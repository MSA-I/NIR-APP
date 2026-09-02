-- P29 -- four sources compared, and the several ways that comparison could lie.
--
-- The assessment in 0108 is what a person sees before approving a supplier document, and what
-- blocks that approval. Everything downstream in this campaign -- the credit request, the receipt
-- draft, the expense figures -- is built on its verdict. So each assertion below is one way the
-- verdict could be wrong in a direction that costs money or accuses a supplier who did nothing:
--
--   * comparing against TODAY'S price instead of the price agreed on the document's date, which
--     turns every price rise into retroactive overcharging on older documents;
--   * treating a DRAFT receipt as a fact about goods that arrived;
--   * reading a quantity that could not be read as zero;
--   * calling an item "missing" because a partial document did not mention it;
--   * naming a product from its description;
--   * proposing a credit for a price that was BELOW the agreed one.
\set ON_ERROR_STOP on

begin;

-- Legacy invoice fixtures in this transaction predate multi-currency and are explicitly ILS.
alter table public.invoices alter column currency set default 'ILS';

create function pg_temp.p29_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P29 reconciliation assertion failed: %', p_message;
  end if;
end
$$;

-- The payload shape the extraction contract produces. Only the keys 0108 actually reads are
-- built here, and they are built the way the pipeline builds them -- a key that stops being read
-- shows up below as a finding that stopped firing.
create function pg_temp.p29_payload(p_lines jsonb, p_fields jsonb default '{}'::jsonb)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'fields', coalesce((
      select jsonb_agg(jsonb_build_object('key', f.key, 'value', f.value))
      from jsonb_each_text(p_fields) f), '[]'::jsonb),
    'line_items', p_lines);
$$;

create function pg_temp.p29_line(
  p_sku text default null,
  p_quantity text default null,
  p_unit text default null,
  p_unit_price text default null,
  p_line_total text default null,
  p_barcode text default null,
  p_vat_rate text default null
) returns jsonb language sql immutable as $$
  select jsonb_build_array(jsonb_build_object('values', jsonb_strip_nulls(jsonb_build_object(
    'sku', p_sku, 'barcode', p_barcode, 'quantity', p_quantity, 'unit', p_unit,
    'unit_price', p_unit_price, 'line_total', p_line_total, 'vat_rate', p_vat_rate))));
$$;

create function pg_temp.p29_assess(
  p_lines jsonb,
  p_fields jsonb default '{}'::jsonb,
  p_order uuid default null,
  p_date date default null,
  p_type text default 'invoice',
  p_supplier uuid default '4a290000-0000-4000-8000-000000000001',
  p_org uuid default '1a290000-0000-4000-8000-000000000001'
) returns jsonb language sql stable as $$
  select private.document_reconciliation_assessment(
    p_org, p_type, p_supplier, p_order, pg_temp.p29_payload(p_lines, p_fields), p_date);
$$;

-- Does any finding with this code exist, at any severity?
create function pg_temp.p29_finding(p_assessment jsonb, p_code text)
returns jsonb language sql immutable as $$
  select f from jsonb_array_elements(p_assessment -> 'findings') f
  where f ->> 'code' = p_code limit 1;
$$;

insert into public.organizations (id, name, status, vat_rate) values
  ('1a290000-0000-4000-8000-000000000001', 'P29 mine', 'active', 18),
  ('1a290000-0000-4000-8000-000000000002', 'P29 other tenant', 'active', 18);

insert into public.suppliers (id, org_id, name, status) values
  ('4a290000-0000-4000-8000-000000000001', '1a290000-0000-4000-8000-000000000001',
   'P29 ספק', 'active'),
  ('4a290000-0000-4000-8000-000000000002', '1a290000-0000-4000-8000-000000000001',
   'P29 ספק אחר', 'active');

insert into public.products (id, org_id, name, unit) values
  ('3a290000-0000-4000-8000-000000000001', '1a290000-0000-4000-8000-000000000001',
   'P29 בשר', 'kg'),
  ('3a290000-0000-4000-8000-000000000002', '1a290000-0000-4000-8000-000000000001',
   'P29 ארגז', 'unit'),
  ('3a290000-0000-4000-8000-000000000003', '1a290000-0000-4000-8000-000000000001',
   'P29 מוצר שלא הוזמן', 'unit');

insert into public.supplier_products
  (id, org_id, supplier_id, product_id, current_price, supplier_sku) values
  ('7a290000-0000-4000-8000-000000000001', '1a290000-0000-4000-8000-000000000001',
   '4a290000-0000-4000-8000-000000000001', '3a290000-0000-4000-8000-000000000001', 30, 'SKU-MEAT'),
  ('7a290000-0000-4000-8000-000000000002', '1a290000-0000-4000-8000-000000000001',
   '4a290000-0000-4000-8000-000000000001', '3a290000-0000-4000-8000-000000000002', 8, 'SKU-BOX'),
  ('7a290000-0000-4000-8000-000000000003', '1a290000-0000-4000-8000-000000000001',
   '4a290000-0000-4000-8000-000000000001', '3a290000-0000-4000-8000-000000000003', 5, 'SKU-EXTRA');

