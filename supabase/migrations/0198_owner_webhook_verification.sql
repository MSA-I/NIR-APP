-- 0198 -- Owner-configurable webhooks: registration, the verification handshake, and the
-- state-machine property that makes activation unreachable without one (#98 / #253).
--
-- What already exists and is NOT re-implemented here: the outbox (0064), at-least-once
-- delivery with backoff / dead-letter / reasoned replay (#90), the outbound dedup key (#91),
-- DB-side HMAC signing with the subscription's Vault secret (#97, 0066), the offboarding
-- egress fence on the claim (0103), and the owner step-up on activation (0066:287, #85).
-- This file adds the missing half of #253: a way for the OWNER to register an endpoint at all,
-- and a proof that the endpoint is theirs before their tenant's business events start flowing
-- to it.
--
-- The threat this file exists for is uncomfortable: the attacker is the paying customer. A
-- registered endpoint is an authenticated request issued from our network to an address the
-- customer chose, retried on a schedule, with the outcome reported back to them. So:
--
--   * private.webhook_url_rejection refuses every ADDRESS LITERAL encoding at registration
--     time -- dotted quad, single decimal, octal, hex, mixed inet_aton, bracketed IPv6 -- plus
--     the names that are loopback or private by convention. It cannot close DNS rebinding and
--     does not pretend to: `127.0.0.1.nip.io` is a syntactically ordinary hostname. That case
--     is closed at CONNECT time, in supabase/functions/webhook-verify/ssrf.ts, which resolves
--     once and dials the validated ADDRESS with the name carried only as SNI.
--   * activation is gated by a table CHECK, not by command ordering: `active` cannot be true
--     unless verified_at is set AND verified_url still equals the row's url. Change the url and
--     the trigger below clears the verification, so the constraint refuses the row.
--   * the signing secret is written INTO Vault by the command and never read back out. The
--     owner reader returns no secret, no vault reference and no raw error text (#98, #99).
--
-- Invented guardrails, documented as such (the #90 / #96 / #97 precedent -- these are NOT
-- business rules and belong in OPEN-DECISIONS if they are to be relied on):
--   * a verification attempt is live for 15 minutes;
--   * a signing secret is 32..200 characters.
--
-- A5 note for every definer body in this file: none of the six enforced table names appears in
-- any function body, comments included -- the 0063/0066 discipline.

-- ===== 1. The verification state on the subscription row =====
-- Two columns only, and both are safe to export: the challenge itself never lands here (it
-- lives, hashed, in the private ledger below), so the tenant-export registry keeps its
-- "no secret material" property without a new exclusion.
alter table public.webhook_subscriptions
  add column verified_at timestamptz,
  add column verified_url text;

-- D5, structural. Not "the command checks first" -- the ROW cannot hold this combination.
-- Any writer, including a future service-role path or a hand-run UPDATE, hits this.
alter table public.webhook_subscriptions
  add constraint webhook_subscriptions_active_requires_verification
  check (
    not active
    or (verified_at is not null and verified_url is not distinct from url)
  );

comment on column public.webhook_subscriptions.verified_at is
  'When the endpoint last proved control by echoing a server-issued challenge. Cleared '
  'automatically whenever url changes.';
comment on column public.webhook_subscriptions.verified_url is
  'The exact url that was verified. The active-requires-verification CHECK compares it to '
  'url, so re-pointing a live subscription is refused rather than silently trusted.';

-- Changing the endpoint revokes the proof, in the same statement that changes it. Without
-- this, an owner could verify a benign URL and then edit the row to an internal one.
create function private.webhook_clear_verification_on_url_change()
returns trigger
language plpgsql
as $$
begin
  if new.url is distinct from old.url then
    new.verified_at := null;
    new.verified_url := null;
  end if;
  return new;
end
$$;
revoke all on function private.webhook_clear_verification_on_url_change()
  from public, anon, authenticated, service_role;

-- BEFORE the 0066 touch trigger alphabetically is not something to rely on; both are BEFORE
-- UPDATE row triggers and neither reads the other's field.
create trigger webhook_subscriptions_clear_verification
  before update on public.webhook_subscriptions
  for each row execute function private.webhook_clear_verification_on_url_change();

-- ===== 2. The attempt ledger -- private, so the challenge never reaches a browser or an export
-- The challenge digest is the only thing stored; the raw challenge exists for the duration of
-- one Edge call and is never written down. private schema => outside A1, outside the tenant
-- export registry, outside every browser ACL contract (the 0064 outbox precedent).
create table private.webhook_verification_attempts (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null
    references public.webhook_subscriptions(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  -- Captured at request time. The completion compares it against the row's CURRENT url, so an
  -- endpoint edited mid-handshake fails the handshake instead of inheriting its result.
  url text not null,
  challenge_hash text,
  requested_by uuid,
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null,
  dispatched_at timestamptz,
  completed_at timestamptz,
  outcome text not null default 'pending'
    check (outcome in ('pending', 'verified', 'failed')),
  failure_code text,
  correlation_id uuid default public.request_correlation_id()
);

create index webhook_verification_attempts_subscription_idx
  on private.webhook_verification_attempts (subscription_id, requested_at desc);

revoke all on table private.webhook_verification_attempts
  from public, anon, authenticated;

comment on table private.webhook_verification_attempts is
  'One row per verification handshake of a customer webhook endpoint. Holds the digest of the '
  'server-issued challenge, never the challenge. private schema: the browser never reads it '
  'and it is not part of the tenant export.';

-- ===== 3. The URL validator -- the string layer, in SQL =====
-- Returns NULL when the URL may be registered, or a named rejection code. Deliberately mirrors
-- classifyWebhookUrl in supabase/functions/webhook-verify/ssrf.ts, code for code, so a
-- rejection means the same thing on both sides of the boundary.
--
-- What it CANNOT do, stated rather than implied: it does not resolve names, so a hostname that
-- resolves to a private address passes here. Only the connect-time guard closes that.
create function private.webhook_url_rejection(p_url text)
returns text
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  v_url text := btrim(coalesce(p_url, ''));
  v_rest text;
  v_authority text;
  v_host text;
  v_port text;
  v_labels text[];
  v_last text;
  v_suffix text;
begin
  if v_url = '' or length(v_url) > 2000 then
    return 'webhook_url_invalid';
  end if;
  if v_url !~ '^https://' then
    return 'webhook_url_scheme_rejected';
  end if;

  v_rest := substring(v_url from 9);
  v_authority := split_part(split_part(split_part(v_rest, '/', 1), '?', 1), '#', 1);
  if v_authority = '' then
    return 'webhook_url_invalid';
  end if;
  if position('@' in v_authority) > 0 then
    return 'webhook_url_credentials_rejected';
  end if;
  -- Bracketed or bare IPv6 in the authority: two colons cannot be a host:port pair.
  if position('[' in v_authority) > 0 or position(']' in v_authority) > 0
     or (length(v_authority) - length(replace(v_authority, ':', ''))) > 1 then
    return 'webhook_url_ip_literal_rejected';
  end if;

  if position(':' in v_authority) > 0 then
    v_host := split_part(v_authority, ':', 1);
    v_port := split_part(v_authority, ':', 2);
    if v_port <> '443' then
      return 'webhook_url_port_rejected';
    end if;
  else
    v_host := v_authority;
  end if;

  v_host := lower(btrim(v_host));
  v_host := regexp_replace(v_host, '\.$', '');
  if v_host = '' then
    return 'webhook_url_invalid';
  end if;

  -- Names that are loopback or private by convention, plus the RFC 6761 reserved zones.
  foreach v_suffix in array array[
    'localhost', 'local', 'internal', 'intranet', 'lan', 'corp', 'home',
    'home.arpa', 'in-addr.arpa', 'ip6.arpa', 'arpa', 'test', 'invalid', 'example'
  ] loop
    if v_host = v_suffix or v_host like ('%.' || v_suffix) then
      return 'webhook_url_local_name_rejected';
    end if;
  end loop;

  -- Every address-literal encoding at once: a host whose labels are ALL numeric (decimal,
  -- octal or 0x-hex) is an inet_aton spelling of an address, whatever its shape.
  v_labels := string_to_array(v_host, '.');
  if not exists (
    select 1 from unnest(v_labels) as label
    where label !~ '^([0-9]+|0[xX][0-9a-fA-F]+)$'
  ) then
    return 'webhook_url_ip_literal_rejected';
  end if;

  -- A trailing numeric label is the other half of the same family (`0x7f.1`, `10.0.0.1`):
  -- no registrable top-level name is numeric.
  v_last := v_labels[array_length(v_labels, 1)];
  if v_last ~ '^([0-9]+|0[xX][0-9a-fA-F]+)$' then
    return 'webhook_url_ip_literal_rejected';
  end if;

  if v_host !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' then
    return 'webhook_url_host_not_dns';
  end if;

  return null;
end
$$;
revoke all on function private.webhook_url_rejection(text)
  from public, anon, authenticated, service_role;

comment on function private.webhook_url_rejection(text) is
  'Named rejection code for a candidate webhook URL, or NULL when it may be registered. The '
  'string layer only: it does not resolve names, so DNS rebinding is closed at connect time '
  'in the webhook-verify Edge helper, not here.';

-- ===== 4. Owner registration =====
-- The 0066 configure command is service_role-only, which is why #98 had no screen. This is its
-- owner-facing sibling: same INACTIVE result, same "no secret material in the audit row", plus
-- step-up, a mandatory reason, the SSRF validator, and the offboarding write fence -- a tenant
-- on its way out does not get to open a new outbound stream.
create function public.register_webhook_subscription(
  p_url text,
  p_event_types text[],
  p_secret text,
  p_description text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, vault, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_url text := btrim(coalesce(p_url, ''));
  v_event_types text[] := coalesce(p_event_types, '{}'::text[]);
  v_secret text := coalesce(p_secret, '');
  v_rejection text;
  v_id uuid := gen_random_uuid();
  v_secret_id uuid;
  v_row webhook_subscriptions;
begin
  if v_org is null or v_user is null or auth_role() <> 'owner' then
    raise exception 'webhook_not_authorized' using errcode = '42501';
  end if;
  perform public.assert_recent_password_authentication();
  if not public.organization_write_allowed() then
    raise exception 'webhook_organization_read_only' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'webhook_subscription_invalid' using errcode = '22023';
  end if;

  v_rejection := private.webhook_url_rejection(v_url);
  if v_rejection is not null then
    raise exception '%', v_rejection using errcode = '22023';
  end if;

  if array_position(v_event_types, null) is not null
     or v_event_types && array['']::text[] then
    raise exception 'webhook_event_types_invalid' using errcode = '22023';
  end if;

  -- An invented guardrail, not a business rule: a signing secret shorter than this cannot
  -- carry enough entropy for the HMAC to mean anything (#97 signs with it).
  if length(v_secret) < 32 or length(v_secret) > 200 then
    raise exception 'webhook_secret_invalid' using errcode = '22023';
  end if;

  v_secret_id := vault.create_secret(
    v_secret,
    'webhook-signing-' || v_id::text,
    'Signing secret for webhook subscription ' || v_id::text);

  insert into webhook_subscriptions (id, org_id, url, event_types, secret_id, description)
  values (v_id, v_org, v_url, v_event_types, v_secret_id,
          nullif(btrim(coalesce(p_description, '')), ''))
  returning * into v_row;

  -- No secret, and no vault reference either: the audit row records the DECISION, and a vault
  -- id in a browser-readable log is a pointer worth stealing.
  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_org, v_user, 'webhook_subscription_registered', 'webhook_subscriptions', v_row.id,
    jsonb_build_object(
      'target', v_row.target,
      'url', v_row.url,
      'event_types', to_jsonb(v_row.event_types),
      'active', v_row.active,
      'verified', false),
    v_reason
  );

  perform private.record_security_event(
    v_org, v_user, 'webhook_subscription_registered',
    jsonb_build_object('subscription_id', v_row.id, 'target', v_row.target));

  return jsonb_build_object(
    'id', v_row.id,
    'target', v_row.target,
    'active', v_row.active,
    'created_at', v_row.created_at);
end
$$;
revoke all on function public.register_webhook_subscription(text, text[], text, text, text)
  from public, anon;
grant execute on function public.register_webhook_subscription(text, text[], text, text, text)
  to authenticated;

-- ===== 5. The handshake -- request (owner) / begin + complete (trusted worker) =====
-- Split in three on purpose. The OWNER authorizes the outbound request, with step-up and a
-- reason, and gets back nothing but an opaque one-shot id. The Edge helper, holding
-- service_role, exchanges that id for the signed envelope, performs the guarded request, and
-- reports the outcome. The raw challenge exists only inside that exchange.
create function public.request_webhook_verification(
  p_subscription_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_row webhook_subscriptions;
  v_rejection text;
  v_attempt private.webhook_verification_attempts;
begin
  if v_org is null or v_user is null or auth_role() <> 'owner' then
    raise exception 'webhook_not_authorized' using errcode = '42501';
  end if;
  perform public.assert_recent_password_authentication();
  if not public.organization_write_allowed() then
    raise exception 'webhook_organization_read_only' using errcode = '42501';
  end if;
  if p_subscription_id is null or v_reason is null then
    raise exception 'webhook_subscription_invalid' using errcode = '22023';
  end if;

  select * into v_row from webhook_subscriptions
  where org_id = v_org and id = p_subscription_id
  for update;
  if not found then
    raise exception 'webhook_subscription_unknown' using errcode = 'P0002';
  end if;

  -- Re-validated at request time, not only at registration: the rules may have tightened
  -- since, and this is the moment we are about to put packets on the wire.
  v_rejection := private.webhook_url_rejection(v_row.url);
  if v_rejection is not null then
    raise exception '%', v_rejection using errcode = '22023';
  end if;

  -- One live attempt per subscription: an owner cannot fan out requests to an endpoint.
  update private.webhook_verification_attempts
  set outcome = 'failed',
      failure_code = 'verification_superseded',
      completed_at = now(),
      challenge_hash = null
  where subscription_id = v_row.id and outcome = 'pending';

  insert into private.webhook_verification_attempts
    (subscription_id, org_id, url, requested_by, expires_at)
  values (v_row.id, v_org, v_row.url, v_user, now() + interval '15 minutes')
  returning * into v_attempt;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_org, v_user, 'webhook_verification_requested', 'webhook_subscriptions', v_row.id,
    jsonb_build_object('target', v_row.target, 'url', v_row.url),
    v_reason
  );

  perform private.record_security_event(
    v_org, v_user, 'webhook_verification_requested',
    jsonb_build_object('subscription_id', v_row.id, 'target', v_row.target));

  return jsonb_build_object(
    'verification_id', v_attempt.id,
    'expires_at', v_attempt.expires_at);
end
$$;
revoke all on function public.request_webhook_verification(uuid, text) from public, anon;
grant execute on function public.request_webhook_verification(uuid, text) to authenticated;

-- The DB mints the challenge, stores only its digest, and signs the envelope with the
-- subscription's Vault secret in the EXACT #97 format -- body || '.' || timestamp, HMAC-SHA256,
-- hex -- so the receiver's verification recipe is the one they already have for deliveries.
-- The secret does not leave Postgres here either.
create function public.service_begin_webhook_verification(p_verification_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, vault, extensions, pg_temp
as $$
declare
  v_attempt private.webhook_verification_attempts;
  v_row webhook_subscriptions;
  v_secret text;
  v_challenge text;
  v_body text;
  v_ts text := floor(extract(epoch from now()))::bigint::text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select * into v_attempt from private.webhook_verification_attempts
  where id = p_verification_id
  for update;
  if not found then
    raise exception 'webhook_verification_unknown' using errcode = 'P0002';
  end if;
  if v_attempt.outcome <> 'pending' or v_attempt.completed_at is not null then
    raise exception 'webhook_verification_settled' using errcode = '55000';
  end if;
  if v_attempt.expires_at <= now() then
    raise exception 'webhook_verification_expired' using errcode = '55000';
  end if;
  if v_attempt.dispatched_at is not null then
    raise exception 'webhook_verification_already_dispatched' using errcode = '55000';
  end if;

  select * into v_row from webhook_subscriptions where id = v_attempt.subscription_id;
  if not found or v_row.url is distinct from v_attempt.url then
    raise exception 'webhook_verification_endpoint_changed' using errcode = '55000';
  end if;

  select nullif(ds.decrypted_secret, '') into v_secret
  from vault.decrypted_secrets ds where ds.id = v_row.secret_id;
  if v_secret is null then
    raise exception 'webhook_secret_unresolved' using errcode = 'P0002';
  end if;

  v_challenge := encode(extensions.gen_random_bytes(32), 'hex');
  v_body := jsonb_build_object(
    'type', 'webhook.verification',
    'schema_version', 1,
    'verification_id', v_attempt.id,
    'target', v_row.target,
    'challenge', v_challenge)::text;

  update private.webhook_verification_attempts
  set challenge_hash = encode(extensions.digest(v_challenge, 'sha256'), 'hex'),
      dispatched_at = now()
  where id = v_attempt.id;

  return jsonb_build_object(
    'subscription_id', v_row.id,
    'url', v_row.url,
    'body', v_body,
    'timestamp', v_ts,
    'signature', encode(extensions.hmac(v_body || '.' || v_ts, v_secret, 'sha256'), 'hex'),
    'correlation_id', v_attempt.id);
end
$$;
revoke all on function public.service_begin_webhook_verification(uuid)
  from public, anon, authenticated;
grant execute on function public.service_begin_webhook_verification(uuid) to service_role;

-- The settle. A match stamps verified_at / verified_url on the subscription, which is what the
-- activation CHECK reads. Anything else is a named failure code -- never provider text, which
-- is the #99 scrubbing class and would reach the owner through the failure reader.
create function public.service_complete_webhook_verification(
  p_verification_id uuid,
  p_echo text,
  p_failure_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_attempt private.webhook_verification_attempts;
  v_row webhook_subscriptions;
  v_matched boolean;
  v_code text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select * into v_attempt from private.webhook_verification_attempts
  where id = p_verification_id
  for update;
  if not found then
    raise exception 'webhook_verification_unknown' using errcode = 'P0002';
  end if;
  if v_attempt.outcome <> 'pending' or v_attempt.completed_at is not null then
    return jsonb_build_object('verified', v_attempt.outcome = 'verified', 'idempotent', true);
  end if;

  select * into v_row from webhook_subscriptions
  where id = v_attempt.subscription_id
  for update;

  v_matched :=
    v_attempt.expires_at > now()
    and v_attempt.challenge_hash is not null
    and p_echo is not null
    and encode(extensions.digest(p_echo, 'sha256'), 'hex') = v_attempt.challenge_hash
    and v_row.url is not distinct from v_attempt.url;

  if v_matched then
    update private.webhook_verification_attempts
    set outcome = 'verified', completed_at = now(), challenge_hash = null, failure_code = null
    where id = v_attempt.id;

    update webhook_subscriptions
    set verified_at = now(), verified_url = v_attempt.url
    where id = v_row.id;

    insert into audit_logs (
      org_id, user_id, action, entity_type, entity_id, new_values, reason
    ) values (
      v_attempt.org_id, v_attempt.requested_by, 'webhook_verification_succeeded',
      'webhook_subscriptions', v_row.id,
      jsonb_build_object('target', v_row.target, 'url', v_attempt.url),
      'אימות בעלות על נקודת הקצה הושלם'
    );

    perform private.record_security_event(
      v_attempt.org_id, v_attempt.requested_by, 'webhook_verification_succeeded',
      jsonb_build_object('subscription_id', v_row.id, 'target', v_row.target));

    return jsonb_build_object('verified', true, 'idempotent', false);
  end if;

  v_code := coalesce(
    nullif(btrim(coalesce(p_failure_code, '')), ''),
    case
      when v_attempt.expires_at <= now() then 'webhook_verification_expired'
      when v_row.url is distinct from v_attempt.url then 'webhook_verification_endpoint_changed'
      else 'webhook_verification_challenge_mismatch'
    end);
  -- Code shape is enforced here so a caller cannot smuggle provider prose into the ledger.
  if v_code !~ '^[a-z0-9_]{1,100}$' then
    v_code := 'webhook_verification_failed';
  end if;

  update private.webhook_verification_attempts
  set outcome = 'failed', completed_at = now(), challenge_hash = null, failure_code = v_code
  where id = v_attempt.id;

  perform private.record_integration_failure(
    v_attempt.org_id, 'webhook', v_attempt.subscription_id, v_code, null,
    v_attempt.correlation_id);

  perform private.record_security_event(
    v_attempt.org_id, v_attempt.requested_by, 'webhook_verification_failed',
    jsonb_build_object('subscription_id', v_attempt.subscription_id, 'code', v_code));

  return jsonb_build_object('verified', false, 'code', v_code, 'idempotent', false);
end
$$;
revoke all on function public.service_complete_webhook_verification(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.service_complete_webhook_verification(uuid, text, text)
  to service_role;

-- ===== 6. Activation -- anchored patch of the LIVE body, not a redeclare =====
-- The 0168:44-69 idiom. A verbatim redeclare from 0066 would be safe today only because
-- nothing has patched this function since; asserting the anchor instead makes that a fact the
-- migration checks rather than a fact someone remembered. Two additions, both refusals:
-- activation of an unverified endpoint, and activation while the tenant is read-only for
-- offboarding. Deactivation stays unconditional -- turning a stream OFF must always work.
do $$
declare
  v_def text;
  v_anchor text := $anchor$  v_was := v_row.active;$anchor$;
  v_patched text := $patched$  v_was := v_row.active;

  if p_active and (v_row.verified_at is null
                   or v_row.verified_url is distinct from v_row.url) then
    raise exception 'webhook_verification_required' using errcode = '42501';
  end if;
  if p_active and not public.organization_write_allowed() then
    raise exception 'webhook_organization_read_only' using errcode = '42501';
  end if;$patched$;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.oid = 'public.set_webhook_subscription_active(uuid,boolean,text)'::regprocedure;
  if v_def is null then
    raise exception '0198: set_webhook_subscription_active not found';
  end if;
  if position('assert_recent_password_authentication' in v_def) = 0 then
    raise exception '0198: activation lost its step-up call -- refusing to patch';
  end if;
  if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception '0198: activation anchor moved -- refusing to patch blindly';
  end if;
  execute replace(v_def, v_anchor, v_patched);
end
$$;

-- ===== 7. The owner reader -- masked metadata, health, and nothing else =====
-- Dropped and recreated because the projection grows; the signature (no arguments) and the
-- grant matrix are unchanged, so every existing assertion about them still holds.
--
-- #98, literally: target, active, the event allowlist, the last successful delivery and the
-- pending/failed counts. NOT in the projection, and not by accident: secret_id, any vault
-- reference, private.integration_outbox.last_error, private.integration_deliveries.error, and
-- webhook_verification_attempts.failure_code. The owner learns THAT deliveries are failing and
-- how many; the upstream response body is the #99 scrubbing class and stays server-side.
drop function public.read_webhook_subscriptions();

create function public.read_webhook_subscriptions()
returns table (
  id uuid,
  target text,
  url text,
  event_types text[],
  active boolean,
  description text,
  verification_state text,
  verified_at timestamptz,
  verification_expires_at timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  pending_count bigint,
  failed_attempt_count bigint,
  dead_letter_count bigint,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    w.id,
    w.target,
    w.url,
    w.event_types,
    w.active,
    w.description,
    case
      when w.verified_at is not null and w.verified_url is not distinct from w.url
        then 'verified'
      when live.id is not null then 'pending'
      else 'unverified'
    end,
    case
      when w.verified_url is not distinct from w.url then w.verified_at
      else null
    end,
    live.expires_at,
    health.last_success_at,
    health.last_failure_at,
    coalesce(health.pending_count, 0),
    coalesce(health.failed_attempt_count, 0),
    coalesce(health.dead_letter_count, 0),
    w.created_at,
    w.updated_at
  from webhook_subscriptions w
  left join lateral (
    select a.id, a.expires_at
    from private.webhook_verification_attempts a
    where a.subscription_id = w.id
      and a.outcome = 'pending'
      and a.expires_at > now()
    order by a.requested_at desc
    limit 1
  ) live on true
  left join lateral (
    select
      max(o.delivered_at) filter (where o.status = 'delivered') as last_success_at,
      max(d.last_failed_at) as last_failure_at,
      count(*) filter (where o.status in ('pending', 'claimed')) as pending_count,
      coalesce(sum(d.failed_attempts), 0) as failed_attempt_count,
      count(*) filter (where o.status = 'dead_letter') as dead_letter_count
    from private.integration_outbox o
    left join lateral (
      select count(*) as failed_attempts, max(x.attempted_at) as last_failed_at
      from private.integration_deliveries x
      where x.outbox_id = o.id and x.status = 'failed'
    ) d on true
    where o.target = w.target and o.org_id = w.org_id
  ) health on true
  where w.org_id = auth_org() and auth_role() = 'owner'
  order by w.created_at
$$;
revoke all on function public.read_webhook_subscriptions() from public, anon;
grant execute on function public.read_webhook_subscriptions() to authenticated;

comment on function public.read_webhook_subscriptions() is
  'Owner-only webhook surface (#98): target, url, event allowlist, verification state, last '
  'successful delivery and pending/failed counts. Never secret_id, never a vault reference, '
  'never raw provider error text.';

-- ===== 8. Tenant export registry refresh (A6) =====
-- webhook_subscriptions gained two columns; 0103 stores exported_columns and schema_hash as
-- DERIVED values and asserts them against the live catalogue, so they are recomputed here.
-- The exclusion list is unchanged: neither new column carries secret material.
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
where registry.table_name = 'webhook_subscriptions';

-- ===== 9. Re-assert A1 / A3 / A5 / A6 (the 0058:207-218 idiom) =====
-- No public base table was added (the attempt ledger is private), no enforced table is named in
-- any definer body here, and the export registry was refreshed above.
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0198 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
