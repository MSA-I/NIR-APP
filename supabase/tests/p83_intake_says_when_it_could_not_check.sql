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

-- ===== P5-G1: a dollar document with no dollar tolerance enters, and says it was not checked =====
select pg_temp.p83_assert(
  pg_temp.p83_finding(private.document_reconciliation_assessment(
    '10830000-0000-4000-8000-000000000001','invoice',
    '40830000-0000-4000-8000-000000000001',null,pg_temp.p83_payload('USD'),current_date),
    'amount_check_skipped_no_tolerance') is not null,
  'a dollar document with no dollar tolerance produced no finding — the skip is still silent');

select pg_temp.p83_assert(
  pg_temp.p83_finding(private.document_reconciliation_assessment(
    '10830000-0000-4000-8000-000000000001','invoice',
    '40830000-0000-4000-8000-000000000001',null,pg_temp.p83_payload('USD'),current_date),
    'amount_check_skipped_no_tolerance') ->> 'severity' = 'warning',
  'the skipped-check finding is not a warning');

-- #293: the document ENTERS. Blocking would mean a business cannot see its own invoice until
-- somebody visits a settings screen.
select pg_temp.p83_assert(
  (private.document_reconciliation_assessment(
    '10830000-0000-4000-8000-000000000001','invoice',
    '40830000-0000-4000-8000-000000000001',null,pg_temp.p83_payload('USD'),current_date)
   ->> 'approval_blocked')::boolean is false,
  'a missing tolerance blocked approval; #293 says the document enters and warns');

-- The arithmetic itself is genuinely NOT reported, which is the honest half: the product does not
-- claim a comparison it could not make.
select pg_temp.p83_assert(
  pg_temp.p83_finding(private.document_reconciliation_assessment(
    '10830000-0000-4000-8000-000000000001','invoice',
    '40830000-0000-4000-8000-000000000001',null,pg_temp.p83_payload('USD'),current_date),
    'line_arithmetic_discrepancy') is null,
  'the line arithmetic was reported without a tolerance to compare against');

-- ===== P5-G2: state the tolerance, and the check runs =====
update public.organizations
set settings = settings
  || jsonb_build_object('invoice_line_amount_tolerance', jsonb_build_object('USD', 0.05))
  || jsonb_build_object('invoice_document_amount_tolerance', jsonb_build_object('USD', 1))
where id = '10830000-0000-4000-8000-000000000001';

select pg_temp.p83_assert(
  pg_temp.p83_finding(private.document_reconciliation_assessment(
    '10830000-0000-4000-8000-000000000001','invoice',
    '40830000-0000-4000-8000-000000000001',null,pg_temp.p83_payload('USD'),current_date),
    'amount_check_skipped_no_tolerance') is null,
  'the skipped-check finding survived a tolerance being stated');

select pg_temp.p83_assert(
  pg_temp.p83_finding(private.document_reconciliation_assessment(
    '10830000-0000-4000-8000-000000000001','invoice',
    '40830000-0000-4000-8000-000000000001',null,pg_temp.p83_payload('USD'),current_date),
    'line_arithmetic_discrepancy') is not null,
  '2 x 100 billed as 250 went unreported once a dollar tolerance existed');

-- A stated tolerance answers for ONE currency. The euro is still unconfigured and still says so.
select pg_temp.p83_assert(
  pg_temp.p83_finding(private.document_reconciliation_assessment(
    '10830000-0000-4000-8000-000000000001','invoice',
    '40830000-0000-4000-8000-000000000001',null,pg_temp.p83_payload('EUR'),current_date),
    'amount_check_skipped_no_tolerance') is not null,
  'a dollar tolerance silenced the warning for euros as well');

-- ===== P5-G3: the shekel business feels nothing =====
-- 0227's ILS fallbacks (0.05 and 1) are still in force, so nothing about this document changes.
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
