-- 0178 -- #233: historical entity-to-document-kind resolution with explicit provenance.
--
-- Precedence is fixed and visible in one read model:
-- human_review, verified_interpretation, existing_kind, entity_inference, fallback_other.
-- The entity map is an allowlist: invoice/invoice and goods_receipt/delivery_note only.
-- Nothing is backfilled by this migration. A reasoned command applies one preview row and records
-- the source; Production execution remains a separately authorized operation.

create table public.document_kind_resolution_history (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  document_id uuid not null,
  idempotency_key uuid not null,
  actor_id uuid not null,
  old_kind text not null,
  new_kind text not null,
  source_type text not null check (source_type in (
    'human_review', 'verified_interpretation', 'existing_kind', 'entity_inference', 'fallback_other'
  )),
  source_rank smallint not null check (source_rank between 1 and 5),
  source_id uuid,
  entity_type text not null,
  reason text not null check (length(btrim(reason)) between 1 and 1000),
  created_at timestamptz not null default now(),
  constraint document_kind_resolution_history_org_id_id_key unique (org_id, id),
  constraint document_kind_resolution_history_idempotency_key unique (org_id, idempotency_key),
  constraint document_kind_resolution_history_document_fk foreign key (org_id, document_id)
    references public.documents(org_id, id) on delete restrict,
  constraint document_kind_resolution_history_actor_fk foreign key (org_id, actor_id)
    references public.profiles(org_id, id) on delete restrict,
  constraint document_kind_resolution_history_source_shape check (
    (source_type in ('human_review', 'verified_interpretation') and source_id is not null)
    or (source_type in ('existing_kind', 'entity_inference', 'fallback_other') and source_id is null)
  )
);

create trigger document_kind_resolution_history_immutable before update or delete
  on public.document_kind_resolution_history for each row
  execute function public.reject_document_learning_ledger_mutation();
alter table public.document_kind_resolution_history enable row level security;
alter table public.document_kind_resolution_history force row level security;
revoke all on table public.document_kind_resolution_history from public, anon, authenticated;
-- Full CRUD for the same reason 0177 states at length: the immutability trigger above rejects every
-- UPDATE and DELETE regardless of grant, so the ACL is not the guard here, and p0_client_dml_acl.sql
-- reserves its write-exception list for ledgers whose INSERT is closed at the trigger as well.
grant select, insert, update, delete on table public.document_kind_resolution_history to service_role;

