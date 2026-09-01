-- P98b — two scanners at once. What overlapping runs must and must not do.
--
-- THE CLAIM THIS FILE STARTED WITH WAS WRONG, and saying so is the point of the header. The
-- obvious story is that `for update ... skip locked` stops two scans opening two exceptions for
-- one missed period. It does not, because that was never possible: with the lock removed entirely
-- the second scan still opened nothing. A plain `select` followed by `update` serialises by
-- itself -- the second scan's UPDATE waits on the first's row lock, and READ COMMITTED then
-- re-reads a row that already says `missed`, so its loop body never runs.
--
-- WHAT OVERLAPPING SCANS ACTUALLY DO WRONG IS WAIT. This job runs on a schedule. A run that queues
-- behind the previous one on a tenant with many late periods is a run that does not finish inside
-- its window, and the periods it never reached go unreported that night -- which the customer
-- experiences as the product silently not noticing. So the property worth pinning is not "the
-- second scan opened nothing" (true either way, and therefore proof of nothing) but "the second
-- scan CAME BACK".
--
-- AND THE WAIT WAS NOT WHERE IT LOOKED. Probing the two passes separately while the first scan
-- held its rows for three seconds:
--
--     pass two, `select ... for update skip locked`     ->     3 ms, zero rows
--     pass one, `insert ... on conflict do nothing`     ->  2403 ms
--
-- The lock was doing its job and the FIRST pass was blocking anyway: a BEFORE INSERT row trigger
-- fires before ON CONFLICT is evaluated, so an insert that ends up doing nothing still ran the
-- organisation write guard and queued on a lock the other scan held. `0274` puts a `where not
-- exists` in front of that insert for exactly this reason. Without it the second scan serialises
-- on a period that already existed and needed no work, `skip locked` is masked completely, and
-- every assertion in this file would still have passed.
--
-- THAT IS WHY THIS SUITE MEASURES A DURATION. It is the only assertion here that can tell the
-- working implementation from the broken one, and it was written after watching the broken one
-- pass everything else.
\set ON_ERROR_STOP on

create extension if not exists dblink;

drop schema if exists p98b_scanner_concurrency cascade;
create schema p98b_scanner_concurrency;

create function p98b_scanner_concurrency.assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P98b scanner concurrency assertion failed: %', p_message;
  end if;
end
$$;

-- ===== Fixture =====
-- Committed rather than rolled back: a second session cannot see an uncommitted row, and without
-- two sessions there is nothing here to measure.
--
-- CLEARED FIRST AS WELL AS LAST, and the first is the one that matters. Every statement autocommits,
-- so a run that fails anywhere after the inserts leaves rows behind, and the NEXT run then dies on
-- a primary key before reaching a single assertion -- a failure that reads like a broken suite and
-- hides whatever actually went wrong. Cleaning up on the way out only helps the runs that succeed.
--
-- IT TEARS DOWN THROUGH THE DECLARED PURGE RATHER THAN AROUND IT. `audit_logs` refuses a DELETE
-- unless `app.audit_purge` names a reason, which is the right answer for a trail a customer is
-- entitled to trust, and clearing a test tenant is the `organization_teardown` the guard makes room
-- for. Disabling the trigger instead would have this suite prove that the immutability it relies on
-- elsewhere can be switched off.
create procedure p98b_scanner_concurrency.clear_fixture()
language plpgsql
as $$
begin
  perform set_config('app.audit_purge', 'organization_teardown', true);
  delete from audit_logs where org_id = 'a0981000-0000-4000-8000-000000000001';
  delete from notifications where org_id = 'a0981000-0000-4000-8000-000000000001';
  update public.expectation_occurrences set exception_id = null
   where org_id = 'a0981000-0000-4000-8000-000000000001';
  delete from public.exceptions where org_id = 'a0981000-0000-4000-8000-000000000001';
  delete from public.expectation_occurrences
   where org_id = 'a0981000-0000-4000-8000-000000000001';
  delete from public.supplier_document_expectations
   where org_id = 'a0981000-0000-4000-8000-000000000001';
  -- AND IT STOPS ONE ROW SHORT OF THE ORGANISATION. Deleting it cascades to
  -- `org_flag_configurations`, and that DELETE is refused with `organization_read_only`: the write
  -- guard resolves the access mode of an organisation that is in the middle of disappearing and
  -- gets no answer. Forcing it would mean switching off a guard this suite depends on. The tenant
  -- shell stays, the fixture inserts below tolerate it, and every row an assertion reads is gone.
