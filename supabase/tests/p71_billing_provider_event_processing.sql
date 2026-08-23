-- P71 -- A verified provider event drives exactly one named transition, an unproven provider
-- changes nothing, everything unrecognized or undecided becomes a visible dead letter, a replay is
-- a no-op, a payload cannot name the tenant, and not one transition moves a usage counter
-- (0187, on the 0154/0155/0157 contracts; owner decisions #210, #213-#225, #242, #256).
\set ON_ERROR_STOP on

begin;

create function pg_temp.p71_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P71 billing processing assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p71_as_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
end
$$;

create function pg_temp.p71_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_user, 'amr', '[]'::jsonb)::text, true);
end
$$;

-- The whole usage surface in one comparable value. Every transition below is checked against it:
-- billing and usage are two clocks, and this suite exists partly to prove only one of them moves.
create function pg_temp.p71_usage_fingerprint() returns text language sql volatile as $$
  select coalesce(md5(string_agg(
    org_id::text || '|' || metric_key || '|' || period_start::text || '|' || quantity::text,
    ',' order by org_id, metric_key, period_start)), 'empty')
  from private.usage_counters
$$;

create function pg_temp.p71_plan_of(p_org uuid) returns text language sql volatile as $$
  select plan_key from organization_subscriptions where org_id = p_org
$$;

create function pg_temp.p71_status_of(p_org uuid) returns text language sql volatile as $$
  select status from organization_subscriptions where org_id = p_org
$$;

create function pg_temp.p71_period_of(p_org uuid, p_field text) returns timestamptz
language sql volatile as $$
  select (to_jsonb(subscription) ->> p_field)::timestamptz
  from organization_subscriptions subscription where subscription.org_id = p_org
$$;

create function pg_temp.p71_dead_reason(p_event_id text) returns text language sql volatile as $$
  select dead.reason_code
  from private.billing_event_dead_letters dead
  join private.billing_events event on event.id = dead.billing_event_id
  where event.provider_event_id = p_event_id
$$;

-- Records the event through 0157's ingestion door, then runs 0187's dispatcher over it.
--
-- The verdict is parked in a setting rather than returned into the assertion expression, so a
-- delivery is always its OWN statement. That is not style. A reader called in the same statement
-- as a volatile writer can be planned against the snapshot from before the statement began, so
-- `deliver(...) and status_of(...) = 'past_due'` would read the OLD status and fail an assertion
-- about a transition that in fact worked. Splitting the statements is what makes every claim below
-- a claim about state that has actually landed.
create function pg_temp.p71_deliver(
  p_event_id text, p_event_type text, p_customer text, p_payload jsonb
) returns void language plpgsql as $$
declare
  v_recorded jsonb;
begin
  v_recorded := public.service_record_billing_event(
    'paddle', p_event_id, p_event_type, p_customer, p_payload);
  perform set_config('p71.last', (
    public.service_apply_billing_event('paddle', p_event_id)
    || jsonb_build_object('recorded_status', v_recorded ->> 'status'))::text, false);
end
$$;

/** The last delivery's verdict, read in a LATER statement than the one that produced it. */
create function pg_temp.p71_last(p_key text) returns text language sql volatile as $$
  select current_setting('p71.last', true)::jsonb ->> p_key
$$;

create function pg_temp.p71_applied() returns boolean language sql volatile as $$
  select coalesce((current_setting('p71.last', true)::jsonb ->> 'applied')::boolean, false)
$$;

-- A Paddle subscription entity, in the shape the published documentation shows (read 23.08.2026):
-- data.items[].price.id, data.billing_cycle.interval, data.current_billing_period.starts_at/ends_at,
-- data.next_billed_at, data.scheduled_change.action/effective_at, data.customer_id.
create function pg_temp.p71_subscription_payload(
  p_event_id text, p_event_type text, p_price text,
  p_interval text default 'month', p_scheduled jsonb default null
) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'event_id', p_event_id,
    'event_type', p_event_type,
    'occurred_at', '2026-08-23T09:00:00.000000Z',
    'notification_id', 'ntf_p71',
    'data', jsonb_build_object(
      'id', 'sub_p71',
      'status', 'active',
      'customer_id', 'ctm_p71_linked',
      'billing_cycle', jsonb_build_object('interval', p_interval, 'frequency', 1),
      'current_billing_period', jsonb_build_object(
        'starts_at', '2026-08-23T09:00:00Z', 'ends_at', '2026-09-23T09:00:00Z'),
      'next_billed_at', '2026-09-23T09:00:00Z',
      'scheduled_change', p_scheduled,
      'items', jsonb_build_array(jsonb_build_object(
        'price', jsonb_build_object('id', p_price)))))
