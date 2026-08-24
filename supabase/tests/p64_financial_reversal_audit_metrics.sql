-- P64 -- approval-consumption reversal, legal-entity audit scope and 90-day supplier metrics.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p64_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P64 financial reversal/audit/metrics assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p64_expect_error(p_sql text, p_fragment text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
    raise exception 'P64 expected error containing %, statement succeeded: %', p_fragment, p_sql;
  exception when others then
    if sqlerrm like 'P64 expected error%' or position(p_fragment in sqlerrm) = 0 then raise; end if;
  end;
end
$$;

create function pg_temp.p64_actor(p_user uuid, p_fresh boolean default true)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', p_user::text, 'role', 'authenticated',
    'amr', case when p_fresh then jsonb_build_array(jsonb_build_object(
      'method', 'password', 'timestamp', extract(epoch from clock_timestamp())::bigint
    )) else '[]'::jsonb end
  )::text, true);
end
$$;

select pg_temp.p64_assert(
  to_regprocedure('public.reverse_invoice_three_way_approval_consumption(uuid,text)') is not null,
  'reversal command is missing');
select pg_temp.p64_assert(
  -- information_schema.columns.column_name is sql_identifier, and there is no @> between
  -- sql_identifier[] and text[]; cast per element so the containment test has an operator.
  (select array_agg(column_name::text order by ordinal_position) @>
      array['reversed_at','reversed_by','reversal_reason']::text[]
   from information_schema.columns
   where table_schema = 'public' and table_name = 'invoice_three_way_approval_snapshots'),
  'one-time reversal metadata is missing');
select pg_temp.p64_assert(
  position('approval.reversed_at is null' in lower(pg_get_functiondef(
    'private.invoice_three_way_raw(uuid,uuid)'::regprocedure))) > 0,
  'reversed latest approvals still consume quantity');

insert into public.organizations (id, name, status) values
  ('1c640000-0000-4000-8000-000000000001', 'P64 tenant', 'active');
select id as root_id from public.org_units
where org_id = '1c640000-0000-4000-8000-000000000001' and unit_type = 'root' \gset p64_
select id as legal_a from public.org_units
where org_id = '1c640000-0000-4000-8000-000000000001' and unit_type = 'legal_entity' \gset p64_
insert into public.org_units (id, org_id, parent_id, unit_type, name) values
  ('1c640000-0000-4000-8000-000000000002', '1c640000-0000-4000-8000-000000000001',
   :'p64_root_id', 'legal_entity', 'P64 sister entity');

insert into auth.users (id, email) values
  ('2c640000-0000-4000-8000-000000000001', 'owner-p64@example.test'),
  ('2c640000-0000-4000-8000-000000000002', 'office-p64@example.test'),
  ('2c640000-0000-4000-8000-000000000003', 'accountant-p64@example.test');
insert into public.profiles (id, org_id, full_name, role) values
  ('2c640000-0000-4000-8000-000000000001', '1c640000-0000-4000-8000-000000000001', 'P64 owner', 'owner'),
  ('2c640000-0000-4000-8000-000000000002', '1c640000-0000-4000-8000-000000000001', 'P64 office', 'office'),
  ('2c640000-0000-4000-8000-000000000003', '1c640000-0000-4000-8000-000000000001', 'P64 accountant', 'accountant');
delete from public.user_scope_grants where user_id = '2c640000-0000-4000-8000-000000000003';
insert into public.user_scope_grants (org_id, user_id, unit_id) values
  ('1c640000-0000-4000-8000-000000000001', '2c640000-0000-4000-8000-000000000003', :'p64_legal_a');

insert into public.suppliers (id, org_id, name) values
  ('3c640000-0000-4000-8000-000000000001', '1c640000-0000-4000-8000-000000000001', 'P64 supplier');
insert into public.invoices (
  id, org_id, supplier_id, unit_id, invoice_number, invoice_date,
  amount_before_vat, vat_amount, total_amount, review_status
) values
  ('4c640000-0000-4000-8000-000000000001', '1c640000-0000-4000-8000-000000000001',
   '3c640000-0000-4000-8000-000000000001', :'p64_legal_a', 'P64-A', current_date, 100, 18, 118, 'investigation'),
  ('4c640000-0000-4000-8000-000000000002', '1c640000-0000-4000-8000-000000000001',
   '3c640000-0000-4000-8000-000000000001', '1c640000-0000-4000-8000-000000000002', 'P64-B', current_date, 100, 18, 118, 'investigation'),
  ('4c640000-0000-4000-8000-000000000003', '1c640000-0000-4000-8000-000000000001',
   '3c640000-0000-4000-8000-000000000001', :'p64_legal_a', 'P64-LINKED', current_date, 100, 18, 118, 'investigation');

