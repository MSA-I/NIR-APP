-- Real two-session version allocation test for legal-entity monthly snapshots.
-- Run only against a freshly reset disposable local database after migrations 0073-0074.
\set ON_ERROR_STOP on

create extension if not exists dblink;
drop schema if exists monthly_snapshot_concurrency_test cascade;
create schema monthly_snapshot_concurrency_test;

create function monthly_snapshot_concurrency_test.assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'Monthly snapshot concurrency assertion failed: %', p_message;
  end if;
end
$$;

insert into public.organizations (id, name, status) values
  ('a5750000-0000-0000-0000-000000000001', 'Snapshot concurrency tenant', 'active');
select id as root from public.org_units
where org_id = 'a5750000-0000-0000-0000-000000000001' and unit_type = 'root'
\gset concurrency_
insert into public.org_units (id, org_id, parent_id, unit_type, name) values (
  'b5750000-0000-0000-0000-000000000001', 'a5750000-0000-0000-0000-000000000001',
  :'concurrency_root', 'legal_entity', 'Concurrency legal entity'
);
insert into auth.users (id, email) values
  ('c5750000-0000-0000-0000-000000000001', 'snapshot-concurrency-owner@example.test');
insert into public.profiles (id, org_id, full_name, role) values
  ('c5750000-0000-0000-0000-000000000001', 'a5750000-0000-0000-0000-000000000001',
   'Snapshot concurrency owner', 'owner');

create function monthly_snapshot_concurrency_test.run_snapshot(p_hold_seconds double precision)
returns jsonb
language plpgsql
security invoker
as $$
declare v_snapshot public.monthly_report_snapshots;
begin
  perform set_config('request.jwt.claim.sub', 'c5750000-0000-0000-0000-000000000001', true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', 'c5750000-0000-0000-0000-000000000001',
    'amr', jsonb_build_array(jsonb_build_object(
      'method', 'password', 'timestamp', extract(epoch from clock_timestamp())
    ))
  )::text, true);
  perform set_config('statement_timeout', '7000', true);
  perform set_config('role', 'authenticated', true);
  v_snapshot := public.create_monthly_report_snapshot(
    '2026-08-01', 'b5750000-0000-0000-0000-000000000001'
  );
  -- Hold the transaction after version allocation so the second session must wait for the
  -- advisory lock and then observe the committed next version.
  perform pg_sleep(p_hold_seconds);
  return jsonb_build_object(
    'snapshot_id', v_snapshot.id,
    'unit_id', v_snapshot.unit_id,
    'version', v_snapshot.version
  );
end
$$;

create table monthly_snapshot_concurrency_test.results (
  runner text primary key,
  result jsonb not null
);

select dblink_connect_u(
  'snapshot_a', format('dbname=%L user=%L', current_database(), 'postgres')
);
select dblink_connect_u(
  'snapshot_b', format('dbname=%L user=%L', current_database(), 'postgres')
);

select dblink_send_query(
  'snapshot_a', 'select monthly_snapshot_concurrency_test.run_snapshot(1.2)'
);
select pg_sleep(0.15);
select dblink_send_query(
  'snapshot_b', 'select monthly_snapshot_concurrency_test.run_snapshot(0)'
);

insert into monthly_snapshot_concurrency_test.results
select 'a', result from dblink_get_result('snapshot_a') as t(result jsonb);
insert into monthly_snapshot_concurrency_test.results
select 'b', result from dblink_get_result('snapshot_b') as t(result jsonb);

select monthly_snapshot_concurrency_test.assert(
  (select array_agg(version order by version) = array[1, 2]
   from public.monthly_report_snapshots
   where org_id = 'a5750000-0000-0000-0000-000000000001'
     and unit_id = 'b5750000-0000-0000-0000-000000000001'
     and report_month = '2026-08-01'),
  'concurrent creation did not allocate unique sequential versions per legal entity'
);
select monthly_snapshot_concurrency_test.assert(
  (select count(*) = 2 and count(distinct result ->> 'snapshot_id') = 2
      and bool_and(result ->> 'unit_id' = 'b5750000-0000-0000-0000-000000000001')
   from monthly_snapshot_concurrency_test.results),
  'concurrent creation did not return two distinct snapshots for the requested entity'
);
select monthly_snapshot_concurrency_test.assert(
  (select count(*) = 2
   from public.audit_logs
   where org_id = 'a5750000-0000-0000-0000-000000000001'
     and action = 'monthly_report_snapshot_created'),
  'concurrent creation did not atomically audit both versions'
);
select monthly_snapshot_concurrency_test.assert(
  (select count(*) = 2
   from public.domain_events
   where org_id = 'a5750000-0000-0000-0000-000000000001'
     and unit_id = 'b5750000-0000-0000-0000-000000000001'
     and event_type = 'monthly_report.snapshot_created'),
  'concurrent creation did not atomically emit both domain events'
);

select dblink_disconnect('snapshot_a');
select dblink_disconnect('snapshot_b');

select 'monthly_report_snapshots_concurrency: all assertions passed' as result;
