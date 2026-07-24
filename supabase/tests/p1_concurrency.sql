-- P1 concurrency harness. Run only against a disposable database that already has all
-- project migrations through 0023_p1_financial_command_boundaries.sql applied. The harness uses
-- dblink to create two real PostgreSQL sessions and intentionally commits its fixtures.
-- Clone/reset the database before every run. Run psql as the disposable database superuser;
-- each worker immediately switches to the authenticated role before invoking application RPCs.
\set ON_ERROR_STOP on

create extension if not exists dblink;
drop schema if exists p1_concurrency_test cascade;
create schema p1_concurrency_test;

create function p1_concurrency_test.assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P1 concurrency assertion failed: %', p_message;
  end if;
end
$$;

create table p1_concurrency_test.results (
  case_name text not null,
  runner text not null,
  result jsonb not null
);

-- Stable fixtures live only in the disposable clone.
insert into organizations (id, name, status) values
  ('11000000-0000-0000-0000-000000000001', 'P1 concurrency tenant', 'active');

insert into auth.users (id, email) values
  ('21000000-0000-0000-0000-000000000001', 'p1-concurrency-owner@example.test'),
  ('21000000-0000-0000-0000-000000000002', 'p1-concurrency-office@example.test'),
  ('21000000-0000-0000-0000-000000000003', 'p1-concurrency-kitchen@example.test'),
  ('21000000-0000-0000-0000-000000000004', 'p1-concurrency-payer@example.test'),
  ('21000000-0000-0000-0000-000000000005', 'p1-concurrency-accountant@example.test');

insert into profiles (id, org_id, full_name, role) values
  ('21000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', 'P1 owner', 'owner'),
  ('21000000-0000-0000-0000-000000000002', '11000000-0000-0000-0000-000000000001', 'P1 office', 'office'),
  ('21000000-0000-0000-0000-000000000003', '11000000-0000-0000-0000-000000000001', 'P1 kitchen', 'kitchen'),
  ('21000000-0000-0000-0000-000000000004', '11000000-0000-0000-0000-000000000001', 'P1 payer', 'payer'),
  ('21000000-0000-0000-0000-000000000005', '11000000-0000-0000-0000-000000000001', 'P1 accountant', 'accountant');

insert into suppliers (id, org_id, name) values
  ('31000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', 'P1 supplier A'),
  ('31000000-0000-0000-0000-000000000002', '11000000-0000-0000-0000-000000000001', 'P1 supplier B');

insert into products (id, org_id, name, unit) values
  ('41000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', 'P1 product price', 'unit'),
  ('41000000-0000-0000-0000-000000000002', '11000000-0000-0000-0000-000000000001', 'P1 product finalize', 'unit'),
  ('41000000-0000-0000-0000-000000000003', '11000000-0000-0000-0000-000000000001', 'P1 product tie', 'unit');

insert into supplier_products (
  id, org_id, supplier_id, product_id, current_price, price_effective_date, available
) values
  ('51000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', '31000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-000000000001', 10, '2026-07-01', true),
  ('51000000-0000-0000-0000-000000000002', '11000000-0000-0000-0000-000000000001', '31000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-000000000002', 20, '2026-07-01', true),
  ('51000000-0000-0000-0000-000000000003', '11000000-0000-0000-0000-000000000001', '31000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-000000000003', 5, '2026-07-01', true),
  ('51000000-0000-0000-0000-000000000004', '11000000-0000-0000-0000-000000000001', '31000000-0000-0000-0000-000000000002', '41000000-0000-0000-0000-000000000003', 5, '2026-07-01', true);

insert into price_history (org_id, supplier_product_id, price, effective_date) values
  ('11000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000001', 10, '2026-07-01'),
  ('11000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000002', 20, '2026-07-01'),
  ('11000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000003', 5, '2026-07-01'),
  ('11000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000004', 5, '2026-07-01');

