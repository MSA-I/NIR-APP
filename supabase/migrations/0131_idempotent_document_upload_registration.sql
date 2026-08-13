-- 0131 — Idempotent browser document registration after a durable Storage upload.
--
-- A direct INSERT followed by best-effort object cleanup cannot distinguish "the database
-- rejected the row" from "the row committed and the HTTP response was lost". In the latter
-- case cleanup deletes the source object of a registered document; retrying can also create a
-- second document row. The client upload key below is minted before TUS starts and survives
-- every registration retry. One tenant/key therefore names exactly one immutable registry row.
-- The transport key deliberately lives in a private registry rather than on documents: browser
-- roles already hold UPDATE on documents for soft-delete/refiling, and PostgreSQL policies are
-- permissive by default. Keeping the key out of that table makes direct rebinding impossible
-- instead of relying on a forgeable transaction GUC or on policy ordering.

create table private.document_upload_registrations (
  org_id uuid not null references public.organizations(id) on delete cascade,
  client_upload_key text not null check (
    client_upload_key ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,199}$'
  ),
  document_id uuid not null references public.documents(id) on delete cascade,
  storage_path text not null,
  uploaded_by uuid not null references public.profiles(id),
  created_at timestamptz not null default statement_timestamp(),
  primary key (org_id, client_upload_key),
  unique (org_id, document_id),
  unique (org_id, storage_path)
);

revoke all on table private.document_upload_registrations
from public, anon, authenticated, service_role;

-- Registration now has state that a direct documents INSERT cannot supply. Remove the old
-- browser column grant so every authenticated registration must cross the stable-key RPC. The
-- service_role grant is deliberately untouched: trusted fixtures and server maintenance still
-- need to seed/import document rows without impersonating a browser.
revoke insert on table public.documents from public, anon, authenticated;
revoke insert (
  org_id, entity_type, entity_id, storage_path, file_name, mime_type, uploaded_by,
  document_kind, supplier_id, document_date
) on table public.documents from public, anon, authenticated;

-- Storage object identity is also unique. This closes the rollout/legacy window where an older
-- client may have committed the same durable path without a client key before losing its HTTP
-- response. The new RPC must recover that row, not register the object a second time.
do $$
begin
  if exists (
    select 1
    from public.documents
    group by org_id, storage_path
    having count(*) > 1
  ) then
    raise exception '0131: duplicate document storage paths require reviewed remediation before uniqueness can be enforced'
      using errcode = '23505';
  end if;
end
$$;

create unique index documents_org_storage_path_key
  on public.documents (org_id, storage_path);

