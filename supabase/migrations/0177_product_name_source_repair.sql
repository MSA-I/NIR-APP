-- 0177 -- #231: checksum-bound, human-approved repair of raw product names.
--
-- A dry run is prepared only by service_role after it parsed the immutable original price-list
-- bytes. The database rechecks the submission checksum and matches rows by SKU/barcode through
-- the authoritative matcher. Browser callers can only read the resulting preview and approve one
-- ready row at a time. Missing or ambiguous source evidence remains blocked.

create table public.product_name_repair_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  source_submission_id uuid not null,
  source_checksum text not null check (source_checksum ~ '^[0-9a-f]{64}$'),
  source_file_name text not null check (length(btrim(source_file_name)) between 1 and 255),
  target_product_ids uuid[] not null check (cardinality(target_product_ids) between 1 and 500),
  rows_digest text not null check (rows_digest ~ '^[0-9a-f]{32}$'),
  prepared_by uuid not null,
  source_uploaded_by uuid not null,
  created_at timestamptz not null default now(),
  constraint product_name_repair_runs_org_id_id_key unique (org_id, id),
  constraint product_name_repair_runs_source_key unique (org_id, source_submission_id, source_checksum),
  constraint product_name_repair_runs_submission_fk foreign key (org_id, source_submission_id)
    references public.supplier_price_submissions(org_id, id) on delete restrict,
  constraint product_name_repair_runs_actor_fk foreign key (org_id, prepared_by)
    references public.profiles(org_id, id) on delete restrict,
  constraint product_name_repair_runs_uploader_fk foreign key (org_id, source_uploaded_by)
    references public.profiles(org_id, id) on delete restrict
);

create table public.product_name_repair_candidates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  run_id uuid not null,
  source_submission_id uuid not null,
  product_id uuid not null,
  old_name text not null,
  proposed_name text,
  status text not null check (status in ('ready', 'blocked', 'unchanged')),
  reason_code text check (reason_code in ('missing_source', 'ambiguous_source', 'source_name_missing', 'source_same_as_current')),
  source_row integer check (source_row is null or source_row > 0),
  source_evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(source_evidence) = 'object'),
  matched_by text,
  created_at timestamptz not null default now(),
  constraint product_name_repair_candidates_org_id_id_key unique (org_id, id),
  constraint product_name_repair_candidates_product_key unique (org_id, run_id, product_id),
  constraint product_name_repair_candidates_run_fk foreign key (org_id, run_id)
    references public.product_name_repair_runs(org_id, id) on delete restrict,
  constraint product_name_repair_candidates_submission_fk foreign key (org_id, source_submission_id)
    references public.supplier_price_submissions(org_id, id) on delete restrict,
  constraint product_name_repair_candidates_product_fk foreign key (org_id, product_id)
    references public.products(org_id, id) on delete restrict,
  constraint product_name_repair_candidates_shape check (
    (status = 'ready' and proposed_name is not null and reason_code is null and source_row is not null)
    or (status = 'unchanged' and proposed_name is not null and reason_code = 'source_same_as_current')
    or (status = 'blocked' and reason_code in ('missing_source', 'ambiguous_source', 'source_name_missing'))
  ),
  constraint product_name_repair_candidates_name_shape check (
    proposed_name is null or (btrim(proposed_name) <> '' and length(proposed_name) <= 200)
  )
);

