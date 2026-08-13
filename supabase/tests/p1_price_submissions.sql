-- P1B supplier price submission regression harness. Run only against an isolated local
-- database after applying migrations through 0038_p1b_qualified_storage_paths.sql.
\set ON_ERROR_STOP on

begin;

-- Storage API 2.109.1 blocks direct SQL deletes before RLS is evaluated. This test-only,
-- transaction-local opt-in lets the synthetic DELETE fixtures exercise the real policies;
-- the setting rolls back with the harness and is never part of a migration or product path.
select set_config('storage.allow_delete_query', 'true', true);

create function pg_temp.p1b_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P1B assertion failed: %', p_message;
  end if;
end
$$;

-- Trusted fixtures are inserted without a JWT. All product calls below run as authenticated.
insert into organizations (id, name, status) values
  ('11000000-0000-0000-0000-000000000001', 'P1B tenant A', 'active'),
  ('11000000-0000-0000-0000-000000000002', 'P1B tenant B', 'active');

insert into auth.users (id, email) values
  ('21000000-0000-0000-0000-000000000001', 'owner-p1b@example.test'),
  ('21000000-0000-0000-0000-000000000002', 'office-p1b@example.test'),
  ('21000000-0000-0000-0000-000000000003', 'office-uploader-p1b@example.test'),
  ('21000000-0000-0000-0000-000000000004', 'owner-b-p1b@example.test'),
  ('21000000-0000-0000-0000-000000000005', 'accountant-p1b@example.test'),
  ('21000000-0000-0000-0000-000000000006', 'accountant-secondary-p1b@example.test'),
  ('21000000-0000-0000-0000-000000000008', 'office-uploader-2-p1b@example.test');

insert into profiles (id, org_id, full_name, role) values
  ('21000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', 'P1B owner', 'owner'),
  ('21000000-0000-0000-0000-000000000002', '11000000-0000-0000-0000-000000000001', 'P1B office', 'office'),
  ('21000000-0000-0000-0000-000000000003', '11000000-0000-0000-0000-000000000001', 'P1B office uploader', 'office'),
  ('21000000-0000-0000-0000-000000000004', '11000000-0000-0000-0000-000000000002', 'P1B owner B', 'owner'),
  ('21000000-0000-0000-0000-000000000005', '11000000-0000-0000-0000-000000000001', 'P1B accountant', 'accountant'),
  ('21000000-0000-0000-0000-000000000006', '11000000-0000-0000-0000-000000000001', 'P1B secondary accountant', 'accountant'),
  ('21000000-0000-0000-0000-000000000008', '11000000-0000-0000-0000-000000000001', 'P1B second office uploader', 'office');

insert into suppliers (id, org_id, name) values
  ('31000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', 'P1B supplier A1'),
  ('31000000-0000-0000-0000-000000000002', '11000000-0000-0000-0000-000000000001', 'P1B supplier A2'),
  ('31000000-0000-0000-0000-000000000003', '11000000-0000-0000-0000-000000000002', 'P1B supplier B1');

insert into products (id, org_id, name, unit) values
  ('41000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', 'P1B Product A1', 'unit'),
  ('41000000-0000-0000-0000-000000000002', '11000000-0000-0000-0000-000000000001', 'P1B Product A2', 'unit'),
  ('41000000-0000-0000-0000-000000000003', '11000000-0000-0000-0000-000000000002', 'P1B Product B1', 'unit');

insert into supplier_products (
  id, org_id, supplier_id, product_id, current_price, price_effective_date, available
) values
  ('51000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', '31000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-000000000001', 10, '2026-07-01', true),
  ('51000000-0000-0000-0000-000000000002', '11000000-0000-0000-0000-000000000001', '31000000-0000-0000-0000-000000000002', '41000000-0000-0000-0000-000000000002', 20, '2026-07-01', true),
  ('51000000-0000-0000-0000-000000000003', '11000000-0000-0000-0000-000000000002', '31000000-0000-0000-0000-000000000003', '41000000-0000-0000-0000-000000000003', 30, '2026-07-01', true);

insert into price_history (org_id, supplier_product_id, price, effective_date) values
  ('11000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000001', 10, '2026-07-01'),
  ('11000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000002', 20, '2026-07-01'),
  ('11000000-0000-0000-0000-000000000002', '51000000-0000-0000-0000-000000000003', 30, '2026-07-01');

insert into storage.objects (bucket_id, name, owner, metadata) values
  (
    'price-submissions',
    '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/61000000-0000-0000-0000-000000000001/july.csv',
    '21000000-0000-0000-0000-000000000003',
    '{"mimetype":"text/csv"}'::jsonb
  ),
  (
    'price-submissions',
    '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/61000000-0000-4000-8000-000000000002/same-bytes.csv',
    '21000000-0000-0000-0000-000000000003',
    '{"mimetype":"text/csv","size":100}'::jsonb
  ),
  (
    'price-submissions',
    '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/61000000-0000-0000-0000-000000000003/july-correction.csv',
    '21000000-0000-0000-0000-000000000003',
    '{"mimetype":"text/csv","size":100}'::jsonb
  ),
  (
    'price-submissions',
    '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/61000000-0000-4000-8000-000000000005/db-failure.csv',
    '21000000-0000-0000-0000-000000000003',
    '{"mimetype":"text/csv","size":100}'::jsonb
  ),
  (
    'price-submissions',
    '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/66000000-0000-4000-8000-000000000008/service-stage.csv',
    '21000000-0000-0000-0000-000000000003',
    '{"mimetype":"text/csv","size":100}'::jsonb
  ),
  (
    'price-submissions',
    '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/64000000-0000-4000-8000-000000000009/changed-stage.csv',
    '21000000-0000-0000-0000-000000000003',
    '{"mimetype":"text/csv","size":100}'::jsonb
  ),
  (
    'price-submissions',
    '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000002/68000000-0000-4000-8000-000000000001/competitor-stage.csv',
    '21000000-0000-0000-0000-000000000003',
    '{"mimetype":"text/csv","size":100}'::jsonb
  ),
  (
    'price-submissions',
    '11000000-0000-0000-0000-000000000002/price-submissions/31000000-0000-0000-0000-000000000003/68000000-0000-4000-8000-000000000002/tenant-stage.csv',
    '21000000-0000-0000-0000-000000000003',
    '{"mimetype":"text/csv","size":100}'::jsonb
  ),
  (
    'price-submissions',
    '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000002/62000000-0000-0000-0000-000000000001/competitor-ledger.csv',
    '21000000-0000-0000-0000-000000000002',
    '{"mimetype":"text/csv","size":100}'::jsonb
  ),
  (
    'price-submissions',
    '11000000-0000-0000-0000-000000000002/price-submissions/31000000-0000-0000-0000-000000000003/62000000-0000-0000-0000-000000000002/tenant-ledger.csv',
    '21000000-0000-0000-0000-000000000004',
    '{"mimetype":"text/csv","size":100}'::jsonb
  );

-- Trusted fixture receipts let the RLS checks prove competitor and second-tenant isolation.
insert into supplier_price_submissions (
  id, org_id, supplier_id, target_month, revision, file_name, storage_path,
  file_checksum, status, accepted_count, rejected_count, unchanged_count,
  row_count, created_count, updated_count, submitted_by
) values
  (
    '62000000-0000-0000-0000-000000000001',
    '11000000-0000-0000-0000-000000000001',
    '31000000-0000-0000-0000-000000000002', '2026-07-01', 1,
    'competitor-ledger.csv',
    '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000002/62000000-0000-0000-0000-000000000001/competitor-ledger.csv',
    repeat('c', 64), 'accepted', 1, 0, 0, 1, 1, 0,
    '21000000-0000-0000-0000-000000000002'
  ),
  (
    '62000000-0000-0000-0000-000000000002',
    '11000000-0000-0000-0000-000000000002',
    '31000000-0000-0000-0000-000000000003', '2026-07-01', 1,
    'tenant-ledger.csv',
    '11000000-0000-0000-0000-000000000002/price-submissions/31000000-0000-0000-0000-000000000003/62000000-0000-0000-0000-000000000002/tenant-ledger.csv',
    repeat('d', 64), 'accepted', 1, 0, 0, 1, 1, 0,
    '21000000-0000-0000-0000-000000000004'
  );

