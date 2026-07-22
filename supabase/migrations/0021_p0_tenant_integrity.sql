-- P0 tenant-integrity expand/contract.
-- relation -> writer -> invariant -> enforcement
-- catalog/order/receipt/invoice links -> browser + draft RPC -> every endpoint shares org -> org_id + composite FK
-- payment/bank allocations -> browser (P1 cutover later) -> parent and targets share org -> existing derived org + composite FK
-- profile actor references -> browser/tenant RPC -> actor is a member of the row org -> composite FK
-- audit_logs.user_id is deliberately excluded: a platform operation may audit into a tenant it does not belong to.

-- Fail before changing data. IDs are the only row data exposed in the error.
do $$
declare v_relation text; v_ids text;
begin
  select relation, ids into v_relation, v_ids
  from (
    select 'supplier_categories' relation,
           string_agg(concat_ws(':', sc.supplier_id, sc.category_id), ', ' order by sc.supplier_id) ids
    from supplier_categories sc join suppliers s on s.id = sc.supplier_id
    join categories c on c.id = sc.category_id where s.org_id <> c.org_id
    union all
    select 'supplier_products', string_agg(sp.id::text, ', ' order by sp.id)
    from supplier_products sp join suppliers s on s.id = sp.supplier_id
    join products p on p.id = sp.product_id
    where sp.org_id <> s.org_id or sp.org_id <> p.org_id
    union all
    select 'price_history', string_agg(ph.id::text, ', ' order by ph.id)
    from price_history ph join supplier_products sp on sp.id = ph.supplier_product_id
    where ph.org_id <> sp.org_id
    union all
    select 'purchase_request_items', string_agg(i.id::text, ', ' order by i.id)
    from purchase_request_items i join purchase_requests r on r.id = i.request_id
    join products p on p.id = i.product_id
    left join suppliers rs on rs.id = i.recommended_supplier_id
    left join suppliers cs on cs.id = i.chosen_supplier_id
    where r.org_id <> p.org_id or (rs.id is not null and rs.org_id <> r.org_id)
       or (cs.id is not null and cs.org_id <> r.org_id)
    union all
    select 'purchase_orders', string_agg(po.id::text, ', ' order by po.id)
    from purchase_orders po join suppliers s on s.id = po.supplier_id
    left join purchase_requests r on r.id = po.request_id
    where po.org_id <> s.org_id or (r.id is not null and po.org_id <> r.org_id)
    union all
    select 'purchase_order_items', string_agg(i.id::text, ', ' order by i.id)
    from purchase_order_items i join purchase_orders o on o.id = i.order_id
    join products p on p.id = i.product_id where o.org_id <> p.org_id
    union all
    select 'goods_receipts', string_agg(g.id::text, ', ' order by g.id)
    from goods_receipts g join purchase_orders o on o.id = g.order_id where g.org_id <> o.org_id
    union all
    select 'goods_receipt_items', string_agg(i.id::text, ', ' order by i.id)
    from goods_receipt_items i join goods_receipts g on g.id = i.receipt_id
    join purchase_order_items oi on oi.id = i.order_item_id
    join purchase_orders o on o.id = oi.order_id join products p on p.id = i.product_id
    where g.org_id <> o.org_id or g.org_id <> p.org_id
    union all
    select 'invoice_order_links', string_agg(concat_ws(':', l.invoice_id, l.order_id), ', ' order by l.invoice_id)
    from invoice_order_links l join invoices i on i.id = l.invoice_id
    join purchase_orders o on o.id = l.order_id where i.org_id <> o.org_id
    union all
    select 'invoice_receipt_links', string_agg(concat_ws(':', l.invoice_id, l.receipt_id), ', ' order by l.invoice_id)
    from invoice_receipt_links l join invoices i on i.id = l.invoice_id
    join goods_receipts g on g.id = l.receipt_id where i.org_id <> g.org_id
    union all
    select 'credit_requests', string_agg(c.id::text, ', ' order by c.id)
    from credit_requests c join suppliers s on s.id = c.supplier_id
    left join invoices i on i.id = c.invoice_id
    left join goods_receipt_items gi on gi.id = c.receipt_item_id
    left join goods_receipts g on g.id = gi.receipt_id
    where c.org_id <> s.org_id or (i.id is not null and c.org_id <> i.org_id)
       or (g.id is not null and c.org_id <> g.org_id)
    union all
    select 'payment_request_invoices', string_agg(concat_ws(':', l.payment_request_id, l.invoice_id), ', ' order by l.payment_request_id)
    from payment_request_invoices l join payment_requests pr on pr.id = l.payment_request_id
    join invoices i on i.id = l.invoice_id where pr.org_id <> i.org_id
    union all
    select 'payments', string_agg(p.id::text, ', ' order by p.id)
    from payments p join suppliers s on s.id = p.supplier_id
    left join payment_requests pr on pr.id = p.payment_request_id
    where p.org_id <> s.org_id or (pr.id is not null and p.org_id <> pr.org_id)
    union all
    select 'payment_allocations', string_agg(pa.id::text, ', ' order by pa.id)
    from payment_allocations pa join payments p on p.id = pa.payment_id
    left join invoices i on i.id = pa.invoice_id left join credit_requests c on c.id = pa.credit_id
    where pa.org_id <> p.org_id or pa.amount <= 0
       or (pa.invoice_id is null and pa.credit_id is null)
       or (pa.invoice_id is not null and pa.credit_id is not null)
       or (i.id is not null and (i.org_id <> pa.org_id or i.supplier_id <> p.supplier_id))
       or (c.id is not null and (c.org_id <> pa.org_id or c.supplier_id <> p.supplier_id))
    union all
    select 'bank_transactions', string_agg(t.id::text, ', ' order by t.id)
    from bank_transactions t join bank_imports i on i.id = t.import_id
    left join suppliers s on s.id = t.supplier_id
    where t.org_id <> i.org_id or (s.id is not null and t.org_id <> s.org_id)
    union all
    select 'bank_allocations', string_agg(ba.id::text, ', ' order by ba.id)
    from bank_allocations ba join bank_transactions t on t.id = ba.bank_transaction_id
    left join invoices i on i.id = ba.invoice_id left join payments p on p.id = ba.payment_id
    where ba.org_id <> t.org_id or ba.amount <= 0
       or (ba.invoice_id is null and ba.payment_id is null)
       or (i.id is not null and i.org_id <> ba.org_id)
       or (p.id is not null and p.org_id <> ba.org_id)
    union all
    select 'documents', string_agg(d.id::text, ', ' order by d.id)
    from documents d left join profiles u on u.id = d.uploaded_by
    left join profiles x on x.id = d.deleted_by left join suppliers s on s.id = d.supplier_id
    left join invoices i on d.entity_type = 'invoice' and i.id = d.entity_id
    left join goods_receipts g on d.entity_type = 'goods_receipt' and g.id = d.entity_id
    left join payments p on d.entity_type = 'payment' and p.id = d.entity_id
    where d.storage_path not like d.org_id::text || '/%'
       or (u.id is not null and u.org_id <> d.org_id) or (x.id is not null and x.org_id <> d.org_id)
       or (s.id is not null and s.org_id <> d.org_id)
       or (d.entity_type = 'invoice' and (i.id is null or i.org_id <> d.org_id))
       or (d.entity_type = 'goods_receipt' and (g.id is null or g.org_id <> d.org_id))
       or (d.entity_type = 'payment' and (p.id is null or p.org_id <> d.org_id))
    union all
    select 'tenant_actor_references', string_agg(id, ', ' order by id)
    from (
      select ph.id::text id from price_history ph join profiles p on p.id = ph.created_by where p.org_id <> ph.org_id
      union all select r.id::text from purchase_requests r join profiles p on p.id = r.created_by where p.org_id <> r.org_id
      union all select o.id::text from purchase_orders o join profiles p on p.id = o.created_by where p.org_id <> o.org_id
      union all select g.id::text from goods_receipts g join profiles p on p.id = g.received_by where p.org_id <> g.org_id
      union all select i.id::text from invoices i join profiles p on p.id = i.received_by where p.org_id <> i.org_id
      union all select c.id::text from credit_requests c join profiles p on p.id = c.created_by where p.org_id <> c.org_id
      union all select r.id::text from payment_requests r join profiles p on p.id in (r.created_by, r.approved_by) where p.org_id <> r.org_id
      union all select pmt.id::text from payments pmt join profiles p on p.id = pmt.executed_by where p.org_id <> pmt.org_id
      union all select b.id::text from bank_imports b join profiles p on p.id = b.imported_by where p.org_id <> b.org_id
      union all select b.id::text from bank_allocations b join profiles p on p.id = b.created_by where p.org_id <> b.org_id
      union all select e.id::text from exceptions e join profiles p on p.id = e.resolved_by where p.org_id <> e.org_id
      union all select c.id::text from comments c join profiles p on p.id = c.created_by where p.org_id <> c.org_id
      union all select m.id::text from monthly_exports m join profiles p on p.id = m.sent_by where p.org_id <> m.org_id
      union all select i.id::text from invitations i join profiles p on p.id in (i.accepted_by, i.revoked_by, i.invited_by) where p.org_id <> i.org_id
      union all select s.id::text from push_subscriptions s join profiles p on p.id = s.user_id where p.org_id <> s.org_id
      union all select n.id::text from notifications n join profiles p on p.id = n.user_id where p.org_id <> n.org_id
    ) actors
  ) anomalies
  where ids is not null
  limit 1;

  if v_relation is not null then
    raise exception 'P0 tenant-integrity anomaly in % (sample ids: %). No data was changed.', v_relation, v_ids;
  end if;
