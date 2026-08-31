-- P90 — one definition of "compared with last month", and a baseline that survives February.
--
-- `0263` moved the control centre's three period comparisons out of the browser. What has to keep
-- holding is not that the numbers exist but that they mean what the card says:
--
--   THE MONTH-TO-DATE BASELINE IS DAY-ALIGNED AND CLAMPED. On the 31st there is no 31st to compare
--   against in a thirty-day month, and an unclamped baseline silently becomes the WHOLE previous
--   month — which turns a normal month into an apparent collapse. Proved on 2026-07-31 against
--   June, and on 2026-03-31 against February.
--
--   ONE CURRENCY PER ROW, AND NEVER A SUM. A shekel figure and a dollar figure are two facts.
--
--   A MEASURED ZERO AND AN ABSENCE ARE DIFFERENT. A currency that traded in one window and not the
--   other reports 0 for the empty side — that is a fact about the business. A currency that never
--   appears produces no row, and the card draws nothing.
--
--   AND THE INVOICED COMPARISON IS WHOLE MONTH AGAINST WHOLE MONTH, because both months are over
--   as far as that card is concerned. Four boundaries, not two, and each comparison uses its pair.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p90_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P90 dashboard comparison assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p90_block(p_today date)
returns jsonb language sql stable as $$
  select public.management_dashboard_snapshot(p_today) -> 'periodComparison';
$$;

/* One figure out of one currency row, so an assertion names what it is reading. */
create function pg_temp.p90_row(p_today date, p_series text, p_currency text, p_side text)
returns numeric language sql stable as $$
  select (row_json ->> p_side)::numeric
  from jsonb_array_elements(pg_temp.p90_block(p_today) -> p_series) row_json
  where row_json ->> 'currency' = p_currency;
$$;

insert into public.organizations(id, name, status, vat_rate, base_currency, country_code)
values ('d0900000-0000-4000-8000-000000000001', 'P90 org', 'active', 18, 'ILS', 'IL');
insert into auth.users (id, email)
values ('e0900000-0000-4000-8000-000000000001', 'p90-owner@example.test');
insert into public.profiles(id, org_id, full_name, role, active)
values ('e0900000-0000-4000-8000-000000000001', 'd0900000-0000-4000-8000-000000000001',
        'P90 owner', 'owner', true);
insert into public.suppliers(id, org_id, name, status, default_currency, country_code)
values ('f0900000-0000-4000-8000-000000000001', 'd0900000-0000-4000-8000-000000000001',
        'P90 supplier', 'active', 'ILS', 'IL');
-- An order item needs a product with a unit: `p0_set_purchase_order_item_unit_snapshot` (0099)
-- takes the snapshot from it and refuses the row otherwise.
insert into public.products(id, org_id, name, unit)
values ('a0900000-0000-4000-8000-000000000001', 'd0900000-0000-4000-8000-000000000001',
        'P90 product', 'unit');

-- ---- Payments: the series with the simplest evidence, in two currencies. ----------------------
-- July 1–31 is the current window when today is the 31st; June 1–30 is the baseline. The 31st of
-- July has no counterpart in June, which is the whole point.
insert into public.payments(id, org_id, supplier_id, amount, currency, paid_date, method) values
  -- Inside the current month-to-date window.
  ('10900000-0000-4000-8000-000000000001', 'd0900000-0000-4000-8000-000000000001',
   'f0900000-0000-4000-8000-000000000001', 100, 'ILS', '2026-07-05', 'bank_transfer'),
  ('10900000-0000-4000-8000-000000000002', 'd0900000-0000-4000-8000-000000000001',
   'f0900000-0000-4000-8000-000000000001', 900, 'ILS', '2026-07-31', 'bank_transfer'),
  -- Inside the day-aligned baseline: June 1–30.
  ('10900000-0000-4000-8000-000000000003', 'd0900000-0000-4000-8000-000000000001',
   'f0900000-0000-4000-8000-000000000001', 400, 'ILS', '2026-06-05', 'bank_transfer'),
  ('10900000-0000-4000-8000-000000000004', 'd0900000-0000-4000-8000-000000000001',
   'f0900000-0000-4000-8000-000000000001', 600, 'ILS', '2026-06-30', 'bank_transfer'),
  -- A second currency, current window only. Its baseline is a measured zero, not an absence.
  ('10900000-0000-4000-8000-000000000005', 'd0900000-0000-4000-8000-000000000001',
   'f0900000-0000-4000-8000-000000000001', 250, 'USD', '2026-07-10', 'bank_transfer'),
  -- Outside both windows: May, and August. Neither may reach either figure.
  ('10900000-0000-4000-8000-000000000006', 'd0900000-0000-4000-8000-000000000001',
   'f0900000-0000-4000-8000-000000000001', 5000, 'ILS', '2026-05-20', 'bank_transfer'),
  ('10900000-0000-4000-8000-000000000007', 'd0900000-0000-4000-8000-000000000001',
   'f0900000-0000-4000-8000-000000000001', 7000, 'ILS', '2026-08-02', 'bank_transfer');

