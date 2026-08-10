-- P23 -- supplier purchase-order projection, acknowledgement and adversarial isolation.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p23_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P23 supplier portal assertion failed: %', p_message;
  end if;
end
$$;

select pg_temp.p23_assert(
  exists (
    select 1
    from private.scope_definer_enforcements enforcement
    join pg_catalog.pg_proc proc
      on proc.oid = 'public.supplier_portal_context()'::regprocedure
    where enforcement.function_signature = 'supplier_portal_context()'
      and enforcement.enforcement_kind = 'filtered_read'
      and enforcement.body_hash = md5(replace(proc.prosrc, e'\r', ''))
  ),
  'supplier portal definer scope enforcement is missing or stale'
);

insert into public.organizations (id, name, status) values
  ('26100000-0000-4000-8000-000000000001', 'P23 tenant A', 'active'),
  ('26100000-0000-4000-8000-000000000002', 'P23 tenant B', 'active');

insert into auth.users (id, email) values
  ('26200000-0000-4000-8000-000000000001', 'p23-owner-a@example.test'),
  ('26200000-0000-4000-8000-000000000002', 'p23-supplier-a1@example.test'),
  ('26200000-0000-4000-8000-000000000003', 'p23-supplier-a2@example.test'),
  ('26200000-0000-4000-8000-000000000004', 'p23-supplier-b@example.test');

insert into public.suppliers (id, org_id, name) values
  ('26300000-0000-4000-8000-000000000001', '26100000-0000-4000-8000-000000000001', 'P23 supplier A1'),
  ('26300000-0000-4000-8000-000000000002', '26100000-0000-4000-8000-000000000001', 'P23 supplier A2'),
  ('26300000-0000-4000-8000-000000000003', '26100000-0000-4000-8000-000000000002', 'P23 supplier B');

insert into public.profiles (id, org_id, full_name, role, supplier_id) values
  ('26200000-0000-4000-8000-000000000001', '26100000-0000-4000-8000-000000000001', 'P23 owner A', 'owner', null),
  ('26200000-0000-4000-8000-000000000002', '26100000-0000-4000-8000-000000000001', 'P23 supplier A1 agent', 'supplier', '26300000-0000-4000-8000-000000000001'),
  ('26200000-0000-4000-8000-000000000003', '26100000-0000-4000-8000-000000000001', 'P23 supplier A2 agent', 'supplier', '26300000-0000-4000-8000-000000000002'),
  ('26200000-0000-4000-8000-000000000004', '26100000-0000-4000-8000-000000000002', 'P23 supplier B agent', 'supplier', '26300000-0000-4000-8000-000000000003');

insert into public.products (id, org_id, name, unit) values
  ('26400000-0000-4000-8000-000000000001', '26100000-0000-4000-8000-000000000001', 'P23 product A', 'unit'),
  ('26400000-0000-4000-8000-000000000002', '26100000-0000-4000-8000-000000000002', 'P23 product B', 'kg');

insert into public.supplier_products (
  id, org_id, supplier_id, product_id, current_price, supplier_sku
) values
  ('26500000-0000-4000-8000-000000000001', '26100000-0000-4000-8000-000000000001', '26300000-0000-4000-8000-000000000001', '26400000-0000-4000-8000-000000000001', 12, 'A1-SKU'),
  ('26500000-0000-4000-8000-000000000002', '26100000-0000-4000-8000-000000000001', '26300000-0000-4000-8000-000000000002', '26400000-0000-4000-8000-000000000001', 13, 'A2-SKU'),
  ('26500000-0000-4000-8000-000000000003', '26100000-0000-4000-8000-000000000002', '26300000-0000-4000-8000-000000000003', '26400000-0000-4000-8000-000000000002', 14, 'B-SKU');

