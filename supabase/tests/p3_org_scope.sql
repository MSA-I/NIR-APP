-- P3 organization-scope harness for 0054-0058. Run only against an isolated local database
-- with every migration applied. The transaction is rolled back.
--
-- What it proves, per PLAN-03 §3.3:
--   (a) the RESTRICTIVE rider denies AS AUTHENTICATED: a branch-scoped user does not see
--       another unit's rows and does see unit_id-NULL rows;
--   (b) the balance functions respect scope after 0057 with correct per-unit sums, and the
--       0031 role gates survived the re-declaration (office: zero rows; accountant:
--       approved-only) -- the silent-revert detector;
--   (c) grant -> closure resynced synchronously in the same transaction; revoke -> gone
--       immediately, through the real owner RPCs with audit;
--  (c2) the 0071 last-grant floor: a non-last revoke still succeeds, revoking the LAST grant
--       of an active member is refused by name, the refusal leaves grant/closure/visibility
--       intact, and a deactivated member may still be emptied;
--   (d) an org_units cycle is rejected;
--   (e) A1/A3/A5 actually detect mutations: a weakened rider, an unregistered table and an
--       uncovered definer -- each rolled back;
--   (f) the latch: while the exemption registry is non-empty, an organization with sibling
--       units of the same type is flagged; a drained registry silences it;
--   (g) saved-view commands: owner saves and reads, shared writes demand a reason, other
--       users cannot edit, and the other tenant sees nothing.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p3_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P3 org scope assertion failed: %', p_message;
  end if;
end
$$;

-- ===== Fixture =====
-- Two tenants. The 0054 seeding triggers give each its default chain
-- (root > legal_entity > branch > warehouse); tenant A then grows a second legal entity and
-- a second branch -- the exact state the rider exists for.

insert into organizations (id, name, status) values
  ('15000000-0000-0000-0000-000000000001', 'P3 scope tenant A', 'active'),
  ('15000000-0000-0000-0000-000000000002', 'P3 scope tenant B', 'active');

-- Trigger-created default units of tenant A, captured for the fixture below.
select u.id as le1 from org_units u
where u.org_id = '15000000-0000-0000-0000-000000000001' and u.unit_type = 'legal_entity'
order by u.created_at, u.id limit 1
\gset unit_
select u.id as branch1 from org_units u
where u.org_id = '15000000-0000-0000-0000-000000000001' and u.unit_type = 'branch'
order by u.created_at, u.id limit 1
\gset unit_
select u.id as root from org_units u
where u.org_id = '15000000-0000-0000-0000-000000000001' and u.unit_type = 'root'
\gset unit_

-- The sibling units: a second legal entity under the root, a second branch under le1.
insert into org_units (id, org_id, parent_id, unit_type, name) values
  ('16000000-0000-0000-0000-000000000002', '15000000-0000-0000-0000-000000000001',
   :'unit_root', 'legal_entity', 'P3 second entity'),
  ('16000000-0000-0000-0000-000000000003', '15000000-0000-0000-0000-000000000001',
   :'unit_le1', 'branch', 'P3 second branch');

insert into auth.users (id, email) values
  ('25000000-0000-0000-0000-000000000001', 'p3-owner-a@example.test'),
  ('25000000-0000-0000-0000-000000000002', 'p3-branch-a@example.test'),
  ('25000000-0000-0000-0000-000000000003', 'p3-entity-a@example.test'),
  ('25000000-0000-0000-0000-000000000004', 'p3-office-a@example.test'),
  ('25000000-0000-0000-0000-000000000005', 'p3-accountant-a@example.test'),
  ('25000000-0000-0000-0000-000000000009', 'p3-owner-b@example.test');

