-- P31 -- the moment a person's approval becomes a financial record.
--
-- Every other function in this campaign reads. This one writes, and it writes the records the rest
-- of the product bills, pays and reports from. The assertions below are the ways an approval could
-- turn into something the approver did not agree to:
--
--   * a client could post a proposal claiming there is nothing wrong with it;
--   * an invoice could quietly receive goods, letting a supplier close an order with paperwork;
--   * a delivery note could complete a receipt nobody stood at;
--   * a receipt -- evidence, by the owner's decision -- could become a second debt;
--   * a retry from a phone on a dropping connection could bill the same supplier twice;
--   * a role, a tenant or a branch boundary could be crossed on the way in.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p31_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P31 apply assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p31_act(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
end
$$;

create function pg_temp.p31_line(
  p_product uuid, p_qty text, p_unit text, p_price text, p_total text,
  p_sku text default null, p_description text default 'שורה'
) returns jsonb language sql immutable as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'product_id', p_product, 'sku', p_sku, 'description', p_description,
    'quantity', p_qty, 'unit', p_unit, 'unit_price', p_price, 'line_total', p_total,
    'vat_rate', '18'));
$$;

create function pg_temp.p31_reviewed(
  p_type text, p_lines jsonb, p_order uuid default null,
  p_number text default 'INV-31', p_date text default '2026-06-15',
  p_net text default null, p_vat text default null, p_total text default null
) returns jsonb language sql immutable as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'document_type', p_type,
    'supplier_id', '40310000-0000-4000-8000-000000000001',
    'order_id', p_order,
    'document_number', p_number,
    'document_date', p_date,
    'totals', jsonb_strip_nulls(jsonb_build_object(
      'net', p_net, 'vat', p_vat, 'total', p_total)),
    'lines', p_lines));
$$;

insert into public.organizations (id, name, status, vat_rate) values
  ('10310000-0000-4000-8000-000000000001', 'P31 mine', 'active', 18),
  ('10310000-0000-4000-8000-000000000002', 'P31 other', 'active', 18);

insert into auth.users (id, email) values
  ('20310000-0000-4000-8000-000000000001', 'owner-p31@example.test'),
  ('20310000-0000-4000-8000-000000000002', 'office-p31@example.test');

insert into public.suppliers (id, org_id, name, status) values
  ('40310000-0000-4000-8000-000000000001', '10310000-0000-4000-8000-000000000001',
   'P31 ספק', 'active');

insert into public.profiles (id, org_id, full_name, role) values
  ('20310000-0000-4000-8000-000000000001', '10310000-0000-4000-8000-000000000001',
   'P31 owner', 'owner'),
  ('20310000-0000-4000-8000-000000000002', '10310000-0000-4000-8000-000000000001',
   'P31 office', 'office');

insert into public.products (id, org_id, name, unit) values
  ('30310000-0000-4000-8000-000000000001', '10310000-0000-4000-8000-000000000001',
   'P31 מוצר', 'unit'),
  -- Listed by nobody and priced by nobody: the line a reviewer must map by hand.
  ('30310000-0000-4000-8000-000000000002', '10310000-0000-4000-8000-000000000001',
   'P31 מוצר ללא מחירון', 'unit');

insert into public.supplier_products
  (id, org_id, supplier_id, product_id, current_price, supplier_sku) values
  ('70310000-0000-4000-8000-000000000001', '10310000-0000-4000-8000-000000000001',
   '40310000-0000-4000-8000-000000000001', '30310000-0000-4000-8000-000000000001', 10, 'SKU-31');
insert into public.price_history (org_id, supplier_product_id, price, effective_date) values
  ('10310000-0000-4000-8000-000000000001', '70310000-0000-4000-8000-000000000001', 10,
   '2026-01-01');

insert into public.purchase_orders (id, org_id, supplier_id, status) values
  ('50310000-0000-4000-8000-000000000001', '10310000-0000-4000-8000-000000000001',
   '40310000-0000-4000-8000-000000000001', 'sent');
