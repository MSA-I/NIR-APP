-- 0317 -- The review screen accepts one human sentence about the document, not annotation and
-- learning-rule administration. The old ledgers remain immutable history; this new contract does
-- not write to them and is not a replacement operations console (owner rulings #373-#374).

create table public.document_review_feedback (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  document_id uuid not null,
  interpretation_id uuid not null,
  extraction_id uuid not null,
  actor_id uuid not null,
  idempotency_key uuid not null,
  note text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  constraint document_review_feedback_note_length
    check (char_length(btrim(note)) between 1 and 1500),
  constraint document_review_feedback_reason_length
    check (char_length(btrim(reason)) between 1 and 1000),
  constraint document_review_feedback_idempotency
    unique (org_id, idempotency_key),
  constraint document_review_feedback_one_per_actor
    unique (org_id, interpretation_id, actor_id),
  constraint document_review_feedback_document_fk
    foreign key (org_id, document_id)
    references public.documents(org_id, id) on delete restrict,
  constraint document_review_feedback_interpretation_fk
    foreign key (org_id, interpretation_id, extraction_id, document_id)
    references public.document_interpretations(org_id, id, extraction_id, document_id) on delete restrict,
  constraint document_review_feedback_actor_fk
    foreign key (org_id, actor_id)
    references public.profiles(org_id, id) on delete restrict
);

create index document_review_feedback_document_idx
  on public.document_review_feedback (org_id, document_id, created_at desc);

comment on table public.document_review_feedback is
  'One immutable human note per actor and document interpretation. It is the customer-facing '
  '"this is not correct" record and does not mutate annotations or learning rules.';

create trigger document_review_feedback_immutable
before update or delete on public.document_review_feedback
for each row execute function public.reject_document_learning_ledger_mutation();

create trigger document_review_feedback_audit
after insert on public.document_review_feedback
for each row execute function public.audit_row_change();

alter table public.document_review_feedback enable row level security;
alter table public.document_review_feedback force row level security;

create policy document_review_feedback_select_own
on public.document_review_feedback
for select to authenticated
using (
  org_id = public.auth_org()
  and actor_id = auth.uid()
  and public.auth_role() in ('owner', 'office')
);

revoke all on table public.document_review_feedback from public, anon, authenticated, service_role;
grant select on table public.document_review_feedback to authenticated;

insert into private.scope_registry (table_name, scope_class, enforced)
values ('document_review_feedback', 'org_global', false)
on conflict (table_name) do update
set scope_class = excluded.scope_class, enforced = excluded.enforced;

insert into private.tenant_export_registry (
  table_name, disposition, excluded_columns, rationale
) values (
  'document_review_feedback', 'include', '{}',
  'The tenant-authored document review note, its source interpretation, actor, reason and time.'
)
on conflict (table_name) do update set
  disposition = excluded.disposition,
  excluded_columns = excluded.excluded_columns,
  rationale = excluded.rationale;

update private.tenant_export_registry registry
set exported_columns = (
      select array_agg(column_info.column_name order by column_info.ordinal_position)
      from information_schema.columns column_info
      where column_info.table_schema = 'public' and column_info.table_name = registry.table_name
        and not (column_info.column_name = any(registry.excluded_columns))
    ),
    schema_hash = (
      select md5(string_agg(
        column_info.column_name || ':' || column_info.data_type || ':' || column_info.is_nullable,
        '|' order by column_info.ordinal_position))
      from information_schema.columns column_info
      where column_info.table_schema = 'public' and column_info.table_name = registry.table_name
    )
where registry.table_name = 'document_review_feedback';

insert into private.audit_scope_taxonomy (entity_type, scope_domain, resolver, rationale)
values (
  'document_review_feedback', 'organization_identity_platform', 'cross_scope',
  'Document-level feedback belongs to the tenant-wide review record, like document_feedback.'
)
on conflict (entity_type) do update
set scope_domain = excluded.scope_domain,
    resolver = excluded.resolver,
    rationale = excluded.rationale;

create function public.add_document_review_feedback(
  p_document_id uuid,
  p_interpretation_id uuid,
  p_note text,
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
  v_note text := nullif(btrim(p_note), '');
  v_reason text := nullif(btrim(p_reason), '');
  v_existing public.document_review_feedback;
  v_feedback public.document_review_feedback;
  v_interpretation public.document_interpretations;
begin
  if v_actor is null or v_org is null or v_role not in ('owner', 'office') then
    raise exception 'document_review_feedback_not_authorized' using errcode = '42501';
  end if;
  if p_document_id is null or p_interpretation_id is null or p_idempotency_key is null
     or v_note is null or char_length(v_note) > 1500
     or v_reason is null or char_length(v_reason) > 1000 then
    raise exception 'document_review_feedback_invalid' using errcode = '22023';
  end if;
  if private.organization_access_mode(v_org) <> 'active' then
    raise exception 'organization_not_writable' using errcode = '42501';
  end if;

  select feedback.* into v_existing
  from public.document_review_feedback feedback
  where feedback.org_id = v_org and feedback.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.document_id is distinct from p_document_id
       or v_existing.interpretation_id is distinct from p_interpretation_id
       or v_existing.note is distinct from v_note
       or v_existing.reason is distinct from v_reason then
      raise exception 'document_review_feedback_idempotency_conflict' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'feedback_id', v_existing.id, 'idempotent', true, 'already_recorded', true);
  end if;

  -- The same scope check as the review read. Another tenant, a deleted document and an excluded
  -- unit are deliberately indistinguishable.
  if not exists (
    select 1 from public.documents document
    where document.org_id = v_org and document.id = p_document_id
      and document.deleted_at is null
      and (document.unit_id is null or document.unit_id = any(public.auth_scopes()))
  ) then
    raise exception 'document_not_found' using errcode = 'P0002';
  end if;
  select interpretation.* into v_interpretation
    from public.document_interpretations interpretation
    where interpretation.org_id = v_org and interpretation.id = p_interpretation_id
      and interpretation.document_id = p_document_id;
  if not found then
    raise exception 'document_interpretation_unknown' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'document-review-feedback:' || v_org::text || ':' || p_interpretation_id::text
      || ':' || v_actor::text, 0));

  select feedback.* into v_existing
  from public.document_review_feedback feedback
  where feedback.org_id = v_org
    and feedback.interpretation_id = p_interpretation_id
    and feedback.actor_id = v_actor;
  if found then
    if v_existing.note is distinct from v_note then
      raise exception 'document_review_feedback_already_recorded' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'feedback_id', v_existing.id, 'idempotent', true, 'already_recorded', true);
  end if;

  perform set_config('app.audit_reason', v_reason, true);
  insert into public.document_review_feedback (
    org_id, document_id, interpretation_id, extraction_id, actor_id,
    idempotency_key, note, reason
  ) values (
    v_org, p_document_id, p_interpretation_id, v_interpretation.extraction_id, v_actor,
    p_idempotency_key, v_note, v_reason
  ) returning * into v_feedback;

  return jsonb_build_object(
    'feedback_id', v_feedback.id, 'idempotent', false, 'already_recorded', false);
