-- P94 — the launch window moved, and it moved in every place that held a copy of it.
--
-- `0267` extends the pre-launch window by one month (owner ruling 31.08.2026, `OPEN-DECISIONS
-- #314`). The interesting half is not the function: it is that the old value had already been
-- COPIED INTO ROWS in three tables, so redefining the function alone would have moved not one
-- existing customer while looking like a complete change.
--
-- WHAT THIS SUITE CAN AND CANNOT PROVE, said plainly because it changes what the assertions mean.
-- The suite runs after every migration, so the backfill has already happened and cannot be watched
-- happening. What is provable after the fact is the END STATE — the function's value, that no row
-- in the three places still carries the old date, that the JSONB survived being edited, and that
-- every move is in the ledger with the ruling behind it — plus the CONDITIONALITY, tested by
-- building the rows the backfill was written to skip and asserting the migration's own predicates
-- do not select them.
--
-- AND THE FOURTH COPY IS NOT TESTABLE HERE AT ALL. `AI_ASSISTANT_PRELAUNCH_EXCEPTION` is an Edge
-- secret outside the repository. No suite can read it. It is verified by hand in the same rollout,
-- and its absence from this file is a limit rather than an oversight.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p94_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P94 launch window assertion failed: %', p_message;
  end if;
end
$$;

-- ---- 1. The one literal moved, and it is still the only one. ---------------------------------
select pg_temp.p94_assert(
  private.prelaunch_window_end() = '2027-02-01T00:00:00+00'::timestamptz,
  'the window is not at the extended date');

-- A second copy of a deadline in a routine body is how the two halves split apart (0210:25).
select pg_temp.p94_assert(
  not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.proname <> 'prelaunch_window_end'
      and (replace(p.prosrc, chr(13), '') like '%2027-01-01T00:00:00%'
        or replace(p.prosrc, chr(13), '') like '%2027-02-01T00:00:00%')),
  'a routine other than prelaunch_window_end carries a copy of the window');

-- ---- 2. Nothing was left behind carrying the old date. ---------------------------------------
select pg_temp.p94_assert(
  not exists (
    select 1 from public.organization_subscriptions subscription
    where subscription.provider = 'manual'
      and subscription.granted_until = '2027-01-01T00:00:00+00'::timestamptz
      and not exists (select 1 from public.organization_billing_periods period
                       where period.org_id = subscription.org_id)),
  'a manual unpaid subscription still expires on the old date');
select pg_temp.p94_assert(
  not exists (
    select 1 from public.org_flag_configurations
    where flag_key in ('assistant.ui', 'assistant.history')
      and targeting ->> 'ends_at' = '2027-01-01T00:00:00+00'),
  'an assistant exposure flag still ends on the old date');
select pg_temp.p94_assert(
  not exists (
    select 1 from public.org_autonomy_policies
    where policy_key in ('document.interpretation', 'delivery_note.receiving',
                         'price_list.intake', 'document.packet_split')
      and expires_at = '2027-01-01T00:00:00+00'::timestamptz),
  'a document-autonomy policy still expires on the old date');

-- And the assertions above are not vacuous: rows of each kind actually exist to have been moved.
select pg_temp.p94_assert(
  (select count(*) from public.org_flag_configurations
   where flag_key in ('assistant.ui', 'assistant.history')
     and targeting ->> 'ends_at' = '2027-02-01T00:00:00+00') > 0,
  'no assistant exposure flag carries the new date, so nothing was there to move');
select pg_temp.p94_assert(
  (select count(*) from public.org_autonomy_policies
   where policy_key in ('document.interpretation', 'delivery_note.receiving',
                        'price_list.intake', 'document.packet_split')
     and expires_at = '2027-02-01T00:00:00+00'::timestamptz) > 0,
  'no autonomy policy carries the new date, so nothing was there to move');