create function public.get_document_kind_history_preview()
returns table (
  document_id uuid,
  current_kind text,
  proposed_kind text,
  source_type text,
  source_rank smallint,
  source_id uuid,
  source_at timestamptz,
  entity_type text,
  would_change boolean,
  reason_code text
)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
begin
  if v_org is null or auth_role() not in ('owner', 'office') then
    raise exception 'document_kind_history_not_authorized' using errcode = '42501';
  end if;
  return query
  with latest_human as (
    select distinct on (decision.org_id, decision.document_id)
      decision.org_id, decision.document_id, decision.id, decision.approved_document_type,
      decision.created_at
    from public.document_type_review_decisions decision
    where decision.org_id = v_org and decision.decision = 'approved'
      and decision.approved_document_type is not null
    order by decision.org_id, decision.document_id, decision.revision desc,
      decision.created_at desc, decision.id desc
  ), latest_verified_interpretation as (
    select distinct on (interpretation.org_id, interpretation.document_id)
      interpretation.org_id, interpretation.document_id, interpretation.id,
      interpretation.payload ->> 'document_type' as document_type,
      interpretation.created_at
    from public.document_interpretations interpretation
    join public.document_processing_jobs job
      on job.org_id = interpretation.org_id and job.id = interpretation.job_id
      and job.document_id = interpretation.document_id
    where interpretation.org_id = v_org and job.status in ('review', 'completed')
    order by interpretation.org_id, interpretation.document_id,
      interpretation.created_at desc, interpretation.id desc
  ), resolved as (
    select document.id as document_id, document.document_kind as current_kind,
      -- ALLOWLIST, NOT A PASS-THROUGH -- on both evidence branches, for the same reason the entity
      -- branch below is one. `documents.document_kind` and the interpretation/review vocabulary are
      -- two different closed domains that happen to overlap, and the second one has already been
      -- widened once without the first (0104 added `tax_receipt` to the contract AND to the CHECK,
      -- so today every value maps). `else <stored value>` bets that this stays true. The next value
      -- added to `smart_document_interpretation_valid` or to `approved_document_type` would surface
      -- here as a preview row with `would_change = true` and an `apply` that dies with 23514
      -- check_violation -- a raw Postgres error on a document a person just approved -- instead of
      -- a named refusal. Naming the seven pairs makes an unknown type resolve to `other`, which the
      -- CHECK can always store, exactly as `payment`/`supplier`/`inbox`/`archive` do (#233).
      -- P66 pins this against the LIVE constraint and the LIVE contract rather than against a copy.
      case
        when human.id is not null then case human.approved_document_type
          when 'invoice' then 'invoice'
          when 'delivery_note' then 'delivery_note'
          when 'credit_note' then 'credit'
          when 'price_list' then 'price_list'
          when 'quote' then 'quote'
          when 'payment_confirmation' then 'payment_confirmation'
          when 'tax_receipt' then 'tax_receipt'
          else 'other'
        end
        when verified.id is not null then case verified.document_type
          when 'invoice' then 'invoice'
          when 'delivery_note' then 'delivery_note'
          when 'credit_note' then 'credit'
          when 'price_list' then 'price_list'
          when 'quote' then 'quote'
          when 'payment_confirmation' then 'payment_confirmation'
          when 'tax_receipt' then 'tax_receipt'
          else 'other'
        end
        when document.document_kind <> 'other' then document.document_kind
        else case document.entity_type
          when 'invoice' then 'invoice'
          when 'goods_receipt' then 'delivery_note'
          else 'other'
        end
      end as proposed_kind,
      case
        when human.id is not null then 'human_review'
        when verified.id is not null then 'verified_interpretation'
        when document.document_kind <> 'other' then 'existing_kind'
        when document.entity_type in ('invoice', 'goods_receipt') then 'entity_inference'
        else 'fallback_other'
      end as source_type,
      case
        when human.id is not null then 1
        when verified.id is not null then 2
        when document.document_kind <> 'other' then 3
        when document.entity_type in ('invoice', 'goods_receipt') then 4
        else 5
      end::smallint as source_rank,
      case when human.id is not null then human.id
           when verified.id is not null then verified.id else null end as source_id,
      case when human.id is not null then human.created_at
           when verified.id is not null then verified.created_at else document.created_at end as source_at,
      document.entity_type
    from public.documents document
    left join latest_human human
      on human.org_id = document.org_id and human.document_id = document.id
    left join latest_verified_interpretation verified
      on verified.org_id = document.org_id and verified.document_id = document.id
    where document.org_id = v_org and document.deleted_at is null
      and (document.unit_id is null or document.unit_id = any(public.auth_scopes()))
  )
  select resolved.document_id, resolved.current_kind, resolved.proposed_kind,
    resolved.source_type, resolved.source_rank, resolved.source_id, resolved.source_at,
    resolved.entity_type, resolved.current_kind is distinct from resolved.proposed_kind,
    case when resolved.current_kind is distinct from resolved.proposed_kind then 'would_update'
         else 'already_resolved' end
  from resolved
  order by resolved.source_rank, resolved.document_id;
end $$;

revoke all on function public.get_document_kind_history_preview() from public, anon, service_role;
grant execute on function public.get_document_kind_history_preview() to authenticated;

create function public.apply_document_kind_history(
  p_document_id uuid,
  p_expected_current_kind text,
  p_expected_source_type text,
  p_idempotency_key uuid,
  p_reason text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_preview record;
  v_document public.documents;
  v_existing public.document_kind_resolution_history;
  v_history_id uuid := gen_random_uuid();
begin
  if v_org is null or v_actor is null or auth_role() not in ('owner', 'office') then
    raise exception 'document_kind_history_not_authorized' using errcode = '42501';
  end if;
  if p_document_id is null or p_idempotency_key is null or v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select history.* into v_existing from public.document_kind_resolution_history history
  where history.org_id = v_org and history.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.document_id is distinct from p_document_id
       or v_existing.old_kind is distinct from p_expected_current_kind
       or v_existing.source_type is distinct from p_expected_source_type
       or v_existing.reason is distinct from v_reason then
      raise exception 'document_kind_history_idempotency_conflict' using errcode = '55000';
    end if;
    return jsonb_build_object('document_id', v_existing.document_id,
      'new_kind', v_existing.new_kind, 'idempotent', true);
  end if;

  select * into v_preview from public.get_document_kind_history_preview() preview
  where preview.document_id = p_document_id;
  if not found then raise exception 'document_unknown' using errcode = 'P0002'; end if;
  if v_preview.current_kind is distinct from p_expected_current_kind
     or v_preview.source_type is distinct from p_expected_source_type then
    raise exception 'document_kind_history_context_changed' using errcode = '55000';
  end if;
  if not v_preview.would_change then
    raise exception 'document_kind_history_unchanged' using errcode = '22023';
  end if;

  select document.* into v_document from public.documents document
  where document.org_id = v_org and document.id = p_document_id
    and (document.unit_id is null or document.unit_id = any(public.auth_scopes()))
  for update;
  if not found or v_document.document_kind is distinct from v_preview.current_kind then
    raise exception 'document_kind_history_context_changed' using errcode = '55000';
  end if;
  update public.documents set document_kind = v_preview.proposed_kind
  where org_id = v_org and id = p_document_id;
  insert into public.document_kind_resolution_history (
    id, org_id, document_id, idempotency_key, actor_id, old_kind, new_kind,
    source_type, source_rank, source_id, entity_type, reason
  ) values (
    v_history_id, v_org, p_document_id, p_idempotency_key, v_actor,
    v_preview.current_kind, v_preview.proposed_kind, v_preview.source_type,
    v_preview.source_rank, v_preview.source_id, v_preview.entity_type, v_reason
  );
  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_actor, 'document_kind_resolved_from_history', 'documents', p_document_id,
    jsonb_build_object('document_kind', v_preview.current_kind),
    jsonb_build_object('document_kind', v_preview.proposed_kind,
      'source_type', v_preview.source_type, 'source_rank', v_preview.source_rank,
      'source_id', v_preview.source_id, 'entity_type', v_preview.entity_type),
    v_reason
  );
  return jsonb_build_object('document_id', p_document_id,
    'new_kind', v_preview.proposed_kind, 'history_id', v_history_id, 'idempotent', false);
end $$;

revoke all on function public.apply_document_kind_history(uuid, text, text, uuid, text)
  from public, anon, service_role;
grant execute on function public.apply_document_kind_history(uuid, text, text, uuid, text)
  to authenticated;

insert into private.scope_registry (table_name, scope_class, enforced)
values ('document_kind_resolution_history', 'org_global', false);
insert into private.tenant_export_registry (table_name, disposition, excluded_columns, rationale)
values ('document_kind_resolution_history', 'include', '{}',
  'Reasoned historical document-kind decisions with their precedence source and actor.')
on conflict (table_name) do update set disposition = excluded.disposition,
  excluded_columns = excluded.excluded_columns, rationale = excluded.rationale;
update private.tenant_export_registry registry
set exported_columns = (select array_agg(c.column_name order by c.ordinal_position)
      from information_schema.columns c where c.table_schema = 'public'
        and c.table_name = registry.table_name and not (c.column_name = any(registry.excluded_columns))),
    schema_hash = (select md5(string_agg(c.column_name || ':' || c.data_type || ':' || c.is_nullable,
      '|' order by c.ordinal_position)) from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = registry.table_name)
where registry.table_name = 'document_kind_resolution_history';

insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
)
select reviewed.signature, md5(replace(proc.prosrc, e'\r', '')), 'filtered_read', reviewed.proof
from (values
  ('get_document_kind_history_preview()',
   '0178 returns only non-deleted auth_org documents whose unit is null or present in auth_scopes; every joined review and interpretation is tenant-bound through the document chain.'),
  ('apply_document_kind_history(uuid,text,text,uuid,text)',
   '0178 resolves through the same auth_org plus null-or-auth_scopes preview, then locks the exact document with the same unit predicate before the reasoned write.')
) reviewed(signature, proof)
join pg_catalog.pg_proc proc on proc.oid = pg_catalog.to_regprocedure(reviewed.signature)
on conflict (function_signature) do update set body_hash = excluded.body_hash,
  enforcement_kind = excluded.enforcement_kind, scope_proof = excluded.scope_proof;

do $$
declare v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then raise exception e'0178 scope assertions failed:\n%', v_violations; end if;
  select string_agg(detail, e'\n' order by detail) into v_violations
    from private.tenant_export_registry_violations();
  if v_violations is not null then raise exception e'0178 export assertions failed:\n%', v_violations; end if;
end $$;
