-- P18 -- price-list shadow/calibration/drift and document operations read models.
-- Runs against a freshly reset disposable database.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p18_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P18 document automation calibration assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p18_platform_claims(p_offset interval default null)
returns void language plpgsql as $$
declare
  v_platform uuid := '2a000000-0000-4000-8000-000000000001';
  v_claims jsonb;
begin
  v_claims := jsonb_build_object('sub', v_platform, 'role', 'authenticated');
  if p_offset is not null then
    v_claims := v_claims || jsonb_build_object(
      'amr', jsonb_build_array(jsonb_build_object(
        'method', 'password',
        'timestamp', extract(epoch from clock_timestamp() + p_offset)::bigint
      ))
    );
  end if;
  perform set_config('request.jwt.claim.sub', v_platform::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', v_claims::text, true);
end
$$;

select pg_temp.p18_assert(
  private.price_list_layout_signature(
    '{"blocks":[{"page":1,"type":"text"}],"tables":[{"page":1,"rows":[["a","b","c"]]}]}'::jsonb,
    'application/pdf'
  ) = private.price_list_layout_signature(
    '{"blocks":[{"page":1,"type":"text"},{"page":2,"type":"text"}],"tables":[{"page":1,"rows":[["a","b","c"],["d","e","f"]]},{"page":2,"rows":[["g","h","i"]]}]}'::jsonb,
    'application/pdf'
  ),
  'continuation pages or repeated rows changed the structural layout signature'
);
select pg_temp.p18_assert(
  private.price_list_layout_signature(
    '{"blocks":[{"page":1,"type":"text"}],"tables":[{"rows":[["a","b","c"]]}]}'::jsonb,
    'application/pdf'
  ) <> private.price_list_layout_signature(
    '{"blocks":[{"page":1,"type":"text"}],"tables":[{"rows":[["a","b","c","d"]]}]}'::jsonb,
    'application/pdf'
  )
  and private.price_list_layout_signature(
    '{"blocks":[{"page":1,"type":"text"}],"tables":[{"rows":[["a","b","c"]]}]}'::jsonb,
    'application/pdf'
  ) <> private.price_list_layout_signature(
    '{"blocks":[{"page":1,"type":"text"},{"page":1,"type":"barcode"}],"tables":[{"rows":[["a","b","c"]]}]}'::jsonb,
    'application/pdf'
  ),
  'changed column shape or block type did not change the layout signature'
);
select pg_temp.p18_assert(
  private.price_list_layout_signature(
    '{"schema_version":"1","blocks":[{"page":1,"type":"table"}],"tables":[{"rows":[[{"text":"  מוצר","bbox":null},{"text":"SKU","bbox":null},{"text":"מחיר  ","bbox":null}],[{"text":"א","bbox":null},{"text":"1","bbox":null},{"text":"10","bbox":null}]]}]}'::jsonb,
    'application/pdf'
  ) = private.price_list_layout_signature(
    '{"schema_version":"1","blocks":[{"page":1,"type":"table"},{"page":2,"type":"table"}],"tables":[{"rows":[[{"text":"מוצר","bbox":null},{"text":"sku","bbox":null},{"text":"מחיר","bbox":null}],[{"text":"ב","bbox":null},{"text":"2","bbox":null},{"text":"20","bbox":null}]]},{"rows":[[{"text":"מוצר","bbox":null},{"text":"SKU","bbox":null},{"text":"מחיר","bbox":null}],[{"text":"ג","bbox":null},{"text":"3","bbox":null},{"text":"30","bbox":null}]]}]}'::jsonb,
    'application/pdf'
  ),
  'normalized headers, repeated rows or continuation tables changed the layout signature'
);
select pg_temp.p18_assert(
  private.price_list_layout_signature(
    '{"schema_version":"1","blocks":[{"type":"table"}],"tables":[{"rows":[[{"text":"מוצר"},{"text":"SKU"},{"text":"מחיר"}]]}]}'::jsonb,
    'application/pdf'
  ) <> private.price_list_layout_signature(
    '{"schema_version":"1","blocks":[{"type":"table"}],"tables":[{"rows":[[{"text":"מוצר"},{"text":"מחיר"},{"text":"SKU"}]]}]}'::jsonb,
    'application/pdf'
  )
  and private.price_list_layout_signature(
    '{"schema_version":"1","blocks":[{"type":"table"}],"tables":[{"rows":[[{"text":"מוצר"},{"text":"SKU"},{"text":"מחיר"}]]}]}'::jsonb,
    'application/pdf'
  ) <> private.price_list_layout_signature(
    '{"schema_version":"2","blocks":[{"type":"table"}],"tables":[{"rows":[[{"text":"מוצר"},{"text":"SKU"},{"text":"מחיר"}]]}]}'::jsonb,
    'application/pdf'
  ),
  'header order or extraction contract version did not change the layout signature'
);

-- A missing custom GUC is NULL in a fresh session. The immutable evidence
-- triggers must fail closed before any RPC initializes their writer setting.
select pg_temp.p18_assert(
  current_setting('app.price_list_shadow_writer', true) is null,
  'shadow writer setting was unexpectedly initialized'
);
select pg_temp.p18_assert(
  current_setting('app.price_list_calibration_writer', true) is null,
  'calibration writer setting was unexpectedly initialized'
);
select pg_temp.p18_assert(
  current_setting('app.price_list_empty_review_writer', true) is null,
  'empty-run review writer setting was unexpectedly initialized'
);
select pg_temp.p18_assert(
  current_setting('app.price_list_scope_writer', true) is null,
  'scope decision writer setting was unexpectedly initialized'
);

do $$
declare
  v_blocked boolean := false;
begin
  begin
    insert into public.price_list_shadow_runs default values;
  exception when sqlstate '42501' then
    v_blocked := sqlerrm = 'price_list_shadow_writer_required';
  end;
  if not v_blocked then
    raise exception 'P18 document automation calibration assertion failed: fresh-session shadow insert did not fail closed';
  end if;

  v_blocked := false;
  begin
    insert into public.price_list_shadow_lines default values;
  exception when sqlstate '42501' then
    v_blocked := sqlerrm = 'price_list_shadow_writer_required';
  end;
  if not v_blocked then
    raise exception 'P18 document automation calibration assertion failed: fresh-session shadow-line insert did not fail closed';
  end if;

  v_blocked := false;
  begin
    insert into public.price_list_calibration_reviews default values;
  exception when sqlstate '42501' then
    v_blocked := sqlerrm = 'price_list_calibration_writer_required';
  end;
  if not v_blocked then
    raise exception 'P18 document automation calibration assertion failed: fresh-session calibration insert did not fail closed';
  end if;

  v_blocked := false;
  begin
    insert into public.price_list_empty_run_reviews default values;
  exception when sqlstate '42501' then
    v_blocked := sqlerrm = 'price_list_empty_review_writer_required';
  end;
  if not v_blocked then
    raise exception 'P18 document automation calibration assertion failed: fresh-session empty-run review insert did not fail closed';
  end if;

  v_blocked := false;
  begin
    insert into public.price_list_automation_scope_decisions default values;
  exception when sqlstate '42501' then
    v_blocked := sqlerrm = 'price_list_scope_writer_required';
  end;
  if not v_blocked then
    raise exception 'P18 document automation calibration assertion failed: fresh-session scope decision insert did not fail closed';
  end if;
end
$$;

create function pg_temp.p18_extraction_payload()
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'schema_version', '1',
    'document', jsonb_build_object(
      'page_count', 1,
      'detected_languages', jsonb_build_array('he'),
      'plain_text', 'מחירון כיול',
      'partial', false
    ),
    'blocks', jsonb_build_array(jsonb_build_object(
      'id', 'block-1', 'page', 1, 'type', 'text',
      'bbox', jsonb_build_array(0, 0, 1, 1),
      'text', 'מחירון כיול', 'confidence', 0.99
    )),
    'tables', '[]'::jsonb,
    'marks', '[]'::jsonb
  )
