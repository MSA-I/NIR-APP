-- P79 -- Cross-tenant user administration and the operator roster's write path (0214).
--
-- The two axes this suite keeps apart, because the whole file exists to prove they stay apart:
--   (a) a TENANT user, changed from outside their tenant under `user.access`;
--   (b) a PLATFORM operator, whose authority is changed under `operator.manage`.
-- Reading one does not grant the other, and neither read is an oracle for who holds authority.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p79_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P79 user administration assertion failed: %', p_message;
  end if;
end
$$;

-- Same claims helper as P49 (0151 suite): `amr` carries a password timestamp when the command
-- under test is a step-up one, and every command in section 5 and 6 of 0214 is.
create function pg_temp.p79_as(p_user uuid, p_fresh_password boolean default false)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    case when p_user is null then '{}'::jsonb else jsonb_build_object(
      'sub', p_user,
      'amr', case when p_fresh_password then jsonb_build_array(jsonb_build_object(
        'method', 'password', 'timestamp', extract(epoch from clock_timestamp())
      )) else '[]'::jsonb end
    ) end::text,
    true
  );
end
$$;

create function pg_temp.p79_refused(p_sql text, p_expected text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm not like '%' || p_expected || '%' then
      raise exception 'P79 expected refusal %, got: %', p_expected, sqlerrm;
    end if;
    return;
  end;
  raise exception 'P79 expected refusal % but the statement succeeded: %', p_expected, p_sql;
end
$$;

-- ===== 1. Structural claims, before any fixture =====
-- The 0214 write path is definer-only. If a policy or a DML grant ever appears on the roster
-- tables, the narrow door has been replaced by a wide one and P49's premise is gone with it.
select pg_temp.p79_assert(
  not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename in ('platform_admins', 'platform_admin_roles', 'platform_admin_events')
      and cmd <> 'SELECT'),
  'a write policy appeared on the operator roster -- 0214 grants authority through commands only');

select pg_temp.p79_assert(
  not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'platform_admin_events'
      and grantee in ('anon', 'authenticated')),
  'a browser role holds a grant on platform_admin_events');

-- operator.manage is the capability that can create more authority. One role holds it.
select pg_temp.p79_assert(
  (select array_agg(role_key order by role_key) from platform_role_capabilities
    where capability = 'operator.manage') = array['super_admin'],
  'operator.manage is held by a role other than super_admin');

select pg_temp.p79_assert(
  exists (select 1 from private.platform_capability_definitions
           where capability = 'user.access' and requires_step_up and sensitivity = 'high'),
  'user.access is not declared as a step-up capability of high sensitivity');

-- The absence that is a decision, not an omission (owner, 28.08.2026).
select pg_temp.p79_assert(
  not exists (select 1 from private.platform_capability_definitions
               where capability like '%impersonat%'),
  'an impersonation capability appeared -- it is deferred debt, not shipped');

-- ===== 2. Fixture =====
-- Existing operators are cleared inside this transaction so "the last super admin" is a
-- deterministic fact rather than an accident of whatever the machine happens to hold. The
-- rollback at the end puts them back.
delete from platform_admins;

insert into public.organizations (id, name, status, created_at) values
  ('79000000-0000-4000-8000-000000000001', 'P79 tenant A', 'active', now() - interval '40 days'),
  ('79000000-0000-4000-8000-000000000002', 'P79 tenant B', 'active', now() - interval '20 days');

