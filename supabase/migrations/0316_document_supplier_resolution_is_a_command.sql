-- 0316 -- A document with no supplier gets one human decision, not a dead end.
--
-- The browser used to insert suppliers directly. The generic supplier audit trigger therefore
-- wrote a row whose reason was always null, and a dropped response could create the same supplier
-- twice. The command below derives the tenant from the signed-in actor, optionally proves the
-- document belongs to that tenant and unit scope, serialises a stable idempotency key, and gives
-- the existing audit trigger the reason for this transaction.
--
-- The folder read is deliberately batched. It answers only the exceptional state this package
-- adds to the list: an interpreted document whose supplier resolver still has no single answer.
-- Resolved documents return no row. That keeps the list read cheap and avoids calling the full
-- assessment RPC once per document.

-- ===== 1. The existing row audit can carry a command reason =====

create or replace function public.audit_row_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_org uuid := nullif(v_row ->> 'org_id', '')::uuid;
  v_actor uuid := auth.uid();
  v_reason text := nullif(btrim(current_setting('app.audit_reason', true)), '');
begin
  if v_org is null then
    raise exception 'audit_source_missing_org: %', tg_table_name;
  end if;
  if v_actor is not null and v_org is distinct from auth_org()
     and not is_platform_admin() then
    raise exception 'audit_source_org_mismatch: %', tg_table_name using errcode = '42501';
  end if;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org,
    v_actor,
    lower(tg_op),
    tg_table_name,
    nullif(v_row ->> 'id', '')::uuid,
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end,
    v_reason
  );

  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

-- ===== 2. Immutable replay ledger =====

create table private.document_supplier_creation_commands (
  org_id uuid not null,
  idempotency_key uuid not null,
  supplier_id uuid not null,
  document_id uuid,
  actor_id uuid not null,
  supplier_name text not null check (nullif(btrim(supplier_name), '') is not null),
  tax_id text,
  reason text not null check (nullif(btrim(reason), '') is not null),
  created_at timestamptz not null default now(),
  primary key (org_id, idempotency_key),
  unique (org_id, supplier_id),
  foreign key (org_id, supplier_id) references public.suppliers(org_id, id),
  foreign key (org_id, document_id) references public.documents(org_id, id),
  foreign key (org_id, actor_id) references public.profiles(org_id, id)
);

create function private.reject_document_supplier_creation_command_mutation()
returns trigger
language plpgsql
set search_path = private, pg_temp
as $$
begin
  if tg_op = 'DELETE'
     and current_setting('app.audit_purge', true) = 'organization_teardown' then
    return old;
  end if;
  raise exception 'document_supplier_creation_command_immutable' using errcode = '55000';
end
$$;

create trigger document_supplier_creation_commands_immutable
before update or delete on private.document_supplier_creation_commands
for each row execute function private.reject_document_supplier_creation_command_mutation();

revoke all on table private.document_supplier_creation_commands
  from public, anon, authenticated, service_role;
revoke all on function private.reject_document_supplier_creation_command_mutation()
  from public, anon, authenticated, service_role;

-- ===== 3. Tenant-derived, reasoned and idempotent supplier creation =====

create function public.create_supplier_from_document(
  p_document_id uuid,
  p_name text,
  p_tax_id text,
  p_idempotency_key uuid,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_org uuid := public.auth_org();
  v_actor uuid := auth.uid();
  v_role public.user_role := public.auth_role();
  v_name text := nullif(btrim(p_name), '');
  v_tax_id text := nullif(btrim(p_tax_id), '');
  v_reason text := nullif(btrim(p_reason), '');
  v_existing private.document_supplier_creation_commands;
  v_supplier public.suppliers;
begin
  if v_actor is null or v_org is null or v_role not in ('owner', 'office') then
    raise exception 'supplier_create_not_authorized' using errcode = '42501';
  end if;
  if v_name is null or p_idempotency_key is null or v_reason is null
     or length(v_reason) > 1000 then
    raise exception 'supplier_create_invalid' using errcode = '22023';
  end if;

  if p_document_id is not null and not exists (
    select 1 from public.documents document
    where document.org_id = v_org and document.id = p_document_id
      and document.deleted_at is null
      and (document.unit_id is null or document.unit_id = any(public.auth_scopes()))
  ) then
    raise exception 'document_not_found' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'document-supplier-create:' || v_org::text || ':' || p_idempotency_key::text, 0));

  select command.* into v_existing
  from private.document_supplier_creation_commands command
  where command.org_id = v_org and command.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.document_id is distinct from p_document_id
       or v_existing.supplier_name is distinct from v_name
       or v_existing.tax_id is distinct from v_tax_id then
      raise exception 'supplier_create_idempotency_conflict' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'supplier_id', v_existing.supplier_id,
      'name', v_existing.supplier_name,
      'idempotent', true
    );
  end if;

  -- LOCAL to this transaction. Pooled connections never inherit the previous command's reason.
  perform set_config('app.audit_reason', v_reason, true);
  insert into public.suppliers (org_id, name, tax_id)
  values (v_org, v_name, v_tax_id)
  returning * into v_supplier;

  insert into private.document_supplier_creation_commands (
    org_id, idempotency_key, supplier_id, document_id, actor_id,
    supplier_name, tax_id, reason
  ) values (
    v_org, p_idempotency_key, v_supplier.id, p_document_id, v_actor,
    v_supplier.name, v_supplier.tax_id, v_reason
  );

  return jsonb_build_object(
    'supplier_id', v_supplier.id,
    'name', v_supplier.name,
    'idempotent', false
  );
end
$$;

revoke all on function public.create_supplier_from_document(uuid,text,text,uuid,text)
  from public, anon;
grant execute on function public.create_supplier_from_document(uuid,text,text,uuid,text)
  to authenticated;

