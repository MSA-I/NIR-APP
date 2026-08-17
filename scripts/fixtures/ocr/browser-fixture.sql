-- Disposable local acceptance fixture. The caller has already uploaded the seven source
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

create function pg_temp.ocr_price_list_payload()
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'schema_version', '1',
    'document_type', 'price_list',
    'document_type_confidence', 0.99,
    'supplier', jsonb_build_object(
      'suggested_id', 'aa000000-0000-4000-8000-000000000008',
      'suggested_name', 'משקאות אור בע״מ',
      'confidence', 0.99,
      'evidence_block_ids', jsonb_build_array('block-heading')
    ),
    'fields', '[]'::jsonb,
    'line_items', jsonb_build_array(
      jsonb_build_object(
        'source_row', 1,
        'values', jsonb_build_object(
          'sku', 'OCR-BROWSER-EXISTING-20260807',
          'product_name', 'מוצר קיים לבדיקת מחירון',
          'unit', 'אריזה',
          'unit_price', 12.50
        ),
        'evidence_block_ids', jsonb_build_array('block-total')
      ),
      jsonb_build_object(
        'source_row', 2,
        'values', jsonb_build_object(
          'sku', 'OCR-BROWSER-NEW-20260807',
          'barcode', '7290999000077',
          'product_name', 'מיץ תפוזים חדש מהמחירון',
          'unit', 'אריזה',
          'unit_price', 18.75
        ),
        'evidence_block_ids', jsonb_build_array('block-total')
      ),
      jsonb_build_object(
        'source_row', 3,
        'values', jsonb_build_object(
          'product_name', 'מוצר בלי מק״ט או ברקוד',
          'unit_price', 7.00
        ),
        'evidence_block_ids', jsonb_build_array('block-total')
      )
    ),
    'suggested_annotations', '[]'::jsonb
  )
$$;

create function pg_temp.ocr_manual_price_list_payload()
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'schema_version','1','document_type','price_list','document_type_confidence',0.99,
    'supplier',jsonb_build_object(
      'suggested_id','aa000000-0000-4000-8000-000000000008',
      'suggested_name','משקאות אור בע״מ','confidence',0.99,
      'evidence_block_ids',jsonb_build_array('block-heading')),
    'fields','[]'::jsonb,
    'line_items',(select jsonb_agg(jsonb_build_object(
      'source_row',row_number,
      'values',jsonb_build_object(
        'sku','OCR-MANUAL-'||lpad(row_number::text,2,'0'),
        'product_name','מוצר מחירון לבדיקה '||row_number,
        'unit','אריזה','unit_price',10+row_number),
      'evidence_block_ids',jsonb_build_array('block-total')) order by row_number)
      from generate_series(1,22) row_number),
    'suggested_annotations','[]'::jsonb)
$$;

create function pg_temp.ocr_packet_payload()
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'schema_version','1','document_type','other','document_type_confidence',0.99,
    'supplier',jsonb_build_object('suggested_id',null,'suggested_name',null,
      'confidence',null,'evidence_block_ids','[]'::jsonb),
    'fields','[]'::jsonb,'line_items','[]'::jsonb,'suggested_annotations','[]'::jsonb,
    'packet_segments',jsonb_build_array(
      jsonb_build_object('ordinal',1,'start_page',1,'end_page',2,
        'document_type','delivery_note','confidence',0.94),
      jsonb_build_object('ordinal',2,'start_page',3,'end_page',4,
        'document_type','invoice','confidence',0.96)))
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

insert into public.document_processing_jobs (
  id, org_id, document_id, requested_by, status, input_checksum,
  interpretation_actor_id, interpretation_started_at
)
select
  '97100000-0000-4000-8000-000000000007', d.org_id, d.id, :'ocr_owner_id',
  'review', public.smart_document_source_checksum(d.org_id, d.storage_path, d.mime_type, d.uploaded_by),
  :'ocr_owner_id', now()