-- Every fixture above is written with NO end-user subject, because `p1_financial_command_guard`
-- (0023) refuses a direct write to a money table from anyone who has one. The subject is set here,
-- after the writing is done, and cleared again around each later write.
select set_config('request.jwt.claim.sub', 'e0900000-0000-4000-8000-000000000001', true);

-- ---- 1. The four boundaries, and the clamp. ---------------------------------------------------
select pg_temp.p90_assert(
  pg_temp.p90_block('2026-07-31') ->> 'monthFrom' = '2026-07-01'
  and pg_temp.p90_block('2026-07-31') ->> 'monthToDateTo' = '2026-07-31'
  and pg_temp.p90_block('2026-07-31') ->> 'previousFrom' = '2026-06-01',
  'the current and baseline windows do not start where the month does');

-- THE ASSERTION THIS SUITE EXISTS FOR. June has no 31st. Unclamped, the baseline would run to
-- July 1 and the comparison would be against a window that overlaps the current one.
select pg_temp.p90_assert(
  pg_temp.p90_block('2026-07-31') ->> 'previousToDateTo' = '2026-06-30',
  'the day-aligned baseline was not clamped to the end of a thirty-day month');
-- February, the shortest case in the calendar.
select pg_temp.p90_assert(
  pg_temp.p90_block('2026-03-31') ->> 'previousToDateTo' = '2026-02-28',
  'the day-aligned baseline was not clamped to the end of February');
-- And on an ordinary day it is the same day number, not the end of the month.
select pg_temp.p90_assert(
  pg_temp.p90_block('2026-07-17') ->> 'previousToDateTo' = '2026-06-17',
  'the baseline does not end on the same day number');

-- The whole-month boundaries are separate, and they are whole.
select pg_temp.p90_assert(
  pg_temp.p90_block('2026-07-17') ->> 'monthTo' = '2026-07-31'
  and pg_temp.p90_block('2026-07-17') ->> 'previousTo' = '2026-06-30',
  'the whole-month boundaries are not whole months');

-- ---- 2. The figures are the windows' own. -----------------------------------------------------
select pg_temp.p90_assert(
  pg_temp.p90_row('2026-07-31', 'paidByCurrency', 'ILS', 'current') = 1000,
  'the current month-to-date payment total is not the sum of its window');
select pg_temp.p90_assert(
  pg_temp.p90_row('2026-07-31', 'paidByCurrency', 'ILS', 'previous') = 1000,
  'the baseline payment total is not the sum of the day-aligned window');

-- May and August are outside both windows, and 5000 + 7000 is a large enough mistake to see.
select pg_temp.p90_assert(
  pg_temp.p90_row('2026-07-31', 'paidByCurrency', 'ILS', 'current') < 5000
  and pg_temp.p90_row('2026-07-31', 'paidByCurrency', 'ILS', 'previous') < 5000,
  'a payment outside both windows reached a figure');

-- ---- 3. One currency per row, and a measured zero is not an absence. --------------------------
select pg_temp.p90_assert(
  pg_temp.p90_row('2026-07-31', 'paidByCurrency', 'USD', 'current') = 250
  and pg_temp.p90_row('2026-07-31', 'paidByCurrency', 'USD', 'previous') = 0,
  'the dollar row does not report its own current figure and a measured zero baseline');
select pg_temp.p90_assert(
  pg_temp.p90_row('2026-07-31', 'paidByCurrency', 'ILS', 'current') = 1000,
  'the shekel figure absorbed the dollar one');
select pg_temp.p90_assert(
  pg_temp.p90_row('2026-07-31', 'paidByCurrency', 'EUR', 'current') is null,
  'a currency that never traded produced a row');
select pg_temp.p90_assert(
  (select count(*) from jsonb_array_elements(
     pg_temp.p90_block('2026-07-31') -> 'paidByCurrency')) = 2,
  'the payment comparison did not emit exactly the two currencies that traded');

-- ---- 4. Orders: the same windows, and the filter the browser applied. -------------------------
select set_config('request.jwt.claim.sub', '', true);
insert into public.purchase_orders(id, org_id, supplier_id, status, currency, created_at) values
  ('20900000-0000-4000-8000-000000000001', 'd0900000-0000-4000-8000-000000000001',
   'f0900000-0000-4000-8000-000000000001', 'sent', 'ILS', '2026-07-05 09:00+03'),
  -- A draft, and a cancelled order, both inside the current window. Neither is money committed.
  ('20900000-0000-4000-8000-000000000002', 'd0900000-0000-4000-8000-000000000001',
   'f0900000-0000-4000-8000-000000000001', 'draft', 'ILS', '2026-07-06 09:00+03'),
  ('20900000-0000-4000-8000-000000000003', 'd0900000-0000-4000-8000-000000000001',
   'f0900000-0000-4000-8000-000000000001', 'cancelled', 'ILS', '2026-07-07 09:00+03');
