-- P34 -- one delivery, counted once.
--
-- The fixture below is a single purchase of ten units that left three records: an order line, a
-- COMPLETED receipt line for eight, and an approved invoice line for eight. A naive rollup reports
-- twenty-six units and three times the spend, and the number looks entirely plausible on a screen.
-- That plausibility is the danger, and every assertion here is one way it creeps back in.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p34_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P34 summary assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p34_product(p_product uuid)
returns jsonb language sql stable as $$
  select p
  from jsonb_array_elements(
    private.product_purchase_summary(
      '10340000-0000-4000-8000-000000000001', '2026-08-01', '2026-08-31', null) -> 'products') p
  where p ->> 'product_id' = p_product::text
$$;

insert into public.organizations (id, name, status, vat_rate) values
  ('10340000-0000-4000-8000-000000000001', 'P34 tenant', 'active', 18);
insert into auth.users (id, email) values
  ('20340000-0000-4000-8000-000000000001', 'owner-p34@example.test');
insert into public.profiles (id, org_id, full_name, role) values
  ('20340000-0000-4000-8000-000000000001', '10340000-0000-4000-8000-000000000001',
   'P34 owner', 'owner');
insert into public.suppliers (id, org_id, name, status) values
  ('40340000-0000-4000-8000-000000000001', '10340000-0000-4000-8000-000000000001',
   'P34 ספק א', 'active'),
  ('40340000-0000-4000-8000-000000000002', '10340000-0000-4000-8000-000000000001',
   'P34 ספק ב', 'active');
insert into public.products (id, org_id, name, unit) values
  -- Two names a person reads as one product and Postgres reads as two. They must NEVER merge.
  ('30340000-0000-4000-8000-000000000001', '10340000-0000-4000-8000-000000000001',
   'עגבניות שרי', 'kg'),
  ('30340000-0000-4000-8000-000000000002', '10340000-0000-4000-8000-000000000001',
   'עגבניות שרי 500 גרם', 'unit'),
  ('30340000-0000-4000-8000-000000000003', '10340000-0000-4000-8000-000000000001',
   'P34 מוצר בלי ראיה', 'unit');

insert into public.purchase_orders (id, org_id, supplier_id, status, created_at) values
  ('50340000-0000-4000-8000-000000000001', '10340000-0000-4000-8000-000000000001',
   '40340000-0000-4000-8000-000000000001', 'partial', timestamptz '2026-08-03 09:00+03'),
  -- A second supplier for the SAME product, so supplier_count has something to count.
  ('50340000-0000-4000-8000-000000000002', '10340000-0000-4000-8000-000000000001',
   '40340000-0000-4000-8000-000000000002', 'sent', timestamptz '2026-08-04 09:00+03');

insert into public.purchase_order_items (id, org_id, order_id, product_id, qty, unit_price) values
  ('80340000-0000-4000-8000-000000000001', '10340000-0000-4000-8000-000000000001',
   '50340000-0000-4000-8000-000000000001', '30340000-0000-4000-8000-000000000001', 10, 20),
  -- Ordered from a second supplier, nothing received or billed yet.
  ('80340000-0000-4000-8000-000000000002', '10340000-0000-4000-8000-000000000001',
   '50340000-0000-4000-8000-000000000002', '30340000-0000-4000-8000-000000000001', 4, 21),
  -- The lookalike product, on its own line.
  ('80340000-0000-4000-8000-000000000003', '10340000-0000-4000-8000-000000000001',
   '50340000-0000-4000-8000-000000000001', '30340000-0000-4000-8000-000000000002', 6, 5),
  -- Ordered, never evidenced by anything.
  ('80340000-0000-4000-8000-000000000004', '10340000-0000-4000-8000-000000000001',
   '50340000-0000-4000-8000-000000000001', '30340000-0000-4000-8000-000000000003', 7, 3);

-- Eight of the ten arrived and a person signed for them. Plus a DRAFT for the remaining two,
-- which nobody has confirmed.
insert into public.goods_receipts (id, org_id, order_id, status, received_at) values
  ('90340000-0000-4000-8000-000000000001', '10340000-0000-4000-8000-000000000001',
   '50340000-0000-4000-8000-000000000001', 'completed', '2026-08-05'),
  ('90340000-0000-4000-8000-000000000002', '10340000-0000-4000-8000-000000000001',
   '50340000-0000-4000-8000-000000000001', 'draft', '2026-08-06');
insert into public.goods_receipt_items
  (org_id, receipt_id, order_item_id, product_id, qty_received, status) values
  ('10340000-0000-4000-8000-000000000001', '90340000-0000-4000-8000-000000000001',
   '80340000-0000-4000-8000-000000000001', '30340000-0000-4000-8000-000000000001', 8, 'partial'),
  ('10340000-0000-4000-8000-000000000001', '90340000-0000-4000-8000-000000000002',
   '80340000-0000-4000-8000-000000000001', '30340000-0000-4000-8000-000000000001', 2, 'full'),
  -- The lookalike product arrived in full, with NO invoice — so its canonical source is the
  -- receipt and its spend is zero, which is a true statement and not a missing number.
  ('10340000-0000-4000-8000-000000000001', '90340000-0000-4000-8000-000000000001',
   '80340000-0000-4000-8000-000000000003', '30340000-0000-4000-8000-000000000002', 6, 'full');

