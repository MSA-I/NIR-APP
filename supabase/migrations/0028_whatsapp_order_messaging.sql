-- Auditable WhatsApp order delivery. Provider access tokens stay in Supabase Vault.

create extension if not exists supabase_vault with schema vault;
create extension if not exists pg_net;
create extension if not exists pg_cron;

create schema if not exists private;

-- One environment-level scheduler configuration. The value stored here is only a
-- Vault reference: the raw value must be identical to the Edge Function secret
-- WHATSAPP_CRON_SECRET and is never stored in this migration or in cron.job.
create table private.whatsapp_reminder_config (
  id boolean primary key default true check (id),
  edge_url text not null check (trim(edge_url) <> ''),
  cron_secret_id uuid not null references vault.secrets(id) on delete restrict,
  configured_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger whatsapp_reminder_config_touch
before update on private.whatsapp_reminder_config
for each row execute function public.set_updated_at();

revoke all on table private.whatsapp_reminder_config
  from public, anon, authenticated;

create type whatsapp_connection_status as enum ('pending', 'active', 'disabled', 'error');
create type whatsapp_message_kind as enum ('order', 'reminder');
create type whatsapp_message_status as enum (
  'queued', 'sending', 'unknown', 'accepted', 'sent', 'delivered', 'read', 'failed'
);

create table whatsapp_connections (
  org_id uuid primary key references organizations(id) on delete restrict,
  phone_number_id text not null unique check (trim(phone_number_id) <> ''),
  waba_id text not null check (trim(waba_id) <> ''),
  display_phone_number text not null check (trim(display_phone_number) <> ''),
  token_secret_id uuid not null references vault.secrets(id) on delete restrict,
  status whatsapp_connection_status not null default 'pending',
  order_template_name text not null check (trim(order_template_name) <> ''),
  reminder_template_name text not null check (trim(reminder_template_name) <> ''),
  language_code text not null default 'he' check (trim(language_code) <> ''),
  configured_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger whatsapp_connections_touch
before update on whatsapp_connections
for each row execute function set_updated_at();

create table whatsapp_order_messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  order_id uuid not null,
  kind whatsapp_message_kind not null,
  status whatsapp_message_status not null default 'queued',
  meta_message_id text unique,
  confirm_token_hash text not null check (confirm_token_hash ~ '^[0-9a-f]{64}$'),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_attempt_at timestamptz,
  lease_expires_at timestamptz,
  accepted_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  failed_at timestamptz,
  error_code text,
  error_message text,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_order_messages_org_id_id_key unique (org_id, id),
  constraint whatsapp_order_messages_order_fk
    foreign key (org_id, order_id) references purchase_orders(org_id, id) on delete restrict,
  constraint whatsapp_order_messages_actor_fk
    foreign key (org_id, created_by) references profiles(org_id, id) on delete restrict,
  unique (org_id, order_id, kind)
);

create index whatsapp_order_messages_org_status_idx
  on whatsapp_order_messages (org_id, status, updated_at desc);
create index whatsapp_order_messages_reminder_due_idx
  on whatsapp_order_messages (org_id, accepted_at, order_id)
  where kind = 'order' and accepted_at is not null;

create trigger whatsapp_order_messages_touch
before update on whatsapp_order_messages
for each row execute function set_updated_at();

create table whatsapp_webhook_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id),
  phone_number_id text not null,
  event_id text not null check (trim(event_id) <> ''),
  event_type text not null check (trim(event_type) <> ''),
  meta_message_id text,
  received_at timestamptz not null default now(),
  unique (phone_number_id, event_id)
);

create index whatsapp_webhook_events_org_received_idx
  on whatsapp_webhook_events (org_id, received_at desc);

alter table whatsapp_connections enable row level security;
alter table whatsapp_order_messages enable row level security;
alter table whatsapp_webhook_events enable row level security;

create policy whatsapp_order_messages_select on whatsapp_order_messages for select to authenticated using (
  org_id = auth_org() and auth_role() in ('owner', 'office', 'kitchen')
);

revoke all on whatsapp_connections, whatsapp_order_messages, whatsapp_webhook_events
  from public, anon, authenticated;
grant select on whatsapp_order_messages to authenticated;

