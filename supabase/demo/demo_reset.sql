-- SupplyFlow — remove the demo tenant.
--
-- Deletes every row belonging to the demo organization and nothing else. Scoped strictly
-- by org_id, so it is safe to run on a database that also holds real tenants: a row that
-- does not carry the demo org id is never touched.
--
-- Run this before re-loading supabase/demo/demo_seed.sql (the seed refuses to load twice
-- rather than silently duplicating data). scripts\seed-demo.ps1 does both in one command.
--
-- The demo auth.users rows survive on purpose — profiles are resolved from them by email,
-- so create-users.ps1 only ever has to run once per project.

do $$
declare
  v_org uuid := '11111111-1111-4111-8111-111111111111';
  v_name text;
begin
  select name into v_name from organizations where id = v_org;

  -- Safety: never let this file delete something that is not the demo tenant.
  if v_name is not null and v_name <> 'עסק לדוגמה' then
    raise exception 'Organization % is named "%" — that is not the demo tenant. Refusing to delete.', v_org, v_name;
  end if;

  -- 0175 made raw audit history immutable and gave audit_logs a legal-entity foreign key to
  -- org_units with ON DELETE RESTRICT. Removing a tenant therefore needs two things this file did
  -- not need before: the authorized purge declaration the immutability guard defines, and the
  -- tenant's audit rows gone BEFORE `delete from organizations` cascades its org_units away --
  -- otherwise the restrict fires on the seeded rows that carry a legal entity. The GUC is
  -- transaction-local and expires with this statement.
  perform set_config('app.audit_purge', 'organization_teardown', true);

  -- Order follows the foreign keys inward: junctions and children first, then their
  -- parents, then profiles (referenced by every created_by / received_by column), and
  -- finally the organization itself.
  delete from comments   where org_id = v_org;
  delete from exceptions where org_id = v_org;

  delete from bank_allocations  where org_id = v_org;
  delete from bank_transactions where org_id = v_org;
  delete from bank_imports      where org_id = v_org;

  delete from payment_allocations      where org_id = v_org;
  delete from payments                 where org_id = v_org;
  delete from payment_request_invoices where payment_request_id in (select id from payment_requests where org_id = v_org);
  delete from payment_requests         where org_id = v_org;

  delete from credit_requests      where org_id = v_org;
  delete from invoice_order_links   where invoice_id in (select id from invoices where org_id = v_org);
  delete from invoice_receipt_links where invoice_id in (select id from invoices where org_id = v_org);
  delete from invoices              where org_id = v_org;

  delete from goods_receipt_items where receipt_id in (select id from goods_receipts where org_id = v_org);
  delete from goods_receipts      where org_id = v_org;

  delete from purchase_order_items   where order_id in (select id from purchase_orders where org_id = v_org);
  delete from purchase_orders        where org_id = v_org;
  delete from purchase_request_items where request_id in (select id from purchase_requests where org_id = v_org);
  delete from purchase_requests      where org_id = v_org;

  delete from price_history        where org_id = v_org;
  delete from supplier_products    where org_id = v_org;
  delete from products             where org_id = v_org;
  delete from supplier_categories  where supplier_id in (select id from suppliers where org_id = v_org);
  delete from categories           where org_id = v_org;
  delete from monthly_exports      where org_id = v_org;
  delete from documents            where org_id = v_org;

  -- profiles before suppliers: a supplier-agent profile carries supplier_id.
  delete from profiles  where org_id = v_org;
  delete from suppliers where org_id = v_org;

  -- The event plane, before the organization. This was a real gap from wave 5 onward, and it
  -- broke this file: domain_events.org_id references organizations WITHOUT a cascade
  -- (0063:69), and the audit fan-out fills the table during the seed itself (an inserted
  -- product, supplier or order each emits an event), so `delete from organizations` failed on
  -- domain_events_org_id_fkey. Every other table added since wave 3 cascades with the
  -- organization -- notification_preferences and approval_policy_configurations included --
  -- which is exactly why this one stood out once it was actually run.
  --
  -- The three private tables that reference an event go first. The demo's only webhook
  -- subscription is deliberately INACTIVE (OPEN-DECISIONS #98), so nothing is ever enqueued
  -- and these three deletes are no-ops today. They are written anyway: a demo tenant that
  -- someone switched a subscription on for must still be removable without hand-editing SQL.
  delete from private.integration_deliveries
   where outbox_id in (select id from private.integration_outbox where org_id = v_org);
  delete from private.dead_letter_records
   where event_id in (select id from domain_events where org_id = v_org);
  delete from private.idempotency_keys
   where event_id in (select id from domain_events where org_id = v_org);
  delete from private.integration_outbox where org_id = v_org;
  delete from domain_events where org_id = v_org;

  -- Before the organization, not after: every audit row the seed wrote for an invoice, payment
  -- or payment request carries legal_entity_id, and audit_logs_legal_entity_fk (0175) restricts
  -- the org_units delete that `delete from organizations` cascades.
  delete from audit_logs where org_id = v_org;

  delete from organizations where id = v_org;

  -- Again, last: the deletes above each fired the audit trigger and wrote new audit rows. Since
  -- migration 0009 the allocation tables carry org_id too, so this one predicate catches every
  -- audit row the teardown produced. These rows never carry a legal entity -- the row each one
  -- describes is already gone, so private.resolve_audit_legal_entity finds nothing and classifies
  -- them cross_scope -- which is why they do not block the cascade above.
  delete from audit_logs where org_id = v_org;

  raise notice 'Demo organization % removed.', v_org;
end $$;
