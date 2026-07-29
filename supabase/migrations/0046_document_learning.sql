-- 0046 — Tenant-safe document interpretation, annotations and learned rules.
-- Claude receives only validated ExtractionContract JSON. Interpretations and rules remain
-- review annotations; this migration never writes invoices, receipts, credits, prices or balances.

-- ===== InterpretationContract v1 validation =====

create or replace function public.smart_document_string_array_valid(p_value jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_typeof(p_value) = 'array'
    and not exists (
      select 1
      from jsonb_array_elements(p_value) item
      where jsonb_typeof(item) <> 'string' or length(item #>> '{}') = 0
    )
$$;

create or replace function public.smart_document_interpretation_valid(
  p_payload jsonb,
  p_schema_version text
)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_supplier jsonb;
  v_item jsonb;
  v_value jsonb;
begin
  if p_payload is null
     or jsonb_typeof(p_payload) is distinct from 'object'
     or not (p_payload ?& array[
       'schema_version', 'document_type', 'document_type_confidence', 'supplier',
       'fields', 'line_items', 'suggested_annotations'
     ])
     or p_schema_version is distinct from '1'
     or jsonb_typeof(p_payload -> 'schema_version') <> 'string'
     or (p_payload ->> 'schema_version') is distinct from p_schema_version
     or jsonb_typeof(p_payload -> 'document_type') <> 'string'
     or p_payload ->> 'document_type' not in (
       'invoice', 'delivery_note', 'credit_note', 'price_list', 'quote',
       'payment_confirmation', 'other'
     )
     or not public.smart_document_confidence_valid(p_payload -> 'document_type_confidence')
     or jsonb_typeof(p_payload -> 'supplier') <> 'object'
     or jsonb_typeof(p_payload -> 'fields') <> 'array'
     or jsonb_typeof(p_payload -> 'line_items') <> 'array'
     or jsonb_typeof(p_payload -> 'suggested_annotations') <> 'array' then
    return false;
  end if;

  v_supplier := p_payload -> 'supplier';
  if not (v_supplier ?& array[
       'suggested_id', 'suggested_name', 'confidence', 'evidence_block_ids'
     ])
     or jsonb_typeof(v_supplier -> 'suggested_id') not in ('string', 'null')
     or jsonb_typeof(v_supplier -> 'suggested_name') not in ('string', 'null')
     or not public.smart_document_confidence_valid(v_supplier -> 'confidence')
     or not public.smart_document_string_array_valid(v_supplier -> 'evidence_block_ids') then
    return false;
  end if;
  if jsonb_typeof(v_supplier -> 'suggested_id') = 'string' then
    perform (v_supplier ->> 'suggested_id')::uuid;
  end if;

  for v_item in select value from jsonb_array_elements(p_payload -> 'fields')
  loop
    if jsonb_typeof(v_item) <> 'object'
       or not (v_item ?& array['key', 'value', 'confidence', 'evidence_block_ids'])
       or jsonb_typeof(v_item -> 'key') <> 'string'
       or length(v_item ->> 'key') = 0
       or jsonb_typeof(v_item -> 'value') not in ('string', 'number', 'boolean', 'null')
       or not public.smart_document_confidence_valid(v_item -> 'confidence')
       or not public.smart_document_string_array_valid(v_item -> 'evidence_block_ids') then
      return false;
    end if;
  end loop;

  for v_item in select value from jsonb_array_elements(p_payload -> 'line_items')
  loop
    if jsonb_typeof(v_item) <> 'object'
       or not (v_item ?& array['source_row', 'values', 'evidence_block_ids'])
       or jsonb_typeof(v_item -> 'source_row') not in ('number', 'null')
       or jsonb_typeof(v_item -> 'values') <> 'object'
       or not public.smart_document_string_array_valid(v_item -> 'evidence_block_ids') then
      return false;
    end if;
    for v_value in select value from jsonb_each(v_item -> 'values')
    loop
      if jsonb_typeof(v_value) not in ('string', 'number', 'null') then
        return false;
      end if;
    end loop;
  end loop;

  for v_item in select value from jsonb_array_elements(p_payload -> 'suggested_annotations')
  loop
    if jsonb_typeof(v_item) <> 'object'
       or not (v_item ?& array[
         'tag_key', 'label', 'target_block_ids', 'evidence_mark_ids', 'confidence'
       ])
       or jsonb_typeof(v_item -> 'tag_key') <> 'string'
       or length(trim(v_item ->> 'tag_key')) not between 1 and 100
       or jsonb_typeof(v_item -> 'label') <> 'string'
       or length(trim(v_item ->> 'label')) not between 1 and 200
       or not public.smart_document_string_array_valid(v_item -> 'target_block_ids')
       or not public.smart_document_string_array_valid(v_item -> 'evidence_mark_ids')
       or not public.smart_document_confidence_valid(v_item -> 'confidence') then
      return false;
    end if;
  end loop;

  return true;
exception when others then
  return false;
end
$$;

revoke all on function public.smart_document_string_array_valid(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.smart_document_interpretation_valid(jsonb, text)
  from public, anon, authenticated, service_role;

-- ===== Five tenant-scoped ledgers =====

alter table public.document_extractions
  add constraint document_extractions_interpretation_parent_key
  unique (org_id, id, job_id, document_id);

alter table public.document_processing_jobs
  add column interpretation_actor_id uuid,
  add column interpretation_started_at timestamptz,
  add constraint document_processing_jobs_interpretation_actor_tenant_fk
    foreign key (org_id, interpretation_actor_id)
    references public.profiles(org_id, id) on delete restrict,
  add constraint document_processing_jobs_interpretation_actor_shape check (
    (interpretation_actor_id is null and interpretation_started_at is null)
    or (interpretation_actor_id is not null and interpretation_started_at is not null)
  );

create or replace function public.guard_document_processing_job()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.org_id is distinct from old.org_id
     or new.document_id is distinct from old.document_id
     or new.requested_by is distinct from old.requested_by
     or new.input_checksum is distinct from old.input_checksum
     or new.contract_version is distinct from old.contract_version
     or new.priority is distinct from old.priority
     or new.created_at is distinct from old.created_at
     or new.attempt_count < old.attempt_count then
    raise exception 'document_processing_job_identity_immutable' using errcode = '42501';
  end if;

  if new.interpretation_actor_id is distinct from old.interpretation_actor_id
     or new.interpretation_started_at is distinct from old.interpretation_started_at then
    if old.status = 'extracted'
       and new.status = 'interpreting'
       and old.interpretation_actor_id is null
       and old.interpretation_started_at is null
       and new.interpretation_actor_id is not null
       and new.interpretation_started_at is not null
       and current_setting('app.document_interpretation_writer', true)
            is not distinct from new.interpretation_actor_id::text then
      null;
    elsif old.status = 'interpreting'
       and new.status = 'interpreting'
       and old.interpretation_actor_id is not null
       and old.interpretation_started_at <= clock_timestamp() - interval '5 minutes'
       and new.interpretation_actor_id is not null
       and new.interpretation_started_at > old.interpretation_started_at
       and current_setting('app.document_interpretation_writer', true)
            is not distinct from new.interpretation_actor_id::text then
      null;
    else
      raise exception 'document_interpretation_actor_immutable' using errcode = '42501';
    end if;
  elsif old.status = 'extracted' and new.status = 'interpreting' then
    raise exception 'document_interpretation_rpc_required' using errcode = '42501';
  end if;

  if old.status = 'queued' and new.status not in ('queued', 'leased') then
    raise exception 'document_processing_transition_invalid' using errcode = '23514';
  elsif old.status = 'leased' and new.status not in ('leased', 'extracted', 'failed') then
    raise exception 'document_processing_transition_invalid' using errcode = '23514';
  elsif old.status = 'extracted' and new.status not in ('extracted', 'interpreting', 'failed') then
    raise exception 'document_processing_transition_invalid' using errcode = '23514';
  elsif old.status = 'interpreting' and new.status not in ('interpreting', 'review', 'failed') then
    raise exception 'document_processing_transition_invalid' using errcode = '23514';
  elsif old.status = 'review' and new.status not in ('review', 'completed', 'failed') then
    raise exception 'document_processing_transition_invalid' using errcode = '23514';
  elsif old.status in ('completed', 'failed') and new.status <> old.status then
    raise exception 'document_processing_terminal_state' using errcode = '23514';
  end if;

  new.updated_at := now();
  return new;
end
$$;

create table public.document_interpretations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  job_id uuid not null,
  extraction_id uuid not null,
  document_id uuid not null,
  interpreted_for_user_id uuid not null,
  provider text not null check (length(trim(provider)) between 1 and 100),
  model text not null check (length(trim(model)) between 1 and 200),
  prompt_version text not null check (length(trim(prompt_version)) between 1 and 100),
  schema_version text not null default '1' check (schema_version = '1'),
  payload jsonb not null,
  suggested_supplier_id uuid generated always as (
    nullif(payload #>> '{supplier,suggested_id}', '')::uuid
  ) stored,
  usage jsonb not null default '{}'::jsonb check (jsonb_typeof(usage) = 'object'),
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  created_at timestamptz not null default now(),
  constraint document_interpretations_org_id_id_key unique (org_id, id),
  constraint document_interpretations_job_key unique (org_id, job_id),
  constraint document_interpretations_context_key
    unique (org_id, id, extraction_id, document_id),
  constraint document_interpretations_extraction_tenant_fk
    foreign key (org_id, extraction_id, job_id, document_id)
    references public.document_extractions(org_id, id, job_id, document_id) on delete restrict,
  constraint document_interpretations_actor_tenant_fk
    foreign key (org_id, interpreted_for_user_id)
    references public.profiles(org_id, id) on delete restrict,
  constraint document_interpretations_supplier_tenant_fk
    foreign key (org_id, suggested_supplier_id)
    references public.suppliers(org_id, id) on delete restrict,
  constraint document_interpretations_payload_check
    check (public.smart_document_interpretation_valid(payload, schema_version))
);

create index document_interpretations_document_idx
  on public.document_interpretations (org_id, document_id, created_at desc);

create table public.document_learning_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  family_id uuid not null,
  version integer not null check (version > 0),
  user_id uuid,
  document_type text check (
    document_type is null or document_type in (
      'invoice', 'delivery_note', 'credit_note', 'price_list', 'quote',
      'payment_confirmation', 'other'
    )
  ),
  supplier_id uuid,
  mark_kind text not null check (
    mark_kind in ('circle', 'check', 'cross', 'underline', 'star', 'custom', 'unknown')
  ),
  mark_fingerprint text check (
    mark_fingerprint is null or length(trim(mark_fingerprint)) between 1 and 500
  ),
  tag_key text not null check (length(trim(tag_key)) between 1 and 100),
  label text not null check (length(trim(label)) between 1 and 200),
  active boolean not null default true,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  disabled_at timestamptz,
  disabled_by uuid,
  disable_reason text,
  constraint document_learning_rules_org_id_id_key unique (org_id, id),
  constraint document_learning_rules_family_version_key unique (org_id, family_id, version),
  constraint document_learning_rules_rule_version_key unique (org_id, id, version),
  constraint document_learning_rules_user_tenant_fk
    foreign key (org_id, user_id) references public.profiles(org_id, id) on delete restrict,
  constraint document_learning_rules_supplier_tenant_fk
    foreign key (org_id, supplier_id) references public.suppliers(org_id, id) on delete restrict,
  constraint document_learning_rules_creator_tenant_fk
    foreign key (org_id, created_by) references public.profiles(org_id, id) on delete restrict,
  constraint document_learning_rules_disabler_tenant_fk
    foreign key (org_id, disabled_by) references public.profiles(org_id, id) on delete restrict,
  constraint document_learning_rules_personal_actor_check
    check (user_id is null or user_id = created_by),
  constraint document_learning_rules_scope_check
    check (supplier_id is null or document_type is not null),
  constraint document_learning_rules_active_shape check (
    (active and disabled_at is null and disabled_by is null and disable_reason is null)
    or (
      not active and disabled_at is not null and disabled_by is not null
      and nullif(trim(disable_reason), '') is not null
    )
  )
);

create unique index document_learning_rules_active_match_key
  on public.document_learning_rules (
    org_id, user_id, document_type, supplier_id, mark_kind, mark_fingerprint
  ) nulls not distinct
  where active;
create index document_learning_rules_context_idx
  on public.document_learning_rules (
    org_id, user_id, document_type, supplier_id, mark_kind, version desc
  ) where active;

create table public.document_annotations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  interpretation_id uuid not null,
  extraction_id uuid not null,
  document_id uuid not null,
  target_kind text not null check (target_kind in ('block', 'mark')),
  target_id text not null check (length(trim(target_id)) between 1 and 500),
  tag_key text not null check (length(trim(tag_key)) between 1 and 100),
  label text not null check (length(trim(label)) between 1 and 200),
  source text not null check (source in ('user', 'rule', 'claude')),
  applied_for_user_id uuid,
  rule_id uuid,
  rule_version integer,
  confidence numeric check (confidence is null or confidence between 0 and 1),
  evidence_mark_ids text[] not null default '{}',
  active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  corrected_at timestamptz,
  corrected_by uuid,
  correction_annotation_id uuid,
  constraint document_annotations_org_id_id_key unique (org_id, id),
  constraint document_annotations_interpretation_key
    unique (org_id, id, interpretation_id),
  constraint document_annotations_context_fk
    foreign key (org_id, interpretation_id, extraction_id, document_id)
    references public.document_interpretations(org_id, id, extraction_id, document_id)
    on delete restrict,
  constraint document_annotations_rule_version_fk
    foreign key (org_id, rule_id, rule_version)
    references public.document_learning_rules(org_id, id, version) on delete restrict,
  constraint document_annotations_creator_tenant_fk
    foreign key (org_id, created_by) references public.profiles(org_id, id) on delete restrict,
  constraint document_annotations_applied_user_tenant_fk
    foreign key (org_id, applied_for_user_id)
    references public.profiles(org_id, id) on delete restrict,
  constraint document_annotations_corrector_tenant_fk
    foreign key (org_id, corrected_by) references public.profiles(org_id, id) on delete restrict,
  constraint document_annotations_rule_shape check (
    (source = 'rule' and rule_id is not null and rule_version is not null
      and created_by is not null and applied_for_user_id = created_by)
    or (source = 'user' and rule_id is null and rule_version is null
      and created_by is not null
      and (applied_for_user_id is null or applied_for_user_id = created_by))
    or (source = 'claude' and rule_id is null and rule_version is null
      and applied_for_user_id is null)
  ),
  constraint document_annotations_active_shape check (
    (active and corrected_at is null and corrected_by is null and correction_annotation_id is null)
    or (not active and corrected_at is not null and corrected_by is not null)
  )
);

alter table public.document_annotations
  add constraint document_annotations_correction_tenant_fk
  foreign key (org_id, correction_annotation_id, interpretation_id)
  references public.document_annotations(org_id, id, interpretation_id) on delete restrict;

create index document_annotations_document_idx
  on public.document_annotations (org_id, document_id, created_at desc);
create index document_annotations_interpretation_idx
  on public.document_annotations (org_id, interpretation_id, active, created_at);

create table public.document_feedback (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  interpretation_id uuid not null,
  annotation_id uuid not null,
  feedback_type text not null check (feedback_type in ('accepted', 'rejected', 'corrected')),
  before_value jsonb not null check (jsonb_typeof(before_value) = 'object'),
  after_value jsonb not null check (jsonb_typeof(after_value) = 'object'),
  actor_id uuid not null,
  reason text not null check (nullif(trim(reason), '') is not null),
  correction_annotation_id uuid,
  created_at timestamptz not null default now(),
  constraint document_feedback_org_id_id_key unique (org_id, id),
  constraint document_feedback_interpretation_tenant_fk
    foreign key (org_id, interpretation_id)
    references public.document_interpretations(org_id, id) on delete restrict,
  constraint document_feedback_annotation_tenant_fk
    foreign key (org_id, annotation_id, interpretation_id)
    references public.document_annotations(org_id, id, interpretation_id) on delete restrict,
  constraint document_feedback_actor_tenant_fk
    foreign key (org_id, actor_id) references public.profiles(org_id, id) on delete restrict,
  constraint document_feedback_correction_tenant_fk
    foreign key (org_id, correction_annotation_id, interpretation_id)
    references public.document_annotations(org_id, id, interpretation_id) on delete restrict,
  constraint document_feedback_correction_shape check (
    (feedback_type = 'corrected' and correction_annotation_id is not null)
    or (feedback_type <> 'corrected' and correction_annotation_id is null)
  )
);

create index document_feedback_interpretation_idx
  on public.document_feedback (org_id, interpretation_id, created_at);

create table public.document_rule_applications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  interpretation_id uuid not null,
  extraction_id uuid not null,
  document_id uuid not null,
  rule_id uuid not null,
  rule_version integer not null,
  applied_for_user_id uuid not null,
  target_kind text not null check (target_kind = 'mark'),
  target_id text not null check (length(trim(target_id)) between 1 and 500),
  confidence numeric check (confidence is null or confidence between 0 and 1),
  annotation_id uuid not null,
  created_at timestamptz not null default now(),
  constraint document_rule_applications_org_id_id_key unique (org_id, id),
  constraint document_rule_applications_target_key
    unique (org_id, interpretation_id, applied_for_user_id, target_kind, target_id),
  constraint document_rule_applications_interpretation_tenant_fk
    foreign key (org_id, interpretation_id, extraction_id, document_id)
    references public.document_interpretations(org_id, id, extraction_id, document_id)
    on delete restrict,
  constraint document_rule_applications_rule_version_fk
    foreign key (org_id, rule_id, rule_version)
    references public.document_learning_rules(org_id, id, version) on delete restrict,
  constraint document_rule_applications_actor_tenant_fk
    foreign key (org_id, applied_for_user_id)
    references public.profiles(org_id, id) on delete restrict,
  constraint document_rule_applications_annotation_tenant_fk
    foreign key (org_id, annotation_id, interpretation_id)
    references public.document_annotations(org_id, id, interpretation_id) on delete restrict
);

