-- P116 — a password change is the holder's own record.
--
-- Run only against a disposable database with every migration applied.
--
-- WHAT IS UNDER TEST. `PERM-02`: on production, the accountant asked
-- `/rest/v1/audit_log_read_model?action=eq.password_changed` and received 2 rows, of which they
-- are the subject of 0. `0293` writes those rows; `0175`'s `audit_select` hands every
-- `organization_identity_platform` row to every owner AND accountant of the tenant, and
-- `audit_log_read_model` is a `security_invoker` view with no predicate of its own, so the view
-- returns exactly what that policy allows. `0323` adds one conjunct: a `password_changed` row is
-- readable by its SUBJECT, and by the `owner` — the only role with an audit surface
-- (`/supplier-log` is owner-only, ruling #153; `/settings` is owner-only; nothing in `src/` reads
-- `password_changed` at all).
--
-- EVERY READ BELOW IS MEASURED ON THE GUARDED PATH. The fixtures are written as the superuser,
-- which is what a migration or a seed is. Every READ under test is issued with `role` set to
-- `authenticated` and a real `request.jwt.claims.sub`, so `auth_org()`, `auth_role()`,
-- `auth_scopes()` and the policy are all actually in the path. A read run as `postgres` skips RLS
-- entirely and would prove nothing at all.
--
-- AND THE PASSWORD ROWS ARE WRITTEN THE REAL WAY. Not inserted into `audit_logs` by hand: each one
-- comes from `update auth.users set encrypted_password = …`, which is the trigger `0293` installed,
-- so the rows under test are the same shape as the two on production rather than a hand-built
-- imitation of them.
--
-- ASSERTED PER ROW, PER ACTOR — never by count. A count agrees for the wrong reason: an accountant
-- reading two rows they are the subject of neither of, and an accountant reading their own row plus
-- a colleague's, are both "2".
--
-- THE CONTROLS, which pass in BOTH the red and the green run, so a red that is really a broken
-- harness shows up as one:
--   * `identity_control_a` — a `profiles` audit row in the accountant's own tenant, the same
--     `cross_scope`/`organization_identity_platform` class as a password row. The accountant reads
--     it before and after: `0323` narrows password rows, NOT the identity ledger.
--   * `financial_control_a` — a `bank_imports` audit row, `cross_scope`/`financial_accounting`,
--     reachable only through the root-scope branch. Proves the third branch survived the wrap.
--   * `identity_control_b` — the same row in another tenant. Invisible to tenant A before and
--     after; if it ever reads `true` the harness is not measuring RLS.
--   * `office_*` — the office role reads NOTHING from `audit_logs`, before and after.
--     `auth_role() in ('owner','accountant')` has excluded it since `0031:209`, and `0323`'s
--     subject clause does NOT widen one in. A subject clause that handed office a read it never
--     had would be a privilege leak wearing this finding's own words.
--   * `owner_a` on every password row of its own tenant — the regression check. Narrowing a scope
--     is exactly the change that quietly breaks the screen it was meant to protect.
--
-- The outcomes are RECORDED and reported once at the end rather than asserted where they happen.
-- Under ON_ERROR_STOP a suite that asserts inline stops at the first failure and reports one line;
-- this one prints every actor/row pair that disagreed, which is what a red run has to say to be
-- worth reading.
\set ON_ERROR_STOP on

drop schema if exists p116 cascade;
create schema p116;

create table p116.actors (
  actor text primary key,
  user_id uuid not null,
  note text not null
);
create table p116.ledger_rows (
  row_key text primary key,
  audit_id uuid not null,
  note text not null
);
create table p116.reads (
  actor text not null,
  row_key text not null,
  visible boolean not null,
  primary key (actor, row_key)
);
create table p116.expectations (
  actor text not null,
  row_key text not null,
  expected boolean not null,
  is_control boolean not null,
  note text not null,
  primary key (actor, row_key)
);

grant usage on schema p116 to authenticated;
grant select on p116.ledger_rows to authenticated;
grant insert, select on p116.reads to authenticated;

