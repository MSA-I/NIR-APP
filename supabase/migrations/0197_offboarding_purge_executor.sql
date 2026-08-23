-- 0197 -- The offboarding purge executor (OPEN-DECISIONS #261, decided 22.08.2026).
--
-- #261 in full: "אין purge עיוור" -- no blind purge. The system produces a candidate report;
-- a Platform Admin approves a batch only after export readiness, backup, retention eligibility
-- and a legal-hold check; the command locks, re-checks and writes audit/manifest; there is no
-- automatic deletion merely because a clock elapsed. #261 also says plainly that the decision
-- DOES NOT AUTHORIZE A PURGE NOW. This migration builds and proves the executor. Running it
-- against production is a separate, per-batch owner authorization that has not been given.
--
-- THE FOUR THINGS THAT MAKE THIS THE MOST DANGEROUS CODE IN THE PRODUCT, AND WHAT ANSWERS THEM:
--   1. Time as authorization. The executor takes ONE argument -- an approval id. It has no
--      candidate query, no date predicate and no path that selects its own targets. A scheduler
--      calling it still has to name an approval a person created.
--   2. Stale approval. Between report, approval and execution a tenant can be reinstated or put
--      on hold. Every tenant is re-locked and re-gated immediately before its own deletion, and
--      a tenant that changed is SKIPPED while the rest of the batch proceeds.
--   3. Batch scope drift. Execution replays the approved manifest. It never re-runs the
--      candidate query, so a tenant that became a candidate after approval is not in scope.
--   4. Cascade blast radius. `delete from organizations` is not a staged delete -- and it does
--      not even work here: profiles_org_id_fkey is RESTRICT (measured 23.08.2026). Deletion
--      goes through private.delete_tenant_rows (0196), whose order is derived from the live
--      foreign-key graph and which refuses to return while any tenant row survives.
--
-- LEGAL HOLD FAILS CLOSED. organization_offboarding_requests.legal_hold is `not null default
-- true` (0103:58). An organization with no offboarding request at all, or whose hold cannot be
-- read as an explicit false, is NOT a candidate. Unknown is a hold.

-- =====================================================================================
-- 1. Backup and restore evidence
-- =====================================================================================
-- Deliberately NO foreign key to organizations: the evidence has to outlive the tenant it is
-- evidence about, which a cascade would prevent. Append-only, like the export access ledger
-- (0103:577).
create table private.organization_purge_backup_evidence (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null,
  backup_reference    text not null check (length(trim(backup_reference)) > 0),
  backup_taken_at     timestamptz not null,
  restore_verified_at timestamptz,
  recorded_by         uuid not null,
  reason              text not null check (length(trim(reason)) > 0),
  recorded_at         timestamptz not null default statement_timestamp()
);
revoke all on table private.organization_purge_backup_evidence
  from public, anon, authenticated, service_role;
create index organization_purge_backup_evidence_org_idx
  on private.organization_purge_backup_evidence (org_id, recorded_at desc);

-- =====================================================================================
-- 2. The approval batch and its immutable manifest
-- =====================================================================================
create table private.organization_purge_batches (
  id          uuid primary key default gen_random_uuid(),
  approved_by uuid not null,
  approved_at timestamptz not null default statement_timestamp(),
  reason      text not null check (length(trim(reason)) > 0)
);
revoke all on table private.organization_purge_batches
  from public, anon, authenticated, service_role;

-- The manifest IS the authorization. If it can be edited afterwards, nothing records what was
-- actually approved. Append-only for every role: no grants at all, plus a trigger so even the
-- owning role cannot rewrite it by hand.
create table private.organization_purge_manifest_items (
  id                     uuid primary key default gen_random_uuid(),
  batch_id               uuid not null references private.organization_purge_batches(id),
  org_id                 uuid not null,
  organization_name      text not null,
  offboarding_request_id uuid not null,
  gates_at_approval      jsonb not null check (jsonb_typeof(gates_at_approval) = 'object'),
  created_at             timestamptz not null default statement_timestamp(),
  unique (batch_id, org_id)
);
revoke all on table private.organization_purge_manifest_items
  from public, anon, authenticated, service_role;

create table private.organization_purge_executions (
  id                 uuid primary key default gen_random_uuid(),
  batch_id           uuid not null references private.organization_purge_batches(id),
  org_id             uuid not null,
  outcome            text not null check (outcome in ('purged', 'skipped')),
  skip_reason        text,
  removed_row_counts jsonb not null default '{}'::jsonb
    check (jsonb_typeof(removed_row_counts) = 'object'),
  executed_at        timestamptz not null default statement_timestamp(),
  unique (batch_id, org_id),
  constraint organization_purge_executions_skip_shape check (
    (outcome = 'skipped' and skip_reason is not null)
    or (outcome = 'purged' and skip_reason is null))
);
revoke all on table private.organization_purge_executions
  from public, anon, authenticated, service_role;

create function private.reject_purge_ledger_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'purge_ledger_is_append_only' using errcode = '42501';
end
$$;
revoke all on function private.reject_purge_ledger_change()
  from public, anon, authenticated, service_role;

create trigger organization_purge_batches_append_only
  before update or delete on private.organization_purge_batches
  for each row execute function private.reject_purge_ledger_change();
create trigger organization_purge_manifest_items_append_only
  before update or delete on private.organization_purge_manifest_items
  for each row execute function private.reject_purge_ledger_change();
create trigger organization_purge_executions_append_only
  before update or delete on private.organization_purge_executions
  for each row execute function private.reject_purge_ledger_change();
create trigger organization_purge_backup_evidence_append_only
  before update or delete on private.organization_purge_backup_evidence
  for each row execute function private.reject_purge_ledger_change();

-- The purge ledger is the platform's record of what it deleted. Deleting it with the tenant
-- would destroy the only proof the deletion was authorized, bounded and preceded by a verified
-- restore -- so all four tables are excluded from the staged tenant delete by name (0196).
insert into private.tenant_delete_exclusions (schema_name, table_name, rationale) values
  ('private', 'organization_purge_manifest_items',
   'The approved manifest is the authorization for the deletion and must survive it (#261).'),
  ('private', 'organization_purge_executions',
   'The per-tenant outcome ledger is the record of what the purge actually did (#261).'),
  ('private', 'organization_purge_backup_evidence',
   'Backup and restore evidence is evidence ABOUT the tenant and must outlive it (#261 E8).');

-- =====================================================================================
-- 3. The four gates, defined ONCE
-- =====================================================================================
-- The report and the executor ask the same function. Two copies of a gate is how a report and
-- an executor come to disagree about what "eligible" means.
create function private.organization_purge_gates(p_org_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'offboarding_request_id', request.id,
    -- Gate 1: every retention boundary 0103 recorded has passed.
    'retention_eligible', coalesce(
      request.operational_purge_eligible_at <= now()
      and request.security_logs_retain_until <= now()
      and request.financial_records_retain_until <= now(), false),
    -- Gate 2: the hold must be an explicit false. No request, or anything else, is a hold.
    'legal_hold_clear', coalesce(request.legal_hold, true) = false,
    -- Gate 3: an export that actually completed, with its digest and its object path.
    'export_ready', coalesce(
      request.status in ('export_ready', 'completed')
      and request.export_completed_at is not null
      and request.export_sha256 is not null
      and request.export_object_path is not null, false),
    -- Gate 4: a recorded backup AND a verified restore. #261 gates on backup; a backup nobody
    -- has restored is a claim, not evidence, so both are required until an owner says otherwise.
    'backup_present', exists (
      select 1 from private.organization_purge_backup_evidence evidence
      where evidence.org_id = p_org_id
        and evidence.restore_verified_at is not null),
    'eligible', request.id is not null
      and coalesce(
        request.operational_purge_eligible_at <= now()
        and request.security_logs_retain_until <= now()
        and request.financial_records_retain_until <= now(), false)
      and coalesce(request.legal_hold, true) = false
      and coalesce(
        request.status in ('export_ready', 'completed')
        and request.export_completed_at is not null
        and request.export_sha256 is not null
        and request.export_object_path is not null, false)
      and exists (
        select 1 from private.organization_purge_backup_evidence evidence
        where evidence.org_id = p_org_id
          and evidence.restore_verified_at is not null))
  from (select p_org_id as requested_id) requested
  left join lateral (
    select * from public.organization_offboarding_requests candidate
    where candidate.org_id = requested.requested_id
      and candidate.status in ('export_ready', 'completed')
    order by candidate.requested_at desc
    limit 1
  ) request on true
$$;
revoke all on function private.organization_purge_gates(uuid)
  from public, anon, authenticated, service_role;

-- =====================================================================================
-- 4. The candidate report
-- =====================================================================================
-- STABLE, so it structurally cannot write, and every gate is reported separately: an operator
-- approving a batch has to be able to see WHICH gate a tenant fails, not just that it does.
create function public.platform_purge_candidates()
returns table (
  org_id             uuid,
  organization_name  text,
  offboarding_request_id uuid,
  requested_at       timestamptz,
  retention_eligible boolean,
  legal_hold_clear   boolean,
  export_ready       boolean,
  backup_present     boolean,
  eligible           boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select organization.id, organization.name,
         (gates.value ->> 'offboarding_request_id')::uuid,
         request.requested_at,
         (gates.value ->> 'retention_eligible')::boolean,
         (gates.value ->> 'legal_hold_clear')::boolean,
         (gates.value ->> 'export_ready')::boolean,
         (gates.value ->> 'backup_present')::boolean,
         (gates.value ->> 'eligible')::boolean
  from public.organizations organization
  cross join lateral (select private.organization_purge_gates(organization.id) as value) gates
  left join public.organization_offboarding_requests request
    on request.id = (gates.value ->> 'offboarding_request_id')::uuid
  where public.is_platform_admin()
    and public.platform_has_capability('offboarding.handle')
    and gates.value ->> 'offboarding_request_id' is not null
  order by request.requested_at
$$;
revoke all on function public.platform_purge_candidates() from public, anon, service_role;
grant execute on function public.platform_purge_candidates() to authenticated;

create function public.platform_purge_batches()
returns table (
  id uuid, approved_by uuid, approved_at timestamptz, reason text,
  tenant_count bigint, purged_count bigint, skipped_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select batch.id, batch.approved_by, batch.approved_at, batch.reason,
         (select count(*) from private.organization_purge_manifest_items item
          where item.batch_id = batch.id),
         (select count(*) from private.organization_purge_executions run
          where run.batch_id = batch.id and run.outcome = 'purged'),
         (select count(*) from private.organization_purge_executions run
          where run.batch_id = batch.id and run.outcome = 'skipped')
  from private.organization_purge_batches batch
  where public.is_platform_admin()
    and public.platform_has_capability('offboarding.handle')
  order by batch.approved_at desc
$$;
revoke all on function public.platform_purge_batches() from public, anon, service_role;
grant execute on function public.platform_purge_batches() to authenticated;

create function public.platform_purge_batch_items(p_batch_id uuid)
returns table (
  org_id uuid, organization_name text, gates_at_approval jsonb,
  outcome text, skip_reason text, executed_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select item.org_id, item.organization_name, item.gates_at_approval,
         run.outcome, run.skip_reason, run.executed_at
  from private.organization_purge_manifest_items item
  left join private.organization_purge_executions run
    on run.batch_id = item.batch_id and run.org_id = item.org_id
  where item.batch_id = p_batch_id
    and public.is_platform_admin()
    and public.platform_has_capability('offboarding.handle')
  order by item.organization_name
$$;
revoke all on function public.platform_purge_batch_items(uuid) from public, anon, service_role;
grant execute on function public.platform_purge_batch_items(uuid) to authenticated;

-- =====================================================================================
-- 5. Recording backup and restore evidence
-- =====================================================================================
create function public.record_organization_purge_backup_evidence(
  p_org_id uuid,
  p_backup_reference text,
  p_backup_taken_at timestamptz,
  p_restore_verified_at timestamptz,
  p_reason text
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor     uuid := auth.uid();
  v_reference text := nullif(trim(p_backup_reference), '');
  v_reason    text := nullif(trim(p_reason), '');
  v_id        uuid;
begin
  if v_actor is null or not public.is_platform_admin()
     or not public.platform_has_capability('offboarding.handle') then
    raise exception 'not_platform_admin' using errcode = '42501';
  end if;
  if p_org_id is null or v_reference is null or v_reason is null
     or p_backup_taken_at is null then
    raise exception 'purge_backup_evidence_invalid' using errcode = '22023';
  end if;
  perform public.assert_recent_password_authentication();
  if not exists (select 1 from public.organizations where id = p_org_id) then
    raise exception 'organization_unknown' using errcode = 'P0002';
  end if;

  insert into private.organization_purge_backup_evidence
    (org_id, backup_reference, backup_taken_at, restore_verified_at, recorded_by, reason)
  values (p_org_id, v_reference, p_backup_taken_at, p_restore_verified_at, v_actor, v_reason)
  returning id into v_id;

  perform private.record_security_event(
    p_org_id, v_actor, 'org_lifecycle_change',
    jsonb_build_object('event', 'purge_backup_evidence_recorded',
                       'restore_verified', p_restore_verified_at is not null));
  return v_id;
end
$$;
revoke all on function public.record_organization_purge_backup_evidence(
  uuid, text, timestamptz, timestamptz, text) from public, anon, service_role;
grant execute on function public.record_organization_purge_backup_evidence(
  uuid, text, timestamptz, timestamptz, text) to authenticated;

-- =====================================================================================
-- 6. Batch approval -- step-up, reason, manifest
-- =====================================================================================
-- The approved list is snapshotted into the manifest together with the gate values that were
-- true at approval time. Nothing later re-derives the list.
create function public.approve_organization_purge_batch(
  p_org_ids uuid[],
  p_reason text
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := auth.uid();
  v_reason text := nullif(trim(p_reason), '');
  v_batch  uuid;
  v_org    record;
  v_gates  jsonb;
  v_count  integer := 0;
begin
  if v_actor is null or not public.is_platform_admin()
     or not public.platform_has_capability('offboarding.handle') then
    raise exception 'not_platform_admin' using errcode = '42501';
  end if;
  if v_reason is null or p_org_ids is null or array_length(p_org_ids, 1) is null then
    raise exception 'purge_batch_invalid' using errcode = '22023';
  end if;
  perform public.assert_recent_password_authentication();

  insert into private.organization_purge_batches (approved_by, reason)
  values (v_actor, v_reason) returning id into v_batch;

  for v_org in
    select distinct organization.id, organization.name
    from unnest(p_org_ids) as requested(org_id)
    join public.organizations organization on organization.id = requested.org_id
    order by organization.name
  loop
    v_gates := private.organization_purge_gates(v_org.id);
    if not (v_gates ->> 'eligible')::boolean then
      raise exception 'purge_candidate_not_eligible: %', v_gates using errcode = '42501';
    end if;
    insert into private.organization_purge_manifest_items
      (batch_id, org_id, organization_name, offboarding_request_id, gates_at_approval)
    values (v_batch, v_org.id, v_org.name,
            (v_gates ->> 'offboarding_request_id')::uuid, v_gates);
    v_count := v_count + 1;
    perform private.record_security_event(
      v_org.id, v_actor, 'org_lifecycle_change',
      jsonb_build_object('event', 'purge_batch_approved', 'batch_id', v_batch));
  end loop;

  if v_count <> array_length(p_org_ids, 1) then
    raise exception 'purge_batch_unknown_organization' using errcode = 'P0002';
  end if;
  return v_batch;
end
$$;
revoke all on function public.approve_organization_purge_batch(uuid[], text)
  from public, anon, service_role;
grant execute on function public.approve_organization_purge_batch(uuid[], text) to authenticated;

comment on function public.approve_organization_purge_batch(uuid[], text) is
  'Platform Admin approval of a purge batch (#261): step-up, a reason, and an immutable '
  'manifest of exactly the organizations approved. Execution replays this manifest.';

-- =====================================================================================
-- 7. The executor
-- =====================================================================================
-- ONE argument: the approval. There is no candidate query in this body, no date predicate that
-- selects a target, and no way in for anything that is not a signed-in Platform Admin holding
-- offboarding.handle who has just re-entered their password.
--
-- WHY A PERSON AND NOT service_role. It would be easier to make this a service command a worker
-- calls. That is precisely what #261 forbids: "אין מחיקה אוטומטית רק בגלל שעון". A service
-- command is reachable by a scheduler; this one is not reachable by anything that cannot present
-- a platform-admin JWT with a fresh password AMR claim, which no cron job has. The requirement
-- and the guard bypass point the same way -- organization_row_write_guard's platform-admin lever
-- (0103:2227) is what lets a purge touch a tenant that is, by definition, not active.
create function public.execute_organization_purge_batch(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := auth.uid();
  v_batch    private.organization_purge_batches;
  v_item     record;
  v_gates    jsonb;
  v_removed  jsonb;
  v_purged   integer := 0;
  v_skipped  integer := 0;
begin
  if v_actor is null or not public.is_platform_admin()
     or not public.platform_has_capability('offboarding.handle') then
    raise exception 'not_platform_admin' using errcode = '42501';
  end if;
  perform public.assert_recent_password_authentication();

  select * into v_batch from private.organization_purge_batches where id = p_batch_id;
  if not found then
    raise exception 'purge_batch_unknown' using errcode = 'P0002';
  end if;
  if exists (select 1 from private.organization_purge_executions
             where batch_id = v_batch.id) then
    raise exception 'purge_batch_already_executed' using errcode = '42501';
  end if;

  -- REPLAY THE MANIFEST. Not the candidate query.
  for v_item in
    select item.org_id, item.organization_name
    from private.organization_purge_manifest_items item
    where item.batch_id = v_batch.id
    order by item.organization_name
  loop
    -- Lock this tenant, then re-derive every gate. Per tenant, not per batch: a tenant that
    -- changed since approval is skipped and the rest of the batch continues.
    perform 1 from public.organizations where id = v_item.org_id for update;
    if not found then
      insert into private.organization_purge_executions (batch_id, org_id, outcome, skip_reason)
      values (v_batch.id, v_item.org_id, 'skipped', 'organization_absent');
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_gates := private.organization_purge_gates(v_item.org_id);
    if not (v_gates ->> 'eligible')::boolean then
      insert into private.organization_purge_executions (batch_id, org_id, outcome, skip_reason)
      values (v_batch.id, v_item.org_id, 'skipped',
              'gates_changed_since_approval: ' || v_gates::text);
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- The forensic event goes first: security_events carries a foreign key to organizations
    -- (0060:82), so it is unwritable one statement later. It is also removed with the tenant --
    -- which is why the durable record of this deletion is the append-only execution row below,
    -- and not the security log.
    perform private.record_security_event(
      v_item.org_id, v_actor, 'org_lifecycle_change',
      jsonb_build_object('event', 'purge_executed', 'batch_id', v_batch.id));

    v_removed := private.delete_tenant_rows(v_item.org_id);
    perform private.delete_tenant_organization_row(v_item.org_id);

    insert into private.organization_purge_executions
      (batch_id, org_id, outcome, removed_row_counts)
    values (v_batch.id, v_item.org_id, 'purged', v_removed);
    v_purged := v_purged + 1;
  end loop;

  return jsonb_build_object('batch_id', v_batch.id, 'purged', v_purged, 'skipped', v_skipped);
end
$$;
revoke all on function public.execute_organization_purge_batch(uuid)
  from public, anon, service_role;
grant execute on function public.execute_organization_purge_batch(uuid) to authenticated;

comment on function public.execute_organization_purge_batch(uuid) is
  'Replays one approved purge manifest (#261). Platform Admin only, with step-up: no scheduler '
  'can present the JWT this requires. Locks and re-gates every tenant individually, deletes in '
  'stages derived from the live foreign-key graph, and records an outcome per tenant.';

-- =====================================================================================
-- 8. Structural re-assertion (mandatory after 0057)
-- =====================================================================================
do $assert_0197$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0197 scope assertions failed:\n%', v_violations;
  end if;
  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0197 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0197$;

-- =====================================================================================
-- 9. Anchors
-- =====================================================================================
do $anchor_0197$
begin
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'private'
      and table_name in ('organization_purge_batches', 'organization_purge_manifest_items',
                         'organization_purge_executions', 'organization_purge_backup_evidence')
      and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
  ) then
    raise exception '0197: a browser or service role holds a grant on the purge ledger';
  end if;

  -- The executor takes exactly one argument -- an approval id -- and is reachable by no role
  -- that a scheduler can hold.
  if exists (
    select 1 from information_schema.role_routine_grants
    where routine_schema = 'public'
      and routine_name = 'execute_organization_purge_batch'
      and grantee in ('anon', 'service_role')
  ) then
    raise exception '0197: an anonymous or service role can execute the purge executor';
  end if;
  if (select pronargs from pg_catalog.pg_proc
      where oid = 'public.execute_organization_purge_batch(uuid)'::regprocedure) <> 1 then
    raise exception '0197: the purge executor grew an argument';
  end if;
  if coalesce((
    select p.prosrc from pg_catalog.pg_proc p
    where p.oid = 'public.execute_organization_purge_batch(uuid)'::regprocedure
  ), '') !~ 'assert_recent_password_authentication' then
    raise exception '0197: the purge executor lost its step-up assertion';
  end if;

  -- No scheduled job may name the executor. pg_cron is installed on this stack.
  if to_regclass('cron.job') is not null then
    if exists (
      select 1 from cron.job
      where command like '%execute_organization_purge_batch%'
         or command like '%approve_organization_purge_batch%'
    ) then
      raise exception '0197: a scheduled job reaches the purge executor; #261 forbids a purge that happens because a clock elapsed';
    end if;
  end if;

  -- The report cannot write.
  if (select p.provolatile from pg_catalog.pg_proc p
      where p.oid = 'public.platform_purge_candidates()'::regprocedure) = 'v' then
    raise exception '0197: the purge candidate report is VOLATILE and could therefore write';
  end if;

  -- Approval demands a fresh password.
  if coalesce((
    select p.prosrc from pg_catalog.pg_proc p
    where p.oid = 'public.approve_organization_purge_batch(uuid[],text)'::regprocedure
  ), '') !~ 'assert_recent_password_authentication' then
    raise exception '0197: purge batch approval lost its step-up assertion';
  end if;
end
$anchor_0197$;
