-- P98 — the scan that turns a standing expectation into a finding, and the five ways it could
-- quietly do the wrong thing.
--
-- `0272` could hold the statement and `0273` could name the finding; neither could notice. `0274`
-- is the noticing, and noticing is exactly the kind of job that looks correct while being wrong:
--
--   IT MUST NOT OPEN AN EXCEPTION INSIDE THE WINDOW. A document that is not late yet is not
--   missing, and an exception raised on the 4th for an invoice due by the 7th is the product
--   inventing work. The waiting window AND the grace period both have to have passed.
--
--   IT MUST NOT REACH BACK BEFORE ANYBODY SWITCHED IT ON. `created_at` is when a person drafted a
--   proposal; `activated_at` is when somebody agreed it should be watched. Scanning from the
--   former would greet the approver with a wall of exceptions for months nobody was watching, all
--   dated today. This suite activates an expectation with a past date and one with today's, and
--   the second gets nothing for last month.
--
--   RUNNING TWICE MUST CHANGE NOTHING. Idempotency here is structural -- the UNIQUE on
--   (expectation_id, period_start) -- rather than the job remembering whether it ran. This suite
--   runs the scan twice and counts.
--
--   "NOT THIS MONTH" MUST CLOSE ONE MONTH. A person saying the invoice is not coming in August is
--   stating a fact about August. If it silenced the expectation instead, September would go
--   unwatched and nobody would be told.
--
--   A LATE ARRIVAL MUST NOT ERASE HAVING BEEN LATE. `missed_at` survives the document turning up,
--   because the measure of this whole item -- how many missing documents we found -- is computed
--   from occurrences that were missed and then received.
--
-- WHAT THIS SUITE DELIBERATELY DOES NOT ASSERT: that two scanners running at once open one
-- exception. That needs two real sessions and lives in
-- `p98b_expectation_scanner_concurrency.sql`; a single-session test could only assert that the
-- word `skip locked` appears in the source, which is not evidence of anything.
--
-- DATE INDEPENDENCE. Nothing here pins a literal date. Every assertion names the period it means
-- by arithmetic on `now()` -- "the period that began on the first of last month" -- so the suite
-- gives the same answer on the 1st and on the 31st. A test that passes only in the middle of the
-- month is a test that will fail at 2am on a Sunday for reasons nobody will find.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p98_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P98 scanner assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p98_refuses(p_sql text)
returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return true;
end
$$;

-- The period that is unambiguously over: the first of last month. More than 27 days ago whatever
-- today is, so "the window and the grace have passed" is true on every day of every month.
create function pg_temp.p98_last_month_start() returns date language sql stable as $$
  select (date_trunc('month', now() at time zone 'Asia/Jerusalem')
          - interval '1 month')::date
$$;

insert into public.organizations(id, name, status, vat_rate, base_currency, country_code) values
  ('a0980000-0000-4000-8000-000000000001', 'P98 org', 'active', 18, 'ILS', 'IL');
insert into auth.users (id, email) values
  ('b0980000-0000-4000-8000-000000000001', 'p98-owner@example.test'),
  ('b0980000-0000-4000-8000-000000000002', 'p98-accountant@example.test');
insert into public.profiles(id, org_id, full_name, role, active) values
  ('b0980000-0000-4000-8000-000000000001', 'a0980000-0000-4000-8000-000000000001',
   'P98 owner', 'owner', true),
  ('b0980000-0000-4000-8000-000000000002', 'a0980000-0000-4000-8000-000000000001',
   'P98 accountant', 'accountant', true);
insert into public.suppliers(id, org_id, name, status, default_currency, country_code) values
  ('c0980000-0000-4000-8000-000000000001', 'a0980000-0000-4000-8000-000000000001',
   'P98 electricity', 'active', 'ILS', 'IL'),
  ('c0980000-0000-4000-8000-000000000002', 'a0980000-0000-4000-8000-000000000001',
   'P98 water', 'active', 'ILS', 'IL'),
  ('c0980000-0000-4000-8000-000000000003', 'a0980000-0000-4000-8000-000000000001',
   'P98 gas', 'active', 'ILS', 'IL'),
  ('c0980000-0000-4000-8000-000000000004', 'a0980000-0000-4000-8000-000000000001',
   'P98 cleaning', 'active', 'ILS', 'IL');