create table public.product_name_repair_decisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  candidate_id uuid not null,
  product_id uuid not null,
  idempotency_key uuid not null,
  actor_id uuid not null,
  old_name text not null,
  new_name text not null,
  source_checksum text not null check (source_checksum ~ '^[0-9a-f]{64}$'),
  source_submission_id uuid not null,
  source_row integer not null check (source_row > 0),
  source_evidence jsonb not null check (jsonb_typeof(source_evidence) = 'object'),
  reason text not null check (length(btrim(reason)) between 1 and 1000),
  created_at timestamptz not null default now(),
  constraint product_name_repair_decisions_org_id_id_key unique (org_id, id),
  constraint product_name_repair_decisions_candidate_key unique (org_id, candidate_id),
  constraint product_name_repair_decisions_idempotency_key unique (org_id, idempotency_key),
  constraint product_name_repair_decisions_candidate_fk foreign key (org_id, candidate_id)
    references public.product_name_repair_candidates(org_id, id) on delete restrict,
  constraint product_name_repair_decisions_product_fk foreign key (org_id, product_id)
    references public.products(org_id, id) on delete restrict,
  constraint product_name_repair_decisions_submission_fk foreign key (org_id, source_submission_id)
    references public.supplier_price_submissions(org_id, id) on delete restrict,
  constraint product_name_repair_decisions_actor_fk foreign key (org_id, actor_id)
    references public.profiles(org_id, id) on delete restrict
);

create index product_name_repair_candidates_queue_idx
  on public.product_name_repair_candidates (org_id, status, created_at, id);

create function public.reject_product_name_repair_ledger_mutation()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  raise exception 'product_name_repair_ledger_immutable' using errcode = '42501';
end $$;

create trigger product_name_repair_runs_immutable before update or delete
  on public.product_name_repair_runs for each row execute function public.reject_product_name_repair_ledger_mutation();
create trigger product_name_repair_candidates_immutable before update or delete
  on public.product_name_repair_candidates for each row execute function public.reject_product_name_repair_ledger_mutation();
create trigger product_name_repair_decisions_immutable before update or delete
  on public.product_name_repair_decisions for each row execute function public.reject_product_name_repair_ledger_mutation();

alter table public.product_name_repair_runs enable row level security;
alter table public.product_name_repair_runs force row level security;
alter table public.product_name_repair_candidates enable row level security;
alter table public.product_name_repair_candidates force row level security;
alter table public.product_name_repair_decisions enable row level security;
alter table public.product_name_repair_decisions force row level security;
revoke all on table public.product_name_repair_runs, public.product_name_repair_candidates,
  public.product_name_repair_decisions from public, anon, authenticated;
grant select, insert on table public.product_name_repair_runs, public.product_name_repair_candidates,
  public.product_name_repair_decisions to service_role;

