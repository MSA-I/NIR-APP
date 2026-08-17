-- 0143 — Progress telemetry for the interpretation stage.
--
-- 0141 gave the review screen a page counter, and it only ever fills in for pages that go through
-- OCR. Measured on production the day after: two scanned documents reported 3/4 and 1/2, and every
-- price list reported nothing at all, because a PDF with a text layer needs no OCR page. The owner
-- watching a 338-line price list therefore saw a lifecycle strip with no bar under it for the whole
-- wait -- and the wait he was watching was not the reading at all. It was the interpretation: the
-- provider call, split by 0140's planner into up to four concurrent page-range chunks, each of
-- which takes far longer than reading the text layer did.
--
-- So the counter has to describe that stage too. Nothing about the counter changes: the same two
-- columns, the same "NULL is the truth nobody has reported yet" rule, the same refusal to invent a
-- number. What is added is `progress_stage`, which says WHICH stage the two numbers describe.
--
-- The stage column is not decoration and not a display hint. Without it, a job that finishes
-- reading at page 7 of 27 and moves on to interpretation would keep showing 7 of 27 while a
-- completely different piece of work ran -- the same class of lie 0141's `progress_attempt_id`
-- exists to prevent, one stage further along. The read model returns a counter only when its stage
-- is the stage the job is actually in, so a stale pair is unreachable rather than short-lived.
--
-- Why the interpretation writer is fenced on `interpretation_started_at` rather than on the lease:
-- the lease belongs to the OCR worker, which is finished and gone by then. The interpretation's own
-- fencing token is the one `fail_document_interpretation` and `save_document_interpretation`
-- already use, and reusing it means a retried interpretation cannot have its counter written by the
-- attempt it replaced.

alter table public.document_processing_jobs add column progress_stage text;

-- Everything recorded before this migration came from the OCR page loop, and 0141's writer is the
-- only thing that ever wrote those columns.
update public.document_processing_jobs
set progress_stage = 'reading'
where progress_done is not null;

alter table public.document_processing_jobs
  drop constraint document_processing_jobs_progress_check;

-- The bounds of 0141, plus the stage. `progress_attempt_id` stays mandatory for reading, where the
-- lease attempt is the fence; interpretation is fenced by `interpretation_started_at` in the writer
-- below, so it does not carry an attempt of its own.
alter table public.document_processing_jobs
  add constraint document_processing_jobs_progress_check check (
    (progress_done is null and progress_total is null and progress_stage is null)
    or (
      progress_done is not null and progress_total is not null
      and progress_stage in ('reading', 'interpretation')
      and progress_done >= 0 and progress_total > 0 and progress_total <= 100
      and progress_done <= progress_total
      and (progress_stage <> 'reading' or progress_attempt_id is not null)
    )
  );

comment on column public.document_processing_jobs.progress_stage is
  'Which stage the two counters describe: reading (OCR pages) or interpretation (provider chunks).';

