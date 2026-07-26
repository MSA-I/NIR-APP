-- Roadmap database contracts: supplier portal, inventory, savings snapshots and WhatsApp.
\set ON_ERROR_STOP on

begin;

create function pg_temp.roadmap_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'Roadmap assertion failed: %', p_message;
  end if;
end
$$;

create temporary table roadmap_values (key text primary key, value text not null);
grant select, insert, update, delete on roadmap_values to authenticated, anon;

insert into organizations (id, name, status) values
  ('91000000-0000-0000-0000-000000000001', 'Roadmap tenant A', 'active'),
  ('91000000-0000-0000-0000-000000000002', 'Roadmap tenant B', 'active');

insert into auth.users (id, email) values
  ('92000000-0000-0000-0000-000000000001', 'roadmap-owner@example.test'),
  ('92000000-0000-0000-0000-000000000002', 'roadmap-office@example.test'),
  ('92000000-0000-0000-0000-000000000003', 'roadmap-supplier@example.test'),
  ('92000000-0000-0000-0000-000000000004', 'roadmap-owner-b@example.test'),
  ('92000000-0000-0000-0000-000000000005', 'roadmap-kitchen@example.test');

insert into suppliers (id, org_id, name, whatsapp) values
  ('93000000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000001', 'Roadmap supplier A1', '+972501111111'),
  ('93000000-0000-0000-0000-000000000002', '91000000-0000-0000-0000-000000000001', 'Roadmap supplier A2', '+972502222222'),
  ('93000000-0000-0000-0000-000000000003', '91000000-0000-0000-0000-000000000001', 'Roadmap supplier A3', '+972503333333'),
  ('93000000-0000-0000-0000-000000000004', '91000000-0000-0000-0000-000000000002', 'Roadmap supplier B1', '+972504444444'),
  ('93000000-0000-0000-0000-000000000005', '91000000-0000-0000-0000-000000000001', 'Deleted invitation supplier', '+972505555555');

insert into profiles (id, org_id, full_name, role, supplier_id) values
  ('92000000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000001', 'Roadmap Owner', 'owner', null),
  ('92000000-0000-0000-0000-000000000002', '91000000-0000-0000-0000-000000000001', 'Roadmap Office', 'office', null),
  ('92000000-0000-0000-0000-000000000003', '91000000-0000-0000-0000-000000000001', 'Roadmap Supplier Agent', 'supplier', '93000000-0000-0000-0000-000000000001'),
  ('92000000-0000-0000-0000-000000000004', '91000000-0000-0000-0000-000000000002', 'Roadmap Owner B', 'owner', null),
  ('92000000-0000-0000-0000-000000000005', '91000000-0000-0000-0000-000000000001', 'Roadmap Kitchen', 'kitchen', null);

insert into purchase_requests (
  id, org_id, status, created_by, editor_step
) values (
  '97200000-0000-0000-0000-000000000001',
  '91000000-0000-0000-0000-000000000001', 'draft',
  '92000000-0000-0000-0000-000000000001', 1
);

insert into products (id, org_id, name, unit, min_stock) values
  ('94000000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000001', 'Portal product', 'unit', 3),
  ('94000000-0000-0000-0000-000000000002', '91000000-0000-0000-0000-000000000001', 'Receipt product', 'kg', 2),
  ('94000000-0000-0000-0000-000000000003', '91000000-0000-0000-0000-000000000001', 'Savings product 1', 'unit', null),
  ('94000000-0000-0000-0000-000000000004', '91000000-0000-0000-0000-000000000001', 'Savings product 2', 'unit', null),
  ('94000000-0000-0000-0000-000000000005', '91000000-0000-0000-0000-000000000002', 'Tenant B product', 'unit', null),
  ('94000000-0000-0000-0000-000000000006', '91000000-0000-0000-0000-000000000001', 'Inactive portal product', 'unit', null);
update products set active = false where id = '94000000-0000-0000-0000-000000000006';

insert into supplier_products (
  id, org_id, supplier_id, product_id, current_price, price_effective_date,
  available, supplier_sku, min_qty, package_size
) values
  ('95000000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000001', 10, date_trunc('month', current_date)::date, true, 'A1-PORTAL', 1, 1),
  ('95000000-0000-0000-0000-000000000002', '91000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000002', '94000000-0000-0000-0000-000000000001', 9, date_trunc('month', current_date)::date, true, 'A2-PORTAL', 1, 1),
  ('95000000-0000-0000-0000-000000000003', '91000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000003', 10, date_trunc('month', current_date)::date, true, 'A1-S1', null, 1),
  ('95000000-0000-0000-0000-000000000004', '91000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000002', '94000000-0000-0000-0000-000000000003', 35, date_trunc('month', current_date)::date, true, 'A2-S1', 5, 1),
  ('95000000-0000-0000-0000-000000000005', '91000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000004', 20, date_trunc('month', current_date)::date, true, 'A1-S2', null, 1),
  ('95000000-0000-0000-0000-000000000006', '91000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000002', '94000000-0000-0000-0000-000000000004', 15, date_trunc('month', current_date)::date, true, 'A2-S2', null, 1),
  ('95000000-0000-0000-0000-000000000007', '91000000-0000-0000-0000-000000000002', '93000000-0000-0000-0000-000000000004', '94000000-0000-0000-0000-000000000005', 99, date_trunc('month', current_date)::date, true, 'B1', null, 1),
  ('95000000-0000-0000-0000-000000000008', '91000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000006', 5, date_trunc('month', current_date)::date, true, 'A1-INACTIVE', null, 1),
  ('95000000-0000-0000-0000-000000000009', '91000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000003', '94000000-0000-0000-0000-000000000001', 20, date_trunc('month', current_date)::date, true, 'A3-KPI', null, 1),
  ('95000000-0000-0000-0000-000000000010', '91000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000003', '94000000-0000-0000-0000-000000000003', 5, date_trunc('month', current_date)::date, false, 'A3-UNAVAILABLE', null, 1);

insert into price_history (
  org_id, supplier_product_id, price, effective_date, created_by
) values
  ('91000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-000000000009', 20, current_date - 2, '92000000-0000-0000-0000-000000000001'),
  ('91000000-0000-0000-0000-000000000001', '95000000-0000-0000-0000-000000000009', 20, current_date - 1, '92000000-0000-0000-0000-000000000001');

-- The later P0/P1B contract permits the tenant catalog and this supplier's own offer rows.
-- Organization and supplier records remain available only through the dedicated projection.
select set_config('request.jwt.claim.sub', '92000000-0000-0000-0000-000000000003', true);
set local role authenticated;