insert into auth.users (id, email) values
  ('79100000-0000-4000-8000-000000000001', 'owner-a-p79@example.test'),
  ('79100000-0000-4000-8000-000000000002', 'office-a-p79@example.test'),
  ('79100000-0000-4000-8000-000000000003', 'owner-b-p79@example.test'),
  ('79100000-0000-4000-8000-000000000004', 'super-p79@example.test'),
  ('79100000-0000-4000-8000-000000000005', 'support-p79@example.test'),
  ('79100000-0000-4000-8000-000000000006', 'second-super-p79@example.test'),
  ('79100000-0000-4000-8000-000000000007', 'not-an-operator-p79@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('79100000-0000-4000-8000-000000000001', '79000000-0000-4000-8000-000000000001', 'P79 owner A',   'owner'),
  ('79100000-0000-4000-8000-000000000002', '79000000-0000-4000-8000-000000000001', 'P79 manager A', 'office'),
  ('79100000-0000-4000-8000-000000000003', '79000000-0000-4000-8000-000000000002', 'P79 owner B',   'owner');

insert into public.platform_admins (user_id, note) values
  ('79100000-0000-4000-8000-000000000004', 'P79 super operator'),
  ('79100000-0000-4000-8000-000000000005', 'P79 support operator');
insert into public.platform_admin_roles (user_id, role_key) values
  ('79100000-0000-4000-8000-000000000004', 'super_admin'),
  ('79100000-0000-4000-8000-000000000005', 'support');

-- ===== 3. The read door (G2) =====
select pg_temp.p79_as('79100000-0000-4000-8000-000000000004');
select pg_temp.p79_assert(
  (select count(*) from public.platform_users(p_org_id => '79000000-0000-4000-8000-000000000001')) = 2,
  'an operator with user.view cannot read the tenant user directory');

select pg_temp.p79_assert(
  (select total_count from public.platform_users(
     p_org_id => '79000000-0000-4000-8000-000000000001') limit 1) = 2,
  'total_count does not report the filtered count before paging');

select pg_temp.p79_assert(
  (select count(*) from public.platform_users(p_search => 'office-a-p79')) = 1,
  'search does not match on the email address, which is the only handle support has');

select pg_temp.p79_assert(
  (select count(*) from public.platform_users(p_status => 'never_signed_in')) >= 3,
  'the never-signed-in filter does not find fixture users who have never signed in');

select pg_temp.p79_assert(
  (select org_owner_count from public.platform_user_detail(
     '79100000-0000-4000-8000-000000000001')) = 1,
  'the detail read does not report how many active owners the organization has');

-- A tenant owner is not an operator. Zero rows, not an error: the read must not be an oracle.
select pg_temp.p79_as('79100000-0000-4000-8000-000000000001');
select pg_temp.p79_assert(
  (select count(*) from public.platform_users()) = 0,
  'a tenant owner read the cross-tenant user directory');
select pg_temp.p79_assert(
  (select count(*) from public.platform_user_overview()) = 0,
  'a tenant owner read the platform overview');

select pg_temp.p79_as(null);
select pg_temp.p79_assert(
  (select count(*) from public.platform_users()) = 0,
  'an anonymous caller read the cross-tenant user directory');

-- ===== 4. Changing a tenant user's access (G3) =====
-- Support holds user.view and not user.access: it can see the person and cannot change them.
select pg_temp.p79_as('79100000-0000-4000-8000-000000000005', true);
select pg_temp.p79_assert(
  (select count(*) from public.platform_users(p_search => 'p79@example.test')) = 3,
  'support cannot read the directory it is supposed to answer questions from');
select pg_temp.p79_refused(
  $$select public.platform_set_user_access(
      '79100000-0000-4000-8000-000000000002', 'accountant', true, 'P79 support attempt')$$,
  'not_platform_capability');

-- The step-up is not decorative: the same operator, same capability, stale authentication.
select pg_temp.p79_as('79100000-0000-4000-8000-000000000004', false);
select pg_temp.p79_refused(
  $$select public.platform_set_user_access(
      '79100000-0000-4000-8000-000000000002', 'accountant', true, 'P79 stale authentication')$$,
  'fresh_authentication_required');

select pg_temp.p79_as('79100000-0000-4000-8000-000000000004', true);
select pg_temp.p79_refused(
  $$select public.platform_set_user_access(
      '79100000-0000-4000-8000-000000000002', 'accountant', true, '   ')$$,
  'reason_required');

-- An organization with no active owner is a customer nobody can administer.
select pg_temp.p79_refused(
  $$select public.platform_set_user_access(
      '79100000-0000-4000-8000-000000000003', 'office', true, 'P79 demote the only owner')$$,
  'last_owner_required');
select pg_temp.p79_refused(
  $$select public.platform_set_user_access(
      '79100000-0000-4000-8000-000000000003', 'owner', false, 'P79 suspend the only owner')$$,
  'last_owner_required');

-- A retired persona cannot be revived from outside the tenant either (0127, 0133).
select pg_temp.p79_refused(
  $$select public.platform_set_user_access(
      '79100000-0000-4000-8000-000000000002', 'kitchen', true, 'P79 revive a retired persona')$$,
  'account_role_retired');

-- The supplier role is a decision inside the customer's catalogue, in either direction.
select pg_temp.p79_refused(
  $$select public.platform_set_user_access(
      '79100000-0000-4000-8000-000000000002', 'supplier', false, 'P79 make a supplier')$$,
  'supplier_role_change_out_of_scope');

-- The success path, and the two logs it owes.
select public.platform_set_user_access(
  '79100000-0000-4000-8000-000000000002', 'accountant', false, 'P79 suspended at the customer''s request');

select pg_temp.p79_assert(
  (select role = 'accountant' and not active from profiles
    where id = '79100000-0000-4000-8000-000000000002'),
  'the tenant user was not actually changed');

select pg_temp.p79_assert(
  exists (select 1 from audit_logs
           where entity_id = '79100000-0000-4000-8000-000000000002'
             and action = 'profile_access_changed_by_platform'
             and org_id = '79000000-0000-4000-8000-000000000001'
             and reason like 'P79 suspended%'),
  'the change was not written to the tenant''s own audit trail');

select pg_temp.p79_assert(
  exists (select 1 from platform_lifecycle_events
           where entity_id = '79100000-0000-4000-8000-000000000002'
             and action = 'user_access_set'),
  'the change was not written to the platform timeline the console reads back');

select pg_temp.p79_assert(
  (select count(*) from public.platform_user_events('79100000-0000-4000-8000-000000000002')) = 1,
  'the console cannot read back what it just did to a user');

-- Idempotence is reported, not re-written: a no-op must not manufacture a second audit row.
select public.platform_set_user_access(
  '79100000-0000-4000-8000-000000000002', 'accountant', false, 'P79 repeat');
select pg_temp.p79_assert(
  (select count(*) from platform_lifecycle_events
    where entity_id = '79100000-0000-4000-8000-000000000002' and action = 'user_access_set') = 1,
  'a no-op change wrote a second event');

-- The 0020 guard still refuses a direct write. The platform handshake is transaction-local and
-- belongs to the command, not to the operator's session.
select pg_temp.p79_refused(
  $$update profiles set active = true where id = '79100000-0000-4000-8000-000000000002'$$,
  'profile_access_rpc_required');

-- ===== 5. The operator roster (G4) =====
-- Support may not touch authority at all.
select pg_temp.p79_as('79100000-0000-4000-8000-000000000005', true);
select pg_temp.p79_refused(
  $$select public.platform_add_operator(
      'not-an-operator-p79@example.test', 'P79', 'support', 'P79 support attempt')$$,
  'not_platform_capability');

select pg_temp.p79_as('79100000-0000-4000-8000-000000000004', true);

-- You may never change your own authority. This is the escalation path a write door opens.
select pg_temp.p79_refused(
  $$select public.platform_set_operator_roles(
      '79100000-0000-4000-8000-000000000004', array['super_admin'], 'P79 self')$$,
  'self_authority_change_forbidden');
select pg_temp.p79_refused(
  $$select public.platform_remove_operator(
      '79100000-0000-4000-8000-000000000004', 'P79 self')$$,
  'self_authority_change_forbidden');

-- An identity that does not exist cannot be granted authority: this command grants, it does not
-- create accounts.
select pg_temp.p79_refused(
  $$select public.platform_add_operator(
      'nobody-p79@example.test', 'P79', 'support', 'P79 unknown account')$$,
  'operator_account_unknown');

select public.platform_add_operator(
  'not-an-operator-p79@example.test', 'P79 new operator', 'support', 'P79 onboarding a colleague');
select pg_temp.p79_assert(
  exists (select 1 from platform_admin_roles
           where user_id = '79100000-0000-4000-8000-000000000007' and role_key = 'support'),
  'the new operator did not receive the role they were granted');
select pg_temp.p79_assert(
  exists (select 1 from platform_admin_events
           where subject = '79100000-0000-4000-8000-000000000007' and action = 'operator_added'),
  'adding an operator was not recorded');

select pg_temp.p79_refused(
  $$select public.platform_add_operator(
      'not-an-operator-p79@example.test', 'P79', 'support', 'P79 twice')$$,
  'operator_already_exists');

-- An operator with no role holds no capability. Say so, rather than storing a roster row that
-- can see nothing.
select pg_temp.p79_refused(
  $$select public.platform_set_operator_roles(
      '79100000-0000-4000-8000-000000000007', array[]::text[], 'P79 empty')$$,
  'operator_requires_role');
select pg_temp.p79_refused(
  $$select public.platform_set_operator_roles(
      '79100000-0000-4000-8000-000000000007', array['no_such_role'], 'P79 unknown role')$$,
  'platform_role_unknown');

select public.platform_set_operator_roles(
  '79100000-0000-4000-8000-000000000007', array['billing', 'analyst'], 'P79 moved to billing');
select pg_temp.p79_assert(
  (select array_agg(role_key order by role_key) from platform_admin_roles
    where user_id = '79100000-0000-4000-8000-000000000007') = array['analyst', 'billing'],
  'setting roles did not replace the previous set');

-- The lockout guard. With one super admin left, neither demotion nor removal may proceed --
-- and both become possible again the moment a second one exists.
select pg_temp.p79_as('79100000-0000-4000-8000-000000000007', true);
select pg_temp.p79_refused(
  $$select public.platform_set_operator_roles(
      '79100000-0000-4000-8000-000000000004', array['support'], 'P79 demote the last super admin')$$,
  'not_platform_capability');

select pg_temp.p79_as('79100000-0000-4000-8000-000000000004', true);
select public.platform_add_operator(
  'second-super-p79@example.test', 'P79 second super', 'super_admin', 'P79 succession');

select pg_temp.p79_as('79100000-0000-4000-8000-000000000006', true);
select public.platform_set_operator_roles(
  '79100000-0000-4000-8000-000000000004', array['customer_ops'], 'P79 handover');
select pg_temp.p79_assert(
  (select array_agg(role_key) from platform_admin_roles
    where user_id = '79100000-0000-4000-8000-000000000004') = array['customer_ops'],
  'the demotion did not take once a second super admin existed');

-- The demotion is real, and the demoted operator loses the door behind them: 000004 held
-- operator.manage one statement ago and holds nothing of the kind now.
select pg_temp.p79_as('79100000-0000-4000-8000-000000000004', true);
select pg_temp.p79_refused(
  $$select public.platform_remove_operator(
      '79100000-0000-4000-8000-000000000006', 'P79 after demotion')$$,
  'not_platform_capability');

-- 000006 is now the only super_admin. It cannot remove itself, which is what actually keeps the
-- last one in place -- `last_super_admin_required` below it is the second lock on the same door,
-- unreachable while the self rule holds and deliberately kept for the day it is relaxed.
select pg_temp.p79_as('79100000-0000-4000-8000-000000000006', true);
select pg_temp.p79_refused(
  $$select public.platform_remove_operator(
      '79100000-0000-4000-8000-000000000006', 'P79 remove myself')$$,
  'self_authority_change_forbidden');

select public.platform_remove_operator(
  '79100000-0000-4000-8000-000000000007', 'P79 colleague left');

select pg_temp.p79_assert(
  (select count(*) from platform_admin_roles where role_key = 'super_admin') >= 1,
  'the roster ended with no super admin -- the platform locked itself out');
select pg_temp.p79_assert(
  not exists (select 1 from platform_admins where user_id = '79100000-0000-4000-8000-000000000007'),
  'removing an operator left the roster row behind');
select pg_temp.p79_assert(
  not exists (select 1 from platform_admin_roles where user_id = '79100000-0000-4000-8000-000000000007'),
  'removing an operator left their roles behind -- the cascade did not hold');

-- ===== 6. The history is a record, not a draft =====
select pg_temp.p79_assert(
  (select count(*) from public.platform_operator_events()) >= 5,
  'the operator history does not read back the changes just made');

select pg_temp.p79_refused(
  $$update platform_admin_events set reason = 'rewritten'$$,
  'platform_admin_event_immutable');
select pg_temp.p79_refused(
  $$delete from platform_admin_events$$,
  'platform_admin_event_immutable');

-- ===== 7. The overview answers the console's first question =====
select pg_temp.p79_assert(
  (select users_suspended from public.platform_user_overview()) >= 1,
  'the overview does not count the user this suite just suspended');
select pg_temp.p79_assert(
  (select operators_without_role from public.platform_user_overview()) = 0,
  'an operator was left holding membership without any role');

rollback;
