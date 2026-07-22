-- P0 security contract: validate tenant relationships, close implicit DELETE/audit paths,
-- bind document bytes to document rows and make every financial aggregate tenant-explicit.
-- The payer execution workflow and its three direct-write policies remain owned by P1.

-- ===== Contract the expand migration only after a second fail-closed check =====
do $$
declare
  v_relation text;
  v_count bigint;
  c record;
begin
  for c in
    select * from (values
      ('supplier_categories'),
      ('purchase_request_items'),
      ('purchase_order_items'),
      ('goods_receipt_items'),
      ('invoice_order_links'),
      ('invoice_receipt_links'),
      ('payment_request_invoices')
    ) as relations(name)
  loop
    execute format('select count(*) from %I where org_id is null', c.name) into v_count;
    if v_count > 0 then
      v_relation := c.name;
      exit;
    end if;
  end loop;

  if v_relation is not null then
    raise exception 'P0 tenant contract refused: %.org_id has % null row(s). No data was changed.',
      v_relation, v_count;
  end if;

  for c in
    select conrelid::regclass relation, conname
    from pg_constraint
    where conname like 'p0\_%\_tenant\_fk' escape '\'
  loop
    execute format('alter table %s validate constraint %I', c.relation, c.conname);
  end loop;
end
$$;

alter table supplier_categories alter column org_id set not null;
alter table purchase_request_items alter column org_id set not null;
alter table purchase_order_items alter column org_id set not null;
alter table goods_receipt_items alter column org_id set not null;
alter table invoice_order_links alter column org_id set not null;
alter table invoice_receipt_links alter column org_id set not null;
alter table payment_request_invoices alter column org_id set not null;

-- ===== Tenant identity is immutable for JWT writers =====
create or replace function guard_tenant_identity() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid := auth.uid();
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
begin
  if v_actor is null then return new; end if;

  if (v_old ? 'id' and v_new -> 'id' is distinct from v_old -> 'id')
     or v_new -> 'org_id' is distinct from v_old -> 'org_id'
     or (v_old ? 'created_at' and v_new -> 'created_at' is distinct from v_old -> 'created_at') then
    raise exception '%_tenant_identity_immutable', tg_table_name using errcode = '42501';
  end if;

  return new;
end
$$;

revoke all on function guard_tenant_identity() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array[
    'categories','suppliers','supplier_categories','products','supplier_products','price_history',
    'purchase_requests','purchase_request_items','purchase_orders','purchase_order_items',
    'goods_receipts','goods_receipt_items','invoices','invoice_order_links','invoice_receipt_links',
    'credit_requests','payment_requests','payment_request_invoices','payments','payment_allocations',
    'bank_imports','bank_transactions','bank_allocations','exceptions','comments','monthly_exports',
    'invitations','push_subscriptions','notifications'
  ]
  loop
    execute format('drop trigger if exists p0_tenant_identity_guard on %I', t);
    execute format(
      'create trigger p0_tenant_identity_guard before update on %I for each row execute function guard_tenant_identity()',
      t
    );
  end loop;
end
$$;

-- ===== Explicit RLS actions; no financial DELETE hidden inside FOR ALL =====

-- Catalog records with lifecycle columns use UPDATE rather than hard deletion.
drop policy if exists suppliers_select on suppliers;
drop policy if exists suppliers_write on suppliers;
create policy suppliers_select on suppliers for select to authenticated using (
  org_id = auth_org() and (
    auth_role() in ('owner','office','kitchen','accountant')
    or (auth_role() = 'payer' and exists (
      select 1 from payment_requests pr
      where pr.org_id = suppliers.org_id and pr.supplier_id = suppliers.id
        and pr.status in ('approved','sent_for_execution','executed','matched')
    ))
    or (auth_role() = 'supplier' and id = auth_supplier())
  )
);
create policy suppliers_insert on suppliers for insert to authenticated
  with check (org_id = auth_org() and auth_role() in ('owner','office'));
