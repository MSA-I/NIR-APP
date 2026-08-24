-- P65 -- #231: product names are repaired only from checksum-bound source rows.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p65_assert(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'P65: %', p_message; end if;
end $$;

insert into public.organizations (id, name, status)
values ('65000000-0000-4000-8000-000000000001', 'P65 tenant', 'active');
insert into auth.users (id, email) values
  ('65100000-0000-4000-8000-000000000001', 'owner-p65@example.test'),
  ('65100000-0000-4000-8000-000000000003', 'office-p65@example.test'),
  ('65100000-0000-4000-8000-000000000002', 'accountant-p65@example.test');
insert into public.profiles (id, org_id, full_name, role) values
  ('65100000-0000-4000-8000-000000000001', '65000000-0000-4000-8000-000000000001', 'P65 owner', 'owner'),
  ('65100000-0000-4000-8000-000000000003', '65000000-0000-4000-8000-000000000001', 'P65 office', 'office'),
  ('65100000-0000-4000-8000-000000000002', '65000000-0000-4000-8000-000000000001', 'P65 accountant', 'accountant');
insert into public.suppliers (id, org_id, name, status)
values ('65200000-0000-4000-8000-000000000001', '65000000-0000-4000-8000-000000000001', 'P65 supplier', 'active');
insert into public.products (id, org_id, name, unit, sku) values
  ('65300000-0000-4000-8000-000000000001', '65000000-0000-4000-8000-000000000001', ')ג"ק 5( ןבל חמק', 'ק״ג', 'P65-1'),
  ('65300000-0000-4000-8000-000000000002', '65000000-0000-4000-8000-000000000001', ')רטיל 1( ןמש', 'יח׳', 'P65-2');
insert into public.supplier_price_submissions (
  id, org_id, supplier_id, target_month, revision, file_name, storage_path, file_checksum,
  status, accepted_count, rejected_count, unchanged_count, rejections,
  row_count, created_count, updated_count, submitted_by
) values (
  '65400000-0000-4000-8000-000000000001', '65000000-0000-4000-8000-000000000001',
  '65200000-0000-4000-8000-000000000001', date '2026-07-01', 1, 'p65-original.xlsx',
  '65000000-0000-4000-8000-000000000001/price-submissions/65200000-0000-4000-8000-000000000001/65400000-0000-4000-8000-000000000001/p65-original.xlsx',
  repeat('a', 64), 'accepted', 2, 0, 0, '[]'::jsonb, 2, 2, 0,
  '65100000-0000-4000-8000-000000000001'
);

-- Before anything has been measured the read model must SAY so. This is the whole reason 0177
-- returns an object instead of a row set: an empty candidate list alone is indistinguishable from
-- "nobody ever produced a report", and the screen rendered it as a measured zero.
select set_config('request.jwt.claim.sub', '65100000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select pg_temp.p65_assert((
  select queue ->> 'has_dry_run' = 'false'
     and (queue ->> 'dry_run_count')::integer = 0
     and queue ->> 'latest_dry_run_at' is null
     and queue -> 'candidates' = '[]'::jsonb
  from public.get_product_name_repair_queue() queue
), 'an unmeasured queue reported itself as a measured zero');
reset role;

-- Dry-run preparation is server-only and binds rows to the immutable submission checksum.
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.prepare_product_name_repair_dry_run(
  '65400000-0000-4000-8000-000000000001', '65100000-0000-4000-8000-000000000003', repeat('a', 64),
  array[
    '65300000-0000-4000-8000-000000000001'::uuid,
    '65300000-0000-4000-8000-000000000002'::uuid
  ],
  jsonb_build_array(jsonb_build_object(
    'source_row', 7, 'sku', 'P65-1', 'barcode', null,
    'product_name', 'קמח לבן (5 ק"ג)',
    'evidence', jsonb_build_object('sheet', 'מחירון', 'cell', 'B7')
  ))
);
reset role;
select pg_temp.p65_assert((select prepared_by='65100000-0000-4000-8000-000000000003'
  and source_uploaded_by='65100000-0000-4000-8000-000000000001'
  from public.product_name_repair_runs where source_submission_id='65400000-0000-4000-8000-000000000001'),
  'requester and immutable original uploader were conflated');

set local role service_role;
do $$ begin
  perform public.prepare_product_name_repair_dry_run(
    '65400000-0000-4000-8000-000000000001', '65100000-0000-4000-8000-000000000002', repeat('a',64),
    array['65300000-0000-4000-8000-000000000001'::uuid], '[]'::jsonb);
  raise exception 'inactive/unauthorized requester accepted';