-- The supplier billed for the same eight. Same delivery, third record.
alter table public.invoices disable trigger invoice_three_way_approval_guard_insert;
insert into public.invoices
  (id, org_id, supplier_id, invoice_number, invoice_date, total_amount, review_status) values
  ('a0340000-0000-4000-8000-000000000001', '10340000-0000-4000-8000-000000000001',
   '40340000-0000-4000-8000-000000000001', 'INV-34', '2026-08-07', 189, 'approved');
alter table public.invoices enable trigger invoice_three_way_approval_guard_insert;

-- The evidence and the explicit match, written the way 0099 requires: a claimed writer, one kind
-- at a time. This is the transitive link — invoice line → order item ← receipt line — that is the
-- ONLY thing joining a supplier's bill to what physically arrived.
select set_config('app.invoice_three_way_writer', 'evidence', true);
insert into public.invoice_line_evidence_batches (
  id, org_id, invoice_id, revision, idempotency_key, source_type, actor_id, source_checksum, reason
) values (
  'b0340000-0000-4000-8000-000000000001', '10340000-0000-4000-8000-000000000001',
  'a0340000-0000-4000-8000-000000000001', 1, gen_random_uuid(), 'manual_entry',
  '20340000-0000-4000-8000-000000000001', repeat('a', 64), 'P34 fixture');
insert into public.invoice_lines (
  id, org_id, evidence_batch_id, invoice_id, line_number, description, product_id,
  quantity, unit, unit_price, discount_amount, vat_rate, line_total,
  evidence_block_ids, raw_evidence, source_hash
) values
  ('c0340000-0000-4000-8000-000000000001', '10340000-0000-4000-8000-000000000001',
   'b0340000-0000-4000-8000-000000000001', 'a0340000-0000-4000-8000-000000000001', 1,
   'עגבניות שרי', '30340000-0000-4000-8000-000000000001',
   8, 'kg', 20, 0, 18, 160, '{}'::text[], '{}'::jsonb, repeat('b', 64)),
  -- A line nobody mapped to an order item. Real money, unknown product placement.
  ('c0340000-0000-4000-8000-000000000002', '10340000-0000-4000-8000-000000000001',
   'b0340000-0000-4000-8000-000000000001', 'a0340000-0000-4000-8000-000000000001', 2,
   'משהו שלא מופה', null,
   1, 'unit', 29, 0, 18, 29, '{}'::text[], '{}'::jsonb, repeat('c', 64));
select set_config('app.invoice_three_way_writer', 'match', true);
insert into public.invoice_line_match_sets (
  id, org_id, invoice_id, evidence_batch_id, revision, idempotency_key, match_checksum,
  actor_id, reason
) values (
  'd0340000-0000-4000-8000-000000000001', '10340000-0000-4000-8000-000000000001',
  'a0340000-0000-4000-8000-000000000001', 'b0340000-0000-4000-8000-000000000001', 1,
  gen_random_uuid(), repeat('d', 64), '20340000-0000-4000-8000-000000000001', 'P34 fixture');
insert into public.invoice_line_matches (
  org_id, match_set_id, invoice_id, invoice_line_id, purchase_order_item_id, allocated_quantity
) values (
  '10340000-0000-4000-8000-000000000001', 'd0340000-0000-4000-8000-000000000001',
  'a0340000-0000-4000-8000-000000000001', 'c0340000-0000-4000-8000-000000000001',
  '80340000-0000-4000-8000-000000000001', 8);
select set_config('app.invoice_three_way_writer', '', true);

-- ===== 1. Counted once =====

select pg_temp.p34_assert(
  (select (p ->> 'canonical_qty')::numeric = 8
   from pg_temp.p34_product('30340000-0000-4000-8000-000000000001') p),
  'THE SAME DELIVERY WAS COUNTED MORE THAN ONCE. Ten ordered, eight received, eight billed — one '
  'purchase of eight. A naive rollup says twenty-six, and twenty-six looks perfectly plausible on '
  'a screen, which is what makes it dangerous rather than merely wrong');

select pg_temp.p34_assert(
  (select p ->> 'includes_invoice_only_quantity' = 'false'
   from pg_temp.p34_product('30340000-0000-4000-8000-000000000001') p),
  'the row does not say that its quantity came from our own count rather than the supplier''s '
  'word. A quantity whose provenance is invisible cannot be defended in a supplier conversation');

