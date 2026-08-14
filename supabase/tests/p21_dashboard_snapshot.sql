-- P21 -- Management dashboard aggregation is tenant-scoped, role-gated and evidence-aware.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p21_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P21 dashboard assertion failed: %', p_message;
  end if;
end
$$;

select pg_temp.p21_assert(
  not (select p.prosecdef from pg_catalog.pg_proc p
       where p.oid = 'public.management_dashboard_snapshot(date)'::regprocedure),
  'dashboard projection must remain SECURITY INVOKER');
select pg_temp.p21_assert(
  has_function_privilege('authenticated', 'public.management_dashboard_snapshot(date)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.management_dashboard_snapshot(date)', 'EXECUTE'),
  'dashboard projection execute grants drifted');

insert into public.organizations (id, name, status) values
  ('21000000-0000-4000-8000-000000000001', 'P21 tenant A', 'active'),
  ('21000000-0000-4000-8000-000000000002', 'P21 tenant B', 'active'),
  ('21000000-0000-4000-8000-000000000003', 'P21 empty tenant', 'active');
insert into auth.users (id, email) values
  ('31000000-0000-4000-8000-000000000001', 'owner-p21@example.test'),
  ('31000000-0000-4000-8000-000000000002', 'accountant-p21@example.test'),
  ('31000000-0000-4000-8000-000000000003', 'empty-owner-p21@example.test');
insert into public.profiles (id, org_id, full_name, role) values
  ('31000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001', 'P21 owner', 'owner'),
  ('31000000-0000-4000-8000-000000000002', '21000000-0000-4000-8000-000000000001', 'P21 accountant', 'accountant'),
  ('31000000-0000-4000-8000-000000000003', '21000000-0000-4000-8000-000000000003', 'P21 empty owner', 'owner');
insert into public.user_scope_grants (org_id, user_id, unit_id)
select unit.org_id, actor.user_id, unit.id
from public.org_units unit
cross join (values
  ('31000000-0000-4000-8000-000000000001'::uuid),
  ('31000000-0000-4000-8000-000000000002'::uuid)
) actor(user_id)
where unit.org_id = '21000000-0000-4000-8000-000000000001'
on conflict do nothing;
-- Profiles receive the root grant automatically; the explicit rows above add the branch and
-- legal-entity scopes used by the dashboard fixtures without assuming one physical unit type.
insert into public.suppliers (id, org_id, name) values
  ('41000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001', 'P21 supplier A'),
  ('41000000-0000-4000-8000-000000000002', '21000000-0000-4000-8000-000000000002', 'P21 supplier B');

-- Credits are derived, scope-checked rows and cannot be visible without a real invoice or
-- receipt-item anchor. Soft-deleted invoices keep that immutable identity evidence without
-- contributing an open balance to this dashboard fixture.
insert into public.invoices (
  id, org_id, supplier_id, invoice_number, invoice_date,
  amount_before_vat, vat_amount, total_amount
) values
  ('51000000-0000-4000-8000-000000000001', '21000000-0000-4000-8000-000000000001',
   '41000000-0000-4000-8000-000000000001', 'P21-A', '2026-08-01', 7, 0, 7),
  ('51000000-0000-4000-8000-000000000002', '21000000-0000-4000-8000-000000000002',
   '41000000-0000-4000-8000-000000000002', 'P21-B', '2026-08-01', 70, 0, 70);

insert into public.payment_requests (org_id, supplier_id, amount, due_date, status) values
  ('21000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000001', 10, '2026-08-01', 'pending_approval'),
  ('21000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000001', 20, null, 'draft'),
  ('21000000-0000-4000-8000-000000000002', '41000000-0000-4000-8000-000000000002', 30, '2026-08-01', 'pending_approval');
insert into public.credit_requests (org_id, supplier_id, invoice_id, reason, amount, status) values
  ('21000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000001',
   '51000000-0000-4000-8000-000000000001', 'other', 7, 'open'),
  ('21000000-0000-4000-8000-000000000002', '41000000-0000-4000-8000-000000000002',
   '51000000-0000-4000-8000-000000000002', 'other', 70, 'open');

-- The credit is created while its payable invoice is live. A later soft delete preserves the
-- immutable reference while excluding the invoice from the dashboard's open-balance evidence.
update public.invoices
set deleted_at = statement_timestamp()
where id in (
  '51000000-0000-4000-8000-000000000001',
  '51000000-0000-4000-8000-000000000002'
);

select set_config('request.jwt.claim.sub', '31000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select pg_temp.p21_assert(
  public.management_dashboard_snapshot('2026-08-09') #>> '{paymentRequests,pendingApproval}' = '1'
  and public.management_dashboard_snapshot('2026-08-09') #>> '{paymentRequests,drafts}' = '1'
  and public.management_dashboard_snapshot('2026-08-09') #>> '{paymentRequests,dueDateCoverage}' = '1'
  and public.management_dashboard_snapshot('2026-08-09') #>> '{paymentRequests,activeCount}' = '2'
  and public.management_dashboard_snapshot('2026-08-09') #>> '{paymentRequests,overdue}' = '1'
  and public.management_dashboard_snapshot('2026-08-09') #>> '{paymentRequests,dueToday}' = '0',
  'dated active requests were not measured independently from undated active requests');
select pg_temp.p21_assert(
  public.management_dashboard_snapshot('2026-08-09') #>> '{credits,count}' = '1'
  and (public.management_dashboard_snapshot('2026-08-09') #>> '{credits,sum}')::numeric = 7,
  'credit aggregation leaked another tenant');
select pg_temp.p21_assert(
  public.management_dashboard_snapshot('2026-08-09') #> '{money,openBalance}' = 'null'::jsonb,
  'missing invoice evidence must remain null, not zero');
select pg_temp.p21_assert(
  public.management_dashboard_snapshot(null) is null,
  'missing business date must not turn due-date uncertainty into zero');

reset role;
select set_config('request.jwt.claim.sub', '31000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select pg_temp.p21_assert(
  public.management_dashboard_snapshot('2026-08-09') #>> '{paymentRequests,activeCount}' = '0'
  and public.management_dashboard_snapshot('2026-08-09') #>> '{paymentRequests,dueDateCoverage}' = '0'
  and public.management_dashboard_snapshot('2026-08-09') #> '{paymentRequests,overdue}' = 'null'::jsonb
  and public.management_dashboard_snapshot('2026-08-09') #> '{paymentRequests,dueToday}' = 'null'::jsonb,
  'absence of any active request with an explicit due date must remain unknown, not zero');

reset role;
select set_config('request.jwt.claim.sub', '31000000-0000-4000-8000-000000000002', true);
set local role authenticated;
select pg_temp.p21_assert(
  public.management_dashboard_snapshot('2026-08-09') is null,
  'accountant must not receive the owner/office management projection');
reset role;

rollback;
