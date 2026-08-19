-- P54 -- A provider event is attributed only through a link we wrote ourselves, a replay is a
-- no-op, an unattributable event dead-letters instead of guessing, and the funnel says which of
-- its stages it cannot see (0157, 0158).
\set ON_ERROR_STOP on

begin;

create function pg_temp.p54_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P54 billing boundary assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p54_as(p_user uuid, p_fresh_password boolean default false)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_user,
      'amr', case when p_fresh_password then jsonb_build_array(jsonb_build_object(
        'method', 'password', 'timestamp', extract(epoch from clock_timestamp())
      )) else '[]'::jsonb end)::text, true);
end
$$;

create function pg_temp.p54_as_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
end
$$;

-- ===== Structural claims =====
select pg_temp.p54_assert(
  not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'private'
      and table_name in ('billing_events', 'product_events', 'product_event_definitions')
      and grantee in ('anon', 'authenticated', 'service_role')),
  'a role holds a direct grant on the billing or product event ledger');

-- The attribution function must not be able to see the payload even by accident.
select pg_temp.p54_assert(
  (select pronargs from pg_proc where oid = to_regprocedure('private.resolve_billing_org(text,text)')) = 2,
  'resolve_billing_org changed shape -- attribution must not receive the payload');

-- ===== Fixture =====
insert into public.organizations (id, name, status, created_at) values
  ('54000000-0000-4000-8000-000000000001', 'P54 linked',   'active', now() - interval '40 days'),
  ('54000000-0000-4000-8000-000000000002', 'P54 unlinked', 'active', now() - interval '30 days');

