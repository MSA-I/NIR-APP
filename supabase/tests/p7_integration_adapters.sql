-- P7 integration-adapter harness for 0066. Run only against an isolated local database
-- with every migration applied. The transaction is rolled back.
--
-- What it proves, per PLAN-08 §2:
--   (a) structure: Shape-2 ACLs on webhook_subscriptions / integration_failures, the
--       owner-read surface on external_references, the three registry rows, the generated
--       target derivation, the RPC grant matrix, and the enqueue trigger's existence;
--   (b) the enqueue path fires through a REAL, UNEDITED command: set_invoice_review_status
--       (asserted structurally to know nothing of webhooks) emits its event through the
--       0063 fan-out, and the AFTER INSERT trigger on domain_events enqueues exactly one
--       outbox row per matching ACTIVE subscription, carrying the EVENT's correlation id;
--   (c) the four negatives: an inactive subscription, a non-matching event_types filter,
--       and another tenant's subscription each enqueue NOTHING; two matching
--       subscriptions enqueue two rows with two distinct idempotency keys;
--   (d) enqueue idempotency through the wave-5 seam (same (target, event) -> same row);
--   (e) the signature known-answer vector (fixed secret + body + timestamp -> pinned
--       hex), and that every claimed row's signature verifies against a recomputation
--       from its OWN returned body + timestamp with the subscription's Vault secret --
--       the body being the deterministic jsonb::text envelope serialization;
--   (f) an unregistered target claims WITHOUT url/signature/timestamp (the worker's
--       wave-5 target_unregistered fail path is preserved);
--   (g) claim -> complete, and claim -> fail x8 -> dead-letter -> reasoned replay
--       (the p5 lifecycle, now against a REGISTERED target);
--   (h) the command surface: configure (service_role only, vault-id validated, reasoned
--       audit without secret material), set_webhook_subscription_active (owner + reason
--       + STEP-UP + audit + security event), the owner readers (no secret_id, no
--       raw_error), and the failure recorder;
--   (i) the mutation proof: deactivating the subscriptions makes an identical command
--       enqueue ZERO rows; restoring them (savepoint rollback) makes it enqueue again.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p7_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P7 integration adapters assertion failed: %', p_message;
  end if;
end
$$;

-- JWT-claims stamp: the p5_claims idiom plus the p4_flags_identity amr arm (NULL offset
-- = no amr at all; interval '0' = fresh password proof).
create function pg_temp.p7_claims(p_sub uuid, p_offset interval default null)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', p_sub::text, true);
  if p_offset is null then
    perform set_config('request.jwt.claims',
      jsonb_build_object('sub', p_sub::text)::text, true);
  else
    perform set_config('request.jwt.claims', jsonb_build_object(
      'sub', p_sub::text,
      'amr', jsonb_build_array(jsonb_build_object(
        'method', 'password',
        'timestamp', extract(epoch from clock_timestamp() + p_offset)::bigint))
    )::text, true);
  end if;
end
$$;

-- ===== (a) structural proofs =====