-- Every profile is auto-anchored to the root by the 0054 trigger. The two partial users are
-- then re-anchored directly (trusted-migration-style DML; the RPC path is proven in (c)):
-- branch-a holds ONLY the second branch, entity-a ONLY the first legal entity.
insert into profiles (id, org_id, full_name, role) values
  ('25000000-0000-0000-0000-000000000001', '15000000-0000-0000-0000-000000000001', 'P3 Owner A', 'owner'),
  ('25000000-0000-0000-0000-000000000002', '15000000-0000-0000-0000-000000000001', 'P3 Branch-scoped A', 'owner'),
  ('25000000-0000-0000-0000-000000000003', '15000000-0000-0000-0000-000000000001', 'P3 Entity-scoped A', 'owner'),
  ('25000000-0000-0000-0000-000000000004', '15000000-0000-0000-0000-000000000001', 'P3 Office A', 'office'),
  ('25000000-0000-0000-0000-000000000005', '15000000-0000-0000-0000-000000000001', 'P3 Accountant A', 'accountant'),
  ('25000000-0000-0000-0000-000000000009', '15000000-0000-0000-0000-000000000002', 'P3 Owner B', 'owner');

delete from user_scope_grants
where user_id in ('25000000-0000-0000-0000-000000000002', '25000000-0000-0000-0000-000000000003');
insert into user_scope_grants (org_id, user_id, unit_id) values
  ('15000000-0000-0000-0000-000000000001', '25000000-0000-0000-0000-000000000002',
   '16000000-0000-0000-0000-000000000003'),
  ('15000000-0000-0000-0000-000000000001', '25000000-0000-0000-0000-000000000003',
   :'unit_le1');

-- The closure was maintained synchronously by the grant triggers alone.
select pg_temp.p3_assert(
  (select c.unit_ids = array['16000000-0000-0000-0000-000000000003'::uuid]
   from user_scope_closure c
   where c.user_id = '25000000-0000-0000-0000-000000000002'),
  'branch-scoped closure must hold exactly the second branch');
select pg_temp.p3_assert(
  (select :'unit_le1'::uuid = any(c.unit_ids)
      and :'unit_branch1'::uuid = any(c.unit_ids)
      and '16000000-0000-0000-0000-000000000003'::uuid = any(c.unit_ids)
      and not ('16000000-0000-0000-0000-000000000002'::uuid = any(c.unit_ids))
      and not (:'unit_root'::uuid = any(c.unit_ids))
   from user_scope_closure c
   where c.user_id = '25000000-0000-0000-0000-000000000003'),
  'entity-scoped closure must be the le1 subtree: both branches, never le2 or the root');

insert into suppliers (id, org_id, name) values
  ('35000000-0000-0000-0000-000000000001', '15000000-0000-0000-0000-000000000001', 'P3 supplier A1'),
  ('35000000-0000-0000-0000-000000000009', '15000000-0000-0000-0000-000000000002', 'P3 supplier B1');

-- Purchase orders across units. po3 models a pre-0055 legacy row: the 0055 default trigger
-- assigns a unit on insert, so the org-visible NULL state is restored by direct update
-- (auth.uid() IS NULL -- the documented trusted-backfill contract, 0033:19).
insert into purchase_orders (id, org_id, supplier_id, unit_id, status) values
  ('45000000-0000-0000-0000-000000000001', '15000000-0000-0000-0000-000000000001',
   '35000000-0000-0000-0000-000000000001', :'unit_branch1', 'sent'),
  ('45000000-0000-0000-0000-000000000002', '15000000-0000-0000-0000-000000000001',
   '35000000-0000-0000-0000-000000000001', '16000000-0000-0000-0000-000000000003', 'sent'),
  ('45000000-0000-0000-0000-000000000003', '15000000-0000-0000-0000-000000000001',
   '35000000-0000-0000-0000-000000000001', null, 'sent');
update purchase_orders set unit_id = null
where id = '45000000-0000-0000-0000-000000000003';

