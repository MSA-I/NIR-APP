-- P80 -- the plan gate refuses on the server, not only in the menu.
--
-- `#274` fixes the order this suite exists to prove was actually followed: "סדר מימוש מחייב:
-- שרת לפני מסך … מסך שמסתיר בזמן שהשרת מרשה אינו נעילה." `src/lib/entitlements.ts` hides three
-- destinations from the navigation, and a hidden link over an open route is a claim the address
-- bar disproves in one keystroke. So every assertion below is written from the position of a
-- customer who did NOT use the menu: they are signed in, they hold the right ROLE, the row is
-- there — and the only thing standing between them and it is the plan.
--
-- The direction of the last two assertions is as important as the first four. An unmeasured
-- entitlement must NOT refuse, and a live override must reopen: `measured = false` in 0154 means
-- "we cannot state what this customer is entitled to", which is a gap in OUR configuration, and
-- turning that into a refusal makes a missing row indistinguishable from a broken product.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p84_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P80 plan-capability assertion failed: %', p_message;
  end if;
end
$$;

/** Runs one statement as the given member and reports the SQLSTATE/message, or 'ok'.
 *
 * IT ALSO CLAIMS THE FINANCIAL-WRITER SEAT, AND THAT IS NOT INCIDENTAL. Two BEFORE-row triggers
 * sit on these tables, and PostgreSQL fires them in NAME order:
 *
 *     p1_bank_imports_guard            (0023) — every P1 financial write must come through its RPC
 *     zz_plan_capability_bank_imports  (0252) — the plan must include the capability
 *
 * `p1_` sorts before `zz_`, so without `app.p1_financial_writer` the first guard refuses with
 * `financial_command_rpc_required` and the plan guard is never reached at all. The suite would
 * then report "a write on free must be refused by name" as a failure while the write was in fact
 * refused — by the wrong guard, for the wrong reason.
 *
 * Setting it here is what an RPC does on the caller's behalf (0023 sets exactly this before each
 * financial command), so this reproduces the shape of a real command and leaves the PLAN guard as
 * the thing under test. It is transaction-local and cleared on both exits, so no statement outside
 * an attempt is silently authorised.
 */
