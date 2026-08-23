-- Wave 2 of Subscriptions/Billing/Usage (owner decisions #210, #213-#225, #242, #256) -- the
-- processor 0157 said would come, and the fail-closed boundary that keeps it from running.
--
-- 0157 built the storage, the idempotency, the attribution and the audit, and stated plainly what
-- was left: "When a provider is chosen, the remaining work is a signature check and a parser." The
-- signature check now exists in supabase/functions/_shared/billing-adapter.ts, implemented from
-- Paddle's published contract (read 23.08.2026,
-- https://developer.paddle.com/webhooks/about/signature-verification/). This file is the other
-- half: what a verified, attributed event is allowed to DO.
--
-- 0157 ALSO SAID THERE WOULD BE NO `processed` STATUS UNTIL A PROCESSOR LANDED, and asserted it.
-- The processor has landed, so this migration knowingly overturns that invariant, adds `processed`,
-- and re-asserts the new state machine in its own anchor. That is the intended succession, not a
-- workaround: 0157's anchor was a point-in-time statement about a build in which nothing processed.
--
-- WHAT DOES NOT CHANGE, AND MUST NOT. private.resolve_billing_org still takes no payload argument
-- and is still the only way an event acquires an organization. The transitions below read the
-- payload for their own inputs -- which plan, which timestamp, which refund -- and take the
-- organization as a separate argument sourced from private.billing_events.org_id, which was
-- resolved from the provider-customer link WE wrote (0154). No path exists from a payload field to
-- a choice of tenant, and the anchors at the end of this file say so structurally.
--
-- FAIL-CLOSED, IN THE DATABASE, NOT ONLY IN THE EDGE FUNCTION. #213 records Paddle as
-- SELECTED / ACCOUNT_NOT_PROVEN / KYC_NOT_PROVEN / ISRAEL_PAYOUT_NOT_PROVEN / NOT_INTEGRATED, and
-- #207/#256 make Stripe direct and Morning a fallback that is explicitly not authorized. So every
-- provider is seeded DISABLED, at most one merchant of record may ever be enabled at a time, and
-- there is deliberately NO function that can enable one. Turning a provider on is a future
-- forward-only migration written after the owner has proven the account -- reviewed as the
-- commercial decision it is. Until then a perfectly signed, perfectly attributed Paddle event
-- changes no entitlement; it dead-letters, visibly, with a reason. Merging this file is not
-- billing activation and cannot become it by configuration.
--
-- USAGE IS NOT BILLING (#242). Not one transition in this file writes a usage period, creates a
-- counter row or resets one. The usage anchor belongs to the organization's signup date and to
-- another migration entirely. An anchor at the end of this file fails the migration if any
-- transition body so much as names the usage counter surface.

-- ===== 1. The provider boundary: seeded shut, with no key =====
create table private.billing_provider_boundary (
  provider           text primary key check (provider ~ '^[a-z][a-z0-9_]*$'),
  -- A merchant of record carries the commercial truth: who charged the customer, who owes the
  -- tax, who issues the refund. Two of them at once is not a configuration, it is a defect.
  role               text not null check (role in ('merchant_of_record', 'tax_documents')),
  enabled            boolean not null default false,
  -- The row in docs/OPEN-DECISIONS.md that governs this provider. Not decoration: it is how a
  -- reader of this table finds out who decided, and on what.
  decision_reference text not null check (decision_reference ~ '^#[0-9]+$'),
  -- The readiness string exactly as recorded in that decision. A provider whose readiness says
  -- NOT_PROVEN cannot be enabled by anyone reading this table honestly.
  readiness          text not null check (length(btrim(readiness)) > 0),
  enabled_at         timestamptz,
  enabled_by         uuid references auth.users(id) on delete restrict,
  enable_reason      text,
  updated_at         timestamptz not null default now(),
  -- Enabling is not a boolean flip: it must carry who did it, when, and why.
  constraint billing_provider_boundary_enable_shape check (
    (enabled = false and enabled_at is null and enabled_by is null and enable_reason is null)
    or (enabled = true and enabled_at is not null and enabled_by is not null
        and length(btrim(enable_reason)) > 0))
);
revoke all on table private.billing_provider_boundary
  from public, anon, authenticated, service_role;

-- One live merchant of record, enforced by the database rather than by everyone remembering.
-- (And one live tax-document provider, by the same index and the same argument.)
create unique index billing_provider_boundary_single_live_role_idx
  on private.billing_provider_boundary (role) where enabled;

insert into private.billing_provider_boundary (provider, role, decision_reference, readiness) values
  ('paddle', 'merchant_of_record', '#213',
   'SELECTED / ACCOUNT_NOT_PROVEN / KYC_NOT_PROVEN / ISRAEL_PAYOUT_NOT_PROVEN / NOT_INTEGRATED'),
  ('stripe', 'merchant_of_record', '#207',
   'FALLBACK_ONLY / NOT_AUTHORIZED / BLOCKED_UNTIL_PADDLE_KYC_OR_PAYOUT_CONCLUSIVELY_FAILS'),
  ('morning', 'tax_documents', '#256',
   'SELECTED_FALLBACK / ACCOUNT_NOT_PROVEN / API_NOT_VERIFIED / NOT_INTEGRATED');

comment on table private.billing_provider_boundary is
  'Which billing provider may act (0187). Seeded entirely disabled and deliberately has no write '
  'function: enabling one is a forward-only migration written after the owner proves the account, '
  'not a runtime toggle. The partial unique index allows at most one live merchant of record.';

create or replace function private.billing_provider_enabled(p_provider text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select boundary.enabled from private.billing_provider_boundary boundary
      where boundary.provider = p_provider), false)
$$;
revoke all on function private.billing_provider_enabled(text) from public, anon, authenticated;

-- ===== 2. The recognized-event whitelist =====
-- An allowlist, not a switch statement: what an event means is data an operator can read, and an
-- event type nobody has classified cannot reach a transition by accident.
create table private.billing_event_types (
  provider   text not null check (provider ~ '^[a-z][a-z0-9_]*$'),
  event_type text not null check (length(btrim(event_type)) between 1 and 100),
  transition text not null check (transition in (
    -- Recognized and deliberately inert: it tells us something, it changes nothing.
    'none',
    -- Recognized as a real commercial state change for which the product has NO decided
    -- behaviour. It dead-letters on purpose, because silently ignoring it would leave a customer
    -- holding entitlement the provider has stopped billing for.
    'undecided',
    'activate_paid', 'sync_subscription', 'downgrade_to_free',
    'mark_delinquent', 'resume_paid', 'recover_payment', 'apply_refund')),
  note       text not null check (length(btrim(note)) >= 10),
  primary key (provider, event_type)
);
revoke all on table private.billing_event_types from public, anon, authenticated, service_role;

-- Paddle's event vocabulary, read 23.08.2026 from https://developer.paddle.com/llms/webhooks.txt
insert into private.billing_event_types (provider, event_type, transition, note) values
  ('paddle', 'subscription.created',     'none',
   'A subscription exists at the provider; nobody has paid yet, so nothing is granted here.'),
  ('paddle', 'subscription.imported',    'none',
   'A subscription imported into Paddle; entitlement follows the activation event, not the import.'),
  ('paddle', 'subscription.trialing',    'none',
   'Trials are a product state this build does not sell; recorded, never acted on.'),
  ('paddle', 'subscription.activated',   'activate_paid',
   'The signed payment event #217 requires: paid entitlement opens immediately, usage is untouched.'),
  ('paddle', 'subscription.updated',     'sync_subscription',
   'The provider is authoritative for plan and interval; #216 changes arrive here at renewal.'),
  ('paddle', 'subscription.canceled',    'downgrade_to_free',
   'The paid period ended (#219): the organization becomes Free without a usage reset (#220/#242).'),
  ('paddle', 'subscription.past_due',    'mark_delinquent',
   'A renewal charge failed (#221): the organization goes read-only until a payment succeeds.'),
  ('paddle', 'subscription.resumed',     'resume_paid',
   'A cancellation was withdrawn before the period boundary (#219).'),
  ('paddle', 'subscription.paused',      'undecided',
   'Pause is not a decided product state: #210 decides cancellation and delinquency, not pause.'),
  ('paddle', 'transaction.completed',    'recover_payment',
   'The successful signed payment #222 requires to restore write access, opening a new period.'),
  ('paddle', 'transaction.paid',         'none',
   'Recorded; recovery has one authority (transaction.completed) so two events cannot both act.'),
  ('paddle', 'transaction.payment_failed', 'none',
   'Recorded; delinquency has one authority (subscription.past_due) so two events cannot both act.'),
  ('paddle', 'transaction.billed',       'none', 'Recorded for reconciliation only.'),
  ('paddle', 'transaction.created',      'none', 'Recorded for reconciliation only.'),
  ('paddle', 'transaction.ready',        'none', 'Recorded for reconciliation only.'),
  ('paddle', 'transaction.updated',      'none', 'Recorded for reconciliation only.'),
  ('paddle', 'transaction.canceled',     'none', 'Recorded for reconciliation only.'),
  ('paddle', 'transaction.past_due',     'none',
   'Recorded; delinquency has one authority (subscription.past_due) so two events cannot both act.'),
  ('paddle', 'transaction.revised',      'none', 'Recorded for reconciliation only.'),
  ('paddle', 'adjustment.created',       'apply_refund',
   'A refund may already be approved on creation (#224/#225); the transition acts only if it is.'),
  ('paddle', 'adjustment.updated',       'apply_refund',
   'A refund reaching approved status (#224/#225); partial changes no plan, full moves to Free.');

-- ===== 3. Which provider price is which plan =====
-- Deliberately EMPTY. What a Paddle price grants is a pricing decision (#195/#208) and inventing a
-- mapping here would be exactly the silent guess OPEN-DECISIONS.md:3 forbids. Until an owner-signed
-- catalogue fills this table, an activation whose price is unmapped dead-letters and grants
-- nothing -- which is the correct failure, because the alternative is granting a guessed plan.
create table private.billing_provider_price_map (
  provider          text not null check (provider ~ '^[a-z][a-z0-9_]*$'),
  provider_price_id text not null check (length(btrim(provider_price_id)) between 1 and 200),
  plan_key          text not null references subscription_plans(plan_key) on delete restrict,
  note              text,
  created_at        timestamptz not null default now(),
  primary key (provider, provider_price_id)
);
revoke all on table private.billing_provider_price_map
  from public, anon, authenticated, service_role;
comment on table private.billing_provider_price_map is
  'Provider price id to plan (0187). Seeded empty on purpose: an unmapped price dead-letters '
  'rather than granting a guessed plan.';

-- ===== 4. Scheduled changes =====
-- #216 and #219: a change between paid plans, an interval change and a cancellation all take
-- effect at the next renewal, never mid-period and never with proration. The provider owns the
-- schedule; this table is our readable copy of it, so a customer can be told honestly what is
-- about to happen and so a resume knows what it is withdrawing.
create table private.subscription_scheduled_changes (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references organizations(id) on delete restrict,
  provider                text not null,
  action                  text not null check (action in ('cancel', 'resume')),
  effective_at            timestamptz not null,
  source_billing_event_id uuid not null references private.billing_events(id) on delete restrict,
  recorded_at             timestamptz not null default now(),
  withdrawn_at            timestamptz
);
revoke all on table private.subscription_scheduled_changes
  from public, anon, authenticated, service_role;
-- One live schedule per organization: the provider has one answer, and so does this table.
create unique index subscription_scheduled_changes_live_idx
  on private.subscription_scheduled_changes (org_id) where withdrawn_at is null;

-- ===== 5. The dead-letter queue =====
-- 0157's `dead_letter` status means one specific thing -- we could not attribute the event -- and
-- its shape constraint pins org_id to null for exactly that reason. An attributable event that no
-- transition may act on is a different failure with a different audience: it belongs to a known
-- customer, and somebody has to work it. It gets its own table rather than a weakened constraint.
create table private.billing_event_dead_letters (
  id               uuid primary key default gen_random_uuid(),
  -- Unique: a re-delivered event must not be able to queue a second complaint about itself.
  billing_event_id uuid not null unique references private.billing_events(id) on delete restrict,
  org_id           uuid references organizations(id) on delete restrict,
  provider         text not null,
  event_type       text not null,
  reason_code      text not null check (reason_code ~ '^[a-z][a-z0-9_]*$'),
  detail           text not null check (length(btrim(detail)) > 0),
  created_at       timestamptz not null default now()
);
revoke all on table private.billing_event_dead_letters
  from public, anon, authenticated, service_role;
create index billing_event_dead_letters_recent_idx
  on private.billing_event_dead_letters (created_at desc);
comment on table private.billing_event_dead_letters is
  'Attributable provider events that no transition was allowed to act on (0187). The row IS the '
  'evidence: an event that changes nothing must be visible, because silence looks like success.';

-- ===== 6. Rejected at the door =====
-- A request whose signature does not verify is NOT a provider event and must never be written to
-- private.billing_events. That table uniques on the event id the request CLAIMS, so recording an
-- unverified one would let an attacker pre-register an identifier and make the genuine delivery
-- look like a replay. So a rejection is counted, with no identifier the caller supplied: the
-- operator learns that unverifiable traffic is arriving without the ledger being poisonable.
create table private.billing_ingress_rejections (
  id          uuid primary key default gen_random_uuid(),
  provider    text not null check (provider ~ '^[a-z][a-z0-9_]*$'),
  reason_code text not null check (reason_code in (
    'signature_invalid', 'not_configured', 'not_authorized', 'unsupported', 'payload_invalid')),
  occurred_at timestamptz not null default statement_timestamp()
);
revoke all on table private.billing_ingress_rejections
  from public, anon, authenticated, service_role;
create index billing_ingress_rejections_recent_idx
  on private.billing_ingress_rejections (occurred_at desc);

create or replace function public.service_record_billing_ingress_rejection(
  p_provider text, p_reason_code text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  insert into private.billing_ingress_rejections (provider, reason_code)
  values (p_provider, p_reason_code);
end
$$;
revoke all on function public.service_record_billing_ingress_rejection(text, text)
  from public, anon, authenticated;
grant execute on function public.service_record_billing_ingress_rejection(text, text)
  to service_role;

-- ===== 7. The new state machine on the 0157 ledger =====
-- Overturning 0157's two-state claim, deliberately and in writing. `stored` keeps its meaning
-- exactly -- attributed, nothing acted on it -- and now covers both an informational event and one
-- still awaiting its transition. `processed` means a named transition ran to completion.
-- `dead_letter` is untouched: unattributable, org_id null, reason mandatory.
--
-- Read the LIVE definitions before dropping them. There is no `create or replace` for a
-- constraint, so a drop is unconditional and a blind one would silently discard a rule somebody
-- tightened after 0157 -- in a database that, unlike the migration history, we cannot read by
-- opening a file. If either constraint is not the 0157 text this file was written against, refuse
-- rather than widen something we have not actually seen.
do $verify_0157_constraints$
declare
  v_status_def      text;
  v_attribution_def text;
begin
  select pg_get_constraintdef(oid) into v_status_def from pg_constraint
  where conrelid = 'private.billing_events'::regclass and conname = 'billing_events_status_check';
  select pg_get_constraintdef(oid) into v_attribution_def from pg_constraint
  where conrelid = 'private.billing_events'::regclass
    and conname = 'billing_events_attribution_shape';

  if v_status_def is null or v_attribution_def is null then
    raise exception '0187: a 0157 billing_events constraint is absent -- refusing to widen blindly';
  end if;
  if v_status_def !~ '\mstored\M' or v_status_def !~ '\mdead_letter\M'
     or v_status_def ~ '\mprocessed\M' then
    raise exception '0187: billing_events_status_check is not the 0157 two-state definition '
                    '-- refusing to replace blindly (live: %)', v_status_def;
  end if;
  if v_attribution_def !~ '\mstored\M' or v_attribution_def !~ '\mdead_letter\M'
     or v_attribution_def ~ '\mprocessed\M' then
    raise exception '0187: billing_events_attribution_shape is not the 0157 definition '
                    '-- refusing to replace blindly (live: %)', v_attribution_def;
  end if;
end
$verify_0157_constraints$;

alter table private.billing_events drop constraint billing_events_status_check;
alter table private.billing_events add constraint billing_events_status_check
  check (status in ('stored', 'processed', 'dead_letter'));
alter table private.billing_events drop constraint billing_events_attribution_shape;
alter table private.billing_events add constraint billing_events_attribution_shape check (
  (status in ('stored', 'processed') and org_id is not null and dead_letter_reason is null)
  or (status = 'dead_letter' and org_id is null and dead_letter_reason is not null));

-- ===== 8. The transitions =====
-- Every one of them takes the organization as its own argument, sourced by the dispatcher from
-- private.billing_events.org_id. None of them derives an organization from p_data. They return a
-- jsonb verdict rather than raising, so the dispatcher can turn a refusal into a dead letter
-- without an exception handler having to guess what went wrong.
--
-- The verdict shape: {changed boolean, reason_code text|null, detail text, summary jsonb}.
-- reason_code non-null means "dead-letter this, change nothing".

create or replace function private.billing_verdict(
  p_changed boolean, p_reason_code text, p_detail text, p_summary jsonb default '{}'::jsonb
) returns jsonb
language sql immutable as $$
  select jsonb_build_object('changed', p_changed, 'reason_code', p_reason_code,
                            'detail', p_detail, 'summary', coalesce(p_summary, '{}'::jsonb))
$$;

-- Paddle's billing_cycle.interval, verified 23.08.2026, is 'month' / 'year' / 'week' / 'day'.
-- Only the two the plan model sells are translatable; anything else is a refusal, not a default.
create or replace function private.billing_interval_from_provider(p_interval text)
returns text language sql immutable as $$
  select case p_interval when 'month' then 'monthly' when 'year' then 'yearly' end
$$;

/**
 * Reconciles our subscription row with what the provider says it is right now.
 *
 * This is how #216 is honoured without us keeping a second schedule for plan and interval: we
 * asked the provider to change at the next renewal with no proration, so whatever the provider
 * reports as the CURRENT plan is, by construction, the change having arrived at the renewal. The
 * only schedule we keep our own copy of is cancel/resume (#219), because a customer has to be
 * told the date and a resume has to know what it is withdrawing.
 */
create or replace function private.billing_apply_subscription_state(
  p_org_id uuid, p_data jsonb, p_event_id uuid, p_provider text, p_activate boolean
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_price_id  text := p_data -> 'items' -> 0 -> 'price' ->> 'id';
  v_plan_key  text;
  v_interval  text := private.billing_interval_from_provider(p_data -> 'billing_cycle' ->> 'interval');
  v_starts_at timestamptz := nullif(p_data -> 'current_billing_period' ->> 'starts_at', '')::timestamptz;
  v_ends_at   timestamptz := nullif(p_data -> 'current_billing_period' ->> 'ends_at', '')::timestamptz;
  v_renews_at timestamptz := nullif(p_data ->> 'next_billed_at', '')::timestamptz;
  v_scheduled text := p_data -> 'scheduled_change' ->> 'action';
  v_effective timestamptz := nullif(p_data -> 'scheduled_change' ->> 'effective_at', '')::timestamptz;
  v_before    jsonb;
begin
  if v_price_id is null then
    return private.billing_verdict(false, 'price_absent',
      'the subscription entity named no price, so no plan can be resolved');
  end if;

  select map.plan_key into v_plan_key from private.billing_provider_price_map map
  where map.provider = p_provider and map.provider_price_id = v_price_id;
  if v_plan_key is null then
    return private.billing_verdict(false, 'plan_unmapped',
      format('provider price %s is not mapped to a plan; granting a guessed plan is not an option',
             v_price_id));
  end if;

  if v_interval is null then
    return private.billing_verdict(false, 'interval_unrecognized',
      format('billing_cycle.interval %L is not one of the intervals this plan model sells',
             p_data -> 'billing_cycle' ->> 'interval'));
  end if;

  -- Pause is a real commercial state with no decided product behaviour (#210 decides cancellation
  -- and delinquency). Refusing here is what keeps a paused customer from silently keeping paid
  -- entitlement the provider has stopped billing for.
  if v_scheduled = 'pause' then
    return private.billing_verdict(false, 'paused_not_decided',
      'the provider scheduled a pause; the product has no decided behaviour for a paused plan');
  end if;
  if v_scheduled is not null and v_scheduled not in ('cancel', 'resume') then
    return private.billing_verdict(false, 'scheduled_change_unrecognized',
      format('the provider scheduled %L, which this build does not recognise', v_scheduled));
  end if;
  if v_scheduled is not null and v_effective is null then
    return private.billing_verdict(false, 'scheduled_change_unrecognized',
      'the provider scheduled a change with no effective date');
  end if;

  select to_jsonb(existing) into v_before
  from organization_subscriptions existing where existing.org_id = p_org_id for update;
  if v_before is null then
    return private.billing_verdict(false, 'subscription_row_absent',
      'the organization has no subscription row to reconcile');
  end if;

  -- Our copy of the provider's cancel/resume schedule. A report of "no scheduled change" withdraws
  -- whatever we were holding, which is how a resume at the provider reaches the customer's screen.
  update private.subscription_scheduled_changes
     set withdrawn_at = now()
   where org_id = p_org_id and withdrawn_at is null
     and (v_scheduled is null or action is distinct from v_scheduled);
  if v_scheduled is not null and not exists (
    select 1 from private.subscription_scheduled_changes
    where org_id = p_org_id and withdrawn_at is null and action = v_scheduled
  ) then
    insert into private.subscription_scheduled_changes
      (org_id, provider, action, effective_at, source_billing_event_id)
    values (p_org_id, p_provider, v_scheduled, v_effective, p_event_id);
  end if;

  -- The write. Note what is absent: no usage period, no counter, no reset. #242 keeps the usage
  -- anchor on the organization's signup date through every one of these transitions.
  update organization_subscriptions
     set plan_key = v_plan_key,
         billing_interval = v_interval,
         current_period_start = v_starts_at,
         current_period_end = v_ends_at,
         renews_at = v_renews_at,
         -- Activation opens paid entitlement immediately (#217). A plain update never revives a
         -- delinquent organization: only a successful payment does that (#222).
         status = case when p_activate then 'active' else organization_subscriptions.status end,
         canceled_at = case when p_activate then null else organization_subscriptions.canceled_at end,
         updated_at = now()
   where org_id = p_org_id;

  return private.billing_verdict(true, null, 'subscription reconciled with the provider',
    jsonb_build_object('plan_key', v_plan_key, 'billing_interval', v_interval,
                       'scheduled_change', v_scheduled, 'activated', p_activate,
                       'previous_plan_key', v_before ->> 'plan_key'));
end
$$;
revoke all on function private.billing_apply_subscription_state(uuid, jsonb, uuid, text, boolean)
  from public, anon, authenticated;

/** #219/#220/#242: the paid period ended. Free from now on; not one counter moves. */
create or replace function private.billing_downgrade_to_free(p_org_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_before jsonb;
begin
  select to_jsonb(existing) into v_before
  from organization_subscriptions existing where existing.org_id = p_org_id for update;
  if v_before is null then
    return private.billing_verdict(false, 'subscription_row_absent', 'no subscription row');
  end if;
  if v_before ->> 'plan_key' = 'free' then
    return private.billing_verdict(false, null, 'already on Free; the event changed nothing');
  end if;

  update organization_subscriptions
     set plan_key = 'free', status = 'active', canceled_at = null,
         current_period_start = null, current_period_end = null, renews_at = null,
         updated_at = now()
   where org_id = p_org_id;
  update private.subscription_scheduled_changes set withdrawn_at = now()
   where org_id = p_org_id and withdrawn_at is null;

  return private.billing_verdict(true, null, 'the paid period ended; the organization is on Free',
    jsonb_build_object('previous_plan_key', v_before ->> 'plan_key', 'plan_key', 'free'));
end
$$;
revoke all on function private.billing_downgrade_to_free(uuid) from public, anon, authenticated;

/**
 * #221: a renewal charge failed. Immediate read-only, and nothing else -- no move to Free, no
 * deletion, no offboarding. `past_due` is the existing subscription status for exactly this and
 * is deliberately NOT a change to the organization's access mode, which #221 says is a separate
 * concept from Trial/Grace, suspension and offboarding.
 */
create or replace function private.billing_mark_delinquent(p_org_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_status text;
begin
  select existing.status into v_status
  from organization_subscriptions existing where existing.org_id = p_org_id for update;
  if v_status is null then
    return private.billing_verdict(false, 'subscription_row_absent', 'no subscription row');
  end if;
  if v_status = 'past_due' then
    return private.billing_verdict(false, null, 'already delinquent; the event changed nothing');
  end if;

  update organization_subscriptions set status = 'past_due', updated_at = now()
   where org_id = p_org_id;
  return private.billing_verdict(true, null, 'a renewal charge failed; the organization is read-only',
    jsonb_build_object('previous_status', v_status, 'status', 'past_due'));
end
$$;
revoke all on function private.billing_mark_delinquent(uuid) from public, anon, authenticated;

/**
 * #222/#223: the ONLY exit from delinquency is a successful, signed, server-side payment event.
 * A full new billing period opens at the payment-approval timestamp and the next renewal is
 * anchored to it. The usage period is untouched and keeps its signup anchor (#242) -- these are
 * two different clocks and this function moves exactly one of them.
 */
create or replace function private.billing_recover_payment(
  p_org_id uuid, p_approved_at timestamptz
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row      organization_subscriptions;
  v_period   interval;
  v_start    timestamptz := coalesce(p_approved_at, now());
begin
  select * into v_row from organization_subscriptions where org_id = p_org_id for update;
  if not found then
    return private.billing_verdict(false, 'subscription_row_absent', 'no subscription row');
  end if;
  if v_row.status <> 'past_due' then
    -- Not an error and not a dead letter: a successful charge on a healthy subscription is the
    -- normal case, and it must not silently re-anchor a billing period that is already correct.
    return private.billing_verdict(false, null,
      'the subscription was not delinquent; the payment opened no new period');
  end if;

  v_period := case v_row.billing_interval when 'yearly' then interval '1 year'
                                          else interval '1 month' end;
  update organization_subscriptions
     set status = 'active',
         current_period_start = v_start,
         current_period_end = v_start + v_period,
         renews_at = v_start + v_period,
         updated_at = now()
   where org_id = p_org_id;

  -- The keys are prefixed `billing_` on purpose: the #242 anchor below reads this body as text and
  -- refuses any transition that names the usage clock, so the two clocks do not even share a
  -- vocabulary here. That is the anchor doing its job, not an inconvenience to work around.
  return private.billing_verdict(true, null,
    'a late payment was approved; write access is restored and a new billing period opened',
    jsonb_build_object('billing_period_start', v_start, 'billing_period_end', v_start + v_period));
end
$$;
revoke all on function private.billing_recover_payment(uuid, timestamptz)
  from public, anon, authenticated;

/** #219: a cancellation withdrawn before the boundary. Delinquency is NOT cleared by a resume. */
create or replace function private.billing_resume_paid(p_org_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_status text;
begin
  select existing.status into v_status
  from organization_subscriptions existing where existing.org_id = p_org_id for update;
  if v_status is null then
    return private.billing_verdict(false, 'subscription_row_absent', 'no subscription row');
  end if;

  update private.subscription_scheduled_changes set withdrawn_at = now()
   where org_id = p_org_id and withdrawn_at is null and action = 'cancel';
  update organization_subscriptions
     set status = case when v_status = 'past_due' then 'past_due' else 'active' end,
         canceled_at = null, updated_at = now()
   where org_id = p_org_id;

  return private.billing_verdict(true, null, 'the scheduled cancellation was withdrawn',
    jsonb_build_object('status', case when v_status = 'past_due' then 'past_due' else 'active' end));
end
$$;
revoke all on function private.billing_resume_paid(uuid) from public, anon, authenticated;

/**
 * #224/#225. Paddle's adjustment entity (verified 23.08.2026): `action` is one of credit, refund,
 * chargeback, chargeback_reverse, chargeback_warning, chargeback_warning_reverse, credit_reverse;
 * `type` is 'full' ("the grand total for the related transaction is adjusted") or 'partial';
 * `status` is pending_approval, approved, rejected or reversed.
 *
 * Only an APPROVED REFUND acts. A full one ends the paid plan immediately and moves the
 * organization to Free without resetting usage; a partial one changes nothing, which is #225 read
 * literally. A duplicate refund changes nothing because the first already moved the plan and this
 * function is idempotent on state as well as on event id. A chargeback is a money event with no
 * decided product behaviour, so it dead-letters rather than being quietly filed as a refund.
 */
create or replace function private.billing_apply_refund(p_org_id uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_action  text := p_data ->> 'action';
  v_type    text := p_data ->> 'type';
  v_status  text := p_data ->> 'status';
  v_verdict jsonb;
begin
  if v_status is distinct from 'approved' then
    return private.billing_verdict(false, null,
      format('the adjustment is %L, not approved; nothing changes yet', coalesce(v_status, 'absent')));
  end if;
  if v_action is distinct from 'refund' then
    return private.billing_verdict(false, 'adjustment_action_not_decided',
      format('an approved %L adjustment arrived; #224 decides refunds, not this', coalesce(v_action, 'absent')));
  end if;
  if v_type is null or v_type not in ('full', 'partial') then
    return private.billing_verdict(false, 'refund_scope_undeterminable',
      'the refund does not say whether it is full or partial, and the plan effect differs');
  end if;
  if v_type = 'partial' then
    return private.billing_verdict(false, null,
      'a partial refund does not change the plan (#225)');
  end if;

  -- A full refund of a valid charge ends the paid plan immediately (#225) -- the same write as the
  -- end of a cancelled period, told truthfully as the different thing it is.
  v_verdict := private.billing_downgrade_to_free(p_org_id);
  return jsonb_set(v_verdict, '{detail}', to_jsonb(
    case when (v_verdict ->> 'changed')::boolean
      then 'a full refund was approved; the paid plan ended and the organization is on Free'
      else 'a full refund was approved; the organization was already on Free' end));
end
$$;
revoke all on function private.billing_apply_refund(uuid, jsonb) from public, anon, authenticated;

-- ===== 9. The dispatcher =====
create or replace function public.service_apply_billing_event(
  p_provider text, p_provider_event_id text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_event      private.billing_events;
  v_transition text;
  v_verdict    jsonb;
  v_reason     text;
  v_detail     text;
  v_data       jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;

  select * into v_event from private.billing_events
  where provider = p_provider and provider_event_id = p_provider_event_id
  for update;
  if not found then
    raise exception 'billing_event_unknown' using errcode = 'P0002';
  end if;

  -- Replay, first. A provider that retries a delivery sixty times over three days (Paddle's
  -- documented live schedule) must reach the same answer sixty times and cause one effect.
  if v_event.status = 'processed' then
    return jsonb_build_object('status', 'processed', 'applied', false, 'idempotent', true);
  end if;
  if v_event.status = 'dead_letter' then
    return jsonb_build_object('status', 'dead_letter', 'applied', false, 'idempotent', true,
                              'reason_code', 'unattributable');
  end if;
  if exists (select 1 from private.billing_event_dead_letters
             where billing_event_id = v_event.id) then
    return jsonb_build_object('status', 'stored', 'applied', false, 'idempotent', true,
                              'reason_code', 'already_dead_lettered');
  end if;

  -- Fail-closed at the database, not only at the door. #213/#207/#256: every provider is seeded
  -- disabled and nothing in this schema can enable one. A perfectly signed, perfectly attributed
  -- event from an unproven provider therefore changes no entitlement -- visibly.
  if not private.billing_provider_enabled(p_provider) then
    v_reason := 'provider_not_enabled';
    v_detail := format('provider %L is not enabled in the billing boundary; code merge is not '
                       || 'billing activation', p_provider);
  else
    select types.transition into v_transition from private.billing_event_types types
    where types.provider = p_provider and types.event_type = v_event.event_type;

    if v_transition is null then
      v_reason := 'event_type_unrecognized';
      v_detail := format('%L is not on the recognized-event allowlist for %L',
                         v_event.event_type, p_provider);
    elsif v_transition = 'undecided' then
      v_reason := 'transition_undecided';
      v_detail := format('%L is a real commercial state change with no decided product behaviour',
                         v_event.event_type);
    elsif v_transition = 'none' then
      update private.billing_events set status = 'processed' where id = v_event.id;
      return jsonb_build_object('status', 'processed', 'applied', false, 'idempotent', false,
                                'transition', 'none');
    else
      -- The organization comes from the ROW, resolved by 0157 from the provider-customer link we
      -- wrote ourselves. It is never taken from v_data, which is the untrusted document.
      v_data := coalesce(v_event.payload -> 'data', '{}'::jsonb);
      begin
        v_verdict := case v_transition
          when 'activate_paid' then private.billing_apply_subscription_state(
            v_event.org_id, v_data, v_event.id, p_provider, true)
          when 'sync_subscription' then private.billing_apply_subscription_state(
            v_event.org_id, v_data, v_event.id, p_provider, false)
          when 'downgrade_to_free' then private.billing_downgrade_to_free(v_event.org_id)
          when 'mark_delinquent' then private.billing_mark_delinquent(v_event.org_id)
          when 'resume_paid' then private.billing_resume_paid(v_event.org_id)
          when 'recover_payment' then private.billing_recover_payment(
            v_event.org_id, nullif(v_event.payload ->> 'occurred_at', '')::timestamptz)
          when 'apply_refund' then private.billing_apply_refund(v_event.org_id, v_data)
        end;
      exception when others then
        -- An unexpected failure inside a transition rolls this block back, so a half-applied
        -- change cannot survive, and becomes a visible dead letter instead of a 500 the provider
        -- retries sixty times.
        v_verdict := null;
        v_reason := 'transition_failed';
        v_detail := left(coalesce(sqlerrm, 'unknown failure'), 500);
      end;

      if v_verdict is not null and (v_verdict ->> 'reason_code') is not null then
        v_reason := v_verdict ->> 'reason_code';
        v_detail := v_verdict ->> 'detail';
      end if;
    end if;
  end if;

  if v_reason is not null then
    insert into private.billing_event_dead_letters
      (billing_event_id, org_id, provider, event_type, reason_code, detail)
    values (v_event.id, v_event.org_id, p_provider, v_event.event_type, v_reason, v_detail);
    -- The event stays `stored`: it was attributed and it is held. What it did not do is now a row
    -- somebody can work, which is the whole point -- an event that changes nothing must not look
    -- the same as one that succeeded.
    return jsonb_build_object('status', 'stored', 'applied', false, 'idempotent', false,
                              'reason_code', v_reason, 'detail', v_detail);
  end if;

  update private.billing_events set status = 'processed' where id = v_event.id;

  -- Every entitlement-changing transition is audited WITH a reason, to the customer's own log and
  -- to the platform timeline. user_id stays null on purpose: no person did this, a signed provider
  -- event did, and naming an operator would be a lie in the audit trail.
  if (v_verdict ->> 'changed')::boolean then
    insert into audit_logs (org_id, action, entity_type, entity_id, new_values, reason)
    values (v_event.org_id, 'billing_' || v_transition, 'organization_subscriptions',
            v_event.org_id, v_verdict -> 'summary',
            format('%s %s (%s)', p_provider, v_event.event_type, v_verdict ->> 'detail'));
    perform private.record_platform_lifecycle_event(
      v_event.org_id, null, 'billing_transition_applied', 'organization_subscriptions',
      v_event.org_id, null,
      jsonb_build_object('transition', v_transition, 'summary', v_verdict -> 'summary'),
      format('%s %s', p_provider, v_event.event_type));
  end if;

  return jsonb_build_object('status', 'processed', 'idempotent', false,
                            'transition', v_transition,
                            'applied', (v_verdict ->> 'changed')::boolean,
                            'detail', v_verdict ->> 'detail');
end
$$;
revoke all on function public.service_apply_billing_event(text, text)
  from public, anon, authenticated;
grant execute on function public.service_apply_billing_event(text, text) to service_role;

comment on function public.service_apply_billing_event(text, text) is
  'Runs the one named transition a recognized provider event maps to (0187). The organization is '
  'read from private.billing_events.org_id -- resolved by 0157 from the link we wrote -- and never '
  'from the payload. Anything unrecognized, undecided or failing becomes a dead letter and changes '
  'no entitlement. Writes no usage period and no counter (#242).';

-- ===== 10. Re-assert A1 / A3 / A5 (the 0058:207-218 idiom; required of every post-0057 file) =====
do $assert_0187$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0187 scope assertions failed:\n%', v_violations;
  end if;
  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0187 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0187$;

-- ===== 11. Anchors =====
do $anchor_0187$
declare
  v_transition text;
begin
  -- 0157's guarantee, restated because this file is the first thing that could break it: the
  -- attribution function still does not receive a payload and therefore cannot be steered by one.
  if (select pronargs from pg_proc
      where oid = to_regprocedure('private.resolve_billing_org(text,text)')) <> 2 then
    raise exception '0187: resolve_billing_org changed shape -- attribution must not see the payload';
  end if;

  -- #242. A transition that wrote a usage period or a counter would silently give a paying
  -- customer a fresh quota, or take one away on a downgrade. None of them may name that surface.
  foreach v_transition in array array[
    'private.billing_apply_subscription_state(uuid,jsonb,uuid,text,boolean)',
    'private.billing_downgrade_to_free(uuid)',
    'private.billing_mark_delinquent(uuid)',
    'private.billing_recover_payment(uuid,timestamptz)',
    'private.billing_resume_paid(uuid)',
    'private.billing_apply_refund(uuid,jsonb)',
    'public.service_apply_billing_event(text,text)'
  ] loop
    if exists (select 1 from pg_proc where oid = to_regprocedure(v_transition)
               and prosrc ~ '\musage_counters\M|\musage_period\M|\mperiod_start\M') then
      raise exception '0187: % touches the usage period surface; billing and usage are separate (#242)',
        v_transition;
    end if;
  end loop;

  -- No function may enable a provider. Enabling one is a forward-only migration written after the
  -- owner has proven the account (#213), which is a reviewed act, not a runtime toggle.
  if exists (
    select 1 from pg_proc
    where pronamespace in ('public'::regnamespace, 'private'::regnamespace)
      and prosrc ~ '\mbilling_provider_boundary\M'
      and prosrc ~* '\minsert\M|\mupdate\M|\mdelete\M'
  ) then
    raise exception '0187: a function can write the billing provider boundary';
  end if;

  -- Seeded shut, all of it. A migration that arrived with a provider already on would be the one
  -- thing this whole file exists to make impossible.
  if exists (select 1 from private.billing_provider_boundary where enabled) then
    raise exception '0187: a billing provider was seeded enabled';
  end if;

  -- The dispatcher is service_role only: a browser JWT must never reach a transition.
  if has_function_privilege('anon', 'public.service_apply_billing_event(text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.service_apply_billing_event(text,text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.service_apply_billing_event(text,text)', 'EXECUTE')
  then
    raise exception '0187: the billing transition dispatcher is not service_role only';
  end if;

  -- No role holds a direct grant on any of the new ledgers.
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'private'
      and table_name in ('billing_provider_boundary', 'billing_event_types',
                         'billing_provider_price_map', 'subscription_scheduled_changes',
                         'billing_event_dead_letters', 'billing_ingress_rejections')
      and grantee in ('anon', 'authenticated', 'service_role')
  ) then
    raise exception '0187: a role holds a direct grant on a billing ledger';
  end if;

  -- The price map must arrive empty: a seeded mapping would be an invented pricing decision.
  if exists (select 1 from private.billing_provider_price_map) then
    raise exception '0187: the provider price map was seeded with a guessed plan mapping';
  end if;
end
$anchor_0187$;
