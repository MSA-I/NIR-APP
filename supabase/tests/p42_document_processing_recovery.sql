-- P42 -- Owner recovery of stuck processing is tenant-bound, evidence-first and idempotent.
\set ON_ERROR_STOP on

create extension if not exists dblink;

create function pg_temp.p42_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P42 document recovery assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p42_payload(p_text text)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'schema_version', '1',
    'document', jsonb_build_object(
      'page_count', 1,
      'detected_languages', jsonb_build_array('he'),
      'plain_text', p_text,
      'partial', false
    ),
    'blocks', jsonb_build_array(jsonb_build_object(
      'id', 'block-1', 'page', 1, 'type', 'text',
      'bbox', jsonb_build_array(0, 0, 1, 1),
      'text', p_text, 'confidence', 0.95
    )),
    'tables', '[]'::jsonb,
    'marks', '[]'::jsonb
  );
$$;

select pg_temp.p42_assert(
  has_function_privilege(
    'service_role',
    'public.service_recover_stuck_document_processing(uuid,uuid,uuid,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.service_recover_stuck_document_processing(uuid,uuid,uuid,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.service_recover_stuck_document_processing(uuid,uuid,uuid,text)',
    'EXECUTE'
  )
  and (
    select prosecdef
    from pg_proc
    where oid = 'public.service_recover_stuck_document_processing(uuid,uuid,uuid,text)'::regprocedure
  )
  and (
    select coalesce(proconfig, '{}'::text[])
             @> array['search_path=public, pg_temp']::text[]
    from pg_proc
    where oid = 'public.service_recover_stuck_document_processing(uuid,uuid,uuid,text)'::regprocedure
  ),
  'the recovery RPC is not an exact service-only SECURITY DEFINER boundary'
);

select pg_temp.p42_assert(
  to_regclass('private.document_processing_recoveries') is not null
  and not has_table_privilege('service_role', 'private.document_processing_recoveries', 'SELECT')
  and not has_table_privilege('service_role', 'private.document_processing_recoveries', 'INSERT')
  and not has_table_privilege('service_role', 'private.document_processing_recoveries', 'UPDATE')
  and not has_table_privilege('service_role', 'private.document_processing_recoveries', 'DELETE')
  and not has_table_privilege('authenticated', 'private.document_processing_recoveries', 'SELECT')
  and not has_table_privilege('authenticated', 'private.document_processing_recoveries', 'INSERT')
  and not has_table_privilege('authenticated', 'private.document_processing_recoveries', 'UPDATE')
  and not has_table_privilege('authenticated', 'private.document_processing_recoveries', 'DELETE')
  and not has_table_privilege('anon', 'private.document_processing_recoveries', 'SELECT')
  and not has_table_privilege('anon', 'private.document_processing_recoveries', 'INSERT')
  and not has_table_privilege('anon', 'private.document_processing_recoveries', 'UPDATE')
  and not has_table_privilege('anon', 'private.document_processing_recoveries', 'DELETE'),
  'the private recovery replay registry is directly reachable'
);

select pg_temp.p42_assert(
  position(
    'app.document_processing_stuck_recovery_job'
    in pg_get_functiondef('public.guard_document_processing_job()'::regprocedure)
  ) > 0
  and position(
    'superseded_for_stuck_recovery'
    in pg_get_functiondef(
      'public.service_recover_document_extraction_from_egress(uuid,uuid,uuid,text)'::regprocedure
    )
  ) > 0
  and position(
    'superseded_for_stuck_recovery'
    in pg_get_functiondef(
      'public.service_recover_document_interpretation_from_egress(uuid,uuid,uuid,uuid,text)'::regprocedure
    )
  ) > 0
  and position(
    'service_recover_document_extraction_from_egress'
    in pg_get_functiondef(
      'public.service_recover_stuck_document_processing(uuid,uuid,uuid,text)'::regprocedure
    )
  ) > 0
  and position(
    'service_recover_document_interpretation_from_egress'
    in pg_get_functiondef(
      'public.service_recover_stuck_document_processing(uuid,uuid,uuid,text)'::regprocedure
    )
  ) > 0,
  'the exact transition fence, late-worker fence or evidence-first recovery path is missing'
);

begin;

insert into public.organizations (id, name, status) values
  ('13200000-0000-4000-8000-000000000001', 'P42 tenant A', 'active'),
  ('13200000-0000-4000-8000-000000000002', 'P42 tenant B', 'active');

insert into auth.users (id, email) values
  ('13210000-0000-4000-8000-000000000001', 'owner-a-p42@example.test'),
  ('13210000-0000-4000-8000-000000000002', 'office-a-p42@example.test'),
  ('13210000-0000-4000-8000-000000000003', 'owner-b-p42@example.test');

insert into public.profiles (id, org_id, full_name, role, active) values
  ('13210000-0000-4000-8000-000000000001', '13200000-0000-4000-8000-000000000001',
   'P42 owner A', 'owner', true),
  ('13210000-0000-4000-8000-000000000002', '13200000-0000-4000-8000-000000000001',
   'P42 office A', 'office', true),
  ('13210000-0000-4000-8000-000000000003', '13200000-0000-4000-8000-000000000002',
   'P42 owner B', 'owner', true);

insert into storage.objects (bucket_id, name, owner, owner_id, metadata)
select 'documents', fixture.storage_path, fixture.uploader, fixture.uploader::text,
       jsonb_build_object(
         'mimetype', 'application/pdf',
         'size', 8,
         'eTag', fixture.etag
       )
from (values
  ('13200000-0000-4000-8000-000000000001/p42/queued.pdf',
   '13210000-0000-4000-8000-000000000001'::uuid, '4200000000000001'),
  ('13200000-0000-4000-8000-000000000001/p42/healthy.pdf',
   '13210000-0000-4000-8000-000000000001'::uuid, '4200000000000002'),
  ('13200000-0000-4000-8000-000000000001/p42/recent-lease.pdf',
   '13210000-0000-4000-8000-000000000001'::uuid, '4200000000000003'),
  ('13200000-0000-4000-8000-000000000001/p42/expired-lease.pdf',
   '13210000-0000-4000-8000-000000000001'::uuid, '4200000000000004'),
  ('13200000-0000-4000-8000-000000000001/p42/live-evidence.pdf',
   '13210000-0000-4000-8000-000000000002'::uuid, '4200000000000005'),
  ('13200000-0000-4000-8000-000000000001/p42/resume.pdf',
   '13210000-0000-4000-8000-000000000002'::uuid, '4200000000000006'),
  ('13200000-0000-4000-8000-000000000001/p42/live-no-evidence.pdf',
   '13210000-0000-4000-8000-000000000001'::uuid, '4200000000000007'),
  ('13200000-0000-4000-8000-000000000001/p42/atomic.pdf',
   '13210000-0000-4000-8000-000000000001'::uuid, '4200000000000008'),
  ('13200000-0000-4000-8000-000000000001/p42/live-egress.pdf',
   '13210000-0000-4000-8000-000000000001'::uuid, '4200000000000009'),
  ('13200000-0000-4000-8000-000000000001/p42/interpretation-evidence.pdf',
   '13210000-0000-4000-8000-000000000002'::uuid, '4200000000000010')
) as fixture(storage_path, uploader, etag);

