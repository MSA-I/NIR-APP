-- P49 -- Platform capabilities narrow operator authority, and the operator customer list is
-- neither readable by a tenant nor an oracle for who holds platform authority (0151).
\set ON_ERROR_STOP on

begin;

create function pg_temp.p49_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P49 platform capability assertion failed: %', p_message;
  end if;
end
$$;

-- The claims helper carries `amr` as well as `sub`: suspending the fixture organization goes
-- through set_organization_lifecycle (0134:149), which asserts a fresh password authentication
-- (0061:51). Writing `status = 'suspended'` directly is impossible on purpose -- the 0020 guard
-- forces every lifecycle change through that command, and the audit row it writes would itself
-- be refused by the 0092 read-only guard once the organization is already suspended.
create function pg_temp.p49_as(p_user uuid, p_fresh_password boolean default false)
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

-- ===== Structural claims, before any fixture =====
select pg_temp.p49_assert(
  not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename in ('platform_roles', 'platform_role_capabilities', 'platform_admin_roles')
      and cmd <> 'SELECT'
  ),
  'a write policy appeared on the platform role tables -- assignment must stay out-of-band');

select pg_temp.p49_assert(
  not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('platform_roles', 'platform_role_capabilities', 'platform_admin_roles')
      and grantee in ('anon', 'authenticated')
      and privilege_type <> 'SELECT'
  ),
  'a browser role holds DML on the platform role tables');

select pg_temp.p49_assert(
  not exists (
    select 1 from platform_admins roster
    where not exists (
      select 1 from platform_admin_roles assignment where assignment.user_id = roster.user_id)
  ),
  'a platform admin exists with no role -- 0151 backfill did not hold');

-- Every declared capability must be reachable through some role; the foreign key covers the
-- other direction. A definition nobody references is vocabulary that can never be granted.
select pg_temp.p49_assert(
  not exists (
    select 1 from private.platform_capability_definitions definition
    where not exists (
      select 1 from platform_role_capabilities granted
      where granted.capability = definition.capability)
  ),
  'a declared capability is referenced by no role at all');

-- ===== Fixture =====
-- A: an ordinary working customer.   B: suspended, memberless, never acted.
-- C: active and working, but with an open offboarding request.
insert into public.organizations (id, name, status, created_at) values
  ('49000000-0000-4000-8000-000000000001', 'P49 tenant A', 'active', now() - interval '30 days'),
  ('49000000-0000-4000-8000-000000000002', 'P49 tenant B', 'active', now() - interval '20 days'),
  ('49000000-0000-4000-8000-000000000003', 'P49 tenant C', 'active', now() - interval '10 days');

insert into auth.users (id, email) values
  ('59000000-0000-4000-8000-000000000001', 'owner-a-p49@example.test'),
  ('59000000-0000-4000-8000-000000000002', 'super-p49@example.test'),
  ('59000000-0000-4000-8000-000000000003', 'support-p49@example.test'),
  ('59000000-0000-4000-8000-000000000004', 'noroles-p49@example.test'),
  ('59000000-0000-4000-8000-000000000005', 'owner-c-p49@example.test');

-- Tenant B deliberately has no members, so the `no_users` filter has something true to find.
insert into public.profiles (id, org_id, full_name, role) values
  ('59000000-0000-4000-8000-000000000001', '49000000-0000-4000-8000-000000000001', 'P49 owner A', 'owner'),
  ('59000000-0000-4000-8000-000000000005', '49000000-0000-4000-8000-000000000003', 'P49 owner C', 'owner');

insert into public.platform_admins (user_id, note) values
  ('59000000-0000-4000-8000-000000000002', 'P49 super operator'),
  ('59000000-0000-4000-8000-000000000003', 'P49 support operator'),
  ('59000000-0000-4000-8000-000000000004', 'P49 operator with no role assigned');

insert into public.platform_admin_roles (user_id, role_key) values
  ('59000000-0000-4000-8000-000000000002', 'super_admin'),
  ('59000000-0000-4000-8000-000000000003', 'support');
-- ...000004 stays deliberately unassigned: membership without capability must read as nothing.

