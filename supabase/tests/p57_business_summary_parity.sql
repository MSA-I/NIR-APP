-- P57 -- One definition for the business summary (0165): the five metrics the /alerts screen and
-- the assistant tool both consume, proven against independently re-derived literal queries over a
-- known fixture -- the suite re-derives the truth rather than calling the function twice. Run only
-- against an isolated local database after all migrations through 0165. Rolled back.
\set ON_ERROR_STOP on

begin;

-- Legacy invoice fixtures in this transaction predate multi-currency and are explicitly ILS.
alter table public.invoices alter column currency set default 'ILS';

create function pg_temp.p57_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P57 business summary assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p57_as(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_user, 'amr', '[]'::jsonb)::text, true);
end
$$;

-- The business day the function is defined against. Computed the same way, independently.
create function pg_temp.p57_today()
returns date language sql stable as $$
  select (now() at time zone 'Asia/Jerusalem')::date
$$;

-- ===== Structural claims =====
-- INVOKER is the design: RLS and unit scope must produce exactly the visibility the browser's
-- own queries produced before 0165. A definer here would widen five aggregates for every caller.
select pg_temp.p57_assert(
  not (select procedure.prosecdef from pg_proc procedure
       join pg_namespace space on space.oid = procedure.pronamespace
       where space.nspname = 'public' and procedure.proname = 'p2_business_summary_rows_by_currency'),
  'p2_business_summary_rows_by_currency is SECURITY DEFINER');

-- Same rule as my_entitlements(): a tenant summary must not accept an organization argument,
-- because a parameter is a thing an attacker can change.
select pg_temp.p57_assert(
  (select procedure.pronargs from pg_proc procedure
    join pg_namespace space on space.oid = procedure.pronamespace
   where space.nspname = 'public' and procedure.proname = 'p2_business_summary_rows_by_currency') = 0,
  'p2_business_summary_rows_by_currency grew a parameter');

select pg_temp.p57_assert(
  has_function_privilege('authenticated', 'public.p2_business_summary_rows_by_currency()', 'execute'),
  'the browser role cannot call the summary at all');
select pg_temp.p57_assert(
  not has_function_privilege('anon', 'public.p2_business_summary_rows_by_currency()', 'execute'),
  'anon can read a business summary');

-- ===== Fixture =====
insert into public.organizations (id, name, status) values
  ('57000000-0000-4000-8000-000000000001', 'P57 tenant A', 'active'),
  ('57000000-0000-4000-8000-000000000002', 'P57 tenant B', 'active');