select pg_temp.roadmap_assert(
  (select count(*) = 0 from organizations),
  'supplier can read organizations directly'
);
select pg_temp.roadmap_assert(
  (select count(*) = 0 from suppliers),
  'supplier can read suppliers directly'
);
select pg_temp.roadmap_assert(
  (select count(*) = 5 from products)
  and not exists (select 1 from products where org_id <> '91000000-0000-0000-0000-000000000001'),
  'supplier catalog visibility is incomplete or crosses tenants'
);
select pg_temp.roadmap_assert(
  (select count(*) = 4 from supplier_products)
  and not exists (
    select 1 from supplier_products
    where supplier_id <> '93000000-0000-0000-0000-000000000001'
  ),
  'supplier price visibility is incomplete or crosses suppliers'
);
select pg_temp.roadmap_assert(
  supplier_portal_context()->>'organization_name' = 'Roadmap tenant A'
  and supplier_portal_context()->'supplier'->>'id' = '93000000-0000-0000-0000-000000000001'
  and jsonb_array_length(supplier_portal_context()->'prices') = 3,
  'supplier portal projection is incomplete or over-broad'
);

do $$
begin
  perform set_supplier_product_price(
    '95000000-0000-0000-0000-000000000001', 11, current_date, true, 'forbidden direct supplier write'
  );
  raise exception 'expected supplier manual price rejection';
exception when sqlstate '42501' then
  if sqlerrm not like '%price_write_not_authorized%' then raise; end if;
end
$$;

do $$
begin
  perform import_supplier_prices(
    '[{"supplier_id":"93000000-0000-0000-0000-000000000001","product_id":"94000000-0000-0000-0000-000000000001","price":11,"available":true}]'::jsonb,
    date_trunc('month', current_date)::date,
    'forbidden legacy supplier import'
  );
  raise exception 'expected legacy supplier import rejection';
exception when sqlstate '42501' then
  if sqlerrm not like '%price_import_not_authorized%' then raise; end if;
end
$$;

select pg_temp.roadmap_assert(
  to_regprocedure('public.import_supplier_prices(jsonb,date,text,uuid)') is null,
  'legacy supplier submission RPC still exposes a second write path'
);
select pg_temp.roadmap_assert(
  to_regprocedure('public.submit_supplier_price_list(uuid)') is not null,
  'trusted supplier submission intake RPC is missing'
);

-- Owner invitation overload binds a supplier; the legacy overload cannot create supplier users.
reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.sub', '92000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select pg_temp.roadmap_assert(
  create_invitation(
    'new-supplier-agent@example.test', 'supplier',
    '93000000-0000-0000-0000-000000000001'
  )->>'supplier_id' = '93000000-0000-0000-0000-000000000001',
  'supplier invitation was not supplier-bound'
);
with invitation_payload as (
  select create_invitation(
    'deleted-supplier-agent@example.test', 'supplier',
    '93000000-0000-0000-0000-000000000005'
  ) as result
)
insert into roadmap_values (key, value)
select 'deleted_supplier_invitation_id', result->>'invitation_id' from invitation_payload
union all
select 'deleted_supplier_invitation_token', result->>'token' from invitation_payload;
do $$
begin
  perform create_invitation('legacy-supplier@example.test', 'supplier');
  raise exception 'expected legacy supplier invitation rejection';
exception when sqlstate '22023' then
  if sqlerrm not like '%supplier_invitation_requires_supplier%' then raise; end if;
end
$$;
select soft_delete_supplier(
  '93000000-0000-0000-0000-000000000005',
  'verify deleted supplier invitation handling'
);
select pg_temp.roadmap_assert(
  lookup_invitation(
    (select value from roadmap_values where key = 'deleted_supplier_invitation_token')
  )->>'status' = 'unknown',
  'deleted supplier invitation still looked valid'
);
do $$
begin
  perform resend_invitation(
    (select value::uuid from roadmap_values where key = 'deleted_supplier_invitation_id')
  );
  raise exception 'expected deleted supplier resend rejection';
exception when sqlstate '23514' then
  if sqlerrm not like '%supplier_outside_organization%' then raise; end if;
end
$$;

-- Inventory is unknown until the first count, then all changes are immutable ledger entries.
select pg_temp.roadmap_assert(
  (select quantity_on_hand is null and not is_counted
   from inventory_balances where product_id = '94000000-0000-0000-0000-000000000001'),
  'uncounted inventory claimed a balance'
);
do $$
begin
  perform record_inventory_movement(
    '97000000-0000-0000-0000-000000000001',
    '94000000-0000-0000-0000-000000000001',
    'consumption', 1, false, 'consumption before count'
  );
  raise exception 'expected first-stocktake requirement';
exception when sqlstate 'P0001' then
  if sqlerrm not like '%inventory_stocktake_required%' then raise; end if;
end
$$;

select record_inventory_stocktake(
  '97000000-0000-0000-0000-000000000002',
  '94000000-0000-0000-0000-000000000001', 10, 'initial stocktake'
);
select record_inventory_movement(
  '97000000-0000-0000-0000-000000000003',
  '94000000-0000-0000-0000-000000000001',
  'consumption', 3, false, 'kitchen consumption'
);
select record_inventory_movement(
  '97000000-0000-0000-0000-000000000004',
  '94000000-0000-0000-0000-000000000001',
  'adjustment', 2, false, 'counting adjustment'
);
select pg_temp.roadmap_assert(
  (select quantity_on_hand = 9 and is_counted
   from inventory_balances where product_id = '94000000-0000-0000-0000-000000000001'),
  'inventory ledger did not calculate the balance'
);

reset role;
select set_config('request.jwt.claim.sub', '92000000-0000-0000-0000-000000000005', true);
set local role authenticated;
do $$
begin
  perform record_inventory_movement(
    '97000000-0000-0000-0000-000000000009',
    '94000000-0000-0000-0000-000000000001',
    'adjustment', 1, false, 'kitchen adjustment must be rejected'
  );
  raise exception 'expected kitchen adjustment rejection';
exception when sqlstate '42501' then
  if sqlerrm not like '%inventory_not_authorized%' then raise; end if;
end
$$;
reset role;
select set_config('request.jwt.claim.sub', '92000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select record_inventory_stocktake(
  '97000000-0000-0000-0000-000000000008',
  '94000000-0000-0000-0000-000000000001', 9, 'later physical count'
);
do $$
begin
  perform reverse_inventory_movement(
    '97000000-0000-0000-0000-000000000007',
    '97000000-0000-0000-0000-000000000003', false,
    'must not reverse consumption before later count'
  );
  raise exception 'expected superseded movement rejection';
exception when sqlstate 'P0001' then
  if sqlerrm not like '%inventory_target_superseded_by_stocktake%' then raise; end if;
end
$$;

select record_inventory_movement(
  '97000000-0000-0000-0000-000000000005',
  '94000000-0000-0000-0000-000000000001',
  'adjustment', -20, true, 'owner-approved negative balance'
);
do $$
begin
  perform record_inventory_movement(
    '97000000-0000-0000-0000-000000000005',
    '94000000-0000-0000-0000-000000000001',
    'adjustment', -20, false, 'owner-approved negative balance'
  );
  raise exception 'expected negative override fingerprint conflict';
