-- P15 -- automatic price-list intake. Runs against a freshly reset disposable database.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p15_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P15 automatic price-list assertion failed: %', p_message;
  end if;
end
$$;

select pg_temp.p15_assert(
  private.dispatch_document_interpretations() = array[]::bigint[],
  'unconfigured automatic dispatch did not fail closed'
);

create function pg_temp.p15_extraction_payload()
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'schema_version', '1',
    'document', jsonb_build_object(
      'page_count', 1, 'detected_languages', jsonb_build_array('he'),
      'plain_text', 'מחירון ספק לבדיקה', 'partial', false
    ),
    'blocks', jsonb_build_array(jsonb_build_object(
      'id', 'block-1', 'page', 1, 'type', 'text',
      'bbox', jsonb_build_array(0, 0, 1, 1),
      'text', 'מחירון ספק לבדיקה', 'confidence', 0.99
    )),
    'tables', '[]'::jsonb,
    'marks', '[]'::jsonb
  )
$$;

create function pg_temp.p15_payload(p_lines jsonb)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'schema_version', '1',
    'document_type', 'price_list',
    'document_type_confidence', 0.99,
    'supplier', jsonb_build_object(
      'suggested_id', '35000000-0000-4000-8000-000000000001',
      'suggested_name', 'P15 supplier',
      'confidence', 0.99,
      'evidence_block_ids', jsonb_build_array('block-1')
    ),
    'fields', '[]'::jsonb,
    'line_items', p_lines,
    'suggested_annotations', '[]'::jsonb
  )
$$;

create function pg_temp.p15_line(
  p_row integer,
  p_sku text,
  p_barcode text,
  p_price text,
  p_product_name text default null
) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'source_row', p_row,
    'values', jsonb_strip_nulls(jsonb_build_object(
      'sku', p_sku, 'barcode', p_barcode, 'unit_price', p_price,
      'product_name', p_product_name
    )),
    'evidence_block_ids', jsonb_build_array('block-1')
  )
$$;

