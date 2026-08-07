-- 0081 -- Interpret every extracted document, and optionally ingest matched price-list lines.
--
-- Two independent switches stay independent. Interpretation dispatch is infrastructure and runs
-- for every active tenant, under a hard per-tenant hourly ceiling. Price-list financial writes
-- use the second autonomy policy below, ship OFF, and match only sku/barcode. Product names are
-- never a matching key; an unmatched keyed line may use its printed name to create a product.

-- ===== 1. The second financial policy =====
insert into private.autonomy_policy_definitions (
  policy_key, description, baseline_enabled, baseline_min_confidence, kill_switch
) values (
  'price_list.intake',
  'May the system ingest matched rows from an interpreted supplier price list without a human. '
  'Existing products match by supplier sku, product sku or barcode. Product names never match; '
  'an unmatched row with a printed name and sku/barcode creates a product. Baseline is off; '
  '0.900 is uncalibrated.',
  false, 0.900, false
);

-- ===== 2. Bounded automatic dispatch =====
-- Config is intentionally empty after migration. Production rollout writes one row only after the
-- matching Edge secret exists. Missing config or secret makes every cron tick a no-op.
create table private.document_interpretation_automation_config (
  id boolean primary key default true check (id),
  edge_url text not null check (trim(edge_url) <> ''),
  cron_secret_id uuid not null references vault.secrets(id) on delete restrict,
  max_starts_per_org_hour integer not null default 20
    check (max_starts_per_org_hour between 1 and 100)
);
revoke all on table private.document_interpretation_automation_config
  from public, anon, authenticated, service_role;

