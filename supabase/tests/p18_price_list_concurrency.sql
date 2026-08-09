-- P18B -- deterministic same-document price-list reprocess race.
-- This test commits fixtures and must run only on the disposable local database before a reset.
\set ON_ERROR_STOP on

create extension if not exists dblink;
drop schema if exists p18_price_concurrency cascade;
create schema p18_price_concurrency;

create function p18_price_concurrency.assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P18B price-list concurrency assertion failed: %', p_message;
  end if;
end
$$;

create table p18_price_concurrency.results (runner text primary key, result jsonb not null);

insert into public.organizations (id, name, status) values
  ('1c000000-0000-4000-8000-000000000001', 'P18B tenant', 'active');
insert into auth.users (id, email) values
  ('2c000000-0000-4000-8000-000000000001', 'owner-p18b@example.test'),
  ('2c000000-0000-4000-8000-000000000002', 'platform-p18b@example.test');
insert into public.profiles (id, org_id, full_name, role) values
  ('2c000000-0000-4000-8000-000000000001',
   '1c000000-0000-4000-8000-000000000001', 'P18B owner', 'owner');
insert into public.platform_admins (user_id, note) values
  ('2c000000-0000-4000-8000-000000000002', 'P18B platform operator');
insert into public.suppliers (id, org_id, name, status) values
  ('3c000000-0000-4000-8000-000000000001',
   '1c000000-0000-4000-8000-000000000001', 'P18B supplier', 'active');
insert into public.products (id, org_id, name, unit, sku, barcode) values
  ('4c000000-0000-4000-8000-000000000001',
   '1c000000-0000-4000-8000-000000000001', 'P18B product', 'unit',
   'P18B-SKU', '729180000099');
insert into public.supplier_products (
  id, org_id, supplier_id, product_id, current_price, price_effective_date,
  available, supplier_sku
) values (
  '5c000000-0000-4000-8000-000000000001',
  '1c000000-0000-4000-8000-000000000001',
  '3c000000-0000-4000-8000-000000000001',
  '4c000000-0000-4000-8000-000000000001',
  10, current_date, true, 'P18B-SKU'
);
insert into public.org_autonomy_policies (
  org_id, policy_key, autonomy_enabled, min_confidence
) values (
  '1c000000-0000-4000-8000-000000000001', 'price_list.intake', true, 0.95
);

insert into storage.objects (bucket_id, name, owner, metadata) values (
  'documents',
  '1c000000-0000-4000-8000-000000000001/supplier/3c000000-0000-4000-8000-000000000001/8c000000-0000-4000-8000-000000000001/p18b.pdf',
  '2c000000-0000-4000-8000-000000000001',
  '{"mimetype":"application/pdf","size":2048,"eTag":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'::jsonb
);
insert into public.documents (
  id, org_id, entity_type, entity_id, supplier_id, storage_path,
  file_name, mime_type, document_kind, uploaded_by
) values (
  '8c000000-0000-4000-8000-000000000001',
  '1c000000-0000-4000-8000-000000000001', 'supplier',
  '3c000000-0000-4000-8000-000000000001',
  '3c000000-0000-4000-8000-000000000001',
  '1c000000-0000-4000-8000-000000000001/supplier/3c000000-0000-4000-8000-000000000001/8c000000-0000-4000-8000-000000000001/p18b.pdf',
  'p18b.pdf', 'application/pdf', 'price_list',
  '2c000000-0000-4000-8000-000000000001'
);

insert into public.document_processing_jobs (
  id, org_id, document_id, requested_by, status, input_checksum,
  interpretation_actor_id, interpretation_started_at
) values
  ('8d000000-0000-4000-8000-000000000001',
   '1c000000-0000-4000-8000-000000000001',
   '8c000000-0000-4000-8000-000000000001',
   '2c000000-0000-4000-8000-000000000001', 'review',
   'etag:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
   '2c000000-0000-4000-8000-000000000001', now()),
  ('8d000000-0000-4000-8000-000000000002',
   '1c000000-0000-4000-8000-000000000001',
   '8c000000-0000-4000-8000-000000000001',
   '2c000000-0000-4000-8000-000000000001', 'review',
   'etag:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
   '2c000000-0000-4000-8000-000000000001', now());

