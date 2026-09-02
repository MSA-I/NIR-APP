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

create function smart_document_processing_test.valid_payload_of_canonical_size(
  p_target_bytes integer
) returns jsonb
language plpgsql
immutable
as $$
declare
  v_payload jsonb := jsonb_set(
    smart_document_processing_test.valid_payload('x'),
    '{tables}', jsonb_build_array(jsonb_build_object(
      'id', 'table-cap', 'page', 1,
      'bbox', jsonb_build_array(0, 0, 1, 1),
      'rows', jsonb_build_array(jsonb_build_array(jsonb_build_object(
        'text', '', 'bbox', null
      )))
    )), false
  );
  v_filler_bytes integer;
begin
  v_filler_bytes := p_target_bytes - octet_length(v_payload::text);
  if v_filler_bytes < 0 then
    raise exception 'target payload is smaller than the valid extraction envelope';
  end if;
  v_payload := jsonb_set(
    v_payload, '{tables,0,rows,0,0,text}', to_jsonb(repeat('x', v_filler_bytes)), false
  );
  if octet_length(v_payload::text) <> p_target_bytes then
    raise exception 'canonical payload fixture size mismatch';
  end if;
  return v_payload;
end
$$;

grant usage on schema smart_document_processing_test to authenticated, service_role;
grant execute on function smart_document_processing_test.valid_payload(text) to authenticated, service_role;
grant execute on function smart_document_processing_test.valid_payload_of_canonical_size(integer)
  to service_role;

create function smart_document_processing_test.start_egress(p_job_id uuid, p_owner text)
returns jsonb
language plpgsql
as $$
declare
  v_job public.document_processing_jobs;
  v_reservation jsonb;
  v_ack jsonb;
begin
  select * into v_job from public.document_processing_jobs where id = p_job_id;
  if v_job.status <> 'leased' or v_job.lease_owner is distinct from p_owner
     or v_job.processing_attempt_id is null then
    raise exception 'smart test cannot start egress for an unowned attempt';
  end if;
  v_reservation := public.service_reserve_organization_external_egress(
    v_job.org_id, 'document_signed_url', v_job.processing_attempt_id, 90
  );
  v_ack := public.service_acknowledge_document_processing_download(
    v_job.id, p_owner,
    (v_reservation ->> 'lease_id')::uuid,
    (v_reservation ->> 'lease_token')::uuid,
    300
  );
  return v_ack || jsonb_build_object('egress_lease_token', v_reservation ->> 'lease_token');
end
$$;
revoke all on function smart_document_processing_test.start_egress(uuid, text)
  from public, anon, authenticated;
grant execute on function smart_document_processing_test.start_egress(uuid, text) to service_role;

create function smart_document_processing_test.record_ocr(
  p_job_id uuid,
  p_processing_attempt_id uuid,
  p_owner text,
  p_egress_lease_id uuid,
  p_egress_lease_token uuid,
  p_payload jsonb,
  p_duration_ms integer default 10,
  p_resource_metadata jsonb default '{}'::jsonb
) returns jsonb
language sql
as $$
  select public.service_record_document_ocr_evidence(
    p_job_id, p_processing_attempt_id, p_owner,
    p_egress_lease_id, p_egress_lease_token,
    'fixture', 'fixture-model', '1.0.0',
    job.input_checksum, job.contract_version,
    p_payload, p_duration_ms, p_resource_metadata
  )
  from public.document_processing_jobs job
  where job.id = p_job_id
$$;
revoke all on function smart_document_processing_test.record_ocr(
  uuid, uuid, text, uuid, uuid, jsonb, integer, jsonb
) from public, anon, authenticated;
grant execute on function smart_document_processing_test.record_ocr(
  uuid, uuid, text, uuid, uuid, jsonb, integer, jsonb
) to service_role;

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

-- The tenant tie is asserted by its GUARANTEE, not by one spelling of it. 0279 WIDENS this
-- foreign key from (org_id, document_id) to (org_id, document_id, source): every guarantee the
-- narrow one gave still holds, plus a document can no longer shed its source and escape the
-- actor requirement. Pinning the exact old text failed on a change that strengthened the very
-- thing being checked -- so the pattern now requires the two tenant columns and the documents
-- reference, and tolerates further columns between them.
select smart_document_processing_test.assert(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.document_processing_jobs'::regclass
      and contype = 'f'
      and pg_get_constraintdef(oid) ilike '%foreign key (org_id, document_id%references documents(org_id, id%'
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
      and pg_get_constraintdef(oid) ilike '%foreign key (org_id, document_id%references documents(org_id, id%'
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
    and not has_function_privilege('authenticated', 'public.service_acknowledge_document_processing_download(uuid,text,uuid,uuid,integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.service_record_document_ocr_evidence(uuid,uuid,text,uuid,uuid,text,text,text,text,text,jsonb,integer,jsonb)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.heartbeat_document_processing_job(uuid,text,uuid,uuid,integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.complete_document_processing_job(uuid,uuid,text,uuid,uuid,text)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.fail_document_processing_job(uuid,text,uuid,uuid,text,text,boolean)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.service_recover_document_extraction_from_egress(uuid,uuid,uuid,text)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.claim_document_processing_job(text,integer)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.service_acknowledge_document_processing_download(uuid,text,uuid,uuid,integer)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.service_record_document_ocr_evidence(uuid,uuid,text,uuid,uuid,text,text,text,text,text,jsonb,integer,jsonb)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.heartbeat_document_processing_job(uuid,text,uuid,uuid,integer)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.complete_document_processing_job(uuid,uuid,text,uuid,uuid,text)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.fail_document_processing_job(uuid,text,uuid,uuid,text,text,boolean)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.service_recover_document_extraction_from_egress(uuid,uuid,uuid,text)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.heartbeat_document_processing_job(uuid,text,integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.complete_document_processing_job(uuid,text,text,text,text,text,text,jsonb,integer,jsonb)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.fail_document_processing_job(uuid,text,text,text)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.heartbeat_document_processing_job(uuid,text,integer)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.complete_document_processing_job(uuid,text,text,text,text,text,text,jsonb,integer,jsonb)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.fail_document_processing_job(uuid,text,text,text)', 'EXECUTE')
    and to_regprocedure('public.complete_document_processing_job(uuid,text,uuid,uuid,text,text,text,text,text,jsonb,integer,jsonb)') is null
    and position('document_processing_legacy_contract_forbidden' in pg_get_functiondef(
      'public.complete_document_processing_job(uuid,text,text,text,text,text,text,jsonb,integer,jsonb)'::regprocedure
    )) > 0,
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
      'application/vnd.oasis.opendocument.text'
    ]::text[] <@ allowed_mime_types
    and not ('application/x-msdownload' = any(allowed_mime_types))
   from storage.buckets where id = 'documents'),
  'documents bucket MIME allowlist is incomplete or permits executables'
);