from public.documents d where d.id = '97000000-0000-4000-8000-000000000007';

insert into public.document_processing_jobs (
  id, org_id, document_id, requested_by, status, input_checksum,
  interpretation_actor_id, interpretation_started_at
)
select fixture.job_id,d.org_id,d.id,:'ocr_owner_id','review',
  public.smart_document_source_checksum(d.org_id,d.storage_path,d.mime_type,d.uploaded_by),
  :'ocr_owner_id',now()
from public.documents d
join (values
  ('97000000-0000-4000-8000-000000000008'::uuid,'97100000-0000-4000-8000-000000000008'::uuid),
  ('97000000-0000-4000-8000-000000000009'::uuid,'97100000-0000-4000-8000-000000000009'::uuid)
) fixture(document_id,job_id) on fixture.document_id=d.id;

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

-- One real partial price-list decision: update an existing product, create one keyed product,
-- and leave the unkeyed row waiting. This is intentionally outside the six gallery stage fixtures.
insert into public.products (id, org_id, name, unit, sku)
values (
  '97700000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  'מוצר קיים לבדיקת מחירון', 'אריזה', 'OCR-BROWSER-PRODUCT-20260807'
);

insert into public.supplier_products (
  id, org_id, supplier_id, product_id, current_price,
  price_effective_date, available, supplier_sku
) values (
  '97800000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  'aa000000-0000-4000-8000-000000000008',
  '97700000-0000-4000-8000-000000000001',
  10, current_date - 30, true, 'OCR-BROWSER-EXISTING-20260807'
);

insert into public.document_extractions (
  id, org_id, job_id, document_id, engine, model, model_version,
  input_checksum, contract_version, payload, duration_ms, resource_metadata
)
select
  '97200000-0000-4000-8000-000000000007'::uuid, j.org_id, j.id, j.document_id,
  'private-fixture', 'ocr-acceptance-hebrew', '1.0.0', j.input_checksum, j.contract_version,
  pg_temp.ocr_extraction_payload('מחירון ספק עם מוצר חדש'), 811,
  jsonb_build_object('fixture', true, 'source', 'local-storage')
from public.document_processing_jobs j where j.id = '97100000-0000-4000-8000-000000000007';

insert into public.document_interpretations (
  id, org_id, job_id, extraction_id, document_id, interpreted_for_user_id,
  provider, model, prompt_version, schema_version, payload, usage, duration_ms
)
values (
  '97300000-0000-4000-8000-000000000007', '11111111-1111-4111-8111-111111111111',
  '97100000-0000-4000-8000-000000000007', '97200000-0000-4000-8000-000000000007',
  '97000000-0000-4000-8000-000000000007', :'ocr_owner_id',
  'openai-fixture', 'gpt-local-contract-fixture', 'interpret-document-v6', '1',
  pg_temp.ocr_price_list_payload(), jsonb_build_object('fixture', true), 304
);

insert into public.document_extractions (
  id,org_id,job_id,document_id,engine,model,model_version,input_checksum,
  contract_version,payload,duration_ms,resource_metadata
)
select fixture.extraction_id,j.org_id,j.id,j.document_id,
  'private-fixture','ocr-acceptance-hebrew','1.0.0',j.input_checksum,j.contract_version,
  pg_temp.ocr_extraction_payload(fixture.title),700,
  jsonb_build_object('fixture',true,'source','local-storage')
from public.document_processing_jobs j
join (values
  ('97100000-0000-4000-8000-000000000008'::uuid,'97200000-0000-4000-8000-000000000008'::uuid,'מחירון ידני עם 22 שורות'),
  ('97100000-0000-4000-8000-000000000009'::uuid,'97200000-0000-4000-8000-000000000009'::uuid,'חבילת מסמכים מעורבת')
) fixture(job_id,extraction_id,title) on fixture.job_id=j.id;

