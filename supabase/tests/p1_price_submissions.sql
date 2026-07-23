-- P1B supplier price submission regression harness. Run only against an isolated local
-- database after applying migrations through 0026_supplier_price_submissions.sql.
\set ON_ERROR_STOP on

begin;

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
  ('21000000-0000-0000-0000-000000000004', 'owner-b-p1b@example.test');

insert into profiles (id, org_id, full_name, role) values
  ('21000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', 'P1B owner', 'owner'),
  ('21000000-0000-0000-0000-000000000002', '11000000-0000-0000-0000-000000000001', 'P1B office', 'office'),
  ('21000000-0000-0000-0000-000000000004', '11000000-0000-0000-0000-000000000002', 'P1B owner B', 'owner');

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
    '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/61000000-0000-0000-0000-000000000003/july-correction.csv',
    '21000000-0000-0000-0000-000000000003',
    '{"mimetype":"text/csv"}'::jsonb
  );

select set_config('request.jwt.claim.sub', '21000000-0000-0000-0000-000000000003', true);
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
  (submit_supplier_price_list(
    '61000000-0000-0000-0000-000000000001',
    '31000000-0000-0000-0000-000000000001',
    '2026-07-01', 'july.csv',
    '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/61000000-0000-0000-0000-000000000001/july.csv',
    repeat('a', 64),
    '[
      {"source_row":2,"product_id":"41000000-0000-0000-0000-000000000001","product_name":"P1B Product A1","price_text":"12","available":true},
      {"source_row":3,"product_id":null,"product_name":"Invented Product","price_text":"8","available":true}
    ]'::jsonb,
    'monthly supplier submission'
  )->>'status') = 'accepted_with_rejections',
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
select pg_temp.p1b_assert(
  exists (
    select 1 from audit_logs
    where action = 'supplier_price_submission_processed'
      and entity_id = '61000000-0000-0000-0000-000000000001'
      and reason = 'monthly supplier submission'
  ),
  'submission audit is missing'
);
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
       '61000000-0000-0000-0000-000000000002',
       '31000000-0000-0000-0000-000000000001',
       '2026-07-01', 'same-bytes.csv',
       '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/61000000-0000-0000-0000-000000000002/same-bytes.csv',
       repeat('a', 64),
       '[{"source_row":2,"product_id":"41000000-0000-0000-0000-000000000001","product_name":"P1B Product A1","price_text":"12","available":true}]'::jsonb,
       'lost response retry'
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

-- A corrected file for the same month creates revision 2 instead of overwriting revision 1.
select pg_temp.p1b_assert(
  (submit_supplier_price_list(
    '61000000-0000-0000-0000-000000000003',
    '31000000-0000-0000-0000-000000000001',
    '2026-07-01', 'july-correction.csv',
    '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/61000000-0000-0000-0000-000000000003/july-correction.csv',
    repeat('b', 64),
    '[{"source_row":2,"product_id":"41000000-0000-0000-0000-000000000001","product_name":"P1B Product A1","price_text":"15","available":true}]'::jsonb,
    'corrected monthly submission'
  )->>'revision')::integer = 2,
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

-- Missing Storage bytes fail before price writes or ledger registration.
do $$
begin
  perform submit_supplier_price_list(
    '61000000-0000-0000-0000-000000000004',
    '31000000-0000-0000-0000-000000000001',
    '2026-07-01', 'missing.csv',
    '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/61000000-0000-0000-0000-000000000004/missing.csv',
    repeat('c', 64),
    '[{"source_row":2,"product_id":"41000000-0000-0000-0000-000000000001","product_name":"P1B Product A1","price_text":"16","available":true}]'::jsonb,
    'missing object rollback'
  );
  raise exception 'expected missing object rejection';
exception when sqlstate 'P0002' then
  if sqlerrm not like '%price_submission_file_missing%' then raise; end if;
end
$$;
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
insert into storage.objects (bucket_id, name, owner, metadata) values (
  'price-submissions',
  '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/61000000-0000-0000-0000-000000000005/db-failure.csv',
  '21000000-0000-0000-0000-000000000003',
  '{"mimetype":"text/csv"}'::jsonb
);
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
set local role authenticated;
do $$
begin
  perform submit_supplier_price_list(
    '61000000-0000-0000-0000-000000000005',
    '31000000-0000-0000-0000-000000000001',
    '2026-07-01', 'db-failure.csv',
    '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/61000000-0000-0000-0000-000000000005/db-failure.csv',
    repeat('d', 64),
    '[{"source_row":2,"product_id":"41000000-0000-0000-0000-000000000001","product_name":"P1B Product A1","price_text":"17","available":true}]'::jsonb,
    'forced database rollback'
  );
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
    where id = '61000000-0000-0000-0000-000000000005'
  ),
  'ledger failure left a submission receipt'
);

-- The failed upload is an unreadable orphan, but its uploader can remove it immediately.
select set_config('request.jwt.claim.sub', '21000000-0000-0000-0000-000000000003', true);
set local role authenticated;
delete from storage.objects
where bucket_id = 'price-submissions'
  and name = '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/61000000-0000-0000-0000-000000000005/db-failure.csv';
reset role;
select pg_temp.p1b_assert(
  not exists (
    select 1 from storage.objects
    where bucket_id = 'price-submissions'
      and name = '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000001/61000000-0000-0000-0000-000000000005/db-failure.csv'
  ),
  'uploader could not remove an unregistered orphan'
);

-- A supplier cannot redirect the command to a competitor or a second tenant.
select set_config('request.jwt.claim.sub', '21000000-0000-0000-0000-000000000003', true);
set local role authenticated;
do $$
begin
  perform submit_supplier_price_list(
    '61000000-0000-0000-0000-000000000006',
    '31000000-0000-0000-0000-000000000002',
    '2026-07-01', 'competitor.csv',
    '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000002/61000000-0000-0000-0000-000000000006/competitor.csv',
    repeat('e', 64), '[]'::jsonb, 'competitor attempt'
  );
  raise exception 'expected competitor rejection';
exception when sqlstate '42501' then
  if sqlerrm not like '%price_submission_not_authorized%' then raise; end if;
end
$$;
do $$
begin
  perform submit_supplier_price_list(
    '61000000-0000-0000-0000-000000000007',
    '31000000-0000-0000-0000-000000000003',
    '2026-07-01', 'tenant-b.csv',
    '11000000-0000-0000-0000-000000000001/price-submissions/31000000-0000-0000-0000-000000000003/61000000-0000-0000-0000-000000000007/tenant-b.csv',
    repeat('f', 64), '[]'::jsonb, 'tenant crossing attempt'
  );
  raise exception 'expected tenant rejection';
exception when sqlstate '42501' then
  if sqlerrm not like '%price_submission_not_authorized%' then raise; end if;
end
$$;

-- Manager legacy import remains available and retains its all-or-nothing 0023 behavior.
reset role;
select set_config('request.jwt.claim.sub', '21000000-0000-0000-0000-000000000002', true);
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
