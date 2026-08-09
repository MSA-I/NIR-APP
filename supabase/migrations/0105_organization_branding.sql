-- 0105 -- Safe tenant branding: the existing organization name plus one constrained logo.
-- Logos are intentionally public brand assets; only the tenant owner may write versioned paths.

alter table public.organizations
  add column logo_path text,
  add column logo_updated_at timestamptz,
  add constraint organizations_logo_shape check (
    (logo_path is null and logo_updated_at is null)
    or (
      logo_path ~ ('^' || id::text
        || '/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.](png|jpg|webp)$')
      and logo_updated_at is not null
    )
  ) not valid;
alter table public.organizations validate constraint organizations_logo_shape;

do $$
declare
  v_body text;
begin
  select p.prosrc into v_body
  from pg_catalog.pg_proc p
  where p.oid = 'public.organizations_guard_lifecycle()'::regprocedure;
  if md5(v_body) <> '13885309d3247b6255cb8764da50c3f4' then
    raise exception '0105 ancestry guard failed: organizations_guard_lifecycle changed';
  end if;

  select p.prosrc into v_body
  from pg_catalog.pg_proc p
  where p.oid = 'private.audit_organizations_change()'::regprocedure;
  if md5(v_body) <> 'a2b56c4a209013b56e87190206b711a8' then
    raise exception '0105 ancestry guard failed: audit_organizations_change changed';
  end if;
end
$$;

-- Logo references are written only after the Edge Function validates and stores the bytes.
revoke update (logo_path, logo_updated_at)
  on table public.organizations from authenticated;

create or replace function public.organizations_guard_lifecycle() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null then return new; end if;

  if (to_jsonb(new) - array['name', 'vat_rate', 'settings', 'logo_path', 'logo_updated_at'])
       is distinct from
     (to_jsonb(old) - array['name', 'vat_rate', 'settings', 'logo_path', 'logo_updated_at']) then
    if current_setting('app.organization_lifecycle_writer', true) is distinct from v_actor::text
       or not is_platform_admin() then
      raise exception 'organization_lifecycle_rpc_required' using errcode = '42501';
    end if;
  end if;
  return new;
end
$$;

create or replace function private.audit_organizations_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := case when tg_op = 'DELETE' then old.id else new.id end;
  v_actor uuid := coalesce(
    auth.uid(),
    nullif(current_setting('app.organization_branding_actor', true), '')::uuid
  );
  v_reason text := nullif(current_setting('app.organization_branding_reason', true), '');
begin
  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org,
    v_actor,
    lower(tg_op),
    tg_table_name,
    v_org,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end,
    v_reason
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

create function public.set_organization_branding_reference(
  p_actor_id uuid,
  p_expected_logo_path text,
  p_new_logo_path text,
  p_new_logo_updated_at timestamptz,
  p_reason text
) returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_org public.organizations;
  v_reason text := nullif(trim(p_reason), '');
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'branding_service_role_required' using errcode = '42501';
  end if;
  if p_actor_id is null or v_reason is null
     or ((p_new_logo_path is null) is distinct from (p_new_logo_updated_at is null)) then
    raise exception 'branding_reference_invalid' using errcode = '22023';
  end if;

  select o.* into v_org
  from public.profiles p
  join public.organizations o on o.id = p.org_id
  where p.id = p_actor_id
    and p.active
    and p.role = 'owner'
    and o.status in ('trial', 'active')
  for update of o;
  if not found then
    raise exception 'branding_actor_forbidden' using errcode = '42501';
  end if;
  if v_org.logo_path is distinct from p_expected_logo_path then
    return false;
  end if;

  perform set_config('app.organization_branding_actor', p_actor_id::text, true);
  perform set_config('app.organization_branding_reason', v_reason, true);
  update public.organizations
  set logo_path = p_new_logo_path,
      logo_updated_at = p_new_logo_updated_at
  where id = v_org.id;
  return true;
end
$$;

revoke all on function public.set_organization_branding_reference(
  uuid, text, text, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.set_organization_branding_reference(
  uuid, text, text, timestamptz, text
) to service_role;

insert into storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
) values (
  'organization-branding',
  'organization-branding',
  true,
  2097152,
  array['image/png', 'image/jpeg', 'image/webp']::text[]
)
on conflict (id) do update
set public = true,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0105 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
