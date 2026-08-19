-- P60 -- email order delivery (0168): fail-closed preferences, the claim/settle ledger in the
-- 0028 shape, and `sent` stamped only by the observed provider event.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p51_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P51 email delivery assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p51_expect_error(p_sql text, p_fragment text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
    raise exception 'P51 expected error containing %, statement succeeded: %', p_fragment, p_sql;
  exception when others then
    if sqlerrm like 'P51 expected error%' or position(p_fragment in sqlerrm) = 0 then
      raise;
    end if;
  end;
end
$$;

create function pg_temp.p51_actor(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end
$$;

create function pg_temp.p51_service()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end
$$;

-- ===== Fixtures =====
insert into public.organizations (id, name, status) values
  ('1a510000-0000-4000-8000-000000000001', 'P51 A', 'active'),
  ('1a510000-0000-4000-8000-000000000002', 'P51 B', 'active');
insert into auth.users (id, email) values
  ('2a510000-0000-4000-8000-000000000001', 'owner-a-p51@example.test'),
  ('2a510000-0000-4000-8000-000000000002', 'accountant-a-p51@example.test'),
  ('2a510000-0000-4000-8000-000000000003', 'owner-b-p51@example.test');
insert into public.profiles (id, org_id, full_name, role) values
  ('2a510000-0000-4000-8000-000000000001', '1a510000-0000-4000-8000-000000000001', 'P51 owner A', 'owner'),
  ('2a510000-0000-4000-8000-000000000002', '1a510000-0000-4000-8000-000000000001', 'P51 accountant A', 'accountant'),
  ('2a510000-0000-4000-8000-000000000003', '1a510000-0000-4000-8000-000000000002', 'P51 owner B', 'owner');
insert into public.suppliers (id, org_id, name, status, email, phone) values
  ('4a510000-0000-4000-8000-000000000001', '1a510000-0000-4000-8000-000000000001',
   'P51 supplier', 'active', 'Supplier@Example.TEST', '050-1234567'),
  ('4a510000-0000-4000-8000-000000000002', '1a510000-0000-4000-8000-000000000001',
   'P51 no-email supplier', 'active', null, null);
insert into public.products (id, org_id, name, unit) values
  ('3a510000-0000-4000-8000-000000000001', '1a510000-0000-4000-8000-000000000001', 'P51 rice', 'kg');
insert into public.purchase_orders (id, org_id, supplier_id, status, expected_date, created_by) values
  ('6a510000-0000-4000-8000-000000000001', '1a510000-0000-4000-8000-000000000001',
   '4a510000-0000-4000-8000-000000000001', 'ready', current_date + 5,
   '2a510000-0000-4000-8000-000000000001'),
  ('6a510000-0000-4000-8000-000000000002', '1a510000-0000-4000-8000-000000000001',
   '4a510000-0000-4000-8000-000000000002', 'ready', null,
   '2a510000-0000-4000-8000-000000000001');
insert into public.purchase_order_items (id, org_id, order_id, product_id, qty, unit_price) values
  ('7a510000-0000-4000-8000-000000000001', '1a510000-0000-4000-8000-000000000001',
   '6a510000-0000-4000-8000-000000000001', '3a510000-0000-4000-8000-000000000001', 10, 4.5);

-- ===== 1. The egress vocabulary accepts the new kind =====
select pg_temp.p51_service();
select pg_temp.p51_assert(
  (select (reservation ->> 'egress_allowed')::boolean
      and (reservation ->> 'kind') = 'supplier_order_email'
   from service_reserve_organization_external_egress(
     '1a510000-0000-4000-8000-000000000001', 'supplier_order_email',
     'aa510000-0000-4000-8000-0000000000aa', 60) reservation),
  'supplier_order_email is a reservable egress kind');

-- ===== 2. Preferences: fail-closed, validated, audited =====
select pg_temp.p51_actor('2a510000-0000-4000-8000-000000000002');
select pg_temp.p51_expect_error(
  $$select set_supplier_communication_preferences('4a510000-0000-4000-8000-000000000001',
    'email', 'he', null, null, false, 'x')$$,
  'not_authorized');

select pg_temp.p51_actor('2a510000-0000-4000-8000-000000000001');
select pg_temp.p51_expect_error(
  $$select set_supplier_communication_preferences('4a510000-0000-4000-8000-000000000001',
    'email', 'he', null, null, false, '  ')$$,
  'reason_required');
select pg_temp.p51_expect_error(
  $$select set_supplier_communication_preferences('4a510000-0000-4000-8000-000000000001',
    'carrier-pigeon', 'he', null, null, false, 'x')$$,
  'communication_preferences_invalid');
select pg_temp.p51_expect_error(
  $$select set_supplier_communication_preferences('4a510000-0000-4000-8000-000000000001',
    'email', 'he', 'not-an-email', null, false, 'x')$$,
  'communication_email_invalid');
-- A provider channel without a reachable destination refuses up front.
select pg_temp.p51_expect_error(
  $$select set_supplier_communication_preferences('4a510000-0000-4000-8000-000000000002',
    'email', 'he', null, null, false, 'x')$$,
  'communication_email_destination_missing');
select pg_temp.p51_expect_error(
  $$select set_supplier_communication_preferences('4a510000-0000-4000-8000-000000000001',
    'whatsapp', 'he', null, 'abc', false, 'x')$$,
  'communication_whatsapp_invalid');

select set_supplier_communication_preferences(
  '4a510000-0000-4000-8000-000000000001', 'email', 'he', null, null, true, 'P51 enable email');
select pg_temp.p51_assert(
  (select channel = 'email' and locale = 'he' and reminders_allowed
   from supplier_communication_preferences
   where org_id = '1a510000-0000-4000-8000-000000000001'
     and supplier_id = '4a510000-0000-4000-8000-000000000001'),
  'preferences persisted');
select pg_temp.p51_assert(
  (select count(*) = 1 from audit_logs
   where action = 'supplier_communication_preferences_set'
     and entity_id = '4a510000-0000-4000-8000-000000000001'
     and reason = 'P51 enable email'),
  'preference change audited with reason');

-- ===== 3. Claim: channel gate, ledger creation, the link rides along =====
select pg_temp.p51_expect_error(
  $$select claim_email_order_message('6a510000-0000-4000-8000-000000000002', 'send it')$$,
  'email_channel_disabled');

create table pg_temp.p51_state (key text primary key, value text);
do $$
declare
  v jsonb;
begin
  v := claim_email_order_message('6a510000-0000-4000-8000-000000000001', 'P51 first send');
  if v ->> 'state' <> 'claimed' then
    raise exception 'P51: expected claimed, got %', v ->> 'state';
  end if;
  insert into pg_temp.p51_state values
    ('message1', v ->> 'message_id'),
    ('token1', v ->> 'portal_token');
end
$$;

select pg_temp.p51_assert(
  (select status = 'sending' and attempt_count = 1 and to_email = 'supplier@example.test'
      and locale = 'he' and template_name = 'new_purchase_order' and template_version = 1
      and link_id is not null and lease_expires_at > now()
   from email_order_messages
   where id = (select value::uuid from pg_temp.p51_state where key = 'message1')),
  'first claim: sending, attempt 1, normalized destination, template stamped, link attached');
select pg_temp.p51_assert(
  (select value ~ '^[0-9a-f]{64}$' from pg_temp.p51_state where key = 'token1'),
  'the claim returns the raw portal token exactly once');
select pg_temp.p51_assert(
  (select l.token_hash = encode(sha256(convert_to(
      (select value from pg_temp.p51_state where key = 'token1'), 'UTF8')), 'hex')
   from email_order_messages m
   join supplier_order_links l on l.id = m.link_id
   where m.id = (select value::uuid from pg_temp.p51_state where key = 'message1')),
  'only the hash of the riding token is stored');

-- A second claim while the lease is alive answers in_flight and sends nothing.
select pg_temp.p51_assert(
  (select (claim_email_order_message('6a510000-0000-4000-8000-000000000001', 'again')
     ->> 'state') = 'in_flight'),
  'an in-flight lease refuses a duplicate send');

-- ===== 4. Settle: the provider event stamps the order =====
select pg_temp.p51_expect_error(
  format($$select service_settle_email_order_message(%L, 'accepted', 'prov-1', 200, null, null)$$,
    (select value from pg_temp.p51_state where key = 'message1')),
  'service_role_required');

select pg_temp.p51_service();
select service_settle_email_order_message(
  (select value::uuid from pg_temp.p51_state where key = 'message1'),
  'accepted', 'prov-msg-1', 200, null, null);

select pg_temp.p51_assert(
  (select status = 'accepted' and provider_message_id = 'prov-msg-1'
      and accepted_at is not null and lease_expires_at is null
   from email_order_messages
   where id = (select value::uuid from pg_temp.p51_state where key = 'message1')),
  'acceptance recorded with the provider message id');
select pg_temp.p51_assert(
  (select status = 'sent' and sent_at is not null from purchase_orders
   where id = '6a510000-0000-4000-8000-000000000001'),
  'the order is sent because the provider accepted -- an observed event, not a click');
select pg_temp.p51_assert(
  (select count(*) = 1 from audit_logs
   where action = 'purchase_order_status_changed'
     and entity_id = '6a510000-0000-4000-8000-000000000001'
     and user_id is null
     and new_values ->> 'status' = 'sent'),
  'the stamp is audited as a machine actor');

-- Late/duplicate settlement is answered, never applied twice.
select pg_temp.p51_assert(
  (select (service_settle_email_order_message(
     (select value::uuid from pg_temp.p51_state where key = 'message1'),
     'failed', null, 500, 'x', 'y') ->> 'state') = 'not_sending'),
  'settling a settled message is a no-op answer');

-- A claim after acceptance answers already_sent (idempotent, nothing re-mailed).
select pg_temp.p51_actor('2a510000-0000-4000-8000-000000000001');
select pg_temp.p51_assert(
  (select (claim_email_order_message('6a510000-0000-4000-8000-000000000001', 'again')
     ->> 'state') = 'already_sent'),
  'an accepted thread answers already_sent');

-- ===== 5. Failure path, retry accounting and the manual reset =====
-- Second order gets email preferences so it can fail honestly.
select set_supplier_communication_preferences(
  '4a510000-0000-4000-8000-000000000002', 'email', 'en', 'backup@example.test', null, false,
  'P51 add destination');
create table pg_temp.p51_state2 (key text primary key, value text);
do $$
declare
  v jsonb;
begin
  v := claim_email_order_message('6a510000-0000-4000-8000-000000000002', 'P51 second order');
  insert into pg_temp.p51_state2 values ('message2', v ->> 'message_id');
end
$$;
select pg_temp.p51_assert(
  (select to_email = 'backup@example.test' and locale = 'en'
   from email_order_messages
   where id = (select value::uuid from pg_temp.p51_state2 where key = 'message2')),
  'the destination override wins and the locale follows the preference');

select pg_temp.p51_service();
select service_settle_email_order_message(
  (select value::uuid from pg_temp.p51_state2 where key = 'message2'),
  'failed', null, 500, 'provider_500', 'boom');
select pg_temp.p51_assert(
  (select status = 'failed' and failed_at is not null and error_code = 'provider_500'
   from email_order_messages
   where id = (select value::uuid from pg_temp.p51_state2 where key = 'message2')),
  'failure recorded with its error');
select pg_temp.p51_assert(
  (select status = 'ready' from purchase_orders
   where id = '6a510000-0000-4000-8000-000000000002'),
  'a failed send never moves the order');

-- Retry: claim again raises the attempt; cap at 5 refuses by name.
select pg_temp.p51_actor('2a510000-0000-4000-8000-000000000001');
do $$
declare
  v jsonb;
begin
  v := claim_email_order_message('6a510000-0000-4000-8000-000000000002', 'retry');
  if v ->> 'state' <> 'claimed' or (v ->> 'attempt')::int <> 2 then
    raise exception 'P51: expected attempt 2 claim, got %', v;
  end if;
end
$$;
update email_order_messages
set status = 'failed', attempt_count = 5, lease_expires_at = null
where id = (select value::uuid from pg_temp.p51_state2 where key = 'message2');
select pg_temp.p51_expect_error(
  $$select claim_email_order_message('6a510000-0000-4000-8000-000000000002', 'over cap')$$,
  'email_message_retry_limit');

-- The reset is owner-only, reasoned, and only for dead threads.
select pg_temp.p51_actor('2a510000-0000-4000-8000-000000000002');
select pg_temp.p51_expect_error(
  format($$select reset_email_order_message(%L, 'x')$$,
    (select value from pg_temp.p51_state2 where key = 'message2')),
  'not_authorized');
select pg_temp.p51_actor('2a510000-0000-4000-8000-000000000001');
select reset_email_order_message(
  (select value::uuid from pg_temp.p51_state2 where key = 'message2'), 'P51 manual replay');
select pg_temp.p51_assert(
  (select status = 'queued' and attempt_count = 0 and error_code is null
   from email_order_messages
   where id = (select value::uuid from pg_temp.p51_state2 where key = 'message2')),
  'the reset re-opens the thread with a clean attempt budget');
select pg_temp.p51_assert(
  (select count(*) = 1 from audit_logs
   where action = 'email_order_message_reset'
     and entity_id = (select value::uuid from pg_temp.p51_state2 where key = 'message2')
     and reason = 'P51 manual replay'),
  'the reset is audited');

-- ===== 6. Tenancy and the browser surface =====
select pg_temp.p51_actor('2a510000-0000-4000-8000-000000000003');
set local role authenticated;
select pg_temp.p51_assert(
  (select count(id) = 0 from email_order_messages),
  'a foreign tenant reads no email threads');
select pg_temp.p51_assert(
  (select count(supplier_id) = 0 from supplier_communication_preferences),
  'a foreign tenant reads no preferences');
reset role;
select pg_temp.p51_assert(
  not has_table_privilege('authenticated', 'public.email_order_messages', 'INSERT')
  and not has_table_privilege('authenticated', 'public.supplier_communication_preferences', 'INSERT')
  and not has_table_privilege('anon', 'public.email_order_messages', 'SELECT'),
  'no browser DML, and anon reads nothing');

rollback;