exception when sqlstate 'P0001' then
  if sqlerrm not like '%inventory_movement_id_conflict%' then raise; end if;
end
$$;
select reverse_inventory_movement(
  '97000000-0000-0000-0000-000000000006',
  '97000000-0000-0000-0000-000000000005', false, 'reverse negative adjustment'
);

-- Receipt movements are recorded before the product has ever been counted.
reset role;
select set_config('request.jwt.claim.sub', '', true);
insert into purchase_orders (
  id, org_id, supplier_id, status, created_by
) values (
  '97100000-0000-0000-0000-000000000001',
  '91000000-0000-0000-0000-000000000001',
  '93000000-0000-0000-0000-000000000001', 'confirmed',
  '92000000-0000-0000-0000-000000000001'
);
insert into purchase_order_items (
  id, org_id, order_id, product_id, qty, unit_price
) values (
  '97110000-0000-0000-0000-000000000001',
  '91000000-0000-0000-0000-000000000001',
  '97100000-0000-0000-0000-000000000001',
  '94000000-0000-0000-0000-000000000002', 5, 7
);
select set_config('request.jwt.claim.sub', '92000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select save_goods_receipt(
  '97100000-0000-0000-0000-000000000001',
  '97120000-0000-0000-0000-000000000001', true, null, false,
  '[{"order_item_id":"97110000-0000-0000-0000-000000000001","qty_received":5,"status":"full","notes":null}]'::jsonb,
  'complete receipt for inventory'
);
select pg_temp.roadmap_assert(
  (select count(*) = 1 from inventory_movements
   where product_id = '94000000-0000-0000-0000-000000000002'
     and movement_type = 'receipt' and quantity_delta = 5),
  'receipt did not create one inventory movement'
);
select pg_temp.roadmap_assert(
  (select quantity_on_hand is null and not is_counted
   from inventory_balances where product_id = '94000000-0000-0000-0000-000000000002'),
  'receipt before first count claimed a known balance'
);
select record_inventory_stocktake(
  '97130000-0000-0000-0000-000000000001',
  '94000000-0000-0000-0000-000000000002', 4, 'first count after receipt'
);
select pg_temp.roadmap_assert(
  (select quantity_on_hand = 4 from inventory_balances
   where product_id = '94000000-0000-0000-0000-000000000002'),
  'stocktake did not establish the absolute balance after receipt'
);

do $$
begin
  update inventory_movements set reason = 'tamper'
  where id = '97130000-0000-0000-0000-000000000001';
  raise exception 'expected immutable inventory rejection';
exception when sqlstate '42501' then
  if sqlerrm not like '%permission denied%' then raise; end if;
end
$$;
reset role;
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  update inventory_movements set reason = 'trusted tamper'
  where id = '97130000-0000-0000-0000-000000000001';
  raise exception 'expected immutable inventory trigger rejection';
exception when sqlstate '42501' then
  if sqlerrm not like '%inventory_movements_are_immutable%' then raise; end if;
end
$$;
select set_config('request.jwt.claim.sub', '92000000-0000-0000-0000-000000000001', true);
set local role authenticated;

-- Savings snapshot respects minimum quantities and survives later price changes.
select pg_temp.roadmap_assert(
  save_purchase_request_draft(
    '97200000-0000-0000-0000-000000000001', null, current_date + 3, 2::smallint,
    '[
      {"product_id":"94000000-0000-0000-0000-000000000003","qty":5,"chosen_supplier_id":null},
      {"product_id":"94000000-0000-0000-0000-000000000004","qty":5,"chosen_supplier_id":null}
    ]'::jsonb
  )->>'request_id' = '97200000-0000-0000-0000-000000000001',
  'purchase draft was not saved'
);
select pg_temp.roadmap_assert(
  (select chosen_supplier_id = '93000000-0000-0000-0000-000000000001'
   from purchase_request_items
   where request_id = '97200000-0000-0000-0000-000000000001'
     and product_id = '94000000-0000-0000-0000-000000000003'),
  'minimum quantity was ignored by recommendation'
);
reset role;
select set_config('request.jwt.claim.sub', '', true);
update supplier_products set current_price = 8
where id = '95000000-0000-0000-0000-000000000004';
select set_config('request.jwt.claim.sub', '92000000-0000-0000-0000-000000000001', true);
set local role authenticated;
do $$
begin
  perform finalize_purchase_request_draft(
    '97200000-0000-0000-0000-000000000001', 125, 'stale automatic recommendation'
  );
  raise exception 'expected newly cheaper competitor rejection';
exception when sqlstate 'P0001' then
  if sqlerrm not like '%draft_price_changed%' then raise; end if;
end
$$;
select pg_temp.roadmap_assert(
  not exists (select 1 from purchase_orders
              where request_id = '97200000-0000-0000-0000-000000000001'),
  'stale recommendation created purchase orders'
);
reset role;
select set_config('request.jwt.claim.sub', '', true);
update supplier_products set current_price = 35
where id = '95000000-0000-0000-0000-000000000004';
update supplier_products set available = true
where id = '95000000-0000-0000-0000-000000000010';
select set_config('request.jwt.claim.sub', '92000000-0000-0000-0000-000000000001', true);
set local role authenticated;
do $$
begin
  perform finalize_purchase_request_draft(
    '97200000-0000-0000-0000-000000000001', 125, 'newly available cheaper competitor'
  );
  raise exception 'expected newly available competitor rejection';
exception when sqlstate 'P0001' then
  if sqlerrm not like '%draft_price_changed%' then raise; end if;
end
$$;
select pg_temp.roadmap_assert(
  not exists (select 1 from purchase_orders
              where request_id = '97200000-0000-0000-0000-000000000001'),
  'availability race created purchase orders from a stale recommendation'
);
reset role;
select set_config('request.jwt.claim.sub', '', true);
update supplier_products set available = false
where id = '95000000-0000-0000-0000-000000000010';
select set_config('request.jwt.claim.sub', '92000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select pg_temp.roadmap_assert(
  finalize_purchase_request_draft(
    '97200000-0000-0000-0000-000000000001', 125, 'finalize savings snapshot'
  )->>'savings_amount' = '25.00',
  'finalize did not return the savings snapshot'
);
select pg_temp.roadmap_assert(
  (select split_total = 125 and single_supplier_total = 150
      and single_supplier_id = '93000000-0000-0000-0000-000000000001'
      and savings_amount = 25 and savings_percent = 16.7
      and pricing_snapshot_at is not null
   from purchase_requests where id = '97200000-0000-0000-0000-000000000001'),
  'purchase request savings snapshot is incorrect'
);

reset role;
select set_config('request.jwt.claim.sub', '', true);
update supplier_products set current_price = 50
where id = '95000000-0000-0000-0000-000000000003';
select pg_temp.roadmap_assert(
  (select split_total = 125 and single_supplier_total = 150 and savings_amount = 25
   from purchase_requests where id = '97200000-0000-0000-0000-000000000001'),
  'later price update changed historic savings evidence'
);

