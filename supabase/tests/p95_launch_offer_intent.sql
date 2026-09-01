-- P95 — one intent per window, one log row, and a door that refuses instead of emptying.
--
-- `0269` records that an owner wants to talk about continuing. The interesting parts are all about
-- what must NOT happen twice, and what must not be answered with silence:
--
--   TWO DEVICES, ONE ROW, ONE LOG ENTRY. The UNIQUE constraint is what lets the strip stop asking,
--   and `on conflict do nothing returning` is what stops the ledger gaining a second entry for a
--   row that was never written. A constraint alone would have produced one table row and two audit
--   rows — the exact duplicate it exists to prevent.
--
--   THE WINDOW IS DERIVED, NEVER SUPPLIED. A caller that named its own `window_kind` or
--   `window_ends_at` would be choosing the key of its own uniqueness constraint. The signature
--   takes a reason and nothing else, and this suite proves the derived values are the server's.
--
--   AND A NON-OWNER IS REFUSED IN WORDS. `my_benefit_window()` returns `free_intro` and
--   `intent_recorded`, neither of which `my_plan_grant()` exposes, so it is a WIDER door than the
--   one 0262 reasoned from. An empty object would read as "you have no benefit", which is a
--   different sentence from "this is not yours to see".
\set ON_ERROR_STOP on

begin;

create function pg_temp.p95_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P95 launch offer assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p95_as(p_user uuid)
returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_user::text, true);
$$;

-- Two organisations: one inside a live grant, one that has paid.
insert into public.organizations(id, name, status, vat_rate, base_currency, country_code) values
  ('a0950000-0000-4000-8000-000000000001', 'P95 granted', 'active', 18, 'ILS', 'IL'),
  ('a0950000-0000-4000-8000-000000000002', 'P95 paying', 'active', 18, 'ILS', 'IL');
insert into auth.users (id, email) values
  ('b0950000-0000-4000-8000-000000000001', 'p95-owner@example.test'),
  ('b0950000-0000-4000-8000-000000000002', 'p95-office@example.test'),
  ('b0950000-0000-4000-8000-000000000003', 'p95-paying-owner@example.test');
insert into public.profiles(id, org_id, full_name, role, active) values
  ('b0950000-0000-4000-8000-000000000001', 'a0950000-0000-4000-8000-000000000001',
   'P95 owner', 'owner', true),
  ('b0950000-0000-4000-8000-000000000002', 'a0950000-0000-4000-8000-000000000001',
   'P95 office', 'office', true),
  ('b0950000-0000-4000-8000-000000000003', 'a0950000-0000-4000-8000-000000000002',
   'P95 paying owner', 'owner', true);

insert into public.organization_subscriptions(org_id, plan_key, provider, granted_until) values
  ('a0950000-0000-4000-8000-000000000001', 'premium', 'manual', now() + interval '45 days')
on conflict (org_id) do update
  set plan_key = 'premium', provider = 'manual', granted_until = excluded.granted_until;
insert into public.organization_subscriptions(org_id, plan_key, provider, granted_until) values
  ('a0950000-0000-4000-8000-000000000002', 'premium', 'manual', now() + interval '45 days')
on conflict (org_id) do update
  set plan_key = 'premium', provider = 'manual', granted_until = excluded.granted_until;
insert into public.organization_billing_periods
  (org_id, plan_key, billing_interval, catalogue_version, amount, currency,
   period_start, period_end, opened_reason)
values ('a0950000-0000-4000-8000-000000000002', 'premium', 'monthly', 'launch-il', 100, 'ILS',
        now() - interval '10 days', now() + interval '20 days', 'p95 fixture');

-- ---- 1. The window is visible to the owner, and refused to everybody else. --------------------
select pg_temp.p95_as('b0950000-0000-4000-8000-000000000001');
select pg_temp.p95_assert(
  public.my_benefit_window() -> 'window' ->> 'kind' = 'prelaunch_grant',
  'the owner cannot see the grant window');
select pg_temp.p95_assert(
  not (public.my_benefit_window() ->> 'intent_recorded')::boolean,
  'an untouched window already reports an intent');
select pg_temp.p95_assert(
  (public.my_benefit_window() ->> 'eligible')::boolean,
  'an owner inside an unanswered window is not eligible');

-- A REFUSAL, NOT AN EMPTY OBJECT. "You have no benefit" and "this is not yours to see" are
-- different sentences, and only one of them is true here.
select pg_temp.p95_as('b0950000-0000-4000-8000-000000000002');
select pg_temp.p95_assert(
  public.my_benefit_window() ->> 'status' = 'not_permitted',
  'a non-owner was answered instead of refused');
