-- P0 identity hotfix: immutable tenant identity, audited lifecycle commands and
-- server-authored audit rows. No payer workflow changes live in this migration.

-- ===== Profiles: self service is name/phone only; access changes use one command =====
drop policy if exists profiles_owner_all on profiles;
drop policy if exists profiles_self_update on profiles;

create policy profiles_owner_update on profiles for update to authenticated
  using (org_id = auth_org() and auth_role() = 'owner')
  with check (org_id = auth_org() and auth_role() = 'owner');

create policy profiles_self_update on profiles for update to authenticated
  using (id = auth.uid() and org_id = auth_org())
  with check (id = auth.uid() and org_id = auth_org());

revoke insert, delete, truncate on profiles from public, anon, authenticated;

create or replace function profiles_guard_privileged_columns() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid();
  v_access_change boolean;
begin
  -- Migrations, seeds and service-role operations have no end-user subject.
  if v_actor is null then return new; end if;

  if new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.created_at is distinct from old.created_at then
    raise exception 'profiles_identity_immutable' using errcode = '42501';
  end if;

  -- A future profile column is privileged by default. Browser writers may only touch the
  -- two self-service fields plus the three access fields owned by manage_profile_access().
  if (to_jsonb(new) - array['full_name', 'phone', 'role', 'active', 'supplier_id'])
       is distinct from
     (to_jsonb(old) - array['full_name', 'phone', 'role', 'active', 'supplier_id']) then
    raise exception 'profiles_column_not_browser_writable' using errcode = '42501';
  end if;

  v_access_change := new.role is distinct from old.role
                     or new.active is distinct from old.active
                     or new.supplier_id is distinct from old.supplier_id;

  if v_access_change then
    if current_setting('app.profile_access_writer', true) is distinct from v_actor::text
       or auth_role() <> 'owner'
       or old.org_id is distinct from auth_org() then
      raise exception 'profile_access_rpc_required' using errcode = '42501';
    end if;
  elsif old.id <> v_actor and not (auth_role() = 'owner' and old.org_id = auth_org()) then
    raise exception 'profile_update_not_authorized' using errcode = '42501';
  end if;

  return new;
end
$$;

create or replace function manage_profile_access(
  p_profile_id uuid,
  p_role user_role,
  p_active boolean,
  p_supplier_id uuid,
  p_reason text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_target profiles;
  v_reason text := nullif(trim(p_reason), '');
begin
  if v_org is null or v_actor is null or auth_role() <> 'owner' then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  if p_profile_id = v_actor then
    raise exception 'self_access_change_forbidden' using errcode = '42501';
  end if;
  if p_role is null or p_active is null or v_reason is null then
    raise exception 'profile_access_invalid' using errcode = '22023';
  end if;
  if (p_role = 'supplier') is distinct from (p_supplier_id is not null) then
    raise exception 'supplier_profile_requires_supplier' using errcode = '22023';
  end if;
  if p_supplier_id is not null and not exists (
    select 1 from suppliers s where s.id = p_supplier_id and s.org_id = v_org
  ) then
    raise exception 'supplier_outside_organization' using errcode = '23514';
  end if;

  select * into v_target
  from profiles
  where id = p_profile_id and org_id = v_org
  for update;
  if not found then raise exception 'profile_unknown' using errcode = 'P0002'; end if;

  perform set_config('app.profile_access_writer', v_actor::text, true);
  update profiles
  set role = p_role, active = p_active, supplier_id = p_supplier_id
  where id = v_target.id;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_actor, 'profile_access_changed', 'profiles', v_target.id,
    jsonb_build_object('role', v_target.role, 'active', v_target.active, 'supplier_id', v_target.supplier_id),
    jsonb_build_object('role', p_role, 'active', p_active, 'supplier_id', p_supplier_id),
    v_reason
  );
end
$$;

revoke all on function manage_profile_access(uuid, user_role, boolean, uuid, text) from public;
grant execute on function manage_profile_access(uuid, user_role, boolean, uuid, text) to authenticated;

-- ===== Organization lifecycle: browser UPDATE cannot touch platform-controlled fields =====
drop policy if exists org_update on organizations;
drop policy if exists org_platform_insert on organizations;
drop policy if exists org_platform_update on organizations;

create policy org_update on organizations for update to authenticated
  using (id = auth_org() and auth_role() = 'owner')
  with check (id = auth_org() and auth_role() = 'owner');

revoke insert, delete, truncate on organizations from public, anon, authenticated;

create or replace function organizations_guard_lifecycle() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null then return new; end if;

  -- name/vat/settings are the complete tenant-owned surface. New columns are lifecycle
  -- controlled until a later migration explicitly classifies them as tenant-owned.
  if (to_jsonb(new) - array['name', 'vat_rate', 'settings'])
       is distinct from
     (to_jsonb(old) - array['name', 'vat_rate', 'settings']) then
    if current_setting('app.organization_lifecycle_writer', true) is distinct from v_actor::text
       or not is_platform_admin() then
      raise exception 'organization_lifecycle_rpc_required' using errcode = '42501';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists organizations_guard_lifecycle_trg on organizations;
