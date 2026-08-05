-- 0066 -- Integration adapters: target registry, external references, failure ledger,
-- and the signed claim (wave 7, PLAN-08).
--
-- Wave 5 shipped the outbox with ZERO auto-enqueue: an event entered the outbox only
-- through the seam private.enqueue_integration_outbox, and nothing called it. This
-- migration registers the first target kind -- webhook subscriptions -- and wires the
-- enqueue path as an AFTER INSERT trigger on public.domain_events (PLAN-08 decision 1):
-- the trigger covers BOTH emission arms (the 0063 audit fan-out and future inline
-- commands) without touching the proven fan-out function. domain_events is registered
-- cross_scope / enforced=false (0063:347-348), so a trigger on it never enters A5's
-- trigger arm.
--
-- Webhook signing (PLAN-08 decision 2, OPEN-DECISIONS #97 -- an invented guardrail,
-- documented as such): the DATABASE signs. claim_integration_outbox is redeclared from
-- its live 0064 definition (ancestry-asserted below) to also return the deterministic
-- body serialization, a timestamp, and an HMAC-SHA256 signature computed with the
-- subscription's Vault secret. The worker copies them into headers verbatim; the secret
-- never leaves Postgres, and the signature is provable in SQL with a known-answer vector
-- (p7_integration_adapters.sql).
--
-- A5 note for every definer body in this file: the six enforced table names never appear
-- in any function body, comments included -- entity names live in DATA columns only
-- (the 0063 fan-out discipline).

-- ===== 1. webhook_subscriptions -- the target registry =====
-- public + org_id, Shape-2 ACL (the 0060 identity_provider_settings precedent): RLS on,
-- NO policies, browser roles fully revoked -- the row references a Vault secret and is
-- written only through the service-role configure command below. Owners read through
-- read_webhook_subscriptions(), which never returns secret_id.
--
-- target is GENERATED from the row id as 'webhook:' || id: the outbox dedup arm is
-- unique(target, event_id) WITHOUT org_id (0064:38), so target must be globally unique
-- by construction -- a shared namespace across tenants is forbidden (PLAN-08 decision 3).
-- A generated column is the strongest form of the derivation: it cannot drift, cannot be
-- written, and carries both unique constraints structurally.
create table public.webhook_subscriptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  target text not null generated always as ('webhook:' || id::text) stored unique,
  url text not null check (url ~* '^https?://' and length(url) <= 2000),
  -- '{}' means "all event types" (the subscription filter, not an empty subscription).
  event_types text[] not null default '{}'::text[]
    check (array_position(event_types, null) is null
           and not (event_types && array['']::text[])),
  secret_id uuid not null references vault.secrets(id) on delete restrict,
  -- Activation is a separate, owner-gated, step-up-protected decision -- never the
  -- configure default. Turning a subscription on means "stream this tenant's business
  -- events to that URL": the same exfiltration class as bank_details (#85 applies).
  active boolean not null default false,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, target)
);

alter table public.webhook_subscriptions enable row level security;
revoke all on table public.webhook_subscriptions from public, anon, authenticated;

create trigger webhook_subscriptions_touch
  before update on public.webhook_subscriptions
  for each row execute function public.set_updated_at();

-- The generic audit trigger applies (the table has org_id and holds NO secret material --
-- secret_id is a Vault reference, not a secret; contrast identity_provider_settings,
-- whose audit exemption exists because its rows carry secret payloads).
create trigger webhook_subscriptions_audit
  after insert or update or delete on public.webhook_subscriptions
  for each row execute function audit_row_change();

comment on table public.webhook_subscriptions is
  'Registered webhook targets for the integration outbox (INTEGRATION-ARCHITECTURE.md '
  'SS4, wave 7). target is generated as ''webhook:''||id -- globally unique because the '
  'outbox dedup key has no org_id. secret_id references vault.secrets; the raw secret '
  'never leaves Postgres (OPEN-DECISIONS #97). active defaults to false: enabling is an '
  'owner step-up command, not a configuration default.';

