-- 0048 -- Route reviewed OCR price lists through the existing trusted price writer.
-- The document/extraction/interpretation chain remains immutable evidence. A short-lived
-- service-authored intake is the only bridge; the authenticated command remains
-- submit_supplier_price_list(p_intake_id).

-- ===== Immutable source provenance =====

alter table public.supplier_price_submission_intakes
  add column source_document_id uuid,
  add column source_job_id uuid,
  add column source_extraction_id uuid,
  add column source_interpretation_id uuid,
  add column source_input_checksum text,
  add column source_contract_version text,
  add column source_schema_version text;

alter table public.supplier_price_submission_intakes
  add constraint supplier_price_submission_intakes_source_document_fk
    foreign key (org_id, source_document_id)
    references public.documents(org_id, id) on delete restrict,
  add constraint supplier_price_submission_intakes_source_job_fk
    foreign key (org_id, source_job_id)
    references public.document_processing_jobs(org_id, id) on delete restrict,
  add constraint supplier_price_submission_intakes_source_extraction_fk
    foreign key (org_id, source_extraction_id, source_job_id, source_document_id)
    references public.document_extractions(org_id, id, job_id, document_id) on delete restrict,
  add constraint supplier_price_submission_intakes_source_interpretation_fk
    foreign key (org_id, source_interpretation_id, source_extraction_id, source_document_id)
    references public.document_interpretations(org_id, id, extraction_id, document_id)
    on delete restrict,
  add constraint supplier_price_submission_intakes_source_shape check (
    (
      source_document_id is null
      and source_job_id is null
      and source_extraction_id is null
      and source_interpretation_id is null
      and source_input_checksum is null
      and source_contract_version is null
      and source_schema_version is null
    )
    or (
      source_document_id is not null
      and source_job_id is not null
      and source_extraction_id is not null
      and source_interpretation_id is not null
      and source_input_checksum like 'etag:%'
      and source_contract_version = '1'
      and source_schema_version = '1'
    )
  );

