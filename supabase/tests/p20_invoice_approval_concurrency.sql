-- P20B -- Concurrent invoices cannot both consume the same received quantity.
-- Commits disposable fixtures and must be followed by a local reset.
\set ON_ERROR_STOP on

create extension if not exists dblink;
drop schema if exists p20_approval_concurrency cascade;
create schema p20_approval_concurrency;

create function p20_approval_concurrency.assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P20B approval concurrency assertion failed: %', p_message;
  end if;
end
$$;

create table p20_approval_concurrency.results (
  runner text primary key,
  result jsonb not null
);

insert into public.organizations (id, name, status, vat_rate) values
  ('1c200000-0000-4000-8000-000000000001', 'P20B tenant', 'active', 17);
insert into auth.users (id, email) values
  ('2c200000-0000-4000-8000-000000000001', 'owner-p20b@example.test');
insert into public.profiles (id, org_id, full_name, role) values
  ('2c200000-0000-4000-8000-000000000001',
   '1c200000-0000-4000-8000-000000000001', 'P20B owner', 'owner');
insert into public.suppliers (id, org_id, name) values
  ('3c200000-0000-4000-8000-000000000001',
   '1c200000-0000-4000-8000-000000000001', 'P20B supplier');
insert into public.products (id, org_id, name, unit, barcode) values
  ('4c200000-0000-4000-8000-000000000001',
   '1c200000-0000-4000-8000-000000000001', 'P20B item', 'unit', '729200000001');
insert into public.purchase_orders (
  id, org_id, supplier_id, status, created_by
) values (
  '5c200000-0000-4000-8000-000000000001',
  '1c200000-0000-4000-8000-000000000001',
  '3c200000-0000-4000-8000-000000000001', 'received',
  '2c200000-0000-4000-8000-000000000001'
);
insert into public.purchase_order_items (
  id, org_id, order_id, product_id, qty, received_qty, unit_price
) values (
  '6c200000-0000-4000-8000-000000000001',
  '1c200000-0000-4000-8000-000000000001',
  '5c200000-0000-4000-8000-000000000001',
  '4c200000-0000-4000-8000-000000000001', 10, 10, 5
);
insert into public.invoices (
  id, org_id, supplier_id, invoice_number, invoice_date,
  amount_before_vat, vat_amount, total_amount, review_status, currency
) values
  ('7c200000-0000-4000-8000-000000000001',
   '1c200000-0000-4000-8000-000000000001',
   '3c200000-0000-4000-8000-000000000001', 'P20B-A', current_date,
   30, 5.10, 35.10, 'in_review', 'ILS'),
  ('7c200000-0000-4000-8000-000000000002',
   '1c200000-0000-4000-8000-000000000001',
   '3c200000-0000-4000-8000-000000000001', 'P20B-B', current_date,
   30, 5.10, 35.10, 'in_review', 'ILS');
insert into public.invoice_order_links (org_id, invoice_id, order_id) values
  ('1c200000-0000-4000-8000-000000000001',
   '7c200000-0000-4000-8000-000000000001',
   '5c200000-0000-4000-8000-000000000001'),
  ('1c200000-0000-4000-8000-000000000001',
   '7c200000-0000-4000-8000-000000000002',
   '5c200000-0000-4000-8000-000000000001');

create function p20_approval_concurrency.activate()
returns void language plpgsql security invoker as $$
begin
  perform set_config('request.jwt.claim.sub',
    '2c200000-0000-4000-8000-000000000001', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', '2c200000-0000-4000-8000-000000000001',
    'role', 'authenticated'
  )::text, true);
  perform set_config('statement_timeout', '7000', true);
  perform set_config('role', 'authenticated', true);
end
$$;

create function p20_approval_concurrency.record_fixture(
  p_invoice_id uuid, p_batch_id uuid, p_key uuid
) returns void language plpgsql security invoker as $$
begin
  perform p20_approval_concurrency.activate();
  perform public.record_invoice_line_evidence(
    p_batch_id, p_invoice_id, p_key, 'manual_entry', null, null,
    '2c200000-0000-4000-8000-000000000001',
    jsonb_build_array(jsonb_build_object(
      'line_number', 1,
      'description', 'Six P20B items',
      'supplier_sku', null,
      'barcode', '729200000001',
      'product_id', '4c200000-0000-4000-8000-000000000001',
      'quantity', 6,
      'unit', 'unit',
      'unit_price', 5,
      'discount_amount', 0,
      'vat_rate', 17,
      'line_total', 30,
      'evidence_block_ids', jsonb_build_array('p20b-human'),
      'raw_evidence', jsonb_build_object('source', 'p20b-human')
    )),
    'P20B immutable human-reviewed fixture'
  );
