-- 0065_upload_reservation_renewal.sql
-- Wave 6b (PLAN-07 §1 decision 2): resumable tus uploads outlive the fixed 15-minute
-- reservation window, so the 0048 reservation plane gains three fixes in one migration:
--
--   (1) renew_supplier_price_document_upload(p_document_id) -- a time-extension-ONLY RPC.
--       No re-bind, no parameter beyond the id; the caller's OWN reservation, with the
--       same liveness checks reserve makes; total lifetime capped at 45 minutes from
--       created_at (below the ~1h cloud tus expiry). Renewal is NOT audited -- the
--       precedent is reserve itself (OPEN-DECISIONS #95).
--   (2) a one-hour grace on the cross-tenant sweep inside reserve (0048:352-353 deleted
--       every expired reservation on every reserve call by anyone -- a race a renewal
--       cannot win). Expiry still closes the storage and register gates at expires_at,
--       unchanged; the grace only delays PHYSICAL deletion so an in-flight renewal
--       cannot lose to another tenant's sweep and orphan already-transferred bytes.
--   (3) a column-guard trigger on the reservation table (the documents_guard_columns
--       idiom, 0045:69). The RPC bodies were the only thing standing between a
--       service-role writer and a coherent re-bind (supplier_id + storage_path updated
--       together, satisfying every CHECK); the guard makes re-binding structurally
--       impossible instead of merely unreachable.
--
-- A5 note: the renewal RPC and the replaced reserve body touch only unenforced tables
-- (profiles, organizations, suppliers, the reservation table); neither body may contain
-- a word-boundary match of any enforced table name -- the 0057 regex reads prosrc,
-- comments and string literals included. The guard trigger function needs no table
-- access at all (it only compares OLD with NEW), so unlike its 0045 namesake it is NOT
-- SECURITY DEFINER -- invoker rights suffice and keep it off the A5 definer surface.

-- ===== 1. The column guard =====

create or replace function public.supplier_price_upload_reservation_guard_columns()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  -- Identity and binding are immutable from the moment the row is reserved: the storage
  -- policy trusts (path, mime, actor, org) exactly as reserved, so a coherent re-bind
  -- must fail here, not merely be absent from the RPC bodies.
  if new.document_id is distinct from old.document_id
     or new.org_id is distinct from old.org_id
     or new.actor_id is distinct from old.actor_id
     or new.supplier_id is distinct from old.supplier_id
     or new.file_name is distinct from old.file_name
     or new.mime_type is distinct from old.mime_type
     or new.storage_path is distinct from old.storage_path
     or new.created_at is distinct from old.created_at then
    raise exception 'upload_reservation_binding_immutable' using errcode = '42501';
  end if;

  -- Exactly one lifecycle transition exists: reserved -> registered, and the receipt
  -- columns may change only inside it (the 0048 status CHECK then forces them non-null).
  -- A registered receipt is permanent: no re-pointing object_id/job_id afterwards.
  if new.status is distinct from old.status then
    if old.status <> 'reserved' or new.status <> 'registered' then
      raise exception 'upload_reservation_invalid_transition' using errcode = '42501';
    end if;
  elsif new.object_id is distinct from old.object_id
     or new.object_updated_at is distinct from old.object_updated_at
     or new.job_id is distinct from old.job_id
     or new.registered_at is distinct from old.registered_at then
    raise exception 'upload_reservation_receipt_immutable' using errcode = '42501';
  end if;

  -- expires_at moves only while the claim is still open (the renewal path).
  if new.expires_at is distinct from old.expires_at and old.status <> 'reserved' then
    raise exception 'upload_reservation_expiry_locked' using errcode = '42501';
  end if;

  return new;
end
$$;

create trigger supplier_price_document_upload_reservations_guard
  before update on public.supplier_price_document_upload_reservations
  for each row
  execute function public.supplier_price_upload_reservation_guard_columns();

-- ===== 2. The renewal RPC =====

create or replace function public.renew_supplier_price_document_upload(
  p_document_id uuid
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
  v_reservation public.supplier_price_document_upload_reservations;
  v_lifetime_deadline timestamptz;
  v_expires_at timestamptz;
begin
  if v_org is null or v_actor is null or p_document_id is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  -- The same liveness gate reserve holds: active profile, permitted role, live org.
  select p.role, p.supplier_id into v_role, v_profile_supplier
  from public.profiles p
  join public.organizations o on o.id = p.org_id
  where p.id = v_actor and p.org_id = v_org and p.active
    and o.status in ('trial', 'active');
  if v_role is null or v_role not in ('owner', 'office', 'supplier') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  -- Only the caller's OWN claim: actor and org are part of the lookup, so a foreign
  -- actor sees no row at all -- the same shape register uses.
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

  -- A registered claim has no upload window left to extend. Named rejection, not
  -- idempotent success: success would tell the client to keep uploading, and the money
  -- rule says a stored-and-registered file is never re-uploaded (OPEN-DECISIONS #95).
  if v_reservation.status = 'registered' then
    raise exception 'document_upload_reservation_registered' using errcode = 'P0001';
  end if;

  -- Total-lifetime cap: 45 minutes from created_at, below the ~1h cloud tus expiry.
  -- Note there is deliberately NO expires_at check here: a claim past expires_at but
  -- inside the lifetime cap is exactly the renewal race the sweep grace protects --
  -- renewal revives it, while the storage and register gates stayed closed since expiry.
  v_lifetime_deadline := v_reservation.created_at + interval '45 minutes';
  if v_lifetime_deadline <= now() then
    raise exception 'document_upload_reservation_lifetime_exceeded'
      using errcode = 'P0001';
  end if;

  v_expires_at := least(now() + interval '15 minutes', v_lifetime_deadline);
  update public.supplier_price_document_upload_reservations
  set expires_at = v_expires_at
  where document_id = v_reservation.document_id;

  return jsonb_build_object(
    'document_id', v_reservation.document_id,
    'expires_at', v_expires_at,
    'renewable_until', v_lifetime_deadline
  );
end
$$;

revoke all on function public.renew_supplier_price_document_upload(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.renew_supplier_price_document_upload(uuid)
  to authenticated;

-- ===== 3. The sweep grace =====
-- Replaced from the LIVE catalog definition (pg_get_functiondef verified against the
-- running stack, 2026-08-05: byte-identical to 0048:316-387 -- no migration since 0048
-- touched it). The ONLY change is the sweep predicate (and its comment): physical
-- deletion now waits a full hour past expiry. Expiry semantics everywhere else --
-- the storage policy's active predicate and register's :698 check -- are untouched.

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

  -- Registered rows are the durable retry receipt. Only unused claims a full grace hour
  -- past expiry are disposable: expiry alone already closed the storage and register
  -- gates, and the grace keeps a just-expired claim renewable so an in-flight renewal
  -- cannot lose the race to another tenant's sweep (0065).
  delete from public.supplier_price_document_upload_reservations
  where status = 'reserved' and expires_at <= now() - interval '1 hour';

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

-- CREATE OR REPLACE preserves ACLs; re-asserted anyway so the contract is visible here.
revoke all on function public.reserve_supplier_price_document_upload(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.reserve_supplier_price_document_upload(uuid, text, text)
  to authenticated;

-- ===== 4. Re-assert (the 0058:207-218 idiom) =====
-- No public table was added (A1 untouched); proves the new definer RPC and the replaced
-- reserve body tripped neither A5 arm and no rider/registry/definer contract regressed
-- inside this migration. The guard trigger function is not SECURITY DEFINER and its
-- table sits in the registry with enforced = false, so neither A5 arm reaches it.
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0065 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
