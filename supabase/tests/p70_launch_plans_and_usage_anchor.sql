-- P70 -- The launch ladder is priced, versioned and ordered; Legacy is retired by an idempotent,
-- audited command that leaves the usage period alone; and the usage period is anchored to the
-- organization's signup instant for its whole life, so that no payment, renewal, tier change,
-- cancellation, delinquency, late payment or refund can hand a customer a fresh quota
-- (0184, 0185 -- OPEN-DECISIONS #164, #194-#197, #201, #208, #215-#225, #242).
\set ON_ERROR_STOP on

begin;

create function pg_temp.p70_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P70 launch plan assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p70_as(p_user uuid, p_fresh_password boolean default false)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    case when p_user is null then '{}'::jsonb else jsonb_build_object(
      'sub', p_user,
      'amr', case when p_fresh_password then jsonb_build_array(jsonb_build_object(
        'method', 'password', 'timestamp', extract(epoch from clock_timestamp())
      )) else '[]'::jsonb end
    ) end::text,
    true
  );
end
$$;

-- ===== 1. The ladder (#194) =====
select pg_temp.p70_assert(
  (select string_agg(plan_key, '<' order by tier_order) from subscription_plans where active)
    = 'free<basic<pro<premium<business',
  'the active ladder is not free<basic<pro<premium<business');
select pg_temp.p70_assert(
  (select count(*) from subscription_plans where plan_key in ('basic', 'premium') and active) = 2,
  'basic and premium are not both active plans');
select pg_temp.p70_assert(
  not (select active from subscription_plans where plan_key = 'legacy'),
  'legacy became selectable again -- #164 retires it, it does not revive it');
-- The labels are the owner's words, not a translation somebody improvised in a component.
select pg_temp.p70_assert(
  (select count(*) from (values
     ('free', 'חינם'), ('basic', 'בסיס'), ('pro', 'פרו'),
     ('premium', 'פרימיום'), ('business', 'ביזנס')) as decided(plan_key, label)
   join subscription_plans plan
     on plan.plan_key = decided.plan_key and plan.label = decided.label) = 5,
  'a plan label drifted from the ladder #194 names');

-- `/pricing` is anonymous. The new rungs must be visible there and the retired one must not.
select set_config('request.jwt.claim.role', 'anon', true);
set local role anon;
select pg_temp.p70_assert(
  (select count(*) from subscription_plans where plan_key in ('basic', 'premium')) = 2,
  'the anonymous catalogue does not expose the two new rungs');
select pg_temp.p70_assert(
  (select count(*) from subscription_plans where not active) = 0,
  'the anonymous catalogue exposed a retired plan');
reset role;

-- ===== 2. Volumes (#197), applied in full at cutover =====
select pg_temp.p70_assert(
  (select count(*) from (values
     -- #197's eight figures, as #266 revised them on 24.08.2026. Documents came down at every
     -- tier and pages remain exactly ten times documents -- the derived ceiling, not a dial.
     ('free',    'documents.monthly',   20),
     ('free',    'ocr_pages.monthly',  200),
     ('basic',   'documents.monthly',   40),
     ('basic',   'ocr_pages.monthly',  400),
     ('pro',     'documents.monthly',  150),
     ('pro',     'ocr_pages.monthly', 1500),
     ('premium', 'documents.monthly',  375),
     ('premium', 'ocr_pages.monthly', 3750)) as expected(plan_key, entitlement_key, quota)
   join plan_entitlements entitlement
     on entitlement.plan_key = expected.plan_key
    and entitlement.entitlement_key = expected.entitlement_key
    and not entitlement.unlimited
    and entitlement.numeric_limit = expected.quota) = 8,
  'the metered quotas are not the eight figures #197/#266 decided');
-- The ratio is ten, superseding 0163's twenty as the COMMERCIAL multiple. The per-document
-- 20-AI-page file cap is a different limit, lives in the worker, and is untouched.
select pg_temp.p70_assert(
  not exists (
    select 1 from plan_entitlements docs
    join plan_entitlements pages
      on pages.plan_key = docs.plan_key and pages.entitlement_key = 'ocr_pages.monthly'
    where docs.entitlement_key = 'documents.monthly'
      and (case when docs.unlimited then not pages.unlimited
                else pages.unlimited
                     or pages.numeric_limit is distinct from docs.numeric_limit * 10
           end)),
  'a plan page quota is not its document quota times ten');
-- Scoped by decision_ref: 0202 recorded #198's four assistant figures in the same ledger, and a
-- bare count would both fail on a second owner decision and hide one of the eight behind it.
--
-- The eight metered figures belong to #266 since 24.08.2026: 0208 restated every one of them and
-- the ledger holds the CURRENT decision per quota, not a log. All eight came down this time --
-- #197's three reductions became eight -- which is the difference the assertion should notice.
select pg_temp.p70_assert(
  (select count(*) from private.plan_quota_decisions
   where decision_ref = 'OPEN-DECISIONS #266') = 8
  and (select count(*) from private.plan_quota_decisions
       where decision_ref = 'OPEN-DECISIONS #266'
         and previous_limit is not null and previous_limit > decided_limit) = 8,
  'the #266 record does not hold eight figures, every one of them a reduction');
-- Every decided figure actually reached the catalogue: a record without the application is a
-- number nobody is held to.
select pg_temp.p70_assert(
  not exists (
    select 1 from private.plan_quota_decisions decision
    join plan_entitlements entitlement
      on entitlement.plan_key = decision.plan_key
     and entitlement.entitlement_key = decision.entitlement_key
    where entitlement.unlimited
       or entitlement.numeric_limit is distinct from decision.decided_limit),
  'a decided quota did not reach the catalogue');

-- #196 said tiers differ by volume only, and this asserted it literally: no boolean anywhere may
-- be anything but true. **#274 cancelled #196 on 25.08.2026** and put two conditions in its place,
-- so enforcing the withdrawn rule would have blocked the first capability the owner then chose to
-- lock (`exports.unbranded_pdf`, #297). What replaces it is #274 itself, and it is deliberately
-- the SAME function p51 calls: one definition, so the two suites cannot come to disagree about
-- what the ladder is allowed to do.
select pg_temp.p70_assert(
  not exists (select 1 from private.plan_capability_violations()),
  'a capability is closed without a recorded decision, or an upgrade would remove one -- #274');
-- Every rung answers for every entitlement, or effective_entitlement() says `unavailable` and 0155
-- reads that as a refusal on the customer's first document.
select pg_temp.p70_assert(
  not exists (
    select 1 from subscription_plans plan
    cross join private.entitlement_definitions definition
    where not exists (
      select 1 from plan_entitlements entitlement
      where entitlement.plan_key = plan.plan_key
        and entitlement.entitlement_key = definition.entitlement_key)),
  'a plan/entitlement pair is unseeded, so a new rung would resolve to `unavailable`');
-- The assistant quota was the ONE metric allowed to sit in the unknown-that-refuses state while
-- #209's differently-anchored window was undecided. 0202 closed that gap, so the rule is now
-- narrower rather than gone: the four self-service rungs hold #198's figures, and the unknown state
-- survives only where a number would be an invention -- `business`, whose answer is `מותאם` and
-- therefore a per-contract override, and the retired `legacy` rung, which gets no new allowance.
select pg_temp.p70_assert(
  not exists (
    select 1 from plan_entitlements
    where kind = 'numeric' and not unlimited and numeric_limit is null
      and not (entitlement_key = 'assistant_runs.monthly'
               and plan_key in ('business', 'legacy'))),
  'a metric beyond the contract-priced assistant quota entered the unknown-that-refuses state');
select pg_temp.p70_assert(
  (select count(*) from (values
     ('free', 20), ('basic', 40), ('pro', 100), ('premium', 250)) as decided(plan_key, quota)
   join plan_entitlements entitlement
     on entitlement.plan_key = decided.plan_key
    and entitlement.entitlement_key = 'assistant_runs.monthly'
    and not entitlement.unlimited
    and entitlement.numeric_limit = decided.quota) = 4,
  'the assistant quota is not the four figures #198 decided for the self-service rungs');
select pg_temp.p70_assert(
  (select count(*) from plan_entitlements
   where entitlement_key = 'assistant_runs.monthly' and not unlimited and numeric_limit is null)
   = 2,
  'the assistant quota stopped refusing on the contract-priced or the retired rung');

-- ===== 3. Price (#195, #201, #208) =====
select pg_temp.p70_assert(
  (select count(*) from plan_price_catalogues where active) = 2
  and (select count(*) from plan_price_catalogues where billing_country_scope = 'IL' and currency = 'ILS') = 1
  and (select count(*) from plan_price_catalogues where billing_country_scope = 'ROW' and currency = 'USD') = 1,
  'the two decided catalogues (Israel in ILS, everywhere else in USD) are not both present');
-- #195 verbatim, both currencies, both intervals.
select pg_temp.p70_assert(
  (select count(*) from (values
     ('ROW', 'basic',   'monthly',    20), ('ROW', 'pro', 'monthly',   79),
     ('ROW', 'premium', 'monthly',   149), ('ROW', 'free', 'monthly',    0),
     ('ROW', 'basic',   'yearly',    200), ('ROW', 'pro', 'yearly',    790),
     ('ROW', 'premium', 'yearly',   1490), ('ROW', 'free', 'yearly',     0),
     ('IL',  'basic',   'monthly',    69), ('IL',  'pro', 'monthly',  249),
     ('IL',  'premium', 'monthly',   449), ('IL',  'free', 'monthly',   0),
     ('IL',  'basic',   'yearly',    690), ('IL',  'pro', 'yearly',   2490),
     ('IL',  'premium', 'yearly',   4490), ('IL',  'free', 'yearly',    0))
     as decided(scope, plan_key, billing_interval, amount)
   join plan_price_catalogues catalogue on catalogue.billing_country_scope = decided.scope
   join plan_prices price
     on price.catalogue_version = catalogue.catalogue_version
    and price.plan_key = decided.plan_key
    and price.billing_interval = decided.billing_interval
    and price.amount = decided.amount) = 16,
  'the decided launch prices are not what the catalogue holds');
-- The derivation, not the transcription: a year costs ten months.
select pg_temp.p70_assert(
  not exists (
    select 1 from plan_prices monthly
    join plan_prices yearly
      on yearly.catalogue_version = monthly.catalogue_version
     and yearly.plan_key = monthly.plan_key and yearly.billing_interval = 'yearly'
    where monthly.billing_interval = 'monthly' and yearly.amount <> monthly.amount * 10),
  'an annual price is not ten months of its monthly price');
-- #201: Business is a conversation. Its internal minimum must not exist in a readable table.
select pg_temp.p70_assert(
  not exists (select 1 from plan_prices where plan_key in ('business', 'legacy')),
  'a plan whose answer is `דברו איתנו` acquired a published price');
-- #208: the catalogue is chosen from a verified billing country, never inferred.
select pg_temp.p70_assert(
  public.billing_catalogue_scope('IL') = 'IL'
  and public.billing_catalogue_scope('il') = 'IL'
  and public.billing_catalogue_scope('US') = 'ROW'
  and public.billing_catalogue_scope(null) = 'ROW',
  'the billing-country scope mapping is not Israel-or-everywhere-else');

select set_config('request.jwt.claim.role', 'anon', true);
set local role anon;
-- The anonymous surface is the read model, never the base tables: those carry #215 price-change
-- notice metadata, and a prospect who can read when a change was announced is reading our calendar.
do $$
begin
  perform (select count(*) from public.plan_prices);
  raise exception 'expected an anonymous read of the price base table to be refused';
exception when insufficient_privilege then null;
end
$$;
do $$
begin
  update public.plan_prices set amount = 1;
  raise exception 'expected an anonymous rewrite of the price catalogue to be refused';
exception when insufficient_privilege then null;
end
$$;
reset role;

-- The published price surface has no provider identifier anywhere in it, by construction.
select pg_temp.p70_assert(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name in ('plan_price_catalogues', 'plan_prices')
      and column_name ~* 'provider|customer|subscription_id|secret|token'),
  'the public price catalogue grew a provider-shaped column');

-- ===== 4. Fixture =====
-- Signup instants are chosen, not defaulted: the 31st is the month-end case the anchor arithmetic
-- exists for, and the 09:17 is what proves a period is not a calendar month wearing a new name.
insert into public.organizations (id, name, status, created_at) values
  ('70000000-0000-4000-8000-000000000001', 'P70 anchored tenant', 'active',
   date_trunc('minute', now()) - interval '45 days'),
  ('70000000-0000-4000-8000-000000000002', 'P70 legacy tenant', 'active',
   date_trunc('minute', now()) - interval '400 days'),
  ('70000000-0000-4000-8000-000000000003', 'P70 month-end tenant', 'active',
   (date_trunc('month', now() at time zone 'Asia/Jerusalem') - interval '5 months'
    + interval '1 month - 1 day' + interval '9 hours 17 minutes') at time zone 'Asia/Jerusalem'),
  ('70000000-0000-4000-8000-000000000004', 'P70 over-quota legacy tenant', 'active',
   date_trunc('minute', now()) - interval '200 days');

insert into auth.users (id, email) values
  ('71000000-0000-4000-8000-000000000001', 'owner-a-p70@example.test'),
  ('71000000-0000-4000-8000-000000000002', 'billing-p70@example.test'),
  ('71000000-0000-4000-8000-000000000003', 'support-p70@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('71000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001', 'P70 owner', 'owner');

insert into public.platform_admins (user_id, note) values
  ('71000000-0000-4000-8000-000000000002', 'P70 billing operator'),
  ('71000000-0000-4000-8000-000000000003', 'P70 support operator');
insert into public.platform_admin_roles (user_id, role_key) values
  ('71000000-0000-4000-8000-000000000002', 'billing'),
  ('71000000-0000-4000-8000-000000000003', 'support');

update organization_subscriptions set plan_key = 'legacy'
where org_id in ('70000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000004');

-- ===== 5. The usage anchor (#242) =====
select pg_temp.p70_assert(
  (select count(*) from organizations org
   where not exists (select 1 from private.organization_usage_anchors anchor
                     where anchor.org_id = org.id)) = 0,
  'an organization exists with no usage anchor and would fall back to the calendar month');
select pg_temp.p70_assert(
  (select anchor_at from private.organization_usage_anchors
   where org_id = '70000000-0000-4000-8000-000000000001')
    = (select created_at from organizations where id = '70000000-0000-4000-8000-000000000001'),
  'the usage anchor of a newly created organization is not its signup instant');

-- Immutable means immutable: #242 lists six events that must not move it, and the table refuses
-- all of them at once rather than trusting six call sites.
do $$
begin
  update private.organization_usage_anchors set anchor_at = now()
  where org_id = '70000000-0000-4000-8000-000000000001';
  raise exception 'expected the usage anchor to be immutable';
exception when insufficient_privilege then null;
end
$$;

select pg_temp.p70_assert(
  (select period_source from private.usage_period('70000000-0000-4000-8000-000000000001'))
    = 'signup_anchor',
  'the usage period does not name the signup anchor as its source');
select pg_temp.p70_assert(
  (select now() >= period_start and now() < period_end
   from private.usage_period('70000000-0000-4000-8000-000000000001')),
  'the current usage period does not contain the present moment');
select pg_temp.p70_assert(
  (select (period_start at time zone 'Asia/Jerusalem')::time
   from private.usage_period('70000000-0000-4000-8000-000000000001'))
  = (select (created_at at time zone 'Asia/Jerusalem')::time
     from organizations where id = '70000000-0000-4000-8000-000000000001'),
  'the usage period lost the signup time of day -- it is a calendar month wearing a new name');

-- Month ends. The tenant signed up on the last day of a month at 09:17; every later period must
-- start on that day-of-month, or on the last day of a month too short to have it.
select pg_temp.p70_assert(
  (select extract(day from (period_start at time zone 'Asia/Jerusalem'))
   from private.usage_period('70000000-0000-4000-8000-000000000003'))
  = (select least(
       extract(day from (anchor.anchor_at at time zone 'Asia/Jerusalem')),
       extract(day from (
         date_trunc('month', period.period_start at time zone 'Asia/Jerusalem')
         + interval '1 month - 1 day')))
     from private.organization_usage_anchors anchor
     cross join lateral private.usage_period(anchor.org_id) period
     where anchor.org_id = '70000000-0000-4000-8000-000000000003'),
  'a month-end anchor did not clamp to the last day of a shorter month');
select pg_temp.p70_assert(
  (select extract(epoch from (period_end - period_start)) / 86400
   from private.usage_period('70000000-0000-4000-8000-000000000003')) between 27.9 and 31.1,
  'a usage period is not one calendar month long');

-- The arithmetic itself, proved without depending on today's date: twelve consecutive periods from
-- a 31st anchor must be strictly increasing and must RETURN to the 31st rather than drifting off
-- it, which is what iterating "previous boundary + one month" would do.
select pg_temp.p70_assert(
  (select count(*) from generate_series(0, 11) as n
   where (timestamp '2026-01-31 09:17' + make_interval(months => n))
       < (timestamp '2026-01-31 09:17' + make_interval(months => n + 1))) = 12
  and (timestamp '2026-01-31 09:17' + make_interval(months => 1))::date = date '2026-02-28'
  and (timestamp '2026-01-31 09:17' + make_interval(months => 2))::date = date '2026-03-31'
  and (timestamp '2026-01-31 09:17' + make_interval(months => 3))::date = date '2026-04-30',
  'month-end period arithmetic drifts instead of clamping and returning');

-- ===== 6. No transition may move the period or reset a counter (#216-#225, #242) =====
select private.record_usage_event(
  '70000000-0000-4000-8000-000000000001', 'documents.monthly', 1, 'p70-doc-1', 'p70');
select private.record_usage_event(
  '70000000-0000-4000-8000-000000000001', 'documents.monthly', 1, 'p70-doc-2', 'p70');
select private.record_usage_event(
  '70000000-0000-4000-8000-000000000001', 'documents.monthly', 1, 'p70-doc-3', 'p70');

select set_config('p70.period_start',
  (select period_start::text from private.usage_period('70000000-0000-4000-8000-000000000001')), true);

create function pg_temp.p70_unchanged(p_after text) returns void language plpgsql as $$
declare
  v_now record;
  v_used numeric;
begin
  select * into v_now from private.usage_period('70000000-0000-4000-8000-000000000001');
  if v_now.period_start::text <> current_setting('p70.period_start') then
    raise exception 'P70: % moved the usage period from % to %',
      p_after, current_setting('p70.period_start'), v_now.period_start;
  end if;
  if v_now.period_source <> 'signup_anchor' then
    raise exception 'P70: % made the usage period follow "%" instead of the signup anchor',
      p_after, v_now.period_source;
  end if;
  select quantity into v_used from private.usage_counters
  where org_id = '70000000-0000-4000-8000-000000000001'
    and metric_key = 'documents.monthly' and period_start = v_now.period_start;
  if coalesce(v_used, -1) <> 3 then
    raise exception 'P70: % changed the counter from 3 to %', p_after, coalesce(v_used, -1);
  end if;
  if (select count(*) from private.usage_counters
      where org_id = '70000000-0000-4000-8000-000000000001'
        and metric_key = 'documents.monthly'
        and period_start <= now() and period_end > now()) <> 1 then
    raise exception 'P70: % left more than one open counter row', p_after;
  end if;
end
$$;

select pg_temp.p70_as('71000000-0000-4000-8000-000000000002', true);
set local role authenticated;

-- #217 Free -> paid: immediate on a signed server payment event, and the billing period starts at
-- that timestamp. The usage period does not restart and the counter does not reset.
select public.platform_set_org_subscription(
  '70000000-0000-4000-8000-000000000001', 'pro', 'active', 'monthly', 'P70: #217 first payment');
reset role;
select private.record_billing_period(
  '70000000-0000-4000-8000-000000000001', 'pro', 'monthly', 'launch-il',
  now(), now() + interval '1 month', 'P70: #217 first billing period');
select pg_temp.p70_unchanged('the first payment (#217)');

-- #223: a repeated recovery event must not open a second billing period for the same start.
select pg_temp.p70_assert(
  (private.record_billing_period(
     '70000000-0000-4000-8000-000000000001', 'pro', 'monthly', 'launch-il',
     (select period_start from organization_billing_periods
      where org_id = '70000000-0000-4000-8000-000000000001' order by period_start desc limit 1),
     now() + interval '1 month', 'P70: replayed event') ->> 'idempotent')::boolean,
  'a replayed billing event opened a second billing period');

-- A price nobody wrote down cannot be charged: the money-shaped version of an unstated limit.
do $$
begin
  perform private.record_billing_period(
    '70000000-0000-4000-8000-000000000001', 'business', 'monthly', 'launch-il',
    now() + interval '2 months', now() + interval '3 months', 'P70: unpriced plan');
  raise exception 'expected a billing period on an unpriced plan to be refused';
exception when no_data_found then null;
end
$$;

select pg_temp.p70_as('71000000-0000-4000-8000-000000000002', true);
set local role authenticated;
-- #216 tier and interval change at renewal.
select public.platform_set_org_subscription(
  '70000000-0000-4000-8000-000000000001', 'premium', 'active', 'yearly', 'P70: #216 scheduled change');
reset role;
select pg_temp.p70_unchanged('a tier and interval change (#216)');

-- #221 renewal failure -> read-only. The commercial state changes; the meter does not.
update organization_subscriptions set status = 'past_due'
where org_id = '70000000-0000-4000-8000-000000000001';
select pg_temp.p70_unchanged('a failed renewal (#221)');

-- #223 late payment: a whole NEW billing period opens at the approval timestamp.
select private.record_billing_period(
  '70000000-0000-4000-8000-000000000001', 'premium', 'yearly', 'launch-il',
  now() + interval '1 second', now() + interval '1 year', 'P70: #223 late payment recovery');
update organization_subscriptions set status = 'active'
where org_id = '70000000-0000-4000-8000-000000000001';
select pg_temp.p70_unchanged('a late payment opening a new billing period (#223)');
select pg_temp.p70_assert(
  (select count(*) from organization_billing_periods
   where org_id = '70000000-0000-4000-8000-000000000001') = 2,
  'the late payment did not open a second, separate billing period');

-- #219/#220 cancellation at the period boundary -> Free, and #225 a full refund -> Free
-- immediately. Neither resets anything.
select pg_temp.p70_as('71000000-0000-4000-8000-000000000002', true);
set local role authenticated;
select public.platform_set_org_subscription(
  '70000000-0000-4000-8000-000000000001', 'free', 'active', 'monthly',
  'P70: #225 full refund ends the paid plan immediately');
reset role;
select pg_temp.p70_unchanged('a refund dropping the tenant back to Free (#225)');

-- And the billing periods survive as history. A refund corrects the money; it does not unwrite
-- that the customer was on a plan.
select pg_temp.p70_assert(
  (select count(*) from organization_billing_periods
   where org_id = '70000000-0000-4000-8000-000000000001') = 2,
  'a plan change deleted the billing history it was supposed to leave alone');

-- ===== 7. The Legacy cutover (#164) =====
-- One legacy tenant is already past what Free allows. #164 says exactly that may happen, and that
-- the dry run must name them BEFORE the cutover rather than after somebody is refused.
select private.record_usage_event(
  '70000000-0000-4000-8000-000000000004', 'documents.monthly', 40, 'p70-legacy-burst', 'p70');

select pg_temp.p70_as('71000000-0000-4000-8000-000000000002', true);
set local role authenticated;
select pg_temp.p70_assert(
  (select target_plan_key from public.platform_plan_cutover_report()
   where org_id = '70000000-0000-4000-8000-000000000004'
     and metric_key = 'documents.monthly') = 'free',
  'the dry run does not say a legacy tenant is heading to Free');
select pg_temp.p70_assert(
  (select over_target from public.platform_plan_cutover_report()
   where org_id = '70000000-0000-4000-8000-000000000004'
     and metric_key = 'documents.monthly'),
  'the dry run did not name the legacy tenant that is already over Free''s quota');
select pg_temp.p70_assert(
  not (select over_target from public.platform_plan_cutover_report()
       where org_id = '70000000-0000-4000-8000-000000000002'
         and metric_key = 'documents.monthly'),
  'the dry run reported a tenant as over quota that has used nothing');
-- The report carries the ceiling that was replaced beside the one now in force, per organization
-- and per metric, so the owner can see the size of every move rather than only its result.
-- The target follows the catalogue, so #266's 200 replaced #197's 250 here. The assertion is
-- about the report carrying BOTH numbers, not about either of their values, so it reads the
-- target from the catalogue rather than restating it and going stale again at the next decision.
select pg_temp.p70_assert(
  (select previous_limit is not null
      and target_limit = (select numeric_limit from plan_entitlements
                           where plan_key = 'free' and entitlement_key = 'ocr_pages.monthly')
      and previous_limit > target_limit
     from public.platform_plan_cutover_report()
    where org_id = '70000000-0000-4000-8000-000000000001'
      and metric_key = 'ocr_pages.monthly'),
  'the report does not carry the ceiling that was replaced beside the one now in force');
select pg_temp.p70_assert(
  (select ceiling_dropped from public.platform_plan_cutover_report()
   where org_id = '70000000-0000-4000-8000-000000000001'
     and metric_key = 'ocr_pages.monthly'),
  'the report does not flag a metric whose ceiling this migration lowered');
-- The pair above and below is what proves the flag DISCRIMINATES rather than always firing.
-- It used to contrast pages with documents; #266 lowered documents too, so the metric that does
-- not move is now the one with no prior ceiling to drop from — which is the more exact case
-- anyway, because `null -> 20` must never read as a reduction.
select pg_temp.p70_assert(
  not (select ceiling_dropped from public.platform_plan_cutover_report()
       where org_id = '70000000-0000-4000-8000-000000000001'
         and metric_key = 'assistant_runs.monthly'),
  'the report flagged a ceiling drop on a metric that had no ceiling to drop from');
select pg_temp.p70_assert(
  not exists (select 1 from public.platform_plan_cutover_report() where target_plan_key = 'legacy'),
  'the report proposed moving somebody ONTO the retired plan');
reset role;

-- A tenant cannot retire anybody, and an operator without the capability cannot either.
select pg_temp.p70_as('71000000-0000-4000-8000-000000000001', true);
set local role authenticated;
do $$
begin
  perform public.platform_legacy_cutover('P70: tenant tries the cutover');
  raise exception 'expected a tenant-initiated legacy cutover to be refused';
exception when insufficient_privilege then null;
end
$$;
select pg_temp.p70_assert(
  (select count(*) from public.platform_plan_cutover_report()) = 0,
  'a tenant read the platform cutover report');
reset role;

select pg_temp.p70_as('71000000-0000-4000-8000-000000000003', true);
set local role authenticated;
do $$
begin
  perform public.platform_legacy_cutover('P70: support tries the cutover');
  raise exception 'expected an operator without subscription.edit to be refused';
exception when insufficient_privilege then null;
end
$$;
reset role;

-- The capability without a fresh password is still not enough: this moves what every customer is
-- allowed to do, and it re-authenticates like every other high-impact platform command.
select pg_temp.p70_as('71000000-0000-4000-8000-000000000002', false);
set local role authenticated;
do $$
begin
  perform public.platform_legacy_cutover('P70: no step-up');
  raise exception 'expected a cutover without step-up to be refused';
exception when insufficient_privilege then null;
end
$$;
reset role;

select pg_temp.p70_as('71000000-0000-4000-8000-000000000002', true);
set local role authenticated;
do $$
begin
  perform public.platform_legacy_cutover('   ');
  raise exception 'expected a reasonless cutover to be refused';
exception when invalid_parameter_value then null;
end
$$;

select set_config('p70.cutover',
  public.platform_legacy_cutover('P70: #164 retire Legacy to Free')::text, true);
reset role;

select pg_temp.p70_assert(
  (current_setting('p70.cutover')::jsonb ->> 'moved')::integer >= 2,
  'the cutover did not move the legacy tenants');
select pg_temp.p70_assert(
  (current_setting('p70.cutover')::jsonb ->> 'remaining_legacy')::integer = 0,
  '#164 requires a postflight of zero active Legacy and the cutover did not reach it');
select pg_temp.p70_assert(
  (select count(*) from organization_subscriptions where plan_key = 'legacy') = 0,
  'an organization still holds a legacy subscription after the cutover');

-- Idempotent: a second run finds nothing to do and says so, rather than re-auditing everybody.
select pg_temp.p70_as('71000000-0000-4000-8000-000000000002', true);
set local role authenticated;
select pg_temp.p70_assert(
  (public.platform_legacy_cutover('P70: #164 replay') ->> 'moved')::integer = 0,
  'a replayed cutover moved organizations a second time');
reset role;

-- Audited with a reason, per organization, on the platform timeline.
select pg_temp.p70_assert(
  (select count(*) from public.platform_customer_timeline('70000000-0000-4000-8000-000000000004')
   where action = 'subscription_set') >= 1,
  'the cutover left no audited trace for the organization it moved');

-- #164 in one line: the move does not touch the usage period and does not reset counters, so a
-- tenant already past Free stays past it until its own next period.
select pg_temp.p70_assert(
  (select period_source from private.usage_period('70000000-0000-4000-8000-000000000004'))
    = 'signup_anchor',
  'the cutover changed how the moved tenant''s usage period is defined');
select pg_temp.p70_assert(
  (select quantity from private.usage_counters
   where org_id = '70000000-0000-4000-8000-000000000004'
     and metric_key = 'documents.monthly') = 40,
  'the cutover reset the moved tenant''s counter -- #164 says it must not');
do $$
begin
  perform private.assert_usage_within_limit(
    '70000000-0000-4000-8000-000000000004', 'documents.monthly', 40, 1);
  raise exception 'expected a tenant over Free''s quota to be refused new work after the cutover';
exception when raise_exception then
  if sqlerrm <> 'plan_limit_reached' then raise; end if;
end
$$;

-- ===== 8. Billing periods are not tenant-readable, and carry the catalogue version (#215) =====
select pg_temp.p70_assert(
  not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'organization_billing_periods'
      and grantee in ('anon', 'authenticated')),
  'a browser role holds a grant on the billing period ledger');
select pg_temp.p70_assert(
  (select count(*) from organization_billing_periods
   where org_id = '70000000-0000-4000-8000-000000000001'
     and catalogue_version = 'launch-il' and currency = 'ILS') = 2,
  'a billing period did not record the catalogue version and currency it was sold on');
select pg_temp.p70_assert(
  (select amount from organization_billing_periods
   where org_id = '70000000-0000-4000-8000-000000000001' and billing_interval = 'yearly') = 4490,
  'the billing period did not take its price from the catalogue version it names');

-- ===== 9. The client contract exists (the false-green rule) =====
-- A client suite that mocks a server function is green whether or not the function was ever
-- written. These assertions are the thing that would have caught eight mocked contracts meeting
-- zero real ones, and they name each signature rather than counting a catalogue -- a census would
-- also see the objects a concurrent, unmerged migration happens to have added to this container.
do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.get_public_plan_catalogue()',
    'public.get_public_plan_quotas()',
    'public.my_subscription()',
    'public.my_upgrade_options()',
    'public.my_referral_code()',
    'public.my_referral_bonus()',
    'public.service_bind_referral(uuid,text)',
    'public.platform_referral_ledger(uuid)',
    'public.platform_revoke_referral_grant(uuid,text,text)',
    'public.platform_plan_cutover_report()',
    'public.platform_legacy_cutover(text)',
    'public.organization_usage_snapshot()',
    'public.my_entitlements()'
  ] loop
    if to_regprocedure(v_signature) is null then
      raise exception 'P70: the published client contract % does not exist', v_signature;
    end if;
  end loop;
end
$$;

-- ===== 10. #208: a caller may not choose its own currency =====
-- The regression this exists to stop: a pricing read that TAKES a scope and is granted to a
-- browser role is a free currency picker with a different name, and the answer comes back wearing
-- the authority of a server response. The guard is the signature, not a convention.
select pg_temp.p70_assert(
  to_regprocedure('public.plan_pricing(text)') is null,
  'a pricing function that accepts a caller-supplied scope still exists');
select pg_temp.p70_assert(
  not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('plan_price_catalogues', 'plan_prices')
      and grantee in ('anon', 'authenticated')),
  'a browser role can still read the price tables, including the #215 notice metadata');
-- The `my_<noun>()` rule, enforced the way p51:78-85 already enforces it for my_entitlements():
-- one named function, one property. The prefix is not decoration -- it marks a read that takes NO
-- parameter and therefore cannot be aimed at another tenant, and a parameter is a thing an
-- attacker can change. This is the machine-checked form of the defect that put a caller-supplied
-- scope on a pricing function.
select pg_temp.p70_assert(
  (select pronargs from pg_proc procedure
    join pg_namespace space on space.oid = procedure.pronamespace
   where space.nspname = 'public' and procedure.proname = 'my_subscription') = 0,
  'my_subscription() grew a parameter -- the tenant must come from auth_org() alone');
select pg_temp.p70_assert(
  (select pronargs from pg_proc procedure
    join pg_namespace space on space.oid = procedure.pronamespace
   where space.nspname = 'public' and procedure.proname = 'my_upgrade_options') = 0,
  'my_upgrade_options() grew a parameter -- the tenant must come from auth_org() alone');
select pg_temp.p70_assert(
  (select pronargs from pg_proc procedure
    join pg_namespace space on space.oid = procedure.pronamespace
   where space.nspname = 'public' and procedure.proname = 'my_referral_code') = 0,
  'my_referral_code() grew a parameter -- the tenant must come from auth_org() alone');
select pg_temp.p70_assert(
  (select pronargs from pg_proc procedure
    join pg_namespace space on space.oid = procedure.pronamespace
   where space.nspname = 'public' and procedure.proname = 'my_referral_bonus') = 0,
  'my_referral_bonus() grew a parameter -- the tenant must come from auth_org() alone');
-- The public catalogue reads take nothing either, for the #208 reason rather than the tenant one:
-- an argument on an anon-executable pricing read is a free currency picker with a different name.
select pg_temp.p70_assert(
  (select pronargs from pg_proc procedure
    join pg_namespace space on space.oid = procedure.pronamespace
   where space.nspname = 'public' and procedure.proname = 'get_public_plan_catalogue') = 0,
  'get_public_plan_catalogue() grew a parameter -- a caller could then name its own currency');
select pg_temp.p70_assert(
  (select pronargs from pg_proc procedure
    join pg_namespace space on space.oid = procedure.pronamespace
   where space.nspname = 'public' and procedure.proname = 'get_public_plan_quotas') = 0,
  'get_public_plan_quotas() grew a parameter');

select set_config('request.jwt.claim.role', 'anon', true);
set local role anon;
-- The anonymous page gets BOTH catalogues, each labelled, asserting nothing about the viewer.
select pg_temp.p70_assert(
  (select count(*) from public.get_public_plan_catalogue()) = 8
  and (select count(distinct currency) from public.get_public_plan_catalogue()) = 2,
  'the anonymous catalogue does not return both currencies for the four public plans');
select pg_temp.p70_assert(
  (select count(*) from public.get_public_plan_catalogue() where plan_key = 'business') = 0
  and (select count(*) from public.get_public_plan_quotas() where plan_key = 'business') = 0,
  'Business reached an anonymous surface -- `דברו איתנו` is the whole public answer (#201)');
-- #200: the storage ceilings are internal safety limits and are never published.
select pg_temp.p70_assert(
  (select count(*) from public.get_public_plan_quotas() where entitlement_key = 'storage.bytes') = 0,
  'the internal storage ceiling was published as a plan quota');
-- #199 / DEBT §56: an entitlement nothing counts is reported unmeasured AND blank, so a caller
-- that forgets to read the flag still cannot publish a promise.
select pg_temp.p70_assert(
  not exists (
    select 1 from public.get_public_plan_quotas()
    where not measured and (unlimited or numeric_limit is not null)),
  'an unmeasured entitlement was published with a value attached');
-- Read from the catalogue rather than restated: the assertion is that what is PUBLISHED equals
-- what is enforced, which is the property that matters and the one that does not go stale when a
-- decision moves the figure.
select pg_temp.p70_assert(
  (select measured from public.get_public_plan_quotas()
   where plan_key = 'basic' and entitlement_key = 'documents.monthly')
  and (select numeric_limit from public.get_public_plan_quotas()
       where plan_key = 'basic' and entitlement_key = 'documents.monthly')
      = (select numeric_limit from plan_entitlements
          where plan_key = 'basic' and entitlement_key = 'documents.monthly'),
  'a decided, counted quota was not published');
reset role;

-- An authenticated tenant with no verified billing country is told it has none, rather than being
-- quoted in a currency somebody guessed for it.
select pg_temp.p70_as('71000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.p70_assert(
  (select billing_country_verified from public.my_subscription()) = false
  and (select catalogue_currency from public.my_subscription()) is null,
  'an unverified billing country produced a currency anyway');
select pg_temp.p70_assert(
  (select count(*) from public.my_upgrade_options()) = 5
  and (select contact_sales from public.my_upgrade_options()
       where plan_key = 'business')
  and (select monthly_amount from public.my_upgrade_options()
       where plan_key = 'business') is null,
  'the upgrade surface does not show all five rungs with Business priceless');
select pg_temp.p70_assert(
  not exists (select 1 from public.my_upgrade_options() where currency is not null),
  'an upgrade price appeared without a verified billing country');
reset role;

-- Once a signed provider event has verified a country, the currency follows from it -- derived,
-- never asked for.
select private.record_billing_country(
  '70000000-0000-4000-8000-000000000001', 'IL', now(), null);
select pg_temp.p70_as('71000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.p70_assert(
  (select catalogue_currency from public.my_subscription()) = 'ILS'
  and (select billing_country from public.my_subscription()) = 'IL',
  'a verified billing country did not select its catalogue');
select pg_temp.p70_assert(
  (select monthly_amount from public.my_upgrade_options() where plan_key = 'pro')
    = 249,
  'the upgrade surface did not price from the verified country''s catalogue');
reset role;

-- ===== 11. Referral (#212, #227, #228, #229, #230) =====
-- Clear the impersonation first. audit_row_change (0020:198) derives the acting organization from
-- the JWT, and creating a tenant while wearing another tenant's identity is refused as a
-- cross-tenant audit source -- the same trap p52 documents for its own fixture.
select pg_temp.p70_as(null);

insert into public.organizations (id, name, status, created_at) values
  ('70000000-0000-4000-8000-000000000005', 'P70 referrer', 'active', now() - interval '300 days'),
  ('70000000-0000-4000-8000-000000000006', 'P70 referred', 'active', now() - interval '10 days'),
  ('70000000-0000-4000-8000-000000000007', 'P70 twin-email tenant', 'active', now() - interval '9 days');

insert into auth.users (id, email, email_confirmed_at) values
  ('71000000-0000-4000-8000-000000000005', 'owner-referrer-p70@example.test', now()),
  ('71000000-0000-4000-8000-000000000006', 'owner-referred-p70@example.test', now()),
  -- The same address in different case. `auth.users` uniqueness is on the RAW email, so these are
  -- two legitimate accounts as far as the database is concerned -- and they are the same person as
  -- far as #228 is concerned, which is exactly why the block compares case-insensitively.
  ('71000000-0000-4000-8000-000000000007', 'Owner-Referrer-P70@example.test', now());

insert into public.profiles (id, org_id, full_name, role) values
  ('71000000-0000-4000-8000-000000000005', '70000000-0000-4000-8000-000000000005', 'P70 referrer owner', 'owner'),
  ('71000000-0000-4000-8000-000000000006', '70000000-0000-4000-8000-000000000006', 'P70 referred owner', 'owner'),
  ('71000000-0000-4000-8000-000000000007', '70000000-0000-4000-8000-000000000007', 'P70 twin owner', 'owner');

-- Every organization can share. A code that does not exist cannot be given away.
select pg_temp.p70_assert(
  (select count(*) from private.referral_codes
   where org_id in ('70000000-0000-4000-8000-000000000005',
                    '70000000-0000-4000-8000-000000000006')) = 2,
  'a newly created organization has no referral code to share');

select set_config('p70.referrer_code',
  (select code from private.referral_codes
   where org_id = '70000000-0000-4000-8000-000000000005'), true);

-- #229: binding happens in the signup request, through the service path and nothing else. Asserted
-- on the GRANT rather than by calling it from a browser role: no browser role holds EXECUTE at
-- all, so there is no in-function refusal to observe, and a privilege check is the stronger claim
-- anyway -- it holds even if the function's own guard is later edited.
select pg_temp.p70_assert(
  not has_function_privilege('anon', 'public.service_bind_referral(uuid,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.service_bind_referral(uuid,text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.service_bind_referral(uuid,text)', 'EXECUTE'),
  'referral binding is reachable from a browser role, or unreachable from the signup path');

select set_config('request.jwt.claim.role', 'service_role', true);
-- An absent or unknown code produces an organization with no referrer and does NOT raise: a
-- mistyped share link must never be able to stop somebody opening an account.
select pg_temp.p70_assert(
  (public.service_bind_referral('70000000-0000-4000-8000-000000000006', null) ->> 'reason')
    = 'code_absent'
  and (public.service_bind_referral('70000000-0000-4000-8000-000000000006', 'NOTACODE12') ->> 'reason')
    = 'code_unknown',
  'a missing or unknown referral code did not fall through harmlessly');
select pg_temp.p70_assert(
  (select count(*) from private.organization_referrals
   where referred_org_id = '70000000-0000-4000-8000-000000000006') = 0,
  'an invalid code created a binding anyway');

-- #228: the same verified owner email is a hard block, and the verdict is a code, never an address.
select pg_temp.p70_assert(
  (public.service_bind_referral(
     '70000000-0000-4000-8000-000000000007', current_setting('p70.referrer_code')) ->> 'reason')
    = 'same_verified_owner_email',
  'two organizations sharing a verified owner email were allowed to refer each other');

select pg_temp.p70_assert(
  (public.service_bind_referral(
     '70000000-0000-4000-8000-000000000006', current_setting('p70.referrer_code')) ->> 'bound')::boolean,
  'a valid referral code did not bind');
-- #229: one binding, immutable. A second attempt reports the existing state rather than replacing.
select pg_temp.p70_assert(
  (public.service_bind_referral('70000000-0000-4000-8000-000000000006', 'NOTACODE12') ->> 'reason')
    = 'already_bound',
  'a second binding attempt was treated as a fresh attribution');
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
begin
  update private.organization_referrals
     set referrer_org_id = '70000000-0000-4000-8000-000000000001'
   where referred_org_id = '70000000-0000-4000-8000-000000000006';
  raise exception 'expected the referral binding to be immutable';
exception when insufficient_privilege then null;
end
$$;

-- #212: binding is not activation. Nothing is paid until the owner's email is verified AND a
-- document has really been processed.
select pg_temp.p70_assert(
  (select count(*) from private.referral_grants) = 0,
  'a referral paid out before it was activated');

-- The first successfully processed document. The extraction row IS that event, which is why
-- activation hangs off it rather than off a second definition of "processed".
insert into public.documents (
  org_id, entity_type, entity_id, storage_path, file_name, mime_type, uploaded_by,
  document_kind, supplier_id, document_date
) values (
  '70000000-0000-4000-8000-000000000006', 'inbox', null,
  '70000000-0000-4000-8000-000000000006/inbox/first.pdf', 'first.pdf', 'application/pdf',
  '71000000-0000-4000-8000-000000000006', 'other', null, null);

insert into public.document_processing_jobs (
  org_id, document_id, requested_by, status, input_checksum, contract_version
) values (
  '70000000-0000-4000-8000-000000000006',
  (select id from public.documents where org_id = '70000000-0000-4000-8000-000000000006'),
  '71000000-0000-4000-8000-000000000006', 'queued', 'etag:dddddddddddddddd', '1');

insert into public.document_extractions (
  org_id, job_id, document_id, engine, model, model_version, input_checksum,
  contract_version, payload
) values (
  '70000000-0000-4000-8000-000000000006',
  (select id from public.document_processing_jobs
   where org_id = '70000000-0000-4000-8000-000000000006'),
  (select id from public.documents where org_id = '70000000-0000-4000-8000-000000000006'),
  'p70', 'p70-model', '1', 'etag:dddddddddddddddd', '1',
  jsonb_build_object(
    'schema_version', '1',
    'document', jsonb_build_object(
      'page_count', 3, 'detected_languages', jsonb_build_array('he'),
      'plain_text', 'p70', 'partial', false),
    'blocks', '[]'::jsonb, 'tables', '[]'::jsonb, 'marks', '[]'::jsonb));

select pg_temp.p70_assert(
  (select activated_at from private.organization_referrals
   where referred_org_id = '70000000-0000-4000-8000-000000000006') is not null,
  'a first processed document did not activate the referral');

-- #227: BOTH sides are credited, each inside ITS OWN current usage period -- and the two periods
-- are anchored to two different signup instants, so this is not one shared window.
select pg_temp.p70_assert(
  (select count(*) from private.referral_grants
   where referred_org_id = '70000000-0000-4000-8000-000000000006') = 2,
  'a referral did not credit both organizations');
select pg_temp.p70_assert(
  (select count(*) from private.referral_grants grant_row
   join private.organization_usage_anchors anchor
     on anchor.org_id = grant_row.beneficiary_org_id
   cross join lateral private.usage_period(grant_row.beneficiary_org_id) period
   where grant_row.period_start <> period.period_start) = 0,
  'a grant was credited to a period that is not the beneficiary''s own current one');
select pg_temp.p70_assert(
  (select count(distinct period_start) from private.referral_grants
   where referred_org_id = '70000000-0000-4000-8000-000000000006') = 2,
  'both sides were credited in the same window -- their signup anchors differ');
select pg_temp.p70_assert(
  (select count(*) from private.referral_grants where quantity = 10) = 2,
  'the referral did not pay the ten #227 decided');

-- The bonus reaches the quota through the ONE resolution rule, so enforcement and every read model
-- see the same number.
-- Plan limit PLUS the ten, read from the catalogue rather than added up here: the assertion is
-- that the bonus reaches the quota through the one resolution rule, not that the plan is at any
-- particular number. #266 moved free from 25 to 20 and this did not have to move with it.
-- The plan is read from the ORGANISATION rather than named, because which plan a new one is
-- created on stopped being a constant in 0210: inside the pre-launch window it is `premium`, after
-- it `free`. Naming either would make this assertion fail on a calendar date for a reason that has
-- nothing to do with referrals -- and the comment above already says the point is the bonus
-- reaching the quota through the one resolution rule, not the plan being at any particular number.
select pg_temp.p70_assert(
  (public.effective_entitlement(
    '70000000-0000-4000-8000-000000000006', 'documents.monthly') ->> 'limit')::numeric
   = (select entitlement.numeric_limit + 10
      from plan_entitlements entitlement
      join organization_subscriptions subscription
        on subscription.plan_key = entitlement.plan_key
      where subscription.org_id = '70000000-0000-4000-8000-000000000006'
        and entitlement.entitlement_key = 'documents.monthly'),
  'the referral bonus did not raise the beneficiary''s effective limit');
select pg_temp.p70_assert(
  (public.effective_entitlement(
    '70000000-0000-4000-8000-000000000006', 'documents.monthly') ->> 'referral_bonus')::numeric = 10,
  'the resolution rule does not report the bonus separately from the plan');
-- An unstated limit stays a refusal: a bonus is added to a number, and there is no number here.
-- Since #198 the only genuinely unstated ceiling is the contract-priced rung's assistant quota, so
-- the organization is moved onto it for the length of this check and put straight back -- what is
-- being tested is the resolution rule, not which plan this fixture happens to sit on.
update organization_subscriptions set plan_key = 'business'
where org_id = '70000000-0000-4000-8000-000000000006';
select pg_temp.p70_assert(
  (public.effective_entitlement(
    '70000000-0000-4000-8000-000000000006', 'assistant_runs.monthly') ->> 'measured')::boolean
    = false,
  'a bonus made an unstated limit look measured');
update organization_subscriptions set plan_key = 'free'
where org_id = '70000000-0000-4000-8000-000000000006';

-- A replayed activation pays once. The key is (referral, beneficiary, period) and the retry lands
-- on the same row.
select private.try_activate_referral('70000000-0000-4000-8000-000000000006');
select pg_temp.p70_assert(
  (select count(*) from private.referral_grants
   where referred_org_id = '70000000-0000-4000-8000-000000000006') = 2
  and (select sum(quantity) from private.referral_grants
   where beneficiary_org_id = '70000000-0000-4000-8000-000000000006') = 10,
  'a replayed activation paid a second time');

-- #228: a cycle is a hard block. The referrer now tries to be referred by the organization it
-- referred.
select set_config('request.jwt.claim.role', 'service_role', true);
select pg_temp.p70_assert(
  (public.service_bind_referral(
     '70000000-0000-4000-8000-000000000005',
     (select code from private.referral_codes
      where org_id = '70000000-0000-4000-8000-000000000006')) ->> 'bound')::boolean,
  'the cycle fixture did not bind -- a cycle is only detectable once both edges exist');
select set_config('request.jwt.claim.role', 'authenticated', true);
select pg_temp.p70_assert(
  (private.try_activate_referral('70000000-0000-4000-8000-000000000005') ->> 'reason')
    = 'referral_cycle',
  'a referral cycle was allowed to pay out');
select pg_temp.p70_assert(
  (select block_reason from private.organization_referrals
   where referred_org_id = '70000000-0000-4000-8000-000000000005') = 'referral_cycle',
  'the cycle block was not recorded as a reason code');

-- #230: reversal takes back only the UNUSED remainder. Consume four of the beneficiary's units
-- first: the plan allowance plus four, against a bonus of 10, means four of the bonus are spent
-- and six remain -- whatever the plan allowance is worth on the day.
-- The burn is the PLAN limit plus four, so four of the ten-document grant are spent and six
-- remain whatever the plan is worth. It used to be the literal 29, which meant "25 plus four"
-- until #266 moved free to 20 and quietly turned it into "20 plus nine".
do $$
declare v_i integer; v_burn integer;
begin
  select numeric_limit + 4 into v_burn from plan_entitlements
   where plan_key = 'free' and entitlement_key = 'documents.monthly';
  for v_i in 1..v_burn loop
    perform private.record_usage_event(
      '70000000-0000-4000-8000-000000000006', 'documents.monthly', 1,
      'p70-burn-' || v_i, 'p70');
  end loop;
end
$$;
select pg_temp.p70_assert(
  (select quantity from private.usage_counters
   where org_id = '70000000-0000-4000-8000-000000000006'
     and metric_key = 'documents.monthly')
   = (select numeric_limit + 4 from plan_entitlements
       where plan_key = 'free' and entitlement_key = 'documents.monthly'),
  'the reversal fixture did not consume what it meant to');

select pg_temp.p70_as('71000000-0000-4000-8000-000000000002', true);
set local role authenticated;
do $$
begin
  perform public.platform_revoke_referral_grant(
    '70000000-0000-4000-8000-000000000006', 'P70: fraud review', null);
  raise exception 'expected a reversal without evidence to be refused';
exception when invalid_parameter_value then null;
end
$$;
select set_config('p70.reversal',
  public.platform_revoke_referral_grant(
    '70000000-0000-4000-8000-000000000006',
    'P70: #230 confirmed fraudulent referral',
    'P70: operator ticket 4711, chargeback evidence attached')::text, true);
reset role;

select pg_temp.p70_assert(
  (select revoked_quantity from private.referral_grants
   where beneficiary_org_id = '70000000-0000-4000-8000-000000000006') = 6,
  'the reversal did not take back exactly the unused remainder');
select pg_temp.p70_assert(
  (select revoked_quantity from private.referral_grants
   where beneficiary_org_id = '70000000-0000-4000-8000-000000000005') = 10,
  'the untouched beneficiary''s whole unused grant was not reversed');
select pg_temp.p70_assert(
  (select quantity from private.usage_counters
   where org_id = '70000000-0000-4000-8000-000000000006'
     and metric_key = 'documents.monthly')
   = (select numeric_limit + 4 from plan_entitlements
       where plan_key = 'free' and entitlement_key = 'documents.monthly'),
  'the reversal clawed back usage that had already happened -- #230 forbids it');
select pg_temp.p70_assert(
  (select count(*) from private.referral_grants
   where referred_org_id = '70000000-0000-4000-8000-000000000006') = 2,
  'a reversed grant was deleted instead of marked');
-- #230: the full issued amount keeps counting toward the ceiling, so a reversal cannot mint room
-- for a fresh allowance.
select pg_temp.p70_assert(
  (select sum(quantity) from private.referral_grants
   where beneficiary_org_id = '70000000-0000-4000-8000-000000000006') = 10,
  'a reversal reduced the issued amount the period ceiling is measured on');

-- An identical retry adds no second reversal.
select pg_temp.p70_as('71000000-0000-4000-8000-000000000002', true);
set local role authenticated;
select pg_temp.p70_assert(
  (public.platform_revoke_referral_grant(
     '70000000-0000-4000-8000-000000000006',
     'P70: #230 confirmed fraudulent referral',
     'P70: operator ticket 4711, chargeback evidence attached') ->> 'idempotent')::boolean,
  'a repeated reversal was not idempotent');
reset role;

rollback;

\echo 'p70_launch_plans_and_usage_anchor_passed'
