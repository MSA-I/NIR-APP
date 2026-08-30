-- P77 -- The assistant quota stops being a refusal for everybody (0202, #198/#209/#242), and the
-- two read models the assistant may explain but never compute (0203, #189/#190/#145/#155/#182).
--
-- What it proves:
--   A1  Inside the 30-day introduction the allowance is 50: the 49th is admitted, the 50th is
--       refused by name, and the start stamp cannot be moved.
--   A2  One second past the window the organization is measured against its PLAN number, not 50.
--   A3  No verified owner email means no window row at all -- and the plan quota, not an invented
--       allowance.
--   A4  The four decided figures are in the catalogue and each is recorded beside what it replaced.
--   A5  `business` is `מותאם`: it refuses with assistant_limit_unknown until a per-contract
--       override exists, and is admitted the moment one does.
--   A6  Two sessions at limit-minus-one serialize on the locked counter and exactly one is
--       recorded (the committed section at the bottom; the p18/p20 dblink idiom).
--   A7  A tier change and the Legacy->Free move move neither the stamp nor the counter.
--   B1  A rise is reported with its baseline, source and as-of; a price that came back is silent;
--       a row with no authoritative baseline is unmeasurable and counted nowhere; the month is the
--       1st at 00:00 Asia/Jerusalem.
--   B2  A role that may not read prices gets zero rows through RLS, not an error.
--   F*  Falsification: every negative guard is fired on a real violation, because a guard that
--       merely returns no rows has proven nothing (the p68 #245/#251/#252 arms are the model).
--
-- Run only against an isolated local database with every migration applied. The first section is
-- rolled back; the concurrency section commits a disposable tenant and purges it again.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p77_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P77 assistant quota/read-model assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p77_as(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_user, 'amr', '[]'::jsonb)::text, true);
end
$$;

create function pg_temp.p77_anonymous()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', '{}', true);
end
$$;

-- The calendar month #178/#189 decide, computed the same way the read model computes it, so the
-- fixture below is dated against the boundary rather than against a hardcoded day.
create function pg_temp.p77_month_start() returns date language sql stable as $$
  select date_trunc('month', now() at time zone 'Asia/Jerusalem')::date
$$;

-- =====================================================================================
-- Fixture
-- =====================================================================================
insert into public.organizations (id, name, status) values
  ('77000000-0000-4000-8000-000000000001', 'P77 inside the introduction', 'active'),
  ('77000000-0000-4000-8000-000000000002', 'P77 introduction expired',    'active'),
  ('77000000-0000-4000-8000-000000000003', 'P77 unverified owner',        'active'),
  ('77000000-0000-4000-8000-000000000004', 'P77 business contract',       'active'),
  ('77000000-0000-4000-8000-000000000005', 'P77 prices tenant',           'active'),
  ('77000000-0000-4000-8000-000000000006', 'P77 business, newly verified', 'active');

-- 0210 creates an organisation on `premium` while the pre-launch window is open, and this suite is
-- about the WINDOW rather than about which plan a demo lands on -- its arms compare the intro
-- allowance against "the plan number", so that number has to be one the suite chose. Pinned to
-- `free` here, explicitly, so the assertions keep naming a figure instead of tracking whatever the
-- default happens to be this month. The arms that need another tier set it themselves below.
update public.organization_subscriptions set plan_key = 'free'
 where org_id in ('77000000-0000-4000-8000-000000000001', '77000000-0000-4000-8000-000000000002',
                  '77000000-0000-4000-8000-000000000003');

-- The prices tenant seats TWO people -- an owner and an accountant -- and since `0246` a rung's
-- `users.max` is enforced at the write, so `free` (one seat) refuses the second profile. This
-- tenant is about the comparison read models and asserts no plan figure of its own, so it is
-- pinned to `pro` for the same reason the three above are pinned to `free`: a chosen rung, not
-- whatever the birth trigger grants this month.
update public.organization_subscriptions set plan_key = 'pro'
 where org_id = '77000000-0000-4000-8000-000000000005';

insert into auth.users (id, email, email_confirmed_at) values
  ('78000000-0000-4000-8000-000000000001', 'owner-intro-p77@example.test',
   now() - interval '5 days'),
  ('78000000-0000-4000-8000-000000000002', 'owner-expired-p77@example.test',
   now() - interval '30 days 1 second'),
  ('78000000-0000-4000-8000-000000000003', 'owner-unverified-p77@example.test', null),
  ('78000000-0000-4000-8000-000000000004', 'owner-business-p77@example.test', null),
  ('78000000-0000-4000-8000-000000000005', 'owner-prices-p77@example.test', null),
  ('78000000-0000-4000-8000-000000000006', 'accountant-prices-p77@example.test', null),
  ('78000000-0000-4000-8000-000000000007', 'operator-p77@example.test', null),
  ('78000000-0000-4000-8000-000000000008', 'owner-business-new-p77@example.test',
   now() - interval '3 days');

insert into public.profiles (id, org_id, full_name, role) values
  ('78000000-0000-4000-8000-000000000001',
   '77000000-0000-4000-8000-000000000001', 'P77 intro owner',      'owner'),
  ('78000000-0000-4000-8000-000000000002',
   '77000000-0000-4000-8000-000000000002', 'P77 expired owner',    'owner'),
  ('78000000-0000-4000-8000-000000000003',
   '77000000-0000-4000-8000-000000000003', 'P77 unverified owner', 'owner'),
  ('78000000-0000-4000-8000-000000000004',
   '77000000-0000-4000-8000-000000000004', 'P77 business owner',   'owner'),
  ('78000000-0000-4000-8000-000000000005',
   '77000000-0000-4000-8000-000000000005', 'P77 prices owner',     'owner'),
  ('78000000-0000-4000-8000-000000000006',
   '77000000-0000-4000-8000-000000000005', 'P77 prices accountant', 'accountant'),
  ('78000000-0000-4000-8000-000000000008',
   '77000000-0000-4000-8000-000000000006', 'P77 new business owner', 'owner');

update public.organization_subscriptions set plan_key = 'business'
where org_id in ('77000000-0000-4000-8000-000000000004',
                 '77000000-0000-4000-8000-000000000006');

-- =====================================================================================
-- A4 -- the four decided figures, and the record beside each
-- =====================================================================================
select pg_temp.p77_assert(
  (select count(*) from (values
     ('free', 20), ('basic', 40), ('pro', 100), ('premium', 250)) as decided(plan_key, quota)
   join public.plan_entitlements entitlement
     on entitlement.plan_key = decided.plan_key
    and entitlement.entitlement_key = 'assistant_runs.monthly'
    and not entitlement.unlimited
    and entitlement.numeric_limit = decided.quota) = 4,
  'the assistant quotas are not the four figures #198 decided (free 20, basic 40, pro 100, premium 250)');

select pg_temp.p77_assert(
  (select count(*) from private.plan_quota_decisions
   where entitlement_key = 'assistant_runs.monthly'
     and decision_ref = 'OPEN-DECISIONS #198') = 4,
  'the #198 record does not hold the four assistant figures');
-- The previous value travels with the decision. It is null here and that is the point: before
-- #198 nobody had stated a number, and `null` says "unstated" where a 0 would say "allowed none".
select pg_temp.p77_assert(
  (select count(*) from private.plan_quota_decisions
   where entitlement_key = 'assistant_runs.monthly'
     and decision_ref = 'OPEN-DECISIONS #198'
     and previous_limit is null and previous_unlimited = false) = 4,
  'the #198 record lost what each assistant figure replaced');

-- `מותאם` is not a number. Business and the retired Legacy rung keep the unknown-that-refuses.
select pg_temp.p77_assert(
  (select count(*) from public.plan_entitlements
   where entitlement_key = 'assistant_runs.monthly'
     and plan_key in ('business', 'legacy')
     and not unlimited and numeric_limit is null) = 2,
  'a contract-priced or retired rung was handed an invented assistant number');

-- =====================================================================================
-- A1 -- inside the introduction: 50 runs, and a stamp nothing can move
-- =====================================================================================
select pg_temp.p77_assert(
  (select runs from private.assistant_intro_allowance where singleton) = 50
  and (select window_days from private.assistant_intro_allowance where singleton) = 30,
  'the introductory allowance is not the 50 runs over 30 days #198/#209 decided');

-- The stamp materializes from the verification instant auth already recorded -- not from now().
select pg_temp.p77_assert(
  private.assistant_intro_window_start('77000000-0000-4000-8000-000000000001')
    = (select email_confirmed_at from auth.users
       where id = '78000000-0000-4000-8000-000000000001'),
  'the introduction stamp is not the owner''s first email verification');
select pg_temp.p77_assert(
  (select source from private.assistant_intro_windows
   where org_id = '77000000-0000-4000-8000-000000000001') = 'owner_email_confirmed',
  'the introduction stamp did not record where it came from');

select pg_temp.p77_assert(
  (private.assistant_effective_quota('77000000-0000-4000-8000-000000000001') ->> 'source')
    = 'intro'
  and (private.assistant_effective_quota('77000000-0000-4000-8000-000000000001') ->> 'limit')::numeric
    = 50
  and (private.assistant_effective_quota('77000000-0000-4000-8000-000000000001') ->> 'used')::numeric
    = 0,
  'an organization five days into its introduction is not measured against the 50-run window');

-- 49 runs inside the window. Dated three days back so the hourly abuse valve (30/user/hour) is not
-- what refuses the 50th -- this arm is about the quota, and a test that could not tell the two
-- refusals apart would prove neither.
insert into public.assistant_runs (id, org_id, user_id, status, complete, created_at)
select gen_random_uuid(), '77000000-0000-4000-8000-000000000001',
       '78000000-0000-4000-8000-000000000001', 'succeeded', true,
       now() - interval '3 days'
from generate_series(1, 49);

select pg_temp.p77_assert(
  (private.assistant_effective_quota('77000000-0000-4000-8000-000000000001') ->> 'used')::numeric
    = 49,
  'the introductory window does not count the runs recorded inside it');

select pg_temp.p77_as('78000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.p77_assert(
  (public.assistant_assert_run_allowed() ->> 'allowed')::boolean
  and (public.assistant_assert_run_allowed() ->> 'source') = 'intro',
  'the 50th run of the introduction was refused while 49 were used');
reset role;

-- F1 -- the refusal fires on a real violation, at the real number.
insert into public.assistant_runs (id, org_id, user_id, status, complete, created_at)
values (gen_random_uuid(), '77000000-0000-4000-8000-000000000001',
        '78000000-0000-4000-8000-000000000001', 'succeeded', true, now() - interval '3 days');

select pg_temp.p77_as('78000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$
begin
  perform public.assistant_assert_run_allowed();
  raise exception 'expected the 51st run of a 50-run introduction to be refused';
exception when raise_exception then
  if sqlerrm <> 'assistant_limit_reached' then raise; end if;
end
$$;
reset role;

-- A privacy delete removes a conversation and keeps the run rows, so the window cannot be reset by
-- deleting a conversation. Counting from private.usage_counters would have made this reachable.
select pg_temp.p77_assert(
  (private.assistant_effective_quota('77000000-0000-4000-8000-000000000001') ->> 'used')::numeric
    = 50,
  'the introductory count is not taken from the run rows themselves');

-- The stamp is unwritable.
do $$
begin
  update private.assistant_intro_windows set started_at = now()
  where org_id = '77000000-0000-4000-8000-000000000001';
  raise exception 'expected the introduction stamp to refuse being moved';
exception when insufficient_privilege then
  if sqlerrm <> 'assistant_intro_window_immutable' then raise; end if;
end
$$;

-- F2 -- and it is a guard, not a blanket refusal: an update that leaves the stamp alone passes, so
-- the arm above proved the rule rather than proving the table is read-only.
update private.assistant_intro_windows set source = 'backfill'
where org_id = '77000000-0000-4000-8000-000000000001';
select pg_temp.p77_assert(
  (select source from private.assistant_intro_windows
   where org_id = '77000000-0000-4000-8000-000000000001') = 'backfill',
  'the immutability trigger refuses writes that do not touch the stamp');
update private.assistant_intro_windows set source = 'owner_email_confirmed'
where org_id = '77000000-0000-4000-8000-000000000001';

-- =====================================================================================
-- A2 -- one second past the window, the plan number decides
-- =====================================================================================
-- #209 measures thirty days from a verification instant, so "one second past the boundary" is an
-- organization whose owner verified 30 days and one second ago. The predicate is identical; only
-- now() is fixed, and a suite cannot move that.
select pg_temp.p77_assert(
  private.assistant_intro_window_start('77000000-0000-4000-8000-000000000002') is not null,
  'the expired organization has no stamp, so this arm would prove the wrong thing');
select pg_temp.p77_assert(
  (private.assistant_effective_quota('77000000-0000-4000-8000-000000000002') ->> 'source')
    = 'plan'
  and (private.assistant_effective_quota('77000000-0000-4000-8000-000000000002') ->> 'limit')::numeric
    = 20,
  'an organization past its introduction is still measured against the 50-run window');
-- Its stamp is still there, unchanged: the window expired, it was not erased.
select pg_temp.p77_assert(
  (select started_at from private.assistant_intro_windows
   where org_id = '77000000-0000-4000-8000-000000000002')
    = (select email_confirmed_at from auth.users
       where id = '78000000-0000-4000-8000-000000000002'),
  'an expired introduction lost the stamp that proves it happened');

-- =====================================================================================
-- A3 -- no verified owner email, no window, and nothing invented
-- =====================================================================================
select pg_temp.p77_assert(
  private.assistant_intro_window_start('77000000-0000-4000-8000-000000000003') is null
  and not exists (select 1 from private.assistant_intro_windows
                  where org_id = '77000000-0000-4000-8000-000000000003'),
  'an organization with no verified owner email was given an introduction window anyway');
select pg_temp.p77_assert(
  (private.assistant_effective_quota('77000000-0000-4000-8000-000000000003') ->> 'source')
    = 'plan'
  and (private.assistant_effective_quota('77000000-0000-4000-8000-000000000003') ->> 'limit')::numeric
    = 20,
  'an organization with no introduction is not measured against its plan');

-- =====================================================================================
-- A5 -- `business` is a contract, not a number
-- =====================================================================================
select pg_temp.p77_assert(
  not (private.assistant_effective_quota('77000000-0000-4000-8000-000000000004')
       ->> 'measured')::boolean,
  'the business rung claims to be measured without a contract override');

select pg_temp.p77_as('78000000-0000-4000-8000-000000000004');
set local role authenticated;
do $$
begin
  perform public.assistant_assert_run_allowed();
  raise exception 'expected a business organization with no override to refuse';
exception when raise_exception then
  if sqlerrm <> 'assistant_limit_unknown' then raise; end if;
end
$$;
reset role;
select pg_temp.p77_anonymous();

insert into public.organization_entitlement_overrides (
  org_id, entitlement_key, kind, unlimited, numeric_limit, reason, granted_by
) values (
  '77000000-0000-4000-8000-000000000004', 'assistant_runs.monthly', 'numeric', false, 500,
  'P77 business contract: 500 assistant runs per usage period',
  '78000000-0000-4000-8000-000000000007');

select pg_temp.p77_assert(
  (private.assistant_effective_quota('77000000-0000-4000-8000-000000000004') ->> 'source')
    = 'override'
  and (private.assistant_effective_quota('77000000-0000-4000-8000-000000000004') ->> 'limit')::numeric
    = 500,
  'the per-contract override did not become the business organization''s quota');

select pg_temp.p77_as('78000000-0000-4000-8000-000000000004');
set local role authenticated;
select pg_temp.p77_assert(
  (public.assistant_assert_run_allowed() ->> 'allowed')::boolean,
  'a business organization with a live override is still refused');
reset role;
select pg_temp.p77_anonymous();

-- #209 says EVERY new organization gets the 50 runs, and it says so without qualifying by plan.
-- A Business organization that has just verified its owner's email is therefore inside the window
-- like anybody else: `מותאם` decides what happens on day 31, not on day 3.
select pg_temp.p77_assert(
  (private.assistant_effective_quota('77000000-0000-4000-8000-000000000006') ->> 'source')
    = 'intro'
  and (private.assistant_effective_quota('77000000-0000-4000-8000-000000000006') ->> 'limit')::numeric
    = 50
  and (private.assistant_effective_quota('77000000-0000-4000-8000-000000000006')
       ->> 'measured')::boolean,
  'a newly verified business organization was refused inside its introduction for want of a contract');

-- =====================================================================================
-- A7 -- a tier change and the Legacy->Free move touch neither the stamp nor the counter
-- =====================================================================================
select private.record_usage_event(
  '77000000-0000-4000-8000-000000000001', 'assistant_runs.monthly', 1, 'p77-a7', 'p77');

create temporary table p77_before on commit drop as
select (select started_at from private.assistant_intro_windows
        where org_id = '77000000-0000-4000-8000-000000000001') as started_at,
       (select quantity from private.usage_counters
        where org_id = '77000000-0000-4000-8000-000000000001'
          and metric_key = 'assistant_runs.monthly') as quantity,
       (select period_start from private.usage_period(
          '77000000-0000-4000-8000-000000000001')) as period_start;

update public.organization_subscriptions set plan_key = 'pro'
where org_id = '77000000-0000-4000-8000-000000000001';
select pg_temp.p77_assert(
  private.assistant_intro_window_start('77000000-0000-4000-8000-000000000001')
    = (select started_at from p77_before)
  and (select quantity from private.usage_counters
       where org_id = '77000000-0000-4000-8000-000000000001'
         and metric_key = 'assistant_runs.monthly') = (select quantity from p77_before)
  and (select period_start from private.usage_period(
        '77000000-0000-4000-8000-000000000001')) = (select period_start from p77_before),
  'a tier change moved the introduction stamp, the counter or the usage period (#209/#242)');

-- #164's cutover: Legacy becomes Free. It is a subscription row change and nothing else -- no new
-- introduction, no reset, no fresh period.
update public.organization_subscriptions set plan_key = 'legacy'
where org_id = '77000000-0000-4000-8000-000000000001';
update public.organization_subscriptions set plan_key = 'free'
where org_id = '77000000-0000-4000-8000-000000000001';
select pg_temp.p77_assert(
  private.assistant_intro_window_start('77000000-0000-4000-8000-000000000001')
    = (select started_at from p77_before)
  and (select count(*) from private.assistant_intro_windows
       where org_id = '77000000-0000-4000-8000-000000000001') = 1
  and (select quantity from private.usage_counters
       where org_id = '77000000-0000-4000-8000-000000000001'
         and metric_key = 'assistant_runs.monthly') = (select quantity from p77_before)
  and (select period_start from private.usage_period(
        '77000000-0000-4000-8000-000000000001')) = (select period_start from p77_before),
  'the Legacy->Free move opened a second introduction or reset a counter (#164/#209/#242)');
select pg_temp.p77_assert(
  (private.assistant_effective_quota('77000000-0000-4000-8000-000000000001') ->> 'source')
    = 'intro',
  'a plan change ended an introduction window that had not expired');

-- =====================================================================================
-- B1 -- the monthly supplier price-rise read model (#189)
-- =====================================================================================
insert into public.suppliers (id, org_id, name, min_order_amount, preferred) values
  ('77000000-0000-4000-8000-0000000000a1',
   '77000000-0000-4000-8000-000000000005', 'P77 ספק א', 400, false),
  ('77000000-0000-4000-8000-0000000000a2',
   '77000000-0000-4000-8000-000000000005', 'P77 ספק ב', null, true);

insert into public.products (id, org_id, name, unit, barcode) values
  ('77000000-0000-4000-8000-0000000000b1',
   '77000000-0000-4000-8000-000000000005', 'P77 מוצר שעלה', 'unit', '729770000001'),
  ('77000000-0000-4000-8000-0000000000b2',
   '77000000-0000-4000-8000-000000000005', 'P77 מוצר שעלה וחזר', 'unit', '729770000002'),
  ('77000000-0000-4000-8000-0000000000b3',
   '77000000-0000-4000-8000-000000000005', 'P77 מוצר בלי בסיס', 'unit', '729770000003'),
  ('77000000-0000-4000-8000-0000000000b4',
   '77000000-0000-4000-8000-000000000005', 'P77 מוצר שירד', 'unit', '729770000004'),
  ('77000000-0000-4000-8000-0000000000b5',
   '77000000-0000-4000-8000-000000000005', 'P77 מוצר יציב', 'unit', '729770000005');

insert into public.supplier_products (
  id, org_id, supplier_id, product_id, current_price, price_effective_date, available, min_qty
) values
  -- Rose: baseline 10.00 in effect at the month start, 12.00 now.
  ('77000000-0000-4000-8000-0000000000c1', '77000000-0000-4000-8000-000000000005',
   '77000000-0000-4000-8000-0000000000a1', '77000000-0000-4000-8000-0000000000b1',
   12.00, current_date, true, null),
  -- Rose and came back to the baseline.
  ('77000000-0000-4000-8000-0000000000c2', '77000000-0000-4000-8000-000000000005',
   '77000000-0000-4000-8000-0000000000a1', '77000000-0000-4000-8000-0000000000b2',
   10.00, current_date, true, null),
  -- No authoritative baseline: the price first appeared inside the month.
  ('77000000-0000-4000-8000-0000000000c3', '77000000-0000-4000-8000-000000000005',
   '77000000-0000-4000-8000-0000000000a1', '77000000-0000-4000-8000-0000000000b3',
   9.00, current_date, true, null),
  -- Fell.
  ('77000000-0000-4000-8000-0000000000c4', '77000000-0000-4000-8000-000000000005',
   '77000000-0000-4000-8000-0000000000a2', '77000000-0000-4000-8000-0000000000b4',
   15.00, current_date, true, null),
  -- No history at all, but the current price took effect before the month opened: measurable,
  -- provably unchanged, and therefore silent rather than unmeasurable.
  ('77000000-0000-4000-8000-0000000000c5', '77000000-0000-4000-8000-000000000005',
   '77000000-0000-4000-8000-0000000000a2', '77000000-0000-4000-8000-0000000000b5',
   7.00, pg_temp.p77_month_start() - 5, true, null);

insert into public.price_history (org_id, supplier_product_id, price, effective_date) values
  ('77000000-0000-4000-8000-000000000005', '77000000-0000-4000-8000-0000000000c1',
   10.00, pg_temp.p77_month_start() - 10),
  ('77000000-0000-4000-8000-000000000005', '77000000-0000-4000-8000-0000000000c2',
   10.00, pg_temp.p77_month_start() - 10),
  -- The excursion inside the month. Dated past the boundary so it is never mistaken for the
  -- baseline even when this suite runs on the 1st.
  ('77000000-0000-4000-8000-000000000005', '77000000-0000-4000-8000-0000000000c2',
   14.00, pg_temp.p77_month_start() + 1),
  ('77000000-0000-4000-8000-000000000005', '77000000-0000-4000-8000-0000000000c2',
   10.00, pg_temp.p77_month_start() + 2),
  ('77000000-0000-4000-8000-000000000005', '77000000-0000-4000-8000-0000000000c3',
   9.00, pg_temp.p77_month_start() + 1),
  ('77000000-0000-4000-8000-000000000005', '77000000-0000-4000-8000-0000000000c4',
   20.00, pg_temp.p77_month_start() - 10);

select pg_temp.p77_as('78000000-0000-4000-8000-000000000005');
set local role authenticated;

-- The month boundary is the 1st at 00:00 in Asia/Jerusalem, and the read model says so itself.
select pg_temp.p77_assert(
  (select distinct month_start from public.supplier_monthly_price_rises())
    = (date_trunc('month', now() at time zone 'Asia/Jerusalem') at time zone 'Asia/Jerusalem')
  and (select distinct time_zone from public.supplier_monthly_price_rises()) = 'Asia/Jerusalem'
  and (select distinct month_end from public.supplier_monthly_price_rises())
    = ((date_trunc('month', now() at time zone 'Asia/Jerusalem') + interval '1 month')
       at time zone 'Asia/Jerusalem'),
  'the price-rise month is not the calendar month from the 1st at 00:00 Asia/Jerusalem');

select pg_temp.p77_assert(
  (select count(*) from public.supplier_monthly_price_rises()
   where product_id = '77000000-0000-4000-8000-0000000000b1'
     and measurable
     and baseline_price = 10.00
     and baseline_source = 'price_history'
     and baseline_as_of = pg_temp.p77_month_start() - 10
     and current_price = 12.00
     and delta_amount = 2.00
     and delta_percent = 20.0) = 1,
  'a supplier price rise is not reported with its delta, its baseline, its source and its as-of');

select pg_temp.p77_assert(
  not exists (select 1 from public.supplier_monthly_price_rises()
              where product_id = '77000000-0000-4000-8000-0000000000b2'),
  'a price that rose and came back to its baseline was reported as a rise');
select pg_temp.p77_assert(
  not exists (select 1 from public.supplier_monthly_price_rises()
              where product_id = '77000000-0000-4000-8000-0000000000b4'),
  'a price that fell was reported by a read model that reports rises');
select pg_temp.p77_assert(
  not exists (select 1 from public.supplier_monthly_price_rises()
              where product_id = '77000000-0000-4000-8000-0000000000b5'),
  'a price that provably did not move this month was reported');

-- Unmeasurable is reported AS unmeasurable, with no delta at all -- and it is counted nowhere.
select pg_temp.p77_assert(
  (select count(*) from public.supplier_monthly_price_rises()
   where product_id = '77000000-0000-4000-8000-0000000000b3'
     and not measurable
     and unmeasurable_reason = 'no_baseline_at_month_start'
     and baseline_price is null and baseline_source is null and baseline_as_of is null
     and delta_amount is null and delta_percent is null) = 1,
  'a row with no authoritative baseline is not reported as unmeasurable with null figures');
select pg_temp.p77_assert(
  (select distinct measured_rise_rows from public.supplier_monthly_price_rises()) = 1
  and (select distinct unmeasurable_rows from public.supplier_monthly_price_rises()) = 1
  and (select distinct supplier_rise_total from public.supplier_monthly_price_rises()
       where supplier_id = '77000000-0000-4000-8000-0000000000a1') = 2.00,
  'the unmeasurable row was counted as a zero rise, or the per-supplier totals do not add up');

-- B2 -- a role that may not read prices sees nothing, and is told nothing by the shape of the
-- refusal either: zero rows, no error, no existence oracle.
reset role;
select pg_temp.p77_as('78000000-0000-4000-8000-000000000006');
set local role authenticated;
select pg_temp.p77_assert(
  (select count(*) from public.supplier_monthly_price_rises()) = 0,
  'an accountant read the price-rise model that /prices grants to owner and office only');
reset role;

-- F5 -- the emptiness above is the ROLE, not an empty dataset: the same call as the owner returns
-- the same two rows it returned before.
select pg_temp.p77_as('78000000-0000-4000-8000-000000000005');
set local role authenticated;
select pg_temp.p77_assert(
  (select count(*) from public.supplier_monthly_price_rises()) = 2,
  'the price-rise model returned nothing for the owner either, so the accountant arm proved nothing');
reset role;

-- F3 -- the "came back" exclusion is about the VALUE, not about the row being invisible: raise the
-- same product above its baseline and it appears. The write is made with no end-user subject, the
-- way a seed writes: p1_financial_command_guard requires a named RPC for anybody else, and routing
-- this through set_supplier_product_price would write a price_history row of its own and move the
-- very baseline this arm is testing against.
select pg_temp.p77_anonymous();
update public.supplier_products set current_price = 13.00
where id = '77000000-0000-4000-8000-0000000000c2';
select pg_temp.p77_as('78000000-0000-4000-8000-000000000005');
set local role authenticated;
select pg_temp.p77_assert(
  (select count(*) from public.supplier_monthly_price_rises()
   where product_id = '77000000-0000-4000-8000-0000000000b2'
     and measurable and delta_amount = 3.00) = 1,
  'the excluded product stayed invisible even once it really did rise above its baseline');
reset role;
select pg_temp.p77_anonymous();
update public.supplier_products set current_price = 10.00
where id = '77000000-0000-4000-8000-0000000000c2';

-- F4 -- and "unmeasurable" is about the missing baseline, not about the product: give it an
-- authoritative baseline and it becomes a measured rise.
select pg_temp.p77_anonymous();
insert into public.price_history (org_id, supplier_product_id, price, effective_date) values
  ('77000000-0000-4000-8000-000000000005', '77000000-0000-4000-8000-0000000000c3',
   5.00, pg_temp.p77_month_start() - 2);
select pg_temp.p77_as('78000000-0000-4000-8000-000000000005');
set local role authenticated;
select pg_temp.p77_assert(
  (select count(*) from public.supplier_monthly_price_rises()
   where product_id = '77000000-0000-4000-8000-0000000000b3'
     and measurable and baseline_price = 5.00 and delta_amount = 4.00
     and delta_percent = 80.0) = 1,
  'a row reported unmeasurable stayed unmeasurable after an authoritative baseline arrived');
select pg_temp.p77_assert(
  (select distinct unmeasurable_rows from public.supplier_monthly_price_rises()) = 0,
  'the unmeasurable count did not fall once the baseline arrived');
reset role;
select pg_temp.p77_anonymous();
delete from public.price_history
where supplier_product_id = '77000000-0000-4000-8000-0000000000c3'
  and effective_date = pg_temp.p77_month_start() - 2;

-- =====================================================================================
-- B1b -- the purchase comparison read model (#190/#145/#155/#182)
-- =====================================================================================
-- A second offer for the risen product, so a line has an alternative; the stable product keeps
-- exactly one offer, which is what `—` rather than `0` is for.
select pg_temp.p77_anonymous();
insert into public.supplier_products (
  id, org_id, supplier_id, product_id, current_price, price_effective_date, available, min_qty
) values
  ('77000000-0000-4000-8000-0000000000c6', '77000000-0000-4000-8000-000000000005',
   '77000000-0000-4000-8000-0000000000a2', '77000000-0000-4000-8000-0000000000b1',
   14.00, current_date, true, null);

select pg_temp.p77_as('78000000-0000-4000-8000-000000000005');
set local role authenticated;

-- The cheaper supplier is chosen; the preferred flag on the dearer one does not win the line.
select pg_temp.p77_assert(
  (public.purchase_comparison(jsonb_build_array(jsonb_build_object(
     'product_id', '77000000-0000-4000-8000-0000000000b1', 'qty', 10)))
   -> 'lines' -> 0 ->> 'chosen_supplier_id') = '77000000-0000-4000-8000-0000000000a1'
  and (public.purchase_comparison(jsonb_build_array(jsonb_build_object(
     'product_id', '77000000-0000-4000-8000-0000000000b1', 'qty', 10)))
   -> 'lines' -> 0 ->> 'chosen_unit_price')::numeric = 12.00,
  'a preferred supplier won a line it was more expensive on -- #145 makes it a tie-break only');
select pg_temp.p77_assert(
  jsonb_array_length(public.purchase_comparison(jsonb_build_array(jsonb_build_object(
     'product_id', '77000000-0000-4000-8000-0000000000b1', 'qty', 10)))
   -> 'lines' -> 0 -> 'offers') = 2
  and jsonb_array_length(public.purchase_comparison(jsonb_build_array(jsonb_build_object(
     'product_id', '77000000-0000-4000-8000-0000000000b5', 'qty', 1)))
   -> 'lines' -> 0 -> 'offers') = 1,
  'the comparison did not return every offer the line actually has');

-- F6 -- a supplier minimum is a BREACH with a shortfall, and the read model never raises the
-- quantity to clear it. 10 x 12.00 = 120 against a 400 minimum.
select pg_temp.p77_assert(
  (public.purchase_comparison(jsonb_build_array(jsonb_build_object(
     'product_id', '77000000-0000-4000-8000-0000000000b1', 'qty', 10)))
   -> 'suppliers' -> 0 ->> 'below_minimum')::boolean
  and (public.purchase_comparison(jsonb_build_array(jsonb_build_object(
     'product_id', '77000000-0000-4000-8000-0000000000b1', 'qty', 10)))
   -> 'suppliers' -> 0 ->> 'shortfall')::numeric = 280.00
  and (public.purchase_comparison(jsonb_build_array(jsonb_build_object(
     'product_id', '77000000-0000-4000-8000-0000000000b1', 'qty', 10)))
   -> 'lines' -> 0 ->> 'qty')::numeric = 10,
  'the supplier minimum was not returned as a breach with its shortfall, or the quantity was moved');
-- ...and the breach flag fires on the real condition rather than always: clear the minimum and it
-- goes quiet. 40 x 12.00 = 480.
select pg_temp.p77_assert(
  not (public.purchase_comparison(jsonb_build_array(jsonb_build_object(
     'product_id', '77000000-0000-4000-8000-0000000000b1', 'qty', 40)))
   -> 'suppliers' -> 0 ->> 'below_minimum')::boolean
  and (public.purchase_comparison(jsonb_build_array(jsonb_build_object(
     'product_id', '77000000-0000-4000-8000-0000000000b1', 'qty', 40)))
   ->> 'minimum_breaches')::integer = 0,
  'the minimum-order breach flag is on regardless of the basket, so it proves nothing');

-- An unknown product is dropped rather than defaulted, and `complete` says so.
select pg_temp.p77_assert(
  not (public.purchase_comparison(jsonb_build_array(
     jsonb_build_object('product_id', '77000000-0000-4000-8000-0000000000b1', 'qty', 10),
     jsonb_build_object('product_id', null, 'qty', 3))) ->> 'complete')::boolean,
  'a line the read model could not use was silently absorbed into a complete answer');

-- Ambiguous input refuses by name instead of quietly preferring one of two baskets.
do $$
begin
  perform public.purchase_comparison(
    jsonb_build_array(jsonb_build_object(
      'product_id', '77000000-0000-4000-8000-0000000000b1', 'qty', 1)),
    '77000000-0000-4000-8000-00000000d001');
  raise exception 'expected quantities and a draft id together to refuse';
exception when invalid_parameter_value then
  if sqlerrm <> 'purchase_comparison_input_ambiguous' then raise; end if;
end
$$;
reset role;

-- The draft path reads the draft's own quantities, under the draft's own RLS.
select pg_temp.p77_anonymous();
insert into public.purchase_requests (id, org_id, status, created_by, editor_step) values
  ('77000000-0000-4000-8000-00000000d001', '77000000-0000-4000-8000-000000000005',
   'draft', '78000000-0000-4000-8000-000000000005', 2);
insert into public.purchase_request_items (org_id, request_id, product_id, qty) values
  ('77000000-0000-4000-8000-000000000005', '77000000-0000-4000-8000-00000000d001',
   '77000000-0000-4000-8000-0000000000b1', 40);

select pg_temp.p77_as('78000000-0000-4000-8000-000000000005');
set local role authenticated;
select pg_temp.p77_assert(
  (public.purchase_comparison(null, '77000000-0000-4000-8000-00000000d001') ->> 'source') = 'draft'
  and (public.purchase_comparison(null, '77000000-0000-4000-8000-00000000d001')
       -> 'lines' -> 0 ->> 'qty')::numeric = 40,
  'the draft path did not read the draft''s own quantities');
reset role;
select pg_temp.p77_anonymous();

-- #182 by structure, not by intention: neither read model can reach an order, and the comparison
-- wrote nothing at all.
select pg_temp.p77_assert(
  not exists (
    select 1 from pg_catalog.pg_proc
    where oid in (
        pg_catalog.to_regprocedure('public.purchase_comparison(jsonb,uuid)'),
        pg_catalog.to_regprocedure('public.supplier_monthly_price_rises(integer)'))
      and (prosecdef or provolatile = 'v'
        or prosrc ~ '\mpurchase_orders\M' or prosrc ~ '\mpurchase_order_items\M')),
  'a read model became a definer, became volatile, or reached a purchase order (#182)');
select pg_temp.p77_assert(
  (select count(*) from public.purchase_orders
   where org_id = '77000000-0000-4000-8000-000000000005') = 0
  and (select count(*) from public.purchase_requests
       where org_id = '77000000-0000-4000-8000-000000000005') = 1,
  'the comparison read model created an order or a second draft');

rollback;

-- =====================================================================================
-- A6 -- concurrency, on committed rows (the p18/p20 dblink idiom)
-- =====================================================================================
-- Two sessions arrive at the same organization one run below its introductory allowance. They must
-- serialize on the counter row assistant_record_run locks, and exactly one of them must be
-- recorded -- otherwise a 50-run window admits 51 runs whenever two people press send together.
-- The fixture is committed because a second session cannot see an uncommitted one, and it is
-- purged again at the bottom through the product's own staged tenant delete.
create extension if not exists dblink;
drop schema if exists p77_concurrency cascade;
create schema p77_concurrency;

-- The disposable tenant has to be able to leave. Two of the ledgers it touches refuse deletion by
-- design -- private.organization_external_egress_evidence is immutable outright (0165), and
-- public.audit_logs yields only to a DELETE that declared an authorized purge (0175/0200) -- so the
-- teardown declares the purge, presents the service-role claim 0103's write guard requires of a
-- write to a departing organization, and suspends the evidence table's own trigger for the length
-- of the statement that removes ITS OWN rows. Everything else goes through the product's staged
-- tenant delete, whose order is derived from the live foreign-key graph and which refuses to return
-- while any tenant row survives -- which is also what proves 0202's new table is staged rather than
-- pinning a tenant forever.
create function p77_concurrency.teardown() returns void language plpgsql as $teardown$
begin
  perform set_config('app.audit_purge', 'organization_teardown', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  if exists (
    select 1 from private.organization_external_egress_evidence
    where org_id = '77000000-0000-4000-8000-00000000e001'
  ) then
    alter table private.organization_external_egress_evidence disable trigger user;
    delete from private.organization_external_egress_evidence
    where org_id = '77000000-0000-4000-8000-00000000e001';
    alter table private.organization_external_egress_evidence enable trigger user;
  end if;
  delete from private.organization_external_egress_leases
  where org_id = '77000000-0000-4000-8000-00000000e001';
  if exists (
    select 1 from public.organizations where id = '77000000-0000-4000-8000-00000000e001'
  ) then
    perform private.delete_tenant_rows('77000000-0000-4000-8000-00000000e001');
    perform private.delete_tenant_organization_row('77000000-0000-4000-8000-00000000e001');
  end if;
  delete from auth.users
  where id in ('78000000-0000-4000-8000-00000000e001', '78000000-0000-4000-8000-00000000e002');
  perform set_config('request.jwt.claim.role', '', true);
end
$teardown$;

-- A previous run that died between the commit and the teardown would otherwise poison every run
-- after it with a primary-key collision that says nothing about the product.
select p77_concurrency.teardown();

create function p77_concurrency.assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P77 concurrency assertion failed: %', p_message;
  end if;
end
$$;

create table p77_concurrency.results (runner text primary key, result jsonb not null);

insert into public.organizations (id, name, status) values
  ('77000000-0000-4000-8000-00000000e001', 'P77 concurrency tenant', 'active');
insert into auth.users (id, email, email_confirmed_at) values
  ('78000000-0000-4000-8000-00000000e001', 'owner-conc-p77@example.test',
   now() - interval '4 days'),
  ('78000000-0000-4000-8000-00000000e002', 'office-conc-p77@example.test', null);
insert into public.profiles (id, org_id, full_name, role) values
  ('78000000-0000-4000-8000-00000000e001',
   '77000000-0000-4000-8000-00000000e001', 'P77 concurrency owner', 'owner'),
  ('78000000-0000-4000-8000-00000000e002',
   '77000000-0000-4000-8000-00000000e001', 'P77 concurrency office', 'office');

-- One below the allowance, dated outside the hourly abuse window so this arm is about the quota.
insert into public.assistant_runs (id, org_id, user_id, status, complete, created_at)
select gen_random_uuid(), '77000000-0000-4000-8000-00000000e001',
       '78000000-0000-4000-8000-00000000e001', 'succeeded', true, now() - interval '2 days'
from generate_series(1, 49);

-- The Edge boundary's proof-of-egress, one settled lease per run id.
insert into private.organization_external_egress_leases (
  lease_id, org_id, kind, correlation_id, status, outcome, evidence_code,
  reserved_at, expires_at, settled_at
) values
  ('77000000-0000-4000-8000-00000000f001', '77000000-0000-4000-8000-00000000e001',
   'assistant', '77000000-0000-4000-8000-00000000a001', 'settled', 'delivered',
   'p77_assistant_run', statement_timestamp(),
   statement_timestamp() + interval '110 seconds', statement_timestamp()),
  ('77000000-0000-4000-8000-00000000f002', '77000000-0000-4000-8000-00000000e001',
   'assistant', '77000000-0000-4000-8000-00000000a002', 'settled', 'delivered',
   'p77_assistant_run', statement_timestamp(),
   statement_timestamp() + interval '110 seconds', statement_timestamp());
insert into private.organization_external_egress_evidence (
  lease_id, org_id, kind, correlation_id, outcome, evidence_code, evidence, evidence_sha256
) values
  ('77000000-0000-4000-8000-00000000f001', '77000000-0000-4000-8000-00000000e001',
   'assistant', '77000000-0000-4000-8000-00000000a001', 'delivered', 'p77_assistant_run',
   '{}'::jsonb, repeat('a', 64)),
  ('77000000-0000-4000-8000-00000000f002', '77000000-0000-4000-8000-00000000e001',
   'assistant', '77000000-0000-4000-8000-00000000a002', 'delivered', 'p77_assistant_run',
   '{}'::jsonb, repeat('b', 64));

create function p77_concurrency.run(
  p_user uuid, p_run uuid, p_lease uuid, p_hold double precision
) returns jsonb language plpgsql security invoker as $$
declare
  v_token uuid;
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_user, 'amr', '[]'::jsonb)::text, true);
  select lease_token into v_token
  from private.organization_external_egress_leases where lease_id = p_lease;
  declare
    v_result jsonb;
  begin
    v_result := public.assistant_record_run(
      p_run, null, false, 'P77 concurrent question', null, 'succeeded', null,
      'p77-model', 'v1', 10, 10, 1, 10, true,
      '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null, p_lease, v_token,
      jsonb_build_object('ui', true, 'history', false,
                         'drafts', false, 'confirmedActions', false));
    -- Hold the counter lock long enough for the second session to reach it. Without this the two
    -- sessions may never overlap and the arm would pass without testing anything.
    perform pg_sleep(p_hold);
    return v_result;
  end;
exception when others then
  return jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate);
end
$$;

select dblink_connect_u('p77_a', format('dbname=%L user=%L', current_database(), 'postgres'));
select dblink_connect_u('p77_b', format('dbname=%L user=%L', current_database(), 'postgres'));
select dblink_send_query('p77_a', $sql$
  select p77_concurrency.run(
    '78000000-0000-4000-8000-00000000e001'::uuid,
    '77000000-0000-4000-8000-00000000a001'::uuid,
    '77000000-0000-4000-8000-00000000f001'::uuid, 1.5)
$sql$);
select pg_sleep(0.2);
select dblink_send_query('p77_b', $sql$
  select p77_concurrency.run(
    '78000000-0000-4000-8000-00000000e002'::uuid,
    '77000000-0000-4000-8000-00000000a002'::uuid,
    '77000000-0000-4000-8000-00000000f002'::uuid, 0)
$sql$);
insert into p77_concurrency.results
select 'a', result from dblink_get_result('p77_a') as response(result jsonb);
insert into p77_concurrency.results
select 'b', result from dblink_get_result('p77_b') as response(result jsonb);
select count(*) from dblink_get_result('p77_a') as response(result jsonb);
select count(*) from dblink_get_result('p77_b') as response(result jsonb);
select dblink_disconnect('p77_a');
select dblink_disconnect('p77_b');

-- Printed, not just asserted: the two outcomes are the whole point of this section, and a human
-- watching the gate should be able to see which session crossed and how the other was refused.
select runner, coalesce(result ->> 'run_id', result ->> 'error') as outcome
from p77_concurrency.results order by runner;

select p77_concurrency.assert(
  (select count(*) filter (where result ? 'run_id') = 1
          and count(*) filter (where result ->> 'error' = 'assistant_limit_reached') = 1
   from p77_concurrency.results),
  'two sessions at limit-minus-one did not yield exactly one recorded run and one named refusal');
select p77_concurrency.assert(
  (select count(*) from public.assistant_runs
   where org_id = '77000000-0000-4000-8000-00000000e001') = 50,
  'the introductory allowance admitted more runs than it allows');
select p77_concurrency.assert(
  (select quantity from private.usage_counters
   where org_id = '77000000-0000-4000-8000-00000000e001'
     and metric_key = 'assistant_runs.monthly') = 1,
  'metering stopped being true inside the introduction window -- the counter must still move');

-- Cleanup through the product's own staged tenant delete. It derives its order from the LIVE
-- foreign-key graph and refuses to return while any tenant row survives, so this doubles as proof
-- that 0202's new table is staged with everything else rather than pinning a tenant forever.
select p77_concurrency.teardown();

select p77_concurrency.assert(
  not exists (select 1 from public.organizations
              where id = '77000000-0000-4000-8000-00000000e001')
  and not exists (select 1 from private.assistant_intro_windows
                  where org_id = '77000000-0000-4000-8000-00000000e001')
  and not exists (select 1 from public.assistant_runs
                  where org_id = '77000000-0000-4000-8000-00000000e001'),
  'the concurrency fixture outlived its own cleanup');

drop schema p77_concurrency cascade;

\echo 'p77_assistant_quota_and_read_models_passed'