-- Invoices across legal entities; inv3 is the org-visible NULL row. inv1 is transitioned to
-- approved after insert so the 3-way approval guard evaluates and persists the trusted fixture
-- assessment instead of bypassing the production command boundary with an approved INSERT.
insert into invoices (id, org_id, supplier_id, unit_id, invoice_number, invoice_date,
                      amount_before_vat, vat_amount, total_amount, review_status) values
  ('55000000-0000-0000-0000-000000000001', '15000000-0000-0000-0000-000000000001',
   '35000000-0000-0000-0000-000000000001', :'unit_le1', 'P3-INV-1', '2026-07-01',
   847.46, 152.54, 1000, 'received'),
  ('55000000-0000-0000-0000-000000000002', '15000000-0000-0000-0000-000000000001',
   '35000000-0000-0000-0000-000000000001', '16000000-0000-0000-0000-000000000002',
   'P3-INV-2', '2026-07-02', 423.73, 76.27, 500, 'received'),
  ('55000000-0000-0000-0000-000000000003', '15000000-0000-0000-0000-000000000001',
   '35000000-0000-0000-0000-000000000001', null, 'P3-INV-3', '2026-07-03',
   169.49, 30.51, 200, 'received');
select set_config('request.jwt.claim.sub', '25000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select public.set_invoice_review_status(
  '55000000-0000-0000-0000-000000000001', 'in_review',
  'P3 enters review through the financial command boundary');
select public.set_invoice_review_status(
  '55000000-0000-0000-0000-000000000001', 'approved',
  'P3 persists the no-order assessment before accountant scope assertions');
reset role;
select set_config('request.jwt.claim.sub', '', true);
update invoices set unit_id = null
where id = '55000000-0000-0000-0000-000000000003';

-- A partial payment against inv1: balance 700 = 1000 - 300.
insert into payments (id, org_id, supplier_id, amount, paid_date) values
  ('65000000-0000-0000-0000-000000000001', '15000000-0000-0000-0000-000000000001',
   '35000000-0000-0000-0000-000000000001', 300, '2026-07-10');
insert into payment_allocations (payment_id, invoice_id, amount) values
  ('65000000-0000-0000-0000-000000000001', '55000000-0000-0000-0000-000000000001', 300);

-- ===== (a) The rider denies as authenticated =====
select set_config('request.jwt.claim.sub', '25000000-0000-0000-0000-000000000002', true);
set local role authenticated;
select count(*)::text as po_visible from purchase_orders \gset branch_
select count(*)::text as po_foreign from purchase_orders
where id = '45000000-0000-0000-0000-000000000001' \gset branch_
select count(*)::text as po_null from purchase_orders
where id = '45000000-0000-0000-0000-000000000003' \gset branch_
select count(*)::text as inv_visible from invoices \gset branch_
reset role;

select pg_temp.p3_assert(
  :'branch_po_visible'::int = 2
    and :'branch_po_foreign'::int = 0
    and :'branch_po_null'::int = 1
    and :'branch_inv_visible'::int = 1,
  'branch-scoped user must see own-branch and NULL rows only: the other branch is denied, '
  || 'and legal-entity invoices are outside a branch closure');

