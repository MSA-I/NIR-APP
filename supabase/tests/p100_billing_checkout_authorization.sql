-- P100 -- who may start a payment, what the server chooses for them, and the one write that makes
-- a later provider event attributable (0277/0278, on the 0154/0157/0187 contracts;
-- owner decisions #165, #201, #204, #208, #216, #217, #219).
--
-- P71 proves what a VERIFIED EVENT is allowed to do. This suite proves the other direction: what a
-- SIGNED-IN PERSON is allowed to start. The two meet at one table -- private.billing_provider_price_map
-- decides both what a checkout sells and what an activation grants -- and the assertion that the
-- same row answers both questions is the reason "paid for Pro, received Pro" is structural here
-- rather than a coincidence between two lookups.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p100_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P100 billing checkout assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p100_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_user, 'amr', '[]'::jsonb)::text, true);
end
$$;

create function pg_temp.p100_as_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
end
$$;

-- ===== Fixtures: two tenants, so isolation is a thing this suite can actually test =====
insert into organizations (id, name, status) values
  ('c1000000-0000-4000-8000-000000000001', 'P100 tenant A', 'active'),
  ('c1000000-0000-4000-8000-000000000002', 'P100 tenant B', 'active');

insert into auth.users (id, email) values
  ('c2000000-0000-4000-8000-00000000000a', 'p100-owner-a@example.test'),
  ('c2000000-0000-4000-8000-00000000000b', 'p100-owner-b@example.test'),
  ('c2000000-0000-4000-8000-00000000000c', 'p100-office-a@example.test');

insert into profiles (id, org_id, role, full_name, active) values
  ('c2000000-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-000000000001', 'owner',  'P100 owner A',  true),
  ('c2000000-0000-4000-8000-00000000000b', 'c1000000-0000-4000-8000-000000000002', 'owner',  'P100 owner B',  true),
  ('c2000000-0000-4000-8000-00000000000c', 'c1000000-0000-4000-8000-000000000001', 'office', 'P100 office A', true);

-- The rung each tenant starts on, whatever it is. Read once, compared at the end.
create table pg_temp.p100_plan_before as
  select org_id, plan_key from organization_subscriptions
  where org_id in ('c1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002');

-- ===== 1. While no merchant of record is enabled, nobody can be charged =====
-- This is the gate that did not exist before 0278 and is the one most worth pinning: 0187 already
-- made a shut provider's EVENTS inert, but a checkout that still opened would take a customer's
-- money for an entitlement the platform would then refuse to grant.
select pg_temp.p100_as('c2000000-0000-4000-8000-00000000000a');
select pg_temp.p100_assert(
  (public.authorize_billing_checkout('pro', 'monthly') ->> 'reason_code') = 'provider_not_enabled'
  and not (public.authorize_billing_checkout('pro', 'monthly') -> 'allowed')::boolean,
  'a checkout was authorized while no merchant of record is enabled');
select pg_temp.p100_assert(
  (public.authorize_billing_management() ->> 'reason_code') = 'provider_not_enabled',
  'subscription management was authorized while no merchant of record is enabled');

-- From here the provider is enabled INSIDE this transaction only, exactly as p71 does it. Nothing
-- outside this rollback ever sees an enabled provider.
update private.billing_provider_boundary
   set enabled = true, enabled_at = now(),
       enabled_by = 'c2000000-0000-4000-8000-00000000000a',
       enable_reason = 'P100 proves the checkout authorization; rolled back with this transaction'
 where provider = 'paddle';

-- ===== 2. Role: an owner may buy, and nobody else may =====
select pg_temp.p100_as('c2000000-0000-4000-8000-00000000000c');
select pg_temp.p100_assert(
  (public.authorize_billing_checkout('pro', 'monthly') ->> 'reason_code') = 'not_authorized',
  'a non-owner was authorized to start a payment');

select pg_temp.p100_as(null);
select pg_temp.p100_assert(
  not (public.authorize_billing_checkout('pro', 'monthly') -> 'allowed')::boolean,
  'a caller with no organization was authorized to start a payment');

-- ===== 3. The server chooses the price, and it is the SAME row a grant reads =====
select pg_temp.p100_as('c2000000-0000-4000-8000-00000000000a');
do $$
declare
  v_result jsonb := public.authorize_billing_checkout('pro', 'monthly');
  v_mapped text;
begin
  perform pg_temp.p100_assert((v_result -> 'allowed')::boolean,
    format('an owner was refused a mapped rung: %s', v_result ->> 'reason_code'));
  perform pg_temp.p100_assert(v_result ->> 'org_id' = 'c1000000-0000-4000-8000-000000000001',
    'the authorization named an organization other than the caller''s own');

  -- THE JOIN THAT MATTERS. The price handed to a checkout must be the price that, arriving back on
  -- a signed event, grants this same rung. One table answering both is what makes that structural.
  select map.plan_key into v_mapped from private.billing_provider_price_map map
  where map.provider = 'paddle' and map.provider_price_id = v_result ->> 'provider_price_id';
  perform pg_temp.p100_assert(v_mapped = 'pro',
    format('the price sold for pro grants %L on the way back', v_mapped));
end
$$;

-- #165/#201: neither rung is purchasable, and both refuse with the SAME code as a misspelling, so
-- a caller cannot enumerate the catalogue by reading the differences between refusals.
select pg_temp.p100_assert(
  (public.authorize_billing_checkout('business', 'monthly') ->> 'reason_code') = 'price_unmapped'
  and (public.authorize_billing_checkout('free', 'monthly') ->> 'reason_code') = 'price_unmapped'
  and (public.authorize_billing_checkout('nonesuch', 'monthly') ->> 'reason_code') = 'price_unmapped',
  'business, free and a misspelled rung do not all refuse identically');