-- Dashboard subscriptions are useful only when the source tables are in the publication.
-- Keep this idempotent so local resets and upgraded projects converge on the same contract.
do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'purchase_requests', 'purchase_orders', 'invoices', 'payment_requests', 'payments',
    'exceptions', 'credit_requests', 'bank_transactions', 'supplier_products',
    'inventory_movements', 'documents', 'goods_receipts', 'monthly_exports',
    'supplier_price_submissions', 'whatsapp_order_messages'
  ]
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = v_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    end if;
  end loop;
end
$$;

create or replace function whatsapp_status_rank(p_status whatsapp_message_status)
returns integer
language sql immutable security definer set search_path = public as $$
  select case p_status
    when 'queued' then 0
    when 'sending' then 1
    when 'unknown' then 1
    when 'accepted' then 2
    when 'sent' then 3
    when 'delivered' then 4
    when 'read' then 5
    when 'failed' then -1
  end
$$;

revoke all on function whatsapp_status_rank(whatsapp_message_status)
  from public, anon, authenticated;

create or replace function get_whatsapp_connection_status()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_org uuid := auth_org();
  v_connection whatsapp_connections;
begin
  if v_org is null or auth.uid() is null or auth_role() not in ('owner', 'office', 'kitchen') then
    raise exception 'whatsapp_not_authorized' using errcode = '42501';
  end if;

  select * into v_connection from whatsapp_connections where org_id = v_org;
  if not found then
    return jsonb_build_object('configured', false, 'status', null);
  end if;

  return jsonb_build_object(
    'configured', true,
    'status', v_connection.status,
    'phone_number_id', v_connection.phone_number_id,
    'waba_id', v_connection.waba_id,
    'display_phone_number', v_connection.display_phone_number,
    'order_template_name', v_connection.order_template_name,
    'reminder_template_name', v_connection.reminder_template_name,
    'language_code', v_connection.language_code,
    'configured_at', v_connection.configured_at,
    'updated_at', v_connection.updated_at
  );
end
$$;

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
  set status = case when p_enabled then 'active' else 'disabled' end
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

