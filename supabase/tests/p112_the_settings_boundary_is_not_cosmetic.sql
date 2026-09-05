-- P112 -- The /settings boundary is enforced by the database, not by the router.
--
-- PERM-01. `App.tsx` wraps the route in `<Guard roles={['owner']}>`, which decides what is
-- PAINTED. PostgREST has never heard of it. Measured against production on 05.09.2026, one read
-- per role on the guarded path, all three roles received all four surfaces in full: six colleague
-- rows with five telephone numbers, the whole organizations row, three feature-flag configuration
-- rows and four autonomy-policy rows -- identical for owner, office and accountant.
--
-- This suite states the condition that was FALSE before migration 0319 and is TRUE after, in the
-- two instruments the finding named: the catalogue (`has_column_privilege` /
-- `has_table_privilege`), and a LIVE read as each role with a real JWT subject and
-- `set local role authenticated`, so `auth_org()`, `auth_role()` and RLS are all actually in the
-- path. A read performed as postgres would prove nothing at all here -- postgres owns the tables
-- and is exempt from the very policies under test.
--
-- EVERY LIVE ASSERTION IS PER ROW. The surfaces are aggregated as `name=value` strings ordered by
-- name and compared to a literal, never counted: a count of 3 passes for a tenant whose three rows
-- are the wrong three, and "office receives nothing" is a claim about which rows, not how many.
--
-- THE ONE PLACE THIS SUITE EXECUTES A REFUSAL rather than reading the catalogue is section 5, and
-- it is a COLUMN privilege denial inside the ordinary executor ACL check. That is not the
-- function-EXECUTE denial that segfaults this Postgres image (calling a function a role holds no
-- EXECUTE on takes the whole container down; every privilege question about a FUNCTION in this
-- repository is therefore answered from `has_function_privilege`). A table/column denial raises
-- 42501 cleanly, which is what p0_client_dml_acl.sql has relied on for twenty-odd assertions.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p112_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P112 settings boundary assertion failed: %', p_message;
  end if;
end
$$;

-- ===== Fixtures =====
-- Two tenants. Tenant A carries all three product roles so that "owner yes, office no" is measured
-- between people who are the SAME database role; tenant B exists so that "cross-tenant receives
-- nothing" is measured against a real neighbour rather than against an empty database.
--
-- The JWT subject is cleared for the fixture writes: the audit trigger on org_autonomy_policies
-- rejects a JWT-authored write for another organisation by design, and a seed has no end-user.
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '', true);

insert into public.organizations (id, name, status) values
  ('11200000-0000-4000-8000-000000000001', 'P112 tenant A', 'active'),
  ('11200000-0000-4000-8000-000000000002', 'P112 tenant B', 'active');
insert into auth.users (id, email) values
  ('21200000-0000-4000-8000-000000000001', 'owner-p112@example.test'),
  ('21200000-0000-4000-8000-000000000002', 'office-p112@example.test'),
  ('21200000-0000-4000-8000-000000000003', 'accountant-p112@example.test'),
  ('21200000-0000-4000-8000-000000000004', 'owner-b-p112@example.test');
-- The accountant has NO telephone number and NO backup address on purpose: a NULL that survives
-- the view is the difference between "this person has none" and "this reader was not served the
-- column", and the roster draws those two states differently.
insert into public.profiles (id, org_id, full_name, role, phone, backup_email) values
  ('21200000-0000-4000-8000-000000000001', '11200000-0000-4000-8000-000000000001',
   'P112 owner', 'owner', '050-1000001', 'owner-p112@example.test'),
  ('21200000-0000-4000-8000-000000000002', '11200000-0000-4000-8000-000000000001',
   'P112 office', 'office', '050-1000002', 'office-p112@example.test'),
  ('21200000-0000-4000-8000-000000000003', '11200000-0000-4000-8000-000000000001',
   'P112 accountant', 'accountant', null, null),
  ('21200000-0000-4000-8000-000000000004', '11200000-0000-4000-8000-000000000002',
   'P112 tenant B owner', 'owner', '050-2000001', 'owner-b-p112@example.test');

