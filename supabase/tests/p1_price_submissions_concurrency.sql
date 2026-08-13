-- P1B real-session concurrency harness. Run only against a freshly reset disposable database
-- with migrations through 0048 applied. It intentionally commits fixtures for dblink visibility;
-- the quality gate resets the database immediately after all concurrency suites.
\set ON_ERROR_STOP on

create extension if not exists dblink;
drop schema if exists p1b_concurrency_test cascade;
create schema p1b_concurrency_test;

create function p1b_concurrency_test.assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P1B concurrency assertion failed: %', p_message;
  end if;
end
$$;

create table p1b_concurrency_test.results (
  case_name text not null,
  runner text not null,
  result jsonb not null
);

insert into organizations (id, name, status) values
  ('12000000-0000-0000-0000-000000000001', 'P1B concurrency tenant', 'active');
insert into auth.users (id, email) values
  ('22000000-0000-0000-0000-000000000001', 'p1b-concurrency-office@example.test');
insert into suppliers (id, org_id, name) values
  ('32000000-0000-0000-0000-000000000001', '12000000-0000-0000-0000-000000000001', 'P1B concurrent supplier');
insert into profiles (id, org_id, full_name, role, supplier_id) values
  ('22000000-0000-0000-0000-000000000001', '12000000-0000-0000-0000-000000000001',
   'P1B concurrent office uploader', 'office', null);
insert into products (id, org_id, name, unit) values
  ('42000000-0000-0000-0000-000000000001', '12000000-0000-0000-0000-000000000001', 'P1B concurrent product', 'unit');
insert into supplier_products (
  id, org_id, supplier_id, product_id, current_price, price_effective_date, available
) values (
  '52000000-0000-0000-0000-000000000001', '12000000-0000-0000-0000-000000000001',
  '32000000-0000-0000-0000-000000000001', '42000000-0000-0000-0000-000000000001',
  10, '2026-06-01', true
);
insert into price_history (org_id, supplier_product_id, price, effective_date) values (
  '12000000-0000-0000-0000-000000000001',
  '52000000-0000-0000-0000-000000000001', 10, '2026-06-01'
);

insert into storage.objects (bucket_id, name, owner, metadata) values
  ('price-submissions', '12000000-0000-0000-0000-000000000001/price-submissions/32000000-0000-0000-0000-000000000001/62000000-0000-0000-0000-000000000001/same-a.csv', '22000000-0000-0000-0000-000000000001', '{"mimetype":"text/csv","size":100}'::jsonb),
  ('price-submissions', '12000000-0000-0000-0000-000000000001/price-submissions/32000000-0000-0000-0000-000000000001/62000000-0000-0000-0000-000000000002/same-b.csv', '22000000-0000-0000-0000-000000000001', '{"mimetype":"text/csv","size":100}'::jsonb),
  ('price-submissions', '12000000-0000-0000-0000-000000000001/price-submissions/32000000-0000-0000-0000-000000000001/62000000-0000-0000-0000-000000000003/revision-a.csv', '22000000-0000-0000-0000-000000000001', '{"mimetype":"text/csv","size":100}'::jsonb),
  ('price-submissions', '12000000-0000-0000-0000-000000000001/price-submissions/32000000-0000-0000-0000-000000000001/62000000-0000-0000-0000-000000000004/revision-b.csv', '22000000-0000-0000-0000-000000000001', '{"mimetype":"text/csv","size":100}'::jsonb);

insert into supplier_price_submission_intakes (
  id, org_id, actor_id, supplier_id, submission_id, target_month,
  file_name, storage_path, object_id, object_updated_at, mime_type,
  file_checksum, file_size, rows_payload, reason, status
)
select fixture.intake_id, '12000000-0000-0000-0000-000000000001',
       '22000000-0000-0000-0000-000000000001',
       '32000000-0000-0000-0000-000000000001', fixture.submission_id,
       fixture.target_month, fixture.file_name, fixture.storage_path,
       object.id, object.updated_at, 'text/csv', fixture.file_checksum, 100,
       jsonb_build_array(jsonb_build_object(
         'source_row', 2,
         'product_id', '42000000-0000-0000-0000-000000000001',
         'product_name', 'P1B concurrent product',
         'price_text', fixture.price_text,
         'available', true
       )),
       'P1B trusted concurrency', 'prepared'