create or replace function claim_whatsapp_order_message(
  p_order_id uuid,
  p_reason text
)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_reason text := nullif(trim(p_reason), '');
  v_order purchase_orders;
  v_supplier suppliers;
  v_connection whatsapp_connections;
  v_message whatsapp_order_messages;
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
  if not found or nullif(trim(v_supplier.whatsapp), '') is null then
    raise exception 'whatsapp_supplier_number_missing' using errcode = 'P0001';
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
    v_idempotent := true;
    if v_message.status in ('unknown', 'accepted', 'sent', 'delivered', 'read') then
      v_should_send := false;
    elsif v_message.status = 'sending' then
      if v_message.lease_expires_at > now() then
        v_should_send := false;
      else
        -- An expired in-flight lease is ambiguous, not proof that Meta rejected the send.
        -- Freeze it for reconciliation instead of risking a duplicate supplier message.
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
    v_raw_token := encode(gen_random_bytes(32), 'hex');
    insert into whatsapp_order_messages (
      org_id, order_id, kind, status, confirm_token_hash,
      attempt_count, last_attempt_at, lease_expires_at, created_by
    ) values (
      v_org, v_order.id, 'order', 'sending',
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
      'whatsapp', v_supplier.whatsapp
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

revoke all on function get_whatsapp_connection_status() from public, anon;
revoke all on function set_whatsapp_connection_enabled(boolean, text) from public, anon;
revoke all on function claim_whatsapp_order_message(uuid, text) from public, anon;
grant execute on function get_whatsapp_connection_status() to authenticated;
grant execute on function set_whatsapp_connection_enabled(boolean, text) to authenticated;
grant execute on function claim_whatsapp_order_message(uuid, text) to authenticated;

-- Service-role configuration and provider callbacks.
create or replace function configure_whatsapp_connection(
  p_org_id uuid,
  p_phone_number_id text,
  p_waba_id text,
  p_display_phone_number text,
  p_token_secret_id uuid,
  p_order_template_name text,
  p_reminder_template_name text,
  p_language_code text,
  p_status whatsapp_connection_status,
  p_reason text
)
returns jsonb
language plpgsql security definer set search_path = public, vault as $$
declare
  v_reason text := nullif(trim(p_reason), '');
  v_connection whatsapp_connections;
begin
  if p_org_id is null or nullif(trim(p_phone_number_id), '') is null
     or nullif(trim(p_waba_id), '') is null or nullif(trim(p_display_phone_number), '') is null
     or p_token_secret_id is null or nullif(trim(p_order_template_name), '') is null
     or nullif(trim(p_reminder_template_name), '') is null
     or nullif(trim(p_language_code), '') is null or p_status is null or v_reason is null then
    raise exception 'whatsapp_connection_invalid' using errcode = '22023';
  end if;
  if not exists (select 1 from organizations where id = p_org_id) then
    raise exception 'whatsapp_organization_unknown' using errcode = 'P0002';
  end if;
  if not exists (select 1 from vault.secrets where id = p_token_secret_id) then
    raise exception 'whatsapp_token_secret_unknown' using errcode = 'P0002';
  end if;

  insert into whatsapp_connections (
    org_id, phone_number_id, waba_id, display_phone_number, token_secret_id,
    status, order_template_name, reminder_template_name, language_code
  ) values (
    p_org_id, trim(p_phone_number_id), trim(p_waba_id), trim(p_display_phone_number),
    p_token_secret_id, p_status, trim(p_order_template_name),
    trim(p_reminder_template_name), trim(p_language_code)
  )
  on conflict (org_id) do update set
    phone_number_id = excluded.phone_number_id,
    waba_id = excluded.waba_id,
    display_phone_number = excluded.display_phone_number,
    token_secret_id = excluded.token_secret_id,
    status = excluded.status,
    order_template_name = excluded.order_template_name,
    reminder_template_name = excluded.reminder_template_name,
    language_code = excluded.language_code,
    configured_at = now()
  returning * into v_connection;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    p_org_id, null, 'whatsapp_connection_configured', 'whatsapp_connections', p_org_id,
    jsonb_build_object(
      'phone_number_id', v_connection.phone_number_id,
      'waba_id', v_connection.waba_id,
      'display_phone_number', v_connection.display_phone_number,
      'status', v_connection.status,
      'order_template_name', v_connection.order_template_name,
      'reminder_template_name', v_connection.reminder_template_name,
      'language_code', v_connection.language_code
    ),
    v_reason
  );

  return jsonb_build_object(
    'org_id', v_connection.org_id,
    'phone_number_id', v_connection.phone_number_id,
    'status', v_connection.status,
    'configured_at', v_connection.configured_at
  );
end
$$;

create or replace function get_whatsapp_connection(
  p_org_id uuid,
  p_phone_number_id text
)
returns jsonb
language plpgsql stable security definer set search_path = public, vault as $$
declare
  v_connection whatsapp_connections;
  v_token text;
begin
  if (p_org_id is null) = (nullif(trim(p_phone_number_id), '') is null) then
    raise exception 'whatsapp_connection_lookup_invalid' using errcode = '22023';
  end if;

  select * into v_connection from whatsapp_connections
  where (p_org_id is not null and org_id = p_org_id)
     or (p_org_id is null and phone_number_id = trim(p_phone_number_id));
  if not found then
    raise exception 'whatsapp_connection_unknown' using errcode = 'P0002';
  end if;

  select decrypted_secret into v_token
  from vault.decrypted_secrets where id = v_connection.token_secret_id;
  if v_token is null then
    raise exception 'whatsapp_token_secret_unknown' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'org_id', v_connection.org_id,
    'phone_number_id', v_connection.phone_number_id,
    'waba_id', v_connection.waba_id,
    'display_phone_number', v_connection.display_phone_number,
    'status', v_connection.status,
    'order_template_name', v_connection.order_template_name,
    'reminder_template_name', v_connection.reminder_template_name,
    'language_code', v_connection.language_code,
    'access_token', v_token
  );
end
$$;