-- Ready orders are open but do not count as supplier lateness until they are sent.
insert into purchase_orders (
  id, org_id, supplier_id, status, expected_date, created_by, sent_at
) values
  ('97300000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000003', 'ready', current_date - 1, '92000000-0000-0000-0000-000000000001', null),
  ('97300000-0000-0000-0000-000000000002', '91000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000003', 'sent', current_date - 1, '92000000-0000-0000-0000-000000000001', now() - interval '2 days'),
  ('97300000-0000-0000-0000-000000000003', '91000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000003', 'ready', current_date - 1, '92000000-0000-0000-0000-000000000001', null),
  ('97300000-0000-0000-0000-000000000004', '91000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000003', 'ready', current_date - 1, '92000000-0000-0000-0000-000000000001', null),
  ('97300000-0000-0000-0000-000000000005', '91000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000003', 'received', current_date - 2, '92000000-0000-0000-0000-000000000001', now() - interval '5 days');
insert into purchase_order_items (id, org_id, order_id, product_id, qty, unit_price) values
  ('97310000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000001', '97300000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000001', 1, 11),
  ('97310000-0000-0000-0000-000000000002', '91000000-0000-0000-0000-000000000001', '97300000-0000-0000-0000-000000000002', '94000000-0000-0000-0000-000000000001', 1, 11),
  ('97310000-0000-0000-0000-000000000003', '91000000-0000-0000-0000-000000000001', '97300000-0000-0000-0000-000000000003', '94000000-0000-0000-0000-000000000001', 1, 11),
  ('97310000-0000-0000-0000-000000000004', '91000000-0000-0000-0000-000000000001', '97300000-0000-0000-0000-000000000004', '94000000-0000-0000-0000-000000000001', 1, 11),
  ('97310000-0000-0000-0000-000000000005', '91000000-0000-0000-0000-000000000001', '97300000-0000-0000-0000-000000000005', '94000000-0000-0000-0000-000000000001', 2, 11);
insert into goods_receipts (
  id, org_id, order_id, status, received_by, received_at, notes
) values
  ('97320000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000001', '97300000-0000-0000-0000-000000000005', 'completed', '92000000-0000-0000-0000-000000000001', (current_date - 3) + time '12:00', 'partial shipment'),
  ('97320000-0000-0000-0000-000000000002', '91000000-0000-0000-0000-000000000001', '97300000-0000-0000-0000-000000000005', 'completed', '92000000-0000-0000-0000-000000000001', (current_date - 1) + time '12:00', 'final shipment');

select set_config('request.jwt.claim.sub', '92000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select pg_temp.roadmap_assert(
  (select open_orders = 4 and late_open_orders = 1
      and otd_samples = 1 and otd_on_time = 1 and on_time_pct = 100
      and avg_lead_days = 2 and price_changes_window = 0
   from supplier_metrics where supplier_id = '93000000-0000-0000-0000-000000000003'),
  'supplier open/late order metrics are incorrect'
);

-- WhatsApp: Vault-only provider token, idempotent send, webhook dedupe and one logical reminder.
reset role;
select set_config('request.jwt.claim.sub', '', true);
select pg_temp.roadmap_assert(
  (select count(*) = 1
   from cron.job
   where jobname = 'supplyflow-whatsapp-confirmation-reminders'
     and schedule = '*/15 * * * *'
     and command = 'select private.dispatch_whatsapp_confirmation_reminders();'
     and active),
  'WhatsApp reminder scheduler is missing, duplicated or misconfigured'
);
select pg_temp.roadmap_assert(
  private.dispatch_whatsapp_confirmation_reminders() is null,
  'unconfigured WhatsApp reminder scheduler was not a quiet no-op'
);
insert into roadmap_values (key, value)
select 'cron_secret_id', vault.create_secret(
  'roadmap-cron-secret-value', 'roadmap-whatsapp-cron-secret', 'roadmap scheduler test secret'
)::text;
insert into private.whatsapp_reminder_config (id, edge_url, cron_secret_id)
values (
  true,
  'https://roadmap.supabase.co/functions/v1/whatsapp',
  (select value::uuid from roadmap_values where key = 'cron_secret_id')
);
insert into roadmap_values (key, value)
select 'vault_secret_id', vault.create_secret(
  'roadmap-provider-access-token', 'roadmap-whatsapp-token', 'roadmap test token'
)::text;
select configure_whatsapp_connection(
  '91000000-0000-0000-0000-000000000001', 'roadmap-phone-id', 'roadmap-waba-id',
  '+972500000000', (select value::uuid from roadmap_values where key = 'vault_secret_id'),
  'supplyflow_order', 'supplyflow_order_reminder', 'he', 'active', 'roadmap test configuration'
);
select set_config('request.jwt.claim.sub', '92000000-0000-0000-0000-000000000001', true);
set local role authenticated;
insert into roadmap_values (key, value)
select 'whatsapp_toggle_disabled',
       set_whatsapp_connection_enabled(false, 'roadmap owner disables automatic channel')::text;
select pg_temp.roadmap_assert(
  (select value::jsonb->>'status' = 'disabled' from roadmap_values
   where key = 'whatsapp_toggle_disabled'),
  'owner could not disable the WhatsApp connection'
);
insert into roadmap_values (key, value)
select 'whatsapp_toggle_active',
       set_whatsapp_connection_enabled(true, 'roadmap owner enables automatic channel')::text;
select pg_temp.roadmap_assert(
  (select value::jsonb->>'status' = 'active' from roadmap_values
   where key = 'whatsapp_toggle_active'),
  'owner could not enable the WhatsApp connection'
);
reset role;
select set_config('request.jwt.claim.sub', '', true);
select pg_temp.roadmap_assert(
  get_whatsapp_connection('91000000-0000-0000-0000-000000000001', null)->>'access_token'
    = 'roadmap-provider-access-token',
  'service connection lookup did not decrypt the Vault token'
);
select pg_temp.roadmap_assert(
  not has_function_privilege(
    'authenticated',
    'get_whatsapp_connection(uuid,text)',
    'EXECUTE'
  ) and not has_function_privilege(
    'authenticated',
    'mark_whatsapp_message_ambiguous(uuid,text,text,text)',
    'EXECUTE'
  ) and not has_function_privilege(
    'authenticated',
    'private.dispatch_whatsapp_confirmation_reminders()',
    'EXECUTE'
  ) and not has_schema_privilege('authenticated', 'private', 'USAGE')
    and not has_table_privilege('authenticated', 'private.whatsapp_reminder_config', 'SELECT')
    and not has_table_privilege('authenticated', 'vault.secrets', 'SELECT')
    and not has_table_privilege('authenticated', 'vault.decrypted_secrets', 'SELECT')
    and not has_table_privilege('authenticated', 'whatsapp_connections', 'SELECT')
    and not has_function_privilege(
      'authenticated',
      'process_whatsapp_webhook_event(text,text,text,text,whatsapp_message_status,text,text,timestamptz)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated', 'begin_whatsapp_reminder_send(uuid)', 'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'process_whatsapp_webhook_event(text,text,text,text,whatsapp_message_status,text,text,timestamptz)',
      'EXECUTE'
    )
    and to_regprocedure('claim_whatsapp_webhook_event(text,text,text,text)') is null
    and to_regprocedure('confirm_whatsapp_order(text,text,timestamptz)') is null,
  'browser role can access WhatsApp connection secrets'
);

