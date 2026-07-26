-- Close WhatsApp delivery races: immutable recipient context, atomic webhook
-- processing, guarded PO transitions and reclaimable pre-provider reminder claims.

create or replace function private.normalize_whatsapp_phone(p_value text)
returns text
language plpgsql
immutable
security definer
set search_path = pg_catalog
as $$
declare
  v_digits text := regexp_replace(coalesce(p_value, ''), '[^0-9]', '', 'g');
begin
  if v_digits like '9720%' then
    v_digits := '972' || substr(v_digits, 5);
  elsif v_digits like '0%' then
    v_digits := '972' || substr(v_digits, 2);
  end if;
  if v_digits !~ '^[0-9]{8,15}$' then
    return null;
  end if;
  return v_digits;
end
$$;

revoke all on function private.normalize_whatsapp_phone(text)
  from public, anon, authenticated, service_role;

-- Keep the owner toggle executable: CASE otherwise resolves its enum literals as
-- text and fails at runtime when assigned to whatsapp_connection_status.
create or replace function set_whatsapp_connection_enabled(
  p_enabled boolean,
  p_reason text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_reason text := nullif(trim(p_reason), '');
  v_connection whatsapp_connections;
  v_old_status whatsapp_connection_status;
begin
  if v_org is null or v_user is null or auth_role() <> 'owner' then
    raise exception 'whatsapp_not_authorized' using errcode = '42501';
  end if;
  if p_enabled is null or v_reason is null then
    raise exception 'whatsapp_connection_invalid' using errcode = '22023';
  end if;

  select * into v_connection from whatsapp_connections
  where org_id = v_org for update;
  if not found then
    raise exception 'whatsapp_connection_unknown' using errcode = 'P0002';
  end if;
  v_old_status := v_connection.status;

  update whatsapp_connections
  set status = case when p_enabled
    then 'active'::whatsapp_connection_status
    else 'disabled'::whatsapp_connection_status
  end
  where org_id = v_org
  returning * into v_connection;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_user, 'whatsapp_connection_toggled', 'whatsapp_connections', v_org,
    jsonb_build_object('status', v_old_status),
    jsonb_build_object('status', v_connection.status),
    v_reason
  );

  return jsonb_build_object(
    'configured', true,
    'status', v_connection.status,
    'display_phone_number', v_connection.display_phone_number,
    'updated_at', v_connection.updated_at
  );
end
$$;

-- Existing rows intentionally remain null: their historic destination cannot be
-- reconstructed truthfully from a supplier phone number that may since have changed.
alter table whatsapp_order_messages
  add column recipient_number text;
alter table whatsapp_order_messages
  add constraint whatsapp_order_messages_recipient_number_check
  check (recipient_number is null or recipient_number ~ '^[0-9]{8,15}$');

create function private.guard_whatsapp_recipient_snapshot()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if new.recipient_number is distinct from old.recipient_number then
    raise exception 'whatsapp_recipient_snapshot_immutable' using errcode = '42501';
  end if;
  return new;
end
$$;

revoke all on function private.guard_whatsapp_recipient_snapshot()
  from public, anon, authenticated, service_role;

create trigger whatsapp_order_messages_recipient_snapshot_guard
before update of recipient_number on whatsapp_order_messages
for each row execute function private.guard_whatsapp_recipient_snapshot();

-- A reminder that has not started a provider attempt has no confirmation token.
-- It may remain queued or fail a final preflight; every provider-started state and
-- every order message still requires a valid hash.
alter table whatsapp_order_messages
  drop constraint whatsapp_order_messages_confirm_token_hash_check;
alter table whatsapp_order_messages
  alter column confirm_token_hash drop not null;
alter table whatsapp_order_messages
  add constraint whatsapp_order_messages_confirm_token_hash_check check (
    (
      kind = 'reminder' and status in ('queued', 'failed')
      and attempt_count = 0 and confirm_token_hash is null
    )
    or (
      confirm_token_hash is not null
      and confirm_token_hash ~ '^[0-9a-f]{64}$'
    )
  );

alter table whatsapp_webhook_events
  add column processed_at timestamptz,
  add column result jsonb,
  add column payload_fingerprint text,
  add constraint whatsapp_webhook_events_payload_fingerprint_check
    check (payload_fingerprint is null or payload_fingerprint ~ '^[0-9a-f]{64}$');

-- A browser can set a custom GUC if an arbitrary SQL surface is ever introduced.
-- Pair the transaction-local token with a private, single-use marker so the GUC
-- cannot by itself bypass the transition guard.
create table private.whatsapp_sent_transition_guards (
  backend_pid integer not null,
  transaction_id bigint not null,
  order_id uuid not null,
  guard_token text not null check (guard_token ~ '^[0-9a-f]{64}$'),
  primary key (backend_pid, transaction_id, order_id)
);

revoke all on table private.whatsapp_sent_transition_guards
  from public, anon, authenticated, service_role;

create or replace function private.guard_purchase_order_whatsapp_sent()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_token text := current_setting('supplyflow.whatsapp_sent_guard', true);
  v_consumed integer;
