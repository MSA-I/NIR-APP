-- P1B supplier price submission regression harness. Run only against an isolated local
-- database after applying migrations through 0031_p1b_uploader_orphan_cleanup.sql.
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
  ('21000000-0000-0000-0000-000000000003', 'supplier-p1b@example.test'),
  ('21000000-0000-0000-0000-000000000004', 'owner-b-p1b@example.test'),
  ('21000000-0000-0000-0000-000000000005', 'payer-p1b@example.test'),
  ('21000000-0000-0000-0000-000000000006', 'accountant-p1b@example.test'),
  ('21000000-0000-0000-0000-000000000007', 'kitchen-p1b@example.test');

insert into profiles (id, org_id, full_name, role) values
  ('21000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', 'P1B owner', 'owner'),
  ('21000000-0000-0000-0000-000000000002', '11000000-0000-0000-0000-000000000001', 'P1B office', 'office'),
  ('21000000-0000-0000-0000-000000000004', '11000000-0000-0000-0000-000000000002', 'P1B owner B', 'owner'),
  ('21000000-0000-0000-0000-000000000005', '11000000-0000-0000-0000-000000000001', 'P1B payer', 'payer'),
  ('21000000-0000-0000-0000-000000000006', '11000000-0000-0000-0000-000000000001', 'P1B accountant', 'accountant'),
  ('21000000-0000-0000-0000-000000000007', '11000000-0000-0000-0000-000000000001', 'P1B kitchen', 'kitchen');

insert into suppliers (id, org_id, name) values
  ('31000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', 'P1B supplier A1'),
  ('31000000-0000-0000-0000-000000000002', '11000000-0000-0000-0000-000000000001', 'P1B supplier A2'),
  ('31000000-0000-0000-0000-000000000003', '11000000-0000-0000-0000-000000000002', 'P1B supplier B1');

insert into profiles (id, org_id, full_name, role, supplier_id) values (
  '21000000-0000-0000-0000-000000000003',
  '11000000-0000-0000-0000-000000000001',
  'P1B supplier agent', 'supplier',
  '31000000-0000-0000-0000-000000000001'
);

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
  file_checksum, status, accepted_count, rejected_count, unchanged_count, submitted_by
) values
  (
    '62000000-0000-0000-0000-000000000001',
    '11000000-0000-0000-0000-000000000001',
    '31000000-0000-0000-0000-000000000002', '2026-07-01', 1,
    'competitor-ledger.csv',
    '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000002/62000000-0000-0000-0000-000000000001/competitor-ledger.csv',
    repeat('c', 64), 'accepted', 1, 0, 0,
    '21000000-0000-0000-0000-000000000002'
  ),
  (
    '62000000-0000-0000-0000-000000000002',
    '11000000-0000-0000-0000-000000000002',
    '31000000-0000-0000-0000-000000000003', '2026-07-01', 1,
    'tenant-ledger.csv',
    '11000000-0000-0000-0000-000000000002/price-submissions/31000000-0000-0000-0000-000000000003/62000000-0000-0000-0000-000000000002/tenant-ledger.csv',
    repeat('d', 64), 'accepted', 1, 0, 0,
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

-- P0 regression: the supplier reads only its own current prices, never a competitor or tenant B.
select pg_temp.p1b_assert(
  (select count(*) = 1 from supplier_products),
  'supplier current-price RLS did not isolate its own supplier'
);
select pg_temp.p1b_assert(
  (select count(*) = 1 from price_history),
  'supplier history RLS did not isolate its own supplier'
);
select pg_temp.p1b_assert(
  (select count(*) = 0 from supplier_price_submissions),
  'supplier receipt RLS exposed a competitor or second tenant'
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
        '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000002/68000000-0000-4000-8000-000000000001/competitor-stage.csv',
        '11000000-0000-0000-0000-000000000002/price-submissions/31000000-0000-0000-0000-000000000003/68000000-0000-4000-8000-000000000002/tenant-stage.csv',
        '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000002/62000000-0000-0000-0000-000000000001/competitor-ledger.csv',
        '11000000-0000-0000-0000-000000000002/price-submissions/31000000-0000-0000-0000-000000000003/62000000-0000-0000-0000-000000000002/tenant-ledger.csv'
      )
  ),
  'supplier Storage RLS did not isolate uploader staging, competitor and second tenant files'
);

with deleted as (
  delete from storage.objects
  where bucket_id = 'price-submissions'
    and name in (
      '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000002/68000000-0000-4000-8000-000000000001/competitor-stage.csv',
      '11000000-0000-0000-0000-000000000002/price-submissions/31000000-0000-0000-0000-000000000003/68000000-0000-4000-8000-000000000002/tenant-stage.csv'
    )
  returning 1
)
select pg_temp.p1b_assert(
  (select count(*) = 0 from deleted),
  'supplier could delete competitor or second-tenant staging'
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

do $$
begin
  perform p1b_submit_supplier_price_list_internal(
    '69900000-0000-0000-0000-000000000001',
    '31000000-0000-0000-0000-000000000001', '2026-07-01', 'bypass.csv',
    '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/69900000-0000-0000-0000-000000000001/bypass.csv',
    repeat('9', 64), '[]'::jsonb, 'direct bypass attempt'
  );
  raise exception 'expected internal command privilege rejection';
exception when insufficient_privilege then null;
end
$$;

do $$
begin
  perform claim_supplier_price_intake(
    '79900000-0000-0000-0000-000000000002', auth.uid(),
    '31000000-0000-0000-0000-000000000001',
    '69900000-0000-0000-0000-000000000002', '2026-07-01', 'bypass.csv',
    '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/69900000-0000-0000-0000-000000000002/bypass.csv',
    'direct service command attempt'
  );
  raise exception 'expected service staging privilege rejection';
exception when insufficient_privilege then null;
end
$$;

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
do $$
begin
    insert into storage.objects (bucket_id, name, owner, metadata) values (
      'price-submissions',
      '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000002/69000000-0000-4000-8000-000000000010/competitor-policy.csv',
      auth.uid(), '{"mimetype":"text/csv","size":10}'::jsonb
  );
  raise exception 'expected competitor Storage insert rejection';
exception when insufficient_privilege then null;
end
$$;
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
  'supplier could not read its own tenant-scoped staging object'
);
with deleted as (
  delete from storage.objects
  where bucket_id = 'price-submissions'
    and name = '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/69000000-0000-4000-8000-000000000009/own-policy.csv'
  returning 1
)
select pg_temp.p1b_assert(
  (select count(*) = 1 from deleted),
  'supplier could not delete its own inactive staging orphan'
);