create function public.prepare_product_name_repair_dry_run(
  p_source_submission_id uuid,
  p_requester_id uuid,
  p_source_checksum text,
  p_target_product_ids uuid[],
  p_rows jsonb
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_submission public.supplier_price_submissions;
  v_actor uuid;
  v_uploader uuid;
  v_targets uuid[];
  v_rows_digest text;
  v_existing public.product_name_repair_runs;
  v_run_id uuid := gen_random_uuid();
  v_product public.products;
  v_target uuid;
  v_row jsonb;
  v_match jsonb;
  v_name text;
  v_names text[];
  v_match_count integer;
  v_source_row integer;
  v_evidence jsonb;
  v_matched_by text;
  v_status text;
  v_reason text;
  v_proposed text;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), auth.jwt() ->> 'role', '')
     <> 'service_role' then
    raise exception 'product_name_repair_not_authorized' using errcode = '42501';
  end if;
  if p_source_submission_id is null or p_source_checksum !~ '^[0-9a-f]{64}$'
     or p_target_product_ids is null or cardinality(p_target_product_ids) not between 1 and 500
     or p_rows is null or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) > 5000 then
    raise exception 'product_name_repair_dry_run_invalid' using errcode = '22023';
  end if;

  select s.* into v_submission from public.supplier_price_submissions s
  where s.id = p_source_submission_id for share;
  if not found or v_submission.file_checksum is distinct from lower(p_source_checksum) then
    raise exception 'product_name_repair_source_changed' using errcode = '55000';
  end if;
  select p.id into v_actor from public.profiles p
  where p.org_id = v_submission.org_id and p.id = p_requester_id
    and p.active and p.role in ('owner', 'office');
  if v_actor is null then
    raise exception 'product_name_repair_requester_not_authorized' using errcode = '42501';
  end if;
  select p.id into v_uploader from public.profiles p
  where p.org_id = v_submission.org_id and p.id = v_submission.submitted_by;
  if v_uploader is null then
    raise exception 'product_name_repair_source_uploader_unavailable' using errcode = '55000';
  end if;

  select array_agg(distinct target order by target) into v_targets
  from unnest(p_target_product_ids) target;
  if cardinality(v_targets) <> cardinality(p_target_product_ids) then
    raise exception 'product_name_repair_targets_duplicated' using errcode = '22023';
  end if;
  v_rows_digest := md5(p_rows::text);

  select run.* into v_existing from public.product_name_repair_runs run
  where run.org_id = v_submission.org_id and run.source_submission_id = v_submission.id
    and run.source_checksum = lower(p_source_checksum);
  if found then
    if v_existing.target_product_ids is distinct from v_targets
       or v_existing.rows_digest is distinct from v_rows_digest then
      raise exception 'product_name_repair_dry_run_conflict' using errcode = '55000';
    end if;
    return v_existing.id;
  end if;

  insert into public.product_name_repair_runs (
    id, org_id, source_submission_id, source_checksum, source_file_name,
    target_product_ids, rows_digest, prepared_by, source_uploaded_by
  ) values (
    v_run_id, v_submission.org_id, v_submission.id, lower(p_source_checksum),
    v_submission.file_name, v_targets, v_rows_digest, v_actor, v_uploader
  );

  foreach v_target in array v_targets loop
    select p.* into v_product from public.products p
    where p.org_id = v_submission.org_id and p.id = v_target;
    if not found then
      raise exception 'product_name_repair_product_not_found' using errcode = 'P0002';
    end if;

    v_names := array[]::text[];
    v_match_count := 0;
    v_source_row := null;
    v_evidence := '{}'::jsonb;
    v_matched_by := null;
    for v_row in select value from jsonb_array_elements(p_rows) loop
      if jsonb_typeof(v_row) <> 'object'
         or jsonb_typeof(v_row -> 'source_row') <> 'number'
         or (v_row ->> 'source_row')::integer <= 0
         or coalesce(v_row ->> 'product_name', '') = '' then
        continue;
      end if;
      v_match := private.match_price_list_line(
        v_submission.org_id, v_submission.supplier_id, v_row ->> 'sku', v_row ->> 'barcode'
      );
      if v_match ->> 'status' = 'matched'
         and (v_match ->> 'product_id')::uuid = v_target then
        v_match_count := v_match_count + 1;
        v_name := left(btrim(v_row ->> 'product_name'), 200);
        if not v_name = any(v_names) then v_names := array_append(v_names, v_name); end if;
        if v_source_row is null or (v_row ->> 'source_row')::integer < v_source_row then
          v_source_row := (v_row ->> 'source_row')::integer;
          v_evidence := case when jsonb_typeof(v_row -> 'evidence') = 'object'
            then v_row -> 'evidence' else '{}'::jsonb end;
          v_matched_by := v_match ->> 'matched_by';
        end if;
      end if;
    end loop;

    if v_match_count = 0 then
      v_status := 'blocked'; v_reason := 'missing_source'; v_proposed := null;
    elsif cardinality(v_names) = 0 then
      v_status := 'blocked'; v_reason := 'source_name_missing'; v_proposed := null;
    elsif cardinality(v_names) > 1 then
      v_status := 'blocked'; v_reason := 'ambiguous_source'; v_proposed := null;
    else
      v_proposed := v_names[1];
      if v_proposed = v_product.name then
        v_status := 'unchanged'; v_reason := 'source_same_as_current';
      else
        v_status := 'ready'; v_reason := null;
      end if;
    end if;

    insert into public.product_name_repair_candidates (
      org_id, run_id, source_submission_id, product_id, old_name, proposed_name,
      status, reason_code, source_row, source_evidence, matched_by
    ) values (
      v_submission.org_id, v_run_id, v_submission.id, v_product.id, v_product.name, v_proposed,
      v_status, v_reason, v_source_row, v_evidence, v_matched_by
    );
  end loop;
  return v_run_id;