create function p116.assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P116 assertion failed: %', p_message;
  end if;
end
$$;

-- ===== Fixture: two tenants =====

insert into public.organizations (id, name, status, vat_rate, base_currency, country_code) values
  ('a1160000-0000-4000-8000-000000000001', 'P116 tenant A', 'active', 18, 'ILS', 'IL'),
  ('a1160000-0000-4000-8000-000000000002', 'P116 tenant B', 'active', 18, 'ILS', 'IL');

insert into auth.users (id, email) values
  ('b1160000-0000-4000-8000-000000000001', 'p116-owner-a@example.test'),
  ('b1160000-0000-4000-8000-000000000002', 'p116-accountant-a@example.test'),
  ('b1160000-0000-4000-8000-000000000003', 'p116-office-a@example.test'),
  ('b1160000-0000-4000-8000-000000000011', 'p116-owner-b@example.test'),
  ('b1160000-0000-4000-8000-000000000012', 'p116-accountant-b@example.test');

insert into public.profiles (id, org_id, full_name, role, active) values
  ('b1160000-0000-4000-8000-000000000001', 'a1160000-0000-4000-8000-000000000001', 'P116 owner A', 'owner', true),
  ('b1160000-0000-4000-8000-000000000002', 'a1160000-0000-4000-8000-000000000001', 'P116 accountant A', 'accountant', true),
  ('b1160000-0000-4000-8000-000000000003', 'a1160000-0000-4000-8000-000000000001', 'P116 office A', 'office', true),
  ('b1160000-0000-4000-8000-000000000011', 'a1160000-0000-4000-8000-000000000002', 'P116 owner B', 'owner', true),
  ('b1160000-0000-4000-8000-000000000012', 'a1160000-0000-4000-8000-000000000002', 'P116 accountant B', 'accountant', true);

insert into p116.actors (actor, user_id, note) values
  ('owner_a',      'b1160000-0000-4000-8000-000000000001', 'the role with an audit surface'),
  ('accountant_a', 'b1160000-0000-4000-8000-000000000002', 'the finding: reads rows they are the subject of none of'),
  ('office_a',     'b1160000-0000-4000-8000-000000000003', 'reads no audit row at all, before and after'),
  ('owner_b',      'b1160000-0000-4000-8000-000000000011', 'another tenant''s owner'),
  ('accountant_b', 'b1160000-0000-4000-8000-000000000012', 'another tenant''s accountant');

-- Creating a profile already grants it the organisation root, and the closure expands that to
-- every unit — measured in `p101`. So both readers of tenant A carry the SAME scopes, and any
-- difference between what they read is a difference of ROLE, not of scope. Asserted rather than
-- assumed, because the whole comparison below rests on it.
select p116.assert(
  (select coalesce(array_length(closure.unit_ids, 1), 0) > 0
     from public.user_scope_closure closure
    where closure.org_id = 'a1160000-0000-4000-8000-000000000001'
      and closure.user_id = 'b1160000-0000-4000-8000-000000000002'),
  'the accountant has no scopes, so a row they cannot read would prove nothing about their role');
select p116.assert(
  (select owner_closure.unit_ids @> accountant_closure.unit_ids
      and accountant_closure.unit_ids @> owner_closure.unit_ids
     from public.user_scope_closure owner_closure, public.user_scope_closure accountant_closure
    where owner_closure.org_id = 'a1160000-0000-4000-8000-000000000001'
      and owner_closure.user_id = 'b1160000-0000-4000-8000-000000000001'
      and accountant_closure.org_id = 'a1160000-0000-4000-8000-000000000001'
      and accountant_closure.user_id = 'b1160000-0000-4000-8000-000000000002'),
  'the owner and the accountant of tenant A do not hold the same scopes, so the comparison below would measure scope rather than role');

-- ===== The rows under test =====
--
-- Written the way production writes them: `0293`'s trigger on `auth.users`, inside GoTrue's own
-- transaction. Nothing here inserts a `password_changed` row by hand.