-- ===== 2. external_references -- the internal<->external identity boundary =====
-- The INTEGRATION-ARCHITECTURE.md:91-92 tuple, verbatim: (org_id, provider, entity_type,
-- internal_id, external_id). This table IS the boundary -- no provider id columns ever
-- land on business tables. entity_type is DATA, never a column name (PLAN-08 decision 4).
-- Readable by owners (the domain_events 0063:112-119 read shape); written only by
-- server-side adapters (service_role) -- no browser DML, no RPC in this wave.
create table public.external_references (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null check (btrim(provider) <> '' and length(provider) <= 100),
  entity_type text not null check (btrim(entity_type) <> '' and length(entity_type) <= 100),
  internal_id uuid not null,
  external_id text not null check (btrim(external_id) <> '' and length(external_id) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The pair of uniques: one internal row maps to at most one external identity per
  -- (provider, entity_type), and vice versa -- a bidirectional bijection per provider.
  unique (org_id, provider, entity_type, internal_id),
  unique (org_id, provider, entity_type, external_id)
);

alter table public.external_references enable row level security;

create policy external_references_owner_read on public.external_references
  for select to authenticated
  using (org_id = auth_org() and auth_role() = 'owner');

revoke all on table public.external_references from anon, authenticated;
grant select on table public.external_references to authenticated;

create trigger external_references_touch
  before update on public.external_references
  for each row execute function public.set_updated_at();

create trigger external_references_audit
  after insert or update or delete on public.external_references
  for each row execute function audit_row_change();

comment on table public.external_references is
  'Mapping between an internal entity and its identity at an external provider '
  '(INTEGRATION-ARCHITECTURE.md:91-92). This is the boundary: no provider id columns on '
  'business tables. entity_type is data -- adapters write it; nothing joins on it '
  'structurally.';

-- ===== 3. integration_failures -- the adapter/inbound failure ledger =====
-- Boundary with private.integration_deliveries (OPEN-DECISIONS #99): deliveries record
-- the TRANSPORT outcome of an outbox row (one row per attempt, written by the worker
-- RPCs); integration_failures records adapter-plane and inbound failures that have no
-- outbox row -- a rejected inbound signature, a mapping conflict, a provider SDK error.
-- raw_error is the provider's raw text: the same scrubbing class Sentry gets
-- (observability.ts strips console breadcrumbs because raw server strings can name a
-- supplier or an amount) -- so the browser NEVER reads this table (Shape-2) and the
-- owner-gated reader below returns error codes and counts, never raw_error.
create table public.integration_failures (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  source text not null check (source in ('adapter', 'webhook', 'inbound')),
  subscription_id uuid references public.webhook_subscriptions(id) on delete set null,
  error_code text not null check (btrim(error_code) <> '' and length(error_code) <= 200),
  raw_error text,
  correlation_id uuid default public.request_correlation_id(),
  created_at timestamptz not null default now()
);

create index integration_failures_org_created_idx
  on public.integration_failures (org_id, created_at desc);

alter table public.integration_failures enable row level security;
revoke all on table public.integration_failures from public, anon, authenticated;

-- NO audit_row_change trigger: it is itself a log (the security_events 0060 precedent) --
-- auditing the failure ledger would double every recorder's write amplification.

comment on table public.integration_failures is
  'Adapter-plane and inbound integration failures (OPEN-DECISIONS #99). NOT delivery '
  'attempts -- those live in private.integration_deliveries, one row per outbox attempt. '
  'raw_error is provider text and never reaches a browser; read through '
  'read_integration_failures() (codes and counts only).';

-- The internal recorder (the private.record_security_event 0060:98-112 shape): called
-- only from trusted server contexts. Skips quietly when no tenant is in context --
-- the ledger is tenant-scoped by design and org_id is not null.
create function private.record_integration_failure(
  p_org uuid,
  p_source text,
  p_subscription_id uuid,
  p_error_code text,
  p_raw_error text,
  p_correlation_id uuid default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_org is null then
    return;
  end if;
  insert into integration_failures
    (org_id, source, subscription_id, error_code, raw_error, correlation_id)
  values (
    p_org,
    p_source,
    p_subscription_id,
    left(coalesce(nullif(btrim(p_error_code), ''), 'unknown_error'), 200),
    nullif(left(coalesce(p_raw_error, ''), 4000), ''),
    coalesce(p_correlation_id, public.request_correlation_id())
  );
end
$$;
revoke all on function private.record_integration_failure(uuid, text, uuid, text, text, uuid)
  from public, anon, authenticated;

-- The owner-gated, REDACTED reader: error codes and counts only -- raw_error is not in
-- the projection and never will be through this surface. Non-owners get zero rows,
-- never an error (the platform_orgs precedent, 0006:152).
create function public.read_integration_failures()
returns table (
  source text,
  subscription_id uuid,
  error_code text,
  failure_count bigint,
  first_failed_at timestamptz,
  last_failed_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select f.source, f.subscription_id, f.error_code,
         count(*), min(f.created_at), max(f.created_at)
  from integration_failures f
  where f.org_id = auth_org() and auth_role() = 'owner'
  group by f.source, f.subscription_id, f.error_code
  order by max(f.created_at) desc
$$;
revoke all on function public.read_integration_failures() from public, anon;
grant execute on function public.read_integration_failures() to authenticated;

-- ===== 4. The webhook command surface =====
-- (a) configure -- service_role ONLY, the configure_whatsapp_connection precedent
-- (0028:407): the secret arrives as a Vault id, never as plaintext through PostgREST.
-- Always creates the subscription INACTIVE; activation is the owner's separate step-up
-- decision below. The reasoned audit row never contains secret material -- not even the
-- vault reference id.
create function public.configure_webhook_subscription(
  p_org_id uuid,
  p_url text,
  p_event_types text[],
  p_secret_id uuid,
  p_description text,
  p_reason text
)
returns jsonb
language plpgsql security definer set search_path = public, vault as $$
declare
  v_reason text := nullif(trim(p_reason), '');
  v_url text := nullif(trim(p_url), '');
  v_event_types text[] := coalesce(p_event_types, '{}'::text[]);
  v_row webhook_subscriptions;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_org_id is null or v_url is null or p_secret_id is null or v_reason is null then
    raise exception 'webhook_subscription_invalid' using errcode = '22023';
  end if;
  if v_url !~* '^https?://' or length(v_url) > 2000 then
    raise exception 'webhook_url_invalid' using errcode = '22023';
  end if;
  if array_position(v_event_types, null) is not null
     or v_event_types && array['']::text[] then
    raise exception 'webhook_event_types_invalid' using errcode = '22023';
  end if;
  if not exists (select 1 from organizations where id = p_org_id) then
    raise exception 'webhook_organization_unknown' using errcode = 'P0002';
  end if;
  if not exists (select 1 from vault.secrets where id = p_secret_id) then
    raise exception 'webhook_secret_unknown' using errcode = 'P0002';
  end if;

  insert into webhook_subscriptions (org_id, url, event_types, secret_id, description)
  values (p_org_id, v_url, v_event_types, p_secret_id, nullif(trim(p_description), ''))
  returning * into v_row;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    p_org_id, null, 'webhook_subscription_configured', 'webhook_subscriptions', v_row.id,
    jsonb_build_object(
      'target', v_row.target,
      'url', v_row.url,
      'event_types', to_jsonb(v_row.event_types),
      'active', v_row.active,
      'description', v_row.description
    ),
    v_reason
  );

  return jsonb_build_object(
    'id', v_row.id,
    'target', v_row.target,
    'active', v_row.active,
    'created_at', v_row.created_at
  );
end
$$;
revoke all on function public.configure_webhook_subscription(uuid, text, text[], uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.configure_webhook_subscription(uuid, text, text[], uuid, text, text)
  to service_role;

-- (b) activate/deactivate -- owner + mandatory reason + STEP-UP + audit + security event.
-- Enabling a subscription streams the tenant's business events to an external URL: the
-- same exfiltration class as changing a supplier's bank_details, so #85 applies and the
-- assertion is unconditional (never behind a flag -- SECURITY-MODEL SS8).
create function public.set_webhook_subscription_active(
  p_subscription_id uuid,
  p_active boolean,
  p_reason text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_reason text := nullif(trim(p_reason), '');
  v_row webhook_subscriptions;
  v_was boolean;
begin
  if v_org is null or v_user is null or auth_role() <> 'owner' then
    raise exception 'webhook_not_authorized' using errcode = '42501';
  end if;
  perform public.assert_recent_password_authentication();
  if p_subscription_id is null or p_active is null or v_reason is null then
    raise exception 'webhook_subscription_invalid' using errcode = '22023';
  end if;

  select * into v_row from webhook_subscriptions
  where org_id = v_org and id = p_subscription_id
  for update;
  if not found then
    raise exception 'webhook_subscription_unknown' using errcode = 'P0002';
  end if;
  v_was := v_row.active;

  update webhook_subscriptions
  set active = p_active
  where id = v_row.id
  returning * into v_row;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_user, 'webhook_subscription_toggled', 'webhook_subscriptions', v_row.id,
    jsonb_build_object('active', v_was),
    jsonb_build_object('active', v_row.active),
    v_reason
  );

  perform private.record_security_event(
    v_org, v_user, 'webhook_subscription_toggled',
    jsonb_build_object('subscription_id', v_row.id, 'target', v_row.target,
                       'active', v_row.active));

  return jsonb_build_object(
    'id', v_row.id,
    'target', v_row.target,
    'active', v_row.active,
    'updated_at', v_row.updated_at
  );
end
$$;
revoke all on function public.set_webhook_subscription_active(uuid, boolean, text)
  from public, anon;
grant execute on function public.set_webhook_subscription_active(uuid, boolean, text)
  to authenticated;

-- (c) the owner reader -- everything EXCEPT secret_id (the read_identity_provider_settings
-- 0060:160 shape). Non-owners get zero rows, never an error.
create function public.read_webhook_subscriptions()
returns table (
  id uuid,
  target text,
  url text,
  event_types text[],
  active boolean,
  description text,
  created_at timestamptz,
  updated_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select w.id, w.target, w.url, w.event_types, w.active, w.description,
         w.created_at, w.updated_at
  from webhook_subscriptions w
  where w.org_id = auth_org() and auth_role() = 'owner'
  order by w.created_at
$$;
revoke all on function public.read_webhook_subscriptions() from public, anon;
grant execute on function public.read_webhook_subscriptions() to authenticated;

-- ===== 5. The enqueue path -- AFTER INSERT on domain_events =====
-- PLAN-08 decision 1: the trigger sits on the event table itself, so it covers the 0063
-- audit fan-out AND any future command that emits inline (the ADR-0005 forward rule)
-- without touching either. For each ACTIVE subscription of the event's tenant whose
-- filter matches ('{}' = all types), the wave-5 seam enqueues exactly once -- the seam's
-- on-conflict arm keeps re-fires idempotent per (target, event).
create function private.enqueue_matching_subscriptions()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s record;
begin
  for s in
    select w.target
    from public.webhook_subscriptions w
    where w.org_id = new.org_id
      and w.active
      and (w.event_types = '{}'::text[] or new.event_type = any (w.event_types))
    order by w.created_at, w.id
  loop
    perform private.enqueue_integration_outbox(new.id, s.target);
  end loop;
  return null;
end
$$;
revoke all on function private.enqueue_matching_subscriptions()
  from public, anon, authenticated;

create trigger domain_events_enqueue_subscriptions
  after insert on public.domain_events
  for each row execute function private.enqueue_matching_subscriptions();

-- ===== 6. The signed claim -- claim_integration_outbox redeclared from 0064 =====
-- Ancestry assertion first (the 0064 SS6 WhatsApp-dispatcher idiom): the live definition
-- must be the 0064 text -- present markers prove the 0064 body, absent markers prove no
-- one extended it before us. A drifted or already-extended body fails the reset loudly
-- instead of being silently overwritten.
do $$
declare
  v_def text;
begin
  select pg_get_functiondef('public.claim_integration_outbox(text,integer)'::regprocedure::oid)
    into v_def;
  if v_def is null then
    raise exception 'claim_redeclare_missing: 0064 ancestry not found';
  end if;
  if position('for update of o skip locked' in v_def) = 0
     or position('interval ''10 minutes''' in v_def) = 0
     or position('''sf:'' || c.event_id::text || '':'' || c.target' in v_def) = 0 then
    raise exception 'claim_redeclare_source_mismatch: live body is not the 0064 text';
  end if;
  if position('webhook_subscriptions' in v_def) > 0
     or position('hmac' in v_def) > 0
     or position('signature' in v_def) > 0 then
    raise exception 'claim_redeclare_already_extended';
  end if;
end
$$;

-- The 0064 body verbatim, plus the wave-7 extension: each claimed row also carries
--   body      -- the event envelope's deterministic serialization (jsonb::text: jsonb
--                normalizes key order, so the signed bytes are reproducible in SQL)
--   url       -- the resolved subscription's URL (absent when the target is unknown,
--                inactive, or its Vault secret does not resolve -- the worker then falls
--                back to the wave-5 target_unregistered fail path, preserving behavior)
--   timestamp -- unix epoch seconds, one value per claim batch; returned as the
--                x-supplyflow-timestamp header value
--   signature -- hex HMAC-SHA256 over (body || '.' || timestamp) with the subscription's
--                Vault secret (OPEN-DECISIONS #97). The secret never leaves this
--                function; the worker only ever sees the finished signature.
create or replace function public.claim_integration_outbox(
  p_worker_id text,
  p_limit integer default 10
)
returns setof jsonb
language plpgsql
security definer
set search_path = public, vault, extensions, pg_temp
as $$
declare
  v_worker text := nullif(trim(p_worker_id), '');
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 100);
  v_ts text := floor(extract(epoch from now()))::bigint::text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_worker is null or length(v_worker) > 200 then
    raise exception 'worker_id_invalid' using errcode = '22023';
  end if;

  return query
  with candidate as (
    select o.id
    from private.integration_outbox o
    join public.organizations org
      on org.id = o.org_id and org.status in ('trial', 'active')
    where (o.status = 'pending' and o.next_attempt_at <= now())
       -- A claim older than 10 minutes is stale (worker died mid-batch): reclaimable.
       or (o.status = 'claimed' and o.claimed_at <= now() - interval '10 minutes')
    order by o.next_attempt_at, o.created_at, o.id
    for update of o skip locked
    limit v_limit
  ),
  claimed as (
    update private.integration_outbox o
    set status = 'claimed',
        claimed_by = v_worker,
        claimed_at = now(),
        attempt_count = o.attempt_count + 1,
        updated_at = now()
    from candidate
    where o.id = candidate.id
    returning o.id, o.org_id, o.target, o.event_id, o.attempt_count
  ),
  keyed as (
    -- First claim records the outbound dedup key; later attempts reuse it.
    insert into private.idempotency_keys (target, event_id, idempotency_key)
    select c.target, c.event_id, 'sf:' || c.event_id::text || ':' || c.target
    from claimed c
    on conflict (target, event_id) do nothing
  )
  select jsonb_build_object(
    'outbox_id', c.id,
    'target', c.target,
    'attempt', c.attempt_count,
    'idempotency_key', 'sf:' || c.event_id::text || ':' || c.target,
    'url', sub.url,
    'body', env.body,
    'timestamp', case when sub.url is not null then v_ts end,
    'signature', case when sub.url is not null
                   then encode(extensions.hmac(env.body || '.' || v_ts, sub.secret,
                                               'sha256'), 'hex')
                 end,
    'event', env.envelope)
  from claimed c
  join public.domain_events e on e.id = c.event_id
  cross join lateral (
    select built.envelope, built.envelope::text as body
    from (
      select jsonb_build_object(
        'id', e.id,
        'sequence', e.sequence,
        'event_type', e.event_type,
        'schema_version', e.schema_version,
        'org_id', e.org_id,
        'unit_id', e.unit_id,
        'entity_type', e.entity_type,
        'entity_id', e.entity_id,
        'actor_id', e.actor_id,
        'correlation_id', e.correlation_id,
        'causation_id', e.causation_id,
        'occurred_at', e.occurred_at,
        'payload', e.payload,
        'metadata', e.metadata) as envelope
    ) built
  ) env
  left join lateral (
    select w.url, ds.decrypted_secret as secret
    from public.webhook_subscriptions w
    join vault.decrypted_secrets ds on ds.id = w.secret_id
    where w.target = c.target
      and w.org_id = c.org_id
      and w.active
      and nullif(ds.decrypted_secret, '') is not null
  ) sub on true;
end
$$;

-- CREATE OR REPLACE preserves ACLs; re-asserted anyway so the contract is visible here.
revoke all on function public.claim_integration_outbox(text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_integration_outbox(text, integer) to service_role;

-- ===== 7. Registry (A1) + re-assert (the 0058:207-218 idiom, literal 0066) =====
-- webhook_subscriptions is org_global: configuration, never scoped work. The other two
-- are cross_scope: a reference or a failure may point at any unit's entity; they carry a
-- tenant, never a scope of their own (the security_events 0060 classification).
insert into private.scope_registry (table_name, scope_class, enforced) values
  ('webhook_subscriptions', 'org_global',  false),
  ('external_references',   'cross_scope', false),
  ('integration_failures',  'cross_scope', false);

do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0066 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
