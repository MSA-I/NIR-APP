-- 0073 payment-credit override regression harness.
-- Run only against an isolated local database with all migrations applied. Rolled back.
\set ON_ERROR_STOP on

begin;

create function pg_temp.credit_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'payment credit override assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.credit_expect_error(p_sql text, p_error text)
returns void
language plpgsql
as $$
begin
  begin
    execute p_sql;
  exception when others then
    if position(p_error in sqlerrm) = 0 then
      raise exception 'expected error %, received %', p_error, sqlerrm;
    end if;
    return;
  end;
  raise exception 'expected error %, statement succeeded', p_error;
end
$$;

-- ===== Fixture: two tenants and two legal entities in tenant A =====

insert into organizations (id, name, status) values
  ('17300000-0000-0000-0000-000000000001', '0073 tenant A', 'active'),
  ('17300000-0000-0000-0000-000000000002', '0073 tenant B', 'active');

select u.id as root_a from org_units u
where u.org_id = '17300000-0000-0000-0000-000000000001' and u.unit_type = 'root'
\gset unit_
select u.id as le_a1 from org_units u
where u.org_id = '17300000-0000-0000-0000-000000000001' and u.unit_type = 'legal_entity'
order by u.created_at, u.id limit 1
\gset unit_
select u.id as branch_a1 from org_units u
where u.org_id = '17300000-0000-0000-0000-000000000001' and u.unit_type = 'branch'
order by u.created_at, u.id limit 1
\gset unit_
select u.id as warehouse_a1 from org_units u
where u.org_id = '17300000-0000-0000-0000-000000000001' and u.unit_type = 'warehouse'
order by u.created_at, u.id limit 1
\gset unit_
select u.id as le_b1 from org_units u
where u.org_id = '17300000-0000-0000-0000-000000000002' and u.unit_type = 'legal_entity'
order by u.created_at, u.id limit 1
\gset unit_

insert into org_units (id, org_id, parent_id, unit_type, name) values
  ('17310000-0000-0000-0000-000000000002', '17300000-0000-0000-0000-000000000001', :'unit_root_a', 'legal_entity', '0073 entity A2'),
  ('17310000-0000-0000-0000-000000000003', '17300000-0000-0000-0000-000000000001', '17310000-0000-0000-0000-000000000002', 'branch', '0073 branch A2'),
  ('17310000-0000-0000-0000-000000000004', '17300000-0000-0000-0000-000000000001', '17310000-0000-0000-0000-000000000003', 'warehouse', '0073 warehouse A2');

insert into auth.users (id, email) values
  ('17320000-0000-0000-0000-000000000001', '0073-owner-a@example.test'),
  ('17320000-0000-0000-0000-000000000002', '0073-office-a@example.test'),
  ('17320000-0000-0000-0000-000000000003', '0073-payer-a@example.test'),
  ('17320000-0000-0000-0000-000000000004', '0073-kitchen-a@example.test'),
  ('17320000-0000-0000-0000-000000000005', '0073-scoped-office-a@example.test'),
  ('17320000-0000-0000-0000-000000000009', '0073-owner-b@example.test');

insert into profiles (id, org_id, full_name, role) values
  ('17320000-0000-0000-0000-000000000001', '17300000-0000-0000-0000-000000000001', '0073 owner A', 'owner'),
  ('17320000-0000-0000-0000-000000000002', '17300000-0000-0000-0000-000000000001', '0073 office A', 'office'),
  ('17320000-0000-0000-0000-000000000003', '17300000-0000-0000-0000-000000000001', '0073 payer A', 'payer'),
  ('17320000-0000-0000-0000-000000000004', '17300000-0000-0000-0000-000000000001', '0073 kitchen A', 'kitchen'),
  ('17320000-0000-0000-0000-000000000005', '17300000-0000-0000-0000-000000000001', '0073 scoped office A', 'office'),
  ('17320000-0000-0000-0000-000000000009', '17300000-0000-0000-0000-000000000002', '0073 owner B', 'owner');