create policy suppliers_update on suppliers for update to authenticated
  using (org_id = auth_org() and auth_role() in ('owner','office'))
  with check (org_id = auth_org() and auth_role() in ('owner','office'));

drop policy if exists supplier_categories_select on supplier_categories;
drop policy if exists supplier_categories_write on supplier_categories;
create policy supplier_categories_select on supplier_categories for select to authenticated
  using (org_id = auth_org() and auth_role() in ('owner','office','kitchen','accountant'));
create policy supplier_categories_insert on supplier_categories for insert to authenticated
  with check (org_id = auth_org() and auth_role() in ('owner','office'));
create policy supplier_categories_update on supplier_categories for update to authenticated
  using (org_id = auth_org() and auth_role() in ('owner','office'))
  with check (org_id = auth_org() and auth_role() in ('owner','office'));
create policy supplier_categories_delete on supplier_categories for delete to authenticated
  using (org_id = auth_org() and auth_role() in ('owner','office'));

drop policy if exists products_write on products;
create policy products_insert on products for insert to authenticated
  with check (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));
create policy products_update on products for update to authenticated
  using (org_id = auth_org() and auth_role() in ('owner','office','kitchen'))
  with check (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));

drop policy if exists supplier_products_write on supplier_products;
create policy supplier_products_insert on supplier_products for insert to authenticated
  with check (org_id = auth_org() and auth_role() in ('owner','office'));
create policy supplier_products_update on supplier_products for update to authenticated
  using (org_id = auth_org() and auth_role() in ('owner','office'))
  with check (org_id = auth_org() and auth_role() in ('owner','office'));

-- Personal drafts are visible only to their creator, even inside the same organization.
drop policy if exists purchase_requests_select on purchase_requests;
drop policy if exists purchase_requests_write on purchase_requests;
create policy purchase_requests_select on purchase_requests for select to authenticated using (
  org_id = auth_org()
  and auth_role() in ('owner','office','kitchen','accountant')
  and (status <> 'draft' or created_by = auth.uid())
);
create policy purchase_requests_insert on purchase_requests for insert to authenticated
  with check (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));
create policy purchase_requests_update on purchase_requests for update to authenticated
  using (org_id = auth_org() and auth_role() in ('owner','office','kitchen'))
  with check (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));

drop policy if exists pri_select on purchase_request_items;
drop policy if exists pri_write on purchase_request_items;
create policy pri_select on purchase_request_items for select to authenticated using (
  org_id = auth_org()
  and auth_role() in ('owner','office','kitchen','accountant')
  and exists (
    select 1 from purchase_requests r
    where r.org_id = purchase_request_items.org_id
      and r.id = purchase_request_items.request_id
      and (r.status <> 'draft' or r.created_by = auth.uid())
  )
);
create policy pri_insert on purchase_request_items for insert to authenticated
  with check (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));
create policy pri_update on purchase_request_items for update to authenticated
  using (org_id = auth_org() and auth_role() in ('owner','office','kitchen'))
  with check (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));
create policy pri_delete_draft on purchase_request_items for delete to authenticated using (
  org_id = auth_org() and auth_role() in ('owner','office','kitchen')
  and exists (
    select 1 from purchase_requests r
    where r.org_id = purchase_request_items.org_id
      and r.id = purchase_request_items.request_id
      and r.status = 'draft' and r.created_by = auth.uid()
  )
);

drop policy if exists purchase_orders_write on purchase_orders;
create policy purchase_orders_insert on purchase_orders for insert to authenticated
  with check (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));
create policy purchase_orders_update on purchase_orders for update to authenticated
  using (org_id = auth_org() and auth_role() in ('owner','office','kitchen'))
  with check (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));

drop policy if exists poi_select on purchase_order_items;
drop policy if exists poi_write on purchase_order_items;
create policy poi_select on purchase_order_items for select to authenticated
  using (org_id = auth_org() and auth_role() in ('owner','office','kitchen','accountant'));
create policy poi_insert on purchase_order_items for insert to authenticated
  with check (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));