insert into public.purchase_orders (
  id, org_id, supplier_id, status, expected_date, created_by, sent_at
) values
  ('26600000-0000-4000-8000-000000000001', '26100000-0000-4000-8000-000000000001', '26300000-0000-4000-8000-000000000001', 'sent', '2026-08-20', '26200000-0000-4000-8000-000000000001', now() - interval '2 days'),
  ('26600000-0000-4000-8000-000000000002', '26100000-0000-4000-8000-000000000001', '26300000-0000-4000-8000-000000000001', 'draft', null, '26200000-0000-4000-8000-000000000001', null),
  ('26600000-0000-4000-8000-000000000003', '26100000-0000-4000-8000-000000000001', '26300000-0000-4000-8000-000000000001', 'ready', null, '26200000-0000-4000-8000-000000000001', null),
  ('26600000-0000-4000-8000-000000000004', '26100000-0000-4000-8000-000000000001', '26300000-0000-4000-8000-000000000001', 'cancelled', null, '26200000-0000-4000-8000-000000000001', now() - interval '3 days'),
  ('26600000-0000-4000-8000-000000000005', '26100000-0000-4000-8000-000000000001', '26300000-0000-4000-8000-000000000002', 'sent', null, '26200000-0000-4000-8000-000000000001', now() - interval '1 day'),
  ('26600000-0000-4000-8000-000000000006', '26100000-0000-4000-8000-000000000002', '26300000-0000-4000-8000-000000000003', 'sent', null, null, now() - interval '1 day'),
  ('26600000-0000-4000-8000-000000000007', '26100000-0000-4000-8000-000000000001', '26300000-0000-4000-8000-000000000001', 'sent', '2026-08-21', '26200000-0000-4000-8000-000000000001', now());

insert into public.purchase_order_items (
  id, org_id, order_id, product_id, qty, unit_price
) values
  ('26700000-0000-4000-8000-000000000001', '26100000-0000-4000-8000-000000000001', '26600000-0000-4000-8000-000000000001', '26400000-0000-4000-8000-000000000001', 5, 12),
  ('26700000-0000-4000-8000-000000000002', '26100000-0000-4000-8000-000000000001', '26600000-0000-4000-8000-000000000002', '26400000-0000-4000-8000-000000000001', 1, 12),
  ('26700000-0000-4000-8000-000000000003', '26100000-0000-4000-8000-000000000001', '26600000-0000-4000-8000-000000000003', '26400000-0000-4000-8000-000000000001', 1, 12),
  ('26700000-0000-4000-8000-000000000004', '26100000-0000-4000-8000-000000000001', '26600000-0000-4000-8000-000000000004', '26400000-0000-4000-8000-000000000001', 2, 12),
  ('26700000-0000-4000-8000-000000000005', '26100000-0000-4000-8000-000000000001', '26600000-0000-4000-8000-000000000005', '26400000-0000-4000-8000-000000000001', 3, 13),
  ('26700000-0000-4000-8000-000000000006', '26100000-0000-4000-8000-000000000002', '26600000-0000-4000-8000-000000000006', '26400000-0000-4000-8000-000000000002', 4, 14),
  ('26700000-0000-4000-8000-000000000007', '26100000-0000-4000-8000-000000000001', '26600000-0000-4000-8000-000000000007', '26400000-0000-4000-8000-000000000001', 6, 12);

select set_config('request.jwt.claim.sub', '26200000-0000-4000-8000-000000000002', true);
set local role authenticated;

select pg_temp.p23_assert(
  (select count(*) = 0 from public.purchase_orders)
  and (select count(*) = 0 from public.purchase_order_items)
  and (select count(*) = 0 from public.suppliers),
  'supplier gained direct access to a purchase-order or supplier base table'
);

select pg_temp.p23_assert(
  public.supplier_portal_context()->'supplier'->>'id' = '26300000-0000-4000-8000-000000000001'
  and public.supplier_portal_context()->'supplier'->>'status' = 'active'
  and jsonb_array_length(public.supplier_portal_context()->'orders') = 3
  and not exists (
    select 1
    from jsonb_array_elements(public.supplier_portal_context()->'orders') order_row
    where order_row->>'id' in (
      '26600000-0000-4000-8000-000000000002',
      '26600000-0000-4000-8000-000000000003',
      '26600000-0000-4000-8000-000000000005',
      '26600000-0000-4000-8000-000000000006'
    )
  ),
  'projection omitted supplier commerce status or exposed an unissued, other-supplier or other-tenant order'
);

select pg_temp.p23_assert(
  public.supplier_portal_context()->'orders'->0->'items'->0->>'product_name' = 'P23 product A'
  and exists (
    select 1
    from jsonb_array_elements(public.supplier_portal_context()->'orders') order_row
    cross join lateral jsonb_array_elements(order_row->'items') item
    where item->>'supplier_sku' = 'A1-SKU'
      and (item->>'unit_price')::numeric = 12
  ),
  'projection omitted supplier-safe order item details'
);