create or replace function complete_whatsapp_order_message(
  p_message_id uuid,
  p_meta_message_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_message whatsapp_order_messages;
  v_order purchase_orders;
  v_meta_id text := nullif(trim(p_meta_message_id), '');
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
  if v_message.status in ('accepted', 'sent', 'delivered', 'read') then
    return jsonb_build_object(
      'message_id', v_message.id, 'status', v_message.status,
      'meta_message_id', v_message.meta_message_id, 'idempotent', true
    );
  end if;

  update whatsapp_order_messages
  set status = 'accepted', meta_message_id = v_meta_id,
      accepted_at = coalesce(accepted_at, now()), lease_expires_at = null,
      failed_at = null, error_code = null, error_message = null
  where id = v_message.id
  returning * into v_message;

  if v_message.kind = 'order' then
    select * into v_order from purchase_orders
    where org_id = v_message.org_id and id = v_message.order_id for update;
    if v_order.status = 'ready' then
      update purchase_orders set status = 'sent', sent_at = coalesce(sent_at, now())
      where id = v_order.id;
    elsif v_order.status not in ('sent', 'confirmed', 'partial', 'received') then
      raise exception 'whatsapp_order_not_sendable' using errcode = 'P0001';
    end if;
  end if;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_message.org_id, null, 'whatsapp_message_accepted',
    'whatsapp_order_messages', v_message.id,
    jsonb_build_object('status', 'accepted', 'meta_message_id', v_meta_id),
    'Meta אישרה את קבלת ההודעה לשליחה'
  );

  return jsonb_build_object(
    'message_id', v_message.id, 'status', v_message.status,
    'meta_message_id', v_message.meta_message_id, 'idempotent', false
  );
end
$$;

create or replace function fail_whatsapp_order_message(
  p_message_id uuid,
  p_error_code text,
  p_error_message text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_message whatsapp_order_messages;
  v_code text := nullif(trim(p_error_code), '');
  v_error text := nullif(trim(p_error_message), '');
begin
  if p_message_id is null or v_code is null or v_error is null then
    raise exception 'whatsapp_message_invalid' using errcode = '22023';
  end if;
  select * into v_message from whatsapp_order_messages
  where id = p_message_id for update;
  if not found then raise exception 'whatsapp_message_unknown' using errcode = 'P0002'; end if;

  if v_message.status in ('delivered', 'read') then
    return jsonb_build_object(
      'message_id', v_message.id, 'status', v_message.status, 'idempotent', true
    );
  end if;

  update whatsapp_order_messages
  set status = 'failed', failed_at = now(), lease_expires_at = null,
      error_code = v_code, error_message = v_error
  where id = v_message.id
  returning * into v_message;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_message.org_id, null, 'whatsapp_message_failed',
    'whatsapp_order_messages', v_message.id,
    jsonb_build_object('status', 'failed', 'error_code', v_code),
    v_error
  );

  return jsonb_build_object(
    'message_id', v_message.id, 'status', v_message.status, 'idempotent', false
  );
end
$$;

create or replace function mark_whatsapp_message_ambiguous(
  p_message_id uuid,
  p_error_code text,
  p_error_message text,
  p_meta_message_id text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_message whatsapp_order_messages;
  v_code text := nullif(trim(p_error_code), '');
  v_error text := nullif(trim(p_error_message), '');
  v_meta_id text := nullif(trim(p_meta_message_id), '');
begin
  if p_message_id is null or v_code is null or v_error is null then
    raise exception 'whatsapp_message_invalid' using errcode = '22023';
  end if;
  select * into v_message from whatsapp_order_messages
  where id = p_message_id for update;
  if not found then raise exception 'whatsapp_message_unknown' using errcode = 'P0002'; end if;

  if v_message.meta_message_id is not null and v_meta_id is not null
     and v_message.meta_message_id <> v_meta_id then
    raise exception 'whatsapp_message_id_conflict' using errcode = 'P0001';
  end if;
  if v_message.status in ('accepted', 'sent', 'delivered', 'read') then
    return jsonb_build_object(
      'message_id', v_message.id, 'status', v_message.status, 'idempotent', true
    );
  end if;
  if v_message.status = 'unknown' then
    return jsonb_build_object(
      'message_id', v_message.id, 'status', v_message.status,
      'meta_message_id', v_message.meta_message_id, 'idempotent', true
    );
  end if;
  if v_message.status not in ('queued', 'sending') then
    raise exception 'whatsapp_message_not_ambiguous' using errcode = 'P0001';
  end if;

  update whatsapp_order_messages
  set status = 'unknown',
      meta_message_id = coalesce(meta_message_id, v_meta_id),
      lease_expires_at = null,
      error_code = v_code,
      error_message = v_error
  where id = v_message.id
  returning * into v_message;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_message.org_id, null, 'whatsapp_message_ambiguous',
    'whatsapp_order_messages', v_message.id,
    jsonb_build_object(
      'status', 'unknown', 'meta_message_id', v_message.meta_message_id,
      'error_code', v_code
    ),
    v_error
  );

  return jsonb_build_object(
    'message_id', v_message.id, 'status', v_message.status,
    'meta_message_id', v_message.meta_message_id, 'idempotent', false
  );
