-- P47 -- Mixed PDFs are split only from a complete reviewed manifest into isolated child jobs.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p47_assert(p_condition boolean,p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition,false) then
    raise exception 'P47 mixed document packet assertion failed: %',p_message;
  end if;
end
$$;

create function pg_temp.p47_actor(p_user uuid,p_role text default 'authenticated')
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub',coalesce(p_user::text,''),false);
  perform set_config('request.jwt.claim.role',case
    when p_user is null and p_role='authenticated' then '' else coalesce(p_role,'') end,false);
  perform set_config('request.jwt.claims',case when p_user is null then '{}' else
    jsonb_build_object('sub',p_user,'role',p_role)::text end,false);
end
$$;

create function pg_temp.p47_extraction(p_page_count integer,p_partial boolean)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'schema_version','1','document',jsonb_build_object(
      'page_count',p_page_count,'detected_languages',jsonb_build_array('he'),
      'plain_text','P47 packet','partial',p_partial),
    'blocks','[]'::jsonb,'tables','[]'::jsonb,'marks','[]'::jsonb)
$$;

create function pg_temp.p47_manifest(
  p_page_count integer,p_first_confidence numeric,p_second_confidence numeric
) returns jsonb language sql immutable as $$
  select jsonb_build_array(
    jsonb_build_object('ordinal',1,'start_page',1,
      'end_page',greatest(1,p_page_count/2),'document_type','delivery_note',
      'confidence',p_first_confidence),
    jsonb_build_object('ordinal',2,'start_page',greatest(1,p_page_count/2)+1,
      'end_page',p_page_count,'document_type','invoice','confidence',p_second_confidence))
$$;

create function pg_temp.p47_interpretation(p_manifest jsonb)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'schema_version','1','document_type','other','document_type_confidence',0.99,
    'supplier',jsonb_build_object('suggested_id',null,'suggested_name',null,
      'confidence',null,'evidence_block_ids','[]'::jsonb),
    'fields','[]'::jsonb,'line_items','[]'::jsonb,
    'suggested_annotations','[]'::jsonb,'packet_segments',p_manifest)
$$;

-- ===== Shape, policy and manifest contract =====

select pg_temp.p47_assert(
  exists(select 1 from private.autonomy_policy_definitions
    where policy_key='document.packet_split' and not baseline_enabled
      and baseline_min_confidence=0.900 and not kill_switch),
  'packet splitting must be default-off at the 0.900 floor');

select pg_temp.p47_assert(
  (select bool_and(relrowsecurity and relforcerowsecurity) from pg_class
   where oid=any(array['public.document_packets'::regclass,
     'public.document_packet_segments'::regclass]))
  and has_table_privilege('authenticated','public.document_packets','SELECT')
  and has_table_privilege('authenticated','public.document_packet_segments','SELECT')
  and not has_table_privilege('authenticated','public.document_packets','INSERT')
  and not has_table_privilege('authenticated','public.document_packet_segments','UPDATE')
  and has_function_privilege('service_role',
    'public.service_record_document_packet(uuid,uuid,uuid)','EXECUTE')
  and not has_function_privilege('authenticated',
    'public.service_record_document_packet(uuid,uuid,uuid)','EXECUTE')
  and has_function_privilege('authenticated',
    'public.approve_document_packet(uuid,text,jsonb,text)','EXECUTE')
  and not has_function_privilege('anon',
    'public.approve_document_packet(uuid,text,jsonb,text)','EXECUTE')
  and has_function_privilege('service_role',
    'public.service_materialize_document_packet(uuid,text,uuid)','EXECUTE')
  and not has_function_privilege('authenticated',
    'public.service_materialize_document_packet(uuid,text,uuid)','EXECUTE'),
  'RLS, FORCE RLS or RPC-only grants drifted');

