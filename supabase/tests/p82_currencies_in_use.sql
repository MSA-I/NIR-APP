-- P82 -- currencies_in_use() answers the question #288 assumed somebody could already answer.
--
-- The screen that shows a currency as "needing a decision" needs a list of currencies to show. It
-- had none, and that is the whole reason three of four tolerances shipped unconfigurable. The two
-- properties that matter are here: the answer is HISTORY (#292), so a closed file still counts, and
-- the answer is ONE TENANT'S, which is RLS's job rather than the function's.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p82_assert(p_condition boolean,p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition,false) then
    raise exception 'P82 currencies-in-use assertion failed: %',p_message;
  end if;
end
$$;

create function pg_temp.p82_act(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub',p_user::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
end
$$;

insert into public.organizations(id,name,status,vat_rate,base_currency,country_code,settings)
values
('10820000-0000-4000-8000-000000000001','P82 org A','active',18,'ILS','IL',
  jsonb_build_object('bank_match_amount_tolerance',1)),
('10820000-0000-4000-8000-000000000002','P82 org B','active',18,'ILS','IL',
  jsonb_build_object('bank_match_amount_tolerance',1));

select id as unit_a from public.org_units
where org_id='10820000-0000-4000-8000-000000000001' and unit_type='legal_entity'
order by created_at,id limit 1 \gset p82_
select id as unit_b from public.org_units
where org_id='10820000-0000-4000-8000-000000000002' and unit_type='legal_entity'
order by created_at,id limit 1 \gset p82_

insert into auth.users(id,email) values
('20820000-0000-4000-8000-000000000001','owner-a-p82@example.test'),
('20820000-0000-4000-8000-000000000002','owner-b-p82@example.test'),
('20820000-0000-4000-8000-000000000003','retired-p82@example.test');
insert into public.profiles(id,org_id,full_name,role) values
('20820000-0000-4000-8000-000000000001','10820000-0000-4000-8000-000000000001','P82 owner A','owner'),
('20820000-0000-4000-8000-000000000002','10820000-0000-4000-8000-000000000002','P82 owner B','owner'),
('20820000-0000-4000-8000-000000000003','10820000-0000-4000-8000-000000000001','P82 retired','kitchen');

-- A supplier quoted in euros before a single euro document exists. This is the row that lets an
-- owner state the tolerance BEFORE meeting the refusal, which is the point of #293.
insert into public.suppliers(id,org_id,name,status,default_currency,country_code) values
('40820000-0000-4000-8000-000000000001','10820000-0000-4000-8000-000000000001','P82 supplier EUR','active','EUR','DE'),
('40820000-0000-4000-8000-000000000002','10820000-0000-4000-8000-000000000002','P82 supplier B','active','ILS','IL');

insert into public.invoices(
  id,org_id,unit_id,supplier_id,invoice_number,invoice_date,
  amount_before_vat,vat_amount,total_amount,review_status,payment_status,currency,deleted_at
) values
-- Soft-deleted on purpose: #292 says a closed file is still a currency this business has handled.
('60820000-0000-4000-8000-000000000001','10820000-0000-4000-8000-000000000001',:'p82_unit_a',
 '40820000-0000-4000-8000-000000000001','P82-USD-GONE',current_date,100,0,100,'received','unpaid','USD',now()),
('60820000-0000-4000-8000-000000000002','10820000-0000-4000-8000-000000000002',:'p82_unit_b',
 '40820000-0000-4000-8000-000000000002','P82-JPY-B',current_date,1000,0,1000,'received','unpaid','JPY',null);

set local role authenticated;
select pg_temp.p82_act('20820000-0000-4000-8000-000000000001');

-- P2-G1: history, not open balance. The USD invoice is soft-deleted and USD is still listed.
select pg_temp.p82_assert(
  exists(select 1 from public.currencies_in_use() where currency='USD'),
  'a soft-deleted USD invoice removed USD from the list; #292 asks for history, not open balance');

select pg_temp.p82_assert(
  (select sources from public.currencies_in_use() where currency='USD') = array['invoice'],
  'USD did not name the surface it was seen on');

-- The base currency is in use by definition, and a supplier default counts before any money moves.
select pg_temp.p82_assert(
  exists(select 1 from public.currencies_in_use() where currency='ILS' and 'base_currency'=any(sources)),
  'the base currency was missing from the list');
select pg_temp.p82_assert(
  exists(select 1 from public.currencies_in_use() where currency='EUR' and 'supplier_default'=any(sources)),
  'a euro supplier default did not put EUR on the list, so the tolerance cannot be set in advance');

-- P2-G2: one tenant's answer. Org B's yen is invisible here, and RLS is what makes that true.
select pg_temp.p82_assert(
  not exists(select 1 from public.currencies_in_use() where currency='JPY'),
  'another organisation''s currency leaked into this one''s list');

select pg_temp.p82_assert(
  (select count(*) from public.currencies_in_use()) = 3,
  'the list held something other than exactly ILS, USD and EUR');

-- The other side of the same isolation: org B sees its own yen and none of org A's currencies.
select pg_temp.p82_act('20820000-0000-4000-8000-000000000002');
select pg_temp.p82_assert(
  exists(select 1 from public.currencies_in_use() where currency='JPY')
  and not exists(select 1 from public.currencies_in_use() where currency in ('USD','EUR')),
  'organisation B did not see exactly its own currencies');

-- A retired role is not a reader. The gate is inside the body, so this is a zero-row answer rather
-- than a privilege error — the shape that does not take the backend down with it.
select pg_temp.p82_act('20820000-0000-4000-8000-000000000003');
select pg_temp.p82_assert(
  (select count(*) from public.currencies_in_use()) = 0,
  'a retired role read the currency list');

reset role;

-- The function stays an invoker. If this ever flips, A5 begins applying to it and 0243's header
-- stops being true.
select pg_temp.p82_assert(
  not (select prosecdef from pg_catalog.pg_proc where oid='public.currencies_in_use()'::regprocedure),
  'currencies_in_use() became SECURITY DEFINER');

select pg_temp.p82_assert(
  not has_function_privilege('anon','public.currencies_in_use()','execute'),
  'anon can execute currencies_in_use()');

rollback;