-- The registry is private and has no browser grants, and 0131 revokes browser INSERT on documents,
-- so this is the single idempotent registration boundary. Storage-path uniqueness still covers
-- rows imported by service_role and rows committed by pre-0131 clients before the cutover.
-- It repeats the live documents_insert contract before its definer privileges are used. The
-- entity trigger remains authoritative for entity/supplier integrity, while auth_scopes keeps
-- the function scope-aware for A5 instead of adding another single-unit exemption.
create function public.register_uploaded_document(
  p_client_upload_key text,
  p_entity_type text,
  p_entity_id uuid,
  p_storage_path text,
  p_file_name text,
  p_mime_type text,
  p_document_kind text,
  p_supplier_id uuid default null,
  p_document_date date default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_role public.user_role := auth_role();
  v_key text := nullif(trim(p_client_upload_key), '');
  v_mime text := lower(nullif(trim(p_mime_type), ''));
  v_document public.documents;
  v_registered_document_id uuid;
  v_registered_key text;
  v_inserted boolean := false;
begin
  if v_org is null or v_actor is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_key is null or v_key !~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,199}$' then
    raise exception 'document_upload_key_invalid' using errcode = '22023';
  end if;

  if not public.organization_write_allowed()
     or p_storage_path is null
     or p_storage_path not like v_org::text || '/%'
     or p_entity_type not in ('inbox', 'invoice', 'goods_receipt', 'payment', 'supplier')
     or v_mime is null
     or not public.smart_document_mime_allowed(v_mime)
     or not public.p0_document_object_owned(p_storage_path, v_mime)
     or not (
       v_role in ('owner', 'office')
       or (
         v_role = 'accountant'
         and p_entity_type = 'payment'
         and exists (
           select 1
           from public.payments payment
           where payment.org_id = v_org
             and payment.id = p_entity_id
             and payment.executed_by = v_actor
             and (payment.unit_id is null or payment.unit_id = any(public.auth_scopes()))
         )
       )
     ) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select registration.document_id into v_registered_document_id
  from private.document_upload_registrations registration
  where registration.org_id = v_org
    and registration.client_upload_key = v_key;

  if found then
    select * into v_document
    from public.documents document
    where document.id = v_registered_document_id
      and document.org_id = v_org
    for update;
    if not found then
      raise exception 'document_upload_key_conflict' using errcode = '23505';
    end if;
  else
    insert into public.documents (
      org_id, entity_type, entity_id, storage_path, file_name, mime_type, uploaded_by,
      document_kind, supplier_id, document_date
    ) values (
      v_org, p_entity_type, p_entity_id, p_storage_path, p_file_name, v_mime, v_actor,
      p_document_kind, p_supplier_id, p_document_date
    )
    on conflict do nothing
    returning * into v_document;

    v_inserted := found;
    if not v_inserted then
      select * into v_document
      from public.documents document
      where document.org_id = v_org
        and document.storage_path = p_storage_path
      for update;

      if not found then
        raise exception 'document_upload_key_conflict' using errcode = '23505';
      end if;
    end if;
  end if;

  -- Scope is checked before lifecycle so the definer never reveals whether an out-of-scope row is
  -- live or soft-deleted through two distinguishable conflict codes.
  if v_document.unit_id is not null
     and not (v_document.unit_id = any(public.auth_scopes())) then
    raise exception 'document_upload_key_conflict' using errcode = '23505';
  end if;

  if v_document.deleted_at is not null then
    raise exception 'document_upload_key_retired' using errcode = '23505';
  end if;

  if v_document.uploaded_by is distinct from v_actor
     or v_document.entity_type is distinct from p_entity_type
     or v_document.entity_id is distinct from p_entity_id
     or v_document.storage_path is distinct from p_storage_path
     or v_document.file_name is distinct from p_file_name
     or lower(v_document.mime_type) is distinct from v_mime
     or v_document.document_kind is distinct from p_document_kind
     or v_document.supplier_id is distinct from p_supplier_id
     or v_document.document_date is distinct from p_document_date then
    raise exception 'document_upload_key_conflict' using errcode = '23505';
  end if;

  insert into private.document_upload_registrations (
    org_id, client_upload_key, document_id, storage_path, uploaded_by
  ) values (
    v_org, v_key, v_document.id, v_document.storage_path, v_actor
  ) on conflict do nothing;

  select registration.document_id, registration.client_upload_key
    into v_registered_document_id, v_registered_key
  from private.document_upload_registrations registration
  where registration.org_id = v_org
    and (
      registration.client_upload_key = v_key
      or registration.document_id = v_document.id
      or registration.storage_path = v_document.storage_path
    )
  order by (registration.client_upload_key = v_key) desc
  limit 1
  for update;

  if not found
     or v_registered_document_id is distinct from v_document.id
     or v_registered_key is distinct from v_key then
    raise exception 'document_upload_key_conflict' using errcode = '23505';
  end if;

  return jsonb_build_object(
    'document_id', v_document.id,
    'storage_path', v_document.storage_path,
    'idempotent', not v_inserted
  );
end
$$;

revoke all on function public.register_uploaded_document(
  text, text, uuid, text, text, text, text, uuid, date
) from public, anon, authenticated, service_role;
grant execute on function public.register_uploaded_document(
  text, text, uuid, text, text, text, text, uuid, date
) to authenticated;

comment on function public.register_uploaded_document(
  text, text, uuid, text, text, text, text, uuid, date
) is 'RLS-bound idempotent registration of an already uploaded document object.';

insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
)
select reviewed.function_signature, md5(replace(proc.prosrc, e'\r', '')),
       'filtered_read', reviewed.scope_proof
from (values (
  'register_uploaded_document(text,text,uuid,text,text,text,text,uuid,date)',
  '0131 derives one auth_org, inserts documents only with unit_id NULL, filters payment evidence '
  'and any recovered legacy document through the canonical null-or-auth_scopes unit predicate.'
)) as reviewed(function_signature, scope_proof)
join pg_catalog.pg_proc proc
  on proc.oid = pg_catalog.to_regprocedure(reviewed.function_signature)
on conflict (function_signature) do update
  set body_hash = excluded.body_hash,
      enforcement_kind = excluded.enforcement_kind,
      scope_proof = excluded.scope_proof;

-- A6: the replay key is transport state, not tenant business data. The registry is private and
-- therefore outside the tenant-business export surface; documents keeps its pinned shape.

-- ===== A1/A3/A5/A6 re-assertion =====
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0131 scope assertions failed:\n%', v_violations;
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations
  from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0131 tenant export assertions failed:\n%', v_violations;
  end if;
end
$$;