-- ===== 1. The arithmetic, before anything writes =====
-- These are the cases a hand-written month calculation gets wrong, and each is a real customer
-- arrangement rather than a curiosity.

-- "The 28th to the 31st" is how a business says end of month. February has neither.
select pg_temp.p98_assert(
  (select period_end from private.expectation_period_bounds(
     'monthly', 28, 31, null, null, date '2027-02-10')) = date '2027-02-28',
  'a monthly window ending on the 31st did not clamp to the end of a 28-day February');

select pg_temp.p98_assert(
  (select period_end from private.expectation_period_bounds(
     'monthly', 28, 31, null, null, date '2028-02-10')) = date '2028-02-29',
  'the leap day was not the end of February 2028');

-- A quarter's second month, not its first.
select pg_temp.p98_assert(
  (select period_start from private.expectation_period_bounds(
     'quarterly', 5, 9, null, 2, date '2026-08-20')) = date '2026-08-05',
  'the second month of the third quarter was not August');

-- Postgres weeks begin on Monday and this business does not. 2026-09-03 is a Thursday.
select pg_temp.p98_assert(
  (select period_start from private.expectation_period_bounds(
     'weekly', null, null, 0, null, date '2026-09-03')) = date '2026-08-30',
  'weekday 0 did not resolve to the Sunday that began the anchor''s week');

-- DAYLIGHT SAVING, AND WHERE IT ACTUALLY LIVES. The bounds function is pure date arithmetic and
-- cannot be affected by a clock change; the risk is in the scanner's `(now() at time zone tz)::date`.
-- Israel moved to summer time at 02:00 on 2026-03-27. An instant just after the change must still
-- read as the 27th locally -- if the cast happened before the timezone conversion it would read as
-- the 26th, and every window boundary would move by a day twice a year.
select pg_temp.p98_assert(
  (timestamptz '2026-03-27 03:30:00+03' at time zone 'Asia/Jerusalem')::date = date '2026-03-27'
  and (timestamptz '2026-10-25 01:30:00+03' at time zone 'Asia/Jerusalem')::date = date '2026-10-25',
  'a local date either side of a daylight-saving change did not stay on its own day');

-- ===== 2. What gets scanned, and what does not =====
-- Four expectations, one per supplier, differing only in the state and the activation date. Same
-- cadence and same window, so any difference in what the scan produces is caused by the thing
-- under test rather than by the calendar.

-- (a) ACTIVE and switched on long ago. This is the one that should be found late.
insert into public.supplier_document_expectations
  (id, org_id, supplier_id, document_type, cadence, expected_day_from, expected_day_to,
   grace_days, state, created_by, activated_at)
values ('d0980000-0000-4000-8000-000000000001', 'a0980000-0000-4000-8000-000000000001',
        'c0980000-0000-4000-8000-000000000001', 'invoice', 'monthly', 1, 1, 0, 'active',
        'b0980000-0000-4000-8000-000000000001', now() - interval '8 months');

-- (b) PROPOSED. Nobody approved it, so it must produce nothing at all: a proposal that scans is
-- the product creating work off a suggestion it made to itself.
insert into public.supplier_document_expectations
  (id, org_id, supplier_id, document_type, cadence, expected_day_from, expected_day_to,
   grace_days, state, created_by, activated_at)
values ('d0980000-0000-4000-8000-000000000002', 'a0980000-0000-4000-8000-000000000001',
        'c0980000-0000-4000-8000-000000000002', 'invoice', 'monthly', 1, 1, 0, 'proposed',
        'b0980000-0000-4000-8000-000000000001', now() - interval '8 months');