insert into auth.users (id, email) values
  ('57000000-0000-4000-8000-000000000101', 'owner-a-p57@example.test'),
  ('57000000-0000-4000-8000-000000000102', 'owner-b-p57@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('57000000-0000-4000-8000-000000000101', '57000000-0000-4000-8000-000000000001', 'P57 owner A', 'owner'),
  ('57000000-0000-4000-8000-000000000102', '57000000-0000-4000-8000-000000000002', 'P57 owner B', 'owner');

insert into public.suppliers (id, org_id, name) values
  ('57000000-0000-4000-8000-000000000201', '57000000-0000-4000-8000-000000000001', 'P57 raiser'),
  ('57000000-0000-4000-8000-000000000202', '57000000-0000-4000-8000-000000000001', 'P57 old raiser'),
  ('57000000-0000-4000-8000-000000000203', '57000000-0000-4000-8000-000000000001', 'P57 discounter'),
  ('57000000-0000-4000-8000-000000000204', '57000000-0000-4000-8000-000000000002', 'P57 tenant-B supplier');

insert into public.products (id, org_id, name, unit) values
  ('57000000-0000-4000-8000-000000000301', '57000000-0000-4000-8000-000000000001', 'P57 product 1', 'unit'),
  ('57000000-0000-4000-8000-000000000302', '57000000-0000-4000-8000-000000000001', 'P57 product 2', 'unit'),
  ('57000000-0000-4000-8000-000000000303', '57000000-0000-4000-8000-000000000002', 'P57 product B', 'unit');

-- received_week wants exactly 2: in-window received + in-window pending. The -6/-8 margins are
-- race-safe: if the business day ticks over mid-suite, -6 is still inside a 7-day window and -8
-- is still outside it.
insert into public.invoices (
  id, org_id, supplier_id, invoice_number, invoice_date, received_date,
  amount_before_vat, vat_amount, total_amount, review_status, financial_role, deleted_at
) values
  -- counted by received_week only
  ('57000000-0000-4000-8000-000000000401', '57000000-0000-4000-8000-000000000001',
   '57000000-0000-4000-8000-000000000201', 'P57-A-1', '2026-08-01', pg_temp.p57_today() - 6,
   100, 18, 118, 'received', 'payable', null),
  -- counted by received_week AND awaiting_approval
  ('57000000-0000-4000-8000-000000000402', '57000000-0000-4000-8000-000000000001',
   '57000000-0000-4000-8000-000000000201', 'P57-A-2', '2026-08-01', pg_temp.p57_today() - 6,
   100, 18, 118, 'pending_approval', 'payable', null),
  -- awaiting_approval only: pending, but received outside the 7-day window
  ('57000000-0000-4000-8000-000000000403', '57000000-0000-4000-8000-000000000001',
   '57000000-0000-4000-8000-000000000202', 'P57-A-3', '2026-08-01', pg_temp.p57_today() - 8,
   100, 18, 118, 'pending_approval', 'payable', null),
  ('57000000-0000-4000-8000-000000000404', '57000000-0000-4000-8000-000000000001',
   '57000000-0000-4000-8000-000000000202', 'P57-A-4', '2026-08-01', pg_temp.p57_today() - 9,
   100, 18, 118, 'pending_approval', 'payable', null),
  -- soft-deleted: counted by nothing
  ('57000000-0000-4000-8000-000000000405', '57000000-0000-4000-8000-000000000001',
   '57000000-0000-4000-8000-000000000201', 'P57-A-5', '2026-08-01', pg_temp.p57_today() - 6,
   100, 18, 118, 'received', 'payable', now()),
  -- supporting evidence (0137): not a payable, counted by nothing
  ('57000000-0000-4000-8000-000000000406', '57000000-0000-4000-8000-000000000001',
   '57000000-0000-4000-8000-000000000201', 'P57-A-6', '2026-08-01', pg_temp.p57_today() - 6,
   100, 18, 118, 'received', 'supporting_evidence', null),
  -- tenant B: one in-window pending invoice, invisible to A
  ('57000000-0000-4000-8000-000000000407', '57000000-0000-4000-8000-000000000002',
   '57000000-0000-4000-8000-000000000204', 'P57-B-1', '2026-08-01', pg_temp.p57_today() - 6,
   100, 18, 118, 'pending_approval', 'payable', null);

-- expected_payments: the four active statuses sum to 375.25; executed and cancelled are not open.
insert into public.payment_requests (id, org_id, supplier_id, amount, status, created_by) values
  ('57000000-0000-4000-8000-000000000501', '57000000-0000-4000-8000-000000000001',
   '57000000-0000-4000-8000-000000000201', 100.25, 'draft', '57000000-0000-4000-8000-000000000101'),
  ('57000000-0000-4000-8000-000000000502', '57000000-0000-4000-8000-000000000001',
   '57000000-0000-4000-8000-000000000201', 200.00, 'approved', '57000000-0000-4000-8000-000000000101'),
  ('57000000-0000-4000-8000-000000000503', '57000000-0000-4000-8000-000000000001',
   '57000000-0000-4000-8000-000000000202', 50.00, 'pending_approval', '57000000-0000-4000-8000-000000000101'),
  ('57000000-0000-4000-8000-000000000504', '57000000-0000-4000-8000-000000000001',
   '57000000-0000-4000-8000-000000000202', 25.00, 'sent_for_execution', '57000000-0000-4000-8000-000000000101'),
  ('57000000-0000-4000-8000-000000000505', '57000000-0000-4000-8000-000000000001',
   '57000000-0000-4000-8000-000000000201', 999.00, 'executed', '57000000-0000-4000-8000-000000000101'),
  ('57000000-0000-4000-8000-000000000506', '57000000-0000-4000-8000-000000000001',
   '57000000-0000-4000-8000-000000000201', 111.00, 'cancelled', '57000000-0000-4000-8000-000000000101'),
  ('57000000-0000-4000-8000-000000000507', '57000000-0000-4000-8000-000000000002',
   '57000000-0000-4000-8000-000000000204', 77.00, 'draft', '57000000-0000-4000-8000-000000000102');

-- suppliers_raised: one supplier raised twice (still ONE distinct supplier), one raised outside
-- the 30-day window, one lowered a price inside it. Expected: 1.
insert into public.supplier_products (
  org_id, supplier_id, product_id, current_price, previous_price, price_effective_date
) values
  ('57000000-0000-4000-8000-000000000001', '57000000-0000-4000-8000-000000000201',
   '57000000-0000-4000-8000-000000000301', 12, 10, pg_temp.p57_today() - 5),
  ('57000000-0000-4000-8000-000000000001', '57000000-0000-4000-8000-000000000201',
   '57000000-0000-4000-8000-000000000302', 20, 15, pg_temp.p57_today() - 3),
  ('57000000-0000-4000-8000-000000000001', '57000000-0000-4000-8000-000000000202',
   '57000000-0000-4000-8000-000000000301', 12, 10, pg_temp.p57_today() - 40),
  ('57000000-0000-4000-8000-000000000001', '57000000-0000-4000-8000-000000000203',
   '57000000-0000-4000-8000-000000000302', 8, 10, pg_temp.p57_today() - 5),
  ('57000000-0000-4000-8000-000000000002', '57000000-0000-4000-8000-000000000204',
   '57000000-0000-4000-8000-000000000303', 12, 10, pg_temp.p57_today() - 5);

-- open_exceptions: open and in_progress count; resolved and dismissed do not. Expected: 4.
insert into public.exceptions (id, org_id, type, status, title) values
  ('57000000-0000-4000-8000-000000000601', '57000000-0000-4000-8000-000000000001',
   'amount_mismatch', 'open', 'P57 open 1'),
  ('57000000-0000-4000-8000-000000000602', '57000000-0000-4000-8000-000000000001',
   'duplicate_invoice', 'open', 'P57 open 2'),
  ('57000000-0000-4000-8000-000000000603', '57000000-0000-4000-8000-000000000001',
   'unmatched_bank', 'in_progress', 'P57 in progress 1'),
  ('57000000-0000-4000-8000-000000000604', '57000000-0000-4000-8000-000000000001',
   'unknown_supplier', 'in_progress', 'P57 in progress 2'),
  ('57000000-0000-4000-8000-000000000605', '57000000-0000-4000-8000-000000000001',
   'amount_mismatch', 'resolved', 'P57 resolved'),
  ('57000000-0000-4000-8000-000000000606', '57000000-0000-4000-8000-000000000001',
   'amount_mismatch', 'dismissed', 'P57 dismissed'),
  ('57000000-0000-4000-8000-000000000607', '57000000-0000-4000-8000-000000000002',
   'amount_mismatch', 'open', 'P57 tenant B open');

-- ===== Parity: the function vs the truth re-derived, under the browser role =====
-- The literal queries below are the ORIGINAL browser filters (src/lib/summary.ts before 0165),
-- executed under the same JWT and role as the function. Both run under RLS; if the function ever
-- drifts from the definition the screen used to run, these disagree.
select pg_temp.p57_as('57000000-0000-4000-8000-000000000101');
set local role authenticated;

select pg_temp.p57_assert(
  (select count(*) from public.p2_business_summary_rows_by_currency()) = 5
  and (select bool_and(measured) from public.p2_business_summary_rows_by_currency()),
  'a healthy schema did not return five measured metrics');

select pg_temp.p57_assert(
  (select value from public.p2_business_summary_rows_by_currency() where metric_key = 'received_week')
    = (select count(*) from public.invoices
        where financial_role = 'payable' and deleted_at is null
          and received_date >= pg_temp.p57_today() - 7)
  and (select value from public.p2_business_summary_rows_by_currency() where metric_key = 'received_week') = 2,
  'received_week disagrees with the re-derived literal (payable, not deleted, trailing 7 days)');

select pg_temp.p57_assert(
  (select value from public.p2_business_summary_rows_by_currency() where metric_key = 'awaiting_approval')
    = (select count(*) from public.invoices
        where financial_role = 'payable' and deleted_at is null
          and review_status = 'pending_approval')
  and (select value from public.p2_business_summary_rows_by_currency() where metric_key = 'awaiting_approval') = 3,
  'awaiting_approval disagrees with the re-derived literal (payable, not deleted, pending_approval)');

select pg_temp.p57_assert(
  (select value from public.p2_business_summary_rows_by_currency() where metric_key = 'expected_payments')
    = (select coalesce(sum(amount), 0) from public.payment_requests
        where status in ('draft', 'pending_approval', 'approved', 'sent_for_execution'))
  and (select value from public.p2_business_summary_rows_by_currency() where metric_key = 'expected_payments')
    = 375.25,
  'expected_payments disagrees with the re-derived literal (sum over the four active statuses)');

select pg_temp.p57_assert(
  (select value from public.p2_business_summary_rows_by_currency() where metric_key = 'suppliers_raised')
    = (select count(distinct supplier_id) from public.supplier_products
        where previous_price is not null and current_price > previous_price
          and price_effective_date >= pg_temp.p57_today() - 30)
  and (select value from public.p2_business_summary_rows_by_currency() where metric_key = 'suppliers_raised') = 1,
  'suppliers_raised disagrees with the re-derived literal (distinct raisers, trailing 30 days)');

select pg_temp.p57_assert(
  (select value from public.p2_business_summary_rows_by_currency() where metric_key = 'open_exceptions')
    = (select count(*) from public.exceptions where status in ('open', 'in_progress'))
  and (select value from public.p2_business_summary_rows_by_currency() where metric_key = 'open_exceptions') = 4,
  'open_exceptions disagrees with the re-derived literal (open or in_progress)');

reset role;

-- ===== Tenant isolation: B reads B, and only B =====
select pg_temp.p57_as('57000000-0000-4000-8000-000000000102');
set local role authenticated;
select pg_temp.p57_assert(
  (select jsonb_object_agg(metric_key, value) from public.p2_business_summary_rows_by_currency())
    = jsonb_build_object(
        'received_week', 1, 'awaiting_approval', 1, 'expected_payments', 77,
        'suppliers_raised', 1, 'open_exceptions', 1),
  'tenant B''s summary is not exactly tenant B''s five numbers');
reset role;

-- ===== Failure isolation: one broken metric never blanks the other four =====
-- A REAL failure, not a simulated flag: drop one inner definition and the metric that consumed
-- it must come back measured=false while its four neighbours keep their values. The transaction
-- rolls back, so nothing stays dropped.
drop function public.p2_suppliers_with_price_increase_since(date);

select pg_temp.p57_as('57000000-0000-4000-8000-000000000101');
set local role authenticated;
select pg_temp.p57_assert(
  (select not measured and value is null
     from public.p2_business_summary_rows_by_currency() where metric_key = 'suppliers_raised'),
  'a broken metric did not report measured=false / value=null');
select pg_temp.p57_assert(
  (select count(*) from public.p2_business_summary_rows_by_currency()
    where measured and metric_key in
      ('received_week', 'awaiting_approval', 'expected_payments', 'open_exceptions')) = 4
  and (select value from public.p2_business_summary_rows_by_currency() where metric_key = 'expected_payments')
    = 375.25,
  'one broken metric blanked its neighbours');
reset role;

-- ===== 0219: the money metric splits per currency, and the counts do not =====
--
-- Everything above runs on a shekel-only fixture, which is what every organisation looks like
-- today; the assertions there prove the shape did not change for them. This block adds one dollar
-- payment request to tenant A and proves the only thing the rename exists for: `expected_payments`
-- becomes TWO rows, neither of which is their sum, while the four counts stay single rows with no
-- currency on them at all.
--
-- The four broken-metric assertions above have already run, and `p2_suppliers_with_price_increase_since`
-- is dropped by then, so this block asserts only what survives that: the money metric and the counts.
-- No JWT subject for the write: p1_financial_command_guard lets a migration or a trusted job write
-- directly and stops an end user, which is the boundary it is for, and this fixture row is neither
-- a user action nor something an RPC can express (no RPC accepts a currency yet -- that is phase 4).
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '', true);