select pg_temp.p47_assert(
  private.document_packet_manifest_valid(pg_temp.p47_manifest(4,0.95,0.96),4)
  and not private.document_packet_manifest_valid(
    jsonb_build_array(
      jsonb_build_object('ordinal',1,'start_page',1,'end_page',1,
        'document_type','invoice','confidence',0.95),
      jsonb_build_object('ordinal',2,'start_page',3,'end_page',4,
        'document_type','delivery_note','confidence',0.95)),4)
  and not private.document_packet_manifest_valid(
    jsonb_build_array(
      jsonb_build_object('ordinal',1,'start_page',1,'end_page',3,
        'document_type','invoice','confidence',0.95),
      jsonb_build_object('ordinal',2,'start_page',3,'end_page',4,
        'document_type','delivery_note','confidence',0.95)),4)
  and not private.document_packet_manifest_valid(
    jsonb_build_array(
      jsonb_build_object('ordinal',2,'start_page',1,'end_page',2,
        'document_type','invoice','confidence',0.95),
      jsonb_build_object('ordinal',3,'start_page',3,'end_page',4,
        'document_type','delivery_note','confidence',0.95)),4),
  'gap, overlap or wrong ordinal was accepted');

-- ===== Two tenants and five packet candidates =====

insert into public.organizations(id,name,status) values
  ('14700000-0000-4000-8000-000000000001','P47 tenant A','active'),
  ('14700000-0000-4000-8000-000000000002','P47 tenant B','active');

-- 0211 grants the four document autonomy policies to every organisation created inside the
-- pre-launch window, so a fixture tenant is now born WITH them. This suite's OFF scenarios
-- need the opposite, and after 0211 "off" is a state a test has to construct rather than
-- inherit. Removing the birth grants by name is that construction.
delete from org_autonomy_policies where org_id in (
  '14700000-0000-4000-8000-000000000001','14700000-0000-4000-8000-000000000002');

select id as unit_id from public.org_units
where org_id='14700000-0000-4000-8000-000000000001' and unit_type='legal_entity'
\gset p47_

insert into auth.users(id,email) values
  ('14710000-0000-4000-8000-000000000001','p47-owner-a@example.test'),
  ('14710000-0000-4000-8000-000000000002','p47-office-a@example.test'),
  ('14710000-0000-4000-8000-000000000003','p47-accountant-a@example.test'),
  ('14710000-0000-4000-8000-000000000004','p47-owner-b@example.test');
insert into public.profiles(id,org_id,full_name,role) values
  ('14710000-0000-4000-8000-000000000001','14700000-0000-4000-8000-000000000001','P47 owner A','owner'),
  ('14710000-0000-4000-8000-000000000002','14700000-0000-4000-8000-000000000001','P47 office A','office'),
  ('14710000-0000-4000-8000-000000000003','14700000-0000-4000-8000-000000000001','P47 accountant A','accountant'),
  ('14710000-0000-4000-8000-000000000004','14700000-0000-4000-8000-000000000002','P47 owner B','owner');

insert into storage.objects(bucket_id,name,owner,owner_id,metadata)
select 'documents','14700000-0000-4000-8000-000000000001/p47/'||fixture.label||'.pdf',
  '14710000-0000-4000-8000-000000000001','14710000-0000-4000-8000-000000000001',
  jsonb_build_object('mimetype','application/pdf','size',256,'eTag',fixture.etag)
from (values
  ('baseline','1470000000000001'),('partial','1470000000000002'),
  ('long','1470000000000003'),('low','1470000000000004'),
  ('automatic','1470000000000005'),
  -- 0144 moved the automatic ceiling from 20 to 40. `ceiling` sits exactly on it and `long` sits
  -- one page past it, so the boundary is asserted from both sides. `partial-ceiling` is inside
  -- the ceiling but incompletely read -- the 21-40 page SCAN that the worker's paid-OCR cap of
  -- 20 pages still cannot finish, and which must therefore stay with a human.
  ('ceiling','1470000000000006'),('partial-ceiling','1470000000000007'))
  fixture(label,etag);

insert into public.documents(
  id,org_id,unit_id,entity_type,entity_id,storage_path,file_name,mime_type,
  document_kind,uploaded_by
)
select fixture.document_id,'14700000-0000-4000-8000-000000000001',:'p47_unit_id',
  'inbox',null,'14700000-0000-4000-8000-000000000001/p47/'||fixture.label||'.pdf',
  fixture.label||'.pdf','application/pdf','other','14710000-0000-4000-8000-000000000001'
