-- P88 — the invoice publishes the ladder, and the ladder agrees with the decision.
--
-- `0261` added six keys to `private.invoice_three_way_raw`'s totals block so the reconciliation
-- strip can render the invoice's arithmetic instead of redoing it in React. Six keys are easy to
-- add and easy to get subtly wrong, and every way of getting them wrong is a lie told in a
-- currency: a gap with the wrong sign, a discount summed over the wrong lines, a zero standing in
-- for an invoice nobody itemised, or a figure rounded to two places in a currency that has none.
--
-- So this suite proves four things that a reader would act on:
--
--   THE GAP IS THE SAME NUMBER THE SERVER JUDGED, with the same sign the DOCUMENT ladder uses —
--   `total - (net + vat)` — while `difference_amount` on the existing reason keeps the opposite
--   sign it has carried since `0099`. Both are asserted, because one component draws both ladders.
--
--   AN ABSENCE IS NAMED. An invoice with no extracted lines reports `missing_rungs: ["lines_net"]`
--   and a NULL discount — never `0`, which would claim the lines were read and summed to nothing.
--
--   THE SCALE IS THE CURRENCY'S. The yen has no minor unit, so a yen ladder carries no decimals.
--
--   AND NOTHING THAT WAS ALREADY PUBLISHED MOVED, including the three line totals two Edge
--   Function tools read, and including whether the invoice is blocked at all.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p88_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P88 invoice ladder assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p88_totals(p_invoice uuid)
returns jsonb language sql stable as $$
  select private.invoice_three_way_raw(
    '10880000-0000-4000-8000-000000000001', p_invoice) -> 'totals';
$$;

create function pg_temp.p88_reason(p_invoice uuid, p_code text)
returns jsonb language sql stable as $$
  select r
  from jsonb_array_elements(private.invoice_three_way_raw(
    '10880000-0000-4000-8000-000000000001', p_invoice) -> 'reasons') r
  where r ->> 'code' = p_code
  limit 1;
$$;

insert into public.organizations(id, name, status, vat_rate, base_currency, country_code)
values ('10880000-0000-4000-8000-000000000001', 'P88 org', 'active', 18, 'ILS', 'IL');

insert into auth.users (id, email) values
  ('20880000-0000-4000-8000-000000000001', 'owner-p88@example.test');
insert into public.profiles(id, org_id, full_name, role, active)
values ('20880000-0000-4000-8000-000000000001', '10880000-0000-4000-8000-000000000001',
        'P88 actor', 'owner', true);

insert into public.suppliers(id, org_id, name, status, default_currency, country_code) values
('40880000-0000-4000-8000-000000000001', '10880000-0000-4000-8000-000000000001',
 'P88 ILS', 'active', 'ILS', 'IL'),
('40880000-0000-4000-8000-000000000002', '10880000-0000-4000-8000-000000000001',
 'P88 JPY', 'active', 'JPY', 'JP');

insert into public.invoices
  (id, org_id, supplier_id, invoice_number, invoice_date,
   amount_before_vat, vat_amount, total_amount, currency) values
-- A: reconciles exactly. 100 + 18 = 118. The gap is a MEASURED zero, which is a different fact
-- from an unmeasured one and has to survive the trip through JSON as a number.
('f8800000-0000-4000-8000-000000000001', '10880000-0000-4000-8000-000000000001',
 '40880000-0000-4000-8000-000000000001', 'P88-OK', '2026-08-01', 100, 18, 118, 'ILS'),
-- B: the header states 12 more than its own parts imply. Outside the shekel tolerance of 1, so
-- the server blocks — and the strip must show the same 12 the server acted on.
('f8800000-0000-4000-8000-000000000002', '10880000-0000-4000-8000-000000000001',
 '40880000-0000-4000-8000-000000000001', 'P88-GAP', '2026-08-01', 100, 18, 130, 'ILS'),
-- C: yen. 10000 + 1800 = 11800, and a yen ladder has no decimal places at all.
('f8800000-0000-4000-8000-000000000003', '10880000-0000-4000-8000-000000000001',
 '40880000-0000-4000-8000-000000000002', 'P88-JPY', '2026-08-01', 10000, 1800, 11800, 'JPY'),