create index document_rule_applications_extraction_idx
  on public.document_rule_applications (org_id, extraction_id, created_at);

-- ===== Mutation guards =====

create or replace function public.reject_document_learning_ledger_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception '%_immutable', tg_table_name using errcode = '42501';
end
$$;

create trigger document_interpretations_immutable_trg
  before update or delete on public.document_interpretations
  for each row execute function public.reject_document_learning_ledger_mutation();
create trigger document_feedback_immutable_trg
  before update or delete on public.document_feedback
  for each row execute function public.reject_document_learning_ledger_mutation();
create trigger document_rule_applications_immutable_trg
  before update or delete on public.document_rule_applications
  for each row execute function public.reject_document_learning_ledger_mutation();

create or replace function public.guard_document_learning_rule()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'document_learning_rule_immutable' using errcode = '42501';
  end if;
  if old.active = false
     or (to_jsonb(new) - array['active', 'disabled_at', 'disabled_by', 'disable_reason'])
          is distinct from
        (to_jsonb(old) - array['active', 'disabled_at', 'disabled_by', 'disable_reason'])
     or new.active
     or new.disabled_at is null
     or new.disabled_by is null
     or nullif(trim(new.disable_reason), '') is null then
    raise exception 'document_learning_rule_immutable' using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger document_learning_rules_guard_trg
  before update or delete on public.document_learning_rules
  for each row execute function public.guard_document_learning_rule();

