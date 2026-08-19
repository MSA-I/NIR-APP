-- 0166 -- The eighth egress kind: assistant.
--
-- WHY THIS EXISTS. The assistant Edge Function must reach its model provider through the same
-- leased-egress boundary every other external call already uses (0103): reserve a short fenced
-- lease, make one bounded provider call, settle it with evidence. The boundary constrains kind
-- to a closed list in three places that must move together -- the table CHECK (0103:599), the
-- literal list duplicated inside service_reserve_organization_external_egress (0132:94), and
-- the KINDS allowlist in supabase/functions/_shared/organization-egress.ts. This migration
-- moves the two database copies; the TypeScript copy moves in the same commit.
--
-- Shape: one new value, 'assistant', appended to the kind CHECK and to the reservation
-- function's literal list. The function body is otherwise the 0132 body verbatim: the same
-- FOR KEY SHARE organization lock, the same organization_access_mode gate, the same 5-120s TTL
-- bound, the same settled/recovery/expired/idempotent-replay branches and the same grants. The
-- guard below refuses to replace anything except the exact reviewed 0132 body, and the anchor
-- pins the replacement, so what runs is what was reviewed -- not what somebody remembered.
--
-- assistant takes the ordinary 120-second unacknowledged expiry cap
-- (organization_external_egress_expiry_check, 0103:618). No carve-out: the only per-kind arm
-- stays document_signed_url's acknowledged OCR window. If an assistant provider call ever needs
-- more than 120 seconds, that is a boundary design conversation, not a wider constraint.
--
-- private.organization_external_egress_evidence carries no kind allowlist of its own (0103:650):
-- evidence rows are written only by the settle path from an existing lease row, so their kind
-- inherits validity from the lease. Nothing to change there.
--
-- What this deliberately does not cover: no assistant tables, no Edge Function, no model or
-- provider choice, no new TTL semantics, no per-kind expiry carve-out, and no row in
-- private.scope_definer_enforcements -- the reservation function touches no scope-enforced
-- table and has never been registered there (checked against the live registry; guard (b)
-- re-checks so a future pin turns this replace into a loud failure instead of a stale hash
-- that trips A5 three migrations later).

-- ===== 1. Guards: replace only what was reviewed =====
do $guard_0166$
declare
  v_hash text;
  v_def text;
  v_kind text;
