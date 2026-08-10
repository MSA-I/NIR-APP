-- P20 -- Immutable invoice evidence, true PO/receipt/invoice matching and approval guard.
-- Runs against a freshly reset disposable local database after migration 0099.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p20_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P20 invoice three-way assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p20_actor(p_user uuid, p_fresh_password boolean default false)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', case when p_user is null then '' else 'authenticated' end, true);
  perform set_config('request.jwt.claims', case when p_user is null then '{}'::jsonb else
    jsonb_build_object(
      'sub', p_user,
      'role', 'authenticated',
      'amr', case when p_fresh_password then jsonb_build_array(jsonb_build_object(
        'method', 'password', 'timestamp', extract(epoch from clock_timestamp())
      )) else '[]'::jsonb end
    ) end::text, true);
end
$$;

create function pg_temp.p20_line(
  p_description text,
  p_supplier_sku text,
  p_barcode text,
  p_product_id uuid,
  p_quantity numeric,
  p_unit text,
  p_unit_price numeric,
  p_discount numeric,
  p_vat numeric,
  p_total numeric,
  p_line_number integer default 1
) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'line_number', p_line_number,
    'description', p_description,
    'supplier_sku', p_supplier_sku,
    'barcode', p_barcode,
    'product_id', p_product_id,
    'quantity', p_quantity,
    'unit', p_unit,
    'unit_price', p_unit_price,
    'discount_amount', p_discount,
    'vat_rate', p_vat,
    'line_total', p_total,
    'evidence_block_ids', jsonb_build_array('manual-p20'),
    'raw_evidence', jsonb_build_object('source', 'human-reviewed-p20')
  )
$$;

-- ===== Catalog, ACL, tenant-composite and immutability contracts =====

select pg_temp.p20_assert(
  (select bool_and(c.relrowsecurity and c.relforcerowsecurity)
   from pg_class c
   where c.oid = any(array[
     'public.invoice_line_evidence_batches'::regclass,
     'public.invoice_lines'::regclass,
     'public.invoice_line_match_sets'::regclass,
     'public.invoice_line_matches'::regclass,
     'public.invoice_three_way_overrides'::regclass,
     'public.invoice_three_way_approval_snapshots'::regclass
   ])),
  'all evidence/match/override ledgers must have RLS and FORCE RLS'
);
select pg_temp.p20_assert(
  not has_table_privilege('authenticated', 'public.invoice_lines', 'INSERT')
  and not has_table_privilege('authenticated', 'public.invoice_lines', 'UPDATE')
  and has_table_privilege('authenticated', 'public.invoice_lines', 'SELECT'),
  'browser line evidence must be read-only outside its RPC'
);
select pg_temp.p20_assert(
  (select p.prosecdef from pg_proc p
   where p.oid = 'public.record_invoice_line_evidence(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb,text)'::regprocedure)
  and (select p.prosecdef from pg_proc p
   where p.oid = 'public.record_invoice_line_matches(uuid,uuid,uuid,uuid,jsonb,text)'::regprocedure)
  and (select p.prosecdef from pg_proc p
   where p.oid = 'public.override_invoice_three_way_match(uuid,text,uuid,text)'::regprocedure)
  and (select p.prosecdef from pg_proc p
   where p.oid = 'public.get_invoice_three_way_match(uuid)'::regprocedure),
  'commands and narrow private-helper projection must be definer'
);
select pg_temp.p20_assert(
  not exists (
    select 1
    from private.scope_definer_enforcements enforcement
    join pg_proc proc on proc.oid = to_regprocedure(enforcement.function_signature)
    where enforcement.function_signature in (
      'record_invoice_line_evidence(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb,text)',
      'record_invoice_line_matches(uuid,uuid,uuid,uuid,jsonb,text)',
      'override_invoice_three_way_match(uuid,text,uuid,text)',
      'get_invoice_three_way_match(uuid)'
    ) and enforcement.body_hash <> md5(replace(proc.prosrc, e'\r', ''))
  ) and (
    select count(*) = 4 from private.scope_definer_enforcements
    where function_signature in (
      'record_invoice_line_evidence(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb,text)',
      'record_invoice_line_matches(uuid,uuid,uuid,uuid,jsonb,text)',
      'override_invoice_three_way_match(uuid,text,uuid,text)',
      'get_invoice_three_way_match(uuid)'
    )
  ),
  'A5 reviewed scope-definer hashes are missing or stale'
);
select pg_temp.p20_assert(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.invoice_lines'::regclass
      and pg_get_constraintdef(oid) ilike 'FOREIGN KEY (org_id, invoice_id)%invoices(org_id, id)%'
  ) and exists (
    select 1 from pg_constraint
    where conrelid = 'public.invoice_line_matches'::regclass
      and pg_get_constraintdef(oid) ilike 'FOREIGN KEY (org_id, purchase_order_item_id)%purchase_order_items(org_id, id)%'
  ) and exists (
    select 1 from pg_constraint
    where conrelid = 'public.invoice_line_matches'::regclass
      and pg_get_constraintdef(oid)
        ilike 'FOREIGN KEY (org_id, invoice_line_id, invoice_id)%invoice_lines(org_id, id, invoice_id)%'
  ),
  'tenant/source-composite invoice/order-item foreign keys are missing'
);
select pg_temp.p20_assert(
  private.invoice_unit_factor('g', 'kg') = 0.001
  and private.invoice_unit_factor('ק"ג', 'גרם') = 1000
  and private.invoice_unit_factor('ml', 'liter') = 0.001
  and private.invoice_unit_factor('יחידה', 'ארגז') is null,
  'implicit conversion must be limited to mass/volume'
);
select pg_temp.p20_assert(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.document_auto_actions'::regclass
      and trigger_row.tgname = 'document_auto_action_captures_invoice_lines'
      and not trigger_row.tgisinternal
      and trigger_row.tgenabled = 'O'
  ) and position('record_invoice_line_evidence' in (
    select proc.prosrc from pg_proc proc
    where proc.oid = 'public.capture_applied_invoice_line_evidence()'::regprocedure
  )) > 0 and (select proc.prosecdef from pg_proc proc
    where proc.oid = 'public.capture_applied_invoice_line_evidence()'::regprocedure),
  'automatic document application is not wired atomically to invoice-line evidence'
);
select pg_temp.p20_assert(
  position('pg_advisory_xact_lock' in (
    select proc.prosrc from pg_proc proc
    where proc.oid = 'public.invoice_three_way_approval_guard()'::regprocedure
  )) > 0,
  'invoice approval must serialize cumulative three-way assessment before commit'
);
select pg_temp.p20_assert(
  to_regprocedure('private.invoice_line_identified_product(uuid,uuid,uuid)') is null
  and (select regexp_count(proc.prosrc, 'from private[.]invoice_line_candidates') = 2
       from pg_proc proc
       where proc.oid = 'private.invoice_three_way_raw(uuid,uuid)'::regprocedure)
  and (select regexp_count(proc.prosrc, 'from private[.]invoice_effective_line_matches') = 1
       from pg_proc proc
       where proc.oid = 'private.invoice_three_way_raw(uuid,uuid)'::regprocedure),
  'assessment must cache candidates and effective matches once, not recompute them per line'
);

do $$
declare v_blocked boolean := false;
begin
  begin
    insert into public.invoice_lines default values;
  exception when sqlstate '42501' then
    v_blocked := sqlerrm = 'invoice_three_way_writer_required';
  end;
  if not v_blocked then
    raise exception 'P20 invoice three-way assertion failed: direct evidence insert did not fail closed';
  end if;
end
$$;

-- ===== Two tenants, four roles, three purchase/receipt contexts =====

insert into public.organizations (id, name, status, vat_rate) values
  ('20000000-0000-4000-8000-000000000001', 'P20 tenant A', 'active', 17),
  ('20000000-0000-4000-8000-000000000002', 'P20 tenant B', 'active', 17);
insert into auth.users (id, email) values
  ('21000000-0000-4000-8000-000000000001', 'owner-a-p20@example.test'),
  ('21000000-0000-4000-8000-000000000002', 'office-a-p20@example.test'),
  ('21000000-0000-4000-8000-000000000003', 'kitchen-a-p20@example.test'),
  ('21000000-0000-4000-8000-000000000004', 'accountant-a-p20@example.test'),
  ('21000000-0000-4000-8000-000000000005', 'owner-b-p20@example.test');