select pg_temp.p34_assert(
  (select (p ->> 'ordered_qty')::numeric = 14
          and (p ->> 'received_qty')::numeric = 8
          and (p ->> 'invoiced_qty')::numeric = 8
   from pg_temp.p34_product('30340000-0000-4000-8000-000000000001') p),
  'ordered, received and invoiced stopped being separate columns. The rows worth opening are '
  'exactly the ones where they disagree, and one merged figure hides the disagreement');

-- ===== 2. A draft receipt is not an arrival =====

select pg_temp.p34_assert(
  (select (p ->> 'received_qty')::numeric = 8
   from pg_temp.p34_product('30340000-0000-4000-8000-000000000001') p),
  'the two units on the DRAFT receipt were counted as arrived. A draft is a proposal nobody has '
  'confirmed');

-- ===== 3. Products are never merged by name =====

select pg_temp.p34_assert(
  (select (p ->> 'canonical_qty')::numeric = 6 and (p ->> 'gross_amount')::numeric = 0
   from pg_temp.p34_product('30340000-0000-4000-8000-000000000002') p),
  '"עגבניות שרי 500 גרם" was merged into "עגבניות שרי", or its receipted quantity was lost. They '
  'are one product to a person and two rows to Postgres; merging them on a screen that drives '
  'purchasing decisions invents a fact');

select pg_temp.p34_assert(
  (select count(*) = 3 from jsonb_array_elements(
     private.product_purchase_summary(
       '10340000-0000-4000-8000-000000000001', '2026-08-01', '2026-08-31', null) -> 'products')),
  'the product count changed, which means rows were merged or dropped');

-- ===== 4. Ordered is never the answer =====

select pg_temp.p34_assert(
  (select (p ->> 'ordered_qty')::numeric = 7 and (p ->> 'canonical_qty')::numeric = 0
          and p ->> 'includes_unevidenced_quantity' = 'true'
   from pg_temp.p34_product('30340000-0000-4000-8000-000000000003') p),
  'a product that was ordered and never evidenced reported a purchase. Ordered is what we asked '
  'for, not what we bought — and the row must say that it is still waiting for evidence');

-- ===== 5. Money nobody could place is a work list, not a rounding error =====

select pg_temp.p34_assert(
  (select (r ->> 'unmapped_invoice_lines')::bigint = 1
          and (r ->> 'unmapped_invoice_amount')::numeric = 29
   from private.product_purchase_summary(
     '10340000-0000-4000-8000-000000000001', '2026-08-01', '2026-08-31', null) r),
  'an approved invoice line that no order item claims was silently folded into a product total, '
  'or silently dropped. It is real money whose product placement is not established');

select pg_temp.p34_assert(
  (select (p ->> 'gross_amount')::numeric = 160
   from pg_temp.p34_product('30340000-0000-4000-8000-000000000001') p),
  'the unmapped ₪29 line leaked into a product''s spend');

select pg_temp.p34_assert(
  (select (p ->> 'average_unit_price')::numeric = 20
   from pg_temp.p34_product('30340000-0000-4000-8000-000000000001') p),
  'the average unit price is not spend divided by the CANONICAL quantity. Dividing by the summed '
  'quantity of all three sources would report a third of the real price');

-- ===== 6. Provenance of the row itself =====

select pg_temp.p34_assert(
  (select (p ->> 'supplier_count')::bigint = 2 and (p ->> 'order_count')::bigint = 2
          and (p ->> 'invoice_count')::bigint = 1
   from pg_temp.p34_product('30340000-0000-4000-8000-000000000001') p),
  'the row does not say how many suppliers, orders and invoices it stands on, so a reader cannot '
  'tell one big purchase from several small ones');

select pg_temp.p34_assert(
  (select r ->> 'quantity_rule' = 'completed_receipt_else_approved_invoice_never_both'
   from private.product_purchase_summary(
     '10340000-0000-4000-8000-000000000001', '2026-08-01', '2026-08-31', null) r),
  'the answer no longer states the rule it counted by');

-- ===== 7. The supplier filter narrows without changing the rule =====

select pg_temp.p34_assert(
  (select (p ->> 'canonical_qty')::numeric = 8 and (p ->> 'ordered_qty')::numeric = 10
   from jsonb_array_elements(
     private.product_purchase_summary(
       '10340000-0000-4000-8000-000000000001', '2026-08-01', '2026-08-31',
       '40340000-0000-4000-8000-000000000001') -> 'products') p
   where p ->> 'product_id' = '30340000-0000-4000-8000-000000000001'),
  'filtering to one supplier changed the counting rule rather than the row set');

-- ===== 8. The boundary =====

set local role authenticated;
select set_config('request.jwt.claim.sub', '20340000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select pg_temp.p34_assert(
  (select jsonb_array_length(r -> 'products') = 3
   from public.get_product_purchase_summary('2026-08-01', '2026-08-31') r),
  'the owner cannot read the summary through the public wrapper');

reset role;
select pg_temp.p34_assert(
  not has_function_privilege('authenticated',
    'private.product_purchase_summary(uuid,date,date,uuid)', 'execute'),
  'a client role can call the private summary directly, which takes org_id as an argument');

rollback;