select pg_temp.p95_assert(
  public.my_benefit_window() -> 'window' is null
    and public.my_benefit_window() ->> 'reason' = 'role_out_of_scope',
  'the refusal carried figures, or did not say why');

-- ---- 2. Two presses, one row, one log entry. -------------------------------------------------
select pg_temp.p95_as('b0950000-0000-4000-8000-000000000001');
select pg_temp.p95_assert(
  (public.record_launch_offer_intent('P95 first press') ->> 'recorded')::boolean,
  'the first press did not record an intent');

-- THE ASSERTION THIS SUITE EXISTS FOR. A second device, the same window.
select pg_temp.p95_assert(
  not (public.record_launch_offer_intent('P95 second press') ->> 'recorded')::boolean
  and (public.record_launch_offer_intent('P95 third press') ->> 'already_recorded')::boolean,
  'a repeated press reported a second recording');
select pg_temp.p95_assert(
  (select count(*) from public.launch_offer_intents
   where org_id = 'a0950000-0000-4000-8000-000000000001') = 1,
  'the intents table gained a second row for one window');
-- And the ledger did NOT gain entries for rows that were never written. This is the half a
-- UNIQUE constraint alone would have missed.
select pg_temp.p95_assert(
  (select count(*) from audit_logs
   where org_id = 'a0950000-0000-4000-8000-000000000001'
     and action = 'launch_offer_intent_recorded') = 1,
  'the ledger carries one entry per press instead of one per intent');

-- ---- 3. The window derives from the server, and the strip can now disappear. ------------------
select pg_temp.p95_assert(
  (select window_kind from public.launch_offer_intents
   where org_id = 'a0950000-0000-4000-8000-000000000001') = 'prelaunch_grant',
  'the recorded window kind is not the one the server derived');
select pg_temp.p95_assert(
  (select window_ends_at from public.launch_offer_intents
   where org_id = 'a0950000-0000-4000-8000-000000000001')
    = (public.my_plan_grant() ->> 'ends_at')::timestamptz,
  'the recorded boundary is not my_plan_grant''s own — the grant is defined twice');
select pg_temp.p95_assert(
  (public.my_benefit_window() ->> 'intent_recorded')::boolean
  and not (public.my_benefit_window() ->> 'eligible')::boolean,
  'after the intent the window still offers itself');
-- The window is still REPORTED — the strip needs to know the account's truth even when it stops
-- offering anything.
select pg_temp.p95_assert(
  public.my_benefit_window() -> 'window' ->> 'kind' = 'prelaunch_grant',
  'recording an intent hid the window as well as the offer');

-- ---- 4. What the command refuses. -------------------------------------------------------------
-- An organisation that has paid is not being offered anything, so there is nothing to intend.
select pg_temp.p95_as('b0950000-0000-4000-8000-000000000003');
do $paying$
declare v_refused boolean := false;
begin
  begin
    perform public.record_launch_offer_intent('P95 paying');
  exception when others then
    v_refused := sqlerrm = 'already_paying';
  end;
  if not v_refused then
    raise exception 'P95 launch offer assertion failed: a paying organisation recorded an intent';
  end if;
end
$paying$;

select pg_temp.p95_as('b0950000-0000-4000-8000-000000000002');
do $role$
declare v_refused boolean := false;
begin
  begin
    perform public.record_launch_offer_intent('P95 office');
  exception when insufficient_privilege then
    v_refused := sqlerrm = 'not_authorized';
  end;
  if not v_refused then
    raise exception 'P95 launch offer assertion failed: an office user recorded an intent';
  end if;
end
$role$;

-- ---- 5. It moved no money and changed no plan. -----------------------------------------------
select pg_temp.p95_assert(
  (select plan_key from public.organization_subscriptions
   where org_id = 'a0950000-0000-4000-8000-000000000001') = 'premium',
  'recording an intent changed the plan');
select pg_temp.p95_assert(
  not exists (select 1 from public.organization_billing_periods
              where org_id = 'a0950000-0000-4000-8000-000000000001'),
  'recording an intent opened a billing period');

-- ---- 6. Only the roles the server means, and no client writes the table. ---------------------
select pg_temp.p95_assert(
  has_function_privilege('authenticated', 'public.record_launch_offer_intent(text)', 'execute')
  and not has_function_privilege('anon', 'public.record_launch_offer_intent(text)', 'execute'),
  'the command is not exactly authenticated-only');
select pg_temp.p95_assert(
  not has_table_privilege('authenticated', 'public.launch_offer_intents', 'insert')
  and not has_table_privilege('authenticated', 'public.launch_offer_intents', 'delete')
  and has_table_privilege('authenticated', 'public.launch_offer_intents', 'select'),
  'the intents table is not read-only to the tenant');

rollback;

select 'P95_launch_offer_intent_passed' as result;