insert into public.documents (
  id, org_id, entity_type, entity_id, storage_path, file_name, mime_type,
  document_kind, uploaded_by
) values
  ('13220000-0000-4000-8000-000000000001', '13200000-0000-4000-8000-000000000001',
   'inbox', null, '13200000-0000-4000-8000-000000000001/p42/queued.pdf',
   'queued.pdf', 'application/pdf', 'other', '13210000-0000-4000-8000-000000000001'),
  ('13220000-0000-4000-8000-000000000002', '13200000-0000-4000-8000-000000000001',
   'inbox', null, '13200000-0000-4000-8000-000000000001/p42/healthy.pdf',
   'healthy.pdf', 'application/pdf', 'other', '13210000-0000-4000-8000-000000000001'),
  ('13220000-0000-4000-8000-000000000003', '13200000-0000-4000-8000-000000000001',
   'inbox', null, '13200000-0000-4000-8000-000000000001/p42/recent-lease.pdf',
   'recent-lease.pdf', 'application/pdf', 'other', '13210000-0000-4000-8000-000000000001'),
  ('13220000-0000-4000-8000-000000000004', '13200000-0000-4000-8000-000000000001',
   'inbox', null, '13200000-0000-4000-8000-000000000001/p42/expired-lease.pdf',
   'expired-lease.pdf', 'application/pdf', 'other', '13210000-0000-4000-8000-000000000001'),
  ('13220000-0000-4000-8000-000000000005', '13200000-0000-4000-8000-000000000001',
   'inbox', null, '13200000-0000-4000-8000-000000000001/p42/live-evidence.pdf',
   'live-evidence.pdf', 'application/pdf', 'other', '13210000-0000-4000-8000-000000000002'),
  ('13220000-0000-4000-8000-000000000006', '13200000-0000-4000-8000-000000000001',
   'inbox', null, '13200000-0000-4000-8000-000000000001/p42/resume.pdf',
   'resume.pdf', 'application/pdf', 'other', '13210000-0000-4000-8000-000000000002'),
  ('13220000-0000-4000-8000-000000000007', '13200000-0000-4000-8000-000000000001',
   'inbox', null, '13200000-0000-4000-8000-000000000001/p42/live-no-evidence.pdf',
   'live-no-evidence.pdf', 'application/pdf', 'other', '13210000-0000-4000-8000-000000000001'),
  ('13220000-0000-4000-8000-000000000008', '13200000-0000-4000-8000-000000000001',
   'inbox', null, '13200000-0000-4000-8000-000000000001/p42/atomic.pdf',
   'atomic.pdf', 'application/pdf', 'other', '13210000-0000-4000-8000-000000000001'),
  ('13220000-0000-4000-8000-000000000009', '13200000-0000-4000-8000-000000000001',
   'inbox', null, '13200000-0000-4000-8000-000000000001/p42/live-egress.pdf',
   'live-egress.pdf', 'application/pdf', 'other', '13210000-0000-4000-8000-000000000001'),
  ('13220000-0000-4000-8000-000000000010', '13200000-0000-4000-8000-000000000001',
   'inbox', null, '13200000-0000-4000-8000-000000000001/p42/interpretation-evidence.pdf',
   'interpretation-evidence.pdf', 'application/pdf', 'other',
   '13210000-0000-4000-8000-000000000002');

insert into public.document_processing_jobs (
  id, org_id, document_id, requested_by, status, input_checksum,
  contract_version, priority, attempt_count, lease_owner, lease_until,
  processing_attempt_id, processing_attempt_started_at, created_at, updated_at
)
select fixture.job_id, document.org_id, document.id, fixture.requested_by,
       fixture.status, public.smart_document_source_checksum(
         document.org_id, document.storage_path, document.mime_type, document.uploaded_by
       ),
       '1', 100, fixture.attempt_count, fixture.lease_owner, fixture.lease_until,
       fixture.attempt_id, fixture.attempt_started_at, fixture.created_at, fixture.updated_at
from public.documents document
join (values
  ('13220000-0000-4000-8000-000000000001'::uuid, '13230000-0000-4000-8000-000000000001'::uuid,
   '13210000-0000-4000-8000-000000000002'::uuid, 'queued', 3, null::text, null::timestamptz,
   null::uuid, null::timestamptz, statement_timestamp() - interval '3 hours',
   statement_timestamp() - interval '3 hours'),
  ('13220000-0000-4000-8000-000000000002'::uuid, '13230000-0000-4000-8000-000000000002'::uuid,
   '13210000-0000-4000-8000-000000000001'::uuid, 'queued', 0, null::text, null::timestamptz,
   null::uuid, null::timestamptz, statement_timestamp(), statement_timestamp()),
  ('13220000-0000-4000-8000-000000000003'::uuid, '13230000-0000-4000-8000-000000000003'::uuid,
   '13210000-0000-4000-8000-000000000001'::uuid, 'leased', 2, 'p42-recent',
   statement_timestamp() - interval '2 minutes', '13240000-0000-4000-8000-000000000003'::uuid,
   statement_timestamp() - interval '3 hours', statement_timestamp() - interval '3 hours',
   statement_timestamp() - interval '3 hours'),
  ('13220000-0000-4000-8000-000000000004'::uuid, '13230000-0000-4000-8000-000000000004'::uuid,
   '13210000-0000-4000-8000-000000000002'::uuid, 'leased', 3, 'p42-expired',
   statement_timestamp() - interval '10 minutes', '13240000-0000-4000-8000-000000000004'::uuid,
   statement_timestamp() - interval '3 hours', statement_timestamp() - interval '3 hours',
   statement_timestamp() - interval '3 hours'),
  ('13220000-0000-4000-8000-000000000005'::uuid, '13230000-0000-4000-8000-000000000005'::uuid,
   '13210000-0000-4000-8000-000000000002'::uuid, 'leased', 1, 'p42-live-evidence',
   statement_timestamp() + interval '30 minutes', '13240000-0000-4000-8000-000000000005'::uuid,
   statement_timestamp(), statement_timestamp(), statement_timestamp()),
  ('13220000-0000-4000-8000-000000000006'::uuid, '13230000-0000-4000-8000-000000000006'::uuid,
   '13210000-0000-4000-8000-000000000002'::uuid, 'leased', 1, 'p42-resume',
   statement_timestamp() + interval '30 minutes', '13240000-0000-4000-8000-000000000006'::uuid,
   statement_timestamp() - interval '3 hours', statement_timestamp() - interval '3 hours',
   statement_timestamp() - interval '3 hours'),
  ('13220000-0000-4000-8000-000000000007'::uuid, '13230000-0000-4000-8000-000000000007'::uuid,
   '13210000-0000-4000-8000-000000000001'::uuid, 'leased',
   private.document_processing_claim_attempt_limit(), 'p42-live-no-evidence',
   statement_timestamp() + interval '30 minutes', '13240000-0000-4000-8000-000000000007'::uuid,
   statement_timestamp() - interval '3 hours', statement_timestamp() - interval '3 hours',
   statement_timestamp() - interval '3 hours'),
  ('13220000-0000-4000-8000-000000000008'::uuid, '13230000-0000-4000-8000-000000000008'::uuid,
   '13210000-0000-4000-8000-000000000002'::uuid, 'queued', 4, null::text, null::timestamptz,
   null::uuid, null::timestamptz, statement_timestamp() - interval '3 hours',
   statement_timestamp() - interval '3 hours'),
  ('13220000-0000-4000-8000-000000000009'::uuid, '13230000-0000-4000-8000-000000000009'::uuid,
   '13210000-0000-4000-8000-000000000001'::uuid, 'leased', 3, 'p42-live-egress',
   statement_timestamp() - interval '10 minutes', '13240000-0000-4000-8000-000000000009'::uuid,
   statement_timestamp() - interval '3 hours', statement_timestamp() - interval '3 hours',
   statement_timestamp() - interval '3 hours'),
  ('13220000-0000-4000-8000-000000000010'::uuid, '13230000-0000-4000-8000-000000000010'::uuid,
   '13210000-0000-4000-8000-000000000002'::uuid, 'leased', 1, 'p42-interpretation-evidence',
   statement_timestamp() + interval '30 minutes', '13240000-0000-4000-8000-000000000010'::uuid,
   statement_timestamp(), statement_timestamp() - interval '3 hours',
   statement_timestamp() - interval '3 hours')
) as fixture(
  document_id, job_id, requested_by, status, attempt_count, lease_owner, lease_until,
  attempt_id, attempt_started_at, created_at, updated_at
) on fixture.document_id = document.id
where document.org_id = '13200000-0000-4000-8000-000000000001';