-- D: itemised, and every rung of it reconciles. 55 + 17.50 = 72.50 net, 9.90 + 3.15 = 13.05 VAT.
('f8800000-0000-4000-8000-000000000004', '10880000-0000-4000-8000-000000000001',
 '40880000-0000-4000-8000-000000000001', 'P88-LINES', '2026-08-01', 72.50, 13.05, 85.55, 'ILS');

-- The lines for D. `0099` requires a claimed writer and one kind at a time; no match set is
-- needed, because the ladder is the invoice's own arithmetic and not a comparison with an order.
select set_config('app.invoice_three_way_writer', 'evidence', true);
insert into public.invoice_line_evidence_batches (
  id, org_id, invoice_id, revision, idempotency_key, source_type, actor_id, source_checksum, reason
) values (
  'b8800000-0000-4000-8000-000000000001', '10880000-0000-4000-8000-000000000001',
  'f8800000-0000-4000-8000-000000000004', 1, gen_random_uuid(), 'manual_entry',
  '20880000-0000-4000-8000-000000000001', repeat('a', 64), 'P88 fixture');
insert into public.invoice_lines (
  id, org_id, evidence_batch_id, invoice_id, line_number, description, product_id,
  quantity, unit, unit_price, discount_amount, vat_rate, line_total,
  evidence_block_ids, raw_evidence, source_hash
) values
  -- 2 × 30 less a 5 discount = 55.
  ('c8800000-0000-4000-8000-000000000001', '10880000-0000-4000-8000-000000000001',
   'b8800000-0000-4000-8000-000000000001', 'f8800000-0000-4000-8000-000000000004', 1,
   'שורה עם הנחה', null, 2, 'unit', 30, 5, 18, 55, '{}'::text[], '{}'::jsonb, repeat('b', 64)),
  -- 1 × 20 less a 2.50 discount = 17.50.
  ('c8800000-0000-4000-8000-000000000002', '10880000-0000-4000-8000-000000000001',
   'b8800000-0000-4000-8000-000000000001', 'f8800000-0000-4000-8000-000000000004', 2,
   'שורה שנייה', null, 1, 'unit', 20, 2.50, 18, 17.50, '{}'::text[], '{}'::jsonb, repeat('c', 64));
select set_config('app.invoice_three_way_writer', '', true);

-- ---- 1. The computed total is the server's, and so is the gap. --------------------------------
select pg_temp.p88_assert(
  (pg_temp.p88_totals('f8800000-0000-4000-8000-000000000001') ->> 'computed_total')::numeric = 118,
  'A: computed_total is not net + vat');
select pg_temp.p88_assert(
  (pg_temp.p88_totals('f8800000-0000-4000-8000-000000000001') ->> 'unexplained_gap')::numeric = 0,
  'A: a reconciling invoice does not report a zero gap');

-- A MEASURED ZERO IS NOT A NULL. The strip prints a number for one and words for the other, so a
-- key that quietly went missing here would turn "these numbers agree" into "we could not check".
select pg_temp.p88_assert(
  jsonb_typeof(pg_temp.p88_totals('f8800000-0000-4000-8000-000000000001') -> 'unexplained_gap')
    = 'number',
  'A: the gap of a reconciling invoice is not a number');

-- ---- 2. The gap the strip shows is the gap the server acted on. -------------------------------
select pg_temp.p88_assert(
  (pg_temp.p88_totals('f8800000-0000-4000-8000-000000000002') ->> 'unexplained_gap')::numeric = 12,
  'B: the ladder gap is not the 12 the header overstates');
select pg_temp.p88_assert(
  pg_temp.p88_reason('f8800000-0000-4000-8000-000000000002',
    'invoice_header_arithmetic_discrepancy') is not null,
  'B: the server did not raise the discrepancy this gap describes');

-- AND THE TWO SIGNS ARE DELIBERATELY OPPOSITE. `difference_amount` has meant `(net + vat) - total`
-- since 0099 and two Edge tools read it; `unexplained_gap` means `total - (net + vat)`, matching
-- the document ladder in 0260 because one component draws both. Asserting the pair is what stops
-- a future "consistency fix" from silently flipping a number on a screen.
select pg_temp.p88_assert(
  (pg_temp.p88_reason('f8800000-0000-4000-8000-000000000002',
     'invoice_header_arithmetic_discrepancy') ->> 'difference_amount')::numeric = -12,
  'B: difference_amount changed sign');