insert into public.org_flag_configurations (org_id, flag_key, state) values
  ('11200000-0000-4000-8000-000000000001', 'p112.tenant-a', true),
  ('11200000-0000-4000-8000-000000000002', 'p112.tenant-b', true);
insert into public.org_autonomy_policies (org_id, policy_key, autonomy_enabled, min_confidence) values
  ('11200000-0000-4000-8000-000000000001', 'p112.autonomy-a', true, 0.950),
  ('11200000-0000-4000-8000-000000000002', 'p112.autonomy-b', true, 0.950);

-- ===== 1. The catalogue: the four columns are out of every client role's reach =====
select pg_temp.p112_assert(
  not has_column_privilege('authenticated', 'public.profiles', 'phone', 'select')
  and not has_column_privilege('authenticated', 'public.profiles', 'backup_email', 'select')
  and not has_column_privilege('anon', 'public.profiles', 'phone', 'select')
  and not has_column_privilege('anon', 'public.profiles', 'backup_email', 'select'),
  'a client role can still select a colleague''s phone or backup address straight off profiles. '
  'RLS cannot mask a column, so the column privilege is the only thing standing here');

select pg_temp.p112_assert(
  not has_column_privilege('authenticated', 'public.organizations', 'trial_ends_at', 'select')
  and not has_column_privilege('authenticated', 'public.organizations', 'created_at', 'select')
  and not has_column_privilege('anon', 'public.organizations', 'trial_ends_at', 'select')
  and not has_column_privilege('anon', 'public.organizations', 'created_at', 'select'),
  'a client role can still select the tenant''s commercial columns straight off organizations');

-- The other half of a column REVOKE, and the half that breaks screens: EVERY remaining column
-- must still be readable. This re-derives the list from information_schema and names the casualty,
-- because the symptom of getting it wrong is a 403 on a whole statement, nowhere near the cause.
select pg_temp.p112_assert(
  not exists (
    select 1 from information_schema.columns c
    where c.table_schema = 'public'
      and ((c.table_name = 'profiles' and c.column_name not in ('phone', 'backup_email'))
        or (c.table_name = 'organizations' and c.column_name not in ('created_at', 'trial_ends_at')))
      and not has_column_privilege('authenticated', format('public.%I', c.table_name), c.column_name, 'select')),
  'an account column the product reads became unreadable: ' || coalesce((
    select string_agg(c.table_name || '.' || c.column_name, ', ' order by c.table_name, c.column_name)
    from information_schema.columns c
    where c.table_schema = 'public'
      and ((c.table_name = 'profiles' and c.column_name not in ('phone', 'backup_email'))
        or (c.table_name = 'organizations' and c.column_name not in ('created_at', 'trial_ends_at')))
      and not has_column_privilege('authenticated', format('public.%I', c.table_name), c.column_name, 'select')
  ), '(none)'));

-- Reading a colleague's number and maintaining your own are two different boundaries, and 0319
-- moved only the first. 0255:152 granted `update (backup_email)` deliberately.
select pg_temp.p112_assert(
  has_column_privilege('authenticated', 'public.profiles', 'phone', 'update')
  and has_column_privilege('authenticated', 'public.profiles', 'backup_email', 'update'),
  'a person lost the ability to maintain their own phone or backup address -- the revoke was '
  'meant to be SELECT only');

-- ===== 2. The catalogue: the shapes the boundary depends on =====
select pg_temp.p112_assert(
  has_table_privilege('authenticated', 'public.organization_people_directory', 'select')
  and not has_table_privilege('authenticated', 'public.organization_people_directory', 'insert')
  and not has_table_privilege('authenticated', 'public.organization_people_directory', 'update')
  and not has_table_privilege('authenticated', 'public.organization_people_directory', 'delete')
  and not has_table_privilege('anon', 'public.organization_people_directory', 'select'),
  'the owner directory is not a read-only surface for the browser role alone');

