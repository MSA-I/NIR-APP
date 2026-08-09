-- 0092 -- Immutable invoice-line evidence and server-authoritative three-way matching.
--
-- The order schema had no historical unit snapshot. New purchase-order items receive one here;
-- legacy NULL snapshots remain explicit review work rather than being backfilled from today's
-- product master. There is no approved packaging-conversion or PO-line VAT contract in the
-- repository. Consequently packaging conversions fail to manual review, while only g<->kg and
-- ml<->liter are implicit. Recorded invoice VAT rates are applied exactly to line arithmetic.

-- ===== 1. Future-safe order unit snapshot =====

alter table public.purchase_order_items
  add column unit_snapshot text
  check (unit_snapshot is null or length(trim(unit_snapshot)) between 1 and 100);

create or replace function public.p0_set_purchase_order_item_unit_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product_unit text;
begin
  select p.unit into v_product_unit
  from public.products p
  where p.org_id = new.org_id and p.id = new.product_id;
  if v_product_unit is null then
    raise exception 'purchase_order_item_unit_snapshot_required' using errcode = '23514';
  end if;
  if new.unit_snapshot is not null and trim(new.unit_snapshot) <> trim(v_product_unit) then
    raise exception 'purchase_order_item_unit_snapshot_must_match_product'
      using errcode = '23514';
  end if;
  new.unit_snapshot := v_product_unit;
  return new;
end
$$;
revoke all on function public.p0_set_purchase_order_item_unit_snapshot()
  from public, anon, authenticated, service_role;

create trigger p0_purchase_order_items_unit_snapshot
before insert on public.purchase_order_items
for each row execute function public.p0_set_purchase_order_item_unit_snapshot();

create or replace function public.purchase_order_item_unit_snapshot_immutable()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if new.unit_snapshot is distinct from old.unit_snapshot then
    raise exception 'purchase_order_item_unit_snapshot_immutable' using errcode = '42501';
  end if;
  return new;
end
$$;
revoke all on function public.purchase_order_item_unit_snapshot_immutable()
  from public, anon, authenticated, service_role;
create trigger p0_purchase_order_items_unit_snapshot_immutable
before update on public.purchase_order_items
for each row execute function public.purchase_order_item_unit_snapshot_immutable();

-- ===== 2. Append-only evidence, explicit match allocations and overrides =====

create table public.invoice_line_evidence_batches (
  id uuid primary key,
  org_id uuid not null,
  invoice_id uuid not null,
  revision integer not null check (revision > 0),
  idempotency_key uuid not null,
  source_type text not null check (source_type in ('document_interpretation', 'manual_entry')),
  document_id uuid,
  interpretation_id uuid,
  actor_id uuid not null,
  source_checksum text not null check (source_checksum ~ '^[0-9a-f]{64}$'),
  reason text not null check (reason ~ '[[:graph:]]' and length(reason) <= 1000),
  created_at timestamptz not null default now(),
  constraint invoice_line_evidence_batches_org_id_id_key unique (org_id, id),
  constraint invoice_line_evidence_batches_id_invoice_key unique (org_id, id, invoice_id),
  constraint invoice_line_evidence_batches_revision_key unique (org_id, invoice_id, revision),
  constraint invoice_line_evidence_batches_idempotency_key unique (org_id, idempotency_key),
  constraint invoice_line_evidence_batches_invoice_fk foreign key (org_id, invoice_id)
    references public.invoices(org_id, id) on delete restrict,
  constraint invoice_line_evidence_batches_document_fk foreign key (org_id, document_id)
    references public.documents(org_id, id) on delete restrict,
  constraint invoice_line_evidence_batches_interpretation_fk foreign key (org_id, interpretation_id)
    references public.document_interpretations(org_id, id) on delete restrict,
  constraint invoice_line_evidence_batches_actor_fk foreign key (org_id, actor_id)
    references public.profiles(org_id, id) on delete restrict,
  constraint invoice_line_evidence_batches_source_shape check (
    (source_type = 'manual_entry' and document_id is null and interpretation_id is null)
    or
    (source_type = 'document_interpretation' and document_id is not null and interpretation_id is not null)
  )
);

create table public.invoice_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  evidence_batch_id uuid not null,
  invoice_id uuid not null,
  line_number integer not null check (line_number > 0),
  description text not null check (length(trim(description)) between 1 and 1000),
  supplier_sku text,
  barcode text,
  product_id uuid,
  quantity numeric(18,6) not null check (quantity > 0),
  unit text not null check (length(trim(unit)) between 1 and 100),
  unit_price numeric(18,6) not null check (unit_price >= 0),
  discount_amount numeric(14,2) not null default 0 check (discount_amount >= 0),
  vat_rate numeric(7,4) not null check (vat_rate between 0 and 100),
  -- Normalized source contract: net line amount after discount and before VAT.
  line_total numeric(14,2) not null check (line_total >= 0),
  evidence_block_ids text[] not null default '{}'::text[],
  raw_evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(raw_evidence) = 'object'),
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  constraint invoice_lines_org_id_id_key unique (org_id, id),
  constraint invoice_lines_id_invoice_key unique (org_id, id, invoice_id),
  constraint invoice_lines_batch_line_key unique (org_id, evidence_batch_id, line_number),
  constraint invoice_lines_batch_fk foreign key (org_id, evidence_batch_id)
    references public.invoice_line_evidence_batches(org_id, id) on delete restrict,
  constraint invoice_lines_batch_invoice_fk foreign key (org_id, evidence_batch_id, invoice_id)
    references public.invoice_line_evidence_batches(org_id, id, invoice_id) on delete restrict,
  constraint invoice_lines_invoice_fk foreign key (org_id, invoice_id)
    references public.invoices(org_id, id) on delete restrict,
  constraint invoice_lines_product_fk foreign key (org_id, product_id)
    references public.products(org_id, id) on delete restrict,
  constraint invoice_lines_identifier_shape check (
    supplier_sku is null or length(trim(supplier_sku)) between 1 and 200
  ),
  constraint invoice_lines_barcode_shape check (
    barcode is null or length(trim(barcode)) between 1 and 200
  )
);

create table public.invoice_line_match_sets (
  id uuid primary key,
  org_id uuid not null,
  invoice_id uuid not null,
  evidence_batch_id uuid not null,
  revision integer not null check (revision > 0),
  idempotency_key uuid not null,
  match_checksum text not null check (match_checksum ~ '^[0-9a-f]{64}$'),
  actor_id uuid not null,
  reason text not null check (reason ~ '[[:graph:]]' and length(reason) <= 1000),
  created_at timestamptz not null default now(),
  constraint invoice_line_match_sets_org_id_id_key unique (org_id, id),
  constraint invoice_line_match_sets_id_invoice_key unique (org_id, id, invoice_id),
  constraint invoice_line_match_sets_revision_key unique (org_id, invoice_id, revision),
  constraint invoice_line_match_sets_idempotency_key unique (org_id, idempotency_key),
  constraint invoice_line_match_sets_invoice_fk foreign key (org_id, invoice_id)
    references public.invoices(org_id, id) on delete restrict,
  constraint invoice_line_match_sets_batch_fk foreign key (org_id, evidence_batch_id)
    references public.invoice_line_evidence_batches(org_id, id) on delete restrict,
  constraint invoice_line_match_sets_batch_invoice_fk
    foreign key (org_id, evidence_batch_id, invoice_id)
    references public.invoice_line_evidence_batches(org_id, id, invoice_id) on delete restrict,
  constraint invoice_line_match_sets_actor_fk foreign key (org_id, actor_id)
    references public.profiles(org_id, id) on delete restrict
);

create table public.invoice_line_matches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  match_set_id uuid not null,
  invoice_id uuid not null,
  invoice_line_id uuid not null,
  purchase_order_item_id uuid not null,
  allocated_quantity numeric(18,6) not null check (allocated_quantity > 0),
  created_at timestamptz not null default now(),
  constraint invoice_line_matches_org_id_id_key unique (org_id, id),
  constraint invoice_line_matches_allocation_key
    unique (org_id, match_set_id, invoice_line_id, purchase_order_item_id),
  constraint invoice_line_matches_set_fk foreign key (org_id, match_set_id)
    references public.invoice_line_match_sets(org_id, id) on delete restrict,
  constraint invoice_line_matches_set_invoice_fk foreign key (org_id, match_set_id, invoice_id)
    references public.invoice_line_match_sets(org_id, id, invoice_id) on delete restrict,
  constraint invoice_line_matches_invoice_fk foreign key (org_id, invoice_id)
    references public.invoices(org_id, id) on delete restrict,
  constraint invoice_line_matches_line_fk foreign key (org_id, invoice_line_id)
    references public.invoice_lines(org_id, id) on delete restrict,
  constraint invoice_line_matches_line_invoice_fk foreign key (org_id, invoice_line_id, invoice_id)
    references public.invoice_lines(org_id, id, invoice_id) on delete restrict,
  constraint invoice_line_matches_order_item_fk foreign key (org_id, purchase_order_item_id)
    references public.purchase_order_items(org_id, id) on delete restrict
);

