-- P40 -- browser Storage INSERT sees owner/owner_id and metadata as NULL.
-- The tenant path and active product role must authorize the initial row by themselves.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p40_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P40 browser storage assertion failed: %', p_message;
  end if;
end
$$;

insert into public.organizations (id, name, status, vat_rate) values
  ('1a400000-0000-4000-8000-000000000001', 'P40 mine', 'active', 18),
  ('1a400000-0000-4000-8000-000000000002', 'P40 other', 'active', 18);

insert into auth.users (id, email) values
  ('2a400000-0000-4000-8000-000000000001', 'owner-p40@example.test'),
  ('2a400000-0000-4000-8000-000000000002', 'office-p40@example.test'),
  ('2a400000-0000-4000-8000-000000000003', 'accountant-p40@example.test'),
  ('2a400000-0000-4000-8000-000000000004', 'kitchen-p40@example.test'),
  ('2a400000-0000-4000-8000-000000000005', 'payer-p40@example.test'),
  ('2a400000-0000-4000-8000-000000000006', 'supplier-p40@example.test');

insert into public.suppliers (id, org_id, name) values
  ('3a400000-0000-4000-8000-000000000001', '1a400000-0000-4000-8000-000000000001',
   'P40 supplier');

-- Retired profiles here are historical postgres fixtures. 0127 deliberately keeps the enum and
-- lets trusted SQL suites construct old rows; the authenticated policies must still refuse them.
insert into public.profiles (id, org_id, full_name, role, active, supplier_id) values
  ('2a400000-0000-4000-8000-000000000001', '1a400000-0000-4000-8000-000000000001',
   'P40 owner', 'owner', true, null),
  ('2a400000-0000-4000-8000-000000000002', '1a400000-0000-4000-8000-000000000001',
   'P40 office', 'office', true, null),
  ('2a400000-0000-4000-8000-000000000003', '1a400000-0000-4000-8000-000000000001',
   'P40 accountant', 'accountant', true, null),
  ('2a400000-0000-4000-8000-000000000004', '1a400000-0000-4000-8000-000000000001',
   'P40 kitchen', 'kitchen', true, null),
  ('2a400000-0000-4000-8000-000000000005', '1a400000-0000-4000-8000-000000000001',
   'P40 payer', 'payer', true, null),
  ('2a400000-0000-4000-8000-000000000006', '1a400000-0000-4000-8000-000000000001',
   'P40 supplier user', 'supplier', true, '3a400000-0000-4000-8000-000000000001');

select set_config('request.jwt.claim.role', 'authenticated', true);

-- Owner uploads a document row exactly as the Storage API first creates it: no owner and no
-- metadata yet. This was impossible before 0128.
select set_config('request.jwt.claim.sub', '2a400000-0000-4000-8000-000000000001', true);
set local role authenticated;
insert into storage.objects (bucket_id, name) values (
  'documents',
  '1a400000-0000-4000-8000-000000000001/invoice/4a400000-0000-4000-8000-000000000001/scan.pdf'
);
reset role;

select pg_temp.p40_assert(
  (select owner is null and owner_id is null and metadata is null
   from storage.objects
   where bucket_id = 'documents'
     and name = '1a400000-0000-4000-8000-000000000001/invoice/4a400000-0000-4000-8000-000000000001/scan.pdf'),
  'documents INSERT still requires fields populated only after the Storage row is created');

-- Accountant is now a product account and the payment executor, including transfer-proof upload.
select set_config('request.jwt.claim.sub', '2a400000-0000-4000-8000-000000000003', true);
set local role authenticated;
insert into storage.objects (bucket_id, name) values (
  'documents',
  '1a400000-0000-4000-8000-000000000001/payment/4a400000-0000-4000-8000-000000000002/proof.pdf'
);
reset role;

-- Office uploads an unregistered price-list staging object with the same NULL service fields.
select set_config('request.jwt.claim.sub', '2a400000-0000-4000-8000-000000000002', true);
set local role authenticated;
insert into storage.objects (bucket_id, name) values (
  'price-submissions',
  '1a400000-0000-4000-8000-000000000001/price-submissions/3a400000-0000-4000-8000-000000000001/4a400000-0000-4000-8000-000000000003/price-list.xlsx'
);
reset role;

-- Owner uploads a workbook; accountant can read the live layout but cannot replace it.
select set_config('request.jwt.claim.sub', '2a400000-0000-4000-8000-000000000001', true);
set local role authenticated;
insert into storage.objects (bucket_id, name) values (
  'export-templates',
  '1a400000-0000-4000-8000-000000000001/4a400000-0000-4000-8000-000000000004.xlsx'
);
reset role;

select set_config('request.jwt.claim.sub', '2a400000-0000-4000-8000-000000000003', true);
set local role authenticated;
select pg_temp.p40_assert(
  (select count(*) = 1 from storage.objects
   where bucket_id = 'export-templates'
     and name = '1a400000-0000-4000-8000-000000000001/4a400000-0000-4000-8000-000000000004.xlsx'),
  'accountant cannot read the workbook used for the accountant export');

do $$
begin
  insert into storage.objects (bucket_id, name) values (
    'export-templates',
    '1a400000-0000-4000-8000-000000000001/4a400000-0000-4000-8000-000000000005.xlsx'
  );
  raise exception 'P40 browser storage assertion failed: accountant uploaded an export template';
exception when sqlstate '42501' then null;
end
$$;
reset role;

-- Every retired persona is refused even when an old active profile exists.
do $$
declare
  v_user uuid;
  v_role text;
begin
  foreach v_user in array array[
    '2a400000-0000-4000-8000-000000000004'::uuid,
    '2a400000-0000-4000-8000-000000000005'::uuid,
    '2a400000-0000-4000-8000-000000000006'::uuid
  ] loop
    select role::text into v_role from public.profiles where id = v_user;
    perform set_config('request.jwt.claim.sub', v_user::text, true);
    execute 'set local role authenticated';
    begin
      insert into storage.objects (bucket_id, name) values (
        'documents',
        '1a400000-0000-4000-8000-000000000001/archive/4a400000-0000-4000-8000-000000000006/'
          || v_role || '.pdf'
      );
      raise exception 'P40 browser storage assertion failed: retired role % uploaded a document',
        v_role;
    exception when sqlstate '42501' then null;
    end;
    execute 'reset role';
  end loop;
end
$$;

-- Tenant and supplier path boundaries remain after removing owner/metadata checks.
select set_config('request.jwt.claim.sub', '2a400000-0000-4000-8000-000000000001', true);
set local role authenticated;
do $$
begin
  insert into storage.objects (bucket_id, name) values (
    'documents',
    '1a400000-0000-4000-8000-000000000002/invoice/4a400000-0000-4000-8000-000000000007/cross.pdf'
  );
  raise exception 'P40 browser storage assertion failed: cross-tenant document path was accepted';
exception when sqlstate '42501' then null;
end
$$;

do $$
begin
  insert into storage.objects (bucket_id, name) values (
    'price-submissions',
    '1a400000-0000-4000-8000-000000000001/price-submissions/3a400000-0000-4000-8000-000000000099/4a400000-0000-4000-8000-000000000008/price-list.xlsx'
  );
  raise exception 'P40 browser storage assertion failed: unknown supplier path was accepted';
exception when sqlstate '42501' then null;
end
$$;
reset role;

select pg_temp.p40_assert(
  not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname like 'supplier_price_documents_storage_%'
  ),
  'a supplier-document Storage policy remains');

rollback;