-- Creating the fixture organizations and profiles fired the ordinary audit triggers, which wrote
-- rows with a NULL actor (no JWT subject in a migration/seed context) stamped `now()`. Those are
-- artefacts of building the fixture, not customer activity, and leaving them in would mask the
-- very thing being measured. They are cleared rather than excluded in the function: a NULL actor
-- in production is a service_role write on the tenant's behalf -- an Edge Function interpreting a
-- document the customer uploaded -- which IS customer activity and must keep counting.
-- 0175 made raw audit history immutable. Clearing a fixture's own footprint is the authorized
-- purge that guard defines, declared transaction-locally and withdrawn on the next line, so every
-- later statement in this suite still meets the ordinary immutable ledger.
select set_config('app.audit_purge', 'organization_teardown', true);
delete from public.audit_logs where org_id in (
  '49000000-0000-4000-8000-000000000001',
  '49000000-0000-4000-8000-000000000002',
  '49000000-0000-4000-8000-000000000003');
select set_config('app.audit_purge', '', true);

-- Activity: tenant A acted a day ago, and an OPERATOR touched the same tenant just now. The list
-- must report the tenant's timestamp, never the console's own footprint. Tenant C acted an hour
-- ago. Tenant B has no audit rows at all -- which is what `dormant` means for a customer that
-- never did anything.
insert into public.audit_logs (org_id, user_id, action, entity_type, created_at) values
  ('49000000-0000-4000-8000-000000000001', '59000000-0000-4000-8000-000000000001',
   'update', 'invoices', now() - interval '1 day'),
  ('49000000-0000-4000-8000-000000000001', '59000000-0000-4000-8000-000000000002',
   'org_flag_configured', 'org_flag_configurations', now()),
  ('49000000-0000-4000-8000-000000000003', '59000000-0000-4000-8000-000000000005',
   'insert', 'purchase_orders', now() - interval '1 hour');

-- Through the real command rather than a hand-built row: the retention deadlines are coupled by
-- CHECK constraints (0103) and a fixture that guesses them proves nothing about the state an
-- actual offboarding produces.
select pg_temp.p49_as('59000000-0000-4000-8000-000000000005', true);
set local role authenticated;
select public.request_organization_offboarding('69000000-0000-4000-8000-000000000001');
reset role;

select pg_temp.p49_as('59000000-0000-4000-8000-000000000002', true);
set local role authenticated;
select public.set_organization_lifecycle(
  '49000000-0000-4000-8000-000000000002', 'suspended', null, 'P49 fixture: suspended customer');
reset role;

-- ===== A tenant user sees none of it =====
select pg_temp.p49_as('59000000-0000-4000-8000-000000000001');
set local role authenticated;

select pg_temp.p49_assert(
  (select count(*) from public.platform_customers(p_search => 'P49')) = 0,
  'a tenant owner read the operator customer list');
select pg_temp.p49_assert(
  not public.platform_has_capability('customer.view'),
  'a tenant owner holds a platform capability');
select pg_temp.p49_assert(
  cardinality(public.platform_my_capabilities()) = 0,
  'a tenant owner was handed a capability set');
select pg_temp.p49_assert(
  (select count(*) from public.platform_roles) = 0
  and (select count(*) from public.platform_role_capabilities) = 0
  and (select count(*) from public.platform_admin_roles) = 0,
  'a tenant owner read the platform role tables through RLS');

do $$
begin
  insert into public.platform_admin_roles (user_id, role_key)
  values ('59000000-0000-4000-8000-000000000001', 'super_admin');
  raise exception 'expected tenant self-grant of a platform role to be rejected';
exception when insufficient_privilege then null;
end
$$;

reset role;

-- ===== An operator who is a member but holds no role reads nothing =====
select pg_temp.p49_as('59000000-0000-4000-8000-000000000004');
set local role authenticated;

select pg_temp.p49_assert(
  public.is_platform_admin(),
  'the role-less fixture operator is not in platform_admins -- the fixture is wrong');
select pg_temp.p49_assert(
  cardinality(public.platform_my_capabilities()) = 0,
  'an operator with no role assignment was handed capabilities');
select pg_temp.p49_assert(
  (select count(*) from public.platform_customers(p_search => 'P49')) = 0,
  'an operator without customer.view read the customer list');

reset role;

-- ===== A narrowed operator: support may look, but holds no money capability =====
select pg_temp.p49_as('59000000-0000-4000-8000-000000000003');
set local role authenticated;

select pg_temp.p49_assert(
  public.platform_has_capability('customer.view'),
  'the support role lost customer.view');
