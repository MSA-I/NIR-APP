-- Forward-only review mutations for PLAN-05.
-- Immutable extraction and interpretation payloads remain untouched; corrections are append-only overlays.

create table public.document_review_corrections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  interpretation_id uuid not null,
  extraction_id uuid not null,
  document_id uuid not null,
  target_kind text not null check (target_kind in ('block', 'table_cell')),
  target_id text not null check (length(trim(target_id)) between 1 and 500),
  row_index integer,
  column_index integer,
  revision integer not null check (revision > 0),
  input_checksum text not null check (
    input_checksum ~ '^etag:[0-9a-fA-F]{16,128}(-[0-9]+)?$'
  ),
  contract_version text not null check (contract_version = '1'),
  original_text text not null check (length(original_text) <= 2000000),
  before_text text not null check (length(before_text) <= 2000000),
  corrected_text text not null check (length(corrected_text) <= 2000000),
  actor_id uuid not null,
  reason text not null check (length(trim(reason)) between 1 and 1000),
  created_at timestamptz not null default now(),
  constraint document_review_corrections_org_id_id_key unique (org_id, id),
  constraint document_review_corrections_context_fk
    foreign key (org_id, interpretation_id, extraction_id, document_id)
    references public.document_interpretations(org_id, id, extraction_id, document_id)
    on delete restrict,
  constraint document_review_corrections_actor_tenant_fk
    foreign key (org_id, actor_id)
    references public.profiles(org_id, id) on delete restrict,
  constraint document_review_corrections_target_shape check (
    (target_kind = 'block' and row_index is null and column_index is null)
    or (
      target_kind = 'table_cell'
      and row_index is not null and row_index >= 0
      and column_index is not null and column_index >= 0
    )
  ),
  constraint document_review_corrections_changes_text check (before_text <> corrected_text)
);

create unique index document_review_corrections_revision_key
  on public.document_review_corrections (
    org_id,
    interpretation_id,
    target_kind,
    target_id,
    coalesce(row_index, -1),
    coalesce(column_index, -1),
    revision
  );
create index document_review_corrections_document_idx
  on public.document_review_corrections (org_id, document_id, created_at desc);

create trigger document_review_corrections_immutable_trg
  before update or delete on public.document_review_corrections
  for each row execute function public.reject_document_learning_ledger_mutation();

alter table public.document_review_corrections enable row level security;
alter table public.document_review_corrections force row level security;

create policy document_review_corrections_select on public.document_review_corrections
  for select to authenticated using (
    org_id = auth_org() and auth_role() in ('owner', 'office', 'kitchen')
  );
create policy supplier_price_document_review_corrections_select
  on public.document_review_corrections for select to authenticated using (
    public.supplier_price_document_owned(org_id, document_id, auth.uid())
    and exists (
      select 1 from public.document_interpretations i
      where i.org_id = document_review_corrections.org_id
        and i.id = document_review_corrections.interpretation_id
        and i.document_id = document_review_corrections.document_id
        and i.interpreted_for_user_id = auth.uid()
    )
  );

revoke all on table public.document_review_corrections
  from public, anon, authenticated, service_role;
grant select on table public.document_review_corrections to authenticated;
grant select, insert, update, delete on table public.document_review_corrections to service_role;

