-- 0195 -- Split the organization-lifecycle reason into a tenant-visible half and a
-- Platform-only half (OPEN-DECISIONS #20, decided 22.08.2026).
--
-- THE LEAK THIS CLOSES IS LIVE, NOT HYPOTHETICAL. The live command is
-- 0134_retire_trial_lifecycle.sql:149 (NOT 0020:152 -- 0020 was superseded twice, by 0092 and
-- then 0134). It writes the operator's single free-text p_reason into
--   audit_logs(org_id = <the tenant>, action = 'organization_lifecycle_changed', reason = ...)
-- and the live read policy audit_select (0031:209) is
--   org_id = auth_org() and auth_role() in ('owner', 'accountant').
-- So the operator's commercial note -- "unpaid bill, chasing collection, do not extend credit"
-- -- is readable by the suspended tenant's own owner and accountant the moment it is written,
-- and it rides along in the tenant export (0103) and in anything built off audit.
--
-- THE SPLIT.
--   * public reason code  -- a controlled vocabulary, stored in the tenant-readable audit row's
--     new_values. The tenant may see WHICH kind of change happened.
--   * public reason text  -- p_reason, unchanged, still mandatory, still tenant-readable. #20
--     requires the tenant to keep seeing a general reason; a split that let an operator suspend
--     with no recorded reason at all would be a worse outcome than the leak.
--   * internal note       -- new, optional, Platform-only. Shape-2 storage in `private`: RLS on,
--     no policies, every grant revoked. The identity_provider_settings (0060:17-33) and
--     webhook_subscriptions (0066:57) precedent.
--
-- WHY `private` AND NOT A PUBLIC TABLE WITH A DENY POLICY. A public table carrying org_id is
-- enumerated by private.tenant_export_registry (0103:194) and has to be classified for export
-- one way or the other; a later reviewer could classify it 'include' and hand the note straight
-- back to the tenant. A table in `private` is not reachable by PostgREST at all and is not part
-- of the export enumeration, so the disclosure boundary is structural rather than a decision
-- somebody has to keep making correctly.
--
-- ANCHORED REPLACEMENT, NOT A REDECLARE. The command is patched out of its own live body
-- (pg_get_functiondef), each anchor asserted to occur exactly once (0168:44-69 idiom). If the
-- live body is not what this migration believes it is, the migration refuses to apply instead
-- of silently reverting whatever the difference was.

-- ===== 1. The public reason-code vocabulary =====
-- Platform vocabulary, not tenant data: schema `private`, like scope_registry (0054:97-101).
-- Seeded with exactly the two codes the lifecycle transition itself states. The richer
-- commercial vocabulary (non-payment, contract ended, security incident, ...) is an OWNER
-- decision that #20 does not make, and this migration deliberately does not invent it: adding a
-- code is one INSERT and no code change.
create table private.organization_lifecycle_reason_codes (
  reason_code       text primary key
    check (reason_code ~ '^[a-z][a-z0-9_]{2,63}$'),
  applies_to_status public.org_status not null,
  tenant_label      text not null check (length(trim(tenant_label)) > 0)
);
revoke all on table private.organization_lifecycle_reason_codes
  from public, anon, authenticated, service_role;

insert into private.organization_lifecycle_reason_codes
  (reason_code, applies_to_status, tenant_label) values
  ('organization_suspended',   'suspended', 'הגישה לארגון הושהתה'),
  ('organization_reactivated', 'active',    'הארגון הופעל מחדש');

comment on table private.organization_lifecycle_reason_codes is
  'Tenant-visible reason codes for a lifecycle change (#20). The commercial vocabulary is an '
  'owner decision and is added here as data, never as a code branch.';

-- ===== 2. Shape-2 internal-note storage =====
-- RLS on, NO policies, every grant revoked from every role including service_role. The only
-- writer is the lifecycle command; the only reader is the platform-gated function below, and
-- both are SECURITY DEFINER owned by the migration role.
--
-- No generic audit trigger, for the same reason 0060:37-45 gives for identity_provider_settings:
-- audit_row_change captures the FULL row into audit_logs, and audit_logs is tenant-readable --
-- an audit trigger here would re-open the exact leak this file closes.
create table private.organization_lifecycle_internal_notes (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  -- The tenant-readable row this note belongs to. Actor and time are recorded here as well, so
  -- the platform trail stands on its own.
  audit_log_id       uuid not null references public.audit_logs(id) on delete cascade,
  actor_user_id      uuid,
  status             public.org_status not null,
  public_reason_code text not null
    references private.organization_lifecycle_reason_codes(reason_code),
  internal_note      text not null check (length(trim(internal_note)) > 0),
  created_at         timestamptz not null default statement_timestamp()
);
alter table private.organization_lifecycle_internal_notes enable row level security;
revoke all on table private.organization_lifecycle_internal_notes
  from public, anon, authenticated, service_role;
create index organization_lifecycle_internal_notes_org_idx
  on private.organization_lifecycle_internal_notes (org_id, created_at desc);

comment on table private.organization_lifecycle_internal_notes is
  'Platform-only commercial notes attached to a lifecycle change (#20). Shape-2: RLS on, no '
  'policies, no grants. Never enters audit_logs, the tenant export or a notification.';

-- ===== 3. Patch the live command =====
do $mig_0195$
declare
  v_def     text;
  v_anchor  text;
  v_patched text;
  v_signature constant text :=
    'public.set_organization_lifecycle(uuid,public.org_status,timestamptz,text)';
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_catalog.pg_proc p
  where p.oid = v_signature::regprocedure;
  if v_def is null then
    raise exception '0195: set_organization_lifecycle not found';
  end if;
  -- Normalise line endings on BOTH sides so a CRLF checkout cannot fake an anchor mismatch.
  v_def := replace(v_def, e'\r', '');

  -- --- anchor 1: the argument list (this creates the six-argument overload) ---
  v_anchor := replace($anchor$public.set_organization_lifecycle(p_org_id uuid, p_status org_status, p_trial_ends_at timestamp with time zone, p_reason text)$anchor$, e'\r', '');
  v_patched := replace($patched$public.set_organization_lifecycle(p_org_id uuid, p_status org_status, p_trial_ends_at timestamp with time zone, p_reason text, p_public_reason_code text DEFAULT NULL::text, p_internal_note text DEFAULT NULL::text)$patched$, e'\r', '');
  if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception '0195: argument-list anchor moved -- refusing to patch blindly';
  end if;
  v_def := replace(v_def, v_anchor, v_patched);

  -- --- anchor 2: the declaration block ---
  v_anchor := replace($anchor$  v_reason text := nullif(trim(p_reason), '');$anchor$, e'\r', '');
  v_patched := replace($patched$  v_reason text := nullif(trim(p_reason), '');
  v_public_reason_code text := lower(nullif(trim(p_public_reason_code), ''));
  v_internal_note text := nullif(trim(p_internal_note), '');
  v_audit_id uuid;$patched$, e'\r', '');
  if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception '0195: declaration anchor moved -- refusing to patch blindly';
  end if;
  v_def := replace(v_def, v_anchor, v_patched);

  -- --- anchor 3: the audit write ---
  v_anchor := replace($anchor$  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org.id, v_actor, 'organization_lifecycle_changed', 'organizations', v_org.id,
    jsonb_build_object('status', v_org.status),
    jsonb_build_object('status', p_status),
    v_reason
  );$anchor$, e'\r', '');
  v_patched := replace($patched$  v_public_reason_code := coalesce(
    v_public_reason_code,
    case when p_status = 'suspended'
         then 'organization_suspended' else 'organization_reactivated' end);
  if not exists (
    select 1 from private.organization_lifecycle_reason_codes code
    where code.reason_code = v_public_reason_code
      and code.applies_to_status = p_status
  ) then
    raise exception 'lifecycle_reason_code_unknown' using errcode = '22023';
  end if;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org.id, v_actor, 'organization_lifecycle_changed', 'organizations', v_org.id,
    jsonb_build_object('status', v_org.status),
    jsonb_build_object('status', p_status, 'public_reason_code', v_public_reason_code),
    v_reason
  ) returning id into v_audit_id;

  -- The commercial half goes to Shape-2 storage the tenant has no path to, keyed to the
  -- tenant-readable row above and to the organization row this call locked.
  if v_internal_note is not null then
    insert into private.organization_lifecycle_internal_notes (
      org_id, audit_log_id, actor_user_id, status, public_reason_code, internal_note
    ) values (
      v_org.id, v_audit_id, v_actor, p_status, v_public_reason_code, v_internal_note
    );
  end if;$patched$, e'\r', '');
  if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception '0195: audit-write anchor moved -- refusing to patch blindly';
  end if;
  v_def := replace(v_def, v_anchor, v_patched);

  execute v_def;
