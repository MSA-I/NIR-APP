-- 0168 -- Real supplier order delivery over email: communication preferences, a claim/settle
-- message ledger in the 0028 shape, and the provider event that finally stamps `sent`.
--
-- ==========================================================================================
-- WHAT CHANGES FOR THE BUSINESS. Until now "נשלחה לספק" was a human's word: wa.me opened a
-- window, a person promised the message left (share.ts:60-70). This wave adds the first
-- provider-backed path: an owner/office user presses "שליחה במייל", the email-sender Edge
-- Function claims the send here, mails through Resend, and settles the outcome. The order
-- becomes `sent` ONLY when the provider ACCEPTED the message -- an observed provider event,
-- never the click, and never a browser timer. The manual share flow remains, clearly labeled,
-- as the fallback channel.
--
-- SHAPE. whatsapp_order_messages (0028/0029) already solved this problem's hard parts --
-- claim-with-lease, attempt ceiling, the `unknown` freeze for ambiguous in-flight sends,
-- webhook-upgradable statuses -- so email_order_messages copies that ledger shape rather than
-- inventing a second delivery architecture. The integration_outbox (0064) is NOT reused here
-- on purpose: it fans out domain events to registered webhook subscribers; an order email is a
-- caller-initiated command with per-message provider evidence, the 0028 family.
--
-- THE PORTAL LINK RIDES ALONG. claim delegates to issue_supplier_order_link (0167) -- same
-- caller, same audit, same one-live-link rule -- and hands the raw URL to the Edge Function
-- for the message body only. It is never stored; a retry mints a fresh link and the previous
-- one dies, which is correct because a retry only happens when the previous send FAILED.
--
-- A5 / EXEMPTION PIN: claim_email_order_message reads purchase_orders with a real JWT and
-- self-enforces (assert_unit_in_scope + enforcement pin). service_settle_email_order_message
-- runs with NO user JWT (the sender settles with the service key), so like
-- apply_document_interpretation (0077) it takes an EXEMPTION row -- the registry grows
-- 89 -> 90 and p9_five_domains.sql moves with it, by explicit edit.
-- ==========================================================================================