create function pg_temp.p84_attempt(p_actor uuid, p_role text, p_sql text)
returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_actor::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('app.p1_financial_writer', p_actor::text, true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql;
    execute 'set local role postgres';
    perform set_config('app.p1_financial_writer', '', true);
    return 'ok';
  exception when others then
    execute 'set local role postgres';
    perform set_config('app.p1_financial_writer', '', true);
    return sqlerrm;
  end;
end
$$;

-- ===== Fixture: three tenants that differ ONLY in what their plan includes =====
insert into public.organizations (id, name, status) values
  ('7b790000-0000-4000-8000-000000000001', 'P80 free tenant', 'active'),
  ('7b790000-0000-4000-8000-000000000002', 'P80 pro tenant', 'active'),
  ('7b790000-0000-4000-8000-000000000003', 'P80 unmeasured tenant', 'active');

insert into auth.users (id, email) values
  ('7b790000-0000-4000-8000-000000000011', 'owner-free-p79@example.test'),
  ('7b790000-0000-4000-8000-000000000012', 'owner-pro-p79@example.test'),
  ('7b790000-0000-4000-8000-000000000013', 'owner-unmeasured-p79@example.test');

-- OWNER in all three. The role is held constant on purpose: if an assertion below fails, it can
-- only be the plan, never a permission the tenant never had.
insert into public.profiles (id, org_id, full_name, role) values
  ('7b790000-0000-4000-8000-000000000011', '7b790000-0000-4000-8000-000000000001', 'P80 free owner', 'owner'),
  ('7b790000-0000-4000-8000-000000000012', '7b790000-0000-4000-8000-000000000002', 'P80 pro owner', 'owner'),
  ('7b790000-0000-4000-8000-000000000013', '7b790000-0000-4000-8000-000000000003', 'P80 unmeasured owner', 'owner');

-- The birth trigger (0210) puts a new organisation on a granted rung inside the pre-launch window,
-- so each tenant is moved to the plan this suite is actually about.
update public.organization_subscriptions
   set plan_key = 'free', granted_until = null
 where org_id = '7b790000-0000-4000-8000-000000000001';
update public.organization_subscriptions
   set plan_key = 'pro', granted_until = null
 where org_id = '7b790000-0000-4000-8000-000000000002';
delete from public.organization_subscriptions
 where org_id = '7b790000-0000-4000-8000-000000000003';

-- One identical bank import and transaction per tenant, written with no JWT in scope so the write
-- guard passes exactly as a migration or an operator command does.
insert into public.bank_imports (id, org_id, filename, file_hash, column_mapping) values
  ('7b790000-0000-4000-8000-000000000021', '7b790000-0000-4000-8000-000000000001', 'p79.xlsx', 'p79-free', '{}'),
  ('7b790000-0000-4000-8000-000000000022', '7b790000-0000-4000-8000-000000000002', 'p79.xlsx', 'p79-pro', '{}'),
  ('7b790000-0000-4000-8000-000000000023', '7b790000-0000-4000-8000-000000000003', 'p79.xlsx', 'p79-unmeasured', '{}');

insert into public.bank_transactions
  (id, org_id, import_id, tx_date, description, amount, raw, row_hash) values
  ('7b790000-0000-4000-8000-000000000031', '7b790000-0000-4000-8000-000000000001',
   '7b790000-0000-4000-8000-000000000021', date '2026-08-01', 'P80 free row', 100, '{}', 'p79-free-row'),
  ('7b790000-0000-4000-8000-000000000032', '7b790000-0000-4000-8000-000000000002',
   '7b790000-0000-4000-8000-000000000022', date '2026-08-01', 'P80 pro row', 100, '{}', 'p79-pro-row'),
  ('7b790000-0000-4000-8000-000000000033', '7b790000-0000-4000-8000-000000000003',
   '7b790000-0000-4000-8000-000000000023', date '2026-08-01', 'P80 unmeasured row', 100, '{}', 'p79-unmeasured-row');

-- ===== 1. The plan decides what an owner can READ =====
select set_config('request.jwt.claim.sub', '7b790000-0000-4000-8000-000000000011', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select pg_temp.p84_assert(
  (select count(*) = 0 from public.bank_transactions),
  'an owner on free must not read a bank transaction their own tenant holds');
select pg_temp.p84_assert(
  (select count(*) = 0 from public.bank_imports),
  'an owner on free must not read a bank import their own tenant holds');

set local role postgres;
select set_config('request.jwt.claim.sub', '7b790000-0000-4000-8000-000000000012', true);
set local role authenticated;

select pg_temp.p84_assert(
  (select count(*) = 1 from public.bank_transactions),
  'an owner on pro must read exactly their own tenant''s bank transaction');

-- ===== 2. An unmeasured plan is NOT a refusal =====
-- The tenant with no subscription row at all. This is the assertion that keeps a configuration
-- gap on our side from reading, to the customer, as a product that broke.
set local role postgres;
select set_config('request.jwt.claim.sub', '7b790000-0000-4000-8000-000000000013', true);
set local role authenticated;

select pg_temp.p84_assert(
  (select count(*) = 1 from public.bank_transactions),
  'a tenant whose plan states nothing must not be refused -- unmeasured is our gap, not zero');

set local role postgres;

-- ===== 3. The plan decides what an owner can WRITE =====
-- Run as `postgres` with the tenant's JWT in scope: that is the shape of every SECURITY DEFINER
-- command that writes these tables, so this measures the guard rather than the RLS policy.
select pg_temp.p84_assert(
  pg_temp.p84_attempt('7b790000-0000-4000-8000-000000000011', 'postgres',
    $sql$insert into public.bank_imports (org_id, filename, file_hash, column_mapping)
         values ('7b790000-0000-4000-8000-000000000001', 'blocked.xlsx', 'p79-blocked', '{}')$sql$)
  like '%capability_not_in_plan%',
  'a write on free must be refused by name, not silently dropped');

select pg_temp.p84_assert(
  pg_temp.p84_attempt('7b790000-0000-4000-8000-000000000012', 'postgres',
    $sql$insert into public.bank_imports (org_id, filename, file_hash, column_mapping)
         values ('7b790000-0000-4000-8000-000000000002', 'allowed.xlsx', 'p79-allowed', '{}')$sql$)
  = 'ok',
  'the same write on pro must succeed');

-- ===== 4. A live override reopens it, which is the operator escape hatch =====
-- Without this, a concession an operator granted with a reason would be silently overruled by the
-- plan, and 0154's whole override table would be decoration.
insert into public.organization_entitlement_overrides
  (org_id, entitlement_key, kind, boolean_value, reason, granted_by)
values ('7b790000-0000-4000-8000-000000000001', 'bank.reconciliation', 'boolean', true,
        'P80 operator concession', '7b790000-0000-4000-8000-000000000011');

select set_config('request.jwt.claim.sub', '7b790000-0000-4000-8000-000000000011', true);
set local role authenticated;
select pg_temp.p84_assert(
  (select count(*) = 1 from public.bank_transactions),
  'a live override must outrank the plan and reopen the capability');
set local role postgres;

-- An EXPIRED override resolves exactly like no override at all -- the same property 0211 proves
-- for autonomy, asserted here for entitlements.
update public.organization_entitlement_overrides
   set expires_at = now() - interval '1 second'
 where org_id = '7b790000-0000-4000-8000-000000000001';

select set_config('request.jwt.claim.sub', '7b790000-0000-4000-8000-000000000011', true);
set local role authenticated;
select pg_temp.p84_assert(
  (select count(*) = 0 from public.bank_transactions),
  'an expired override must resolve like no override, not like a live one');
set local role postgres;

-- ===== 5. users.max: an outstanding invitation is a seat already spent =====
-- The free tenant holds one seat and one active member, so it is already full. If the guard
-- counted only accepted members, a plan of one could be handed out five times in a minute.
select pg_temp.p84_assert(
  (select numeric_limit = 1 from public.plan_entitlements
    where plan_key = 'free' and entitlement_key = 'users.max'),
  'the free plan must state exactly one member seat');

select pg_temp.p84_assert(
  pg_temp.p84_attempt('7b790000-0000-4000-8000-000000000011', 'postgres',
    $sql$select public.create_invitation('second-p79@example.test', 'office')$sql$)
  like '%user_seats_exhausted%',
  'an invitation past the plan''s seats must be refused by name');

-- The pro tenant has fifteen seats and one member, so the same statement must go through. Same
-- role, same command, same second: only the plan differs.
select pg_temp.p84_assert(
  pg_temp.p84_attempt('7b790000-0000-4000-8000-000000000012', 'postgres',
    $sql$select public.create_invitation('colleague-p79@example.test', 'office')$sql$)
  = 'ok',
  'an invitation inside the plan''s seats must succeed');

-- And now that pro has one member plus one OUTSTANDING invitation, the count must include it.
select pg_temp.p84_assert(
  (select count(*) = 1 from public.invitations
    where org_id = '7b790000-0000-4000-8000-000000000002'
      and accepted_at is null and revoked_at is null),
  'the invitation the previous assertion created must be outstanding for the count to be real');

-- ===== 6. The ladder itself, read back rather than assumed =====
select pg_temp.p84_assert(
  (select bool_and(entitlement.boolean_value is false)
     from public.plan_entitlements entitlement
    where entitlement.kind = 'boolean'
      and entitlement.plan_key in ('free', 'basic')
      and entitlement.entitlement_key
          in ('reports.advanced', 'bank.reconciliation', 'exports.custom')),
  'free and basic must not include the three capabilities #277 moved to pro');

select pg_temp.p84_assert(
  (select bool_and(entitlement.boolean_value is true)
     from public.plan_entitlements entitlement
    where entitlement.kind = 'boolean'
      and entitlement.plan_key in ('pro', 'premium', 'business', 'legacy')
      and entitlement.entitlement_key
          in ('reports.advanced', 'bank.reconciliation', 'exports.custom')),
  'pro and every rung above it must include all three');

-- Every capability that is off for a plan names the decision that turned it off (#274's brake).
select pg_temp.p84_assert(
  (select count(*) = 0
     from public.plan_entitlements entitlement
    where entitlement.kind = 'boolean' and entitlement.boolean_value = false
      and not exists (select 1 from private.plan_capability_decisions decision
                      where decision.plan_key = entitlement.plan_key
                        and decision.entitlement_key = entitlement.entitlement_key)),
  'a capability may not be off for a plan without a decision row saying who decided it');

rollback;
