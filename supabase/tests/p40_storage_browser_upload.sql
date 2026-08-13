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
  ('2a400000-0000-4000-8000-000000000003', 'accountant-p40@example.test');

insert into public.suppliers (id, org_id, name) values
  ('3a400000-0000-4000-8000-000000000001', '1a400000-0000-4000-8000-000000000001',
   'P40 supplier');

insert into public.profiles (id, org_id, full_name, role, active, supplier_id) values
  ('2a400000-0000-4000-8000-000000000001', '1a400000-0000-4000-8000-000000000001',
   'P40 owner', 'owner', true, null),
  ('2a400000-0000-4000-8000-000000000002', '1a400000-0000-4000-8000-000000000001',
   'P40 office', 'office', true, null),
  ('2a400000-0000-4000-8000-000000000003', '1a400000-0000-4000-8000-000000000001',
   'P40 accountant', 'accountant', true, null);

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

rollback;
