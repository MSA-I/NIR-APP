-- P79 -- #274/#276: plan capabilities are monotonic and consumed by server gates; Free receives
-- Basic capabilities for the one existing 30-day introduction, then falls back without deleting
-- data. #295 keeps display currency separate from verified billing currency.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p79_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P79 plan capability assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p79_as(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    case when p_user is null then '{}'::text
      else jsonb_build_object('sub', p_user, 'role', 'authenticated')::text end,
    true);
end
$$;

-- ===== 1. Catalogue facts =====

select pg_temp.p79_assert(
  (select count(*) from public.get_public_plan_features()) = 44,
  'the four public plans do not each expose the eleven decided feature rows');

select pg_temp.p79_assert(
  not exists (select 1 from public.get_public_plan_features() where plan_key = 'business'),
  'Business leaked into the public catalogue');

select pg_temp.p79_assert(
  (select not included and intro_included from public.get_public_plan_features()
   where plan_key = 'free' and entitlement_key = 'documents.automation')
  and (select included from public.get_public_plan_features()
       where plan_key = 'basic' and entitlement_key = 'documents.automation')
  and (select included from public.get_public_plan_features()
       where plan_key = 'pro' and entitlement_key = 'bank.reconciliation')
  and (select included from public.get_public_plan_features()
       where plan_key = 'premium' and entitlement_key = 'integrations.api'),
  'the capability steps do not match #274/#276');

select pg_temp.p79_assert(
  not exists (
    select 1
    from public.plan_entitlements lower_entitlement
    join public.subscription_plans lower_plan on lower_plan.plan_key = lower_entitlement.plan_key
    join public.plan_entitlements upper_entitlement
      on upper_entitlement.entitlement_key = lower_entitlement.entitlement_key
     and upper_entitlement.kind = 'boolean'
    join public.subscription_plans upper_plan on upper_plan.plan_key = upper_entitlement.plan_key
    where lower_entitlement.kind = 'boolean'
      and lower_plan.active and upper_plan.active
      and lower_plan.tier_order < upper_plan.tier_order
      and lower_entitlement.boolean_value
      and not upper_entitlement.boolean_value),
  'a higher rung removes a capability held below it');