insert into invoices (
  id, org_id, supplier_id, invoice_number, invoice_date,
  amount_before_vat, vat_amount, total_amount, review_status
) values
  ('61000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', '31000000-0000-0000-0000-000000000001', 'P1-PAYMENT', '2026-07-10', 84.75, 15.25, 100, 'approved'),
  ('61000000-0000-0000-0000-000000000002', '11000000-0000-0000-0000-000000000001', '31000000-0000-0000-0000-000000000001', 'P1-REVERSE-A', '2026-07-11', 84.75, 15.25, 100, 'approved'),
  ('61000000-0000-0000-0000-000000000003', '11000000-0000-0000-0000-000000000001', '31000000-0000-0000-0000-000000000001', 'P1-REVERSE-B', '2026-07-12', 84.75, 15.25, 100, 'approved'),
  ('61000000-0000-0000-0000-000000000004', '11000000-0000-0000-0000-000000000001', '31000000-0000-0000-0000-000000000001', 'P1-BANK', '2026-07-13', 42.37, 7.63, 50, 'approved'),
  ('61000000-0000-0000-0000-000000000005', '11000000-0000-0000-0000-000000000001', '31000000-0000-0000-0000-000000000001', 'P1-MONTH', '2026-07-14', 21.19, 3.81, 25, 'approved'),
  ('61000000-0000-0000-0000-000000000006', '11000000-0000-0000-0000-000000000001', '31000000-0000-0000-0000-000000000001', 'P1-CREDIT', '2026-07-15', 21.19, 3.81, 25, 'approved');

insert into credit_requests (
  id, org_id, supplier_id, invoice_id, reason, amount, status, created_by
) values (
  '65000000-0000-0000-0000-000000000001',
  '11000000-0000-0000-0000-000000000001',
  '31000000-0000-0000-0000-000000000001',
  '61000000-0000-0000-0000-000000000006',
  'wrong_price', 25, 'received', '21000000-0000-0000-0000-000000000001'
);

insert into payment_requests (
  id, org_id, supplier_id, amount, due_date, status, created_by, approved_by, approved_at
) values
  ('81000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', '31000000-0000-0000-0000-000000000001', 100, '2026-07-25', 'approved', '21000000-0000-0000-0000-000000000001', '21000000-0000-0000-0000-000000000001', now()),
  ('81000000-0000-0000-0000-000000000002', '11000000-0000-0000-0000-000000000001', '31000000-0000-0000-0000-000000000001', 20, '2026-07-25', 'approved', '21000000-0000-0000-0000-000000000001', '21000000-0000-0000-0000-000000000001', now()),
  ('81000000-0000-0000-0000-000000000003', '11000000-0000-0000-0000-000000000001', '31000000-0000-0000-0000-000000000001', 20, '2026-07-25', 'approved', '21000000-0000-0000-0000-000000000001', '21000000-0000-0000-0000-000000000001', now());

insert into payment_request_invoices (org_id, payment_request_id, invoice_id, amount_allocated) values
  ('11000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000001', '61000000-0000-0000-0000-000000000001', 100),
  ('11000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000002', '61000000-0000-0000-0000-000000000002', 10),
  ('11000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000002', '61000000-0000-0000-0000-000000000003', 10),
  ('11000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000003', '61000000-0000-0000-0000-000000000002', 10),
  ('11000000-0000-0000-0000-000000000001', '81000000-0000-0000-0000-000000000003', '61000000-0000-0000-0000-000000000003', 10);

insert into purchase_orders (id, org_id, supplier_id, status, created_by) values
  ('71000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', '31000000-0000-0000-0000-000000000001', 'confirmed', '21000000-0000-0000-0000-000000000001');

insert into purchase_order_items (id, org_id, order_id, product_id, qty, unit_price) values
  ('71100000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-000000000001', 10, 10);

insert into bank_imports (
  id, org_id, filename, file_hash, column_mapping, row_count, imported_by
) values (
  '91000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001',
  'p1-concurrency.csv', repeat('1', 64), '{}'::jsonb, 1, '21000000-0000-0000-0000-000000000002'
);

insert into bank_transactions (
  id, org_id, import_id, tx_date, description, amount, is_debit,
  reference, raw, supplier_id, status, row_hash
) values (
  '92000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001',
  '91000000-0000-0000-0000-000000000001', '2026-07-20', 'P1 concurrent bank match',
  50, true, 'P1-BANK', '{}'::jsonb, '31000000-0000-0000-0000-000000000001',
  'unmatched', repeat('2', 64)
);

insert into purchase_requests (
  id, org_id, status, notes, created_by, expected_date, editor_step
) values (
  '73000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001',
  'draft', 'P1 finalize lock', '21000000-0000-0000-0000-000000000001', '2026-07-30', 2
), (
  '73000000-0000-0000-0000-000000000002', '11000000-0000-0000-0000-000000000001',
  'draft', 'P1 equal-price tie', '21000000-0000-0000-0000-000000000001', '2026-07-30', 2
);