-- The service path still re-verifies an active owner in the job tenant.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
do $$
begin
  perform public.service_recover_stuck_document_processing(
    '13230000-0000-4000-8000-000000000001',
    '13210000-0000-4000-8000-000000000002',
    '13260000-0000-4000-8000-000000000001', 'P42 office denied'
  );
  raise exception 'expected office recovery rejection';
exception when insufficient_privilege then
  if sqlerrm <> 'not_authorized' then raise; end if;
end
$$;
do $$
begin
  perform public.service_recover_stuck_document_processing(
    '13230000-0000-4000-8000-000000000001',
    '13210000-0000-4000-8000-000000000003',
    '13260000-0000-4000-8000-000000000002', 'P42 cross tenant denied'
  );
  raise exception 'expected cross-tenant recovery rejection';
exception when insufficient_privilege then
  if sqlerrm <> 'not_authorized' then raise; end if;
end
$$;
reset role;

-- A stable request and normalized reason replay the exact successor. A second request for the
-- same old job is also idempotent, but changing the semantic reason fails closed.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select public.service_recover_stuck_document_processing(
  '13230000-0000-4000-8000-000000000001',
  '13210000-0000-4000-8000-000000000001',
  '13260000-0000-4000-8000-000000000003', '  P42 stable queued recovery  '
)::text as result
\gset p42_queued_
select public.service_recover_stuck_document_processing(
  '13230000-0000-4000-8000-000000000001',
  '13210000-0000-4000-8000-000000000001',
  '13260000-0000-4000-8000-000000000003', 'P42 stable queued recovery'
)::text as result
\gset p42_replay_
select public.service_recover_stuck_document_processing(
  '13230000-0000-4000-8000-000000000001',
  '13210000-0000-4000-8000-000000000001',
  '13260000-0000-4000-8000-000000000004', 'P42 stable queued recovery'
)::text as result
\gset p42_second_request_
do $$
begin
  perform public.service_recover_stuck_document_processing(
    '13230000-0000-4000-8000-000000000001',
    '13210000-0000-4000-8000-000000000001',
    '13260000-0000-4000-8000-000000000005', 'P42 changed reason'
  );
  raise exception 'expected changed-reason conflict';
exception when unique_violation then
  if sqlerrm <> 'document_processing_recovery_conflict' then raise; end if;
end
$$;
reset role;

select pg_temp.p42_assert(
  :'p42_queued_result'::jsonb ->> 'outcome' = 'requeued'
  and not (:'p42_queued_result'::jsonb ->> 'idempotent')::boolean
  and (:'p42_queued_result'::jsonb ->> 'old_job_id')::uuid
      = '13230000-0000-4000-8000-000000000001'
  and (:'p42_queued_result'::jsonb ->> 'job_id')::uuid
      <> '13230000-0000-4000-8000-000000000001'
  and (:'p42_replay_result'::jsonb ->> 'idempotent')::boolean
  and (:'p42_second_request_result'::jsonb ->> 'idempotent')::boolean
  and :'p42_replay_result'::jsonb ->> 'job_id'
      = :'p42_queued_result'::jsonb ->> 'job_id'
  and :'p42_second_request_result'::jsonb ->> 'job_id'
      = :'p42_queued_result'::jsonb ->> 'job_id'
  and exists (
    select 1 from public.document_processing_jobs
    where id = '13230000-0000-4000-8000-000000000001'
      and status = 'failed'
      and last_error_code = 'superseded_for_stuck_recovery'
  )
  and exists (
    select 1 from public.document_processing_jobs
    where id = (:'p42_queued_result'::jsonb ->> 'job_id')::uuid
      and status = 'queued' and attempt_count = 0
      and requested_by = '13210000-0000-4000-8000-000000000001'
  )
  and (
    select count(*) = 2
    from public.document_processing_jobs
    where org_id = '13200000-0000-4000-8000-000000000001'
      and document_id = '13220000-0000-4000-8000-000000000001'
  )
  and (
    select reason = 'P42 stable queued recovery'
    from private.document_processing_recoveries
    where old_job_id = '13230000-0000-4000-8000-000000000001'
  )
  and exists (
    select 1 from public.audit_logs
    where action = 'document_processing_reprocessed'
      and entity_id = (:'p42_queued_result'::jsonb ->> 'job_id')::uuid
      and user_id = '13210000-0000-4000-8000-000000000001'
      and new_values ->> 'recovery_kind' = 'stuck'
      and (new_values ->> 'old_job_id')::uuid
          = '13230000-0000-4000-8000-000000000001'
      and new_values ->> 'new_job_id'
          = (:'p42_queued_result'::jsonb ->> 'job_id')
  ),
  'queued recovery did not create exactly one uploader-owned successor or replay exactly'
);

-- Healthy work, a recently expired worker lease, and a live worker lease without evidence are
-- not mutated by an owner click.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select public.service_reserve_organization_external_egress(
  '13200000-0000-4000-8000-000000000001', 'document_signed_url',
  '13240000-0000-4000-8000-000000000009', 90
);
do $$
begin
  perform public.service_recover_stuck_document_processing(
    '13230000-0000-4000-8000-000000000002',
    '13210000-0000-4000-8000-000000000001',
    '13260000-0000-4000-8000-000000000006', 'P42 healthy rejected'
  );
  raise exception 'expected healthy rejection';
exception when sqlstate '55000' then
  if sqlerrm <> 'document_processing_job_not_stuck' then raise; end if;
end
$$;
do $$
begin
  perform public.service_recover_stuck_document_processing(
    '13230000-0000-4000-8000-000000000003',
    '13210000-0000-4000-8000-000000000001',
    '13260000-0000-4000-8000-000000000007', 'P42 recent lease rejected'
  );
  raise exception 'expected recent-lease rejection';
exception when sqlstate '55000' then
  if sqlerrm <> 'document_processing_job_not_stuck' then raise; end if;
end
$$;
do $$
begin
  perform public.service_recover_stuck_document_processing(
    '13230000-0000-4000-8000-000000000007',
    '13210000-0000-4000-8000-000000000001',
    '13260000-0000-4000-8000-000000000008', 'P42 live lease rejected'
  );
  raise exception 'expected live-lease rejection';
exception when sqlstate '55000' then
  if sqlerrm <> 'document_processing_job_not_stuck' then raise; end if;
end
$$;
do $$
begin
  perform public.service_recover_stuck_document_processing(
    '13230000-0000-4000-8000-000000000009',
    '13210000-0000-4000-8000-000000000001',
    '13260000-0000-4000-8000-000000000013', 'P42 live OCR egress rejected'
  );
  raise exception 'expected live OCR egress rejection';
exception when sqlstate '55000' then
  if sqlerrm <> 'document_processing_egress_active' then raise; end if;
end
$$;
reset role;

select pg_temp.p42_assert(
  not exists (
    select 1 from private.document_processing_recoveries
    where request_id in (
      '13260000-0000-4000-8000-000000000006',
      '13260000-0000-4000-8000-000000000007',
      '13260000-0000-4000-8000-000000000008',
      '13260000-0000-4000-8000-000000000013'
    )
  )
  and (select status = 'queued' from public.document_processing_jobs
       where id = '13230000-0000-4000-8000-000000000002')
  and (select status = 'leased' and lease_until > statement_timestamp() - interval '5 minutes'
       from public.document_processing_jobs
       where id = '13230000-0000-4000-8000-000000000003')
  and (select status = 'leased' and lease_until > statement_timestamp()
       from public.document_processing_jobs
       where id = '13230000-0000-4000-8000-000000000007')
  and (select status = 'leased' from public.document_processing_jobs
       where id = '13230000-0000-4000-8000-000000000009')
  and (select status = 'active' and expires_at > statement_timestamp()
       from private.organization_external_egress_leases
       where correlation_id = '13240000-0000-4000-8000-000000000009'),
  'healthy, recent or live work was mutated by recovery'
);

