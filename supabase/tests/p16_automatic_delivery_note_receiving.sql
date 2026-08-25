-- P16 -- automatic delivery-note receiving. Runs against a freshly reset disposable database.
--
-- The one thing this suite exists to prove, above every individual assertion: the automatic path
-- opens a DRAFT and touches nothing financial. purchase_order_items.received_qty,
-- purchase_orders.status, inventory_movements and credit_requests are captured before the first
-- call and re-asserted after every scenario. A future edit that "helpfully" completes the receipt
-- fails here rather than moving a tenant's stock on the strength of a photograph.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p16_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P16 automatic delivery-note assertion failed: %', p_message;
  end if;
end
$$;

-- The financial footprint, as one comparable value. Any scenario that moves any of it changes
-- this string.
create function pg_temp.p16_footprint()
returns text language sql stable as $$
  select concat_ws('|',
    (select coalesce(sum(poi.received_qty), 0)::text
       from public.purchase_order_items poi
       join public.purchase_orders po on po.id = poi.order_id
      where po.org_id = '16000000-0000-4000-8000-000000000001'),
    (select string_agg(po.status::text, ',' order by po.id)
       from public.purchase_orders po
      where po.org_id = '16000000-0000-4000-8000-000000000001'),
    (select count(*)::text from public.inventory_movements
      where org_id = '16000000-0000-4000-8000-000000000001'),
    (select count(*)::text from public.credit_requests
      where org_id = '16000000-0000-4000-8000-000000000001'),
    (select count(*)::text from public.invoices
      where org_id = '16000000-0000-4000-8000-000000000001')
  )
$$;

create function pg_temp.p16_payload(
  p_lines jsonb,
  p_supplier uuid,
  p_document_type text default 'delivery_note',
  p_fields jsonb default '[]'::jsonb
)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'schema_version', '1',
    'document_type', p_document_type,
    'document_type_confidence', 0.99,
    'supplier', jsonb_build_object(
      'suggested_id', p_supplier,
      'suggested_name', 'P16 supplier',
      'confidence', 0.99,
      'evidence_block_ids', jsonb_build_array('block-1')
    ),
    'fields', p_fields,
    'line_items', p_lines,
    'suggested_annotations', '[]'::jsonb
  )
$$;

create function pg_temp.p16_line(
  p_row integer,
  p_sku text,
  p_barcode text,
  p_qty text
) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'source_row', p_row,
    'values', jsonb_strip_nulls(jsonb_build_object(
      'sku', p_sku, 'barcode', p_barcode, 'quantity', p_qty
    )),
    'evidence_block_ids', jsonb_build_array('block-1')
  )
$$;

