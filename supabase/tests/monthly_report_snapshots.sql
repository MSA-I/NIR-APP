-- Immutable legal-entity monthly accountant snapshot acceptance.
-- Run only against a freshly reset disposable local database after migrations 0073-0074.
\set ON_ERROR_STOP on

begin;

create function pg_temp.snapshot_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'Monthly snapshot assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.snapshot_actor(p_user uuid, p_fresh_password boolean default true)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config(
    'request.jwt.claims',
    case when p_user is null then '{}'::jsonb else jsonb_build_object(
      'sub', p_user,
      'amr', case when p_fresh_password then jsonb_build_array(jsonb_build_object(
        'method', 'password', 'timestamp', extract(epoch from clock_timestamp())
      )) else '[]'::jsonb end
    ) end::text,
    true
  );
end
$$;

-- ===== Catalog, ACL, A1/A3/A5 and immutability contracts =====
select pg_temp.snapshot_assert(
  to_regclass('public.monthly_report_snapshots') is not null,
  'snapshot table is missing'
);
select pg_temp.snapshot_assert(
  (select relrowsecurity and relforcerowsecurity
   from pg_class where oid = 'public.monthly_report_snapshots'::regclass),
  'RLS and FORCE RLS must both be enabled'
);
select pg_temp.snapshot_assert(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.monthly_report_snapshots'::regclass
      and pg_get_constraintdef(oid)
        ilike 'FOREIGN KEY (org_id, unit_id)%org_units(org_id, id)%'
  ),
  'tenant-composite legal-entity foreign key is missing'
);
select pg_temp.snapshot_assert(
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.monthly_report_snapshots'::regclass
      and pg_get_constraintdef(oid)
        ilike 'UNIQUE (org_id, unit_id, report_month, version)%'
  ),
  'version uniqueness is not legal-entity scoped'
);
select pg_temp.snapshot_assert(
  exists (
    select 1 from private.scope_registry
    where table_name = 'monthly_report_snapshots'
      and scope_class = 'legal_entity' and enforced
  ),
  'A1 registry classification is missing or not enforced'
);
select pg_temp.snapshot_assert(
  exists (
    select 1
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'monthly_report_snapshots'
      and p.polname = 'scope_rider_monthly_report_snapshots'
      and not p.polpermissive and p.polcmd = '*' and p.polroles = '{0}'::oid[]
      and pg_get_expr(p.polqual, p.polrelid)
        = '((unit_id IS NULL) OR (unit_id = ANY (auth_scopes())))'
  ),
  'A3 restrictive scope rider is missing or non-canonical'
);
select pg_temp.snapshot_assert(
  not exists (select 1 from private.scope_enforcement_violations()),
  '0074 left an A1, A3 or A5 violation'
);
select pg_temp.snapshot_assert(
  has_table_privilege('authenticated', 'public.monthly_report_snapshots', 'SELECT')
    and not has_table_privilege('authenticated', 'public.monthly_report_snapshots', 'INSERT')
    and not has_table_privilege('authenticated', 'public.monthly_report_snapshots', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.monthly_report_snapshots', 'DELETE'),
  'authenticated clients must be command-only writers'
);
select pg_temp.snapshot_assert(
  exists (
    select 1 from private.domain_event_map
    where action = 'monthly_report_snapshot_created'
      and entity_type = 'monthly_report_snapshots'
      and event_type = 'monthly_report.snapshot_created'
  ),
  'snapshot audit-to-domain-event mapping is missing'
);
select pg_temp.snapshot_assert(
  to_regclass('public.monthly_report_snapshot_deliveries') is not null
    and (select relrowsecurity and relforcerowsecurity
         from pg_class where oid = 'public.monthly_report_snapshot_deliveries'::regclass),
  'immutable snapshot delivery ledger or its forced RLS is missing'
);
select pg_temp.snapshot_assert(
  exists (
    select 1 from private.scope_registry
    where table_name = 'monthly_report_snapshot_deliveries'
      and scope_class = 'legal_entity' and enforced
  ),
  'delivery ledger legal-entity scope is not enforced'
);
select pg_temp.snapshot_assert(
  has_table_privilege('authenticated', 'public.monthly_report_snapshot_deliveries', 'SELECT')
    and not has_table_privilege('authenticated', 'public.monthly_report_snapshot_deliveries', 'INSERT')
    and not has_table_privilege('authenticated', 'public.monthly_report_snapshot_deliveries', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.monthly_report_snapshot_deliveries', 'DELETE'),
  'authenticated clients must be command-only delivery writers'
);
select pg_temp.snapshot_assert(
  (
    length(pg_get_functiondef(
      'public.create_monthly_report_snapshot(date,uuid)'::regprocedure
    ))
    - length(replace(pg_get_functiondef(
      'public.create_monthly_report_snapshot(date,uuid)'::regprocedure
    ), 'assert_recent_password_authentication', ''))
  ) / length('assert_recent_password_authentication') >= 2
  and position(
    'assert_recent_password_authentication'
    in substring(
      pg_get_functiondef('public.create_monthly_report_snapshot(date,uuid)'::regprocedure)
      from position(
        'pg_advisory_xact_lock'
        in pg_get_functiondef('public.create_monthly_report_snapshot(date,uuid)'::regprocedure)
      )
    )
  ) > 0,
  'snapshot creation must re-check fresh password authentication after the advisory wait'
);
select pg_temp.snapshot_assert(
  position('private.credit_request_legal_entity' in pg_get_functiondef(
    'public.create_monthly_report_snapshot(date,uuid)'::regprocedure
  )) > 0,
  'snapshot command does not reuse the 0073 supplier-aware credit resolver'
);
select pg_temp.snapshot_assert(
  position('review_status = ''approved''' in pg_get_functiondef(
    'public.create_monthly_report_snapshot(date,uuid)'::regprocedure
  )) = 0,
  'snapshot still applies an approved-only invoice boundary'
);
select pg_temp.snapshot_assert(
  position('assert_recent_password_authentication' in pg_get_functiondef(
    'public.mark_monthly_report_snapshot_sent(uuid,text)'::regprocedure
  )) > 0
    and position('into v_visible_unit' in lower(pg_get_functiondef(
      'public.mark_monthly_report_snapshot_sent(uuid,text)'::regprocedure
    ))) > 0
    and position('public.auth_scopes()' in pg_get_functiondef(
      'public.mark_monthly_report_snapshot_sent(uuid,text)'::regprocedure
    )) > 0
    and position('into v_visible_unit' in lower(pg_get_functiondef(
      'public.mark_monthly_report_snapshot_sent(uuid,text)'::regprocedure
    ))) < position('for update' in lower(pg_get_functiondef(
      'public.mark_monthly_report_snapshot_sent(uuid,text)'::regprocedure
    )))
    and position('from public.invoices' in lower(pg_get_functiondef(
      'public.mark_monthly_report_snapshot_sent(uuid,text)'::regprocedure
    ))) = 0,
  'delivery command must pre-bind through auth_scopes before locking and remain step-up protected'
);
select pg_temp.snapshot_assert(
  (
    select position('auth.uid()' in after_lock) > 0
       and position('auth_org()' in after_lock) > 0
       and position('auth_role()' in after_lock) > 0
       and position('assert_unit_in_scope' in after_lock) > 0
       and position('assert_recent_password_authentication' in after_lock) > 0
    from (
      select substring(definition from position('for update' in definition)) as after_lock
      from (
        select lower(pg_get_functiondef(
          'public.mark_monthly_report_snapshot_sent(uuid,text)'::regprocedure
        )) as definition
      ) source
    ) locked
  ),
  'delivery command must re-check actor, tenant, role, scope and step-up after the row lock wait'
);

-- ===== Fixture: two tenants and two sibling legal entities in tenant A =====
insert into public.organizations (id, name, status) values
  ('a5740000-0000-0000-0000-000000000001', 'Snapshot tenant A', 'active'),
  ('a5740000-0000-0000-0000-000000000002', 'Snapshot tenant B', 'active');

select id as root from public.org_units
where org_id = 'a5740000-0000-0000-0000-000000000001' and unit_type = 'root'
\gset snap_
select id as le1 from public.org_units
where org_id = 'a5740000-0000-0000-0000-000000000001' and unit_type = 'legal_entity'
order by created_at, id limit 1
\gset snap_
select id as branch1 from public.org_units
where org_id = 'a5740000-0000-0000-0000-000000000001' and unit_type = 'branch'
order by created_at, id limit 1
\gset snap_
select id as warehouse1 from public.org_units
where org_id = 'a5740000-0000-0000-0000-000000000001' and unit_type = 'warehouse'
order by created_at, id limit 1
\gset snap_
select id as le_b from public.org_units
where org_id = 'a5740000-0000-0000-0000-000000000002' and unit_type = 'legal_entity'
order by created_at, id limit 1
\gset snap_

-- psql does not interpolate variables inside dollar-quoted DO bodies. Mirror the dynamic
-- fixture identity into a transaction-local setting for those blocks.
select set_config('monthly_snapshot_test.le1', :'snap_le1', true);

insert into public.org_units (id, org_id, parent_id, unit_type, name) values
  ('b5740000-0000-0000-0000-000000000002', 'a5740000-0000-0000-0000-000000000001',
   :'snap_root', 'legal_entity', 'ישות משפטית שנייה');

insert into auth.users (id, email) values
  ('c5740000-0000-0000-0000-000000000001', 'snapshot-owner-a@example.test'),
  ('c5740000-0000-0000-0000-000000000002', 'snapshot-accountant-a@example.test'),
  ('c5740000-0000-0000-0000-000000000003', 'snapshot-office-a@example.test'),
  ('c5740000-0000-0000-0000-000000000004', 'snapshot-payer-a@example.test'),
  ('c5740000-0000-0000-0000-000000000005', 'snapshot-owner-b@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('c5740000-0000-0000-0000-000000000001', 'a5740000-0000-0000-0000-000000000001', 'Snapshot owner A', 'owner'),
  ('c5740000-0000-0000-0000-000000000002', 'a5740000-0000-0000-0000-000000000001', 'Snapshot accountant A', 'accountant'),
  ('c5740000-0000-0000-0000-000000000003', 'a5740000-0000-0000-0000-000000000001', 'Snapshot office A', 'office'),
  ('c5740000-0000-0000-0000-000000000004', 'a5740000-0000-0000-0000-000000000001', 'Snapshot payer A', 'payer'),
  ('c5740000-0000-0000-0000-000000000005', 'a5740000-0000-0000-0000-000000000002', 'Snapshot owner B', 'owner');

-- Accountant A sees only the first legal-entity subtree, not its sibling.
delete from public.user_scope_grants
where org_id = 'a5740000-0000-0000-0000-000000000001'
  and user_id = 'c5740000-0000-0000-0000-000000000002';
insert into public.user_scope_grants (org_id, user_id, unit_id) values
  ('a5740000-0000-0000-0000-000000000001', 'c5740000-0000-0000-0000-000000000002', :'snap_le1');

insert into public.suppliers (id, org_id, name) values
  ('d5740000-0000-0000-0000-000000000001', 'a5740000-0000-0000-0000-000000000001', 'Snapshot supplier A'),
  ('d5740000-0000-0000-0000-000000000002', 'a5740000-0000-0000-0000-000000000002', 'Snapshot supplier B');
insert into public.products (id, org_id, name) values
  ('e5740000-0000-0000-0000-000000000001', 'a5740000-0000-0000-0000-000000000001', 'Snapshot product');

insert into public.invoices (
  id, org_id, unit_id, supplier_id, invoice_number, invoice_date, received_by,
  amount_before_vat, vat_amount, total_amount, review_status, payment_status
) values
  ('f5740000-0000-0000-0000-000000000001', 'a5740000-0000-0000-0000-000000000001', :'snap_le1',
   'd5740000-0000-0000-0000-000000000001', 'SNAP-LE1', '2026-08-02',
   'c5740000-0000-0000-0000-000000000001', 100, 18, 118, 'received', 'unpaid'),
  ('f5740000-0000-0000-0000-000000000002', 'a5740000-0000-0000-0000-000000000001',
   'b5740000-0000-0000-0000-000000000002', 'd5740000-0000-0000-0000-000000000001',
   'SNAP-LE2', '2026-08-03', 'c5740000-0000-0000-0000-000000000001',
   200, 36, 236, 'in_review', 'unpaid');

-- Persist the same immutable 0106 approval assessment used by production rather than seeding an
-- already-approved row that bypasses the invoice approval guard.
select pg_temp.snapshot_actor('c5740000-0000-0000-0000-000000000001');
set local role authenticated;
select public.set_invoice_review_status(
  'f5740000-0000-0000-0000-000000000001', 'in_review', '0074 trusted fixture review started'
);
select public.set_invoice_review_status(
  'f5740000-0000-0000-0000-000000000001', 'approved', '0074 trusted fixture approved'
);
reset role;
select pg_temp.snapshot_actor(null);

insert into public.payments (
  id, org_id, unit_id, supplier_id, amount, paid_date, method, reference, executed_by
) values
  -- unit_id values are deliberately swapped. 0056's dimension default is not authoritative;
  -- allocations below must determine the reporting entity.
  ('05740000-0000-0000-0000-000000000001', 'a5740000-0000-0000-0000-000000000001',
   'b5740000-0000-0000-0000-000000000002',
   'd5740000-0000-0000-0000-000000000001', 40, '2026-08-04', 'bank', 'SNAP-REF',
   'c5740000-0000-0000-0000-000000000001'),
  ('05740000-0000-0000-0000-000000000002', 'a5740000-0000-0000-0000-000000000001',
   :'snap_le1', 'd5740000-0000-0000-0000-000000000001',
   20, '2026-07-04', 'bank', 'SNAP-LE2-REF', 'c5740000-0000-0000-0000-000000000001');

insert into public.payment_allocations (
  id, org_id, payment_id, invoice_id, amount
) values
  ('a5741000-0000-0000-0000-000000000001', 'a5740000-0000-0000-0000-000000000001',
   '05740000-0000-0000-0000-000000000001', 'f5740000-0000-0000-0000-000000000001', 40),
  ('a5741000-0000-0000-0000-000000000002', 'a5740000-0000-0000-0000-000000000001',
   '05740000-0000-0000-0000-000000000002', 'f5740000-0000-0000-0000-000000000002', 20);

insert into public.purchase_orders (id, org_id, unit_id, supplier_id, status, created_by) values
  ('25740000-0000-0000-0000-000000000001', 'a5740000-0000-0000-0000-000000000001', :'snap_branch1',
   'd5740000-0000-0000-0000-000000000001', 'confirmed', 'c5740000-0000-0000-0000-000000000001');
insert into public.purchase_order_items (id, org_id, order_id, product_id, qty, unit_price) values
  ('35740000-0000-0000-0000-000000000001', 'a5740000-0000-0000-0000-000000000001',
   '25740000-0000-0000-0000-000000000001', 'e5740000-0000-0000-0000-000000000001', 1, 5);
insert into public.goods_receipts (id, org_id, unit_id, order_id, status, received_by, received_at) values
  ('45740000-0000-0000-0000-000000000001', 'a5740000-0000-0000-0000-000000000001', :'snap_warehouse1',
   '25740000-0000-0000-0000-000000000001', 'completed', 'c5740000-0000-0000-0000-000000000001',
   '2026-08-03 10:00:00+03');
insert into public.goods_receipt_items (
  id, org_id, receipt_id, order_item_id, product_id, qty_received, status
) values (
  '55740000-0000-0000-0000-000000000001', 'a5740000-0000-0000-0000-000000000001',
  '45740000-0000-0000-0000-000000000001', '35740000-0000-0000-0000-000000000001',
  'e5740000-0000-0000-0000-000000000001', 1, 'full'
);

-- One invoice-derived credit and one receipt-derived credit resolve to the same LE1.
insert into public.credit_requests (
  id, org_id, supplier_id, invoice_id, receipt_item_id, reason, amount, status, created_by, created_at
) values
  ('15740000-0000-0000-0000-000000000001', 'a5740000-0000-0000-0000-000000000001',
   'd5740000-0000-0000-0000-000000000001', 'f5740000-0000-0000-0000-000000000001', null,
   'wrong_price', 10, 'open', 'c5740000-0000-0000-0000-000000000001', '2026-08-04 10:00:00+03'),
  ('15740000-0000-0000-0000-000000000002', 'a5740000-0000-0000-0000-000000000001',
   'd5740000-0000-0000-0000-000000000001', null, '55740000-0000-0000-0000-000000000001',
   'damaged', 5, 'open', 'c5740000-0000-0000-0000-000000000001', '2026-08-04 11:00:00+03');

insert into public.bank_imports (
  id, org_id, filename, file_hash, column_mapping, row_count, imported_by
) values (
  '65740000-0000-0000-0000-000000000001', 'a5740000-0000-0000-0000-000000000001',
  'snapshot.csv', repeat('5', 64), '{}'::jsonb, 1, 'c5740000-0000-0000-0000-000000000001'
);
insert into public.bank_transactions (
  id, org_id, import_id, tx_date, description, amount, raw, status, row_hash
) values (
  '75740000-0000-0000-0000-000000000001', 'a5740000-0000-0000-0000-000000000001',
  '65740000-0000-0000-0000-000000000001', '2026-08-05', 'Snapshot bank row', 40,
  '{}'::jsonb, 'matched', repeat('6', 64)
);
insert into public.bank_allocations (
  id, org_id, bank_transaction_id, payment_id, amount, confirmed, created_by
) values (
  '85740000-0000-0000-0000-000000000001', 'a5740000-0000-0000-0000-000000000001',
  '75740000-0000-0000-0000-000000000001', '05740000-0000-0000-0000-000000000001', 40, true,
  'c5740000-0000-0000-0000-000000000001'
);
insert into public.exceptions (id, org_id, type, status, title, supplier_id, invoice_id) values (
  '95740000-0000-0000-0000-000000000001', 'a5740000-0000-0000-0000-000000000001',
  'amount_mismatch', 'open', 'Snapshot exception', 'd5740000-0000-0000-0000-000000000001',
  'f5740000-0000-0000-0000-000000000001'
);

-- ===== Authorized creation, exact stored values, audit and event =====
select pg_temp.snapshot_actor('c5740000-0000-0000-0000-000000000001', false);
set local role authenticated;
do $$
begin
  perform public.create_monthly_report_snapshot(
    '2026-08-01', current_setting('monthly_snapshot_test.le1')::uuid
  );
  raise exception 'snapshot test failure: creation without fresh password was accepted';
exception when insufficient_privilege then
  if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
end
$$;
reset role;

select pg_temp.snapshot_actor('c5740000-0000-0000-0000-000000000001');
set local role authenticated;
do $$
declare v_snapshot public.monthly_report_snapshots;
begin
  v_snapshot := public.create_monthly_report_snapshot(
    '2026-08-01', current_setting('monthly_snapshot_test.le1')::uuid
  );
  perform pg_temp.snapshot_assert(v_snapshot.version = 1, 'owner did not create LE1 version 1');
  perform pg_temp.snapshot_assert(
    v_snapshot.unit_id = current_setting('monthly_snapshot_test.le1')::uuid,
    'stored legal entity differs from command'
  );
  perform pg_temp.snapshot_assert(v_snapshot.organization_name = 'Snapshot tenant A', 'organization metadata mismatch');
  perform pg_temp.snapshot_assert(v_snapshot.legal_entity_name = 'ישות משפטית ראשית', 'legal-entity name was not captured');
  perform pg_temp.snapshot_assert((v_snapshot.totals ->> 'invoice_count')::integer = 1, 'LE1 invoice count mismatch');
  perform pg_temp.snapshot_assert((v_snapshot.totals ->> 'invoice_total')::numeric = 118, 'LE1 invoice total mismatch');
  perform pg_temp.snapshot_assert((v_snapshot.totals ->> 'payment_total')::numeric = 40, 'LE1 payment total mismatch');
  perform pg_temp.snapshot_assert((v_snapshot.totals ->> 'credit_total')::numeric = 15, 'derived credit total mismatch');
  perform pg_temp.snapshot_assert((v_snapshot.totals ->> 'exception_count')::integer = 1, 'attributed exception mismatch');
  perform pg_temp.snapshot_assert((v_snapshot.totals ->> 'bank_transaction_count')::integer = 1, 'bank row count mismatch');
  perform pg_temp.snapshot_assert(jsonb_array_length(v_snapshot.bank_rows) = 1, 'structured bank detail is missing');
  perform pg_temp.snapshot_assert(
    v_snapshot.invoice_rows -> 0 ->> 'review_status_label' = 'מאושרת'
      and v_snapshot.credit_rows -> 0 ? 'reason_label'
      and v_snapshot.exception_rows -> 0 ? 'type_label'
      and v_snapshot.bank_rows -> 0 ? 'status_label',
    'export display labels were not frozen in snapshot rows'
  );
  perform set_config('monthly_snapshot_test.snapshot1', v_snapshot.id::text, true);

  v_snapshot := public.create_monthly_report_snapshot(
    '2026-08-01', 'b5740000-0000-0000-0000-000000000002'
  );
  perform set_config('monthly_snapshot_test.snapshot2', v_snapshot.id::text, true);
  perform pg_temp.snapshot_assert(v_snapshot.version = 1, 'LE2 must have an independent version sequence');
  perform pg_temp.snapshot_assert((v_snapshot.totals ->> 'invoice_total')::numeric = 236, 'LE2 leaked or lost invoice data');
  perform pg_temp.snapshot_assert(
    v_snapshot.invoice_rows -> 0 ->> 'review_status' = 'in_review',
    'non-approved invoice from the live report boundary was omitted'
  );
end
$$;
reset role;

-- Delivery is derived from the locked snapshot identity, is step-up protected and replay-safe.
select pg_temp.snapshot_actor('c5740000-0000-0000-0000-000000000001', false);
set local role authenticated;
do $$
begin
  perform public.mark_monthly_report_snapshot_sent(
    current_setting('monthly_snapshot_test.snapshot1')::uuid,
    'ניסיון ללא אימות טרי'
  );
  raise exception 'snapshot test failure: delivery without fresh password was accepted';
exception when insufficient_privilege then
  if sqlerrm not like '%fresh_authentication_required%' then raise; end if;
end
$$;
reset role;

select pg_temp.snapshot_actor('c5740000-0000-0000-0000-000000000001');
set local role authenticated;
do $$
declare v_result jsonb;
begin
  v_result := public.mark_monthly_report_snapshot_sent(
    current_setting('monthly_snapshot_test.snapshot1')::uuid,
    'נמסר לרואת החשבון לבדיקה'
  );
  perform pg_temp.snapshot_assert(not (v_result ->> 'idempotent')::boolean, 'first delivery was reported as replay');

  v_result := public.mark_monthly_report_snapshot_sent(
    current_setting('monthly_snapshot_test.snapshot1')::uuid,
    'נמסר לרואת החשבון לבדיקה'
  );
  perform pg_temp.snapshot_assert((v_result ->> 'idempotent')::boolean, 'identical delivery replay was not idempotent');

  begin
    perform public.mark_monthly_report_snapshot_sent(
      current_setting('monthly_snapshot_test.snapshot1')::uuid,
      'סיבה סותרת'
    );
    raise exception 'snapshot test failure: conflicting delivery replay was accepted';
  exception when others then
    if sqlerrm not like '%monthly_report_snapshot_delivery_replay_conflict%' then raise; end if;
  end;
end
$$;
reset role;

select pg_temp.snapshot_assert(
  (select count(*) = 1 and bool_and(delivery.content_hash = snapshot.content_hash)
   from public.monthly_report_snapshot_deliveries delivery
   join public.monthly_report_snapshots snapshot on snapshot.id = delivery.snapshot_id
   where delivery.snapshot_id = current_setting('monthly_snapshot_test.snapshot1')::uuid),
  'delivery replay created duplicate ledger rows'
);
select pg_temp.snapshot_assert(
  (select count(*) = 1
   from public.audit_logs
   where action = 'monthly_report_snapshot_sent'
     and new_values ->> 'snapshot_id' = current_setting('monthly_snapshot_test.snapshot1')),
  'delivery replay created duplicate or missing audit rows'
);
select pg_temp.snapshot_assert(
  (select count(*) = 1
   from public.domain_events
   where event_type = 'monthly_report.snapshot_sent'
     and payload ->> 'snapshot_id' = current_setting('monthly_snapshot_test.snapshot1')),
  'delivery audit did not emit exactly one domain event'
);

select pg_temp.snapshot_assert(
  (select content_hash = encode(sha256(convert_to(jsonb_build_object(
    'report_version', report_version,
    'organization_id', org_id,
    'organization_name', organization_name,
    'legal_entity_id', unit_id,
    'legal_entity_name', legal_entity_name,
    'report_month', report_month,
    'invoice_rows', invoice_rows,
    'payment_rows', payment_rows,
    'credit_rows', credit_rows,
    'exception_rows', exception_rows,
    'bank_rows', bank_rows,
    'totals', totals
  )::text, 'UTF8')), 'hex')
   from public.monthly_report_snapshots
   where org_id = 'a5740000-0000-0000-0000-000000000001'
     and unit_id = :'snap_le1' and version = 1),
  'stored checksum does not match canonical snapshot content'
);
select pg_temp.snapshot_assert(
  exists (
    select 1 from public.audit_logs a
    join public.monthly_report_snapshots s on s.id = a.entity_id
    where s.org_id = 'a5740000-0000-0000-0000-000000000001'
      and s.unit_id = :'snap_le1' and s.version = 1
      and a.action = 'monthly_report_snapshot_created'
      and a.user_id = 'c5740000-0000-0000-0000-000000000001'
      and a.new_values ->> 'unit_id' = :'snap_le1'
      and a.new_values ->> 'report_month' = '2026-08-01'
      and (a.new_values ->> 'version')::integer = 1
      and a.new_values ->> 'snapshot_id' = s.id::text
  ),
  'audit row lacks creator, unit, month, version or snapshot id'
);
select pg_temp.snapshot_assert(
  exists (
    select 1 from public.domain_events e
    join public.monthly_report_snapshots s on s.id = e.entity_id
    where s.org_id = 'a5740000-0000-0000-0000-000000000001'
      and s.unit_id = :'snap_le1' and s.version = 1
      and e.event_type = 'monthly_report.snapshot_created'
      and e.unit_id = :'snap_le1'
      and e.payload ->> 'content_hash' = s.content_hash
  ),
  'audit fan-out did not emit the scoped snapshot event atomically'
);

-- ===== Snapshot stability and explicit later versions =====
select pg_temp.snapshot_actor(null);
update public.invoices set amount_before_vat = 200, vat_amount = 36, total_amount = 236
where id = 'f5740000-0000-0000-0000-000000000001';
update public.suppliers set name = 'Snapshot supplier changed'
where id = 'd5740000-0000-0000-0000-000000000001';

select pg_temp.snapshot_assert(
  (select (totals ->> 'invoice_total')::numeric = 118
      and invoice_rows -> 0 -> 'supplier' ->> 'name' = 'Snapshot supplier A'
   from public.monthly_report_snapshots
   where org_id = 'a5740000-0000-0000-0000-000000000001'
     and unit_id = :'snap_le1' and version = 1),
  'live changes altered historical version 1'
);

select pg_temp.snapshot_actor('c5740000-0000-0000-0000-000000000001');
set local role authenticated;
do $$
declare v_snapshot public.monthly_report_snapshots;
begin
  v_snapshot := public.create_monthly_report_snapshot(
    '2026-08-01', current_setting('monthly_snapshot_test.le1')::uuid
  );
  perform pg_temp.snapshot_assert(v_snapshot.version = 2, 'explicit later creation did not allocate version 2');
  perform pg_temp.snapshot_assert((v_snapshot.totals ->> 'invoice_total')::numeric = 236, 'version 2 did not capture new live total');
end
$$;
reset role;

-- The legal-entity-scoped accountant can create LE1 version 3 and see only LE1 versions.
select pg_temp.snapshot_actor('c5740000-0000-0000-0000-000000000002');
set local role authenticated;
select pg_temp.snapshot_assert(
  (select count(*) = 1 and bool_and(id = :'snap_le1'::uuid)
   from public.read_monthly_report_legal_entities()),
  'narrow legal-entity reader exposed a sibling unit'
);
do $$
declare v_snapshot public.monthly_report_snapshots;
begin
  v_snapshot := public.create_monthly_report_snapshot(
    '2026-08-01', current_setting('monthly_snapshot_test.le1')::uuid
  );
  perform pg_temp.snapshot_assert(v_snapshot.version = 3, 'accountant could not create an authorized later version');
end
$$;
select pg_temp.snapshot_assert(
  (select count(*) = 3 and count(*) filter (
     where unit_id = 'b5740000-0000-0000-0000-000000000002') = 0
   from public.monthly_report_snapshots
   where report_month = '2026-08-01'),
  'restrictive rider exposed another legal entity snapshot'
);
do $$
begin
  perform public.create_monthly_report_snapshot(
    '2026-08-01', 'b5740000-0000-0000-0000-000000000002'
  );
  raise exception 'snapshot test failure: out-of-scope legal entity was accepted';
exception when others then
  if sqlerrm not like '%unit_out_of_scope%' then raise; end if;
end
$$;
do $$
begin
  perform public.mark_monthly_report_snapshot_sent(
    current_setting('monthly_snapshot_test.snapshot2')::uuid,
    'sibling scope must stay unknown'
  );
  raise exception 'snapshot test failure: sibling-scope delivery was accepted';
exception when no_data_found then
  if sqlerrm not like '%monthly_report_snapshot_delivery_unknown%' then raise; end if;
end
$$;
reset role;
select pg_temp.snapshot_assert(
  not exists (
    select 1 from public.monthly_report_snapshot_deliveries
    where snapshot_id = current_setting('monthly_snapshot_test.snapshot2')::uuid
  ),
  'sibling-scope delivery attempt left an immutable delivery fact'
);

-- ===== Unauthorized roles and tenant crossing =====
select pg_temp.snapshot_actor('c5740000-0000-0000-0000-000000000003');
set local role authenticated;
do $$
begin
  perform public.create_monthly_report_snapshot(
    '2026-08-01', current_setting('monthly_snapshot_test.le1')::uuid
  );
  raise exception 'snapshot test failure: office creation was accepted';
exception when insufficient_privilege then
  if sqlerrm not like '%monthly_report_snapshot_not_authorized%' then raise; end if;
end
$$;
do $$
begin
  perform public.mark_monthly_report_snapshot_sent(
    current_setting('monthly_snapshot_test.snapshot1')::uuid,
    'office must not deliver'
  );
  raise exception 'snapshot test failure: office delivery was accepted';
exception when insufficient_privilege then
  if sqlerrm not like '%monthly_report_snapshot_delivery_not_authorized%' then raise; end if;
end
$$;
select pg_temp.snapshot_assert(
  (select count(*) = 0 from public.monthly_report_snapshots),
  'office role read final snapshots'
);
select pg_temp.snapshot_assert(
  (select count(*) = 0 from public.monthly_report_snapshot_deliveries),
  'office role read final snapshot deliveries'
);
reset role;

select pg_temp.snapshot_actor('c5740000-0000-0000-0000-000000000004');
set local role authenticated;
do $$
begin
  perform public.create_monthly_report_snapshot(
    '2026-08-01', current_setting('monthly_snapshot_test.le1')::uuid
  );
  raise exception 'snapshot test failure: payer creation was accepted';
exception when insufficient_privilege then
  if sqlerrm not like '%monthly_report_snapshot_not_authorized%' then raise; end if;
end
$$;
reset role;

select pg_temp.snapshot_actor('c5740000-0000-0000-0000-000000000005');
set local role authenticated;
do $$
begin
  perform public.create_monthly_report_snapshot(
    '2026-08-01', current_setting('monthly_snapshot_test.le1')::uuid
  );
  raise exception 'snapshot test failure: cross-tenant legal entity was accepted';
exception when invalid_parameter_value then
  if sqlerrm not like '%monthly_report_snapshot_legal_entity_invalid%' then raise; end if;
end
$$;
do $$
begin
  perform public.mark_monthly_report_snapshot_sent(
    current_setting('monthly_snapshot_test.snapshot1')::uuid,
    'cross tenant must not deliver'
  );
  raise exception 'snapshot test failure: cross-tenant delivery was accepted';
exception when no_data_found then
  if sqlerrm not like '%monthly_report_snapshot_delivery_unknown%' then raise; end if;
end
$$;
select pg_temp.snapshot_assert(
  (select count(*) = 0 from public.monthly_report_snapshots
   where org_id = 'a5740000-0000-0000-0000-000000000001'),
  'tenant B read tenant A snapshots'
);
select pg_temp.snapshot_assert(
  (select count(*) = 0 from public.monthly_report_snapshot_deliveries
   where org_id = 'a5740000-0000-0000-0000-000000000001'),
  'tenant B read tenant A snapshot deliveries'
);
reset role;

-- ===== Fail-closed derived attribution and atomic failure =====
-- The block runs as the suite owner so the anomaly fixtures can be inserted at
-- all (browser roles have no direct DML on financial tables); each sub-block
-- switches to authenticated only for the command under test, and the caught
-- exception rolls back fixture, command effects and the SET LOCAL together.
select pg_temp.snapshot_actor('c5740000-0000-0000-0000-000000000001');
do $$
declare
  v_snapshots_before bigint;
  v_audits_before bigint;
  v_events_before bigint;
begin
  select count(*) into v_snapshots_before from public.monthly_report_snapshots;
  select count(*) into v_audits_before from public.audit_logs
    where action = 'monthly_report_snapshot_created';
  select count(*) into v_events_before from public.domain_events
    where event_type = 'monthly_report.snapshot_created';

  begin
    perform pg_temp.snapshot_actor(null);
    insert into public.credit_requests (
      id, org_id, supplier_id, reason, amount, status, created_by, created_at
    ) values (
      '15740000-0000-0000-0000-000000000009', 'a5740000-0000-0000-0000-000000000001',
      'd5740000-0000-0000-0000-000000000001', 'other', 1, 'open',
      'c5740000-0000-0000-0000-000000000001', '2026-08-05 10:00:00+03'
    );
    perform pg_temp.snapshot_actor('c5740000-0000-0000-0000-000000000001');
    set local role authenticated;
    perform public.create_monthly_report_snapshot(
      '2026-08-01', current_setting('monthly_snapshot_test.le1')::uuid
    );
    raise exception 'snapshot test failure: unattributed credit was accepted';
  exception when others then
    if sqlerrm not like '%monthly_report_snapshot_unattributed_credits%' then raise; end if;
  end;

  begin
    perform pg_temp.snapshot_actor(null);
    insert into public.bank_transactions (
      id, org_id, import_id, tx_date, description, amount, raw, status, row_hash
    ) values (
      '75740000-0000-0000-0000-000000000009', 'a5740000-0000-0000-0000-000000000001',
      '65740000-0000-0000-0000-000000000001', '2026-08-06', 'Unattributed bank', 1,
      '{}'::jsonb, 'unmatched', repeat('9', 64)
    );
    perform pg_temp.snapshot_actor('c5740000-0000-0000-0000-000000000001');
    set local role authenticated;
    perform public.create_monthly_report_snapshot(
      '2026-08-01', current_setting('monthly_snapshot_test.le1')::uuid
    );
    raise exception 'snapshot test failure: unattributed bank transaction was accepted';
  exception when others then
    if sqlerrm not like '%monthly_report_snapshot_unattributed_bank_transactions%' then raise; end if;
  end;

  begin
    perform pg_temp.snapshot_actor(null);
    insert into public.exceptions (id, org_id, type, status, title) values (
      '95740000-0000-0000-0000-000000000009', 'a5740000-0000-0000-0000-000000000001',
      'unknown_supplier', 'open', 'Unattributed exception'
    );
    perform pg_temp.snapshot_actor('c5740000-0000-0000-0000-000000000001');
    set local role authenticated;
    perform public.create_monthly_report_snapshot(
      '2026-08-01', current_setting('monthly_snapshot_test.le1')::uuid
    );
    raise exception 'snapshot test failure: unattributed exception was accepted';
  exception when others then
    if sqlerrm not like '%monthly_report_snapshot_unattributed_exceptions%' then raise; end if;
  end;

  begin
    perform pg_temp.snapshot_actor(null);
    insert into public.exceptions (
      id, org_id, type, status, title, invoice_id, payment_id
    ) values (
      '95740000-0000-0000-0000-000000000010', 'a5740000-0000-0000-0000-000000000001',
      'amount_mismatch', 'open', 'Ambiguous cross-entity exception',
      'f5740000-0000-0000-0000-000000000001', '05740000-0000-0000-0000-000000000002'
    );
    perform pg_temp.snapshot_actor('c5740000-0000-0000-0000-000000000001');
    set local role authenticated;
    perform public.create_monthly_report_snapshot(
      '2026-08-01', current_setting('monthly_snapshot_test.le1')::uuid
    );
    raise exception 'snapshot test failure: ambiguous exception was accepted';
  exception when others then
    if sqlerrm not like '%monthly_report_snapshot_unattributed_exceptions%' then raise; end if;
  end;

  perform pg_temp.snapshot_assert(
    (select count(*) from public.monthly_report_snapshots) = v_snapshots_before,
    'failed creation left a partial snapshot'
  );
  perform pg_temp.snapshot_assert(
    (select count(*) from public.audit_logs
      where action = 'monthly_report_snapshot_created') = v_audits_before,
    'failed creation left a partial audit row'
  );
  perform pg_temp.snapshot_assert(
    (select count(*) from public.domain_events
      where event_type = 'monthly_report.snapshot_created') = v_events_before,
    'failed creation left a partial domain event'
  );
end
$$;
reset role;

-- Trusted or browser mutations are rejected; no ordinary tenant UI path can overwrite history.
do $$
begin
  update public.monthly_report_snapshots set legal_entity_name = 'tampered'
  where org_id = 'a5740000-0000-0000-0000-000000000001'
    and unit_id = current_setting('monthly_snapshot_test.le1')::uuid and version = 1;
  raise exception 'snapshot test failure: immutable row update was accepted';
exception when insufficient_privilege then
  if sqlerrm not like '%monthly_report_snapshot_immutable%' then raise; end if;
end
$$;
do $$
begin
  delete from public.monthly_report_snapshots
  where org_id = 'a5740000-0000-0000-0000-000000000001'
    and unit_id = current_setting('monthly_snapshot_test.le1')::uuid and version = 1;
  raise exception 'snapshot test failure: immutable row delete was accepted';
exception when insufficient_privilege then
  if sqlerrm not like '%monthly_report_snapshot_immutable%' then raise; end if;
end
$$;
do $$
begin
  update public.monthly_report_snapshot_deliveries set reason = 'tampered'
  where snapshot_id = current_setting('monthly_snapshot_test.snapshot1')::uuid;
  raise exception 'snapshot test failure: immutable delivery update was accepted';
exception when insufficient_privilege then
  if sqlerrm not like '%monthly_report_snapshot_immutable%' then raise; end if;
end
$$;
do $$
begin
  delete from public.monthly_report_snapshot_deliveries
  where snapshot_id = current_setting('monthly_snapshot_test.snapshot1')::uuid;
  raise exception 'snapshot test failure: immutable delivery delete was accepted';
exception when insufficient_privilege then
  if sqlerrm not like '%monthly_report_snapshot_immutable%' then raise; end if;
end
$$;

rollback;

select 'monthly_report_snapshots: all assertions passed' as result;
