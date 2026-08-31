-- 0268 -- the product email that follows a verified subscription activation, owed exactly once.
--
-- WHAT THIS IS FOR, AND WHAT PADDLE KEEPS. Paddle is the merchant of record (#207): it charged the
-- customer, so it owes the receipt, the invoice and the tax document, and it sends them. InPlace
-- must not issue a second document for the same money -- two receipts for one payment is not
-- redundancy, it is a bookkeeping error with our name on it. What Paddle does NOT send is the
-- product sentence: your plan is live, this is what it is called, here is the way in. That is the
-- only email this migration is about.
--
-- EXACTLY ONCE, ENFORCED BY THE PRIMARY KEY. org_id is the key. Not the event id, which would send
-- a fresh welcome after every resume; not a period, which would send one a month. A provider
-- redelivery, a plan change and a re-activation two years later all collide with the same row and
-- do nothing. Paddle retries a delivery up to sixty times across three days, and Resend's
-- Idempotency-Key expires after twenty-four hours, so the database is the only place this
-- guarantee can actually live.
--
-- WHERE THE ADDRESS COMES FROM. The organization's OWNER, read server-side from the profile table
-- we write. Never from the provider payload: 0157's rule is that a payload chooses nothing, and an
-- address is a thing worth choosing if you are an attacker holding a checkout form.
--
-- NOTHING HERE SENDS ANYTHING, AND NOTHING HERE CAN. This migration records a debt and hands a
-- claim/settle pair to service_role. The sender is an Edge Function, and it cannot run today for
-- the reason everything else in this area cannot: the provider boundary (0187) seeds Paddle
-- DISABLED, so no activation transition executes, so no row is ever inserted. Applying this
-- migration is not billing activation and cannot become it by configuration.

-- ===== 1. The ledger =====
create table private.subscription_activation_emails (
  -- The organization, and therefore the once-ness. A second activation finds this row and stops.
  org_id              uuid primary key references organizations(id) on delete restrict,
  -- Which verified event created the debt. Traceability, never attribution: the org came from the
  -- provider-customer link we wrote, and this column is written from that same resolved value.
  billing_event_id    uuid not null references private.billing_events(id) on delete restrict,
  plan_key            text not null references subscription_plans(plan_key) on delete restrict,
  to_email            text not null check (length(btrim(to_email)) between 3 and 254),
  status              text not null default 'pending'
                        check (status in ('pending', 'sending', 'sent', 'failed')),
  attempt_count       int not null default 0 check (attempt_count between 0 and 5),
  lease_expires_at    timestamptz,
  provider_message_id text,
  error_code          text,
  created_at          timestamptz not null default now(),
  sent_at             timestamptz,
  -- A sent row carries its timestamp and holds no lease. The shape is checked rather than
  -- remembered, because "sent" with a live lease is the state a duplicate send comes from.
  constraint subscription_activation_emails_sent_shape check (
    (status = 'sent' and sent_at is not null and lease_expires_at is null)
    or (status <> 'sent' and sent_at is null))
);
revoke all on table private.subscription_activation_emails
  from public, anon, authenticated, service_role;

create index subscription_activation_emails_pending_idx
  on private.subscription_activation_emails (created_at)
  where status in ('pending', 'sending');

comment on table private.subscription_activation_emails is
  'One row per organization, ever: the product email owed after a verified paid activation (0268). '
  'Paddle keeps the receipt; this is the plan-is-live sentence. The primary key is what makes a '
  'redelivery, a resume and a later re-activation all send nothing.';

-- ===== 2. Whose address =====
--
-- Its own function so the ledger and the sender cannot disagree about who "the customer" is, and
-- so the rule is one line to read: the ACTIVE OWNER of the organization, and null when there is
-- none. Returning null rather than raising matters -- an organization with no active owner is a
-- support problem, not a reason to roll back an entitlement the customer has paid for.
--
-- The address lives in auth.users, not on the profile: the profile carries org, role and activity
-- and deliberately holds no email, so identity has exactly one home (the 0152 idiom). Reaching
-- into the auth schema is why this function is SECURITY DEFINER and why no tenant role may run it.
create function private.subscription_activation_owner_email(p_org_id uuid)
returns text
language sql stable security definer set search_path = public, pg_temp as $fn$
  select account.email::text
  from profiles p
  join auth.users account on account.id = p.id
  where p.org_id = p_org_id and p.role = 'owner' and p.active
    and account.email is not null and length(btrim(account.email::text)) > 2
  order by p.created_at
  limit 1
$fn$;
revoke all on function private.subscription_activation_owner_email(uuid)
  from public, anon, authenticated, service_role;

-- ===== 3. The transition, redeclared with one line added =====
--
-- The body below is 0187's, copied verbatim from that file rather than retyped, with a single
-- insert added before the success return. It was diffed against the LIVE definition first: the
-- deployed body matched 0187 exactly, so no later migration's change is being reverted here.
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

  -- THE ONLY NEW LINE IN THIS BODY (0268). Everything above is 0187 verbatim.
  --
  -- An activation that reached this point is verified, attributed and applied. Recording that the
  -- organization is owed one activation email HERE, inside the same transaction as the entitlement
  -- write, is what makes the two inseparable: the mail cannot be owed for a plan that was not
  -- granted, and cannot be forgotten for one that was.
  --
  -- The primary key is the ORGANIZATION, so this insert is a no-op the second time for any reason
  -- -- a provider redelivery, a resume, a plan change, a second activation years later. Paddle's
  -- documented retry schedule is sixty deliveries over three days; Resend's Idempotency-Key holds
  -- for twenty-four hours, so the provider's own header cannot cover that window and the database
  -- has to. "Welcome to InPlace" is true exactly once.
  if p_activate then
    insert into private.subscription_activation_emails (org_id, billing_event_id, plan_key, to_email)
    select p_org_id, p_event_id, v_plan_key, owner_email.email
    from private.subscription_activation_owner_email(p_org_id) as owner_email(email)
    where owner_email.email is not null
    on conflict (org_id) do nothing;
  end if;

  return private.billing_verdict(true, null, 'subscription reconciled with the provider',
    jsonb_build_object('plan_key', v_plan_key, 'billing_interval', v_interval,
                       'scheduled_change', v_scheduled, 'activated', p_activate,
                       'previous_plan_key', v_before ->> 'plan_key'));
end
$$;

-- ===== 4. The claim/settle pair the sender uses =====
--
-- The same shape 0168 uses for a supplier order: a lease makes a concurrent second sender a no-op,
-- an attempt ceiling stops an infinite retry, and an expired lease is AMBIGUOUS rather than free to
-- retry -- because "we never heard back" is not evidence that nothing was sent. A human decides
-- what to do with an ambiguous row; the machine does not get to guess and risk a second email.
create function public.service_claim_subscription_activation_email()
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_row private.subscription_activation_emails;
begin
  select * into v_row
  from private.subscription_activation_emails
  where status = 'pending'
     or (status = 'sending' and lease_expires_at < now())
  order by created_at
  for update skip locked
  limit 1;

  if not found then
    return jsonb_build_object('state', 'idle');
  end if;

  -- An expired lease is not a licence to send again. Freeze it and let a person look.
  if v_row.status = 'sending' then
    update private.subscription_activation_emails
       set status = 'failed', lease_expires_at = null, error_code = 'lease_expired'
     where org_id = v_row.org_id;
    return jsonb_build_object('state', 'ambiguous', 'org_id', v_row.org_id);
  end if;

  if v_row.attempt_count >= 5 then
    update private.subscription_activation_emails
       set status = 'failed', lease_expires_at = null, error_code = 'retry_limit'
     where org_id = v_row.org_id;
    return jsonb_build_object('state', 'exhausted', 'org_id', v_row.org_id);
  end if;

  update private.subscription_activation_emails
     set status = 'sending',
         attempt_count = attempt_count + 1,
         lease_expires_at = now() + interval '5 minutes',
         error_code = null
   where org_id = v_row.org_id
  returning * into v_row;

  -- The LABEL and the locale are resolved here, at claim time, rather than frozen into the ledger
  -- at activation. A plan's display name is a product string that may be corrected between the
  -- activation and the send, and the customer should read the current one. The plan KEY is what is
  -- stored, because that is the identity; the label is only how it is spelled.
  return jsonb_build_object(
    'state', 'claimed',
    'org_id', v_row.org_id,
    'to_email', v_row.to_email,
    'plan_key', v_row.plan_key,
    'plan_label', (select plan.label from subscription_plans plan
                    where plan.plan_key = v_row.plan_key),
    'locale', coalesce((select p.locale::text from profiles p
                         where p.org_id = v_row.org_id and p.role = 'owner' and p.active
                         order by p.created_at limit 1), 'he'),
    'attempt', v_row.attempt_count);
end
$fn$;
revoke all on function public.service_claim_subscription_activation_email()
  from public, anon, authenticated;
grant execute on function public.service_claim_subscription_activation_email() to service_role;

create function public.service_settle_subscription_activation_email(
  p_org_id uuid, p_outcome text, p_provider_message_id text, p_error_code text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_row private.subscription_activation_emails;
begin
  if p_outcome not in ('sent', 'failed') then
    raise exception 'activation_email_outcome_invalid' using errcode = '22023';
  end if;

  select * into v_row from private.subscription_activation_emails
  where org_id = p_org_id for update;
  if not found then
    raise exception 'activation_email_unknown' using errcode = 'P0002';
  end if;

  -- Settling a row that is already sent is a no-op, not an error and not a second send. A retried
  -- settlement call must reach the same answer as the first one.
  if v_row.status = 'sent' then
    return jsonb_build_object('state', 'already_sent', 'org_id', p_org_id);
  end if;

  update private.subscription_activation_emails
     set status = p_outcome,
         lease_expires_at = null,
         sent_at = case when p_outcome = 'sent' then now() else null end,
         provider_message_id = case when p_outcome = 'sent' then p_provider_message_id else null end,
         error_code = case when p_outcome = 'sent' then null else left(p_error_code, 100) end
   where org_id = p_org_id;

  return jsonb_build_object('state', p_outcome, 'org_id', p_org_id);
end
$fn$;
revoke all on function public.service_settle_subscription_activation_email(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.service_settle_subscription_activation_email(uuid, text, text, text)
  to service_role;

-- ===== 5. Assertions -- the invariants, checked at apply time rather than believed =====
do $assert$
declare
  v_violations text;
begin
  -- The once-ness is structural, not a convention somebody has to remember.
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'private' and t.relname = 'subscription_activation_emails'
      and c.contype = 'p' and array_length(c.conkey, 1) = 1
  ) then
    raise exception '0268: the activation ledger must be keyed on the organization alone';
  end if;

  -- No tenant-reachable role may read or write the ledger or run its commands.
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'private' and table_name = 'subscription_activation_emails'
      and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
  ) then
    raise exception '0268: the activation ledger is reachable by a role that must not see it';
  end if;
  if has_function_privilege('authenticated',
       'public.service_claim_subscription_activation_email()', 'EXECUTE')
     or has_function_privilege('anon',
       'public.service_claim_subscription_activation_email()', 'EXECUTE') then
    raise exception '0268: the activation-email claim is executable by a tenant role';
  end if;

  -- The transition still resolves its plan from the price MAP, not from the payload. Rewriting a
  -- body by hand is exactly how that gets lost, so the redeclaration above is checked for it.
  if position('billing_provider_price_map' in
      replace(pg_get_functiondef('private.billing_apply_subscription_state(uuid,jsonb,uuid,text,boolean)'::regprocedure),
              chr(13), '')) = 0 then
    raise exception '0268: the activation transition no longer resolves its plan from the price map';
  end if;

  -- And it is still SECURITY DEFINER with a pinned search_path. A create-or-replace that dropped
  -- either would be silent and catastrophic.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'billing_apply_subscription_state'
      and p.prosecdef and 'search_path=public, pg_temp' = any(p.proconfig)
  ) then
    raise exception '0268: the activation transition lost SECURITY DEFINER or its search_path';
  end if;

  -- Merging this file is not billing activation. If it ever is, this assertion is the alarm.
  if private.billing_provider_enabled('paddle') then
    raise exception '0268: paddle is enabled; this migration must not be the thing that did it';
  end if;

  -- The 0057 gate, re-run as every migration after it must. This file adds a table and three
  -- SECURITY DEFINER functions, which is exactly the surface A1/A3/A5 exist to catch.
  select string_agg(detail, chr(10) order by detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception '0268 scope assertions failed: %', v_violations;
  end if;
end
$assert$;