-- 0288, OPEN-DECISIONS #346: HTML is not a document type. The bucket allowlist is enforced by the
-- storage service before any policy runs, so this is the layer that stops the bytes arriving at
-- all. Asserted as a separate claim rather than folded into the line above: a missing type and a
-- forbidden one fail for opposite reasons, and one message cannot say which happened.
select smart_document_processing_test.assert(
  (select not ('text/html' = any(allowed_mime_types))
     and not ('application/xhtml+xml' = any(allowed_mime_types))
   from storage.buckets where id = 'documents'),
  'documents bucket still permits a MIME type the browser renders as a page'
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
  ('25000000-0000-4000-8000-000000000003', 'smart-doc-office-b@example.test'),
  ('25000000-0000-4000-8000-000000000004', 'smart-doc-accountant-a@example.test'),
  ('25000000-0000-4000-8000-000000000005', 'smart-doc-owner-b@example.test'),
  ('25000000-0000-4000-8000-000000000006', 'smart-doc-owner-suspended@example.test'),
  ('25000000-0000-4000-8000-000000000007', 'smart-doc-platform-admin@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('25000000-0000-4000-8000-000000000001', '15000000-0000-4000-8000-000000000001', 'Smart doc owner A', 'owner'),
  ('25000000-0000-4000-8000-000000000002', '15000000-0000-4000-8000-000000000001', 'Smart doc office A', 'office'),
  ('25000000-0000-4000-8000-000000000003', '15000000-0000-4000-8000-000000000001', 'Smart doc office B', 'office'),
  ('25000000-0000-4000-8000-000000000004', '15000000-0000-4000-8000-000000000001', 'Smart doc accountant A', 'accountant'),
  ('25000000-0000-4000-8000-000000000005', '15000000-0000-4000-8000-000000000002', 'Smart doc owner B', 'owner'),
  ('25000000-0000-4000-8000-000000000006', '15000000-0000-4000-8000-000000000003', 'Smart doc owner suspended', 'owner'),
  ('25000000-0000-4000-8000-000000000007', '15000000-0000-4000-8000-000000000001', 'Smart doc platform admin', 'owner');

insert into public.platform_admins (user_id, note) values
  ('25000000-0000-4000-8000-000000000007', 'P4 smart document suspended fixture');

insert into storage.objects (bucket_id, name, owner, metadata) values
  ('documents', '15000000-0000-4000-8000-000000000001/smart-doc/main.pdf', '25000000-0000-4000-8000-000000000001', jsonb_build_object('mimetype', 'application/pdf', 'size', 100, 'eTag', upper(repeat('a', 64)))),
  ('documents', '15000000-0000-4000-8000-000000000001/smart-doc/retry.pdf', '25000000-0000-4000-8000-000000000001', jsonb_build_object('mimetype', 'application/pdf', 'size', 100, 'eTag', repeat('b', 64))),
  ('documents', '15000000-0000-4000-8000-000000000001/smart-doc/changed.pdf', '25000000-0000-4000-8000-000000000001', jsonb_build_object('mimetype', 'application/pdf', 'size', 100, 'eTag', repeat('c', 64))),
  ('documents', '15000000-0000-4000-8000-000000000001/smart-doc/crash.pdf', '25000000-0000-4000-8000-000000000001', jsonb_build_object('mimetype', 'application/pdf', 'size', 100, 'eTag', repeat('8', 64))),
  ('documents', '15000000-0000-4000-8000-000000000001/smart-doc/missing-etag.pdf', '25000000-0000-4000-8000-000000000001', jsonb_build_object('mimetype', 'application/pdf', 'size', 100)),
  ('documents', '15000000-0000-4000-8000-000000000001/smart-doc/deleted.pdf', '25000000-0000-4000-8000-000000000001', jsonb_build_object('mimetype', 'application/pdf', 'size', 100, 'eTag', repeat('f', 64))),
  ('documents', '15000000-0000-4000-8000-000000000002/smart-doc/tenant-b.pdf', '25000000-0000-4000-8000-000000000005', jsonb_build_object('mimetype', 'application/pdf', 'size', 100, 'eTag', repeat('d', 64))),
  ('documents', '15000000-0000-4000-8000-000000000003/smart-doc/suspended.pdf', '25000000-0000-4000-8000-000000000006', jsonb_build_object('mimetype', 'application/pdf', 'size', 100, 'eTag', repeat('e', 64))),
  ('documents', '15000000-0000-4000-8000-000000000002/smart-doc/legacy-complete.pdf', '25000000-0000-4000-8000-000000000005', jsonb_build_object('mimetype', 'application/pdf', 'size', 100, 'eTag', repeat('1', 64))),
  ('documents', '15000000-0000-4000-8000-000000000002/smart-doc/legacy-inflight.pdf', '25000000-0000-4000-8000-000000000005', jsonb_build_object('mimetype', 'application/pdf', 'size', 100, 'eTag', repeat('2', 64)));

insert into public.documents (
  id, org_id, entity_type, entity_id, storage_path, file_name, mime_type,
  document_kind, uploaded_by
) values
  ('45000000-0000-4000-8000-000000000001', '15000000-0000-4000-8000-000000000001', 'inbox', null, '15000000-0000-4000-8000-000000000001/smart-doc/main.pdf', 'main.pdf', 'application/pdf', 'other', '25000000-0000-4000-8000-000000000001'),
  ('45000000-0000-4000-8000-000000000002', '15000000-0000-4000-8000-000000000001', 'inbox', null, '15000000-0000-4000-8000-000000000001/smart-doc/retry.pdf', 'retry.pdf', 'application/pdf', 'other', '25000000-0000-4000-8000-000000000001'),
  ('45000000-0000-4000-8000-000000000003', '15000000-0000-4000-8000-000000000001', 'inbox', null, '15000000-0000-4000-8000-000000000001/smart-doc/changed.pdf', 'changed.pdf', 'application/pdf', 'price_list', '25000000-0000-4000-8000-000000000001'),
  ('45000000-0000-4000-8000-000000000008', '15000000-0000-4000-8000-000000000001', 'inbox', null, '15000000-0000-4000-8000-000000000001/smart-doc/crash.pdf', 'crash.pdf', 'application/pdf', 'other', '25000000-0000-4000-8000-000000000001'),
  ('45000000-0000-4000-8000-000000000004', '15000000-0000-4000-8000-000000000001', 'inbox', null, '15000000-0000-4000-8000-000000000001/smart-doc/missing-etag.pdf', 'missing-etag.pdf', 'application/pdf', 'other', '25000000-0000-4000-8000-000000000001'),
  ('45000000-0000-4000-8000-000000000006', '15000000-0000-4000-8000-000000000001', 'inbox', null, '15000000-0000-4000-8000-000000000001/smart-doc/deleted.pdf', 'deleted.pdf', 'application/pdf', 'other', '25000000-0000-4000-8000-000000000001'),
  ('45000000-0000-4000-8000-000000000005', '15000000-0000-4000-8000-000000000002', 'inbox', null, '15000000-0000-4000-8000-000000000002/smart-doc/tenant-b.pdf', 'tenant-b.pdf', 'application/pdf', 'other', '25000000-0000-4000-8000-000000000005'),
  ('45000000-0000-4000-8000-000000000007', '15000000-0000-4000-8000-000000000003', 'inbox', null, '15000000-0000-4000-8000-000000000003/smart-doc/suspended.pdf', 'suspended.pdf', 'application/pdf', 'other', '25000000-0000-4000-8000-000000000006'),
  ('45000000-0000-4000-8000-000000000009', '15000000-0000-4000-8000-000000000002', 'inbox', null, '15000000-0000-4000-8000-000000000002/smart-doc/legacy-complete.pdf', 'legacy-complete.pdf', 'application/pdf', 'other', '25000000-0000-4000-8000-000000000005'),
  ('45000000-0000-4000-8000-000000000010', '15000000-0000-4000-8000-000000000002', 'inbox', null, '15000000-0000-4000-8000-000000000002/smart-doc/legacy-inflight.pdf', 'legacy-inflight.pdf', 'application/pdf', 'other', '25000000-0000-4000-8000-000000000005');

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
  attempt_count, lease_owner, lease_until,
  processing_attempt_id, processing_attempt_started_at, created_at, updated_at
) values
  (
    '55000000-0000-4000-8000-000000000007',
    '15000000-0000-4000-8000-000000000003',
    '45000000-0000-4000-8000-000000000007',
    '25000000-0000-4000-8000-000000000006',
    'queued', 'etag:' || repeat('d', 64),
    0, null, null, null, null,
    '1999-01-01 00:00:00+00', '1999-01-01 00:00:00+00'
  ),
  (
    '55000000-0000-4000-8000-000000000107',
    '15000000-0000-4000-8000-000000000003',
    '45000000-0000-4000-8000-000000000007',
    '25000000-0000-4000-8000-000000000006',
    'leased', 'etag:' || repeat('e', 64),
    1, 'worker-suspended', now() + interval '10 minutes',
    '65000000-0000-4000-8000-000000000107', now(),
    '1998-01-01 00:00:00+00', '1998-01-01 00:00:00+00'
  );

-- Expand/contract fixtures: one job was claimed by the deployed legacy worker after the DB
-- migration (attempt id present), and one was already leased before the new columns existed.
insert into public.document_processing_jobs (
  id, org_id, document_id, requested_by, status, input_checksum,
  attempt_count, lease_owner, lease_until,
  processing_attempt_id, processing_attempt_started_at, created_at, updated_at
) values
  (
    '55000000-0000-4000-8000-000000000009',
    '15000000-0000-4000-8000-000000000002',
    '45000000-0000-4000-8000-000000000009',
    '25000000-0000-4000-8000-000000000005',
    'leased', 'etag:' || repeat('1', 64), 1, 'worker-legacy', now() + interval '10 minutes',
    '65000000-0000-4000-8000-000000000009', now(), now(), now()
  ),
  (
    '55000000-0000-4000-8000-000000000010',
    '15000000-0000-4000-8000-000000000002',
    '45000000-0000-4000-8000-000000000010',
    '25000000-0000-4000-8000-000000000005',
    'leased', 'etag:' || repeat('2', 64), 1, 'worker-inflight', now() + interval '10 minutes',
    null, null, now(), now()
  );

-- Belongs to tenant 3, so it has to be written while that tenant is still writable -- i.e.
-- strictly before the lifecycle command below.
insert into private.organization_external_egress_leases (
  lease_id, lease_token, org_id, kind, correlation_id, expires_at,
  acknowledged_at, acknowledged_by
) values (
  '75000000-0000-4000-8000-000000000107',
  '85000000-0000-4000-8000-000000000107',
  '15000000-0000-4000-8000-000000000003',
  'document_signed_url', '65000000-0000-4000-8000-000000000107',
  now() + interval '10 minutes', now(), 'worker-suspended'
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

-- 0288, OPEN-DECISIONS #346: an HTML file is refused by the ROW contract too, not only by the
-- bucket. The row is what an Edge Function or a service-role path writes, so a refusal that lived
-- only in the bucket allowlist would leave the type reachable from every non-browser writer. The
-- claim is the same shape as the executable one above, deliberately: both are types that execute.
do $$
begin
  insert into public.documents (
    org_id, entity_type, storage_path, file_name, mime_type, document_kind, uploaded_by
  ) values (
    '15000000-0000-4000-8000-000000000001', 'inbox',
    '15000000-0000-4000-8000-000000000001/smart-doc/price-list.html',
    'price-list.html', 'text/html', 'price_list',
    '25000000-0000-4000-8000-000000000001'
  );
  raise exception 'expected text/html MIME rejection';
exception when check_violation then
  null;
end
$$;

select smart_document_processing_test.assert(
  not public.smart_document_mime_allowed('text/html')
    and not public.smart_document_mime_allowed('TEXT/HTML')
    and not public.smart_document_mime_allowed('application/xhtml+xml')
    and public.smart_document_mime_allowed('application/pdf')
    and public.smart_document_mime_allowed('text/plain'),
  'smart_document_mime_allowed did not remove exactly text/html'
);

-- ...but a RETIRED row keeps the type, and stays writable. This is not a nicety: a CHECK is
-- re-evaluated on every UPDATE, so without the `deleted_at is not null` escape a text/html row
-- stored before 0288 could never be soft-deleted, re-filed or audited again -- and no permitted
-- route could clear it, because hard delete is barred for these records and the guard trigger
-- refuses to let mime_type be edited. The escape is what makes remove_document(id, reason) the
-- answer instead of a dead end.
select smart_document_processing_test.assert(
  (select convalidated and pg_get_constraintdef(oid) like '%deleted_at IS NOT NULL%'
   from pg_constraint
   where conrelid = 'public.documents'::regclass and conname = 'p0_documents_mime_check'),
  'p0_documents_mime_check lost the retired-row escape, freezing every stored HTML document'
);

-- The behaviour behind that definition, proved and then rolled back so no fixture row survives.
begin;
insert into public.documents (
  org_id, entity_type, storage_path, file_name, mime_type, document_kind, uploaded_by,
  deleted_at, deleted_by
) values (
  '15000000-0000-4000-8000-000000000001', 'inbox',
  '15000000-0000-4000-8000-000000000001/smart-doc/retired-price-list.html',
  'retired-price-list.html', 'text/html', 'price_list',
  '25000000-0000-4000-8000-000000000001',
  now(), '25000000-0000-4000-8000-000000000001'
);
rollback;

-- DB-first Edge rollout bridge: the deployed legacy worker can finish a post-migration claim,
-- and a job leased before the migration (therefore with no attempt id) can still settle failure.
begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.heartbeat_document_processing_job(
  '55000000-0000-4000-8000-000000000009', 'worker-legacy', 60
) as lease_until
\gset smart_legacy_heartbeat_
select public.complete_document_processing_job(
  '55000000-0000-4000-8000-000000000009', 'worker-legacy',
  'fixture', 'legacy-model', '1.0.0', 'etag:' || repeat('1', 64), '1',
  smart_document_processing_test.valid_payload('legacy bridge'), 11,
  jsonb_build_object('bridge', true)
) as extraction_id
\gset smart_legacy_complete_
select public.complete_document_processing_job(
  '55000000-0000-4000-8000-000000000009', 'worker-legacy',
  'fixture', 'legacy-model', '1.0.0', 'etag:' || repeat('1', 64), '1',
  smart_document_processing_test.valid_payload('legacy bridge'), 11,
  jsonb_build_object('bridge', true)
) as extraction_id
\gset smart_legacy_replay_
do $$
begin
  perform public.complete_document_processing_job(
    '55000000-0000-4000-8000-000000000009', 'worker-legacy',
    'fixture', 'legacy-model', '1.0.0', 'etag:' || repeat('1', 64), '1',
    smart_document_processing_test.valid_payload('legacy bridge changed'), 11,
    jsonb_build_object('bridge', true)
  );
  raise exception 'expected legacy A/B completion conflict';
exception when unique_violation then null;
end
$$;
select public.fail_document_processing_job(
  '55000000-0000-4000-8000-000000000010', 'worker-inflight',
  'legacy_worker_failed', 'pre-migration job failure'
) as job_id
\gset smart_inflight_fail_
select public.fail_document_processing_job(
  '55000000-0000-4000-8000-000000000010', 'worker-inflight',
  'legacy_worker_failed', 'pre-migration job failure'
) as job_id
\gset smart_inflight_replay_
reset role;
commit;

select smart_document_processing_test.assert(
  :'smart_legacy_complete_extraction_id'::uuid = :'smart_legacy_replay_extraction_id'::uuid
    and :'smart_inflight_fail_job_id'::uuid = :'smart_inflight_replay_job_id'::uuid
    and :'smart_legacy_heartbeat_lease_until'::timestamptz > statement_timestamp()
    and (select status = 'extracted' and processing_attempt_id =
          '65000000-0000-4000-8000-000000000009'::uuid
         from public.document_processing_jobs
         where id = '55000000-0000-4000-8000-000000000009')
    and (select status = 'failed' and processing_attempt_id is null
          and last_error_code = 'legacy_worker_failed'
         from public.document_processing_jobs
         where id = '55000000-0000-4000-8000-000000000010')
    and (select count(*) = 1 from public.audit_logs
         where entity_id = '55000000-0000-4000-8000-000000000009'
           and action = 'document_processing_legacy_bridge_extracted')
    and (select count(*) = 1 from public.audit_logs
         where entity_id = '55000000-0000-4000-8000-000000000010'
           and action = 'document_processing_legacy_bridge_failed'),
  'legacy worker bridge did not safely settle post-migration and in-flight attempts'
);

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
select count(*) as visible_jobs
from public.document_processing_jobs
where org_id = '15000000-0000-4000-8000-000000000001'
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
    '55000000-0000-4000-8000-000000000107', 'worker-suspended',
    '75000000-0000-4000-8000-000000000107',
    '85000000-0000-4000-8000-000000000107', 60
  );
  raise exception 'expected suspended heartbeat rejection';
exception when sqlstate '42501' then null;
end
$$;
do $$
begin
  perform public.service_settle_organization_external_egress_evidence(
    '75000000-0000-4000-8000-000000000107',
    '85000000-0000-4000-8000-000000000107',
    'delivered', 'document_ocr_completed', null,
    jsonb_build_object('extraction', smart_document_processing_test.valid_payload('unbound'))
  );
  raise exception 'expected generic OCR evidence rejection';
exception
  when sqlstate '42501' then
    if position('document_ocr_evidence_narrow_rpc_required' in sqlerrm) = 0 then raise; end if;
end
$$;
select public.service_record_document_ocr_evidence(
  '55000000-0000-4000-8000-000000000107',
  '65000000-0000-4000-8000-000000000107',
  'worker-suspended',
  '75000000-0000-4000-8000-000000000107',
  '85000000-0000-4000-8000-000000000107',
  'fixture', 'fixture-model', '1.0.0', 'etag:' || repeat('e', 64), '1',
  smart_document_processing_test.valid_payload('suspended source'), 10, '{}'::jsonb
) ->> 'evidence_sha256' as evidence_sha256
\gset smart_suspended_evidence_
select result ->> 'business_applied' as business_applied,
       result ->> 'evidence_sha256' as evidence_sha256
from (select public.complete_document_processing_job(
  '55000000-0000-4000-8000-000000000107',
  '65000000-0000-4000-8000-000000000107', 'worker-suspended',
  '75000000-0000-4000-8000-000000000107',
  '85000000-0000-4000-8000-000000000107',
  :'smart_suspended_evidence_evidence_sha256'
) result) completed
\gset smart_suspended_complete_
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
  )
  and :'smart_suspended_complete_business_applied'::boolean is false
  and :'smart_suspended_complete_evidence_sha256' ~ '^[0-9a-f]{64}$'
  and (select status = 'settled' and outcome = 'delivered'
       from private.organization_external_egress_leases
       where lease_id = '75000000-0000-4000-8000-000000000107'),
  'suspended tenant work mutated business data or lost provider evidence'
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
select result ->> 'processing_attempt_id' as processing_attempt_id,
       result ->> 'egress_lease_id' as egress_lease_id,
       result ->> 'egress_lease_token' as egress_lease_token,
       result ->> 'acknowledged_at' as acknowledged_at
