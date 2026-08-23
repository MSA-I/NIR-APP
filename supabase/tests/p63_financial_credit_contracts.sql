-- P63 -- approved credit-note intake and partial credit allocations.
--
-- This suite proves the two owner decisions that close DEBT §49-§50:
--   * an approved credit note creates one received credit only when supplier and credited invoice
--     resolve uniquely; the document remains evidence and intake alone changes no balance;
--   * credit allocations consume only the remaining amount under the credit row lock. Partial use
--     stays received, full use becomes offset, and two payments cannot consume the same remainder.
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
  ('f6300000-0000-4000-8000-000000000003', 'p63-accountant@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('f6300000-0000-4000-8000-000000000002', 'f6300000-0000-4000-8000-000000000001',
   'P63 owner', 'owner'),
  ('f6300000-0000-4000-8000-000000000003', 'f6300000-0000-4000-8000-000000000001',
   'P63 accountant', 'accountant');

insert into public.suppliers (id, org_id, name, status) values
  ('f6300000-0000-4000-8000-000000000011', 'f6300000-0000-4000-8000-000000000001',
   'P63 supplier', 'active');

insert into public.invoices (
  id, org_id, supplier_id, invoice_number, invoice_date,
  amount_before_vat, vat_amount, total_amount, review_status
) values
  ('f6300000-0000-4000-8000-000000000021', 'f6300000-0000-4000-8000-000000000001',
   'f6300000-0000-4000-8000-000000000011', 'INV-CREDITED', current_date, 100, 0, 100, 'received'),
  ('f6300000-0000-4000-8000-000000000022', 'f6300000-0000-4000-8000-000000000001',
   'f6300000-0000-4000-8000-000000000011', 'INV-AMBIGUOUS', current_date, 100, 0, 100, 'received'),
  ('f6300000-0000-4000-8000-000000000023', 'f6300000-0000-4000-8000-000000000001',
   'f6300000-0000-4000-8000-000000000011', 'INV-AMBIGUOUS', current_date, 100, 0, 100, 'received'),
  ('f6300000-0000-4000-8000-000000000024', 'f6300000-0000-4000-8000-000000000001',
   'f6300000-0000-4000-8000-000000000011', 'INV-PARTIAL-A', current_date, 100, 0, 100, 'received'),
  ('f6300000-0000-4000-8000-000000000025', 'f6300000-0000-4000-8000-000000000001',
   'f6300000-0000-4000-8000-000000000011', 'INV-PARTIAL-B', current_date, 100, 0, 100, 'received'),
  ('f6300000-0000-4000-8000-000000000026', 'f6300000-0000-4000-8000-000000000001',
   'f6300000-0000-4000-8000-000000000011', 'INV-RACE-A', current_date, 100, 0, 100, 'received'),
  ('f6300000-0000-4000-8000-000000000027', 'f6300000-0000-4000-8000-000000000001',
   'f6300000-0000-4000-8000-000000000011', 'INV-RACE-B', current_date, 100, 0, 100, 'received');

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
  (select credited_amount = 0 and balance = 100
   from public.p0_invoice_balance_rows()
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

-- The four payment invoices are approved through the real command so accountant visibility and
-- payment execution use production-shaped approval snapshots.
select pg_temp.p63_activate('f6300000-0000-4000-8000-000000000002');
select public.set_invoice_review_status(id, 'in_review', 'P63 fixture enters review')
from public.invoices where id between
  'f6300000-0000-4000-8000-000000000024'::uuid and
  'f6300000-0000-4000-8000-000000000027'::uuid order by id;
select public.set_invoice_review_status(id, 'approved', 'P63 fixture approved')
from public.invoices where id between
  'f6300000-0000-4000-8000-000000000024'::uuid and
  'f6300000-0000-4000-8000-000000000027'::uuid order by id;

reset role;
insert into public.payment_requests (
  id, org_id, supplier_id, amount, status, created_by, approved_by, approved_at
) values
  ('f6300000-0000-4000-8000-000000000081', 'f6300000-0000-4000-8000-000000000001',
   'f6300000-0000-4000-8000-000000000011', 100, 'approved',
   'f6300000-0000-4000-8000-000000000002', 'f6300000-0000-4000-8000-000000000002', now()),
  ('f6300000-0000-4000-8000-000000000082', 'f6300000-0000-4000-8000-000000000001',
   'f6300000-0000-4000-8000-000000000011', 100, 'approved',
   'f6300000-0000-4000-8000-000000000002', 'f6300000-0000-4000-8000-000000000002', now()),
  ('f6300000-0000-4000-8000-000000000083', 'f6300000-0000-4000-8000-000000000001',
   'f6300000-0000-4000-8000-000000000011', 100, 'approved',
   'f6300000-0000-4000-8000-000000000002', 'f6300000-0000-4000-8000-000000000002', now()),
  ('f6300000-0000-4000-8000-000000000084', 'f6300000-0000-4000-8000-000000000001',
   'f6300000-0000-4000-8000-000000000011', 100, 'approved',
   'f6300000-0000-4000-8000-000000000002', 'f6300000-0000-4000-8000-000000000002', now());
insert into public.payment_request_invoices (org_id, payment_request_id, invoice_id, amount_allocated) values
  ('f6300000-0000-4000-8000-000000000001', 'f6300000-0000-4000-8000-000000000081',
   'f6300000-0000-4000-8000-000000000024', 100),
  ('f6300000-0000-4000-8000-000000000001', 'f6300000-0000-4000-8000-000000000082',
   'f6300000-0000-4000-8000-000000000025', 100),
  ('f6300000-0000-4000-8000-000000000001', 'f6300000-0000-4000-8000-000000000083',
   'f6300000-0000-4000-8000-000000000026', 100),
  ('f6300000-0000-4000-8000-000000000001', 'f6300000-0000-4000-8000-000000000084',
   'f6300000-0000-4000-8000-000000000027', 100);
insert into public.credit_requests (
  id, org_id, supplier_id, invoice_id, reason, amount, status, created_by
) values (
  'f6300000-0000-4000-8000-000000000091',
  'f6300000-0000-4000-8000-000000000001',
  'f6300000-0000-4000-8000-000000000011',
  'f6300000-0000-4000-8000-000000000026',
  'other', 25, 'received', 'f6300000-0000-4000-8000-000000000002');

set local role authenticated;
select pg_temp.p63_activate('f6300000-0000-4000-8000-000000000003', true);

select pg_temp.p63_assert(
  (select not (r ->> 'idempotent')::boolean
   from public.execute_payment_request(
     'f6300000-0000-4000-8000-000000000081', current_date, 'bank transfer',
     'P63-PARTIAL-A', null,
     jsonb_build_array(
       jsonb_build_object('invoice_id', 'f6300000-0000-4000-8000-000000000024',
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
  (select credited_amount = 30 and balance = 70
   from public.p0_invoice_balance_rows()
   where invoice_id = 'f6300000-0000-4000-8000-000000000021'),
  'the partial allocation, rather than intake, did not become the credited amount');

select public.execute_payment_request(
  'f6300000-0000-4000-8000-000000000082', current_date, 'bank transfer',
  'P63-PARTIAL-B', null,
  jsonb_build_array(
    jsonb_build_object('invoice_id', 'f6300000-0000-4000-8000-000000000025',
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

commit;

-- Real concurrent sessions. A trigger pauses the first credit allocation while it holds the
-- credit row lock; the second request must wait, re-read the remaining balance and refuse.
create extension if not exists dblink;
drop schema if exists p63_credit_concurrency cascade;
create schema p63_credit_concurrency;
create table p63_credit_concurrency.results (runner text primary key, result jsonb not null);

create function p63_credit_concurrency.activate()
returns void language plpgsql security invoker as $$
begin
  perform set_config('request.jwt.claim.sub', 'f6300000-0000-4000-8000-000000000003', true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', 'f6300000-0000-4000-8000-000000000003',
    'amr', jsonb_build_array(jsonb_build_object(
      'method', 'password', 'timestamp', extract(epoch from clock_timestamp())::bigint
    ))
  )::text, true);
  perform set_config('statement_timeout', '7000', true);
  perform set_config('role', 'authenticated', true);
end
$$;

create function p63_credit_concurrency.pause_first_credit_allocation()
returns trigger language plpgsql as $$
begin
  if new.credit_id = 'f6300000-0000-4000-8000-000000000091' then
    perform pg_sleep(1.2);
  end if;
  return new;
end
$$;
create trigger zz_p63_pause_credit_allocation
before insert on public.payment_allocations
for each row execute function p63_credit_concurrency.pause_first_credit_allocation();

create function p63_credit_concurrency.run_payment(
  p_request uuid, p_invoice uuid, p_reference text
) returns jsonb language plpgsql security invoker as $$
begin
  perform p63_credit_concurrency.activate();
  begin
    return public.execute_payment_request(
      p_request, current_date, 'bank transfer', p_reference, null,
      jsonb_build_array(
        jsonb_build_object('invoice_id', p_invoice, 'credit_id', null, 'amount', 80),
        jsonb_build_object('invoice_id', null,
          'credit_id', 'f6300000-0000-4000-8000-000000000091', 'amount', 20)),
      'P63 concurrent partial credit allocation');
  exception when others then
    if position('allocation_target_invalid' in sqlerrm) = 0 then raise; end if;
    return jsonb_build_object('error', 'allocation_target_invalid');
  end;
end
$$;

select dblink_connect('p63_a', 'dbname=' || current_database());
select dblink_connect('p63_b', 'dbname=' || current_database());
select dblink_send_query('p63_a', $$select p63_credit_concurrency.run_payment(
  'f6300000-0000-4000-8000-000000000083',
  'f6300000-0000-4000-8000-000000000026', 'P63-RACE-A')$$);
select pg_sleep(0.15);
select dblink_send_query('p63_b', $$select p63_credit_concurrency.run_payment(
  'f6300000-0000-4000-8000-000000000084',
  'f6300000-0000-4000-8000-000000000027', 'P63-RACE-B')$$);
insert into p63_credit_concurrency.results
select 'a', result from dblink_get_result('p63_a') as t(result jsonb);
insert into p63_credit_concurrency.results
select 'b', result from dblink_get_result('p63_b') as t(result jsonb);
select dblink_disconnect('p63_a');
select dblink_disconnect('p63_b');

do $$
begin
  if not (
    select count(*) filter (where result ->> 'error' = 'allocation_target_invalid') = 1
       and count(*) filter (where result ->> 'payment_id' is not null) = 1
    from p63_credit_concurrency.results
  ) then
    raise exception 'P63 financial credit assertion failed: concurrent payments did not produce one success and one refusal';
  end if;
  if (select coalesce(sum(amount), 0) from public.payment_allocations
      where credit_id = 'f6300000-0000-4000-8000-000000000091') <> 20 then
    raise exception 'P63 financial credit assertion failed: concurrent payments over-allocated one credit';
  end if;
  if (select status <> 'received' from public.credit_requests
      where id = 'f6300000-0000-4000-8000-000000000091') then
    raise exception 'P63 financial credit assertion failed: a credit with 5 remaining left received';
  end if;
end
$$;

drop trigger zz_p63_pause_credit_allocation on public.payment_allocations;
drop schema p63_credit_concurrency cascade;

select 'p63_financial_credit_contracts_passed' as result;