end
$mig_0195$;

-- The four-argument form must go: with the two new arguments defaulted, keeping it would make
-- every existing four-argument call ambiguous. Existing callers resolve to the new form.
drop function public.set_organization_lifecycle(uuid, public.org_status, timestamptz, text);

revoke all on function
  public.set_organization_lifecycle(uuid, public.org_status, timestamptz, text, text, text)
  from public, anon, service_role;
grant execute on function
  public.set_organization_lifecycle(uuid, public.org_status, timestamptz, text, text, text)
  to authenticated;

comment on function
  public.set_organization_lifecycle(uuid, public.org_status, timestamptz, text, text, text) is
  'Platform lifecycle change (#20). p_reason and p_public_reason_code are tenant-visible; '
  'p_internal_note is Platform-only and never reaches audit_logs, the export or a notification.';

-- ===== 4. The Platform-only reader =====
-- The guard sits inside the WHERE so an unauthorised caller receives zero rows rather than a
-- statement about the platform (the 0159:160-166 shape).
create function public.platform_organization_lifecycle_notes(p_org_id uuid)
returns table (
  id                 uuid,
  audit_log_id       uuid,
  actor_email        text,
  status             public.org_status,
  public_reason_code text,
  internal_note      text,
  created_at         timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select note.id, note.audit_log_id, actor.email::text, note.status,
         note.public_reason_code, note.internal_note, note.created_at
  from private.organization_lifecycle_internal_notes note
  left join auth.users actor on actor.id = note.actor_user_id
  where note.org_id = p_org_id
    and public.is_platform_admin()
    and public.platform_has_capability('org.lifecycle')
  order by note.created_at desc
$$;
revoke all on function public.platform_organization_lifecycle_notes(uuid)
  from public, anon, service_role;
grant execute on function public.platform_organization_lifecycle_notes(uuid) to authenticated;

-- The tenant-facing label for a reason code. Readable by any signed-in user: a code with no
-- label is a code the tenant cannot understand, and the labels state nothing the tenant does
-- not already know about its own lifecycle state.
create function public.organization_lifecycle_reason_labels()
returns table (reason_code text, applies_to_status public.org_status, tenant_label text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select code.reason_code, code.applies_to_status, code.tenant_label
  from private.organization_lifecycle_reason_codes code
  where public.auth_org() is not null or public.is_platform_admin()
  order by code.reason_code
$$;
revoke all on function public.organization_lifecycle_reason_labels() from public, anon;
grant execute on function public.organization_lifecycle_reason_labels() to authenticated;

-- ===== 5. Structural re-assertion (mandatory after 0057) =====
do $assert_0195$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0195 scope assertions failed:\n%', v_violations;
  end if;
  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0195 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0195$;

-- ===== 6. Anchors =====
do $anchor_0195$
begin
  -- Shape-2 or nothing: a policy or a browser grant on the note table is the leak coming back.
  if exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'private' and tablename = 'organization_lifecycle_internal_notes'
  ) then
    raise exception '0195: the internal-note table grew a policy';
  end if;
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'private'
      and table_name in ('organization_lifecycle_internal_notes',
                         'organization_lifecycle_reason_codes')
      and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
  ) then
    raise exception '0195: a browser or service role holds a grant on the internal-note storage';
  end if;

  -- The note storage must never become a tenant export surface.
  if exists (
    select 1 from private.tenant_export_registry
    where table_name in ('organization_lifecycle_internal_notes',
                         'organization_lifecycle_reason_codes')
  ) then
    raise exception '0195: the internal-note storage was classified for tenant export';
  end if;

  -- The patched command must still carry every guarantee 0134 gave it.
  if coalesce((
    select p.prosrc from pg_catalog.pg_proc p
    where p.oid = 'public.set_organization_lifecycle(uuid,public.org_status,timestamptz,text,text,text)'::regprocedure
  ), '') !~ 'assert_recent_password_authentication' then
    raise exception '0195: the patched lifecycle command lost its step-up assertion';
  end if;
  if coalesce((
    select p.prosrc from pg_catalog.pg_proc p
    where p.oid = 'public.set_organization_lifecycle(uuid,public.org_status,timestamptz,text,text,text)'::regprocedure
  ), '') !~ 'trial_retired' then
    raise exception '0195: the patched lifecycle command lost the 0134 trial refusal';
  end if;
  if to_regprocedure('public.set_organization_lifecycle(uuid,public.org_status,timestamptz,text)')
     is not null then
    raise exception '0195: the four-argument lifecycle command survived the split';
  end if;
end
$anchor_0195$;
