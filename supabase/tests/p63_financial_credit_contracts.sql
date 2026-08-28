-- P63 -- approved credit-note intake and partial credit allocations.
--
-- This suite proves the two owner decisions that close DEBT §49-§50:
--   * an approved credit note creates one received credit only when supplier and credited invoice
--     resolve uniquely; the document remains evidence and intake alone changes no balance;
--   * credit allocations consume only the remaining amount, a credit settles the invoice it is
--     LINKED to, an unlinked credit may settle any invoice of its own supplier and is linked at the
--     moment it does, and every reader of "how much credit was consumed" answers from allocations
--     that actually happened rather than from the credit's lifecycle label.
--
-- Everything here runs inside ONE transaction and ends in ROLLBACK. Nothing is left behind, so the
-- suite is re-runnable and cannot shift the row counts p9, p49 and live_schema_alignment measure.
-- The real two-session race lives in p63_financial_credit_concurrency.sql, which commits its own
-- fixtures on a disposable database -- the same split payment_credit_override_concurrency.sql uses.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p63_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P63 financial credit assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p63_expect_error(p_sql text, p_fragment text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
    raise exception 'P63 expected error containing %, statement succeeded: %', p_fragment, p_sql;
  exception when others then
    if sqlerrm like 'P63 expected error%' or position(p_fragment in sqlerrm) = 0 then raise; end if;
  end;
end
$$;

create function pg_temp.p63_activate(p_user uuid, p_password_fresh boolean default false)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', p_user::text,
    'amr', case when p_password_fresh then jsonb_build_array(jsonb_build_object(
      'method', 'password', 'timestamp', extract(epoch from clock_timestamp())::bigint
    )) else '[]'::jsonb end
  )::text, true);
end
$$;

insert into public.organizations (id, name, status, vat_rate) values
  ('f6300000-0000-4000-8000-000000000001', 'P63 credit tenant', 'active', 18);

insert into auth.users (id, email) values
  ('f6300000-0000-4000-8000-000000000002', 'p63-owner@example.test'),
  ('f6300000-0000-4000-8000-000000000003', 'p63-accountant@example.test'),
  ('f6300000-0000-4000-8000-000000000004', 'p63-office@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('f6300000-0000-4000-8000-000000000002', 'f6300000-0000-4000-8000-000000000001',
   'P63 owner', 'owner'),
  ('f6300000-0000-4000-8000-000000000003', 'f6300000-0000-4000-8000-000000000001',
   'P63 accountant', 'accountant'),
  -- office reads the supplier card but not the allocation ledger. Section 3 uses this identity to
  -- prove the open-credit amount refuses rather than reverting to the pre-allocation figure.
  ('f6300000-0000-4000-8000-000000000004', 'f6300000-0000-4000-8000-000000000001',
   'P63 office', 'office');

insert into public.suppliers (id, org_id, name, status) values
  ('f6300000-0000-4000-8000-000000000011', 'f6300000-0000-4000-8000-000000000001',
   'P63 supplier', 'active'),
  ('f6300000-0000-4000-8000-000000000012', 'f6300000-0000-4000-8000-000000000001',
   'P63 other supplier', 'active');

-- INV-CREDITED is 200 on purpose: a 60 credit consumed in two 30 halves has to leave the invoice
-- visibly part-settled in between, which a 100 invoice would hide behind a zero balance.
insert into public.invoices (
  id, org_id, supplier_id, invoice_number, invoice_date,
  amount_before_vat, vat_amount, total_amount, review_status
) values
  ('f6300000-0000-4000-8000-000000000021', 'f6300000-0000-4000-8000-000000000001',
   'f6300000-0000-4000-8000-000000000011', 'INV-CREDITED', current_date, 200, 0, 200, 'received'),
  ('f6300000-0000-4000-8000-000000000022', 'f6300000-0000-4000-8000-000000000001',
   'f6300000-0000-4000-8000-000000000011', 'INV-AMBIGUOUS', current_date, 100, 0, 100, 'received'),
  ('f6300000-0000-4000-8000-000000000023', 'f6300000-0000-4000-8000-000000000001',
   'f6300000-0000-4000-8000-000000000011', 'INV-AMBIGUOUS', current_date, 100, 0, 100, 'received'),
  ('f6300000-0000-4000-8000-000000000024', 'f6300000-0000-4000-8000-000000000001',
   'f6300000-0000-4000-8000-000000000011', 'INV-PAID-BY-CREDIT', current_date, 100, 0, 100, 'received'),
  ('f6300000-0000-4000-8000-000000000025', 'f6300000-0000-4000-8000-000000000001',
   'f6300000-0000-4000-8000-000000000011', 'INV-OVERPAY', current_date, 200, 0, 200, 'received'),
  ('f6300000-0000-4000-8000-000000000026', 'f6300000-0000-4000-8000-000000000001',
   'f6300000-0000-4000-8000-000000000011', 'INV-FOREIGN-CREDIT', current_date, 100, 0, 100, 'received'),
  ('f6300000-0000-4000-8000-000000000027', 'f6300000-0000-4000-8000-000000000001',
   'f6300000-0000-4000-8000-000000000011', 'INV-COVERAGE', current_date, 100, 0, 100, 'received'),
  -- 200, so the same unlinked credit can be applied to it twice and still leave the invoice
  -- visibly part-settled between the two halves.
  ('f6300000-0000-4000-8000-000000000028', 'f6300000-0000-4000-8000-000000000001',
   'f6300000-0000-4000-8000-000000000011', 'INV-UNLINKED-TARGET', current_date, 200, 0, 200,
   'received'),
  ('f6300000-0000-4000-8000-000000000029', 'f6300000-0000-4000-8000-000000000001',
   'f6300000-0000-4000-8000-000000000011', 'INV-UNLINKED-OTHER', current_date, 100, 0, 100,
   'received'),
  -- Same tenant, DIFFERENT supplier. Nothing but the supplier predicate stands between a credit
  -- and this invoice: it receives no cash in the payload that names it, and the cash branch is the
  -- only other place an invoice's supplier is ever compared.
  ('f6300000-0000-4000-8000-00000000002a', 'f6300000-0000-4000-8000-000000000001',
   'f6300000-0000-4000-8000-000000000012', 'INV-CROSS-SUPPLIER', current_date, 100, 0, 100,
   'received');

