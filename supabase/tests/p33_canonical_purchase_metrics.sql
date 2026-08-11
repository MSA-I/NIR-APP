-- P33 -- one definition per money question, and the four ways a screen used to answer differently.
--
-- Each section below is a divergence that was MEASURED in the product, not one that was imagined:
--
--   §1 TIME ZONE -- two dashboards filed the same order under two different months.
--   §2 SNAPSHOT PRICE -- reaching for today's price list makes last month's total move whenever a
--      supplier raises a price.
--   §3 WHICH INVOICES COUNT -- an invoice in review is a claim, not an expense.
--   §4 WHICH CREDITS NET -- five statuses in two disjoint groups, all counted under one label.
--
-- And one rule that is not a divergence but a principle: an empty source set produces a DASH, not
-- a zero. Zero is a claim about the business.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p33_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P33 metric assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p33_metrics(p_from date, p_to date, p_org uuid
  default '10330000-0000-4000-8000-000000000001')
returns jsonb language sql stable as $$
  select private.canonical_purchase_metrics(p_org, p_from, p_to);
$$;

insert into public.organizations (id, name, status, vat_rate) values
  ('10330000-0000-4000-8000-000000000001', 'P33 tenant', 'active', 18),
  ('10330000-0000-4000-8000-000000000002', 'P33 other tenant', 'active', 18);
insert into auth.users (id, email) values
  ('20330000-0000-4000-8000-000000000001', 'owner-p33@example.test'),
  ('20330000-0000-4000-8000-000000000002', 'kitchen-p33@example.test');
insert into public.profiles (id, org_id, full_name, role) values
  ('20330000-0000-4000-8000-000000000001', '10330000-0000-4000-8000-000000000001',
   'P33 owner', 'owner'),
  ('20330000-0000-4000-8000-000000000002', '10330000-0000-4000-8000-000000000001',
   'P33 kitchen', 'kitchen');
insert into public.suppliers (id, org_id, name, status) values
  ('40330000-0000-4000-8000-000000000001', '10330000-0000-4000-8000-000000000001',
   'P33 ספק', 'active');
insert into public.products (id, org_id, name, unit) values
  ('30330000-0000-4000-8000-000000000001', '10330000-0000-4000-8000-000000000001',
   'P33 מוצר', 'unit');
insert into public.supplier_products (org_id, supplier_id, product_id, current_price) values
  ('10330000-0000-4000-8000-000000000001', '40330000-0000-4000-8000-000000000001',
   '30330000-0000-4000-8000-000000000001', 999);

-- ===== 1. The business day, not the UTC day =====
--
-- 2026-08-01 00:30 Asia/Jerusalem is 2026-07-31 21:30Z. A raw UTC slice files this order under
-- July; the business placed it in August. This one row is the divergence that had the main
-- dashboard and the kitchen dashboard reporting different totals for the same month.

insert into public.purchase_orders (id, org_id, supplier_id, status, created_at) values
  ('50330000-0000-4000-8000-000000000001', '10330000-0000-4000-8000-000000000001',
   '40330000-0000-4000-8000-000000000001', 'sent',
   timestamptz '2026-08-01 00:30:00+03'),
  -- Cancelled: nothing was committed.
  ('50330000-0000-4000-8000-000000000002', '10330000-0000-4000-8000-000000000001',
   '40330000-0000-4000-8000-000000000001', 'cancelled',
   timestamptz '2026-08-05 12:00:00+03'),
  -- Draft: nothing was sent.
  ('50330000-0000-4000-8000-000000000003', '10330000-0000-4000-8000-000000000001',
   '40330000-0000-4000-8000-000000000001', 'draft',
   timestamptz '2026-08-06 12:00:00+03');

insert into public.purchase_order_items (org_id, order_id, product_id, qty, unit_price)
select '10330000-0000-4000-8000-000000000001', o.id,
       '30330000-0000-4000-8000-000000000001', 10, 5
from (values ('50330000-0000-4000-8000-000000000001'::uuid),
             ('50330000-0000-4000-8000-000000000002'::uuid),
             ('50330000-0000-4000-8000-000000000003'::uuid)) as o(id);

