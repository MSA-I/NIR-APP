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
  if v_name is not null and v_name <> 'אולמי גאמוס' then
    raise exception 'Organization % is named "%" — that is not the demo tenant. Refusing to delete.', v_org, v_name;
  end if;

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

  delete from organizations where id = v_org;

  -- Last: the deletes above each fired the audit trigger and wrote new audit rows. Since
  -- migration 0009 the allocation tables carry org_id too, so this one predicate catches
  -- every audit row the teardown produced.
  delete from audit_logs where org_id = v_org;

  raise notice 'Demo organization % removed.', v_org;
end $$;