create policy poi_update on purchase_order_items for update to authenticated
  using (org_id = auth_org() and auth_role() in ('owner','office','kitchen'))
  with check (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));

drop policy if exists goods_receipts_write on goods_receipts;
create policy goods_receipts_insert on goods_receipts for insert to authenticated
  with check (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));
create policy goods_receipts_update on goods_receipts for update to authenticated
  using (org_id = auth_org() and auth_role() in ('owner','office','kitchen'))
  with check (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));

drop policy if exists gri_select on goods_receipt_items;
drop policy if exists gri_write on goods_receipt_items;
create policy gri_select on goods_receipt_items for select to authenticated
  using (org_id = auth_org() and auth_role() in ('owner','office','kitchen','accountant'));
create policy gri_insert on goods_receipt_items for insert to authenticated
  with check (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));
create policy gri_update on goods_receipt_items for update to authenticated
  using (org_id = auth_org() and auth_role() in ('owner','office','kitchen'))
  with check (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));
create policy gri_delete_draft on goods_receipt_items for delete to authenticated using (
  org_id = auth_org() and auth_role() in ('owner','office','kitchen')
  and exists (
    select 1 from goods_receipts g
    where g.org_id = goods_receipt_items.org_id
      and g.id = goods_receipt_items.receipt_id and g.status = 'draft'
  )
);

drop policy if exists invoices_select on invoices;
drop policy if exists invoices_insert on invoices;
drop policy if exists invoices_update on invoices;
create policy invoices_select on invoices for select to authenticated using (
  org_id = auth_org() and (
    auth_role() in ('owner','office','kitchen','accountant')
    or (auth_role() = 'payer' and exists (
      select 1
      from payment_request_invoices pri
      join payment_requests pr
        on pr.org_id = pri.org_id and pr.id = pri.payment_request_id
      where pri.org_id = invoices.org_id and pri.invoice_id = invoices.id
        and pr.status in ('approved','sent_for_execution','executed','matched')
    ))
  )
);
create policy invoices_insert on invoices for insert to authenticated
  with check (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));
create policy invoices_update on invoices for update to authenticated
  using (org_id = auth_org() and auth_role() in ('owner','office','kitchen'))
  with check (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));

drop policy if exists iol_select on invoice_order_links;
drop policy if exists iol_write on invoice_order_links;
create policy iol_select on invoice_order_links for select to authenticated
  using (org_id = auth_org() and auth_role() in ('owner','office','kitchen','accountant'));
create policy iol_insert on invoice_order_links for insert to authenticated
  with check (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));
create policy iol_update on invoice_order_links for update to authenticated
  using (org_id = auth_org() and auth_role() in ('owner','office','kitchen'))
  with check (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));

drop policy if exists irl_select on invoice_receipt_links;
drop policy if exists irl_write on invoice_receipt_links;
create policy irl_select on invoice_receipt_links for select to authenticated
  using (org_id = auth_org() and auth_role() in ('owner','office','kitchen','accountant'));
create policy irl_insert on invoice_receipt_links for insert to authenticated
  with check (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));
create policy irl_update on invoice_receipt_links for update to authenticated
  using (org_id = auth_org() and auth_role() in ('owner','office','kitchen'))
  with check (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));

drop policy if exists credit_requests_write on credit_requests;
create policy credit_requests_insert on credit_requests for insert to authenticated
  with check (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));
create policy credit_requests_update on credit_requests for update to authenticated
  using (org_id = auth_org() and auth_role() in ('owner','office','kitchen'))
  with check (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));

-- P1-owned policies payment_requests_payer_update, payments_payer_insert and pa_payer_insert
-- are intentionally not changed here.
drop policy if exists payment_requests_write on payment_requests;
create policy payment_requests_insert on payment_requests for insert to authenticated
  with check (org_id = auth_org() and auth_role() in ('owner','office'));
create policy payment_requests_update on payment_requests for update to authenticated
  using (org_id = auth_org() and auth_role() in ('owner','office'))
  with check (org_id = auth_org() and auth_role() in ('owner','office'));

