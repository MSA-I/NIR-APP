-- P1 read-only anomaly report. Returns counts and technical identifiers only.
-- Any non-zero row blocks the corresponding constraint; never repair financial history here.

with
duplicate_payment_executions as (
  select (array_agg(id order by id))[1] as id
  from payments
  where payment_request_id is not null
  group by org_id, payment_request_id
  having count(*) > 1
),
invalid_payment_allocations as (
  select pa.id
  from payment_allocations pa
  join payments p on p.id = pa.payment_id
  left join invoices i on i.id = pa.invoice_id
  left join credit_requests c on c.id = pa.credit_id
  where pa.amount <= 0
     or num_nonnulls(pa.invoice_id, pa.credit_id) <> 1
     or pa.org_id <> p.org_id
     or (i.id is not null and (i.org_id <> p.org_id or i.supplier_id <> p.supplier_id))
     or (c.id is not null and (c.org_id <> p.org_id or c.supplier_id <> p.supplier_id))
),
overallocated_payments as (
  select p.id
  from payments p
  join payment_allocations pa on pa.payment_id = p.id
  group by p.id, p.amount
  having round(sum(pa.amount), 2) > round(p.amount, 2)
),
invalid_bank_allocations as (
  select ba.id
  from bank_allocations ba
  join bank_transactions bt on bt.id = ba.bank_transaction_id
  left join invoices i on i.id = ba.invoice_id
  left join payments p on p.id = ba.payment_id
  where ba.amount <= 0
     or num_nonnulls(ba.invoice_id, ba.payment_id) <> 1
     or ba.org_id <> bt.org_id
     or (ba.confidence is not null and (ba.confidence < 0 or ba.confidence > 1))
     or (i.id is not null and (i.org_id <> bt.org_id or (bt.supplier_id is not null and i.supplier_id <> bt.supplier_id)))
     or (p.id is not null and (p.org_id <> bt.org_id or (bt.supplier_id is not null and p.supplier_id <> bt.supplier_id)))
),
bank_allocations_bad_amount as (
  select id from bank_allocations where amount <= 0
),
bank_allocations_bad_target_count as (
  select id from bank_allocations where num_nonnulls(invoice_id, payment_id) <> 1
),
bank_allocations_bad_confidence as (
  select id from bank_allocations where confidence is not null and (confidence < 0 or confidence > 1)
),
bank_allocations_cross_tenant as (
  select ba.id
  from bank_allocations ba
  join bank_transactions bt on bt.id = ba.bank_transaction_id
  left join invoices i on i.id = ba.invoice_id
  left join payments p on p.id = ba.payment_id
  where ba.org_id <> bt.org_id
     or (i.id is not null and i.org_id <> bt.org_id)
     or (p.id is not null and p.org_id <> bt.org_id)
),
bank_allocations_supplier_mismatch as (
  select ba.id
  from bank_allocations ba
  join bank_transactions bt on bt.id = ba.bank_transaction_id
  left join invoices i on i.id = ba.invoice_id
  left join payments p on p.id = ba.payment_id
  where bt.supplier_id is not null
    and ((i.id is not null and i.supplier_id <> bt.supplier_id)
      or (p.id is not null and p.supplier_id <> bt.supplier_id))
),
overallocated_bank_transactions as (
  select bt.id
  from bank_transactions bt
  join bank_allocations ba on ba.bank_transaction_id = bt.id
  group by bt.id, bt.amount
  having round(sum(ba.amount), 2) > round(bt.amount + 1, 2)
),
duplicate_bank_rows as (
  select (array_agg(id order by id))[1] as id
  from bank_transactions
  group by org_id, row_hash
  having count(*) > 1
),
duplicate_receipt_lines as (
  select (array_agg(id order by id))[1] as id
  from goods_receipt_items
  group by receipt_id, order_item_id
  having count(*) > 1
),
invalid_receipt_quantities as (
  select id from goods_receipt_items where qty_received < 0
),
overreceived_order_items as (
  select poi.id
  from purchase_order_items poi
  left join goods_receipt_items gri on gri.order_item_id = poi.id
  left join goods_receipts gr on gr.id = gri.receipt_id and gr.status = 'completed'
  group by poi.id, poi.qty, poi.received_qty
  having poi.received_qty > poi.qty
     or coalesce(sum(gri.qty_received) filter (
          where gr.id is not null and gri.status in ('full', 'partial')
        ), 0) > poi.qty
),
prices_without_history as (
  select sp.id
  from supplier_products sp
  where not exists (
    select 1
    from price_history ph
    where ph.supplier_product_id = sp.id
      and ph.org_id = sp.org_id
      and ph.price = sp.current_price
      and ph.effective_date = sp.price_effective_date
  )
),
cross_tenant_price_history as (
  select ph.id
  from price_history ph
  join supplier_products sp on sp.id = ph.supplier_product_id
  where ph.org_id <> sp.org_id
),
invalid_supplier_prices as (
  select id from supplier_products where current_price <= 0 or current_price > 1000000
),
duplicate_month_exports as (
  select (array_agg(id order by id))[1] as id
  from monthly_exports
  group by org_id, month
  having count(*) > 1
),
noncanonical_month_exports as (
  select id
  from monthly_exports
  where month <> date_trunc('month', month)::date
),
legacy_sent_exports as (
  select id from monthly_exports where status = 'sent'
),
-- ===== Wave 3 organization-scope checks (0054-0058) =====
-- A stale or orphaned closure is a SECURITY defect, not a performance defect: auth_scopes()
-- answers from user_scope_closure, so a row that disagrees with a live recompute widens or
-- narrows what the 0057 rider allows. Pure reads only, per this file's contract.
stale_user_scope_closure as (
  select pair.user_id as id
  from (
    select g.org_id, g.user_id from user_scope_grants g
    union
    select c.org_id, c.user_id from user_scope_closure c
  ) pair
  where coalesce(
      (select c.unit_ids from user_scope_closure c
        where c.org_id = pair.org_id and c.user_id = pair.user_id),
      '{}'::uuid[])
    is distinct from coalesce(
      -- The same expansion p0_recompute_scope_closure runs, inline and read-only: every
      -- granted unit plus its subtree, deduplicated, ordered by id.
      (with recursive reachable as (
         select u.id
         from org_units u
         where u.org_id = pair.org_id
           and exists (
             select 1 from user_scope_grants g
             where g.org_id = pair.org_id and g.user_id = pair.user_id and g.unit_id = u.id)
         union
         select child.id
         from org_units child
         join reachable r on child.parent_id = r.id
         where child.org_id = pair.org_id
       )
       select array_agg(d.id order by d.id) from (select id from reachable) d),
      '{}'::uuid[])
),
orphan_closure_rows as (
  select c.user_id as id
  from user_scope_closure c
  where not exists (
    select 1 from user_scope_grants g
    where g.org_id = c.org_id and g.user_id = c.user_id)
),
orgs_without_root_unit as (
  select o.id
  from organizations o
  where (select count(*) from org_units u
         where u.org_id = o.id and u.unit_type = 'root') <> 1
),
users_without_scope_grant as (
  select p.id
  from profiles p
  where not exists (
    select 1 from user_scope_grants g
    where g.org_id = p.org_id and g.user_id = p.id)
),
cross_tenant_org_units as (
  select u.id
  from org_units u
  join org_units parent on parent.id = u.parent_id
  where parent.org_id <> u.org_id
),
org_unit_cycles as (
  with recursive walk(start_id, node_id, depth) as (
    select u.id, u.parent_id, 1 from org_units u where u.parent_id is not null
    union all
    select w.start_id, u.parent_id, w.depth + 1
    from walk w
    join org_units u on u.id = w.node_id
    where u.parent_id is not null and w.depth < 64
  )
  select distinct start_id as id from walk where node_id = start_id
),
unit_id_org_mismatch as (
  -- Structurally impossible through the composite (org_id, unit_id) foreign keys; verified
  -- anyway because a scope pointer into another tenant is the exact class of defect this
  -- report exists to catch before it can matter.
  select t.id
  from (
    select i.id, i.org_id, i.unit_id from invoices i
    union all select p.id, p.org_id, p.unit_id from payments p
    union all select po.id, po.org_id, po.unit_id from purchase_orders po
    union all select gr.id, gr.org_id, gr.unit_id from goods_receipts gr
    union all select im.id, im.org_id, im.unit_id from inventory_movements im
    union all select d.id, d.org_id, d.unit_id from documents d
  ) t
  join org_units u on u.id = t.unit_id
  where u.org_id <> t.org_id
),
multi_unit_org_with_open_exemptions as (
  -- The 0057 latch (OPEN-DECISIONS #83): while private.scope_definer_exemptions is
  -- non-empty, an organization holding sibling units of the same type is the state in
  -- which the exempted definer functions could actually leak across units -- so reaching
  -- it is a blocking anomaly. Draining the registry, not weakening this check, is the
  -- multi-unit enablement wave's entry criterion.
  select distinct latch.org_id as id
  from (
    select u.org_id
    from org_units u
    where exists (select 1 from private.scope_definer_exemptions)
    group by u.org_id, u.unit_type
    having count(*) > 1
  ) latch
),
checks(check_name, rows_found, sample_ids) as (
  select 'duplicate_payment_executions', count(*),
    coalesce((select jsonb_agg(id) from (select id from duplicate_payment_executions limit 20) s), '[]'::jsonb)
  from duplicate_payment_executions
  union all select 'invalid_payment_allocations', count(*),
    coalesce((select jsonb_agg(id) from (select id from invalid_payment_allocations limit 20) s), '[]'::jsonb)
  from invalid_payment_allocations
  union all select 'overallocated_payments', count(*),
    coalesce((select jsonb_agg(id) from (select id from overallocated_payments limit 20) s), '[]'::jsonb)
  from overallocated_payments
  union all select 'invalid_bank_allocations', count(*),
    coalesce((select jsonb_agg(id) from (select id from invalid_bank_allocations limit 20) s), '[]'::jsonb)
  from invalid_bank_allocations
  union all select 'bank_allocations_bad_amount', count(*),
    coalesce((select jsonb_agg(id) from (select id from bank_allocations_bad_amount limit 20) s), '[]'::jsonb)
  from bank_allocations_bad_amount
  union all select 'bank_allocations_bad_target_count', count(*),
    coalesce((select jsonb_agg(id) from (select id from bank_allocations_bad_target_count limit 20) s), '[]'::jsonb)
  from bank_allocations_bad_target_count
  union all select 'bank_allocations_bad_confidence', count(*),
    coalesce((select jsonb_agg(id) from (select id from bank_allocations_bad_confidence limit 20) s), '[]'::jsonb)
  from bank_allocations_bad_confidence
  union all select 'bank_allocations_cross_tenant', count(*),
    coalesce((select jsonb_agg(id) from (select id from bank_allocations_cross_tenant limit 20) s), '[]'::jsonb)
  from bank_allocations_cross_tenant
  union all select 'bank_allocations_supplier_mismatch', count(*),
    coalesce((select jsonb_agg(id) from (select id from bank_allocations_supplier_mismatch limit 20) s), '[]'::jsonb)
  from bank_allocations_supplier_mismatch
  union all select 'overallocated_bank_transactions', count(*),
    coalesce((select jsonb_agg(id) from (select id from overallocated_bank_transactions limit 20) s), '[]'::jsonb)
  from overallocated_bank_transactions
  union all select 'duplicate_bank_rows', count(*),
    coalesce((select jsonb_agg(id) from (select id from duplicate_bank_rows limit 20) s), '[]'::jsonb)
  from duplicate_bank_rows
  union all select 'duplicate_receipt_lines', count(*),
    coalesce((select jsonb_agg(id) from (select id from duplicate_receipt_lines limit 20) s), '[]'::jsonb)
  from duplicate_receipt_lines
  union all select 'invalid_receipt_quantities', count(*),
    coalesce((select jsonb_agg(id) from (select id from invalid_receipt_quantities limit 20) s), '[]'::jsonb)
  from invalid_receipt_quantities
  union all select 'overreceived_order_items', count(*),
    coalesce((select jsonb_agg(id) from (select id from overreceived_order_items limit 20) s), '[]'::jsonb)
  from overreceived_order_items
  union all select 'prices_without_matching_history', count(*),
    coalesce((select jsonb_agg(id) from (select id from prices_without_history limit 20) s), '[]'::jsonb)
  from prices_without_history
  union all select 'cross_tenant_price_history', count(*),
    coalesce((select jsonb_agg(id) from (select id from cross_tenant_price_history limit 20) s), '[]'::jsonb)
  from cross_tenant_price_history
  union all select 'invalid_supplier_prices', count(*),
    coalesce((select jsonb_agg(id) from (select id from invalid_supplier_prices limit 20) s), '[]'::jsonb)
  from invalid_supplier_prices
  union all select 'duplicate_month_exports', count(*),
    coalesce((select jsonb_agg(id) from (select id from duplicate_month_exports limit 20) s), '[]'::jsonb)
  from duplicate_month_exports
  union all select 'noncanonical_month_exports', count(*),
    coalesce((select jsonb_agg(id) from (select id from noncanonical_month_exports limit 20) s), '[]'::jsonb)
  from noncanonical_month_exports
  union all select 'legacy_sent_exports_without_snapshot', count(*),
    coalesce((select jsonb_agg(id) from (select id from legacy_sent_exports limit 20) s), '[]'::jsonb)
  from legacy_sent_exports
  union all select 'stale_user_scope_closure', count(*),
    coalesce((select jsonb_agg(id) from (select id from stale_user_scope_closure limit 20) s), '[]'::jsonb)
  from stale_user_scope_closure
  union all select 'orphan_closure_rows', count(*),
    coalesce((select jsonb_agg(id) from (select id from orphan_closure_rows limit 20) s), '[]'::jsonb)
  from orphan_closure_rows
  union all select 'orgs_without_root_unit', count(*),
    coalesce((select jsonb_agg(id) from (select id from orgs_without_root_unit limit 20) s), '[]'::jsonb)
  from orgs_without_root_unit
  union all select 'users_without_scope_grant', count(*),
    coalesce((select jsonb_agg(id) from (select id from users_without_scope_grant limit 20) s), '[]'::jsonb)
  from users_without_scope_grant
  union all select 'cross_tenant_org_units', count(*),
    coalesce((select jsonb_agg(id) from (select id from cross_tenant_org_units limit 20) s), '[]'::jsonb)
  from cross_tenant_org_units
  union all select 'org_unit_cycles', count(*),
    coalesce((select jsonb_agg(id) from (select id from org_unit_cycles limit 20) s), '[]'::jsonb)
  from org_unit_cycles
  union all select 'unit_id_org_mismatch', count(*),
    coalesce((select jsonb_agg(id) from (select id from unit_id_org_mismatch limit 20) s), '[]'::jsonb)
  from unit_id_org_mismatch
  union all select 'multi_unit_org_with_open_exemptions', count(*),
    coalesce((select jsonb_agg(id) from (select id from multi_unit_org_with_open_exemptions limit 20) s), '[]'::jsonb)
  from multi_unit_org_with_open_exemptions
)
select check_name, rows_found, sample_ids
from checks
order by check_name;