create or replace function public.guard_document_annotation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payload jsonb;
begin
  if tg_op = 'DELETE' then
    raise exception 'document_annotation_immutable' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    if old.active = false
       or (to_jsonb(new) - array['active', 'corrected_at', 'corrected_by', 'correction_annotation_id'])
            is distinct from
          (to_jsonb(old) - array['active', 'corrected_at', 'corrected_by', 'correction_annotation_id'])
       or new.active
       or new.corrected_at is null
       or new.corrected_by is null then
      raise exception 'document_annotation_immutable' using errcode = '42501';
    end if;
    return new;
  end if;

  select e.payload into v_payload
  from public.document_extractions e
  where e.org_id = new.org_id and e.id = new.extraction_id;
  if not found or not exists (
    select 1
    from jsonb_array_elements(
      case when new.target_kind = 'block' then v_payload -> 'blocks' else v_payload -> 'marks' end
    ) target
    where target ->> 'id' = new.target_id
  ) then
    raise exception 'document_annotation_target_invalid' using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger document_annotations_guard_trg
  before insert or update or delete on public.document_annotations
  for each row execute function public.guard_document_annotation();

revoke all on function public.reject_document_learning_ledger_mutation()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_document_learning_rule()
  from public, anon, authenticated, service_role;
revoke all on function public.guard_document_annotation()
  from public, anon, authenticated, service_role;

