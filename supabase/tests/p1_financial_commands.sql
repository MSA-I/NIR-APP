-- P1 regression harness. Run only against an isolated local database after applying all
-- project migrations through 0035, including the reasoned purchase-order status command.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p1_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P1 assertion failed: %', p_message;
  end if;
end
$$;

-- Fresh-install ACL contract: browser reads exist only where an RLS read policy exists.
select pg_temp.p1_assert(
  not exists (
    select 1
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and (
        not c.relrowsecurity
        or not exists (
          select 1
          from pg_catalog.pg_policy p
          where p.polrelid = c.oid
            and p.polcmd in ('r', '*')
            and (
              0::oid = any(p.polroles)
              or (select oid from pg_catalog.pg_roles where rolname = 'authenticated') = any(p.polroles)
            )
        )
      )
      and has_table_privilege('authenticated', c.oid, 'SELECT')
  ),
  'authenticated received SELECT on a non-RLS or service-only table'
);
select pg_temp.p1_assert(
  not exists (
    select 1
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relrowsecurity
      and exists (
        select 1
        from pg_catalog.pg_policy p
        where p.polrelid = c.oid
          and p.polcmd in ('r', '*')
          and (
            0::oid = any(p.polroles)
            or (select oid from pg_catalog.pg_roles where rolname = 'authenticated') = any(p.polroles)
          )
      )
      and not has_table_privilege('authenticated', c.oid, 'SELECT')
  ),
  'authenticated is missing SELECT on an RLS-protected application table'
);

-- Stable fixtures. Inserts run without a JWT and therefore model trusted migration/seed work.
insert into organizations (id, name, status) values
  ('10000000-0000-0000-0000-000000000001', 'P1 tenant A', 'active'),
  ('10000000-0000-0000-0000-000000000002', 'P1 tenant B', 'active');

insert into auth.users (id, email) values
  ('20000000-0000-0000-0000-000000000001', 'owner-a@example.test'),
  ('20000000-0000-0000-0000-000000000002', 'office-a@example.test'),
  ('20000000-0000-0000-0000-000000000003', 'kitchen-a@example.test'),
  ('20000000-0000-0000-0000-000000000004', 'payer-a@example.test'),
  ('20000000-0000-0000-0000-000000000005', 'accountant-a@example.test'),
  ('20000000-0000-0000-0000-000000000006', 'supplier-a@example.test'),
  ('20000000-0000-0000-0000-000000000007', 'owner-b@example.test');

insert into profiles (id, org_id, full_name, role) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Owner A', 'owner'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Office A', 'office'),
  ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'Kitchen A', 'kitchen'),
  ('20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'Payer A', 'payer'),
  ('20000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', 'Accountant A', 'accountant'),
  ('20000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000002', 'Owner B', 'owner');

insert into suppliers (id, org_id, name) values
  ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Supplier A1'),
  ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Supplier A2'),
  ('30000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', 'Supplier B1');

insert into profiles (id, org_id, full_name, role, supplier_id) values
  ('20000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', 'Supplier agent A1', 'supplier', '30000000-0000-0000-0000-000000000001');

insert into products (id, org_id, name, unit) values
  ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Product A1', 'unit'),
  ('40000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Product A2', 'unit'),
  ('40000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', 'Product B1', 'unit');

insert into supplier_products (
  id, org_id, supplier_id, product_id, current_price, price_effective_date, available
) values
  ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 10, '2026-07-01', true),
  ('50000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001', 10, '2026-07-01', true),
  ('50000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000003', 30, '2026-07-01', true);

