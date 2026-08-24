-- P60 -- a price with an older effective date records history but does not move the present.
--
-- This suite exists because the defect it pins was invisible from every screen. Both live price
-- writers asked `price_effective_date <> p_effective_date`, which is true in BOTH directions, so
-- a price list carrying a date earlier than the stored one replaced `current_price` with the
-- older figure and every order priced afterwards used it. Nothing warned: from the writer's
-- point of view something had changed and it wrote it. Meanwhile the as-of read
-- (`private.supplier_price_effective_on`, 0105) kept answering correctly about the PAST, which
-- is precisely why nobody noticed the present was wrong.
--
-- Each assertion below is one half of the rule 0207 installed: the newer date wins the present,
-- and the older date still earns its place in history.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p78_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P60 newest-effective-date assertion failed: %', p_message;
  end if;
end
$$;

insert into public.organizations (id, name, status) values
  ('1a600000-0000-4000-8000-000000000001', 'P60 tenant', 'active');
insert into auth.users (id, email) values
  ('2a600000-0000-4000-8000-000000000001', 'owner-p78@example.test');
insert into public.profiles (id, org_id, full_name, role) values
  ('2a600000-0000-4000-8000-000000000001', '1a600000-0000-4000-8000-000000000001', 'P60 owner', 'owner');
insert into public.suppliers (id, org_id, name, status) values
  ('4a600000-0000-4000-8000-000000000001', '1a600000-0000-4000-8000-000000000001', 'P60 supplier', 'active');
insert into public.products (id, org_id, name, unit) values
  ('3a600000-0000-4000-8000-000000000001', '1a600000-0000-4000-8000-000000000001', 'P60 single', 'kg'),
  ('3a600000-0000-4000-8000-000000000002', '1a600000-0000-4000-8000-000000000001', 'P60 bulk', 'kg');

-- Two identical starting points, so the single-write path and the bulk-import path are measured
-- against the same fact rather than against each other.
insert into public.supplier_products (
  id, org_id, supplier_id, product_id, current_price, price_effective_date
) values
  ('5a600000-0000-4000-8000-000000000001', '1a600000-0000-4000-8000-000000000001',
   '4a600000-0000-4000-8000-000000000001', '3a600000-0000-4000-8000-000000000001', 10, date '2026-08-01'),
  ('5a600000-0000-4000-8000-000000000002', '1a600000-0000-4000-8000-000000000001',
   '4a600000-0000-4000-8000-000000000001', '3a600000-0000-4000-8000-000000000002', 10, date '2026-08-01');
insert into public.price_history (org_id, supplier_product_id, price, effective_date) values
  ('1a600000-0000-4000-8000-000000000001', '5a600000-0000-4000-8000-000000000001', 10, date '2026-08-01'),
  ('1a600000-0000-4000-8000-000000000001', '5a600000-0000-4000-8000-000000000002', 10, date '2026-08-01');

