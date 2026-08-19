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

-- Four rows chosen so every arm of the due-window money (0148) is separable at p_today
-- 2026-08-09: tenant A holds one overdue dated request (10), one UNDATED active request (20)
-- that must contribute to neither money figure, and one request falling inside the seven-day
-- window (35). Tenant B's 30 is the leak probe -- it is overdue on the same date, so a snapshot
-- that ignored org scope would report 40 instead of 10 and the number itself would say so.
insert into public.payment_requests (org_id, supplier_id, amount, due_date, status) values
  ('21000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000001', 10, '2026-08-01', 'pending_approval'),
  ('21000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000001', 20, null, 'draft'),
  ('21000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000001', 35, '2026-08-12', 'pending_approval'),
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

-- pendingApproval, dueDateCoverage and activeCount each moved by one when the 35 of 2026-08-12
-- joined the fixture above. They are still the same three claims about the same rows.
select pg_temp.p21_assert(
  public.management_dashboard_snapshot('2026-08-09') #>> '{paymentRequests,pendingApproval}' = '2'
  and public.management_dashboard_snapshot('2026-08-09') #>> '{paymentRequests,drafts}' = '1'
  and public.management_dashboard_snapshot('2026-08-09') #>> '{paymentRequests,dueDateCoverage}' = '2'
  and public.management_dashboard_snapshot('2026-08-09') #>> '{paymentRequests,activeCount}' = '3'
  and public.management_dashboard_snapshot('2026-08-09') #>> '{paymentRequests,overdue}' = '1'
  and public.management_dashboard_snapshot('2026-08-09') #>> '{paymentRequests,dueToday}' = '0',
  'dated active requests were not measured independently from undated active requests');

-- The due-window MONEY (0148). Three separate claims, each of which a plausible bug breaks alone:
--   overdueAmount = 10   -- not 40: tenant B's identically-overdue 30 must not leak in, and the
--                           undated 20 of this tenant must not be treated as due at some date.
--   dueWithin7Amount = 35 -- the [p_today, p_today+7] window contains 2026-08-12 and excludes the
--                           already-overdue 2026-08-01, so the two figures never double-count.
--   dueWithin7Count = 1   -- the count agrees with the sum it accompanies.
select pg_temp.p21_assert(
  (public.management_dashboard_snapshot('2026-08-09') #>> '{paymentRequests,overdueAmount}')::numeric = 10
  and (public.management_dashboard_snapshot('2026-08-09') #>> '{paymentRequests,dueWithin7Amount}')::numeric = 35
  and public.management_dashboard_snapshot('2026-08-09') #>> '{paymentRequests,dueWithin7Count}' = '1',
  'the due-window money leaked another tenant, counted an undated request, or double-counted the overdue slice');

-- The other half of the no-data policy, on the SAME tenant: move the business date past both
-- dated requests and the window empties while the evidence does not. An empty window under
-- existing dated requests is a measured ₪0, not "unknown" -- this is what the `coalesce` inside
-- the guard buys, and it is the assertion that fails the moment someone removes it.
select pg_temp.p21_assert(
  (public.management_dashboard_snapshot('2026-08-25') #>> '{paymentRequests,overdueAmount}')::numeric = 45
  and (public.management_dashboard_snapshot('2026-08-25') #>> '{paymentRequests,dueWithin7Amount}')::numeric = 0
  and public.management_dashboard_snapshot('2026-08-25') #>> '{paymentRequests,dueWithin7Count}' = '0',
  'an empty due window under existing dated requests must read as a measured zero, not as unknown');
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
  and public.management_dashboard_snapshot('2026-08-09') #> '{paymentRequests,dueToday}' = 'null'::jsonb
  -- The money follows the counts: no dated request at all is not ₪0 owed, it is no measurement,
  -- and the dashboard tile prints a sentence rather than a figure when it reads these nulls.
  and public.management_dashboard_snapshot('2026-08-09') #> '{paymentRequests,overdueAmount}' = 'null'::jsonb
  and public.management_dashboard_snapshot('2026-08-09') #> '{paymentRequests,dueWithin7Amount}' = 'null'::jsonb
  and public.management_dashboard_snapshot('2026-08-09') #> '{paymentRequests,dueWithin7Count}' = 'null'::jsonb,
  'absence of any active request with an explicit due date must remain unknown, not zero');

reset role;
select set_config('request.jwt.claim.sub', '31000000-0000-4000-8000-000000000002', true);
set local role authenticated;
select pg_temp.p21_assert(
  public.management_dashboard_snapshot('2026-08-09') is null,
  'accountant must not receive the owner/office management projection');
reset role;

rollback;