update auth.users set encrypted_password = 'p116-hash-owner-a'
 where id = 'b1160000-0000-4000-8000-000000000001';
update auth.users set encrypted_password = 'p116-hash-accountant-a'
 where id = 'b1160000-0000-4000-8000-000000000002';
update auth.users set encrypted_password = 'p116-hash-office-a'
 where id = 'b1160000-0000-4000-8000-000000000003';
update auth.users set encrypted_password = 'p116-hash-owner-b'
 where id = 'b1160000-0000-4000-8000-000000000011';

insert into p116.ledger_rows (row_key, audit_id, note)
select 'pw_owner_a', entry.id, 'password change of tenant A''s owner'
  from public.audit_logs entry
 where entry.action = 'password_changed'
   and entry.entity_id = 'b1160000-0000-4000-8000-000000000001'
union all
select 'pw_accountant_a', entry.id, 'password change of tenant A''s accountant — their OWN record'
  from public.audit_logs entry
 where entry.action = 'password_changed'
   and entry.entity_id = 'b1160000-0000-4000-8000-000000000002'
union all
select 'pw_office_a', entry.id, 'password change of tenant A''s office user'
  from public.audit_logs entry
 where entry.action = 'password_changed'
   and entry.entity_id = 'b1160000-0000-4000-8000-000000000003'
union all
select 'pw_owner_b', entry.id, 'password change of tenant B''s owner — cross-tenant'
  from public.audit_logs entry
 where entry.action = 'password_changed'
   and entry.entity_id = 'b1160000-0000-4000-8000-000000000011';

-- Four writes, four rows, one each: if `0293` had written two for one change (or none) every
-- assertion below would be about the wrong row.
select p116.assert(
  (select count(*) = 4 from p116.ledger_rows),
  'the four password changes did not produce exactly four ledger rows to test against');
select p116.assert(
  (select bool_and(entry.scope_class = 'cross_scope'
               and entry.scope_domain = 'organization_identity_platform')
     from public.audit_logs entry
     join p116.ledger_rows fixture on fixture.audit_id = entry.id),
  'a password row did not take the auth.users audit scope, so it is not the row PERM-02 is about');

-- The controls. Both are `cross_scope`, one per domain, so between them they exercise the two
-- branches of `audit_select` that a careless rewrite would drop.
insert into public.audit_logs (id, org_id, user_id, action, entity_type, entity_id, reason) values
  ('c1160000-0000-4000-8000-000000000001', 'a1160000-0000-4000-8000-000000000001',
   'b1160000-0000-4000-8000-000000000001', 'update', 'profiles',
   'b1160000-0000-4000-8000-000000000001', 'P116 identity control, tenant A'),
  ('c1160000-0000-4000-8000-000000000002', 'a1160000-0000-4000-8000-000000000002',
   'b1160000-0000-4000-8000-000000000011', 'update', 'profiles',
   'b1160000-0000-4000-8000-000000000011', 'P116 identity control, tenant B'),
  ('c1160000-0000-4000-8000-000000000003', 'a1160000-0000-4000-8000-000000000001',
   'b1160000-0000-4000-8000-000000000001', 'update', 'bank_imports',
   'c1160000-0000-4000-8000-000000000003', 'P116 financial control, tenant A');

insert into p116.ledger_rows (row_key, audit_id, note) values
  ('identity_control_a',  'c1160000-0000-4000-8000-000000000001',
   'CONTROL — an identity row in the reader''s own tenant, the same class as a password row'),
  ('identity_control_b',  'c1160000-0000-4000-8000-000000000002',
   'CONTROL — the same row in another tenant'),
  ('financial_control_a', 'c1160000-0000-4000-8000-000000000003',
   'CONTROL — a financial cross-scope row, reachable only through the root-scope branch');

select p116.assert(
  (select scope_domain = 'organization_identity_platform' and scope_class = 'cross_scope'
     from public.audit_logs where id = 'c1160000-0000-4000-8000-000000000001'),
  'the identity control did not land in the identity branch, so it controls nothing');