-- ===== 1. The egress vocabulary learns the new kind =====
-- One new external call class: 'supplier_order_email'. The lease table CHECK and the live
-- reserve function (0132's replacement) both carry the closed list; both are patched by
-- anchored replacement so nothing else about them can drift here (the 0104 idiom).
alter table private.organization_external_egress_leases
  drop constraint organization_external_egress_leases_kind_check;
alter table private.organization_external_egress_leases
  add constraint organization_external_egress_leases_kind_check check (kind in (
    'document_interpretation', 'invitation_email', 'push_notification',
    'integration_webhook', 'document_signed_url', 'whatsapp_reminder',
    'organization_logo_storage', 'assistant', 'supplier_order_email'
  ));

do $$
declare
  v_def text;
  v_anchor text := $anchor$'document_interpretation', 'invitation_email', 'push_notification',
       'integration_webhook', 'document_signed_url', 'whatsapp_reminder',
       'organization_logo_storage', 'assistant'$anchor$;
  v_patched text := $patched$'document_interpretation', 'invitation_email', 'push_notification',
       'integration_webhook', 'document_signed_url', 'whatsapp_reminder',
       'organization_logo_storage', 'assistant', 'supplier_order_email'$patched$;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.oid = 'public.service_reserve_organization_external_egress(uuid,text,uuid,integer)'::regprocedure;
  if v_def is null then
    raise exception '0168: egress reserve function not found';
  end if;
  if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception '0168: egress kind anchor moved -- refusing to patch blindly';
  end if;
  execute replace(v_def, v_anchor, v_patched);
end
$$;

-- ===== 2. Supplier communication preferences =====
-- Fail-closed vocabulary: an unconfigured supplier is 'manual' -- no provider send happens
-- until a human states the channel. Destinations may override the supplier card's contact
-- fields; they are validated and normalized HERE, server-side, not in the form.
create table supplier_communication_preferences (
  org_id uuid not null references organizations(id),
  supplier_id uuid not null,
  channel text not null default 'manual'
    check (channel in ('manual', 'email', 'whatsapp', 'both')),
  locale text not null default 'he' check (locale in ('he', 'en')),
  email_override text check (email_override is null or email_override ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  whatsapp_override text check (whatsapp_override is null or whatsapp_override ~ '^972[0-9]{8,9}$'),
  reminders_allowed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, supplier_id),
  foreign key (org_id, supplier_id) references suppliers (org_id, id)
);

create trigger supplier_communication_preferences_touch
before update on supplier_communication_preferences
for each row execute function public.set_updated_at();

alter table supplier_communication_preferences enable row level security;
create policy supplier_communication_preferences_select on supplier_communication_preferences
  for select to authenticated using (org_id = auth_org());
revoke all on table supplier_communication_preferences from public, anon, authenticated;
grant select on supplier_communication_preferences to authenticated;

create function set_supplier_communication_preferences(
  p_supplier_id uuid,
  p_channel text,
  p_locale text,
  p_email_override text,
  p_whatsapp_override text,
  p_reminders_allowed boolean,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := auth_org();
  v_actor user_role := auth_role();
  v_supplier suppliers;
  v_email text := nullif(lower(trim(coalesce(p_email_override, ''))), '');
  v_whatsapp text;
  v_before supplier_communication_preferences;
begin
  if v_org is null or v_actor not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if p_channel not in ('manual', 'email', 'whatsapp', 'both')
     or p_locale not in ('he', 'en') then
    raise exception 'communication_preferences_invalid' using errcode = '22023';
  end if;
  select * into v_supplier from suppliers s
  where s.id = p_supplier_id and s.org_id = v_org and s.deleted_at is null;
  if not found then
    raise exception 'supplier_unknown' using errcode = 'P0002';
  end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'communication_email_invalid' using errcode = '22023';
  end if;
  -- The whatsapp override normalizes through the same 0029 function every WhatsApp reader
  -- uses; an unparseable number refuses rather than storing a maybe.
  if nullif(trim(coalesce(p_whatsapp_override, '')), '') is not null then
    v_whatsapp := private.normalize_whatsapp_phone(p_whatsapp_override);
    if v_whatsapp is null or v_whatsapp !~ '^972[0-9]{8,9}$' then
      raise exception 'communication_whatsapp_invalid' using errcode = '22023';
    end if;
  end if;
  -- A provider channel with no reachable destination is a misconfiguration stated up front,
  -- not a send-time surprise.
  if p_channel in ('email', 'both')
     and coalesce(v_email, nullif(lower(trim(coalesce(v_supplier.email, ''))), '')) is null then
    raise exception 'communication_email_destination_missing' using errcode = '22023';
  end if;
  if p_channel in ('whatsapp', 'both')
     and coalesce(v_whatsapp,
           private.normalize_whatsapp_phone(coalesce(v_supplier.whatsapp, v_supplier.phone))) is null then
    raise exception 'communication_whatsapp_destination_missing' using errcode = '22023';
  end if;

  select * into v_before from supplier_communication_preferences
  where org_id = v_org and supplier_id = p_supplier_id;

  insert into supplier_communication_preferences as prefs (
    org_id, supplier_id, channel, locale, email_override, whatsapp_override, reminders_allowed
  ) values (
    v_org, p_supplier_id, p_channel, p_locale, v_email, v_whatsapp, coalesce(p_reminders_allowed, false)
  )
  on conflict (org_id, supplier_id) do update set
    channel = excluded.channel,
    locale = excluded.locale,
    email_override = excluded.email_override,
    whatsapp_override = excluded.whatsapp_override,
    reminders_allowed = excluded.reminders_allowed;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason)
  values (
    v_org, auth.uid(), 'supplier_communication_preferences_set', 'suppliers', p_supplier_id,
    case when v_before.supplier_id is null then null else jsonb_build_object(
      'channel', v_before.channel, 'locale', v_before.locale,
      'email_override', v_before.email_override, 'whatsapp_override', v_before.whatsapp_override,
      'reminders_allowed', v_before.reminders_allowed) end,
    jsonb_build_object('channel', p_channel, 'locale', p_locale,
      'email_override', v_email, 'whatsapp_override', v_whatsapp,
      'reminders_allowed', coalesce(p_reminders_allowed, false)),
    p_reason);

  return jsonb_build_object('channel', p_channel, 'locale', p_locale);
end
$$;
revoke all on function set_supplier_communication_preferences(uuid, text, text, text, text, boolean, text)
  from public, anon;
grant execute on function set_supplier_communication_preferences(uuid, text, text, text, text, boolean, text)
  to authenticated;

-- ===== 3. The email message ledger (the 0028 shape) =====
create table email_order_messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  order_id uuid not null references purchase_orders(id),
  supplier_id uuid not null,
  link_id uuid references supplier_order_links(id),
  kind text not null default 'order' check (kind in ('order')),
  status text not null default 'queued' check (status in (
    'queued', 'sending', 'unknown', 'accepted', 'delivered', 'bounced', 'failed'
  )),
  to_email text not null check (to_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  locale text not null check (locale in ('he', 'en')),
  template_name text not null,
  template_version integer not null check (template_version >= 1),
  provider_message_id text,
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  last_attempt_at timestamptz,
  lease_expires_at timestamptz,
  accepted_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  error_code text,
  error_message text,
  correlation_id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, supplier_id) references suppliers (org_id, id)
);