$$;

create function pg_temp.p18_table_extraction_payload(p_headers text[])
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'schema_version', '1',
    'document', jsonb_build_object(
      'page_count', 1,
      'detected_languages', jsonb_build_array('he'),
      'plain_text', array_to_string(p_headers, E'\t'),
      'partial', false
    ),
    'blocks', jsonb_build_array(jsonb_build_object(
      'id', 'table-block-1', 'page', 1, 'type', 'table',
      'bbox', jsonb_build_array(0, 0, 1, 1),
      'text', array_to_string(p_headers, E'\t'), 'confidence', 0.99
    )),
    'tables', jsonb_build_array(jsonb_build_object(
      'id', 'table-1', 'page', 1, 'bbox', jsonb_build_array(0, 0, 1, 1),
      'rows', jsonb_build_array((
        select jsonb_agg(
          jsonb_build_object('text', header_value, 'bbox', null)
          order by header_ordinality
        )
        from unnest(p_headers) with ordinality as header(header_value, header_ordinality)
      ))
    )),
    'marks', '[]'::jsonb
  )
$$;

create function pg_temp.p18_line(
  p_row integer,
  p_sku text,
  p_barcode text,
  p_price text,
  p_product_name text default null
) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'source_row', p_row,
    'values', jsonb_strip_nulls(jsonb_build_object(
      'sku', p_sku,
      'barcode', p_barcode,
      'unit_price', p_price,
      'product_name', p_product_name,
      'unit', 'יח'''
    )),
    'evidence_block_ids', jsonb_build_array('block-1')
  )
$$;

create function pg_temp.p18_interpretation_payload(
  p_confidence numeric,
  p_lines jsonb
) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'schema_version', '1',
    'document_type', 'price_list',
    'document_type_confidence', p_confidence,
    'supplier', jsonb_build_object(
      'suggested_id', '38000000-0000-4000-8000-000000000001',
      'suggested_name', 'P18 supplier',
      'confidence', p_confidence,
      'evidence_block_ids', jsonb_build_array('block-1')
    ),
    'fields', '[]'::jsonb,
    'line_items', p_lines,
    'suggested_annotations', '[]'::jsonb
  )
$$;

