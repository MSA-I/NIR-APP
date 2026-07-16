-- Nir's feedback round 1:
-- (1) Supplier agent users: can upload/maintain ONLY their own price list, see nothing else.
-- (4) Order confirmation tracking: when + note, on top of the audit log's who.

-- ===== supplier agent linkage =====
alter table profiles add column supplier_id uuid references suppliers(id);

create or replace function auth_supplier() returns uuid
language sql stable security definer set search_path = public as
$$ select supplier_id from profiles where id = auth.uid() and active $$;

-- supplier agents see only their own profile (not the staff roster)
drop policy profiles_select on profiles;
create policy profiles_select on profiles for select using (
  org_id = auth_org() and (auth_role() <> 'supplier' or id = auth.uid()));

-- suppliers: agent reads only its own supplier row
drop policy suppliers_select on suppliers;
create policy suppliers_select on suppliers for select using (org_id = auth_org() and (
  auth_role() in ('owner','office','kitchen','accountant')
  or (auth_role() = 'payer' and exists (select 1 from payment_requests pr where pr.supplier_id = suppliers.id
        and pr.status in ('approved','sent_for_execution','executed','matched')))
  or (auth_role() = 'supplier' and id = auth_supplier())));

-- products: agent may read the catalog (names/units) to match its price file — no prices of others here
drop policy products_select on products;
create policy products_select on products for select using (org_id = auth_org()
  and auth_role() in ('owner','office','kitchen','accountant','supplier'));

-- supplier_products: agent reads/updates/inserts ONLY rows of its own supplier
create policy sp_supplier_select on supplier_products for select using (
  org_id = auth_org() and auth_role() = 'supplier' and supplier_id = auth_supplier());
create policy sp_supplier_insert on supplier_products for insert with check (
  org_id = auth_org() and auth_role() = 'supplier' and supplier_id = auth_supplier());
create policy sp_supplier_update on supplier_products for update using (
  org_id = auth_org() and auth_role() = 'supplier' and supplier_id = auth_supplier())
  with check (supplier_id = auth_supplier());

-- price_history: agent inserts/reads history for its own rows only
create policy ph_supplier_select on price_history for select using (
  org_id = auth_org() and auth_role() = 'supplier'
  and exists (select 1 from supplier_products sp where sp.id = supplier_product_id and sp.supplier_id = auth_supplier()));
create policy ph_supplier_insert on price_history for insert with check (
  org_id = auth_org() and auth_role() = 'supplier'
  and exists (select 1 from supplier_products sp where sp.id = supplier_product_id and sp.supplier_id = auth_supplier()));

-- ===== order confirmation tracking =====
alter table purchase_orders add column confirmed_at timestamptz;
alter table purchase_orders add column confirmation_note text;