insert into purchase_request_items (
  id, org_id, request_id, product_id, qty, recommended_supplier_id, chosen_supplier_id, unit_price
) values (
  '73100000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', '73000000-0000-0000-0000-000000000001',
  '41000000-0000-0000-0000-000000000002', 1,
  '31000000-0000-0000-0000-000000000001', '31000000-0000-0000-0000-000000000001', 20
);

create function p1_concurrency_test.activate(p_user uuid)
returns void
language plpgsql
security invoker
as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('statement_timeout', '7000', true);
  perform set_config('role', 'authenticated', true);
end
$$;

create function p1_concurrency_test.run_same_payment(p_hold_seconds double precision)
returns jsonb
language plpgsql
security invoker
as $$
declare v_result jsonb;
begin
  perform p1_concurrency_test.activate('21000000-0000-0000-0000-000000000004');
  v_result := execute_payment_request(
    '81000000-0000-0000-0000-000000000001', '2026-07-22',
    'bank transfer', 'P1-SAME', null,
    '[{"invoice_id":"61000000-0000-0000-0000-000000000001","credit_id":null,"amount":100}]'::jsonb,
    'concurrent same payment request'
  );
  perform pg_sleep(p_hold_seconds);
  return v_result;
end
$$;

create function p1_concurrency_test.run_reverse_payment(p_request_id uuid, p_reference text, p_reverse boolean)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_allocations jsonb;
begin
  perform p1_concurrency_test.activate('21000000-0000-0000-0000-000000000004');
  v_allocations := case when p_reverse then
    '[
      {"invoice_id":"61000000-0000-0000-0000-000000000003","credit_id":null,"amount":10},
      {"invoice_id":"61000000-0000-0000-0000-000000000002","credit_id":null,"amount":10}
    ]'::jsonb
  else
    '[
      {"invoice_id":"61000000-0000-0000-0000-000000000002","credit_id":null,"amount":10},
      {"invoice_id":"61000000-0000-0000-0000-000000000003","credit_id":null,"amount":10}
    ]'::jsonb
  end;
  return execute_payment_request(
    p_request_id, '2026-07-22', 'bank transfer', p_reference, null,
    v_allocations, 'reverse allocation lock-order test'
  );
end
$$;

create function p1_concurrency_test.run_receipt(p_hold_seconds double precision)
returns jsonb
language plpgsql
security invoker
as $$
declare v_result jsonb;
begin
  perform p1_concurrency_test.activate('21000000-0000-0000-0000-000000000003');
  v_result := save_goods_receipt(
    '71000000-0000-0000-0000-000000000001',
    '72000000-0000-0000-0000-000000000001',
    true, null, true,
    '[{"order_item_id":"71100000-0000-0000-0000-000000000001","qty_received":10,"status":"full","notes":null}]'::jsonb,
    'concurrent receipt completion'
  );
  perform pg_sleep(p_hold_seconds);
  return v_result;
end
$$;

create function p1_concurrency_test.run_same_credit(p_hold_seconds double precision)
returns jsonb
language plpgsql
security invoker
as $$
declare v_result jsonb;
begin
  perform p1_concurrency_test.activate('21000000-0000-0000-0000-000000000001');
  v_result := transition_credit_request(
    '65000000-0000-0000-0000-000000000001', 'offset',
    'concurrent credit offset'
  );
  perform pg_sleep(p_hold_seconds);
  return v_result;
end
$$;

create function p1_concurrency_test.run_bank_match(p_hold_seconds double precision)
returns jsonb
language plpgsql
security invoker
as $$
declare v_result jsonb;
begin
  perform p1_concurrency_test.activate('21000000-0000-0000-0000-000000000005');
  v_result := match_bank_transaction(
    '92000000-0000-0000-0000-000000000001',
    '31000000-0000-0000-0000-000000000001', null,
    '93000000-0000-0000-0000-000000000001',
    '[{"invoice_id":"61000000-0000-0000-0000-000000000004","amount":50}]'::jsonb,
    0.9, 'concurrent bank match'
  );
  perform pg_sleep(p_hold_seconds);
  return v_result;
end
$$;

