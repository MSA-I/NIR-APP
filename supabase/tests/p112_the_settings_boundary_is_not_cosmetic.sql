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
-- THE HARNESS ACCUMULATES; IT DOES NOT ABORT ON THE FIRST FALSE CASE. Every case is recorded in
-- pg_temp.p112_cases as an expected/observed PAIR, the whole table is printed, and one verdict at
-- the end raises with the list of mismatches. That is not a stylistic preference: a REVOKE is the
-- one change in this area that can break every open tab in the product, so the red must show WHICH
-- cases moved and, in the SAME RUN, that the deliberate controls did not. A harness that stops at
-- the first failure cannot show a control passing beside it, and "everything failed" is
-- indistinguishable from a broken harness.
--
-- THE CONTROLS, named here so a reader does not have to infer them. They are marked `control` in
-- the printed table and are green BEFORE the migration and after it:
--   * catalogue/other-columns-still-readable -- the half of a column REVOKE that breaks screens.
--   * catalogue/self-service-update-kept     -- 0255:152 granted update(backup_email) on purpose.
--   * catalogue/config-tables-keep-grant     -- the narrowing belongs in the policy, not the grant.
--   * live/roster and live/organizations, for all four actors -- nothing in 0319 narrows a name,
--     so a red on one of these means the harness lost its tenant, not that the boundary moved.
--
-- EVERY LIVE ASSERTION IS PER ROW. The surfaces are aggregated as `name=value` strings ordered by
-- name and compared to a literal, never counted: a count of 3 passes for a tenant whose three rows
-- are the wrong three, and "office receives nothing" is a claim about which rows, not how many.
--
-- THE PLACES THIS SUITE EXECUTES A REFUSAL rather than reading the catalogue are the two
-- `live/direct.*` surfaces, and they are COLUMN privilege denials inside the ordinary executor ACL
-- check. That is not the function-EXECUTE denial that segfaults this Postgres image (calling a
-- function a role holds no EXECUTE on takes the whole container down; every privilege question
-- about a FUNCTION in this repository is therefore answered from `has_function_privilege`). A
-- table/column denial raises 42501 cleanly, which is what p0_client_dml_acl.sql has relied on for
-- twenty-odd assertions. Those two surfaces are also where the LEAK ITSELF is stated: before 0319
-- an office clerk's own `observed` column literally lists a colleague's telephone number.
\set ON_ERROR_STOP on

begin;

create table pg_temp.p112_cases (
  seq        int generated always as identity,
  case_id    text not null,
  kind       text not null,
  expected   text not null,
  observed   text not null
);

create function pg_temp.p112_case(
  p_case text, p_expected text, p_observed text, p_control boolean default false)
returns void language sql as $$
  insert into pg_temp.p112_cases (case_id, kind, expected, observed)
  values (p_case, case when p_control then 'control' else 'case' end,
          p_expected, coalesce(p_observed, '(null)'));
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

-- ===== 1. The catalogue =====
-- Guarded inside a block rather than written as bare SELECTs because three of these ask questions
-- about a view that does not exist before the migration, and `has_table_privilege` on a missing
-- relation raises rather than returning false.
do $p112_catalogue$
declare
  v_view text;
