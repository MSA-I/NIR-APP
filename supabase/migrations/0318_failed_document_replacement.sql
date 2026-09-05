-- 0318 -- Re-uploading after a terminal scan failure creates a new document and supersedes the
-- failed one softly. The source bytes are not deleted; financial derivatives are not touched.

create table private.failed_document_replacements (
  org_id uuid not null,
  failed_document_id uuid not null,
  replacement_document_id uuid not null,
  idempotency_key uuid not null,
  actor_id uuid not null,
  reason text not null check (char_length(btrim(reason)) between 1 and 1000),
  created_at timestamptz not null default now(),
  primary key (org_id, failed_document_id),
  unique (org_id, replacement_document_id),
  unique (org_id, idempotency_key),
  foreign key (org_id, failed_document_id) references public.documents(org_id, id),
  foreign key (org_id, replacement_document_id) references public.documents(org_id, id),
  foreign key (org_id, actor_id) references public.profiles(org_id, id),
  check (failed_document_id <> replacement_document_id)
);

create index failed_document_replacements_actor_idx
  on private.failed_document_replacements (org_id, actor_id);

create function private.reject_failed_document_replacement_mutation()
returns trigger language plpgsql set search_path = private, pg_temp as $$
begin
  if tg_op = 'DELETE'
     and current_setting('app.audit_purge', true) = 'organization_teardown' then
    return old;
  end if;
  raise exception 'failed_document_replacement_immutable' using errcode = '55000';
end
$$;
create trigger failed_document_replacements_immutable
before update or delete on private.failed_document_replacements
for each row execute function private.reject_failed_document_replacement_mutation();

revoke all on table private.failed_document_replacements
  from public, anon, authenticated, service_role;
revoke all on function private.reject_failed_document_replacement_mutation()
  from public, anon, authenticated, service_role;

create or replace function public.supersede_failed_document(
  p_failed_document_id uuid,
  p_replacement_document_id uuid,
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
  v_reason text := nullif(btrim(p_reason), '');
  v_existing private.failed_document_replacements;
  v_failed public.documents;
  v_replacement public.documents;
  v_latest_scan_status text;
  v_remove jsonb;
begin
  if v_actor is null or v_org is null or v_role not in ('owner', 'office') then
    raise exception 'failed_document_supersede_not_authorized' using errcode = '42501';
  end if;
  if p_failed_document_id is null or p_replacement_document_id is null
     or p_failed_document_id = p_replacement_document_id
     or p_idempotency_key is null or v_reason is null or length(v_reason) > 1000 then
    raise exception 'failed_document_supersede_invalid' using errcode = '22023';
  end if;
  if private.organization_access_mode(v_org) <> 'active' then
    raise exception 'organization_not_writable' using errcode = '42501';
  end if;

  -- Deterministic order prevents two crossed replacement attempts from deadlocking.
  perform 1 from public.documents document
  where document.org_id = v_org
    and document.id in (p_failed_document_id, p_replacement_document_id)
  order by document.id
  for update;

  -- Read replay state only after the document locks. Two concurrent calls for the same failed
  -- row now serialize here: the second sees the first mapping and returns it instead of observing
  -- the already-soft-deleted source and reporting a false document_not_found.
  select replacement.* into v_existing
  from private.failed_document_replacements replacement
  where replacement.org_id = v_org
    and (replacement.idempotency_key = p_idempotency_key
      or replacement.failed_document_id = p_failed_document_id);
  if found then
    if v_existing.failed_document_id is distinct from p_failed_document_id
       or v_existing.replacement_document_id is distinct from p_replacement_document_id then
      raise exception 'failed_document_supersede_idempotency_conflict' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'failed_document_id', v_existing.failed_document_id,
      'replacement_document_id', v_existing.replacement_document_id,
      'idempotent', true,
      'original_file_retained', true
    );
  end if;

  select document.* into v_failed
  from public.documents document
  where document.org_id = v_org and document.id = p_failed_document_id
    and document.deleted_at is null
    and (document.unit_id is null or document.unit_id = any(public.auth_scopes()));
  if not found then
    raise exception 'document_not_found' using errcode = 'P0002';
  end if;
  select scan.status into v_latest_scan_status
  from public.document_scan_jobs scan
  where scan.org_id = v_org and scan.document_id = v_failed.id
  order by scan.created_at desc, scan.id desc
  limit 1;
  if v_latest_scan_status is distinct from 'failed' then
    raise exception 'failed_document_supersede_source_not_failed' using errcode = '55000';
  end if;

  select document.* into v_replacement
  from public.documents document
  where document.org_id = v_org and document.id = p_replacement_document_id
    and document.deleted_at is null and document.entity_type = 'inbox' and document.entity_id is null
    and (document.unit_id is null or document.unit_id = any(public.auth_scopes()));
  if not found then
    raise exception 'failed_document_supersede_replacement_invalid' using errcode = 'P0002';
  end if;

  -- Reuse the canonical soft-removal command. `document_only` preserves every derived record and
  -- never deletes Storage bytes; its return makes that guarantee executable below.
  v_remove := public.remove_document(p_failed_document_id, 'document_only', v_reason);
  if not coalesce((v_remove ->> 'original_file_retained')::boolean, false) then
    raise exception 'failed_document_supersede_source_retention_failed' using errcode = '55000';
  end if;

  insert into private.failed_document_replacements (
    org_id, failed_document_id, replacement_document_id,
    idempotency_key, actor_id, reason
  ) values (
    v_org, p_failed_document_id, p_replacement_document_id,
    p_idempotency_key, v_actor, v_reason
  );

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_actor, 'document_superseded', 'documents', p_failed_document_id,
    jsonb_build_object('failed_document_id', p_failed_document_id),
    jsonb_build_object(
      'replacement_document_id', p_replacement_document_id,
      'original_file_retained', true,
      'soft_deleted', true
    ),
    v_reason
  );

  return jsonb_build_object(
    'failed_document_id', p_failed_document_id,
    'replacement_document_id', p_replacement_document_id,
    'idempotent', false,
    'original_file_retained', true
  );
