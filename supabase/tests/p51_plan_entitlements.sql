-- P51 -- One resolution rule for what a customer is entitled to: an override beats the plan, an
-- unstated limit is "unknown" rather than infinity, and a tenant can read its own plan and nobody
-- else's (0154).
\set ON_ERROR_STOP on

begin;

create function pg_temp.p51_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P51 plan entitlement assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p51_as(p_user uuid, p_fresh_password boolean default false)
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

-- ===== Structural claims =====
-- The catalogue is readable; the customer's own commercial state is not table-readable at all.
select pg_temp.p51_assert(
  not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('organization_subscriptions', 'organization_entitlement_overrides')
      and grantee in ('anon', 'authenticated')),
  'a browser role holds a grant on the subscription or override table');
select pg_temp.p51_assert(
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('subscription_plans', 'plan_entitlements')
      and grantee = 'authenticated' and privilege_type <> 'SELECT') = 0,
  'the plan catalogue is writable by a browser role');

-- `/pricing` is a public route. Anonymous readers need the active catalogue, but never the
-- inactive `legacy` holding plan that exists only for customers predating self-service.
select pg_temp.p51_assert(
  has_table_privilege('anon', 'public.subscription_plans', 'SELECT')
  and has_table_privilege('anon', 'public.plan_entitlements', 'SELECT'),
  'the public pricing route cannot read the plan catalogue');

select set_config('request.jwt.claim.role', 'anon', true);
set local role anon;
select pg_temp.p51_assert(
  (select count(*) from subscription_plans) > 0
  and (select count(*) from plan_entitlements) > 0,
  'the anonymous pricing policies returned an empty catalogue');
select pg_temp.p51_assert(
  (select count(*) from subscription_plans where not active) = 0,
  'the anonymous pricing catalogue exposed an inactive plan');
select pg_temp.p51_assert(
  (select string_agg(plan_key, '<' order by tier_order) from subscription_plans)
    = 'free<basic<pro<premium<business',
  'the anonymous pricing catalogue is not the ladder #194 decided, in order');
select pg_temp.p51_assert(
  not exists (select 1 from plan_entitlements where plan_key = 'legacy'),
  'the anonymous pricing catalogue exposed legacy entitlements');
select pg_temp.p51_assert(
  not exists (
    select 1 from plan_entitlements entitlement
    where not exists (
      select 1 from subscription_plans plan
      where plan.plan_key = entitlement.plan_key)),
  'the anonymous pricing catalogue exposed entitlements without a visible active plan');
reset role;

-- my_entitlements() must take no organization argument: a parameter is a thing an attacker can
-- change, and this function's whole safety is that the tenant comes from auth_org().
select pg_temp.p51_assert(
  (select pronargs from pg_proc procedure
    join pg_namespace space on space.oid = procedure.pronamespace
   where space.nspname = 'public' and procedure.proname = 'my_entitlements') = 0,
  'my_entitlements() grew a parameter -- the tenant must come from auth_org() alone');