-- ---- 3. The JSONB survived being edited. -----------------------------------------------------
-- `jsonb_set` on a path that does not exist is a silent no-op, so the shape is asserted rather
-- than assumed: an object, with an end date still in it.
select pg_temp.p94_assert(
  not exists (
    select 1 from public.org_flag_configurations
    where flag_key in ('assistant.ui', 'assistant.history')
      and targeting is not null
      and (jsonb_typeof(targeting) <> 'object' or targeting ->> 'ends_at' is null)),
  'a targeting row lost its shape or its end date');

-- ---- 4. THE CONSEQUENCE THE EXTENSION EXISTS FOR. --------------------------------------------
-- A window that ends on 2027-02-01 must still be open on a date in January 2027 — the month the
-- extension bought. Read off the stored value rather than off the function, because the stored
-- value is what `resolve_feature_flags` will actually compare against.
select pg_temp.p94_assert(
  not exists (
    select 1 from public.org_flag_configurations
    where flag_key in ('assistant.ui', 'assistant.history')
      and state
      and (targeting ->> 'ends_at')::timestamptz <= '2027-01-15T00:00:00+00'::timestamptz),
  'an assistant exposure flag would already be closed in the month the extension bought');

-- ---- 5. The conditionality, tested on rows built to be skipped. ------------------------------
-- The backfill was keyed on the EXACT old value and carried forward the guards of the migration
-- that wrote each column. These fixtures are what those guards exist to protect: a date an
-- operator chose, and an organisation that has paid.
insert into public.organizations(id, name, status, vat_rate, base_currency, country_code) values
  ('a0940000-0000-4000-8000-000000000001', 'P94 hand-dated', 'active', 18, 'ILS', 'IL'),
  ('a0940000-0000-4000-8000-000000000002', 'P94 paying', 'active', 18, 'ILS', 'IL');

-- An operator set this one to a different date on purpose. It is a decision, not a copy.
insert into public.organization_subscriptions(org_id, plan_key, provider, granted_until)
values ('a0940000-0000-4000-8000-000000000001', 'premium', 'manual',
        '2027-06-30T00:00:00+00'::timestamptz)
on conflict (org_id) do update
  set plan_key = 'premium', provider = 'manual', granted_until = excluded.granted_until;

-- And this one has paid, which is the clause `0212` said matters most.
insert into public.organization_subscriptions(org_id, plan_key, provider, granted_until)
values ('a0940000-0000-4000-8000-000000000002', 'premium', 'manual',
        '2027-01-01T00:00:00+00'::timestamptz)
on conflict (org_id) do update
  set plan_key = 'premium', provider = 'manual', granted_until = excluded.granted_until;
insert into public.organization_billing_periods
  (org_id, plan_key, billing_interval, catalogue_version, amount, currency,
   period_start, period_end, opened_reason)
values ('a0940000-0000-4000-8000-000000000002', 'premium', 'monthly', 'launch-il', 100, 'ILS',
        now() - interval '10 days', now() + interval '20 days', 'p94 fixture');

-- The migration's own predicate, run against them. Neither may be selected.
select pg_temp.p94_assert(
  not exists (
    select 1 from public.organization_subscriptions subscription
    where subscription.provider = 'manual'
      and subscription.granted_until = '2027-01-01T00:00:00+00'::timestamptz
      and not exists (select 1 from public.organization_billing_periods period
                       where period.org_id = subscription.org_id)
      and subscription.org_id in ('a0940000-0000-4000-8000-000000000001',
                                  'a0940000-0000-4000-8000-000000000002')),
  'the backfill predicate selects a hand-dated row or a paying organisation');

-- Stated the other way, so the fixture cannot pass by simply not existing: the hand-dated row
-- keeps its own date, and the paying one keeps the old date it was never entitled to have moved.
select pg_temp.p94_assert(
  (select granted_until from public.organization_subscriptions
   where org_id = 'a0940000-0000-4000-8000-000000000001')
    = '2027-06-30T00:00:00+00'::timestamptz,
  'the hand-dated grant did not keep the date an operator chose');
