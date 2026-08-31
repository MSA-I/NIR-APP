-- P89 — one window, one clock, and a boundary that is the one that actually changes something.
--
-- `0262` moved the thirty-day introduction out of `effective_entitlement` and into
-- `private.free_intro_window()`, then built `public.my_benefit_window()` on top of it. The
-- entitlement parity of that move was proved before and after the migration, on 400 calls across
-- six plans, three window states, an override and an organisation with no subscription. What THIS
-- suite pins is the behaviour that has to keep holding afterwards:
--
--   THE EXTRACTED WINDOW IS THE LADDER'S OWN. For every fixture, `free_intro_window` returns a row
--   exactly when `effective_entitlement` calls an introduction-presented key `intro`. Two
--   definitions drifting apart is the failure `0210` and `0212` name, and the countdown reading a
--   window the ladder does not honour is what it would look like here.
--
--   THE BOUNDARY IS THE ONE AFTER WHICH THE ENTITLEMENT DIFFERS. An organisation on a granted
--   premium plan has NO introduction window at all — the ladder requires `plan_key = 'free'` — so
--   its intro stamp expiring takes nothing away, and the benefit window must report the GRANT.
--   Choosing the earlier of two dates would show that tenant a downgrade that will not happen.
--
--   A PAYING CUSTOMER IS NOT ELIGIBLE, and expiry is null rather than zero or a negative number.
--
--   AND THE PAYLOAD CARRIES KEYS, NEVER LABELS. `subscription_plans.label` is Hebrew, the product
--   has `profiles.locale`, and `check:i18n` is a ratchet on source code rather than a gate on
--   strings arriving from the database — so nothing but this assertion stands between a Hebrew
--   label and an English screen.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p89_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P89 benefit window assertion failed: %', p_message;
  end if;
end
$$;

/*
 * Acting as the owner of one organisation. Only the JWT claim is set, deliberately: `auth_org()`
 * is SECURITY DEFINER and reads `auth.uid()`, so the claim alone decides which organisation the
 * benefit window answers about. Switching the session role as well would leave this suite unable
 * to read `private` for its own expectations, and role-level access is asserted where it belongs
 * — with `has_function_privilege`, never by provoking a denial inside a `set role` block.
 */
create function pg_temp.p89_as(p_user uuid)
returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_user::text, true);
$$;

-- ---- Fixtures: the four states the benefit window can be in ----------------------------------
do $seed$
declare
  v_case record;
begin
  for v_case in
    select * from (values
      -- free plan, live intro stamp: the introduction is the window that ends.
      ('01', 'free',    'active',  false, false),
      -- free plan, stamp older than thirty days: nothing is live.
      ('02', 'free',    'expired', false, false),
      -- free plan, no stamp at all.
      ('03', 'free',    'none',    false, false),
      -- GRANTED premium with a live stamp. The ladder gives it no introduction window, so the
      -- grant is the only boundary — and the stamp expiring costs it nothing.
      ('04', 'premium', 'active',  true,  false),
      -- Paid, on free, with a live stamp: a window exists but nobody is eligible for the offer.
      ('05', 'free',    'active',  false, true)
    ) as t(n, plan_key, intro, granted, paid)
  loop
    insert into public.organizations(id, name, status, vat_rate, base_currency, country_code)
    values (('b0890000-0000-4000-8000-0000000000' || v_case.n)::uuid,
            'P89 ' || v_case.n, 'active', 18, 'ILS', 'IL');
    insert into public.organization_subscriptions(org_id, plan_key, granted_until, provider)
    values (('b0890000-0000-4000-8000-0000000000' || v_case.n)::uuid, v_case.plan_key,
            case when v_case.granted then now() + interval '45 days' end, 'manual')
    on conflict (org_id) do update
      set plan_key = excluded.plan_key, granted_until = excluded.granted_until,
          provider = excluded.provider;

    if v_case.intro <> 'none' then
      insert into private.assistant_intro_windows(org_id, started_at, source)
      values (('b0890000-0000-4000-8000-0000000000' || v_case.n)::uuid,
              now() - (case when v_case.intro = 'active' then interval '3 days'
                            else interval '90 days' end), 'backfill');
    end if;

    if v_case.paid then
      insert into public.organization_billing_periods
        (org_id, plan_key, billing_interval, catalogue_version, amount, currency,
         period_start, period_end, opened_reason)
      values (('b0890000-0000-4000-8000-0000000000' || v_case.n)::uuid, v_case.plan_key,
              'monthly', 'launch-il', 100, 'ILS',
              now() - interval '10 days', now() + interval '20 days',
              'p89 fixture');
    end if;

    insert into auth.users (id, email)
    values (('c0890000-0000-4000-8000-0000000000' || v_case.n)::uuid,
            'p89-' || v_case.n || '@example.test');
    insert into public.profiles(id, org_id, full_name, role, active)
    values (('c0890000-0000-4000-8000-0000000000' || v_case.n)::uuid,
            ('b0890000-0000-4000-8000-0000000000' || v_case.n)::uuid,
            'P89 owner ' || v_case.n, 'owner', true);
  end loop;