-- The whole point of 0105, made concrete: ₪20/kg was agreed until 01.07.2026, ₪30/kg after. A
-- document dated 15.06 must be compared against 20, and one dated 15.07 against 30. Comparing
-- either against `current_price` would accuse this supplier of overcharging on the June document.
insert into public.price_history (org_id, supplier_product_id, price, effective_date) values
  ('1a290000-0000-4000-8000-000000000001', '7a290000-0000-4000-8000-000000000001', 20, '2026-01-01'),
  ('1a290000-0000-4000-8000-000000000001', '7a290000-0000-4000-8000-000000000001', 30, '2026-07-01'),
  ('1a290000-0000-4000-8000-000000000001', '7a290000-0000-4000-8000-000000000002', 8, '2026-01-01');

insert into public.purchase_orders (id, org_id, supplier_id, status) values
  ('5a290000-0000-4000-8000-000000000001', '1a290000-0000-4000-8000-000000000001',
   '4a290000-0000-4000-8000-000000000001', 'partial'),
  -- An order of the OTHER supplier, to catch a document attached to the wrong contract.
  ('5a290000-0000-4000-8000-000000000002', '1a290000-0000-4000-8000-000000000001',
   '4a290000-0000-4000-8000-000000000002', 'sent');

insert into public.purchase_order_items (id, org_id, order_id, product_id, qty, unit_price) values
  ('8a290000-0000-4000-8000-000000000001', '1a290000-0000-4000-8000-000000000001',
   '5a290000-0000-4000-8000-000000000001', '3a290000-0000-4000-8000-000000000001', 10, 20),
  ('8a290000-0000-4000-8000-000000000002', '1a290000-0000-4000-8000-000000000001',
   '5a290000-0000-4000-8000-000000000001', '3a290000-0000-4000-8000-000000000002', 5, 8);

-- One COMPLETED receipt (6 kg arrived of the 10 ordered) and one DRAFT (a proposal, not a fact).
insert into public.goods_receipts (id, org_id, order_id, status, received_at) values
  ('9a290000-0000-4000-8000-000000000001', '1a290000-0000-4000-8000-000000000001',
   '5a290000-0000-4000-8000-000000000001', 'completed', '2026-06-15'),
  ('9a290000-0000-4000-8000-000000000002', '1a290000-0000-4000-8000-000000000001',
   '5a290000-0000-4000-8000-000000000001', 'draft', '2026-06-16');
insert into public.goods_receipt_items
  (org_id, receipt_id, order_item_id, product_id, qty_received, status) values
  ('1a290000-0000-4000-8000-000000000001', '9a290000-0000-4000-8000-000000000001',
   '8a290000-0000-4000-8000-000000000001', '3a290000-0000-4000-8000-000000000001', 6, 'partial'),
  ('1a290000-0000-4000-8000-000000000001', '9a290000-0000-4000-8000-000000000002',
   '8a290000-0000-4000-8000-000000000002', '3a290000-0000-4000-8000-000000000002', 5, 'full');

-- ===== 1. The baseline is the price on the DOCUMENT'S date =====
--
-- This is the assertion the campaign exists for. Same document, same price, two dates: on 15.06
-- ₪22/kg is above the ₪20 that was agreed then; on 15.07 it is below the ₪30 agreed by then.

select pg_temp.p29_assert(
  (select (f ->> 'baseline_price')::numeric = 20
          and f ->> 'baseline_source' = 'price_history'
          and f ->> 'severity' = 'error'
   from pg_temp.p29_finding(
     pg_temp.p29_assess(pg_temp.p29_line('SKU-MEAT', '2', 'kg', '22', '44'),
                        '{}'::jsonb, null, date '2026-06-15'),
     'price_above_baseline') f),
  'a June document was not compared against the price agreed in June. Comparing against today''s '
  'price turns every later price rise into retroactive overcharging, and this campaign turns that '
  'finding into a credit request against a supplier who did nothing wrong');

select pg_temp.p29_assert(
  (select f ->> 'severity' = 'info' and (f ->> 'baseline_price')::numeric = 30
   from pg_temp.p29_finding(
     pg_temp.p29_assess(pg_temp.p29_line('SKU-MEAT', '2', 'kg', '22', '44'),
                        '{}'::jsonb, null, date '2026-07-15'),
     'price_below_baseline') f),
  'the same printed price was not recognised as BELOW the baseline once the agreed price rose');