from (select smart_document_processing_test.start_egress(
  :'smart_claim_job_id'::uuid, 'worker-a'
) result) started
\gset smart_claim_egress_
select set_config(
  'app.smart_egress_lease_id', :'smart_claim_egress_egress_lease_id', true
);
select set_config(
  'app.smart_egress_lease_token', :'smart_claim_egress_egress_lease_token', true
);
do $$
begin
  perform public.heartbeat_document_processing_job(
    (select id from public.document_processing_jobs
     where document_id = '45000000-0000-4000-8000-000000000001' and status = 'leased'),
    'worker-a', 60
  );
  raise exception 'expected legacy heartbeat downgrade rejection';
exception when sqlstate '42501' then
  if position('document_processing_legacy_contract_forbidden' in sqlerrm) = 0 then raise; end if;
end
$$;
do $$
begin
  perform public.complete_document_processing_job(
    (select id from public.document_processing_jobs
     where document_id = '45000000-0000-4000-8000-000000000001' and status = 'leased'),
    'worker-a', 'fixture', 'legacy-model', '1.0.0',
    (select input_checksum from public.document_processing_jobs
     where document_id = '45000000-0000-4000-8000-000000000001' and status = 'leased'),
    '1', smart_document_processing_test.valid_payload('downgrade'), 10, '{}'::jsonb
  );
  raise exception 'expected legacy complete downgrade rejection';
