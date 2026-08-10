-- 0073 payment-credit concurrency harness.
-- Run only against a disposable database with all migrations through 0073 applied.
-- This file intentionally commits fixtures and opens independent sessions with dblink.
-- Clone/reset the database before every run; run psql as the disposable DB superuser.
\set ON_ERROR_STOP on

create extension if not exists dblink;
drop schema if exists payment_credit_concurrency_test cascade;
create schema payment_credit_concurrency_test;

create function payment_credit_concurrency_test.assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception '0073 concurrency assertion failed: %', p_message;
  end if;
end
$$;

create table payment_credit_concurrency_test.results (
  case_name text not null,
  runner text not null,
  result jsonb not null
);

-- Two independent requests avoid coupling the two races through business data.
insert into organizations (id, name, status) values
  ('a5730000-0000-4000-8000-000000000001', '0073 concurrency tenant', 'active');

select u.id as legal_entity
from org_units u
where u.org_id = 'a5730000-0000-4000-8000-000000000001'
  and u.unit_type = 'legal_entity'
order by u.created_at, u.id
limit 1
\gset pc_

insert into auth.users (id, email) values
  ('a5730000-0000-4000-8000-000000000002', '0073-concurrency-owner@example.test'),
  ('a5730000-0000-4000-8000-000000000003', '0073-concurrency-payer@example.test');

insert into profiles (id, org_id, full_name, role) values
  ('a5730000-0000-4000-8000-000000000002', 'a5730000-0000-4000-8000-000000000001',
   '0073 concurrency owner', 'owner'),
  ('a5730000-0000-4000-8000-000000000003', 'a5730000-0000-4000-8000-000000000001',
   '0073 concurrency payer', 'payer');

insert into suppliers (id, org_id, name) values
  ('a5730000-0000-4000-8000-000000000011', 'a5730000-0000-4000-8000-000000000001',
   '0073 replay supplier'),
  ('a5730000-0000-4000-8000-000000000012', 'a5730000-0000-4000-8000-000000000001',
   '0073 credit race supplier');

insert into invoices (
  id, org_id, unit_id, supplier_id, invoice_number, invoice_date,
  amount_before_vat, vat_amount, total_amount, review_status, payment_status
) values
  ('a5730000-0000-4000-8000-000000000021', 'a5730000-0000-4000-8000-000000000001',
   :'pc_legal_entity', 'a5730000-0000-4000-8000-000000000011',
   '0073-CONCURRENCY-REPLAY', current_date, 100, 0, 100, 'received', 'unpaid'),
  ('a5730000-0000-4000-8000-000000000022', 'a5730000-0000-4000-8000-000000000001',
   :'pc_legal_entity', 'a5730000-0000-4000-8000-000000000012',
   '0073-CONCURRENCY-CREDIT', current_date, 80, 0, 80, 'received', 'unpaid');

-- Create both requests through the real command so the replay payload and baseline audit facts
-- are production-shaped before independent sessions begin.
select set_config('request.jwt.claim.sub', 'a5730000-0000-4000-8000-000000000002', false);
set role authenticated;
select set_invoice_review_status(
  'a5730000-0000-4000-8000-000000000021', 'in_review',
  '0073 replay fixture enters review'
);
select set_invoice_review_status(
  'a5730000-0000-4000-8000-000000000021', 'approved',
  '0073 replay fixture persists assessment'
);
select set_invoice_review_status(
  'a5730000-0000-4000-8000-000000000022', 'in_review',
  '0073 credit fixture enters review'
);
select set_invoice_review_status(
  'a5730000-0000-4000-8000-000000000022', 'approved',
  '0073 credit fixture persists assessment'
);
select create_payment_request(
  'a5730000-0000-4000-8000-000000000031',
  'a5730000-0000-4000-8000-000000000011', '2026-09-01',
  'replay fixture', 'pending_approval',
  '[{"invoice_id":"a5730000-0000-4000-8000-000000000021","amount":100}]'::jsonb,
  'create replay concurrency fixture'
);
select create_payment_request(
  'a5730000-0000-4000-8000-000000000032',
  'a5730000-0000-4000-8000-000000000012', '2026-09-01',
  'credit race fixture', 'pending_approval',
  '[{"invoice_id":"a5730000-0000-4000-8000-000000000022","amount":80}]'::jsonb,
  'create credit concurrency fixture'
);
reset role;
select set_config('request.jwt.claim.sub', '', false);

