-- Forward-only document-type review decisions for PLAN-05.
-- Claude suggestions remain immutable; approvals/rejections are append-only review evidence.

create table public.document_type_review_decisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  interpretation_id uuid not null,
  extraction_id uuid not null,
  document_id uuid not null,
  revision integer not null check (revision > 0),
  decision text not null check (decision in ('approved', 'rejected')),
  suggested_document_type text not null check (
    suggested_document_type in (
      'invoice', 'delivery_note', 'credit_note', 'price_list', 'quote',
      'payment_confirmation', 'other'
    )
  ),
  approved_document_type text check (
    approved_document_type is null or approved_document_type in (
      'invoice', 'delivery_note', 'credit_note', 'price_list', 'quote',
      'payment_confirmation', 'other'
    )
  ),
  input_checksum text not null check (
    input_checksum ~ '^etag:[0-9a-fA-F]{16,128}(-[0-9]+)?$'
  ),
  contract_version text not null check (contract_version = '1'),
  actor_id uuid not null,
  reason text not null check (length(trim(reason)) between 1 and 1000),
  created_at timestamptz not null default now(),
  constraint document_type_review_decisions_org_id_id_key unique (org_id, id),
  constraint document_type_review_decisions_revision_key
    unique (org_id, interpretation_id, revision),
  constraint document_type_review_decisions_context_fk
    foreign key (org_id, interpretation_id, extraction_id, document_id)
    references public.document_interpretations(org_id, id, extraction_id, document_id)
    on delete restrict,
  constraint document_type_review_decisions_actor_tenant_fk
    foreign key (org_id, actor_id)
    references public.profiles(org_id, id) on delete restrict,
  constraint document_type_review_decisions_shape check (
    (decision = 'approved' and approved_document_type = suggested_document_type)
    or (decision = 'rejected' and approved_document_type is null)
  )
);

create index document_type_review_decisions_document_idx
  on public.document_type_review_decisions (org_id, document_id, created_at desc);

create trigger document_type_review_decisions_immutable_trg
  before update or delete on public.document_type_review_decisions
  for each row execute function public.reject_document_learning_ledger_mutation();

alter table public.document_type_review_decisions enable row level security;
alter table public.document_type_review_decisions force row level security;

create policy document_type_review_decisions_select
  on public.document_type_review_decisions for select to authenticated using (
    org_id = auth_org() and auth_role() in ('owner', 'office', 'kitchen')
  );
create policy supplier_price_document_type_review_decisions_select
  on public.document_type_review_decisions for select to authenticated using (
    public.supplier_price_document_owned(org_id, document_id, auth.uid())
    and exists (
      select 1
      from public.document_interpretations i
      join public.document_processing_jobs j
        on j.org_id = i.org_id and j.id = i.job_id
      where i.org_id = document_type_review_decisions.org_id
        and i.id = document_type_review_decisions.interpretation_id
        and i.document_id = document_type_review_decisions.document_id
        and i.interpreted_for_user_id = auth.uid()
        and j.requested_by = auth.uid()
    )
  );

revoke all on table public.document_type_review_decisions
  from public, anon, authenticated, service_role;
grant select on table public.document_type_review_decisions to authenticated;
grant select, insert, update, delete on table public.document_type_review_decisions
  to service_role;