select pg_temp.p29_assert(
  (select r -> 'totals' ->> 'overcharge_total' = '0.00'
          and pg_temp.p29_finding(r, 'credit_required') is null
   from pg_temp.p29_assess(pg_temp.p29_line('SKU-MEAT', '2', 'kg', '22', '44'),
                           '{}'::jsonb, null, date '2026-07-15') r),
  'a price BELOW the baseline produced a credit. A negative credit request is an invoice to our '
  'own supplier');

-- The overcharge is the positive difference times the quantity, and nothing else.
select pg_temp.p29_assert(
  (select (f ->> 'overcharge_amount')::numeric = 4
   from pg_temp.p29_finding(
     pg_temp.p29_assess(pg_temp.p29_line('SKU-MEAT', '2', 'kg', '22', '44'),
                        '{}'::jsonb, null, date '2026-06-15'),
     'price_above_baseline') f)
  and (select (r -> 'totals' ->> 'overcharge_total')::numeric = 4
       from pg_temp.p29_assess(pg_temp.p29_line('SKU-MEAT', '2', 'kg', '22', '44'),
                               '{}'::jsonb, null, date '2026-06-15') r),
  'the overcharge is not quantity times the positive unit-price difference');

-- 1% is 0099's price tolerance, reused rather than reinvented. ₪20.10 is inside it.
select pg_temp.p29_assert(
  (select pg_temp.p29_finding(r, 'price_above_baseline') is null
   from pg_temp.p29_assess(pg_temp.p29_line('SKU-MEAT', '2', 'kg', '20.10', '40.20'),
                           '{}'::jsonb, null, date '2026-06-15') r),
  'a price inside the 1% tolerance was reported as an overcharge');

-- ===== 2. What the assessment refuses to claim =====

select pg_temp.p29_assert(
  (select f ->> 'severity' = 'info' and (f ->> 'is_physical_absence_claim')::boolean = false
   from pg_temp.p29_finding(
     pg_temp.p29_assess(pg_temp.p29_line('SKU-MEAT', '2', 'kg', '20', '40'),
                        '{}'::jsonb, '5a290000-0000-4000-8000-000000000001', date '2026-06-15'),
     'ordered_not_on_document') f),
  'an ordered item absent from a PARTIAL document was reported as a shortage. A supplier bills in '
  'instalments; absence from one document says nothing about what is still coming');

select pg_temp.p29_assert(
  (select f ->> 'severity' = 'error'
   from pg_temp.p29_finding(
     pg_temp.p29_assess(pg_temp.p29_line('SKU-MEAT', 'לא מספר', 'kg', '20', '40')),
     'quantity_unreadable') f),
  'a quantity that could not be read was silently treated as readable. A quantity that cannot be '
  'read is not a zero -- zero is a claim that nothing arrived');

select pg_temp.p29_assert(
  (select f ->> 'severity' = 'error'
   from pg_temp.p29_finding(
     pg_temp.p29_assess(pg_temp.p29_line(null, '2', 'kg', '20', '40')),
     'product_unidentified') f),
  'a line with no printed code was assessed as if the product were known. Names are never a key: '
  '"בשר" and "בשר טרי 500 גרם" are one product to a person and two strings to Postgres');

-- ===== 3. A draft receipt is a proposal, not a fact about goods =====

select pg_temp.p29_assert(
  (select (r -> 'sources' ->> 'received')::boolean = true
   from pg_temp.p29_assess(pg_temp.p29_line('SKU-MEAT', '2', 'kg', '20', '40'),
                           '{}'::jsonb, '5a290000-0000-4000-8000-000000000001') r),
  'a completed receipt on the order was not recognised as physical-arrival evidence');

select pg_temp.p29_assert(
  (select f ->> 'severity' = 'error' and (f ->> 'received_quantity')::numeric = 6
   from pg_temp.p29_finding(
     pg_temp.p29_assess(pg_temp.p29_line('SKU-MEAT', '9', 'kg', '20', '180'),
                        '{}'::jsonb, '5a290000-0000-4000-8000-000000000001', date '2026-06-15'),
     'quantity_above_received') f),
  'billing 9 kg when 6 arrived was not caught, or the draft receipt''s quantity was counted as '
  'arrived. A draft moves no stock and asserts nothing');

select pg_temp.p29_assert(
  (select (f ->> 'received_quantity')::numeric = 0
   from pg_temp.p29_finding(
     pg_temp.p29_assess(pg_temp.p29_line('SKU-BOX', '5', 'unit', '8', '40'),
                        '{}'::jsonb, '5a290000-0000-4000-8000-000000000001', date '2026-06-15'),
     'quantity_above_received') f),
  'the five boxes recorded ONLY on the DRAFT receipt were counted as having arrived. A draft is a '
  'proposal a person has not confirmed; treating it as arrival would let a document approve '
  'itself through a receipt nobody signed');