-- An old expired lease is fenced and replaced. The late worker may not apply either extraction
-- or interpretation evidence to the superseded attempt.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select public.service_recover_stuck_document_processing(
  '13230000-0000-4000-8000-000000000004',
  '13210000-0000-4000-8000-000000000001',
  '13260000-0000-4000-8000-000000000009', 'P42 expired lease recovery'
)::text as result
\gset p42_expired_
do $$
begin
  perform public.service_recover_document_extraction_from_egress(
    '13230000-0000-4000-8000-000000000004',
    '13240000-0000-4000-8000-000000000004',
    '13270000-0000-4000-8000-000000000001', repeat('a', 64)
  );
  raise exception 'expected late extraction worker rejection';
exception when sqlstate '55000' then
  if sqlerrm <> 'document_processing_attempt_superseded' then raise; end if;
end
$$;
do $$
begin
  perform public.service_recover_document_interpretation_from_egress(
    '13230000-0000-4000-8000-000000000004',
    '13270000-0000-4000-8000-000000000002',
    '13210000-0000-4000-8000-000000000001',
    '13270000-0000-4000-8000-000000000003', repeat('b', 64)
  );
  raise exception 'expected late interpretation worker rejection';
exception when sqlstate '55000' then
  if sqlerrm <> 'document_processing_attempt_superseded' then raise; end if;
end
$$;
reset role;

select pg_temp.p42_assert(
  :'p42_expired_result'::jsonb ->> 'outcome' = 'requeued'
  and (:'p42_expired_result'::jsonb ->> 'stuck_reason') = 'lease_expired'
  and (select status = 'failed'
              and last_error_code = 'superseded_for_stuck_recovery'
              and lease_owner is null and lease_until is null
       from public.document_processing_jobs
       where id = '13230000-0000-4000-8000-000000000004')
  and (select status = 'queued' and attempt_count = 0
              and requested_by = '13210000-0000-4000-8000-000000000001'
       from public.document_processing_jobs
       where id = (:'p42_expired_result'::jsonb ->> 'job_id')::uuid)
  and (
    select count(*) = 1
    from public.document_processing_jobs
    where document_id = '13220000-0000-4000-8000-000000000004'
      and status in ('queued', 'leased', 'extracted', 'interpreting', 'review')
  ),
  'the old lease was not permanently fenced and replaced exactly once'
);

-- Commit real OCR evidence through the same service RPCs used by the worker. Recovery must consume
-- paid evidence even though the job lease is live and must not create a successor.
select pg_temp.p42_payload('P42 live settled OCR evidence')::text as payload
\gset p42_live_
select input_checksum as checksum from public.document_processing_jobs
where id = '13230000-0000-4000-8000-000000000005'
\gset p42_live_
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select result ->> 'lease_id' as lease_id, result ->> 'lease_token' as lease_token
from (select public.service_reserve_organization_external_egress(
  '13200000-0000-4000-8000-000000000001', 'document_signed_url',
  '13240000-0000-4000-8000-000000000005', 90
) result) reserved
\gset p42_live_
select public.service_acknowledge_document_processing_download(
  '13230000-0000-4000-8000-000000000005', 'p42-live-evidence',
  :'p42_live_lease_id'::uuid, :'p42_live_lease_token'::uuid, 300
);
select result ->> 'evidence_sha256' as evidence_sha256
from (select public.service_record_document_ocr_evidence(
  '13230000-0000-4000-8000-000000000005',
  '13240000-0000-4000-8000-000000000005', 'p42-live-evidence',
  :'p42_live_lease_id'::uuid, :'p42_live_lease_token'::uuid,
  'p42-engine', 'p42-model', '1', :'p42_live_checksum', '1',
  :'p42_live_payload'::jsonb, 42, '{"fixture":"p42-live"}'::jsonb
) result) recorded
\gset p42_live_
select public.service_recover_stuck_document_processing(
  '13230000-0000-4000-8000-000000000005',
  '13210000-0000-4000-8000-000000000001',
  '13260000-0000-4000-8000-000000000010', 'P42 consume committed OCR evidence'
)::text as result
\gset p42_live_recovery_
reset role;

select pg_temp.p42_assert(
  :'p42_live_recovery_result'::jsonb ->> 'outcome' = 'extraction_recovered'
  and (:'p42_live_recovery_result'::jsonb ->> 'job_id')::uuid
      = '13230000-0000-4000-8000-000000000005'
  and :'p42_live_recovery_result'::jsonb ->> 'stuck_reason' = 'committed_evidence_available'
  and (select status = 'extracted' and lease_owner is null and lease_until is null
       from public.document_processing_jobs
       where id = '13230000-0000-4000-8000-000000000005')
  and (select payload = :'p42_live_payload'::jsonb
       from public.document_extractions
       where job_id = '13230000-0000-4000-8000-000000000005')
  and (select count(*) = 1 from public.document_processing_jobs
       where document_id = '13220000-0000-4000-8000-000000000005')
  and (select new_job_id is null and outcome = 'extraction_recovered'
       from private.document_processing_recoveries
       where old_job_id = '13230000-0000-4000-8000-000000000005')
  and exists (
    select 1 from public.audit_logs
    where action = 'document_processing_stuck_recovered'
      and entity_id = '13230000-0000-4000-8000-000000000005'
      and new_values ->> 'recovery_kind' = 'stuck'
  ),
  'settled OCR evidence lost to a live lease or produced a duplicate provider job'
);

-- Interpretation evidence keeps the historical provider actor even after that uploader becomes
-- inactive. The owner who requested recovery is recorded separately and is the actor that the
-- service-mode interpretation handoff must use for any current follow-up decision.
select pg_temp.p42_payload('P42 historical interpretation actor')::text as payload
\gset p42_interpret_
select input_checksum as checksum from public.document_processing_jobs
where id = '13230000-0000-4000-8000-000000000010'
\gset p42_interpret_
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select result ->> 'lease_id' as lease_id, result ->> 'lease_token' as lease_token
from (select public.service_reserve_organization_external_egress(
  '13200000-0000-4000-8000-000000000001', 'document_signed_url',
  '13240000-0000-4000-8000-000000000010', 90
) result) reserved
\gset p42_interpret_ocr_
select public.service_acknowledge_document_processing_download(
  '13230000-0000-4000-8000-000000000010', 'p42-interpretation-evidence',
  :'p42_interpret_ocr_lease_id'::uuid, :'p42_interpret_ocr_lease_token'::uuid, 300
);
select result ->> 'evidence_sha256' as evidence_sha256
from (select public.service_record_document_ocr_evidence(
  '13230000-0000-4000-8000-000000000010',
  '13240000-0000-4000-8000-000000000010', 'p42-interpretation-evidence',
  :'p42_interpret_ocr_lease_id'::uuid, :'p42_interpret_ocr_lease_token'::uuid,
  'p42-engine', 'p42-model', '1', :'p42_interpret_checksum', '1',
  :'p42_interpret_payload'::jsonb, 44, '{"fixture":"p42-interpretation"}'::jsonb
) result) recorded
\gset p42_interpret_ocr_
select public.complete_document_processing_job(
  '13230000-0000-4000-8000-000000000010',
  '13240000-0000-4000-8000-000000000010', 'p42-interpretation-evidence',
  :'p42_interpret_ocr_lease_id'::uuid, :'p42_interpret_ocr_lease_token'::uuid,
  :'p42_interpret_ocr_evidence_sha256'
);
select public.begin_document_interpretation(
  '13230000-0000-4000-8000-000000000010',
  (select id from public.document_extractions
   where job_id = '13230000-0000-4000-8000-000000000010'),
  '13210000-0000-4000-8000-000000000002'
)::text as payload
\gset p42_interpret_begin_
select public.service_reserve_organization_external_egress(
  '13200000-0000-4000-8000-000000000001', 'document_interpretation',
  '13230000-0000-4000-8000-000000000010', 90
)::text as reservation
\gset p42_interpret_egress_
select
  '{"schema_version":"1","document_type":"other","document_type_confidence":null,"supplier":{"suggested_id":null,"suggested_name":null,"confidence":null,"evidence_block_ids":[]},"fields":[],"line_items":[],"suggested_annotations":[]}'::jsonb::text
    as payload,
  encode(digest(convert_to(
    '{"schema_version":"1","document_type":"other","document_type_confidence":null,"supplier":{"suggested_id":null,"suggested_name":null,"confidence":null,"evidence_block_ids":[]},"fields":[],"line_items":[],"suggested_annotations":[]}'::jsonb::text,
    'UTF8'
  ), 'sha256'), 'hex') as sha256
