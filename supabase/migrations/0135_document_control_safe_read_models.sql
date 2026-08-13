-- 0135 -- Customer-safe read models for the owner-only document control room.

create or replace function public.get_document_operations_metrics(
  p_window_days integer default 30
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_since timestamptz;
  v_result jsonb;
begin
  if public.auth_org() is null or auth.uid() is null or public.auth_role() <> 'owner' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_window_days is null or p_window_days < 1 or p_window_days > 365 then
    raise exception 'invalid_window_days' using errcode = '22023';
  end if;
  v_since := statement_timestamp() - make_interval(days => p_window_days);

  with visible_documents as (
    select document.id, document.org_id
    from public.documents document
    where document.org_id = public.auth_org()
      and document.deleted_at is null
      and (
        document.unit_id is null
        or document.unit_id = any(public.auth_scopes())
      )
  ), latest as (
    select distinct on (job.document_id) job.*
    from public.document_processing_jobs job
    join visible_documents document
      on document.org_id = job.org_id and document.id = job.document_id
    where job.org_id = public.auth_org()
    order by job.document_id, job.created_at desc, job.id desc
  ), current_jobs as (
    select job.*,
           private.document_processing_stuck_reason(
             job.status, job.attempt_count, job.created_at, job.updated_at, job.lease_until,
             statement_timestamp()
           ) as stuck_reason
    from latest job
  ), durations as (
    select extraction.duration_ms + interpretation.duration_ms as total_duration_ms
    from public.document_processing_jobs job
    join public.document_extractions extraction
      on extraction.org_id = job.org_id and extraction.job_id = job.id
    join public.document_interpretations interpretation
      on interpretation.org_id = job.org_id and interpretation.job_id = job.id
    join visible_documents document
      on document.org_id = job.org_id and document.id = job.document_id
    where job.org_id = public.auth_org() and job.created_at >= v_since
  )
  select jsonb_build_object(
    'window_days', p_window_days,
    'documents_waiting', count(*) filter (where job.status = 'queued' and job.stuck_reason is null),
    'documents_processing', count(*) filter (
      where job.status in ('leased', 'extracted', 'interpreting') and job.stuck_reason is null
    ),
    'documents_stuck', count(*) filter (where job.stuck_reason is not null),
    'documents_review_required', count(*) filter (where job.status = 'review'),
    'documents_failed', count(*) filter (where job.status = 'failed'),
    'documents_completed', count(*) filter (
      where job.status = 'completed' and job.updated_at >= v_since
    ),
    'retry_count', (
      select coalesce(sum(greatest(attempt_count - 1, 0)), 0)
      from public.document_processing_jobs
      where org_id = public.auth_org() and created_at >= v_since
    ),
    'average_processing_duration_ms', (
      select avg(total_duration_ms) from durations where total_duration_ms is not null
    ),
    'last_processing_at', max(job.updated_at)
  ) into v_result
  from current_jobs job;

  return v_result;
end
$$;

revoke all on function public.get_document_operations_metrics(integer)
  from public, anon, service_role;
grant execute on function public.get_document_operations_metrics(integer)
  to authenticated;

create function public.get_document_control_attempts(
  p_document_id uuid default null,
  p_limit integer default 100
) returns table (
  job_id uuid,
  document_id uuid,
  file_name text,
  status text,
  attempt_count integer,
  created_at timestamptz,
  updated_at timestamptz,
  queue_age_seconds bigint,
  price_list_outcome text,
  is_stuck boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if public.auth_org() is null or auth.uid() is null or public.auth_role() <> 'owner' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'invalid_limit' using errcode = '22023';
  end if;

  return query
  with ranked as (
    select job.*,
           row_number() over (
             partition by job.document_id order by job.created_at desc, job.id desc
           ) as document_rank
    from public.document_processing_jobs job
    where job.org_id = public.auth_org()
      and (p_document_id is null or job.document_id = p_document_id)
  ), selected as (
    select job.*,
           private.document_processing_stuck_reason(
             job.status, job.attempt_count, job.created_at, job.updated_at, job.lease_until,
             statement_timestamp()
           ) as stuck_reason
    from ranked job
    where p_document_id is not null or job.document_rank = 1
  )
  select job.id, job.document_id, document.file_name, job.status, job.attempt_count,
         job.created_at, job.updated_at,
         case when job.status in ('queued', 'leased', 'extracted', 'interpreting')
              then extract(epoch from (statement_timestamp() - job.created_at))::bigint
              else null end,
         decision.outcome,
         job.stuck_reason is not null
  from selected job
  join public.documents document
    on document.org_id = job.org_id and document.id = job.document_id
   and document.deleted_at is null
   and (
     document.unit_id is null
     or document.unit_id = any(public.auth_scopes())
   )
  left join public.document_interpretations interpretation
    on interpretation.org_id = job.org_id and interpretation.job_id = job.id
  left join public.price_list_interpretation_decisions decision
    on decision.org_id = job.org_id and decision.interpretation_id = interpretation.id
  order by job.created_at desc, job.id desc
  limit p_limit;
end
$$;

revoke all on function public.get_document_control_attempts(uuid, integer)
  from public, anon, service_role;
grant execute on function public.get_document_control_attempts(uuid, integer)
  to authenticated;

create function public.get_document_control_price_review_queue(
  p_document_limit integer default 50
) returns table (
  review_key text,
  document_id uuid,
  file_name text,
  supplier_name text,
  source_row integer,
  predicted_action text,
  product_name text,
  matched_product_name text,
  sku text,
  proposed_unit_price numeric,
  current_unit_price numeric,
  document_line_count bigint,
  document_reviewed_count bigint,
  is_empty_run boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if public.auth_org() is null or auth.uid() is null or public.auth_role() <> 'owner' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_document_limit is null or p_document_limit < 1 or p_document_limit > 50 then
    raise exception 'invalid_document_limit' using errcode = '22023';
  end if;

  return query
  with latest_review as (
    select distinct on (review.shadow_line_id) review.shadow_line_id, review.revision
    from public.price_list_calibration_reviews review
    where review.org_id = public.auth_org()
    order by review.shadow_line_id, review.revision desc
  ), latest_empty_review as (
    select distinct on (review.shadow_run_id) review.shadow_run_id, review.revision
    from public.price_list_empty_run_reviews review
    where review.org_id = public.auth_org()
    order by review.shadow_run_id, review.revision desc
  ), run_progress as (
    select run.id, run.created_at,
           count(line.id) as line_count,
           count(latest.shadow_line_id) as reviewed_count,
           bool_or(empty_review.shadow_run_id is not null) as empty_reviewed
    from public.price_list_shadow_runs run
    left join public.price_list_shadow_lines line
      on line.org_id = run.org_id and line.shadow_run_id = run.id
    left join latest_review latest on latest.shadow_line_id = line.id
    left join latest_empty_review empty_review on empty_review.shadow_run_id = run.id
    where run.org_id = public.auth_org()
    group by run.id, run.created_at
    having (count(line.id) > 0 and count(latest.shadow_line_id) < count(line.id))
        or (count(line.id) = 0 and not bool_or(empty_review.shadow_run_id is not null))
    order by run.created_at, run.id
    limit p_document_limit
  )
  select coalesce(line.id, run.id)::text,
         run.document_id,
         document.file_name,
         supplier.name,
         line.source_row,
         coalesce(line.predicted_action, 'review'),
         line.product_name,
         product.name,
         line.sku,
         line.proposed_unit_price,
         line.current_unit_price,
         progress.line_count,
         progress.reviewed_count,
         line.id is null
  from run_progress progress
  join public.price_list_shadow_runs run on run.id = progress.id
  left join public.price_list_shadow_lines line
    on line.org_id = run.org_id and line.shadow_run_id = run.id
  left join latest_review latest on latest.shadow_line_id = line.id
  join public.documents document
    on document.org_id = run.org_id and document.id = run.document_id
   and document.deleted_at is null
   and (
     document.unit_id is null
     or document.unit_id = any(public.auth_scopes())
   )
  left join public.suppliers supplier
    on supplier.org_id = run.org_id and supplier.id = run.supplier_id
  left join public.products product
    on product.org_id = run.org_id and product.id = line.product_id
  where line.id is null or latest.shadow_line_id is null
  order by progress.created_at, run.id, line.line_index;
end
$$;

revoke all on function public.get_document_control_price_review_queue(integer)
  from public, anon, service_role;
grant execute on function public.get_document_control_price_review_queue(integer)
  to authenticated;

-- The customer UI no longer consumes laboratory telemetry or raw processing internals.
revoke execute on function public.get_document_processing_attempts(uuid, integer) from authenticated;
revoke execute on function public.get_price_list_calibration_metrics(timestamptz, timestamptz) from authenticated;
revoke execute on function public.get_price_list_calibration_queue(integer) from authenticated;
revoke execute on function public.get_price_list_drift_metrics(integer) from authenticated;

comment on function public.get_document_operations_metrics(integer) is
  'Owner-only customer-safe document control summary; no provider, model, prompt, token, cost, confidence or drift telemetry.';
comment on function public.get_document_control_attempts(uuid, integer) is
  'Owner-only customer-safe document status list with tenant scope and server-evaluated stuck state.';
comment on function public.get_document_control_price_review_queue(integer) is
  'Owner-only business decision queue for price-list review; no model or confidence telemetry.';

-- Pin the reviewed tenant/unit predicates to the live function bodies. A later SECURITY DEFINER
-- edit that removes auth_scopes() or changes one of these bodies must fail A5 until re-reviewed.
insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
)
select reviewed.function_signature, md5(replace(proc.prosrc, e'\r', '')),
       'filtered_read', reviewed.scope_proof
from (values
  (
    'get_document_operations_metrics(integer)',
    '0135 derives one authenticated owner tenant, limits jobs to non-deleted documents in that tenant, and narrows every document through the canonical null-or-auth_scopes unit predicate.'
  ),
  (
    'get_document_control_attempts(uuid,integer)',
    '0135 derives one authenticated owner tenant and joins each attempt only to a non-deleted document visible through the canonical null-or-auth_scopes unit predicate.'
  ),
  (
    'get_document_control_price_review_queue(integer)',
    '0135 derives one authenticated owner tenant and returns review work only when its non-deleted document is visible through the canonical null-or-auth_scopes unit predicate.'
  )
) as reviewed(function_signature, scope_proof)
join pg_catalog.pg_proc proc
  on proc.oid = pg_catalog.to_regprocedure(reviewed.function_signature)
on conflict (function_signature) do update
  set body_hash = excluded.body_hash,
      enforcement_kind = excluded.enforcement_kind,
      scope_proof = excluded.scope_proof;

do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0135 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
