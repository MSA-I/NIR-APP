-- P2 database regression harness. Run only against an isolated local database after all
-- migrations through 0024_p2_data_reliability.sql. The transaction is rolled back.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p2_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P2 assertion failed: %', p_message;
  end if;
end
$$;

insert into organizations (id, name, status) values
  ('12000000-0000-0000-0000-000000000001', 'P2 reliability tenant', 'active');

insert into auth.users (id, email) values
  ('22000000-0000-0000-0000-000000000001', 'p2-owner@example.test'),
  ('22000000-0000-0000-0000-000000000002', 'p2-office@example.test');

insert into profiles (id, org_id, full_name, role, active) values
  ('22000000-0000-0000-0000-000000000001', '12000000-0000-0000-0000-000000000001', 'P2 owner', 'owner', true),
  ('22000000-0000-0000-0000-000000000002', '12000000-0000-0000-0000-000000000001', 'P2 office', 'office', true);

create temporary table p2_suppliers (n integer primary key, id uuid not null);
insert into p2_suppliers
select n, gen_random_uuid() from generate_series(1, 1501) n;

insert into suppliers (id, org_id, name)
select id, '12000000-0000-0000-0000-000000000001', 'P2 supplier ' || n
from p2_suppliers;

insert into products (id, org_id, name, unit) values
  ('42000000-0000-0000-0000-000000000001', '12000000-0000-0000-0000-000000000001', 'P2 aggregate product', 'unit');

-- 1,501 current offers prove the aggregate is not bounded by PostgREST's 1,000-row cap.
insert into supplier_products (
  id, org_id, supplier_id, product_id, current_price, previous_price,
  price_effective_date, available
)
select
  gen_random_uuid(),
  '12000000-0000-0000-0000-000000000001',
  id,
  '42000000-0000-0000-0000-000000000001',
  case when n = 1501 then 1000 else 100 end,
  50,
  '2026-07-22',
  true
from p2_suppliers;

-- One stable invoice is used by the credit graph; 1,500 more form 750 duplicate groups.
insert into invoices (
  id, org_id, supplier_id, invoice_number, invoice_date, received_date,
  amount_before_vat, vat_amount, total_amount, review_status
) values (
  '62000000-0000-0000-0000-000000000001',
  '12000000-0000-0000-0000-000000000001',
  (select id from p2_suppliers where n = 1),
  'P2-CREDIT', '2026-07-22', '2026-07-22', 100, 18, 118, 'approved'
);

insert into invoices (
  id, org_id, supplier_id, invoice_number, invoice_date, received_date,
  amount_before_vat, vat_amount, total_amount
)
select
  gen_random_uuid(),
  '12000000-0000-0000-0000-000000000001',
  (select id from p2_suppliers where n = 1),
  'P2-SCALE-' || ((n - 1) / 2),
  '2026-07-22', '2026-07-22', 1, 0, 1
from generate_series(1, 1500) n;

insert into payment_requests (
  id, org_id, supplier_id, amount, due_date, status, created_by
)
select
  gen_random_uuid(),
  '12000000-0000-0000-0000-000000000001',
  (select id from p2_suppliers where n = 1),
  1,
  case when n <= 751 then '2026-07-21'::date else '2026-07-29'::date end,
  'approved',
  '22000000-0000-0000-0000-000000000001'
from generate_series(1, 1501) n;

insert into credit_requests (
  id, org_id, supplier_id, invoice_id, reason, amount, status, created_by
) values (
  '72000000-0000-0000-0000-000000000001',
  '12000000-0000-0000-0000-000000000001',
  (select id from p2_suppliers where n = 1),
  '62000000-0000-0000-0000-000000000001',
  'wrong_price', 10, 'requested',
  '22000000-0000-0000-0000-000000000001'
);

-- Aggregates execute as the browser role and remain tenant-scoped by RLS.
select set_config('request.jwt.claim.sub', '22000000-0000-0000-0000-000000000001', true);
set local role authenticated;

