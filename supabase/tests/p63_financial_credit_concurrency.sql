-- P63 partial-credit concurrency harness.
--
-- Run only against a disposable database with all migrations through 0173 applied.
-- This file intentionally commits fixtures and opens independent sessions with dblink.
-- Clone/reset the database before every run; run psql as the disposable DB superuser.
--
-- The transactional half of P63 lives in p63_financial_credit_contracts.sql and rolls back. This
-- half exists because the thing under test cannot be observed in one session: two accountants
-- executing at the same moment must not both spend the same remainder of one credit. The split is
-- the same one payment_credit_override_concurrency.sql makes for the 0073 races.
--
-- The credit under test is UNLINKED, which is now the sharpest version of the race: the winner does
-- not merely spend part of the remainder, it also decides -- and records -- which invoice this credit
-- belongs to for good. Both requests deliberately name the SAME invoice as the credit's target, so
-- the only scarce thing is the remainder. Give them different targets and the loser would be refused
-- because the winner's link contradicts its own, which is containment, not the race: the test would
-- go green while proving nothing about the lock. A third, single-session payment runs afterwards and
-- succeeds on exactly the remainder the loser was denied, which is what separates "refused because
-- the money was gone" from "refused because the credit had become unreachable".
\set ON_ERROR_STOP on

create extension if not exists dblink;
drop schema if exists p63_credit_concurrency cascade;
create schema p63_credit_concurrency;

create function p63_credit_concurrency.assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P63 concurrency assertion failed: %', p_message;
  end if;
end
$$;

create table p63_credit_concurrency.results (runner text primary key, result jsonb not null);

insert into public.organizations (id, name, status, vat_rate) values
  ('f6390000-0000-4000-8000-000000000001', 'P63 concurrency tenant', 'active', 18);

select u.id as legal_entity
from public.org_units u
where u.org_id = 'f6390000-0000-4000-8000-000000000001'
  and u.unit_type = 'legal_entity'
order by u.created_at, u.id
limit 1
\gset p63c_

insert into auth.users (id, email) values
  ('f6390000-0000-4000-8000-000000000002', 'p63-concurrency-owner@example.test'),
  ('f6390000-0000-4000-8000-000000000003', 'p63-concurrency-accountant@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('f6390000-0000-4000-8000-000000000002', 'f6390000-0000-4000-8000-000000000001',
   'P63 concurrency owner', 'owner'),
  ('f6390000-0000-4000-8000-000000000003', 'f6390000-0000-4000-8000-000000000001',
   'P63 concurrency accountant', 'accountant');

insert into public.suppliers (id, org_id, name, status) values
  ('f6390000-0000-4000-8000-000000000011', 'f6390000-0000-4000-8000-000000000001',
   'P63 concurrency supplier', 'active');

-- 200, so both 100 requests fit the invoice and only the 25 credit is genuinely scarce. If the
-- invoice were the scarce resource the loser would be refused for the balance rather than for the
-- credit, and the race under test would never be reached.
insert into public.invoices (
  id, org_id, unit_id, supplier_id, invoice_number, invoice_date,
  amount_before_vat, vat_amount, total_amount, review_status, payment_status
) values
  ('f6390000-0000-4000-8000-000000000021', 'f6390000-0000-4000-8000-000000000001',
   :'p63c_legal_entity', 'f6390000-0000-4000-8000-000000000011',
   'P63-CONCURRENCY-CREDIT', current_date, 200, 0, 200, 'received', 'unpaid');

-- Approved through the real command so the executor meets a production-shaped approval.
select set_config('request.jwt.claim.sub', 'f6390000-0000-4000-8000-000000000002', false);
set role authenticated;
select public.set_invoice_review_status(
  'f6390000-0000-4000-8000-000000000021', 'in_review', 'P63 concurrency fixture enters review');
select public.set_invoice_review_status(
  'f6390000-0000-4000-8000-000000000021', 'approved', 'P63 concurrency fixture approved');
reset role;
select set_config('request.jwt.claim.sub', '', false);

insert into public.credit_requests (
  id, org_id, supplier_id, invoice_id, reason, amount, status, created_by
) values (
  'f6390000-0000-4000-8000-000000000041',
  'f6390000-0000-4000-8000-000000000001',
  'f6390000-0000-4000-8000-000000000011',
  null,
  'other', 25, 'received', 'f6390000-0000-4000-8000-000000000002');