$$;

create function pg_temp.p71_adjustment_payload(
  p_event_id text, p_action text, p_type text, p_status text
) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'event_id', p_event_id,
    'occurred_at', '2026-09-01T09:00:00.000000Z',
    'data', (jsonb_build_object(
      'id', 'adj_p71', 'customer_id', 'ctm_p71_linked',
      'transaction_id', 'txn_p71', 'subscription_id', 'sub_p71',
      'action', p_action, 'status', p_status)
      || case when p_type is null then '{}'::jsonb else jsonb_build_object('type', p_type) end))
$$;

-- ===== Structural claims: seeded shut, unreachable, and unguessed =====
select pg_temp.p71_assert(
  not exists (select 1 from private.billing_provider_boundary where enabled),
  'a billing provider is seeded enabled -- code merge would be billing activation');
select pg_temp.p71_assert(
  (select count(*) from private.billing_provider_boundary
    where provider in ('paddle', 'stripe', 'morning')) = 3,
  'the boundary does not name all three decided providers');
select pg_temp.p71_assert(
  (select readiness from private.billing_provider_boundary where provider = 'paddle')
    like '%ACCOUNT_NOT_PROVEN%',
  'the recorded Paddle readiness no longer matches #213');
select pg_temp.p71_assert(
  not exists (select 1 from private.billing_provider_price_map),
  'the provider price map carries a guessed plan mapping');
select pg_temp.p71_assert(
  not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'private'
      and table_name in ('billing_provider_boundary', 'billing_event_types',
                         'billing_provider_price_map', 'subscription_scheduled_changes',
                         'billing_event_dead_letters', 'billing_ingress_rejections')
      and grantee in ('anon', 'authenticated', 'service_role')),
  'a role holds a direct grant on a billing ledger');
select pg_temp.p71_assert(
  not has_function_privilege('anon', 'public.service_apply_billing_event(text,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.service_apply_billing_event(text,text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.service_apply_billing_event(text,text)', 'EXECUTE'),
  'the billing transition dispatcher is not service_role only');
-- 0157's guarantee, restated: attribution still cannot be handed a payload.
select pg_temp.p71_assert(
  (select pronargs from pg_proc
    where oid = to_regprocedure('private.resolve_billing_org(text,text)')) = 2,
  'resolve_billing_org changed shape -- attribution must not receive the payload');
-- The ledger's new state machine, and only it.
select pg_temp.p71_assert(
  (select pg_get_constraintdef(oid) from pg_constraint
    where conrelid = 'private.billing_events'::regclass
      and conname = 'billing_events_status_check') ~ '\mprocessed\M',
  'billing_events cannot record that a transition ran');
select pg_temp.p71_assert(
  not exists (
    select 1 from pg_proc
    where pronamespace in ('public'::regnamespace, 'private'::regnamespace)
      and prosrc ~ '\mbilling_provider_boundary\M'
      and prosrc ~* '\minsert\M|\mupdate\M|\mdelete\M'),
  'a function can enable a billing provider at runtime');

-- ===== Fixture =====
insert into public.organizations (id, name, status, created_at) values
  ('71000000-0000-4000-8000-000000000001', 'P71 linked',    'active', now() - interval '90 days'),
  ('71000000-0000-4000-8000-000000000002', 'P71 bystander', 'active', now() - interval '90 days');

insert into auth.users (id, email) values
  ('72000000-0000-4000-8000-000000000001', 'owner-p71@example.test'),
  ('72000000-0000-4000-8000-000000000002', 'billing-p71@example.test');
