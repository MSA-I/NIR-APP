-- 0130 — One server-side definition for stalled document processing.
--
-- The browser may render elapsed time, but it must not invent the operational verdict from its
-- own clock. This helper and the owner operations RPC use one persisted-facts contract so an
-- expired lease or an eight-hour-old active attempt is never presented as healthy work.

create or replace function private.document_processing_stuck_reason(
  p_status text,
  p_attempt_count integer,
  p_created_at timestamptz,
  p_updated_at timestamptz,
  p_lease_until timestamptz,
  p_evaluated_at timestamptz default statement_timestamp()
)
returns text
language sql
stable
set search_path = pg_catalog
as $$
  select case
    when p_status not in ('queued', 'leased', 'extracted', 'interpreting') then null
    when coalesce(p_attempt_count, 0) >= private.document_processing_claim_attempt_limit()
      then 'claim_attempt_limit_reached'
    when p_status = 'leased' and p_lease_until is not null and p_lease_until <= p_evaluated_at
      then 'lease_expired'
    when p_created_at is not null and p_created_at <= p_evaluated_at - interval '2 hours'
      then 'active_over_two_hours'
    when coalesce(p_attempt_count, 0) >= 3
      and p_updated_at is not null
      and p_updated_at <= p_evaluated_at - interval '30 minutes'
      then 'no_progress'
    else null
  end;
$$;

revoke all on function private.document_processing_stuck_reason(
  text, integer, timestamptz, timestamptz, timestamptz, timestamptz
) from public, anon, authenticated, service_role;

-- Keep the operations summary on the same classifier as the attempt list. A stuck current job
-- is its own mutually-exclusive bucket; it is neither healthy queued work nor work processing
-- "right now". The extra JSON key is additive, so existing clients keep their response shape.
create or replace function public.get_document_operations_metrics(
  p_window_days integer default 30
) returns jsonb
language plpgsql
stable
-- The private classifier is intentionally not executable by browser roles. This owner-only read
-- resolver therefore crosses that boundary as definer and repeats the tenant predicate in every
-- source CTE; RLS is not relied on inside this body.
security definer
set search_path = public, pg_temp
as $$
declare
  v_since timestamptz;
  v_result jsonb;
