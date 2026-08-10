-- P24 -- inventory intelligence preserves unknowns, tenant scope and read-only suggestions.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p24_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P24 inventory assertion failed: %', p_message;
  end if;
end
$$;

insert into public.organizations (id, name, status) values
  ('1a240000-0000-4000-8000-000000000001', 'P24 A', 'active'),
  ('1a240000-0000-4000-8000-000000000002', 'P24 B', 'active');
insert into auth.users (id, email) values
  ('2a240000-0000-4000-8000-000000000001', 'owner-a-p24@example.test'),
  ('2a240000-0000-4000-8000-000000000002', 'accountant-a-p24@example.test');
insert into public.profiles (id, org_id, full_name, role) values
  ('2a240000-0000-4000-8000-000000000001', '1a240000-0000-4000-8000-000000000001', 'P24 owner', 'owner'),
  ('2a240000-0000-4000-8000-000000000002', '1a240000-0000-4000-8000-000000000001', 'P24 accountant', 'accountant');
insert into public.products (id, org_id, name, unit, min_stock) values
  ('3a240000-0000-4000-8000-000000000001', '1a240000-0000-4000-8000-000000000001', 'P24 measured', 'kg', 5),
  ('3a240000-0000-4000-8000-000000000002', '1a240000-0000-4000-8000-000000000001', 'P24 unknown', 'unit', 5),
  ('3a240000-0000-4000-8000-000000000003', '1a240000-0000-4000-8000-000000000002', 'P24 other tenant', 'kg', 5);
insert into public.suppliers (id, org_id, name, status) values
  ('4a240000-0000-4000-8000-000000000001', '1a240000-0000-4000-8000-000000000001', 'P24 cheaper', 'active'),
  ('4a240000-0000-4000-8000-000000000002', '1a240000-0000-4000-8000-000000000001', 'P24 dearer', 'active');
insert into public.supplier_products (org_id, supplier_id, product_id, current_price) values
  ('1a240000-0000-4000-8000-000000000001', '4a240000-0000-4000-8000-000000000001', '3a240000-0000-4000-8000-000000000001', 10),
  ('1a240000-0000-4000-8000-000000000001', '4a240000-0000-4000-8000-000000000002', '3a240000-0000-4000-8000-000000000001', 12);

select set_config('request.jwt.claim.sub', '2a240000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select public.record_inventory_stocktake(
  '5a240000-0000-4000-8000-000000000001',
  '3a240000-0000-4000-8000-000000000001', 4, 'P24 opening count'
);
select public.record_inventory_movement(
  '5a240000-0000-4000-8000-000000000002',
  '3a240000-0000-4000-8000-000000000001', 'consumption', 1, false, 'P24 consumption'
);
reset role;

insert into public.purchase_orders (
  id, org_id, supplier_id, status, expected_date, created_by
) values
  ('6a240000-0000-4000-8000-000000000001',
   '1a240000-0000-4000-8000-000000000001',
   '4a240000-0000-4000-8000-000000000001', 'sent', current_date + 30,
   '2a240000-0000-4000-8000-000000000001'),
  ('6a240000-0000-4000-8000-000000000002',
   '1a240000-0000-4000-8000-000000000001',
   '4a240000-0000-4000-8000-000000000001', 'sent', null,
   '2a240000-0000-4000-8000-000000000001'),
  ('6a240000-0000-4000-8000-000000000003',
   '1a240000-0000-4000-8000-000000000001',
   '4a240000-0000-4000-8000-000000000001', 'draft', null,
   '2a240000-0000-4000-8000-000000000001');
insert into public.purchase_order_items (org_id, order_id, product_id, qty, received_qty, unit_price)
values
  ('1a240000-0000-4000-8000-000000000001',
   '6a240000-0000-4000-8000-000000000001',
   '3a240000-0000-4000-8000-000000000001', 5, 2, 11),
  ('1a240000-0000-4000-8000-000000000001',
   '6a240000-0000-4000-8000-000000000002',
   '3a240000-0000-4000-8000-000000000001', 4, 0, 11),
  ('1a240000-0000-4000-8000-000000000001',
   '6a240000-0000-4000-8000-000000000003',
   '3a240000-0000-4000-8000-000000000001', 1, 0, 99);

set local role authenticated;
select pg_temp.p24_assert(
  (select quantity_on_hand = 3
      and consumption_sample_count = 1
      and average_daily_consumption > 0
      and expected_incoming_quantity = 7
      and incoming_without_date_quantity = 4
      and next_expected_incoming_date = current_date + 30
      and projected_stockout_days = 3
      and suggested_reorder_quantity = 2
      and cheapest_supplier_name = 'P24 cheaper'
      and cheapest_unit_price = 10
      and price_advantage = 2
      and latest_purchase_unit_price = 11
   from public.inventory_intelligence
   where product_id = '3a240000-0000-4000-8000-000000000001'),
  'measured intelligence credited late/undated incoming supply before arrival or lost evidence');
select pg_temp.p24_assert(
  (select quantity_on_hand is null
      and average_daily_consumption is null
      and projected_stockout_days is null
      and suggested_reorder_quantity is null
   from public.inventory_intelligence
   where product_id = '3a240000-0000-4000-8000-000000000002'),
  'unknown inventory was converted into a numeric claim');
select pg_temp.p24_assert(
  not exists (
    select 1 from public.inventory_intelligence
    where product_id = '3a240000-0000-4000-8000-000000000003'
  ),
  'other-tenant inventory leaked');
reset role;

select set_config('request.jwt.claim.sub', '2a240000-0000-4000-8000-000000000002', true);
set local role authenticated;
select pg_temp.p24_assert(
  not exists (select 1 from public.inventory_intelligence),
  'accountant gained warehouse inventory access');
reset role;

rollback;