drop policy if exists pri2_select on payment_request_invoices;
drop policy if exists pri2_write on payment_request_invoices;
create policy pri2_select on payment_request_invoices for select to authenticated using (
  org_id = auth_org() and exists (
    select 1 from payment_requests pr
    where pr.org_id = payment_request_invoices.org_id
      and pr.id = payment_request_invoices.payment_request_id
      and (
        auth_role() in ('owner','office','accountant')
        or (auth_role() = 'payer' and pr.status in ('approved','sent_for_execution','executed','matched'))
      )
  )
);
create policy pri2_insert on payment_request_invoices for insert to authenticated
  with check (org_id = auth_org() and auth_role() in ('owner','office'));
create policy pri2_update on payment_request_invoices for update to authenticated
  using (org_id = auth_org() and auth_role() in ('owner','office'))
  with check (org_id = auth_org() and auth_role() in ('owner','office'));

drop policy if exists payments_write on payments;
create policy payments_insert on payments for insert to authenticated
  with check (org_id = auth_org() and auth_role() in ('owner','office'));
create policy payments_update on payments for update to authenticated
  using (org_id = auth_org() and auth_role() in ('owner','office'))
  with check (org_id = auth_org() and auth_role() in ('owner','office'));

drop policy if exists pa_select on payment_allocations;
drop policy if exists pa_write on payment_allocations;
create policy pa_select on payment_allocations for select to authenticated
  using (org_id = auth_org() and auth_role() in ('owner','office','accountant'));
create policy pa_insert on payment_allocations for insert to authenticated
  with check (org_id = auth_org() and auth_role() in ('owner','office'));
create policy pa_update on payment_allocations for update to authenticated
  using (org_id = auth_org() and auth_role() in ('owner','office'))
  with check (org_id = auth_org() and auth_role() in ('owner','office'));

drop policy if exists bank_imports_write on bank_imports;
create policy bank_imports_insert on bank_imports for insert to authenticated
  with check (org_id = auth_org() and auth_role() in ('owner','office'));
create policy bank_imports_update on bank_imports for update to authenticated
  using (org_id = auth_org() and auth_role() in ('owner','office'))
  with check (org_id = auth_org() and auth_role() in ('owner','office'));

drop policy if exists bank_tx_write on bank_transactions;
create policy bank_tx_insert on bank_transactions for insert to authenticated
  with check (org_id = auth_org() and auth_role() in ('owner','office'));
create policy bank_tx_update on bank_transactions for update to authenticated
  using (org_id = auth_org() and auth_role() in ('owner','office'))
  with check (org_id = auth_org() and auth_role() in ('owner','office'));

drop policy if exists bank_alloc_select on bank_allocations;
drop policy if exists bank_alloc_write on bank_allocations;
create policy bank_alloc_select on bank_allocations for select to authenticated
  using (org_id = auth_org() and auth_role() in ('owner','office','accountant'));
create policy bank_alloc_insert on bank_allocations for insert to authenticated
  with check (org_id = auth_org() and auth_role() in ('owner','office'));
create policy bank_alloc_update on bank_allocations for update to authenticated
  using (org_id = auth_org() and auth_role() in ('owner','office'))
  with check (org_id = auth_org() and auth_role() in ('owner','office'));

drop policy if exists exceptions_write on exceptions;
create policy exceptions_insert on exceptions for insert to authenticated
  with check (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));
create policy exceptions_update on exceptions for update to authenticated
  using (org_id = auth_org() and auth_role() in ('owner','office','kitchen'))
  with check (org_id = auth_org() and auth_role() in ('owner','office','kitchen'));

drop policy if exists monthly_exports_write on monthly_exports;
create policy monthly_exports_insert on monthly_exports for insert to authenticated
  with check (org_id = auth_org() and auth_role() in ('owner','office'));
create policy monthly_exports_update on monthly_exports for update to authenticated
  using (org_id = auth_org() and auth_role() in ('owner','office'))
  with check (org_id = auth_org() and auth_role() in ('owner','office'));