insert into public.profiles (id, org_id, full_name, role) values
  ('72000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001',
   'P71 owner', 'owner');
insert into public.platform_admins (user_id, note) values
  ('72000000-0000-4000-8000-000000000002', 'P71 billing operator');
insert into public.platform_admin_roles (user_id, role_key) values
  ('72000000-0000-4000-8000-000000000002', 'billing');

-- The link WE wrote. This, and only this, is what attribution may consult.
update organization_subscriptions
   set provider = 'paddle', provider_customer_id = 'ctm_p71_linked', plan_key = 'free'
 where org_id = '71000000-0000-4000-8000-000000000001';
update organization_subscriptions set plan_key = 'free'
 where org_id = '71000000-0000-4000-8000-000000000002';

-- Usage this organization has already consumed on Free. #242: nothing below may move it.
insert into private.usage_counters (org_id, metric_key, period_start, period_end, quantity)
values ('71000000-0000-4000-8000-000000000001', 'ocr_pages.monthly',
        date_trunc('month', now()), date_trunc('month', now()) + interval '1 month', 37);

select set_config('p71.usage', pg_temp.p71_usage_fingerprint(), false);

select pg_temp.p71_as_service();

-- ===== The provider is not proven: a perfect event changes nothing =====
-- #213. This is the assertion that makes "code merge is not billing activation" a fact rather
-- than a sentence in a report.
select pg_temp.p71_deliver('evt_disabled', 'subscription.activated', 'ctm_p71_linked',
  pg_temp.p71_subscription_payload('evt_disabled', 'subscription.activated', 'pri_pro_monthly'));
select pg_temp.p71_assert(
  pg_temp.p71_last('reason_code') = 'provider_not_enabled'
  and pg_temp.p71_dead_reason('evt_disabled') = 'provider_not_enabled',
  'a signed, attributed event was processed while the provider is unproven');
select pg_temp.p71_assert(
  pg_temp.p71_plan_of('71000000-0000-4000-8000-000000000001') = 'free',
  'an unproven provider changed a plan');

-- From here on the provider is enabled INSIDE this transaction only, so the transitions can be
-- proven. Nothing outside this rollback ever sees an enabled provider.
update private.billing_provider_boundary
   set enabled = true, enabled_at = now(),
       enabled_by = '72000000-0000-4000-8000-000000000002',
       enable_reason = 'P71 proves the transitions; rolled back with this transaction'
 where provider = 'paddle';

-- Two live merchants of record is not a configuration, it is a defect.
do $$
begin
  update private.billing_provider_boundary
     set enabled = true, enabled_at = now(),
         enabled_by = '72000000-0000-4000-8000-000000000002', enable_reason = 'P71 second MoR'
   where provider = 'stripe';
  raise exception 'expected a second live merchant of record to be refused';
exception when unique_violation then null;
end
$$;

-- ===== Unrecognized, undecided and unmapped all dead-letter and touch nothing =====
select pg_temp.p71_deliver('evt_unknown', 'subscription.telepathy', 'ctm_p71_linked',
  jsonb_build_object('event_id', 'evt_unknown',
    'data', jsonb_build_object('customer_id', 'ctm_p71_linked')));
select pg_temp.p71_assert(
  pg_temp.p71_dead_reason('evt_unknown') = 'event_type_unrecognized',
  'an event type nobody classified reached a transition');

select pg_temp.p71_deliver('evt_paused', 'subscription.paused', 'ctm_p71_linked',
  pg_temp.p71_subscription_payload('evt_paused', 'subscription.paused', 'pri_pro_monthly'));
select pg_temp.p71_assert(
  pg_temp.p71_dead_reason('evt_paused') = 'transition_undecided',
  'a paused subscription was silently ignored instead of dead-lettered');

-- The price is not mapped to a plan, and there is no plan to guess. #195/#208 own that mapping.
select pg_temp.p71_deliver('evt_unmapped', 'subscription.activated', 'ctm_p71_linked',
  pg_temp.p71_subscription_payload('evt_unmapped', 'subscription.activated', 'pri_never_mapped'));