-- One order-send thread per order: retries live on the same row (attempts, statuses), exactly
-- as 0028 keeps one whatsapp thread per (order, kind).
create unique index email_order_messages_order_kind_idx
  on email_order_messages (org_id, order_id, kind);
create index email_order_messages_org_status_idx on email_order_messages (org_id, status);

create trigger email_order_messages_touch
before update on email_order_messages
for each row execute function public.set_updated_at();

alter table email_order_messages enable row level security;
create policy email_order_messages_select on email_order_messages
  for select to authenticated using (org_id = auth_org());
revoke all on table email_order_messages from public, anon, authenticated;
grant select on email_order_messages to authenticated;

-- ===== 4. Claim (authenticated -- the user pressed send) =====
create function claim_email_order_message(p_order_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org uuid := auth_org();
  v_actor user_role := auth_role();
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_order purchase_orders;
  v_supplier suppliers;
  v_prefs supplier_communication_preferences;
  v_to text;
  v_message email_order_messages;
  v_link jsonb;
  v_should_send boolean := false;
begin
  if v_org is null or v_actor not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_order_id is null or v_reason is null then
    raise exception 'email_message_invalid' using errcode = '22023';
  end if;

  select * into v_order from purchase_orders o
  where o.id = p_order_id and o.org_id = v_org
  for update;
  if not found then
    raise exception 'order_unknown' using errcode = 'P0002';
  end if;
  perform assert_unit_in_scope(v_order.unit_id);
  if v_order.status not in ('ready', 'sent') then
    raise exception 'email_order_not_sendable' using errcode = '55000';
  end if;

  select * into v_supplier from suppliers s
  where s.id = v_order.supplier_id and s.org_id = v_org and s.deleted_at is null;
  if not found then
    raise exception 'supplier_unknown' using errcode = 'P0002';
  end if;

  -- The channel gate: nothing is mailed for a supplier whose preferences do not say email.
  select * into v_prefs from supplier_communication_preferences
  where org_id = v_org and supplier_id = v_supplier.id;
  if not found or v_prefs.channel not in ('email', 'both') then
    raise exception 'email_channel_disabled' using errcode = 'P0001';
  end if;
  v_to := coalesce(v_prefs.email_override, nullif(lower(trim(coalesce(v_supplier.email, ''))), ''));
  if v_to is null then
    raise exception 'email_destination_missing' using errcode = 'P0001';
  end if;

  select * into v_message from email_order_messages
  where org_id = v_org and order_id = v_order.id and kind = 'order'
  for update;

  if found then
    if v_message.status in ('accepted', 'delivered') then
      -- Already with the provider (or beyond): answer idempotently, send nothing.
      return jsonb_build_object('message_id', v_message.id, 'state', 'already_sent',
                                'status', v_message.status);
    elsif v_message.status = 'sending' then
      if v_message.lease_expires_at > now() then
        return jsonb_build_object('message_id', v_message.id, 'state', 'in_flight');
      end if;
      -- An expired in-flight lease is ambiguous, not proof of rejection (the 0028 rule):
      -- freeze for reconciliation instead of risking a duplicate supplier email.
      update email_order_messages
      set status = 'unknown', lease_expires_at = null,
          error_code = 'lease_expired',
          error_message = 'לא התקבלה תשובה חד-משמעית מספק המייל'
      where id = v_message.id;
      return jsonb_build_object('message_id', v_message.id, 'state', 'ambiguous');
    elsif v_message.status = 'unknown' then
      return jsonb_build_object('message_id', v_message.id, 'state', 'ambiguous');
    elsif v_message.attempt_count >= 5 then
      raise exception 'email_message_retry_limit' using errcode = 'P0001';
    end if;
  end if;

  -- A fresh portal link rides in every attempt's message body. Delegating keeps one issuing
  -- path: same audit, same one-live-link rule, same pending-proposal refusal (0167).
  v_link := issue_supplier_order_link(v_order.id, v_reason);

  if v_message.id is null then
    insert into email_order_messages (
      org_id, order_id, supplier_id, link_id, kind, status, to_email, locale,
      template_name, template_version, attempt_count, last_attempt_at, lease_expires_at
    ) values (
      v_org, v_order.id, v_supplier.id, (v_link ->> 'link_id')::uuid, 'order', 'sending',
      v_to, v_prefs.locale,
      case when v_order.revision_number > 1 then 'revised_purchase_order' else 'new_purchase_order' end,
      1, 1, now(), now() + interval '5 minutes'
    ) returning * into v_message;
  else
    update email_order_messages
    set status = 'sending',
        link_id = (v_link ->> 'link_id')::uuid,
        to_email = v_to,
        locale = v_prefs.locale,
        attempt_count = attempt_count + 1,
        last_attempt_at = now(),
        lease_expires_at = now() + interval '5 minutes',
        provider_message_id = null,
        failed_at = null,
        error_code = null,
        error_message = null
    where id = v_message.id
    returning * into v_message;
  end if;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, new_values, reason)
  values (v_org, auth.uid(), 'email_order_message_claimed', 'email_order_messages', v_message.id,
          jsonb_build_object('order_id', v_order.id, 'attempt', v_message.attempt_count,
                             'to_domain', split_part(v_to, '@', 2)),
          v_reason);

  return jsonb_build_object(
    'message_id', v_message.id,
    'state', 'claimed',
    'attempt', v_message.attempt_count,
    'to_email', v_to,
    'locale', v_prefs.locale,
    'template_name', v_message.template_name,
    'template_version', v_message.template_version,
    'portal_token', v_link ->> 'token',
    'link_expires_at', v_link ->> 'expires_at',
    'order_snapshot', (select l.order_snapshot from supplier_order_links l
                       where l.id = (v_link ->> 'link_id')::uuid),
    'correlation_id', v_message.correlation_id,
    'org_id', v_org);
