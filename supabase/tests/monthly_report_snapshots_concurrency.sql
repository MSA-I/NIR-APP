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

create function monthly_snapshot_concurrency_test.hold_first_snapshot_row(p_hold_seconds double precision)
returns text
language plpgsql
as $$
begin
  perform 1
  from public.monthly_report_snapshots snapshot
  where snapshot.org_id = 'a5750000-0000-0000-0000-000000000001'
    and snapshot.unit_id = 'b5750000-0000-0000-0000-000000000001'
    and snapshot.report_month = '2026-08-01'
    and snapshot.version = 1
  for update;
  if not found then
    raise exception 'snapshot concurrency fixture version 1 is missing';
  end if;
  perform pg_sleep(p_hold_seconds);
  return 'released';
end
$$;

create function monthly_snapshot_concurrency_test.hold_snapshot_lane(p_hold_seconds double precision)
returns text
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'monthly-report-snapshot:'
      || 'a5750000-0000-0000-0000-000000000001'
      || ':' || 'b5750000-0000-0000-0000-000000000001'
      || ':' || '2026-08-01',
    0
  ));
  perform pg_sleep(p_hold_seconds);
  return 'released';
end
$$;

create function monthly_snapshot_concurrency_test.run_first_snapshot_delivery()
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_snapshot_id uuid;
  v_result jsonb;
begin
  select snapshot.id into v_snapshot_id
  from public.monthly_report_snapshots snapshot
  where snapshot.org_id = 'a5750000-0000-0000-0000-000000000001'
    and snapshot.unit_id = 'b5750000-0000-0000-0000-000000000001'
    and snapshot.report_month = '2026-08-01'
    and snapshot.version = 1;

  perform set_config('request.jwt.claim.sub', 'c5750000-0000-0000-0000-000000000001', true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', 'c5750000-0000-0000-0000-000000000001',
    'amr', jsonb_build_array(jsonb_build_object(
      'method', 'password', 'timestamp', extract(epoch from clock_timestamp())
    ))
  )::text, true);
  perform set_config('statement_timeout', '10000', true);
  perform set_config('role', 'authenticated', true);

  begin
    v_result := public.mark_monthly_report_snapshot_sent(
      v_snapshot_id, 'delivery must re-check role after row-lock wait'
    );
    return jsonb_build_object('unexpected_success', v_result);
  exception when others then
    return jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate);
  end;
end
$$;

create function monthly_snapshot_concurrency_test.run_aging_snapshot()
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_snapshot public.monthly_report_snapshots;
begin
  perform set_config('request.jwt.claim.sub', 'c5750000-0000-0000-0000-000000000001', true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', 'c5750000-0000-0000-0000-000000000001',
    'amr', jsonb_build_array(jsonb_build_object(
      'method', 'password',
      'timestamp', extract(epoch from clock_timestamp() - interval '4 minutes 58 seconds')
    ))
  )::text, true);
  perform set_config('statement_timeout', '10000', true);
  perform set_config('role', 'authenticated', true);

  begin
    v_snapshot := public.create_monthly_report_snapshot(
      '2026-08-01', 'b5750000-0000-0000-0000-000000000001'
    );
    return jsonb_build_object('unexpected_success', to_jsonb(v_snapshot));
  exception when others then
    return jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate);
  end;
end
$$;

create table monthly_snapshot_concurrency_test.results (
  runner text primary key,
  result jsonb not null
);

