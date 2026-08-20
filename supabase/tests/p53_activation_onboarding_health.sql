-- P53 -- Activation is derived from evidence, onboarding lets evidence overrule an operator, and
-- health is a list of reasons rather than a score (0156).
\set ON_ERROR_STOP on

begin;

create function pg_temp.p53_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P53 activation assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p53_as(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_user, 'amr', '[]'::jsonb)::text, true);
end
$$;

-- ===== Structural claims =====
-- `not_started` must stay the absence of a decision. A stored row saying "not started" looks like
-- somebody assessed the step, and nobody did.
select pg_temp.p53_assert(
  not exists (
    select 1 from pg_constraint
    where conrelid = 'public.customer_onboarding_steps'::regclass
      and pg_get_constraintdef(oid) like '%not_started%'),
  'not_started became a storable onboarding state');

select pg_temp.p53_assert(
  not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'customer_onboarding_steps'
      and grantee in ('anon', 'authenticated')),
  'a browser role holds a grant on the onboarding table');

-- ===== Fixture =====
insert into public.organizations (id, name, status, created_at) values
  ('53000000-0000-4000-8000-000000000001', 'P53 established', 'active', now() - interval '60 days'),
  ('53000000-0000-4000-8000-000000000002', 'P53 brand new',   'active', now() - interval '2 days');

