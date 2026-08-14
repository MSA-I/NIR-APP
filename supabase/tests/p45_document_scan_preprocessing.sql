-- P45 -- Uploaded images require an immutable, human-approved scan derivative before OCR.
\set ON_ERROR_STOP on

create function pg_temp.p45_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P45 document scan assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p45_start_scan_egress(p_job_id uuid, p_owner text)
returns jsonb
language plpgsql
as $$
declare
  v_job public.document_scan_jobs;
  v_reservation jsonb;
  v_ack jsonb;
begin
  select * into v_job from public.document_scan_jobs where id = p_job_id;
  if v_job.status <> 'processing' or v_job.lease_owner is distinct from p_owner
     or v_job.processing_attempt_id is null then
    raise exception 'P45 cannot start egress for an unowned scan attempt';
  end if;
  v_reservation := public.service_reserve_organization_external_egress(
    v_job.org_id, 'document_signed_url', v_job.processing_attempt_id, 120
  );
  v_ack := public.service_acknowledge_document_scan_download(
    v_job.id, p_owner,
    (v_reservation ->> 'lease_id')::uuid,
    (v_reservation ->> 'lease_token')::uuid,
    120
  );
  return v_ack || jsonb_build_object(
    'egress_lease_token', v_reservation ->> 'lease_token'
  );
end
$$;

select pg_temp.p45_assert(
  exists (
    select 1 from storage.buckets
    where id = 'document-scans' and not public
      and file_size_limit = 10485760
      and allowed_mime_types = array['image/png']::text[]
  ),
  'the private scanned-output bucket is missing or too broad'
);