insert into price_history (org_id, supplier_product_id, price, effective_date) values
  ('10000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 10, '2026-07-01'),
  ('10000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000002', 10, '2026-07-01'),
  ('10000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000003', 30, '2026-07-01');

insert into purchase_orders (
  id, org_id, supplier_id, status, created_by
) values (
  '70000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  'confirmed',
  '20000000-0000-0000-0000-000000000001'
), (
  '70000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  'ready',
  '20000000-0000-0000-0000-000000000002'
);

insert into purchase_order_items (id, org_id, order_id, product_id, qty, unit_price) values
  ('71000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 10, 10),
  ('71000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000002', 5, 20),
  ('71000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001', 2, 10);

insert into invoices (
  id, org_id, supplier_id, invoice_number, invoice_date,
  amount_before_vat, vat_amount, total_amount
) values (
  '60000000-0000-0000-0000-000000000010',
  '10000000-0000-0000-0000-000000000002',
  '30000000-0000-0000-0000-000000000003',
  'TENANT-B-CREDIT', '2026-07-10', 10, 1.8, 11.8
);

select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000001', true);
set local role authenticated;

-- Routine order status changes use the reasoned command; protected receipt quantities still
-- exercise the shared table-safe guard below.
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000002', true);
select pg_temp.p1_assert(
  (public.transition_purchase_order_status(
    '70000000-0000-0000-0000-000000000002',
    'sent',
    'P1 supplier message sent',
    null,
    null
  )->>'idempotent')::boolean = false,
  'office ready-to-sent command did not commit'
);
select pg_temp.p1_assert(
  (select status = 'sent' and sent_at is not null
   from purchase_orders where id = '70000000-0000-0000-0000-000000000002'),
  'office ready-to-sent command did not stamp sent_at'
);
do $$
begin
  update purchase_order_items
  set received_qty = 1
  where id = '71000000-0000-0000-0000-000000000003';
  raise exception 'expected direct received_qty rejection';
exception when insufficient_privilege then
  null;
end
$$;
select pg_temp.p1_assert(
  (select received_qty = 0 from purchase_order_items where id = '71000000-0000-0000-0000-000000000003'),
  'direct received_qty mutation crossed the financial command guard'
);
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000001', true);
select pg_temp.p1_assert(
  exists (
    select 1 from audit_logs
    where entity_type = 'purchase_orders'
      and entity_id = '70000000-0000-0000-0000-000000000002'
      and action = 'purchase_order_status_changed'
      and reason = 'P1 supplier message sent'
      and old_values ->> 'status' = 'ready'
      and new_values ->> 'status' = 'sent'
  ),
  'ready-to-sent command did not create a reasoned server-authored audit'
);

-- Invoice: full commit, invalid rollback, exact retry, transition validation and tenant guard.
select pg_temp.p1_assert(
  (create_invoice(
    '60000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    'INV-001', '2026-07-10', 100, 18, 118, null, null, null, null,
    'קליטת חשבונית לבדיקה'
  )->>'idempotent')::boolean = false,
  'invoice first call must commit'
);
select pg_temp.p1_assert(
  (select count(*) = 1 from invoices where id = '60000000-0000-0000-0000-000000000001'),
  'invoice row missing'
);
select pg_temp.p1_assert(
  (create_invoice(
    '60000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    'INV-001', '2026-07-10', 100, 18, 118, null, null, null, null,
    'ניסיון חוזר'
  )->>'idempotent')::boolean,
  'invoice retry must be idempotent'
);

do $$
begin
  perform create_invoice(
    '60000000-0000-0000-0000-000000000099',
    '30000000-0000-0000-0000-000000000001',
    'INV-BAD', '2026-07-10', 100, 18, 117, null, null, null, null, 'בדיקת rollback'
  );
  raise exception 'expected invoice_amounts_invalid';
exception when sqlstate '22023' then
  if sqlerrm not like '%invoice_amounts_invalid%' then raise; end if;
end
$$;
select pg_temp.p1_assert(
  not exists (select 1 from invoices where id = '60000000-0000-0000-0000-000000000099'),
  'invalid invoice left a row behind'
);

do $$
begin
  perform create_invoice(
    '60000000-0000-0000-0000-000000000098',
    '30000000-0000-0000-0000-000000000003',
    'CROSS-TENANT', '2026-07-10', 10, 1.8, 11.8, null, null, null, null, 'בדיקת דייר'
  );
  raise exception 'expected cross-tenant rejection';
exception when sqlstate 'P0002' then
  if sqlerrm not like '%invoice_supplier_invalid%' then raise; end if;
end
$$;

do $$
begin
  perform set_invoice_review_status(
    '60000000-0000-0000-0000-000000000001', 'approved', 'מעבר לא חוקי'
  );
  raise exception 'expected invalid invoice transition';
exception when sqlstate 'P0001' then
  if sqlerrm not like '%invoice_review_transition_invalid%' then raise; end if;
end
$$;
select set_invoice_review_status(
  '60000000-0000-0000-0000-000000000001', 'in_review', 'תחילת בדיקה'
);
select set_invoice_review_status(
  '60000000-0000-0000-0000-000000000001', 'approved', 'אישור חשבונית לתשלום'
);

-- A second open invoice drives bank matching and the month snapshot tests.
select create_invoice(
  '60000000-0000-0000-0000-000000000002',
  '30000000-0000-0000-0000-000000000001',
  'INV-002', '2026-07-11', 42.37, 7.63, 50, null, null, null, null,
  'קליטת חשבונית נוספת'
);
select set_invoice_review_status(
  '60000000-0000-0000-0000-000000000002', 'in_review', 'תחילת בדיקה'
);
select set_invoice_review_status(
  '60000000-0000-0000-0000-000000000002', 'approved', 'אישור חשבונית להתאמה'
);

-- Invoice soft delete is a server command: direct deleted_at writes are blocked, while an
-- unreferenced invoice is deleted atomically with its reasoned audit.
select create_invoice(
  '60000000-0000-0000-0000-000000000009',
  '30000000-0000-0000-0000-000000000001',
  'INV-SOFT-DELETE', '2026-07-12', 10, 1.8, 11.8, null, null, null, null,
  'חשבונית לבדיקת מחיקה רכה'
);
select create_invoice(
  '60000000-0000-0000-0000-000000000012',
  '30000000-0000-0000-0000-000000000001',
  'INV-OFFICE-DELETE', '2026-07-12', 20, 3.6, 23.6, null, null, null, null,
  'חשבונית לבדיקת הרשאת מנהל רכש'
);
do $$
begin
  update invoices
  set deleted_at = now()
  where id = '60000000-0000-0000-0000-000000000009';
  raise exception 'expected direct invoice soft-delete rejection';
exception when sqlstate '42501' then
  -- A fresh install rejects at the table ACL. Upgraded installs that still carry the legacy
  -- UPDATE grant reach p0_invoice_soft_delete_guard and reject with the same SQLSTATE.
  null;
end
$$;
select pg_temp.p1_assert(
  (soft_delete_invoice(
    '60000000-0000-0000-0000-000000000009', 'חשבונית נקלטה בטעות'
  )->>'idempotent')::boolean = false,
  'invoice soft-delete command did not commit'
);
select pg_temp.p1_assert(
  (select deleted_at is not null from invoices where id = '60000000-0000-0000-0000-000000000009'),
  'invoice soft-delete did not set deleted_at'
);
select pg_temp.p1_assert(
  exists (
    select 1 from audit_logs
    where action = 'invoice_soft_deleted'
      and entity_id = '60000000-0000-0000-0000-000000000009'
      and reason = 'חשבונית נקלטה בטעות'
  ),
  'invoice soft-delete audit is missing its reason'
);
select pg_temp.p1_assert(
  (soft_delete_invoice(
    '60000000-0000-0000-0000-000000000009', 'ניסיון חוזר'
  )->>'idempotent')::boolean,
  'invoice soft-delete retry must be idempotent'
);

-- Invoice-linked credit requests use one retry-safe command boundary for creation and status.
select create_invoice(
  '60000000-0000-0000-0000-000000000003',
  '30000000-0000-0000-0000-000000000001',
  'INV-CREDIT', '2026-07-12', 100, 18, 118, null, null, null, null,
  'credit command fixture'
);
select pg_temp.p1_assert(
  (create_invoice_credit_request(
    '65000000-0000-0000-0000-000000000001',
    '60000000-0000-0000-0000-000000000003',
    'wrong_price', 118, 'full credit', 'open invoice credit'
  )->>'idempotent')::boolean = false,
  'credit request first call must commit'
);
select pg_temp.p1_assert(
  (create_invoice_credit_request(
    '65000000-0000-0000-0000-000000000001',
    '60000000-0000-0000-0000-000000000003',
    'wrong_price', 118, 'full credit', 'credit retry'
  )->>'idempotent')::boolean,
  'credit request retry must be idempotent'
);
do $$
begin
  perform create_invoice_credit_request(
    '65000000-0000-0000-0000-000000000001',
    '60000000-0000-0000-0000-000000000003',
    'wrong_price', 117, 'full credit', 'conflicting credit retry'
  );
  raise exception 'expected credit idempotency conflict';
exception when sqlstate 'P0001' then
  if sqlerrm not like '%credit_request_idempotency_conflict%' then raise; end if;
end
$$;
do $$
begin
  perform create_invoice_credit_request(
    '65000000-0000-0000-0000-000000000002',
    '60000000-0000-0000-0000-000000000010',
    'wrong_price', 11.8, null, 'cross-tenant credit attempt'
  );
  raise exception 'expected cross-tenant credit rejection';
exception when sqlstate 'P0002' then
  if sqlerrm not like '%credit_request_invoice_unknown%' then raise; end if;
end
$$;
do $$
begin
  perform transition_credit_request(
    '65000000-0000-0000-0000-000000000001', 'offset', 'invalid direct offset'
  );
  raise exception 'expected invalid credit transition';
exception when sqlstate 'P0001' then
  if sqlerrm not like '%credit_request_transition_invalid%' then raise; end if;
end
$$;
select transition_credit_request(
  '65000000-0000-0000-0000-000000000001', 'requested', 'requested from supplier'
);
select pg_temp.p1_assert(
  (transition_credit_request(
    '65000000-0000-0000-0000-000000000001', 'requested', 'credit transition retry'
  )->>'idempotent')::boolean,
  'credit transition retry must be idempotent'
);
select transition_credit_request(
  '65000000-0000-0000-0000-000000000001', 'received', 'credit received'
);
select transition_credit_request(
  '65000000-0000-0000-0000-000000000001', 'offset', 'credit offset against invoice'
);
select pg_temp.p1_assert(
  (select payment_status = 'paid' from invoices where id = '60000000-0000-0000-0000-000000000003'),
  'credit offset did not refresh invoice payment status'
);
select transition_credit_request(
  '65000000-0000-0000-0000-000000000001', 'closed', 'credit closed'
);
select pg_temp.p1_assert(
  exists (
    select 1 from audit_logs
    where entity_type = 'credit_requests'
      and entity_id = '65000000-0000-0000-0000-000000000001'
      and action = 'credit_request_transitioned'
      and reason = 'credit closed'
  ),
  'credit transition audit is missing its reason'
);

-- Payment request: create, retry, transition and payer execution all remain atomic.
select pg_temp.p1_assert(
  (create_payment_request(
    '80000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    '2026-07-25', null, 'pending_approval',
    '[{"invoice_id":"60000000-0000-0000-0000-000000000001","amount":118}]'::jsonb,
    'תשלום חשבונית INV-001'
  )->>'idempotent')::boolean = false,
  'payment request first call must commit'
);
select pg_temp.p1_assert(
  (create_payment_request(
    '80000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    '2026-07-25', null, 'pending_approval',
    '[{"invoice_id":"60000000-0000-0000-0000-000000000001","amount":118}]'::jsonb,
    'ניסיון חוזר'
  )->>'idempotent')::boolean,
  'payment request retry must be idempotent'
);
select transition_payment_request(
  '80000000-0000-0000-0000-000000000001', 'approved', 'אישור בעלים'
);

reset role;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000004', true);
set local role authenticated;
select pg_temp.p1_assert(
  (execute_payment_request(
    '80000000-0000-0000-0000-000000000001',
    '2026-07-20', 'העברה בנקאית', 'REF-001', null,
    '[{"invoice_id":"60000000-0000-0000-0000-000000000001","credit_id":null,"amount":118}]'::jsonb,
    'ביצוע העברה מאושרת'
  )->>'idempotent')::boolean = false,
  'payment execution first call must commit'
);
select pg_temp.p1_assert(
  (execute_payment_request(
    '80000000-0000-0000-0000-000000000001',
    '2026-07-20', 'העברה בנקאית', 'REF-001', null,
    '[{"invoice_id":"60000000-0000-0000-0000-000000000001","credit_id":null,"amount":118}]'::jsonb,
    'ניסיון חוזר'
  )->>'idempotent')::boolean,
  'payment execution retry must be idempotent'
);
select pg_temp.p1_assert(
  (select status = 'executed' from payment_requests where id = '80000000-0000-0000-0000-000000000001'),
  'request was not executed'
);
select pg_temp.p1_assert(
  (select payment_status = 'paid' from invoices where id = '60000000-0000-0000-0000-000000000001'),
  'invoice payment status was not refreshed'
);

do $$
begin
  perform execute_payment_request(
    '80000000-0000-0000-0000-000000000001',
    '2026-07-20', 'העברה בנקאית', 'DIFFERENT', null,
    '[{"invoice_id":"60000000-0000-0000-0000-000000000001","credit_id":null,"amount":118}]'::jsonb,
    'payload שונה'
  );
  raise exception 'expected payment execution conflict';
exception when sqlstate 'P0001' then
  if sqlerrm not like '%payment_execution_conflict%' then raise; end if;
end
$$;

-- Receipt: draft replacement, completion retry, shortage credit and returned semantics.
reset role;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000003', true);
set local role authenticated;
select pg_temp.p1_assert(
  (save_goods_receipt(
    '70000000-0000-0000-0000-000000000001',
    '72000000-0000-0000-0000-000000000001',
    false, null, true,
    '[
      {"order_item_id":"71000000-0000-0000-0000-000000000001","qty_received":6,"status":"partial","notes":null},
      {"order_item_id":"71000000-0000-0000-0000-000000000002","qty_received":5,"status":"returned","notes":"הוחזר לספק"}
    ]'::jsonb,
    'שמירת טיוטת קבלה'
  )->>'idempotent')::boolean = false,
  'receipt draft first call must commit'
);
select pg_temp.p1_assert(
  (save_goods_receipt(
    '70000000-0000-0000-0000-000000000001',
    '72000000-0000-0000-0000-000000000001',
    false, null, true,
    '[
      {"order_item_id":"71000000-0000-0000-0000-000000000001","qty_received":6,"status":"partial","notes":null},
      {"order_item_id":"71000000-0000-0000-0000-000000000002","qty_received":5,"status":"returned","notes":"הוחזר לספק"}
    ]'::jsonb,
    'ניסיון חוזר'
  )->>'idempotent')::boolean,
  'receipt draft retry must be idempotent'
);
select save_goods_receipt(
  '70000000-0000-0000-0000-000000000001',
  '72000000-0000-0000-0000-000000000001',
  true, null, true,
  '[
    {"order_item_id":"71000000-0000-0000-0000-000000000001","qty_received":6,"status":"partial","notes":null},
    {"order_item_id":"71000000-0000-0000-0000-000000000002","qty_received":5,"status":"returned","notes":"הוחזר לספק"}
  ]'::jsonb,
  'השלמת קבלה'
);
select pg_temp.p1_assert(
  (select received_qty = 6 from purchase_order_items where id = '71000000-0000-0000-0000-000000000001'),
  'partial receipt did not accumulate usable quantity'
);
select pg_temp.p1_assert(
  (select received_qty = 0 from purchase_order_items where id = '71000000-0000-0000-0000-000000000002'),
  'returned quantity was counted as usable delivery'
);
select pg_temp.p1_assert(
  (select count(*) = 1 and min(reason) = 'missing' and min(amount) = 40
   from credit_requests where receipt_item_id in (
     select id from goods_receipt_items where receipt_id = '72000000-0000-0000-0000-000000000001'
   )),
  'receipt must create one shortage credit and no returned credit'
);
select pg_temp.p1_assert(
  (save_goods_receipt(
    '70000000-0000-0000-0000-000000000001',
    '72000000-0000-0000-0000-000000000001',
    true, null, true,
    '[
      {"order_item_id":"71000000-0000-0000-0000-000000000001","qty_received":6,"status":"partial","notes":null},
      {"order_item_id":"71000000-0000-0000-0000-000000000002","qty_received":5,"status":"returned","notes":"הוחזר לספק"}
    ]'::jsonb,
    'ניסיון חוזר'
  )->>'idempotent')::boolean,
  'completed receipt retry must be idempotent'
);
do $$
begin
  perform save_goods_receipt(
    '70000000-0000-0000-0000-000000000001',
    '72000000-0000-0000-0000-000000000001',
    true, null, false,
    '[
      {"order_item_id":"71000000-0000-0000-0000-000000000001","qty_received":6,"status":"partial","notes":null},
      {"order_item_id":"71000000-0000-0000-0000-000000000002","qty_received":5,"status":"returned","notes":"הוחזר לספק"}
    ]'::jsonb,
    'retry with different credit behavior'
  );
  raise exception 'expected receipt idempotency conflict';