begin
  if new.status <> 'sent' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'sent' then
    return new;
  end if;

  -- Guard every entry into sent, not just ready -> sent. Otherwise a caller could
  -- insert sent directly or detour through another status to avoid the acceptance gate.
  if exists (
       select 1 from public.whatsapp_connections c
       where c.org_id = new.org_id and c.status = 'active'
     )
     and exists (
       select 1 from public.suppliers s
       where s.org_id = new.org_id and s.id = new.supplier_id
         and s.deleted_at is null
         and private.normalize_whatsapp_phone(s.whatsapp) is not null
     )
     and not exists (
       select 1 from public.whatsapp_order_messages m
       where m.org_id = new.org_id and m.order_id = new.id
         and m.kind = 'order' and m.status = 'failed'
     ) then
    delete from private.whatsapp_sent_transition_guards g
    where g.backend_pid = pg_backend_pid()
      and g.transaction_id = txid_current()
      and g.order_id = new.id
      and g.guard_token = coalesce(v_token, '');
    get diagnostics v_consumed = row_count;
    if v_consumed <> 1 then
      raise exception 'whatsapp_sent_requires_meta_acceptance' using errcode = '42501';
    end if;
  end if;
  return new;
end
$$;

revoke all on function private.guard_purchase_order_whatsapp_sent()
  from public, anon, authenticated, service_role;

create trigger purchase_orders_whatsapp_sent_guard
before insert or update on purchase_orders
for each row execute function private.guard_purchase_order_whatsapp_sent();

-- The shared P1 trigger previously referenced NEW.received_qty as a static record
-- field even while firing for purchase_orders. Use JSON field access so legitimate
-- manual order transitions reach the table-specific branch reliably.
create or replace function p1_financial_command_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_authorized boolean := current_setting('app.p1_financial_writer', true)
                          is not distinct from auth.uid()::text;
begin
  if v_user is null or v_authorized then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_table_name = 'invoices' and tg_op = 'UPDATE'
     and (to_jsonb(new) - 'deleted_at' - 'updated_at')
         is not distinct from (to_jsonb(old) - 'deleted_at' - 'updated_at') then
    return new;
  end if;

  if tg_table_name = 'purchase_order_items' and tg_op = 'UPDATE'
     and (to_jsonb(new)->'received_qty') is not distinct from
         (to_jsonb(old)->'received_qty') then
    return new;
  end if;

  if tg_table_name = 'purchase_orders' and tg_op = 'UPDATE'
     and (
       (to_jsonb(new)->'status') is not distinct from (to_jsonb(old)->'status')
       or (
         (to_jsonb(new)->>'status') not in ('partial', 'received')
         and (to_jsonb(old)->>'status') not in ('partial', 'received')
       )
     ) then
    return new;
  end if;

  raise exception 'financial_command_rpc_required' using errcode = '42501';
end
$$;

create or replace function claim_whatsapp_order_message(
  p_order_id uuid,
  p_reason text
)
returns jsonb
language plpgsql security definer set search_path = public, extensions, private, pg_temp as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_reason text := nullif(trim(p_reason), '');
  v_order purchase_orders;
  v_supplier suppliers;
  v_connection whatsapp_connections;
  v_message whatsapp_order_messages;
  v_recipient text;
  v_raw_token text;
  v_should_send boolean := false;
  v_idempotent boolean := false;
  v_items jsonb;
  v_total numeric(12,2);