-- One word, one number: the per-line comparison and the order rollup must not report physical
-- arrival differently, or a reviewer trusts whichever they happened to look at.
select pg_temp.p29_assert(
  (select (item ->> 'received_quantity')::numeric = 0
          and (item ->> 'recorded_received_qty')::numeric = 0
   from pg_temp.p29_assess(pg_temp.p29_line('SKU-BOX', '5', 'unit', '8', '40'),
                           '{}'::jsonb, '5a290000-0000-4000-8000-000000000001',
                           date '2026-06-15') r,
        jsonb_array_elements(r -> 'order_items') item
   where item ->> 'purchase_order_item_id' = '8a290000-0000-4000-8000-000000000002'),
  'the order rollup reports a different arrived quantity than the line comparison does');

select pg_temp.p29_assert(
  (select f ->> 'severity' = 'warning'
   from pg_temp.p29_finding(
     pg_temp.p29_assess(pg_temp.p29_line('SKU-MEAT', '6', 'kg', '20', '120'),
                        '{}'::jsonb, '5a290000-0000-4000-8000-000000000001', date '2026-06-15'),
     'receipt_recorded_exception') f),
  'a receipt line someone recorded as partial, damaged or returned was not surfaced. That is the '
  'strongest input the credit path has, and it came from a person standing at the delivery');

-- ===== 4. Against what was ordered =====

select pg_temp.p29_assert(
  (select f ->> 'severity' = 'error' and (f ->> 'ordered_quantity')::numeric = 10
   from pg_temp.p29_finding(
     pg_temp.p29_assess(pg_temp.p29_line('SKU-MEAT', '12', 'kg', '20', '240'),
                        '{}'::jsonb, '5a290000-0000-4000-8000-000000000001', date '2026-06-15'),
     'quantity_above_ordered') f),
  'a document billing more than the order allowed was accepted');

select pg_temp.p29_assert(
  (select f ->> 'severity' = 'error'
   from pg_temp.p29_finding(
     pg_temp.p29_assess(pg_temp.p29_line('SKU-EXTRA', '1', 'unit', '5', '5'),
                        '{}'::jsonb, '5a290000-0000-4000-8000-000000000001', date '2026-06-15'),
     'product_charged_not_ordered') f),
  'a product that was charged but never ordered passed without a person looking. It may be a '
  'legitimate direct purchase -- which is exactly why a person, not the machine, decides');

-- Weight tolerance: 2% of 10 kg is 0.2, so 10.1 kg is a match and 10.3 is not. These are 0099's
-- numbers, reused; an anchor in 0108 fails if they change there.
select pg_temp.p29_assert(
  (select pg_temp.p29_finding(r, 'quantity_above_ordered') is null
          and pg_temp.p29_finding(r, 'quantity_differs_from_ordered') is null
   from pg_temp.p29_assess(pg_temp.p29_line('SKU-MEAT', '10.1', 'kg', '20', '202'),
                           '{}'::jsonb, '5a290000-0000-4000-8000-000000000001',
                           date '2026-06-15') r),
  'a weight inside the 2% tolerance was reported as a discrepancy');

-- g<->kg is one of only two conversions 0099 permits, and it must survive here.
select pg_temp.p29_assert(
  (select pg_temp.p29_finding(r, 'unit_or_packaging_mismatch') is null
   from pg_temp.p29_assess(pg_temp.p29_line('SKU-MEAT', '2000', 'g', '0.02', '40'),
                           '{}'::jsonb, '5a290000-0000-4000-8000-000000000001',
                           date '2026-06-15') r),
  'grams were not converted to the order''s kilograms');

select pg_temp.p29_assert(
  (select f ->> 'severity' = 'error'
   from pg_temp.p29_finding(
     pg_temp.p29_assess(pg_temp.p29_line('SKU-MEAT', '2', 'קרטון', '20', '40'),
                        '{}'::jsonb, '5a290000-0000-4000-8000-000000000001', date '2026-06-15'),
     'unit_or_packaging_mismatch') f),
  'a packaging unit was silently converted. Packaging is never inferred from today''s package_size');

-- ===== 5. Arithmetic on the page, and the header against the lines =====

select pg_temp.p29_assert(
  (select f ->> 'severity' = 'error'
   from pg_temp.p29_finding(
     pg_temp.p29_assess(pg_temp.p29_line('SKU-MEAT', '2', 'kg', '20', '50')),
     'line_arithmetic_discrepancy') f),
  'a line whose total is not quantity times price was accepted');

