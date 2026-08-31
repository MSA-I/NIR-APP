-- P87 — the document says by how much it does not add up, and which rung it never read.
--
-- Before 0260 the assessment published five numbers and two tolerances. It KNEW whether the header
-- reconciled — it raises `header_arithmetic_discrepancy` when it does not — but it never said BY
-- HOW MUCH, and the difference between a rounding artefact and a missing discount line is exactly
-- that number. A screen wanting the ladder would have had to add `header_net + header_vat` in
-- React: a second source of truth for money, rounding by its own rules rather than by the ones
-- that decided whether to block the document.
--
-- What this suite pins is the pair of claims that make the read model trustworthy:
--
--   THE GAP IS REAL ARITHMETIC, rounded by the assessment's own minor units, and it is NULL —
--   never zero — where a rung was not extracted. A gap of zero says "these numbers agree"; a gap
--   of null says "one of them is missing". Collapsing the two is the failure the constitution's
--   rule about `—` versus `0` describes.
--
--   NOTHING THAT DECIDES ANYTHING MOVED. Same findings, same severity, same approval_blocked.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p87_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P87 document ladder assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p87_totals(p_payload jsonb)
returns jsonb language sql as $$
  select private.document_reconciliation_assessment(
    '10870000-0000-4000-8000-000000000001', 'invoice',
    '40870000-0000-4000-8000-000000000001', null, p_payload, '2026-08-01') -> 'totals';
$$;

create function pg_temp.p87_full(p_payload jsonb)
returns jsonb language sql as $$
  select private.document_reconciliation_assessment(
    '10870000-0000-4000-8000-000000000001', 'invoice',
    '40870000-0000-4000-8000-000000000001', null, p_payload, '2026-08-01');
$$;

/* A header whose three figures are stated, plus one line. `header_total` is what the document
   CLAIMS; `net + vat` is what it IMPLIES. The distance between them is the gap. */
create function pg_temp.p87_payload(
  p_net text, p_vat text, p_total text, p_discount text default '0', p_line_total text default '100')
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'fields', jsonb_build_array(
      jsonb_build_object('key', 'currency', 'value', 'ILS'),
      jsonb_build_object('key', 'amount_before_vat', 'value', p_net),
      jsonb_build_object('key', 'vat_amount', 'value', p_vat),
      jsonb_build_object('key', 'total_amount', 'value', p_total)),
    'line_items', jsonb_build_array(jsonb_build_object('values', jsonb_build_object(
      'sku', 'P87-SKU', 'quantity', '1', 'unit_price', '100',
      'discount_amount', p_discount, 'line_total', p_line_total))));
$$;

insert into public.organizations(id, name, status, vat_rate, base_currency, country_code)
values ('10870000-0000-4000-8000-000000000001', 'P87 org', 'active', 18, 'ILS', 'IL');

insert into public.suppliers(id, org_id, name, status, default_currency, country_code)
values ('40870000-0000-4000-8000-000000000001', '10870000-0000-4000-8000-000000000001',
        'P87 supplier', 'active', 'ILS', 'IL');

/* The catalogue entry keeps `product_unidentified` out of the way: it blocks for a reason that has
   nothing to do with arithmetic, and would make every assertion below measure the wrong rule. */
insert into public.products(id, org_id, name, unit)
values ('30870000-0000-4000-8000-000000000001', '10870000-0000-4000-8000-000000000001', 'P87 מוצר', 'unit');
insert into public.supplier_products(id, org_id, supplier_id, product_id, current_price, supplier_sku, currency)
values ('70870000-0000-4000-8000-000000000001', '10870000-0000-4000-8000-000000000001',
        '40870000-0000-4000-8000-000000000001', '30870000-0000-4000-8000-000000000001',
        100, 'P87-SKU', 'ILS');

-- ---- 1. A document that adds up: the gap is ZERO, and zero is a measurement here. -------------
select pg_temp.p87_assert(
  (pg_temp.p87_totals(pg_temp.p87_payload('100', '18', '118')) ->> 'computed_total')::numeric = 118
  and (pg_temp.p87_totals(pg_temp.p87_payload('100', '18', '118')) ->> 'unexplained_gap')::numeric = 0,
  'a header that reconciles must publish a computed total of 118 and a gap of exactly 0');

-- ---- 2. A document that does not: the gap is the AMOUNT, not just a finding. ------------------
select pg_temp.p87_assert(
  (pg_temp.p87_totals(pg_temp.p87_payload('100', '18', '130')) ->> 'unexplained_gap')::numeric = 12,
  'a header claiming 130 against an implied 118 must publish a gap of 12');