select pg_temp.p49_assert(
  not public.platform_has_capability('subscription.edit')
  and not public.platform_has_capability('entitlement.override')
  and not public.platform_has_capability('org.lifecycle'),
  'the support role holds a high-impact capability it was never granted');
select pg_temp.p49_assert(
  (select count(*) from public.platform_customers(p_search => 'P49')) = 3,
  'a narrowed operator with customer.view could not read the customer list');

reset role;

-- ===== The full operator: the list answers what it claims to answer =====
select pg_temp.p49_as('59000000-0000-4000-8000-000000000002');
set local role authenticated;

-- Read through the operator's own RLS view of the bundle, not through private: `authenticated`
-- has no USAGE on the private schema, and a suite that reaches around the boundary it is
-- testing proves the wrong thing.
select pg_temp.p49_assert(
  (select array_length(public.platform_my_capabilities(), 1))
    = (select count(*) from public.platform_role_capabilities where role_key = 'super_admin'),
  'super_admin does not resolve to every capability its bundle grants');
select pg_temp.p49_assert(
  public.platform_has_capability('subscription.edit')
  and public.platform_has_capability('org.lifecycle'),
  'super_admin lost a high-impact capability');

select pg_temp.p49_assert(
  (select last_activity_at from public.platform_customers(p_search => 'P49 tenant A'))
    < now() - interval '1 hour',
  'last activity counted the operator''s own audit row as customer engagement');

select pg_temp.p49_assert(
  (select last_activity_at from public.platform_customers(p_search => 'P49 tenant B')) is null,
  'a customer that never acted reported an activity timestamp instead of nothing');

select pg_temp.p49_assert(
  (select active_user_count from public.platform_customers(p_search => 'P49 tenant A')) = 1
  and (select active_user_count from public.platform_customers(p_search => 'P49 tenant B')) = 0,
  'the active member count is wrong');

select pg_temp.p49_assert(
  (select status from public.platform_customers(p_search => 'P49 tenant B')) = 'suspended',
  'the suspended fixture customer did not read back as suspended');

-- total_count is the FILTERED count before paging: one row comes back, but the caller still
-- learns there are three, which is what a pager needs.
select pg_temp.p49_assert(
  (select count(*) from public.platform_customers(p_search => 'P49', p_limit => 1)) = 1
  and (select total_count from public.platform_customers(p_search => 'P49', p_limit => 1)) = 3,
  'total_count did not survive paging');

-- Ordering is created_at desc, so page one is the newest customer and page three the oldest.
select pg_temp.p49_assert(
  (select name from public.platform_customers(p_search => 'P49', p_limit => 1, p_offset => 0))
    = 'P49 tenant C'
  and (select name from public.platform_customers(p_search => 'P49', p_limit => 1, p_offset => 2))
    = 'P49 tenant A',
  'paging returned the wrong slice or the wrong order');

select pg_temp.p49_assert(
  (select name from public.platform_customers(p_search => 'P49', p_status => array['suspended']))
    = 'P49 tenant B',
  'the status filter did not narrow to the suspended customer');
select pg_temp.p49_assert(
  (select name from public.platform_customers(p_search => 'P49', p_attention => 'no_users'))
    = 'P49 tenant B',
  'the no_users attention filter did not find the memberless customer');
select pg_temp.p49_assert(
  (select name from public.platform_customers(p_search => 'P49', p_attention => 'offboarding'))
    = 'P49 tenant C',
  'the offboarding attention filter did not find the open request');
select pg_temp.p49_assert(
  (select name from public.platform_customers(p_search => 'P49', p_attention => 'dormant'))
    = 'P49 tenant B',
  'the dormant attention filter did not find the customer that never acted');

-- An unrecognised filter must fail loudly. Silently returning nothing would turn a typo in a
-- query string into "this customer base is empty".
do $$
begin
  perform public.platform_customers(p_search => 'P49', p_attention => 'nonsense');
  raise exception 'expected an unknown attention filter to be rejected';
exception when invalid_parameter_value then null;
end
$$;
do $$
begin
  perform public.platform_customers(p_search => 'P49', p_status => array['deleted']);
  raise exception 'expected an unknown status filter to be rejected';
exception when invalid_parameter_value then null;
end
$$;

reset role;
rollback;

\echo 'p49_platform_capabilities_passed'
