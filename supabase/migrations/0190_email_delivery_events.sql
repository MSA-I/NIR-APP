-- 0190 -- What the email provider learned AFTER it accepted the message: a signed, de-duplicated,
-- monotonic delivery-event ledger, and the `delivery_failed` channel state the order screen offers
-- a resend from.
--
-- ==========================================================================================
-- WHAT CHANGES FOR THE BUSINESS. Since 0168 an order becomes `sent` when Resend ACCEPTED the
-- message (#187) -- an observed provider event, not a click. Acceptance is not delivery. A
-- correct address can still be refused hours later by the receiving mail server, and until now
-- that fact had nowhere to land: `delivered` and `bounced` existed in the status vocabulary but
-- nothing could ever write them, so a bounced order looked exactly like a delivered one and the
-- business quietly waited for a supplier who never got the mail.
--
-- This migration gives that knowledge a door. A signed Resend webhook (email-webhook) records
-- each delivery event once, and the channel -- not the order -- moves. #238 decides the shape
-- exactly: when an order email is accepted and then bounced, the ORDER STAYS `sent`; the email
-- channel becomes `delivery_failed` and the screen offers a resend; displaying `delivered` is
-- forbidden. Nothing here touches purchase_orders. The order's lifecycle was already settled by
-- the accepted event, and rewriting it later would mean the business's own record of what it
-- sent changes underneath it.
--
-- WHY THIS SHAPE.
--
-- 1. IDEMPOTENCY IS A CONSTRAINT, NOT A CODE PATH. Svix retries a webhook for hours and Resend
--    reuses no event identifier; `svix-id` is the per-delivery identity. So the ledger carries a
--    UNIQUE (provider, provider_event_id) and the recording function inserts FIRST. A replay
--    collides in the database -- under concurrency, in a crash, in a second Edge isolate -- and
--    not merely in application logic that happened to check.
--
-- 2. LATE AND OUT-OF-ORDER EVENTS CANNOT REGRESS. Webhook deliveries have no ordering guarantee.
--    private.email_delivery_rank() gives the status ladder a total order and the recording
--    function only advances: queued < sending < unknown < failed < accepted < delivered < bounced.
--    `bounced` sits ABOVE `delivered` deliberately -- that is #238's sentence "אסור להציג
--    delivered" turned into arithmetic. A `delivered` arriving after a `bounced` is still stored
--    as evidence, marked applied = false, and changes nothing. The rule lives HERE, in SQL, so no
--    Edge deployment, retry or rollback can hold a different opinion about it.
--
-- 3. THE CHANNEL STATE IS DERIVED, NOT DUPLICATED. email_order_messages.delivery_state is a
--    STORED GENERATED column over `status`. The screen reads the #238 vocabulary directly
--    (`delivery_failed`) while the ledger keeps the provider's own word (`bounced`, `failed`),
--    and the two can never disagree because there is only one stored fact.
--
-- 4. BOUNDED REASON, NO RAW PAYLOAD. Nothing stores the provider's payload -- not in a browser
--    table, not in a private one. What is kept is five bounded fields: a closed reason_code
--    vocabulary, a length-capped reason_message (the same 500 characters 0168:456 already caps a
--    provider error at), the provider's two identifiers and a timestamp. The recording function
--    derives reason_code from the EVENT TYPE rather than trusting the caller's word for it, so a
--    compromised or buggy sender cannot label a bounce as a delivery. An unrecognized bounce
--    classification lands on `bounce_unclassified`: an unknown value must never borrow a
--    stronger or weaker meaning, and must never break ingestion.
--
-- 5. THE RETRY IS THE ONE THAT ALREADY EXISTS. #188 requires that a retry mint a new portal link
--    and kill the previous one immediately. That is claim_email_order_message (0168) delegating
--    to issue_supplier_order_link (0167), and `bounced` already falls through its retry branch --
--    so this migration adds NO second link issuer and NO second authorization path. The retry
--    also nulls provider_message_id, which is why a late event for a superseded attempt can only
--    answer `unmatched`. p72 proves both halves.
--
-- A5 / EXEMPTION PIN: DELIBERATELY UNMOVED. service_record_email_delivery_event runs with no user
-- JWT, like service_settle_email_order_message before it -- but unlike that function it touches no
-- scope-enforced table at all: only email_order_messages (registered `derived`, not enforced), the
-- new event ledger, and audit_logs. private.scope_definer_marker_violations() only considers a
-- definer whose prosrc names an ENFORCED table, so this one is not a candidate and needs no
-- exemption row. The registry stays at 90 and p9_five_domains.sql is NOT edited. That is the whole
-- reason the order lifecycle is left alone here rather than "corrected" on a late bounce: #238
-- already said the order stays `sent`, and honouring it also keeps the A5 hole exactly as wide as
-- it was.
-- ==========================================================================================

-- ===== 1. The status ladder gets a total order =====
-- Plain (non-definer) and immutable: it is arithmetic over a closed vocabulary, and an unknown
-- status answers -1 so it can never out-rank a real one.
create function private.email_delivery_rank(p_status text)
returns integer
language sql
immutable
as $$
  select case p_status
    when 'queued' then 0
    when 'sending' then 1
    when 'unknown' then 2
    when 'failed' then 3
    when 'accepted' then 4
    when 'delivered' then 5
    when 'bounced' then 6
    else -1
  end
$$;
revoke all on function private.email_delivery_rank(text) from public, anon, authenticated;

-- ===== 2. The channel state the screen reads (#238) =====
-- Generated and stored, so the tenant-visible channel vocabulary is a function of the ledger
-- rather than a second copy of it. `failed` (the send never left) and `bounced` (it left and came
-- back) are different provider facts with the same consequence for the business: the supplier does
-- not have the order, and a resend is the next action.
alter table email_order_messages
  add column delivery_state text
  generated always as (
    case
      when status in ('bounced', 'failed') then 'delivery_failed'
      when status = 'delivered' then 'delivered'
      when status = 'accepted' then 'accepted'
      when status = 'unknown' then 'unknown'
      else 'pending'
    end
  ) stored;

comment on column email_order_messages.delivery_state is
  'Tenant-facing email channel state (#238). delivery_failed covers both a send that never left '
  'and a message the receiving server returned; the order status is never rewritten by either.';

-- A late event must be able to find its message, and exactly one of them. Resend''s email_id is
-- globally unique and 0168 nulls it on every retry, so a partial unique index is both true and
-- load-bearing: it makes "unmatched or exactly one" a structural fact rather than a query habit.
create unique index email_order_messages_provider_message_idx
  on email_order_messages (provider_message_id)
  where provider_message_id is not null;

-- ===== 3. The delivery event ledger =====
create table email_delivery_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  message_id uuid not null references email_order_messages(id),
  provider text not null default 'resend' check (provider in ('resend')),
  -- The provider's per-delivery identifier (Resend sends it as the `svix-id` header).
  provider_event_id text not null check (char_length(provider_event_id) between 1 and 200),
  -- The provider's message identifier (Resend sends it as data.email_id).
  provider_message_id text not null check (char_length(provider_message_id) between 1 and 200),
  event_type text not null check (event_type in (
    'delivered', 'bounced', 'delivery_delayed', 'complained'
  )),
  reason_code text not null check (reason_code in (
    'delivered', 'bounce_permanent', 'bounce_transient', 'bounce_undetermined',
    'bounce_unclassified', 'delivery_delayed', 'complaint'
  )),
  -- Bounded by the database, not only by the caller: the same 500-character cap 0168 applies to a
  -- provider error message. There is no raw-payload column here and no private mirror of one.
  reason_message text check (reason_message is null or char_length(reason_message) <= 500),
  -- Did this event actually advance the channel, or was it recorded as out-of-order evidence?
  applied boolean not null default false,
  occurred_at timestamptz,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- The de-duplication guarantee itself. A replayed delivery collides here.
create unique index email_delivery_events_provider_event_idx
  on email_delivery_events (provider, provider_event_id);
create index email_delivery_events_message_idx
  on email_delivery_events (message_id, received_at desc);
create index email_delivery_events_org_idx on email_delivery_events (org_id, received_at desc);

-- Append-only evidence: an event that could be edited or deleted afterwards is not evidence.
-- There is deliberately no updated_at and no touch trigger -- the recording function decides
-- `applied` before it inserts, so nothing about a stored row is ever revised.
create function private.email_delivery_event_guard()
returns trigger
language plpgsql
as $$
begin
  raise exception 'email_delivery_event_immutable' using errcode = '55000';
end
$$;
revoke all on function private.email_delivery_event_guard() from public, anon, authenticated;

create trigger email_delivery_events_append_only
before update or delete on email_delivery_events
for each row execute function private.email_delivery_event_guard();

alter table email_delivery_events enable row level security;
create policy email_delivery_events_select on email_delivery_events
  for select to authenticated using (org_id = auth_org());
-- Supabase default privileges grant ALL to anon/authenticated by name (0053:99-104); revoke, then
-- grant back only the read. service_role keeps its CRUD: p0_client_dml_acl.sql requires full
-- trusted-server CRUD on every public table, and the append-only trigger is what actually stops
-- a rewrite -- for every role, including the trusted one.
revoke all on table email_delivery_events from public, anon, authenticated;
grant select on email_delivery_events to authenticated;

-- ===== 4. Recording an event (service_role -- the webhook has no user JWT) =====
create function service_record_email_delivery_event(
  p_provider_event_id text,
  p_provider_message_id text,
  p_event_type text,
  p_reason_code text,
  p_reason_message text,
  p_occurred_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_message email_order_messages;
  v_previous text;
  v_target text;
  v_apply boolean;
  v_reason_code text;
  v_reason_message text;
  v_occurred timestamptz;
  v_event_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_provider_event_id, '')), '') is null
     or nullif(trim(coalesce(p_provider_message_id, '')), '') is null
     or p_event_type not in ('delivered', 'bounced', 'delivery_delayed', 'complained') then
    raise exception 'email_delivery_event_invalid' using errcode = '22023';
  end if;

  -- The reason vocabulary is decided HERE from the event type. A caller cannot label a bounce as
  -- a delivery, and an unrecognized bounce classification degrades rather than raising -- a
  -- webhook that 500s is retried for hours, which would be a worse answer than `unclassified`.
  v_reason_code := case p_event_type
    when 'delivered' then 'delivered'
    when 'delivery_delayed' then 'delivery_delayed'
    when 'complained' then 'complaint'
    else case
      when p_reason_code in ('bounce_permanent', 'bounce_transient', 'bounce_undetermined')
        then p_reason_code
      else 'bounce_unclassified'
    end
  end;
  v_reason_message := case when p_event_type = 'bounced'
    then nullif(left(trim(coalesce(p_reason_message, '')), 500), '')
    else null end;
  -- A provider clock ahead of ours must not stamp the future onto tenant evidence.
  v_occurred := least(coalesce(p_occurred_at, statement_timestamp()), statement_timestamp());

  select * into v_message from email_order_messages m
  where m.provider_message_id = trim(p_provider_message_id)
  for update;
  if not found then
    -- An event for a message this deployment never sent, or one whose attempt was superseded by a
    -- retry (0168 nulls provider_message_id when it re-claims). Answered, never invented: no row
    -- is created, so an unknown identifier can never grow a phantom ledger entry.
    return jsonb_build_object('state', 'unmatched');
  end if;

  if v_message.status not in ('accepted', 'delivered', 'bounced') then
    -- Nothing the provider says about a thread that is queued, in flight, frozen or failed can be
    -- trusted to belong to the CURRENT attempt.
    return jsonb_build_object('state', 'not_settled', 'status', v_message.status);
  end if;

  v_previous := v_message.status;
  v_target := case p_event_type
    when 'delivered' then 'delivered'
    when 'bounced' then 'bounced'
    else null
  end;
  -- delivery_delayed and complained are recorded as evidence and move nothing: a delay is not an
  -- outcome, and a spam complaint is not a delivery failure. Neither has a decided business
  -- consequence, and inventing one here would be a silent policy.
  v_apply := v_target is not null
    and private.email_delivery_rank(v_target) > private.email_delivery_rank(v_previous);

  insert into email_delivery_events (
    org_id, message_id, provider, provider_event_id, provider_message_id,
    event_type, reason_code, reason_message, applied, occurred_at
  ) values (
    v_message.org_id, v_message.id, 'resend', trim(p_provider_event_id),
    trim(p_provider_message_id), p_event_type, v_reason_code, v_reason_message,
    coalesce(v_apply, false), v_occurred
  )
  on conflict (provider, provider_event_id) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    -- The unique index refused it: this exact delivery was already recorded. Answer success and
    -- apply nothing -- a replay must be a no-op, not a second transition.
    return jsonb_build_object('state', 'duplicate', 'status', v_message.status,
                              'delivery_state', v_message.delivery_state);
  end if;

  if not coalesce(v_apply, false) then
    -- Stored as evidence, applied = false. A `delivered` that arrives after a `bounced` lands
    -- here, and the screen keeps saying delivery_failed (#238).
    return jsonb_build_object('state', 'stale', 'status', v_message.status,
                              'delivery_state', v_message.delivery_state);
  end if;

  update email_order_messages
  set status = v_target,
      lease_expires_at = null,
      delivered_at = case when v_target = 'delivered' then v_occurred else delivered_at end,
      failed_at = case when v_target = 'bounced' then v_occurred else failed_at end,
      error_code = case when v_target = 'bounced' then v_reason_code else null end,
      error_message = case when v_target = 'bounced' then v_reason_message else null end
  where id = v_message.id
  returning * into v_message;

  insert into audit_logs (org_id, action, entity_type, entity_id, old_values, new_values)
  values (
    v_message.org_id, 'email_order_message_delivery_event', 'email_order_messages', v_message.id,
    jsonb_build_object('status', v_previous),
    jsonb_build_object('status', v_message.status, 'delivery_state', v_message.delivery_state,
                       'event_type', p_event_type, 'reason_code', v_reason_code,
                       'provider_event_id', trim(p_provider_event_id))
  );

  return jsonb_build_object('state', 'applied', 'status', v_message.status,
                            'delivery_state', v_message.delivery_state);
end
$$;
revoke all on function service_record_email_delivery_event(text, text, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function service_record_email_delivery_event(text, text, text, text, text, timestamptz)
  to service_role;

comment on function service_record_email_delivery_event(text, text, text, text, text, timestamptz) is
  'Records one verified provider delivery event exactly once (unique provider event id) and '
  'advances the email channel monotonically. Never advances the order lifecycle: an accepted '
  'order that later bounces stays sent and its channel becomes delivery_failed (#238).';

-- ===== 5. Registries =====
insert into private.scope_registry (table_name, scope_class, enforced) values
  ('email_delivery_events', 'derived', false);

insert into private.tenant_export_registry (table_name, disposition, excluded_columns, rationale) values
  ('email_delivery_events', 'include', '{}',
   'Tenant order-delivery evidence: one bounded row per verified provider event.')
on conflict (table_name) do update set
  disposition = excluded.disposition,
  excluded_columns = excluded.excluded_columns,
  rationale = excluded.rationale;

-- email_order_messages gained a column, so its export fingerprint moves with it (0168:529-546).
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
where registry.table_name in ('email_delivery_events', 'email_order_messages');

-- ===== Re-assert A1 / A3 / A5 (the 0058:207-218 idiom; required of every post-0057 file) =====
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0190 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
