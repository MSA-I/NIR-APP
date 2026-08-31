-- P92 — a figure that cannot be read without its coverage, and a cohort that cannot be rewritten.
--
-- The card this feeds is not a cash-flow forecast and must never render as one. Two failures would
-- turn it into one, and both are pinned here:
--
--   COVERAGE AS A NOTE INSTEAD OF A FIELD. `covered_count`, `total_count`, `covered_amount` and
--   `uncovered_amount` come back on every row, so a caller physically cannot render the amount
--   without holding how much of the debt that amount could see. And coverage in ROWS is not
--   coverage in MONEY: nine requests out of twenty-three can be ninety per cent of the exposure or
--   three. This suite builds a case where the two ratios disagree sharply and asserts both.
--
--   A PERMISSION BOUNDARY RENDERED AS A BUSINESS FACT. `office` is outside this scope (#151), and
--   returning zeros to that role would read as "nothing is due" — `DEBT §59` is exactly that
--   mistake. It gets `not_permitted` and a reason.
--
-- Plus the two structural claims the backtest rests on: undated order commitments stay OUTSIDE the
-- horizon, and the frozen cohort refuses to be updated or deleted by anybody at all.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p92_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P92 outlook assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p92_row(p_currency text, p_key text)
returns numeric language sql stable as $$
  select (row_json ->> p_key)::numeric
  from jsonb_array_elements(public.scheduled_payments_outlook(30) -> 'byCurrency') row_json
  where row_json ->> 'currency' = p_currency;
$$;

insert into public.organizations(id, name, status, vat_rate, base_currency, country_code)
values ('a0920000-0000-4000-8000-000000000001', 'P92 org', 'active', 18, 'ILS', 'IL');
insert into auth.users (id, email) values
  ('b0920000-0000-4000-8000-000000000001', 'p92-owner@example.test'),
  ('b0920000-0000-4000-8000-000000000002', 'p92-office@example.test'),
  ('b0920000-0000-4000-8000-000000000003', 'p92-accountant@example.test');
insert into public.profiles(id, org_id, full_name, role, active) values
  ('b0920000-0000-4000-8000-000000000001', 'a0920000-0000-4000-8000-000000000001', 'P92 owner', 'owner', true),
  ('b0920000-0000-4000-8000-000000000002', 'a0920000-0000-4000-8000-000000000001', 'P92 office', 'office', true),
  ('b0920000-0000-4000-8000-000000000003', 'a0920000-0000-4000-8000-000000000001', 'P92 accountant', 'accountant', true);
insert into public.suppliers(id, org_id, name, status, default_currency, country_code)
values ('c0920000-0000-4000-8000-000000000001', 'a0920000-0000-4000-8000-000000000001',
        'P92 supplier', 'active', 'ILS', 'IL');

-- THE CASE WHERE THE TWO COVERAGES DISAGREE. Three shekel requests: one dated and large, two
-- undated and small. One row in three is dated — 33% by count — but that row is 90% of the money.
-- A card reporting only the count ratio would tell the reader they can see a third of their
-- exposure when they can see nearly all of it.
insert into public.payment_requests
  (id, org_id, supplier_id, amount, currency, due_date, status) values
  ('d0920000-0000-4000-8000-000000000001', 'a0920000-0000-4000-8000-000000000001',
   'c0920000-0000-4000-8000-000000000001', 9000, 'ILS',
   (now() at time zone 'Asia/Jerusalem')::date + 10, 'pending_approval'),
  ('d0920000-0000-4000-8000-000000000002', 'a0920000-0000-4000-8000-000000000001',
   'c0920000-0000-4000-8000-000000000001', 500, 'ILS', null, 'pending_approval'),
  ('d0920000-0000-4000-8000-000000000003', 'a0920000-0000-4000-8000-000000000001',
   'c0920000-0000-4000-8000-000000000001', 500, 'ILS', null, 'pending_approval'),
  -- Dated, but far outside the thirty days: counts as covered, does not enter the horizon figure.
  ('d0920000-0000-4000-8000-000000000004', 'a0920000-0000-4000-8000-000000000001',
   'c0920000-0000-4000-8000-000000000001', 7000, 'ILS',
   (now() at time zone 'Asia/Jerusalem')::date + 200, 'pending_approval'),
  -- A second currency, so the rows never merge.
  ('d0920000-0000-4000-8000-000000000005', 'a0920000-0000-4000-8000-000000000001',
   'c0920000-0000-4000-8000-000000000001', 250, 'USD',
   (now() at time zone 'Asia/Jerusalem')::date + 5, 'pending_approval'),
  -- Draft and cancelled are not debt anybody scheduled.
  ('d0920000-0000-4000-8000-000000000006', 'a0920000-0000-4000-8000-000000000001',
   'c0920000-0000-4000-8000-000000000001', 99999, 'ILS',
   (now() at time zone 'Asia/Jerusalem')::date + 3, 'draft'),
  ('d0920000-0000-4000-8000-000000000007', 'a0920000-0000-4000-8000-000000000001',
   'c0920000-0000-4000-8000-000000000001', 88888, 'ILS',
   (now() at time zone 'Asia/Jerusalem')::date + 3, 'cancelled');

select set_config('request.jwt.claim.sub', 'b0920000-0000-4000-8000-000000000001', true);

-- ---- 1. The horizon figure is the dated, active, in-window money. ----------------------------
select pg_temp.p92_assert(
  public.scheduled_payments_outlook(30) ->> 'status' = 'measured',
  'the owner did not get a measurement');
select pg_temp.p92_assert(
  pg_temp.p92_row('ILS', 'amount') = 9000,
  'the horizon figure is not the dated in-window shekel money');
select pg_temp.p92_assert(
  pg_temp.p92_row('ILS', 'recordCount') = 1,
  'the horizon record count is wrong');
-- 99999 and 88888 are large enough that a draft or a cancelled request leaking in is unmissable.
select pg_temp.p92_assert(
  pg_temp.p92_row('ILS', 'amount') < 50000,
  'a draft or cancelled request reached the horizon figure');

-- ---- 2. THE ASSERTION THIS SUITE EXISTS FOR: the two coverages disagree, and both are told. ---
select pg_temp.p92_assert(
  pg_temp.p92_row('ILS', 'coveredCount') = 2 and pg_temp.p92_row('ILS', 'totalCount') = 4,
  'coverage by count is not two dated rows out of four active ones');
select pg_temp.p92_assert(
  pg_temp.p92_row('ILS', 'coveredAmount') = 16000
  and pg_temp.p92_row('ILS', 'uncoveredAmount') = 1000,
  'coverage by amount is not the dated money against the undated money');
-- Half the rows, but roughly ninety-four per cent of the money. A card told only the first number
-- would misstate the reader's exposure by a factor of two.
select pg_temp.p92_assert(
  (pg_temp.p92_row('ILS', 'coveredCount') / pg_temp.p92_row('ILS', 'totalCount'))
    < (pg_temp.p92_row('ILS', 'coveredAmount')
       / (pg_temp.p92_row('ILS', 'coveredAmount') + pg_temp.p92_row('ILS', 'uncoveredAmount'))),
  'the fixture does not make the two coverages disagree, so the assertion above proves nothing');

-- ---- 3. One row per currency, never merged. --------------------------------------------------
select pg_temp.p92_assert(
  pg_temp.p92_row('USD', 'amount') = 250 and pg_temp.p92_row('USD', 'totalCount') = 1,
  'the dollar row is missing or absorbed');
select pg_temp.p92_assert(
  (select count(*) from jsonb_array_elements(
     public.scheduled_payments_outlook(30) -> 'byCurrency')) = 2,
  'the outlook did not emit exactly the two currencies that have requests');

-- ---- 4. Undated commitments sit BESIDE the horizon, never inside it. -------------------------
insert into public.products(id, org_id, name, unit)
values ('e0920000-0000-4000-8000-000000000001', 'a0920000-0000-4000-8000-000000000001',
        'P92 product', 'unit');
insert into public.purchase_orders(id, org_id, supplier_id, status, currency)
values ('f0920000-0000-4000-8000-000000000001', 'a0920000-0000-4000-8000-000000000001',
        'c0920000-0000-4000-8000-000000000001', 'sent', 'ILS');
insert into public.purchase_order_items(id, org_id, order_id, product_id, qty, unit_price)
values ('a0920000-0000-4000-8000-000000000002', 'a0920000-0000-4000-8000-000000000001',
        'f0920000-0000-4000-8000-000000000001', 'e0920000-0000-4000-8000-000000000001', 4, 500);

select pg_temp.p92_assert(
  (select (row_json ->> 'amount')::numeric
   from jsonb_array_elements(public.scheduled_payments_outlook(30)
     -> 'undatedCommitmentsByCurrency') row_json
   where row_json ->> 'currency' = 'ILS') = 2000,
  'the open order commitment is not reported beside the horizon');
select pg_temp.p92_assert(
  pg_temp.p92_row('ILS', 'amount') = 9000,
  'the undated order commitment leaked into the thirty-day figure');

-- ---- 5. office is refused in words, never with zeros. ----------------------------------------
select set_config('request.jwt.claim.sub', 'b0920000-0000-4000-8000-000000000002', true);
select pg_temp.p92_assert(
  public.scheduled_payments_outlook(30) ->> 'status' = 'not_permitted',
  'office was given a measurement it may not see');
select pg_temp.p92_assert(
  public.scheduled_payments_outlook(30) -> 'byCurrency' is null,
  'the refusal still carried figures');
-- The distinction that matters: a refusal is not an empty result. An office user must never be
-- able to read "nothing is due" out of a boundary they cannot cross.
select pg_temp.p92_assert(
  public.scheduled_payments_outlook(30) ->> 'reason' = 'role_out_of_scope',
  'the refusal does not say why');

select set_config('request.jwt.claim.sub', 'b0920000-0000-4000-8000-000000000003', true);
select pg_temp.p92_assert(
  public.scheduled_payments_outlook(30) ->> 'status' = 'measured',
  'the accountant was refused a measurement that is theirs to read');

-- ---- 6. The monthly writer, and the cohort it freezes. ---------------------------------------
select set_config('request.jwt.claim.sub', '', true);
-- The writer sweeps every organisation in the database, so the count it returns belongs to the
-- whole stack. What this suite owns is ITS tenant's rows.
select pg_temp.p92_assert(
  private.record_forecast_snapshots() >= 2,
  'the writer produced no headers at all');
select pg_temp.p92_assert(
  (select count(*) from public.forecast_snapshots
   where org_id = 'a0920000-0000-4000-8000-000000000001') = 2,
  'the writer did not produce one header per currency with active requests');
select pg_temp.p92_assert(
  (select count(*) from public.forecast_snapshot_requests
   where org_id = 'a0920000-0000-4000-8000-000000000001') = 5,
  'the frozen cohort does not carry every active request behind its snapshot');
-- Frozen means frozen, including against the role that just wrote it.
do $frozen$
declare v_refused boolean := false;
begin
  begin
    update public.forecast_snapshot_requests set amount = 1;
  exception when insufficient_privilege then
    v_refused := sqlerrm = 'forecast_snapshot_rows_are_frozen';
  end;
  if not v_refused then
    raise exception 'P92 outlook assertion failed: the frozen cohort was rewritten';
  end if;
end
$frozen$;
do $frozen_delete$
declare v_refused boolean := false;
begin
  begin
    delete from public.forecast_snapshot_requests;
  exception when insufficient_privilege then
    v_refused := sqlerrm = 'forecast_snapshot_rows_are_frozen';
  end;
  if not v_refused then
    raise exception 'P92 outlook assertion failed: the frozen cohort was deleted';
  end if;
end
$frozen_delete$;

-- And the header the cohort belongs to carries its own coverage, not just a total.
select pg_temp.p92_assert(
  (select covered_count = 2 and total_count = 4 and covered_amount = 16000
          and uncovered_amount = 1000
   from public.forecast_snapshots
   where org_id = 'a0920000-0000-4000-8000-000000000001' and currency = 'ILS'),
  'the snapshot header does not carry the coverage its figure had');

-- ---- 7. No client role can write either table. -----------------------------------------------
select pg_temp.p92_assert(
  not has_table_privilege('authenticated', 'public.forecast_snapshots', 'insert')
  and not has_table_privilege('authenticated', 'public.forecast_snapshot_requests', 'update')
  and has_table_privilege('authenticated', 'public.forecast_snapshots', 'select'),
  'the snapshot tables are not read-only to the tenant');

rollback;

select 'P92_scheduled_payments_outlook_passed' as result;
