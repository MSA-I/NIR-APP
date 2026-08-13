-- 0136 — Human-approved document image preprocessing before OCR.
-- 0134-0135 are reserved by the concurrent document-control campaign.

create or replace function public.document_scan_image_mime(p_mime_type text)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select lower(coalesce(p_mime_type, '')) = any(array[
    'image/jpeg', 'image/png', 'image/webp', 'image/heic',
    'image/heif', 'image/gif', 'image/avif'
  ]::text[]);
$$;

create or replace function public.document_scan_corners_valid(p_corners jsonb)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  v_point jsonb;
  v_x1 numeric;
  v_y1 numeric;
  v_x2 numeric;
  v_y2 numeric;
  v_x3 numeric;
  v_y3 numeric;
  v_x4 numeric;
  v_y4 numeric;
  v_area numeric;
  v_cross1 numeric;
  v_cross2 numeric;
  v_cross3 numeric;
  v_cross4 numeric;
begin
  if jsonb_typeof(p_corners) <> 'array' or jsonb_array_length(p_corners) <> 4 then
    return false;
  end if;
  for v_point in select value from jsonb_array_elements(p_corners) loop
    if jsonb_typeof(v_point) <> 'array' or jsonb_array_length(v_point) <> 2
       or jsonb_typeof(v_point -> 0) <> 'number'
       or jsonb_typeof(v_point -> 1) <> 'number'
       or (v_point ->> 0)::numeric not between 0 and 1
       or (v_point ->> 1)::numeric not between 0 and 1 then
      return false;
    end if;
  end loop;
  v_x1 := (p_corners -> 0 ->> 0)::numeric;
  v_y1 := (p_corners -> 0 ->> 1)::numeric;
  v_x2 := (p_corners -> 1 ->> 0)::numeric;
  v_y2 := (p_corners -> 1 ->> 1)::numeric;
  v_x3 := (p_corners -> 2 ->> 0)::numeric;
  v_y3 := (p_corners -> 2 ->> 1)::numeric;
  v_x4 := (p_corners -> 3 ->> 0)::numeric;
  v_y4 := (p_corners -> 3 ->> 1)::numeric;
  v_area := abs(
    v_x1 * v_y2 + v_x2 * v_y3 + v_x3 * v_y4 + v_x4 * v_y1
    - v_y1 * v_x2 - v_y2 * v_x3 - v_y3 * v_x4 - v_y4 * v_x1
  ) / 2;
  v_cross1 := (v_x2 - v_x1) * (v_y3 - v_y2) - (v_y2 - v_y1) * (v_x3 - v_x2);
  v_cross2 := (v_x3 - v_x2) * (v_y4 - v_y3) - (v_y3 - v_y2) * (v_x4 - v_x3);
  v_cross3 := (v_x4 - v_x3) * (v_y1 - v_y4) - (v_y4 - v_y3) * (v_x1 - v_x4);
  v_cross4 := (v_x1 - v_x4) * (v_y2 - v_y1) - (v_y1 - v_y4) * (v_x2 - v_x1);
  return v_area >= 0.08 and (
    (v_cross1 > 0 and v_cross2 > 0 and v_cross3 > 0 and v_cross4 > 0)
    or (v_cross1 < 0 and v_cross2 < 0 and v_cross3 < 0 and v_cross4 < 0)
  );
exception when others then
  return false;
end;
$$;

revoke all on function public.document_scan_image_mime(text)
  from public, anon, authenticated, service_role;
revoke all on function public.document_scan_corners_valid(jsonb)
  from public, anon, authenticated, service_role;

alter table public.document_processing_jobs
  drop constraint document_processing_jobs_status_check;
alter table public.document_processing_jobs
  add constraint document_processing_jobs_status_check check (
    status in (
      'awaiting_scan', 'queued', 'leased', 'extracted',
      'interpreting', 'review', 'completed', 'failed'
    )
  );

drop index public.document_processing_jobs_active_key;
create unique index document_processing_jobs_active_key
  on public.document_processing_jobs (org_id, document_id, input_checksum, contract_version)
  where status in ('awaiting_scan', 'queued', 'leased', 'extracted', 'interpreting');

create table public.document_scan_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  document_id uuid not null,
  processing_job_id uuid not null,
  requested_by uuid not null,
  status text not null default 'queued' check (
    status in ('queued', 'processing', 'needs_corners', 'ready', 'accepted', 'failed')
  ),
  input_checksum text not null check (
    input_checksum ~ '^etag:[0-9a-fA-F]{16,128}(-[0-9]+)?$'
  ),
  requested_mode text not null default 'auto' check (
    requested_mode in ('auto', 'grayscale', 'black_and_white')
  ),
  manual_corners jsonb check (
    manual_corners is null or public.document_scan_corners_valid(manual_corners)
  ),
  priority smallint not null default 100 check (priority between 0 and 1000),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  lease_owner text,
  lease_until timestamptz,
  processing_attempt_id uuid,
  processing_attempt_started_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint document_scan_jobs_org_id_id_key unique (org_id, id),
  constraint document_scan_jobs_processing_key unique (org_id, processing_job_id),
  constraint document_scan_jobs_document_tenant_fk
    foreign key (org_id, document_id)
    references public.documents(org_id, id) on delete restrict,
  constraint document_scan_jobs_processing_tenant_fk
    foreign key (org_id, processing_job_id)
    references public.document_processing_jobs(org_id, id) on delete restrict,
  constraint document_scan_jobs_requester_tenant_fk
    foreign key (org_id, requested_by)
    references public.profiles(org_id, id) on delete restrict,
  constraint document_scan_jobs_lease_shape check (
    (status = 'processing' and lease_owner is not null and lease_until is not null)
    or (status <> 'processing' and lease_owner is null and lease_until is null)
  ),
  constraint document_scan_jobs_attempt_shape check (
    (processing_attempt_id is null and processing_attempt_started_at is null)
    or (processing_attempt_id is not null and processing_attempt_started_at is not null)
  ),
  constraint document_scan_jobs_error_shape check (
    (status in ('needs_corners', 'failed') and last_error_code is not null)
    or (status not in ('needs_corners', 'failed')
      and last_error_code is null and last_error_message is null)
  )
);

create index document_scan_jobs_claim_idx
  on public.document_scan_jobs (priority desc, created_at, id)
  where status in ('queued', 'processing');
create index document_scan_jobs_document_idx
  on public.document_scan_jobs (org_id, document_id, created_at desc);

create table public.document_scan_outputs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  scan_job_id uuid not null,
  document_id uuid not null,
  storage_path text not null,
  mime_type text not null default 'image/png' check (mime_type = 'image/png'),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint not null check (byte_size between 1 and 10485760),
  width integer not null check (width between 64 and 4096),
  height integer not null check (height between 64 and 4096),
  output_mode text not null check (output_mode in ('grayscale', 'black_and_white')),
  corners jsonb not null check (public.document_scan_corners_valid(corners)),
  corners_source text not null check (corners_source in ('automatic', 'manual')),
  rotation_degrees numeric(7,4) not null check (rotation_degrees between -7 and 7),
  metrics jsonb not null default '{}'::jsonb check (jsonb_typeof(metrics) = 'object'),
  created_at timestamptz not null default now(),
  constraint document_scan_outputs_org_id_id_key unique (org_id, id),
  constraint document_scan_outputs_job_key unique (org_id, scan_job_id),
  constraint document_scan_outputs_storage_key unique (org_id, storage_path),
  constraint document_scan_outputs_job_tenant_fk
    foreign key (org_id, scan_job_id)
    references public.document_scan_jobs(org_id, id) on delete restrict,
  constraint document_scan_outputs_document_tenant_fk
    foreign key (org_id, document_id)
    references public.documents(org_id, id) on delete restrict,
  constraint document_scan_outputs_path_check check (
    storage_path like org_id::text || '/' || document_id::text || '/' || scan_job_id::text || '/%'
  )
);

