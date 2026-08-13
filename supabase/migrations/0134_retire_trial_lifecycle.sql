-- 0134 -- Retire the trial lifecycle without weakening suspension or tenant offboarding.
-- Historical enum/column compatibility remains, but no current row or supported command can use it.

-- The 0092 update guard may reject an already-expired trial. The migration is the authoritative
-- one-time conversion, so disable only that exact trigger for the conversion transaction.
alter table public.organizations disable trigger organizations_trial_write_guard;

update public.organizations
set status = 'active', trial_ends_at = null
where status = 'trial' or trial_ends_at is not null;

alter table public.organizations enable trigger organizations_trial_write_guard;

alter table public.organizations
  alter column status set default 'active';

alter table public.organizations
  drop constraint if exists organizations_trial_end_required;

drop trigger if exists organizations_default_trial_period on public.organizations;
drop function if exists private.organizations_default_trial_period();

alter table public.organizations
  add constraint organizations_trial_retired
  check (status <> 'trial' and trial_ends_at is null) not valid;
alter table public.organizations validate constraint organizations_trial_retired;

create or replace function private.organization_access_mode(p_org_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when organization.id is null or organization.status = 'suspended' then 'suspended'
    when exists (
      select 1
      from public.organization_offboarding_requests request
      where request.org_id = organization.id
        and request.status in (
          'requested', 'approved', 'export_building', 'export_ready', 'export_failed'
        )
    ) then 'offboarding'
    when organization.status = 'active' then 'active'
    else 'suspended'
  end
  from (select p_org_id as requested_id) requested
  left join public.organizations organization on organization.id = requested.requested_id
$$;

revoke all on function private.organization_access_mode(uuid)
  from public, anon, authenticated, service_role;

create or replace function private.organization_write_allowed_fenced(p_org_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  if p_org_id is null then return false; end if;
  perform 1
  from public.organizations organization
  where organization.id = p_org_id
  for key share;
  if not found then return false; end if;
  return private.organization_access_mode(p_org_id) = 'active';
end
$$;

revoke all on function private.organization_write_allowed_fenced(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.organization_write_allowed()
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
  return private.organization_write_allowed_fenced(public.auth_org());
end
$$;

revoke all on function public.organization_write_allowed() from public, anon;
grant execute on function public.organization_write_allowed() to authenticated;

-- Keep the response columns for deployed clients. The retired deadline fields are always null.
create or replace function public.organization_access_state()
returns table (
  access_mode text,
  trial_ends_at timestamptz,
  grace_ends_at timestamptz,
  grace_days_remaining integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with actor_organization as (
    select profile.org_id
    from public.profiles profile
    where profile.id = auth.uid()
      and profile.active
    limit 1
  )
  select private.organization_access_mode(actor_organization.org_id),
         null::timestamptz,
         null::timestamptz,
         null::integer
  from actor_organization
$$;

revoke all on function public.organization_access_state() from public, anon;
grant execute on function public.organization_access_state() to authenticated;

create or replace function private.organizations_trial_write_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_lifecycle_write boolean := coalesce(
    v_actor is not null
    and public.is_platform_admin()
    and current_setting('app.organization_lifecycle_writer', true) = v_actor::text,
    false
  );
begin
  if new.status = 'trial' or new.trial_ends_at is not null then
    raise exception 'trial_retired' using errcode = '22023';
  end if;
  if private.organization_access_mode(old.id) <> 'active' and not v_lifecycle_write then
    raise exception 'organization_read_only' using errcode = '42501';
  end if;
  return new;
end
$$;

revoke all on function private.organizations_trial_write_guard()
  from public, anon, authenticated, service_role;

create or replace function public.set_organization_lifecycle(
  p_org_id uuid,
  p_status public.org_status,
  p_trial_ends_at timestamptz,
  p_reason text
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_org public.organizations;
  v_reason text := nullif(trim(p_reason), '');
begin
  if v_actor is null or not public.is_platform_admin() then
    raise exception 'not_platform_admin' using errcode = '42501';
  end if;
  if p_org_id is null or p_status is null or v_reason is null then
    raise exception 'lifecycle_invalid' using errcode = '22023';
  end if;
  if p_status = 'trial' or p_trial_ends_at is not null then
    raise exception 'trial_retired' using errcode = '22023';
  end if;
  if p_status not in ('active', 'suspended') then
    raise exception 'lifecycle_invalid' using errcode = '22023';
  end if;

  perform public.assert_recent_password_authentication();
  select * into v_org from public.organizations where id = p_org_id for update;
  if not found then raise exception 'organization_unknown' using errcode = 'P0002'; end if;

  perform set_config('app.organization_lifecycle_writer', v_actor::text, true);
  update public.organizations
  set status = p_status, trial_ends_at = null
  where id = v_org.id;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org.id, v_actor, 'organization_lifecycle_changed', 'organizations', v_org.id,
    jsonb_build_object('status', v_org.status),
    jsonb_build_object('status', p_status),
    v_reason
  );
end
$$;

revoke all on function public.set_organization_lifecycle(uuid, public.org_status, timestamptz, text)
  from public, anon, service_role;
grant execute on function public.set_organization_lifecycle(uuid, public.org_status, timestamptz, text)
  to authenticated;

comment on function public.organization_access_state() is
  'Canonical tenant access state after Trial retirement: active, suspended or offboarding; legacy deadline columns are null.';
comment on function public.organization_write_allowed() is
  'RLS and Storage latch; true only for an active tenant with no open offboarding request.';

do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0134 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
