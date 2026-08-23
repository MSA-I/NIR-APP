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
select pg_temp.p51_assert(
  (select numeric_limit from plan_entitlements
    where plan_key = 'free' and entitlement_key = 'documents.monthly') = 25
  and (select numeric_limit from plan_entitlements
    where plan_key = 'pro' and entitlement_key = 'documents.monthly') = 300,
  'the decided monthly document limits moved without a decision');
select pg_temp.p51_assert(
  (select unlimited from plan_entitlements
    where plan_key = 'business' and entitlement_key = 'documents.monthly')
  and (select unlimited from plan_entitlements
    where plan_key = 'legacy' and entitlement_key = 'documents.monthly'),
  'a limit was applied to a plan that promises none');
-- The two rungs that existed before the launch ladder keep the 0163 derivation: page quota =
-- document quota times the hard 20-page-per-document ceiling the worker enforces. #197 decides a
-- commercial ratio of TEN for the launch catalogue, but every remaining #197 figure for `free` and
-- `pro` is a REDUCTION, and no decision states when a reduced quota reaches an organization already
-- on the plan -- so 0184 records those three figures and deliberately does not apply them. Pinning
-- the live values here is what stops a later edit applying a reduction by accident.
select pg_temp.p51_assert(
  (select numeric_limit from plan_entitlements
    where plan_key = 'free' and entitlement_key = 'ocr_pages.monthly') = 25 * 20
  and (select numeric_limit from plan_entitlements
    where plan_key = 'pro' and entitlement_key = 'ocr_pages.monthly') = 300 * 20,
  'the page quotas of the pre-launch rungs moved without a decision on reduction timing');
-- The launch rungs are new, hold nobody, and therefore land at the decided #197 ratio of ten.
select pg_temp.p51_assert(
  (select numeric_limit from plan_entitlements
    where plan_key = 'basic' and entitlement_key = 'documents.monthly') = 50
  and (select numeric_limit from plan_entitlements
    where plan_key = 'basic' and entitlement_key = 'ocr_pages.monthly') = 50 * 10
  and (select numeric_limit from plan_entitlements
    where plan_key = 'premium' and entitlement_key = 'documents.monthly') = 500
  and (select numeric_limit from plan_entitlements
    where plan_key = 'premium' and entitlement_key = 'ocr_pages.monthly') = 500 * 10,
  'the launch rungs are not at the volumes #197 decided for them');
-- Every decided figure is on record whether or not it is live, and every withheld one carries the
-- reason it was withheld. A decision dropped on the floor reads exactly like one nobody took.
select pg_temp.p51_assert(
  (select count(*) from private.plan_quota_decisions) = 8
  and not exists (
    select 1 from private.plan_quota_decisions
    where not applied and nullif(btrim(coalesce(withheld_reason, '')), '') is null),
  'a #197 figure is missing from the record or was withheld without a stated reason');
select pg_temp.p51_assert(
  (select unlimited from plan_entitlements
    where plan_key = 'business' and entitlement_key = 'ocr_pages.monthly')
  and (select unlimited from plan_entitlements
    where plan_key = 'legacy' and entitlement_key = 'ocr_pages.monthly'),
  'a page quota was applied to a plan that limits no documents');
-- The pin below was one assertion until 0164 introduced a metric whose limit nobody has decided
-- yet. Splitting it keeps both teeth rather than blunting one: a STATED number outside the two
-- decided limits still fails, and the unknown-that-refuses state is pinned to exactly the one key
-- allowed to hold it. A single relaxed assertion would have let any future metric ship as
-- "unknown" and read as green.
select pg_temp.p51_assert(
  not exists (
    select 1 from plan_entitlements
    where entitlement_key not in ('documents.monthly', 'ocr_pages.monthly')
      and ((kind = 'numeric' and not unlimited and numeric_limit is not null)
        or (kind = 'boolean' and boolean_value is not true))),
  'an entitlement beyond the two decided limits became restrictive without a decision');
select pg_temp.p51_assert(
  not exists (
    select 1 from plan_entitlements
    where entitlement_key <> 'assistant_runs.monthly'
      and kind = 'numeric' and not unlimited and numeric_limit is null),
  'an entitlement beyond the assistant run quota entered the unknown-that-refuses state without a decision');

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

-- Organizations created after 0154 land on `free` through the default-subscription trigger, not
-- through the one-time backfill. Proving that here is the whole reason wave 4 will not refuse
-- every customer who signs up tomorrow.
select pg_temp.p51_assert(
  (select plan_key from organization_subscriptions
    where org_id = '51000000-0000-4000-8000-000000000002') = 'free',
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

-- Tenant B is on the untouched backfill plan, and must see that rather than tenant A's.
select pg_temp.p51_as('61000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.p51_assert(
  (select plan_key from public.my_entitlements() limit 1) = 'free',
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
  (select plan_key from public.my_entitlements() limit 1) = 'free',
  'tenant B''s plan moved while tenant A was being edited');
reset role;

rollback;

\echo 'p51_plan_entitlements_passed'