end
$seed$;

-- ---- 1. The extracted window is the ladder's own, for every fixture. --------------------------
-- Not "returns something reasonable": for each organisation, the window exists exactly when the
-- entitlement ladder calls an introduction-presented key `intro`. This is the assertion that
-- would fail if the extraction ever drifted from the CTE it replaced.
select pg_temp.p89_assert(
  not exists (
    select 1
    from (values ('01'), ('02'), ('03'), ('04'), ('05')) as t(n)
    cross join lateral (
      select ('b0890000-0000-4000-8000-0000000000' || t.n)::uuid as org) o
    where exists (select 1 from private.free_intro_window(o.org)) is distinct from
          (public.effective_entitlement(o.org, 'history.full') ->> 'source' = 'intro')),
  'the extracted window disagrees with the ladder about who is in an introduction');

-- And it is not vacuous: at least one fixture IS in a window and at least one is not.
select pg_temp.p89_assert(
  exists (select 1 from private.free_intro_window('b0890000-0000-4000-8000-000000000001'))
  and not exists (select 1 from private.free_intro_window('b0890000-0000-4000-8000-000000000002')),
  'the fixtures do not exercise both sides of the window');

-- ---- 2. A granted premium tenant has no introduction to lose. ---------------------------------
-- The ladder requires `plan_key = 'free'`. This is the whole reason the boundary rule is "the
-- next change in entitlement" and not "the earliest date": fixture 04 has a live intro stamp and
-- no intro window, so its stamp expiring is not a downgrade.
select pg_temp.p89_assert(
  not exists (select 1 from private.free_intro_window('b0890000-0000-4000-8000-000000000004')),
  '04: a granted premium organisation was given an introduction window');
select pg_temp.p89_assert(
  exists (select 1 from private.assistant_intro_windows
          where org_id = 'b0890000-0000-4000-8000-000000000004'
            and now() < started_at + interval '30 days'),
  '04: the fixture does not actually carry a live stamp, so the assertion above proves nothing');

-- ---- 3. `my_benefit_window()` picks the boundary that changes something. ----------------------
select pg_temp.p89_as('c0890000-0000-4000-8000-000000000001');
select pg_temp.p89_assert(
  public.my_benefit_window() -> 'window' ->> 'kind' = 'free_intro',
  '01: a free organisation in its introduction does not report the introduction');
select pg_temp.p89_assert(
  (public.my_benefit_window() -> 'window' ->> 'ends_at')::timestamptz
    = (select ends_at from private.free_intro_window('b0890000-0000-4000-8000-000000000001')),
  '01: the reported end is not the window''s own end');
-- The plan the ladder actually grants during the introduction, from its `effective_plan` CTE.
select pg_temp.p89_assert(
  public.my_benefit_window() -> 'window' ->> 'plan_key' = 'basic'
  and public.my_benefit_window() -> 'window' ->> 'reverts_to_plan_key' = 'free',
  '01: the introduction does not report the plan it grants and the plan it falls back to');