select pg_temp.p33_assert(
  (select (r ->> 'committed')::numeric = 50 and (r ->> 'committed_order_count')::bigint = 1
   from pg_temp.p33_metrics('2026-08-01', '2026-08-31') r),
  'an order placed at 00:30 on 1 August, which is 21:30Z on 31 July, was not counted in August. '
  'This is the exact row that had two dashboards reporting different totals for the same month '
  'under the same label');

select pg_temp.p33_assert(
  (select r ->> 'committed' is null
   from pg_temp.p33_metrics('2026-07-01', '2026-07-31') r),
  'the same order was ALSO counted in July. A UTC slice puts it there; the business day does not');

select pg_temp.p33_assert(
  (select r ->> 'time_zone' = 'Asia/Jerusalem'
   from pg_temp.p33_metrics('2026-08-01', '2026-08-31') r),
  'the answer does not state which day boundary it used, so a reader cannot tell whether it '
  'agrees with the screen next to it');

-- ===== 2. Snapshot prices, not today's price list =====
--
-- The order was placed at ₪5; the price list now says ₪999. If the metric reached for the current
-- price, every past month would move whenever a supplier raised a price — and last month's
-- reported spend would be a number nobody could reconcile against anything.

select pg_temp.p33_assert(
  (select (r ->> 'committed')::numeric = 50
   from pg_temp.p33_metrics('2026-08-01', '2026-08-31') r),
  'the committed figure moved with the price list. Order items carry the price agreed AT THE TIME '
  '(ARCHITECTURE.md); reading current_price here rewrites history every time a supplier raises a '
  'price');

-- ===== 3. An invoice in review is a claim, not an expense =====

-- 0099 refuses to CREATE an invoice already approved: approval must go through the three-way gate
-- and leave a persisted assessment behind. That guard is exactly right, and it is tested where it
-- belongs (p20). Here it is in the way of a fixture: this suite is about what the metric COUNTS,
-- not about how an invoice earns the word "approved". Disabled for these four rows and restored
-- immediately, inside the transaction that rolls back.
alter table public.invoices disable trigger invoice_three_way_approval_guard_insert;

insert into public.invoices
  (org_id, supplier_id, invoice_number, invoice_date, total_amount, review_status) values
  ('10330000-0000-4000-8000-000000000001', '40330000-0000-4000-8000-000000000001',
   'INV-A', '2026-08-10', 100, 'approved'),
  ('10330000-0000-4000-8000-000000000001', '40330000-0000-4000-8000-000000000001',
   'INV-B', '2026-08-11', 40, 'approved'),
  -- Still being checked: counting it would make August's figure move as the office works its queue.
  ('10330000-0000-4000-8000-000000000001', '40330000-0000-4000-8000-000000000001',
   'INV-C', '2026-08-12', 500, 'in_review'),
  -- Approved but soft-deleted.
  ('10330000-0000-4000-8000-000000000001', '40330000-0000-4000-8000-000000000001',
   'INV-D', '2026-08-13', 700, 'approved');
alter table public.invoices enable trigger invoice_three_way_approval_guard_insert;

update public.invoices set deleted_at = now()
where org_id = '10330000-0000-4000-8000-000000000001' and invoice_number = 'INV-D';

select pg_temp.p33_assert(
  (select (r ->> 'gross_expense')::numeric = 140
          and (r ->> 'gross_invoice_count')::bigint = 2
   from pg_temp.p33_metrics('2026-08-01', '2026-08-31') r),
  'gross expense counted an invoice still in review, or a deleted one. An unapproved invoice is a '
  'claim; counting it makes the month''s figure move as the office works through its queue');

-- ===== 4. Which credits net, and which are merely reported =====

insert into public.credit_requests
  (org_id, supplier_id, reason, amount, status, created_at, resolved_at) values
  ('10330000-0000-4000-8000-000000000001', '40330000-0000-4000-8000-000000000001',
   'wrong_price',30, 'closed', timestamptz '2026-08-14 10:00+03',
   timestamptz '2026-08-14 10:00+03'),
  ('10330000-0000-4000-8000-000000000001', '40330000-0000-4000-8000-000000000001',
   'wrong_price',25, 'requested', timestamptz '2026-08-15 10:00+03', null);