create or replace function public.review_document_type(
  p_interpretation_id uuid,
  p_decision text,
  p_expected_suggested_document_type text,
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
  v_decision text := lower(trim(coalesce(p_decision, '')));
  v_expected_suggestion text := lower(trim(coalesce(p_expected_suggested_document_type, '')));
  v_reason text := nullif(trim(p_reason), '');
  v_expected_checksum text := nullif(trim(p_expected_input_checksum), '');
  v_expected_contract text := nullif(trim(p_expected_contract_version), '');
  v_extraction_id uuid;
  v_document_id uuid;
  v_job_id uuid;
  v_suggested_document_type text;
  v_schema_version text;
  v_input_checksum text;
  v_contract_version text;
  v_job_input_checksum text;
  v_job_contract_version text;
  v_storage_path text;
  v_mime_type text;
  v_uploaded_by uuid;
  v_current_checksum text;
  v_status text;
  v_current public.document_type_review_decisions;
  v_current_revision integer := 0;
  v_approved_document_type text;
  v_decision_id uuid;
  v_next_revision integer;
begin
  if v_org is null or v_actor is null
     or v_role not in ('owner', 'office', 'kitchen') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_decision not in ('approved', 'rejected')
     or v_expected_suggestion not in (
       'invoice', 'delivery_note', 'credit_note', 'price_list', 'quote',
       'payment_confirmation', 'other'
     )
     or v_reason is null or length(v_reason) > 1000
     or v_expected_checksum is null
     or v_expected_contract is null
     or p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'document_type_review_invalid' using errcode = '22023';
  end if;

  -- Match 0049's document -> interpretation -> job lock order.
  perform 1
  from public.documents d
  join public.document_interpretations i
    on i.org_id = d.org_id and i.document_id = d.id
  join public.document_processing_jobs j
    on j.org_id = i.org_id and j.id = i.job_id
  where i.org_id = v_org and i.id = p_interpretation_id
    and d.deleted_at is null
  for share of d;
  if not found then
    raise exception 'document_interpretation_unknown' using errcode = 'P0002';
  end if;

  -- ponytail: one interpretation/job lock serializes its low-volume type decisions;
  -- use per-decision advisory locks only if real review contention appears.
  select
    i.extraction_id, i.document_id, i.job_id,
    i.payload ->> 'document_type', i.schema_version,
    e.input_checksum, e.contract_version,
    j.input_checksum, j.contract_version, j.status,
    d.storage_path, d.mime_type, d.uploaded_by
  into
    v_extraction_id, v_document_id, v_job_id,
    v_suggested_document_type, v_schema_version,
    v_input_checksum, v_contract_version,
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
     or v_schema_version <> v_contract_version
     or v_current_checksum <> v_input_checksum
     or v_input_checksum <> v_expected_checksum
     or v_contract_version <> v_expected_contract
     or v_suggested_document_type <> v_expected_suggestion then
    raise exception 'document_type_review_context_changed' using errcode = '55000';
  end if;

  select d.* into v_current
  from public.document_type_review_decisions d
  where d.org_id = v_org and d.interpretation_id = p_interpretation_id
  order by d.revision desc
  limit 1;
  if found then
    v_current_revision := v_current.revision;
  end if;

  v_approved_document_type := case
    when v_decision = 'approved' then v_suggested_document_type
    else null
  end;

  if p_expected_revision <> v_current_revision then
    if v_current_revision = p_expected_revision + 1
       and v_current.decision = v_decision
       and v_current.suggested_document_type = v_suggested_document_type
       and v_current.approved_document_type is not distinct from v_approved_document_type
       and v_current.input_checksum = v_input_checksum
       and v_current.contract_version = v_contract_version
       and v_current.actor_id = v_actor
       and v_current.reason = v_reason then
      return jsonb_build_object(
        'decision_id', v_current.id,
        'job_id', v_job_id,
        'revision', v_current.revision,
        'decision', v_current.decision,
        'suggested_document_type', v_current.suggested_document_type,
        'approved_document_type', v_current.approved_document_type,
        'input_checksum', v_current.input_checksum,
        'contract_version', v_current.contract_version,
        'idempotent', true
      );
    end if;
    raise exception 'document_type_review_revision_conflict' using errcode = '40001';
  end if;

  if v_current_revision > 0
     and v_current.decision = v_decision
     and v_current.approved_document_type is not distinct from v_approved_document_type then
    raise exception 'document_type_review_unchanged' using errcode = '22023';
  end if;

  v_next_revision := v_current_revision + 1;
  insert into public.document_type_review_decisions (
    org_id, interpretation_id, extraction_id, document_id, revision,
    decision, suggested_document_type, approved_document_type,
    input_checksum, contract_version, actor_id, reason
  ) values (
    v_org, p_interpretation_id, v_extraction_id, v_document_id, v_next_revision,
    v_decision, v_suggested_document_type, v_approved_document_type,
    v_input_checksum, v_contract_version, v_actor, v_reason
  ) returning id into v_decision_id;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_actor, 'document_type_review_decided',
    'document_type_review_decisions', v_decision_id,
    case when v_current_revision = 0 then null else jsonb_build_object(
      'decision_id', v_current.id,
      'revision', v_current.revision,
      'decision', v_current.decision,
      'approved_document_type', v_current.approved_document_type
    ) end,
    jsonb_build_object(
      'interpretation_id', p_interpretation_id,
      'job_id', v_job_id,
      'revision', v_next_revision,
      'decision', v_decision,
      'suggested_document_type', v_suggested_document_type,
      'approved_document_type', v_approved_document_type,
      'input_checksum', v_input_checksum,
      'contract_version', v_contract_version
    ),
    v_reason
  );

  return jsonb_build_object(
    'decision_id', v_decision_id,
    'job_id', v_job_id,
    'revision', v_next_revision,
    'decision', v_decision,
    'suggested_document_type', v_suggested_document_type,
    'approved_document_type', v_approved_document_type,
    'input_checksum', v_input_checksum,
    'contract_version', v_contract_version,
    'idempotent', false
  );
end
$$;

revoke all on function public.review_document_type(
  uuid, text, text, text, text, text, integer
) from public, anon, service_role;
grant execute on function public.review_document_type(
  uuid, text, text, text, text, text, integer
) to authenticated;

comment on table public.document_type_review_decisions is
  'Append-only approval/rejection history for immutable document-type suggestions.';
comment on function public.review_document_type(
  uuid, text, text, text, text, text, integer
) is 'Approves or rejects the current immutable document-type suggestion with stale-context fences.';