-- (c) PAUSED, and previously active. A pause is about the future; it must stop the scan without
-- deleting what is already recorded.
insert into public.supplier_document_expectations
  (id, org_id, supplier_id, document_type, cadence, expected_day_from, expected_day_to,
   grace_days, state, created_by, activated_at)
values ('d0980000-0000-4000-8000-000000000003', 'a0980000-0000-4000-8000-000000000001',
        'c0980000-0000-4000-8000-000000000003', 'invoice', 'monthly', 1, 1, 0, 'paused',
        'b0980000-0000-4000-8000-000000000001', now() - interval '8 months');

-- (d) ACTIVE but only switched on today. THE NEGATIVE CONTROL FOR `activated_at`: identical to (a)
-- in every other respect, so if last month appears for this one the guard is doing nothing.
insert into public.supplier_document_expectations
  (id, org_id, supplier_id, document_type, cadence, expected_day_from, expected_day_to,
   grace_days, state, created_by, activated_at)
values ('d0980000-0000-4000-8000-000000000004', 'a0980000-0000-4000-8000-000000000001',
        'c0980000-0000-4000-8000-000000000004', 'invoice', 'monthly', 1, 1, 0, 'active',
        'b0980000-0000-4000-8000-000000000001', now());

select private.dispatch_document_expectations();

select pg_temp.p98_assert(
  exists (select 1 from public.expectation_occurrences
           where expectation_id = 'd0980000-0000-4000-8000-000000000001'
             and period_start = pg_temp.p98_last_month_start()),
  'the active expectation got no occurrence for the month that has already ended');

select pg_temp.p98_assert(
  (select count(*) from public.expectation_occurrences
    where expectation_id = 'd0980000-0000-4000-8000-000000000002') = 0,
  'a proposal nobody approved was scanned');

select pg_temp.p98_assert(
  (select count(*) from public.expectation_occurrences
    where expectation_id = 'd0980000-0000-4000-8000-000000000003') = 0,
  'a paused expectation was scanned');

select pg_temp.p98_assert(
  (select count(*) from public.expectation_occurrences
    where expectation_id = 'd0980000-0000-4000-8000-000000000004'
      and period_start = pg_temp.p98_last_month_start()) = 0,
  'an expectation activated today was made responsible for last month');

-- ===== 3. The exception, and only after the window and the grace =====
select pg_temp.p98_assert(
  (select o.due_status from public.expectation_occurrences o
    where o.expectation_id = 'd0980000-0000-4000-8000-000000000001'
      and o.period_start = pg_temp.p98_last_month_start()) = 'missed',
  'a period whose window and grace both ended was not marked missed');

select pg_temp.p98_assert(
  (select o.exception_id is not null from public.expectation_occurrences o
    where o.expectation_id = 'd0980000-0000-4000-8000-000000000001'
      and o.period_start = pg_temp.p98_last_month_start()),
  'the missed period was not linked to the exception opened for it');

select pg_temp.p98_assert(
  (select e.type::text from public.exceptions e
    join public.expectation_occurrences o on o.exception_id = e.id
   where o.expectation_id = 'd0980000-0000-4000-8000-000000000001'
     and o.period_start = pg_temp.p98_last_month_start()) = 'expected_document_missing',
  'the exception opened for a document that never arrived was filed under another type');

-- STILL INSIDE THE WINDOW: a weekly expectation due today with a week of grace cannot be late.
-- This is the assertion that stops the scanner reporting everything the moment it exists.
insert into public.supplier_document_expectations
  (id, org_id, supplier_id, document_type, cadence, expected_weekday, grace_days,
   state, created_by, activated_at)
values ('d0980000-0000-4000-8000-000000000005', 'a0980000-0000-4000-8000-000000000001',
        'c0980000-0000-4000-8000-000000000002', 'delivery_note', 'weekly',
        extract(dow from (now() at time zone 'Asia/Jerusalem'))::int, 7, 'active',
        'b0980000-0000-4000-8000-000000000001', now() - interval '8 months');

