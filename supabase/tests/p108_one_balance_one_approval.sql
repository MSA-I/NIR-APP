-- P108 — one balance, one approval.
--
-- Run only against a disposable database with every migration applied. This file COMMITS its
-- fixtures and opens independent sessions with dblink, exactly as
-- payment_credit_override_concurrency.sql and p63_financial_credit_concurrency.sql do; reset the
-- database before every run and run psql as the disposable DB superuser.
--
-- WHAT IS UNDER TEST, and why it could not be measured before. `MON-01`: an invoice of 640.00 with
-- 300.00 already approved accepted a second request for the whole 640.00 AND approved it, so
-- 940.00 stood against a 640.00 debt and both reached the accountant's queue — where `/pay` records
-- a transfer the bank has already made, so the refusal at execution arrives after the money is
-- gone. Owner decision #350 rules that an invoice's money is committed at APPROVAL: creation of a
-- second request stays legal, approval of the one that no longer fits is refused BY NAME, and
-- splitting a payment stays legal.
--
-- EVERY REFUSAL BELOW IS MEASURED ON THE GUARDED PATH. The fixtures are written as the superuser —
-- `p1_financial_command_guard` lets a caller with no end-user subject through, which is what a
-- migration or a seed is — but every command under test is called with `role` set to
-- `authenticated` and a real `request.jwt.claim.sub`, so `auth_org()`, `auth_role()` and the
-- financial guard all see a person. A proof run as `postgres` would prove nothing.
--
-- The outcomes are RECORDED and asserted at the end rather than asserted where they happen. Under
-- ON_ERROR_STOP a suite that asserts inline stops at the first failure and reports one line; this
-- one reports every scenario that disagreed with #350 in a single message, which is what a red run
-- has to say to be worth reading.
\set ON_ERROR_STOP on

create extension if not exists dblink;
drop schema if exists p108 cascade;
create schema p108;

create table p108.results (step text primary key, outcome text not null);
grant usage on schema p108 to authenticated;
grant insert, select on p108.results to authenticated;

-- 'ok', or the server's own message. The step names below are the contract; the expectations live
-- in one table at the bottom so the red run prints the whole picture at once.
create function p108.try_sql(p_sql text)
returns text language plpgsql security invoker as $$
begin
  begin
    execute p_sql;
  exception when others then
    return sqlerrm;
  end;
  return 'ok';
end
$$;
grant execute on function p108.try_sql(text) to authenticated;

create function p108.assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P108 assertion failed: %', p_message;
  end if;
end
$$;

-- ===== Fixture =====

insert into public.organizations (id, name, status, vat_rate) values
  ('f1080000-0000-4000-8000-000000000001', 'P108 tenant', 'active', 18);

select u.id as legal_entity
from public.org_units u
where u.org_id = 'f1080000-0000-4000-8000-000000000001'
  and u.unit_type = 'legal_entity'
order by u.created_at, u.id
limit 1
\gset p108_

insert into auth.users (id, email) values
  ('f1080000-0000-4000-8000-000000000002', 'p108-owner@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('f1080000-0000-4000-8000-000000000002', 'f1080000-0000-4000-8000-000000000001',
   'P108 owner', 'owner');

-- Two suppliers. The reservation supplier carries NO credit, so the open-credit override barrier
-- never fires and the only thing that can refuse an approval is the invoice balance. The credit
-- supplier exists only for §119 and is never approved.
insert into public.suppliers (id, org_id, name, status) values
  ('f1080000-0000-4000-8000-000000000011', 'f1080000-0000-4000-8000-000000000001',
   'P108 reservation supplier', 'active'),
  ('f1080000-0000-4000-8000-000000000012', 'f1080000-0000-4000-8000-000000000001',
   'P108 partial-credit supplier', 'active');

