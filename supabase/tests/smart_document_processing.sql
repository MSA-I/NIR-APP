-- Smart-document queue, tenant and immutable-extraction contract.
-- Run as local supabase_admin only against a freshly reset disposable database after migration 0045.
-- This file commits fixtures so dblink sessions can exercise a real expired-lease race;
-- reset the local database immediately after the test.
\set ON_ERROR_STOP on

create extension if not exists dblink;
drop schema if exists smart_document_processing_test cascade;
create schema smart_document_processing_test;

create function smart_document_processing_test.assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'Smart document assertion failed: %', p_message;
  end if;
end
$$;

create function smart_document_processing_test.valid_payload(p_text text default 'בדיקת חילוץ')
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'schema_version', '1',
    'document', jsonb_build_object(
      'page_count', 1,
      'detected_languages', jsonb_build_array('he'),
      'plain_text', p_text,
      'partial', false
    ),
    'blocks', jsonb_build_array(jsonb_build_object(
      'id', 'block-1',
      'page', 1,
      'type', 'text',
      'bbox', jsonb_build_array(0, 0, 1, 1),
      'text', p_text,
      'confidence', 0.91
    )),
    'tables', '[]'::jsonb,
    'marks', '[]'::jsonb
  )
$$;

grant usage on schema smart_document_processing_test to authenticated, service_role;
grant execute on function smart_document_processing_test.valid_payload(text) to authenticated, service_role;

-- Schema, RLS, tenant FKs and the active-job idempotency key.
select smart_document_processing_test.assert(
  to_regclass('public.document_processing_jobs') is not null
    and to_regclass('public.document_extractions') is not null,
  'processing tables are missing'
);

select smart_document_processing_test.assert(
  (select relrowsecurity from pg_class where oid = 'public.document_processing_jobs'::regclass)
    and (select relrowsecurity from pg_class where oid = 'public.document_extractions'::regclass),
  'RLS is not enabled on both processing tables'
);

select smart_document_processing_test.assert(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.document_processing_jobs'::regclass
      and contype = 'f'
      and pg_get_constraintdef(oid) ilike '%foreign key (org_id, document_id)%references documents(org_id, id)%'
  ),
  'jobs do not have a tenant document FK'
);

select smart_document_processing_test.assert(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.document_extractions'::regclass
      and contype = 'f'
      and pg_get_constraintdef(oid) ilike '%foreign key (org_id, job_id)%references document_processing_jobs(org_id, id)%'
  ) and exists (
    select 1 from pg_constraint
    where conrelid = 'public.document_extractions'::regclass
      and contype = 'f'
      and pg_get_constraintdef(oid) ilike '%foreign key (org_id, document_id)%references documents(org_id, id)%'
  ),
  'extractions do not have both tenant FKs'
);

select smart_document_processing_test.assert(
  exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'document_processing_jobs'
      and indexdef ilike '%unique%org_id%document_id%input_checksum%contract_version%where%'
  ),
  'active job idempotency index is missing'
);