-- One office user can see only entity A1, never sibling A2.
delete from user_scope_grants
where user_id = '17320000-0000-0000-0000-000000000005';
insert into user_scope_grants (org_id, user_id, unit_id) values
  ('17300000-0000-0000-0000-000000000001', '17320000-0000-0000-0000-000000000005', :'unit_le_a1');

insert into suppliers (id, org_id, name) values
  ('17330000-0000-0000-0000-000000000001', '17300000-0000-0000-0000-000000000001', '0073 credit supplier'),
  ('17330000-0000-0000-0000-000000000002', '17300000-0000-0000-0000-000000000001', '0073 clean supplier'),
  ('17330000-0000-0000-0000-000000000003', '17300000-0000-0000-0000-000000000001', '0073 malformed supplier'),
  ('17330000-0000-0000-0000-000000000009', '17300000-0000-0000-0000-000000000002', '0073 tenant B supplier');

insert into invoices (
  id, org_id, unit_id, supplier_id, invoice_number, invoice_date,
  amount_before_vat, vat_amount, total_amount, review_status, payment_status
) values
  ('17340000-0000-0000-0000-000000000001', '17300000-0000-0000-0000-000000000001', :'unit_le_a1',
   '17330000-0000-0000-0000-000000000001', '0073-A1', current_date, 100, 0, 100, 'received', 'unpaid'),
  ('17340000-0000-0000-0000-000000000002', '17300000-0000-0000-0000-000000000001', '17310000-0000-0000-0000-000000000002',
   '17330000-0000-0000-0000-000000000001', '0073-A2', current_date, 80, 0, 80, 'received', 'unpaid'),
  ('17340000-0000-0000-0000-000000000003', '17300000-0000-0000-0000-000000000001', :'unit_le_a1',
   '17330000-0000-0000-0000-000000000002', '0073-CLEAN', current_date, 60, 0, 60, 'received', 'unpaid'),
  ('17340000-0000-0000-0000-000000000004', '17300000-0000-0000-0000-000000000001', :'unit_le_a1',
   '17330000-0000-0000-0000-000000000003', '0073-MALFORMED', current_date, 40, 0, 40, 'received', 'unpaid'),
  ('17340000-0000-0000-0000-000000000009', '17300000-0000-0000-0000-000000000002', :'unit_le_b1',
   '17330000-0000-0000-0000-000000000009', '0073-B1', current_date, 70, 0, 70, 'received', 'unpaid');

-- 0106 forbids trusted fixtures from materializing an approved invoice without the same
-- server-authoritative review transition and immutable three-way approval snapshot as production.
select set_config('request.jwt.claim.sub', '17320000-0000-0000-0000-000000000001', true);
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', '17320000-0000-0000-0000-000000000001'
)::text, true);
set local role authenticated;
select set_invoice_review_status(
  '17340000-0000-0000-0000-000000000001', 'in_review', '0073 trusted fixture review started'
);
select set_invoice_review_status(
  '17340000-0000-0000-0000-000000000001', 'approved', '0073 trusted fixture approved'
);
select set_invoice_review_status(
  '17340000-0000-0000-0000-000000000002', 'in_review', '0073 trusted fixture review started'
);
select set_invoice_review_status(
  '17340000-0000-0000-0000-000000000002', 'approved', '0073 trusted fixture approved'
);
select set_invoice_review_status(
  '17340000-0000-0000-0000-000000000003', 'in_review', '0073 trusted fixture review started'
);
select set_invoice_review_status(
  '17340000-0000-0000-0000-000000000003', 'approved', '0073 trusted fixture approved'
);
select set_invoice_review_status(
  '17340000-0000-0000-0000-000000000004', 'in_review', '0073 trusted fixture review started'
);
select set_invoice_review_status(
  '17340000-0000-0000-0000-000000000004', 'approved', '0073 trusted fixture approved'
);
reset role;