comment on function public.create_supplier_from_document(uuid,text,text,uuid,text) is
  'Creates the supplier a human selected while resolving a document. Tenant and actor come from '
  'the session; an optional document is re-read under auth_scopes(); owner or office only; a '
  'stable idempotency key returns the first supplier; the suppliers audit row carries p_reason.';

-- ===== 4. One folder read for every visible document id =====

create function public.get_document_folder_review_states(p_document_ids uuid[])
returns table (
  document_id uuid,
  state text,
  suggested_supplier_name text
)
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_org uuid := public.auth_org();
  v_role public.user_role := public.auth_role();
begin
  if auth.uid() is null or v_org is null
     or v_role not in ('owner', 'office', 'kitchen', 'accountant') then
    raise exception 'document_folder_review_read_not_authorized' using errcode = '42501';
  end if;
  if p_document_ids is null or cardinality(p_document_ids) = 0 then
    return;
  end if;
  if cardinality(p_document_ids) > 200 then
    raise exception 'document_folder_review_read_too_many_ids' using errcode = '22023';
  end if;

  return query
  select document.id,
         'supplier_unresolved'::text,
         nullif(btrim(interpretation.payload #>> '{supplier,suggested_name}'), '')
  from public.documents document
  join lateral (
    select candidate.payload
    from public.document_interpretations candidate
    where candidate.org_id = v_org and candidate.document_id = document.id
    order by candidate.created_at desc, candidate.id desc
    limit 1
  ) interpretation on true
  cross join lateral private.resolve_document_supplier(
    v_org, document.id, interpretation.payload
  ) resolution
  where document.org_id = v_org
    and document.id = any(p_document_ids)
    and document.deleted_at is null
    and (document.unit_id is null or document.unit_id = any(public.auth_scopes()))
    and not coalesce((resolution ->> 'resolved')::boolean, false)
  order by document.id;
end
$$;

revoke all on function public.get_document_folder_review_states(uuid[])
  from public, anon;
grant execute on function public.get_document_folder_review_states(uuid[])
  to authenticated;

comment on function public.get_document_folder_review_states(uuid[]) is
  'Batched folder read for at most 200 requested documents. Returns only interpreted, visible '
  'documents whose canonical supplier resolver is unresolved, plus the name read from the page. '
  'Filters auth_org() and auth_scopes() inside the definer and writes nothing.';

-- The review screen already reads the resolver through get_document_review_assessment. Add the
-- raw printed name to that resolver result so the screen can distinguish machine text from the
-- supplier a human selects; do not create a second per-document read.
do $$
declare
  v_definition text := replace(pg_get_functiondef(
    'private.resolve_document_supplier(uuid,uuid,jsonb)'::regprocedure), e'\r', '');
  v_anchor text := '''candidates'', v_matches || v_advisory';
  v_replacement text := '''suggested_name'', nullif(btrim(p_payload #>> ''{supplier,suggested_name}''), ''''), '
    || v_anchor;
  v_count integer;
begin
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, '')))
    / length(v_anchor);
  if v_count <> 1 then
    raise exception '0316: supplier suggested-name return anchor count %', v_count;
  end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$$;

-- ===== 5. Definer inventory and executable anchors =====

insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
)
select p.oid::regprocedure::text,
       md5(replace(p.prosrc, e'\r', '')),
       case when p.proname = 'get_document_folder_review_states'
            then 'filtered_read' else 'assert_unit' end,
       case when p.proname = 'get_document_folder_review_states'
            then '0316 derives org from auth_org(), refuses unknown roles, caps the request, and '
              || 'filters every document by org_id, deleted_at and auth_scopes() before returning.'
            else '0316 derives org and actor from the session, allows owner or office only, and '
              || 're-reads a supplied document by org_id, deleted_at and auth_scopes() before '
              || 'writing an organization-wide supplier.' end
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('create_supplier_from_document', 'get_document_folder_review_states')
on conflict (function_signature) do update
set body_hash = excluded.body_hash,
    enforcement_kind = excluded.enforcement_kind,
    scope_proof = excluded.scope_proof;

do $$
declare
  v_audit text := replace(
    pg_get_functiondef('public.audit_row_change()'::regprocedure), e'\r', '');
  v_create text := replace(pg_get_functiondef(
    'public.create_supplier_from_document(uuid,text,text,uuid,text)'::regprocedure), e'\r', '');
  v_read text := replace(pg_get_functiondef(
    'public.get_document_folder_review_states(uuid[])'::regprocedure), e'\r', '');
  v_guard text := replace(pg_get_functiondef(
    'private.reject_document_supplier_creation_command_mutation()'::regprocedure), e'\r', '');
begin
  if position('app.audit_reason' in v_audit) = 0
     or position('p_idempotency_key' in v_create) = 0
     or position('document.unit_id is null or document.unit_id = any(public.auth_scopes())' in v_create) = 0
     or position('cardinality(p_document_ids) > 200' in v_read) = 0
     or position('private.resolve_document_supplier' in v_read) = 0
     or position('organization_teardown' in v_guard) = 0 then
    raise exception '0316: supplier resolution contract anchor missing';
  end if;
  if has_function_privilege('anon',
       'public.create_supplier_from_document(uuid,text,text,uuid,text)', 'execute')
     or has_function_privilege('anon',
       'public.get_document_folder_review_states(uuid[])', 'execute') then
    raise exception '0316: anon can reach a document supplier contract';
  end if;
end
$$;

-- The standing post-0057 scope assertion. New definer functions and a new org_id ledger must not
-- enter the catalog without satisfying the same A1/A3/A5 inventory as every existing object.
do $assert_scope$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0316 scope failed:\n%', v_violations;
  end if;
end
$assert_scope$;