create table private.document_interpretation_dispatches (
  job_id uuid primary key references public.document_processing_jobs(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  last_dispatched_at timestamptz not null default now(),
  attempt_count integer not null default 1 check (attempt_count > 0),
  constraint document_interpretation_dispatches_org_job unique (org_id, job_id)
);
revoke all on table private.document_interpretation_dispatches
  from public, anon, authenticated, service_role;

-- One job per tenant per minute. A dispatch that never reaches the Edge endpoint may retry after
-- five minutes; a dispatch that starts the model is counted from interpretation_started_at.
create or replace function private.claim_document_interpretation_jobs(
  p_limit integer,
  p_max_starts_per_org_hour integer
) returns table (job_id uuid)
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_candidate record;
begin
  if p_limit not between 1 and 100
     or p_max_starts_per_org_hour not between 1 and 100 then
    raise exception 'document_interpretation_dispatch_limit_invalid' using errcode = '22023';
  end if;

  for v_candidate in
    with eligible as (
      select j.id, j.org_id, j.created_at,
             row_number() over (
               partition by j.org_id order by j.created_at, j.id
             ) as tenant_position
      from public.document_processing_jobs j
      join public.documents d
        on d.org_id = j.org_id and d.id = j.document_id and d.deleted_at is null
      join public.document_extractions e
        on e.org_id = j.org_id and e.job_id = j.id and e.document_id = d.id
       and e.input_checksum = j.input_checksum and e.contract_version = j.contract_version
      join public.profiles p
        on p.org_id = j.org_id and p.id = d.uploaded_by and p.active
       and p.role in ('owner', 'office', 'kitchen', 'supplier')
      join public.organizations o
        on o.id = j.org_id and o.status in ('trial', 'active')
      left join private.document_interpretation_dispatches sent on sent.job_id = j.id
      where j.status = 'extracted'
        and j.requested_by = d.uploaded_by
        and not exists (
          select 1 from public.document_interpretations i
          where i.org_id = j.org_id and i.job_id = j.id
        )
        and (
          sent.job_id is null
          or sent.last_dispatched_at <= clock_timestamp() - interval '5 minutes'
        )
        and (
          select count(*)
          from public.document_processing_jobs recent
          where recent.org_id = j.org_id
            and recent.interpretation_started_at
              >= clock_timestamp() - interval '1 hour'
        ) < p_max_starts_per_org_hour
    )
    select id, org_id
    from eligible
    where tenant_position = 1
    order by created_at, id
    limit p_limit
  loop
    perform 1
    from public.document_processing_jobs j
    where j.id = v_candidate.id and j.status = 'extracted'
    for update skip locked;
    if not found then continue; end if;

    insert into private.document_interpretation_dispatches (
      job_id, org_id, last_dispatched_at, attempt_count
    ) values (
      v_candidate.id, v_candidate.org_id, clock_timestamp(), 1
    )
    on conflict (job_id) do update
      set last_dispatched_at = excluded.last_dispatched_at,
          attempt_count = private.document_interpretation_dispatches.attempt_count + 1;

    job_id := v_candidate.id;
    return next;
  end loop;
end
$$;
revoke all on function private.claim_document_interpretation_jobs(integer, integer)
  from public, anon, authenticated, service_role;

create or replace function private.dispatch_document_interpretations()
returns bigint[]
language plpgsql
security definer
set search_path = pg_catalog, private, vault, net
as $$
declare
  v_edge_url text;
  v_cron_secret text;
  v_limit integer;
  v_job record;
  v_request_ids bigint[] := array[]::bigint[];
begin
  perform pg_catalog.set_config(
    'app.correlation_id', pg_catalog.gen_random_uuid()::text, true
  );

  select pg_catalog.btrim(c.edge_url), pg_catalog.nullif(s.decrypted_secret, ''),
         c.max_starts_per_org_hour
    into v_edge_url, v_cron_secret, v_limit
  from private.document_interpretation_automation_config c
  join vault.decrypted_secrets s on s.id = c.cron_secret_id
  where c.id;
  if not found or v_cron_secret is null then return v_request_ids; end if;

  for v_job in
    select claimed.job_id
    from private.claim_document_interpretation_jobs(10, v_limit) claimed
  loop
    v_request_ids := pg_catalog.array_append(
      v_request_ids,
      net.http_post(
        url := v_edge_url,
        body := pg_catalog.jsonb_build_object('jobId', v_job.job_id),
        headers := pg_catalog.jsonb_build_object(
          'Content-Type', 'application/json',
          'x-interpret-cron-secret', v_cron_secret
        )
      )
    );
  end loop;
  return v_request_ids;
end
$$;
revoke all on function private.dispatch_document_interpretations()
  from public, anon, authenticated, service_role;

select cron.schedule(
  'supplyflow-document-interpretation',
  '* * * * *',
  'select private.dispatch_document_interpretations();'
);

-- ===== 3. Decision and per-line result ledgers =====
create table public.price_list_interpretation_decisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  document_id uuid not null,
  job_id uuid not null,
  interpretation_id uuid not null,
  actor_id uuid not null,
  supplier_id uuid,
  submission_id uuid,
  outcome text not null check (
    outcome in ('queued_for_review', 'partially_applied', 'auto_applied')
  ),
  reason_code text,
  decision_confidence numeric,
  accepted_count integer not null default 0 check (accepted_count >= 0),
  waiting_count integer not null default 0 check (waiting_count >= 0),
  created_product_count integer not null default 0 check (created_product_count >= 0),
  created_at timestamptz not null default now(),
  reverted_at timestamptz,
  reverted_by uuid,
  reverted_reason text,
  constraint price_list_interpretation_decisions_org_id_id unique (org_id, id),
  constraint price_list_interpretation_decisions_interpretation_key
    unique (org_id, interpretation_id),
  constraint price_list_interpretation_decisions_document_fk
    foreign key (org_id, document_id) references public.documents(org_id, id) on delete restrict,
  constraint price_list_interpretation_decisions_job_fk
    foreign key (org_id, job_id)
      references public.document_processing_jobs(org_id, id) on delete restrict,
  constraint price_list_interpretation_decisions_interpretation_fk
    foreign key (org_id, interpretation_id)
      references public.document_interpretations(org_id, id) on delete restrict,
  constraint price_list_interpretation_decisions_actor_fk
    foreign key (org_id, actor_id) references public.profiles(org_id, id) on delete restrict,
  constraint price_list_interpretation_decisions_supplier_fk
    foreign key (org_id, supplier_id) references public.suppliers(org_id, id) on delete restrict,
  constraint price_list_interpretation_decisions_submission_fk
    foreign key (org_id, submission_id)
      references public.supplier_price_submissions(org_id, id) on delete restrict,
  constraint price_list_interpretation_decisions_reversal_shape check (
    (reverted_at is null and reverted_by is null and reverted_reason is null)
    or (
      reverted_at is not null and reverted_by is not null
      and length(trim(reverted_reason)) between 1 and 1000
      and submission_id is not null
    )
  ),
  constraint price_list_interpretation_decisions_outcome_shape check (
    (outcome = 'queued_for_review' and submission_id is null and accepted_count = 0)
    or (
      outcome = 'partially_applied' and submission_id is not null
      and accepted_count > 0 and waiting_count > 0
    )
    or (
      outcome = 'auto_applied' and submission_id is not null
      and accepted_count > 0 and waiting_count = 0
    )
  )
);