select set_config('app.invoice_three_way_writer', 'approval_snapshot', true);
insert into public.invoice_three_way_approval_snapshots (
  id, org_id, invoice_id, revision, assessment_hash, assessment, approved_by
) values
  ('5c640000-0000-4000-8000-000000000001', '1c640000-0000-4000-8000-000000000001',
   '4c640000-0000-4000-8000-000000000001', 1, repeat('a',64),
   '{"order_items":[{"purchase_order_item_id":"6c640000-0000-4000-8000-000000000001","current_invoice_quantity":2,"unit_resolved":true}]}',
   '2c640000-0000-4000-8000-000000000001'),
  ('5c640000-0000-4000-8000-000000000002', '1c640000-0000-4000-8000-000000000001',
   '4c640000-0000-4000-8000-000000000003', 1, repeat('b',64), '{"order_items":[]}',
   '2c640000-0000-4000-8000-000000000001');
select set_config('app.invoice_three_way_writer', '', true);

insert into public.payment_requests (id, org_id, supplier_id, unit_id, amount, created_by) values
  ('6c640000-0000-4000-8000-000000000001', '1c640000-0000-4000-8000-000000000001',
   '3c640000-0000-4000-8000-000000000001', :'p64_legal_a', 118,
   '2c640000-0000-4000-8000-000000000001');
insert into public.payment_request_invoices (org_id, payment_request_id, invoice_id, amount_allocated) values
  ('1c640000-0000-4000-8000-000000000001', '6c640000-0000-4000-8000-000000000001',
   '4c640000-0000-4000-8000-000000000003', 118);

select pg_temp.p64_actor('2c640000-0000-4000-8000-000000000002');
select pg_temp.p64_expect_error(
  $$select reverse_invoice_three_way_approval_consumption('5c640000-0000-4000-8000-000000000001','office')$$,
  'invoice_approval_reversal_not_authorized');
select pg_temp.p64_actor('2c640000-0000-4000-8000-000000000001', false);
select pg_temp.p64_expect_error(
  $$select reverse_invoice_three_way_approval_consumption('5c640000-0000-4000-8000-000000000001','stale')$$,
  'fresh_authentication_required');
select pg_temp.p64_actor('2c640000-0000-4000-8000-000000000001');
select pg_temp.p64_expect_error(
  $$select reverse_invoice_three_way_approval_consumption('5c640000-0000-4000-8000-000000000002','linked')$$,
  'invoice_approval_reversal_financial_links');

select pg_temp.p64_assert(
  not (reverse_invoice_three_way_approval_consumption(
    '5c640000-0000-4000-8000-000000000001', 'P64 release consumed quantity')->>'idempotent')::boolean,
  'first reversal did not commit');
select pg_temp.p64_assert(
  (select reversed_at is not null and reversed_by = '2c640000-0000-4000-8000-000000000001'
      and reversal_reason = 'P64 release consumed quantity'
   from public.invoice_three_way_approval_snapshots
   where id = '5c640000-0000-4000-8000-000000000001')
  and (select review_status = 'investigation' and deleted_at is null
       from public.invoices where id = '4c640000-0000-4000-8000-000000000001'),
  'reversal did not mark one snapshot or rewrote invoice evidence');
select pg_temp.p64_assert(
  (reverse_invoice_three_way_approval_consumption(
    '5c640000-0000-4000-8000-000000000001', 'P64 release consumed quantity')->>'idempotent')::boolean,
  'same reversal retry was not idempotent');
select pg_temp.p64_expect_error(
  $$select reverse_invoice_three_way_approval_consumption('5c640000-0000-4000-8000-000000000001','different reason')$$,
  'invoice_approval_reversal_conflict');