exception when sqlstate 'P0001' then
  if sqlerrm not like '%receipt_idempotency_conflict%' then raise; end if;
end
$$;

-- Prices: current row + history are inseparable; batch validation is all-or-nothing.
reset role;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select set_supplier_product_price(
  '50000000-0000-0000-0000-000000000001', 12, '2026-07-12', true, 'עדכון ידני'
);
select pg_temp.p1_assert(
  (select current_price = 12 and previous_price = 10 from supplier_products where id = '50000000-0000-0000-0000-000000000001'),
  'manual price did not update current and previous price'
);
select pg_temp.p1_assert(
  (set_supplier_product_price(
    '50000000-0000-0000-0000-000000000001', 12, '2026-07-12', true, 'ניסיון חוזר'
  )->>'idempotent')::boolean,
  'same effective price must be idempotent'
);
select pg_temp.p1_assert(
  (select count(*) = 2 from price_history where supplier_product_id = '50000000-0000-0000-0000-000000000001'),
  'price retry created duplicate history'
);
select set_supplier_product_price(
  '50000000-0000-0000-0000-000000000001', 12, '2026-07-13', true,
  'אותו מחיר בתאריך תחולה חדש'
);
select pg_temp.p1_assert(
  (select price_effective_date = '2026-07-13'
          and current_price = 12 and previous_price = 10
   from supplier_products where id = '50000000-0000-0000-0000-000000000001'),
  'effective-date-only price update corrupted current or previous price'
);
select pg_temp.p1_assert(
  (select count(*) = 3
          and count(*) filter (where price = 12 and effective_date = '2026-07-13') = 1
   from price_history where supplier_product_id = '50000000-0000-0000-0000-000000000001'),
  'effective-date-only price update did not preserve matching history'
);
select pg_temp.p1_assert(
  (set_supplier_product_price(
    '50000000-0000-0000-0000-000000000001', 12, '2026-07-13', true,
    'ניסיון חוזר לתאריך החדש'
  )->>'idempotent')::boolean,
  'effective-date-only price retry must be idempotent'
);
select import_supplier_prices(
  '[
    {"supplier_id":"30000000-0000-0000-0000-000000000001","product_id":"40000000-0000-0000-0000-000000000001","price":13,"available":true},
    {"supplier_id":"30000000-0000-0000-0000-000000000001","product_id":"40000000-0000-0000-0000-000000000002","price":20,"available":true}
  ]'::jsonb,
  '2026-07-13', 'ייבוא מחירון בדיקה'
);
select pg_temp.p1_assert(
  (select count(*) = 2 from supplier_products where supplier_id = '30000000-0000-0000-0000-000000000001'),
  'price batch did not create the missing pair'
);