insert into public.document_extractions (
  id, org_id, job_id, document_id, engine, model, model_version,
  input_checksum, contract_version, payload
)
select extraction_id, '1c000000-0000-4000-8000-000000000001', job_id,
       '8c000000-0000-4000-8000-000000000001', 'fixture', 'fixture-ocr', 'v1',
       checksum, '1', jsonb_build_object(
         'schema_version', '1',
         'document', jsonb_build_object(
           'page_count', 1, 'detected_languages', jsonb_build_array('he'),
           'plain_text', 'price list', 'partial', false
         ),
         'blocks', jsonb_build_array(jsonb_build_object(
           'id', 'b1', 'page', 1, 'type', 'text',
           'bbox', jsonb_build_array(0, 0, 1, 1), 'text', 'price list', 'confidence', 0.99
         )),
         'tables', '[]'::jsonb, 'marks', '[]'::jsonb
       )
from (values
  ('8e000000-0000-4000-8000-000000000001'::uuid,
   '8d000000-0000-4000-8000-000000000001'::uuid,
   'etag:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  ('8e000000-0000-4000-8000-000000000002'::uuid,
   '8d000000-0000-4000-8000-000000000002'::uuid,
   'etag:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
) fixture(extraction_id, job_id, checksum);

insert into public.document_interpretations (
  id, org_id, job_id, extraction_id, document_id, interpreted_for_user_id,
  provider, model, prompt_version, schema_version, payload
)
select interpretation_id, '1c000000-0000-4000-8000-000000000001', job_id,
       extraction_id, '8c000000-0000-4000-8000-000000000001',
       '2c000000-0000-4000-8000-000000000001',
       'openai', 'p18b-model', 'p18b-prompt', '1', jsonb_build_object(
         'schema_version', '1', 'document_type', 'price_list',
         'document_type_confidence', 0.99,
         'supplier', jsonb_build_object(
           'suggested_id', '3c000000-0000-4000-8000-000000000001',
           'suggested_name', 'P18B supplier', 'confidence', 0.99,
           'evidence_block_ids', jsonb_build_array('b1')
         ),
         'fields', '[]'::jsonb,
         'line_items', jsonb_build_array(jsonb_build_object(
           'source_row', 1,
           'values', jsonb_build_object(
             'sku', 'P18B-SKU', 'barcode', '729180000099',
             'unit_price', '12.00', 'product_name', 'P18B product', 'unit', 'unit'
           ),
           'evidence_block_ids', jsonb_build_array('b1')
         )),
         'suggested_annotations', '[]'::jsonb
       )
from (values
  ('8f000000-0000-4000-8000-000000000001'::uuid,
   '8d000000-0000-4000-8000-000000000001'::uuid,
   '8e000000-0000-4000-8000-000000000001'::uuid),
  ('8f000000-0000-4000-8000-000000000002'::uuid,
   '8d000000-0000-4000-8000-000000000002'::uuid,
   '8e000000-0000-4000-8000-000000000002'::uuid)
) fixture(interpretation_id, job_id, extraction_id);

select set_config('app.price_list_shadow_writer', 'run', false);
insert into public.price_list_shadow_runs (
  id, org_id, document_id, job_id, extraction_id, interpretation_id,
  actor_id, supplier_id, evaluator_version, policy_configured,
  live_policy_enabled, policy_kill_switch, evaluated_min_confidence,
  decision_confidence, predicted_outcome, applicable_count, waiting_count,
  would_create_product_count, provider, model, prompt_version, schema_version,
  document_format, extraction_engine, extraction_model, extraction_model_version,
  page_count, block_count, table_count, interpreted_line_count, layout_signature
)
select run_id, '1c000000-0000-4000-8000-000000000001',
       '8c000000-0000-4000-8000-000000000001', fixture.job_id, fixture.extraction_id,
       fixture.interpretation_id, '2c000000-0000-4000-8000-000000000001',
       '3c000000-0000-4000-8000-000000000001', 'price-list-shadow-v1',
       true, true, false, 0.95, 0.99, 'would_apply', 1, 0, 0,
       'openai', 'p18b-model', 'p18b-prompt', '1', 'application/pdf',
       'fixture', 'fixture-ocr', 'v1', 1, 1, 0, 1,
       private.price_list_layout_signature(extraction_payload, 'application/pdf')
from (values
  ('81000000-0000-4000-8000-000000000001'::uuid,
   '8d000000-0000-4000-8000-000000000001'::uuid,
   '8e000000-0000-4000-8000-000000000001'::uuid,
   '8f000000-0000-4000-8000-000000000001'::uuid),
  ('81000000-0000-4000-8000-000000000002'::uuid,
   '8d000000-0000-4000-8000-000000000002'::uuid,
   '8e000000-0000-4000-8000-000000000002'::uuid,
   '8f000000-0000-4000-8000-000000000002'::uuid)
) fixture(run_id, job_id, extraction_id, interpretation_id)
join public.document_extractions extraction on extraction.id = fixture.extraction_id
cross join lateral (select extraction.payload as extraction_payload) payload;

insert into public.price_list_shadow_lines (
  org_id, shadow_run_id, document_id, interpretation_id, line_index, source_row,
  evidence_block_ids, predicted_action, matched_by, product_id, supplier_product_id,
  sku, barcode, product_name, unit, proposed_unit_price, current_unit_price,
  price_change_percent, product_would_be_created
)
select '1c000000-0000-4000-8000-000000000001', run_id,
       '8c000000-0000-4000-8000-000000000001', interpretation_id, 0, 1,
       array['b1'], 'apply_existing_price', 'supplier_sku',
       '4c000000-0000-4000-8000-000000000001',
       '5c000000-0000-4000-8000-000000000001', 'P18B-SKU', '729180000099',
       'P18B product', 'unit', 12, 10, 20, false
from (values
  ('81000000-0000-4000-8000-000000000001'::uuid,
   '8f000000-0000-4000-8000-000000000001'::uuid),
  ('81000000-0000-4000-8000-000000000002'::uuid,
   '8f000000-0000-4000-8000-000000000002'::uuid)
) fixture(run_id, interpretation_id);
select set_config('app.price_list_shadow_writer', '', false);

select set_config('app.price_list_scope_writer', 'decide', false);
insert into public.price_list_automation_scope_decisions (
  org_id, scope_fingerprint, evidence_shadow_run_id, revision, idempotency_key,
  state, evidence_line_count, evidence_reviewed_count, evidence_correct_count,
  evidence_incorrect_count, evidence_ambiguous_count, evidence_policy_rejected_count,
  evidence_accuracy, decided_by, reason
)
select run.org_id, private.price_list_scope_fingerprint(run), run.id, 1,
       '82000000-0000-4000-8000-000000000001', 'eligible', 1, 1, 1, 0, 0, 0, 1,
       '2c000000-0000-4000-8000-000000000001', 'P18B reviewed fixture scope'
from public.price_list_shadow_runs run
where run.id = '81000000-0000-4000-8000-000000000001';
select set_config('app.price_list_scope_writer', '', false);

create function p18_price_concurrency.run_scope_decision(p_shadow_run_id uuid)
returns jsonb language plpgsql as $$
begin
  return public.platform_set_price_list_automation_scope(
    '1c000000-0000-4000-8000-000000000001', p_shadow_run_id, 'shadow_only',
    '82000000-0000-4000-8000-000000000002', 'P18B concurrent idempotency proof'
  );
exception when sqlstate '55000' then
  return jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate);