create function payment_credit_concurrency_test.activate()
returns void
language plpgsql
security invoker
as $$
begin
  perform set_config('request.jwt.claim.sub', 'a5730000-0000-4000-8000-000000000002', true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', 'a5730000-0000-4000-8000-000000000002',
    'amr', jsonb_build_array(jsonb_build_object(
      'method', 'password', 'timestamp', extract(epoch from clock_timestamp())::bigint
    ))
  )::text, true);
  perform set_config('statement_timeout', '7000', true);
  perform set_config('role', 'authenticated', true);
end
$$;

-- A test-only holder proves both command families wait on the same request-specific lane before
-- they can take invoices or request rows. The private helper remains ungranted to browser roles.
create function payment_credit_concurrency_test.hold_request_lane(p_seconds double precision)
returns jsonb
language plpgsql
security definer
set search_path = payment_credit_concurrency_test, private, pg_catalog
as $$
begin
  perform private.lock_payment_request_command(
    'a5730000-0000-4000-8000-000000000001',
    'a5730000-0000-4000-8000-000000000031'
  );
  perform pg_catalog.pg_sleep(p_seconds);
  return jsonb_build_object('held', true);
end
$$;

create function payment_credit_concurrency_test.replay_request()
returns jsonb
language plpgsql
security invoker
as $$
begin
  perform payment_credit_concurrency_test.activate();
  return create_payment_request(
    'a5730000-0000-4000-8000-000000000031',
    'a5730000-0000-4000-8000-000000000011', '2026-09-01',
    'replay fixture', 'pending_approval',
    '[{"invoice_id":"a5730000-0000-4000-8000-000000000021","amount":100}]'::jsonb,
    'exact replay while approval competes'
  );
end
$$;

create function payment_credit_concurrency_test.approve_replay_request()
returns jsonb
language plpgsql
security invoker
as $$
begin
  perform payment_credit_concurrency_test.activate();
  return transition_payment_request(
    'a5730000-0000-4000-8000-000000000031', 'approved',
    'approval competing with exact creation replay'
  );
end
$$;

-- Hold the exact row lock that execute_payment_request takes first, then call the production
-- command in the same transaction. Before the replay fix this schedule formed request->invoice
-- versus invoice->request; now replay waits at the request and never consumes invoice balances.
create function payment_credit_concurrency_test.execute_after_request_hold()
returns jsonb
language plpgsql
security definer
set search_path = public, payment_credit_concurrency_test, pg_temp
as $$
begin
  perform set_config('request.jwt.claim.sub', 'a5730000-0000-4000-8000-000000000003', true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', 'a5730000-0000-4000-8000-000000000003',
    'amr', jsonb_build_array(jsonb_build_object(
      'method', 'password', 'timestamp', extract(epoch from clock_timestamp())::bigint
    ))
  )::text, true);
  perform set_config('statement_timeout', '7000', true);

  perform 1
  from public.payment_requests request
  where request.org_id = 'a5730000-0000-4000-8000-000000000001'
    and request.id = 'a5730000-0000-4000-8000-000000000031'
  for update;
  if not found then
    raise exception 'execution fixture request missing';
  end if;
  perform pg_sleep(1.2);

  return public.execute_payment_request(
    'a5730000-0000-4000-8000-000000000031', '2026-09-02',
    'bank transfer', '0073-CONCURRENT-EXECUTION', 'executed by concurrency harness',
    '[{"invoice_id":"a5730000-0000-4000-8000-000000000021","credit_id":null,"amount":100}]'::jsonb,
    'execute while exact creation replay competes'
  );
end
$$;

-- Pause after create_invoice_credit_request has locked the invoice, but before INSERT checks the
-- supplier FK. With the production lock order, approval waits on the invoice and never holds the
-- supplier against this creator. The former supplier-first order deadlocked this exact schedule.
create function payment_credit_concurrency_test.pause_credit_insert()
returns trigger
language plpgsql
as $$
begin
  if new.id = 'a5730000-0000-4000-8000-000000000041' then
    perform pg_sleep(1.2);
  end if;
  return new;