select p116.assert(
  (select scope_domain = 'financial_accounting' and scope_class = 'cross_scope'
     from public.audit_logs where id = 'c1160000-0000-4000-8000-000000000003'),
  'the financial control did not land in the financial cross-scope branch, so it controls nothing');

-- ===== The reads, one actor at a time, each as `authenticated` with that person's own subject =====

select set_config('request.jwt.claim.sub', 'b1160000-0000-4000-8000-000000000001', false);
select set_config('request.jwt.claims',
  '{"sub":"b1160000-0000-4000-8000-000000000001","role":"authenticated"}', false);
set role authenticated;
insert into p116.reads (actor, row_key, visible)
select 'owner_a', fixture.row_key,
       exists (select 1 from public.audit_log_read_model v where v.id = fixture.audit_id)
  from p116.ledger_rows fixture;
reset role;

select set_config('request.jwt.claim.sub', 'b1160000-0000-4000-8000-000000000002', false);
select set_config('request.jwt.claims',
  '{"sub":"b1160000-0000-4000-8000-000000000002","role":"authenticated"}', false);
set role authenticated;
insert into p116.reads (actor, row_key, visible)
select 'accountant_a', fixture.row_key,
       exists (select 1 from public.audit_log_read_model v where v.id = fixture.audit_id)
  from p116.ledger_rows fixture;
reset role;

select set_config('request.jwt.claim.sub', 'b1160000-0000-4000-8000-000000000003', false);
select set_config('request.jwt.claims',
  '{"sub":"b1160000-0000-4000-8000-000000000003","role":"authenticated"}', false);
set role authenticated;
insert into p116.reads (actor, row_key, visible)
select 'office_a', fixture.row_key,
       exists (select 1 from public.audit_log_read_model v where v.id = fixture.audit_id)
  from p116.ledger_rows fixture;
reset role;

select set_config('request.jwt.claim.sub', 'b1160000-0000-4000-8000-000000000011', false);
select set_config('request.jwt.claims',
  '{"sub":"b1160000-0000-4000-8000-000000000011","role":"authenticated"}', false);
set role authenticated;
insert into p116.reads (actor, row_key, visible)
select 'owner_b', fixture.row_key,
       exists (select 1 from public.audit_log_read_model v where v.id = fixture.audit_id)
  from p116.ledger_rows fixture;
reset role;

select set_config('request.jwt.claim.sub', 'b1160000-0000-4000-8000-000000000012', false);
select set_config('request.jwt.claims',
  '{"sub":"b1160000-0000-4000-8000-000000000012","role":"authenticated"}', false);
set role authenticated;
insert into p116.reads (actor, row_key, visible)
select 'accountant_b', fixture.row_key,
       exists (select 1 from public.audit_log_read_model v where v.id = fixture.audit_id)
  from p116.ledger_rows fixture;
reset role;

select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '', false);

-- ===== What each of them must see =====