insert into public.document_interpretations (
  id,org_id,job_id,extraction_id,document_id,interpreted_for_user_id,
  provider,model,prompt_version,schema_version,payload,usage,duration_ms
) values
(
  '97300000-0000-4000-8000-000000000008','11111111-1111-4111-8111-111111111111',
  '97100000-0000-4000-8000-000000000008','97200000-0000-4000-8000-000000000008',
  '97000000-0000-4000-8000-000000000008',:'ocr_owner_id',
  'openai-fixture','gpt-local-contract-fixture','interpret-document-v11','1',
  pg_temp.ocr_manual_price_list_payload(),jsonb_build_object('fixture',true),301
),
(
  '97300000-0000-4000-8000-000000000009','11111111-1111-4111-8111-111111111111',
  '97100000-0000-4000-8000-000000000009','97200000-0000-4000-8000-000000000009',
  '97000000-0000-4000-8000-000000000009',:'ocr_owner_id',
  'openai-fixture','gpt-local-contract-fixture','interpret-document-v11','1',
  pg_temp.ocr_packet_payload(),jsonb_build_object('fixture',true),302
);

insert into public.document_packets(
  id,org_id,parent_document_id,source_job_id,source_interpretation_id,page_count,
  source_partial,confidence_threshold,automatic_eligible,status,manifest_hash,created_by
) values(
  '97400000-0000-4000-8000-000000000009','11111111-1111-4111-8111-111111111111',
  '97000000-0000-4000-8000-000000000009','97100000-0000-4000-8000-000000000009',
  '97300000-0000-4000-8000-000000000009',4,false,0.900,false,'needs_review',repeat('a',64),
  :'ocr_owner_id'
);
insert into public.document_packet_segments(
  id,org_id,packet_id,ordinal,start_page,end_page,document_type,confidence
) values
  ('97500000-0000-4000-8000-000000000091','11111111-1111-4111-8111-111111111111',
   '97400000-0000-4000-8000-000000000009',1,1,2,'delivery_note',0.94),
  ('97500000-0000-4000-8000-000000000092','11111111-1111-4111-8111-111111111111',
   '97400000-0000-4000-8000-000000000009',2,3,4,'invoice',0.96);

insert into public.org_autonomy_policies (
  org_id, policy_key, autonomy_enabled, min_confidence
) values (
  '11111111-1111-4111-8111-111111111111', 'price_list.intake', true, 0.900
)
on conflict (org_id, policy_key) do update
set autonomy_enabled = excluded.autonomy_enabled,
    min_confidence = excluded.min_confidence;

select set_config('request.jwt.claim.role', 'service_role', true);
-- The legacy writer is deliberately revoked from service_role by the calibrated
-- automation boundary. This fixture seeds a historical auto-applied result as the
-- database owner so the browser can render that terminal state; runtime automation
-- reaches the writer only through apply_eligible_price_list_interpretation().
set local role postgres;
select public.apply_price_list_interpretation(
  '97100000-0000-4000-8000-000000000007',
  '97300000-0000-4000-8000-000000000007',
  null
);
reset role;

-- The shadow prediction behind the MANUAL price-list document (22 rows): twenty rows the server
-- matched by SKU to a catalogue product at a readable price, and two it could not. This is the
-- state every real price list reaches — `run_price_list_shadow` records it whether or not the
-- calibrated scope lets the automation act — and it is what the confirmation screen prefills from.
-- Without it the browser scenario would only ever see the "no stored prediction" fallback.
set local role postgres;
insert into public.products (id, org_id, name, unit, sku)
select
  ('97710000-0000-4000-8000-0000000000' || lpad(row_number::text, 2, '0'))::uuid,
  '11111111-1111-4111-8111-111111111111',
  'מוצר מחירון לבדיקה ' || row_number, 'אריזה',
  'OCR-MANUAL-' || lpad(row_number::text, 2, '0')