insert into auth.users (id, email) values
  ('64000000-0000-4000-8000-000000000001', 'owner-p54@example.test'),
  ('64000000-0000-4000-8000-000000000002', 'billing-p54@example.test'),
  ('64000000-0000-4000-8000-000000000003', 'support-p54@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('64000000-0000-4000-8000-000000000001', '54000000-0000-4000-8000-000000000001', 'P54 owner', 'owner');

insert into public.platform_admins (user_id, note) values
  ('64000000-0000-4000-8000-000000000002', 'P54 billing operator'),
  ('64000000-0000-4000-8000-000000000003', 'P54 support operator');
insert into public.platform_admin_roles (user_id, role_key) values
  ('64000000-0000-4000-8000-000000000002', 'billing'),
  ('64000000-0000-4000-8000-000000000003', 'support');

-- The link WE wrote. This, and only this, is what attribution may consult.
update organization_subscriptions
   set provider = 'manual', provider_customer_id = 'cus_p54_linked'
 where org_id = '54000000-0000-4000-8000-000000000001';

-- ===== Ingestion is service_role only =====
select pg_temp.p54_as('64000000-0000-4000-8000-000000000002', true);
set local role authenticated;
do $$
begin
  perform public.service_record_billing_event(
    'manual', 'evt_from_browser', 'invoice.paid', 'cus_p54_linked', '{}'::jsonb);
  raise exception 'expected a user JWT to be refused at the billing ingestion door';
exception when insufficient_privilege then null;
end
$$;
reset role;

-- ===== Attribution comes from our own link, never from the payload =====
select pg_temp.p54_as_service();

select pg_temp.p54_assert(
  (public.service_record_billing_event(
    'manual', 'evt_1', 'invoice.paid', 'cus_p54_linked',
    '{"amount": 1200}'::jsonb) ->> 'status') = 'stored',
  'an event carrying a known provider customer id was not attributed');
select pg_temp.p54_assert(
  (public.service_record_billing_event(
    'manual', 'evt_1', 'invoice.paid', 'cus_p54_linked', '{"amount": 1200}'::jsonb)
    ->> 'idempotent')::boolean,
  'a replayed provider event was processed twice');
select pg_temp.p54_assert(
  (select count(*) from private.billing_events where provider_event_id = 'evt_1') = 1,
  'a replayed provider event created a second row');

-- THE ATTACK. A payload naming another organization must change nothing: the metadata is an
-- untrusted document, and the only thing consulted is the provider customer id we wrote.
select pg_temp.p54_assert(
  (public.service_record_billing_event(
    'manual', 'evt_forged', 'invoice.paid', 'cus_does_not_exist',
    jsonb_build_object('metadata',
      jsonb_build_object('org_id', '54000000-0000-4000-8000-000000000002'))) ->> 'status')
    = 'dead_letter',
  'an event with a forged org_id in its metadata was attributed to that organization');
select pg_temp.p54_assert(
  (select org_id from private.billing_events where provider_event_id = 'evt_forged') is null,
  'a dead letter was attached to an organization anyway');
select pg_temp.p54_assert(
  (select count(*) from private.billing_events
    where org_id = '54000000-0000-4000-8000-000000000002') = 0,
  'the organization named in the payload received an event it has no link to');

-- An event with no customer id at all is a dead letter with its own reason, not a crash.
select pg_temp.p54_assert(
  (public.service_record_billing_event(
    'manual', 'evt_no_customer', 'ping', null, '{}'::jsonb) ->> 'status') = 'dead_letter',
  'an event with no provider customer id was not dead-lettered');
select pg_temp.p54_assert(
  (select dead_letter_reason from private.billing_events where provider_event_id = 'evt_no_customer')
    is not null,
  'a dead letter carries no reason');

-- Nothing this file does changes a customer's plan. Acting on a billing event is a later wave;
-- until then an event is evidence, and an operator changes a subscription deliberately.
select pg_temp.p54_assert(
  (select plan_key from organization_subscriptions
    where org_id = '54000000-0000-4000-8000-000000000001')
    = (select plan_key from organization_subscriptions
       where org_id = '54000000-0000-4000-8000-000000000002'),
  'receiving a billing event silently changed a subscription');

reset role;

-- ===== Operator reads, gated and payload-free =====
select pg_temp.p54_as('64000000-0000-4000-8000-000000000003');
set local role authenticated;
select pg_temp.p54_assert(
  (select count(*) from public.platform_billing_events('54000000-0000-4000-8000-000000000001')) = 0
  and (select count(*) from public.platform_billing_dead_letters()) = 0,
  'an operator without billing.view read the billing ledger');
reset role;

select pg_temp.p54_as('64000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.p54_assert(
  (select count(*) from public.platform_billing_events('54000000-0000-4000-8000-000000000001')) = 1,
  'the billing operator could not see the attributed event');
select pg_temp.p54_assert(
  (select count(*) from public.platform_billing_dead_letters()) = 2,
  'the dead-letter queue did not hold both unattributable events');

-- The attributed event reached the customer's own timeline; the dead letters reached nobody's,
-- because they belong to no customer and inventing one would be the guess this design refuses.
select pg_temp.p54_assert(
  exists (select 1 from public.platform_customer_timeline('54000000-0000-4000-8000-000000000001')
          where action = 'billing_event_received'),
  'an attributed billing event did not reach the customer timeline');
reset role;

-- ===== The quota crossing is recorded once, on the write that exhausts it =====
update plan_entitlements set unlimited = false, numeric_limit = 2
where plan_key = (select plan_key from organization_subscriptions
                  where org_id = '54000000-0000-4000-8000-000000000001')
  and entitlement_key = 'documents.monthly';

select pg_temp.p54_assert(
  (private.record_usage_event(
    '54000000-0000-4000-8000-000000000001', 'documents.monthly', 1, 'doc-1', 'p54')
    ->> 'quantity')::numeric = 1,
  'the first metered write did not move the counter');
select pg_temp.p54_assert(
  (select count(*) from private.product_events
    where org_id = '54000000-0000-4000-8000-000000000001'
      and event_name = 'usage.limit_reached') = 0,
  'the quota crossing fired before the quota was exhausted');

select pg_temp.p54_assert(
  (private.record_usage_event(
    '54000000-0000-4000-8000-000000000001', 'documents.monthly', 1, 'doc-2', 'p54')
    ->> 'quantity')::numeric = 2,
  'the second metered write did not move the counter');
select pg_temp.p54_assert(
  (select count(*) from private.product_events
    where org_id = '54000000-0000-4000-8000-000000000001'
      and event_name = 'usage.limit_reached') = 1,
  'exhausting the quota did not record the crossing');

-- Once per quota per period: the write after the crossing must not emit a second event, and
-- neither must a later one. The idempotency key is the period, not the write.
select pg_temp.p54_assert(
  (private.record_usage_event(
    '54000000-0000-4000-8000-000000000001', 'documents.monthly', 1, 'doc-3', 'p54')
    ->> 'recorded')::boolean,
  'the write past the quota was not counted');
select pg_temp.p54_assert(
  (select count(*) from private.product_events
    where org_id = '54000000-0000-4000-8000-000000000001'
      and event_name = 'usage.limit_reached') = 1,
  'the crossing fired again after the quota was already exhausted');

-- An event outside the allowlist cannot be recorded at all.
do $$
begin
  perform private.record_product_event(
    '54000000-0000-4000-8000-000000000001', null, 'made.up', '{}'::jsonb, 'p54');
  raise exception 'expected an undefined product event to be refused';
exception when foreign_key_violation then null;
end
$$;

-- ===== The funnel says what it cannot see =====
select pg_temp.p54_as('64000000-0000-4000-8000-000000000002');
set local role authenticated;

select pg_temp.p54_assert(
  (select count(*) from public.platform_funnel_metrics()) > 0,
  'the billing operator could not read the funnel');

-- Three stages have no data in this system. They must appear and be flagged, not be omitted --
-- a missing row invites somebody to add a zero later and call it a measurement.
select pg_temp.p54_assert(
  (select count(*) from public.platform_funnel_metrics()
    where metric_key in ('visitor_to_signup', 'checkout_started', 'returned_after_first_session')
      and not measured and value is null and btrim(coalesce(note, '')) <> '') = 3,
  'an unmeasurable funnel stage was omitted, reported as zero, or given no explanation');

-- The window is asserted relatively rather than absolutely: this database carries organizations
-- from other fixtures and from the seed, so a bare count is not this suite's to predict. Widening
-- the window past the older fixture organization must admit at least it.
select pg_temp.p54_assert(
  (select value from public.platform_funnel_metrics(now() - interval '60 days', now())
    where metric_key = 'organizations_created')
  >= (select value from public.platform_funnel_metrics(now() - interval '35 days', now())
       where metric_key = 'organizations_created') + 1,
  'widening the window past an organization did not admit it');

-- A window that has not happened yet is deterministically empty, whatever else the database holds.
select pg_temp.p54_assert(
  (select value from public.platform_funnel_metrics(now() + interval '1 day', now() + interval '2 days')
    where metric_key = 'organizations_created') = 0,
  'the funnel counted organizations created in a window that has not arrived');

-- A rate with no denominator is unmeasured, not zero: nobody failed to activate out of nobody.
select pg_temp.p54_assert(
  (select measured from public.platform_funnel_metrics(now() + interval '1 day', now() + interval '2 days')
    where metric_key = 'activation_rate') = false,
  'an activation rate over an empty cohort reported itself as measured');

select pg_temp.p54_assert(
  (select value from public.platform_funnel_metrics()
    where metric_key = 'limit_reached_events') >= 1,
  'the funnel did not see the recorded quota crossing');

reset role;

-- A tenant reads none of it.
select pg_temp.p54_as('64000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.p54_assert(
  (select count(*) from public.platform_funnel_metrics()) = 0
  and (select count(*) from public.platform_billing_dead_letters()) = 0,
  'a tenant owner read the funnel or the billing dead letters');
reset role;

rollback;

\echo 'p54_billing_boundary_and_funnel_passed'