insert into public.payment_requests (id, org_id, supplier_id, amount, status, currency, unit_id)
select '57000000-0000-4000-8000-0000000009f1', '57000000-0000-4000-8000-000000000001',
       request.supplier_id, 120, 'draft', 'USD', request.unit_id
from public.payment_requests request
where request.org_id = '57000000-0000-4000-8000-000000000001'
limit 1;

select pg_temp.p57_as('57000000-0000-4000-8000-000000000101');
set local role authenticated;

select pg_temp.p57_assert(
  (select count(*) from public.p2_business_summary_rows_by_currency()
    where metric_key = 'expected_payments') = 2,
  'a two-currency organisation did not get two expected_payments rows');

select pg_temp.p57_assert(
  (select value from public.p2_business_summary_rows_by_currency()
    where metric_key = 'expected_payments' and currency = 'ILS') = 375.25
  and (select value from public.p2_business_summary_rows_by_currency()
    where metric_key = 'expected_payments' and currency = 'USD') = 120,
  'the two currencies did not keep their own totals');

select pg_temp.p57_assert(
  not exists (
    select 1 from public.p2_business_summary_rows_by_currency()
    where metric_key = 'expected_payments' and value = 495.25),
  'the summary produced the sum of two currencies, which is a false number');

select pg_temp.p57_assert(
  (select bool_and(currency is null) from public.p2_business_summary_rows_by_currency()
    where metric_key in ('received_week', 'awaiting_approval', 'open_exceptions')),
  'a count was given a currency, which it does not have');

reset role;

rollback;

\echo 'p57_business_summary_parity_passed'