-- ===== RLS and least-privilege grants =====

alter table public.document_interpretations enable row level security;
alter table public.document_interpretations force row level security;
alter table public.document_learning_rules enable row level security;
alter table public.document_learning_rules force row level security;
alter table public.document_annotations enable row level security;
alter table public.document_annotations force row level security;
alter table public.document_feedback enable row level security;
alter table public.document_feedback force row level security;
alter table public.document_rule_applications enable row level security;
alter table public.document_rule_applications force row level security;

create policy document_interpretations_select on public.document_interpretations
  for select to authenticated using (
    org_id = auth_org() and auth_role() in ('owner', 'office', 'kitchen')
  );
create policy document_learning_rules_select on public.document_learning_rules
  for select to authenticated using (
    org_id = auth_org()
    and auth_role() in ('owner', 'office', 'kitchen')
    and (user_id is null or user_id = auth.uid())
  );
create policy document_annotations_select on public.document_annotations
  for select to authenticated using (
    org_id = auth_org() and auth_role() in ('owner', 'office', 'kitchen')
    and (applied_for_user_id is null or applied_for_user_id = auth.uid())
  );
create policy document_feedback_select on public.document_feedback
  for select to authenticated using (
    org_id = auth_org() and auth_role() in ('owner', 'office', 'kitchen')
    and actor_id = auth.uid()
  );
create policy document_rule_applications_select on public.document_rule_applications
  for select to authenticated using (
    org_id = auth_org() and auth_role() in ('owner', 'office', 'kitchen')
    and applied_for_user_id = auth.uid()
  );

revoke all on table public.document_interpretations from public, anon, authenticated, service_role;
revoke all on table public.document_learning_rules from public, anon, authenticated, service_role;
revoke all on table public.document_annotations from public, anon, authenticated, service_role;
revoke all on table public.document_feedback from public, anon, authenticated, service_role;
revoke all on table public.document_rule_applications from public, anon, authenticated, service_role;

grant select on table
  public.document_interpretations,
  public.document_learning_rules,
  public.document_annotations,
  public.document_feedback,
  public.document_rule_applications
to authenticated;

-- The project-wide trusted-server ACL requires full table CRUD for service_role.
-- Immutable-ledger triggers and tenant/context constraints remain authoritative even there;
-- browser clients still mutate only through the reasoned RPCs below.
grant select, insert, update, delete on table
  public.document_interpretations,
  public.document_learning_rules,
  public.document_annotations,
  public.document_feedback,
  public.document_rule_applications
to service_role;

-- ===== Authenticated learning commands =====

create or replace function public.create_document_learning_rule(
  p_rule_scope text,
  p_document_type text,
  p_supplier_id uuid,
  p_mark_kind text,
  p_mark_fingerprint text,
  p_tag_key text,
  p_label text,
  p_reason text
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
  v_scope text := lower(trim(coalesce(p_rule_scope, '')));
  v_user_id uuid;
  v_document_type text := nullif(lower(trim(p_document_type)), '');
  v_mark_kind text := lower(trim(coalesce(p_mark_kind, '')));
  v_fingerprint text := nullif(trim(p_mark_fingerprint), '');
  v_tag_key text := nullif(trim(p_tag_key), '');
  v_label text := nullif(trim(p_label), '');
  v_reason text := nullif(trim(p_reason), '');
  v_previous public.document_learning_rules;
  v_family_id uuid;
  v_version integer;
  v_rule_id uuid;
begin
  if v_org is null or v_actor is null or v_role not in ('owner', 'office', 'kitchen') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_scope not in ('personal', 'organization') then
    raise exception 'document_learning_scope_invalid' using errcode = '22023';
  end if;
  if v_scope = 'organization' and v_role not in ('owner', 'office') then
    raise exception 'document_learning_org_rule_not_authorized' using errcode = '42501';
  end if;
  v_user_id := case when v_scope = 'personal' then v_actor else null end;

  if v_document_type is not null and v_document_type not in (
       'invoice', 'delivery_note', 'credit_note', 'price_list', 'quote',
       'payment_confirmation', 'other'
     ) then
    raise exception 'document_learning_document_type_invalid' using errcode = '22023';
  end if;
  if p_supplier_id is not null and v_document_type is null then
    raise exception 'document_learning_supplier_scope_requires_document_type' using errcode = '22023';
  end if;
  if p_supplier_id is not null and not exists (
    select 1 from public.suppliers s
    where s.org_id = v_org and s.id = p_supplier_id and s.deleted_at is null
  ) then
    raise exception 'document_learning_supplier_unknown' using errcode = 'P0002';
  end if;
  if v_mark_kind not in ('circle', 'check', 'cross', 'underline', 'star', 'custom', 'unknown')
     or v_tag_key is null or length(v_tag_key) > 100
     or v_label is null or length(v_label) > 200
     or v_fingerprint is not null and length(v_fingerprint) > 500
     or v_reason is null then
    raise exception 'document_learning_rule_invalid' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(
    v_org, v_user_id, v_document_type, p_supplier_id, v_mark_kind, v_fingerprint
  )::text, 0));

  select * into v_previous
  from public.document_learning_rules r
  where r.org_id = v_org
    and r.user_id is not distinct from v_user_id
    and r.document_type is not distinct from v_document_type
    and r.supplier_id is not distinct from p_supplier_id
    and r.mark_kind = v_mark_kind
    and r.mark_fingerprint is not distinct from v_fingerprint
  order by r.version desc, r.created_at desc, r.id desc
  limit 1
  for update;

  if found then
    v_family_id := v_previous.family_id;
    v_version := v_previous.version + 1;
    if v_previous.active then
      update public.document_learning_rules
      set active = false,
          disabled_at = now(),
          disabled_by = v_actor,
          disable_reason = v_reason
      where id = v_previous.id;
    end if;
  else
    v_family_id := gen_random_uuid();
    v_version := 1;
  end if;

  insert into public.document_learning_rules (
    org_id, family_id, version, user_id, document_type, supplier_id,
    mark_kind, mark_fingerprint, tag_key, label, created_by
  ) values (
    v_org, v_family_id, v_version, v_user_id, v_document_type, p_supplier_id,
    v_mark_kind, v_fingerprint, v_tag_key, v_label, v_actor
  ) returning id into v_rule_id;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_actor,
    case when v_previous.id is null then 'document_learning_rule_created'
         else 'document_learning_rule_versioned' end,
    'document_learning_rules', v_rule_id,
    case when v_previous.id is null then null else jsonb_build_object(
      'rule_id', v_previous.id, 'version', v_previous.version,
      'tag_key', v_previous.tag_key, 'label', v_previous.label
    ) end,
    jsonb_build_object(
      'scope', v_scope, 'version', v_version, 'document_type', v_document_type,
      'supplier_id', p_supplier_id, 'mark_kind', v_mark_kind,
      'mark_fingerprint', v_fingerprint, 'tag_key', v_tag_key, 'label', v_label
    ),
    v_reason
  );
  return v_rule_id;
