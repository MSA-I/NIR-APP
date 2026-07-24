-- Focused P4 contract for reasoned purchase-order status transitions.
-- Run only against an isolated local database after migration 0035.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p4_order_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P4 order assertion failed: %', p_message;
  end if;
end
$$;

insert into public.organizations (id, name, status) values
  ('14000000-0000-4000-8000-000000000001', 'P4 order tenant A', 'active'),
  ('14000000-0000-4000-8000-000000000002', 'P4 order tenant B', 'active');

insert into auth.users (id, email) values
  ('24000000-0000-4000-8000-000000000001', 'p4-order-owner-a@example.test'),
  ('24000000-0000-4000-8000-000000000002', 'p4-order-office-a@example.test'),
  ('24000000-0000-4000-8000-000000000003', 'p4-order-kitchen-a@example.test'),
  ('24000000-0000-4000-8000-000000000004', 'p4-order-accountant-a@example.test'),
  ('24000000-0000-4000-8000-000000000005', 'p4-order-owner-b@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('24000000-0000-4000-8000-000000000001', '14000000-0000-4000-8000-000000000001', 'P4 owner A', 'owner'),
  ('24000000-0000-4000-8000-000000000002', '14000000-0000-4000-8000-000000000001', 'P4 office A', 'office'),
  ('24000000-0000-4000-8000-000000000003', '14000000-0000-4000-8000-000000000001', 'P4 kitchen A', 'kitchen'),
  ('24000000-0000-4000-8000-000000000004', '14000000-0000-4000-8000-000000000001', 'P4 accountant A', 'accountant'),
  ('24000000-0000-4000-8000-000000000005', '14000000-0000-4000-8000-000000000002', 'P4 owner B', 'owner');

insert into public.suppliers (id, org_id, name) values
  ('34000000-0000-4000-8000-000000000001', '14000000-0000-4000-8000-000000000001', 'P4 supplier A'),
  ('34000000-0000-4000-8000-000000000002', '14000000-0000-4000-8000-000000000002', 'P4 supplier B');

insert into public.purchase_orders (
  id, org_id, supplier_id, status, expected_date, created_by
) values
  ('54000000-0000-4000-8000-000000000001', '14000000-0000-4000-8000-000000000001', '34000000-0000-4000-8000-000000000001', 'ready', '2026-07-30', '24000000-0000-4000-8000-000000000002'),
  ('54000000-0000-4000-8000-000000000002', '14000000-0000-4000-8000-000000000001', '34000000-0000-4000-8000-000000000001', 'draft', null, '24000000-0000-4000-8000-000000000002'),
  ('54000000-0000-4000-8000-000000000003', '14000000-0000-4000-8000-000000000002', '34000000-0000-4000-8000-000000000002', 'ready', null, '24000000-0000-4000-8000-000000000005'),
  ('54000000-0000-4000-8000-000000000004', '14000000-0000-4000-8000-000000000001', '34000000-0000-4000-8000-000000000001', 'draft', null, '24000000-0000-4000-8000-000000000003');

select set_config('request.jwt.claim.sub', '24000000-0000-4000-8000-000000000002', true);
set local role authenticated;

do $$
begin
  update public.purchase_orders
  set status = 'sent', sent_at = clock_timestamp()
  where id = '54000000-0000-4000-8000-000000000001';
  raise exception 'expected direct status update denial';
exception when insufficient_privilege then
  null;
end
$$;

do $$
begin
  perform public.transition_purchase_order_status(
    '54000000-0000-4000-8000-000000000001', 'sent', '   ', null, null
  );
  raise exception 'expected missing reason rejection';
exception when invalid_parameter_value then
  null;
end
$$;

do $$
begin
  perform public.transition_purchase_order_status(
    '54000000-0000-4000-8000-000000000001', 'sent', 'send', 'not allowed', null
  );
  raise exception 'expected non-confirmation payload rejection';
exception when invalid_parameter_value then
  null;
end
$$;

select pg_temp.p4_order_assert(
  (public.transition_purchase_order_status(
    '54000000-0000-4000-8000-000000000001',
    'sent',
    'שליחת הזמנה לספק',
    null,
    null
  )->>'idempotent')::boolean = false,
  'ready-to-sent transition did not commit'
);

select pg_temp.p4_order_assert(
  (select status = 'sent' and sent_at is not null and confirmed_at is null
   from public.purchase_orders
   where id = '54000000-0000-4000-8000-000000000001'),
  'sent transition did not preserve timestamp semantics'
);

select set_config(
  'p4_order.sent_at',
  (select sent_at::text from public.purchase_orders
   where id = '54000000-0000-4000-8000-000000000001'),
  true
);

select pg_temp.p4_order_assert(
  (public.transition_purchase_order_status(
    '54000000-0000-4000-8000-000000000001',
    'sent',
    'retry after lost response',
    null,
    null
  )->>'idempotent')::boolean,
  'sent retry was not idempotent'
);

select pg_temp.p4_order_assert(
  (select sent_at::text = current_setting('p4_order.sent_at')
   from public.purchase_orders
   where id = '54000000-0000-4000-8000-000000000001'),
  'sent retry changed sent_at'
);

select pg_temp.p4_order_assert(
  (public.transition_purchase_order_status(
    '54000000-0000-4000-8000-000000000001',
    'confirmed',
    'אישור ספק להזמנה',
    'אושר ב-WhatsApp',
    '2026-07-31'
  )->>'idempotent')::boolean = false,
  'sent-to-confirmed transition did not commit'
);

select pg_temp.p4_order_assert(
  (select status = 'confirmed'
      and sent_at::text = current_setting('p4_order.sent_at')
      and confirmed_at is not null
      and confirmation_note = 'אושר ב-WhatsApp'
      and expected_date = '2026-07-31'
   from public.purchase_orders
   where id = '54000000-0000-4000-8000-000000000001'),
  'confirmation metadata was not stored atomically'
);

select pg_temp.p4_order_assert(
  (public.transition_purchase_order_status(
    '54000000-0000-4000-8000-000000000001',
    'confirmed',
    'retry confirmation',
    'אושר ב-WhatsApp',
    '2026-07-31'
  )->>'idempotent')::boolean,
  'confirmation retry with the same payload was not idempotent'
);

do $$
begin
  perform public.transition_purchase_order_status(
    '54000000-0000-4000-8000-000000000001',
    'confirmed',
    'conflicting retry',
    'payload שונה',
    '2026-07-31'
  );
  raise exception 'expected confirmation payload conflict';
exception when sqlstate 'P0001' then
  if sqlerrm not like '%purchase_order_status_idempotency_conflict%' then raise; end if;
end
$$;

do $$
begin
  perform public.transition_purchase_order_status(
    '54000000-0000-4000-8000-000000000001',
    'confirmed',
    'conflicting retry',
    'אושר ב-WhatsApp',
    '2026-08-01'
  );
  raise exception 'expected confirmation date conflict';
exception when sqlstate 'P0001' then
  if sqlerrm not like '%purchase_order_status_idempotency_conflict%' then raise; end if;
end
$$;

select pg_temp.p4_order_assert(
  (public.transition_purchase_order_status(
    '54000000-0000-4000-8000-000000000002',
    'ready',
    'סימון הזמנה כמוכנה',
    null,
    null
  )->>'status') = 'ready',
  'draft-to-ready transition was rejected'
);

do $$
begin
  perform public.transition_purchase_order_status(
    '54000000-0000-4000-8000-000000000002',
    'confirmed',
    'illegal skip',
    null,
    null
  );
  raise exception 'expected ready-to-confirmed rejection';
exception when sqlstate 'P0001' then
  if sqlerrm not like '%purchase_order_status_transition_invalid%' then raise; end if;
end
$$;

select pg_temp.p4_order_assert(
  (public.transition_purchase_order_status(
    '54000000-0000-4000-8000-000000000004',
    'sent',
    'שליחת הזמנה לספק',
    null,
    null
  )->>'status') = 'sent',
  'legacy draft-to-sent transition was rejected'
);

do $$
begin
  perform public.transition_purchase_order_status(
    '54000000-0000-4000-8000-000000000003',
    'sent',
    'cross-tenant attempt',
    null,
    null
  );
  raise exception 'expected cross-tenant rejection';
exception when sqlstate 'P0002' then
  if sqlerrm not like '%purchase_order_unknown%' then raise; end if;
end
$$;

reset role;
select set_config('request.jwt.claim.sub', '24000000-0000-4000-8000-000000000004', true);
set local role authenticated;

do $$
begin
  perform public.transition_purchase_order_status(
    '54000000-0000-4000-8000-000000000002',
    'sent',
    'wrong role attempt',
    null,
    null
  );
  raise exception 'expected wrong-role rejection';
exception when insufficient_privilege then
  if sqlerrm not like '%purchase_order_status_not_authorized%' then raise; end if;
end
$$;

reset role;

select pg_temp.p4_order_assert(
  (select status = 'ready' from public.purchase_orders
   where id = '54000000-0000-4000-8000-000000000003'),
  'cross-tenant attempt changed tenant B'
);

select pg_temp.p4_order_assert(
  (select count(*) = 2
   from public.audit_logs
   where entity_type = 'purchase_orders'
     and entity_id = '54000000-0000-4000-8000-000000000001'
     and action = 'purchase_order_status_changed'),
  'idempotent retries added or removed reasoned audit rows'
);

select pg_temp.p4_order_assert(
  exists (
    select 1 from public.audit_logs
    where org_id = '14000000-0000-4000-8000-000000000001'
      and user_id = '24000000-0000-4000-8000-000000000002'
      and entity_type = 'purchase_orders'
      and entity_id = '54000000-0000-4000-8000-000000000001'
      and action = 'purchase_order_status_changed'
      and reason = 'שליחת הזמנה לספק'
      and old_values ->> 'status' = 'ready'
      and new_values ->> 'status' = 'sent'
      and new_values ->> 'sent_at' is not null
  ),
  'sent transition audit is missing actor, reason or before/after values'
);

select pg_temp.p4_order_assert(
  exists (
    select 1 from public.audit_logs
    where org_id = '14000000-0000-4000-8000-000000000001'
      and user_id = '24000000-0000-4000-8000-000000000002'
      and entity_type = 'purchase_orders'
      and entity_id = '54000000-0000-4000-8000-000000000001'
      and action = 'purchase_order_status_changed'
      and reason = 'אישור ספק להזמנה'
      and old_values ->> 'status' = 'sent'
      and new_values ->> 'status' = 'confirmed'
      and new_values ->> 'confirmation_note' = 'אושר ב-WhatsApp'
      and new_values ->> 'expected_date' = '2026-07-31'
  ),
  'confirmation audit is missing its reasoned payload'
);

rollback;