select pg_temp.p29_assert(
  (select f ->> 'severity' = 'error'
   from pg_temp.p29_finding(
     pg_temp.p29_assess(pg_temp.p29_line('SKU-MEAT', '2', 'kg', '20', '40'),
                        jsonb_build_object('subtotal', '400')),
     'header_total_differs_from_lines') f),
  'a header total that disagrees with the sum of the lines was accepted');

select pg_temp.p29_assert(
  (select f ->> 'severity' = 'error'
   from pg_temp.p29_finding(
     pg_temp.p29_assess(pg_temp.p29_line('SKU-MEAT', '2', 'kg', '20', '40'),
                        jsonb_build_object('subtotal', '40', 'vat_amount', '7.2',
                                           'total', '90')),
     'header_arithmetic_discrepancy') f),
  'a header whose net plus VAT does not equal its total was accepted');

-- ===== 6. Identity findings: duplicate, wrong supplier, foreign currency =====

insert into public.invoices
  (org_id, supplier_id, invoice_number, invoice_date, total_amount) values
  ('1a290000-0000-4000-8000-000000000001', '4a290000-0000-4000-8000-000000000001',
   'INV-4471', '2026-06-10', 100);

select pg_temp.p29_assert(
  (select f ->> 'severity' = 'critical'
   from pg_temp.p29_finding(
     pg_temp.p29_assess(pg_temp.p29_line('SKU-MEAT', '2', 'kg', '20', '40'),
                        jsonb_build_object('invoice_number', 'INV-4471')),
     'duplicate_document') f),
  'the same supplier''s same document number was not recognised as already recorded');

select pg_temp.p29_assert(
  (select f ->> 'severity' = 'error'
   from pg_temp.p29_finding(
     pg_temp.p29_assess(pg_temp.p29_line('SKU-MEAT', '2', 'kg', '20', '40'),
                        '{}'::jsonb, '5a290000-0000-4000-8000-000000000002', date '2026-06-15'),
     'supplier_mismatch') f),
  'a document was compared against an order belonging to a different supplier. Every quantity and '
  'price below that point would be measured against the wrong contract');

select pg_temp.p29_assert(
  (select (r -> 'sources' ->> 'ordered')::boolean = false
   from pg_temp.p29_assess(pg_temp.p29_line('SKU-MEAT', '2', 'kg', '20', '40'),
                           '{}'::jsonb, '5a290000-0000-4000-8000-000000000002',
                           date '2026-06-15') r),
  'after a supplier mismatch the assessment still claimed the order as a source');

select pg_temp.p29_assert(
  (select r ->> 'currency' = 'EUR'
          and (r ->> 'approval_blocked')::boolean = false
          and pg_temp.p29_finding(r, 'currency_unrecognised') is null
   from pg_temp.p29_assess('[]'::jsonb, jsonb_build_object('currency', 'EUR')) r),
  'a valid active ISO currency was still refused instead of being carried by the assessment');

select pg_temp.p29_assert(
  (select (r ->> 'approval_blocked')::boolean = true
          and pg_temp.p29_finding(r, 'currency_unrecognised') ->> 'severity' = 'error'
   from pg_temp.p29_assess('[]'::jsonb, jsonb_build_object('currency', 'US0')) r),
  'an unreadable printed currency was accepted or silently treated as shekels');

select pg_temp.p29_assert(
  (select r ->> 'currency' = 'ILS'
          and pg_temp.p29_finding(r, 'currency_assumed_from_supplier') is null
   from pg_temp.p29_assess('[]'::jsonb, '{}'::jsonb) r),
  'a shekel supplier with no printed currency no longer follows the unchanged quiet ILS path');

-- VAT belongs to the business country, not the printed currency. A foreign supplier's document
-- is recorded as printed; the same zero-rate line from a domestic supplier is still a mismatch.
update public.organizations set country_code = 'IL'
where id = '1a290000-0000-4000-8000-000000000001';
update public.suppliers set country_code = 'IL'
where id = '4a290000-0000-4000-8000-000000000001';

select pg_temp.p29_assert(
  (select pg_temp.p29_finding(r, 'vat_rate_mismatch') is not null
   from pg_temp.p29_assess(
     pg_temp.p29_line('SKU-MEAT', '2', 'kg', '20', '40', null, '0'),
     jsonb_build_object('currency', 'ILS'), null, date '2026-06-15') r),
  'a domestic supplier stopped being checked against the organisation VAT rate');

update public.suppliers set country_code = 'US', default_currency = 'USD'
where id = '4a290000-0000-4000-8000-000000000001';