\gset p42_interpret_result_
select public.service_settle_organization_external_egress_evidence(
  (:'p42_interpret_egress_reservation'::jsonb ->> 'lease_id')::uuid,
  (:'p42_interpret_egress_reservation'::jsonb ->> 'lease_token')::uuid,
  'delivered', 'interpretation_provider_result_recorded', 200,
  jsonb_build_object(
    'job_id', '13230000-0000-4000-8000-000000000010'::uuid,
    'extraction_id', (select id from public.document_extractions
                      where job_id = '13230000-0000-4000-8000-000000000010'),
    'actor_id', '13210000-0000-4000-8000-000000000002'::uuid,
    'interpretation_started_at', :'p42_interpret_begin_payload'::jsonb
      ->> 'interpretation_started_at',
    'provider', 'p42-provider', 'model', 'p42-model',
    'prompt_version', 'p42-historical-actor', 'schema_version', '1',
    'provider_request_id', 'p42-provider-request', 'usage', '{}'::jsonb,
    'duration_ms', 1, 'input_truncation', '{}'::jsonb,
    'provider_result_sha256', :'p42_interpret_result_sha256',
    'interpretation', :'p42_interpret_result_payload'::jsonb
  )
)::text as receipt
\gset p42_interpret_evidence_
reset role;

update public.profiles set active = false
where id = '13210000-0000-4000-8000-000000000002';

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select public.service_recover_stuck_document_processing(
  '13230000-0000-4000-8000-000000000010',
  '13210000-0000-4000-8000-000000000001',
  '13260000-0000-4000-8000-000000000015',
  'P42 consume historical actor interpretation evidence'
)::text as result
\gset p42_interpret_recovery_
reset role;

select pg_temp.p42_assert(
  :'p42_interpret_recovery_result'::jsonb ->> 'outcome' = 'interpretation_recovered',
  'committed interpretation evidence did not produce interpretation_recovered'
);

select pg_temp.p42_assert(
  :'p42_interpret_recovery_result'::jsonb ->> 'stuck_reason'
    = 'active_over_two_hours',
  'interpretation recovery did not preserve the canonical time-based stuck reason'
);

select pg_temp.p42_assert(
  (select status = 'review'
   from public.document_processing_jobs
   where id = '13230000-0000-4000-8000-000000000010'),
  'interpretation evidence recovery did not leave the job in review'
);

select pg_temp.p42_assert(
  (select interpreted_for_user_id = '13210000-0000-4000-8000-000000000002'
   from public.document_interpretations
   where job_id = '13230000-0000-4000-8000-000000000010'),
  'interpretation evidence lost its historical actor'
);

select pg_temp.p42_assert(
  (select requested_by = '13210000-0000-4000-8000-000000000002'
   from public.document_processing_jobs
   where id = '13230000-0000-4000-8000-000000000010'),
  'interpretation recovery rewrote the historical job requester'
);

select pg_temp.p42_assert(
  (select uploaded_by = '13210000-0000-4000-8000-000000000002'
   from public.documents
   where id = '13220000-0000-4000-8000-000000000010'),
  'interpretation recovery rewrote the historical document uploader'
);

select pg_temp.p42_assert(
  (select actor_id = '13210000-0000-4000-8000-000000000001'
          and new_job_id is null and outcome = 'interpretation_recovered'
   from private.document_processing_recoveries
   where request_id = '13260000-0000-4000-8000-000000000015'),
  'the recovery ledger did not record the verified owner separately'
);

select pg_temp.p42_assert(
  exists (
    select 1 from public.audit_logs audit
    join public.document_processing_jobs job on job.id = audit.entity_id
    where audit.action = 'document_processing_stuck_recovered'
      and audit.entity_id = '13230000-0000-4000-8000-000000000010'
      and audit.user_id = '13210000-0000-4000-8000-000000000001'
      and audit.new_values ->> 'outcome' = 'interpretation_recovered'
      and audit.new_values ->> 'result_job_status' = job.status
      and (audit.new_values ->> 'result_job_updated_at')::timestamptz = job.updated_at
  ),
  'the recovery audit did not record the verified owner and current job state'
);

-- A genuinely old extracted job resumes interpretation in place. Its extraction is also created
-- through real egress evidence, never by a direct INSERT into the immutable ledger.
select pg_temp.p42_payload('P42 extracted evidence')::text as payload
\gset p42_resume_
select input_checksum as checksum from public.document_processing_jobs
where id = '13230000-0000-4000-8000-000000000006'
\gset p42_resume_
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select result ->> 'lease_id' as lease_id, result ->> 'lease_token' as lease_token
from (select public.service_reserve_organization_external_egress(
  '13200000-0000-4000-8000-000000000001', 'document_signed_url',
  '13240000-0000-4000-8000-000000000006', 90
) result) reserved
\gset p42_resume_
select public.service_acknowledge_document_processing_download(
  '13230000-0000-4000-8000-000000000006', 'p42-resume',
  :'p42_resume_lease_id'::uuid, :'p42_resume_lease_token'::uuid, 300
);
select result ->> 'evidence_sha256' as evidence_sha256
from (select public.service_record_document_ocr_evidence(
  '13230000-0000-4000-8000-000000000006',
  '13240000-0000-4000-8000-000000000006', 'p42-resume',
  :'p42_resume_lease_id'::uuid, :'p42_resume_lease_token'::uuid,
  'p42-engine', 'p42-model', '1', :'p42_resume_checksum', '1',
  :'p42_resume_payload'::jsonb, 43, '{"fixture":"p42-resume"}'::jsonb
) result) recorded
\gset p42_resume_
select public.complete_document_processing_job(
  '13230000-0000-4000-8000-000000000006',
  '13240000-0000-4000-8000-000000000006', 'p42-resume',
  :'p42_resume_lease_id'::uuid, :'p42_resume_lease_token'::uuid,
  :'p42_resume_evidence_sha256'
);
select public.service_recover_stuck_document_processing(
  '13230000-0000-4000-8000-000000000006',
  '13210000-0000-4000-8000-000000000001',
  '13260000-0000-4000-8000-000000000011', 'P42 resume interpretation'
)::text as result
\gset p42_resume_recovery_
reset role;

select pg_temp.p42_assert(
  :'p42_resume_recovery_result'::jsonb ->> 'outcome' = 'resume_interpretation'
  and (:'p42_resume_recovery_result'::jsonb ->> 'job_id')::uuid
      = '13230000-0000-4000-8000-000000000006'
  and (select status = 'extracted' from public.document_processing_jobs
       where id = '13230000-0000-4000-8000-000000000006')
  and (select payload = :'p42_resume_payload'::jsonb from public.document_extractions
       where job_id = '13230000-0000-4000-8000-000000000006')
  and (select requested_by = '13210000-0000-4000-8000-000000000002'
       from public.document_processing_jobs
       where id = '13230000-0000-4000-8000-000000000006')
  and (select uploaded_by = '13210000-0000-4000-8000-000000000002'
       from public.documents
       where id = '13220000-0000-4000-8000-000000000006')
  and (select count(*) = 1 from public.document_processing_jobs
       where document_id = '13220000-0000-4000-8000-000000000006')
  and exists (
    select 1 from public.audit_logs
    where action = 'document_processing_stuck_recovered'
      and entity_id = '13230000-0000-4000-8000-000000000006'
      and user_id = '13210000-0000-4000-8000-000000000001'
      and new_values ->> 'recovery_kind' = 'stuck'
      and reason = 'P42 resume interpretation'
  ),
  'an extracted job was duplicated, lost evidence or failed to resume interpretation in place'
);