end
$$;

-- Junctions now carry their own enforceable tenant.
alter table supplier_categories add column org_id uuid references organizations(id);
alter table purchase_request_items add column org_id uuid references organizations(id);
alter table purchase_order_items add column org_id uuid references organizations(id);
alter table goods_receipt_items add column org_id uuid references organizations(id);
alter table invoice_order_links add column org_id uuid references organizations(id);
alter table invoice_receipt_links add column org_id uuid references organizations(id);
alter table payment_request_invoices add column org_id uuid references organizations(id);

alter table supplier_categories alter column org_id set default auth_org();
alter table purchase_request_items alter column org_id set default auth_org();
alter table purchase_order_items alter column org_id set default auth_org();
alter table goods_receipt_items alter column org_id set default auth_org();
alter table invoice_order_links alter column org_id set default auth_org();
alter table invoice_receipt_links alter column org_id set default auth_org();
alter table payment_request_invoices alter column org_id set default auth_org();

update supplier_categories x set org_id = s.org_id from suppliers s where s.id = x.supplier_id;
update purchase_request_items x set org_id = r.org_id from purchase_requests r where r.id = x.request_id;
update purchase_order_items x set org_id = o.org_id from purchase_orders o where o.id = x.order_id;
update goods_receipt_items x set org_id = r.org_id from goods_receipts r where r.id = x.receipt_id;
update invoice_order_links x set org_id = i.org_id from invoices i where i.id = x.invoice_id;
update invoice_receipt_links x set org_id = i.org_id from invoices i where i.id = x.invoice_id;
update payment_request_invoices x set org_id = r.org_id from payment_requests r where r.id = x.payment_request_id;