select pg_temp.p64_assert(
  (select count(*) = 1 from public.audit_logs
   where action = 'invoice_approval_consumption_reversed'
     and entity_id = '5c640000-0000-4000-8000-000000000001')
  and (select count(*) = 1 from public.security_events
   where event_type = 'invoice_approval_consumption_reversed'
     and details->>'snapshot_id' = '5c640000-0000-4000-8000-000000000001'),
  'reversal audit/security evidence is missing or duplicated');

-- Audit taxonomy and sister-entity isolation.
insert into public.audit_logs (org_id, user_id, action, entity_type, entity_id, reason) values
  ('1c640000-0000-4000-8000-000000000001', '2c640000-0000-4000-8000-000000000001',
   'p64_invoice_a', 'invoices', '4c640000-0000-4000-8000-000000000001', 'A'),
  ('1c640000-0000-4000-8000-000000000001', '2c640000-0000-4000-8000-000000000001',
   'p64_invoice_b', 'invoices', '4c640000-0000-4000-8000-000000000002', 'B'),
  ('1c640000-0000-4000-8000-000000000001', '2c640000-0000-4000-8000-000000000001',
   'p64_org', 'organizations', '1c640000-0000-4000-8000-000000000001', 'ORG'),
  ('1c640000-0000-4000-8000-000000000001', '2c640000-0000-4000-8000-000000000001',
   'p64_ambiguous_bank', 'bank_transactions', null, 'AMBIGUOUS');

select pg_temp.p64_actor('2c640000-0000-4000-8000-000000000003');
set local role authenticated;
select pg_temp.p64_assert(
  exists (select 1 from public.audit_log_read_model where action = 'p64_invoice_a')
  and exists (select 1 from public.audit_log_read_model where action = 'p64_org')
  and not exists (select 1 from public.audit_log_read_model where action = 'p64_invoice_b')
  and not exists (select 1 from public.audit_log_read_model where action = 'p64_ambiguous_bank'),
  'legal-entity-scoped accountant saw sister or ambiguous financial metadata');
reset role;

select pg_temp.p64_expect_error(
  $$update public.audit_logs set reason = 'rewritten' where action = 'p64_invoice_a'$$,
  'audit_log_immutable');
select pg_temp.p64_expect_error(
  $$delete from public.audit_logs where action = 'p64_invoice_a'$$,
  'audit_log_immutable');

-- An entity nobody classified is refused rather than defaulted. #255 allows cross_scope only when
-- the taxonomy says the entity is organizational, so an unclassified one has no legal answer at
-- all -- and calling it financial would additionally narrow who may read it.
select pg_temp.p64_expect_error(
  $$insert into public.audit_logs (org_id, user_id, action, entity_type, entity_id, reason)
    values ('1c640000-0000-4000-8000-000000000001', '2c640000-0000-4000-8000-000000000001',
            'p64_unclassified', 'p64_entity_not_in_taxonomy', null, 'X')$$,
  'audit_scope_taxonomy_incomplete');

-- The authorized purge is exactly as wide as tenant teardown and fixture cleanup need: DELETE
-- only, only while the caller has declared it, and never a way to rewrite what an entry says.
select set_config('app.audit_purge', 'organization_teardown', true);
select pg_temp.p64_expect_error(
  $$update public.audit_logs set reason = 'rewritten' where action = 'p64_invoice_a'$$,
  'audit_log_immutable');
with purged as (
  delete from public.audit_logs where action = 'p64_org' returning 1
)
select pg_temp.p64_assert(count(*) = 1,
  'the declared audit purge did not remove the row it named')
from purged;
select set_config('app.audit_purge', '', true);
select pg_temp.p64_expect_error(
  $$delete from public.audit_logs where action = 'p64_invoice_a'$$,
  'audit_log_immutable');

-- pg_get_viewdef re-renders an interval literal as '90 days'::interval, never as the
-- interval '90 days' the migration was written with, so the assertion matches the rendered form.
select pg_temp.p64_assert(
  position('''90 days''::interval' in lower(pg_get_viewdef('public.supplier_metrics'::regclass))) > 0
  and position('''180 days''' in lower(pg_get_viewdef('public.supplier_metrics'::regclass))) = 0
  and position('min(g.received_at)' in lower(pg_get_viewdef('public.supplier_metrics'::regclass))) > 0,
  'supplier metrics did not move to 90 days or lost first-complete-receipt rule');

rollback;
\echo 'p64_financial_reversal_audit_metrics_passed'