do $$
declare v_before numeric;
begin
  select current_price into v_before from supplier_products where id = '50000000-0000-0000-0000-000000000001';
  begin
    perform import_supplier_prices(
      '[
        {"supplier_id":"30000000-0000-0000-0000-000000000001","product_id":"40000000-0000-0000-0000-000000000001","price":14,"available":true},
        {"supplier_id":"30000000-0000-0000-0000-000000000001","product_id":"40000000-0000-0000-0000-000000000002","price":1000001,"available":true}
      ]'::jsonb,
      '2026-07-14', 'batch invalid'
    );
    raise exception 'expected invalid price batch';
  exception when sqlstate '22023' then
    if sqlerrm not like '%price_import_invalid%' then raise; end if;
  end;
  perform pg_temp.p1_assert(
    (select current_price = v_before from supplier_products where id = '50000000-0000-0000-0000-000000000001'),
    'invalid price batch partially updated rows'
  );
end
$$;

-- Supplier agent may write only its own price rows.
reset role;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000006', true);
set local role authenticated;
select set_supplier_product_price(
  '50000000-0000-0000-0000-000000000001', 13.5, '2026-07-15', true, 'עדכון ספק'
);
do $$
begin
  perform set_supplier_product_price(
    '50000000-0000-0000-0000-000000000002', 11, '2026-07-15', true, 'ניסיון ספק אחר'
  );
  raise exception 'expected supplier scope rejection';
exception when sqlstate '42501' then
  if sqlerrm not like '%price_write_not_authorized%' then raise; end if;
end
$$;