-- If it were a security_invoker view it would read with the CALLER's privileges -- which no
-- longer include the two columns -- and the OWNER would get an error instead of a roster. And
-- without security_barrier a caller's own WHERE can run before the role predicate.
select pg_temp.p112_assert(
  (select coalesce(reloptions::text, '') not like '%security_invoker=%'
     and reloptions::text like '%security_barrier=true%'
   from pg_class where oid = 'public.organization_people_directory'::regclass),
  'the owner directory is a security_invoker view, or lost security_barrier');

-- The predicate is what separates the three product roles; a grant cannot, because all three are
-- the same database role. Both halves pinned by text: a later edit that dropped either would
-- leave a view that still works and no longer refuses anybody.
select pg_temp.p112_assert(
  (select position('auth_role()' in pg_get_viewdef('public.organization_people_directory'::regclass)) > 0
      and position('''owner''' in pg_get_viewdef('public.organization_people_directory'::regclass)) > 0
      and position('auth_org()' in pg_get_viewdef('public.organization_people_directory'::regclass)) > 0),
  'the owner directory lost its role predicate or its tenant predicate');

-- The two configuration tables are narrowed in the POLICY and keep their grant. That is not an
-- oversight: p1_financial_commands.sql:21 asserts, for every public table, that a permissive read
-- policy exists <=> authenticated holds SELECT. Revoking here would break that contract and buy
-- nothing the predicate does not already say.
select pg_temp.p112_assert(
  has_table_privilege('authenticated', 'public.org_flag_configurations', 'select')
  and has_table_privilege('authenticated', 'public.org_autonomy_policies', 'select'),
  'a configuration table lost its SELECT grant -- the narrowing belongs in the policy');
select pg_temp.p112_assert(
  not exists (
    select 1 from pg_policy p
    where p.polrelid in ('public.org_flag_configurations'::regclass,
                         'public.org_autonomy_policies'::regclass)
      and p.polcmd = 'r'
      and position('auth_role()' in coalesce(pg_get_expr(p.polqual, p.polrelid), '')) = 0),
  'a configuration table''s read policy still answers every role in the tenant');

-- ===== 3. The live reads, one row per role, every surface named =====
create table pg_temp.p112_live (
  as_role   text not null,
  surface   text not null,
  observed  text not null,
  expected  text not null
);

do $p112_live$
declare
  r record;
  v_directory_phone  text;
  v_directory_backup text;
  v_flags            text;
  v_autonomy         text;
  v_roster           text;
  v_orgs             text;
begin
  for r in
    select * from (values
      ('owner',        '21200000-0000-4000-8000-000000000001'),
      ('office',       '21200000-0000-4000-8000-000000000002'),
      ('accountant',   '21200000-0000-4000-8000-000000000003'),
      ('owner-B',      '21200000-0000-4000-8000-000000000004')
    ) as actors(role_label, subject)
  loop
    perform set_config('request.jwt.claim.sub', r.subject, true);
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    set local role authenticated;

    -- Aggregated per row and ordered by name, never counted. `-` is a value the fixture put
    -- there (the accountant has neither), so a NULL that survives the view is distinguishable
    -- from a row that never arrived.
    select coalesce(string_agg(d.full_name || '=' || coalesce(d.phone, '-'), ', ' order by d.full_name), '(none)')
      into v_directory_phone
    from public.organization_people_directory d;
    select coalesce(string_agg(d.full_name || '=' || coalesce(d.backup_email, '-'), ', ' order by d.full_name), '(none)')
      into v_directory_backup
    from public.organization_people_directory d;
    select coalesce(string_agg(f.flag_key, ', ' order by f.flag_key), '(none)')
      into v_flags from public.org_flag_configurations f;
    select coalesce(string_agg(a.policy_key, ', ' order by a.policy_key), '(none)')
      into v_autonomy from public.org_autonomy_policies a;
    select coalesce(string_agg(p.full_name, ', ' order by p.full_name), '(none)')
      into v_roster from public.profiles p;
    select coalesce(string_agg(o.name, ', ' order by o.name), '(none)')
      into v_orgs from public.organizations o;

    reset role;

    insert into pg_temp.p112_live (as_role, surface, observed, expected) values
      (r.role_label, 'directory.phone',  v_directory_phone,  case r.role_label
         when 'owner'   then 'P112 accountant=-, P112 office=050-1000002, P112 owner=050-1000001'
         when 'owner-B' then 'P112 tenant B owner=050-2000001'
         else '(none)' end),
      (r.role_label, 'directory.backup', v_directory_backup, case r.role_label
         when 'owner'   then 'P112 accountant=-, P112 office=office-p112@example.test, P112 owner=owner-p112@example.test'
         when 'owner-B' then 'P112 tenant B owner=owner-b-p112@example.test'
         else '(none)' end),
      (r.role_label, 'flag_configurations', v_flags, case r.role_label
         when 'owner'   then 'p112.tenant-a'
         when 'owner-B' then 'p112.tenant-b'
         else '(none)' end),
      (r.role_label, 'autonomy_policies', v_autonomy, case r.role_label
         when 'owner'   then 'p112.autonomy-a'
         when 'owner-B' then 'p112.autonomy-b'
         else '(none)' end),
      -- THE CONTROL. The roster itself is not narrowed by anything here, and every one of the four
      -- reads it in full within their own tenant, before the migration and after it. A red on this
      -- line means the harness lost the tenant, not that the boundary moved.
      (r.role_label, 'roster', v_roster, case r.role_label
         when 'owner-B' then 'P112 tenant B owner'
         else 'P112 accountant, P112 office, P112 owner' end),
      (r.role_label, 'organizations', v_orgs, case r.role_label
         when 'owner-B' then 'P112 tenant B'
         else 'P112 tenant A' end);
  end loop;
