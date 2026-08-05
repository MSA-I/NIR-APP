-- 0064 -- Transactional outbox for integrations (PLAN-05).
--
-- Everything lives in the private schema (PLAN-05 SS1.4): the browser never reads an
-- outbox, so these tables stay outside A1 (public-only) and outside the browser ACL
-- contracts. The worker reaches them ONLY through service_role RPCs in the 0045
-- claim/complete/fail pattern; pg_cron reaches the Edge worker through the 0028
-- config-gated vault dispatcher pattern.
--
-- Delivery semantics (OPEN-DECISIONS #90 -- documented guardrails, not business rules):
-- at-least-once, exponential backoff base 1m / multiplier 4 / cap 6h, max 8 attempts,
-- then dead-letter, replayable only through a reasoned command.
--
-- ZERO auto-enqueue (PLAN-05 SS1.4): no trigger and no command writes outbox rows in
-- this wave. An event enters the outbox only when a registered target asks for it --
-- wave 7 registers targets (webhook_subscriptions) and calls the enqueue seam below.
-- An empty outbox at the gate is by design, not by luck.

-- ===== 1. The outbox =====
create table private.integration_outbox (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  event_id uuid not null references public.domain_events(id),
  target text not null check (btrim(target) <> ''),
  status text not null default 'pending'
    check (status in ('pending', 'claimed', 'delivered', 'dead_letter')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  claimed_by text,
  claimed_at timestamptz,
  delivered_at timestamptz,
  last_error text,
  -- Copied from the event at enqueue time so a delivery keeps its lineage even if the
  -- event row is ever archived separately.
  correlation_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One outbox row per (target, event): the enqueue-side dedup arm.
  unique (target, event_id)
);

create index integration_outbox_due_idx
  on private.integration_outbox (status, next_attempt_at);

revoke all on table private.integration_outbox from public, anon, authenticated;

comment on table private.integration_outbox is
  'Pending deliveries of domain events to registered integration targets. At-least-once; '
  'rows are claimed by the outbox-worker Edge function through service_role RPCs only. '
  'Empty until wave 7 registers targets -- by design (PLAN-05 SS1.4).';

-- One row per delivery attempt -- the operational history the integrations screen reads.
create table private.integration_deliveries (
  id uuid primary key default gen_random_uuid(),
  outbox_id uuid not null references private.integration_outbox(id),
  attempt integer not null check (attempt >= 1),
  status text not null check (status in ('delivered', 'failed')),
  response_code integer,
  error text,
  correlation_id uuid,
  attempted_at timestamptz not null default now(),
  unique (outbox_id, attempt)
);

revoke all on table private.integration_deliveries from public, anon, authenticated;

-- Outbound dedup key per (target, event) -- OPEN-DECISIONS #91. The key is deterministic
-- ('sf:<event_id>:<target>'), recorded at first claim, and sent on EVERY attempt so the
-- receiver can deduplicate at-least-once redelivery.
create table private.idempotency_keys (
  target text not null,
  event_id uuid not null references public.domain_events(id),
  idempotency_key text not null check (btrim(idempotency_key) <> ''),
  created_at timestamptz not null default now(),
  primary key (target, event_id)
);

revoke all on table private.idempotency_keys from public, anon, authenticated;

-- Terminal failures. failure_reason is NOT NULL by contract (preflight verifies anyway);
-- the record survives a replay -- replay stamps it, never deletes it.
create table private.dead_letter_records (
  id uuid primary key default gen_random_uuid(),
  outbox_id uuid not null references private.integration_outbox(id),
  event_id uuid not null references public.domain_events(id),
  target text not null,
  failure_reason text not null check (btrim(failure_reason) <> ''),
  attempts integer not null,
  dead_lettered_at timestamptz not null default now(),
  replayed_at timestamptz,
  replayed_by uuid,
  replay_reason text
);

revoke all on table private.dead_letter_records from public, anon, authenticated;

-- ===== 2. Scheduler configuration -- the 0028 vault shape, verbatim =====
-- The value stored here is only a Vault reference: the raw value must be identical to
-- the Edge Function secret OUTBOX_FN_SECRET and is never stored in this migration or in
-- cron.job. No config row = the dispatcher is a quiet no-op, so migrations may be
-- applied before the Edge Function is deployed and configured.
create table private.integration_outbox_config (
  id boolean primary key default true check (id),
  edge_url text not null check (trim(edge_url) <> ''),
  cron_secret_id uuid not null references vault.secrets(id) on delete restrict,
  configured_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger integration_outbox_config_touch
before update on private.integration_outbox_config
for each row execute function public.set_updated_at();

revoke all on table private.integration_outbox_config
  from public, anon, authenticated;

-- ===== 3. The enqueue seam (wave 7 calls this; nothing calls it in wave 5) =====
-- SECURITY INVOKER on purpose: only trusted server contexts (definer commands, jobs,
-- migrations) can reach the private schema at all. Dedup by the unique(target, event_id)
-- arm; idempotent -- re-enqueueing an already-queued pair returns the existing row.
create function private.enqueue_integration_outbox(
  p_event_id uuid,
  p_target text
)
returns uuid
language plpgsql
as $$
declare
  v_target text := nullif(trim(p_target), '');
  v_id uuid;
begin
  if p_event_id is null or v_target is null or length(v_target) > 200 then
    raise exception 'outbox_enqueue_invalid' using errcode = '22023';
  end if;

  insert into private.integration_outbox (org_id, event_id, target, correlation_id)
  select e.org_id, e.id, v_target, e.correlation_id
  from public.domain_events e
  where e.id = p_event_id
  on conflict (target, event_id) do nothing
  returning id into v_id;

  if v_id is null then
    select o.id into v_id
    from private.integration_outbox o
    where o.target = v_target and o.event_id = p_event_id;
  end if;
  if v_id is null then
    raise exception 'outbox_event_unknown' using errcode = 'P0002';
  end if;
  return v_id;
end
$$;

revoke all on function private.enqueue_integration_outbox(uuid, text)
  from public, anon, authenticated;

-- ===== 4. The worker surface -- service_role RPCs, the 0045 claim pattern =====
create function public.claim_integration_outbox(
  p_worker_id text,
  p_limit integer default 10
)
returns setof jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_worker text := nullif(trim(p_worker_id), '');
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 100);
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
    returning o.id, o.target, o.event_id, o.attempt_count
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
    'event', jsonb_build_object(
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
      'metadata', e.metadata))
  from claimed c
  join public.domain_events e on e.id = c.event_id;
end
$$;

create function public.complete_integration_outbox_delivery(
  p_outbox_id uuid,
  p_worker_id text,
  p_response_code integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_worker text := nullif(trim(p_worker_id), '');
  v_row private.integration_outbox;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_worker is null or length(v_worker) > 200 then
    raise exception 'worker_id_invalid' using errcode = '22023';
  end if;

  select o.* into v_row
  from private.integration_outbox o
  where o.id = p_outbox_id
  for update;
  if not found then
    raise exception 'outbox_row_unknown' using errcode = 'P0002';
  end if;
  if v_row.status = 'delivered' then
    return jsonb_build_object('outbox_id', v_row.id, 'status', v_row.status,
                              'idempotent', true);
  end if;
  if v_row.status <> 'claimed' or v_row.claimed_by is distinct from v_worker then
    raise exception 'outbox_claim_lost' using errcode = '55000';
  end if;

  insert into private.integration_deliveries
    (outbox_id, attempt, status, response_code, correlation_id)
  values (v_row.id, v_row.attempt_count, 'delivered', p_response_code,
          v_row.correlation_id);

  update private.integration_outbox o
  set status = 'delivered',
      delivered_at = now(),
      claimed_by = null,
      claimed_at = null,
      last_error = null,
      updated_at = now()
  where o.id = v_row.id;

  return jsonb_build_object('outbox_id', v_row.id, 'status', 'delivered',
                            'attempt', v_row.attempt_count, 'idempotent', false);
end
$$;

create function public.fail_integration_outbox_delivery(
  p_outbox_id uuid,
  p_worker_id text,
  p_error text,
  p_response_code integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_worker text := nullif(trim(p_worker_id), '');
  v_error text := nullif(left(trim(coalesce(p_error, '')), 1000), '');
  v_row private.integration_outbox;
  v_next timestamptz;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_worker is null or length(v_worker) > 200 then
    raise exception 'worker_id_invalid' using errcode = '22023';
  end if;
  if v_error is null then
    raise exception 'outbox_error_required' using errcode = '22023';
  end if;

  select o.* into v_row
  from private.integration_outbox o
  where o.id = p_outbox_id
  for update;
  if not found then
    raise exception 'outbox_row_unknown' using errcode = 'P0002';
  end if;
  if v_row.status = 'dead_letter' then
    return jsonb_build_object('outbox_id', v_row.id, 'status', v_row.status,
                              'idempotent', true);
  end if;
  if v_row.status <> 'claimed' or v_row.claimed_by is distinct from v_worker then
    raise exception 'outbox_claim_lost' using errcode = '55000';
  end if;

  insert into private.integration_deliveries
    (outbox_id, attempt, status, response_code, error, correlation_id)
  values (v_row.id, v_row.attempt_count, 'failed', p_response_code, v_error,
          v_row.correlation_id);

  if v_row.attempt_count >= 8 then
    -- OPEN-DECISIONS #90: the 8th failed attempt is terminal.
    update private.integration_outbox o
    set status = 'dead_letter',
        claimed_by = null,
        claimed_at = null,
        last_error = v_error,
        updated_at = now()
    where o.id = v_row.id;

    insert into private.dead_letter_records
      (outbox_id, event_id, target, failure_reason, attempts)
    values (v_row.id, v_row.event_id, v_row.target, v_error, v_row.attempt_count);

    return jsonb_build_object('outbox_id', v_row.id, 'status', 'dead_letter',
                              'attempt', v_row.attempt_count, 'idempotent', false);
  end if;

  -- Backoff: base 1m, multiplier 4, cap 6h (attempts 1..7 wait 1m, 4m, 16m, 64m,
  -- 256m, 6h, 6h).
  v_next := now() + make_interval(
    mins => least(360, (4 ^ (v_row.attempt_count - 1))::integer));

  update private.integration_outbox o
  set status = 'pending',
      next_attempt_at = v_next,
      claimed_by = null,
      claimed_at = null,
      last_error = v_error,
      updated_at = now()
  where o.id = v_row.id;

  return jsonb_build_object('outbox_id', v_row.id, 'status', 'pending',
                            'attempt', v_row.attempt_count,
                            'next_attempt_at', v_next, 'idempotent', false);
end
$$;

-- Replay is a REASONED command (OPEN-DECISIONS #90): a human decision with an audit
-- trail, not an automatic loop. The dead-letter record survives -- it is stamped, never
-- deleted -- and the audit row carries the operator's reason.
create function public.replay_dead_letter_record(
  p_dead_letter_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_record private.dead_letter_records;
  v_row private.integration_outbox;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'replay_reason_required' using errcode = '22023';
  end if;

  select d.* into v_record
  from private.dead_letter_records d
  where d.id = p_dead_letter_id
  for update;
  if not found then
    raise exception 'dead_letter_unknown' using errcode = 'P0002';
  end if;
  if v_record.replayed_at is not null then
    raise exception 'dead_letter_already_replayed' using errcode = '55000';
  end if;

  select o.* into v_row
  from private.integration_outbox o
  where o.id = v_record.outbox_id
  for update;
  if not found or v_row.status <> 'dead_letter' then
    raise exception 'outbox_row_not_dead_lettered' using errcode = '55000';
  end if;

  update private.integration_outbox o
  set status = 'pending',
      attempt_count = 0,
      next_attempt_at = now(),
      claimed_by = null,
      claimed_at = null,
      last_error = null,
      updated_at = now()
  where o.id = v_row.id;

  update private.dead_letter_records d
  set replayed_at = now(),
      replayed_by = auth.uid(),
      replay_reason = v_reason
  where d.id = v_record.id;

  insert into public.audit_logs
    (org_id, user_id, action, entity_type, entity_id, new_values, reason)
  values (
    v_row.org_id, auth.uid(), 'integration_dead_letter_replayed', 'domain_events',
    v_row.event_id,
    jsonb_build_object('target', v_row.target, 'attempts', v_record.attempts,
                       'dead_letter_id', v_record.id),
    v_reason
  );

  return jsonb_build_object('outbox_id', v_row.id, 'status', 'pending',
                            'dead_letter_id', v_record.id);
end
$$;

revoke all on function public.claim_integration_outbox(text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_integration_outbox(text, integer) to service_role;
revoke all on function public.complete_integration_outbox_delivery(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.complete_integration_outbox_delivery(uuid, text, integer)
  to service_role;
revoke all on function public.fail_integration_outbox_delivery(uuid, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.fail_integration_outbox_delivery(uuid, text, text, integer)
  to service_role;
revoke all on function public.replay_dead_letter_record(uuid, text)
  from public, anon, authenticated;
grant execute on function public.replay_dead_letter_record(uuid, text) to service_role;

-- ===== 5. The dispatcher -- the 0028:995 config-gated vault no-op pattern =====
-- pg_cron invokes only this private dispatcher. Missing configuration (or a
-- missing/empty Vault value) is deliberately a quiet no-op, so migrations may be
-- applied before the Edge Function is deployed and configured.
create function private.dispatch_integration_outbox()
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, private, vault, net
as $$
declare
  v_edge_url text;
  v_cron_secret text;
  v_request_id bigint;
begin
  -- Root correlation stamp: cron-originated work has no request header (PLAN-05 SS1.3).
  perform pg_catalog.set_config('app.correlation_id',
    pg_catalog.gen_random_uuid()::text, true);

  select trim(c.edge_url), nullif(ds.decrypted_secret, '')
  into v_edge_url, v_cron_secret
  from private.integration_outbox_config c
  join vault.decrypted_secrets ds on ds.id = c.cron_secret_id
  where c.id;

  if not found or v_cron_secret is null then
    return null;
  end if;

  v_request_id := net.http_post(
    url := v_edge_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-outbox-cron-secret', v_cron_secret
    )
  );

  return v_request_id;
end
$$;

revoke all on function private.dispatch_integration_outbox()
  from public, anon, authenticated, service_role;

-- cron.schedule(job_name, ...) is an upsert by job name (0028:1032), so applying this
-- migration converges to one active per-minute job without duplicating schedules. The
-- per-minute cadence matches the 1-minute backoff base; without a config row every run
-- is a no-op SELECT.
select cron.schedule(
  'supplyflow-integration-outbox',
  '* * * * *',
  'select private.dispatch_integration_outbox();'
);

-- ===== 6. Root-stamp the two EXISTING cron bodies (PLAN-05 SS1.3) =====
-- (a) The 0016 daily push scan: re-scheduled under the SAME name (upsert-by-name), body
-- copied verbatim from 0016:91-108 plus the one stamp line.
select cron.schedule('push-payment-due', '0 4 * * *', $$
do $job$
declare
  cfg private.push_config%rowtype;
begin
  perform set_config('app.correlation_id', gen_random_uuid()::text, true);
  select * into cfg from private.push_config where id;
  if not found then
    return;
  end if;
  perform net.http_post(
    url     := cfg.edge_url,
    body    := '{"event":"payment_due_scan"}'::jsonb,
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'x-push-secret', cfg.secret)
  );
end $job$;
$$);

-- (b) The 0028 reminder dispatcher: its cron job body only calls this private function,
-- so the stamp goes into the function. This is NOT a command-surface function (private
-- schema, cron-only, all roles revoked) and its live body IS its 0028:995 text --
-- asserted below in the 0031/0061 ancestry style before the replace, so a drifted or
-- already-stamped body fails the reset instead of being silently overwritten.
do $$
declare
  v_src text;
begin
  select p.prosrc into v_src
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private'
    and p.proname = 'dispatch_whatsapp_confirmation_reminders';
  if v_src is null then
    raise exception 'whatsapp_dispatcher_missing: 0028 ancestry not found';
  end if;
  if position('whatsapp_reminder_config' in v_src) = 0
     or position('x-whatsapp-cron-secret' in v_src) = 0 then
    raise exception 'whatsapp_dispatcher_source_mismatch: live body is not the 0028 text';
  end if;
  if position('app.correlation_id' in v_src) > 0 then
    raise exception 'whatsapp_dispatcher_already_stamped';
  end if;
end
$$;

-- The 0028:995 body verbatim, plus the one stamp line at the top.
create or replace function private.dispatch_whatsapp_confirmation_reminders()
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, private, vault, net
as $$
declare
  v_edge_url text;
  v_cron_secret text;
  v_request_id bigint;
begin
  perform pg_catalog.set_config('app.correlation_id',
    pg_catalog.gen_random_uuid()::text, true);

  select trim(c.edge_url), nullif(ds.decrypted_secret, '')
  into v_edge_url, v_cron_secret
  from private.whatsapp_reminder_config c
  join vault.decrypted_secrets ds on ds.id = c.cron_secret_id
  where c.id;

  if not found or v_cron_secret is null then
    return null;
  end if;

  v_request_id := net.http_post(
    url := v_edge_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-whatsapp-cron-secret', v_cron_secret
    )
  );

  return v_request_id;
end
$$;

-- CREATE OR REPLACE preserves ACLs; re-asserted anyway so the contract is visible here.
revoke all on function private.dispatch_whatsapp_confirmation_reminders()
  from public, anon, authenticated, service_role;

-- ===== 7. Re-assert (the 0058:207-218 idiom) =====
-- No public table was added (A1 untouched); proves the four new definer RPCs tripped
-- neither A5 arm and no rider/registry/definer contract regressed inside this migration.
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0064 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