begin
  -- (a) The live body is exactly the reviewed 0132 body, CR-stripped (the 0155 convention: a
  -- Windows checkout must hash like CI). Anything else is out-of-band drift -- or a second run
  -- of this migration -- and both deserve a human, not a silent skip.
  select md5(replace(proc.prosrc, e'\r', '')) into v_hash
  from pg_catalog.pg_proc proc
  where proc.oid = pg_catalog.to_regprocedure(
    'public.service_reserve_organization_external_egress(uuid,text,uuid,integer)');
  if v_hash is null then
    raise exception '0166: service_reserve_organization_external_egress(uuid,text,uuid,integer) is missing; 0132 must run first';
  end if;
  if v_hash <> '0ccfb3293b8af6bc36e729c5cd951ac6' then
    raise exception
      '0166: service_reserve_organization_external_egress is not the reviewed 0132 body (found %) -- out-of-band drift or a repeated run; re-review before replacing',
      v_hash;
  end if;

  -- (b) The function is not pinned in private.scope_definer_enforcements today. If it ever is,
  -- replacing it here without re-pinning would leave a stale hash for A5's staleness arm to
  -- reject later and elsewhere; fail now, here, with the required dance named (0155:317-378).
  if exists (
    select 1 from private.scope_definer_enforcements pin
    where pin.function_signature like 'service_reserve_organization_external_egress(%'
  ) then
    raise exception '0166: the reservation function is now hash-pinned; rewrite this migration with the 0155 drift-check / replace / re-pin dance';
  end if;

  -- (c) The kind CHECK exists under the name Postgres derived for 0103's inline check, and
  -- lists exactly the seven reviewed kinds. A different name or list means the boundary moved
  -- out of band, and skipping would leave the table refusing what the function accepts.
  select pg_get_constraintdef(con.oid) into v_def
  from pg_catalog.pg_constraint con
  where con.conrelid = 'private.organization_external_egress_leases'::regclass
    and con.conname = 'organization_external_egress_leases_kind_check'
    and con.contype = 'c';
  if v_def is null then
    raise exception '0166: constraint organization_external_egress_leases_kind_check not found -- read the real name from pg_constraint and re-review this migration';
  end if;
  foreach v_kind in array array[
    'document_interpretation', 'invitation_email', 'push_notification',
    'integration_webhook', 'document_signed_url', 'whatsapp_reminder',
    'organization_logo_storage'
  ] loop
    if position('''' || v_kind || '''' in v_def) = 0 then
      raise exception '0166: the kind CHECK no longer lists % -- boundary drifted out of band, re-review', v_kind;
    end if;
  end loop;
  if position('''assistant''' in v_def) > 0 then
    raise exception '0166: the kind CHECK already lists assistant -- this migration already ran';
  end if;
end
$guard_0166$;

-- ===== 2. The table CHECK: seven kinds become eight =====
alter table private.organization_external_egress_leases
  drop constraint organization_external_egress_leases_kind_check;
alter table private.organization_external_egress_leases
  add constraint organization_external_egress_leases_kind_check check (kind in (
    'document_interpretation', 'invitation_email', 'push_notification',
    'integration_webhook', 'document_signed_url', 'whatsapp_reminder',
    'organization_logo_storage', 'assistant'
  ));

-- ===== 3. The reservation function: 0132 verbatim, plus 'assistant' in the literal list =====
create or replace function public.service_reserve_organization_external_egress(
  p_org_id uuid,
  p_kind text,
  p_correlation_id uuid,
  p_ttl_seconds integer default 90
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind text := lower(nullif(trim(p_kind), ''));
  v_lease private.organization_external_egress_leases;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_org_id is null or p_correlation_id is null
     or v_kind not in (
       'document_interpretation', 'invitation_email', 'push_notification',
       'integration_webhook', 'document_signed_url', 'whatsapp_reminder',
       'organization_logo_storage', 'assistant'
     ) or p_ttl_seconds not between 5 and 120 then
    raise exception 'organization_external_egress_reservation_invalid' using errcode = '22023';
  end if;

  perform 1 from public.organizations organization
  where organization.id = p_org_id
  for key share;
  if not found then
    raise exception 'organization_unknown' using errcode = 'P0002';
  end if;

  select * into v_lease
  from private.organization_external_egress_leases lease
  where lease.org_id = p_org_id and lease.kind = v_kind
    and lease.correlation_id = p_correlation_id
  for update;
  if found and v_lease.status = 'settled' then
    return jsonb_build_object(
      'lease_id', v_lease.lease_id, 'lease_token', null,
      'org_id', v_lease.org_id, 'kind', v_lease.kind,
      'correlation_id', v_lease.correlation_id, 'expires_at', v_lease.expires_at,
      'egress_allowed', false, 'settled_outcome', v_lease.outcome, 'idempotent', true
    );
  end if;
  -- Recovery creates a private one-shot generation before the Edge handoff starts. Consume that
  -- marker before ordinary expiry handling and start its bounded provider window here, so a cold
  -- start or failed handoff cannot turn an otherwise unused recovery generation into an
  -- unrecoverable ambiguous lease. The row lock still lets exactly one reservation receive
  -- idempotent=false; every concurrent caller observes the consumed generation.
  if found and v_lease.status = 'active'
     and v_lease.evidence_code = 'owner_stuck_recovery_rearmed' then
    if private.organization_access_mode(p_org_id) not in ('active', 'trial', 'grace') then
      raise exception 'organization_external_egress_not_allowed' using errcode = '42501';
    end if;
    update private.organization_external_egress_leases lease
    set evidence_code = null,
        reserved_at = statement_timestamp(),
        expires_at = statement_timestamp() + make_interval(secs => p_ttl_seconds)
    where lease.lease_id = v_lease.lease_id
    returning * into v_lease;
    return jsonb_build_object(
      'lease_id', v_lease.lease_id, 'lease_token', v_lease.lease_token,
      'org_id', v_lease.org_id, 'kind', v_lease.kind,
      'correlation_id', v_lease.correlation_id, 'expires_at', v_lease.expires_at,
      'egress_allowed', true, 'settled_outcome', null, 'idempotent', false
    );
  end if;
  if found and v_lease.expires_at < statement_timestamp() then
    update private.organization_external_egress_leases lease
    set status = 'settled', outcome = 'ambiguous',
        evidence_code = 'lease_expired_without_settlement', settled_at = statement_timestamp()
    where lease.lease_id = v_lease.lease_id
    returning * into v_lease;
    return jsonb_build_object(
      'lease_id', v_lease.lease_id, 'lease_token', null,
      'org_id', v_lease.org_id, 'kind', v_lease.kind,
      'correlation_id', v_lease.correlation_id, 'expires_at', v_lease.expires_at,
      'egress_allowed', false, 'settled_outcome', 'ambiguous', 'idempotent', true
    );
  end if;
  if private.organization_access_mode(p_org_id) not in ('active', 'trial', 'grace') then
    raise exception 'organization_external_egress_not_allowed' using errcode = '42501';
  end if;
  if found and v_lease.expires_at >= statement_timestamp() then
    return jsonb_build_object(
      'lease_id', v_lease.lease_id, 'lease_token', v_lease.lease_token,
      'org_id', v_lease.org_id, 'kind', v_lease.kind,
      'correlation_id', v_lease.correlation_id, 'expires_at', v_lease.expires_at,
      'egress_allowed', true, 'settled_outcome', null, 'idempotent', true
    );
  end if;

  insert into private.organization_external_egress_leases (
    org_id, kind, correlation_id, expires_at
  ) values (
    p_org_id, v_kind, p_correlation_id,
    statement_timestamp() + make_interval(secs => p_ttl_seconds)
  ) returning * into v_lease;

  return jsonb_build_object(
    'lease_id', v_lease.lease_id, 'lease_token', v_lease.lease_token,
    'org_id', v_lease.org_id, 'kind', v_lease.kind,
    'correlation_id', v_lease.correlation_id, 'expires_at', v_lease.expires_at,
    'egress_allowed', true, 'settled_outcome', null, 'idempotent', false
  );
end
$$;

revoke all on function public.service_reserve_organization_external_egress(
  uuid, text, uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function public.service_reserve_organization_external_egress(
  uuid, text, uuid, integer
) to service_role;

-- ===== 4. The 0057/0103 contracts still hold =====
do $assert_0166$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0166 scope assertions failed:\n%', v_violations;
  end if;
  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0166 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0166$;

-- ===== 5. Anchors =====
do $anchor_0166$
declare
  v_def text;
  v_kind text;
  v_hash text;
begin
  -- The CHECK accepts all eight kinds and nothing else: every literal present, and exactly
  -- eight ::text casts in the deparsed array -- a ninth kind cannot hide.
  select pg_get_constraintdef(con.oid) into v_def
  from pg_catalog.pg_constraint con
  where con.conrelid = 'private.organization_external_egress_leases'::regclass
    and con.conname = 'organization_external_egress_leases_kind_check'
    and con.contype = 'c';
  foreach v_kind in array array[
    'document_interpretation', 'invitation_email', 'push_notification',
    'integration_webhook', 'document_signed_url', 'whatsapp_reminder',
    'organization_logo_storage', 'assistant'
  ] loop
    if v_def is null or position('''' || v_kind || '''' in v_def) = 0 then
      raise exception '0166: the rebuilt kind CHECK does not list %: %', v_kind, v_def;
    end if;
  end loop;
  if (length(v_def) - length(replace(v_def, '::text', ''))) <> 8 * length('::text') then
    raise exception '0166: the rebuilt kind CHECK does not hold exactly eight kinds: %', v_def;
  end if;

  -- assistant got no expiry carve-out: the ordinary 120-second unacknowledged cap applies, and
  -- the only per-kind arm is still document_signed_url's acknowledged window.
  select pg_get_constraintdef(con.oid) into v_def
  from pg_catalog.pg_constraint con
  where con.conrelid = 'private.organization_external_egress_leases'::regclass
    and con.conname = 'organization_external_egress_expiry_check'
    and con.contype = 'c';
  if v_def is null then
    raise exception '0166: organization_external_egress_expiry_check disappeared';
  end if;
  if position('assistant' in v_def) > 0 then
    raise exception '0166: assistant grew an expiry carve-out: %', v_def;
  end if;
  if position('document_signed_url' in v_def) = 0 or position('00:02:00' in v_def) = 0 then
    raise exception '0166: the expiry constraint no longer reads as reviewed: %', v_def;
  end if;

  -- The replacement is exactly the reviewed body: 0132 plus 'assistant', nothing else. The
  -- hash is over CR-stripped prosrc, so Windows and CI agree on it.
  select md5(replace(proc.prosrc, e'\r', '')) into v_hash
  from pg_catalog.pg_proc proc
  where proc.oid = pg_catalog.to_regprocedure(
    'public.service_reserve_organization_external_egress(uuid,text,uuid,integer)')
    and proc.prosecdef;
  if v_hash is distinct from 'aa98553801b844f570f6a3d9c90b1133' then
    raise exception '0166: the replaced reservation function hashes % instead of the reviewed body', v_hash;
  end if;

  -- Still service-only at the grant surface.
  if has_function_privilege('anon', 'public.service_reserve_organization_external_egress(uuid,text,uuid,integer)', 'execute')
     or has_function_privilege('authenticated', 'public.service_reserve_organization_external_egress(uuid,text,uuid,integer)', 'execute') then
    raise exception '0166: a browser role can execute the reservation function';
  end if;
  if not has_function_privilege('service_role', 'public.service_reserve_organization_external_egress(uuid,text,uuid,integer)', 'execute') then
    raise exception '0166: service_role lost execute on the reservation function';
  end if;
end
$anchor_0166$;