end
$$;
grant usage on schema p18_price_concurrency to authenticated;
grant execute on function p18_price_concurrency.run_scope_decision(uuid) to authenticated;

select dblink_connect_u('p18b_lock', format('dbname=%L user=%L', current_database(), 'postgres'));
select dblink_connect_u('p18b_a', format('dbname=%L user=%L', current_database(), 'postgres'));
select dblink_connect_u('p18b_b', format('dbname=%L user=%L', current_database(), 'postgres'));

select dblink_exec('p18b_lock', 'begin');
select dblink_exec('p18b_lock', $sql$
  do $$ begin
    perform 1 from public.documents
    where id = '8c000000-0000-4000-8000-000000000001' for update;
  end $$
$sql$);
select dblink_exec('p18b_a', 'set "request.jwt.claim.role" = ''service_role''; set role service_role');
select dblink_exec('p18b_b', 'set "request.jwt.claim.role" = ''service_role''; set role service_role');

select dblink_send_query('p18b_a', $sql$
  select public.apply_eligible_price_list_interpretation(
    '8d000000-0000-4000-8000-000000000001',
    '8f000000-0000-4000-8000-000000000001',
    '2c000000-0000-4000-8000-000000000001'
  )
$sql$);
select dblink_send_query('p18b_b', $sql$
  select public.apply_eligible_price_list_interpretation(
    '8d000000-0000-4000-8000-000000000002',
    '8f000000-0000-4000-8000-000000000002',
    '2c000000-0000-4000-8000-000000000001'
  )
$sql$);
select pg_sleep(0.5);
select dblink_exec('p18b_lock', 'commit');

insert into p18_price_concurrency.results
select 'a', result from dblink_get_result('p18b_a') as t(result jsonb);
select count(*) from dblink_get_result('p18b_a') as t(result jsonb);
insert into p18_price_concurrency.results
select 'b', result from dblink_get_result('p18b_b') as t(result jsonb);
select count(*) from dblink_get_result('p18b_b') as t(result jsonb);