insert into auth.users (id, email) values
  ('63000000-0000-4000-8000-000000000001', 'owner-p53@example.test'),
  ('63000000-0000-4000-8000-000000000002', 'ops-p53@example.test'),
  ('63000000-0000-4000-8000-000000000003', 'analyst-p53@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('63000000-0000-4000-8000-000000000001', '53000000-0000-4000-8000-000000000001', 'P53 owner', 'owner');

insert into public.platform_admins (user_id, note) values
  ('63000000-0000-4000-8000-000000000002', 'P53 customer ops'),
  ('63000000-0000-4000-8000-000000000003', 'P53 analyst');
insert into public.platform_admin_roles (user_id, role_key) values
  ('63000000-0000-4000-8000-000000000002', 'customer_ops'),
  ('63000000-0000-4000-8000-000000000003', 'analyst');

-- ===== A tenant reaches none of it =====
select pg_temp.p53_as('63000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.p53_assert(
  (select count(*) from public.platform_customer_activation('53000000-0000-4000-8000-000000000001')) = 0
  and (select count(*) from public.platform_customer_onboarding('53000000-0000-4000-8000-000000000001')) = 0
  and public.platform_customer_health('53000000-0000-4000-8000-000000000001') is null,
  'a tenant owner read the operator activation, onboarding or health views');
do $$
begin
  perform public.platform_set_onboarding_step(
    '53000000-0000-4000-8000-000000000001', 'team_invited', 'completed', 'tenant self-assessment');
  raise exception 'expected a tenant onboarding write to be refused';
exception when insufficient_privilege then null;
end
$$;
reset role;

-- ===== Activation is derived, and says what it cannot measure =====
select pg_temp.p53_as('63000000-0000-4000-8000-000000000002');
set local role authenticated;

select pg_temp.p53_assert(
  (select achieved_at from public.platform_customer_activation('53000000-0000-4000-8000-000000000001')
    where milestone_key = 'organization_created') is not null,
  'the organization creation milestone was not resolved');
select pg_temp.p53_assert(
  (select achieved_at from public.platform_customer_activation('53000000-0000-4000-8000-000000000001')
    where milestone_key = 'first_supplier') is null,
  'a supplier milestone was reported before any supplier existed');

-- Two milestones have no readable evidence in this schema. They must report themselves as not
-- measured, so a reader never treats "we cannot see it" as "the customer has not done it".
select pg_temp.p53_assert(
  (select count(*) from public.platform_customer_activation('53000000-0000-4000-8000-000000000001')
    where not measured and source = 'unavailable') = 2,
  'the unmeasurable milestones did not declare themselves unmeasured');

reset role;

-- A real supplier, so the audit trigger writes the ledger row the derivation reads. This is the
-- whole chain: product write -> audit ledger -> derived milestone, with nothing accumulated.
select pg_temp.p53_as('63000000-0000-4000-8000-000000000001');
insert into public.suppliers (org_id, name, status)
values ('53000000-0000-4000-8000-000000000001', 'ספק בדיקה P53', 'active');

select pg_temp.p53_as('63000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.p53_assert(
  (select achieved_at from public.platform_customer_activation('53000000-0000-4000-8000-000000000001')
    where milestone_key = 'first_supplier') is not null,
  'creating a supplier did not resolve the milestone through the audit ledger');
select pg_temp.p53_assert(
  (select source from public.platform_customer_activation('53000000-0000-4000-8000-000000000001')
    where milestone_key = 'first_supplier') = 'audit_ledger',
  'the milestone did not name the ledger as its source');
reset role;

-- ===== Onboarding: evidence overrules the operator, and fills the silence otherwise =====
select pg_temp.p53_as('63000000-0000-4000-8000-000000000002');
set local role authenticated;

-- The step whose milestone already happened is complete no matter what is recorded against it.
select pg_temp.p53_assert(
  public.platform_set_onboarding_step(
    '53000000-0000-4000-8000-000000000001', 'suppliers_imported', 'skipped',
    'P53: operator wrongly marks a step the customer already did') ? 'step_key',
  'the onboarding record was not written');
select pg_temp.p53_assert(
  (select state from public.platform_customer_onboarding('53000000-0000-4000-8000-000000000001')
    where step_key = 'suppliers_imported') = 'completed',
  'an operator note overruled a product event that actually happened');
select pg_temp.p53_assert(
  (select source from public.platform_customer_onboarding('53000000-0000-4000-8000-000000000001')
    where step_key = 'suppliers_imported') = 'product_event',
  'a completed step did not name the product event as its source');

-- A step with no milestone is exactly where an operator's word is the only evidence there is.
select pg_temp.p53_assert(
  public.platform_set_onboarding_step(
    '53000000-0000-4000-8000-000000000001', 'team_invited', 'skipped',
    'P53: the owner works alone') ? 'step_key',
  'the operator-only onboarding step was not recorded');
select pg_temp.p53_assert(
  (select state from public.platform_customer_onboarding('53000000-0000-4000-8000-000000000001')
    where step_key = 'team_invited') = 'skipped'
  and (select source from public.platform_customer_onboarding('53000000-0000-4000-8000-000000000001')
    where step_key = 'team_invited') = 'operator_manual',
  'the operator record did not fill the step that has no product evidence');

-- A step with neither evidence nor an operator record is `not_started` and stores nothing.
select pg_temp.p53_assert(
  (select state from public.platform_customer_onboarding('53000000-0000-4000-8000-000000000001')
    where step_key = 'accounting_setup') = 'not_started',
  'an untouched step reported something other than not_started');
-- Asserted through the read door rather than the table: `authenticated` holds no grant on
-- customer_onboarding_steps at all, and a suite that reaches around the boundary it is testing
-- proves the wrong thing. An untouched step carries no recorder and no timestamp.
select pg_temp.p53_assert(
  (select recorded_at from public.platform_customer_onboarding('53000000-0000-4000-8000-000000000001')
    where step_key = 'accounting_setup') is null
  and (select recorded_by_email from public.platform_customer_onboarding('53000000-0000-4000-8000-000000000001')
    where step_key = 'accounting_setup') is null,
  'an untouched step carries an operator record');

do $$
begin
  perform public.platform_set_onboarding_step(
    '53000000-0000-4000-8000-000000000001', 'team_invited', 'skipped', '');
  raise exception 'expected a reasonless onboarding record to be refused';
exception when invalid_parameter_value then null;
end
$$;
do $$
begin
  perform public.platform_set_onboarding_step(
    '53000000-0000-4000-8000-000000000001', 'no_such_step', 'skipped', 'P53');
  raise exception 'expected an unknown onboarding step to be refused';
exception when no_data_found then null;
end
$$;

reset role;

-- An analyst holds customer.view but not onboarding.edit: they may read, not assess.
select pg_temp.p53_as('63000000-0000-4000-8000-000000000003');
set local role authenticated;
select pg_temp.p53_assert(
  (select count(*) from public.platform_customer_onboarding('53000000-0000-4000-8000-000000000001')) > 0,
  'an analyst with customer.view could not read onboarding');
do $$
begin
  perform public.platform_set_onboarding_step(
    '53000000-0000-4000-8000-000000000001', 'accounting_setup', 'completed', 'analyst assesses');
  raise exception 'expected an operator without onboarding.edit to be refused';
exception when insufficient_privilege then null;
end
$$;
reset role;

-- ===== Health is reasons, not a score =====
select pg_temp.p53_as('63000000-0000-4000-8000-000000000002');
set local role authenticated;

-- A two-day-old organization that has done nothing is UNKNOWN. Calling it healthy would be a
-- claim; calling it at risk would be a different one, and both would be invented.
select pg_temp.p53_assert(
  public.platform_customer_health('53000000-0000-4000-8000-000000000002') ->> 'status' = 'unknown',
  'a brand-new silent customer was judged rather than reported as unknown');

select pg_temp.p53_assert(
  jsonb_typeof(public.platform_customer_health('53000000-0000-4000-8000-000000000001') -> 'signals')
    = 'array',
  'health did not return the signals that produced it');
select pg_temp.p53_assert(
  not (public.platform_customer_health('53000000-0000-4000-8000-000000000001') ? 'score')
  and not (public.platform_customer_health('53000000-0000-4000-8000-000000000001') ? 'churn_risk'),
  'health grew a score or a prediction');

-- Every signal carries a code, a severity and a human sentence: a status with an unexplainable
-- reason behind it is the mysterious score this design refuses.
select pg_temp.p53_assert(
  not exists (
    select 1 from jsonb_array_elements(
      public.platform_customer_health('53000000-0000-4000-8000-000000000001') -> 'signals') signal
    where signal ->> 'code' is null or signal ->> 'severity' is null
       or btrim(coalesce(signal ->> 'detail', '')) = ''),
  'a health signal is missing its code, severity or explanation');

-- An alert-severity signal must produce `at_risk`, not a softer word.
reset role;
update organization_subscriptions set status = 'past_due'
where org_id = '53000000-0000-4000-8000-000000000001';
select pg_temp.p53_as('63000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.p53_assert(
  public.platform_customer_health('53000000-0000-4000-8000-000000000001') ->> 'status' = 'at_risk',
  'a past-due subscription did not put the customer at risk');
select pg_temp.p53_assert(
  exists (
    select 1 from jsonb_array_elements(
      public.platform_customer_health('53000000-0000-4000-8000-000000000001') -> 'signals') signal
    where signal ->> 'code' = 'billing_past_due'),
  'the at-risk status did not name the billing signal that caused it');

-- ===== The two new attention filters =====
select pg_temp.p53_assert(
  (select count(*) from public.platform_customers(p_search => 'P53', p_attention => 'onboarding_stalled'))
    >= 1,
  'the onboarding_stalled filter found no stalled customer');
select pg_temp.p53_assert(
  not exists (
    select 1 from public.platform_customers(p_search => 'P53 brand new', p_attention => 'onboarding_stalled')),
  'a two-day-old customer was called stalled');
do $$
begin
  perform public.platform_customers(p_search => 'P53', p_attention => 'nonsense');
  raise exception 'expected an unknown attention filter to be rejected';
exception when invalid_parameter_value then null;
end
$$;

reset role;
rollback;

\echo 'p53_activation_onboarding_health_passed'