begin
  if v_org is null or v_user is null or auth_role() not in ('owner', 'office', 'kitchen') then
    raise exception 'whatsapp_not_authorized' using errcode = '42501';
  end if;
  if p_order_id is null or v_reason is null then
    raise exception 'whatsapp_message_invalid' using errcode = '22023';
  end if;

  select * into v_order from purchase_orders
  where org_id = v_org and id = p_order_id
  for update;
  if not found then
    raise exception 'whatsapp_order_unknown' using errcode = 'P0002';
  end if;

  select * into v_supplier from suppliers
  where org_id = v_org and id = v_order.supplier_id and deleted_at is null;
  if not found then
    raise exception 'whatsapp_supplier_unknown' using errcode = 'P0002';
  end if;

  select * into v_connection from whatsapp_connections
  where org_id = v_org and status = 'active';
  if not found then
    raise exception 'whatsapp_connection_inactive' using errcode = 'P0001';
  end if;

  select * into v_message from whatsapp_order_messages
  where org_id = v_org and order_id = v_order.id and kind = 'order'
  for update;

  if found then
    if v_message.recipient_number is null then
      raise exception 'whatsapp_recipient_snapshot_missing' using errcode = 'P0001';
    end if;
    v_recipient := v_message.recipient_number;
    v_idempotent := true;
    if v_message.status in ('unknown', 'accepted', 'sent', 'delivered', 'read') then
      v_should_send := false;
    elsif v_message.status = 'sending' then
      if v_message.lease_expires_at > now() then
        v_should_send := false;
      else
        update whatsapp_order_messages
        set status = 'unknown', lease_expires_at = null,
            error_code = 'lease_expired',
            error_message = 'לא התקבלה תשובה חד-משמעית מספק ההודעות'
        where id = v_message.id
        returning * into v_message;
        v_should_send := false;
      end if;
    else
      if v_order.status <> 'ready' then
        raise exception 'whatsapp_order_not_ready' using errcode = 'P0001';
      end if;
      if v_message.attempt_count >= 5 then
        raise exception 'whatsapp_message_retry_limit' using errcode = 'P0001';
      end if;
      v_raw_token := encode(gen_random_bytes(32), 'hex');
      update whatsapp_order_messages
      set status = 'sending',
          confirm_token_hash = encode(sha256(convert_to(v_raw_token, 'UTF8')), 'hex'),
          attempt_count = attempt_count + 1,
          last_attempt_at = now(),
          lease_expires_at = now() + interval '5 minutes',
          meta_message_id = null,
          failed_at = null,
          error_code = null,
          error_message = null
      where id = v_message.id
      returning * into v_message;
      v_should_send := true;
    end if;
  else
    if v_order.status <> 'ready' then
      raise exception 'whatsapp_order_not_ready' using errcode = 'P0001';
    end if;
    v_recipient := private.normalize_whatsapp_phone(v_supplier.whatsapp);
    if v_recipient is null then
      raise exception 'whatsapp_supplier_number_missing' using errcode = 'P0001';
    end if;
    v_raw_token := encode(gen_random_bytes(32), 'hex');
    insert into whatsapp_order_messages (
      org_id, order_id, kind, status, recipient_number, confirm_token_hash,
      attempt_count, last_attempt_at, lease_expires_at, created_by
    ) values (
      v_org, v_order.id, 'order', 'sending', v_recipient,
      encode(sha256(convert_to(v_raw_token, 'UTF8')), 'hex'),
      1, now(), now() + interval '5 minutes', v_user
    ) returning * into v_message;
    v_should_send := true;

    insert into audit_logs (
      org_id, user_id, action, entity_type, entity_id, new_values, reason
    ) values (
      v_org, v_user, 'whatsapp_order_message_claimed',
      'whatsapp_order_messages', v_message.id,
      jsonb_build_object('order_id', v_order.id, 'kind', 'order'),
      v_reason
    );
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'product_id', poi.product_id,
      'product_name', p.name,
      'unit', p.unit,
      'qty', poi.qty,
      'unit_price', poi.unit_price,
      'line_total', round(poi.qty * poi.unit_price, 2)
    ) order by p.name, poi.id), '[]'::jsonb),
    round(coalesce(sum(poi.qty * poi.unit_price), 0), 2)
  into v_items, v_total
  from purchase_order_items poi
  join products p on p.org_id = poi.org_id and p.id = poi.product_id
  where poi.org_id = v_org and poi.order_id = v_order.id;

  return jsonb_strip_nulls(jsonb_build_object(
    'message_id', v_message.id,
    'delivery_status', v_message.status,
    'recipient_number', v_message.recipient_number,
    'idempotent', v_idempotent,
    'should_send', v_should_send,
    'confirmation_token', case when v_should_send then v_raw_token else null end,
    'order', jsonb_build_object(
      'id', v_order.id,
      'number', v_order.number,
      'expected_date', v_order.expected_date,
      'notes', v_order.notes,
      'total', v_total,
      'items', v_items
    ),
    'supplier', jsonb_build_object(
      'id', v_supplier.id,
      'name', v_supplier.name,
      'whatsapp', v_message.recipient_number
    ),
    'connection', jsonb_build_object(
      'phone_number_id', v_connection.phone_number_id,
      'waba_id', v_connection.waba_id,
      'display_phone_number', v_connection.display_phone_number,
      'template_name', v_connection.order_template_name,
      'language_code', v_connection.language_code
    )
  ));
end
$$;

revoke all on function claim_whatsapp_order_message(uuid, text) from public, anon;
grant execute on function claim_whatsapp_order_message(uuid, text) to authenticated;

create or replace function complete_whatsapp_order_message(
  p_message_id uuid,
  p_meta_message_id text
)
returns jsonb
language plpgsql security definer set search_path = public, extensions, private as $$
declare
  v_message whatsapp_order_messages;
  v_order purchase_orders;
  v_meta_id text := nullif(trim(p_meta_message_id), '');
  v_guard_token text;
  v_already_accepted boolean := false;
  v_order_changed boolean := false;
