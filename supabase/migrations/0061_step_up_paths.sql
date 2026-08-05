-- Step-up authentication on the five sensitive paths (wave 4, PLAN-04 §2.3;
-- SECURITY-MODEL §6; OPEN-DECISIONS #85).
--
-- The mechanism already existed exactly once -- inline in
-- execute_emergency_payment_request (0031:788-805). This migration extracts it verbatim
-- into ONE named assertion and wires it, server-side and unconditionally (never behind a
-- flag -- §8 forbids a flag evaluator inside an RPC), into:
--
--   1. payment execution          -- execute_payment_request (live decl: 0031:506) and the
--                                    owner emergency wrapper (0031:760, refactored to
--                                    delegate -- no second copy of the check)
--   2. suppliers.bank_details     -- new update_supplier_bank_details + column-grant
--                                    revocation (0036:67-71 loses bank_details)
--   3. another user's permissions -- manage_profile_access (live decl: 0020:59) and
--                                    grant_user_scope / revoke_user_scope (0054:364/404)
--   4. SSO settings               -- update_identity_provider_settings (born in 0060,
--                                    rewired here the moment the assertion exists)
--   5. sensitive financial export -- mark_month_export_sent. DETERMINATION (PLAN-04
--                                    §2.3): "sensitive financial export" is the monthly
--                                    export to the accountant; record_document_export is
--                                    NOT wired -- that ledger is already immutable and
--                                    process-approved.
--
-- The four attributes of the check survive by extraction, not re-invention:
-- typeof-array fail-closed · method='password' only · max(timestamp) · the +30s
-- clock-skew ceiling. The error stays byte-identical -- 'fresh_authentication_required',
-- SQLSTATE 42501 -- because three gate assertions in p1_financial_commands.sql:1186-1242
-- pin it.
--
-- Exemption registry: ZERO new rows. execute_payment_request and mark_month_export_sent
-- keep their 0057 rows (CREATE OR REPLACE preserves the oid the row is keyed on); the
-- emergency wrapper keeps its delegating-wrapper row; everything newly written here
-- touches no enforced table.

-- ===== 1. The named assertion =====
-- The evaluation itself lives in two lockstep forms: session_security_level() (0060,
-- side-effect-free, for the client's skip-when-fresh decision) and this raising form,
-- which also records the forensic security event. auth.uid() IS NULL passes through --
-- trusted service/seed/migration work, the same early-out as assert_unit_in_scope
-- (0054:337); every wired command has already rejected a null actor by the time this
-- runs, so the early-out never weakens a browser path.
--
-- Recording semantics, stated honestly: the step_up_failure row is inserted BEFORE the
-- raise, so it persists only when a caller traps the error without aborting the
-- surrounding transaction; through PostgREST the transaction rolls back and the failure
-- row is lost with it. Postgres has no autonomous transactions; this is the closest
-- honest implementation of "record success/failure" (PLAN-04 §2.3) without inventing
-- infrastructure. Every successful assertion records one step_up_success row -- the
-- emergency path therefore records two per execution (wrapper + delegate), which is
-- forensically accurate: two gates were passed.
create or replace function assert_recent_password_authentication() returns void
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid();
  v_org uuid := auth_org();
  v_reauthenticated_at timestamptz;
begin
  if v_actor is null then
    return;
  end if;

  -- ===== verbatim 0031:788-805 from here =====
  if jsonb_typeof(auth.jwt() -> 'amr') <> 'array' then
    perform private.record_security_event(
      v_org, v_actor, 'step_up_failure', jsonb_build_object('cause', 'amr_shape'));
    raise exception 'fresh_authentication_required' using errcode = '42501';
  end if;

  begin
    select max(to_timestamp((entry ->> 'timestamp')::double precision))
      into v_reauthenticated_at
    from jsonb_array_elements(auth.jwt() -> 'amr') entry
    where entry ->> 'method' = 'password';
  exception when others then
    perform private.record_security_event(
      v_org, v_actor, 'step_up_failure', jsonb_build_object('cause', 'amr_parse'));
    raise exception 'fresh_authentication_required' using errcode = '42501';
  end;

  if v_reauthenticated_at is null
     or v_reauthenticated_at < clock_timestamp() - interval '5 minutes'
     or v_reauthenticated_at > clock_timestamp() + interval '30 seconds' then
    perform private.record_security_event(
      v_org, v_actor, 'step_up_failure',
      jsonb_build_object('cause', 'amr_stale', 'password_at', v_reauthenticated_at));
    raise exception 'fresh_authentication_required' using errcode = '42501';
  end if;
  -- ===== verbatim 0031:788-805 to here =====

  perform private.record_security_event(v_org, v_actor, 'step_up_success', '{}'::jsonb);
end
$$;
revoke all on function assert_recent_password_authentication()
  from public, anon, authenticated;

-- ===== 2. Path 1a -- execute_payment_request (dynamic injection) =====
-- The live declaration is 0031:506 (NOT 0023:232 -- redeclaring from there would revert
-- the emergency-GUC handshake). Rather than transcribing ~250 lines and risking a silent
-- drift, the assertion is injected into the LIVE definition with position asserts --
-- 0031:1196's own persona_role_rewrite idiom, which fails the reset closed on any
-- ancestry mismatch. Placement: immediately after the authorization gate, so an
-- unauthorized caller still receives its authorization error (the
-- p1_financial_commands.sql:1172-1184 owner assertion pins exactly that ordering), while
-- no authorized execution can proceed without fresh password proof.
--
-- ===== Path 5 -- mark_month_export_sent (dynamic injection) =====
-- Its latest TEXTUAL declaration is 0023:2475, but 0031:1196-1240 rewrote the live body
-- in place: the role gate became ('owner', 'accountant') and an approved-only invoice
-- guard was injected. A verbatim redeclare from 0023 would silently revert BOTH -- an
-- ACL revert and a financial-correctness revert. Injection into the live definition is
-- therefore the only safe wiring; the ancestry asserts below fail the reset if the 0031
-- rewrite is ever not present.
do $step_up_wiring$
declare
  v_signature regprocedure;
  v_definition text;
  v_eol text;
  v_anchor text;
  v_occurrences int;
begin
  -- --- execute_payment_request ---
  v_signature := 'public.execute_payment_request(uuid,date,text,text,text,jsonb,text)'::regprocedure;
  select pg_get_functiondef(v_signature::oid) into v_definition;
  if position('assert_recent_password_authentication' in v_definition) > 0 then
    raise exception 'step_up_wiring_already_applied: %', v_signature;
  end if;
  v_eol := case when position(E'\r\n' in v_definition) > 0 then E'\r\n' else E'\n' end;
  v_anchor := '    raise exception ''payment_request_not_executable'' using errcode = ''42501'';'
    || v_eol || '  end if;';
  v_occurrences := (length(v_definition) - length(replace(v_definition, v_anchor, '')))
    / length(v_anchor);
  if v_occurrences <> 1 then
    raise exception 'step_up_wiring_source_mismatch: % (gate anchor found % times)',
      v_signature, v_occurrences;
  end if;
  execute replace(
    v_definition, v_anchor,
    v_anchor || v_eol || '  perform public.assert_recent_password_authentication();');

  -- --- mark_month_export_sent ---
  v_signature := 'public.mark_month_export_sent(date,uuid[],text)'::regprocedure;
  select pg_get_functiondef(v_signature::oid) into v_definition;
  if position('assert_recent_password_authentication' in v_definition) > 0 then
    raise exception 'step_up_wiring_already_applied: %', v_signature;
  end if;
  -- Ancestry guards: the 0031 persona rewrite must already be present -- anchoring on the
  -- LIVE text, never on 0023's.
  if position('v_role not in (''owner'', ''accountant'')' in v_definition) = 0
     or position('or (v_role = ''accountant'' and i.review_status <> ''approved'')' in v_definition) = 0 then
    raise exception 'step_up_wiring_source_mismatch: % (0031 persona rewrite not found)',
      v_signature;
  end if;
  v_eol := case when position(E'\r\n' in v_definition) > 0 then E'\r\n' else E'\n' end;
  v_anchor := '    raise exception ''month_export_not_authorized'' using errcode = ''42501'';'
    || v_eol || '  end if;';
  v_occurrences := (length(v_definition) - length(replace(v_definition, v_anchor, '')))
    / length(v_anchor);
  if v_occurrences <> 1 then
    raise exception 'step_up_wiring_source_mismatch: % (gate anchor found % times)',
      v_signature, v_occurrences;
  end if;
  execute replace(
    v_definition, v_anchor,
    v_anchor || v_eol || '  perform public.assert_recent_password_authentication();');

  -- Both injections landed.
  if (select p.prosrc from pg_catalog.pg_proc p
      where p.oid = 'public.execute_payment_request(uuid,date,text,text,text,jsonb,text)'::regprocedure::oid)
      !~ 'assert_recent_password_authentication'
     or (select p.prosrc from pg_catalog.pg_proc p
      where p.oid = 'public.mark_month_export_sent(date,uuid[],text)'::regprocedure::oid)
      !~ 'assert_recent_password_authentication' then
    raise exception 'step_up_wiring_source_mismatch: injection did not land';
  end if;
end
$step_up_wiring$;

-- ===== 3. Path 1b -- the owner emergency wrapper, refactored to delegate =====
-- Redeclared from 0031:760 with ONE change: the inline AMR block (0031:788-805) is
-- replaced by the named assertion -- delegation, not a second copy. Signature unchanged,
-- so its delegating-wrapper exemption row (keyed by oid::regprocedure) stays valid.
create or replace function public.execute_emergency_payment_request(
  p_payment_request_id uuid,
  p_paid_date date,
  p_method text,
  p_reference text,
  p_notes text,
  p_allocations jsonb,
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
  v_role user_role := auth_role();
  v_result jsonb;
begin
  if v_org is null or v_user is null or v_role <> 'owner' then
    raise exception 'owner_emergency_not_authorized' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  perform public.assert_recent_password_authentication();

  perform set_config('app.p0_owner_emergency_payment', v_user::text, true);
  begin
    v_result := public.execute_payment_request(
      p_payment_request_id,
      p_paid_date,
      p_method,
      p_reference,
      p_notes,
      p_allocations,
      p_reason
    );
  exception when others then
    perform set_config('app.p0_owner_emergency_payment', '', true);
    raise;
  end;
  perform set_config('app.p0_owner_emergency_payment', '', true);

  return v_result;
end
$$;

-- ===== 4. Path 3a -- manage_profile_access =====
-- Redeclared from its live declaration (0020:59 -- verified: no later redeclaration or
-- dynamic rewrite touches it). Two additions: the assertion after the owner gate, and the
-- permission_change security event piggybacked on the audit write.
create or replace function manage_profile_access(
  p_profile_id uuid,
  p_role user_role,
  p_active boolean,
  p_supplier_id uuid,
  p_reason text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_target profiles;
  v_reason text := nullif(trim(p_reason), '');
begin
  if v_org is null or v_actor is null or auth_role() <> 'owner' then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  perform public.assert_recent_password_authentication();
  if p_profile_id = v_actor then
    raise exception 'self_access_change_forbidden' using errcode = '42501';
  end if;
  if p_role is null or p_active is null or v_reason is null then
    raise exception 'profile_access_invalid' using errcode = '22023';
  end if;
  if (p_role = 'supplier') is distinct from (p_supplier_id is not null) then
    raise exception 'supplier_profile_requires_supplier' using errcode = '22023';
  end if;
  if p_supplier_id is not null and not exists (
    select 1 from suppliers s where s.id = p_supplier_id and s.org_id = v_org
  ) then
    raise exception 'supplier_outside_organization' using errcode = '23514';
  end if;

  select * into v_target
  from profiles
  where id = p_profile_id and org_id = v_org
  for update;
  if not found then raise exception 'profile_unknown' using errcode = 'P0002'; end if;

  perform set_config('app.profile_access_writer', v_actor::text, true);
  update profiles
  set role = p_role, active = p_active, supplier_id = p_supplier_id
  where id = v_target.id;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_actor, 'profile_access_changed', 'profiles', v_target.id,
    jsonb_build_object('role', v_target.role, 'active', v_target.active, 'supplier_id', v_target.supplier_id),
    jsonb_build_object('role', p_role, 'active', p_active, 'supplier_id', p_supplier_id),
    v_reason
  );

  perform private.record_security_event(
    v_org, v_actor, 'permission_change',
    jsonb_build_object(
      'profile_id', v_target.id,
      'old_role', v_target.role, 'new_role', p_role,
      'old_active', v_target.active, 'new_active', p_active));
end
$$;

-- ===== 5. Path 3b -- grant_user_scope / revoke_user_scope =====
-- Redeclared from 0054:364/404. INCLUSION JUSTIFICATION (PLAN-04 §2.3 requires it in
-- writing): a scope grant is "another user's permissions" in the §6 sense -- it widens or
-- narrows everything the target user can SEE across the six enforced tables, which is at
-- least as sensitive as changing their role. Both additions per command: the assertion
-- after the owner gate, and a scope_grant_change security event beside the existing audit.
create or replace function grant_user_scope(p_user_id uuid, p_unit_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_reason text := nullif(trim(p_reason), '');
  v_unit org_units;
begin
  if v_org is null or v_actor is null or auth_role() <> 'owner' then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  perform public.assert_recent_password_authentication();
  if v_reason is null then
    raise exception 'scope_reason_required' using errcode = '22023';
  end if;
  select * into v_unit from org_units where id = p_unit_id and org_id = v_org;
  if not found then
    raise exception 'unit_unknown' using errcode = 'P0002';
  end if;
  if not exists (select 1 from profiles p where p.id = p_user_id and p.org_id = v_org) then
    raise exception 'profile_unknown' using errcode = 'P0002';
  end if;

  insert into user_scope_grants (org_id, user_id, unit_id)
  values (v_org, p_user_id, p_unit_id)
  on conflict (org_id, user_id, unit_id) do nothing;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, new_values, reason)
  values (
    v_org, v_actor, 'user_scope_granted', 'user_scope_grants', p_user_id,
    jsonb_build_object(
      'user_id', p_user_id, 'unit_id', p_unit_id,
      'unit_type', v_unit.unit_type, 'unit_name', v_unit.name),
    v_reason
  );

  perform private.record_security_event(
    v_org, v_actor, 'scope_grant_change',
    jsonb_build_object('change', 'granted', 'user_id', p_user_id, 'unit_id', p_unit_id));
end
$$;

create or replace function revoke_user_scope(p_user_id uuid, p_unit_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_reason text := nullif(trim(p_reason), '');
  v_unit org_units;
begin
  if v_org is null or v_actor is null or auth_role() <> 'owner' then
    raise exception 'not_owner' using errcode = '42501';
  end if;
  perform public.assert_recent_password_authentication();
  if v_reason is null then
    raise exception 'scope_reason_required' using errcode = '22023';
  end if;
  select * into v_unit from org_units where id = p_unit_id and org_id = v_org;
  if not found then
    raise exception 'unit_unknown' using errcode = 'P0002';
  end if;

  delete from user_scope_grants
  where org_id = v_org and user_id = p_user_id and unit_id = p_unit_id;
  if not found then
    raise exception 'scope_grant_unknown' using errcode = 'P0002';
  end if;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, old_values, reason)
  values (
    v_org, v_actor, 'user_scope_revoked', 'user_scope_grants', p_user_id,
    jsonb_build_object(
      'user_id', p_user_id, 'unit_id', p_unit_id,
      'unit_type', v_unit.unit_type, 'unit_name', v_unit.name),
    v_reason
  );

  perform private.record_security_event(
    v_org, v_actor, 'scope_grant_change',
    jsonb_build_object('change', 'revoked', 'user_id', p_user_id, 'unit_id', p_unit_id));
end
$$;

-- ===== 6. Path 4 -- update_identity_provider_settings, rewired =====
-- Full redeclaration of the 0060 body with the assertion after the owner gate. No user
-- traffic runs between 0060 and 0061, so no un-stepped-up window ever exists.
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
  perform public.assert_recent_password_authentication();
  if v_reason is null then
    raise exception 'sso_reason_required' using errcode = '22023';
  end if;
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

-- ===== 7. Path 2 -- suppliers.bank_details =====
-- The 0036:67-71 column allowlist loses UPDATE (bank_details): changing where an existing
-- counterparty gets paid is the classic payment-diversion fraud and stops being a plain
-- form write. INSERT (bank_details) stays -- entering details while CREATING a supplier
-- is part of onboarding, and a new row diverts nothing. The suppliers UPDATE policy roles
-- (owner/office, 0022:114-116) keep the capability, through the reasoned command below.
revoke update (bank_details) on table public.suppliers from public, anon, authenticated;

create or replace function update_supplier_bank_details(
  p_supplier_id uuid,
  p_bank_details text,
  p_reason text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_reason text := nullif(trim(p_reason), '');
  v_new text := nullif(trim(coalesce(p_bank_details, '')), '');
  v_supplier suppliers;
begin
  if v_org is null or v_actor is null or auth_role() not in ('owner', 'office') then
    raise exception 'supplier_bank_details_not_authorized' using errcode = '42501';
  end if;
  perform public.assert_recent_password_authentication();
  if v_reason is null then
    raise exception 'supplier_bank_details_reason_required' using errcode = '22023';
  end if;

  select * into v_supplier
  from suppliers s
  where s.id = p_supplier_id and s.org_id = v_org and s.deleted_at is null
  for update;
  if not found then
    raise exception 'supplier_unknown' using errcode = 'P0002';
  end if;

  update suppliers set bank_details = v_new where id = v_supplier.id;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason)
  values (
    v_org, v_actor, 'supplier_bank_details_changed', 'suppliers', v_supplier.id,
    jsonb_build_object('bank_details', v_supplier.bank_details),
    jsonb_build_object('bank_details', v_new),
    v_reason
  );
end
$$;
revoke all on function update_supplier_bank_details(uuid, text, text) from public, anon;
grant execute on function update_supplier_bank_details(uuid, text, text) to authenticated;

-- ===== 8. Re-assertion (wave-3 inherited duties, PLAN-04 §2.4) =====
-- No new table in this migration, but the redeclarations above ran under A5's eye: every
-- function that references an enforced table kept its oid and therefore its exemption
-- row; every new function here touches none. Prove it.
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0061 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
