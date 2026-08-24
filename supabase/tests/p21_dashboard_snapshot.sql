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

-- ===== 0168 -- which rows the due window is allowed to see =====
-- These two rows are added HERE, below the assertions above, so every claim already made keeps
-- describing the fixture it was written for. Each row is one defect 0168 fixed.
reset role;
-- The financial-command guard (0023/0033) refuses a direct write while a JWT subject is set: a
-- person writing money outside an RPC is exactly what it exists to stop. Fixture setup is not a
-- person, so it clears the subject first, as p63 does, and restores it below.
select set_config('request.jwt.claim.sub', '', true);
insert into public.payment_requests (org_id, supplier_id, amount, due_date, status) values
  -- (1) A DATED DRAFT inside the window. Before 0168 its 500 landed in dueWithin7Amount: a
  -- request nobody had submitted yet, reported as money leaving the account this week.
  ('21000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000001',
   500, '2026-08-12', 'draft'),
  -- (2) The EIGHTH day. `between p_today and p_today + 7` is inclusive at both ends, so
  -- 2026-08-16 sat inside a window the UI calls seven days. At + 6 it does not.
  ('21000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000001',
   700, '2026-08-16', 'pending_approval');
select set_config('request.jwt.claim.sub', '31000000-0000-4000-8000-000000000001', true);
set local role authenticated;

select pg_temp.p21_assert(
  (public.management_dashboard_snapshot('2026-08-09') #>> '{paymentRequests,dueWithin7Amount}')::numeric = 35
  and public.management_dashboard_snapshot('2026-08-09') #>> '{paymentRequests,dueWithin7Count}' = '1',
  'the due window admitted a draft or an eighth day -- 535, 735 or 1235 where 35 was owed');

-- Both rows ARE in the tenant, and the snapshot says so in the keys that should move: the draft
-- joins `drafts`, the eighth-day request joins the dated-coverage denominator, and neither
-- joins the money. Without this the assertion above would also pass if the inserts had failed.
-- dueDateCoverage reads 3 and not 4 because active_due_dated now excludes drafts too -- the
-- denominator of the null guard and the money it guards agree about which requests are live.
select pg_temp.p21_assert(
  public.management_dashboard_snapshot('2026-08-09') #>> '{paymentRequests,drafts}' = '2'
  and public.management_dashboard_snapshot('2026-08-09') #>> '{paymentRequests,activeCount}' = '5'
  and public.management_dashboard_snapshot('2026-08-09') #>> '{paymentRequests,dueDateCoverage}' = '3',
  'the 0168 fixture rows did not land, so the window assertion above proved nothing');


-- The other half of the no-data policy, on the SAME tenant: move the business date past both
-- dated requests and the window empties while the evidence does not. An empty window under
-- existing dated requests is a measured ₪0, not "unknown" -- this is what the `coalesce` inside
-- the guard buys, and it is the assertion that fails the moment someone removes it.
select pg_temp.p21_assert(
  (public.management_dashboard_snapshot('2026-08-25') #>> '{paymentRequests,overdueAmount}')::numeric = 745
  and (public.management_dashboard_snapshot('2026-08-25') #>> '{paymentRequests,dueWithin7Amount}')::numeric = 0
  and public.management_dashboard_snapshot('2026-08-25') #>> '{paymentRequests,dueWithin7Count}' = '0',
  -- 745 and not 1245: by this date the 10, the 35 and the 700 added above are all overdue,
  -- and the 500 draft that shares 2026-08-12 with the 35 is still excluded. The same
  -- exclusion, measured from the other side of the window.
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


-- ===== 0168 -- the unit fence =====
-- Until 0168 this was the only money tile on the dashboard with no auth_scopes() filter, while
-- the invoice-balance tile directly above it has had one since 0137. A user granted one legal
-- entity therefore read org-wide money here and scoped money one tile up.
--
-- Two sibling legal entities make the fence measurable. The owner keeps the automatic root
-- grant, whose closure spans both; the office user below is anchored to ONE of them. Both
-- requests are dated 2026-12-01, outside every window asserted above, so no figure already
-- claimed moves.
reset role;
-- Same reason as the payment_requests fixture above: the audit source guard (0020) refuses a
-- write whose org differs from the ACTOR's org, and fixture setup has no actor.
select set_config('request.jwt.claim.sub', '', true);
insert into public.org_units (id, org_id, parent_id, unit_type, name)
select ('61000000-0000-4000-8000-00000000000' || n)::uuid,
       '21000000-0000-4000-8000-000000000001', root.id, 'legal_entity', 'P21 LE' || n
from generate_series(1, 2) as n
cross join lateral (
  select id from public.org_units
  where org_id = '21000000-0000-4000-8000-000000000001' and unit_type = 'root'
) root;

insert into auth.users (id, email) values
  ('31000000-0000-4000-8000-000000000004', 'office-le1-p21@example.test');
insert into public.profiles (id, org_id, full_name, role) values
  ('31000000-0000-4000-8000-000000000004', '21000000-0000-4000-8000-000000000001',
   'P21 LE1 office', 'office');
-- A new profile is anchored to the root automatically, and a root grant closes over the whole
-- subtree. A user who is meant to see ONE legal entity must therefore have that grant removed
-- before the narrow one is added -- the p3_org_scope idiom.
delete from public.user_scope_grants
where user_id = '31000000-0000-4000-8000-000000000004';
insert into public.user_scope_grants (org_id, user_id, unit_id) values
  ('21000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000004',
   '61000000-0000-4000-8000-000000000001');

insert into public.payment_requests (org_id, supplier_id, amount, due_date, status, unit_id) values
  ('21000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000001',
   900, '2026-12-01', 'pending_approval', '61000000-0000-4000-8000-000000000001'),
  ('21000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000001',
   1300, '2026-12-01', 'pending_approval', '61000000-0000-4000-8000-000000000002');

-- The root-granted owner sees both legal entities: 900 + 1300.
select set_config('request.jwt.claim.sub', '31000000-0000-4000-8000-000000000001', true);
set local role authenticated;
select pg_temp.p21_assert(
  (public.management_dashboard_snapshot('2026-11-28') #>> '{paymentRequests,dueWithin7Amount}')::numeric = 2200,
  'a root-granted actor lost money that its scope closure covers');

-- The LE1-granted office user sees its own legal entity and the unit-less rows, and nothing of
-- LE2. Both halves matter: 900 proves the fence does not drop money it should show, and the
-- absence of 1300 proves it drops money it should not. 745 restates that unit_id IS NULL stays
-- org-visible by design (0054), which is why the older rows are still counted here.
reset role;
select set_config('request.jwt.claim.sub', '31000000-0000-4000-8000-000000000004', true);
set local role authenticated;
select pg_temp.p21_assert(
  (public.management_dashboard_snapshot('2026-11-28') #>> '{paymentRequests,dueWithin7Amount}')::numeric = 900
  and (public.management_dashboard_snapshot('2026-11-28') #>> '{paymentRequests,overdueAmount}')::numeric = 745,
  'the due window ignored unit scope -- 2200 instead of 900, or dropped the org-visible rows');
reset role;
select set_config('request.jwt.claim.sub', '31000000-0000-4000-8000-000000000002', true);
set local role authenticated;
select pg_temp.p21_assert(
  public.management_dashboard_snapshot('2026-08-09') is null,
  'accountant must not receive the owner/office management projection');
reset role;

rollback;