end
$$;

create or replace function public.disable_document_learning_rule(
  p_rule_id uuid,
  p_reason text
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
  v_reason text := nullif(trim(p_reason), '');
  v_rule public.document_learning_rules;
begin
  if v_org is null or v_actor is null or v_role not in ('owner', 'office', 'kitchen') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into v_rule
  from public.document_learning_rules
  where org_id = v_org and id = p_rule_id
  for update;
  if not found then
    raise exception 'document_learning_rule_unknown' using errcode = 'P0002';
  end if;
  if v_rule.user_id is null and v_role not in ('owner', 'office') then
    raise exception 'document_learning_org_rule_not_authorized' using errcode = '42501';
  end if;
  if v_rule.user_id is not null and v_rule.user_id <> v_actor then
    raise exception 'document_learning_personal_rule_not_owned' using errcode = '42501';
  end if;
  if not v_rule.active then
    return v_rule.id;
  end if;

  update public.document_learning_rules
  set active = false, disabled_at = now(), disabled_by = v_actor, disable_reason = v_reason
  where id = v_rule.id;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_actor, 'document_learning_rule_disabled', 'document_learning_rules', v_rule.id,
    jsonb_build_object('active', true, 'version', v_rule.version),
    jsonb_build_object('active', false, 'version', v_rule.version),
    v_reason
  );
  return v_rule.id;
end
$$;

create or replace function public.add_document_feedback(
  p_annotation_id uuid,
  p_feedback_type text,
  p_after jsonb,
  p_reason text
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
  v_feedback_type text := lower(trim(coalesce(p_feedback_type, '')));
  v_reason text := nullif(trim(p_reason), '');
  v_annotation public.document_annotations;
  v_before jsonb;
  v_after jsonb;
  v_feedback_id uuid := gen_random_uuid();
  v_correction_id uuid;
  v_tag_key text;
  v_label text;
begin
  if v_org is null or v_actor is null or v_role not in ('owner', 'office', 'kitchen') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_feedback_type not in ('accepted', 'rejected', 'corrected') or v_reason is null then
    raise exception 'document_feedback_invalid' using errcode = '22023';
  end if;

  select * into v_annotation
  from public.document_annotations
  where org_id = v_org and id = p_annotation_id
  for update;
  if not found then
    raise exception 'document_annotation_unknown' using errcode = 'P0002';
  end if;
  if v_annotation.applied_for_user_id is not null
     and v_annotation.applied_for_user_id <> v_actor then
    raise exception 'document_annotation_not_owned' using errcode = '42501';
  end if;
  if not v_annotation.active and v_feedback_type <> 'accepted' then
    raise exception 'document_annotation_inactive' using errcode = '55000';
  end if;

  v_before := jsonb_build_object(
    'tag_key', v_annotation.tag_key,
    'label', v_annotation.label,
    'active', v_annotation.active
  );
  if v_feedback_type = 'accepted' then
    v_after := v_before;
  elsif v_feedback_type = 'rejected' then
    v_after := v_before || jsonb_build_object('active', false);
  else
    if p_after is null or jsonb_typeof(p_after) <> 'object'
       or jsonb_typeof(p_after -> 'tag_key') <> 'string'
       or jsonb_typeof(p_after -> 'label') <> 'string' then
      raise exception 'document_feedback_correction_invalid' using errcode = '22023';
    end if;
    v_tag_key := nullif(trim(p_after ->> 'tag_key'), '');
    v_label := nullif(trim(p_after ->> 'label'), '');
    if v_tag_key is null or length(v_tag_key) > 100
       or v_label is null or length(v_label) > 200 then
      raise exception 'document_feedback_correction_invalid' using errcode = '22023';
    end if;
    v_after := jsonb_build_object('tag_key', v_tag_key, 'label', v_label, 'active', true);
    insert into public.document_annotations (
      org_id, interpretation_id, extraction_id, document_id, target_kind, target_id,
      tag_key, label, source, applied_for_user_id, confidence, evidence_mark_ids, created_by
    ) values (
      v_annotation.org_id, v_annotation.interpretation_id, v_annotation.extraction_id,
      v_annotation.document_id, v_annotation.target_kind, v_annotation.target_id,
      v_tag_key, v_label, 'user', v_actor,
      v_annotation.confidence,
      v_annotation.evidence_mark_ids, v_actor
    ) returning id into v_correction_id;
  end if;

  insert into public.document_feedback (
    id, org_id, interpretation_id, annotation_id, feedback_type,
    before_value, after_value, actor_id, reason, correction_annotation_id
  ) values (
    v_feedback_id, v_org, v_annotation.interpretation_id, v_annotation.id, v_feedback_type,
    v_before, v_after, v_actor, v_reason, v_correction_id
  );

  if v_feedback_type in ('rejected', 'corrected') then
    update public.document_annotations
    set active = false,
        corrected_at = now(),
        corrected_by = v_actor,
        correction_annotation_id = v_correction_id
    where id = v_annotation.id;
  end if;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_actor, 'document_feedback_added', 'document_feedback', v_feedback_id,
    jsonb_build_object('annotation_id', v_annotation.id),
    jsonb_build_object(
      'feedback_type', v_feedback_type,
      'correction_annotation_id', v_correction_id
    ),
    v_reason
  );
  return v_feedback_id;