-- The following prepared rows stand in for the Edge Function after it has hashed and parsed the
-- claimed immutable bytes. Authenticated users have no grant that can create them.
insert into supplier_price_submission_intakes (
  id, org_id, actor_id, supplier_id, submission_id, target_month,
  file_name, storage_path, object_id, object_updated_at, mime_type,
  file_checksum, file_size, rows_payload, reason, status
)
select fixture.intake_id, fixture.org_id, fixture.actor_id, fixture.supplier_id,
       fixture.submission_id, fixture.target_month, fixture.file_name, fixture.storage_path,
       object.id, object.updated_at, 'text/csv', fixture.file_checksum, 100,
       fixture.rows_payload, fixture.reason, 'prepared'
from (values
  (
    '71000000-0000-0000-0000-000000000001'::uuid,
    '11000000-0000-0000-0000-000000000001'::uuid,
    '21000000-0000-0000-0000-000000000003'::uuid,
    '31000000-0000-0000-0000-000000000001'::uuid,
    '61000000-0000-0000-0000-000000000001'::uuid, '2026-07-01'::date,
    'july.csv'::text,
    '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/61000000-0000-0000-0000-000000000001/july.csv'::text,
    repeat('a', 64)::text,
    '[{"source_row":2,"product_id":"41000000-0000-0000-0000-000000000001","product_name":"P1B Product A1","price_text":"12","available":true},{"source_row":3,"product_id":null,"product_name":"Invented Product","price_text":"8","available":true}]'::jsonb,
    'monthly supplier submission'::text
  ),
  (
    '71000000-0000-0000-0000-000000000002'::uuid,
    '11000000-0000-0000-0000-000000000001'::uuid,
    '21000000-0000-0000-0000-000000000003'::uuid,
    '31000000-0000-0000-0000-000000000001'::uuid,
    '61000000-0000-4000-8000-000000000002'::uuid, '2026-07-01'::date,
    'same-bytes.csv'::text,
    '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/61000000-0000-4000-8000-000000000002/same-bytes.csv'::text,
    repeat('a', 64)::text,
    '[{"source_row":2,"product_id":"41000000-0000-0000-0000-000000000001","product_name":"P1B Product A1","price_text":"12","available":true}]'::jsonb,
    'lost response retry'::text
  ),
  (
    '71000000-0000-0000-0000-000000000003'::uuid,
    '11000000-0000-0000-0000-000000000001'::uuid,
    '21000000-0000-0000-0000-000000000003'::uuid,
    '31000000-0000-0000-0000-000000000001'::uuid,
    '61000000-0000-0000-0000-000000000003'::uuid, '2026-07-01'::date,
    'july-correction.csv'::text,
    '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/61000000-0000-0000-0000-000000000003/july-correction.csv'::text,
    repeat('b', 64)::text,
    '[{"source_row":2,"product_id":"41000000-0000-0000-0000-000000000001","product_name":"P1B Product A1","price_text":"15","available":true}]'::jsonb,
    'corrected monthly submission'::text
  ),
  (
    '71000000-0000-0000-0000-000000000005'::uuid,
    '11000000-0000-0000-0000-000000000001'::uuid,
    '21000000-0000-0000-0000-000000000003'::uuid,
    '31000000-0000-0000-0000-000000000001'::uuid,
    '61000000-0000-4000-8000-000000000005'::uuid, '2026-07-01'::date,
    'db-failure.csv'::text,
    '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/61000000-0000-4000-8000-000000000005/db-failure.csv'::text,
    repeat('e', 64)::text,
    '[{"source_row":2,"product_id":"41000000-0000-0000-0000-000000000001","product_name":"P1B Product A1","price_text":"17","available":true}]'::jsonb,
    'forced database rollback'::text
  )
) as fixture(
  intake_id, org_id, actor_id, supplier_id, submission_id, target_month,
  file_name, storage_path, file_checksum, rows_payload, reason
)
join storage.objects object
  on object.bucket_id = 'price-submissions' and object.name = fixture.storage_path;

-- The real service boundary can claim, prepare and discard an uploader-owned object. No
-- authenticated grant exists on either the intake table or these staging commands.
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select claim_supplier_price_intake(
  '71000000-0000-0000-0000-000000000008',
  '21000000-0000-0000-0000-000000000003',
  '31000000-0000-0000-0000-000000000001',
  '66000000-0000-4000-8000-000000000008',
  '2026-08-01', 'service-stage.csv',
  '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/66000000-0000-4000-8000-000000000008/service-stage.csv',
  'trusted Edge staging test'
);
select prepare_supplier_price_intake(
  '71000000-0000-0000-0000-000000000008',
  '21000000-0000-0000-0000-000000000003',
  repeat('8', 64), 100,
  '[{"source_row":2,"product_id":"41000000-0000-0000-0000-000000000001","product_name":"P1B Product A1","price_text":"18","available":true}]'::jsonb
);
select pg_temp.p1b_assert(
  (select status = 'prepared' and file_checksum = repeat('8', 64)
   from supplier_price_submission_intakes
   where id = '71000000-0000-0000-0000-000000000008'),
  'service-only intake was not prepared from the claimed object'
);
reset role;

