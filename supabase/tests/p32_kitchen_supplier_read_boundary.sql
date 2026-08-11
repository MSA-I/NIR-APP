-- P32 -- narrowing a role without breaking it.
--
-- The obvious way to stop a kitchen manager reading supplier bank details is to take away their
-- row access to `suppliers`. That is measurably wrong: PostgREST filters EMBEDS by RLS, so
-- `purchase_orders?select=*,supplier:suppliers(name)` starts returning `supplier: null` and every
-- ordering, receiving and sharing screen loses the supplier's name while keeping its buttons.
--
-- 0112 uses a column privilege instead, which sits BENEATH RLS. These assertions are the two
-- halves of that claim, and they pull in opposite directions on purpose: the column must be
-- unreachable, and the row must stay readable. A change that satisfies one and breaks the other is
-- exactly the failure this suite exists to catch.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p32_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P32 supplier boundary assertion failed: %', p_message;
  end if;
end
$$;

insert into public.organizations (id, name, status) values
  ('10320000-0000-4000-8000-000000000001', 'P32 tenant', 'active');
insert into auth.users (id, email) values
  ('20320000-0000-4000-8000-000000000001', 'owner-p32@example.test'),
  ('20320000-0000-4000-8000-000000000002', 'kitchen-p32@example.test');
insert into public.profiles (id, org_id, full_name, role) values
  ('20320000-0000-4000-8000-000000000001', '10320000-0000-4000-8000-000000000001',
   'P32 owner', 'owner'),
  ('20320000-0000-4000-8000-000000000002', '10320000-0000-4000-8000-000000000001',
   'P32 kitchen', 'kitchen');
insert into public.suppliers (id, org_id, name, status, bank_details, tax_id) values
  ('40320000-0000-4000-8000-000000000001', '10320000-0000-4000-8000-000000000001',
   'P32 ספק', 'active', 'בנק 12 סניף 345 חשבון 678901', '511111118');
insert into public.purchase_orders (id, org_id, supplier_id, status) values
  ('50320000-0000-4000-8000-000000000001', '10320000-0000-4000-8000-000000000001',
   '40320000-0000-4000-8000-000000000001', 'sent');

-- ===== 1. The column is unreachable, for everyone, by any direct query =====
--
-- Not "for kitchen": `authenticated` is ONE database role shared by every app role, so a column
-- privilege cannot tell them apart. The owner loses the direct read too, and gets it back through
-- the view — which is what makes the boundary enforceable rather than advisory.

select pg_temp.p32_assert(
  not has_column_privilege('authenticated', 'public.suppliers', 'bank_details', 'select'),
  'a client role can select suppliers.bank_details directly. RLS cannot mask a column; this '
  'privilege is the only thing standing between a crafted PostgREST query and the account money '
  'is sent to');

select pg_temp.p32_assert(
  not has_column_privilege('anon', 'public.suppliers', 'bank_details', 'select'),
  'an unauthenticated role can select supplier bank details');

select pg_temp.p32_assert(
  not has_column_privilege('authenticated', 'public.suppliers', 'bank_details', 'update'),
  'a client role regained direct UPDATE on bank_details. 0061 revoked it so that changing where '
  'money goes is always a reasoned, audited command');

-- ===== 2. ...and every other column is still readable =====
--
-- Getting column granularity meant revoking the TABLE grant and re-issuing it column by column.
-- That is the kind of change that takes a bystander with it, and a bystander here is a screen that
-- renders empty with no error anyone can trace.

select pg_temp.p32_assert(
  not exists (
    select 1 from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = 'suppliers'
      and c.column_name <> 'bank_details'
      and not has_column_privilege('authenticated', 'public.suppliers', c.column_name, 'select')),
  'a supplier column other than bank_details lost its read privilege when the table grant was '
  'split into column grants');

select pg_temp.p32_assert(
  has_column_privilege('authenticated', 'public.suppliers', 'name', 'select')
  and has_column_privilege('authenticated', 'public.suppliers', 'phone', 'select')
  and has_column_privilege('authenticated', 'public.suppliers', 'status', 'select'),
  'the fields a kitchen manager needs to place an order and receive goods stopped being readable');

-- ===== 3. THE ROW STAYS READABLE. This is the half that breaking looks like a fix. =====

select pg_temp.p32_assert(
  (select position('kitchen' in pg_get_expr(pol.polqual, pol.polrelid)) > 0
   from pg_policy pol join pg_class c on c.oid = pol.polrelid
   where c.relname = 'suppliers' and pol.polname = 'suppliers_select'),
  'KITCHEN LOST ROW ACCESS TO SUPPLIERS. PostgREST filters embeds by RLS, so every purchase '
  'order, receipt, order form and WhatsApp share would render `supplier: null` — the buttons '
  'would stay and the supplier''s name would vanish. The column privilege narrows this role; the '
  'policy must not');

set local role authenticated;
select set_config('request.jwt.claim.sub', '20320000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

-- The embed, as the ordering and receiving screens actually make it.
select pg_temp.p32_assert(
  (select s.name = 'P32 ספק'
   from public.purchase_orders po
   join public.suppliers s on s.id = po.supplier_id
   where po.id = '50320000-0000-4000-8000-000000000001'),
  'a kitchen manager cannot read the supplier name through the order, which is what every '
  'ordering and receiving screen does');

do $$
begin
  perform bank_details from public.suppliers
  where id = '40320000-0000-4000-8000-000000000001';
  raise exception 'P32 supplier boundary assertion failed: A KITCHEN MANAGER READ THE SUPPLIER''S '
    'BANK ACCOUNT. This is the query the whole migration exists to refuse';
exception when insufficient_privilege then
  null;
end
$$;

-- ===== 4. The directory is the only way back in, and it no longer serves kitchen =====

select pg_temp.p32_assert(
  (select count(*) = 0 from public.financial_supplier_directory
   where id = '40320000-0000-4000-8000-000000000001'),
  'the financial directory still serves a kitchen manager the supplier''s payment fields');

select set_config('request.jwt.claim.sub', '20320000-0000-4000-8000-000000000001', true);
select pg_temp.p32_assert(
  (select d.bank_details = 'בנק 12 סניף 345 חשבון 678901'
   from public.financial_supplier_directory d
   where d.id = '40320000-0000-4000-8000-000000000001'),
  'THE OWNER LOST THE BANK DETAILS ENTIRELY. The column revoke applies to every app role, because '
  'they share one database role — the view is what hands them back, and if it stops working the '
  'payment screen has nowhere to read from');

reset role;
select pg_temp.p32_assert(
  (select reloptions::text like '%security_barrier=true%'
   from pg_class where oid = 'public.financial_supplier_directory'::regclass),
  'the directory lost security_barrier, so a caller''s own WHERE clause may now run before the '
  'role predicate');

select pg_temp.p32_assert(
  (select position('''kitchen''' in pg_get_viewdef(
     'public.financial_supplier_directory'::regclass)) = 0),
  'kitchen is back in the directory definition');

rollback;