begin
  if p_message_id is null or v_meta_id is null then
    raise exception 'whatsapp_message_invalid' using errcode = '22023';
  end if;
  select * into v_message from whatsapp_order_messages
  where id = p_message_id for update;
  if not found then raise exception 'whatsapp_message_unknown' using errcode = 'P0002'; end if;

  if v_message.meta_message_id is not null and v_message.meta_message_id <> v_meta_id then
    raise exception 'whatsapp_message_id_conflict' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from whatsapp_order_messages other_message
    where other_message.meta_message_id = v_meta_id and other_message.id <> v_message.id
  ) then
    raise exception 'whatsapp_message_id_conflict' using errcode = 'P0001';
  end if;

  v_already_accepted := v_message.status in ('accepted', 'sent', 'delivered', 'read');
  if not v_already_accepted then
    update whatsapp_order_messages
    set status = 'accepted', meta_message_id = v_meta_id,
        accepted_at = coalesce(accepted_at, now()), lease_expires_at = null,
        failed_at = null, error_code = null, error_message = null
    where id = v_message.id
    returning * into v_message;
  elsif v_message.meta_message_id is null then
    update whatsapp_order_messages
    set meta_message_id = v_meta_id
    where id = v_message.id
    returning * into v_message;
  end if;

  if v_message.kind = 'order' then
    select * into v_order from purchase_orders
    where org_id = v_message.org_id and id = v_message.order_id for update;
    if v_order.status = 'ready' then
      v_guard_token := encode(gen_random_bytes(32), 'hex');
      insert into private.whatsapp_sent_transition_guards (
        backend_pid, transaction_id, order_id, guard_token
      ) values (
        pg_backend_pid(), txid_current(), v_order.id, v_guard_token
      ) on conflict (backend_pid, transaction_id, order_id)
        do update set guard_token = excluded.guard_token;
      perform set_config('supplyflow.whatsapp_sent_guard', v_guard_token, true);
      update purchase_orders
      set status = 'sent', sent_at = coalesce(sent_at, now())
      where id = v_order.id;
      delete from private.whatsapp_sent_transition_guards g
      where g.backend_pid = pg_backend_pid()
        and g.transaction_id = txid_current()
        and g.order_id = v_order.id
        and g.guard_token = v_guard_token;
      perform set_config('supplyflow.whatsapp_sent_guard', '', true);
      v_order_changed := true;
    elsif v_order.status not in ('sent', 'confirmed', 'partial', 'received') then
      raise exception 'whatsapp_order_not_sendable' using errcode = 'P0001';
    end if;
  end if;

  if not v_already_accepted then
    insert into audit_logs (
      org_id, user_id, action, entity_type, entity_id, new_values, reason
    ) values (
      v_message.org_id, null, 'whatsapp_message_accepted',
      'whatsapp_order_messages', v_message.id,
      jsonb_build_object('status', 'accepted', 'meta_message_id', v_meta_id),
      'Meta אישרה את קבלת ההודעה לשליחה'
    );
  elsif v_order_changed then
    insert into audit_logs (
      org_id, user_id, action, entity_type, entity_id, new_values, reason
    ) values (
      v_message.org_id, null, 'whatsapp_order_sent_reconciled',
      'purchase_orders', v_message.order_id,
      jsonb_build_object('status', 'sent', 'meta_message_id', v_meta_id),
      'סטטוס Meta מאומת השלים מעבר הזמנה שנקטע'
    );
  end if;

  return jsonb_build_object(
    'message_id', v_message.id,
    'status', v_message.status,
    'meta_message_id', v_message.meta_message_id,
    'idempotent', v_already_accepted and not v_order_changed
  );
end
$$;

revoke all on function complete_whatsapp_order_message(uuid, text)
  from public, anon, authenticated;
grant execute on function complete_whatsapp_order_message(uuid, text) to service_role;