from generate_series(1, 20) row_number;

select set_config('app.price_list_shadow_writer', 'run', true);

insert into public.price_list_shadow_runs (
  id, org_id, document_id, job_id, extraction_id, interpretation_id, actor_id, supplier_id,
  evaluator_version, policy_configured, live_policy_enabled, policy_kill_switch,
  evaluated_min_confidence, decision_confidence, predicted_outcome, reason_code,
  applicable_count, waiting_count, would_create_product_count,
  provider, model, prompt_version, schema_version, document_format,
  extraction_engine, extraction_model, extraction_model_version,
  page_count, block_count, table_count, interpreted_line_count, layout_signature
) values (
  '97900000-0000-4000-8000-000000000008', '11111111-1111-4111-8111-111111111111',
  '97000000-0000-4000-8000-000000000008', '97100000-0000-4000-8000-000000000008',
  '97200000-0000-4000-8000-000000000008', '97300000-0000-4000-8000-000000000008',
  :'ocr_owner_id', 'aa000000-0000-4000-8000-000000000008',
  'fixture-shadow-v1', true, true, false,
  0.900, 0.990, 'partially_applicable', 'shadow_scope_not_eligible',
  20, 2, 0,
  'openai-fixture', 'gpt-local-contract-fixture', 'interpret-document-v11', '1', 'application/pdf',
  'private-fixture', 'ocr-acceptance-hebrew', '1.0.0',
  1, 3, 1, 22, repeat('b', 64)
);

insert into public.price_list_shadow_lines (
  id, org_id, shadow_run_id, document_id, interpretation_id, line_index, source_row,
  predicted_action, reason_code, matched_by, product_id, sku, product_name, unit,
  proposed_unit_price, product_would_be_created
)
select
  ('97910000-0000-4000-8000-0000000000' || lpad(row_number::text, 2, '0'))::uuid,
  '11111111-1111-4111-8111-111111111111',
  '97900000-0000-4000-8000-000000000008',
  '97000000-0000-4000-8000-000000000008',
  '97300000-0000-4000-8000-000000000008',
  row_number - 1, row_number,
  case when row_number <= 20 then 'apply_existing_price' else 'review' end,
  case row_number
    when 21 then 'line_product_unmatched'
    when 22 then 'line_price_unreadable'
    else null end,
  case when row_number <= 20 then 'sku' else null end,
  case when row_number <= 20
       then ('97710000-0000-4000-8000-0000000000' || lpad(row_number::text, 2, '0'))::uuid
       else null end,
  case when row_number <= 20 then 'OCR-MANUAL-' || lpad(row_number::text, 2, '0') else null end,
  'מוצר מחירון לבדיקה ' || row_number, 'אריזה',
  case when row_number <= 20 then 10 + row_number else null end,
  false
from generate_series(1, 22) row_number;

select set_config('app.price_list_shadow_writer', '', true);
reset role;

-- An approved type decision on the review document. Without one the review screen never reaches
-- the state where a classified invoice can be drafted, so the draft path would go unexercised.
insert into public.document_type_review_decisions (
  org_id, interpretation_id, extraction_id, document_id, revision,
  decision, suggested_document_type, approved_document_type,
  input_checksum, contract_version, actor_id, reason
)
select
  i.org_id, i.id, i.extraction_id, i.document_id, 1,
  'approved', 'invoice', 'invoice',
  e.input_checksum, e.contract_version, :'ocr_owner_id',
  'אושר בפיקסטורת הקבלה כדי לאפשר בדיקת טיוטת חשבונית'
from public.document_interpretations i
join public.document_extractions e on e.org_id = i.org_id and e.id = i.extraction_id
where i.id = '97300000-0000-4000-8000-000000000004';