-- Shape-2: browser roles hold ZERO privileges on the registry and the failure ledger;
-- service_role keeps full CRUD (the p0_client_dml_acl contract).
select pg_temp.p7_assert(
  not has_table_privilege('anon', 'public.webhook_subscriptions', 'SELECT')
    and not has_table_privilege('authenticated', 'public.webhook_subscriptions', 'SELECT')
    and not has_table_privilege('authenticated', 'public.webhook_subscriptions', 'INSERT')
    and not has_table_privilege('authenticated', 'public.webhook_subscriptions', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.webhook_subscriptions', 'DELETE')
    and has_table_privilege('service_role', 'public.webhook_subscriptions', 'SELECT')
    and has_table_privilege('service_role', 'public.webhook_subscriptions', 'INSERT'),
  'webhook_subscriptions must be Shape-2: no browser privileges, service_role CRUD');

select pg_temp.p7_assert(
  not has_table_privilege('anon', 'public.integration_failures', 'SELECT')
    and not has_table_privilege('authenticated', 'public.integration_failures', 'SELECT')
    and not has_table_privilege('authenticated', 'public.integration_failures', 'INSERT')
    and has_table_privilege('service_role', 'public.integration_failures', 'SELECT'),
  'integration_failures must be Shape-2: no browser privileges, service_role CRUD');

-- external_references: SELECT-only for authenticated, through one permissive owner-read
-- policy (the polpermissive contract), with RLS enabled on all three tables.
select pg_temp.p7_assert(
  has_table_privilege('authenticated', 'public.external_references', 'SELECT')
    and not has_table_privilege('authenticated', 'public.external_references', 'INSERT')
    and not has_table_privilege('authenticated', 'public.external_references', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.external_references', 'DELETE')
    and not has_table_privilege('anon', 'public.external_references', 'SELECT'),
  'external_references must be SELECT-only for authenticated');

select pg_temp.p7_assert(
  exists (
    select 1
    from pg_catalog.pg_policy pol
    join pg_catalog.pg_class c on c.oid = pol.polrelid
    where c.relname = 'external_references'
      and pol.polname = 'external_references_owner_read'
      and pol.polpermissive
      and pol.polcmd = 'r'),
  'external_references must carry the permissive owner-read policy');

select pg_temp.p7_assert(
  (select count(*) from pg_catalog.pg_class c
   join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('webhook_subscriptions', 'external_references',
                       'integration_failures')
     and c.relrowsecurity) = 3,
  'RLS must be enabled on all three wave-7 tables');

-- Registry (A1): the three classifications, none enforced.
select pg_temp.p7_assert(
  (select count(*) from private.scope_registry
   where (table_name, scope_class, enforced) in (
     ('webhook_subscriptions', 'org_global',  false),
     ('external_references',   'cross_scope', false),
     ('integration_failures',  'cross_scope', false))) = 3,
  'the three wave-7 registry rows must exist with their classes, enforced=false');

-- target is a STORED GENERATED column -- the derivation cannot drift or be written.
select pg_temp.p7_assert(
  (select a.attgenerated = 's'
   from pg_catalog.pg_attribute a
   where a.attrelid = 'public.webhook_subscriptions'::regclass
     and a.attname = 'target'),
  'webhook_subscriptions.target must be a stored generated column');

-- RPC grant matrix.
select pg_temp.p7_assert(
  has_function_privilege('service_role',
    'public.configure_webhook_subscription(uuid,text,text[],uuid,text,text)', 'EXECUTE')
    and not has_function_privilege('authenticated',
      'public.configure_webhook_subscription(uuid,text,text[],uuid,text,text)', 'EXECUTE')
    and not has_function_privilege('anon',
      'public.configure_webhook_subscription(uuid,text,text[],uuid,text,text)', 'EXECUTE')
    and has_function_privilege('authenticated',
      'public.set_webhook_subscription_active(uuid,boolean,text)', 'EXECUTE')
    and not has_function_privilege('anon',
      'public.set_webhook_subscription_active(uuid,boolean,text)', 'EXECUTE')
    and has_function_privilege('authenticated',
      'public.read_webhook_subscriptions()', 'EXECUTE')
    and not has_function_privilege('anon', 'public.read_webhook_subscriptions()', 'EXECUTE')
    and has_function_privilege('authenticated',
      'public.read_integration_failures()', 'EXECUTE')
    and not has_function_privilege('anon', 'public.read_integration_failures()', 'EXECUTE')
    and not has_function_privilege('authenticated',
      'private.record_integration_failure(uuid,text,uuid,text,text,uuid)', 'EXECUTE')
    and not has_function_privilege('authenticated',
      'private.enqueue_matching_subscriptions()', 'EXECUTE'),
  'the wave-7 RPC grant matrix must hold');

-- The enqueue trigger sits on domain_events.
select pg_temp.p7_assert(
  exists (
    select 1
    from pg_catalog.pg_trigger tg
    where tg.tgrelid = 'public.domain_events'::regclass
      and tg.tgname = 'domain_events_enqueue_subscriptions'
      and not tg.tgisinternal),
  'the AFTER INSERT enqueue trigger must exist on domain_events');

-- The claim was EXTENDED (webhook resolution + hmac landed) and every wave-7 definer
-- body stays word-clean of the enforced table names (the A5 contract).
select pg_temp.p7_assert(
  exists (
    select 1 from pg_proc
    where proname = 'claim_integration_outbox'
      and prosrc like '%webhook_subscriptions%'
      and prosrc like '%hmac%'),
  'claim_integration_outbox must carry the wave-7 resolution + signature extension');

select pg_temp.p7_assert(
  not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join (select table_name from private.scope_registry where enforced) r
    where n.nspname in ('public', 'private')
      and p.proname in ('claim_integration_outbox', 'enqueue_matching_subscriptions',
                        'record_integration_failure', 'configure_webhook_subscription',
                        'set_webhook_subscription_active', 'read_webhook_subscriptions',
                        'read_integration_failures')
      and p.prosrc ~ ('\m' || r.table_name || '\M')),
  'no wave-7 function body may name an enforced table -- entity names are data');

-- The command under test was NOT edited for webhooks: the event trigger alone enqueues.
select pg_temp.p7_assert(
  not exists (
    select 1 from pg_proc
    where proname = 'set_invoice_review_status'
      and (prosrc ilike '%webhook%' or prosrc ilike '%enqueue%')),
  'set_invoice_review_status must know nothing of webhooks -- the trigger alone enqueues');

-- ===== (e1) the signature known-answer vector =====
-- HMAC-SHA256(key='p7-known-answer-secret', message='{"p7":"known-answer"}.1754400000').
-- The signed string is body || '.' || timestamp -- the exact receiver contract
-- (handoff/07-adapters-contract.md). The same vector is pinned in
-- supabase/functions/outbox-worker/core.test.ts, proving both sides agree byte-for-byte.
select pg_temp.p7_assert(
  encode(extensions.hmac('{"p7":"known-answer"}.1754400000',
                         'p7-known-answer-secret', 'sha256'), 'hex')
    = '4e3f7e7c2061cba6aa5de9f70b941753e26dc9f33cabd8830a9244608aa94f75',
  'the HMAC-SHA256 known-answer vector must match the pinned hex');

-- ===== Trusted fixtures (no JWT: migration/seed-style work) =====
-- Fixtures BEFORE subscriptions: the supplier insert below fans out supplier.created,
-- and no subscription may exist yet -- so the controlled commands later in this file are
-- the ONLY enqueue sources.

insert into organizations (id, name, status) values
  ('17000000-0000-0000-0000-000000000001', 'P7 adapters tenant', 'active'),
  ('17000000-0000-0000-0000-000000000002', 'P7 foreign tenant', 'active');

insert into auth.users (id, email) values
  ('27000000-0000-0000-0000-000000000001', 'p7-owner@example.test'),
  ('27000000-0000-0000-0000-000000000002', 'p7-office@example.test');

insert into profiles (id, org_id, full_name, role) values
  ('27000000-0000-0000-0000-000000000001', '17000000-0000-0000-0000-000000000001',
   'P7 Owner', 'owner'),
  ('27000000-0000-0000-0000-000000000002', '17000000-0000-0000-0000-000000000001',
   'P7 Office', 'office');

insert into suppliers (id, org_id, name) values
  ('37000000-0000-0000-0000-000000000001', '17000000-0000-0000-0000-000000000001',
   'P7 Supplier');

insert into invoices (id, org_id, supplier_id, invoice_number, invoice_date, total_amount,
                      review_status) values
  ('47000000-0000-0000-0000-000000000001', '17000000-0000-0000-0000-000000000001',
   '37000000-0000-0000-0000-000000000001', 'P7-INV-1', current_date, 100, 'received'),
  ('47000000-0000-0000-0000-000000000002', '17000000-0000-0000-0000-000000000001',
   '37000000-0000-0000-0000-000000000001', 'P7-INV-2', current_date, 200,
   'pending_approval'),
  ('47000000-0000-0000-0000-000000000003', '17000000-0000-0000-0000-000000000001',
   '37000000-0000-0000-0000-000000000001', 'P7-INV-3', current_date, 300,
   'pending_approval');

-- Vault secrets for the subscriptions (rolled back with the transaction).
select vault.create_secret('p7-secret-alpha') as secret_alpha \gset
select vault.create_secret('p7-secret-beta') as secret_beta \gset
select vault.create_secret('p7-secret-gamma') as secret_gamma \gset

-- Five subscriptions with EXPLICIT ids, so the generated targets are static below:
--   ...01  org1, ACTIVE,   '{}' (all types)              -> matches everything
--   ...02  org1, ACTIVE,   {invoice.approved}            -> the filter discriminator
--   ...03  org1, INACTIVE, '{}'                          -> negative: inactive
--   ...04  org1, ACTIVE,   {payment.executed}            -> negative: filter mismatch
--   ...05  org2, ACTIVE,   '{}'                          -> negative: foreign tenant
insert into webhook_subscriptions (id, org_id, url, event_types, secret_id, active, description) values
  ('a7000000-0000-4000-8000-000000000001', '17000000-0000-0000-0000-000000000001',
   'https://p7.example.test/hooks/all', '{}'::text[], :'secret_alpha', true, 'P7 all'),
  ('a7000000-0000-4000-8000-000000000002', '17000000-0000-0000-0000-000000000001',
   'https://p7.example.test/hooks/approved', array['invoice.approved'], :'secret_beta',
   true, 'P7 approved only'),
  ('a7000000-0000-4000-8000-000000000003', '17000000-0000-0000-0000-000000000001',
   'https://p7.example.test/hooks/inactive', '{}'::text[], :'secret_gamma', false,
   'P7 inactive'),
  ('a7000000-0000-4000-8000-000000000004', '17000000-0000-0000-0000-000000000001',
   'https://p7.example.test/hooks/mismatch', array['payment.executed'], :'secret_gamma',
   true, 'P7 filter mismatch'),
  ('a7000000-0000-4000-8000-000000000005', '17000000-0000-0000-0000-000000000002',
   'https://p7.example.test/hooks/foreign', '{}'::text[], :'secret_gamma', true,
   'P7 foreign tenant');

-- The generated derivation holds for every row.
select pg_temp.p7_assert(
  (select count(*) from webhook_subscriptions
   where id::text like 'a7000000%'
     and target = 'webhook:' || id::text) = 5,
  'every subscription target must be generated as webhook:<id>');

-- The derivation cannot be overridden: writing target explicitly fails.
do $$
begin
  begin
    update webhook_subscriptions
    set target = 'evil-target'
    where id = 'a7000000-0000-4000-8000-000000000001';
    raise exception 'P7 integration adapters assertion failed: target update must fail';
  exception
    when generated_always then
      null; -- 428C9: exactly what a stored generated column promises
  end;
end
$$;

-- No fixture insert enqueued anything: subscriptions did not exist when the supplier
-- event fanned out, and direct invoice inserts are unmapped.
select pg_temp.p7_assert(
  (select count(*) from private.integration_outbox
   where org_id in ('17000000-0000-0000-0000-000000000001',
                    '17000000-0000-0000-0000-000000000002')) = 0,
  'no fixture write may reach the outbox');

-- ===== (b) the enqueue path through a real, unedited command =====

select set_config('request.headers',
  '{"x-correlation-id":"a7b00000-0000-4000-8000-00000000000a"}', true);
select pg_temp.p7_claims('27000000-0000-0000-0000-000000000001');
set local role authenticated;
select set_invoice_review_status('47000000-0000-0000-0000-000000000001',
  'investigation', 'P7 enqueue proof');
reset role;
select set_config('request.headers', '{}', true);

select id as ev_review_id
from domain_events
where entity_id = '47000000-0000-0000-0000-000000000001'
  and event_type = 'invoice.review_required'
\gset

-- Exactly ONE outbox row: the all-types subscription. The filtered subscription
-- (invoice.approved only), the inactive one, the mismatched one and the foreign-tenant
-- one all enqueued nothing -- three of the four negatives in one assertion each.
select pg_temp.p7_assert(
  (select count(*) from private.integration_outbox
   where event_id = :'ev_review_id') = 1,
  'invoice.review_required must enqueue exactly one outbox row');

select pg_temp.p7_assert(
  (select target = 'webhook:a7000000-0000-4000-8000-000000000001'
      and status = 'pending'
      and org_id = '17000000-0000-0000-0000-000000000001'
      and correlation_id = 'a7b00000-0000-4000-8000-00000000000a'::uuid
   from private.integration_outbox where event_id = :'ev_review_id'),
  'the enqueued row must target the all-types subscription with the EVENT correlation id');

select pg_temp.p7_assert(
  not exists (
    select 1 from private.integration_outbox
    where target in ('webhook:a7000000-0000-4000-8000-000000000003',
                     'webhook:a7000000-0000-4000-8000-000000000004',
                     'webhook:a7000000-0000-4000-8000-000000000005')),
  'inactive, filter-mismatched and foreign-tenant subscriptions must enqueue NOTHING');

-- ===== (c) two matching subscriptions -> two rows =====

set local role authenticated;
select set_invoice_review_status('47000000-0000-0000-0000-000000000002',
  'approved', 'P7 double-subscription proof');
reset role;

select id as ev_approved_id
from domain_events
where entity_id = '47000000-0000-0000-0000-000000000002'
  and event_type = 'invoice.approved'
\gset

select pg_temp.p7_assert(
  (select count(*) from private.integration_outbox
   where event_id = :'ev_approved_id') = 2
    and (select count(distinct target) from private.integration_outbox
         where event_id = :'ev_approved_id') = 2,
  'invoice.approved must enqueue two rows -- one per matching subscription');

-- ===== (d) enqueue idempotency through the wave-5 seam =====

select pg_temp.p7_assert(
  (select private.enqueue_integration_outbox(
     :'ev_review_id'::uuid, 'webhook:a7000000-0000-4000-8000-000000000001'))
    = (select id from private.integration_outbox where event_id = :'ev_review_id'),
  're-enqueueing the same (target, event) must return the same outbox row');

select pg_temp.p7_assert(
  (select count(*) from private.integration_outbox
   where event_id = :'ev_review_id') = 1,
  'the idempotent re-enqueue must not add a row');

-- An unregistered target still enters the outbox through the seam (the worker will fail
-- it honestly -- proven in (f)).
select private.enqueue_integration_outbox(
  :'ev_review_id'::uuid, 'p7-unregistered-target') as unregistered_outbox_id \gset

-- ===== (e2)+(f) the signed claim =====

select set_config('request.jwt.claim.role', 'service_role', true);

create table pg_temp.p7_claimed (j jsonb);
insert into pg_temp.p7_claimed
select * from public.claim_integration_outbox('p7-worker', 10);

select pg_temp.p7_assert(
  (select count(*) from pg_temp.p7_claimed) = 4,
  'the claim must return all four due rows (1 review + 2 approved + 1 unregistered)');

-- Every REGISTERED row resolves: the subscription URL, a numeric timestamp, and a
-- signature that verifies against a recomputation over (body || '.' || timestamp) with
-- the subscription's Vault secret.
select pg_temp.p7_assert(
  (select count(*) from pg_temp.p7_claimed o
   join webhook_subscriptions w on w.target = o.j ->> 'target'
   join vault.decrypted_secrets ds on ds.id = w.secret_id
   where (o.j ->> 'url') = w.url
     and (o.j ->> 'timestamp') ~ '^[0-9]+$'
     and (o.j ->> 'signature')
         = encode(extensions.hmac((o.j ->> 'body') || '.' || (o.j ->> 'timestamp'),
                                  ds.decrypted_secret, 'sha256'), 'hex')) = 3,
  'every registered claim row must carry the URL and a verifiable signature');

-- The body is the DETERMINISTIC envelope serialization: recomputing the same
-- jsonb_build_object over the event row and casting to text reproduces it exactly.
select pg_temp.p7_assert(
  not exists (
    select 1
    from pg_temp.p7_claimed o
    join domain_events e on e.id = ((o.j -> 'event') ->> 'id')::uuid
    where (o.j ->> 'body') is distinct from jsonb_build_object(
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
      'metadata', e.metadata)::text),
  'the claim body must be the deterministic jsonb::text envelope serialization');

-- (f) the unregistered target claims WITHOUT url/signature/timestamp -- the worker's
-- wave-5 target_unregistered fail path is preserved.
select pg_temp.p7_assert(
  (select (j -> 'url') = 'null'::jsonb
      and (j -> 'signature') = 'null'::jsonb
      and (j -> 'timestamp') = 'null'::jsonb
      and (j ->> 'body') is not null
   from pg_temp.p7_claimed where j ->> 'target' = 'p7-unregistered-target'),
  'an unregistered target must claim without url/signature/timestamp');

-- Two DISTINCT outbound idempotency keys were recorded for the two-subscription event.
select pg_temp.p7_assert(
  (select count(distinct idempotency_key) from private.idempotency_keys
   where event_id = :'ev_approved_id') = 2,
  'two subscriptions must record two distinct idempotency keys');

-- ===== (g) claim -> complete, then claim -> fail x8 -> dead-letter -> replay =====

select id as outbox_review_id from private.integration_outbox
where event_id = :'ev_review_id'
  and target = 'webhook:a7000000-0000-4000-8000-000000000001'
\gset
select id as outbox_beta_id from private.integration_outbox
where event_id = :'ev_approved_id'
  and target = 'webhook:a7000000-0000-4000-8000-000000000002'
\gset

select public.complete_integration_outbox_delivery(
  :'outbox_review_id'::uuid, 'p7-worker', 200);

select pg_temp.p7_assert(
  (select status = 'delivered' and claimed_by is null
   from private.integration_outbox where id = :'outbox_review_id')
    and exists (
      select 1 from private.integration_deliveries
      where outbox_id = :'outbox_review_id'::uuid
        and status = 'delivered' and response_code = 200),
  'complete must mark the row delivered and record the delivery attempt');

-- Fail the filtered-subscription row to dead-letter: attempt 1 failed here, attempts
-- 2..8 in the loop (the p5:375-411 idiom -- auth.role() answers from the claim GUC, so
-- postgres can drive the RPCs while adjusting the clock).
select public.fail_integration_outbox_delivery(
  :'outbox_beta_id'::uuid, 'p7-worker', 'p7_simulated_failure', 503);

do $$
declare
  v_outbox uuid;
  v_claimed integer;
  k integer;
begin
  select o.id into strict v_outbox
  from private.integration_outbox o
  where o.target = 'webhook:a7000000-0000-4000-8000-000000000002'
    and o.status = 'pending';
  for k in 2..8 loop
    update private.integration_outbox
    set next_attempt_at = now() - interval '1 second'
    where id = v_outbox;

    select count(*) into v_claimed from public.claim_integration_outbox('p7-worker', 5);
    if v_claimed <> 1 then
      raise exception
        'P7 integration adapters assertion failed: retry claim % returned % rows',
        k, v_claimed;
    end if;

    perform public.fail_integration_outbox_delivery(
      v_outbox, 'p7-worker', 'p7_simulated_failure', 503);
  end loop;
end
$$;

select pg_temp.p7_assert(
  (select status = 'dead_letter' and attempt_count = 8
   from private.integration_outbox where id = :'outbox_beta_id'),
  'the 8th failed attempt must dead-letter the registered-target row');

select id as dead_letter_id from private.dead_letter_records
where outbox_id = :'outbox_beta_id'::uuid
\gset

select public.replay_dead_letter_record(:'dead_letter_id'::uuid, 'P7 replay proof');

select pg_temp.p7_assert(
  (select status = 'pending' and attempt_count = 0
   from private.integration_outbox where id = :'outbox_beta_id')
    and (select replayed_at is not null and replay_reason = 'P7 replay proof'
         from private.dead_letter_records where id = :'dead_letter_id'),
  'replay must reset the row and stamp (never delete) the dead-letter record');

-- ===== (h) the command surface =====

-- configure: happy path under the service claim.
select vault.create_secret('p7-secret-configure') as secret_configure \gset

select public.configure_webhook_subscription(
  '17000000-0000-0000-0000-000000000001',
  'https://p7.example.test/hooks/configured',
  array['invoice.approved'],
  :'secret_configure',
  'P7 configured subscription',
  'P7 configure reason') as configure_result
\gset

select pg_temp.p7_assert(
  (select (:'configure_result'::jsonb ->> 'active')::boolean is false
      and (:'configure_result'::jsonb ->> 'target')
          = 'webhook:' || (:'configure_result'::jsonb ->> 'id')),
  'configure must create the subscription INACTIVE with the generated target');

-- The reasoned configure audit row exists and carries NO secret reference at all.
select pg_temp.p7_assert(
  exists (
    select 1 from audit_logs
    where action = 'webhook_subscription_configured'
      and entity_id = (:'configure_result'::jsonb ->> 'id')::uuid
      and reason = 'P7 configure reason'
      and not (new_values ? 'secret_id')
      and new_values::text not ilike '%secret%'),
  'the configure audit row must be reasoned and secret-free');

-- configure negatives: bad URL scheme, unknown vault id, missing reason.
do $$
begin
  begin
    perform public.configure_webhook_subscription(
      '17000000-0000-0000-0000-000000000001', 'ftp://p7.example.test/x',
      '{}'::text[], gen_random_uuid(), null, 'P7 bad url');
    raise exception 'P7 integration adapters assertion failed: ftp url must be rejected';
  exception when sqlstate '22023' then
    if sqlerrm not like '%webhook_url_invalid%' then raise; end if;
  end;
  begin
    perform public.configure_webhook_subscription(
      '17000000-0000-0000-0000-000000000001', 'https://p7.example.test/x',
      '{}'::text[], '00000000-0000-4000-8000-00000000dead', null, 'P7 bad secret');
    raise exception 'P7 integration adapters assertion failed: unknown vault id must be rejected';
  exception when sqlstate 'P0002' then
    if sqlerrm not like '%webhook_secret_unknown%' then raise; end if;
  end;
  begin
    perform public.configure_webhook_subscription(
      '17000000-0000-0000-0000-000000000001', 'https://p7.example.test/x',
      '{}'::text[], gen_random_uuid(), null, '   ');
    raise exception 'P7 integration adapters assertion failed: blank reason must be rejected';
  exception when sqlstate '22023' then
    if sqlerrm not like '%webhook_subscription_invalid%' then raise; end if;
  end;
end
$$;

-- configure is service_role-only: without the service claim it refuses.
select set_config('request.jwt.claim.role', '', true);
do $$
begin
  begin
    perform public.configure_webhook_subscription(
      '17000000-0000-0000-0000-000000000001', 'https://p7.example.test/x',
      '{}'::text[], gen_random_uuid(), null, 'P7 not service');
    raise exception 'P7 integration adapters assertion failed: non-service configure must fail';
  exception when sqlstate '42501' then
    if sqlerrm not like '%not_authorized%' then raise; end if;
  end;
end
$$;

-- The failure recorder + the redacted reader.
select private.record_integration_failure(
  '17000000-0000-0000-0000-000000000001', 'webhook',
  'a7000000-0000-4000-8000-000000000001', 'signature_rejected',
  'raw provider text that must never reach a browser', null);
-- A null-org call skips quietly (the record_security_event contract).
select private.record_integration_failure(
  null, 'adapter', null, 'ignored', 'ignored', null);

select pg_temp.p7_assert(
  (select count(*) from integration_failures
   where org_id = '17000000-0000-0000-0000-000000000001') = 1,
  'the recorder must record with a tenant and skip quietly without one');

-- Owner reads codes and counts; the projection has NO raw_error key; office reads
-- nothing (zero rows, never an error).
select pg_temp.p7_claims('27000000-0000-0000-0000-000000000001');
set local role authenticated;
select pg_temp.p7_assert(
  (select count(*) from read_integration_failures()
   where error_code = 'signature_rejected' and failure_count = 1) = 1
    and not exists (
      select 1 from read_integration_failures() r
      where to_jsonb(r) ? 'raw_error' or to_jsonb(r)::text like '%provider text%'),
  'the owner reader must return codes and counts, never raw_error');

-- The owner sees the tenant's five subscriptions (four fixtures + the configured one;
-- the foreign-tenant fixture is invisible) and never the secret reference.
select pg_temp.p7_assert(
  (select count(*) from read_webhook_subscriptions()) = 5
    and not exists (
      select 1 from read_webhook_subscriptions() r
      where to_jsonb(r) ? 'secret_id'),
  'the owner subscription reader must list the five tenant rows without secret_id');