from (values
  ('14720000-0000-4000-8000-000000000001'::uuid,'baseline'),
  ('14720000-0000-4000-8000-000000000002'::uuid,'partial'),
  ('14720000-0000-4000-8000-000000000003'::uuid,'long'),
  ('14720000-0000-4000-8000-000000000004'::uuid,'low'),
  ('14720000-0000-4000-8000-000000000005'::uuid,'automatic'),
  ('14720000-0000-4000-8000-000000000006'::uuid,'ceiling'),
  ('14720000-0000-4000-8000-000000000007'::uuid,'partial-ceiling')
) fixture(document_id,label);

insert into public.document_processing_jobs(
  id,org_id,document_id,requested_by,status,input_checksum,
  interpretation_actor_id,interpretation_started_at
)
select fixture.job_id,document.org_id,document.id,document.uploaded_by,'review',
  'etag:'||fixture.etag,document.uploaded_by,statement_timestamp()
from public.documents document
join (values
  ('14720000-0000-4000-8000-000000000001'::uuid,'14730000-0000-4000-8000-000000000001'::uuid,'1470000000000001'),
  ('14720000-0000-4000-8000-000000000002'::uuid,'14730000-0000-4000-8000-000000000002'::uuid,'1470000000000002'),
  ('14720000-0000-4000-8000-000000000003'::uuid,'14730000-0000-4000-8000-000000000003'::uuid,'1470000000000003'),
  ('14720000-0000-4000-8000-000000000004'::uuid,'14730000-0000-4000-8000-000000000004'::uuid,'1470000000000004'),
  ('14720000-0000-4000-8000-000000000005'::uuid,'14730000-0000-4000-8000-000000000005'::uuid,'1470000000000005'),
  ('14720000-0000-4000-8000-000000000006'::uuid,'14730000-0000-4000-8000-000000000006'::uuid,'1470000000000006'),
  ('14720000-0000-4000-8000-000000000007'::uuid,'14730000-0000-4000-8000-000000000007'::uuid,'1470000000000007')
) fixture(document_id,job_id,etag) on fixture.document_id=document.id;

insert into public.document_extractions(
  id,org_id,job_id,document_id,engine,model,model_version,input_checksum,
  contract_version,payload
)
select fixture.extraction_id,job.org_id,job.id,job.document_id,'p47','fixture','1',
  job.input_checksum,'1',pg_temp.p47_extraction(fixture.page_count,fixture.partial)
from public.document_processing_jobs job
join (values
  ('14730000-0000-4000-8000-000000000001'::uuid,'14740000-0000-4000-8000-000000000001'::uuid,4,false),
  ('14730000-0000-4000-8000-000000000002'::uuid,'14740000-0000-4000-8000-000000000002'::uuid,4,true),
  -- One page past the 0144 ceiling. Was 21 while the ceiling was 20; raising the ceiling without
  -- moving this fixture would have quietly turned the suite's over-length case into a passing one.
  ('14730000-0000-4000-8000-000000000003'::uuid,'14740000-0000-4000-8000-000000000003'::uuid,41,false),
  ('14730000-0000-4000-8000-000000000004'::uuid,'14740000-0000-4000-8000-000000000004'::uuid,4,false),
  ('14730000-0000-4000-8000-000000000005'::uuid,'14740000-0000-4000-8000-000000000005'::uuid,4,false),
  ('14730000-0000-4000-8000-000000000006'::uuid,'14740000-0000-4000-8000-000000000006'::uuid,40,false),
  ('14730000-0000-4000-8000-000000000007'::uuid,'14740000-0000-4000-8000-000000000007'::uuid,40,true)
) fixture(job_id,extraction_id,page_count,partial) on fixture.job_id=job.id;

insert into public.document_interpretations(
  id,org_id,job_id,extraction_id,document_id,interpreted_for_user_id,
  provider,model,prompt_version,schema_version,payload
)
select fixture.interpretation_id,extraction.org_id,extraction.job_id,extraction.id,
  extraction.document_id,'14710000-0000-4000-8000-000000000001',
  'p47','fixture','p47-v1','1',pg_temp.p47_interpretation(
    pg_temp.p47_manifest(fixture.page_count,fixture.confidence,fixture.confidence))
