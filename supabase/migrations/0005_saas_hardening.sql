-- SaaS hardening: tenant isolation on storage + the indexes every RLS policy needs.
--
-- (1) Storage was the only place org isolation was missing: the bucket policies checked
--     auth_role() but not the org, so any authenticated user could list the `documents`
--     bucket and download every tenant's invoice photos. The `documents` TABLE was always
--     org-scoped -- the leak was the bucket itself.
-- (2) Every policy in 0001 filters `org_id = auth_org()`, but org_id had no index anywhere,
--     so each of those was a sequential scan. Invisible on demo data, expensive at scale.

-- ===== (1) Storage: org-scoped paths =====
-- New layout: {org_id}/{entity_type}/{entity_id}/{timestamp}_{name}
-- (storage.foldername(name))[1] is the leading org_id folder.

drop policy if exists docs_storage_read on storage.objects;
drop policy if exists docs_storage_insert on storage.objects;
drop policy if exists docs_storage_delete on storage.objects;

create policy docs_storage_read on storage.objects for select using (
  bucket_id = 'documents'
  and (storage.foldername(name))[1] = auth_org()::text
  and auth_role() in ('owner','office','kitchen','accountant','payer'));

create policy docs_storage_insert on storage.objects for insert with check (
  bucket_id = 'documents'
  and (storage.foldername(name))[1] = auth_org()::text
  and auth_role() in ('owner','office','kitchen','payer'));

create policy docs_storage_delete on storage.objects for delete using (
  bucket_id = 'documents'
  and (storage.foldername(name))[1] = auth_org()::text
  and auth_role() in ('owner','office'));

-- ponytail: pre-org-prefix uploads (demo data) become unreadable by design -- a security
-- policy shouldn't carry a grandfather clause. Re-upload them, or re-run seed.sql.

-- ===== (2) org_id indexes -- one per table carrying org_id =====
create index if not exists profiles_org_idx          on profiles (org_id);
create index if not exists categories_org_idx        on categories (org_id);
create index if not exists suppliers_org_idx         on suppliers (org_id);
create index if not exists products_org_idx          on products (org_id);
create index if not exists supplier_products_org_idx on supplier_products (org_id);
create index if not exists price_history_org_idx     on price_history (org_id);
create index if not exists purchase_requests_org_idx on purchase_requests (org_id);
create index if not exists purchase_orders_org_idx   on purchase_orders (org_id);
create index if not exists goods_receipts_org_idx    on goods_receipts (org_id);
create index if not exists invoices_org_idx          on invoices (org_id);
create index if not exists credit_requests_org_idx   on credit_requests (org_id);
create index if not exists payment_requests_org_idx  on payment_requests (org_id);
create index if not exists payments_org_idx          on payments (org_id);
create index if not exists bank_imports_org_idx      on bank_imports (org_id);
create index if not exists bank_transactions_org_idx on bank_transactions (org_id);
create index if not exists exceptions_org_idx        on exceptions (org_id);
create index if not exists documents_org_idx         on documents (org_id);
create index if not exists comments_org_idx          on comments (org_id);
create index if not exists monthly_exports_org_idx   on monthly_exports (org_id);
create index if not exists audit_logs_org_idx        on audit_logs (org_id);

-- ===== (3) FK indexes -- child-table policies use `exists (... where id = <fk>)` per row =====
create index if not exists supplier_categories_supplier_idx on supplier_categories (supplier_id);
create index if not exists supplier_products_supplier_idx   on supplier_products (supplier_id);
create index if not exists supplier_products_product_idx    on supplier_products (product_id);
create index if not exists price_history_sp_idx             on price_history (supplier_product_id);
create index if not exists pri_request_idx                  on purchase_request_items (request_id);
create index if not exists pri_product_idx                  on purchase_request_items (product_id);
create index if not exists purchase_orders_supplier_idx     on purchase_orders (supplier_id);
create index if not exists purchase_orders_request_idx      on purchase_orders (request_id);
create index if not exists poi_order_idx                    on purchase_order_items (order_id);
create index if not exists poi_product_idx                  on purchase_order_items (product_id);
create index if not exists goods_receipts_order_idx         on goods_receipts (order_id);
create index if not exists gri_receipt_idx                  on goods_receipt_items (receipt_id);
create index if not exists gri_product_idx                  on goods_receipt_items (product_id);
create index if not exists invoices_supplier_idx            on invoices (supplier_id);
create index if not exists iol_invoice_idx                  on invoice_order_links (invoice_id);
create index if not exists iol_order_idx                    on invoice_order_links (order_id);
create index if not exists irl_invoice_idx                  on invoice_receipt_links (invoice_id);
create index if not exists irl_receipt_idx                  on invoice_receipt_links (receipt_id);
create index if not exists credit_requests_supplier_idx     on credit_requests (supplier_id);
create index if not exists credit_requests_invoice_idx      on credit_requests (invoice_id);
create index if not exists payment_requests_supplier_idx    on payment_requests (supplier_id);
create index if not exists pri_pr_idx                       on payment_request_invoices (payment_request_id);
create index if not exists pri_invoice_idx                  on payment_request_invoices (invoice_id);
create index if not exists payments_supplier_idx            on payments (supplier_id);
create index if not exists payments_pr_idx                  on payments (payment_request_id);
create index if not exists pa_payment_idx                   on payment_allocations (payment_id);
create index if not exists pa_invoice_idx                   on payment_allocations (invoice_id);
create index if not exists pa_credit_idx                    on payment_allocations (credit_id);
create index if not exists bank_transactions_import_idx     on bank_transactions (import_id);
create index if not exists bank_transactions_supplier_idx   on bank_transactions (supplier_id);
create index if not exists ba_invoice_idx                   on bank_allocations (invoice_id);
create index if not exists ba_payment_idx                   on bank_allocations (payment_id);
create index if not exists exceptions_supplier_idx          on exceptions (supplier_id);
create index if not exists exceptions_invoice_idx           on exceptions (invoice_id);
create index if not exists profiles_supplier_idx            on profiles (supplier_id);

-- ===== Self-check: fail the migration if any org_id column is still unindexed =====
-- Cheap insurance -- a table added later without an index would otherwise just get slow quietly.
do $$
declare missing text;
begin
  select string_agg(c.table_name, ', ')
    into missing
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.column_name = 'org_id'
    and not exists (
      select 1 from pg_index i
      join pg_class t   on t.oid = i.indrelid
      join pg_attribute a on a.attrelid = t.oid and a.attnum = i.indkey[0]
      where t.relname = c.table_name and a.attname = 'org_id');

  if missing is not null then
    raise exception 'org_id has no leading index on: %', missing;
  end if;
end $$;