select set_config('request.jwt.claim.sub', '25000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select count(*)::text as po_visible from purchase_orders \gset owner_
select count(*)::text as inv_visible from invoices \gset owner_
reset role;
select pg_temp.p3_assert(
  :'owner_po_visible'::int = 3 and :'owner_inv_visible'::int = 3,
  'root-anchored owner must keep seeing every row -- todays behaviour, unchanged');

select set_config('request.jwt.claim.sub', '25000000-0000-0000-0000-000000000009', true);
set local role authenticated;
select count(*)::text as po_visible from purchase_orders \gset foreign_
select count(*)::text as inv_visible from invoices \gset foreign_
reset role;
select pg_temp.p3_assert(
  :'foreign_po_visible'::int = 0 and :'foreign_inv_visible'::int = 0,
  'tenant B must keep seeing nothing of tenant A');

-- ===== (b) Balance functions respect scope, and the 0031 role gates survived =====
select set_config('request.jwt.claim.sub', '25000000-0000-0000-0000-000000000001', true);
select count(*)::text as rows, coalesce(sum(balance), -1)::text as total
from p0_invoice_balance_rows() \gset owner_bal_
select coalesce(open_balance, -1)::text as balance, coalesce(open_invoices, -1)::text as count
from p0_supplier_balance_rows()
where supplier_id = '35000000-0000-0000-0000-000000000001' \gset owner_sup_
select pg_temp.p3_assert(
  :'owner_bal_rows'::int = 3 and :'owner_bal_total'::numeric = 1400.00
    and :'owner_sup_balance'::numeric = 1400.00 and :'owner_sup_count'::int = 3,
  'root owner balances must aggregate all three invoices (700 + 500 + 200)');

select set_config('request.jwt.claim.sub', '25000000-0000-0000-0000-000000000003', true);
select count(*)::text as rows, coalesce(sum(balance), -1)::text as total,
       coalesce(sum(paid_amount), -1)::text as paid
from p0_invoice_balance_rows() \gset entity_bal_
select coalesce(open_balance, -1)::text as balance, coalesce(open_invoices, -1)::text as count
from p0_supplier_balance_rows()
where supplier_id = '35000000-0000-0000-0000-000000000001' \gset entity_sup_
select pg_temp.p3_assert(
  :'entity_bal_rows'::int = 2 and :'entity_bal_total'::numeric = 900.00
    and :'entity_bal_paid'::numeric = 300.00
    and :'entity_sup_balance'::numeric = 900.00 and :'entity_sup_count'::int = 2,
  'entity-scoped balances must be the le1 invoice plus the NULL invoice: 700 + 200, paid 300 '
  || '-- never the other entity''s 500');

select set_config('request.jwt.claim.sub', '25000000-0000-0000-0000-000000000002', true);
select count(*)::text as rows, coalesce(sum(balance), -1)::text as total
from p0_invoice_balance_rows() \gset branch_bal_
select pg_temp.p3_assert(
  :'branch_bal_rows'::int = 1 and :'branch_bal_total'::numeric = 200.00,
  'branch-scoped balances must hold only the org-visible NULL invoice');

-- The 0031 gates, pinned against a 0022 silent revert: office gets NOTHING from either
-- function; accountant gets approved invoices only.
select set_config('request.jwt.claim.sub', '25000000-0000-0000-0000-000000000004', true);
select count(*)::text as inv_rows from p0_invoice_balance_rows() \gset office_
select count(*)::text as sup_rows from p0_supplier_balance_rows() \gset office_
select pg_temp.p3_assert(
  :'office_inv_rows'::int = 0 and :'office_sup_rows'::int = 0,
  'office must stay outside both balance functions (the 0031 narrowing, not the 0022 gate)');

select set_config('request.jwt.claim.sub', '25000000-0000-0000-0000-000000000005', true);
select count(*)::text as rows, coalesce(sum(balance), -1)::text as total
from p0_invoice_balance_rows() \gset acct_
select pg_temp.p3_assert(
  :'acct_rows'::int = 1 and :'acct_total'::numeric = 700.00,
  'accountant must see approved invoices only (inv1, balance 700)');

-- ===== (c) Grant and revoke resync the closure synchronously, through the owner RPCs =====
select set_config('request.jwt.claim.sub', '25000000-0000-0000-0000-000000000001', true);
-- 0061 wires step-up into the scope commands; the owner needs a fresh password AMR
-- (p1_financial_commands.sql idiom).
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', '25000000-0000-0000-0000-000000000001',
  'amr', jsonb_build_array(jsonb_build_object(
    'method', 'password', 'timestamp', extract(epoch from clock_timestamp())::bigint
  ))
)::text, true);
select grant_user_scope(
  '25000000-0000-0000-0000-000000000002', :'unit_branch1', 'P3: widen to the first branch');