insert into public.invoices (
  id, org_id, unit_id, supplier_id, invoice_number, invoice_date,
  amount_before_vat, vat_amount, total_amount, review_status, payment_status, currency
) values
  -- the sequential MON-01 case
  ('f1080000-0000-4000-8000-000000000021', 'f1080000-0000-4000-8000-000000000001',
   :'p108_legal_entity', 'f1080000-0000-4000-8000-000000000011',
   'P108-SEQUENTIAL', current_date, 640, 0, 640, 'received', 'unpaid', 'ILS'),
  -- the split control: two approvals that together equal the balance must both pass
  ('f1080000-0000-4000-8000-000000000022', 'f1080000-0000-4000-8000-000000000001',
   :'p108_legal_entity', 'f1080000-0000-4000-8000-000000000011',
   'P108-SPLIT', current_date, 640, 0, 640, 'received', 'unpaid', 'ILS'),
  -- the two-session race
  ('f1080000-0000-4000-8000-000000000023', 'f1080000-0000-4000-8000-000000000001',
   :'p108_legal_entity', 'f1080000-0000-4000-8000-000000000011',
   'P108-RACE', current_date, 640, 0, 640, 'received', 'unpaid', 'ILS'),
  -- DEBT §119: a partially consumed credit the writer cannot see
  ('f1080000-0000-4000-8000-000000000024', 'f1080000-0000-4000-8000-000000000001',
   :'p108_legal_entity', 'f1080000-0000-4000-8000-000000000012',
   'P108-PARTIAL-CREDIT', current_date, 900, 0, 900, 'received', 'unpaid', 'ILS');

-- 0099 forbids a trusted fixture from materialising an approved invoice without the same
-- server-authoritative transition production uses.
select set_config('request.jwt.claim.sub', 'f1080000-0000-4000-8000-000000000002', false);
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'f1080000-0000-4000-8000-000000000002'
)::text, false);
set role authenticated;
select public.set_invoice_review_status('f1080000-0000-4000-8000-000000000021', 'in_review', 'P108 fixture review started');
select public.set_invoice_review_status('f1080000-0000-4000-8000-000000000021', 'approved', 'P108 fixture approved');
select public.set_invoice_review_status('f1080000-0000-4000-8000-000000000022', 'in_review', 'P108 fixture review started');
select public.set_invoice_review_status('f1080000-0000-4000-8000-000000000022', 'approved', 'P108 fixture approved');
select public.set_invoice_review_status('f1080000-0000-4000-8000-000000000023', 'in_review', 'P108 fixture review started');
select public.set_invoice_review_status('f1080000-0000-4000-8000-000000000023', 'approved', 'P108 fixture approved');
select public.set_invoice_review_status('f1080000-0000-4000-8000-000000000024', 'in_review', 'P108 fixture review started');
select public.set_invoice_review_status('f1080000-0000-4000-8000-000000000024', 'approved', 'P108 fixture approved');
reset role;
-- The subject goes with the role. `p1_financial_command_guard` lets a caller with no end-user
-- subject through — that is what a migration or a seed is — and refuses one that has a subject but
-- did not come through an RPC. Leaving the owner's `sub` set here would turn the fixture rows
-- below into `financial_command_rpc_required`.
select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '', false);

-- §119 fixture: a credit of 300.00 against the 900.00 invoice, of which 120.00 has actually been
-- applied. It stays `received` because that is what a partially consumed credit is — and that is
-- precisely the state the writer could not see while the reader subtracted the 120.00.
insert into public.credit_requests (
  id, org_id, supplier_id, invoice_id, reason, amount, status, created_by, currency
) values (
  'f1080000-0000-4000-8000-000000000041', 'f1080000-0000-4000-8000-000000000001',
  'f1080000-0000-4000-8000-000000000012', 'f1080000-0000-4000-8000-000000000024',
  'other', 300, 'received', 'f1080000-0000-4000-8000-000000000002', 'ILS');

insert into public.payments (
  id, org_id, unit_id, supplier_id, amount, paid_date, method, reference, executed_by, currency
) values (
  'f1080000-0000-4000-8000-000000000051', 'f1080000-0000-4000-8000-000000000001',
  :'p108_legal_entity', 'f1080000-0000-4000-8000-000000000012', 120, current_date,
  'credit offset', 'P108-PARTIAL-CREDIT', 'f1080000-0000-4000-8000-000000000002', 'ILS');

-- A credit allocation names its credit and carries a null invoice_id (0234:107-111), which is why
-- the writer's payments term does not double-count it.
insert into public.payment_allocations (id, org_id, payment_id, invoice_id, credit_id, amount, currency)
values (
  'f1080000-0000-4000-8000-000000000061', 'f1080000-0000-4000-8000-000000000001',
  'f1080000-0000-4000-8000-000000000051', null,
  'f1080000-0000-4000-8000-000000000041', 120, 'ILS');

-- ===== The commands, every one of them on the guarded path =====

select set_config('request.jwt.claim.sub', 'f1080000-0000-4000-8000-000000000002', false);
select set_config('request.jwt.claim.role', 'authenticated', false);
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', 'f1080000-0000-4000-8000-000000000002',
  'amr', jsonb_build_array(jsonb_build_object(
    'method', 'password', 'timestamp', extract(epoch from clock_timestamp())::bigint
  ))
)::text, false);
set role authenticated;