exception when sqlstate '42501' then
  if sqlerrm<>'product_name_repair_requester_not_authorized' then raise; end if;
end $$;
reset role;

-- A wrong checksum cannot mint trusted preview evidence.
set local role service_role;
do $$ begin
  perform public.prepare_product_name_repair_dry_run(
    '65400000-0000-4000-8000-000000000001', '65100000-0000-4000-8000-000000000003', repeat('b', 64),
    array['65300000-0000-4000-8000-000000000001'::uuid], '[]'::jsonb);
  raise exception 'wrong checksum accepted';
exception when sqlstate '55000' then
  if sqlerrm <> 'product_name_repair_source_changed' then raise; end if;
end $$;
reset role;

-- Owner sees old/new plus source row/checksum. Missing source stays blocked.
select set_config('request.jwt.claim.sub', '65100000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
-- ...and once one HAS been produced, the same read model must say that too, or the measurement is
-- unobservable and the assertion above would pass forever on a function that always answers false.
select pg_temp.p65_assert((
  select queue ->> 'has_dry_run' = 'true'
     and (queue ->> 'dry_run_count')::integer = 1
     and queue ->> 'latest_dry_run_at' is not null
  from public.get_product_name_repair_queue() queue
), 'a produced dry run was still reported as never measured');
select pg_temp.p65_assert((
  select count(*) = 1
  from jsonb_array_elements(public.get_product_name_repair_queue() -> 'candidates') candidate
  where candidate ->> 'product_id' = '65300000-0000-4000-8000-000000000001'
    and candidate ->> 'status' = 'ready' and candidate ->> 'old_name' = ')ג"ק 5( ןבל חמק'
    and candidate ->> 'proposed_name' = 'קמח לבן (5 ק"ג)'
    and (candidate ->> 'source_row')::integer = 7
    and candidate ->> 'source_checksum' = repeat('a', 64)
    and candidate -> 'source_evidence' = '{"cell":"B7","sheet":"מחירון"}'::jsonb
), 'ready preview lost old/new or provenance');
select pg_temp.p65_assert((
  select count(*) = 1
  from jsonb_array_elements(public.get_product_name_repair_queue() -> 'candidates') candidate
  where candidate ->> 'product_id' = '65300000-0000-4000-8000-000000000002'
    and candidate ->> 'status' = 'blocked' and candidate ->> 'reason_code' = 'missing_source'
), 'target absent from source must remain blocked');

-- One approval changes one name, carries reason/checksum, and retries idempotently.
select set_config('p65.candidate_id', (select candidate ->> 'candidate_id'
  from jsonb_array_elements(public.get_product_name_repair_queue() -> 'candidates') candidate
  where candidate ->> 'product_id' = '65300000-0000-4000-8000-000000000001'), true);
select public.apply_product_name_repair(
  current_setting('p65.candidate_id')::uuid,
  ')ג"ק 5( ןבל חמק', 'קמח לבן (5 ק"ג)', repeat('a', 64),
  '65500000-0000-4000-8000-000000000001', 'P65 checked original row 7'
);
select pg_temp.p65_assert((public.apply_product_name_repair(
  current_setting('p65.candidate_id')::uuid,
  ')ג"ק 5( ןבל חמק', 'קמח לבן (5 ק"ג)', repeat('a', 64),
  '65500000-0000-4000-8000-000000000001', 'P65 checked original row 7'
) ->> 'idempotent')::boolean, 'same command retry must be idempotent');
reset role;

select pg_temp.p65_assert((select name = 'קמח לבן (5 ק"ג)' from public.products
  where id = '65300000-0000-4000-8000-000000000001'), 'approved source name did not land');
select pg_temp.p65_assert((select name = ')רטיל 1( ןמש' from public.products
  where id = '65300000-0000-4000-8000-000000000002'), 'blocked target was mutated');
select pg_temp.p65_assert((select count(*) = 1 from public.audit_logs
  where action = 'product_name_repaired_from_source'
    and entity_id = '65300000-0000-4000-8000-000000000001'
    and reason = 'P65 checked original row 7'
    and new_values ->> 'source_checksum' = repeat('a', 64)
    and new_values ->> 'source_row' = '7'), 'repair audit lacks actor reason or source proof');

-- Accountant cannot read the queue or apply a repair.
select set_config('request.jwt.claim.sub', '65100000-0000-4000-8000-000000000002', true);
set local role authenticated;
do $$ begin
  perform public.get_product_name_repair_queue();
  raise exception 'accountant queue access accepted';
exception when sqlstate '42501' then null; end $$;
reset role;

rollback;