create trigger organizations_guard_lifecycle_trg
  before update on organizations
  for each row execute function organizations_guard_lifecycle();

create or replace function set_organization_lifecycle(
  p_org_id uuid,
  p_status org_status,
  p_trial_ends_at timestamptz,
  p_reason text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid();
  v_org organizations;
  v_reason text := nullif(trim(p_reason), '');
begin
  if v_actor is null or not is_platform_admin() then
    raise exception 'not_platform_admin' using errcode = '42501';
  end if;
  if p_org_id is null or p_status is null or v_reason is null then
    raise exception 'lifecycle_invalid' using errcode = '22023';
  end if;

  select * into v_org from organizations where id = p_org_id for update;
  if not found then raise exception 'organization_unknown' using errcode = 'P0002'; end if;

  perform set_config('app.organization_lifecycle_writer', v_actor::text, true);
  update organizations
  set status = p_status, trial_ends_at = p_trial_ends_at
  where id = v_org.id;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org.id, v_actor, 'organization_lifecycle_changed', 'organizations', v_org.id,
    jsonb_build_object('status', v_org.status, 'trial_ends_at', v_org.trial_ends_at),
    jsonb_build_object('status', p_status, 'trial_ends_at', p_trial_ends_at),
    v_reason
  );
end
$$;

revoke all on function set_organization_lifecycle(uuid, org_status, timestamptz, text) from public;
grant execute on function set_organization_lifecycle(uuid, org_status, timestamptz, text) to authenticated;

-- ===== Audit rows are server-authored =====
drop policy if exists audit_insert on audit_logs;
drop policy if exists audit_platform_insert on audit_logs;
revoke insert, update, delete, truncate on audit_logs from public, anon, authenticated;

create or replace function audit_row_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_org uuid := nullif(v_row ->> 'org_id', '')::uuid;
  v_actor uuid := auth.uid();
begin
  if v_org is null then
    raise exception 'audit_source_missing_org: %', tg_table_name;
  end if;
  if v_actor is not null and v_org is distinct from auth_org() then
    raise exception 'audit_source_org_mismatch: %', tg_table_name using errcode = '42501';
  end if;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, old_values, new_values)
  values (
    v_org,
    v_actor,
    lower(tg_op),
    tg_table_name,
    nullif(v_row ->> 'id', '')::uuid,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );

  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

revoke all on function audit_row_change() from public, anon, authenticated;

-- ===== Invitation delivery: bounded and recorded by the command that issues the token =====
create index if not exists audit_invitation_rate_idx
  on audit_logs (org_id, user_id, created_at desc)
  where action = 'invitation_delivery_requested';

create or replace function invitation_rate_limits(p_org uuid)
returns table (cooldown_seconds int, daily_limit int)
language sql stable set search_path = public as $$
  select
    case when o.settings ->> 'invite_resend_cooldown_seconds' ~ '^[0-9]+$'
         then least(86400, greatest(1, (o.settings ->> 'invite_resend_cooldown_seconds')::int))
         else 60 end,
    case when o.settings ->> 'invite_send_limit_per_day' ~ '^[0-9]+$'
         then least(1000, greatest(1, (o.settings ->> 'invite_send_limit_per_day')::int))
         else 20 end
  from organizations o where o.id = p_org
$$;

revoke all on function invitation_rate_limits(uuid) from public, anon, authenticated;

create or replace function create_invitation(p_email text, p_role user_role)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_org uuid := auth_org();
  v_actor user_role := auth_role();
  v_uid uuid := auth.uid();
  v_email text := lower(trim(p_email));
  v_raw text;
  v_expires timestamptz;
  v_id uuid;
  v_name text;
  v_existing invitations;
  v_has_existing boolean := false;
  v_cooldown int;
  v_daily_limit int;