select set_config('request.jwt.claim.sub', '21000000-0000-0000-0000-000000000003', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

-- Active office uploaders read the tenant price catalog while tenant B remains invisible.
select pg_temp.p1b_assert(
  (select count(*) = 2 from supplier_products),
  'office current-price RLS did not expose the tenant catalog'
);
select pg_temp.p1b_assert(
  (select count(*) = 2 from price_history),
  'office price history RLS did not expose the tenant catalog'
);
select pg_temp.p1b_assert(
  (select count(*) = 1 from supplier_price_submissions),
  'office receipt RLS did not preserve tenant isolation'
);
select pg_temp.p1b_assert(
  exists (
    select 1 from storage.objects
    where bucket_id = 'price-submissions'
      and name = '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/66000000-0000-4000-8000-000000000008/service-stage.csv'
  )
  and not exists (
    select 1 from storage.objects
    where bucket_id = 'price-submissions'
      and name in (
        '11000000-0000-0000-0000-000000000002/price-submissions/31000000-0000-0000-0000-000000000003/68000000-0000-4000-8000-000000000002/tenant-stage.csv',
        '11000000-0000-0000-0000-000000000002/price-submissions/31000000-0000-0000-0000-000000000003/62000000-0000-0000-0000-000000000002/tenant-ledger.csv'
      )
  ),
  'office Storage RLS crossed the tenant boundary'
);

with deleted as (
  delete from storage.objects
  where bucket_id = 'price-submissions'
    and name in (
      '11000000-0000-0000-0000-000000000002/price-submissions/31000000-0000-0000-0000-000000000003/68000000-0000-4000-8000-000000000002/tenant-stage.csv'
    )
  returning 1
)
select pg_temp.p1b_assert(
  (select count(*) = 0 from deleted),
  'office could delete second-tenant staging'
);

with deleted as (
  delete from storage.objects
  where bucket_id = 'price-submissions'
    and name = '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/66000000-0000-4000-8000-000000000008/service-stage.csv'
  returning 1
)
select pg_temp.p1b_assert(
  (select count(*) = 0 from deleted),
  'active trusted intake did not block uploader deletion'
);
reset role;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select pg_temp.p1b_assert(
  exists (
    select 1 from storage.objects
    where bucket_id = 'price-submissions'
      and name = '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/66000000-0000-4000-8000-000000000008/service-stage.csv'
  ),
  'uploader deleted an object while its trusted intake was active'
);
select pg_temp.p1b_assert(
  discard_supplier_price_intake(
    '71000000-0000-0000-0000-000000000008',
    '21000000-0000-0000-0000-000000000003'
  ),
  'service-only intake was not discarded'
);

-- Replacing the object after the claim cannot smuggle different bytes into the prepared
-- payload. Change its immutable identity explicitly: Storage's updated_at trigger uses now(),
-- which is transaction-stable and therefore cannot model a version change in this harness.
select claim_supplier_price_intake(
  '74000000-0000-0000-0000-000000000009',
  '21000000-0000-0000-0000-000000000003',
  '31000000-0000-0000-0000-000000000001',
  '64000000-0000-4000-8000-000000000009',
  '2026-08-01', 'changed-stage.csv',
  '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/64000000-0000-4000-8000-000000000009/changed-stage.csv',
  'changed object rejection'
);
reset role;
update storage.objects
set id = '65000000-0000-4000-8000-000000000009'
where bucket_id = 'price-submissions'
  and name = '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/64000000-0000-4000-8000-000000000009/changed-stage.csv';
set local role service_role;
do $$
begin
  perform prepare_supplier_price_intake(
    '74000000-0000-0000-0000-000000000009',
    '21000000-0000-0000-0000-000000000003', repeat('9', 64), 100,
    '[{"source_row":2,"product_id":"41000000-0000-0000-0000-000000000001","product_name":"P1B Product A1","price_text":"19","available":true}]'::jsonb
  );
  raise exception 'expected changed object rejection';
exception when sqlstate 'P0001' then
  if sqlerrm not like '%price_submission_file_changed%' then raise; end if;
end
$$;
select pg_temp.p1b_assert(
  discard_supplier_price_intake(
    '74000000-0000-0000-0000-000000000009',
    '21000000-0000-0000-0000-000000000003'
  ),
  'changed object intake was not released'
);
reset role;
select set_config('request.jwt.claim.sub', '21000000-0000-0000-0000-000000000003', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

do $$
begin
  perform submit_supplier_price_list('79900000-0000-0000-0000-000000000001');
  raise exception 'expected direct submit without trusted intake rejection';
exception when sqlstate 'P0002' then
  if sqlerrm not like '%price_submission_intake_required%' then raise; end if;
end
$$;

-- Calling any revoked function under SET ROLE crashes the local Supabase PostgreSQL 17.6
-- backend (also reproduced with a trivial function). Assert the effective ACL directly;
-- successful service_role execution of claim_supplier_price_intake is exercised above.
select pg_temp.p1b_assert(
  not has_function_privilege(
    'authenticated',
    'public.p1b_submit_supplier_price_list_internal(uuid,uuid,date,text,text,text,jsonb,text)',
    'EXECUTE'
  ),
  'authenticated can execute the internal price-list command'
);
select pg_temp.p1b_assert(
  not has_function_privilege(
    'authenticated',
    'public.claim_supplier_price_intake(uuid,uuid,uuid,uuid,date,text,text,text)',
    'EXECUTE'
  ),
  'authenticated can execute the service intake command'
);

do $$
begin
  insert into supplier_price_submission_intakes (id)
  values ('79900000-0000-0000-0000-000000000003');
  raise exception 'expected direct intake table insert rejection';
exception when insufficient_privilege then null;
end
$$;
do $$
begin
  perform 1 from supplier_price_submission_intakes limit 1;
  raise exception 'expected direct intake table read rejection';
exception when insufficient_privilege then null;
end
$$;

insert into storage.objects (bucket_id, name, owner, metadata) values (
  'price-submissions',
  '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/69000000-0000-4000-8000-000000000009/own-policy.csv',
  auth.uid(), '{"mimetype":"text/csv","size":10}'::jsonb
);
insert into storage.objects (bucket_id, name, owner, metadata) values (
  'price-submissions',
  '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000002/69000000-0000-4000-8000-000000000010/another-supplier-policy.csv',
  auth.uid(), '{"mimetype":"text/csv","size":10}'::jsonb
);
do $$
begin
    insert into storage.objects (bucket_id, name, owner, metadata) values (
      'price-submissions',
      '11000000-0000-0000-0000-000000000002/price-submissions/31000000-0000-0000-0000-000000000001/69000000-0000-4000-8000-000000000011/tenant-policy.csv',
      auth.uid(), '{"mimetype":"text/csv","size":10}'::jsonb
  );
  raise exception 'expected tenant Storage insert rejection';
exception when insufficient_privilege then null;
end
$$;
select pg_temp.p1b_assert(
  exists (
    select 1 from storage.objects
    where bucket_id = 'price-submissions'
      and name = '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/69000000-0000-4000-8000-000000000009/own-policy.csv'
  ),
  'office could not read its tenant-scoped staging object'
);
with deleted as (
  delete from storage.objects
  where bucket_id = 'price-submissions'
    and name = '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/69000000-0000-4000-8000-000000000009/own-policy.csv'
  returning 1
)
select pg_temp.p1b_assert(
  (select count(*) = 1 from deleted),
  'office could not delete its inactive staging orphan'
);

-- The old batch RPC remains for owner/office but is not a finance-role bypass.
reset role;
select set_config('request.jwt.claim.sub', '21000000-0000-0000-0000-000000000005', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
do $$
begin
  perform import_supplier_prices(
    '[{"supplier_id":"31000000-0000-0000-0000-000000000001","product_id":"41000000-0000-0000-0000-000000000001","price":11,"available":true}]'::jsonb,
    '2026-07-01', 'accountant attempted the procurement route'
  );
  raise exception 'expected accountant import rejection';
exception when sqlstate '42501' then
  if sqlerrm not like '%price_import_not_authorized%' then raise; end if;
end
$$;

reset role;
select set_config('request.jwt.claim.sub', '21000000-0000-0000-0000-000000000003', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

-- One known row commits while an unknown product receives an actionable rejection. No catalog
-- product is created from the uploaded name.
select pg_temp.p1b_assert(
  (submit_supplier_price_list('71000000-0000-0000-0000-000000000001')->>'status')
    = 'accepted_with_rejections',
  'partial submission status is wrong'
);
select pg_temp.p1b_assert(
  (select revision = 1 and accepted_count = 1 and rejected_count = 1 and unchanged_count = 0
          and row_count = 2 and created_count = 0 and updated_count = 1
     from supplier_price_submissions
    where id = '61000000-0000-0000-0000-000000000001'),
  'first receipt counts or revision are wrong'
);
select pg_temp.p1b_assert(
  (select current_price = 12 and previous_price = 10
     from supplier_products where id = '51000000-0000-0000-0000-000000000001'),
  'accepted price did not commit'
);
select pg_temp.p1b_assert(
  (select count(*) = 2 from price_history
    where supplier_product_id = '51000000-0000-0000-0000-000000000001'),
  'accepted price and history were not committed together'
);
select pg_temp.p1b_assert(
  (select count(*) = 2 from products where org_id = '11000000-0000-0000-0000-000000000001'),
  'unknown supplier row created a catalog product'
);

-- Inspect immutable command evidence as the database owner, then restore the office uploader.
reset role;
select pg_temp.p1b_assert(
  exists (
    select 1 from audit_logs
    where action = 'supplier_price_submission_processed'
      and entity_id = '61000000-0000-0000-0000-000000000001'
      and reason = 'monthly supplier submission'
  ),
  'submission audit is missing'
);
select set_config('request.jwt.claim.sub', '21000000-0000-0000-0000-000000000003', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
do $$
begin
  delete from supplier_price_submissions
  where id = '61000000-0000-0000-0000-000000000001';
  raise exception 'expected immutable receipt rejection';
exception when insufficient_privilege then
  null;
end
$$;
delete from storage.objects
where bucket_id = 'price-submissions'
  and name = '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/61000000-0000-0000-0000-000000000001/july.csv';
select pg_temp.p1b_assert(
  exists (
    select 1 from storage.objects
    where bucket_id = 'price-submissions'
      and name = '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/61000000-0000-0000-0000-000000000001/july.csv'
  ),
  'registered submission file was deletable'
);

-- Same month + checksum is idempotent even when the caller retries with a fresh staging id.
select pg_temp.p1b_assert(
  (select retry ->> 'submission_id' = '61000000-0000-0000-0000-000000000001'
          and (retry ->> 'idempotent')::boolean
   from (
     select submit_supplier_price_list(
       '71000000-0000-0000-0000-000000000002'
     ) as retry
   ) result),
  'checksum retry did not return the first receipt'
);
select pg_temp.p1b_assert(
  (select count(*) = 1
   from supplier_price_submissions
   where supplier_id = '31000000-0000-0000-0000-000000000001'
     and target_month = '2026-07-01'),
  'checksum retry created another ledger revision'
);
select pg_temp.p1b_assert(
  (select count(*) = 2 from price_history
    where supplier_product_id = '51000000-0000-0000-0000-000000000001'),
  'checksum retry duplicated price history'
);
with deleted as (
  delete from storage.objects
  where bucket_id = 'price-submissions'
    and name = '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/61000000-0000-4000-8000-000000000002/same-bytes.csv'
  returning 1
)
select pg_temp.p1b_assert(
  (select count(*) = 1 from deleted),
  'idempotent retry staging orphan was not removable by its uploader'
);

-- A corrected file for the same month creates revision 2 instead of overwriting revision 1.
select pg_temp.p1b_assert(
  (submit_supplier_price_list('71000000-0000-0000-0000-000000000003')->>'revision')::integer = 2,
  'corrected file did not create revision 2'
);
select pg_temp.p1b_assert(
  (select count(*) = 2 and max(revision) = 2
   from supplier_price_submissions
   where supplier_id = '31000000-0000-0000-0000-000000000001'
     and target_month = '2026-07-01'),
  'revision history was overwritten or duplicated'
);
select pg_temp.p1b_assert(
  (select current_price = 15 from supplier_products
    where id = '51000000-0000-0000-0000-000000000001'),
  'revision 2 price did not commit'
);

-- Missing Storage bytes fail at the service-only claim, before a trusted payload or price write.
reset role;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
do $$
begin
  perform claim_supplier_price_intake(
    '71000000-0000-0000-0000-000000000004',
    '21000000-0000-0000-0000-000000000003',
    '31000000-0000-0000-0000-000000000001',
    '61000000-0000-0000-0000-000000000004',
    '2026-07-01', 'missing.csv',
    '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/61000000-0000-0000-0000-000000000004/missing.csv',
    'missing object rollback'
  );
  raise exception 'expected missing object rejection';
exception when sqlstate 'P0002' then
  if sqlerrm not like '%price_submission_file_missing%' then raise; end if;
end
$$;
reset role;
select set_config('request.jwt.claim.sub', '21000000-0000-0000-0000-000000000003', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select pg_temp.p1b_assert(
  (select current_price = 15 from supplier_products
    where id = '51000000-0000-0000-0000-000000000001'),
  'missing file changed the price'
);
select pg_temp.p1b_assert(
  not exists (
    select 1 from supplier_price_submissions
    where id = '61000000-0000-0000-0000-000000000004'
  ),
  'missing file left a ledger row'
);

-- A database failure after the atomic importer ran rolls back price, history and ledger. The
-- temporary trigger exists only inside this test transaction.
reset role;
create function pg_temp.p1b_force_ledger_failure()
returns trigger language plpgsql as $$
begin
  raise exception 'forced_p1b_ledger_failure';
end
$$;
create trigger p1b_force_ledger_failure
  before insert on supplier_price_submissions
  for each row execute function pg_temp.p1b_force_ledger_failure();

select set_config('request.jwt.claim.sub', '21000000-0000-0000-0000-000000000003', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
do $$
begin
  perform submit_supplier_price_list('71000000-0000-0000-0000-000000000005');
  raise exception 'expected forced ledger failure';
exception when others then
  if sqlerrm not like '%forced_p1b_ledger_failure%' then raise; end if;
end
$$;

reset role;
drop trigger p1b_force_ledger_failure on supplier_price_submissions;
select pg_temp.p1b_assert(
  (select current_price = 15 from supplier_products
    where id = '51000000-0000-0000-0000-000000000001'),
  'ledger failure left a partial price update'
);
select pg_temp.p1b_assert(
  (select count(*) = 3 from price_history
    where supplier_product_id = '51000000-0000-0000-0000-000000000001'),
  'ledger failure left partial price history'
);
select pg_temp.p1b_assert(
  not exists (
    select 1 from supplier_price_submissions
    where id = '61000000-0000-4000-8000-000000000005'
  ),
  'ledger failure left a submission receipt'
);
select pg_temp.p1b_assert(
  exists (
    select 1 from supplier_price_submission_intakes
    where id = '71000000-0000-0000-0000-000000000005' and status = 'prepared'
  ),
  'failed database transaction consumed the trusted intake'
);

-- The Edge Function releases a failed intake, after which the uploader can remove the orphan.
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select discard_supplier_price_intake(
  '71000000-0000-0000-0000-000000000005',
  '21000000-0000-0000-0000-000000000003'
);
reset role;
select set_config('request.jwt.claim.sub', '21000000-0000-0000-0000-000000000003', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
delete from storage.objects
where bucket_id = 'price-submissions'
  and name = '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/61000000-0000-4000-8000-000000000005/db-failure.csv';
reset role;
select pg_temp.p1b_assert(
  not exists (
    select 1 from storage.objects
    where bucket_id = 'price-submissions'
      and name = '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/61000000-0000-4000-8000-000000000005/db-failure.csv'
  ),
  'uploader could not remove an unregistered orphan'
);

-- The trusted staging command accepts any supplier in the office actor's tenant, while a second
-- tenant remains impossible even when the Edge request supplies all identifiers directly.
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select claim_supplier_price_intake(
  '71000000-0000-0000-0000-000000000006',
  '21000000-0000-0000-0000-000000000003',
  '31000000-0000-0000-0000-000000000002',
  '68000000-0000-4000-8000-000000000001',
  '2026-07-01', 'competitor-stage.csv',
  '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000002/68000000-0000-4000-8000-000000000001/competitor-stage.csv',
  'office stages another tenant supplier'
);
select pg_temp.p1b_assert(
  discard_supplier_price_intake(
    '71000000-0000-0000-0000-000000000006',
    '21000000-0000-0000-0000-000000000003'
  ),
  'office could not discard another supplier staging intake'
);
do $$
begin
  perform claim_supplier_price_intake(
    '71000000-0000-0000-0000-000000000007',
    '21000000-0000-0000-0000-000000000003',
    '31000000-0000-0000-0000-000000000003',
    '61000000-0000-0000-0000-000000000007',
    '2026-07-01', 'tenant-b.csv',
    '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000003/61000000-0000-0000-0000-000000000007/tenant-b.csv',
    'tenant crossing attempt'
  );
  raise exception 'expected tenant rejection';
exception when sqlstate 'P0002' then
  if sqlerrm not like '%price_submission_supplier_invalid%' then raise; end if;
end
$$;

-- Accountants preserve their P0 contract: no receipt visibility, no Storage visibility and no
-- execution of the trusted submit command.
reset role;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '21000000-0000-0000-0000-000000000005', true);
set local role authenticated;
do $$
begin
  perform submit_supplier_price_list('79900000-0000-0000-0000-000000000005');
  raise exception 'expected accountant submit rejection';
exception when sqlstate '42501' then
  if sqlerrm not like '%price_submission_not_authorized%' then raise; end if;
end
$$;
select pg_temp.p1b_assert(
  (select count(*) = 0 from supplier_price_submissions)
  and (select count(*) = 0 from storage.objects where bucket_id = 'price-submissions'),
  'accountant can read price submission receipts or files'
);

reset role;
select set_config('request.jwt.claim.sub', '21000000-0000-0000-0000-000000000006', true);
set local role authenticated;
do $$
begin
  perform submit_supplier_price_list('79900000-0000-0000-0000-000000000006');
  raise exception 'expected accountant submit rejection';
exception when sqlstate '42501' then
  if sqlerrm not like '%price_submission_not_authorized%' then raise; end if;
end
$$;
select pg_temp.p1b_assert(
  (select count(*) = 0 from supplier_price_submissions)
  and (select count(*) = 0 from storage.objects where bucket_id = 'price-submissions'),
  'accountant can read price submission receipts or files'
);

-- Owner and office retain the approved management path. Both claims are created from their
-- uploader-owned objects by the service boundary, then consumed under the original user JWT.
reset role;
select set_config('request.jwt.claim.sub', '21000000-0000-0000-0000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select pg_temp.p1b_assert(
  auth.uid() = '21000000-0000-0000-0000-000000000001',
  'owner Storage fixture has the wrong auth.uid'
);
select pg_temp.p1b_assert(
  auth_org() = '11000000-0000-0000-0000-000000000001',
  'owner Storage fixture has the wrong auth_org'
);
select pg_temp.p1b_assert(
  auth_role() = 'owner',
  'owner Storage fixture has the wrong auth_role'
);
-- The Storage policy joins suppliers by id; what it needs is that `authenticated` can READ the
-- table, not that the grant is written at table granularity. 0112 replaced the table grant with
-- per-column grants so that bank_details is out of the browser's reach -- a column privilege is
-- the only thing that can hide a column, since RLS cannot -- and `id` is exactly what this
-- policy reads.
select pg_temp.p1b_assert(
  has_column_privilege('authenticated', 'public.suppliers', 'id', 'select')
  and has_column_privilege('authenticated', 'public.suppliers', 'org_id', 'select'),
  'authenticated role lacks supplier visibility required by the Storage policy'
);
select pg_temp.p1b_assert(
  exists (
    select 1 from suppliers
    where org_id = auth_org()
      and id = '31000000-0000-0000-0000-000000000002'
      and deleted_at is null
  ),
  'owner cannot see the active target supplier required by the Storage policy'
);
select pg_temp.p1b_assert(
  array_length(storage.foldername(
    '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000002/63000000-0000-4000-8000-000000000001/owner-submit.csv'
  ), 1) = 4,
  'owner Storage path does not contain four folders'
);
select pg_temp.p1b_assert(
  (storage.foldername(
    '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000002/63000000-0000-4000-8000-000000000001/owner-submit.csv'
  ))[1] = auth_org()::text
  and (storage.foldername(
    '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000002/63000000-0000-4000-8000-000000000001/owner-submit.csv'
  ))[2] = 'price-submissions'
  and (storage.foldername(
    '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000002/63000000-0000-4000-8000-000000000001/owner-submit.csv'
  ))[3] = '31000000-0000-0000-0000-000000000002',
  'owner Storage path tenant, bucket folder or supplier folder is invalid'
);
select pg_temp.p1b_assert(
  (storage.foldername(
    '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000002/63000000-0000-4000-8000-000000000001/owner-submit.csv'
  ))[4] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  'owner Storage submission folder is not a valid UUID'
);
select pg_temp.p1b_assert(
  auth.uid() is not null
  and lower('{"mimetype":"text/csv","size":100}'::jsonb ->> 'mimetype') = 'text/csv',
  'owner Storage owner or MIME predicate is invalid'
);
insert into storage.objects (bucket_id, name, owner, metadata) values (
  'price-submissions',
  '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000002/63000000-0000-4000-8000-000000000001/owner-submit.csv',
  auth.uid(), '{"mimetype":"text/csv","size":100}'::jsonb
);
do $$
begin
  insert into storage.objects (bucket_id, name, owner, metadata) values (
    'price-submissions',
    '11000000-0000-0000-0000-000000000002/price-submissions/31000000-0000-0000-0000-000000000003/63000000-0000-4000-8000-000000000003/owner-cross-tenant.csv',
    auth.uid(), '{"mimetype":"text/csv","size":100}'::jsonb
  );
  raise exception 'expected owner cross-tenant Storage insert rejection';
exception when insufficient_privilege then null;
end
$$;
reset role;
select set_config('request.jwt.claim.sub', '21000000-0000-0000-0000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
insert into storage.objects (bucket_id, name, owner, metadata) values (
  'price-submissions',
  '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000002/63000000-0000-4000-8000-000000000002/office-submit.csv',
  auth.uid(), '{"mimetype":"text/csv","size":100}'::jsonb
);
do $$
begin
  insert into storage.objects (bucket_id, name, owner, metadata) values (
    'price-submissions',
    '11000000-0000-0000-0000-000000000002/price-submissions/31000000-0000-0000-0000-000000000003/63000000-0000-4000-8000-000000000004/office-cross-tenant.csv',
    auth.uid(), '{"mimetype":"text/csv","size":100}'::jsonb
  );
  raise exception 'expected office cross-tenant Storage insert rejection';
exception when insufficient_privilege then null;
end
$$;
reset role;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select claim_supplier_price_intake(
  '73000000-0000-0000-0000-000000000001',
  '21000000-0000-0000-0000-000000000001',
  '31000000-0000-0000-0000-000000000002',
  '63000000-0000-4000-8000-000000000001',
  '2026-08-01', 'owner-submit.csv',
  '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000002/63000000-0000-4000-8000-000000000001/owner-submit.csv',
  'owner monthly submission'
);
select prepare_supplier_price_intake(
  '73000000-0000-0000-0000-000000000001',
  '21000000-0000-0000-0000-000000000001', repeat('f', 64), 100,
  '[{"source_row":2,"product_id":"41000000-0000-0000-0000-000000000002","product_name":"P1B Product A2","price_text":"21","available":true}]'::jsonb
);
select claim_supplier_price_intake(
  '73000000-0000-0000-0000-000000000002',
  '21000000-0000-0000-0000-000000000002',
  '31000000-0000-0000-0000-000000000002',
  '63000000-0000-4000-8000-000000000002',
  '2026-08-01', 'office-submit.csv',
  '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000002/63000000-0000-4000-8000-000000000002/office-submit.csv',
  'office monthly submission'
);
select prepare_supplier_price_intake(
  '73000000-0000-0000-0000-000000000002',
  '21000000-0000-0000-0000-000000000002', repeat('0', 64), 100,
  '[{"source_row":2,"product_id":"41000000-0000-0000-0000-000000000002","product_name":"P1B Product A2","price_text":"21.5","available":true}]'::jsonb
);

reset role;
select set_config('request.jwt.claim.sub', '21000000-0000-0000-0000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select pg_temp.p1b_assert(
  (submit_supplier_price_list('73000000-0000-0000-0000-000000000001')->>'revision')::integer = 1,
  'owner could not consume its trusted management intake'
);

reset role;
select set_config('request.jwt.claim.sub', '21000000-0000-0000-0000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select pg_temp.p1b_assert(
  (submit_supplier_price_list('73000000-0000-0000-0000-000000000002')->>'revision')::integer = 2,
  'office could not consume its trusted management intake'
);
select pg_temp.p1b_assert(
  (select current_price = 21.5 from supplier_products
   where id = '51000000-0000-0000-0000-000000000002'),
  'owner/office trusted submissions did not serialize their revisions'
);

-- Manager legacy import remains available and retains its all-or-nothing 0023 behavior.
reset role;
select set_config('request.jwt.claim.sub', '21000000-0000-0000-0000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select import_supplier_prices(
  '[{"supplier_id":"31000000-0000-0000-0000-000000000002","product_id":"41000000-0000-0000-0000-000000000002","price":22,"available":true}]'::jsonb,
  '2026-07-01', 'manager legacy import regression'
);
select pg_temp.p1b_assert(
  (select current_price = 22 from supplier_products
    where id = '51000000-0000-0000-0000-000000000002'),
  'office legacy importer was not preserved'
);

-- Reviewed OCR bridge: owner and office can upload and enqueue a price-list document for any
-- supplier in their tenant; the tenant boundary remains server-owned.
reset role;
insert into products (id, org_id, name, unit) values (
  '41000000-0000-4000-8000-000000000048',
  '11000000-0000-0000-0000-000000000001',
  'P1B OCR Product A1', 'unit'
);
insert into supplier_products (
  id, org_id, supplier_id, product_id, current_price, price_effective_date, available
) values (
  '51000000-0000-4000-8000-000000000048',
  '11000000-0000-0000-0000-000000000001',
  '31000000-0000-0000-0000-000000000001',
  '41000000-0000-4000-8000-000000000048', 10, '2026-07-01', true
);
insert into price_history (org_id, supplier_product_id, price, effective_date) values (
  '11000000-0000-0000-0000-000000000001',
  '51000000-0000-4000-8000-000000000048', 10, '2026-07-01'
);

-- A complete supplier-B chain proves that RLS and confirmation reject real foreign context,
-- not only a malformed upload path.
insert into storage.objects (bucket_id, name, owner, metadata) values (
  'documents',
  '11000000-0000-0000-0000-000000000001/supplier/31000000-0000-0000-0000-000000000002/45000000-0000-4000-8000-000000000049/competitor.pdf',
  '21000000-0000-0000-0000-000000000008',
  jsonb_build_object(
    'mimetype', 'application/pdf', 'size', 2048, 'eTag', repeat('b', 64)
  )
);
insert into documents (
  id, org_id, entity_type, entity_id, supplier_id, storage_path,
  file_name, mime_type, document_kind, uploaded_by
) values (
  '45000000-0000-4000-8000-000000000049',
  '11000000-0000-0000-0000-000000000001',
  'supplier', '31000000-0000-0000-0000-000000000002',
  '31000000-0000-0000-0000-000000000002',
  '11000000-0000-0000-0000-000000000001/supplier/31000000-0000-0000-0000-000000000002/45000000-0000-4000-8000-000000000049/competitor.pdf',
  'competitor.pdf', 'application/pdf', 'price_list',
  '21000000-0000-0000-0000-000000000008'
);
insert into document_processing_jobs (
  id, org_id, document_id, requested_by, status, input_checksum,
  contract_version, interpretation_actor_id, interpretation_started_at
) values (
  '55000000-0000-4000-8000-000000000050',
  '11000000-0000-0000-0000-000000000001',
  '45000000-0000-4000-8000-000000000049',
  '21000000-0000-0000-0000-000000000008',
  'review', 'etag:' || repeat('b', 64), '1',
  '21000000-0000-0000-0000-000000000008', now()
);
insert into document_extractions (
  id, org_id, job_id, document_id, engine, model, model_version,
  input_checksum, contract_version, payload
) values (
  '65000000-0000-4000-8000-000000000050',
  '11000000-0000-0000-0000-000000000001',
  '55000000-0000-4000-8000-000000000050',
  '45000000-0000-4000-8000-000000000049',
  'fixture', 'fixture-model', '1', 'etag:' || repeat('b', 64), '1',
  jsonb_build_object(
    'schema_version', '1',
    'document', jsonb_build_object(
      'page_count', 1, 'detected_languages', jsonb_build_array('he'),
      'plain_text', 'מחירון מתחרה', 'partial', false
    ),
    'blocks', '[]'::jsonb, 'tables', '[]'::jsonb, 'marks', '[]'::jsonb
  )
);
insert into document_interpretations (
  id, org_id, job_id, extraction_id, document_id, interpreted_for_user_id,
  provider, model, prompt_version, schema_version, payload
) values (
  '75000000-0000-4000-8000-000000000050',
  '11000000-0000-0000-0000-000000000001',
  '55000000-0000-4000-8000-000000000050',
  '65000000-0000-4000-8000-000000000050',
  '45000000-0000-4000-8000-000000000049',
  '21000000-0000-0000-0000-000000000008',
  'anthropic', 'fixture-model', 'interpret-document-v1', '1',
  jsonb_build_object(
    'schema_version', '1', 'document_type', 'price_list',
    'document_type_confidence', 0.99,
    'supplier', jsonb_build_object(
      'suggested_id', '31000000-0000-0000-0000-000000000002',
      'suggested_name', 'P1B supplier A2', 'confidence', 0.99,
      'evidence_block_ids', '[]'::jsonb
    ),
    'fields', '[]'::jsonb,
    'line_items', jsonb_build_array(jsonb_build_object(
      'source_row', 1,
      'values', jsonb_build_object('product_name', 'Competitor product', 'price', '99'),
      'evidence_block_ids', '[]'::jsonb
    )),
    'suggested_annotations', '[]'::jsonb
  )
);
-- Staff may choose a supplier in their tenant, but the server still owns the UUID/path.
-- The fixture expired TWO HOURS ago -- past the one-hour sweep grace 0065 added -- so the
-- reserve call below still deletes it. The test's intent is unchanged (expired unused
-- claims get swept); 0065 only moved WHEN: a claim expired less than an hour stays
-- renewable and must survive the sweep (proven in p6b_upload_reservations.sql).
insert into supplier_price_document_upload_reservations (
  document_id, org_id, actor_id, supplier_id,
  file_name, mime_type, storage_path, created_at, expires_at
) values (
  '45000000-0000-4000-8000-000000000087',
  '11000000-0000-0000-0000-000000000001',
  '21000000-0000-0000-0000-000000000001',
  '31000000-0000-0000-0000-000000000002',
  'expired.pdf', 'application/pdf',
  '11000000-0000-0000-0000-000000000001/supplier/31000000-0000-0000-0000-000000000002/45000000-0000-4000-8000-000000000087/expired.pdf',
  now() - interval '3 hours', now() - interval '2 hours'
);
select set_config('request.jwt.claim.sub', '21000000-0000-0000-0000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select reserve_supplier_price_document_upload(
  '31000000-0000-0000-0000-000000000002',
  'staff-prices.pdf', 'application/pdf'
)::text as staff_reservation
\gset ocr_
select
  :'ocr_staff_reservation'::jsonb ->> 'document_id' as staff_document_id,
  :'ocr_staff_reservation'::jsonb ->> 'storage_path' as staff_storage_path
\gset ocr_
insert into storage.objects (bucket_id, name, owner, metadata) values (
  'documents', :'ocr_staff_storage_path', auth.uid(),
  jsonb_build_object(
    'mimetype', 'application/pdf', 'size', 2048, 'eTag', repeat('d', 64)
  )
);
select register_supplier_price_document(
  :'ocr_staff_document_id'::uuid
)::text as staff_registration
\gset ocr_
select pg_temp.p1b_assert(
  :'ocr_staff_reservation'::jsonb ->> 'storage_path'
    like '11000000-0000-0000-0000-000000000001/supplier/31000000-0000-0000-0000-000000000002/%/staff-prices.pdf'
  and not (:'ocr_staff_registration'::jsonb ->> 'idempotent')::boolean
  and exists (
    select 1 from documents d
    where d.id = :'ocr_staff_document_id'::uuid
      and d.org_id = '11000000-0000-0000-0000-000000000001'
      and d.supplier_id = '31000000-0000-0000-0000-000000000002'
      and d.uploaded_by = auth.uid()
  )
  and exists (
    select 1 from document_processing_jobs j
    where j.id = (:'ocr_staff_registration'::jsonb ->> 'job_id')::uuid
      and j.document_id = :'ocr_staff_document_id'::uuid
      and j.requested_by = auth.uid()
  ),
  'owner reservation did not upload through the existing Storage policy and register one job'
);

reset role;
select pg_temp.p1b_assert(
  not exists (
    select 1 from supplier_price_document_upload_reservations
    where document_id = '45000000-0000-4000-8000-000000000087'
  ),
  'reserve did not clean up an expired unused reservation'
);
select set_config('request.jwt.claim.sub', '21000000-0000-0000-0000-000000000003', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select pg_temp.p1b_assert(
  not has_column_privilege('authenticated', 'public.documents', 'id', 'INSERT')
  and not has_table_privilege(
    'authenticated', 'public.supplier_price_document_upload_reservations', 'SELECT'
  )
  and not has_table_privilege(
    'authenticated', 'public.supplier_price_document_upload_reservations', 'INSERT'
  )
  and not has_table_privilege(
    'anon', 'public.supplier_price_document_upload_reservations', 'SELECT'
  )
  and not has_table_privilege(
    'anon', 'public.supplier_price_document_upload_reservations', 'INSERT'
  )
  and has_table_privilege(
    'service_role', 'public.supplier_price_document_upload_reservations', 'SELECT'
  )
  and has_table_privilege(
    'service_role', 'public.supplier_price_document_upload_reservations', 'INSERT'
  )
  and has_table_privilege(
    'service_role', 'public.supplier_price_document_upload_reservations', 'UPDATE'
  )
  and has_table_privilege(
    'service_role', 'public.supplier_price_document_upload_reservations', 'DELETE'
  ),
  'P0 reservation ACL is not browser-closed and service-role writable'
);

do $$
begin
  insert into public.documents (id) values (
    '45000000-0000-4000-8000-000000000088'
  );
  raise exception 'expected direct documents.id insert rejection';
exception when insufficient_privilege then null;
end
$$;

do $$
begin
  insert into storage.objects (bucket_id, name, owner, metadata) values (
    'documents',
    '11000000-0000-0000-0000-000000000001/supplier/31000000-0000-0000-0000-000000000001/45000000-0000-4000-8000-000000000089/no-reservation.pdf',
    auth.uid(),
    jsonb_build_object('mimetype', 'application/pdf', 'size', 2048, 'eTag', repeat('f', 64))
  );
  raise exception 'expected unreserved supplier Storage upload rejection';
exception when insufficient_privilege then null;
end
$$;

select reserve_supplier_price_document_upload(
  '31000000-0000-0000-0000-000000000001',
  'prices.pdf', 'application/pdf'
)::text as reservation
\gset ocr_
select
  :'ocr_reservation'::jsonb ->> 'document_id' as document_id,
  :'ocr_reservation'::jsonb ->> 'storage_path' as storage_path
\gset ocr_
select pg_temp.p1b_assert(
  (:'ocr_reservation'::jsonb ->> 'document_id')::uuid is not null
  and :'ocr_storage_path'
    = '11000000-0000-0000-0000-000000000001/supplier/31000000-0000-0000-0000-000000000001/'
      || :'ocr_document_id' || '/prices.pdf'
  and (:'ocr_reservation'::jsonb ->> 'expires_at')::timestamptz > now(),
  'server reservation did not return a canonical short-lived document path'
);

insert into storage.objects (bucket_id, name, owner, metadata) values (
  'documents', :'ocr_storage_path', auth.uid(),
  jsonb_build_object(
    'mimetype', 'application/pdf',
    'size', 2048,
    'eTag', repeat('a', 64)
  )
);

select register_supplier_price_document(
  :'ocr_document_id'::uuid
)::text as registration
\gset ocr_
select :'ocr_registration'::jsonb ->> 'job_id' as job_id
\gset ocr_
select register_supplier_price_document(
  :'ocr_document_id'::uuid
)::text as registration_retry
\gset ocr_

select pg_temp.p1b_assert(
  not (:'ocr_registration'::jsonb ->> 'idempotent')::boolean
  and (:'ocr_registration_retry'::jsonb ->> 'idempotent')::boolean
  and :'ocr_registration_retry'::jsonb ->> 'document_id' = :'ocr_document_id'
  and :'ocr_registration_retry'::jsonb ->> 'job_id' = :'ocr_job_id'
  and :'ocr_registration_retry'::jsonb ->> 'storage_path' = :'ocr_storage_path',
  'document registration retry did not return the original document and job'
);
select pg_temp.p1b_assert(
  (select requested_by = auth.uid() and input_checksum = 'etag:' || repeat('a', 64)
   from document_processing_jobs where id = :'ocr_job_id'::uuid),
  'server registration did not bind the uploader, enqueue job and current eTag'
);

-- Service-side extraction and interpretation preserve the exact job/document/extraction chain.
reset role;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
reset role;
update document_processing_jobs
set status = 'leased', lease_owner = 'p1b-test-worker', lease_until = now() + interval '1 minute'
where id = :'ocr_job_id'::uuid;

insert into document_extractions (
  id, org_id, job_id, document_id, engine, model, model_version,
  input_checksum, contract_version, payload
) values (
  '65000000-0000-4000-8000-000000000048',
  '11000000-0000-0000-0000-000000000001', :'ocr_job_id'::uuid,
  :'ocr_document_id'::uuid,
  'fixture', 'fixture-model', '1', 'etag:' || repeat('a', 64), '1',
  jsonb_build_object(
    'schema_version', '1',
    'document', jsonb_build_object(
      'page_count', 1, 'detected_languages', jsonb_build_array('he'),
      'plain_text', 'מחירון ספק', 'partial', false
    ),
    'blocks', '[]'::jsonb,
    'tables', '[]'::jsonb,
    'marks', '[]'::jsonb
  )
);
update document_processing_jobs
set status = 'extracted', lease_owner = null, lease_until = null
where id = :'ocr_job_id'::uuid;

set local role service_role;
select begin_document_interpretation(
  :'ocr_job_id'::uuid,
  '65000000-0000-4000-8000-000000000048',
  '21000000-0000-0000-0000-000000000003'
)::text as begin_payload
\gset ocr_

select save_document_interpretation(
  :'ocr_job_id'::uuid,
  '65000000-0000-4000-8000-000000000048',
  '21000000-0000-0000-0000-000000000003',
  (:'ocr_begin_payload'::jsonb ->> 'interpretation_started_at')::timestamptz,
  'anthropic', 'fixture-model', 'interpret-document-v1', '1',
  jsonb_build_object(
    'schema_version', '1',
    'document_type', 'price_list',
    'document_type_confidence', 0.99,
    'supplier', jsonb_build_object(
      'suggested_id', '31000000-0000-0000-0000-000000000001',
      'suggested_name', 'P1B supplier A1',
      'confidence', 0.99,
      'evidence_block_ids', '[]'::jsonb
    ),
    'fields', '[]'::jsonb,
    'line_items', jsonb_build_array(
      jsonb_build_object(
        'source_row', 1,
        'values', jsonb_build_object('product_name', 'P1B OCR Product A1', 'price', '24'),
        'evidence_block_ids', '[]'::jsonb
      ),
      jsonb_build_object(
        'source_row', 2,
        'values', jsonb_build_object('product_name', 'Unknown OCR product', 'price', '9'),
        'evidence_block_ids', '[]'::jsonb
      )
    ),
    'suggested_annotations', '[]'::jsonb
  ),
  '{}'::jsonb, 10
) as interpretation_id
\gset ocr_

reset role;
select set_config('request.jwt.claim.sub', '21000000-0000-0000-0000-000000000003', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select pg_temp.p1b_assert(
  exists (
    select 1 from documents where id = :'ocr_document_id'::uuid
  )
  and exists (
    select 1 from documents where id = '45000000-0000-4000-8000-000000000049'
  )
  and exists (
    select 1 from document_processing_jobs where id = :'ocr_job_id'::uuid
  )
  and exists (
    select 1 from document_processing_jobs
    where id = '55000000-0000-4000-8000-000000000050'
  )
  and exists (
    select 1 from document_extractions
    where id = '65000000-0000-4000-8000-000000000048'
  )
  and exists (
    select 1 from document_extractions
    where id = '65000000-0000-4000-8000-000000000050'
  )
  and exists (
    select 1 from document_interpretations where id = :'ocr_interpretation_id'::uuid
  )
  and exists (
    select 1 from document_interpretations
    where id = '75000000-0000-4000-8000-000000000050'
  ),
  'office lost tenant-wide supplier document processing or interpretation visibility'
);
select pg_temp.p1b_assert(
  exists (
    select 1 from storage.objects
    where bucket_id = 'documents'
      and name = :'ocr_storage_path'
  )
  and exists (
    select 1 from storage.objects
    where bucket_id = 'documents'
      and name like '%/45000000-0000-4000-8000-000000000049/competitor.pdf'
  ),
  'office lost tenant-wide supplier source-object visibility'
);

reset role;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select prepare_ocr_supplier_price_intake(
  '79000000-0000-4000-8000-000000000048',
  '21000000-0000-0000-0000-000000000003',
  :'ocr_interpretation_id'::uuid,
  :'ocr_document_id'::uuid,
  :'ocr_interpretation_id'::uuid,
  '2026-09-01',
  jsonb_build_array(
    jsonb_build_object(
      'lineItemIndex', 0,
      'productId', '41000000-0000-4000-8000-000000000048',
      'priceText', '24', 'available', true
    ),
    jsonb_build_object(
      'lineItemIndex', 1,
      'productId', '49000000-0000-4000-8000-000000000048',
      'priceText', '9', 'available', true
    )
  ),
  'human approved OCR rows'
)::text as bridge
\gset ocr_

select count(*) as product_count_before from products
where org_id = '11000000-0000-0000-0000-000000000001'
\gset ocr_
select count(*) as history_count_before from price_history
where supplier_product_id = '51000000-0000-4000-8000-000000000048'
\gset ocr_

reset role;
select set_config('request.jwt.claim.sub', '21000000-0000-0000-0000-000000000003', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select submit_supplier_price_list(
  '79000000-0000-4000-8000-000000000048'
)::text as receipt
\gset ocr_

select pg_temp.p1b_assert(
  (:'ocr_receipt'::jsonb ->> 'submission_id')::uuid
    = :'ocr_interpretation_id'::uuid
  and (:'ocr_receipt'::jsonb ->> 'accepted_count')::integer = 1
  and (:'ocr_receipt'::jsonb ->> 'rejected_count')::integer = 1
  and :'ocr_receipt'::jsonb #>> '{rejections,0,reason}' = 'unknown_product',
  'OCR confirmation did not preserve accepted and unknown-product verdicts'
);
select pg_temp.p1b_assert(
  (select count(*) = :'ocr_product_count_before'::integer from products
   where org_id = '11000000-0000-0000-0000-000000000001')
  and not exists (
    select 1 from products where id = '49000000-0000-4000-8000-000000000048'
  ),
  'OCR confirmation created an unknown product'
);
select pg_temp.p1b_assert(
  (select current_price = 24 and price_effective_date = '2026-09-01'
   from supplier_products where id = '51000000-0000-4000-8000-000000000048')
  and (select status = 'completed' from document_processing_jobs where id = :'ocr_job_id'::uuid),
  'OCR confirmation did not commit price and document completion atomically'
);
select pg_temp.p1b_assert(
  (select source_document_id = :'ocr_document_id'::uuid
          and source_job_id = :'ocr_job_id'::uuid
          and source_extraction_id = '65000000-0000-4000-8000-000000000048'
          and source_interpretation_id = :'ocr_interpretation_id'::uuid
          and source_input_checksum = 'etag:' || repeat('a', 64)
   from supplier_price_submissions
   where id = :'ocr_interpretation_id'::uuid),
  'OCR ledger did not retain the immutable source provenance'
);

-- Same human confirmation, even under a new submission id, returns the original receipt.
reset role;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select prepare_ocr_supplier_price_intake(
  '79000000-0000-4000-8000-000000000049',
  '21000000-0000-0000-0000-000000000003',
  :'ocr_interpretation_id'::uuid,
  :'ocr_document_id'::uuid,
  :'ocr_interpretation_id'::uuid,
  '2026-09-01',
  jsonb_build_array(
    jsonb_build_object(
      'lineItemIndex', 1,
      'productId', '49000000-0000-4000-8000-000000000048',
      'priceText', '9', 'available', true
    ),
    jsonb_build_object(
      'lineItemIndex', 0,
       'productId', '41000000-0000-4000-8000-000000000048',
      'priceText', '24', 'available', true
    )
  ),
  'human approved OCR rows replay'
);
reset role;
select set_config('request.jwt.claim.sub', '21000000-0000-0000-0000-000000000003', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select submit_supplier_price_list(
  '79000000-0000-4000-8000-000000000049'
)::text as replay_receipt
\gset ocr_
select pg_temp.p1b_assert(
  (:'ocr_replay_receipt'::jsonb ->> 'submission_id')::uuid
    = :'ocr_interpretation_id'::uuid
  and (:'ocr_replay_receipt'::jsonb ->> 'idempotent')::boolean
  and (select count(*) = 1 from supplier_price_submissions
       where source_interpretation_id = :'ocr_interpretation_id'::uuid)
  and (select count(*) = :'ocr_history_count_before'::integer + 1 from price_history
       where supplier_product_id = '51000000-0000-4000-8000-000000000048'),
  'OCR replay created duplicate ledger or price history'
);

-- Staff provider failures use the same current-source fence and clean up the bound attempt.
reset role;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
reset role;
insert into document_processing_jobs (
  id, org_id, document_id, requested_by, status, input_checksum, contract_version
) values (
  '55000000-0000-4000-8000-000000000049',
  '11000000-0000-0000-0000-000000000001',
  :'ocr_document_id'::uuid,
  '21000000-0000-0000-0000-000000000003',
  'extracted', 'etag:' || repeat('a', 64), '1'
);
insert into document_extractions (
  id, org_id, job_id, document_id, engine, model, model_version,
  input_checksum, contract_version, payload
) select
  '65000000-0000-4000-8000-000000000049',
  '11000000-0000-0000-0000-000000000001',
  '55000000-0000-4000-8000-000000000049',
  :'ocr_document_id'::uuid,
  'fixture', 'fixture-model', '1', 'etag:' || repeat('a', 64), '1', payload
from document_extractions
where id = '65000000-0000-4000-8000-000000000048';
set local role service_role;
select begin_document_interpretation(
  '55000000-0000-4000-8000-000000000049',
  '65000000-0000-4000-8000-000000000049',
  '21000000-0000-0000-0000-000000000003'
)::text as failed_begin
\gset ocr_
select fail_document_interpretation(
  '55000000-0000-4000-8000-000000000049',
  '65000000-0000-4000-8000-000000000049',
  '21000000-0000-0000-0000-000000000003',
  (:'ocr_failed_begin'::jsonb ->> 'interpretation_started_at')::timestamptz,
  'provider_timeout', null
);
select pg_temp.p1b_assert(
  (select status = 'failed' and last_error_code = 'provider_timeout'
   from document_processing_jobs
   where id = '55000000-0000-4000-8000-000000000049'),
  'staff failure path left the job in interpreting state'
);

-- A changed source object is rejected before a new intake can reach the writer.
reset role;
update storage.objects
set metadata = metadata || jsonb_build_object('eTag', repeat('c', 64))
where bucket_id = 'documents'
  and name = :'ocr_storage_path';
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
do $$
declare
  v_document_id uuid;
  v_interpretation_id uuid;
begin
  select d.id into strict v_document_id
  from documents d
  where d.org_id = '11000000-0000-0000-0000-000000000001'
    and d.uploaded_by = '21000000-0000-0000-0000-000000000003'
    and d.file_name = 'prices.pdf';
  select i.id into strict v_interpretation_id
  from document_interpretations i
  where i.document_id = v_document_id
    and i.job_id <> '55000000-0000-4000-8000-000000000049';
  perform prepare_ocr_supplier_price_intake(
    '79000000-0000-4000-8000-000000000050',
    '21000000-0000-0000-0000-000000000003',
    v_interpretation_id,
    v_document_id,
    v_interpretation_id,
    '2026-10-01',
    jsonb_build_array(jsonb_build_object(
      'lineItemIndex', 0,
      'productId', '41000000-0000-4000-8000-000000000048',
      'priceText', '25', 'available', true
    )),
    'changed object must fail'
  );
  raise exception 'expected changed OCR source rejection';
exception when sqlstate 'P0001' then
  if sqlerrm not like '%price_submission_file_changed%' then raise; end if;
end
$$;
select pg_temp.p1b_assert(
  not exists (
    select 1 from supplier_price_submission_intakes
    where id = '79000000-0000-4000-8000-000000000050'
  ),
  'changed OCR object left a prepared intake'
);

-- The only authenticated price writer remains the intake-consuming command.
select pg_temp.p1b_assert(
  has_function_privilege(
    'authenticated', 'public.submit_supplier_price_list(uuid)', 'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.prepare_ocr_supplier_price_intake(uuid,uuid,uuid,uuid,uuid,date,jsonb,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.p1b_submit_supplier_price_list_internal(uuid,uuid,date,text,text,text,jsonb,text)',
    'EXECUTE'
  ),
  'OCR bridge exposed a second authenticated price writer'
);

reset role;
select 'p1_price_submissions: all assertions passed' as result;
rollback;
