-- P81 -- payment requests and bank settlement stay inside one currency at every comparison.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p81_assert(p_condition boolean,p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition,false) then
    raise exception 'P81 multi-currency payment assertion failed: %',p_message;
  end if;
end
$$;

create function pg_temp.p81_act(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub',p_user::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
end
$$;

insert into public.organizations(id,name,status,vat_rate,base_currency,country_code,settings)
values('10810000-0000-4000-8000-000000000001','P81 org','active',18,'ILS','IL',
  jsonb_build_object('bank_match_amount_tolerance',1));
select id as legal_entity from public.org_units
where org_id='10810000-0000-4000-8000-000000000001' and unit_type='legal_entity'
order by created_at,id limit 1 \gset p81_

insert into auth.users(id,email) values
('20810000-0000-4000-8000-000000000001','owner-p81@example.test'),
('20810000-0000-4000-8000-000000000002','accountant-p81@example.test');
insert into public.profiles(id,org_id,full_name,role) values
('20810000-0000-4000-8000-000000000001','10810000-0000-4000-8000-000000000001','P81 owner','owner'),
('20810000-0000-4000-8000-000000000002','10810000-0000-4000-8000-000000000001','P81 accountant','accountant');
insert into public.suppliers(id,org_id,name,status,default_currency,country_code) values
('40810000-0000-4000-8000-000000000001','10810000-0000-4000-8000-000000000001','P81 supplier A','active','USD','US'),
('40810000-0000-4000-8000-000000000002','10810000-0000-4000-8000-000000000001','P81 supplier B','active','USD','US');

insert into public.invoices(
  id,org_id,unit_id,supplier_id,invoice_number,invoice_date,
  amount_before_vat,vat_amount,total_amount,review_status,payment_status,currency
) values
('60810000-0000-4000-8000-000000000001','10810000-0000-4000-8000-000000000001',:'p81_legal_entity','40810000-0000-4000-8000-000000000001','USD-A1',current_date,100,0,100,'received','unpaid','USD'),
('60810000-0000-4000-8000-000000000002','10810000-0000-4000-8000-000000000001',:'p81_legal_entity','40810000-0000-4000-8000-000000000001','USD-A2',current_date,200,0,200,'received','unpaid','USD'),
('60810000-0000-4000-8000-000000000003','10810000-0000-4000-8000-000000000001',:'p81_legal_entity','40810000-0000-4000-8000-000000000001','ILS-A',current_date,50,0,50,'received','unpaid','ILS'),
('60810000-0000-4000-8000-000000000004','10810000-0000-4000-8000-000000000001',:'p81_legal_entity','40810000-0000-4000-8000-000000000002','USD-B',current_date,80,0,80,'received','unpaid','USD'),
('60810000-0000-4000-8000-000000000005','10810000-0000-4000-8000-000000000001',:'p81_legal_entity','40810000-0000-4000-8000-000000000002','ILS-B',current_date,20,0,20,'received','unpaid','ILS'),
('60810000-0000-4000-8000-000000000006','10810000-0000-4000-8000-000000000001',:'p81_legal_entity','40810000-0000-4000-8000-000000000001','USD-BANK',current_date,3100,0,3100,'received','unpaid','USD');

set local role authenticated;
select pg_temp.p81_act('20810000-0000-4000-8000-000000000001');
select public.set_invoice_review_status(id,'in_review','P81 enters review')
from public.invoices where org_id='10810000-0000-4000-8000-000000000001' order by id;
select public.set_invoice_review_status(id,'approved','P81 approved fixture')
from public.invoices where org_id='10810000-0000-4000-8000-000000000001' order by id;

select public.create_payment_request(
  '70810000-0000-4000-8000-000000000001','40810000-0000-4000-8000-000000000001',
  current_date+7,null,'pending_approval',
  '[{"invoice_id":"60810000-0000-4000-8000-000000000001","amount":100},'
   '{"invoice_id":"60810000-0000-4000-8000-000000000002","amount":200}]'::jsonb,
  'P81 USD request');

select pg_temp.p81_assert(
  (select currency='USD' and amount=300 from public.payment_requests
   where id='70810000-0000-4000-8000-000000000001')
  and (select count(*)=2 and bool_and(currency='USD') from public.payment_request_invoices
       where payment_request_id='70810000-0000-4000-8000-000000000001'),
  'a request built from USD invoices did not carry USD through its row and allocations');

do $$
begin
  perform public.create_payment_request(
    '70810000-0000-4000-8000-000000000002','40810000-0000-4000-8000-000000000001',
    current_date+7,null,'pending_approval',
    '[{"invoice_id":"60810000-0000-4000-8000-000000000001","amount":100},'
     '{"invoice_id":"60810000-0000-4000-8000-000000000003","amount":50}]'::jsonb,
    'P81 mixed request refusal');
  raise exception 'P81 multi-currency payment assertion failed: mixed request accepted';
exception when sqlstate '22023' then
  if sqlerrm<>'payment_request_currency_mixed' then raise; end if;
end
$$;

reset role;
insert into public.credit_requests(id,org_id,supplier_id,invoice_id,reason,amount,status,created_by,currency) values
('80810000-0000-4000-8000-000000000001','10810000-0000-4000-8000-000000000001','40810000-0000-4000-8000-000000000001','60810000-0000-4000-8000-000000000001','other',25,'received','20810000-0000-4000-8000-000000000001','USD'),
('80810000-0000-4000-8000-000000000002','10810000-0000-4000-8000-000000000001','40810000-0000-4000-8000-000000000001','60810000-0000-4000-8000-000000000003','other',50,'received','20810000-0000-4000-8000-000000000001','ILS'),
('80810000-0000-4000-8000-000000000003','10810000-0000-4000-8000-000000000001','40810000-0000-4000-8000-000000000002','60810000-0000-4000-8000-000000000005','other',20,'received','20810000-0000-4000-8000-000000000001','ILS');
set local role authenticated;
select pg_temp.p81_act('20810000-0000-4000-8000-000000000001');

select public.approve_payment_request_with_credit_override(
  '70810000-0000-4000-8000-000000000001','40810000-0000-4000-8000-000000000001',
  25,'P81 USD credit override only');
select pg_temp.p81_assert(
  (select currency='USD' and open_credit_override_total=25
   from public.payment_requests where id='70810000-0000-4000-8000-000000000001'),
  'override total included an ILS credit or lost the request currency');

select public.create_payment_request(
  '70810000-0000-4000-8000-000000000003','40810000-0000-4000-8000-000000000002',
  current_date+7,null,'pending_approval',
  '[{"invoice_id":"60810000-0000-4000-8000-000000000004","amount":80}]'::jsonb,
  'P81 USD request with only ILS credit');
select public.transition_payment_request(
  '70810000-0000-4000-8000-000000000003','approved','P81 plain approval ignores ILS credit');
select pg_temp.p81_assert(
  (select status='approved' and open_credit_override_total is null
   from public.payment_requests where id='70810000-0000-4000-8000-000000000003'),
  'a credit in another currency blocked plain approval or was recorded as an override');

select public.create_payment_request(
  '70810000-0000-4000-8000-000000000004','40810000-0000-4000-8000-000000000001',
  current_date+7,null,'pending_approval',
  '[{"invoice_id":"60810000-0000-4000-8000-000000000006","amount":3100}]'::jsonb,
  'P81 request paid from another account currency');
select public.approve_payment_request_with_credit_override(
  '70810000-0000-4000-8000-000000000004','40810000-0000-4000-8000-000000000001',
  25,'P81 settlement request override');

select pg_temp.p81_act('20810000-0000-4000-8000-000000000002');
select set_config('request.jwt.claims',jsonb_build_object(
  'sub','20810000-0000-4000-8000-000000000002','role','authenticated','amr',
  jsonb_build_array(jsonb_build_object('method','password','timestamp',extract(epoch from now())::bigint)))::text,true);
select public.execute_payment_request(
  p_payment_request_id=>'70810000-0000-4000-8000-000000000004',
  p_paid_date=>current_date,p_method=>'bank',p_reference=>'P81-SETTLEMENT',p_notes=>null,
  p_allocations=>'[{"invoice_id":"60810000-0000-4000-8000-000000000006","credit_id":null,"amount":3100}]'::jsonb,
  p_settlement_amount=>11470,p_settlement_currency=>'ILS',p_reason=>'P81 executed with settlement');

reset role;
insert into public.bank_imports(id,org_id,filename,file_hash,column_mapping,row_count,imported_by,currency) values
('90810000-0000-4000-8000-000000000001','10810000-0000-4000-8000-000000000001','p81.csv','p81-hash','{}',2,'20810000-0000-4000-8000-000000000002','ILS');
insert into public.bank_transactions(
  id,org_id,import_id,tx_date,description,amount,is_debit,reference,raw,row_hash,currency
) values
('a0810000-0000-4000-8000-000000000001','10810000-0000-4000-8000-000000000001','90810000-0000-4000-8000-000000000001',current_date,'P81 settlement',11470,true,'P81-SETTLEMENT','{}','p81-row-1','ILS'),
('a0810000-0000-4000-8000-000000000002','10810000-0000-4000-8000-000000000001','90810000-0000-4000-8000-000000000001',current_date,'P81 direct mismatch',3100,true,'P81-DIRECT','{}','p81-row-2','ILS');
set local role authenticated;
select pg_temp.p81_act('20810000-0000-4000-8000-000000000001');

select public.match_bank_transaction(
  'a0810000-0000-4000-8000-000000000001','40810000-0000-4000-8000-000000000001',
  (select id from public.payments where payment_request_id='70810000-0000-4000-8000-000000000004'),
  null,null,1,'P81 settlement match');
select pg_temp.p81_assert(
  (select count(*)=1 and bool_and(currency='ILS') and bool_and(amount=11470)
   from public.bank_allocations where bank_transaction_id='a0810000-0000-4000-8000-000000000001'
     and payment_id=(select id from public.payments where payment_request_id='70810000-0000-4000-8000-000000000004'))
  and (select settlement_amount/amount=3.7 from public.payments
       where payment_request_id='70810000-0000-4000-8000-000000000004'),
  'bank settlement did not match in ILS while the invoice allocation remained USD');

do $$
begin
  perform public.match_bank_transaction(
    'a0810000-0000-4000-8000-000000000002','40810000-0000-4000-8000-000000000001',
    null,'b0810000-0000-4000-8000-000000000002',
    '[{"invoice_id":"60810000-0000-4000-8000-000000000006","amount":3100}]'::jsonb,
    1,'P81 direct currency mismatch');
  raise exception 'P81 multi-currency payment assertion failed: ILS bank row matched USD invoice directly';
exception when sqlstate '22023' then
  if sqlerrm<>'bank_match_currency_mismatch' then raise; end if;
end
$$;

select pg_temp.p81_assert(
  not exists(select 1 from information_schema.columns where table_schema='public'
    and table_name='payments' and column_name in ('exchange_rate','fx_rate')),
  'an FX rate was stored instead of being derived from settlement_amount / amount');

rollback;
