-- 0045 — Tenant-safe smart document processing contract.
-- Historical 0001/0004 live-ledger drift is limited to leading comments and was explicitly
-- accepted on 2026-07-29. Applied migrations remain untouched; this migration is forward-only.

-- ===== Source document contract =====

create or replace function public.smart_document_mime_allowed(p_mime text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select lower(coalesce(p_mime, '')) in (
    'application/pdf',
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif', 'image/avif',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/rtf', 'text/rtf',
    'text/plain', 'text/html',
    'application/vnd.oasis.opendocument.text'
  )
$$;

revoke all on function public.smart_document_mime_allowed(text) from public, anon;
grant execute on function public.smart_document_mime_allowed(text) to authenticated, service_role;

alter table public.documents drop constraint documents_kind_check;
alter table public.documents add constraint documents_kind_check check (
  document_kind in (
    'invoice', 'delivery_note', 'credit', 'quote', 'price_list',
    'payment_confirmation', 'other'
  )
);

alter table public.documents drop constraint p0_documents_mime_check;
alter table public.documents add constraint p0_documents_mime_check check (
  mime_type is null or public.smart_document_mime_allowed(mime_type)
) not valid;
alter table public.documents validate constraint p0_documents_mime_check;

-- Composite identity is required by every tenant FK below. The UUID primary key remains intact.
alter table public.documents
  add constraint smart_documents_org_id_id_key unique (org_id, id);

create or replace function public.p0_document_object_owned(p_path text, p_mime text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from storage.objects o
    where o.bucket_id = 'documents'
      and o.name = p_path
      and (o.owner = auth.uid() or o.owner_id = auth.uid()::text)
      and lower(coalesce(o.metadata ->> 'mimetype', '')) = lower(p_mime)
      and public.smart_document_mime_allowed(p_mime)
  )
$$;

revoke all on function public.p0_document_object_owned(text, text) from public, anon;
grant execute on function public.p0_document_object_owned(text, text) to authenticated;

create or replace function public.documents_guard_columns()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  refiling boolean;
  validate_entity boolean := true;
  validate_supplier boolean := true;
begin
  if tg_op = 'UPDATE' then
    refiling := old.entity_type = 'inbox'
                and new.entity_type in ('invoice', 'goods_receipt')
                and new.entity_id is not null;
    validate_entity := new.entity_type is distinct from old.entity_type
                       or new.entity_id is distinct from old.entity_id;
    validate_supplier := new.supplier_id is distinct from old.supplier_id;

    if new.org_id is distinct from old.org_id
       or new.storage_path is distinct from old.storage_path
       or new.file_name is distinct from old.file_name
       or new.mime_type is distinct from old.mime_type
       or new.uploaded_by is distinct from old.uploaded_by
       or new.created_at is distinct from old.created_at
       or (not refiling and validate_entity) then
      raise exception 'documents: only metadata, soft-delete fields, or inbox filing may be changed'
        using errcode = '42501';
    end if;

    if refiling
       and auth.uid() is not null
       and current_setting('app.document_filing_writer', true) is distinct from auth.uid()::text then
      raise exception 'document_filing_rpc_required' using errcode = '42501';
    end if;
  end if;

  if validate_supplier and new.supplier_id is not null and not exists (
    select 1 from public.suppliers s where s.id = new.supplier_id and s.org_id = new.org_id
  ) then
    raise exception 'documents: supplier must belong to the document organization'
      using errcode = '23514';
  end if;

  if validate_entity and new.entity_type = 'invoice' and not exists (
    select 1 from public.invoices i where i.id = new.entity_id and i.org_id = new.org_id
  ) then
    raise exception 'documents: invoice must belong to the document organization'
      using errcode = '23514';
  end if;

  if validate_entity and new.entity_type = 'goods_receipt' and not exists (
    select 1 from public.goods_receipts gr where gr.id = new.entity_id and gr.org_id = new.org_id
  ) then
    raise exception 'documents: goods receipt must belong to the document organization'
      using errcode = '23514';
  end if;

  if new.entity_type = 'payment' and not exists (
    select 1 from public.payments p where p.id = new.entity_id and p.org_id = new.org_id
  ) then
    raise exception 'documents: payment must belong to the document organization'
      using errcode = '23514';
  end if;

  if validate_entity and new.entity_type = 'supplier' and not exists (
    select 1 from public.suppliers s where s.id = new.entity_id and s.org_id = new.org_id
  ) then
    raise exception 'documents: supplier target must belong to the document organization'
      using errcode = '23514';
  end if;

  return new;
end
$$;

drop policy if exists documents_insert on public.documents;
create policy documents_insert on public.documents for insert to authenticated with check (
  org_id = auth_org()
  and uploaded_by = auth.uid()
  and storage_path like auth_org()::text || '/%'
  and entity_type in ('inbox', 'invoice', 'goods_receipt', 'payment', 'supplier')
  and mime_type is not null
  and public.smart_document_mime_allowed(mime_type)
  and public.p0_document_object_owned(storage_path, mime_type)
  and (
    auth_role() in ('owner', 'office', 'kitchen')
    or (
      auth_role() in ('accountant', 'payer')
      and entity_type = 'payment'
      and exists (
        select 1
        from public.payments p
        where p.org_id = documents.org_id
          and p.id = documents.entity_id
          and p.executed_by = auth.uid()
      )
    )
  )
);

update storage.buckets
set public = false,
    file_size_limit = 10485760,
    allowed_mime_types = array[
      'application/pdf',
      'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif', 'image/avif',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/rtf', 'text/rtf',
      'text/plain', 'text/html',
      'application/vnd.oasis.opendocument.text'
    ]::text[]
where id = 'documents';

drop policy if exists docs_storage_insert on storage.objects;
create policy docs_storage_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'documents'
  and (storage.foldername(name))[1] = auth_org()::text
  and (owner = auth.uid() or owner_id = auth.uid()::text)
  and public.smart_document_mime_allowed(metadata ->> 'mimetype')
  and auth_role() in ('owner', 'office', 'kitchen', 'payer', 'accountant')
);