select pg_temp.p2_assert(
  p2_active_payment_request_total() = 1501,
  'active payment total lost rows above 1,000'
);
select pg_temp.p2_assert(
  p2_suppliers_with_price_increase_since('2026-06-22') = 1501,
  'distinct supplier increase count lost rows above 1,000'
);
select pg_temp.p2_assert(
  p2_recent_price_increase_count('2026-06-22') = 1501,
  'price increase count lost rows above 1,000'
);
select pg_temp.p2_assert(
  p2_above_average_offer_count(0.15) = 1,
  'above-average offer count is incorrect'
);
select pg_temp.p2_assert(
  p2_duplicate_invoice_group_count() = 750,
  'duplicate invoice grouping is incorrect above 1,000 rows'
);
select pg_temp.p2_assert(
  p2_invoice_without_order_count() = 1501,
  'invoice-without-order count lost rows above 1,000'
);
select pg_temp.p2_assert(
  p2_payment_due_counts('2026-07-22', '2026-07-29') = '{"total": 1501, "late": 751}'::jsonb,
  'payment due aggregate is incorrect above 1,000 rows'
);

-- received is not resolved and cannot skip the financial offset step.
select transition_credit_request(
  '72000000-0000-0000-0000-000000000001', 'received', 'P2 received credit test'
);
select pg_temp.p2_assert(
  (select resolved_at is null from credit_requests where id = '72000000-0000-0000-0000-000000000001'),
  'received credit was marked resolved before offset'
);

do $$
begin
  perform transition_credit_request(
    '72000000-0000-0000-0000-000000000001', 'closed', 'P2 invalid direct close'
  );
  raise exception 'P2 assertion failed: received credit closed without offset';
exception
  when sqlstate 'P0001' then
    if sqlerrm <> 'credit_request_transition_invalid' then raise; end if;
end
$$;

select transition_credit_request(
  '72000000-0000-0000-0000-000000000001', 'offset', 'P2 credit offset test'
);
select pg_temp.p2_assert(
  (select resolved_at is not null from credit_requests where id = '72000000-0000-0000-0000-000000000001'),
  'offset credit did not receive resolved_at'
);
select transition_credit_request(
  '72000000-0000-0000-0000-000000000001', 'closed', 'P2 credit close test'
);

reset role;
select set_config('request.jwt.claim.sub', '', true);

-- The unsafe two-step service claim is closed; only the atomic boundary is executable.
select pg_temp.p2_assert(
  not has_function_privilege(
    'service_role',
    'public.claim_notification_event(uuid,text,text,text)',
    'execute'
  ),
  'service_role can still call the non-atomic notification claim'
);
select pg_temp.p2_assert(
  has_function_privilege(
    'service_role',
    'public.claim_notification_event_and_notify(uuid,text,text,text,text,text,text)',
    'execute'
  ),
  'service_role cannot call the atomic notification boundary'
);
select pg_temp.p2_assert(
  not exists (
    select 1
    from pg_constraint old_fk
    join pg_constraint tenant_fk
      on tenant_fk.contype = 'f'
     and tenant_fk.conrelid = old_fk.conrelid
     and tenant_fk.confrelid = old_fk.confrelid
     and tenant_fk.conname like 'p0\_%\_tenant\_fk' escape '\'
     and cardinality(tenant_fk.conkey) = 2
     and old_fk.conkey[1] = tenant_fk.conkey[2]
     and old_fk.confkey[1] = tenant_fk.confkey[2]
    where old_fk.contype = 'f'
      and old_fk.connamespace = 'public'::regnamespace
      and old_fk.conname not like 'p0\_%' escape '\'
      and cardinality(old_fk.conkey) = 1
  ),
  'legacy FKs still make tenant-safe PostgREST embeds ambiguous'
);

