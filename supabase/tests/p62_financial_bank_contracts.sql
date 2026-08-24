-- P62 -- structured supplier bank accounts and canonical XLSX bank-import contract (0171).
\set ON_ERROR_STOP on

begin;

create function pg_temp.p62_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P62 financial bank assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p62_expect_error(p_sql text, p_fragment text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
    raise exception 'P62 expected error containing %, statement succeeded: %', p_fragment, p_sql;
  exception when others then
    if sqlerrm like 'P62 expected error%' or position(p_fragment in sqlerrm) = 0 then
      raise;
    end if;
  end;
end
$$;

create function pg_temp.p62_actor(p_user uuid, p_fresh boolean default true)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', p_user::text,
    'role', 'authenticated',
    'amr', case when p_fresh then jsonb_build_array(jsonb_build_object(
      'method', 'password', 'timestamp', extract(epoch from clock_timestamp())::bigint
    )) else '[]'::jsonb end
  )::text, true);
end
$$;

select pg_temp.p62_assert(
  to_regclass('public.supplier_bank_accounts') is not null,
  'structured bank table is missing');
select pg_temp.p62_assert(
  (select relrowsecurity and relforcerowsecurity
   from pg_class where oid = 'public.supplier_bank_accounts'::regclass),
  'structured bank table must enable and force RLS');
