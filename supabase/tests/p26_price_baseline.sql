-- P26 -- the contractual baseline is the price that was in effect on the document's date.
--
-- This suite exists because the alternative is a credit request against an innocent supplier. The
-- campaign turns "price above baseline" into an exception, an alert and a draft credit request; if
-- the baseline is today's `current_price` instead of the price as of the document, then every
-- document written before a price increase reads as an overcharge. Each assertion below is one way
-- that can happen.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p26_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P26 price baseline assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p26_baseline(p_supplier uuid, p_product uuid, p_on date)
returns jsonb language sql as $$
  select private.supplier_price_effective_on(
    '1a260000-0000-4000-8000-000000000001', p_supplier, p_product, p_on);
$$;

insert into public.organizations (id, name, status) values
  ('1a260000-0000-4000-8000-000000000001', 'P26 A', 'active'),
  ('1a260000-0000-4000-8000-000000000002', 'P26 B', 'active');
insert into public.products (id, org_id, name, unit) values
  ('3a260000-0000-4000-8000-000000000001', '1a260000-0000-4000-8000-000000000001', 'P26 priced', 'kg'),
  ('3a260000-0000-4000-8000-000000000002', '1a260000-0000-4000-8000-000000000001', 'P26 no history', 'unit'),
  ('3a260000-0000-4000-8000-000000000003', '1a260000-0000-4000-8000-000000000001', 'P26 unlisted', 'unit');
insert into public.suppliers (id, org_id, name, status) values
  ('4a260000-0000-4000-8000-000000000001', '1a260000-0000-4000-8000-000000000001', 'P26 supplier', 'active');

-- The product with a price history. `current_price` is deliberately the LAST value in the chain,
-- as the real commands leave it, so that any assertion which accidentally reads current_price
-- instead of the history returns 12 and fails visibly.
insert into public.supplier_products (
  id, org_id, supplier_id, product_id, current_price, price_effective_date, package_size
) values (
  '5a260000-0000-4000-8000-000000000001',
  '1a260000-0000-4000-8000-000000000001',
  '4a260000-0000-4000-8000-000000000001',
  '3a260000-0000-4000-8000-000000000001',
  12, date '2026-08-01', 6
);
insert into public.price_history (org_id, supplier_product_id, price, effective_date) values
  ('1a260000-0000-4000-8000-000000000001', '5a260000-0000-4000-8000-000000000001', 8, date '2026-06-01'),
  ('1a260000-0000-4000-8000-000000000001', '5a260000-0000-4000-8000-000000000001', 12, date '2026-08-01'),
  -- Future-dated, exactly as `set_supplier_product_price` permits.
  ('1a260000-0000-4000-8000-000000000001', '5a260000-0000-4000-8000-000000000001', 20, date '2026-12-01');

-- A product the supplier lists but for which no history row was ever written.
insert into public.supplier_products (
  id, org_id, supplier_id, product_id, current_price, price_effective_date
) values (
  '5a260000-0000-4000-8000-000000000002',
  '1a260000-0000-4000-8000-000000000001',
  '4a260000-0000-4000-8000-000000000001',
  '3a260000-0000-4000-8000-000000000002',
  7, date '2026-07-01'
);

-- ===== 1. The claim the campaign rests on =====

select pg_temp.p26_assert(
  (pg_temp.p26_baseline(
     '4a260000-0000-4000-8000-000000000001',
     '3a260000-0000-4000-8000-000000000001', date '2026-07-15')
   || '{}'::jsonb) @> jsonb_build_object(
     'status', 'resolved',
     'baseline_price', 8,
     'baseline_source', 'price_history',
     'baseline_effective_date', '2026-06-01',
     'as_of', '2026-07-15'),
  'a July document was priced against a price that started in August -- this is the false '
  'overcharge the whole migration exists to prevent');

select pg_temp.p26_assert(
  (select (pg_temp.p26_baseline(
     '4a260000-0000-4000-8000-000000000001',
     '3a260000-0000-4000-8000-000000000001', date '2026-08-05') ->> 'baseline_price')::numeric = 12),
  'an August document did not pick up the August price');

select pg_temp.p26_assert(
  (select (pg_temp.p26_baseline(
     '4a260000-0000-4000-8000-000000000001',
     '3a260000-0000-4000-8000-000000000001', date '2026-08-01') ->> 'baseline_price')::numeric = 12),
  'the effective_date boundary is exclusive -- a document dated the day a price took effect must '
  'use that price');

select pg_temp.p26_assert(
  (select (pg_temp.p26_baseline(
     '4a260000-0000-4000-8000-000000000001',
     '3a260000-0000-4000-8000-000000000001', date '2026-08-05') ->> 'baseline_price')::numeric <> 20),
  'a future-dated price was applied to a document that predates it');

-- ===== 2. Documents older than our records, and products with no records =====
--
-- Falling back to `current_price` here would be the worst answer available: it is the far end of a
-- chain of increases the document could not have known about. The earliest recorded price is
-- returned instead, and it is labelled so the reviewer is told.

select pg_temp.p26_assert(
  (pg_temp.p26_baseline(
     '4a260000-0000-4000-8000-000000000001',
     '3a260000-0000-4000-8000-000000000001', date '2026-01-01')
   || '{}'::jsonb) @> jsonb_build_object(
     'baseline_price', 8,
     'baseline_source', 'earliest_price_history',
     'baseline_effective_date', '2026-06-01'),
  'a document predating all recorded prices was compared against today''s price');

