-- SupplyFlow — tenant isolation audit.
--
-- Answers two questions about whatever is currently in the database:
--   (A) how many rows each organization owns, per table;
--   (B) whether any row is joined to a parent belonging to a DIFFERENT organization;
--   (C) the same question for junction/child rows, which inherit their tenant through a
--       parent instead of carrying org_id themselves.
--
-- (B) and (C) are the ones that matter, and every `value` in them must be 0. RLS filters
-- `org_id = auth_org()` on the row itself, so a child row carrying org A while its parent
-- belongs to org B would be invisible to both tenants' policies yet still corrupt every
-- join, balance view and report it appears in.
--
-- Deliberately one single statement: the Management API returns only the last result set,
-- so splitting this into three queries would silently report only the third.
--
-- Safe to run any time — it only reads.
--   .\scripts\db-query.ps1 -SqlFile supabase\demo\demo_verify.sql
--   .\scripts\seed-demo.ps1 -VerifyOnly

select section, scope, item, value from (

  -- ===== (A) rows per organization =====
  select 'A. rows per org' as section, o.name as scope, t.table_name as item, t.rows as value
  from organizations o
  join lateral (
    select 'profiles'          as table_name, count(*) as rows from profiles          where org_id = o.id
    union all select 'categories',        count(*) from categories        where org_id = o.id
    union all select 'suppliers',         count(*) from suppliers         where org_id = o.id
    union all select 'products',          count(*) from products          where org_id = o.id
    union all select 'supplier_products', count(*) from supplier_products where org_id = o.id
    union all select 'price_history',     count(*) from price_history     where org_id = o.id
    union all select 'purchase_requests', count(*) from purchase_requests where org_id = o.id
    union all select 'purchase_request_items', count(*) from purchase_request_items where org_id = o.id
    union all select 'purchase_orders',   count(*) from purchase_orders   where org_id = o.id
    union all select 'purchase_order_items', count(*) from purchase_order_items where org_id = o.id
    union all select 'goods_receipts',    count(*) from goods_receipts    where org_id = o.id
    union all select 'goods_receipt_items', count(*) from goods_receipt_items where org_id = o.id
    union all select 'invoices',          count(*) from invoices          where org_id = o.id
    union all select 'invoice_order_links', count(*) from invoice_order_links where org_id = o.id
    union all select 'invoice_receipt_links', count(*) from invoice_receipt_links where org_id = o.id
    union all select 'credit_requests',   count(*) from credit_requests   where org_id = o.id
    union all select 'payment_requests',  count(*) from payment_requests  where org_id = o.id
    union all select 'payment_request_invoices', count(*) from payment_request_invoices where org_id = o.id
    union all select 'payments',          count(*) from payments          where org_id = o.id
    union all select 'payment_allocations', count(*) from payment_allocations where org_id = o.id
    union all select 'bank_allocations',    count(*) from bank_allocations    where org_id = o.id
    union all select 'bank_imports',      count(*) from bank_imports      where org_id = o.id
    union all select 'bank_transactions', count(*) from bank_transactions where org_id = o.id
    union all select 'exceptions',        count(*) from exceptions        where org_id = o.id
    union all select 'documents',         count(*) from documents         where org_id = o.id
    union all select 'comments',          count(*) from comments          where org_id = o.id
    union all select 'monthly_exports',   count(*) from monthly_exports   where org_id = o.id
    union all select 'audit_logs',        count(*) from audit_logs        where org_id = o.id
  ) t on true
  where t.rows > 0

  union all

  -- ===== (B) a row whose parent belongs to another tenant — must all be 0 =====
  select 'B. cross-tenant refs', 'all orgs', relation, bad_rows from (
    select 'profiles -> organizations' as relation, count(*) as bad_rows
      from profiles p left join organizations o on o.id = p.org_id where o.id is null
    union all select 'profiles -> suppliers', count(*)
      from profiles p join suppliers s on s.id = p.supplier_id where s.org_id <> p.org_id
    union all select 'supplier_products -> suppliers', count(*)
      from supplier_products sp join suppliers s on s.id = sp.supplier_id where s.org_id <> sp.org_id
    union all select 'supplier_products -> products', count(*)
      from supplier_products sp join products pr on pr.id = sp.product_id where pr.org_id <> sp.org_id
    union all select 'price_history -> supplier_products', count(*)
      from price_history ph join supplier_products sp on sp.id = ph.supplier_product_id where sp.org_id <> ph.org_id
    union all select 'products -> categories', count(*)
      from products pr join categories c on c.id = pr.category_id where c.org_id <> pr.org_id
    union all select 'purchase_orders -> suppliers', count(*)
      from purchase_orders po join suppliers s on s.id = po.supplier_id where s.org_id <> po.org_id
    union all select 'purchase_orders -> purchase_requests', count(*)
      from purchase_orders po join purchase_requests r on r.id = po.request_id where r.org_id <> po.org_id
    union all select 'goods_receipts -> purchase_orders', count(*)
      from goods_receipts g join purchase_orders po on po.id = g.order_id where po.org_id <> g.org_id
    union all select 'invoices -> suppliers', count(*)
      from invoices i join suppliers s on s.id = i.supplier_id where s.org_id <> i.org_id
    union all select 'credit_requests -> invoices', count(*)
      from credit_requests cr join invoices i on i.id = cr.invoice_id where i.org_id <> cr.org_id
    union all select 'credit_requests -> suppliers', count(*)
      from credit_requests cr join suppliers s on s.id = cr.supplier_id where s.org_id <> cr.org_id
    union all select 'payment_requests -> suppliers', count(*)
      from payment_requests pr join suppliers s on s.id = pr.supplier_id where s.org_id <> pr.org_id
    union all select 'payments -> suppliers', count(*)
      from payments p join suppliers s on s.id = p.supplier_id where s.org_id <> p.org_id
    union all select 'payments -> payment_requests', count(*)
      from payments p join payment_requests pr on pr.id = p.payment_request_id where pr.org_id <> p.org_id
    union all select 'bank_transactions -> bank_imports', count(*)
      from bank_transactions bt join bank_imports bi on bi.id = bt.import_id where bi.org_id <> bt.org_id
    union all select 'bank_transactions -> suppliers', count(*)
      from bank_transactions bt join suppliers s on s.id = bt.supplier_id where s.org_id <> bt.org_id
    union all select 'exceptions -> invoices', count(*)
      from exceptions e join invoices i on i.id = e.invoice_id where i.org_id <> e.org_id
    union all select 'exceptions -> suppliers', count(*)
      from exceptions e join suppliers s on s.id = e.supplier_id where s.org_id <> e.org_id
    union all select 'exceptions -> bank_transactions', count(*)
      from exceptions e join bank_transactions bt on bt.id = e.bank_transaction_id where bt.org_id <> e.org_id
    -- allocations carry their own org_id since migration 0009; it must agree with the parent.
    union all select 'payment_allocations -> payments', count(*)
      from payment_allocations pa join payments p on p.id = pa.payment_id where p.org_id <> pa.org_id
    union all select 'payment_allocations -> invoices', count(*)
      from payment_allocations pa join invoices i on i.id = pa.invoice_id where i.org_id <> pa.org_id
    union all select 'bank_allocations -> bank_transactions', count(*)
      from bank_allocations ba join bank_transactions bt on bt.id = ba.bank_transaction_id where bt.org_id <> ba.org_id
    union all select 'bank_allocations -> invoices', count(*)
      from bank_allocations ba join invoices i on i.id = ba.invoice_id where i.org_id <> ba.org_id
    union all select 'documents path/uploader/supplier/target', count(*)
      from documents d
      left join profiles u on u.id = d.uploaded_by
      left join profiles x on x.id = d.deleted_by
      left join suppliers s on s.id = d.supplier_id
      left join invoices i on d.entity_type = 'invoice' and i.id = d.entity_id
      left join goods_receipts g on d.entity_type = 'goods_receipt' and g.id = d.entity_id
      left join payments p on d.entity_type = 'payment' and p.id = d.entity_id
      where d.storage_path not like d.org_id::text || '/%'
        or (u.id is not null and u.org_id <> d.org_id)
        or (x.id is not null and x.org_id <> d.org_id)
        or (s.id is not null and s.org_id <> d.org_id)
        or (d.entity_type = 'invoice' and (i.id is null or i.org_id <> d.org_id))
        or (d.entity_type = 'goods_receipt' and (g.id is null or g.org_id <> d.org_id))
        or (d.entity_type = 'payment' and (p.id is null or p.org_id <> d.org_id))
    union all select 'tenant actor references', count(*) from (
      select ph.id from price_history ph join profiles p on p.id = ph.created_by where p.org_id <> ph.org_id
      union all select r.id from purchase_requests r join profiles p on p.id = r.created_by where p.org_id <> r.org_id
      union all select o.id from purchase_orders o join profiles p on p.id = o.created_by where p.org_id <> o.org_id
      union all select g.id from goods_receipts g join profiles p on p.id = g.received_by where p.org_id <> g.org_id
      union all select i.id from invoices i join profiles p on p.id = i.received_by where p.org_id <> i.org_id
      union all select c.id from credit_requests c join profiles p on p.id = c.created_by where p.org_id <> c.org_id
      union all select r.id from payment_requests r join profiles p on p.id in (r.created_by, r.approved_by) where p.org_id <> r.org_id
      union all select pmt.id from payments pmt join profiles p on p.id = pmt.executed_by where p.org_id <> pmt.org_id
      union all select b.id from bank_imports b join profiles p on p.id = b.imported_by where p.org_id <> b.org_id
      union all select b.id from bank_allocations b join profiles p on p.id = b.created_by where p.org_id <> b.org_id
      union all select e.id from exceptions e join profiles p on p.id = e.resolved_by where p.org_id <> e.org_id
      union all select c.id from comments c join profiles p on p.id = c.created_by where p.org_id <> c.org_id
      union all select m.id from monthly_exports m join profiles p on p.id = m.sent_by where p.org_id <> m.org_id
      union all select s.id from push_subscriptions s join profiles p on p.id = s.user_id where p.org_id <> s.org_id
      union all select n.id from notifications n join profiles p on p.id = n.user_id where p.org_id <> n.org_id
    ) actor_rows
    union all select 'audit_logs with no org', count(*)
      from audit_logs where org_id is null
    union all select 'audit_logs actor outside org', count(*)
      from audit_logs a join profiles p on p.id = a.user_id
      where p.org_id <> a.org_id
        and not exists (select 1 from platform_admins pa where pa.user_id = a.user_id)
  ) b

  union all

  -- ===== (C) a junction row bridging two tenants — must all be 0 =====
  select 'C. split-tenant children', 'all orgs', relation, bad_rows from (
    select 'supplier_categories (supplier vs category)' as relation, count(*) as bad_rows
      from supplier_categories sc join suppliers s on s.id = sc.supplier_id
      join categories c on c.id = sc.category_id
      where sc.org_id <> s.org_id or sc.org_id <> c.org_id
    union all select 'purchase_request_items (request vs product)', count(*)
      from purchase_request_items i join purchase_requests r on r.id = i.request_id
      join products p on p.id = i.product_id
      where i.org_id <> r.org_id or i.org_id <> p.org_id
    union all select 'purchase_order_items (order vs product)', count(*)
      from purchase_order_items i join purchase_orders o on o.id = i.order_id
      join products p on p.id = i.product_id
      where i.org_id <> o.org_id or i.org_id <> p.org_id
    union all select 'goods_receipt_items (receipt vs order item)', count(*)
      from goods_receipt_items gi join goods_receipts g on g.id = gi.receipt_id
      join purchase_order_items oi on oi.id = gi.order_item_id
      join purchase_orders o on o.id = oi.order_id
      where gi.org_id <> g.org_id or gi.org_id <> oi.org_id or gi.org_id <> o.org_id
    union all select 'invoice_order_links (invoice vs order)', count(*)
      from invoice_order_links l join invoices i on i.id = l.invoice_id
      join purchase_orders o on o.id = l.order_id
      where l.org_id <> i.org_id or l.org_id <> o.org_id
    union all select 'invoice_receipt_links (invoice vs receipt)', count(*)
      from invoice_receipt_links l join invoices i on i.id = l.invoice_id
      join goods_receipts g on g.id = l.receipt_id
      where l.org_id <> i.org_id or l.org_id <> g.org_id
    union all select 'payment_request_invoices (request vs invoice)', count(*)
      from payment_request_invoices pri join payment_requests pr on pr.id = pri.payment_request_id
      join invoices i on i.id = pri.invoice_id
      where pri.org_id <> pr.org_id or pri.org_id <> i.org_id
    union all select 'payment_allocations (payment vs invoice)', count(*)
      from payment_allocations pa join payments p on p.id = pa.payment_id
      join invoices i on i.id = pa.invoice_id where p.org_id <> i.org_id
    union all select 'payment_allocations (payment vs credit)', count(*)
      from payment_allocations pa join payments p on p.id = pa.payment_id
      join credit_requests cr on cr.id = pa.credit_id where p.org_id <> cr.org_id
    union all select 'payment_allocations invalid target/amount/supplier', count(*)
      from payment_allocations pa
      join payments p on p.id = pa.payment_id
      left join invoices i on i.id = pa.invoice_id
      left join credit_requests cr on cr.id = pa.credit_id
      where pa.amount <= 0
        or (pa.invoice_id is null) = (pa.credit_id is null)
        or (i.id is not null and i.supplier_id <> p.supplier_id)
        or (cr.id is not null and cr.supplier_id <> p.supplier_id)
    union all select 'bank_allocations (tx vs invoice)', count(*)
      from bank_allocations ba join bank_transactions bt on bt.id = ba.bank_transaction_id
      join invoices i on i.id = ba.invoice_id where bt.org_id <> i.org_id
    union all select 'bank_allocations (tx vs payment)', count(*)
      from bank_allocations ba join bank_transactions bt on bt.id = ba.bank_transaction_id
      join payments p on p.id = ba.payment_id where bt.org_id <> p.org_id
    union all select 'bank_allocations invalid target/amount', count(*)
      from bank_allocations ba
      where ba.amount <= 0 or (ba.invoice_id is null and ba.payment_id is null)
  ) c

) all_sections
order by section, scope, item;
