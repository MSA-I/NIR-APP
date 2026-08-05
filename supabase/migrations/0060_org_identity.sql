-- Organization identity foundations (wave 4, PLAN-04 §2.2; SECURITY-MODEL §7;
-- OPEN-DECISIONS #87-#88).
--
-- Three server-only tables (Shape-2 -- RLS on, no policies, no browser grants; the
-- user_scope_closure precedent, 0054:220-234) plus the two derived session functions.
-- The auth user UUID is the identity, never an email address: external identity mappings
-- bind (provider, external_subject) to a profile UUID, and everything else keys on that.
--
-- SSO itself does NOT ship in this wave: no Edge Function, no [auth.external.*] config,
-- no UI. What ships is the storage and command surface a later SSO wave plugs into,
-- gated by the 'sso.enabled' flag (0059) for its UI/mounting only -- the RPC permission
-- gates below are flag-free (SECURITY-MODEL §8 law).

-- ===== Identity provider settings =====
-- Shape-2: the row carries secrets (client secrets, SAML certificates), so the browser
-- never reads the table. The owner-gated reader below returns the non-secret projection.
create table identity_provider_settings (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  -- The four providers SECURITY-MODEL §7 names. Storage stays open text (trim-checked)
  -- so a future provider needs no ALTER; the RPC validates against the known set.
  provider      text not null check (trim(provider) <> ''),
  enabled       boolean not null default false,
  -- Non-secret configuration: issuer / tenant id / allowed domains / metadata URL.
  config        jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  -- Secrets. NEVER returned by any reader, never copied into audit rows (key names only).
  secret_config jsonb not null default '{}'::jsonb check (jsonb_typeof(secret_config) = 'object'),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint identity_provider_settings_org_provider_key unique (org_id, provider)
);
alter table identity_provider_settings enable row level security;
revoke all on table identity_provider_settings from public, anon, authenticated;

create trigger identity_provider_settings_touch before update on identity_provider_settings
  for each row execute function set_updated_at();

-- NO generic audit trigger on this table -- a deliberate, load-bearing exception to the
-- "every org_id table gets audit_row_change" duty: the trigger captures the FULL row into
-- audit_logs.old_values/new_values, and audit_logs is browser-readable for
-- owner/office/accountant (audit_select, 0031:208) -- secret_config would leak to the
-- browser through the audit trail. PLAN-04 §2.2 requires the reader/writer to HIDE
-- secrets; the reasoned, secret-redacted audit row written by
-- update_identity_provider_settings (below) is the complete trail, because that command
-- is the only write path (Shape-2 + no browser DML; service_role writes are trusted).

-- ===== External identity mappings =====
-- Shape-2. (provider, external_subject) is globally unique: one external subject maps to
-- exactly one profile across the whole platform. The composite FK makes a cross-tenant
-- mapping structurally impossible -- the mapped user must belong to the mapping's org.
-- Writes arrive only through the service-role SSO callback of a later wave; there is no
-- browser path and no RPC in this wave, deliberately.
create table external_identity_mappings (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null,
  user_id          uuid not null,
  provider         text not null check (trim(provider) <> ''),
  external_subject text not null check (trim(external_subject) <> ''),
  created_at       timestamptz not null default now(),
  constraint external_identity_mappings_subject_key unique (provider, external_subject),
  constraint external_identity_mappings_user_fk foreign key (org_id, user_id)
    references profiles (org_id, id) on delete cascade
);
create index external_identity_mappings_user_idx on external_identity_mappings (org_id, user_id);
alter table external_identity_mappings enable row level security;
revoke all on table external_identity_mappings from public, anon, authenticated;

create trigger external_identity_mappings_audit
  after insert or update or delete on external_identity_mappings
  for each row execute function audit_row_change();

-- ===== Security events =====
-- A forensic log (OPEN-DECISIONS #87): minimal open taxonomy --
--   step_up_success · step_up_failure · permission_change · scope_grant_change ·
--   sso_config_change · org_lifecycle_change
-- event_type stays open text so a later wave can record more without a migration.
-- Shape-2: the browser never reads it (an attacker inspecting their own failed step-up
-- attempts is exactly the reader we refuse). No audit_row_change -- it is itself a log,
-- and auditing the audit would double every sensitive command's write amplification.
-- actor_user_id carries NO foreign key on purpose: the forensic record must survive the
-- profile's deletion; it dies only with the tenant (org cascade).
create table security_events (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  actor_user_id uuid,
  event_type    text not null check (trim(event_type) <> ''),
  details       jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at    timestamptz not null default now()
);
create index security_events_org_created_idx on security_events (org_id, created_at desc);
alter table security_events enable row level security;
revoke all on table security_events from public, anon, authenticated;

-- The internal recorder: called only from SECURITY DEFINER commands (0061 wires the
-- step-up assertion and the piggybacked command events through it). Skips quietly when no
-- organization is in context (platform-operator work without a profile): security_events
-- is tenant-scoped by design and org_id is not null.
create or replace function private.record_security_event(
  p_org uuid,
  p_actor uuid,
  p_event_type text,
  p_details jsonb
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_org is null then
    return;
  end if;
  insert into security_events (org_id, actor_user_id, event_type, details)
  values (p_org, p_actor, p_event_type, coalesce(p_details, '{}'::jsonb));
end
$$;
revoke all on function private.record_security_event(uuid, uuid, text, jsonb)
  from public, anon, authenticated;

-- ===== session_security_level() =====
-- 'password_fresh' | 'standard', derived from the JWT's AMR claim and nothing else --
-- no new state (OPEN-DECISIONS #88). The evaluation is the 0031:788-805 check on all four
-- attributes, converted from raise to return and kept in lockstep with
-- assert_recent_password_authentication (0061), which owns the raising form:
--   1. an `amr` that is not a JSON array fails closed;
--   2. only method='password' entries count;
--   3. max(timestamp) is the reference instant;
--   4. the window is [now - 5 minutes, now + 30 seconds] -- the +30s clock-skew ceiling.
-- SECURITY INVOKER on purpose: it reads only the caller's own JWT GUC, needs no elevated
-- rights, and staying invoker keeps it entirely outside the A5 definer scan.
create or replace function session_security_level() returns text
language plpgsql stable set search_path = public as $$
declare
  v_reauthenticated_at timestamptz;
begin
  if jsonb_typeof(auth.jwt() -> 'amr') <> 'array' then
    return 'standard';
  end if;

  begin
    select max(to_timestamp((entry ->> 'timestamp')::double precision))
      into v_reauthenticated_at
    from jsonb_array_elements(auth.jwt() -> 'amr') entry
    where entry ->> 'method' = 'password';
  exception when others then
    return 'standard';
  end;

  if v_reauthenticated_at is null
     or v_reauthenticated_at < clock_timestamp() - interval '5 minutes'
     or v_reauthenticated_at > clock_timestamp() + interval '30 seconds' then
    return 'standard';
  end if;

  return 'password_fresh';
end
$$;
revoke all on function session_security_level() from public, anon;
grant execute on function session_security_level() to authenticated;

-- ===== The owner-gated reader =====
-- Secrets never leave the server: secret_config is not in the projection. Non-owners get
-- zero rows, never an error (platform_orgs precedent, 0006:152).
create or replace function read_identity_provider_settings()
returns table (id uuid, provider text, enabled boolean, config jsonb, updated_at timestamptz)
language sql stable security definer set search_path = public as $$
  select s.id, s.provider, s.enabled, s.config, s.updated_at
  from identity_provider_settings s
  where s.org_id = auth_org() and auth_role() = 'owner'
  order by s.provider
$$;
revoke all on function read_identity_provider_settings() from public, anon;
grant execute on function read_identity_provider_settings() to authenticated;

-- ===== The only write path =====
-- owner + mandatory reason + audit (secrets redacted to key names) + sso_config_change
-- security event, in one transaction. 0061 redeclares this function to add the step-up
-- assertion at the top ("born with it" -- the assertion itself is a 0061 object, and no
-- user traffic runs between the two migrations).
create or replace function update_identity_provider_settings(
  p_provider text,
  p_enabled boolean,
  p_config jsonb,
  p_secret_config jsonb,
  p_reason text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_reason text := nullif(trim(p_reason), '');
  v_provider text := nullif(trim(p_provider), '');
  v_config jsonb := coalesce(p_config, '{}'::jsonb);
  v_secret jsonb := coalesce(p_secret_config, '{}'::jsonb);
  v_existing identity_provider_settings;
  v_id uuid;
begin
  if v_org is null or v_actor is null or auth_role() <> 'owner' then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'sso_reason_required' using errcode = '22023';
  end if;
  -- The four providers SECURITY-MODEL §7 names; extending the set is a code change on
  -- this one line, not a schema change.
  if v_provider is null
     or v_provider not in ('entra_id', 'okta', 'google_workspace', 'saml') then
    raise exception 'sso_provider_invalid' using errcode = '22023';
  end if;
  if p_enabled is null
     or jsonb_typeof(v_config) <> 'object' or jsonb_typeof(v_secret) <> 'object' then
    raise exception 'sso_config_invalid' using errcode = '22023';
  end if;

  select * into v_existing
  from identity_provider_settings s
  where s.org_id = v_org and s.provider = v_provider
  for update;

  insert into identity_provider_settings (org_id, provider, enabled, config, secret_config)
  values (v_org, v_provider, p_enabled, v_config, v_secret)
  on conflict (org_id, provider)
  do update set enabled = excluded.enabled,
                config = excluded.config,
                secret_config = excluded.secret_config,
                updated_at = now()
  returning id into v_id;

  -- Command-level audit: reasons and non-secret values; secrets appear as key names only.
  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason)
  values (
    v_org, v_actor, 'sso_settings_changed', 'identity_provider_settings', v_id,
    case when v_existing.id is not null then jsonb_build_object(
      'provider', v_existing.provider, 'enabled', v_existing.enabled,
      'config', v_existing.config,
      'secret_keys', (select coalesce(jsonb_agg(k order by k), '[]'::jsonb)
                      from jsonb_object_keys(v_existing.secret_config) k)) end,
    jsonb_build_object(
      'provider', v_provider, 'enabled', p_enabled, 'config', v_config,
      'secret_keys', (select coalesce(jsonb_agg(k order by k), '[]'::jsonb)
                      from jsonb_object_keys(v_secret) k)),
    v_reason
  );

  perform private.record_security_event(
    v_org, v_actor, 'sso_config_change',
    jsonb_build_object('provider', v_provider, 'enabled', p_enabled));

  return v_id;
end
$$;
revoke all on function update_identity_provider_settings(text, boolean, jsonb, jsonb, text)
  from public, anon;
grant execute on function update_identity_provider_settings(text, boolean, jsonb, jsonb, text)
  to authenticated;

-- ===== Registry + re-assertion (wave-3 inherited duties, PLAN-04 §2.4) =====
-- identity tables are org_global (no scope column, ever -- like profiles/invitations);
-- security_events is cross_scope (an event may reference any unit's work; it carries a
-- tenant, never a scope of its own).
insert into private.scope_registry (table_name, scope_class, enforced) values
  ('identity_provider_settings', 'org_global',  false),
  ('external_identity_mappings', 'org_global',  false),
  ('security_events',            'cross_scope', false);

do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0060 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