begin
  if auth_org() is null or auth.uid() is null or auth_role() <> 'owner' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_window_days is null or p_window_days < 1 or p_window_days > 365 then
    raise exception 'invalid_window_days' using errcode = '22023';
  end if;
  v_since := statement_timestamp() - make_interval(days => p_window_days);

  with jobs as (
    select j.*
    from public.document_processing_jobs j
    where j.org_id = auth_org()
  ), current_job_rows as (
    select distinct on (j.document_id) j.*
    from jobs j
    order by j.document_id, j.created_at desc, j.id desc
  ), current_jobs as (
    select j.*,
           private.document_processing_stuck_reason(
             j.status, j.attempt_count, j.created_at, j.updated_at, j.lease_until,
             statement_timestamp()
           ) as stuck_reason
    from current_job_rows j
  ), timed as (
    select j.id as job_id, e.duration_ms as extraction_duration_ms,
           i.duration_ms as interpretation_duration_ms,
           case when e.duration_ms is not null and i.duration_ms is not null
                then e.duration_ms + i.duration_ms else null end as total_duration_ms,
           i.usage
    from jobs j
    left join public.document_extractions e
      on e.org_id = j.org_id and e.job_id = j.id
    left join public.document_interpretations i
      on i.org_id = j.org_id and i.job_id = j.id
    where j.created_at >= v_since
  ), latest_failure as (
    select j.last_error_code, j.last_error_message, j.updated_at
    from jobs j
    where j.status = 'failed'
    order by j.updated_at desc, j.id desc
    limit 1
  ), latest_interpretation as (
    select i.provider, i.model, i.prompt_version, i.schema_version, i.created_at
    from public.document_interpretations i
    where i.org_id = auth_org()
    order by i.created_at desc, i.id desc
    limit 1
  ), price_counts as (
    select count(*) filter (where d.outcome = 'auto_applied') as automatically_applied,
           count(*) filter (where d.outcome = 'partially_applied') as partially_applied,
           count(*) filter (where d.outcome = 'queued_for_review') as review_required,
           count(*) filter (where d.reverted_at is not null) as reverted
    from public.price_list_interpretation_decisions d
    where d.org_id = auth_org() and d.created_at >= v_since
  )
  select jsonb_build_object(
    'window_days', p_window_days,
    'documents_waiting', count(*) filter (
      where j.status = 'queued' and j.stuck_reason is null
    ),
    'documents_processing', count(*) filter (
      where j.status in ('leased', 'extracted', 'interpreting')
        and j.stuck_reason is null
    ),
    'documents_stuck', count(*) filter (where j.stuck_reason is not null),
    'documents_completed', count(*) filter (where j.status = 'completed'),
    'documents_review_required', count(*) filter (where j.status = 'review'),
    'documents_failed', count(*) filter (where j.status = 'failed'),
    'oldest_queue_age_seconds', (
      select extract(epoch from (statement_timestamp() - min(created_at)))::bigint
      from current_jobs
      where status = 'queued' and stuck_reason is null
    ),
    'retry_count', (
      select coalesce(sum(greatest(attempt_count - 1, 0)), 0)
      from jobs where created_at >= v_since
    ),
    'average_processing_duration_ms', (
      select avg(total_duration_ms) from timed where total_duration_ms is not null
    ),
    'last_failure', (
      select jsonb_build_object(
        'code', last_error_code,
        'message', last_error_message,
        'at', updated_at
      ) from latest_failure
    ),
    'last_interpretation', (
      select jsonb_build_object(
        'provider', provider, 'model', model,
        'prompt_version', prompt_version, 'schema_version', schema_version,
        'at', created_at
      ) from latest_interpretation
    ),
    'usage', jsonb_build_object(
      'input_tokens', (
        select sum(case when jsonb_typeof(usage -> 'input_tokens') = 'number'
                        then (usage ->> 'input_tokens')::bigint end)
        from timed
      ),
      'cached_input_tokens', (
        select sum(case when jsonb_typeof(usage -> 'cached_input_tokens') = 'number'
                        then (usage ->> 'cached_input_tokens')::bigint end)
        from timed
      ),
      'output_tokens', (
        select sum(case when jsonb_typeof(usage -> 'output_tokens') = 'number'
                        then (usage ->> 'output_tokens')::bigint end)
        from timed
      ),
      'cost', null
    ),
    'automatically_classified', (
      select count(*) from public.audit_logs a
      where a.org_id = auth_org()
        and a.action = 'document_kind_classified_automatically'
        and a.created_at >= v_since
    ),
    'automatically_applied_documents', (
      select count(*) from (
        select a.document_id
        from public.document_auto_actions a
        where a.org_id = auth_org() and a.created_at >= v_since
        union
        select d.document_id
        from public.price_list_interpretation_decisions d
        where d.org_id = auth_org() and d.created_at >= v_since
          and d.outcome in ('auto_applied', 'partially_applied')
      ) applied
    ),
    'reprocessed_documents', (
      select count(*) from public.audit_logs a
      where a.org_id = auth_org()
        and a.action = 'document_processing_reprocessed'
        and a.created_at >= v_since
    ),
    'price_list_results', (
      select jsonb_build_object(
        'automatically_applied', automatically_applied,
        'partially_applied', partially_applied,
        'review_required', review_required,
        'reverted', reverted
      ) from price_counts
    ),
    'last_processing_at', (select max(updated_at) from jobs)
  ) into v_result
  from current_jobs j;

  return v_result;
end;
$$;

revoke all on function public.get_document_operations_metrics(integer)
  from public, anon, service_role;
grant execute on function public.get_document_operations_metrics(integer)
  to authenticated;

comment on function public.get_document_operations_metrics(integer) is
  'Owner operations summary with mutually exclusive healthy and stuck current-job counts.';

-- Tenant read model for galleries, inbox and upload surfaces. It preserves the job columns those
-- screens already consume and adds the server verdict; callers no longer need Date.now() to decide
-- whether an active row is healthy. Null means all rows visible under the existing table policy.
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
  queue_age_seconds bigint,
  is_stuck boolean,
  stuck_reason text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth_org() is null or auth.uid() is null
     or auth_role() not in ('owner', 'office', 'kitchen') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_document_ids is not null and cardinality(p_document_ids) > 500 then
    raise exception 'too_many_document_ids' using errcode = '22023';
  end if;

  return query
  select j.id, j.org_id, j.document_id, j.requested_by, j.status,
         j.input_checksum, j.contract_version, j.priority, j.attempt_count,
         j.lease_owner, j.lease_until, j.processing_attempt_id,
         j.processing_attempt_started_at, j.last_error_code, j.last_error_message,
         j.created_at, j.updated_at,
         case when j.status in ('queued', 'leased', 'extracted', 'interpreting')
              then extract(epoch from (statement_timestamp() - j.created_at))::bigint
              else null end,
         health.stuck_reason is not null,
         health.stuck_reason
  from public.document_processing_jobs j
  cross join lateral (
    select private.document_processing_stuck_reason(
      j.status, j.attempt_count, j.created_at, j.updated_at, j.lease_until,
      statement_timestamp()
    ) as stuck_reason
  ) health
  where j.org_id = auth_org()
    and (p_document_ids is null or j.document_id = any(p_document_ids))
  order by j.created_at desc, j.id desc;
