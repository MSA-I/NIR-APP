-- 0132 — Owner-initiated recovery for a canonically stuck current document job.
--
-- Recovery is deliberately service-only: the browser reaches it through the narrow
-- recover-document-processing Edge Function. Already-committed OCR/provider evidence always wins;
-- extraction is never purchased twice, and only a stuck queued/expired-leased job is superseded.

create table private.document_processing_recoveries (
  org_id uuid not null references public.organizations(id) on delete restrict,
  request_id uuid not null,
  old_job_id uuid not null,
  new_job_id uuid,
  actor_id uuid not null,
  reason text not null check (length(trim(reason)) between 1 and 1000),
  stuck_reason text not null,
  outcome text not null check (outcome in (
    'requeued', 'extraction_recovered', 'resume_interpretation',
    'interpretation_recovered'
  )),
  result_job_status text not null,
  result_job_updated_at timestamptz not null,
  created_at timestamptz not null default statement_timestamp(),
  primary key (org_id, request_id),
  unique (org_id, old_job_id, result_job_status, result_job_updated_at),
  foreign key (org_id, old_job_id)
    references public.document_processing_jobs(org_id, id) on delete restrict,
  foreign key (org_id, new_job_id)
    references public.document_processing_jobs(org_id, id) on delete restrict,
  foreign key (org_id, actor_id)
    references public.profiles(org_id, id) on delete restrict
);

revoke all on table private.document_processing_recoveries
from public, anon, authenticated, service_role;

-- A live or only-recently-expired worker lease gets five minutes to recover automatically. This
-- same helper drives gallery status, operations metrics and the write command below.
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
    when p_status = 'leased' and p_lease_until is not null
      and p_lease_until > p_evaluated_at - interval '5 minutes' then null
    when coalesce(p_attempt_count, 0) >= private.document_processing_claim_attempt_limit()
      then 'claim_attempt_limit_reached'
    when p_status = 'leased' and p_lease_until is not null
      and p_lease_until <= p_evaluated_at - interval '5 minutes' then 'lease_expired'
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

