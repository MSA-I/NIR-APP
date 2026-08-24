-- P73 -- the WhatsApp ledger stops assuming one vendor (0191 over 0028/0029).
--
-- The first block is the RED evidence: every assertion in it fails against the pre-0191 schema,
-- because 0028 encoded Meta Cloud API in the column names and in the NOT NULL constraints, and
-- decision #239 chose a different provider. The rest proves the forward shape: a per-provider
-- identity CHECK, provider-scoped message uniqueness, database-enforced webhook de-duplication,
-- monotonic status that a late callback cannot regress, inbound refused by name (#241), and a
-- per-organization owner-only connection that never exposes its credential (#240).
\set ON_ERROR_STOP on

begin;

create function pg_temp.p73_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P73 provider-neutral WhatsApp assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p73_expect_error(p_sql text, p_fragment text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
    raise exception 'P73 expected error containing %, statement succeeded: %', p_fragment, p_sql;
  exception when others then
    if sqlerrm like 'P73 expected error%' or position(p_fragment in sqlerrm) = 0 then
      raise;
    end if;
  end;
end
$$;

-- A browser actor. p_fresh decides whether the token carries the password amr entry the
-- step-up assertion (0061) demands, so the suite can prove step-up is actually required.
create function pg_temp.p73_actor(p_user uuid, p_fresh boolean)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    case when p_fresh then
      jsonb_build_object('sub', p_user, 'role', 'authenticated',
        'amr', jsonb_build_array(jsonb_build_object(
          'method', 'password',
          'timestamp', floor(extract(epoch from statement_timestamp()))::bigint)))
    else
      jsonb_build_object('sub', p_user, 'role', 'authenticated')
    end::text, true);
end
$$;

create function pg_temp.p73_service()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end
$$;

create function pg_temp.p73_column_is_nullable(p_table text, p_column text)
returns boolean language sql stable as $$
  select column_info.is_nullable = 'YES'
  from information_schema.columns column_info
  where column_info.table_schema = 'public'
    and column_info.table_name = p_table
    and column_info.column_name = p_column
$$;

create function pg_temp.p73_has_column(p_table text, p_column text)
returns boolean language sql stable as $$
  select exists (
    select 1 from information_schema.columns column_info
    where column_info.table_schema = 'public'
      and column_info.table_name = p_table
      and column_info.column_name = p_column)
$$;

-- ==========================================================================================
-- 1. RED -- the Meta assumption, stated as the defect it is
-- Each of these fails on the pre-0191 schema. That failure is the evidence that 0028's
-- vendor choice was structural rather than cosmetic.
-- ==========================================================================================
select pg_temp.p73_assert(
  pg_temp.p73_has_column('whatsapp_connections', 'provider'),
  'whatsapp_connections carries no provider discriminator, so every connection is implicitly '
  'one vendor and decision #239 cannot be represented');
select pg_temp.p73_assert(
  pg_temp.p73_has_column('whatsapp_connections', 'provider_sender_id')
  and pg_temp.p73_has_column('whatsapp_connections', 'provider_account_id'),
  'the only connection identity is Meta-named (phone_number_id / waba_id): there is no '
  'provider-neutral routing key a non-Meta callback could resolve a tenant by');
select pg_temp.p73_assert(
  pg_temp.p73_column_is_nullable('whatsapp_connections', 'waba_id'),
  'waba_id is NOT NULL, so a connection that has no WhatsApp Business Account id -- which is '
  'exactly what a non-Meta connection is -- is unsatisfiable and cannot be inserted at all');
select pg_temp.p73_assert(
  pg_temp.p73_column_is_nullable('whatsapp_connections', 'phone_number_id'),
  'phone_number_id is NOT NULL, so the Meta phone-number identifier is mandatory for every '
  'provider');
select pg_temp.p73_assert(
  pg_temp.p73_has_column('whatsapp_order_messages', 'provider_message_id'),
  'meta_message_id is the only provider-id surface on a message, and it is globally unique, so '
  'two providers would collide in one column');
select pg_temp.p73_assert(
  pg_temp.p73_has_column('whatsapp_webhook_events', 'provider_sender_id'),
  'the webhook dedupe ledger keys on phone_number_id, which a non-Meta callback never sends');

-- ==========================================================================================
-- 1b. The client boundary: every RPC the browser and the Edge workers call EXISTS, by name and
-- by full argument-type list.
--
-- A mocked client spec proves a component renders and refuses correctly against a SHAPE. It
-- proves nothing about whether the function exists, is named that, or takes those arguments --
-- so a UI and a migration can both be green while sharing no surface at all. Enumerated one by
-- one on purpose: a census or a name pattern would pass against whatever else happens to be
-- applied to the machine running this suite.
-- ==========================================================================================
select pg_temp.p73_assert(
  to_regprocedure('public.get_whatsapp_connection_status()') is not null,
  'src/lib/whatsappConnection.ts calls get_whatsapp_connection_status() and it does not exist');
select pg_temp.p73_assert(
  to_regprocedure(
    'public.configure_whatsapp_provider_connection(text,text,text,text,text,text,text,text,text)'
  ) is not null,
  'src/lib/whatsappConnection.ts calls configure_whatsapp_provider_connection with nine text '
  'arguments and no such function exists');
select pg_temp.p73_assert(
  to_regprocedure('public.set_whatsapp_provider_connection_enabled(boolean,text)') is not null,
  'src/lib/whatsappConnection.ts calls set_whatsapp_provider_connection_enabled(boolean,text) '
  'and it does not exist');
select pg_temp.p73_assert(
  to_regprocedure('public.revoke_whatsapp_provider_connection(text)') is not null,
  'src/lib/whatsappConnection.ts calls revoke_whatsapp_provider_connection(text) and it does '
  'not exist');
select pg_temp.p73_assert(
  to_regprocedure('public.claim_whatsapp_order_message(uuid,text)') is not null,
  'supabase/functions/whatsapp-sender calls claim_whatsapp_order_message(uuid,text)');
select pg_temp.p73_assert(
  to_regprocedure('public.service_get_whatsapp_provider_connection(text,text)') is not null,
  'both Edge functions call service_get_whatsapp_provider_connection(text,text)');
select pg_temp.p73_assert(
  to_regprocedure('public.complete_whatsapp_order_message(uuid,text)') is not null,
  'supabase/functions/whatsapp-sender calls complete_whatsapp_order_message(uuid,text)');
select pg_temp.p73_assert(
  to_regprocedure('public.fail_whatsapp_order_message(uuid,text,text)') is not null,
  'supabase/functions/whatsapp-sender calls fail_whatsapp_order_message(uuid,text,text)');
select pg_temp.p73_assert(
  to_regprocedure('public.mark_whatsapp_message_ambiguous(uuid,text,text,text)') is not null,
  'supabase/functions/whatsapp-sender calls mark_whatsapp_message_ambiguous(uuid,text,text,text)');
select pg_temp.p73_assert(
  to_regprocedure(
    'public.service_process_whatsapp_provider_event(text,text,text,text,text,whatsapp_message_status,text,text,timestamptz)'
  ) is not null,
  'supabase/functions/whatsapp-webhook calls service_process_whatsapp_provider_event and no such '
  'function exists with that argument list');

-- ==========================================================================================
-- 2. Fixtures
-- ==========================================================================================
insert into public.organizations (id, name, status) values
  ('17300000-0000-4000-8000-000000000001', 'P73 tenant A', 'active'),
  ('17300000-0000-4000-8000-000000000002', 'P73 tenant B', 'active');
insert into auth.users (id, email) values
  ('27300000-0000-4000-8000-000000000001', 'p73-owner-a@example.test'),
  ('27300000-0000-4000-8000-000000000002', 'p73-office-a@example.test'),
  ('27300000-0000-4000-8000-000000000003', 'p73-owner-b@example.test');
insert into public.profiles (id, org_id, full_name, role) values
  ('27300000-0000-4000-8000-000000000001', '17300000-0000-4000-8000-000000000001', 'P73 owner A', 'owner'),
  ('27300000-0000-4000-8000-000000000002', '17300000-0000-4000-8000-000000000001', 'P73 office A', 'office'),
  ('27300000-0000-4000-8000-000000000003', '17300000-0000-4000-8000-000000000002', 'P73 owner B', 'owner');
insert into public.suppliers (id, org_id, name, status, whatsapp) values
  ('37300000-0000-4000-8000-000000000001', '17300000-0000-4000-8000-000000000001',
   'P73 supplier A', 'active', '0501234567'),
  ('37300000-0000-4000-8000-000000000002', '17300000-0000-4000-8000-000000000002',
   'P73 supplier B', 'active', '0507654321');
insert into public.products (id, org_id, name, unit) values
  ('47300000-0000-4000-8000-000000000001', '17300000-0000-4000-8000-000000000001', 'P73 flour', 'kg');
insert into public.purchase_orders (id, org_id, supplier_id, status, created_by) values
  ('57300000-0000-4000-8000-000000000001', '17300000-0000-4000-8000-000000000001',
   '37300000-0000-4000-8000-000000000001', 'ready', '27300000-0000-4000-8000-000000000001'),
  ('57300000-0000-4000-8000-000000000002', '17300000-0000-4000-8000-000000000002',
   '37300000-0000-4000-8000-000000000002', 'ready', '27300000-0000-4000-8000-000000000003');
insert into public.purchase_order_items (id, org_id, order_id, product_id, qty, unit_price) values
  ('67300000-0000-4000-8000-000000000001', '17300000-0000-4000-8000-000000000001',
   '57300000-0000-4000-8000-000000000001', '47300000-0000-4000-8000-000000000001', 4, 12.5);

-- ==========================================================================================
-- 3. Onboarding is per organization, owner-only, stepped up and reasoned (#240)
-- ==========================================================================================
select pg_temp.p73_actor('27300000-0000-4000-8000-000000000002', true);
select pg_temp.p73_expect_error(
  $$select configure_whatsapp_provider_connection('twilio', 'ACp73', 'whatsapp:+972500000001',
    '+972500000001', 'p73-credential-value', 'p73_order', 'p73_reminder', 'he', 'office tries')$$,
  'whatsapp_not_authorized');

-- The owner alone is not enough: a stale session cannot connect an outbound channel.
select pg_temp.p73_actor('27300000-0000-4000-8000-000000000001', false);
select pg_temp.p73_expect_error(
  $$select configure_whatsapp_provider_connection('twilio', 'ACp73', 'whatsapp:+972500000001',
    '+972500000001', 'p73-credential-value', 'p73_order', 'p73_reminder', 'he', 'stale session')$$,
  'fresh_authentication_required');

select pg_temp.p73_actor('27300000-0000-4000-8000-000000000001', true);
select pg_temp.p73_expect_error(
  $$select configure_whatsapp_provider_connection('twilio', 'ACp73', 'whatsapp:+972500000001',
    '+972500000001', 'p73-credential-value', 'p73_order', 'p73_reminder', 'he', '   ')$$,
  'reason_required');
select pg_temp.p73_expect_error(
  $$select configure_whatsapp_provider_connection('carrier-pigeon', 'ACp73',
    'whatsapp:+972500000001', '+972500000001', 'p73-credential-value',
    'p73_order', 'p73_reminder', 'he', 'unknown provider')$$,
  'whatsapp_connection_invalid');
select pg_temp.p73_expect_error(
  $$select configure_whatsapp_provider_connection('twilio', 'ACp73', 'whatsapp:+972500000001',
    '+972500000001', 'short', 'p73_order', 'p73_reminder', 'he', 'credential too short')$$,
  'whatsapp_credential_invalid');

select configure_whatsapp_provider_connection(
  'twilio', 'ACp73', 'whatsapp:+972500000001', '+972500000001', 'p73-credential-value',
  'p73_order', 'p73_reminder', 'he', 'P73 owner connects the tenant sender') as config_a \gset

-- The reply names the provider and a masked sender, and nothing else about the identity.
select pg_temp.p73_assert(
  (:'config_a'::jsonb ->> 'provider') = 'twilio'
  and (:'config_a'::jsonb ->> 'status') = 'pending'
  and (:'config_a'::jsonb ->> 'masked_sender') = '••••0001'
  and (:'config_a'::jsonb ->> 'credential_configured') = 'true'
  and not (:'config_a'::jsonb ? 'credential')
  and not (:'config_a'::jsonb ? 'token_secret_id')
  and not (:'config_a'::jsonb ? 'provider_sender_id'),
  'the owner reply exposed a credential, a Vault reference or an unmasked sender');

reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.p73_assert(
  (select provider = 'twilio' and phone_number_id is null and waba_id is null
       and provider_sender_id = 'whatsapp:+972500000001' and provider_account_id = 'ACp73'
       and status = 'pending'
   from whatsapp_connections where org_id = '17300000-0000-4000-8000-000000000001'),
  'the stored connection did not take the provider-neutral identity, or kept a Meta identity '
  'it does not have');
select pg_temp.p73_assert(
  (select count(*) = 1 from audit_logs
   where org_id = '17300000-0000-4000-8000-000000000001'
     and action = 'whatsapp_provider_connection_configured'
     and reason = 'P73 owner connects the tenant sender'
     and new_values::text not like '%p73-credential-value%'
     and new_values ->> 'masked_sender' = '••••0001'),
  'connecting a sender was not audited with a reason, or the audit carried the credential');

-- ==========================================================================================
-- 4. The per-provider identity CHECK: each provider's required fields, and only those
-- ==========================================================================================
select pg_temp.p73_expect_error(
  $$update whatsapp_connections set provider_account_id = null
    where org_id = '17300000-0000-4000-8000-000000000001'$$,
  'whatsapp_connections_provider_identity_check');
select pg_temp.p73_expect_error(
  $$update whatsapp_connections set provider = 'meta_cloud'
    where org_id = '17300000-0000-4000-8000-000000000001'$$,
  'whatsapp_connections_provider_identity_check');

-- A Meta connection remains fully representable and mirrors both identities.
select pg_temp.p73_actor('27300000-0000-4000-8000-000000000003', true);
select configure_whatsapp_provider_connection(
  'meta_cloud', 'p73-waba-b', 'p73-phone-b', '+972500000002', 'p73-credential-value-b',
  'p73_order', 'p73_reminder', 'he', 'P73 owner B connects a Meta sender');
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.p73_assert(
  (select phone_number_id = 'p73-phone-b' and waba_id = 'p73-waba-b'
       and provider_sender_id = phone_number_id and provider_account_id = waba_id
   from whatsapp_connections where org_id = '17300000-0000-4000-8000-000000000002'),
  'a Meta connection lost its legacy identity or stopped mirroring the neutral one');

-- Two organizations cannot claim the same sender: a callback must resolve exactly one tenant.
select pg_temp.p73_expect_error(
  $$update whatsapp_connections
    set provider = 'twilio', phone_number_id = null, waba_id = null,
        provider_account_id = 'ACp73', provider_sender_id = 'whatsapp:+972500000001'
    where org_id = '17300000-0000-4000-8000-000000000002'$$,
  'whatsapp_connections_provider_sender_idx');

-- ==========================================================================================
-- 5. Enable and revoke are owner-only, stepped up and reasoned
-- ==========================================================================================
select pg_temp.p73_actor('27300000-0000-4000-8000-000000000002', true);
select pg_temp.p73_expect_error(
  $$select set_whatsapp_provider_connection_enabled(true, 'office tries to enable')$$,
  'whatsapp_not_authorized');
select pg_temp.p73_actor('27300000-0000-4000-8000-000000000001', false);
select pg_temp.p73_expect_error(
  $$select set_whatsapp_provider_connection_enabled(true, 'stale session enables')$$,
  'fresh_authentication_required');
select pg_temp.p73_actor('27300000-0000-4000-8000-000000000001', true);
select pg_temp.p73_expect_error(
  $$select set_whatsapp_provider_connection_enabled(true, '  ')$$,
  'reason_required');
select pg_temp.p73_assert(
  (set_whatsapp_provider_connection_enabled(true, 'P73 owner enables the channel')
    ->> 'status') = 'active',
  'the owner could not enable the connection with a reason and a fresh password');
reset role;
select set_config('request.jwt.claims', '', true);

-- ==========================================================================================
-- 6. Delivery: the message takes the organization's provider, not a hardcoded vendor
-- ==========================================================================================
select pg_temp.p73_actor('27300000-0000-4000-8000-000000000002', true);
select claim_whatsapp_order_message(
  '57300000-0000-4000-8000-000000000001', 'P73 office sends the order') as claim_a \gset
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.p73_assert(
  (select provider = 'twilio' and meta_message_id is null and provider_message_id is null
       and status = 'sending'
   from whatsapp_order_messages
   where id = (:'claim_a'::jsonb ->> 'message_id')::uuid),
  'the claimed message did not inherit the organization provider, or carried a Meta identity');
-- The worker must be able to route without knowing which vendor it is talking to.
select pg_temp.p73_assert(
  (:'claim_a'::jsonb -> 'connection' ->> 'provider') = 'twilio'
  and (:'claim_a'::jsonb -> 'connection' ->> 'provider_sender_id') = 'whatsapp:+972500000001'
  and (:'claim_a'::jsonb -> 'connection' ->> 'provider_account_id') = 'ACp73'
  and (:'claim_a'::jsonb -> 'connection' ->> 'phone_number_id') is null,
  'the claim handed the worker a Meta-only connection block');

select complete_whatsapp_order_message(
  (:'claim_a'::jsonb ->> 'message_id')::uuid, 'SMp73aaaaaaaaaaaaaaaaaaaaaaaaaaaa') as complete_a \gset
select pg_temp.p73_assert(
  (select provider_message_id = 'SMp73aaaaaaaaaaaaaaaaaaaaaaaaaaaa'
       and meta_message_id is null and status = 'accepted'
   from whatsapp_order_messages
   where id = (:'claim_a'::jsonb ->> 'message_id')::uuid)
  and (select status = 'sent' from purchase_orders
       where id = '57300000-0000-4000-8000-000000000001'),
  'acceptance did not settle onto the provider-neutral identifier, or the order was not stamped '
  'by the observed provider event');

-- The same identifier under a DIFFERENT provider is a different message and must not collide;
-- the same identifier under the SAME provider must.
insert into whatsapp_order_messages (
  org_id, order_id, kind, status, recipient_number, confirm_token_hash,
  attempt_count, created_by, meta_message_id
) values (
  '17300000-0000-4000-8000-000000000002', '57300000-0000-4000-8000-000000000002', 'order',
  'accepted', '972507654321', repeat('a', 64), 1,
  '27300000-0000-4000-8000-000000000003', 'SMp73aaaaaaaaaaaaaaaaaaaaaaaaaaaa');
select pg_temp.p73_assert(
  (select provider = 'meta_cloud'
       and provider_message_id = 'SMp73aaaaaaaaaaaaaaaaaaaaaaaaaaaa'
       and meta_message_id = provider_message_id
   from whatsapp_order_messages where org_id = '17300000-0000-4000-8000-000000000002'),
  'two providers could not carry the same provider-side identifier independently');
select pg_temp.p73_expect_error(
  $$update whatsapp_order_messages set provider_message_id = 'SMp73aaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    where org_id = '17300000-0000-4000-8000-000000000002'
      and provider_message_id is not null
      and false
    ;
    insert into whatsapp_order_messages (
      org_id, order_id, kind, status, recipient_number, confirm_token_hash,
      attempt_count, created_by, provider_message_id
    ) values (
      '17300000-0000-4000-8000-000000000001', '57300000-0000-4000-8000-000000000001', 'reminder',
      'accepted', '972501234567', repeat('b', 64), 1,
      '27300000-0000-4000-8000-000000000001', 'SMp73aaaaaaaaaaaaaaaaaaaaaaaaaaaa')$$,
  'whatsapp_order_messages_provider_message_idx');

-- ==========================================================================================
-- 7. The provider callback door: service only, inbound refused, replay a no-op, monotonic
-- ==========================================================================================
select pg_temp.p73_actor('27300000-0000-4000-8000-000000000001', true);
select pg_temp.p73_expect_error(
  $$select service_process_whatsapp_provider_event('twilio', 'whatsapp:+972500000001',
    'EVp73-1', 'delivery_status', 'SMp73aaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'sent', null, null, now())$$,
  'service_role_required');
reset role;
select pg_temp.p73_service();

-- #241: inbound text and media are not ingested, not filed and not answered as handled. The
-- refusal happens before any row exists, so nothing can render as processed.
select pg_temp.p73_expect_error(
  $$select service_process_whatsapp_provider_event('twilio', 'whatsapp:+972500000001',
    'EVp73-inbound', 'inbound_message', 'SMp73inbound', null, null, null, now())$$,
  'whatsapp_inbound_unsupported');
select pg_temp.p73_assert(
  not exists (select 1 from whatsapp_webhook_events where event_id = 'EVp73-inbound'),
  'a refused inbound event still left an artefact in the dedupe ledger');

-- An identifier we never issued settles nothing and creates nothing.
-- Every call below is its own statement: AND does not order its operands, so a mutation and an
-- observation inside one expression would prove nothing about which ran first.
select service_process_whatsapp_provider_event('twilio', 'whatsapp:+972500000001',
  'EVp73-ghost', 'delivery_status', 'SMp73-never-issued', 'delivered', null, null, now())
  as ghost \gset
select pg_temp.p73_assert(
  (:'ghost'::jsonb -> 'result' ->> 'state') = 'unknown_message',
  'an unknown provider message id was not reported as unknown');
select pg_temp.p73_assert(
  (select count(*) = 2 from whatsapp_order_messages
   where org_id in ('17300000-0000-4000-8000-000000000001',
                    '17300000-0000-4000-8000-000000000002')),
  'an unknown provider message id created a phantom row');

select service_process_whatsapp_provider_event('twilio', 'whatsapp:+972500000001',
  'EVp73-delivered', 'delivery_status', 'SMp73aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'delivered', null, null, now()) as delivered_first \gset
select pg_temp.p73_assert(
  (:'delivered_first'::jsonb ->> 'processed')::boolean
  and not (:'delivered_first'::jsonb ->> 'duplicate')::boolean,
  'the first delivered callback was not processed');
select pg_temp.p73_assert(
  (select status = 'delivered' from whatsapp_order_messages
   where provider = 'twilio'
     and provider_message_id = 'SMp73aaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  'a delivered callback did not advance the message');

-- Replay of the same provider event identifier is a no-op, answered from the ledger.
select service_process_whatsapp_provider_event('twilio', 'whatsapp:+972500000001',
  'EVp73-delivered', 'delivery_status', 'SMp73aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'delivered', null, null, now()) as delivered_replay \gset
select pg_temp.p73_assert(
  not (:'delivered_replay'::jsonb ->> 'processed')::boolean
  and (:'delivered_replay'::jsonb ->> 'duplicate')::boolean,
  'a replayed provider event was processed a second time');
select pg_temp.p73_assert(
  (select count(*) = 1 from whatsapp_webhook_events where event_id = 'EVp73-delivered'),
  'a replayed provider event was stored twice');

-- Monotonicity lives in SQL, not only in the Edge function: a late, out-of-order callback
-- cannot walk the ladder backwards.
select service_process_whatsapp_provider_event('twilio', 'whatsapp:+972500000001',
  'EVp73-late-sent', 'delivery_status', 'SMp73aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'sent', null, null, now() - interval '5 minutes');
select pg_temp.p73_assert(
  (select status = 'delivered' from whatsapp_order_messages
   where provider = 'twilio' and provider_message_id = 'SMp73aaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  'a late sent callback regressed a delivered message');

select service_process_whatsapp_provider_event('twilio', 'whatsapp:+972500000001',
  'EVp73-read', 'delivery_status', 'SMp73aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'read', null, null, now());
select pg_temp.p73_assert(
  (select status = 'read' and read_at is not null from whatsapp_order_messages
   where provider = 'twilio' and provider_message_id = 'SMp73aaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  'a read receipt did not advance the message');

-- Failure evidence is bounded: a short enumerated code and a length-capped message.
select service_process_whatsapp_provider_event('meta_cloud', 'p73-phone-b',
  'EVp73-failed', 'delivery_status', 'SMp73aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'failed', 'TWILIO_63016', repeat('x', 4000), now());
select pg_temp.p73_assert(
  (select status = 'failed' and error_code = 'twilio_63016'
       and char_length(error_message) = 500
   from whatsapp_order_messages where org_id = '17300000-0000-4000-8000-000000000002'),
  'provider failure evidence was not stored bounded and normalized');
select pg_temp.p73_expect_error(
  $$update whatsapp_order_messages set error_code = repeat('z', 101)
    where org_id = '17300000-0000-4000-8000-000000000002'$$,
  'whatsapp_order_messages_error_code_bounded_check');

-- ==========================================================================================
-- 8. Nothing here is reachable from a browser, and no raw provider payload is stored
-- ==========================================================================================
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.p73_assert(
  not has_table_privilege('authenticated', 'public.whatsapp_connections', 'SELECT')
  and not has_table_privilege('anon', 'public.whatsapp_connections', 'SELECT')
  and not has_table_privilege('authenticated', 'public.whatsapp_webhook_events', 'SELECT')
  and not has_table_privilege('anon', 'public.whatsapp_webhook_events', 'SELECT'),
  'a browser role can read the connection identity or the raw webhook ledger');
select pg_temp.p73_assert(
  not has_function_privilege(
    'authenticated', 'public.service_get_whatsapp_provider_connection(text,text)', 'EXECUTE')
  and not has_function_privilege(
    'anon', 'public.service_get_whatsapp_provider_connection(text,text)', 'EXECUTE')
  and has_function_privilege(
    'service_role', 'public.service_get_whatsapp_provider_connection(text,text)', 'EXECUTE'),
  'the credential-returning connection lookup is not service-role-only');
select pg_temp.p73_assert(
  not has_function_privilege('authenticated',
    'public.service_process_whatsapp_provider_event(text,text,text,text,text,whatsapp_message_status,text,text,timestamptz)',
    'EXECUTE')
  and has_function_privilege('service_role',
    'public.service_process_whatsapp_provider_event(text,text,text,text,text,whatsapp_message_status,text,text,timestamptz)',
    'EXECUTE'),
  'the provider callback door is not service-role-only');
select pg_temp.p73_assert(
  not exists (
    select 1 from information_schema.columns column_info
    where column_info.table_schema = 'public'
      and column_info.table_name in (
        'whatsapp_connections', 'whatsapp_order_messages', 'whatsapp_webhook_events')
      and column_info.column_name in ('payload', 'raw_payload', 'provider_payload', 'body')),
  'a raw provider payload column exists on a WhatsApp table');

-- The masking helper and the identity triggers are private infrastructure.
select pg_temp.p73_assert(
  not has_schema_privilege('authenticated', 'private', 'USAGE')
  and not has_function_privilege('service_role', 'private.mask_whatsapp_sender(text)', 'EXECUTE'),
  'the sender-masking helper is reachable outside the definer bodies that use it');

-- ==========================================================================================
-- 9. Revocation removes the credential, not the evidence
-- ==========================================================================================
select pg_temp.p73_actor('27300000-0000-4000-8000-000000000002', true);
select pg_temp.p73_expect_error(
  $$select revoke_whatsapp_provider_connection('office tries to revoke')$$,
  'whatsapp_not_authorized');
select pg_temp.p73_actor('27300000-0000-4000-8000-000000000001', false);
select pg_temp.p73_expect_error(
  $$select revoke_whatsapp_provider_connection('stale session revokes')$$,
  'fresh_authentication_required');
select pg_temp.p73_actor('27300000-0000-4000-8000-000000000001', true);
select revoke_whatsapp_provider_connection('P73 owner revokes the tenant sender') as revoked \gset
select pg_temp.p73_assert(
  (:'revoked'::jsonb ->> 'configured') = 'false',
  'revocation did not report the connection as gone');
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.p73_assert(
  not exists (select 1 from whatsapp_connections
              where org_id = '17300000-0000-4000-8000-000000000001')
  and (select count(*) = 1 from audit_logs
       where org_id = '17300000-0000-4000-8000-000000000001'
         and action = 'whatsapp_provider_connection_revoked'
         and reason = 'P73 owner revokes the tenant sender')
  and (select count(*) = 1 from whatsapp_order_messages
       where org_id = '17300000-0000-4000-8000-000000000001'),
  'revocation destroyed delivery evidence, or left the connection behind, or skipped the audit');

-- 0191 widened the A5 hole by nothing. Asserted by NAME rather than by a registry census: a
-- catalogue count would silently include whatever else happens to be applied to the machine
-- running this suite, and would then be wrong relative to the branch it is meant to protect.
select pg_temp.p73_assert(
  not exists (
    select 1 from private.scope_definer_exemptions
    where function_signature in (
      'service_get_whatsapp_provider_connection(text,text)',
      'service_process_whatsapp_provider_event(text,text,text,text,text,whatsapp_message_status,text,text,timestamp with time zone)',
      'configure_whatsapp_provider_connection(text,text,text,text,text,text,text,text,text)',
      'set_whatsapp_provider_connection_enabled(boolean,text)',
      'revoke_whatsapp_provider_connection(text)',
      'private.whatsapp_connection_provider_identity()',
      'private.whatsapp_message_provider_identity()',
      'private.whatsapp_webhook_event_provider_identity()',
      'private.mask_whatsapp_sender(text)')),
  'a function introduced by 0191 took a SECURITY DEFINER scope exemption');
select pg_temp.p73_assert(
  not exists (select 1 from private.scope_enforcement_violations()),
  'the A1/A3/A5 assertions do not hold after the provider-neutral migration');

rollback;

\echo 'p73_whatsapp_provider_neutral_passed'