select pg_temp.p45_assert(
  has_function_privilege('authenticated', 'public.begin_document_intake(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.get_document_scan_states(uuid[])', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.submit_document_scan_corners(uuid,jsonb)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.accept_document_scan(uuid,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.claim_document_scan_job(text,integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.claim_document_scan_job(text,integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.claim_document_processing_job_input(text,integer)', 'EXECUTE'),
  'browser and worker RPC grants are not separated'
);

select pg_temp.p45_assert(
  not has_table_privilege('authenticated', 'public.document_scan_jobs', 'INSERT')
  and not has_table_privilege('authenticated', 'public.document_scan_outputs', 'INSERT')
  and not has_table_privilege('authenticated', 'public.document_scan_decisions', 'INSERT')
  and has_table_privilege('service_role', 'public.document_scan_jobs', 'INSERT')
  and has_table_privilege('service_role', 'public.document_scan_outputs', 'INSERT'),
  'scan evidence tables expose a direct browser writer or deny the gateway'
);

begin;

insert into public.organizations (id, name, status) values
  ('13600000-0000-4000-8000-000000000001', 'P45 tenant A', 'active'),
  ('13600000-0000-4000-8000-000000000002', 'P45 tenant B', 'active');

insert into auth.users (id, email) values
  ('13610000-0000-4000-8000-000000000001', 'owner-a-p43@example.test'),
  ('13610000-0000-4000-8000-000000000002', 'office-a-p43@example.test'),
  ('13610000-0000-4000-8000-000000000003', 'accountant-a-p43@example.test'),
  ('13610000-0000-4000-8000-000000000004', 'owner-b-p43@example.test');

insert into public.profiles (id, org_id, full_name, role, active) values
  ('13610000-0000-4000-8000-000000000001', '13600000-0000-4000-8000-000000000001', 'P45 owner A', 'owner', true),
  ('13610000-0000-4000-8000-000000000002', '13600000-0000-4000-8000-000000000001', 'P45 office A', 'office', true),
  ('13610000-0000-4000-8000-000000000003', '13600000-0000-4000-8000-000000000001', 'P45 accountant A', 'accountant', true),
  ('13610000-0000-4000-8000-000000000004', '13600000-0000-4000-8000-000000000002', 'P45 owner B', 'owner', true);

insert into public.suppliers (id, org_id, name) values (
  '13630000-0000-4000-8000-000000000001',
  '13600000-0000-4000-8000-000000000001',
  'P45 price-list supplier'
);

insert into storage.objects (bucket_id, name, owner, owner_id, metadata) values
  ('documents', '13600000-0000-4000-8000-000000000001/inbox/p45-image.jpg',
   '13610000-0000-4000-8000-000000000001', '13610000-0000-4000-8000-000000000001',
   '{"mimetype":"image/jpeg","size":8192,"eTag":"1360000000000001"}'::jsonb),
  ('documents', '13600000-0000-4000-8000-000000000001/inbox/p45-pdf.pdf',
   '13610000-0000-4000-8000-000000000001', '13610000-0000-4000-8000-000000000001',
   '{"mimetype":"application/pdf","size":8192,"eTag":"1360000000000002"}'::jsonb),
  ('documents', '13600000-0000-4000-8000-000000000002/inbox/p45-other.jpg',
   '13610000-0000-4000-8000-000000000004', '13610000-0000-4000-8000-000000000004',
   '{"mimetype":"image/jpeg","size":8192,"eTag":"1360000000000003"}'::jsonb),
  ('documents', '13600000-0000-4000-8000-000000000001/supplier/13630000-0000-4000-8000-000000000001/p45-price-list.jpg',
   '13610000-0000-4000-8000-000000000001', '13610000-0000-4000-8000-000000000001',
   '{"mimetype":"image/jpeg","size":8192,"eTag":"1360000000000004"}'::jsonb);

insert into public.documents (
  id, org_id, entity_type, entity_id, storage_path, file_name,
  mime_type, document_kind, uploaded_by
) values
  ('13620000-0000-4000-8000-000000000001', '13600000-0000-4000-8000-000000000001',
   'inbox', null, '13600000-0000-4000-8000-000000000001/inbox/p45-image.jpg',
   'p45-image.jpg', 'image/jpeg', 'invoice', '13610000-0000-4000-8000-000000000001'),
  ('13620000-0000-4000-8000-000000000002', '13600000-0000-4000-8000-000000000001',
   'inbox', null, '13600000-0000-4000-8000-000000000001/inbox/p45-pdf.pdf',
   'p45-pdf.pdf', 'application/pdf', 'invoice', '13610000-0000-4000-8000-000000000001'),
  ('13620000-0000-4000-8000-000000000003', '13600000-0000-4000-8000-000000000002',
   'inbox', null, '13600000-0000-4000-8000-000000000002/inbox/p45-other.jpg',
   'p45-other.jpg', 'image/jpeg', 'invoice', '13610000-0000-4000-8000-000000000004'),
  ('13620000-0000-4000-8000-000000000004', '13600000-0000-4000-8000-000000000001',
   'supplier', '13630000-0000-4000-8000-000000000001',
   '13600000-0000-4000-8000-000000000001/supplier/13630000-0000-4000-8000-000000000001/p45-price-list.jpg',
   'p45-price-list.jpg', 'image/jpeg', 'price_list', '13610000-0000-4000-8000-000000000001');

select set_config('request.jwt.claim.sub', '13610000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select public.begin_document_intake('13620000-0000-4000-8000-000000000001')::text as result
\gset p45_image_
select public.begin_document_intake('13620000-0000-4000-8000-000000000002')::text as result
\gset p45_pdf_
select public.begin_document_intake('13620000-0000-4000-8000-000000000004')::text as result
\gset p45_price_list_
reset role;

select pg_temp.p45_assert(
  :'p45_image_result'::jsonb ->> 'intake_kind' = 'scan'
  and (:'p45_image_result'::jsonb ->> 'requires_scan_review')::boolean
  and exists (
    select 1 from public.document_processing_jobs
    where id = (:'p45_image_result'::jsonb ->> 'processing_job_id')::uuid
      and status = 'awaiting_scan' and scan_output_id is null
  )
  and exists (
    select 1 from public.document_scan_jobs
    where id = (:'p45_image_result'::jsonb ->> 'intake_job_id')::uuid
      and status = 'queued'
  ),
  'image intake bypassed scan review or created a claimable OCR job'
);

select pg_temp.p45_assert(
  :'p45_pdf_result'::jsonb ->> 'intake_kind' = 'processing'
  and not (:'p45_pdf_result'::jsonb ->> 'requires_scan_review')::boolean
  and exists (
    select 1 from public.document_processing_jobs
    where id = (:'p45_pdf_result'::jsonb ->> 'processing_job_id')::uuid
      and status = 'queued' and scan_output_id is null
  ),
  'non-image intake no longer follows the existing OCR route'
);

select pg_temp.p45_assert(
  :'p45_price_list_result'::jsonb ->> 'intake_kind' = 'processing'
  and not (:'p45_price_list_result'::jsonb ->> 'requires_scan_review')::boolean
  and exists (
    select 1 from public.document_processing_jobs
    where id = (:'p45_price_list_result'::jsonb ->> 'processing_job_id')::uuid
      and status = 'queued' and scan_output_id is null
  )
  and not exists (
    select 1 from public.document_scan_jobs
    where document_id = '13620000-0000-4000-8000-000000000004'
  ),
  'supplier price-list image was diverted into document scanning'
);

-- Accountant payment-proof behavior remains outside OCR and cannot start this staff intake.
select set_config('request.jwt.claim.sub', '13610000-0000-4000-8000-000000000003', true);
set local role authenticated;
do $$
begin
  perform public.begin_document_intake('13620000-0000-4000-8000-000000000001');
  raise exception 'expected accountant intake denial';
exception when insufficient_privilege then null;
end
$$;
reset role;

-- Claim scan first. The PDF remains independently claimable by the mature OCR queue.
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.claim_document_scan_job('p45-scanner', 120)::text as result
\gset p45_claim_
reset role;

select pg_temp.p45_assert(
  :'p45_claim_result'::jsonb ->> 'job_id' = :'p45_image_result'::jsonb ->> 'intake_job_id'
  and :'p45_claim_result'::jsonb ->> 'manual_corners' is null
  and :'p45_claim_result'::jsonb ->> 'requested_mode' = 'auto',
  'scan claim did not bind the original image and automatic mode'
);

set local role service_role;
select result ->> 'processing_attempt_id' as processing_attempt_id,
       result ->> 'egress_lease_id' as egress_lease_id,
       result ->> 'egress_lease_token' as egress_lease_token
from (select pg_temp.p45_start_scan_egress(
  (:'p45_claim_result'::jsonb ->> 'job_id')::uuid,
  'p45-scanner'
) result) started
\gset p45_auto_egress_
reset role;

-- Automatic boundary failure becomes a human-fixable state, not an OCR fallback.
set local role service_role;
select public.fail_document_scan_job(
  (:'p45_claim_result'::jsonb ->> 'job_id')::uuid,
  :'p45_auto_egress_processing_attempt_id'::uuid,
  'p45-scanner',
  :'p45_auto_egress_egress_lease_id'::uuid,
  :'p45_auto_egress_egress_lease_token'::uuid,
  'document_not_detected', 'manual corner selection is required', false
)::text as result
\gset p45_failure_
reset role;

select pg_temp.p45_assert(
  :'p45_failure_result'::jsonb ->> 'status' = 'needs_corners'
  and not exists (
    select 1 from public.document_processing_jobs
    where document_id = '13620000-0000-4000-8000-000000000001'
      and status in ('queued', 'leased', 'extracted', 'interpreting', 'review')
  ),
  'boundary detection failure fell through to OCR'
);

select pg_temp.p45_assert(
  exists (
    select 1
    from private.organization_external_egress_leases lease
    join private.organization_external_egress_evidence evidence
      on evidence.lease_id = lease.lease_id
    where lease.lease_id = :'p45_auto_egress_egress_lease_id'::uuid
      and lease.status = 'settled' and lease.outcome = 'failed'
      and evidence.evidence_code = 'document_scan_failed'
      and evidence.correlation_id = :'p45_auto_egress_processing_attempt_id'::uuid
  ),
  'acknowledged scan failure did not settle its egress evidence'
);

select set_config('request.jwt.claim.sub', '13610000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select public.submit_document_scan_corners(
  (:'p45_claim_result'::jsonb ->> 'job_id')::uuid,
  '[[0.08,0.07],[0.93,0.09],[0.91,0.94],[0.06,0.92]]'::jsonb
)::text as result
\gset p45_retry_
reset role;

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.claim_document_scan_job('p45-scanner', 120)::text as result
\gset p45_manual_claim_
reset role;

select pg_temp.p45_assert(
  :'p45_manual_claim_result'::jsonb -> 'manual_corners'
    = '[[0.08,0.07],[0.93,0.09],[0.91,0.94],[0.06,0.92]]'::jsonb,
  'manual corners were not persisted into the retry claim'
);

set local role service_role;
select result ->> 'processing_attempt_id' as processing_attempt_id,
       result ->> 'egress_lease_id' as egress_lease_id,
       result ->> 'egress_lease_token' as egress_lease_token
from (select pg_temp.p45_start_scan_egress(
  (:'p45_manual_claim_result'::jsonb ->> 'job_id')::uuid,
  'p45-scanner'
) result) started
\gset p45_manual_egress_
select public.heartbeat_document_scan_job(
  (:'p45_manual_claim_result'::jsonb ->> 'job_id')::uuid,
  'p45-scanner',
  :'p45_manual_egress_egress_lease_id'::uuid,
  :'p45_manual_egress_egress_lease_token'::uuid,
  120
)::text as result
\gset p45_heartbeat_
reset role;

select pg_temp.p45_assert(
  :'p45_heartbeat_result'::jsonb ->> 'processing_attempt_id'
    = :'p45_manual_egress_processing_attempt_id'
  and :'p45_heartbeat_result'::jsonb ->> 'egress_lease_id'
    = :'p45_manual_egress_egress_lease_id',
  'scan heartbeat lost its processing-attempt or egress binding'
);

insert into storage.objects (bucket_id, name, metadata) values (
  'document-scans',
  '13600000-0000-4000-8000-000000000001/13620000-0000-4000-8000-000000000001/'
    || (:'p45_manual_claim_result'::jsonb ->> 'job_id') || '/scan.png',
  '{"mimetype":"image/png","size":4096}'::jsonb
);

set local role service_role;
select public.service_complete_document_scan_job(
  (:'p45_manual_claim_result'::jsonb ->> 'job_id')::uuid,
  :'p45_manual_egress_processing_attempt_id'::uuid,
  'p45-scanner',
  :'p45_manual_egress_egress_lease_id'::uuid,
  :'p45_manual_egress_egress_lease_token'::uuid,
  :'p45_manual_claim_result'::jsonb ->> 'input_checksum',
  '13600000-0000-4000-8000-000000000001/13620000-0000-4000-8000-000000000001/'
    || (:'p45_manual_claim_result'::jsonb ->> 'job_id') || '/scan.png',
  repeat('a', 64), 4096, 1200, 1800, 'black_and_white',
  '[[0.08,0.07],[0.93,0.09],[0.91,0.94],[0.06,0.92]]'::jsonb,
  'manual', 0.4, '{"shadow":0.18,"ink_ratio":0.12}'::jsonb
)::text as result
\gset p45_completed_
reset role;

select pg_temp.p45_assert(
  :'p45_completed_result'::jsonb ->> 'status' = 'ready'
  and exists (
    select 1 from public.document_scan_outputs
    where id = (:'p45_completed_result'::jsonb ->> 'output_id')::uuid
      and sha256 = repeat('a', 64) and corners_source = 'manual'
  ),
  'clean scan output was not recorded as immutable review evidence'
);

select pg_temp.p45_assert(
  exists (
    select 1
    from private.organization_external_egress_leases lease
    join private.organization_external_egress_evidence evidence
      on evidence.lease_id = lease.lease_id
    where lease.lease_id = :'p45_manual_egress_egress_lease_id'::uuid
      and lease.status = 'settled' and lease.outcome = 'delivered'
      and evidence.evidence_code = 'document_scan_completed'
      and evidence.correlation_id = :'p45_manual_egress_processing_attempt_id'::uuid
  ),
  'completed scan did not settle immutable egress evidence'
);

select set_config('request.jwt.claim.sub', '13610000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select public.accept_document_scan(
  (:'p45_completed_result'::jsonb ->> 'output_id')::uuid,
  'P45 human preview approval'
)::text as result
\gset p45_accepted_
reset role;

select pg_temp.p45_assert(
  exists (
    select 1
    from public.document_processing_jobs processing
    join public.document_scan_outputs output
      on output.org_id = processing.org_id and output.id = processing.scan_output_id
    where processing.id = (:'p45_accepted_result'::jsonb ->> 'processing_job_id')::uuid
      and processing.status = 'queued'
      and processing.input_checksum = 'etag:' || output.sha256
  )
  and exists (
    select 1 from public.document_processing_jobs
    where id = (:'p45_image_result'::jsonb ->> 'processing_job_id')::uuid
      and status = 'failed' and last_error_code = 'superseded_by_accepted_scan'
  )
  and exists (
    select 1 from public.document_scan_decisions
    where scan_output_id = (:'p45_completed_result'::jsonb ->> 'output_id')::uuid
      and decided_by = '13610000-0000-4000-8000-000000000001'
  ),
  'human acceptance did not create exactly one scan-bound OCR job and decision'
);

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.claim_document_processing_job_input('p45-ocr-pdf', 120)::text as result
\gset p45_existing_ocr_
select public.claim_document_processing_job_input('p45-ocr-price-list', 120)::text as result
\gset p45_price_ocr_
select public.claim_document_processing_job_input('p45-ocr', 120)::text as result
\gset p45_ocr_
select coalesce(
  public.claim_document_processing_job_input('p45-ocr-overflow', 120),
  '{}'::jsonb
)::text as result
\gset p45_ocr_overflow_
reset role;

select pg_temp.p45_assert(
  exists (
    select 1 from jsonb_array_elements(jsonb_build_array(
      :'p45_existing_ocr_result'::jsonb,
      :'p45_price_ocr_result'::jsonb,
      :'p45_ocr_result'::jsonb,
      :'p45_ocr_overflow_result'::jsonb
    )) claim
    where claim ->> 'job_id' = :'p45_pdf_result'::jsonb ->> 'processing_job_id'
      and claim ->> 'storage_bucket' = 'documents'
      and claim ->> 'mime_type' = 'application/pdf'
  )
  and exists (
    select 1 from jsonb_array_elements(jsonb_build_array(
      :'p45_existing_ocr_result'::jsonb,
      :'p45_price_ocr_result'::jsonb,
      :'p45_ocr_result'::jsonb,
      :'p45_ocr_overflow_result'::jsonb
    )) claim
    where claim ->> 'job_id' = :'p45_price_list_result'::jsonb ->> 'processing_job_id'
      and claim ->> 'storage_bucket' = 'documents'
      and claim ->> 'mime_type' = 'image/jpeg'
  )
  and exists (
    select 1 from jsonb_array_elements(jsonb_build_array(
      :'p45_existing_ocr_result'::jsonb,
      :'p45_price_ocr_result'::jsonb,
      :'p45_ocr_result'::jsonb,
      :'p45_ocr_overflow_result'::jsonb
    )) claim
    where claim ->> 'job_id' = :'p45_accepted_result'::jsonb ->> 'processing_job_id'
      and claim ->> 'storage_bucket' = 'document-scans'
      and claim ->> 'mime_type' = 'image/png'
      and claim ->> 'input_checksum' = 'etag:' || repeat('a', 64)
  ),
  'OCR claim did not resolve to the accepted scanned derivative'
);

-- Tenant B cannot see or accept tenant A scan evidence.
select set_config('request.jwt.claim.sub', '13610000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'p43.output_id',
  :'p45_completed_result'::jsonb ->> 'output_id',
  true
);
set local role authenticated;
select pg_temp.p45_assert(
  not exists (
    select 1 from public.get_document_scan_states(array[
      '13620000-0000-4000-8000-000000000001'::uuid
    ])
  ),
  'scan state crossed the tenant boundary'
);
do $$
begin
  perform public.accept_document_scan(
    current_setting('p43.output_id', true)::uuid,
    'cross tenant attempt'
  );
  raise exception 'expected cross-tenant scan denial';
exception when no_data_found then null;
when others then
  if sqlerrm not like '%document_scan_output_unknown%' then raise; end if;
end
$$;
reset role;

rollback;