exception when sqlstate '42501' then
  if position('document_processing_legacy_contract_forbidden' in sqlerrm) = 0 then raise; end if;
end
$$;
do $$
begin
  perform public.fail_document_processing_job(
    (select id from public.document_processing_jobs
     where document_id = '45000000-0000-4000-8000-000000000001' and status = 'leased'),
    'worker-a', 'legacy_failure', 'downgrade'
  );
  raise exception 'expected legacy fail downgrade rejection';
exception when sqlstate '42501' then
  if position('document_processing_legacy_contract_forbidden' in sqlerrm) = 0 then raise; end if;
end
$$;
do $$
begin
  perform public.heartbeat_document_processing_job(
    (select id from public.document_processing_jobs
     where document_id = '45000000-0000-4000-8000-000000000001' and status = 'leased'),
    'worker-a', current_setting('app.smart_egress_lease_id')::uuid,
    '95000000-0000-4000-8000-000000000001', 60
  );
  raise exception 'expected stale egress token rejection';
exception when sqlstate '40001' then null;
end
$$;
do $$
begin
  perform public.heartbeat_document_processing_job(
    (select id from public.document_processing_jobs
     where document_id = '45000000-0000-4000-8000-000000000001' and status = 'leased'),
    ' ',
    current_setting('app.smart_egress_lease_id')::uuid,
    current_setting('app.smart_egress_lease_token')::uuid, 60
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
    (select processing_attempt_id from public.document_processing_jobs
     where document_id = '45000000-0000-4000-8000-000000000001' and status = 'leased'),
    '',
    current_setting('app.smart_egress_lease_id')::uuid,
    current_setting('app.smart_egress_lease_token')::uuid,
    repeat('a', 64)
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
    current_setting('app.smart_egress_lease_id')::uuid,
    current_setting('app.smart_egress_lease_token')::uuid,
    'invalid_owner',
    'blank owner must not fail another lease', false
  );
  raise exception 'expected null fail owner rejection';
exception when sqlstate '22023' then null;
end
$$;
do $$
begin
  perform public.service_record_document_ocr_evidence(
    (select id from public.document_processing_jobs
    where document_id = '45000000-0000-4000-8000-000000000001' and status = 'leased'),
    (select processing_attempt_id from public.document_processing_jobs
     where document_id = '45000000-0000-4000-8000-000000000001' and status = 'leased'),
    'worker-b',
    current_setting('app.smart_egress_lease_id')::uuid,
    current_setting('app.smart_egress_lease_token')::uuid,
    'fixture', 'fixture-model', '1.0.0',
    (select input_checksum from public.document_processing_jobs
     where document_id = '45000000-0000-4000-8000-000000000001' and status = 'leased'),
    '1', smart_document_processing_test.valid_payload('wrong owner'), 10, '{}'::jsonb
  );
  raise exception 'expected wrong evidence owner rejection';
exception when sqlstate '40001' then null;
end
$$;
do $$
begin
  perform public.fail_document_processing_job(
    (select id from public.document_processing_jobs
    where document_id = '45000000-0000-4000-8000-000000000001' and status = 'leased'),
    'worker-b',
    current_setting('app.smart_egress_lease_id')::uuid,
    current_setting('app.smart_egress_lease_token')::uuid,
    'wrong_owner',
    'wrong owner must not fail another lease', false
  );
  raise exception 'expected wrong fail owner rejection';
