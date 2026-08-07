-- 0083 -- Avoid PL/pgSQL output-variable ambiguity in the dispatch upsert conflict target.
create or replace function private.claim_document_interpretation_jobs(
  p_limit integer,
  p_max_starts_per_org_hour integer
) returns table (job_id uuid)
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_candidate record;
begin
  if p_limit not between 1 and 100
     or p_max_starts_per_org_hour not between 1 and 100 then
    raise exception 'document_interpretation_dispatch_limit_invalid' using errcode = '22023';
  end if;

  for v_candidate in
    with eligible as (
      select j.id, j.org_id, j.created_at,
             row_number() over (
               partition by j.org_id order by j.created_at, j.id
             ) as tenant_position
      from public.document_processing_jobs j
      join public.documents d
        on d.org_id = j.org_id and d.id = j.document_id and d.deleted_at is null
      join public.document_extractions e
        on e.org_id = j.org_id and e.job_id = j.id and e.document_id = d.id
       and e.input_checksum = j.input_checksum and e.contract_version = j.contract_version
      join public.profiles p
        on p.org_id = j.org_id and p.id = d.uploaded_by and p.active
       and p.role in ('owner', 'office', 'kitchen', 'supplier')
      join public.organizations o
        on o.id = j.org_id and o.status in ('trial', 'active')
      left join private.document_interpretation_dispatches sent on sent.job_id = j.id
      where j.status = 'extracted'
        and j.requested_by = d.uploaded_by
        and not exists (
          select 1 from public.document_interpretations i
          where i.org_id = j.org_id and i.job_id = j.id
        )
        and (
          sent.job_id is null
          or sent.last_dispatched_at <= clock_timestamp() - interval '5 minutes'
        )
        and (
          select count(*)
          from public.document_processing_jobs recent
          where recent.org_id = j.org_id
            and recent.interpretation_started_at
              >= clock_timestamp() - interval '1 hour'
        ) < p_max_starts_per_org_hour
    )
    select id, org_id
    from eligible
    where tenant_position = 1
    order by created_at, id
    limit p_limit
  loop
    perform 1
    from public.document_processing_jobs j
    where j.id = v_candidate.id and j.status = 'extracted'
    for update skip locked;
    if not found then continue; end if;

    insert into private.document_interpretation_dispatches (
      job_id, org_id, last_dispatched_at, attempt_count
    ) values (
      v_candidate.id, v_candidate.org_id, clock_timestamp(), 1
    )
    on conflict on constraint document_interpretation_dispatches_pkey do update
      set last_dispatched_at = excluded.last_dispatched_at,
          attempt_count = private.document_interpretation_dispatches.attempt_count + 1;

    job_id := v_candidate.id;
    return next;
  end loop;
end
$$;
revoke all on function private.claim_document_interpretation_jobs(integer, integer)
  from public, anon, authenticated, service_role;