-- The same interpretation approved as a delivery note on the other document, so the receiving
-- draft has a document to start from. Approved directly rather than through review_document_type:
-- this document's job is 'completed', and the RPC rightly refuses to decide outside review.
insert into public.document_type_review_decisions (
  org_id, interpretation_id, extraction_id, document_id, revision,
  decision, suggested_document_type, approved_document_type,
  input_checksum, contract_version, actor_id, reason
)
select
  i.org_id, i.id, i.extraction_id, i.document_id, 1,
  'approved', 'invoice', 'delivery_note',
  e.input_checksum, e.contract_version, :'ocr_owner_id',
  'תוקן בפיקסטורת הקבלה לתעודת משלוח כדי לאפשר בדיקת קליטת סחורה'
from public.document_interpretations i
join public.document_extractions e on e.org_id = i.org_id and e.id = i.extraction_id
where i.id = '97300000-0000-4000-8000-000000000005';

-- A third document for the credit-note draft. One document carries one decision ledger, and the
-- other two are spoken for: 0004 is the invoice draft, 0005 the delivery note.
insert into public.document_extractions (
  id, org_id, job_id, document_id, engine, model, model_version,
  input_checksum, contract_version, payload, duration_ms, resource_metadata
)
select
  '97200000-0000-4000-8000-000000000003'::uuid, j.org_id, j.id, j.document_id,
  'private-fixture', 'ocr-acceptance-hebrew', '1.0.0', j.input_checksum, j.contract_version,
  pg_temp.ocr_extraction_payload('חשבונית זיכוי עברית'), 790,
  jsonb_build_object('fixture', true, 'source', 'local-storage')
from public.document_processing_jobs j where j.id = '97100000-0000-4000-8000-000000000003';

insert into public.document_interpretations (
  id, org_id, job_id, extraction_id, document_id, interpreted_for_user_id,
  provider, model, prompt_version, schema_version, payload, usage, duration_ms
)
values (
  '97300000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111',
  '97100000-0000-4000-8000-000000000003', '97200000-0000-4000-8000-000000000003',
  '97000000-0000-4000-8000-000000000003', :'ocr_owner_id',
  'openai-fixture', 'gpt-local-contract-fixture', 'ocr-acceptance-v1', '1',
  pg_temp.ocr_interpretation_payload(), jsonb_build_object('fixture', true), 288
);

insert into public.document_type_review_decisions (
  org_id, interpretation_id, extraction_id, document_id, revision,
  decision, suggested_document_type, approved_document_type,
  input_checksum, contract_version, actor_id, reason
)
select
  i.org_id, i.id, i.extraction_id, i.document_id, 1,
  'approved', 'invoice', 'credit_note',
  e.input_checksum, e.contract_version, :'ocr_owner_id',
  'תוקן בפיקסטורת הקבלה לחשבונית זיכוי כדי לאפשר בדיקת דרישת זיכוי'
from public.document_interpretations i
join public.document_extractions e on e.org_id = i.org_id and e.id = i.extraction_id
where i.id = '97300000-0000-4000-8000-000000000003';

-- The invoice the credit note refers to, by the number the fixture interpretation carries. It
-- lives here and not in the demo seed on purpose: this file is applied after the last database
-- reset and after every SQL gate and preflight, so the row exists only for the browser run and
-- cannot move a financial assertion. Exactly one must match -- the draft refuses to guess between
-- two invoices sharing a number, and that refusal is asserted in the browser check.
insert into public.invoices (
  org_id, supplier_id, invoice_number, invoice_date, received_by,
  amount_before_vat, vat_amount, total_amount, notes
) values (
  '11111111-1111-4111-8111-111111111111', 'aa000000-0000-4000-8000-000000000008',
  'INV-2026-1042', current_date - 7, :'ocr_owner_id',
  632.71, 112.89, 745.60, 'חשבונית פיקסטורה לבדיקת דרישת זיכוי מסריקה'
);