select dblink_connect_u(
  'snapshot_a', format(
    'dbname=%L user=%L application_name=%L',
    current_database(), 'postgres', 'snapshot_concurrency_holder'
  )
);
select dblink_connect_u(
  'snapshot_b', format(
    'dbname=%L user=%L application_name=%L',
    current_database(), 'postgres', 'snapshot_concurrency_worker'
  )
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
-- Drain the async end-of-results marker; without this the next dblink_send_query
-- on the same connection fails silently ("connection busy") and no lock is held.
select count(*) from dblink_get_result('snapshot_a') as t(result jsonb);
select count(*) from dblink_get_result('snapshot_b') as t(result jsonb);

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

-- A delivery that already passed its initial role check must fail if the profile is revoked
-- while it waits for the immutable snapshot row lock.
select dblink_send_query(
  'snapshot_a',
  'select monthly_snapshot_concurrency_test.hold_first_snapshot_row(2.0)'
);
select pg_sleep(0.15);
select dblink_send_query(
  'snapshot_b',
  'select monthly_snapshot_concurrency_test.run_first_snapshot_delivery()'
);
do $$
declare
  v_waiting boolean := false;
begin
  for attempt in 1..60 loop
    -- pg_stat_activity is frozen at first access within a transaction; without
    -- clearing the snapshot every poll re-reads the same stale view and the
    -- worker's lock wait is never observed.
    perform pg_stat_clear_snapshot();
    select exists (
      select 1 from pg_stat_activity
      where application_name = 'snapshot_concurrency_worker'
        and wait_event_type = 'Lock'
    ) into v_waiting;
    exit when v_waiting;
    perform pg_sleep(0.05);
  end loop;
  if not v_waiting then
    raise exception 'delivery worker did not reach the snapshot row-lock wait';
  end if;
end
$$;
update public.profiles
set role = 'office'
where id = 'c5750000-0000-0000-0000-000000000001'
  and org_id = 'a5750000-0000-0000-0000-000000000001';
select released from dblink_get_result('snapshot_a') as t(released text);
insert into monthly_snapshot_concurrency_test.results
select 'delivery_revoked', result
from dblink_get_result('snapshot_b') as t(result jsonb);
select count(*) from dblink_get_result('snapshot_a') as t(released text);
select count(*) from dblink_get_result('snapshot_b') as t(result jsonb);
select monthly_snapshot_concurrency_test.assert(
  (select result ->> 'error' like '%monthly_report_snapshot_delivery_not_authorized%'
   from monthly_snapshot_concurrency_test.results where runner = 'delivery_revoked'),
  'delivery accepted a role revoked during its row-lock wait'
);
select monthly_snapshot_concurrency_test.assert(
  not exists (
    select 1 from public.monthly_report_snapshot_deliveries delivery
    join public.monthly_report_snapshots snapshot on snapshot.id = delivery.snapshot_id
    where snapshot.org_id = 'a5750000-0000-0000-0000-000000000001'
      and snapshot.unit_id = 'b5750000-0000-0000-0000-000000000001'
      and snapshot.report_month = '2026-08-01'
      and snapshot.version = 1
  ),
  'failed post-lock delivery authorization left a delivery row'
);
update public.profiles
set role = 'owner'
where id = 'c5750000-0000-0000-0000-000000000001'
  and org_id = 'a5750000-0000-0000-0000-000000000001';

-- A password AMR that was fresh before the advisory wait must be checked again after waiting.
select dblink_send_query(
  'snapshot_a',
  'select monthly_snapshot_concurrency_test.hold_snapshot_lane(3.0)'
);
select pg_sleep(0.15);
select dblink_send_query(
  'snapshot_b',
  'select monthly_snapshot_concurrency_test.run_aging_snapshot()'
);
do $$
declare
  v_waiting boolean := false;
begin
  for attempt in 1..60 loop
    -- pg_stat_activity is frozen at first access within a transaction; without
    -- clearing the snapshot every poll re-reads the same stale view and the
    -- worker's lock wait is never observed.
    perform pg_stat_clear_snapshot();
    select exists (
      select 1 from pg_stat_activity
      where application_name = 'snapshot_concurrency_worker'
        and wait_event_type = 'Lock'
    ) into v_waiting;
    exit when v_waiting;
    perform pg_sleep(0.05);
  end loop;
  if not v_waiting then
    raise exception 'snapshot worker did not reach the advisory-lock wait';
  end if;
end
$$;
select released from dblink_get_result('snapshot_a') as t(released text);
insert into monthly_snapshot_concurrency_test.results
select 'create_stale', result
from dblink_get_result('snapshot_b') as t(result jsonb);
select count(*) from dblink_get_result('snapshot_a') as t(released text);
select count(*) from dblink_get_result('snapshot_b') as t(result jsonb);
select monthly_snapshot_concurrency_test.assert(
  (select result ->> 'error' like '%fresh_authentication_required%'
   from monthly_snapshot_concurrency_test.results where runner = 'create_stale'),
  'snapshot creation did not re-check an AMR that expired during the advisory wait'
);
select monthly_snapshot_concurrency_test.assert(
  (select count(*) = 2
   from public.monthly_report_snapshots
   where org_id = 'a5750000-0000-0000-0000-000000000001'
     and unit_id = 'b5750000-0000-0000-0000-000000000001'
     and report_month = '2026-08-01')
  and
  (select count(*) = 2
   from public.audit_logs
   where org_id = 'a5750000-0000-0000-0000-000000000001'
     and action = 'monthly_report_snapshot_created'),
  'failed post-wait snapshot authentication left a snapshot or audit row'
);

select dblink_disconnect('snapshot_a');
select dblink_disconnect('snapshot_b');

select 'monthly_report_snapshots_concurrency: all assertions passed' as result;
