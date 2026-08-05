-- Scope columns and indexes (wave 3, PLAN-03 §2.2).
--
-- Exactly six tables receive a unit pointer -- the six the registry marks enforced:
--   invoices, payments            -> legal_entity   (an invoice is issued to a tax identity)
--   purchase_orders               -> branch         (ordering is a branch operation)
--   goods_receipts,
--   inventory_movements           -> warehouse      (goods arrive somewhere physical)
--   documents                     -> cross-scope    (unit_id stays NULL; the scope of a
--                                                    document follows what it is filed to)
--
-- Three deliberate absences:
--   * NO NOT NULL and NO column DEFAULT. demo_seed.sql and every fixture insert with
--     explicit column lists; a default expression could not reach the org's unit anyway.
--     The BEFORE INSERT triggers below assign the dimension default instead, which works
--     for any column list.
--   * NO policy change. Enforcement is 0057's RESTRICTIVE rider; this migration is only
--     schema, so it can be verified (and reverted) independently of enforcement.
--   * NO trigger for documents. Its default IS null -- org-visible until filed.
--
-- The composite foreign key (org_id, unit_id) -> org_units(org_id, id) makes a
-- cross-tenant unit pointer structurally impossible: the referenced unit must belong to
-- the row's own organization, before any policy is consulted. unit_id NULL passes the FK
-- untouched (MATCH SIMPLE), which is exactly the backward-compatible "org-visible" state.

-- ===== invoices -> legal_entity =====
alter table invoices add column unit_id uuid;
alter table invoices add constraint invoices_unit_fk
  foreign key (org_id, unit_id) references org_units (org_id, id);
create index invoices_org_unit_idx on invoices (org_id, unit_id);

-- ===== payments -> legal_entity =====
alter table payments add column unit_id uuid;
alter table payments add constraint payments_unit_fk
  foreign key (org_id, unit_id) references org_units (org_id, id);
create index payments_org_unit_idx on payments (org_id, unit_id);

-- ===== purchase_orders -> branch =====
alter table purchase_orders add column unit_id uuid;
alter table purchase_orders add constraint purchase_orders_unit_fk
  foreign key (org_id, unit_id) references org_units (org_id, id);
create index purchase_orders_org_unit_idx on purchase_orders (org_id, unit_id);

-- ===== goods_receipts -> warehouse =====
alter table goods_receipts add column unit_id uuid;
alter table goods_receipts add constraint goods_receipts_unit_fk
  foreign key (org_id, unit_id) references org_units (org_id, id);
create index goods_receipts_org_unit_idx on goods_receipts (org_id, unit_id);

-- ===== inventory_movements -> warehouse =====
alter table inventory_movements add column unit_id uuid;
alter table inventory_movements add constraint inventory_movements_unit_fk
  foreign key (org_id, unit_id) references org_units (org_id, id);
create index inventory_movements_org_unit_idx on inventory_movements (org_id, unit_id);

-- The 0026:1 header calls this ledger "single-warehouse". Editing an applied migration is
-- forbidden, so the correction lives here, on the object itself: as of 0055 the ledger is
-- multi-warehouse -- each movement carries the warehouse unit it happened in. The 0026
-- file comment is superseded by this declaration.
comment on table inventory_movements is
  'Immutable inventory ledger. Multi-warehouse as of migration 0055: unit_id references '
  'the warehouse org_unit a movement belongs to (the 0026 header comment declaring a '
  'single-warehouse ledger is superseded).';

-- ===== documents -> cross-scope =====
alter table documents add column unit_id uuid;
alter table documents add constraint documents_unit_fk
  foreign key (org_id, unit_id) references org_units (org_id, id);
create index documents_org_unit_idx on documents (org_id, unit_id);

-- ===== Dimension defaults =====
-- One trigger function, parameterized by dimension. Trigger names are p0_<table>_set_unit
-- on purpose: BEFORE triggers on the same event fire in name order, and 'p0_' sorts before
-- 'p1_<table>_guard' (0023/0033), so the unit is already assigned by the time the
-- financial-command guard inspects the row. (Never 'zz_' -- sorting AFTER the guard would
-- run the default only for rows the guard already accepted, inverting the contract.)
--
-- Null-safety: the function touches no auth context, so seed/demo/service inserts with
-- auth.uid() IS NULL behave identically. If the organization has no units yet (rows
-- replayed between 0055 and 0056 on the upgrade path), p0_default_unit returns NULL and
-- the row simply stays org-visible until 0056 backfills it.
create or replace function p0_set_default_unit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.unit_id is null and new.org_id is not null then
    new.unit_id := p0_default_unit(new.org_id, tg_argv[0]::org_unit_type);
  end if;
  return new;
end
$$;
revoke all on function p0_set_default_unit() from public, anon, authenticated;

create trigger p0_invoices_set_unit
  before insert on invoices
  for each row execute function p0_set_default_unit('legal_entity');

create trigger p0_payments_set_unit
  before insert on payments
  for each row execute function p0_set_default_unit('legal_entity');

create trigger p0_purchase_orders_set_unit
  before insert on purchase_orders
  for each row execute function p0_set_default_unit('branch');

create trigger p0_goods_receipts_set_unit
  before insert on goods_receipts
  for each row execute function p0_set_default_unit('warehouse');

create trigger p0_inventory_movements_set_unit
  before insert on inventory_movements
  for each row execute function p0_set_default_unit('warehouse');

-- No p0_documents_set_unit: documents are cross-scope, their default is NULL by design.