alter table public.document_processing_jobs
  add column scan_output_id uuid,
  add constraint document_processing_jobs_scan_output_tenant_fk
    foreign key (org_id, scan_output_id)
    references public.document_scan_outputs(org_id, id) on delete restrict;

create table public.document_scan_decisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  scan_job_id uuid not null,
  scan_output_id uuid not null,
  processing_job_id uuid not null,
  decided_by uuid not null,
  decision text not null check (decision = 'accepted'),
  reason text not null default 'enhanced scan approved for OCR'
    check (length(trim(reason)) between 3 and 500),
  created_at timestamptz not null default now(),
  constraint document_scan_decisions_org_id_id_key unique (org_id, id),
  constraint document_scan_decisions_job_key unique (org_id, scan_job_id),
  constraint document_scan_decisions_output_key unique (org_id, scan_output_id),
  constraint document_scan_decisions_job_tenant_fk
    foreign key (org_id, scan_job_id)
    references public.document_scan_jobs(org_id, id) on delete restrict,
  constraint document_scan_decisions_output_tenant_fk
    foreign key (org_id, scan_output_id)
    references public.document_scan_outputs(org_id, id) on delete restrict,
  constraint document_scan_decisions_processing_tenant_fk
    foreign key (org_id, processing_job_id)
    references public.document_processing_jobs(org_id, id) on delete restrict,
  constraint document_scan_decisions_actor_tenant_fk
    foreign key (org_id, decided_by)
    references public.profiles(org_id, id) on delete restrict
);

create or replace function public.guard_document_scan_job()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_manual_retry boolean := coalesce(
    current_setting('app.document_scan_manual_retry', true) = old.id::text, false
  );
  v_claim_write boolean := coalesce(
    auth.role() = 'service_role'
    and current_setting('app.document_scan_claim_job', true) = old.id::text, false
  );
begin
  if new.org_id is distinct from old.org_id
     or new.document_id is distinct from old.document_id
     or new.processing_job_id is distinct from old.processing_job_id
     or new.requested_by is distinct from old.requested_by
     or new.input_checksum is distinct from old.input_checksum
     or new.requested_mode is distinct from old.requested_mode
     or new.priority is distinct from old.priority
     or new.created_at is distinct from old.created_at
     or new.attempt_count < old.attempt_count then
    raise exception 'document_scan_job_identity_immutable' using errcode = '42501';
  end if;
  if new.processing_attempt_id is distinct from old.processing_attempt_id
     or new.processing_attempt_started_at is distinct from old.processing_attempt_started_at then
    if not v_claim_write
       or new.status <> 'processing'
       or new.processing_attempt_id is null
       or new.processing_attempt_started_at is null
       or new.attempt_count <> old.attempt_count + 1 then
      raise exception 'document_scan_attempt_immutable' using errcode = '42501';
    end if;
  end if;
  if new.manual_corners is distinct from old.manual_corners
     and not (
       old.status = 'needs_corners' and new.status = 'queued'
       and v_manual_retry and new.manual_corners is not null
     ) then
    raise exception 'document_scan_corners_rpc_required' using errcode = '42501';
  end if;
  if old.status = 'queued' and new.status not in ('queued', 'processing', 'failed') then
    raise exception 'document_scan_transition_invalid' using errcode = '23514';
  elsif old.status = 'processing'
        and new.status not in ('processing', 'queued', 'needs_corners', 'ready', 'failed') then
    raise exception 'document_scan_transition_invalid' using errcode = '23514';
  elsif old.status = 'needs_corners' and new.status not in ('needs_corners', 'queued') then
    raise exception 'document_scan_transition_invalid' using errcode = '23514';
  elsif old.status = 'ready' and new.status not in ('ready', 'accepted') then
    raise exception 'document_scan_transition_invalid' using errcode = '23514';
  elsif old.status in ('accepted', 'failed') and new.status <> old.status then
    raise exception 'document_scan_terminal_state' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end
$$;

create or replace function public.guard_document_processing_scan_binding()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.scan_output_id is distinct from old.scan_output_id then
    raise exception 'document_processing_scan_binding_immutable' using errcode = '42501';
  end if;
  if old.status = 'awaiting_scan'
     and new.status not in ('awaiting_scan', 'failed') then
    raise exception 'document_processing_scan_transition_invalid' using errcode = '23514';
  end if;
  return new;
end
$$;

create or replace function public.reject_document_scan_evidence_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'document_scan_evidence_immutable' using errcode = '42501';
end
$$;

create trigger document_scan_jobs_guard_trg
  before update on public.document_scan_jobs
  for each row execute function public.guard_document_scan_job();
create trigger document_processing_scan_binding_guard_trg
  before update on public.document_processing_jobs
  for each row execute function public.guard_document_processing_scan_binding();
create trigger document_scan_outputs_immutable_trg
  before update or delete on public.document_scan_outputs
  for each row execute function public.reject_document_scan_evidence_mutation();
create trigger document_scan_decisions_immutable_trg
  before update or delete on public.document_scan_decisions
  for each row execute function public.reject_document_scan_evidence_mutation();

revoke all on function public.guard_document_scan_job()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_document_processing_scan_binding()
  from public, anon, authenticated, service_role;
revoke all on function public.reject_document_scan_evidence_mutation()
  from public, anon, authenticated, service_role;

alter table public.document_scan_jobs enable row level security;
alter table public.document_scan_jobs force row level security;
alter table public.document_scan_outputs enable row level security;
alter table public.document_scan_outputs force row level security;
alter table public.document_scan_decisions enable row level security;
alter table public.document_scan_decisions force row level security;

create policy document_scan_jobs_select on public.document_scan_jobs
  for select to authenticated using (
    org_id = auth_org() and auth_role() in ('owner', 'office')
    and exists (
      select 1 from public.documents document
      where document.org_id = document_scan_jobs.org_id
        and document.id = document_scan_jobs.document_id
        and document.deleted_at is null
        and (document.unit_id is null or document.unit_id = any(public.auth_scopes()))
    )
  );
create policy document_scan_outputs_select on public.document_scan_outputs
  for select to authenticated using (
    org_id = auth_org() and auth_role() in ('owner', 'office')
    and exists (
      select 1 from public.documents document
      where document.org_id = document_scan_outputs.org_id
        and document.id = document_scan_outputs.document_id
        and document.deleted_at is null
        and (document.unit_id is null or document.unit_id = any(public.auth_scopes()))
    )
  );
create policy document_scan_decisions_select on public.document_scan_decisions
  for select to authenticated using (
    org_id = auth_org() and auth_role() in ('owner', 'office')
    and exists (
      select 1
      from public.document_scan_outputs output
      join public.documents document
        on document.org_id = output.org_id and document.id = output.document_id
      where output.org_id = document_scan_decisions.org_id
        and output.id = document_scan_decisions.scan_output_id
        and document.deleted_at is null
        and (document.unit_id is null or document.unit_id = any(public.auth_scopes()))
    )
  );

revoke all on table public.document_scan_jobs, public.document_scan_outputs,
  public.document_scan_decisions from public, anon, authenticated, service_role;
grant select on table public.document_scan_jobs, public.document_scan_outputs,
  public.document_scan_decisions to authenticated;