select pg_temp.p100_assert(
  (public.authorize_billing_checkout('pro', 'weekly') ->> 'reason_code') = 'interval_unrecognized',
  'an interval the plan model does not sell was accepted');

-- ===== 4. The attribution link =====
select pg_temp.p100_as_service();
select pg_temp.p100_assert(
  (public.service_link_billing_customer(
    'c1000000-0000-4000-8000-000000000001', 'paddle', 'ctm_p100_a') ->> 'changed')::boolean,
  'linking a provider customer did not write');
select pg_temp.p100_assert(
  (select provider_customer_id from organization_subscriptions
    where org_id = 'c1000000-0000-4000-8000-000000000001') = 'ctm_p100_a',
  'the provider customer link is not readable where 0157 attributes from');

-- Idempotent on an identical value: a customer who abandons a checkout and returns must not churn
-- the link every future event depends on.
select pg_temp.p100_assert(
  (public.service_link_billing_customer(
    'c1000000-0000-4000-8000-000000000001', 'paddle', 'ctm_p100_a') ->> 'idempotent')::boolean,
  'relinking the same provider customer was not idempotent');

-- Re-pointing at a SECOND customer is refused. Every event still in flight for the first would
-- otherwise arrive, fail to resolve and dead-letter as unattributable -- which is indistinguishable
-- from an attack after the fact.
do $$
begin
  perform public.service_link_billing_customer(
    'c1000000-0000-4000-8000-000000000001', 'paddle', 'ctm_p100_second');
  raise exception 'P100: an organization was re-pointed at a second provider customer';
exception when unique_violation then null;
end
$$;

-- ===== 5. TENANT ISOLATION: org B cannot claim org A's provider customer =====
-- If it could, every one of A's future payments would attribute to B. This is the same property
-- p71 proves from the event side, asserted here from the side that WRITES the link.
do $$
begin
  perform public.service_link_billing_customer(
    'c1000000-0000-4000-8000-000000000002', 'paddle', 'ctm_p100_a');
  raise exception 'P100: one organization claimed another organization''s provider customer';
exception when unique_violation then null;
end
$$;
select pg_temp.p100_assert(
  (select provider_customer_id from organization_subscriptions
    where org_id = 'c1000000-0000-4000-8000-000000000002') is null,
  'the refused claim still wrote a link onto the bystander');

-- And a tenant owner cannot reach the link writer at all.
select pg_temp.p100_assert(
  not has_function_privilege('authenticated',
    'public.service_link_billing_customer(uuid,text,text)', 'EXECUTE'),
  'a browser role can write the provider-customer attribution link');

-- ===== 6. NOT COVERED HERE, and named rather than quietly skipped =====
-- `authorize_billing_checkout` refuses a suspended or offboarding organization with
-- `organization_not_active`, and this suite does NOT exercise that branch. It cannot: a suspended
-- tenant cannot be built inside a transaction, because private.organization_row_write_guard()
-- refuses the seeding triggers that fire for a read-only organization -- on the update path AND on
-- the insert path. That guard is correct and worth more than this assertion, so the branch is left
-- to the organization-lifecycle suites that own that machinery, and the gap is written down here
-- instead of being papered over by disabling a trigger.

-- ===== 7. Neither authorization can be aimed, and neither grants anything =====
select pg_temp.p100_assert(
  (select pronargs from pg_proc
    where oid = to_regprocedure('public.authorize_billing_checkout(text,text)')) = 2
  and (select pronargs from pg_proc
    where oid = to_regprocedure('public.authorize_billing_management()')) = 0,
  'a billing authorization function grew a parameter it could be aimed with');

-- The plan is untouched by everything above: authorizing a purchase is not making one, and
-- entitlement moves only on a verified provider event (#217).
--
-- BEFORE-AND-AFTER, NOT A LITERAL. The first draft asserted `= 'free'` and failed -- correctly, and
-- on the test's assumption rather than on the code. `0210` puts every new organization on `premium`
-- for the pre-launch window, so a suite that hardcodes the rung it expects is really asserting that
-- the grant has not shipped. What this file has standing to claim is that NOTHING IT DID moved the
-- plan, whatever the plan happens to be.
select pg_temp.p100_assert(
  (select plan_key from organization_subscriptions
    where org_id = 'c1000000-0000-4000-8000-000000000001')
  = (select plan_key from pg_temp.p100_plan_before
      where org_id = 'c1000000-0000-4000-8000-000000000001'),
  'authorizing a checkout changed a plan');

-- ===== 8. The catalogue mapping 0277 seeded is complete and unambiguous =====
select pg_temp.p100_assert(
  (select count(*) from private.billing_provider_price_map
    where provider = 'paddle' and environment = 'sandbox') = 6,
  'the sandbox price map is not the three purchasable rungs times two intervals');
select pg_temp.p100_assert(
  not exists (select 1 from private.billing_provider_price_map
              where provider = 'paddle' and plan_key in ('free', 'business')),
  'free or business was given a provider price');
select pg_temp.p100_assert(
  not exists (select 1 from private.billing_provider_price_map
              where provider = 'paddle' and environment = 'sandbox'
              group by plan_key, billing_interval having count(*) > 1),
  'a rung and interval maps to more than one provider price');

rollback;
