-- P1B real-session concurrency harness. Run only against a freshly reset disposable database
-- with migrations through 0029 applied. It intentionally commits fixtures for dblink visibility;
-- the quality gate resets the database immediately after all concurrency suites.
\set ON_ERROR_STOP on

create extension if not exists dblink;
drop schema if exists p1b_concurrency_test cascade;
create schema p1b_concurrency_test;

create function p1b_concurrency_test.assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P1B concurrency assertion failed: %', p_message;
  end if;
end
$$;

create table p1b_concurrency_test.results (
  case_name text not null,
  runner text not null,
  result jsonb not null
);

insert into organizations (id, name, status) values
  ('12000000-0000-0000-0000-000000000001', 'P1B concurrency tenant', 'active');
insert into auth.users (id, email) values
  ('22000000-0000-0000-0000-000000000001', 'p1b-concurrency-supplier@example.test');
insert into suppliers (id, org_id, name) values
  ('32000000-0000-0000-0000-000000000001', '12000000-0000-0000-0000-000000000001', 'P1B concurrent supplier');
insert into profiles (id, org_id, full_name, role, supplier_id) values
  ('22000000-0000-0000-0000-000000000001', '12000000-0000-0000-0000-000000000001',
   'P1B concurrent supplier', 'supplier', '32000000-0000-0000-0000-000000000001');
insert into products (id, org_id, name, unit) values
  ('42000000-0000-0000-0000-000000000001', '12000000-0000-0000-0000-000000000001', 'P1B concurrent product', 'unit');
insert into supplier_products (
  id, org_id, supplier_id, product_id, current_price, price_effective_date, available
) values (
  '52000000-0000-0000-0000-000000000001', '12000000-0000-0000-0000-000000000001',
  '32000000-0000-0000-0000-000000000001', '42000000-0000-0000-0000-000000000001',
  10, '2026-06-01', true
);
insert into price_history (org_id, supplier_product_id, price, effective_date) values (
  '12000000-0000-0000-0000-000000000001',
  '52000000-0000-0000-0000-000000000001', 10, '2026-06-01'
);

insert into storage.objects (bucket_id, name, owner, metadata) values
  ('price-submissions', '12000000-0000-0000-0000-000000000001/price-submissions/32000000-0000-0000-0000-000000000001/62000000-0000-0000-0000-000000000001/same-a.csv', '22000000-0000-0000-0000-000000000001', '{"mimetype":"text/csv","size":100}'::jsonb),
  ('price-submissions', '12000000-0000-0000-0000-000000000001/price-submissions/32000000-0000-0000-0000-000000000001/62000000-0000-0000-0000-000000000002/same-b.csv', '22000000-0000-0000-0000-000000000001', '{"mimetype":"text/csv","size":100}'::jsonb),
  ('price-submissions', '12000000-0000-0000-0000-000000000001/price-submissions/32000000-0000-0000-0000-000000000001/62000000-0000-0000-0000-000000000003/revision-a.csv', '22000000-0000-0000-0000-000000000001', '{"mimetype":"text/csv","size":100}'::jsonb),
  ('price-submissions', '12000000-0000-0000-0000-000000000001/price-submissions/32000000-0000-0000-0000-000000000001/62000000-0000-0000-0000-000000000004/revision-b.csv', '22000000-0000-0000-0000-000000000001', '{"mimetype":"text/csv","size":100}'::jsonb);

insert into supplier_price_submission_intakes (
  id, org_id, actor_id, supplier_id, submission_id, target_month,
  file_name, storage_path, object_id, object_updated_at, mime_type,
  file_checksum, file_size, rows_payload, reason, status
)
select fixture.intake_id, '12000000-0000-0000-0000-000000000001',
       '22000000-0000-0000-0000-000000000001',
       '32000000-0000-0000-0000-000000000001', fixture.submission_id,
       fixture.target_month, fixture.file_name, fixture.storage_path,
       object.id, object.updated_at, 'text/csv', fixture.file_checksum, 100,
       jsonb_build_array(jsonb_build_object(
         'source_row', 2,
         'product_id', '42000000-0000-0000-0000-000000000001',
         'product_name', 'P1B concurrent product',
         'price_text', fixture.price_text,
         'available', true
       )),
       'P1B trusted concurrency', 'prepared'
