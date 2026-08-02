-- Disposable local acceptance fixture. The caller has already uploaded the six source
-- objects and registered their documents through prepare-browser-fixture.cjs.
\set ON_ERROR_STOP on

begin;

select p.id::text as owner_id
from public.profiles p
join auth.users u on u.id = p.id
where p.org_id = '11111111-1111-4111-8111-111111111111'
  and p.role = 'owner'
  and u.email = 'owner@demo.supplyflow.local'
\gset ocr_

create function pg_temp.ocr_cell(p_text text)
returns jsonb language sql immutable as $$
  select jsonb_build_object('text', p_text, 'bbox', null)
$$;

create function pg_temp.ocr_extraction_payload(p_title text)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'schema_version', '1',
    'document', jsonb_build_object(
      'page_count', 1,
      'detected_languages', jsonb_build_array('he', 'en'),
      'plain_text', p_title || E'\nחשבונית INV-2026-1042\nמשקאות אור בע״מ\nלתשלום 745.60 ₪',
      'partial', false
    ),
    'blocks', jsonb_build_array(
      jsonb_build_object(
        'id', 'block-heading', 'page', 1, 'type', 'heading',
        'bbox', jsonb_build_array(0.05, 0.05, 0.48, 0.13),
        'text', 'חשבונית INV-2026-1042', 'confidence', 0.98
      ),
      jsonb_build_object(
        'id', 'block-total', 'page', 1, 'type', 'text',
        'bbox', jsonb_build_array(0.58, 0.61, 0.94, 0.69),
        'text', 'לתשלום 745.60 ₪', 'confidence', 0.93
      )
    ),
    'tables', jsonb_build_array(jsonb_build_object(
      'id', 'table-lines', 'page', 1,
      'bbox', jsonb_build_array(0.04, 0.25, 0.96, 0.55),
      'rows', jsonb_build_array(
        jsonb_build_array(pg_temp.ocr_cell('מק״ט'), pg_temp.ocr_cell('תיאור'), pg_temp.ocr_cell('מחיר')),
        jsonb_build_array(pg_temp.ocr_cell('DRK-001'), pg_temp.ocr_cell('קולה 1.5 ל׳'), pg_temp.ocr_cell('42.50')),
        jsonb_build_array(pg_temp.ocr_cell('DRK-002'), pg_temp.ocr_cell('מים מינרליים'), pg_temp.ocr_cell('31.00'))
      )
    )),
    'marks', jsonb_build_array(jsonb_build_object(
      'id', 'mark-circle', 'page', 1, 'kind', 'circle',
      'bbox', jsonb_build_array(0.55, 0.60, 0.91, 0.70),
      'nearby_block_ids', jsonb_build_array('block-total'),
      'confidence', 0.94, 'fingerprint', 'ocr-acceptance-circle-v1'
    ))
  )
$$;

create function pg_temp.ocr_interpretation_payload()
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'schema_version', '1',
    'document_type', 'invoice',
    'document_type_confidence', 0.98,
    'supplier', jsonb_build_object(
      'suggested_id', 'aa000000-0000-4000-8000-000000000008',
      'suggested_name', 'משקאות אור בע״מ',
      'confidence', 0.95,
      'evidence_block_ids', jsonb_build_array('block-heading')
    ),
    'fields', jsonb_build_array(
      jsonb_build_object('key', 'invoice_number', 'value', 'INV-2026-1042', 'confidence', 0.97, 'evidence_block_ids', jsonb_build_array('block-heading')),
      jsonb_build_object('key', 'total', 'value', 745.60, 'confidence', 0.93, 'evidence_block_ids', jsonb_build_array('block-total'))
    ),
    'line_items', jsonb_build_array(
      jsonb_build_object('source_row', 1, 'values', jsonb_build_object('sku', 'DRK-001', 'description', 'קולה 1.5 ל׳', 'unit_price', 42.50), 'evidence_block_ids', jsonb_build_array('block-total')),
      jsonb_build_object('source_row', 2, 'values', jsonb_build_object('sku', 'DRK-002', 'description', 'מים מינרליים', 'unit_price', 31.00), 'evidence_block_ids', jsonb_build_array('block-total'))
    ),
    'suggested_annotations', jsonb_build_array(jsonb_build_object(
      'tag_key', 'manager_review',
      'label', 'סכום שסומן לבדיקה',
      'target_block_ids', jsonb_build_array('block-total'),
      'evidence_mark_ids', jsonb_build_array('mark-circle'),
      'confidence', 0.92
    ))
  )