end
$$;

-- ===== Rule application: exactly one winner per extracted mark =====

create or replace function public.assert_document_interpretation_actor(
  p_org_id uuid,
  p_actor_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1
    from public.profiles p
    where p.org_id = p_org_id
      and p.id = p_actor_id
      and p.active
      and p.role in ('owner', 'office', 'kitchen')
  ) then
    raise exception 'document_interpretation_actor_invalid' using errcode = '42501';
  end if;
end
$$;

revoke all on function public.assert_document_interpretation_actor(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.apply_document_learning_rules(
  p_interpretation_id uuid,
  p_actor_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_interpretation public.document_interpretations;
  v_extraction public.document_extractions;
  v_job public.document_processing_jobs;
  v_actor uuid := p_actor_id;
  v_document_type text;
  v_supplier_id uuid;
  v_mark jsonb;
  v_rule public.document_learning_rules;
  v_annotation_id uuid;
  v_confidence numeric;
  v_count integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select * into v_interpretation
  from public.document_interpretations
  where id = p_interpretation_id;
  if not found then
    raise exception 'document_interpretation_unknown' using errcode = 'P0002';
  end if;
  perform public.assert_document_interpretation_actor(v_interpretation.org_id, v_actor);
  perform pg_advisory_xact_lock(hashtextextended(
    v_interpretation.id::text || ':' || v_actor::text, 0
  ));

  select * into v_extraction
  from public.document_extractions
  where org_id = v_interpretation.org_id and id = v_interpretation.extraction_id;
  select * into v_job
  from public.document_processing_jobs
  where org_id = v_interpretation.org_id and id = v_interpretation.job_id;
  if v_extraction.id is null or v_job.id is null then
    raise exception 'document_interpretation_context_invalid' using errcode = '23514';
  end if;

  v_document_type := v_interpretation.payload ->> 'document_type';
  v_supplier_id := v_interpretation.suggested_supplier_id;

  for v_mark in select value from jsonb_array_elements(v_extraction.payload -> 'marks')
  loop
    if exists (
      select 1 from public.document_rule_applications a
      where a.org_id = v_interpretation.org_id
        and a.interpretation_id = v_interpretation.id
        and a.applied_for_user_id = v_actor
        and a.target_kind = 'mark'
        and a.target_id = v_mark ->> 'id'
    ) then
      continue;
    end if;

    select * into v_rule
    from public.document_learning_rules r
    where r.org_id = v_interpretation.org_id
      and r.active
      and r.mark_kind = v_mark ->> 'kind'
      and (r.mark_fingerprint is null or r.mark_fingerprint = v_mark ->> 'fingerprint')
      and (r.user_id is null or r.user_id = v_actor)
      and (r.document_type is null or r.document_type = v_document_type)
      and (r.supplier_id is null or r.supplier_id = v_supplier_id)
    order by
      case when r.user_id = v_actor then 1 else 0 end desc,
      case
        when r.supplier_id is not null and r.document_type is not null then 2
        when r.document_type is not null then 1
        else 0
      end desc,
      r.version desc,
      r.created_at desc,
      r.id desc
    limit 1;

    if not found then
      continue;
    end if;

    v_confidence := case
      when jsonb_typeof(v_mark -> 'confidence') = 'number'
        then (v_mark ->> 'confidence')::numeric
      else null
    end;
    insert into public.document_annotations (
      org_id, interpretation_id, extraction_id, document_id, target_kind, target_id,
      tag_key, label, source, applied_for_user_id, rule_id, rule_version, confidence, created_by
    ) values (
      v_interpretation.org_id, v_interpretation.id, v_interpretation.extraction_id,
      v_interpretation.document_id, 'mark', v_mark ->> 'id',
      v_rule.tag_key, v_rule.label, 'rule', v_actor, v_rule.id, v_rule.version,
      v_confidence, v_actor
    ) returning id into v_annotation_id;

    insert into public.document_rule_applications (
      org_id, interpretation_id, extraction_id, document_id, rule_id, rule_version,
      applied_for_user_id, target_kind, target_id, confidence, annotation_id
    ) values (
      v_interpretation.org_id, v_interpretation.id, v_interpretation.extraction_id,
      v_interpretation.document_id, v_rule.id, v_rule.version, v_actor,
      'mark', v_mark ->> 'id', v_confidence, v_annotation_id
    );
    v_count := v_count + 1;
  end loop;

  if v_count > 0 then
    insert into public.audit_logs (
      org_id, user_id, action, entity_type, entity_id, new_values, reason
    ) values (
      v_interpretation.org_id, v_actor, 'document_learning_rules_applied',
      'document_interpretations', v_interpretation.id,
      jsonb_build_object('annotation_count', v_count),
      'active learned rules applied as annotations only'
    );
  end if;
  return v_count;
end
$$;

-- ===== Service-only interpretation lifecycle =====

create or replace function public.begin_document_interpretation(
  p_job_id uuid,
  p_extraction_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.document_processing_jobs;
  v_extraction public.document_extractions;
  v_document public.documents;
  v_existing_id uuid;
  v_rule_count integer;
  v_reclaimed boolean := false;
  v_attempt_started_at timestamptz;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select * into v_job
  from public.document_processing_jobs
  where id = p_job_id
  for update;
  if not found then
    raise exception 'document_processing_job_unknown' using errcode = 'P0002';
  end if;
  perform public.assert_document_interpretation_actor(v_job.org_id, p_actor_id);
  select * into v_extraction
  from public.document_extractions
  where org_id = v_job.org_id and id = p_extraction_id
    and job_id = v_job.id and document_id = v_job.document_id;
  if not found then
    raise exception 'document_extraction_unknown' using errcode = 'P0002';
  end if;
  perform 1 from public.organizations o
  where o.id = v_job.org_id and o.status in ('trial', 'active') for share;
  if not found then
    raise exception 'org_suspended' using errcode = 'P0002';
  end if;

  select i.id into v_existing_id
  from public.document_interpretations i
  where i.org_id = v_job.org_id and i.job_id = v_job.id;
  if v_existing_id is not null then
    v_rule_count := public.apply_document_learning_rules(v_existing_id, p_actor_id);
    return jsonb_build_object(
      'job_id', v_job.id, 'org_id', v_job.org_id, 'document_id', v_job.document_id,
      'actor_id', p_actor_id, 'extraction_id', v_extraction.id,
      'already_interpreted', true, 'interpretation_id', v_existing_id,
      'rule_annotation_count', v_rule_count
    );
  end if;
  if v_job.status = 'interpreting' then
    if v_job.interpretation_started_at is null
       or v_job.interpretation_started_at > clock_timestamp() - interval '5 minutes' then
      raise exception 'document_interpretation_in_progress' using errcode = '55000';
    end if;
    v_reclaimed := true;
  elsif v_job.status <> 'extracted' then
    raise exception 'document_interpretation_status_invalid' using errcode = '55000';
  end if;

  select * into v_document
  from public.documents
  where org_id = v_job.org_id and id = v_job.document_id and deleted_at is null;
  if not found then
    raise exception 'document_unknown' using errcode = 'P0002';
  end if;

  perform set_config('app.document_interpretation_writer', p_actor_id::text, true);
  update public.document_processing_jobs
  set status = 'interpreting',
      interpretation_actor_id = p_actor_id,
      interpretation_started_at = clock_timestamp()
  where id = v_job.id
  returning interpretation_started_at into v_attempt_started_at;

  if v_reclaimed then
    insert into public.audit_logs (
      org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
    ) values (
      v_job.org_id, null, 'document_interpretation_reclaimed',
      'document_processing_jobs', v_job.id,
      jsonb_build_object(
        'extraction_id', v_extraction.id,
        'actor_id', v_job.interpretation_actor_id,
        'started_at', v_job.interpretation_started_at
      ),
      jsonb_build_object(
        'extraction_id', v_extraction.id,
        'actor_id', p_actor_id,
        'started_at', v_attempt_started_at
      ),
      'stale document interpretation reclaimed after five minutes'
    );
  else
    insert into public.audit_logs (
      org_id, user_id, action, entity_type, entity_id, new_values, reason
    ) values (
      v_job.org_id, null, 'document_interpretation_started',
      'document_processing_jobs', v_job.id,
      jsonb_build_object('extraction_id', v_extraction.id, 'actor_id', p_actor_id),
      'server-side structured interpretation started'
    );
  end if;

  return jsonb_build_object(
    'job_id', v_job.id,
    'org_id', v_job.org_id,
    'document_id', v_job.document_id,
    'actor_id', p_actor_id,
    'interpretation_started_at', v_attempt_started_at,
    'extraction_id', v_extraction.id,
    'extraction_contract_version', v_extraction.contract_version,
    'extraction_payload', v_extraction.payload,
    'document_kind', v_document.document_kind,
    'current_supplier_id', v_document.supplier_id,
    'already_interpreted', false
  );
end
$$;

create or replace function public.save_document_interpretation(
  p_job_id uuid,
  p_extraction_id uuid,
  p_actor_id uuid,
  p_interpretation_started_at timestamptz,
  p_provider text,
  p_model text,
  p_prompt_version text,
  p_schema_version text,
  p_payload jsonb,
  p_usage jsonb default '{}'::jsonb,
  p_duration_ms integer default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.document_processing_jobs;
  v_extraction public.document_extractions;
  v_existing public.document_interpretations;
  v_provider text := nullif(trim(p_provider), '');
  v_model text := nullif(trim(p_model), '');
  v_prompt_version text := nullif(trim(p_prompt_version), '');
  v_interpretation_id uuid;
  v_rule_count integer;
  v_claude_annotation_count integer := 0;
  v_suggestion jsonb;
  v_target_id text;
  v_evidence_id text;
  v_evidence_mark_ids text[];
  v_confidence numeric;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_provider is null or length(v_provider) > 100
     or v_model is null or length(v_model) > 200
     or v_prompt_version is null or length(v_prompt_version) > 100
     or p_schema_version is distinct from '1'
     or p_usage is null or jsonb_typeof(p_usage) <> 'object'
     or p_duration_ms is not null and p_duration_ms < 0
     or not public.smart_document_interpretation_valid(p_payload, p_schema_version) then
    raise exception 'document_interpretation_invalid' using errcode = '22023';
  end if;

  select * into v_job
  from public.document_processing_jobs
  where id = p_job_id
  for update;
  if not found then
    raise exception 'document_processing_job_unknown' using errcode = 'P0002';
  end if;
  perform public.assert_document_interpretation_actor(v_job.org_id, p_actor_id);
  if v_job.interpretation_actor_id is distinct from p_actor_id then
    raise exception 'document_interpretation_actor_mismatch' using errcode = '42501';
  end if;
  if v_job.interpretation_started_at is distinct from p_interpretation_started_at then
    raise exception 'document_interpretation_attempt_mismatch' using errcode = '55000';
  end if;

  select * into v_existing
  from public.document_interpretations
  where org_id = v_job.org_id and job_id = v_job.id;
  if found then
    if v_existing.extraction_id = p_extraction_id
       and v_existing.provider = v_provider
       and v_existing.model = v_model
       and v_existing.prompt_version = v_prompt_version
       and v_existing.schema_version = p_schema_version
       and v_existing.payload = p_payload then
      perform public.apply_document_learning_rules(v_existing.id, p_actor_id);
      return v_existing.id;
    end if;
    raise exception 'document_interpretation_conflict' using errcode = '23505';
  end if;
  if v_job.status <> 'interpreting' then
    raise exception 'document_interpretation_status_invalid' using errcode = '55000';
  end if;

  select * into v_extraction
  from public.document_extractions
  where org_id = v_job.org_id and id = p_extraction_id
    and job_id = v_job.id and document_id = v_job.document_id;
  if not found then
    raise exception 'document_extraction_unknown' using errcode = 'P0002';
  end if;

  insert into public.document_interpretations (
    org_id, job_id, extraction_id, document_id, interpreted_for_user_id, provider, model,
    prompt_version, schema_version, payload, usage, duration_ms
  ) values (
    v_job.org_id, v_job.id, v_extraction.id, v_job.document_id, p_actor_id,
    v_provider, v_model, v_prompt_version, p_schema_version,
    p_payload, p_usage, p_duration_ms
  ) returning id into v_interpretation_id;

  for v_suggestion in
    select value from jsonb_array_elements(p_payload -> 'suggested_annotations')
  loop
    v_evidence_mark_ids := array(
      select jsonb_array_elements_text(v_suggestion -> 'evidence_mark_ids')
    );
    foreach v_evidence_id in array v_evidence_mark_ids
    loop
      if not exists (
        select 1 from jsonb_array_elements(v_extraction.payload -> 'marks') mark
        where mark ->> 'id' = v_evidence_id
      ) then
        raise exception 'document_annotation_evidence_invalid' using errcode = '23514';
      end if;
    end loop;
    v_confidence := case
      when jsonb_typeof(v_suggestion -> 'confidence') = 'number'
        then (v_suggestion ->> 'confidence')::numeric
      else null
    end;
    for v_target_id in
      select jsonb_array_elements_text(v_suggestion -> 'target_block_ids')
    loop
      insert into public.document_annotations (
        org_id, interpretation_id, extraction_id, document_id, target_kind, target_id,
        tag_key, label, source, confidence, evidence_mark_ids
      ) values (
        v_job.org_id, v_interpretation_id, v_extraction.id, v_job.document_id,
        'block', v_target_id, trim(v_suggestion ->> 'tag_key'),
        trim(v_suggestion ->> 'label'), 'claude', v_confidence, v_evidence_mark_ids
      );
      v_claude_annotation_count := v_claude_annotation_count + 1;
    end loop;
  end loop;

  v_rule_count := public.apply_document_learning_rules(v_interpretation_id, p_actor_id);

  update public.document_processing_jobs
  set status = 'review', last_error_code = null, last_error_message = null
  where id = v_job.id;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_job.org_id, null, 'document_interpretation_saved',
    'document_interpretations', v_interpretation_id,
    jsonb_build_object(
      'job_id', v_job.id, 'extraction_id', v_extraction.id,
      'provider', v_provider, 'model', v_model,
      'prompt_version', v_prompt_version, 'schema_version', p_schema_version,
      'claude_annotation_count', v_claude_annotation_count,
      'rule_annotation_count', v_rule_count,
      'actor_id', p_actor_id
    ),
    'validated structured interpretation saved for human review'
  );
  return v_interpretation_id;
end
$$;

create or replace function public.fail_document_interpretation(
  p_job_id uuid,
  p_extraction_id uuid,
  p_actor_id uuid,
  p_interpretation_started_at timestamptz,
  p_error_code text,
  p_error_message text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.document_processing_jobs;
  v_error_code text := lower(trim(coalesce(p_error_code, '')));
  v_error_message text := nullif(left(trim(coalesce(p_error_message, '')), 1000), '');
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_error_code !~ '^[a-z][a-z0-9_]{2,99}$' then
    raise exception 'document_interpretation_error_code_invalid' using errcode = '22023';
  end if;

  select * into v_job
  from public.document_processing_jobs
  where id = p_job_id
  for update;
  if not found then
    raise exception 'document_processing_job_unknown' using errcode = 'P0002';
  end if;
  if v_job.interpretation_actor_id is null
     or v_job.interpretation_actor_id is distinct from p_actor_id then
    raise exception 'document_interpretation_actor_mismatch' using errcode = '42501';
  end if;
  if v_job.interpretation_started_at is distinct from p_interpretation_started_at then
    raise exception 'document_interpretation_attempt_mismatch' using errcode = '55000';
  end if;
  if not exists (
    select 1 from public.document_extractions e
    where e.org_id = v_job.org_id and e.id = p_extraction_id
      and e.job_id = v_job.id and e.document_id = v_job.document_id
  ) then
    raise exception 'document_extraction_unknown' using errcode = 'P0002';
  end if;
  if v_job.status = 'failed' and v_job.last_error_code = v_error_code then
    return v_job.id;
  end if;
  if exists (
    select 1 from public.document_interpretations i
    where i.org_id = v_job.org_id and i.job_id = v_job.id
  ) then
    raise exception 'document_interpretation_already_saved' using errcode = '55000';
  end if;
  if v_job.status <> 'interpreting' then
    raise exception 'document_interpretation_status_invalid' using errcode = '55000';
  end if;
  update public.document_processing_jobs
  set status = 'failed', last_error_code = v_error_code, last_error_message = v_error_message
  where id = v_job.id;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_job.org_id, null, 'document_interpretation_failed',
    'document_processing_jobs', v_job.id,
    jsonb_build_object(
      'extraction_id', p_extraction_id, 'actor_id', p_actor_id,
      'error_code', v_error_code
    ),
    coalesce(v_error_message, v_error_code)
  );
  return v_job.id;
end
$$;

revoke all on function public.create_document_learning_rule(
  text, text, uuid, text, text, text, text, text
) from public, anon, service_role;
grant execute on function public.create_document_learning_rule(
  text, text, uuid, text, text, text, text, text
) to authenticated;
revoke all on function public.disable_document_learning_rule(uuid, text)
  from public, anon, service_role;
grant execute on function public.disable_document_learning_rule(uuid, text) to authenticated;
revoke all on function public.add_document_feedback(uuid, text, jsonb, text)
  from public, anon, service_role;
grant execute on function public.add_document_feedback(uuid, text, jsonb, text) to authenticated;

revoke all on function public.apply_document_learning_rules(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.apply_document_learning_rules(uuid, uuid) to service_role;
revoke all on function public.begin_document_interpretation(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.begin_document_interpretation(uuid, uuid, uuid) to service_role;
revoke all on function public.save_document_interpretation(
  uuid, uuid, uuid, timestamptz, text, text, text, text, jsonb, jsonb, integer
) from public, anon, authenticated;
grant execute on function public.save_document_interpretation(
  uuid, uuid, uuid, timestamptz, text, text, text, text, jsonb, jsonb, integer
) to service_role;
revoke all on function public.fail_document_interpretation(uuid, uuid, uuid, timestamptz, text, text)
  from public, anon, authenticated;
grant execute on function public.fail_document_interpretation(uuid, uuid, uuid, timestamptz, text, text)
  to service_role;

comment on table public.document_interpretations is
  'Immutable validated InterpretationContract payloads; model output is a review suggestion only.';
comment on table public.document_learning_rules is
  'Versioned organization or personal annotation rules; never business-field automation.';
comment on table public.document_annotations is
  'Block/mark annotations from users, learned rules or Claude; no business entity target exists.';
comment on table public.document_feedback is
  'Append-only accepted, rejected or corrected annotation feedback with actor and reason.';
comment on table public.document_rule_applications is
  'Append-only winner ledger: one learned rule annotation per interpretation mark.';