end $$;

revoke all on function public.prepare_product_name_repair_dry_run(uuid, uuid, text, uuid[], jsonb)
  from public, anon, authenticated;
grant execute on function public.prepare_product_name_repair_dry_run(uuid, uuid, text, uuid[], jsonb)
  to service_role;

create function public.get_product_name_repair_queue()
returns table (
  candidate_id uuid, product_id uuid, status text, reason_code text,
  old_name text, proposed_name text, source_submission_id uuid, source_file_name text,
  source_checksum text, source_row integer, source_evidence jsonb
)
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
begin
  if v_org is null or auth_role() not in ('owner', 'office') then
    raise exception 'product_name_repair_not_authorized' using errcode = '42501';
  end if;
  return query
  select candidate.id, candidate.product_id, candidate.status, candidate.reason_code,
         candidate.old_name, candidate.proposed_name, candidate.source_submission_id,
         run.source_file_name, run.source_checksum, candidate.source_row, candidate.source_evidence
  from public.product_name_repair_candidates candidate
  join public.product_name_repair_runs run
    on run.org_id = candidate.org_id and run.id = candidate.run_id
  left join public.product_name_repair_decisions decision
    on decision.org_id = candidate.org_id and decision.candidate_id = candidate.id
  where candidate.org_id = v_org and decision.id is null
  order by case candidate.status when 'ready' then 0 when 'blocked' then 1 else 2 end,
           candidate.created_at, candidate.id;
end $$;

revoke all on function public.get_product_name_repair_queue() from public, anon, service_role;
grant execute on function public.get_product_name_repair_queue() to authenticated;

create function public.apply_product_name_repair(
  p_candidate_id uuid,
  p_expected_old_name text,
  p_expected_proposed_name text,
  p_expected_source_checksum text,
  p_idempotency_key uuid,
  p_reason text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_actor uuid := auth.uid();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_candidate public.product_name_repair_candidates;
  v_run public.product_name_repair_runs;
  v_product public.products;
  v_existing public.product_name_repair_decisions;
  v_decision_id uuid := gen_random_uuid();
begin
  if v_org is null or v_actor is null or auth_role() not in ('owner', 'office') then
    raise exception 'product_name_repair_not_authorized' using errcode = '42501';
  end if;
  if p_candidate_id is null or p_idempotency_key is null or v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select decision.* into v_existing from public.product_name_repair_decisions decision
  where decision.org_id = v_org and decision.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.candidate_id is distinct from p_candidate_id
       or v_existing.old_name is distinct from p_expected_old_name
       or v_existing.new_name is distinct from p_expected_proposed_name
       or v_existing.source_checksum is distinct from lower(p_expected_source_checksum)
       or v_existing.reason is distinct from v_reason then
      raise exception 'product_name_repair_idempotency_conflict' using errcode = '55000';
    end if;
    return jsonb_build_object('candidate_id', v_existing.candidate_id,
      'product_id', v_existing.product_id, 'idempotent', true);
  end if;

  select candidate.* into v_candidate from public.product_name_repair_candidates candidate
  where candidate.org_id = v_org and candidate.id = p_candidate_id for update;
  if not found then raise exception 'product_name_repair_candidate_not_found' using errcode = 'P0002'; end if;
  if v_candidate.status <> 'ready' then
    raise exception 'product_name_repair_candidate_blocked' using errcode = '55000';
  end if;
  select run.* into v_run from public.product_name_repair_runs run
  where run.org_id = v_org and run.id = v_candidate.run_id for share;
  if v_candidate.old_name is distinct from p_expected_old_name
     or v_candidate.proposed_name is distinct from p_expected_proposed_name
     or v_run.source_checksum is distinct from lower(p_expected_source_checksum) then
    raise exception 'product_name_repair_context_changed' using errcode = '55000';
  end if;
  if exists (select 1 from public.product_name_repair_decisions decision
    where decision.org_id = v_org and decision.candidate_id = v_candidate.id) then
    raise exception 'product_name_repair_already_decided' using errcode = '55000';
  end if;

  select product.* into v_product from public.products product
  where product.org_id = v_org and product.id = v_candidate.product_id for update;
  if not found then raise exception 'product_not_found' using errcode = 'P0002'; end if;
  if v_product.name is distinct from v_candidate.old_name then
    raise exception 'product_name_repair_context_changed' using errcode = '55000';
  end if;

  update public.products set name = v_candidate.proposed_name
  where org_id = v_org and id = v_product.id;
  insert into public.product_name_repair_decisions (
    id, org_id, candidate_id, product_id, idempotency_key, actor_id, old_name, new_name,
    source_checksum, source_submission_id, source_row, source_evidence, reason
  ) values (
    v_decision_id, v_org, v_candidate.id, v_product.id, p_idempotency_key, v_actor,
    v_product.name, v_candidate.proposed_name, v_run.source_checksum,
    v_candidate.source_submission_id, v_candidate.source_row, v_candidate.source_evidence, v_reason
  );
  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_actor, 'product_name_repaired_from_source', 'products', v_product.id,
    jsonb_build_object('name', v_product.name),
    jsonb_build_object('name', v_candidate.proposed_name, 'candidate_id', v_candidate.id,
      'source_submission_id', v_candidate.source_submission_id,
      'source_checksum', v_run.source_checksum, 'source_row', v_candidate.source_row,
      'source_evidence', v_candidate.source_evidence),
    v_reason
  );
  return jsonb_build_object('candidate_id', v_candidate.id, 'product_id', v_product.id,
    'decision_id', v_decision_id, 'idempotent', false);