-- Accountant owns bank operations; office is denied even when calling the RPC directly.
reset role;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000005', true);
set local role authenticated;
select pg_temp.p1_assert(
  (import_bank_transactions(
    'bank.csv', repeat('a', 64), '{"date":"date"}'::jsonb,
    jsonb_build_array(
      jsonb_build_object(
        'tx_date', '2026-07-20', 'description', 'Supplier A1 invoice', 'amount', 50,
        'is_debit', true, 'reference', 'BANK-50', 'raw', '{}'::jsonb,
        'supplier_id', '30000000-0000-0000-0000-000000000001', 'row_hash', repeat('b', 64)
      ),
      jsonb_build_object(
        'tx_date', '2026-07-20', 'description', 'Supplier A1 payment', 'amount', 118,
        'is_debit', true, 'reference', 'REF-001', 'raw', '{}'::jsonb,
        'supplier_id', '30000000-0000-0000-0000-000000000001', 'row_hash', repeat('c', 64)
      )
    ),
    'ייבוא תדפיס בדיקה'
  )->>'row_count')::int = 2,
  'bank import did not insert full batch'
);
select pg_temp.p1_assert(
  (import_bank_transactions(
    'bank.csv', repeat('a', 64), '{"date":"date"}'::jsonb, '[]'::jsonb, 'ניסיון חוזר'
  )->>'idempotent')::boolean,
  'bank file retry must return existing import'
);
select assign_bank_transaction_supplier(
  (select id from bank_transactions where row_hash = repeat('b', 64)),
  null, 'הסרת שיוך ספק שגוי'
);
select pg_temp.p1_assert(
  (select supplier_id is null from bank_transactions where row_hash = repeat('b', 64)),
  'bank supplier assignment could not be cleared'
);
select assign_bank_transaction_supplier(
  (select id from bank_transactions where row_hash = repeat('b', 64)),
  '30000000-0000-0000-0000-000000000001', 'החזרת שיוך ספק'
);

do $$
begin
  perform import_bank_transactions(
    'bad.csv', repeat('d', 64), '{}'::jsonb,
    jsonb_build_array(jsonb_build_object(
      'tx_date', '2026-07-20', 'description', 'bad', 'amount', 0, 'is_debit', true,
      'raw', '{}'::jsonb, 'row_hash', repeat('e', 64)
    )),
    'בדיקת rollback'
  );
  raise exception 'expected invalid bank rows';
exception when sqlstate '22023' then
  if sqlerrm not like '%bank_import_invalid_rows%' then raise; end if;
end
$$;
select pg_temp.p1_assert(
  not exists (select 1 from bank_imports where file_hash = repeat('d', 64)),
  'invalid bank batch left an import header'
);

select match_bank_transaction(
  (select id from bank_transactions where row_hash = repeat('b', 64)),
  '30000000-0000-0000-0000-000000000001', null,
  '90000000-0000-0000-0000-000000000001',
  '[{"invoice_id":"60000000-0000-0000-0000-000000000002","amount":50}]'::jsonb,
  0.9, 'התאמה ישירה לחשבונית'
);
select pg_temp.p1_assert(
  (select count(*) = 1 and bool_and(invoice_id is not null and payment_id is null)
   from bank_allocations ba join bank_transactions bt on bt.id = ba.bank_transaction_id
   where bt.row_hash = repeat('b', 64)),
  'direct bank match did not preserve one-target allocation'
);
select pg_temp.p1_assert(
  (match_bank_transaction(
    (select id from bank_transactions where row_hash = repeat('b', 64)),
    '30000000-0000-0000-0000-000000000001', null,
    '90000000-0000-0000-0000-000000000001',
    '[{"invoice_id":"60000000-0000-0000-0000-000000000002","amount":50}]'::jsonb,
    0.9, 'ניסיון חוזר'
  )->>'idempotent')::boolean,
  'direct bank match retry must be idempotent'
);
select match_bank_transaction(
  (select id from bank_transactions where row_hash = repeat('c', 64)),
  '30000000-0000-0000-0000-000000000001',
  (select id from payments where payment_request_id = '80000000-0000-0000-0000-000000000001'),
  null, '[]'::jsonb, 0.99, 'התאמת תשלום קיים'
);
select pg_temp.p1_assert(
  (select status = 'matched' from payment_requests where id = '80000000-0000-0000-0000-000000000001'),
  'existing-payment match did not advance its request'
);
do $$
begin
  perform unmatch_bank_transaction(
    (select id from bank_transactions where row_hash = repeat('b', 64)),
    'ניסיון להסיר התאמה ישירה'
  );
  raise exception 'expected direct-match correction requirement';
exception when sqlstate 'P0001' then
  if sqlerrm not like '%bank_direct_match_requires_financial_correction%' then raise; end if;
end
$$;
select pg_temp.p1_assert(
  (unmatch_bank_transaction(
    (select id from bank_transactions where row_hash = repeat('c', 64)),
    'הסרת התאמת תשלום קיים'
  )->>'idempotent')::boolean = false,
  'existing-payment unmatch did not commit'
);
select pg_temp.p1_assert(
  (select status = 'executed' from payment_requests where id = '80000000-0000-0000-0000-000000000001'),
  'unmatch did not restore the request to executed'
);
select pg_temp.p1_assert(
  not exists (
    select 1 from bank_allocations ba
    join bank_transactions bt on bt.id = ba.bank_transaction_id
    where bt.row_hash = repeat('c', 64)
  ),
  'unmatch left a bank allocation behind'
);
select pg_temp.p1_assert(
  (unmatch_bank_transaction(
    (select id from bank_transactions where row_hash = repeat('c', 64)),
    'ניסיון חוזר להסרה'
  )->>'idempotent')::boolean,
  'unmatch retry must be idempotent'
);
select pg_temp.p1_assert(
  exists (
    select 1 from audit_logs
    where action = 'bank_match_removed'
      and entity_id = (select id from bank_transactions where row_hash = repeat('c', 64))
      and reason = 'הסרת התאמת תשלום קיים'
  ),
  'unmatch audit is missing its reason'
);