select set_config('request.jwt.claim.sub', '17320000-0000-0000-0000-000000000009', true);
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', '17320000-0000-0000-0000-000000000009'
)::text, true);
set local role authenticated;
select set_invoice_review_status(
  '17340000-0000-0000-0000-000000000009', 'in_review', '0073 trusted fixture review started'
);
select set_invoice_review_status(
  '17340000-0000-0000-0000-000000000009', 'approved', '0073 trusted fixture approved'
);
reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '', true);

-- A receipt-linked credit in entity A2 proves warehouse -> legal-entity derivation.
insert into purchase_orders (id, org_id, unit_id, supplier_id, status) values
  ('17350000-0000-0000-0000-000000000001', '17300000-0000-0000-0000-000000000001',
   '17310000-0000-0000-0000-000000000003', '17330000-0000-0000-0000-000000000001', 'sent');
insert into products (id, org_id, name) values
  ('17351000-0000-0000-0000-000000000001', '17300000-0000-0000-0000-000000000001', '0073 product');
insert into purchase_order_items (id, org_id, order_id, product_id, qty, unit_price) values
  ('17352000-0000-0000-0000-000000000001', '17300000-0000-0000-0000-000000000001',
   '17350000-0000-0000-0000-000000000001',
   '17351000-0000-0000-0000-000000000001', 1, 11);
insert into goods_receipts (id, org_id, unit_id, order_id, status) values
  ('17353000-0000-0000-0000-000000000001', '17300000-0000-0000-0000-000000000001',
   '17310000-0000-0000-0000-000000000004', '17350000-0000-0000-0000-000000000001', 'completed');
insert into goods_receipt_items (
  id, org_id, receipt_id, order_item_id, product_id, qty_received, status
) values (
  '17354000-0000-0000-0000-000000000001', '17300000-0000-0000-0000-000000000001',
  '17353000-0000-0000-0000-000000000001', '17352000-0000-0000-0000-000000000001',
  '17351000-0000-0000-0000-000000000001', 1, 'full'
);

insert into credit_requests (
  id, org_id, supplier_id, invoice_id, receipt_item_id, reason, amount, status
) values
  ('17360000-0000-0000-0000-000000000001', '17300000-0000-0000-0000-000000000001',
   '17330000-0000-0000-0000-000000000001', '17340000-0000-0000-0000-000000000001', null, 'other', 20, 'open'),
  ('17360000-0000-0000-0000-000000000002', '17300000-0000-0000-0000-000000000001',
   '17330000-0000-0000-0000-000000000001', '17340000-0000-0000-0000-000000000002', null, 'other', 30, 'requested'),
  ('17360000-0000-0000-0000-000000000003', '17300000-0000-0000-0000-000000000001',
   '17330000-0000-0000-0000-000000000001', null, '17354000-0000-0000-0000-000000000001', 'other', 11, 'received');

insert into payment_requests (
  id, org_id, unit_id, supplier_id, amount, status, created_by
) values
  ('17370000-0000-0000-0000-000000000001', '17300000-0000-0000-0000-000000000001', :'unit_le_a1',
   '17330000-0000-0000-0000-000000000002', 60, 'pending_approval', '17320000-0000-0000-0000-000000000001'),
  ('17370000-0000-0000-0000-000000000002', '17300000-0000-0000-0000-000000000001', :'unit_le_a1',
   '17330000-0000-0000-0000-000000000001', 100, 'pending_approval', '17320000-0000-0000-0000-000000000001'),
  ('17370000-0000-0000-0000-000000000003', '17300000-0000-0000-0000-000000000001', '17310000-0000-0000-0000-000000000002',
   '17330000-0000-0000-0000-000000000001', 80, 'pending_approval', '17320000-0000-0000-0000-000000000001'),
  ('17370000-0000-0000-0000-000000000004', '17300000-0000-0000-0000-000000000001', :'unit_le_a1',
   '17330000-0000-0000-0000-000000000003', 40, 'pending_approval', '17320000-0000-0000-0000-000000000001'),
  ('17370000-0000-0000-0000-000000000005', '17300000-0000-0000-0000-000000000001', :'unit_le_a1',
   '17330000-0000-0000-0000-000000000001', 100, 'draft', '17320000-0000-0000-0000-000000000001'),
  ('17370000-0000-0000-0000-000000000009', '17300000-0000-0000-0000-000000000002', :'unit_le_b1',
   '17330000-0000-0000-0000-000000000009', 70, 'pending_approval', '17320000-0000-0000-0000-000000000009');