-- THE SEAT COLUMN IS `basic = 1`, AND THAT IS A LATER RULING, NOT DRIFT. `0246` wrote #274's
-- 1/5/15/30 and this assertion pinned them. On 28.08.2026 the owner moved `basic` to one member --
-- "ההכרעה האחרונה גוברת" -- and `0252` applies it (#298), so adding a user is what `פרו` opens.
-- The two numbers above `basic` were not contradicted and are unchanged, and the branch and
-- automatic-document columns are #274's throughout. This suite states the ladder the database
-- actually ends up with; the earlier figures live in `0246` and in #274.
select pg_temp.p79_assert(
  (select count(*) from (values
    ('free', 1::numeric, 1::numeric, 5::numeric),
    ('basic', 1::numeric, 1::numeric, 40::numeric),
    ('pro', 15::numeric, 1::numeric, 150::numeric),
    ('premium', 30::numeric, 10::numeric, 375::numeric)
  ) expected(plan_key, users_max, branches_max, auto_max)
  join public.plan_entitlements users_row
    on users_row.plan_key = expected.plan_key and users_row.entitlement_key = 'users.max'
   and users_row.numeric_limit = expected.users_max and not users_row.unlimited
  join public.plan_entitlements branches_row
    on branches_row.plan_key = expected.plan_key and branches_row.entitlement_key = 'branches.max'
   and branches_row.numeric_limit = expected.branches_max and not branches_row.unlimited
  join public.plan_entitlements automatic_row
    on automatic_row.plan_key = expected.plan_key
   and automatic_row.entitlement_key = 'documents.automatic_monthly'
   and automatic_row.numeric_limit = expected.auto_max and not automatic_row.unlimited) = 4,
  'the enforced user, branch or automatic-document limits drifted');

-- Both display catalogues stay available to the authenticated application. No Business figure
-- exists, and this read does not alter the verified billing currency in my_subscription().
select pg_temp.p79_assert(
  (select count(*) from public.get_public_plan_catalogue()) = 8
  and (select count(distinct currency) from public.get_public_plan_catalogue()) = 2,
  'the authenticated display cannot read both ILS and USD catalogues');

-- ===== 2. One 30-day clock =====

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-4000-8000-000000000791', 'p79-intro@example.test', now()),
  ('00000000-0000-4000-8000-000000000792', 'p79-expired@example.test', now()),
  ('00000000-0000-4000-8000-000000000793', 'p79-extra@example.test', now());

insert into public.organizations (id, name, created_at) values
  ('00000000-0000-4000-8000-000000000791', 'P79 intro', now()),
  ('00000000-0000-4000-8000-000000000792', 'P79 expired', now() - interval '31 days');

update public.organization_subscriptions set plan_key = 'free', granted_until = null
where org_id in (
  '00000000-0000-4000-8000-000000000791',
  '00000000-0000-4000-8000-000000000792');

insert into private.assistant_intro_windows (org_id, started_at, source) values
  ('00000000-0000-4000-8000-000000000791', now(), 'owner_email_confirmed'),
  ('00000000-0000-4000-8000-000000000792', now() - interval '31 days', 'owner_email_confirmed');

insert into public.profiles (id, org_id, full_name, role, active) values
  ('00000000-0000-4000-8000-000000000791', '00000000-0000-4000-8000-000000000791', 'P79 intro', 'owner', true),
  ('00000000-0000-4000-8000-000000000792', '00000000-0000-4000-8000-000000000792', 'P79 expired', 'owner', true);

select pg_temp.p79_assert(
  (public.effective_entitlement(
    '00000000-0000-4000-8000-000000000791', 'documents.automation') ->> 'source') = 'intro'
  and (public.effective_entitlement(
    '00000000-0000-4000-8000-000000000791', 'documents.automation') ->> 'value')::boolean
  and (public.effective_entitlement(
    '00000000-0000-4000-8000-000000000791', 'documents.automatic_monthly') ->> 'limit')::numeric = 20,
  'the introduction does not open Basic automation over all twenty Free documents');

select pg_temp.p79_assert(
  not (public.effective_entitlement(
    '00000000-0000-4000-8000-000000000791', 'bank.reconciliation') ->> 'value')::boolean,
  'the introduction leaked a Pro capability');

select pg_temp.p79_assert(
  not (public.effective_entitlement(
    '00000000-0000-4000-8000-000000000792', 'documents.automation') ->> 'value')::boolean
  and (public.effective_entitlement(
    '00000000-0000-4000-8000-000000000792', 'documents.automatic_monthly') ->> 'limit')::numeric = 5,
  'an expired introduction did not fall back to the Free contract');

-- ===== 3. Measured limits and Data API refusal =====

do $$
begin
  begin
    insert into public.profiles (id, org_id, full_name, role, active) values
      ('00000000-0000-4000-8000-000000000793',
       '00000000-0000-4000-8000-000000000792', 'P79 extra', 'office', true);
    raise exception 'P79 expected plan_user_limit_reached';
  exception when others then
    if sqlerrm not like '%plan_user_limit_reached%' then raise; end if;
  end;
end
$$;

do $$
declare v_root uuid;
begin
  select id into v_root from public.org_units
  where org_id = '00000000-0000-4000-8000-000000000792' and unit_type = 'root';
  begin
    insert into public.org_units (org_id, parent_id, unit_type, name)
    values ('00000000-0000-4000-8000-000000000792', v_root, 'branch', 'Second branch');
    raise exception 'P79 expected plan_branch_limit_reached';
  exception when others then
    if sqlerrm not like '%plan_branch_limit_reached%' then raise; end if;
  end;
end
$$;

select pg_temp.p79_as('00000000-0000-4000-8000-000000000792');
select set_config('request.path', 'bank_imports', true);
select set_config('request.method', 'GET', true);
do $$
begin
  begin
    perform public.check_plan_request();
    raise exception 'P79 expected plan_capability_required';
  exception when others then
    if sqlerrm not like '%plan_capability_required:bank.reconciliation%' then raise; end if;
  end;
end
$$;

update public.organization_subscriptions set plan_key = 'pro'
where org_id = '00000000-0000-4000-8000-000000000792';
select public.check_plan_request();

select pg_temp.p79_assert(
  exists (
    select 1 from pg_catalog.pg_proc
    where oid = pg_catalog.to_regprocedure('private.claim_document_interpretation_jobs(integer,integer)')
      and prosrc like '%documents.automatic_monthly%'
      and prosrc like '%record_usage_event%'),
  'automatic interpretation has no quota consumer');

rollback;

\echo 'p79_plan_capability_ladder_passed'