select pg_temp.p71_assert(
  pg_temp.p71_dead_reason('evt_unmapped') = 'plan_unmapped'
  and pg_temp.p71_plan_of('71000000-0000-4000-8000-000000000001') = 'free',
  'an unmapped provider price granted a guessed plan');

-- ===== THE ATTACK: no payload field may name the tenant =====
-- The bystander is named in metadata, custom_data and passthrough, by an event whose provider
-- customer id resolves to nobody. 0157 dead-letters it as unattributable; nothing reaches either
-- organization, and in particular not the one the payload asked for.
select pg_temp.p71_deliver('evt_forged', 'subscription.activated', 'ctm_not_ours',
  jsonb_build_object(
    'event_id', 'evt_forged',
    'data', jsonb_build_object(
      'customer_id', 'ctm_not_ours',
      'custom_data', jsonb_build_object('org_id', '71000000-0000-4000-8000-000000000002'),
      'passthrough', '{"org_id":"71000000-0000-4000-8000-000000000002"}',
      'metadata', jsonb_build_object('org_id', '71000000-0000-4000-8000-000000000002'))));
select pg_temp.p71_assert(
  pg_temp.p71_last('recorded_status') = 'dead_letter'
  and pg_temp.p71_applied() = false,
  'an event naming an organization in its payload was attributed to it');
select pg_temp.p71_assert(
  pg_temp.p71_plan_of('71000000-0000-4000-8000-000000000002') = 'free'
  and not exists (select 1 from private.billing_events
                  where org_id = '71000000-0000-4000-8000-000000000002'),
  'the organization named in the payload received an event or a plan change');