insert into payment_request_invoices (org_id, payment_request_id, invoice_id, amount_allocated) values
  ('17300000-0000-0000-0000-000000000001', '17370000-0000-0000-0000-000000000001', '17340000-0000-0000-0000-000000000003', 60),
  ('17300000-0000-0000-0000-000000000001', '17370000-0000-0000-0000-000000000002', '17340000-0000-0000-0000-000000000001', 100),
  ('17300000-0000-0000-0000-000000000001', '17370000-0000-0000-0000-000000000003', '17340000-0000-0000-0000-000000000002', 80),
  ('17300000-0000-0000-0000-000000000001', '17370000-0000-0000-0000-000000000004', '17340000-0000-0000-0000-000000000004', 40),
  ('17300000-0000-0000-0000-000000000001', '17370000-0000-0000-0000-000000000005', '17340000-0000-0000-0000-000000000001', 100),
  ('17300000-0000-0000-0000-000000000002', '17370000-0000-0000-0000-000000000009', '17340000-0000-0000-0000-000000000009', 70);

-- ===== Owner: scoped signal, normal path, blocking and valid override =====

select set_config('request.jwt.claim.sub', '17320000-0000-0000-0000-000000000001', true);
set local role authenticated;

select pg_temp.credit_assert(
  (public.payment_request_financial_check_signals(
    '17330000-0000-0000-0000-000000000001', 100,
    array['17340000-0000-0000-0000-000000000001'::uuid],
    '17370000-0000-0000-0000-000000000002'
  ) ->> 'open_credit_total')::numeric = 20,
  'entity A1 total must exclude invoice and receipt credits in entity A2'
);

select pg_temp.credit_assert(
  public.payment_request_financial_check_signals(
    '17330000-0000-0000-0000-000000000001', 100,
    array['17340000-0000-0000-0000-000000000001'::uuid],
    '17370000-0000-0000-0000-000000000002'
  ) ->> 'similar_bank_transfer_check' = 'unavailable',
  'bank comparison must remain explicitly unavailable until bank data is entity-scoped'
);

select pg_temp.credit_assert(
  (public.transition_payment_request(
    '17370000-0000-0000-0000-000000000001', 'approved', 'normal approval without credits'
  ) ->> 'idempotent')::boolean = false,
  'normal approval must continue to work when the supplier has no open credits'
);

select pg_temp.credit_expect_error(
  $$select public.transition_payment_request(
      '17370000-0000-0000-0000-000000000002', 'approved', 'ordinary approval'
    )$$,
  'payment_request_credit_override_required'
);

select pg_temp.credit_expect_error(
  $$select public.approve_payment_request_with_credit_override(
      '17370000-0000-0000-0000-000000000002',
      '17330000-0000-0000-0000-000000000001', 20, '   '
    )$$,
  'payment_request_credit_override_invalid'
);

select pg_temp.credit_expect_error(
  $$select public.approve_payment_request_with_credit_override(
      '17370000-0000-0000-0000-000000000002',
      '17330000-0000-0000-0000-000000000002', 20, 'wrong supplier'
    )$$,
  'payment_request_credit_supplier_mismatch'
);

select pg_temp.credit_expect_error(
  $$select public.approve_payment_request_with_credit_override(
      '17370000-0000-0000-0000-000000000002',
      '17330000-0000-0000-0000-000000000001', 19, 'stale total'
    )$$,
  'payment_request_credit_total_changed'
);