select set_config('request.jwt.claim.sub', '92000000-0000-0000-0000-000000000005', true);
set local role authenticated;
select pg_temp.roadmap_assert(
  get_whatsapp_connection_status()->>'status' = 'active',
  'kitchen cannot read the nonsecret WhatsApp action gate'
);
reset role;
select set_config('request.jwt.claim.sub', '', true);
insert into suppliers (id, org_id, name, whatsapp) values
  ('93000000-0000-0000-0000-000000000006', '91000000-0000-0000-0000-000000000001', 'Supplier without WhatsApp', null),
  ('93000000-0000-0000-0000-000000000007', '91000000-0000-0000-0000-000000000001', 'Supplier deleted before reminder', null);
insert into purchase_orders (id, org_id, supplier_id, status, created_by) values
  ('97300000-0000-0000-0000-000000000006', '91000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000006', 'ready', '92000000-0000-0000-0000-000000000001'),
  ('97300000-0000-0000-0000-000000000007', '91000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000003', 'ready', '92000000-0000-0000-0000-000000000001'),
  ('97300000-0000-0000-0000-000000000008', '91000000-0000-0000-0000-000000000002', '93000000-0000-0000-0000-000000000004', 'ready', '92000000-0000-0000-0000-000000000004'),
  ('97300000-0000-0000-0000-000000000009', '91000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000007', 'sent', '92000000-0000-0000-0000-000000000001');

select set_config('request.jwt.claim.sub', '92000000-0000-0000-0000-000000000001', true);
set local role authenticated;
do $$
begin
  perform transition_purchase_order_status(
    '97300000-0000-0000-0000-000000000001', 'sent',
    'verify automatic WhatsApp guard', null, null
  );
  raise exception 'expected automatic-channel sent guard';
exception when sqlstate '42501' then
  if sqlerrm not like '%whatsapp_sent_requires_meta_acceptance%' then raise; end if;
end
$$;
reset role;
select set_config('request.jwt.claim.sub', '', true);
update purchase_orders set status = 'draft'
where id = '97300000-0000-0000-0000-000000000001';
select set_config('request.jwt.claim.sub', '92000000-0000-0000-0000-000000000001', true);
set local role authenticated;
do $$
begin
  perform transition_purchase_order_status(
    '97300000-0000-0000-0000-000000000001', 'sent',
    'verify indirect automatic WhatsApp guard', null, null
  );
  raise exception 'expected indirect automatic-channel sent guard';
exception when sqlstate '42501' then
  if sqlerrm not like '%whatsapp_sent_requires_meta_acceptance%' then raise; end if;
end
$$;
reset role;
select set_config('request.jwt.claim.sub', '', true);
update purchase_orders set status = 'ready'
where id = '97300000-0000-0000-0000-000000000001';
select set_config('request.jwt.claim.sub', '92000000-0000-0000-0000-000000000001', true);
set local role authenticated;
do $$
begin
  insert into purchase_orders (
    id, org_id, supplier_id, status, created_by
  ) values (
    '97300000-0000-0000-0000-000000000010',
    '91000000-0000-0000-0000-000000000001',
    '93000000-0000-0000-0000-000000000003',
    'sent', '92000000-0000-0000-0000-000000000001'
  );
  raise exception 'expected inserted automatic-channel sent guard';
exception when sqlstate '42501' then
  if sqlerrm not like '%whatsapp_sent_requires_meta_acceptance%'
     and sqlerrm not like '%permission denied for table purchase_orders%' then raise; end if;
end
$$;
select pg_temp.roadmap_assert(
  not exists (
    select 1 from purchase_orders
    where id = '97300000-0000-0000-0000-000000000010'
  ),
  'automatic-channel order was inserted directly as sent'
);
select transition_purchase_order_status(
  '97300000-0000-0000-0000-000000000006', 'sent',
  'manual fallback without supplier WhatsApp', null, null
);
select pg_temp.roadmap_assert(
  (select status = 'sent' from purchase_orders
   where id = '97300000-0000-0000-0000-000000000006'),
  'manual fallback was blocked for a supplier without a valid WhatsApp number'
);
reset role;
select set_config('request.jwt.claim.sub', '92000000-0000-0000-0000-000000000004', true);
set local role authenticated;
select transition_purchase_order_status(
  '97300000-0000-0000-0000-000000000008', 'sent',
  'manual fallback without tenant connection', null, null
);
select pg_temp.roadmap_assert(
  (select status = 'sent' from purchase_orders
   where id = '97300000-0000-0000-0000-000000000008'),
  'manual transition was blocked for a tenant without an active WhatsApp connection'
);
reset role;
select set_config('request.jwt.claim.sub', '92000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select claim_whatsapp_order_message(
  '97300000-0000-0000-0000-000000000007', 'prepare definitive failure fallback'
);
reset role;
select set_config('request.jwt.claim.sub', '', true);
select fail_whatsapp_order_message(
  (select id from whatsapp_order_messages
   where order_id = '97300000-0000-0000-0000-000000000007' and kind = 'order'),
  'provider_rejected', 'definitive provider rejection'
);
select set_config('request.jwt.claim.sub', '92000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select transition_purchase_order_status(
  '97300000-0000-0000-0000-000000000007', 'sent',
  'manual fallback after provider failure', null, null
);
select pg_temp.roadmap_assert(
  (select status = 'sent' from purchase_orders
   where id = '97300000-0000-0000-0000-000000000007'),
  'manual fallback was blocked after a definitive WhatsApp failure'
);

insert into roadmap_values (key, value)
select 'order_token', claim_whatsapp_order_message(
  '97300000-0000-0000-0000-000000000001', 'send purchase order'
)->>'confirmation_token';
select pg_temp.roadmap_assert(
  claim_whatsapp_order_message(
    '97300000-0000-0000-0000-000000000001', 'send retry'
  )->>'confirmation_token' is null
  and claim_whatsapp_order_message(
    '97300000-0000-0000-0000-000000000001', 'inspect active send'
  )->>'delivery_status' = 'sending'
  and (select status = 'ready' from purchase_orders
       where id = '97300000-0000-0000-0000-000000000001'),
  'active message lease exposed a second confirmation token'
);
select pg_temp.roadmap_assert(
  (select recipient_number = '972503333333'
   from whatsapp_order_messages
   where order_id = '97300000-0000-0000-0000-000000000001' and kind = 'order')
  and claim_whatsapp_order_message(
    '97300000-0000-0000-0000-000000000001', 'inspect recipient snapshot'
  )->>'recipient_number' = '972503333333',
  'order claim did not persist and return a canonical recipient snapshot'
);

