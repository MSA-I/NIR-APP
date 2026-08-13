-- 0129 — Authoritative document-processing claim circuit breaker.
--
-- Deploy only after the contract-v2 worker has drained any pre-existing over-cap leases.
-- The cap lives in the claim transaction so a crash, stale image or direct service RPC caller
-- cannot increment attempt_count indefinitely.

create or replace function private.document_processing_claim_attempt_limit()
returns integer
language sql
immutable
set search_path = pg_catalog
as $$
  select 8;
$$;

revoke all on function private.document_processing_claim_attempt_limit()
  from public, anon, authenticated, service_role;

drop function public.claim_document_processing_job(text, integer);

create function public.claim_document_processing_job(
  p_lease_owner text,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner text := nullif(trim(p_lease_owner), '');
  v_seconds integer := greatest(30, least(coalesce(p_lease_seconds, 120), 900));
  v_attempt_limit integer := private.document_processing_claim_attempt_limit();
  v_job public.document_processing_jobs;
  v_document public.documents;
  v_attempt_id uuid;
  v_recovery_lease_id uuid;
  v_recovery_evidence_sha256 text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_owner is null or length(v_owner) > 200 then
    raise exception 'lease_owner_invalid' using errcode = '22023';
  end if;

  loop
    select j.*
      into v_job
    from public.document_processing_jobs j
    where (
        j.status = 'queued'
        or (j.status = 'leased' and j.lease_until <= statement_timestamp())
      )
      and private.organization_write_allowed_fenced(j.org_id)
    order by j.priority desc, j.created_at, j.id
    for update skip locked
    limit 1;

    if not found then
      return null;
    end if;

    if v_job.status = 'leased' and v_job.processing_attempt_id is not null then
      select evidence.lease_id, evidence.evidence_sha256
        into v_recovery_lease_id, v_recovery_evidence_sha256
      from private.organization_external_egress_evidence evidence
      join private.organization_external_egress_leases lease
        on lease.lease_id = evidence.lease_id
      where evidence.org_id = v_job.org_id
        and evidence.kind = 'document_signed_url'
        and evidence.correlation_id = v_job.processing_attempt_id
        and evidence.outcome = 'delivered'
        and lease.org_id = v_job.org_id
        and lease.kind = evidence.kind
        and lease.correlation_id = evidence.correlation_id;

      if found then
        perform public.service_recover_document_extraction_from_egress(
          v_job.id,
          v_job.processing_attempt_id,
          v_recovery_lease_id,
          v_recovery_evidence_sha256
        );
        continue;
      end if;

      update private.organization_external_egress_leases lease
      set status = 'settled',
          outcome = 'ambiguous',
          evidence_code = 'job_lease_expired_before_settlement',
          settled_at = statement_timestamp()
      where lease.org_id = v_job.org_id
        and lease.kind = 'document_signed_url'
        and lease.correlation_id = v_job.processing_attempt_id
        and lease.status = 'active';
    end if;

    if v_job.attempt_count >= v_attempt_limit then
      update public.document_processing_jobs
      set status = 'failed',
          lease_owner = null,
          lease_until = null,
          last_error_code = 'claim_attempt_limit_exceeded',
          last_error_message = 'Document processing stopped after repeated claim attempts'
      where id = v_job.id;

      insert into public.audit_logs (
        org_id, user_id, action, entity_type, entity_id, new_values, reason
      ) values (
        v_job.org_id,
        null,
        'document_processing_failed',
        'document_processing_jobs',
        v_job.id,
        jsonb_build_object(
          'error_code', 'claim_attempt_limit_exceeded',
          'attempt_count', v_job.attempt_count,
          'attempt_limit', v_attempt_limit
        ),
        'authoritative document processing claim circuit breaker'
      );
      continue;
    end if;

    v_attempt_id := gen_random_uuid();
    perform set_config('app.document_processing_claim_job', v_job.id::text, true);

    update public.document_processing_jobs j
    set status = 'leased',
        lease_owner = v_owner,
        lease_until = now() + make_interval(secs => v_seconds),
        attempt_count = j.attempt_count + 1,
        processing_attempt_id = v_attempt_id,
        processing_attempt_started_at = clock_timestamp(),
        last_error_code = null,
        last_error_message = null
    where j.id = v_job.id
    returning * into v_job;

    select * into v_document
    from public.documents
    where id = v_job.document_id
      and org_id = v_job.org_id;

    if not found or v_document.deleted_at is not null then
      update public.document_processing_jobs
      set status = 'failed',
          lease_owner = null,
          lease_until = null,
          last_error_code = 'document_deleted',
          last_error_message = 'Source document was deleted before processing'
      where id = v_job.id;

      insert into public.audit_logs (
        org_id, user_id, action, entity_type, entity_id, new_values, reason
      ) values (
        v_job.org_id,
        null,
        'document_processing_failed',
        'document_processing_jobs',
        v_job.id,
        jsonb_build_object(
          'error_code', 'document_deleted',
          'processing_attempt_id', v_attempt_id
        ),
        'source document deleted before processing'
      );
      continue;
    end if;

    exit;
  end loop;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_job.org_id,
    null,
    'document_processing_claimed',
    'document_processing_jobs',
    v_job.id,
    jsonb_build_object(
      'lease_owner', v_owner,
      'attempt_count', v_job.attempt_count,
      'processing_attempt_id', v_attempt_id
    ),
    'private OCR worker lease'
  );

  return jsonb_build_object(
    'job_id', v_job.id,
    'org_id', v_job.org_id,
    'document_id', v_job.document_id,
    'processing_attempt_id', v_attempt_id,
    'processing_attempt_started_at', v_job.processing_attempt_started_at,
    'storage_path', v_document.storage_path,
    'mime_type', v_document.mime_type,
    'file_name', v_document.file_name,
    'input_checksum', v_job.input_checksum,
    'contract_version', v_job.contract_version,
    'lease_until', v_job.lease_until,
    'attempt_count', v_job.attempt_count
  );
end;
$$;

revoke all on function public.claim_document_processing_job(text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_document_processing_job(text, integer)
  to service_role;

comment on function public.claim_document_processing_job(text, integer) is
  'Service-only OCR claim. Recovers committed evidence first and terminally fails jobs before a ninth claim.';

-- ===== A1/A3/A5 re-assertion =====

do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0129 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
