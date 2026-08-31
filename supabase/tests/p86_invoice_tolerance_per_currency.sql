-- P86 — ₪1 is not ¥1, and the invoice stopped pretending otherwise.
--
-- `private.invoice_three_way_raw` compared money against the literals `1` and `0.05` from `0099`
-- until `0259`. Those are shekel numbers. The document path stopped using them in `0227`, so from
-- that day the two halves of the same product disagreed about what "close enough" means, and any
-- screen that printed "the tolerance for this currency" beside an invoice would have been stating
-- something the server does not enforce.
--
-- What this suite proves is the pair of failures the literal caused, in both directions:
--
--   JPY has NO minor unit, so its ordinary threshold is 100 yen. A ¥50 header discrepancy is
--   pocket change and the old code raised an error on it.
--   KWD has THREE, so its threshold is 0.100 dinar. A 0.5-dinar discrepancy is five times the
--   tolerance and the old code let it through in silence.
--
-- And the third thing, which is the one that makes the change safe to ship: a SHEKEL business sees
-- exactly what it saw before. `money_tolerance` derives 100 minor units, and for ILS that is
-- literally 1 — the same number, arrived at from the currency rather than from a constant.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p86_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P86 invoice tolerance assertion failed: %', p_message;
  end if;
end
$$;

/* One reason out of the assessment, by code. */
create function pg_temp.p86_reason(p_raw jsonb, p_code text)
returns jsonb language sql immutable as $$
  select r from jsonb_array_elements(p_raw -> 'reasons') r
  where r ->> 'code' = p_code limit 1;
$$;

insert into public.organizations(id, name, status, vat_rate, base_currency, country_code)
values ('10860000-0000-4000-8000-000000000001', 'P86 org', 'active', 18, 'ILS', 'IL');

insert into public.suppliers(id, org_id, name, status, default_currency, country_code) values
('40860000-0000-4000-8000-000000000001', '10860000-0000-4000-8000-000000000001', 'P86 ILS', 'active', 'ILS', 'IL'),
('40860000-0000-4000-8000-000000000002', '10860000-0000-4000-8000-000000000001', 'P86 JPY', 'active', 'JPY', 'JP'),
('40860000-0000-4000-8000-000000000003', '10860000-0000-4000-8000-000000000001', 'P86 KWD', 'active', 'KWD', 'KW');

/* Header-only invoices: the identity `net + vat = total` is checked independently of any extracted
   line (0099:1258-1260), so it isolates the tolerance from every other rule on the screen.
   Each row states its own discrepancy in its own currency. */
insert into public.invoices
  (id, org_id, supplier_id, invoice_number, invoice_date, amount_before_vat, vat_amount, total_amount, currency) values
-- ILS, off by 0.50 — inside the shekel tolerance of 1, exactly as before 0259.
('f8600000-0000-4000-8000-000000000001', '10860000-0000-4000-8000-000000000001',
 '40860000-0000-4000-8000-000000000001', 'P86-ILS-OK', '2026-08-01', 100, 18, 117.50, 'ILS'),
-- ILS, off by 1.50 — outside it, exactly as before 0259.
('f8600000-0000-4000-8000-000000000002', '10860000-0000-4000-8000-000000000001',
 '40860000-0000-4000-8000-000000000001', 'P86-ILS-BAD', '2026-08-01', 100, 18, 119.50, 'ILS'),
-- JPY, off by 50 yen. Tolerance 100. The OLD literal would have raised an error on this.
('f8600000-0000-4000-8000-000000000003', '10860000-0000-4000-8000-000000000001',
 '40860000-0000-4000-8000-000000000002', 'P86-JPY-OK', '2026-08-01', 10000, 1800, 11750, 'JPY'),
-- JPY, off by 150 yen. Outside even the yen tolerance.
('f8600000-0000-4000-8000-000000000004', '10860000-0000-4000-8000-000000000001',
 '40860000-0000-4000-8000-000000000002', 'P86-JPY-BAD', '2026-08-01', 10000, 1800, 11950, 'JPY'),