-- One bank transaction may legitimately allocate to multiple payments. Unmatch restores every
-- linked request and keeps the legacy singular payment_id response field.
reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '', true);
insert into bank_imports (id, org_id, filename, file_hash, column_mapping, row_count, imported_by)
values (
  '91000000-0000-0000-0000-000000000009',
  '10000000-0000-0000-0000-000000000001', 'multi-payment.csv', repeat('8', 64), '{}'::jsonb, 1,
  '20000000-0000-0000-0000-000000000001'
);
insert into bank_transactions (
  id, org_id, import_id, tx_date, description, amount, is_debit, raw, status, row_hash
) values (
  '92000000-0000-0000-0000-000000000009',
  '10000000-0000-0000-0000-000000000001',
  '91000000-0000-0000-0000-000000000009', '2026-07-21', 'multi payment', 30, true,
  '{}'::jsonb, 'matched', repeat('9', 64)
);
insert into payment_requests (
  id, org_id, supplier_id, amount, status, created_by, approved_by, approved_at
) values
  ('80000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000001', 10, 'matched',
   '20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', now()),
  ('80000000-0000-0000-0000-000000000010', '10000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000001', 20, 'matched',
   '20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', now());
insert into payments (
  id, org_id, supplier_id, payment_request_id, amount, paid_date, method, reference, executed_by
) values
  ('90000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000009',
   10, '2026-07-21', 'העברה בנקאית', 'MULTI-1', '20000000-0000-0000-0000-000000000001'),
  ('90000000-0000-0000-0000-000000000010', '10000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000010',
   20, '2026-07-21', 'העברה בנקאית', 'MULTI-2', '20000000-0000-0000-0000-000000000001');
insert into bank_allocations (
  id, org_id, bank_transaction_id, payment_id, amount, confirmed, created_by
) values
  ('93000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000001',
   '92000000-0000-0000-0000-000000000009', '90000000-0000-0000-0000-000000000009',
   10, true, '20000000-0000-0000-0000-000000000001'),
  ('93000000-0000-0000-0000-000000000010', '10000000-0000-0000-0000-000000000001',
   '92000000-0000-0000-0000-000000000009', '90000000-0000-0000-0000-000000000010',
   20, true, '20000000-0000-0000-0000-000000000001');
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select pg_temp.p1_assert(
  jsonb_array_length((unmatch_bank_transaction(
    '92000000-0000-0000-0000-000000000009', 'הסרת התאמה מרובת תשלומים'
  )->'payment_ids')) = 2,
  'multi-payment unmatch did not return every payment id'
);
select pg_temp.p1_assert(
  (select count(*) = 2 and bool_and(status = 'executed')
   from payment_requests
   where id in ('80000000-0000-0000-0000-000000000009', '80000000-0000-0000-0000-000000000010')),
  'multi-payment unmatch did not restore every request'
);
select pg_temp.p1_assert(
  not exists (
    select 1 from bank_allocations
    where bank_transaction_id = '92000000-0000-0000-0000-000000000009'
  ),
  'multi-payment unmatch left allocations behind'
);
select pg_temp.p1_assert(
  exists (
    select 1 from audit_logs
    where action = 'bank_match_removed'
      and entity_id = '92000000-0000-0000-0000-000000000009'
      and jsonb_array_length(old_values->'payment_ids') = 2
      and reason = 'הסרת התאמה מרובת תשלומים'
  ),
  'multi-payment unmatch audit did not preserve every payment id'
);

-- Month export stores a canonical snapshot and rejects later expansion/shrinkage.
select pg_temp.p1_assert(
  (mark_month_export_sent(
    '2026-07-01',
    array['60000000-0000-0000-0000-000000000002'::uuid, '60000000-0000-0000-0000-000000000001'::uuid],
    'העברת דוח יולי'
  )->>'idempotent')::boolean = false,
  'month export first call must commit'
);
select pg_temp.p1_assert(
  (mark_month_export_sent(
    '2026-07-01',
    array['60000000-0000-0000-0000-000000000001'::uuid, '60000000-0000-0000-0000-000000000002'::uuid],
    'ניסיון חוזר'
  )->>'idempotent')::boolean,
  'month export retry must ignore input ordering'
);
do $$
begin
  perform mark_month_export_sent(
    '2026-07-01', array['60000000-0000-0000-0000-000000000001'::uuid], 'snapshot שונה'
  );
  raise exception 'expected month snapshot conflict';
exception when sqlstate 'P0001' then
  if sqlerrm not like '%month_export_snapshot_conflict%' then raise; end if;
end
$$;

do $$
begin
  perform soft_delete_invoice(
    '60000000-0000-0000-0000-000000000001', 'ניסיון להסתיר חשבונית ששולמה'
  );
  raise exception 'expected referenced invoice soft-delete rejection';
exception when sqlstate 'P0001' then
  if sqlerrm not like '%invoice_has_financial_references%' then raise; end if;
end
$$;
select pg_temp.p1_assert(
  (select deleted_at is null from invoices where id = '60000000-0000-0000-0000-000000000001'),
  'referenced invoice was soft-deleted'
);

-- Accountant can operate approved accounting work but not an unapproved invoice credit.
reset role;
select set_config('request.jwt.claim.sub', '', true);
insert into credit_requests (
  id, org_id, supplier_id, invoice_id, reason, amount, status, created_by
) values (
  '65000000-0000-0000-0000-000000000004',
  '10000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '60000000-0000-0000-0000-000000000002',
  'other', 1, 'requested', '20000000-0000-0000-0000-000000000001'
);
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000005', true);
set local role authenticated;
do $$
begin
  perform soft_delete_invoice(
    '60000000-0000-0000-0000-000000000012', 'accountant delete attempt'
  );
  raise exception 'expected accountant invoice soft-delete rejection';
exception when sqlstate '42501' then
  if sqlerrm not like '%invoice_soft_delete_not_authorized%' then raise; end if;
end
$$;
do $$
begin
  perform transition_credit_request(
    '65000000-0000-0000-0000-000000000001', 'closed', 'accountant attempt'
  );
  raise exception 'expected unapproved invoice credit rejection';
exception when sqlstate '42501' then
  if sqlerrm not like '%credit_request_invoice_not_approved%' then raise; end if;
end
$$;
select pg_temp.p1_assert(
  (transition_credit_request(
    '65000000-0000-0000-0000-000000000004', 'received', 'זיכוי התקבל בהנהלת חשבונות'
  )->>'idempotent')::boolean = false,
  'accountant could not transition an approved-invoice credit'
);

-- Owner retains authorized financial signals. Procurement roles receive no bank or balance
-- oracle, even though the underlying bank match remains present.
reset role;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select pg_temp.p1_assert(
  (invoice_financial_check_signals('60000000-0000-0000-0000-000000000002')->>'bank_match_exists')::boolean,
  'owner lost the confirmed direct bank-match signal'
);

