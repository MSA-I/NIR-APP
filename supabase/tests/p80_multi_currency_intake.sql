-- P80 -- currency crosses the intake boundary as data, never as a display default.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p80_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P80 multi-currency intake assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p80_act(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
end
$$;

insert into public.organizations (
  id, name, status, vat_rate, base_currency, country_code
) values (
  '10800000-0000-4000-8000-000000000001', 'P80 org', 'active', 18, 'ILS', 'IL'
);

insert into auth.users (id, email) values
  ('20800000-0000-4000-8000-000000000001', 'owner-p80@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('20800000-0000-4000-8000-000000000001',
   '10800000-0000-4000-8000-000000000001', 'P80 owner', 'owner');

insert into public.suppliers (
  id, org_id, name, status, default_currency, country_code
) values (
  '40800000-0000-4000-8000-000000000001',
  '10800000-0000-4000-8000-000000000001', 'P80 foreign supplier', 'active', 'USD', 'US'
);

insert into public.purchase_orders (
  id, org_id, supplier_id, status, currency
) values (
  '50800000-0000-4000-8000-000000000001',
  '10800000-0000-4000-8000-000000000001',
  '40800000-0000-4000-8000-000000000001', 'sent', 'ILS'
);

set local role authenticated;
select pg_temp.p80_act('20800000-0000-4000-8000-000000000001');

select public.create_invoice(
  p_invoice_id => '60800000-0000-4000-8000-000000000001',
  p_supplier_id => '40800000-0000-4000-8000-000000000001',
  p_currency => 'USD',
  p_invoice_number => 'SAME-80',
  p_invoice_date => date '2026-08-28',
  p_amount_before_vat => 100,
  p_vat_amount => 0,
  p_total_amount => 100,
  p_notes => null,
  p_order_id => null,
  p_receipt_id => null,
  p_override_reason => null,
  p_reason => 'P80 USD invoice'
);

select pg_temp.p80_assert(
  (select currency = 'USD' from public.invoices
   where id = '60800000-0000-4000-8000-000000000001'),
  'create_invoice did not store the chosen USD currency');

select public.create_invoice(
  p_invoice_id => '60800000-0000-4000-8000-000000000002',
  p_supplier_id => '40800000-0000-4000-8000-000000000001',
  p_currency => 'ILS',
  p_invoice_number => 'SAME-80',
  p_invoice_date => date '2026-08-28',
  p_amount_before_vat => 100,
  p_vat_amount => 0,
  p_total_amount => 100,
  p_notes => null,
  p_order_id => null,
  p_receipt_id => null,
  p_override_reason => null,
  p_reason => 'P80 same number in other currency'
);

select pg_temp.p80_assert(
  (select review_status = 'received' and currency = 'ILS'
   from public.invoices where id = '60800000-0000-4000-8000-000000000002'),
  'an invoice number in another currency was treated as this invoice''s duplicate');

do $$
begin
  perform public.create_invoice(
    p_invoice_id => '60800000-0000-4000-8000-000000000003',
    p_supplier_id => '40800000-0000-4000-8000-000000000001',
    p_currency => 'JPY',
    p_invoice_number => 'JPY-80',
    p_invoice_date => date '2026-08-28',
    p_amount_before_vat => 1000.50,
    p_vat_amount => 0,
    p_total_amount => 1000.50,
    p_notes => null,
    p_order_id => null,
    p_receipt_id => null,
    p_override_reason => null,
    p_reason => 'P80 JPY precision refusal');
  raise exception 'P80 multi-currency intake assertion failed: JPY accepted fractional minor units';
exception when sqlstate '22023' then
  if sqlerrm <> 'invoice_currency_precision_invalid' then raise; end if;
end
$$;

do $$
begin
  perform public.create_invoice(
    p_invoice_id => '60800000-0000-4000-8000-000000000004',
    p_supplier_id => '40800000-0000-4000-8000-000000000001',
    p_currency => 'US0',
    p_invoice_number => 'BAD-80',
    p_invoice_date => date '2026-08-28',
    p_amount_before_vat => 100,
    p_vat_amount => 0,
    p_total_amount => 100,
    p_notes => null,
    p_order_id => null,
    p_receipt_id => null,
    p_override_reason => null,
    p_reason => 'P80 invalid currency refusal');
  raise exception 'P80 multi-currency intake assertion failed: unrecognised currency accepted';
exception when sqlstate '22023' then
  if sqlerrm <> 'invoice_currency_invalid' then raise; end if;
end
$$;

do $$
begin
  perform public.create_invoice(
    p_invoice_id => '60800000-0000-4000-8000-000000000005',
    p_supplier_id => '40800000-0000-4000-8000-000000000001',
    p_currency => 'USD',
    p_invoice_number => 'ORDER-80',
    p_invoice_date => date '2026-08-28',
    p_amount_before_vat => 100,
    p_vat_amount => 0,
    p_total_amount => 100,
    p_notes => null,
    p_order_id => '50800000-0000-4000-8000-000000000001',
    p_receipt_id => null,
    p_override_reason => null,
    p_reason => 'P80 cross-currency order refusal');
  raise exception 'P80 multi-currency intake assertion failed: USD invoice linked to ILS order';
exception when sqlstate '22023' then
  if sqlerrm <> 'invoice_order_currency_mismatch' then raise; end if;
end
$$;

reset role;

select pg_temp.p80_assert(
  (select column_default is null
   from information_schema.columns
   where table_schema = 'public' and table_name = 'invoices' and column_name = 'currency'),
  'invoices.currency still has the temporary ILS default');

do $$
begin
  insert into public.invoices (
    id, org_id, supplier_id, invoice_number, invoice_date, total_amount
  ) values (
    '60800000-0000-4000-8000-000000000006',
    '10800000-0000-4000-8000-000000000001',
    '40800000-0000-4000-8000-000000000001',
    'MISSING-CURRENCY-80', date '2026-08-28', 100
  );
  raise exception 'P80 multi-currency intake assertion failed: an invoice without currency defaulted silently';
exception when not_null_violation then
  if position('currency' in sqlerrm) = 0 then raise; end if;
end
$$;

select pg_temp.p80_assert(
  to_regprocedure('public.create_invoice(uuid,uuid,text,date,numeric,numeric,numeric,text,uuid,uuid,text,text)') is null
  and to_regprocedure('public.create_invoice(uuid,uuid,text,text,date,numeric,numeric,numeric,text,uuid,uuid,text,text)') is not null,
  'the old no-currency create_invoice signature still exists or the new signature is missing');

rollback;