create index supplier_categories_org_idx on supplier_categories (org_id);
create index purchase_request_items_org_idx on purchase_request_items (org_id);
create index purchase_order_items_org_idx on purchase_order_items (org_id);
create index goods_receipt_items_org_idx on goods_receipt_items (org_id);
create index invoice_order_links_org_idx on invoice_order_links (org_id);
create index invoice_receipt_links_org_idx on invoice_receipt_links (org_id);
create index payment_request_invoices_org_idx on payment_request_invoices (org_id);

-- Composite parent keys. The UUID remains the public identity; org_id makes tenant equality
-- part of every relationship rather than a convention in caller code.
alter table profiles add constraint p0_profiles_org_id_id_key unique (org_id, id);
alter table categories add constraint p0_categories_org_id_id_key unique (org_id, id);
alter table suppliers add constraint p0_suppliers_org_id_id_key unique (org_id, id);
alter table products add constraint p0_products_org_id_id_key unique (org_id, id);
alter table supplier_products add constraint p0_supplier_products_org_id_id_key unique (org_id, id);
alter table purchase_requests add constraint p0_purchase_requests_org_id_id_key unique (org_id, id);
alter table purchase_orders add constraint p0_purchase_orders_org_id_id_key unique (org_id, id);
alter table purchase_order_items add constraint p0_purchase_order_items_org_id_id_key unique (org_id, id);
alter table goods_receipts add constraint p0_goods_receipts_org_id_id_key unique (org_id, id);
alter table goods_receipt_items add constraint p0_goods_receipt_items_org_id_id_key unique (org_id, id);
alter table invoices add constraint p0_invoices_org_id_id_key unique (org_id, id);
alter table credit_requests add constraint p0_credit_requests_org_id_id_key unique (org_id, id);
alter table payment_requests add constraint p0_payment_requests_org_id_id_key unique (org_id, id);
alter table payments add constraint p0_payments_org_id_id_key unique (org_id, id);
alter table bank_imports add constraint p0_bank_imports_org_id_id_key unique (org_id, id);
alter table bank_transactions add constraint p0_bank_transactions_org_id_id_key unique (org_id, id);

