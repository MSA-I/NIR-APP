-- P37 -- one overcharge, one credit request.
--
-- The risk in this feature is quantity, not correctness. The arithmetic is 0108's and is tested in
-- p29; what this suite is about is that a supplier who was overcharged once receives ONE credit
-- request — not one per re-processing, not one per retry from a phone on a dropping connection,
-- not two because someone pressed approve twice.
--
-- And the refusals, which matter more than the creation: nothing is sent to the supplier, the
-- price list is not touched, and being UNDERcharged produces nothing at all.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p37_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P37 overcharge assertion failed: %', p_message;
  end if;
end
$$;

insert into public.organizations (id, name, status, vat_rate) values
  ('10370000-0000-4000-8000-000000000001', 'P37 tenant', 'active', 18);
insert into auth.users (id, email) values
  ('20370000-0000-4000-8000-000000000001', 'owner-p37@example.test');
insert into public.profiles (id, org_id, full_name, role) values
  ('20370000-0000-4000-8000-000000000001', '10370000-0000-4000-8000-000000000001',
   'P37 owner', 'owner');
insert into public.suppliers (id, org_id, name, status) values
  ('40370000-0000-4000-8000-000000000001', '10370000-0000-4000-8000-000000000001',
   'P37 ספק', 'active');
insert into public.products (id, org_id, name, unit) values
  ('30370000-0000-4000-8000-000000000001', '10370000-0000-4000-8000-000000000001',
   'P37 מוצר', 'unit');
insert into public.supplier_products
  (id, org_id, supplier_id, product_id, current_price, supplier_sku) values
  ('70370000-0000-4000-8000-000000000001', '10370000-0000-4000-8000-000000000001',
   '40370000-0000-4000-8000-000000000001', '30370000-0000-4000-8000-000000000001', 10, 'SKU-37');
insert into public.price_history (org_id, supplier_product_id, price, effective_date) values
  ('10370000-0000-4000-8000-000000000001', '70370000-0000-4000-8000-000000000001', 10,
   '2026-01-01');

alter table public.invoices disable trigger invoice_three_way_approval_guard_insert;
insert into public.invoices
  (id, org_id, supplier_id, invoice_number, invoice_date, total_amount, review_status) values
  ('c0370000-0000-4000-8000-000000000001', '10370000-0000-4000-8000-000000000001',
   '40370000-0000-4000-8000-000000000001', 'INV-OVER', '2026-06-15', 100, 'received'),
  ('c0370000-0000-4000-8000-000000000002', '10370000-0000-4000-8000-000000000001',
   '40370000-0000-4000-8000-000000000001', 'INV-UNDER', '2026-06-15', 100, 'received');
alter table public.invoices enable trigger invoice_three_way_approval_guard_insert;

