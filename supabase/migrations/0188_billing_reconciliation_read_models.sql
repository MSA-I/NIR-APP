-- Wave 2 of Subscriptions/Billing/Usage -- what a Platform Admin can SEE about the processor 0187
-- built. Four reads, no writes, no new state.
--
-- WHY THIS FILE EXISTS AT ALL. A webhook processor's characteristic failure is not a crash, it is
-- silence: an event arrives, nothing acts on it, and every surface looks exactly as it does when
-- everything is fine. So `received`, `processed`, `dead_lettered`, `awaiting` and `unattributable`
-- are five separate numbers rather than one health tick, and 0187's dead-letter row and ingress
-- rejection counter are given a door a human can actually walk through. Drift you cannot see is
-- drift you find out about from a customer.
--
-- THE COLUMNS MUST ADD UP. `received = processed + dead_lettered + awaiting + unattributable`, and
-- p71 asserts it for every row. A read model whose parts do not sum to its whole is precisely how
-- an event goes missing between two columns and nobody notices for a month.
--
-- NO PAYLOAD, ANYWHERE. 0157 anchored that its two operator reads cannot return a payment
-- processor's raw dump of a customer's card metadata to a console; these four inherit the rule and
-- this file re-anchors it over all six together.
--
-- SCOPED TO NAMED OBJECTS ONLY. Nothing here enumerates tables, functions or schemas to look for
-- drift. A read model that scanned the catalogue would report whatever else happens to be in the
-- database it runs against -- which differs between a developer's stack and CI -- and would then
-- be green in one place and red in the other for reasons that have nothing to do with billing.
--
-- STILL NO WAY TO ENABLE A PROVIDER. platform_billing_boundary() reads the flags; it cannot set
-- one. Enabling a merchant of record remains a forward-only migration written after the owner has
-- proven the account (#213), and 0187's anchor -- re-run here -- fails the build if any function
-- acquires the ability to write that table.

-- ===== 1. Received versus applied versus dead-lettered =====
create or replace function public.platform_billing_reconciliation(
  p_from timestamptz default now() - interval '30 days',
  -- Unbounded by default, NOT now(). now() is the transaction start time, so an event recorded
  -- earlier in the same transaction has a later received_at and a now() upper bound would silently
  -- exclude it. A reconciliation read that cannot see what just happened is worse than none.
  p_to   timestamptz default null
)
returns table (
  provider       text,
  event_type     text,
  received       bigint,
  processed      bigint,
  dead_lettered  bigint,
  awaiting       bigint,
  unattributable bigint,
  last_received  timestamptz
)
language sql stable security definer set search_path = public as $$
  select event.provider,
         event.event_type,
         count(*),
         -- Applied: a named transition ran to completion over it.
         count(*) filter (where event.status = 'processed'),
         -- Held for a human: attributed, and something refused to act on it.
         count(*) filter (where dead.id is not null),
         -- Neither. An event sitting here is the one an operator most needs to notice, so it gets
         -- its own column instead of being quietly absorbed by one of the two above.
         count(*) filter (where event.status = 'stored' and dead.id is null),
         -- Belongs to no customer we can identify: 0157's own dead-letter state.
         count(*) filter (where event.status = 'dead_letter'),
         max(event.received_at)
  from private.billing_events event
  left join private.billing_event_dead_letters dead on dead.billing_event_id = event.id
  where event.received_at >= coalesce(p_from, now() - interval '30 days')
    and (p_to is null or event.received_at <= p_to)
    and is_platform_admin() and public.platform_has_capability('billing.view')
  group by event.provider, event.event_type
  order by max(event.received_at) desc
$$;
revoke all on function public.platform_billing_reconciliation(timestamptz, timestamptz)
  from public, anon;
grant execute on function public.platform_billing_reconciliation(timestamptz, timestamptz)
  to authenticated;

comment on function public.platform_billing_reconciliation(timestamptz, timestamptz) is
  'Provider events received versus transitions applied versus dead-lettered (0188). The columns '
  'sum to `received` by construction so an event cannot go missing between them.';

-- ===== 2. The queue somebody has to work =====
-- Attributed events that no transition was allowed to act on. The organization is named, because
-- these belong to a known customer and the operator has to be able to call them back.
create or replace function public.platform_billing_dead_letter_queue(p_limit integer default 50)
returns table (
  id            uuid,
  org_id        uuid,
  organization  text,
  provider      text,
  event_type    text,
  reason_code   text,
  detail        text,
  created_at    timestamptz
)
language sql stable security definer set search_path = public as $$
  select dead.id, dead.org_id, org.name, dead.provider, dead.event_type,
         dead.reason_code, dead.detail, dead.created_at
  from private.billing_event_dead_letters dead
  left join organizations org on org.id = dead.org_id
  where is_platform_admin() and public.platform_has_capability('billing.view')
  order by dead.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200)
$$;
revoke all on function public.platform_billing_dead_letter_queue(integer) from public, anon;
grant execute on function public.platform_billing_dead_letter_queue(integer) to authenticated;