create function p1_concurrency_test.run_price(p_price numeric, p_effective_date date, p_hold_seconds double precision)
returns jsonb
language plpgsql
security invoker
as $$
declare v_result jsonb;
begin
  perform p1_concurrency_test.activate('21000000-0000-0000-0000-000000000001');
  v_result := set_supplier_product_price(
    '51000000-0000-0000-0000-000000000001', p_price, p_effective_date, true,
    'concurrent ordered price update'
  );
  perform pg_sleep(p_hold_seconds);
  return v_result;
end
$$;

create function p1_concurrency_test.run_finalize_price_update(p_hold_seconds double precision)
returns jsonb
language plpgsql
security invoker
as $$
declare v_result jsonb;
begin
  perform p1_concurrency_test.activate('21000000-0000-0000-0000-000000000001');
  v_result := set_supplier_product_price(
    '51000000-0000-0000-0000-000000000002', 21, '2026-07-22', true,
    'price update racing draft finalization'
  );
  perform pg_sleep(p_hold_seconds);
  return v_result;
end
$$;

create function p1_concurrency_test.run_finalize_after_price()
returns jsonb
language plpgsql
security invoker
as $$
begin
  perform p1_concurrency_test.activate('21000000-0000-0000-0000-000000000001');
  begin
    return finalize_purchase_request_draft(
      '73000000-0000-0000-0000-000000000001', 20, 'concurrent finalize'
    );
  exception when sqlstate 'P0001' then
    if sqlerrm not like '%draft_price_changed%' then
      raise;
    end if;
    return jsonb_build_object('error', 'draft_price_changed');
  end;
end
$$;

create function p1_concurrency_test.run_month_export(p_hold_seconds double precision)
returns jsonb
language plpgsql
security invoker
as $$
declare v_result jsonb;
begin
  perform p1_concurrency_test.activate('21000000-0000-0000-0000-000000000001');
  v_result := mark_month_export_sent(
    '2026-07-01', array['61000000-0000-0000-0000-000000000005'::uuid],
    'concurrent month export'
  );
  perform pg_sleep(p_hold_seconds);
  return v_result;
end
$$;

create function p1_concurrency_test.run_tie_draft()
returns jsonb
language plpgsql
security invoker
as $$
begin
  perform p1_concurrency_test.activate('21000000-0000-0000-0000-000000000001');
  return save_purchase_request_draft(
    '73000000-0000-0000-0000-000000000002',
    'deterministic equal-price recommendation', '2026-07-30', 2::smallint,
    '[{"product_id":"41000000-0000-0000-0000-000000000003","qty":1,"chosen_supplier_id":null}]'::jsonb
  );
end
$$;

select dblink_connect_u(
  'p1_a',
  format('dbname=%L user=%L', current_database(), 'postgres')
);
select dblink_connect_u(
  'p1_b',
  format('dbname=%L user=%L', current_database(), 'postgres')
);

-- The browser and save RPC both break equal-price ties by supplier UUID.
select dblink_send_query('p1_a', 'select p1_concurrency_test.run_tie_draft()');
insert into p1_concurrency_test.results
select 'tie_break', 'a', result from dblink_get_result('p1_a') as t(result jsonb);
select count(*) from dblink_get_result('p1_a') as t(result jsonb);
select p1_concurrency_test.assert(
  (select recommended_supplier_id = '31000000-0000-0000-0000-000000000001'
          and chosen_supplier_id = '31000000-0000-0000-0000-000000000001'
   from purchase_request_items
   where request_id = '73000000-0000-0000-0000-000000000002'),
  'server equal-price tie-break did not choose the lowest supplier UUID'
);

-- The first session holds the command transaction open after the RPC, while the second
-- session enters the same serialization point.
select dblink_send_query('p1_a', 'select p1_concurrency_test.run_same_payment(1.2)');
select pg_sleep(0.15);
select dblink_send_query('p1_b', 'select p1_concurrency_test.run_same_payment(0)');
insert into p1_concurrency_test.results
select 'same_payment', 'a', result from dblink_get_result('p1_a') as t(result jsonb);
insert into p1_concurrency_test.results
select 'same_payment', 'b', result from dblink_get_result('p1_b') as t(result jsonb);
select count(*) from dblink_get_result('p1_a') as t(result jsonb);
select count(*) from dblink_get_result('p1_b') as t(result jsonb);
select p1_concurrency_test.assert(
  (select count(*) = 1 from payments where payment_request_id = '81000000-0000-0000-0000-000000000001'),
  'same payment request created more than one payment'
);
select p1_concurrency_test.assert(
  (select count(*) filter (where (result->>'idempotent')::boolean) = 1
          and count(*) filter (where not (result->>'idempotent')::boolean) = 1
   from p1_concurrency_test.results where case_name = 'same_payment'),
  'same payment request did not produce one commit and one idempotent retry'
);