end
$$;

call p98b_scanner_concurrency.clear_fixture();

insert into public.organizations(id, name, status, vat_rate, base_currency, country_code) values
  ('a0981000-0000-4000-8000-000000000001', 'P98b concurrency tenant', 'active', 18, 'ILS', 'IL')
on conflict (id) do nothing;
insert into auth.users (id, email) values
  ('b0981000-0000-4000-8000-000000000001', 'p98b-owner@example.test')
on conflict (id) do nothing;
insert into public.profiles(id, org_id, full_name, role, active) values
  ('b0981000-0000-4000-8000-000000000001', 'a0981000-0000-4000-8000-000000000001',
   'P98b owner', 'owner', true)
on conflict (id) do nothing;
insert into public.suppliers(id, org_id, name, status, default_currency, country_code) values
  ('c0981000-0000-4000-8000-000000000001', 'a0981000-0000-4000-8000-000000000001',
   'P98b electricity', 'active', 'ILS', 'IL')
on conflict (id) do nothing;

insert into public.supplier_document_expectations
  (id, org_id, supplier_id, document_type, cadence, expected_day_from, expected_day_to,
   grace_days, state, created_by, activated_at)
values ('d0981000-0000-4000-8000-000000000001', 'a0981000-0000-4000-8000-000000000001',
        'c0981000-0000-4000-8000-000000000001', 'invoice', 'monthly', 1, 1, 0, 'active',
        'b0981000-0000-4000-8000-000000000001', now() - interval '8 months');

-- EVERY PERIOD PRE-CREATED AND COMMITTED. The scan's first pass covers the current period and the
-- one before it; leaving those to be created during the race would have session B reach an ON
-- CONFLICT insert against rows session A had inserted and not committed, and an ON CONFLICT insert
-- BLOCKS on an uncommitted conflicting row rather than skipping it. B would then be measuring a
-- different wait than the one under test.
insert into public.expectation_occurrences
  (id, org_id, expectation_id, period_start, period_end)
select ('e0981000-0000-4000-8000-00000000000' || offsets.n)::uuid,
       'a0981000-0000-4000-8000-000000000001',
       'd0981000-0000-4000-8000-000000000001',
       (date_trunc('month', now() at time zone 'Asia/Jerusalem')
        - make_interval(months => offsets.n))::date,
       (date_trunc('month', now() at time zone 'Asia/Jerusalem')
        - make_interval(months => offsets.n))::date
from (values (0), (1), (2)) as offsets(n);

-- Runs the scan and then keeps its transaction open. dblink runs each statement in its own
-- transaction, so the sleep happens while the row locks the scan took are still held.
create function p98b_scanner_concurrency.scan_and_hold(p_hold_seconds double precision)
returns jsonb
language plpgsql
as $$
declare
  v_result jsonb;
begin
  v_result := private.dispatch_document_expectations();
  perform pg_sleep(p_hold_seconds);
  return v_result;
end
$$;

create table p98b_scanner_concurrency.results (
  runner text primary key,
  result jsonb,
  elapsed_ms int
);

select dblink_connect_u(
  'p98b_a', format(
    'dbname=%L user=%L application_name=%L',
    current_database(), 'postgres', 'p98b_scanner_holder'
  )
);
select dblink_connect_u(
  'p98b_b', format(
    'dbname=%L user=%L application_name=%L',
    current_database(), 'postgres', 'p98b_scanner_worker'
  )
);

-- A takes the rows and holds them for three seconds.
select dblink_send_query('p98b_a', 'select p98b_scanner_concurrency.scan_and_hold(3)');
select pg_sleep(0.7);

