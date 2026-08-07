-- 0080 -- Let one trusted command reuse the existing price writer for the document uploader.
--
-- The eight-argument writer from 0048 remains byte-for-byte untouched and keeps every grant
-- revoked. Re-declaring its ~400 lines here would be the same silent-revert trap 0078 narrowly
-- avoided. This overload adds only the missing server boundary: a service caller may name an
-- actor only when the prepared OCR intake, source document and active profile all name that same
-- uploader. It then lends the old writer that JWT identity for the duration of the nested call.

create or replace function public.p1b_submit_supplier_price_list_internal(
  p_submission_id uuid,
  p_supplier_id uuid,
  p_target_month date,
  p_file_name text,
  p_storage_path text,
  p_file_checksum text,
  p_rows jsonb,
  p_reason text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_previous_sub text := current_setting('request.jwt.claim.sub', true);
  v_previous_role text := current_setting('request.jwt.claim.role', true);
  v_result jsonb;
begin
  -- The explicit NULL path is the old path. It is intentionally not a DEFAULT: keeping the
  -- original eight-argument function makes a defaulted overload ambiguous in PostgreSQL.
  if p_actor_id is null then
    return public.p1b_submit_supplier_price_list_internal(
      p_submission_id, p_supplier_id, p_target_month, p_file_name,
      p_storage_path, p_file_checksum, p_rows, p_reason
    );
  end if;

  if auth.role() is distinct from 'service_role' then
    raise exception 'price_submission_not_authorized' using errcode = '42501';
  end if;

  -- This is the actor boundary. The caller cannot nominate an arbitrary tenant member: the
  -- actor must be the uploader already bound into every OCR provenance row and into the
  -- prepared intake the old writer consumes.
  perform 1
  from public.supplier_price_submission_intakes intake
  join public.documents d
    on d.org_id = intake.org_id
   and d.id = intake.source_document_id
   and d.uploaded_by = intake.actor_id
  join public.document_processing_jobs j
    on j.org_id = d.org_id
   and j.id = intake.source_job_id
   and j.document_id = d.id
  join public.document_interpretations i
    on i.org_id = j.org_id
   and i.id = intake.source_interpretation_id
   and i.job_id = j.id
   and i.document_id = d.id
  join public.profiles p
    on p.org_id = d.org_id
   and p.id = d.uploaded_by
   and p.active
   and p.role in ('owner', 'office', 'supplier')
  join public.organizations o
    on o.id = d.org_id and o.status in ('trial', 'active')
  where intake.actor_id = p_actor_id
    and intake.submission_id = p_submission_id
    and intake.supplier_id = p_supplier_id
    and intake.target_month = p_target_month
    and intake.file_name = trim(p_file_name)
    and intake.storage_path = p_storage_path
    and intake.file_checksum = lower(trim(coalesce(p_file_checksum, '')))
    and intake.rows_payload = p_rows
    and intake.reason = nullif(trim(p_reason), '')
    and intake.status = 'prepared'
    and intake.expires_at > now()
    and intake.source_document_id is not null
    and d.deleted_at is null
    and d.entity_type = 'supplier'
    and d.entity_id = p_supplier_id
    and d.supplier_id = p_supplier_id
    and d.document_kind = 'price_list'
    and d.uploaded_by = p_actor_id
    and j.requested_by = p_actor_id
    and j.interpretation_actor_id = p_actor_id
    and i.interpreted_for_user_id = p_actor_id;
  if not found then
    raise exception 'price_submission_not_authorized' using errcode = '42501';
  end if;

  perform set_config('request.jwt.claim.sub', p_actor_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  begin
    v_result := public.p1b_submit_supplier_price_list_internal(
      p_submission_id, p_supplier_id, p_target_month, p_file_name,
      p_storage_path, p_file_checksum, p_rows, p_reason
    );
  exception when others then
    perform set_config('request.jwt.claim.sub', coalesce(v_previous_sub, ''), true);
    perform set_config('request.jwt.claim.role', coalesce(v_previous_role, ''), true);
    raise;
  end;
  perform set_config('request.jwt.claim.sub', coalesce(v_previous_sub, ''), true);
  perform set_config('request.jwt.claim.role', coalesce(v_previous_role, ''), true);
  return v_result;
end
$$;

revoke all on function public.p1b_submit_supplier_price_list_internal(
  uuid, uuid, date, text, text, text, jsonb, text, uuid
) from public, anon, authenticated, service_role;

comment on function public.p1b_submit_supplier_price_list_internal(
  uuid, uuid, date, text, text, text, jsonb, text, uuid
) is
  'Server-only overload of the 0048 writer. The actor must be the source document uploader and '
  'the same actor already bound to the job, interpretation and prepared intake. No role receives '
  'EXECUTE; apply_price_list_interpretation reaches it only as the postgres-owned definer.';

insert into private.scope_definer_exemptions (function_signature, reason, target_wave)
values (
  'public.p1b_submit_supplier_price_list_internal(uuid,uuid,date,text,text,text,jsonb,text,uuid)'::regprocedure::text,
  'internal-only -- the overload has no EXECUTE grant and accepts an actor only when the '
    || 'tenant-composite document, job, interpretation and prepared intake all bind that actor '
    || 'to the same org. It delegates to the unchanged 0048 writer.',
  'multi-unit enablement wave'
);

do $$
begin
  if has_function_privilege(
       'authenticated',
       'public.p1b_submit_supplier_price_list_internal(uuid,uuid,date,text,text,text,jsonb,text,uuid)',
       'EXECUTE'
     )
     or has_function_privilege(
       'service_role',
       'public.p1b_submit_supplier_price_list_internal(uuid,uuid,date,text,text,text,jsonb,text,uuid)',
       'EXECUTE'
     ) then
    raise exception '0080 refused: the server price writer overload is executable directly';
  end if;
end
$$;