select private.dispatch_document_expectations();

select pg_temp.p98_assert(
  (select count(*) from public.expectation_occurrences
    where expectation_id = 'd0980000-0000-4000-8000-000000000005'
      and due_status <> 'awaiting') = 0,
  'a period still inside its window and grace was reported as missing');

-- ===== 4. The automatic exception names no operator =====
-- Naming one would be a false statement in the audit trail about who did something, and the trail
-- is the thing a customer is entitled to trust. The REASON is still mandatory.
select pg_temp.p98_assert(
  exists (select 1 from audit_logs
           where action = 'expectation_occurrence_missed'
             and org_id = 'a0980000-0000-4000-8000-000000000001'
             and user_id is null
             and nullif(btrim(coalesce(reason, '')), '') is not null),
  'the automatically opened exception was audited without a reason, or with an operator named');

-- ===== 5. Running again changes nothing =====
-- The claim is not "the second run opened no exception" alone -- that could be true because the
-- second run did nothing at all. Both counts are taken, so a scan that silently stopped working
-- would fail this too.
create temporary table p98_before as
select (select count(*) from public.expectation_occurrences) as occurrences,
       (select count(*) from public.exceptions
         where type = 'expected_document_missing') as exceptions;

select private.dispatch_document_expectations();
select private.dispatch_document_expectations();

select pg_temp.p98_assert(
  (select occurrences from p98_before) = (select count(*) from public.expectation_occurrences)
  and (select exceptions from p98_before)
      = (select count(*) from public.exceptions where type = 'expected_document_missing'),
  'running the scan again opened a second occurrence or a second exception for the same period');

-- ONE EXCEPTION PER MISSED PERIOD, COUNTED BOTH WAYS. An expectation switched on eight months ago
-- legitimately has more than one finished period, so counting exceptions per expectation would
-- prove nothing; the claim is that the two totals agree. A scan that opened a second exception for
-- a period it had already reported would make the left side larger, and `exception_id` would point
-- at the newest while the older one sat in the tenant's list with nothing to close it.
select pg_temp.p98_assert(
  (select count(*) from public.exceptions
    where org_id = 'a0980000-0000-4000-8000-000000000001'
      and type = 'expected_document_missing')
  = (select count(*) from public.expectation_occurrences
      where org_id = 'a0980000-0000-4000-8000-000000000001' and due_status = 'missed'),
  'the number of exceptions opened does not equal the number of periods actually missed');

-- ===== 6. "Not this month" closes one month =====
select set_config('request.jwt.claim.sub', 'b0980000-0000-4000-8000-000000000001', true);

-- A second finished period to prove the scope of the command: the month before last.
insert into public.expectation_occurrences
  (id, org_id, expectation_id, period_start, period_end)
values ('e0980000-0000-4000-8000-000000000009', 'a0980000-0000-4000-8000-000000000001',
        'd0980000-0000-4000-8000-000000000001',
        (pg_temp.p98_last_month_start() - interval '1 month')::date,
        (pg_temp.p98_last_month_start() - interval '1 month')::date);

select public.mark_expectation_not_due(
  (select id from public.expectation_occurrences
    where expectation_id = 'd0980000-0000-4000-8000-000000000001'
      and period_start = pg_temp.p98_last_month_start()),
  'the supplier confirmed there was no consumption to bill in this period');

select pg_temp.p98_assert(
  (select due_status from public.expectation_occurrences
    where expectation_id = 'd0980000-0000-4000-8000-000000000001'
      and period_start = pg_temp.p98_last_month_start()) = 'not_due',
  'the period a person said was not expected is still awaiting a document');

-- THE POINT OF THE COMMAND: the neighbouring period is untouched. If "not due" had paused the
-- expectation, this row would have been silenced too and nobody would ever be told about it.
select pg_temp.p98_assert(
  (select due_status from public.expectation_occurrences
    where id = 'e0980000-0000-4000-8000-000000000009') = 'awaiting',
  'marking one period not due changed a different period');

