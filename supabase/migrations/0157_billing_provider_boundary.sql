-- Wave 6a of Customer Operations (owner decision 19.08.2026: "demo only, but prepare the ground")
-- -- the billing provider boundary, with no provider behind it.
--
-- Shape: an internal model that knows nothing about any provider's payload shape, plus an
-- ingestion seam that is idempotent, attributable and auditable before anything acts on it. The
-- adapter interface lives in TypeScript (supabase/functions/_shared/billing/); this file is the
-- half that has to be right in the database, because idempotency and attribution are not things
-- an adapter can promise on its own.
--
-- THE ATTACK THIS FILE EXISTS TO CLOSE. Every hosted billing provider puts arbitrary `metadata` on
-- its webhook payloads, and the obvious implementation reads an org_id out of it. That makes the
-- payload -- an untrusted document from outside -- the thing that decides which customer gets
-- upgraded. Here the organization is resolved ONLY through
-- organization_subscriptions.provider_customer_id, which we wrote ourselves when we created the
-- customer with the provider, and which carries a unique index (0154) so the resolution is
-- single-valued. An event we cannot attribute that way becomes a dead letter and mutates nothing.
--
-- TWO STATES, NOT FIVE. `stored` and `dead_letter`. There is deliberately no `processed` or
-- `failed`, because nothing processes yet: this build acts on no billing event at all, and a
-- status enum full of states that can never occur is a description of a system that does not
-- exist. When a processor lands it adds its own states and the suite that proves them.
--
-- WHY private, not public. These rows hold a payment processor's raw payload: customer
-- identifiers, amounts, email addresses, and whatever else the provider decided to include. No
-- tenant reads them, so there is no reason to buy them an export-registry row and a write guard,
-- and every reason not to let them near a browser role. The operator reads through a scoped
-- function that never returns the payload.
--
-- What this deliberately does not cover: no HTTP endpoint. A webhook route with no provider
-- behind it cannot verify a signature against a secret that does not exist, and an endpoint that
-- accepts unsigned payloads is a hole rather than groundwork. When a provider is chosen, the
-- remaining work is a signature check and a parser -- the storage, the idempotency, the
-- attribution and the audit are here and tested. Nothing in this file changes a subscription:
-- an operator still does that through platform_set_org_subscription, with step-up and a reason.

-- ===== 1. The event ledger =====
create table private.billing_events (
  id                   uuid primary key default gen_random_uuid(),
  provider             text not null check (provider ~ '^[a-z][a-z0-9_]*$'),
  -- The provider's own identifier for the event. Together with `provider` it is what makes a
  -- replay a no-op: a webhook delivered three times is one row and one effect.
  provider_event_id    text not null check (length(btrim(provider_event_id)) between 1 and 200),
  event_type           text not null check (length(btrim(event_type)) between 1 and 100),
  provider_customer_id text,
  -- Null exactly when we could not attribute the event. Nullable on purpose: a dead letter that
  -- could not be stored would be an event we silently lost.
  org_id               uuid references organizations(id) on delete restrict,
  status               text not null check (status in ('stored', 'dead_letter')),
  dead_letter_reason   text,
  payload              jsonb not null,
  correlation_id       uuid,
  received_at          timestamptz not null default statement_timestamp(),
  unique (provider, provider_event_id),
  constraint billing_events_attribution_shape check (
    (status = 'stored' and org_id is not null and dead_letter_reason is null)
    or (status = 'dead_letter' and org_id is null and dead_letter_reason is not null))
);
revoke all on table private.billing_events from public, anon, authenticated, service_role;
create index billing_events_org_idx on private.billing_events (org_id, received_at desc);
create index billing_events_dead_letter_idx on private.billing_events (received_at desc)
  where status = 'dead_letter';

comment on table private.billing_events is
  'Raw provider events (0157). The (provider, provider_event_id) unique is the replay guarantee, '
  'and org_id is resolved ONLY from organization_subscriptions.provider_customer_id -- never from '
  'the payload, which is an untrusted document.';

-- ===== 2. Attribution =====
-- The whole security of this boundary is that this function does not read p_payload.
create or replace function private.resolve_billing_org(
  p_provider text, p_provider_customer_id text
) returns uuid
language sql stable security definer set search_path = public as $$
  select subscription.org_id
  from organization_subscriptions subscription
  where subscription.provider = p_provider
    and subscription.provider_customer_id is not null
    and subscription.provider_customer_id = p_provider_customer_id
$$;
revoke all on function private.resolve_billing_org(text, text)
  from public, anon, authenticated;