create function pg_temp.p16_seed(
  p_n integer,
  p_lines jsonb,
  p_supplier uuid default '36000000-0000-4000-8000-000000000001',
  p_document_type text default 'delivery_note',
  p_fields jsonb default '[]'::jsonb
)
returns uuid language plpgsql as $$
declare
  v_org constant uuid := '16000000-0000-4000-8000-000000000001';
  v_user constant uuid := '26000000-0000-4000-8000-000000000001';
  v_doc uuid := ('91000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
  v_job uuid := ('92000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
  v_ext uuid := ('93000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
  v_int uuid := ('94000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
  v_etag text := md5('p16' || p_n::text) || md5('p16' || p_n::text);
  v_path text := v_org::text || '/inbox/note-' || p_n || '.jpg';
begin
  insert into storage.objects (bucket_id, name, owner, metadata)
  values ('documents', v_path, v_user,
    jsonb_build_object('mimetype', 'image/jpeg', 'size', 4096, 'eTag', v_etag));

  -- A phone photo in the inbox: exactly what the owner uploaded on 09.08.2026.
  insert into public.documents (
    id, org_id, entity_type, entity_id, storage_path,
    file_name, mime_type, document_kind, uploaded_by
  ) values (
    v_doc, v_org, 'inbox', null, v_path,
    'note-' || p_n || '.jpg', 'image/jpeg', 'delivery_note', v_user
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
    'etag:' || v_etag, '1',
    jsonb_build_object(
      'schema_version', '1',
      'document', jsonb_build_object(
        'page_count', 1, 'detected_languages', jsonb_build_array('he'),
        'plain_text', 'תעודת משלוח לבדיקה', 'partial', false
      ),
      'blocks', jsonb_build_array(jsonb_build_object(
        'id', 'block-1', 'page', 1, 'type', 'text',
        'bbox', jsonb_build_array(0, 0, 1, 1),
        'text', 'תעודת משלוח לבדיקה', 'confidence', 0.99
      )),
      'tables', '[]'::jsonb,
      'marks', '[]'::jsonb
    )
  );

  insert into public.document_interpretations (
    id, org_id, job_id, extraction_id, document_id, interpreted_for_user_id,
    provider, model, prompt_version, schema_version, payload
  ) values (
    v_int, v_org, v_job, v_ext, v_doc, v_user,
    'openai', 'gpt-p16-fixture', 'interpret-document-v8', '1',
    pg_temp.p16_payload(p_lines, p_supplier, p_document_type, p_fields)
  );
  return v_int;
end
$$;

create function pg_temp.p16_apply(p_interpretation uuid)
returns jsonb language plpgsql as $$
declare
  v_result jsonb;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  set local role service_role;
  v_result := public.apply_delivery_note_interpretation(
    (select job_id from public.document_interpretations where id = p_interpretation),
    p_interpretation, null);
  reset role;
  return v_result;
end
$$;

-- ===== Fixture =====
insert into public.organizations (id, name, status)
values ('16000000-0000-4000-8000-000000000001', 'P16 tenant', 'active');

-- 0211 grants the four document autonomy policies to every organisation created inside the
-- pre-launch window, so a fixture tenant is now born WITH them. This suite's OFF scenarios
-- need the opposite, and after 0211 "off" is a state a test has to construct rather than
-- inherit. Removing the birth grants by name is that construction.
delete from org_autonomy_policies where org_id = '16000000-0000-4000-8000-000000000001';
insert into auth.users (id, email)
values ('26000000-0000-4000-8000-000000000001', 'owner-p16@example.test');
insert into public.profiles (id, org_id, full_name, role)
values (
  '26000000-0000-4000-8000-000000000001',
  '16000000-0000-4000-8000-000000000001', 'P16 owner', 'owner'
);
insert into public.suppliers (id, org_id, name) values
  ('36000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-000000000001', 'P16 two-order supplier'),
  ('36000000-0000-4000-8000-000000000002', '16000000-0000-4000-8000-000000000001', 'P16 one-order supplier');

insert into public.products (id, org_id, name, unit, sku, barcode) values
  ('46000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-000000000001', 'P16 one', 'unit', 'DN-SKU-1', '769000000001'),
  ('46000000-0000-4000-8000-000000000002', '16000000-0000-4000-8000-000000000001', 'P16 two', 'unit', 'DN-SKU-2', '769000000002'),
  ('46000000-0000-4000-8000-000000000003', '16000000-0000-4000-8000-000000000001', 'P16 three', 'unit', 'DN-SKU-3', '769000000003'),
  ('46000000-0000-4000-8000-000000000004', '16000000-0000-4000-8000-000000000001', 'P16 amb A', 'unit', 'DN-AMB-A', '769999999999'),
  ('46000000-0000-4000-8000-000000000005', '16000000-0000-4000-8000-000000000001', 'P16 amb B', 'unit', 'DN-AMB-B', '769999999999'),
  ('46000000-0000-4000-8000-000000000006', '16000000-0000-4000-8000-000000000001', 'P16 six', 'unit', 'DN-SKU-6', '769000000006'),
  -- Catalogued for supplier two but on none of its orders. Its presence on a note is what stops
  -- the goods from choosing an order, which is the only way to reach the third tier.
  ('46000000-0000-4000-8000-000000000007', '16000000-0000-4000-8000-000000000001', 'P16 seven', 'unit', 'DN-SKU-7', '769000000007');

insert into public.supplier_products (
  id, org_id, supplier_id, product_id, current_price, price_effective_date, available, supplier_sku
) values
  ('56000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-000000000001', '36000000-0000-4000-8000-000000000001', '46000000-0000-4000-8000-000000000001', 10, '2026-07-01', true, 'SUP-DN-1'),
  ('56000000-0000-4000-8000-000000000002', '16000000-0000-4000-8000-000000000001', '36000000-0000-4000-8000-000000000001', '46000000-0000-4000-8000-000000000002', 20, '2026-07-01', true, 'SUP-DN-2'),
  ('56000000-0000-4000-8000-000000000003', '16000000-0000-4000-8000-000000000001', '36000000-0000-4000-8000-000000000001', '46000000-0000-4000-8000-000000000003', 30, '2026-07-01', true, 'SUP-DN-3'),
  ('56000000-0000-4000-8000-000000000006', '16000000-0000-4000-8000-000000000001', '36000000-0000-4000-8000-000000000002', '46000000-0000-4000-8000-000000000006', 60, '2026-07-01', true, 'SUP-DN-6'),
  ('56000000-0000-4000-8000-000000000007', '16000000-0000-4000-8000-000000000001', '36000000-0000-4000-8000-000000000002', '46000000-0000-4000-8000-000000000007', 70, '2026-07-01', true, 'SUP-DN-7');

-- Two open orders for supplier one. A contains products 1 and 2; B contains 1 and 3. A note
-- delivering 1+2 fits only A; a note delivering only 1 fits both and must not be guessed.
insert into public.purchase_orders (id, org_id, supplier_id, status) values
  ('66000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-000000000001', '36000000-0000-4000-8000-000000000001', 'sent'),
  ('66000000-0000-4000-8000-000000000002', '16000000-0000-4000-8000-000000000001', '36000000-0000-4000-8000-000000000001', 'sent'),
  ('66000000-0000-4000-8000-000000000003', '16000000-0000-4000-8000-000000000001', '36000000-0000-4000-8000-000000000002', 'sent');

-- org_id spelled out: its default is auth_org(), which is NULL here, and
-- p0_set_purchase_order_item_unit_snapshot looks the product up by (org_id, product_id).
insert into public.purchase_order_items (id, org_id, order_id, product_id, qty, unit_price) values
  ('76000000-0000-4000-8000-000000000001', '16000000-0000-4000-8000-000000000001', '66000000-0000-4000-8000-000000000001', '46000000-0000-4000-8000-000000000001', 10, 10),
  ('76000000-0000-4000-8000-000000000002', '16000000-0000-4000-8000-000000000001', '66000000-0000-4000-8000-000000000001', '46000000-0000-4000-8000-000000000002', 5, 20),
  ('76000000-0000-4000-8000-000000000003', '16000000-0000-4000-8000-000000000001', '66000000-0000-4000-8000-000000000002', '46000000-0000-4000-8000-000000000001', 7, 10),
  ('76000000-0000-4000-8000-000000000004', '16000000-0000-4000-8000-000000000001', '66000000-0000-4000-8000-000000000002', '46000000-0000-4000-8000-000000000003', 3, 30),
  ('76000000-0000-4000-8000-000000000005', '16000000-0000-4000-8000-000000000001', '66000000-0000-4000-8000-000000000003', '46000000-0000-4000-8000-000000000006', 4, 60);

select pg_temp.p16_footprint() as baseline \gset p16_

-- ===== 1. The ACL, before anything else =====
-- A browser role holding EXECUTE on the writer would make every guard above it decoration.
select pg_temp.p16_assert(
  not has_function_privilege('authenticated',
    'public.apply_delivery_note_interpretation(uuid,uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('anon',
    'public.apply_delivery_note_interpretation(uuid,uuid,uuid)', 'EXECUTE')
  and has_function_privilege('service_role',
    'public.apply_delivery_note_interpretation(uuid,uuid,uuid)', 'EXECUTE')
  -- And the mirror: reversal belongs to the person, never to the trusted server.
  and has_function_privilege('authenticated',
    'public.revert_delivery_note_receipt(uuid,text)', 'EXECUTE')
  and not has_function_privilege('service_role',
    'public.revert_delivery_note_receipt(uuid,text)', 'EXECUTE'),
  'the delivery-note command ACL was widened, or reversal left the person'
);

-- The ledger tables are readable by the tenant and writable by nobody through DML.
select pg_temp.p16_assert(
  not has_table_privilege('authenticated',
    'public.delivery_note_interpretation_decisions', 'INSERT')
  and not has_table_privilege('authenticated',
    'public.delivery_note_interpretation_decisions', 'UPDATE')
  and has_table_privilege('authenticated',
    'public.delivery_note_interpretation_decisions', 'SELECT'),
  'the decision ledger became writable from the browser'
);

-- ===== 2. OFF means zero =====
select pg_temp.p16_seed(1, jsonb_build_array(
  pg_temp.p16_line(1, 'SUP-DN-1', null, '4'),
  pg_temp.p16_line(2, 'SUP-DN-2', null, '5')
))::text as interpretation \gset off_
select pg_temp.p16_apply(:'off_interpretation'::uuid)::text as result \gset off_
select pg_temp.p16_assert(
  :'off_result'::jsonb ->> 'reason_code' = 'autonomy_disabled'
  and :'off_result'::jsonb ->> 'outcome' = 'queued_for_review'
  and :'off_result'::jsonb ->> 'receipt_id' is null
  and (select count(*) = 0 from public.goods_receipts
        where org_id = '16000000-0000-4000-8000-000000000001')
  and pg_temp.p16_footprint() = :'p16_baseline',
  'OFF opened a receipt or moved something financial'
);

insert into public.org_autonomy_policies (
  org_id, policy_key, autonomy_enabled, min_confidence
) values (
  '16000000-0000-4000-8000-000000000001', 'delivery_note.receiving', true, 0.900
);

-- ===== 3. The order is chosen by the goods themselves =====
select pg_temp.p16_seed(2, jsonb_build_array(
  pg_temp.p16_line(1, 'SUP-DN-1', null, '4'),
  pg_temp.p16_line(2, 'SUP-DN-2', null, '5')
))::text as interpretation \gset items_
select pg_temp.p16_apply(:'items_interpretation'::uuid)::text as result \gset items_
select pg_temp.p16_assert(
  :'items_result'::jsonb ->> 'outcome' = 'draft_created'
  and :'items_result'::jsonb ->> 'order_matched_by' = 'by_items'
  and (:'items_result'::jsonb ->> 'order_id')::uuid = '66000000-0000-4000-8000-000000000001'
  and (:'items_result'::jsonb ->> 'matched_count')::integer = 2
  and (:'items_result'::jsonb ->> 'waiting_count')::integer = 0,
  'a note whose goods fit exactly one open order did not resolve to it'
);

-- What was actually written: a draft, attributed to nobody, with the two lines and their statuses.
select pg_temp.p16_assert(
  (select g.status = 'draft' and g.received_by is null
     and g.order_id = '66000000-0000-4000-8000-000000000001'
   from public.goods_receipts g
   where g.id = (:'items_result'::jsonb ->> 'receipt_id')::uuid)
  and (select count(*) = 2 from public.goods_receipt_items
        where receipt_id = (:'items_result'::jsonb ->> 'receipt_id')::uuid)
  -- 4 of 10 is partial; 5 of 5 is full. save_goods_receipt refuses any other pairing
  -- (0023:1505-1525), so a draft that got this wrong could never be saved by the person.
  and (select qty_received = 4 and status = 'partial' from public.goods_receipt_items
        where receipt_id = (:'items_result'::jsonb ->> 'receipt_id')::uuid
          and order_item_id = '76000000-0000-4000-8000-000000000001')
  and (select qty_received = 5 and status = 'full' from public.goods_receipt_items
        where receipt_id = (:'items_result'::jsonb ->> 'receipt_id')::uuid
          and order_item_id = '76000000-0000-4000-8000-000000000002'),
  'the draft receipt was not written as an unattributed draft with correct line statuses'
);

-- THE CENTRAL CLAIM: a draft moved nothing.
select pg_temp.p16_assert(
  pg_temp.p16_footprint() = :'p16_baseline',
  'creating the draft moved received_qty, order status, inventory, credits or invoices'
);

-- The document reached its destination and the job stopped saying it needs reading.
select pg_temp.p16_assert(
  (select entity_type = 'goods_receipt'
     and entity_id = (:'items_result'::jsonb ->> 'receipt_id')::uuid
     and supplier_id = '36000000-0000-4000-8000-000000000001'
   from public.documents where id = '91000000-0000-4000-8000-000000000002')
  and (select status = 'completed' from public.document_processing_jobs
        where id = '92000000-0000-4000-8000-000000000002')
  and (select category = 'delivery_note' and reason_code is null and decided_by = 'system'
       from public.document_filings
       where interpretation_id = :'items_interpretation'::uuid),
  'the document was not filed to its draft receipt'
);

-- ===== 4. A second run decides nothing twice =====
select pg_temp.p16_apply(:'items_interpretation'::uuid)::text as result \gset replay_
select pg_temp.p16_assert(
  (:'replay_result'::jsonb ->> 'idempotent')::boolean
  and (:'replay_result'::jsonb ->> 'receipt_id')::uuid
      = (:'items_result'::jsonb ->> 'receipt_id')::uuid
  and (select count(*) = 1 from public.goods_receipts
        where org_id = '16000000-0000-4000-8000-000000000001')
  and pg_temp.p16_footprint() = :'p16_baseline',
  'a repeat call opened a second receipt'
);

-- ===== 5. Ambiguity is never a guess =====
-- Product one alone sits on BOTH open orders, and this supplier has two of them, so neither the
-- goods nor the "only open order" fallback can answer. The honest result is no receipt at all.
select pg_temp.p16_seed(3, jsonb_build_array(
  pg_temp.p16_line(1, 'SUP-DN-1', null, '2')
))::text as interpretation \gset amb_
select pg_temp.p16_apply(:'amb_interpretation'::uuid)::text as result \gset amb_
select pg_temp.p16_assert(
  :'amb_result'::jsonb ->> 'reason_code' = 'order_unresolved'
  and :'amb_result'::jsonb ->> 'receipt_id' is null
  and (select count(*) = 1 from public.goods_receipts
        where org_id = '16000000-0000-4000-8000-000000000001')
  and (select reason_code = 'order_unresolved' from public.document_filings
        where interpretation_id = :'amb_interpretation'::uuid)
  and pg_temp.p16_footprint() = :'p16_baseline',
  'an unresolvable order still produced a receipt'
);

-- A printed order number outranks the goods: the same one-product note resolves to the order it
-- names, even though the products alone could not choose.
select pg_temp.p16_seed(4, jsonb_build_array(
  pg_temp.p16_line(1, 'SUP-DN-3', null, '3')
), '36000000-0000-4000-8000-000000000001', 'delivery_note', jsonb_build_array(
  jsonb_build_object('key', 'order_number', 'value',
    (select number::text from public.purchase_orders
      where id = '66000000-0000-4000-8000-000000000002'),
    'confidence', 0.99,
    'evidence_block_ids', jsonb_build_array('block-1'))
))::text as interpretation \gset number_
select pg_temp.p16_apply(:'number_interpretation'::uuid)::text as result \gset number_
select pg_temp.p16_assert(
  :'number_result'::jsonb ->> 'outcome' = 'draft_created'
  and :'number_result'::jsonb ->> 'order_matched_by' = 'by_number'
  and (:'number_result'::jsonb ->> 'order_id')::uuid = '66000000-0000-4000-8000-000000000002'
  and pg_temp.p16_footprint() = :'p16_baseline',
  'a transcribed order number did not outrank the ambiguous goods'
);

-- ===== 6. One draft per order =====
select pg_temp.p16_seed(5, jsonb_build_array(
  pg_temp.p16_line(1, 'SUP-DN-1', null, '3'),
  pg_temp.p16_line(2, 'SUP-DN-2', null, '5')
))::text as interpretation \gset conflict_
select pg_temp.p16_apply(:'conflict_interpretation'::uuid)::text as result \gset conflict_
select pg_temp.p16_assert(
  :'conflict_result'::jsonb ->> 'reason_code' = 'receipt_draft_conflict'
  and :'conflict_result'::jsonb ->> 'receipt_id' is null
  and (select count(*) = 2 from public.goods_receipts
        where org_id = '16000000-0000-4000-8000-000000000001'),
  'a second draft was opened against an order that already had one'
);

-- ===== 7. A line the catalogue cannot answer for waits, by name =====
-- Two products share a barcode, and one supplier has only one open order -- so the order is
-- resolvable but the line is not. Nothing to receive means no draft.
select pg_temp.p16_seed(6, jsonb_build_array(
  pg_temp.p16_line(1, null, '769999999999', '2')
), '36000000-0000-4000-8000-000000000002')::text as interpretation \gset line_
select pg_temp.p16_apply(:'line_interpretation'::uuid)::text as result \gset line_
select pg_temp.p16_assert(
  :'line_result'::jsonb ->> 'reason_code' = 'no_line_matched'
  and :'line_result'::jsonb ->> 'receipt_id' is null
  and (select outcome = 'waiting' and reason_code = 'line_product_ambiguous'
       from public.delivery_note_interpretation_lines
       where interpretation_id = :'line_interpretation'::uuid and line_index = 0)
  and pg_temp.p16_footprint() = :'p16_baseline',
  'an ambiguous barcode was resolved rather than named'
);

-- A quantity above what is outstanding waits too, because save_goods_receipt would refuse the
-- draft and the person would be handed work they cannot finish.
select pg_temp.p16_seed(7, jsonb_build_array(
  pg_temp.p16_line(1, 'SUP-DN-6', null, '99')
), '36000000-0000-4000-8000-000000000002')::text as interpretation \gset over_
select pg_temp.p16_apply(:'over_interpretation'::uuid)::text as result \gset over_
select pg_temp.p16_assert(
  :'over_result'::jsonb ->> 'reason_code' = 'no_line_matched'
  and (select reason_code = 'line_quantity_exceeds_order'
       from public.delivery_note_interpretation_lines
       where interpretation_id = :'over_interpretation'::uuid and line_index = 0)
  and pg_temp.p16_footprint() = :'p16_baseline',
  'a quantity above the outstanding balance was accepted into a draft'
);

-- An unreadable quantity is not a zero. Zero is a claim that nothing arrived.
select pg_temp.p16_seed(8, jsonb_build_array(
  pg_temp.p16_line(1, 'SUP-DN-6', null, 'כ-4 ארגזים')
), '36000000-0000-4000-8000-000000000002')::text as interpretation \gset unreadable_
select pg_temp.p16_apply(:'unreadable_interpretation'::uuid)::text as result \gset unreadable_
select pg_temp.p16_assert(
  (select reason_code = 'line_quantity_unreadable'
     from public.delivery_note_interpretation_lines
     where interpretation_id = :'unreadable_interpretation'::uuid and line_index = 0)
  and pg_temp.p16_footprint() = :'p16_baseline',
  'an unreadable quantity became a number'
);

-- ===== 8. The weakest tier, named as such =====
-- Product seven is catalogued for this supplier but is on none of its orders, so no order
-- contains everything the note delivered and the goods cannot choose. Only then does "the one
-- open order" answer -- and the line that pushed us here still waits by name rather than being
-- forced onto an order it does not belong to.
select pg_temp.p16_seed(9, jsonb_build_array(
  pg_temp.p16_line(1, 'SUP-DN-6', null, '4'),
  pg_temp.p16_line(2, 'SUP-DN-7', null, '2')
), '36000000-0000-4000-8000-000000000002')::text as interpretation \gset single_
select pg_temp.p16_apply(:'single_interpretation'::uuid)::text as result \gset single_
select pg_temp.p16_assert(
  :'single_result'::jsonb ->> 'outcome' = 'draft_created'
  -- Recorded, because this is the tier 0077 refuses for invoices. A wrong link is investigated
  -- from this column.
  and :'single_result'::jsonb ->> 'order_matched_by' = 'single_open_order'
  and (:'single_result'::jsonb ->> 'order_id')::uuid = '66000000-0000-4000-8000-000000000003'
  and (:'single_result'::jsonb ->> 'matched_count')::integer = 1
  and (:'single_result'::jsonb ->> 'waiting_count')::integer = 1
  and (select reason_code = 'line_not_on_order'
       from public.delivery_note_interpretation_lines
       where interpretation_id = :'single_interpretation'::uuid and line_index = 1)
  -- Partial capture leaves the document in review: some of what arrived is not in the draft.
  and (select status = 'review' from public.document_processing_jobs
        where id = '92000000-0000-4000-8000-000000000009')
  and pg_temp.p16_footprint() = :'p16_baseline',
  'the single-open-order fallback did not resolve, or did not record which tier decided'
);

-- ===== 9. A human reclassification stops the machine =====
select pg_temp.p16_seed(10, jsonb_build_array(
  pg_temp.p16_line(1, 'SUP-DN-6', null, '1')
), '36000000-0000-4000-8000-000000000002')::text as interpretation \gset kind_
-- Reclassified AFTER the seed (the seed writes document_kind = 'delivery_note'): the update must
-- follow it, or it touches a row that does not exist yet and reclassifies nothing.
update public.documents set document_kind = 'invoice'
where id = '91000000-0000-4000-8000-000000000010';
select pg_temp.p16_apply(:'kind_interpretation'::uuid)::text as result \gset kind_
select pg_temp.p16_assert(
  :'kind_result'::jsonb ->> 'reason_code' = 'not_a_delivery_note'
  and :'kind_result'::jsonb ->> 'receipt_id' is null,
  'a document reclassified away from delivery_note still opened a receipt'
);

-- ===== 10. Reasoned reversal =====
select set_config('request.jwt.claim.sub', '26000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
do $$
begin
  perform public.revert_delivery_note_receipt(
    (select id from public.delivery_note_interpretation_decisions
      where interpretation_id = '94000000-0000-4000-8000-000000000009'),
    '   ');
  raise exception 'expected reason_required';
exception when sqlstate '22023' then
  if sqlerrm <> 'reason_required' then raise; end if;
end
$$;
select public.revert_delivery_note_receipt(
  (select id from public.delivery_note_interpretation_decisions
    where interpretation_id = :'single_interpretation'::uuid),
  'P16 verified reversal'
)::text as reversal \gset single_
reset role;

select pg_temp.p16_assert(
  (select count(*) = 0 from public.goods_receipts
    where id = (:'single_result'::jsonb ->> 'receipt_id')::uuid)
  and (select count(*) = 0 from public.goods_receipt_items
        where receipt_id = (:'single_result'::jsonb ->> 'receipt_id')::uuid)
  -- Back where the reviewer will find it, not stranded pointing at a receipt that is gone.
  and (select entity_type = 'inbox' and entity_id is null
       from public.documents where id = '91000000-0000-4000-8000-000000000009')
  and (select status = 'review' from public.document_processing_jobs
        where id = '92000000-0000-4000-8000-000000000009')
  and (select reverted_reason = 'P16 verified reversal'
       from public.delivery_note_interpretation_decisions
       where interpretation_id = :'single_interpretation'::uuid)
  and (select reverted_at is not null from public.document_filings
        where interpretation_id = :'single_interpretation'::uuid)
  and pg_temp.p16_footprint() = :'p16_baseline',
  'reversal did not remove the draft and restore the document'
);

-- Twice is not allowed either.
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
do $$
begin
  perform public.revert_delivery_note_receipt(
    (select id from public.delivery_note_interpretation_decisions
      where interpretation_id = '94000000-0000-4000-8000-000000000009'),
    'P16 second attempt');
  raise exception 'expected already_reverted';
exception when sqlstate '55000' then
  if sqlerrm <> 'delivery_note_auto_action_already_reverted' then raise; end if;
end
$$;
reset role;

-- ===== 11. Once a person completed it, it is theirs =====
-- Completing moves stock and quantities through save_goods_receipt's own path; a machine reversal
-- must refuse rather than delete a receipt somebody stood at the delivery and signed off.
update public.goods_receipts
set status = 'completed', received_by = '26000000-0000-4000-8000-000000000001'
where id = (:'items_result'::jsonb ->> 'receipt_id')::uuid;

select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
do $$
begin
  perform public.revert_delivery_note_receipt(
    (select id from public.delivery_note_interpretation_decisions
      where interpretation_id = '94000000-0000-4000-8000-000000000002'),
    'P16 must refuse');
  raise exception 'expected already_completed';
exception when sqlstate '55000' then
  if sqlerrm <> 'delivery_note_receipt_already_completed' then raise; end if;
end
$$;
reset role;

select pg_temp.p16_assert(
  (select count(*) = 1 from public.goods_receipts
    where id = (:'items_result'::jsonb ->> 'receipt_id')::uuid)
  and (select reverted_at is null from public.delivery_note_interpretation_decisions
        where interpretation_id = :'items_interpretation'::uuid),
  'a completed receipt was deleted by a machine reversal'
);

-- ===== 12. The source text, because a future edit is the real risk =====
-- Every assertion above is about one run. This one is about every run there will ever be: the
-- command's own body must never write the four financial tables. Same shape as p14:1603-1616.
select pg_temp.p16_assert(
  (select prosrc !~ '\minsert\s+into\s+public\.invoices\M'
      and prosrc !~ '\mupdate\s+public\.purchase_order_items\M'
      and prosrc !~ '\mupdate\s+purchase_order_items\M'
      and prosrc !~ '\minsert\s+into\s+public\.credit_requests\M'
      and prosrc !~ '\minsert\s+into\s+public\.inventory_movements\M'
      and prosrc !~ '\mupdate\s+public\.purchase_orders\M'
   from pg_proc
   where oid = 'public.apply_delivery_note_interpretation(uuid,uuid,uuid)'::regprocedure),
  'the delivery-note command grew a financial write'
);

-- And the receipt it opens is always a draft. Asserted as "inserts one, never updates one"
-- rather than by hunting for the word 'completed', which also appears legitimately in the JOB
-- stage a few lines below and would make this assertion pass or fail for the wrong reason.
select pg_temp.p16_assert(
  (select prosrc ~ '\minsert\s+into\s+public\.goods_receipts\M'
      and prosrc !~ '\mupdate\s+public\.goods_receipts\M'
      and prosrc ~ '''draft'''
   from pg_proc
   where oid = 'public.apply_delivery_note_interpretation(uuid,uuid,uuid)'::regprocedure),
  'the command can now complete a receipt without a human'
);

-- ===== 13. The sixth guard leg is load-bearing, proved by removing it =====
-- Same idiom as p14's C5 mutation proof (p14:2477-2518). Without 0090's goods_receipt -> inbox
-- leg the reversal deletes the draft and THEN dies at documents_guard_columns, leaving a document
-- filed to a receipt that no longer exists. This is the failure the leg exists to prevent, and it
-- is worth proving rather than asserting.
savepoint p16_guard_mutation;
do $$
declare
  v_def text := replace(
    pg_get_functiondef('public.documents_guard_columns()'::regprocedure), e'\r', '');
  v_leg text := replace($leg$
                or (old.entity_type = 'goods_receipt'
                    and new.entity_type = 'inbox'
                    and new.entity_id is null);$leg$, e'\r', '');
begin
  if position(v_leg in v_def) = 0 then
    raise exception 'P16 mutation proof cannot run: the goods_receipt -> inbox leg is not where '
      '0090 section 4b left it in documents_guard_columns';
  end if;
  -- The terminator on a line of its own, for the reason p14:2492-2495 records: a bare ';' would
  -- land inside the leg's comment block and be swallowed by `--`.
  execute replace(v_def, v_leg, e'\n                ;');
end
$$;

select set_config('request.jwt.claim.sub', '26000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
do $$
begin
  perform public.revert_delivery_note_receipt(
    (select id from public.delivery_note_interpretation_decisions
      where interpretation_id = '94000000-0000-4000-8000-000000000004'),
    'P16 mutation: reverting with the sixth guard leg removed');
  raise exception 'expected the guard to refuse';
exception when sqlstate '42501' then
  if sqlerrm not like '%only metadata, soft-delete fields, or inbox filing%' then raise; end if;
end
$$;
reset role;

select pg_temp.p16_assert(
  (select reverted_at is null from public.delivery_note_interpretation_decisions
    where interpretation_id = '94000000-0000-4000-8000-000000000004')
  and (select count(*) = 1 from public.goods_receipts
        where id = (:'number_result'::jsonb ->> 'receipt_id')::uuid),
  'P16 guard mutation proof: the aborted reversal must leave NOTHING half-done -- the draft is '
  || 'still there and the decision is still live, one transaction or none'
);
rollback to savepoint p16_guard_mutation;

rollback;