alter table public.supplier_price_submission_intakes
  drop constraint supplier_price_submission_intakes_path_check,
  add constraint supplier_price_submission_intakes_path_check check (
    (
      source_document_id is null
      and array_length(string_to_array(storage_path, '/'), 1) = 5
      and split_part(storage_path, '/', 1) = org_id::text
      and split_part(storage_path, '/', 2) = 'price-submissions'
      and split_part(storage_path, '/', 3) = supplier_id::text
      and split_part(storage_path, '/', 4) = submission_id::text
      and split_part(storage_path, '/', 5) <> ''
      and split_part(storage_path, '/', 6) = ''
    )
    or (
      source_document_id is not null
      and array_length(string_to_array(storage_path, '/'), 1) = 5
      and split_part(storage_path, '/', 1) = org_id::text
      and split_part(storage_path, '/', 2) = 'supplier'
      and split_part(storage_path, '/', 3) = supplier_id::text
      and split_part(storage_path, '/', 4) = source_document_id::text
      and split_part(storage_path, '/', 5) <> ''
      and split_part(storage_path, '/', 6) = ''
    )
  ),
  drop constraint supplier_price_submission_intakes_mime_check,
  add constraint supplier_price_submission_intakes_mime_check check (
    (
      source_document_id is null
      and mime_type in (
        'text/csv',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
    )
    or (
      source_document_id is not null
      and public.smart_document_mime_allowed(mime_type)
    )
  );

alter table public.supplier_price_submissions
  add column source_document_id uuid,
  add column source_job_id uuid,
  add column source_extraction_id uuid,
  add column source_interpretation_id uuid,
  add column source_input_checksum text,
  add column source_contract_version text,
  add column source_schema_version text,
  add column source_object_id uuid,
  add column source_object_updated_at timestamptz;

alter table public.supplier_price_submissions
  add constraint supplier_price_submissions_source_document_fk
    foreign key (org_id, source_document_id)
    references public.documents(org_id, id) on delete restrict,
  add constraint supplier_price_submissions_source_job_fk
    foreign key (org_id, source_job_id)
    references public.document_processing_jobs(org_id, id) on delete restrict,
  add constraint supplier_price_submissions_source_extraction_fk
    foreign key (org_id, source_extraction_id, source_job_id, source_document_id)
    references public.document_extractions(org_id, id, job_id, document_id) on delete restrict,
  add constraint supplier_price_submissions_source_interpretation_fk
    foreign key (org_id, source_interpretation_id, source_extraction_id, source_document_id)
    references public.document_interpretations(org_id, id, extraction_id, document_id)
    on delete restrict,
  add constraint supplier_price_submissions_source_shape check (
    (
      source_document_id is null
      and source_job_id is null
      and source_extraction_id is null
      and source_interpretation_id is null
      and source_input_checksum is null
      and source_contract_version is null
      and source_schema_version is null
      and source_object_id is null
      and source_object_updated_at is null
    )
    or (
      source_document_id is not null
      and source_job_id is not null
      and source_extraction_id is not null
      and source_interpretation_id is not null
      and source_input_checksum like 'etag:%'
      and source_contract_version = '1'
      and source_schema_version = '1'
      and source_object_id is not null
      and source_object_updated_at is not null
    )
  ) not valid;

alter table public.supplier_price_submissions
  drop constraint supplier_price_submissions_path_check,
  add constraint supplier_price_submissions_path_check check (
    (
      source_document_id is null
      and array_length(string_to_array(storage_path, '/'), 1) = 5
      and split_part(storage_path, '/', 1) = org_id::text
      and split_part(storage_path, '/', 2) = 'price-submissions'
      and split_part(storage_path, '/', 3) = supplier_id::text
      and split_part(storage_path, '/', 4) = id::text
      and split_part(storage_path, '/', 5) <> ''
      and split_part(storage_path, '/', 6) = ''
    )
    or (
      source_document_id is not null
      and array_length(string_to_array(storage_path, '/'), 1) = 5
      and split_part(storage_path, '/', 1) = org_id::text
      and split_part(storage_path, '/', 2) = 'supplier'
      and split_part(storage_path, '/', 3) = supplier_id::text
      and split_part(storage_path, '/', 4) = source_document_id::text
      and split_part(storage_path, '/', 5) <> ''
      and split_part(storage_path, '/', 6) = ''
    )
  ) not valid,
  drop constraint supplier_price_submissions_storage_path_key;

create unique index supplier_price_submissions_file_storage_path_key
  on public.supplier_price_submissions (org_id, storage_path)
  where source_document_id is null;
create index supplier_price_submissions_source_document_idx
  on public.supplier_price_submissions (org_id, source_document_id, submitted_at desc)
  where source_document_id is not null;

-- ===== Narrow supplier upload/read contract =====

create or replace function public.supplier_price_upload_authorized(
  p_org_id uuid,
  p_supplier_id uuid,
  p_actor_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles p
    join public.organizations o on o.id = p.org_id
    join public.suppliers s
      on s.org_id = p.org_id and s.id = p.supplier_id and s.deleted_at is null
    where p_actor_id = auth.uid() and p_org_id = auth_org()
      and p.id = p_actor_id and p.org_id = p_org_id
      and p.active and p.role = 'supplier'
      and p.supplier_id = p_supplier_id
      and o.status in ('trial', 'active')
  )
$$;

revoke all on function public.supplier_price_upload_authorized(uuid, uuid, uuid)
  from public, anon;
grant execute on function public.supplier_price_upload_authorized(uuid, uuid, uuid)
  to authenticated, service_role;

-- Browser callers never choose a documents.id. The server reserves the immutable UUID/path first,
-- then the Storage policy accepts exactly that actor-bound path for a short window.
create table public.supplier_price_document_upload_reservations (
  document_id uuid primary key,
  org_id uuid not null,
  actor_id uuid not null,
  supplier_id uuid not null,
  file_name text not null,
  mime_type text not null,
  storage_path text not null unique,
  status text not null default 'reserved',
  object_id uuid,
  object_updated_at timestamptz,
  job_id uuid,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  registered_at timestamptz,
  constraint supplier_price_document_upload_reservations_org_fk
    foreign key (org_id) references public.organizations(id) on delete restrict,
  constraint supplier_price_document_upload_reservations_actor_fk
    foreign key (org_id, actor_id) references public.profiles(org_id, id) on delete restrict,
  constraint supplier_price_document_upload_reservations_supplier_fk
    foreign key (org_id, supplier_id) references public.suppliers(org_id, id) on delete restrict,
  constraint supplier_price_document_upload_reservations_job_fk
    foreign key (org_id, job_id)
    references public.document_processing_jobs(org_id, id) on delete restrict,
  constraint supplier_price_document_upload_reservations_file_name_check check (
    length(file_name) between 1 and 255
    and file_name not in ('.', '..')
    and file_name !~ '[\\/]'
    and file_name !~ '[[:cntrl:]]'
  ),
  constraint supplier_price_document_upload_reservations_mime_check check (
    mime_type = lower(mime_type) and public.smart_document_mime_allowed(mime_type)
  ),
  constraint supplier_price_document_upload_reservations_path_check check (
    array_length(string_to_array(storage_path, '/'), 1) = 5
    and split_part(storage_path, '/', 1) = org_id::text
    and split_part(storage_path, '/', 2) = 'supplier'
    and split_part(storage_path, '/', 3) = supplier_id::text
    and split_part(storage_path, '/', 4) = document_id::text
    and split_part(storage_path, '/', 5) = file_name
    and split_part(storage_path, '/', 6) = ''
  ),
  constraint supplier_price_document_upload_reservations_status_check check (
    (
      status = 'reserved'
      and object_id is null and object_updated_at is null
      and job_id is null and registered_at is null
    )
    or (
      status = 'registered'
      and object_id is not null and object_updated_at is not null
      and job_id is not null and registered_at is not null
    )
  ),
  constraint supplier_price_document_upload_reservations_time_check check (
    expires_at > created_at
  )
);

create index supplier_price_document_upload_reservations_actor_idx
  on public.supplier_price_document_upload_reservations
  (org_id, actor_id, status, expires_at desc);

alter table public.supplier_price_document_upload_reservations enable row level security;
alter table public.supplier_price_document_upload_reservations force row level security;
revoke all on table public.supplier_price_document_upload_reservations
  from public, anon, authenticated, service_role;
grant select, insert, update, delete
  on table public.supplier_price_document_upload_reservations to service_role;

create or replace function public.supplier_price_upload_reservation_active(
  p_storage_path text,
  p_mime_type text,
  p_actor_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.supplier_price_document_upload_reservations r
    join public.profiles p
      on p.org_id = r.org_id and p.id = r.actor_id
    join public.organizations o on o.id = r.org_id
    join public.suppliers s
      on s.org_id = r.org_id and s.id = r.supplier_id and s.deleted_at is null
    where r.storage_path = p_storage_path
      and r.mime_type = lower(split_part(trim(coalesce(p_mime_type, '')), ';', 1))
      and r.actor_id = p_actor_id
      and r.org_id = auth_org()
      and r.status = 'reserved'
      and r.expires_at > now()
      and p.id = auth.uid()
      and p.active and p.role = 'supplier'
      and p.supplier_id = r.supplier_id
      and o.status in ('trial', 'active')
  )
$$;

revoke all on function public.supplier_price_upload_reservation_active(text, text, uuid)
  from public, anon;
grant execute on function public.supplier_price_upload_reservation_active(text, text, uuid)
  to authenticated, service_role;

create or replace function public.reserve_supplier_price_document_upload(
  p_supplier_id uuid,
  p_file_name text,
  p_mime_type text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_role public.user_role;
  v_profile_supplier uuid;
  v_document_id uuid := gen_random_uuid();
  v_file_name text := nullif(btrim(p_file_name), '');
  v_mime_type text := lower(split_part(trim(coalesce(p_mime_type, '')), ';', 1));
  v_storage_path text;
  v_expires_at timestamptz;
begin
  if v_org is null or v_actor is null or p_supplier_id is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select p.role, p.supplier_id into v_role, v_profile_supplier
  from public.profiles p
  join public.organizations o on o.id = p.org_id
  where p.id = v_actor and p.org_id = v_org and p.active
    and o.status in ('trial', 'active');
  if v_role is null or v_role not in ('owner', 'office', 'supplier')
     or (v_role = 'supplier' and v_profile_supplier is distinct from p_supplier_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  -- Registered rows are the durable retry receipt. Only unused, expired claims are disposable.
  delete from public.supplier_price_document_upload_reservations
  where status = 'reserved' and expires_at <= now();

  perform 1
  from public.suppliers s
  where s.org_id = v_org and s.id = p_supplier_id and s.deleted_at is null;
  if not found then
    raise exception 'supplier_unknown' using errcode = 'P0002';
  end if;

  if v_file_name is null or length(v_file_name) > 255
     or v_file_name in ('.', '..')
     or v_file_name ~ '[\\/]'
     or v_file_name ~ '[[:cntrl:]]'
     or not public.smart_document_mime_allowed(v_mime_type) then
    raise exception 'document_upload_invalid' using errcode = '22023';
  end if;

  v_storage_path := concat_ws(
    '/', v_org::text, 'supplier', p_supplier_id::text, v_document_id::text, v_file_name
  );
  insert into public.supplier_price_document_upload_reservations (
    document_id, org_id, actor_id, supplier_id,
    file_name, mime_type, storage_path
  ) values (
    v_document_id, v_org, v_actor, p_supplier_id,
    v_file_name, v_mime_type, v_storage_path
  ) returning expires_at into v_expires_at;

  return jsonb_build_object(
    'document_id', v_document_id,
    'storage_path', v_storage_path,
    'expires_at', v_expires_at
  );
end
$$;

revoke all on function public.reserve_supplier_price_document_upload(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.reserve_supplier_price_document_upload(uuid, text, text)
  to authenticated;

create or replace function public.supplier_price_document_owned(
  p_org_id uuid,
  p_document_id uuid,
  p_actor_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.documents d
    join public.profiles p
      on p.org_id = d.org_id and p.id = p_actor_id
    join public.organizations o on o.id = p.org_id
    join public.suppliers s
      on s.org_id = p.org_id and s.id = p.supplier_id and s.deleted_at is null
    where p_actor_id = auth.uid() and p_org_id = auth_org()
      and d.org_id = p_org_id
      and d.id = p_document_id
      and d.deleted_at is null
      and p.active
      and p.role = 'supplier'
      and o.status in ('trial', 'active')
      and d.entity_type = 'supplier'
      and d.entity_id = p.supplier_id
      and d.supplier_id = p.supplier_id
      and d.document_kind = 'price_list'
      and d.uploaded_by = p_actor_id
      and array_length(string_to_array(d.storage_path, '/'), 1) = 5
      and split_part(d.storage_path, '/', 1) = p.org_id::text
      and split_part(d.storage_path, '/', 2) = 'supplier'
      and split_part(d.storage_path, '/', 3) = p.supplier_id::text
      and split_part(d.storage_path, '/', 4) = d.id::text
      and split_part(d.storage_path, '/', 5) <> ''
      and split_part(d.storage_path, '/', 6) = ''
  )
$$;

revoke all on function public.supplier_price_document_owned(uuid, uuid, uuid)
  from public, anon;
grant execute on function public.supplier_price_document_owned(uuid, uuid, uuid)
  to authenticated, service_role;

-- Supplier document rows are registered only by the server-side reservation finalizer below.
-- Retain the P0 browser DML allowlist: generated document IDs are never caller-writable.
drop policy if exists supplier_price_documents_insert on public.documents;
revoke insert (id) on table public.documents from public, anon, authenticated;

create policy supplier_price_documents_select
on public.documents for select to authenticated
using (public.supplier_price_document_owned(org_id, id, auth.uid()));

create policy supplier_price_documents_storage_insert
on storage.objects for insert to authenticated
with check (
  bucket_id = 'documents'
  and auth_role() = 'supplier'
  and auth_supplier() is not null
  and array_length(storage.foldername(name), 1) = 4
  and (storage.foldername(name))[1] = auth_org()::text
  and (storage.foldername(name))[2] = 'supplier'
  and (storage.foldername(name))[3] = auth_supplier()::text
  and (storage.foldername(name))[4]
    ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and (owner = auth.uid() or owner_id = auth.uid()::text)
  and public.smart_document_mime_allowed(metadata ->> 'mimetype')
  and public.supplier_price_upload_reservation_active(
    name, metadata ->> 'mimetype', auth.uid()
  )
);

create policy supplier_price_documents_storage_select
on storage.objects for select to authenticated
using (
  bucket_id = 'documents'
  and exists (
    select 1 from public.documents d
    where d.storage_path = storage.objects.name
      and public.supplier_price_document_owned(d.org_id, d.id, auth.uid())
  )
);

create policy supplier_price_documents_storage_delete
on storage.objects for delete to authenticated
using (
  bucket_id = 'documents'
  and auth_role() = 'supplier'
  and auth_supplier() is not null
  and array_length(storage.foldername(name), 1) = 4
  and (storage.foldername(name))[1] = auth_org()::text
  and (storage.foldername(name))[2] = 'supplier'
  and (storage.foldername(name))[3] = auth_supplier()::text
  and (owner = auth.uid() or owner_id = auth.uid()::text)
  and not public.p0_document_path_registered(name)
  and public.supplier_price_upload_authorized(
    auth_org(), auth_supplier(), auth.uid()
  )
);

create policy supplier_price_document_jobs_select
on public.document_processing_jobs for select to authenticated
using (
  requested_by = auth.uid()
  and public.supplier_price_document_owned(org_id, document_id, auth.uid())
);

create policy supplier_price_document_extractions_select
on public.document_extractions for select to authenticated
using (
  public.supplier_price_document_owned(org_id, document_id, auth.uid())
  and exists (
    select 1 from public.document_processing_jobs j
    where j.org_id = document_extractions.org_id
      and j.id = document_extractions.job_id
      and j.document_id = document_extractions.document_id
      and j.requested_by = auth.uid()
  )
);

create policy supplier_price_document_interpretations_select
on public.document_interpretations for select to authenticated
using (
  interpreted_for_user_id = auth.uid()
  and public.supplier_price_document_owned(org_id, document_id, auth.uid())
);

create policy supplier_price_document_annotations_select
on public.document_annotations for select to authenticated
using (
  (applied_for_user_id is null or applied_for_user_id = auth.uid())
  and public.supplier_price_document_owned(org_id, document_id, auth.uid())
  and exists (
    select 1 from public.document_interpretations i
    where i.org_id = document_annotations.org_id
      and i.id = document_annotations.interpretation_id
      and i.document_id = document_annotations.document_id
      and i.interpreted_for_user_id = auth.uid()
  )
);

-- Preserve the existing staff enqueue path and add only the exact supplier-owned price-list case.
create or replace function public.enqueue_document_processing(p_document_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role user_role := auth_role();
  v_document public.documents;
  v_checksum text;
  v_job_id uuid;
begin
  if v_org is null or v_user is null
     or v_role not in ('owner', 'office', 'kitchen', 'supplier') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select * into v_document
  from public.documents
  where id = p_document_id and org_id = v_org and deleted_at is null;
  if not found then
    raise exception 'document_unknown' using errcode = 'P0002';
  end if;

  if v_role = 'supplier'
     and not public.supplier_price_document_owned(v_org, v_document.id, v_user) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  v_checksum := public.smart_document_source_checksum(
    v_document.org_id, v_document.storage_path, v_document.mime_type, v_document.uploaded_by
  );

  select j.id into v_job_id
  from public.document_processing_jobs j
  where j.org_id = v_org
    and j.document_id = v_document.id
    and j.input_checksum = v_checksum
    and j.contract_version = '1'
    and j.status <> 'failed'
  order by j.created_at desc
  limit 1;
  if v_job_id is not null then
    return v_job_id;
  end if;

  begin
    insert into public.document_processing_jobs (
      org_id, document_id, requested_by, input_checksum, contract_version
    ) values (
      v_org, v_document.id, v_user, v_checksum, '1'
    ) returning id into v_job_id;
  exception when unique_violation then
    select j.id into v_job_id
    from public.document_processing_jobs j
    where j.org_id = v_org
      and j.document_id = v_document.id
      and j.input_checksum = v_checksum
      and j.contract_version = '1'
      and j.status in ('queued', 'leased', 'extracted', 'interpreting', 'review')
    order by j.created_at desc
    limit 1;
  end;

  if v_job_id is null then
    raise exception 'document_processing_enqueue_conflict' using errcode = '40001';
  end if;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_org, v_user, 'document_processing_enqueued', 'document_processing_jobs', v_job_id,
    jsonb_build_object('document_id', v_document.id, 'contract_version', '1'),
    'document uploaded for extraction'
  );
  return v_job_id;
end
$$;

create or replace function public.register_supplier_price_document(p_document_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_role public.user_role;
  v_profile_supplier uuid;
  v_reservation public.supplier_price_document_upload_reservations;
  v_object_id uuid;
  v_object_updated_at timestamptz;
  v_object_mime text;
  v_object_size bigint;
  v_job_id uuid;
begin
  if v_org is null or v_actor is null or p_document_id is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select p.role, p.supplier_id into v_role, v_profile_supplier
  from public.profiles p
  join public.organizations o on o.id = p.org_id
  where p.id = v_actor and p.org_id = v_org and p.active
    and o.status in ('trial', 'active');
  if v_role is null or v_role not in ('owner', 'office', 'supplier') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select * into v_reservation
  from public.supplier_price_document_upload_reservations r
  where r.document_id = p_document_id
    and r.org_id = v_org
    and r.actor_id = v_actor
  for update;
  if not found then
    raise exception 'document_upload_reservation_unknown' using errcode = 'P0002';
  end if;

  if v_role = 'supplier'
     and v_profile_supplier is distinct from v_reservation.supplier_id then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform 1
  from public.suppliers s
  where s.org_id = v_org and s.id = v_reservation.supplier_id and s.deleted_at is null;
  if not found then
    raise exception 'supplier_unknown' using errcode = 'P0002';
  end if;

  if v_reservation.status = 'registered' then
    perform 1
    from public.documents d
    join public.document_processing_jobs j
      on j.org_id = d.org_id and j.id = v_reservation.job_id
      and j.document_id = d.id and j.requested_by = v_actor
    where d.org_id = v_org and d.id = v_reservation.document_id
      and d.deleted_at is null
      and d.entity_type = 'supplier'
      and d.entity_id = v_reservation.supplier_id
      and d.supplier_id = v_reservation.supplier_id
      and d.document_kind = 'price_list'
      and d.uploaded_by = v_actor
      and d.storage_path = v_reservation.storage_path
      and d.file_name = v_reservation.file_name
      and lower(d.mime_type) = v_reservation.mime_type;
    if not found then
      raise exception 'document_registration_invalid' using errcode = 'P0001';
    end if;
    return jsonb_build_object(
      'document_id', v_reservation.document_id,
      'job_id', v_reservation.job_id,
      'storage_path', v_reservation.storage_path,
      'idempotent', true
    );
  end if;

  if v_reservation.status <> 'reserved' or v_reservation.expires_at <= now() then
    raise exception 'document_upload_reservation_expired' using errcode = 'P0001';
  end if;

  select o.id, o.updated_at,
         lower(split_part(trim(coalesce(o.metadata ->> 'mimetype', '')), ';', 1)),
         case
           when coalesce(o.metadata ->> 'size', '') ~ '^[0-9]{1,12}$'
             then (o.metadata ->> 'size')::bigint
           else null
         end
    into v_object_id, v_object_updated_at, v_object_mime, v_object_size
  from storage.objects o
  where o.bucket_id = 'documents'
    and o.name = v_reservation.storage_path
    and (o.owner = v_actor or o.owner_id = v_actor::text)
  for update;
  if v_object_id is null
     or v_object_mime is distinct from v_reservation.mime_type
     or not public.smart_document_mime_allowed(v_object_mime)
     or v_object_size not between 1 and 10485760 then
    raise exception 'document_upload_object_invalid' using errcode = 'P0002';
  end if;

  insert into public.documents (
    id, org_id, entity_type, entity_id, supplier_id, storage_path,
    file_name, mime_type, document_kind, uploaded_by
  ) values (
    v_reservation.document_id, v_reservation.org_id,
    'supplier', v_reservation.supplier_id, v_reservation.supplier_id,
    v_reservation.storage_path, v_reservation.file_name,
    v_reservation.mime_type, 'price_list', v_actor
  );

  v_job_id := public.enqueue_document_processing(v_reservation.document_id);
  update public.supplier_price_document_upload_reservations
  set status = 'registered',
      object_id = v_object_id,
      object_updated_at = v_object_updated_at,
      job_id = v_job_id,
      registered_at = now()
  where document_id = v_reservation.document_id;

  return jsonb_build_object(
    'document_id', v_reservation.document_id,
    'job_id', v_job_id,
    'storage_path', v_reservation.storage_path,
    'idempotent', false
  );
end
$$;

revoke all on function public.register_supplier_price_document(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.register_supplier_price_document(uuid)
  to authenticated;

-- ===== Supplier interpretation fence =====

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

  select p.supplier_id into v_supplier
  from public.profiles p
  join public.organizations o on o.id = p.org_id
  join public.suppliers s
    on s.org_id = p.org_id and s.id = p.supplier_id and s.deleted_at is null
  where p.org_id = v_job.org_id and p.id = p_actor_id
    and p.active and p.role = 'supplier'
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

-- Existing interpretation RPCs call this assertion. The local fence can only be set by the
-- service-only wrappers below after a complete supplier document-chain verification.
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

create or replace function public.begin_supplier_price_interpretation(
  p_job_id uuid,
  p_extraction_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform public.assert_supplier_price_interpretation_context(
    p_job_id, p_extraction_id, p_actor_id
  );
  select org_id into v_org from public.document_processing_jobs where id = p_job_id;
  perform set_config('app.ocr_supplier_interpretation_actor', p_actor_id::text, true);
  perform set_config('app.ocr_supplier_interpretation_org', v_org::text, true);
  return public.begin_document_interpretation(p_job_id, p_extraction_id, p_actor_id);
end
$$;

revoke all on function public.begin_supplier_price_interpretation(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.begin_supplier_price_interpretation(uuid, uuid, uuid)
  to service_role;

create or replace function public.save_supplier_price_interpretation(
  p_job_id uuid,
  p_extraction_id uuid,
  p_actor_id uuid,
  p_interpretation_started_at timestamptz,
  p_provider text,
  p_model text,
  p_prompt_version text,
  p_schema_version text,
  p_payload jsonb,
  p_usage jsonb default '{}'::jsonb,
  p_duration_ms integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform public.assert_supplier_price_interpretation_context(
    p_job_id, p_extraction_id, p_actor_id
  );
  select org_id into v_org from public.document_processing_jobs where id = p_job_id;
  perform set_config('app.ocr_supplier_interpretation_actor', p_actor_id::text, true);
  perform set_config('app.ocr_supplier_interpretation_org', v_org::text, true);
  return public.save_document_interpretation(
    p_job_id, p_extraction_id, p_actor_id, p_interpretation_started_at,
    p_provider, p_model, p_prompt_version, p_schema_version,
    p_payload, p_usage, p_duration_ms
  );
end
$$;

revoke all on function public.save_supplier_price_interpretation(
  uuid, uuid, uuid, timestamptz, text, text, text, text, jsonb, jsonb, integer
) from public, anon, authenticated;
grant execute on function public.save_supplier_price_interpretation(
  uuid, uuid, uuid, timestamptz, text, text, text, text, jsonb, jsonb, integer
) to service_role;

create or replace function public.fail_supplier_price_interpretation(
  p_job_id uuid,
  p_extraction_id uuid,
  p_actor_id uuid,
  p_interpretation_started_at timestamptz,
  p_error_code text,
  p_error_message text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform public.assert_supplier_price_interpretation_context(
    p_job_id, p_extraction_id, p_actor_id
  );
  select org_id into v_org from public.document_processing_jobs where id = p_job_id;
  perform set_config('app.ocr_supplier_interpretation_actor', p_actor_id::text, true);
  perform set_config('app.ocr_supplier_interpretation_org', v_org::text, true);
  return public.fail_document_interpretation(
    p_job_id, p_extraction_id, p_actor_id, p_interpretation_started_at,
    p_error_code, p_error_message
  );
end
$$;

revoke all on function public.fail_supplier_price_interpretation(
  uuid, uuid, uuid, timestamptz, text, text
) from public, anon, authenticated;
grant execute on function public.fail_supplier_price_interpretation(
  uuid, uuid, uuid, timestamptz, text, text
) to service_role;

-- ===== Service-only review confirmation intake =====

create or replace function public.prepare_ocr_supplier_price_intake(
  p_intake_id uuid,
  p_actor_id uuid,
  p_submission_id uuid,
  p_document_id uuid,
  p_interpretation_id uuid,
  p_target_month date,
  p_approved_rows jsonb,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_org uuid;
  v_role public.user_role;
  v_profile_supplier uuid;
  v_document public.documents;
  v_job public.document_processing_jobs;
  v_extraction public.document_extractions;
  v_interpretation public.document_interpretations;
  v_object_id uuid;
  v_object_updated_at timestamptz;
  v_mime text;
  v_file_size bigint;
  v_item jsonb;
  v_line_item jsonb;
  v_line_index integer;
  v_source_row integer;
  v_product_id_text text;
  v_product_name text;
  v_price_text text;
  v_available boolean;
  v_seen_indexes integer[] := array[]::integer[];
  v_rows jsonb := '[]'::jsonb;
  v_normalized_rows jsonb := '[]'::jsonb;
  v_checksum text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'price_submission_intake_service_only' using errcode = '42501';
  end if;
  if p_intake_id is null or p_actor_id is null or p_submission_id is null
     or p_document_id is null or p_interpretation_id is null
     or p_submission_id <> p_interpretation_id
     or p_target_month is null
     or p_target_month <> date_trunc('month', p_target_month)::date
     or length(trim(coalesce(p_reason, ''))) not between 1 and 1000
     or p_approved_rows is null
     or jsonb_typeof(p_approved_rows) <> 'array'
     or jsonb_array_length(p_approved_rows) not between 1 and 5000 then
    raise exception 'price_submission_intake_invalid' using errcode = '22023';
  end if;

  select p.org_id, p.role, p.supplier_id
    into v_org, v_role, v_profile_supplier
  from public.profiles p
  join public.organizations o on o.id = p.org_id
  where p.id = p_actor_id and p.active
    and o.status in ('trial', 'active');
  if v_org is null or v_role not in ('owner', 'office', 'supplier') then
    raise exception 'price_submission_not_authorized' using errcode = '42501';
  end if;

  select * into v_document
  from public.documents d
  where d.org_id = v_org and d.id = p_document_id
    and d.deleted_at is null
    and d.entity_type = 'supplier'
    and d.entity_id is not null
    and d.entity_id = d.supplier_id
    and d.document_kind = 'price_list'
    and d.uploaded_by = p_actor_id
    and array_length(string_to_array(d.storage_path, '/'), 1) = 5
    and split_part(d.storage_path, '/', 1) = d.org_id::text
    and split_part(d.storage_path, '/', 2) = 'supplier'
    and split_part(d.storage_path, '/', 3) = d.supplier_id::text
    and split_part(d.storage_path, '/', 4) = d.id::text
    and split_part(d.storage_path, '/', 5) <> ''
    and split_part(d.storage_path, '/', 6) = ''
  for share;
  if not found then
    raise exception 'price_submission_document_invalid' using errcode = 'P0002';
  end if;
  if v_role = 'supplier'
     and v_profile_supplier is distinct from v_document.supplier_id then
    raise exception 'price_submission_not_authorized' using errcode = '42501';
  end if;

  perform 1 from public.suppliers s
  where s.org_id = v_org and s.id = v_document.supplier_id and s.deleted_at is null
  for share;
  if not found then
    raise exception 'price_submission_supplier_invalid' using errcode = 'P0002';
  end if;

  select * into v_interpretation
  from public.document_interpretations i
  where i.org_id = v_org and i.id = p_interpretation_id
    and i.document_id = v_document.id
    and i.interpreted_for_user_id = p_actor_id
    and i.schema_version = '1'
    and i.payload ->> 'document_type' = 'price_list'
    and (
      i.suggested_supplier_id is null
      or i.suggested_supplier_id = v_document.supplier_id
    )
  for share;
  if not found then
    raise exception 'price_submission_interpretation_invalid' using errcode = 'P0002';
  end if;

  select * into v_job
  from public.document_processing_jobs j
  where j.org_id = v_org and j.id = v_interpretation.job_id
    and j.document_id = v_document.id
    and j.requested_by = p_actor_id
    and j.interpretation_actor_id = p_actor_id
    and j.contract_version = '1'
    and j.status in ('review', 'completed')
  for update;
  if not found then
    raise exception 'price_submission_job_invalid' using errcode = 'P0002';
  end if;

  select * into v_extraction
  from public.document_extractions e
  where e.org_id = v_org and e.id = v_interpretation.extraction_id
    and e.job_id = v_job.id and e.document_id = v_document.id
    and e.contract_version = '1'
    and e.input_checksum = v_job.input_checksum;
  if not found then
    raise exception 'price_submission_extraction_invalid' using errcode = 'P0002';
  end if;

  if v_interpretation.extraction_id is distinct from v_extraction.id
     or public.smart_document_source_checksum(
          v_document.org_id,
          v_document.storage_path,
          v_document.mime_type,
          v_document.uploaded_by
        ) is distinct from v_job.input_checksum then
    raise exception 'price_submission_file_changed' using errcode = 'P0001';
  end if;

  select o.id, o.updated_at,
         lower(split_part(coalesce(o.metadata ->> 'mimetype', ''), ';', 1)),
         case
           when coalesce(o.metadata ->> 'size', '') ~ '^[0-9]{1,12}$'
             then (o.metadata ->> 'size')::bigint
           else null
         end
    into v_object_id, v_object_updated_at, v_mime, v_file_size
  from storage.objects o
  where o.bucket_id = 'documents'
    and o.name = v_document.storage_path
    and (o.owner = p_actor_id or o.owner_id = p_actor_id::text)
    and lower(split_part(coalesce(o.metadata ->> 'mimetype', ''), ';', 1))
      = lower(v_document.mime_type)
  for update;
  if v_object_id is null or not public.smart_document_mime_allowed(v_mime)
     or v_file_size not between 1 and 10485760 then
    raise exception 'price_submission_file_missing' using errcode = 'P0002';
  end if;

  for v_item in select value from jsonb_array_elements(p_approved_rows)
  loop
    if jsonb_typeof(v_item) <> 'object'
       or exists (
         select 1 from jsonb_object_keys(v_item) key
         where key not in ('lineItemIndex', 'productId', 'priceText', 'available')
       )
       or not (v_item ?& array['lineItemIndex', 'productId', 'priceText'])
       or jsonb_typeof(v_item -> 'lineItemIndex') <> 'number'
       or coalesce(v_item ->> 'lineItemIndex', '') !~ '^[0-9]{1,4}$'
       or jsonb_typeof(v_item -> 'productId') <> 'string'
       or coalesce(v_item ->> 'productId', '')
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or jsonb_typeof(v_item -> 'priceText') <> 'string'
       or length(trim(coalesce(v_item ->> 'priceText', ''))) not between 1 and 64
       or (
         v_item ? 'available'
         and jsonb_typeof(v_item -> 'available') <> 'boolean'
       ) then
      raise exception 'price_submission_intake_invalid' using errcode = '22023';
    end if;

    v_line_index := (v_item ->> 'lineItemIndex')::integer;
    if v_line_index = any(v_seen_indexes)
       or v_line_index >= jsonb_array_length(v_interpretation.payload -> 'line_items') then
      raise exception 'price_submission_intake_invalid' using errcode = '22023';
    end if;
    v_seen_indexes := array_append(v_seen_indexes, v_line_index);
    v_line_item := v_interpretation.payload -> 'line_items' -> v_line_index;
    if v_line_item is null or jsonb_typeof(v_line_item) <> 'object' then
      raise exception 'price_submission_intake_invalid' using errcode = '22023';
    end if;

    v_source_row := case
      when jsonb_typeof(v_line_item -> 'source_row') = 'number'
       and coalesce(v_line_item ->> 'source_row', '') ~ '^[0-9]{1,6}$'
        then (v_line_item ->> 'source_row')::integer
      else v_line_index + 2
    end;
    v_product_id_text := lower(trim(v_item ->> 'productId'));
    select p.name into v_product_name
    from public.products p
    where p.org_id = v_org and p.id::text = v_product_id_text and p.active;
    v_product_name := coalesce(
      v_product_name,
      nullif(left(trim(coalesce(v_line_item -> 'values' ->> 'product_name', '')), 200), ''),
      nullif(left(trim(coalesce(v_line_item -> 'values' ->> 'product', '')), 200), ''),
      v_product_id_text
    );
    v_price_text := trim(v_item ->> 'priceText');
    v_available := case
      when v_item ? 'available' then (v_item ->> 'available')::boolean
      else true
    end;

    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      '_line_item_index', v_line_index,
      'source_row', v_source_row,
      'product_id', v_product_id_text,
      'product_name', v_product_name,
      'price_text', v_price_text,
      'available', v_available
    ));
    v_normalized_rows := v_normalized_rows || jsonb_build_array(jsonb_build_object(
      'line_item_index', v_line_index,
      'product_id', v_product_id_text,
      'price_text', v_price_text,
      'available', v_available
    ));
  end loop;

  select coalesce(jsonb_agg(value order by (value ->> 'line_item_index')::integer), '[]'::jsonb)
    into v_normalized_rows
  from jsonb_array_elements(v_normalized_rows);
  select coalesce(
           jsonb_agg(
             value - '_line_item_index'
             order by (value ->> '_line_item_index')::integer
           ),
           '[]'::jsonb
         )
    into v_rows
  from jsonb_array_elements(v_rows);

  v_checksum := encode(digest(convert_to(jsonb_build_object(
    'contract_version', '1',
    'document_id', v_document.id,
    'interpretation_id', v_interpretation.id,
    'source_input_checksum', v_job.input_checksum,
    'supplier_id', v_document.supplier_id,
    'target_month', p_target_month,
    'approved_rows', v_normalized_rows
  )::text, 'UTF8'), 'sha256'), 'hex');

  delete from public.supplier_price_submission_intakes where expires_at <= now();
  begin
    insert into public.supplier_price_submission_intakes (
      id, org_id, actor_id, supplier_id, submission_id, target_month,
      file_name, storage_path, object_id, object_updated_at, mime_type,
      file_checksum, file_size, rows_payload, reason, status,
      source_document_id, source_job_id, source_extraction_id,
      source_interpretation_id, source_input_checksum,
      source_contract_version, source_schema_version
    ) values (
      p_intake_id, v_org, p_actor_id, v_document.supplier_id, p_submission_id,
      p_target_month, trim(v_document.file_name), v_document.storage_path,
      v_object_id, v_object_updated_at, v_mime,
      v_checksum, v_file_size, v_rows, trim(p_reason), 'prepared',
      v_document.id, v_job.id, v_extraction.id, v_interpretation.id,
      v_job.input_checksum, v_job.contract_version, v_interpretation.schema_version
    );
  exception when unique_violation then
    raise exception 'price_submission_intake_busy' using errcode = '55P03';
  end;

  return jsonb_build_object(
    'intake_id', p_intake_id,
    'supplier_id', v_document.supplier_id,
    'file_checksum', v_checksum,
    'source_input_checksum', v_job.input_checksum
  );
end
$$;

revoke all on function public.prepare_ocr_supplier_price_intake(
  uuid, uuid, uuid, uuid, uuid, date, jsonb, text
) from public, anon, authenticated;
grant execute on function public.prepare_ocr_supplier_price_intake(
  uuid, uuid, uuid, uuid, uuid, date, jsonb, text
) to service_role;

-- The private implementation still performs every catalog/price/history/ledger write. It now
-- accepts either the original trusted file intake or the equally strict reviewed-document intake.
create or replace function public.p1b_submit_supplier_price_list_internal(
  p_submission_id uuid,
  p_supplier_id uuid,
  p_target_month date,
  p_file_name text,
  p_storage_path text,
  p_file_checksum text,
  p_rows jsonb,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role user_role := auth_role();
  v_auth_supplier uuid := auth_supplier();
  v_reason text := nullif(trim(p_reason), '');
  v_checksum text := lower(trim(coalesce(p_file_checksum, '')));
  v_intake public.supplier_price_submission_intakes%rowtype;
  v_submission public.supplier_price_submissions%rowtype;
  v_item jsonb;
  v_ordinal bigint;
  v_source_row integer;
  v_product_id uuid;
  v_product_name text;
  v_price_text text;
  v_price numeric;
  v_available boolean;
  v_seen_products uuid[] := array[]::uuid[];
  v_valid_rows jsonb := '[]'::jsonb;
  v_rejections jsonb := '[]'::jsonb;
  v_import_result jsonb := '{}'::jsonb;
  v_created integer := 0;
  v_updated integer := 0;
  v_accepted integer := 0;
  v_unchanged integer := 0;
  v_rejected integer := 0;
  v_revision integer;
  v_status text;
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office', 'supplier') then
    raise exception 'price_submission_not_authorized' using errcode = '42501';
  end if;
  if v_role = 'supplier' and (v_auth_supplier is null or v_auth_supplier <> p_supplier_id) then
    raise exception 'price_submission_not_authorized' using errcode = '42501';
  end if;

  select * into v_intake
  from public.supplier_price_submission_intakes intake
  where intake.org_id = v_org
    and intake.actor_id = v_user
    and intake.submission_id = p_submission_id
    and intake.supplier_id = p_supplier_id
    and intake.target_month = p_target_month
    and intake.file_name = trim(p_file_name)
    and intake.storage_path = p_storage_path
    and intake.file_checksum = v_checksum
    and intake.rows_payload = p_rows
    and intake.reason = v_reason
    and intake.status = 'prepared'
    and intake.expires_at > now()
  for update;
  if not found then
    raise exception 'price_submission_intake_required' using errcode = 'P0002';
  end if;

  if p_submission_id is null or p_supplier_id is null or p_target_month is null
     or p_target_month <> date_trunc('month', p_target_month)::date
     or v_reason is null
     or p_rows is null or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 5000
     or length(trim(coalesce(p_file_name, ''))) not between 1 and 255
     or p_file_name ~ '[\\/]'
     or v_checksum !~ '^[0-9a-f]{64}$'
     or p_storage_path is null then
    raise exception 'price_submission_invalid' using errcode = '22023';
  end if;

  if v_intake.source_document_id is null then
    if array_length(string_to_array(p_storage_path, '/'), 1) <> 5
       or split_part(p_storage_path, '/', 1) <> v_org::text
       or split_part(p_storage_path, '/', 2) <> 'price-submissions'
       or split_part(p_storage_path, '/', 3) <> p_supplier_id::text
       or split_part(p_storage_path, '/', 4) <> p_submission_id::text
       or split_part(p_storage_path, '/', 5) = ''
       or split_part(p_storage_path, '/', 6) <> '' then
      raise exception 'price_submission_invalid' using errcode = '22023';
    end if;
  elsif array_length(string_to_array(p_storage_path, '/'), 1) <> 5
     or split_part(p_storage_path, '/', 1) <> v_org::text
     or split_part(p_storage_path, '/', 2) <> 'supplier'
     or split_part(p_storage_path, '/', 3) <> p_supplier_id::text
     or split_part(p_storage_path, '/', 4) <> v_intake.source_document_id::text
     or split_part(p_storage_path, '/', 5) = ''
     or split_part(p_storage_path, '/', 6) <> '' then
    raise exception 'price_submission_invalid' using errcode = '22023';
  end if;

  -- One supplier row serializes revisions and checksum retries for every month.
  perform 1
  from public.suppliers s
  where s.org_id = v_org and s.id = p_supplier_id and s.deleted_at is null
  for update;
  if not found then
    raise exception 'price_submission_supplier_invalid' using errcode = 'P0002';
  end if;

  select * into v_submission
  from public.supplier_price_submissions submission
  where submission.id = p_submission_id;
  if found then
    if v_submission.org_id <> v_org
       or v_submission.supplier_id <> p_supplier_id
       or v_submission.target_month <> p_target_month
       or v_submission.file_checksum <> v_checksum
       or v_submission.source_interpretation_id
            is distinct from v_intake.source_interpretation_id then
      raise exception 'price_submission_idempotency_conflict' using errcode = 'P0001';
    end if;
    return jsonb_build_object(
      'submission_id', v_submission.id,
      'revision', v_submission.revision,
      'status', v_submission.status,
      'accepted_count', v_submission.accepted_count,
      'rejected_count', v_submission.rejected_count,
      'unchanged_count', v_submission.unchanged_count,
      'rejections', v_submission.rejections,
      'storage_path', v_submission.storage_path,
      'idempotent', true
    );
  end if;

  select * into v_submission
  from public.supplier_price_submissions submission
  where submission.org_id = v_org
    and submission.supplier_id = p_supplier_id
    and submission.target_month = p_target_month
    and submission.file_checksum = v_checksum;
  if found then
    return jsonb_build_object(
      'submission_id', v_submission.id,
      'revision', v_submission.revision,
      'status', v_submission.status,
      'accepted_count', v_submission.accepted_count,
      'rejected_count', v_submission.rejected_count,
      'unchanged_count', v_submission.unchanged_count,
      'rejections', v_submission.rejections,
      'storage_path', v_submission.storage_path,
      'idempotent', true
    );
  end if;

  if v_intake.source_document_id is null then
    perform 1
    from storage.objects o
    where o.bucket_id = 'price-submissions'
      and o.name = p_storage_path
      and o.id = v_intake.object_id
      and o.updated_at = v_intake.object_updated_at
      and (o.owner = v_user or o.owner_id = v_user::text)
      and lower(split_part(coalesce(o.metadata ->> 'mimetype', ''), ';', 1))
        = v_intake.mime_type
      and lower(split_part(coalesce(o.metadata ->> 'mimetype', ''), ';', 1)) in (
        'text/csv',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
    if not found then
      raise exception 'price_submission_file_changed' using errcode = 'P0001';
    end if;
  else
    perform 1
    from public.documents d
    join public.document_processing_jobs j
      on j.org_id = d.org_id and j.id = v_intake.source_job_id
      and j.document_id = d.id
    join public.document_extractions e
      on e.org_id = j.org_id and e.id = v_intake.source_extraction_id
      and e.job_id = j.id and e.document_id = d.id
    join public.document_interpretations i
      on i.org_id = e.org_id and i.id = v_intake.source_interpretation_id
      and i.job_id = j.id and i.extraction_id = e.id and i.document_id = d.id
    join storage.objects o
      on o.bucket_id = 'documents' and o.name = d.storage_path
    where d.org_id = v_org and d.id = v_intake.source_document_id
      and d.deleted_at is null
      and d.entity_type = 'supplier'
      and d.entity_id = p_supplier_id
      and d.supplier_id = p_supplier_id
      and d.document_kind = 'price_list'
      and d.uploaded_by = v_user
      and j.requested_by = v_user
      and j.interpretation_actor_id = v_user
      and j.input_checksum = v_intake.source_input_checksum
      and j.contract_version = v_intake.source_contract_version
      and j.status in ('review', 'completed')
      and e.input_checksum = j.input_checksum
      and e.contract_version = j.contract_version
      and i.interpreted_for_user_id = v_user
      and i.schema_version = v_intake.source_schema_version
      and i.payload ->> 'document_type' = 'price_list'
      and (i.suggested_supplier_id is null or i.suggested_supplier_id = p_supplier_id)
      and o.id = v_intake.object_id
      and o.updated_at = v_intake.object_updated_at
      and (o.owner = v_user or o.owner_id = v_user::text)
      and lower(split_part(coalesce(o.metadata ->> 'mimetype', ''), ';', 1))
        = v_intake.mime_type;
    if not found then
      raise exception 'price_submission_file_changed' using errcode = 'P0001';
    end if;

    if public.smart_document_source_checksum(
         v_org, p_storage_path, v_intake.mime_type, v_user
       ) is distinct from v_intake.source_input_checksum then
      raise exception 'price_submission_file_changed' using errcode = 'P0001';
    end if;
  end if;

  -- Every source row receives an independent verdict. Product ids resolve only against the
  -- active tenant catalog; names alone never create a catalog product.
  for v_item, v_ordinal in
    select input.value, input.ordinality
    from jsonb_array_elements(p_rows) with ordinality as input(value, ordinality)
  loop
    if jsonb_typeof(v_item) <> 'object' then
      v_rejections := v_rejections || jsonb_build_array(jsonb_build_object(
        'row', v_ordinal + 1,
        'reason', 'invalid_row',
        'message', 'השורה אינה במבנה נתונים תקין'
      ));
      continue;
    end if;

    if coalesce(v_item ->> 'source_row', '') ~ '^[0-9]{1,6}$'
       and (v_item ->> 'source_row')::integer >= 2 then
      v_source_row := (v_item ->> 'source_row')::integer;
    else
      v_source_row := (v_ordinal + 1)::integer;
    end if;
    v_product_name := left(trim(coalesce(v_item ->> 'product_name', '')), 200);

    v_product_id := null;
    select p.id into v_product_id
    from public.products p
    where p.org_id = v_org
      and p.active
      and p.id::text = trim(coalesce(v_item ->> 'product_id', ''));
    if v_product_id is null then
      v_rejections := v_rejections || jsonb_build_array(jsonb_build_object(
        'row', v_source_row,
        'product', nullif(v_product_name, ''),
        'reason', 'unknown_product',
        'message', 'המוצר אינו קיים בקטלוג הפעיל; לא נוצר מוצר חדש'
      ));
      continue;
    end if;

    v_price_text := regexp_replace(
      trim(coalesce(v_item ->> 'price_text', '')),
      '[[:space:]₪,]', '', 'g'
    );
    if length(v_price_text) > 16 or v_price_text !~ '^[0-9]+([.][0-9]{1,4})?$' then
      v_rejections := v_rejections || jsonb_build_array(jsonb_build_object(
        'row', v_source_row,
        'product', nullif(v_product_name, ''),
        'reason', 'invalid_price',
        'message', 'נדרש מחיר חיובי ותקין'
      ));
      continue;
    end if;
    v_price := round(v_price_text::numeric, 2);
    if v_price <= 0 or v_price > 1000000 then
      v_rejections := v_rejections || jsonb_build_array(jsonb_build_object(
        'row', v_source_row,
        'product', nullif(v_product_name, ''),
        'reason', 'invalid_price',
        'message', 'המחיר חייב להיות גדול מאפס ועד 1,000,000'
      ));
      continue;
    end if;

    if v_product_id = any(v_seen_products) then
      v_rejections := v_rejections || jsonb_build_array(jsonb_build_object(
        'row', v_source_row,
        'product', nullif(v_product_name, ''),
        'reason', 'duplicate_product',
        'message', 'המוצר מופיע יותר מפעם אחת בקובץ; רק השורה הראשונה נקלטה'
      ));
      continue;
    end if;

    v_available := case
      when jsonb_typeof(v_item -> 'available') = 'boolean'
        then (v_item ->> 'available')::boolean
      else true
    end;
    v_seen_products := array_append(v_seen_products, v_product_id);
    v_valid_rows := v_valid_rows || jsonb_build_array(jsonb_build_object(
      'supplier_id', p_supplier_id,
      'product_id', v_product_id,
      'price', v_price,
      'available', v_available
    ));
  end loop;

  v_rejected := jsonb_array_length(v_rejections);
  if jsonb_array_length(v_valid_rows) > 0 then
    v_import_result := public.p1_import_supplier_prices_internal(
      v_valid_rows, p_target_month, v_reason
    );
    v_created := coalesce((v_import_result ->> 'created')::integer, 0);
    v_updated := coalesce((v_import_result ->> 'updated')::integer, 0);
    v_unchanged := coalesce((v_import_result ->> 'unchanged')::integer, 0);
    v_accepted := v_created + v_updated;
  end if;

  v_status := case
    when jsonb_array_length(v_valid_rows) = 0 then 'rejected'
    when v_rejected > 0 then 'accepted_with_rejections'
    else 'accepted'
  end;

  select coalesce(max(submission.revision), 0) + 1 into v_revision
  from public.supplier_price_submissions submission
  where submission.org_id = v_org
    and submission.supplier_id = p_supplier_id
    and submission.target_month = p_target_month;

  insert into public.supplier_price_submissions (
    id, org_id, supplier_id, target_month, revision,
    file_name, storage_path, file_checksum, status,
    accepted_count, rejected_count, unchanged_count,
    row_count, created_count, updated_count, rejections,
    submitted_by,
    source_document_id, source_job_id, source_extraction_id,
    source_interpretation_id, source_input_checksum,
    source_contract_version, source_schema_version,
    source_object_id, source_object_updated_at
  ) values (
    p_submission_id, v_org, p_supplier_id, p_target_month, v_revision,
    trim(p_file_name), p_storage_path, v_checksum, v_status,
    v_accepted, v_rejected, v_unchanged,
    v_created + v_updated + v_unchanged + v_rejected,
    v_created, v_updated, v_rejections,
    v_user,
    v_intake.source_document_id, v_intake.source_job_id,
    v_intake.source_extraction_id, v_intake.source_interpretation_id,
    v_intake.source_input_checksum, v_intake.source_contract_version,
    v_intake.source_schema_version,
    case when v_intake.source_document_id is null then null else v_intake.object_id end,
    case
      when v_intake.source_document_id is null then null
      else v_intake.object_updated_at
    end
  ) returning * into v_submission;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id,
    old_values, new_values, reason
  ) values (
    v_org, v_user, 'supplier_price_submission_processed',
    'supplier_price_submissions', p_submission_id,
    null,
    jsonb_build_object(
      'supplier_id', p_supplier_id,
      'target_month', p_target_month,
      'revision', v_revision,
      'file_checksum', v_checksum,
      'status', v_status,
      'accepted_count', v_accepted,
      'rejected_count', v_rejected,
      'unchanged_count', v_unchanged,
      'source_document_id', v_intake.source_document_id,
      'source_job_id', v_intake.source_job_id,
      'source_extraction_id', v_intake.source_extraction_id,
      'source_interpretation_id', v_intake.source_interpretation_id,
      'source_input_checksum', v_intake.source_input_checksum
    ),
    v_reason
  );

  return jsonb_build_object(
    'submission_id', v_submission.id,
    'revision', v_submission.revision,
    'status', v_submission.status,
    'accepted_count', v_submission.accepted_count,
    'rejected_count', v_submission.rejected_count,
    'unchanged_count', v_submission.unchanged_count,
    'rejections', v_submission.rejections,
    'storage_path', v_submission.storage_path,
    'idempotent', false
  );
end
$$;

revoke all on function public.p1b_submit_supplier_price_list_internal(
  uuid, uuid, date, text, text, text, jsonb, text
) from public, anon, authenticated, service_role;

-- The public command boundary is unchanged. OCR provenance is completed atomically only after
-- the same internal writer returns a receipt.
create or replace function public.submit_supplier_price_list(p_intake_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role public.user_role := auth_role();
  v_intake public.supplier_price_submission_intakes%rowtype;
  v_result jsonb;
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office', 'supplier') then
    raise exception 'price_submission_not_authorized' using errcode = '42501';
  end if;

  select * into v_intake
  from public.supplier_price_submission_intakes intake
  where intake.id = p_intake_id
    and intake.org_id = v_org
    and intake.actor_id = v_user
    and intake.status = 'prepared'
    and intake.expires_at > now()
  for update;
  if not found then
    raise exception 'price_submission_intake_required' using errcode = 'P0002';
  end if;

  if v_role = 'supplier' and auth_supplier() is distinct from v_intake.supplier_id then
    raise exception 'price_submission_not_authorized' using errcode = '42501';
  end if;

  v_result := public.p1b_submit_supplier_price_list_internal(
    v_intake.submission_id,
    v_intake.supplier_id,
    v_intake.target_month,
    v_intake.file_name,
    v_intake.storage_path,
    v_intake.file_checksum,
    v_intake.rows_payload,
    v_intake.reason
  );

  if v_intake.source_job_id is not null then
    update public.document_processing_jobs
    set status = 'completed', last_error_code = null, last_error_message = null
    where org_id = v_intake.org_id and id = v_intake.source_job_id
      and document_id = v_intake.source_document_id
      and status = 'review';

    if found then
      insert into public.audit_logs (
        org_id, user_id, action, entity_type, entity_id, new_values, reason
      ) values (
        v_intake.org_id, v_user, 'document_price_list_confirmed',
        'document_processing_jobs', v_intake.source_job_id,
        jsonb_build_object(
          'document_id', v_intake.source_document_id,
          'interpretation_id', v_intake.source_interpretation_id,
          'submission_id', v_result ->> 'submission_id'
        ),
        v_intake.reason
      );
    end if;
  end if;

  delete from public.supplier_price_submission_intakes where id = v_intake.id;
  return v_result;
end
$$;

revoke all on function public.submit_supplier_price_list(uuid) from public, anon;
grant execute on function public.submit_supplier_price_list(uuid) to authenticated;

comment on function public.submit_supplier_price_list(uuid) is
  'Sole authenticated price-list writer; consumes a service-authored file or reviewed OCR intake.';

-- Fail closed if a browser-visible alternate price writer reappears.
do $$
begin
  if has_function_privilege(
       'authenticated',
       'public.p1b_submit_supplier_price_list_internal(uuid,uuid,date,text,text,text,jsonb,text)',
       'EXECUTE'
     )
     or has_function_privilege(
       'service_role',
       'public.p1b_submit_supplier_price_list_internal(uuid,uuid,date,text,text,text,jsonb,text)',
       'EXECUTE'
     ) then
    raise exception '0048 refused: private supplier price writer is executable.';
  end if;
end
$$;