select pg_temp.p29_assert(
  (select pg_temp.p29_finding(r, 'vat_rate_mismatch') is null
   from pg_temp.p29_assess(
     pg_temp.p29_line('SKU-MEAT', '2', 'kg', '20', '40', null, '0'),
     jsonb_build_object('currency', 'USD'), null, date '2026-06-15') r),
  'a foreign supplier was falsely accused of using the wrong local VAT rate');

update public.suppliers set country_code = 'IL', default_currency = 'ILS'
where id = '4a290000-0000-4000-8000-000000000001';

-- ===== 7. A document with no order is still assessable, and says what it lacks =====

select pg_temp.p29_assert(
  (select (r -> 'sources' ->> 'document')::boolean = true
          and (r -> 'sources' ->> 'ordered')::boolean = false
          and (r -> 'sources' ->> 'received')::boolean = false
          and (r -> 'sources' ->> 'baseline')::boolean = true
   from pg_temp.p29_assess(pg_temp.p29_line('SKU-MEAT', '2', 'kg', '20', '40'),
                           '{}'::jsonb, null, date '2026-06-15') r),
  'the assessment did not state which of the four sources it actually had. A screen that cannot '
  'tell an absent source from a zero will print a fabricated zero');

select pg_temp.p29_assert(
  (select r -> 'totals' ->> 'lines_net' is null
          and (r -> 'sources' ->> 'document')::boolean = false
   from pg_temp.p29_assess('[]'::jsonb, '{}'::jsonb, null, date '2026-06-15') r),
  'a document with no readable lines reported a total of zero rather than nothing at all');

-- ===== 8. Tenancy =====

select pg_temp.p29_assert(
  (select (r -> 'sources' ->> 'baseline')::boolean = false
          and pg_temp.p29_finding(r, 'product_unidentified') is not null
   from pg_temp.p29_assess(pg_temp.p29_line('SKU-MEAT', '2', 'kg', '20', '40'),
                           '{}'::jsonb, null, date '2026-06-15', 'invoice',
                           '4a290000-0000-4000-8000-000000000001',
                           '1a290000-0000-4000-8000-000000000002') r),
  'read as another tenant, our supplier''s SKU still resolved to our product and our price list');

select pg_temp.p29_assert(
  (select (r -> 'sources' ->> 'ordered')::boolean = false
   from pg_temp.p29_assess(pg_temp.p29_line('SKU-MEAT', '2', 'kg', '20', '40'),
                           '{}'::jsonb, '5a290000-0000-4000-8000-000000000001',
                           date '2026-06-15', 'invoice',
                           '4a290000-0000-4000-8000-000000000001',
                           '1a290000-0000-4000-8000-000000000002') r),
  'an order id from another org was read by passing that org''s id alongside it');

-- ===== 9. Assessing is a read, and blocking is an answer rather than an action =====

create temp table p29_before as
  select (select count(*) from public.invoices) as invoices,
         (select count(*) from public.goods_receipts) as receipts,
         (select count(*) from public.price_history) as prices,
         (select count(*) from public.supplier_products) as supplier_products,
         (select coalesce(sum(received_qty), 0) from public.purchase_order_items) as received;

select pg_temp.p29_assess(pg_temp.p29_line('SKU-MEAT', '12', 'kg', '99', '1188'),
                          jsonb_build_object('invoice_number', 'INV-4471'),
                          '5a290000-0000-4000-8000-000000000001', date '2026-06-15');

select pg_temp.p29_assert(
  (select b.invoices = (select count(*) from public.invoices)
          and b.receipts = (select count(*) from public.goods_receipts)
          and b.prices = (select count(*) from public.price_history)
          and b.supplier_products = (select count(*) from public.supplier_products)
          and b.received = (select coalesce(sum(received_qty), 0)
                            from public.purchase_order_items)
   from p29_before b),
  'assessing a document changed something. THE PRICE LIST IN PARTICULAR IS THE CONTRACTUAL '
  'BASELINE AND IS NEVER UPDATED FROM A DOCUMENT (OPEN-DECISIONS #144) -- if a document could '
  'move the baseline, every overcharge would erase the evidence of itself');

select pg_temp.p29_assert(
  (select (r ->> 'approval_blocked')::boolean = true and r ->> 'severity' = 'critical'
   from pg_temp.p29_assess(pg_temp.p29_line('SKU-MEAT', '12', 'kg', '99', '1188'),
                           jsonb_build_object('invoice_number', 'INV-4471'),
                           '5a290000-0000-4000-8000-000000000001', date '2026-06-15') r),
  'a document with a duplicate number, a price far above baseline and a quantity above the order '
  'did not block approval');

-- ===== 10. The browser cannot reach any of it =====