from public.document_extractions extraction
join (values
  ('14740000-0000-4000-8000-000000000001'::uuid,'14750000-0000-4000-8000-000000000001'::uuid,4,0.99::numeric),
  ('14740000-0000-4000-8000-000000000002'::uuid,'14750000-0000-4000-8000-000000000002'::uuid,4,0.99::numeric),
  ('14740000-0000-4000-8000-000000000003'::uuid,'14750000-0000-4000-8000-000000000003'::uuid,41,0.99::numeric),
  ('14740000-0000-4000-8000-000000000004'::uuid,'14750000-0000-4000-8000-000000000004'::uuid,4,0.89::numeric),
  ('14740000-0000-4000-8000-000000000005'::uuid,'14750000-0000-4000-8000-000000000005'::uuid,4,0.99::numeric),
  ('14740000-0000-4000-8000-000000000006'::uuid,'14750000-0000-4000-8000-000000000006'::uuid,40,0.99::numeric),
  ('14740000-0000-4000-8000-000000000007'::uuid,'14750000-0000-4000-8000-000000000007'::uuid,40,0.99::numeric)
) fixture(extraction_id,interpretation_id,page_count,confidence) on fixture.extraction_id=extraction.id;

-- Baseline is disabled even for a complete high-confidence packet.
select pg_temp.p47_actor(null,'service_role');
set role service_role;
select public.service_record_document_packet(
  '14730000-0000-4000-8000-000000000001','14750000-0000-4000-8000-000000000001',
  '14710000-0000-4000-8000-000000000001') as baseline_result
\gset p47_
reset role;
select pg_temp.p47_actor(null);

select pg_temp.p47_assert(
  :'p47_baseline_result'::jsonb @> '{"status":"needs_review","automatic_eligible":false,"idempotent":false}'::jsonb,
  'an existing organization auto-approved under the default-off baseline');

-- Turn the organization on at the documented floor. Partial, over-length and low confidence
-- remain human.
insert into public.org_autonomy_policies(org_id,policy_key,autonomy_enabled,min_confidence)
values('14700000-0000-4000-8000-000000000001','document.packet_split',true,0.900);

select pg_temp.p47_actor(null,'service_role');
set role service_role;
select public.service_record_document_packet(
  '14730000-0000-4000-8000-000000000002','14750000-0000-4000-8000-000000000002',
  '14710000-0000-4000-8000-000000000001');
select public.service_record_document_packet(
  '14730000-0000-4000-8000-000000000003','14750000-0000-4000-8000-000000000003',
  '14710000-0000-4000-8000-000000000001');
select public.service_record_document_packet(
  '14730000-0000-4000-8000-000000000004','14750000-0000-4000-8000-000000000004',
  '14710000-0000-4000-8000-000000000001');
select public.service_record_document_packet(
  '14730000-0000-4000-8000-000000000007','14750000-0000-4000-8000-000000000007',
  '14710000-0000-4000-8000-000000000001');
select public.service_record_document_packet(
  '14730000-0000-4000-8000-000000000006','14750000-0000-4000-8000-000000000006',
  '14710000-0000-4000-8000-000000000001') as ceiling_result
\gset p47_
select public.service_record_document_packet(
  '14730000-0000-4000-8000-000000000005','14750000-0000-4000-8000-000000000005',
  '14710000-0000-4000-8000-000000000001') as automatic_result
\gset p47_
select public.service_record_document_packet(
  '14730000-0000-4000-8000-000000000001','14750000-0000-4000-8000-000000000001',
  '14710000-0000-4000-8000-000000000001') as replay_result
\gset p47_
reset role;
select pg_temp.p47_actor(null);

select pg_temp.p47_assert(
  (select count(*)=4 and bool_and(status='needs_review')
   from public.document_packets where source_job_id in (
     '14730000-0000-4000-8000-000000000002',
     '14730000-0000-4000-8000-000000000003',
     '14730000-0000-4000-8000-000000000004',
     '14730000-0000-4000-8000-000000000007'))
  and :'p47_automatic_result'::jsonb @> '{"status":"approved","automatic_eligible":true}'::jsonb
  and :'p47_replay_result'::jsonb @> '{"idempotent":true}'::jsonb
  and (select count(*)=7 from public.document_packets
       where org_id='14700000-0000-4000-8000-000000000001'),
  'partial, over-length, low-confidence or idempotent record behavior drifted');