reset role;

select pg_temp.p7_claims('27000000-0000-0000-0000-000000000002');
set local role authenticated;
select pg_temp.p7_assert(
  (select count(*) from read_integration_failures()) = 0
    and (select count(*) from read_webhook_subscriptions()) = 0,
  'non-owner readers must get zero rows, never an error');
reset role;

-- set_webhook_subscription_active: the step-up boundary.
-- (1) owner WITHOUT fresh password proof -> fresh_authentication_required.
select pg_temp.p7_claims('27000000-0000-0000-0000-000000000001');
set local role authenticated;
do $$
begin
  begin
    perform set_webhook_subscription_active(
      'a7000000-0000-4000-8000-000000000003', true, 'P7 no amr');
    raise exception 'P7 integration adapters assertion failed: toggle without amr must fail';
  exception when sqlstate '42501' then
    if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
  end;
end
$$;
reset role;

-- (2) office (fresh proof) -> not authorized before anything else matters.
select pg_temp.p7_claims('27000000-0000-0000-0000-000000000002', interval '0');
set local role authenticated;
do $$
begin
  begin
    perform set_webhook_subscription_active(
      'a7000000-0000-4000-8000-000000000003', true, 'P7 office toggle');
    raise exception 'P7 integration adapters assertion failed: office toggle must fail';
  exception when sqlstate '42501' then
    if sqlerrm not like '%webhook_not_authorized%' then raise; end if;
  end;