-- And the exception that had been opened for it is withdrawn rather than left standing, because
-- an open exception says the document is still missing after a person said it was never coming.
select pg_temp.p98_assert(
  (select e.status::text from public.exceptions e
    where e.id = (select exception_id from public.expectation_occurrences
                   where expectation_id = 'd0980000-0000-4000-8000-000000000001'
                     and period_start = pg_temp.p98_last_month_start())) = 'dismissed',
  'the exception for a period since declared not due was left open');

-- The next scan does not undo the ruling.
select private.dispatch_document_expectations();
select pg_temp.p98_assert(
  (select due_status from public.expectation_occurrences
    where expectation_id = 'd0980000-0000-4000-8000-000000000001'
      and period_start = pg_temp.p98_last_month_start()) = 'not_due',
  'the next scan reopened a period a person had closed');

-- ===== 7. A late document does not erase having been late =====
select private.dispatch_document_expectations();

select public.resolve_expectation_occurrence(
  'e0980000-0000-4000-8000-000000000009', null,
  'the invoice arrived by email three weeks after the period closed');

select pg_temp.p98_assert(
  (select due_status from public.expectation_occurrences
    where id = 'e0980000-0000-4000-8000-000000000009') = 'received',
  'the arriving document did not move the period to received');

select pg_temp.p98_assert(
  (select missed_at is not null and received_late
     from public.expectation_occurrences
    where id = 'e0980000-0000-4000-8000-000000000009'),
  'the fact that the document had been missed was erased when it finally arrived');

-- ===== 8. The commands refuse the roles and the arguments they must =====
select pg_temp.p98_assert(
  pg_temp.p98_refuses($$select public.mark_expectation_not_due(
    'e0980000-0000-4000-8000-000000000009', '   ')$$),
  'a sensitive command accepted a blank reason');

select pg_temp.p98_assert(
  pg_temp.p98_refuses($$select public.activate_document_expectation(
    'd0980000-0000-4000-8000-000000000099', 'no such row')$$),
  'activating an expectation that does not exist was accepted');

-- The accountant is refused by ENFORCEMENT rather than by the screen not offering the button.
-- `org_id = auth_org()` alone would have let every role in the tenant read this.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'b0980000-0000-4000-8000-000000000002', true);

select pg_temp.p98_assert(
  (select count(*) from public.expectation_occurrences) = 0
  and (select count(*) from public.supplier_document_expectations) = 0,
  'the accountant read expectation rows directly -- this is a procurement surface');

select pg_temp.p98_assert(
  pg_temp.p98_refuses($$select public.mark_expectation_not_due(
    'e0980000-0000-4000-8000-000000000009', 'the accountant should not be able to say this')$$),
  'the accountant was allowed to rule on a period');

-- And the owner does see them, so the previous assertion measured the role rather than an empty
-- table or a broken fixture.
select set_config('request.jwt.claim.sub', 'b0980000-0000-4000-8000-000000000001', true);
select pg_temp.p98_assert(
  (select count(*) from public.expectation_occurrences) > 0,
  'the owner could not read the occurrences either -- the accountant assertion proved nothing');

reset role;

-- ===== 9. No client role can run the scan =====
-- A tenant able to call this could open exceptions across every organisation at a moment of its
-- choosing. Asked through the catalogue rather than by calling it: attempting the call as the
-- wrong role and catching the refusal takes the backend down.
select pg_temp.p98_assert(
  not has_function_privilege('authenticated', 'private.dispatch_document_expectations()', 'execute')
  and not has_function_privilege('anon', 'private.dispatch_document_expectations()', 'execute'),
  'a client role can execute the scanner');

select pg_temp.p98_assert(
  exists (select 1 from cron.job where jobname = 'supplyflow-document-expectations'),
  'the nightly scan is not scheduled');

rollback;

select 'P98_document_expectation_scanner_passed' as result;