exception when sqlstate '55000' then null;
end
$$;
do $$
begin
  perform public.service_record_document_ocr_evidence(
    (select id from public.document_processing_jobs
    where document_id = '45000000-0000-4000-8000-000000000001' and status = 'leased'),
    (select processing_attempt_id from public.document_processing_jobs
     where document_id = '45000000-0000-4000-8000-000000000001' and status = 'leased'),
    'worker-a',
    current_setting('app.smart_egress_lease_id')::uuid,
    current_setting('app.smart_egress_lease_token')::uuid,
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
  perform public.service_record_document_ocr_evidence(
    (select id from public.document_processing_jobs
    where document_id = '45000000-0000-4000-8000-000000000001' and status = 'leased'),
    (select processing_attempt_id from public.document_processing_jobs
     where document_id = '45000000-0000-4000-8000-000000000001' and status = 'leased'),
    'worker-a',
    current_setting('app.smart_egress_lease_id')::uuid,
    current_setting('app.smart_egress_lease_token')::uuid,
    'fixture', 'fixture-model', '1.0.0',
    (select input_checksum from public.document_processing_jobs
     where document_id = '45000000-0000-4000-8000-000000000001' and status = 'leased'),
    null, smart_document_processing_test.valid_payload('null contract version'), 10, '{}'::jsonb
  );
  raise exception 'expected null contract-version rejection';
exception when sqlstate '22023' then null;
end
$$;
select result ->> 'job_lease_until' as lease_until
from (select public.heartbeat_document_processing_job(
  :'smart_claim_job_id'::uuid, 'worker-a',
  :'smart_claim_egress_egress_lease_id'::uuid,
  :'smart_claim_egress_egress_lease_token'::uuid, 60
) result) heartbeat
\gset smart_heartbeat_
select coalesce(public.claim_document_processing_job('worker-b', 60) ->> 'job_id', '') as job_id
\gset smart_second_claim_
select result ->> 'evidence_sha256' as evidence_sha256,
       result ->> 'payload_sha256' as payload_sha256,
       result ->> 'idempotent' as idempotent
from (select smart_document_processing_test.record_ocr(
  :'smart_claim_job_id'::uuid,
  :'smart_claim_egress_processing_attempt_id'::uuid,
  'worker-a',
  :'smart_claim_egress_egress_lease_id'::uuid,
  :'smart_claim_egress_egress_lease_token'::uuid,
  :'smart_valid_payload'::jsonb,
  25,
  '{"gpu":"fixture"}'::jsonb
) result) recorded
\gset smart_record_
select result ->> 'evidence_sha256' as evidence_sha256,
       result ->> 'payload_sha256' as payload_sha256,
       result ->> 'idempotent' as idempotent
from (select smart_document_processing_test.record_ocr(
  :'smart_claim_job_id'::uuid,
  :'smart_claim_egress_processing_attempt_id'::uuid,
  'worker-a',
  :'smart_claim_egress_egress_lease_id'::uuid,
  :'smart_claim_egress_egress_lease_token'::uuid,
  :'smart_valid_payload'::jsonb,
  25,
  '{"gpu":"fixture"}'::jsonb
) result) replayed
\gset smart_record_replay_
select set_config('app.smart_job_id', :'smart_claim_job_id', true);
select set_config('app.smart_attempt_id', :'smart_claim_egress_processing_attempt_id', true);
do $$
begin
  perform smart_document_processing_test.record_ocr(
    current_setting('app.smart_job_id')::uuid,
    current_setting('app.smart_attempt_id')::uuid,
    'worker-a',
    current_setting('app.smart_egress_lease_id')::uuid,
    current_setting('app.smart_egress_lease_token')::uuid,
    smart_document_processing_test.valid_payload('conflicting provider result'),
    25,
    '{"gpu":"fixture"}'::jsonb
  );
  raise exception 'expected immutable OCR evidence conflict';
exception when sqlstate '55000' then null;
end
$$;
reset role;
commit;

begin;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('app.smart_job_id', :'smart_claim_job_id', true);
select set_config('app.smart_attempt_id', :'smart_claim_egress_processing_attempt_id', true);
select set_config('app.smart_egress_lease_id', :'smart_claim_egress_egress_lease_id', true);
select set_config('app.smart_egress_lease_token', :'smart_claim_egress_egress_lease_token', true);
set local role service_role;
select public.complete_document_processing_job(
  :'smart_claim_job_id'::uuid,
  :'smart_claim_egress_processing_attempt_id'::uuid,
  'worker-a',
  :'smart_claim_egress_egress_lease_id'::uuid,
  :'smart_claim_egress_egress_lease_token'::uuid,
  :'smart_record_evidence_sha256'
) ->> 'extraction_id' as extraction_id
\gset smart_complete_
reset role;
commit;

begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.complete_document_processing_job(
  :'smart_claim_job_id'::uuid,
  :'smart_claim_egress_processing_attempt_id'::uuid, 'worker-a',
  :'smart_claim_egress_egress_lease_id'::uuid,
  :'smart_claim_egress_egress_lease_token'::uuid,
  :'smart_record_evidence_sha256'
)::text as replay
\gset smart_complete_replay_
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
         from public.document_extractions where id = :'smart_complete_extraction_id'::uuid)
    and (:'smart_complete_replay_replay'::jsonb ->> 'extraction_id')::uuid
      = :'smart_complete_extraction_id'::uuid
    and (:'smart_complete_replay_replay'::jsonb ->> 'idempotent')::boolean
    and not :'smart_record_idempotent'::boolean
    and :'smart_record_replay_idempotent'::boolean
    and :'smart_record_replay_evidence_sha256' = :'smart_record_evidence_sha256'
    and :'smart_record_replay_payload_sha256' = :'smart_record_payload_sha256'
    and :'smart_record_payload_sha256' ~ '^[0-9a-f]{64}$'
    and (select status = 'settled' and outcome = 'delivered'
         from private.organization_external_egress_leases
         where lease_id = :'smart_claim_egress_egress_lease_id'::uuid),
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
select count(*) as visible_extractions
from public.document_extractions
where org_id = '15000000-0000-4000-8000-000000000001'
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
select public.service_reserve_organization_external_egress(
  '15000000-0000-4000-8000-000000000001',
  'document_interpretation', :'smart_first_job_id'::uuid, 90
)::text as reservation
\gset smart_interpretation_egress_
select public.service_settle_organization_external_egress_evidence(
  (:'smart_interpretation_egress_reservation'::jsonb ->> 'lease_id')::uuid,
  (:'smart_interpretation_egress_reservation'::jsonb ->> 'lease_token')::uuid,
  'delivered', 'interpretation_provider_result_recorded', 200,
  jsonb_build_object(
    'job_id', :'smart_first_job_id'::uuid,
    'extraction_id', :'smart_complete_extraction_id'::uuid,
    'actor_id', '25000000-0000-4000-8000-000000000001'::uuid,
    'interpretation_started_at', :'smart_begin_payload'::jsonb ->> 'interpretation_started_at',
    'provider', 'fixture', 'model', 'fixture-model',
    'prompt_version', 'smart-document-test', 'schema_version', '1',
    'provider_request_id', 'smart-provider-request', 'usage', '{}'::jsonb,
    'duration_ms', 1, 'input_truncation', '{}'::jsonb,
    'provider_result_sha256', repeat('0', 64),
    'interpretation',
      '{"schema_version":"1","document_type":"other","document_type_confidence":null,"supplier":{"suggested_id":null,"suggested_name":null,"confidence":null,"evidence_block_ids":[]},"fields":[],"line_items":[],"suggested_annotations":[]}'::jsonb
  )
)::text as receipt
\gset smart_interpretation_evidence_
select public.fail_document_interpretation(
  :'smart_first_job_id'::uuid,
  :'smart_complete_extraction_id'::uuid,
  '25000000-0000-4000-8000-000000000001',
  (:'smart_begin_payload'::jsonb ->> 'interpretation_started_at')::timestamptz,
  'persistence_failed', 'simulate provider success followed by persistence failure'
);
select public.service_recover_document_interpretation_from_egress(
  :'smart_first_job_id'::uuid,
  :'smart_complete_extraction_id'::uuid,
  '25000000-0000-4000-8000-000000000001',
  (:'smart_interpretation_egress_reservation'::jsonb ->> 'lease_id')::uuid,
  :'smart_interpretation_evidence_receipt'::jsonb ->> 'evidence_sha256'
)::text as recovery
\gset smart_interpretation_recovery_
select public.service_recover_document_interpretation_from_egress(
  :'smart_first_job_id'::uuid,
  :'smart_complete_extraction_id'::uuid,
  '25000000-0000-4000-8000-000000000001',
  (:'smart_interpretation_egress_reservation'::jsonb ->> 'lease_id')::uuid,
  :'smart_interpretation_evidence_receipt'::jsonb ->> 'evidence_sha256'
)::text as replay
\gset smart_interpretation_replay_
select smart_document_processing_test.assert(
  (:'smart_interpretation_recovery_recovery'::jsonb ->> 'recovered_from_failed')::boolean
  and not (:'smart_interpretation_recovery_recovery'::jsonb ->> 'idempotent')::boolean
  and (:'smart_interpretation_replay_replay'::jsonb ->> 'idempotent')::boolean
  and :'smart_interpretation_evidence_receipt'::jsonb ->> 'provider_result_sha256'
    = encode(digest(convert_to(
        ('{"schema_version":"1","document_type":"other","document_type_confidence":null,"supplier":{"suggested_id":null,"suggested_name":null,"confidence":null,"evidence_block_ids":[]},"fields":[],"line_items":[],"suggested_annotations":[]}'::jsonb)::text,
        'UTF8'
      ), 'sha256'), 'hex'),
  'immutable interpretation evidence did not recover canonically and idempotently'
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
select result ->> 'processing_attempt_id' as processing_attempt_id,
       result ->> 'egress_lease_id' as lease_id,
       result ->> 'egress_lease_token' as lease_token
from (select smart_document_processing_test.start_egress(
  :'smart_reprocess_claim_job_id'::uuid, 'worker-reprocess'
) result) started
\gset smart_reprocess_egress_
select public.fail_document_processing_job(
  :'smart_reprocess_claim_job_id'::uuid,
  'worker-reprocess',
  :'smart_reprocess_egress_lease_id'::uuid,
  :'smart_reprocess_egress_lease_token'::uuid,
  'fixture_failure',
  'synthetic failure', false
) ->> 'job_id' as job_id
\gset smart_failed_
reset role;
commit;

select smart_document_processing_test.assert(
  :'smart_failed_job_id'::uuid = :'smart_reprocess_job_id'::uuid
    and (select status = 'failed' and last_error_code = 'fixture_failure'
         from public.document_processing_jobs where id = :'smart_failed_job_id'::uuid),
  'worker failure did not create a terminal explicit error'
);

-- A manager may reprocess a document uploaded by somebody else. The uploader remains the trusted
-- processing/interpretation actor, while the manager remains the reasoned audit actor.
begin;
select set_config('request.jwt.claim.sub', '25000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select public.reprocess_document(
  '45000000-0000-4000-8000-000000000001',
  'office requested cross-actor reprocess'
) as job_id
\gset smart_cross_actor_
reset role;
commit;

select smart_document_processing_test.assert(
  (select requested_by = '25000000-0000-4000-8000-000000000001'
   from public.document_processing_jobs where id = :'smart_cross_actor_job_id'::uuid)
  and exists (
    select 1
    from public.audit_logs
    where action = 'document_processing_reprocessed'
      and entity_id = :'smart_cross_actor_job_id'::uuid
      and user_id = '25000000-0000-4000-8000-000000000002'
      and reason = 'office requested cross-actor reprocess'
      and new_values ->> 'processing_actor_id'
        = '25000000-0000-4000-8000-000000000001'
  ),
  'cross-actor reprocess replaced the uploader identity or lost the requesting manager audit'
);

begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select (public.claim_document_processing_job('worker-cross-actor', 60) ->> 'job_id') as job_id
\gset smart_cross_actor_claim_
select result ->> 'processing_attempt_id' as processing_attempt_id,
       result ->> 'egress_lease_id' as lease_id,
       result ->> 'egress_lease_token' as lease_token
from (select smart_document_processing_test.start_egress(
  :'smart_cross_actor_claim_job_id'::uuid, 'worker-cross-actor'
) result) started
\gset smart_cross_actor_egress_
select smart_document_processing_test.record_ocr(
  :'smart_cross_actor_claim_job_id'::uuid,
  :'smart_cross_actor_egress_processing_attempt_id'::uuid,
  'worker-cross-actor',
  :'smart_cross_actor_egress_lease_id'::uuid,
  :'smart_cross_actor_egress_lease_token'::uuid,
  smart_document_processing_test.valid_payload('cross-actor reprocess extraction'),
  10,
  '{}'::jsonb
) ->> 'evidence_sha256' as evidence_sha256
\gset smart_cross_actor_evidence_
select public.complete_document_processing_job(
  :'smart_cross_actor_claim_job_id'::uuid,
  :'smart_cross_actor_egress_processing_attempt_id'::uuid,
  'worker-cross-actor',
  :'smart_cross_actor_egress_lease_id'::uuid,
  :'smart_cross_actor_egress_lease_token'::uuid,
  :'smart_cross_actor_evidence_evidence_sha256'
) ->> 'extraction_id' as extraction_id
\gset smart_cross_actor_
reset role;
commit;

create temporary table smart_cross_actor_interpretation_claims as
select job_id from private.claim_document_interpretation_jobs(100, 100);

select smart_document_processing_test.assert(
  :'smart_cross_actor_claim_job_id'::uuid = :'smart_cross_actor_job_id'::uuid
    and exists (
      select 1 from smart_cross_actor_interpretation_claims
      where job_id = :'smart_cross_actor_job_id'::uuid
    )
    and exists (
      select 1 from private.document_interpretation_dispatches
      where job_id = :'smart_cross_actor_job_id'::uuid
    ),
  'cross-actor reprocess did not continue from extraction into interpretation dispatch'
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
select result ->> 'processing_attempt_id' as processing_attempt_id,
       result ->> 'egress_lease_id' as lease_id,
       result ->> 'egress_lease_token' as lease_token
from (select smart_document_processing_test.start_egress(
  :'smart_changed_claim_job_id'::uuid, 'worker-changed'
) result) started
\gset smart_changed_egress_
select smart_document_processing_test.record_ocr(
  :'smart_changed_claim_job_id'::uuid,
  :'smart_changed_egress_processing_attempt_id'::uuid,
  'worker-changed',
  :'smart_changed_egress_lease_id'::uuid,
  :'smart_changed_egress_lease_token'::uuid,
  smart_document_processing_test.valid_payload('stale source'),
  10,
  '{}'::jsonb
) ->> 'evidence_sha256' as evidence_sha256
\gset smart_changed_evidence_
reset role;
commit;

update storage.objects
set metadata = jsonb_set(metadata, '{eTag}', to_jsonb(repeat('e', 64)))
where bucket_id = 'documents'
  and name = '15000000-0000-4000-8000-000000000001/smart-doc/changed.pdf';

begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select set_config('app.smart_changed_lease_id', :'smart_changed_egress_lease_id', true);
select set_config('app.smart_changed_lease_token', :'smart_changed_egress_lease_token', true);
select set_config('app.smart_changed_attempt_id', :'smart_changed_egress_processing_attempt_id', true);
select set_config('app.smart_changed_evidence_sha256', :'smart_changed_evidence_evidence_sha256', true);
do $$
begin
  perform public.complete_document_processing_job(
    (select id from public.document_processing_jobs
    where document_id = '45000000-0000-4000-8000-000000000003' and status = 'leased'),
    current_setting('app.smart_changed_attempt_id')::uuid,
    'worker-changed',
    current_setting('app.smart_changed_lease_id')::uuid,
    current_setting('app.smart_changed_lease_token')::uuid,
    current_setting('app.smart_changed_evidence_sha256')
  );
  raise exception 'expected changed-source rejection';
exception when sqlstate '22023' then null;
end
$$;
reset role;
commit;

select smart_document_processing_test.assert(
  not exists (
      select 1 from public.document_extractions where job_id = :'smart_changed_job_id'::uuid
    )
    and exists (
      select 1 from private.organization_external_egress_evidence
      where lease_id = :'smart_changed_egress_lease_id'::uuid
        and evidence_sha256 = :'smart_changed_evidence_evidence_sha256'
    ),
  'changed source produced an extraction or rolled back immutable provider evidence'
);

-- Evidence is committed in transaction A. A rolled-back apply transaction cannot erase it, and
-- an expired lease is recovered by the next claim before a new billable OCR attempt is created.
begin;
select set_config('request.jwt.claim.sub', '25000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select public.enqueue_document_processing(
  '45000000-0000-4000-8000-000000000008'
) as job_id
\gset smart_crash_
reset role;
commit;

begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.claim_document_processing_job('worker-crash', 60)::text as claim
\gset smart_crash_claim_
select smart_document_processing_test.start_egress(
  :'smart_crash_job_id'::uuid, 'worker-crash'
)::text as egress
\gset smart_crash_egress_
select set_config('app.smart_cap_job_id', :'smart_crash_job_id', true);
select set_config(
  'app.smart_cap_attempt_id',
  :'smart_crash_egress_egress'::jsonb ->> 'processing_attempt_id', true
);
select set_config(
  'app.smart_cap_lease_id',
  :'smart_crash_egress_egress'::jsonb ->> 'egress_lease_id', true
);
select set_config(
  'app.smart_cap_lease_token',
  :'smart_crash_egress_egress'::jsonb ->> 'egress_lease_token', true
);
savepoint smart_exact_ocr_cap;
select smart_document_processing_test.record_ocr(
  :'smart_crash_job_id'::uuid,
  (:'smart_crash_egress_egress'::jsonb ->> 'processing_attempt_id')::uuid,
  'worker-crash',
  (:'smart_crash_egress_egress'::jsonb ->> 'egress_lease_id')::uuid,
  (:'smart_crash_egress_egress'::jsonb ->> 'egress_lease_token')::uuid,
  smart_document_processing_test.valid_payload_of_canonical_size(26214400),
  17,
  jsonb_build_object('scenario', 'exact-25-mib')
)::text as evidence
\gset smart_exact_cap_
select smart_document_processing_test.assert(
  (:'smart_exact_cap_evidence'::jsonb ->> 'evidence_sha256') ~ '^[0-9a-f]{64}$'
  and (:'smart_exact_cap_evidence'::jsonb ->> 'payload_sha256') ~ '^[0-9a-f]{64}$',
  'the canonical 25 MiB OCR payload was rejected by the evidence envelope'
);
rollback to savepoint smart_exact_ocr_cap;
release savepoint smart_exact_ocr_cap;
do $$
begin
  perform smart_document_processing_test.record_ocr(
    current_setting('app.smart_cap_job_id')::uuid,
    current_setting('app.smart_cap_attempt_id')::uuid,
    'worker-crash',
    current_setting('app.smart_cap_lease_id')::uuid,
    current_setting('app.smart_cap_lease_token')::uuid,
    smart_document_processing_test.valid_payload_of_canonical_size(26214401),
    17,
    jsonb_build_object('scenario', 'over-25-mib')
  );
  raise exception 'expected the over-limit OCR payload to be rejected';
exception when sqlstate '22023' then null;
end
$$;
select smart_document_processing_test.record_ocr(
  :'smart_crash_job_id'::uuid,
  (:'smart_crash_egress_egress'::jsonb ->> 'processing_attempt_id')::uuid,
  'worker-crash',
  (:'smart_crash_egress_egress'::jsonb ->> 'egress_lease_id')::uuid,
  (:'smart_crash_egress_egress'::jsonb ->> 'egress_lease_token')::uuid,
  smart_document_processing_test.valid_payload('committed before apply crash'),
  17,
  jsonb_build_object('scenario', 'transaction-split')
)::text as evidence
\gset smart_crash_evidence_
reset role;
commit;

begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.complete_document_processing_job(
  :'smart_crash_job_id'::uuid,
  (:'smart_crash_egress_egress'::jsonb ->> 'processing_attempt_id')::uuid,
  'worker-crash',
  (:'smart_crash_egress_egress'::jsonb ->> 'egress_lease_id')::uuid,
  (:'smart_crash_egress_egress'::jsonb ->> 'egress_lease_token')::uuid,
  :'smart_crash_evidence_evidence'::jsonb ->> 'evidence_sha256'
);
rollback;

select smart_document_processing_test.assert(
  exists (
    select 1 from private.organization_external_egress_evidence
    where lease_id = (:'smart_crash_egress_egress'::jsonb ->> 'egress_lease_id')::uuid
      and evidence_sha256 = (:'smart_crash_evidence_evidence'::jsonb ->> 'evidence_sha256')
  )
  and not exists (
    select 1 from public.document_extractions where job_id = :'smart_crash_job_id'::uuid
  ),
  'apply rollback erased transaction-A evidence or committed extraction state'
);

update public.document_processing_jobs
set lease_until = statement_timestamp() - interval '1 second',
    attempt_count = private.document_processing_claim_attempt_limit()
where id = :'smart_crash_job_id'::uuid;
update private.organization_external_egress_leases
set reserved_at = statement_timestamp() - interval '10 minutes',
    acknowledged_at = statement_timestamp() - interval '9 minutes',
    expires_at = statement_timestamp() - interval '1 second'
where lease_id = (:'smart_crash_egress_egress'::jsonb ->> 'egress_lease_id')::uuid;
begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.claim_document_processing_job('worker-after-crash', 60);
reset role;
commit;
select smart_document_processing_test.assert(
  (select status = 'extracted'
              and attempt_count = private.document_processing_claim_attempt_limit()
   from public.document_processing_jobs where id = :'smart_crash_job_id'::uuid)
  and exists (
    select 1 from public.document_extractions
    where job_id = :'smart_crash_job_id'::uuid
      and payload = smart_document_processing_test.valid_payload('committed before apply crash')
  ),
  'expired committed evidence was re-OCRed instead of recovered before reclaim'
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
select result ->> 'processing_attempt_id' as attempt_id,
       result ->> 'egress_lease_id' as lease_id,
       result ->> 'egress_lease_token' as lease_token
from (select smart_document_processing_test.start_egress(
  :'smart_expired_job_id'::uuid, 'worker-expired'
) result) started
\gset smart_expired_egress_
select public.fail_document_processing_job(
  :'smart_expired_job_id'::uuid, 'worker-expired',
  :'smart_expired_egress_lease_id'::uuid,
  :'smart_expired_egress_lease_token'::uuid,
  'provider_retryable', 'synthetic retryable provider failure', true
)::text as retryable_result
\gset smart_retryable_
reset role;
commit;

begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select (public.claim_document_processing_job('worker-reclaimer', 30) ->> 'job_id') as job_id
\gset smart_reclaimed_
select result ->> 'processing_attempt_id' as attempt_id,
       result ->> 'egress_lease_id' as lease_id,
       result ->> 'egress_lease_token' as lease_token
from (select smart_document_processing_test.start_egress(
  :'smart_reclaimed_job_id'::uuid, 'worker-reclaimer'
) result) started
\gset smart_reclaimed_egress_
select public.fail_document_processing_job(
  :'smart_reclaimed_job_id'::uuid,
  'worker-reclaimer',
  :'smart_reclaimed_egress_lease_id'::uuid,
  :'smart_reclaimed_egress_lease_token'::uuid,
  'fixture_reclaimed',
  'lease retry completed', false
) ->> 'job_id' as job_id
\gset smart_reclaimed_failed_
reset role;
commit;

select smart_document_processing_test.assert(
  :'smart_reclaimed_job_id'::uuid = :'smart_retry_job_id'::uuid
    and :'smart_expired_egress_attempt_id'::uuid
      <> :'smart_reclaimed_egress_attempt_id'::uuid
    and (select attempt_count = 2 from public.document_processing_jobs
         where id = :'smart_retry_job_id'::uuid)
    and (:'smart_retryable_retryable_result'::jsonb ->> 'job_status') = 'queued'
    and (:'smart_retryable_retryable_result'::jsonb ->> 'business_applied')::boolean
    and (select status = 'settled' and outcome = 'failed'
              and evidence_code = 'provider_retryable'
         from private.organization_external_egress_leases
         where lease_id = :'smart_expired_egress_lease_id'::uuid),
  'retryable failure did not settle, requeue or fence the next attempt'
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

-- A lifecycle flip preserves the committed result. Once the platform operator restores writes,
-- recovery consumes the exact evidence without a second provider request.
select set_config('request.jwt.claim.sub', '25000000-0000-4000-8000-000000000007', false);
select set_config('request.jwt.claim.role', 'authenticated', false);
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', '25000000-0000-4000-8000-000000000007',
  'role', 'authenticated',
  'amr', jsonb_build_array(jsonb_build_object(
    'method', 'password', 'timestamp', extract(epoch from clock_timestamp())::bigint
  ))
)::text, false);
select public.set_organization_lifecycle(
  '15000000-0000-4000-8000-000000000003', 'active', null,
  'Smart OCR lifecycle recovery fixture'
);
select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claim.role', 'service_role', false);
select set_config('request.jwt.claims', '{}'::jsonb::text, false);
set role service_role;
select public.service_recover_document_extraction_from_egress(
  '55000000-0000-4000-8000-000000000107',
  '65000000-0000-4000-8000-000000000107',
  '75000000-0000-4000-8000-000000000107',
  :'smart_suspended_evidence_evidence_sha256'
)::text as recovered
\gset smart_suspended_recovery_
reset role;
select smart_document_processing_test.assert(
  (:'smart_suspended_recovery_recovered'::jsonb ->> 'extraction_id')::uuid is not null
  and not (:'smart_suspended_recovery_recovered'::jsonb ->> 'idempotent')::boolean
  and exists (
    select 1 from public.document_extractions
    where job_id = '55000000-0000-4000-8000-000000000107'
  ),
  'writable lifecycle recovery did not consume the committed OCR evidence'
);

-- No browser role can mutate the immutable queue/extraction ledgers directly.
-- The authoritative claim circuit breaker fails an over-cap job in the claim transaction,
-- then claims the next eligible job without incrementing the blocked row a ninth time.
insert into public.documents (
  id, org_id, entity_type, entity_id, storage_path, file_name, mime_type,
  document_kind, uploaded_by
) values
  (
    '45000000-0000-4000-8000-000000000012',
    '15000000-0000-4000-8000-000000000001',
    'inbox', null,
    '15000000-0000-4000-8000-000000000001/smart-doc/circuit-breaker.pdf',
    'circuit-breaker.pdf', 'application/pdf', 'other',
    '25000000-0000-4000-8000-000000000001'
  ),
  (
    '45000000-0000-4000-8000-000000000013',
    '15000000-0000-4000-8000-000000000001',
    'inbox', null,
    '15000000-0000-4000-8000-000000000001/smart-doc/final-eligible.pdf',
    'final-eligible.pdf', 'application/pdf', 'other',
    '25000000-0000-4000-8000-000000000001'
  );

insert into public.document_processing_jobs (
  id, org_id, document_id, requested_by, status, input_checksum,
  contract_version, priority, attempt_count, lease_owner, lease_until,
  processing_attempt_id, processing_attempt_started_at
) values
  (
    '55000000-0000-4000-8000-000000000112',
    '15000000-0000-4000-8000-000000000001',
    '45000000-0000-4000-8000-000000000012',
    '25000000-0000-4000-8000-000000000001',
    'leased', 'etag:10101010101010101010101010101010', '1', 1000, 8,
    'stale-worker', statement_timestamp() + interval '60 seconds',
    '65000000-0000-4000-8000-000000000112',
    statement_timestamp() - interval '10 minutes'
  ),
  (
    '55000000-0000-4000-8000-000000000113',
    '15000000-0000-4000-8000-000000000001',
    '45000000-0000-4000-8000-000000000013',
    '25000000-0000-4000-8000-000000000001',
    'queued', 'etag:11111111111111111111111111111111', '1', 999, 7,
    null, null, null, null
  );

begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select smart_document_processing_test.start_egress(
  '55000000-0000-4000-8000-000000000112', 'stale-worker'
)::text as egress
\gset smart_cap_egress_
reset role;
commit;

update public.document_processing_jobs
set lease_until = statement_timestamp() - interval '1 second'
where id = '55000000-0000-4000-8000-000000000112';

begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.claim_document_processing_job('worker-cap', 60)::text as claim
\gset smart_cap_claim_
select public.fail_document_processing_job(
  '55000000-0000-4000-8000-000000000113',
  'worker-cap',
  'fixture_complete',
  'circuit breaker eligible fixture settled'
);
reset role;
commit;

select smart_document_processing_test.assert(
  (:'smart_cap_claim_claim'::jsonb ->> 'job_id')::uuid
      = '55000000-0000-4000-8000-000000000113'
    and (:'smart_cap_claim_claim'::jsonb ->> 'attempt_count')::integer = 8
    and exists (
      select 1
      from public.document_processing_jobs
      where id = '55000000-0000-4000-8000-000000000112'
        and status = 'failed'
        and attempt_count = 8
        and last_error_code = 'claim_attempt_limit_exceeded'
    )
    and exists (
      select 1
      from private.organization_external_egress_leases
      where lease_id = (:'smart_cap_egress_egress'::jsonb ->> 'egress_lease_id')::uuid
        and status = 'settled'
        and outcome = 'ambiguous'
        and evidence_code = 'job_lease_expired_before_settlement'
    )
    and (
      select count(*) = 1
      from public.audit_logs
      where entity_type = 'document_processing_jobs'
        and entity_id = '55000000-0000-4000-8000-000000000112'
        and action = 'document_processing_failed'
        and new_values ->> 'error_code' = 'claim_attempt_limit_exceeded'
    ),
  'claim circuit breaker incremented or reclaimed an over-cap job'
);

-- 0130: the operations screen consumes the same server-side health verdict for every attempt.
select smart_document_processing_test.assert(
  private.document_processing_stuck_reason(
    'leased', 1, statement_timestamp() - interval '8 hours', statement_timestamp(),
    statement_timestamp() + interval '1 minute', statement_timestamp()
  ) is null
  and private.document_processing_stuck_reason(
    'leased', 1, statement_timestamp(), statement_timestamp(),
    statement_timestamp() - interval '1 second', statement_timestamp()
  ) is null
  and private.document_processing_stuck_reason(
    'leased', 1, statement_timestamp(), statement_timestamp(),
    statement_timestamp() - interval '6 minutes', statement_timestamp()
  ) = 'lease_expired'
  and private.document_processing_stuck_reason(
    'failed', 99, statement_timestamp() - interval '8 hours', statement_timestamp(),
    null, statement_timestamp()
  ) is null,
  'server-side stuck classification drifted for live/recent leases, expired lease or terminal state'
);

begin;
select set_config('request.jwt.claim.sub', '25000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select status = 'failed' as status_is_failed,
       attempt_count = 8 as attempt_count_is_eight,
       file_name = 'circuit-breaker.pdf' as file_name_is_safe,
       queue_age_seconds is null as queue_age_is_null,
       is_stuck = false as stuck_is_false
from public.get_document_control_attempts(
  '45000000-0000-4000-8000-000000000012', 10
)
where job_id = '55000000-0000-4000-8000-000000000112'
\gset smart_control_attempt_health_
reset role;
select is_stuck = false as stuck_is_false,
       stuck_reason is null as stuck_reason_is_null,
       queue_age_seconds is null as queue_age_is_null,
       lease_until is null as lease_is_null,
       processing_attempt_started_at is null as attempt_started_is_null
from public.get_document_processing_attempts(
  '45000000-0000-4000-8000-000000000012', 10
)
where job_id = '55000000-0000-4000-8000-000000000112'
\gset smart_raw_attempt_health_
commit;

select smart_document_processing_test.assert(
  :'smart_control_attempt_health_status_is_failed'::boolean
    and :'smart_control_attempt_health_attempt_count_is_eight'::boolean
    and :'smart_control_attempt_health_file_name_is_safe'::boolean
    and :'smart_control_attempt_health_queue_age_is_null'::boolean
    and :'smart_control_attempt_health_stuck_is_false'::boolean,
  'document control attempts RPC omitted its customer-safe processing shape'
);

select smart_document_processing_test.assert(
  :'smart_raw_attempt_health_stuck_is_false'::boolean
    and :'smart_raw_attempt_health_stuck_reason_is_null'::boolean
    and :'smart_raw_attempt_health_queue_age_is_null'::boolean
    and :'smart_raw_attempt_health_lease_is_null'::boolean
    and :'smart_raw_attempt_health_attempt_started_is_null'::boolean = false,
  'privileged processing telemetry omitted the canonical health or attempt timing shape'
);

begin;
select set_config('request.jwt.claim.sub', '25000000-0000-4000-8000-000000000005', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select smart_document_processing_test.assert(
  not exists (
    select 1 from public.get_document_control_attempts(
      '45000000-0000-4000-8000-000000000012', 10
    )
  ),
  'document control attempts RPC crossed the tenant boundary'
);
reset role;
commit;

-- Stuck current jobs are a separate operations bucket. Adding one expired lease and one active
-- row older than two hours must not increase the healthy "processing now" number.
begin;
select set_config('request.jwt.claim.sub', '25000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select public.get_document_operations_metrics(30)::text as metrics
\gset smart_health_before_
reset role;
commit;

insert into public.documents (
  id, org_id, entity_type, entity_id, storage_path, file_name, mime_type,
  document_kind, uploaded_by
) values
  (
    '45000000-0000-4000-8000-000000000016',
    '15000000-0000-4000-8000-000000000001', 'inbox', null,
    '15000000-0000-4000-8000-000000000001/smart-doc/old-active.pdf',
    'old-active.pdf', 'application/pdf', 'other',
    '25000000-0000-4000-8000-000000000001'
  ),
  (
    '45000000-0000-4000-8000-000000000017',
    '15000000-0000-4000-8000-000000000001', 'inbox', null,
    '15000000-0000-4000-8000-000000000001/smart-doc/expired-lease.pdf',
    'expired-lease.pdf', 'application/pdf', 'other',
    '25000000-0000-4000-8000-000000000001'
  );

insert into public.document_processing_jobs (
  id, org_id, document_id, requested_by, status, input_checksum,
  contract_version, priority, attempt_count, lease_owner, lease_until,
  processing_attempt_id, processing_attempt_started_at, created_at, updated_at
) values
  (
    '55000000-0000-4000-8000-000000000116',
    '15000000-0000-4000-8000-000000000001',
    '45000000-0000-4000-8000-000000000016',
    '25000000-0000-4000-8000-000000000001',
    'extracted', 'etag:16161616161616161616161616161616', '1', 100, 1,
    null, null, '65000000-0000-4000-8000-000000000116',
    statement_timestamp() - interval '3 hours',
    statement_timestamp() - interval '3 hours',
    statement_timestamp() - interval '3 hours'
  ),
  (
    '55000000-0000-4000-8000-000000000117',
    '15000000-0000-4000-8000-000000000001',
    '45000000-0000-4000-8000-000000000017',
    '25000000-0000-4000-8000-000000000001',
    'leased', 'etag:17171717171717171717171717171717', '1', 100, 1,
    'expired-health-worker', statement_timestamp() - interval '6 minutes',
    '65000000-0000-4000-8000-000000000117',
    statement_timestamp() - interval '5 minutes',
    statement_timestamp() - interval '5 minutes',
    statement_timestamp() - interval '5 minutes'
  );

begin;
select set_config('request.jwt.claim.sub', '25000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select public.get_document_operations_metrics(30)::text as metrics
\gset smart_health_after_
reset role;
commit;

select smart_document_processing_test.assert(
  (:'smart_health_after_metrics'::jsonb ->> 'documents_stuck')::integer
      = (:'smart_health_before_metrics'::jsonb ->> 'documents_stuck')::integer + 2
    and (:'smart_health_after_metrics'::jsonb ->> 'documents_processing')::integer
      = (:'smart_health_before_metrics'::jsonb ->> 'documents_processing')::integer
    and (:'smart_health_after_metrics'::jsonb ->> 'documents_waiting')::integer
      = (:'smart_health_before_metrics'::jsonb ->> 'documents_waiting')::integer,
  'stuck current jobs leaked into healthy waiting or processing-now metrics'
);

-- The same tenant-scoped read contract is available to every role that could already select the
-- job table. Office sees both reasons; another tenant sees neither; accountant remains denied.
begin;
select set_config('request.jwt.claim.sub', '25000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select smart_document_processing_test.assert(
  (select count(*) = 2
          and bool_and(is_stuck)
          and bool_or(stuck_reason = 'active_over_two_hours')
          and bool_or(stuck_reason = 'lease_expired')
   from public.get_document_processing_statuses(array[
     '45000000-0000-4000-8000-000000000016'::uuid,
     '45000000-0000-4000-8000-000000000017'::uuid
   ])),
  'tenant processing status RPC disagreed with operations health metrics'
);
reset role;
commit;

begin;
select set_config('request.jwt.claim.sub', '25000000-0000-4000-8000-000000000005', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select smart_document_processing_test.assert(
  not exists (
    select 1 from public.get_document_processing_statuses(array[
      '45000000-0000-4000-8000-000000000016'::uuid
    ])
  ),
  'tenant processing status RPC crossed the tenant boundary'
);
reset role;
commit;

begin;
select set_config('request.jwt.claim.sub', '25000000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
do $$
begin
  perform public.get_document_processing_statuses(null);
  raise exception 'expected processing status role rejection';
exception when sqlstate '42501' then null;
end
$$;
reset role;
commit;

-- The active browser read models share one explicit ACL matrix: authenticated may enter each
-- function and its body narrows the product role; anon, service_role and PUBLIC cannot execute it.
select smart_document_processing_test.assert(
  (
    select bool_and(
      has_function_privilege('authenticated', signature, 'EXECUTE')
      and not has_function_privilege('anon', signature, 'EXECUTE')
      and not has_function_privilege('service_role', signature, 'EXECUTE')
      and not exists (
        select 1
        from pg_catalog.aclexplode(proc.proacl) acl
        where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
      )
    )
    from (values
      ('public.get_document_operations_metrics(integer)'::regprocedure),
      ('public.get_document_processing_statuses(uuid[])'::regprocedure),
      ('public.get_document_control_attempts(uuid,integer)'::regprocedure),
      ('public.get_document_control_price_review_queue(integer)'::regprocedure)
    ) expected(signature)
    join pg_catalog.pg_proc proc on proc.oid = expected.signature
  ),
  'customer-safe processing read RPC ACL matrix drifted for authenticated, anon, service role or PUBLIC'
);

select smart_document_processing_test.assert(
  (
    select bool_and(
      not has_function_privilege('authenticated', signature, 'EXECUTE')
      and not has_function_privilege('anon', signature, 'EXECUTE')
      and not has_function_privilege('service_role', signature, 'EXECUTE')
      and not exists (
        select 1
        from pg_catalog.aclexplode(proc.proacl) acl
        where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
      )
    )
    from (values
      ('public.get_document_processing_attempts(uuid,integer)'::regprocedure),
      ('public.get_price_list_calibration_metrics(timestamptz,timestamptz)'::regprocedure),
      ('public.get_price_list_calibration_queue(integer)'::regprocedure),
      ('public.get_price_list_drift_metrics(integer)'::regprocedure)
    ) retired(signature)
    join pg_catalog.pg_proc proc on proc.oid = retired.signature
  ),
  'retired technical processing RPC remains executable by a browser or API role'
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
