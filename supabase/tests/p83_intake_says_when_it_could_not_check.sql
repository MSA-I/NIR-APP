-- P83 -- a check that could not run says so, and a shekel business feels nothing.
--
-- 0227 made the intake arithmetic tolerances per-currency and correctly refused to invent one for
-- a currency nobody had configured. The clause it left behind reads
-- `if v_line_tolerance is not null and abs(...) > v_line_tolerance`, so the comparison was skipped
-- in silence: a dollar invoice with wrong line arithmetic produced no finding, and the review
-- screen showed a document that had passed every check it was given. It had not been given that
-- one. 0244 makes the skip visible without making it a gate (#293).
\set ON_ERROR_STOP on

begin;

create function pg_temp.p83_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P83 skipped-check assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p83_finding(p_assessment jsonb, p_code text)
returns jsonb language sql immutable as $$
  select f from jsonb_array_elements(p_assessment -> 'findings') f
  where f ->> 'code' = p_code limit 1;
$$;

/* One line whose arithmetic is deliberately WRONG: 2 x 100 should be 200 and the document says
   250. Whether that is reported is exactly what the tolerance decides. */
create function pg_temp.p83_payload(p_currency text default null)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'fields', case when p_currency is null then '[]'::jsonb
                   else jsonb_build_array(jsonb_build_object('key', 'currency', 'value', p_currency)) end,
    'line_items', jsonb_build_array(jsonb_build_object('values', jsonb_build_object(
      'sku', 'P83-SKU', 'quantity', '2', 'unit_price', '100', 'line_total', '250'))));
$$;

insert into public.organizations(id,name,status,vat_rate,base_currency,country_code,settings)
values('10830000-0000-4000-8000-000000000001','P83 org','active',18,'ILS','IL',
  jsonb_build_object('bank_match_amount_tolerance',1));

insert into public.suppliers(id,org_id,name,status,default_currency,country_code) values
('40830000-0000-4000-8000-000000000001','10830000-0000-4000-8000-000000000001','P83 supplier USD','active','USD','US'),
('40830000-0000-4000-8000-000000000002','10830000-0000-4000-8000-000000000001','P83 supplier ILS','active','ILS','IL');

/* The catalogue entries matter to this suite even though it is not about products: without them
   the document raises `product_unidentified` at severity error, `approval_blocked` is true for a
   reason that has nothing to do with currency, and the assertion below would be measuring the
   wrong rule. Each supplier's price is stated in that supplier's own currency (0217). */
insert into public.products(id,org_id,name,unit) values
('30830000-0000-4000-8000-000000000001','10830000-0000-4000-8000-000000000001','P83 מוצר','unit');
insert into public.supplier_products(id,org_id,supplier_id,product_id,current_price,supplier_sku,currency) values
('70830000-0000-4000-8000-000000000001','10830000-0000-4000-8000-000000000001',
 '40830000-0000-4000-8000-000000000001','30830000-0000-4000-8000-000000000001',100,'P83-SKU','USD'),
('70830000-0000-4000-8000-000000000002','10830000-0000-4000-8000-000000000001',
 '40830000-0000-4000-8000-000000000002','30830000-0000-4000-8000-000000000001',100,'P83-SKU','ILS');

-- ===== #294: a dollar document is checked automatically, exactly like a shekel one =====
-- Before 0245 this produced `amount_check_skipped_no_tolerance` and NO arithmetic finding, because
-- nobody had typed a dollar number. A business abroad had to configure the product before it would
-- read its own invoice — which is the friction #294 removes.
select pg_temp.p83_assert(
  pg_temp.p83_finding(private.document_reconciliation_assessment(
    '10830000-0000-4000-8000-000000000001','invoice',
    '40830000-0000-4000-8000-000000000001',null,pg_temp.p83_payload('USD'),current_date),
    'amount_check_skipped_no_tolerance') is null,
  'a dollar document still demands configuration before it can be checked');

select pg_temp.p83_assert(
  pg_temp.p83_finding(private.document_reconciliation_assessment(
    '10830000-0000-4000-8000-000000000001','invoice',
    '40830000-0000-4000-8000-000000000001',null,pg_temp.p83_payload('USD'),current_date),
    'line_arithmetic_discrepancy') is not null,
  '2 x 100 billed as 250 went unreported in dollars');

/* The derived thresholds ARE the shekel thresholds, read in each currency's own minor units:
   100 minor units for the bank, the request and the document total; 5 for a line. Nothing is
   converted — 100 cents is not "one shekel in dollars", it is a hundred cents (#294, #290). */