create table public.price_list_interpretation_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  decision_id uuid not null,
  document_id uuid not null,
  interpretation_id uuid not null,
  line_index integer not null check (line_index >= 0),
  source_row integer,
  outcome text not null check (outcome in ('applied', 'waiting')),
  reason_code text,
  product_id uuid,
  supplier_product_id uuid,
  sku text,
  barcode text,
  unit_price numeric,
  product_created boolean not null default false,
  created_at timestamptz not null default now(),
  constraint price_list_interpretation_lines_decision_fk
    foreign key (org_id, decision_id)
      references public.price_list_interpretation_decisions(org_id, id) on delete cascade,
  constraint price_list_interpretation_lines_document_fk
    foreign key (org_id, document_id) references public.documents(org_id, id) on delete restrict,
  constraint price_list_interpretation_lines_interpretation_fk
    foreign key (org_id, interpretation_id)
      references public.document_interpretations(org_id, id) on delete restrict,
  constraint price_list_interpretation_lines_product_fk
    foreign key (org_id, product_id) references public.products(org_id, id) on delete restrict,
  constraint price_list_interpretation_lines_supplier_product_fk
    foreign key (org_id, supplier_product_id)
      references public.supplier_products(org_id, id) on delete restrict,
  constraint price_list_interpretation_lines_unique
    unique (org_id, interpretation_id, line_index),
  constraint price_list_interpretation_lines_shape check (
    (
      outcome = 'applied' and reason_code is null
      and product_id is not null and unit_price is not null
    )
    or (
      outcome = 'waiting' and reason_code is not null
      and supplier_product_id is null and not product_created
    )
  )
);

create table private.price_list_auto_action_snapshots (
  decision_id uuid primary key,
  org_id uuid not null,
  previous_prices jsonb not null check (jsonb_typeof(previous_prices) = 'array'),
  applied_prices jsonb not null check (jsonb_typeof(applied_prices) = 'array'),
  constraint price_list_auto_action_snapshots_decision_fk
    foreign key (org_id, decision_id)
      references public.price_list_interpretation_decisions(org_id, id) on delete restrict
);
revoke all on table private.price_list_auto_action_snapshots
  from public, anon, authenticated, service_role;

alter table public.price_list_interpretation_decisions enable row level security;
alter table public.price_list_interpretation_decisions force row level security;
alter table public.price_list_interpretation_lines enable row level security;
alter table public.price_list_interpretation_lines force row level security;

create policy price_list_interpretation_decisions_select
on public.price_list_interpretation_decisions for select to authenticated
using (
  org_id = auth_org()
  and exists (
    select 1 from public.profiles p
    where p.org_id = auth_org() and p.id = auth.uid() and p.active
      and (
        p.role in ('owner', 'office', 'kitchen')
        or (
          p.role = 'supplier'
          and p.id = price_list_interpretation_decisions.actor_id
          and p.supplier_id = price_list_interpretation_decisions.supplier_id
        )
      )
  )
);

create policy price_list_interpretation_lines_select
on public.price_list_interpretation_lines for select to authenticated
using (
  exists (
    select 1 from public.price_list_interpretation_decisions d
    where d.org_id = price_list_interpretation_lines.org_id
      and d.id = price_list_interpretation_lines.decision_id
  )
);

revoke all on table public.price_list_interpretation_decisions
  from public, anon, authenticated;
revoke all on table public.price_list_interpretation_lines
  from public, anon, authenticated;
grant select on table public.price_list_interpretation_decisions to authenticated;
grant select on table public.price_list_interpretation_lines to authenticated;
grant select, insert, update, delete
  on table public.price_list_interpretation_decisions to service_role;
grant select, insert, update, delete
  on table public.price_list_interpretation_lines to service_role;

-- Even the trusted role cannot turn table DML into a second financial command.
create or replace function public.price_list_interpretation_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if current_setting('app.price_list_auto_writer', true)
       not in ('apply', 'revert') then
    raise exception 'price_list_interpretation_immutable' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (
    old.id is distinct from new.id
    or old.org_id is distinct from new.org_id
    or old.document_id is distinct from new.document_id
    or old.job_id is distinct from new.job_id
    or old.interpretation_id is distinct from new.interpretation_id
    or old.actor_id is distinct from new.actor_id
    or old.supplier_id is distinct from new.supplier_id
    or old.submission_id is distinct from new.submission_id
    or old.outcome is distinct from new.outcome
    or old.reason_code is distinct from new.reason_code
    or old.decision_confidence is distinct from new.decision_confidence
    or old.accepted_count is distinct from new.accepted_count
    or old.waiting_count is distinct from new.waiting_count
    or old.created_product_count is distinct from new.created_product_count
    or old.created_at is distinct from new.created_at
  ) then
    raise exception 'price_list_interpretation_immutable' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;