create or replace function record_whatsapp_message_status(
  p_phone_number_id text,
  p_meta_message_id text,
  p_status whatsapp_message_status,
  p_event_at timestamptz
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_connection whatsapp_connections;
  v_message whatsapp_order_messages;
  v_event_at timestamptz := coalesce(p_event_at, now());
  v_changed boolean := false;
begin
  if nullif(trim(p_phone_number_id), '') is null
     or nullif(trim(p_meta_message_id), '') is null
     or p_status not in ('accepted', 'sent', 'delivered', 'read', 'failed') then
    raise exception 'whatsapp_status_invalid' using errcode = '22023';
  end if;

  select * into v_connection from whatsapp_connections
  where phone_number_id = trim(p_phone_number_id);
  if not found then raise exception 'whatsapp_connection_unknown' using errcode = 'P0002'; end if;

  select * into v_message from whatsapp_order_messages
  where org_id = v_connection.org_id and meta_message_id = trim(p_meta_message_id)
  for update;
  if not found then raise exception 'whatsapp_message_unknown' using errcode = 'P0002'; end if;

  -- A positive signed provider event first goes through complete(). That is the only
  -- function allowed to authorize ready -> sent for an active automatic channel.
  if p_status in ('accepted', 'sent', 'delivered', 'read') then
    perform complete_whatsapp_order_message(v_message.id, trim(p_meta_message_id));
    select * into v_message from whatsapp_order_messages where id = v_message.id for update;
  end if;

  if (p_status = 'failed' and whatsapp_status_rank(v_message.status) < 4)
     or (p_status <> 'failed' and (
       v_message.status = 'unknown'
       or whatsapp_status_rank(p_status) > whatsapp_status_rank(v_message.status)
     )) then
    update whatsapp_order_messages set
      status = p_status,
      accepted_at = case when p_status in ('accepted','sent','delivered','read')
        then coalesce(accepted_at, v_event_at) else accepted_at end,
      sent_at = case when p_status in ('sent','delivered','read')
        then coalesce(sent_at, v_event_at) else sent_at end,
      delivered_at = case when p_status in ('delivered','read')
        then coalesce(delivered_at, v_event_at) else delivered_at end,
      read_at = case when p_status = 'read' then coalesce(read_at, v_event_at) else read_at end,
      failed_at = case when p_status = 'failed' then coalesce(failed_at, v_event_at) else failed_at end,
      lease_expires_at = null
    where id = v_message.id
    returning * into v_message;
    v_changed := true;
  end if;

  return jsonb_build_object(
    'message_id', v_message.id,
    'status', v_message.status,
    'changed', v_changed
  );
end
$$;

revoke all on function record_whatsapp_message_status(text, text, whatsapp_message_status, timestamptz)
  from public, anon, authenticated, service_role;

drop function confirm_whatsapp_order(text, text, timestamptz);

create function confirm_whatsapp_order(
  p_phone_number_id text,
  p_context_message_id text,
  p_sender_number text,
  p_confirmation_token text,
  p_confirmed_at timestamptz
)
returns jsonb
language plpgsql security definer set search_path = public, extensions, private as $$
declare
  v_connection whatsapp_connections;
  v_message whatsapp_order_messages;
  v_order purchase_orders;
  v_hash text;
  v_sender text := private.normalize_whatsapp_phone(p_sender_number);
  v_context_id text := nullif(trim(p_context_message_id), '');
  v_at timestamptz := coalesce(p_confirmed_at, now());
begin
  if nullif(trim(p_phone_number_id), '') is null
     or v_context_id is null or v_sender is null
     or p_confirmation_token is null or length(p_confirmation_token) <> 64 then
    raise exception 'whatsapp_confirmation_invalid' using errcode = '22023';
  end if;
  select * into v_connection from whatsapp_connections
  where phone_number_id = trim(p_phone_number_id);
  if not found then raise exception 'whatsapp_connection_unknown' using errcode = 'P0002'; end if;

  v_hash := encode(sha256(convert_to(p_confirmation_token, 'UTF8')), 'hex');
  select * into v_message from whatsapp_order_messages
  where org_id = v_connection.org_id and confirm_token_hash = v_hash
  order by created_at desc limit 1 for update;
  if not found then
    return jsonb_build_object('accepted', false, 'reason', 'invalid_token');
  end if;
  if v_message.meta_message_id is null then
    raise exception 'whatsapp_confirmation_outbound_not_ready' using errcode = 'P0001';
  end if;
  if v_message.meta_message_id <> v_context_id then
    return jsonb_build_object(
      'accepted', false, 'reason', 'context_mismatch', 'order_id', v_message.order_id
    );
  end if;
  if v_message.recipient_number is null then
    return jsonb_build_object(
      'accepted', false, 'reason', 'recipient_snapshot_missing', 'order_id', v_message.order_id
    );
  end if;
  if v_message.recipient_number <> v_sender then
    return jsonb_build_object(
      'accepted', false, 'reason', 'sender_mismatch', 'order_id', v_message.order_id
    );
  end if;
  if v_message.status not in ('unknown', 'accepted', 'sent', 'delivered', 'read') then
    return jsonb_build_object(
      'accepted', false, 'reason', 'message_not_accepted', 'order_id', v_message.order_id
    );
  end if;

  select * into v_order from purchase_orders
  where org_id = v_message.org_id and id = v_message.order_id for update;
  if v_order.status in ('confirmed', 'partial', 'received') then
    return jsonb_build_object(
      'accepted', true, 'order_id', v_order.id,
      'status', v_order.status, 'idempotent', true
    );
  end if;
  if v_order.status not in ('ready', 'sent') then
    raise exception 'whatsapp_order_not_confirmable' using errcode = 'P0001';
  end if;

  update purchase_orders
  set status = 'confirmed', sent_at = coalesce(sent_at, v_at),
      confirmed_at = coalesce(confirmed_at, v_at),
      confirmation_note = coalesce(confirmation_note, 'אישור התקבל ב-WhatsApp')
  where id = v_order.id;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_order.org_id, null, 'purchase_order_whatsapp_confirmed', 'purchase_orders', v_order.id,
    jsonb_build_object('status', v_order.status),
    jsonb_build_object('status', 'confirmed', 'confirmed_at', v_at),
    'הספק אישר את ההזמנה דרך WhatsApp'
  );

  return jsonb_build_object(
    'accepted', true, 'order_id', v_order.id,
    'status', 'confirmed', 'idempotent', false
  );
end
$$;

revoke all on function confirm_whatsapp_order(text, text, text, text, timestamptz)
  from public, anon, authenticated, service_role;

drop function claim_whatsapp_webhook_event(text, text, text, text);

