-- P0 browser-DML and reasoned-command regression harness. Run only against an isolated local
-- database after applying migrations through 0030_client_dml_acl_and_reasoned_commands.sql.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p0_acl_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P0 ACL assertion failed: %', p_message;
  end if;
end
$$;

-- ===== Static ACL contract =====

select pg_temp.p0_acl_assert(
  has_column_privilege('authenticated', 'public.organizations', 'name', 'UPDATE')
  and has_column_privilege('authenticated', 'public.categories', 'org_id', 'INSERT')
  and has_column_privilege('authenticated', 'public.categories', 'name', 'UPDATE')
  and has_table_privilege('authenticated', 'public.categories', 'DELETE')
  and has_column_privilege('authenticated', 'public.suppliers', 'name', 'INSERT')
  and has_column_privilege('authenticated', 'public.suppliers', 'name', 'UPDATE')
  and has_column_privilege('authenticated', 'public.products', 'active', 'INSERT')
  and has_column_privilege('authenticated', 'public.products', 'name', 'UPDATE')
  and has_column_privilege('authenticated', 'public.purchase_orders', 'status', 'UPDATE')
  and has_column_privilege('authenticated', 'public.exceptions', 'status', 'UPDATE')
  and has_column_privilege('authenticated', 'public.documents', 'storage_path', 'INSERT')
  and has_column_privilege('authenticated', 'public.documents', 'deleted_at', 'UPDATE')
  and has_table_privilege('authenticated', 'public.push_subscriptions', 'DELETE'),
  'required browser DML privilege is missing'
);

