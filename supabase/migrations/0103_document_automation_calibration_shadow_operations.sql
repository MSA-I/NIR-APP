-- 0103 -- Measured price-list automation: immutable shadow predictions, human calibration
-- evidence, drift read models, and document-pipeline operational read models.
--
-- This migration deliberately does not change either autonomy switch or confidence threshold.
-- Shadow evaluation uses the configured threshold (or the documented baseline when the tenant is
-- unconfigured) to say what the current rule WOULD do, but it never calls a catalog/price writer.
-- Human verdicts are evidence only: they do not tune a threshold and cannot mutate a prediction.

-- ===== 1. Immutable shadow and calibration ledgers =====

create table public.price_list_shadow_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  document_id uuid not null,
  job_id uuid not null,
  extraction_id uuid not null,
  interpretation_id uuid not null,
  actor_id uuid not null,
  supplier_id uuid,
  execution_mode text not null default 'shadow' check (execution_mode = 'shadow'),
  evaluator_version text not null check (length(trim(evaluator_version)) between 1 and 100),
  policy_configured boolean not null,
  live_policy_enabled boolean not null,
  policy_kill_switch boolean not null,
  evaluated_min_confidence numeric check (
    evaluated_min_confidence is null
    or (evaluated_min_confidence > 0 and evaluated_min_confidence <= 1)
  ),
  decision_confidence numeric check (
    decision_confidence is null or (decision_confidence >= 0 and decision_confidence <= 1)
  ),
  predicted_outcome text not null check (
    predicted_outcome in ('queued_for_review', 'partially_applicable', 'would_apply')
  ),
  reason_code text,
  applicable_count integer not null default 0 check (applicable_count >= 0),
  waiting_count integer not null default 0 check (waiting_count >= 0),
  would_create_product_count integer not null default 0
    check (would_create_product_count >= 0),
  provider text not null check (length(trim(provider)) between 1 and 100),
  model text not null check (length(trim(model)) between 1 and 200),
  prompt_version text not null check (length(trim(prompt_version)) between 1 and 100),
  schema_version text not null check (length(trim(schema_version)) between 1 and 100),
  document_format text not null check (length(trim(document_format)) between 1 and 200),
  extraction_engine text not null check (length(trim(extraction_engine)) between 1 and 100),
  extraction_model text not null check (length(trim(extraction_model)) between 1 and 200),
  extraction_model_version text not null
    check (length(trim(extraction_model_version)) between 1 and 200),
  page_count integer not null check (page_count between 1 and 100),
  block_count integer not null check (block_count >= 0),
  table_count integer not null check (table_count >= 0),
  interpreted_line_count integer not null check (interpreted_line_count >= 0),
  layout_signature text not null check (layout_signature ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  constraint price_list_shadow_runs_org_id_id_key unique (org_id, id),
  constraint price_list_shadow_runs_interpretation_version_key
    unique (org_id, interpretation_id, evaluator_version),
  constraint price_list_shadow_runs_document_fk
    foreign key (org_id, document_id)
      references public.documents(org_id, id) on delete restrict,
  constraint price_list_shadow_runs_job_fk
    foreign key (org_id, job_id)
      references public.document_processing_jobs(org_id, id) on delete restrict,
  constraint price_list_shadow_runs_interpretation_fk
    foreign key (org_id, interpretation_id, extraction_id, document_id)
      references public.document_interpretations(org_id, id, extraction_id, document_id)
      on delete restrict,
  constraint price_list_shadow_runs_actor_fk
    foreign key (org_id, actor_id)
      references public.profiles(org_id, id) on delete restrict,
  constraint price_list_shadow_runs_supplier_fk
    foreign key (org_id, supplier_id)
      references public.suppliers(org_id, id) on delete restrict,
  constraint price_list_shadow_runs_count_shape check (
    applicable_count + waiting_count = interpreted_line_count
    and would_create_product_count <= applicable_count
  ),
  constraint price_list_shadow_runs_outcome_shape check (
    (predicted_outcome = 'queued_for_review' and applicable_count = 0)
    or (
      predicted_outcome = 'partially_applicable'
      and applicable_count > 0 and waiting_count > 0
    )
    or (
      predicted_outcome = 'would_apply'
      and applicable_count > 0 and waiting_count = 0
    )
  )
);

create index price_list_shadow_runs_supplier_format_idx
  on public.price_list_shadow_runs (
    org_id, supplier_id, document_format, created_at desc
  );
create index price_list_shadow_runs_version_idx
  on public.price_list_shadow_runs (
    org_id, provider, model, prompt_version, created_at desc
  );

create table public.price_list_shadow_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  shadow_run_id uuid not null,
  document_id uuid not null,
  interpretation_id uuid not null,
  line_index integer not null check (line_index >= 0),
  source_row integer check (source_row is null or source_row > 0),
  evidence_block_ids text[] not null default '{}'::text[],
  predicted_action text not null check (
    predicted_action in (
      'apply_existing_price', 'create_product', 'review', 'rejected_by_policy'
    )
  ),
  reason_code text,
  matched_by text,
  product_id uuid,
  supplier_product_id uuid,
  sku text,
  barcode text,
  product_name text,
  unit text,
  proposed_unit_price numeric,
  current_unit_price numeric,
  price_change_percent numeric,
  product_would_be_created boolean not null default false,
  created_at timestamptz not null default now(),
  constraint price_list_shadow_lines_org_id_id_key unique (org_id, id),
  constraint price_list_shadow_lines_run_line_key
    unique (org_id, shadow_run_id, line_index),
  constraint price_list_shadow_lines_run_fk
    foreign key (org_id, shadow_run_id)
      references public.price_list_shadow_runs(org_id, id) on delete restrict,
  constraint price_list_shadow_lines_document_fk
    foreign key (org_id, document_id)
      references public.documents(org_id, id) on delete restrict,
  constraint price_list_shadow_lines_interpretation_fk
    foreign key (org_id, interpretation_id)
      references public.document_interpretations(org_id, id) on delete restrict,
  constraint price_list_shadow_lines_product_fk
    foreign key (org_id, product_id)
      references public.products(org_id, id) on delete restrict,
  constraint price_list_shadow_lines_supplier_product_fk
    foreign key (org_id, supplier_product_id)
      references public.supplier_products(org_id, id) on delete restrict,
  constraint price_list_shadow_lines_price_shape check (
    (proposed_unit_price is null or proposed_unit_price > 0)
    and (current_unit_price is null or current_unit_price > 0)
    and (price_change_percent is null or current_unit_price is not null)
  ),
  constraint price_list_shadow_lines_action_shape check (
    (
      predicted_action = 'apply_existing_price'
      and reason_code is null and product_id is not null
      and proposed_unit_price is not null and not product_would_be_created
    )
    or (
      predicted_action = 'create_product'
      and reason_code is null and product_id is null and supplier_product_id is null
      and proposed_unit_price is not null and product_would_be_created
    )
    or (
      predicted_action in ('review', 'rejected_by_policy')
      and reason_code is not null and supplier_product_id is null
      and not product_would_be_created
    )
  )
);

create index price_list_shadow_lines_action_idx
  on public.price_list_shadow_lines (org_id, predicted_action, created_at desc);

create table public.price_list_calibration_reviews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  shadow_run_id uuid not null,
  shadow_line_id uuid not null,
  document_id uuid not null,
  interpretation_id uuid not null,
  revision integer not null check (revision > 0),
  idempotency_key uuid not null,
  reviewer_id uuid not null,
  verdict text not null check (
    verdict in ('correct', 'incorrect', 'ambiguous', 'rejected_by_policy')
  ),
  error_labels text[] not null default '{}'::text[] check (
    error_labels <@ array[
      'incorrect_action', 'incorrect_product_match', 'incorrect_new_product', 'incorrect_price',
      'ambiguous', 'rejected_by_policy'
    ]::text[]
  ),
  expected_action text not null check (
    expected_action in (
      'apply_existing_price', 'create_product', 'review', 'rejected_by_policy'
    )
  ),
  expected_product_id uuid,
  expected_unit_price numeric,
  reason text not null check (
    coalesce(reason, '') ~ '[[:graph:]]' and length(reason) <= 1000
  ),
  created_at timestamptz not null default now(),
  constraint price_list_calibration_reviews_org_id_id_key unique (org_id, id),
  constraint price_list_calibration_reviews_idempotency_key
    unique (org_id, idempotency_key),
  constraint price_list_calibration_reviews_revision_key
    unique (org_id, shadow_line_id, revision),
  constraint price_list_calibration_reviews_run_fk
    foreign key (org_id, shadow_run_id)
      references public.price_list_shadow_runs(org_id, id) on delete restrict,
  constraint price_list_calibration_reviews_line_fk
    foreign key (org_id, shadow_line_id)
      references public.price_list_shadow_lines(org_id, id) on delete restrict,
  constraint price_list_calibration_reviews_document_fk
    foreign key (org_id, document_id)
      references public.documents(org_id, id) on delete restrict,
  constraint price_list_calibration_reviews_interpretation_fk
    foreign key (org_id, interpretation_id)
      references public.document_interpretations(org_id, id) on delete restrict,
  constraint price_list_calibration_reviews_reviewer_fk
    foreign key (org_id, reviewer_id)
      references public.profiles(org_id, id) on delete restrict,
  constraint price_list_calibration_reviews_expected_product_fk
    foreign key (org_id, expected_product_id)
      references public.products(org_id, id) on delete restrict,
  constraint price_list_calibration_reviews_verdict_shape check (
    (verdict = 'correct' and cardinality(error_labels) = 0)
    or (verdict = 'incorrect' and cardinality(error_labels) > 0)
    or (verdict = 'ambiguous' and 'ambiguous' = any(error_labels))
    or (
      verdict = 'rejected_by_policy'
      and 'rejected_by_policy' = any(error_labels)
    )
  ),
  constraint price_list_calibration_reviews_expected_shape check (
    (
      expected_action = 'apply_existing_price'
      and expected_product_id is not null
      and expected_unit_price is not null and expected_unit_price > 0
    )
    or (
      expected_action = 'create_product'
      and expected_product_id is null
      and expected_unit_price is not null and expected_unit_price > 0
    )
    or (
      expected_action in ('review', 'rejected_by_policy')
      and expected_product_id is null and expected_unit_price is null
    )
  )
);

create index price_list_calibration_reviews_latest_idx
  on public.price_list_calibration_reviews (
    org_id, shadow_line_id, revision desc
  );

create table public.price_list_empty_run_reviews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  shadow_run_id uuid not null,
  document_id uuid not null,
  interpretation_id uuid not null,
  revision integer not null check (revision > 0),
  idempotency_key uuid not null,
  reviewer_id uuid not null,
  verdict text not null check (
    verdict in ('correct', 'incorrect', 'ambiguous', 'rejected_by_policy')
  ),
  reason text not null check (reason ~ '[[:graph:]]' and length(reason) <= 1000),
  created_at timestamptz not null default now(),
  constraint price_list_empty_run_reviews_org_id_id_key unique (org_id, id),
  constraint price_list_empty_run_reviews_idempotency_key unique (org_id, idempotency_key),
  constraint price_list_empty_run_reviews_revision_key unique (org_id, shadow_run_id, revision),
  constraint price_list_empty_run_reviews_run_fk foreign key (org_id, shadow_run_id)
    references public.price_list_shadow_runs(org_id, id) on delete restrict,
  constraint price_list_empty_run_reviews_document_fk foreign key (org_id, document_id)
    references public.documents(org_id, id) on delete restrict,
  constraint price_list_empty_run_reviews_interpretation_fk foreign key (org_id, interpretation_id)
    references public.document_interpretations(org_id, id) on delete restrict,
  constraint price_list_empty_run_reviews_reviewer_fk foreign key (org_id, reviewer_id)
    references public.profiles(org_id, id) on delete restrict
);