end;
$$;

revoke all on function public.get_document_processing_statuses(uuid[])
  from public, anon, service_role;
grant execute on function public.get_document_processing_statuses(uuid[])
  to authenticated;

comment on function public.get_document_processing_statuses(uuid[]) is
  'Tenant-scoped owner/office/kitchen processing rows with server-evaluated queue age and stuck verdict.';

drop function public.get_document_processing_attempts(uuid, integer);

create function public.get_document_processing_attempts(
  p_document_id uuid default null,
  p_limit integer default 100
) returns table (
  job_id uuid,
  document_id uuid,
  previous_job_id uuid,
  status text,
  attempt_count integer,
  created_at timestamptz,
  updated_at timestamptz,
  queue_age_seconds bigint,
  lease_until timestamptz,
  processing_attempt_started_at timestamptz,
  last_error_code text,
  last_error_message text,
  is_stuck boolean,
  stuck_reason text,
  extraction_id uuid,
  extraction_engine text,
  extraction_model text,
  extraction_model_version text,
  extraction_duration_ms integer,
  interpretation_id uuid,
  provider text,
  interpretation_model text,
  prompt_version text,
  schema_version text,
  interpretation_duration_ms integer,
  document_type text,
  document_type_confidence numeric,
  supplier_confidence numeric,
  usage jsonb,
  usage_cost numeric,
  price_list_outcome text,
  price_list_reason_code text,
  price_list_applied_count integer,
  price_list_waiting_count integer
)
language plpgsql
stable
-- The private classifier is intentionally not executable by browser roles. This owner-only read
-- resolver therefore crosses that boundary as definer and repeats the tenant predicate in the
-- query; RLS is not relied on inside this body.
security definer
set search_path = public, pg_temp
as $$
begin
  if auth_org() is null or auth.uid() is null or auth_role() <> 'owner' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'invalid_limit' using errcode = '22023';
  end if;

  return query
  with ordered as (
    select j.*,
           lag(j.id) over (
             partition by j.document_id order by j.created_at, j.id
           ) as previous_job_id
    from public.document_processing_jobs j
    where j.org_id = auth_org()
      and (p_document_id is null or j.document_id = p_document_id)
  ), evaluated as (
    select j.*,
           private.document_processing_stuck_reason(
             j.status, j.attempt_count, j.created_at, j.updated_at, j.lease_until,
             statement_timestamp()
           ) as stuck_reason
    from ordered j
  )
  select j.id, j.document_id, j.previous_job_id, j.status, j.attempt_count,
         j.created_at, j.updated_at,
         case when j.status in ('queued', 'leased', 'extracted', 'interpreting')
              then extract(epoch from (statement_timestamp() - j.created_at))::bigint
              else null end,
         j.lease_until, j.processing_attempt_started_at,
         j.last_error_code, j.last_error_message,
         j.stuck_reason is not null, j.stuck_reason,
         e.id, e.engine, e.model, e.model_version, e.duration_ms,
         i.id, i.provider, i.model, i.prompt_version, i.schema_version, i.duration_ms,
         i.payload ->> 'document_type',
         case when jsonb_typeof(i.payload -> 'document_type_confidence') = 'number'
              then (i.payload ->> 'document_type_confidence')::numeric else null end,
         case when jsonb_typeof(i.payload -> 'supplier' -> 'confidence') = 'number'
              then (i.payload -> 'supplier' ->> 'confidence')::numeric else null end,
         i.usage,
         null::numeric,
         d.outcome, d.reason_code, d.accepted_count, d.waiting_count
  from evaluated j
  left join public.document_extractions e
    on e.org_id = j.org_id and e.job_id = j.id
  left join public.document_interpretations i
    on i.org_id = j.org_id and i.job_id = j.id
  left join public.price_list_interpretation_decisions d
    on d.org_id = j.org_id and d.interpretation_id = i.id
  order by j.created_at desc, j.id desc
  limit p_limit;
end
$$;

revoke all on function public.get_document_processing_attempts(uuid, integer)
  from public, anon, service_role;
grant execute on function public.get_document_processing_attempts(uuid, integer)
  to authenticated;

comment on function public.get_document_processing_attempts(uuid, integer) is
  'Owner operations history with server-evaluated active age, lease health and stuck reason.';

-- ===== A1/A3/A5 re-assertion =====

do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0130 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