select set_config('request.jwt.claim.sub', '2a600000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

-- ===== 1. The newer date wins the present =====
select public.set_supplier_product_price(
  '5a600000-0000-4000-8000-000000000001', 14, date '2026-09-01', true, 'P60 raise');

select pg_temp.p78_assert(
  (select round(current_price, 2) = 14 and price_effective_date = date '2026-09-01'
     from public.supplier_products where id = '5a600000-0000-4000-8000-000000000001'),
  'a NEWER effective date must move current_price and price_effective_date');

-- ===== 2. The older date does NOT move the present =====
-- The write is accepted -- it is a real fact about an earlier period -- but it must not become
-- the price the next purchase order snapshots.
select public.set_supplier_product_price(
  '5a600000-0000-4000-8000-000000000001', 7, date '2026-07-01', true, 'P60 backdated correction');

select pg_temp.p78_assert(
  (select round(current_price, 2) = 14 and price_effective_date = date '2026-09-01'
     from public.supplier_products where id = '5a600000-0000-4000-8000-000000000001'),
  'an OLDER effective date overwrote the current price -- the defect 0207 exists to stop');

-- ===== 3. ...and it still earns its row in history =====
-- Dropping the row would be the opposite failure: the ledger would forget a price that was
-- really charged, and ARCHITECTURE.md:178 says price_history keeps every change.
select pg_temp.p78_assert(
  (select count(*) = 1 from public.price_history
    where supplier_product_id = '5a600000-0000-4000-8000-000000000001'
      and effective_date = date '2026-07-01' and round(price, 2) = 7),
  'the backdated price was refused entry to history -- it is a fact, not a mistake');

-- ===== 4. The as-of read answers with it, for its own period =====
-- `private` is not reachable from `authenticated`; reading the baseline is a server question.
reset role;

-- This is what makes (3) worth doing rather than merely harmless.
select pg_temp.p78_assert(
  (private.supplier_price_effective_on(
     '1a600000-0000-4000-8000-000000000001',
     '4a600000-0000-4000-8000-000000000001',
     '3a600000-0000-4000-8000-000000000001', date '2026-07-15') ->> 'baseline_price')::numeric = 7,
  'the backdated price is in history but the as-of baseline cannot see it');

select pg_temp.p78_assert(
  (private.supplier_price_effective_on(
     '1a600000-0000-4000-8000-000000000001',
     '4a600000-0000-4000-8000-000000000001',
     '3a600000-0000-4000-8000-000000000001', date '2026-09-15') ->> 'baseline_price')::numeric = 14,
  'the as-of baseline stopped resolving the newest row on or before the date');

-- ===== 5. The refusal is legible afterwards =====
-- A write that changed less than it was asked to must say so, or the audit trail quietly
-- disagrees with the table.
select pg_temp.p78_assert(
  (select (new_values ->> 'superseded_by_newer_effective_date')::boolean
     from public.audit_logs
    where action = 'supplier_product_price_set'
      and entity_id = '5a600000-0000-4000-8000-000000000001'
    order by created_at desc, id desc limit 1),
  'the audit row does not record that a backdated write was superseded');

-- ===== 6. The bulk import path obeys the same rule =====
-- Every client import (PriceListUpload, QuickCreateProduct, Onboarding, PriceLists) funnels
-- through this one, so a guard on the single write alone would leave the common path broken.
select public.import_supplier_prices(
  jsonb_build_array(jsonb_build_object(
    'supplier_id', '4a600000-0000-4000-8000-000000000001',
    'product_id',  '3a600000-0000-4000-8000-000000000002',
    'price', 16, 'available', true)),
  date '2026-09-01', 'P60 bulk raise');

select public.import_supplier_prices(
  jsonb_build_array(jsonb_build_object(
    'supplier_id', '4a600000-0000-4000-8000-000000000001',
    'product_id',  '3a600000-0000-4000-8000-000000000002',
    'price', 5, 'available', true)),
  date '2026-06-01', 'P60 bulk backdated');

select pg_temp.p78_assert(
  (select round(current_price, 2) = 16 and price_effective_date = date '2026-09-01'
     from public.supplier_products where id = '5a600000-0000-4000-8000-000000000002'),
  'the bulk import let an older effective date overwrite the current price');

select pg_temp.p78_assert(
  (select count(*) = 1 from public.price_history
    where supplier_product_id = '5a600000-0000-4000-8000-000000000002'
      and effective_date = date '2026-06-01' and round(price, 2) = 5),
  'the bulk import dropped the backdated row instead of recording it');

-- ===== 7. Availability is about now, not about a date =====
-- Deliberately NOT guarded by 0207: an older price list may still be the latest word on whether
-- the supplier can ship the item. This assertion exists so that a future change which "tidies"
-- availability into the date guard fails here and has to argue for it.
select public.import_supplier_prices(
  jsonb_build_array(jsonb_build_object(
    'supplier_id', '4a600000-0000-4000-8000-000000000001',
    'product_id',  '3a600000-0000-4000-8000-000000000002',
    'price', 5, 'available', false)),
  date '2026-06-01', 'P60 bulk backdated unavailable');

select pg_temp.p78_assert(
  (select available = false and round(current_price, 2) = 16
     from public.supplier_products where id = '5a600000-0000-4000-8000-000000000002'),
  'a backdated row must still be able to report the product unavailable without moving the price');

reset role;

rollback;