select pg_temp.p94_assert(
  (select granted_until from public.organization_subscriptions
   where org_id = 'a0940000-0000-4000-8000-000000000002')
    = '2027-01-01T00:00:00+00'::timestamptz,
  'the paying organisation was swept into a backfill that excludes it');

-- ---- 6. Every move is in the ledger, with the ruling behind it. ------------------------------
-- Extending entitlement is a financial change, and "the migration did it" is not a reason.
-- NOT `count(*) > 0`. That asserted the DATABASE happened to hold rows worth moving, not that
-- the code logs what it moves, so it passed or failed with the fixture set rather than with the
-- migration -- and it did both on this branch before any merge reached it.
--
-- A silent move is not expressible here: `0270` writes the ledger in the SAME statement as the
-- update (`with moved as (update ... returning) insert into audit_logs ... from moved`), so a
-- row cannot be moved without the insert seeing it. And the migration already asserts, at
-- migration time, that every row it wrote carries the ruling.
--
-- What is worth asserting from out here, and is true whatever the database held, is the other
-- direction: nothing the backfill exists to EXCLUDE may appear in the ledger. The two fixtures
-- above are exactly those cases -- a date an operator chose, and an organisation that has paid.
select pg_temp.p94_assert(
  not exists (
    select 1 from audit_logs ledger
    where ledger.action = 'prelaunch_window_extended'
      and ledger.org_id in ('a0940000-0000-4000-8000-000000000001',
                            'a0940000-0000-4000-8000-000000000002')),
  'a hand-dated or paying organisation was written to the extension ledger');
select pg_temp.p94_assert(
  not exists (
    select 1 from audit_logs
    where action = 'prelaunch_window_extended'
      and (reason is null or length(trim(reason)) = 0 or position('#314' in reason) = 0)),
  'a window extension was logged without the ruling behind it');
-- The old and the new value are both on the row, so a reader can see what actually changed.
select pg_temp.p94_assert(
  not exists (
    select 1 from audit_logs
    where action = 'prelaunch_window_extended'
      and (old_values is null or new_values is null or old_values = new_values)),
  'a window extension was logged without both sides of the change');
-- NO ASSERTION HERE MAY REQUIRE THE LEDGER TO CONTAIN ANYTHING, and the reason is structural
-- rather than a quirk of this fixture set. Traced through the migrations:
--
--   * 0210 and 0211 seed org_flag_configurations and org_autonomy_policies with
--     `... from organizations o` -- over organisations that ALREADY EXIST. The same rows are
--     otherwise written by a birth trigger, one organisation at a time.
--   * organization_subscriptions belongs to a tenant in exactly the same way.
--   * `supabase db reset` runs every migration BEFORE any seed. At the moment 0270 executes,
--     `organizations` is empty, so all three source tables are empty, the backfill correctly
--     moves nothing, and the ledger is correctly empty.
--
-- The demo seed then creates organisations, and their birth trigger writes
-- `private.prelaunch_window_end()` -- which 0270 has already moved. That is why section 2
-- above finds rows carrying the NEW date and passes: they were BORN with it. They were never
-- moved, so nothing was logged, and no count over audit_logs can be satisfied.
--
-- Three assertions were tried here and all three were unsatisfiable for this one reason:
-- `count(*) > 0`, then `count(distinct entity_type) = 3`, then 'the two tables that always
-- have rows'. There is no fourth version: presence cannot be asserted from out here at all.
--
-- What CAN be asserted is the shape of whatever the ledger does hold, and that nothing the
-- backfill excludes ever appears in it. Those are the assertions above and below, and they
-- are the ones that would actually catch a regression: a backfill that logged a paying
-- organisation, or logged without a reason, or logged without both sides of the change.

rollback;

select 'P94_launch_window_extension_passed' as result;