from (values
  ('72000000-0000-0000-0000-000000000001'::uuid, '62000000-0000-0000-0000-000000000001'::uuid, '2026-07-01'::date, 'same-a.csv'::text, '12000000-0000-0000-0000-000000000001/price-submissions/32000000-0000-0000-0000-000000000001/62000000-0000-0000-0000-000000000001/same-a.csv'::text, repeat('a', 64)::text, '20'::text),
  ('72000000-0000-0000-0000-000000000002'::uuid, '62000000-0000-0000-0000-000000000002'::uuid, '2026-07-01'::date, 'same-b.csv'::text, '12000000-0000-0000-0000-000000000001/price-submissions/32000000-0000-0000-0000-000000000001/62000000-0000-0000-0000-000000000002/same-b.csv'::text, repeat('a', 64)::text, '20'::text),
  ('72000000-0000-0000-0000-000000000003'::uuid, '62000000-0000-0000-0000-000000000003'::uuid, '2026-08-01'::date, 'revision-a.csv'::text, '12000000-0000-0000-0000-000000000001/price-submissions/32000000-0000-0000-0000-000000000001/62000000-0000-0000-0000-000000000003/revision-a.csv'::text, repeat('b', 64)::text, '21'::text),
  ('72000000-0000-0000-0000-000000000004'::uuid, '62000000-0000-0000-0000-000000000004'::uuid, '2026-08-01'::date, 'revision-b.csv'::text, '12000000-0000-0000-0000-000000000001/price-submissions/32000000-0000-0000-0000-000000000001/62000000-0000-0000-0000-000000000004/revision-b.csv'::text, repeat('c', 64)::text, '22'::text)
) as fixture(intake_id, submission_id, target_month, file_name, storage_path, file_checksum, price_text)
join storage.objects object
  on object.bucket_id = 'price-submissions' and object.name = fixture.storage_path;