end
$$;
reset role;

-- (3) owner + fresh proof + reason -> toggles, audits, records the security event.
select pg_temp.p7_claims('27000000-0000-0000-0000-000000000001', interval '0');
set local role authenticated;
do $$
begin
  begin
    perform set_webhook_subscription_active(
      'a7000000-0000-4000-8000-000000000003', true, '  ');
    raise exception 'P7 integration adapters assertion failed: blank toggle reason must fail';
  exception when sqlstate '22023' then
    if sqlerrm not like '%webhook_subscription_invalid%' then raise; end if;
  end;
end
$$;
select set_webhook_subscription_active(
  'a7000000-0000-4000-8000-000000000003', true, 'P7 enable proof');
select set_webhook_subscription_active(
  'a7000000-0000-4000-8000-000000000003', false, 'P7 disable proof');
reset role;

select pg_temp.p7_assert(
  (select active is false from webhook_subscriptions
   where id = 'a7000000-0000-4000-8000-000000000003')
    and (select count(*) from audit_logs
         where action = 'webhook_subscription_toggled'
           and entity_id = 'a7000000-0000-4000-8000-000000000003') = 2
    and (select count(*) from security_events
         where event_type = 'webhook_subscription_toggled'
           and org_id = '17000000-0000-0000-0000-000000000001') >= 2,
  'each toggle must leave a reasoned audit row and a security event');