-- Two credit-note readings: one has one exact invoice, one has two. Supplier provenance is the
-- document's tenant-bound supplier_id, not a client-supplied guess.
insert into public.documents (
  id, org_id, entity_type, storage_path, file_name, mime_type, document_kind, supplier_id
) values
  ('f6300000-0000-4000-8000-000000000031', 'f6300000-0000-4000-8000-000000000001',
   'inbox', 'f6300000-0000-4000-8000-000000000001/p63-credit.pdf',
   'p63-credit.pdf', 'application/pdf', 'credit', 'f6300000-0000-4000-8000-000000000011'),
  ('f6300000-0000-4000-8000-000000000032', 'f6300000-0000-4000-8000-000000000001',
   'inbox', 'f6300000-0000-4000-8000-000000000001/p63-ambiguous.pdf',
   'p63-ambiguous.pdf', 'application/pdf', 'credit', 'f6300000-0000-4000-8000-000000000011');

insert into public.document_processing_jobs (
  id, org_id, document_id, requested_by, status, input_checksum,
  interpretation_actor_id, interpretation_started_at
) values
  ('f6300000-0000-4000-8000-000000000041', 'f6300000-0000-4000-8000-000000000001',
   'f6300000-0000-4000-8000-000000000031', 'f6300000-0000-4000-8000-000000000002',
   'review', 'etag:0000000000000063', 'f6300000-0000-4000-8000-000000000002', now()),
  ('f6300000-0000-4000-8000-000000000042', 'f6300000-0000-4000-8000-000000000001',
   'f6300000-0000-4000-8000-000000000032', 'f6300000-0000-4000-8000-000000000002',
   'review', 'etag:0000000000000064', 'f6300000-0000-4000-8000-000000000002', now());

insert into public.document_extractions (
  id, org_id, job_id, document_id, engine, model, model_version,
  input_checksum, contract_version, payload
) select
  ('f6300000-0000-4000-8000-00000000005' || n)::uuid,
  'f6300000-0000-4000-8000-000000000001',
  ('f6300000-0000-4000-8000-00000000004' || n)::uuid,
  ('f6300000-0000-4000-8000-00000000003' || n)::uuid,
  'fixture', 'fixture-model', '1.0.0',
  case n when 1 then 'etag:0000000000000063' else 'etag:0000000000000064' end, '1',
  jsonb_build_object(
    'schema_version', '1',
    'document', jsonb_build_object('page_count', 1, 'detected_languages', jsonb_build_array('he'),
      'plain_text', 'P63 credit note', 'partial', false),
    'blocks', jsonb_build_array(jsonb_build_object(
      'id', 'block-1', 'page', 1, 'type', 'text',
      'bbox', jsonb_build_array(0, 0, 1, 1), 'text', 'P63', 'confidence', 0.99)),
    'tables', '[]'::jsonb, 'marks', '[]'::jsonb)
from generate_series(1, 2) n;

insert into public.document_interpretations (
  id, org_id, job_id, extraction_id, document_id, interpreted_for_user_id,
  provider, model, prompt_version, schema_version, payload
) select
  ('f6300000-0000-4000-8000-00000000006' || n)::uuid,
  'f6300000-0000-4000-8000-000000000001',
  ('f6300000-0000-4000-8000-00000000004' || n)::uuid,
  ('f6300000-0000-4000-8000-00000000005' || n)::uuid,
  ('f6300000-0000-4000-8000-00000000003' || n)::uuid,
  'f6300000-0000-4000-8000-000000000002',
  'fixture', 'fixture-model', 'p63', '1',
  jsonb_build_object(
    'schema_version', '1', 'document_type', 'credit_note', 'document_type_confidence', 0.99,
    'supplier', jsonb_build_object('suggested_id', 'f6300000-0000-4000-8000-000000000011',
      'suggested_name', 'P63 supplier', 'confidence', 0.99,
      'evidence_block_ids', jsonb_build_array('block-1')),
    'fields', jsonb_build_array(
      jsonb_build_object('key', 'reference_invoice_number',
        'value', case n when 1 then 'INV-CREDITED' else 'INV-AMBIGUOUS' end,
        'confidence', 0.99, 'evidence_block_ids', jsonb_build_array('block-1')),
      jsonb_build_object('key', 'document_number', 'value', 'CN-' || n,
        'confidence', 0.99, 'evidence_block_ids', jsonb_build_array('block-1')),
      jsonb_build_object('key', 'total', 'value', case n when 1 then '60.00' else '25.00' end,
        'confidence', 0.99, 'evidence_block_ids', jsonb_build_array('block-1'))),
    'line_items', '[]'::jsonb, 'suggested_annotations', '[]'::jsonb)