create or replace function public.add_document_annotation(
  p_interpretation_id uuid,
  p_target_kind text,
  p_target_id text,
  p_tag_key text,
  p_label text,
  p_reason text,
  p_expected_input_checksum text,
  p_expected_contract_version text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_role user_role := auth_role();
  v_target_kind text := lower(trim(coalesce(p_target_kind, '')));
  v_target_id text := nullif(trim(p_target_id), '');
  v_tag_key text := nullif(trim(p_tag_key), '');
  v_label text := nullif(trim(p_label), '');
  v_reason text := nullif(trim(p_reason), '');
  v_expected_checksum text := nullif(trim(p_expected_input_checksum), '');
  v_expected_contract text := nullif(trim(p_expected_contract_version), '');
  v_extraction_id uuid;
  v_document_id uuid;
  v_input_checksum text;
  v_contract_version text;
  v_job_input_checksum text;
  v_job_contract_version text;
  v_storage_path text;
  v_mime_type text;
  v_uploaded_by uuid;
  v_current_checksum text;
  v_status text;
  v_payload jsonb;
  v_target_count integer;
  v_annotation_id uuid;
begin
  if v_org is null or v_actor is null
     or v_role not in ('owner', 'office', 'kitchen', 'supplier') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_target_kind not in ('block', 'mark')
     or v_target_id is null or length(v_target_id) > 500
     or v_tag_key is null or length(v_tag_key) > 100
     or v_label is null or length(v_label) > 200
     or v_reason is null or length(v_reason) > 1000
     or v_expected_checksum is null
     or v_expected_contract is null then
    raise exception 'document_annotation_invalid' using errcode = '22023';
  end if;

  -- Match 0048's document -> interpretation -> job lock order.
  perform 1
  from public.documents d
  join public.document_interpretations i
    on i.org_id = d.org_id and i.document_id = d.id
  join public.document_processing_jobs j
    on j.org_id = i.org_id and j.id = i.job_id
  where i.org_id = v_org and i.id = p_interpretation_id
    and d.deleted_at is null
    and (
      v_role <> 'supplier'
      or (
        i.interpreted_for_user_id = v_actor
        and j.requested_by = v_actor
        and public.supplier_price_document_owned(i.org_id, i.document_id, v_actor)
      )
    )
  for share of d;
  if not found then
    raise exception 'document_interpretation_unknown' using errcode = 'P0002';
  end if;

  select
    i.extraction_id, i.document_id, e.input_checksum, e.contract_version,
    j.input_checksum, j.contract_version, j.status,
    d.storage_path, d.mime_type, d.uploaded_by, e.payload
  into
    v_extraction_id, v_document_id, v_input_checksum, v_contract_version,
    v_job_input_checksum, v_job_contract_version, v_status,
    v_storage_path, v_mime_type, v_uploaded_by, v_payload
  from public.document_interpretations i
  join public.document_extractions e
    on e.org_id = i.org_id and e.id = i.extraction_id
  join public.document_processing_jobs j
    on j.org_id = i.org_id and j.id = i.job_id
  join public.documents d
    on d.org_id = i.org_id and d.id = i.document_id and d.deleted_at is null
  where i.org_id = v_org and i.id = p_interpretation_id
    and (
      v_role <> 'supplier'
      or (
        i.interpreted_for_user_id = v_actor
        and j.requested_by = v_actor
        and public.supplier_price_document_owned(i.org_id, i.document_id, v_actor)
      )
    )
  for update of i, j;
  if not found then
    raise exception 'document_interpretation_unknown' using errcode = 'P0002';
  end if;
  if v_status <> 'review' then
    raise exception 'document_review_status_invalid' using errcode = '55000';
  end if;
  v_current_checksum := public.smart_document_source_checksum(
    v_org, v_storage_path, v_mime_type, v_uploaded_by
  );
  if v_input_checksum <> v_job_input_checksum
     or v_contract_version <> v_job_contract_version
     or v_current_checksum <> v_input_checksum
     or v_input_checksum <> v_expected_checksum
     or v_contract_version <> v_expected_contract then
    raise exception 'document_review_source_changed' using errcode = '55000';
  end if;
  select count(*)::integer into v_target_count
  from jsonb_array_elements(
    case when v_target_kind = 'block' then v_payload -> 'blocks' else v_payload -> 'marks' end
  ) target
  where target ->> 'id' = v_target_id;
  if v_target_count <> 1 then
    raise exception 'document_annotation_target_invalid' using errcode = '23514';
  end if;

  select a.id into v_annotation_id
  from public.document_annotations a
  where a.org_id = v_org
    and a.interpretation_id = p_interpretation_id
    and a.target_kind = v_target_kind
    and a.target_id = v_target_id
    and a.tag_key = v_tag_key
    and a.label = v_label
    and a.source = 'user'
    and a.created_by = v_actor
    and a.applied_for_user_id = v_actor
    and a.active
  order by a.created_at desc, a.id
  limit 1;
  if v_annotation_id is not null then
    return v_annotation_id;
  end if;

  insert into public.document_annotations (
    org_id, interpretation_id, extraction_id, document_id,
    target_kind, target_id, tag_key, label, source,
    applied_for_user_id, created_by
  ) values (
    v_org, p_interpretation_id, v_extraction_id, v_document_id,
    v_target_kind, v_target_id, v_tag_key, v_label, 'user',
    v_actor, v_actor
  ) returning id into v_annotation_id;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_org, v_actor, 'document_annotation_created', 'document_annotations', v_annotation_id,
    jsonb_build_object(
      'interpretation_id', p_interpretation_id,
      'target_kind', v_target_kind,
      'target_id', v_target_id,
      'tag_key', v_tag_key
    ),
    v_reason
  );
  return v_annotation_id;
end
$$;