grant select, insert, update, delete on table public.document_scan_jobs,
  public.document_scan_outputs, public.document_scan_decisions to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('document-scans', 'document-scans', false, 10485760, array['image/png'])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy document_scans_staff_read on storage.objects
  for select to authenticated using (
    bucket_id = 'document-scans'
    and (storage.foldername(name))[1] = auth_org()::text
    and auth_role() in ('owner', 'office')
  );

-- One source-of-truth fence for both original documents and accepted scan derivatives. OCR
-- completion and owner recovery must compare against the input actually claimed, not silently
-- fall back to the original object after a human accepted a different immutable source.
create or replace function private.document_processing_current_checksum(
  p_job public.document_processing_jobs
) returns text
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_document public.documents;
  v_output public.document_scan_outputs;
begin
  if p_job.id is null or p_job.org_id is null or p_job.document_id is null then
    raise exception 'document_processing_source_invalid' using errcode = '22023';
  end if;
  if p_job.scan_output_id is not null then
    -- Acceptance belongs to the immutable output. Reprocess and stuck-recovery jobs may reuse
    -- that approved source while keeping a new processing attempt and evidence chain.
    select output.* into v_output
    from public.document_scan_outputs output
    join public.document_scan_decisions decision
      on decision.org_id = output.org_id
      and decision.scan_output_id = output.id
      and decision.decision = 'accepted'
    where output.org_id = p_job.org_id
      and output.id = p_job.scan_output_id
      and output.document_id = p_job.document_id;
    if not found then
      raise exception 'document_processing_scan_evidence_invalid' using errcode = '42501';
    end if;
    return 'etag:' || v_output.sha256;
  end if;
  select * into v_document
  from public.documents document
  where document.org_id = p_job.org_id
    and document.id = p_job.document_id
    and document.deleted_at is null;
  if not found then raise exception 'document_unknown' using errcode = 'P0002'; end if;
  return public.smart_document_source_checksum(
    v_document.org_id, v_document.storage_path, v_document.mime_type, v_document.uploaded_by
  );
end
$$;

revoke all on function private.document_processing_current_checksum(
  public.document_processing_jobs
) from public, anon, authenticated, service_role;

-- Existing callers keep one UUID result. Images receive an inert awaiting_scan job; OCR cannot
-- claim it. The accepted scan creates a separate queued OCR job bound to immutable scan evidence.
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
  v_output public.document_scan_outputs;
  v_checksum text;
  v_job_id uuid;
  v_status text;
  v_requires_scan boolean;
begin
  if v_org is null or v_user is null
     or v_role not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_document
  from public.documents document
  where document.id = p_document_id and document.org_id = v_org
    and document.deleted_at is null
    and (document.unit_id is null or document.unit_id = any(public.auth_scopes()));
  if not found then
    raise exception 'document_unknown' using errcode = 'P0002';
  end if;
  -- The trusted supplier price-list bridge owns a separate reservation and immutable intake
  -- contract. Keep that route unchanged even when its source happens to be an image.
  v_requires_scan := public.document_scan_image_mime(v_document.mime_type)
    and not (
      v_document.entity_type = 'supplier'
      and v_document.document_kind = 'price_list'
    );

  if v_requires_scan then
    select output.* into v_output
    from public.document_scan_outputs output
    join public.document_scan_decisions decision
      on decision.org_id = output.org_id and decision.scan_output_id = output.id
    where output.org_id = v_org and output.document_id = v_document.id
      and decision.decision = 'accepted'
    order by decision.created_at desc
    limit 1;
  end if;

  if v_output.id is not null then
    v_checksum := 'etag:' || v_output.sha256;
    v_status := 'queued';
  else
    v_checksum := public.smart_document_source_checksum(
      v_document.org_id, v_document.storage_path, v_document.mime_type, v_document.uploaded_by
    );
    v_status := case when v_requires_scan then 'awaiting_scan' else 'queued' end;
  end if;

  select job.id into v_job_id
  from public.document_processing_jobs job
  where job.org_id = v_org and job.document_id = v_document.id
    and job.input_checksum = v_checksum and job.contract_version = '1'
    and job.status <> 'failed'
  order by job.created_at desc
  limit 1;
  if v_job_id is not null then return v_job_id; end if;

  begin
    insert into public.document_processing_jobs (
      org_id, document_id, requested_by, status, input_checksum,
      contract_version, scan_output_id
    ) values (
      v_org, v_document.id, v_user, v_status, v_checksum,
      '1', v_output.id
    ) returning id into v_job_id;
  exception when unique_violation then
    select job.id into v_job_id
    from public.document_processing_jobs job
    where job.org_id = v_org and job.document_id = v_document.id
      and job.input_checksum = v_checksum and job.contract_version = '1'
      and job.status in ('awaiting_scan', 'queued', 'leased', 'extracted', 'interpreting')
    order by job.created_at desc limit 1;
  end;
  if v_job_id is null then
    raise exception 'document_processing_enqueue_conflict' using errcode = '40001';
  end if;

  if v_status = 'awaiting_scan' then
    insert into public.document_scan_jobs (
      org_id, document_id, processing_job_id, requested_by, input_checksum
    ) values (
      v_org, v_document.id, v_job_id, v_user, v_checksum
    ) on conflict (org_id, processing_job_id) do nothing;
  end if;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_org, v_user,
    case when v_status = 'awaiting_scan'
      then 'document_scan_enqueued' else 'document_processing_enqueued' end,
    'document_processing_jobs', v_job_id,
    jsonb_build_object(
      'document_id', v_document.id,
      'contract_version', '1',
      'scan_output_id', v_output.id
    ),
    case when v_status = 'awaiting_scan'
      then 'document image queued for scan preview'
      else 'document queued for extraction' end
  );
  return v_job_id;
end
$$;