-- --- What the product prints, before anything is requested. 900 − 120 applied credit. ---
insert into p108.results(step, outcome)
select 'reader_prints_partial_credit_balance',
       coalesce((select balance_in_currency::text from public.invoice_balances_by_currency
                 where invoice_id = 'f1080000-0000-4000-8000-000000000024'), 'no row');

-- --- MON-01, sequential: 300 approved, then 640 on the same invoice ---
insert into p108.results(step, outcome) values ('mon01_first_create', p108.try_sql($sql$
  select public.create_payment_request(
    'f1080000-0000-4000-8000-000000000031'::uuid,
    'f1080000-0000-4000-8000-000000000011'::uuid, null::date, null::text, 'pending_approval',
    jsonb_build_array(jsonb_build_object(
      'invoice_id', 'f1080000-0000-4000-8000-000000000021', 'amount', 300)),
    'P108 first request for part of the balance')
$sql$));
insert into p108.results(step, outcome) values ('mon01_first_approve', p108.try_sql($sql$
  select public.transition_payment_request(
    'f1080000-0000-4000-8000-000000000031'::uuid, 'approved', 'P108 approves the first request')
$sql$));

-- #350 allows this. A second request on the same invoice may be typed; what it may not do is be
-- approved past the balance. The screen states it critically, the server states it at approval.
insert into p108.results(step, outcome) values ('mon01_second_create', p108.try_sql($sql$
  select public.create_payment_request(
    'f1080000-0000-4000-8000-000000000032'::uuid,
    'f1080000-0000-4000-8000-000000000011'::uuid, null::date, null::text, 'pending_approval',
    jsonb_build_array(jsonb_build_object(
      'invoice_id', 'f1080000-0000-4000-8000-000000000021', 'amount', 640)),
    'P108 second request for the whole balance')
$sql$));
insert into p108.results(step, outcome) values ('mon01_second_approve', p108.try_sql($sql$
  select public.transition_payment_request(
    'f1080000-0000-4000-8000-000000000032'::uuid, 'approved', 'P108 approves the second request')
$sql$));

-- --- The split control: 250 + 390 against 640. #350 does not forbid splitting a payment. ---
insert into p108.results(step, outcome) values ('split_first_create', p108.try_sql($sql$
  select public.create_payment_request(
    'f1080000-0000-4000-8000-000000000033'::uuid,
    'f1080000-0000-4000-8000-000000000011'::uuid, null::date, null::text, 'pending_approval',
    jsonb_build_array(jsonb_build_object(
      'invoice_id', 'f1080000-0000-4000-8000-000000000022', 'amount', 250)),
    'P108 first half of a split payment')
$sql$));
insert into p108.results(step, outcome) values ('split_first_approve', p108.try_sql($sql$
  select public.transition_payment_request(
    'f1080000-0000-4000-8000-000000000033'::uuid, 'approved', 'P108 approves the first half')
$sql$));
insert into p108.results(step, outcome) values ('split_second_create', p108.try_sql($sql$
  select public.create_payment_request(
    'f1080000-0000-4000-8000-000000000034'::uuid,
    'f1080000-0000-4000-8000-000000000011'::uuid, null::date, null::text, 'pending_approval',
    jsonb_build_array(jsonb_build_object(
      'invoice_id', 'f1080000-0000-4000-8000-000000000022', 'amount', 390)),
    'P108 second half of a split payment')
$sql$));
insert into p108.results(step, outcome) values ('split_second_approve', p108.try_sql($sql$
  select public.transition_payment_request(
    'f1080000-0000-4000-8000-000000000034'::uuid, 'approved', 'P108 approves the second half')
$sql$));

-- --- DEBT §119: an allocation above the balance the product printed ---
insert into p108.results(step, outcome) values ('debt119_over_printed_balance', p108.try_sql($sql$
  select public.create_payment_request(
    'f1080000-0000-4000-8000-000000000035'::uuid,
    'f1080000-0000-4000-8000-000000000012'::uuid, null::date, null::text, 'pending_approval',
    jsonb_build_array(jsonb_build_object(
      'invoice_id', 'f1080000-0000-4000-8000-000000000024', 'amount', 900)),
    'P108 asks for the whole invoice, ignoring the credit already applied')
$sql$));
insert into p108.results(step, outcome) values ('debt119_at_printed_balance', p108.try_sql($sql$
  select public.create_payment_request(
    'f1080000-0000-4000-8000-000000000036'::uuid,
    'f1080000-0000-4000-8000-000000000012'::uuid, null::date, null::text, 'pending_approval',
    jsonb_build_array(jsonb_build_object(
      'invoice_id', 'f1080000-0000-4000-8000-000000000024', 'amount', 780)),
    'P108 asks for exactly the balance the product prints')
$sql$));