begin
  if v_org is null or v_actor <> 'owner' or v_uid is null then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invalid_email' using errcode = '22023';
  end if;
  if p_role = 'supplier' then raise exception 'role_not_invitable' using errcode = '42501'; end if;
  if exists (select 1 from profiles p join auth.users u on u.id = p.id
             where p.org_id = v_org and lower(u.email) = v_email) then
    raise exception 'already_member' using errcode = '23505';
  end if;

  select * into v_existing from invitations
  where org_id = v_org and lower(email) = v_email
    and accepted_at is null and revoked_at is null
  for update;
  v_has_existing := found;
  select cooldown_seconds, daily_limit into v_cooldown, v_daily_limit
  from invitation_rate_limits(v_org);
  if v_has_existing and v_existing.last_sent_at > now() - make_interval(secs => v_cooldown) then
    raise exception 'invite_cooldown' using errcode = '42900';
  end if;
  if (select count(*) from audit_logs
      where org_id = v_org and user_id = v_uid
        and action = 'invitation_delivery_requested'
        and created_at >= now() - interval '24 hours') >= v_daily_limit then
    raise exception 'invite_daily_limit' using errcode = '42900';
  end if;

  v_raw := encode(gen_random_bytes(32), 'hex');
  v_expires := now() + make_interval(days => invitation_expiry_days(v_org));
  insert into invitations (org_id, email, role, token_hash, expires_at, invited_by)
  values (v_org, v_email, p_role, encode(sha256(convert_to(v_raw, 'UTF8')), 'hex'), v_expires, v_uid)
  on conflict (org_id, lower(email)) where accepted_at is null and revoked_at is null
  do update set role = excluded.role, token_hash = excluded.token_hash,
                expires_at = excluded.expires_at, invited_by = excluded.invited_by,
                last_sent_at = now(), send_count = invitations.send_count + 1
  returning id into v_id;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, new_values, reason)
  values (v_org, v_uid, 'invitation_delivery_requested', 'invitations', v_id,
          jsonb_build_object('email', v_email, 'role', p_role), 'יצירת הזמנה ומשלוח קישור');
  select name into v_name from organizations where id = v_org;
  return jsonb_build_object('invitation_id', v_id, 'token', v_raw, 'email', v_email,
                            'role', p_role, 'org_name', v_name, 'expires_at', v_expires);
end
$$;

create or replace function resend_invitation(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_org uuid := auth_org();
  v_actor user_role := auth_role();
  v_uid uuid := auth.uid();
  inv invitations;
  v_raw text;
  v_expires timestamptz;
  v_name text;
  v_cooldown int;
  v_daily_limit int;
begin
  if v_org is null or v_actor <> 'owner' or v_uid is null then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  select * into inv from invitations where id = p_id and org_id = v_org for update;
  if not found then raise exception 'invitation_unknown' using errcode = 'P0002'; end if;
  if inv.accepted_at is not null then raise exception 'invitation_accepted' using errcode = 'P0002'; end if;
  if inv.revoked_at is not null then raise exception 'invitation_revoked' using errcode = 'P0002'; end if;

  select cooldown_seconds, daily_limit into v_cooldown, v_daily_limit
  from invitation_rate_limits(v_org);
  if inv.last_sent_at > now() - make_interval(secs => v_cooldown) then
    raise exception 'invite_cooldown' using errcode = '42900';
  end if;
  if (select count(*) from audit_logs
      where org_id = v_org and user_id = v_uid
        and action = 'invitation_delivery_requested'
        and created_at >= now() - interval '24 hours') >= v_daily_limit then
    raise exception 'invite_daily_limit' using errcode = '42900';
  end if;

  v_raw := encode(gen_random_bytes(32), 'hex');
  v_expires := now() + make_interval(days => invitation_expiry_days(v_org));
  update invitations
  set token_hash = encode(sha256(convert_to(v_raw, 'UTF8')), 'hex'),
      expires_at = v_expires, last_sent_at = now(), send_count = send_count + 1
  where id = inv.id;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason)
  values (v_org, v_uid, 'invitation_delivery_requested', 'invitations', inv.id,
          jsonb_build_object('last_sent_at', inv.last_sent_at, 'send_count', inv.send_count),
          jsonb_build_object('last_sent_at', now(), 'send_count', inv.send_count + 1),
          'שליחה מחדש של הזמנה');
  select name into v_name from organizations where id = v_org;
  return jsonb_build_object('invitation_id', inv.id, 'token', v_raw, 'email', inv.email,
                            'role', inv.role, 'org_name', v_name, 'expires_at', v_expires);
end
$$;

create or replace function revoke_invitation(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := auth_org();
  v_uid uuid := auth.uid();
  inv invitations;
  v_reason text := nullif(trim(p_reason), '');
begin
  if v_org is null or v_uid is null or auth_role() <> 'owner' then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  if v_reason is null then raise exception 'reason_required' using errcode = '22023'; end if;
  select * into inv from invitations where id = p_id and org_id = v_org for update;
  if not found then raise exception 'invitation_unknown' using errcode = 'P0002'; end if;
  if inv.accepted_at is not null then raise exception 'invitation_accepted' using errcode = 'P0002'; end if;

  update invitations set revoked_at = now(), revoked_by = v_uid
  where id = inv.id and revoked_at is null;
  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason)
  values (v_org, v_uid, 'invitation_revoked', 'invitations', inv.id,
          jsonb_build_object('revoked_at', inv.revoked_at, 'revoked_by', inv.revoked_by),
          jsonb_build_object('revoked_at', now(), 'revoked_by', v_uid), v_reason);
end
$$;

revoke all on function create_invitation(text, user_role) from public;
revoke all on function resend_invitation(uuid) from public;
revoke all on function revoke_invitation(uuid) from public, anon, authenticated;
revoke all on function revoke_invitation(uuid, text) from public;
grant execute on function create_invitation(text, user_role) to authenticated;
grant execute on function resend_invitation(uuid) to authenticated;
grant execute on function revoke_invitation(uuid, text) to authenticated;