create table public.invoice_three_way_overrides (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  invoice_id uuid not null,
  evidence_batch_id uuid,
  match_set_id uuid,
  override_id uuid,
  assessment_hash text not null check (assessment_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key uuid not null,
  actor_id uuid not null,
  reason text not null check (reason ~ '[[:graph:]]' and length(reason) <= 1000),
  created_at timestamptz not null default now(),
  constraint invoice_three_way_overrides_org_id_id_key unique (org_id, id),
  constraint invoice_three_way_overrides_idempotency_key unique (org_id, idempotency_key),
  constraint invoice_three_way_overrides_assessment_key unique (org_id, invoice_id, assessment_hash),
  constraint invoice_three_way_overrides_invoice_fk foreign key (org_id, invoice_id)
    references public.invoices(org_id, id) on delete restrict,
  constraint invoice_three_way_overrides_batch_fk foreign key (org_id, evidence_batch_id)
    references public.invoice_line_evidence_batches(org_id, id) on delete restrict,
  constraint invoice_three_way_overrides_batch_invoice_fk
    foreign key (org_id, evidence_batch_id, invoice_id)
    references public.invoice_line_evidence_batches(org_id, id, invoice_id) on delete restrict,
  constraint invoice_three_way_overrides_match_set_fk foreign key (org_id, match_set_id)
    references public.invoice_line_match_sets(org_id, id) on delete restrict,
  constraint invoice_three_way_overrides_match_set_invoice_fk
    foreign key (org_id, match_set_id, invoice_id)
    references public.invoice_line_match_sets(org_id, id, invoice_id) on delete restrict,
  constraint invoice_three_way_overrides_actor_fk foreign key (org_id, actor_id)
    references public.profiles(org_id, id) on delete restrict
);

-- Every approval freezes the exact three-way facts used at the financial boundary. Later edits to
-- live supplier SKU/barcode mappings cannot rewrite how an already-approved invoice consumed a
-- purchase-order or receipt quantity. Re-approval appends a higher revision; history is immutable.
create table public.invoice_three_way_approval_snapshots (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  invoice_id uuid not null,
  revision integer not null check (revision > 0),
  evidence_batch_id uuid,
  match_set_id uuid,
  override_id uuid,
  assessment_hash text not null check (assessment_hash ~ '^[0-9a-f]{64}$'),
  assessment jsonb not null check (jsonb_typeof(assessment) = 'object'),
  approved_by uuid not null,
  created_at timestamptz not null default now(),
  constraint invoice_three_way_approval_snapshots_org_id_id_key unique (org_id, id),
  constraint invoice_three_way_approval_snapshots_revision_key
    unique (org_id, invoice_id, revision),
  constraint invoice_three_way_approval_snapshots_invoice_fk foreign key (org_id, invoice_id)
    references public.invoices(org_id, id) on delete restrict,
  constraint invoice_three_way_approval_snapshots_batch_fk foreign key (org_id, evidence_batch_id)
    references public.invoice_line_evidence_batches(org_id, id) on delete restrict,
  constraint invoice_three_way_approval_snapshots_batch_invoice_fk
    foreign key (org_id, evidence_batch_id, invoice_id)
    references public.invoice_line_evidence_batches(org_id, id, invoice_id) on delete restrict,
  constraint invoice_three_way_approval_snapshots_match_set_fk foreign key (org_id, match_set_id)
    references public.invoice_line_match_sets(org_id, id) on delete restrict,
  constraint invoice_three_way_approval_snapshots_match_set_invoice_fk
    foreign key (org_id, match_set_id, invoice_id)
    references public.invoice_line_match_sets(org_id, id, invoice_id) on delete restrict,
  constraint invoice_three_way_approval_snapshots_override_fk foreign key (org_id, override_id)
    references public.invoice_three_way_overrides(org_id, id) on delete restrict,
  constraint invoice_three_way_approval_snapshots_actor_fk foreign key (org_id, approved_by)
    references public.profiles(org_id, id) on delete restrict
);

create index invoice_lines_invoice_idx
  on public.invoice_lines (org_id, invoice_id, evidence_batch_id, line_number);
create index invoice_line_matches_order_item_idx
  on public.invoice_line_matches (org_id, purchase_order_item_id);
create index invoice_three_way_overrides_invoice_idx
  on public.invoice_three_way_overrides (org_id, invoice_id, created_at desc);
create index invoice_three_way_approval_snapshots_invoice_idx
  on public.invoice_three_way_approval_snapshots (org_id, invoice_id, revision desc);

-- Every ledger is append-only and is writable only while one RPC holds its transaction-local
-- writer latch. The service role retains catalog CRUD privileges for the existing P0 contract,
-- but cannot mutate evidence accidentally without explicitly entering the command path.
create or replace function public.invoice_three_way_immutable_guard()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_expected text := case
    when tg_table_name in ('invoice_line_evidence_batches', 'invoice_lines') then 'evidence'
    when tg_table_name in ('invoice_line_match_sets', 'invoice_line_matches') then 'match'
    when tg_table_name = 'invoice_three_way_overrides' then 'override'
    when tg_table_name = 'invoice_three_way_approval_snapshots' then 'approval_snapshot'
  end;
begin
  if tg_op <> 'INSERT' then
    raise exception 'invoice_three_way_evidence_immutable' using errcode = '42501';
  end if;
  if current_setting('app.invoice_three_way_writer', true) is distinct from v_expected then
    raise exception 'invoice_three_way_writer_required' using errcode = '42501';
  end if;
  return new;
end
$$;
revoke all on function public.invoice_three_way_immutable_guard()
  from public, anon, authenticated, service_role;

create trigger invoice_line_evidence_batches_immutable
before insert or update or delete on public.invoice_line_evidence_batches
for each row execute function public.invoice_three_way_immutable_guard();
create trigger invoice_lines_immutable
before insert or update or delete on public.invoice_lines
for each row execute function public.invoice_three_way_immutable_guard();
create trigger invoice_line_match_sets_immutable
before insert or update or delete on public.invoice_line_match_sets
for each row execute function public.invoice_three_way_immutable_guard();
create trigger invoice_line_matches_immutable
before insert or update or delete on public.invoice_line_matches
for each row execute function public.invoice_three_way_immutable_guard();
create trigger invoice_three_way_overrides_immutable
before insert or update or delete on public.invoice_three_way_overrides
for each row execute function public.invoice_three_way_immutable_guard();
create trigger invoice_three_way_approval_snapshots_immutable
before insert or update or delete on public.invoice_three_way_approval_snapshots
for each row execute function public.invoice_three_way_immutable_guard();

-- ===== 3. Tenant and role visibility =====

alter table public.invoice_line_evidence_batches enable row level security;
alter table public.invoice_line_evidence_batches force row level security;
alter table public.invoice_lines enable row level security;
alter table public.invoice_lines force row level security;
alter table public.invoice_line_match_sets enable row level security;
alter table public.invoice_line_match_sets force row level security;
alter table public.invoice_line_matches enable row level security;
alter table public.invoice_line_matches force row level security;
alter table public.invoice_three_way_overrides enable row level security;
alter table public.invoice_three_way_overrides force row level security;
alter table public.invoice_three_way_approval_snapshots enable row level security;
alter table public.invoice_three_way_approval_snapshots force row level security;

create policy invoice_line_evidence_batches_select
on public.invoice_line_evidence_batches for select to authenticated using (
  org_id = auth_org() and exists (
    select 1 from public.invoices i
    where i.org_id = invoice_line_evidence_batches.org_id
      and i.id = invoice_line_evidence_batches.invoice_id and i.deleted_at is null
      and (i.unit_id is null or i.unit_id = any(auth_scopes()))
      and (auth_role() in ('owner','office','kitchen')
        or (auth_role() = 'accountant' and i.review_status = 'approved'))
  )
);
create policy invoice_lines_select
on public.invoice_lines for select to authenticated using (
  org_id = auth_org() and exists (
    select 1 from public.invoices i
    where i.org_id = invoice_lines.org_id and i.id = invoice_lines.invoice_id
      and i.deleted_at is null and (i.unit_id is null or i.unit_id = any(auth_scopes()))
      and (auth_role() in ('owner','office','kitchen')
        or (auth_role() = 'accountant' and i.review_status = 'approved'))
  )
);
create policy invoice_line_match_sets_select
on public.invoice_line_match_sets for select to authenticated using (
  org_id = auth_org() and exists (
    select 1 from public.invoices i
    where i.org_id = invoice_line_match_sets.org_id and i.id = invoice_line_match_sets.invoice_id
      and i.deleted_at is null and (i.unit_id is null or i.unit_id = any(auth_scopes()))
      and (auth_role() in ('owner','office','kitchen')
        or (auth_role() = 'accountant' and i.review_status = 'approved'))
  )
);
create policy invoice_line_matches_select
on public.invoice_line_matches for select to authenticated using (
  org_id = auth_org() and exists (
    select 1 from public.invoices i
    where i.org_id = invoice_line_matches.org_id and i.id = invoice_line_matches.invoice_id
      and i.deleted_at is null and (i.unit_id is null or i.unit_id = any(auth_scopes()))
      and (auth_role() in ('owner','office','kitchen')
        or (auth_role() = 'accountant' and i.review_status = 'approved'))
  )
);
create policy invoice_three_way_overrides_select
on public.invoice_three_way_overrides for select to authenticated using (
  org_id = auth_org() and exists (
    select 1 from public.invoices i
    where i.org_id = invoice_three_way_overrides.org_id and i.id = invoice_three_way_overrides.invoice_id
      and i.deleted_at is null and (i.unit_id is null or i.unit_id = any(auth_scopes()))
      and (auth_role() in ('owner','office')
        or (auth_role() = 'accountant' and i.review_status = 'approved'))
  )
);
create policy invoice_three_way_approval_snapshots_select
on public.invoice_three_way_approval_snapshots for select to authenticated using (
  org_id = auth_org() and exists (
    select 1 from public.invoices i
    where i.org_id = invoice_three_way_approval_snapshots.org_id
      and i.id = invoice_three_way_approval_snapshots.invoice_id
      and i.deleted_at is null
      and (i.unit_id is null or i.unit_id = any(auth_scopes()))
      and (auth_role() in ('owner','office')
        or (auth_role() = 'accountant' and i.review_status = 'approved'))
  )
);

revoke all on table public.invoice_line_evidence_batches,
  public.invoice_lines, public.invoice_line_match_sets, public.invoice_line_matches,
  public.invoice_three_way_overrides, public.invoice_three_way_approval_snapshots
  from public, anon, authenticated, service_role;
grant select on table public.invoice_line_evidence_batches,
  public.invoice_lines, public.invoice_line_match_sets, public.invoice_line_matches,
  public.invoice_three_way_overrides, public.invoice_three_way_approval_snapshots
  to authenticated;
grant all on table public.invoice_line_evidence_batches,
  public.invoice_lines, public.invoice_line_match_sets, public.invoice_line_matches,
  public.invoice_three_way_overrides, public.invoice_three_way_approval_snapshots
  to service_role;

-- Child ledgers inherit both tenant and legal-entity visibility from invoices; ADR-0004 calls
-- this derived scope, so they intentionally carry no independent unit_id.
insert into private.scope_registry (table_name, scope_class, enforced) values
  ('invoice_line_evidence_batches', 'derived', false),
  ('invoice_lines', 'derived', false),
  ('invoice_line_match_sets', 'derived', false),
  ('invoice_line_matches', 'derived', false),
  ('invoice_three_way_overrides', 'derived', false),
  ('invoice_three_way_approval_snapshots', 'derived', false);

-- ===== 4. Unit conversion and deterministic candidates =====

create or replace function private.invoice_unit_canonical(p_unit text)
returns text language sql immutable parallel safe as $$
  select case lower(regexp_replace(trim(coalesce(p_unit, '')), '[[:space:]]+', '', 'g'))
    when 'g' then 'g' when 'gram' then 'g' when 'grams' then 'g' when 'גרם' then 'g'
    when 'kg' then 'kg' when 'kilogram' then 'kg' when 'kilograms' then 'kg'
      when 'קג' then 'kg' when 'ק"ג' then 'kg' when 'ק״ג' then 'kg'
    when 'ml' then 'ml' when 'milliliter' then 'ml' when 'millilitre' then 'ml'
      when 'מ״ל' then 'ml' when 'מ"ל' then 'ml' when 'מל' then 'ml'
    when 'l' then 'liter' when 'liter' then 'liter' when 'litre' then 'liter'
      when 'ליטר' then 'liter'
    else lower(regexp_replace(trim(coalesce(p_unit, '')), '[[:space:]]+', ' ', 'g'))
  end
$$;

create or replace function private.invoice_unit_factor(p_from text, p_to text)
returns numeric language sql immutable parallel safe as $$
  with u as (
    select private.invoice_unit_canonical(p_from) f, private.invoice_unit_canonical(p_to) t
  )
  select case
    when f = '' or t = '' then null
    when f = t then 1::numeric
    when f = 'g' and t = 'kg' then 0.001::numeric
    when f = 'kg' and t = 'g' then 1000::numeric
    when f = 'ml' and t = 'liter' then 0.001::numeric
    when f = 'liter' and t = 'ml' then 1000::numeric
    else null
  end from u
$$;

create or replace function private.invoice_unit_comparison_unit(p_unit text)
returns text language sql immutable parallel safe as $$
  select case private.invoice_unit_canonical(p_unit)
    when 'kg' then 'g'
    when 'liter' then 'ml'
    else private.invoice_unit_canonical(p_unit)
  end
$$;

create or replace function private.invoice_unit_comparison_quantity(p_quantity numeric, p_unit text)
returns numeric language sql immutable parallel safe as $$
  select case private.invoice_unit_canonical(p_unit)
    when 'kg' then p_quantity * 1000
    when 'liter' then p_quantity * 1000
    else p_quantity
  end
$$;

create or replace function private.invoice_unit_comparison_price(p_price numeric, p_unit text)
returns numeric language sql immutable parallel safe as $$
  select case private.invoice_unit_canonical(p_unit)
    when 'kg' then p_price / 1000
    when 'liter' then p_price / 1000
    else p_price
  end
$$;

revoke all on function private.invoice_unit_canonical(text),
  private.invoice_unit_factor(text,text),
  private.invoice_unit_comparison_unit(text),
  private.invoice_unit_comparison_quantity(numeric,text),
  private.invoice_unit_comparison_price(numeric,text)
  from public, anon, authenticated, service_role;

create or replace function private.invoice_line_candidates(p_org_id uuid, p_invoice_id uuid)
returns table (invoice_line_id uuid, purchase_order_item_id uuid)
language sql stable security invoker set search_path = public, private, pg_temp as $$
  with latest_batch as (
    select b.id
    from public.invoice_line_evidence_batches b
    where b.org_id = p_org_id and b.invoice_id = p_invoice_id
    order by b.revision desc limit 1
  )
  select distinct line.id, poi.id
  from latest_batch batch
  join public.invoice_lines line
    on line.org_id = p_org_id and line.evidence_batch_id = batch.id
  join public.invoice_order_links iol
    on iol.org_id = p_org_id and iol.invoice_id = p_invoice_id
  join public.purchase_orders po
    on po.org_id = iol.org_id and po.id = iol.order_id
  join public.invoices inv
    on inv.org_id = p_org_id and inv.id = p_invoice_id and inv.supplier_id = po.supplier_id
  join public.purchase_order_items poi
    on poi.org_id = po.org_id and poi.order_id = po.id
  join public.products product
    on product.org_id = poi.org_id and product.id = poi.product_id
  left join public.supplier_products sp
    on sp.org_id = poi.org_id and sp.supplier_id = inv.supplier_id
   and sp.product_id = poi.product_id
  where (line.product_id is not null and line.product_id = poi.product_id)
     or (line.supplier_sku is not null and sp.supplier_sku is not null
       and lower(trim(line.supplier_sku)) = lower(trim(sp.supplier_sku)))
     or (line.barcode is not null and product.barcode is not null
       and regexp_replace(line.barcode, '[[:space:]-]+', '', 'g')
         = regexp_replace(product.barcode, '[[:space:]-]+', '', 'g'))
$$;

create or replace function private.invoice_effective_line_matches(p_org_id uuid, p_invoice_id uuid)
returns table (
  invoice_line_id uuid,
  purchase_order_item_id uuid,
  allocated_quantity numeric,
  match_source text
)
language sql stable security invoker set search_path = public, private, pg_temp as $$
  with latest_batch as (
    select b.id
    from public.invoice_line_evidence_batches b
    where b.org_id = p_org_id and b.invoice_id = p_invoice_id
    order by b.revision desc limit 1
  ), latest_set as (
    select s.id
    from public.invoice_line_match_sets s join latest_batch b on b.id = s.evidence_batch_id
    where s.org_id = p_org_id and s.invoice_id = p_invoice_id
    order by s.revision desc limit 1
  ), candidate_counts as (
    select c.invoice_line_id, count(*)::integer n,
      (array_agg(c.purchase_order_item_id order by c.purchase_order_item_id))[1] item_id
    from private.invoice_line_candidates(p_org_id, p_invoice_id) c
    group by c.invoice_line_id
  )
  select m.invoice_line_id, m.purchase_order_item_id, m.allocated_quantity, 'explicit'::text
  from latest_set s
  join public.invoice_line_matches m
    on m.org_id = p_org_id and m.match_set_id = s.id
  union all
  select line.id, count.item_id, line.quantity, 'deterministic'::text
  from latest_batch b
  join public.invoice_lines line on line.org_id = p_org_id and line.evidence_batch_id = b.id
  join candidate_counts count on count.invoice_line_id = line.id and count.n = 1
  where not exists (
    select 1
    from latest_set selected_set
    join public.invoice_line_matches selected_match
      on selected_match.org_id = p_org_id
     and selected_match.match_set_id = selected_set.id
     and selected_match.invoice_line_id = line.id
  )
$$;

create or replace function private.invoice_line_identified_product(
  p_org_id uuid,
  p_invoice_id uuid,
  p_invoice_line_id uuid
) returns uuid
language sql stable security invoker set search_path = public, private, pg_temp as $$
  with source_line as (
    select line.product_id
    from public.invoice_lines line
    where line.org_id = p_org_id and line.invoice_id = p_invoice_id
      and line.id = p_invoice_line_id
  ), candidate_products as (
    select distinct item.product_id
    from private.invoice_line_candidates(p_org_id, p_invoice_id) candidate
    join public.purchase_order_items item
      on item.org_id = p_org_id and item.id = candidate.purchase_order_item_id
    where candidate.invoice_line_id = p_invoice_line_id
  )
  select coalesce(line.product_id, case
    when (select count(*) from candidate_products) = 1
      then (select product_id from candidate_products)
    else null
  end)
  from source_line line
$$;

revoke all on function private.invoice_line_candidates(uuid,uuid),
  private.invoice_effective_line_matches(uuid,uuid),
  private.invoice_line_identified_product(uuid,uuid,uuid)
  from public, anon, authenticated, service_role;

-- ===== 5. Server-authoritative evidence and explicit-match commands =====

create or replace function public.record_invoice_line_evidence(
  p_evidence_batch_id uuid,
  p_invoice_id uuid,
  p_idempotency_key uuid,
  p_source_type text,
  p_document_id uuid,
  p_interpretation_id uuid,
  p_actor_id uuid,
  p_lines jsonb,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  -- PostgREST supplies the service_role JWT in production. Disposable DB suites invoke the
  -- trusted command directly as the postgres session with no subject; no browser session can
  -- satisfy either arm because authenticated calls retain session_user=authenticator.
  v_service boolean := auth.role() = 'service_role'
    or (auth.uid() is null and session_user = 'postgres');
  v_invoice public.invoices;
  v_existing public.invoice_line_evidence_batches;
  v_revision integer;
  v_reason text := nullif(trim(p_reason), '');
  v_checksum text;
  v_count integer;
begin
  if p_evidence_batch_id is null or p_invoice_id is null or p_idempotency_key is null
     or p_source_type not in ('document_interpretation', 'manual_entry')
     or p_actor_id is null or jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) = 0 or v_reason is null then
    raise exception 'invoice_line_evidence_fields_required' using errcode = '22023';
  end if;
  if length(v_reason) > 1000 then
    raise exception 'reason_too_long' using errcode = '22023';
  end if;
  if not v_service and (
    v_org is null or v_user is null or auth_role() not in ('owner','office')
    or p_actor_id is distinct from v_user or p_source_type <> 'manual_entry'
  ) then
    raise exception 'invoice_line_evidence_not_authorized' using errcode = '42501';
  end if;
  if v_service and p_source_type <> 'document_interpretation' then
    raise exception 'invoice_line_evidence_service_source_invalid' using errcode = '42501';
  end if;

  select * into v_invoice
  from public.invoices i
  where i.id = p_invoice_id and i.deleted_at is null
    and (v_service or (
      i.org_id = v_org and (i.unit_id is null or i.unit_id = any(public.auth_scopes()))
    ))
  for update;
  if not found then
    raise exception 'invoice_not_found' using errcode = 'P0002';
  end if;
  v_org := v_invoice.org_id;
  if v_invoice.review_status = 'approved' then
    raise exception 'approved_invoice_line_evidence_immutable' using errcode = '55000';
  end if;
  if not exists (
    select 1 from public.profiles p
    where p.org_id = v_org and p.id = p_actor_id and (v_service or p.active)
  ) then
    raise exception 'invoice_line_evidence_actor_invalid' using errcode = '42501';
  end if;

  if p_source_type = 'manual_entry' then
    if p_document_id is not null or p_interpretation_id is not null then
      raise exception 'invoice_line_manual_source_invalid' using errcode = '22023';
    end if;
  elsif not exists (
    select 1
    from public.documents d
    join public.document_interpretations interpretation
      on interpretation.org_id = d.org_id
     and interpretation.document_id = d.id
     and interpretation.id = p_interpretation_id
    where d.org_id = v_org and d.id = p_document_id and d.deleted_at is null
      and d.supplier_id = v_invoice.supplier_id
      and interpretation.interpreted_for_user_id = p_actor_id
  ) then
    raise exception 'invoice_line_document_chain_invalid' using errcode = '42501';
  end if;

  select count(*)::integer into v_count
  from jsonb_to_recordset(p_lines) as line(
    line_number integer, description text, supplier_sku text, barcode text,
    product_id uuid, quantity numeric, unit text, unit_price numeric,
    discount_amount numeric, vat_rate numeric, line_total numeric,
    evidence_block_ids text[], raw_evidence jsonb
  );
  if v_count <> jsonb_array_length(p_lines)
     or v_count <> (select count(distinct line.line_number)
       from jsonb_to_recordset(p_lines) as line(line_number integer))
     or exists (
       select 1
       from jsonb_to_recordset(p_lines) as line(
         line_number integer, description text, supplier_sku text, barcode text,
         product_id uuid, quantity numeric, unit text, unit_price numeric,
         discount_amount numeric, vat_rate numeric, line_total numeric,
         evidence_block_ids text[], raw_evidence jsonb
       )
       where line.line_number is null or line.line_number <= 0
          or nullif(trim(line.description), '') is null
          or length(trim(line.description)) > 1000
          or line.quantity is null or line.quantity <= 0
          or nullif(trim(line.unit), '') is null or length(trim(line.unit)) > 100
          or line.unit_price is null or line.unit_price < 0
          or coalesce(line.discount_amount, 0) < 0
          or coalesce(line.discount_amount, 0) > line.quantity * line.unit_price
          or line.vat_rate is null or line.vat_rate < 0 or line.vat_rate > 100
          or line.line_total is null or line.line_total < 0
          or (line.raw_evidence is not null and jsonb_typeof(line.raw_evidence) <> 'object')
     ) then
    raise exception 'invoice_line_evidence_invalid' using errcode = '22023';
  end if;

  -- A model-supplied product id is accepted only when a stronger supplier SKU or barcode maps
  -- to that exact tenant product. Product name is never an identity signal.
  if p_source_type = 'document_interpretation' and exists (
    select 1
    from jsonb_to_recordset(p_lines) as line(
      product_id uuid, supplier_sku text, barcode text
    )
    where line.product_id is not null and not (
      exists (
        select 1 from public.supplier_products sp
        where sp.org_id = v_org and sp.supplier_id = v_invoice.supplier_id
          and sp.product_id = line.product_id and line.supplier_sku is not null
          and sp.supplier_sku is not null
          and lower(trim(sp.supplier_sku)) = lower(trim(line.supplier_sku))
      ) or exists (
        select 1 from public.products p
        where p.org_id = v_org and p.id = line.product_id and line.barcode is not null
          and p.barcode is not null
          and regexp_replace(p.barcode, '[[:space:]-]+', '', 'g')
            = regexp_replace(line.barcode, '[[:space:]-]+', '', 'g')
      )
    )
  ) then
    raise exception 'invoice_line_product_identity_unproven' using errcode = '22023';
  end if;

  v_checksum := encode(digest(convert_to(p_lines::text, 'utf8'), 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    'invoice-line-evidence:' || v_org::text || ':' || p_idempotency_key::text, 0));
  select * into v_existing
  from public.invoice_line_evidence_batches b
  where b.org_id = v_org and b.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.id is distinct from p_evidence_batch_id
       or v_existing.invoice_id is distinct from p_invoice_id
       or v_existing.source_type is distinct from p_source_type
       or v_existing.document_id is distinct from p_document_id
       or v_existing.interpretation_id is distinct from p_interpretation_id
       or v_existing.actor_id is distinct from p_actor_id
       or v_existing.source_checksum is distinct from v_checksum
       or v_existing.reason is distinct from v_reason then
      raise exception 'invoice_line_evidence_idempotency_conflict' using errcode = '55000';
    end if;
    return jsonb_build_object(
      'evidence_batch_id', v_existing.id, 'revision', v_existing.revision,
      'line_count', (select count(*) from public.invoice_lines l
        where l.org_id = v_org and l.evidence_batch_id = v_existing.id),
      'idempotent', true);
  end if;

  select coalesce(max(b.revision), 0) + 1 into v_revision
  from public.invoice_line_evidence_batches b
  where b.org_id = v_org and b.invoice_id = p_invoice_id;

  perform set_config('app.invoice_three_way_writer', 'evidence', true);
  insert into public.invoice_line_evidence_batches (
    id, org_id, invoice_id, revision, idempotency_key, source_type,
    document_id, interpretation_id, actor_id, source_checksum, reason
  ) values (
    p_evidence_batch_id, v_org, p_invoice_id, v_revision, p_idempotency_key,
    p_source_type, p_document_id, p_interpretation_id, p_actor_id, v_checksum, v_reason
  );
  insert into public.invoice_lines (
    org_id, evidence_batch_id, invoice_id, line_number, description,
    supplier_sku, barcode, product_id, quantity, unit, unit_price,
    discount_amount, vat_rate, line_total, evidence_block_ids, raw_evidence, source_hash
  )
  select v_org, p_evidence_batch_id, p_invoice_id, line.line_number,
    trim(line.description), nullif(trim(line.supplier_sku), ''), nullif(trim(line.barcode), ''),
    line.product_id, line.quantity, trim(line.unit), line.unit_price,
    coalesce(line.discount_amount, 0), line.vat_rate, line.line_total,
    coalesce(line.evidence_block_ids, '{}'::text[]), coalesce(line.raw_evidence, '{}'::jsonb),
    encode(digest(convert_to(to_jsonb(line)::text, 'utf8'), 'sha256'), 'hex')
  from jsonb_to_recordset(p_lines) as line(
    line_number integer, description text, supplier_sku text, barcode text,
    product_id uuid, quantity numeric, unit text, unit_price numeric,
    discount_amount numeric, vat_rate numeric, line_total numeric,
    evidence_block_ids text[], raw_evidence jsonb
  ) order by line.line_number;
  perform set_config('app.invoice_three_way_writer', '', true);

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_org, p_actor_id, 'invoice_line_evidence_recorded',
    'invoice_line_evidence_batches', p_evidence_batch_id,
    jsonb_build_object('invoice_id', p_invoice_id, 'revision', v_revision,
      'source_type', p_source_type, 'source_checksum', v_checksum,
      'line_count', v_count), v_reason
  );
  return jsonb_build_object(
    'evidence_batch_id', p_evidence_batch_id, 'revision', v_revision,
    'line_count', v_count, 'idempotent', false);