select pg_temp.p26_assert(
  (pg_temp.p26_baseline(
     '4a260000-0000-4000-8000-000000000001',
     '3a260000-0000-4000-8000-000000000002', date '2026-07-15')
   || '{}'::jsonb) @> jsonb_build_object(
     'baseline_price', 7, 'baseline_source', 'current_price'),
  'a product without price history did not fall back to current_price, or did not disclose it');

select pg_temp.p26_assert(
  (select b ->> 'baseline_source' = 'current_price' and b ->> 'as_of' is null
   from pg_temp.p26_baseline(
     '4a260000-0000-4000-8000-000000000001',
     '3a260000-0000-4000-8000-000000000001', null) b),
  'a document with no readable date was given an as-of answer it cannot have');

-- ===== 3. What must NOT be answered =====

select pg_temp.p26_assert(
  (pg_temp.p26_baseline(
     '4a260000-0000-4000-8000-000000000001',
     '3a260000-0000-4000-8000-000000000003', date '2026-07-15')
   || '{}'::jsonb) @> jsonb_build_object(
     'status', 'unknown', 'reason', 'supplier_does_not_list_product'),
  'a baseline was invented for a product this supplier does not list');

select pg_temp.p26_assert(
  private.supplier_price_effective_on(
    '1a260000-0000-4000-8000-000000000002',
    '4a260000-0000-4000-8000-000000000001',
    '3a260000-0000-4000-8000-000000000001', date '2026-07-15') ->> 'status' = 'unknown',
  'another tenant read this org''s contractual prices through the org_id argument');

select pg_temp.p26_assert(
  private.supplier_price_effective_on(
    null, '4a260000-0000-4000-8000-000000000001',
    '3a260000-0000-4000-8000-000000000001', date '2026-07-15') ->> 'status' = 'unknown',
  'a null org_id produced an answer instead of unknown');

-- ===== 4. Reversal ordering: same effective_date, later row wins =====
--
-- A price-list reversal writes a compensating row rather than deleting history (0081:865). It
-- carries the same effective_date and a later created_at, so it must win -- that is what
-- reversing means.

insert into public.price_history (org_id, supplier_product_id, price, effective_date, created_at)
values (
  '1a260000-0000-4000-8000-000000000001', '5a260000-0000-4000-8000-000000000001',
  9, date '2026-08-01', now() + interval '1 minute'
);
select pg_temp.p26_assert(
  (select (pg_temp.p26_baseline(
     '4a260000-0000-4000-8000-000000000001',
     '3a260000-0000-4000-8000-000000000001', date '2026-08-05') ->> 'baseline_price')::numeric = 9),
  'a compensating price row written after a reversal was ignored');

-- ===== 5. The baseline is read, never written =====
--
-- OPEN-DECISIONS #144: the price list is the contractual baseline and is never updated from a
-- document. A read-only helper is the cheapest place to hold that line, so it is asserted here
-- rather than assumed from the word `stable`.

create temp table p26_before as
  select id, current_price, price_effective_date from public.supplier_products
  where org_id = '1a260000-0000-4000-8000-000000000001';
select count(*) as n into temp table p26_hist_before from public.price_history
  where org_id = '1a260000-0000-4000-8000-000000000001';

select pg_temp.p26_baseline(
  '4a260000-0000-4000-8000-000000000001', '3a260000-0000-4000-8000-000000000001', date '2026-07-15');
select pg_temp.p26_baseline(
  '4a260000-0000-4000-8000-000000000001', '3a260000-0000-4000-8000-000000000002', null);

select pg_temp.p26_assert(
  not exists (
    select 1 from p26_before b
    join public.supplier_products sp on sp.id = b.id
    where sp.current_price is distinct from b.current_price
       or sp.price_effective_date is distinct from b.price_effective_date)
  and (select n from p26_hist_before)
      = (select count(*) from public.price_history
         where org_id = '1a260000-0000-4000-8000-000000000001'),
  'reading the baseline changed the price list -- a document must never update it');

-- ===== 6. The browser cannot reach it =====

select pg_temp.p26_assert(
  not has_schema_privilege('authenticated', 'private', 'usage'),
  'the authenticated role gained USAGE on private -- supplier_price_effective_on takes org_id as '
  'an argument and would trust a caller that can now pass any org');
select pg_temp.p26_assert(
  not has_schema_privilege('anon', 'private', 'usage'),
  'the anon role gained USAGE on private');

-- ===== 7. Package size travels with the price =====
--
-- A document line prices a package; the baseline prices whatever the price list prices. The caller
-- cannot normalise units without knowing the package size, and a missing one has to be visible as
-- missing rather than defaulted to 1 (0099 already sends unresolved packaging to manual review).

select pg_temp.p26_assert(
  (select (pg_temp.p26_baseline(
     '4a260000-0000-4000-8000-000000000001',
     '3a260000-0000-4000-8000-000000000001', date '2026-07-15') ->> 'package_size')::numeric = 6),
  'the baseline did not carry the package size the caller needs to normalise units');
select pg_temp.p26_assert(
  (select pg_temp.p26_baseline(
     '4a260000-0000-4000-8000-000000000001',
     '3a260000-0000-4000-8000-000000000002', date '2026-07-15') ->> 'package_size' is null),
  'an absent package size was reported as a number');

rollback;
