-- Retire kitchen, payer and supplier as product accounts without rewriting user_role.
--
-- user_role is historical database vocabulary embedded in the RLS lineage. Removing enum values
-- would rewrite that lineage and would also make old business rows impossible to explain. The
-- product-account contract is narrower: owner, office and accountant are the only roles that may
-- be active. Accountant remains the approved payment executor.
--
-- This migration preserves auth identities and business history. It deactivates retired profiles,
-- bans their Auth identities, revokes pending invitations, writes an explicit audit row for every
-- mutation, and installs guards on the two tables through which a retired persona could return.

-- ===== Existing profiles and Auth identities =====

do $$
declare
  v_profile profiles%rowtype;
  v_banned_until timestamptz;
begin
  for v_profile in
    select p.*
    from profiles p
    where p.role in ('kitchen', 'payer', 'supplier')
      and p.active
    order by p.id
    for update
  loop
    update profiles
    set active = false
    where id = v_profile.id;

    insert into audit_logs (
      org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
    ) values (
      v_profile.org_id, null, 'retired_persona_profile_deactivated', 'profiles', v_profile.id,
      jsonb_build_object('role', v_profile.role, 'active', true),
      jsonb_build_object('role', v_profile.role, 'active', false),
      'פרישת תפקיד מוצר: נשארים מנהל, מנהל רכש ורואה חשבון'
    );
  end loop;

  for v_profile in
    select p.*
    from profiles p
    join auth.users u on u.id = p.id
    where p.role in ('kitchen', 'payer', 'supplier')
      and (u.banned_until is null or u.banned_until <> 'infinity'::timestamptz)
    order by p.id
    for update of u
  loop
    select u.banned_until into v_banned_until
    from auth.users u
    where u.id = v_profile.id;

    update auth.users
    set banned_until = 'infinity'::timestamptz,
        updated_at = now()
    where id = v_profile.id;

    insert into audit_logs (
      org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
    ) values (
      v_profile.org_id, null, 'retired_persona_auth_banned', 'auth.users', v_profile.id,
      jsonb_build_object('role', v_profile.role, 'banned_until', v_banned_until),
      jsonb_build_object('role', v_profile.role, 'banned_until', 'infinity'),
      'חסימת כניסה לתפקיד מוצר שפרש; הזהות וההיסטוריה נשמרות'
    );
  end loop;
end
$$;

-- ===== Pending invitations =====

do $$
declare
  v_inv invitations%rowtype;
  v_revoked_at timestamptz;
begin
  for v_inv in
    select i.*
    from invitations i
    where i.role in ('kitchen', 'payer', 'supplier')
      and i.accepted_at is null
      and i.revoked_at is null
    order by i.id
    for update
  loop
    v_revoked_at := clock_timestamp();

    update invitations
    set revoked_at = v_revoked_at,
        revoked_by = null
    where id = v_inv.id;

    insert into audit_logs (
      org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
    ) values (
      v_inv.org_id, null, 'retired_persona_invitation_revoked', 'invitations', v_inv.id,
      jsonb_build_object(
        'email', lower(v_inv.email), 'role', v_inv.role,
        'revoked_at', v_inv.revoked_at, 'accepted_at', v_inv.accepted_at
      ),
      jsonb_build_object(
        'email', lower(v_inv.email), 'role', v_inv.role,
        'revoked_at', v_revoked_at, 'accepted_at', v_inv.accepted_at
      ),
      'ביטול הזמנה לתפקיד מוצר שפרש'
    );
  end loop;
end
$$;

-- ===== Future-write guards =====

create or replace function guard_retired_product_profile()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and old.role in ('kitchen', 'payer', 'supplier')
     and new.role not in ('kitchen', 'payer', 'supplier')
     -- A product owner cannot safely complete this transition: the matching Auth identity is
     -- banned above. A platform operator must change the profile and unban Auth together.
     and not (current_user = 'postgres' and auth.uid() is null) then
    raise exception 'retired_identity_requires_platform_reactivation' using errcode = '42501';
  end if;

  if new.role in ('kitchen', 'payer', 'supplier')
     and new.active
     -- SQL suites and historical fixtures are loaded by a trusted database actor with no end-user
     -- subject. Product RPCs are SECURITY DEFINER too, but retain auth.uid(), so they do not pass.
     and not (current_user = 'postgres' and auth.uid() is null) then
    raise exception 'account_role_retired' using errcode = '42501';
  end if;

  return new;
end
$$;

drop trigger if exists profiles_retired_product_persona_guard on profiles;
create trigger profiles_retired_product_persona_guard
before insert or update of role, active on profiles
for each row execute function guard_retired_product_profile();

create or replace function guard_retired_product_invitation()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_trusted_fixture boolean := current_user = 'postgres' and auth.uid() is null;
  v_cancel_only boolean := false;
begin
  if tg_op = 'UPDATE' then
    v_cancel_only := old.role in ('kitchen', 'payer', 'supplier')
      and new.role = old.role
      and old.revoked_at is null
      and new.revoked_at is not null
      and (to_jsonb(new) - array['revoked_at', 'revoked_by'])
          = (to_jsonb(old) - array['revoked_at', 'revoked_by']);
  end if;

  if new.role in ('kitchen', 'payer', 'supplier')
     and not v_trusted_fixture
     and not v_cancel_only then
    raise exception 'account_role_retired' using errcode = '42501';
  end if;

  return new;
end
$$;

drop trigger if exists invitations_retired_product_persona_guard on invitations;
create trigger invitations_retired_product_persona_guard
before insert or update on invitations
for each row execute function guard_retired_product_invitation();

revoke all on function guard_retired_product_profile() from public, anon, authenticated;
revoke all on function guard_retired_product_invitation() from public, anon, authenticated;

-- ===== A1/A3/A5 re-assertion =====

do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0127 scope assertions failed:\n%', v_violations;
  end if;
end
$$;

-- ===== Migration self-check =====

do $$
begin
  if exists (
    select 1 from profiles
    where role in ('kitchen', 'payer', 'supplier') and active
  ) then
    raise exception '0127: active retired profile remains';
  end if;

  if exists (
    select 1 from invitations
    where role in ('kitchen', 'payer', 'supplier')
      and accepted_at is null and revoked_at is null
  ) then
    raise exception '0127: pending retired-role invitation remains';
  end if;

  if exists (
    select 1
    from profiles p
    join auth.users u on u.id = p.id
    where p.role in ('kitchen', 'payer', 'supplier')
      and (u.banned_until is null or u.banned_until <> 'infinity'::timestamptz)
  ) then
    raise exception '0127: retired Auth identity is not banned';
  end if;
end
$$;