end
$$;

create trigger zz_payment_credit_concurrency_pause
before insert on credit_requests
for each row execute function payment_credit_concurrency_test.pause_credit_insert();

create function payment_credit_concurrency_test.create_competing_credit()
returns jsonb
language plpgsql
security invoker
as $$
begin
  perform payment_credit_concurrency_test.activate();
  return create_invoice_credit_request(
    'a5730000-0000-4000-8000-000000000041',
    'a5730000-0000-4000-8000-000000000022',
    'other', 10, 'concurrent open credit', 'create credit while approval competes'
  );
end
$$;

create function payment_credit_concurrency_test.approve_after_competing_credit()
returns jsonb
language plpgsql
security invoker
as $$
begin
  perform payment_credit_concurrency_test.activate();
  begin
    perform transition_payment_request(
      'a5730000-0000-4000-8000-000000000032', 'approved',
      'ordinary approval competing with credit creation'
    );
  exception when others then
    if position('payment_request_credit_override_required' in sqlerrm) = 0 then
      raise;
    end if;
    return jsonb_build_object('error', 'payment_request_credit_override_required');
  end;
  raise exception 'ordinary approval unexpectedly ignored the concurrently committed credit';
end
$$;

select dblink_connect_u(
  'pc_gate', format('dbname=%L user=%L', current_database(), 'postgres')
);
select dblink_connect_u(
  'pc_create', format('dbname=%L user=%L', current_database(), 'postgres')
);
select dblink_connect_u(
  'pc_approve', format('dbname=%L user=%L', current_database(), 'postgres')
);

-- Case 1: exact create replay and transition cannot pass the request command lane together.
select dblink_send_query(
  'pc_gate', 'select payment_credit_concurrency_test.hold_request_lane(1.2)'
);
select pg_sleep(0.15);
select dblink_send_query(
  'pc_create', 'select payment_credit_concurrency_test.replay_request()'
);
select dblink_send_query(
  'pc_approve', 'select payment_credit_concurrency_test.approve_replay_request()'
);
select pg_sleep(0.15);
select payment_credit_concurrency_test.assert(
  dblink_is_busy('pc_create') = 1 and dblink_is_busy('pc_approve') = 1,
  'creation replay and transition did not both wait on the shared advisory lane'
);
select count(*) from dblink_get_result('pc_gate') as t(result jsonb);
select count(*) from dblink_get_result('pc_gate') as t(result jsonb);
insert into payment_credit_concurrency_test.results
select 'create_replay_vs_approval', 'create', result
from dblink_get_result('pc_create') as t(result jsonb);
insert into payment_credit_concurrency_test.results
select 'create_replay_vs_approval', 'approve', result
from dblink_get_result('pc_approve') as t(result jsonb);
select count(*) from dblink_get_result('pc_create') as t(result jsonb);
select count(*) from dblink_get_result('pc_approve') as t(result jsonb);

select payment_credit_concurrency_test.assert(
  (select status = 'approved'
   from payment_requests
   where id = 'a5730000-0000-4000-8000-000000000031'),
  'serialized replay/approval race did not leave the request approved'
);
select payment_credit_concurrency_test.assert(
  (select count(*) = 1
   from payment_request_invoices
   where payment_request_id = 'a5730000-0000-4000-8000-000000000031')
  and
  (select count(*) = 1
   from audit_logs
   where entity_id = 'a5730000-0000-4000-8000-000000000031'
     and action = 'payment_request_created')
  and
  (select count(*) = 1
   from audit_logs
   where entity_id = 'a5730000-0000-4000-8000-000000000031'
     and action = 'payment_request_transitioned'),
  'serialized replay created duplicate links or audit facts'
);
select payment_credit_concurrency_test.assert(
  (select count(*) filter (where runner = 'create' and (result->>'idempotent')::boolean) = 1
          and count(*) filter (where runner = 'approve' and not (result->>'idempotent')::boolean) = 1
   from payment_credit_concurrency_test.results
   where case_name = 'create_replay_vs_approval'),
  'serialized replay and approval did not return one replay plus one transition'
);