insert into public.purchase_order_items(id, org_id, order_id, product_id, qty, unit_price) values
  ('30900000-0000-4000-8000-000000000001', 'd0900000-0000-4000-8000-000000000001',
   '20900000-0000-4000-8000-000000000001', 'a0900000-0000-4000-8000-000000000001', 2, 150),
  ('30900000-0000-4000-8000-000000000002', 'd0900000-0000-4000-8000-000000000001',
   '20900000-0000-4000-8000-000000000002', 'a0900000-0000-4000-8000-000000000001', 10, 1000),
  ('30900000-0000-4000-8000-000000000003', 'd0900000-0000-4000-8000-000000000001',
   '20900000-0000-4000-8000-000000000003', 'a0900000-0000-4000-8000-000000000001', 10, 1000);
select set_config('request.jwt.claim.sub', 'e0900000-0000-4000-8000-000000000001', true);

select pg_temp.p90_assert(
  pg_temp.p90_row('2026-07-31', 'purchasedByCurrency', 'ILS', 'current') = 300,
  'the ordered figure is not the sum of its items at snapshot prices, or a draft reached it');

-- ---- 5. Invoices compare WHOLE month against WHOLE month. ------------------------------------
-- The invoice on July 31 belongs to the current month either way; the one on June 30 belongs to
-- the baseline either way. The one on July 5 of the PREVIOUS year proves the window is a month
-- and not a rolling range.
select set_config('request.jwt.claim.sub', '', true);
insert into public.invoices
  (id, org_id, supplier_id, invoice_number, invoice_date, amount_before_vat, vat_amount,
   total_amount, currency, financial_role) values
  ('40900000-0000-4000-8000-000000000001', 'd0900000-0000-4000-8000-000000000001',
   'f0900000-0000-4000-8000-000000000001', 'P90-1', '2026-07-31', 100, 18, 118, 'ILS', 'payable'),
  ('40900000-0000-4000-8000-000000000002', 'd0900000-0000-4000-8000-000000000001',
   'f0900000-0000-4000-8000-000000000001', 'P90-2', '2026-06-30', 200, 36, 236, 'ILS', 'payable'),
  ('40900000-0000-4000-8000-000000000003', 'd0900000-0000-4000-8000-000000000001',
   'f0900000-0000-4000-8000-000000000001', 'P90-3', '2025-07-05', 900, 162, 1062, 'ILS', 'payable');
select set_config('request.jwt.claim.sub', 'e0900000-0000-4000-8000-000000000001', true);

-- Asked on the 17th: the invoice dated the 31st still counts, because this comparison is about
-- whole months. Day-aligned boundaries here would have hidden it.
select pg_temp.p90_assert(
  pg_temp.p90_row('2026-07-17', 'invoicedByCurrency', 'ILS', 'current') = 118,
  'the invoiced comparison used the day-aligned window instead of the whole month');
select pg_temp.p90_assert(
  pg_temp.p90_row('2026-07-17', 'invoicedByCurrency', 'ILS', 'previous') = 236,
  'the invoiced baseline is not the whole previous month');
select pg_temp.p90_assert(
  pg_temp.p90_row('2026-07-17', 'invoicedByCurrency', 'ILS', 'current') < 1000,
  'an invoice from the same month a YEAR earlier reached the current figure');

-- A soft-deleted invoice is not a business fact. `0263` carries the same filter the browser did.
select set_config('request.jwt.claim.sub', '', true);
update public.invoices set deleted_at = now()
where id = '40900000-0000-4000-8000-000000000001';
select set_config('request.jwt.claim.sub', 'e0900000-0000-4000-8000-000000000001', true);
select pg_temp.p90_assert(
  pg_temp.p90_row('2026-07-17', 'invoicedByCurrency', 'ILS', 'current') = 0,
  'a soft-deleted invoice still counts toward the month');

-- ---- 6. The block is not published to a reader who may not see the dashboard. -----------------
select set_config('request.jwt.claim.sub', '', true);
update public.profiles set role = 'accountant' where id = 'e0900000-0000-4000-8000-000000000001';
select set_config('request.jwt.claim.sub', 'e0900000-0000-4000-8000-000000000001', true);
select pg_temp.p90_assert(
  public.management_dashboard_snapshot('2026-07-31') is null,
  'the snapshot answered a role that is not owner or office');

rollback;

select 'P90_dashboard_period_comparison_passed' as result;