-- ===== 3. Ingestion =====
-- service_role only: this is the door an Edge Function walks through after it has verified a
-- signature, and a user JWT must never reach it. Same guard shape as the 0103 export services.
create or replace function public.service_record_billing_event(
  p_provider             text,
  p_provider_event_id    text,
  p_event_type           text,
  p_provider_customer_id text,
  p_payload              jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org      uuid;
  v_existing private.billing_events;
  v_id       uuid;
  v_status   text;
  v_reason   text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'billing_payload_invalid' using errcode = '22023';
  end if;

  -- Replay first, before any work: a provider retrying a delivery must reach the same answer and
  -- must not be able to make a second attribution attempt with the same event id.
  select * into v_existing from private.billing_events
  where provider = p_provider and provider_event_id = p_provider_event_id;
  if found then
    return jsonb_build_object(
      'event_id', v_existing.id, 'status', v_existing.status,
      'org_id', v_existing.org_id, 'idempotent', true);
  end if;

  v_org := private.resolve_billing_org(p_provider, p_provider_customer_id);

  if v_org is null then
    v_status := 'dead_letter';
    v_reason := case
      when nullif(btrim(coalesce(p_provider_customer_id, '')), '') is null
        then 'the event carried no provider customer id'
      else 'no organization is linked to this provider customer id' end;
  else
    v_status := 'stored';
  end if;

  insert into private.billing_events (
    provider, provider_event_id, event_type, provider_customer_id, org_id,
    status, dead_letter_reason, payload, correlation_id
  ) values (
    p_provider, p_provider_event_id, p_event_type, p_provider_customer_id, v_org,
    v_status, v_reason, p_payload, public.request_correlation_id()
  ) returning id into v_id;

  -- An attributed event is visible on the customer's own platform timeline. A dead letter is not:
  -- it belongs to no customer by definition, and inventing a timeline for it would mean guessing
  -- which one -- exactly the guess this whole design refuses.
  if v_org is not null then
    perform private.record_platform_lifecycle_event(
      v_org, null, 'billing_event_received', 'billing_events', v_id,
      null, jsonb_build_object('provider', p_provider, 'event_type', p_event_type),
      'billing provider event recorded');
  end if;

  return jsonb_build_object('event_id', v_id, 'status', v_status,
                            'org_id', v_org, 'idempotent', false);
end
$$;
revoke all on function public.service_record_billing_event(text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.service_record_billing_event(text, text, text, text, jsonb)
  to service_role;

-- ===== 4. Operator reads =====
-- The payload is deliberately absent from both. An operator needs to know that an event arrived,
-- when, of what kind, and whether it stuck -- not to read a payment processor's dump of a
-- customer's card metadata out of a console.
create or replace function public.platform_billing_events(
  p_org_id uuid, p_limit integer default 50
)
returns table (
  id uuid, provider text, event_type text, status text,
  received_at timestamptz, correlation_id uuid
)
language sql stable security definer set search_path = public as $$
  select event.id, event.provider, event.event_type, event.status,
         event.received_at, event.correlation_id
  from private.billing_events event
  where event.org_id = p_org_id
    and is_platform_admin() and public.platform_has_capability('billing.view')
  order by event.received_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
$$;
revoke all on function public.platform_billing_events(uuid, integer) from public, anon;
grant execute on function public.platform_billing_events(uuid, integer) to authenticated;

-- Dead letters belong to no customer, so they have their own door rather than appearing under a
-- guessed one. This is the queue somebody has to work; hiding it would mean money events silently
-- landing nowhere.
create or replace function public.platform_billing_dead_letters(p_limit integer default 50)
returns table (
  id uuid, provider text, event_type text, provider_customer_id text,
  dead_letter_reason text, received_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select event.id, event.provider, event.event_type, event.provider_customer_id,
         event.dead_letter_reason, event.received_at
  from private.billing_events event
  where event.status = 'dead_letter'
    and is_platform_admin() and public.platform_has_capability('billing.view')
  order by event.received_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
$$;
revoke all on function public.platform_billing_dead_letters(integer) from public, anon;
grant execute on function public.platform_billing_dead_letters(integer) to authenticated;

-- ===== 5. Structural re-assertion =====
do $assert_0157$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0157 scope assertions failed:\n%', v_violations;
  end if;
  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0157 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0157$;

-- ===== 6. Anchors =====
do $anchor_0157$
begin
  -- The attribution function must not be able to read the payload even by accident: it does not
  -- take one. A future edit that adds a payload argument is the moment this boundary breaks.
  if (select pronargs from pg_proc
      where oid = to_regprocedure('private.resolve_billing_org(text,text)')) <> 2 then
    raise exception '0157: resolve_billing_org changed shape -- attribution must not see the payload';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'private' and table_name = 'billing_events'
      and grantee in ('anon', 'authenticated', 'service_role')
  ) then
    raise exception '0157: a role holds a direct grant on the billing event ledger';
  end if;

  -- Neither operator read may return the raw payload.
  if exists (
    select 1 from pg_proc
    where oid in (to_regprocedure('public.platform_billing_events(uuid,integer)'),
                  to_regprocedure('public.platform_billing_dead_letters(integer)'))
      and prosrc ~ '\mpayload\M'
  ) then
    raise exception '0157: an operator billing read returns the provider payload';
  end if;

  -- No status this build can never produce.
  if exists (
    select 1 from pg_constraint
    where conrelid = 'private.billing_events'::regclass
      and pg_get_constraintdef(oid) ~ '\mprocessed\M|\mfailed\M'
  ) then
    raise exception '0157: billing_events declares a status nothing can reach';
  end if;
end
$anchor_0157$;