select pg_temp.p83_assert(
  private.money_tolerance('10830000-0000-4000-8000-000000000001','USD','invoice_line_amount_tolerance') = 0.05
  and private.money_tolerance('10830000-0000-4000-8000-000000000001','USD','bank_match_amount_tolerance') = 1,
  'the dollar thresholds are not 5 and 100 minor units');

-- The two shapes that would break an assumption of two decimals, which is why this reads the
-- `currencies` table rather than hard-coding a scale.
select pg_temp.p83_assert(
  private.money_tolerance('10830000-0000-4000-8000-000000000001','JPY','invoice_line_amount_tolerance') = 5
  and private.money_tolerance('10830000-0000-4000-8000-000000000001','JPY','invoice_document_amount_tolerance') = 100,
  'a zero-decimal currency did not derive whole yen');
select pg_temp.p83_assert(
  private.money_tolerance('10830000-0000-4000-8000-000000000001','KWD','invoice_document_amount_tolerance') = 0.100,
  'a three-decimal currency did not derive 100 minor units');

-- ===== A stated value still wins, and only for the currency it names =====
update public.organizations
set settings = settings
  || jsonb_build_object('invoice_line_amount_tolerance', jsonb_build_object('USD', 60))
where id = '10830000-0000-4000-8000-000000000001';

select pg_temp.p83_assert(
  private.money_tolerance('10830000-0000-4000-8000-000000000001','USD','invoice_line_amount_tolerance') = 60,
  'a stated dollar value lost to the derived default');
select pg_temp.p83_assert(
  private.money_tolerance('10830000-0000-4000-8000-000000000001','EUR','invoice_line_amount_tolerance') = 0.05,
  'stating a dollar value changed what another currency derives');

-- The line is out by 50 (2 x 100 is 200, the page says 250). Sixty dollars covers that, so the
-- finding goes away — the owner's number beating the product's, which is why the field stays.
select pg_temp.p83_assert(
  pg_temp.p83_finding(private.document_reconciliation_assessment(
    '10830000-0000-4000-8000-000000000001','invoice',
    '40830000-0000-4000-8000-000000000001',null,pg_temp.p83_payload('USD'),current_date),
    'line_arithmetic_discrepancy') is null,
  'a stated tolerance wide enough to cover the discrepancy did not silence it');

/* ===== "Cannot compare" survives for a currency the database cannot answer for =====
   #294 gives every KNOWN currency an answer; it does not replace the null path with a number.
   0232's refusal and 0244's finding have to stay reachable, or the honesty they carry is gone. */
update public.currencies set active = false where code = 'EUR';
select pg_temp.p83_assert(
  private.money_tolerance('10830000-0000-4000-8000-000000000001','EUR','invoice_line_amount_tolerance') is null,
  'a deactivated currency was still handed a derived tolerance');
select pg_temp.p83_assert(
  pg_temp.p83_finding(private.document_reconciliation_assessment(
    '10830000-0000-4000-8000-000000000001','invoice',
    '40830000-0000-4000-8000-000000000001',null,pg_temp.p83_payload('EUR'),current_date),
    'amount_check_skipped_no_tolerance') is not null,
  'a currency with no possible answer stopped saying so');
update public.currencies set active = true where code = 'EUR';

-- ===== The shekel business feels nothing, before or after #294 =====
-- The shekel derives exactly what 0227 hard-coded for it: 0.05 and 1. An existing Israeli
-- business must not be able to tell that 0245 ran.
select pg_temp.p83_assert(
  pg_temp.p83_finding(private.document_reconciliation_assessment(
    '10830000-0000-4000-8000-000000000001','invoice',
    '40830000-0000-4000-8000-000000000002',null,pg_temp.p83_payload(null),current_date),
    'amount_check_skipped_no_tolerance') is null,
  'a shekel document from a shekel supplier gained a new finding — the Israeli business felt this');

select pg_temp.p83_assert(
  pg_temp.p83_finding(private.document_reconciliation_assessment(
    '10830000-0000-4000-8000-000000000001','invoice',
    '40830000-0000-4000-8000-000000000002',null,pg_temp.p83_payload(null),current_date),
    'line_arithmetic_discrepancy') is not null,
  'the shekel line arithmetic check stopped firing');

-- The unreadable-currency refusal of 0227 is a different rule and must survive the patch.
select pg_temp.p83_assert(
  pg_temp.p83_finding(private.document_reconciliation_assessment(
    '10830000-0000-4000-8000-000000000001','invoice',
    '40830000-0000-4000-8000-000000000001',null,pg_temp.p83_payload('US0'),current_date),
    'currency_unrecognised') is not null,
  'an unreadable printed currency stopped being refused');

rollback;
