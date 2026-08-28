-- P59 -- the supplier order portal (0167): hashed one-order tokens, immutable structured
-- proposals, reasoned internal decisions, and revisions that never mutate history.
\set ON_ERROR_STOP on

begin;

-- Legacy invoice fixtures in this transaction predate multi-currency and are explicitly ILS.
alter table public.invoices alter column currency set default 'ILS';

create function pg_temp.p59_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P59 supplier portal assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p59_expect_error(p_sql text, p_fragment text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
    raise exception 'P59 expected error containing %, statement succeeded: %', p_fragment, p_sql;
  exception when others then
    if sqlerrm like 'P59 expected error%' or position(p_fragment in sqlerrm) = 0 then
      raise;
    end if;
  end;
end
$$;

create function pg_temp.p59_actor(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end
$$;

create function pg_temp.p59_service()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end
$$;

create function pg_temp.p59_hash(p_raw text)
returns text language sql immutable as
$$ select encode(sha256(convert_to(p_raw, 'UTF8')), 'hex') $$;

-- ===== Persistent distributed rate limit =====
select pg_temp.p59_assert(
  not has_function_privilege(
    'authenticated', 'public.service_check_supplier_portal_rate_limit(text)', 'execute')
  and has_function_privilege(
    'service_role', 'public.service_check_supplier_portal_rate_limit(text)', 'execute'),
  'the persistent rate-limit RPC is not service-role-only');
select pg_temp.p59_assert(
  not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'private'
      and table_name = 'supplier_portal_rate_limits'
      and grantee in ('anon', 'authenticated', 'service_role')),
  'a browser or service role can read the retained rate fingerprints directly');

-- Exercise the function's JWT guard through a DB role that may execute it. A direct denied
-- EXECUTE is intentionally avoided because the local Supabase image can terminate that backend.
select pg_temp.p59_actor('2a500000-0000-4000-8000-000000000001');
set local role service_role;
select pg_temp.p59_expect_error(
  $$select public.service_check_supplier_portal_rate_limit(repeat('a', 64))$$,
  'service_role_required');
select pg_temp.p59_service();
do $$
declare
  v_attempt integer;
  v_decision jsonb;
begin
  for v_attempt in 1..30 loop
    v_decision := public.service_check_supplier_portal_rate_limit(repeat('a', 64));
    perform pg_temp.p59_assert(
      (v_decision ->> 'allowed')::boolean
      and (v_decision ->> 'observed_count')::integer = v_attempt,
      'an allowed persistent rate hit returned the wrong count');
  end loop;
end
$$;
select pg_temp.p59_assert(
  not (public.service_check_supplier_portal_rate_limit(repeat('a', 64)) ->> 'allowed')::boolean,
  'the thirty-first request was not blocked across database calls');
reset role;
select pg_temp.p59_assert(
  (select hit_count = 31 and blocked_until > statement_timestamp()
   from private.supplier_portal_rate_limits where fingerprint = repeat('a', 64)),
  'the persistent rate row did not retain the block');

-- A completed minute resets the same key; another fingerprint has an independent window.
update private.supplier_portal_rate_limits
set window_started_at = statement_timestamp() - interval '2 minutes',
    hit_count = 30,
    blocked_until = null
where fingerprint = repeat('a', 64);
select pg_temp.p59_service();
set local role service_role;
select pg_temp.p59_assert(
  (public.service_check_supplier_portal_rate_limit(repeat('a', 64)) ->> 'allowed')::boolean,
  'an elapsed rate window did not reset');
select pg_temp.p59_assert(
  (public.service_check_supplier_portal_rate_limit(repeat('b', 64)) ->> 'allowed')::boolean,
  'an independent fingerprint inherited another source block');
select pg_temp.p59_expect_error(
  $$select public.service_check_supplier_portal_rate_limit('readable-ip')$$,
  'supplier_portal_rate_fingerprint_invalid');
reset role;
select pg_temp.p59_assert(
  (select hit_count = 1 from private.supplier_portal_rate_limits
   where fingerprint = repeat('a', 64))
  and (select hit_count = 1 from private.supplier_portal_rate_limits
       where fingerprint = repeat('b', 64)),
  'rate windows did not reset and isolate fingerprints independently');
select pg_temp.p59_assert(
  (select count(*) = 1 from cron.job
   where jobname = 'supplyflow-supplier-portal-rate-prune' and active),
  'the persistent rate-limit retention job is missing');

-- ===== Fixtures =====
insert into public.organizations (id, name, status) values
  ('1a500000-0000-4000-8000-000000000001', 'P59 A', 'active'),
  ('1a500000-0000-4000-8000-000000000002', 'P59 B', 'active');
insert into auth.users (id, email) values
  ('2a500000-0000-4000-8000-000000000001', 'owner-a-p59@example.test'),
  ('2a500000-0000-4000-8000-000000000002', 'accountant-a-p59@example.test'),
  ('2a500000-0000-4000-8000-000000000003', 'owner-b-p59@example.test');
insert into public.profiles (id, org_id, full_name, role) values
  ('2a500000-0000-4000-8000-000000000001', '1a500000-0000-4000-8000-000000000001', 'P59 owner A', 'owner'),
  ('2a500000-0000-4000-8000-000000000002', '1a500000-0000-4000-8000-000000000001', 'P59 accountant A', 'accountant'),
  ('2a500000-0000-4000-8000-000000000003', '1a500000-0000-4000-8000-000000000002', 'P59 owner B', 'owner');
insert into public.suppliers (id, org_id, name, status) values
  ('4a500000-0000-4000-8000-000000000001', '1a500000-0000-4000-8000-000000000001', 'P59 supplier A', 'active'),
  ('4a500000-0000-4000-8000-000000000002', '1a500000-0000-4000-8000-000000000002', 'P59 supplier B', 'active');
insert into public.products (id, org_id, name, unit) values
  ('3a500000-0000-4000-8000-000000000001', '1a500000-0000-4000-8000-000000000001', 'P59 flour', 'kg'),
  ('3a500000-0000-4000-8000-000000000002', '1a500000-0000-4000-8000-000000000001', 'P59 oil', 'liter'),
  ('3a500000-0000-4000-8000-000000000003', '1a500000-0000-4000-8000-000000000002', 'P59 foreign', 'unit');

insert into public.purchase_orders (id, org_id, supplier_id, status, expected_date, created_by) values
  ('6a500000-0000-4000-8000-000000000001', '1a500000-0000-4000-8000-000000000001',
   '4a500000-0000-4000-8000-000000000001', 'ready', current_date + 7,
   '2a500000-0000-4000-8000-000000000001'),
  ('6a500000-0000-4000-8000-000000000002', '1a500000-0000-4000-8000-000000000001',
   '4a500000-0000-4000-8000-000000000001', 'sent', null,
   '2a500000-0000-4000-8000-000000000001'),
  ('6a500000-0000-4000-8000-000000000003', '1a500000-0000-4000-8000-000000000002',
   '4a500000-0000-4000-8000-000000000002', 'ready', null,
   '2a500000-0000-4000-8000-000000000003');
insert into public.purchase_order_items (id, org_id, order_id, product_id, qty, unit_price) values
  ('7a500000-0000-4000-8000-000000000001', '1a500000-0000-4000-8000-000000000001',
   '6a500000-0000-4000-8000-000000000001', '3a500000-0000-4000-8000-000000000001', 5, 10),
  ('7a500000-0000-4000-8000-000000000002', '1a500000-0000-4000-8000-000000000001',
   '6a500000-0000-4000-8000-000000000001', '3a500000-0000-4000-8000-000000000002', 2, 20),
  ('7a500000-0000-4000-8000-000000000003', '1a500000-0000-4000-8000-000000000001',
   '6a500000-0000-4000-8000-000000000002', '3a500000-0000-4000-8000-000000000001', 1, 10),
  ('7a500000-0000-4000-8000-000000000004', '1a500000-0000-4000-8000-000000000002',
   '6a500000-0000-4000-8000-000000000003', '3a500000-0000-4000-8000-000000000003', 1, 1);
insert into public.goods_receipts (id, org_id, order_id, status, received_by) values (
  '8a500000-0000-4000-8000-000000000001', '1a500000-0000-4000-8000-000000000001',
  '6a500000-0000-4000-8000-000000000001', 'draft',
  '2a500000-0000-4000-8000-000000000001');
insert into public.invoices (
  id, org_id, supplier_id, invoice_number, invoice_date, received_by,
  amount_before_vat, vat_amount, total_amount
) values (
  '8b500000-0000-4000-8000-000000000001', '1a500000-0000-4000-8000-000000000001',
  '4a500000-0000-4000-8000-000000000001', 'P59-EVIDENCE', current_date,
  '2a500000-0000-4000-8000-000000000001', 76.92, 13.08, 90.00);
insert into public.invoice_order_links (org_id, invoice_id, order_id) values (
  '1a500000-0000-4000-8000-000000000001',
  '8b500000-0000-4000-8000-000000000001',
  '6a500000-0000-4000-8000-000000000001');

-- ===== 1. Issuing: role gate, reason gate, tenancy, token round trip =====
select pg_temp.p59_actor('2a500000-0000-4000-8000-000000000002');
select pg_temp.p59_expect_error(
  $$select issue_supplier_order_link('6a500000-0000-4000-8000-000000000001', 'x')$$,
  'not_authorized');

select pg_temp.p59_actor('2a500000-0000-4000-8000-000000000001');
select pg_temp.p59_expect_error(
  $$select issue_supplier_order_link('6a500000-0000-4000-8000-000000000001', '  ')$$,
  'reason_required');
select pg_temp.p59_expect_error(
  $$select issue_supplier_order_link('6a500000-0000-4000-8000-000000000003', 'cross tenant')$$,
  'order_unknown');

create table pg_temp.p59_state (key text primary key, value text);
do $$
declare
  v jsonb;
begin
  v := issue_supplier_order_link('6a500000-0000-4000-8000-000000000001', 'P59 first issue');
  insert into pg_temp.p59_state values ('token1', v ->> 'token'), ('link1', v ->> 'link_id');
end
$$;

select pg_temp.p59_assert(
  (select value ~ '^[0-9a-f]{64}$' from pg_temp.p59_state where key = 'token1'),
  'raw token is 64 hex chars');
select pg_temp.p59_assert(
  (select count(*) = 1 from supplier_order_links l
   where l.id = (select value::uuid from pg_temp.p59_state where key = 'link1')
     and l.token_hash = pg_temp.p59_hash((select value from pg_temp.p59_state where key = 'token1'))
     and l.revoked_at is null
     and l.expires_at > statement_timestamp()),
  'link stores only the hash of the returned token, live and expiring');
select pg_temp.p59_assert(
  (select jsonb_array_length(order_snapshot -> 'items') = 2
      and order_snapshot ->> 'org_name' = 'P59 A'
      and order_snapshot -> 'items' -> 0 ->> 'product_name' = 'P59 flour'
   from supplier_order_links
   where id = (select value::uuid from pg_temp.p59_state where key = 'link1')),
  'snapshot carries the raw supplier-facing wording and both rows');
select pg_temp.p59_assert(
  (select count(*) = 1 from audit_logs
   where org_id = '1a500000-0000-4000-8000-000000000001'
     and action = 'supplier_order_link_issued'
     and entity_id = (select value::uuid from pg_temp.p59_state where key = 'link1')
     and reason = 'P59 first issue'),
  'issuing is audited with the reason');

-- ===== 2. Regeneration kills the previous link =====
do $$
declare
  v jsonb;
begin
  v := issue_supplier_order_link('6a500000-0000-4000-8000-000000000001', 'P59 regenerate');
  insert into pg_temp.p59_state values ('token2', v ->> 'token'), ('link2', v ->> 'link_id');
end
$$;
select pg_temp.p59_assert(
  (select revoked_at is not null and revoked_reason = 'regenerated'
   from supplier_order_links
   where id = (select value::uuid from pg_temp.p59_state where key = 'link1')),
  'regeneration revokes the previous link');

-- Manual revocation is reasoned, audited, and indistinguishable from every other dead link.
do $$
declare
  v jsonb;
begin
  v := issue_supplier_order_link('6a500000-0000-4000-8000-000000000002', 'P59 revoke issue');
  insert into pg_temp.p59_state values
    ('revoked_token', v ->> 'token'), ('revoked_link', v ->> 'link_id');
end
$$;
select revoke_supplier_order_link(
  (select value::uuid from pg_temp.p59_state where key = 'revoked_link'), 'P59 manual revoke');
select pg_temp.p59_assert(
  (select revoked_by = '2a500000-0000-4000-8000-000000000001'
      and revoked_reason = 'P59 manual revoke'
   from supplier_order_links
   where id = (select value::uuid from pg_temp.p59_state where key = 'revoked_link')),
  'manual revocation did not retain actor and reason');
select pg_temp.p59_assert(
  (select count(*) = 1 from audit_logs
   where action = 'supplier_order_link_revoked'
     and entity_id = (select value::uuid from pg_temp.p59_state where key = 'revoked_link')
     and reason = 'P59 manual revoke'),
  'manual revocation is not audited');

-- ===== 3. Redemption: service_role only, uniform miss, open accounting =====
select pg_temp.p59_expect_error(
  $$select service_resolve_supplier_order_link(repeat('a', 64))$$,
  'service_role_required');

select pg_temp.p59_service();
select pg_temp.p59_assert(
  service_resolve_supplier_order_link(
    pg_temp.p59_hash((select value from pg_temp.p59_state where key = 'token1'))) is null,
  'a revoked link resolves to nothing');
select pg_temp.p59_assert(
  service_resolve_supplier_order_link(
    pg_temp.p59_hash((select value from pg_temp.p59_state where key = 'revoked_token'))) is null,
  'a manually revoked link resolves to the same uniform miss');
select pg_temp.p59_assert(
  service_resolve_supplier_order_link(repeat('0', 64)) is null,
  'an unknown token resolves to nothing');
select pg_temp.p59_assert(
  (select count(*) >= 1 from private.supplier_portal_lookup_failures),
  'failed lookups are ledgered');

select pg_temp.p59_assert(
  (select (service_resolve_supplier_order_link(
     pg_temp.p59_hash((select value from pg_temp.p59_state where key = 'token2')))
     ->> 'state') = 'open'),
  'a live link resolves open');
select pg_temp.p59_assert(
  (select opened_at is not null and open_count = 1 from supplier_order_links
   where id = (select value::uuid from pg_temp.p59_state where key = 'link2')),
  'first open is stamped and counted');

-- ===== 4. Expiry lives in the WHERE clause =====
insert into supplier_order_links (
  org_id, purchase_order_id, supplier_id, token_hash, order_snapshot, expires_at, issued_by
) values (
  '1a500000-0000-4000-8000-000000000001', '6a500000-0000-4000-8000-000000000002',
  '4a500000-0000-4000-8000-000000000001', pg_temp.p59_hash('expired-token-p59'),
  '{"items": []}'::jsonb, statement_timestamp() - interval '1 hour',
  '2a500000-0000-4000-8000-000000000001');
select pg_temp.p59_assert(
  service_resolve_supplier_order_link(pg_temp.p59_hash('expired-token-p59')) is null,
  'an expired link resolves to nothing');

-- ===== 5. Submission: snapshot-fenced, computed deltas, one per link =====
-- Failures are answered in-band so the attempt bookkeeping COMMITS (a raise would roll it back).
select pg_temp.p59_assert(
  (select (service_submit_supplier_order_proposal(
     pg_temp.p59_hash((select value from pg_temp.p59_state where key = 'token2')),
     '{"lines": [{"order_item_id": "7a500000-0000-4000-8000-000000000003", "availability": "available"}]}'::jsonb)
     ->> 'error') = 'proposal_invalid'),
  'a line outside the snapshot is refused as proposal_invalid');
select pg_temp.p59_assert(
  (select failed_attempts = 1 from supplier_order_links
   where id = (select value::uuid from pg_temp.p59_state where key = 'link2')),
  'a malformed submission is counted against the link');

do $$
declare
  v jsonb;
begin
  v := service_submit_supplier_order_proposal(
    pg_temp.p59_hash((select value from pg_temp.p59_state where key = 'token2')),
    jsonb_build_object(
      'proposed_delivery_date', (current_date + 14)::text,
      'supplier_note', 'P59 note',
      'lines', jsonb_build_array(
        jsonb_build_object('order_item_id', '7a500000-0000-4000-8000-000000000001',
                           'proposed_qty', 3, 'proposed_unit_price', 9),
        jsonb_build_object('order_item_id', '7a500000-0000-4000-8000-000000000002',
                           'availability', 'unavailable',
                           'replacement_note', 'P59 replacement'))));
  insert into pg_temp.p59_state values ('proposal1', v ->> 'proposal_id');
end
$$;

select pg_temp.p59_assert(
  (select status = 'submitted'
      and proposed_delivery_date = current_date + 14
      and supplier_note = 'P59 note'
      and total_delta = -63.00
   from supplier_order_proposals
   where id = (select value::uuid from pg_temp.p59_state where key = 'proposal1')),
  'proposal row: submitted, dated, noted, and totalled server-side (-23 - 40 = -63)');
select pg_temp.p59_assert(
  (select count(*) = 2
      and sum(case when availability = 'unavailable' then 1 else 0 end) = 1
      and min(line_delta) = -40.00 and max(line_delta) = -23.00
   from supplier_order_proposal_lines
   where proposal_id = (select value::uuid from pg_temp.p59_state where key = 'proposal1')),
  'line evidence: one per row, computed deltas, availability preserved');
select pg_temp.p59_assert(
  (select submitted_at is not null from supplier_order_links
   where id = (select value::uuid from pg_temp.p59_state where key = 'link2')),
  'the link is spent by submission');
select pg_temp.p59_assert(
  (select count(*) = 1 from audit_logs
   where action = 'supplier_order_proposal_submitted'
     and entity_id = (select value::uuid from pg_temp.p59_state where key = 'proposal1')
     and user_id is null),
  'submission is audited as a machine actor (user_id null)');

-- Replay of the SAME payload answers idempotently; a DIFFERENT payload is refused.
select pg_temp.p59_assert(
  (select (service_submit_supplier_order_proposal(
     pg_temp.p59_hash((select value from pg_temp.p59_state where key = 'token2')),
     jsonb_build_object(
       'proposed_delivery_date', (current_date + 14)::text,
       'supplier_note', 'P59 note',
       'lines', jsonb_build_array(
         jsonb_build_object('order_item_id', '7a500000-0000-4000-8000-000000000001',
                            'proposed_qty', 3, 'proposed_unit_price', 9),
         jsonb_build_object('order_item_id', '7a500000-0000-4000-8000-000000000002',
                            'availability', 'unavailable',
                            'replacement_note', 'P59 replacement'))))
     ->> 'replayed')::boolean),
  'an identical retry is answered idempotently');
select pg_temp.p59_assert(
  (select (service_submit_supplier_order_proposal(
     pg_temp.p59_hash((select value from pg_temp.p59_state where key = 'token2')),
     '{"lines": [{"order_item_id": "7a500000-0000-4000-8000-000000000001", "proposed_qty": 4}]}'::jsonb)
     ->> 'error') = 'proposal_already_submitted'),
  'a DIFFERENT payload on a spent link is a conflict, not a second version');
select pg_temp.p59_assert(
  (select count(*) = 1 from supplier_order_proposals
   where link_id = (select value::uuid from pg_temp.p59_state where key = 'link2')),
  'one proposal per link, structurally');

-- ===== 6. A pending proposal blocks a new round =====
select pg_temp.p59_actor('2a500000-0000-4000-8000-000000000001');
select pg_temp.p59_expect_error(
  $$select issue_supplier_order_link('6a500000-0000-4000-8000-000000000001', 'again')$$,
  'proposal_pending_decision');

-- ===== 7. Deciding: complete, reasoned, audited =====
select pg_temp.p59_actor('2a500000-0000-4000-8000-000000000003');
select pg_temp.p59_expect_error(
  format($$select decide_supplier_order_proposal(%L, '[]'::jsonb, true, 'x')$$,
    (select value from pg_temp.p59_state where key = 'proposal1')),
  'proposal_unknown');

select pg_temp.p59_actor('2a500000-0000-4000-8000-000000000001');
select pg_temp.p59_expect_error(
  format($$select decide_supplier_order_proposal(%L,
    (select jsonb_agg(jsonb_build_object('line_id', l.id, 'decision', 'accepted'))
     from supplier_order_proposal_lines l
     where l.proposal_id = %L and l.availability = 'available'), true, 'partial only')$$,
    (select value from pg_temp.p59_state where key = 'proposal1'),
    (select value from pg_temp.p59_state where key = 'proposal1')),
  'decisions_incomplete');
select pg_temp.p59_expect_error(
  format($$select decide_supplier_order_proposal(%L,
    (select jsonb_agg(jsonb_build_object('line_id', l.id, 'decision',
       case when l.availability = 'available' then 'accepted' else 'rejected' end))
     from supplier_order_proposal_lines l where l.proposal_id = %L), true, null)$$,
    (select value from pg_temp.p59_state where key = 'proposal1'),
    (select value from pg_temp.p59_state where key = 'proposal1')),
  'decision_reason_required');

select decide_supplier_order_proposal(
  (select value::uuid from pg_temp.p59_state where key = 'proposal1'),
  (select jsonb_agg(jsonb_build_object('line_id', l.id, 'decision',
     case when l.availability = 'available' then 'accepted' else 'rejected' end))
   from supplier_order_proposal_lines l
   where l.proposal_id = (select value::uuid from pg_temp.p59_state where key = 'proposal1')),
  true, 'P59 partial acceptance');

select pg_temp.p59_assert(
  (select status = 'partially_accepted'
      and decided_by = '2a500000-0000-4000-8000-000000000001'
      and decision_reason = 'P59 partial acceptance'
      and delivery_date_accepted
   from supplier_order_proposals
   where id = (select value::uuid from pg_temp.p59_state where key = 'proposal1')),
  'decision recorded with actor, reason, and the delivery-date verdict');
select pg_temp.p59_expect_error(
  format($$select decide_supplier_order_proposal(%L, '[]'::jsonb, true, 'x')$$,
    (select value from pg_temp.p59_state where key = 'proposal1')),
  'proposal_already_decided');
select pg_temp.p59_assert(
  (select count(*) = 1 from audit_logs
   where action = 'supplier_order_proposal_decided'
     and entity_id = (select value::uuid from pg_temp.p59_state where key = 'proposal1')
     and reason = 'P59 partial acceptance'),
  'the decision is audited');

-- ===== 8. The revision: history intact, accepted numbers in, original superseded =====
do $$
declare
  v uuid;
begin
  v := create_purchase_order_revision_from_proposal(
    (select value::uuid from pg_temp.p59_state where key = 'proposal1'), 'P59 revision');
  insert into pg_temp.p59_state values ('revision', v::text);
end
$$;

select pg_temp.p59_assert(
  (select status = 'ready'
      and revision_number = 2
      and revised_from_order_id = '6a500000-0000-4000-8000-000000000001'
      and expected_date = current_date + 14
   from purchase_orders
   where id = (select value::uuid from pg_temp.p59_state where key = 'revision')),
  'revision: new ready order, chained, carrying the accepted delivery date');
select pg_temp.p59_assert(
  (select count(*) = 2
      and sum(case when product_id = '3a500000-0000-4000-8000-000000000001'
                    and qty = 3 and unit_price = 9 then 1 else 0 end) = 1
      and sum(case when product_id = '3a500000-0000-4000-8000-000000000002'
                    and qty = 2 and unit_price = 20 then 1 else 0 end) = 1
   from purchase_order_items
   where order_id = (select value::uuid from pg_temp.p59_state where key = 'revision')),
  'accepted change carries the proposed numbers; rejected unavailability keeps the original row');
select pg_temp.p59_assert(
  (select status = 'cancelled' from purchase_orders
   where id = '6a500000-0000-4000-8000-000000000001'),
  'the original order is superseded, not edited');
select pg_temp.p59_assert(
  (select count(*) = 2 and min(qty) = 2 and max(qty) = 5
   from purchase_order_items
   where order_id = '6a500000-0000-4000-8000-000000000001'),
  'the original order rows are untouched evidence');
select pg_temp.p59_assert(
  (select count(*) = 1 from goods_receipts
   where id = '8a500000-0000-4000-8000-000000000001'
     and order_id = '6a500000-0000-4000-8000-000000000001'),
  'the original receipt evidence did not remain linked to the original order');
select pg_temp.p59_assert(
  (select count(*) = 1 from invoice_order_links
   where invoice_id = '8b500000-0000-4000-8000-000000000001'
     and order_id = '6a500000-0000-4000-8000-000000000001'),
  'the original invoice evidence did not remain linked to the original order');
select pg_temp.p59_assert(
  (select revision_order_id = (select value::uuid from pg_temp.p59_state where key = 'revision')
   from supplier_order_proposals
   where id = (select value::uuid from pg_temp.p59_state where key = 'proposal1')),
  'the proposal points at the revision it produced');
select pg_temp.p59_expect_error(
  format($$select create_purchase_order_revision_from_proposal(%L, 'twice')$$,
    (select value from pg_temp.p59_state where key = 'proposal1')),
  'revision_already_created');

-- ===== 9. Lock after repeated failed submissions =====
select pg_temp.p59_actor('2a500000-0000-4000-8000-000000000001');
do $$
declare
  v jsonb;
begin
  v := issue_supplier_order_link(
    (select value::uuid from pg_temp.p59_state where key = 'revision'), 'P59 lock test');
  insert into pg_temp.p59_state values ('token3', v ->> 'token'), ('link3', v ->> 'link_id');
end
$$;
update supplier_order_links set failed_attempts = 19
where id = (select value::uuid from pg_temp.p59_state where key = 'link3');
select pg_temp.p59_service();
select pg_temp.p59_assert(
  (select (service_submit_supplier_order_proposal(
     pg_temp.p59_hash((select value from pg_temp.p59_state where key = 'token3')),
     '{"lines": [{"order_item_id": "00000000-0000-4000-8000-000000000000", "availability": "available"}]}'::jsonb)
     ->> 'error') = 'proposal_invalid'),
  'the malformed submission is refused');
select pg_temp.p59_assert(
  (select locked_until > statement_timestamp() from supplier_order_links
   where id = (select value::uuid from pg_temp.p59_state where key = 'link3')),
  'the twentieth failure locks the link');
select pg_temp.p59_assert(
  (select (service_submit_supplier_order_proposal(
     pg_temp.p59_hash((select value from pg_temp.p59_state where key = 'token3')),
     '{"lines": [{"order_item_id": "00000000-0000-4000-8000-000000000000", "availability": "available"}]}'::jsonb)
     ->> 'error') = 'link_locked'),
  'a locked link refuses further submissions by name');
select pg_temp.p59_assert(
  (select (service_resolve_supplier_order_link(
     pg_temp.p59_hash((select value from pg_temp.p59_state where key = 'token3')))
     ->> 'state') = 'locked'),
  'a locked link answers locked, not the order');

-- ===== 10. Tenancy and the browser surface =====
select pg_temp.p59_actor('2a500000-0000-4000-8000-000000000003');
set local role authenticated;
select pg_temp.p59_assert(
  (select count(id) = 0 from supplier_order_links),
  'a foreign tenant reads no links');
select pg_temp.p59_assert(
  (select count(id) = 0 from supplier_order_proposals),
  'a foreign tenant reads no proposals');
reset role;

select pg_temp.p59_assert(
  not has_column_privilege('authenticated', 'public.supplier_order_links', 'token_hash', 'SELECT'),
  'token_hash never reaches the browser');
select pg_temp.p59_assert(
  not has_table_privilege('authenticated', 'public.supplier_order_links', 'INSERT')
  and not has_table_privilege('authenticated', 'public.supplier_order_proposals', 'INSERT')
  and not has_table_privilege('authenticated', 'public.supplier_order_proposal_lines', 'INSERT')
  and not has_table_privilege('anon', 'public.supplier_order_links', 'SELECT'),
  'no browser DML anywhere, and anon reads nothing');

-- ===== 11. Immutability guards =====
select pg_temp.p59_expect_error(
  format($$update supplier_order_proposal_lines set original_qty = 99 where proposal_id = %L$$,
    (select value from pg_temp.p59_state where key = 'proposal1')),
  'supplier_order_proposal_line_immutable');
select pg_temp.p59_expect_error(
  format($$delete from supplier_order_proposals where id = %L$$,
    (select value from pg_temp.p59_state where key = 'proposal1')),
  'supplier_order_proposal_immutable');
select pg_temp.p59_expect_error(
  format($$update supplier_order_links set order_snapshot = '{}'::jsonb where id = %L$$,
    (select value from pg_temp.p59_state where key = 'link2')),
  'supplier_order_link_immutable');

rollback;

\echo 'p59_supplier_order_portal_passed'