$$;

-- Six truthful stages: no job, queued, leased (displayed as processing), review,
-- completed and failed.
insert into public.document_processing_jobs (
  id, org_id, document_id, requested_by, status, input_checksum
)
select
  '97100000-0000-4000-8000-000000000002', d.org_id, d.id, :'ocr_owner_id',
  'queued', public.smart_document_source_checksum(d.org_id, d.storage_path, d.mime_type, d.uploaded_by)
from public.documents d where d.id = '97000000-0000-4000-8000-000000000002';

insert into public.document_processing_jobs (
  id, org_id, document_id, requested_by, status, input_checksum, lease_owner, lease_until
)
select
  '97100000-0000-4000-8000-000000000003', d.org_id, d.id, :'ocr_owner_id',
  'leased', public.smart_document_source_checksum(d.org_id, d.storage_path, d.mime_type, d.uploaded_by),
  'ocr-acceptance-worker', now() + interval '10 minutes'
from public.documents d where d.id = '97000000-0000-4000-8000-000000000003';

insert into public.document_processing_jobs (
  id, org_id, document_id, requested_by, status, input_checksum,
  interpretation_actor_id, interpretation_started_at
)
select
  '97100000-0000-4000-8000-000000000004', d.org_id, d.id, :'ocr_owner_id',
  'review', public.smart_document_source_checksum(d.org_id, d.storage_path, d.mime_type, d.uploaded_by),
  :'ocr_owner_id', now()
from public.documents d where d.id = '97000000-0000-4000-8000-000000000004';

insert into public.document_processing_jobs (
  id, org_id, document_id, requested_by, status, input_checksum,
  interpretation_actor_id, interpretation_started_at
)
select
  '97100000-0000-4000-8000-000000000005', d.org_id, d.id, :'ocr_owner_id',
  'completed', public.smart_document_source_checksum(d.org_id, d.storage_path, d.mime_type, d.uploaded_by),
  :'ocr_owner_id', now()
from public.documents d where d.id = '97000000-0000-4000-8000-000000000005';

insert into public.document_processing_jobs (
  id, org_id, document_id, requested_by, status, input_checksum,
  last_error_code, last_error_message
)
select
  '97100000-0000-4000-8000-000000000006', d.org_id, d.id, :'ocr_owner_id',
  'failed', public.smart_document_source_checksum(d.org_id, d.storage_path, d.mime_type, d.uploaded_by),
  'fixture_ocr_timeout', 'חריגת זמן מקומית שנזרעה לבדיקת מצב כשל'
from public.documents d where d.id = '97000000-0000-4000-8000-000000000006';

insert into public.document_extractions (
  id, org_id, job_id, document_id, engine, model, model_version,
  input_checksum, contract_version, payload, duration_ms, resource_metadata
)
select
  '97200000-0000-4000-8000-000000000004'::uuid, j.org_id, j.id, j.document_id,
  'private-fixture', 'ocr-acceptance-hebrew', '1.0.0', j.input_checksum, j.contract_version,
  pg_temp.ocr_extraction_payload('חשבונית עברית לבדיקת review'), 842,
  jsonb_build_object('fixture', true, 'source', 'local-storage')
from public.document_processing_jobs j where j.id = '97100000-0000-4000-8000-000000000004'
union all
select
  '97200000-0000-4000-8000-000000000005'::uuid, j.org_id, j.id, j.document_id,
  'private-fixture', 'ocr-acceptance-hebrew', '1.0.0', j.input_checksum, j.contract_version,
  pg_temp.ocr_extraction_payload('חשבונית עברית שהושלמה'), 801,
  jsonb_build_object('fixture', true, 'source', 'local-storage')
from public.document_processing_jobs j where j.id = '97100000-0000-4000-8000-000000000005';