select pg_temp.credit_expect_error(
  $$select public.approve_payment_request_with_credit_override(
      '17370000-0000-0000-0000-000000000005',
      '17330000-0000-0000-0000-000000000001', 20, 'wrong state'
    )$$,
  'payment_request_transition_invalid'
);

select pg_temp.credit_assert(
  not (public.approve_payment_request_with_credit_override(
    '17370000-0000-0000-0000-000000000002',
    '17330000-0000-0000-0000-000000000001', 20,
    'approved after reviewing open credits'
  ) ->> 'idempotent')::boolean,
  'valid explicit override must approve the request'
);

select pg_temp.credit_assert(
  (select pr.status = 'approved'
          and pr.amount = 100
          and pr.open_credit_override_total = 20
          and pr.open_credit_override_reason = 'approved after reviewing open credits'
          and pr.open_credit_override_at is not null
   from payment_requests pr
   where pr.id = '17370000-0000-0000-0000-000000000002'),
  'request keeps its amount and records the complete override tuple'
);

select pg_temp.credit_assert(
  (select count(*) = 3
          and bool_and(cr.status in ('open', 'requested', 'received'))
          and sum(cr.amount) = 61
   from credit_requests cr
   where cr.id in (
     '17360000-0000-0000-0000-000000000001',
     '17360000-0000-0000-0000-000000000002',
     '17360000-0000-0000-0000-000000000003'
   )),
  'override must not change, offset or close any credit'
);
select pg_temp.credit_assert(
  not exists (
    select 1 from payment_allocations pa
    where pa.credit_id in (
      '17360000-0000-0000-0000-000000000001',
      '17360000-0000-0000-0000-000000000002',
      '17360000-0000-0000-0000-000000000003'
    )
  ),
  'override must not create credit allocations'
);

select pg_temp.credit_assert(
  (select count(*) = 1
          and bool_and(al.user_id = '17320000-0000-0000-0000-000000000001')
          and bool_and(al.org_id = '17300000-0000-0000-0000-000000000001')
          and bool_and((al.new_values ->> 'supplier_id')::uuid = '17330000-0000-0000-0000-000000000001')
          and bool_and((al.new_values ->> 'payment_request_id')::uuid = '17370000-0000-0000-0000-000000000002')
          and bool_and((al.new_values ->> 'open_credit_total')::numeric = 20)
          and bool_and((al.new_values ->> 'payment_request_amount')::numeric = 100)
          and bool_and(al.new_values ->> 'override_reason' = 'approved after reviewing open credits')
          and bool_and(al.new_values ? 'approved_at')
   from audit_logs al
   where al.action = 'payment_request_transitioned'
     and al.entity_id = '17370000-0000-0000-0000-000000000002'),
  'one audit row must preserve actor, tenant, supplier, request, amounts, reason and timestamp'
);

select pg_temp.credit_assert(
  (select count(*) = 1
          and bool_and(de.unit_id = :'unit_le_a1'::uuid)
   from domain_events de
   where de.event_type = 'payment_request.approved'
     and de.entity_id = '17370000-0000-0000-0000-000000000002'),
  'one legal-entity-scoped approval event must fan out from the one audit row'
);

-- Exact replay returns the original fact and cannot duplicate audit or event rows.
select pg_temp.credit_assert(
  (public.approve_payment_request_with_credit_override(
    '17370000-0000-0000-0000-000000000002',
    '17330000-0000-0000-0000-000000000001', 20,
    'approved after reviewing open credits'
  ) ->> 'idempotent')::boolean,
  'exact replay must be idempotent'
);
select pg_temp.credit_assert(
  (select count(*) = 1 from audit_logs
   where action = 'payment_request_transitioned'
     and entity_id = '17370000-0000-0000-0000-000000000002')
  and
  (select count(*) = 1 from domain_events
   where event_type = 'payment_request.approved'
     and entity_id = '17370000-0000-0000-0000-000000000002'),
  'replay must not duplicate audit or event records'
);
select pg_temp.credit_expect_error(
  $$select public.approve_payment_request_with_credit_override(
      '17370000-0000-0000-0000-000000000002',
      '17330000-0000-0000-0000-000000000001', 20, 'different replay reason'
    )$$,
  'payment_request_credit_override_replay_mismatch'
);