insert into public.profiles (id, org_id, full_name, role) values
  ('21000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'P20 owner A', 'owner'),
  ('21000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', 'P20 office A', 'office'),
  ('21000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001', 'P20 kitchen A', 'kitchen'),
  ('21000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000001', 'P20 accountant A', 'accountant'),
  ('21000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000002', 'P20 owner B', 'owner');
insert into public.suppliers (id, org_id, name, tax_id) values
  ('22000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'P20 supplier A', 'P20-A'),
  ('22000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'P20 supplier B', 'P20-B'),
  ('22000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001', 'P20 wrong linked supplier', 'P20-WRONG');
insert into public.products (id, org_id, name, unit, sku, barcode) values
  ('23000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Flour P20', 'kg', 'FLOUR-P20', '7290000000201'),
  ('23000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', 'Cans P20', 'unit', 'CAN-P20', '7290000000202'),
  ('23000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001', 'Cases P20', 'case', 'CASE-P20', '7290000000203'),
  ('23000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000001', 'Hierarchy A P20', 'unit', 'HIER-A-P20', '7290000000205'),
  ('23000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000001', 'Hierarchy B P20', 'unit', 'HIER-B-P20', '7290000000206'),
  ('23000000-0000-4000-8000-000000000007', '20000000-0000-4000-8000-000000000001', 'Duplicate supplier SKU A P20', 'unit', 'DUP-A-P20', '7290000000207'),
  ('23000000-0000-4000-8000-000000000008', '20000000-0000-4000-8000-000000000001', 'Duplicate supplier SKU B P20', 'unit', 'DUP-B-P20', '7290000000208'),
  ('23000000-0000-4000-8000-000000000009', '20000000-0000-4000-8000-000000000001', 'Duplicate barcode A P20', 'unit', 'BAR-A-P20', '7290000000209'),
  ('23000000-0000-4000-8000-000000000010', '20000000-0000-4000-8000-000000000001', 'Duplicate barcode B P20', 'unit', 'BAR-B-P20', '7290000000209'),
  ('23000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000002', 'Tenant B P20', 'kg', 'B-P20', '7290000000299');
insert into public.supplier_products (
  org_id, supplier_id, product_id, current_price, supplier_sku
) values
  ('20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000005', 5, 'SUP-HIER-A'),
  ('20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000006', 5, 'SUP-HIER-B'),
  ('20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000007', 5, 'SUP-DUPLICATE'),
  ('20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000008', 5, 'SUP-DUPLICATE'),
  ('20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000009', 5, 'SUP-BAR-A'),
  ('20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000010', 5, 'SUP-BAR-B');
insert into public.purchase_orders (id, org_id, supplier_id, status, created_by) values
  ('24000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'sent', '21000000-0000-4000-8000-000000000001'),
  ('24000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'sent', '21000000-0000-4000-8000-000000000001'),
  ('24000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'sent', '21000000-0000-4000-8000-000000000001'),
  ('24000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'sent', '21000000-0000-4000-8000-000000000001'),
  ('24000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'sent', '21000000-0000-4000-8000-000000000001'),
  ('24000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'sent', '21000000-0000-4000-8000-000000000001'),
  ('24000000-0000-4000-8000-000000000007', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'sent', '21000000-0000-4000-8000-000000000001'),
  ('24000000-0000-4000-8000-000000000008', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'sent', '21000000-0000-4000-8000-000000000001'),
  ('24000000-0000-4000-8000-000000000009', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'sent', '21000000-0000-4000-8000-000000000001'),
  ('24000000-0000-4000-8000-000000000010', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'sent', '21000000-0000-4000-8000-000000000001'),
  ('24000000-0000-4000-8000-000000000011', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'sent', '21000000-0000-4000-8000-000000000001'),
  ('24000000-0000-4000-8000-000000000012', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000003', 'sent', '21000000-0000-4000-8000-000000000001'),
  ('24000000-0000-4000-8000-000000000013', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'sent', '21000000-0000-4000-8000-000000000001'),
  ('24000000-0000-4000-8000-000000000014', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'sent', '21000000-0000-4000-8000-000000000001');
insert into public.purchase_order_items (id, org_id, order_id, product_id, qty, unit_price) values
  ('25000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001', '23000000-0000-4000-8000-000000000001', 20, 42),
  ('25000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000002', '23000000-0000-4000-8000-000000000001', 20, 42),
  ('25000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000003', '23000000-0000-4000-8000-000000000002', 10, 5),
  ('25000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000004', '23000000-0000-4000-8000-000000000003', 2, 100),
  ('25000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000005', '23000000-0000-4000-8000-000000000001', 2, 42),
  ('25000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000005', '23000000-0000-4000-8000-000000000002', 3, 5),
  ('25000000-0000-4000-8000-000000000007', '20000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000006', '23000000-0000-4000-8000-000000000002', 10, 5),
  ('25000000-0000-4000-8000-000000000008', '20000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000007', '23000000-0000-4000-8000-000000000005', 4, 5),
  ('25000000-0000-4000-8000-000000000009', '20000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000008', '23000000-0000-4000-8000-000000000005', 10, 5),
  ('25000000-0000-4000-8000-000000000010', '20000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000009', '23000000-0000-4000-8000-000000000006', 4, 5),
  ('25000000-0000-4000-8000-000000000011', '20000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000010', '23000000-0000-4000-8000-000000000007', 4, 5),
  ('25000000-0000-4000-8000-000000000012', '20000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000011', '23000000-0000-4000-8000-000000000008', 4, 5),
  ('25000000-0000-4000-8000-000000000013', '20000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000012', '23000000-0000-4000-8000-000000000005', 4, 5),
  ('25000000-0000-4000-8000-000000000014', '20000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000013', '23000000-0000-4000-8000-000000000009', 4, 5),
  ('25000000-0000-4000-8000-000000000015', '20000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000014', '23000000-0000-4000-8000-000000000010', 4, 5);

select pg_temp.p20_assert(
  (select unit_snapshot = 'kg' from public.purchase_order_items where id = '25000000-0000-4000-8000-000000000001')
  and (select unit_snapshot = 'unit' from public.purchase_order_items where id = '25000000-0000-4000-8000-000000000003'),
  'new order items must snapshot the exact product unit'
);
do $$
begin
  update public.purchase_order_items set unit_snapshot = 'g'
  where id = '25000000-0000-4000-8000-000000000001';
  raise exception 'P20 invoice three-way assertion failed: order unit snapshot was mutable';
exception when sqlstate '42501' then
  if sqlerrm <> 'purchase_order_item_unit_snapshot_immutable' then raise; end if;
end
$$;

select pg_temp.p20_actor('21000000-0000-4000-8000-000000000001', false);
set local role authenticated;
select public.save_goods_receipt(
  '24000000-0000-4000-8000-000000000001', '26000000-0000-4000-8000-000000000001',
  true, 'P20 partial receipt', false,
  '[{"order_item_id":"25000000-0000-4000-8000-000000000001","qty_received":18,"status":"partial","notes":"2 kg missing"}]',
  'P20 records actual partial receipt'
);
select public.save_goods_receipt(
  '24000000-0000-4000-8000-000000000002', '26000000-0000-4000-8000-000000000002',
  true, 'P20 full receipt', false,
  '[{"order_item_id":"25000000-0000-4000-8000-000000000002","qty_received":20,"status":"full","notes":null}]',
  'P20 records actual full receipt'
);
select public.save_goods_receipt(
  '24000000-0000-4000-8000-000000000003', '26000000-0000-4000-8000-000000000003',
  true, 'P20 unit receipt', false,
  '[{"order_item_id":"25000000-0000-4000-8000-000000000003","qty_received":10,"status":"full","notes":null}]',
  'P20 records exact unit receipt'
);
select public.save_goods_receipt(
  '24000000-0000-4000-8000-000000000004', '26000000-0000-4000-8000-000000000004',
  true, 'P20 case receipt', false,
  '[{"order_item_id":"25000000-0000-4000-8000-000000000004","qty_received":2,"status":"full","notes":null}]',
  'P20 records exact case receipt'
);
select public.save_goods_receipt(
  '24000000-0000-4000-8000-000000000005', '26000000-0000-4000-8000-000000000005',
  true, 'P20 receipt includes one item absent from invoice', false,
  '[{"order_item_id":"25000000-0000-4000-8000-000000000005","qty_received":2,"status":"full","notes":null},{"order_item_id":"25000000-0000-4000-8000-000000000006","qty_received":3,"status":"full","notes":null}]',
  'P20 records both received order items'
);
select public.save_goods_receipt(
  '24000000-0000-4000-8000-000000000006', '26000000-0000-4000-8000-000000000006',
  true, 'P20 cumulative invoice receipt', false,
  '[{"order_item_id":"25000000-0000-4000-8000-000000000007","qty_received":10,"status":"full","notes":null}]',
  'P20 records quantity shared by two invoices'
);
select public.save_goods_receipt(
  '24000000-0000-4000-8000-000000000007', '26000000-0000-4000-8000-000000000007',
  true, 'P20 smaller hierarchy balance', false,
  '[{"order_item_id":"25000000-0000-4000-8000-000000000008","qty_received":4,"status":"full","notes":null}]',
  'P20 records the smaller remaining quantity candidate'
);
select public.save_goods_receipt(
  '24000000-0000-4000-8000-000000000008', '26000000-0000-4000-8000-000000000008',
  true, 'P20 larger hierarchy balance', false,
  '[{"order_item_id":"25000000-0000-4000-8000-000000000009","qty_received":10,"status":"full","notes":null}]',
  'P20 records the only candidate capable of carrying six units'
);
select public.save_goods_receipt(
  '24000000-0000-4000-8000-000000000009', '26000000-0000-4000-8000-000000000009',
  true, 'P20 conflicting lower-priority identity', false,
  '[{"order_item_id":"25000000-0000-4000-8000-000000000010","qty_received":4,"status":"full","notes":null}]',
  'P20 records the lower-priority identity collision candidate'
);
select public.save_goods_receipt(
  '24000000-0000-4000-8000-000000000010', '26000000-0000-4000-8000-000000000010',
  true, 'P20 duplicate supplier SKU A', false,
  '[{"order_item_id":"25000000-0000-4000-8000-000000000011","qty_received":4,"status":"full","notes":null}]',
  'P20 records the first deliberately duplicated catalog identity'
);
select public.save_goods_receipt(
  '24000000-0000-4000-8000-000000000011', '26000000-0000-4000-8000-000000000011',
  true, 'P20 duplicate supplier SKU B', false,
  '[{"order_item_id":"25000000-0000-4000-8000-000000000012","qty_received":4,"status":"full","notes":null}]',
  'P20 records the second deliberately duplicated catalog identity'
);
select public.save_goods_receipt(
  '24000000-0000-4000-8000-000000000012', '26000000-0000-4000-8000-000000000012',
  true, 'P20 wrong-supplier linked order', false,
  '[{"order_item_id":"25000000-0000-4000-8000-000000000013","qty_received":4,"status":"full","notes":null}]',
  'P20 records evidence that must remain outside supplier A matching'
);
select public.save_goods_receipt(
  '24000000-0000-4000-8000-000000000013', '26000000-0000-4000-8000-000000000013',
  true, 'P20 duplicate barcode A', false,
  '[{"order_item_id":"25000000-0000-4000-8000-000000000014","qty_received":4,"status":"full","notes":null}]',
  'P20 records the first deliberately duplicated barcode'
);
select public.save_goods_receipt(
  '24000000-0000-4000-8000-000000000014', '26000000-0000-4000-8000-000000000014',
  true, 'P20 duplicate barcode B', false,
  '[{"order_item_id":"25000000-0000-4000-8000-000000000015","qty_received":4,"status":"full","notes":null}]',
  'P20 records the second deliberately duplicated barcode'
);
reset role;
select pg_temp.p20_actor(null, false);

-- ===== Invoices and immutable human-reviewed source evidence =====

insert into public.invoices (
  id, org_id, supplier_id, invoice_number, invoice_date,
  amount_before_vat, vat_amount, total_amount
) values
  ('27000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'P20-GOOD', current_date, 756, 128.52, 884.52),
  ('27000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'P20-PRICE-WARN', current_date, 848.40, 144.23, 992.63),
  ('27000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'P20-PRICE-BLOCK', current_date, 848.60, 144.26, 992.86),
  ('27000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'P20-UNIT-OVER', current_date, 55, 9.35, 64.35),
  ('27000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'P20-AMBIGUOUS', current_date, 714, 121.38, 835.38),
  ('27000000-0000-4000-8000-000000000006', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'P20-NO-ORDER', current_date, 100, 17, 117),
  ('27000000-0000-4000-8000-000000000007', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'P20-DUP-LINE', current_date, 756, 128.52, 884.52),
  ('27000000-0000-4000-8000-000000000008', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'P20-MASS-TOLERANCE', current_date, 771.12, 131.09, 902.21),
  ('27000000-0000-4000-8000-000000000009', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'P20-MASS-OVER', current_date, 773.22, 131.45, 904.67),
  ('27000000-0000-4000-8000-000000000010', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'P20-SPLIT-ORDERS', current_date, 1646, 279.82, 1925.82),
  ('27000000-0000-4000-8000-000000000011', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'P20-PACKAGE', current_date, 200, 34, 234),
  ('27000000-0000-4000-8000-000000000012', '20000000-0000-4000-8000-000000000002', '22000000-0000-4000-8000-000000000002', 'P20-TENANT-B', current_date, 10, 1.70, 11.70),
  ('27000000-0000-4000-8000-000000000015', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'P20-VAT-RATE', current_date, 50, 9, 59),
  ('27000000-0000-4000-8000-000000000016', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'P20-PRICE-BELOW', current_date, 820, 139.40, 959.40),
  ('27000000-0000-4000-8000-000000000017', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'P20-RECEIVED-NOT-INVOICED', current_date, 84, 14.28, 98.28),
  ('27000000-0000-4000-8000-000000000018', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'P20-CUMULATIVE-A', current_date, 30, 5.10, 35.10),
  ('27000000-0000-4000-8000-000000000019', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'P20-CUMULATIVE-B', current_date, 30, 5.10, 35.10),
  ('27000000-0000-4000-8000-000000000021', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'P20-REMAINING-CHOICE', current_date, 30, 5.10, 35.10),
  ('27000000-0000-4000-8000-000000000022', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'P20-PRODUCT-PRIORITY', current_date, 20, 3.40, 23.40),
  ('27000000-0000-4000-8000-000000000023', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'P20-SKU-PRIORITY', current_date, 20, 3.40, 23.40),
  ('27000000-0000-4000-8000-000000000024', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'P20-DUPLICATE-SCALE', current_date, 200, 34, 234),
  ('27000000-0000-4000-8000-000000000025', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'P20-HEADER-ARITHMETIC', current_date, 101, 18, 116),
  ('27000000-0000-4000-8000-000000000026', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'P20-LEGACY-HEADER-ARITHMETIC', current_date, 101, 18, 116),
  ('27000000-0000-4000-8000-000000000027', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'P20-DUPLICATE-IDENTITY', current_date, 20, 3.40, 23.40),
  ('27000000-0000-4000-8000-000000000028', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'P20-WRONG-SUPPLIER-LINK', current_date, 20, 3.40, 23.40),
  ('27000000-0000-4000-8000-000000000029', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'P20-HEADER-ONE-SHEKEL', current_date, 100, 17, 116),
  ('27000000-0000-4000-8000-000000000030', '20000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', 'P20-DUPLICATE-BARCODE', current_date, 20, 3.40, 23.40);
insert into public.invoice_order_links (org_id, invoice_id, order_id) values
  ('20000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000002', '24000000-0000-4000-8000-000000000002'),
  ('20000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000003', '24000000-0000-4000-8000-000000000002'),
  ('20000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000004', '24000000-0000-4000-8000-000000000003'),
  -- A second linked order with another product proves that an office user cannot turn a
  -- linked-order choice into a product-identity override.
  ('20000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000004', '24000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000005', '24000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000005', '24000000-0000-4000-8000-000000000002'),
  ('20000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000007', '24000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000008', '24000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000009', '24000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000010', '24000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000010', '24000000-0000-4000-8000-000000000002'),
  ('20000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000010', '24000000-0000-4000-8000-000000000003'),
  ('20000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000011', '24000000-0000-4000-8000-000000000004'),
  ('20000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000015', '24000000-0000-4000-8000-000000000003'),
  ('20000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000016', '24000000-0000-4000-8000-000000000002'),
  ('20000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000017', '24000000-0000-4000-8000-000000000005'),
  ('20000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000018', '24000000-0000-4000-8000-000000000006'),
  ('20000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000019', '24000000-0000-4000-8000-000000000006'),
  ('20000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000021', '24000000-0000-4000-8000-000000000007'),
  ('20000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000021', '24000000-0000-4000-8000-000000000008'),
  ('20000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000022', '24000000-0000-4000-8000-000000000007'),
  ('20000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000022', '24000000-0000-4000-8000-000000000009'),
  ('20000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000023', '24000000-0000-4000-8000-000000000007'),
  ('20000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000023', '24000000-0000-4000-8000-000000000009'),
  ('20000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000027', '24000000-0000-4000-8000-000000000010'),
  ('20000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000027', '24000000-0000-4000-8000-000000000011'),
  ('20000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000028', '24000000-0000-4000-8000-000000000007'),
  ('20000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000028', '24000000-0000-4000-8000-000000000012'),
  ('20000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000030', '24000000-0000-4000-8000-000000000013'),
  ('20000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000030', '24000000-0000-4000-8000-000000000014');

select pg_temp.p20_actor('21000000-0000-4000-8000-000000000001', false);
set local role authenticated;

select pg_temp.p20_assert(
  not (public.record_invoice_line_evidence(
    '28000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000001',
    '29000000-0000-4000-8000-000000000001', 'manual_entry', null, null,
    '21000000-0000-4000-8000-000000000001',
    jsonb_build_array(pg_temp.p20_line('Flour', 'SUP-FLOUR', null, '23000000-0000-4000-8000-000000000001', 18000, 'g', 0.042, 0, 17, 756)),
    'P20 reviewed gram evidence'
  )->>'idempotent')::boolean,
  'first evidence command must commit'
);
select pg_temp.p20_assert(
  (public.record_invoice_line_evidence(
    '28000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000001',
    '29000000-0000-4000-8000-000000000001', 'manual_entry', null, null,
    '21000000-0000-4000-8000-000000000001',
    jsonb_build_array(pg_temp.p20_line('Flour', 'SUP-FLOUR', null, '23000000-0000-4000-8000-000000000001', 18000, 'g', 0.042, 0, 17, 756)),
    'P20 reviewed gram evidence'
  )->>'idempotent')::boolean,
  'lost-response evidence retry must be idempotent'
);

select public.record_invoice_line_evidence(
  '28000000-0000-4000-8000-000000000002', '27000000-0000-4000-8000-000000000002',
  '29000000-0000-4000-8000-000000000002', 'manual_entry', null, null,
  '21000000-0000-4000-8000-000000000001',
  jsonb_build_array(pg_temp.p20_line('Flour', 'SUP-FLOUR', null, '23000000-0000-4000-8000-000000000001', 20, 'kg', 42.42, 0, 17, 848.40)),
  'P20 exact one-percent price evidence'
);
select public.record_invoice_line_evidence(
  '28000000-0000-4000-8000-000000000003', '27000000-0000-4000-8000-000000000003',
  '29000000-0000-4000-8000-000000000003', 'manual_entry', null, null,
  '21000000-0000-4000-8000-000000000001',
  jsonb_build_array(pg_temp.p20_line('Flour', 'SUP-FLOUR', null, '23000000-0000-4000-8000-000000000001', 20, 'kg', 42.43, 0, 17, 848.60)),
  'P20 above-tolerance price evidence'
);
select public.record_invoice_line_evidence(
  '28000000-0000-4000-8000-000000000004', '27000000-0000-4000-8000-000000000004',
  '29000000-0000-4000-8000-000000000004', 'manual_entry', null, null,
  '21000000-0000-4000-8000-000000000001',
  -- Mirrors automatically captured evidence: product_id is not trusted from the model and
  -- identity comes from the source barcode.
  jsonb_build_array(pg_temp.p20_line('Cans', null, '7290000000202', null, 11, 'unit', 5, 0, 17, 55)),
  'P20 exact-unit overage evidence'
);
select public.record_invoice_line_evidence(
  '28000000-0000-4000-8000-000000000005', '27000000-0000-4000-8000-000000000005',
  '29000000-0000-4000-8000-000000000005', 'manual_entry', null, null,
  '21000000-0000-4000-8000-000000000001',
  jsonb_build_array(pg_temp.p20_line('Flour', 'SUP-FLOUR', null, '23000000-0000-4000-8000-000000000001', 17, 'kg', 42, 0, 17, 714)),
  'P20 ambiguous multi-order evidence'
);
select public.record_invoice_line_evidence(
  '28000000-0000-4000-8000-000000000007', '27000000-0000-4000-8000-000000000007',
  '29000000-0000-4000-8000-000000000007', 'manual_entry', null, null,
  '21000000-0000-4000-8000-000000000001',
  jsonb_build_array(
    pg_temp.p20_line('First wording', 'SUP-FLOUR', null, '23000000-0000-4000-8000-000000000001', 9000, 'g', 0.042, 0, 17, 378, 1),
    pg_temp.p20_line('Different wording', 'SUP-FLOUR', null, '23000000-0000-4000-8000-000000000001', 9, 'kg', 42, 0, 17, 378, 2)
  ), 'P20 preserves duplicate lines as evidence'
);
select public.record_invoice_line_evidence(
  '28000000-0000-4000-8000-000000000008', '27000000-0000-4000-8000-000000000008',
  '29000000-0000-4000-8000-000000000008', 'manual_entry', null, null,
  '21000000-0000-4000-8000-000000000001',
  jsonb_build_array(pg_temp.p20_line('Flour', 'SUP-FLOUR', null, '23000000-0000-4000-8000-000000000001', 18.36, 'kg', 42, 0, 17, 771.12)),
  'P20 mass quantity at tolerance evidence'
);
select public.record_invoice_line_evidence(
  '28000000-0000-4000-8000-000000000009', '27000000-0000-4000-8000-000000000009',
  '29000000-0000-4000-8000-000000000009', 'manual_entry', null, null,
  '21000000-0000-4000-8000-000000000001',
  jsonb_build_array(pg_temp.p20_line('Flour', 'SUP-FLOUR', null, '23000000-0000-4000-8000-000000000001', 18.41, 'kg', 42, 0, 17, 773.22)),
  'P20 mass quantity above tolerance evidence'
);
select public.record_invoice_line_evidence(
  '28000000-0000-4000-8000-000000000010', '27000000-0000-4000-8000-000000000010',
  '29000000-0000-4000-8000-000000000010', 'manual_entry', null, null,
  '21000000-0000-4000-8000-000000000001',
  jsonb_build_array(
    pg_temp.p20_line('Flour split', 'SUP-FLOUR', null,
      '23000000-0000-4000-8000-000000000001', 38, 'kg', 42, 0, 17, 1596, 1),
    pg_temp.p20_line('Cans remain deterministic', 'SUP-CAN', null,
      '23000000-0000-4000-8000-000000000002', 10, 'unit', 5, 0, 17, 50, 2)
  ),
  'P20 one line spans two orders while another remains deterministic'
);
select public.record_invoice_line_evidence(
  '28000000-0000-4000-8000-000000000011', '27000000-0000-4000-8000-000000000011',
  '29000000-0000-4000-8000-000000000011', 'manual_entry', null, null,
  '21000000-0000-4000-8000-000000000001',
  jsonb_build_array(pg_temp.p20_line('Cases as units', 'SUP-CASE', null, '23000000-0000-4000-8000-000000000003', 2, 'unit', 100, 0, 17, 200)),
  'P20 unapproved package conversion evidence'
);
select public.record_invoice_line_evidence(
  '28000000-0000-4000-8000-000000000015', '27000000-0000-4000-8000-000000000015',
  '29000000-0000-4000-8000-000000000015', 'manual_entry', null, null,
  '21000000-0000-4000-8000-000000000001',
  jsonb_build_array(pg_temp.p20_line('Cans VAT mismatch', 'SUP-CAN', null,
    '23000000-0000-4000-8000-000000000002', 10, 'unit', 5, 0, 18, 50)),
  'P20 exact source VAT differs from organization expected rate'
);
select public.record_invoice_line_evidence(
  '28000000-0000-4000-8000-000000000016', '27000000-0000-4000-8000-000000000016',
  '29000000-0000-4000-8000-000000000016', 'manual_entry', null, null,
  '21000000-0000-4000-8000-000000000001',
  jsonb_build_array(pg_temp.p20_line('Flour below snapshot', 'SUP-FLOUR', null,
    '23000000-0000-4000-8000-000000000001', 20, 'kg', 41, 0, 17, 820)),
  'P20 lower price still exposes signed difference'
);
select public.record_invoice_line_evidence(
  '28000000-0000-4000-8000-000000000017', '27000000-0000-4000-8000-000000000017',
  '29000000-0000-4000-8000-000000000017', 'manual_entry', null, null,
  '21000000-0000-4000-8000-000000000001',
  jsonb_build_array(pg_temp.p20_line('Flour only', null, '7290000000201', null,
    2, 'kg', 42, 0, 17, 84)),
  'P20 invoice intentionally omits a second received item'
);
select public.record_invoice_line_evidence(
  '28000000-0000-4000-8000-000000000018', '27000000-0000-4000-8000-000000000018',
  '29000000-0000-4000-8000-000000000018', 'manual_entry', null, null,
  '21000000-0000-4000-8000-000000000001',
  jsonb_build_array(pg_temp.p20_line('First six cans', null, '7290000000202', null,
    6, 'unit', 5, 0, 17, 30)),
  'P20 first invoice consumes part of one receipt'
);
select public.record_invoice_line_evidence(
  '28000000-0000-4000-8000-000000000020', '27000000-0000-4000-8000-000000000019',
  '29000000-0000-4000-8000-000000000020', 'manual_entry', null, null,
  '21000000-0000-4000-8000-000000000001',
  jsonb_build_array(pg_temp.p20_line('Second six cans', null, '7290000000202',
    '23000000-0000-4000-8000-000000000002',
    6, 'unit', 5, 0, 17, 30)),
  'P20 second invoice would exceed the same receipt cumulatively'
);
select public.record_invoice_line_evidence(
  '28000000-0000-4000-8000-000000000021', '27000000-0000-4000-8000-000000000021',
  '29000000-0000-4000-8000-000000000021', 'manual_entry', null, null,
  '21000000-0000-4000-8000-000000000001',
  jsonb_build_array(pg_temp.p20_line('Six hierarchy units', null, null,
    '23000000-0000-4000-8000-000000000005', 6, 'unit', 5, 0, 17, 30)),
  'P20 remaining quantity uniquely selects the linked order with capacity'
);
select public.record_invoice_line_evidence(
  '28000000-0000-4000-8000-000000000022', '27000000-0000-4000-8000-000000000022',
  '29000000-0000-4000-8000-000000000022', 'manual_entry', null, null,
  '21000000-0000-4000-8000-000000000001',
  jsonb_build_array(pg_temp.p20_line('Product identity wins', 'SUP-HIER-B', '7290000000206',
    '23000000-0000-4000-8000-000000000005', 4, 'unit', 5, 0, 17, 20)),
  'P20 product identity outranks conflicting SKU and barcode'
);
select public.record_invoice_line_evidence(
  '28000000-0000-4000-8000-000000000023', '27000000-0000-4000-8000-000000000023',
  '29000000-0000-4000-8000-000000000023', 'manual_entry', null, null,
  '21000000-0000-4000-8000-000000000001',
  jsonb_build_array(pg_temp.p20_line('Supplier SKU wins', 'SUP-HIER-A', '7290000000206',
    null, 4, 'unit', 5, 0, 17, 20)),
  'P20 supplier SKU outranks a conflicting barcode when product identity is absent'
);
select public.record_invoice_line_evidence(
  '28000000-0000-4000-8000-000000000024', '27000000-0000-4000-8000-000000000024',
  '29000000-0000-4000-8000-000000000024', 'manual_entry', null, null,
  '21000000-0000-4000-8000-000000000001',
  (select jsonb_agg(pg_temp.p20_line(
     'Repeated scale line', null, null, '23000000-0000-4000-8000-000000000005',
     1, 'unit', 5, 0, 17, 5, series.line_number
   ) order by series.line_number)
   from generate_series(1, 40) series(line_number)),
  'P20 set-based duplicate detection scale fixture'
);
select public.record_invoice_line_evidence(
  '28000000-0000-4000-8000-000000000025', '27000000-0000-4000-8000-000000000025',
  '29000000-0000-4000-8000-000000000025', 'manual_entry', null, null,
  '21000000-0000-4000-8000-000000000001',
  jsonb_build_array(pg_temp.p20_line('Header identity mismatch', null, null,
    '23000000-0000-4000-8000-000000000005', 1, 'unit', 100, 0, 17, 100)),
  'P20 line totals are each within one shekel while the header identity is not'
);
select public.record_invoice_line_evidence(
  '28000000-0000-4000-8000-000000000027', '27000000-0000-4000-8000-000000000027',
  '29000000-0000-4000-8000-000000000027', 'manual_entry', null, null,
  '21000000-0000-4000-8000-000000000001',
  jsonb_build_array(pg_temp.p20_line('Ambiguous duplicate supplier SKU',
    'SUP-DUPLICATE', null, null, 4, 'unit', 5, 0, 17, 20)),
  'P20 duplicated supplier SKU must not select either product'
);
select public.record_invoice_line_evidence(
  '28000000-0000-4000-8000-000000000028', '27000000-0000-4000-8000-000000000028',
  '29000000-0000-4000-8000-000000000028', 'manual_entry', null, null,
  '21000000-0000-4000-8000-000000000001',
  jsonb_build_array(pg_temp.p20_line('Correct supplier only', null, null,
    '23000000-0000-4000-8000-000000000005', 4, 'unit', 5, 0, 17, 20)),
  'P20 a linked order from another supplier must not become a candidate'
);
select public.record_invoice_line_evidence(
  '28000000-0000-4000-8000-000000000030', '27000000-0000-4000-8000-000000000030',
  '29000000-0000-4000-8000-000000000030', 'manual_entry', null, null,
  '21000000-0000-4000-8000-000000000001',
  jsonb_build_array(pg_temp.p20_line('Ambiguous duplicate barcode',
    null, '7290000000209', null, 4, 'unit', 5, 0, 17, 20)),
  'P20 duplicated barcode must not select either product'
);

-- ===== Read-model reasons and tolerance boundaries =====

select pg_temp.p20_assert(
  public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000001')->>'status' = 'matched'
  and (public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000001')->>'approval_allowed')::boolean,
  'g-to-kg conversion with actual partial receipt should match'
);
select pg_temp.p20_assert(
  public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000002')->>'status' = 'matched_with_warnings'
  and (public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000002')->>'approval_allowed')::boolean
  and exists (select 1 from jsonb_array_elements(public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000002')->'reasons') r
    where r->>'code' = 'unit_price_within_tolerance'
      and (r->>'difference_amount')::numeric = 0.42
      and (r->>'difference_percent')::numeric = 1),
  'exactly one-percent higher price must warn without blocking'
);
select pg_temp.p20_assert(
  not (public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000003')->>'approval_allowed')::boolean
  and exists (select 1 from jsonb_array_elements(public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000003')->'reasons') r
    where r->>'code' = 'unit_price_above_order'
      and (r->>'difference_amount')::numeric = 0.43
      and (r->>'difference_percent')::numeric > 1),
  'price above one percent must block with a reason'
);
select pg_temp.p20_assert(
  (public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000016')->>'approval_allowed')::boolean
  and exists (select 1
    from jsonb_array_elements(public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000016')->'reasons') reason
    where reason->>'code' = 'unit_price_below_order'
      and (reason->>'difference_amount')::numeric = -1
      and (reason->>'difference_percent')::numeric < 0),
  'lower price must remain nonblocking and expose signed amount and percent differences'
);
select pg_temp.p20_assert(
  exists (select 1 from jsonb_array_elements(public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000004')->'reasons') r
    where r->>'code' in ('invoiced_quantity_above_ordered','invoiced_quantity_above_received')),
  'non-weight quantity must be exact and reject an overage'
);
select pg_temp.p20_assert(
  exists (select 1 from jsonb_array_elements(public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000005')->'reasons') r
    where r->>'code' = 'multi_order_ambiguity'),
  'multiple matching linked orders must require an explicit human allocation'
);
select pg_temp.p20_assert(
  public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000021')
    #>> '{lines,0,matches,0,purchase_order_item_id}' = '25000000-0000-4000-8000-000000000009'
  and not exists (
    select 1
    from jsonb_array_elements(
      public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000021')->'reasons') reason
    where reason->>'code' = 'multi_order_ambiguity'
  ),
  'remaining quantity did not uniquely select the only linked order item able to carry the line'
);
select pg_temp.p20_assert(
  public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000022')
    #>> '{lines,0,matches,0,purchase_order_item_id}' = '25000000-0000-4000-8000-000000000008'
  and public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000023')
    #>> '{lines,0,matches,0,purchase_order_item_id}' = '25000000-0000-4000-8000-000000000008',
  'identity collision ignored the product-to-SKU-to-barcode priority contract'
);
select pg_temp.p20_assert(
  exists (
    select 1
    from jsonb_array_elements(
      public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000027')->'reasons') reason
    where reason->>'code' = 'multi_order_ambiguity'
      and (reason->>'candidate_count')::integer = 2
  ),
  'duplicate supplier SKU selected a product instead of requiring review'
);
select pg_temp.p20_assert(
  exists (
    select 1
    from jsonb_array_elements(
      public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000030')->'reasons') reason
    where reason->>'code' = 'multi_order_ambiguity'
      and (reason->>'candidate_count')::integer = 2
  ),
  'duplicate barcode selected a product instead of requiring review'
);
select pg_temp.p20_assert(
  public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000028')
    #>> '{lines,0,matches,0,purchase_order_item_id}' = '25000000-0000-4000-8000-000000000008'
  and jsonb_array_length(
    public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000028')
      ->'candidate_context') = 1,
  'an invoice-linked purchase order from another supplier entered candidate matching'
);
select pg_temp.p20_assert(
  not (public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000025')
    ->>'approval_allowed')::boolean
  and exists (
    select 1
    from jsonb_array_elements(
      public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000025')->'reasons') reason
    where reason->>'code' = 'invoice_header_arithmetic_discrepancy'
      and (reason->>'expected_header_grand')::numeric = 119
      and (reason->>'actual_header_grand')::numeric = 116
      and (reason->>'difference_amount')::numeric = 3
  ),
  'separate one-shekel line comparisons hid a three-shekel invoice-header identity error'
);
select pg_temp.p20_assert(
  not (public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000026')
    ->>'approval_allowed')::boolean
  and exists (
    select 1
    from jsonb_array_elements(
      public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000026')->'reasons') reason
    where reason->>'code' = 'invoice_header_arithmetic_discrepancy'
  ),
  'legacy invoice without line evidence bypassed the invoice-header arithmetic identity'
);
select pg_temp.p20_assert(
  (public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000029')
    ->>'approval_allowed')::boolean
  and not exists (
    select 1
    from jsonb_array_elements(
      public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000029')->'reasons') reason
    where reason->>'code' = 'invoice_header_arithmetic_discrepancy'
  ),
  'an invoice-header identity difference of exactly one shekel exceeded its inclusive tolerance'
);
select public.set_invoice_review_status(
  '27000000-0000-4000-8000-000000000025', 'in_review',
  'P20 header arithmetic discrepancy enters review');
do $$
begin
  perform public.set_invoice_review_status(
    '27000000-0000-4000-8000-000000000025', 'approved',
    'P20 header arithmetic discrepancy must remain blocked');
  raise exception 'P20 invoice three-way assertion failed: invalid header arithmetic was approved';
exception when sqlstate '55000' then
  if sqlerrm <> 'invoice_approval_blocked_three_way_review' then raise; end if;
end
$$;

-- Scale regression: the old nested helper recomputed all candidates and approval JSON for every
-- pair of duplicate lines. The set-based cache must assess forty duplicate lines within one
-- bounded call; EXPLAIN ANALYZE records the actual execution path in the test artifact.
set local statement_timeout = '5s';
select pg_temp.p20_assert(
  jsonb_array_length(
    public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000024')->'lines') = 40
  and (select count(*) = 40
       from jsonb_array_elements(
         public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000024')->'lines') line
       where exists (
         select 1 from jsonb_array_elements(line->'reasons') reason
         where reason->>'code' = 'duplicate_invoice_line_suspected'
       )),
  'set-based duplicate cache did not preserve all forty duplicate-line warnings'
);
explain (analyze, costs off, summary on, format text)
select public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000024');
set local statement_timeout = 0;
select pg_temp.p20_assert(
  public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000006')->>'status' = 'not_comparable'
  and public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000006')->>'comparison_state' = 'not_comparable',
  'invoice without an order must be explicit not-comparable, not fake matched'
);
select pg_temp.p20_assert(
  exists (select 1 from jsonb_array_elements(public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000007')->'reasons') r
    where r->>'code' = 'duplicate_invoice_line_suspected' and r->>'severity' = 'warning')
  and jsonb_array_length(public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000007')->'lines') = 2
  and (public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000007')->>'approval_allowed')::boolean,
  'same identified product with normalized unit/quantity/price/VAT/total must warn, preserve both lines and never merge/block'
);
select pg_temp.p20_assert(
  (public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000008')->>'approval_allowed')::boolean
  and not (public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000009')->>'approval_allowed')::boolean
  and exists (select 1 from jsonb_array_elements(public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000009')->'reasons') r
    where r->>'code' = 'invoiced_quantity_above_received'),
  'mass/volume receipt comparison must enforce the relevant two-percent tolerance boundary'
);
select pg_temp.p20_assert(
  (public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000008')
    ->'order_items'->0->>'ordered_quantity_tolerance')::numeric = 0.4
  and (public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000008')
    ->'order_items'->0->>'received_quantity_tolerance')::numeric = 0.36,
  'ordered comparison must use two percent ordered while receipt comparison uses two percent actually received'
);
select pg_temp.p20_assert(
  exists (select 1 from jsonb_array_elements(public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000011')->'reasons') r
    where r->>'code' = 'unit_or_packaging_conversion_requires_review'),
  'packaging conversion without an approved contract must fail to manual review'
);
select pg_temp.p20_assert(
  exists (select 1
    from jsonb_array_elements(public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000015')->'reasons') reason
    where reason->>'code' = 'vat_rate_mismatch'
      and (reason->>'expected_vat_rate')::numeric = 17
      and (reason->>'actual_vat_rate')::numeric = 18
      and (reason->>'tolerance')::numeric = 0)
  and not (public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000015')->>'approval_allowed')::boolean,
  'line VAT must match the organization expected rate exactly while the invoice VAT sum keeps its separate one-shekel tolerance'
);
select pg_temp.p20_assert(
  public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000017')->>'status' = 'matched_with_warnings'
  and (public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000017')->>'approval_allowed')::boolean
  and exists (
    select 1
    from jsonb_array_elements(public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000017')->'reasons') reason
    where reason->>'code' = 'received_but_not_invoiced'
      and reason->>'purchase_order_item_id' = '25000000-0000-4000-8000-000000000006'
      and (reason->>'received_quantity')::numeric = 3
      and (reason->>'invoiced_quantity')::numeric = 0
  ),
  'a received linked order item with no invoice allocation must remain visible as a nonblocking warning'
);
select pg_temp.p20_assert(
  (public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000018')->>'approval_allowed')::boolean
  and (public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000019')->>'approval_allowed')::boolean,
  'unapproved invoices must be assessed independently before either consumes receipt quantity'
);
select public.set_invoice_review_status(
  '27000000-0000-4000-8000-000000000018', 'in_review',
  'P20 first cumulative invoice enters review');
select public.set_invoice_review_status(
  '27000000-0000-4000-8000-000000000018', 'approved',
  'P20 first cumulative invoice consumes approved receipt quantity');
select pg_temp.p20_assert(
  (select count(*) = 1
   from public.invoice_three_way_approval_snapshots
   where invoice_id = '27000000-0000-4000-8000-000000000018'
     and (assessment #>> '{order_items,0,current_invoice_quantity}')::numeric = 6),
  'approval did not append the immutable quantity-allocation snapshot'
);
reset role;
-- Live catalog identifiers may legitimately be corrected later. That must not rewrite the
-- already-approved invoice allocation used by cumulative matching.
update public.products
set barcode = '7290000000298'
where id = '23000000-0000-4000-8000-000000000002';
select pg_temp.p20_actor('21000000-0000-4000-8000-000000000001', false);
set local role authenticated;
select public.set_invoice_review_status(
  '27000000-0000-4000-8000-000000000019', 'in_review',
  'P20 second cumulative invoice enters review');
select pg_temp.p20_assert(
  not (public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000019')->>'approval_allowed')::boolean
  and exists (
    select 1
    from jsonb_array_elements(public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000019')->'reasons') reason
    where reason->>'code' = 'invoiced_quantity_above_received'
      and (reason->>'prior_approved_invoiced_quantity')::numeric = 6
      and (reason->>'current_invoice_quantity')::numeric = 6
      and (reason->>'invoiced_quantity')::numeric = 12
  ),
  'a second invoice must include prior approved allocations and block cumulative overbilling'
);
do $$
begin
  perform public.set_invoice_review_status(
    '27000000-0000-4000-8000-000000000019', 'approved',
    'P20 cumulative overbilling must remain blocked');
  raise exception 'P20 invoice three-way assertion failed: cumulative overbilling was approved';
exception when sqlstate '55000' then
  if sqlerrm <> 'invoice_approval_blocked_three_way_review' then raise; end if;
end
$$;

-- Explicit allocations can resolve one ambiguous order or span several linked orders.
reset role;
select pg_temp.p20_actor('21000000-0000-4000-8000-000000000002', false);
set local role authenticated;
do $$
begin
  perform public.record_invoice_line_matches(
    '28100000-0000-4000-8000-000000000004', '27000000-0000-4000-8000-000000000004',
    '28000000-0000-4000-8000-000000000004', '29100000-0000-4000-8000-000000000004',
    jsonb_build_array(jsonb_build_object(
      'invoice_line_id', (select id from public.invoice_lines
        where evidence_batch_id = '28000000-0000-4000-8000-000000000004'),
      'purchase_order_item_id', '25000000-0000-4000-8000-000000000001',
      'allocated_quantity', 11
    )), 'P20 adversarial office product mismatch allocation');
  raise exception 'P20 invoice three-way assertion failed: office assigned a barcode-identified line to another linked product';
exception when sqlstate '22023' then
  if sqlerrm <> 'invoice_line_match_invalid' then raise; end if;
end
$$;

reset role;
select pg_temp.p20_actor('21000000-0000-4000-8000-000000000001', false);
set local role authenticated;
select public.record_invoice_line_matches(
  '28100000-0000-4000-8000-000000000005', '27000000-0000-4000-8000-000000000005',
  '28000000-0000-4000-8000-000000000005', '29100000-0000-4000-8000-000000000005',
  jsonb_build_array(jsonb_build_object(
      'invoice_line_id', (select id from public.invoice_lines where evidence_batch_id = '28000000-0000-4000-8000-000000000005'),
      'purchase_order_item_id', '25000000-0000-4000-8000-000000000001',
      'allocated_quantity', 17
    )), 'P20 resolves deterministic multi-order ambiguity'
);
select pg_temp.p20_assert(
  public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000005')->>'status' = 'matched_with_warnings'
  and (public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000005')->>'approval_allowed')::boolean
  and not exists (
    select 1 from jsonb_array_elements(
      public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000005')->'reasons') reason
    where reason->>'code' = 'ambiguous_order_match'
  ),
  'explicit allocation must resolve ambiguity while preserving received-not-invoiced warnings'
);
select pg_temp.p20_assert(
  not (public.record_invoice_line_matches(
    '28100000-0000-4000-8000-000000000010', '27000000-0000-4000-8000-000000000010',
    '28000000-0000-4000-8000-000000000010', '29100000-0000-4000-8000-000000000010',
    jsonb_build_array(
      jsonb_build_object(
        'invoice_line_id', (select id from public.invoice_lines
          where evidence_batch_id = '28000000-0000-4000-8000-000000000010' and line_number = 1),
        'purchase_order_item_id', '25000000-0000-4000-8000-000000000001', 'allocated_quantity', 18),
      jsonb_build_object(
        'invoice_line_id', (select id from public.invoice_lines
          where evidence_batch_id = '28000000-0000-4000-8000-000000000010' and line_number = 1),
        'purchase_order_item_id', '25000000-0000-4000-8000-000000000002', 'allocated_quantity', 20)
    ), 'P20 allocates one line across two real orders'
  )->>'idempotent')::boolean,
  'first split-order allocation must commit'
);
select pg_temp.p20_assert(
  public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000010')->>'status' = 'matched'
  and jsonb_array_length(public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000010')->'lines'->0->'matches') = 2
  and jsonb_array_length(public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000010')->'lines'->1->'matches') = 1
  and public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000010') #>> '{lines,1,matches,0,source}' = 'deterministic',
  'explicit allocation for one line must preserve another line deterministic match'
);

-- ===== Role/tenant boundary =====

reset role;
select pg_temp.p20_actor('21000000-0000-4000-8000-000000000003', false);
set local role authenticated;
do $$
begin
  perform public.record_invoice_line_evidence(
    '28000000-0000-4000-8000-000000000006', '27000000-0000-4000-8000-000000000006',
    '29000000-0000-4000-8000-000000000006', 'manual_entry', null, null,
    '21000000-0000-4000-8000-000000000003',
    jsonb_build_array(pg_temp.p20_line('Not allowed', null, null, null, 1, 'unit', 100, 0, 17, 100)),
    'P20 kitchen mutation attempt');
  raise exception 'P20 invoice three-way assertion failed: kitchen wrote invoice evidence';
exception when sqlstate '42501' then
  if sqlerrm <> 'invoice_line_evidence_not_authorized' then raise; end if;
end
$$;
reset role;

select pg_temp.p20_actor('21000000-0000-4000-8000-000000000005', false);
set local role authenticated;
do $$
begin
  perform public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000001');
  raise exception 'P20 invoice three-way assertion failed: tenant B read tenant A assessment';
exception when sqlstate 'P0002' then null;
end
$$;
select pg_temp.p20_assert(
  (select count(*) from public.invoice_lines) = 0,
  'tenant B must not read tenant A immutable invoice lines'
);
reset role;

-- ===== Owner-only, step-up, assessment-bound and idempotent override =====

select pg_temp.p20_actor('21000000-0000-4000-8000-000000000002', true);
set local role authenticated;
do $$
declare v_read jsonb;
begin
  v_read := public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000003');
  perform public.override_invoice_three_way_match(
    '27000000-0000-4000-8000-000000000003', v_read->>'assessment_hash',
    '29200000-0000-4000-8000-000000000003', 'P20 office must not override');
  raise exception 'P20 invoice three-way assertion failed: office override succeeded';
exception when sqlstate '42501' then
  if sqlerrm <> 'invoice_three_way_override_not_authorized' then raise; end if;
end
$$;
reset role;

select pg_temp.p20_actor('21000000-0000-4000-8000-000000000001', false);
set local role authenticated;
do $$
declare v_read jsonb;
begin
  v_read := public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000003');
  perform public.override_invoice_three_way_match(
    '27000000-0000-4000-8000-000000000003', v_read->>'assessment_hash',
    '29200000-0000-4000-8000-000000000003', 'P20 stale authentication attempt');
  raise exception 'P20 invoice three-way assertion failed: stale owner override succeeded';
exception when sqlstate '42501' then
  if sqlerrm <> 'fresh_authentication_required' then raise; end if;
end
$$;
reset role;

select pg_temp.p20_actor('21000000-0000-4000-8000-000000000001', true);
set local role authenticated;
do $$
declare v_read jsonb; v_first jsonb; v_second jsonb;
begin
  v_read := public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000003');
  v_first := public.override_invoice_three_way_match(
    '27000000-0000-4000-8000-000000000003', v_read->>'assessment_hash',
    '29200000-0000-4000-8000-000000000003', 'P20 owner accepts reviewed price variance');
  v_second := public.override_invoice_three_way_match(
    '27000000-0000-4000-8000-000000000003', v_read->>'assessment_hash',
    '29200000-0000-4000-8000-000000000003', 'P20 owner accepts reviewed price variance');
  if (v_first->>'idempotent')::boolean or not (v_second->>'idempotent')::boolean then
    raise exception 'P20 invoice three-way assertion failed: override replay idempotency is wrong';
  end if;
end
$$;
select pg_temp.p20_assert(
  (select count(*) from public.invoice_three_way_overrides where invoice_id = '27000000-0000-4000-8000-000000000003') = 1
  and (select count(*) from public.audit_logs where action = 'invoice_three_way_match_overridden'
    and new_values->>'invoice_id' = '27000000-0000-4000-8000-000000000003') = 1
  and (public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000003')->>'approval_allowed')::boolean,
  'double override must create one immutable row and one audit record'
);

-- Approval is blocked without a current override and allowed with the exact current hash.
select public.set_invoice_review_status(
  '27000000-0000-4000-8000-000000000004', 'in_review', 'P20 enters review before approval guard');
select public.set_invoice_review_status(
  '27000000-0000-4000-8000-000000000003', 'in_review', 'P20 enters reviewed override before approval');
do $$
begin
  perform public.set_invoice_review_status(
    '27000000-0000-4000-8000-000000000004', 'approved', 'P20 must remain blocked');
  raise exception 'P20 invoice three-way assertion failed: blocked invoice was approved';
exception when sqlstate '55000' then
  if sqlerrm <> 'invoice_approval_blocked_three_way_review' then raise; end if;
end
$$;
select public.set_invoice_review_status(
  '27000000-0000-4000-8000-000000000003', 'approved', 'P20 approval after current owner override');
select pg_temp.p20_assert(
  (select review_status = 'approved' from public.invoices where id = '27000000-0000-4000-8000-000000000003'),
  'current owner override did not unlock the approved transition'
);

-- A later evidence revision changes the assessment hash and invalidates the earlier override.
do $$
declare v_before text; v_after text;
begin
  v_before := public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000009')->>'assessment_hash';
  perform public.override_invoice_three_way_match(
    '27000000-0000-4000-8000-000000000009', v_before,
    '29200000-0000-4000-8000-000000000009', 'P20 temporary reviewed quantity variance');
  perform public.record_invoice_line_evidence(
    '28000000-0000-4000-8000-000000000019', '27000000-0000-4000-8000-000000000009',
    '29000000-0000-4000-8000-000000000019', 'manual_entry', null, null,
    '21000000-0000-4000-8000-000000000001',
    jsonb_build_array(pg_temp.p20_line('Flour revised', 'SUP-FLOUR', null,
      '23000000-0000-4000-8000-000000000001', 18.42, 'kg', 42, 0, 17, 773.64)),
    'P20 reviewer supplied a new immutable interpretation');
  v_after := public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000009')->>'assessment_hash';
  if v_before = v_after
     or (public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000009')->>'override_active')::boolean then
    raise exception 'P20 invoice three-way assertion failed: new evidence did not invalidate override';
  end if;
end
$$;

-- Definite duplicate invoice is the one non-overridable outcome.
reset role;
insert into public.invoices (
  id, org_id, supplier_id, invoice_number, invoice_date,
  amount_before_vat, vat_amount, total_amount
) values (
  '27000000-0000-4000-8000-000000000013', '20000000-0000-4000-8000-000000000001',
  '22000000-0000-4000-8000-000000000001', 'P20-GOOD', current_date, 756, 128.52, 884.52
);
select pg_temp.p20_actor('21000000-0000-4000-8000-000000000001', true);
set local role authenticated;
do $$
declare v_read jsonb;
begin
  v_read := public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000013');
  if not (v_read->>'definite_duplicate_invoice')::boolean then
    raise exception 'P20 invoice three-way assertion failed: definite duplicate was not detected';
  end if;
  perform public.override_invoice_three_way_match(
    '27000000-0000-4000-8000-000000000013', v_read->>'assessment_hash',
    '29200000-0000-4000-8000-000000000013', 'P20 must reject duplicate override');
  raise exception 'P20 invoice three-way assertion failed: definite duplicate override succeeded';
exception when sqlstate '55000' then
  if sqlerrm <> 'definite_duplicate_invoice_cannot_be_overridden' then raise; end if;
end
$$;

-- Same idempotency key with different evidence is an explicit conflict.
do $$
begin
  perform public.record_invoice_line_evidence(
    '28000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000001',
    '29000000-0000-4000-8000-000000000001', 'manual_entry', null, null,
    '21000000-0000-4000-8000-000000000001',
    jsonb_build_array(pg_temp.p20_line('Changed replay', 'SUP-FLOUR', null,
      '23000000-0000-4000-8000-000000000001', 18, 'kg', 42, 0, 17, 756)),
    'P20 reviewed gram evidence');
  raise exception 'P20 invoice three-way assertion failed: conflicting evidence replay succeeded';
exception when sqlstate '55000' then
  if sqlerrm <> 'invoice_line_evidence_idempotency_conflict' then raise; end if;
end
$$;

-- The real automatic caller: apply_document_interpretation atomically emits this action row.
-- Complete exact line keys must create a document_interpretation evidence batch in the same
-- transaction; no browser or later polling step is involved.
reset role;
select pg_temp.p20_actor(null, false);
insert into public.invoices (
  id, org_id, supplier_id, invoice_number, invoice_date,
  amount_before_vat, vat_amount, total_amount
) values (
  '27000000-0000-4000-8000-000000000014', '20000000-0000-4000-8000-000000000001',
  '22000000-0000-4000-8000-000000000001', 'P20-DOCUMENT-LINES', current_date, 100, 17, 117
);
insert into public.invoice_order_links (org_id, invoice_id, order_id) values (
  '20000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000014',
  '24000000-0000-4000-8000-000000000004'
);
insert into public.documents (
  id, org_id, entity_type, entity_id, storage_path, file_name, mime_type,
  uploaded_by, supplier_id
) values (
  '2b000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
  'invoice', '27000000-0000-4000-8000-000000000014',
  '20000000-0000-4000-8000-000000000001/p20/document-lines.pdf',
  'document-lines.pdf', 'application/pdf', '21000000-0000-4000-8000-000000000001',
  '22000000-0000-4000-8000-000000000001'
);
insert into public.document_processing_jobs (
  id, org_id, document_id, requested_by, status, input_checksum
) values (
  '2c000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
  '2b000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001',
  'completed', 'etag:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
);
insert into public.document_extractions (
  id, org_id, job_id, document_id, engine, model, model_version,
  input_checksum, contract_version, payload
) values (
  '2d000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
  '2c000000-0000-4000-8000-000000000001', '2b000000-0000-4000-8000-000000000001',
  'fixture', 'fixture-ocr', '1.0.0', 'etag:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '1',
  jsonb_build_object(
    'schema_version', '1',
    'document', jsonb_build_object('page_count', 1, 'detected_languages', jsonb_build_array('he'),
      'plain_text', 'P20 complete invoice line', 'partial', false),
    'blocks', jsonb_build_array(jsonb_build_object(
      'id', 'block-line', 'page', 1, 'type', 'table',
      'bbox', jsonb_build_array(0,0,1,1), 'text', 'Case 1 x 100', 'confidence', 0.99)),
    'tables', '[]'::jsonb, 'marks', '[]'::jsonb
  )
);
insert into public.document_interpretations (
  id, org_id, job_id, extraction_id, document_id, interpreted_for_user_id,
  provider, model, prompt_version, schema_version, payload
) values (
  '2e000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
  '2c000000-0000-4000-8000-000000000001', '2d000000-0000-4000-8000-000000000001',
  '2b000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001',
  'openai', 'p20-fixture', 'interpret-document-p20-lines', '1',
  jsonb_build_object(
    'schema_version', '1', 'document_type', 'invoice', 'document_type_confidence', 0.99,
    'supplier', jsonb_build_object(
      'suggested_id', '22000000-0000-4000-8000-000000000001',
      'suggested_name', 'P20 supplier A', 'confidence', 0.99,
      'evidence_block_ids', jsonb_build_array('block-line')),
    'fields', '[]'::jsonb,
    'line_items', jsonb_build_array(jsonb_build_object(
      'source_row', 1,
      'values', jsonb_build_object(
        'product_name', 'Cases P20', 'barcode', '7290000000203',
        'quantity', 1, 'unit', 'case', 'unit_price', 100,
        'discount_amount', 0, 'vat_rate', 17, 'line_total', 100),
      'evidence_block_ids', jsonb_build_array('block-line'))),
    'suggested_annotations', '[]'::jsonb
  )
);

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
insert into public.document_auto_actions (
  id, org_id, document_id, interpretation_id, outcome, invoice_id, order_id, decision
) values (
  '2f000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001',
  '2b000000-0000-4000-8000-000000000001', '2e000000-0000-4000-8000-000000000001',
  'auto_applied', '27000000-0000-4000-8000-000000000014',
  '24000000-0000-4000-8000-000000000004', '{"source":"p20"}'::jsonb
);
reset role;
select pg_temp.p20_actor(null, false);
select pg_temp.p20_assert(
  (select source_type = 'document_interpretation'
     and document_id = '2b000000-0000-4000-8000-000000000001'
     and interpretation_id = '2e000000-0000-4000-8000-000000000001'
   from public.invoice_line_evidence_batches
   where id = '2e000000-0000-4000-8000-000000000001')
  and (select quantity = 1 and unit = 'case' and unit_price = 100
        and discount_amount = 0 and vat_rate = 17 and line_total = 100
       from public.invoice_lines
       where evidence_batch_id = '2e000000-0000-4000-8000-000000000001'),
  'complete automatic interpretation did not create exact immutable invoice-line evidence'
);

select pg_temp.p20_actor('21000000-0000-4000-8000-000000000001', false);
set local role authenticated;
select pg_temp.p20_assert(
  (public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000014')->>'approval_allowed')::boolean
  and public.get_invoice_three_way_match('27000000-0000-4000-8000-000000000014')->>'status' = 'matched_with_warnings',
  'automatically captured line evidence did not reach the owner three-way read model'
);
reset role;
select pg_temp.p20_actor(null, false);

rollback;
