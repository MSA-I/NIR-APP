-- 0138: A bad automatic crop or a terminal scan failure can be corrected without mutating
-- either the original upload or the previous scan output. The correction creates a new
-- awaiting-scan/scan-job pair and links it to the superseded attempt for idempotency.

alter table public.document_scan_jobs
  add column recovered_from_scan_job_id uuid,
  add constraint document_scan_jobs_recovery_not_self_check check (
    recovered_from_scan_job_id is null or recovered_from_scan_job_id <> id
  ),
  add constraint document_scan_jobs_recovery_tenant_fk
    foreign key (org_id, recovered_from_scan_job_id)
    references public.document_scan_jobs(org_id, id) on delete restrict;

create unique index document_scan_jobs_recovery_source_key
  on public.document_scan_jobs (org_id, recovered_from_scan_job_id)
  where recovered_from_scan_job_id is not null;

create or replace function public.guard_document_scan_job()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_manual_retry boolean := coalesce(
    current_setting('app.document_scan_manual_retry', true) = old.id::text, false
  );
  v_claim_write boolean := coalesce(
    auth.role() = 'service_role'
    and current_setting('app.document_scan_claim_job', true) = old.id::text, false
  );
begin
  if new.org_id is distinct from old.org_id
     or new.document_id is distinct from old.document_id
     or new.processing_job_id is distinct from old.processing_job_id
     or new.requested_by is distinct from old.requested_by
     or new.input_checksum is distinct from old.input_checksum
     or new.requested_mode is distinct from old.requested_mode
     or new.recovered_from_scan_job_id is distinct from old.recovered_from_scan_job_id
     or new.priority is distinct from old.priority
     or new.created_at is distinct from old.created_at
     or new.attempt_count < old.attempt_count then
    raise exception 'document_scan_job_identity_immutable' using errcode = '42501';
  end if;
  if new.processing_attempt_id is distinct from old.processing_attempt_id
     or new.processing_attempt_started_at is distinct from old.processing_attempt_started_at then
    if not v_claim_write
       or new.status <> 'processing'
       or new.processing_attempt_id is null
       or new.processing_attempt_started_at is null
       or new.attempt_count <> old.attempt_count + 1 then
      raise exception 'document_scan_attempt_immutable' using errcode = '42501';
    end if;
  end if;
  if new.manual_corners is distinct from old.manual_corners
     and not (
       old.status = 'needs_corners' and new.status = 'queued'
       and v_manual_retry and new.manual_corners is not null
     ) then
    raise exception 'document_scan_corners_rpc_required' using errcode = '42501';
  end if;
  if old.status = 'queued' and new.status not in ('queued', 'processing', 'failed') then
    raise exception 'document_scan_transition_invalid' using errcode = '23514';
  elsif old.status = 'processing'
        and new.status not in ('processing', 'queued', 'needs_corners', 'ready', 'failed') then
    raise exception 'document_scan_transition_invalid' using errcode = '23514';
  elsif old.status = 'needs_corners' and new.status not in ('needs_corners', 'queued') then
    raise exception 'document_scan_transition_invalid' using errcode = '23514';
  elsif old.status = 'ready' and new.status not in ('ready', 'accepted') then
    raise exception 'document_scan_transition_invalid' using errcode = '23514';
  elsif old.status in ('accepted', 'failed') and new.status <> old.status then
    raise exception 'document_scan_terminal_state' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end
$$;

create or replace function public.reject_superseded_scan_acceptance()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1 from public.document_scan_jobs successor
    where successor.org_id = new.org_id
      and successor.recovered_from_scan_job_id = new.scan_job_id
  ) then
    raise exception 'document_scan_superseded_by_recovery' using errcode = '55000';
  end if;
  return new;
end
$$;

create trigger document_scan_recovery_acceptance_fence_trg
  before insert on public.document_scan_decisions
  for each row execute function public.reject_superseded_scan_acceptance();

revoke all on function public.reject_superseded_scan_acceptance()
  from public, anon, authenticated, service_role;

