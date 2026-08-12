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