reset role;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000003', true);
set local role authenticated;
select pg_temp.p1_assert(
  not (invoice_financial_check_signals('60000000-0000-0000-0000-000000000002')->>'bank_match_exists')::boolean,
  'kitchen received a bank-match signal'
);

reset role;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000002', true);
set local role authenticated;
select pg_temp.p1_assert(
  (soft_delete_invoice(
    '60000000-0000-0000-0000-000000000012', 'מחיקת מנהל רכש עם סיבה'
  )->>'idempotent')::boolean = false,
  'office could not use the reasoned invoice soft-delete command'
);
do $$
begin
  perform transition_credit_request(
    '65000000-0000-0000-0000-000000000004', 'closed', 'office attempt'
  );
  raise exception 'expected office credit transition rejection';
exception when sqlstate '42501' then
  if sqlerrm not like '%credit_request_transition_not_authorized%' then raise; end if;
end
$$;
select pg_temp.p1_assert(
  not (invoice_financial_check_signals('60000000-0000-0000-0000-000000000002')->>'bank_match_exists')::boolean,
  'office received a bank-match signal'
);
select pg_temp.p1_assert(
  not (payment_request_financial_check_signals(
    '30000000-0000-0000-0000-000000000001', 118,
    array['60000000-0000-0000-0000-000000000001'::uuid],
    '80000000-0000-0000-0000-000000000001'
  )->>'similar_bank_transfer_exists')::boolean,
  'office received a similar-bank-transfer signal'
);
select pg_temp.p1_assert(
  (payment_request_financial_check_signals(
    '30000000-0000-0000-0000-000000000001', 1,
    array['60000000-0000-0000-0000-000000000001'::uuid], null
  )->>'amount_matches_open_balance')::boolean
  and (payment_request_financial_check_signals(
    '30000000-0000-0000-0000-000000000001', 117,
    array['60000000-0000-0000-0000-000000000001'::uuid], null
  )->>'amount_matches_open_balance')::boolean,
  'office can distinguish hidden balances by varying the amount'
);
do $$
begin
  perform payment_request_financial_check_signals(
    '30000000-0000-0000-0000-000000000001', 117,
    array['60000000-0000-0000-0000-000000000001'::uuid],
    '80000000-0000-0000-0000-000000000001'
  );
  raise exception 'expected payment-request signal binding rejection';
exception when sqlstate '22023' then
  if sqlerrm not like '%payment_request_checks_mismatch%' then raise; end if;
end
$$;
select pg_temp.p1_assert(
  (select count(*) = 0 from bank_transactions),
  'office can read bank transactions through RLS'
);
do $$
begin
  perform import_bank_transactions(
    'office.csv', repeat('f', 64), '{}'::jsonb, '[]'::jsonb, 'office bank attempt'
  );
  raise exception 'expected office bank rejection';
exception when sqlstate '42501' then
  if sqlerrm not like '%not_authorized%' then raise; end if;
end
$$;

-- Focused fixtures prove accountant execution and the isolated owner emergency path.
reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '', true);
insert into invoices (
  id, org_id, supplier_id, invoice_number, invoice_date,
  amount_before_vat, vat_amount, total_amount, review_status
) values
  ('60000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000001', 'INV-ACCOUNTANT', '2026-07-21', 100, 18, 118, 'approved'),
  ('60000000-0000-0000-0000-000000000008', '10000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000001', 'INV-EMERGENCY', '2026-07-22', 50, 9, 59, 'approved'),
  ('60000000-0000-0000-0000-000000000011', '10000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000001', 'INV-REOPENED', '2026-07-22', 25, 4.5, 29.5, 'approved');
insert into payment_requests (
  id, org_id, supplier_id, amount, status, created_by, approved_by, approved_at
) values
  ('80000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000001', 118, 'approved',
   '20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', now()),
  ('80000000-0000-0000-0000-000000000008', '10000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000001', 59, 'approved',
   '20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', now()),
  ('80000000-0000-0000-0000-000000000011', '10000000-0000-0000-0000-000000000001',
   '30000000-0000-0000-0000-000000000001', 29.5, 'approved',
   '20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', now());
insert into payment_request_invoices (org_id, payment_request_id, invoice_id, amount_allocated) values
  ('10000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000007',
   '60000000-0000-0000-0000-000000000007', 118),
  ('10000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000008',
   '60000000-0000-0000-0000-000000000008', 59),
  ('10000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000011',
   '60000000-0000-0000-0000-000000000011', 29.5);

select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000005', true);
set local role authenticated;
select pg_temp.p1_assert(
  (execute_payment_request(
    '80000000-0000-0000-0000-000000000007', '2026-07-23', 'העברה בנקאית',
    'ACCOUNTANT-REF', null,
    '[{"invoice_id":"60000000-0000-0000-0000-000000000007","credit_id":null,"amount":118}]'::jsonb,
    'ביצוע הנהלת חשבונות'
  )->>'idempotent')::boolean = false,
  'accountant could not execute an approved payment request'
);
select pg_temp.p1_assert(
  exists (
    select 1 from payment_requests
    where id = '80000000-0000-0000-0000-000000000011'
  ) and exists (
    select 1 from payment_request_invoices
    where payment_request_id = '80000000-0000-0000-0000-000000000011'
  ),
  'accountant cannot see a request whose invoices are currently approved'
);

reset role;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select set_invoice_review_status(
  '60000000-0000-0000-0000-000000000011', 'investigation', 'פתיחה מחדש לפני ביצוע'
);

reset role;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000005', true);
set local role authenticated;
select pg_temp.p1_assert(
  not exists (
    select 1 from payment_requests
    where id = '80000000-0000-0000-0000-000000000011'
  ) and not exists (
    select 1 from payment_request_invoices
    where payment_request_id = '80000000-0000-0000-0000-000000000011'
  ),
  'accountant can see a request after its invoice returned to investigation'
);

reset role;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000004', true);
set local role authenticated;
select pg_temp.p1_assert(
  exists (
    select 1 from payment_requests
    where id = '80000000-0000-0000-0000-000000000011'
  ) and exists (
    select 1 from payment_request_invoices
    where payment_request_id = '80000000-0000-0000-0000-000000000011'
  ),
  'payer visibility changed when accountant readiness was tightened'
);