-- Opposite payload ordering must not change the deterministic invoice lock order.
select dblink_send_query(
  'p1_a',
  $$select p1_concurrency_test.run_reverse_payment(
    '81000000-0000-0000-0000-000000000002', 'P1-REVERSE-A', false
  )$$
);
select dblink_send_query(
  'p1_b',
  $$select p1_concurrency_test.run_reverse_payment(
    '81000000-0000-0000-0000-000000000003', 'P1-REVERSE-B', true
  )$$
);
insert into p1_concurrency_test.results
select 'reverse_allocations', 'a', result from dblink_get_result('p1_a') as t(result jsonb);
insert into p1_concurrency_test.results
select 'reverse_allocations', 'b', result from dblink_get_result('p1_b') as t(result jsonb);
select count(*) from dblink_get_result('p1_a') as t(result jsonb);
select count(*) from dblink_get_result('p1_b') as t(result jsonb);
select p1_concurrency_test.assert(
  (select count(*) = 2 from payments
   where payment_request_id in (
     '81000000-0000-0000-0000-000000000002',
     '81000000-0000-0000-0000-000000000003'
   )),
  'reversed allocation arrays deadlocked or lost a payment'
);

select dblink_send_query('p1_a', 'select p1_concurrency_test.run_receipt(1.2)');
select pg_sleep(0.15);
select dblink_send_query('p1_b', 'select p1_concurrency_test.run_receipt(0)');
insert into p1_concurrency_test.results
select 'same_receipt', 'a', result from dblink_get_result('p1_a') as t(result jsonb);
insert into p1_concurrency_test.results
select 'same_receipt', 'b', result from dblink_get_result('p1_b') as t(result jsonb);
select count(*) from dblink_get_result('p1_a') as t(result jsonb);
select count(*) from dblink_get_result('p1_b') as t(result jsonb);
select p1_concurrency_test.assert(
  (select received_qty = 10 from purchase_order_items where id = '71100000-0000-0000-0000-000000000001'),
  'concurrent receipt completion exceeded or lost ordered quantity'
);
select p1_concurrency_test.assert(
  (select count(*) = 1 from goods_receipts where id = '72000000-0000-0000-0000-000000000001'),
  'concurrent receipt completion created duplicate receipts'
);

select dblink_send_query('p1_a', 'select p1_concurrency_test.run_same_credit(1.2)');
select pg_sleep(0.15);
select dblink_send_query('p1_b', 'select p1_concurrency_test.run_same_credit(0)');
insert into p1_concurrency_test.results
select 'same_credit', 'a', result from dblink_get_result('p1_a') as t(result jsonb);
insert into p1_concurrency_test.results
select 'same_credit', 'b', result from dblink_get_result('p1_b') as t(result jsonb);
select count(*) from dblink_get_result('p1_a') as t(result jsonb);
select count(*) from dblink_get_result('p1_b') as t(result jsonb);
select p1_concurrency_test.assert(
  (select count(*) filter (where (result->>'idempotent')::boolean) = 1
          and count(*) filter (where not (result->>'idempotent')::boolean) = 1
   from p1_concurrency_test.results where case_name = 'same_credit'),
  'concurrent credit transition was not exactly-once'
);
select p1_concurrency_test.assert(
  (select status = 'offset' from credit_requests where id = '65000000-0000-0000-0000-000000000001')
  and (select payment_status = 'paid' from invoices where id = '61000000-0000-0000-0000-000000000006'),
  'concurrent credit transition did not refresh the invoice exactly once'
);