revoke delete on suppliers, products, supplier_products, price_history,
  purchase_requests, purchase_orders, purchase_order_items, goods_receipts,
  invoices, invoice_order_links, invoice_receipt_links, credit_requests,
  payment_requests, payment_request_invoices, payments, payment_allocations,
  bank_imports, bank_transactions, bank_allocations, exceptions, documents,
  monthly_exports
from public, anon, authenticated;

-- ===== Audit is server-authored on every independent sensitive row =====
do $$
declare t text;
begin
  foreach t in array array[
    'price_history','purchase_requests','purchase_request_items','purchase_order_items',
    'goods_receipt_items','invoice_order_links','invoice_receipt_links',
    'payment_request_invoices','bank_imports','bank_transactions','exceptions',
    'documents','monthly_exports'
  ]
  loop
    execute format('drop trigger if exists %I_audit on %I', t, t);
    execute format(
      'create trigger %I_audit after insert or update or delete on %I for each row execute function audit_row_change()',
      t, t
    );
  end loop;
end
$$;

-- These existing reasoned commands must retain the right to write their own atomic audit row.
alter function public.file_document(uuid, text, uuid, text) security definer;
alter function public.file_document(uuid, text, uuid, text) set search_path = public;
alter function public.cancel_purchase_request_draft(uuid, text) security definer;
alter function public.cancel_purchase_request_draft(uuid, text) set search_path = public;

-- ===== Tenant-explicit financial reads =====
drop view supplier_balances;
drop view invoice_balances;

create or replace function p0_invoice_balance_rows()
returns table (
  invoice_id uuid,
  total_amount numeric(12,2),
  paid_amount numeric(12,2),
  credited_amount numeric(12,2),
  balance numeric(12,2)
)
language sql stable security definer set search_path = public as $$
  with paid as (
    select pa.org_id, pa.invoice_id, sum(pa.amount) as amount
    from payment_allocations pa
    where pa.org_id = auth_org() and pa.invoice_id is not null
    group by pa.org_id, pa.invoice_id
  ), credited as (
    select cr.org_id, cr.invoice_id, sum(cr.amount) as amount
    from credit_requests cr
    where cr.org_id = auth_org() and cr.invoice_id is not null
      and cr.status in ('offset','closed')
    group by cr.org_id, cr.invoice_id
  )
  select i.id,
         i.total_amount,
         coalesce(p.amount, 0)::numeric(12,2),
         coalesce(c.amount, 0)::numeric(12,2),
         (i.total_amount - coalesce(p.amount, 0) - coalesce(c.amount, 0))::numeric(12,2)
  from invoices i
  left join paid p on p.org_id = i.org_id and p.invoice_id = i.id
  left join credited c on c.org_id = i.org_id and c.invoice_id = i.id
  where i.org_id = auth_org() and i.deleted_at is null
    and (
      auth_role() in ('owner','office','kitchen','accountant')
      or (auth_role() = 'payer' and exists (
        select 1
        from payment_request_invoices pri
        join payment_requests pr
          on pr.org_id = pri.org_id and pr.id = pri.payment_request_id
        where pri.org_id = i.org_id and pri.invoice_id = i.id
          and pr.status in ('approved','sent_for_execution','executed','matched')
      ))
    )
$$;

create or replace function p0_supplier_balance_rows()
returns table (supplier_id uuid, open_balance numeric(12,2), open_invoices bigint)
language sql stable security definer set search_path = public as $$
  with balances as (
    select * from p0_invoice_balance_rows()
  )
  select s.id,
         coalesce(sum(b.balance), 0)::numeric(12,2),
         count(b.invoice_id) filter (where b.balance > 0)
  from suppliers s
  left join invoices i
    on i.org_id = s.org_id and i.supplier_id = s.id and i.deleted_at is null
  left join balances b on b.invoice_id = i.id
  where s.org_id = auth_org() and auth_role() in ('owner','office','kitchen','accountant')
  group by s.id
$$;

revoke all on function p0_invoice_balance_rows() from public, anon;
revoke all on function p0_supplier_balance_rows() from public, anon;
grant execute on function p0_invoice_balance_rows() to authenticated;
grant execute on function p0_supplier_balance_rows() to authenticated;

