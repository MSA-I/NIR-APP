-- 0319 -- /settings is refused to office and accountant by the router only. The API serves them
-- every row the screen draws, and two columns it does not.
--
-- MEASURED, NOT INFERRED (production, read-only, 05.09.2026 -- the numbers are in
-- docs/qa/2026-09-04/evidence/PERM01-DIAGNOSIS-PRODUCTION.txt). One read per role on the guarded
-- path -- `set local role authenticated` with that person's subject in the JWT claims:
--
--   as_role      colleagues  phone values  organizations rows  flag rows  autonomy rows
--   owner                 6             5                   1          3              4
--   office                6             5                   1          3              4
--   accountant            6             5                   1          3              4
--
-- Identical. `App.tsx:425` wraps the route in `<Guard roles={['owner']}>` and that is the entire
-- boundary: it decides what is PAINTED, and PostgREST has never heard of it.
--
-- FOUR SURFACES, AND THEY NEED TWO DIFFERENT MECHANISMS. This is the whole shape of the migration
-- and it is not a stylistic choice.
--
--   * `profiles.phone` and `profiles.backup_email` are COLUMNS. RLS cannot mask a column -- 0097
--     says so in its first line and 0112 is built on it -- so the only instrument is a column
--     privilege. But a column privilege cannot tell owner from office either: all three product
--     roles are the SAME database role, `authenticated`. So the 0112 shape is forced: revoke the
--     table grant, re-grant every column except those two, and hand them back through a view that
--     runs with its OWNER's privileges and carries its own role predicate.
--   * `organizations.created_at` and `organizations.trial_ends_at` are columns too, and nothing
--     hands them back: no tenant screen draws either, and an operator reads them through the
--     platform commands in src/lib/platform.ts, every one of which is SECURITY DEFINER.
--   * `org_flag_configurations` and `org_autonomy_policies` are ROWS. A read policy CAN name a
--     role, so these are narrowed in the policy and KEEP their table grant -- which is why the
--     "a permissive read policy exists <=> authenticated holds SELECT" contract
--     (p1_financial_commands.sql:21) still holds on both after this migration. Revoking the grant
--     would have broken it and bought nothing the predicate does not.
--
-- WHY `backup_email` IS THE ONE THAT MATTERS MOST, even though its live count above is zero. It
-- is zero because nobody in that tenant has nominated a second address yet. The COLUMN is fully
-- readable, so the first person who nominates one publishes their account-recovery address to
-- every colleague -- and the settings roster was fetching it with `select('*')` on every visit.
-- 0255 built `my_backup_email()` precisely so a person could read their OWN; this closes the
-- door 0255 left open beside it.
--
-- WHAT WAS MEASURED BEFORE THE REVOKE WAS WRITTEN, because a column REVOKE takes bystanders with
-- it and the failure is a 403 on a whole statement, nowhere near the line that caused it:
--   * exactly one view in `public` reads either table -- `inventory_movement_feed`, which is
--     `security_invoker=on` and therefore the one that COULD have broken. It selects full_name,
--     org_id and id from profiles. None of the four columns.
--   * one INVOKER routine a browser role may execute names any of the four columns and either
--     table: `management_dashboard_snapshot(date)`, whose `created_at` references are on other
--     tables (0263 reads neither of these two at all).
--   * no existing SQL suite reads any of the four from the TABLE as `authenticated`. p44's three
--     `trial_ends_at` reads are from the return columns of `organization_access_state()`, a
--     definer RPC; p22, p25, p70 and p75 read theirs as postgres.
--   * the client stopped asking one commit earlier, which is the only reason this is deployable:
--     `*` expands to every column, so a revoke turns an open tab's next read into a 403 on the
--     WHOLE statement rather than on the one column it may not have.