create or replace function public.add_document_review_correction(
  p_interpretation_id uuid,
  p_target_kind text,
  p_target_id text,
  p_row_index integer,
  p_column_index integer,
  p_expected_text text,
  p_corrected_text text,
  p_reason text,
  p_expected_input_checksum text,
  p_expected_contract_version text,
  p_expected_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_role user_role := auth_role();
  v_target_kind text := lower(trim(coalesce(p_target_kind, '')));
  v_target_id text := nullif(trim(p_target_id), '');
  v_reason text := nullif(trim(p_reason), '');
  v_expected_checksum text := nullif(trim(p_expected_input_checksum), '');
  v_expected_contract text := nullif(trim(p_expected_contract_version), '');
  v_extraction_id uuid;
  v_document_id uuid;
  v_input_checksum text;
  v_contract_version text;
  v_job_input_checksum text;
  v_job_contract_version text;
  v_storage_path text;
  v_mime_type text;
  v_uploaded_by uuid;
  v_current_checksum text;
  v_status text;
  v_payload jsonb;
  v_target jsonb;
  v_target_count integer;
  v_original_text text;
  v_before_text text;
  v_current_revision integer;
  v_next_revision integer;
  v_correction_id uuid;
begin
  if v_org is null or v_actor is null
     or v_role not in ('owner', 'office', 'kitchen', 'supplier') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_target_kind not in ('block', 'table_cell')
     or v_target_id is null or length(v_target_id) > 500
     or p_expected_text is null or length(p_expected_text) > 2000000
     or p_corrected_text is null or length(p_corrected_text) > 2000000
     or v_reason is null or length(v_reason) > 1000
     or v_expected_checksum is null
     or v_expected_contract is null
     or p_expected_revision is null or p_expected_revision < 0
     or (v_target_kind = 'block' and (p_row_index is not null or p_column_index is not null))
     or (
       v_target_kind = 'table_cell'
       and (p_row_index is null or p_row_index < 0
            or p_column_index is null or p_column_index < 0)
     ) then
    raise exception 'document_review_correction_invalid' using errcode = '22023';
  end if;

  -- Match 0048's document -> interpretation -> job lock order.
  perform 1
  from public.documents d
  join public.document_interpretations i
    on i.org_id = d.org_id and i.document_id = d.id
  join public.document_processing_jobs j
    on j.org_id = i.org_id and j.id = i.job_id
  where i.org_id = v_org and i.id = p_interpretation_id
    and d.deleted_at is null
    and (
      v_role <> 'supplier'
      or (
        i.interpreted_for_user_id = v_actor
        and j.requested_by = v_actor
        and public.supplier_price_document_owned(i.org_id, i.document_id, v_actor)
      )
    )
  for share of d;
  if not found then
    raise exception 'document_interpretation_unknown' using errcode = 'P0002';
  end if;

  -- ponytail: one interpretation/job lock serializes its low-volume review edits;
  -- use per-target advisory locks only if real review contention appears.
  select
    i.extraction_id, i.document_id, e.input_checksum, e.contract_version, e.payload,
    j.input_checksum, j.contract_version, j.status,
    d.storage_path, d.mime_type, d.uploaded_by
  into
    v_extraction_id, v_document_id, v_input_checksum, v_contract_version, v_payload,
    v_job_input_checksum, v_job_contract_version, v_status,
    v_storage_path, v_mime_type, v_uploaded_by
  from public.document_interpretations i
  join public.document_extractions e
    on e.org_id = i.org_id and e.id = i.extraction_id
  join public.document_processing_jobs j
    on j.org_id = i.org_id and j.id = i.job_id
  join public.documents d
    on d.org_id = i.org_id and d.id = i.document_id and d.deleted_at is null
  where i.org_id = v_org and i.id = p_interpretation_id
    and (
      v_role <> 'supplier'
      or (
        i.interpreted_for_user_id = v_actor
        and j.requested_by = v_actor
        and public.supplier_price_document_owned(i.org_id, i.document_id, v_actor)
      )
    )
  for update of i, j;
  if not found then
    raise exception 'document_interpretation_unknown' using errcode = 'P0002';
  end if;
  if v_status <> 'review' then
    raise exception 'document_review_status_invalid' using errcode = '55000';
  end if;
  v_current_checksum := public.smart_document_source_checksum(
    v_org, v_storage_path, v_mime_type, v_uploaded_by
  );
  if v_input_checksum <> v_job_input_checksum
     or v_contract_version <> v_job_contract_version
     or v_current_checksum <> v_input_checksum
     or v_input_checksum <> v_expected_checksum
     or v_contract_version <> v_expected_contract then
    raise exception 'document_review_source_changed' using errcode = '55000';
  end if;
  if v_target_kind = 'block' then
    select count(*)::integer into v_target_count
    from jsonb_array_elements(v_payload -> 'blocks') item
    where item ->> 'id' = v_target_id;
    if v_target_count <> 1 then
      raise exception 'document_review_target_unknown' using errcode = 'P0002';
    end if;
    select item into v_target
    from jsonb_array_elements(v_payload -> 'blocks') item
    where item ->> 'id' = v_target_id
    limit 1;
    v_original_text := v_target ->> 'text';
  else
    select count(*)::integer into v_target_count
    from jsonb_array_elements(v_payload -> 'tables') item
    where item ->> 'id' = v_target_id;
    if v_target_count <> 1 then
      raise exception 'document_review_target_unknown' using errcode = 'P0002';
    end if;
    select item into v_target
    from jsonb_array_elements(v_payload -> 'tables') item
    where item ->> 'id' = v_target_id
    limit 1;
    if v_target is null
       or jsonb_array_length(v_target -> 'rows') <= p_row_index
       or jsonb_typeof((v_target -> 'rows') -> p_row_index) <> 'array'
       or jsonb_array_length((v_target -> 'rows') -> p_row_index) <= p_column_index then
      raise exception 'document_review_target_unknown' using errcode = 'P0002';
    end if;
    v_original_text := v_target #>> array[
      'rows', p_row_index::text, p_column_index::text, 'text'
    ];
    if v_original_text is null then
      raise exception 'document_review_target_unknown' using errcode = 'P0002';
    end if;
  end if;

  select c.revision, c.corrected_text
  into v_current_revision, v_before_text
  from public.document_review_corrections c
  where c.org_id = v_org
    and c.interpretation_id = p_interpretation_id
    and c.target_kind = v_target_kind
    and c.target_id = v_target_id
    and c.row_index is not distinct from p_row_index
    and c.column_index is not distinct from p_column_index
  order by c.revision desc
  limit 1;
  if not found then
    v_current_revision := 0;
    v_before_text := v_original_text;
  end if;

  if p_expected_revision <> v_current_revision
     or p_expected_text <> v_before_text then
    raise exception 'document_review_revision_conflict' using errcode = '40001';
  end if;
  if p_corrected_text = v_before_text then
    raise exception 'document_review_correction_unchanged' using errcode = '22023';
  end if;

  v_next_revision := v_current_revision + 1;
  insert into public.document_review_corrections (
    org_id, interpretation_id, extraction_id, document_id,
    target_kind, target_id, row_index, column_index, revision,
    input_checksum, contract_version, original_text, before_text, corrected_text,
    actor_id, reason
  ) values (
    v_org, p_interpretation_id, v_extraction_id, v_document_id,
    v_target_kind, v_target_id, p_row_index, p_column_index, v_next_revision,
    v_input_checksum, v_contract_version, v_original_text, v_before_text, p_corrected_text,
    v_actor, v_reason
  ) returning id into v_correction_id;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_actor, 'document_review_correction_created',
    'document_review_corrections', v_correction_id,
    jsonb_build_object(
      'interpretation_id', p_interpretation_id,
      'target_kind', v_target_kind,
      'target_id', v_target_id,
      'row_index', p_row_index,
      'column_index', p_column_index,
      'revision', v_current_revision
    ),
    jsonb_build_object(
      'revision', v_next_revision,
      'input_checksum', v_input_checksum,
      'contract_version', v_contract_version
    ),
    v_reason
  );

  return jsonb_build_object(
    'correction_id', v_correction_id,
    'revision', v_next_revision,
    'input_checksum', v_input_checksum,
    'contract_version', v_contract_version
  );
end
$$;

revoke all on function public.add_document_annotation(
  uuid, text, text, text, text, text, text, text
) from public, anon, service_role;
grant execute on function public.add_document_annotation(
  uuid, text, text, text, text, text, text, text
) to authenticated;

revoke all on function public.add_document_review_correction(
  uuid, text, text, integer, integer, text, text, text, text, text, integer
) from public, anon, service_role;
grant execute on function public.add_document_review_correction(
  uuid, text, text, integer, integer, text, text, text, text, text, integer
) to authenticated;

comment on table public.document_review_corrections is
  'Append-only user corrections layered over immutable extraction blocks and table cells.';
comment on function public.add_document_annotation(
  uuid, text, text, text, text, text, text, text
) is 'Creates an actor-scoped one-off block or mark annotation during document review.';
comment on function public.add_document_review_correction(
  uuid, text, text, integer, integer, text, text, text, text, text, integer
) is 'Appends a version-fenced text or table-cell correction without rewriting extraction evidence.';