-- One complete reviewed-document chain drives the OCR-specific prepare race below.
insert into products (id, org_id, name, unit) values (
  '42000000-0000-4000-8000-000000000048',
  '12000000-0000-0000-0000-000000000001',
  'P1B concurrent OCR product', 'unit'
);
insert into supplier_products (
  id, org_id, supplier_id, product_id, current_price, price_effective_date, available
) values (
  '52000000-0000-4000-8000-000000000048',
  '12000000-0000-0000-0000-000000000001',
  '32000000-0000-0000-0000-000000000001',
  '42000000-0000-4000-8000-000000000048', 10, '2026-06-01', true
);
insert into price_history (org_id, supplier_product_id, price, effective_date) values (
  '12000000-0000-0000-0000-000000000001',
  '52000000-0000-4000-8000-000000000048', 10, '2026-06-01'
);
insert into storage.objects (bucket_id, name, owner, metadata) values (
  'documents',
  '12000000-0000-0000-0000-000000000001/supplier/32000000-0000-0000-0000-000000000001/46000000-0000-4000-8000-000000000048/concurrent.pdf',
  '22000000-0000-0000-0000-000000000001',
  jsonb_build_object(
    'mimetype', 'application/pdf', 'size', 2048, 'eTag', repeat('d', 64)
  )
);
insert into documents (
  id, org_id, entity_type, entity_id, supplier_id, storage_path,
  file_name, mime_type, document_kind, uploaded_by
) values (
  '46000000-0000-4000-8000-000000000048',
  '12000000-0000-0000-0000-000000000001',
  'supplier', '32000000-0000-0000-0000-000000000001',
  '32000000-0000-0000-0000-000000000001',
  '12000000-0000-0000-0000-000000000001/supplier/32000000-0000-0000-0000-000000000001/46000000-0000-4000-8000-000000000048/concurrent.pdf',
  'concurrent.pdf', 'application/pdf', 'price_list',
  '22000000-0000-0000-0000-000000000001'
);
insert into document_processing_jobs (
  id, org_id, document_id, requested_by, status, input_checksum,
  contract_version, interpretation_actor_id, interpretation_started_at
) values (
  '56000000-0000-4000-8000-000000000048',
  '12000000-0000-0000-0000-000000000001',
  '46000000-0000-4000-8000-000000000048',
  '22000000-0000-0000-0000-000000000001',
  'review', 'etag:' || repeat('d', 64), '1',
  '22000000-0000-0000-0000-000000000001', now()
);
insert into document_extractions (
  id, org_id, job_id, document_id, engine, model, model_version,
  input_checksum, contract_version, payload
) values (
  '66000000-0000-4000-8000-000000000048',
  '12000000-0000-0000-0000-000000000001',
  '56000000-0000-4000-8000-000000000048',
  '46000000-0000-4000-8000-000000000048',
  'fixture', 'fixture-model', '1', 'etag:' || repeat('d', 64), '1',
  jsonb_build_object(
    'schema_version', '1',
    'document', jsonb_build_object(
      'page_count', 1, 'detected_languages', jsonb_build_array('he'),
      'plain_text', 'מחירון במקביל', 'partial', false
    ),
    'blocks', '[]'::jsonb, 'tables', '[]'::jsonb, 'marks', '[]'::jsonb
  )
);
insert into document_interpretations (
  id, org_id, job_id, extraction_id, document_id, interpreted_for_user_id,
  provider, model, prompt_version, schema_version, payload
) values (
  '76000000-0000-4000-8000-000000000048',
  '12000000-0000-0000-0000-000000000001',
  '56000000-0000-4000-8000-000000000048',
  '66000000-0000-4000-8000-000000000048',
  '46000000-0000-4000-8000-000000000048',
  '22000000-0000-0000-0000-000000000001',
  'anthropic', 'fixture-model', 'interpret-document-v1', '1',
  jsonb_build_object(
    'schema_version', '1', 'document_type', 'price_list',
    'document_type_confidence', 0.99,
    'supplier', jsonb_build_object(
      'suggested_id', '32000000-0000-0000-0000-000000000001',
      'suggested_name', 'P1B concurrent supplier', 'confidence', 0.99,
      'evidence_block_ids', '[]'::jsonb
    ),
    'fields', '[]'::jsonb,
    'line_items', jsonb_build_array(jsonb_build_object(
      'source_row', 1,
      'values', jsonb_build_object('product_name', 'P1B concurrent OCR product', 'price', '31'),
      'evidence_block_ids', '[]'::jsonb
    )),
    'suggested_annotations', '[]'::jsonb
  )
);