create function process_whatsapp_webhook_event(
  p_phone_number_id text,
  p_event_id text,
  p_event_type text,
  p_meta_message_id text,
  p_status whatsapp_message_status,
  p_sender_number text,
  p_confirmation_token text,
  p_event_at timestamptz
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_connection whatsapp_connections;
  v_event whatsapp_webhook_events;
  v_event_id text := nullif(trim(p_event_id), '');
  v_event_type text := nullif(trim(p_event_type), '');
  v_meta_id text := nullif(trim(p_meta_message_id), '');
  v_inserted integer;
  v_result jsonb;
  v_accepted boolean;
  v_sender text := private.normalize_whatsapp_phone(p_sender_number);
  v_token_fingerprint text;
  v_payload_fingerprint text;
begin
  if nullif(trim(p_phone_number_id), '') is null
     or v_event_id is null or v_event_type is null or v_meta_id is null then
    raise exception 'whatsapp_webhook_event_invalid' using errcode = '22023';
  end if;
  if v_event_type like 'status.%' then
    if p_status is null
       or p_status not in ('accepted', 'sent', 'delivered', 'read', 'failed')
       or v_event_type <> 'status.' || p_status::text
       or p_sender_number is not null or p_confirmation_token is not null then
      raise exception 'whatsapp_webhook_event_invalid' using errcode = '22023';
    end if;
  elsif v_event_type = 'order.confirmation' then
    if p_status is not null
       or private.normalize_whatsapp_phone(p_sender_number) is null
       or p_confirmation_token is null or length(p_confirmation_token) <> 64 then
      raise exception 'whatsapp_webhook_event_invalid' using errcode = '22023';
    end if;
  else
    raise exception 'whatsapp_webhook_event_invalid' using errcode = '22023';
  end if;

  -- Bind the dedupe key to the normalized identity and transition fields without
  -- retaining the one-time confirmation token itself. event_at is deliberately
  -- excluded: when Meta omits a valid timestamp, Edge supplies receipt time, which
  -- can legitimately differ between otherwise identical delivery retries.
  v_token_fingerprint := case when p_confirmation_token is null then null
    else encode(sha256(convert_to(p_confirmation_token, 'UTF8')), 'hex') end;
  v_payload_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'event_type', v_event_type,
    'meta_message_id', v_meta_id,
    'status', p_status,
    'sender_number', v_sender,
    'confirmation_token_hash', v_token_fingerprint
  )::text, 'UTF8')), 'hex');

  select * into v_connection from whatsapp_connections
  where phone_number_id = trim(p_phone_number_id);
  if not found then raise exception 'whatsapp_connection_unknown' using errcode = 'P0002'; end if;

  insert into whatsapp_webhook_events (
    org_id, phone_number_id, event_id, event_type, meta_message_id,
    payload_fingerprint
  ) values (
    v_connection.org_id, trim(p_phone_number_id), v_event_id, v_event_type, v_meta_id,
    v_payload_fingerprint
  ) on conflict (phone_number_id, event_id) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    select * into v_event from whatsapp_webhook_events
    where phone_number_id = trim(p_phone_number_id) and event_id = v_event_id
    for update;
    if v_event.org_id <> v_connection.org_id
       or v_event.event_type <> v_event_type
       or v_event.meta_message_id is distinct from v_meta_id
       or (
         v_event.payload_fingerprint is not null
         and v_event.payload_fingerprint <> v_payload_fingerprint
       ) then
      raise exception 'whatsapp_webhook_event_conflict' using errcode = 'P0001';
    end if;
    if v_event.payload_fingerprint is null then
      update whatsapp_webhook_events
      set payload_fingerprint = v_payload_fingerprint
      where phone_number_id = trim(p_phone_number_id) and event_id = v_event_id;
      v_event.payload_fingerprint := v_payload_fingerprint;
    end if;
    if v_event.processed_at is not null then
      v_accepted := case when v_event_type = 'order.confirmation'
        then coalesce((v_event.result->>'accepted')::boolean, false)
        else true end;
      return jsonb_build_object(
        'processed', false,
        'duplicate', true,
        'accepted', v_accepted,
        'event_id', v_event_id,
        'result', v_event.result
      );
    end if;
  end if;

  if v_event_type like 'status.%' then
    v_result := record_whatsapp_message_status(
      trim(p_phone_number_id), v_meta_id, p_status, p_event_at
    );
    v_accepted := true;
  else
    v_result := confirm_whatsapp_order(
      trim(p_phone_number_id), v_meta_id, p_sender_number,
      p_confirmation_token, p_event_at
    );
    v_accepted := coalesce((v_result->>'accepted')::boolean, false);
  end if;

  update whatsapp_webhook_events
  set processed_at = now(), result = v_result,
      payload_fingerprint = v_payload_fingerprint
  where phone_number_id = trim(p_phone_number_id) and event_id = v_event_id;

  return jsonb_build_object(
    'processed', true,
    'duplicate', false,
    'accepted', v_accepted,
    'event_id', v_event_id,
    'result', v_result
  );
end
$$;

