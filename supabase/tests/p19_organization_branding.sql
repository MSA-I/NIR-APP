-- P19 -- Tenant branding has immutable paths, server-only writes and server-enforced file limits.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p19_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P19 organization branding assertion failed: %', p_message;
  end if;
end
$$;

select pg_temp.p19_assert(
  (select public and file_size_limit = 2097152
     and allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp']::text[]
   from storage.buckets where id = 'organization-branding'),
  'branding bucket limits or MIME allowlist drifted');
select pg_temp.p19_assert(
  not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname like 'organization_branding_%'
  ),
  'browser storage DML policy bypasses the server branding validator');

insert into public.organizations (id, name, status) values
  ('19000000-0000-4000-8000-000000000001', 'P19 tenant A', 'active'),
  ('19000000-0000-4000-8000-000000000002', 'P19 tenant B', 'active');
insert into auth.users (id, email) values
  ('29000000-0000-4000-8000-000000000001', 'owner-p19@example.test');
insert into public.profiles (id, org_id, full_name, role) values
  ('29000000-0000-4000-8000-000000000001', '19000000-0000-4000-8000-000000000001', 'P19 owner', 'owner');
insert into storage.objects (bucket_id, name, owner, metadata) values (
  'organization-branding',
  '19000000-0000-4000-8000-000000000001/91000000-0000-4000-8000-000000000001.png',
  '29000000-0000-4000-8000-000000000001',
  '{"mimetype":"image/png","size":100}'::jsonb
);

do $$
begin
  update public.organizations
     set logo_path = '19000000-0000-4000-8000-000000000002/logo', logo_updated_at = now()
   where id = '19000000-0000-4000-8000-000000000001';
  raise exception 'expected fixed tenant logo path rejection';
exception when check_violation then null;
end
$$;

select set_config('request.jwt.claim.sub', '29000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

do $$
begin
  insert into storage.objects (bucket_id, name, owner, metadata) values (
    'organization-branding',
    '19000000-0000-4000-8000-000000000001/91000000-0000-4000-8000-000000000003.png',
    '29000000-0000-4000-8000-000000000001',
    '{"mimetype":"image/png","size":100}'::jsonb
  );
  raise exception 'expected direct branding upload rejection';
exception when insufficient_privilege then null;
end
$$;

do $$
begin
  update storage.objects set metadata = '{"mimetype":"image/png","size":101}'::jsonb
  where bucket_id = 'organization-branding'
    and name = '19000000-0000-4000-8000-000000000001/91000000-0000-4000-8000-000000000001.png';
  if found then raise exception 'expected versioned branding overwrite rejection'; end if;
exception when insufficient_privilege then null;
end
$$;

do $$
begin
  delete from storage.objects
  where bucket_id = 'organization-branding'
    and name = '19000000-0000-4000-8000-000000000001/91000000-0000-4000-8000-000000000001.png';
  if found then raise exception 'expected direct active-logo deletion rejection'; end if;
exception when insufficient_privilege then null;
end
$$;

do $$
begin
  insert into storage.objects (bucket_id, name, owner, metadata) values (
    'organization-branding',
    '19000000-0000-4000-8000-000000000002/91000000-0000-4000-8000-000000000002.png',
    '29000000-0000-4000-8000-000000000001',
    '{"mimetype":"image/png","size":100}'::jsonb
  );
  raise exception 'expected cross-tenant branding path rejection';
exception when insufficient_privilege then null;
end
$$;

do $$
begin
  update public.organizations
  set logo_path = id::text || '/91000000-0000-4000-8000-000000000001.png',
      logo_updated_at = now()
  where id = '19000000-0000-4000-8000-000000000001';
  raise exception 'expected direct branding reference update rejection';
exception when insufficient_privilege then null;
end
$$;

reset role;

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select pg_temp.p19_assert(
  public.set_organization_branding_reference(
    '29000000-0000-4000-8000-000000000001',
    null,
    '19000000-0000-4000-8000-000000000001/91000000-0000-4000-8000-000000000001.png',
    now(),
    'owner_uploaded_organization_logo'
  ),
  'service command did not persist the branding reference');
select pg_temp.p19_assert(
  exists (
    select 1 from public.audit_logs
    where org_id = '19000000-0000-4000-8000-000000000001'
      and user_id = '29000000-0000-4000-8000-000000000001'
      and entity_type = 'organizations'
      and entity_id = '19000000-0000-4000-8000-000000000001'
      and reason = 'owner_uploaded_organization_logo'
      and new_values ->> 'logo_path' =
        '19000000-0000-4000-8000-000000000001/91000000-0000-4000-8000-000000000001.png'
  ),
  'branding audit did not preserve the owner identity and reason');
select pg_temp.p19_assert(
  not public.set_organization_branding_reference(
    '29000000-0000-4000-8000-000000000001',
    null,
    '19000000-0000-4000-8000-000000000001/91000000-0000-4000-8000-000000000004.png',
    now(),
    'stale_branding_write'
  ),
  'stale branding compare-and-swap unexpectedly succeeded');
reset role;
rollback;
