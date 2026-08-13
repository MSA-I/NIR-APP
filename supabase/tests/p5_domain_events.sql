-- P5 domain-event harness for 0063-0064. Run only against an isolated local database
-- with every migration applied. The transaction is rolled back.
--
-- What it proves for the 0063 domain-event contract:
--   (a) an EXISTING reasoned command -- set_invoice_review_status, not edited for events
--       (asserted structurally against pg_proc) -- produces the correct domain event with
--       the payload the map row projects, through the audit fan-out alone;
--   (b) the map discriminates transitions from new_values: 'investigation' emits
--       invoice.review_required, 'approved' emits invoice.approved, and an unmapped
--       transition ('pending_approval') emits NOTHING;
--   (c) correlation: a request header is inherited (correlation_source='inherited',
--       equal to the audit row's id); with no source at all the event MINTS a root id
--       (NOT NULL holds, correlation_source='minted') while the audit row records NULL;
--   (d) causation arrives from the app.causation_id GUC on both the audit row and the
--       event;
--   (e) an unmapped action emits zero events -- including a generic service_role direct
--       audit insert (the allowlist contains it);
--   (f) a cross-tenant unit pointer on domain_events is structurally impossible (the
--       composite (org_id, unit_id) FK);
--   (g) the outbox stays EMPTY without a registered target (by design, not by luck), and
--       an empty outbox claims nothing;
--   (h) the delivery lifecycle through the REAL seam (private.enqueue_integration_outbox
--       -> claim -> fail x8): exponential backoff (1m base, 6h cap), dead-letter on the
--       8th attempt with a NOT NULL failure_reason, and a reasoned, audited replay;
--   (i) the mutation proof: deleting a map row makes the identifying assertion of (a)
--       fail for an identical command -- the map is load-bearing -- and restoring it
--       (savepoint rollback) makes the same command emit again.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p5_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P5 domain events assertion failed: %', p_message;
  end if;
end
$$;

-- JWT-claims stamp, the p4b_correlation.sql:34 idiom.
create function pg_temp.p5_claims(p_sub uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', p_sub::text, true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_sub::text)::text, true);
end
$$;

-- ===== Structural proofs first =====

-- The command under test was NOT edited for events: the fan-out alone carries them.
select pg_temp.p5_assert(
  not exists (
    select 1 from pg_proc
    where proname = 'set_invoice_review_status' and prosrc ilike '%domain_event%'),
  'set_invoice_review_status must not mention domain events -- the fan-out alone emits');

-- The fan-out function is word-clean of every enforced table name (the A5 contract):
-- entity knowledge lives in private.domain_event_map DATA only.
select pg_temp.p5_assert(
  not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join (select table_name from private.scope_registry where enforced) r
    where n.nspname = 'private'
      and p.proname = 'emit_domain_events_from_audit'
      and p.prosrc ~ ('\m' || r.table_name || '\M')),
  'the fan-out body must not name any enforced table -- the map holds the names');

-- The seeded map is the 26-row derivation (24 event types; two actions share
-- invoice.created and payment.executed each has two source literals), plus the
-- two monthly-report snapshot events 0074 added (created / sent).
select pg_temp.p5_assert(
  (select count(*) from private.domain_event_map) = 28
    and (select count(distinct event_type) from private.domain_event_map) = 26,
  'private.domain_event_map must hold the seeded 28 rows / 26 event types');

-- Worker surface ACL: browser roles never touch the outbox RPCs.
select pg_temp.p5_assert(
  not has_function_privilege('authenticated', 'public.claim_integration_outbox(text,integer)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.claim_integration_outbox(text,integer)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.claim_integration_outbox(text,integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.complete_integration_outbox_delivery(uuid,text,integer)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.complete_integration_outbox_delivery(uuid,text,integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.fail_integration_outbox_delivery(uuid,text,text,integer)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.fail_integration_outbox_delivery(uuid,text,text,integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.replay_dead_letter_record(uuid,text)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.replay_dead_letter_record(uuid,text)', 'EXECUTE'),
  'outbox worker RPCs must be service_role-only');

-- ===== Trusted fixtures (no JWT: migration/seed-style work) =====

insert into organizations (id, name, status) values
  ('15000000-0000-0000-0000-000000000001', 'P5 events tenant', 'active'),
  ('15000000-0000-0000-0000-000000000002', 'P5 foreign tenant', 'active');

insert into auth.users (id, email) values
  ('25000000-0000-0000-0000-000000000001', 'p5-owner@example.test');

insert into profiles (id, org_id, full_name, role) values
  ('25000000-0000-0000-0000-000000000001', '15000000-0000-0000-0000-000000000001',
   'P5 Owner', 'owner');

-- The supplier fixture carries bank details ON PURPOSE: the trigger-authored audit row
-- holds the full row image, and the map's payload allowlist must not leak it.
insert into suppliers (id, org_id, name, bank_details) values
  ('35000000-0000-0000-0000-000000000001', '15000000-0000-0000-0000-000000000001',
   'P5 Supplier', 'IL00-0000-secret-account');

insert into invoices (id, org_id, supplier_id, invoice_number, invoice_date,
                      amount_before_vat, vat_amount, total_amount, review_status) values
  ('45000000-0000-0000-0000-000000000001', '15000000-0000-0000-0000-000000000001',
   '35000000-0000-0000-0000-000000000001', 'P5-INV-1', current_date, 100, 0, 100, 'received'),
  ('45000000-0000-0000-0000-000000000002', '15000000-0000-0000-0000-000000000001',
   '35000000-0000-0000-0000-000000000001', 'P5-INV-2', current_date, 200, 0, 200, 'received'),
  ('45000000-0000-0000-0000-000000000003', '15000000-0000-0000-0000-000000000001',
   '35000000-0000-0000-0000-000000000001', 'P5-INV-3', current_date, 300, 0, 300,
   'pending_approval');

-- The fixture supplier insert itself proves the trigger-authored arm of the map:
-- audit_row_change wrote ('insert','suppliers') and the fan-out projected ONLY the
-- allowlisted keys -- the bank details stayed in the audit trail.
select pg_temp.p5_assert(
  (select count(*) from domain_events
   where org_id = '15000000-0000-0000-0000-000000000001'
     and event_type = 'supplier.created'
     and entity_id = '35000000-0000-0000-0000-000000000001') = 1,
  'a supplier fixture insert must fan out to exactly one supplier.created event');

select pg_temp.p5_assert(
  (select payload ? 'name' and payload ? 'status' and not payload ? 'bank_details'
   from domain_events
   where event_type = 'supplier.created'
     and entity_id = '35000000-0000-0000-0000-000000000001'),
  'supplier.created payload must hold only allowlisted keys -- never bank_details');

-- Direct invoice fixture inserts use trigger action ('insert','invoices'), which is
-- deliberately NOT mapped: invoice.created belongs to the reasoned creation command.
select pg_temp.p5_assert(
  (select count(*) from domain_events
   where entity_type = 'invoices') = 0,
  'direct invoice fixture inserts must not emit events -- (insert, invoices) is unmapped');

-- ===== (a) + (b) + (c inherited): header-correlated command emits through the map =====

select set_config('request.headers',
  '{"x-correlation-id":"a5b00000-0000-4000-8000-00000000000a"}', true);
select pg_temp.p5_claims('25000000-0000-0000-0000-000000000001');
set local role authenticated;
select set_invoice_review_status('45000000-0000-0000-0000-000000000001',
  'investigation', 'P5 review-required proof');
reset role;

select pg_temp.p5_assert(
  (select count(*) from domain_events
   where entity_id = '45000000-0000-0000-0000-000000000001'
     and event_type = 'invoice.review_required') = 1,
  'investigation transition must emit exactly one invoice.review_required event');

select id as ev_review_id, sequence as ev_review_seq
from domain_events
where entity_id = '45000000-0000-0000-0000-000000000001'
  and event_type = 'invoice.review_required'
\gset

select pg_temp.p5_assert(
  (select schema_version = 1
      and org_id = '15000000-0000-0000-0000-000000000001'
      and entity_type = 'invoices'
      and actor_id = '25000000-0000-0000-0000-000000000001'
      and (payload ->> 'review_status') = 'investigation'
      and payload - 'review_status' = '{}'::jsonb
      and (metadata ->> 'audit_action') = 'invoice_review_status_changed'
      and (metadata ->> 'reason') = 'P5 review-required proof'
      and occurred_at is not null
      and unit_id is null
   from domain_events where id = :'ev_review_id'),
  'invoice.review_required envelope must carry the map payload and the audit intent');

-- Correlation inherited: equal to the header AND to the audit row it fanned out from.
select pg_temp.p5_assert(
  (select correlation_id = 'a5b00000-0000-4000-8000-00000000000a'::uuid
      and correlation_source = 'inherited'
   from domain_events where id = :'ev_review_id'),
  'the event must inherit the request correlation id');

select pg_temp.p5_assert(
  (select a.correlation_id = e.correlation_id
   from domain_events e
   join audit_logs a on a.id = (e.metadata ->> 'audit_log_id')::uuid
   where e.id = :'ev_review_id'),
  'event and audit row must share one correlation id');

-- (b) an unmapped transition emits nothing.
set local role authenticated;
select set_invoice_review_status('45000000-0000-0000-0000-000000000001',
  'pending_approval', 'P5 unmapped transition proof');
reset role;

select pg_temp.p5_assert(
  (select count(*) from domain_events
   where entity_id = '45000000-0000-0000-0000-000000000001') = 1,
  'the pending_approval transition is unmapped and must emit nothing');

-- ===== (c minted) no source at all: the event mints, the audit row records NULL =====

select set_config('request.headers', '{}', true);
select set_config('app.correlation_id', '', true);
set local role authenticated;
select set_invoice_review_status('45000000-0000-0000-0000-000000000001',
  'approved', 'P5 minted correlation proof');
reset role;

select pg_temp.p5_assert(
  (select count(*) from domain_events
   where entity_id = '45000000-0000-0000-0000-000000000001'
     and event_type = 'invoice.approved') = 1,
  'the approved transition must emit exactly one invoice.approved event');

select pg_temp.p5_assert(
  (select e.correlation_id is not null
      and e.correlation_source = 'minted'
      and a.correlation_id is null
      and e.sequence > :'ev_review_seq'::bigint
   from domain_events e
   join audit_logs a on a.id = (e.metadata ->> 'audit_log_id')::uuid
   where e.entity_id = '45000000-0000-0000-0000-000000000001'
     and e.event_type = 'invoice.approved'),
  'with no source the event must mint a NOT NULL root id while the audit row holds NULL');

-- ===== (d) causation arrives from the GUC on both rows =====

select set_config('request.headers',
  '{"x-correlation-id":"a5b00000-0000-4000-8000-00000000000b"}', true);
select set_config('app.causation_id', 'a5b00000-0000-4000-8000-00000000000c', true);
set local role authenticated;
select set_invoice_review_status('45000000-0000-0000-0000-000000000002',
  'investigation', 'P5 causation proof');
reset role;
select set_config('app.causation_id', '', true);

select pg_temp.p5_assert(
  (select e.causation_id = 'a5b00000-0000-4000-8000-00000000000c'::uuid
      and a.causation_id = 'a5b00000-0000-4000-8000-00000000000c'::uuid
      and e.correlation_id = 'a5b00000-0000-4000-8000-00000000000b'::uuid
      and e.correlation_source = 'inherited'
   from domain_events e
   join audit_logs a on a.id = (e.metadata ->> 'audit_log_id')::uuid
   where e.entity_id = '45000000-0000-0000-0000-000000000002'
     and e.event_type = 'invoice.review_required'),
  'the app.causation_id GUC must land on both the audit row and the event');

-- ===== (e) unmapped action: a generic service_role direct write emits nothing =====

set local role service_role;
insert into audit_logs (org_id, user_id, action, entity_type, entity_id, reason) values
  ('15000000-0000-0000-0000-000000000001', '25000000-0000-0000-0000-000000000001',
   'p5_service_probe', 'organizations', '15000000-0000-0000-0000-000000000001',
   'P5 allowlist containment proof');
reset role;

select pg_temp.p5_assert(
  (select count(*) from domain_events
   where org_id = '15000000-0000-0000-0000-000000000001'
     and entity_type = 'organizations') = 0,
  'an unmapped service_role audit write must emit zero events (allowlist semantics)');

-- ===== (f) a cross-tenant unit pointer is structurally impossible =====

do $$
declare
  v_foreign_unit uuid;
begin
  select id into v_foreign_unit
  from org_units
  where org_id = '15000000-0000-0000-0000-000000000002' and unit_type = 'root';

  begin
    insert into domain_events (event_type, org_id, unit_id, entity_type)
    values ('p5.cross_tenant_probe', '15000000-0000-0000-0000-000000000001',
            v_foreign_unit, 'probe');
    raise exception 'P5 domain events assertion failed: cross-tenant unit insert must fail';
  exception
    when foreign_key_violation then
      null; -- exactly what the composite FK promises
  end;
end
$$;

-- ===== (g) the outbox is empty by design, and an empty outbox claims nothing =====

-- ORDER DEPENDENCY (wave 7): since 0066, an ACTIVE webhook_subscriptions row makes every
-- matching domain event enqueue outbox rows -- including the fixture events this file
-- creates above. The assertion below therefore holds only while no active subscription
-- exists when this suite runs: the gate runs p5 before the demo fixture is installed
-- (whose only subscription is INACTIVE), and p7_integration_adapters.sql rolls its
-- subscriptions back. Seeding an ACTIVE subscription into the gate database before this
-- point would honestly fail this arm -- move the seed, not the assertion.
select pg_temp.p5_assert(
  (select count(*) from private.integration_outbox) = 0,
  'no target is registered in this wave, so the outbox must be EMPTY by design');

-- The dispatcher without a config row is a quiet no-op (the 0028 pattern).
select pg_temp.p5_assert(
  (select private.dispatch_integration_outbox() is null),
  'the outbox dispatcher must no-op quietly without a config row');

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select pg_temp.p5_assert(
  (select count(*) from public.claim_integration_outbox('p5-worker', 5)) = 0,
  'an empty outbox must claim nothing');
reset role;

-- ===== (h) delivery lifecycle through the REAL seam =====

-- Enqueue the review event for a simulated target; the seam is idempotent.
select private.enqueue_integration_outbox(
  :'ev_review_id'::uuid, 'p5-simulated-target') as sim_outbox_id
\gset

select pg_temp.p5_assert(
  (select private.enqueue_integration_outbox(:'ev_review_id'::uuid, 'p5-simulated-target'))
    = :'sim_outbox_id'::uuid,
  're-enqueueing the same (target, event) must return the same outbox row');

select pg_temp.p5_assert(
  (select status = 'pending'
      and attempt_count = 0
      and org_id = '15000000-0000-0000-0000-000000000001'
      and correlation_id = 'a5b00000-0000-4000-8000-00000000000a'::uuid
   from private.integration_outbox where id = :'sim_outbox_id'),
  'the enqueued row must be pending with the EVENT''s correlation id');

-- First claim under the real service_role, with the full envelope in the claim payload.
set local role service_role;
select j ->> 'outbox_id' as claim_outbox_id,
       j ->> 'idempotency_key' as claim_idem_key,
       (j -> 'event') ->> 'id' as claim_event_id,
       (j -> 'event') ->> 'event_type' as claim_event_type
from public.claim_integration_outbox('p5-worker', 5) as j
\gset

select pg_temp.p5_assert(
  :'claim_outbox_id' = :'sim_outbox_id'
    and :'claim_event_id' = :'ev_review_id'
    and :'claim_event_type' = 'invoice.review_required'
    and :'claim_idem_key' = 'sf:' || :'ev_review_id' || ':p5-simulated-target',
  'the claim must return the outbox row with its event envelope and deterministic key');

select public.fail_integration_outbox_delivery(
  :'sim_outbox_id'::uuid, 'p5-worker', 'simulated_failure', 503);
reset role;

-- The (target, event) dedup key was recorded at first claim (OPEN-DECISIONS #91).
select pg_temp.p5_assert(
  exists (
    select 1 from private.idempotency_keys
    where target = 'p5-simulated-target'
      and event_id = :'ev_review_id'::uuid
      and idempotency_key = 'sf:' || :'ev_review_id' || ':p5-simulated-target'),
  'the first claim must record the outbound idempotency key');

-- First backoff: base 1 minute.
select pg_temp.p5_assert(
  (select status = 'pending'
      and attempt_count = 1
      and next_attempt_at between now() + interval '50 seconds'
                              and now() + interval '70 seconds'
   from private.integration_outbox where id = :'sim_outbox_id'),
  'after the first failure the row must wait ~1 minute (backoff base)');

-- Attempts 2..8: force each retry due, claim, fail. The 6th failure must hit the 6h cap;
-- the 8th is terminal (OPEN-DECISIONS #90). auth.role() answers from the claim GUC set
-- above, so the loop can drive the service RPCs while postgres adjusts the clock.
do $$
declare
  v_outbox uuid;
  v_claimed integer;
  v_next timestamptz;
  k integer;
begin
  -- psql variables do not interpolate inside dollar quoting; exactly one outbox row
  -- exists at this point (asserted above), so the lookup is deterministic.
  select id into strict v_outbox from private.integration_outbox;
  for k in 2..8 loop
    update private.integration_outbox
    set next_attempt_at = now() - interval '1 second'
    where id = v_outbox;

    select count(*) into v_claimed from public.claim_integration_outbox('p5-worker', 5);
    if v_claimed <> 1 then
      raise exception 'P5 domain events assertion failed: retry claim % returned % rows',
        k, v_claimed;
    end if;

    perform public.fail_integration_outbox_delivery(
      v_outbox, 'p5-worker', 'simulated_failure', 503);

    if k = 6 then
      select next_attempt_at into v_next
      from private.integration_outbox where id = v_outbox;
      if v_next is null
         or v_next < now() + interval '355 minutes'
         or v_next > now() + interval '365 minutes' then
        raise exception 'P5 domain events assertion failed: 6th backoff must hit the 6h cap (got %)',
          v_next - now();
      end if;
    end if;
  end loop;
end
$$;

select pg_temp.p5_assert(
  (select status = 'dead_letter' and attempt_count = 8 and claimed_by is null
   from private.integration_outbox where id = :'sim_outbox_id'),
  'the 8th failed attempt must dead-letter the row');

select pg_temp.p5_assert(
  (select count(*) from private.integration_deliveries
   where outbox_id = :'sim_outbox_id'::uuid and status = 'failed') = 8
    and (select count(distinct attempt) from private.integration_deliveries
         where outbox_id = :'sim_outbox_id'::uuid) = 8,
  'every attempt must leave exactly one delivery record (attempts 1..8)');

select id as dead_letter_id
from private.dead_letter_records
where outbox_id = :'sim_outbox_id'::uuid
\gset

select pg_temp.p5_assert(
  (select failure_reason = 'simulated_failure' and attempts = 8 and replayed_at is null
   from private.dead_letter_records where id = :'dead_letter_id'),
  'the dead-letter record must carry the failure reason and the attempt count');

-- Replay is a reasoned command: resets the row, stamps (never deletes) the record, and
-- leaves an audit row with the reason. Its own audit action is unmapped -- no event.
set local role service_role;
select public.replay_dead_letter_record(:'dead_letter_id'::uuid, 'P5 replay proof');
reset role;

select pg_temp.p5_assert(
  (select status = 'pending' and attempt_count = 0 and last_error is null
   from private.integration_outbox where id = :'sim_outbox_id'),
  'replay must return the row to pending with a fresh attempt budget');

select pg_temp.p5_assert(
  (select replayed_at is not null and replay_reason = 'P5 replay proof'
   from private.dead_letter_records where id = :'dead_letter_id'),
  'replay must stamp the dead-letter record, never delete it');

select pg_temp.p5_assert(
  exists (
    select 1 from audit_logs
    where action = 'integration_dead_letter_replayed'
      and entity_id = :'ev_review_id'::uuid
      and reason = 'P5 replay proof'),
  'replay must leave a reasoned audit row');

select pg_temp.p5_assert(
  (select count(*) from domain_events
   where (metadata ->> 'audit_action') = 'integration_dead_letter_replayed') = 0,
  'the replay audit action is unmapped and must emit no event');

do $$
begin
  begin
    perform public.replay_dead_letter_record(
      (select id from private.dead_letter_records limit 1), 'P5 double replay');
    raise exception 'P5 domain events assertion failed: double replay must fail';
  exception
    when others then
      if sqlerrm not like '%dead_letter_already_replayed%' then
        raise;
      end if;
  end;
end
$$;
select set_config('request.jwt.claim.role', '', true);

-- ===== (i) the mutation proof: the map row is load-bearing =====

savepoint p5_map_mutation;
delete from private.domain_event_map
where action = 'invoice_review_status_changed' and event_type = 'invoice.approved';

set local role authenticated;
select set_invoice_review_status('45000000-0000-0000-0000-000000000003',
  'approved', 'P5 mutation proof (map row deleted)');
reset role;

-- The identifying assertion of (a) now FAILS for an identical command: zero events.
select pg_temp.p5_assert(
  (select count(*) from domain_events
   where entity_id = '45000000-0000-0000-0000-000000000003') = 0,
  'with the map row deleted the identical command must emit nothing');

rollback to savepoint p5_map_mutation;

-- Map restored (and the command rolled back with it): the same command emits again.
set local role authenticated;
select set_invoice_review_status('45000000-0000-0000-0000-000000000003',
  'approved', 'P5 mutation proof (map row restored)');
reset role;

select pg_temp.p5_assert(
  (select count(*) from domain_events
   where entity_id = '45000000-0000-0000-0000-000000000003'
     and event_type = 'invoice.approved') = 1,
  'with the map row restored the same command must emit invoice.approved again');

rollback;

\echo 'p5_domain_events_passed'