insert into public.documents (
  id, org_id, entity_type, storage_path, file_name, mime_type, document_kind
)
select ('60370000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       '10370000-0000-4000-8000-000000000001', 'inbox',
       '10370000-0000-4000-8000-000000000001/p37-' || n || '.pdf',
       'p37-' || n || '.pdf', 'application/pdf', 'invoice'
from generate_series(1, 3) as n;
insert into public.document_processing_jobs (
  id, org_id, document_id, requested_by, status, input_checksum,
  interpretation_actor_id, interpretation_started_at
)
select ('90370000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       '10370000-0000-4000-8000-000000000001',
       ('60370000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       '20370000-0000-4000-8000-000000000001', 'review',
       'etag:' || lpad(n::text, 16, '0'), '20370000-0000-4000-8000-000000000001', now()
from generate_series(1, 3) as n;
insert into public.document_extractions (
  id, org_id, job_id, document_id, engine, model, model_version,
  input_checksum, contract_version, payload
)
select ('a0370000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       '10370000-0000-4000-8000-000000000001',
       ('90370000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       ('60370000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       'fixture', 'fixture-model', '1.0.0', 'etag:' || lpad(n::text, 16, '0'), '1',
       jsonb_build_object(
         'schema_version', '1',
         'document', jsonb_build_object('page_count', 1,
           'detected_languages', jsonb_build_array('he'), 'plain_text', 'P37', 'partial', false),
         'blocks', jsonb_build_array(jsonb_build_object(
           'id', 'block-1', 'page', 1, 'type', 'text',
           'bbox', jsonb_build_array(0, 0, 1, 1), 'text', 'P37', 'confidence', 0.95)),
         'tables', '[]'::jsonb, 'marks', '[]'::jsonb)
from generate_series(1, 3) as n;
insert into public.document_interpretations (
  id, org_id, job_id, extraction_id, document_id, interpreted_for_user_id,
  provider, model, prompt_version, schema_version, payload
)
select ('b0370000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       '10370000-0000-4000-8000-000000000001',
       ('90370000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       ('a0370000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       ('60370000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       '20370000-0000-4000-8000-000000000001',
       'p37', 'p37-model', 'interpret-document-v10', '1',
       jsonb_build_object(
         'schema_version', '1', 'document_type', 'invoice', 'document_type_confidence', 0.97,
         'supplier', jsonb_build_object('suggested_id', null, 'suggested_name', 'P37 ספק',
           'confidence', 0.9, 'evidence_block_ids', jsonb_build_array('block-1')),
         'fields', '[]'::jsonb, 'line_items', '[]'::jsonb, 'suggested_annotations', '[]'::jsonb)
from generate_series(1, 3) as n;

-- The application ledger row is what the trigger fires on. Written directly here, with the
-- assessment shape 0108 produces, because this suite is about what happens AFTER an overcharge is
-- found — p29 is where the finding itself is proven, and p31 where the apply command is.
create function pg_temp.p37_assessment(p_overcharge text)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'severity', 'error',
    'totals', jsonb_build_object('overcharge_total', p_overcharge::numeric),
    'findings', case when p_overcharge::numeric > 0 then jsonb_build_array(jsonb_build_object(
      'code', 'price_above_baseline', 'severity', 'error', 'line_index', 0,
      'baseline_price', 10, 'document_unit_price_normalized', 14,
      'overcharge_amount', p_overcharge::numeric))
      else jsonb_build_array(jsonb_build_object(
        'code', 'price_below_baseline', 'severity', 'info', 'line_index', 0)) end);
$$;

create function pg_temp.p37_apply(p_doc text, p_interp text, p_invoice uuid, p_overcharge text)
returns uuid language sql as $$
  insert into public.document_review_applications (
    org_id, document_id, interpretation_id, idempotency_key, actor_id, document_type,
    supplier_id, order_id, outcome, invoice_id, reviewed, assessment, reason
  ) values (
    '10370000-0000-4000-8000-000000000001', p_doc::uuid, p_interp::uuid, gen_random_uuid(),
    '20370000-0000-4000-8000-000000000001', 'invoice',
    '40370000-0000-4000-8000-000000000001', null, 'invoice_created', p_invoice,
    '{}'::jsonb, pg_temp.p37_assessment(p_overcharge), 'P37')
  returning id;
$$;

-- ===== 1. An overcharge produces exactly one of each =====

select pg_temp.p37_apply('60370000-0000-4000-8000-000000000001',
                         'b0370000-0000-4000-8000-000000000001',
                         'c0370000-0000-4000-8000-000000000001', '40');

select pg_temp.p37_assert(
  (select count(*) = 1 from public.credit_requests c
   where c.org_id = '10370000-0000-4000-8000-000000000001'
     and c.invoice_id = 'c0370000-0000-4000-8000-000000000001'),
  'an overcharge did not produce exactly one credit request');

select pg_temp.p37_assert(
  (select c.amount = 40 and c.status::text = 'open' and c.reason::text = 'wrong_price'
   from public.credit_requests c
   where c.invoice_id = 'c0370000-0000-4000-8000-000000000001'),
  'the credit request is not a DRAFT for the exact overcharge. Asking a supplier for money back '
  'is a relationship decision; the machine''s job ends at the arithmetic and the document it came '
  'from');

select pg_temp.p37_assert(
  (select count(*) = 1 from public.exceptions e
   where e.org_id = '10370000-0000-4000-8000-000000000001'
     and e.invoice_id = 'c0370000-0000-4000-8000-000000000001'
     and e.type::text = 'amount_mismatch' and e.status::text = 'open'),
  'an overcharge did not raise exactly one exception');

select pg_temp.p37_assert(
  (select jsonb_array_length(e.details -> 'lines') = 1
          and (e.details ->> 'overcharge_amount')::numeric = 40
   from public.exceptions e
   where e.invoice_id = 'c0370000-0000-4000-8000-000000000001'),
  'the exception does not carry WHICH lines overcharged and by how much. Without them the person '
  'opening it has to re-derive the finding from a price list that may since have moved');

select pg_temp.p37_assert(
  (select count(*) = 1 from public.notifications n
   where n.org_id = '10370000-0000-4000-8000-000000000001'
     and n.event_code = 'document_overcharge_detected'),
  'an overcharge did not alert exactly one person');

select pg_temp.p37_assert(
  (select n.body like '%אינה נשלחת לספק%' from public.notifications n
   where n.event_code = 'document_overcharge_detected'),
  'the alert does not say that the credit request has NOT been sent. A person who assumes it went '
  'out will not send it, and a person who assumes it did not will send it twice');

-- ===== 2. Being UNDERcharged produces nothing =====

select pg_temp.p37_apply('60370000-0000-4000-8000-000000000002',
                         'b0370000-0000-4000-8000-000000000002',
                         'c0370000-0000-4000-8000-000000000002', '0');

select pg_temp.p37_assert(
  (select count(*) = 0 from public.credit_requests c
   where c.invoice_id = 'c0370000-0000-4000-8000-000000000002'),
  'a price at or BELOW the agreed one produced a credit request. A negative credit request is an '
  'invoice to our own supplier, and being undercharged is not an exception — it is a good day');

select pg_temp.p37_assert(
  (select count(*) = 0 from public.exceptions e
   where e.invoice_id = 'c0370000-0000-4000-8000-000000000002'),
  'a favourable price deviation raised an exception');

-- ===== 3. THE PRICE LIST IS NOT TOUCHED =====

select pg_temp.p37_assert(
  (select sp.current_price = 10 from public.supplier_products sp
   where sp.id = '70370000-0000-4000-8000-000000000001')
  and (select count(*) = 1 from public.price_history h
       where h.supplier_product_id = '70370000-0000-4000-8000-000000000001'),
  'THE OVERCHARGE UPDATED THE PRICE LIST. It is the contractual baseline; a document is evidence '
  'about what was charged, never an instruction about what was agreed (OPEN-DECISIONS #144). If a '
  'document could move the baseline, every overcharge would erase the evidence of itself');

-- ===== 4. A second approval of the same document does not bill twice =====
--
-- This is the assertion the whole design is shaped around. The ledger is unique per approval, so
-- a retry writes no row and therefore drafts no second credit — idempotency is structural rather
-- than something the trigger has to remember.

select pg_temp.p37_apply('60370000-0000-4000-8000-000000000003',
                         'b0370000-0000-4000-8000-000000000003',
                         'c0370000-0000-4000-8000-000000000001', '40');

select pg_temp.p37_assert(
  (select count(*) = 2 from public.credit_requests c
   where c.invoice_id = 'c0370000-0000-4000-8000-000000000001'),
  'a SECOND, deliberate approval of a different document against the same invoice did not draft '
  'its own credit. Two documents are two claims; the guard is against retries, not against a '
  'person deciding twice');

do $$
declare v_key uuid := gen_random_uuid();
begin
  insert into public.document_review_applications (
    org_id, document_id, interpretation_id, idempotency_key, actor_id, document_type,
    supplier_id, outcome, invoice_id, reviewed, assessment, reason
  ) values (
    '10370000-0000-4000-8000-000000000001', '60370000-0000-4000-8000-000000000001',
    'b0370000-0000-4000-8000-000000000001', v_key,
    '20370000-0000-4000-8000-000000000001', 'invoice',
    '40370000-0000-4000-8000-000000000001', 'invoice_created',
    'c0370000-0000-4000-8000-000000000001', '{}'::jsonb,
    pg_temp.p37_assessment('40'), 'P37 retry');
  -- The same key again: this is the dropped-connection retry, and it must not reach the trigger.
  insert into public.document_review_applications (
    org_id, document_id, interpretation_id, idempotency_key, actor_id, document_type,
    supplier_id, outcome, invoice_id, reviewed, assessment, reason
  ) values (
    '10370000-0000-4000-8000-000000000001', '60370000-0000-4000-8000-000000000001',
    'b0370000-0000-4000-8000-000000000001', v_key,
    '20370000-0000-4000-8000-000000000001', 'invoice',
    '40370000-0000-4000-8000-000000000001', 'invoice_created',
    'c0370000-0000-4000-8000-000000000001', '{}'::jsonb,
    pg_temp.p37_assessment('40'), 'P37 retry');
  raise exception 'P37 overcharge assertion failed: THE LEDGER ACCEPTED A DUPLICATE IDEMPOTENCY '
    'KEY. That constraint is the only thing stopping a retry from asking the same supplier for '
    'the same money twice';
exception when unique_violation then
  null;
end
$$;

-- ===== 5. A delivery note and a receipt draft nothing =====

-- TWO, not three: the retry block above caught its unique_violation, and a caught exception in
-- plpgsql rolls back the whole implicit subtransaction — including that block's FIRST insert.
-- Which is the behaviour we want anyway: a retry that collides leaves nothing behind.
select pg_temp.p37_assert(
  (select count(*) = 2 from public.credit_requests c
   where c.org_id = '10370000-0000-4000-8000-000000000001'),
  'the credit-request count is not what the approvals above should have produced');

insert into public.document_review_applications (
  org_id, document_id, interpretation_id, idempotency_key, actor_id, document_type,
  supplier_id, outcome, invoice_id, reviewed, assessment, reason
) values (
  '10370000-0000-4000-8000-000000000001', '60370000-0000-4000-8000-000000000002',
  'b0370000-0000-4000-8000-000000000002', gen_random_uuid(),
  '20370000-0000-4000-8000-000000000001', 'delivery_note',
  '40370000-0000-4000-8000-000000000001', 'receipt_draft_created', null, '{}'::jsonb,
  pg_temp.p37_assessment('40'), 'P37 delivery note with an overcharge-shaped assessment');

select pg_temp.p37_assert(
  (select count(*) = 2 from public.credit_requests c
   where c.org_id = '10370000-0000-4000-8000-000000000001'),
  'a DELIVERY NOTE drafted a credit request. It carries no invoice and therefore no price we owe '
  'on; crediting against it would be crediting a debt that does not exist yet');

rollback;