-- ===== Extraction JSON contract =====

create or replace function public.smart_document_bbox_valid(p_bbox jsonb)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_value jsonb;
  v_values numeric[] := array[]::numeric[];
begin
  if p_bbox is null
     or jsonb_typeof(p_bbox) is distinct from 'array'
     or jsonb_array_length(p_bbox) <> 4 then
    return false;
  end if;
  for v_value in select value from jsonb_array_elements(p_bbox)
  loop
    if jsonb_typeof(v_value) <> 'number' then
      return false;
    end if;
    v_values := array_append(v_values, (v_value #>> '{}')::numeric);
  end loop;
  return v_values[1] between 0 and 1
     and v_values[2] between 0 and 1
     and v_values[3] between 0 and 1
     and v_values[4] between 0 and 1
     and v_values[3] >= v_values[1]
     and v_values[4] >= v_values[2];
exception when others then
  return false;
end
$$;

create or replace function public.smart_document_confidence_valid(p_confidence jsonb)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_value numeric;
begin
  if p_confidence is null or jsonb_typeof(p_confidence) = 'null' then
    return true;
  end if;
  if jsonb_typeof(p_confidence) <> 'number' then
    return false;
  end if;
  v_value := (p_confidence #>> '{}')::numeric;
  return v_value between 0 and 1;
exception when others then
  return false;
end
$$;

create or replace function public.smart_document_extraction_valid(
  p_payload jsonb,
  p_contract_version text
)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_document jsonb;
  v_item jsonb;
  v_row jsonb;
  v_cell jsonb;
  v_total_rows integer := 0;
begin
  if p_payload is null
     or jsonb_typeof(p_payload) is distinct from 'object'
     or not (p_payload ?& array['schema_version', 'document', 'blocks', 'tables', 'marks'])
     or p_contract_version is distinct from '1'
     or jsonb_typeof(p_payload -> 'schema_version') is distinct from 'string'
     or (p_payload ->> 'schema_version') is distinct from p_contract_version
     or jsonb_typeof(p_payload -> 'document') <> 'object'
     or jsonb_typeof(p_payload -> 'blocks') <> 'array'
     or jsonb_typeof(p_payload -> 'tables') <> 'array'
     or jsonb_typeof(p_payload -> 'marks') <> 'array'
     or pg_column_size(p_payload) > 26214400 then
    return false;
  end if;

  v_document := p_payload -> 'document';
  if not (v_document ?& array['page_count', 'detected_languages', 'plain_text', 'partial'])
     or jsonb_typeof(v_document -> 'page_count') <> 'number'
     or (v_document ->> 'page_count')::numeric < 1
     or (v_document ->> 'page_count')::numeric <> trunc((v_document ->> 'page_count')::numeric)
     or (v_document ->> 'page_count')::numeric > 100
     or jsonb_typeof(v_document -> 'detected_languages') <> 'array'
     or exists (
       select 1 from jsonb_array_elements(v_document -> 'detected_languages') language
       where jsonb_typeof(language) <> 'string'
     )
     or jsonb_typeof(v_document -> 'plain_text') <> 'string'
     or length(v_document ->> 'plain_text') > 2000000
     or jsonb_typeof(v_document -> 'partial') <> 'boolean' then
    return false;
  end if;

  for v_item in select value from jsonb_array_elements(p_payload -> 'blocks')
  loop
    if jsonb_typeof(v_item) <> 'object'
       or not (v_item ?& array['id', 'page', 'type', 'bbox', 'text', 'confidence'])
       or jsonb_typeof(v_item -> 'id') <> 'string'
       or length(v_item ->> 'id') = 0
       or jsonb_typeof(v_item -> 'page') <> 'number'
       or (v_item ->> 'page')::numeric < 1
       or (v_item ->> 'page')::numeric <> trunc((v_item ->> 'page')::numeric)
       or (v_item ->> 'page')::numeric > (v_document ->> 'page_count')::numeric
       or jsonb_typeof(v_item -> 'type') is distinct from 'string'
       or v_item ->> 'type' not in ('text', 'heading', 'table', 'image', 'handwriting')
       or not public.smart_document_bbox_valid(v_item -> 'bbox')
       or jsonb_typeof(v_item -> 'text') <> 'string'
       or not public.smart_document_confidence_valid(v_item -> 'confidence') then
      return false;
    end if;
  end loop;

  for v_item in select value from jsonb_array_elements(p_payload -> 'tables')
  loop
    if jsonb_typeof(v_item) <> 'object'
       or not (v_item ?& array['id', 'page', 'bbox', 'rows'])
       or jsonb_typeof(v_item -> 'id') <> 'string'
       or length(v_item ->> 'id') = 0
       or jsonb_typeof(v_item -> 'page') <> 'number'
       or (v_item ->> 'page')::numeric < 1
       or (v_item ->> 'page')::numeric <> trunc((v_item ->> 'page')::numeric)
       or (v_item ->> 'page')::numeric > (v_document ->> 'page_count')::numeric
       or not public.smart_document_bbox_valid(v_item -> 'bbox')
       or jsonb_typeof(v_item -> 'rows') <> 'array'
       or jsonb_array_length(v_item -> 'rows') > 5000 then
      return false;
    end if;
    v_total_rows := v_total_rows + jsonb_array_length(v_item -> 'rows');
    if v_total_rows > 5000 then
      return false;
    end if;
    for v_row in select value from jsonb_array_elements(v_item -> 'rows')
    loop
      if jsonb_typeof(v_row) <> 'array' then
        return false;
      end if;
      for v_cell in select value from jsonb_array_elements(v_row)
      loop
        if jsonb_typeof(v_cell) <> 'object'
           or not (v_cell ?& array['text', 'bbox'])
           or jsonb_typeof(v_cell -> 'text') <> 'string'
           or not (
             jsonb_typeof(v_cell -> 'bbox') = 'null'
             or public.smart_document_bbox_valid(v_cell -> 'bbox')
           ) then
          return false;
        end if;
      end loop;
    end loop;
  end loop;

  for v_item in select value from jsonb_array_elements(p_payload -> 'marks')
  loop
    if jsonb_typeof(v_item) <> 'object'
       or not (v_item ?& array[
         'id', 'page', 'kind', 'bbox', 'nearby_block_ids', 'confidence', 'fingerprint'
       ])
       or jsonb_typeof(v_item -> 'id') <> 'string'
       or length(v_item ->> 'id') = 0
       or jsonb_typeof(v_item -> 'page') <> 'number'
       or (v_item ->> 'page')::numeric < 1
       or (v_item ->> 'page')::numeric <> trunc((v_item ->> 'page')::numeric)
       or (v_item ->> 'page')::numeric > (v_document ->> 'page_count')::numeric
       or jsonb_typeof(v_item -> 'kind') is distinct from 'string'
       or v_item ->> 'kind' not in ('circle', 'check', 'cross', 'underline', 'star', 'custom', 'unknown')
       or not public.smart_document_bbox_valid(v_item -> 'bbox')
       or jsonb_typeof(v_item -> 'nearby_block_ids') <> 'array'
       or exists (
         select 1 from jsonb_array_elements(v_item -> 'nearby_block_ids') block_id
         where jsonb_typeof(block_id) <> 'string'
       )
       or not public.smart_document_confidence_valid(v_item -> 'confidence')
       or not (
         jsonb_typeof(v_item -> 'fingerprint') in ('string', 'null')
       ) then
      return false;
    end if;
  end loop;

  return true;
exception when others then
  return false;
end
$$;

revoke all on function public.smart_document_bbox_valid(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.smart_document_confidence_valid(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.smart_document_extraction_valid(jsonb, text) from public, anon, authenticated, service_role;

-- ===== Queue and immutable extraction ledger =====

create table public.document_processing_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  document_id uuid not null,
  requested_by uuid not null,
  status text not null default 'queued' check (
    status in ('queued', 'leased', 'extracted', 'interpreting', 'review', 'completed', 'failed')
  ),
  input_checksum text not null check (input_checksum ~ '^etag:[0-9a-fA-F]{16,128}(-[0-9]+)?$'),
  contract_version text not null default '1' check (contract_version = '1'),
  priority smallint not null default 100 check (priority between 0 and 1000),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  lease_owner text,
  lease_until timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint document_processing_jobs_org_id_id_key unique (org_id, id),
  constraint document_processing_jobs_document_tenant_fk
    foreign key (org_id, document_id) references public.documents(org_id, id) on delete restrict,
  constraint document_processing_jobs_requester_tenant_fk
    foreign key (org_id, requested_by) references public.profiles(org_id, id) on delete restrict,
  constraint document_processing_jobs_lease_shape check (
    (status = 'leased' and lease_owner is not null and lease_until is not null)
    or (status <> 'leased' and lease_owner is null and lease_until is null)
  ),
  constraint document_processing_jobs_error_shape check (
    (status = 'failed' and last_error_code is not null)
    or (status <> 'failed' and last_error_code is null and last_error_message is null)
  )
);

create unique index document_processing_jobs_active_key
  on public.document_processing_jobs (org_id, document_id, input_checksum, contract_version)
  where status in ('queued', 'leased', 'extracted', 'interpreting', 'review');
create index document_processing_jobs_claim_idx
  on public.document_processing_jobs (priority desc, created_at, id)
  where status in ('queued', 'leased');
create index document_processing_jobs_document_idx
  on public.document_processing_jobs (org_id, document_id, created_at desc);

create table public.document_extractions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  job_id uuid not null,
  document_id uuid not null,
  engine text not null check (length(trim(engine)) between 1 and 100),
  model text not null check (length(trim(model)) between 1 and 200),
  model_version text not null check (length(trim(model_version)) between 1 and 200),
  input_checksum text not null check (input_checksum ~ '^etag:[0-9a-fA-F]{16,128}(-[0-9]+)?$'),
  contract_version text not null check (contract_version = '1'),
  payload jsonb not null,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  resource_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(resource_metadata) = 'object'),
  created_at timestamptz not null default now(),
  constraint document_extractions_org_id_id_key unique (org_id, id),
  constraint document_extractions_job_key unique (org_id, job_id),
  constraint document_extractions_job_tenant_fk
    foreign key (org_id, job_id) references public.document_processing_jobs(org_id, id) on delete restrict,
  constraint document_extractions_document_tenant_fk
    foreign key (org_id, document_id) references public.documents(org_id, id) on delete restrict,
  constraint document_extractions_payload_check
    check (public.smart_document_extraction_valid(payload, contract_version))
);

create index document_extractions_document_idx
  on public.document_extractions (org_id, document_id, created_at desc);

create or replace function public.guard_document_processing_job()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.org_id is distinct from old.org_id
     or new.document_id is distinct from old.document_id
     or new.requested_by is distinct from old.requested_by
     or new.input_checksum is distinct from old.input_checksum
     or new.contract_version is distinct from old.contract_version
     or new.priority is distinct from old.priority
     or new.created_at is distinct from old.created_at
     or new.attempt_count < old.attempt_count then
    raise exception 'document_processing_job_identity_immutable' using errcode = '42501';
  end if;

  if old.status = 'queued' and new.status not in ('queued', 'leased') then
    raise exception 'document_processing_transition_invalid' using errcode = '23514';
  elsif old.status = 'leased' and new.status not in ('leased', 'extracted', 'failed') then
    raise exception 'document_processing_transition_invalid' using errcode = '23514';
  elsif old.status = 'extracted' and new.status not in ('extracted', 'interpreting', 'failed') then
    raise exception 'document_processing_transition_invalid' using errcode = '23514';
  elsif old.status = 'interpreting' and new.status not in ('interpreting', 'review', 'failed') then
    raise exception 'document_processing_transition_invalid' using errcode = '23514';
  elsif old.status = 'review' and new.status not in ('review', 'completed', 'failed') then
    raise exception 'document_processing_transition_invalid' using errcode = '23514';
  elsif old.status in ('completed', 'failed') and new.status <> old.status then
    raise exception 'document_processing_terminal_state' using errcode = '23514';
  end if;

  new.updated_at := now();
  return new;
end
$$;

create trigger document_processing_jobs_guard_trg
  before update on public.document_processing_jobs
  for each row execute function public.guard_document_processing_job();

create or replace function public.reject_document_extraction_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'document_extraction_immutable' using errcode = '42501';
end
$$;

create trigger document_extractions_immutable_trg
  before update or delete on public.document_extractions
  for each row execute function public.reject_document_extraction_mutation();

revoke all on function public.guard_document_processing_job()
  from public, anon, authenticated, service_role;
revoke all on function public.reject_document_extraction_mutation()
  from public, anon, authenticated, service_role;

alter table public.document_processing_jobs enable row level security;
alter table public.document_processing_jobs force row level security;
alter table public.document_extractions enable row level security;
alter table public.document_extractions force row level security;

create policy document_processing_jobs_select on public.document_processing_jobs
  for select to authenticated using (
    org_id = auth_org() and auth_role() in ('owner', 'office', 'kitchen')
  );
create policy document_extractions_select on public.document_extractions
  for select to authenticated using (
    org_id = auth_org() and auth_role() in ('owner', 'office', 'kitchen')
  );

revoke all on table public.document_processing_jobs from public, anon, authenticated, service_role;
revoke all on table public.document_extractions from public, anon, authenticated, service_role;
grant select on table public.document_processing_jobs, public.document_extractions to authenticated;
grant select, insert, update, delete
  on table public.document_processing_jobs, public.document_extractions
  to service_role;

-- ===== Authenticated and worker RPCs =====

create or replace function public.smart_document_source_checksum(
  p_org_id uuid,
  p_storage_path text,
  p_mime_type text,
  p_uploaded_by uuid
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_etag text;
begin
  select lower(btrim(o.metadata ->> 'eTag', '"'))
    into v_etag
  from storage.objects o
  where o.bucket_id = 'documents'
    and o.name = p_storage_path
    and (storage.foldername(o.name))[1] = p_org_id::text
    and lower(coalesce(o.metadata ->> 'mimetype', '')) = lower(p_mime_type)
    and (o.owner = p_uploaded_by or o.owner_id = p_uploaded_by::text);

  if v_etag is null or v_etag !~ '^[0-9a-f]{16,128}(-[0-9]+)?$' then
    raise exception 'document_source_checksum_unavailable' using errcode = '22023';
  end if;
  return 'etag:' || v_etag;
end
$$;

revoke all on function public.smart_document_source_checksum(uuid, text, text, uuid)
  from public, anon, authenticated, service_role;

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
  if v_org is null or v_user is null or v_role not in ('owner', 'office', 'kitchen') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select * into v_document
  from public.documents
  where id = p_document_id and org_id = v_org and deleted_at is null;
  if not found then
    raise exception 'document_unknown' using errcode = 'P0002';
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
      and j.status in ('queued', 'leased', 'extracted', 'interpreting', 'review')
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

create or replace function public.claim_document_processing_job(
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
  v_seconds integer := least(greatest(coalesce(p_lease_seconds, 120), 30), 900);
  v_job public.document_processing_jobs;
  v_document public.documents;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_owner is null or length(v_owner) > 200 then
    raise exception 'lease_owner_invalid' using errcode = '22023';
  end if;

  loop
    with candidate as (
      select j.id
      from public.document_processing_jobs j
      join public.organizations o
        on o.id = j.org_id and o.status in ('trial', 'active')
      where j.status = 'queued'
         or (j.status = 'leased' and j.lease_until <= now())
      order by j.priority desc, j.created_at, j.id
      for update of j skip locked
      limit 1
    )
    update public.document_processing_jobs j
    set status = 'leased',
        lease_owner = v_owner,
        lease_until = now() + make_interval(secs => v_seconds),
        attempt_count = j.attempt_count + 1,
        last_error_code = null,
        last_error_message = null
    from candidate
    where j.id = candidate.id
    returning j.* into v_job;

    if not found then
      return null;
    end if;

    select * into v_document
    from public.documents
    where id = v_job.document_id and org_id = v_job.org_id;

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
        v_job.org_id, null, 'document_processing_failed', 'document_processing_jobs', v_job.id,
        jsonb_build_object('error_code', 'document_deleted'),
        'source document deleted before processing'
      );
      continue;
    end if;

    exit;
  end loop;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_job.org_id, null, 'document_processing_claimed', 'document_processing_jobs', v_job.id,
    jsonb_build_object('lease_owner', v_owner, 'attempt_count', v_job.attempt_count),
    'private OCR worker lease'
  );

  return jsonb_build_object(
    'job_id', v_job.id,
    'org_id', v_job.org_id,
    'document_id', v_job.document_id,
    'storage_path', v_document.storage_path,
    'mime_type', v_document.mime_type,
    'file_name', v_document.file_name,
    'input_checksum', v_job.input_checksum,
    'contract_version', v_job.contract_version,
    'lease_until', v_job.lease_until,
    'attempt_count', v_job.attempt_count
  );
end
$$;

create or replace function public.heartbeat_document_processing_job(
  p_job_id uuid,
  p_lease_owner text,
  p_lease_seconds integer default 120
)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lease_until timestamptz;
  v_owner text := nullif(trim(p_lease_owner), '');
  v_seconds integer := least(greatest(coalesce(p_lease_seconds, 120), 30), 900);
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_owner is null or length(v_owner) > 200 then
    raise exception 'lease_owner_invalid' using errcode = '22023';
  end if;
  update public.document_processing_jobs
  set lease_until = now() + make_interval(secs => v_seconds)
  where id = p_job_id
    and status = 'leased'
    and lease_owner is not distinct from v_owner
    and lease_until > now()
    and exists (
      select 1 from public.organizations o
      where o.id = document_processing_jobs.org_id
        and o.status in ('trial', 'active')
    )
  returning lease_until into v_lease_until;
  if v_lease_until is null then
    raise exception 'document_processing_lease_lost' using errcode = '55000';
  end if;
  return v_lease_until;
end
$$;

create or replace function public.complete_document_processing_job(
  p_job_id uuid,
  p_lease_owner text,
  p_engine text,
  p_model text,
  p_model_version text,
  p_input_checksum text,
  p_contract_version text,
  p_payload jsonb,
  p_duration_ms integer default null,
  p_resource_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.document_processing_jobs;
  v_document public.documents;
  v_current_checksum text;
  v_extraction_id uuid;
  v_owner text := nullif(trim(p_lease_owner), '');
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_owner is null or length(v_owner) > 200 then
    raise exception 'lease_owner_invalid' using errcode = '22023';
  end if;

  select e.id into v_extraction_id
  from public.document_extractions e
  where e.job_id = p_job_id
    and e.input_checksum = p_input_checksum
    and e.contract_version = p_contract_version;
  if v_extraction_id is not null then
    return v_extraction_id;
  end if;

  select * into v_job
  from public.document_processing_jobs
  where id = p_job_id
  for update;
  if not found then
    raise exception 'document_processing_job_unknown' using errcode = 'P0002';
  end if;
  if v_job.status <> 'leased'
     or v_job.lease_owner is distinct from v_owner
     or v_job.lease_until <= now() then
    raise exception 'document_processing_lease_lost' using errcode = '55000';
  end if;

  perform 1
  from public.organizations o
  where o.id = v_job.org_id and o.status in ('trial', 'active')
  for share;
  if not found then
    raise exception 'org_suspended' using errcode = 'P0002';
  end if;
  if p_input_checksum is distinct from v_job.input_checksum
     or p_contract_version is distinct from v_job.contract_version then
    raise exception 'document_processing_source_changed' using errcode = '22023';
  end if;

  select * into v_document
  from public.documents
  where id = v_job.document_id and org_id = v_job.org_id and deleted_at is null;
  if not found then
    raise exception 'document_unknown' using errcode = 'P0002';
  end if;
  v_current_checksum := public.smart_document_source_checksum(
    v_document.org_id, v_document.storage_path, v_document.mime_type, v_document.uploaded_by
  );
  if v_current_checksum <> v_job.input_checksum then
    raise exception 'document_processing_source_changed' using errcode = '22023';
  end if;

  if not public.smart_document_extraction_valid(p_payload, p_contract_version) then
    raise exception 'document_extraction_invalid' using errcode = '22023';
  end if;

  insert into public.document_extractions (
    org_id, job_id, document_id, engine, model, model_version,
    input_checksum, contract_version, payload, duration_ms, resource_metadata
  ) values (
    v_job.org_id, v_job.id, v_job.document_id,
    trim(p_engine), trim(p_model), trim(p_model_version),
    p_input_checksum, p_contract_version, p_payload, p_duration_ms,
    coalesce(p_resource_metadata, '{}'::jsonb)
  ) returning id into v_extraction_id;

  update public.document_processing_jobs
  set status = 'extracted', lease_owner = null, lease_until = null
  where id = v_job.id;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_job.org_id, null, 'document_processing_extracted', 'document_processing_jobs', v_job.id,
    jsonb_build_object('extraction_id', v_extraction_id, 'engine', trim(p_engine), 'model', trim(p_model)),
    'private OCR worker completed extraction'
  );
  return v_extraction_id;
end
$$;

create or replace function public.fail_document_processing_job(
  p_job_id uuid,
  p_lease_owner text,
  p_error_code text,
  p_error_message text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.document_processing_jobs;
  v_owner text := nullif(trim(p_lease_owner), '');
  v_error_code text := nullif(trim(p_error_code), '');
  v_error_message text := nullif(left(trim(coalesce(p_error_message, '')), 1000), '');
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_owner is null or length(v_owner) > 200 then
    raise exception 'lease_owner_invalid' using errcode = '22023';
  end if;
  if v_error_code is null or length(v_error_code) > 100 then
    raise exception 'document_processing_error_code_invalid' using errcode = '22023';
  end if;

  select * into v_job
  from public.document_processing_jobs
  where id = p_job_id
  for update;
  if not found then
    raise exception 'document_processing_job_unknown' using errcode = 'P0002';
  end if;
  if v_job.status = 'failed' and v_job.last_error_code = v_error_code then
    return v_job.id;
  end if;
  if v_job.status <> 'leased'
     or v_job.lease_owner is distinct from v_owner
     or v_job.lease_until <= now() then
    raise exception 'document_processing_lease_lost' using errcode = '55000';
  end if;

  update public.document_processing_jobs
  set status = 'failed',
      lease_owner = null,
      lease_until = null,
      last_error_code = v_error_code,
      last_error_message = v_error_message
  where id = v_job.id;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_job.org_id, null, 'document_processing_failed', 'document_processing_jobs', v_job.id,
    jsonb_build_object('error_code', v_error_code),
    coalesce(v_error_message, v_error_code)
  );
  return v_job.id;
end
$$;

revoke all on function public.enqueue_document_processing(uuid) from public, anon, service_role;
grant execute on function public.enqueue_document_processing(uuid) to authenticated;
revoke all on function public.reprocess_document(uuid, text) from public, anon, service_role;
grant execute on function public.reprocess_document(uuid, text) to authenticated;

revoke all on function public.claim_document_processing_job(text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_document_processing_job(text, integer) to service_role;
revoke all on function public.heartbeat_document_processing_job(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.heartbeat_document_processing_job(uuid, text, integer) to service_role;
revoke all on function public.complete_document_processing_job(
  uuid, text, text, text, text, text, text, jsonb, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.complete_document_processing_job(
  uuid, text, text, text, text, text, text, jsonb, integer, jsonb
) to service_role;
revoke all on function public.fail_document_processing_job(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.fail_document_processing_job(uuid, text, text, text) to service_role;

comment on table public.document_processing_jobs is
  'Tenant-scoped queue state for immutable source documents. Source identity is the Storage-managed eTag.';
comment on table public.document_extractions is
  'Immutable validated ExtractionContract payloads; OCR output is evidence for review, never business truth.';