-- Both requests are written already approved: this harness measures execution, and routing them
-- through the approval command would additionally trip the open-credit override barrier, which has
-- its own suite in payment_credit_override_concurrency.sql.
insert into public.payment_requests (
  id, org_id, unit_id, supplier_id, amount, status, created_by, approved_by, approved_at
) values
  ('f6390000-0000-4000-8000-000000000031', 'f6390000-0000-4000-8000-000000000001',
   :'p63c_legal_entity', 'f6390000-0000-4000-8000-000000000011', 100, 'approved',
   'f6390000-0000-4000-8000-000000000002', 'f6390000-0000-4000-8000-000000000002', now()),
  ('f6390000-0000-4000-8000-000000000032', 'f6390000-0000-4000-8000-000000000001',
   :'p63c_legal_entity', 'f6390000-0000-4000-8000-000000000011', 100, 'approved',
   'f6390000-0000-4000-8000-000000000002', 'f6390000-0000-4000-8000-000000000002', now()),
  -- The control: 5 of cash and the 5 of credit the loser could not have.
  ('f6390000-0000-4000-8000-000000000033', 'f6390000-0000-4000-8000-000000000001',
   :'p63c_legal_entity', 'f6390000-0000-4000-8000-000000000011', 10, 'approved',
   'f6390000-0000-4000-8000-000000000002', 'f6390000-0000-4000-8000-000000000002', now());

insert into public.payment_request_invoices (org_id, payment_request_id, invoice_id, amount_allocated)
values
  ('f6390000-0000-4000-8000-000000000001', 'f6390000-0000-4000-8000-000000000031',
   'f6390000-0000-4000-8000-000000000021', 100),
  ('f6390000-0000-4000-8000-000000000001', 'f6390000-0000-4000-8000-000000000032',
   'f6390000-0000-4000-8000-000000000021', 100),
  ('f6390000-0000-4000-8000-000000000001', 'f6390000-0000-4000-8000-000000000033',
   'f6390000-0000-4000-8000-000000000021', 10);

create function p63_credit_concurrency.activate()
returns void language plpgsql security invoker as $$
begin
  perform set_config('request.jwt.claim.sub', 'f6390000-0000-4000-8000-000000000003', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', 'f6390000-0000-4000-8000-000000000003',
    'amr', jsonb_build_array(jsonb_build_object(
      'method', 'password', 'timestamp', extract(epoch from clock_timestamp())::bigint
    ))
  )::text, true);
  perform set_config('statement_timeout', '7000', true);
  perform set_config('role', 'authenticated', true);
end
$$;

-- The pause holds the credit row lock long enough for the second session to be measurably behind.
create function p63_credit_concurrency.pause_first_credit_allocation()
returns trigger language plpgsql as $$
begin
  if new.credit_id = 'f6390000-0000-4000-8000-000000000041' then
    perform pg_sleep(1.2);
  end if;
  return new;
end
$$;
create trigger zz_p63_pause_credit_allocation
before insert on public.payment_allocations
for each row execute function p63_credit_concurrency.pause_first_credit_allocation();

create function p63_credit_concurrency.run_payment(p_request uuid, p_reference text)
returns jsonb language plpgsql security invoker as $$
begin
  perform p63_credit_concurrency.activate();
  begin
    return public.execute_payment_request(
      p_request, current_date, 'bank transfer', p_reference, null,
      jsonb_build_array(
        jsonb_build_object('invoice_id', 'f6390000-0000-4000-8000-000000000021',
          'credit_id', null, 'amount', 80),
        jsonb_build_object('invoice_id', null,
          'credit_id', 'f6390000-0000-4000-8000-000000000041', 'amount', 20,
          'credit_invoice_id', 'f6390000-0000-4000-8000-000000000021')),
      'P63 concurrent partial credit allocation');
  exception when others then
    if position('allocation_target_invalid' in sqlerrm) = 0 then raise; end if;
    return jsonb_build_object('error', 'allocation_target_invalid');
  end;
end
$$;

-- The control names no target at all: by the time it runs the credit is linked, so it travels the
-- ordinary linked path. If the loser had been refused for containment rather than for the
-- remainder, this call -- which asks for less money against the same invoice -- would fail too.
create function p63_credit_concurrency.run_control()
returns jsonb language plpgsql security invoker as $$
begin
  perform p63_credit_concurrency.activate();
  return public.execute_payment_request(
    'f6390000-0000-4000-8000-000000000033', current_date, 'bank transfer', 'P63-RACE-CONTROL', null,
    jsonb_build_array(
      jsonb_build_object('invoice_id', 'f6390000-0000-4000-8000-000000000021',
        'credit_id', null, 'amount', 5),
      jsonb_build_object('invoice_id', null,
        'credit_id', 'f6390000-0000-4000-8000-000000000041', 'amount', 5)),
    'P63 control takes the remainder the loser was denied');