-- ===== 3. Which provider is live, and on whose decision =====
create or replace function public.platform_billing_boundary()
returns table (
  provider           text,
  role               text,
  enabled            boolean,
  decision_reference text,
  readiness          text,
  enabled_at         timestamptz,
  enable_reason      text
)
language sql stable security definer set search_path = public as $$
  select boundary.provider, boundary.role, boundary.enabled, boundary.decision_reference,
         boundary.readiness, boundary.enabled_at, boundary.enable_reason
  from private.billing_provider_boundary boundary
  where is_platform_admin() and public.platform_has_capability('billing.view')
  order by boundary.role, boundary.provider
$$;
revoke all on function public.platform_billing_boundary() from public, anon;
grant execute on function public.platform_billing_boundary() to authenticated;

comment on function public.platform_billing_boundary() is
  'Reads the provider flags (0188). There is no matching setter on purpose: enabling a merchant '
  'of record is a forward-only migration written after the owner proves the account (#213).';

-- ===== 4. What never got through the door =====
-- Unverifiable traffic, counted by 0187 without any identifier the caller supplied. A sudden run
-- of these is either a rotated secret nobody told us about or somebody probing the endpoint, and
-- both are things an operator should be able to see before a customer reports a missing upgrade.
create or replace function public.platform_billing_ingress_rejections(
  p_from timestamptz default now() - interval '30 days',
  -- Unbounded by default, for the same reason as the reconciliation read above.
  p_to   timestamptz default null
)
returns table (
  provider      text,
  reason_code   text,
  rejected      bigint,
  last_rejected timestamptz
)
language sql stable security definer set search_path = public as $$
  select rejection.provider, rejection.reason_code, count(*), max(rejection.occurred_at)
  from private.billing_ingress_rejections rejection
  where rejection.occurred_at >= coalesce(p_from, now() - interval '30 days')
    and (p_to is null or rejection.occurred_at <= p_to)
    and is_platform_admin() and public.platform_has_capability('billing.view')
  group by rejection.provider, rejection.reason_code
  order by max(rejection.occurred_at) desc
$$;
revoke all on function public.platform_billing_ingress_rejections(timestamptz, timestamptz)
  from public, anon;
grant execute on function public.platform_billing_ingress_rejections(timestamptz, timestamptz)
  to authenticated;

-- ===== 5. Re-assert A1 / A3 / A5 (the 0058:207-218 idiom; required of every post-0057 file) =====
do $assert_0188$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0188 scope assertions failed:\n%', v_violations;
  end if;
  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0188 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0188$;

-- ===== 6. Anchors =====
do $anchor_0188$
declare
  v_read text;
begin
  -- 0157's rule, now covering all six operator billing reads: none of them returns the raw
  -- payload. An operator needs to know that an event arrived and what it did, not to read a
  -- payment processor's dump of a customer's card metadata out of a console.
  if exists (
    select 1 from pg_proc
    where oid in (
      to_regprocedure('public.platform_billing_events(uuid,integer)'),
      to_regprocedure('public.platform_billing_dead_letters(integer)'),
      to_regprocedure('public.platform_billing_reconciliation(timestamptz,timestamptz)'),
      to_regprocedure('public.platform_billing_dead_letter_queue(integer)'),
      to_regprocedure('public.platform_billing_boundary()'),
      to_regprocedure('public.platform_billing_ingress_rejections(timestamptz,timestamptz)'))
      and prosrc ~ '\mpayload\M'
  ) then
    raise exception '0188: an operator billing read returns the provider payload';
  end if;

  -- Every new read is gated, and none of them is reachable anonymously.
  foreach v_read in array array[
    'public.platform_billing_reconciliation(timestamptz,timestamptz)',
    'public.platform_billing_dead_letter_queue(integer)',
    'public.platform_billing_boundary()',
    'public.platform_billing_ingress_rejections(timestamptz,timestamptz)'
  ] loop
    if to_regprocedure(v_read) is null then
      raise exception '0188: % was not created', v_read;
    end if;
    if has_function_privilege('anon', v_read, 'EXECUTE') then
      raise exception '0188: % is reachable anonymously', v_read;
    end if;
    if not exists (select 1 from pg_proc where oid = to_regprocedure(v_read)
                   and prosrc ~ '\mis_platform_admin\M'
                   and prosrc ~ '\mplatform_has_capability\M') then
      raise exception '0188: % does not gate on a platform admin holding billing.view', v_read;
    end if;
  end loop;

  -- 0187's guarantee, re-run because this file is the one that adds functions naming the boundary
  -- table: reading the flags is allowed, writing them is not.
  if exists (
    select 1 from pg_proc
    where pronamespace in ('public'::regnamespace, 'private'::regnamespace)
      and prosrc ~ '\mbilling_provider_boundary\M'
      and prosrc ~* '\minsert\M|\mupdate\M|\mdelete\M'
  ) then
    raise exception '0188: a function can write the billing provider boundary';
  end if;
  if exists (select 1 from private.billing_provider_boundary where enabled) then
    raise exception '0188: a billing provider is enabled; code merge is not billing activation';
  end if;
end
$anchor_0188$;