end
$p112_live$;

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

select pg_temp.p112_assert(
  not exists (select 1 from pg_temp.p112_live where observed is distinct from expected),
  'a role received a surface it must not, or lost one it must keep:' || coalesce((
    select string_agg(
      e'\n  ' || as_role || ' / ' || surface
        || e'\n      expected: ' || expected
        || e'\n      observed: ' || observed,
      '' order by as_role, surface)
    from pg_temp.p112_live where observed is distinct from expected), ''));

-- ===== 4. The two ends of the claim, said separately =====
-- Stated on their own so a red run names the specific thing that failed rather than a wall of
-- rows: office and accountant get NOTHING from the three narrowed surfaces, and the owner gets
-- all of them. The aggregate above already covers this; these two make the sentence readable.
select pg_temp.p112_assert(
  (select count(*) = 8 from pg_temp.p112_live
   where as_role in ('office', 'accountant')
     and surface in ('directory.phone', 'directory.backup', 'flag_configurations', 'autonomy_policies')
     and observed = '(none)'),
  'office or accountant still receives one of the four narrowed surfaces');
select pg_temp.p112_assert(
  (select count(*) = 4 from pg_temp.p112_live
   where as_role = 'owner'
     and surface in ('directory.phone', 'directory.backup', 'flag_configurations', 'autonomy_policies')
     and observed <> '(none)'),
  'the owner lost one of the four surfaces the fix must keep');

-- ===== 5. The direct path, executed =====
-- The catalogue says the privilege is gone; this says the statement is actually refused, for the
-- OWNER too -- the view is the owner's only route, not a convenience beside a door still open.
-- This is a column ACL denial (42501), not the function-EXECUTE denial that crashes this image.
select set_config('request.jwt.claim.sub', '21200000-0000-4000-8000-000000000001', true);
do $p112_direct$
begin
  set local role authenticated;
  perform phone from public.profiles limit 1;
  reset role;
  raise exception 'P112 settings boundary assertion failed: the owner still selected '
    'profiles.phone directly, so the column privilege is not what is standing here';
exception when insufficient_privilege then
  null;
end
$p112_direct$;

do $p112_direct_org$
begin
  set local role authenticated;
  perform trial_ends_at from public.organizations limit 1;
  reset role;
  raise exception 'P112 settings boundary assertion failed: a tenant member still selected '
    'organizations.trial_ends_at directly';
exception when insufficient_privilege then
  null;
end
$p112_direct_org$;

reset role;
select set_config('request.jwt.claim.sub', '', true);

rollback;