-- ===== 1. Two personal columns leave the browser's reach =====
--
-- A column-level REVOKE does nothing while a TABLE-level SELECT grant stands: table SELECT already
-- implies every column and the two are not subtracted from one another. So the table grant is
-- dropped and re-issued column by column. The list is built from information_schema rather than
-- typed out, because a typed list silently stops covering a column added later -- and anchor (a2)
-- re-derives it to prove the coverage is complete.
--
-- UPDATE is untouched on purpose. `profiles_self_update` (0020) plus the browser-writable
-- allow-list in `profiles_guard_privileged_columns` is how a person maintains their own phone and
-- nominates their own backup address; 0255:152 granted `update (backup_email)` for exactly that.
-- Reading someone else's and writing your own are two different boundaries and this moves one.
do $columns_0319$
declare
  v_columns text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into v_columns
  from information_schema.columns
  where table_schema = 'public' and table_name = 'profiles'
    and column_name not in ('phone', 'backup_email');

  revoke select on public.profiles from authenticated, anon;
  execute format('grant select (%s) on public.profiles to authenticated', v_columns);

  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into v_columns
  from information_schema.columns
  where table_schema = 'public' and table_name = 'organizations'
    and column_name not in ('created_at', 'trial_ends_at');

  revoke select on public.organizations from authenticated, anon;
  execute format('grant select (%s) on public.organizations to authenticated', v_columns);
end
$columns_0319$;

comment on column public.profiles.phone is
  'A colleague''s telephone number. NOT directly selectable by any client role (0319): a column '
  'privilege is revoked from `authenticated`, beneath RLS, so no crafted PostgREST query reaches '
  'it. The owner reads it through public.organization_people_directory, which runs with its '
  'owner''s privileges and carries its own role predicate. Writes are unchanged -- the person '
  'maintains their own through profiles_self_update.';

comment on column public.profiles.backup_email is
  'A second address this person can be reached at, nominated by them (owner decision #270). '
  'Nomination is NOT proof: the address counts as verified only while a row in '
  'profile_backup_email_verifications carries the same address with verified_at set. Self-service, '
  'like phone and locale -- writable by the person themselves through profiles_self_update and '
  'listed in profiles_guard_privileged_columns'' browser-writable allow-list. Grants nothing. '
  '0319: NOT directly selectable by any client role either. It is an account-recovery address, and '
  'the settings roster was fetching every colleague''s with select(*). A person reads their own '
  'through my_backup_email() (0255); the owner reads the tenant''s through '
  'public.organization_people_directory.';

comment on column public.organizations.trial_ends_at is
  'When this tenant''s trial ends. Commercial, not operational: no tenant screen draws it, so 0319 '
  'revoked the column privilege from every client role. An operator reads it through the platform '
  'commands, which are SECURITY DEFINER and carry their own operator predicate.';

comment on column public.organizations.created_at is
  'When this tenant was provisioned. No tenant screen draws it, so 0319 revoked the column '
  'privilege from every client role for the same reason as trial_ends_at.';

-- ===== 2. The owner's route back to the two personal columns =====
--
-- Modelled on public.financial_supplier_directory (0097/0112), the only other place in this schema
-- where a column has to reach one product role and not another. A view reads with its OWNER's
-- privileges, so it can select a column its caller cannot, and its own predicate decides who gets
-- to ask -- which is the only way to say "owner yes, office no" when both are `authenticated`.
--
-- `security_barrier` is not decoration: without it a caller's own WHERE clause may be evaluated
-- BEFORE the role predicate, and a leaky operator or a well-chosen error message reads rows the
-- predicate was supposed to withhold. Anchor (d) restates it.
--
-- Deliberately the WHOLE roster row and not a phone lookup: the settings screen already draws
-- name, role and status, and a second surface that returned only the phone would make the screen
-- join two answers about the same people and pick which to believe.
create or replace view public.organization_people_directory
with (security_barrier = true)
as
select p.id, p.org_id, p.full_name, p.role, p.phone, p.backup_email, p.active,
       p.supplier_id, p.locale, p.theme
from public.profiles p
where p.org_id = auth_org()
  and auth.uid() is not null
  and auth_role() = 'owner';

revoke all on public.organization_people_directory from public, anon, authenticated;
grant select on public.organization_people_directory to authenticated;

comment on view public.organization_people_directory is
  'The tenant roster as the OWNER may read it (0319), including the two columns 0319 took out of '
  'every client role''s reach: profiles.phone and profiles.backup_email. This view is the only way '
  'any role now reads either. Office and accountant hold SELECT on the view and receive zero rows '
  'from it, because the predicate -- not the grant -- is what tells the three product roles apart: '
  'they are one database role and a privilege cannot.';