begin
  -- The four columns leave every client role's reach. RLS cannot mask a column -- 0097 says so in
  -- its first line -- so the column privilege is the only instrument that can stand here.
  perform pg_temp.p112_case('catalogue/profiles.phone as authenticated', 'revoked',
    case when has_column_privilege('authenticated', 'public.profiles', 'phone', 'select')
         then 'READABLE' else 'revoked' end);
  perform pg_temp.p112_case('catalogue/profiles.backup_email as authenticated', 'revoked',
    case when has_column_privilege('authenticated', 'public.profiles', 'backup_email', 'select')
         then 'READABLE' else 'revoked' end);
  perform pg_temp.p112_case('catalogue/profiles.phone as anon', 'revoked',
    case when has_column_privilege('anon', 'public.profiles', 'phone', 'select')
         then 'READABLE' else 'revoked' end);
  perform pg_temp.p112_case('catalogue/profiles.backup_email as anon', 'revoked',
    case when has_column_privilege('anon', 'public.profiles', 'backup_email', 'select')
         then 'READABLE' else 'revoked' end);
  perform pg_temp.p112_case('catalogue/organizations.trial_ends_at as authenticated', 'revoked',
    case when has_column_privilege('authenticated', 'public.organizations', 'trial_ends_at', 'select')
         then 'READABLE' else 'revoked' end);
  perform pg_temp.p112_case('catalogue/organizations.created_at as authenticated', 'revoked',
    case when has_column_privilege('authenticated', 'public.organizations', 'created_at', 'select')
         then 'READABLE' else 'revoked' end);
  perform pg_temp.p112_case('catalogue/organizations.trial_ends_at as anon', 'revoked',
    case when has_column_privilege('anon', 'public.organizations', 'trial_ends_at', 'select')
         then 'READABLE' else 'revoked' end);
  perform pg_temp.p112_case('catalogue/organizations.created_at as anon', 'revoked',
    case when has_column_privilege('anon', 'public.organizations', 'created_at', 'select')
         then 'READABLE' else 'revoked' end);

  -- CONTROL. The other half of a column REVOKE, and the half that breaks screens: EVERY remaining
  -- column must still be readable. Derived from information_schema so it keeps covering a column
  -- added later, and it NAMES the casualty -- the symptom of getting this wrong is a 403 on a
  -- whole statement, nowhere near the cause.
  perform pg_temp.p112_case('catalogue/other-columns-still-readable', '(none unreadable)',
    coalesce((
      select string_agg(c.table_name || '.' || c.column_name, ', ' order by c.table_name, c.column_name)
      from information_schema.columns c
      where c.table_schema = 'public'
        and ((c.table_name = 'profiles' and c.column_name not in ('phone', 'backup_email'))
          or (c.table_name = 'organizations' and c.column_name not in ('created_at', 'trial_ends_at')))
        and not has_column_privilege('authenticated', format('public.%I', c.table_name), c.column_name, 'select')
    ), '(none unreadable)'), true);

  -- CONTROL. Reading a colleague's number and maintaining your own are two different boundaries,
  -- and 0319 moves only the first. 0255:152 granted `update (backup_email)` deliberately.
  perform pg_temp.p112_case('catalogue/self-service-update-kept', 'phone+backup_email updatable',
    case when has_column_privilege('authenticated', 'public.profiles', 'phone', 'update')
          and has_column_privilege('authenticated', 'public.profiles', 'backup_email', 'update')
         then 'phone+backup_email updatable' else 'a person lost a write on their own row' end, true);

  -- The owner's route back: read-only for the browser role, closed to anon.
  if to_regclass('public.organization_people_directory') is null then
    perform pg_temp.p112_case('catalogue/directory is a read-only browser surface',
      'select only, anon none', '(view absent)');
    perform pg_temp.p112_case('catalogue/directory is not security_invoker and keeps barrier',
      'definer-privileged, security_barrier=true', '(view absent)');
    perform pg_temp.p112_case('catalogue/directory carries role and tenant predicates',
      'auth_role()+owner+auth_org()', '(view absent)');
  else
    perform pg_temp.p112_case('catalogue/directory is a read-only browser surface',
      'select only, anon none',
      case when has_table_privilege('authenticated', 'public.organization_people_directory', 'select')
            and not has_table_privilege('authenticated', 'public.organization_people_directory', 'insert')
            and not has_table_privilege('authenticated', 'public.organization_people_directory', 'update')
            and not has_table_privilege('authenticated', 'public.organization_people_directory', 'delete')
            and not has_table_privilege('anon', 'public.organization_people_directory', 'select')
           then 'select only, anon none' else 'wrong privilege set' end);

    -- A security_invoker view would read with the CALLER's privileges -- which no longer include
    -- the two columns -- so the OWNER would get an error instead of a roster. And without
    -- security_barrier a caller's own WHERE can be evaluated before the role predicate.
    perform pg_temp.p112_case('catalogue/directory is not security_invoker and keeps barrier',
      'definer-privileged, security_barrier=true',
      (select case when coalesce(reloptions::text, '') like '%security_invoker=%'
                   then 'security_invoker view'
                   when coalesce(reloptions::text, '') not like '%security_barrier=true%'
                   then 'lost security_barrier'
                   else 'definer-privileged, security_barrier=true' end
       from pg_class where oid = 'public.organization_people_directory'::regclass));

    -- The predicate is what separates the three product roles; a grant cannot, because all three
    -- are the same database role. Both halves pinned by text: an edit that dropped either would
    -- leave a view that still works and no longer refuses anybody.
    select pg_get_viewdef('public.organization_people_directory'::regclass) into v_view;
    perform pg_temp.p112_case('catalogue/directory carries role and tenant predicates',
      'auth_role()+owner+auth_org()',
      case when position('auth_role()' in v_view) > 0
            and position('''owner''' in v_view) > 0
            and position('auth_org()' in v_view) > 0
           then 'auth_role()+owner+auth_org()' else 'a predicate is missing' end);
  end if;

  -- CONTROL. The two configuration tables are narrowed in the POLICY and KEEP their grant. That is
  -- not an oversight: p1_financial_commands.sql:21 asserts, for every public table, that a
  -- permissive read policy exists <=> authenticated can read at least one column. Revoking here
  -- would break that contract and buy nothing the predicate does not already say.
  perform pg_temp.p112_case('catalogue/config-tables-keep-grant', 'both granted',
    case when has_table_privilege('authenticated', 'public.org_flag_configurations', 'select')
          and has_table_privilege('authenticated', 'public.org_autonomy_policies', 'select')
         then 'both granted' else 'a configuration table lost its SELECT grant' end, true);

  perform pg_temp.p112_case('catalogue/config-read-policies name the role', 'both name auth_role()',
    coalesce((
      select 'still answers every role: ' || string_agg(c.relname || '.' || p.polname, ', ' order by c.relname)
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      where p.polrelid in ('public.org_flag_configurations'::regclass,
                           'public.org_autonomy_policies'::regclass)
        and p.polcmd = 'r'
        and position('auth_role()' in coalesce(pg_get_expr(p.polqual, p.polrelid), '')) = 0
    ), 'both name auth_role()'));