end
$$;

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

  -- A signed provider status proves that an order message left Meta even when the
  -- original HTTP response was ambiguous and complete() never ran.
  if v_message.kind = 'order' and v_message.status in ('sent', 'delivered', 'read') then
    update purchase_orders
    set status = 'sent', sent_at = coalesce(sent_at, v_event_at)
    where org_id = v_message.org_id and id = v_message.order_id and status = 'ready';
  end if;

  return jsonb_build_object(
    'message_id', v_message.id,
    'status', v_message.status,
    'changed', v_changed
  );
end
$$;

create or replace function claim_whatsapp_webhook_event(
  p_phone_number_id text,
  p_event_id text,
  p_event_type text,
  p_meta_message_id text
)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
  v_inserted integer;
begin
  if nullif(trim(p_phone_number_id), '') is null or nullif(trim(p_event_id), '') is null
     or nullif(trim(p_event_type), '') is null then
    raise exception 'whatsapp_webhook_event_invalid' using errcode = '22023';
  end if;
  select org_id into v_org from whatsapp_connections
  where phone_number_id = trim(p_phone_number_id);
  if v_org is null then raise exception 'whatsapp_connection_unknown' using errcode = 'P0002'; end if;

  insert into whatsapp_webhook_events (
    org_id, phone_number_id, event_id, event_type, meta_message_id
  ) values (
    v_org, trim(p_phone_number_id), trim(p_event_id), trim(p_event_type),
    nullif(trim(p_meta_message_id), '')
  ) on conflict (phone_number_id, event_id) do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted = 1;
end
$$;

create or replace function confirm_whatsapp_order(
  p_phone_number_id text,
  p_confirmation_token text,
  p_confirmed_at timestamptz
)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_connection whatsapp_connections;
  v_message whatsapp_order_messages;
  v_order purchase_orders;
  v_hash text;
  v_at timestamptz := coalesce(p_confirmed_at, now());
begin
  if nullif(trim(p_phone_number_id), '') is null
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
  if not found then raise exception 'whatsapp_confirmation_unknown' using errcode = 'P0002'; end if;

  select * into v_order from purchase_orders
  where org_id = v_message.org_id and id = v_message.order_id for update;
  if v_order.status in ('confirmed', 'partial', 'received') then
    return jsonb_build_object(
      'order_id', v_order.id, 'status', v_order.status, 'idempotent', true
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
    'order_id', v_order.id, 'status', 'confirmed', 'idempotent', false
  );
end
$$;

