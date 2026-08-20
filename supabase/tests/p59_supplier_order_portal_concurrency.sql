-- P59B -- two real sessions can create at most one supplier proposal for one link.
-- Commits disposable fixtures and must be followed immediately by a local database reset.
\set ON_ERROR_STOP on

create extension if not exists dblink;
drop schema if exists p59_portal_concurrency cascade;
create schema p59_portal_concurrency;

create function p59_portal_concurrency.assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P59B portal concurrency assertion failed: %', p_message;
  end if;
end
$$;

create table p59_portal_concurrency.results (
  runner text primary key,
  result jsonb not null
);

insert into public.organizations (id, name, status) values
  ('1c590000-0000-4000-8000-000000000001', 'P59B tenant', 'active');
insert into auth.users (id, email) values
  ('2c590000-0000-4000-8000-000000000001', 'owner-p59b@example.test');
insert into public.profiles (id, org_id, full_name, role) values
  ('2c590000-0000-4000-8000-000000000001',
   '1c590000-0000-4000-8000-000000000001', 'P59B owner', 'owner');
insert into public.suppliers (id, org_id, name, status) values
  ('3c590000-0000-4000-8000-000000000001',
   '1c590000-0000-4000-8000-000000000001', 'P59B supplier', 'active');
insert into public.products (id, org_id, name, unit) values
  ('4c590000-0000-4000-8000-000000000001',
   '1c590000-0000-4000-8000-000000000001', 'P59B item', 'unit');
insert into public.purchase_orders (
  id, org_id, supplier_id, status, expected_date, created_by
) values (
  '5c590000-0000-4000-8000-000000000001',
  '1c590000-0000-4000-8000-000000000001',
  '3c590000-0000-4000-8000-000000000001', 'ready', current_date + 7,
  '2c590000-0000-4000-8000-000000000001');
insert into public.purchase_order_items (
  id, org_id, order_id, product_id, qty, unit_price
) values (
  '6c590000-0000-4000-8000-000000000001',
  '1c590000-0000-4000-8000-000000000001',
  '5c590000-0000-4000-8000-000000000001',
  '4c590000-0000-4000-8000-000000000001', 5, 10);

insert into public.supplier_order_links (
  id, org_id, purchase_order_id, supplier_id, token_hash, order_snapshot, expires_at, issued_by
) values (
  '7c590000-0000-4000-8000-000000000001',
  '1c590000-0000-4000-8000-000000000001',
  '5c590000-0000-4000-8000-000000000001',
  '3c590000-0000-4000-8000-000000000001',
  encode(sha256(convert_to('p59b-concurrent-token', 'UTF8')), 'hex'),
  jsonb_build_object(
    'order_id', '5c590000-0000-4000-8000-000000000001',
    'order_number', 590,
    'revision_number', 1,
    'expected_date', current_date + 7,
    'notes', null,
    'supplier_name', 'P59B supplier',
    'org_name', 'P59B tenant',
    'issued_at', statement_timestamp(),
    'items', jsonb_build_array(jsonb_build_object(
      'order_item_id', '6c590000-0000-4000-8000-000000000001',
      'position', 1, 'product_name', 'P59B item', 'unit', 'unit',
      'qty', 5, 'unit_price', 10))),
  statement_timestamp() + interval '1 day',
  '2c590000-0000-4000-8000-000000000001');

create function p59_portal_concurrency.run_submit(p_qty numeric, p_hold_seconds double precision)
returns jsonb language plpgsql security invoker as $$
declare
  v_result jsonb;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('statement_timeout', '7000', true);
  perform set_config('role', 'service_role', true);
  v_result := public.service_submit_supplier_order_proposal(
    encode(sha256(convert_to('p59b-concurrent-token', 'UTF8')), 'hex'),
    jsonb_build_object('lines', jsonb_build_array(jsonb_build_object(
      'order_item_id', '6c590000-0000-4000-8000-000000000001',
      'availability', 'available', 'proposed_qty', p_qty))));
  -- Keep the link-row lock until the competing session reaches the same FOR UPDATE.
  perform pg_sleep(p_hold_seconds);
  return v_result;
end
$$;

select dblink_connect_u('p59b_a', format('dbname=%L user=%L', current_database(), 'postgres'));
select dblink_connect_u('p59b_b', format('dbname=%L user=%L', current_database(), 'postgres'));
select dblink_send_query('p59b_a',
  $$select p59_portal_concurrency.run_submit(3, 1.2)$$);
select pg_sleep(0.1);
select dblink_send_query('p59b_b',
  $$select p59_portal_concurrency.run_submit(4, 0)$$);
insert into p59_portal_concurrency.results
select 'a', result from dblink_get_result('p59b_a') as response(result jsonb);
insert into p59_portal_concurrency.results
select 'b', result from dblink_get_result('p59b_b') as response(result jsonb);
select count(*) from dblink_get_result('p59b_a') as response(result jsonb);
select count(*) from dblink_get_result('p59b_b') as response(result jsonb);

select p59_portal_concurrency.assert(
  (select count(*) = 1 from public.supplier_order_proposals
   where link_id = '7c590000-0000-4000-8000-000000000001'),
  'two concurrent submissions created more than one proposal');
select p59_portal_concurrency.assert(
  (select count(*) filter (where result ? 'proposal_id') = 1
      and count(*) filter (where result ->> 'error' = 'proposal_already_submitted') = 1
   from p59_portal_concurrency.results),
  'concurrent different payloads did not yield one proposal and one named conflict');
select p59_portal_concurrency.assert(
  (select count(*) = 1 and min(proposed_qty) in (3, 4)
   from public.supplier_order_proposal_lines
   where order_item_id = '6c590000-0000-4000-8000-000000000001'),
  'the winning proposal line was duplicated or replaced with an unexpected value');
select p59_portal_concurrency.assert(
  (select count(*) = 1 from public.audit_logs
   where action = 'supplier_order_proposal_submitted'
     and entity_id in (
       select id from public.supplier_order_proposals
       where link_id = '7c590000-0000-4000-8000-000000000001')),
  'concurrent submission appended more than one audit event');

select dblink_disconnect('p59b_a');
select dblink_disconnect('p59b_b');

\echo 'p59_supplier_order_portal_concurrency_passed'