-- The old due-alert writer suffixed the lifecycle key with the user id. A completed
-- historical row must suppress a second row for that user while other recipients enqueue.
insert into notifications (
  org_id, user_id, event_code, entity_key, severity,
  title, body, target_url, dedupe_key, push_sent_at
) values (
  '12000000-0000-0000-0000-000000000001',
  '22000000-0000-0000-0000-000000000001',
  'payment_due', 'legacy-entity', 'warning',
  'Legacy title', 'Legacy body', '/payment-requests',
  'payment_due:legacy-entity:1:warning:22000000-0000-0000-0000-000000000001',
  now()
);
create temporary table p2_legacy_delivery as
select * from enqueue_notification_delivery(
  '12000000-0000-0000-0000-000000000001',
  'payment_due', 'legacy-entity', 'warning',
  'Current title', 'Current body', '/payment-requests',
  'payment_due:legacy-entity:1:warning'
);
select pg_temp.p2_assert(
  (
    select count(*) = 1
      and bool_and(created)
      and bool_and(user_id = '22000000-0000-0000-0000-000000000002'::uuid)
    from p2_legacy_delivery
  ),
  'legacy per-user dedupe key was replayed or blocked another recipient'
);
select pg_temp.p2_assert(
  (
    select count(*) = 2
    from notifications
    where event_code = 'payment_due' and entity_key = 'legacy-entity'
  ),
  'legacy notification compatibility created the wrong recipient count'
);

-- Force a failure after the lifecycle claim. The caught subtransaction must roll both the
-- event state and recipient rows back, proving that the condition cannot be lost.
create function pg_temp.p2_fail_notification_insert()
returns trigger
language plpgsql
as $$
begin
  raise exception 'forced_notification_failure';
end
$$;
create trigger p2_forced_notification_failure
  before insert on notifications
  for each row execute function pg_temp.p2_fail_notification_insert();

do $$
begin
  perform * from claim_notification_event_and_notify(
    '12000000-0000-0000-0000-000000000001',
    'p2_atomic', 'entity-1', 'warning',
    'P2 title', 'P2 body', '/alerts'
  );
  raise exception 'P2 assertion failed: forced notification insert unexpectedly succeeded';
exception
  when others then
    if sqlerrm <> 'forced_notification_failure' then raise; end if;
end
$$;

select pg_temp.p2_assert(
  not exists (
    select 1 from notification_event_states
    where org_id = '12000000-0000-0000-0000-000000000001'
      and event_code = 'p2_atomic' and entity_key = 'entity-1'
  ),
  'notification state survived a failed atomic insert'
);
drop trigger p2_forced_notification_failure on notifications;

create temporary table p2_first_delivery as
select * from claim_notification_event_and_notify(
  '12000000-0000-0000-0000-000000000001',
  'p2_atomic', 'entity-1', 'warning',
  'P2 title', 'P2 body', '/alerts'
);
select pg_temp.p2_assert(
  (select count(*) = 2 and bool_and(created) from p2_first_delivery),
  'atomic notification did not create exactly one row per eligible recipient'
);

create temporary table p2_retry_delivery as
select * from claim_notification_event_and_notify(
  '12000000-0000-0000-0000-000000000001',
  'p2_atomic', 'entity-1', 'warning',
  'P2 title', 'P2 body', '/alerts'
);
select pg_temp.p2_assert(
  (select count(*) = 2 and not bool_or(created) from p2_retry_delivery),
  'notification retry created duplicate recipient rows'
);
select pg_temp.p2_assert(
  (select count(*) = 2 from notifications where event_code = 'p2_atomic'),
  'notification retry changed the exactly-once row count'
);

select record_notification_push_result(
  (select notification_id from p2_first_delivery order by user_id limit 1),
  true,
  null
);
select record_notification_push_result(
  (select notification_id from p2_first_delivery order by user_id desc limit 1),
  false,
  'provider_unavailable'
);

create temporary table p2_failed_retry as
select * from claim_notification_event_and_notify(
  '12000000-0000-0000-0000-000000000001',
  'p2_atomic', 'entity-1', 'warning',
  'P2 title', 'P2 body', '/alerts'
);
select pg_temp.p2_assert(
  (select count(*) = 1 and not bool_or(created) from p2_failed_retry),
  'failed Push row was not retained as the only pending retry'
);
select record_notification_push_result(
  (select notification_id from p2_failed_retry),
  true,
  null
);
select pg_temp.p2_assert(
  not exists (
    select 1 from claim_notification_event_and_notify(
      '12000000-0000-0000-0000-000000000001',
      'p2_atomic', 'entity-1', 'warning',
      'P2 title', 'P2 body', '/alerts'
    )
  ),
  'completed Push deliveries were returned for another retry'
);

rollback;

\echo 'P2 data reliability checks passed'