from (values
  ('72000000-0000-0000-0000-000000000001'::uuid, '62000000-0000-0000-0000-000000000001'::uuid, '2026-07-01'::date, 'same-a.csv'::text, '12000000-0000-0000-0000-000000000001/price-submissions/32000000-0000-0000-0000-000000000001/62000000-0000-0000-0000-000000000001/same-a.csv'::text, repeat('a', 64)::text, '20'::text),
  ('72000000-0000-0000-0000-000000000002'::uuid, '62000000-0000-0000-0000-000000000002'::uuid, '2026-07-01'::date, 'same-b.csv'::text, '12000000-0000-0000-0000-000000000001/price-submissions/32000000-0000-0000-0000-000000000001/62000000-0000-0000-0000-000000000002/same-b.csv'::text, repeat('a', 64)::text, '20'::text),
  ('72000000-0000-0000-0000-000000000003'::uuid, '62000000-0000-0000-0000-000000000003'::uuid, '2026-08-01'::date, 'revision-a.csv'::text, '12000000-0000-0000-0000-000000000001/price-submissions/32000000-0000-0000-0000-000000000001/62000000-0000-0000-0000-000000000003/revision-a.csv'::text, repeat('b', 64)::text, '21'::text),
  ('72000000-0000-0000-0000-000000000004'::uuid, '62000000-0000-0000-0000-000000000004'::uuid, '2026-08-01'::date, 'revision-b.csv'::text, '12000000-0000-0000-0000-000000000001/price-submissions/32000000-0000-0000-0000-000000000001/62000000-0000-0000-0000-000000000004/revision-b.csv'::text, repeat('c', 64)::text, '22'::text)
) as fixture(intake_id, submission_id, target_month, file_name, storage_path, file_checksum, price_text)
join storage.objects object
  on object.bucket_id = 'price-submissions' and object.name = fixture.storage_path;

create function p1b_concurrency_test.activate()
returns void language plpgsql security invoker as $$
begin
  perform set_config('request.jwt.claim.sub', '22000000-0000-0000-0000-000000000001', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('statement_timeout', '7000', true);
  perform set_config('role', 'authenticated', true);
end
$$;

create function p1b_concurrency_test.run_submission(p_intake_id uuid, p_hold_seconds double precision)
returns jsonb language plpgsql security invoker as $$
declare v_result jsonb;
begin
  perform p1b_concurrency_test.activate();
  v_result := submit_supplier_price_list(p_intake_id);
  perform pg_sleep(p_hold_seconds);
  return v_result;
end
$$;

select dblink_connect_u('p1b_a', format('dbname=%L user=%L', current_database(), 'postgres'));
select dblink_connect_u('p1b_b', format('dbname=%L user=%L', current_database(), 'postgres'));

-- Same month and server-derived checksum: one commit and one idempotent receipt.
select dblink_send_query('p1b_a', $$select p1b_concurrency_test.run_submission('72000000-0000-0000-0000-000000000001', 1.2)$$);
select pg_sleep(0.15);
select dblink_send_query('p1b_b', $$select p1b_concurrency_test.run_submission('72000000-0000-0000-0000-000000000002', 0)$$);
insert into p1b_concurrency_test.results
select 'same_checksum', 'a', result from dblink_get_result('p1b_a') as t(result jsonb);
insert into p1b_concurrency_test.results
select 'same_checksum', 'b', result from dblink_get_result('p1b_b') as t(result jsonb);
select count(*) from dblink_get_result('p1b_a') as t(result jsonb);
select count(*) from dblink_get_result('p1b_b') as t(result jsonb);
select p1b_concurrency_test.assert(
  (select count(*) = 1 from supplier_price_submissions
   where org_id = '12000000-0000-0000-0000-000000000001'
     and supplier_id = '32000000-0000-0000-0000-000000000001'
     and target_month = '2026-07-01'),
  'same checksum created more than one receipt'
);
select p1b_concurrency_test.assert(
  (select count(*) filter (where (result ->> 'idempotent')::boolean) = 1
          and count(*) filter (where not (result ->> 'idempotent')::boolean) = 1
   from p1b_concurrency_test.results where case_name = 'same_checksum'),
  'same checksum did not produce one commit and one idempotent result'
);

-- Different checksums for the same month serialize into revisions 1 and 2.
select dblink_send_query('p1b_a', $$select p1b_concurrency_test.run_submission('72000000-0000-0000-0000-000000000003', 1.2)$$);
select pg_sleep(0.15);
select dblink_send_query('p1b_b', $$select p1b_concurrency_test.run_submission('72000000-0000-0000-0000-000000000004', 0)$$);
insert into p1b_concurrency_test.results
select 'different_checksum', 'a', result from dblink_get_result('p1b_a') as t(result jsonb);
insert into p1b_concurrency_test.results
select 'different_checksum', 'b', result from dblink_get_result('p1b_b') as t(result jsonb);
select count(*) from dblink_get_result('p1b_a') as t(result jsonb);
select count(*) from dblink_get_result('p1b_b') as t(result jsonb);
select p1b_concurrency_test.assert(
  (select count(*) = 2 and min(revision) = 1 and max(revision) = 2
   from supplier_price_submissions
   where org_id = '12000000-0000-0000-0000-000000000001'
     and supplier_id = '32000000-0000-0000-0000-000000000001'
     and target_month = '2026-08-01'),
  'different checksums did not serialize into revisions 1 and 2'
);
select p1b_concurrency_test.assert(
  not exists (
    select 1 from supplier_price_submission_intakes
    where id in (
      '72000000-0000-0000-0000-000000000001',
      '72000000-0000-0000-0000-000000000002',
      '72000000-0000-0000-0000-000000000003',
      '72000000-0000-0000-0000-000000000004'
    )
  ),
  'successful concurrent commands did not consume every intake'
);

select dblink_disconnect('p1b_a');
select dblink_disconnect('p1b_b');
select 'p1_price_submissions_concurrency: all assertions passed' as result;