reset role;
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  update whatsapp_order_messages set recipient_number = '972509999999'
  where order_id = '97300000-0000-0000-0000-000000000001' and kind = 'order';
  raise exception 'expected immutable recipient snapshot';
exception when sqlstate '42501' then
  if sqlerrm not like '%whatsapp_recipient_snapshot_immutable%' then raise; end if;
end
$$;
select pg_temp.roadmap_assert(
  (select recipient_number = '972503333333'
   from whatsapp_order_messages
   where order_id = '97300000-0000-0000-0000-000000000001' and kind = 'order'),
  'recipient snapshot changed after the outbox row was created'
);
select mark_whatsapp_message_ambiguous(
  (select id from whatsapp_order_messages
   where order_id = '97300000-0000-0000-0000-000000000001' and kind = 'order'),
  'transport_timeout', 'ambiguous provider response', 'wamid-roadmap-order-1'
);
select set_config('request.jwt.claim.sub', '92000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select pg_temp.roadmap_assert(
  claim_whatsapp_order_message(
    '97300000-0000-0000-0000-000000000001', 'inspect ambiguous send'
  )->>'delivery_status' = 'unknown'
  and not (claim_whatsapp_order_message(
    '97300000-0000-0000-0000-000000000001', 'do not resend ambiguous send'
  )->>'should_send')::boolean
  and (select status = 'ready' from purchase_orders
       where id = '97300000-0000-0000-0000-000000000001'),
  'ambiguous transport was reclaimed or marked the order sent'
);
reset role;
select set_config('request.jwt.claim.sub', '', true);
update suppliers set whatsapp = '+972509999999'
where id = '93000000-0000-0000-0000-000000000003';
do $$
begin
  perform process_whatsapp_webhook_event(
    'roadmap-phone-id', 'event-transient', 'status.delivered',
    'wamid-not-persisted-yet', 'delivered', null, null, now()
  );
  raise exception 'expected transient webhook transition failure';
exception when sqlstate 'P0002' then
  if sqlerrm not like '%whatsapp_message_unknown%' then raise; end if;
end
$$;
select pg_temp.roadmap_assert(
  not exists (
    select 1 from whatsapp_webhook_events
    where phone_number_id = 'roadmap-phone-id' and event_id = 'event-transient'
  ),
  'failed webhook transition consumed its dedupe event'
);
select pg_temp.roadmap_assert(
  (process_whatsapp_webhook_event(
    'roadmap-phone-id', 'event-status-delivered', 'status.delivered',
    'wamid-roadmap-order-1', 'delivered', null, null, now()
  )->>'processed')::boolean,
  'atomic provider status event was not processed'
);
select pg_temp.roadmap_assert(
  not (process_whatsapp_webhook_event(
    'roadmap-phone-id', 'event-status-delivered', 'status.delivered',
    'wamid-roadmap-order-1', 'delivered', null, null, now()
  )->>'processed')::boolean
  and (process_whatsapp_webhook_event(
    'roadmap-phone-id', 'event-status-delivered', 'status.delivered',
    'wamid-roadmap-order-1', 'delivered', null, null, now()
  )->>'duplicate')::boolean
  and (select count(*) = 1 from whatsapp_webhook_events
       where phone_number_id = 'roadmap-phone-id' and event_id = 'event-status-delivered'),
  'atomic webhook event deduplication failed'
);
select pg_temp.roadmap_assert(
  (process_whatsapp_webhook_event(
    'roadmap-phone-id', 'event-status-delivered', 'status.delivered',
    'wamid-roadmap-order-1', 'delivered', null, null, now() + interval '1 hour'
  )->>'duplicate')::boolean,
  'receipt-time fallback made an otherwise identical webhook retry conflict'
);
select pg_temp.roadmap_assert(
  (select status = 'sent' and sent_at is not null
   from purchase_orders where id = '97300000-0000-0000-0000-000000000001'),
  'signed provider delivery did not mark an ambiguous order sent'
);
select process_whatsapp_webhook_event(
  'roadmap-phone-id', 'event-status-sent-late', 'status.sent',
  'wamid-roadmap-order-1', 'sent', null, null, now() + interval '1 second'
);
select pg_temp.roadmap_assert(
  (select status = 'delivered' from whatsapp_order_messages
   where meta_message_id = 'wamid-roadmap-order-1'),
  'provider status regressed from delivered to sent'
);
select pg_temp.roadmap_assert(
  fail_whatsapp_order_message(
    (select id from whatsapp_order_messages where meta_message_id = 'wamid-roadmap-order-1'),
    'late_failure', 'late failure must not regress delivery'
  )->>'status' = 'delivered',
  'failure callback regressed a delivered message'
);
select pg_temp.roadmap_assert(
  not (process_whatsapp_webhook_event(
    'roadmap-phone-id', 'event-confirm-current-number', 'order.confirmation',
    'wamid-roadmap-order-1', null, '972509999999',
    (select value from roadmap_values where key = 'order_token'), now()
  )->>'accepted')::boolean
  and process_whatsapp_webhook_event(
    'roadmap-phone-id', 'event-confirm-current-number', 'order.confirmation',
    'wamid-roadmap-order-1', null, '972509999999',
    (select value from roadmap_values where key = 'order_token'), now()
  )->'result'->>'reason' = 'sender_mismatch',
  'confirmation trusted the supplier current number instead of the send snapshot'
);
do $$
begin
  perform process_whatsapp_webhook_event(
    'roadmap-phone-id', 'event-confirm-current-number', 'order.confirmation',
    'wamid-roadmap-order-1', null, '972503333333',
    (select value from roadmap_values where key = 'order_token'), now()
  );
  raise exception 'expected webhook payload conflict';
exception when sqlstate 'P0001' then
  if sqlerrm not like '%whatsapp_webhook_event_conflict%' then raise; end if;
end
$$;
select pg_temp.roadmap_assert(
  (select payload_fingerprint ~ '^[0-9a-f]{64}$'
          and payload_fingerprint <> (select value from roadmap_values where key = 'order_token')
          and result->>'reason' = 'sender_mismatch'
   from whatsapp_webhook_events
   where phone_number_id = 'roadmap-phone-id'
     and event_id = 'event-confirm-current-number'),
  'webhook dedupe was not bound to a nonsecret payload fingerprint'
);
select pg_temp.roadmap_assert(
  not (process_whatsapp_webhook_event(
    'roadmap-phone-id', 'event-confirm-wrong-context', 'order.confirmation',
    'wamid-wrong-context', null, '972503333333',
    (select value from roadmap_values where key = 'order_token'), now()
  )->>'accepted')::boolean
  and process_whatsapp_webhook_event(
    'roadmap-phone-id', 'event-confirm-wrong-context', 'order.confirmation',
    'wamid-wrong-context', null, '972503333333',
    (select value from roadmap_values where key = 'order_token'), now()
  )->'result'->>'reason' = 'context_mismatch',
  'confirmation accepted a token outside its outbound message context'
);
insert into roadmap_values (key, value)
select 'confirm_original_result', process_whatsapp_webhook_event(
    'roadmap-phone-id', 'event-confirm-original-number', 'order.confirmation',
    'wamid-roadmap-order-1', null, '+972 50-333-3333',
    (select value from roadmap_values where key = 'order_token'), now()
  )::text;
