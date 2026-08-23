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

-- ===== 2. Volumes: what is live, and what was decided but withheld (#197) =====
-- Pinned as the deliberately MIXED state 0184 landed: the two new rungs at the decided #197
-- figures, the two existing rungs untouched because every remaining #197 figure is a REDUCTION and
-- no decision says when a reduction reaches an organization already on the plan.
select pg_temp.p70_assert(
  (select count(*) from (values
     ('free',    'documents.monthly',   25),
     ('free',    'ocr_pages.monthly',  500),
     ('basic',   'documents.monthly',   50),
     ('basic',   'ocr_pages.monthly',  500),
     ('pro',     'documents.monthly',  300),
     ('pro',     'ocr_pages.monthly', 6000),
     ('premium', 'documents.monthly',  500),
     ('premium', 'ocr_pages.monthly', 5000)) as expected(plan_key, entitlement_key, quota)
   join plan_entitlements entitlement
     on entitlement.plan_key = expected.plan_key
    and entitlement.entitlement_key = expected.entitlement_key
    and not entitlement.unlimited
    and entitlement.numeric_limit = expected.quota) = 8,
  'the metered quotas are not the eight values 0184 pinned');
select pg_temp.p70_assert(
  (select count(*) from private.plan_quota_decisions) = 8
  and (select count(*) from private.plan_quota_decisions where not applied) = 3,
  '#197 decided eight figures with three withheld, and the record no longer says so');
-- A withheld figure must always be BELOW the live one. A withheld increase would be a customer
-- quietly kept under what the owner decided they get.
select pg_temp.p70_assert(
  not exists (
    select 1 from private.plan_quota_decisions decision
    join plan_entitlements entitlement
      on entitlement.plan_key = decision.plan_key
     and entitlement.entitlement_key = decision.entitlement_key
    where not decision.applied
      and (entitlement.unlimited or entitlement.numeric_limit is null
           or entitlement.numeric_limit <= decision.decided_limit)),
  'a withheld quota decision was not a reduction');
select pg_temp.p70_assert(
  not exists (select 1 from private.plan_quota_decisions
              where not applied and nullif(btrim(coalesce(withheld_reason, '')), '') is null),
  'a quota figure was withheld without a stated reason');

-- #196: tiers differ by volume only. A boolean that is false anywhere gates a capability by plan.
select pg_temp.p70_assert(
  not exists (select 1 from plan_entitlements where kind = 'boolean' and boolean_value is not true),
  'a capability was gated by plan -- #196 forbids it');
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
-- The assistant quota is the ONE metric allowed to sit in the unknown-that-refuses state: #198
-- states the steady numbers but #209 puts a differently-anchored 30-day window in front of them.
select pg_temp.p70_assert(
  not exists (
    select 1 from plan_entitlements
    where kind = 'numeric' and not unlimited and numeric_limit is null
      and entitlement_key <> 'assistant_runs.monthly'),
  'a metric beyond the assistant quota entered the unknown-that-refuses state');
select pg_temp.p70_assert(
  (select count(*) from plan_entitlements
   where entitlement_key = 'assistant_runs.monthly' and not unlimited and numeric_limit is null)
   = (select count(*) from subscription_plans),
  'the assistant quota stopped refusing on some rung without #209 being decided');

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
select pg_temp.p70_assert(
  (select count(*) from public.plan_pricing('IL')) = 8
  and (select count(*) from public.plan_pricing('ROW')) = 8,
  'the anonymous pricing read did not return four plans on two intervals');
select pg_temp.p70_assert(
  (select count(*) from public.plan_pricing('IL') where currency <> 'ILS') = 0
  and (select count(*) from public.plan_pricing('ROW') where currency <> 'USD') = 0,
  'a pricing scope returned the other scope''s currency');
select pg_temp.p70_assert(
  (select count(*) from public.plan_pricing('IL') where plan_key = 'business') = 0,
  'the public pricing read exposed a Business price');
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
-- The withheld reductions are visible in the same report, so the owner decides on evidence.
select pg_temp.p70_assert(
  (select decided_limit from public.platform_plan_cutover_report()
   where org_id = '70000000-0000-4000-8000-000000000001'
     and metric_key = 'documents.monthly') is not null,
  'the report does not carry the decided figure alongside the live one');
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

rollback;

\echo 'p70_launch_plans_and_usage_anchor_passed'