-- --- The two requests that will race. Created here, approved from two sessions below. ---
insert into p108.results(step, outcome) values ('race_first_create', p108.try_sql($sql$
  select public.create_payment_request(
    'f1080000-0000-4000-8000-000000000037'::uuid,
    'f1080000-0000-4000-8000-000000000011'::uuid, null::date, null::text, 'pending_approval',
    jsonb_build_array(jsonb_build_object(
      'invoice_id', 'f1080000-0000-4000-8000-000000000023', 'amount', 400)),
    'P108 race request A')
$sql$));
insert into p108.results(step, outcome) values ('race_second_create', p108.try_sql($sql$
  select public.create_payment_request(
    'f1080000-0000-4000-8000-000000000038'::uuid,
    'f1080000-0000-4000-8000-000000000011'::uuid, null::date, null::text, 'pending_approval',
    jsonb_build_array(jsonb_build_object(
      'invoice_id', 'f1080000-0000-4000-8000-000000000023', 'amount', 380)),
    'P108 race request B')
$sql$));

reset role;
select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claim.role', '', false);
select set_config('request.jwt.claims', '', false);

-- ===== Two sessions, one invoice =====
--
-- 400 and 380 each fit a 640.00 invoice on their own and cannot both be approved. The pause holds
-- the first session inside its transaction — AFTER it has taken the id-ordered invoice lock and
-- BEFORE it commits — so the second is measurably behind rather than merely second in the file.
-- Without it the two could serialise by luck and the suite would go green having proved nothing.
create function p108.pause_first_approval()
returns trigger language plpgsql as $$
begin
  if new.id = 'f1080000-0000-4000-8000-000000000037' and new.status = 'approved'
     and old.status is distinct from 'approved' then
    perform pg_sleep(1.2);
  end if;
  return new;
end
$$;
create trigger zz_p108_pause_first_approval
  before update on public.payment_requests
  for each row execute function p108.pause_first_approval();

create function p108.approve_as_owner(p_request uuid, p_reason text)
returns text language plpgsql security invoker as $$
begin
  perform set_config('request.jwt.claim.sub', 'f1080000-0000-4000-8000-000000000002', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', 'f1080000-0000-4000-8000-000000000002',
    'amr', jsonb_build_array(jsonb_build_object(
      'method', 'password', 'timestamp', extract(epoch from clock_timestamp())::bigint
    ))
  )::text, true);
  perform set_config('statement_timeout', '20000', true);
  perform set_config('role', 'authenticated', true);
  begin
    perform public.transition_payment_request(p_request, 'approved', p_reason);
  exception when others then
    return sqlerrm;
  end;
  return 'ok';
end
$$;

select dblink_connect('p108_a', 'dbname=' || current_database());
select dblink_connect('p108_b', 'dbname=' || current_database());
select dblink_send_query('p108_a', $$select p108.approve_as_owner(
  'f1080000-0000-4000-8000-000000000037', 'P108 race session A')$$);
select pg_sleep(0.2);
select dblink_send_query('p108_b', $$select p108.approve_as_owner(
  'f1080000-0000-4000-8000-000000000038', 'P108 race session B')$$);
insert into p108.results(step, outcome)
select 'race_session_a', result from dblink_get_result('p108_a') as t(result text);
insert into p108.results(step, outcome)
select 'race_session_b', result from dblink_get_result('p108_b') as t(result text);
select dblink_disconnect('p108_a');
select dblink_disconnect('p108_b');

drop trigger zz_p108_pause_first_approval on public.payment_requests;

-- ===== One report =====