-- Business endpoints.
alter table profiles add constraint p0_profiles_supplier_tenant_fk foreign key (org_id, supplier_id) references suppliers(org_id, id) not valid;
alter table products add constraint p0_products_category_tenant_fk foreign key (org_id, category_id) references categories(org_id, id) not valid;
alter table supplier_products add constraint p0_sp_supplier_tenant_fk foreign key (org_id, supplier_id) references suppliers(org_id, id) on delete cascade not valid;
alter table supplier_products add constraint p0_sp_product_tenant_fk foreign key (org_id, product_id) references products(org_id, id) on delete cascade not valid;
alter table price_history add constraint p0_ph_sp_tenant_fk foreign key (org_id, supplier_product_id) references supplier_products(org_id, id) on delete cascade not valid;
alter table supplier_categories add constraint p0_sc_supplier_tenant_fk foreign key (org_id, supplier_id) references suppliers(org_id, id) on delete cascade not valid;
alter table supplier_categories add constraint p0_sc_category_tenant_fk foreign key (org_id, category_id) references categories(org_id, id) on delete cascade not valid;
alter table purchase_request_items add constraint p0_pri_request_tenant_fk foreign key (org_id, request_id) references purchase_requests(org_id, id) on delete cascade not valid;
alter table purchase_request_items add constraint p0_pri_product_tenant_fk foreign key (org_id, product_id) references products(org_id, id) not valid;
alter table purchase_request_items add constraint p0_pri_recommended_supplier_tenant_fk foreign key (org_id, recommended_supplier_id) references suppliers(org_id, id) not valid;
alter table purchase_request_items add constraint p0_pri_chosen_supplier_tenant_fk foreign key (org_id, chosen_supplier_id) references suppliers(org_id, id) not valid;
alter table purchase_orders add constraint p0_po_supplier_tenant_fk foreign key (org_id, supplier_id) references suppliers(org_id, id) not valid;
alter table purchase_orders add constraint p0_po_request_tenant_fk foreign key (org_id, request_id) references purchase_requests(org_id, id) not valid;
alter table purchase_order_items add constraint p0_poi_order_tenant_fk foreign key (org_id, order_id) references purchase_orders(org_id, id) on delete cascade not valid;
alter table purchase_order_items add constraint p0_poi_product_tenant_fk foreign key (org_id, product_id) references products(org_id, id) not valid;
alter table goods_receipts add constraint p0_gr_order_tenant_fk foreign key (org_id, order_id) references purchase_orders(org_id, id) not valid;
alter table goods_receipt_items add constraint p0_gri_receipt_tenant_fk foreign key (org_id, receipt_id) references goods_receipts(org_id, id) on delete cascade not valid;
alter table goods_receipt_items add constraint p0_gri_order_item_tenant_fk foreign key (org_id, order_item_id) references purchase_order_items(org_id, id) not valid;
alter table goods_receipt_items add constraint p0_gri_product_tenant_fk foreign key (org_id, product_id) references products(org_id, id) not valid;
alter table invoices add constraint p0_invoices_supplier_tenant_fk foreign key (org_id, supplier_id) references suppliers(org_id, id) not valid;
alter table invoice_order_links add constraint p0_iol_invoice_tenant_fk foreign key (org_id, invoice_id) references invoices(org_id, id) on delete cascade not valid;
alter table invoice_order_links add constraint p0_iol_order_tenant_fk foreign key (org_id, order_id) references purchase_orders(org_id, id) on delete cascade not valid;
alter table invoice_receipt_links add constraint p0_irl_invoice_tenant_fk foreign key (org_id, invoice_id) references invoices(org_id, id) on delete cascade not valid;
alter table invoice_receipt_links add constraint p0_irl_receipt_tenant_fk foreign key (org_id, receipt_id) references goods_receipts(org_id, id) on delete cascade not valid;
alter table credit_requests add constraint p0_credits_supplier_tenant_fk foreign key (org_id, supplier_id) references suppliers(org_id, id) not valid;
alter table credit_requests add constraint p0_credits_invoice_tenant_fk foreign key (org_id, invoice_id) references invoices(org_id, id) not valid;
alter table credit_requests add constraint p0_credits_receipt_item_tenant_fk foreign key (org_id, receipt_item_id) references goods_receipt_items(org_id, id) not valid;
alter table payment_requests add constraint p0_pr_supplier_tenant_fk foreign key (org_id, supplier_id) references suppliers(org_id, id) not valid;
alter table payment_request_invoices add constraint p0_pri2_request_tenant_fk foreign key (org_id, payment_request_id) references payment_requests(org_id, id) on delete cascade not valid;
alter table payment_request_invoices add constraint p0_pri2_invoice_tenant_fk foreign key (org_id, invoice_id) references invoices(org_id, id) not valid;
alter table payments add constraint p0_payments_supplier_tenant_fk foreign key (org_id, supplier_id) references suppliers(org_id, id) not valid;
alter table payments add constraint p0_payments_request_tenant_fk foreign key (org_id, payment_request_id) references payment_requests(org_id, id) not valid;
alter table payment_allocations add constraint p0_pa_payment_tenant_fk foreign key (org_id, payment_id) references payments(org_id, id) on delete restrict not valid;
alter table payment_allocations add constraint p0_pa_invoice_tenant_fk foreign key (org_id, invoice_id) references invoices(org_id, id) not valid;
alter table payment_allocations add constraint p0_pa_credit_tenant_fk foreign key (org_id, credit_id) references credit_requests(org_id, id) not valid;
alter table bank_transactions add constraint p0_bt_import_tenant_fk foreign key (org_id, import_id) references bank_imports(org_id, id) on delete cascade not valid;
alter table bank_transactions add constraint p0_bt_supplier_tenant_fk foreign key (org_id, supplier_id) references suppliers(org_id, id) not valid;
alter table bank_allocations add constraint p0_ba_transaction_tenant_fk foreign key (org_id, bank_transaction_id) references bank_transactions(org_id, id) on delete cascade not valid;
alter table bank_allocations add constraint p0_ba_invoice_tenant_fk foreign key (org_id, invoice_id) references invoices(org_id, id) not valid;
alter table bank_allocations add constraint p0_ba_payment_tenant_fk foreign key (org_id, payment_id) references payments(org_id, id) on delete restrict not valid;
alter table exceptions add constraint p0_ex_supplier_tenant_fk foreign key (org_id, supplier_id) references suppliers(org_id, id) not valid;
alter table exceptions add constraint p0_ex_invoice_tenant_fk foreign key (org_id, invoice_id) references invoices(org_id, id) not valid;
alter table exceptions add constraint p0_ex_payment_tenant_fk foreign key (org_id, payment_id) references payments(org_id, id) not valid;
alter table exceptions add constraint p0_ex_request_tenant_fk foreign key (org_id, payment_request_id) references payment_requests(org_id, id) not valid;
alter table exceptions add constraint p0_ex_bank_tx_tenant_fk foreign key (org_id, bank_transaction_id) references bank_transactions(org_id, id) not valid;
alter table documents add constraint p0_documents_supplier_tenant_fk foreign key (org_id, supplier_id) references suppliers(org_id, id) on delete restrict not valid;

