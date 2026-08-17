-- 0141 — Page progress telemetry for document extraction.
--
-- The review screen could say "בעיבוד" and nothing else. Production measurements showed why that
-- is not enough: jobs sat in `queued` for 523, 614, 615 and 746 seconds before a worker claimed
-- them, and a 27-page scan then ran for 330 seconds of real work. From the outside those two are
-- one undifferentiated wait, so an owner watching a document reasonably concluded the upload was
-- broken. Queue time the screen can already derive from `created_at` and `processing_attempt_started_at`.
-- Page progress it cannot derive from anything, because nothing records it.
--
-- Three columns, written by the worker's existing heartbeat, and no invented number anywhere: a
-- job with no telemetry keeps NULL, and the read model returns NULL rather than a zero, because a
-- zero is a claim about the work and NULL is the truth that nobody has reported yet.
--
-- `progress_attempt_id` is the reason this is three columns and not two. A retried job keeps its
-- row, so without an attempt stamp the previous attempt's "page 7 of 27" would be displayed for
-- up to one heartbeat interval after a fresh claim. The read model returns progress only when the
-- stamp matches the live attempt, which makes that window impossible rather than short.

alter table public.document_processing_jobs
  add column progress_done integer,
  add column progress_total integer,
  add column progress_attempt_id uuid;

alter table public.document_processing_jobs
  add constraint document_processing_jobs_progress_check check (
    (progress_done is null and progress_total is null and progress_attempt_id is null)
    or (
      progress_done is not null and progress_total is not null and progress_attempt_id is not null
      and progress_done >= 0 and progress_total > 0 and progress_total <= 100
      and progress_done <= progress_total
    )
  );

comment on column public.document_processing_jobs.progress_done is
  'Pages the worker has finished transcribing in the attempt named by progress_attempt_id.';
comment on column public.document_processing_jobs.progress_total is
  'Pages that attempt intends to transcribe. Never larger than the 100-page extraction limit.';
comment on column public.document_processing_jobs.progress_attempt_id is
  'The processing attempt the two counters describe. A stale attempt is not displayed.';