-- ---- 3. An invoice nobody itemised says so, and never says zero. ------------------------------
select pg_temp.p88_assert(
  pg_temp.p88_totals('f8800000-0000-4000-8000-000000000001') -> 'missing_rungs'
    = '["lines_net"]'::jsonb,
  'A: an invoice with no lines does not name the missing rung');
select pg_temp.p88_assert(
  jsonb_typeof(pg_temp.p88_totals('f8800000-0000-4000-8000-000000000001') -> 'lines_discount')
    = 'null',
  'A: an unitemised invoice reports a discount instead of an absence');
select pg_temp.p88_assert(
  jsonb_typeof(pg_temp.p88_totals('f8800000-0000-4000-8000-000000000001') -> 'lines_vs_header_gap')
    = 'null',
  'A: an unitemised invoice reports a lines-versus-header gap it cannot have');

-- ---- 4. An itemised one sums its own discounts, over its own lines. ---------------------------
select pg_temp.p88_assert(
  (pg_temp.p88_totals('f8800000-0000-4000-8000-000000000004') ->> 'lines_discount')::numeric = 7.50,
  'D: the discount is not the sum of the two lines');
select pg_temp.p88_assert(
  pg_temp.p88_totals('f8800000-0000-4000-8000-000000000004') -> 'missing_rungs' = '[]'::jsonb,
  'D: an itemised invoice reports a missing rung');
select pg_temp.p88_assert(
  (pg_temp.p88_totals('f8800000-0000-4000-8000-000000000004')
     ->> 'lines_vs_header_gap')::numeric = 0,
  'D: the lines and the header disagree when they do not');
select pg_temp.p88_assert(
  (pg_temp.p88_totals('f8800000-0000-4000-8000-000000000004') ->> 'unexplained_gap')::numeric = 0,
  'D: an itemised invoice that reconciles reports a gap');

-- ---- 5. The scale belongs to the currency, not to the shekel. ---------------------------------
-- `round(x, 0)` on the yen leaves no decimal places. Two would be the shekel assumption `0259`
-- removed from the comparisons three lines above where this figure is built.
select pg_temp.p88_assert(
  pg_temp.p88_totals('f8800000-0000-4000-8000-000000000003') ->> 'computed_total' = '11800',
  'C: the yen ladder is rounded like a shekel');
select pg_temp.p88_assert(
  pg_temp.p88_totals('f8800000-0000-4000-8000-000000000003') ->> 'currency' = 'JPY',
  'C: the ladder does not carry the currency it is counted in');

-- ---- 6. Nothing that was already published moved. ---------------------------------------------
-- Two Edge Function tools read these three, and `0261` claims not to have touched them.
select pg_temp.p88_assert(
  (pg_temp.p88_totals('f8800000-0000-4000-8000-000000000004') ->> 'line_net')::numeric = 72.50
  and (pg_temp.p88_totals('f8800000-0000-4000-8000-000000000004') ->> 'line_vat')::numeric = 13.05
  and (pg_temp.p88_totals('f8800000-0000-4000-8000-000000000004') ->> 'line_grand')::numeric = 85.55,
  'D: an existing published line total changed');
select pg_temp.p88_assert(
  (pg_temp.p88_totals('f8800000-0000-4000-8000-000000000001') ->> 'invoice_tolerance')::numeric = 1,
  'A: the shekel tolerance 0259 derives stopped being 1');

-- ---- 7. And nothing that DECIDES anything moved either. ---------------------------------------
-- The reconciling invoice is not blocked by its own arithmetic; the overstated one is. That is
-- the pairing that makes the strip trustworthy: it shows the number the block was made on.
select pg_temp.p88_assert(
  pg_temp.p88_reason('f8800000-0000-4000-8000-000000000001',
    'invoice_header_arithmetic_discrepancy') is null,
  'A: a reconciling invoice was blocked on its header arithmetic');
select pg_temp.p88_assert(
  (private.invoice_three_way_raw('10880000-0000-4000-8000-000000000001',
     'f8800000-0000-4000-8000-000000000002') ->> 'approval_blocked')::boolean,
  'B: an invoice 12 over its tolerance is not blocked');

rollback;

select 'P88_invoice_ladder_passed' as result;