-- Tenant-authored actor endpoints. Cross-tenant platform audit stays only in audit_logs.
alter table price_history add constraint p0_ph_actor_tenant_fk foreign key (org_id, created_by) references profiles(org_id, id) not valid;
alter table purchase_requests add constraint p0_purchase_requests_actor_tenant_fk foreign key (org_id, created_by) references profiles(org_id, id) not valid;
alter table purchase_orders add constraint p0_purchase_orders_actor_tenant_fk foreign key (org_id, created_by) references profiles(org_id, id) not valid;
alter table goods_receipts add constraint p0_goods_receipts_actor_tenant_fk foreign key (org_id, received_by) references profiles(org_id, id) not valid;
alter table invoices add constraint p0_invoices_actor_tenant_fk foreign key (org_id, received_by) references profiles(org_id, id) not valid;
alter table credit_requests add constraint p0_credits_actor_tenant_fk foreign key (org_id, created_by) references profiles(org_id, id) not valid;
alter table payment_requests add constraint p0_pr_created_actor_tenant_fk foreign key (org_id, created_by) references profiles(org_id, id) not valid;
alter table payment_requests add constraint p0_pr_approved_actor_tenant_fk foreign key (org_id, approved_by) references profiles(org_id, id) not valid;
alter table payments add constraint p0_payments_actor_tenant_fk foreign key (org_id, executed_by) references profiles(org_id, id) not valid;
alter table bank_imports add constraint p0_bank_imports_actor_tenant_fk foreign key (org_id, imported_by) references profiles(org_id, id) not valid;
alter table bank_allocations add constraint p0_bank_alloc_actor_tenant_fk foreign key (org_id, created_by) references profiles(org_id, id) not valid;
alter table exceptions add constraint p0_exceptions_actor_tenant_fk foreign key (org_id, resolved_by) references profiles(org_id, id) not valid;
alter table documents add constraint p0_documents_uploader_tenant_fk foreign key (org_id, uploaded_by) references profiles(org_id, id) not valid;
alter table documents add constraint p0_documents_deleter_tenant_fk foreign key (org_id, deleted_by) references profiles(org_id, id) not valid;
alter table comments add constraint p0_comments_actor_tenant_fk foreign key (org_id, created_by) references profiles(org_id, id) not valid;
alter table monthly_exports add constraint p0_exports_actor_tenant_fk foreign key (org_id, sent_by) references profiles(org_id, id) not valid;
alter table invitations add constraint p0_invites_accepted_tenant_fk foreign key (org_id, accepted_by) references profiles(org_id, id) not valid;
alter table invitations add constraint p0_invites_revoked_tenant_fk foreign key (org_id, revoked_by) references profiles(org_id, id) not valid;
alter table invitations add constraint p0_invites_inviter_tenant_fk foreign key (org_id, invited_by) references profiles(org_id, id) not valid;
alter table push_subscriptions add constraint p0_push_user_tenant_fk foreign key (org_id, user_id) references profiles(org_id, id) on delete cascade not valid;
alter table notifications add constraint p0_notifications_user_tenant_fk foreign key (org_id, user_id) references profiles(org_id, id) on delete cascade not valid;

-- Validation and NOT NULL are the contract boundary in 0022. Keeping expand separate lets old
-- compatible writers continue during a staged rollout while every relationship is observable.
