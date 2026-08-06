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
-- ===== Wave 4 flags & identity checks (0059-0061) =====
-- The first is the real anomaly this wave can produce (config keys are deliberately not
-- FK-bound to private.flag_definitions); the other four are structurally impossible
-- through NOT NULL / unique / composite-FK constraints and are verified anyway -- a flag
-- config nobody defined, an event without a tenant, or an identity mapping that crosses
-- one are exactly the defect classes this report exists to catch before they matter.
flag_config_without_definition as (
  select c.id
  from org_flag_configurations c
  where not exists (
    select 1 from private.flag_definitions d where d.flag_key = c.flag_key)
),
security_events_without_org as (
  select e.id
  from security_events e
  left join organizations o on o.id = e.org_id
  where e.org_id is null or o.id is null
),
identity_mapping_to_unknown_user as (
  select m.id
  from external_identity_mappings m
  left join profiles p on p.id = m.user_id
  where p.id is null
),
duplicate_identity_mapping as (
  select (array_agg(id order by id))[1] as id
  from external_identity_mappings
  group by provider, external_subject
  having count(*) > 1
),
identity_mapping_cross_tenant as (
  select m.id
  from external_identity_mappings m
  join profiles p on p.id = m.user_id
  where p.org_id <> m.org_id
),
-- ===== Wave 5 domain events & outbox checks (0063-0064) =====
-- The first two guard the event plane: a unit pointer into another tenant is structurally
-- impossible through the composite (org_id, unit_id) FK and verified anyway; an event
-- whose type no map row names means the emission contract and the map drifted apart.
-- The outbox three guard delivery hygiene: a claim nobody released, a dead letter with no
-- reason, and a blank target -- impossible (NOT NULL + check) and verified anyway. The
-- wave-5 reading of the last arm ("the outbox must stay EMPTY until wave 7 registers
-- targets") is superseded: wave 7 (0066) registers targets, so the honest successor
-- canary is outbox_target_unregistered below.
domain_events_cross_tenant_unit as (
  select e.id
  from domain_events e
  join org_units u on u.id = e.unit_id
  where u.org_id <> e.org_id
),
domain_events_unknown_event_type as (
  select e.id
  from domain_events e
  where not exists (
    select 1 from private.domain_event_map m where m.event_type = e.event_type)
),
stuck_outbox_rows as (
  select o.id
  from private.integration_outbox o
  where (o.status = 'claimed' and o.claimed_at < now() - interval '1 hour')
     or (o.status = 'pending' and o.next_attempt_at < now() - interval '24 hours')
),
dead_letter_without_failure_reason as (
  select d.id
  from private.dead_letter_records d
  where nullif(btrim(d.failure_reason), '') is null
),
outbox_rows_without_target as (
  select o.id
  from private.integration_outbox o
  where nullif(btrim(o.target), '') is null
),
-- ===== Wave 7 integration-adapter check (0066) =====
-- The honest successor to the wave-5 "empty outbox" canary. Since 0066, rows enter the
-- outbox only through the enqueue trigger, which fires per ACTIVE webhook subscription --
-- so a PENDING row whose target has no active subscription is machinery escaping its
-- design: either the subscription was deactivated/deleted with work still queued (the
-- worker would burn all 8 attempts on target_unregistered), or something enqueued a
-- target nobody registered. The second half folds in the orphan-subscription arm: a
-- subscription whose target is not the generated 'webhook:'||id derivation -- structurally
-- impossible (stored generated column), verified anyway, in the same read-only pass.
outbox_target_unregistered as (
  select o.id
  from private.integration_outbox o
  where o.status = 'pending'
    and not exists (
      select 1 from webhook_subscriptions w
      where w.target = o.target and w.active)
  union all
  select w.id
  from webhook_subscriptions w
  where w.target is distinct from ('webhook:' || w.id::text)
),
-- ===== Wave 6b upload-reservation check (0065) =====
-- The orphan class the reservation plane can produce: a claim still 'reserved' past its
-- expires_at whose bytes already landed in the bucket. Expiry closed the register gate,
-- so on a quiesced database nothing will ever turn the object into a registered row --
-- the reservation is sweep-fodder and the stored object is what remains. Read-only,
-- like every arm here; the sweep itself stays inside reserve (grace-delayed by 0065).
expired_reservations_with_stored_object as (
  select r.document_id as id
  from supplier_price_document_upload_reservations r
  join storage.objects o
    on o.bucket_id = 'documents'
   and o.name = r.storage_path
  where r.status = 'reserved'
    and r.expires_at <= now()
),
-- ===== Wave 9 notification-preference & approval-policy checks (0068, 0070) =====
-- The first is structurally impossible -- notification_preferences reaches profiles only
-- through the composite (org_id, user_id) FK -- and is verified anyway, because a preference
-- row bridging two tenants would decide, from inside one tenant, who the other tenant
-- notifies. The second is the real anomaly wave 9 can produce: policy configuration keys are
-- deliberately NOT FK-bound to the private definitions (0070 §2, the 0059:66-68 reasoning),
-- so a definition that retires leaves an orphan configuration that no evaluator can explain.
notification_preference_cross_tenant as (
  select pref.id
  from notification_preferences pref
  join profiles p on p.id = pref.user_id
  where p.org_id <> pref.org_id
),
approval_policy_config_without_definition as (
  select c.id
  from approval_policy_configurations c
  where not exists (
    select 1 from private.approval_policy_definitions d where d.policy_key = c.policy_key)
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
  union all select 'flag_config_without_definition', count(*),
    coalesce((select jsonb_agg(id) from (select id from flag_config_without_definition limit 20) s), '[]'::jsonb)
  from flag_config_without_definition
  union all select 'security_events_without_org', count(*),
    coalesce((select jsonb_agg(id) from (select id from security_events_without_org limit 20) s), '[]'::jsonb)
  from security_events_without_org
  union all select 'identity_mapping_to_unknown_user', count(*),
    coalesce((select jsonb_agg(id) from (select id from identity_mapping_to_unknown_user limit 20) s), '[]'::jsonb)
  from identity_mapping_to_unknown_user
  union all select 'duplicate_identity_mapping', count(*),
    coalesce((select jsonb_agg(id) from (select id from duplicate_identity_mapping limit 20) s), '[]'::jsonb)
  from duplicate_identity_mapping
  union all select 'identity_mapping_cross_tenant', count(*),
    coalesce((select jsonb_agg(id) from (select id from identity_mapping_cross_tenant limit 20) s), '[]'::jsonb)
  from identity_mapping_cross_tenant
  union all select 'domain_events_cross_tenant_unit', count(*),
    coalesce((select jsonb_agg(id) from (select id from domain_events_cross_tenant_unit limit 20) s), '[]'::jsonb)
  from domain_events_cross_tenant_unit
  union all select 'domain_events_unknown_event_type', count(*),
    coalesce((select jsonb_agg(id) from (select id from domain_events_unknown_event_type limit 20) s), '[]'::jsonb)
  from domain_events_unknown_event_type
  union all select 'stuck_outbox_rows', count(*),
    coalesce((select jsonb_agg(id) from (select id from stuck_outbox_rows limit 20) s), '[]'::jsonb)
  from stuck_outbox_rows
  union all select 'dead_letter_without_failure_reason', count(*),
    coalesce((select jsonb_agg(id) from (select id from dead_letter_without_failure_reason limit 20) s), '[]'::jsonb)
  from dead_letter_without_failure_reason
  union all select 'outbox_rows_without_target', count(*),
    coalesce((select jsonb_agg(id) from (select id from outbox_rows_without_target limit 20) s), '[]'::jsonb)
  from outbox_rows_without_target
  union all select 'outbox_target_unregistered', count(*),
    coalesce((select jsonb_agg(id) from (select id from outbox_target_unregistered limit 20) s), '[]'::jsonb)
  from outbox_target_unregistered
  union all select 'expired_reservations_with_stored_object', count(*),
    coalesce((select jsonb_agg(id) from (select id from expired_reservations_with_stored_object limit 20) s), '[]'::jsonb)
  from expired_reservations_with_stored_object
  union all select 'notification_preference_cross_tenant', count(*),
    coalesce((select jsonb_agg(id) from (select id from notification_preference_cross_tenant limit 20) s), '[]'::jsonb)
  from notification_preference_cross_tenant
  union all select 'approval_policy_config_without_definition', count(*),
    coalesce((select jsonb_agg(id) from (select id from approval_policy_config_without_definition limit 20) s), '[]'::jsonb)
  from approval_policy_config_without_definition
)
select check_name, rows_found, sample_ids
from checks
order by check_name;
