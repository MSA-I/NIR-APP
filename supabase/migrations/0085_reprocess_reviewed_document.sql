-- 0085 -- Review is a terminal result, not an active worker state. Allow a new audited job
-- while still rejecting duplicates that are queued or currently being processed.
drop index if exists public.document_processing_jobs_active_key;
create unique index document_processing_jobs_active_key
  on public.document_processing_jobs (org_id, document_id, input_checksum, contract_version)
  where status in ('queued', 'leased', 'extracted', 'interpreting');

create or replace function public.reprocess_document(p_document_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role user_role := auth_role();
  v_reason text := nullif(trim(p_reason), '');
  v_document public.documents;
  v_checksum text;
  v_job_id uuid;
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into v_document
  from public.documents
  where id = p_document_id and org_id = v_org and deleted_at is null
  for update;
  if not found then
    raise exception 'document_unknown' using errcode = 'P0002';
  end if;

  v_checksum := public.smart_document_source_checksum(
    v_document.org_id, v_document.storage_path, v_document.mime_type, v_document.uploaded_by
  );

  if exists (
    select 1 from public.document_processing_jobs j
    where j.org_id = v_org
      and j.document_id = v_document.id
      and j.input_checksum = v_checksum
      and j.contract_version = '1'
      and j.status in ('queued', 'leased', 'extracted', 'interpreting')
  ) then
    raise exception 'document_processing_active' using errcode = '55000';
  end if;

  insert into public.document_processing_jobs (
    org_id, document_id, requested_by, input_checksum, contract_version
  ) values (
    v_org, v_document.id, v_user, v_checksum, '1'
  ) returning id into v_job_id;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_org, v_user, 'document_processing_reprocessed', 'document_processing_jobs', v_job_id,
    jsonb_build_object('document_id', v_document.id, 'contract_version', '1'), v_reason
  );
  return v_job_id;
end
$$;

revoke all on function public.reprocess_document(uuid, text) from public, anon, service_role;
grant execute on function public.reprocess_document(uuid, text) to authenticated;