create index price_list_empty_run_reviews_latest_idx
  on public.price_list_empty_run_reviews (org_id, shadow_run_id, revision desc);

create or replace function public.reject_price_list_measurement_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'price_list_measurement_immutable' using errcode = '42501';
  end if;
  if tg_table_name in ('price_list_shadow_runs', 'price_list_shadow_lines')
     and current_setting('app.price_list_shadow_writer', true) is distinct from 'run' then
    raise exception 'price_list_shadow_writer_required' using errcode = '42501';
  end if;
  if tg_table_name = 'price_list_calibration_reviews'
     and current_setting('app.price_list_calibration_writer', true) is distinct from 'record' then
    raise exception 'price_list_calibration_writer_required' using errcode = '42501';
  end if;
  if tg_table_name = 'price_list_empty_run_reviews'
     and current_setting('app.price_list_empty_review_writer', true) is distinct from 'record' then
    raise exception 'price_list_empty_review_writer_required' using errcode = '42501';
  end if;
  if tg_table_name = 'price_list_automation_scope_decisions'
     and current_setting('app.price_list_scope_writer', true) is distinct from 'decide' then
    raise exception 'price_list_scope_writer_required' using errcode = '42501';
  end if;
  return new;
end
$$;
revoke all on function public.reject_price_list_measurement_mutation()
  from public, anon, authenticated, service_role;

create trigger price_list_shadow_runs_immutable_trg
  before insert or update or delete on public.price_list_shadow_runs
  for each row execute function public.reject_price_list_measurement_mutation();
create trigger price_list_shadow_lines_immutable_trg
  before insert or update or delete on public.price_list_shadow_lines
  for each row execute function public.reject_price_list_measurement_mutation();
create trigger price_list_calibration_reviews_immutable_trg
  before insert or update or delete on public.price_list_calibration_reviews
  for each row execute function public.reject_price_list_measurement_mutation();
create trigger price_list_empty_run_reviews_immutable_trg
  before insert or update or delete on public.price_list_empty_run_reviews
  for each row execute function public.reject_price_list_measurement_mutation();

alter table public.price_list_shadow_runs enable row level security;
alter table public.price_list_shadow_runs force row level security;
alter table public.price_list_shadow_lines enable row level security;
alter table public.price_list_shadow_lines force row level security;
alter table public.price_list_calibration_reviews enable row level security;
alter table public.price_list_calibration_reviews force row level security;
alter table public.price_list_empty_run_reviews enable row level security;
alter table public.price_list_empty_run_reviews force row level security;

create policy price_list_shadow_runs_owner_select
  on public.price_list_shadow_runs for select to authenticated
  using (org_id = auth_org() and auth_role() = 'owner');
create policy price_list_shadow_lines_owner_select
  on public.price_list_shadow_lines for select to authenticated
  using (org_id = auth_org() and auth_role() = 'owner');
create policy price_list_calibration_reviews_owner_select
  on public.price_list_calibration_reviews for select to authenticated
  using (org_id = auth_org() and auth_role() = 'owner');
create policy price_list_empty_run_reviews_owner_select
  on public.price_list_empty_run_reviews for select to authenticated
  using (org_id = auth_org() and auth_role() = 'owner');

revoke all on table public.price_list_shadow_runs
  from public, anon, authenticated, service_role;
revoke all on table public.price_list_shadow_lines
  from public, anon, authenticated, service_role;
revoke all on table public.price_list_calibration_reviews
  from public, anon, authenticated, service_role;
revoke all on table public.price_list_empty_run_reviews
  from public, anon, authenticated, service_role;
grant select on table public.price_list_shadow_runs to authenticated, service_role;
grant select on table public.price_list_shadow_lines to authenticated, service_role;
grant select on table public.price_list_calibration_reviews to authenticated, service_role;
grant select on table public.price_list_empty_run_reviews to authenticated, service_role;

-- ===== 2. Explicit, service-only shadow evaluation =====

