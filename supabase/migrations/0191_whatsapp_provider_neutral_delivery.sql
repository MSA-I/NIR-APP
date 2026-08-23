-- 0191 -- WhatsApp delivery stops being Meta-shaped: one provider discriminator, provider-neutral
-- connection and message identifiers, and a per-provider identity CHECK, so decision #239's
-- chosen provider can enter the 0028/0029 ledger without a second delivery architecture and
-- without editing a migration production has already run.
--
-- ==========================================================================================
-- WHAT CHANGES FOR THE BUSINESS. Decision #239 (22.08.2026, owner) chose Twilio, not Meta Cloud
-- API. 0028 wrote the WhatsApp ledger against Meta's vocabulary and made those assumptions
-- structural, not cosmetic: `whatsapp_connections.phone_number_id` and `.waba_id` are NOT NULL,
-- so a connection that has neither -- which is exactly what a Twilio connection is -- cannot be
-- represented at all; `whatsapp_order_messages.meta_message_id` is the single provider-id
-- surface, globally unique, so two providers would collide in one column. Nothing about the
-- BUSINESS rules changed: an order is still `sent` only on an observed provider acceptance, a
-- connection still belongs to exactly one organization (#240), and inbound WhatsApp is still
-- explicitly unsupported at launch (#241). What changes is that those rules stop naming one
-- vendor.
--
-- THIS IS SCHEMA, NOT ACTIVATION. Twilio is `SELECTED / ACCOUNT_NOT_PROVEN /
-- CREDENTIALS_NOT_CONFIGURED / NOT_INTEGRATED` (#239). No account exists, no credential is
-- stored, no message has been sent. This migration makes the shape representable; it claims
-- nothing about a live channel.
--
-- WHY THIS SHAPE.
--
--   * ONE DISCRIMINATOR, TWO NEUTRAL IDENTIFIERS. `provider` is a bounded text vocabulary
--     ('meta_cloud', 'twilio') rather than an enum, because a third provider must be addable
--     forward-only inside a transaction. `provider_sender_id` is the routing key every webhook
--     resolves a tenant by; `provider_account_id` is the owning account above it. For Meta they
--     ARE `phone_number_id` and `waba_id`; for Twilio they are the channel sender address and
--     the account identifier. One reader, two vendors.
--
--   * THE LEGACY COLUMNS STAY, AND STAY TRUE. Requirement: retain the Meta-shaped columns and
--     readers until the new path is proven, and retire them forward-only later -- not here. A
--     BEFORE trigger keeps `provider_sender_id`/`provider_account_id` identical to the Meta
--     columns for a 'meta_cloud' row and keeps the Meta columns empty for any other provider,
--     so every 0028/0029 reader, every fixture and every historical insert keeps working
--     unchanged, while a non-Meta row can never carry a Meta identity it does not have.
--
--   * MEASURED, NOT GUESSED. A provider cannot be inferred from an existing row. Before any
--     relaxation this file COUNTS the connection and message ledgers and refuses to proceed if
--     either is non-empty, naming the human decision required instead of defaulting one. The
--     local stack measured 0 connections, 0 messages and 0 webhook events on 23.08.2026; the
--     assertion is what makes that measurement binding rather than a note.
--
--   * NO SECOND DELIVERY ARCHITECTURE. Claim-with-lease, the attempt ceiling, the `unknown`
--     freeze for ambiguous in-flight sends and the monotonic status ladder are 0028/0029's and
--     stay 0028/0029's. Monotonicity remains enforced in SQL (whatsapp_status_rank +
--     record_whatsapp_message_status), so a late or out-of-order provider callback cannot
--     regress a further-along state no matter which Edge Function delivers it.
--
--   * EXISTING BODIES ARE PATCHED BY ANCHOR, NEVER REDECLARED. The 0133/0168 idiom: fetch the
--     LIVE definition with pg_get_functiondef, assert each anchor appears exactly once, refuse
--     loudly if it moved. Redeclaring from 0028's text would have silently reverted 0133's
--     narrowing of `get_whatsapp_connection_status` from ('owner','office','kitchen') to
--     ('owner','office') -- measured: the live body differs from every migration file in this
--     repository, because 0133 rewrote it generically.
--
-- A5 / EXEMPTION PIN: ZERO new rows. Every function created here touches only
-- whatsapp_connections, whatsapp_order_messages, whatsapp_webhook_events, organizations,
-- audit_logs and vault -- none of them scope-enforced -- and delegates every transition that
-- reaches an enforced table to the 0028/0029 functions that already hold their exemption. The
-- registry stays at 90 and p9_five_domains.sql does not move.
-- ==========================================================================================

-- ===== 0. Measure before changing anything =====
-- A provider cannot be inferred from a row that predates the discriminator. If either ledger
-- has content, this migration refuses rather than defaulting every historical row to Meta.
do $$
declare
  v_connections bigint;
  v_messages bigint;
begin
  select count(*) into v_connections from whatsapp_connections;
  select count(*) into v_messages from whatsapp_order_messages;
  if v_connections <> 0 or v_messages <> 0 then
    raise exception
      '0191 refuses to guess a provider: % connection row(s) and % message row(s) exist. '
      'Set the provider on each row by explicit owner decision first, then re-run.',
      v_connections, v_messages;
  end if;
end
$$;

-- ===== 1. Connection identity becomes provider-neutral =====
alter table whatsapp_connections
  add column provider text not null default 'meta_cloud'
    check (provider in ('meta_cloud', 'twilio')),
  add column provider_account_id text,
  add column provider_sender_id text;

comment on column whatsapp_connections.provider is
  'Which messaging provider carries this organization''s WhatsApp channel (#239).';
comment on column whatsapp_connections.provider_sender_id is
  'Provider-neutral routing key a delivery callback resolves the tenant by. Equals '
  'phone_number_id for a meta_cloud connection; the channel sender address for twilio.';
comment on column whatsapp_connections.provider_account_id is
  'Provider-neutral owning account above the sender. Equals waba_id for a meta_cloud connection.';

-- The Meta identity columns become conditionally required instead of unconditionally required:
-- unsatisfiable for a non-Meta connection is the defect this migration exists to remove.
alter table whatsapp_connections alter column phone_number_id drop not null;
alter table whatsapp_connections alter column waba_id drop not null;

create function private.whatsapp_connection_provider_identity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if new.provider = 'meta_cloud' then
    new.provider_sender_id := coalesce(new.provider_sender_id, new.phone_number_id);
    new.provider_account_id := coalesce(new.provider_account_id, new.waba_id);
  else
    -- A non-Meta connection has no Meta identity. Refusing to store one keeps the legacy
    -- readers honest: what they read is Meta or nothing.
    new.phone_number_id := null;
    new.waba_id := null;
  end if;
  return new;
end
$$;

revoke all on function private.whatsapp_connection_provider_identity()
  from public, anon, authenticated, service_role;

create trigger whatsapp_connections_provider_identity
before insert or update on whatsapp_connections
for each row execute function private.whatsapp_connection_provider_identity();

alter table whatsapp_connections
  add constraint whatsapp_connections_provider_identity_check check (
    case provider
      when 'meta_cloud' then
        phone_number_id is not null and waba_id is not null
        and provider_sender_id = phone_number_id
        and provider_account_id = waba_id
      when 'twilio' then
        phone_number_id is null and waba_id is null
        and nullif(trim(provider_sender_id), '') is not null
        and nullif(trim(provider_account_id), '') is not null
      else false
    end
  );

-- One sender belongs to one organization, per provider: the webhook routing key must be
-- unambiguous or a callback could settle another tenant's message.
create unique index whatsapp_connections_provider_sender_idx
  on whatsapp_connections (provider, provider_sender_id);

-- ===== 2. Message identity becomes provider-neutral =====
alter table whatsapp_order_messages
  add column provider text not null default 'meta_cloud'
    check (provider in ('meta_cloud', 'twilio')),
  add column provider_message_id text;

comment on column whatsapp_order_messages.provider_message_id is
  'Provider-neutral identifier of the delivered message. Mirrors meta_message_id for a '
  'meta_cloud row; for any other provider meta_message_id stays empty.';

create function private.whatsapp_message_provider_identity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' then
    -- A message is carried by the organization's one connection, so the connection decides the
    -- provider. Without this the historical claim path (0028/0029, which predates the
    -- discriminator) would stamp every new row Meta regardless of who actually sends it.
    new.provider := coalesce(
      (select connection.provider from public.whatsapp_connections connection
       where connection.org_id = new.org_id),
      new.provider);
  elsif new.provider is distinct from old.provider then
    raise exception 'whatsapp_message_provider_immutable' using errcode = '42501';
  end if;

  if new.provider = 'meta_cloud' then
    new.provider_message_id := coalesce(new.provider_message_id, new.meta_message_id);
    new.meta_message_id := new.provider_message_id;
  else
    new.meta_message_id := null;
  end if;
  return new;
end
$$;

revoke all on function private.whatsapp_message_provider_identity()
  from public, anon, authenticated, service_role;

create trigger whatsapp_order_messages_provider_identity
before insert or update on whatsapp_order_messages
for each row execute function private.whatsapp_message_provider_identity();

-- The uniqueness meta_message_id carried, now per provider so two providers cannot collide.
create unique index whatsapp_order_messages_provider_message_idx
  on whatsapp_order_messages (provider, provider_message_id)
  where provider_message_id is not null;

-- Bounded failure evidence: a short enumerated code and a length-capped human message. A raw
-- provider payload is never stored on a row any browser role can read.
alter table whatsapp_order_messages
  add constraint whatsapp_order_messages_error_code_bounded_check check (
    error_code is null or (char_length(error_code) <= 100 and error_code ~ '^[a-z0-9_]+$')
  ),
  add constraint whatsapp_order_messages_error_message_bounded_check check (
    error_message is null or char_length(error_message) <= 500
  );

-- ===== 3. The webhook dedupe ledger becomes provider-neutral =====
alter table whatsapp_webhook_events
  add column provider text not null default 'meta_cloud'
    check (provider in ('meta_cloud', 'twilio')),
  add column provider_sender_id text,
  add column provider_message_id text;

alter table whatsapp_webhook_events alter column phone_number_id drop not null;

create function private.whatsapp_webhook_event_provider_identity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if new.provider = 'meta_cloud' then
    new.provider_sender_id := coalesce(new.provider_sender_id, new.phone_number_id);
    new.provider_message_id := coalesce(new.provider_message_id, new.meta_message_id);
  else
    new.phone_number_id := null;
    new.meta_message_id := null;
  end if;
  return new;
end
$$;

revoke all on function private.whatsapp_webhook_event_provider_identity()
  from public, anon, authenticated, service_role;

create trigger whatsapp_webhook_events_provider_identity
before insert or update on whatsapp_webhook_events
for each row execute function private.whatsapp_webhook_event_provider_identity();

alter table whatsapp_webhook_events
  add constraint whatsapp_webhook_events_provider_identity_check check (
    case provider
      when 'meta_cloud' then
        phone_number_id is not null and provider_sender_id = phone_number_id
      when 'twilio' then
        phone_number_id is null and nullif(trim(provider_sender_id), '') is not null
      else false
    end
  );

-- De-duplication by the provider's own event identifier, enforced by the database rather than
-- by whichever Edge Function happens to receive the retry.
create unique index whatsapp_webhook_events_provider_event_idx
  on whatsapp_webhook_events (provider, provider_sender_id, event_id);

-- ===== 4. Existing bodies, patched by anchor against the LIVE definition =====
-- Never sourced from 0028/0029: the live get_whatsapp_connection_status body was rewritten by
-- 0133 and no migration file in this repository contains it.

do $patch_complete$
declare
  v_definition text;
  v_patched text;
  v_anchor text;
  v_replacement text;
begin
  select replace(pg_get_functiondef(proc.oid), e'\r', '') into v_definition
  from pg_catalog.pg_proc proc
  where proc.oid = to_regprocedure('public.complete_whatsapp_order_message(uuid,text)');
  if v_definition is null then
    raise exception '0191: complete_whatsapp_order_message is absent -- refusing to proceed';
  end if;
  v_patched := v_definition;

  v_anchor := replace($a$  if v_message.meta_message_id is not null and v_message.meta_message_id <> v_meta_id then$a$, e'\r', '');
  v_replacement := replace($r$  if v_message.provider_message_id is not null and v_message.provider_message_id <> v_meta_id then$r$, e'\r', '');
  if (length(v_patched) - length(replace(v_patched, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception '0191: complete() identity-conflict anchor moved -- refusing to patch blindly';
  end if;
  v_patched := replace(v_patched, v_anchor, v_replacement);

  v_anchor := replace($a$    where other_message.meta_message_id = v_meta_id and other_message.id <> v_message.id$a$, e'\r', '');
  v_replacement := replace($r$    where other_message.provider = v_message.provider
      and other_message.provider_message_id = v_meta_id and other_message.id <> v_message.id$r$, e'\r', '');
  if (length(v_patched) - length(replace(v_patched, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception '0191: complete() duplicate-identity anchor moved -- refusing to patch blindly';
  end if;
  v_patched := replace(v_patched, v_anchor, v_replacement);

  v_anchor := replace($a$    set status = 'accepted', meta_message_id = v_meta_id,$a$, e'\r', '');
  v_replacement := replace($r$    set status = 'accepted', provider_message_id = v_meta_id,$r$, e'\r', '');
  if (length(v_patched) - length(replace(v_patched, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception '0191: complete() acceptance anchor moved -- refusing to patch blindly';
  end if;
  v_patched := replace(v_patched, v_anchor, v_replacement);

  v_anchor := replace($a$  elsif v_message.meta_message_id is null then
    update whatsapp_order_messages
    set meta_message_id = v_meta_id$a$, e'\r', '');
  v_replacement := replace($r$  elsif v_message.provider_message_id is null then
    update whatsapp_order_messages
    set provider_message_id = v_meta_id$r$, e'\r', '');
  if (length(v_patched) - length(replace(v_patched, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception '0191: complete() backfill anchor moved -- refusing to patch blindly';
  end if;
  v_patched := replace(v_patched, v_anchor, v_replacement);

  v_anchor := replace($a$    'meta_message_id', v_message.meta_message_id,
    'idempotent'$a$, e'\r', '');
  v_replacement := replace($r$    'meta_message_id', v_message.meta_message_id,
    'provider', v_message.provider,
    'provider_message_id', v_message.provider_message_id,
    'idempotent'$r$, e'\r', '');
  if (length(v_patched) - length(replace(v_patched, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception '0191: complete() result anchor moved -- refusing to patch blindly';
  end if;
  v_patched := replace(v_patched, v_anchor, v_replacement);

  execute v_patched;
end
$patch_complete$;

do $patch_record$
declare
  v_definition text;
  v_patched text;
  v_anchor text;
  v_replacement text;
begin
  select replace(pg_get_functiondef(proc.oid), e'\r', '') into v_definition
  from pg_catalog.pg_proc proc
  where proc.oid = to_regprocedure(
    'public.record_whatsapp_message_status(text,text,whatsapp_message_status,timestamptz)');
  if v_definition is null then
    raise exception '0191: record_whatsapp_message_status is absent -- refusing to proceed';
  end if;
  v_patched := v_definition;

  v_anchor := replace($a$  where phone_number_id = trim(p_phone_number_id);$a$, e'\r', '');
  v_replacement := replace($r$  where provider_sender_id = trim(p_phone_number_id);$r$, e'\r', '');
  if (length(v_patched) - length(replace(v_patched, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception '0191: record() connection anchor moved -- refusing to patch blindly';
  end if;
  v_patched := replace(v_patched, v_anchor, v_replacement);

  v_anchor := replace($a$  where org_id = v_connection.org_id and meta_message_id = trim(p_meta_message_id)$a$, e'\r', '');
  v_replacement := replace($r$  where org_id = v_connection.org_id and provider_message_id = trim(p_meta_message_id)$r$, e'\r', '');
  if (length(v_patched) - length(replace(v_patched, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception '0191: record() message anchor moved -- refusing to patch blindly';
  end if;
  v_patched := replace(v_patched, v_anchor, v_replacement);

  execute v_patched;
end
$patch_record$;

-- The two send-claim functions hand the worker a connection block that is Meta-only. A worker
-- for any other provider cannot route on it, so both learn the neutral identity. Patched
-- separately and asserted separately: 0028/0029 wrote them as a pair, but 0103 has since moved
-- one of them and 0133 has since narrowed the other, so they are NOT interchangeable.
do $patch_send_claims$
declare
  v_case record;
  v_definition text;
  v_anchor text := replace($a$      'phone_number_id', v_connection.phone_number_id,
      'waba_id', v_connection.waba_id,$a$, e'\r', '');
  v_replacement text := replace($r$      'provider', v_connection.provider,
      'provider_sender_id', v_connection.provider_sender_id,
      'provider_account_id', v_connection.provider_account_id,
      'phone_number_id', v_connection.phone_number_id,
      'waba_id', v_connection.waba_id,$r$, e'\r', '');
begin
  for v_case in
    select * from (values
      ('public.claim_whatsapp_order_message(uuid,text)'),
      ('public.begin_whatsapp_reminder_send(uuid)')
    ) targets(signature)
  loop
    select replace(pg_get_functiondef(proc.oid), e'\r', '') into v_definition
    from pg_catalog.pg_proc proc
    where proc.oid = to_regprocedure(v_case.signature);
    if v_definition is null then
      raise exception '0191: % is absent -- refusing to proceed', v_case.signature;
    end if;
    if (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor) <> 1 then
      raise exception '0191: % connection-block anchor moved -- refusing to patch blindly',
        v_case.signature;
    end if;
    execute replace(v_definition, v_anchor, v_replacement);
  end loop;
end
$patch_send_claims$;

comment on function record_whatsapp_message_status(text, text, whatsapp_message_status, timestamptz) is
  'Applies one observed provider status monotonically. Its first two arguments keep their '
  'historical names but are now the provider-neutral routing key and message id; a meta_cloud '
  'connection satisfies both by mirroring, so no 0028/0029 caller changed.';

-- The masked sender an owner is shown. Never the credential, never the Vault reference.
create function private.mask_whatsapp_sender(p_value text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select case
    when nullif(trim(coalesce(p_value, '')), '') is null then null
    when length(regexp_replace(p_value, '[^0-9]', '', 'g')) < 4 then repeat('•', 4)
    else repeat('•', 4) || right(regexp_replace(p_value, '[^0-9]', '', 'g'), 4)
  end
$$;

revoke all on function private.mask_whatsapp_sender(text)
  from public, anon, authenticated, service_role;

do $patch_status_reader$
declare
  v_definition text;
  v_anchor text;
  v_replacement text;
begin
  select replace(pg_get_functiondef(proc.oid), e'\r', '') into v_definition
  from pg_catalog.pg_proc proc
  where proc.oid = to_regprocedure('public.get_whatsapp_connection_status()');
  if v_definition is null then
    raise exception '0191: get_whatsapp_connection_status is absent -- refusing to proceed';
  end if;
  v_anchor := replace($a$    'configured_at', v_connection.configured_at,$a$, e'\r', '');
  v_replacement := replace($r$    'provider', v_connection.provider,
    'masked_sender', private.mask_whatsapp_sender(v_connection.display_phone_number),
    'credential_configured', v_connection.token_secret_id is not null,
    'configured_at', v_connection.configured_at,$r$, e'\r', '');
  if (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception '0191: connection-status result anchor moved -- refusing to patch blindly';
  end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_status_reader$;

-- ===== 5. Provider-neutral service reads and callbacks =====
-- The delivery worker resolves a tenant by the routing key the provider actually sends.
create function service_get_whatsapp_provider_connection(
  p_provider text,
  p_provider_sender_id text
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, vault
as $$
declare
  v_connection whatsapp_connections;
  v_credential text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_provider is null or nullif(trim(p_provider_sender_id), '') is null then
    raise exception 'whatsapp_connection_lookup_invalid' using errcode = '22023';
  end if;

  select * into v_connection from whatsapp_connections
  where provider = p_provider and provider_sender_id = trim(p_provider_sender_id);
  if not found then
    raise exception 'whatsapp_connection_unknown' using errcode = 'P0002';
  end if;

  select decrypted_secret into v_credential
  from vault.decrypted_secrets where id = v_connection.token_secret_id;
  if v_credential is null then
    raise exception 'whatsapp_credential_unknown' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'org_id', v_connection.org_id,
    'provider', v_connection.provider,
    'provider_account_id', v_connection.provider_account_id,
    'provider_sender_id', v_connection.provider_sender_id,
    'display_phone_number', v_connection.display_phone_number,
    'status', v_connection.status,
    'order_template_name', v_connection.order_template_name,
    'reminder_template_name', v_connection.reminder_template_name,
    'language_code', v_connection.language_code,
    'credential', v_credential
  );
end
$$;

revoke all on function service_get_whatsapp_provider_connection(text, text)
  from public, anon, authenticated;
grant execute on function service_get_whatsapp_provider_connection(text, text) to service_role;

-- One door for every provider callback. Inbound is refused by name (#241): at launch the
-- channel is outbound plus delivery evidence only, and an inbound event is neither stored nor
-- answered as handled. A future inbound capability requires a NEW owner decision, not a hook.
create function service_process_whatsapp_provider_event(
  p_provider text,
  p_provider_sender_id text,
  p_event_id text,
  p_event_kind text,
  p_provider_message_id text,
  p_status whatsapp_message_status,
  p_error_code text,
  p_error_message text,
  p_event_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_connection whatsapp_connections;
  v_event whatsapp_webhook_events;
  v_event_id text := nullif(trim(p_event_id), '');
  v_message_id text := nullif(trim(p_provider_message_id), '');
  v_inserted integer;
  v_result jsonb;
  v_target uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_provider is null or nullif(trim(p_provider_sender_id), '') is null
     or v_event_id is null or v_message_id is null then
    raise exception 'whatsapp_webhook_event_invalid' using errcode = '22023';
  end if;
  -- The allowlist. Anything that is not a delivery status is inbound content or an unknown
  -- event class: refused here, before a row exists, so nothing can render as handled.
  if p_event_kind is distinct from 'delivery_status' then
    raise exception 'whatsapp_inbound_unsupported' using errcode = '0A000';
  end if;
  if p_status is null
     or p_status not in ('accepted', 'sent', 'delivered', 'read', 'failed') then
    raise exception 'whatsapp_status_invalid' using errcode = '22023';
  end if;

  select * into v_connection from whatsapp_connections
  where provider = p_provider and provider_sender_id = trim(p_provider_sender_id);
  if not found then
    raise exception 'whatsapp_connection_unknown' using errcode = 'P0002';
  end if;

  insert into whatsapp_webhook_events (
    org_id, provider, provider_sender_id, phone_number_id, event_id, event_type,
    provider_message_id
  ) values (
    v_connection.org_id, p_provider, trim(p_provider_sender_id),
    case when p_provider = 'meta_cloud' then trim(p_provider_sender_id) else null end,
    v_event_id, 'status.' || p_status::text, v_message_id
  ) on conflict (provider, provider_sender_id, event_id) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    select * into v_event from whatsapp_webhook_events
    where provider = p_provider and provider_sender_id = trim(p_provider_sender_id)
      and event_id = v_event_id
    for update;
    if v_event.org_id <> v_connection.org_id
       or v_event.provider_message_id is distinct from v_message_id then
      raise exception 'whatsapp_webhook_event_conflict' using errcode = 'P0001';
    end if;
    if v_event.processed_at is not null then
      -- A replayed provider event is a no-op, answered from the ledger.
      return jsonb_build_object(
        'processed', false, 'duplicate', true, 'event_id', v_event_id,
        'result', v_event.result
      );
    end if;
  end if;

  select id into v_target from whatsapp_order_messages
  where org_id = v_connection.org_id and provider = p_provider
    and provider_message_id = v_message_id;
  if v_target is null then
    -- An identifier we never issued settles nothing and creates nothing.
    v_result := jsonb_build_object('state', 'unknown_message');
  else
    v_result := record_whatsapp_message_status(
      trim(p_provider_sender_id), v_message_id, p_status, p_event_at);
    if p_status = 'failed' then
      update whatsapp_order_messages
      set error_code = left(
            coalesce(nullif(lower(trim(coalesce(p_error_code, ''))), ''), 'provider_failed'), 100),
          error_message = left(coalesce(nullif(trim(coalesce(p_error_message, '')), ''),
            'ספק ההודעות דיווח על כשל מסירה'), 500)
      where id = v_target and status = 'failed';
    end if;
  end if;

  update whatsapp_webhook_events
  set processed_at = now(), result = v_result
  where provider = p_provider and provider_sender_id = trim(p_provider_sender_id)
    and event_id = v_event_id;

  return jsonb_build_object(
    'processed', true, 'duplicate', false, 'event_id', v_event_id, 'result', v_result
  );
end
$$;

revoke all on function service_process_whatsapp_provider_event(
  text, text, text, text, text, whatsapp_message_status, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function service_process_whatsapp_provider_event(
  text, text, text, text, text, whatsapp_message_status, text, text, timestamptz
) to service_role;

-- ===== 6. Per-organization onboarding, owner-only, stepped up, reasoned =====
-- #240: every organization connects its OWN sender; there is no central InPlace number. The
-- credential goes straight to Vault and is never returned, never audited and never readable by
-- a browser role. The role check lives HERE, on the server; the component's check is comfort.
create function configure_whatsapp_provider_connection(
  p_provider text,
  p_provider_account_id text,
  p_provider_sender_id text,
  p_display_number text,
  p_credential text,
  p_order_template_name text,
  p_reminder_template_name text,
  p_language_code text,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_account text := nullif(trim(coalesce(p_provider_account_id, '')), '');
  v_sender text := nullif(trim(coalesce(p_provider_sender_id, '')), '');
  v_display text := nullif(trim(coalesce(p_display_number, '')), '');
  v_language text := nullif(trim(coalesce(p_language_code, '')), '');
  v_order_template text := nullif(trim(coalesce(p_order_template_name, '')), '');
  v_reminder_template text := nullif(trim(coalesce(p_reminder_template_name, '')), '');
  v_existing whatsapp_connections;
  v_connection whatsapp_connections;
  v_secret_id uuid;
begin
  if v_org is null or v_actor is null or auth_role() <> 'owner' then
    raise exception 'whatsapp_not_authorized' using errcode = '42501';
  end if;
  perform assert_recent_password_authentication();
  if v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if p_provider is null or p_provider not in ('meta_cloud', 'twilio')
     or v_account is null or v_sender is null or v_display is null
     or v_language is null or v_order_template is null or v_reminder_template is null then
    raise exception 'whatsapp_connection_invalid' using errcode = '22023';
  end if;
  if p_credential is null or char_length(p_credential) not between 8 and 512 then
    raise exception 'whatsapp_credential_invalid' using errcode = '22023';
  end if;

  select * into v_existing from whatsapp_connections where org_id = v_org for update;
  if found then
    perform vault.update_secret(v_existing.token_secret_id, p_credential);
    v_secret_id := v_existing.token_secret_id;
  else
    v_secret_id := vault.create_secret(
      p_credential,
      'whatsapp_provider_credential_' || v_org::text,
      'Per-organization WhatsApp provider credential (0191).');
  end if;

  insert into whatsapp_connections (
    org_id, provider, provider_account_id, provider_sender_id,
    phone_number_id, waba_id, display_phone_number, token_secret_id, status,
    order_template_name, reminder_template_name, language_code
  ) values (
    v_org, p_provider, v_account, v_sender,
    case when p_provider = 'meta_cloud' then v_sender else null end,
    case when p_provider = 'meta_cloud' then v_account else null end,
    v_display, v_secret_id, 'pending',
    v_order_template, v_reminder_template, v_language
  )
  on conflict (org_id) do update set
    provider = excluded.provider,
    provider_account_id = excluded.provider_account_id,
    provider_sender_id = excluded.provider_sender_id,
    phone_number_id = excluded.phone_number_id,
    waba_id = excluded.waba_id,
    display_phone_number = excluded.display_phone_number,
    token_secret_id = excluded.token_secret_id,
    status = 'pending',
    order_template_name = excluded.order_template_name,
    reminder_template_name = excluded.reminder_template_name,
    language_code = excluded.language_code,
    configured_at = now()
  returning * into v_connection;

  -- The audit records WHAT was configured, never the credential and never its Vault reference.
  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_actor, 'whatsapp_provider_connection_configured', 'whatsapp_connections', v_org,
    case when v_existing.org_id is null then null else jsonb_build_object(
      'provider', v_existing.provider, 'status', v_existing.status,
      'masked_sender', private.mask_whatsapp_sender(v_existing.display_phone_number)) end,
    jsonb_build_object(
      'provider', v_connection.provider, 'status', v_connection.status,
      'masked_sender', private.mask_whatsapp_sender(v_connection.display_phone_number),
      'order_template_name', v_connection.order_template_name,
      'reminder_template_name', v_connection.reminder_template_name,
      'language_code', v_connection.language_code,
      'credential_rotated', true),
    v_reason
  );

  return jsonb_build_object(
    'configured', true,
    'provider', v_connection.provider,
    'status', v_connection.status,
    'masked_sender', private.mask_whatsapp_sender(v_connection.display_phone_number),
    'credential_configured', true,
    'configured_at', v_connection.configured_at
  );
end
$$;

revoke all on function configure_whatsapp_provider_connection(
  text, text, text, text, text, text, text, text, text
) from public, anon;
grant execute on function configure_whatsapp_provider_connection(
  text, text, text, text, text, text, text, text, text
) to authenticated;

create function set_whatsapp_provider_connection_enabled(p_enabled boolean, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_connection whatsapp_connections;
  v_old whatsapp_connection_status;
begin
  if v_org is null or v_actor is null or auth_role() <> 'owner' then
    raise exception 'whatsapp_not_authorized' using errcode = '42501';
  end if;
  perform assert_recent_password_authentication();
  if p_enabled is null or v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into v_connection from whatsapp_connections where org_id = v_org for update;
  if not found then
    raise exception 'whatsapp_connection_unknown' using errcode = 'P0002';
  end if;
  v_old := v_connection.status;

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
    v_org, v_actor, 'whatsapp_provider_connection_toggled', 'whatsapp_connections', v_org,
    jsonb_build_object('status', v_old),
    jsonb_build_object('status', v_connection.status),
    v_reason
  );

  return jsonb_build_object(
    'configured', true,
    'provider', v_connection.provider,
    'status', v_connection.status,
    'masked_sender', private.mask_whatsapp_sender(v_connection.display_phone_number)
  );
end
$$;

revoke all on function set_whatsapp_provider_connection_enabled(boolean, text) from public, anon;
grant execute on function set_whatsapp_provider_connection_enabled(boolean, text) to authenticated;

-- Revocation is real: the connection row goes and the Vault credential goes with it. The
-- delivery ledger and the audit trail stay -- history is evidence, not configuration.
create function revoke_whatsapp_provider_connection(p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_connection whatsapp_connections;
begin
  if v_org is null or v_actor is null or auth_role() <> 'owner' then
    raise exception 'whatsapp_not_authorized' using errcode = '42501';
  end if;
  perform assert_recent_password_authentication();
  if v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into v_connection from whatsapp_connections where org_id = v_org for update;
  if not found then
    raise exception 'whatsapp_connection_unknown' using errcode = 'P0002';
  end if;

  delete from whatsapp_connections where org_id = v_org;
  delete from vault.secrets where id = v_connection.token_secret_id;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, reason
  ) values (
    v_org, v_actor, 'whatsapp_provider_connection_revoked', 'whatsapp_connections', v_org,
    jsonb_build_object(
      'provider', v_connection.provider, 'status', v_connection.status,
      'masked_sender', private.mask_whatsapp_sender(v_connection.display_phone_number)),
    v_reason
  );

  return jsonb_build_object('configured', false, 'status', null);
end
$$;

revoke all on function revoke_whatsapp_provider_connection(text) from public, anon;
grant execute on function revoke_whatsapp_provider_connection(text) to authenticated;

-- ===== 7. Registries =====
update private.tenant_export_registry registry
set exported_columns = case when registry.disposition = 'exclude' then '{}'::text[] else (
      select array_agg(column_info.column_name order by column_info.ordinal_position)
      from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = registry.table_name
        and not (column_info.column_name = any(registry.excluded_columns))
    ) end,
    schema_hash = (
      select md5(string_agg(
        column_info.column_name || ':' || column_info.data_type || ':' || column_info.is_nullable,
        '|' order by column_info.ordinal_position
      ))
      from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = registry.table_name
    )
where registry.table_name in (
  'whatsapp_connections', 'whatsapp_order_messages', 'whatsapp_webhook_events');

-- ===== Re-assert A1 / A3 / A5 (the 0058:207-218 idiom; required of every post-0057 file) =====
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0191 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