-- 0144 moved the automatic ceiling from 20 pages to 40, and moved NOTHING else. Both sides of the
-- new boundary are asserted, and so is the case the raised ceiling deliberately does not help: a
-- 40-page document the extraction did not finish reading. The worker's paid-OCR cap
-- (`ExtractionLimits.max_ai_pages`) stays at 20, so a scanned packet of 21-40 pages arrives here
-- with `partial = true` and must still reach a human.
select pg_temp.p47_assert(
  :'p47_ceiling_result'::jsonb @> '{"status":"approved","automatic_eligible":true}'::jsonb
  and (select page_count=40 and not source_partial and status='approved'
       from public.document_packets
       where source_job_id='14730000-0000-4000-8000-000000000006')
  and (select page_count=41 and not automatic_eligible and status='needs_review'
       from public.document_packets
       where source_job_id='14730000-0000-4000-8000-000000000003')
  and (select page_count=40 and source_partial and not automatic_eligible
         and status='needs_review'
       from public.document_packets
       where source_job_id='14730000-0000-4000-8000-000000000007'),
  '40 pages must be eligible, 41 must not, and a partial extraction must be refused inside the ceiling');

select id as baseline_packet_id,manifest_hash as baseline_hash
from public.document_packets where source_job_id='14730000-0000-4000-8000-000000000001'
\gset p47_

-- The persisted-row guard is deferred for replacement, but rejects an incomplete final state.
-- Pass the psql value to the DO block without interpolating it inside dollar quotes.
select set_config('p47.packet_id',:'p47_baseline_packet_id',false);
do $$
begin
  begin
    update public.document_packet_segments set start_page=4
    where packet_id=current_setting('p47.packet_id')::uuid and ordinal=2;
    set constraints document_packet_segments_manifest_guard immediate;
    raise exception 'P47 expected persisted manifest failure';
  exception when check_violation then null;
  end;
  set constraints document_packet_segments_manifest_guard deferred;
end
$$;

-- Accountant and another tenant cannot approve; stale context fails before replacement.
select pg_temp.p47_actor('14710000-0000-4000-8000-000000000003');
set role authenticated;
do $$ begin
  perform public.approve_document_packet(
    current_setting('p47.packet_id')::uuid,repeat('0',64),pg_temp.p47_manifest(4,0.99,0.99),'P47 accountant');
  raise exception 'P47 accountant approval unexpectedly succeeded';
exception when insufficient_privilege then null; end $$;
reset role;

select pg_temp.p47_actor('14710000-0000-4000-8000-000000000004');
set role authenticated;
do $$ begin
  perform public.approve_document_packet(
    current_setting('p47.packet_id')::uuid,repeat('0',64),pg_temp.p47_manifest(4,0.99,0.99),'P47 other tenant');
  raise exception 'P47 cross-tenant approval unexpectedly succeeded';
exception when no_data_found then null; end $$;
reset role;

select pg_temp.p47_actor('14710000-0000-4000-8000-000000000001');
set role authenticated;
do $$ begin
  perform public.approve_document_packet(
    current_setting('p47.packet_id')::uuid,repeat('0',64),pg_temp.p47_manifest(4,0.99,0.99),'P47 stale');
  raise exception 'P47 stale approval unexpectedly succeeded';
exception when serialization_failure then null; end $$;
select public.approve_document_packet(
  :'p47_baseline_packet_id',:'p47_baseline_hash',pg_temp.p47_manifest(4,0.98,0.99),
  'P47 owner reviewed packet') as approved_result
\gset p47_
reset role;
select pg_temp.p47_actor(null);

select manifest_hash as approved_hash from public.document_packets
where id=:'p47_baseline_packet_id'
\gset p47_

