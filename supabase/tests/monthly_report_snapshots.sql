-- Immutable monthly accountant snapshot acceptance.
-- Run against a freshly reset disposable local database after migration 0054.
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
        ilike 'FOREIGN KEY (org_id, created_by)%profiles(org_id, id)%'
  ),
  'tenant-composite creator foreign key is missing'
);
select pg_temp.snapshot_assert(
  has_table_privilege('authenticated', 'public.monthly_report_snapshots', 'SELECT')
    and not has_table_privilege('authenticated', 'public.monthly_report_snapshots', 'INSERT')
    and not has_table_privilege('authenticated', 'public.monthly_report_snapshots', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.monthly_report_snapshots', 'DELETE')
    and has_table_privilege('service_role', 'public.monthly_report_snapshots', 'SELECT')
    and has_table_privilege('service_role', 'public.monthly_report_snapshots', 'INSERT')
    and has_table_privilege('service_role', 'public.monthly_report_snapshots', 'UPDATE')
    and has_table_privilege('service_role', 'public.monthly_report_snapshots', 'DELETE'),
  'snapshot ACL diverges from authenticated command-only writes or trusted-server CRUD'
);

insert into public.organizations (id, name, status) values
  ('a5400000-0000-0000-0000-000000000001', 'Snapshot tenant A', 'active'),
  ('a5400000-0000-0000-0000-000000000002', 'Snapshot tenant B', 'active');

insert into auth.users (id, email) values
  ('b5400000-0000-0000-0000-000000000001', 'snapshot-owner-a@example.test'),
  ('b5400000-0000-0000-0000-000000000002', 'snapshot-accountant-a@example.test'),
  ('b5400000-0000-0000-0000-000000000003', 'snapshot-office-a@example.test'),
  ('b5400000-0000-0000-0000-000000000004', 'snapshot-payer-a@example.test'),
  ('b5400000-0000-0000-0000-000000000005', 'snapshot-owner-b@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('b5400000-0000-0000-0000-000000000001', 'a5400000-0000-0000-0000-000000000001', 'Snapshot owner A', 'owner'),
  ('b5400000-0000-0000-0000-000000000002', 'a5400000-0000-0000-0000-000000000001', 'Snapshot accountant A', 'accountant'),
  ('b5400000-0000-0000-0000-000000000003', 'a5400000-0000-0000-0000-000000000001', 'Snapshot office A', 'office'),
  ('b5400000-0000-0000-0000-000000000004', 'a5400000-0000-0000-0000-000000000001', 'Snapshot payer A', 'payer'),
  ('b5400000-0000-0000-0000-000000000005', 'a5400000-0000-0000-0000-000000000002', 'Snapshot owner B', 'owner');

insert into public.suppliers (id, org_id, name) values
  ('c5400000-0000-0000-0000-000000000001', 'a5400000-0000-0000-0000-000000000001', 'Snapshot supplier A'),
  ('c5400000-0000-0000-0000-000000000002', 'a5400000-0000-0000-0000-000000000002', 'Snapshot supplier B');

insert into public.invoices (
  id, org_id, supplier_id, invoice_number, invoice_date, received_by,
  amount_before_vat, vat_amount, total_amount, review_status, payment_status
) values
  ('d5400000-0000-0000-0000-000000000001', 'a5400000-0000-0000-0000-000000000001',
   'c5400000-0000-0000-0000-000000000001', 'SNAP-APPROVED', '2026-08-02',
   'b5400000-0000-0000-0000-000000000001', 100, 18, 118, 'approved', 'unpaid'),
  ('d5400000-0000-0000-0000-000000000002', 'a5400000-0000-0000-0000-000000000001',
   'c5400000-0000-0000-0000-000000000001', 'SNAP-REVIEW', '2026-08-03',
   'b5400000-0000-0000-0000-000000000001', 50, 9, 59, 'in_review', 'unpaid'),
  ('d5400000-0000-0000-0000-000000000003', 'a5400000-0000-0000-0000-000000000002',
   'c5400000-0000-0000-0000-000000000002', 'SNAP-TENANT-B', '2026-08-02',
   'b5400000-0000-0000-0000-000000000005', 10, 1.8, 11.8, 'approved', 'unpaid');

insert into public.payments (
  id, org_id, supplier_id, amount, paid_date, method, reference, executed_by
) values (
  'e5400000-0000-0000-0000-000000000001', 'a5400000-0000-0000-0000-000000000001',
  'c5400000-0000-0000-0000-000000000001', 40, '2026-08-04', 'bank', 'SNAP-REF',
  'b5400000-0000-0000-0000-000000000002'
);

insert into public.credit_requests (
  id, org_id, supplier_id, invoice_id, reason, amount, status, created_by, created_at
) values (
  'f5400000-0000-0000-0000-000000000001', 'a5400000-0000-0000-0000-000000000001',
  'c5400000-0000-0000-0000-000000000001', 'd5400000-0000-0000-0000-000000000001',
  'wrong_price', 10, 'open', 'b5400000-0000-0000-0000-000000000001',
  '2026-08-04 10:00:00+03'
);

insert into public.exceptions (
  id, org_id, type, status, title, supplier_id
) values (
  '15400000-0000-0000-0000-000000000001', 'a5400000-0000-0000-0000-000000000001',
  'amount_mismatch', 'open', 'Snapshot exception', 'c5400000-0000-0000-0000-000000000001'
);

insert into public.bank_imports (
  id, org_id, filename, file_hash, column_mapping, row_count, imported_by
) values (
  '25400000-0000-0000-0000-000000000001', 'a5400000-0000-0000-0000-000000000001',
  'snapshot.csv', repeat('5', 64), '{}'::jsonb, 1,
  'b5400000-0000-0000-0000-000000000002'
);
insert into public.bank_transactions (
  id, org_id, import_id, tx_date, description, amount, raw, status, row_hash
) values (
  '35400000-0000-0000-0000-000000000001', 'a5400000-0000-0000-0000-000000000001',
  '25400000-0000-0000-0000-000000000001', '2026-08-05', 'Snapshot bank row', 40,
  '{}'::jsonb, 'unmatched', repeat('6', 64)
);

select set_config('request.jwt.claim.sub', 'b5400000-0000-0000-0000-000000000001', true);
set local role authenticated;

do $$
declare v_snapshot public.monthly_report_snapshots;
begin
  v_snapshot := public.create_monthly_report_snapshot('2026-08-01');
  perform pg_temp.snapshot_assert(v_snapshot.version = 1, 'owner did not create version 1');
  perform pg_temp.snapshot_assert(v_snapshot.organization_name = 'Snapshot tenant A', 'organization was not captured');
  perform pg_temp.snapshot_assert(v_snapshot.created_by_name = 'Snapshot owner A', 'creator was not captured');
  perform pg_temp.snapshot_assert((v_snapshot.totals ->> 'invoice_count')::integer = 1, 'approved invoice count mismatch at creation');
  perform pg_temp.snapshot_assert((v_snapshot.totals ->> 'invoice_total')::numeric = 118, 'approved invoice total mismatch at creation');
  perform pg_temp.snapshot_assert((v_snapshot.totals ->> 'payment_total')::numeric = 40, 'payment total mismatch at creation');
  perform pg_temp.snapshot_assert((v_snapshot.totals ->> 'credit_total')::numeric = 10, 'credit total mismatch at creation');
  perform pg_temp.snapshot_assert((v_snapshot.totals ->> 'exception_count')::integer = 1, 'exception count mismatch at creation');
  perform pg_temp.snapshot_assert((v_snapshot.totals ->> 'unmatched_bank_count')::integer = 1, 'bank total mismatch at creation');
  perform pg_temp.snapshot_assert(jsonb_array_length(v_snapshot.invoice_rows) = 1, 'approved invoice detail row is missing');
end
$$;

select pg_temp.snapshot_assert(
  (select content_hash = encode(sha256(convert_to(jsonb_build_object(
    'report_version', report_version,
    'organization_id', org_id,
    'organization_name', organization_name,
    'report_month', report_month,
    'invoice_rows', invoice_rows,
    'payment_rows', payment_rows,
    'credit_rows', credit_rows,
    'exception_rows', exception_rows,
    'bank_rows', bank_rows,
    'totals', totals
  )::text, 'UTF8')), 'hex')
   from public.monthly_report_snapshots
   where org_id = 'a5400000-0000-0000-0000-000000000001' and version = 1),
  'stored checksum does not match canonical snapshot content'
);
select pg_temp.snapshot_assert(
  exists (
    select 1 from public.audit_logs a
    join public.monthly_report_snapshots s on s.id = a.entity_id
    where s.org_id = 'a5400000-0000-0000-0000-000000000001' and s.version = 1
      and a.action = 'monthly_report_snapshot_created'
      and a.user_id = 'b5400000-0000-0000-0000-000000000001'
      and a.new_values ->> 'snapshot_id' = s.id::text
      and a.new_values ->> 'report_month' = '2026-08-01'
      and (a.new_values ->> 'version')::integer = 1
  ),
  'audit does not contain creator, month, version and snapshot id'
);

-- Invalid creation is atomic: no snapshot and no audit row are left behind.
do $$
declare v_before integer;
begin
  select count(*) into v_before from public.monthly_report_snapshots;
  begin
    perform public.create_monthly_report_snapshot('2026-08-02');
    raise exception 'expected monthly_report_snapshot_month_invalid';
  exception when sqlstate '22023' then
    if sqlerrm not like '%monthly_report_snapshot_month_invalid%' then raise; end if;
  end;
  perform pg_temp.snapshot_assert(
    (select count(*) from public.monthly_report_snapshots) = v_before,
    'failed creation left a partial snapshot'
  );
end
$$;

-- Browser roles cannot mutate or delete an immutable version.
do $$
begin
  update public.monthly_report_snapshots set organization_name = 'tampered'
  where org_id = 'a5400000-0000-0000-0000-000000000001' and version = 1;
  raise exception 'expected snapshot update rejection';
exception when insufficient_privilege then null;
end
$$;
do $$
begin
  delete from public.monthly_report_snapshots
  where org_id = 'a5400000-0000-0000-0000-000000000001' and version = 1;
  raise exception 'expected snapshot delete rejection';
exception when insufficient_privilege then null;
end
$$;

-- Later live changes do not alter version 1; explicit creation adds version 2.
reset role;
select set_config('request.jwt.claim.sub', '', true);
update public.invoices
set amount_before_vat = 200, vat_amount = 36, total_amount = 236
where id = 'd5400000-0000-0000-0000-000000000001';
update public.suppliers set name = 'Snapshot supplier changed'
where id = 'c5400000-0000-0000-0000-000000000001';

select set_config('request.jwt.claim.sub', 'b5400000-0000-0000-0000-000000000001', true);
set local role authenticated;
select pg_temp.snapshot_assert(
  (select (totals ->> 'invoice_total')::numeric = 118 from public.monthly_report_snapshots where version = 1)
  and (select invoice_rows #>> '{0,supplier,name}' from public.monthly_report_snapshots where version = 1) = 'Snapshot supplier A',
  'live source mutation altered version 1'
);
do $$
declare v_snapshot public.monthly_report_snapshots;
begin
  v_snapshot := public.create_monthly_report_snapshot('2026-08-01');
  perform pg_temp.snapshot_assert(v_snapshot.version = 2, 'explicit later creation did not create version 2');
  perform pg_temp.snapshot_assert((v_snapshot.totals ->> 'invoice_total')::numeric = 236, 'version 2 did not capture current approved-source totals');
  perform pg_temp.snapshot_assert(v_snapshot.invoice_rows #>> '{0,supplier,name}' = 'Snapshot supplier changed', 'version 2 did not capture current supplier name');
  perform pg_temp.snapshot_assert((select count(*) from public.monthly_report_snapshots where report_month = '2026-08-01') = 2, 'version 2 replaced version 1');
end
$$;

-- Accountant may create/read, and captures the same approved-only invoice set as the live report.
select set_config('request.jwt.claim.sub', 'b5400000-0000-0000-0000-000000000002', true);
do $$
declare v_snapshot public.monthly_report_snapshots;
begin
  v_snapshot := public.create_monthly_report_snapshot('2026-08-01');
  perform pg_temp.snapshot_assert(v_snapshot.version = 3, 'accountant did not create the next version');
  perform pg_temp.snapshot_assert((v_snapshot.totals ->> 'invoice_count')::integer = 1, 'accountant snapshot included an unapproved invoice');
  perform pg_temp.snapshot_assert((v_snapshot.totals ->> 'invoice_total')::numeric = 236, 'accountant approved-only total mismatch');
end
$$;

-- Office and payer gain neither read nor create permission.
select set_config('request.jwt.claim.sub', 'b5400000-0000-0000-0000-000000000003', true);
select pg_temp.snapshot_assert((select count(*) from public.monthly_report_snapshots) = 0, 'office can read final snapshots');
do $$
begin
  perform public.create_monthly_report_snapshot('2026-08-01');
  raise exception 'expected office create rejection';
exception when insufficient_privilege then
  if sqlerrm not like '%monthly_report_snapshot_not_authorized%' then raise; end if;
end
$$;

select set_config('request.jwt.claim.sub', 'b5400000-0000-0000-0000-000000000004', true);
select pg_temp.snapshot_assert((select count(*) from public.monthly_report_snapshots) = 0, 'payer can read final snapshots');
do $$
begin
  perform public.create_monthly_report_snapshot('2026-08-01');
  raise exception 'expected payer create rejection';
exception when insufficient_privilege then
  if sqlerrm not like '%monthly_report_snapshot_not_authorized%' then raise; end if;
end
$$;

-- Tenant B cannot discover tenant A snapshots and can create only its own version stream.
select set_config('request.jwt.claim.sub', 'b5400000-0000-0000-0000-000000000005', true);
select pg_temp.snapshot_assert((select count(*) from public.monthly_report_snapshots) = 0, 'tenant B can read tenant A snapshots');
do $$
declare v_snapshot public.monthly_report_snapshots;
begin
  v_snapshot := public.create_monthly_report_snapshot('2026-08-01');
  perform pg_temp.snapshot_assert(v_snapshot.org_id = 'a5400000-0000-0000-0000-000000000002', 'tenant B created a cross-tenant snapshot');
  perform pg_temp.snapshot_assert(v_snapshot.version = 1, 'tenant B did not receive an isolated version stream');
end
$$;
select pg_temp.snapshot_assert((select count(*) from public.monthly_report_snapshots) = 1, 'tenant B sees another tenant snapshot');

-- The immutable trigger also rejects privileged accidental mutation.
reset role;
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  update public.monthly_report_snapshots set organization_name = 'privileged tamper'
  where org_id = 'a5400000-0000-0000-0000-000000000001' and version = 1;
  raise exception 'expected immutable trigger rejection';
exception when insufficient_privilege then
  if sqlerrm not like '%monthly_report_snapshot_immutable%' then raise; end if;
end
$$;

rollback;