-- KWD, off by 0.500 dinar. Tolerance 0.100. The OLD literal let this through in SILENCE.
('f8600000-0000-4000-8000-000000000005', '10860000-0000-4000-8000-000000000001',
 '40860000-0000-4000-8000-000000000003', 'P86-KWD-BAD', '2026-08-01', 100.000, 18.000, 118.500, 'KWD'),
-- KWD, off by 0.050 dinar. Inside it.
('f8600000-0000-4000-8000-000000000006', '10860000-0000-4000-8000-000000000001',
 '40860000-0000-4000-8000-000000000003', 'P86-KWD-OK', '2026-08-01', 100.000, 18.000, 118.050, 'KWD');

-- ---- 1. The shekel business feels nothing. --------------------------------------------------
select pg_temp.p86_assert(
  pg_temp.p86_reason(private.invoice_three_way_raw(
    '10860000-0000-4000-8000-000000000001', 'f8600000-0000-4000-8000-000000000001'),
    'invoice_header_arithmetic_discrepancy') is null,
  'ILS off by 0.50 must stay inside the shekel tolerance, as it did before 0259');

select pg_temp.p86_assert(
  pg_temp.p86_reason(private.invoice_three_way_raw(
    '10860000-0000-4000-8000-000000000001', 'f8600000-0000-4000-8000-000000000002'),
    'invoice_header_arithmetic_discrepancy') is not null,
  'ILS off by 1.50 must still be reported, as it was before 0259');

-- The number it publishes is the number it used, and for a shekel that is still 1.
select pg_temp.p86_assert(
  (pg_temp.p86_reason(private.invoice_three_way_raw(
    '10860000-0000-4000-8000-000000000001', 'f8600000-0000-4000-8000-000000000002'),
    'invoice_header_arithmetic_discrepancy') ->> 'tolerance')::numeric = 1,
  'the shekel reason must publish a tolerance of 1 — the same number, derived rather than typed');

-- ---- 2. The yen stops being judged by a shekel. ----------------------------------------------
select pg_temp.p86_assert(
  pg_temp.p86_reason(private.invoice_three_way_raw(
    '10860000-0000-4000-8000-000000000001', 'f8600000-0000-4000-8000-000000000003'),
    'invoice_header_arithmetic_discrepancy') is null,
  'a 50-yen discrepancy is inside the yen tolerance of 100 and must NOT be reported');

select pg_temp.p86_assert(
  (pg_temp.p86_reason(private.invoice_three_way_raw(
    '10860000-0000-4000-8000-000000000001', 'f8600000-0000-4000-8000-000000000004'),
    'invoice_header_arithmetic_discrepancy') ->> 'tolerance')::numeric = 100,
  'a yen invoice must be judged, and report itself judged, against 100');

-- ---- 3. The dinar stops slipping through. ----------------------------------------------------
select pg_temp.p86_assert(
  pg_temp.p86_reason(private.invoice_three_way_raw(
    '10860000-0000-4000-8000-000000000001', 'f8600000-0000-4000-8000-000000000005'),
    'invoice_header_arithmetic_discrepancy') is not null,
  'half a dinar is five times the dinar tolerance and must be reported — the old literal hid it');

select pg_temp.p86_assert(
  (pg_temp.p86_reason(private.invoice_three_way_raw(
    '10860000-0000-4000-8000-000000000001', 'f8600000-0000-4000-8000-000000000005'),
    'invoice_header_arithmetic_discrepancy') ->> 'tolerance')::numeric = 0.1,
  'a dinar invoice must report the dinar tolerance of 0.100');

select pg_temp.p86_assert(
  pg_temp.p86_reason(private.invoice_three_way_raw(
    '10860000-0000-4000-8000-000000000001', 'f8600000-0000-4000-8000-000000000006'),
    'invoice_header_arithmetic_discrepancy') is null,
  '0.05 dinar is inside the dinar tolerance and must not be reported');