-- A recovered interpretation attempt may rotate an expired/ambiguous lease only when no
-- immutable provider evidence exists. The recovery transaction writes this one-shot marker while
-- holding the lease row. The next canonical reservation consumes it atomically and receives a
-- fresh token with idempotent=false; every concurrent reservation sees ordinary in-flight work.
create or replace function public.service_reserve_organization_external_egress(
  p_org_id uuid,
  p_kind text,
  p_correlation_id uuid,
  p_ttl_seconds integer default 90
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind text := lower(nullif(trim(p_kind), ''));
  v_lease private.organization_external_egress_leases;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_org_id is null or p_correlation_id is null
     or v_kind not in (
       'document_interpretation', 'invitation_email', 'push_notification',
       'integration_webhook', 'document_signed_url', 'whatsapp_reminder',
       'organization_logo_storage'
     ) or p_ttl_seconds not between 5 and 120 then
    raise exception 'organization_external_egress_reservation_invalid' using errcode = '22023';
  end if;

  perform 1 from public.organizations organization
  where organization.id = p_org_id
  for key share;
  if not found then
    raise exception 'organization_unknown' using errcode = 'P0002';
  end if;

  select * into v_lease
  from private.organization_external_egress_leases lease
  where lease.org_id = p_org_id and lease.kind = v_kind
    and lease.correlation_id = p_correlation_id
  for update;
  if found and v_lease.status = 'settled' then
    return jsonb_build_object(
      'lease_id', v_lease.lease_id, 'lease_token', null,
      'org_id', v_lease.org_id, 'kind', v_lease.kind,
      'correlation_id', v_lease.correlation_id, 'expires_at', v_lease.expires_at,
      'egress_allowed', false, 'settled_outcome', v_lease.outcome, 'idempotent', true
    );
  end if;
  -- Recovery creates a private one-shot generation before the Edge handoff starts. Consume that
  -- marker before ordinary expiry handling and start its bounded provider window here, so a cold
  -- start or failed handoff cannot turn an otherwise unused recovery generation into an
  -- unrecoverable ambiguous lease. The row lock still lets exactly one reservation receive
  -- idempotent=false; every concurrent caller observes the consumed generation.
  if found and v_lease.status = 'active'
     and v_lease.evidence_code = 'owner_stuck_recovery_rearmed' then
    if private.organization_access_mode(p_org_id) not in ('active', 'trial', 'grace') then
      raise exception 'organization_external_egress_not_allowed' using errcode = '42501';
    end if;
    update private.organization_external_egress_leases lease
    set evidence_code = null,
        reserved_at = statement_timestamp(),
        expires_at = statement_timestamp() + make_interval(secs => p_ttl_seconds)
    where lease.lease_id = v_lease.lease_id
    returning * into v_lease;
    return jsonb_build_object(
      'lease_id', v_lease.lease_id, 'lease_token', v_lease.lease_token,
      'org_id', v_lease.org_id, 'kind', v_lease.kind,
      'correlation_id', v_lease.correlation_id, 'expires_at', v_lease.expires_at,
      'egress_allowed', true, 'settled_outcome', null, 'idempotent', false
    );
  end if;
  if found and v_lease.expires_at < statement_timestamp() then
    update private.organization_external_egress_leases lease
    set status = 'settled', outcome = 'ambiguous',
        evidence_code = 'lease_expired_without_settlement', settled_at = statement_timestamp()
    where lease.lease_id = v_lease.lease_id
    returning * into v_lease;
    return jsonb_build_object(
      'lease_id', v_lease.lease_id, 'lease_token', null,
      'org_id', v_lease.org_id, 'kind', v_lease.kind,
      'correlation_id', v_lease.correlation_id, 'expires_at', v_lease.expires_at,
      'egress_allowed', false, 'settled_outcome', 'ambiguous', 'idempotent', true
    );
  end if;
  if private.organization_access_mode(p_org_id) not in ('active', 'trial', 'grace') then
    raise exception 'organization_external_egress_not_allowed' using errcode = '42501';
  end if;
  if found and v_lease.expires_at >= statement_timestamp() then
    return jsonb_build_object(
      'lease_id', v_lease.lease_id, 'lease_token', v_lease.lease_token,
      'org_id', v_lease.org_id, 'kind', v_lease.kind,
      'correlation_id', v_lease.correlation_id, 'expires_at', v_lease.expires_at,
      'egress_allowed', true, 'settled_outcome', null, 'idempotent', true
    );
  end if;

  insert into private.organization_external_egress_leases (
    org_id, kind, correlation_id, expires_at
  ) values (
    p_org_id, v_kind, p_correlation_id,
    statement_timestamp() + make_interval(secs => p_ttl_seconds)
  ) returning * into v_lease;

  return jsonb_build_object(
    'lease_id', v_lease.lease_id, 'lease_token', v_lease.lease_token,
    'org_id', v_lease.org_id, 'kind', v_lease.kind,
    'correlation_id', v_lease.correlation_id, 'expires_at', v_lease.expires_at,
    'egress_allowed', true, 'settled_outcome', null, 'idempotent', false
  );
end
$$;

revoke all on function public.service_reserve_organization_external_egress(
  uuid, text, uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function public.service_reserve_organization_external_egress(
  uuid, text, uuid, integer
) to service_role;

-- Evidence recovery preserves the actor embedded in the immutable provider receipt. Active
-- product work keeps the ordinary actor checks; this additional fence is set only by the
-- service-only recovery RPC after it has locked the same-tenant job and evidence.
create or replace function public.assert_document_interpretation_actor(
  p_org_id uuid,
  p_actor_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1
    from public.profiles p
    where p.org_id = p_org_id
      and p.id = p_actor_id
      and p.active
      and p.role in ('owner', 'office', 'kitchen')
  ) then
    return;
  end if;

  if auth.role() = 'service_role'
     and current_setting('app.document_interpretation_evidence_recovery_actor', true)
          is not distinct from p_actor_id::text
     and current_setting('app.document_interpretation_evidence_recovery_org', true)
          is not distinct from p_org_id::text
     and exists (
       select 1 from public.profiles p
       where p.org_id = p_org_id and p.id = p_actor_id
         and p.role in ('owner', 'office', 'kitchen')
     ) then
    return;
  end if;

  if auth.role() is distinct from 'service_role'
     or current_setting('app.ocr_supplier_interpretation_actor', true)
          is distinct from p_actor_id::text
     or current_setting('app.ocr_supplier_interpretation_org', true)
          is distinct from p_org_id::text then
    raise exception 'document_interpretation_actor_invalid' using errcode = '42501';
  end if;
end
$$;

revoke all on function public.assert_document_interpretation_actor(uuid, uuid)
  from public, anon, authenticated, service_role;

-- The supplier wrapper normally requires an active supplier account. Historical supplier
-- evidence remains consumable after persona retirement only under the exact recovery fence; the
-- full job/extraction/document/supplier chain and tenant are still re-verified here.
create or replace function public.assert_supplier_price_interpretation_context(
  p_job_id uuid,
  p_extraction_id uuid,
  p_actor_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.document_processing_jobs;
  v_extraction public.document_extractions;
  v_document public.documents;
  v_supplier uuid;
  v_historical_recovery boolean := false;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select * into v_job
  from public.document_processing_jobs j
  where j.id = p_job_id and j.requested_by = p_actor_id;
  if not found then
    raise exception 'document_interpretation_actor_invalid' using errcode = '42501';
  end if;

  v_historical_recovery :=
    current_setting('app.document_interpretation_evidence_recovery_actor', true)
      is not distinct from p_actor_id::text
    and current_setting('app.document_interpretation_evidence_recovery_org', true)
      is not distinct from v_job.org_id::text;

  select p.supplier_id into v_supplier
  from public.profiles p
  join public.organizations o on o.id = p.org_id
  join public.suppliers s
    on s.org_id = p.org_id and s.id = p.supplier_id and s.deleted_at is null
  where p.org_id = v_job.org_id and p.id = p_actor_id
    and (p.active or v_historical_recovery) and p.role = 'supplier'
    and o.status in ('trial', 'active');
  if v_supplier is null then
    raise exception 'document_interpretation_actor_invalid' using errcode = '42501';
  end if;

  select * into v_extraction
  from public.document_extractions e
  where e.org_id = v_job.org_id and e.id = p_extraction_id
    and e.job_id = v_job.id and e.document_id = v_job.document_id
    and e.input_checksum = v_job.input_checksum
    and e.contract_version = '1' and v_job.contract_version = '1';
  if not found then
    raise exception 'document_extraction_unknown' using errcode = 'P0002';
  end if;

  select * into v_document
  from public.documents d
  where d.org_id = v_job.org_id and d.id = v_job.document_id
    and d.deleted_at is null
    and d.entity_type = 'supplier'
    and d.entity_id = v_supplier
    and d.supplier_id = v_supplier
    and d.document_kind = 'price_list'
    and d.uploaded_by = p_actor_id
    and array_length(string_to_array(d.storage_path, '/'), 1) = 5
    and split_part(d.storage_path, '/', 1) = d.org_id::text
    and split_part(d.storage_path, '/', 2) = 'supplier'
    and split_part(d.storage_path, '/', 3) = v_supplier::text
    and split_part(d.storage_path, '/', 4) = d.id::text
    and split_part(d.storage_path, '/', 5) <> ''
    and split_part(d.storage_path, '/', 6) = '';
  if not found then
    raise exception 'document_interpretation_actor_invalid' using errcode = '42501';
  end if;

  if public.smart_document_source_checksum(
       v_document.org_id,
       v_document.storage_path,
       v_document.mime_type,
       v_document.uploaded_by
     ) is distinct from v_job.input_checksum then
    raise exception 'document_source_changed' using errcode = 'P0001';
  end if;
end
$$;

revoke all on function public.assert_supplier_price_interpretation_context(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

-- queued -> failed stays forbidden except inside the exact service recovery transaction.
do $guard_patch$
declare
  v_def text := replace(
    pg_get_functiondef('public.guard_document_processing_job()'::regprocedure), e'\r', '');
  v_declare_anchor text := replace($anchor$  v_extraction_recovery_write boolean := coalesce(
    auth.role() = 'service_role'
    and current_setting('app.document_extraction_recovery_job', true) = old.id::text, false
  );$anchor$, e'\r', '');
  v_declare_replacement text := replace($replacement$  v_extraction_recovery_write boolean := coalesce(
    auth.role() = 'service_role'
    and current_setting('app.document_extraction_recovery_job', true) = old.id::text, false
  );
  v_stuck_recovery_write boolean := coalesce(
    auth.role() = 'service_role'
    and current_setting('app.document_processing_stuck_recovery_job', true) = old.id::text, false
  );$replacement$, e'\r', '');
  v_transition_anchor text := replace($anchor$  if old.status = 'queued' and new.status not in ('queued', 'leased') then
    raise exception 'document_processing_transition_invalid' using errcode = '23514';$anchor$, e'\r', '');
  v_transition_replacement text := replace($replacement$  if old.status = 'queued'
     and new.status not in ('queued', 'leased')
     and not (new.status = 'failed' and v_stuck_recovery_write) then
    raise exception 'document_processing_transition_invalid' using errcode = '23514';$replacement$, e'\r', '');
begin
  if position(v_declare_anchor in v_def) = 0
     or position(v_transition_anchor in v_def) = 0 then
    raise exception '0132: document processing guard moved; stuck recovery was not installed';
  end if;
  execute replace(
    replace(v_def, v_declare_anchor, v_declare_replacement),
    v_transition_anchor, v_transition_replacement
  );
end
$guard_patch$;

-- A successor permanently fences the superseded attempt. A late evidence-applier may not revive
-- it through the otherwise-valid failed -> extracted/interpreting recovery paths from 0103.
do $late_worker_patch$
declare
  v_signature regprocedure;
  v_def text;
  v_anchor text;
  v_replacement text;
begin
  v_signature := 'public.service_recover_document_extraction_from_egress(uuid,uuid,uuid,text)'::regprocedure;
  v_def := replace(pg_get_functiondef(v_signature), e'\r', '');
  v_anchor := replace($anchor$  if not found then raise exception 'document_processing_job_unknown' using errcode = 'P0002'; end if;
  v_evidence := private.document_ocr_evidence_binding($anchor$, e'\r', '');
  v_replacement := replace($replacement$  if not found then raise exception 'document_processing_job_unknown' using errcode = 'P0002'; end if;
  if v_job.last_error_code = 'superseded_for_stuck_recovery' then
    raise exception 'document_processing_attempt_superseded' using errcode = '55000';
  end if;
  v_evidence := private.document_ocr_evidence_binding($replacement$, e'\r', '');
  if position(v_anchor in v_def) = 0 then
    raise exception '0132: extraction recovery moved; late-worker fence was not installed';
  end if;
  execute replace(v_def, v_anchor, v_replacement);

  v_signature := 'public.service_recover_document_interpretation_from_egress(uuid,uuid,uuid,uuid,text)'::regprocedure;
  v_def := replace(pg_get_functiondef(v_signature), e'\r', '');
  v_anchor := replace($anchor$  select * into v_job from public.document_processing_jobs where id = p_job_id for update;
  if not found then raise exception 'document_processing_job_unknown' using errcode = 'P0002'; end if;
  select * into v_extraction$anchor$, e'\r', '');
  v_replacement := replace($replacement$  select * into v_job from public.document_processing_jobs where id = p_job_id for update;
  if not found then raise exception 'document_processing_job_unknown' using errcode = 'P0002'; end if;
  if v_job.last_error_code = 'superseded_for_stuck_recovery' then
    raise exception 'document_processing_attempt_superseded' using errcode = '55000';
  end if;
  select * into v_extraction$replacement$, e'\r', '');
  if position(v_anchor in v_def) = 0 then
    raise exception '0132: interpretation recovery moved; late-worker fence was not installed';
  end if;
  v_def := replace(v_def, v_anchor, v_replacement);

  v_anchor := replace($anchor$  select profile.role into v_role
  from public.profiles profile
  where profile.org_id = v_job.org_id and profile.id = p_actor_id and profile.active;
  if v_role = 'supplier' then$anchor$, e'\r', '');
  v_replacement := replace($replacement$  select profile.role into v_role
  from public.profiles profile
  where profile.org_id = v_job.org_id and profile.id = p_actor_id;
  if not found then
    raise exception 'document_interpretation_recovery_actor_invalid' using errcode = '42501';
  end if;
  perform set_config(
    'app.document_interpretation_evidence_recovery_actor', p_actor_id::text, true
  );
  perform set_config(
    'app.document_interpretation_evidence_recovery_org', v_job.org_id::text, true
  );
  if v_role = 'supplier' then
    perform set_config('app.ocr_supplier_interpretation_actor', p_actor_id::text, true);
    perform set_config('app.ocr_supplier_interpretation_org', v_job.org_id::text, true);
  end if;
  if v_role = 'supplier' then$replacement$, e'\r', '');
  if position(v_anchor in v_def) = 0 then
    raise exception '0132: interpretation recovery actor fence moved; historical evidence recovery was not installed';
  end if;
  execute replace(v_def, v_anchor, v_replacement);
end
$late_worker_patch$;

create function public.service_recover_stuck_document_processing(
  p_job_id uuid,
  p_actor_id uuid,
  p_request_id uuid,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := nullif(trim(p_reason), '');
  v_org uuid;
  v_job public.document_processing_jobs;
  v_document public.documents;
  v_existing private.document_processing_recoveries;
  v_stuck_reason text;
  v_current_job_id uuid;
  v_new_job_id uuid;
  v_outcome text;
  v_ocr_lease private.organization_external_egress_leases;
  v_interpretation_lease private.organization_external_egress_leases;
  v_ocr_lease_id uuid;
  v_ocr_evidence_sha256 text;
  v_interpretation_lease_id uuid;
  v_interpretation_evidence_sha256 text;
  v_extraction_id uuid;
  v_current_checksum text;
  v_ocr_egress_active boolean := false;
  v_interpretation_egress_exists boolean := false;
  v_interpretation_egress_active boolean := false;
  v_interpretation_evidence_exists boolean := false;
  v_result_job_status text;
  v_result_job_updated_at timestamptz;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_job_id is null or p_actor_id is null or p_request_id is null
     or v_reason is null or length(v_reason) > 1000 then
    raise exception 'document_processing_recovery_invalid' using errcode = '22023';
  end if;

  select profile.org_id into v_org
  from public.profiles profile
  where profile.id = p_actor_id
    and profile.role = 'owner'
    and profile.active;
  if not found then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if not private.organization_write_allowed_fenced(v_org) then
    raise exception 'organization_read_only' using errcode = '42501';
  end if;
  select * into v_job
  from public.document_processing_jobs job
  where job.id = p_job_id and job.org_id = v_org
  for update;
  if not found then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_existing
  from private.document_processing_recoveries recovery
  where recovery.org_id = v_job.org_id
    and recovery.request_id = p_request_id
  for update;
  if found then
    if v_existing.old_job_id is distinct from v_job.id
       or v_existing.reason is distinct from v_reason then
      raise exception 'document_processing_recovery_conflict' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'outcome', v_existing.outcome,
      'old_job_id', v_existing.old_job_id,
      'job_id', coalesce(v_existing.new_job_id, v_existing.old_job_id),
      'stuck_reason', v_existing.stuck_reason,
      'idempotent', true
    );
  end if;

  select * into v_existing
  from private.document_processing_recoveries recovery
  where recovery.org_id = v_job.org_id
    and recovery.old_job_id = v_job.id
    and recovery.result_job_status = v_job.status
    and recovery.result_job_updated_at = v_job.updated_at
  for update;
  if found then
    if v_existing.reason is distinct from v_reason then
      raise exception 'document_processing_recovery_conflict' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'outcome', v_existing.outcome,
      'old_job_id', v_existing.old_job_id,
      'job_id', coalesce(v_existing.new_job_id, v_existing.old_job_id),
      'stuck_reason', v_existing.stuck_reason,
      'idempotent', true
    );
  end if;

  select * into v_document
  from public.documents document
  where document.org_id = v_job.org_id
    and document.id = v_job.document_id
    and document.deleted_at is null
  for update;
  if not found then
    raise exception 'document_unknown' using errcode = 'P0002';
  end if;
  v_current_checksum := public.smart_document_source_checksum(
    v_document.org_id, v_document.storage_path, v_document.mime_type, v_document.uploaded_by
  );
  if v_current_checksum is distinct from v_job.input_checksum then
    raise exception 'document_processing_source_changed' using errcode = '22023';
  end if;

  select current_job.id into v_current_job_id
  from public.document_processing_jobs current_job
  where current_job.org_id = v_job.org_id
    and current_job.document_id = v_job.document_id
  order by current_job.created_at desc, current_job.id desc
  limit 1;
  if v_current_job_id is distinct from v_job.id then
    raise exception 'document_processing_job_not_current' using errcode = '55000';
  end if;

  -- Lock the provider authority before looking for its evidence. A recorder that is already
  -- settling wins this lock first; after it commits, this transaction sees and consumes the
  -- evidence. Conversely, once recovery owns the lock no late settlement can race a successor.
  if v_job.processing_attempt_id is not null then
    select * into v_ocr_lease
    from private.organization_external_egress_leases lease
    where lease.org_id = v_job.org_id
      and lease.kind = 'document_signed_url'
      and lease.correlation_id = v_job.processing_attempt_id
    for update;
    v_ocr_egress_active := found
      and v_ocr_lease.status = 'active'
      and v_ocr_lease.expires_at > statement_timestamp();
  end if;

  -- Paid-for provider evidence wins even while the worker lease is still live. The lease only
  -- fences a replacement provider call; it must never hide a result that was durably settled.
  if v_job.status = 'leased'
     and v_ocr_lease.lease_id is not null
     and v_ocr_lease.status = 'settled' then
    select evidence.lease_id, evidence.evidence_sha256
      into v_ocr_lease_id, v_ocr_evidence_sha256
    from private.organization_external_egress_evidence evidence
    where evidence.org_id = v_job.org_id
      and evidence.kind = 'document_signed_url'
      and evidence.correlation_id = v_job.processing_attempt_id
      and evidence.outcome = 'delivered'
      and evidence.lease_id = v_ocr_lease.lease_id
    limit 1;
    if found then
      perform public.service_recover_document_extraction_from_egress(
        v_job.id, v_job.processing_attempt_id, v_ocr_lease_id, v_ocr_evidence_sha256
      );
      v_outcome := 'extraction_recovered';
    end if;
  end if;

  if v_outcome is null and v_job.status = 'interpreting' then
    select extraction.id into v_extraction_id
    from public.document_extractions extraction
    where extraction.org_id = v_job.org_id and extraction.job_id = v_job.id;

    select * into v_interpretation_lease
    from private.organization_external_egress_leases lease
    where lease.org_id = v_job.org_id
      and lease.kind = 'document_interpretation'
      and lease.correlation_id = v_job.id
    for update;
    v_interpretation_egress_exists := found;
    v_interpretation_egress_active := found
      and v_interpretation_lease.status = 'active'
      and v_interpretation_lease.expires_at > statement_timestamp();

    select exists (
      select 1
      from private.organization_external_egress_evidence evidence
      where evidence.lease_id = v_interpretation_lease.lease_id
    ) into v_interpretation_evidence_exists;

    select evidence.lease_id, evidence.evidence_sha256
      into v_interpretation_lease_id, v_interpretation_evidence_sha256
    from private.organization_external_egress_evidence evidence
    where evidence.org_id = v_job.org_id
      and evidence.kind = 'document_interpretation'
      and evidence.correlation_id = v_job.id
      and evidence.outcome in ('delivered', 'ambiguous')
      and evidence.lease_id = v_interpretation_lease.lease_id
      and v_interpretation_lease.status = 'settled'
    limit 1;
    if found then
      perform public.service_recover_document_interpretation_from_egress(
        v_job.id, v_extraction_id, v_job.interpretation_actor_id,
        v_interpretation_lease_id, v_interpretation_evidence_sha256
      );
      v_outcome := 'interpretation_recovered';
    end if;
  end if;

  if v_outcome is not null then
    v_stuck_reason := coalesce(
      private.document_processing_stuck_reason(
        v_job.status, v_job.attempt_count, v_job.created_at, v_job.updated_at,
        v_job.lease_until, statement_timestamp()
      ),
      'committed_evidence_available'
    );
  else
    v_stuck_reason := private.document_processing_stuck_reason(
      v_job.status, v_job.attempt_count, v_job.created_at, v_job.updated_at,
      v_job.lease_until, statement_timestamp()
    );
    if v_stuck_reason is null then
      raise exception 'document_processing_job_not_stuck' using errcode = '55000';
    end if;
    if v_job.status = 'leased'
       and v_job.lease_until > statement_timestamp() - interval '5 minutes' then
      raise exception 'document_processing_lease_active' using errcode = '55000';
    end if;
    if v_ocr_egress_active or v_interpretation_egress_active then
      raise exception 'document_processing_egress_active' using errcode = '55000';
    end if;
    if v_job.status = 'interpreting' and v_interpretation_egress_exists then
      if v_interpretation_evidence_exists
         or not (
           (
             v_interpretation_lease.status = 'active'
             and v_interpretation_lease.expires_at <= statement_timestamp()
           )
           or (
             v_interpretation_lease.status = 'settled'
             and v_interpretation_lease.outcome = 'ambiguous'
             and v_interpretation_lease.evidence_code in (
               'lease_expired_without_settlement',
               'job_lease_expired_before_settlement',
               'owner_stuck_recovery_superseded'
             )
           )
         ) then
        raise exception 'document_processing_recovery_state_invalid' using errcode = '55000';
      end if;

      -- Rotate the token while holding the same row lock. A provider result carrying the previous
      -- generation can no longer settle, while the next canonical reservation consumes the marker
      -- and receives idempotent=false exactly once.
      update private.organization_external_egress_leases lease
      set lease_token = gen_random_uuid(), status = 'active', outcome = null,
          evidence_code = 'owner_stuck_recovery_rearmed', provider_status = null,
          reserved_at = statement_timestamp(),
          expires_at = statement_timestamp() + interval '90 seconds',
          acknowledged_at = null, acknowledged_by = null, settled_at = null,
          reservation_count = lease.reservation_count + 1
      where lease.lease_id = v_interpretation_lease.lease_id
      returning * into v_interpretation_lease;
    end if;
  end if;

  if v_outcome is null and (
    v_job.status = 'extracted'
    or v_job.status = 'interpreting'
  ) then
    v_outcome := 'resume_interpretation';
  end if;

  if v_outcome is null then
    if v_job.status not in ('queued', 'leased') then
      raise exception 'document_processing_recovery_state_invalid' using errcode = '55000';
    end if;
    if v_job.processing_attempt_id is not null then
      update private.organization_external_egress_leases lease
      set status = 'settled', outcome = 'ambiguous',
          evidence_code = 'owner_stuck_recovery_superseded',
          settled_at = statement_timestamp()
      where lease.org_id = v_job.org_id
        and lease.kind = 'document_signed_url'
        and lease.correlation_id = v_job.processing_attempt_id
        and lease.status = 'active';
    end if;
    perform set_config('app.document_processing_stuck_recovery_job', v_job.id::text, true);
    update public.document_processing_jobs
    set status = 'failed', lease_owner = null, lease_until = null,
        last_error_code = 'superseded_for_stuck_recovery',
        last_error_message = 'Superseded by owner recovery after canonical stuck detection'
    where id = v_job.id;

    insert into public.document_processing_jobs (
      org_id, document_id, requested_by, input_checksum, contract_version, priority
    ) values (
      v_job.org_id, v_job.document_id, v_document.uploaded_by,
      v_current_checksum, v_job.contract_version, v_job.priority
    ) returning id into v_new_job_id;
    v_outcome := 'requeued';
  end if;

  select job.status, job.updated_at
    into v_result_job_status, v_result_job_updated_at
  from public.document_processing_jobs job
  where job.id = v_job.id;

  insert into private.document_processing_recoveries (
    org_id, request_id, old_job_id, new_job_id, actor_id, reason, stuck_reason, outcome,
    result_job_status, result_job_updated_at
  ) values (
    v_job.org_id, p_request_id, v_job.id, v_new_job_id,
    p_actor_id, v_reason, v_stuck_reason, v_outcome,
    v_result_job_status, v_result_job_updated_at
  );

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_job.org_id, p_actor_id, case
      when v_outcome = 'requeued' then 'document_processing_reprocessed'
      else 'document_processing_stuck_recovered'
    end,
    'document_processing_jobs', coalesce(v_new_job_id, v_job.id),
    jsonb_build_object(
      'status', v_job.status, 'attempt_count', v_job.attempt_count,
      'processing_attempt_id', v_job.processing_attempt_id
    ),
    jsonb_build_object(
      'old_job_id', v_job.id, 'new_job_id', v_new_job_id, 'outcome', v_outcome,
      'stuck_reason', v_stuck_reason, 'recovery_kind', 'stuck',
      'request_id', p_request_id,
      'result_job_status', v_result_job_status,
      'result_job_updated_at', v_result_job_updated_at
    ), v_reason
  );

  return jsonb_build_object(
    'outcome', v_outcome,
    'old_job_id', v_job.id,
    'job_id', coalesce(v_new_job_id, v_job.id),
    'stuck_reason', v_stuck_reason,
    'idempotent', false
  );
end
$$;

revoke all on function public.service_recover_stuck_document_processing(uuid,uuid,uuid,text)
from public, anon, authenticated, service_role;
grant execute on function public.service_recover_stuck_document_processing(uuid,uuid,uuid,text)
to service_role;

insert into private.scope_definer_exemptions (function_signature, reason, target_wave)
values (
  'public.service_recover_stuck_document_processing(uuid,uuid,uuid,text)'::regprocedure::text,
  'actor: service_role Edge path with active owner re-verified in the job tenant; tenant: locked job, document, actor and evidence derive one org; scope: browser supplies only exact job and reason, while service recovery never accepts a caller-selected unit; tables: jobs, document, private egress and audit; reason: an owner needs a fenced, evidence-first escape from canonically stuck OCR without duplicate provider work; audit: old/new job, persisted reason, attempt and outcome are atomic; proof: browser execute revoked, current-job, writable-lifecycle, active-lease, evidence and unique-idempotency checks fail closed.',
  'document processing stuck recovery'
);

do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0132 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