-- ===== Scope, role and tenant failures =====

reset role;
select set_config('request.jwt.claim.sub', '17320000-0000-0000-0000-000000000005', true);
set local role authenticated;
select pg_temp.credit_expect_error(
  $$select public.approve_payment_request_with_credit_override(
      '17370000-0000-0000-0000-000000000003',
      '17330000-0000-0000-0000-000000000001', 41, 'outside scope'
    )$$,
  'unit_out_of_scope'
);

reset role;
select set_config('request.jwt.claim.sub', '17320000-0000-0000-0000-000000000003', true);
set local role authenticated;
select pg_temp.credit_expect_error(
  $$select public.approve_payment_request_with_credit_override(
      '17370000-0000-0000-0000-000000000003',
      '17330000-0000-0000-0000-000000000001', 41, 'payer cannot approve'
    )$$,
  'not_authorized'
);
select pg_temp.credit_assert(
  not has_table_privilege('authenticated', 'public.payment_requests', 'UPDATE'),
  'payer-visible override context must remain read-only browser data'
);
select pg_temp.credit_assert(
  (select pr.open_credit_override_reason = 'approved after reviewing open credits'
   from payment_requests pr
   where pr.id = '17370000-0000-0000-0000-000000000002'),
  'payer may read the recorded reason on an approved request'
);

reset role;
select set_config('request.jwt.claim.sub', '17320000-0000-0000-0000-000000000001', true);
set local role authenticated;
select pg_temp.credit_expect_error(
  $$select public.approve_payment_request_with_credit_override(
      '17370000-0000-0000-0000-000000000009',
      '17330000-0000-0000-0000-000000000009', 1, 'cross tenant'
    )$$,
  'payment_request_unknown'
);

-- Root-scoped office is an already-authorized approver and may approve entity A2. Its total
-- is 30 invoice-linked + 11 receipt-linked; entity A1's 20 is excluded.
reset role;
select set_config('request.jwt.claim.sub', '17320000-0000-0000-0000-000000000002', true);
set local role authenticated;
select pg_temp.credit_assert(
  not (public.approve_payment_request_with_credit_override(
    '17370000-0000-0000-0000-000000000003',
    '17330000-0000-0000-0000-000000000001', 41,
    'office reviewed entity A2 credits'
  ) ->> 'idempotent')::boolean,
  'office keeps its existing approval authority with a valid scoped override'
);

-- A new source-less active credit is a runtime fail-closed condition. It is inserted only as
-- trusted fixture data; no browser role has direct DML permission.
reset role;
select set_config('request.jwt.claim.sub', '', true);
insert into credit_requests (
  id, org_id, supplier_id, reason, amount, status
) values (
  '17360000-0000-0000-0000-000000000004', '17300000-0000-0000-0000-000000000001',
  '17330000-0000-0000-0000-000000000003', 'other', 5, 'open'
);
select set_config('request.jwt.claim.sub', '17320000-0000-0000-0000-000000000001', true);
set local role authenticated;
select pg_temp.credit_expect_error(
  $$select public.transition_payment_request(
      '17370000-0000-0000-0000-000000000004', 'approved', 'must fail closed'
    )$$,
  'payment_request_credit_scope_unresolved'
);