end
$$;
revoke all on function claim_email_order_message(uuid, text) from public, anon;
grant execute on function claim_email_order_message(uuid, text) to authenticated;

comment on function claim_email_order_message(uuid, text) is
  'Claims the one email-send thread of an order for a 5-minute lease and mints the portal link '
  'that rides in the body (returned once, never stored). Fail-closed on preferences: suppliers '
  'without an email channel are refused by name. Ambiguous in-flight sends freeze as unknown, '
  'the 0028 rule.';

-- ===== 5. Settle (service_role -- the sender reports the provider outcome) =====
create function service_settle_email_order_message(
  p_message_id uuid,
  p_outcome text,
  p_provider_message_id text,
  p_provider_status integer,
  p_error_code text,
  p_error_message text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_message email_order_messages;
  v_order purchase_orders;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_outcome not in ('accepted', 'failed') then
    raise exception 'email_settlement_invalid' using errcode = '22023';
  end if;

  select * into v_message from email_order_messages m
  where m.id = p_message_id
  for update;
  if not found then
    raise exception 'email_message_unknown' using errcode = 'P0002';
  end if;
  if v_message.status <> 'sending' then
    -- A late settlement of a frozen/settled row is answered, not applied: the freeze exists
    -- precisely because the outcome was ambiguous when the lease died.
    return jsonb_build_object('state', 'not_sending', 'status', v_message.status);
  end if;

  if p_outcome = 'accepted' then
    update email_order_messages
    set status = 'accepted',
        accepted_at = statement_timestamp(),
        provider_message_id = p_provider_message_id,
        lease_expires_at = null
    where id = v_message.id;

    -- THE observed provider event: the message is with the provider, so the order is sent.
    -- Stamped here, in the same transaction as the evidence, never from the browser.
    select * into v_order from purchase_orders o
    where o.id = v_message.order_id
    for update;
    if found and v_order.status in ('draft', 'ready') then
      perform set_config('app.p1_financial_writer', coalesce(auth.uid()::text, ''), true);
      update purchase_orders
      set status = 'sent', sent_at = coalesce(sent_at, statement_timestamp())
      where id = v_order.id;
      insert into audit_logs (org_id, action, entity_type, entity_id, old_values, new_values, reason)
      values (v_message.org_id, 'purchase_order_status_changed', 'purchase_orders', v_order.id,
              jsonb_build_object('status', v_order.status),
              jsonb_build_object('status', 'sent', 'provider_message_id', p_provider_message_id),
              'ההזמנה נמסרה לספק המייל (אירוע ספק שנצפה)');
    end if;

    insert into audit_logs (org_id, action, entity_type, entity_id, new_values)
    values (v_message.org_id, 'email_order_message_accepted', 'email_order_messages', v_message.id,
            jsonb_build_object('provider_message_id', p_provider_message_id,
                               'provider_status', p_provider_status));
    return jsonb_build_object('state', 'accepted');
  end if;

  update email_order_messages
  set status = 'failed',
      failed_at = statement_timestamp(),
      lease_expires_at = null,
      error_code = left(coalesce(p_error_code, 'provider_failed'), 100),
      error_message = left(coalesce(p_error_message, ''), 500)
  where id = v_message.id;

  insert into audit_logs (org_id, action, entity_type, entity_id, new_values)
  values (v_message.org_id, 'email_order_message_failed', 'email_order_messages', v_message.id,
          jsonb_build_object('error_code', p_error_code, 'provider_status', p_provider_status,
                             'attempt', v_message.attempt_count));
  return jsonb_build_object('state', 'failed', 'attempt', v_message.attempt_count);
end
$$;
revoke all on function service_settle_email_order_message(uuid, text, text, integer, text, text)
  from public, anon, authenticated;
grant execute on function service_settle_email_order_message(uuid, text, text, integer, text, text)
  to service_role;

-- ===== 6. Manual dead-letter replay (owner, reasoned) =====
create function reset_email_order_message(p_message_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := auth_org();
  v_actor user_role := auth_role();
  v_message email_order_messages;
begin
  if v_org is null or v_actor <> 'owner' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  select * into v_message from email_order_messages m
  where m.id = p_message_id and m.org_id = v_org
  for update;
  if not found then
    raise exception 'email_message_unknown' using errcode = 'P0002';
  end if;
  if v_message.status not in ('failed', 'unknown') then
    raise exception 'email_message_not_resettable' using errcode = '55000';
  end if;

  update email_order_messages
  set status = 'queued', attempt_count = 0, lease_expires_at = null,
      failed_at = null, error_code = null, error_message = null
  where id = v_message.id;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, old_values, reason)
  values (v_org, auth.uid(), 'email_order_message_reset', 'email_order_messages', v_message.id,
          jsonb_build_object('status', v_message.status, 'attempts', v_message.attempt_count,
                             'error_code', v_message.error_code),
          p_reason);
end
$$;
revoke all on function reset_email_order_message(uuid, text) from public, anon;
grant execute on function reset_email_order_message(uuid, text) to authenticated;

-- ===== 7. Registries =====
insert into private.scope_registry (table_name, scope_class, enforced) values
  ('supplier_communication_preferences', 'org_global', false),
  ('email_order_messages', 'derived', false);

insert into private.tenant_export_registry (table_name, disposition, excluded_columns, rationale) values
  ('supplier_communication_preferences', 'include', '{}',
   'Tenant-stated supplier communication channels, locales and destinations.'),
  ('email_order_messages', 'include', '{}',
   'Tenant order-delivery evidence: statuses, attempts and provider message identifiers.')
on conflict (table_name) do update set
  disposition = excluded.disposition,
  excluded_columns = excluded.excluded_columns,
  rationale = excluded.rationale;

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
where registry.table_name in ('supplier_communication_preferences', 'email_order_messages');

-- A5: the claim self-enforces; the settle runs with no user JWT and takes an exemption, the
-- 0077 precedent. The exemption pin moves 89 -> 90 and p9_five_domains.sql is edited with it.
insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
)
select reviewed.signature, md5(replace(proc.prosrc, e'\r', '')), reviewed.kind, reviewed.proof
from (values
  ('claim_email_order_message(uuid,text)', 'assert_unit',
    '0168 locks the tenant order and asserts its branch unit before claiming the email send.')
) reviewed(signature, kind, proof)
join pg_catalog.pg_proc proc on proc.oid = pg_catalog.to_regprocedure(reviewed.signature)
on conflict (function_signature) do update
set body_hash = excluded.body_hash, enforcement_kind = excluded.enforcement_kind,
    scope_proof = excluded.scope_proof;

insert into private.scope_definer_exemptions (function_signature, reason, target_wave) values
  ('service_settle_email_order_message(uuid,text,text,integer,text,text)'::regprocedure::text,
   'service-role-trusted-path', '0168 email order delivery');

-- ===== Re-assert A1 / A3 / A5 (the 0058:207-218 idiom; required of every post-0057 file) =====
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0168 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