-- Until 19.08.2026 this asserted that NO plan carried a numeric limit, because the numbers were
-- an open owner decision and a seeded limit would have been an invented one. The owner decided
-- (#166), so the guard now pins what was decided rather than the absence of a decision: Free
-- below Pro, both stated, and nothing else restrictive.
--
-- The figures moved on 24.08.2026 under #266 -- 25/200 became 20/150 -- and this pin moved with
-- the decision, which is the only thing that may move it.
select pg_temp.p51_assert(
  (select numeric_limit from plan_entitlements
    where plan_key = 'free' and entitlement_key = 'documents.monthly') = 20
  and (select numeric_limit from plan_entitlements
    where plan_key = 'pro' and entitlement_key = 'documents.monthly') = 150,
  'the decided monthly document limits moved without a decision');
select pg_temp.p51_assert(
  (select unlimited from plan_entitlements
    where plan_key = 'business' and entitlement_key = 'documents.monthly')
  and (select unlimited from plan_entitlements
    where plan_key = 'legacy' and entitlement_key = 'documents.monthly'),
  'a limit was applied to a plan that promises none');
-- Page quotas are the document quota times TEN. Until 23.08.2026 this pinned 0163's twenty, the
-- per-document AI page ceiling; #197 replaces the COMMERCIAL ratio with ten and keeps the twenty
-- as a separate per-file cap in the worker. Pinning the RELATIONSHIP rather than the numbers is
-- what catches a later edit that moves one and forgets the other, which would refuse a customer
-- who stayed inside the document quota they were sold.
-- Pinned as the relationship rather than as two products of the numbers of the day: #266 moved
-- the documents on 24.08.2026 and this assertion did not have to move with them, which is the
-- property the paragraph above claims and did not previously have.
select pg_temp.p51_assert(
  not exists (
    select 1
      from plan_entitlements docs
      join plan_entitlements pages on pages.plan_key = docs.plan_key
     where docs.entitlement_key = 'documents.monthly'
       and pages.entitlement_key = 'ocr_pages.monthly'
       and not docs.unlimited and not pages.unlimited
       and pages.numeric_limit is distinct from docs.numeric_limit * 10),
  'the page quotas are no longer the document quota times ten');
select pg_temp.p51_assert(
  (select numeric_limit from plan_entitlements
    where plan_key = 'basic' and entitlement_key = 'documents.monthly') = 40
  and (select numeric_limit from plan_entitlements
    where plan_key = 'basic' and entitlement_key = 'ocr_pages.monthly') = 40 * 10
  and (select numeric_limit from plan_entitlements
    where plan_key = 'premium' and entitlement_key = 'documents.monthly') = 375
  and (select numeric_limit from plan_entitlements
    where plan_key = 'premium' and entitlement_key = 'ocr_pages.monthly') = 375 * 10,
  'the launch rungs are not at the volumes #266 decided for them');
-- Every decided figure is on record beside the one it replaced, so the size of each move stays
-- answerable after the fact -- three of the eight lowered a ceiling somebody was already under.
-- Scoped to #197 by its own decision_ref since 0202 recorded #198's four assistant figures in the
-- same table: a bare count would have turned a second owner decision into a test failure, and
-- worse, would have let one of #197's own eight go missing behind #198's four.
--
-- The eight metered figures belong to #266 since 24.08.2026: the ledger holds the CURRENT
-- decision per quota rather than a log, so 0208 restated all eight and every one came down.
-- 0208 is idempotent about this on purpose -- a second run keeps the ceiling it replaced instead
-- of recording "it was already 20", which would erase the move it is meant to evidence.
select pg_temp.p51_assert(
  (select count(*) from private.plan_quota_decisions
   where decision_ref = 'OPEN-DECISIONS #266') = 8
  and (select count(*) from private.plan_quota_decisions
       where decision_ref = 'OPEN-DECISIONS #266'
         and previous_limit is not null and previous_limit > decided_limit) = 8,
  'the #266 record does not hold eight figures, every one of them a reduction');
-- Two teeth, kept apart. The first: a plan may not restrict anything the owner has not decided.
-- Naming the allowed metrics was how this read until 0202 added a third, and a list of names has to
-- be edited every time -- so the rule is now stated as what it always meant: every stated ceiling
-- must be backed by a row in the decision ledger for that exact plan and figure. A number typed
-- into plan_entitlements without a decision behind it still fails, whichever metric it belongs to,
-- and a boolean turned off still fails because no decision row can back it.
select pg_temp.p51_assert(
  not exists (
    select 1 from plan_entitlements entitlement
    where ((entitlement.kind = 'numeric'
             and not entitlement.unlimited and entitlement.numeric_limit is not null)
        or (entitlement.kind = 'boolean' and entitlement.boolean_value is not true))
      and not exists (
        select 1 from private.plan_quota_decisions decision
        where decision.plan_key = entitlement.plan_key
          and decision.entitlement_key = entitlement.entitlement_key
          and decision.decided_limit = entitlement.numeric_limit)),
  'a plan ceiling was stated without a recorded owner decision behind it');
-- The second: the unknown-that-refuses state is pinned to exactly the rows allowed to hold it.
-- Since #198 that is the assistant quota on the contract-priced rung and on the retired one --
-- `מותאם` is a per-contract override, not a number a migration may invent, and Legacy gets no new
-- allowance. Any other unstated numeric would ship as "unknown" and read as green.
select pg_temp.p51_assert(
  not exists (
    select 1 from plan_entitlements
    where kind = 'numeric' and not unlimited and numeric_limit is null
      and not (entitlement_key = 'assistant_runs.monthly'
               and plan_key in ('business', 'legacy'))),
  'an entitlement beyond the contract-priced assistant quota entered the unknown-that-refuses state');

-- ===== Fixture =====
insert into public.organizations (id, name, status, created_at) values
  ('51000000-0000-4000-8000-000000000001', 'P51 tenant A', 'active', now() - interval '60 days'),
  ('51000000-0000-4000-8000-000000000002', 'P51 tenant B', 'active', now() - interval '50 days');

insert into auth.users (id, email) values
  ('61000000-0000-4000-8000-000000000001', 'owner-a-p51@example.test'),
  ('61000000-0000-4000-8000-000000000002', 'owner-b-p51@example.test'),
  ('61000000-0000-4000-8000-000000000003', 'billing-p51@example.test'),
  ('61000000-0000-4000-8000-000000000004', 'support-p51@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('61000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000001', 'P51 owner A', 'owner'),
  ('61000000-0000-4000-8000-000000000002', '51000000-0000-4000-8000-000000000002', 'P51 owner B', 'owner');

insert into public.platform_admins (user_id, note) values
  ('61000000-0000-4000-8000-000000000003', 'P51 billing operator'),
  ('61000000-0000-4000-8000-000000000004', 'P51 support operator');
insert into public.platform_admin_roles (user_id, role_key) values
  ('61000000-0000-4000-8000-000000000003', 'billing'),
  ('61000000-0000-4000-8000-000000000004', 'support');

-- Organizations created after 0154 land on a plan through the default-subscription trigger, not
-- through the one-time backfill. Proving that here is the whole reason wave 4 will not refuse
-- every customer who signs up tomorrow.
--
-- WHICH plan is now a function of the clock, not a constant (0210, owner ruling 25.08.2026):
-- inside the pre-launch window every organisation is a demo and is created on `premium`; after it,
-- on `free` again, with no further migration because the trigger reads the date rather than a row
-- somebody has to remember to change. The assertion reads the SAME date from the SAME function --
-- a literal here would be the second copy of a deadline that 0210 exists to avoid, and it would
-- start failing on its own the day the window closes.
-- Captured HERE, while the suite is still superuser: `private` is unreadable to `authenticated`,
-- and the isolation assertion further down runs under that role.
select case when clock_timestamp() < private.prelaunch_window_end() then 'premium' else 'free' end
  as plan \gset p51_default_
select pg_temp.p51_assert(
  (select plan_key from organization_subscriptions
    where org_id = '51000000-0000-4000-8000-000000000002') = :'p51_default_plan',
  'a newly created organization received no default subscription');

-- Move A to a paid tier so the plan lookup resolves something other than the default.
update organization_subscriptions set plan_key = 'pro'
where org_id = '51000000-0000-4000-8000-000000000001';

-- ===== The tenant sees its own plan and nothing else =====
select pg_temp.p51_as('61000000-0000-4000-8000-000000000001');
set local role authenticated;

select pg_temp.p51_assert(
  (select plan_key from public.my_entitlements() limit 1) = 'pro',
  'the tenant did not resolve to its own plan');
select pg_temp.p51_assert(
  (select count(*) from public.my_entitlements())
    = (select count(*) from public.subscription_plans limit 1) * 0
      + (select count(*) from public.plan_entitlements where plan_key = 'pro'),
  'my_entitlements() did not return one row per defined entitlement');
select pg_temp.p51_assert(
  (select count(*) from public.subscription_plans) >= 4
  and (select count(*) from public.plan_entitlements) > 0,
  'the tenant cannot read the plan catalogue it is about to be told about');

do $$
begin
  perform (select count(*) from public.organization_subscriptions);
  raise exception 'expected a direct tenant read of organization_subscriptions to be refused';
exception when insufficient_privilege then null;
end
$$;
do $$
begin
  perform (select count(*) from public.organization_entitlement_overrides);
  raise exception 'expected a direct tenant read of the override table to be refused';
exception when insufficient_privilege then null;
end
$$;
do $$
begin
  update public.plan_entitlements set unlimited = false where plan_key = 'free';
  raise exception 'expected a tenant rewrite of the plan catalogue to be refused';
exception when insufficient_privilege then null;
end
$$;
do $$
begin
  perform public.platform_set_org_subscription(
    '51000000-0000-4000-8000-000000000001', 'business', 'active', 'monthly', 'tenant self-upgrade');
  raise exception 'expected a tenant subscription change to be refused';
exception when insufficient_privilege then null;
end
$$;

reset role;

-- Tenant B is on the plan the trigger gave it, and must see that rather than tenant A's. What
-- this assertion is actually about is ISOLATION -- A was moved to `pro` above -- so the expected
-- value is "whatever a new organisation is created on", read from 0210's own branch rather than
-- written out as a constant a second time.
select pg_temp.p51_as('61000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.p51_assert(
  (select plan_key from public.my_entitlements() limit 1) = :'p51_default_plan',
  'one tenant resolved to another tenant''s plan');
reset role;

-- ===== Capability, and step-up, on the money commands =====
select pg_temp.p51_as('61000000-0000-4000-8000-000000000004', true);
set local role authenticated;
do $$
begin
  perform public.platform_set_org_subscription(
    '51000000-0000-4000-8000-000000000001', 'business', 'active', 'monthly', 'support tries to upgrade');
  raise exception 'expected an operator without subscription.edit to be refused';
exception when insufficient_privilege then null;
end
$$;
select pg_temp.p51_assert(
  public.platform_org_subscription('51000000-0000-4000-8000-000000000001') is null,
  'an operator without billing.view read the subscription');
reset role;

-- The billing operator holds the capability but arrives without a fresh password.
select pg_temp.p51_as('61000000-0000-4000-8000-000000000003', false);
set local role authenticated;
do $$
begin
  perform public.platform_set_org_subscription(
    '51000000-0000-4000-8000-000000000001', 'business', 'active', 'monthly', 'no step-up');
  raise exception 'expected a subscription change without step-up to be refused';
exception when insufficient_privilege then null;
end
$$;
reset role;

-- ===== The full billing operator =====
select pg_temp.p51_as('61000000-0000-4000-8000-000000000003', true);
set local role authenticated;

do $$
begin
  perform public.platform_set_org_subscription(
    '51000000-0000-4000-8000-000000000001', 'business', 'active', 'monthly', '');
  raise exception 'expected a reasonless subscription change to be refused';
exception when invalid_parameter_value then null;
end
$$;

-- `legacy` holds who is already on it and takes nobody new: moving a customer onto it would be
-- inventing a history they do not have.
do $$
begin
  perform public.platform_set_org_subscription(
    '51000000-0000-4000-8000-000000000001', 'legacy', 'active', 'monthly', 'P51: park on legacy');
  raise exception 'expected a move onto an inactive plan to be refused';
exception when invalid_parameter_value then null;
end
$$;

select pg_temp.p51_assert(
  public.platform_set_org_subscription(
    '51000000-0000-4000-8000-000000000001', 'business', 'active', 'yearly',
    'P51: upgrade to business') ->> 'previous_plan_key' = 'pro',
  'the subscription change did not report the plan it replaced');
select pg_temp.p51_assert(
  public.platform_org_subscription('51000000-0000-4000-8000-000000000001') ->> 'plan_key' = 'business',
  'the subscription did not read back as business');

-- ===== The resolution rule =====
-- An override beats the plan.
select pg_temp.p51_assert(
  public.platform_grant_entitlement_override(
    '51000000-0000-4000-8000-000000000001', 'documents.monthly', false, 250, null, null,
    'P51: capped while an integration is investigated') ? 'override_id',
  'the entitlement override was not granted');
select pg_temp.p51_assert(
  (select numeric_limit from public.platform_org_entitlements('51000000-0000-4000-8000-000000000001')
    where entitlement_key = 'documents.monthly') = 250,
  'the live override did not beat the plan');
select pg_temp.p51_assert(
  (select source from public.platform_org_entitlements('51000000-0000-4000-8000-000000000001')
    where entitlement_key = 'documents.monthly') = 'override',
  'the resolution did not name the override as its source');

-- Replacing a concession is revoke-then-grant, never two live rows.
do $$
begin
  perform public.platform_grant_entitlement_override(
    '51000000-0000-4000-8000-000000000001', 'documents.monthly', true, null, null, null,
    'P51: second live override');
  raise exception 'expected a second live override to be refused';
exception when unique_violation then null;
end
$$;

do $$
declare v_id uuid;
begin
  select override_id into v_id
  from public.platform_org_entitlements('51000000-0000-4000-8000-000000000001')
  where entitlement_key = 'documents.monthly';
  perform public.platform_revoke_entitlement_override(v_id, 'P51: investigation closed');
end
$$;
select pg_temp.p51_assert(
  (select source from public.platform_org_entitlements('51000000-0000-4000-8000-000000000001')
    where entitlement_key = 'documents.monthly') = 'plan',
  'a revoked override still won over the plan');

-- An expired override stops applying without anybody revoking it.
select pg_temp.p51_assert(
  public.platform_grant_entitlement_override(
    '51000000-0000-4000-8000-000000000001', 'suppliers.max', false, 5,
    null, now() - interval '1 day', 'P51: already-expired concession') ? 'override_id',
  'the expiring override was not granted');
select pg_temp.p51_assert(
  (select source from public.platform_org_entitlements('51000000-0000-4000-8000-000000000001')
    where entitlement_key = 'suppliers.max') = 'plan',
  'an expired override was still in force');

reset role;

-- ===== An unstated limit is unknown, never infinity =====
-- The seeded catalogue is permissive; this is the state the owner's decision will produce for
-- every entitlement it does not cover, and wave 4 has to refuse it rather than wave it through.
update plan_entitlements set unlimited = false, numeric_limit = null
where plan_key = 'business' and entitlement_key = 'ocr_pages.monthly';

select pg_temp.p51_as('61000000-0000-4000-8000-000000000003', true);
set local role authenticated;
select pg_temp.p51_assert(
  (select measured from public.platform_org_entitlements('51000000-0000-4000-8000-000000000001')
    where entitlement_key = 'ocr_pages.monthly') = false,
  'a limit nobody stated reported itself as measured');
select pg_temp.p51_assert(
  (select unlimited from public.platform_org_entitlements('51000000-0000-4000-8000-000000000001')
    where entitlement_key = 'ocr_pages.monthly') = false
  and (select numeric_limit from public.platform_org_entitlements('51000000-0000-4000-8000-000000000001')
    where entitlement_key = 'ocr_pages.monthly') is null,
  'an unstated limit resolved to a number or to unlimited');

-- Every command left an auditable trace on the platform timeline, with a reason and an actor.
select pg_temp.p51_assert(
  (select count(*) from public.platform_customer_timeline('51000000-0000-4000-8000-000000000001')
    where action in ('subscription_set', 'entitlement_override_granted',
                     'entitlement_override_revoked')) >= 4,
  'the money commands did not reach the platform timeline');

-- org_id substitution: everything above was aimed at tenant A, and tenant B must be untouched.
select pg_temp.p51_assert(
  (select count(*) from public.platform_customer_timeline('51000000-0000-4000-8000-000000000002')) = 0,
  'a command aimed at one organization left a trace on another');

reset role;

select pg_temp.p51_as('61000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.p51_assert(
  (select plan_key from public.my_entitlements() limit 1) = :'p51_default_plan',
  'tenant B''s plan moved while tenant A was being edited');
reset role;

rollback;

\echo 'p51_plan_entitlements_passed'