select pg_temp.p3_assert(
  (select :'unit_branch1'::uuid = any(c.unit_ids)
      and '16000000-0000-0000-0000-000000000003'::uuid = any(c.unit_ids)
   from user_scope_closure c
   where c.user_id = '25000000-0000-0000-0000-000000000002'),
  'grant_user_scope must land in the closure within the same transaction');

-- The widened scope is immediately effective for the rider.
set local role authenticated;
select set_config('request.jwt.claim.sub', '25000000-0000-0000-0000-000000000002', true);
select count(*)::text as po_visible from purchase_orders \gset widened_
reset role;
select pg_temp.p3_assert(:'widened_po_visible'::int = 3,
  'after the grant the branch user must see both branches plus the NULL row');

select set_config('request.jwt.claim.sub', '25000000-0000-0000-0000-000000000001', true);
select revoke_user_scope(
  '25000000-0000-0000-0000-000000000002', :'unit_branch1', 'P3: narrow back');
select pg_temp.p3_assert(
  (select not (:'unit_branch1'::uuid = any(c.unit_ids))
      and '16000000-0000-0000-0000-000000000003'::uuid = any(c.unit_ids)
   from user_scope_closure c
   where c.user_id = '25000000-0000-0000-0000-000000000002'),
  'revoke_user_scope must leave the closure immediately -- stale closure is a security bug');

select pg_temp.p3_assert(
  (select count(*) from audit_logs
   where org_id = '15000000-0000-0000-0000-000000000001'
     and action in ('user_scope_granted', 'user_scope_revoked')
     and entity_id = '25000000-0000-0000-0000-000000000002') = 2,
  'both scope commands must write reasoned audit rows in the same transaction');

-- ===== (c2) The last-grant guard: narrow to one unit, never to none (0071, audit §G) =====
-- Before 0071 the chain was: revoke the only grant -> p0_recompute_scope_closure deletes the
-- closure row -> auth_scopes() coalesces to '{}' -> the RESTRICTIVE rider denies every row on
-- the five tables whose p0_*_set_unit trigger stamps a non-NULL unit -> both balance
-- functions return 0. Not an error, not a dash: a confident zero, indistinguishable from an
-- empty business. The revoke at (c) above deliberately was NOT the last grant, so it is
-- already the "non-last revoke still succeeds" half; pin that reading, then prove the floor.
select pg_temp.p3_assert(
  (select count(*) from user_scope_grants
   where org_id = '15000000-0000-0000-0000-000000000001'
     and user_id = '25000000-0000-0000-0000-000000000002') = 1,
  'the non-last revoke at (c) must have succeeded and left exactly one grant standing');

do $$
begin
  perform revoke_user_scope(
    '25000000-0000-0000-0000-000000000002',
    '16000000-0000-0000-0000-000000000003', 'P3: take the last unit away');
  raise exception
    'P3 org scope assertion failed: the last scope grant of an active member was revoked';
exception when sqlstate '42501' then
  if sqlerrm not like '%scope_last_grant_required%' then raise; end if;
end
$$;

-- The refusal rolled its own delete back, so grant, closure and visibility all survive.
select pg_temp.p3_assert(
  (select count(*) from user_scope_grants
   where org_id = '15000000-0000-0000-0000-000000000001'
     and user_id = '25000000-0000-0000-0000-000000000002') = 1,
  'the refused revoke must leave the grant in place');
select pg_temp.p3_assert(
  (select c.unit_ids = array['16000000-0000-0000-0000-000000000003'::uuid]
   from user_scope_closure c
   where c.user_id = '25000000-0000-0000-0000-000000000002'),
  'the refused revoke must leave the closure intact');

set local role authenticated;
select set_config('request.jwt.claim.sub', '25000000-0000-0000-0000-000000000002', true);
select count(*)::text as po_visible from purchase_orders \gset guarded_
reset role;
select set_config('request.jwt.claim.sub', '25000000-0000-0000-0000-000000000001', true);
select pg_temp.p3_assert(:'guarded_po_visible'::int = 2,
  'after the refused revoke the member still sees their own branch plus the org-visible row '
  || '-- a zero here IS the audit paragraph-G defect, and it reaches the screen as 0, not a dash');