create table p108.expectations (step text primary key, expected text not null, note text not null);
insert into p108.expectations (step, expected, note) values
  ('reader_prints_partial_credit_balance', '780.00',
   'the reader subtracts the 120.00 of credit actually applied to the 900.00 invoice'),
  ('mon01_first_create', 'ok', 'a request for part of an open balance is created'),
  ('mon01_first_approve', 'ok', 'and approved, which is where its money is committed (#350)'),
  ('mon01_second_create', 'ok',
   '#350 allows a second request on the same invoice to be typed'),
  ('mon01_second_approve', 'payment_request_invoice_reserved',
   'MON-01: approving 640.00 on an invoice already holding 300.00 approved must be refused BY NAME'),
  ('split_first_create', 'ok', 'splitting a payment stays legal'),
  ('split_first_approve', 'ok', '250.00 of a 640.00 balance'),
  ('split_second_create', 'ok', 'and the remainder'),
  ('split_second_approve', 'ok',
   '390.00 more against the same invoice: 250 + 390 = 640 and the guard must not refuse it'),
  ('debt119_over_printed_balance', 'payment_request_allocation_invalid',
   'DEBT §119: the writer must not admit 900.00 where the reader prints 780.00'),
  ('debt119_at_printed_balance', 'ok',
   'and must admit exactly the number the product printed'),
  ('race_first_create', 'ok', 'two requests that each fit alone'),
  ('race_second_create', 'ok', 'and cannot both be approved');

-- ONE raise, every disagreement inside it — the sequential scenarios and the race together. A
-- report that stops at the first mismatch sends the reader back for a second full run to learn
-- the second one, and a suite that commits its fixtures cannot simply be run twice.
do $report$
declare
  v_lines text;
  v_race_ok int;
  v_race_refused int;
begin
  select string_agg(format('  %s: expected %L, got %L  (%s)',
                           e.step, e.expected, coalesce(r.outcome, '(no row)'), e.note), e'\n'
                    order by e.step)
    into v_lines
  from p108.expectations e
  left join p108.results r on r.step = e.step
  where r.outcome is null
     or (e.expected = 'ok' and r.outcome <> 'ok')
     or (e.expected <> 'ok' and position(e.expected in r.outcome) = 0);

  select count(*) filter (where outcome = 'ok'),
         count(*) filter (where position('payment_request_invoice_reserved' in outcome) > 0)
    into v_race_ok, v_race_refused
  from p108.results where step in ('race_session_a', 'race_session_b');
  if v_race_ok <> 1 or v_race_refused <> 1 then
    v_lines := concat_ws(e'\n', v_lines, format(
      '  race: %s approval(s) succeeded and %s were refused by name; exactly one of each is required'
      || e'\n    session a: %L\n    session b: %L',
      v_race_ok, v_race_refused,
      (select outcome from p108.results where step = 'race_session_a'),
      (select outcome from p108.results where step = 'race_session_b')));
  end if;

  if v_lines is not null then
    raise exception e'P108 failed — #350 is not enforced:\n%', v_lines;
  end if;
end
$report$;

-- The arithmetic, not only the refusals: what actually stands against each invoice afterwards.
select p108.assert(
  (select coalesce(sum(pri.amount_allocated), 0) = 300
   from public.payment_request_invoices pri
   join public.payment_requests pr on pr.org_id = pri.org_id and pr.id = pri.payment_request_id
   where pri.invoice_id = 'f1080000-0000-4000-8000-000000000021'
     and pr.status in ('approved', 'sent_for_execution')),
  'the sequential invoice ended up holding more approved money than its balance');
select p108.assert(
  (select coalesce(sum(pri.amount_allocated), 0) = 640
   from public.payment_request_invoices pri
   join public.payment_requests pr on pr.org_id = pri.org_id and pr.id = pri.payment_request_id
   where pri.invoice_id = 'f1080000-0000-4000-8000-000000000022'
     and pr.status in ('approved', 'sent_for_execution')),
  'the split invoice did not end up with both halves approved');
select p108.assert(
  (select coalesce(sum(pri.amount_allocated), 0) in (400, 380)
   from public.payment_request_invoices pri
   join public.payment_requests pr on pr.org_id = pri.org_id and pr.id = pri.payment_request_id
   where pri.invoice_id = 'f1080000-0000-4000-8000-000000000023'
     and pr.status in ('approved', 'sent_for_execution')),
  'the raced invoice ended up holding both approvals');
-- The refused second request is still there and still workable: #350 refuses the commitment, not
-- the record. Cancelling it is the user's decision, not the guard's.
select p108.assert(
  (select status = 'pending_approval' from public.payment_requests
   where id = 'f1080000-0000-4000-8000-000000000032'),
  'the refused request was moved or destroyed instead of left for a person to decide on');

drop schema p108 cascade;

select 'p108_one_balance_one_approval_passed' as result;