-- An in-place recovery is stage-scoped, not a permanent ban. An interpretation lease that settled
-- ambiguous without evidence is rearmed as a new token generation. The next reservation consumes
-- that generation once, while the old provider token is permanently fenced.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select public.begin_document_interpretation(
  '13230000-0000-4000-8000-000000000006',
  (select id from public.document_extractions
   where job_id = '13230000-0000-4000-8000-000000000006'),
  '13210000-0000-4000-8000-000000000001'
);
select public.service_reserve_organization_external_egress(
  '13200000-0000-4000-8000-000000000001', 'document_interpretation',
  '13230000-0000-4000-8000-000000000006', 90
)::text as reservation
\gset p42_stale_interpretation_
reset role;

update private.organization_external_egress_leases
set status = 'settled', outcome = 'ambiguous',
    evidence_code = 'lease_expired_without_settlement',
    settled_at = statement_timestamp()
where lease_id = (:'p42_stale_interpretation_reservation'::jsonb ->> 'lease_id')::uuid;

create temp table p42_stale_interpretation_generation (
  lease_id uuid primary key,
  lease_token uuid not null
);
insert into p42_stale_interpretation_generation values (
  (:'p42_stale_interpretation_reservation'::jsonb ->> 'lease_id')::uuid,
  (:'p42_stale_interpretation_reservation'::jsonb ->> 'lease_token')::uuid
);
grant select on p42_stale_interpretation_generation to service_role;

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select public.service_recover_stuck_document_processing(
  '13230000-0000-4000-8000-000000000006',
  '13210000-0000-4000-8000-000000000001',
  '13260000-0000-4000-8000-000000000014', 'P42 recover later interpretation stage'
)::text as result
\gset p42_later_stage_
do $$
declare
  v_lease_id uuid;
  v_lease_token uuid;
begin
  select lease_id, lease_token into v_lease_id, v_lease_token
  from p42_stale_interpretation_generation;
  perform public.service_settle_organization_external_egress_evidence(
    v_lease_id, v_lease_token,
    'delivered', 'late_provider_result', 200, '{}'::jsonb
  );
  raise exception 'expected previous interpretation generation to be fenced';
exception when serialization_failure then
  if sqlerrm <> 'organization_external_egress_lease_lost' then raise; end if;
end
$$;
-- The recovery RPC may commit before the Edge handoff gets CPU. Even after that private marker's
-- provisional deadline passes, its first canonical consumer must receive one fresh bounded
-- provider window instead of settling the unused generation as ambiguous.
reset role;
update private.organization_external_egress_leases
set reserved_at = statement_timestamp() - interval '2 minutes',
    expires_at = statement_timestamp() - interval '1 second'
where org_id = '13200000-0000-4000-8000-000000000001'
  and kind = 'document_interpretation'
  and correlation_id = '13230000-0000-4000-8000-000000000006'
  and evidence_code = 'owner_stuck_recovery_rearmed';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select public.service_reserve_organization_external_egress(
  '13200000-0000-4000-8000-000000000001', 'document_interpretation',
  '13230000-0000-4000-8000-000000000006', 90
)::text as reservation
\gset p42_rearmed_interpretation_
select public.service_reserve_organization_external_egress(
  '13200000-0000-4000-8000-000000000001', 'document_interpretation',
  '13230000-0000-4000-8000-000000000006', 90
)::text as reservation
\gset p42_rearmed_replay_
reset role;

select pg_temp.p42_assert(
  :'p42_later_stage_result'::jsonb ->> 'outcome' = 'resume_interpretation'
  and not (:'p42_later_stage_result'::jsonb ->> 'idempotent')::boolean
  and not (:'p42_rearmed_interpretation_reservation'::jsonb ->> 'idempotent')::boolean
  and (:'p42_rearmed_replay_reservation'::jsonb ->> 'idempotent')::boolean
  and :'p42_rearmed_interpretation_reservation'::jsonb ->> 'lease_token'
      = :'p42_rearmed_replay_reservation'::jsonb ->> 'lease_token'
  and :'p42_rearmed_interpretation_reservation'::jsonb ->> 'lease_token'
      <> :'p42_stale_interpretation_reservation'::jsonb ->> 'lease_token'
  and (select expires_at > statement_timestamp() + interval '60 seconds'
       from private.organization_external_egress_leases
       where org_id = '13200000-0000-4000-8000-000000000001'
         and kind = 'document_interpretation'
         and correlation_id = '13230000-0000-4000-8000-000000000006')
  and (select count(*) = 2 from private.document_processing_recoveries
       where old_job_id = '13230000-0000-4000-8000-000000000006')
  and (select status = 'interpreting' from public.document_processing_jobs
       where id = '13230000-0000-4000-8000-000000000006')
  and (select status = 'active' and evidence_code is null and reservation_count = 2
       from private.organization_external_egress_leases
       where org_id = '13200000-0000-4000-8000-000000000001'
         and kind = 'document_interpretation'
         and correlation_id = '13230000-0000-4000-8000-000000000006')
  and (select count(*) = 1 from public.document_processing_jobs
       where document_id = '13220000-0000-4000-8000-000000000006'),
  'interpretation rearm did not rotate and consume exactly one provider generation'
);

-- A later statement failure rolls the recovery command back atomically with its registry, audit
-- row and successor.
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
do $$
begin
  begin
    perform public.service_recover_stuck_document_processing(
      '13230000-0000-4000-8000-000000000008',
      '13210000-0000-4000-8000-000000000001',
      '13260000-0000-4000-8000-000000000012', 'P42 forced rollback'
    );
    raise exception 'p42_forced_post_recovery_failure';
  exception when raise_exception then
    if sqlerrm <> 'p42_forced_post_recovery_failure' then raise; end if;
  end;
end
$$;
reset role;

select pg_temp.p42_assert(
  (select status = 'queued' and last_error_code is null
   from public.document_processing_jobs
   where id = '13230000-0000-4000-8000-000000000008')
  and (select count(*) = 1 from public.document_processing_jobs
       where document_id = '13220000-0000-4000-8000-000000000008')
  and not exists (
    select 1 from private.document_processing_recoveries
    where request_id = '13260000-0000-4000-8000-000000000012'
  )
  and not exists (
    select 1 from public.audit_logs
    where action in ('document_processing_reprocessed', 'document_processing_stuck_recovered')
      and entity_id = '13230000-0000-4000-8000-000000000008'
  ),
  'a forced caller rollback left a failed old job, successor, registry or audit fragment'
);

rollback;

-- Concurrency needs committed fixtures so independent connections can see them. The queued
-- fixture is extraction-free; the two interpretation fixtures isolate both lease-lock orders.
begin;
insert into public.organizations (id, name, status)
values ('13200000-0000-4000-8000-000000000099', 'P42 concurrency tenant', 'active');
insert into auth.users (id, email)
values ('13210000-0000-4000-8000-000000000099', 'owner-concurrency-p42@example.test');
insert into public.profiles (id, org_id, full_name, role, active) values (
  '13210000-0000-4000-8000-000000000099',
  '13200000-0000-4000-8000-000000000099', 'P42 concurrency owner', 'owner', true
);
insert into storage.objects (bucket_id, name, owner, owner_id, metadata) values
  (
    'documents',
    '13200000-0000-4000-8000-000000000099/p42/concurrency.pdf',
    '13210000-0000-4000-8000-000000000099',
    '13210000-0000-4000-8000-000000000099',
    '{"mimetype":"application/pdf","size":8,"eTag":"4200000000000099"}'::jsonb
  ),
  (
    'documents',
    '13200000-0000-4000-8000-000000000099/p42/settlement-first.pdf',
    '13210000-0000-4000-8000-000000000099',
    '13210000-0000-4000-8000-000000000099',
    '{"mimetype":"application/pdf","size":8,"eTag":"4200000000000097"}'::jsonb
  ),
  (
    'documents',
    '13200000-0000-4000-8000-000000000099/p42/recovery-first.pdf',
    '13210000-0000-4000-8000-000000000099',
    '13210000-0000-4000-8000-000000000099',
    '{"mimetype":"application/pdf","size":8,"eTag":"4200000000000096"}'::jsonb
  );