select pg_temp.p29_assert(
  not has_schema_privilege('authenticated', 'private', 'usage')
  and not has_function_privilege(
        'authenticated',
        'private.document_reconciliation_assessment(uuid, text, uuid, uuid, jsonb, date)',
        'execute'),
  'a client role can reach the assessment, which takes org_id as an argument and would trust '
  'whatever a browser passed');

-- ===== 11. DEBT §35 -- the document is measured against what the order has LEFT =====
--
-- 0284. The gate above compares a documented line against `purchase_order_items.qty`, the quantity
-- ORDERED. It never asked how much of that same item earlier APPROVED invoices already consumed,
-- so a second document could claim a quantity the order no longer had -- and be told so only three
-- screens later, when `record_invoice_line_evidence` refused the approval. The money was never
-- wrong; the person was told too late, on a screen whose whole purpose is deciding.
--
-- There is exactly ONE definition of "consumed" and this suite holds it to that: the immutable
-- approval snapshots of 0099, latest revision per invoice, released by an owner reversal under
-- 0174. No running total, no cache, no recount from live invoice lines.

insert into auth.users (id, email) values
  ('2a290000-0000-4000-8000-000000000001', 'p29-owner@example.test');
insert into public.profiles (id, org_id, full_name, role) values
  ('2a290000-0000-4000-8000-000000000001', '1a290000-0000-4000-8000-000000000001',
   'P29 owner', 'owner');

-- One earlier invoice of this supplier, approved over 8 kg of the 10 kg ordered.
insert into public.invoices
  (id, org_id, supplier_id, invoice_number, invoice_date, total_amount) values
  ('6a290000-0000-4000-8000-000000000001', '1a290000-0000-4000-8000-000000000001',
   '4a290000-0000-4000-8000-000000000001', 'INV-P29-PRIOR', '2026-06-12', 160);

select set_config('app.invoice_three_way_writer', 'approval_snapshot', true);
insert into public.invoice_three_way_approval_snapshots
  (id, org_id, invoice_id, revision, assessment_hash, assessment, approved_by) values
  ('6a290000-0000-4000-8000-000000000011', '1a290000-0000-4000-8000-000000000001',
   '6a290000-0000-4000-8000-000000000001', 1, repeat('c', 64),
   '{"order_items":[{"purchase_order_item_id":"8a290000-0000-4000-8000-000000000001","current_invoice_quantity":8,"unit_resolved":true}]}',
   '2a290000-0000-4000-8000-000000000001');
select set_config('app.invoice_three_way_writer', '', true);

-- 3 kg is below the 10 ordered and below the 6 received, so every comparison that existed before
-- this migration stays silent. Only the remainder -- 10 minus the 8 an approval already took --
-- makes it an overrun, and the tolerance on a kg line is 0.2.
select pg_temp.p29_assert(
  (select (f ->> 'remaining_ordered_quantity')::numeric = 2
          and (f ->> 'prior_approved_invoiced_quantity')::numeric = 8
          and f ->> 'severity' = 'error'
   from pg_temp.p29_finding(
     pg_temp.p29_assess(pg_temp.p29_line('SKU-MEAT', '3', 'kg', '20', '60'),
                        '{}'::jsonb, '5a290000-0000-4000-8000-000000000001', date '2026-06-15'),
     'quantity_above_remaining_ordered') f),
  'a document claimed 3 kg of an order item an approved invoice had already reduced to 2, and the '
  'document gate reported nothing. The refusal still comes at final approval, so no money moves -- '
  'but the reviewer decides at THIS screen, and a gate that stays silent about a known overrun '
  'teaches them the assessment does not mean what it says');

select pg_temp.p29_assert(
  (select (r ->> 'approval_blocked')::boolean = true
   from pg_temp.p29_assess(pg_temp.p29_line('SKU-MEAT', '3', 'kg', '20', '60'),
                           '{}'::jsonb, '5a290000-0000-4000-8000-000000000001',
                           date '2026-06-15') r),
  'exceeding the remaining ordered quantity was reported but did not block approval');

-- The rung ABOVE it still outranks it: 12 kg is above the whole order, and that is the stronger
-- and more specific claim. Reporting both would be two findings for one fact.
select pg_temp.p29_assert(
  (select pg_temp.p29_finding(r, 'quantity_above_ordered') is not null
          and pg_temp.p29_finding(r, 'quantity_above_remaining_ordered') is null
   from pg_temp.p29_assess(pg_temp.p29_line('SKU-MEAT', '12', 'kg', '20', '240'),
                           '{}'::jsonb, '5a290000-0000-4000-8000-000000000001',
                           date '2026-06-15') r),
  'a quantity above the WHOLE order was also reported as above the remainder. One fact, one '
  'finding, and the stronger claim wins');