revoke all on function process_whatsapp_webhook_event(
  text, text, text, text, whatsapp_message_status, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function process_whatsapp_webhook_event(
  text, text, text, text, whatsapp_message_status, text, text, timestamptz
) to service_role;

create or replace function claim_whatsapp_confirmation_reminders(p_limit integer)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_expired whatsapp_order_messages;
  v_message whatsapp_order_messages;
  v_results jsonb := '[]'::jsonb;
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
begin
  -- Once a provider attempt has started, an expired lease is ambiguous and is
  -- frozen for manual review. Before provider start, queued leases are reclaimable.
  for v_expired in
    update whatsapp_order_messages
    set status = 'unknown', lease_expires_at = null,
        error_code = 'reminder_send_lease_expired',
        error_message = 'לא ידוע אם תזכורת WhatsApp נשלחה'
    where kind = 'reminder' and status = 'sending'
      and lease_expires_at <= now()
    returning *
  loop
    insert into audit_logs (
      org_id, user_id, action, entity_type, entity_id, new_values, reason
    ) values (
      v_expired.org_id, null, 'whatsapp_reminder_ambiguous',
      'whatsapp_order_messages', v_expired.id,
      jsonb_build_object('status', 'unknown', 'order_id', v_expired.order_id),
      'פג תוקף נעילת השליחה לאחר תחילת ניסיון מול Meta'
    );
  end loop;

  insert into whatsapp_order_messages (
    org_id, order_id, kind, status, recipient_number, confirm_token_hash,
    attempt_count, lease_expires_at, created_by
  )
  select candidate.org_id, candidate.order_id, 'reminder', 'queued',
         candidate.recipient_number, null, 0, null, candidate.created_by
  from (
    select original.org_id, original.order_id, original.created_by,
           original.recipient_number
    from whatsapp_order_messages original
    join purchase_orders po
      on po.org_id = original.org_id and po.id = original.order_id and po.status = 'sent'
    join suppliers s
      on s.org_id = po.org_id and s.id = po.supplier_id and s.deleted_at is null
    join whatsapp_connections wc
      on wc.org_id = original.org_id and wc.status = 'active'
    left join whatsapp_order_messages reminder
      on reminder.org_id = original.org_id
     and reminder.order_id = original.order_id and reminder.kind = 'reminder'
    where original.kind = 'order'
      and original.status in ('accepted', 'sent', 'delivered', 'read')
      and original.accepted_at <= now() - interval '24 hours'
      and original.recipient_number is not null
      and reminder.id is null
    order by original.accepted_at, original.order_id
    limit v_limit
    for update of original skip locked
  ) candidate
  on conflict (org_id, order_id, kind) do nothing;

  for v_message in
    select m.*
    from whatsapp_order_messages m
    join purchase_orders po
      on po.org_id = m.org_id and po.id = m.order_id and po.status = 'sent'
    join whatsapp_connections wc
      on wc.org_id = m.org_id and wc.status = 'active'
    where m.kind = 'reminder' and m.status = 'queued'
      and (m.lease_expires_at is null or m.lease_expires_at <= now())
    order by m.created_at, m.id
    limit v_limit
    for update of m skip locked
  loop
    update whatsapp_order_messages
    set lease_expires_at = now() + interval '5 minutes'
    where id = v_message.id
    returning * into v_message;
    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'message_id', v_message.id,
      'delivery_status', v_message.status
    ));
  end loop;

  return v_results;
end
$$;

revoke all on function claim_whatsapp_confirmation_reminders(integer)
  from public, anon, authenticated;
grant execute on function claim_whatsapp_confirmation_reminders(integer) to service_role;