select pg_temp.p89_assert(
  (public.my_benefit_window() ->> 'eligible')::boolean, '01: an unpaid tenant in a window is not eligible');

select pg_temp.p89_as('c0890000-0000-4000-8000-000000000004');
select pg_temp.p89_assert(
  public.my_benefit_window() -> 'window' ->> 'kind' = 'prelaunch_grant',
  '04: the grant did not win over a stamp that grants nothing');
select pg_temp.p89_assert(
  (public.my_benefit_window() -> 'window' ->> 'ends_at')::timestamptz
    = (public.my_plan_grant() ->> 'ends_at')::timestamptz,
  '04: the grant end is not my_plan_grant''s own — the grant is defined twice');
select pg_temp.p89_assert(
  public.my_benefit_window() -> 'window' ->> 'plan_key' = 'premium',
  '04: the granted plan is not reported');

-- ---- 4. Expiry is null. Not zero, not negative, not a restart. --------------------------------
select pg_temp.p89_as('c0890000-0000-4000-8000-000000000002');
select pg_temp.p89_assert(
  jsonb_typeof(public.my_benefit_window() -> 'window') = 'null',
  '02: an expired introduction reports a window');
select pg_temp.p89_assert(
  not (public.my_benefit_window() ->> 'eligible')::boolean,
  '02: an expired introduction leaves the tenant eligible');

select pg_temp.p89_as('c0890000-0000-4000-8000-000000000003');
select pg_temp.p89_assert(
  jsonb_typeof(public.my_benefit_window() -> 'window') = 'null',
  '03: an organisation that never had a window reports one');

-- ---- 5. A paying customer never sees the offer. -----------------------------------------------
select pg_temp.p89_as('c0890000-0000-4000-8000-000000000005');
select pg_temp.p89_assert(
  (public.my_benefit_window() ->> 'has_paid')::boolean,
  '05: a billing period does not make has_paid true');
select pg_temp.p89_assert(
  not (public.my_benefit_window() ->> 'eligible')::boolean,
  '05: a paying customer is eligible for the launch offer');
-- The window itself is still reported; it is eligibility that turns off, because the strip needs
-- to know the truth about the account even when it does not offer anything.
select pg_temp.p89_assert(
  public.my_benefit_window() -> 'window' ->> 'kind' = 'free_intro',
  '05: paying hid the window as well as the offer');

-- ---- 6. The server clock is there, and it is the SERVER'S. ------------------------------------
select pg_temp.p89_assert(
  (public.my_benefit_window() ->> 'server_now')::timestamptz between now() - interval '1 minute'
                                                                and now() + interval '1 minute',
  'server_now is not the server''s own clock');

-- ---- 7. Keys, never labels. -------------------------------------------------------------------
-- One Hebrew label reaching an English screen, and no guard in the repository would catch it.
select pg_temp.p89_as('c0890000-0000-4000-8000-000000000001');
select pg_temp.p89_assert(
  not exists (
    select 1 from jsonb_each_text(public.my_benefit_window() -> 'window')
    where value ~ '[֐-׿]'),
  'the benefit window returned a Hebrew string');
select pg_temp.p89_assert(
  (select count(*) from jsonb_object_keys(public.my_benefit_window() -> 'window') k) = 5,
  'the window object grew or lost a key without this suite being told');

-- ---- 8. Only the roles that should reach it, can. ---------------------------------------------
-- Read as a privilege, never by switching role and catching the denial: a denied EXECUTE inside a
-- `set role` block takes the backend down with it.
select pg_temp.p89_assert(
  has_function_privilege('authenticated', 'public.my_benefit_window()', 'execute')
  and not has_function_privilege('anon', 'public.my_benefit_window()', 'execute'),
  'my_benefit_window is not exactly authenticated-only');
select pg_temp.p89_assert(
  not has_function_privilege('authenticated', 'private.free_intro_window(uuid)', 'execute')
  and not has_function_privilege('anon', 'private.free_intro_window(uuid)', 'execute'),
  'the private window helper is reachable by a client role');

rollback;

select 'P89_benefit_window_passed' as result;