end
$$;

select dblink_connect('p63_a', 'dbname=' || current_database());
select dblink_connect('p63_b', 'dbname=' || current_database());
select dblink_send_query('p63_a', $$select p63_credit_concurrency.run_payment(
  'f6390000-0000-4000-8000-000000000031', 'P63-RACE-A')$$);
select pg_sleep(0.15);
select dblink_send_query('p63_b', $$select p63_credit_concurrency.run_payment(
  'f6390000-0000-4000-8000-000000000032', 'P63-RACE-B')$$);
insert into p63_credit_concurrency.results
select 'a', result from dblink_get_result('p63_a') as t(result jsonb);
insert into p63_credit_concurrency.results
select 'b', result from dblink_get_result('p63_b') as t(result jsonb);
select dblink_disconnect('p63_a');
select dblink_disconnect('p63_b');

select p63_credit_concurrency.assert(
  (select count(*) filter (where result ->> 'error' = 'allocation_target_invalid') = 1
      and count(*) filter (where result ->> 'payment_id' is not null) = 1
   from p63_credit_concurrency.results),
  'concurrent payments did not produce exactly one success and one refusal');
select p63_credit_concurrency.assert(
  (select coalesce(sum(amount), 0) = 20 from public.payment_allocations
   where credit_id = 'f6390000-0000-4000-8000-000000000041'),
  'concurrent payments over-allocated one credit');
select p63_credit_concurrency.assert(
  (select status = 'received' and resolved_at is null from public.credit_requests
   where id = 'f6390000-0000-4000-8000-000000000041'),
  'a credit with 5 remaining did not stay received');
select p63_credit_concurrency.assert(
  (select count(*) = 1 and bool_and(amount = 80) from public.payments
   where payment_request_id in ('f6390000-0000-4000-8000-000000000031',
                                'f6390000-0000-4000-8000-000000000032')),
  'the winning payment recorded something other than the cash it transferred');
select p63_credit_concurrency.assert(
  (select payment_status = 'partial' from public.invoices
   where id = 'f6390000-0000-4000-8000-000000000021')
  and (select count(*) = 1 from public.payment_requests
       where org_id = 'f6390000-0000-4000-8000-000000000001' and status = 'executed'),
  'the refused session still moved the invoice or its own request');

-- The winner decided what this credit belongs to, and said so in the ledger. The loser wrote
-- nothing: one link, one audit row, whichever session got there first.
select p63_credit_concurrency.assert(
  (select invoice_id = 'f6390000-0000-4000-8000-000000000021' and status = 'received'
   from public.credit_requests where id = 'f6390000-0000-4000-8000-000000000041'),
  'the winning session did not record the link on the unlinked credit');
select p63_credit_concurrency.assert(
  (select count(*) = 1 from public.audit_logs
   where entity_type = 'credit_requests'
     and entity_id = 'f6390000-0000-4000-8000-000000000041'
     and action = 'credit_request_invoice_linked'
     and new_values ->> 'invoice_id' = 'f6390000-0000-4000-8000-000000000021'
     and reason = 'P63 concurrent partial credit allocation'),
  'the recorded link was audited twice, or not at all, under contention');

drop trigger zz_p63_pause_credit_allocation on public.payment_allocations;

-- The loser lost the money, not the invoice. A refusal here aborts the suite under ON_ERROR_STOP,
-- which is the assertion: the control must be able to spend exactly what the loser could not.
select p63_credit_concurrency.run_control();
select p63_credit_concurrency.assert(
  (select count(*) = 1 and bool_and(amount = 5) from public.payments
   where reference = 'P63-RACE-CONTROL'),
  'the remainder of the once-unlinked credit was unreachable after the race');
select p63_credit_concurrency.assert(
  (select coalesce(sum(amount), 0) = 25 from public.payment_allocations
   where credit_id = 'f6390000-0000-4000-8000-000000000041')
  and (select status = 'offset' and resolved_at is not null
       and invoice_id = 'f6390000-0000-4000-8000-000000000021'
       from public.credit_requests where id = 'f6390000-0000-4000-8000-000000000041'),
  'the control did not exhaust the credit against the invoice the winner linked it to');
select p63_credit_concurrency.assert(
  (select count(*) = 1 from public.audit_logs
   where entity_type = 'credit_requests'
     and entity_id = 'f6390000-0000-4000-8000-000000000041'
     and action = 'credit_request_invoice_linked'),
  'a later allocation of the already linked credit audited the link again');

drop schema p63_credit_concurrency cascade;

select 'p63_financial_credit_concurrency_passed' as result;