create function p1b_concurrency_test.activate()
returns void language plpgsql security invoker as $$
begin
  perform set_config('request.jwt.claim.sub', '22000000-0000-0000-0000-000000000001', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('statement_timeout', '7000', true);
  perform set_config('role', 'authenticated', true);
end
$$;

create function p1b_concurrency_test.run_submission(p_intake_id uuid, p_hold_seconds double precision)
returns jsonb language plpgsql security invoker as $$
declare v_result jsonb;
begin
  perform p1b_concurrency_test.activate();
  v_result := submit_supplier_price_list(p_intake_id);
  perform pg_sleep(p_hold_seconds);
  return v_result;
end
$$;

create function p1b_concurrency_test.run_document_reserve(p_file_name text)
returns jsonb language plpgsql security invoker as $$
begin
  perform p1b_concurrency_test.activate();
  return reserve_supplier_price_document_upload(
    '32000000-0000-0000-0000-000000000001', p_file_name, 'application/pdf'
  );
end
$$;

create function p1b_concurrency_test.run_document_register(
  p_document_id uuid,
  p_hold_seconds double precision
)
returns jsonb language plpgsql security invoker as $$
declare v_result jsonb;
begin
  perform p1b_concurrency_test.activate();
  v_result := register_supplier_price_document(p_document_id);
  perform pg_sleep(p_hold_seconds);
  return v_result;
end
$$;

create function p1b_concurrency_test.run_ocr_prepare(
  p_intake_id uuid,
  p_hold_seconds double precision
)
returns jsonb language plpgsql security invoker as $$
declare
  v_result jsonb;
begin
  perform set_config('request.jwt.claim.sub', '22000000-0000-0000-0000-000000000001', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('statement_timeout', '7000', true);
  perform set_config('role', 'service_role', true);
  begin
    v_result := prepare_ocr_supplier_price_intake(
      p_intake_id,
      '22000000-0000-0000-0000-000000000001',
      '76000000-0000-4000-8000-000000000048',
      '46000000-0000-4000-8000-000000000048',
      '76000000-0000-4000-8000-000000000048',
      '2026-09-01',
      jsonb_build_array(jsonb_build_object(
        'lineItemIndex', 0,
        'productId', '42000000-0000-4000-8000-000000000048',
        'priceText', '31', 'available', true
      )),
      'P1B concurrent reviewed OCR confirmation'
    );
    perform pg_sleep(p_hold_seconds);
    return jsonb_build_object(
      'status', 'prepared', 'intake_id', p_intake_id, 'bridge', v_result
    );
  exception when sqlstate '55P03' then
    return jsonb_build_object('status', 'busy', 'intake_id', p_intake_id);
  end;
end
$$;

select p1b_concurrency_test.run_document_reserve(
  'concurrent-register.pdf'
)::text as payload
\gset document_reservation_
select
  :'document_reservation_payload'::jsonb ->> 'document_id' as document_id,
  :'document_reservation_payload'::jsonb ->> 'storage_path' as storage_path
\gset document_reservation_
insert into storage.objects (bucket_id, name, owner, metadata) values (
  'documents', :'document_reservation_storage_path',
  '22000000-0000-0000-0000-000000000001',
  jsonb_build_object(
    'mimetype', 'application/pdf', 'size', 2048, 'eTag', repeat('e', 64)
  )
);

select dblink_connect_u('p1b_a', format('dbname=%L user=%L', current_database(), 'postgres'));
select dblink_connect_u('p1b_b', format('dbname=%L user=%L', current_database(), 'postgres'));

-- Two finalizers race the same server-reserved UUID. The row lock lets one perform the insert and
-- enqueue; the waiter returns the committed IDs as an idempotent lost-response retry.
select dblink_send_query(
  'p1b_a',
  format(
    'select p1b_concurrency_test.run_document_register(%L, 1.2)',
    :'document_reservation_document_id'
  )
);
select pg_sleep(0.15);
select dblink_send_query(
  'p1b_b',
  format(
    'select p1b_concurrency_test.run_document_register(%L, 0)',
    :'document_reservation_document_id'
  )
);
insert into p1b_concurrency_test.results
select 'document_register', 'a', result
from dblink_get_result('p1b_a') as t(result jsonb);
insert into p1b_concurrency_test.results
select 'document_register', 'b', result
from dblink_get_result('p1b_b') as t(result jsonb);
select count(*) from dblink_get_result('p1b_a') as t(result jsonb);
select count(*) from dblink_get_result('p1b_b') as t(result jsonb);
select p1b_concurrency_test.assert(
  (select count(*) filter (where (result ->> 'idempotent')::boolean) = 1
          and count(*) filter (where not (result ->> 'idempotent')::boolean) = 1
          and count(distinct result ->> 'document_id') = 1
          and count(distinct result ->> 'job_id') = 1
          and count(distinct result ->> 'storage_path') = 1
   from p1b_concurrency_test.results where case_name = 'document_register')
  and (select count(*) = 1 from documents
       where id = :'document_reservation_document_id'::uuid)
  and (select count(*) = 1 from document_processing_jobs
       where document_id = :'document_reservation_document_id'::uuid)
  and (select status = 'registered' and job_id is not null
       from supplier_price_document_upload_reservations
       where document_id = :'document_reservation_document_id'::uuid),
  'concurrent document registration did not produce one document/job and one retry receipt'
);

-- Same month and server-derived checksum: one commit and one idempotent receipt.
select dblink_send_query('p1b_a', $$select p1b_concurrency_test.run_submission('72000000-0000-0000-0000-000000000001', 1.2)$$);
select pg_sleep(0.15);
select dblink_send_query('p1b_b', $$select p1b_concurrency_test.run_submission('72000000-0000-0000-0000-000000000002', 0)$$);
insert into p1b_concurrency_test.results
select 'same_checksum', 'a', result from dblink_get_result('p1b_a') as t(result jsonb);
insert into p1b_concurrency_test.results
select 'same_checksum', 'b', result from dblink_get_result('p1b_b') as t(result jsonb);
select count(*) from dblink_get_result('p1b_a') as t(result jsonb);
select count(*) from dblink_get_result('p1b_b') as t(result jsonb);
select p1b_concurrency_test.assert(
  (select count(*) = 1 from supplier_price_submissions
   where org_id = '12000000-0000-0000-0000-000000000001'
     and supplier_id = '32000000-0000-0000-0000-000000000001'
     and target_month = '2026-07-01'),
  'same checksum created more than one receipt'
);
select p1b_concurrency_test.assert(
  (select count(*) filter (where (result ->> 'idempotent')::boolean) = 1
          and count(*) filter (where not (result ->> 'idempotent')::boolean) = 1
   from p1b_concurrency_test.results where case_name = 'same_checksum'),
  'same checksum did not produce one commit and one idempotent result'
);

-- Different checksums for the same month serialize into revisions 1 and 2.
select dblink_send_query('p1b_a', $$select p1b_concurrency_test.run_submission('72000000-0000-0000-0000-000000000003', 1.2)$$);
select pg_sleep(0.15);
select dblink_send_query('p1b_b', $$select p1b_concurrency_test.run_submission('72000000-0000-0000-0000-000000000004', 0)$$);
insert into p1b_concurrency_test.results
select 'different_checksum', 'a', result from dblink_get_result('p1b_a') as t(result jsonb);
insert into p1b_concurrency_test.results
select 'different_checksum', 'b', result from dblink_get_result('p1b_b') as t(result jsonb);
select count(*) from dblink_get_result('p1b_a') as t(result jsonb);
select count(*) from dblink_get_result('p1b_b') as t(result jsonb);
select p1b_concurrency_test.assert(
  (select count(*) = 2 and min(revision) = 1 and max(revision) = 2
   from supplier_price_submissions
   where org_id = '12000000-0000-0000-0000-000000000001'
     and supplier_id = '32000000-0000-0000-0000-000000000001'
     and target_month = '2026-08-01'),
  'different checksums did not serialize into revisions 1 and 2'
);
select p1b_concurrency_test.assert(
  not exists (
    select 1 from supplier_price_submission_intakes
    where id in (
      '72000000-0000-0000-0000-000000000001',
      '72000000-0000-0000-0000-000000000002',
      '72000000-0000-0000-0000-000000000003',
      '72000000-0000-0000-0000-000000000004'
    )
  ),
  'successful concurrent commands did not consume every intake'
);

-- Two confirmations of the same immutable interpretation race at the service-only intake
-- boundary. Exactly one claim survives; the other receives the stable busy verdict.
select dblink_send_query(
  'p1b_a',
  $$select p1b_concurrency_test.run_ocr_prepare(
    '78000000-0000-4000-8000-000000000001', 1.2
  )$$
);
select pg_sleep(0.15);
select dblink_send_query(
  'p1b_b',
  $$select p1b_concurrency_test.run_ocr_prepare(
    '78000000-0000-4000-8000-000000000002', 0
  )$$
);
insert into p1b_concurrency_test.results
select 'ocr_prepare', 'a', result
from dblink_get_result('p1b_a') as t(result jsonb);
insert into p1b_concurrency_test.results
select 'ocr_prepare', 'b', result
from dblink_get_result('p1b_b') as t(result jsonb);
select count(*) from dblink_get_result('p1b_a') as t(result jsonb);
select count(*) from dblink_get_result('p1b_b') as t(result jsonb);
select p1b_concurrency_test.assert(
  (select count(*) filter (where result ->> 'status' = 'prepared') = 1
          and count(*) filter (where result ->> 'status' = 'busy') = 1
   from p1b_concurrency_test.results where case_name = 'ocr_prepare')
  and (select count(*) = 1
       from supplier_price_submission_intakes
       where source_interpretation_id = '76000000-0000-4000-8000-000000000048'),
  'OCR intake race did not produce exactly one prepared intake and one busy result'
);

select id::text as winner_intake_id
from supplier_price_submission_intakes
where source_interpretation_id = '76000000-0000-4000-8000-000000000048'
\gset ocr_concurrency_
select count(*) as history_before
from price_history
where supplier_product_id = '52000000-0000-4000-8000-000000000048'
\gset ocr_concurrency_

select p1b_concurrency_test.run_submission(
  :'ocr_concurrency_winner_intake_id'::uuid, 0
)::text as receipt
\gset ocr_concurrency_

select p1b_concurrency_test.assert(
  (:'ocr_concurrency_receipt'::jsonb ->> 'submission_id')::uuid
    = '76000000-0000-4000-8000-000000000048'
  and not (:'ocr_concurrency_receipt'::jsonb ->> 'idempotent')::boolean
  and (select count(*) = 1 from supplier_price_submissions
       where source_interpretation_id = '76000000-0000-4000-8000-000000000048')
  and (select count(*) = :'ocr_concurrency_history_before'::integer + 1
       from price_history
       where supplier_product_id = '52000000-0000-4000-8000-000000000048'),
  'winning OCR intake did not produce exactly one ledger and history change'
);

-- Once the winner is consumed, the same deterministic interpretation can be prepared again;
-- the existing writer returns the original receipt without another history row.
select p1b_concurrency_test.run_ocr_prepare(
  '78000000-0000-4000-8000-000000000003', 0
)::text as replay_preparation
\gset ocr_concurrency_
select p1b_concurrency_test.assert(
  :'ocr_concurrency_replay_preparation'::jsonb ->> 'status' = 'prepared',
  'OCR replay intake was not prepared through the service-only bridge'
);
select p1b_concurrency_test.run_submission(
  '78000000-0000-4000-8000-000000000003', 0
)::text as replay_receipt
\gset ocr_concurrency_
select p1b_concurrency_test.assert(
  (:'ocr_concurrency_replay_receipt'::jsonb ->> 'submission_id')::uuid
    = '76000000-0000-4000-8000-000000000048'
  and (:'ocr_concurrency_replay_receipt'::jsonb ->> 'idempotent')::boolean
  and (select count(*) = 1 from supplier_price_submissions
       where source_interpretation_id = '76000000-0000-4000-8000-000000000048')
  and (select count(*) = :'ocr_concurrency_history_before'::integer + 1
       from price_history
       where supplier_product_id = '52000000-0000-4000-8000-000000000048'),
  'OCR replay after the prepare race duplicated ledger or price history'
);

select dblink_disconnect('p1b_a');
select dblink_disconnect('p1b_b');
select 'p1_price_submissions_concurrency: all assertions passed' as result;