create view invoice_balances with (security_invoker = on, security_barrier = on) as
select * from p0_invoice_balance_rows();

create view supplier_balances with (security_invoker = on, security_barrier = on) as
select * from p0_supplier_balance_rows();

revoke all on invoice_balances, supplier_balances from public, anon;
grant select on invoice_balances, supplier_balances to authenticated;

create or replace function refresh_invoice_payment_status(inv_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := auth_org();
  v_total numeric;
  v_paid numeric;
  v_credited numeric;
  v_status invoice_payment_status;
begin
  if v_org is null then return; end if;

  select i.total_amount into v_total
  from invoices i where i.org_id = v_org and i.id = inv_id;
  if v_total is null then return; end if;

  select coalesce(sum(pa.amount), 0) into v_paid
  from payment_allocations pa
  where pa.org_id = v_org and pa.invoice_id = inv_id;

  select coalesce(sum(cr.amount), 0) into v_credited
  from credit_requests cr
  where cr.org_id = v_org and cr.invoice_id = inv_id and cr.status in ('offset', 'closed');

  v_status := case
    when v_total - v_paid - v_credited <= 1 then 'paid'
    when v_paid > 0 then 'partial'
    else 'unpaid'
  end;

  update invoices set payment_status = v_status where org_id = v_org and id = inv_id;
end
$$;

revoke all on function refresh_invoice_payment_status(uuid) from public, anon;
grant execute on function refresh_invoice_payment_status(uuid) to authenticated;

drop view supplier_metrics;
create view supplier_metrics with (security_invoker = on, security_barrier = on) as
with cfg as (
  select (now() - interval '180 days') as since
), deliveries as (
  select po.org_id, po.supplier_id, po.expected_date, po.sent_at,
         (select min(g.received_at)
          from goods_receipts g
          where g.org_id = po.org_id and g.order_id = po.id and g.status = 'completed') as received_at
  from purchase_orders po
  where po.org_id = auth_org() and po.status in ('received', 'partial')
), d as (
  select v.org_id, v.supplier_id,
    count(*) filter (where v.expected_date is not null) as otd_samples,
    count(*) filter (
      where v.expected_date is not null
        and (v.received_at at time zone 'Asia/Jerusalem')::date <= v.expected_date
    ) as otd_on_time,
    count(*) filter (where v.sent_at is not null) as lead_samples,
    avg((v.received_at at time zone 'Asia/Jerusalem')::date
      - (v.sent_at at time zone 'Asia/Jerusalem')::date)
      filter (where v.sent_at is not null) as avg_lead_days
  from deliveries v, cfg
  where v.received_at is not null and v.received_at >= cfg.since
  group by v.org_id, v.supplier_id
), x as (
  select e.org_id, e.supplier_id,
    count(*) filter (where e.status in ('open','in_progress')) as open_exceptions,
    count(*) filter (where e.created_at >= (select since from cfg)) as exceptions_window,
    count(*) as exceptions_lifetime
  from exceptions e
  where e.org_id = auth_org() and e.supplier_id is not null
  group by e.org_id, e.supplier_id
), c as (
  select cr.org_id, cr.supplier_id,
    count(*) filter (where cr.status in ('open','requested','received')) as open_credits,
    coalesce(sum(cr.amount) filter (where cr.status in ('open','requested','received')), 0)
      as open_credits_amount,
    count(*) filter (where cr.created_at >= (select since from cfg)) as credits_window,
    count(*) as credits_lifetime
  from credit_requests cr
  where cr.org_id = auth_org()
  group by cr.org_id, cr.supplier_id
), p as (
  select sp.org_id, sp.supplier_id,
         count(distinct sp.id) as priced_items,
         count(h.id) as price_changes_window,
         max(h.effective_date) as last_price_change
  from supplier_products sp
  left join price_history h
    on h.org_id = sp.org_id and h.supplier_product_id = sp.id
   and h.effective_date >= (select since::date from cfg)
  where sp.org_id = auth_org()
  group by sp.org_id, sp.supplier_id
)
select s.id as supplier_id,
  coalesce(d.otd_samples, 0) as otd_samples,
  coalesce(d.otd_on_time, 0) as otd_on_time,
  case when coalesce(d.otd_samples, 0) = 0 then null
       else round(d.otd_on_time::numeric * 100 / d.otd_samples, 0) end as on_time_pct,
  coalesce(d.lead_samples, 0) as lead_samples,
  round(d.avg_lead_days::numeric, 1) as avg_lead_days,
  coalesce(x.open_exceptions, 0) as open_exceptions,
  coalesce(x.exceptions_window, 0) as exceptions_window,
  coalesce(x.exceptions_lifetime, 0) as exceptions_lifetime,
  coalesce(c.open_credits, 0) as open_credits,
  coalesce(c.open_credits_amount, 0)::numeric(12,2) as open_credits_amount,
  coalesce(c.credits_window, 0) as credits_window,
  coalesce(c.credits_lifetime, 0) as credits_lifetime,
  coalesce(p.priced_items, 0) as priced_items,
  coalesce(p.price_changes_window, 0) as price_changes_window,
  p.last_price_change
from suppliers s
left join d on d.org_id = s.org_id and d.supplier_id = s.id
left join x on x.org_id = s.org_id and x.supplier_id = s.id
left join c on c.org_id = s.org_id and c.supplier_id = s.id
left join p on p.org_id = s.org_id and p.supplier_id = s.id
where s.org_id = auth_org() and s.deleted_at is null
  and auth_role() in ('owner','office','kitchen','accountant');

revoke all on supplier_metrics from public, anon;
grant select on supplier_metrics to authenticated;

-- ===== Documents and Storage share one row-backed authorization contract =====
do $$
declare
  v_ids text;
begin
  select string_agg(id::text, ', ' order by id) into v_ids
  from (
    select id from documents
    where mime_type is not null
      and lower(mime_type) not in (
        'application/pdf','image/jpeg','image/png','image/webp','image/heic','image/heif',
        'image/gif','image/avif'
      )
    order by id limit 25
  ) unsafe;
  if v_ids is not null then
    raise exception 'P0 document MIME contract refused (sample ids: %). No data was changed.', v_ids;
  end if;
end
$$;

alter table documents add constraint p0_documents_storage_path_org_check
  check (storage_path like org_id::text || '/%') not valid;
alter table documents validate constraint p0_documents_storage_path_org_check;

alter table documents add constraint p0_documents_mime_check check (
  mime_type is null or lower(mime_type) in (
    'application/pdf','image/jpeg','image/png','image/webp','image/heic','image/heif',
    'image/gif','image/avif'
  )
) not valid;
alter table documents validate constraint p0_documents_mime_check;

create or replace function p0_document_object_owned(p_path text, p_mime text)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from storage.objects o
    where o.bucket_id = 'documents' and o.name = p_path
      and (o.owner = auth.uid() or o.owner_id = auth.uid()::text)
      and lower(coalesce(o.metadata ->> 'mimetype', '')) = lower(p_mime)
      and lower(p_mime) in (
        'application/pdf','image/jpeg','image/png','image/webp','image/heic','image/heif',
        'image/gif','image/avif'
      )
  )