create or replace function public.recover_document_scan(
  p_scan_job_id uuid,
  p_corners jsonb,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_reason text := nullif(trim(p_reason), '');
  v_old public.document_scan_jobs;
  v_old_processing public.document_processing_jobs;
  v_successor public.document_scan_jobs;
  v_processing_job_id uuid;
begin
  if v_org is null or v_actor is null or auth_role() not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if not public.document_scan_corners_valid(p_corners) then
    raise exception 'invalid_scan_corners' using errcode = '22023';
  end if;
  if v_reason is null or length(v_reason) not between 3 and 500 then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select scan.* into v_old
  from public.document_scan_jobs scan
  join public.documents document
    on document.org_id = scan.org_id and document.id = scan.document_id
  where scan.org_id = v_org and scan.id = p_scan_job_id
    and document.deleted_at is null
    and (document.unit_id is null or document.unit_id = any(public.auth_scopes()))
  for update of scan;
  if not found then raise exception 'document_scan_unknown' using errcode = 'P0002'; end if;

  if v_old.status = 'accepted' or exists (
    select 1 from public.document_scan_decisions decision
    where decision.org_id = v_org and decision.scan_job_id = v_old.id
  ) then
    raise exception 'accepted_document_scan_immutable' using errcode = '55000';
  end if;
  if v_old.status not in ('ready', 'failed') then
    raise exception 'document_scan_recovery_unavailable' using errcode = '55000';
  end if;

  select successor.* into v_successor
  from public.document_scan_jobs successor
  where successor.org_id = v_org
    and successor.recovered_from_scan_job_id = v_old.id;
  if found then
    return jsonb_build_object(
      'scan_job_id', v_successor.id,
      'processing_job_id', v_successor.processing_job_id,
      'status', v_successor.status,
      'idempotent', true
    );
  end if;

  select * into v_old_processing
  from public.document_processing_jobs processing
  where processing.org_id = v_org and processing.id = v_old.processing_job_id
  for update;
  if not found or v_old_processing.status <> 'awaiting_scan' then
    raise exception 'document_scan_processing_state_invalid' using errcode = '55000';
  end if;

  update public.document_processing_jobs
  set status = 'failed',
      last_error_code = 'superseded_by_scan_recovery',
      last_error_message = 'Document scan boundaries were corrected by a human reviewer'
  where id = v_old_processing.id;

  insert into public.document_processing_jobs (
    org_id, document_id, requested_by, status, input_checksum,
    contract_version, priority, scan_output_id
  ) values (
    v_org, v_old.document_id, v_actor, 'awaiting_scan', v_old.input_checksum,
    v_old_processing.contract_version, v_old_processing.priority, null
  ) returning id into v_processing_job_id;

  insert into public.document_scan_jobs (
    org_id, document_id, processing_job_id, requested_by, status,
    input_checksum, requested_mode, manual_corners, priority,
    recovered_from_scan_job_id
  ) values (
    v_org, v_old.document_id, v_processing_job_id, v_actor, 'queued',
    v_old.input_checksum, v_old.requested_mode, p_corners, v_old.priority,
    v_old.id
  ) returning * into v_successor;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_org, v_actor, 'document_scan_recovered', 'document_scan_jobs', v_successor.id,
    jsonb_build_object(
      'document_id', v_old.document_id,
      'superseded_scan_job_id', v_old.id,
      'successor_processing_job_id', v_processing_job_id,
      'previous_output_preserved', exists (
        select 1 from public.document_scan_outputs output
        where output.org_id = v_org and output.scan_job_id = v_old.id
      )
    ), v_reason
  );

  return jsonb_build_object(
    'scan_job_id', v_successor.id,
    'processing_job_id', v_processing_job_id,
    'status', 'queued',
    'idempotent', false
  );
end
$$;

revoke all on function public.recover_document_scan(uuid, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.recover_document_scan(uuid, jsonb, text) to authenticated;

insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
)
select 'recover_document_scan(uuid,jsonb,text)', md5(replace(proc.prosrc, e'\r', '')),
       'rls-preread-single-unit',
       '0138 locks the source scan only through its auth_org document and canonical null-or-auth_scopes unit predicate before creating the successor.'
from pg_catalog.pg_proc proc
where proc.oid = 'public.recover_document_scan(uuid,jsonb,text)'::regprocedure
on conflict (function_signature) do update set
  body_hash = excluded.body_hash,
  enforcement_kind = excluded.enforcement_kind,
  scope_proof = excluded.scope_proof;

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
where registry.table_name = 'document_scan_jobs';

do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0138 scope assertions failed:\n%', v_violations;
  end if;
  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0138 tenant export assertions failed:\n%', v_violations;
  end if;
end
$$;