-- Case 2: execution holds request first while an exact create replay starts. The replay must
-- wait on the request without locking invoices; execution then commits exactly one payment.
select dblink_send_query(
  'pc_approve', 'select payment_credit_concurrency_test.execute_after_request_hold()'
);
select pg_sleep(0.15);
select dblink_send_query(
  'pc_create', 'select payment_credit_concurrency_test.replay_request()'
);
insert into payment_credit_concurrency_test.results
select 'create_replay_vs_execution', 'execute', result
from dblink_get_result('pc_approve') as t(result jsonb);
insert into payment_credit_concurrency_test.results
select 'create_replay_vs_execution', 'create', result
from dblink_get_result('pc_create') as t(result jsonb);
select count(*) from dblink_get_result('pc_approve') as t(result jsonb);
select count(*) from dblink_get_result('pc_create') as t(result jsonb);

select payment_credit_concurrency_test.assert(
  (select status = 'executed'
   from payment_requests
   where id = 'a5730000-0000-4000-8000-000000000031')
  and
  (select count(*) = 1 and sum(amount) = 100
   from payments
   where payment_request_id = 'a5730000-0000-4000-8000-000000000031')
  and
  (select count(*) = 1 and sum(allocation.amount) = 100
   from payment_allocations allocation
   join payments payment on payment.id = allocation.payment_id
   where payment.payment_request_id = 'a5730000-0000-4000-8000-000000000031'),
  'replay/execution race deadlocked or created duplicate money rows'
);
select payment_credit_concurrency_test.assert(
  (select count(*) = 1
   from audit_logs
   where entity_id = 'a5730000-0000-4000-8000-000000000031'
     and action = 'payment_request_executed')
  and
  (select count(*) = 1
   from audit_logs
   where entity_id = 'a5730000-0000-4000-8000-000000000031'
     and action = 'payment_request_created')
  and
  (select count(*) filter (where runner = 'execute' and not (result->>'idempotent')::boolean) = 1
          and count(*) filter (where runner = 'create' and (result->>'idempotent')::boolean) = 1
   from payment_credit_concurrency_test.results
   where case_name = 'create_replay_vs_execution'),
  'replay/execution race duplicated audit or failed to return one execution plus one replay'
);

-- Case 3: invoice-first ordering lets credit creation commit; approval then sees the new credit
-- and fails closed instead of deadlocking or approving against a stale snapshot.
select dblink_send_query(
  'pc_create', 'select payment_credit_concurrency_test.create_competing_credit()'
);
select pg_sleep(0.15);
select dblink_send_query(
  'pc_approve', 'select payment_credit_concurrency_test.approve_after_competing_credit()'
);
insert into payment_credit_concurrency_test.results
select 'credit_create_vs_approval', 'credit', result
from dblink_get_result('pc_create') as t(result jsonb);
insert into payment_credit_concurrency_test.results
select 'credit_create_vs_approval', 'approve', result
from dblink_get_result('pc_approve') as t(result jsonb);
select count(*) from dblink_get_result('pc_create') as t(result jsonb);
select count(*) from dblink_get_result('pc_approve') as t(result jsonb);

select payment_credit_concurrency_test.assert(
  (select count(*) = 1 and bool_and(status = 'open')
   from credit_requests
   where id = 'a5730000-0000-4000-8000-000000000041')
  and
  (select status = 'pending_approval'
   from payment_requests
   where id = 'a5730000-0000-4000-8000-000000000032'),
  'credit/approval race did not preserve the open credit and pending request'
);
select payment_credit_concurrency_test.assert(
  (select result->>'error' = 'payment_request_credit_override_required'
   from payment_credit_concurrency_test.results
   where case_name = 'credit_create_vs_approval' and runner = 'approve')
  and
  not exists (
    select 1 from audit_logs
    where entity_id = 'a5730000-0000-4000-8000-000000000032'
      and action = 'payment_request_transitioned'
  ),
  'ordinary approval did not fail closed after the concurrent credit committed'
);

drop trigger zz_payment_credit_concurrency_pause on credit_requests;
select dblink_disconnect('pc_gate');
select dblink_disconnect('pc_create');
select dblink_disconnect('pc_approve');

select 'payment_credit_override_concurrency: all assertions passed' as result;