$$;

create or replace function p0_document_path_registered(p_path text)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from documents d where d.storage_path = p_path)
$$;

revoke all on function p0_document_object_owned(text, text) from public, anon;
revoke all on function p0_document_path_registered(text) from public, anon;
grant execute on function p0_document_object_owned(text, text) to authenticated;
grant execute on function p0_document_path_registered(text) to authenticated;

drop policy if exists documents_select on documents;
drop policy if exists documents_insert on documents;
drop policy if exists documents_soft_delete on documents;
create policy documents_select on documents for select to authenticated using (
  org_id = auth_org() and (
    auth_role() in ('owner','office','kitchen','accountant')
    or (auth_role() = 'payer' and uploaded_by = auth.uid())
  )
);
create policy documents_insert on documents for insert to authenticated with check (
  org_id = auth_org()
  and uploaded_by = auth.uid()
  and storage_path like auth_org()::text || '/%'
  and entity_type in ('inbox','invoice','goods_receipt','payment')
  and mime_type is not null
  and p0_document_object_owned(storage_path, mime_type)
  and (
    auth_role() in ('owner','office','kitchen')
    or (
      auth_role() = 'payer' and entity_type = 'payment'
      and exists (
        select 1 from payments p
        where p.org_id = documents.org_id and p.id = documents.entity_id
          and p.executed_by = auth.uid()
      )
    )
  )
);
create policy documents_soft_delete on documents for update to authenticated
  using (org_id = auth_org() and auth_role() in ('owner','office'))
  with check (
    org_id = auth_org() and auth_role() in ('owner','office')
    and (deleted_at is null or deleted_by = auth.uid())
  );

