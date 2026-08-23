-- P72 -- the signed Resend delivery webhook ledger (0190): event de-duplication in the database,
-- a monotonic channel that late events cannot regress, `delivery_failed` without touching the
-- order, a bounded reason the database itself enforces, and a retry that kills the old link.
--
-- The business sentences under test are #187 (accepted is not delivered), #238 (an accepted-then-
-- bounced order STAYS `sent`; the channel becomes delivery_failed; delivered must not be shown)
-- and #188 (a retry mints a new portal link and the previous one dies immediately).
\set ON_ERROR_STOP on

begin;

create function pg_temp.p72_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P72 delivery event assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p72_expect_error(p_sql text, p_fragment text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
    raise exception 'P72 expected error containing %, statement succeeded: %', p_fragment, p_sql;
  exception when others then
    if sqlerrm like 'P72 expected error%' or position(p_fragment in sqlerrm) = 0 then
      raise;
    end if;
  end;
end
$$;

create function pg_temp.p72_actor(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end
$$;

create function pg_temp.p72_service()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end
$$;

-- ===== Fixtures: two tenants, three order threads =====
insert into public.organizations (id, name, status) values
  ('1a720000-0000-4000-8000-000000000001', 'P72 A', 'active'),
  ('1a720000-0000-4000-8000-000000000002', 'P72 B', 'active');
insert into auth.users (id, email) values
  ('2a720000-0000-4000-8000-000000000001', 'owner-a-p72@example.test'),
  ('2a720000-0000-4000-8000-000000000002', 'owner-b-p72@example.test');
insert into public.profiles (id, org_id, full_name, role) values
  ('2a720000-0000-4000-8000-000000000001', '1a720000-0000-4000-8000-000000000001', 'P72 owner A', 'owner'),
  ('2a720000-0000-4000-8000-000000000002', '1a720000-0000-4000-8000-000000000002', 'P72 owner B', 'owner');
insert into public.suppliers (id, org_id, name, status, email) values
  ('4a720000-0000-4000-8000-000000000001', '1a720000-0000-4000-8000-000000000001',
   'P72 supplier A', 'active', 'supplier-a@example.test'),
  ('4a720000-0000-4000-8000-000000000002', '1a720000-0000-4000-8000-000000000002',
   'P72 supplier B', 'active', 'supplier-b@example.test');
insert into public.products (id, org_id, name, unit) values
  ('3a720000-0000-4000-8000-000000000001', '1a720000-0000-4000-8000-000000000001', 'P72 salt', 'kg'),
  ('3a720000-0000-4000-8000-000000000002', '1a720000-0000-4000-8000-000000000002', 'P72 sugar', 'kg');
insert into public.purchase_orders (id, org_id, supplier_id, status, expected_date, created_by) values
  ('6a720000-0000-4000-8000-000000000001', '1a720000-0000-4000-8000-000000000001',
   '4a720000-0000-4000-8000-000000000001', 'ready', current_date + 3,
   '2a720000-0000-4000-8000-000000000001'),
  ('6a720000-0000-4000-8000-000000000002', '1a720000-0000-4000-8000-000000000001',
   '4a720000-0000-4000-8000-000000000001', 'ready', current_date + 4,
   '2a720000-0000-4000-8000-000000000001'),
  ('6a720000-0000-4000-8000-000000000003', '1a720000-0000-4000-8000-000000000002',
   '4a720000-0000-4000-8000-000000000002', 'ready', null,
   '2a720000-0000-4000-8000-000000000002');
insert into public.purchase_order_items (id, org_id, order_id, product_id, qty, unit_price) values
  ('7a720000-0000-4000-8000-000000000001', '1a720000-0000-4000-8000-000000000001',
   '6a720000-0000-4000-8000-000000000001', '3a720000-0000-4000-8000-000000000001', 4, 12),
  ('7a720000-0000-4000-8000-000000000002', '1a720000-0000-4000-8000-000000000001',
   '6a720000-0000-4000-8000-000000000002', '3a720000-0000-4000-8000-000000000001', 6, 12),
  ('7a720000-0000-4000-8000-000000000003', '1a720000-0000-4000-8000-000000000002',
   '6a720000-0000-4000-8000-000000000003', '3a720000-0000-4000-8000-000000000002', 2, 8);

create table pg_temp.p72_state (key text primary key, value text);

-- Bring all three threads to `accepted`: the 0168 path, which is what #187 calls "נשלחה".
select pg_temp.p72_actor('2a720000-0000-4000-8000-000000000001');
select set_supplier_communication_preferences(
  '4a720000-0000-4000-8000-000000000001', 'email', 'he', null, null, false, 'P72 enable email A');
do $$
declare
  v jsonb;
begin
  v := claim_email_order_message('6a720000-0000-4000-8000-000000000001', 'P72 send one');
  insert into pg_temp.p72_state values ('message1', v ->> 'message_id');
  v := claim_email_order_message('6a720000-0000-4000-8000-000000000002', 'P72 send two');
  insert into pg_temp.p72_state values ('message2', v ->> 'message_id'), ('link2', null);
end
$$;

select pg_temp.p72_actor('2a720000-0000-4000-8000-000000000002');
select set_supplier_communication_preferences(
  '4a720000-0000-4000-8000-000000000002', 'email', 'he', null, null, false, 'P72 enable email B');
do $$
declare
  v jsonb;
begin
  v := claim_email_order_message('6a720000-0000-4000-8000-000000000003', 'P72 send B');
  insert into pg_temp.p72_state values ('message3', v ->> 'message_id');
end
$$;

select pg_temp.p72_service();
select service_settle_email_order_message(
  (select value::uuid from pg_temp.p72_state where key = 'message1'),
  'accepted', 'p72-prov-a1', 200, null, null);
select service_settle_email_order_message(
  (select value::uuid from pg_temp.p72_state where key = 'message2'),
  'accepted', 'p72-prov-a2', 200, null, null);
select service_settle_email_order_message(
  (select value::uuid from pg_temp.p72_state where key = 'message3'),
  'accepted', 'p72-prov-b1', 200, null, null);

select pg_temp.p72_assert(
  (select count(*) = 3 from purchase_orders
   where id in ('6a720000-0000-4000-8000-000000000001', '6a720000-0000-4000-8000-000000000002',
                '6a720000-0000-4000-8000-000000000003')
     and status = 'sent'),
  'all three orders are sent because the provider accepted them (#187)');
select pg_temp.p72_assert(
  (select count(*) = 3 from email_order_messages
   where status = 'accepted' and delivery_state = 'accepted'
     and provider_message_id in ('p72-prov-a1', 'p72-prov-a2', 'p72-prov-b1')),
  'accepted is its own channel state -- it is not delivered');

-- ===== 1. The recording function is service-role only =====
select pg_temp.p72_actor('2a720000-0000-4000-8000-000000000001');
set local role service_role;
select pg_temp.p72_expect_error(
  $$select service_record_email_delivery_event('p72-evt-x', 'p72-prov-a1', 'delivered',
    'delivered', null, now())$$,
  'service_role_required');
reset role;
select pg_temp.p72_assert(
  not has_function_privilege('authenticated',
    'public.service_record_email_delivery_event(text,text,text,text,text,timestamptz)', 'execute')
  and not has_function_privilege('anon',
    'public.service_record_email_delivery_event(text,text,text,text,text,timestamptz)', 'execute')
  and has_function_privilege('service_role',
    'public.service_record_email_delivery_event(text,text,text,text,text,timestamptz)', 'execute'),
  'the webhook recording RPC is reachable only by the trusted server');

select pg_temp.p72_service();
select pg_temp.p72_expect_error(
  $$select service_record_email_delivery_event('p72-evt-x', 'p72-prov-a1', 'email.opened',
    'delivered', null, now())$$,
  'email_delivery_event_invalid');
select pg_temp.p72_expect_error(
  $$select service_record_email_delivery_event('  ', 'p72-prov-a1', 'delivered',
    'delivered', null, now())$$,
  'email_delivery_event_invalid');

-- ===== 2. An unknown provider message id never grows a phantom row =====
select pg_temp.p72_assert(
  (select (service_record_email_delivery_event('p72-evt-orphan', 'p72-prov-nobody', 'delivered',
     'delivered', null, now()) ->> 'state') = 'unmatched'),
  'an event for a message this deployment never sent answers unmatched');
select pg_temp.p72_assert(
  (select count(*) = 0 from email_delivery_events),
  'an unmatched event created no ledger row');

-- ===== 3. delivered applies, and the same event id applies exactly once =====
select pg_temp.p72_assert(
  (select (service_record_email_delivery_event('p72-evt-1', 'p72-prov-a1', 'delivered',
     'delivered', null, now()) ->> 'state') = 'applied'),
  'a first delivered event applies');
select pg_temp.p72_assert(
  (select status = 'delivered' and delivery_state = 'delivered' and delivered_at is not null
      and error_code is null
   from email_order_messages
   where id = (select value::uuid from pg_temp.p72_state where key = 'message1')),
  'the channel reached delivered');
select pg_temp.p72_assert(
  (select applied and event_type = 'delivered' and reason_code = 'delivered'
      and reason_message is null and provider = 'resend'
      and org_id = '1a720000-0000-4000-8000-000000000001'
   from email_delivery_events where provider_event_id = 'p72-evt-1'),
  'the event is ledgered as applied, bounded, and attributed to its tenant');

-- The replay. Same provider event id, same everything: the UNIQUE index refuses it, so the
-- transition cannot happen twice no matter how many times the provider retries.
select pg_temp.p72_assert(
  (select (service_record_email_delivery_event('p72-evt-1', 'p72-prov-a1', 'delivered',
     'delivered', null, now()) ->> 'state') = 'duplicate'),
  'a replayed event id answers duplicate');
select pg_temp.p72_assert(
  (select count(*) = 1 from email_delivery_events where provider_event_id = 'p72-evt-1'),
  'the replay stored no second row');
select pg_temp.p72_expect_error(
  $$insert into email_delivery_events (org_id, message_id, provider, provider_event_id,
      provider_message_id, event_type, reason_code)
    select org_id, message_id, provider, provider_event_id, provider_message_id, event_type,
           reason_code
    from email_delivery_events where provider_event_id = 'p72-evt-1'$$,
  'email_delivery_events_provider_event_idx');

-- ===== 4. #238: a bounce settles the CHANNEL and leaves the order alone =====
select pg_temp.p72_assert(
  (select (service_record_email_delivery_event('p72-evt-2', 'p72-prov-a2', 'bounced',
     'bounce_permanent', 'The recipient mailbox does not exist.', now())
     ->> 'delivery_state') = 'delivery_failed'),
  'an accepted-then-bounced thread reports the delivery_failed channel state');
select pg_temp.p72_assert(
  (select status = 'bounced' and delivery_state = 'delivery_failed'
      and error_code = 'bounce_permanent'
      and error_message = 'The recipient mailbox does not exist.'
      and failed_at is not null
   from email_order_messages
   where id = (select value::uuid from pg_temp.p72_state where key = 'message2')),
  'the ledger keeps the provider word `bounced` and the bounded reason');
select pg_temp.p72_assert(
  (select status = 'sent' and sent_at is not null from purchase_orders
   where id = '6a720000-0000-4000-8000-000000000002'),
  'THE #238 SENTENCE: the order stays sent after a late bounce');
select pg_temp.p72_assert(
  not exists (
    select 1 from audit_logs
    where entity_id = '6a720000-0000-4000-8000-000000000002'
      and action = 'purchase_order_status_changed'
      and new_values ->> 'status' <> 'sent'),
  'no bounce ever moved the order lifecycle anywhere else');
select pg_temp.p72_assert(
  (select count(*) = 1 from audit_logs
   where action = 'email_order_message_delivery_event'
     and entity_id = (select value::uuid from pg_temp.p72_state where key = 'message2')
     and old_values ->> 'status' = 'accepted'
     and new_values ->> 'delivery_state' = 'delivery_failed'
     and new_values ->> 'provider_event_id' = 'p72-evt-2'),
  'the channel transition is audited with the provider event that caused it');

-- ===== 5. The monotonic rule: a late event can never regress a further-along state =====
select pg_temp.p72_assert(
  private.email_delivery_rank('bounced') > private.email_delivery_rank('delivered')
  and private.email_delivery_rank('delivered') > private.email_delivery_rank('accepted')
  and private.email_delivery_rank('accepted') > private.email_delivery_rank('sending')
  and private.email_delivery_rank('anything-else') = -1,
  'the ladder is totally ordered and bounced outranks delivered (#238)');

-- delivered -> bounced still advances: a message that came back did not arrive.
select pg_temp.p72_assert(
  (select (service_record_email_delivery_event('p72-evt-3', 'p72-prov-a1', 'bounced',
     'bounce_transient', 'Mailbox full.', now()) ->> 'state') = 'applied'),
  'a bounce after a delivered advances the channel');
-- ...and a delivered arriving AFTER that bounce is stored as evidence and changes nothing.
select pg_temp.p72_assert(
  (select (service_record_email_delivery_event('p72-evt-4', 'p72-prov-a1', 'delivered',
     'delivered', null, now()) ->> 'state') = 'stale'),
  'a delivered arriving after a bounce is refused as stale');
select pg_temp.p72_assert(
  (select status = 'bounced' and delivery_state = 'delivery_failed'
   from email_order_messages
   where id = (select value::uuid from pg_temp.p72_state where key = 'message1')),
  'the out-of-order delivered did not regress the channel, and delivered is not displayed');
select pg_temp.p72_assert(
  (select not applied and event_type = 'delivered'
   from email_delivery_events where provider_event_id = 'p72-evt-4'),
  'the refused event is still stored, marked applied = false');

-- delivery_delayed and complained are evidence, not outcomes.
select pg_temp.p72_assert(
  (select (service_record_email_delivery_event('p72-evt-5', 'p72-prov-b1', 'delivery_delayed',
     'delivery_delayed', null, now()) ->> 'state') = 'stale'),
  'a delay is recorded but advances nothing');
select pg_temp.p72_assert(
  (select (service_record_email_delivery_event('p72-evt-6', 'p72-prov-b1', 'complained',
     'complaint', null, now()) ->> 'state') = 'stale'),
  'a spam complaint is recorded but is not a delivery failure');
select pg_temp.p72_assert(
  (select status = 'accepted' and delivery_state = 'accepted'
   from email_order_messages
   where id = (select value::uuid from pg_temp.p72_state where key = 'message3')),
  'neither a delay nor a complaint moved the tenant B channel');

-- ===== 6. The reason is bounded BY THE DATABASE, and derived from the event type =====
select pg_temp.p72_assert(
  (select (service_record_email_delivery_event('p72-evt-7', 'p72-prov-b1', 'bounced',
     'bounce_permanent', repeat('x', 900), now()) ->> 'state') = 'applied'),
  'a bounce with an oversized provider sentence is accepted');
select pg_temp.p72_assert(
  (select char_length(reason_message) = 500
   from email_delivery_events where provider_event_id = 'p72-evt-7'),
  'the provider sentence is capped at 500 characters on the way in');
select pg_temp.p72_expect_error(
  $$insert into email_delivery_events (org_id, message_id, provider_event_id,
      provider_message_id, event_type, reason_code, reason_message)
    values ('1a720000-0000-4000-8000-000000000001',
      (select id from email_order_messages where provider_message_id = 'p72-prov-a1'),
      'p72-evt-toolong', 'p72-prov-a1', 'bounced', 'bounce_permanent', repeat('y', 501))$$,
  'email_delivery_events_reason_message_check');
select pg_temp.p72_expect_error(
  $$insert into email_delivery_events (org_id, message_id, provider_event_id,
      provider_message_id, event_type, reason_code)
    values ('1a720000-0000-4000-8000-000000000001',
      (select id from email_order_messages where provider_message_id = 'p72-prov-a1'),
      'p72-evt-badcode', 'p72-prov-a1', 'bounced', 'whatever_the_provider_said')$$,
  'email_delivery_events_reason_code_check');

-- The caller's word for the reason is not trusted: the code follows the EVENT TYPE.
select pg_temp.p72_assert(
  (select (service_record_email_delivery_event('p72-evt-8', 'p72-prov-a2', 'bounced',
     'something_resend_added_later', null, now()) is not null)),
  'an unrecognized bounce classification is ingested rather than raising');
select pg_temp.p72_assert(
  (select reason_code = 'bounce_unclassified'
   from email_delivery_events where provider_event_id = 'p72-evt-8'),
  'an unrecognized bounce classification degrades to bounce_unclassified');
select pg_temp.p72_assert(
  (select (service_record_email_delivery_event('p72-evt-9', 'p72-prov-b1', 'delivery_delayed',
     'bounce_permanent', 'trying to look like a bounce', now()) is not null)),
  'a mislabelled delay is ingested');
select pg_temp.p72_assert(
  (select reason_code = 'delivery_delayed' and reason_message is null
   from email_delivery_events where provider_event_id = 'p72-evt-9'),
  'a caller cannot label a delay as a bounce, and only a bounce keeps a sentence');

-- ===== 7. No raw provider payload exists anywhere, browser-readable or not =====
select pg_temp.p72_assert(
  not exists (
    select 1 from information_schema.columns column_info
    where column_info.table_schema = 'public'
      and column_info.table_name = 'email_delivery_events'
      and (column_info.data_type in ('json', 'jsonb')
           or column_info.column_name ~* '(payload|raw|headers|body)')),
  'the delivery ledger has no provider-payload column');
select pg_temp.p72_assert(
  not exists (
    select 1 from information_schema.tables table_info
    where table_info.table_schema = 'private'
      and table_info.table_name ~* 'email_delivery'),
  'there is no private mirror holding the raw provider payload either');
select pg_temp.p72_assert(
  not exists (
    select 1 from information_schema.role_table_grants grant_info
    where grant_info.table_schema = 'public'
      and grant_info.table_name = 'email_delivery_events'
      and grant_info.grantee in ('anon', 'authenticated', 'PUBLIC')
      and grant_info.privilege_type <> 'SELECT'),
  'no browser role holds anything but SELECT on the delivery ledger');
select pg_temp.p72_assert(
  not has_table_privilege('anon', 'public.email_delivery_events', 'SELECT')
  and has_table_privilege('authenticated', 'public.email_delivery_events', 'SELECT')
  and not has_table_privilege('authenticated', 'public.email_delivery_events', 'INSERT')
  and not has_table_privilege('authenticated', 'public.email_delivery_events', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.email_delivery_events', 'DELETE'),
  'anon reads nothing; a signed-in browser reads and never writes');

-- ===== 8. Append-only, and the channel state cannot be hand-written =====
select pg_temp.p72_expect_error(
  $$update email_delivery_events set applied = false where provider_event_id = 'p72-evt-1'$$,
  'email_delivery_event_immutable');
select pg_temp.p72_expect_error(
  $$delete from email_delivery_events where provider_event_id = 'p72-evt-1'$$,
  'email_delivery_event_immutable');
select pg_temp.p72_expect_error(
  $$update email_order_messages set delivery_state = 'delivered'
    where provider_message_id = 'p72-prov-a1'$$,
  'delivery_state');

-- ===== 9. Tenancy: the ledger is per-organization =====
select pg_temp.p72_actor('2a720000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.p72_assert(
  (select count(*) > 0 from email_delivery_events)
  and (select count(*) = 0 from email_delivery_events
       where org_id <> '1a720000-0000-4000-8000-000000000002'),
  'tenant B reads its own delivery events and only its own');
reset role;
select pg_temp.p72_actor('2a720000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.p72_assert(
  not exists (select 1 from email_delivery_events
              where provider_message_id = 'p72-prov-b1'),
  'tenant A cannot read tenant B delivery evidence');
reset role;

-- ===== 10. #188: the retry after a bounce mints a new link and kills the previous one =====
select pg_temp.p72_actor('2a720000-0000-4000-8000-000000000001');
update pg_temp.p72_state set value = (
  select link_id::text from email_order_messages
  where id = (select value::uuid from pg_temp.p72_state s where s.key = 'message2'))
where key = 'link2';
select pg_temp.p72_assert(
  (select revoked_at is null from supplier_order_links
   where id = (select value::uuid from pg_temp.p72_state where key = 'link2')),
  'the bounced attempt still holds a live portal link before the retry');

do $$
declare
  v jsonb;
begin
  v := claim_email_order_message('6a720000-0000-4000-8000-000000000002', 'P72 resend after bounce');
  if v ->> 'state' <> 'claimed' then
    raise exception 'P72: a bounced thread must be re-claimable, got %', v ->> 'state';
  end if;
  insert into pg_temp.p72_state values ('link2b', v ->> 'link_id');
end
$$;
select pg_temp.p72_assert(
  (select revoked_at is not null and revoked_reason = 'regenerated'
   from supplier_order_links
   where id = (select value::uuid from pg_temp.p72_state where key = 'link2')),
  'THE #188 SENTENCE: the retry revoked the previous portal link immediately');
select pg_temp.p72_assert(
  (select count(*) = 1 from supplier_order_links
   where purchase_order_id = '6a720000-0000-4000-8000-000000000002' and revoked_at is null),
  'exactly one live link survives the retry');
select pg_temp.p72_assert(
  (select status = 'sending' and attempt_count = 2 and provider_message_id is null
      and delivery_state = 'pending'
   from email_order_messages
   where id = (select value::uuid from pg_temp.p72_state where key = 'message2')),
  'the retry re-opens the same thread and drops the superseded provider identity');
select pg_temp.p72_assert(
  (select status = 'sent' from purchase_orders
   where id = '6a720000-0000-4000-8000-000000000002'),
  'the retry did not disturb the order lifecycle either');

-- A late event for the superseded attempt can no longer match anything.
select pg_temp.p72_service();
select pg_temp.p72_assert(
  (select (service_record_email_delivery_event('p72-evt-10', 'p72-prov-a2', 'delivered',
     'delivered', null, now()) ->> 'state') = 'unmatched'),
  'a late event for the superseded attempt is unmatched, not applied to the new one');

-- ===== 11. The registries know about the new table =====
select pg_temp.p72_assert(
  (select count(*) = 1 from private.scope_registry
   where table_name = 'email_delivery_events' and scope_class = 'derived' and not enforced),
  'the delivery ledger is classified in the scope registry');
select pg_temp.p72_assert(
  (select disposition = 'include' and 'delivery_state' = any(exported_columns)
   from private.tenant_export_registry where table_name = 'email_order_messages'),
  'the export fingerprint moved with the new channel-state column');
select pg_temp.p72_assert(
  (select count(*) = 0 from private.scope_enforcement_violations()),
  'A1/A3/A5/A6 hold after 0190');
-- Asserted by NAME, never as a registry census: a catalogue count here would silently include
-- whatever else happens to be applied to the local stack and would be wrong relative to main.
-- The arithmetic pin on the registry's size is check:exemptions' job, not this suite's.
select pg_temp.p72_assert(
  not exists (
    select 1 from private.scope_definer_exemptions exemption
    where exemption.function_signature like 'service_record_email_delivery_event%'),
  '0190 took no definer exemption: the webhook path touches no scope-enforced table');
select pg_temp.p72_assert(
  not exists (
    select 1 from private.scope_registry registry
    where registry.enforced
      and pg_get_functiondef(
            'public.service_record_email_delivery_event(text,text,text,text,text,timestamptz)'::regprocedure
          ) ~ ('\m' || registry.table_name || '\M')),
  'the webhook recorder names no scope-enforced table, which is why it needs no exemption');

rollback;

\echo 'p72_email_delivery_events_passed'