end
$p112_catalogue$;

-- ===== 2. The live reads, one row per actor per surface =====
do $p112_live$
declare
  r record;
  v_directory_phone  text;
  v_directory_backup text;
  v_direct_phone     text;
  v_direct_trial     text;
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

    -- The owner's route back. `-` is a value the fixture put there (the accountant has neither),
    -- so a NULL that survives the view stays distinguishable from a row that never arrived.
    if to_regclass('public.organization_people_directory') is null then
      v_directory_phone  := '(view absent)';
      v_directory_backup := '(view absent)';
    else
      select coalesce(string_agg(d.full_name || '=' || coalesce(d.phone, '-'), ', ' order by d.full_name), '(none)')
        into v_directory_phone from public.organization_people_directory d;
      select coalesce(string_agg(d.full_name || '=' || coalesce(d.backup_email, '-'), ', ' order by d.full_name), '(none)')
        into v_directory_backup from public.organization_people_directory d;
    end if;

    -- THE LEAK, EXECUTED. Straight off the table, exactly the shape `select('*')` produced. Before
    -- 0319 an office clerk reads a colleague's telephone number here and it is printed in this
    -- row's `observed`; after it, the statement is refused for every actor including the owner --
    -- the view is the owner's only route, not a convenience beside a door still open.
    begin
      select coalesce(string_agg(p.full_name || '=' || coalesce(p.phone, '-'), ', ' order by p.full_name), '(none)')
        into v_direct_phone from public.profiles p;
    exception when insufficient_privilege then
      v_direct_phone := 'refused (42501)';
    end;
    begin
      select coalesce(string_agg(o.name || '=' || coalesce(o.trial_ends_at::text, '-'), ', ' order by o.name), '(none)')
        into v_direct_trial from public.organizations o;
    exception when insufficient_privilege then
      v_direct_trial := 'refused (42501)';
    end;

    select coalesce(string_agg(f.flag_key, ', ' order by f.flag_key), '(none)')
      into v_flags from public.org_flag_configurations f;
    select coalesce(string_agg(a.policy_key, ', ' order by a.policy_key), '(none)')
      into v_autonomy from public.org_autonomy_policies a;
    select coalesce(string_agg(p.full_name, ', ' order by p.full_name), '(none)')
      into v_roster from public.profiles p;
    select coalesce(string_agg(o.name, ', ' order by o.name), '(none)')
      into v_orgs from public.organizations o;

    reset role;

    perform pg_temp.p112_case(r.role_label || ' / live/directory.phone',
      case r.role_label
        when 'owner'   then 'P112 accountant=-, P112 office=050-1000002, P112 owner=050-1000001'
        when 'owner-B' then 'P112 tenant B owner=050-2000001'
        else '(none)' end,
      v_directory_phone);
    perform pg_temp.p112_case(r.role_label || ' / live/directory.backup',
      case r.role_label
        when 'owner'   then 'P112 accountant=-, P112 office=office-p112@example.test, P112 owner=owner-p112@example.test'
        when 'owner-B' then 'P112 tenant B owner=owner-b-p112@example.test'
        else '(none)' end,
      v_directory_backup);
    perform pg_temp.p112_case(r.role_label || ' / live/direct.profiles.phone',
      'refused (42501)', v_direct_phone);
    perform pg_temp.p112_case(r.role_label || ' / live/direct.organizations.trial_ends_at',
      'refused (42501)', v_direct_trial);
    -- The two configuration surfaces carry MORE than this suite's own fixture row. Every
    -- organization is born with a default set: the `zzz_organizations_prelaunch_assistant` and
    -- `zzz_organizations_prelaunch_autonomy` triggers write them on insert. They are named in the
    -- literal rather than filtered out, because the claim is "the owner reads this tenant's
    -- configuration and nobody else does" -- and a filter that hid the defaults would leave the
    -- suite unable to notice if a default row started reaching an accountant.
    perform pg_temp.p112_case(r.role_label || ' / live/flag_configurations',
      case r.role_label
        when 'owner'   then 'assistant.history, assistant.ui, p112.tenant-a'
        when 'owner-B' then 'assistant.history, assistant.ui, p112.tenant-b'
        else '(none)' end,
      v_flags);
    perform pg_temp.p112_case(r.role_label || ' / live/autonomy_policies',
      case r.role_label
        when 'owner'   then 'delivery_note.receiving, document.interpretation, document.packet_split, p112.autonomy-a, price_list.intake'
        when 'owner-B' then 'delivery_note.receiving, document.interpretation, document.packet_split, p112.autonomy-b, price_list.intake'
        else '(none)' end,
      v_autonomy);
    -- CONTROLS. Nothing in 0319 narrows a name. All four actors read their own tenant's roster and
    -- their own organizations row in full, before the migration and after it. A red on one of
    -- these means the harness lost its tenant, not that the boundary moved.
    perform pg_temp.p112_case(r.role_label || ' / live/roster',
      case r.role_label
        when 'owner-B' then 'P112 tenant B owner'
        else 'P112 accountant, P112 office, P112 owner' end,
      v_roster, true);
    perform pg_temp.p112_case(r.role_label || ' / live/organizations',
      case r.role_label
        when 'owner-B' then 'P112 tenant B'
        else 'P112 tenant A' end,
      v_orgs, true);
  end loop;
