-- P17 -- The accounting supplier card has a narrow, tenant-scoped server read contract.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p17_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P17 financial supplier assertion failed: %', p_message;
  end if;
end
$$;

insert into public.organizations (id, name, status) values
  ('17000000-0000-4000-8000-000000000001', 'P17 tenant A', 'active'),
  ('17000000-0000-4000-8000-000000000002', 'P17 tenant B', 'active');
insert into auth.users (id, email) values
  ('27000000-0000-4000-8000-000000000001', 'accountant-p17@example.test'),
  ('27000000-0000-4000-8000-000000000002', 'office-p17@example.test'),
  ('27000000-0000-4000-8000-000000000003', 'owner-p17@example.test'),
  ('27000000-0000-4000-8000-000000000004', 'supplier-p17@example.test');
insert into public.profiles (id, org_id, full_name, role) values
  ('27000000-0000-4000-8000-000000000001', '17000000-0000-4000-8000-000000000001', 'P17 accountant', 'accountant'),
  ('27000000-0000-4000-8000-000000000002', '17000000-0000-4000-8000-000000000001', 'P17 office', 'office'),
  ('27000000-0000-4000-8000-000000000003', '17000000-0000-4000-8000-000000000001', 'P17 owner', 'owner');
insert into public.suppliers (
  id, org_id, name, tax_id, payment_terms, delivery_days, cutoff_time, min_order_amount, notes
) values
  ('37000000-0000-4000-8000-000000000001', '17000000-0000-4000-8000-000000000001', 'P17 supplier A', 'A-17', 'שוטף + 30', '{1}', '10:00', 500, 'procurement-only A'),
  ('37000000-0000-4000-8000-000000000002', '17000000-0000-4000-8000-000000000002', 'P17 supplier B', 'B-17', 'שוטף + 60', '{2}', '11:00', 700, 'procurement-only B');
insert into public.profiles (id, org_id, full_name, role, supplier_id) values
  ('27000000-0000-4000-8000-000000000004', '17000000-0000-4000-8000-000000000001', 'P17 supplier agent', 'supplier', '37000000-0000-4000-8000-000000000001');

select pg_temp.p17_assert(
  not (select p.prosecdef from pg_catalog.pg_proc p
       where p.oid = 'public.read_financial_supplier(uuid)'::regprocedure),
  'the projection must remain invoker and rely on the caller RLS');
select pg_temp.p17_assert(
  has_function_privilege('authenticated', 'public.read_financial_supplier(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.read_financial_supplier(uuid)', 'EXECUTE'),
  'only authenticated callers may execute the projection');
select pg_temp.p17_assert(
  has_table_privilege('authenticated', 'public.financial_supplier_directory', 'SELECT')
  and not has_table_privilege('authenticated', 'public.financial_supplier_directory', 'INSERT')
  and not has_table_privilege('authenticated', 'public.financial_supplier_directory', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.financial_supplier_directory', 'DELETE')
  and not has_table_privilege('authenticated', 'public.financial_supplier_directory', 'TRUNCATE'),
  'the browser role must have read-only access to the financial supplier directory');

select set_config('request.jwt.claim.sub', '27000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select pg_temp.p17_assert(
  (select count(*) from public.read_financial_supplier('37000000-0000-4000-8000-000000000001')) = 1,
  'accountant must read its own tenant supplier');
select pg_temp.p17_assert(
  (select count(*) from public.read_financial_supplier('37000000-0000-4000-8000-000000000002')) = 0,
  'accountant must not read another tenant supplier');
select pg_temp.p17_assert(
  (select count(*) from public.suppliers) = 0,
  'accountant must not bypass the projection through raw suppliers REST');
select pg_temp.p17_assert(
  (select count(*) from public.financial_supplier_directory) = 1
  and not exists (
    select 1 from public.financial_supplier_directory
    where id = '37000000-0000-4000-8000-000000000002'
  ),
  'financial supplier directory must remain tenant-scoped');
select pg_temp.p17_assert(
  (select array_agg(column_name::text order by ordinal_position)
   from information_schema.columns
   where table_schema = 'public' and table_name = 'financial_supplier_directory')
    = array['id', 'name', 'tax_id', 'payment_terms', 'status', 'bank_details']::text[],
  'financial supplier directory exposed procurement-only columns');
do $$
begin
  execute 'select notes from public.financial_supplier_directory limit 1';
  raise exception 'P17 financial supplier assertion failed: accountant projection exposed notes';
exception when undefined_column then null;
end
$$;
select pg_temp.p17_assert(
  (select to_jsonb(row_value) from public.read_financial_supplier('37000000-0000-4000-8000-000000000001') row_value)
    = jsonb_build_object(
      'id', '37000000-0000-4000-8000-000000000001'::uuid,
      'name', 'P17 supplier A',
      'tax_id', 'A-17',
      'payment_terms', 'שוטף + 30',
      'status', 'active'
    ),
  'the projection must contain exactly the approved financial identity fields');

reset role;
select set_config('request.jwt.claim.sub', '27000000-0000-4000-8000-000000000002', true);
set local role authenticated;
select pg_temp.p17_assert(
  (select count(*) from public.read_financial_supplier('37000000-0000-4000-8000-000000000001')) = 0,
  'office uses the procurement supplier screens, not the financial projection');
select pg_temp.p17_assert(
  (select count(*) from public.suppliers
   where id = '37000000-0000-4000-8000-000000000001') = 1,
  'office procurement supplier access must remain intact');
reset role;

select set_config('request.jwt.claim.sub', '27000000-0000-4000-8000-000000000003', true);
set local role authenticated;
select pg_temp.p17_assert(
  (select count(*) from public.read_financial_supplier('37000000-0000-4000-8000-000000000001')) = 1,
  'owner must retain the financial supplier card');
reset role;

select set_config('request.jwt.claim.sub', '27000000-0000-4000-8000-000000000004', true);
set local role authenticated;
select pg_temp.p17_assert(
  (select count(*) from public.suppliers) = 0,
  'supplier agent must use supplier_portal_context instead of the raw supplier row'
);
select pg_temp.p17_assert(
  public.supplier_portal_context()->'supplier'->>'id'
    = '37000000-0000-4000-8000-000000000001',
  'supplier portal projection did not retain the supplier agent own identity'
);
reset role;

rollback;