revoke all on function public.price_list_interpretation_guard()
  from public, anon, authenticated, service_role;

create trigger price_list_interpretation_decisions_guard
  before insert or update or delete on public.price_list_interpretation_decisions
  for each row execute function public.price_list_interpretation_guard();

create or replace function public.price_list_interpretation_lines_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if current_setting('app.price_list_auto_writer', true) <> 'apply' then
    raise exception 'price_list_interpretation_line_immutable' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;
revoke all on function public.price_list_interpretation_lines_guard()
  from public, anon, authenticated, service_role;
create trigger price_list_interpretation_lines_guard
  before insert or update or delete on public.price_list_interpretation_lines
  for each row execute function public.price_list_interpretation_lines_guard();

-- ===== 4. The only automatic matcher =====
create or replace function private.match_price_list_line(
  p_org_id uuid,
  p_supplier_id uuid,
  p_sku text,
  p_barcode text
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_sku text := nullif(lower(trim(p_sku)), '');
  v_barcode text := nullif(lower(trim(p_barcode)), '');
  v_ids uuid[];
begin
  if p_org_id is null or p_supplier_id is null then
    return jsonb_build_object('status', 'unmatched');
  end if;

  if v_sku is not null then
    select array_agg(distinct sp.product_id order by sp.product_id) into v_ids
    from public.supplier_products sp
    join public.products p on p.org_id = sp.org_id and p.id = sp.product_id and p.active
    where sp.org_id = p_org_id and sp.supplier_id = p_supplier_id
      and lower(trim(sp.supplier_sku)) = v_sku;
    if cardinality(v_ids) > 1 then
      return jsonb_build_object('status', 'ambiguous', 'matched_by', 'supplier_sku');
    elsif cardinality(v_ids) = 1 then
      return jsonb_build_object(
        'status', 'matched', 'product_id', v_ids[1], 'matched_by', 'supplier_sku'
      );
    end if;

    select array_agg(distinct p.id order by p.id) into v_ids
    from public.products p
    where p.org_id = p_org_id and p.active and lower(trim(p.sku)) = v_sku;
    if cardinality(v_ids) > 1 then
      return jsonb_build_object('status', 'ambiguous', 'matched_by', 'sku');
    elsif cardinality(v_ids) = 1 then
      return jsonb_build_object(
        'status', 'matched', 'product_id', v_ids[1], 'matched_by', 'sku'
      );
    end if;
  end if;

  if v_barcode is not null then
    select array_agg(distinct p.id order by p.id) into v_ids
    from public.products p
    where p.org_id = p_org_id and p.active and lower(trim(p.barcode)) = v_barcode;
    if cardinality(v_ids) > 1 then
      return jsonb_build_object('status', 'ambiguous', 'matched_by', 'barcode');
    elsif cardinality(v_ids) = 1 then
      return jsonb_build_object(
        'status', 'matched', 'product_id', v_ids[1], 'matched_by', 'barcode'
      );
    end if;
  end if;

  return jsonb_build_object('status', 'unmatched');
end
$$;
revoke all on function private.match_price_list_line(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;

-- ===== 5. One price-list decision command =====
create or replace function public.apply_price_list_interpretation(
  p_job_id uuid,
  p_interpretation_id uuid,
  p_actor_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_job public.document_processing_jobs;
  v_i public.document_interpretations;
  v_doc public.documents;
  v_policy record;
  v_existing public.price_list_interpretation_decisions;
  v_decision_id uuid := gen_random_uuid();
  v_actor uuid;
  v_supplier_id uuid;
  v_reason_code text;
  v_line_reason_code text;
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
  v_product_id uuid;
  v_product_created boolean;
  v_seen_products uuid[] := array[]::uuid[];
  v_created_product_ids uuid[] := array[]::uuid[];
  v_approved_rows jsonb := '[]'::jsonb;
  v_line_results jsonb := '[]'::jsonb;
  v_accepted integer := 0;
  v_waiting integer := 0;
  v_created_products integer := 0;
  v_target_month date :=
    date_trunc('month', timezone('Asia/Jerusalem', clock_timestamp()))::date;
  v_intake_id uuid := gen_random_uuid();
  v_intake public.supplier_price_submission_intakes;
  v_receipt jsonb;
  v_outcome text;
  v_previous_prices jsonb := '[]'::jsonb;
  v_applied_prices jsonb := '[]'::jsonb;
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
  where j.id = p_job_id and j.org_id = v_i.org_id and j.document_id = v_i.document_id
  for update;
  if not found then
    raise exception 'document_processing_job_unknown' using errcode = 'P0002';
  end if;
  select * into v_doc
  from public.documents d
  where d.id = v_i.document_id and d.org_id = v_i.org_id and d.deleted_at is null
  for update;
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
         and p.role in ('owner', 'office', 'supplier')
     ) then
    raise exception 'document_interpretation_actor_invalid' using errcode = '42501';
  end if;

  select * into v_existing
  from public.price_list_interpretation_decisions d
  where d.org_id = v_i.org_id and d.interpretation_id = v_i.id;
  if found then
    return jsonb_build_object(
      'decision_id', v_existing.id,
      'outcome', v_existing.outcome,
      'reason_code', v_existing.reason_code,
      'submission_id', v_existing.submission_id,
      'accepted_count', v_existing.accepted_count,
      'waiting_count', v_existing.waiting_count,
      'created_product_count', v_existing.created_product_count,
      'idempotent', true
    );
  end if;

  select * into v_policy
  from private.autonomy_policy_for_org(v_i.org_id, 'price_list.intake');
  if not exists (
    select 1 from public.organizations o
    where o.id = v_i.org_id and o.status in ('trial', 'active')
  ) then
    v_reason_code := 'organization_inactive';
  elsif not coalesce(v_policy.autonomy_enabled, false) then
    v_reason_code := 'autonomy_disabled';
  elsif v_doc.document_kind <> 'price_list'
     or v_i.payload ->> 'document_type' <> 'price_list' then
    v_reason_code := 'not_a_price_list';
  elsif v_i.payload -> 'document_type_confidence' = 'null'::jsonb
     or v_i.payload -> 'supplier' -> 'confidence' = 'null'::jsonb then
    v_reason_code := 'confidence_unknown';
  else
    v_decision_confidence := least(
      (v_i.payload ->> 'document_type_confidence')::numeric,
      (v_i.payload -> 'supplier' ->> 'confidence')::numeric
    );
    if v_policy.min_confidence is null
       or v_decision_confidence < v_policy.min_confidence then
      v_reason_code := 'below_confidence_threshold';
    end if;
  end if;

  v_supplier_id := v_doc.supplier_id;
  if v_reason_code is null and (
    v_supplier_id is null
    or v_doc.entity_type <> 'supplier'
    or v_doc.entity_id is distinct from v_supplier_id
    or v_i.suggested_supplier_id is null
    or v_i.suggested_supplier_id is distinct from v_supplier_id
    or not exists (
      select 1 from public.suppliers s
      where s.org_id = v_i.org_id and s.id = v_supplier_id and s.deleted_at is null
    )
  ) then
    v_reason_code := 'supplier_unidentified';
  end if;

  if jsonb_typeof(v_i.payload -> 'line_items') <> 'array' then
    raise exception 'document_interpretation_invalid' using errcode = '22023';
  end if;

  -- Two automatic price lists for one supplier must not both decide that the same keyed product
  -- is absent. The transaction lock keeps match -> optional create -> price write one decision.
  if v_reason_code is null then
    perform pg_advisory_xact_lock(
      hashtextextended(v_i.org_id::text || ':' || v_supplier_id::text, 0)
    );
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
    v_line_reason_code := v_reason_code;
    v_product_id := null;
    v_product_created := false;
    v_price := null;

    if v_line_reason_code is null then
      v_price_text := regexp_replace(v_price_text, '[[:space:]₪,]', '', 'g');
      if length(v_price_text) > 16
         or v_price_text !~ '^[0-9]+([.][0-9]{1,4})?$' then
        v_line_reason_code := 'line_price_unreadable';
      else
        v_price := round(v_price_text::numeric, 2);
        if v_price <= 0 or v_price > 1000000 then
          v_line_reason_code := 'line_price_unreadable';
        end if;
      end if;
    end if;

    if v_line_reason_code is null then
      v_match := private.match_price_list_line(
        v_i.org_id, v_supplier_id, v_sku, v_barcode
      );
      if v_match ->> 'status' = 'ambiguous' then
        v_line_reason_code := 'line_product_ambiguous';
      elsif v_match ->> 'status' = 'matched' then
        v_product_id := (v_match ->> 'product_id')::uuid;
      elsif (v_sku is null and v_barcode is null)
         or v_product_name is null
         or length(v_product_name) > 200
         or length(coalesce(v_sku, '')) > 200
         or length(coalesce(v_barcode, '')) > 200
         or length(coalesce(v_unit, '')) > 50 then
        v_line_reason_code := 'line_product_unmatched';
      else
        v_product_id := gen_random_uuid();
        insert into public.products (id, org_id, name, unit, sku, barcode)
        values (
          v_product_id, v_i.org_id, v_product_name,
          coalesce(v_unit, 'יח'''), v_sku, v_barcode
        );
        v_product_created := true;
        v_created_product_ids := array_append(v_created_product_ids, v_product_id);
        v_created_products := v_created_products + 1;
      end if;
    end if;

    if v_line_reason_code is null and v_product_id = any(v_seen_products) then
      v_line_reason_code := 'line_product_ambiguous';
    end if;

    if v_line_reason_code is null then
      v_seen_products := array_append(v_seen_products, v_product_id);
      v_approved_rows := v_approved_rows || jsonb_build_array(jsonb_build_object(
        'lineItemIndex', v_line_index,
        'productId', v_product_id,
        'priceText', v_price::text,
        'available', true
      ));
      v_line_results := v_line_results || jsonb_build_array(jsonb_build_object(
        'line_index', v_line_index, 'source_row', v_source_row,
        'outcome', 'applied', 'reason_code', null,
        'product_id', v_product_id, 'sku', v_sku, 'barcode', v_barcode,
        'unit_price', v_price, 'product_created', v_product_created
      ));
      v_accepted := v_accepted + 1;
    else
      v_line_results := v_line_results || jsonb_build_array(jsonb_build_object(
        'line_index', v_line_index, 'source_row', v_source_row,
        'outcome', 'waiting', 'reason_code', v_line_reason_code,
        'product_id', null, 'sku', v_sku, 'barcode', v_barcode,
        'unit_price', null, 'product_created', false
      ));
      v_waiting := v_waiting + 1;
    end if;
  end loop;

  if v_accepted = 0 then
    v_outcome := 'queued_for_review';
    if v_reason_code is null then
      select value ->> 'reason_code' into v_reason_code
      from jsonb_array_elements(v_line_results)
      order by (value ->> 'line_index')::integer
      limit 1;
    end if;
  else
    select coalesce(jsonb_agg(jsonb_build_object(
      'product_id', p.id,
      'product_created', p.id = any(v_created_product_ids),
      'existed', sp.id is not null,
      'supplier_product_id', sp.id,
      'current_price', sp.current_price,
      'previous_price', sp.previous_price,
      'price_effective_date', sp.price_effective_date,
      'available', sp.available
    ) order by p.id), '[]'::jsonb)
      into v_previous_prices
    from public.products p
    left join public.supplier_products sp
      on sp.org_id = p.org_id and sp.product_id = p.id and sp.supplier_id = v_supplier_id
    where p.org_id = v_i.org_id and p.id = any(v_seen_products);

    perform public.prepare_ocr_supplier_price_intake(
      v_intake_id, v_actor, v_i.id, v_doc.id, v_i.id,
      v_target_month, v_approved_rows,
      'קליטת מחירון אוטומטית מפירוש מסמך'
    );
    select * into v_intake
    from public.supplier_price_submission_intakes intake
    where intake.id = v_intake_id
    for update;
    if not found then
      raise exception 'price_submission_intake_required' using errcode = 'P0002';
    end if;

    v_receipt := public.p1b_submit_supplier_price_list_internal(
      v_intake.submission_id, v_intake.supplier_id, v_intake.target_month,
      v_intake.file_name, v_intake.storage_path, v_intake.file_checksum,
      v_intake.rows_payload, v_intake.reason, v_actor
    );
    delete from public.supplier_price_submission_intakes where id = v_intake.id;

    select coalesce(jsonb_agg(jsonb_build_object(
      'product_id', sp.product_id,
      'supplier_product_id', sp.id,
      'current_price', sp.current_price,
      'previous_price', sp.previous_price,
      'price_effective_date', sp.price_effective_date,
      'available', sp.available
    ) order by sp.product_id), '[]'::jsonb)
      into v_applied_prices
    from public.supplier_products sp
    where sp.org_id = v_i.org_id and sp.supplier_id = v_supplier_id
      and sp.product_id = any(v_seen_products);

    v_outcome := case when v_waiting > 0
      then 'partially_applied' else 'auto_applied' end;
  end if;

  perform set_config('app.price_list_auto_writer', 'apply', true);
  insert into public.price_list_interpretation_decisions (
    id, org_id, document_id, job_id, interpretation_id, actor_id, supplier_id,
    submission_id, outcome, reason_code, decision_confidence,
    accepted_count, waiting_count, created_product_count
  ) values (
    v_decision_id, v_i.org_id, v_doc.id, v_job.id, v_i.id, v_actor, v_supplier_id,
    case when v_accepted > 0 then v_i.id else null end,
    v_outcome, v_reason_code, v_decision_confidence,
    v_accepted, v_waiting, v_created_products
  );

  insert into public.price_list_interpretation_lines (
    org_id, decision_id, document_id, interpretation_id,
    line_index, source_row, outcome, reason_code, product_id,
    supplier_product_id, sku, barcode, unit_price, product_created
  )
  select v_i.org_id, v_decision_id, v_doc.id, v_i.id,
         (line ->> 'line_index')::integer,
         case when line ->> 'source_row' is null then null
              else (line ->> 'source_row')::integer end,
         line ->> 'outcome', line ->> 'reason_code',
         case when line ->> 'product_id' is null then null
              else (line ->> 'product_id')::uuid end,
         case when line ->> 'product_id' is null then null else (
           select sp.id from public.supplier_products sp
           where sp.org_id = v_i.org_id and sp.supplier_id = v_supplier_id
             and sp.product_id = (line ->> 'product_id')::uuid
         ) end,
         line ->> 'sku', line ->> 'barcode',
         case when line ->> 'unit_price' is null then null
              else (line ->> 'unit_price')::numeric end,
         coalesce((line ->> 'product_created')::boolean, false)
  from jsonb_array_elements(v_line_results) line;

  if v_accepted > 0 then
    insert into private.price_list_auto_action_snapshots (
      decision_id, org_id, previous_prices, applied_prices
    ) values (
      v_decision_id, v_i.org_id, v_previous_prices, v_applied_prices
    );
    update public.document_processing_jobs
    set status = case when v_waiting = 0 then 'completed' else 'review' end,
        last_error_code = null,
        last_error_message = null
    where id = v_job.id;

    insert into public.audit_logs (
      org_id, user_id, action, entity_type, entity_id, new_values, reason
    ) values (
      v_i.org_id, null, 'price_list_interpretation_applied',
      'price_list_interpretation_decisions', v_decision_id,
      jsonb_build_object(
        'document_id', v_doc.id,
        'interpretation_id', v_i.id,
        'submission_id', v_i.id,
        'outcome', v_outcome,
        'accepted_count', v_accepted,
        'waiting_count', v_waiting,
        'created_product_count', v_created_products,
        'prompt_version', v_i.prompt_version,
        'decision_confidence', v_decision_confidence
      ),
      'קליטת מחירון אוטומטית לפי מק״ט וברקוד בלבד'
    );
  end if;

  return jsonb_build_object(
    'decision_id', v_decision_id,
    'outcome', v_outcome,
    'reason_code', v_reason_code,
    'submission_id', case when v_accepted > 0 then v_i.id else null end,
    'accepted_count', v_accepted,
    'waiting_count', v_waiting,
    'created_product_count', v_created_products,
    'receipt', v_receipt,
    'idempotent', false
  );
end
$$;

revoke all on function public.apply_price_list_interpretation(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.apply_price_list_interpretation(uuid, uuid, uuid)
  to service_role;

-- ===== 6. Reasoned compensating reversal =====
-- The immutable submission and price_history rows remain. Reversal writes a compensating price
-- state/history event and refuses if any later price change superseded the automatic one.
create or replace function public.revert_price_list_auto_action(
  p_decision_id uuid,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role public.user_role := auth_role();
  v_reason text := nullif(trim(p_reason), '');
  v_decision public.price_list_interpretation_decisions;
  v_snap private.price_list_auto_action_snapshots;
  v_previous jsonb;
  v_applied jsonb;
  v_current public.supplier_products;
  v_reverted integer := 0;
  v_effective_date date :=
    timezone('Asia/Jerusalem', clock_timestamp())::date;
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if length(v_reason) > 1000 then
    raise exception 'reason_too_long' using errcode = '22023';
  end if;

  select * into v_decision
  from public.price_list_interpretation_decisions d
  where d.id = p_decision_id and d.org_id = v_org
  for update;
  if not found then
    raise exception 'price_list_auto_action_unknown' using errcode = 'P0002';
  end if;
  if v_decision.submission_id is null then
    raise exception 'price_list_auto_action_not_applied' using errcode = '55000';
  end if;
  if v_decision.reverted_at is not null then
    raise exception 'price_list_auto_action_already_reverted' using errcode = '55000';
  end if;

  select * into v_snap
  from private.price_list_auto_action_snapshots s
  where s.org_id = v_org and s.decision_id = v_decision.id;
  if not found then
    raise exception 'price_list_auto_action_snapshot_missing' using errcode = 'P0002';
  end if;

  perform set_config('app.p1_financial_writer', v_user::text, true);
  for v_applied in select value from jsonb_array_elements(v_snap.applied_prices)
  loop
    select * into v_current
    from public.supplier_products sp
    where sp.org_id = v_org
      and sp.id = (v_applied ->> 'supplier_product_id')::uuid
      and sp.supplier_id = v_decision.supplier_id
      and sp.product_id = (v_applied ->> 'product_id')::uuid
    for update;
    if not found
       or round(v_current.current_price, 2)
            <> round((v_applied ->> 'current_price')::numeric, 2)
       or v_current.price_effective_date
            <> (v_applied ->> 'price_effective_date')::date
       or v_current.available <> (v_applied ->> 'available')::boolean then
      raise exception 'price_list_auto_action_superseded' using errcode = '55000';
    end if;

    select value into v_previous
    from jsonb_array_elements(v_snap.previous_prices)
    where value ->> 'product_id' = v_applied ->> 'product_id';
    if v_previous is null then
      raise exception 'price_list_auto_action_snapshot_missing' using errcode = 'P0002';
    end if;

    if (v_previous ->> 'existed')::boolean then
      update public.supplier_products
      set current_price = (v_previous ->> 'current_price')::numeric,
          previous_price = v_current.current_price,
          price_effective_date = v_effective_date,
          available = (v_previous ->> 'available')::boolean
      where id = v_current.id;
      insert into public.price_history (
        org_id, supplier_product_id, price, effective_date, created_by
      ) values (
        v_org, v_current.id, (v_previous ->> 'current_price')::numeric,
        v_effective_date, v_user
      );
    else
      update public.supplier_products
      set available = false
      where id = v_current.id;
    end if;
    if coalesce((v_previous ->> 'product_created')::boolean, false) then
      perform public.set_product_active(
        (v_previous ->> 'product_id')::uuid,
        false,
        'ביטול קליטת מחירון אוטומטית: ' || v_reason
      );
    end if;
    v_reverted := v_reverted + 1;
  end loop;

  perform set_config('app.price_list_auto_writer', 'revert', true);
  update public.price_list_interpretation_decisions
  set reverted_at = clock_timestamp(),
      reverted_by = v_user,
      reverted_reason = v_reason
  where id = v_decision.id and org_id = v_org;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_user, 'price_list_auto_action_reverted',
    'price_list_interpretation_decisions', v_decision.id,
    jsonb_build_object(
      'submission_id', v_decision.submission_id,
      'accepted_count', v_decision.accepted_count,
      'outcome', v_decision.outcome
    ),
    jsonb_build_object('reverted_price_count', v_reverted),
    v_reason
  );

  return jsonb_build_object(
    'decision_id', v_decision.id,
    'submission_id', v_decision.submission_id,
    'reverted_price_count', v_reverted
  );
end
$$;
revoke all on function public.revert_price_list_auto_action(uuid, text)
  from public, anon, service_role;
grant execute on function public.revert_price_list_auto_action(uuid, text)
  to authenticated;

-- ===== 7. Scope registry and structural assertions =====
insert into private.scope_registry (table_name, scope_class, enforced) values
  ('price_list_interpretation_decisions', 'org_global', false),
  ('price_list_interpretation_lines', 'org_global', false);

insert into private.scope_definer_exemptions (function_signature, reason, target_wave)
values (
  'private.claim_document_interpretation_jobs(integer,integer)'::regprocedure::text,
  'internal-only -- no role has EXECUTE; the cron wrapper is the only caller. Every candidate '
    || 'derives org_id from one immutable job/document/extraction chain and the function '
    || 'returns only a job id.',
  'multi-unit enablement wave'
);

insert into private.scope_definer_exemptions (function_signature, reason, target_wave)
values (
  'public.apply_price_list_interpretation(uuid,uuid,uuid)'::regprocedure::text,
  'trusted-server-no-scope -- service_role has no user JWT, so auth_scopes() is empty. Tenant '
    || 'identity is pinned by the interpretation org_id and tenant-composite document, job, '
    || 'actor, supplier and submission keys before any price or product write.',
  'multi-unit enablement wave'
);

do $$
declare
  v_violations text;
begin
  if exists (
    select 1 from private.autonomy_policy_definitions
    where policy_key = 'price_list.intake' and baseline_enabled
  ) then
    raise exception '0081 refused: price-list autonomy did not ship off';
  end if;
  if has_function_privilege(
       'authenticated',
       'public.apply_price_list_interpretation(uuid,uuid,uuid)',
       'EXECUTE'
     ) then
    raise exception '0081 refused: browser can execute automatic price intake';
  end if;
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0081 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