insert into public.documents (
  id, org_id, entity_type, entity_id, storage_path, file_name, mime_type,
  document_kind, uploaded_by
) values (
  '13220000-0000-4000-8000-000000000099',
  '13200000-0000-4000-8000-000000000099', 'inbox', null,
  '13200000-0000-4000-8000-000000000099/p42/concurrency.pdf',
  'concurrency.pdf', 'application/pdf', 'other',
  '13210000-0000-4000-8000-000000000099'
), (
  '13220000-0000-4000-8000-000000000097',
  '13200000-0000-4000-8000-000000000099', 'inbox', null,
  '13200000-0000-4000-8000-000000000099/p42/settlement-first.pdf',
  'settlement-first.pdf', 'application/pdf', 'other',
  '13210000-0000-4000-8000-000000000099'
), (
  '13220000-0000-4000-8000-000000000096',
  '13200000-0000-4000-8000-000000000099', 'inbox', null,
  '13200000-0000-4000-8000-000000000099/p42/recovery-first.pdf',
  'recovery-first.pdf', 'application/pdf', 'other',
  '13210000-0000-4000-8000-000000000099'
);
insert into public.document_processing_jobs (
  id, org_id, document_id, requested_by, status, input_checksum,
  attempt_count, created_at, updated_at
)
select '13230000-0000-4000-8000-000000000099', document.org_id, document.id,
       document.uploaded_by, 'queued', public.smart_document_source_checksum(
         document.org_id, document.storage_path, document.mime_type, document.uploaded_by
       ), 4, statement_timestamp() - interval '3 hours', statement_timestamp() - interval '3 hours'
from public.documents document
where document.id = '13220000-0000-4000-8000-000000000099';

insert into public.document_processing_jobs (
  id, org_id, document_id, requested_by, status, input_checksum,
  attempt_count, interpretation_actor_id, interpretation_started_at,
  created_at, updated_at
)
select fixture.job_id, document.org_id, document.id, document.uploaded_by,
       'interpreting', public.smart_document_source_checksum(
         document.org_id, document.storage_path, document.mime_type, document.uploaded_by
       ), 4, document.uploaded_by,
       statement_timestamp() - interval '3 hours',
       statement_timestamp() - interval '3 hours',
       statement_timestamp() - interval '3 hours'
from (values
  ('13230000-0000-4000-8000-000000000097'::uuid,
   '13220000-0000-4000-8000-000000000097'::uuid),
  ('13230000-0000-4000-8000-000000000096'::uuid,
   '13220000-0000-4000-8000-000000000096'::uuid)
) fixture(job_id, document_id)
join public.documents document on document.id = fixture.document_id;

insert into public.document_extractions (
  id, org_id, job_id, document_id, engine, model, model_version,
  input_checksum, contract_version, payload, duration_ms, resource_metadata
)
select fixture.extraction_id, job.org_id, job.id, job.document_id,
       'p42-engine', 'p42-model', '1', job.input_checksum, '1',
       pg_temp.p42_payload(fixture.label), 1, '{"fixture":"p42-race"}'::jsonb
from (values
  ('13250000-0000-4000-8000-000000000097'::uuid,
   '13230000-0000-4000-8000-000000000097'::uuid, 'P42 settlement first'),
  ('13250000-0000-4000-8000-000000000096'::uuid,
   '13230000-0000-4000-8000-000000000096'::uuid, 'P42 recovery first')
) fixture(extraction_id, job_id, label)
join public.document_processing_jobs job on job.id = fixture.job_id;

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select public.service_reserve_organization_external_egress(
  '13200000-0000-4000-8000-000000000099', 'document_interpretation',
  '13230000-0000-4000-8000-000000000097', 90
)::text as reservation
\gset p42_race_settlement_first_
select public.service_reserve_organization_external_egress(
  '13200000-0000-4000-8000-000000000099', 'document_interpretation',
  '13230000-0000-4000-8000-000000000096', 90
)::text as reservation
\gset p42_race_recovery_first_
reset role;
update private.organization_external_egress_leases
set reserved_at = statement_timestamp() - interval '2 minutes',
    expires_at = statement_timestamp() - interval '1 minute'
where lease_id = (:'p42_race_recovery_first_reservation'::jsonb ->> 'lease_id')::uuid;
commit;

create schema p42_concurrency_test;
grant usage on schema p42_concurrency_test to service_role;
create function p42_concurrency_test.settle_interpretation(
  p_job_id uuid,
  p_extraction_id uuid,
  p_actor_id uuid,
  p_lease_id uuid,
  p_lease_token uuid
) returns jsonb
language plpgsql
security invoker
set search_path = public, extensions, pg_temp
as $$
declare
  v_started_at timestamptz;
  v_interpretation jsonb :=
    '{"schema_version":"1","document_type":"other","document_type_confidence":null,"supplier":{"suggested_id":null,"suggested_name":null,"confidence":null,"evidence_block_ids":[]},"fields":[],"line_items":[],"suggested_annotations":[]}'::jsonb;
  v_provider_hash text;
begin
  select interpretation_started_at into strict v_started_at
  from public.document_processing_jobs where id = p_job_id;
  v_provider_hash := encode(
    digest(convert_to(v_interpretation::text, 'UTF8'), 'sha256'),
    'hex'
  );
  return public.service_settle_organization_external_egress_evidence(
    p_lease_id, p_lease_token, 'delivered',
    'interpretation_provider_result_recorded', 200,
    jsonb_build_object(
      'job_id', p_job_id, 'extraction_id', p_extraction_id,
      'actor_id', p_actor_id, 'interpretation_started_at', v_started_at,
      'provider', 'p42-provider', 'model', 'p42-model',
      'prompt_version', 'p42-race', 'schema_version', '1',
      'provider_request_id', 'p42-race-provider-request',
      'usage', '{}'::jsonb, 'duration_ms', 1,
      'input_truncation', '{}'::jsonb,
      'provider_result_sha256', v_provider_hash,
      'interpretation', v_interpretation
    )
  );
exception when serialization_failure then
  return jsonb_build_object('error', sqlerrm);
end
$$;
grant execute on function p42_concurrency_test.settle_interpretation(
  uuid, uuid, uuid, uuid, uuid
) to service_role;

create temp table p42_settlement_race_results (
  race text not null,
  runner text not null,
  result jsonb not null,
  primary key (race, runner)
);

select dblink_connect(
  'p42_settlement_first',
  'host=127.0.0.1 port=5432 dbname=postgres user=supabase_admin password=postgres'
);
select dblink_connect(
  'p42_recovery_after_settlement',
  'host=127.0.0.1 port=5432 dbname=postgres user=supabase_admin password=postgres'
);
select dblink_connect(
  'p42_recovery_first',
  'host=127.0.0.1 port=5432 dbname=postgres user=supabase_admin password=postgres'
);
select dblink_connect(
  'p42_settlement_after_recovery',
  'host=127.0.0.1 port=5432 dbname=postgres user=supabase_admin password=postgres'
);

select dblink_exec(connection_name, 'set "request.jwt.claim.role" = ''service_role''')
from (values
  ('p42_settlement_first'), ('p42_recovery_after_settlement'),
  ('p42_recovery_first'), ('p42_settlement_after_recovery')
) connections(connection_name);
select dblink_exec(connection_name, 'set role service_role')
from (values
  ('p42_settlement_first'), ('p42_recovery_after_settlement'),
  ('p42_recovery_first'), ('p42_settlement_after_recovery')
) connections(connection_name);