create function begin_whatsapp_reminder_send(p_message_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_message whatsapp_order_messages;
  v_order purchase_orders;
  v_supplier suppliers;
  v_connection whatsapp_connections;
  v_raw_token text;
  v_items jsonb;
  v_total numeric(12,2);
begin
  if p_message_id is null then
    raise exception 'whatsapp_message_invalid' using errcode = '22023';
  end if;
  select * into v_message from whatsapp_order_messages
  where id = p_message_id for update;
  if not found then raise exception 'whatsapp_message_unknown' using errcode = 'P0002'; end if;
  if v_message.kind <> 'reminder' then
    raise exception 'whatsapp_reminder_invalid' using errcode = '22023';
  end if;

  if v_message.status = 'sending' and v_message.lease_expires_at <= now() then
    update whatsapp_order_messages
    set status = 'unknown', lease_expires_at = null,
        error_code = 'reminder_send_lease_expired',
        error_message = 'לא ידוע אם תזכורת WhatsApp נשלחה'
    where id = v_message.id
    returning * into v_message;
    insert into audit_logs (
      org_id, user_id, action, entity_type, entity_id, new_values, reason
    ) values (
      v_message.org_id, null, 'whatsapp_reminder_ambiguous',
      'whatsapp_order_messages', v_message.id,
      jsonb_build_object('status', 'unknown', 'order_id', v_message.order_id),
      'פג תוקף נעילת השליחה לאחר תחילת ניסיון מול Meta'
    );
  end if;
  if v_message.status <> 'queued' then
    return jsonb_build_object(
      'message_id', v_message.id,
      'delivery_status', v_message.status,
      'recipient_number', v_message.recipient_number,
      'should_send', false,
      'idempotent', true
    );
  end if;
  if v_message.recipient_number is null then
    raise exception 'whatsapp_recipient_snapshot_missing' using errcode = 'P0001';
  end if;

  select * into v_order from purchase_orders
  where org_id = v_message.org_id and id = v_message.order_id for update;
  if not found then raise exception 'whatsapp_order_unknown' using errcode = 'P0002'; end if;
  if v_order.status <> 'sent' then
    update whatsapp_order_messages
    set status = 'failed', lease_expires_at = null,
        failed_at = coalesce(failed_at, now()),
        error_code = 'order_no_longer_pending',
        error_message = 'ההזמנה כבר אינה ממתינה לאישור ספק'
    where id = v_message.id
    returning * into v_message;
    insert into audit_logs (
      org_id, user_id, action, entity_type, entity_id, new_values, reason
    ) values (
      v_message.org_id, null, 'whatsapp_reminder_not_sent',
      'whatsapp_order_messages', v_message.id,
      jsonb_build_object(
        'status', 'failed', 'order_id', v_message.order_id,
        'error_code', 'order_no_longer_pending'
      ),
      'ההזמנה כבר אינה ממתינה לאישור ספק; התזכורת לא נשלחה'
    );
    return jsonb_build_object(
      'message_id', v_message.id, 'delivery_status', v_message.status,
      'recipient_number', v_message.recipient_number,
      'should_send', false, 'idempotent', false,
      'reason', 'order_no_longer_pending'
    );
  end if;

  select * into v_supplier from suppliers
  where org_id = v_order.org_id and id = v_order.supplier_id and deleted_at is null;
  if not found then
    update whatsapp_order_messages
    set status = 'failed', lease_expires_at = null,
        failed_at = coalesce(failed_at, now()),
        error_code = 'supplier_unavailable',
        error_message = 'הספק אינו פעיל עוד; התזכורת לא נשלחה'
    where id = v_message.id
    returning * into v_message;
    insert into audit_logs (
      org_id, user_id, action, entity_type, entity_id, new_values, reason
    ) values (
      v_message.org_id, null, 'whatsapp_reminder_not_sent',
      'whatsapp_order_messages', v_message.id,
      jsonb_build_object(
        'status', 'failed', 'order_id', v_message.order_id,
        'error_code', 'supplier_unavailable'
      ),
      'הספק אינו פעיל עוד; התזכורת לא נשלחה'
    );
    return jsonb_build_object(
      'message_id', v_message.id, 'delivery_status', v_message.status,
      'recipient_number', v_message.recipient_number,
      'should_send', false, 'idempotent', false,
      'reason', 'supplier_unavailable'
    );
  end if;
  select * into v_connection from whatsapp_connections
  where org_id = v_order.org_id and status = 'active';
  if not found then
    return jsonb_build_object(
      'message_id', v_message.id, 'delivery_status', v_message.status,
      'recipient_number', v_message.recipient_number,
      'should_send', false, 'idempotent', true,
      'reason', 'connection_inactive'
    );
  end if;

  v_raw_token := encode(gen_random_bytes(32), 'hex');
  update whatsapp_order_messages
  set status = 'sending',
      confirm_token_hash = encode(sha256(convert_to(v_raw_token, 'UTF8')), 'hex'),
      attempt_count = 1,
      last_attempt_at = now(),
      lease_expires_at = now() + interval '5 minutes',
      failed_at = null, error_code = null, error_message = null
  where id = v_message.id
  returning * into v_message;

  select coalesce(jsonb_agg(jsonb_build_object(
      'product_id', poi.product_id,
      'product_name', p.name,
      'unit', p.unit,
      'qty', poi.qty,
      'unit_price', poi.unit_price,
      'line_total', round(poi.qty * poi.unit_price, 2)
    ) order by p.name, poi.id), '[]'::jsonb),
    round(coalesce(sum(poi.qty * poi.unit_price), 0), 2)
  into v_items, v_total
  from purchase_order_items poi
  join products p on p.org_id = poi.org_id and p.id = poi.product_id
  where poi.org_id = v_order.org_id and poi.order_id = v_order.id;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_message.org_id, null, 'whatsapp_reminder_send_started',
    'whatsapp_order_messages', v_message.id,
    jsonb_build_object('status', 'sending', 'order_id', v_message.order_id),
    'החל ניסיון שליחת תזכורת מול Meta'
  );

  return jsonb_build_object(
    'message_id', v_message.id,
    'delivery_status', v_message.status,
    'recipient_number', v_message.recipient_number,
    'confirmation_token', v_raw_token,
    'should_send', true,
    'idempotent', false,
    'order', jsonb_build_object(
      'id', v_order.id,
      'number', v_order.number,
      'expected_date', v_order.expected_date,
      'notes', v_order.notes,
      'total', v_total,
      'items', v_items
    ),
    'supplier', jsonb_build_object(
      'id', v_supplier.id,
      'name', v_supplier.name,
      'whatsapp', v_message.recipient_number
    ),
    'connection', jsonb_build_object(
      'phone_number_id', v_connection.phone_number_id,
      'waba_id', v_connection.waba_id,
      'display_phone_number', v_connection.display_phone_number,
      'template_name', v_connection.reminder_template_name,
      'language_code', v_connection.language_code
    )
  );
end
$$;

revoke all on function begin_whatsapp_reminder_send(uuid)
  from public, anon, authenticated;
grant execute on function begin_whatsapp_reminder_send(uuid) to service_role;