-- And the floor lifts the moment the member stops being live: deactivating first and then
-- emptying the grants is legitimate housekeeping, and a deactivated user holds no session
-- that could be shown a false zero.
savepoint last_grant_inactive;
-- Through the real command, not a direct UPDATE: profiles_guard_privileged_columns() blocks
-- direct writes to role/active/supplier_id (profile_access_rpc_required), which is itself the
-- right answer -- so the sub-case also proves the guard composes with the actual
-- deactivation path. Role is passed unchanged; only `active` moves.
select manage_profile_access(
  '25000000-0000-0000-0000-000000000002', 'owner', false, null,
  'P3: deactivate before emptying the scope');
select revoke_user_scope(
  '25000000-0000-0000-0000-000000000002',
  '16000000-0000-0000-0000-000000000003', 'P3: deactivated first, then emptied');
select pg_temp.p3_assert(
  not exists (
    select 1 from user_scope_grants
    where org_id = '15000000-0000-0000-0000-000000000001'
      and user_id = '25000000-0000-0000-0000-000000000002'),
  'a deactivated member may be emptied -- the guard is a floor for LIVE members only');
rollback to savepoint last_grant_inactive;

-- ===== (d) A cycle in org_units is rejected =====
-- le1 is branch2's parent, so re-parenting le1 under branch2 closes a two-node loop. The
-- id travels through a GUC because psql does not interpolate :variables inside dollar
-- quoting. (Looking le1 up by "oldest legal_entity" inside the block would be wrong here:
-- both entities share this transaction's now(), so that ordering ties on a random uuid.)
select set_config('p3.le1_id', :'unit_le1', true);
do $$
begin
  update org_units
     set parent_id = '16000000-0000-0000-0000-000000000003'
   where id = current_setting('p3.le1_id')::uuid;
  raise exception 'P3 org scope assertion failed: an org_units cycle was accepted';
exception
  when check_violation then null; -- org_units_cycle_detected, 23514
end
$$;

-- ===== (e) The assertions detect mutations =====
select pg_temp.p3_assert(
  (select count(*) from private.scope_enforcement_violations()) = 0,
  'the live schema must carry zero A1/A3/A5 violations before mutating');

savepoint mutation_a3;
drop policy scope_rider_invoices on invoices;
create policy scope_rider_invoices on invoices as restrictive for all to public using (true);
select pg_temp.p3_assert(
  exists (select 1 from private.scope_enforcement_violations()
          where assertion = 'A3' and detail like '%invoices%'),
  'A3 must catch a rider weakened to USING (true), not only a missing one');
rollback to savepoint mutation_a3;

savepoint mutation_a1;
create table public.p3_unregistered_table (id uuid primary key);
select pg_temp.p3_assert(
  exists (select 1 from private.scope_enforcement_violations()
          where assertion = 'A1' and detail like '%p3_unregistered_table%'),
  'A1 must catch a public table that no registry row classifies');
rollback to savepoint mutation_a1;

savepoint mutation_a5;
create function public.p3_rogue_definer() returns bigint
language sql stable security definer
as $function$
  -- Fake enforcement markers must not satisfy A5: auth_scopes().
  /* A block comment containing assert_unit_in_scope(null) is not enforcement either. */
  select count(*) from public.invoices
$function$;
select pg_temp.p3_assert(
  exists (select 1 from private.scope_enforcement_violations()
          where assertion = 'A5' and detail like '%p3_rogue_definer%'),
  'A5 must catch a scoped definer whose only enforcement markers are comments');
rollback to savepoint mutation_a5;

savepoint mutation_a5_string;
create function public.p3_rogue_definer_string() returns bigint
language sql stable security definer
as $function$
  select count(*) from public.invoices where 'auth_scopes()' is not null
$function$;
select pg_temp.p3_assert(
  exists (select 1 from private.scope_enforcement_violations()
          where assertion = 'A5' and detail like '%p3_rogue_definer_string%'),
  'A5 must not accept an enforcement marker inside a string literal');
rollback to savepoint mutation_a5_string;

savepoint mutation_a5_standard_string_backslash;
create function public.p3_rogue_definer_standard_string_backslash() returns bigint
language sql stable security definer
as $function$
  select count(*) from public.invoices where '\' is distinct from 'auth_scopes()'
$function$;
select pg_temp.p3_assert(
  exists (select 1 from private.scope_enforcement_violations()
          where assertion = 'A5' and detail like '%p3_rogue_definer_standard_string_backslash%'),
  'A5 must treat backslash as ordinary text in a standard-conforming string');
rollback to savepoint mutation_a5_standard_string_backslash;

savepoint mutation_a5_escape_string;
create function public.p3_rogue_definer_escape_string() returns bigint
language sql stable security definer
as $function$
  select count(*) from public.invoices where E'\'auth_scopes()' is not null
$function$;
select pg_temp.p3_assert(
  exists (select 1 from private.scope_enforcement_violations()
          where assertion = 'A5' and detail like '%p3_rogue_definer_escape_string%'),
  'A5 must keep an escaped quote inside an E string and reject its fake marker');
rollback to savepoint mutation_a5_escape_string;

savepoint mutation_a5_nested_comment;
create function public.p3_rogue_definer_nested_comment() returns bigint
language sql stable security definer
as $function$
  /* outer comment /* auth_scopes() */ assert_unit_in_scope(null) */
  select count(*) from public.invoices
$function$;
select pg_temp.p3_assert(
  exists (select 1 from private.scope_enforcement_violations()
          where assertion = 'A5' and detail like '%p3_rogue_definer_nested_comment%'),
  'A5 must remove a nested block comment before looking for enforcement calls');
rollback to savepoint mutation_a5_nested_comment;

savepoint mutation_a5_executable_noop;
create function public.p3_rogue_definer_executable_noop() returns bigint
language plpgsql stable security definer
as $function$
begin
  perform public.auth_scopes();
  return (select count(*) from public.invoices);
end
$function$;
select pg_temp.p3_assert(
  exists (select 1 from private.scope_enforcement_violations()
          where assertion = 'A5' and detail like '%p3_rogue_definer_executable_noop%'),
  'A5 must reject an executable scope call that has no reviewed enforcement registration');
rollback to savepoint mutation_a5_executable_noop;

-- ===== (f) The exemption latch =====
-- Tenant A holds two legal entities and two branches; the registry 0057 seeded is
-- non-empty, so the inline preflight logic must flag exactly tenant A.
select pg_temp.p3_assert(
  exists (
    select 1 from (
      select u.org_id
      from org_units u
      where exists (select 1 from private.scope_definer_exemptions)
      group by u.org_id, u.unit_type
      having count(*) > 1
    ) latch
    where latch.org_id = '15000000-0000-0000-0000-000000000001')
  and not exists (
    select 1 from (
      select u.org_id
      from org_units u
      where exists (select 1 from private.scope_definer_exemptions)
      group by u.org_id, u.unit_type
      having count(*) > 1
    ) latch
    where latch.org_id = '15000000-0000-0000-0000-000000000002'),
  'the latch must flag the multi-unit org while exemptions are open, and only that org');

savepoint latch_drain;
delete from private.scope_definer_exemptions;
select pg_temp.p3_assert(
  not exists (
    select 1
    from org_units u
    where exists (select 1 from private.scope_definer_exemptions)
    group by u.org_id, u.unit_type
    having count(*) > 1),
  'a drained exemption registry must silence the latch: sibling units become legitimate');
rollback to savepoint latch_drain;

-- ===== (g) Saved-view commands =====
select set_config('request.jwt.claim.sub', '25000000-0000-0000-0000-000000000001', true);
select save_saved_view(
  null, 'invoices', 'P3 private view', '{"columns":["number"]}'::jsonb,
  false, null, null)::text as id
\gset private_view_

-- Sharing without a reason is refused.
do $$
begin
  perform save_saved_view(
    null, 'invoices', 'P3 shared view', '{}'::jsonb, true, null, null);
  raise exception 'P3 org scope assertion failed: a shared save without a reason was accepted';
exception
  when sqlstate '22023' then null;
end
$$;

select save_saved_view(
  null, 'invoices', 'P3 shared view', '{"columns":["supplier"]}'::jsonb,
  true, null, 'P3: publish the tenant-wide layout')::text as id
\gset shared_view_
select set_config('p3.shared_view_id', :'shared_view_id', true);

-- Editing the shared view without a reason is refused, even for its owner.
do $$
begin
  perform save_saved_view(
    current_setting('p3.shared_view_id')::uuid, 'invoices', 'P3 shared view',
    '{}'::jsonb, true, null, null);
  raise exception 'P3 org scope assertion failed: editing a shared view without a reason was accepted';
exception
  when sqlstate '22023' then null;
end
$$;

-- Another user in the tenant reads the shared view but not the private one, and cannot
-- edit either.
select set_config('request.jwt.claim.sub', '25000000-0000-0000-0000-000000000004', true);
set local role authenticated;
select count(*)::text as visible from saved_views \gset office_views_
reset role;
select pg_temp.p3_assert(:'office_views_visible'::int = 1,
  'a teammate must see exactly the shared view -- never the owner''s private one');

do $$
begin
  perform save_saved_view(
    current_setting('p3.shared_view_id')::uuid, 'invoices', 'P3 hijack',
    '{}'::jsonb, true, null, 'P3: not my view');
  raise exception 'P3 org scope assertion failed: a non-owner edited a shared view';
exception
  when sqlstate '42501' then null;
end
$$;

-- A unit-pinned view demands the unit be inside the caller's scope.
select set_config('request.jwt.claim.sub', '25000000-0000-0000-0000-000000000002', true);
select save_saved_view(
  null, 'orders', 'P3 my branch', '{}'::jsonb, false,
  '16000000-0000-0000-0000-000000000003', null)::text as id
\gset branch_view_
select set_config('p3.branch1_id', :'unit_branch1', true);
do $$
begin
  perform save_saved_view(
    null, 'orders', 'P3 foreign branch', '{}'::jsonb, false,
    current_setting('p3.branch1_id')::uuid, null);
  raise exception 'P3 org scope assertion failed: a view was pinned to an out-of-scope unit';
exception
  when sqlstate '42501' then null;
end
$$;

-- The other tenant sees nothing, shared or not.
select set_config('request.jwt.claim.sub', '25000000-0000-0000-0000-000000000009', true);
set local role authenticated;
select count(*)::text as visible from saved_views \gset foreign_views_
reset role;
select pg_temp.p3_assert(:'foreign_views_visible'::int = 0,
  'tenant B must see zero saved views of tenant A');

-- Deleting the shared view demands a reason; with one it lands in the audit trail.
select set_config('request.jwt.claim.sub', '25000000-0000-0000-0000-000000000001', true);
do $$
begin
  perform delete_saved_view(current_setting('p3.shared_view_id')::uuid, null);
  raise exception 'P3 org scope assertion failed: deleting a shared view without a reason was accepted';
exception
  when sqlstate '22023' then null;
end
$$;
select delete_saved_view(:'shared_view_id'::uuid, 'P3: retire the shared layout');
select pg_temp.p3_assert(
  not exists (select 1 from saved_views where id = :'shared_view_id'::uuid)
  and exists (
    select 1 from audit_logs
    where action = 'saved_view_deleted'
      and entity_id = :'shared_view_id'::uuid
      and reason = 'P3: retire the shared layout'),
  'the shared-view delete must remove the row and write its reasoned audit entry');

rollback;

\echo 'p3_org_scope_passed'