-- ===== 3. The two configuration tables stop answering everyone =====
--
-- 0059 and 0076 both wrote `using (org_id = auth_org())` and both said, in as many words, that the
-- rows carry no secrets and hiding them would add nothing. That was true of a flag's on/off state.
-- It stopped being true when `org_autonomy_policies` became the table that decides whether a model
-- may write financial records unattended and at what confidence -- which is a description of how
-- far the tenant's controls are open, and it is read today by an accountant who cannot change it,
-- cannot see the screen that changes it (it moved to the operator app on 19.08.2026), and has no
-- errand that needs it.
--
-- The predicate is narrowed and the GRANT is kept. That is the difference between this surface and
-- section 1: a policy can name a role, so it does not need the column-privilege machinery -- and
-- keeping the grant is what preserves the all-tables contract in p1_financial_commands.sql:21,
-- "a permissive read policy exists <=> authenticated holds SELECT".
--
-- Nothing in the product reads either table from the browser: the resolver `resolve_feature_flags`
-- is a definer and is the read path for flags, and the autonomy policy is read by the definer
-- commands that enforce it. Measured across src/ and supabase/functions/: zero call sites.
alter policy org_flag_configurations_select on public.org_flag_configurations
  using (org_id = auth_org() and auth_role() = 'owner');

alter policy org_autonomy_policies_select on public.org_autonomy_policies
  using (org_id = auth_org() and auth_role() = 'owner');

comment on table public.org_flag_configurations is
  'Per-organization feature-flag configuration. Readable from the browser by the OWNER only '
  '(0319): the rows say how far this tenant''s controls are open, and every product read goes '
  'through the resolve_feature_flags resolver rather than through these rows. Writes have been '
  'RPC-only since 0059.';

comment on table public.org_autonomy_policies is
  'Per-organization autonomy configuration: whether a model may write a financial record without a '
  'human, and above what confidence. Readable from the browser by the OWNER only (0319) -- the '
  'screen that changes it moved to the operator app on 19.08.2026, and an accountant who can '
  'neither see nor change it has no errand that needs the row. Writes are the one reasoned command '
  '0076 built, and service_role holds no DML at all.';

-- ===== 4. A1/A3/A5 re-assertion =====
do $assert_scope_0319$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0319 scope assertions failed:\n%', v_violations;
  end if;
end
$assert_scope_0319$;

-- ===== 5. Anchors =====
do $assert_0319$
declare
  v_view text;
  v_missing text;