-- A fourth document for the payment-confirmation panel, plus the payment it confirms. The panel
-- reconciles rather than executes: review is an owner/office task while payment execution belongs
-- to the accountant. What is exercised here is the match, which
-- is the only thing a reviewer on this screen can actually act on.
insert into public.document_extractions (
  id, org_id, job_id, document_id, engine, model, model_version,
  input_checksum, contract_version, payload, duration_ms, resource_metadata
)
select
  '97200000-0000-4000-8000-000000000002'::uuid, j.org_id, j.id, j.document_id,
  'private-fixture', 'ocr-acceptance-hebrew', '1.0.0', j.input_checksum, j.contract_version,
  pg_temp.ocr_extraction_payload('אישור העברה בנקאית'), 764,
  jsonb_build_object('fixture', true, 'source', 'local-storage')
from public.document_processing_jobs j where j.id = '97100000-0000-4000-8000-000000000002';

insert into public.document_interpretations (
  id, org_id, job_id, extraction_id, document_id, interpreted_for_user_id,
  provider, model, prompt_version, schema_version, payload, usage, duration_ms
)
values (
  '97300000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
  '97100000-0000-4000-8000-000000000002', '97200000-0000-4000-8000-000000000002',
  '97000000-0000-4000-8000-000000000002', :'ocr_owner_id',
  'openai-fixture', 'gpt-local-contract-fixture', 'ocr-acceptance-v1', '1',
  pg_temp.ocr_interpretation_payload(), jsonb_build_object('fixture', true), 271
);

insert into public.document_type_review_decisions (
  org_id, interpretation_id, extraction_id, document_id, revision,
  decision, suggested_document_type, approved_document_type,
  input_checksum, contract_version, actor_id, reason
)
select
  i.org_id, i.id, i.extraction_id, i.document_id, 1,
  'approved', 'invoice', 'payment_confirmation',
  e.input_checksum, e.contract_version, :'ocr_owner_id',
  'תוקן בפיקסטורת הקבלה לאישור תשלום כדי לאפשר בדיקת התאמה'
from public.document_interpretations i
join public.document_extractions e on e.org_id = i.org_id and e.id = i.extraction_id
where i.id = '97300000-0000-4000-8000-000000000002';

-- The payment the confirmation matches, at the same amount the interpretation carries. Like the
-- invoice above it lives only for the browser run.
insert into public.payments (
  org_id, supplier_id, amount, paid_date, method, reference, executed_by, notes
) values (
  '11111111-1111-4111-8111-111111111111', 'aa000000-0000-4000-8000-000000000008',
  745.60, current_date - 3, 'העברה בנקאית', 'FIXTURE-4471902', :'ocr_owner_id',
  'תשלום פיקסטורה לבדיקת התאמת אישור תשלום'
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
  v_price_decision record;
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

  select outcome, accepted_count, waiting_count, created_product_count
    into v_price_decision
  from public.price_list_interpretation_decisions
  where interpretation_id = '97300000-0000-4000-8000-000000000007';
  if v_price_decision.outcome is distinct from 'partially_applied'
     or v_price_decision.accepted_count is distinct from 2
     or v_price_decision.waiting_count is distinct from 1
     or v_price_decision.created_product_count is distinct from 1 then
    raise exception 'OCR browser price-list fixture did not produce the expected 2/1/1 partial decision';
  end if;
  if not exists (
    select 1 from public.products p
    join public.supplier_products sp
      on sp.org_id = p.org_id and sp.product_id = p.id
    where p.org_id = '11111111-1111-4111-8111-111111111111'
      and p.sku = 'OCR-BROWSER-NEW-20260807'
      and p.name = 'מיץ תפוזים חדש מהמחירון'
      and sp.supplier_id = 'aa000000-0000-4000-8000-000000000008'
      and sp.current_price = 18.75
  ) then
    raise exception 'OCR browser price-list fixture did not create the keyed product and supplier price';
  end if;
end
$$;

commit;

select 'ocr_browser_fixture_ready' as result;
