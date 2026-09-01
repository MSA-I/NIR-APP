-- P30 -- the one door the browser has to the three private resolvers.
--
-- `private.resolve_document_supplier`, `private.resolve_document_order` and
-- `private.document_reconciliation_assessment` all take `p_org_id` as an ARGUMENT rather than
-- reading it from the session. That is safe only while nothing a browser controls can call them.
-- 0109 is the door, and every assertion below is one way a door can fail: it can let the wrong role
-- through, it can serve a document from a unit the actor may not see, it can quietly use an order
-- outside that scope as the comparison basis, or it can tell a person their data was recorded when
-- all that happened is that a file was stored.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p30_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P30 review-read assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p30_act(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
end
$$;

insert into public.organizations (id, name, status, vat_rate) values
  ('10300000-0000-4000-8000-000000000001', 'P30 mine', 'active', 18),
  ('10300000-0000-4000-8000-000000000002', 'P30 other tenant', 'active', 18);

insert into auth.users (id, email) values
  ('20300000-0000-4000-8000-000000000001', 'owner-p30@example.test'),
  ('20300000-0000-4000-8000-000000000002', 'office-p30@example.test'),
  ('20300000-0000-4000-8000-000000000004', 'other-owner-p30@example.test');

insert into public.suppliers (id, org_id, name, tax_id, status) values
  ('40300000-0000-4000-8000-000000000001', '10300000-0000-4000-8000-000000000001',
   'P30 ספק', '511111118', 'active');

insert into public.profiles (id, org_id, full_name, role) values
  ('20300000-0000-4000-8000-000000000001', '10300000-0000-4000-8000-000000000001',
   'P30 owner', 'owner'),
  ('20300000-0000-4000-8000-000000000002', '10300000-0000-4000-8000-000000000001',
   'P30 office', 'office'),
  ('20300000-0000-4000-8000-000000000004', '10300000-0000-4000-8000-000000000002',
   'P30 other owner', 'owner');

-- Two branches. The office user is granted only the first, so the second is the unit whose
-- document and whose order must be invisible to them.
insert into public.org_units (id, org_id, parent_id, unit_type, name) values
  ('b0300000-0000-4000-8000-000000000001', '10300000-0000-4000-8000-000000000001',
   (select id from public.org_units
    where org_id = '10300000-0000-4000-8000-000000000001' and parent_id is null limit 1),
   'branch', 'P30 סניף מותר'),
  ('b0300000-0000-4000-8000-000000000002', '10300000-0000-4000-8000-000000000001',
   (select id from public.org_units
    where org_id = '10300000-0000-4000-8000-000000000001' and parent_id is null limit 1),
   'branch', 'P30 סניף אסור');

delete from public.user_scope_grants
where user_id = '20300000-0000-4000-8000-000000000002';
insert into public.user_scope_grants (org_id, user_id, unit_id) values
  ('10300000-0000-4000-8000-000000000001', '20300000-0000-4000-8000-000000000002',
   'b0300000-0000-4000-8000-000000000001');

insert into public.products (id, org_id, name, unit) values
  ('30300000-0000-4000-8000-000000000001', '10300000-0000-4000-8000-000000000001',
   'P30 מוצר', 'unit');
insert into public.supplier_products
  (id, org_id, supplier_id, product_id, current_price, supplier_sku) values
  ('70300000-0000-4000-8000-000000000001', '10300000-0000-4000-8000-000000000001',
   '40300000-0000-4000-8000-000000000001', '30300000-0000-4000-8000-000000000001', 10, 'SKU-30');
insert into public.price_history (org_id, supplier_product_id, price, effective_date) values
  ('10300000-0000-4000-8000-000000000001', '70300000-0000-4000-8000-000000000001', 10,
   '2026-01-01');

-- The order lives in the branch the office user CANNOT see, and the document names its number.
insert into public.purchase_orders (id, org_id, supplier_id, status, unit_id, expected_date) values
  ('50300000-0000-4000-8000-000000000001', '10300000-0000-4000-8000-000000000001',
   '40300000-0000-4000-8000-000000000001', 'sent',
   'b0300000-0000-4000-8000-000000000002', '2026-06-20');
insert into public.purchase_order_items (org_id, order_id, product_id, qty, unit_price) values
  ('10300000-0000-4000-8000-000000000001', '50300000-0000-4000-8000-000000000001',
   '30300000-0000-4000-8000-000000000001', 10, 10);

insert into public.documents (
  id, org_id, entity_type, storage_path, file_name, mime_type, document_kind, unit_id, uploaded_by) values
  -- Readable by both: no unit at all.
  ('60300000-0000-4000-8000-000000000001', '10300000-0000-4000-8000-000000000001',
   'inbox', '10300000-0000-4000-8000-000000000001/p30-open.pdf', 'p30-open.pdf',
   'application/pdf', 'invoice', null, '20300000-0000-4000-8000-000000000001'),
  -- Filed to the branch the office user cannot see.
  ('60300000-0000-4000-8000-000000000002', '10300000-0000-4000-8000-000000000001',
   'inbox', '10300000-0000-4000-8000-000000000001/p30-scoped.pdf', 'p30-scoped.pdf',
   'application/pdf', 'invoice', 'b0300000-0000-4000-8000-000000000002', '20300000-0000-4000-8000-000000000001'),
  -- Stored, never interpreted: the "file is safe, nothing has been read" case.
  ('60300000-0000-4000-8000-000000000003', '10300000-0000-4000-8000-000000000001',
   'inbox', '10300000-0000-4000-8000-000000000001/p30-raw.pdf', 'p30-raw.pdf',
   'application/pdf', 'invoice', null, '20300000-0000-4000-8000-000000000001');

insert into public.document_processing_jobs (
  id, org_id, document_id, requested_by, status, input_checksum,
  interpretation_actor_id, interpretation_started_at
) values (
  '80300000-0000-4000-8000-000000000001', '10300000-0000-4000-8000-000000000001',
  '60300000-0000-4000-8000-000000000001', '20300000-0000-4000-8000-000000000001', 'review',
  'etag:' || repeat('a', 64), '20300000-0000-4000-8000-000000000001', now()
);

insert into public.document_extractions (
  id, org_id, job_id, document_id, engine, model, model_version,
  input_checksum, contract_version, payload
) values (
  '90300000-0000-4000-8000-000000000001', '10300000-0000-4000-8000-000000000001',
  '80300000-0000-4000-8000-000000000001', '60300000-0000-4000-8000-000000000001',
  'fixture', 'fixture-model', '1.0.0', 'etag:' || repeat('a', 64), '1',
  jsonb_build_object(
    'schema_version', '1',
    'document', jsonb_build_object('page_count', 1,
      'detected_languages', jsonb_build_array('he'), 'plain_text', 'P30', 'partial', false),
    'blocks', jsonb_build_array(jsonb_build_object(
      'id', 'block-1', 'page', 1, 'type', 'text',
      'bbox', jsonb_build_array(0, 0, 1, 1), 'text', 'P30', 'confidence', 0.95)),
    'tables', '[]'::jsonb, 'marks', '[]'::jsonb)
);

insert into public.document_interpretations (
  org_id, job_id, extraction_id, document_id, interpreted_for_user_id, provider, model,
  prompt_version, schema_version, payload
) values (
  '10300000-0000-4000-8000-000000000001', '80300000-0000-4000-8000-000000000001',
  '90300000-0000-4000-8000-000000000001', '60300000-0000-4000-8000-000000000001',
  '20300000-0000-4000-8000-000000000001',
  'p30', 'p30-model', 'interpret-document-v10', '1',
  jsonb_build_object(
    'schema_version', '1',
    'document_type', 'invoice',
    'document_type_confidence', 0.97,
    'supplier', jsonb_build_object(
      'suggested_id', null, 'suggested_name', 'P30 ספק', 'confidence', 0.93,
      'evidence_block_ids', jsonb_build_array('block-1')),
    'fields', jsonb_build_array(
      jsonb_build_object('key', 'supplier_vat_id', 'value', '511111118',
        'confidence', 0.95, 'evidence_block_ids', jsonb_build_array('block-1')),
      jsonb_build_object('key', 'invoice_date', 'value', '2026-06-18',
        'confidence', 0.95, 'evidence_block_ids', jsonb_build_array('block-1')),
      jsonb_build_object('key', 'order_number', 'value',
        (select number::text from public.purchase_orders
         where id = '50300000-0000-4000-8000-000000000001'),
        'confidence', 0.95, 'evidence_block_ids', jsonb_build_array('block-1'))),
    'line_items', jsonb_build_array(jsonb_build_object(
      'source_row', 1,
      'values', jsonb_build_object(
        'sku', 'SKU-30', 'quantity', '2', 'unit', 'unit', 'unit_price', '10',
        'line_total', '20'),
      'evidence_block_ids', jsonb_build_array('block-1'))),
    'suggested_annotations', '[]'::jsonb)
);

set local role authenticated;

-- ===== 1. Who may open the door =====

select pg_temp.p30_act('20300000-0000-4000-8000-000000000001');
select pg_temp.p30_assert(
  (public.get_document_review_assessment('60300000-0000-4000-8000-000000000001')
   ->> 'document_id') = '60300000-0000-4000-8000-000000000001',
  'the owner could not read a document of their own tenant');

select pg_temp.p30_act('20300000-0000-4000-8000-000000000004');
do $$
begin
  perform public.get_document_review_assessment('60300000-0000-4000-8000-000000000001');
  raise exception 'P30 review-read assertion failed: another tenant read our document by its id';
exception when sqlstate 'P0002' then
  if sqlerrm <> 'document_not_found' then raise; end if;
end
$$;

-- ===== 2. Scope, which RLS cannot do here =====
--
-- Inside a SECURITY DEFINER body the scope riders do not run. If 0109 stops narrowing by
-- auth_scopes() itself, these two assertions are the only thing standing between a branch manager
-- and another branch's documents and orders.

select pg_temp.p30_act('20300000-0000-4000-8000-000000000002');
do $$
begin
  perform public.get_document_review_assessment('60300000-0000-4000-8000-000000000002');
  raise exception 'P30 review-read assertion failed: a document filed to a branch the actor is '
    'not granted was served anyway. RLS does not run inside a definer body -- 0109 narrows or '
    'nobody does';
exception when sqlstate 'P0002' then
  if sqlerrm <> 'document_not_found' then raise; end if;
end
$$;

-- The subtler half: the DOCUMENT is readable, but the order its printed number resolves to is not.
-- The order must be dropped rather than silently used as the comparison basis.
select pg_temp.p30_assert(
  (select r #>> '{order_resolution,reason}' = 'order_out_of_scope'
          and r #>> '{order_resolution,order_id}' is null
          and r #>> '{assessment,order_id}' is null
          and (r #> '{assessment,sources,ordered}')::boolean = false
   from public.get_document_review_assessment(
     '60300000-0000-4000-8000-000000000001') r),
  'an order in a branch the actor may not see became the basis of their assessment. The document '
  'printed its number, so the resolver found it correctly -- the narrowing is this function''s job');

-- The owner, who holds the whole tree, sees the same document resolve to the same order.
select pg_temp.p30_act('20300000-0000-4000-8000-000000000001');
select pg_temp.p30_assert(
  (select r #>> '{order_resolution,matched_by}' = 'by_number'
          and r #>> '{assessment,order_id}' = '50300000-0000-4000-8000-000000000001'
          and (r #> '{assessment,sources,ordered}')::boolean = true
   from public.get_document_review_assessment(
     '60300000-0000-4000-8000-000000000001') r),
  'the owner, whose scope covers the branch, did not get the order. If this fails while the '
  'office assertion above passes, the function is refusing everyone rather than narrowing');

-- ===== 3. The two states, which must never be one =====

select pg_temp.p30_assert(
  (select (r ->> 'file_stored')::boolean = true
          and (r ->> 'data_approved')::boolean = false
          and r ->> 'state' = 'awaiting_interpretation'
          and r ->> 'assessment' is null
   from public.get_document_review_assessment(
     '60300000-0000-4000-8000-000000000003') r),
  'a stored-but-unread document did not report itself as exactly that. An empty assessment here '
  'would read as "we checked and found nothing"; "the file is safe" and "the data was approved" '
  'are two different sentences and this is the field the screen prints them from');

select pg_temp.p30_assert(
  (select (r ->> 'data_approved')::boolean = false
   from public.get_document_review_assessment(
     '60300000-0000-4000-8000-000000000001') r),
  'a fully assessed document reported its data as approved. Reading is not approving');

select pg_temp.p30_assert(
  (select r ->> 'state' in ('blocked', 'ready_for_approval', 'supplier_unresolved')
   from public.get_document_review_assessment(
     '60300000-0000-4000-8000-000000000001') r),
  'the read returned a state the screen has no branch for');

-- ===== 4. The supplier ladder and the assessment arrive together =====

select pg_temp.p30_assert(
  (select (r #> '{supplier_resolution,resolved}')::boolean = true
          and r #>> '{supplier_resolution,matched_by}' = 'tax_id'
          and r #>> '{assessment,supplier_id}' = '40300000-0000-4000-8000-000000000001'
   from public.get_document_review_assessment(
     '60300000-0000-4000-8000-000000000001') r),
  'the supplier the printed VAT number identifies did not reach the assessment. One round trip is '
  'the point: a screen that has to ask three times can render a supplier and an assessment that '
  'disagree');

-- ===== 5. Reading changes nothing =====

reset role;
create temp table p30_before as
  select (select count(*) from public.documents) as documents,
         (select count(*) from public.document_interpretations) as interpretations,
         (select count(*) from public.invoices) as invoices,
         (select count(*) from public.price_history) as prices;
set local role authenticated;

select pg_temp.p30_act('20300000-0000-4000-8000-000000000001');
select public.get_document_review_assessment('60300000-0000-4000-8000-000000000001');
select public.get_document_review_assessment('60300000-0000-4000-8000-000000000003');

reset role;
select pg_temp.p30_assert(
  (select b.documents = (select count(*) from public.documents)
          and b.interpretations = (select count(*) from public.document_interpretations)
          and b.invoices = (select count(*) from public.invoices)
          and b.prices = (select count(*) from public.price_history)
   from p30_before b),
  'opening a document to look at it wrote something. Rendering a screen is not a decision');

-- ===== 6. The door is the only way in =====

select pg_temp.p30_assert(
  not has_schema_privilege('authenticated', 'private', 'usage')
  and not has_function_privilege('anon', 'public.get_document_review_assessment(uuid)', 'execute')
  and has_function_privilege(
        'authenticated', 'public.get_document_review_assessment(uuid)', 'execute'),
  'either the browser gained a second way in, or it lost the only one it should have');

-- The A5 ledger row, and specifically that it is an ENFORCEMENT and not an EXEMPTION. An exemption
-- would mean "this definer is allowed to ignore scope"; the whole of section 2 above is the proof
-- that it does not.
select pg_temp.p30_assert(
  exists (
    select 1 from private.scope_definer_enforcements e
    where e.function_signature = 'get_document_review_assessment(uuid)'
      and e.enforcement_kind = 'filtered_read')
  and not exists (
    select 1 from private.scope_definer_exemptions x
    where x.function_signature = 'get_document_review_assessment(uuid)'),
  'the review read is registered as an A5 EXEMPTION rather than an enforcement, or its '
  'registration is gone. It narrows by auth_scopes() and must be ledgered as doing so');

rollback;
