-- A received supplier invoice for the demo org, so the review screen has something real to render.
-- Built on the demo fixture's own supplier, product and open order, so the assessment compares four
-- real sources rather than an isolated document.
\set ON_ERROR_STOP on
begin;

do $$
declare
  v_org uuid := '11111111-1111-4111-8111-111111111111';
  v_owner uuid;
  v_supplier uuid;
  v_product uuid;
  v_order uuid;
  v_order_number text;
  -- Versioned IDs keep an older immutable interpretation from blocking a corrected fixture.
  v_doc uuid := 'f1111111-1111-4111-8111-111111111112';
  v_job uuid := 'f2222222-1111-4111-8111-111111111112';
  v_extraction uuid := 'f3333333-1111-4111-8111-111111111112';
  v_sku text;
  v_unit text;
begin
  select id into v_owner from public.profiles where org_id = v_org and role = 'owner' limit 1;
  -- The supplier with an open order and at least one product line: that is what makes the four
  -- sources meet.
  select po.id, po.supplier_id, po.number::text into v_order, v_supplier, v_order_number
  from public.purchase_orders po
  where po.org_id = v_org and po.status in ('sent', 'confirmed', 'partial')
  order by po.created_at desc limit 1;
  select poi.product_id into v_product
  from public.purchase_order_items poi where poi.order_id = v_order limit 1;
  select coalesce(
           nullif(btrim(sp.supplier_sku), ''),
           nullif(btrim(p.sku), '')
         ), coalesce(p.unit, 'unit')
    into v_sku, v_unit
  from public.products p
  left join public.supplier_products sp
    on sp.org_id = v_org and sp.product_id = p.id and sp.supplier_id = v_supplier
  where p.id = v_product;

  if v_sku is null then
    raise exception 'review-screen fixture requires an order item with a resolvable SKU';
  end if;

  raise notice 'order=% supplier=% product=% sku=%', v_order_number, v_supplier, v_product, v_sku;

  -- Interpretation rows are an immutable learning ledger. A repeated setup run must preserve the
  -- existing evidence instead of trying to delete it and tripping the production invariant.
  if exists (
    select 1 from public.document_interpretations where document_id = v_doc
  ) then
    raise notice 'review-screen fixture already exists for document %', v_doc;
    return;
  end if;

  delete from public.document_interpretations where document_id = v_doc;
  delete from public.document_extractions where document_id = v_doc;
  delete from public.document_processing_jobs where document_id = v_doc;
  delete from public.documents where id = v_doc;

  insert into public.documents (id, org_id, entity_type, storage_path, file_name, mime_type,
                                document_kind, uploaded_by)
  values (v_doc, v_org, 'inbox', v_org::text || '/demo-review-invoice.pdf',
          'חשבונית ספק לבדיקה.pdf', 'application/pdf', 'invoice', v_owner);

  insert into public.document_processing_jobs (
    id, org_id, document_id, requested_by, status, input_checksum,
    interpretation_actor_id, interpretation_started_at)
  values (v_job, v_org, v_doc, v_owner, 'review', 'etag:' || repeat('d', 64), v_owner, now());

  insert into public.document_extractions (
    id, org_id, job_id, document_id, engine, model, model_version,
    input_checksum, contract_version, payload)
  values (v_extraction, v_org, v_job, v_doc, 'fixture', 'fixture-model', '1.0.0',
          'etag:' || repeat('d', 64), '1',
          jsonb_build_object(
            'schema_version', '1',
            'document', jsonb_build_object('page_count', 1,
              'detected_languages', jsonb_build_array('he'),
              'plain_text', 'חשבונית לבדיקה', 'partial', false),
            'blocks', jsonb_build_array(jsonb_build_object(
              'id', 'block-1', 'page', 1, 'type', 'text',
              'bbox', jsonb_build_array(0, 0, 1, 1), 'text', 'חשבונית', 'confidence', 0.95)),
            'tables', '[]'::jsonb, 'marks', '[]'::jsonb));

  insert into public.document_interpretations (
    org_id, job_id, extraction_id, document_id, interpreted_for_user_id, provider, model,
    prompt_version, schema_version, payload)
  values (
    v_org, v_job, v_extraction, v_doc, v_owner, 'fixture', 'fixture-model',
    'interpret-document-v10', '1',
    jsonb_build_object(
      'schema_version', '1',
      'document_type', 'invoice',
      'document_type_confidence', 0.97,
      'supplier', jsonb_build_object(
        'suggested_id', v_supplier::text,
        'suggested_name', (select name from public.suppliers where id = v_supplier),
        'confidence', 0.94, 'evidence_block_ids', jsonb_build_array('block-1')),
      'fields', jsonb_build_array(
        jsonb_build_object('key', 'invoice_number', 'value', 'DEMO-4471',
          'confidence', 0.96, 'evidence_block_ids', jsonb_build_array('block-1')),
        jsonb_build_object('key', 'invoice_date', 'value', to_char(now(), 'YYYY-MM-DD'),
          'confidence', 0.95, 'evidence_block_ids', jsonb_build_array('block-1')),
        jsonb_build_object('key', 'order_number', 'value', v_order_number,
          'confidence', 0.93, 'evidence_block_ids', jsonb_build_array('block-1')),
        jsonb_build_object('key', 'total', 'value', '351',
          'confidence', 0.9, 'evidence_block_ids', jsonb_build_array('block-1'))),
      -- Deliberately priced ABOVE the order snapshot, so the screen has a real finding to show
      -- rather than an all-clear that proves nothing about the parts that matter.
      'line_items', jsonb_build_array(jsonb_build_object(
        'source_row', 1,
        'values', jsonb_build_object(
          'sku', v_sku, 'quantity', '3', 'unit', v_unit,
          'unit_price', '117', 'line_total', '351'),
        'evidence_block_ids', jsonb_build_array('block-1'))),
      'suggested_annotations', '[]'::jsonb));
end
$$;

commit;