select dblink_send_query('p1_a', 'select p1_concurrency_test.run_bank_match(1.2)');
select pg_sleep(0.15);
select dblink_send_query('p1_b', 'select p1_concurrency_test.run_bank_match(0)');
insert into p1_concurrency_test.results
select 'same_bank_match', 'a', result from dblink_get_result('p1_a') as t(result jsonb);
insert into p1_concurrency_test.results
select 'same_bank_match', 'b', result from dblink_get_result('p1_b') as t(result jsonb);
select count(*) from dblink_get_result('p1_a') as t(result jsonb);
select count(*) from dblink_get_result('p1_b') as t(result jsonb);
select p1_concurrency_test.assert(
  (select count(*) = 1 from payments where id = '93000000-0000-0000-0000-000000000001'),
  'concurrent direct bank match created duplicate payments'
);
select p1_concurrency_test.assert(
  (select count(*) = 1 from bank_allocations where bank_transaction_id = '92000000-0000-0000-0000-000000000001'),
  'concurrent bank match created duplicate allocations'
);

select dblink_send_query(
  'p1_a',
  $$select p1_concurrency_test.run_price(11, '2026-07-21', 1.2)$$
);
select pg_sleep(0.15);
select dblink_send_query(
  'p1_b',
  $$select p1_concurrency_test.run_price(12, '2026-07-22', 0)$$
);
insert into p1_concurrency_test.results
select 'ordered_price', 'a', result from dblink_get_result('p1_a') as t(result jsonb);
insert into p1_concurrency_test.results
select 'ordered_price', 'b', result from dblink_get_result('p1_b') as t(result jsonb);
select count(*) from dblink_get_result('p1_a') as t(result jsonb);
select count(*) from dblink_get_result('p1_b') as t(result jsonb);
select p1_concurrency_test.assert(
  (select current_price = 12 and previous_price = 11
   from supplier_products where id = '51000000-0000-0000-0000-000000000001'),
  'concurrent price updates did not serialize current and previous values'
);
select p1_concurrency_test.assert(
  (select count(*) = 3
          and count(*) filter (where price = 11 and effective_date = '2026-07-21') = 1
          and count(*) filter (where price = 12 and effective_date = '2026-07-22') = 1
   from price_history where supplier_product_id = '51000000-0000-0000-0000-000000000001'),
  'concurrent price history does not describe both locked updates'
);

select dblink_send_query('p1_a', 'select p1_concurrency_test.run_finalize_price_update(1.2)');
select pg_sleep(0.15);
select dblink_send_query('p1_b', 'select p1_concurrency_test.run_finalize_after_price()');
insert into p1_concurrency_test.results
select 'finalize_vs_price', 'a', result from dblink_get_result('p1_a') as t(result jsonb);
insert into p1_concurrency_test.results
select 'finalize_vs_price', 'b', result from dblink_get_result('p1_b') as t(result jsonb);
select count(*) from dblink_get_result('p1_a') as t(result jsonb);
select count(*) from dblink_get_result('p1_b') as t(result jsonb);
select p1_concurrency_test.assert(
  (select result->>'error' = 'draft_price_changed'
   from p1_concurrency_test.results
   where case_name = 'finalize_vs_price' and runner = 'b'),
  'finalize accepted a stale price after waiting on the price-row lock'
);
select p1_concurrency_test.assert(
  not exists (select 1 from purchase_orders where request_id = '73000000-0000-0000-0000-000000000001'),
  'failed concurrent finalize left an order behind'
);

select dblink_send_query('p1_a', 'select p1_concurrency_test.run_month_export(1.2)');
select pg_sleep(0.15);
select dblink_send_query('p1_b', 'select p1_concurrency_test.run_month_export(0)');
insert into p1_concurrency_test.results
select 'same_month', 'a', result from dblink_get_result('p1_a') as t(result jsonb);
insert into p1_concurrency_test.results
select 'same_month', 'b', result from dblink_get_result('p1_b') as t(result jsonb);
select count(*) from dblink_get_result('p1_a') as t(result jsonb);
select count(*) from dblink_get_result('p1_b') as t(result jsonb);
select p1_concurrency_test.assert(
  (select count(*) = 1 from monthly_exports
   where org_id = '11000000-0000-0000-0000-000000000001' and month = '2026-07-01'),
  'concurrent month marking created duplicate exports'
);
select p1_concurrency_test.assert(
  (select count(*) filter (where (result->>'idempotent')::boolean) = 1
          and count(*) filter (where not (result->>'idempotent')::boolean) = 1
   from p1_concurrency_test.results where case_name = 'same_month'),
  'concurrent month marking did not produce one commit and one idempotent retry'
);

select dblink_disconnect('p1_a');
select dblink_disconnect('p1_b');

select 'p1_concurrency: all assertions passed' as result;