end
$$;

revoke all on function public.add_document_review_feedback(uuid,uuid,text,uuid,text)
  from public, anon;
grant execute on function public.add_document_review_feedback(uuid,uuid,text,uuid,text)
  to authenticated;

comment on function public.add_document_review_feedback(uuid,uuid,text,uuid,text) is
  'Stores one immutable document-level feedback note for the signed-in owner or office user. '
  'Derives tenant and actor, re-reads document scope and interpretation, serialises one note per '
  'actor and interpretation, replays by idempotency key, and audits p_reason.';

insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
)
select p.oid::regprocedure::text,
       md5(replace(p.prosrc, e'\r', '')),
       'assert_unit',
       '0317 derives org and actor from the session, permits owner or office only, re-reads the '
       || 'document under org_id, deleted_at and auth_scopes(), and binds the interpretation to '
       || 'that same document before inserting one org-global feedback row.'
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'add_document_review_feedback'
on conflict (function_signature) do update
set body_hash = excluded.body_hash,
    enforcement_kind = excluded.enforcement_kind,
    scope_proof = excluded.scope_proof;

do $$
declare
  v_body text := replace(pg_get_functiondef(
    'public.add_document_review_feedback(uuid,uuid,text,uuid,text)'::regprocedure), e'\r', '');
begin
  if position('document.unit_id is null or document.unit_id = any(public.auth_scopes())' in v_body) = 0
     or position('p_idempotency_key' in v_body) = 0
     or position('app.audit_reason' in v_body) = 0 then
    raise exception '0317: feedback command lost scope, replay, or reason';
  end if;
  if has_function_privilege('anon',
       'public.add_document_review_feedback(uuid,uuid,text,uuid,text)', 'execute')
     or has_table_privilege('authenticated', 'public.document_review_feedback', 'insert')
     or has_table_privilege('authenticated', 'public.document_review_feedback', 'update')
     or has_table_privilege('authenticated', 'public.document_review_feedback', 'delete') then
    raise exception '0317: feedback write boundary is open';
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
    raise exception e'0317 scope failed:\n%', v_violations;
  end if;
end
$assert_scope$;