insert into p116.expectations (actor, row_key, expected, is_control, note) values
  -- THE FINDING. The accountant is the subject of none of these and reads none of them.
  ('accountant_a', 'pw_owner_a',          false, false, 'PERM-02: the accountant reads the owner''s password change'),
  ('accountant_a', 'pw_office_a',         false, false, 'PERM-02: and a colleague''s'),
  ('accountant_a', 'pw_owner_b',          false, false, 'cross-tenant: another tenant''s password change'),
  -- THE SUBJECT still reads their own record. Without this the fix is "nobody but the owner".
  ('accountant_a', 'pw_accountant_a',     true,  false, 'the subject reads their OWN record'),
  ('accountant_a', 'identity_control_a',  true,  true,  'CONTROL: the identity ledger is not narrowed'),
  ('accountant_a', 'financial_control_a', true,  true,  'CONTROL: the financial cross-scope branch survives'),
  ('accountant_a', 'identity_control_b',  false, true,  'CONTROL: another tenant is still another tenant'),

  -- THE AUDIT SURFACE. Narrowing a scope is exactly the change that quietly breaks the screen it
  -- was meant to protect, so the owner is asserted on every row of its own tenant.
  ('owner_a', 'pw_owner_a',          true,  true,  'CONTROL: the owner reads its own tenant''s password rows'),
  ('owner_a', 'pw_accountant_a',     true,  false, 'the audit surface still reads what it must'),
  ('owner_a', 'pw_office_a',         true,  false, 'the audit surface still reads what it must'),
  ('owner_a', 'identity_control_a',  true,  true,  'CONTROL'),
  ('owner_a', 'financial_control_a', true,  true,  'CONTROL'),
  ('owner_a', 'pw_owner_b',          false, true,  'CONTROL: cross-tenant'),
  ('owner_a', 'identity_control_b',  false, true,  'CONTROL: cross-tenant'),

  -- THE SAME NARROWING IN THE OTHER TENANT, so the rule is a rule and not a fixture accident.
  ('owner_b', 'pw_owner_b',          true,  false, 'subject AND audit surface'),
  ('owner_b', 'pw_owner_a',          false, true,  'CONTROL: cross-tenant'),
  ('owner_b', 'identity_control_b',  true,  true,  'CONTROL'),
  ('owner_b', 'identity_control_a',  false, true,  'CONTROL: cross-tenant'),
  ('accountant_b', 'pw_owner_b',     false, false, 'tenant B''s accountant is the subject of none of it either'),
  ('accountant_b', 'pw_owner_a',     false, true,  'CONTROL: cross-tenant'),
  ('accountant_b', 'identity_control_b', true, true, 'CONTROL'),

  -- THE ROLE THIS CHANGE MUST NOT WIDEN. `office` reads no audit row at all — including the one it
  -- is the subject of. That is the state before AND after: a subject clause that handed office a
  -- read it never had would be a privilege leak wearing this finding's own words.
  ('office_a', 'pw_office_a',         false, true, 'CONTROL: office reads no audit row, not even its own'),
  ('office_a', 'pw_owner_a',          false, true, 'CONTROL'),
  ('office_a', 'identity_control_a',  false, true, 'CONTROL'),
  ('office_a', 'financial_control_a', false, true, 'CONTROL');

do $report$
declare
  v_lines text;
  v_rollcall text;
  v_pass integer;
  v_total integer;
  v_control_pass integer;
  v_control_total integer;
begin
  -- THE ROLL-CALL, printed before the verdict and in BOTH runs. The verdict below names only the
  -- pairs that DISAGREED, so on a red run the pairs that agreed are invisible and "the controls
  -- were green" would be an inference drawn from an absence. This prints every expected/observed
  -- pair with its own PASS/FAIL, so a red that is really a broken harness -- which shows up as the
  -- CONTROLS failing beside the finding -- is told apart from a real one in the same output.
  select string_agg(
           format('  %-4s %-13s %-20s expected %-5s read %-18s %s%s',
                  case when observed.visible is not distinct from expectation.expected
                       then 'PASS' else 'FAIL' end,
                  expectation.actor, expectation.row_key,
                  expectation.expected::text,
                  coalesce(observed.visible::text, '(no read recorded)'),
                  case when expectation.is_control then '[control] ' else '' end,
                  expectation.note),
           chr(10) order by expectation.actor, expectation.row_key)
    into v_rollcall
  from p116.expectations expectation
  left join p116.reads observed
    on observed.actor = expectation.actor and observed.row_key = expectation.row_key;

  select count(*) filter (where observed.visible is not distinct from expectation.expected),
         count(*),
         count(*) filter (where expectation.is_control
                            and observed.visible is not distinct from expectation.expected),
         count(*) filter (where expectation.is_control)
    into v_pass, v_total, v_control_pass, v_control_total
  from p116.expectations expectation
  left join p116.reads observed
    on observed.actor = expectation.actor and observed.row_key = expectation.row_key;

  raise notice e'P116 roll-call, every expected/observed pair:\n%', v_rollcall;
  raise notice 'P116 tally: % of % pairs pass; of those, % of % controls pass.',
    v_pass, v_total, v_control_pass, v_control_total;

  select string_agg(
           format('  %-13s %-20s expected %-5s read %-18s %s%s',
                  expectation.actor, expectation.row_key,
                  expectation.expected::text,
                  coalesce(observed.visible::text, '(no read recorded)'),
                  case when expectation.is_control then '[control] ' else '' end,
                  expectation.note),
           chr(10) order by expectation.actor, expectation.row_key)
    into v_lines
  from p116.expectations expectation
  left join p116.reads observed
    on observed.actor = expectation.actor and observed.row_key = expectation.row_key
  where observed.visible is distinct from expectation.expected;

  if v_lines is not null then
    raise exception e'P116 failed — a password_changed row is not the holder''s own record:\n%',
      v_lines;
  end if;