-- 0141's writer, unchanged except that it now names its stage. Same signature, so the deployed
-- document-processing function keeps calling it without a redeploy.
create or replace function public.service_record_document_processing_progress(
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
  if p_processing_attempt_id is null
     or p_done is null or p_total is null
     or p_done < 0 or p_total <= 0 or p_total > 100 or p_done > p_total then
    raise exception 'document_processing_progress_invalid' using errcode = '22023';
  end if;
  update public.document_processing_jobs
  set progress_done = p_done,
      progress_total = p_total,
      progress_attempt_id = p_processing_attempt_id,
      progress_stage = 'reading'
  where id = p_job_id
    and status = 'leased'
    and lease_owner = v_owner
    and processing_attempt_id = p_processing_attempt_id;
end;
$$;

-- Best effort, exactly like the reading writer: a chunk that lands after the interpretation moved
-- on writes nothing and raises nothing. An observation must never be able to fail the work it
-- describes.
create function public.service_record_document_interpretation_progress(
  p_job_id uuid,
  p_interpretation_started_at timestamptz,
  p_done integer,
  p_total integer
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  -- Rejected rather than clamped, for the reason 0141 gives: a caller reporting 9 of 4 chunks is a
  -- caller whose numbers nobody should show.
  if p_interpretation_started_at is null
     or p_done is null or p_total is null
     or p_done < 0 or p_total <= 0 or p_total > 100 or p_done > p_total then
    raise exception 'document_interpretation_progress_invalid' using errcode = '22023';
  end if;
  update public.document_processing_jobs
  set progress_done = p_done,
      progress_total = p_total,
      progress_stage = 'interpretation'
  where id = p_job_id
    and status = 'interpreting'
    and interpretation_started_at = p_interpretation_started_at;
end;
$$;

revoke all on function public.service_record_document_interpretation_progress(uuid, timestamptz, integer, integer)
  from public, anon, authenticated;
grant execute on function public.service_record_document_interpretation_progress(uuid, timestamptz, integer, integer)
  to service_role;

comment on function public.service_record_document_interpretation_progress(uuid, timestamptz, integer, integer) is
  'Provider-chunk progress for a live interpretation attempt. Silently ignores an attempt that has moved on.';

-- 0141's read model with one change: a counter is returned only when its stage is the stage the job
-- is in. Return type is identical, so this replaces the body in place and the grant survives.
create or replace function public.get_document_processing_statuses(
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
         -- Reading counts only on a live lease reporting the running attempt; interpretation counts
         -- only while the interpretation is the work in flight. Everything else is NULL, which the
         -- screen renders as an unknown rather than as a number.
         case when (job.status = 'leased' and job.progress_stage = 'reading'
                    and job.progress_attempt_id is not distinct from job.processing_attempt_id)
                or (job.status = 'interpreting' and job.progress_stage = 'interpretation')
              then job.progress_done else null end,
         case when (job.status = 'leased' and job.progress_stage = 'reading'
                    and job.progress_attempt_id is not distinct from job.processing_attempt_id)
                or (job.status = 'interpreting' and job.progress_stage = 'interpretation')
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

comment on function public.get_document_processing_statuses(uuid[]) is
  'Tenant-scoped owner/office processing rows with server-evaluated queue age, stuck verdict and stage-matched progress.';

-- Replacing the body changes its md5, so the pinned enforcement hash is recomputed from pg_proc for
-- the reason 0141 gives: a literal digest is a value that has to be produced on a machine whose
-- line endings match CI's.
update private.scope_definer_enforcements enforcement
set body_hash = md5(replace(proc.prosrc, e'\r', '')),
    scope_proof = '0143 returns processing state only for auth_org documents passing the canonical '
      || 'null-or-auth_scopes unit predicate, and progress only for the stage the job is in.'
from pg_catalog.pg_proc proc
where proc.oid = pg_catalog.to_regprocedure('public.get_document_processing_statuses(uuid[])')
  and enforcement.function_signature = 'get_document_processing_statuses(uuid[])';

-- One new ordinary tenant column, so the recorded column list and schema hash are recomputed the
-- way 0141 recomputed them.
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

do $$
declare
  v_signature text := 'public.service_record_document_interpretation_progress(uuid, timestamptz, integer, integer)';
  v_definition text;
begin
  if not has_function_privilege('service_role', v_signature, 'EXECUTE') then
    raise exception '0143 self-check: service_role cannot execute the interpretation progress writer';
  end if;
  if has_function_privilege('authenticated', v_signature, 'EXECUTE')
     or has_function_privilege('anon', v_signature, 'EXECUTE') then
    raise exception '0143 self-check: a tenant API role can execute the interpretation progress writer';
  end if;

  select pg_get_constraintdef(oid) into v_definition
  from pg_constraint
  where conrelid = 'public.document_processing_jobs'::regclass
    and conname = 'document_processing_jobs_progress_check';
  if v_definition is null then
    raise exception '0143 self-check: the progress constraint is not installed';
  end if;
  -- The four facts the screen depends on: the pair is all-or-nothing, it names a stage, a count
  -- never exceeds its own total, and a total never exceeds the extraction page limit.
  if position('progress_done <= progress_total' in v_definition) = 0
     or position('progress_total <= 100' in v_definition) = 0
     or position('progress_stage IS NULL' in v_definition) = 0
     or position('interpretation' in v_definition) = 0 then
    raise exception '0143 self-check: the progress constraint lost a bound: %', v_definition;
  end if;
end
$$;

-- The stale-counter case this migration exists to close, asserted where it is actually decided:
-- both counter expressions in the read model have to name the stage, or a finished reading is
-- displayed as if it were the interpretation now running.
do $$
declare v_source text;
begin
  select prosrc into v_source from pg_catalog.pg_proc
  where oid = pg_catalog.to_regprocedure('public.get_document_processing_statuses(uuid[])');
  if v_source is null then
    raise exception '0143 self-check: the processing read model is missing';
  end if;
  if (length(v_source) - length(replace(v_source, 'progress_stage', ''))) / length('progress_stage') < 4 then
    raise exception '0143 self-check: the read model does not gate both counters on the stage';
  end if;
  if position('interpretation' in v_source) = 0 then
    raise exception '0143 self-check: the read model never returns an interpretation counter';
  end if;
end
$$;

do $$
declare v_violations text;
begin
  select string_agg(assertion||' -- '||detail,e'\n' order by assertion,detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then raise exception e'0143 scope assertions failed:\n%',v_violations; end if;
  select string_agg(detail,e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then raise exception e'0143 export assertions failed:\n%',v_violations; end if;
end
$$;