-- B runs the whole scan while A is still holding, and the clock is the measurement.
do $$
declare
  v_result jsonb;
  v_started timestamptz := clock_timestamp();
begin
  select result into v_result
    from dblink('p98b_b', 'select private.dispatch_document_expectations()') as t(result jsonb);
  insert into p98b_scanner_concurrency.results
  values ('b', v_result,
          round(extract(epoch from (clock_timestamp() - v_started)) * 1000)::int);
end
$$;

insert into p98b_scanner_concurrency.results
select 'a', result, null from dblink_get_result('p98b_a') as t(result jsonb);
select count(*) from dblink_get_result('p98b_a') as t(result jsonb);

-- ===== The measurement the file exists for =====
-- A holds for 3000ms and B starts 700ms in, so a scan that queues cannot come back in under
-- roughly 2300ms. The threshold is 1000ms: far below any queued run and far above the few
-- milliseconds the skip actually takes, so it separates the two without being sensitive to how
-- loaded the machine is.
select p98b_scanner_concurrency.assert(
  (select elapsed_ms from p98b_scanner_concurrency.results where runner = 'b') < 1000,
  'the second scan queued behind the first instead of skipping its rows -- at this rate a nightly '
  'run does not finish inside its window, and the periods it never reaches go unreported');

-- THE POSITIVE CONTROL. Without it, "B came back quickly" is also satisfied by a scan that is
-- broken for everybody. The count is not pinned exactly: on the first of a month the current
-- period has not yet passed its own end, so two periods are late rather than three, and a suite
-- that failed one morning a month would be noise.
select p98b_scanner_concurrency.assert(
  (select (result ->> 'occurrences_missed')::int from p98b_scanner_concurrency.results
    where runner = 'a') >= 1,
  'the first scan did no work at all -- what the second one did proves nothing');

select p98b_scanner_concurrency.assert(
  (select (result ->> 'occurrences_missed')::int from p98b_scanner_concurrency.results
    where runner = 'b') = 0,
  'the second scan reported work on rows the first was holding');

-- Whatever the two of them did between them, the ledger agrees with itself: one exception and one
-- audit row per period actually missed, and the occurrence points at an exception that exists.
select p98b_scanner_concurrency.assert(
  (select count(*) from public.exceptions
    where org_id = 'a0981000-0000-4000-8000-000000000001'
      and type = 'expected_document_missing')
  = (select count(*) from public.expectation_occurrences
      where org_id = 'a0981000-0000-4000-8000-000000000001' and due_status = 'missed'),
  'the exceptions opened do not match the periods missed');

select p98b_scanner_concurrency.assert(
  (select count(*) from audit_logs
    where org_id = 'a0981000-0000-4000-8000-000000000001'
      and action = 'expectation_occurrence_missed'
      and user_id is null)
  = (select count(*) from public.expectation_occurrences
      where org_id = 'a0981000-0000-4000-8000-000000000001' and due_status = 'missed'),
  'the audit rows do not match the periods missed, or one of them named an operator');

select p98b_scanner_concurrency.assert(
  (select o.exception_id from public.expectation_occurrences o
    where o.id = 'e0981000-0000-4000-8000-000000000002')
  in (select e.id from public.exceptions e
       where e.org_id = 'a0981000-0000-4000-8000-000000000001'
         and e.type = 'expected_document_missing'),
  'the occurrence points at an exception that does not exist');

select dblink_disconnect('p98b_a');
select dblink_disconnect('p98b_b');

call p98b_scanner_concurrency.clear_fixture();

select p98b_scanner_concurrency.assert(
  not exists (select 1 from public.expectation_occurrences
               where org_id = 'a0981000-0000-4000-8000-000000000001')
  and not exists (select 1 from public.exceptions
                   where org_id = 'a0981000-0000-4000-8000-000000000001'),
  'the suite left rows behind that its own next run would measure');

drop schema p98b_scanner_concurrency cascade;

select 'P98b_expectation_scanner_concurrency_passed' as result;