select pg_temp.p33_assert(
  (select (r ->> 'credits_recognised')::numeric = 30
          and (r ->> 'credits_pending')::numeric = 25
   from pg_temp.p33_metrics('2026-08-01', '2026-08-31') r),
  'the two credit groups were merged. `open|requested|received` and `offset|closed` are DISJOINT '
  '(0022:411-417): only the second actually reduces a supplier balance, and Reports counts all '
  'five under one label today');

select pg_temp.p33_assert(
  (select (r ->> 'net_expense')::numeric = 110
   from pg_temp.p33_metrics('2026-08-01', '2026-08-31') r),
  'net expense is not gross minus the RECOGNISED credits. A credit that has been agreed but not '
  'applied has not reduced anything yet, and letting it flatter the net number is the difference '
  'between a report and a hope (OPEN-DECISIONS #147)');

select pg_temp.p33_assert(
  (select r ->> 'net_definition' = 'gross_minus_offset_and_closed_credits'
   from pg_temp.p33_metrics('2026-08-01', '2026-08-31') r),
  'the answer no longer states WHICH definition of net it used. #147 is a documented default '
  'awaiting the owner; a number that does not name its own definition cannot be re-read later');

-- ===== 5. A dash is not a zero =====

select pg_temp.p33_assert(
  (select r ->> 'committed' is null and r ->> 'gross_expense' is null
          and r ->> 'net_expense' is null and r ->> 'credits_recognised' is null
   from pg_temp.p33_metrics('2020-01-01', '2020-01-31') r),
  'an empty window reported zeros instead of nulls. CLAUDE.md: a metric with no data shows a '
  'dash, because zero is itself a claim about the business');

select pg_temp.p33_assert(
  (select (r ->> 'committed_order_count')::bigint = 0
   from pg_temp.p33_metrics('2020-01-01', '2020-01-31') r),
  'the count is null too, so a reader cannot tell "no orders" from "not computed"');

-- ===== 6. Committed and gross are never netted against one another =====

select pg_temp.p33_assert(
  (select (r ->> 'committed')::numeric = 50 and (r ->> 'gross_expense')::numeric = 140
   from pg_temp.p33_metrics('2026-08-01', '2026-08-31') r),
  'committed and gross were combined. They are not two views of one number: an order placed in '
  'March and billed in April belongs to both months in different senses, and a screen that adds '
  'them is double counting');

-- ===== 7. Tenancy and the role boundary =====

select pg_temp.p33_assert(
  (select r ->> 'committed' is null and r ->> 'gross_expense' is null
   from pg_temp.p33_metrics('2026-08-01', '2026-08-31',
                            '10330000-0000-4000-8000-000000000002') r),
  'another tenant''s window returned our figures');

set local role authenticated;
select set_config('request.jwt.claim.sub', '20330000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select pg_temp.p33_assert(
  (select (r ->> 'gross_expense')::numeric = 140
   from public.get_purchase_metrics('2026-08-01', '2026-08-31') r),
  'the owner cannot read the canonical metrics through the public wrapper');

select set_config('request.jwt.claim.sub', '20330000-0000-4000-8000-000000000002', true);
do $$
begin
  perform public.get_purchase_metrics('2026-08-01', '2026-08-31');
  raise exception 'P33 metric assertion failed: a kitchen manager read the money metrics. Role '
    'visibility is not widened just to make two screens agree on a number';
exception when sqlstate '42501' then
  if sqlerrm <> 'purchase_metrics_not_authorized' then raise; end if;
end
$$;

-- Back to the owner: the role check runs FIRST, so leaving the kitchen claim in place here would
-- test authorization a second time and never reach the window validation at all.
select set_config('request.jwt.claim.sub', '20330000-0000-4000-8000-000000000001', true);
do $$
begin
  perform public.get_purchase_metrics('2026-08-31', '2026-08-01');
  raise exception 'P33 metric assertion failed: a backwards window was accepted';
exception when sqlstate '22023' then
  if sqlerrm <> 'purchase_metrics_invalid_window' then raise; end if;
end
$$;

reset role;
select pg_temp.p33_assert(
  not has_function_privilege('authenticated',
    'private.canonical_purchase_metrics(uuid,date,date)', 'execute'),
  'a client role can call the private metric directly, which takes org_id as an argument');

rollback;