-- ---- 4. The totals block names the tolerances AND the currency they belong to. ---------------
select pg_temp.p86_assert(
  (private.invoice_three_way_raw(
    '10860000-0000-4000-8000-000000000001', 'f8600000-0000-4000-8000-000000000003')
   -> 'totals' ->> 'invoice_tolerance')::numeric = 100
  and (private.invoice_three_way_raw(
    '10860000-0000-4000-8000-000000000001', 'f8600000-0000-4000-8000-000000000003')
   -> 'totals' ->> 'line_tolerance')::numeric = 5
  and private.invoice_three_way_raw(
    '10860000-0000-4000-8000-000000000001', 'f8600000-0000-4000-8000-000000000003')
   -> 'totals' ->> 'currency' = 'JPY',
  'the totals block must publish the tolerances it was judged by, and the currency they are in');

-- ---- 5. What the organisation states beats what the currency implies. -------------------------
update public.organizations
set settings = jsonb_build_object('invoice_document_amount_tolerance', jsonb_build_object('JPY', 500))
where id = '10860000-0000-4000-8000-000000000001';

select pg_temp.p86_assert(
  pg_temp.p86_reason(private.invoice_three_way_raw(
    '10860000-0000-4000-8000-000000000001', 'f8600000-0000-4000-8000-000000000004'),
    'invoice_header_arithmetic_discrepancy') is null,
  'a stated per-currency tolerance of 500 must absorb the 150-yen discrepancy the default reported');

update public.organizations set settings = '{}'::jsonb
where id = '10860000-0000-4000-8000-000000000001';

-- ---- 6. A tolerance that cannot be resolved is REPORTED, and never a gate. --------------------
-- `money_tolerance` returns null only where the database does not recognise the currency, so the
-- currency is deactivated after the invoice exists. Silence here would be the worse answer: an
-- invoice nobody could check would look exactly like one that checked out (0244, #288, #293).
update public.currencies set active = false where code = 'KWD';

select pg_temp.p86_assert(
  pg_temp.p86_reason(private.invoice_three_way_raw(
    '10860000-0000-4000-8000-000000000001', 'f8600000-0000-4000-8000-000000000005'),
    'amount_check_skipped_no_tolerance') is not null,
  'an unresolvable tolerance must produce a finding rather than a silent pass');

select pg_temp.p86_assert(
  pg_temp.p86_reason(private.invoice_three_way_raw(
    '10860000-0000-4000-8000-000000000001', 'f8600000-0000-4000-8000-000000000005'),
    'amount_check_skipped_no_tolerance') ->> 'severity' = 'warning',
  'the finding is a warning: #293 refused to make a business unable to see its own invoice');

select pg_temp.p86_assert(
  not (private.invoice_three_way_raw(
    '10860000-0000-4000-8000-000000000001', 'f8600000-0000-4000-8000-000000000005')
    ->> 'approval_blocked')::boolean,
  'a missing tolerance must not block approval');

select pg_temp.p86_assert(
  pg_temp.p86_reason(private.invoice_three_way_raw(
    '10860000-0000-4000-8000-000000000001', 'f8600000-0000-4000-8000-000000000005'),
    'invoice_header_arithmetic_discrepancy') is null,
  'with no tolerance there is no comparison, so the arithmetic reason must not be invented either');

update public.currencies set active = true where code = 'KWD';

-- ---- 7. The rate tolerance is NOT money and did not move. -------------------------------------
-- `vat_rate_mismatch` publishes `'tolerance', 0`, which bounds a RATE. A replacement that swept it
-- up would have changed that rule while every currency assertion above still passed.
select pg_temp.p86_assert(
  position('''tolerance'', 0,' in pg_get_functiondef(
    'private.invoice_three_way_raw(uuid, uuid)'::regprocedure)) > 0,
  'the vat_rate_mismatch rate tolerance must survive 0259 untouched');

select 'P86_invoice_tolerance_per_currency_passed' as result;

rollback;