end $$;

revoke all on function public.apply_product_name_repair(uuid, text, text, text, uuid, text)
  from public, anon, service_role;
grant execute on function public.apply_product_name_repair(uuid, text, text, text, uuid, text)
  to authenticated;

insert into private.scope_registry (table_name, scope_class, enforced) values
  ('product_name_repair_runs', 'org_global', false),
  ('product_name_repair_candidates', 'org_global', false),
  ('product_name_repair_decisions', 'org_global', false);
insert into private.tenant_export_registry (table_name, disposition, excluded_columns, rationale) values
  ('product_name_repair_runs', 'exclude', '{}', 'Derived dry-run working evidence; source submissions export at source.'),
  ('product_name_repair_candidates', 'exclude', '{}', 'Derived preview rows; approved decisions export separately.'),
  ('product_name_repair_decisions', 'include', '{}', 'Human product-name repair decisions with immutable source provenance.')
on conflict (table_name) do update set disposition = excluded.disposition,
  excluded_columns = excluded.excluded_columns, rationale = excluded.rationale;
update private.tenant_export_registry registry
set exported_columns = case when registry.disposition = 'exclude' then '{}'::text[] else (
      select array_agg(c.column_name order by c.ordinal_position) from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = registry.table_name
        and not (c.column_name = any(registry.excluded_columns))
    ) end,
    schema_hash = (select md5(string_agg(c.column_name || ':' || c.data_type || ':' || c.is_nullable,
      '|' order by c.ordinal_position)) from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = registry.table_name)
where registry.table_name in ('product_name_repair_runs', 'product_name_repair_candidates', 'product_name_repair_decisions');

do $$
declare v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then raise exception e'0177 scope assertions failed:\n%', v_violations; end if;
  select string_agg(detail, e'\n' order by detail) into v_violations
    from private.tenant_export_registry_violations();
  if v_violations is not null then raise exception e'0177 export assertions failed:\n%', v_violations; end if;
end $$;