select pg_temp.roadmap_assert(
  ((select value::jsonb from roadmap_values
    where key = 'confirm_original_result')->>'accepted')::boolean
  and (select status = 'confirmed' from purchase_orders
       where id = '97300000-0000-0000-0000-000000000001'),
  'original recipient could not confirm after the supplier phone changed'
);
select pg_temp.roadmap_assert(
  (process_whatsapp_webhook_event(
    'roadmap-phone-id', 'event-confirm-original-number', 'order.confirmation',
    'wamid-roadmap-order-1', null, '+972 50-333-3333',
    (select value from roadmap_values where key = 'order_token'), now()
  )->>'duplicate')::boolean,
  'confirmed webhook retry was not recognized as a duplicate'
);

select set_config('request.jwt.claim.sub', '92000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select claim_whatsapp_order_message(
  '97300000-0000-0000-0000-000000000004', 'send with simulated lost response'
);
reset role;
select set_config('request.jwt.claim.sub', '', true);
update whatsapp_order_messages set lease_expires_at = now() - interval '1 minute'
where order_id = '97300000-0000-0000-0000-000000000004' and kind = 'order';
select set_config('request.jwt.claim.sub', '92000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select pg_temp.roadmap_assert(
  claim_whatsapp_order_message(
    '97300000-0000-0000-0000-000000000004', 'inspect expired ambiguous send'
  )->>'delivery_status' = 'unknown'
  and not (claim_whatsapp_order_message(
    '97300000-0000-0000-0000-000000000004', 'do not reclaim expired send'
  )->>'should_send')::boolean,
  'expired in-flight order was blindly retried'
);
select claim_whatsapp_order_message(
  '97300000-0000-0000-0000-000000000003', 'send order requiring reminder'
);
reset role;
select set_config('request.jwt.claim.sub', '', true);
select complete_whatsapp_order_message(
  (select id from whatsapp_order_messages
   where order_id = '97300000-0000-0000-0000-000000000003' and kind = 'order'),
  'wamid-roadmap-order-2'
);
update whatsapp_order_messages
set accepted_at = now() - interval '25 hours'
where order_id = '97300000-0000-0000-0000-000000000003' and kind = 'order';
select pg_temp.roadmap_assert(
  jsonb_array_length(claim_whatsapp_confirmation_reminders(10)) = 1,
  '24-hour reminder was not queued and claimed'
);
select pg_temp.roadmap_assert(
  jsonb_array_length(claim_whatsapp_confirmation_reminders(10)) = 0
  and (select count(*) = 1 from whatsapp_order_messages
       where order_id = '97300000-0000-0000-0000-000000000003' and kind = 'reminder')
  and (select status = 'queued' and attempt_count = 0 and confirm_token_hash is null
       from whatsapp_order_messages
       where order_id = '97300000-0000-0000-0000-000000000003' and kind = 'reminder'),
  'reminder was duplicated while its lease was active'
);
update whatsapp_order_messages set lease_expires_at = now() - interval '1 minute'
where order_id = '97300000-0000-0000-0000-000000000003' and kind = 'reminder';
select pg_temp.roadmap_assert(
  jsonb_array_length(claim_whatsapp_confirmation_reminders(10)) = 1
  and (select count(*) = 1 from whatsapp_order_messages
       where order_id = '97300000-0000-0000-0000-000000000003' and kind = 'reminder')
  and (select status = 'queued' and attempt_count = 0 and confirm_token_hash is null
       from whatsapp_order_messages
       where order_id = '97300000-0000-0000-0000-000000000003' and kind = 'reminder'),
  'pre-provider reminder claim was not safely reclaimed after a worker crash'
);
insert into roadmap_values (key, value)
select 'reminder_begin', begin_whatsapp_reminder_send(
  (select id from whatsapp_order_messages
   where order_id = '97300000-0000-0000-0000-000000000003' and kind = 'reminder')
)::text;
select pg_temp.roadmap_assert(
  ((select value::jsonb from roadmap_values where key = 'reminder_begin')->>'should_send')::boolean
  and (select value::jsonb from roadmap_values where key = 'reminder_begin')->>'recipient_number'
      = '972509999999'
  and (select status = 'sending' and attempt_count = 1 and confirm_token_hash is not null
       from whatsapp_order_messages
       where order_id = '97300000-0000-0000-0000-000000000003' and kind = 'reminder')
  and not (begin_whatsapp_reminder_send(
    (select id from whatsapp_order_messages
     where order_id = '97300000-0000-0000-0000-000000000003' and kind = 'reminder')
  )->>'should_send')::boolean,
  'reminder begin-send did not create exactly one provider attempt'
);
select fail_whatsapp_order_message(
  (select id from whatsapp_order_messages
   where order_id = '97300000-0000-0000-0000-000000000003' and kind = 'reminder'),
  'test_failure', 'definitive reminder failure'
);
select pg_temp.roadmap_assert(
  jsonb_array_length(claim_whatsapp_confirmation_reminders(10)) = 0
  and (select count(*) = 1 from whatsapp_order_messages
       where order_id = '97300000-0000-0000-0000-000000000003'
         and kind = 'reminder' and status = 'failed' and attempt_count = 1),
  'failed reminder was reclaimed automatically'
);
select complete_whatsapp_order_message(
  (select id from whatsapp_order_messages
   where order_id = '97300000-0000-0000-0000-000000000003' and kind = 'reminder'),
  'wamid-roadmap-reminder-1'
);
select pg_temp.roadmap_assert(
  jsonb_array_length(claim_whatsapp_confirmation_reminders(10)) = 0
  and (select count(*) = 1 from whatsapp_order_messages
       where order_id = '97300000-0000-0000-0000-000000000003'
         and kind = 'reminder' and status = 'accepted'),
  'accepted reminder was reclaimed or duplicated'
);