select p18_price_concurrency.assert(
  (select count(*) = 1 from p18_price_concurrency.results
   where result ->> 'outcome' = 'auto_applied')
  and (select count(*) = 1 from p18_price_concurrency.results
       where result ->> 'reason_code' = 'document_already_auto_applied'),
  'concurrent reprocess writers did not linearize to one apply and one review'
);
select p18_price_concurrency.assert(
  (select count(*) = 1 from public.price_list_interpretation_decisions
   where org_id = '1c000000-0000-4000-8000-000000000001'
     and submission_id is not null and reverted_at is null)
  and (select count(*) = 1 from public.price_history
       where org_id = '1c000000-0000-4000-8000-000000000001'),
  'concurrent reprocess created duplicate live batches or price history'
);

select set_config('app.price_list_shadow_writer', 'run', false);
insert into public.price_list_shadow_runs (
  id, org_id, document_id, job_id, extraction_id, interpretation_id,
  actor_id, supplier_id, evaluator_version, policy_configured,
  live_policy_enabled, policy_kill_switch, evaluated_min_confidence,
  decision_confidence, predicted_outcome, applicable_count, waiting_count,
  would_create_product_count, provider, model, prompt_version, schema_version,
  document_format, extraction_engine, extraction_model, extraction_model_version,
  page_count, block_count, table_count, interpreted_line_count, layout_signature
)
select '81000000-0000-4000-8000-000000000003', org_id, document_id, job_id,
       extraction_id, interpretation_id, actor_id, supplier_id,
       'price-list-shadow-v2', policy_configured, live_policy_enabled,
       policy_kill_switch, evaluated_min_confidence, decision_confidence,
       predicted_outcome, applicable_count, waiting_count, would_create_product_count,
       provider, model, prompt_version, schema_version, document_format,
       extraction_engine, extraction_model, extraction_model_version,
       page_count, block_count, table_count, interpreted_line_count, layout_signature
from public.price_list_shadow_runs
where id = '81000000-0000-4000-8000-000000000001';
select set_config('app.price_list_shadow_writer', '', false);

select dblink_connect_u('p18b_scope_a', format('dbname=%L user=%L', current_database(), 'postgres'));
select dblink_connect_u('p18b_scope_b', format('dbname=%L user=%L', current_database(), 'postgres'));
select dblink_exec('p18b_scope_a', $sql$
  select set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', '2c000000-0000-4000-8000-000000000002',
      'role', 'authenticated',
      'amr', jsonb_build_array(jsonb_build_object(
        'method', 'password',
        'timestamp', extract(epoch from now())::bigint
      ))
    )::text,
    false
  );
  set role authenticated
$sql$);
select dblink_exec('p18b_scope_b', $sql$
  select set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', '2c000000-0000-4000-8000-000000000002',
      'role', 'authenticated',
      'amr', jsonb_build_array(jsonb_build_object(
        'method', 'password',
        'timestamp', extract(epoch from now())::bigint
      ))
    )::text,
    false
  );
  set role authenticated
$sql$);
select dblink_send_query('p18b_scope_a',
  'select p18_price_concurrency.run_scope_decision(''81000000-0000-4000-8000-000000000001'')');
select dblink_send_query('p18b_scope_b',
  'select p18_price_concurrency.run_scope_decision(''81000000-0000-4000-8000-000000000003'')');
insert into p18_price_concurrency.results
select 'scope_a', result from dblink_get_result('p18b_scope_a') as t(result jsonb);
select count(*) from dblink_get_result('p18b_scope_a') as t(result jsonb);
insert into p18_price_concurrency.results
select 'scope_b', result from dblink_get_result('p18b_scope_b') as t(result jsonb);
select count(*) from dblink_get_result('p18b_scope_b') as t(result jsonb);
select p18_price_concurrency.assert(
  (select count(*) = 1 from p18_price_concurrency.results
   where runner like 'scope_%' and result ->> 'state' = 'shadow_only')
  and (select count(*) = 1 from p18_price_concurrency.results
       where runner like 'scope_%'
         and result ->> 'error' = 'price_list_scope_decision_idempotency_conflict'
         and result ->> 'sqlstate' = '55000')
  and (select count(*) = 1 from public.price_list_automation_scope_decisions
       where org_id = '1c000000-0000-4000-8000-000000000001'
         and idempotency_key = '82000000-0000-4000-8000-000000000002'),
  'concurrent cross-fingerprint idempotency returned a raw unique failure or two decisions'
);

select dblink_disconnect('p18b_lock');
select dblink_disconnect('p18b_a');
select dblink_disconnect('p18b_b');
select dblink_disconnect('p18b_scope_a');
select dblink_disconnect('p18b_scope_b');

\echo 'P18B concurrent same-document price-list apply checks passed.'