-- Browser users can read through RLS and invoke only the two user commands.
select smart_document_processing_test.assert(
  has_table_privilege('authenticated', 'public.document_processing_jobs', 'SELECT')
    and not has_table_privilege('authenticated', 'public.document_processing_jobs', 'INSERT')
    and not has_table_privilege('authenticated', 'public.document_processing_jobs', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.document_processing_jobs', 'DELETE')
    and has_table_privilege('authenticated', 'public.document_extractions', 'SELECT')
    and not has_table_privilege('authenticated', 'public.document_extractions', 'INSERT')
    and not has_table_privilege('authenticated', 'public.document_extractions', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.document_extractions', 'DELETE'),
  'authenticated table grants are wider or narrower than read-only RLS access'
);

select smart_document_processing_test.assert(
  has_function_privilege('authenticated', 'public.enqueue_document_processing(uuid)', 'EXECUTE')
    and has_function_privilege('authenticated', 'public.reprocess_document(uuid,text)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.claim_document_processing_job(text,integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.heartbeat_document_processing_job(uuid,text,integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.complete_document_processing_job(uuid,text,text,text,text,text,text,jsonb,integer,jsonb)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.fail_document_processing_job(uuid,text,text,text)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.claim_document_processing_job(text,integer)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.heartbeat_document_processing_job(uuid,text,integer)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.complete_document_processing_job(uuid,text,text,text,text,text,text,jsonb,integer,jsonb)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.fail_document_processing_job(uuid,text,text,text)', 'EXECUTE'),
  'RPC grants do not preserve the browser/service boundary'
);

select smart_document_processing_test.assert(
  not has_function_privilege('anon', 'public.enqueue_document_processing(uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.reprocess_document(uuid,text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.claim_document_processing_job(text,integer)', 'EXECUTE'),
  'anon can execute a processing command'
);

-- Storage keeps the old image contract and adds every locked smart-document MIME.
select smart_document_processing_test.assert(
  (select file_size_limit = 10485760 from storage.buckets where id = 'documents'),
  'documents bucket limit is not 10MB'
);

select smart_document_processing_test.assert(
  (select array[
      'image/jpeg',
      'image/png',
      'application/pdf',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/rtf',
      'text/plain',
      'text/html',
      'application/vnd.oasis.opendocument.text'
    ]::text[] <@ allowed_mime_types
    and not ('application/x-msdownload' = any(allowed_mime_types))
   from storage.buckets where id = 'documents'),
  'documents bucket MIME allowlist is incomplete or permits executables'
);

insert into public.organizations (id, name, status) values
  ('15000000-0000-4000-8000-000000000001', 'Smart document tenant A', 'active'),
  ('15000000-0000-4000-8000-000000000002', 'Smart document tenant B', 'active'),
  -- Born active, suspended right after the fixtures below exist: since 0092 the read-only
  -- latch refuses every child fixture written into an already-suspended tenant.
  ('15000000-0000-4000-8000-000000000003', 'Smart document tenant suspended', 'active');

insert into auth.users (id, email) values
  ('25000000-0000-4000-8000-000000000001', 'smart-doc-owner-a@example.test'),
  ('25000000-0000-4000-8000-000000000002', 'smart-doc-office-a@example.test'),
  ('25000000-0000-4000-8000-000000000003', 'smart-doc-kitchen-a@example.test'),
  ('25000000-0000-4000-8000-000000000004', 'smart-doc-accountant-a@example.test'),
  ('25000000-0000-4000-8000-000000000005', 'smart-doc-owner-b@example.test'),
  ('25000000-0000-4000-8000-000000000006', 'smart-doc-owner-suspended@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('25000000-0000-4000-8000-000000000001', '15000000-0000-4000-8000-000000000001', 'Smart doc owner A', 'owner'),
  ('25000000-0000-4000-8000-000000000002', '15000000-0000-4000-8000-000000000001', 'Smart doc office A', 'office'),
  ('25000000-0000-4000-8000-000000000003', '15000000-0000-4000-8000-000000000001', 'Smart doc kitchen A', 'kitchen'),
  ('25000000-0000-4000-8000-000000000004', '15000000-0000-4000-8000-000000000001', 'Smart doc accountant A', 'accountant'),
  ('25000000-0000-4000-8000-000000000005', '15000000-0000-4000-8000-000000000002', 'Smart doc owner B', 'owner'),
  ('25000000-0000-4000-8000-000000000006', '15000000-0000-4000-8000-000000000003', 'Smart doc owner suspended', 'owner');

insert into storage.objects (bucket_id, name, owner, metadata) values
  ('documents', '15000000-0000-4000-8000-000000000001/smart-doc/main.pdf', '25000000-0000-4000-8000-000000000001', jsonb_build_object('mimetype', 'application/pdf', 'size', 100, 'eTag', upper(repeat('a', 64)))),
  ('documents', '15000000-0000-4000-8000-000000000001/smart-doc/retry.pdf', '25000000-0000-4000-8000-000000000001', jsonb_build_object('mimetype', 'application/pdf', 'size', 100, 'eTag', repeat('b', 64))),
  ('documents', '15000000-0000-4000-8000-000000000001/smart-doc/changed.pdf', '25000000-0000-4000-8000-000000000001', jsonb_build_object('mimetype', 'application/pdf', 'size', 100, 'eTag', repeat('c', 64))),
  ('documents', '15000000-0000-4000-8000-000000000001/smart-doc/missing-etag.pdf', '25000000-0000-4000-8000-000000000001', jsonb_build_object('mimetype', 'application/pdf', 'size', 100)),
  ('documents', '15000000-0000-4000-8000-000000000001/smart-doc/deleted.pdf', '25000000-0000-4000-8000-000000000001', jsonb_build_object('mimetype', 'application/pdf', 'size', 100, 'eTag', repeat('f', 64))),
  ('documents', '15000000-0000-4000-8000-000000000002/smart-doc/tenant-b.pdf', '25000000-0000-4000-8000-000000000005', jsonb_build_object('mimetype', 'application/pdf', 'size', 100, 'eTag', repeat('d', 64))),
  ('documents', '15000000-0000-4000-8000-000000000003/smart-doc/suspended.pdf', '25000000-0000-4000-8000-000000000006', jsonb_build_object('mimetype', 'application/pdf', 'size', 100, 'eTag', repeat('e', 64)));

insert into public.documents (
  id, org_id, entity_type, entity_id, storage_path, file_name, mime_type,
  document_kind, uploaded_by
) values
  ('45000000-0000-4000-8000-000000000001', '15000000-0000-4000-8000-000000000001', 'inbox', null, '15000000-0000-4000-8000-000000000001/smart-doc/main.pdf', 'main.pdf', 'application/pdf', 'other', '25000000-0000-4000-8000-000000000001'),
  ('45000000-0000-4000-8000-000000000002', '15000000-0000-4000-8000-000000000001', 'inbox', null, '15000000-0000-4000-8000-000000000001/smart-doc/retry.pdf', 'retry.pdf', 'application/pdf', 'other', '25000000-0000-4000-8000-000000000001'),
  ('45000000-0000-4000-8000-000000000003', '15000000-0000-4000-8000-000000000001', 'inbox', null, '15000000-0000-4000-8000-000000000001/smart-doc/changed.pdf', 'changed.pdf', 'application/pdf', 'price_list', '25000000-0000-4000-8000-000000000001'),
  ('45000000-0000-4000-8000-000000000004', '15000000-0000-4000-8000-000000000001', 'inbox', null, '15000000-0000-4000-8000-000000000001/smart-doc/missing-etag.pdf', 'missing-etag.pdf', 'application/pdf', 'other', '25000000-0000-4000-8000-000000000001'),
  ('45000000-0000-4000-8000-000000000006', '15000000-0000-4000-8000-000000000001', 'inbox', null, '15000000-0000-4000-8000-000000000001/smart-doc/deleted.pdf', 'deleted.pdf', 'application/pdf', 'other', '25000000-0000-4000-8000-000000000001'),
  ('45000000-0000-4000-8000-000000000005', '15000000-0000-4000-8000-000000000002', 'inbox', null, '15000000-0000-4000-8000-000000000002/smart-doc/tenant-b.pdf', 'tenant-b.pdf', 'application/pdf', 'other', '25000000-0000-4000-8000-000000000005'),
  ('45000000-0000-4000-8000-000000000007', '15000000-0000-4000-8000-000000000003', 'inbox', null, '15000000-0000-4000-8000-000000000003/smart-doc/suspended.pdf', 'suspended.pdf', 'application/pdf', 'other', '25000000-0000-4000-8000-000000000006');

insert into public.document_processing_jobs (
  id, org_id, document_id, requested_by, input_checksum, created_at, updated_at
) values (
  '55000000-0000-4000-8000-000000000006',
  '15000000-0000-4000-8000-000000000001',
  '45000000-0000-4000-8000-000000000006',
  '25000000-0000-4000-8000-000000000001',
  'etag:' || repeat('f', 64),
  '2000-01-01 00:00:00+00',
  '2000-01-01 00:00:00+00'
);

insert into public.document_processing_jobs (
  id, org_id, document_id, requested_by, status, input_checksum,
  attempt_count, lease_owner, lease_until, created_at, updated_at
) values
  (
    '55000000-0000-4000-8000-000000000007',
    '15000000-0000-4000-8000-000000000003',
    '45000000-0000-4000-8000-000000000007',
    '25000000-0000-4000-8000-000000000006',
    'queued', 'etag:' || repeat('e', 64),
    0, null, null,
    '1999-01-01 00:00:00+00', '1999-01-01 00:00:00+00'
  ),
  (
    '55000000-0000-4000-8000-000000000107',
    '15000000-0000-4000-8000-000000000003',
    '45000000-0000-4000-8000-000000000007',
    '25000000-0000-4000-8000-000000000006',
    'leased', 'etag:' || repeat('0', 64),
    1, 'worker-suspended', now() + interval '10 minutes',
    '1998-01-01 00:00:00+00', '1998-01-01 00:00:00+00'
  );

-- Suspend tenant 3 through the production lifecycle command, as an operator would -- the same
-- explicit platform latch p22 exercises. Directly seeding status = 'suspended' stopped being
-- possible when 0092 landed: the row guard refuses child fixtures of a read-only tenant, which
-- is exactly the behaviour the suite then proves for the service path.
insert into auth.users (id, email) values
  ('25000000-0000-4000-8000-000000000099', 'smart-doc-platform@example.test');
insert into public.profiles (id, org_id, full_name, role) values
  ('25000000-0000-4000-8000-000000000099', '15000000-0000-4000-8000-000000000001',
   'Smart doc platform operator', 'owner');
insert into public.platform_admins (user_id, note) values
  ('25000000-0000-4000-8000-000000000099', 'Smart doc platform operator');
-- One DO block, deliberately: this file runs in autocommit, so transaction-local claims set in
-- one statement would evaporate before the next. Inside the block the claims and the command
-- share a transaction, and nothing leaks past its commit.
do $$
begin
  perform set_config('request.jwt.claim.sub', '25000000-0000-4000-8000-000000000099', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', '25000000-0000-4000-8000-000000000099',
    'role', 'authenticated',
    'amr', jsonb_build_array(jsonb_build_object(
      'method', 'password',
      'timestamp', extract(epoch from clock_timestamp())::bigint
    ))
  )::text, true);
  perform public.set_organization_lifecycle(
    '15000000-0000-4000-8000-000000000003',
    'suspended', null, 'Smart doc suite: suspend after fixture creation'
  );
end
$$;

update public.documents
set deleted_at = now(), deleted_by = '25000000-0000-4000-8000-000000000001'
where id = '45000000-0000-4000-8000-000000000006';

-- Every canonical MIME is accepted by the documents row contract.
insert into public.documents (
  id, org_id, entity_type, entity_id, storage_path, file_name, mime_type,
  document_kind, uploaded_by
)
select gen_random_uuid(), '15000000-0000-4000-8000-000000000001', 'inbox', null,
       '15000000-0000-4000-8000-000000000001/smart-doc/mime-' || ordinality,
       'mime-' || ordinality, mime_type, 'other',
       '25000000-0000-4000-8000-000000000001'
from unnest(array[
  'image/jpeg',
  'image/png',
  'application/pdf',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/rtf',
  'text/plain',
  'text/html',
  'application/vnd.oasis.opendocument.text'
]) with ordinality as allowed(mime_type, ordinality);

do $$
begin
  insert into public.documents (
    org_id, entity_type, storage_path, file_name, mime_type, document_kind, uploaded_by
  ) values (
    '15000000-0000-4000-8000-000000000001', 'inbox',
    '15000000-0000-4000-8000-000000000001/smart-doc/blocked.exe',
    'blocked.exe', 'application/x-msdownload', 'other',
    '25000000-0000-4000-8000-000000000001'
  );
  raise exception 'expected executable MIME rejection';
exception when check_violation then
  null;
end
$$;

-- Enqueue derives the Storage eTag server-side and is idempotent for the active contract.
begin;
select set_config('request.jwt.claim.sub', '25000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select public.enqueue_document_processing('45000000-0000-4000-8000-000000000001') as job_id
\gset smart_first_
select public.enqueue_document_processing('45000000-0000-4000-8000-000000000001') as job_id
\gset smart_second_
select count(*) as visible_jobs from public.document_processing_jobs
where document_id = '45000000-0000-4000-8000-000000000001'
\gset smart_owner_
reset role;
commit;

select smart_document_processing_test.assert(
  :'smart_first_job_id'::uuid = :'smart_second_job_id'::uuid
    and (select count(*) = 1 from public.document_processing_jobs
         where document_id = '45000000-0000-4000-8000-000000000001')
    and (select input_checksum = 'etag:' || repeat('a', 64)
         from public.document_processing_jobs where id = :'smart_first_job_id'::uuid),
  'enqueue is not idempotent or did not derive the normalized Storage eTag'
);

select smart_document_processing_test.assert(
  :'smart_owner_visible_jobs'::integer = 1,
  'owner cannot read the tenant processing job through RLS'
);

-- Cross-tenant, missing-eTag and accountant calls fail closed.
begin;
select set_config('request.jwt.claim.sub', '25000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
do $$
begin
  perform public.enqueue_document_processing('45000000-0000-4000-8000-000000000005');
  raise exception 'expected cross-tenant document rejection';
exception when sqlstate 'P0002' then null;
end
$$;
do $$
begin
  perform public.enqueue_document_processing('45000000-0000-4000-8000-000000000004');
  raise exception 'expected missing eTag rejection';
exception when sqlstate '22023' then null;
end
$$;
reset role;
commit;

begin;
select set_config('request.jwt.claim.sub', '25000000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select count(*) as visible_jobs from public.document_processing_jobs
\gset smart_accountant_
do $$
begin
  perform public.enqueue_document_processing('45000000-0000-4000-8000-000000000001');
  raise exception 'expected accountant enqueue rejection';
exception when sqlstate '42501' then null;
end
$$;
reset role;
commit;

select smart_document_processing_test.assert(
  :'smart_accountant_visible_jobs'::integer = 0,
  'accountant received new processing-table access'
);

begin;
select set_config('request.jwt.claim.sub', '25000000-0000-4000-8000-000000000005', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select count(*) as visible_jobs from public.document_processing_jobs
\gset smart_tenant_b_
reset role;
commit;

select smart_document_processing_test.assert(
  :'smart_tenant_b_visible_jobs'::integer = 0,
  'tenant B can read tenant A processing jobs'
);

do $$
begin
  update public.document_processing_jobs
  set status = 'review'
  where document_id = '45000000-0000-4000-8000-000000000001';
  raise exception 'expected queued-to-review transition rejection';
exception when sqlstate '23514' then null;
end
$$;

-- The service path cannot claim, heartbeat or complete work for a suspended tenant.
begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
do $$
begin
  perform public.heartbeat_document_processing_job(
    '55000000-0000-4000-8000-000000000107', 'worker-suspended', 60
  );
  raise exception 'expected suspended heartbeat rejection';
exception when sqlstate '55000' then null;
end
$$;
do $$
begin
  perform public.complete_document_processing_job(
    '55000000-0000-4000-8000-000000000107',
    'worker-suspended',
    'fixture', 'fixture-model', '1.0.0',
    'etag:' || repeat('0', 64),
    '1',
    smart_document_processing_test.valid_payload('suspended source'),
    10,
    '{}'::jsonb
  );
  raise exception 'expected suspended complete rejection';
exception when sqlstate 'P0002' then
  if sqlerrm <> 'org_suspended' then raise; end if;
end
$$;
reset role;
commit;

select smart_document_processing_test.assert(
  (select status = 'queued' and attempt_count = 0
   from public.document_processing_jobs
   where id = '55000000-0000-4000-8000-000000000007')
  and (select status = 'leased' and lease_owner = 'worker-suspended'
       from public.document_processing_jobs
       where id = '55000000-0000-4000-8000-000000000107')
  and not exists (
    select 1 from public.document_extractions
    where job_id = '55000000-0000-4000-8000-000000000107'
  ),
  'suspended tenant work was claimed, extended or completed'
);

-- Only one worker owns an unexpired lease; heartbeat and complete preserve source identity.
select smart_document_processing_test.valid_payload('חילוץ תקין')::text as payload
\gset smart_valid_
select input_checksum as checksum
from public.document_processing_jobs
where id = :'smart_first_job_id'::uuid
\gset smart_source_

begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select (public.claim_document_processing_job('worker-a', 60) ->> 'job_id') as job_id
\gset smart_claim_
do $$
begin
  perform public.heartbeat_document_processing_job(
    (select id from public.document_processing_jobs
     where document_id = '45000000-0000-4000-8000-000000000001' and status = 'leased'),
    ' ',
    60
  );
  raise exception 'expected blank heartbeat owner rejection';
exception when sqlstate '22023' then null;
end
$$;
do $$
begin
  perform public.complete_document_processing_job(
    (select id from public.document_processing_jobs
     where document_id = '45000000-0000-4000-8000-000000000001' and status = 'leased'),
    '',
    'fixture', 'fixture-model', '1.0.0',
    (select input_checksum from public.document_processing_jobs
     where document_id = '45000000-0000-4000-8000-000000000001' and status = 'leased'),
    '1', smart_document_processing_test.valid_payload('blank owner'), 10, '{}'::jsonb
  );
  raise exception 'expected blank complete owner rejection';
exception when sqlstate '22023' then null;
end
$$;
do $$
begin
  perform public.fail_document_processing_job(
    (select id from public.document_processing_jobs
     where document_id = '45000000-0000-4000-8000-000000000001' and status = 'leased'),
    null,
    'invalid_owner',
    'blank owner must not fail another lease'
  );
  raise exception 'expected null fail owner rejection';
exception when sqlstate '22023' then null;
end
$$;
do $$
begin
  perform public.complete_document_processing_job(
    (select id from public.document_processing_jobs
     where document_id = '45000000-0000-4000-8000-000000000001' and status = 'leased'),
    'worker-b',
    'fixture', 'fixture-model', '1.0.0',
    (select input_checksum from public.document_processing_jobs
     where document_id = '45000000-0000-4000-8000-000000000001' and status = 'leased'),
    '1', smart_document_processing_test.valid_payload('wrong owner'), 10, '{}'::jsonb
  );
  raise exception 'expected wrong complete owner rejection';
exception when sqlstate '55000' then null;
end
$$;
do $$
begin
  perform public.fail_document_processing_job(
    (select id from public.document_processing_jobs
     where document_id = '45000000-0000-4000-8000-000000000001' and status = 'leased'),
    'worker-b',
    'wrong_owner',
    'wrong owner must not fail another lease'
  );
  raise exception 'expected wrong fail owner rejection';
exception when sqlstate '55000' then null;
end
$$;
do $$
begin
  perform public.complete_document_processing_job(
    (select id from public.document_processing_jobs
     where document_id = '45000000-0000-4000-8000-000000000001' and status = 'leased'),
    'worker-a',
    'fixture', 'fixture-model', '1.0.0',
    null,
    '1', smart_document_processing_test.valid_payload('null checksum'), 10, '{}'::jsonb
  );
  raise exception 'expected null checksum rejection';
exception when sqlstate '22023' then null;
end
$$;
do $$
begin
  perform public.complete_document_processing_job(
    (select id from public.document_processing_jobs
     where document_id = '45000000-0000-4000-8000-000000000001' and status = 'leased'),
    'worker-a',
    'fixture', 'fixture-model', '1.0.0',
    (select input_checksum from public.document_processing_jobs
     where document_id = '45000000-0000-4000-8000-000000000001' and status = 'leased'),
    null, smart_document_processing_test.valid_payload('null contract version'), 10, '{}'::jsonb
  );
  raise exception 'expected null contract-version rejection';
exception when sqlstate '22023' then null;
end
$$;
select public.heartbeat_document_processing_job(:'smart_claim_job_id'::uuid, 'worker-a', 60) as lease_until
\gset smart_heartbeat_
select coalesce(public.claim_document_processing_job('worker-b', 60) ->> 'job_id', '') as job_id
\gset smart_second_claim_
select public.complete_document_processing_job(
  :'smart_claim_job_id'::uuid,
  'worker-a',
  'fixture',
  'fixture-model',
  '1.0.0',
  :'smart_source_checksum',
  '1',
  :'smart_valid_payload'::jsonb,
  25,
  '{"gpu":"fixture"}'::jsonb
) as extraction_id
\gset smart_complete_
reset role;
commit;

select smart_document_processing_test.assert(
  :'smart_claim_job_id'::uuid = :'smart_first_job_id'::uuid
    and :'smart_second_claim_job_id' = ''
    and :'smart_heartbeat_lease_until'::timestamptz > now()
    and (select status = 'failed'
                and last_error_code = 'document_deleted'
                and lease_owner is null
                and lease_until is null
         from public.document_processing_jobs
         where id = '55000000-0000-4000-8000-000000000006')
    and exists (
      select 1 from public.audit_logs
      where action = 'document_processing_failed'
        and entity_id = '55000000-0000-4000-8000-000000000006'
        and new_values ->> 'error_code' = 'document_deleted'
    )
    and (select status = 'extracted' and lease_owner is null and lease_until is null
         from public.document_processing_jobs where id = :'smart_first_job_id'::uuid)
    and (select payload = :'smart_valid_payload'::jsonb
         from public.document_extractions where id = :'smart_complete_extraction_id'::uuid),
  'claim, deleted-source cleanup, heartbeat or complete violated the lease/extraction contract'
);

do $$
begin
  update public.document_processing_jobs
  set status = 'completed'
  where document_id = '45000000-0000-4000-8000-000000000001'
    and status = 'extracted';
  raise exception 'expected extracted-to-completed transition rejection';
exception when sqlstate '23514' then null;
end
$$;

begin;
select set_config('request.jwt.claim.sub', '25000000-0000-4000-8000-000000000005', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select count(*) as visible_extractions from public.document_extractions
\gset smart_tenant_b_extraction_
reset role;
commit;

select smart_document_processing_test.assert(
  :'smart_tenant_b_extraction_visible_extractions'::integer = 0,
  'tenant B can read tenant A extraction'
);

do $$
begin
  update public.document_extractions
  set model_version = 'mutated'
  where document_id = '45000000-0000-4000-8000-000000000001';
  raise exception 'expected extraction update rejection';
exception when sqlstate '42501' then null;
end
$$;

do $$
begin
  delete from public.document_extractions
  where document_id = '45000000-0000-4000-8000-000000000001';
  raise exception 'expected extraction delete rejection';
exception when sqlstate '42501' then null;
end
$$;

-- The validator rejects missing fields, wrong JSON types, fractional pages and invalid geometry.
select smart_document_processing_test.assert(
  not public.smart_document_extraction_valid(
    jsonb_set(:'smart_valid_payload'::jsonb, '{schema_version}', 'null'::jsonb),
    '1'
  )
  and not public.smart_document_extraction_valid(
    jsonb_set(:'smart_valid_payload'::jsonb, '{schema_version}', '1'::jsonb),
    '1'
  )
  and not public.smart_document_extraction_valid(
    jsonb_set(:'smart_valid_payload'::jsonb, '{blocks,0,type}', 'null'::jsonb),
    '1'
  )
  and not public.smart_document_extraction_valid(
    jsonb_set(
      :'smart_valid_payload'::jsonb,
      '{marks}',
      jsonb_build_array(jsonb_build_object(
        'id', 'mark-1',
        'page', 1,
        'kind', null,
        'bbox', jsonb_build_array(0, 0, 1, 1),
        'nearby_block_ids', '[]'::jsonb,
        'confidence', null,
        'fingerprint', null
      ))
    ),
    '1'
  ),
  'null or non-string contract discriminators were accepted'
);

select smart_document_processing_test.assert(
  not public.smart_document_extraction_valid(
    jsonb_set(
      :'smart_valid_payload'::jsonb,
      '{tables}',
      jsonb_build_array(
        jsonb_build_object(
          'id', 'table-1', 'page', 1, 'bbox', jsonb_build_array(0, 0, 1, 1),
          'rows', (select jsonb_agg('[]'::jsonb) from generate_series(1, 2501))
        ),
        jsonb_build_object(
          'id', 'table-2', 'page', 1, 'bbox', jsonb_build_array(0, 0, 1, 1),
          'rows', (select jsonb_agg('[]'::jsonb) from generate_series(1, 2500))
        )
      )
    ),
    '1'
  ),
  'aggregate spreadsheet row limit was enforced per table instead of per document'
);

select smart_document_processing_test.assert(
  not public.smart_document_extraction_valid(
    jsonb_set(:'smart_valid_payload'::jsonb, '{blocks,0}',
      (:'smart_valid_payload'::jsonb #> '{blocks,0}') - 'confidence'),
    '1'
  ),
  'payload with a missing required block field was accepted'
);

select smart_document_processing_test.assert(
  not public.smart_document_extraction_valid(
    jsonb_set(:'smart_valid_payload'::jsonb, '{blocks,0,page}', '1.5'::jsonb),
    '1'
  ),
  'fractional page number was accepted'
);

select smart_document_processing_test.assert(
  not public.smart_document_extraction_valid(
    jsonb_set(:'smart_valid_payload'::jsonb, '{blocks,0,bbox}', '[0,0,1.1,1]'::jsonb),
    '1'
  ),
  'out-of-range bounding box was accepted'
);

-- Put the first lifecycle in review: review is a terminal result and may be reprocessed.
select (to_regprocedure('public.begin_document_interpretation(uuid,uuid,uuid)') is not null) as available
\gset smart_learning_
\if :smart_learning_available
begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.begin_document_interpretation(
  :'smart_first_job_id'::uuid,
  :'smart_complete_extraction_id'::uuid,
  '25000000-0000-4000-8000-000000000001'
)::text as payload
\gset smart_begin_
select public.save_document_interpretation(
  :'smart_first_job_id'::uuid,
  :'smart_complete_extraction_id'::uuid,
  '25000000-0000-4000-8000-000000000001',
  (:'smart_begin_payload'::jsonb ->> 'interpretation_started_at')::timestamptz,
  'fixture', 'fixture-model', 'smart-document-test', '1',
  '{"schema_version":"1","document_type":"other","document_type_confidence":null,"supplier":{"suggested_id":null,"suggested_name":null,"confidence":null,"evidence_block_ids":[]},"fields":[],"line_items":[],"suggested_annotations":[]}'::jsonb,
  '{}'::jsonb, 1
);
reset role;
commit;
\else
update public.document_processing_jobs
set status = 'interpreting'
where id = :'smart_first_job_id'::uuid;
update public.document_processing_jobs
set status = 'review'
where id = :'smart_first_job_id'::uuid;
\endif
begin;
select set_config('request.jwt.claim.sub', '25000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
do $$
begin
  perform public.reprocess_document('45000000-0000-4000-8000-000000000001', ' ');
  raise exception 'expected reason_required';
exception when sqlstate '22023' then null;
end
$$;
select public.reprocess_document(
  '45000000-0000-4000-8000-000000000001',
  'המשתמש ביקש חילוץ חוזר'
) as job_id
\gset smart_reprocess_
do $$
begin
  perform public.reprocess_document(
    '45000000-0000-4000-8000-000000000001',
    'ניסיון כפול בזמן שהמשימה כבר בתור'
  );
  raise exception 'expected document_processing_active';
exception when sqlstate '55000' then null;
end
$$;
reset role;
commit;

update public.document_processing_jobs
set status = 'completed'
where id = :'smart_first_job_id'::uuid;

do $$
begin
  update public.document_processing_jobs
  set status = 'queued'
  where document_id = '45000000-0000-4000-8000-000000000001'
    and status = 'completed';
  raise exception 'expected terminal job transition rejection';
exception when sqlstate '23514' then null;
end
$$;

select smart_document_processing_test.assert(
  :'smart_reprocess_job_id'::uuid <> :'smart_first_job_id'::uuid
    and (select count(*) = 1 from public.audit_logs
         where action = 'document_processing_reprocessed'
           and entity_id = :'smart_reprocess_job_id'::uuid
           and reason = 'המשתמש ביקש חילוץ חוזר'),
  'reasoned reprocess did not preserve history and audit'
);

begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select (public.claim_document_processing_job('worker-reprocess', 60) ->> 'job_id') as job_id
\gset smart_reprocess_claim_
select public.fail_document_processing_job(
  :'smart_reprocess_claim_job_id'::uuid,
  'worker-reprocess',
  'fixture_failure',
  'synthetic failure'
) as job_id
\gset smart_failed_
reset role;
commit;

select smart_document_processing_test.assert(
  :'smart_failed_job_id'::uuid = :'smart_reprocess_job_id'::uuid
    and (select status = 'failed' and last_error_code = 'fixture_failure'
         from public.document_processing_jobs where id = :'smart_failed_job_id'::uuid),
  'worker failure did not create a terminal explicit error'
);

-- Changed Storage bytes invalidate a leased job before an extraction can be stored.
begin;
select set_config('request.jwt.claim.sub', '25000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select public.enqueue_document_processing('45000000-0000-4000-8000-000000000003') as job_id
\gset smart_changed_
reset role;
commit;

select input_checksum as checksum
from public.document_processing_jobs
where id = :'smart_changed_job_id'::uuid
\gset smart_changed_source_

begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select (public.claim_document_processing_job('worker-changed', 60) ->> 'job_id') as job_id
\gset smart_changed_claim_
reset role;
commit;

update storage.objects
set metadata = jsonb_set(metadata, '{eTag}', to_jsonb(repeat('e', 64)))
where bucket_id = 'documents'
  and name = '15000000-0000-4000-8000-000000000001/smart-doc/changed.pdf';

begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
do $$
begin
  perform public.complete_document_processing_job(
    (select id from public.document_processing_jobs
     where document_id = '45000000-0000-4000-8000-000000000003' and status = 'leased'),
    'worker-changed',
    'fixture', 'fixture-model', '1.0.0',
    (select input_checksum from public.document_processing_jobs
     where document_id = '45000000-0000-4000-8000-000000000003' and status = 'leased'),
    '1',
    smart_document_processing_test.valid_payload('stale source'),
    10,
    '{}'::jsonb
  );
  raise exception 'expected changed-source rejection';
exception when sqlstate '22023' then null;
end
$$;
select public.fail_document_processing_job(
  :'smart_changed_claim_job_id'::uuid,
  'worker-changed',
  'source_changed',
  'Storage eTag changed while leased'
) as job_id
\gset smart_changed_failed_
reset role;
commit;

select smart_document_processing_test.assert(
  :'smart_changed_failed_job_id'::uuid = :'smart_changed_job_id'::uuid
    and not exists (
      select 1 from public.document_extractions where job_id = :'smart_changed_job_id'::uuid
    ),
  'changed source produced an extraction'
);

-- An expired lease is reclaimable, while two parallel workers cannot claim the same queued job.
begin;
select set_config('request.jwt.claim.sub', '25000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select public.enqueue_document_processing('45000000-0000-4000-8000-000000000002') as job_id
\gset smart_retry_
reset role;
commit;

begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select (public.claim_document_processing_job('worker-expired', 30) ->> 'job_id') as job_id
\gset smart_expired_
reset role;
commit;

update public.document_processing_jobs
set lease_until = now() - interval '1 second'
where id = :'smart_expired_job_id'::uuid;

begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select (public.claim_document_processing_job('worker-reclaimer', 30) ->> 'job_id') as job_id
\gset smart_reclaimed_
select public.fail_document_processing_job(
  :'smart_reclaimed_job_id'::uuid,
  'worker-reclaimer',
  'fixture_reclaimed',
  'lease retry completed'
) as job_id
\gset smart_reclaimed_failed_
reset role;
commit;

select smart_document_processing_test.assert(
  :'smart_reclaimed_job_id'::uuid = :'smart_retry_job_id'::uuid
    and (select attempt_count = 2 from public.document_processing_jobs
         where id = :'smart_retry_job_id'::uuid),
  'expired lease was not reclaimed exactly once'
);

-- Re-enqueue the now-failed source and race two independent service sessions.
begin;
select set_config('request.jwt.claim.sub', '25000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select public.enqueue_document_processing('45000000-0000-4000-8000-000000000002') as job_id
\gset smart_parallel_
reset role;
commit;

select dblink_connect(
  'smart_worker_a',
  'host=127.0.0.1 port=5432 dbname=postgres user=postgres password=postgres'
);
select dblink_connect(
  'smart_worker_b',
  'host=127.0.0.1 port=5432 dbname=postgres user=postgres password=postgres'
);
select dblink_exec('smart_worker_a', 'set "request.jwt.claim.role" = ''service_role''');
select dblink_exec('smart_worker_b', 'set "request.jwt.claim.role" = ''service_role''');
select dblink_exec('smart_worker_a', 'set role service_role');
select dblink_exec('smart_worker_b', 'set role service_role');
select dblink_send_query(
  'smart_worker_a',
  $$select coalesce((public.claim_document_processing_job('parallel-a', 60) ->> 'job_id'), '')$$
);
select dblink_send_query(
  'smart_worker_b',
  $$select coalesce((public.claim_document_processing_job('parallel-b', 60) ->> 'job_id'), '')$$
);
select result as job_id from dblink_get_result('smart_worker_a') as result(result text)
\gset smart_parallel_a_
select result as job_id from dblink_get_result('smart_worker_b') as result(result text)
\gset smart_parallel_b_
select dblink_disconnect('smart_worker_a');
select dblink_disconnect('smart_worker_b');

select smart_document_processing_test.assert(
  ((:'smart_parallel_a_job_id' = :'smart_parallel_job_id'::text)::integer
   + (:'smart_parallel_b_job_id' = :'smart_parallel_job_id'::text)::integer) = 1
    and ((:'smart_parallel_a_job_id' = '')::integer
         + (:'smart_parallel_b_job_id' = '')::integer) = 1,
  'parallel workers did not produce exactly one claim winner'
);

-- No browser role can mutate the immutable queue/extraction ledgers directly.
begin;
select set_config('request.jwt.claim.sub', '25000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
do $$
begin
  update public.document_processing_jobs set priority = 999;
  raise exception 'expected browser queue update rejection';
exception when sqlstate '42501' then null;
end
$$;
do $$
begin
  delete from public.document_extractions;
  raise exception 'expected browser extraction delete rejection';
exception when sqlstate '42501' then null;
end
$$;
reset role;
commit;

select 'smart_document_processing_passed' as result;