create or replace function claim_whatsapp_confirmation_reminders(p_limit integer)
returns jsonb
language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare
  v_candidate record;
  v_message whatsapp_order_messages;
  v_raw_token text;
  v_items jsonb;
  v_total numeric(12,2);
  v_results jsonb := '[]'::jsonb;
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
begin
  -- A reminder has exactly one logical row and one provider attempt. Failed or ambiguous
  -- reminders require manual review; they are never reclaimed automatically.
  for v_candidate in
    select
      original.org_id,
      original.order_id,
      original.created_by,
      po.number as order_number,
      po.expected_date,
      po.notes,
      s.id as supplier_id,
      s.name as supplier_name,
      s.whatsapp,
      wc.phone_number_id,
      wc.waba_id,
      wc.display_phone_number,
      wc.reminder_template_name,
      wc.language_code
    from whatsapp_order_messages original
    join purchase_orders po
      on po.org_id = original.org_id and po.id = original.order_id and po.status = 'sent'
    join suppliers s
      on s.org_id = po.org_id and s.id = po.supplier_id
     and s.deleted_at is null and nullif(trim(s.whatsapp), '') is not null
    join whatsapp_connections wc
      on wc.org_id = original.org_id and wc.status = 'active'
    left join whatsapp_order_messages reminder
      on reminder.org_id = original.org_id
     and reminder.order_id = original.order_id and reminder.kind = 'reminder'
    where original.kind = 'order'
      and original.status in ('accepted', 'sent', 'delivered', 'read')
      and original.accepted_at <= now() - interval '24 hours'
      and reminder.id is null
    order by original.accepted_at, original.order_id
    limit v_limit
    for update of original skip locked
  loop
    v_raw_token := encode(gen_random_bytes(32), 'hex');
    insert into whatsapp_order_messages (
      org_id, order_id, kind, status, confirm_token_hash,
      attempt_count, last_attempt_at, lease_expires_at, created_by
    ) values (
      v_candidate.org_id, v_candidate.order_id, 'reminder', 'sending',
      encode(sha256(convert_to(v_raw_token, 'UTF8')), 'hex'),
      1, now(), now() + interval '5 minutes', v_candidate.created_by
    ) returning * into v_message;

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
    where poi.org_id = v_candidate.org_id and poi.order_id = v_candidate.order_id;

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'message_id', v_message.id,
      'delivery_status', v_message.status,
      'confirmation_token', v_raw_token,
      'order', jsonb_build_object(
        'id', v_candidate.order_id,
        'number', v_candidate.order_number,
        'expected_date', v_candidate.expected_date,
        'notes', v_candidate.notes,
        'total', v_total,
        'items', v_items
      ),
      'supplier', jsonb_build_object(
        'id', v_candidate.supplier_id,
        'name', v_candidate.supplier_name,
        'whatsapp', v_candidate.whatsapp
      ),
      'connection', jsonb_build_object(
        'phone_number_id', v_candidate.phone_number_id,
        'waba_id', v_candidate.waba_id,
        'display_phone_number', v_candidate.display_phone_number,
        'template_name', v_candidate.reminder_template_name,
        'language_code', v_candidate.language_code
      )
    ));
  end loop;
  return v_results;
end
$$;

revoke all on function configure_whatsapp_connection(uuid, text, text, text, uuid, text, text, text, whatsapp_connection_status, text)
  from public, anon, authenticated;
revoke all on function get_whatsapp_connection(uuid, text)
  from public, anon, authenticated;
revoke all on function complete_whatsapp_order_message(uuid, text)
  from public, anon, authenticated;
revoke all on function fail_whatsapp_order_message(uuid, text, text)
  from public, anon, authenticated;
revoke all on function mark_whatsapp_message_ambiguous(uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function record_whatsapp_message_status(text, text, whatsapp_message_status, timestamptz)
  from public, anon, authenticated;
revoke all on function claim_whatsapp_webhook_event(text, text, text, text)
  from public, anon, authenticated;
revoke all on function confirm_whatsapp_order(text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function claim_whatsapp_confirmation_reminders(integer)
  from public, anon, authenticated;

grant execute on function configure_whatsapp_connection(uuid, text, text, text, uuid, text, text, text, whatsapp_connection_status, text)
  to service_role;
grant execute on function get_whatsapp_connection(uuid, text) to service_role;
grant execute on function complete_whatsapp_order_message(uuid, text) to service_role;
grant execute on function fail_whatsapp_order_message(uuid, text, text) to service_role;
grant execute on function mark_whatsapp_message_ambiguous(uuid, text, text, text) to service_role;
grant execute on function record_whatsapp_message_status(text, text, whatsapp_message_status, timestamptz)
  to service_role;
grant execute on function claim_whatsapp_webhook_event(text, text, text, text) to service_role;
grant execute on function confirm_whatsapp_order(text, text, timestamptz) to service_role;
grant execute on function claim_whatsapp_confirmation_reminders(integer) to service_role;

-- pg_cron invokes only this private dispatcher. Missing configuration (or a
-- missing/empty Vault value) is deliberately a quiet no-op, so migrations may be
-- applied before the Edge Function is deployed and configured.
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

revoke all on function private.dispatch_whatsapp_confirmation_reminders()
  from public, anon, authenticated, service_role;

-- cron.schedule(job_name, ...) is an upsert by job name, so applying this gate
-- converges to one active 15-minute job without duplicating schedules.
select cron.schedule(
  'supplyflow-whatsapp-confirmation-reminders',
  '*/15 * * * *',
  'select private.dispatch_whatsapp_confirmation_reminders();'
);