-- ===== Free -> paid is immediate, and does NOT reset usage (#217, #242) =====
insert into private.billing_provider_price_map (provider, provider_price_id, plan_key, note)
values ('paddle', 'pri_pro_monthly', 'pro', 'P71 fixture mapping, rolled back with this suite');

select pg_temp.p71_deliver('evt_activate', 'subscription.activated', 'ctm_p71_linked',
  pg_temp.p71_subscription_payload('evt_activate', 'subscription.activated', 'pri_pro_monthly'));
select pg_temp.p71_assert(
  pg_temp.p71_applied(),
  'a mapped activation did not open paid entitlement');
select pg_temp.p71_assert(
  pg_temp.p71_plan_of('71000000-0000-4000-8000-000000000001') = 'pro'
  and pg_temp.p71_status_of('71000000-0000-4000-8000-000000000001') = 'active',
  'activation did not put the organization on the mapped paid plan');
select pg_temp.p71_assert(
  pg_temp.p71_period_of('71000000-0000-4000-8000-000000000001', 'current_period_end')
    = '2026-09-23T09:00:00Z'::timestamptz,
  'activation did not take the billing period from the provider');
select pg_temp.p71_assert(
  pg_temp.p71_usage_fingerprint() = current_setting('p71.usage'),
  'Free -> paid reset a usage counter or opened a new usage period (#242)');

-- Every entitlement change is audited with a reason, and by nobody: a signed provider event did
-- this, and naming an operator in the audit trail would be a lie.
select pg_temp.p71_assert(
  exists (select 1 from audit_logs
          where org_id = '71000000-0000-4000-8000-000000000001'
            and action = 'billing_activate_paid' and user_id is null
            and btrim(coalesce(reason, '')) <> ''),
  'an entitlement-changing transition wrote no reasoned audit row');

-- ===== A replay is a no-op =====
-- Paddle retries a live delivery up to sixty times over three days with the SAME event_id.
select pg_temp.p71_assert(
  (public.service_apply_billing_event('paddle', 'evt_activate') ->> 'idempotent')::boolean,
  'a redelivered event was processed a second time');
select pg_temp.p71_assert(
  (select count(*) from audit_logs
    where org_id = '71000000-0000-4000-8000-000000000001'
      and action = 'billing_activate_paid') = 1,
  'a replay produced a second entitlement change');
select pg_temp.p71_assert(
  (select count(*) from private.billing_events where provider_event_id = 'evt_activate') = 1,
  'a replayed provider event created a second ledger row');

-- ===== A recognized but deliberately inert event is processed, not dead-lettered =====
select pg_temp.p71_deliver('evt_txpaid', 'transaction.paid', 'ctm_p71_linked',
  jsonb_build_object('event_id', 'evt_txpaid',
    'data', jsonb_build_object('customer_id', 'ctm_p71_linked')));
select pg_temp.p71_assert(
  pg_temp.p71_last('transition') = 'none'
  and pg_temp.p71_dead_reason('evt_txpaid') is null,
  'an informational event was treated as a failure');

-- ===== Cancel at period end, then resume (#219) =====
select pg_temp.p71_deliver('evt_cancel_sched', 'subscription.updated', 'ctm_p71_linked',
  pg_temp.p71_subscription_payload('evt_cancel_sched', 'subscription.updated', 'pri_pro_monthly',
    'month', jsonb_build_object('action', 'cancel', 'effective_at', '2026-09-23T09:00:00Z')));
select pg_temp.p71_assert(
  pg_temp.p71_applied(),
  'a scheduled cancellation was not recorded');
select pg_temp.p71_assert(
  exists (select 1 from private.subscription_scheduled_changes
          where org_id = '71000000-0000-4000-8000-000000000001'
            and action = 'cancel' and withdrawn_at is null),
  'the cancellation schedule the customer must be shown was not held');
-- Access is untouched until the boundary: #219 says full access until the paid period ends.
select pg_temp.p71_assert(
  pg_temp.p71_plan_of('71000000-0000-4000-8000-000000000001') = 'pro'
  and pg_temp.p71_status_of('71000000-0000-4000-8000-000000000001') = 'active',
  'scheduling a cancellation withdrew entitlement early');

select pg_temp.p71_deliver('evt_resume', 'subscription.resumed', 'ctm_p71_linked',
  pg_temp.p71_subscription_payload('evt_resume', 'subscription.resumed', 'pri_pro_monthly'));
select pg_temp.p71_assert(
  pg_temp.p71_applied(),
  'a resume did not apply');
select pg_temp.p71_assert(
  not exists (select 1 from private.subscription_scheduled_changes
              where org_id = '71000000-0000-4000-8000-000000000001' and withdrawn_at is null),
  'a resume left the cancellation schedule standing');

-- ===== Delinquency, and the one door out of it (#221, #222, #223) =====
select pg_temp.p71_deliver('evt_pastdue', 'subscription.past_due', 'ctm_p71_linked',
  pg_temp.p71_subscription_payload('evt_pastdue', 'subscription.past_due', 'pri_pro_monthly'));
select pg_temp.p71_assert(
  pg_temp.p71_applied()
  and pg_temp.p71_status_of('71000000-0000-4000-8000-000000000001') = 'past_due',
  'a failed renewal did not put the organization into the read-only state');
select pg_temp.p71_assert(
  pg_temp.p71_plan_of('71000000-0000-4000-8000-000000000001') = 'pro',
  'delinquency moved the plan; #221 says read-only, not a downgrade');
select pg_temp.p71_assert(
  pg_temp.p71_usage_fingerprint() = current_setting('p71.usage'),
  'delinquency moved a usage counter (#242)');

-- A subscription.updated arriving while delinquent must NOT quietly restore write access: only a
-- successful payment does that (#222). This is the hole a naive reconcile-everything would open.
select pg_temp.p71_deliver('evt_sync_while_due', 'subscription.updated', 'ctm_p71_linked',
  pg_temp.p71_subscription_payload('evt_sync_while_due', 'subscription.updated', 'pri_pro_monthly'));
select pg_temp.p71_assert(
  pg_temp.p71_applied()
  and pg_temp.p71_status_of('71000000-0000-4000-8000-000000000001') = 'past_due',
  'an ordinary subscription update lifted a delinquency without a payment');

select pg_temp.p71_deliver('evt_recover', 'transaction.completed', 'ctm_p71_linked',
  jsonb_build_object('event_id', 'evt_recover', 'event_type', 'transaction.completed',
    'occurred_at', '2026-08-30T12:00:00.000000Z',
    'data', jsonb_build_object('customer_id', 'ctm_p71_linked', 'id', 'txn_p71')));
select pg_temp.p71_assert(
  pg_temp.p71_applied()
  and pg_temp.p71_status_of('71000000-0000-4000-8000-000000000001') = 'active',
  'an approved late payment did not restore write access');
-- #223: a full NEW billing period opens at the payment-approval timestamp.
select pg_temp.p71_assert(
  pg_temp.p71_period_of('71000000-0000-4000-8000-000000000001', 'current_period_start')
    = '2026-08-30T12:00:00Z'::timestamptz
  and pg_temp.p71_period_of('71000000-0000-4000-8000-000000000001', 'renews_at')
    = '2026-09-30T12:00:00Z'::timestamptz,
  'recovery did not anchor a new billing period to the payment approval');
select pg_temp.p71_assert(
  pg_temp.p71_usage_fingerprint() = current_setting('p71.usage'),
  'delinquency recovery reset a usage counter (#242)');

-- A second successful charge on a healthy subscription must not re-anchor the period again.
select pg_temp.p71_deliver('evt_recover_again', 'transaction.completed', 'ctm_p71_linked',
  jsonb_build_object('event_id', 'evt_recover_again', 'event_type', 'transaction.completed',
    'occurred_at', '2026-09-05T12:00:00.000000Z',
    'data', jsonb_build_object('customer_id', 'ctm_p71_linked')));
select pg_temp.p71_assert(
  pg_temp.p71_applied() = false
  and pg_temp.p71_period_of('71000000-0000-4000-8000-000000000001', 'current_period_start')
      = '2026-08-30T12:00:00Z'::timestamptz,
  'a routine charge re-anchored a billing period that was already correct');

-- ===== Refunds (#224, #225) =====
-- Not yet approved: nothing happens, and it is not a failure either.
select pg_temp.p71_deliver('evt_adj_pending', 'adjustment.created', 'ctm_p71_linked',
  pg_temp.p71_adjustment_payload('evt_adj_pending', 'refund', 'full', 'pending_approval'));
select pg_temp.p71_assert(
  pg_temp.p71_applied() = false
  and pg_temp.p71_dead_reason('evt_adj_pending') is null
  and pg_temp.p71_plan_of('71000000-0000-4000-8000-000000000001') = 'pro',
  'an unapproved refund changed the plan or was treated as a failure');

-- An approved PARTIAL refund does not change the plan (#225).
select pg_temp.p71_deliver('evt_adj_partial', 'adjustment.updated', 'ctm_p71_linked',
  pg_temp.p71_adjustment_payload('evt_adj_partial', 'refund', 'partial', 'approved'));
select pg_temp.p71_assert(
  pg_temp.p71_applied() = false
  and pg_temp.p71_plan_of('71000000-0000-4000-8000-000000000001') = 'pro',
  'a partial legal refund changed the plan');

-- A chargeback is a money event with no decided product behaviour: dead letter, not a guess.
select pg_temp.p71_deliver('evt_adj_chargeback', 'adjustment.updated', 'ctm_p71_linked',
  pg_temp.p71_adjustment_payload('evt_adj_chargeback', 'chargeback', 'full', 'approved'));
select pg_temp.p71_assert(
  pg_temp.p71_dead_reason('evt_adj_chargeback') = 'adjustment_action_not_decided'
  and pg_temp.p71_plan_of('71000000-0000-4000-8000-000000000001') = 'pro',
  'an approved chargeback was quietly filed as a refund');

-- A refund that will not say whether it is full or partial cannot be acted on.
select pg_temp.p71_deliver('evt_adj_scopeless', 'adjustment.updated', 'ctm_p71_linked',
  pg_temp.p71_adjustment_payload('evt_adj_scopeless', 'refund', null, 'approved'));
select pg_temp.p71_assert(
  pg_temp.p71_dead_reason('evt_adj_scopeless') = 'refund_scope_undeterminable'
  and pg_temp.p71_plan_of('71000000-0000-4000-8000-000000000001') = 'pro',
  'a refund of unknown scope was acted on anyway');

-- An approved FULL refund ends the paid plan immediately and moves to Free, without a usage reset.
select pg_temp.p71_deliver('evt_adj_full', 'adjustment.updated', 'ctm_p71_linked',
  pg_temp.p71_adjustment_payload('evt_adj_full', 'refund', 'full', 'approved'));
select pg_temp.p71_assert(
  pg_temp.p71_applied()
  and pg_temp.p71_plan_of('71000000-0000-4000-8000-000000000001') = 'free'
  and pg_temp.p71_status_of('71000000-0000-4000-8000-000000000001') = 'active',
  'a full refund did not end the paid plan');
select pg_temp.p71_assert(
  pg_temp.p71_usage_fingerprint() = current_setting('p71.usage'),
  'a full refund reset a usage counter (#242)');

-- A duplicate refund changes nothing (#225), whether it is the same event redelivered or a second
-- approved refund arriving after the plan has already ended.
select pg_temp.p71_assert(
  (public.service_apply_billing_event('paddle', 'evt_adj_full') ->> 'idempotent')::boolean,
  'a redelivered refund was applied twice');
select pg_temp.p71_deliver('evt_adj_full_again', 'adjustment.updated', 'ctm_p71_linked',
  pg_temp.p71_adjustment_payload('evt_adj_full_again', 'refund', 'full', 'approved'));
select pg_temp.p71_assert(
  pg_temp.p71_applied() = false
  and pg_temp.p71_plan_of('71000000-0000-4000-8000-000000000001') = 'free',
  'a duplicate refund changed something');

-- ===== The end of a cancelled period (#219, #220, #242) =====
update organization_subscriptions set plan_key = 'pro', status = 'active'
 where org_id = '71000000-0000-4000-8000-000000000001';
select pg_temp.p71_deliver('evt_canceled', 'subscription.canceled', 'ctm_p71_linked',
  pg_temp.p71_subscription_payload('evt_canceled', 'subscription.canceled', 'pri_pro_monthly'));
select pg_temp.p71_assert(
  pg_temp.p71_applied()
  and pg_temp.p71_plan_of('71000000-0000-4000-8000-000000000001') = 'free',
  'the end of a cancelled period did not move the organization to Free');

-- ===== The whole run moved exactly one clock =====
select pg_temp.p71_assert(
  pg_temp.p71_usage_fingerprint() = current_setting('p71.usage'),
  'the usage surface moved somewhere across the full transition suite (#242)');
select pg_temp.p71_assert(
  (select count(*) from private.billing_event_dead_letters) >= 6,
  'the dead-letter queue did not hold every event that changed nothing');
-- One dead letter per event, however many times it is redelivered.
select pg_temp.p71_assert(
  (select count(*) from private.billing_event_dead_letters)
    = (select count(distinct billing_event_id) from private.billing_event_dead_letters),
  'an event queued a second complaint about itself');

-- ===== Rejected at the door, counted without an identifier the caller supplied =====
select public.service_record_billing_ingress_rejection('paddle', 'signature_invalid');
select pg_temp.p71_assert(
  (select count(*) from private.billing_ingress_rejections
    where provider = 'paddle' and reason_code = 'signature_invalid') = 1,
  'an unverifiable request was not counted');
-- The reason it is counted rather than stored: private.billing_events uniques on the event id the
-- request CLAIMS, so writing an unverified one would let an attacker pre-register an identifier
-- and make the genuine delivery look like a replay.
select pg_temp.p71_assert(
  not exists (select 1 from private.billing_ingress_rejections rejection
              where to_jsonb(rejection) ? 'payload'
                 or to_jsonb(rejection) ? 'provider_event_id'),
  'an ingress rejection retained a caller-supplied identifier');

reset role;

-- A user JWT reaches neither the dispatcher nor the rejection counter.
select pg_temp.p71_as('72000000-0000-4000-8000-000000000001');
do $$
begin
  perform public.service_apply_billing_event('paddle', 'evt_activate');
  raise exception 'expected a user JWT to be refused at the billing transition dispatcher';
exception when insufficient_privilege then null;
end
$$;
do $$
begin
  perform public.service_record_billing_ingress_rejection('paddle', 'signature_invalid');
  raise exception 'expected a user JWT to be refused at the billing ingress counter';
exception when insufficient_privilege then null;
end
$$;

rollback;

\echo 'p71_billing_provider_event_processing_passed'