insert into public.document_interpretations (
  id, org_id, job_id, extraction_id, document_id, interpreted_for_user_id,
  provider, model, prompt_version, schema_version, payload, usage, duration_ms
)
values
  (
    '97300000-0000-4000-8000-000000000004', '11111111-1111-4111-8111-111111111111',
    '97100000-0000-4000-8000-000000000004', '97200000-0000-4000-8000-000000000004',
    '97000000-0000-4000-8000-000000000004', :'ocr_owner_id',
    'openai-fixture', 'gpt-local-contract-fixture', 'ocr-acceptance-v1', '1',
    pg_temp.ocr_interpretation_payload(), jsonb_build_object('fixture', true), 315
  ),
  (
    '97300000-0000-4000-8000-000000000005', '11111111-1111-4111-8111-111111111111',
    '97100000-0000-4000-8000-000000000005', '97200000-0000-4000-8000-000000000005',
    '97000000-0000-4000-8000-000000000005', :'ocr_owner_id',
    'openai-fixture', 'gpt-local-contract-fixture', 'ocr-acceptance-v1', '1',
    pg_temp.ocr_interpretation_payload(), jsonb_build_object('fixture', true), 302
  );

insert into public.document_annotations (
  id, org_id, interpretation_id, extraction_id, document_id,
  target_kind, target_id, tag_key, label, source, confidence, evidence_mark_ids
)
values (
  '97400000-0000-4000-8000-000000000004', '11111111-1111-4111-8111-111111111111',
  '97300000-0000-4000-8000-000000000004', '97200000-0000-4000-8000-000000000004',
  '97000000-0000-4000-8000-000000000004',
  'block', 'block-total', 'manager_review', 'הצעה אוטומטית: לבדוק את הסכום המסומן',
  'claude', 0.92, array['mark-circle']
);

select set_config('request.jwt.claim.sub', :'ocr_owner_id', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select public.propose_document_export_template(
  null,
  jsonb_build_object(
    'schema_version', '1',
    'name', 'חשבונית — בדיקת OCR מקומית',
    'format', 'table',
    'scope', jsonb_build_object('document_type', 'invoice', 'supplier_id', null, 'user_id', null),
    'columns', jsonb_build_array(
      jsonb_build_object('key', 'invoice_number', 'label', 'מספר חשבונית', 'source_path', 'fields.invoice_number', 'type', 'text', 'required', true),
      jsonb_build_object('key', 'sku', 'label', 'מק״ט', 'source_path', 'line_items.values.sku', 'type', 'text', 'required', true),
      jsonb_build_object('key', 'unit_price', 'label', 'מחיר יחידה', 'source_path', 'line_items.values.unit_price', 'type', 'number', 'required', true)
    )
  ),
  'fixture מקומי לבדיקת export'
) as export_version_id
\gset ocr_
select public.approve_document_export_template_version(
  :'ocr_export_version_id', 'אישור מקומי לבדיקת הקבלה'
);
reset role;

do $$
declare
  v_stage_count integer;
  v_column_count integer;
begin
  select count(*) into v_stage_count
  from (
    select 'unprocessed' where not exists (
      select 1 from public.document_processing_jobs
      where document_id = '97000000-0000-4000-8000-000000000001'
    )
    union all
    select status from public.document_processing_jobs
    where document_id in (
      '97000000-0000-4000-8000-000000000002',
      '97000000-0000-4000-8000-000000000003',
      '97000000-0000-4000-8000-000000000004',
      '97000000-0000-4000-8000-000000000005',
      '97000000-0000-4000-8000-000000000006'
    )
  ) stages;

  select jsonb_array_length(v.contract -> 'columns') into v_column_count
  from public.document_export_template_versions v
  where v.contract ->> 'name' = 'חשבונית — בדיקת OCR מקומית'
    and v.approved_at is not null;

  if v_stage_count <> 6 then
    raise exception 'OCR browser fixture does not contain six gallery stages';
  end if;
  if v_column_count <> 3 then
    raise exception 'OCR browser fixture export does not contain three columns';
  end if;
end
$$;

commit;

select 'ocr_browser_fixture_ready' as result;