-- Best effort by design. Progress is an observation about work in flight, never a state
-- transition: a worker whose lease has already moved on writes nothing and raises nothing, so a
-- late heartbeat can neither resurrect a finished job nor fail an attempt that is still healthy.
create function public.service_record_document_processing_progress(
  p_job_id uuid,
  p_lease_owner text,
  p_processing_attempt_id uuid,
  p_done integer,
  p_total integer
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner text := nullif(trim(p_lease_owner), '');
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if v_owner is null or length(v_owner) > 200 then
    raise exception 'lease_owner_invalid' using errcode = '22023';
  end if;
  -- Rejected rather than clamped. A worker reporting 130 of 27 pages is not a worker whose
  -- numbers should be quietly rounded into range; it is a worker whose output nobody should show.
  if p_processing_attempt_id is null
     or p_done is null or p_total is null
     or p_done < 0 or p_total <= 0 or p_total > 100 or p_done > p_total then
    raise exception 'document_processing_progress_invalid' using errcode = '22023';
  end if;
  update public.document_processing_jobs
  set progress_done = p_done,
      progress_total = p_total,
      progress_attempt_id = p_processing_attempt_id
  where id = p_job_id
    and status = 'leased'
    and lease_owner = v_owner
    and processing_attempt_id = p_processing_attempt_id;
end;
$$;

revoke all on function public.service_record_document_processing_progress(uuid, text, uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function public.service_record_document_processing_progress(uuid, text, uuid, integer, integer)
  to service_role;

comment on function public.service_record_document_processing_progress(uuid, text, uuid, integer, integer) is
  'Worker page-progress observation for a live lease. Silently ignores a lease or attempt that has moved on.';

-- Return type change, so the read model is replaced rather than amended. The body below is 0136's
-- verbatim -- the documents join, `deleted_at is null`, the canonical null-or-auth_scopes unit
-- predicate, the owner/office role gate and `scan_output_id` -- with two columns appended. None of
-- those may be dropped in passing: this function is registered in private.scope_definer_enforcements
-- as a `filtered_read`, and its scope proof names that unit predicate specifically.
drop function public.get_document_processing_statuses(uuid[]);

create function public.get_document_processing_statuses(
  p_document_ids uuid[] default null
) returns table (
  id uuid,
  org_id uuid,
  document_id uuid,
  requested_by uuid,
  status text,
  input_checksum text,
  contract_version text,
  priority smallint,
  attempt_count integer,
  lease_owner text,
  lease_until timestamptz,
  processing_attempt_id uuid,
  processing_attempt_started_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz,
  updated_at timestamptz,
  scan_output_id uuid,
  queue_age_seconds bigint,
  is_stuck boolean,
  stuck_reason text,
  progress_done integer,
  progress_total integer
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth_org() is null or auth.uid() is null
     or auth_role() not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_document_ids is not null and cardinality(p_document_ids) > 500 then
    raise exception 'too_many_document_ids' using errcode = '22023';
  end if;

  return query
  select job.id, job.org_id, job.document_id, job.requested_by, job.status,
         job.input_checksum, job.contract_version, job.priority, job.attempt_count,
         job.lease_owner, job.lease_until, job.processing_attempt_id,
         job.processing_attempt_started_at, job.last_error_code, job.last_error_message,
         job.created_at, job.updated_at, job.scan_output_id,
         case when job.status in ('awaiting_scan', 'queued', 'leased', 'extracted', 'interpreting')
              then extract(epoch from (statement_timestamp() - job.created_at))::bigint
              else null end,
         health.stuck_reason is not null,
         health.stuck_reason,
         -- Only a live lease reporting on the attempt that is actually running. Everything else
         -- is NULL, which the screen renders as an unknown rather than as a number.
         case when job.status = 'leased'
               and job.progress_attempt_id is not distinct from job.processing_attempt_id
              then job.progress_done else null end,
         case when job.status = 'leased'
               and job.progress_attempt_id is not distinct from job.processing_attempt_id
              then job.progress_total else null end
  from public.document_processing_jobs job
  join public.documents document
    on document.org_id = job.org_id and document.id = job.document_id
  cross join lateral (
    select private.document_processing_stuck_reason(
      job.status, job.attempt_count, job.created_at, job.updated_at, job.lease_until,
      statement_timestamp()
    ) as stuck_reason
  ) health
  where job.org_id = auth_org()
    and document.deleted_at is null
    and (document.unit_id is null or document.unit_id = any(public.auth_scopes()))
    and (p_document_ids is null or job.document_id = any(p_document_ids))
  order by job.created_at desc, job.id desc;
end
$$;

revoke all on function public.get_document_processing_statuses(uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.get_document_processing_statuses(uuid[]) to authenticated;

comment on function public.get_document_processing_statuses(uuid[]) is
  'Tenant-scoped owner/office processing rows with server-evaluated queue age, stuck verdict and live page progress.';

-- Replacing the body changes its md5, so the pinned enforcement hash has to be recomputed here or
-- every later migration fails A5 with "stale scope enforcement registration". Computed from
-- pg_proc rather than written as a literal: a hardcoded digest is a value that has to be produced
-- on a machine whose line endings match CI's, and this one cannot drift.
update private.scope_definer_enforcements enforcement
set body_hash = md5(replace(proc.prosrc, e'\r', '')),
    scope_proof = '0141 returns processing state only for auth_org documents passing the canonical '
      || 'null-or-auth_scopes unit predicate, and page progress only for the live attempt.'
from pg_catalog.pg_proc proc
where proc.oid = pg_catalog.to_regprocedure('public.get_document_processing_statuses(uuid[])')
  and enforcement.function_signature = 'get_document_processing_statuses(uuid[])';

-- The registry pins a column list and a schema hash per exported table, so three new columns make
-- the recorded hash wrong until it is recomputed here. They are ordinary tenant data and stay
-- exported; only lease_owner and lease_until remain excluded, as before.
update private.tenant_export_registry registry
set exported_columns=(select array_agg(column_info.column_name order by column_info.ordinal_position)
    from information_schema.columns column_info where column_info.table_schema='public'
      and column_info.table_name=registry.table_name
      and not (column_info.column_name=any(registry.excluded_columns))),
    schema_hash=(select md5(string_agg(
      column_info.column_name||':'||column_info.data_type||':'||column_info.is_nullable,
      '|' order by column_info.ordinal_position))
    from information_schema.columns column_info where column_info.table_schema='public'
      and column_info.table_name=registry.table_name)
where registry.table_name = 'document_processing_jobs';

-- Self-check, asserting what a migration can actually prove about the new write path.
--
-- Note on what is deliberately NOT asserted here: the function opens with the project's standard
-- `if auth.role() <> 'service_role' then raise` guard, and that guard does not fire when there is
-- no JWT claim at all -- `null <> 'service_role'` is null, and `if null` is not taken. Every
-- service function in this schema is written the same way, so this is the house idiom rather than
-- a local defect, and it is not reachable in practice: the grants below are what actually keep
-- anon and authenticated out, and PostgREST always carries a role claim. The grants are therefore
-- the thing worth pinning.
do $$
declare
  v_signature text := 'public.service_record_document_processing_progress(uuid, text, uuid, integer, integer)';
  v_definition text;
begin
  if not has_function_privilege('service_role', v_signature, 'EXECUTE') then
    raise exception '0141 self-check: service_role cannot execute the progress writer';
  end if;
  if has_function_privilege('authenticated', v_signature, 'EXECUTE')
     or has_function_privilege('anon', v_signature, 'EXECUTE') then
    raise exception '0141 self-check: a tenant API role can execute the progress writer';
  end if;

  select pg_get_constraintdef(oid) into v_definition
  from pg_constraint
  where conrelid = 'public.document_processing_jobs'::regclass
    and conname = 'document_processing_jobs_progress_check';
  if v_definition is null then
    raise exception '0141 self-check: the progress constraint is not installed';
  end if;
  -- The three facts the screen depends on: the pair is all-or-nothing, a count never exceeds its
  -- own total, and a total never exceeds the extraction page limit.
  if position('progress_done <= progress_total' in v_definition) = 0
     or position('progress_total <= 100' in v_definition) = 0
     or position('progress_attempt_id IS NULL' in v_definition) = 0 then
    raise exception '0141 self-check: the progress constraint lost a bound: %', v_definition;
  end if;
end
$$;

do $$
declare v_violations text;
begin
  select string_agg(assertion||' -- '||detail,e'\n' order by assertion,detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then raise exception e'0141 scope assertions failed:\n%',v_violations; end if;
  select string_agg(detail,e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then raise exception e'0141 export assertions failed:\n%',v_violations; end if;
end
$$;