do $$
begin
  perform public.transition_purchase_order_status(
    '26600000-0000-4000-8000-000000000005', 'confirmed',
    'cross-supplier attempt', null, null
  );
  raise exception 'expected other-supplier rejection';
exception when sqlstate 'P0002' then
  if sqlerrm not like '%purchase_order_unknown%' then raise; end if;
end
$$;

do $$
begin
  perform public.transition_purchase_order_status(
    '26600000-0000-4000-8000-000000000006', 'confirmed',
    'cross-tenant attempt', null, null
  );
  raise exception 'expected cross-tenant rejection';
exception when sqlstate 'P0002' then
  if sqlerrm not like '%purchase_order_unknown%' then raise; end if;
end
$$;

do $$
begin
  perform public.transition_purchase_order_status(
    '26600000-0000-4000-8000-000000000002', 'sent',
    'forbidden supplier send', null, null
  );
  raise exception 'expected supplier status authorization rejection';
exception when insufficient_privilege then
  if sqlerrm not like '%purchase_order_status_not_authorized%' then raise; end if;
end
$$;

do $$
begin
  perform public.transition_purchase_order_status(
    '26600000-0000-4000-8000-000000000007', 'confirmed',
    'forbidden delivery-date mutation', null, '2026-08-22'
  );
  raise exception 'expected supplier delivery date rejection';
exception when invalid_parameter_value then
  if sqlerrm not like '%purchase_order_confirmation_fields_invalid%' then raise; end if;
end
$$;

do $$
begin
  perform public.transition_purchase_order_status(
    '26600000-0000-4000-8000-000000000003', 'confirmed',
    'forbidden ready-to-confirmed skip', null, null
  );
  raise exception 'expected supplier ready-to-confirmed rejection';
exception when sqlstate 'P0001' then
  if sqlerrm not like '%purchase_order_status_transition_invalid%' then raise; end if;
end
$$;

select pg_temp.p23_assert(
  (public.transition_purchase_order_status(
    '26600000-0000-4000-8000-000000000001', 'confirmed',
    'אישור קבלת הזמנה בפורטל הספק', 'ההזמנה התקבלה', null
  )->>'idempotent')::boolean = false,
  'supplier acknowledgement did not commit'
);

select pg_temp.p23_assert(
  (public.transition_purchase_order_status(
    '26600000-0000-4000-8000-000000000001', 'confirmed',
    'retry', 'ההזמנה התקבלה', null
  )->>'idempotent')::boolean,
  'supplier acknowledgement retry was not idempotent'
);

do $$
begin
  perform public.transition_purchase_order_status(
    '26600000-0000-4000-8000-000000000001', 'confirmed',
    'conflicting retry', 'טקסט שונה', null
  );
  raise exception 'expected conflicting supplier acknowledgement rejection';
exception when sqlstate 'P0001' then
  if sqlerrm not like '%purchase_order_status_idempotency_conflict%' then raise; end if;
end
$$;

reset role;

select pg_temp.p23_assert(
  (select status = 'confirmed' and confirmed_at is not null
     and confirmation_note = 'ההזמנה התקבלה'
   from public.purchase_orders
   where id = '26600000-0000-4000-8000-000000000001'),
  'supplier acknowledgement metadata is incomplete'
);

select pg_temp.p23_assert(
  (select count(*) = 1
   from public.audit_logs
   where org_id = '26100000-0000-4000-8000-000000000001'
     and user_id = '26200000-0000-4000-8000-000000000002'
     and entity_type = 'purchase_orders'
     and entity_id = '26600000-0000-4000-8000-000000000001'
     and action = 'purchase_order_status_changed'
     and reason = 'אישור קבלת הזמנה בפורטל הספק'
     and old_values->>'status' = 'sent'
     and new_values->>'status' = 'confirmed'),
  'supplier acknowledgement audit is missing or duplicated'
);

select set_config('request.jwt.claim.sub', '26200000-0000-4000-8000-000000000003', true);
set local role authenticated;

select pg_temp.p23_assert(
  jsonb_array_length(public.supplier_portal_context()->'orders') = 1
  and public.supplier_portal_context()->'orders'->0->>'id' = '26600000-0000-4000-8000-000000000005',
  'same-tenant supplier isolation failed'
);

rollback;