-- ===== (i) the mutation proof: deactivation silences the enqueue =====

savepoint p7_subscription_mutation;
update webhook_subscriptions
set active = false
where org_id = '17000000-0000-0000-0000-000000000001';

select pg_temp.p7_claims('27000000-0000-0000-0000-000000000001');
set local role authenticated;
select set_invoice_review_status('47000000-0000-0000-0000-000000000003',
  'approved', 'P7 mutation proof (subscriptions off)');
reset role;

select pg_temp.p7_assert(
  (select count(*)
   from private.integration_outbox o
   join domain_events e on e.id = o.event_id
   where e.entity_id = '47000000-0000-0000-0000-000000000003') = 0,
  'with every subscription off the identical command must enqueue NOTHING');

rollback to savepoint p7_subscription_mutation;

-- Subscriptions restored (and the command rolled back with them): the same command
-- enqueues again -- one row per matching subscription.
select pg_temp.p7_claims('27000000-0000-0000-0000-000000000001');
set local role authenticated;
select set_invoice_review_status('47000000-0000-0000-0000-000000000003',
  'approved', 'P7 mutation proof (subscriptions restored)');
reset role;

select pg_temp.p7_assert(
  (select count(*)
   from private.integration_outbox o
   join domain_events e on e.id = o.event_id
   where e.entity_id = '47000000-0000-0000-0000-000000000003') = 2,
  'with subscriptions restored the same command must enqueue one row per match');

rollback;

\echo 'p7_integration_adapters_passed'