-- 2 kg is exactly the remainder. A gate that fired here would block every legitimate second
-- document and force the exception path onto work that is entirely in order.
select pg_temp.p29_assert(
  (select pg_temp.p29_finding(r, 'quantity_above_remaining_ordered') is null
   from pg_temp.p29_assess(pg_temp.p29_line('SKU-MEAT', '2', 'kg', '20', '40'),
                           '{}'::jsonb, '5a290000-0000-4000-8000-000000000001',
                           date '2026-06-15') r),
  'a document for exactly the remaining quantity was refused');

-- §29/0174: an owner reversal RELEASES the consumed quantity. If the document gate read
-- consumption from anywhere other than the snapshots -- a stored total, a recount from invoice
-- lines -- the reversal would change what the invoice REPORTS while this screen stayed barred.
select set_config('app.invoice_three_way_writer', 'approval_snapshot_reversal', true);
update public.invoice_three_way_approval_snapshots
   set reversed_at = now(), reversed_by = '2a290000-0000-4000-8000-000000000001',
       reversal_reason = 'P29 reversal'
 where id = '6a290000-0000-4000-8000-000000000011';
select set_config('app.invoice_three_way_writer', '', true);

select pg_temp.p29_assert(
  (select pg_temp.p29_finding(r, 'quantity_above_remaining_ordered') is null
   from pg_temp.p29_assess(pg_temp.p29_line('SKU-MEAT', '3', 'kg', '20', '60'),
                           '{}'::jsonb, '5a290000-0000-4000-8000-000000000001',
                           date '2026-06-15') r),
  'an owner reversed the approval that consumed the quantity, and the document gate still counted '
  'it. A reversal that releases capacity for the invoice path but not for the document path is a '
  'second accumulator wearing the name of the first');

-- An earlier approval whose unit could not be resolved makes the remainder UNKNOWN. The
-- constitution is explicit: a figure with no data is not zero, because zero is also a claim.
insert into public.invoices
  (id, org_id, supplier_id, invoice_number, invoice_date, total_amount) values
  ('6a290000-0000-4000-8000-000000000002', '1a290000-0000-4000-8000-000000000001',
   '4a290000-0000-4000-8000-000000000001', 'INV-P29-UNRESOLVED', '2026-06-13', 40);
select set_config('app.invoice_three_way_writer', 'approval_snapshot', true);
insert into public.invoice_three_way_approval_snapshots
  (id, org_id, invoice_id, revision, assessment_hash, assessment, approved_by) values
  ('6a290000-0000-4000-8000-000000000012', '1a290000-0000-4000-8000-000000000001',
   '6a290000-0000-4000-8000-000000000002', 1, repeat('d', 64),
   '{"order_items":[{"purchase_order_item_id":"8a290000-0000-4000-8000-000000000001","current_invoice_quantity":1,"unit_resolved":false}]}',
   '2a290000-0000-4000-8000-000000000001');
select set_config('app.invoice_three_way_writer', '', true);

select pg_temp.p29_assert(
  (select (x.f ->> 'severity') = 'error'
          and (r ->> 'approval_blocked')::boolean = true
          and x.f -> 'remaining_ordered_quantity' is null
   from pg_temp.p29_assess(pg_temp.p29_line('SKU-MEAT', '3', 'kg', '20', '60'),
                           '{}'::jsonb, '5a290000-0000-4000-8000-000000000001',
                           date '2026-06-15') r
   cross join lateral (select pg_temp.p29_finding(r, 'prior_invoiced_unit_unresolved')) x(f)),
  'a prior approval with an unresolvable unit was silently treated as consuming a comparable '
  'quantity. The remainder is UNKNOWN there, and a number the gate cannot stand behind is worse '
  'than a named refusal');

-- The two readers of prior consumption must keep reading the same thing. This does not prove they
-- compute the same number on the same data -- it proves neither has quietly stopped reading the
-- snapshot field, or stopped honouring a reversal, which is how they would drift apart.
select pg_temp.p29_assert(
  (select position('current_invoice_quantity' in d.def) > 0
          and position('approval.reversed_at is null' in d.def) > 0
   from (select replace(pg_get_functiondef(
           'private.invoice_three_way_raw(uuid,uuid)'::regprocedure), e'\r', '') as def) d),
  'private.invoice_three_way_raw no longer reads consumption from the approval snapshot, or no '
  'longer honours a reversal, so it and private.order_item_prior_invoiced now answer "how much was '
  'consumed" from different places');

select pg_temp.p29_assert(
  not has_function_privilege(
        'authenticated',
        'private.order_item_prior_invoiced(uuid, uuid, uuid, uuid)',
        'execute'),
  'a client role can reach the consumption reader, which takes org_id as an argument and would '
  'trust whatever a browser passed');

rollback;