from generate_series(1, 2) n;

-- ===== 1. Intake: one credit, only when the credited invoice is unambiguous =====

set local role authenticated;
select pg_temp.p63_activate('f6300000-0000-4000-8000-000000000002');

select pg_temp.p63_assert(
  (select r #>> '{credit_resolution,invoice_id}' = 'f6300000-0000-4000-8000-000000000021'
          and (r #>> '{credit_resolution,resolved}')::boolean
   from public.get_document_review_assessment('f6300000-0000-4000-8000-000000000031') r),
  'the review read did not expose the one server-resolved credited invoice');
select pg_temp.p63_assert(
  (select not (r #>> '{credit_resolution,resolved}')::boolean
          and r #>> '{credit_resolution,reason}' = 'ambiguous'
   from public.get_document_review_assessment('f6300000-0000-4000-8000-000000000032') r),
  'an ambiguous credited invoice was presented as resolved');

select pg_temp.p63_assert(
  (select r ->> 'outcome' = 'credit_received' and (r ->> 'applied')::boolean
          and r ->> 'credit_id' is not null
   from public.apply_reviewed_document(
     'f6300000-0000-4000-8000-000000000031',
     'f6300000-0000-4000-8000-000000000061',
     jsonb_build_object(
       'document_type', 'credit_note',
       'supplier_id', 'f6300000-0000-4000-8000-000000000011',
       'order_id', null, 'document_number', 'CN-1', 'document_date', current_date,
       'totals', jsonb_build_object('total', '60.00'), 'lines', '[]'::jsonb),
     'f6300000-0000-4000-8000-000000000071', 'P63 approved credit note') r),
  'an approved, uniquely resolved credit note did not create a received credit');

select pg_temp.p63_assert(
  (select count(*) = 1 and bool_and(status::text = 'received' and amount = 60
          and invoice_id = 'f6300000-0000-4000-8000-000000000021'
          and source_document_id = 'f6300000-0000-4000-8000-000000000031'
          and source_interpretation_id = 'f6300000-0000-4000-8000-000000000061')
   from public.credit_requests
   where source_document_id = 'f6300000-0000-4000-8000-000000000031'),
  'credit-note provenance, amount, invoice or received status was not preserved');
select pg_temp.p63_assert(
  (select credited_amount = 0 and balance_in_currency = 200
   from public.p0_invoice_balance_rows_by_currency()
   where invoice_id = 'f6300000-0000-4000-8000-000000000021'),
  'credit-note intake changed the invoice balance before any allocation');

select pg_temp.p63_assert(
  (select (r ->> 'idempotent')::boolean and r ->> 'credit_id' is not null
   from public.apply_reviewed_document(
     'f6300000-0000-4000-8000-000000000031',
     'f6300000-0000-4000-8000-000000000061',
     jsonb_build_object(
       'document_type', 'credit_note',
       'supplier_id', 'f6300000-0000-4000-8000-000000000011',
       'order_id', null, 'document_number', 'CN-1', 'document_date', current_date,
       'totals', jsonb_build_object('total', '60.00'), 'lines', '[]'::jsonb),
     'f6300000-0000-4000-8000-000000000071', 'P63 retry') r),
  'a retry did not return the original credit application');
select pg_temp.p63_assert(
  (select count(*) = 1 from public.credit_requests
   where source_document_id = 'f6300000-0000-4000-8000-000000000031'),
  'a retry created a second credit from one document');

do $$
begin
  perform public.apply_reviewed_document(
    'f6300000-0000-4000-8000-000000000032',
    'f6300000-0000-4000-8000-000000000062',
    jsonb_build_object(
      'document_type', 'credit_note',
      'supplier_id', 'f6300000-0000-4000-8000-000000000011',
      'order_id', null, 'document_number', 'CN-2', 'document_date', current_date,
      'totals', jsonb_build_object('total', '25.00'), 'lines', '[]'::jsonb),
    'f6300000-0000-4000-8000-000000000072', 'P63 ambiguous credit note');
  raise exception 'P63 financial credit assertion failed: ambiguous credit note was applied';
exception when sqlstate '55000' then
  if position('document_review_blocked' in sqlerrm) = 0 then raise; end if;
end
$$;
select pg_temp.p63_assert(
  not exists (select 1 from public.credit_requests
              where source_document_id = 'f6300000-0000-4000-8000-000000000032')
  and (select entity_type = 'inbox' from public.documents
       where id = 'f6300000-0000-4000-8000-000000000032'),
  'an unresolved credit note left review or created a credit');

-- ===== 2. Payment fixtures =====

-- The payable invoices are approved through the real command so accountant visibility and payment
-- execution use production-shaped approval snapshots.
select pg_temp.p63_activate('f6300000-0000-4000-8000-000000000002');
select public.set_invoice_review_status(id, 'in_review', 'P63 fixture enters review')
from public.invoices
where id = any (array[
  'f6300000-0000-4000-8000-000000000021',
  'f6300000-0000-4000-8000-000000000024',
  'f6300000-0000-4000-8000-000000000025',
  'f6300000-0000-4000-8000-000000000026',
  'f6300000-0000-4000-8000-000000000027',
  'f6300000-0000-4000-8000-000000000028',
  'f6300000-0000-4000-8000-000000000029']::uuid[])
order by id;
select public.set_invoice_review_status(id, 'approved', 'P63 fixture approved')
from public.invoices
where id = any (array[
  'f6300000-0000-4000-8000-000000000021',
  'f6300000-0000-4000-8000-000000000024',
  'f6300000-0000-4000-8000-000000000025',
  'f6300000-0000-4000-8000-000000000026',
  'f6300000-0000-4000-8000-000000000027',
  'f6300000-0000-4000-8000-000000000028',
  'f6300000-0000-4000-8000-000000000029']::uuid[])
order by id;

-- Fixture rows are written with no end-user subject, which is the branch p1_financial_command_guard
-- reserves for migrations and seeds. Leaving the owner's subject in place would instead make the
-- inserts depend on app.p1_financial_writer still holding the value the approval command left there.
reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);
select set_config('request.jwt.claims', '', true);

insert into public.payment_requests (
  id, org_id, supplier_id, amount, status, created_by, approved_by, approved_at
)
select ('f6300000-0000-4000-8000-0000000000' || spec.suffix)::uuid,
       'f6300000-0000-4000-8000-000000000001',
       'f6300000-0000-4000-8000-000000000011',
       spec.amount, 'approved',
       'f6300000-0000-4000-8000-000000000002',
       'f6300000-0000-4000-8000-000000000002', now()
from (values
  ('81', 100), ('82', 100), ('83', 100), ('84', 100),
  ('85', 120), ('86', 100), ('87', 100), ('88', 200),
  ('89', 100), ('8a', 100), ('8b', 100), ('8c', 100)
) as spec(suffix, amount);

insert into public.payment_request_invoices (org_id, payment_request_id, invoice_id, amount_allocated)
select 'f6300000-0000-4000-8000-000000000001',
       ('f6300000-0000-4000-8000-0000000000' || spec.request)::uuid,
       ('f6300000-0000-4000-8000-0000000000' || spec.invoice)::uuid,
       spec.amount
from (values
  ('81', '21', 100), ('82', '21', 100), ('83', '24', 100), ('84', '25', 100),
  ('85', '25', 120), ('86', '26', 100), ('87', '26', 100),
  ('88', '26', 100), ('88', '27', 100),
  ('89', '28', 100), ('8a', '29', 100), ('8b', '28', 100),
  -- 8c pays one invoice of its own supplier and one of another. There is no constraint stopping
  -- that shape, which is precisely why the credit's supplier has to be checked against the invoice
  -- it settles rather than against the request.
  ('8c', '28', 70), ('8c', '2a', 30)
) as spec(request, invoice, amount);

-- Five hand-built credits alongside the document credit. 93 and 95 deliberately name no invoice:
-- an unlinked credit may settle any invoice of its own supplier, and the executor has to be told
-- WHICH one. 93 is the specimen for the refusals, 95 for the allocation that records the link.
insert into public.credit_requests (
  id, org_id, supplier_id, invoice_id, reason, amount, status, created_by
) values
  ('f6300000-0000-4000-8000-000000000091', 'f6300000-0000-4000-8000-000000000001',
   'f6300000-0000-4000-8000-000000000011', 'f6300000-0000-4000-8000-000000000024',
   'other', 100, 'received', 'f6300000-0000-4000-8000-000000000002'),
  ('f6300000-0000-4000-8000-000000000092', 'f6300000-0000-4000-8000-000000000001',
   'f6300000-0000-4000-8000-000000000011', 'f6300000-0000-4000-8000-000000000025',
   'other', 50, 'received', 'f6300000-0000-4000-8000-000000000002'),
  ('f6300000-0000-4000-8000-000000000093', 'f6300000-0000-4000-8000-000000000001',
   'f6300000-0000-4000-8000-000000000011', null,
   'other', 30, 'received', 'f6300000-0000-4000-8000-000000000002'),
  ('f6300000-0000-4000-8000-000000000094', 'f6300000-0000-4000-8000-000000000001',
   'f6300000-0000-4000-8000-000000000011', 'f6300000-0000-4000-8000-000000000026',
   'other', 30, 'received', 'f6300000-0000-4000-8000-000000000002'),
  ('f6300000-0000-4000-8000-000000000095', 'f6300000-0000-4000-8000-000000000001',
   'f6300000-0000-4000-8000-000000000011', null,
   'other', 60, 'received', 'f6300000-0000-4000-8000-000000000002');

set local role authenticated;
select pg_temp.p63_activate('f6300000-0000-4000-8000-000000000003', true);

-- ===== 3. Partial consumption of a credit against its own invoice =====

select pg_temp.p63_assert(
  (select not (r ->> 'idempotent')::boolean
   from public.execute_payment_request(
     'f6300000-0000-4000-8000-000000000081', current_date, 'bank transfer',
     'P63-PARTIAL-A', null,
     jsonb_build_array(
       jsonb_build_object('invoice_id', 'f6300000-0000-4000-8000-000000000021',
         'credit_id', null, 'amount', 70),
       jsonb_build_object('invoice_id', null,
         'credit_id', (select id from public.credit_requests
                       where source_document_id = 'f6300000-0000-4000-8000-000000000031'),
         'amount', 30)),
     'P63 partial credit allocation') r),
  'a partial credit allocation was rejected');
select pg_temp.p63_assert(
  (select amount = 70 from public.payments where reference = 'P63-PARTIAL-A'),
  'the recorded bank payment includes the credit instead of only cash transferred');
select pg_temp.p63_assert(
  (select status = 'received' from public.credit_requests
   where source_document_id = 'f6300000-0000-4000-8000-000000000031')
  and (select remaining_amount = 30 and allocated_amount = 30
       from public.credit_request_balance_rows('f6300000-0000-4000-8000-000000000011')
       where credit_id = (select id from public.credit_requests
                          where source_document_id = 'f6300000-0000-4000-8000-000000000031')),
  'partial use did not stay received with a computed remaining balance');
select pg_temp.p63_assert(
  (select paid_amount = 70 and credited_amount = 30 and balance_in_currency = 100
   from public.p0_invoice_balance_rows_by_currency()
   where invoice_id = 'f6300000-0000-4000-8000-000000000021'),
  'the partial allocation, rather than intake, did not become the credited amount');

-- ===== 3a. The supplier card reports what is LEFT of the credit (0204) =====
-- A credit consumed in part stays `received`, so 0176's sum of the full `cr.amount` reported the
-- spent part as still available. Owner reads the true remainder; office, who may not read the
-- allocation ledger, gets a refusal instead of the pre-allocation figure.

select pg_temp.p63_activate('f6300000-0000-4000-8000-000000000002');

-- The positive control comes first: unless a partially consumed credit is live right here, the
-- assertion below cannot tell the two view bodies apart and would pass on either.
select pg_temp.p63_assert(
  (select coalesce(sum(amount), 0) <> coalesce(sum(remaining_amount), 0)
   from public.credit_request_balance_rows('f6300000-0000-4000-8000-000000000011')
   where status in ('open','requested','received')),
  'no partially consumed credit is live at this point, so the open-credit assertion proves nothing');

select pg_temp.p63_assert(
  (select m.open_credits_amount
   from public.supplier_metrics m
   where m.supplier_id = 'f6300000-0000-4000-8000-000000000011')
  = (select coalesce(sum(b.remaining_amount), 0)
     from public.credit_request_balance_rows('f6300000-0000-4000-8000-000000000011') b
     where b.status in ('open','requested','received')),
  'the supplier card open-credit amount is not the computed remaining balance');

select pg_temp.p63_activate('f6300000-0000-4000-8000-000000000004');
select pg_temp.p63_assert(
  (select open_credits > 0 and open_credits_amount is null
   from public.supplier_metrics
   where supplier_id = 'f6300000-0000-4000-8000-000000000011'),
  'office was shown an open-credit amount it cannot compute inside its own read boundary');

select pg_temp.p63_activate('f6300000-0000-4000-8000-000000000003', true);

select public.execute_payment_request(
  'f6300000-0000-4000-8000-000000000082', current_date, 'bank transfer',
  'P63-PARTIAL-B', null,
  jsonb_build_array(
    jsonb_build_object('invoice_id', 'f6300000-0000-4000-8000-000000000021',
      'credit_id', null, 'amount', 70),
    jsonb_build_object('invoice_id', null,
      'credit_id', (select id from public.credit_requests
                    where source_document_id = 'f6300000-0000-4000-8000-000000000031'),
      'amount', 30)),
  'P63 final credit allocation');
select pg_temp.p63_assert(
  (select status = 'offset' and resolved_at is not null from public.credit_requests
   where source_document_id = 'f6300000-0000-4000-8000-000000000031')
  and (select remaining_amount = 0 and allocated_amount = 60
       from public.credit_request_balance_rows('f6300000-0000-4000-8000-000000000011')
       where credit_id = (select id from public.credit_requests
                          where source_document_id = 'f6300000-0000-4000-8000-000000000031')),
  'full consumption did not move the credit to offset exactly at zero remaining');
select pg_temp.p63_assert(
  (select balance_in_currency = 0 from public.p0_invoice_balance_rows_by_currency()
   where invoice_id = 'f6300000-0000-4000-8000-000000000021'),
  'two cash-plus-credit payments did not settle the invoice they named');

-- ===== 4. A payment settled by cash plus a PARTLY consumed credit reads as paid =====
--
-- Credit 91 is 100 against INV-PAID-BY-CREDIT and only 40 of it is used here, so it stays
-- `received`. Under the lifecycle rule the invoice therefore counted zero credit, reported 40
-- outstanding and stayed `partial` for ever. The balance is the same either way; the status is not.
select public.execute_payment_request(
  'f6300000-0000-4000-8000-000000000083', current_date, 'bank transfer',
  'P63-PAID-BY-CREDIT', null,
  jsonb_build_array(
    jsonb_build_object('invoice_id', 'f6300000-0000-4000-8000-000000000024',
      'credit_id', null, 'amount', 60),
    jsonb_build_object('invoice_id', null,
      'credit_id', 'f6300000-0000-4000-8000-000000000091', 'amount', 40)),
  'P63 cash plus partly consumed credit');
reset role;
select pg_temp.p63_assert(
  (select payment_status = 'paid' from public.invoices
   where id = 'f6300000-0000-4000-8000-000000000024')
  and (select status = 'received' from public.credit_requests
       where id = 'f6300000-0000-4000-8000-000000000091'),
  'an invoice settled by cash plus a partly consumed credit did not read as paid');
set local role authenticated;
select pg_temp.p63_activate('f6300000-0000-4000-8000-000000000003', true);

-- ===== 5. The overpayment the lifecycle rule allowed =====
--
-- INV-OVERPAY is 200. 60 cash and 40 of credit 92 leave 100. The lifecycle rule counted the
-- still-`received` credit as zero and would have accepted another 120 of cash -- 20 more than the
-- invoice is worth. The guard now measures allocations that happened.
select public.execute_payment_request(
  'f6300000-0000-4000-8000-000000000084', current_date, 'bank transfer',
  'P63-OVERPAY-BASE', null,
  jsonb_build_array(
    jsonb_build_object('invoice_id', 'f6300000-0000-4000-8000-000000000025',
      'credit_id', null, 'amount', 60),
    jsonb_build_object('invoice_id', null,
      'credit_id', 'f6300000-0000-4000-8000-000000000092', 'amount', 40)),
  'P63 overpay baseline');
select pg_temp.p63_assert(
  (select balance_in_currency = 100 from public.p0_invoice_balance_rows_by_currency()
   where invoice_id = 'f6300000-0000-4000-8000-000000000025'),
  'the baseline payment did not leave exactly 100 outstanding');
select pg_temp.p63_expect_error(
  $$select public.execute_payment_request(
      'f6300000-0000-4000-8000-000000000085', current_date, 'bank transfer',
      'P63-OVERPAY', null,
      jsonb_build_array(
        jsonb_build_object('invoice_id', 'f6300000-0000-4000-8000-000000000025',
          'credit_id', null, 'amount', 120)),
      'P63 overpay attempt')$$,
  'allocation_exceeds_balance');
select pg_temp.p63_assert(
  not exists (select 1 from public.payments where reference = 'P63-OVERPAY'),
  'the refused overpayment still recorded a payment');

-- ===== 6. A credit may only settle its own invoice =====
--
-- Credit 91 belongs to INV-PAID-BY-CREDIT and has 60 remaining, so amount, status, supplier and
-- remainder all pass. The only predicate it fails is containment: its invoice is not in this
-- request. Before the fix this succeeded and silently left the named invoice 30 short.
select pg_temp.p63_expect_error(
  $$select public.execute_payment_request(
      'f6300000-0000-4000-8000-000000000086', current_date, 'bank transfer',
      'P63-FOREIGN-CREDIT', null,
      jsonb_build_array(
        jsonb_build_object('invoice_id', 'f6300000-0000-4000-8000-000000000026',
          'credit_id', null, 'amount', 70),
        jsonb_build_object('invoice_id', null,
          'credit_id', 'f6300000-0000-4000-8000-000000000091', 'amount', 30)),
      'P63 credit from another invoice')$$,
  'allocation_target_invalid');

-- An unlinked credit that names no target invoice. Everything else about this payload is legal --
-- 93 is received, belongs to the request's supplier, has its full 30 remaining, and 70 + 30 covers
-- INV-FOREIGN-CREDIT exactly. The single missing thing is the answer to "which invoice", and the
-- executor must ask for it by name rather than choose one.
select pg_temp.p63_expect_error(
  $$select public.execute_payment_request(
      'f6300000-0000-4000-8000-000000000087', current_date, 'bank transfer',
      'P63-UNLINKED-NO-TARGET', null,
      jsonb_build_array(
        jsonb_build_object('invoice_id', 'f6300000-0000-4000-8000-000000000026',
          'credit_id', null, 'amount', 70),
        jsonb_build_object('invoice_id', null,
          'credit_id', 'f6300000-0000-4000-8000-000000000093', 'amount', 30)),
      'P63 unlinked credit with no target')$$,
  'credit_allocation_invoice_required');

-- An unlinked credit aimed at an invoice of ANOTHER supplier. INV-CROSS-SUPPLIER really is one of
-- this request's invoices and takes no cash here, so containment and the cash branch both pass it.
-- Only the supplier predicate stands between supplier 11's credit and supplier 12's invoice.
select pg_temp.p63_expect_error(
  $$select public.execute_payment_request(
      'f6300000-0000-4000-8000-00000000008c', current_date, 'bank transfer',
      'P63-CROSS-SUPPLIER', null,
      jsonb_build_array(
        jsonb_build_object('invoice_id', 'f6300000-0000-4000-8000-000000000028',
          'credit_id', null, 'amount', 70),
        jsonb_build_object('invoice_id', null,
          'credit_id', 'f6300000-0000-4000-8000-000000000093', 'amount', 30,
          'credit_invoice_id', 'f6300000-0000-4000-8000-00000000002a')),
      'P63 credit aimed at another supplier')$$,
  'credit_allocation_supplier_mismatch');

-- A LINKED credit may not be re-aimed. Credit 94 belongs to INV-FOREIGN-CREDIT; naming
-- INV-COVERAGE for it is a request to move a recorded link, and both invoices are in this request
-- so containment alone would not notice. The recorded link wins over the caller's hint.
select pg_temp.p63_expect_error(
  $$select public.execute_payment_request(
      'f6300000-0000-4000-8000-000000000088', current_date, 'bank transfer',
      'P63-RELINK', null,
      jsonb_build_array(
        jsonb_build_object('invoice_id', 'f6300000-0000-4000-8000-000000000026',
          'credit_id', null, 'amount', 100),
        jsonb_build_object('invoice_id', 'f6300000-0000-4000-8000-000000000027',
          'credit_id', null, 'amount', 70),
        jsonb_build_object('invoice_id', null,
          'credit_id', 'f6300000-0000-4000-8000-000000000094', 'amount', 30,
          'credit_invoice_id', 'f6300000-0000-4000-8000-000000000027')),
      'P63 linked credit aimed elsewhere')$$,
  'allocation_target_invalid');

-- The target rides on the credit row, never on the cash row: a cash allocation that carries one is
-- a caller mistake, not a second way to say the same thing.
select pg_temp.p63_expect_error(
  $$select public.execute_payment_request(
      'f6300000-0000-4000-8000-000000000089', current_date, 'bank transfer',
      'P63-TARGET-ON-CASH', null,
      jsonb_build_array(
        jsonb_build_object('invoice_id', 'f6300000-0000-4000-8000-000000000028',
          'credit_id', null, 'amount', 100,
          'credit_invoice_id', 'f6300000-0000-4000-8000-000000000028')),
      'P63 target on a cash row')$$,
  'allocation_invalid');

-- ===== 7. The cash a credit displaces comes off the credit's own invoice =====
--
-- Both invoices belong to the request, both cash rows fit their own allocation and the totals add
-- up to the approved 200, so every pre-existing check passes. What does not add up is per invoice:
-- INV-FOREIGN-CREDIT would receive 100 cash AND its own 30 credit while INV-COVERAGE is left 30
-- short. Allocation order in an unordered array decided who got overpaid.
select pg_temp.p63_expect_error(
  $$select public.execute_payment_request(
      'f6300000-0000-4000-8000-000000000088', current_date, 'bank transfer',
      'P63-COVERAGE', null,
      jsonb_build_array(
        jsonb_build_object('invoice_id', 'f6300000-0000-4000-8000-000000000026',
          'credit_id', null, 'amount', 100),
        jsonb_build_object('invoice_id', 'f6300000-0000-4000-8000-000000000027',
          'credit_id', null, 'amount', 70),
        jsonb_build_object('invoice_id', null,
          'credit_id', 'f6300000-0000-4000-8000-000000000094', 'amount', 30)),
      'P63 credit paid off the wrong invoice')$$,
  'allocation_invoice_coverage_mismatch');
reset role;
select pg_temp.p63_assert(
  not exists (select 1 from public.payments
              where reference in ('P63-FOREIGN-CREDIT', 'P63-UNLINKED-NO-TARGET',
                                  'P63-CROSS-SUPPLIER', 'P63-RELINK', 'P63-TARGET-ON-CASH',
                                  'P63-COVERAGE'))
  and (select coalesce(sum(amount), 0) = 0 from public.payment_allocations
       where credit_id in ('f6300000-0000-4000-8000-000000000093',
                           'f6300000-0000-4000-8000-000000000094')),
  'a refused allocation still moved money');

-- ===== 8. An unlinked credit settles any invoice of its supplier, and is linked doing it =====
--
-- Credit 95 is 60 with no invoice. It is applied 30 at a time to INV-UNLINKED-TARGET, which belongs
-- to its own supplier and is paid by this request. The first allocation is what the owner ruled on:
-- it succeeds AND records the link.
set local role authenticated;
select pg_temp.p63_activate('f6300000-0000-4000-8000-000000000003', true);

select pg_temp.p63_assert(
  (select not (r ->> 'idempotent')::boolean
   from public.execute_payment_request(
     'f6300000-0000-4000-8000-000000000089', current_date, 'bank transfer',
     'P63-UNLINKED-A', null,
     jsonb_build_array(
       jsonb_build_object('invoice_id', 'f6300000-0000-4000-8000-000000000028',
         'credit_id', null, 'amount', 70),
       jsonb_build_object('invoice_id', null,
         'credit_id', 'f6300000-0000-4000-8000-000000000095', 'amount', 30,
         'credit_invoice_id', 'f6300000-0000-4000-8000-000000000028')),
     'P63 unlinked credit takes its invoice') r),
  'an unlinked credit was refused against an invoice of its own supplier');
select pg_temp.p63_assert(
  (select remaining_amount = 30 and allocated_amount = 30
   from public.credit_request_balance_rows('f6300000-0000-4000-8000-000000000011')
   where credit_id = 'f6300000-0000-4000-8000-000000000095'),
  'the newly linked credit did not report half of itself consumed');
select pg_temp.p63_assert(
  (select paid_amount = 70 and credited_amount = 30 and balance_in_currency = 100
   from public.p0_invoice_balance_rows_by_currency()
   where invoice_id = 'f6300000-0000-4000-8000-000000000028'),
  'the credit an unlinked allocation applied did not reach the invoice it named');

reset role;
select pg_temp.p63_assert(
  (select invoice_id = 'f6300000-0000-4000-8000-000000000028' and status::text = 'received'
   from public.credit_requests where id = 'f6300000-0000-4000-8000-000000000095'),
  'the allocation did not record the link on the credit');
-- The link is a change to a financial record, so it carries the executing accountant's own reason.
select pg_temp.p63_assert(
  (select count(*) = 1
   from public.audit_logs
   where entity_type = 'credit_requests'
     and entity_id = 'f6300000-0000-4000-8000-000000000095'
     and action = 'credit_request_invoice_linked'
     and old_values ->> 'invoice_id' is null
     and new_values ->> 'invoice_id' = 'f6300000-0000-4000-8000-000000000028'
     and reason = 'P63 unlinked credit takes its invoice'),
  'recording the link was not audited with the caller reason');
set local role authenticated;
select pg_temp.p63_activate('f6300000-0000-4000-8000-000000000003', true);

-- The link is not advisory. The remaining 30 cannot be moved to a different invoice, whether the
-- caller names the new invoice or lets the recorded one speak: a credit's applied total is
-- attributed to exactly one invoice by every balance reader, so a split would misstate both.
select pg_temp.p63_expect_error(
  $$select public.execute_payment_request(
      'f6300000-0000-4000-8000-00000000008a', current_date, 'bank transfer',
      'P63-UNLINKED-MOVED', null,
      jsonb_build_array(
        jsonb_build_object('invoice_id', 'f6300000-0000-4000-8000-000000000029',
          'credit_id', null, 'amount', 70),
        jsonb_build_object('invoice_id', null,
          'credit_id', 'f6300000-0000-4000-8000-000000000095', 'amount', 30,
          'credit_invoice_id', 'f6300000-0000-4000-8000-000000000029')),
      'P63 linked credit moved by name')$$,
  'allocation_target_invalid');
select pg_temp.p63_expect_error(
  $$select public.execute_payment_request(
      'f6300000-0000-4000-8000-00000000008a', current_date, 'bank transfer',
      'P63-UNLINKED-DRIFT', null,
      jsonb_build_array(
        jsonb_build_object('invoice_id', 'f6300000-0000-4000-8000-000000000029',
          'credit_id', null, 'amount', 70),
        jsonb_build_object('invoice_id', null,
          'credit_id', 'f6300000-0000-4000-8000-000000000095', 'amount', 30)),
      'P63 linked credit drifting to another request')$$,
  'allocation_target_invalid');

-- The remainder settles the invoice the link names, and the caller no longer has to repeat it.
select public.execute_payment_request(
  'f6300000-0000-4000-8000-00000000008b', current_date, 'bank transfer',
  'P63-UNLINKED-B', null,
  jsonb_build_array(
    jsonb_build_object('invoice_id', 'f6300000-0000-4000-8000-000000000028',
      'credit_id', null, 'amount', 70),
    jsonb_build_object('invoice_id', null,
      'credit_id', 'f6300000-0000-4000-8000-000000000095', 'amount', 30)),
  'P63 once-unlinked credit finishes');
select pg_temp.p63_assert(
  (select remaining_amount = 0 and allocated_amount = 60
   from public.credit_request_balance_rows('f6300000-0000-4000-8000-000000000011')
   where credit_id = 'f6300000-0000-4000-8000-000000000095')
  and (select balance_in_currency = 0 from public.p0_invoice_balance_rows_by_currency()
       where invoice_id = 'f6300000-0000-4000-8000-000000000028'),
  'the second half of the once-unlinked credit did not close its invoice');
reset role;
select pg_temp.p63_assert(
  (select status::text = 'offset' and resolved_at is not null
          and invoice_id = 'f6300000-0000-4000-8000-000000000028'
   from public.credit_requests where id = 'f6300000-0000-4000-8000-000000000095'),
  'exhausting a once-unlinked credit did not offset it against the invoice it was linked to');
-- Linking happens once, at the moment it becomes true -- not again on every later allocation.
select pg_temp.p63_assert(
  (select count(*) = 1 from public.audit_logs
   where entity_type = 'credit_requests'
     and entity_id = 'f6300000-0000-4000-8000-000000000095'
     and action = 'credit_request_invoice_linked'),
  'a later allocation of an already linked credit audited the link again');

-- ===== 9. No live financial reader answers from lifecycle labels any more =====
--
-- The four readers 0173 patched forward are not otherwise reachable from a transactional suite:
-- soft_delete_supplier needs a supplier with no balance and no orders, and both approval-side
-- readers need a pending request built through the approval command. Their bodies are asserted
-- directly, which is the same idiom p64 uses for the reversal consumption anchor.
do $$
declare
  v_stale text;
begin
  select string_agg(proc.oid::regprocedure::text, ', ' order by proc.oid::regprocedure::text)
    into v_stale
  from pg_catalog.pg_proc proc
  where proc.oid in (
    'public.execute_payment_request(uuid,date,text,text,text,jsonb,text)'::regprocedure,
    'public.p0_invoice_balance_rows_by_currency()'::regprocedure,
    'public.p1_refresh_invoice_payment_statuses(uuid,uuid[])'::regprocedure,
    'public.soft_delete_supplier(uuid,text)'::regprocedure,
    'public.payment_request_financial_check_signals(uuid,numeric,uuid[],uuid)'::regprocedure,
    'public.p1_transition_payment_request(uuid,text,text,boolean,text,uuid,numeric)'::regprocedure
  )
    and position('cr.status in (''offset''' in replace(proc.prosrc, e'\r', '')) > 0;
  if v_stale is not null then
    raise exception
      'P63 financial credit assertion failed: lifecycle-based credit consumption survives in %',
      v_stale;
  end if;
  if position('applied.credit_id = cr.id' in replace(pg_get_functiondef(
       'public.p1_transition_payment_request(uuid,text,text,boolean,text,uuid,numeric)'::regprocedure
     ), e'\r', '')) = 0 then
    raise exception
      'P63 financial credit assertion failed: the open-credit override barrier still sums the original credit amount';
  end if;
  if position('applied.credit_id = cr.id' in replace(pg_get_functiondef(
       'public.payment_request_financial_check_signals(uuid,numeric,uuid[],uuid)'::regprocedure
     ), e'\r', '')) = 0 then
    raise exception
      'P63 financial credit assertion failed: the office open-credit signal still sums the original credit amount';
  end if;
  -- The fail-closed placeholder is not merely unreachable, it is gone. An executor that can still
  -- raise it is one that never learned the 2026-08-23 ruling.
  if position('credit_request_not_linked_to_invoice' in replace(pg_get_functiondef(
       'public.execute_payment_request(uuid,date,text,text,text,jsonb,text)'::regprocedure
     ), e'\r', '')) > 0 then
    raise exception
      'P63 financial credit assertion failed: the unlinked-credit placeholder refusal survives';
  end if;
end
$$;

rollback;

select 'p63_financial_credit_contracts_passed' as result;
