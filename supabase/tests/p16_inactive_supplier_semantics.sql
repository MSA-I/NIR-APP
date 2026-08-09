-- P16 -- inactive supplier blocks new commerce while historical finance remains readable.
\set ON_ERROR_STOP on

begin;

insert into public.organizations (id, name, status)
values ('16000000-0000-4000-8000-000000000001', 'P16 tenant', 'active');
insert into auth.users (id, email)
values ('26000000-0000-4000-8000-000000000001', 'owner-p16@example.test');
insert into public.profiles (id, org_id, full_name, role)
values (
  '26000000-0000-4000-8000-000000000001',
  '16000000-0000-4000-8000-000000000001', 'P16 owner', 'owner'
);
insert into public.suppliers (id, org_id, name, status)
values (
  '36000000-0000-4000-8000-000000000001',
  '16000000-0000-4000-8000-000000000001', 'P16 inactive supplier', 'active'
);
insert into public.products (id, org_id, name, unit)
values (
  '46000000-0000-4000-8000-000000000001',
  '16000000-0000-4000-8000-000000000001', 'P16 product', 'unit'
);

-- Historical rows predate deactivation and must remain untouched/readable.
insert into public.purchase_orders (id, org_id, supplier_id, created_by)
values (
  '56000000-0000-4000-8000-000000000001',
  '16000000-0000-4000-8000-000000000001',
  '36000000-0000-4000-8000-000000000001',
  '26000000-0000-4000-8000-000000000001'
);
insert into public.supplier_products (
  id, org_id, supplier_id, product_id, current_price, price_effective_date
) values (
  '66000000-0000-4000-8000-000000000001',
  '16000000-0000-4000-8000-000000000001',
  '36000000-0000-4000-8000-000000000001',
  '46000000-0000-4000-8000-000000000001', 10, '2026-08-01'
);
update public.suppliers set status = 'inactive'
where id = '36000000-0000-4000-8000-000000000001';

do $$
begin
  insert into public.purchase_orders (org_id, supplier_id, created_by)
  values (
    '16000000-0000-4000-8000-000000000001',
    '36000000-0000-4000-8000-000000000001',
    '26000000-0000-4000-8000-000000000001'
  );
  raise exception 'expected inactive purchase-order rejection';
exception when sqlstate '55000' then
  if sqlerrm <> 'supplier_inactive_for_new_commerce' then raise; end if;
end
$$;

select set_config('request.jwt.claim.sub', '26000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
do $$
begin
  perform public.transition_purchase_order_status(
    '56000000-0000-4000-8000-000000000001', 'sent',
    'P16 stale draft send', null, null
  );
  raise exception 'expected inactive supplier order-send rejection';
exception when sqlstate '55000' then
  if sqlerrm <> 'supplier_inactive_for_new_commerce' then raise; end if;
end
$$;
do $$
begin
  perform public.reserve_supplier_price_document_upload(
    '36000000-0000-4000-8000-000000000001', 'inactive-prices.pdf', 'application/pdf'
  );
  raise exception 'expected inactive reservation rejection';
exception when sqlstate '55000' then
  if sqlerrm <> 'supplier_inactive_for_new_commerce' then raise; end if;
end
$$;
do $$
begin
  perform public.import_supplier_prices(
    jsonb_build_array(jsonb_build_object(
      'supplier_id', '36000000-0000-4000-8000-000000000001',
      'product_id', '46000000-0000-4000-8000-000000000001',
      'price', 99, 'available', true
    )),
    '2026-08-08', 'P16 stale client import'
  );
  raise exception 'expected inactive price import rejection';
exception when sqlstate '55000' then
  if sqlerrm <> 'supplier_inactive_for_new_commerce' then raise; end if;
end
$$;
reset role;

do $$
begin
  if not exists (
    select 1 from public.purchase_orders
    where id = '56000000-0000-4000-8000-000000000001'
      and supplier_id = '36000000-0000-4000-8000-000000000001'
  ) or not exists (
    select 1 from public.supplier_products
    where id = '66000000-0000-4000-8000-000000000001' and current_price = 10
  ) then
    raise exception 'inactive supplier history was hidden or mutated';
  end if;
end
$$;

rollback;