-- The old batch RPC remains for owner/office but is no longer a supplier bypass.
do $$
begin
  perform import_supplier_prices(
    '[{"supplier_id":"31000000-0000-0000-0000-000000000001","product_id":"41000000-0000-0000-0000-000000000001","price":11,"available":true}]'::jsonb,
    '2026-07-01', 'supplier attempted the legacy route'
  );
  raise exception 'expected legacy supplier import rejection';
exception when sqlstate '42501' then
  if sqlerrm not like '%price_import_not_authorized%' then raise; end if;
end
$$;

-- One known row commits while an unknown product receives an actionable rejection. No catalog
-- product is created from the uploaded name.
select pg_temp.p1b_assert(
  (submit_supplier_price_list('71000000-0000-0000-0000-000000000001')->>'status')
    = 'accepted_with_rejections',
  'partial submission status is wrong'
);
select pg_temp.p1b_assert(
  (select revision = 1 and accepted_count = 1 and rejected_count = 1 and unchanged_count = 0
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

-- Suppliers must not read the audit ledger. Inspect the command evidence as the database
-- owner, then restore the supplier JWT/role before continuing the caller-facing assertions.
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
  (select count(*) = 1 from supplier_price_submissions),
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
  (select count(*) = 2 and max(revision) = 2 from supplier_price_submissions),
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

-- Even the trusted staging command revalidates actor/supplier/tenant instead of trusting Edge
-- request fields. A supplier cannot redirect it to a competitor or a second tenant.
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
do $$
begin
  perform claim_supplier_price_intake(
    '71000000-0000-0000-0000-000000000006',
    '21000000-0000-0000-0000-000000000003',
    '31000000-0000-0000-0000-000000000002',
    '61000000-0000-0000-0000-000000000006',
    '2026-07-01', 'competitor.csv',
    '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000002/61000000-0000-0000-0000-000000000006/competitor.csv',
    'competitor attempt'
  );
  raise exception 'expected competitor rejection';
exception when sqlstate '42501' then
  if sqlerrm not like '%price_submission_not_authorized%' then raise; end if;
end
$$;
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
exception when sqlstate '42501' then
  if sqlerrm not like '%price_submission_not_authorized%' then raise; end if;
end
$$;

-- Payer, accountant and kitchen preserve their P0 contract: no receipt visibility, no Storage
-- visibility and no execution of the trusted submit command.
reset role;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '21000000-0000-0000-0000-000000000005', true);
set local role authenticated;
do $$
begin
  perform submit_supplier_price_list('79900000-0000-0000-0000-000000000005');
  raise exception 'expected payer submit rejection';
exception when sqlstate '42501' then
  if sqlerrm not like '%price_submission_not_authorized%' then raise; end if;
end
$$;
select pg_temp.p1b_assert(
  (select count(*) = 0 from supplier_price_submissions)
  and (select count(*) = 0 from storage.objects where bucket_id = 'price-submissions'),
  'payer can read price submission receipts or files'
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

reset role;
select set_config('request.jwt.claim.sub', '21000000-0000-0000-0000-000000000007', true);
set local role authenticated;
do $$
begin
  perform submit_supplier_price_list('79900000-0000-0000-0000-000000000007');
  raise exception 'expected kitchen submit rejection';
exception when sqlstate '42501' then
  if sqlerrm not like '%price_submission_not_authorized%' then raise; end if;
end
$$;
select pg_temp.p1b_assert(
  (select count(*) = 0 from supplier_price_submissions)
  and (select count(*) = 0 from storage.objects where bucket_id = 'price-submissions'),
  'kitchen can read price submission receipts or files'
);

-- Owner and office retain the approved management path. Both claims are created from their
-- uploader-owned objects by the service boundary, then consumed under the original user JWT.
reset role;
select set_config('request.jwt.claim.sub', '21000000-0000-0000-0000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
insert into storage.objects (bucket_id, name, owner, metadata) values (
  'price-submissions',
  '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000002/63000000-0000-4000-8000-000000000001/owner-submit.csv',
  auth.uid(), '{"mimetype":"text/csv","size":100}'::jsonb
);
reset role;
select set_config('request.jwt.claim.sub', '21000000-0000-0000-0000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
insert into storage.objects (bucket_id, name, owner, metadata) values (
  'price-submissions',
  '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000002/63000000-0000-4000-8000-000000000002/office-submit.csv',
  auth.uid(), '{"mimetype":"text/csv","size":100}'::jsonb
);
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

reset role;
select 'p1_price_submissions: all assertions passed' as result;
rollback;