-- The restrictive derived policy must hide every sibling, source-less, or supplier-mismatched
-- row even when the legacy permissive organization policy would otherwise expose it.
reset role;
select set_config('request.jwt.claim.sub', '', true);
insert into credit_requests (
  id, org_id, supplier_id, invoice_id, reason, amount, status
) values (
  '17360000-0000-0000-0000-000000000005', '17300000-0000-0000-0000-000000000001',
  '17330000-0000-0000-0000-000000000002', '17340000-0000-0000-0000-000000000001',
  'other', 1, 'closed'
);
select set_config('request.jwt.claim.sub', '17320000-0000-0000-0000-000000000005', true);
set local role authenticated;
select pg_temp.credit_assert(
  (select count(*) = 1
          and bool_and(cr.id = '17360000-0000-0000-0000-000000000001')
   from credit_requests cr
   where cr.org_id = '17300000-0000-0000-0000-000000000001'),
  'derived credit RLS must expose only supplier-matched anchors inside auth_scopes()'
);

reset role;
select set_config('request.jwt.claim.sub', '17320000-0000-0000-0000-000000000001', true);
set local role authenticated;

-- Creation derives the unit from invoices and rejects a mixed-entity payload. No caller
-- supplies unit_id to create_payment_request.
select pg_temp.credit_assert(
  (public.create_payment_request(
    '17370000-0000-0000-0000-000000000006',
    '17330000-0000-0000-0000-000000000002', current_date + 7, null, 'draft',
    jsonb_build_array(jsonb_build_object(
      'invoice_id', '17340000-0000-0000-0000-000000000003', 'amount', 60
    )),
    'create scoped request'
  ) ->> 'unit_id')::uuid = :'unit_le_a1'::uuid,
  'create_payment_request must persist the invoice legal entity'
);
select pg_temp.credit_expect_error(
  $$select public.create_payment_request(
      '17370000-0000-0000-0000-000000000007',
      '17330000-0000-0000-0000-000000000001', current_date + 7, null, 'draft',
      jsonb_build_array(
        jsonb_build_object('invoice_id', '17340000-0000-0000-0000-000000000001', 'amount', 10),
        jsonb_build_object('invoice_id', '17340000-0000-0000-0000-000000000002', 'amount', 10)
      ),
      'mixed entity request'
    )$$,
  'payment_request_scope_invalid'
);

-- Static catalog contract: payment_requests is enforced, the rider is canonical, the three
-- remediated definers hold no exemptions, and no 0073 function consumes approval policy.
reset role;
select set_config('request.jwt.claim.sub', '', true);
select pg_temp.credit_assert(
  (select r.scope_class = 'legal_entity' and r.enforced
   from private.scope_registry r where r.table_name = 'payment_requests'),
  'payment_requests must be an enforced legal-entity table'
);
select pg_temp.credit_assert(
  (select not p.polpermissive
          and p.polcmd = '*'
          and p.polroles = array[0::oid]
   from pg_catalog.pg_policy p
   where p.polrelid = 'public.credit_requests'::regclass
     and p.polname = 'credit_requests_derived_scope_rider'),
  'credit_requests must have a restrictive all-command derived-scope rider for public'
);
select pg_temp.credit_assert(
  not exists (
    select 1 from private.scope_definer_exemptions e
    where e.function_signature in (
      to_regprocedure('public.create_payment_request(uuid,uuid,date,text,text,jsonb,text)')::text,
      to_regprocedure('public.transition_payment_request(uuid,text,text)')::text,
      to_regprocedure('public.payment_request_financial_check_signals(uuid,numeric,uuid[],uuid)')::text
    )
  ),
  'remediated payment-request functions must not retain A5 exemptions'
);
select pg_temp.credit_assert(
  not exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'create_payment_request', 'p1_transition_payment_request',
        'transition_payment_request', 'approve_payment_request_with_credit_override',
        'payment_request_financial_check_signals'
      )
      and p.prosrc ~ 'evaluate_approval_policy'
  ),
  '0073 financial commands must not consume evaluate_approval_policy'
);
select pg_temp.credit_assert(
  not exists (select 1 from private.scope_enforcement_violations()),
  '0073 must leave A1/A3/A5 clean'
);

rollback;