end
$report$;

-- AND NOTHING ELSE NARROWED. Every audit row of tenant A that the owner can read, and that is not
-- a password change the accountant is not the subject of, must ALSO be readable by the accountant.
-- The two hold identical scopes (asserted at the top), so any other difference between them is a
-- narrowing this change did not intend and did not declare.
create table p116.owner_sees (audit_id uuid primary key);
create table p116.accountant_sees (audit_id uuid primary key);
grant insert on p116.owner_sees, p116.accountant_sees to authenticated;

select set_config('request.jwt.claim.sub', 'b1160000-0000-4000-8000-000000000001', false);
select set_config('request.jwt.claims',
  '{"sub":"b1160000-0000-4000-8000-000000000001","role":"authenticated"}', false);
set role authenticated;
insert into p116.owner_sees (audit_id)
select v.id from public.audit_log_read_model v
 where v.org_id = 'a1160000-0000-4000-8000-000000000001';
reset role;

select set_config('request.jwt.claim.sub', 'b1160000-0000-4000-8000-000000000002', false);
select set_config('request.jwt.claims',
  '{"sub":"b1160000-0000-4000-8000-000000000002","role":"authenticated"}', false);
set role authenticated;
insert into p116.accountant_sees (audit_id)
select v.id from public.audit_log_read_model v
 where v.org_id = 'a1160000-0000-4000-8000-000000000001';
reset role;

select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claims', '', false);

select p116.assert(
  (select count(*) > 0 from p116.owner_sees),
  'the owner read nothing at all from its own tenant, so the difference below is meaningless');
select p116.assert(
  not exists (
    select 1 from p116.accountant_sees extra
    where not exists (select 1 from p116.owner_sees seen where seen.audit_id = extra.audit_id)),
  'the accountant reads a tenant-A audit row the owner does not — the policy was widened, not narrowed');

do $difference$
declare
  v_unexpected text;
begin
  -- The set the accountant lost must be EXACTLY the two password rows they are not the subject of.
  -- Anything else in it is collateral damage from a conjunct that was supposed to name one action.
  select string_agg(format('  %s  action=%s  entity_type=%s  user_id=%s',
                           entry.id, entry.action, entry.entity_type, entry.user_id),
                    chr(10) order by entry.created_at, entry.id)
    into v_unexpected
  from p116.owner_sees seen
  join public.audit_logs entry on entry.id = seen.audit_id
  where not exists (select 1 from p116.accountant_sees mine where mine.audit_id = seen.audit_id)
    and not (entry.action = 'password_changed'
             and entry.user_id <> 'b1160000-0000-4000-8000-000000000002');

  if v_unexpected is not null then
    raise exception e'P116 failed — 0323 took rows away from the accountant that it never named:\n%',
      v_unexpected;
  end if;

  -- And it really did take the two it named. Named per row, not counted.
  if exists (select 1 from p116.accountant_sees mine
             join p116.ledger_rows fixture on fixture.audit_id = mine.audit_id
             where fixture.row_key in ('pw_owner_a', 'pw_office_a')) then
    raise exception 'P116 failed — the accountant still reads a password row they are the subject of none of';
  end if;
end
$difference$;

drop schema p116 cascade;

select 'p116_a_password_change_is_the_holders_own_record_passed' as result;