select pg_temp.p62_assert(
  not has_table_privilege('authenticated', 'public.supplier_bank_accounts', 'SELECT')
  and not has_table_privilege('authenticated', 'public.supplier_bank_accounts', 'INSERT')
  and not has_table_privilege('authenticated', 'public.supplier_bank_accounts', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.supplier_bank_accounts', 'DELETE'),
  'browser received direct structured-bank table access');
-- Absence is asserted with to_regprocedure, not with has_function_privilege: 0171 drops the
-- free-text signature outright rather than revoking it, because two same-arity overloads with
-- identical parameter names are unresolvable to PostgREST, and asking about a privilege on a
-- function that no longer exists raises instead of answering false.
select pg_temp.p62_assert(
  has_function_privilege('authenticated', 'public.update_supplier_bank_details(uuid,jsonb,text)', 'EXECUTE')
  and to_regprocedure('public.update_supplier_bank_details(uuid,text,text)') is null,
  'new command is not the sole browser write path');

insert into public.organizations (id, name, status) values
  ('1b620000-0000-4000-8000-000000000001', 'P62 tenant A', 'active'),
  ('1b620000-0000-4000-8000-000000000002', 'P62 tenant B', 'active');
insert into auth.users (id, email) values
  ('2b620000-0000-4000-8000-000000000001', 'owner-a-p62@example.test'),
  ('2b620000-0000-4000-8000-000000000002', 'office-a-p62@example.test'),
  ('2b620000-0000-4000-8000-000000000003', 'accountant-a-p62@example.test'),
  ('2b620000-0000-4000-8000-000000000004', 'owner-b-p62@example.test');
insert into public.profiles (id, org_id, full_name, role) values
  ('2b620000-0000-4000-8000-000000000001', '1b620000-0000-4000-8000-000000000001', 'P62 owner A', 'owner'),
  ('2b620000-0000-4000-8000-000000000002', '1b620000-0000-4000-8000-000000000001', 'P62 office A', 'office'),
  ('2b620000-0000-4000-8000-000000000003', '1b620000-0000-4000-8000-000000000001', 'P62 accountant A', 'accountant'),
  ('2b620000-0000-4000-8000-000000000004', '1b620000-0000-4000-8000-000000000002', 'P62 owner B', 'owner');
insert into public.suppliers (id, org_id, name) values
  ('3b620000-0000-4000-8000-000000000001', '1b620000-0000-4000-8000-000000000001', 'P62 Israel'),
  ('3b620000-0000-4000-8000-000000000002', '1b620000-0000-4000-8000-000000000001', 'P62 International'),
  ('3b620000-0000-4000-8000-000000000003', '1b620000-0000-4000-8000-000000000002', 'P62 tenant B');

select pg_temp.p62_actor('2b620000-0000-4000-8000-000000000001', false);
select pg_temp.p62_expect_error(
  $$select update_supplier_bank_details('3b620000-0000-4000-8000-000000000001',
    '{"account_holder":"P62 Israel Ltd","country_code":"IL","bank_code":"12","branch_code":"345","account_number":"123456"}',
    'P62 no step-up')$$,
  'fresh_authentication_required');

select pg_temp.p62_actor('2b620000-0000-4000-8000-000000000003');
select pg_temp.p62_expect_error(
  $$select update_supplier_bank_details('3b620000-0000-4000-8000-000000000001',
    '{"account_holder":"P62 Israel Ltd","country_code":"IL","bank_code":"12","branch_code":"345","account_number":"123456"}',
    'P62 accountant attempt')$$,
  'supplier_bank_details_not_authorized');

select pg_temp.p62_actor('2b620000-0000-4000-8000-000000000001');
select pg_temp.p62_expect_error(
  $$select update_supplier_bank_details('3b620000-0000-4000-8000-000000000001',
    '{"account_holder":"P62 Israel Ltd","country_code":"IL","iban":"IL620108000000099999999"}',
    'P62 invalid Israel shape')$$,
  'supplier_bank_details_invalid');
select pg_temp.p62_expect_error(
  $$select update_supplier_bank_details('3b620000-0000-4000-8000-000000000002',
    '{"account_holder":"P62 Global Ltd","country_code":"DE","bic":"DEUTDEFF"}',
    'P62 missing IBAN')$$,
  'supplier_bank_details_invalid');
select pg_temp.p62_expect_error(
  $$select update_supplier_bank_details('3b620000-0000-4000-8000-000000000003',
    '{"account_holder":"P62 cross tenant","country_code":"IL","bank_code":"12","branch_code":"345","account_number":"999"}',
    'P62 cross tenant')$$,
  'supplier_unknown');

select update_supplier_bank_details(
  '3b620000-0000-4000-8000-000000000001',
  '{"account_holder":"P62 Israel Ltd","country_code":"IL","bank_code":"12","branch_code":"345","account_number":"123456"}',
  'P62 Israel approved');
select pg_temp.p62_actor('2b620000-0000-4000-8000-000000000002');
select update_supplier_bank_details(
  '3b620000-0000-4000-8000-000000000002',
  '{"account_holder":"P62 Global Ltd","country_code":"DE","iban":"DE89370400440532013000","bic":"COBADEFFXXX"}',
  'P62 international approved');

reset role;
select pg_temp.p62_assert(
  (select account_holder = 'P62 Israel Ltd' and country_code = 'IL'
      and bank_code = '12' and branch_code = '345' and account_number = '123456'
      and iban is null and bic is null
   from public.supplier_bank_accounts
   where supplier_id = '3b620000-0000-4000-8000-000000000001'),
  'valid Israel shape was not stored canonically');
select pg_temp.p62_assert(
  (select account_holder = 'P62 Global Ltd' and country_code = 'DE'
      and bank_code is null and branch_code is null and account_number is null
      and iban = 'DE89370400440532013000' and bic = 'COBADEFFXXX'
   from public.supplier_bank_accounts
   where supplier_id = '3b620000-0000-4000-8000-000000000002'),
  'valid international shape was not stored canonically');
select pg_temp.p62_assert(
  exists (select 1 from audit_logs
    where action = 'supplier_bank_details_changed'
      and entity_id = '3b620000-0000-4000-8000-000000000001'
      and reason = 'P62 Israel approved')
  and not exists (select 1 from audit_logs
    where entity_id in ('3b620000-0000-4000-8000-000000000001', '3b620000-0000-4000-8000-000000000002')
      and coalesce(old_values::text, '') || coalesce(new_values::text, '') ~ '123456|532013000'),
  'audit is missing or contains raw account/IBAN values');

select pg_temp.p62_actor('2b620000-0000-4000-8000-000000000003');
set local role authenticated;
select pg_temp.p62_assert(
  (select country_code = 'IL' and account_holder = 'P62 Israel Ltd'
      and account_number = '123456' and iban is null
   from public.financial_supplier_bank_accounts
   where supplier_id = '3b620000-0000-4000-8000-000000000001')
  and (select bank_details like '%3456%' and bank_details not like '%123456%'
       from public.financial_supplier_directory
       where id = '3b620000-0000-4000-8000-000000000001'),
  'structured account is missing or the shared directory exposes more than last4');
-- The international shape gets the same value assertion. 0171 asserts structurally that the
-- directory reads no column beyond country plus the two maskable ones; that the rendered value
-- is a last-four mask rather than the whole IBAN can only be measured against a real row.
select pg_temp.p62_assert(
  (select bank_details like '%3000%'
      and bank_details not like '%DE89370400440532013000%'
      and bank_details not like '%COBADEFFXXX%'
      and bank_details not like '%P62 Global%'
   from public.financial_supplier_directory
   where id = '3b620000-0000-4000-8000-000000000002'),
  'the shared directory exposes the full IBAN, the BIC or the account holder');
reset role;
select pg_temp.p62_assert(
  position('supplier.bank_details' in pg_get_viewdef('public.financial_supplier_directory'::regclass)) = 0,
  'active financial projection still reads legacy free text');

insert into private.supplier_bank_detail_migration_queue (
  org_id, supplier_id, legacy_bank_details, status
) values (
  '1b620000-0000-4000-8000-000000000001',
  '3b620000-0000-4000-8000-000000000002',
  'Legacy bank 99 branch 001 account 777', 'pending'
);
select pg_temp.p62_actor('2b620000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.p62_assert(
  (select legacy_bank_details = 'Legacy bank 99 branch 001 account 777'
   from read_supplier_bank_migration_item('3b620000-0000-4000-8000-000000000002')),
  'controlled migration reader did not return pending legacy evidence');
reset role;
select update_supplier_bank_details(
  '3b620000-0000-4000-8000-000000000002',
  '{"account_holder":"P62 Global corrected","country_code":"DE","iban":"DE89370400440532013000","bic":"COBADEFFXXX"}',
  'P62 human-confirmed migration');
reset role;
select pg_temp.p62_assert(
  (select status = 'confirmed' and reviewed_by = '2b620000-0000-4000-8000-000000000002'
      and reviewed_at is not null and legacy_bank_details like 'Legacy%'
   from private.supplier_bank_detail_migration_queue
   where supplier_id = '3b620000-0000-4000-8000-000000000002'),
  'human save did not close the migration item while preserving legacy evidence');

-- Canonical import metadata is enforced at the command boundary; byte/signature/formula checks
-- happen in the XLSX parser before this RPC receives normalized rows.
select pg_temp.p62_actor('2b620000-0000-4000-8000-000000000003');
select pg_temp.p62_expect_error(
  $$select import_bank_transactions('legacy.csv', repeat('a',64),
    '{"template_version":"1","sheet":"Bank Transactions","headers":["transaction_date","description","direction","amount","reference"]}',
    '[{"tx_date":"2026-08-21","description":"x","amount":10,"is_debit":true,"reference":null,"raw":{"direction":"debit"},"supplier_id":null,"row_hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]',
    'P62 CSV rejected')$$,
  'bank_import_contract_invalid');

rollback;

\echo 'p62_financial_bank_contracts_passed'