create function pg_temp.p18_seed_interpretation(
  p_n integer,
  p_confidence numeric,
  p_lines jsonb,
  p_actor uuid default '28000000-0000-4000-8000-000000000001',
  p_extraction_payload jsonb default null
) returns uuid language plpgsql as $$
declare
  v_org constant uuid := '18000000-0000-4000-8000-000000000001';
  v_user uuid := p_actor;
  v_supplier constant uuid := '38000000-0000-4000-8000-000000000001';
  v_doc uuid := ('88000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
  v_job uuid := ('89000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
  v_ext uuid := ('8a000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
  v_int uuid := ('8b000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
  v_etag text := repeat((p_n % 10)::text, 64);
  v_path text := v_org::text || '/supplier/' || v_supplier::text || '/'
    || v_doc::text || '/p18.pdf';
begin
  insert into storage.objects (bucket_id, name, owner, metadata)
  values (
    'documents', v_path, v_user,
    jsonb_build_object(
      'mimetype', 'application/pdf', 'size', 2048, 'eTag', v_etag
    )
  );

  insert into public.documents (
    id, org_id, entity_type, entity_id, supplier_id, storage_path,
    file_name, mime_type, document_kind, uploaded_by
  ) values (
    v_doc, v_org, 'supplier', v_supplier, v_supplier,
    v_path,
    'p18-' || p_n || '.pdf', 'application/pdf', 'other', v_user
  );

  insert into public.document_processing_jobs (
    id, org_id, document_id, requested_by, status, input_checksum,
    interpretation_actor_id, interpretation_started_at, attempt_count
  ) values (
    v_job, v_org, v_doc, v_user, 'review', 'etag:' || v_etag,
    v_user, statement_timestamp(), 2
  );

  insert into public.document_extractions (
    id, org_id, job_id, document_id, engine, model, model_version,
    input_checksum, contract_version, payload, duration_ms, resource_metadata
  ) values (
    v_ext, v_org, v_job, v_doc, 'fixture', 'fixture-ocr', 'fixture-ocr-v1',
    'etag:' || v_etag, '1', coalesce(p_extraction_payload, pg_temp.p18_extraction_payload()), 120,
    jsonb_build_object('worker_version', 'p18')
  );

  insert into public.document_interpretations (
    id, org_id, job_id, extraction_id, document_id, interpreted_for_user_id,
    provider, model, prompt_version, schema_version, payload, usage, duration_ms
  ) values (
    v_int, v_org, v_job, v_ext, v_doc, v_user,
    'openai', 'gpt-p18-fixture', 'interpret-document-v8', '1',
    pg_temp.p18_interpretation_payload(p_confidence, p_lines),
    jsonb_build_object(
      'input_tokens', 100, 'cached_input_tokens', 20, 'output_tokens', 50
    ),
    240
  );
  return v_int;
end
$$;

insert into public.organizations (id, name, status) values
  ('18000000-0000-4000-8000-000000000001', 'P18 tenant A', 'active'),
  ('19000000-0000-4000-8000-000000000001', 'P18 tenant B', 'active');

insert into auth.users (id, email) values
  ('28000000-0000-4000-8000-000000000001', 'owner-a-p18@example.test'),
  ('28000000-0000-4000-8000-000000000002', 'office-a-p18@example.test'),
  ('28000000-0000-4000-8000-000000000003', 'office-a-p18-2@example.test'),
  ('29000000-0000-4000-8000-000000000001', 'owner-b-p18@example.test'),
  ('2a000000-0000-4000-8000-000000000001', 'platform-p18@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('28000000-0000-4000-8000-000000000001',
   '18000000-0000-4000-8000-000000000001', 'P18 owner A', 'owner'),
  ('28000000-0000-4000-8000-000000000002',
   '18000000-0000-4000-8000-000000000001', 'P18 office A', 'office'),
  ('28000000-0000-4000-8000-000000000003',
   '18000000-0000-4000-8000-000000000001', 'P18 office A', 'office'),
  ('29000000-0000-4000-8000-000000000001',
   '19000000-0000-4000-8000-000000000001', 'P18 owner B', 'owner');

insert into public.platform_admins (user_id, note) values
  ('2a000000-0000-4000-8000-000000000001', 'P18 platform operator');

insert into public.suppliers (id, org_id, name, status) values
  ('38000000-0000-4000-8000-000000000001',
   '18000000-0000-4000-8000-000000000001', 'P18 supplier', 'active'),
  ('39000000-0000-4000-8000-000000000001',
   '19000000-0000-4000-8000-000000000001', 'P18 supplier B', 'active');

insert into public.products (id, org_id, name, unit, sku, barcode) values
  ('48000000-0000-4000-8000-000000000001',
   '18000000-0000-4000-8000-000000000001', 'P18 existing', 'יח''',
   'EXIST-1', '729180000001'),
  ('48000000-0000-4000-8000-000000000002',
   '18000000-0000-4000-8000-000000000001', 'P18 human expected', 'יח''',
   'EXPECTED-2', '729180000002'),
  ('49000000-0000-4000-8000-000000000001',
   '19000000-0000-4000-8000-000000000001', 'P18 tenant B product', 'יח''',
   'TENANT-B', '729190000001');

insert into public.supplier_products (
  id, org_id, supplier_id, product_id, current_price, price_effective_date,
  available, supplier_sku
) values (
  '58000000-0000-4000-8000-000000000001',
  '18000000-0000-4000-8000-000000000001',
  '38000000-0000-4000-8000-000000000001',
  '48000000-0000-4000-8000-000000000001',
  10.00, current_date, true, 'EXIST-1'
);

select pg_temp.p18_seed_interpretation(1, 0.99, jsonb_build_array(
  pg_temp.p18_line(1, 'EXIST-1', '729180000001', '12.00', 'P18 existing'),
  pg_temp.p18_line(2, 'NEW-2', '729180009999', '20.00', 'P18 proposed new'),
  pg_temp.p18_line(3, null, null, '8.00', 'P18 missing identity')
)) as first_interpretation \gset

select pg_temp.p18_seed_interpretation(2, 0.80, jsonb_build_array(
  pg_temp.p18_line(1, 'EXIST-1', '729180000001', '13.00', 'P18 existing')
)) as low_confidence_interpretation \gset

create temporary table p18_business_before as
select
  (select count(*) from public.products
    where org_id = '18000000-0000-4000-8000-000000000001') as products,
  (select count(*) from public.supplier_products
    where org_id = '18000000-0000-4000-8000-000000000001') as supplier_products,
  (select count(*) from public.price_history
    where org_id = '18000000-0000-4000-8000-000000000001') as price_history,
  (select count(*) from public.supplier_price_submissions
    where org_id = '18000000-0000-4000-8000-000000000001') as submissions,
  (select count(*) from public.price_list_interpretation_decisions
    where org_id = '18000000-0000-4000-8000-000000000001') as live_decisions;

select pg_temp.p18_assert(
  not exists (
    select 1 from public.org_autonomy_policies
    where org_id = '18000000-0000-4000-8000-000000000001'
      and policy_key = 'price_list.intake'
  ),
  'fixture unexpectedly started with a live autonomy configuration'
);

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.run_price_list_shadow(
  '89000000-0000-4000-8000-000000000001',
  :'first_interpretation'::uuid,
  '28000000-0000-4000-8000-000000000001'
)::text as first_shadow \gset
select public.run_price_list_shadow(
  '89000000-0000-4000-8000-000000000001',
  :'first_interpretation'::uuid,
  '28000000-0000-4000-8000-000000000001'
)::text as first_shadow_replay \gset
select public.run_price_list_shadow(
  '89000000-0000-4000-8000-000000000002',
  :'low_confidence_interpretation'::uuid,
  '28000000-0000-4000-8000-000000000001'
)::text as low_confidence_shadow \gset
reset role;

select set_config(
  'p18.first_shadow_id', :'first_shadow'::jsonb ->> 'shadow_run_id', true
);

do $$
declare
  v_a public.price_list_shadow_runs;
  v_b public.price_list_shadow_runs;
begin
  select * into v_a from public.price_list_shadow_runs
  where id = current_setting('p18.first_shadow_id')::uuid;
  v_b := v_a;
  v_a.model := 'model|segment';
  v_a.prompt_version := 'prompt';
  v_b.model := 'model';
  v_b.prompt_version := 'segment|prompt';
  if private.price_list_scope_fingerprint(v_a) = private.price_list_scope_fingerprint(v_b) then
    raise exception 'P18 document automation calibration assertion failed: scope fingerprint has a field-boundary collision';
  end if;
  v_b := v_a;
  v_b.decision_confidence := 0.42;
  v_b.applicable_count := v_a.applicable_count + 100;
  v_b.waiting_count := v_a.waiting_count + 100;
  v_b.would_create_product_count := v_a.would_create_product_count + 100;
  if private.price_list_scope_fingerprint(v_a) <> private.price_list_scope_fingerprint(v_b) then
    raise exception 'P18 document automation calibration assertion failed: numeric telemetry changed an eligible fingerprint';
  end if;
  v_b := v_a;
  v_b.evaluated_min_confidence := v_a.evaluated_min_confidence - 0.01;
  if private.price_list_scope_fingerprint(v_a) = private.price_list_scope_fingerprint(v_b) then
    raise exception 'P18 document automation calibration assertion failed: explicit configured policy change preserved an eligible fingerprint';
  end if;
end
$$;

select pg_temp.p18_assert(
  :'first_shadow'::jsonb ->> 'predicted_outcome' = 'partially_applicable'
  and (:'first_shadow'::jsonb ->> 'applicable_count')::integer = 2
  and (:'first_shadow'::jsonb ->> 'waiting_count')::integer = 1
  and (:'first_shadow'::jsonb ->> 'would_create_product_count')::integer = 1
  and not (:'first_shadow'::jsonb ->> 'idempotent')::boolean,
  'high-confidence shadow did not preserve the two applicable/one review prediction'
);
select pg_temp.p18_assert(
  (:'first_shadow_replay'::jsonb ->> 'idempotent')::boolean
  and :'first_shadow_replay'::jsonb ->> 'shadow_run_id'
    = :'first_shadow'::jsonb ->> 'shadow_run_id'
  and (select count(*) = 1 from public.price_list_shadow_runs
       where interpretation_id = :'first_interpretation'::uuid),
  'shadow replay created a duplicate immutable run'
);
select pg_temp.p18_assert(
  :'low_confidence_shadow'::jsonb ->> 'predicted_outcome' = 'queued_for_review'
  and :'low_confidence_shadow'::jsonb ->> 'reason_code' = 'below_confidence_threshold'
  and (select predicted_action = 'rejected_by_policy'
       from public.price_list_shadow_lines
       where shadow_run_id = (:'low_confidence_shadow'::jsonb ->> 'shadow_run_id')::uuid),
  'below-threshold shadow was not measured as a non-mutating policy rejection'
);

select pg_temp.p18_assert(
  exists (
    select 1 from public.price_list_shadow_runs r
    where r.id = (:'first_shadow'::jsonb ->> 'shadow_run_id')::uuid
      and r.execution_mode = 'shadow'
      and not r.policy_configured
      and not r.live_policy_enabled
      and r.evaluated_min_confidence = 0.900
      and r.provider = 'openai'
      and r.model = 'gpt-p18-fixture'
      and r.prompt_version = 'interpret-document-v8'
      and r.document_format = 'application/pdf'
      and r.layout_signature ~ '^[0-9a-f]{64}$'
  ),
  'shadow run did not preserve policy/version/format/layout measurement metadata'
);
select pg_temp.p18_assert(
  exists (
    select 1 from public.price_list_shadow_lines l
    where l.shadow_run_id = (:'first_shadow'::jsonb ->> 'shadow_run_id')::uuid
      and l.line_index = 0
      and l.predicted_action = 'apply_existing_price'
      and l.product_id = '48000000-0000-4000-8000-000000000001'
      and l.matched_by = 'supplier_sku'
      and l.current_unit_price = 10 and l.proposed_unit_price = 12
      and l.price_change_percent = 20
      and l.evidence_block_ids = array['block-1']::text[]
  ),
  'existing-product shadow line lost its identity/price/evidence snapshot'
);

select pg_temp.p18_assert(
  (select row(products, supplier_products, price_history, submissions, live_decisions)
     from p18_business_before)
  = row(
    (select count(*) from public.products
      where org_id = '18000000-0000-4000-8000-000000000001'),
    (select count(*) from public.supplier_products
      where org_id = '18000000-0000-4000-8000-000000000001'),
    (select count(*) from public.price_history
      where org_id = '18000000-0000-4000-8000-000000000001'),
    (select count(*) from public.supplier_price_submissions
      where org_id = '18000000-0000-4000-8000-000000000001'),
    (select count(*) from public.price_list_interpretation_decisions
      where org_id = '18000000-0000-4000-8000-000000000001')
  ),
  'shadow evaluation mutated catalog, price, submission, or live-decision state'
);
select pg_temp.p18_assert(
  not exists (
    select 1 from public.org_autonomy_policies
    where org_id = '18000000-0000-4000-8000-000000000001'
      and policy_key = 'price_list.intake'
  ),
  'shadow evaluation changed the live policy or threshold'
);

select id as existing_shadow_line
from public.price_list_shadow_lines
where shadow_run_id = (:'first_shadow'::jsonb ->> 'shadow_run_id')::uuid
  and line_index = 0
\gset
select id as new_product_shadow_line
from public.price_list_shadow_lines
where shadow_run_id = (:'first_shadow'::jsonb ->> 'shadow_run_id')::uuid
  and line_index = 1
\gset
select id as ambiguous_shadow_line
from public.price_list_shadow_lines
where shadow_run_id = (:'first_shadow'::jsonb ->> 'shadow_run_id')::uuid
  and line_index = 2
\gset
select set_config('p18.existing_shadow_line', :'existing_shadow_line', true);
select set_config(
  'p18.first_shadow_run', :'first_shadow'::jsonb ->> 'shadow_run_id', true
);
select set_config(
  'p18.low_shadow_run', :'low_confidence_shadow'::jsonb ->> 'shadow_run_id', true
);

select set_config(
  'request.jwt.claim.sub', '28000000-0000-4000-8000-000000000001', true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select public.record_price_list_calibration_review(
  :'existing_shadow_line'::uuid,
  '68000000-0000-4000-8000-000000000001',
  'incorrect',
  array['incorrect_product_match', 'incorrect_price']::text[],
  'apply_existing_price',
  '48000000-0000-4000-8000-000000000002',
  11.50,
  'P18 human correction'
)::text as existing_review \gset
select public.record_price_list_calibration_review(
  :'existing_shadow_line'::uuid,
  '68000000-0000-4000-8000-000000000001',
  'incorrect',
  array['incorrect_product_match', 'incorrect_price']::text[],
  'apply_existing_price',
  '48000000-0000-4000-8000-000000000002',
  11.50,
  'P18 human correction'
)::text as existing_review_replay \gset
select public.record_price_list_calibration_review(
  :'existing_shadow_line'::uuid,
  '68000000-0000-4000-8000-000000000002',
  'incorrect',
  array['incorrect_product_match', 'incorrect_price']::text[],
  'apply_existing_price',
  '48000000-0000-4000-8000-000000000002',
  11.50,
  'P18 human confirmation'
)::text as existing_review_revision \gset
select public.record_price_list_calibration_review(
  :'new_product_shadow_line'::uuid,
  '68000000-0000-4000-8000-000000000003',
  'incorrect', array['incorrect_new_product']::text[],
  'review', null, null,
  'P18 product creation rejected by human'
)::text as new_product_review \gset
select public.record_price_list_calibration_review(
  :'ambiguous_shadow_line'::uuid,
  '68000000-0000-4000-8000-000000000004',
  'ambiguous', array['ambiguous']::text[],
  'review', null, null,
  'P18 identity is ambiguous'
)::text as ambiguous_review \gset

select pg_temp.p18_assert(
  not (:'existing_review'::jsonb ->> 'idempotent')::boolean
  and (:'existing_review_replay'::jsonb ->> 'idempotent')::boolean
  and :'existing_review_replay'::jsonb ->> 'review_id'
    = :'existing_review'::jsonb ->> 'review_id'
  and (:'existing_review_revision'::jsonb ->> 'revision')::integer = 2
  and (select count(*) = 2 from public.price_list_calibration_reviews
       where shadow_line_id = :'existing_shadow_line'::uuid),
  'human review idempotency/revision ledger is not append-only and stable'
);

do $$
begin
  perform public.record_price_list_calibration_review(
    current_setting('p18.existing_shadow_line')::uuid,
    '68000000-0000-4000-8000-000000000098',
    'correct', '{}'::text[], 'apply_existing_price',
    '48000000-0000-4000-8000-000000000002', 12.00,
    'P18 contradictory correct verdict'
  );
  raise exception 'expected calibration_review_contradicts_prediction';
exception when sqlstate '22023' then
  if sqlerrm <> 'calibration_review_contradicts_prediction' then raise; end if;
end
$$;

do $$
begin
  perform public.record_price_list_calibration_review(
    current_setting('p18.existing_shadow_line')::uuid,
    '68000000-0000-4000-8000-000000000096',
    'incorrect', array['incorrect_product_match']::text[],
    'apply_existing_price',
    '48000000-0000-4000-8000-000000000001', 11.50,
    'P18 mismatched product-error label'
  );
  raise exception 'expected calibration_review_label_mismatch';
exception when sqlstate '22023' then
  if sqlerrm <> 'calibration_review_label_mismatch' then raise; end if;
end
$$;

do $$
begin
  perform public.record_price_list_calibration_review(
    current_setting('p18.existing_shadow_line')::uuid,
    '68000000-0000-4000-8000-000000000097',
    'incorrect', array['incorrect_price']::text[],
    'apply_existing_price',
    '48000000-0000-4000-8000-000000000002', 12.00,
    'P18 mismatched price-error label'
  );
  raise exception 'expected calibration_review_label_mismatch';
exception when sqlstate '22023' then
  if sqlerrm <> 'calibration_review_label_mismatch' then raise; end if;
end
$$;

do $$
begin
  perform public.record_price_list_calibration_review(
    current_setting('p18.existing_shadow_line')::uuid,
    '68000000-0000-4000-8000-000000000001',
    'incorrect', array['incorrect_price']::text[],
    'apply_existing_price',
    '48000000-0000-4000-8000-000000000002', 9.99,
    'P18 conflicting replay'
  );
  raise exception 'expected calibration_review_idempotency_conflict';
exception when sqlstate '55000' then
  if sqlerrm <> 'calibration_review_idempotency_conflict' then raise; end if;
end
$$;

do $$
begin
  perform public.record_price_list_calibration_review(
    current_setting('p18.existing_shadow_line')::uuid,
    '68000000-0000-4000-8000-000000000099',
    'incorrect', array['incorrect_product_match']::text[],
    'apply_existing_price',
    '49000000-0000-4000-8000-000000000001', 11.50,
    'P18 cross-tenant expected product'
  );
  raise exception 'expected cross-tenant product FK rejection';
exception when foreign_key_violation then null;
end
$$;

reset role;
select pg_temp.p18_platform_claims();
set local role authenticated;
do $$
begin
  perform public.platform_set_price_list_automation_scope(
    '18000000-0000-4000-8000-000000000001',
    current_setting('p18.low_shadow_run')::uuid,
    'shadow_only', '6a000000-0000-4000-8000-000000000090',
    'P18 missing password proof'
  );
  raise exception 'expected fresh_authentication_required without amr';
exception when sqlstate '42501' then
  if sqlerrm <> 'fresh_authentication_required' then raise; end if;
end
$$;
reset role;
select pg_temp.p18_platform_claims(interval '-6 minutes');
set local role authenticated;
do $$
begin
  perform public.platform_set_price_list_automation_scope(
    '18000000-0000-4000-8000-000000000001',
    current_setting('p18.low_shadow_run')::uuid,
    'shadow_only', '6a000000-0000-4000-8000-000000000091',
    'P18 stale password proof'
  );
  raise exception 'expected fresh_authentication_required for stale amr';
exception when sqlstate '42501' then
  if sqlerrm <> 'fresh_authentication_required' then raise; end if;
end
$$;
reset role;
select pg_temp.p18_platform_claims(interval '0');
set local role authenticated;
do $$
begin
  perform public.platform_set_price_list_automation_scope(
    '18000000-0000-4000-8000-000000000001',
    current_setting('p18.low_shadow_run')::uuid,
    'eligible', '6a000000-0000-4000-8000-000000000001',
    'P18 must reject an unreviewed evidence run'
  );
  raise exception 'expected price_list_scope_review_incomplete';
exception when sqlstate '55000' then
  if sqlerrm <> 'price_list_scope_review_incomplete' then raise; end if;
end
$$;
do $$
begin
  perform public.platform_set_price_list_automation_scope(
    '18000000-0000-4000-8000-000000000001',
    current_setting('p18.first_shadow_run')::uuid,
    'eligible', '6a000000-0000-4000-8000-000000000002',
    'P18 must reject reviewed evidence containing known errors'
  );
  raise exception 'expected price_list_scope_evidence_not_acceptable';
exception when sqlstate '55000' then
  if sqlerrm <> 'price_list_scope_evidence_not_acceptable' then raise; end if;
end
$$;
reset role;
select set_config('request.jwt.claims', '{}'::jsonb::text, true);

select set_config(
  'request.jwt.claim.sub', '28000000-0000-4000-8000-000000000001', true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select pg_temp.p18_assert(
  (select count(*) = 1
          and bool_and(shadow_line_id = (
            select id from public.price_list_shadow_lines
            where shadow_run_id = current_setting('p18.low_shadow_run')::uuid
          ))
          and min(document_line_count) = 1
          and min(document_reviewed_count) = 0
   from public.get_price_list_calibration_queue(50)),
  'the owner calibration queue did not return exactly the pending reviewed-corpus line'
);
select public.get_price_list_calibration_metrics()::text as calibration_metrics \gset
select public.get_price_list_drift_metrics(30)::text as drift_metrics \gset
select public.get_document_operations_metrics(30)::text as operations_metrics \gset

select pg_temp.p18_assert(
  (:'calibration_metrics'::jsonb ->> 'target_document_count')::integer = 50
  and (:'calibration_metrics'::jsonb ->> 'reviewed_document_count')::integer = 1
  and (:'calibration_metrics'::jsonb ->> 'fully_reviewed_document_count')::integer = 1
  and (:'calibration_metrics'::jsonb ->> 'total_interpreted_rows')::integer = 4
  and (:'calibration_metrics'::jsonb ->> 'reviewed_rows')::integer = 3
  and (:'calibration_metrics'::jsonb ->> 'human_corrected_rows')::integer = 2
  and (:'calibration_metrics'::jsonb ->> 'incorrect_product_matches')::integer = 1
  and (:'calibration_metrics'::jsonb ->> 'incorrect_new_products')::integer = 1
  and (:'calibration_metrics'::jsonb ->> 'incorrect_prices')::integer = 1
  and (:'calibration_metrics'::jsonb ->> 'ambiguous_rows')::integer = 1
  and (:'calibration_metrics'::jsonb ->> 'policy_rejected_rows')::integer = 1
  and (:'calibration_metrics'::jsonb ->> 'accuracy')::numeric = 0
  and jsonb_array_length(:'calibration_metrics'::jsonb -> 'by_supplier') = 1
  and jsonb_array_length(:'calibration_metrics'::jsonb -> 'by_document_format') = 1
  and jsonb_array_length(:'calibration_metrics'::jsonb -> 'by_interpretation_version') = 1,
  'calibration read model did not expose the reviewed corpus and required error classes'
);
select pg_temp.p18_assert(
  jsonb_array_length(:'drift_metrics'::jsonb -> 'groups') = 1
  and (:'drift_metrics'::jsonb #>> '{groups,0,extraction_engine}') = 'fixture'
  and (:'drift_metrics'::jsonb #>> '{groups,0,extraction_model}') = 'fixture-ocr'
  and (:'drift_metrics'::jsonb #>> '{groups,0,extraction_model_version}') = 'fixture-ocr-v1'
  and (:'drift_metrics'::jsonb #> '{groups,0,prior_unmatched_rate}') = 'null'::jsonb
  and (:'drift_metrics'::jsonb #> '{groups,0,unmatched_rate_delta}') = 'null'::jsonb
  and (:'drift_metrics'::jsonb #> '{groups,0,new_layout_count}') = 'null'::jsonb
  and (:'drift_metrics'::jsonb #> '{groups,0,layout_change_detected}') = 'null'::jsonb,
  'drift read model converted an absent comparison baseline into a fake zero/signal'
);
select pg_temp.p18_assert(
  (:'operations_metrics'::jsonb ->> 'documents_review_required')::integer = 2
  and (:'operations_metrics'::jsonb ->> 'retry_count')::integer = 2
  and (:'operations_metrics'::jsonb ->> 'average_processing_duration_ms')::numeric = 360
  and (:'operations_metrics'::jsonb #> '{usage,cost}') = 'null'::jsonb
  and (:'operations_metrics'::jsonb #>> '{last_interpretation,prompt_version}')
    = 'interpret-document-v8'
  and (select count(*) = 2 from public.get_document_processing_attempts(null, 100)),
  'document operations read model lost status/retry/version/unknown-cost evidence'
);

select pg_temp.p18_assert(
  (select count(*) = 2 from public.audit_logs
   where org_id = '18000000-0000-4000-8000-000000000001'
     and action = 'price_list_calibration_review_recorded'
     and entity_id in (
       (:'existing_review'::jsonb ->> 'review_id')::uuid,
       (:'existing_review_revision'::jsonb ->> 'review_id')::uuid
     )),
  'new review revisions were not audited exactly once or an idempotent replay audited twice'
);

reset role;
savepoint p18_eligibility_gate;
select count(*) as eligibility_history_before
from public.price_history
where org_id = '18000000-0000-4000-8000-000000000001'
\gset

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.apply_eligible_price_list_interpretation(
  '89000000-0000-4000-8000-000000000001',
  :'first_interpretation'::uuid,
  '28000000-0000-4000-8000-000000000001'
)::text as ineligible_apply \gset
reset role;
select pg_temp.p18_assert(
  :'ineligible_apply'::jsonb ->> 'outcome' = 'queued_for_review'
  and :'ineligible_apply'::jsonb ->> 'reason_code' = 'shadow_scope_not_eligible'
  and (select count(*) = :'eligibility_history_before'::integer
       from public.price_history
       where org_id = '18000000-0000-4000-8000-000000000001')
  and not exists (
    select 1 from public.price_list_interpretation_decisions
    where org_id = '18000000-0000-4000-8000-000000000001'
  ),
  'an unapproved shadow scope reached the live price writer'
);

select pg_temp.p18_seed_interpretation(3, 0.99, jsonb_build_array(
  pg_temp.p18_line(1, 'EXIST-1', '729180000001', '14.00', 'P18 existing')
), '28000000-0000-4000-8000-000000000001',
   pg_temp.p18_table_extraction_payload(array['מוצר', 'SKU', 'מחיר'])
) as clean_interpretation \gset
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.run_price_list_shadow(
  '89000000-0000-4000-8000-000000000003',
  :'clean_interpretation'::uuid,
  '28000000-0000-4000-8000-000000000001'
)::text as clean_shadow \gset
reset role;

select id as clean_shadow_line
from public.price_list_shadow_lines
where shadow_run_id = (:'clean_shadow'::jsonb ->> 'shadow_run_id')::uuid
\gset
select set_config(
  'request.jwt.claim.sub', '28000000-0000-4000-8000-000000000001', true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select public.record_price_list_calibration_review(
  :'clean_shadow_line'::uuid,
  '68000000-0000-4000-8000-000000000010',
  'correct', '{}'::text[], 'apply_existing_price',
  '48000000-0000-4000-8000-000000000001', 14.00,
  'P18 exact clean supplier-layout evidence'
)::text as clean_review \gset
reset role;

select pg_temp.p18_platform_claims(interval '0');
set local role authenticated;
select public.platform_set_price_list_automation_scope(
  '18000000-0000-4000-8000-000000000001',
  (:'clean_shadow'::jsonb ->> 'shadow_run_id')::uuid,
  'eligible', '6a000000-0000-4000-8000-000000000010',
  'P18 all rows independently confirmed for this exact scope'
)::text as eligible_scope \gset
select public.platform_set_price_list_automation_scope(
  '18000000-0000-4000-8000-000000000001',
  (:'clean_shadow'::jsonb ->> 'shadow_run_id')::uuid,
  'eligible', '6a000000-0000-4000-8000-000000000010',
  'P18 all rows independently confirmed for this exact scope'
)::text as eligible_scope_replay \gset
select pg_temp.p18_assert(
  :'eligible_scope'::jsonb ->> 'state' = 'eligible'
  and not (:'eligible_scope'::jsonb ->> 'idempotent')::boolean
  and (:'eligible_scope_replay'::jsonb ->> 'idempotent')::boolean
  and (select evidence_line_count = 1 and evidence_reviewed_count = 1
              and evidence_correct_count = 1 and evidence_accuracy = 1
       from public.price_list_automation_scope_decisions
       where id = (:'eligible_scope'::jsonb ->> 'decision_id')::uuid),
  'a clean reviewed scope was not measured and approved idempotently'
);

reset role;
select set_config('request.jwt.claims', '{}'::jsonb::text, true);
select pg_temp.p18_seed_interpretation(5, 0.99, jsonb_build_array(
  pg_temp.p18_line(1, 'EXIST-1', '729180000001', '14.00', 'P18 existing')
), '28000000-0000-4000-8000-000000000001',
   pg_temp.p18_table_extraction_payload(array['מוצר', 'מחיר', 'SKU'])
) as changed_layout_interpretation \gset
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.run_price_list_shadow(
  '89000000-0000-4000-8000-000000000005',
  :'changed_layout_interpretation'::uuid,
  '28000000-0000-4000-8000-000000000001'
)::text as changed_layout_shadow \gset
select public.apply_eligible_price_list_interpretation(
  '89000000-0000-4000-8000-000000000005',
  :'changed_layout_interpretation'::uuid,
  '28000000-0000-4000-8000-000000000001'
)::text as changed_layout_apply \gset
reset role;
select pg_temp.p18_assert(
  (select changed.layout_signature <> approved.layout_signature
   from public.price_list_shadow_runs changed
   cross join public.price_list_shadow_runs approved
   where changed.id = (:'changed_layout_shadow'::jsonb ->> 'shadow_run_id')::uuid
     and approved.id = (:'clean_shadow'::jsonb ->> 'shadow_run_id')::uuid)
  and :'changed_layout_apply'::jsonb ->> 'outcome' = 'queued_for_review'
  and :'changed_layout_apply'::jsonb ->> 'reason_code' = 'shadow_scope_not_eligible',
  'changed header order reused prior structural eligibility instead of routing to shadow review'
);

select pg_temp.p18_platform_claims(interval '0');
set local role authenticated;
select public.platform_set_price_list_automation_scope(
  '18000000-0000-4000-8000-000000000001',
  (:'clean_shadow'::jsonb ->> 'shadow_run_id')::uuid,
  'shadow_only', '6a000000-0000-4000-8000-000000000011',
  'P18 platform suspended this exact automation scope'
)::text as suspended_scope \gset
reset role;
select set_config('request.jwt.claims', '{}'::jsonb::text, true);

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.apply_eligible_price_list_interpretation(
  '89000000-0000-4000-8000-000000000003',
  :'clean_interpretation'::uuid,
  '28000000-0000-4000-8000-000000000001'
)::text as suspended_apply \gset
reset role;
select pg_temp.p18_assert(
  :'suspended_apply'::jsonb ->> 'outcome' = 'queued_for_review'
  and :'suspended_apply'::jsonb ->> 'reason_code' = 'shadow_scope_not_eligible',
  'a suspended exact scope reached the live writer'
);

select pg_temp.p18_platform_claims(interval '0');
set local role authenticated;
select public.platform_set_price_list_automation_scope(
  '18000000-0000-4000-8000-000000000001',
  (:'clean_shadow'::jsonb ->> 'shadow_run_id')::uuid,
  'eligible', '6a000000-0000-4000-8000-000000000012',
  'P18 platform reactivated this exact reviewed scope'
)::text as reeligible_scope \gset
select pg_temp.p18_assert(
  (:'suspended_scope'::jsonb ->> 'revision')::integer = 2
  and (:'reeligible_scope'::jsonb ->> 'revision')::integer = 3,
  'scope suspension/reactivation did not preserve an append-only revision history'
);
reset role;
select set_config('request.jwt.claims', '{}'::jsonb::text, true);

insert into public.org_autonomy_policies (
  org_id, policy_key, autonomy_enabled, min_confidence
) values (
  '18000000-0000-4000-8000-000000000001', 'price_list.intake', true, 0.900
);
update public.documents
set document_kind = 'price_list'
where id = '88000000-0000-4000-8000-000000000003';

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.apply_eligible_price_list_interpretation(
  '89000000-0000-4000-8000-000000000003',
  :'clean_interpretation'::uuid,
  '28000000-0000-4000-8000-000000000001'
)::text as eligible_apply \gset
select public.apply_eligible_price_list_interpretation(
  '89000000-0000-4000-8000-000000000003',
  :'clean_interpretation'::uuid,
  '28000000-0000-4000-8000-000000000001'
)::text as eligible_apply_replay \gset
reset role;
select count(*) as history_after_apply
from public.price_history
where org_id = '18000000-0000-4000-8000-000000000001'
\gset
select pg_temp.p18_assert(
  :'eligible_apply'::jsonb ->> 'outcome' = 'auto_applied'
  and not (:'eligible_apply'::jsonb ->> 'idempotent')::boolean
  and (:'eligible_apply_replay'::jsonb ->> 'idempotent')::boolean
  and :'history_after_apply'::integer > :'eligibility_history_before'::integer,
  'an eligible exact scope did not apply once and replay idempotently'
);

select set_config(
  'request.jwt.claim.sub', '28000000-0000-4000-8000-000000000001', true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select public.reprocess_document(
  '88000000-0000-4000-8000-000000000003',
  'P18 verify no second live batch for one document'
)::text as reprocess_job \gset
reset role;

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.claim_document_processing_job('p18-reprocess', 120)::text
  as reprocess_claim \gset
select public.service_reserve_organization_external_egress(
  (:'reprocess_claim'::jsonb ->> 'org_id')::uuid,
  'document_signed_url',
  (:'reprocess_claim'::jsonb ->> 'processing_attempt_id')::uuid,
  90
)::text as reprocess_egress \gset
select public.service_acknowledge_document_processing_download(
  :'reprocess_job'::uuid,
  'p18-reprocess',
  (:'reprocess_egress'::jsonb ->> 'lease_id')::uuid,
  (:'reprocess_egress'::jsonb ->> 'lease_token')::uuid,
  300
);
select public.service_record_document_ocr_evidence(
  :'reprocess_job'::uuid,
  (:'reprocess_claim'::jsonb ->> 'processing_attempt_id')::uuid,
  'p18-reprocess',
  (:'reprocess_egress'::jsonb ->> 'lease_id')::uuid,
  (:'reprocess_egress'::jsonb ->> 'lease_token')::uuid,
  'fixture', 'fixture-ocr', 'fixture-ocr-v1',
  :'reprocess_claim'::jsonb ->> 'input_checksum',
  :'reprocess_claim'::jsonb ->> 'contract_version',
  pg_temp.p18_extraction_payload(), 120,
  jsonb_build_object('worker_version', 'p18-reprocess')
)::text as reprocess_evidence \gset
select public.complete_document_processing_job(
  :'reprocess_job'::uuid,
  (:'reprocess_claim'::jsonb ->> 'processing_attempt_id')::uuid,
  'p18-reprocess',
  (:'reprocess_egress'::jsonb ->> 'lease_id')::uuid,
  (:'reprocess_egress'::jsonb ->> 'lease_token')::uuid,
  :'reprocess_evidence'::jsonb ->> 'evidence_sha256'
) ->> 'extraction_id' as reprocess_extraction \gset
select public.begin_document_interpretation(
  :'reprocess_job'::uuid,
  :'reprocess_extraction'::uuid,
  '28000000-0000-4000-8000-000000000001'
)::text as reprocess_begin \gset
select public.save_document_interpretation(
  :'reprocess_job'::uuid,
  :'reprocess_extraction'::uuid,
  '28000000-0000-4000-8000-000000000001',
  (:'reprocess_begin'::jsonb ->> 'interpretation_started_at')::timestamptz,
  'openai', 'gpt-p18-fixture', 'interpret-document-v8', '1',
  pg_temp.p18_interpretation_payload(0.99, jsonb_build_array(
    pg_temp.p18_line(1, 'EXIST-1', '729180000001', '14.00', 'P18 existing')
  )),
  jsonb_build_object('input_tokens', 100, 'output_tokens', 50), 240
)::text as reprocess_interpretation \gset
select public.run_price_list_shadow(
  :'reprocess_job'::uuid,
  :'reprocess_interpretation'::uuid,
  '28000000-0000-4000-8000-000000000001'
)::text as reprocessed_shadow \gset
select public.apply_eligible_price_list_interpretation(
  :'reprocess_job'::uuid,
  :'reprocess_interpretation'::uuid,
  '28000000-0000-4000-8000-000000000001'
)::text as reprocessed_apply \gset
reset role;
select pg_temp.p18_assert(
  :'reprocessed_apply'::jsonb ->> 'outcome' = 'queued_for_review'
  and :'reprocessed_apply'::jsonb ->> 'reason_code' = 'document_already_auto_applied'
  and (select count(*) = :'history_after_apply'::integer
       from public.price_history
       where org_id = '18000000-0000-4000-8000-000000000001'),
  'reprocessing one document created a second automatic price batch'
);

rollback to savepoint p18_eligibility_gate;
release savepoint p18_eligibility_gate;

savepoint p18_empty_office_shadow;
select pg_temp.p18_seed_interpretation(
  4, 0.99, '[]'::jsonb,
  '28000000-0000-4000-8000-000000000003'
) as empty_office_interpretation \gset
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.run_price_list_shadow(
  '89000000-0000-4000-8000-000000000004',
  :'empty_office_interpretation'::uuid,
  '28000000-0000-4000-8000-000000000003'
)::text as empty_office_shadow \gset
reset role;
select pg_temp.p18_assert(
  (select actor_id = '28000000-0000-4000-8000-000000000003'
          and interpreted_line_count = 0
   from public.price_list_shadow_runs
   where id = (:'empty_office_shadow'::jsonb ->> 'shadow_run_id')::uuid)
  and not exists (
    select 1 from public.price_list_shadow_lines
    where shadow_run_id = (:'empty_office_shadow'::jsonb ->> 'shadow_run_id')::uuid
  ),
  'an office-uploaded empty interpretation did not leave measurable zero-line shadow evidence'
);
select set_config(
  'request.jwt.claim.sub', '28000000-0000-4000-8000-000000000001', true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select public.get_price_list_drift_metrics(30)::text as empty_run_drift \gset
select pg_temp.p18_assert(
  (select count(*) = 1 and bool_and(is_empty_run)
   from public.get_price_list_calibration_queue(50)
   where shadow_run_id = (:'empty_office_shadow'::jsonb ->> 'shadow_run_id')::uuid),
  'zero-line price list was absent from the human calibration corpus queue'
);
select public.record_price_list_empty_run_review(
  (:'empty_office_shadow'::jsonb ->> 'shadow_run_id')::uuid,
  '68000000-0000-4000-8000-000000000088',
  'incorrect',
  'P18 human confirmed the price rows were missed'
)::text as empty_run_review \gset
select public.get_price_list_calibration_metrics()::text as empty_run_calibration \gset
select pg_temp.p18_assert(
  (:'empty_run_drift'::jsonb #>> '{groups,0,current_run_count}')::integer = 3
  and (:'empty_run_drift'::jsonb #>> '{groups,0,current_rows}')::integer = 4,
  'the drift denominator dropped a zero-line run or invented an interpreted row'
);
select pg_temp.p18_assert(
  (:'empty_run_review'::jsonb ->> 'idempotent')::boolean = false
  and (:'empty_run_calibration'::jsonb ->> 'zero_line_document_count')::integer = 1
  and (:'empty_run_calibration'::jsonb ->> 'reviewed_zero_line_document_count')::integer = 1
  and not exists (
    select 1 from public.get_price_list_calibration_queue(50)
    where shadow_run_id = (:'empty_office_shadow'::jsonb ->> 'shadow_run_id')::uuid
  ),
  'zero-line human decision was not recorded in corpus progress'
);
reset role;
rollback to savepoint p18_empty_office_shadow;
release savepoint p18_empty_office_shadow;

select set_config(
  'request.jwt.claim.sub', '28000000-0000-4000-8000-000000000001', true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

do $$
begin
  update public.price_list_shadow_runs
  set reason_code = 'tampered'
  where id = current_setting('p18.first_shadow_run')::uuid;
  raise exception 'expected immutable ledger update rejection';
exception when insufficient_privilege then null;
end
$$;

reset role;

select set_config(
  'request.jwt.claim.sub', '28000000-0000-4000-8000-000000000002', true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select pg_temp.p18_assert(
  (select count(*) = 0 from public.price_list_shadow_runs),
  'office role could read owner-only shadow evidence'
);
do $$
begin
  perform public.get_price_list_calibration_metrics();
  raise exception 'expected owner-only calibration metrics rejection';
exception when sqlstate '42501' then
  if sqlerrm <> 'not_authorized' then raise; end if;
end
$$;
do $$
begin
  perform public.get_price_list_calibration_queue(50);
  raise exception 'expected owner-only calibration queue rejection';
exception when sqlstate '42501' then
  if sqlerrm <> 'not_authorized' then raise; end if;
end
$$;
do $$
begin
  perform public.record_price_list_calibration_review(
    current_setting('p18.existing_shadow_line')::uuid,
    '68000000-0000-4000-8000-000000000088',
    'correct', '{}'::text[], 'apply_existing_price',
    '48000000-0000-4000-8000-000000000001', 12,
    'P18 office must not review calibration'
  );
  raise exception 'expected owner-only calibration review rejection';
exception when sqlstate '42501' then
  if sqlerrm <> 'not_authorized' then raise; end if;
end
$$;
reset role;

select set_config(
  'request.jwt.claim.sub', '29000000-0000-4000-8000-000000000001', true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select public.get_price_list_calibration_metrics()::text as tenant_b_calibration \gset
select public.get_document_operations_metrics(30)::text as tenant_b_operations \gset
select pg_temp.p18_assert(
  (select count(*) = 0 from public.price_list_shadow_runs)
  and (select count(*) = 0 from public.get_price_list_calibration_queue(50))
  and (:'tenant_b_calibration'::jsonb ->> 'total_interpreted_rows')::integer = 0
  and (:'tenant_b_calibration'::jsonb -> 'accuracy') = 'null'::jsonb
  and (:'tenant_b_operations'::jsonb ->> 'documents_waiting')::integer = 0
  and (:'tenant_b_operations'::jsonb -> 'last_failure') = 'null'::jsonb
  and (:'tenant_b_operations'::jsonb #> '{usage,cost}') = 'null'::jsonb
  and (select count(*) = 0 from public.get_document_processing_attempts(
    '88000000-0000-4000-8000-000000000001', 100
  )),
  'tenant B saw tenant A evidence or unknown operations data became fake zero detail'
);
do $$
begin
  perform public.record_price_list_calibration_review(
    current_setting('p18.existing_shadow_line')::uuid,
    '68000000-0000-4000-8000-000000000077',
    'correct', '{}'::text[], 'apply_existing_price',
    '49000000-0000-4000-8000-000000000001', 12,
    'P18 tenant B cross-tenant review'
  );
  raise exception 'expected cross-tenant shadow line rejection';
exception when sqlstate 'P0002' then
  if sqlerrm <> 'price_list_shadow_line_unknown' then raise; end if;
end
$$;
reset role;

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
do $$
begin
  insert into public.price_list_calibration_reviews default values;
  raise exception 'expected direct service-role calibration DML rejection';
exception when insufficient_privilege then null;
end
$$;
do $$
begin
  insert into public.price_list_empty_run_reviews default values;
  raise exception 'expected direct service-role empty-run review DML rejection';
exception when insufficient_privilege then null;
end
$$;
reset role;
select pg_temp.p18_assert(
  not has_function_privilege(
    'service_role', 'public.get_document_operations_metrics(integer)', 'EXECUTE'
  ),
  'service_role can execute the owner-only operations read model'
);

select pg_temp.p18_assert(
  (select row(products, supplier_products, price_history, submissions, live_decisions)
     from p18_business_before)
  = row(
    (select count(*) from public.products
      where org_id = '18000000-0000-4000-8000-000000000001'),
    (select count(*) from public.supplier_products
      where org_id = '18000000-0000-4000-8000-000000000001'),
    (select count(*) from public.price_history
      where org_id = '18000000-0000-4000-8000-000000000001'),
    (select count(*) from public.supplier_price_submissions
      where org_id = '18000000-0000-4000-8000-000000000001'),
    (select count(*) from public.price_list_interpretation_decisions
      where org_id = '18000000-0000-4000-8000-000000000001')
  ),
  'calibration/review/read-model operations mutated business state'
);

rollback;

\echo 'P18 document automation calibration/shadow/operations checks passed.'