create or replace function public.begin_document_intake(p_document_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_document public.documents;
  v_job_id uuid;
  v_scan_job_id uuid;
begin
  if v_org is null or v_actor is null or auth_role() not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_document from public.documents document
  where document.org_id = v_org and document.id = p_document_id
    and document.deleted_at is null
    and (document.unit_id is null or document.unit_id = any(public.auth_scopes()));
  if not found then raise exception 'document_unknown' using errcode = 'P0002'; end if;

  v_job_id := public.enqueue_document_processing(v_document.id);
  select scan.id into v_scan_job_id
  from public.document_scan_jobs scan
  where scan.org_id = v_org and scan.processing_job_id = v_job_id;
  return jsonb_build_object(
    'document_id', v_document.id,
    'intake_kind', case when v_scan_job_id is null then 'processing' else 'scan' end,
    'intake_job_id', coalesce(v_scan_job_id, v_job_id),
    'processing_job_id', v_job_id,
    'requires_scan_review', v_scan_job_id is not null
  );
end
$$;

create or replace function public.get_document_scan_states(p_document_ids uuid[] default null)
returns table (
  document_id uuid,
  scan_job_id uuid,
  processing_job_id uuid,
  status text,
  requested_mode text,
  manual_corners jsonb,
  last_error_code text,
  last_error_message text,
  output_id uuid,
  output_storage_path text,
  output_mode text,
  detected_corners jsonb,
  corners_source text,
  rotation_degrees numeric,
  accepted boolean,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select scan.document_id, scan.id,
         coalesce(decision.processing_job_id, scan.processing_job_id), scan.status,
         scan.requested_mode, scan.manual_corners,
         scan.last_error_code, scan.last_error_message,
         output.id, output.storage_path, output.output_mode, output.corners,
         output.corners_source, output.rotation_degrees,
         decision.id is not null, scan.updated_at
  from public.document_scan_jobs scan
  join public.documents document
    on document.org_id = scan.org_id and document.id = scan.document_id
  left join public.document_scan_outputs output
    on output.org_id = scan.org_id and output.scan_job_id = scan.id
  left join public.document_scan_decisions decision
    on decision.org_id = output.org_id and decision.scan_output_id = output.id
  where scan.org_id = auth_org()
    and auth_role() in ('owner', 'office')
    and document.deleted_at is null
    and (document.unit_id is null or document.unit_id = any(public.auth_scopes()))
    and (p_document_ids is null or scan.document_id = any(p_document_ids))
  order by scan.document_id, scan.created_at desc;
$$;

create or replace function public.submit_document_scan_corners(
  p_scan_job_id uuid,
  p_corners jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_job public.document_scan_jobs;
begin
  if v_org is null or v_actor is null or auth_role() not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if not public.document_scan_corners_valid(p_corners) then
    raise exception 'invalid_scan_corners' using errcode = '22023';
  end if;
  select scan.* into v_job
  from public.document_scan_jobs scan
  join public.documents document
    on document.org_id = scan.org_id and document.id = scan.document_id
  where scan.org_id = v_org and scan.id = p_scan_job_id
    and scan.status = 'needs_corners' and document.deleted_at is null
    and (document.unit_id is null or document.unit_id = any(public.auth_scopes()))
  for update of scan;
  if not found then raise exception 'document_scan_retry_unavailable' using errcode = '55000'; end if;
  perform set_config('app.document_scan_manual_retry', v_job.id::text, true);
  update public.document_scan_jobs
  set status = 'queued', manual_corners = p_corners,
      last_error_code = null, last_error_message = null
  where id = v_job.id;
  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_org, v_actor, 'document_scan_corners_submitted', 'document_scan_jobs', v_job.id,
    jsonb_build_object('document_id', v_job.document_id),
    'manual document boundary correction'
  );
  return jsonb_build_object('scan_job_id', v_job.id, 'status', 'queued');
end
$$;

create or replace function public.claim_document_scan_job(
  p_lease_owner text,
  p_lease_seconds integer default 120
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner text := nullif(trim(p_lease_owner), '');
  v_seconds integer := greatest(30, least(coalesce(p_lease_seconds, 120), 900));
  v_job public.document_scan_jobs;
  v_document public.documents;
  v_attempt_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_owner is null or length(v_owner) > 200 then
    raise exception 'lease_owner_invalid' using errcode = '22023';
  end if;
  loop
    select scan.* into v_job
    from public.document_scan_jobs scan
    where (scan.status = 'queued'
      or (scan.status = 'processing' and scan.lease_until <= statement_timestamp()))
      and private.organization_write_allowed_fenced(scan.org_id)
    order by scan.priority desc, scan.created_at, scan.id
    for update skip locked limit 1;
    if not found then return null; end if;
    if v_job.attempt_count >= 8 then
      update public.document_scan_jobs
      set status = 'failed', lease_owner = null, lease_until = null,
          last_error_code = 'claim_attempt_limit_exceeded',
          last_error_message = 'Document scanning stopped after repeated claim attempts'
      where id = v_job.id;
      continue;
    end if;
    select * into v_document from public.documents document
    where document.org_id = v_job.org_id and document.id = v_job.document_id
      and document.deleted_at is null;
    if not found then
      update public.document_scan_jobs
      set status = 'failed', lease_owner = null, lease_until = null,
          last_error_code = 'document_deleted',
          last_error_message = 'Source document was deleted before scanning'
      where id = v_job.id;
      continue;
    end if;
    v_attempt_id := gen_random_uuid();
    perform set_config('app.document_scan_claim_job', v_job.id::text, true);
    update public.document_scan_jobs
    set status = 'processing', lease_owner = v_owner,
        lease_until = now() + make_interval(secs => v_seconds),
        attempt_count = attempt_count + 1,
        processing_attempt_id = v_attempt_id,
        processing_attempt_started_at = statement_timestamp(),
        last_error_code = null, last_error_message = null
    where id = v_job.id returning * into v_job;
    exit;
  end loop;
  return jsonb_build_object(
    'job_id', v_job.id,
    'document_id', v_job.document_id,
    'org_id', v_job.org_id,
    'storage_path', v_document.storage_path,
    'mime_type', v_document.mime_type,
    'file_name', v_document.file_name,
    'input_checksum', v_job.input_checksum,
    'requested_mode', v_job.requested_mode,
    'manual_corners', v_job.manual_corners,
    'lease_until', v_job.lease_until,
    'attempt_count', v_job.attempt_count
    , 'processing_attempt_id', v_job.processing_attempt_id
    , 'processing_attempt_started_at', v_job.processing_attempt_started_at
  );
end
$$;

create or replace function private.document_scan_egress_binding(
  p_job public.document_scan_jobs,
  p_lease_id uuid,
  p_lease_token uuid,
  p_require_ack boolean,
  p_require_active boolean
) returns private.organization_external_egress_leases
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_lease private.organization_external_egress_leases;
begin
  select * into v_lease
  from private.organization_external_egress_leases lease
  where lease.lease_id = p_lease_id
  for update;
  if not found
     or p_job.processing_attempt_id is null
     or v_lease.lease_token is distinct from p_lease_token
     or v_lease.org_id is distinct from p_job.org_id
     or v_lease.kind <> 'document_signed_url'
     or v_lease.correlation_id is distinct from p_job.processing_attempt_id
     or (p_require_active and v_lease.status <> 'active')
     or (p_require_ack and (
       v_lease.acknowledged_at is null
       or v_lease.acknowledged_by is distinct from p_job.lease_owner
     )) then
    raise exception 'document_scan_egress_lease_lost' using errcode = '40001';
  end if;
  return v_lease;
end
$$;

revoke all on function private.document_scan_egress_binding(
  public.document_scan_jobs, uuid, uuid, boolean, boolean
) from public, anon, authenticated, service_role;

create or replace function public.service_acknowledge_document_scan_download(
  p_job_id uuid,
  p_lease_owner text,
  p_egress_lease_id uuid,
  p_egress_lease_token uuid,
  p_lease_seconds integer default 120
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.document_scan_jobs;
  v_lease private.organization_external_egress_leases;
  v_owner text := nullif(trim(p_lease_owner), '');
  v_seconds integer := least(greatest(coalesce(p_lease_seconds, 120), 30), 900);
  v_now timestamptz := statement_timestamp();
  v_ack timestamptz;
  v_until timestamptz;
  v_idempotent boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if v_owner is null or length(v_owner) > 200 then
    raise exception 'lease_owner_invalid' using errcode = '22023';
  end if;
  select * into v_job from public.document_scan_jobs where id = p_job_id for update;
  if not found then raise exception 'document_scan_job_unknown' using errcode = 'P0002'; end if;
  if v_job.status <> 'processing'
     or v_job.lease_owner is distinct from v_owner
     or v_job.lease_until <= v_now then
    raise exception 'document_scan_lease_lost' using errcode = '55000';
  end if;
  v_lease := private.document_scan_egress_binding(
    v_job, p_egress_lease_id, p_egress_lease_token, false, true
  );
  if v_lease.expires_at <= v_now then
    raise exception 'document_scan_egress_lease_lost' using errcode = '40001';
  end if;
  v_idempotent := v_lease.acknowledged_at is not null;
  if v_idempotent and v_lease.acknowledged_by is distinct from v_owner then
    raise exception 'document_scan_egress_lease_lost' using errcode = '40001';
  end if;
  v_ack := coalesce(v_lease.acknowledged_at, v_now);
  v_until := least(v_ack + interval '3720 seconds', v_now + make_interval(secs => v_seconds));
  if v_until <= v_now then
    raise exception 'document_scan_egress_lease_lost' using errcode = '40001';
  end if;
  update private.organization_external_egress_leases
  set acknowledged_at = v_ack, acknowledged_by = v_owner,
      expires_at = greatest(expires_at, v_until)
  where lease_id = v_lease.lease_id
  returning expires_at into v_until;
  update public.document_scan_jobs set lease_until = v_until where id = v_job.id;
  return jsonb_build_object(
    'job_id', v_job.id, 'org_id', v_job.org_id,
    'processing_attempt_id', v_job.processing_attempt_id,
    'egress_lease_id', v_lease.lease_id, 'acknowledged_at', v_ack,
    'job_lease_until', v_until, 'egress_expires_at', v_until,
    'idempotent', v_idempotent
  );
end
$$;

create or replace function public.heartbeat_document_scan_job(
  p_job_id uuid,
  p_lease_owner text,
  p_egress_lease_id uuid,
  p_egress_lease_token uuid,
  p_lease_seconds integer default 120
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.document_scan_jobs;
  v_lease private.organization_external_egress_leases;
  v_owner text := nullif(trim(p_lease_owner), '');
  v_now timestamptz := statement_timestamp();
  v_until timestamptz;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  select * into v_job from public.document_scan_jobs where id = p_job_id for update;
  if not found then raise exception 'document_scan_job_unknown' using errcode = 'P0002'; end if;
  if v_job.status <> 'processing' or v_job.lease_owner is distinct from v_owner
     or v_job.lease_until <= v_now then
    raise exception 'document_scan_lease_lost' using errcode = '55000';
  end if;
  v_lease := private.document_scan_egress_binding(
    v_job, p_egress_lease_id, p_egress_lease_token, true, true
  );
  if v_lease.expires_at <= v_now then
    raise exception 'document_scan_egress_lease_lost' using errcode = '40001';
  end if;
  v_until := least(
    v_lease.acknowledged_at + interval '3720 seconds',
    v_now + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 120), 900)))
  );
  if v_until <= v_now then
    raise exception 'document_scan_egress_lease_lost' using errcode = '40001';
  end if;
  update private.organization_external_egress_leases
  set expires_at = greatest(expires_at, v_until)
  where lease_id = v_lease.lease_id
  returning expires_at into v_until;
  update public.document_scan_jobs set lease_until = v_until where id = v_job.id;
  return jsonb_build_object(
    'job_id', v_job.id, 'processing_attempt_id', v_job.processing_attempt_id,
    'egress_lease_id', v_lease.lease_id, 'acknowledged_at', v_lease.acknowledged_at,
    'job_lease_until', v_until, 'egress_expires_at', v_until
  );
end
$$;

create or replace function public.service_complete_document_scan_job(
  p_job_id uuid,
  p_processing_attempt_id uuid,
  p_lease_owner text,
  p_egress_lease_id uuid,
  p_egress_lease_token uuid,
  p_input_checksum text,
  p_storage_path text,
  p_sha256 text,
  p_byte_size bigint,
  p_width integer,
  p_height integer,
  p_output_mode text,
  p_corners jsonb,
  p_corners_source text,
  p_rotation_degrees numeric,
  p_metrics jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.document_scan_jobs;
  v_document public.documents;
  v_output public.document_scan_outputs;
  v_lease private.organization_external_egress_leases;
  v_evidence private.organization_external_egress_evidence;
  v_settlement jsonb;
  v_current_checksum text;
  v_object_size bigint;
  v_object_mime text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_job from public.document_scan_jobs where id = p_job_id for update;
  if not found then raise exception 'document_scan_job_unknown' using errcode = 'P0002'; end if;
  if v_job.processing_attempt_id is distinct from p_processing_attempt_id then
    raise exception 'document_scan_attempt_lost' using errcode = '40001';
  end if;
  v_lease := private.document_scan_egress_binding(
    v_job, p_egress_lease_id, p_egress_lease_token, false, false
  );
  select * into v_output from public.document_scan_outputs
  where org_id = v_job.org_id and scan_job_id = v_job.id;
  if found and v_output.sha256 = lower(p_sha256) then
    select * into v_evidence
    from private.organization_external_egress_evidence evidence
    where evidence.lease_id = v_lease.lease_id
      and evidence.org_id = v_job.org_id
      and evidence.kind = 'document_signed_url'
      and evidence.correlation_id = v_job.processing_attempt_id
      and evidence.outcome = 'delivered'
      and evidence.evidence_code = 'document_scan_completed'
      and evidence.evidence ->> 'job_id' = v_job.id::text
      and evidence.evidence ->> 'output_sha256' = v_output.sha256;
    if not found then
      raise exception 'document_scan_evidence_missing' using errcode = '42501';
    end if;
    return jsonb_build_object(
      'job_id', v_job.id, 'output_id', v_output.id,
      'processing_attempt_id', v_job.processing_attempt_id,
      'egress_lease_id', v_lease.lease_id,
      'evidence_sha256', v_evidence.evidence_sha256,
      'status', v_job.status, 'idempotent', true
    );
  elsif found then
    raise exception 'document_scan_output_conflict' using errcode = '23505';
  end if;
  if v_job.status <> 'processing'
     or v_job.lease_owner is distinct from nullif(trim(p_lease_owner), '')
     or v_job.lease_until <= statement_timestamp() then
    raise exception 'document_scan_lease_lost' using errcode = '55000';
  end if;
  v_lease := private.document_scan_egress_binding(
    v_job, p_egress_lease_id, p_egress_lease_token, true, true
  );
  if v_lease.expires_at <= statement_timestamp() then
    raise exception 'document_scan_egress_lease_lost' using errcode = '40001';
  end if;
  select * into v_document from public.documents
  where org_id = v_job.org_id and id = v_job.document_id and deleted_at is null;
  if not found then raise exception 'document_unknown' using errcode = 'P0002'; end if;
  v_current_checksum := public.smart_document_source_checksum(
    v_document.org_id, v_document.storage_path, v_document.mime_type, v_document.uploaded_by
  );
  if p_input_checksum is distinct from v_job.input_checksum
     or v_current_checksum is distinct from v_job.input_checksum then
    raise exception 'document_scan_source_changed' using errcode = '55000';
  end if;
  if p_storage_path is distinct from
       v_job.org_id::text || '/' || v_job.document_id::text || '/' || v_job.id::text || '/scan.png'
     or lower(p_sha256) !~ '^[0-9a-f]{64}$'
     or p_byte_size not between 1 and 10485760
     or p_width not between 64 and 4096 or p_height not between 64 and 4096
     or p_output_mode not in ('grayscale', 'black_and_white')
     or not public.document_scan_corners_valid(p_corners)
     or p_corners_source not in ('automatic', 'manual')
     or (p_corners_source = 'manual' and v_job.manual_corners is null)
     or p_rotation_degrees not between -7 and 7
     or jsonb_typeof(coalesce(p_metrics, '{}'::jsonb)) <> 'object' then
    raise exception 'document_scan_output_invalid' using errcode = '22023';
  end if;
  select case when coalesce(object.metadata ->> 'size', '') ~ '^[0-9]{1,12}$'
           then (object.metadata ->> 'size')::bigint else null end,
         lower(split_part(trim(coalesce(object.metadata ->> 'mimetype', '')), ';', 1))
    into v_object_size, v_object_mime
  from storage.objects object
  where object.bucket_id = 'document-scans' and object.name = p_storage_path;
  if v_object_size is distinct from p_byte_size or v_object_mime is distinct from 'image/png' then
    raise exception 'document_scan_object_invalid' using errcode = 'P0002';
  end if;
  v_settlement := public.service_settle_organization_external_egress_evidence(
    v_lease.lease_id,
    p_egress_lease_token,
    'delivered',
    'document_scan_completed',
    200,
    jsonb_build_object(
      'evidence_schema_version', 'document_scan_evidence_v1',
      'job_id', v_job.id,
      'processing_attempt_id', v_job.processing_attempt_id,
      'document_id', v_job.document_id,
      'input_checksum', v_job.input_checksum,
      'output_sha256', lower(p_sha256),
      'output_bytes', p_byte_size,
      'width', p_width,
      'height', p_height,
      'output_mode', p_output_mode,
      'corners', p_corners,
      'corners_source', p_corners_source,
      'rotation_degrees', p_rotation_degrees,
      'metrics', coalesce(p_metrics, '{}'::jsonb)
    )
  );
  insert into public.document_scan_outputs (
    org_id, scan_job_id, document_id, storage_path, sha256, byte_size,
    width, height, output_mode, corners, corners_source,
    rotation_degrees, metrics
  ) values (
    v_job.org_id, v_job.id, v_job.document_id, p_storage_path, lower(p_sha256), p_byte_size,
    p_width, p_height, p_output_mode, p_corners, p_corners_source,
    p_rotation_degrees, coalesce(p_metrics, '{}'::jsonb)
  ) returning * into v_output;
  update public.document_scan_jobs
  set status = 'ready', lease_owner = null, lease_until = null
  where id = v_job.id;
  return jsonb_build_object(
    'job_id', v_job.id, 'output_id', v_output.id,
    'processing_attempt_id', v_job.processing_attempt_id,
    'egress_lease_id', v_lease.lease_id,
    'evidence_sha256', v_settlement ->> 'evidence_sha256',
    'status', 'ready', 'idempotent', false
  );
end
$$;

create or replace function public.fail_document_scan_job(
  p_job_id uuid,
  p_processing_attempt_id uuid,
  p_lease_owner text,
  p_egress_lease_id uuid,
  p_egress_lease_token uuid,
  p_error_code text,
  p_error_message text default null,
  p_retryable boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.document_scan_jobs;
  v_lease private.organization_external_egress_leases;
  v_evidence private.organization_external_egress_evidence;
  v_settlement jsonb;
  v_status text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_job from public.document_scan_jobs where id = p_job_id for update;
  if not found then raise exception 'document_scan_job_unknown' using errcode = 'P0002'; end if;
  if v_job.processing_attempt_id is distinct from p_processing_attempt_id then
    raise exception 'document_scan_attempt_lost' using errcode = '40001';
  end if;
  v_lease := private.document_scan_egress_binding(
    v_job, p_egress_lease_id, p_egress_lease_token, false, false
  );
  if v_job.status <> 'processing' then
    select * into v_evidence
    from private.organization_external_egress_evidence evidence
    where evidence.lease_id = v_lease.lease_id
      and evidence.org_id = v_job.org_id
      and evidence.kind = 'document_signed_url'
      and evidence.correlation_id = v_job.processing_attempt_id
      and evidence.evidence_code = 'document_scan_failed'
      and evidence.evidence ->> 'job_id' = v_job.id::text;
    if not found then
      raise exception 'document_scan_lease_lost' using errcode = '55000';
    end if;
    return jsonb_build_object(
      'job_id', v_job.id, 'processing_attempt_id', v_job.processing_attempt_id,
      'egress_lease_id', v_lease.lease_id,
      'evidence_sha256', v_evidence.evidence_sha256,
      'status', v_job.status, 'retryable', v_job.status = 'queued',
      'idempotent', true
    );
  end if;
  if v_job.status <> 'processing'
     or v_job.lease_owner is distinct from nullif(trim(p_lease_owner), '')
     or v_job.lease_until <= statement_timestamp() then
    raise exception 'document_scan_lease_lost' using errcode = '55000';
  end if;
  if nullif(trim(p_error_code), '') is null
     or p_error_code !~ '^[a-z0-9_]{1,100}$'
     or p_error_message is not null and length(p_error_message) > 1000 then
    raise exception 'document_scan_failure_invalid' using errcode = '22023';
  end if;
  if v_lease.acknowledged_at is not null
     and v_lease.acknowledged_by is distinct from v_job.lease_owner then
    raise exception 'document_scan_egress_lease_lost' using errcode = '40001';
  end if;
  v_status := case
    when p_error_code = 'document_not_detected' then 'needs_corners'
    when p_retryable and v_job.attempt_count < 3 then 'queued'
    else 'failed'
  end;
  v_settlement := public.service_settle_organization_external_egress_evidence(
    v_lease.lease_id,
    p_egress_lease_token,
    'failed',
    'document_scan_failed',
    null,
    jsonb_build_object(
      'evidence_schema_version', 'document_scan_evidence_v1',
      'job_id', v_job.id,
      'processing_attempt_id', v_job.processing_attempt_id,
      'document_id', v_job.document_id,
      'input_checksum', v_job.input_checksum,
      'error_code', p_error_code,
      'error_message', p_error_message,
      'retryable', v_status = 'queued'
    )
  );
  update public.document_scan_jobs
  set status = v_status, lease_owner = null, lease_until = null,
      last_error_code = case when v_status = 'queued' then null else left(p_error_code, 100) end,
      last_error_message = case when v_status = 'queued' then null else left(p_error_message, 1000) end
  where id = v_job.id;
  return jsonb_build_object(
    'job_id', v_job.id, 'processing_attempt_id', v_job.processing_attempt_id,
    'egress_lease_id', v_lease.lease_id,
    'evidence_sha256', v_settlement ->> 'evidence_sha256',
    'status', v_status, 'retryable', v_status = 'queued',
    'idempotent', false
  );
end
$$;

create or replace function public.accept_document_scan(
  p_scan_output_id uuid,
  p_reason text default 'enhanced scan approved for OCR'
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_reason text := nullif(trim(p_reason), '');
  v_output public.document_scan_outputs;
  v_scan public.document_scan_jobs;
  v_waiting public.document_processing_jobs;
  v_processing_job_id uuid;
begin
  if v_org is null or v_actor is null or auth_role() not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_reason is null or length(v_reason) not between 3 and 500 then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  select output.* into v_output
  from public.document_scan_outputs output
  join public.documents document
    on document.org_id = output.org_id and document.id = output.document_id
  where output.org_id = v_org and output.id = p_scan_output_id
    and document.deleted_at is null
    and (document.unit_id is null or document.unit_id = any(public.auth_scopes()))
  for update of output;
  if not found then raise exception 'document_scan_output_unknown' using errcode = 'P0002'; end if;
  select * into v_scan from public.document_scan_jobs
  where org_id = v_org and id = v_output.scan_job_id for update;
  select decision.processing_job_id into v_processing_job_id
  from public.document_scan_decisions decision
  where decision.org_id = v_org and decision.scan_output_id = v_output.id;
  if v_processing_job_id is not null then
    return jsonb_build_object(
      'scan_output_id', v_output.id,
      'processing_job_id', v_processing_job_id,
      'idempotent', true
    );
  end if;
  if v_scan.status <> 'ready' then
    raise exception 'document_scan_not_ready' using errcode = '55000';
  end if;
  select * into v_waiting from public.document_processing_jobs
  where org_id = v_org and id = v_scan.processing_job_id for update;
  if v_waiting.status <> 'awaiting_scan' then
    raise exception 'document_scan_processing_state_invalid' using errcode = '55000';
  end if;
  update public.document_processing_jobs
  set status = 'failed',
      last_error_code = 'superseded_by_accepted_scan',
      last_error_message = 'OCR input replaced by an approved scanned derivative'
  where id = v_waiting.id;
  insert into public.document_processing_jobs (
    org_id, document_id, requested_by, input_checksum, contract_version, scan_output_id
  ) values (
    v_org, v_output.document_id, v_waiting.requested_by,
    'etag:' || v_output.sha256, '1', v_output.id
  ) returning id into v_processing_job_id;
  update public.document_scan_jobs set status = 'accepted' where id = v_scan.id;
  insert into public.document_scan_decisions (
    org_id, scan_job_id, scan_output_id, processing_job_id,
    decided_by, decision, reason
  ) values (
    v_org, v_scan.id, v_output.id, v_processing_job_id,
    v_actor, 'accepted', v_reason
  );
  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_org, v_actor, 'document_scan_accepted', 'document_scan_outputs', v_output.id,
    jsonb_build_object(
      'document_id', v_output.document_id,
      'scan_job_id', v_scan.id,
      'processing_job_id', v_processing_job_id,
      'output_sha256', v_output.sha256
    ), v_reason
  );
  return jsonb_build_object(
    'scan_output_id', v_output.id,
    'processing_job_id', v_processing_job_id,
    'idempotent', false
  );
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
  v_reason text := nullif(trim(p_reason), '');
  v_document public.documents;
  v_output public.document_scan_outputs;
  v_checksum text;
  v_status text;
  v_job_id uuid;
  v_requires_scan boolean;
begin
  if v_org is null or v_user is null or auth_role() not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_reason is null then raise exception 'reason_required' using errcode = '22023'; end if;
  select * into v_document from public.documents document
  where document.org_id = v_org and document.id = p_document_id
    and document.deleted_at is null
    and (document.unit_id is null or document.unit_id = any(public.auth_scopes()))
  for update;
  if not found then raise exception 'document_unknown' using errcode = 'P0002'; end if;
  if exists (
    select 1 from public.document_processing_jobs job
    where job.org_id = v_org and job.document_id = v_document.id
      and job.status in ('awaiting_scan', 'queued', 'leased', 'extracted', 'interpreting')
  ) then
    raise exception 'document_processing_active' using errcode = '55000';
  end if;
  v_requires_scan := public.document_scan_image_mime(v_document.mime_type)
    and not (
      v_document.entity_type = 'supplier'
      and v_document.document_kind = 'price_list'
    );
  if v_requires_scan then
    select output.* into v_output
    from public.document_scan_outputs output
    join public.document_scan_decisions decision
      on decision.org_id = output.org_id and decision.scan_output_id = output.id
    where output.org_id = v_org and output.document_id = v_document.id
    order by decision.created_at desc limit 1;
  end if;
  if v_output.id is not null then
    v_checksum := 'etag:' || v_output.sha256;
    v_status := 'queued';
  else
    v_checksum := public.smart_document_source_checksum(
      v_document.org_id, v_document.storage_path, v_document.mime_type, v_document.uploaded_by
    );
    v_status := case when v_requires_scan then 'awaiting_scan' else 'queued' end;
  end if;
  insert into public.document_processing_jobs (
    org_id, document_id, requested_by, status, input_checksum,
    contract_version, scan_output_id
  ) values (
    v_org, v_document.id, v_document.uploaded_by, v_status,
    v_checksum, '1', v_output.id
  ) returning id into v_job_id;
  if v_status = 'awaiting_scan' then
    insert into public.document_scan_jobs (
      org_id, document_id, processing_job_id, requested_by, input_checksum
    ) values (
      v_org, v_document.id, v_job_id, v_user, v_checksum
    );
  end if;
  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_org, v_user, 'document_processing_reprocessed', 'document_processing_jobs', v_job_id,
    jsonb_build_object(
      'document_id', v_document.id,
      'contract_version', '1',
      'processing_actor_id', v_document.uploaded_by,
      'scan_output_id', v_output.id,
      'requires_scan_review', v_status = 'awaiting_scan'
    ), v_reason
  );
  return v_job_id;
end
$$;

drop function public.get_document_processing_statuses(uuid[]);
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
  scan_output_id uuid,
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
     or auth_role() not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_document_ids is not null and cardinality(p_document_ids) > 500 then
    raise exception 'too_many_document_ids' using errcode = '22023';
  end if;

  return query
  select job.id, job.org_id, job.document_id, job.requested_by, job.status,
         job.input_checksum, job.contract_version, job.priority, job.attempt_count,
         job.lease_owner, job.lease_until, job.processing_attempt_id,
         job.processing_attempt_started_at, job.last_error_code, job.last_error_message,
         job.created_at, job.updated_at, job.scan_output_id,
         case when job.status in ('awaiting_scan', 'queued', 'leased', 'extracted', 'interpreting')
              then extract(epoch from (statement_timestamp() - job.created_at))::bigint
              else null end,
         health.stuck_reason is not null,
         health.stuck_reason
  from public.document_processing_jobs job
  join public.documents document
    on document.org_id = job.org_id and document.id = job.document_id
  cross join lateral (
    select private.document_processing_stuck_reason(
      job.status, job.attempt_count, job.created_at, job.updated_at, job.lease_until,
      statement_timestamp()
    ) as stuck_reason
  ) health
  where job.org_id = auth_org()
    and document.deleted_at is null
    and (document.unit_id is null or document.unit_id = any(public.auth_scopes()))
    and (p_document_ids is null or job.document_id = any(p_document_ids))
  order by job.created_at desc, job.id desc;
end
$$;

revoke all on function public.get_document_processing_statuses(uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.get_document_processing_statuses(uuid[]) to authenticated;

-- The OCR gateway keeps its mature lease/evidence behavior. This wrapper changes only source
-- selection after a claim: accepted image jobs resolve to the scan bucket and immutable checksum.
create or replace function public.claim_document_processing_job_input(
  p_lease_owner text,
  p_lease_seconds integer default 120
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_claim jsonb;
  v_output public.document_scan_outputs;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_claim := public.claim_document_processing_job(p_lease_owner, p_lease_seconds);
  if v_claim is null then return null; end if;
  select output.* into v_output
  from public.document_processing_jobs job
  join public.document_scan_outputs output
    on output.org_id = job.org_id and output.id = job.scan_output_id
  where job.id = (v_claim ->> 'job_id')::uuid;
  if v_output.id is null then
    return v_claim || jsonb_build_object('storage_bucket', 'documents');
  end if;
  if v_claim ->> 'input_checksum' is distinct from 'etag:' || v_output.sha256 then
    raise exception 'document_processing_scan_checksum_invalid' using errcode = '55000';
  end if;
  return v_claim || jsonb_build_object(
    'storage_bucket', 'document-scans',
    'storage_path', v_output.storage_path,
    'mime_type', v_output.mime_type,
    'file_name', 'scan.png'
  );
end
$$;

do $processing_source_fence_patch$
declare
  v_signature text;
  v_procedure regprocedure;
  v_definition text;
  v_pattern text := 'public\.smart_document_source_checksum\(\s*'
    || 'v_document\.org_id,\s*v_document\.storage_path,\s*'
    || 'v_document\.mime_type,\s*v_document\.uploaded_by\s*\)';
  v_new text := 'private.document_processing_current_checksum(v_job)';
  v_patched text;
begin
  foreach v_signature in array array[
    'public.complete_document_processing_job(uuid,uuid,text,uuid,uuid,text)',
    'public.complete_document_processing_job(uuid,text,text,text,text,text,text,jsonb,integer,jsonb)',
    'public.service_recover_document_extraction_from_egress(uuid,uuid,uuid,text)',
    'public.service_recover_stuck_document_processing(uuid,uuid,uuid,text)'
  ] loop
    v_procedure := v_signature::regprocedure;
    v_definition := replace(pg_get_functiondef(v_procedure), e'\r', '');
    v_patched := regexp_replace(v_definition, v_pattern, v_new);
    if v_patched = v_definition then
      raise exception '0136: source checksum anchor moved for %', v_signature;
    end if;
    execute v_patched;
  end loop;
end
$processing_source_fence_patch$;

-- A stuck scan-bound OCR job must keep the same accepted derivative when recovery creates its
-- successor. Copying only the checksum would drop the source path binding and make the wrapper
-- claim the original `documents` object under a scan checksum.
do $processing_recovery_scan_binding_patch$
declare
  v_procedure regprocedure :=
    'public.service_recover_stuck_document_processing(uuid,uuid,uuid,text)'::regprocedure;
  v_definition text := replace(pg_get_functiondef(v_procedure), e'\r', '');
  v_old text := replace($old$    insert into public.document_processing_jobs (
      org_id, document_id, requested_by, input_checksum, contract_version, priority
    ) values (
      v_job.org_id, v_job.document_id, v_document.uploaded_by,
      v_current_checksum, v_job.contract_version, v_job.priority
    ) returning id into v_new_job_id;$old$, e'\r', '');
  v_new text := replace($new$    insert into public.document_processing_jobs (
      org_id, document_id, requested_by, input_checksum, contract_version, priority,
      scan_output_id
    ) values (
      v_job.org_id, v_job.document_id, v_document.uploaded_by,
      v_current_checksum, v_job.contract_version, v_job.priority,
      v_job.scan_output_id
    ) returning id into v_new_job_id;$new$, e'\r', '');
begin
  if position(v_old in v_definition) = 0 then
    raise exception '0136: stuck recovery successor anchor moved';
  end if;
  execute replace(v_definition, v_old, v_new);
end
$processing_recovery_scan_binding_patch$;

revoke all on function public.enqueue_document_processing(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.enqueue_document_processing(uuid) to authenticated;
revoke all on function public.begin_document_intake(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_document_intake(uuid) to authenticated;
revoke all on function public.get_document_scan_states(uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.get_document_scan_states(uuid[]) to authenticated;
revoke all on function public.submit_document_scan_corners(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.submit_document_scan_corners(uuid, jsonb) to authenticated;
revoke all on function public.accept_document_scan(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.accept_document_scan(uuid, text) to authenticated;
revoke all on function public.reprocess_document(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.reprocess_document(uuid, text) to authenticated;
revoke all on function public.claim_document_scan_job(text, integer),
  public.service_acknowledge_document_scan_download(uuid, text, uuid, uuid, integer),
  public.heartbeat_document_scan_job(uuid, text, uuid, uuid, integer),
  public.service_complete_document_scan_job(
    uuid, uuid, text, uuid, uuid, text, text, text, bigint, integer, integer,
    text, jsonb, text, numeric, jsonb
  ),
  public.fail_document_scan_job(uuid, uuid, text, uuid, uuid, text, text, boolean),
  public.claim_document_processing_job_input(text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_document_scan_job(text, integer),
  public.service_acknowledge_document_scan_download(uuid, text, uuid, uuid, integer),
  public.heartbeat_document_scan_job(uuid, text, uuid, uuid, integer),
  public.service_complete_document_scan_job(
    uuid, uuid, text, uuid, uuid, text, text, text, bigint, integer, integer,
    text, jsonb, text, numeric, jsonb
  ),
  public.fail_document_scan_job(uuid, uuid, text, uuid, uuid, text, text, boolean),
  public.claim_document_processing_job_input(text, integer)
  to service_role;

insert into private.scope_registry (table_name, scope_class, enforced) values
  ('document_scan_jobs', 'derived', false),
  ('document_scan_outputs', 'derived', false),
  ('document_scan_decisions', 'derived', false)
on conflict (table_name) do update set
  scope_class = excluded.scope_class,
  enforced = excluded.enforced;

insert into private.scope_definer_exemptions (
  function_signature, reason, target_wave
) values
  (
    'claim_document_scan_job(text,integer)',
    'service-role-only worker claim; organization comes from the queued row and organization_write_allowed_fenced rejects suspended or read-only tenants',
    'document scan preprocessing'
  ),
  (
    'service_complete_document_scan_job(uuid,uuid,text,uuid,uuid,text,text,text,bigint,integer,integer,text,jsonb,text,numeric,jsonb)',
    'service-role-only settlement; locked scan job, attempt identity, egress lease, source checksum, object path and tenant foreign keys fail closed',
    'document scan preprocessing'
  );

insert into private.tenant_export_registry (
  table_name, disposition, excluded_columns, rationale
) values
  ('document_scan_jobs', 'exclude', '{}',
   'Transient document scanning worker leases and retry state are not tenant business evidence.'),
  ('document_scan_outputs', 'include', '{}',
   'Tenant scanned-document derivative metadata and integrity evidence.'),
  ('document_scan_decisions', 'include', '{}',
   'Tenant human approval evidence for OCR input selection.')
on conflict (table_name) do update set
  disposition = excluded.disposition,
  excluded_columns = excluded.excluded_columns,
  rationale = excluded.rationale;

update private.tenant_export_registry registry
set exported_columns = case when registry.disposition = 'exclude' then '{}'::text[] else (
      select array_agg(column_info.column_name order by column_info.ordinal_position)
      from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = registry.table_name
        and not (column_info.column_name = any(registry.excluded_columns))
    ) end,
    schema_hash = (
      select md5(string_agg(
        column_info.column_name || ':' || column_info.data_type || ':' || column_info.is_nullable,
        '|' order by column_info.ordinal_position
      ))
      from information_schema.columns column_info
      where column_info.table_schema = 'public'
        and column_info.table_name = registry.table_name
    )
where registry.table_name in (
  'document_processing_jobs', 'document_scan_jobs',
  'document_scan_outputs', 'document_scan_decisions'
);

insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
)
select reviewed.function_signature, md5(replace(proc.prosrc, e'\r', '')),
       'filtered_read', reviewed.scope_proof
from (values
  ('begin_document_intake(uuid)',
   '0136 filters the source document by auth_org and the canonical null-or-auth_scopes unit predicate before enqueueing.'),
  ('get_document_scan_states(uuid[])',
   '0136 returns scan state only for auth_org documents passing the canonical null-or-auth_scopes unit predicate.'),
  ('get_document_processing_statuses(uuid[])',
   '0136 returns processing state only for auth_org documents passing the canonical null-or-auth_scopes unit predicate.'),
  ('submit_document_scan_corners(uuid,jsonb)',
   '0136 locks the scan only through its auth_org document and canonical null-or-auth_scopes unit predicate.'),
  ('accept_document_scan(uuid,text)',
   '0136 locks the scan output only through its auth_org document and canonical null-or-auth_scopes unit predicate.'),
  ('enqueue_document_processing(uuid)',
    '0136 filters the source document by auth_org and the canonical null-or-auth_scopes unit predicate before any queue write.')
) as reviewed(function_signature, scope_proof)
join pg_catalog.pg_proc proc
  on proc.oid = pg_catalog.to_regprocedure(reviewed.function_signature)
on conflict (function_signature) do update set
  body_hash = excluded.body_hash,
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
    raise exception e'0136 scope assertions failed:\n%', v_violations;
  end if;
  select string_agg(detail, e'\n' order by detail)
    into v_violations
  from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0136 tenant export assertions failed:\n%', v_violations;
  end if;
end
$$;