end
$$;

revoke all on function public.record_invoice_line_evidence(
  uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb,text
) from public, anon, authenticated, service_role;
grant execute on function public.record_invoice_line_evidence(
  uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb,text
) to authenticated, service_role;

-- `apply_document_interpretation` writes document_auto_actions only after the invoice, optional
-- order link and document filing have committed inside the same transaction. This invoker
-- trigger is therefore the narrow existing caller for line ingestion. It refuses to invent a
-- value: only the exact source keys below, all present and valid, become invoice-line evidence.
-- A partial model result remains preserved on document_interpretations and a linked invoice is
-- stopped by `invoice_lines_missing` until a human records reviewed evidence.
create or replace function public.capture_applied_invoice_line_evidence()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_interpretation public.document_interpretations;
  v_lines jsonb;
  v_reason text;
begin
  if new.outcome <> 'auto_applied' or new.invoice_id is null then
    return new;
  end if;
  if auth.role() <> 'service_role'
     and not (auth.uid() is null and session_user = 'postgres') then
    raise exception 'invoice_line_capture_service_role_required' using errcode = '42501';
  end if;

  select * into v_interpretation
  from public.document_interpretations interpretation
  where interpretation.org_id = new.org_id
    and interpretation.id = new.interpretation_id
    and interpretation.document_id = new.document_id;
  if not found then
    raise exception 'invoice_line_capture_interpretation_missing' using errcode = 'P0002';
  end if;

  if jsonb_typeof(v_interpretation.payload -> 'line_items') <> 'array'
     or jsonb_array_length(v_interpretation.payload -> 'line_items') = 0 then
    return new;
  end if;

  -- The InterpretationContract intentionally permits free-form keys. Financial ingestion does
  -- not: every required fact must use this explicit contract and must be source-present.
  if exists (
    select 1
    from jsonb_array_elements(v_interpretation.payload -> 'line_items') as source(item)
    where coalesce(
            nullif(trim(item #>> '{values,description}'), ''),
            nullif(trim(item #>> '{values,product_name}'), '')) is null
       or length(coalesce(
            nullif(trim(item #>> '{values,description}'), ''),
            nullif(trim(item #>> '{values,product_name}'), ''))) > 1000
       or length(coalesce(item #>> '{values,sku}', '')) > 200
       or length(coalesce(item #>> '{values,barcode}', '')) > 200
       or private.interpretation_number(item #> '{values,quantity}') is null
       or private.interpretation_number(item #> '{values,quantity}') <= 0
       or nullif(trim(item #>> '{values,unit}'), '') is null
       or length(trim(item #>> '{values,unit}')) > 100
       or private.interpretation_number(item #> '{values,unit_price}') is null
       or private.interpretation_number(item #> '{values,unit_price}') < 0
       or private.interpretation_number(item #> '{values,discount_amount}') is null
       or private.interpretation_number(item #> '{values,discount_amount}') < 0
       or private.interpretation_number(item #> '{values,discount_amount}')
            > private.interpretation_number(item #> '{values,quantity}')
              * private.interpretation_number(item #> '{values,unit_price}')
       or private.interpretation_number(item #> '{values,vat_rate}') is null
       or private.interpretation_number(item #> '{values,vat_rate}') not between 0 and 100
       or private.interpretation_number(item #> '{values,line_total}') is null
       or private.interpretation_number(item #> '{values,line_total}') < 0
  ) then
    return new;
  end if;

  select jsonb_agg(jsonb_build_object(
    'line_number', ordinal::integer,
    'description', coalesce(
      nullif(trim(item #>> '{values,description}'), ''),
      nullif(trim(item #>> '{values,product_name}'), '')),
    'supplier_sku', item #>> '{values,sku}',
    'barcode', item #>> '{values,barcode}',
    'product_id', null,
    'quantity', private.interpretation_number(item #> '{values,quantity}'),
    'unit', item #>> '{values,unit}',
    'unit_price', private.interpretation_number(item #> '{values,unit_price}'),
    'discount_amount', private.interpretation_number(item #> '{values,discount_amount}'),
    'vat_rate', private.interpretation_number(item #> '{values,vat_rate}'),
    'line_total', private.interpretation_number(item #> '{values,line_total}'),
    'evidence_block_ids', coalesce(item -> 'evidence_block_ids', '[]'::jsonb),
    'raw_evidence', jsonb_build_object(
      'source_row', item -> 'source_row',
      'interpretation_line', item
    )
  ) order by ordinal) into v_lines
  from jsonb_array_elements(v_interpretation.payload -> 'line_items')
    with ordinality as source(item, ordinal);

  v_reason := format(
    'ראיית שורות אוטומטית מפירוש מסמך. מודל: %s, גרסת פרומפט: %s, פירוש: %s',
    v_interpretation.model, v_interpretation.prompt_version, v_interpretation.id);
  perform public.record_invoice_line_evidence(
    v_interpretation.id,
    new.invoice_id,
    v_interpretation.id,
    'document_interpretation',
    new.document_id,
    v_interpretation.id,
    v_interpretation.interpreted_for_user_id,
    v_lines,
    v_reason
  );
  return new;
end
$$;
revoke all on function public.capture_applied_invoice_line_evidence()
  from public, anon, authenticated, service_role;
comment on function public.capture_applied_invoice_line_evidence()
is 'SECURITY DEFINER trigger-only bridge from an immutable auto-applied document action to exact interpretation line evidence. It has no direct grant; exact org/document/interpretation/actor checks and the downstream append-only command remain mandatory.';

create trigger document_auto_action_captures_invoice_lines
after insert on public.document_auto_actions
for each row execute function public.capture_applied_invoice_line_evidence();

create or replace function public.record_invoice_line_matches(
  p_match_set_id uuid,
  p_invoice_id uuid,
  p_evidence_batch_id uuid,
  p_idempotency_key uuid,
  p_matches jsonb,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_invoice public.invoices;
  v_existing public.invoice_line_match_sets;
  v_revision integer;
  v_reason text := nullif(trim(p_reason), '');
  v_checksum text;
  v_count integer;
begin
  if v_org is null or v_user is null or auth_role() not in ('owner','office') then
    raise exception 'invoice_line_match_not_authorized' using errcode = '42501';
  end if;
  if p_match_set_id is null or p_invoice_id is null or p_evidence_batch_id is null
     or p_idempotency_key is null or jsonb_typeof(p_matches) <> 'array'
     or jsonb_array_length(p_matches) = 0 or v_reason is null then
    raise exception 'invoice_line_match_fields_required' using errcode = '22023';
  end if;
  if length(v_reason) > 1000 then
    raise exception 'reason_too_long' using errcode = '22023';
  end if;

  select * into v_invoice from public.invoices i
  where i.org_id = v_org and i.id = p_invoice_id and i.deleted_at is null
    and (i.unit_id is null or i.unit_id = any(public.auth_scopes()))
  for update;
  if not found then raise exception 'invoice_not_found' using errcode = 'P0002'; end if;
  if v_invoice.review_status = 'approved' then
    raise exception 'approved_invoice_line_matches_immutable' using errcode = '55000';
  end if;
  if not exists (
    select 1 from public.invoice_line_evidence_batches b
    where b.org_id = v_org and b.id = p_evidence_batch_id and b.invoice_id = p_invoice_id
      and b.revision = (select max(x.revision) from public.invoice_line_evidence_batches x
        where x.org_id = v_org and x.invoice_id = p_invoice_id)
  ) then
    raise exception 'invoice_line_current_evidence_required' using errcode = '55000';
  end if;

  select count(*)::integer into v_count
  from jsonb_to_recordset(p_matches) as m(
    invoice_line_id uuid, purchase_order_item_id uuid, allocated_quantity numeric
  );
  if v_count <> jsonb_array_length(p_matches)
     or v_count <> (select count(*) from (
       select distinct m.invoice_line_id, m.purchase_order_item_id
       from jsonb_to_recordset(p_matches) as m(
         invoice_line_id uuid, purchase_order_item_id uuid, allocated_quantity numeric)
     ) distinct_matches)
     or exists (
       select 1
       from jsonb_to_recordset(p_matches) as m(
         invoice_line_id uuid, purchase_order_item_id uuid, allocated_quantity numeric)
       left join public.invoice_lines line
         on line.org_id = v_org and line.id = m.invoice_line_id
        and line.evidence_batch_id = p_evidence_batch_id and line.invoice_id = p_invoice_id
       left join public.purchase_order_items poi
         on poi.org_id = v_org and poi.id = m.purchase_order_item_id
       left join public.purchase_orders po
         on po.org_id = poi.org_id and po.id = poi.order_id
       left join public.invoice_order_links iol
         on iol.org_id = po.org_id and iol.order_id = po.id and iol.invoice_id = p_invoice_id
       where m.invoice_line_id is null or m.purchase_order_item_id is null
          or m.allocated_quantity is null or m.allocated_quantity <= 0
          or line.id is null or poi.id is null or iol.invoice_id is null
          or po.supplier_id is distinct from v_invoice.supplier_id
          -- An explicit human allocation may resolve which linked order owns a line, but it
          -- may not invent a different product identity. The selected item must still be one
          -- of the server-derived candidates proven by product_id, supplier SKU or barcode.
          -- When no candidate exists the evidence itself must be corrected/reviewed first.
          or not exists (
            select 1
            from private.invoice_line_candidates(v_org, p_invoice_id) candidate
            where candidate.invoice_line_id = m.invoice_line_id
              and candidate.purchase_order_item_id = m.purchase_order_item_id
          )
     )
     or exists (
       select 1
       from jsonb_to_recordset(p_matches) as m(
         invoice_line_id uuid, purchase_order_item_id uuid, allocated_quantity numeric)
       join public.invoice_lines line on line.org_id = v_org and line.id = m.invoice_line_id
       group by line.id, line.quantity
       having sum(m.allocated_quantity) > line.quantity
     ) then
    raise exception 'invoice_line_match_invalid' using errcode = '22023';
  end if;

  v_checksum := encode(digest(convert_to(p_matches::text, 'utf8'), 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    'invoice-line-match:' || v_org::text || ':' || p_idempotency_key::text, 0));
  select * into v_existing from public.invoice_line_match_sets s
  where s.org_id = v_org and s.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.id is distinct from p_match_set_id
       or v_existing.invoice_id is distinct from p_invoice_id
       or v_existing.evidence_batch_id is distinct from p_evidence_batch_id
       or v_existing.match_checksum is distinct from v_checksum
       or v_existing.reason is distinct from v_reason then
      raise exception 'invoice_line_match_idempotency_conflict' using errcode = '55000';
    end if;
    return jsonb_build_object('match_set_id', v_existing.id,
      'revision', v_existing.revision, 'match_count', v_count, 'idempotent', true);
  end if;

  select coalesce(max(s.revision), 0) + 1 into v_revision
  from public.invoice_line_match_sets s
  where s.org_id = v_org and s.invoice_id = p_invoice_id;
  perform set_config('app.invoice_three_way_writer', 'match', true);
  insert into public.invoice_line_match_sets (
    id, org_id, invoice_id, evidence_batch_id, revision, idempotency_key,
    match_checksum, actor_id, reason
  ) values (
    p_match_set_id, v_org, p_invoice_id, p_evidence_batch_id, v_revision,
    p_idempotency_key, v_checksum, v_user, v_reason
  );
  insert into public.invoice_line_matches (
    org_id, match_set_id, invoice_id, invoice_line_id,
    purchase_order_item_id, allocated_quantity
  )
  select v_org, p_match_set_id, p_invoice_id, m.invoice_line_id,
    m.purchase_order_item_id, m.allocated_quantity
  from jsonb_to_recordset(p_matches) as m(
    invoice_line_id uuid, purchase_order_item_id uuid, allocated_quantity numeric)
  order by m.invoice_line_id, m.purchase_order_item_id;
  perform set_config('app.invoice_three_way_writer', '', true);

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_org, v_user, 'invoice_line_matches_recorded', 'invoice_line_match_sets', p_match_set_id,
    jsonb_build_object('invoice_id', p_invoice_id, 'evidence_batch_id', p_evidence_batch_id,
      'revision', v_revision, 'match_count', v_count, 'match_checksum', v_checksum), v_reason
  );
  return jsonb_build_object('match_set_id', p_match_set_id,
    'revision', v_revision, 'match_count', v_count, 'idempotent', false);
end
$$;

revoke all on function public.record_invoice_line_matches(uuid,uuid,uuid,uuid,jsonb,text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_invoice_line_matches(uuid,uuid,uuid,uuid,jsonb,text)
  to authenticated;

-- ===== 6. Deterministic three-way assessment =====

-- This reader deliberately produces one deterministic JSON document. Its SHA-256 is the
-- object an owner may override, so any new evidence, match allocation, price snapshot or
-- received quantity invalidates the old override automatically.
create or replace function private.invoice_three_way_raw(
  p_org_id uuid,
  p_invoice_id uuid
) returns jsonb
language plpgsql
stable
security invoker
set search_path = public, private, pg_temp
as $$
declare
  v_invoice public.invoices;
  v_batch public.invoice_line_evidence_batches;
  v_set public.invoice_line_match_sets;
  v_line public.invoice_lines;
  v_match record;
  v_order record;
  v_linked_order_count integer := 0;
  v_candidate_count integer := 0;
  v_allocation_count integer := 0;
  v_allocation_sum numeric := 0;
  v_factor numeric;
  v_normalized_quantity numeric;
  v_normalized_unit_price numeric;
  v_ordered_quantity_tolerance numeric;
  v_received_quantity_tolerance numeric;
  v_line_expected numeric;
  v_identified_product uuid;
  v_expected_vat_rate numeric;
  v_line_duplicate boolean;
  v_definite_duplicate boolean := false;
  v_blocked boolean := false;
  v_warning boolean := false;
  v_reasons jsonb := '[]'::jsonb;
  v_line_reasons jsonb;
  v_line_matches jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_order_items jsonb := '[]'::jsonb;
  v_candidate_context jsonb := '[]'::jsonb;
  v_net_total numeric := 0;
  v_vat_total numeric := 0;
  v_status text;
  v_severity text;
begin
  select * into v_invoice
  from public.invoices i
  where i.org_id = p_org_id and i.id = p_invoice_id and i.deleted_at is null;
  if not found then
    raise exception 'invoice_not_found' using errcode = 'P0002';
  end if;
  select organization.vat_rate into v_expected_vat_rate
  from public.organizations organization
  where organization.id = p_org_id;

  select exists (
    select 1
    from public.invoices duplicate
    where duplicate.org_id = p_org_id
      and duplicate.supplier_id = v_invoice.supplier_id
      and duplicate.id <> v_invoice.id
      and duplicate.deleted_at is null
      and lower(trim(duplicate.invoice_number)) = lower(trim(v_invoice.invoice_number))
  ) into v_definite_duplicate;
  if v_definite_duplicate then
    v_blocked := true;
    v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
      'code', 'definite_duplicate_invoice', 'severity', 'critical',
      'message_key', 'invoice_three_way.definite_duplicate_invoice'
    ));
  end if;

  select count(*)::integer into v_linked_order_count
  from public.invoice_order_links link
  join public.purchase_orders po
    on po.org_id = link.org_id and po.id = link.order_id
  where link.org_id = p_org_id and link.invoice_id = p_invoice_id
    and po.supplier_id = v_invoice.supplier_id;

  select * into v_batch
  from public.invoice_line_evidence_batches batch
  where batch.org_id = p_org_id and batch.invoice_id = p_invoice_id
  order by batch.revision desc
  limit 1;

  if v_linked_order_count = 0 then
    v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
      'code', 'no_order_not_comparable', 'severity', 'info',
      'message_key', 'invoice_three_way.no_order_not_comparable'
    ));
  elsif v_batch.id is null then
    v_blocked := true;
    v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
      'code', 'invoice_lines_missing', 'severity', 'error',
      'message_key', 'invoice_three_way.invoice_lines_missing'
    ));
  end if;

  if v_batch.id is not null then
    select * into v_set
    from public.invoice_line_match_sets match_set
    where match_set.org_id = p_org_id
      and match_set.invoice_id = p_invoice_id
      and match_set.evidence_batch_id = v_batch.id
    order by match_set.revision desc
    limit 1;

    for v_line in
      select line.*
      from public.invoice_lines line
      where line.org_id = p_org_id and line.evidence_batch_id = v_batch.id
      order by line.line_number, line.id
    loop
      v_line_reasons := '[]'::jsonb;
      v_line_matches := '[]'::jsonb;
      v_line_expected := round((v_line.quantity * v_line.unit_price) - v_line.discount_amount, 2);

      if abs(v_line.line_total - v_line_expected) > 0.05 then
        v_blocked := true;
        v_line_reasons := v_line_reasons || jsonb_build_array(jsonb_build_object(
          'code', 'line_arithmetic_discrepancy', 'severity', 'error',
          'expected', v_line_expected, 'actual', v_line.line_total,
          'tolerance', 0.05, 'message_key', 'invoice_three_way.line_arithmetic_discrepancy'
        ));
      end if;

      v_identified_product := private.invoice_line_identified_product(
        p_org_id, p_invoice_id, v_line.id);
      select exists (
        select 1
        from public.invoice_lines other
        where other.org_id = v_line.org_id
          and other.evidence_batch_id = v_line.evidence_batch_id
          and other.id <> v_line.id
          and v_identified_product is not null
          and private.invoice_line_identified_product(
                p_org_id, p_invoice_id, other.id) = v_identified_product
          and private.invoice_unit_comparison_unit(other.unit)
            = private.invoice_unit_comparison_unit(v_line.unit)
          and private.invoice_unit_comparison_quantity(other.quantity, other.unit)
            = private.invoice_unit_comparison_quantity(v_line.quantity, v_line.unit)
          and private.invoice_unit_comparison_price(other.unit_price, other.unit)
            = private.invoice_unit_comparison_price(v_line.unit_price, v_line.unit)
          and other.vat_rate = v_line.vat_rate
          and other.line_total = v_line.line_total
      ) into v_line_duplicate;
      if v_line_duplicate then
        -- Suspicion is kept as two immutable evidence lines; nothing is merged automatically.
        v_warning := true;
        v_line_reasons := v_line_reasons || jsonb_build_array(jsonb_build_object(
          'code', 'duplicate_invoice_line_suspected', 'severity', 'warning',
          'message_key', 'invoice_three_way.duplicate_invoice_line_suspected'
        ));
      end if;

      if v_expected_vat_rate is null then
        v_blocked := true;
        v_line_reasons := v_line_reasons || jsonb_build_array(jsonb_build_object(
          'code', 'expected_vat_rate_missing', 'severity', 'error',
          'actual_vat_rate', v_line.vat_rate,
          'message_key', 'invoice_three_way.expected_vat_rate_missing'
        ));
      elsif v_line.vat_rate <> v_expected_vat_rate then
        v_blocked := true;
        v_line_reasons := v_line_reasons || jsonb_build_array(jsonb_build_object(
          'code', 'vat_rate_mismatch', 'severity', 'error',
          'expected_vat_rate', v_expected_vat_rate,
          'actual_vat_rate', v_line.vat_rate,
          'tolerance', 0,
          'message_key', 'invoice_three_way.vat_rate_mismatch'
        ));
      end if;

      if v_linked_order_count > 0 then
        if v_set.id is not null then
          select count(*)::integer, coalesce(sum(allocation.allocated_quantity), 0)
            into v_allocation_count, v_allocation_sum
          from public.invoice_line_matches allocation
          where allocation.org_id = p_org_id
            and allocation.match_set_id = v_set.id
            and allocation.invoice_line_id = v_line.id;

          if v_allocation_count > 0
             and abs(v_allocation_sum - v_line.quantity) > 0.000001 then
            v_blocked := true;
            v_line_reasons := v_line_reasons || jsonb_build_array(jsonb_build_object(
              'code', 'incomplete_explicit_allocation', 'severity', 'error',
              'invoice_quantity', v_line.quantity, 'allocated_quantity', v_allocation_sum,
              'message_key', 'invoice_three_way.incomplete_explicit_allocation'
            ));
          elsif v_allocation_count = 0 then
            -- A match set is line-scoped: resolving one ambiguous line must not erase a different
            -- line's unique deterministic identity. Unmentioned lines keep the same 0/1/many
            -- candidate policy they had before the explicit set existed.
            select count(*)::integer into v_candidate_count
            from private.invoice_line_candidates(p_org_id, p_invoice_id) candidate
            where candidate.invoice_line_id = v_line.id;
            if v_candidate_count = 0 then
              v_blocked := true;
              v_line_reasons := v_line_reasons || jsonb_build_array(jsonb_build_object(
                'code', 'missing_order_item', 'severity', 'error',
                'message_key', 'invoice_three_way.missing_order_item'
              ));
            elsif v_candidate_count > 1 then
              v_blocked := true;
              v_line_reasons := v_line_reasons || jsonb_build_array(jsonb_build_object(
                'code', 'multi_order_ambiguity', 'severity', 'error',
                'candidate_count', v_candidate_count,
                'message_key', 'invoice_three_way.multi_order_ambiguity'
              ));
            end if;
          end if;
        else
          select count(*)::integer into v_candidate_count
          from private.invoice_line_candidates(p_org_id, p_invoice_id) candidate
          where candidate.invoice_line_id = v_line.id;
          if v_candidate_count = 0 then
            v_blocked := true;
            v_line_reasons := v_line_reasons || jsonb_build_array(jsonb_build_object(
              'code', 'missing_order_item', 'severity', 'error',
              'message_key', 'invoice_three_way.missing_order_item'
            ));
          elsif v_candidate_count > 1 then
            v_blocked := true;
            v_line_reasons := v_line_reasons || jsonb_build_array(jsonb_build_object(
              'code', 'multi_order_ambiguity', 'severity', 'error',
              'candidate_count', v_candidate_count,
              'message_key', 'invoice_three_way.multi_order_ambiguity'
            ));
          end if;
        end if;

        for v_match in
          select effective.purchase_order_item_id,
                 effective.allocated_quantity,
                 effective.match_source,
                 item.order_id,
                 item.product_id as order_product_id,
                 item.qty as ordered_quantity,
                 item.received_qty as received_quantity,
                 item.unit_price as ordered_unit_price,
                 item.unit_snapshot as order_unit
          from private.invoice_effective_line_matches(p_org_id, p_invoice_id) effective
          join public.purchase_order_items item
            on item.org_id = p_org_id and item.id = effective.purchase_order_item_id
          where effective.invoice_line_id = v_line.id
          order by item.order_id, item.id
        loop
          v_factor := private.invoice_unit_factor(v_line.unit, v_match.order_unit);
          if v_match.order_unit is null then
            v_blocked := true;
            v_line_reasons := v_line_reasons || jsonb_build_array(jsonb_build_object(
              'code', 'legacy_order_unit_snapshot_missing', 'severity', 'error',
              'purchase_order_item_id', v_match.purchase_order_item_id,
              'message_key', 'invoice_three_way.legacy_order_unit_snapshot_missing'
            ));
          elsif v_factor is null then
            -- Packaging conversion is never inferred from today's package_size metadata.
            v_blocked := true;
            v_line_reasons := v_line_reasons || jsonb_build_array(jsonb_build_object(
              'code', 'unit_or_packaging_conversion_requires_review', 'severity', 'error',
              'invoice_unit', v_line.unit, 'order_unit', v_match.order_unit,
              'purchase_order_item_id', v_match.purchase_order_item_id,
              'message_key', 'invoice_three_way.unit_or_packaging_conversion_requires_review'
            ));
          else
            v_normalized_quantity := v_match.allocated_quantity * v_factor;
            v_normalized_unit_price := v_line.unit_price / v_factor;
            v_ordered_quantity_tolerance := case
              when private.invoice_unit_canonical(v_match.order_unit) in ('g','kg','ml','liter')
                then v_match.ordered_quantity * 0.02
              else 0
            end;
            v_received_quantity_tolerance := case
              when private.invoice_unit_canonical(v_match.order_unit) in ('g','kg','ml','liter')
                then v_match.received_quantity * 0.02
              else 0
            end;

            if v_line.product_id is not null
               and v_line.product_id <> v_match.order_product_id then
              v_blocked := true;
              v_line_reasons := v_line_reasons || jsonb_build_array(jsonb_build_object(
                'code', 'product_mismatch', 'severity', 'error',
                'purchase_order_item_id', v_match.purchase_order_item_id,
                'message_key', 'invoice_three_way.product_mismatch'
              ));
            end if;

            if v_normalized_unit_price > v_match.ordered_unit_price * 1.01 then
              v_blocked := true;
              v_line_reasons := v_line_reasons || jsonb_build_array(jsonb_build_object(
                'code', 'unit_price_above_order', 'severity', 'error',
                'ordered_unit_price', v_match.ordered_unit_price,
                'invoice_unit_price_normalized', round(v_normalized_unit_price, 6),
                'difference_amount', round(
                  v_normalized_unit_price - v_match.ordered_unit_price, 6),
                'difference_percent', round(
                  case when v_match.ordered_unit_price = 0 then null
                    else ((v_normalized_unit_price / v_match.ordered_unit_price) - 1) * 100 end, 4),
                'tolerance_percent', 1,
                'purchase_order_item_id', v_match.purchase_order_item_id,
                'message_key', 'invoice_three_way.unit_price_above_order'
              ));
            elsif v_normalized_unit_price is distinct from v_match.ordered_unit_price then
              v_warning := true;
              v_line_reasons := v_line_reasons || jsonb_build_array(jsonb_build_object(
                'code', case when v_normalized_unit_price > v_match.ordered_unit_price
                  then 'unit_price_within_tolerance' else 'unit_price_below_order' end,
                'severity', 'warning',
                'ordered_unit_price', v_match.ordered_unit_price,
                'invoice_unit_price_normalized', round(v_normalized_unit_price, 6),
                'difference_amount', round(
                  v_normalized_unit_price - v_match.ordered_unit_price, 6),
                'difference_percent', round(
                  case when v_match.ordered_unit_price = 0 then null
                    else ((v_normalized_unit_price / v_match.ordered_unit_price) - 1) * 100 end, 4),
                'tolerance_percent', 1,
                'purchase_order_item_id', v_match.purchase_order_item_id,
                'message_key', case when v_normalized_unit_price > v_match.ordered_unit_price
                  then 'invoice_three_way.unit_price_within_tolerance'
                  else 'invoice_three_way.unit_price_below_order' end
              ));
            end if;

            v_line_matches := v_line_matches || jsonb_build_array(jsonb_build_object(
              'purchase_order_item_id', v_match.purchase_order_item_id,
              'purchase_order_id', v_match.order_id,
              'source', v_match.match_source,
              'allocated_invoice_quantity', v_match.allocated_quantity,
              'normalized_order_quantity', round(v_normalized_quantity, 6),
              'ordered_quantity', v_match.ordered_quantity,
              'received_quantity', v_match.received_quantity,
              'ordered_quantity_tolerance', round(v_ordered_quantity_tolerance, 6),
              'received_quantity_tolerance', round(v_received_quantity_tolerance, 6),
              'invoice_unit', v_line.unit,
              'order_unit', v_match.order_unit,
              'ordered_unit_price', v_match.ordered_unit_price,
              'invoice_unit_price_normalized', round(v_normalized_unit_price, 6)
            ));
          end if;
        end loop;
      end if;

      v_net_total := v_net_total + v_line.line_total;
      -- VAT rate is the immutable extracted/entered line rate. No PO VAT snapshot exists.
      v_vat_total := v_vat_total + round(v_line.line_total * v_line.vat_rate / 100, 2);
      if jsonb_array_length(v_line_reasons) > 0 then
        v_reasons := v_reasons || (
          select coalesce(jsonb_agg(reason || jsonb_build_object(
            'invoice_line_id', v_line.id, 'line_number', v_line.line_number
          ) order by ordinal), '[]'::jsonb)
          from jsonb_array_elements(v_line_reasons) with ordinality as expanded(reason, ordinal)
        );
      end if;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'id', v_line.id,
        'line_number', v_line.line_number,
        'description', v_line.description,
        'supplier_sku', v_line.supplier_sku,
        'barcode', v_line.barcode,
        'product_id', v_line.product_id,
        'quantity', v_line.quantity,
        'unit', v_line.unit,
        'unit_price', v_line.unit_price,
        'discount_amount', v_line.discount_amount,
        'vat_rate', v_line.vat_rate,
        'line_total', v_line.line_total,
        'reasons', v_line_reasons,
        'matches', v_line_matches
      ));
    end loop;

    -- Aggregate by order item so split lines cannot each pass while exceeding the order or
    -- completed received quantity in total.
    for v_order in
      select item.id as purchase_order_item_id,
             item.order_id,
             item.qty as ordered_quantity,
             item.received_qty as received_quantity,
             item.unit_snapshot as order_unit,
             coalesce(sum(effective.allocated_quantity
               * private.invoice_unit_factor(line.unit, item.unit_snapshot)), 0)
               as current_invoice_quantity,
             coalesce(prior.prior_invoiced_quantity, 0) as prior_invoiced_quantity,
             coalesce(sum(effective.allocated_quantity
               * private.invoice_unit_factor(line.unit, item.unit_snapshot)), 0)
               + coalesce(prior.prior_invoiced_quantity, 0) as invoiced_quantity,
             coalesce(bool_or(private.invoice_unit_factor(line.unit, item.unit_snapshot) is null)
               filter (where effective.invoice_line_id is not null), false)
               or coalesce(prior.has_unresolved_unit, false) as has_unresolved_unit
      from public.invoice_order_links linked
      join public.purchase_orders linked_order
        on linked_order.org_id = linked.org_id and linked_order.id = linked.order_id
       and linked_order.supplier_id = v_invoice.supplier_id
      join public.purchase_order_items item
        on item.org_id = linked_order.org_id and item.order_id = linked_order.id
      left join private.invoice_effective_line_matches(p_org_id, p_invoice_id) effective
        on effective.purchase_order_item_id = item.id
      left join public.invoice_lines line
        on line.org_id = p_org_id and line.id = effective.invoice_line_id
      left join lateral (
        -- Only immutable approval snapshots consume prior PO/receipt quantity. Reading live
        -- supplier SKU/barcode mappings here would allow a later catalog edit to rewrite a prior
        -- invoice's allocation. Draft/review evidence remains visible only on its own invoice.
        with latest_approval as (
          select distinct on (snapshot.invoice_id)
            snapshot.invoice_id, snapshot.assessment
          from public.invoice_three_way_approval_snapshots snapshot
          join public.invoices prior_invoice
            on prior_invoice.org_id = snapshot.org_id
           and prior_invoice.id = snapshot.invoice_id
           and prior_invoice.deleted_at is null
          where snapshot.org_id = p_org_id
            and snapshot.invoice_id <> p_invoice_id
            and prior_invoice.supplier_id = v_invoice.supplier_id
          order by snapshot.invoice_id, snapshot.revision desc
        )
        select
          coalesce(sum((approved_item ->> 'current_invoice_quantity')::numeric), 0)
            as prior_invoiced_quantity,
          coalesce(bool_or(not coalesce(
            (approved_item ->> 'unit_resolved')::boolean, false)), false)
            as has_unresolved_unit
        from latest_approval approval
        cross join lateral jsonb_array_elements(
          coalesce(approval.assessment -> 'order_items', '[]'::jsonb)) approved_item
        where approved_item ->> 'purchase_order_item_id' = item.id::text
      ) prior on true
      where linked.org_id = p_org_id and linked.invoice_id = p_invoice_id
      group by item.id, item.order_id, item.qty, item.received_qty, item.unit_snapshot,
        prior.prior_invoiced_quantity, prior.has_unresolved_unit
      order by item.order_id, item.id
    loop
      v_ordered_quantity_tolerance := case
        when private.invoice_unit_canonical(v_order.order_unit) in ('g','kg','ml','liter')
          then v_order.ordered_quantity * 0.02
        else 0
      end;
      v_received_quantity_tolerance := case
        when private.invoice_unit_canonical(v_order.order_unit) in ('g','kg','ml','liter')
          then v_order.received_quantity * 0.02
        else 0
      end;
      if not v_order.has_unresolved_unit then
        if v_order.invoiced_quantity > v_order.ordered_quantity + v_ordered_quantity_tolerance then
          v_blocked := true;
          v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
            'code', 'invoiced_quantity_above_ordered', 'severity', 'error',
            'purchase_order_item_id', v_order.purchase_order_item_id,
            'ordered_quantity', v_order.ordered_quantity,
            'prior_approved_invoiced_quantity', round(v_order.prior_invoiced_quantity, 6),
            'current_invoice_quantity', round(v_order.current_invoice_quantity, 6),
            'invoiced_quantity', round(v_order.invoiced_quantity, 6),
            'tolerance', round(v_ordered_quantity_tolerance, 6),
            'message_key', 'invoice_three_way.invoiced_quantity_above_ordered'
          ));
        end if;
        if v_order.invoiced_quantity > v_order.received_quantity + v_received_quantity_tolerance then
          v_blocked := true;
          v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
            'code', 'invoiced_quantity_above_received', 'severity', 'error',
            'purchase_order_item_id', v_order.purchase_order_item_id,
            'received_quantity', v_order.received_quantity,
            'prior_approved_invoiced_quantity', round(v_order.prior_invoiced_quantity, 6),
            'current_invoice_quantity', round(v_order.current_invoice_quantity, 6),
            'invoiced_quantity', round(v_order.invoiced_quantity, 6),
            'tolerance', round(v_received_quantity_tolerance, 6),
            'message_key', 'invoice_three_way.invoiced_quantity_above_received'
          ));
        elsif v_order.received_quantity > v_order.invoiced_quantity + v_received_quantity_tolerance then
          v_warning := true;
          v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
            'code', 'received_but_not_invoiced', 'severity', 'warning',
            'purchase_order_item_id', v_order.purchase_order_item_id,
            'received_quantity', v_order.received_quantity,
            'prior_approved_invoiced_quantity', round(v_order.prior_invoiced_quantity, 6),
            'current_invoice_quantity', round(v_order.current_invoice_quantity, 6),
            'invoiced_quantity', round(v_order.invoiced_quantity, 6),
            'tolerance', round(v_received_quantity_tolerance, 6),
            'message_key', 'invoice_three_way.received_but_not_invoiced'
          ));
        end if;
      end if;
      v_order_items := v_order_items || jsonb_build_array(jsonb_build_object(
        'purchase_order_item_id', v_order.purchase_order_item_id,
        'purchase_order_id', v_order.order_id,
        'ordered_quantity', v_order.ordered_quantity,
        'received_quantity', v_order.received_quantity,
        'prior_approved_invoiced_quantity', round(v_order.prior_invoiced_quantity, 6),
        'current_invoice_quantity', round(v_order.current_invoice_quantity, 6),
        'invoiced_quantity', round(v_order.invoiced_quantity, 6),
        'unit', v_order.order_unit,
        'ordered_quantity_tolerance', round(v_ordered_quantity_tolerance, 6),
        'received_quantity_tolerance', round(v_received_quantity_tolerance, 6),
        'unit_resolved', not v_order.has_unresolved_unit
      ));
    end loop;

    if abs(v_net_total - v_invoice.amount_before_vat) > 1 then
      v_blocked := true;
      v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
        'code', 'invoice_net_total_discrepancy', 'severity', 'error',
        'lines_total', round(v_net_total, 2), 'invoice_total', v_invoice.amount_before_vat,
        'tolerance', 1, 'message_key', 'invoice_three_way.invoice_net_total_discrepancy'
      ));
    end if;
    if abs(v_vat_total - v_invoice.vat_amount) > 1 then
      v_blocked := true;
      v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
        'code', 'invoice_vat_total_discrepancy', 'severity', 'error',
        'lines_vat_total', round(v_vat_total, 2), 'invoice_vat_total', v_invoice.vat_amount,
        'tolerance', 1, 'message_key', 'invoice_three_way.invoice_vat_total_discrepancy'
      ));
    end if;
    if abs((v_net_total + v_vat_total) - v_invoice.total_amount) > 1 then
      v_blocked := true;
      v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
        'code', 'invoice_grand_total_discrepancy', 'severity', 'error',
        'lines_grand_total', round(v_net_total + v_vat_total, 2),
        'invoice_total', v_invoice.total_amount,
        'tolerance', 1, 'message_key', 'invoice_three_way.invoice_grand_total_discrepancy'
      ));
    end if;

    -- Candidate context is part of the assessment hash even before a human resolves an
    -- ambiguity. Thus a changed PO snapshot, receipt quantity or candidate identity cannot
    -- continue using an override issued against older facts.
    select coalesce(jsonb_agg(jsonb_build_object(
      'invoice_line_id', candidate.invoice_line_id,
      'purchase_order_item_id', candidate.purchase_order_item_id,
      'purchase_order_id', item.order_id,
      'product_id', item.product_id,
      'ordered_quantity', item.qty,
      'received_quantity', item.received_qty,
      'unit', item.unit_snapshot,
      'unit_price', item.unit_price
    ) order by candidate.invoice_line_id, item.order_id, candidate.purchase_order_item_id), '[]'::jsonb)
      into v_candidate_context
    from private.invoice_line_candidates(p_org_id, p_invoice_id) candidate
    join public.purchase_order_items item
      on item.org_id = p_org_id and item.id = candidate.purchase_order_item_id;
  end if;

  v_status := case
    when v_blocked then 'review_required'
    when v_linked_order_count = 0 then 'not_comparable'
    when v_warning then 'matched_with_warnings'
    else 'matched'
  end;
  v_severity := case
    when v_definite_duplicate then 'critical'
    when v_blocked then 'error'
    when v_warning then 'warning'
    else 'info'
  end;

  return jsonb_build_object(
    'invoice_id', v_invoice.id,
    'evidence_batch_id', v_batch.id,
    'evidence_revision', v_batch.revision,
    'match_set_id', v_set.id,
    'match_revision', v_set.revision,
    'linked_order_count', v_linked_order_count,
    'comparison_state', case when v_linked_order_count = 0 then 'not_comparable' else 'comparable' end,
    'status', v_status,
    'severity', v_severity,
    'approval_blocked', v_blocked,
    'definite_duplicate_invoice', v_definite_duplicate,
    'totals', jsonb_build_object(
      'line_net', round(v_net_total, 2),
      'line_vat', round(v_vat_total, 2),
      'line_grand', round(v_net_total + v_vat_total, 2),
      'invoice_net', v_invoice.amount_before_vat,
      'invoice_vat', v_invoice.vat_amount,
      'invoice_grand', v_invoice.total_amount,
      'line_tolerance', 0.05,
      'invoice_tolerance', 1
    ),
    'reasons', v_reasons,
    'lines', v_lines,
    'order_items', v_order_items,
    'candidate_context', v_candidate_context
  );
end
$$;

revoke all on function private.invoice_three_way_raw(uuid,uuid)
  from public, anon, authenticated, service_role;

create or replace function private.invoice_three_way_assessment_hash(p_assessment jsonb)
returns text language sql immutable parallel safe
set search_path = extensions, pg_catalog
as $$
  select encode(digest(convert_to(p_assessment::text, 'utf8'), 'sha256'), 'hex')
$$;
revoke all on function private.invoice_three_way_assessment_hash(jsonb)
  from public, anon, authenticated, service_role;

-- SECURITY DEFINER is required only so authenticated callers never receive direct USAGE on the
-- private assessment helpers. The projection itself still applies an explicit actor, tenant,
-- capability and legal-scope predicate before evaluating any invoice facts.
create or replace function public.get_invoice_three_way_match(p_invoice_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_raw jsonb;
  v_hash text;
  v_override public.invoice_three_way_overrides;
begin
  if auth.uid() is null or auth_role() not in ('owner','office','kitchen','accountant') then
    raise exception 'invoice_three_way_read_not_authorized' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.invoices i
    where i.org_id = v_org and i.id = p_invoice_id and i.deleted_at is null
      and (i.unit_id is null or i.unit_id = any(public.auth_scopes()))
      and (auth_role() <> 'accountant' or i.review_status = 'approved')
  ) then
    raise exception 'invoice_not_found' using errcode = 'P0002';
  end if;
  v_raw := private.invoice_three_way_raw(v_org, p_invoice_id);
  v_hash := private.invoice_three_way_assessment_hash(v_raw);
  select * into v_override
  from public.invoice_three_way_overrides override_row
  where override_row.org_id = v_org and override_row.invoice_id = p_invoice_id
    and override_row.assessment_hash = v_hash;
  return v_raw || jsonb_build_object(
    'assessment_hash', v_hash,
    'override_active', v_override.id is not null,
    'override', case when v_override.id is null then null else jsonb_build_object(
      'id', v_override.id, 'actor_id', v_override.actor_id,
      'reason', v_override.reason, 'created_at', v_override.created_at
    ) end,
    'approval_allowed', (
      not coalesce((v_raw ->> 'definite_duplicate_invoice')::boolean, false)
      and (
        not coalesce((v_raw ->> 'approval_blocked')::boolean, true)
        or v_override.id is not null
      )
    )
  );
end
$$;
revoke all on function public.get_invoice_three_way_match(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_invoice_three_way_match(uuid) to authenticated;

-- SECURITY DEFINER is required only to append the override and audit/security records. The
-- actor is auth.uid(), tenant is auth_org(), invoice legal scope is auth_scopes(), and the
-- immutable assessment hash is recomputed server-side after the invoice row is locked.
create or replace function public.override_invoice_three_way_match(
  p_invoice_id uuid,
  p_assessment_hash text,
  p_idempotency_key uuid,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_invoice public.invoices;
  v_existing public.invoice_three_way_overrides;
  v_raw jsonb;
  v_hash text;
  v_reason text := nullif(trim(p_reason), '');
begin
  if v_user is null or auth_role() <> 'owner' then
    raise exception 'invoice_three_way_override_not_authorized' using errcode = '42501';
  end if;
  if p_invoice_id is null or p_idempotency_key is null or p_assessment_hash is null
     or p_assessment_hash !~ '^[0-9a-f]{64}$' or v_reason is null then
    raise exception 'invoice_three_way_override_fields_required' using errcode = '22023';
  end if;
  if length(v_reason) > 1000 then
    raise exception 'reason_too_long' using errcode = '22023';
  end if;
  perform public.assert_recent_password_authentication();

  select * into v_invoice
  from public.invoices i
  where i.org_id = v_org and i.id = p_invoice_id and i.deleted_at is null
    and (i.unit_id is null or i.unit_id = any(public.auth_scopes()))
  for update;
  if not found then
    raise exception 'invoice_not_found' using errcode = 'P0002';
  end if;
  if v_invoice.review_status = 'approved' then
    raise exception 'approved_invoice_override_immutable' using errcode = '55000';
  end if;

  v_raw := private.invoice_three_way_raw(v_org, p_invoice_id);
  v_hash := private.invoice_three_way_assessment_hash(v_raw);
  if v_hash <> p_assessment_hash then
    raise exception 'invoice_three_way_assessment_stale' using errcode = '40001';
  end if;
  if coalesce((v_raw ->> 'definite_duplicate_invoice')::boolean, false) then
    raise exception 'definite_duplicate_invoice_cannot_be_overridden' using errcode = '55000';
  end if;
  if not coalesce((v_raw ->> 'approval_blocked')::boolean, true) then
    raise exception 'invoice_three_way_override_not_required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'invoice-three-way-override:' || v_org::text || ':' || p_idempotency_key::text, 0));
  -- Re-check identity, scope and the fresh-password window after waiting for serialization.
  if auth.uid() is distinct from v_user or auth_org() is distinct from v_org
     or auth_role() <> 'owner'
     or not (v_invoice.unit_id is null or v_invoice.unit_id = any(public.auth_scopes())) then
    raise exception 'invoice_three_way_override_not_authorized' using errcode = '42501';
  end if;
  perform public.assert_recent_password_authentication();

  select * into v_existing
  from public.invoice_three_way_overrides override_row
  where override_row.org_id = v_org and override_row.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.invoice_id is distinct from p_invoice_id
       or v_existing.assessment_hash is distinct from v_hash
       or v_existing.reason is distinct from v_reason then
      raise exception 'invoice_three_way_override_idempotency_conflict' using errcode = '55000';
    end if;
    return jsonb_build_object('override_id', v_existing.id,
      'assessment_hash', v_existing.assessment_hash, 'idempotent', true);
  end if;

  select * into v_existing
  from public.invoice_three_way_overrides override_row
  where override_row.org_id = v_org and override_row.invoice_id = p_invoice_id
    and override_row.assessment_hash = v_hash;
  if found then
    return jsonb_build_object('override_id', v_existing.id,
      'assessment_hash', v_existing.assessment_hash, 'idempotent', true);
  end if;

  perform set_config('app.invoice_three_way_writer', 'override', true);
  insert into public.invoice_three_way_overrides (
    org_id, invoice_id, evidence_batch_id, match_set_id, assessment_hash,
    idempotency_key, actor_id, reason
  ) values (
    v_org, p_invoice_id, nullif(v_raw ->> 'evidence_batch_id', '')::uuid,
    nullif(v_raw ->> 'match_set_id', '')::uuid, v_hash,
    p_idempotency_key, v_user, v_reason
  ) returning * into v_existing;
  perform set_config('app.invoice_three_way_writer', '', true);

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_org, v_user, 'invoice_three_way_match_overridden', 'invoice_three_way_overrides',
    v_existing.id, jsonb_build_object(
      'invoice_id', p_invoice_id, 'assessment_hash', v_hash,
      'evidence_batch_id', v_existing.evidence_batch_id,
      'match_set_id', v_existing.match_set_id,
      'reason_codes', (select coalesce(jsonb_agg(reason ->> 'code'), '[]'::jsonb)
        from jsonb_array_elements(v_raw -> 'reasons') reason)
    ), v_reason
  );
  perform private.record_security_event(v_org, v_user, 'invoice_three_way_match_overridden',
    jsonb_build_object('invoice_id', p_invoice_id, 'override_id', v_existing.id,
      'assessment_hash', v_hash));

  return jsonb_build_object('override_id', v_existing.id,
    'assessment_hash', v_existing.assessment_hash, 'idempotent', false);
end
$$;
revoke all on function public.override_invoice_three_way_match(uuid,text,uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.override_invoice_three_way_match(uuid,text,uuid,text)
  to authenticated;

-- ===== 7. Hard approval boundary =====

create or replace function public.invoice_three_way_approval_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, private, pg_temp
as $$
declare
  v_raw jsonb;
  v_hash text;
begin
  if new.review_status <> 'approved' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    raise exception 'invoice_approval_requires_persisted_three_way_assessment'
      using errcode = '55000';
  end if;
  if old.review_status = 'approved' then
    return new;
  end if;

  -- Different invoices can target the same receipt. Serialize approval by tenant and supplier
  -- before measuring prior approved allocations so two concurrent requests cannot both observe
  -- the same remaining quantity and over-commit it.
  perform pg_advisory_xact_lock(hashtextextended(
    'invoice-three-way-approval:' || new.org_id::text || ':' || new.supplier_id::text, 0));

  v_raw := private.invoice_three_way_raw(new.org_id, new.id);
  v_hash := private.invoice_three_way_assessment_hash(v_raw);
  if coalesce((v_raw ->> 'definite_duplicate_invoice')::boolean, false) then
    raise exception 'invoice_approval_blocked_definite_duplicate' using errcode = '55000';
  end if;
  if coalesce((v_raw ->> 'approval_blocked')::boolean, true)
     and not exists (
       select 1 from public.invoice_three_way_overrides override_row
       where override_row.org_id = new.org_id and override_row.invoice_id = new.id
         and override_row.assessment_hash = v_hash
     ) then
    raise exception 'invoice_approval_blocked_three_way_review' using errcode = '55000';
  end if;
  return new;
end
$$;
revoke all on function public.invoice_three_way_approval_guard()
  from public, anon, authenticated, service_role;

create or replace function private.capture_invoice_three_way_approval_snapshot()
returns trigger
language plpgsql
security invoker
set search_path = public, private, pg_temp
as $$
declare
  v_raw jsonb;
  v_hash text;
  v_revision integer;
  v_override_id uuid;
begin
  if new.review_status <> 'approved' or old.review_status = 'approved' then
    return new;
  end if;

  v_raw := private.invoice_three_way_raw(new.org_id, new.id);
  v_hash := private.invoice_three_way_assessment_hash(v_raw);
  select override_row.id into v_override_id
  from public.invoice_three_way_overrides override_row
  where override_row.org_id = new.org_id
    and override_row.invoice_id = new.id
    and override_row.assessment_hash = v_hash;
  select coalesce(max(snapshot.revision), 0) + 1 into v_revision
  from public.invoice_three_way_approval_snapshots snapshot
  where snapshot.org_id = new.org_id and snapshot.invoice_id = new.id;

  perform set_config('app.invoice_three_way_writer', 'approval_snapshot', true);
  insert into public.invoice_three_way_approval_snapshots (
    org_id, invoice_id, revision, evidence_batch_id, match_set_id, override_id,
    assessment_hash, assessment, approved_by
  ) values (
    new.org_id, new.id, v_revision,
    nullif(v_raw ->> 'evidence_batch_id', '')::uuid,
    nullif(v_raw ->> 'match_set_id', '')::uuid,
    v_override_id, v_hash, v_raw, auth.uid()
  );
  perform set_config('app.invoice_three_way_writer', '', true);
  return new;
end
$$;
revoke all on function private.capture_invoice_three_way_approval_snapshot()
  from public, anon, authenticated, service_role;

create trigger invoice_three_way_approval_guard_insert
before insert on public.invoices
for each row execute function public.invoice_three_way_approval_guard();
create trigger invoice_three_way_approval_guard_update
before update of review_status on public.invoices
for each row execute function public.invoice_three_way_approval_guard();
create trigger invoice_three_way_approval_snapshot_update
after update of review_status on public.invoices
for each row execute function private.capture_invoice_three_way_approval_snapshot();

comment on function public.record_invoice_line_evidence(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb,text)
is 'SECURITY DEFINER: appends immutable tenant-scoped invoice evidence. Browser actor is auth.uid; service path requires an exact document interpretation chain. Touches invoices, documents, interpretations, profiles, audit_logs. Mandatory reason and idempotency key.';
comment on function public.record_invoice_line_matches(uuid,uuid,uuid,uuid,jsonb,text)
is 'SECURITY DEFINER: appends explicit allocations across all invoice-linked purchase orders. Actor is auth.uid; tenant and legal scope are rechecked. Touches immutable match ledgers and audit_logs. Mandatory reason and idempotency key.';
comment on function public.override_invoice_three_way_match(uuid,text,uuid,text)
is 'SECURITY DEFINER: owner-only fresh-password override of one immutable assessment hash. Definite duplicate invoices cannot be overridden. Tenant/legal scope, reason, audit, security event and idempotency are mandatory.';
comment on function public.get_invoice_three_way_match(uuid)
is 'SECURITY DEFINER: narrow read projection over private assessment helpers. Actor is auth.uid; tenant, capability and null-or-auth_scopes legal scope are checked before any result is returned.';
comment on function private.capture_invoice_three_way_approval_snapshot()
is 'SECURITY INVOKER trigger: appends the exact immutable three-way assessment used at each approval. Prior approved quantities are read only from these snapshots, never from mutable live SKU/barcode mappings.';

-- 0088 requires every definer that touches a scoped financial table to pin its reviewed live
-- body. These registrations are migration-time hashes of the exact declarations above; any
-- later CREATE OR REPLACE without a deliberate reviewed ledger update fails A5.
insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
)
select reviewed.function_signature, md5(proc.prosrc), 'filtered_read', reviewed.scope_proof
from (values
  (
    'record_invoice_line_evidence(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb,text)',
    '0092 locks the exact invoice; browser actors are filtered by tenant and null-or-auth_scopes unit, while service ingestion requires an exact tenant document/interpretation/actor chain.'
  ),
  (
    'record_invoice_line_matches(uuid,uuid,uuid,uuid,jsonb,text)',
    '0092 locks the exact tenant invoice through a null-or-auth_scopes unit predicate before validating every explicit allocation against linked supplier purchase orders.'
  ),
  (
    'override_invoice_three_way_match(uuid,text,uuid,text)',
    '0092 locks the exact tenant invoice through a null-or-auth_scopes unit predicate and rechecks owner identity, scope and fresh password after serialization.'
  ),
  (
    'get_invoice_three_way_match(uuid)',
    '0092 exposes private assessment helpers only after filtering the exact invoice by auth_org, role and the canonical null-or-auth_scopes legal-unit predicate.'
  )
) as reviewed(function_signature, scope_proof)
join pg_catalog.pg_proc proc
  on proc.oid = pg_catalog.to_regprocedure(reviewed.function_signature);

-- Re-run the canonical scope gate after registering every derived table and adding definers.
do $$
declare v_violations text;
begin
  select string_agg(assertion || ': ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0092 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