update storage.buckets
set public = false,
    allowed_mime_types = array[
      'application/pdf','image/jpeg','image/png','image/webp','image/heic','image/heif',
      'image/gif','image/avif'
    ]::text[]
where id = 'documents';

drop policy if exists docs_storage_read on storage.objects;
drop policy if exists docs_storage_insert on storage.objects;
drop policy if exists docs_storage_delete on storage.objects;

create policy docs_storage_read on storage.objects for select to authenticated using (
  bucket_id = 'documents'
  and exists (
    select 1 from documents d
    where d.storage_path = storage.objects.name and d.org_id = auth_org()
      and (
        auth_role() in ('owner','office','kitchen','accountant')
        or (auth_role() = 'payer' and d.uploaded_by = auth.uid())
      )
  )
);

create policy docs_storage_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'documents'
  and (storage.foldername(name))[1] = auth_org()::text
  and (owner = auth.uid() or owner_id = auth.uid()::text)
  and lower(coalesce(metadata ->> 'mimetype', '')) in (
    'application/pdf','image/jpeg','image/png','image/webp','image/heic','image/heif',
    'image/gif','image/avif'
  )
  and auth_role() in ('owner','office','kitchen','payer')
);

create policy docs_storage_delete on storage.objects for delete to authenticated using (
  bucket_id = 'documents'
  and (storage.foldername(name))[1] = auth_org()::text
  and (owner = auth.uid() or owner_id = auth.uid()::text)
  and auth_role() in ('owner','office','kitchen','payer')
  and not p0_document_path_registered(name)
);

-- RLS is not applied to TRUNCATE. PostgREST does not expose it as a row operation, but the
-- browser database roles do not need this latent destructive privilege. Keep this after all
-- view recreation because Supabase's DDL grant hook applies default table privileges to them.
revoke truncate on all tables in schema public from public, anon, authenticated;

-- Final ACL assertions: browser audit fabrication and hard financial deletion stay closed.
do $$
declare v_bad text;
begin
  select string_agg(table_name, ', ' order by table_name) into v_bad
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee in ('anon','authenticated','PUBLIC')
    and privilege_type = 'DELETE'
    and table_name in (
      'suppliers','products','supplier_products','price_history','purchase_requests',
      'purchase_orders','purchase_order_items','goods_receipts','invoices',
      'invoice_order_links','invoice_receipt_links','credit_requests','payment_requests',
      'payment_request_invoices','payments','payment_allocations','bank_imports',
      'bank_transactions','bank_allocations','exceptions','documents','monthly_exports'
    );
  if v_bad is not null then
    raise exception 'P0 DELETE grant remains on: %', v_bad;
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and grantee in ('anon','authenticated','PUBLIC') and privilege_type = 'TRUNCATE'
  ) then
    raise exception 'P0 TRUNCATE grant remains available to a browser role';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'audit_logs'
      and grantee in ('anon','authenticated','PUBLIC') and privilege_type = 'INSERT'
  ) then
    raise exception 'P0 audit INSERT grant remains available to a browser role';
  end if;
end
$$;