insert into public.purchase_order_items (id, org_id, order_id, product_id, qty, unit_price) values
  ('80310000-0000-4000-8000-000000000001', '10310000-0000-4000-8000-000000000001',
   '50310000-0000-4000-8000-000000000001', '30310000-0000-4000-8000-000000000001', 10, 10);

insert into public.documents (
  id, org_id, entity_type, storage_path, file_name, mime_type, document_kind
)
select ('60310000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       '10310000-0000-4000-8000-000000000001', 'inbox',
       '10310000-0000-4000-8000-000000000001/p31-' || n || '.pdf',
       'p31-' || n || '.pdf', 'application/pdf', 'invoice'
from generate_series(1, 8) as n;

insert into public.document_processing_jobs (
  id, org_id, document_id, requested_by, status, input_checksum,
  interpretation_actor_id, interpretation_started_at
)
select ('90310000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       '10310000-0000-4000-8000-000000000001',
       ('60310000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       '20310000-0000-4000-8000-000000000001', 'review',
       'etag:' || lpad(n::text, 16, '0'), '20310000-0000-4000-8000-000000000001', now()
from generate_series(1, 8) as n;

insert into public.document_extractions (
  id, org_id, job_id, document_id, engine, model, model_version,
  input_checksum, contract_version, payload
)
select ('a0310000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       '10310000-0000-4000-8000-000000000001',
       ('90310000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       ('60310000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       'fixture', 'fixture-model', '1.0.0', 'etag:' || lpad(n::text, 16, '0'), '1',
       jsonb_build_object(
         'schema_version', '1',
         'document', jsonb_build_object('page_count', 1,
           'detected_languages', jsonb_build_array('he'), 'plain_text', 'P31', 'partial', false),
         'blocks', jsonb_build_array(jsonb_build_object(
           'id', 'block-1', 'page', 1, 'type', 'text',
           'bbox', jsonb_build_array(0, 0, 1, 1), 'text', 'P31', 'confidence', 0.95)),
         'tables', '[]'::jsonb, 'marks', '[]'::jsonb)
from generate_series(1, 8) as n;

insert into public.document_interpretations (
  id, org_id, job_id, extraction_id, document_id, interpreted_for_user_id,
  provider, model, prompt_version, schema_version, payload
)
select ('b0310000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       '10310000-0000-4000-8000-000000000001',
       ('90310000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       ('a0310000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       ('60310000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       '20310000-0000-4000-8000-000000000001',
       'p31', 'p31-model', 'interpret-document-v10', '1',
       jsonb_build_object(
         'schema_version', '1', 'document_type', 'invoice', 'document_type_confidence', 0.97,
         'supplier', jsonb_build_object('suggested_id', null, 'suggested_name', 'P31 ספק',
           'confidence', 0.9, 'evidence_block_ids', jsonb_build_array('block-1')),
         'fields', '[]'::jsonb, 'line_items', '[]'::jsonb,
         'suggested_annotations', '[]'::jsonb)
from generate_series(1, 8) as n;

set local role authenticated;
select pg_temp.p31_act('20310000-0000-4000-8000-000000000001');

-- ===== 1. The gate: the server recomputes, and a client's opinion is not read =====
--
-- ₪99 against an agreed ₪10 is an overcharge the assessment blocks on. The proposal below also
-- carries a `findings: []` of its own, which is exactly the lie the gate exists to ignore.

do $$
begin
  perform public.apply_reviewed_document(
    '60310000-0000-4000-8000-000000000001', 'b0310000-0000-4000-8000-000000000001',
    pg_temp.p31_reviewed('invoice',
      jsonb_build_array(pg_temp.p31_line(
        '30310000-0000-4000-8000-000000000001', '2', 'unit', '99', '198')),
      null, 'INV-BLOCK', '2026-06-15', '198', '35.64', '233.64')
      || jsonb_build_object('findings', '[]'::jsonb, 'approval_blocked', false),
    gen_random_uuid(), 'P31 מנסה לאשר חיוב יתר');
  raise exception 'P31 apply assertion failed: A CLIENT-SUPPLIED "nothing is wrong" WAS BELIEVED. '
    'The gate is the server recomputing the assessment; if the submitted findings are read at all, '
    'every read-side guarantee in 0106-0109 is decoration';
exception when sqlstate '55000' then
  if position('document_review_blocked' in sqlerrm) = 0 then raise; end if;
  if position('price_above_baseline' in sqlerrm) = 0 then
    raise exception 'P31 apply assertion failed: the refusal did not name the finding that caused '
      'it, so a person cannot tell what to fix. Got: %', sqlerrm;
  end if;
end
$$;

select pg_temp.p31_assert(
  (select count(*) = 0 from public.invoices
   where org_id = '10310000-0000-4000-8000-000000000001'),
  'a blocked application still created an invoice');

-- ===== 2. Invoice: created, linked, and it does not receive goods =====

select pg_temp.p31_assert(
  (select r ->> 'outcome' = 'invoice_created' and (r ->> 'applied')::boolean
          and (r ->> 'applied_lines')::integer = 1
   from public.apply_reviewed_document(
     '60310000-0000-4000-8000-000000000002', 'b0310000-0000-4000-8000-000000000002',
     pg_temp.p31_reviewed('invoice',
       jsonb_build_array(pg_temp.p31_line(
         '30310000-0000-4000-8000-000000000001', '2', 'unit', '10', '20', 'SKU-31')),
       '50310000-0000-4000-8000-000000000001', 'INV-OK', '2026-06-15', '20', '3.6', '23.6'),
     '00000000-0000-4000-8000-000000000001', 'P31 אישור חשבונית תקינה') r),
  'a clean invoice proposal was not applied');

select pg_temp.p31_assert(
  (select i.review_status::text = 'received' and i.total_amount = 23.6
          and i.received_by = '20310000-0000-4000-8000-000000000001'
   from public.invoices i
   where i.org_id = '10310000-0000-4000-8000-000000000001' and i.invoice_number = 'INV-OK'),
  'the created invoice is not in `received`, or its total is not what was approved. Approving the '
  'DOCUMENT is not approving the INVOICE for payment -- that is a separate reasoned command');

select pg_temp.p31_assert(
  (select count(*) = 1 from public.invoice_lines l
   join public.invoices i on i.id = l.invoice_id and i.invoice_number = 'INV-OK'
   where l.org_id = '10310000-0000-4000-8000-000000000001'
     and l.product_id = '30310000-0000-4000-8000-000000000001' and l.quantity = 2),
  'the approved lines were not stored as evidence, so the three-way match has nothing to read');

select pg_temp.p31_assert(
  exists (select 1 from public.invoice_order_links k
          join public.invoices i on i.id = k.invoice_id and i.invoice_number = 'INV-OK'
          where k.order_id = '50310000-0000-4000-8000-000000000001'),
  'the invoice was not linked to the order the reviewer chose');

select pg_temp.p31_assert(
  (select po.status::text = 'sent'
   from public.purchase_orders po where po.id = '50310000-0000-4000-8000-000000000001')
  and (select item.received_qty = 0
       from public.purchase_order_items item
       where item.id = '80310000-0000-4000-8000-000000000001'),
  'AN INVOICE MOVED THE ORDER. Billing is not receiving: if paperwork can advance received_qty or '
  'order status, a supplier closes an order by sending an invoice');

-- ===== 3. Idempotency: the phone next to the delivery truck =====

select pg_temp.p31_assert(
  (select (r ->> 'idempotent')::boolean = true and (r ->> 'applied')::boolean = false
          and r ->> 'outcome' = 'invoice_created'
   from public.apply_reviewed_document(
     '60310000-0000-4000-8000-000000000002', 'b0310000-0000-4000-8000-000000000002',
     pg_temp.p31_reviewed('invoice',
       jsonb_build_array(pg_temp.p31_line(
         '30310000-0000-4000-8000-000000000001', '2', 'unit', '10', '20', 'SKU-31')),
       '50310000-0000-4000-8000-000000000001', 'INV-OK', '2026-06-15', '20', '3.6', '23.6'),
     '00000000-0000-4000-8000-000000000001', 'P31 ניסיון חוזר') r),
  'a retry with the same idempotency key was not recognised');

select pg_temp.p31_assert(
  (select count(*) = 1 from public.invoices
   where org_id = '10310000-0000-4000-8000-000000000001' and invoice_number = 'INV-OK'),
  'a retry billed the supplier twice. This screen runs on a phone beside a delivery truck, on a '
  'connection that drops -- the retry is the normal case, not the edge one');

-- ===== 4. Delivery note: a draft, and only a draft =====

select pg_temp.p31_assert(
  (select r ->> 'outcome' = 'receipt_draft_created'
   from public.apply_reviewed_document(
     '60310000-0000-4000-8000-000000000003', 'b0310000-0000-4000-8000-000000000003',
     pg_temp.p31_reviewed('delivery_note',
       jsonb_build_array(pg_temp.p31_line(
         '30310000-0000-4000-8000-000000000001', '4', 'unit', '10', '40', 'SKU-31')),
       '50310000-0000-4000-8000-000000000001', null, '2026-06-16'),
     '00000000-0000-4000-8000-000000000002', 'P31 תעודת משלוח') r),
  'an approved delivery note did not produce a receipt draft');

select pg_temp.p31_assert(
  (select g.status::text = 'draft' and g.received_by is null
   from public.goods_receipts g
   where g.org_id = '10310000-0000-4000-8000-000000000001'
     and g.order_id = '50310000-0000-4000-8000-000000000001'),
  'the receipt was created completed, or with a receiver. Only a separate human confirmation that '
  'the goods physically arrived may complete it -- and only completion moves stock and status');

select pg_temp.p31_assert(
  (select item.received_qty = 0
   from public.purchase_order_items item
   where item.id = '80310000-0000-4000-8000-000000000001'),
  'a receipt DRAFT moved received_qty. A draft asserts nothing about goods');

select pg_temp.p31_assert(
  (select count(*) = 1 and max(gi.qty_received) = 4
   from public.goods_receipt_items gi
   where gi.org_id = '10310000-0000-4000-8000-000000000001'
     and gi.order_item_id = '80310000-0000-4000-8000-000000000001'),
  'the draft did not carry the reviewed quantity');

-- ===== 5. Tax receipt: evidence, never a debt =====

select pg_temp.p31_assert(
  (select r ->> 'outcome' = 'receipt_evidence_linked'
          and r ->> 'invoice_id' is not null
   from public.apply_reviewed_document(
     '60310000-0000-4000-8000-000000000004', 'b0310000-0000-4000-8000-000000000004',
     pg_temp.p31_reviewed('tax_receipt', '[]'::jsonb, null, 'INV-OK', '2026-06-20',
                          null, null, '23.6'),
     '00000000-0000-4000-8000-000000000003', 'P31 קבלה על חשבונית קיימת') r),
  'a receipt printing an existing invoice number was not linked to it');

select pg_temp.p31_assert(
  (select count(*) = 1 from public.invoices
   where org_id = '10310000-0000-4000-8000-000000000001')
  and (select count(*) = 0 from public.payments
       where org_id = '10310000-0000-4000-8000-000000000001'),
  'A RECEIPT CREATED A CHARGE. The owner decided on 10.08.2026 that a tax receipt is evidence '
  'only: it links to what exists and creates no invoice, no payment and no payable '
  '(OPEN-DECISIONS #141)');

select pg_temp.p31_assert(
  (select d.entity_type = 'invoice' and d.entity_id is not null
   from public.documents d where d.id = '60310000-0000-4000-8000-000000000004'),
  'the linked receipt was not filed against what it is evidence for');

do $$
begin
  perform public.apply_reviewed_document(
    '60310000-0000-4000-8000-000000000005', 'b0310000-0000-4000-8000-000000000005',
    pg_temp.p31_reviewed('tax_receipt', '[]'::jsonb, null, 'INV-NOBODY', '2026-06-20',
                         null, null, '4444.44'),
    '00000000-0000-4000-8000-000000000004', 'P31 קבלה שלא ניתן לקשר');
  raise exception 'P31 apply assertion failed: a receipt that matches no invoice and no payment '
    'was attached to something anyway. An unattachable receipt is a question for a person, not a '
    'reason to invent a link';
exception when sqlstate '55000' then
  if sqlerrm <> 'document_review_receipt_unlinked' then raise; end if;
end
$$;

-- ===== 6. A reviewer may name a product the matcher never could =====
--
-- The second product is on no price list, so `match_price_list_line` cannot reach it from any
-- printed code. Without the reviewer branch this line blocks approval forever, no matter who
-- decides what.

select pg_temp.p31_assert(
  (select (r ->> 'applied')::boolean and (r ->> 'applied_lines')::integer = 1
   from public.apply_reviewed_document(
     '60310000-0000-4000-8000-000000000006', 'b0310000-0000-4000-8000-000000000006',
     pg_temp.p31_reviewed('invoice',
       jsonb_build_array(pg_temp.p31_line(
         '30310000-0000-4000-8000-000000000002', '1', 'unit', '7', '7')),
       null, 'INV-MAPPED', '2026-06-15', '7', '1.26', '8.26'),
     '00000000-0000-4000-8000-000000000005', 'P31 מיפוי ידני של מוצר') r),
  'a line the automatic matcher cannot resolve stayed unresolvable after a person mapped it');

select pg_temp.p31_assert(
  (select l.product_id = '30310000-0000-4000-8000-000000000002'
   from public.invoice_lines l
   join public.invoices i on i.id = l.invoice_id and i.invoice_number = 'INV-MAPPED'
   where l.org_id = '10310000-0000-4000-8000-000000000001'),
  'the reviewer''s mapping was accepted but not stored');

-- A product id from another tenant is not a mapping, it is an attempt.
do $$
begin
  perform public.apply_reviewed_document(
    '60310000-0000-4000-8000-000000000007', 'b0310000-0000-4000-8000-000000000007',
    pg_temp.p31_reviewed('invoice',
      jsonb_build_array(pg_temp.p31_line(
        '00000000-0000-4000-8000-0000000000ff', '1', 'unit', '7', '7')),
      null, 'INV-FOREIGN', '2026-06-15', '7', '1.26', '8.26'),
    '00000000-0000-4000-8000-000000000006', 'P31 מוצר שאינו של הארגון');
  raise exception 'P31 apply assertion failed: a product id that belongs to no product of this '
    'tenant was accepted as a mapping';
exception when sqlstate '55000' then
  if position('product_unidentified' in sqlerrm) = 0 then raise; end if;
end
$$;

-- ===== 7. Active procurement review path =====

select pg_temp.p31_act('20310000-0000-4000-8000-000000000002');
-- Office remains an active reviewer and keeps the delivery-note path.
select pg_temp.p31_assert(
  (select r ->> 'outcome' = 'receipt_draft_created'
   from public.apply_reviewed_document(
     '60310000-0000-4000-8000-000000000008', 'b0310000-0000-4000-8000-000000000008',
     pg_temp.p31_reviewed('delivery_note',
       jsonb_build_array(pg_temp.p31_line(
         '30310000-0000-4000-8000-000000000001', '1', 'unit', '10', '10', 'SKU-31')),
       '50310000-0000-4000-8000-000000000001', null, '2026-06-17'),
     '00000000-0000-4000-8000-000000000008', 'P31 מנהל רכש מקבל סחורה') r),
  'the office manager lost the delivery-note path, which is the one they actually need');

-- ===== 8. Approving a reading that has been superseded =====

-- Re-reading a document is the pipeline's job, not a client's, so this fixture write happens as
-- the owner of the schema rather than as the reviewer.
-- A second reading needs a second job: one interpretation per job is enforced, which is itself
-- the reason a re-read is a real event and not a silent overwrite.
reset role;
insert into public.document_processing_jobs (
  id, org_id, document_id, requested_by, status, input_checksum,
  interpretation_actor_id, interpretation_started_at
) values (
  'c0310000-0000-4000-8000-000000000007', '10310000-0000-4000-8000-000000000001',
  '60310000-0000-4000-8000-000000000007', '20310000-0000-4000-8000-000000000001', 'review',
  'etag:' || lpad('77', 16, '0'), '20310000-0000-4000-8000-000000000001', now());
insert into public.document_extractions (
  id, org_id, job_id, document_id, engine, model, model_version,
  input_checksum, contract_version, payload
)
select 'd0310000-0000-4000-8000-000000000007', '10310000-0000-4000-8000-000000000001',
       'c0310000-0000-4000-8000-000000000007', '60310000-0000-4000-8000-000000000007',
       'fixture', 'fixture-model', '1.0.0', 'etag:' || lpad('77', 16, '0'), '1', e.payload
from public.document_extractions e where e.id = 'a0310000-0000-4000-8000-000000000007';
-- The id is chosen to sort ABOVE the first reading's, because two rows inserted in one transaction
-- share `now()` and the tie-break is the id — the same tie-break 0109 orders by and 0110 checks.
insert into public.document_interpretations (
  id, org_id, job_id, extraction_id, document_id, interpreted_for_user_id,
  provider, model, prompt_version, schema_version, payload
)
select 'e0310000-0000-4000-8000-000000000007', '10310000-0000-4000-8000-000000000001',
       'c0310000-0000-4000-8000-000000000007', 'd0310000-0000-4000-8000-000000000007',
       '60310000-0000-4000-8000-000000000007', '20310000-0000-4000-8000-000000000001',
       'p31', 'p31-model', 'interpret-document-v10', '1', i.payload
from public.document_interpretations i where i.id = 'b0310000-0000-4000-8000-000000000007';
set local role authenticated;
select pg_temp.p31_act('20310000-0000-4000-8000-000000000001');

do $$
begin
  perform public.apply_reviewed_document(
    '60310000-0000-4000-8000-000000000007', 'b0310000-0000-4000-8000-000000000007',
    pg_temp.p31_reviewed('invoice',
      jsonb_build_array(pg_temp.p31_line(
        '30310000-0000-4000-8000-000000000001', '1', 'unit', '10', '10', 'SKU-31')),
      null, 'INV-STALE', '2026-06-15', '10', '1.8', '11.8'),
    '00000000-0000-4000-8000-00000000000a', 'P31 אישור על קריאה שהוחלפה');
  raise exception 'P31 apply assertion failed: a document was applied against a reading that has '
    'since been superseded. The person approved a specific reading of the page';
exception when sqlstate '40001' then
  if sqlerrm <> 'document_interpretation_superseded' then raise; end if;
end
$$;

-- ===== 9. The ledger is evidence, and evidence does not change =====

select pg_temp.p31_assert(
  (select count(*) >= 4 from public.document_review_applications
   where org_id = '10310000-0000-4000-8000-000000000001'),
  'the applications were not recorded');

select pg_temp.p31_assert(
  (select a.assessment ->> 'severity' is not null and a.reviewed ->> 'document_type' = 'invoice'
   from public.document_review_applications a
   where a.org_id = '10310000-0000-4000-8000-000000000001'
     and a.document_id = '60310000-0000-4000-8000-000000000002'),
  'the application did not freeze what was applied and what the server thought of it. Re-deriving '
  'either later would read today''s catalogue and today''s prices, and answer a different question '
  'than the approver answered');

reset role;
do $$
begin
  update public.document_review_applications set reason = 'rewritten'
  where org_id = '10310000-0000-4000-8000-000000000001';
  raise exception 'P31 apply assertion failed: the application ledger can be rewritten';
exception when sqlstate '42501' then
  if sqlerrm <> 'document_review_application_immutable' then raise; end if;
end
$$;

select pg_temp.p31_assert(
  not has_table_privilege('authenticated', 'public.document_review_applications', 'insert')
  and has_table_privilege('authenticated', 'public.document_review_applications', 'select'),
  'a client can insert into the ledger directly, or can no longer read its own history');

rollback;