select pg_temp.p0_acl_assert(
  not has_column_privilege('authenticated', 'public.organizations', 'status', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.suppliers', 'org_id', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.suppliers', 'deleted_at', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.products', 'org_id', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.products', 'active', 'UPDATE')
  and not has_any_column_privilege('authenticated', 'public.purchase_requests', 'INSERT')
  and not has_any_column_privilege('authenticated', 'public.purchase_requests', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.purchase_requests', 'DELETE')
  and not has_any_column_privilege('authenticated', 'public.purchase_request_items', 'INSERT')
  and not has_any_column_privilege('authenticated', 'public.purchase_request_items', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.purchase_request_items', 'DELETE')
  and not has_column_privilege('authenticated', 'public.purchase_orders', 'org_id', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.documents', 'storage_path', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.suppliers', 'DELETE')
  and not has_table_privilege('authenticated', 'public.products', 'DELETE')
  and not has_table_privilege('authenticated', 'public.purchase_orders', 'DELETE'),
  'sensitive or destructive browser privilege is exposed'
);

select pg_temp.p0_acl_assert(
  to_regprocedure('public.finalize_purchase_request_draft(uuid,numeric)') is null
  or not has_function_privilege(
    'authenticated',
    to_regprocedure('public.finalize_purchase_request_draft(uuid,numeric)'),
    'EXECUTE'
  ),
  'legacy two-argument finalize overload is executable without an audit reason'
);

-- ===== Trusted fixtures =====

insert into public.organizations (id, name, status) values
  ('13000000-0000-0000-0000-000000000001', 'P0 ACL tenant A', 'active'),
  ('13000000-0000-0000-0000-000000000002', 'P0 ACL tenant B', 'active');

insert into auth.users (id, email) values
  ('23000000-0000-0000-0000-000000000001', 'owner-a-p0-acl@example.test'),
  ('23000000-0000-0000-0000-000000000002', 'office-a-p0-acl@example.test'),
  ('23000000-0000-0000-0000-000000000003', 'kitchen-a-p0-acl@example.test'),
  ('23000000-0000-0000-0000-000000000004', 'accountant-a-p0-acl@example.test'),
  ('23000000-0000-0000-0000-000000000005', 'payer-a-p0-acl@example.test'),
  ('23000000-0000-0000-0000-000000000006', 'owner-b-p0-acl@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('23000000-0000-0000-0000-000000000001', '13000000-0000-0000-0000-000000000001', 'P0 ACL owner A', 'owner'),
  ('23000000-0000-0000-0000-000000000002', '13000000-0000-0000-0000-000000000001', 'P0 ACL office A', 'office'),
  ('23000000-0000-0000-0000-000000000003', '13000000-0000-0000-0000-000000000001', 'P0 ACL kitchen A', 'kitchen'),
  ('23000000-0000-0000-0000-000000000004', '13000000-0000-0000-0000-000000000001', 'P0 ACL accountant A', 'accountant'),
  ('23000000-0000-0000-0000-000000000005', '13000000-0000-0000-0000-000000000001', 'P0 ACL payer A', 'payer'),
  ('23000000-0000-0000-0000-000000000006', '13000000-0000-0000-0000-000000000002', 'P0 ACL owner B', 'owner');

insert into public.suppliers (id, org_id, name) values
  ('33000000-0000-0000-0000-000000000001', '13000000-0000-0000-0000-000000000001', 'P0 ACL deletable supplier'),
  ('33000000-0000-0000-0000-000000000002', '13000000-0000-0000-0000-000000000001', 'P0 ACL active supplier'),
  ('33000000-0000-0000-0000-000000000003', '13000000-0000-0000-0000-000000000002', 'P0 ACL tenant B supplier');

insert into public.products (id, org_id, name, unit) values
  ('43000000-0000-0000-0000-000000000001', '13000000-0000-0000-0000-000000000001', 'P0 ACL product A', 'unit'),
  ('43000000-0000-0000-0000-000000000002', '13000000-0000-0000-0000-000000000002', 'P0 ACL product B', 'unit');

insert into public.purchase_orders (id, org_id, supplier_id, status, created_by) values
  ('53000000-0000-0000-0000-000000000001', '13000000-0000-0000-0000-000000000001', '33000000-0000-0000-0000-000000000002', 'ready', '23000000-0000-0000-0000-000000000002'),
  ('53000000-0000-0000-0000-000000000002', '13000000-0000-0000-0000-000000000002', '33000000-0000-0000-0000-000000000003', 'ready', '23000000-0000-0000-0000-000000000006');

insert into public.invoices (
  id, org_id, supplier_id, invoice_number, invoice_date,
  amount_before_vat, vat_amount, total_amount, review_status
) values (
  '63000000-0000-0000-0000-000000000001',
  '13000000-0000-0000-0000-000000000001',
  '33000000-0000-0000-0000-000000000002',
  'P0-ACL-APPROVED', '2026-07-23', 100, 18, 118, 'approved'
);

insert into public.payments (
  id, org_id, supplier_id, amount, paid_date, method, reference, executed_by
) values (
  '73000000-0000-0000-0000-000000000001',
  '13000000-0000-0000-0000-000000000001',
  '33000000-0000-0000-0000-000000000002',
  118, '2026-07-23', 'bank_transfer', 'P0-ACL-PAYMENT',
  '23000000-0000-0000-0000-000000000004'
);

insert into storage.objects (bucket_id, name, owner, metadata) values
  (
    'documents',
    '13000000-0000-0000-0000-000000000001/invoice/63000000-0000-0000-0000-000000000001/accountant-invoice.pdf',
    '23000000-0000-0000-0000-000000000004',
    '{"mimetype":"application/pdf"}'::jsonb
  ),
  (
    'documents',
    '13000000-0000-0000-0000-000000000001/payment/73000000-0000-0000-0000-000000000001/accountant-proof.pdf',
    '23000000-0000-0000-0000-000000000004',
    '{"mimetype":"application/pdf"}'::jsonb
  );

-- ===== Owner and tenant boundaries =====

select set_config('request.jwt.claim.sub', '23000000-0000-0000-0000-000000000001', true);
set local role authenticated;

with changed as (
  update public.organizations set name = 'P0 ACL tenant A renamed'
  where id = '13000000-0000-0000-0000-000000000001'
  returning 1
)
select pg_temp.p0_acl_assert(
  (select count(*) = 1 from changed),
  'owner could not update an allowed organization column'
);

with changed as (
  update public.suppliers set name = 'cross-tenant write'
  where id = '33000000-0000-0000-0000-000000000003'
  returning 1
)
select pg_temp.p0_acl_assert(
  (select count(*) = 0 from changed),
  'owner crossed the supplier tenant boundary'
);

-- Draft save/update/cancel work only through SECURITY DEFINER commands. The same browser role
-- has no direct INSERT, UPDATE or DELETE privilege on either draft table.
do $$
begin
  insert into public.purchase_requests (org_id, status, created_by)
  values (
    '13000000-0000-0000-0000-000000000001',
    'draft',
    '23000000-0000-0000-0000-000000000001'
  );
  raise exception 'expected direct purchase-request insert denial';
exception when insufficient_privilege then
  null;
end
$$;

select (
  public.save_purchase_request_draft(
    null,
    'initial ACL draft',
    '2026-07-30',
    1::smallint,
    '[{"product_id":"43000000-0000-0000-0000-000000000001","qty":2,"chosen_supplier_id":null}]'::jsonb
  )->>'request_id'
) as p0_acl_draft_id
\gset

select set_config('app.p0_acl_test_draft_id', :'p0_acl_draft_id', true);

select pg_temp.p0_acl_assert(
  (public.save_purchase_request_draft(
    :'p0_acl_draft_id'::uuid,
    'updated ACL draft',
    '2026-07-31',
    2::smallint,
    '[{"product_id":"43000000-0000-0000-0000-000000000001","qty":3,"chosen_supplier_id":null}]'::jsonb
  )->>'request_id')::uuid = :'p0_acl_draft_id'::uuid,
  'draft RPC could not update its own existing request without direct table DML'
);

do $$
begin
  update public.purchase_requests
  set notes = 'direct update must fail'
  where id = current_setting('app.p0_acl_test_draft_id')::uuid;
  raise exception 'expected direct purchase-request update denial';
exception when insufficient_privilege then
  null;
end
$$;

do $$
begin
  delete from public.purchase_requests
  where id = current_setting('app.p0_acl_test_draft_id')::uuid;
  raise exception 'expected direct purchase-request delete denial';
exception when insufficient_privilege then
  null;
end
$$;

do $$
begin
  insert into public.purchase_request_items (request_id, product_id, qty)
  values (
    current_setting('app.p0_acl_test_draft_id')::uuid,
    '43000000-0000-0000-0000-000000000001',
    1
  );
  raise exception 'expected direct purchase-request-item insert denial';
exception when insufficient_privilege then
  null;
end
$$;

do $$
begin
  update public.purchase_request_items
  set qty = 4
  where request_id = current_setting('app.p0_acl_test_draft_id')::uuid;
  raise exception 'expected direct purchase-request-item update denial';
exception when insufficient_privilege then
  null;
end
$$;

do $$
begin
  delete from public.purchase_request_items
  where request_id = current_setting('app.p0_acl_test_draft_id')::uuid;
  raise exception 'expected direct purchase-request-item delete denial';
exception when insufficient_privilege then
  null;
end
$$;

select public.cancel_purchase_request_draft(
  :'p0_acl_draft_id'::uuid,
  'draft no longer needed'
);

reset role;
select pg_temp.p0_acl_assert(
  exists (
    select 1 from public.purchase_requests
    where id = :'p0_acl_draft_id'::uuid
      and status = 'cancelled'
      and notes = 'updated ACL draft'
      and editor_step = 2
  )
  and exists (
    select 1 from public.audit_logs
    where entity_type = 'purchase_requests'
      and entity_id = :'p0_acl_draft_id'::uuid
      and action = 'purchase_request_cancelled'
      and reason = 'draft no longer needed'
  ),
  'draft command path did not persist the update/cancellation audit'
);

select set_config('request.jwt.claim.sub', '23000000-0000-0000-0000-000000000001', true);
set local role authenticated;

do $$
begin
  update public.suppliers
  set org_id = '13000000-0000-0000-0000-000000000002'
  where id = '33000000-0000-0000-0000-000000000001';
  raise exception 'expected supplier org_id column denial';
exception when insufficient_privilege then
  null;
end
$$;

do $$
begin
  perform public.set_product_active(
    '43000000-0000-0000-0000-000000000002', false, 'cross-tenant test'
  );
  raise exception 'expected cross-tenant product rejection';
exception when sqlstate 'P0002' then
  if sqlerrm not like '%product_not_found%' then raise; end if;
end
$$;

reset role;

-- Office cannot change the organization, but can edit and reason-soft-delete its suppliers.
select set_config('request.jwt.claim.sub', '23000000-0000-0000-0000-000000000002', true);
set local role authenticated;

with changed as (
  update public.organizations set name = 'office must not rename org'
  where id = '13000000-0000-0000-0000-000000000001'
  returning 1
)
select pg_temp.p0_acl_assert(
  (select count(*) = 0 from changed),
  'office changed an owner-only organization field'
);

with changed as (
  update public.suppliers set contact_name = 'Allowed office edit'
  where id = '33000000-0000-0000-0000-000000000001'
  returning 1
)
select pg_temp.p0_acl_assert(
  (select count(*) = 1 from changed),
  'office could not update an allowed supplier field'
);

do $$
begin
  update public.suppliers
  set deleted_at = clock_timestamp()
  where id = '33000000-0000-0000-0000-000000000001';
  raise exception 'expected direct supplier soft-delete denial';
exception when insufficient_privilege then
  null;
end
$$;

select pg_temp.p0_acl_assert(
  (public.soft_delete_supplier(
    '33000000-0000-0000-0000-000000000001', 'supplier no longer used'
  )->>'idempotent')::boolean = false,
  'office supplier soft-delete RPC did not commit'
);

reset role;
select pg_temp.p0_acl_assert(
  exists (
    select 1 from public.audit_logs
    where org_id = '13000000-0000-0000-0000-000000000001'
      and entity_type = 'suppliers'
      and entity_id = '33000000-0000-0000-0000-000000000001'
      and action = 'supplier_deleted'
      and reason = 'supplier no longer used'
  ),
  'supplier soft-delete has no server-authored reasoned audit'
);

select set_config('request.jwt.claim.sub', '23000000-0000-0000-0000-000000000002', true);
set local role authenticated;

do $$
begin
  perform public.soft_delete_supplier(
    '33000000-0000-0000-0000-000000000002', 'must fail with an open balance'
  );
  raise exception 'expected supplier open-balance rejection';
exception when sqlstate 'P0001' then
  if sqlerrm not like '%supplier_has_open_balance%' then raise; end if;
end
$$;

-- Normal non-sensitive order transitions remain direct. Cancellation is RPC-only.
with changed as (
  update public.purchase_orders
  set status = 'sent', sent_at = '2026-07-23 10:00:00+00'
  where id = '53000000-0000-0000-0000-000000000001'
  returning 1
)
select pg_temp.p0_acl_assert(
  (select count(*) = 1 from changed),
  'office normal purchase-order transition was blocked'
);

do $$
begin
  update public.purchase_orders
  set status = 'cancelled'
  where id = '53000000-0000-0000-0000-000000000001';
  raise exception 'expected direct purchase-order cancellation denial';
exception when insufficient_privilege then
  null;
end
$$;

select pg_temp.p0_acl_assert(
  (public.cancel_purchase_order(
    '53000000-0000-0000-0000-000000000001', 'supplier confirmed cancellation'
  )->>'idempotent')::boolean = false,
  'office purchase-order cancellation RPC did not commit'
);

reset role;
select pg_temp.p0_acl_assert(
  exists (
    select 1 from public.audit_logs
    where org_id = '13000000-0000-0000-0000-000000000001'
      and entity_type = 'purchase_orders'
      and entity_id = '53000000-0000-0000-0000-000000000001'
      and action = 'order_status:cancelled'
      and reason = 'supplier confirmed cancellation'
  ),
  'purchase-order cancellation has no server-authored reasoned audit'
);

reset role;

-- Kitchen may edit products, but active state changes always require the reasoned RPC.
select set_config('request.jwt.claim.sub', '23000000-0000-0000-0000-000000000003', true);
set local role authenticated;

with changed as (
  update public.products set notes = 'Allowed kitchen edit'
  where id = '43000000-0000-0000-0000-000000000001'
  returning 1
)
select pg_temp.p0_acl_assert(
  (select count(*) = 1 from changed),
  'kitchen could not update an allowed product field'
);

do $$
begin
  update public.products
  set active = false
  where id = '43000000-0000-0000-0000-000000000001';
  raise exception 'expected direct product active-state denial';
exception when insufficient_privilege then
  null;
end
$$;

do $$
begin
  perform public.set_product_active(
    '43000000-0000-0000-0000-000000000001', false, null
  );
  raise exception 'expected product reason requirement';
exception when sqlstate '22023' then
  if sqlerrm not like '%reason_required%' then raise; end if;
end
$$;

select pg_temp.p0_acl_assert(
  (public.set_product_active(
    '43000000-0000-0000-0000-000000000001', false, 'temporarily unavailable'
  )->>'idempotent')::boolean = false,
  'kitchen product active-state RPC did not commit'
);

reset role;
select pg_temp.p0_acl_assert(
  exists (
    select 1 from public.audit_logs
    where org_id = '13000000-0000-0000-0000-000000000001'
      and entity_type = 'products'
      and entity_id = '43000000-0000-0000-0000-000000000001'
      and action = 'product_deactivated'
      and reason = 'temporarily unavailable'
  ),
  'product active-state change has no server-authored reasoned audit'
);

reset role;

-- Accountant has the shared authenticated ACL but RLS/RPC role checks deny purchasing writes.
select set_config('request.jwt.claim.sub', '23000000-0000-0000-0000-000000000004', true);
set local role authenticated;

with changed as (
  update public.suppliers set name = 'accountant must not edit supplier'
  where id = '33000000-0000-0000-0000-000000000002'
  returning 1
)
select pg_temp.p0_acl_assert(
  (select count(*) = 0 from changed),
  'accountant edited a supplier through shared column ACL'
);

with changed as (
  update public.products set notes = 'accountant must not edit product'
  where id = '43000000-0000-0000-0000-000000000001'
  returning 1
)
select pg_temp.p0_acl_assert(
  (select count(*) = 0 from changed),
  'accountant edited a product through shared column ACL'
);

do $$
begin
  perform public.soft_delete_supplier(
    '33000000-0000-0000-0000-000000000002', 'accountant denial'
  );
  raise exception 'expected accountant supplier command denial';
exception when insufficient_privilege then
  if sqlerrm not like '%supplier_soft_delete_not_authorized%' then raise; end if;
end
$$;

do $$
begin
  perform public.set_product_active(
    '43000000-0000-0000-0000-000000000001', true, 'accountant denial'
  );
  raise exception 'expected accountant product command denial';
exception when insufficient_privilege then
  if sqlerrm not like '%product_active_not_authorized%' then raise; end if;
end
$$;

do $$
begin
  perform public.cancel_purchase_order(
    '53000000-0000-0000-0000-000000000001', 'accountant denial'
  );
  raise exception 'expected accountant order command denial';
exception when insufficient_privilege then
  if sqlerrm not like '%purchase_order_cancel_not_authorized%' then raise; end if;
end
$$;

-- Accountant may register proof only for a payment they executed. An approved invoice stays
-- readable but cannot receive an accountant-authored attachment.
do $$
begin
  insert into public.documents (
    org_id, entity_type, entity_id, storage_path, file_name, mime_type, uploaded_by,
    document_kind, supplier_id, document_date
  ) values (
    '13000000-0000-0000-0000-000000000001',
    'invoice',
    '63000000-0000-0000-0000-000000000001',
    '13000000-0000-0000-0000-000000000001/invoice/63000000-0000-0000-0000-000000000001/accountant-invoice.pdf',
    'accountant-invoice.pdf',
    'application/pdf',
    '23000000-0000-0000-0000-000000000004',
    'invoice',
    '33000000-0000-0000-0000-000000000002',
    '2026-07-23'
  );
  raise exception 'expected accountant invoice attachment denial';
exception when insufficient_privilege then
  null;
end
$$;

insert into public.documents (
  org_id, entity_type, entity_id, storage_path, file_name, mime_type, uploaded_by,
  document_kind, supplier_id, document_date
) values (
  '13000000-0000-0000-0000-000000000001',
  'payment',
  '73000000-0000-0000-0000-000000000001',
  '13000000-0000-0000-0000-000000000001/payment/73000000-0000-0000-0000-000000000001/accountant-proof.pdf',
  'accountant-proof.pdf',
  'application/pdf',
  '23000000-0000-0000-0000-000000000004',
  'payment_confirmation',
  '33000000-0000-0000-0000-000000000002',
  '2026-07-23'
);

select pg_temp.p0_acl_assert(
  exists (
    select 1 from public.documents
    where entity_type = 'payment'
      and entity_id = '73000000-0000-0000-0000-000000000001'
      and uploaded_by = '23000000-0000-0000-0000-000000000004'
      and document_kind = 'payment_confirmation'
  )
  and not exists (
    select 1 from public.documents
    where entity_type = 'invoice'
      and entity_id = '63000000-0000-0000-0000-000000000001'
      and uploaded_by = '23000000-0000-0000-0000-000000000004'
  ),
  'accountant document policy did not separate payment proof from invoice upload'
);

reset role;
rollback;