-- Office has the same decision authority on a separate needs-review packet.
select id as partial_packet_id,manifest_hash as partial_hash
from public.document_packets where source_job_id='14730000-0000-4000-8000-000000000002'
\gset p47_
select pg_temp.p47_actor('14710000-0000-4000-8000-000000000002');
set role authenticated;
select public.approve_document_packet(
  :'p47_partial_packet_id',:'p47_partial_hash',pg_temp.p47_manifest(4,0.99,0.99),
  'P47 office reviewed packet');
reset role;
select pg_temp.p47_actor(null);

select pg_temp.p47_assert(
  (select approved_by='14710000-0000-4000-8000-000000000001' and status='approved'
   from public.document_packets where id=:'p47_baseline_packet_id')
  and (select approved_by='14710000-0000-4000-8000-000000000002' and status='approved'
   from public.document_packets where id=:'p47_partial_packet_id'),
  'owner/office approval boundary or reviewed actor ledger drifted');

-- Materialization is also stale-hash fenced.
select pg_temp.p47_actor(null,'service_role');
set role service_role;
do $$ begin
  perform public.service_materialize_document_packet(
    current_setting('p47.packet_id')::uuid,repeat('0',64),
    '14710000-0000-4000-8000-000000000001');
  raise exception 'P47 stale materialization unexpectedly succeeded';
exception when serialization_failure then null; end $$;
reset role;
select pg_temp.p47_actor(null);

-- The Edge function has uploaded one deterministic PDF per segment, as service_role (no owner).
insert into storage.objects(bucket_id,name,metadata)
select 'documents','14700000-0000-4000-8000-000000000001/document-segments/'||
  '14720000-0000-4000-8000-000000000001/'||segment.id||'.pdf',
  jsonb_build_object('mimetype','application/pdf','size',128,
    'eTag',case segment.ordinal when 1 then '1471111111111111' else '1472222222222222' end)
from public.document_packet_segments segment
where segment.packet_id=:'p47_baseline_packet_id';

select pg_temp.p47_actor(null,'service_role');
set role service_role;
select public.service_materialize_document_packet(
  :'p47_baseline_packet_id',:'p47_approved_hash','14710000-0000-4000-8000-000000000001')
  as materialized_result
\gset p47_
select public.service_materialize_document_packet(
  :'p47_baseline_packet_id',:'p47_approved_hash','14710000-0000-4000-8000-000000000001')
  as materialized_replay
\gset p47_
reset role;
select pg_temp.p47_actor(null);

select pg_temp.p47_assert(
  :'p47_materialized_result'::jsonb @> '{"status":"materialized","segment_count":2,"idempotent":false}'::jsonb
  and :'p47_materialized_replay'::jsonb @> '{"status":"materialized","idempotent":true}'::jsonb
  and (select count(*)=2 and bool_and(child_document_id is not null)
       and count(distinct storage_path)=2
       from public.document_packet_segments where packet_id=:'p47_baseline_packet_id')
  and (select count(*)=2 from public.documents
       where storage_path like '14700000-0000-4000-8000-000000000001/document-segments/%')
  and (select count(*)=2 from public.document_processing_jobs job
       join public.document_packet_segments segment on segment.child_document_id=job.document_id
       where segment.packet_id=:'p47_baseline_packet_id')
  and (select status='completed' from public.document_processing_jobs
       where id='14730000-0000-4000-8000-000000000001')
  and (select entity_type='inbox' and entity_id is null and document_kind='other'
       from public.documents where id='14720000-0000-4000-8000-000000000001')
  and not exists(select 1 from public.invoices
       where org_id='14700000-0000-4000-8000-000000000001'),
  'materialization duplicated children/jobs, changed the parent or created a financial row');

select pg_temp.p47_assert(
  (select bool_and(private.document_processing_current_checksum(job)=job.input_checksum)
   from public.document_processing_jobs job
   join public.document_packet_segments segment on segment.child_document_id=job.document_id
   where segment.packet_id=:'p47_baseline_packet_id'),
  'a service-owned child without Storage owner failed checksum verification');

select pg_temp.p47_assert(
  not exists(select 1 from private.scope_enforcement_violations())
  and not exists(select 1 from private.tenant_export_registry_violations()),
  'A1/A3/A5/A6 scope or export registries drifted');

select 'P47 mixed document packet suite passed' as result;

rollback;