reset role;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000001', true);
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', '20000000-0000-0000-0000-000000000001'
)::text, true);
set local role authenticated;
do $$
begin
  perform execute_payment_request(
    '80000000-0000-0000-0000-000000000008', '2026-07-23', 'העברה בנקאית',
    'EMERGENCY-REF', null,
    '[{"invoice_id":"60000000-0000-0000-0000-000000000008","credit_id":null,"amount":59}]'::jsonb,
    'owner regular attempt'
  );
  raise exception 'expected owner regular execution rejection';
exception when sqlstate '42501' then
  if sqlerrm not like '%payment_request_not_executable%' then raise; end if;
end
$$;
do $$
begin
  perform execute_emergency_payment_request(
    '80000000-0000-0000-0000-000000000008', '2026-07-23', 'העברה בנקאית',
    'EMERGENCY-REF', null,
    '[{"invoice_id":"60000000-0000-0000-0000-000000000008","credit_id":null,"amount":59}]'::jsonb,
    'emergency without fresh password'
  );
  raise exception 'expected missing amr rejection';
exception when sqlstate '42501' then
  if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
end
$$;
reset role;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', '20000000-0000-0000-0000-000000000001',
  'amr', jsonb_build_array(jsonb_build_object(
    'method', 'password', 'timestamp', extract(epoch from clock_timestamp() - interval '10 minutes')::bigint
  ))
)::text, true);
set local role authenticated;
do $$
begin
  perform execute_emergency_payment_request(
    '80000000-0000-0000-0000-000000000008', '2026-07-23', 'העברה בנקאית',
    'EMERGENCY-REF', null,
    '[{"invoice_id":"60000000-0000-0000-0000-000000000008","credit_id":null,"amount":59}]'::jsonb,
    'stale emergency attempt'
  );
  raise exception 'expected stale amr rejection';
exception when sqlstate '42501' then
  if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
end
$$;
reset role;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', '20000000-0000-0000-0000-000000000001',
  'amr', jsonb_build_array(jsonb_build_object(
    'method', 'password', 'timestamp', extract(epoch from clock_timestamp())::bigint
  ))
)::text, true);
set local role authenticated;
select pg_temp.p1_assert(
  (execute_emergency_payment_request(
    '80000000-0000-0000-0000-000000000008', '2026-07-23', 'העברה בנקאית',
    'EMERGENCY-REF', null,
    '[{"invoice_id":"60000000-0000-0000-0000-000000000008","credit_id":null,"amount":59}]'::jsonb,
    'תשלום חירום מאומת'
  )->>'emergency')::boolean,
  'fresh owner emergency execution did not commit'
);
select pg_temp.p1_assert(
  (execute_emergency_payment_request(
    '80000000-0000-0000-0000-000000000008', '2026-07-23', 'העברה בנקאית',
    'EMERGENCY-REF', null,
    '[{"invoice_id":"60000000-0000-0000-0000-000000000008","credit_id":null,"amount":59}]'::jsonb,
    'תשלום חירום מאומת'
  )->>'idempotent')::boolean,
  'owner emergency retry must be idempotent'
);
select pg_temp.p1_assert(
  exists (
    select 1 from audit_logs
    where action = 'payment_request_emergency_executed'
      and entity_id = '80000000-0000-0000-0000-000000000008'
      and reason = 'תשלום חירום מאומת'
  ),
  'owner emergency audit is missing or not distinct'
);

reset role;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000001', true);
set local role authenticated;
do $$
begin
  insert into payments (org_id, supplier_id, amount, paid_date)
  values (
    '10000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001', 1, '2026-07-22'
  );
  raise exception 'expected direct-write rejection';
exception when insufficient_privilege then
  null;
end
$$;
do $$
begin
  insert into credit_requests (
    id, org_id, supplier_id, invoice_id, reason, amount, status, created_by
  ) values (
    '65000000-0000-0000-0000-000000000099',
    '10000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    '60000000-0000-0000-0000-000000000003',
    'other', 1, 'open', '20000000-0000-0000-0000-000000000001'
  );
  raise exception 'expected direct credit insert rejection';
exception when insufficient_privilege then
  null;
end
$$;
do $$
begin
  update credit_requests
  set status = 'open'
  where id = '65000000-0000-0000-0000-000000000001';
  raise exception 'expected direct credit update rejection';
exception when insufficient_privilege then
  null;
end
$$;

-- Finalize revalidates the locked current price and is idempotent after a lost response.
reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '', true);
insert into purchase_requests (
  id, org_id, status, created_by, editor_step
) values (
  '81000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001', 'draft',
  '20000000-0000-0000-0000-000000000001', 2
);
insert into purchase_request_items (
  org_id, request_id, product_id, qty, recommended_supplier_id, chosen_supplier_id, unit_price
) values (
  '10000000-0000-0000-0000-000000000001',
  '81000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000001', 2,
  '30000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001', 13.5
);
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select pg_temp.p1_assert(
  (finalize_purchase_request_draft(
    '81000000-0000-0000-0000-000000000001', 27, 'אישור הזמנה'
  )->>'idempotent')::boolean = false,
  'finalize first call must commit'
);
select pg_temp.p1_assert(
  (finalize_purchase_request_draft(
    '81000000-0000-0000-0000-000000000001', 27, 'ניסיון חוזר'
  )->>'idempotent')::boolean,
  'finalize retry must return existing orders'
);

reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '', true);
insert into purchase_requests (
  id, org_id, status, created_by, editor_step
) values (
  '81000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000001', 'draft',
  '20000000-0000-0000-0000-000000000001', 2
);
insert into purchase_request_items (
  org_id, request_id, product_id, qty, recommended_supplier_id, chosen_supplier_id, unit_price
) values (
  '10000000-0000-0000-0000-000000000001',
  '81000000-0000-0000-0000-000000000002',
  '40000000-0000-0000-0000-000000000001', 1,
  '30000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001', 12
);
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000001', true);
set local role authenticated;
do $$
begin
  perform finalize_purchase_request_draft(
    '81000000-0000-0000-0000-000000000002', 12, 'מחיר ישן'
  );
  raise exception 'expected price change rejection';
exception when sqlstate 'P0001' then
  if sqlerrm not like '%draft_price_changed%' then raise; end if;
end
$$;
select pg_temp.p1_assert(
  not exists (select 1 from purchase_orders where request_id = '81000000-0000-0000-0000-000000000002'),
  'failed finalize left an order behind'
);

reset role;
select 'p1_financial_commands: all assertions passed' as result;
rollback;