-- A provider-started reminder is never blindly retried after its lease expires.
insert into whatsapp_order_messages (
  id, org_id, order_id, kind, status, recipient_number, confirm_token_hash,
  attempt_count, lease_expires_at, created_by
) values (
  '97800000-0000-0000-0000-000000000001',
  '91000000-0000-0000-0000-000000000001',
  '97300000-0000-0000-0000-000000000002',
  'reminder', 'queued', '972503333333', null, 0, now() + interval '5 minutes',
  '92000000-0000-0000-0000-000000000001'
);
select pg_temp.roadmap_assert(
  (begin_whatsapp_reminder_send('97800000-0000-0000-0000-000000000001')->>'should_send')::boolean,
  'queued reminder did not enter provider-started state'
);
update whatsapp_order_messages set lease_expires_at = now() - interval '1 minute'
where id = '97800000-0000-0000-0000-000000000001';
insert into roadmap_values (key, value)
select 'expired_sending_claim', claim_whatsapp_confirmation_reminders(10)::text;
select pg_temp.roadmap_assert(
  jsonb_array_length((select value::jsonb from roadmap_values
                      where key = 'expired_sending_claim')) = 0
  and (select status = 'unknown' and attempt_count = 1
       from whatsapp_order_messages where id = '97800000-0000-0000-0000-000000000001'),
  'expired provider-started reminder was reclaimed instead of frozen for review'
);
select pg_temp.roadmap_assert(
  exists (
    select 1 from audit_logs
    where action = 'whatsapp_reminder_ambiguous'
      and entity_id = '97800000-0000-0000-0000-000000000001'
      and reason is not null
  ),
  'expired provider-started reminder did not leave an audit trail'
);

-- The same expiration is fail-closed when a stale worker reaches begin-send.
insert into whatsapp_order_messages (
  id, org_id, order_id, kind, status, recipient_number, confirm_token_hash,
  attempt_count, lease_expires_at, created_by
) values (
  '97800000-0000-0000-0000-000000000005',
  '91000000-0000-0000-0000-000000000002',
  '97300000-0000-0000-0000-000000000008',
  'reminder', 'sending', '972504444444', repeat('a', 64), 1,
  now() - interval '1 minute', '92000000-0000-0000-0000-000000000004'
);
insert into roadmap_values (key, value)
select 'expired_sending_begin',
       begin_whatsapp_reminder_send('97800000-0000-0000-0000-000000000005')::text;
select pg_temp.roadmap_assert(
  not ((select value::jsonb from roadmap_values
        where key = 'expired_sending_begin')->>'should_send')::boolean
  and (select status = 'unknown' and error_code = 'reminder_send_lease_expired'
       from whatsapp_order_messages where id = '97800000-0000-0000-0000-000000000005')
  and exists (
    select 1 from audit_logs
    where action = 'whatsapp_reminder_ambiguous'
      and entity_id = '97800000-0000-0000-0000-000000000005'
  ),
  'expired provider-started reminder was reclaimed instead of frozen for review'
);

-- A supplier deleted after queueing is a definitive no-send, not an endless 5xx retry.
insert into whatsapp_order_messages (
  id, org_id, order_id, kind, status, recipient_number, confirm_token_hash,
  attempt_count, lease_expires_at, created_by
) values (
  '97800000-0000-0000-0000-000000000002',
  '91000000-0000-0000-0000-000000000001',
  '97300000-0000-0000-0000-000000000009',
  'reminder', 'queued', '972506666666', null, 0, now() + interval '5 minutes',
  '92000000-0000-0000-0000-000000000001'
);
update suppliers set deleted_at = now()
where id = '93000000-0000-0000-0000-000000000007';
insert into roadmap_values (key, value)
select 'deleted_supplier_begin',
       begin_whatsapp_reminder_send('97800000-0000-0000-0000-000000000002')::text;
select pg_temp.roadmap_assert(
  not ((select value::jsonb from roadmap_values
        where key = 'deleted_supplier_begin')->>'should_send')::boolean
  and (select value::jsonb from roadmap_values
       where key = 'deleted_supplier_begin')->>'reason' = 'supplier_unavailable'
  and (select status = 'failed' and attempt_count = 0 and failed_at is not null
              and error_code = 'supplier_unavailable'
       from whatsapp_order_messages where id = '97800000-0000-0000-0000-000000000002'),
  'deleted supplier reminder was sent or left in an infinite retry state'
);
select pg_temp.roadmap_assert(
  exists (
    select 1 from audit_logs
    where action = 'whatsapp_reminder_not_sent'
      and entity_id = '97800000-0000-0000-0000-000000000002'
      and new_values->>'error_code' = 'supplier_unavailable'
      and reason is not null
  ),
  'deleted supplier no-send did not leave an audit trail'
);

-- A queued reminder whose order stopped waiting is terminal before provider start.
insert into whatsapp_order_messages (
  id, org_id, order_id, kind, status, recipient_number, confirm_token_hash,
  attempt_count, lease_expires_at, created_by
) values (
  '97800000-0000-0000-0000-000000000004',
  '91000000-0000-0000-0000-000000000001',
  '97300000-0000-0000-0000-000000000001',
  'reminder', 'queued', '972503333333', null, 0, now() + interval '5 minutes',
  '92000000-0000-0000-0000-000000000001'
);
insert into roadmap_values (key, value)
select 'nonpending_order_begin',
       begin_whatsapp_reminder_send('97800000-0000-0000-0000-000000000004')::text;
select pg_temp.roadmap_assert(
  not ((select value::jsonb from roadmap_values
        where key = 'nonpending_order_begin')->>'should_send')::boolean
  and (select value::jsonb from roadmap_values
       where key = 'nonpending_order_begin')->>'reason' = 'order_no_longer_pending'
  and (select status = 'failed' and attempt_count = 0 and failed_at is not null
              and error_code = 'order_no_longer_pending'
       from whatsapp_order_messages where id = '97800000-0000-0000-0000-000000000004')
  and exists (
    select 1 from audit_logs
    where action = 'whatsapp_reminder_not_sent'
      and entity_id = '97800000-0000-0000-0000-000000000004'
      and new_values->>'error_code' = 'order_no_longer_pending'
  ),
  'nonpending order reminder was sent or left without an auditable terminal state'
);
do $$
begin
  insert into whatsapp_order_messages (
    id, org_id, order_id, kind, status, recipient_number, confirm_token_hash,
    attempt_count, lease_expires_at, created_by
  ) values (
    '97800000-0000-0000-0000-000000000003',
    '91000000-0000-0000-0000-000000000001',
    '97300000-0000-0000-0000-000000000006',
    'reminder', 'sending', '972503333333', null, 1, now() + interval '5 minutes',
    '92000000-0000-0000-0000-000000000001'
  );
  raise exception 'expected provider-started reminder token constraint';
exception when check_violation then
  null;
end
$$;

select pg_temp.roadmap_assert(
  (select count(*) = 15
   from pg_publication_tables
   where pubname = 'supabase_realtime' and schemaname = 'public'
     and tablename = any(array[
       'purchase_requests', 'purchase_orders', 'invoices', 'payment_requests', 'payments',
       'exceptions', 'credit_requests', 'bank_transactions', 'supplier_products',
       'inventory_movements', 'documents', 'goods_receipts', 'monthly_exports',
       'supplier_price_submissions', 'whatsapp_order_messages'
     ])),
  'dashboard realtime publication is incomplete'
);

select 'roadmap_db_contracts: all assertions passed' as result;
rollback;