create or replace function private.price_list_layout_signature(
  p_extraction_payload jsonb,
  p_document_format text
) returns text
language sql
immutable
strict
set search_path = public, extensions, pg_catalog
as $$
  with table_entries as (
    select entry.table_value, entry.table_ordinality
    from jsonb_array_elements(p_extraction_payload -> 'tables')
      with ordinality as entry(table_value, table_ordinality)
  ), header_candidates as (
    -- Future contract versions may expose an explicit header array. Prefer it when present.
    select table_ordinality, true as explicit_header, table_value -> 'headers' as cells
    from table_entries
    where jsonb_typeof(table_value -> 'headers') = 'array'
    union all
    select table_ordinality, true, table_value -> 'header'
    from table_entries
    where jsonb_typeof(table_value -> 'headers') is distinct from 'array'
      and jsonb_typeof(table_value -> 'header') = 'array'
    union all
    -- Contract v1 carries rows only. Treat the first row of the primary table as a
    -- header only when at least two cells look like price-list field names; this
    -- avoids fingerprinting an ordinary first product row.
    select table_ordinality, false, table_value -> 'rows' -> 0
    from table_entries
    where table_ordinality = 1
      and jsonb_typeof(table_value -> 'headers') is distinct from 'array'
      and jsonb_typeof(table_value -> 'header') is distinct from 'array'
      and jsonb_typeof(table_value -> 'rows') = 'array'
      and jsonb_array_length(table_value -> 'rows') > 0
      and jsonb_typeof(table_value -> 'rows' -> 0) = 'array'
  ), normalized_header_candidates as (
    select candidate.table_ordinality, candidate.explicit_header,
           jsonb_agg(cell.normalized_text order by cell.cell_ordinality) as header_cells,
           count(*) filter (where
             position('product' in cell.normalized_text) > 0
             or position('item' in cell.normalized_text) > 0
             or position('description' in cell.normalized_text) > 0
             or position('sku' in cell.normalized_text) > 0
             or position('catalog' in cell.normalized_text) > 0
             or position('barcode' in cell.normalized_text) > 0
             or position('unit' in cell.normalized_text) > 0
             or position('price' in cell.normalized_text) > 0
             or position('cost' in cell.normalized_text) > 0
             or position('currency' in cell.normalized_text) > 0
             or position('מוצר' in cell.normalized_text) > 0
             or position('פריט' in cell.normalized_text) > 0
             or position('תיאור' in cell.normalized_text) > 0
             or position('מקט' in replace(replace(replace(
               cell.normalized_text, '"', ''
             ), '''', ''), '״', '')) > 0
             or position('ברקוד' in cell.normalized_text) > 0
             or position('יחידה' in cell.normalized_text) > 0
             or position('מחיר' in cell.normalized_text) > 0
             or position('עלות' in cell.normalized_text) > 0
             or position('מטבע' in cell.normalized_text) > 0
           ) as semantic_header_cells
    from header_candidates candidate
    cross join lateral (
      select cell_value.cell_ordinality,
             lower(regexp_replace(btrim(coalesce(
               case jsonb_typeof(cell_value.value)
                 when 'object' then cell_value.value ->> 'text'
                 when 'string' then cell_value.value #>> '{}'
                 else null
               end,
               ''
             )), '[[:space:]]+', ' ', 'g')) as normalized_text
      from jsonb_array_elements(candidate.cells)
        with ordinality as cell_value(value, cell_ordinality)
    ) cell
    group by candidate.table_ordinality, candidate.explicit_header
  ), stable_headers as (
    select distinct header_cells
    from normalized_header_candidates
    where explicit_header or semantic_header_cells >= 2
  )
  select encode(digest(convert_to(jsonb_build_object(
    'format', lower(trim(p_document_format)),
    'extraction_contract_version', lower(trim(coalesce(
      p_extraction_payload ->> 'schema_version', 'unknown'
    ))),
    -- Repeated rows, tables and continuation pages are volume, not layout.
    'block_types', coalesce((
      select jsonb_agg(block_type order by block_type)
      from (
        select distinct value ->> 'type' as block_type
        from jsonb_array_elements(p_extraction_payload -> 'blocks') value
      ) types
    ), '[]'::jsonb),
    'table_column_shapes', coalesce((
      select jsonb_agg(column_count order by column_count)
      from (
        select distinct coalesce((
          select max(jsonb_array_length(row_value))
          from jsonb_array_elements(table_value -> 'rows') row_value
        ), 0) as column_count
        from table_entries
      ) shapes
    ), '[]'::jsonb),
    -- Header cells retain column order, while duplicate continuation headers and
    -- table/page order are collapsed so document volume cannot create drift.
    'table_headers', coalesce((
      select jsonb_agg(header_cells order by header_cells::text)
      from stable_headers
    ), '[]'::jsonb)
  )::text, 'UTF8'), 'sha256'), 'hex')
$$;
revoke all on function private.price_list_layout_signature(jsonb, text)
  from public, anon, authenticated, service_role;

create or replace function public.run_price_list_shadow(
  p_job_id uuid,
  p_interpretation_id uuid,
  p_actor_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_evaluator_version constant text := 'price-list-shadow-v1';
  v_job public.document_processing_jobs;
  v_i public.document_interpretations;
  v_ext public.document_extractions;
  v_doc public.documents;
  v_supplier public.suppliers;
  v_policy record;
  v_baseline numeric;
  v_threshold numeric;
  v_existing public.price_list_shadow_runs;
  v_run_id uuid := gen_random_uuid();
  v_actor uuid;
  v_supplier_id uuid;
  v_global_reason text;
  v_decision_confidence numeric;
  v_line jsonb;
  v_values jsonb;
  v_line_index integer;
  v_source_row integer;
  v_sku text;
  v_barcode text;
  v_product_name text;
  v_unit text;
  v_price_text text;
  v_price numeric;
  v_match jsonb;
  v_match_status text;
  v_matched_by text;
  v_product_id uuid;
  v_supplier_product_id uuid;
  v_current_price numeric;
  v_price_change_percent numeric;
  v_line_reason text;
  v_predicted_action text;
  v_seen_products uuid[] := array[]::uuid[];
  v_seen_candidate_keys text[] := array[]::text[];
  v_candidate_key text;
  v_evidence_ids text[];
  v_line_results jsonb := '[]'::jsonb;
  v_applicable integer := 0;
  v_waiting integer := 0;
  v_would_create integer := 0;
  v_outcome text;
  v_layout_signature text;
  v_page_count integer;
  v_block_count integer;
  v_table_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select * into v_i
  from public.document_interpretations i
  where i.id = p_interpretation_id and i.job_id = p_job_id;
  if not found then
    raise exception 'document_interpretation_unknown' using errcode = 'P0002';
  end if;

  select * into v_job
  from public.document_processing_jobs j
  where j.id = p_job_id and j.org_id = v_i.org_id
    and j.document_id = v_i.document_id;
  if not found then
    raise exception 'document_processing_job_unknown' using errcode = 'P0002';
  end if;

  select * into v_ext
  from public.document_extractions e
  where e.id = v_i.extraction_id and e.org_id = v_i.org_id
    and e.job_id = v_job.id and e.document_id = v_i.document_id;
  if not found then
    raise exception 'document_extraction_unknown' using errcode = 'P0002';
  end if;

  select * into v_doc
  from public.documents d
  where d.id = v_i.document_id and d.org_id = v_i.org_id
    and d.deleted_at is null;
  if not found then
    raise exception 'document_unknown' using errcode = 'P0002';
  end if;

  v_actor := coalesce(p_actor_id, v_doc.uploaded_by);
  if v_actor is distinct from v_doc.uploaded_by
     or v_job.requested_by is distinct from v_actor
     or v_job.interpretation_actor_id is distinct from v_actor
     or v_i.interpreted_for_user_id is distinct from v_actor
     or not exists (
       select 1 from public.profiles p
       where p.org_id = v_i.org_id and p.id = v_actor and p.active
         and p.role in ('owner', 'office', 'kitchen', 'supplier')
     ) then
    raise exception 'document_interpretation_actor_invalid' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('price-list-shadow:' || v_i.id::text || ':' || v_evaluator_version, 0)
  );
  select * into v_existing
  from public.price_list_shadow_runs r
  where r.org_id = v_i.org_id
    and r.interpretation_id = v_i.id
    and r.evaluator_version = v_evaluator_version;
  if found then
    return jsonb_build_object(
      'shadow_run_id', v_existing.id,
      'predicted_outcome', v_existing.predicted_outcome,
      'reason_code', v_existing.reason_code,
      'applicable_count', v_existing.applicable_count,
      'waiting_count', v_existing.waiting_count,
      'would_create_product_count', v_existing.would_create_product_count,
      'idempotent', true
    );
  end if;

  select * into v_policy
  from private.autonomy_policy_for_org(v_i.org_id, 'price_list.intake');
  select d.baseline_min_confidence into v_baseline
  from private.autonomy_policy_definitions d
  where d.policy_key = 'price_list.intake';
  if v_baseline is null then
    raise exception 'autonomy_policy_unknown' using errcode = 'P0002';
  end if;
  v_threshold := coalesce(v_policy.min_confidence, v_baseline);

  if not exists (
    select 1 from public.organizations o
    where o.id = v_i.org_id and o.status in ('trial', 'active')
  ) then
    v_global_reason := 'organization_inactive';
  elsif coalesce(v_policy.kill_switch, false) then
    v_global_reason := 'policy_kill_switch';
  elsif v_doc.document_kind <> 'price_list'
     or v_i.payload ->> 'document_type' <> 'price_list' then
    v_global_reason := 'not_a_price_list';
  elsif v_i.payload -> 'document_type_confidence' = 'null'::jsonb
     or v_i.payload -> 'supplier' -> 'confidence' = 'null'::jsonb then
    v_global_reason := 'confidence_unknown';
  else
    v_decision_confidence := least(
      (v_i.payload ->> 'document_type_confidence')::numeric,
      (v_i.payload -> 'supplier' ->> 'confidence')::numeric
    );
    if v_threshold is null or v_decision_confidence < v_threshold then
      v_global_reason := 'below_confidence_threshold';
    end if;
  end if;

  v_supplier_id := v_doc.supplier_id;
  if v_supplier_id is not null then
    select * into v_supplier
    from public.suppliers s
    where s.org_id = v_i.org_id and s.id = v_supplier_id and s.deleted_at is null;
  end if;
  if v_global_reason is null and (
    v_supplier_id is null
    or v_doc.entity_type <> 'supplier'
    or v_doc.entity_id is distinct from v_supplier_id
    or v_i.suggested_supplier_id is null
    or v_i.suggested_supplier_id is distinct from v_supplier_id
    or v_supplier.id is null
  ) then
    v_global_reason := 'supplier_unidentified';
  elsif v_global_reason is null
        and v_supplier.status not in ('active', 'problematic') then
    v_global_reason := 'supplier_inactive';
  end if;

  if jsonb_typeof(v_i.payload -> 'line_items') <> 'array' then
    raise exception 'document_interpretation_invalid' using errcode = '22023';
  end if;

  for v_line, v_line_index in
    select item.value, (item.ordinality - 1)::integer
    from jsonb_array_elements(v_i.payload -> 'line_items')
      with ordinality as item(value, ordinality)
  loop
    v_values := v_line -> 'values';
    v_source_row := case
      when jsonb_typeof(v_line -> 'source_row') = 'number'
        then (v_line ->> 'source_row')::integer
      else null
    end;
    v_sku := nullif(trim(v_values ->> 'sku'), '');
    v_barcode := nullif(trim(v_values ->> 'barcode'), '');
    v_product_name := nullif(trim(v_values ->> 'product_name'), '');
    v_unit := nullif(trim(v_values ->> 'unit'), '');
    v_price_text := trim(coalesce(v_values ->> 'unit_price', ''));
    select coalesce(array_agg(value order by ordinality), '{}'::text[])
      into v_evidence_ids
    from jsonb_array_elements_text(coalesce(v_line -> 'evidence_block_ids', '[]'::jsonb))
      with ordinality as evidence(value, ordinality);

    v_line_reason := v_global_reason;
    v_predicted_action := null;
    v_product_id := null;
    v_supplier_product_id := null;
    v_current_price := null;
    v_price_change_percent := null;
    v_matched_by := null;
    v_price := null;

    if v_line_reason is null then
      v_price_text := regexp_replace(v_price_text, '[[:space:]₪,]', '', 'g');
      if length(v_price_text) > 16
         or v_price_text !~ '^[0-9]+([.][0-9]{1,4})?$' then
        v_line_reason := 'line_price_unreadable';
      else
        v_price := round(v_price_text::numeric, 2);
        if v_price <= 0 or v_price > 1000000 then
          v_line_reason := 'line_price_unreadable';
        end if;
      end if;
    end if;

    if v_line_reason is null then
      v_match := private.match_price_list_line(
        v_i.org_id, v_supplier_id, v_sku, v_barcode
      );
      v_match_status := v_match ->> 'status';
      v_matched_by := v_match ->> 'matched_by';
      if v_match_status = 'ambiguous' then
        v_line_reason := 'line_product_ambiguous';
      elsif v_match_status = 'matched' then
        v_product_id := (v_match ->> 'product_id')::uuid;
        if v_product_id = any(v_seen_products) then
          v_line_reason := 'line_product_ambiguous';
        else
          v_seen_products := array_append(v_seen_products, v_product_id);
          v_predicted_action := 'apply_existing_price';
        end if;
      elsif (v_sku is null and v_barcode is null)
         or v_product_name is null
         or length(v_product_name) > 200
         or length(coalesce(v_sku, '')) > 200
         or length(coalesce(v_barcode, '')) > 200
         or length(coalesce(v_unit, '')) > 50 then
        v_line_reason := 'line_product_unmatched';
      else
        v_candidate_key := lower(coalesce(v_sku, '')) || '|'
          || lower(coalesce(v_barcode, ''));
        if v_candidate_key = any(v_seen_candidate_keys) then
          v_line_reason := 'line_product_ambiguous';
        else
          v_seen_candidate_keys := array_append(v_seen_candidate_keys, v_candidate_key);
          v_predicted_action := 'create_product';
        end if;
      end if;
    end if;

    if v_predicted_action = 'apply_existing_price' then
      select sp.id, sp.current_price
        into v_supplier_product_id, v_current_price
      from public.supplier_products sp
      where sp.org_id = v_i.org_id and sp.supplier_id = v_supplier_id
        and sp.product_id = v_product_id;
      if v_current_price is not null and v_current_price > 0 then
        v_price_change_percent := round(
          ((v_price - v_current_price) / v_current_price) * 100, 4
        );
      end if;
    end if;

    if v_line_reason is not null then
      v_predicted_action := case
        when v_line_reason in (
          'organization_inactive', 'policy_kill_switch', 'confidence_unknown',
          'below_confidence_threshold', 'supplier_inactive'
        ) then 'rejected_by_policy'
        else 'review'
      end;
      v_product_id := null;
      v_supplier_product_id := null;
      v_price := null;
      v_price_change_percent := null;
      v_waiting := v_waiting + 1;
    else
      v_applicable := v_applicable + 1;
      if v_predicted_action = 'create_product' then
        v_would_create := v_would_create + 1;
      end if;
    end if;

    v_line_results := v_line_results || jsonb_build_array(jsonb_build_object(
      'line_index', v_line_index,
      'source_row', v_source_row,
      'evidence_block_ids', to_jsonb(v_evidence_ids),
      'predicted_action', v_predicted_action,
      'reason_code', v_line_reason,
      'matched_by', v_matched_by,
      'product_id', v_product_id,
      'supplier_product_id', v_supplier_product_id,
      'sku', v_sku,
      'barcode', v_barcode,
      'product_name', v_product_name,
      'unit', v_unit,
      'proposed_unit_price', v_price,
      'current_unit_price', v_current_price,
      'price_change_percent', v_price_change_percent,
      'product_would_be_created', v_predicted_action = 'create_product'
    ));
  end loop;

  v_outcome := case
    when v_applicable = 0 then 'queued_for_review'
    when v_waiting > 0 then 'partially_applicable'
    else 'would_apply'
  end;
  if v_applicable = 0 and v_global_reason is null then
    select value ->> 'reason_code' into v_global_reason
    from jsonb_array_elements(v_line_results)
    order by (value ->> 'line_index')::integer
    limit 1;
    v_global_reason := coalesce(v_global_reason, 'no_line_items');
  end if;

  v_page_count := (v_ext.payload #>> '{document,page_count}')::integer;
  v_block_count := jsonb_array_length(v_ext.payload -> 'blocks');
  v_table_count := jsonb_array_length(v_ext.payload -> 'tables');
  v_layout_signature := private.price_list_layout_signature(v_ext.payload, v_doc.mime_type);

  perform set_config('app.price_list_shadow_writer', 'run', true);
  insert into public.price_list_shadow_runs (
    id, org_id, document_id, job_id, extraction_id, interpretation_id,
    actor_id, supplier_id, evaluator_version,
    policy_configured, live_policy_enabled, policy_kill_switch,
    evaluated_min_confidence, decision_confidence, predicted_outcome, reason_code,
    applicable_count, waiting_count, would_create_product_count,
    provider, model, prompt_version, schema_version, document_format,
    extraction_engine, extraction_model, extraction_model_version,
    page_count, block_count, table_count, interpreted_line_count, layout_signature
  ) values (
    v_run_id, v_i.org_id, v_doc.id, v_job.id, v_ext.id, v_i.id,
    v_actor, v_supplier_id, v_evaluator_version,
    coalesce(v_policy.configured, false), coalesce(v_policy.autonomy_enabled, false),
    coalesce(v_policy.kill_switch, false), v_threshold, v_decision_confidence,
    v_outcome, v_global_reason, v_applicable, v_waiting, v_would_create,
    v_i.provider, v_i.model, v_i.prompt_version, v_i.schema_version,
    lower(trim(v_doc.mime_type)), v_ext.engine, v_ext.model, v_ext.model_version,
    v_page_count, v_block_count, v_table_count,
    jsonb_array_length(v_i.payload -> 'line_items'), v_layout_signature
  );

  insert into public.price_list_shadow_lines (
    org_id, shadow_run_id, document_id, interpretation_id, line_index, source_row,
    evidence_block_ids, predicted_action, reason_code, matched_by,
    product_id, supplier_product_id, sku, barcode, product_name, unit,
    proposed_unit_price, current_unit_price, price_change_percent,
    product_would_be_created
  )
  select v_i.org_id, v_run_id, v_doc.id, v_i.id,
         (line ->> 'line_index')::integer,
         case when line ->> 'source_row' is null then null
              else (line ->> 'source_row')::integer end,
         array(
           select value
           from jsonb_array_elements_text(line -> 'evidence_block_ids') value
         ),
         line ->> 'predicted_action', line ->> 'reason_code', line ->> 'matched_by',
         case when line ->> 'product_id' is null then null
              else (line ->> 'product_id')::uuid end,
         case when line ->> 'supplier_product_id' is null then null
              else (line ->> 'supplier_product_id')::uuid end,
         line ->> 'sku', line ->> 'barcode', line ->> 'product_name', line ->> 'unit',
         case when line ->> 'proposed_unit_price' is null then null
              else (line ->> 'proposed_unit_price')::numeric end,
         case when line ->> 'current_unit_price' is null then null
              else (line ->> 'current_unit_price')::numeric end,
         case when line ->> 'price_change_percent' is null then null
              else (line ->> 'price_change_percent')::numeric end,
         (line ->> 'product_would_be_created')::boolean
  from jsonb_array_elements(v_line_results) line;
  perform set_config('app.price_list_shadow_writer', '', true);

  return jsonb_build_object(
    'shadow_run_id', v_run_id,
    'predicted_outcome', v_outcome,
    'reason_code', v_global_reason,
    'applicable_count', v_applicable,
    'waiting_count', v_waiting,
    'would_create_product_count', v_would_create,
    'idempotent', false
  );
end
$$;

revoke all on function public.run_price_list_shadow(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.run_price_list_shadow(uuid, uuid, uuid)
  to service_role;

comment on function public.run_price_list_shadow(uuid, uuid, uuid) is
  'Service-only, immutable shadow evaluation of one stored price-list interpretation. It reads '
  'the live policy threshold but ignores the live enable switch so an unconfigured/new supplier '
  'can be measured safely. It never calls the price/catalog writer and never changes policy.';

-- ===== 3. Owner-reviewed calibration revisions =====

create or replace function public.record_price_list_calibration_review(
  p_shadow_line_id uuid,
  p_idempotency_key uuid,
  p_verdict text,
  p_error_labels text[],
  p_expected_action text,
  p_expected_product_id uuid,
  p_expected_unit_price numeric,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_reason text := private.document_text_sanitize(p_reason);
  v_labels text[] := coalesce(p_error_labels, '{}'::text[]);
  v_line public.price_list_shadow_lines;
  v_run public.price_list_shadow_runs;
  v_existing public.price_list_calibration_reviews;
  v_revision integer;
  v_id uuid := gen_random_uuid();
begin
  if v_org is null or v_user is null or auth_role() <> 'owner' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'idempotency_key_required' using errcode = '22023';
  end if;
  if v_reason is null or v_reason !~ '[[:graph:]]' then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if length(v_reason) > 1000 then
    raise exception 'reason_too_long' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'price-list-calibration:' || v_org::text || ':' || p_idempotency_key::text,
      0
    )
  );
  select * into v_existing
  from public.price_list_calibration_reviews r
  where r.org_id = v_org and r.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.shadow_line_id is distinct from p_shadow_line_id
       or v_existing.verdict is distinct from p_verdict
       or v_existing.error_labels is distinct from v_labels
       or v_existing.expected_action is distinct from p_expected_action
       or v_existing.expected_product_id is distinct from p_expected_product_id
       or v_existing.expected_unit_price is distinct from p_expected_unit_price
       or v_existing.reason is distinct from v_reason then
      raise exception 'calibration_review_idempotency_conflict' using errcode = '55000';
    end if;
    return jsonb_build_object(
      'review_id', v_existing.id,
      'revision', v_existing.revision,
      'idempotent', true
    );
  end if;

  select * into v_line
  from public.price_list_shadow_lines l
  where l.org_id = v_org and l.id = p_shadow_line_id
  for share;
  if not found then
    raise exception 'price_list_shadow_line_unknown' using errcode = 'P0002';
  end if;
  select * into v_run
  from public.price_list_shadow_runs r
  where r.org_id = v_org and r.id = v_line.shadow_run_id
  for update;
  if not found then
    raise exception 'price_list_shadow_run_unknown' using errcode = 'P0002';
  end if;

  if p_verdict not in ('correct', 'incorrect', 'ambiguous', 'rejected_by_policy')
     or p_expected_action not in (
       'apply_existing_price', 'create_product', 'review', 'rejected_by_policy'
     )
     or not (
       v_labels <@ array[
         'incorrect_action', 'incorrect_product_match', 'incorrect_new_product', 'incorrect_price',
         'ambiguous', 'rejected_by_policy'
       ]::text[]
     ) then
    raise exception 'calibration_review_invalid' using errcode = '22023';
  end if;
  if p_verdict = 'correct' and (
       p_expected_action is distinct from v_line.predicted_action
       or p_expected_product_id is distinct from v_line.product_id
       or p_expected_unit_price is distinct from v_line.proposed_unit_price
     ) then
    raise exception 'calibration_review_contradicts_prediction' using errcode = '22023';
  end if;
  if p_verdict = 'incorrect' and (
       p_expected_action is not distinct from v_line.predicted_action
       and p_expected_product_id is not distinct from v_line.product_id
       and p_expected_unit_price is not distinct from v_line.proposed_unit_price
     ) then
    raise exception 'calibration_review_contradicts_prediction' using errcode = '22023';
  end if;
  if 'incorrect_product_match' = any(v_labels) and (
       v_line.predicted_action <> 'apply_existing_price'
       or (
         p_expected_action = 'apply_existing_price'
         and p_expected_product_id is not distinct from v_line.product_id
       )
     ) then
    raise exception 'calibration_review_label_mismatch' using errcode = '22023';
  end if;
  if 'incorrect_new_product' = any(v_labels) and (
       v_line.predicted_action <> 'create_product'
       or p_expected_action = 'create_product'
     ) then
    raise exception 'calibration_review_label_mismatch' using errcode = '22023';
  end if;
  if 'incorrect_price' = any(v_labels)
     and p_expected_unit_price is not distinct from v_line.proposed_unit_price then
    raise exception 'calibration_review_label_mismatch' using errcode = '22023';
  end if;
  if 'incorrect_action' = any(v_labels)
     and p_expected_action is not distinct from v_line.predicted_action then
    raise exception 'calibration_review_label_mismatch' using errcode = '22023';
  end if;

  select coalesce(max(r.revision), 0) + 1 into v_revision
  from public.price_list_calibration_reviews r
  where r.org_id = v_org and r.shadow_line_id = v_line.id;

  perform set_config('app.price_list_calibration_writer', 'record', true);
  insert into public.price_list_calibration_reviews (
    id, org_id, shadow_run_id, shadow_line_id, document_id, interpretation_id,
    revision, idempotency_key, reviewer_id, verdict, error_labels,
    expected_action, expected_product_id, expected_unit_price, reason
  ) values (
    v_id, v_org, v_run.id, v_line.id, v_line.document_id, v_line.interpretation_id,
    v_revision, p_idempotency_key, v_user, p_verdict, v_labels,
    p_expected_action, p_expected_product_id, p_expected_unit_price, v_reason
  );
  perform set_config('app.price_list_calibration_writer', '', true);

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_org, v_user, 'price_list_calibration_review_recorded',
    'price_list_calibration_reviews', v_id,
    jsonb_build_object(
      'shadow_run_id', v_run.id,
      'shadow_line_id', v_line.id,
      'revision', v_revision,
      'verdict', p_verdict,
      'error_labels', to_jsonb(v_labels),
      'expected_action', p_expected_action
    ),
    v_reason
  );

  return jsonb_build_object(
    'review_id', v_id,
    'revision', v_revision,
    'idempotent', false
  );
end
$$;

revoke all on function public.record_price_list_calibration_review(
  uuid, uuid, text, text[], text, uuid, numeric, text
) from public, anon, service_role;
grant execute on function public.record_price_list_calibration_review(
  uuid, uuid, text, text[], text, uuid, numeric, text
) to authenticated;

create or replace function public.record_price_list_empty_run_review(
  p_shadow_run_id uuid,
  p_idempotency_key uuid,
  p_verdict text,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_reason text := nullif(trim(p_reason), '');
  v_run public.price_list_shadow_runs;
  v_existing public.price_list_empty_run_reviews;
  v_revision integer;
  v_id uuid := gen_random_uuid();
begin
  if v_org is null or v_user is null or auth_role() <> 'owner' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_idempotency_key is null or p_verdict not in (
    'correct', 'incorrect', 'ambiguous', 'rejected_by_policy'
  ) then
    raise exception 'empty_run_review_invalid' using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if length(v_reason) > 1000 then
    raise exception 'reason_too_long' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'price-list-empty-review:' || v_org::text || ':' || p_idempotency_key::text, 0
  ));
  select * into v_existing
  from public.price_list_empty_run_reviews review
  where review.org_id = v_org and review.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.shadow_run_id is distinct from p_shadow_run_id
       or v_existing.verdict is distinct from p_verdict
       or v_existing.reason is distinct from v_reason then
      raise exception 'empty_run_review_idempotency_conflict' using errcode = '55000';
    end if;
    return jsonb_build_object(
      'review_id', v_existing.id, 'revision', v_existing.revision, 'idempotent', true
    );
  end if;

  select * into v_run
  from public.price_list_shadow_runs run
  where run.org_id = v_org and run.id = p_shadow_run_id
  for update;
  if not found then
    raise exception 'price_list_shadow_run_unknown' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.price_list_shadow_lines line
    where line.org_id = v_org and line.shadow_run_id = v_run.id
  ) then
    raise exception 'price_list_shadow_run_not_empty' using errcode = '22023';
  end if;

  select coalesce(max(review.revision), 0) + 1 into v_revision
  from public.price_list_empty_run_reviews review
  where review.org_id = v_org and review.shadow_run_id = v_run.id;

  perform set_config('app.price_list_empty_review_writer', 'record', true);
  insert into public.price_list_empty_run_reviews (
    id, org_id, shadow_run_id, document_id, interpretation_id, revision,
    idempotency_key, reviewer_id, verdict, reason
  ) values (
    v_id, v_org, v_run.id, v_run.document_id, v_run.interpretation_id, v_revision,
    p_idempotency_key, v_user, p_verdict, v_reason
  );
  perform set_config('app.price_list_empty_review_writer', '', true);

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_org, v_user, 'price_list_empty_run_review_recorded',
    'price_list_empty_run_reviews', v_id,
    jsonb_build_object(
      'shadow_run_id', v_run.id, 'revision', v_revision, 'verdict', p_verdict
    ),
    v_reason
  );

  return jsonb_build_object('review_id', v_id, 'revision', v_revision, 'idempotent', false);
end
$$;

revoke all on function public.record_price_list_empty_run_review(uuid, uuid, text, text)
  from public, anon, service_role;
grant execute on function public.record_price_list_empty_run_review(uuid, uuid, text, text)
  to authenticated;

-- ===== 4. Owner-only calibration, drift, and operations read models =====

create or replace function public.get_price_list_calibration_metrics(
  p_from timestamptz default null,
  p_to timestamptz default null
) returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  if auth_org() is null or auth.uid() is null or auth_role() <> 'owner' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_from is not null and p_to is not null and p_from >= p_to then
    raise exception 'invalid_time_window' using errcode = '22023';
  end if;

  with latest_review as (
    select distinct on (r.org_id, r.shadow_line_id)
           r.org_id, r.shadow_line_id, r.verdict, r.error_labels,
           r.expected_action, r.expected_product_id, r.expected_unit_price,
           r.revision, r.created_at
    from public.price_list_calibration_reviews r
    where r.org_id = auth_org()
    order by r.org_id, r.shadow_line_id, r.revision desc
  ), latest_empty_review as (
    select distinct on (r.org_id, r.shadow_run_id)
           r.org_id, r.shadow_run_id, r.verdict, r.revision
    from public.price_list_empty_run_reviews r
    where r.org_id = auth_org()
    order by r.org_id, r.shadow_run_id, r.revision desc
  ), base as (
    select run.id as run_id, run.document_id, run.supplier_id,
           run.document_format, run.provider, run.model, run.prompt_version,
           run.decision_confidence, line.id as shadow_line_id,
           line.line_index, line.predicted_action, line.reason_code,
           actual.outcome as actual_outcome,
           review.verdict, review.error_labels, review.expected_action,
           review.expected_product_id, review.expected_unit_price
    from public.price_list_shadow_runs run
    join public.price_list_shadow_lines line
      on line.org_id = run.org_id and line.shadow_run_id = run.id
    left join public.price_list_interpretation_lines actual
      on actual.org_id = run.org_id
     and actual.interpretation_id = run.interpretation_id
     and actual.line_index = line.line_index
    left join latest_review review
      on review.org_id = line.org_id and review.shadow_line_id = line.id
    where run.org_id = auth_org()
      and (p_from is null or run.created_at >= p_from)
      and (p_to is null or run.created_at < p_to)
  ), document_review as (
    select document_id, count(*) as line_count,
           count(*) filter (where verdict is not null) as reviewed_count
    from base
    group by document_id
  ), empty_document_review as (
    select run.document_id, 1::bigint as line_count,
           case when review.shadow_run_id is null then 0 else 1 end::bigint as reviewed_count
    from public.price_list_shadow_runs run
    left join latest_empty_review review
      on review.org_id = run.org_id and review.shadow_run_id = run.id
    where run.org_id = auth_org()
      and (p_from is null or run.created_at >= p_from)
      and (p_to is null or run.created_at < p_to)
      and not exists (
        select 1 from public.price_list_shadow_lines line
        where line.org_id = run.org_id and line.shadow_run_id = run.id
      )
  ), corpus_document_review as (
    select document_id, sum(line_count) as line_count, sum(reviewed_count) as reviewed_count
    from (
      select * from document_review
      union all
      select * from empty_document_review
    ) evidence
    group by document_id
  ), run_confidence as (
    select distinct run_id, decision_confidence
    from base
  ), overall as (
    select count(*)::bigint as interpreted_rows,
           count(*) filter (
             where predicted_action in ('apply_existing_price', 'create_product')
           )::bigint as predicted_applicable_rows,
           count(*) filter (where actual_outcome = 'applied')::bigint
             as automatically_applied_rows,
           count(*) filter (where verdict is not null)::bigint as reviewed_rows,
           count(*) filter (where verdict = 'incorrect')::bigint
             as human_corrected_rows,
           count(*) filter (
             where 'incorrect_product_match' = any(error_labels)
           )::bigint as incorrect_product_matches,
           count(*) filter (
             where 'incorrect_new_product' = any(error_labels)
           )::bigint as incorrect_new_products,
           count(*) filter (
             where 'incorrect_price' = any(error_labels)
           )::bigint as incorrect_prices,
           count(*) filter (
             where verdict = 'ambiguous' or 'ambiguous' = any(error_labels)
           )::bigint as ambiguous_rows,
           count(*) filter (
             where predicted_action = 'rejected_by_policy'
                or 'rejected_by_policy' = any(error_labels)
           )::bigint as policy_rejected_rows,
           count(*) filter (where verdict = 'correct')::numeric
             / nullif(count(*) filter (where verdict in ('correct', 'incorrect')), 0)
             as accuracy
    from base
  ), supplier_metrics as (
    select supplier_id,
           count(*)::bigint as interpreted_rows,
           count(*) filter (where verdict is not null)::bigint as reviewed_rows,
           count(*) filter (where verdict = 'incorrect')::bigint as corrected_rows,
           count(*) filter (where verdict = 'correct')::numeric
             / nullif(count(*) filter (where verdict in ('correct', 'incorrect')), 0) as accuracy
    from base
    group by supplier_id
  ), format_metrics as (
    select document_format,
           count(*)::bigint as interpreted_rows,
           count(*) filter (where verdict is not null)::bigint as reviewed_rows,
           count(*) filter (where verdict = 'incorrect')::bigint as corrected_rows,
           count(*) filter (where verdict = 'correct')::numeric
             / nullif(count(*) filter (where verdict in ('correct', 'incorrect')), 0) as accuracy
    from base
    group by document_format
  ), version_metrics as (
    select provider, model, prompt_version,
           count(*)::bigint as interpreted_rows,
           count(*) filter (where verdict is not null)::bigint as reviewed_rows,
           count(*) filter (where verdict = 'incorrect')::bigint as corrected_rows,
           count(*) filter (where verdict = 'correct')::numeric
             / nullif(count(*) filter (where verdict in ('correct', 'incorrect')), 0) as accuracy
    from base
    group by provider, model, prompt_version
  )
  select jsonb_build_object(
    'target_document_count', 50,
    'reviewed_document_count', (
      select count(*) from corpus_document_review where reviewed_count > 0
    ),
    'fully_reviewed_document_count', (
      select count(*) from corpus_document_review where reviewed_count = line_count
    ),
    'remaining_fully_reviewed_documents', greatest(
      50 - (select count(*) from corpus_document_review where reviewed_count = line_count), 0
    ),
    'zero_line_document_count', (select count(*) from empty_document_review),
    'reviewed_zero_line_document_count', (
      select count(*) from empty_document_review where reviewed_count = 1
    ),
    'total_interpreted_rows', overall.interpreted_rows,
    'predicted_applicable_rows', overall.predicted_applicable_rows,
    'automatically_applied_rows', overall.automatically_applied_rows,
    'reviewed_rows', overall.reviewed_rows,
    'human_corrected_rows', overall.human_corrected_rows,
    'incorrect_product_matches', overall.incorrect_product_matches,
    'incorrect_new_products', overall.incorrect_new_products,
    'incorrect_prices', overall.incorrect_prices,
    'ambiguous_rows', overall.ambiguous_rows,
    'policy_rejected_rows', overall.policy_rejected_rows,
    'accuracy', overall.accuracy,
    'confidence_distribution', jsonb_build_object(
      'p10', (select percentile_cont(0.10) within group (order by decision_confidence)
              from run_confidence where decision_confidence is not null),
      'p50', (select percentile_cont(0.50) within group (order by decision_confidence)
              from run_confidence where decision_confidence is not null),
      'p90', (select percentile_cont(0.90) within group (order by decision_confidence)
              from run_confidence where decision_confidence is not null)
    ),
    'by_supplier', coalesce((
      select jsonb_agg(jsonb_build_object(
        'supplier_id', supplier_id,
        'interpreted_rows', interpreted_rows,
        'reviewed_rows', reviewed_rows,
        'human_corrected_rows', corrected_rows,
        'accuracy', accuracy
      ) order by supplier_id nulls last)
      from supplier_metrics
    ), '[]'::jsonb),
    'by_document_format', coalesce((
      select jsonb_agg(jsonb_build_object(
        'document_format', document_format,
        'interpreted_rows', interpreted_rows,
        'reviewed_rows', reviewed_rows,
        'human_corrected_rows', corrected_rows,
        'accuracy', accuracy
      ) order by document_format)
      from format_metrics
    ), '[]'::jsonb),
    'by_interpretation_version', coalesce((
      select jsonb_agg(jsonb_build_object(
        'provider', provider,
        'model', model,
        'prompt_version', prompt_version,
        'interpreted_rows', interpreted_rows,
        'reviewed_rows', reviewed_rows,
        'human_corrected_rows', corrected_rows,
        'accuracy', accuracy
      ) order by provider, model, prompt_version)
      from version_metrics
    ), '[]'::jsonb)
  ) into v_result
  from overall;

  return v_result;
end
$$;

revoke all on function public.get_price_list_calibration_metrics(timestamptz, timestamptz)
  from public, anon, service_role;
grant execute on function public.get_price_list_calibration_metrics(timestamptz, timestamptz)
  to authenticated;

create or replace function public.get_price_list_calibration_queue(
  p_document_limit integer default 50
) returns table (
  shadow_run_id uuid,
  shadow_line_id uuid,
  document_id uuid,
  file_name text,
  supplier_id uuid,
  supplier_name text,
  decision_confidence numeric,
  line_index integer,
  source_row integer,
  predicted_action text,
  reason_code text,
  matched_by text,
  product_id uuid,
  matched_product_name text,
  sku text,
  barcode text,
  product_name text,
  unit text,
  proposed_unit_price numeric,
  current_unit_price numeric,
  price_change_percent numeric,
  document_line_count bigint,
  document_reviewed_count bigint,
  is_empty_run boolean
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if auth_org() is null or auth.uid() is null or auth_role() <> 'owner' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_document_limit is null or p_document_limit < 1 or p_document_limit > 50 then
    raise exception 'invalid_document_limit' using errcode = '22023';
  end if;

  return query
  with latest_review as (
    select distinct on (review.shadow_line_id)
           review.shadow_line_id, review.revision
    from public.price_list_calibration_reviews review
    where review.org_id = auth_org()
    order by review.shadow_line_id, review.revision desc
  ), latest_empty_review as (
    select distinct on (review.shadow_run_id)
           review.shadow_run_id, review.revision
    from public.price_list_empty_run_reviews review
    where review.org_id = auth_org()
    order by review.shadow_run_id, review.revision desc
  ), run_progress as (
    select run.id, run.created_at,
           count(line.id) as line_count,
           count(latest.shadow_line_id) as reviewed_count,
           bool_or(empty_review.shadow_run_id is not null) as empty_reviewed
    from public.price_list_shadow_runs run
    left join public.price_list_shadow_lines line
      on line.org_id = run.org_id and line.shadow_run_id = run.id
    left join latest_review latest on latest.shadow_line_id = line.id
    left join latest_empty_review empty_review on empty_review.shadow_run_id = run.id
    where run.org_id = auth_org()
    group by run.id, run.created_at
    having (count(line.id) > 0 and count(latest.shadow_line_id) < count(line.id))
        or (count(line.id) = 0 and not bool_or(empty_review.shadow_run_id is not null))
    order by run.created_at, run.id
    limit p_document_limit
  )
  select run.id, line.id, run.document_id, document.file_name,
         run.supplier_id, supplier.name, run.decision_confidence,
         coalesce(line.line_index, 0), line.source_row,
         coalesce(line.predicted_action, 'review'),
         coalesce(line.reason_code, 'no_line_items'),
         line.matched_by, line.product_id, product.name, line.sku, line.barcode,
         line.product_name, line.unit, line.proposed_unit_price,
         line.current_unit_price, line.price_change_percent,
         progress.line_count, progress.reviewed_count, line.id is null
  from run_progress progress
  join public.price_list_shadow_runs run on run.id = progress.id
  left join public.price_list_shadow_lines line
    on line.org_id = run.org_id and line.shadow_run_id = run.id
  left join latest_review latest on latest.shadow_line_id = line.id
  join public.documents document
    on document.org_id = run.org_id and document.id = run.document_id
  left join public.suppliers supplier
    on supplier.org_id = run.org_id and supplier.id = run.supplier_id
  left join public.products product
    on product.org_id = run.org_id and product.id = line.product_id
  where line.id is null or latest.shadow_line_id is null
  order by progress.created_at, run.id, line.line_index;
end
$$;

revoke all on function public.get_price_list_calibration_queue(integer)
  from public, anon, service_role;
grant execute on function public.get_price_list_calibration_queue(integer)
  to authenticated;

-- Numeric deltas below are an owner read model only. They never write an
-- eligibility decision and never synthesize an automatic drift threshold.
create or replace function public.get_price_list_drift_metrics(
  p_window_days integer default 30
) returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_result jsonb;
begin
  if auth_org() is null or auth.uid() is null or auth_role() <> 'owner' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_window_days is null or p_window_days < 1 or p_window_days > 365 then
    raise exception 'invalid_window_days' using errcode = '22023';
  end if;

  with base as (
    select run.id as run_id, run.supplier_id, run.document_format,
           run.provider, run.model, run.prompt_version,
           run.extraction_engine, run.extraction_model, run.extraction_model_version,
           run.layout_signature, run.decision_confidence, run.created_at,
           line.predicted_action, line.reason_code, line.price_change_percent,
           case when run.created_at >= v_now - make_interval(days => p_window_days)
                then 'current' else 'prior' end as period
    from public.price_list_shadow_runs run
    left join public.price_list_shadow_lines line
      on line.org_id = run.org_id and line.shadow_run_id = run.id
    where run.org_id = auth_org()
      and run.created_at >= v_now - make_interval(days => p_window_days * 2)
      and run.created_at < v_now
  ), groups as (
    select distinct supplier_id, document_format, provider, model, prompt_version,
           extraction_engine, extraction_model, extraction_model_version
    from base
  ), aggregated as (
    select g.supplier_id, g.document_format, g.provider, g.model, g.prompt_version,
      g.extraction_engine, g.extraction_model, g.extraction_model_version,
      (select count(distinct b.run_id) from base b
       where b.period = 'current'
         and b.supplier_id is not distinct from g.supplier_id
         and b.document_format = g.document_format
         and b.provider = g.provider and b.model = g.model
         and b.prompt_version = g.prompt_version
         and b.extraction_engine = g.extraction_engine
         and b.extraction_model = g.extraction_model
         and b.extraction_model_version = g.extraction_model_version) as current_run_count,
      (select count(distinct b.run_id) from base b
       where b.period = 'prior'
         and b.supplier_id is not distinct from g.supplier_id
         and b.document_format = g.document_format
         and b.provider = g.provider and b.model = g.model
         and b.prompt_version = g.prompt_version
         and b.extraction_engine = g.extraction_engine
         and b.extraction_model = g.extraction_model
         and b.extraction_model_version = g.extraction_model_version) as prior_run_count,
      (select count(b.predicted_action) from base b
       where b.period = 'current'
         and b.supplier_id is not distinct from g.supplier_id
         and b.document_format = g.document_format
         and b.provider = g.provider and b.model = g.model
         and b.prompt_version = g.prompt_version
         and b.extraction_engine = g.extraction_engine
         and b.extraction_model = g.extraction_model
         and b.extraction_model_version = g.extraction_model_version) as current_rows,
      (select count(b.predicted_action) from base b
       where b.period = 'prior'
         and b.supplier_id is not distinct from g.supplier_id
         and b.document_format = g.document_format
         and b.provider = g.provider and b.model = g.model
         and b.prompt_version = g.prompt_version
         and b.extraction_engine = g.extraction_engine
         and b.extraction_model = g.extraction_model
         and b.extraction_model_version = g.extraction_model_version) as prior_rows,
      (select count(b.predicted_action) filter (where b.reason_code = 'line_product_unmatched')::numeric
                / nullif(count(b.predicted_action), 0)
       from base b where b.period = 'current'
         and b.supplier_id is not distinct from g.supplier_id
         and b.document_format = g.document_format
         and b.provider = g.provider and b.model = g.model
         and b.prompt_version = g.prompt_version
         and b.extraction_engine = g.extraction_engine
         and b.extraction_model = g.extraction_model
         and b.extraction_model_version = g.extraction_model_version) as current_unmatched_rate,
      (select count(b.predicted_action) filter (where b.reason_code = 'line_product_unmatched')::numeric
                / nullif(count(b.predicted_action), 0)
       from base b where b.period = 'prior'
         and b.supplier_id is not distinct from g.supplier_id
         and b.document_format = g.document_format
         and b.provider = g.provider and b.model = g.model
         and b.prompt_version = g.prompt_version
         and b.extraction_engine = g.extraction_engine
         and b.extraction_model = g.extraction_model
         and b.extraction_model_version = g.extraction_model_version) as prior_unmatched_rate,
      (select count(b.predicted_action) filter (where b.predicted_action = 'create_product')::numeric
                / nullif(count(b.predicted_action), 0)
       from base b where b.period = 'current'
         and b.supplier_id is not distinct from g.supplier_id
         and b.document_format = g.document_format
         and b.provider = g.provider and b.model = g.model
         and b.prompt_version = g.prompt_version
         and b.extraction_engine = g.extraction_engine
         and b.extraction_model = g.extraction_model
         and b.extraction_model_version = g.extraction_model_version) as current_created_rate,
      (select count(b.predicted_action) filter (where b.predicted_action = 'create_product')::numeric
                / nullif(count(b.predicted_action), 0)
       from base b where b.period = 'prior'
         and b.supplier_id is not distinct from g.supplier_id
         and b.document_format = g.document_format
         and b.provider = g.provider and b.model = g.model
         and b.prompt_version = g.prompt_version
         and b.extraction_engine = g.extraction_engine
         and b.extraction_model = g.extraction_model
         and b.extraction_model_version = g.extraction_model_version) as prior_created_rate,
      (select avg(b.decision_confidence) from (
         select distinct run_id, decision_confidence from base b0
         where b0.period = 'current'
           and b0.supplier_id is not distinct from g.supplier_id
           and b0.document_format = g.document_format
           and b0.provider = g.provider and b0.model = g.model
           and b0.prompt_version = g.prompt_version
           and b0.extraction_engine = g.extraction_engine
           and b0.extraction_model = g.extraction_model
           and b0.extraction_model_version = g.extraction_model_version
       ) b) as current_mean_confidence,
      (select avg(b.decision_confidence) from (
         select distinct run_id, decision_confidence from base b0
         where b0.period = 'prior'
           and b0.supplier_id is not distinct from g.supplier_id
           and b0.document_format = g.document_format
           and b0.provider = g.provider and b0.model = g.model
           and b0.prompt_version = g.prompt_version
           and b0.extraction_engine = g.extraction_engine
           and b0.extraction_model = g.extraction_model
           and b0.extraction_model_version = g.extraction_model_version
       ) b) as prior_mean_confidence,
      (select percentile_cont(0.90) within group (
          order by abs(b.price_change_percent)
       ) from base b where b.period = 'current'
         and b.supplier_id is not distinct from g.supplier_id
         and b.document_format = g.document_format
         and b.provider = g.provider and b.model = g.model
         and b.prompt_version = g.prompt_version
         and b.extraction_engine = g.extraction_engine
         and b.extraction_model = g.extraction_model
         and b.extraction_model_version = g.extraction_model_version
         and b.price_change_percent is not null) as current_price_change_p90,
      (select max(abs(b.price_change_percent)) from base b
       where b.period = 'current'
         and b.supplier_id is not distinct from g.supplier_id
         and b.document_format = g.document_format
         and b.provider = g.provider and b.model = g.model
         and b.prompt_version = g.prompt_version
         and b.extraction_engine = g.extraction_engine
         and b.extraction_model = g.extraction_model
         and b.extraction_model_version = g.extraction_model_version
         and b.price_change_percent is not null) as current_price_change_max,
      (select count(distinct current_run.layout_signature)
       from base current_run
       where current_run.period = 'current'
         and current_run.supplier_id is not distinct from g.supplier_id
         and current_run.document_format = g.document_format
         and current_run.provider = g.provider and current_run.model = g.model
         and current_run.prompt_version = g.prompt_version
         and current_run.extraction_engine = g.extraction_engine
         and current_run.extraction_model = g.extraction_model
         and current_run.extraction_model_version = g.extraction_model_version
         and not exists (
           select 1 from base prior_run
           where prior_run.period = 'prior'
             and prior_run.supplier_id is not distinct from g.supplier_id
             and prior_run.document_format = g.document_format
             and prior_run.provider = g.provider and prior_run.model = g.model
             and prior_run.prompt_version = g.prompt_version
             and prior_run.extraction_engine = g.extraction_engine
             and prior_run.extraction_model = g.extraction_model
             and prior_run.extraction_model_version = g.extraction_model_version
             and prior_run.layout_signature = current_run.layout_signature
         )) as new_layout_count
    from groups g
  )
  select jsonb_build_object(
    'window_days', p_window_days,
    'current_window_started_at', v_now - make_interval(days => p_window_days),
    'prior_window_started_at', v_now - make_interval(days => p_window_days * 2),
    'measured_at', v_now,
    'groups', coalesce(jsonb_agg(jsonb_build_object(
      'supplier_id', supplier_id,
      'document_format', document_format,
      'provider', provider,
      'model', model,
      'prompt_version', prompt_version,
      'extraction_engine', extraction_engine,
      'extraction_model', extraction_model,
      'extraction_model_version', extraction_model_version,
      'current_run_count', current_run_count,
      'prior_run_count', prior_run_count,
      'current_rows', current_rows,
      'prior_rows', prior_rows,
      'current_unmatched_rate', current_unmatched_rate,
      'prior_unmatched_rate', case when prior_rows = 0 then null else prior_unmatched_rate end,
      'unmatched_rate_delta', case when prior_rows = 0 then null
        else current_unmatched_rate - prior_unmatched_rate end,
      'current_created_product_rate', current_created_rate,
      'prior_created_product_rate', case when prior_rows = 0 then null
        else prior_created_rate end,
      'created_product_rate_delta', case when prior_rows = 0 then null
        else current_created_rate - prior_created_rate end,
      'current_mean_confidence', current_mean_confidence,
      'prior_mean_confidence', case when prior_run_count = 0 then null
        else prior_mean_confidence end,
      'mean_confidence_delta', case when prior_run_count = 0 then null
        else current_mean_confidence - prior_mean_confidence end,
      'absolute_price_change_p90', current_price_change_p90,
      'absolute_price_change_max', current_price_change_max,
      'new_layout_count', case when prior_run_count = 0 then null else new_layout_count end,
      'layout_change_detected', case when prior_run_count = 0 then null
        else new_layout_count > 0 end
    ) order by supplier_id nulls last, document_format, provider, model, prompt_version,
               extraction_engine, extraction_model, extraction_model_version),
    '[]'::jsonb)
  ) into v_result
  from aggregated;

  return v_result;
end
$$;

revoke all on function public.get_price_list_drift_metrics(integer)
  from public, anon, service_role;
grant execute on function public.get_price_list_drift_metrics(integer)
  to authenticated;

create or replace function public.get_document_operations_metrics(
  p_window_days integer default 30
) returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_since timestamptz;
  v_result jsonb;
begin
  if auth_org() is null or auth.uid() is null or auth_role() <> 'owner' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_window_days is null or p_window_days < 1 or p_window_days > 365 then
    raise exception 'invalid_window_days' using errcode = '22023';
  end if;
  v_since := statement_timestamp() - make_interval(days => p_window_days);

  with jobs as (
    select j.*
    from public.document_processing_jobs j
    where j.org_id = auth_org()
  ), current_jobs as (
    select distinct on (j.document_id) j.*
    from jobs j
    order by j.document_id, j.created_at desc, j.id desc
  ), timed as (
    select j.id as job_id, e.duration_ms as extraction_duration_ms,
           i.duration_ms as interpretation_duration_ms,
           case when e.duration_ms is not null and i.duration_ms is not null
                then e.duration_ms + i.duration_ms else null end as total_duration_ms,
           i.usage
    from jobs j
    left join public.document_extractions e
      on e.org_id = j.org_id and e.job_id = j.id
    left join public.document_interpretations i
      on i.org_id = j.org_id and i.job_id = j.id
    where j.created_at >= v_since
  ), latest_failure as (
    select j.last_error_code, j.last_error_message, j.updated_at
    from jobs j
    where j.status = 'failed'
    order by j.updated_at desc, j.id desc
    limit 1
  ), latest_interpretation as (
    select i.provider, i.model, i.prompt_version, i.schema_version, i.created_at
    from public.document_interpretations i
    where i.org_id = auth_org()
    order by i.created_at desc, i.id desc
    limit 1
  ), price_counts as (
    select count(*) filter (where d.outcome = 'auto_applied') as automatically_applied,
           count(*) filter (where d.outcome = 'partially_applied') as partially_applied,
           count(*) filter (where d.outcome = 'queued_for_review') as review_required,
           count(*) filter (where d.reverted_at is not null) as reverted
    from public.price_list_interpretation_decisions d
    where d.org_id = auth_org() and d.created_at >= v_since
  )
  select jsonb_build_object(
    'window_days', p_window_days,
    'documents_waiting', count(*) filter (where j.status = 'queued'),
    'documents_processing', count(*) filter (
      where j.status in ('leased', 'extracted', 'interpreting')
    ),
    'documents_completed', count(*) filter (where j.status = 'completed'),
    'documents_review_required', count(*) filter (where j.status = 'review'),
    'documents_failed', count(*) filter (where j.status = 'failed'),
    'oldest_queue_age_seconds', (
      select extract(epoch from (statement_timestamp() - min(created_at)))::bigint
      from current_jobs where status = 'queued'
    ),
    'retry_count', (
      select coalesce(sum(greatest(attempt_count - 1, 0)), 0)
      from jobs where created_at >= v_since
    ),
    'average_processing_duration_ms', (
      select avg(total_duration_ms) from timed where total_duration_ms is not null
    ),
    'last_failure', (
      select jsonb_build_object(
        'code', last_error_code,
        'message', last_error_message,
        'at', updated_at
      ) from latest_failure
    ),
    'last_interpretation', (
      select jsonb_build_object(
        'provider', provider, 'model', model,
        'prompt_version', prompt_version, 'schema_version', schema_version,
        'at', created_at
      ) from latest_interpretation
    ),
    'usage', jsonb_build_object(
      'input_tokens', (
        select sum(case when jsonb_typeof(usage -> 'input_tokens') = 'number'
                        then (usage ->> 'input_tokens')::bigint end)
        from timed
      ),
      'cached_input_tokens', (
        select sum(case when jsonb_typeof(usage -> 'cached_input_tokens') = 'number'
                        then (usage ->> 'cached_input_tokens')::bigint end)
        from timed
      ),
      'output_tokens', (
        select sum(case when jsonb_typeof(usage -> 'output_tokens') = 'number'
                        then (usage ->> 'output_tokens')::bigint end)
        from timed
      ),
      'cost', null
    ),
    'automatically_classified', (
      select count(*) from public.audit_logs a
      where a.org_id = auth_org()
        and a.action = 'document_kind_classified_automatically'
        and a.created_at >= v_since
    ),
    'automatically_applied_documents', (
      select count(*) from (
        select a.document_id
        from public.document_auto_actions a
        where a.org_id = auth_org() and a.created_at >= v_since
        union
        select d.document_id
        from public.price_list_interpretation_decisions d
        where d.org_id = auth_org() and d.created_at >= v_since
          and d.outcome in ('auto_applied', 'partially_applied')
      ) applied
    ),
    'reprocessed_documents', (
      select count(*) from public.audit_logs a
      where a.org_id = auth_org()
        and a.action = 'document_processing_reprocessed'
        and a.created_at >= v_since
    ),
    'price_list_results', (
      select jsonb_build_object(
        'automatically_applied', automatically_applied,
        'partially_applied', partially_applied,
        'review_required', review_required,
        'reverted', reverted
      ) from price_counts
    ),
    'last_processing_at', (select max(updated_at) from jobs)
  ) into v_result
  from current_jobs j;

  return v_result;
end
$$;

revoke all on function public.get_document_operations_metrics(integer)
  from public, anon, service_role;
grant execute on function public.get_document_operations_metrics(integer)
  to authenticated;

create or replace function public.get_document_processing_attempts(
  p_document_id uuid default null,
  p_limit integer default 100
) returns table (
  job_id uuid,
  document_id uuid,
  previous_job_id uuid,
  status text,
  attempt_count integer,
  created_at timestamptz,
  updated_at timestamptz,
  queue_age_seconds bigint,
  last_error_code text,
  last_error_message text,
  extraction_id uuid,
  extraction_engine text,
  extraction_model text,
  extraction_model_version text,
  extraction_duration_ms integer,
  interpretation_id uuid,
  provider text,
  interpretation_model text,
  prompt_version text,
  schema_version text,
  interpretation_duration_ms integer,
  document_type text,
  document_type_confidence numeric,
  supplier_confidence numeric,
  usage jsonb,
  usage_cost numeric,
  price_list_outcome text,
  price_list_reason_code text,
  price_list_applied_count integer,
  price_list_waiting_count integer
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if auth_org() is null or auth.uid() is null or auth_role() <> 'owner' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'invalid_limit' using errcode = '22023';
  end if;

  return query
  with ordered as (
    select j.*,
           lag(j.id) over (
             partition by j.document_id order by j.created_at, j.id
           ) as previous_job_id
    from public.document_processing_jobs j
    where j.org_id = auth_org()
      and (p_document_id is null or j.document_id = p_document_id)
  )
  select j.id, j.document_id, j.previous_job_id, j.status, j.attempt_count,
         j.created_at, j.updated_at,
         case when j.status = 'queued'
              then extract(epoch from (statement_timestamp() - j.created_at))::bigint
              else null end,
         j.last_error_code, j.last_error_message,
         e.id, e.engine, e.model, e.model_version, e.duration_ms,
         i.id, i.provider, i.model, i.prompt_version, i.schema_version, i.duration_ms,
         i.payload ->> 'document_type',
         case when jsonb_typeof(i.payload -> 'document_type_confidence') = 'number'
              then (i.payload ->> 'document_type_confidence')::numeric else null end,
         case when jsonb_typeof(i.payload -> 'supplier' -> 'confidence') = 'number'
              then (i.payload -> 'supplier' ->> 'confidence')::numeric else null end,
         i.usage,
         null::numeric,
         d.outcome, d.reason_code, d.accepted_count, d.waiting_count
  from ordered j
  left join public.document_extractions e
    on e.org_id = j.org_id and e.job_id = j.id
  left join public.document_interpretations i
    on i.org_id = j.org_id and i.job_id = j.id
  left join public.price_list_interpretation_decisions d
    on d.org_id = j.org_id and d.interpretation_id = i.id
  order by j.created_at desc, j.id desc
  limit p_limit;
end
$$;

revoke all on function public.get_document_processing_attempts(uuid, integer)
  from public, anon, service_role;
grant execute on function public.get_document_processing_attempts(uuid, integer)
  to authenticated;

-- ===== 5. Reviewed supplier/layout eligibility gate =====

create table public.price_list_automation_scope_decisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  scope_fingerprint text not null check (scope_fingerprint ~ '^[0-9a-f]{64}$'),
  evidence_shadow_run_id uuid not null,
  revision integer not null check (revision > 0),
  idempotency_key uuid not null,
  state text not null check (state in ('eligible', 'shadow_only')),
  evidence_line_count integer not null check (evidence_line_count >= 0),
  evidence_reviewed_count integer not null check (evidence_reviewed_count >= 0),
  evidence_correct_count integer not null check (evidence_correct_count >= 0),
  evidence_incorrect_count integer not null check (evidence_incorrect_count >= 0),
  evidence_ambiguous_count integer not null check (evidence_ambiguous_count >= 0),
  evidence_policy_rejected_count integer not null check (evidence_policy_rejected_count >= 0),
  evidence_accuracy numeric check (evidence_accuracy is null or evidence_accuracy between 0 and 1),
  decided_by uuid not null references auth.users(id) on delete restrict,
  reason text not null check (reason ~ '[[:graph:]]' and length(reason) <= 1000),
  created_at timestamptz not null default now(),
  constraint price_list_automation_scope_decisions_org_id_id_key unique (org_id, id),
  constraint price_list_automation_scope_decisions_revision_key
    unique (org_id, scope_fingerprint, revision),
  constraint price_list_automation_scope_decisions_idempotency_key
    unique (org_id, idempotency_key),
  constraint price_list_automation_scope_decisions_run_fk
    foreign key (org_id, evidence_shadow_run_id)
      references public.price_list_shadow_runs(org_id, id) on delete restrict,
  constraint price_list_automation_scope_decisions_evidence_shape check (
    evidence_reviewed_count <= evidence_line_count
    and evidence_correct_count + evidence_incorrect_count
      + evidence_ambiguous_count + evidence_policy_rejected_count = evidence_reviewed_count
  )
);

create index price_list_automation_scope_decisions_latest_idx
  on public.price_list_automation_scope_decisions (
    org_id, scope_fingerprint, revision desc
  );

create trigger price_list_automation_scope_decisions_immutable_trg
  before insert or update or delete on public.price_list_automation_scope_decisions
  for each row execute function public.reject_price_list_measurement_mutation();

alter table public.price_list_automation_scope_decisions enable row level security;
alter table public.price_list_automation_scope_decisions force row level security;
create policy price_list_automation_scope_decisions_select
  on public.price_list_automation_scope_decisions for select to authenticated
  using (
    is_platform_admin()
    or (org_id = auth_org() and auth_role() = 'owner')
  );
revoke all on table public.price_list_automation_scope_decisions
  from public, anon, authenticated, service_role;
grant select on table public.price_list_automation_scope_decisions to authenticated, service_role;

create or replace function private.price_list_scope_fingerprint(
  p_run public.price_list_shadow_runs
) returns text
language sql
immutable
strict
set search_path = public, extensions, pg_catalog
as $$
  -- Observed confidence/rate/count/price drift is deliberately absent. The stored
  -- minimum is an explicit operator-controlled intake policy contract, not a
  -- learned drift threshold; changing that contract requires fresh eligibility.
  select encode(digest(convert_to(jsonb_build_array(
    p_run.org_id::text,
    p_run.supplier_id,
    p_run.document_format,
    p_run.layout_signature,
    p_run.evaluator_version,
    p_run.evaluated_min_confidence,
    p_run.provider,
    p_run.model,
    p_run.prompt_version,
    p_run.schema_version,
    p_run.extraction_engine,
    p_run.extraction_model,
    p_run.extraction_model_version
  )::text, 'UTF8'), 'sha256'), 'hex')
$$;
revoke all on function private.price_list_scope_fingerprint(public.price_list_shadow_runs)
  from public, anon, authenticated, service_role;

create or replace function public.platform_set_price_list_automation_scope(
  p_org_id uuid,
  p_shadow_run_id uuid,
  p_state text,
  p_idempotency_key uuid,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_reason text := nullif(trim(p_reason), '');
  v_run public.price_list_shadow_runs;
  v_fingerprint text;
  v_existing public.price_list_automation_scope_decisions;
  v_revision integer;
  v_line_count integer;
  v_reviewed_count integer;
  v_correct integer;
  v_incorrect integer;
  v_ambiguous integer;
  v_policy_rejected integer;
  v_accuracy numeric;
  v_id uuid := gen_random_uuid();
begin
  if v_actor is null or not is_platform_admin() then
    raise exception 'not_platform_admin' using errcode = '42501';
  end if;
  if p_org_id is null or p_shadow_run_id is null or p_idempotency_key is null
     or p_state not in ('eligible', 'shadow_only') then
    raise exception 'price_list_scope_decision_invalid' using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if length(v_reason) > 1000 then
    raise exception 'reason_too_long' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'price-list-scope-idempotency:' || p_org_id::text || ':' || p_idempotency_key::text,
    0
  ));
  perform public.assert_recent_password_authentication();

  select * into v_run
  from public.price_list_shadow_runs run
  where run.org_id = p_org_id and run.id = p_shadow_run_id;
  if not found then
    raise exception 'price_list_shadow_run_unknown' using errcode = 'P0002';
  end if;
  v_fingerprint := private.price_list_scope_fingerprint(v_run);
  perform pg_advisory_xact_lock(hashtextextended(
    'price-list-scope:' || p_org_id::text || ':' || v_fingerprint, 0
  ));

  select * into v_existing
  from public.price_list_automation_scope_decisions decision
  where decision.org_id = p_org_id
    and decision.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.scope_fingerprint is distinct from v_fingerprint
       or v_existing.evidence_shadow_run_id is distinct from p_shadow_run_id
       or v_existing.state is distinct from p_state
       or v_existing.reason is distinct from v_reason then
      raise exception 'price_list_scope_decision_idempotency_conflict' using errcode = '55000';
    end if;
    return jsonb_build_object(
      'decision_id', v_existing.id,
      'scope_fingerprint', v_existing.scope_fingerprint,
      'state', v_existing.state,
      'revision', v_existing.revision,
      'idempotent', true
    );
  end if;

  with latest as (
    select distinct on (review.shadow_line_id)
           review.shadow_line_id, review.verdict
    from public.price_list_calibration_reviews review
    where review.org_id = p_org_id
      and review.shadow_run_id = p_shadow_run_id
    order by review.shadow_line_id, review.revision desc
  )
  select count(line.id)::integer,
         count(latest.shadow_line_id)::integer,
         count(*) filter (where latest.verdict = 'correct')::integer,
         count(*) filter (where latest.verdict = 'incorrect')::integer,
         count(*) filter (where latest.verdict = 'ambiguous')::integer,
         count(*) filter (where latest.verdict = 'rejected_by_policy')::integer,
         count(*) filter (where latest.verdict = 'correct')::numeric
           / nullif(count(*) filter (where latest.verdict in ('correct', 'incorrect')), 0)
    into v_line_count, v_reviewed_count, v_correct, v_incorrect,
         v_ambiguous, v_policy_rejected, v_accuracy
  from public.price_list_shadow_lines line
  left join latest on latest.shadow_line_id = line.id
  where line.org_id = p_org_id and line.shadow_run_id = p_shadow_run_id;

  if p_state = 'eligible'
     and (v_line_count = 0 or v_reviewed_count <> v_line_count) then
    raise exception 'price_list_scope_review_incomplete' using errcode = '55000';
  end if;
  if p_state = 'eligible' and v_correct <> v_line_count then
    raise exception 'price_list_scope_evidence_not_acceptable' using errcode = '55000';
  end if;

  select coalesce(max(decision.revision), 0) + 1 into v_revision
  from public.price_list_automation_scope_decisions decision
  where decision.org_id = p_org_id
    and decision.scope_fingerprint = v_fingerprint;

  perform set_config('app.price_list_scope_writer', 'decide', true);
  insert into public.price_list_automation_scope_decisions (
    id, org_id, scope_fingerprint, evidence_shadow_run_id, revision,
    idempotency_key, state, evidence_line_count, evidence_reviewed_count,
    evidence_correct_count, evidence_incorrect_count, evidence_ambiguous_count,
    evidence_policy_rejected_count, evidence_accuracy, decided_by, reason
  ) values (
    v_id, p_org_id, v_fingerprint, p_shadow_run_id, v_revision,
    p_idempotency_key, p_state, v_line_count, v_reviewed_count,
    v_correct, v_incorrect, v_ambiguous, v_policy_rejected, v_accuracy,
    v_actor, v_reason
  );
  perform set_config('app.price_list_scope_writer', '', true);

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    p_org_id, v_actor, 'price_list_automation_scope_decided',
    'price_list_automation_scope_decisions', v_id,
    jsonb_build_object(
      'scope_fingerprint', v_fingerprint,
      'state', p_state,
      'evidence_shadow_run_id', p_shadow_run_id,
      'evidence_line_count', v_line_count,
      'evidence_reviewed_count', v_reviewed_count,
      'evidence_accuracy', v_accuracy
    ),
    v_reason
  );

  return jsonb_build_object(
    'decision_id', v_id,
    'scope_fingerprint', v_fingerprint,
    'state', p_state,
    'revision', v_revision,
    'idempotent', false
  );
end
$$;

revoke all on function public.platform_set_price_list_automation_scope(
  uuid, uuid, text, uuid, text
) from public, anon, service_role;
grant execute on function public.platform_set_price_list_automation_scope(
  uuid, uuid, text, uuid, text
) to authenticated;

create or replace function public.apply_eligible_price_list_interpretation(
  p_job_id uuid,
  p_interpretation_id uuid,
  p_actor_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_i public.document_interpretations;
  v_job public.document_processing_jobs;
  v_run public.price_list_shadow_runs;
  v_fingerprint text;
  v_state text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select * into v_i
  from public.document_interpretations interpretation
  where interpretation.id = p_interpretation_id
    and interpretation.job_id = p_job_id;
  if not found then
    raise exception 'document_interpretation_unknown' using errcode = 'P0002';
  end if;
  select * into v_job
  from public.document_processing_jobs job
  where job.id = p_job_id and job.org_id = v_i.org_id
    and job.document_id = v_i.document_id
  for update;
  if not found then
    raise exception 'document_processing_job_unknown' using errcode = 'P0002';
  end if;

  -- One document owns at most one live automatic batch, even when two reprocess jobs
  -- reach this command concurrently.
  perform pg_advisory_xact_lock(hashtextextended(
    'price-list-document:' || v_i.org_id::text || ':' || v_i.document_id::text, 0
  ));

  -- Exact replays remain idempotent, but a new interpretation of a document whose price batch
  -- is still live can never create a second batch. Rollback or a human review must come first.
  if exists (
    select 1 from public.price_list_interpretation_decisions decision
    where decision.org_id = v_i.org_id
      and decision.interpretation_id = v_i.id
  ) then
    return public.apply_price_list_interpretation(p_job_id, p_interpretation_id, p_actor_id);
  end if;
  if exists (
    select 1 from public.price_list_interpretation_decisions decision
    where decision.org_id = v_i.org_id
      and decision.document_id = v_i.document_id
      and decision.submission_id is not null
      and decision.reverted_at is null
  ) then
    update public.document_processing_jobs
    set status = 'review', last_error_code = null, last_error_message = null
    where id = v_job.id and org_id = v_job.org_id;
    return jsonb_build_object(
      'outcome', 'queued_for_review',
      'reason_code', 'document_already_auto_applied',
      'accepted_count', 0,
      'waiting_count', jsonb_array_length(v_i.payload -> 'line_items'),
      'idempotent', false
    );
  end if;

  select * into v_run
  from public.price_list_shadow_runs run
  where run.org_id = v_i.org_id
    and run.interpretation_id = v_i.id
  order by run.created_at desc, run.id desc
  limit 1;
  if found then
    v_fingerprint := private.price_list_scope_fingerprint(v_run);
    -- Serialize the eligibility read with platform approval/suspension. Whichever
    -- transaction gets this lock first defines the observable decision order.
    perform pg_advisory_xact_lock(hashtextextended(
      'price-list-scope:' || v_i.org_id::text || ':' || v_fingerprint, 0
    ));
    select decision.state into v_state
    from public.price_list_automation_scope_decisions decision
    where decision.org_id = v_i.org_id
      and decision.scope_fingerprint = v_fingerprint
    order by decision.revision desc
    limit 1;
  end if;

  if v_run.id is null or v_state is distinct from 'eligible' then
    update public.document_processing_jobs
    set status = 'review', last_error_code = null, last_error_message = null
    where id = v_job.id and org_id = v_job.org_id;
    return jsonb_build_object(
      'outcome', 'queued_for_review',
      'reason_code', case when v_run.id is null
        then 'shadow_evidence_missing' else 'shadow_scope_not_eligible' end,
      'shadow_run_id', v_run.id,
      'accepted_count', 0,
      'waiting_count', jsonb_array_length(v_i.payload -> 'line_items'),
      'idempotent', false
    );
  end if;

  return public.apply_price_list_interpretation(p_job_id, p_interpretation_id, p_actor_id);
end
$$;

revoke all on function public.apply_price_list_interpretation(uuid, uuid, uuid)
  from service_role;
revoke all on function public.apply_eligible_price_list_interpretation(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.apply_eligible_price_list_interpretation(uuid, uuid, uuid)
  to service_role;

-- ===== 6. Scope/security registry and migration assertions =====

insert into private.scope_registry (table_name, scope_class, enforced) values
  ('price_list_shadow_runs', 'org_global', false),
  ('price_list_shadow_lines', 'org_global', false),
  ('price_list_calibration_reviews', 'org_global', false),
  ('price_list_empty_run_reviews', 'org_global', false),
  ('price_list_automation_scope_decisions', 'org_global', false);

insert into private.scope_definer_exemptions (function_signature, reason, target_wave)
values (
  'public.run_price_list_shadow(uuid,uuid,uuid)'::regprocedure::text,
  'actor: trusted service_role invoked by the document automation server with the immutable '
    || 'uploader id; tenant: org_id is derived from the interpretation, then document, job, '
    || 'extraction, actor and supplier are pinned by tenant-composite keys; scope: the trusted '
    || 'caller has no user JWT and auth_scopes() is empty, so executable scope enforcement would '
    || 'silently suppress every run; tables: reads documents, jobs, extractions, interpretations, '
    || 'suppliers, products and supplier_products, writes only price_list_shadow_runs/lines; '
    || 'reason: SECURITY INVOKER cannot read the private policy/matcher or bypass the forced-RLS '
    || 'append path after proving the chain; service_role has RPC execution only and no direct '
    || 'ledger table privileges; audit: no business or '
    || 'financial mutation occurs, and the immutable versioned shadow run is the evidence.',
  'document automation calibration wave'
), (
  'public.record_price_list_empty_run_review(uuid,uuid,text,text)'::regprocedure::text,
  'actor: authenticated active tenant owner proven through auth_role; tenant: the immutable run, '
    || 'document, interpretation and reviewer use tenant-composite foreign keys rooted in auth_org; '
    || 'scope: this org-global evidence has no unit dimension; tables: reads one shadow run and its '
    || 'lines, writes one append-only empty-run review plus audit_logs; reason and idempotency are '
    || 'mandatory; audit: the human verdict and revision are recorded in the same transaction; '
    || 'SECURITY DEFINER is required only to cross forced RLS through the trigger-gated writer path.',
  'document automation calibration wave'
), (
  'public.platform_set_price_list_automation_scope(uuid,uuid,text,uuid,text)'::regprocedure::text,
  'actor: authenticated platform administrator proven by is_platform_admin; tenant: the target '
    || 'organization and immutable shadow run are explicit and tenant-composite; scope: platform '
    || 'operators intentionally act across tenant units and cannot use auth_scopes; tables: reads '
    || 'shadow/calibration evidence and writes one append-only scope decision plus audit_logs; '
    || 'reason and idempotency are mandatory; audit: the evidence counts, accuracy snapshot and '
    || 'operator reason are stored in the same transaction.',
  'document automation calibration wave'
), (
  'public.apply_eligible_price_list_interpretation(uuid,uuid,uuid)'::regprocedure::text,
  'actor: trusted service_role using the immutable uploader chain revalidated by the underlying '
    || 'financial command; tenant: org and document derive from the exact interpretation/job, and '
    || 'the shadow run plus eligibility decision must share that org; scope: service_role has no '
    || 'auth_scopes, so tenant filtering is explicit; tables: reads interpretation, jobs, shadow '
    || 'and scope ledgers, updates only the exact job to review or calls the existing audited price '
    || 'command; reason: prevents direct service bypass and duplicate live batches on reprocess; '
    || 'audit: live mutation remains owned by apply_price_list_interpretation.',
  'document automation calibration wave'
);

do $$
declare
  v_violations text;
begin
  if has_function_privilege(
       'authenticated',
       'public.run_price_list_shadow(uuid,uuid,uuid)',
       'EXECUTE'
     ) then
    raise exception '0103 refused: browser can execute shadow evaluation';
  end if;
  if has_function_privilege(
       'service_role',
       'public.apply_price_list_interpretation(uuid,uuid,uuid)',
       'EXECUTE'
     ) then
    raise exception '0103 refused: service role can bypass scope eligibility';
  end if;
  if has_function_privilege(
       'service_role',
       'public.record_price_list_calibration_review(uuid,uuid,text,text[],text,uuid,numeric,text)',
       'EXECUTE'
     ) then
    raise exception '0103 refused: service role can author human calibration evidence';
  end if;
  if position(
       'assert_recent_password_authentication'
       in pg_get_functiondef(
         'public.platform_set_price_list_automation_scope(uuid,uuid,text,uuid,text)'::regprocedure
       )
     ) = 0 then
    raise exception '0103 refused: platform automation eligibility lacks step-up enforcement';
  end if;
  if has_table_privilege('service_role', 'public.price_list_shadow_runs', 'INSERT')
     or has_table_privilege('service_role', 'public.price_list_shadow_lines', 'INSERT')
     or has_table_privilege('service_role', 'public.price_list_calibration_reviews', 'INSERT')
     or has_table_privilege('service_role', 'public.price_list_empty_run_reviews', 'INSERT')
     or has_table_privilege('service_role', 'public.price_list_automation_scope_decisions', 'INSERT') then
    raise exception '0103 refused: service role can bypass the ledger RPC boundaries';
  end if;

  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0103 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