create function pg_temp.p15_seed(p_n integer, p_lines jsonb)
returns uuid language plpgsql as $$
declare
  v_org constant uuid := '15000000-0000-4000-8000-000000000001';
  v_user constant uuid := '25000000-0000-4000-8000-000000000001';
  v_supplier constant uuid := '35000000-0000-4000-8000-000000000001';
  v_doc uuid := ('81000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
  v_job uuid := ('82000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
  v_ext uuid := ('83000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
  v_int uuid := ('84000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
  v_etag text := md5(p_n::text) || md5(p_n::text);
  v_path text := v_org::text || '/supplier/' || v_supplier::text || '/'
    || v_doc::text || '/prices-' || p_n || '.pdf';
begin
  insert into storage.objects (bucket_id, name, owner, metadata)
  values ('documents', v_path, v_user,
    jsonb_build_object('mimetype', 'application/pdf', 'size', 2048, 'eTag', v_etag));

  insert into public.documents (
    id, org_id, entity_type, entity_id, supplier_id, storage_path,
    file_name, mime_type, document_kind, uploaded_by
  ) values (
    v_doc, v_org, 'supplier', v_supplier, v_supplier, v_path,
    'prices-' || p_n || '.pdf', 'application/pdf', 'price_list', v_user
  );

  insert into public.document_processing_jobs (
    id, org_id, document_id, requested_by, status, input_checksum,
    interpretation_actor_id, interpretation_started_at
  ) values (
    v_job, v_org, v_doc, v_user, 'review', 'etag:' || v_etag, v_user, now()
  );

  insert into public.document_extractions (
    id, org_id, job_id, document_id, engine, model, model_version,
    input_checksum, contract_version, payload
  ) values (
    v_ext, v_org, v_job, v_doc, 'fixture', 'fixture-ocr', '1',
    'etag:' || v_etag, '1', pg_temp.p15_extraction_payload()
  );

  insert into public.document_interpretations (
    id, org_id, job_id, extraction_id, document_id, interpreted_for_user_id,
    provider, model, prompt_version, schema_version, payload
  ) values (
    v_int, v_org, v_job, v_ext, v_doc, v_user,
    'openai', 'gpt-p15-fixture', 'interpret-document-v5', '1',
    pg_temp.p15_payload(p_lines)
  );
  return v_int;
end
$$;

insert into public.organizations (id, name, status)
values ('15000000-0000-4000-8000-000000000001', 'P15 tenant', 'active');
insert into auth.users (id, email)
values ('25000000-0000-4000-8000-000000000001', 'owner-p15@example.test');
insert into public.profiles (id, org_id, full_name, role)
values (
  '25000000-0000-4000-8000-000000000001',
  '15000000-0000-4000-8000-000000000001', 'P15 owner', 'owner'
);
insert into public.suppliers (id, org_id, name)
values (
  '35000000-0000-4000-8000-000000000001',
  '15000000-0000-4000-8000-000000000001', 'P15 supplier'
);

insert into storage.objects (bucket_id, name, owner, metadata)
values (
  'documents',
  '15000000-0000-4000-8000-000000000001/supplier/35000000-0000-4000-8000-000000000001/81000000-0000-4000-8000-000000000900/dispatch.pdf',
  '25000000-0000-4000-8000-000000000001',
  jsonb_build_object('mimetype', 'application/pdf', 'size', 2048, 'eTag', repeat('9', 64))
);
insert into public.documents (
  id, org_id, entity_type, entity_id, supplier_id, storage_path,
  file_name, mime_type, document_kind, uploaded_by
) values (
  '81000000-0000-4000-8000-000000000900',
  '15000000-0000-4000-8000-000000000001', 'supplier',
  '35000000-0000-4000-8000-000000000001', '35000000-0000-4000-8000-000000000001',
  '15000000-0000-4000-8000-000000000001/supplier/35000000-0000-4000-8000-000000000001/81000000-0000-4000-8000-000000000900/dispatch.pdf',
  'dispatch.pdf', 'application/pdf', 'price_list',
  '25000000-0000-4000-8000-000000000001'
);
insert into public.document_processing_jobs (
  id, org_id, document_id, requested_by, status, input_checksum
) values (
  '82000000-0000-4000-8000-000000000900',
  '15000000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000900',
  '25000000-0000-4000-8000-000000000001', 'extracted', 'etag:' || repeat('9', 64)
);
insert into public.document_extractions (
  id, org_id, job_id, document_id, engine, model, model_version,
  input_checksum, contract_version, payload
) values (
  '83000000-0000-4000-8000-000000000900',
  '15000000-0000-4000-8000-000000000001',
  '82000000-0000-4000-8000-000000000900',
  '81000000-0000-4000-8000-000000000900', 'fixture', 'fixture-ocr', '1',
  'etag:' || repeat('9', 64), '1', pg_temp.p15_extraction_payload()
);
create temporary table p15_claimed as
select job_id from private.claim_document_interpretation_jobs(1, 20);
select pg_temp.p15_assert(
  (select array_agg(job_id) from p15_claimed)
    = array['82000000-0000-4000-8000-000000000900'::uuid],
  'eligible automatic interpretation job was not claimed exactly once'
);
select pg_temp.p15_assert(
  exists (
    select 1 from private.document_interpretation_dispatches
    where job_id = '82000000-0000-4000-8000-000000000900'
  ),
  'claim did not persist its dispatch ledger row'
);
insert into public.products (id, org_id, name, unit, sku, barcode) values
  ('45000000-0000-4000-8000-000000000001', '15000000-0000-4000-8000-000000000001', 'P15 one', 'unit', 'PRODUCT-ONE', '729000000001'),
  ('45000000-0000-4000-8000-000000000002', '15000000-0000-4000-8000-000000000001', 'P15 two', 'unit', 'PRODUCT-TWO', '729000000002'),
  ('45000000-0000-4000-8000-000000000003', '15000000-0000-4000-8000-000000000001', 'P15 ambiguous A', 'unit', 'AMB-A', '729999999999'),
  ('45000000-0000-4000-8000-000000000004', '15000000-0000-4000-8000-000000000001', 'P15 ambiguous B', 'unit', 'AMB-B', '729999999999');
insert into public.supplier_products (
  id, org_id, supplier_id, product_id, current_price,
  price_effective_date, available, supplier_sku
) values
  ('55000000-0000-4000-8000-000000000001', '15000000-0000-4000-8000-000000000001', '35000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000001', 10, '2026-07-01', true, 'SUPPLIER-ONE'),
  ('55000000-0000-4000-8000-000000000002', '15000000-0000-4000-8000-000000000001', '35000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000002', 20, '2026-07-01', true, null),
  ('55000000-0000-4000-8000-000000000003', '15000000-0000-4000-8000-000000000001', '35000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000003', 30, '2026-07-01', true, null),
  ('55000000-0000-4000-8000-000000000004', '15000000-0000-4000-8000-000000000001', '35000000-0000-4000-8000-000000000001', '45000000-0000-4000-8000-000000000004', 40, '2026-07-01', true, null);
insert into public.price_history (org_id, supplier_product_id, price, effective_date)
select org_id, id, current_price, price_effective_date
from public.supplier_products
where org_id = '15000000-0000-4000-8000-000000000001';

select pg_temp.p15_assert(
  not has_function_privilege('service_role',
    'public.p1b_submit_supplier_price_list_internal(uuid,uuid,date,text,text,text,jsonb,text)',
    'EXECUTE')
  and not has_function_privilege('service_role',
    'public.p1b_submit_supplier_price_list_internal(uuid,uuid,date,text,text,text,jsonb,text,uuid)',
    'EXECUTE')
  and not has_function_privilege('authenticated',
    'public.apply_price_list_interpretation(uuid,uuid,uuid)', 'EXECUTE')
  and has_function_privilege('service_role',
    'public.apply_price_list_interpretation(uuid,uuid,uuid)', 'EXECUTE'),
  'the old writer or the new command ACL was widened'
);

-- An unconfigured tenant is OFF: the decision is explainable, but prices and history do not move.
select pg_temp.p15_seed(1, jsonb_build_array(
  pg_temp.p15_line(1, 'SUPPLIER-ONE', null, '11'),
  pg_temp.p15_line(2, null, '729000000002', '21')
))::text as interpretation
\gset off_
select count(*) as history_before from public.price_history
where org_id = '15000000-0000-4000-8000-000000000001'
\gset off_
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.apply_price_list_interpretation(
  (select job_id from public.document_interpretations where id = :'off_interpretation'::uuid),
  :'off_interpretation'::uuid, null
)::text as result
\gset off_
reset role;
select pg_temp.p15_assert(
  :'off_result'::jsonb ->> 'reason_code' = 'autonomy_disabled'
  and (select current_price = 10 from public.supplier_products where id = '55000000-0000-4000-8000-000000000001')
  and (select current_price = 20 from public.supplier_products where id = '55000000-0000-4000-8000-000000000002')
  and (select count(*) = :'off_history_before'::integer from public.price_history where org_id = '15000000-0000-4000-8000-000000000001'),
  'OFF changed a price or price_history'
);

insert into public.org_autonomy_policies (
  org_id, policy_key, autonomy_enabled, min_confidence
) values (
  '15000000-0000-4000-8000-000000000001', 'price_list.intake', true, 0.900
);

-- Two products sharing the barcode are an ambiguity, never a first-row-wins match.
select pg_temp.p15_seed(2, jsonb_build_array(
  pg_temp.p15_line(1, null, '729999999999', '99')
))::text as interpretation
\gset ambiguous_
select count(*) as history_before from public.price_history
where org_id = '15000000-0000-4000-8000-000000000001'
\gset ambiguous_
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.apply_price_list_interpretation(
  (select job_id from public.document_interpretations where id = :'ambiguous_interpretation'::uuid),
  :'ambiguous_interpretation'::uuid, null
)::text as result
\gset ambiguous_
reset role;
select pg_temp.p15_assert(
  :'ambiguous_result'::jsonb ->> 'outcome' = 'queued_for_review'
  and :'ambiguous_result'::jsonb ->> 'reason_code' = 'line_product_ambiguous'
  and (select count(*) = :'ambiguous_history_before'::integer from public.price_history where org_id = '15000000-0000-4000-8000-000000000001')
  and (select current_price = 30 from public.supplier_products where id = '55000000-0000-4000-8000-000000000003')
  and (select current_price = 40 from public.supplier_products where id = '55000000-0000-4000-8000-000000000004'),
  'an ambiguous barcode mutated a price'
);

-- Three rows: supplier SKU, product barcode, and one unkeyed name that must remain waiting.
select pg_temp.p15_seed(3, jsonb_build_array(
  pg_temp.p15_line(1, 'SUPPLIER-ONE', null, '12.50'),
  pg_temp.p15_line(2, null, '729000000002', '22.75'),
  pg_temp.p15_line(3, null, null, '7', 'P15 has no key and must wait')
))::text as interpretation
\gset partial_
select count(*) as history_before from public.price_history
where org_id = '15000000-0000-4000-8000-000000000001'
\gset partial_
select count(*) as products_before from public.products
where org_id = '15000000-0000-4000-8000-000000000001'
\gset partial_
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.apply_price_list_interpretation(
  (select job_id from public.document_interpretations where id = :'partial_interpretation'::uuid),
  :'partial_interpretation'::uuid, null
)::text as result
\gset partial_
reset role;
select pg_temp.p15_assert(
  :'partial_result'::jsonb ->> 'outcome' = 'partially_applied'
  and (:'partial_result'::jsonb ->> 'accepted_count')::integer = 2
  and (:'partial_result'::jsonb ->> 'waiting_count')::integer = 1
  and (select current_price = 12.50 from public.supplier_products where id = '55000000-0000-4000-8000-000000000001')
  and (select current_price = 22.75 from public.supplier_products where id = '55000000-0000-4000-8000-000000000002')
  and (select count(*) = :'partial_history_before'::integer + 2 from public.price_history where org_id = '15000000-0000-4000-8000-000000000001')
  and (select count(*) = :'partial_products_before'::integer from public.products where org_id = '15000000-0000-4000-8000-000000000001')
  and not exists (select 1 from public.products where name = 'P15 has no key and must wait')
  and (select count(*) = 2 from public.price_list_interpretation_lines where interpretation_id = :'partial_interpretation'::uuid and outcome = 'applied')
  and (select count(*) = 1 from public.price_list_interpretation_lines where interpretation_id = :'partial_interpretation'::uuid and outcome = 'waiting' and reason_code = 'line_product_unmatched'),
  'partial intake did not produce exactly two prices and one explained waiting row'
);

-- A retry is idempotent, and reversal is a separate reasoned command with compensating history.
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.apply_price_list_interpretation(
  (select job_id from public.document_interpretations where id = :'partial_interpretation'::uuid),
  :'partial_interpretation'::uuid, null
)::text as retry
\gset partial_
reset role;
select pg_temp.p15_assert(
  (:'partial_retry'::jsonb ->> 'idempotent')::boolean
  and (select count(*) = :'partial_history_before'::integer + 2 from public.price_history where org_id = '15000000-0000-4000-8000-000000000001'),
  'retry wrote a second set of prices'
);

select set_config('request.jwt.claim.sub', '25000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
do $$
begin
  perform public.revert_price_list_auto_action(
    (select id from public.price_list_interpretation_decisions
      where interpretation_id = '84000000-0000-4000-8000-000000000003'),
    '   '
  );
  raise exception 'expected reason_required';
exception when sqlstate '22023' then
  if sqlerrm <> 'reason_required' then raise; end if;
end
$$;
select public.revert_price_list_auto_action(
  (select id from public.price_list_interpretation_decisions
    where interpretation_id = :'partial_interpretation'::uuid),
  'P15 verified compensating reversal'
)::text as reversal
\gset partial_
reset role;
select pg_temp.p15_assert(
  (:'partial_reversal'::jsonb ->> 'reverted_price_count')::integer = 2
  and (select current_price = 10 from public.supplier_products where id = '55000000-0000-4000-8000-000000000001')
  and (select current_price = 20 from public.supplier_products where id = '55000000-0000-4000-8000-000000000002')
  and (select count(*) = :'partial_history_before'::integer + 4 from public.price_history where org_id = '15000000-0000-4000-8000-000000000001')
  and (select reverted_reason = 'P15 verified compensating reversal' from public.price_list_interpretation_decisions where interpretation_id = :'partial_interpretation'::uuid),
  'reasoned reversal did not restore the two prior prices'
);

-- A genuinely new keyed row creates the catalog product and its supplier price atomically.
select count(*) as products_before from public.products
where org_id = '15000000-0000-4000-8000-000000000001'
\gset created_
select count(*) as history_before from public.price_history
where org_id = '15000000-0000-4000-8000-000000000001'
\gset created_
select pg_temp.p15_seed(4, jsonb_build_array(
  pg_temp.p15_line(1, 'BRAND-NEW-400', '729400000004', '44.90', 'P15 newly catalogued')
))::text as interpretation
\gset created_
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.apply_price_list_interpretation(
  (select job_id from public.document_interpretations where id = :'created_interpretation'::uuid),
  :'created_interpretation'::uuid, null
)::text as result
\gset created_
reset role;
select pg_temp.p15_assert(
  :'created_result'::jsonb ->> 'outcome' = 'auto_applied'
  and (:'created_result'::jsonb ->> 'created_product_count')::integer = 1
  and (select count(*) = :'created_products_before'::integer + 1 from public.products where org_id = '15000000-0000-4000-8000-000000000001')
  and exists (
    select 1
    from public.products p
    join public.supplier_products sp on sp.org_id = p.org_id and sp.product_id = p.id
    where p.org_id = '15000000-0000-4000-8000-000000000001'
      and p.name = 'P15 newly catalogued' and p.sku = 'BRAND-NEW-400'
      and p.barcode = '729400000004' and p.active
      and sp.supplier_id = '35000000-0000-4000-8000-000000000001'
      and sp.current_price = 44.90 and sp.available
  )
  and (select count(*) = :'created_history_before'::integer + 1 from public.price_history where org_id = '15000000-0000-4000-8000-000000000001')
  and exists (
    select 1 from public.price_list_interpretation_lines
    where interpretation_id = :'created_interpretation'::uuid
      and outcome = 'applied' and product_created
  ),
  'a new keyed price-list row did not create one product and one price'
);

select set_config('request.jwt.claim.sub', '25000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select public.revert_price_list_auto_action(
  (select id from public.price_list_interpretation_decisions
    where interpretation_id = :'created_interpretation'::uuid),
  'P15 soft-deactivates an automatically created product'
);
reset role;
select pg_temp.p15_assert(
  exists (
    select 1
    from public.products p
    join public.supplier_products sp on sp.org_id = p.org_id and sp.product_id = p.id
    where p.org_id = '15000000-0000-4000-8000-000000000001'
      and p.name = 'P15 newly catalogued' and not p.active and not sp.available
  ),
  'reversal did not soft-deactivate the automatically created product'
);

rollback;

\echo 'P15 automatic price-list intake checks passed.'