end
$$;

revoke all on function public.supersede_failed_document(uuid,uuid,uuid,text)
  from public, anon;
grant execute on function public.supersede_failed_document(uuid,uuid,uuid,text)
  to authenticated;

comment on function public.supersede_failed_document(uuid,uuid,uuid,text) is
  'Softly supersedes a document whose scan failed with a newly uploaded inbox document. Owner or '
  'office only; tenant and unit scope are re-read for both rows; source bytes and derived records '
  'remain; source disappears from active lists; source/replacement/key replay returns one result; '
  'audit carries the human reason.';

insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
)
select p.oid::regprocedure::text,
       md5(replace(p.prosrc, e'\r', '')),
       'assert_unit',
       '0318 derives org and actor from the session, permits owner or office only, locks both '
       || 'documents in deterministic order and re-reads each by org_id, deleted_at and '
       || 'auth_scopes() before delegating to canonical soft removal.'
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'supersede_failed_document'
on conflict (function_signature) do update
set body_hash = excluded.body_hash,
    enforcement_kind = excluded.enforcement_kind,
    scope_proof = excluded.scope_proof;

do $$
declare
  v_body text := replace(pg_get_functiondef(
    'public.supersede_failed_document(uuid,uuid,uuid,text)'::regprocedure), e'\r', '');
  v_guard text := replace(pg_get_functiondef(
    'private.reject_failed_document_replacement_mutation()'::regprocedure), e'\r', '');
begin
  if position('public.auth_scopes()' in v_body) = 0
     or position('public.remove_document' in v_body) = 0
     or position('original_file_retained' in v_body) = 0
     or position('p_idempotency_key' in v_body) = 0
     or position('order by scan.created_at desc, scan.id desc' in v_body) = 0
     or position('organization_teardown' in v_guard) = 0 then
    raise exception '0318: supersede contract lost scope, latest failed state, soft retention or replay';
  end if;
  if has_function_privilege('anon',
       'public.supersede_failed_document(uuid,uuid,uuid,text)', 'execute') then
    raise exception '0318: anon can supersede a document';
  end if;
end
$$;

do $assert_scope$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0318 scope failed:\n%', v_violations;
  end if;
end
$assert_scope$;