end
$p112_live$;

reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

-- ===== 3. The whole table, printed, red or green =====
select seq,
       case when observed is not distinct from expected then 'PASS' else 'FAIL' end as verdict,
       kind,
       case_id,
       expected,
       observed
from pg_temp.p112_cases
order by seq;

select count(*) filter (where observed is not distinct from expected) as passed,
       count(*) filter (where observed is distinct from expected)     as failed,
       count(*)                                                       as total,
       count(*) filter (where kind = 'control'
                          and observed is not distinct from expected) as controls_green,
       count(*) filter (where kind = 'control')                       as controls_total
from pg_temp.p112_cases;

-- ===== 4. The verdict =====
do $p112_verdict$
declare
  v_failed   int;
  v_controls int;
  v_detail   text;
begin
  select count(*) filter (where observed is distinct from expected),
         count(*) filter (where kind = 'control' and observed is distinct from expected)
    into v_failed, v_controls
  from pg_temp.p112_cases;

  if v_controls > 0 then
    -- Said before the finding's own cases, because it changes what the run means. A control that
    -- moved is a harness that lost its tenant or its fixtures; nothing below it is evidence.
    raise warning 'P112: % CONTROL case(s) failed -- read this run as a broken harness, not as a finding.', v_controls;
  end if;

  if v_failed > 0 then
    select string_agg(
             e'\n  ' || case_id || '  [' || kind || ']'
               || e'\n      expected: ' || expected
               || e'\n      observed: ' || observed,
             '' order by seq)
      into v_detail
    from pg_temp.p112_cases
    where observed is distinct from expected;
    raise exception 'P112 settings boundary: % case(s) failed:%', v_failed, v_detail;
  end if;
end
$p112_verdict$;

rollback;