-- Settlement owns the lease row first. Recovery must wait, then observe and consume the committed
-- immutable evidence instead of rotating the generation or making another provider request.
select dblink_exec('p42_settlement_first', 'begin');
insert into p42_settlement_race_results
select 'settlement_first', 'settlement', result
from dblink(
  'p42_settlement_first',
  format(
    'select p42_concurrency_test.settle_interpretation(%L::uuid,%L::uuid,%L::uuid,%L::uuid,%L::uuid)',
    '13230000-0000-4000-8000-000000000097',
    '13250000-0000-4000-8000-000000000097',
    '13210000-0000-4000-8000-000000000099',
    :'p42_race_settlement_first_reservation'::jsonb ->> 'lease_id',
    :'p42_race_settlement_first_reservation'::jsonb ->> 'lease_token'
  )
) response(result jsonb);
select dblink_send_query(
  'p42_recovery_after_settlement',
  $$select public.service_recover_stuck_document_processing(
    '13230000-0000-4000-8000-000000000097',
    '13210000-0000-4000-8000-000000000099',
    '13260000-0000-4000-8000-000000000097', 'P42 settlement wins race'
  )$$
);
select pg_sleep(0.15);
select pg_temp.p42_assert(
  dblink_is_busy('p42_recovery_after_settlement') = 1,
  'recovery did not wait while settlement owned the interpretation lease row'
);
select dblink_exec('p42_settlement_first', 'commit');
insert into p42_settlement_race_results
select 'settlement_first', 'recovery', result
from dblink_get_result('p42_recovery_after_settlement') response(result jsonb);
select count(*) from dblink_get_result('p42_recovery_after_settlement') response(result jsonb);

-- Recovery owns the expired lease row first and rotates its token. The old settlement waits for
-- commit and then fails closed against the generation it actually called.
select dblink_exec('p42_recovery_first', 'begin');
insert into p42_settlement_race_results
select 'recovery_first', 'recovery', result
from dblink(
  'p42_recovery_first',
  $$select public.service_recover_stuck_document_processing(
    '13230000-0000-4000-8000-000000000096',
    '13210000-0000-4000-8000-000000000099',
    '13260000-0000-4000-8000-000000000096', 'P42 recovery wins race'
  )$$
) response(result jsonb);
select dblink_send_query(
  'p42_settlement_after_recovery',
  format(
    'select p42_concurrency_test.settle_interpretation(%L::uuid,%L::uuid,%L::uuid,%L::uuid,%L::uuid)',
    '13230000-0000-4000-8000-000000000096',
    '13250000-0000-4000-8000-000000000096',
    '13210000-0000-4000-8000-000000000099',
    :'p42_race_recovery_first_reservation'::jsonb ->> 'lease_id',
    :'p42_race_recovery_first_reservation'::jsonb ->> 'lease_token'
  )
);
select pg_sleep(0.15);
select pg_temp.p42_assert(
  dblink_is_busy('p42_settlement_after_recovery') = 1,
  'the old settlement did not wait while recovery rotated the interpretation generation'
);
select dblink_exec('p42_recovery_first', 'commit');
insert into p42_settlement_race_results
select 'recovery_first', 'settlement', result
from dblink_get_result('p42_settlement_after_recovery') response(result jsonb);
select count(*) from dblink_get_result('p42_settlement_after_recovery') response(result jsonb);

select pg_temp.p42_assert(
  (select result ->> 'outcome' = 'interpretation_recovered'
   from p42_settlement_race_results
   where race = 'settlement_first' and runner = 'recovery')
  and (select result ->> 'error' is null
       from p42_settlement_race_results
       where race = 'settlement_first' and runner = 'settlement')
  and (select status = 'review'
       from public.document_processing_jobs
       where id = '13230000-0000-4000-8000-000000000097')
  and (select count(*) = 1 from public.document_interpretations
       where job_id = '13230000-0000-4000-8000-000000000097'),
  'settlement-first race lost committed evidence or duplicated interpretation work'
);
select pg_temp.p42_assert(
  (select result ->> 'outcome' = 'resume_interpretation'
   from p42_settlement_race_results
   where race = 'recovery_first' and runner = 'recovery')
  and (select result ->> 'error' = 'organization_external_egress_lease_lost'
       from p42_settlement_race_results
       where race = 'recovery_first' and runner = 'settlement')
  and not exists (
    select 1 from private.organization_external_egress_evidence
    where correlation_id = '13230000-0000-4000-8000-000000000096'
      and kind = 'document_interpretation'
  )
  and (select lease_token::text
            <> (:'p42_race_recovery_first_reservation'::jsonb ->> 'lease_token')
       from private.organization_external_egress_leases
       where correlation_id = '13230000-0000-4000-8000-000000000096'
         and kind = 'document_interpretation'),
  'recovery-first race accepted evidence from the superseded provider generation'
);

select dblink_disconnect(connection_name)
from (values
  ('p42_settlement_first'), ('p42_recovery_after_settlement'),
  ('p42_recovery_first'), ('p42_settlement_after_recovery')
) connections(connection_name);
drop schema p42_concurrency_test cascade;

select dblink_connect(
  'p42_recovery_a',
  'host=127.0.0.1 port=5432 dbname=postgres user=supabase_admin password=postgres'
);
select dblink_connect(
  'p42_recovery_b',
  'host=127.0.0.1 port=5432 dbname=postgres user=supabase_admin password=postgres'
);
select dblink_exec('p42_recovery_a', 'set "request.jwt.claim.role" = ''service_role''');
select dblink_exec('p42_recovery_b', 'set "request.jwt.claim.role" = ''service_role''');
select dblink_exec('p42_recovery_a', 'set role service_role');
select dblink_exec('p42_recovery_b', 'set role service_role');
select dblink_send_query(
  'p42_recovery_a',
  $$select public.service_recover_stuck_document_processing(
    '13230000-0000-4000-8000-000000000099',
    '13210000-0000-4000-8000-000000000099',
    '13260000-0000-4000-8000-000000000099', 'P42 concurrent recovery'
  )$$
);
select dblink_send_query(
  'p42_recovery_b',
  $$select public.service_recover_stuck_document_processing(
    '13230000-0000-4000-8000-000000000099',
    '13210000-0000-4000-8000-000000000099',
    '13260000-0000-4000-8000-000000000098', 'P42 concurrent recovery'
  )$$
);
create temp table p42_concurrent_results (caller text primary key, result jsonb not null);
insert into p42_concurrent_results
select 'a', result from dblink_get_result('p42_recovery_a') as response(result jsonb);
insert into p42_concurrent_results
select 'b', result from dblink_get_result('p42_recovery_b') as response(result jsonb);
select count(*) from dblink_get_result('p42_recovery_a') as response(result jsonb);
select count(*) from dblink_get_result('p42_recovery_b') as response(result jsonb);
select dblink_disconnect('p42_recovery_a');
select dblink_disconnect('p42_recovery_b');

select pg_temp.p42_assert(
  (select count(*) = 2 from p42_concurrent_results)
  and (select count(distinct result ->> 'job_id') = 1 from p42_concurrent_results)
  and (select bool_and(result ->> 'outcome' = 'requeued') from p42_concurrent_results)
  and (select count(*) = 1 from private.document_processing_recoveries
       where old_job_id = '13230000-0000-4000-8000-000000000099')
  and (select count(*) = 1 from public.document_processing_jobs
       where document_id = '13220000-0000-4000-8000-000000000099'
         and status = 'queued')
  and (select count(*) = 2 from public.document_processing_jobs
       where document_id = '13220000-0000-4000-8000-000000000099'),
  'two concurrent owner calls created different successors or replay rows'
);

-- The gate runs on a freshly reset disposable database. As in the other dblink suites, the
-- committed concurrency fixture remains visible to later invariant checks and is removed by the
-- next reset; Storage deliberately forbids direct SQL deletion of its object ledger.
select 'p42_document_processing_recovery_passed' as result;