begin
  -- (a) THE FOUR COLUMNS ARE UNREACHABLE DIRECTLY. This is the whole security claim of sections 1.
  if has_column_privilege('authenticated', 'public.profiles', 'phone', 'select')
     or has_column_privilege('authenticated', 'public.profiles', 'backup_email', 'select')
     or has_column_privilege('anon', 'public.profiles', 'phone', 'select')
     or has_column_privilege('anon', 'public.profiles', 'backup_email', 'select') then
    raise exception
      '0319: a client role can still select a colleague''s phone or backup address directly. RLS '
      'cannot mask a column; the column privilege is the only thing standing here.';
  end if;
  if has_column_privilege('authenticated', 'public.organizations', 'trial_ends_at', 'select')
     or has_column_privilege('authenticated', 'public.organizations', 'created_at', 'select')
     or has_column_privilege('anon', 'public.organizations', 'trial_ends_at', 'select')
     or has_column_privilege('anon', 'public.organizations', 'created_at', 'select') then
    raise exception
      '0319: a client role can still select the tenant''s commercial columns directly.';
  end if;

  -- (a2) ...and EVERY OTHER column still is. Revoking a table grant to get column granularity is
  -- the kind of change that takes a bystander with it; this re-derives the list and NAMES the
  -- casualty instead of leaving a screen mysteriously empty. Without it the first symptom would be
  -- a sign-in that 403s and a stack trace pointing at nothing in particular.
  select string_agg(c.table_name || '.' || c.column_name, ', ' order by c.table_name, c.column_name)
    into v_missing
  from information_schema.columns c
  where c.table_schema = 'public'
    and ((c.table_name = 'profiles' and c.column_name not in ('phone', 'backup_email'))
      or (c.table_name = 'organizations' and c.column_name not in ('created_at', 'trial_ends_at')))
    and not has_column_privilege('authenticated', format('public.%I', c.table_name), c.column_name, 'select');
  if v_missing is not null then
    raise exception '0319: an account column the product reads became unreadable: %', v_missing;
  end if;

  -- (b) THE SELF-SERVICE WRITE PATH IS UNTOUCHED. Reading a colleague's number and maintaining
  -- your own are two boundaries; 0255:152 granted the second on purpose and this migration must
  -- not have taken it away as a side effect of dropping the table grant.
  if not has_column_privilege('authenticated', 'public.profiles', 'phone', 'update')
     or not has_column_privilege('authenticated', 'public.profiles', 'backup_email', 'update') then
    raise exception
      '0319: a person lost the ability to maintain their own phone or backup address. The REVOKE '
      'was meant to be SELECT only.';
  end if;

  -- (c) The owner's route back exists, is read-only, and is not an invoker view. If it were
  -- `security_invoker`, it would run with the CALLER's privileges -- which no longer include the
  -- columns -- and the owner would get an error instead of a roster.
  if to_regclass('public.organization_people_directory') is null then
    raise exception '0319: the owner has no route back to the two personal columns.';
  end if;
  if not has_table_privilege('authenticated', 'public.organization_people_directory', 'select')
     or has_table_privilege('authenticated', 'public.organization_people_directory', 'insert')
     or has_table_privilege('authenticated', 'public.organization_people_directory', 'update')
     or has_table_privilege('authenticated', 'public.organization_people_directory', 'delete') then
    raise exception '0319: the people directory is not a read-only surface for the browser role.';
  end if;
  if (select coalesce(reloptions::text, '') like '%security_invoker=%'
      from pg_class where oid = 'public.organization_people_directory'::regclass) then
    raise exception
      '0319: the people directory became a security_invoker view, so it reads with the caller''s '
      'privileges -- which no longer include the two columns it exists to serve.';
  end if;

  -- (d) The predicate, not the grant, is what separates the three product roles -- they are one
  -- database role. Both halves are pinned by text, because a later edit that dropped either would
  -- leave a view that still works and no longer refuses anybody.
  select pg_get_viewdef('public.organization_people_directory'::regclass) into v_view;
  if position('auth_role()' in v_view) = 0 or position('''owner''' in v_view) = 0 then
    raise exception
      '0319: the people directory lost its role predicate. A grant cannot tell owner from office '
      '-- both are `authenticated` -- so without this line every member of the tenant reads every '
      'colleague''s phone and backup address again.';
  end if;
  if position('auth_org()' in v_view) = 0 then
    raise exception
      '0319: the people directory lost its tenant predicate. The view reads with its owner''s '
      'privileges, so RLS on profiles is not what keeps another tenant out -- this line is.';
  end if;
  if not (select reloptions::text like '%security_barrier=true%'
          from pg_class where oid = 'public.organization_people_directory'::regclass) then
    raise exception
      '0319: the directory lost security_barrier, so a caller''s own WHERE clause can now run '
      'before the role predicate and leak rows through error messages or timing.';
  end if;

  -- (e) The two configuration tables answer the owner and nobody else, and they KEPT the grant --
  -- which is the half that is easy to lose. A revoke there would satisfy the finding and break the
  -- all-tables contract that says a table with a permissive read policy is granted to the browser.
  select string_agg(c.relname || '.' || p.polname, ', ' order by c.relname)
    into v_missing
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  where p.polrelid in ('public.org_flag_configurations'::regclass,
                       'public.org_autonomy_policies'::regclass)
    and p.polcmd = 'r'
    and position('auth_role()' in coalesce(pg_get_expr(p.polqual, p.polrelid), '')) = 0;
  if v_missing is not null then
    raise exception
      '0319: a configuration table still answers every role in the tenant: %', v_missing;
  end if;
  if not has_table_privilege('authenticated', 'public.org_flag_configurations', 'select')
     or not has_table_privilege('authenticated', 'public.org_autonomy_policies', 'select') then
    raise exception
      '0319: a configuration table lost its SELECT grant. The narrowing belongs in the policy; '
      'revoking the grant breaks the contract that a table with a permissive read policy is '
      'readable by the browser role, and buys nothing the predicate does not already say.';
  end if;
end
$assert_0319$;
