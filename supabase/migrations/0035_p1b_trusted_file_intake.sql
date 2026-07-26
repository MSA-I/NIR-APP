-- P1B trusted file intake. Migration 0026 remains immutable; this migration closes its
-- browser-trust boundary by requiring a short-lived, service-authored claim over the exact
-- private Storage object before the existing atomic price command can run.

create table public.supplier_price_submission_intakes (
  id uuid primary key,
  org_id uuid not null references public.organizations(id),
  actor_id uuid not null,
  supplier_id uuid not null,
  submission_id uuid not null unique,
  target_month date not null,
  file_name text not null,
  storage_path text not null unique,
  object_id uuid not null,
  object_updated_at timestamptz not null,
  mime_type text not null,
  file_checksum text,
  file_size bigint,
  rows_payload jsonb,
  reason text not null,
  status text not null default 'claimed',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  constraint supplier_price_submission_intakes_actor_fk
    foreign key (org_id, actor_id) references public.profiles(org_id, id),
  constraint supplier_price_submission_intakes_supplier_fk
    foreign key (org_id, supplier_id) references public.suppliers(org_id, id),
  constraint supplier_price_submission_intakes_month_check
    check (target_month = date_trunc('month', target_month)::date),
  constraint supplier_price_submission_intakes_file_name_check
    check (length(trim(file_name)) between 1 and 255 and file_name !~ '[\\/]'),
  constraint supplier_price_submission_intakes_path_check check (
    array_length(string_to_array(storage_path, '/'), 1) = 5
    and split_part(storage_path, '/', 1) = org_id::text
    and split_part(storage_path, '/', 2) = 'price-submissions'
    and split_part(storage_path, '/', 3) = supplier_id::text
    and split_part(storage_path, '/', 4) = submission_id::text
    and split_part(storage_path, '/', 5) <> ''
    and split_part(storage_path, '/', 6) = ''
  ),
  constraint supplier_price_submission_intakes_mime_check check (
    mime_type in (
      'text/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
  ),
  constraint supplier_price_submission_intakes_reason_check
    check (length(trim(reason)) between 1 and 1000),
  constraint supplier_price_submission_intakes_expiry_check
    check (expires_at > created_at and expires_at <= created_at + interval '15 minutes'),
  constraint supplier_price_submission_intakes_status_check
    check (status in ('claimed', 'prepared')),
  constraint supplier_price_submission_intakes_payload_check check (
    (
      status = 'claimed'
      and file_checksum is null and file_size is null and rows_payload is null
    )
    or (
      status = 'prepared'
      and file_checksum ~ '^[0-9a-f]{64}$'
      and file_size between 1 and 10485760
      and jsonb_typeof(rows_payload) = 'array'
      and jsonb_array_length(rows_payload) between 1 and 5000
    )
  )
);

alter table public.supplier_price_submission_intakes enable row level security;
revoke all on table public.supplier_price_submission_intakes
  from public, anon, authenticated;
grant select, insert, update, delete on table public.supplier_price_submission_intakes
  to service_role;

comment on table public.supplier_price_submission_intakes is
  'Short-lived service_role-only claims binding a caller to immutable Storage bytes before price submission.';

-- Storage policies cannot read the service-only table as an authenticated user. This narrow
-- helper exposes one bit only for the caller's own tenant path and keeps an object immutable
-- while the Edge Function hashes and parses it.
create function public.p1b_price_intake_is_active(p_storage_path text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when auth_org() is null
      or split_part(coalesce(p_storage_path, ''), '/', 1) <> auth_org()::text
      then false
    else exists (
      select 1
      from public.supplier_price_submission_intakes intake
      where intake.storage_path = p_storage_path
        and intake.expires_at > now()
    )
  end
$$;

revoke all on function public.p1b_price_intake_is_active(text) from public, anon;
grant execute on function public.p1b_price_intake_is_active(text) to authenticated;

drop policy if exists price_submissions_storage_delete on storage.objects;
create policy price_submissions_storage_delete
on storage.objects for delete to authenticated
using (
  bucket_id = 'price-submissions'
  and array_length(storage.foldername(name), 1) = 4
  and (storage.foldername(name))[1] = auth_org()::text
  and (storage.foldername(name))[2] = 'price-submissions'
  and (owner = auth.uid() or owner_id = auth.uid()::text)
  and (
    auth_role() in ('owner', 'office')
    or (
      auth_role() = 'supplier'
      and auth_supplier() is not null
      and (storage.foldername(name))[3] = auth_supplier()::text
    )
  )
  and not public.p1b_price_intake_is_active(name)
  and not exists (
    select 1
    from public.supplier_price_submissions submission
    where submission.org_id = auth_org()
      and submission.storage_path = storage.objects.name
  )
);

-- First service-only step: validate the actor, tenant, target supplier and uploader, lock the
-- Storage row, and claim its exact object id/version timestamp before bytes are downloaded.
create function public.claim_supplier_price_intake(
  p_intake_id uuid,
  p_actor_id uuid,
  p_supplier_id uuid,
  p_submission_id uuid,
  p_target_month date,
  p_file_name text,
  p_storage_path text,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid;
  v_role public.user_role;
  v_profile_supplier uuid;
  v_object_id uuid;
  v_object_updated_at timestamptz;
  v_mime text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'price_submission_intake_service_only' using errcode = '42501';
  end if;

  if p_intake_id is null or p_actor_id is null or p_supplier_id is null
     or p_submission_id is null or p_target_month is null
     or p_target_month <> date_trunc('month', p_target_month)::date
     or length(trim(coalesce(p_file_name, ''))) not between 1 and 255
     or p_file_name ~ '[\\/]'
     or length(trim(coalesce(p_reason, ''))) not between 1 and 1000
     or p_storage_path is null then
    raise exception 'price_submission_invalid' using errcode = '22023';
  end if;

  select profile.org_id, profile.role, profile.supplier_id
    into v_org, v_role, v_profile_supplier
  from public.profiles profile
  join public.organizations organization on organization.id = profile.org_id
  where profile.id = p_actor_id
    and profile.active
    and organization.status <> 'suspended';

  if v_org is null or v_role not in ('owner', 'office', 'supplier')
     or (v_role = 'supplier' and v_profile_supplier is distinct from p_supplier_id) then
    raise exception 'price_submission_not_authorized' using errcode = '42501';
  end if;

  perform 1
  from public.suppliers supplier
  where supplier.org_id = v_org
    and supplier.id = p_supplier_id
    and supplier.deleted_at is null;
  if not found then
    raise exception 'price_submission_supplier_invalid' using errcode = 'P0002';
  end if;

  if array_length(string_to_array(p_storage_path, '/'), 1) <> 5
     or split_part(p_storage_path, '/', 1) <> v_org::text
     or split_part(p_storage_path, '/', 2) <> 'price-submissions'
     or split_part(p_storage_path, '/', 3) <> p_supplier_id::text
     or split_part(p_storage_path, '/', 4) <> p_submission_id::text
     or split_part(p_storage_path, '/', 5) = ''
     or split_part(p_storage_path, '/', 6) <> '' then
    raise exception 'price_submission_invalid' using errcode = '22023';
  end if;

  delete from public.supplier_price_submission_intakes
  where expires_at <= now();

  if exists (
    select 1 from public.supplier_price_submission_intakes intake
    where intake.storage_path = p_storage_path or intake.submission_id = p_submission_id
  ) then
    raise exception 'price_submission_intake_busy' using errcode = '55P03';
  end if;

  select object.id, object.updated_at,
         lower(split_part(coalesce(object.metadata ->> 'mimetype', ''), ';', 1))
    into v_object_id, v_object_updated_at, v_mime
  from storage.objects object
  where object.bucket_id = 'price-submissions'
    and object.name = p_storage_path
    and (object.owner = p_actor_id or object.owner_id = p_actor_id::text)
  for update;

  if v_object_id is null or v_mime not in (
    'text/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) then
    raise exception 'price_submission_file_missing' using errcode = 'P0002';
  end if;

  begin
    insert into public.supplier_price_submission_intakes (
      id, org_id, actor_id, supplier_id, submission_id, target_month,
      file_name, storage_path, object_id, object_updated_at, mime_type, reason
    ) values (
      p_intake_id, v_org, p_actor_id, p_supplier_id, p_submission_id, p_target_month,
      trim(p_file_name), p_storage_path, v_object_id, v_object_updated_at, v_mime, trim(p_reason)
    );
  exception when unique_violation then
    -- Two service requests may race after the optimistic check above. Keep that outcome a
    -- stable, retryable domain error instead of exposing a raw uniqueness violation.
    raise exception 'price_submission_intake_busy' using errcode = '55P03';
  end;

  return p_intake_id;
end
$$;

revoke all on function public.claim_supplier_price_intake(
  uuid, uuid, uuid, uuid, date, text, text, text
) from public, anon, authenticated;
grant execute on function public.claim_supplier_price_intake(
  uuid, uuid, uuid, uuid, date, text, text, text
) to service_role;

-- Second service-only step: after the claimed object is downloaded, re-check its immutable
-- identity and attach the hash and canonical rows computed from those exact bytes.
create function public.prepare_supplier_price_intake(
  p_intake_id uuid,
  p_actor_id uuid,
  p_file_checksum text,
  p_file_size bigint,
  p_rows jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_intake public.supplier_price_submission_intakes%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'price_submission_intake_service_only' using errcode = '42501';
  end if;
  if p_intake_id is null or p_actor_id is null
     or lower(trim(coalesce(p_file_checksum, ''))) !~ '^[0-9a-f]{64}$'
     or p_file_size is null
     or p_file_size not between 1 and 10485760
     or p_rows is null or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) not between 1 and 5000 then
    raise exception 'price_submission_intake_invalid' using errcode = '22023';
  end if;

  select * into v_intake
  from public.supplier_price_submission_intakes intake
  where intake.id = p_intake_id
    and intake.actor_id = p_actor_id
    and intake.status = 'claimed'
    and intake.expires_at > now()
  for update;
  if not found then
    raise exception 'price_submission_intake_required' using errcode = 'P0002';
  end if;

  perform 1
  from storage.objects object
  where object.bucket_id = 'price-submissions'
    and object.name = v_intake.storage_path
    and object.id = v_intake.object_id
    and object.updated_at = v_intake.object_updated_at
    and (object.owner = v_intake.actor_id or object.owner_id = v_intake.actor_id::text)
    and lower(split_part(coalesce(object.metadata ->> 'mimetype', ''), ';', 1)) = v_intake.mime_type
  for update;
  if not found then
    raise exception 'price_submission_file_changed' using errcode = 'P0001';
  end if;

  update public.supplier_price_submission_intakes
  set file_checksum = lower(trim(p_file_checksum)),
      file_size = p_file_size,
      rows_payload = p_rows,
      status = 'prepared'
  where id = p_intake_id;

  return p_intake_id;
end
$$;

revoke all on function public.prepare_supplier_price_intake(
  uuid, uuid, text, bigint, jsonb
) from public, anon, authenticated;
grant execute on function public.prepare_supplier_price_intake(
  uuid, uuid, text, bigint, jsonb
) to service_role;

create function public.discard_supplier_price_intake(
  p_intake_id uuid,
  p_actor_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'price_submission_intake_service_only' using errcode = '42501';
  end if;
  delete from public.supplier_price_submission_intakes
  where id = p_intake_id and actor_id = p_actor_id;
  return found;
end
$$;

revoke all on function public.discard_supplier_price_intake(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.discard_supplier_price_intake(uuid, uuid)
  to service_role;

-- Keep the already-tested 0026 command as an internal implementation, but remove every API
-- grant. Only the wrapper below can supply its checksum and rows, sourced from a prepared intake.
alter function public.submit_supplier_price_list(
  uuid, uuid, date, text, text, text, jsonb, text
) rename to p1b_submit_supplier_price_list_internal;

revoke all on function public.p1b_submit_supplier_price_list_internal(
  uuid, uuid, date, text, text, text, jsonb, text
) from public, anon, authenticated, service_role;

create function public.submit_supplier_price_list(p_intake_id uuid)
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

  delete from public.supplier_price_submission_intakes where id = v_intake.id;
  return v_result;
end
$$;

revoke all on function public.submit_supplier_price_list(uuid) from public, anon;
grant execute on function public.submit_supplier_price_list(uuid) to authenticated;

comment on function public.submit_supplier_price_list(uuid) is
  'Consumes one prepared service-authored intake and atomically applies its canonical file payload.';