end
$$;

select p20_approval_concurrency.record_fixture(
  '7c200000-0000-4000-8000-000000000001',
  '8c200000-0000-4000-8000-000000000001',
  '9c200000-0000-4000-8000-000000000001');
select p20_approval_concurrency.record_fixture(
  '7c200000-0000-4000-8000-000000000002',
  '8c200000-0000-4000-8000-000000000002',
  '9c200000-0000-4000-8000-000000000002');

create function p20_approval_concurrency.run_approval(
  p_invoice_id uuid, p_hold_seconds double precision
)
returns jsonb language plpgsql security invoker as $$
declare v_result jsonb;
begin
  perform p20_approval_concurrency.activate();
  v_result := public.set_invoice_review_status(
    p_invoice_id, 'approved', 'P20B concurrent approval attempt'
  );
  -- Keep the winning approval uncommitted while the second session reaches the same lock. Without
  -- serialization both sessions would see prior=0 and approve; with it, the second waits for this
  -- transaction and then observes the immutable approval snapshot.
  perform pg_sleep(p_hold_seconds);
  return v_result;
exception when sqlstate '55000' then
  return jsonb_build_object('error', sqlerrm, 'sqlstate', sqlstate);
end
$$;

create function p20_approval_concurrency.read_match(p_invoice_id uuid)
returns jsonb language plpgsql security invoker as $$
begin
  perform p20_approval_concurrency.activate();
  return public.get_invoice_three_way_match(p_invoice_id);
end
$$;

select dblink_connect_u('p20b_a', format('dbname=%L user=%L', current_database(), 'postgres'));
select dblink_connect_u('p20b_b', format('dbname=%L user=%L', current_database(), 'postgres'));
select dblink_send_query('p20b_a', $sql$
  select p20_approval_concurrency.run_approval(
    '7c200000-0000-4000-8000-000000000001', 1.2)
$sql$);
select pg_sleep(0.1);
select dblink_send_query('p20b_b', $sql$
  select p20_approval_concurrency.run_approval(
    '7c200000-0000-4000-8000-000000000002', 0)
$sql$);
insert into p20_approval_concurrency.results
select 'a', result from dblink_get_result('p20b_a') as response(result jsonb);
insert into p20_approval_concurrency.results
select 'b', result from dblink_get_result('p20b_b') as response(result jsonb);
select count(*) from dblink_get_result('p20b_a') as response(result jsonb);
select count(*) from dblink_get_result('p20b_b') as response(result jsonb);

select p20_approval_concurrency.assert(
  (select count(*) = 1 from public.invoices
   where id in (
     '7c200000-0000-4000-8000-000000000001',
     '7c200000-0000-4000-8000-000000000002'
   ) and review_status = 'approved'),
  'two concurrent approvals consumed the same receipt quantity'
);
select p20_approval_concurrency.assert(
  (select count(*) filter (where result ? 'invoice_id') = 1
          and count(*) filter (
            where result->>'error' = 'invoice_approval_blocked_three_way_review') = 1
   from p20_approval_concurrency.results),
  'concurrent requests did not yield exactly one approval and one cumulative block'
);
select p20_approval_concurrency.assert(
  (select count(*) = 1 from public.invoice_three_way_approval_snapshots
   where invoice_id in (
     '7c200000-0000-4000-8000-000000000001',
     '7c200000-0000-4000-8000-000000000002'
   )),
  'concurrent approval did not append exactly one immutable allocation snapshot'
);
select p20_approval_concurrency.assert(
  exists (
    select 1
    from public.invoices losing
    cross join lateral jsonb_array_elements(
      p20_approval_concurrency.read_match(losing.id)->'reasons') reason
    where losing.id in (
      '7c200000-0000-4000-8000-000000000001',
      '7c200000-0000-4000-8000-000000000002'
    )
      and losing.review_status = 'in_review'
      and reason->>'code' = 'invoiced_quantity_above_received'
      and (reason->>'prior_approved_invoiced_quantity')::numeric = 6
      and (reason->>'current_invoice_quantity')::numeric = 6
      and (reason->>'invoiced_quantity')::numeric = 12
  ),
  'losing concurrent invoice did not expose the committed cumulative quantities'
);

select dblink_disconnect('p20b_a');
select dblink_disconnect('p20b_b');
select 'p20_invoice_approval_concurrency: all assertions passed' as result;