select pg_temp.p87_assert(
  exists (select 1 from jsonb_array_elements(
            pg_temp.p87_full(pg_temp.p87_payload('100', '18', '130')) -> 'findings') f
          where f ->> 'code' = 'header_arithmetic_discrepancy'),
  'the finding that existed before 0260 must still be raised — the gap adds to it, not replaces it');

-- ---- 3. A NEGATIVE gap keeps its sign: a header short of what it implies is not the same
--         document as one over it, and an absolute value would have merged them.
select pg_temp.p87_assert(
  (pg_temp.p87_totals(pg_temp.p87_payload('100', '18', '110')) ->> 'unexplained_gap')::numeric = -8,
  'a header stating less than it implies must publish a negative gap, not its magnitude');

-- ---- 4. A rung that was never extracted makes the gap NULL, never 0. --------------------------
-- This is the assertion the whole read model exists for: "these agree" and "one of them is
-- missing" must not arrive at the screen as the same number.
select pg_temp.p87_assert(
  pg_temp.p87_totals(jsonb_build_object(
    'fields', jsonb_build_array(
      jsonb_build_object('key', 'currency', 'value', 'ILS'),
      jsonb_build_object('key', 'amount_before_vat', 'value', '100'),
      jsonb_build_object('key', 'total_amount', 'value', '118')),
    'line_items', '[]'::jsonb)) ->> 'unexplained_gap' is null,
  'a document with no VAT extracted must publish a NULL gap, never 0');

select pg_temp.p87_assert(
  pg_temp.p87_totals(jsonb_build_object(
    'fields', jsonb_build_array(
      jsonb_build_object('key', 'currency', 'value', 'ILS'),
      jsonb_build_object('key', 'amount_before_vat', 'value', '100'),
      jsonb_build_object('key', 'total_amount', 'value', '118')),
    'line_items', '[]'::jsonb)) -> 'missing_rungs' @> '["header_vat"]'::jsonb,
  'the missing rung must be named, so the screen can say WHICH one it could not read');

select pg_temp.p87_assert(
  pg_temp.p87_totals(jsonb_build_object(
    'fields', jsonb_build_array(
      jsonb_build_object('key', 'currency', 'value', 'ILS'),
      jsonb_build_object('key', 'amount_before_vat', 'value', '100'),
      jsonb_build_object('key', 'total_amount', 'value', '118')),
    'line_items', '[]'::jsonb)) -> 'missing_rungs' @> '["lines_net"]'::jsonb,
  'a document with no lines must name lines_net as missing rather than publishing a sum of nothing');

-- ---- 5. A document that reads completely names NO missing rung. -------------------------------
select pg_temp.p87_assert(
  pg_temp.p87_totals(pg_temp.p87_payload('100', '18', '118')) -> 'missing_rungs' = '[]'::jsonb,
  'a fully extracted document must report an empty list, not a null one');

-- ---- 6. The discounts the lines declare are summed and published. -----------------------------
select pg_temp.p87_assert(
  (pg_temp.p87_totals(pg_temp.p87_payload('100', '18', '118', '15', '85')) ->> 'lines_discount')::numeric = 15,
  'a line declaring a 15 discount must appear on the ladder as a discount of 15');

select pg_temp.p87_assert(
  (pg_temp.p87_totals(pg_temp.p87_payload('100', '18', '118')) ->> 'lines_discount')::numeric = 0,
  'a document with no discount publishes 0 — it was read, and it is zero');

-- ---- 7. The lines-versus-header gap is its own number, on its own rung. ------------------------
select pg_temp.p87_assert(
  (pg_temp.p87_totals(pg_temp.p87_payload('90', '18', '108')) ->> 'lines_vs_header_gap')::numeric = 10,
  'a 100 line against a 90 header net must publish a lines-versus-header gap of 10');

-- ---- 8. Every figure carries the unit it is in. -----------------------------------------------
select pg_temp.p87_assert(
  pg_temp.p87_totals(pg_temp.p87_payload('100', '18', '118')) ->> 'currency' = 'ILS',
  'the ladder must name its own currency rather than making the screen ask a second question');

-- ---- 9. And the decision did not move. --------------------------------------------------------
select pg_temp.p87_assert(
  not (pg_temp.p87_full(pg_temp.p87_payload('100', '18', '118')) ->> 'approval_blocked')::boolean,
  'a document that reconciles must still not be blocked');

select pg_temp.p87_assert(
  (pg_temp.p87_full(pg_temp.p87_payload('100', '18', '130')) ->> 'approval_blocked')::boolean,
  'a document that does not reconcile must still be blocked — 0260 decides nothing');

select 'P87_document_ladder_passed' as result;

rollback;
