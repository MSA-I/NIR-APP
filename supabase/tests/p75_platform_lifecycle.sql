-- P75 -- Platform lifecycle: the suspension-reason split (#20), abandoned self-signup handling
-- (#175) and the offboarding purge executor (#261). Run only against an isolated local database
-- with every migration applied. The transaction is rolled back.
--
-- BLAST RADIUS. Sections 3 and 5 execute deletion code. Every organization they touch is
-- created inside this transaction, every id is asserted to be a fixture id before anything is
-- deleted, and the whole file rolls back. There is no path in this file that can reach a row it
-- did not create.
--
-- What it proves:
--   (1) #20 -- the operator's internal commercial note is unreachable from the tenant through
--       audit, through any public table at all, through the export registry or through a
--       notification, while actor/time/public reason survive; a cross-tenant note does not
--       cross; and the check DETECTS a body that stops redacting (the p3 mutation idiom).
--   (3) #175 -- the report writes nothing, the emptiness predicate fails safe for a table
--       nobody classified, one row of any evidence class blocks deletion, the cleanup re-checks
--       under lock inside the deleting transaction, quarantine is never auto-deleted, the
--       retained audit carries no raw PII, and no code path can record a successful reminder
--       send while no provider is configured.
--   (5) #261 -- four gates with four independent negatives, legal hold fails closed, execution
--       replays the approved manifest rather than re-running the candidate query, each tenant is
--       re-locked and re-checked, deletion is staged from the live foreign-key graph and leaves
--       no orphan, the manifest is append-only, and no clock-only path reaches the executor.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p75_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P75 platform lifecycle assertion failed: %', p_message;
  end if;
end
$$;

-- The session-identity helper every platform suite uses (p50:17-33). `p_fresh_password` mints
-- the AMR shape assert_recent_password_authentication() (0061) demands.
create function pg_temp.p75_as(p_user uuid, p_fresh_password boolean default false)
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

-- Does ANY public table hold a row for this organization whose text contains the needle? This
-- is the export/notification question asked directly rather than by naming the tables somebody
-- remembered. It runs with full privilege on purpose: a projection that RLS happens to hide
-- today is still a leak the moment a policy widens, and the tenant export runs privileged.
create function pg_temp.p75_public_rows_containing(p_org_id uuid, p_needle text)
returns setof text
language plpgsql
as $$
declare
  v_table record;
  v_hits  bigint;
  v_cols  text;
begin
  for v_table in
    select c.relname::text as table_name
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and exists (
        select 1 from pg_catalog.pg_attribute a
        where a.attrelid = c.oid and a.attname = 'org_id'
          and a.attnum > 0 and not a.attisdropped)
    order by c.relname
  loop
    select string_agg(format('coalesce(%I::text, %L)', a.attname, ''), ' || ')
      into v_cols
    from pg_catalog.pg_attribute a
    where a.attrelid = format('public.%I', v_table.table_name)::regclass
      and a.attnum > 0 and not a.attisdropped;
    execute format(
      'select count(*) from public.%I where org_id = $1 and (%s) like $2',
      v_table.table_name, v_cols)
      into v_hits using p_org_id, '%' || p_needle || '%';
    if v_hits > 0 then
      return next v_table.table_name;
    end if;
  end loop;
end
$$;

-- =====================================================================================
-- (1) #20 -- the suspension reason is split
-- =====================================================================================

-- ===== Fixture =====
insert into auth.users (id, email) values
  ('76000000-0000-4000-8000-000000000001', 'p75-owner-a@example.test'),
  ('76000000-0000-4000-8000-000000000002', 'p75-accountant-a@example.test'),
  ('76000000-0000-4000-8000-000000000003', 'p75-operator@example.test'),
  ('76000000-0000-4000-8000-000000000004', 'p75-owner-b@example.test'),
  ('76000000-0000-4000-8000-000000000005', 'p75-office-a@example.test');

insert into public.organizations (id, name, status) values
  ('75000000-0000-4000-8000-000000000001', 'P75 tenant A', 'active'),
  ('75000000-0000-4000-8000-000000000002', 'P75 tenant B', 'active');

insert into public.profiles (id, org_id, full_name, role) values
  ('76000000-0000-4000-8000-000000000001', '75000000-0000-4000-8000-000000000001', 'P75 owner A', 'owner'),
  ('76000000-0000-4000-8000-000000000002', '75000000-0000-4000-8000-000000000001', 'P75 accountant A', 'accountant'),
  ('76000000-0000-4000-8000-000000000005', '75000000-0000-4000-8000-000000000001', 'P75 office A', 'office'),
  ('76000000-0000-4000-8000-000000000004', '75000000-0000-4000-8000-000000000002', 'P75 owner B', 'owner');

insert into public.platform_admins (user_id, note) values
  ('76000000-0000-4000-8000-000000000003', 'P75 operator');
insert into public.platform_admin_roles (user_id, role_key) values
  ('76000000-0000-4000-8000-000000000003', 'super_admin');

-- ===== A2 -- the internal note's storage is Shape-2, structurally =====
select pg_temp.p75_assert(
  (select relrowsecurity from pg_catalog.pg_class c
   join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'private' and c.relname = 'organization_lifecycle_internal_notes'),
  'A2: row level security is not enabled on the internal-note table');
select pg_temp.p75_assert(
  not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'private' and tablename = 'organization_lifecycle_internal_notes'),
  'A2: a policy appeared on the internal-note table -- Shape-2 means no policies at all');
select pg_temp.p75_assert(
  not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'private'
      and table_name in ('organization_lifecycle_internal_notes',
                         'organization_lifecycle_reason_codes')
      and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')),
  'A2: a browser or service role holds a grant on the internal-note storage');

-- ===== A3 (structural half) -- the note is not an export surface =====
select pg_temp.p75_assert(
  not exists (
    select 1 from private.tenant_export_registry
    where table_name in ('organization_lifecycle_internal_notes',
                         'organization_lifecycle_reason_codes')),
  'A3: the internal-note storage was classified for tenant export');
-- The export enumerates public tables carrying org_id (0103:322-338). Storage in `private` is
-- therefore not a judgement a future reviewer can get wrong -- assert it stayed there.
select pg_temp.p75_assert(
  not exists (
    select 1 from information_schema.tables
    where table_schema = 'public'
      and table_name = 'organization_lifecycle_internal_notes'),
  'A3: the internal-note table moved into public, where the export enumeration can reach it');

-- ===== The operator suspends with a split reason, then reinstates =====
-- MEASURED: while an organization is suspended auth_org() returns null, so the tenant reads
-- nothing at all. The leak this section closes only becomes reachable on reactivation, which is
-- why the fixture reinstates before it reads.
select pg_temp.p75_as('76000000-0000-4000-8000-000000000003', true);
select public.set_organization_lifecycle(
  p_org_id => '75000000-0000-4000-8000-000000000001',
  p_status => 'suspended',
  p_trial_ends_at => null,
  p_reason => 'התשלום לא הוסדר',
  p_internal_note => 'unpaid bill 4417 -- chasing collection, CEO says do not extend credit');

-- A6 setup: a note about tenant B, written in the same operator session.
select public.set_organization_lifecycle(
  p_org_id => '75000000-0000-4000-8000-000000000002',
  p_status => 'suspended',
  p_trial_ends_at => null,
  p_reason => 'התשלום לא הוסדר',
  p_internal_note => 'tenant B margin note -- undercutting us on price');
select public.set_organization_lifecycle(
  p_org_id => '75000000-0000-4000-8000-000000000002',
  p_status => 'active',
  p_trial_ends_at => null,
  p_reason => 'הוסדר');

select public.set_organization_lifecycle(
  p_org_id => '75000000-0000-4000-8000-000000000001',
  p_status => 'active',
  p_trial_ends_at => null,
  p_reason => 'הוסדר מול הלקוח',
  p_internal_note => 'payment plan agreed -- do not extend credit beyond 30 days');
select pg_temp.p75_as(null);

-- ===== A5 -- actor, time and a non-null public reason survive =====
select pg_temp.p75_assert(
  (select count(*) from public.audit_logs
   where action = 'organization_lifecycle_changed'
     and org_id in ('75000000-0000-4000-8000-000000000001',
                    '75000000-0000-4000-8000-000000000002')
     and user_id = '76000000-0000-4000-8000-000000000003'
     and created_at is not null
     and coalesce(trim(reason), '') <> ''
     and new_values ? 'public_reason_code') = 4,
  'A5: a lifecycle row lost its actor, its time, its public reason or its public reason code');

-- The reason code is a controlled vocabulary, not free text.
select pg_temp.p75_assert(
  not exists (
    select 1 from public.audit_logs a
    where a.action = 'organization_lifecycle_changed'
      and a.org_id = '75000000-0000-4000-8000-000000000001'
      and not exists (
        select 1 from private.organization_lifecycle_reason_codes code
        where code.reason_code = a.new_values ->> 'public_reason_code')),
  'A5: a lifecycle row carries a public reason code that is not in the vocabulary');

do $$
begin
  perform set_config('request.jwt.claim.sub', '76000000-0000-4000-8000-000000000003', true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', '76000000-0000-4000-8000-000000000003',
    'amr', jsonb_build_array(jsonb_build_object(
      'method', 'password', 'timestamp', extract(epoch from clock_timestamp())))
  )::text, true);
  perform public.set_organization_lifecycle(
    p_org_id => '75000000-0000-4000-8000-000000000001',
    p_status => 'suspended',
    p_trial_ends_at => null,
    p_reason => '   ',
    p_internal_note => 'the note must not be able to stand in for the public reason');
  raise exception 'A5: a lifecycle change with a blank public reason was accepted';
exception when sqlstate '22023' then
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
end
$$;

do $$
begin
  perform set_config('request.jwt.claim.sub', '76000000-0000-4000-8000-000000000003', true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', '76000000-0000-4000-8000-000000000003',
    'amr', jsonb_build_array(jsonb_build_object(
      'method', 'password', 'timestamp', extract(epoch from clock_timestamp())))
  )::text, true);
  perform public.set_organization_lifecycle(
    p_org_id => '75000000-0000-4000-8000-000000000001',
    p_status => 'suspended',
    p_trial_ends_at => null,
    p_reason => 'a reason',
    p_public_reason_code => 'invented_on_the_spot',
    p_internal_note => null);
  raise exception 'A5: an unregistered public reason code was accepted';
exception when sqlstate '22023' then
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
end
$$;

-- ===== A1 -- the tenant reads the public half and nothing of the internal half =====
create function pg_temp.p75_tenant_sees_note(p_user uuid, p_needle text)
returns bigint language plpgsql as $$
declare v_hits bigint;
begin
  perform pg_temp.p75_as(p_user);
  set local role authenticated;
  select count(*) into v_hits from public.audit_logs
  where coalesce(reason, '') like '%' || p_needle || '%'
     or coalesce(old_values::text, '') like '%' || p_needle || '%'
     or coalesce(new_values::text, '') like '%' || p_needle || '%';
  reset role;
  perform pg_temp.p75_as(null);
  return v_hits;
end
$$;

select pg_temp.p75_assert(
  pg_temp.p75_tenant_sees_note(
    '76000000-0000-4000-8000-000000000001', 'do not extend credit') = 0,
  'A1: the tenant OWNER can read the operator internal commercial note in audit_logs');
select pg_temp.p75_assert(
  pg_temp.p75_tenant_sees_note(
    '76000000-0000-4000-8000-000000000002', 'do not extend credit') = 0,
  'A1: the tenant ACCOUNTANT can read the operator internal commercial note in audit_logs');
select pg_temp.p75_assert(
  pg_temp.p75_tenant_sees_note(
    '76000000-0000-4000-8000-000000000005', 'do not extend credit') = 0,
  'A1: the tenant OFFICE user can read the operator internal commercial note in audit_logs');

-- ...and the public half really is there, so the split did not simply delete the reason.
select pg_temp.p75_assert(
  pg_temp.p75_tenant_sees_note(
    '76000000-0000-4000-8000-000000000001', 'הוסדר מול הלקוח') = 1,
  'A1: the tenant OWNER cannot read the public reason -- the split removed it instead of '
  || 'splitting it');

-- ===== A3/A4 -- no public table anywhere holds the note, for either tenant =====
select pg_temp.p75_assert(
  not exists (
    select 1 from pg_temp.p75_public_rows_containing(
      '75000000-0000-4000-8000-000000000001', 'do not extend credit')),
  'A3/A4: a public table (export or notification surface) holds the internal note for tenant A');
select pg_temp.p75_assert(
  not exists (
    select 1 from pg_temp.p75_public_rows_containing(
      '75000000-0000-4000-8000-000000000002', 'undercutting us on price')),
  'A3/A4: a public table holds the internal note for tenant B');
select pg_temp.p75_assert(
  (select count(*) from public.notifications
   where coalesce(title, '') || coalesce(body, '') like '%do not extend credit%') = 0,
  'A4: a notification carries the internal note');

-- ===== A6 -- the note does not cross tenants =====
select pg_temp.p75_assert(
  (select count(*) from private.organization_lifecycle_internal_notes
   where org_id = '75000000-0000-4000-8000-000000000001'
     and internal_note like '%undercutting us on price%') = 0
  and (select count(*) from private.organization_lifecycle_internal_notes
   where org_id = '75000000-0000-4000-8000-000000000002'
     and internal_note like '%do not extend credit%') = 0,
  'A6: an internal note was filed under the wrong organization');

-- Every note is filed under the organization row the command locked, and to a lifecycle audit
-- row belonging to that same organization -- a mismatched p_org_id cannot separate them.
select pg_temp.p75_assert(
  not exists (
    select 1 from private.organization_lifecycle_internal_notes note
    join public.audit_logs a on a.id = note.audit_log_id
    where a.org_id is distinct from note.org_id),
  'A6: an internal note points at an audit row belonging to another organization');

-- The Platform reader is the only door, and it is closed to a tenant owner.
select pg_temp.p75_as('76000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.p75_assert(
  (select count(*) from public.platform_organization_lifecycle_notes(
     '75000000-0000-4000-8000-000000000001')) = 0,
  'A6: a tenant owner read the internal notes through the platform reader');
do $$
begin
  perform (select count(*) from private.organization_lifecycle_internal_notes);
  raise exception 'A2: a tenant owner read the internal-note table directly';
exception when insufficient_privilege then null;
end
$$;
reset role;

select pg_temp.p75_as('76000000-0000-4000-8000-000000000003');
set local role authenticated;
select pg_temp.p75_assert(
  (select count(*) from public.platform_organization_lifecycle_notes(
     '75000000-0000-4000-8000-000000000001')) = 2,
  'the Platform operator cannot read the internal notes it just wrote');
select pg_temp.p75_assert(
  (select count(*) from public.platform_organization_lifecycle_notes(
     '75000000-0000-4000-8000-000000000001')
   where internal_note like '%undercutting us on price%') = 0,
  'A6: the platform reader returned another tenant''s note under this organization');
reset role;
select pg_temp.p75_as(null);

-- ===== A7 -- the check DETECTS a body that stops redacting (the p3 mutation idiom) =====
savepoint mutation_a1;
do $mutate$
declare v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_catalog.pg_proc p
  where p.oid = 'public.set_organization_lifecycle(uuid,public.org_status,timestamptz,text,text,text)'::regprocedure;
  -- Put the internal note back into the tenant-readable reason, which is exactly what the live
  -- command did before 0195. If A1 does not turn red here, A1 is decorative.
  v_def := replace(replace(v_def, e'\r', ''),
    'v_reason' || E'\n' || '  ) returning id into v_audit_id;',
    'v_reason || '' | '' || coalesce(v_internal_note, '''')' || E'\n' || '  ) returning id into v_audit_id;');
  execute v_def;
end
$mutate$;

select pg_temp.p75_as('76000000-0000-4000-8000-000000000003', true);
select public.set_organization_lifecycle(
  p_org_id => '75000000-0000-4000-8000-000000000001',
  p_status => 'suspended',
  p_trial_ends_at => null,
  p_reason => 'mutation probe',
  p_internal_note => 'MUTATION do not extend credit');
select public.set_organization_lifecycle(
  p_org_id => '75000000-0000-4000-8000-000000000001',
  p_status => 'active',
  p_trial_ends_at => null,
  p_reason => 'mutation probe restore');
select pg_temp.p75_as(null);

select pg_temp.p75_assert(
  pg_temp.p75_tenant_sees_note(
    '76000000-0000-4000-8000-000000000001', 'MUTATION do not extend credit') > 0,
  'A7: a lifecycle command that copies the internal note into the tenant audit row was NOT '
  || 'detected -- A1 cannot fail, so it proves nothing');
rollback to savepoint mutation_a1;

-- ...and the redaction is back after the rollback.
select pg_temp.p75_assert(
  pg_temp.p75_tenant_sees_note(
    '76000000-0000-4000-8000-000000000001', 'MUTATION do not extend credit') = 0,
  'A7: the mutation survived its own rollback');


-- =====================================================================================
-- (3) #175 -- abandoned self-signup: report, emptiness, reminders, cleanup, quarantine
-- =====================================================================================

-- Every organization this section or section (5) may delete is recorded here first, and the
-- deleting helpers refuse an id that is not in it. Threat-model C8/E9: a test that can reach a
-- row it did not create is the single worst outcome in this file.
create table pg_temp.p75_fixture_orgs (org_id uuid primary key);

create function pg_temp.p75_service_claims()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
end
$$;

-- The containment latch. Nothing in this file deletes an organization without going through it.
create function pg_temp.p75_fixture_only(p_org_id uuid)
returns uuid language plpgsql as $$
begin
  if not exists (select 1 from pg_temp.p75_fixture_orgs where org_id = p_org_id) then
    raise exception 'P75 BLAST RADIUS: % was not created by this transaction', p_org_id;
  end if;
  return p_org_id;
end
$$;

insert into auth.users (id, email, email_confirmed_at) values
  ('76000000-0000-4000-8000-000000000011', 'ronit.abandoned@example.test', null),
  ('76000000-0000-4000-8000-000000000012', 'yossi.active@example.test',    null),
  ('76000000-0000-4000-8000-000000000013', 'dana.verified@example.test',   now()),
  ('76000000-0000-4000-8000-000000000014', 'noa.young@example.test',       null),
  ('76000000-0000-4000-8000-000000000026', 'class.notice@example.test',    null);


-- ===== Fixture =====
insert into public.organizations (id, name, status, created_at) values
  ('75000000-0000-4000-8000-000000000011', 'P75 abandoned empty',     'active', now() - interval '40 days'),
  ('75000000-0000-4000-8000-000000000012', 'P75 abandoned active',    'active', now() - interval '40 days'),
  ('75000000-0000-4000-8000-000000000013', 'P75 verified owner',      'active', now() - interval '40 days'),
  -- Younger than `private.abandoned_signup_grace()` (0287: 24 hours, a documented default
  -- pending an owner ruling). It was ten days while #175's window was thirty; #332 removed
  -- the password from the moment of signup, so an unconfirmed empty tenant is released in a
  -- day and ten days is now DUE rather than young.
  ('75000000-0000-4000-8000-000000000014', 'P75 young signup',        'active', now() - interval '2 hours'),
  ('75000000-0000-4000-8000-000000000021', 'P75 class catalogue',     'active', now() - interval '40 days'),
  ('75000000-0000-4000-8000-000000000022', 'P75 class product',       'active', now() - interval '40 days'),
  ('75000000-0000-4000-8000-000000000023', 'P75 class invitation',    'active', now() - interval '40 days'),
  ('75000000-0000-4000-8000-000000000024', 'P75 class collaboration', 'active', now() - interval '40 days'),
  ('75000000-0000-4000-8000-000000000025', 'P75 class procurement',   'active', now() - interval '40 days'),
  ('75000000-0000-4000-8000-000000000026', 'P75 class notice',        'active', now() - interval '40 days');

insert into pg_temp.p75_fixture_orgs (org_id)
select id from public.organizations
where id between '75000000-0000-4000-8000-000000000011'
              and '75000000-0000-4000-8000-000000000026';

insert into public.profiles (id, org_id, full_name, role, phone) values
  ('76000000-0000-4000-8000-000000000011', '75000000-0000-4000-8000-000000000011',
   'רונית אברהמי', 'owner', '050-1112223'),
  ('76000000-0000-4000-8000-000000000012', '75000000-0000-4000-8000-000000000012',
   'יוסי כהן', 'owner', '050-4445556'),
  ('76000000-0000-4000-8000-000000000013', '75000000-0000-4000-8000-000000000013',
   'דנה לוי', 'owner', '050-7778889'),
  ('76000000-0000-4000-8000-000000000014', '75000000-0000-4000-8000-000000000014',
   'נועה בר', 'owner', '050-1010101'),
  ('76000000-0000-4000-8000-000000000026', '75000000-0000-4000-8000-000000000026',
   'P75 notice owner', 'owner', null);

-- One row of one evidence class per organization, so a dropped class is visible as a named
-- failure rather than as a hole.
insert into public.suppliers (org_id, name) values
  ('75000000-0000-4000-8000-000000000012', 'P75 supplier of the active abandoned tenant'),
  ('75000000-0000-4000-8000-000000000021', 'P75 catalogue class supplier');
insert into public.products (org_id, name) values
  ('75000000-0000-4000-8000-000000000022', 'P75 product class row');
insert into public.invitations (org_id, email, role, token_hash, expires_at) values
  ('75000000-0000-4000-8000-000000000023', 'invited@example.test', 'office',
   repeat('a', 64), now() + interval '7 days');
insert into public.comments (org_id, entity_type, entity_id, body) values
  ('75000000-0000-4000-8000-000000000024', 'purchase_order',
   '75000000-0000-4000-8000-0000000000ff', 'P75 collaboration class row');
insert into public.purchase_requests (org_id) values
  ('75000000-0000-4000-8000-000000000025');
insert into public.notifications (org_id, user_id, event_code, entity_key, severity, title, body, target_url, dedupe_key) values
  ('75000000-0000-4000-8000-000000000026', '76000000-0000-4000-8000-000000000026',
   'p75.notice', 'p75', 'warning', 'P75 notice class row', 'body', '/p75', 'p75-dedupe');

-- ===== C1 -- the completeness sweep is quiet, and it FIRES when something is unclassified =====
--
-- C1 completeness sweep -- contamination exclusion.
--
-- These five tables exist in the shared local database only because migration 0183 is
-- applied to it. 0183 belongs to a concurrent program and exists in NO committed branch.
-- The exclusion exists solely so this assertion can be OBSERVED locally (see the mutation
-- proof below). It is INERT in CI, where a database built from committed migrations
-- contains none of them -- so C1 runs at full strength exactly where correctness is decided.
--
-- REMOVAL CONDITION: when 0183 merges, these five tables are classified in the emptiness
-- predicate like any other business table, or this exclusion is deleted.
--
-- Enumerated deliberately, one per line. NO wildcard, NO schema-level skip, NO pattern
-- match: a SIXTH object added by that program MUST make C1 fire.
select pg_temp.p75_assert(
  not exists (
    select 1 from private.org_activity_registry_violations() violation
    where violation.table_name not in (
      'global_rule_bindings',
      'global_rule_versions',
      'organization_rule_bindings',
      'organization_rule_versions',
      'rule_definitions'
    )),
  'C1: a public table carrying org_id is not classified in the activity-evidence registry: '
  || coalesce((
       select string_agg(violation.table_name, ', ' order by violation.table_name)
       from private.org_activity_registry_violations() violation
       where violation.table_name not in (
         'global_rule_bindings',
         'global_rule_versions',
         'organization_rule_bindings',
         'organization_rule_versions',
         'rule_definitions'
       )), ''));

savepoint mutation_c1;
create table public.p75_unclassified_business_table (
  id     uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade
);
select pg_temp.p75_assert(
  exists (
    select 1 from private.org_activity_registry_violations() violation
    where violation.table_name = 'p75_unclassified_business_table'),
  'C1: the completeness sweep did not name a business table that nobody classified');
insert into public.p75_unclassified_business_table (org_id)
values ('75000000-0000-4000-8000-000000000011');
select pg_temp.p75_assert(
  private.organization_has_business_activity('75000000-0000-4000-8000-000000000011'),
  'C1: an unclassified table did not count as evidence -- the predicate is not fail-safe');
do $$
begin
  perform pg_temp.p75_service_claims();
  perform public.service_cleanup_abandoned_signup(
    pg_temp.p75_fixture_only('75000000-0000-4000-8000-000000000011'));
  raise exception 'C1: an organization holding a row in an unclassified table was deleted';
exception when sqlstate '42501' then
  if sqlerrm not like '%has_activity%' then raise; end if;
end
$$;
rollback to savepoint mutation_c1;

select pg_temp.p75_assert(
  not exists (
    select 1 from private.org_activity_registry_violations() violation
    where violation.table_name not in (
      'global_rule_bindings',
      'global_rule_versions',
      'organization_rule_bindings',
      'organization_rule_versions',
      'rule_definitions'
    )),
  'C1: the sweep did not go quiet again after the mutation rolled back');

-- ===== C2 -- one row of any evidence class blocks deletion, class by class =====
create function pg_temp.p75_refuses_cleanup(p_org_id uuid, p_expect text)
returns boolean language plpgsql as $$
begin
  perform pg_temp.p75_service_claims();
  perform public.service_cleanup_abandoned_signup(pg_temp.p75_fixture_only(p_org_id));
  return false;
exception when others then
  -- A containment breach is never "a refusal" -- let it out.
  if sqlerrm like '%BLAST RADIUS%' then raise; end if;
  return sqlerrm like '%' || p_expect || '%';
end
$$;

select pg_temp.p75_assert(
  private.organization_has_business_activity('75000000-0000-4000-8000-000000000021')
  and pg_temp.p75_refuses_cleanup('75000000-0000-4000-8000-000000000021', 'has_activity'),
  'C2: a catalogue supplier row did not block deletion');
select pg_temp.p75_assert(
  private.organization_has_business_activity('75000000-0000-4000-8000-000000000022')
  and pg_temp.p75_refuses_cleanup('75000000-0000-4000-8000-000000000022', 'has_activity'),
  'C2: a product row did not block deletion');
select pg_temp.p75_assert(
  private.organization_has_business_activity('75000000-0000-4000-8000-000000000023')
  and pg_temp.p75_refuses_cleanup('75000000-0000-4000-8000-000000000023', 'has_activity'),
  'C2: an invitation row did not block deletion');
select pg_temp.p75_assert(
  private.organization_has_business_activity('75000000-0000-4000-8000-000000000024')
  and pg_temp.p75_refuses_cleanup('75000000-0000-4000-8000-000000000024', 'has_activity'),
  'C2: a collaboration comment row did not block deletion');
select pg_temp.p75_assert(
  private.organization_has_business_activity('75000000-0000-4000-8000-000000000025')
  and pg_temp.p75_refuses_cleanup('75000000-0000-4000-8000-000000000025', 'has_activity'),
  'C2: a procurement request row did not block deletion');
select pg_temp.p75_assert(
  private.organization_has_business_activity('75000000-0000-4000-8000-000000000026')
  and pg_temp.p75_refuses_cleanup('75000000-0000-4000-8000-000000000026', 'has_activity'),
  'C2: a notification row did not block deletion');

-- ...and the empty one really is empty, so the predicate is not simply always true.
select pg_temp.p75_assert(
  not private.organization_has_business_activity('75000000-0000-4000-8000-000000000011'),
  'C2: the empty organization was reported as having business activity -- the seven measured '
  || 'not_evidence classifications are wrong');

-- ===== C5 -- quarantine, never automatic deletion =====
select pg_temp.p75_assert(
  exists (
    select 1 from private.organization_quarantine_queue
    where org_id = '75000000-0000-4000-8000-000000000012' and resolved_at is null) = false,
  'C5: a quarantine row existed before anything tried to delete the active organization');
select pg_temp.p75_assert(
  pg_temp.p75_refuses_cleanup('75000000-0000-4000-8000-000000000012', 'has_activity'),
  'C5: an organization with business activity was deleted instead of quarantined');

-- The queue is filled by its own command, not on the refusal path: raising rolls back the
-- subtransaction, so a write on that path would disappear together with the refusal.
select pg_temp.p75_service_claims();
select pg_temp.p75_assert(
  public.service_quarantine_abandoned_signups(100) >= 1,
  'C5: the quarantine scan opened nothing for an organization it must not delete');
select pg_temp.p75_as(null);
select pg_temp.p75_assert(
  exists (
    select 1 from private.organization_quarantine_queue
    where org_id = '75000000-0000-4000-8000-000000000012'
      and reason_code = 'abandoned_signup_with_activity' and resolved_at is null),
  'C5: the quarantine scan did not open an entry for the active abandoned organization');
select pg_temp.p75_assert(
  not exists (
    select 1 from private.organization_quarantine_queue
    where org_id = '75000000-0000-4000-8000-000000000013'),
  'C5: the quarantine scan queued an organization whose owner is verified');
-- The queue command has no delete path at all.
select pg_temp.p75_assert(
  (select p.prosrc from pg_catalog.pg_proc p
   where p.oid = 'public.service_quarantine_abandoned_signups(integer)'::regprocedure)
    !~* '\mdelete\M',
  'C5: the quarantine command contains a delete');
select pg_temp.p75_assert(
  (select count(*) from public.organizations
   where id = '75000000-0000-4000-8000-000000000012') = 1,
  'C5: the quarantined organization was removed anyway');
-- org_status is untouched: quarantine is a queue, not a fourth value (#175 / contract 5b).
select pg_temp.p75_assert(
  (select status::text from public.organizations
   where id = '75000000-0000-4000-8000-000000000012') = 'active',
  'C5: quarantine changed the organization status');

-- ===== The other two refusals: a verified owner, and an organization that is not yet due =====
select pg_temp.p75_assert(
  pg_temp.p75_refuses_cleanup('75000000-0000-4000-8000-000000000013', 'owner_verified'),
  'an organization whose owner confirmed their address was deleted');
select pg_temp.p75_assert(
  pg_temp.p75_refuses_cleanup('75000000-0000-4000-8000-000000000014', 'not_due'),
  'an organization younger than private.abandoned_signup_grace() was deleted');

-- ===== C4 -- the report writes nothing, and is not reachable without the capability =====
select pg_temp.p75_assert(
  (select p.provolatile from pg_catalog.pg_proc p
   where p.oid = 'public.platform_abandoned_signup_candidates(integer)'::regprocedure) <> 'v',
  'C4: the candidate report is VOLATILE, so nothing structurally prevents it from writing');
select pg_temp.p75_assert(
  not exists (
    select 1 from information_schema.role_routine_grants
    where routine_schema = 'public'
      and routine_name = 'service_cleanup_abandoned_signup'
      and grantee in ('anon', 'authenticated')),
  'C4: a browser role can execute the cleanup command');

select pg_temp.p75_as('76000000-0000-4000-8000-000000000011');
set local role authenticated;
select pg_temp.p75_assert(
  (select count(*) from public.platform_abandoned_signup_candidates(30)) = 0
  and (select count(*) from public.platform_quarantine_queue()) = 0,
  'C4: a tenant owner read the abandoned-signup report or the quarantine queue');
reset role;

select pg_temp.p75_as('76000000-0000-4000-8000-000000000003');
set local role authenticated;
select pg_temp.p75_assert(
  (select count(*) from public.platform_abandoned_signup_candidates(30)
   where org_id = '75000000-0000-4000-8000-000000000011'
     and disposition = 'empty_cleanup_eligible') = 1,
  'C4: the operator report does not show the empty abandoned organization as cleanup eligible');
select pg_temp.p75_assert(
  (select count(*) from public.platform_abandoned_signup_candidates(30)
   where org_id = '75000000-0000-4000-8000-000000000012'
     and disposition = 'quarantine_required') = 1,
  'C4: the operator report does not show the active abandoned organization as quarantine only');
select pg_temp.p75_assert(
  (select count(*) from public.platform_abandoned_signup_candidates(30)
   where org_id in ('75000000-0000-4000-8000-000000000013',
                    '75000000-0000-4000-8000-000000000014')) = 0,
  'C4: the report listed a verified owner or an organization that is not yet due');
reset role;
select pg_temp.p75_as(null);

-- ===== C7 -- the reminder path is built and cannot record a success =====
select pg_temp.p75_assert(
  private.enqueue_abandoned_signup_reminders('75000000-0000-4000-8000-000000000011') = 2,
  'C7: the day-7 and three-days-before reminders were not enqueued');
select pg_temp.p75_assert(
  (select count(*) from private.abandoned_signup_reminders
   where org_id = '75000000-0000-4000-8000-000000000011'
     and reminder_kind = 'day_7'
     and due_at = (select created_at + interval '7 days' from public.organizations
                   where id = '75000000-0000-4000-8000-000000000011')) = 1
  and (select count(*) from private.abandoned_signup_reminders
   where org_id = '75000000-0000-4000-8000-000000000011'
     and reminder_kind = 'final_3_days'
     and due_at = (select created_at + interval '27 days' from public.organizations
                   where id = '75000000-0000-4000-8000-000000000011')) = 1,
  'C7: a reminder is not scheduled on the day #175 fixed');

-- No provider is configured (#236). The dispatch records a refusal, by name.
select pg_temp.p75_service_claims();
select pg_temp.p75_assert(
  (public.service_dispatch_abandoned_signup_reminder(
     (select id from private.abandoned_signup_reminders
      where org_id = '75000000-0000-4000-8000-000000000011' and reminder_kind = 'day_7'))
   ->> 'reason') = 'provider_unconfigured',
  'C7: the reminder dispatch did not refuse with provider_unconfigured');
select pg_temp.p75_assert(
  (select state from private.abandoned_signup_reminders
   where org_id = '75000000-0000-4000-8000-000000000011' and reminder_kind = 'day_7')
    = 'not_sent',
  'C7: a reminder reached a state other than not_sent while no provider exists');

-- Even WITH a provider handle present, this migration still has no send, and says so rather
-- than recording a delivery that did not happen.
select set_config('app.auth_email_provider', 'resend', true);
select pg_temp.p75_assert(
  (public.service_dispatch_abandoned_signup_reminder(
     (select id from private.abandoned_signup_reminders
      where org_id = '75000000-0000-4000-8000-000000000011' and reminder_kind = 'final_3_days'))
   ->> 'reason') = 'provider_send_not_implemented',
  'C7: with a provider handle present the dispatch claimed something other than "not implemented"');
select set_config('app.auth_email_provider', '', true);
select pg_temp.p75_as(null);

-- Structural: no routine anywhere writes the success state into the reminder ledger.
select pg_temp.p75_assert(
  not exists (
    select 1 from pg_catalog.pg_proc routine
    join pg_catalog.pg_namespace space on space.oid = routine.pronamespace
    where space.nspname in ('public', 'private')
      and routine.prosrc like '%abandoned_signup_reminders%'
      and routine.prosrc like '%''sent''%'),
  'C7: a routine can write the success state into the reminder ledger while no provider exists');

-- ...and the ledger itself refuses the success state without provider evidence.
do $$
begin
  update private.abandoned_signup_reminders
  set state = 'sent'
  where org_id = '75000000-0000-4000-8000-000000000011' and reminder_kind = 'day_7';
  raise exception 'C7: the ledger accepted a success state with no provider and no message id';
exception when check_violation then null;
end
$$;

-- The ledger stores no address (#173's disclosure rule).
select pg_temp.p75_assert(
  not exists (
    select 1 from private.abandoned_signup_reminders reminder
    where reminder.org_id = '75000000-0000-4000-8000-000000000011'
      and (coalesce(reminder.provider, '') || coalesce(reminder.provider_message_id, '')
           || coalesce(reminder.not_sent_reason, '')) like '%example.test%'),
  'C7: the reminder ledger holds an address');

-- ===== C3 -- the report is not an authorization: lock and re-check inside the delete =====
-- Structural first: the command locks the organization row before it re-derives anything.
select pg_temp.p75_assert(
  (select position('for update' in p.prosrc) from pg_catalog.pg_proc p
   where p.oid = 'public.service_cleanup_abandoned_signup(uuid)'::regprocedure) > 0
  and (select position('for update' in p.prosrc) < position('organization_has_business_activity' in p.prosrc)
       from pg_catalog.pg_proc p
       where p.oid = 'public.service_cleanup_abandoned_signup(uuid)'::regprocedure),
  'C3: the cleanup command re-checks activity before it takes the row lock, or does not lock');

-- Behavioural: the organization was reported eligible a moment ago. Activity arrives. The
-- delete must abort -- the earlier report does not authorize anything.
savepoint toctou;
select pg_temp.p75_as('76000000-0000-4000-8000-000000000003');
set local role authenticated;
select pg_temp.p75_assert(
  (select disposition from public.platform_abandoned_signup_candidates(30)
   where org_id = '75000000-0000-4000-8000-000000000011') = 'empty_cleanup_eligible',
  'C3: the fixture organization is not reported eligible, so the race cannot be staged');
reset role;
select pg_temp.p75_as(null);
insert into public.suppliers (org_id, name)
values ('75000000-0000-4000-8000-000000000011', 'P75 first supplier, added after the report');
select pg_temp.p75_assert(
  pg_temp.p75_refuses_cleanup('75000000-0000-4000-8000-000000000011', 'has_activity'),
  'C3: the delete proceeded on a report that was already stale');
select pg_temp.p75_assert(
  (select count(*) from public.organizations
   where id = '75000000-0000-4000-8000-000000000011') = 1,
  'C3: the organization was removed despite the aborted delete');
rollback to savepoint toctou;

-- ===== The cleanup itself, and C6 -- what survives carries no PII =====
select pg_temp.p75_assert(
  (select count(*) from public.profiles
   where org_id = '75000000-0000-4000-8000-000000000011') = 1
  and (select count(*) from public.org_units
   where org_id = '75000000-0000-4000-8000-000000000011') > 0,
  'the empty organization has no seeded rows, so the cleanup would prove nothing');

select pg_temp.p75_service_claims();
select pg_temp.p75_assert(
  (public.service_cleanup_abandoned_signup(
     pg_temp.p75_fixture_only('75000000-0000-4000-8000-000000000011')) ->> 'org_id')
    = '75000000-0000-4000-8000-000000000011',
  'the empty, unverified, over-thirty-day organization was not removed');
select pg_temp.p75_as(null);

select pg_temp.p75_assert(
  (select count(*) from public.organizations
   where id = '75000000-0000-4000-8000-000000000011') = 0
  and (select count(*) from public.profiles
   where org_id = '75000000-0000-4000-8000-000000000011') = 0
  and (select count(*) from public.org_units
   where org_id = '75000000-0000-4000-8000-000000000011') = 0
  and (select count(*) from public.audit_logs
   where org_id = '75000000-0000-4000-8000-000000000011') = 0,
  'the cleanup left rows behind');

-- The neighbours are untouched. A predicate that scans without anchoring on org_id would have
-- taken them with it.
select pg_temp.p75_assert(
  (select count(*) from public.organizations
   where id in ('75000000-0000-4000-8000-000000000012',
                '75000000-0000-4000-8000-000000000013',
                '75000000-0000-4000-8000-000000000014')) = 3
  and (select count(*) from public.suppliers
   where org_id = '75000000-0000-4000-8000-000000000012') = 1,
  'the cleanup reached beyond the organization it was given');

select pg_temp.p75_assert(
  (select count(*) from private.abandoned_signup_cleanup_log
   where org_id = '75000000-0000-4000-8000-000000000011') = 1,
  'C6: the cleanup left no retained record at all');

-- C6 is asserted against the fixture's LITERAL PII, not against column names.
select pg_temp.p75_assert(
  not exists (
    select 1 from private.abandoned_signup_cleanup_log entry
    where entry.org_id = '75000000-0000-4000-8000-000000000011'
      and (entry.removed_row_counts::text || entry.org_id::text) ~*
          '(ronit\.abandoned|example\.test|רונית|050-1112223|P75 abandoned empty)'),
  'C6: the retained cleanup record contains raw PII from the deleted organization');
select pg_temp.p75_assert(
  (select days_since_signup from private.abandoned_signup_cleanup_log
   where org_id = '75000000-0000-4000-8000-000000000011') >= 30
  and (select removed_row_counts ? 'public.profiles' from private.abandoned_signup_cleanup_log
   where org_id = '75000000-0000-4000-8000-000000000011'),
  'C6: the retained record does not state what it removed');

-- =====================================================================================
-- (5) #261 -- the offboarding purge executor
-- =====================================================================================
-- Every organization below is created in this transaction and registered in
-- pg_temp.p75_fixture_orgs; the manifest is checked against that table before anything runs.

insert into auth.users (id, email) values
  ('76000000-0000-4000-8000-000000000031', 'p75-purge-owner-a@example.test'),
  ('76000000-0000-4000-8000-000000000032', 'p75-purge-owner-b@example.test'),
  ('76000000-0000-4000-8000-000000000006', 'p75-customer-ops@example.test');

-- A SECOND operator, deliberately not a super_admin. customer_ops holds `offboarding.handle` and
-- `org.lifecycle` (0151:143-144), so it can approve an offboarding and run the executor -- which
-- is exactly why E10 below needs it: it is the strongest available proof that the legal hold got
-- its own capability rather than riding along on the one the offboarding work already carries.
insert into public.platform_admins (user_id, note) values
  ('76000000-0000-4000-8000-000000000006', 'P75 customer operations');
insert into public.platform_admin_roles (user_id, role_key) values
  ('76000000-0000-4000-8000-000000000006', 'customer_ops');

-- Created active on purpose. 0103 does not change organizations.status when a tenant offboards;
-- the read-only overlay comes from private.organization_access_mode reading the open request, so
-- 'active' here IS the shape a real purge target has. (Inserting them suspended also trips
-- private.organization_row_write_guard through the organizations audit trigger, which is the
-- same fence the executor has to satisfy -- measured 23.08.2026.)
insert into public.organizations (id, name, status) values
  ('75000000-0000-4000-8000-000000000031', 'P75 purge ready A',      'active'),
  ('75000000-0000-4000-8000-000000000032', 'P75 purge ready B',      'active'),
  ('75000000-0000-4000-8000-000000000033', 'P75 retention not due',  'active'),
  ('75000000-0000-4000-8000-000000000034', 'P75 legal hold',         'active'),
  ('75000000-0000-4000-8000-000000000035', 'P75 export not ready',   'active'),
  ('75000000-0000-4000-8000-000000000036', 'P75 backup unverified',  'active'),
  ('75000000-0000-4000-8000-000000000037', 'P75 no request at all',  'active'),
  ('75000000-0000-4000-8000-000000000038', 'P75 late candidate',     'active'),
  ('75000000-0000-4000-8000-000000000039', 'P75 hold to be lifted',  'active');

insert into pg_temp.p75_fixture_orgs (org_id)
select id from public.organizations
where id between '75000000-0000-4000-8000-000000000031'
              and '75000000-0000-4000-8000-000000000039';

-- Real tenant rows, so the staged delete has something to stage.
insert into public.profiles (id, org_id, full_name, role) values
  ('76000000-0000-4000-8000-000000000031', '75000000-0000-4000-8000-000000000031',
   'P75 purge owner A', 'owner'),
  ('76000000-0000-4000-8000-000000000032', '75000000-0000-4000-8000-000000000032',
   'P75 purge owner B', 'owner');
insert into public.suppliers (org_id, name) values
  ('75000000-0000-4000-8000-000000000031', 'P75 purge supplier A'),
  ('75000000-0000-4000-8000-000000000032', 'P75 purge supplier B');
insert into public.products (org_id, name) values
  ('75000000-0000-4000-8000-000000000031', 'P75 purge product A');
insert into public.comments (org_id, entity_type, entity_id, body) values
  ('75000000-0000-4000-8000-000000000031', 'purchase_order',
   '75000000-0000-4000-8000-0000000000fe', 'P75 purge comment A');

-- Offboarding requests. requested_at is EIGHT YEARS back for the eligible ones, because the
-- binding boundary is financial_records_retain_until -- 0103 keeps financial records seven years
-- past the request, and every shorter fixture (thirty months, measured) fails gate 1 for that
-- reason alone. A purge candidate is genuinely that old.
create function pg_temp.p75_offboarding_request(
  p_id uuid, p_org_id uuid, p_requested_at timestamptz, p_status text,
  p_legal_hold boolean, p_exported boolean
) returns void language plpgsql as $$
declare v_generation uuid := gen_random_uuid();
begin
  insert into public.organization_offboarding_requests (
    id, org_id, status, request_idempotency_key, requested_by, requested_at,
    previous_org_status, cancellation_deadline, platform_reactivation_deadline,
    operational_purge_eligible_at, security_logs_retain_until, financial_records_retain_until,
    legal_hold, export_generation, export_completed_at, export_object_path, export_sha256,
    export_size_bytes, export_file_count
  ) values (
    p_id, p_org_id, p_status, gen_random_uuid(), '76000000-0000-4000-8000-000000000003',
    p_requested_at, 'active',
    p_requested_at + interval '30 days', p_requested_at + interval '120 days',
    p_requested_at + interval '30 days', p_requested_at + interval '24 months',
    p_requested_at + interval '7 years',
    p_legal_hold, v_generation,
    case when p_exported then p_requested_at + interval '1 day' end,
    case when p_exported then p_org_id::text || '/offboarding/' || p_id::text || '/'
                              || v_generation::text || '/manifest.json' end,
    case when p_exported then repeat('a', 64) end,
    case when p_exported then 1024 end,
    case when p_exported then 3 end
  );
end
$$;

select pg_temp.p75_offboarding_request(
  '77000000-0000-4000-8000-000000000031', '75000000-0000-4000-8000-000000000031',
  now() - interval '8 years', 'export_ready', false, true);
select pg_temp.p75_offboarding_request(
  '77000000-0000-4000-8000-000000000032', '75000000-0000-4000-8000-000000000032',
  now() - interval '8 years', 'export_ready', false, true);
-- Gate 1 negative: requested yesterday, so nothing has aged out.
select pg_temp.p75_offboarding_request(
  '77000000-0000-4000-8000-000000000033', '75000000-0000-4000-8000-000000000033',
  now() - interval '1 day', 'export_ready', false, true);
-- Gate 2 negative: the hold 0103 sets by default was never lifted.
select pg_temp.p75_offboarding_request(
  '77000000-0000-4000-8000-000000000034', '75000000-0000-4000-8000-000000000034',
  now() - interval '8 years', 'export_ready', true, true);
-- Gate 3 negative: no completed export.
select pg_temp.p75_offboarding_request(
  '77000000-0000-4000-8000-000000000035', '75000000-0000-4000-8000-000000000035',
  now() - interval '8 years', 'completed', false, false);
-- Gate 4 negative: exported and aged out, but no verified restore.
select pg_temp.p75_offboarding_request(
  '77000000-0000-4000-8000-000000000036', '75000000-0000-4000-8000-000000000036',
  now() - interval '8 years', 'export_ready', false, true);
-- The late candidate: eligible in every way EXCEPT that it is approved by nobody.
select pg_temp.p75_offboarding_request(
  '77000000-0000-4000-8000-000000000038', '75000000-0000-4000-8000-000000000038',
  now() - interval '8 years', 'export_ready', false, true);
-- #306 (0257): the one request in this file that keeps the hold 0103:58 puts on EVERY request and
-- is never written by a fixture. Every other gate passes, so gate 2 is the only thing between it
-- and the executor -- which makes whatever E10 changes attributable to the hold and to nothing
-- else. Note the contrast with its five siblings above: they pass `false` straight into the
-- column because until 0257 there was no other way for this suite to reach that value.
select pg_temp.p75_offboarding_request(
  '77000000-0000-4000-8000-000000000039', '75000000-0000-4000-8000-000000000039',
  now() - interval '8 years', 'export_ready', true, true);

-- Backup and restore evidence, through the real command.
select pg_temp.p75_as('76000000-0000-4000-8000-000000000003', true);
select public.record_organization_purge_backup_evidence(
  '75000000-0000-4000-8000-000000000031', 'backup://p75/a', now() - interval '2 days',
  now() - interval '1 day', 'P75 restore rehearsal A');
select public.record_organization_purge_backup_evidence(
  '75000000-0000-4000-8000-000000000032', 'backup://p75/b', now() - interval '2 days',
  now() - interval '1 day', 'P75 restore rehearsal B');
select public.record_organization_purge_backup_evidence(
  '75000000-0000-4000-8000-000000000033', 'backup://p75/c', now() - interval '2 days',
  now() - interval '1 day', 'P75 restore rehearsal C');
select public.record_organization_purge_backup_evidence(
  '75000000-0000-4000-8000-000000000034', 'backup://p75/d', now() - interval '2 days',
  now() - interval '1 day', 'P75 restore rehearsal D');
select public.record_organization_purge_backup_evidence(
  '75000000-0000-4000-8000-000000000035', 'backup://p75/e', now() - interval '2 days',
  now() - interval '1 day', 'P75 restore rehearsal E');
-- Gate 4 negative: a backup was taken and NEVER restored. A backup nobody restored is a claim.
select public.record_organization_purge_backup_evidence(
  '75000000-0000-4000-8000-000000000036', 'backup://p75/f', now() - interval '2 days',
  null, 'P75 backup with no restore rehearsal');
select public.record_organization_purge_backup_evidence(
  '75000000-0000-4000-8000-000000000038', 'backup://p75/h', now() - interval '2 days',
  now() - interval '1 day', 'P75 restore rehearsal H');
select public.record_organization_purge_backup_evidence(
  '75000000-0000-4000-8000-000000000039', 'backup://p75/i', now() - interval '2 days',
  now() - interval '1 day', 'P75 restore rehearsal I');
select pg_temp.p75_as(null);

-- ===== E1 -- four gates, four independent negatives =====
create function pg_temp.p75_gate(p_org_id uuid, p_gate text)
returns boolean language sql stable as $$
  select (private.organization_purge_gates(p_org_id) ->> p_gate)::boolean
$$;

select pg_temp.p75_assert(
  pg_temp.p75_gate('75000000-0000-4000-8000-000000000031', 'eligible'),
  'E1: the fully gated organization is not eligible, so no negative below proves anything');

select pg_temp.p75_assert(
  not pg_temp.p75_gate('75000000-0000-4000-8000-000000000033', 'retention_eligible')
  and pg_temp.p75_gate('75000000-0000-4000-8000-000000000033', 'legal_hold_clear')
  and pg_temp.p75_gate('75000000-0000-4000-8000-000000000033', 'export_ready')
  and pg_temp.p75_gate('75000000-0000-4000-8000-000000000033', 'backup_present')
  and not pg_temp.p75_gate('75000000-0000-4000-8000-000000000033', 'eligible'),
  'E1 gate 1: retention ineligibility did not independently block the candidate');

select pg_temp.p75_assert(
  pg_temp.p75_gate('75000000-0000-4000-8000-000000000034', 'retention_eligible')
  and not pg_temp.p75_gate('75000000-0000-4000-8000-000000000034', 'legal_hold_clear')
  and pg_temp.p75_gate('75000000-0000-4000-8000-000000000034', 'export_ready')
  and pg_temp.p75_gate('75000000-0000-4000-8000-000000000034', 'backup_present')
  and not pg_temp.p75_gate('75000000-0000-4000-8000-000000000034', 'eligible'),
  'E1 gate 2: a legal hold did not independently block the candidate');

select pg_temp.p75_assert(
  pg_temp.p75_gate('75000000-0000-4000-8000-000000000035', 'retention_eligible')
  and pg_temp.p75_gate('75000000-0000-4000-8000-000000000035', 'legal_hold_clear')
  and not pg_temp.p75_gate('75000000-0000-4000-8000-000000000035', 'export_ready')
  and pg_temp.p75_gate('75000000-0000-4000-8000-000000000035', 'backup_present')
  and not pg_temp.p75_gate('75000000-0000-4000-8000-000000000035', 'eligible'),
  'E1 gate 3: an unfinished export did not independently block the candidate');

select pg_temp.p75_assert(
  pg_temp.p75_gate('75000000-0000-4000-8000-000000000036', 'retention_eligible')
  and pg_temp.p75_gate('75000000-0000-4000-8000-000000000036', 'legal_hold_clear')
  and pg_temp.p75_gate('75000000-0000-4000-8000-000000000036', 'export_ready')
  and not pg_temp.p75_gate('75000000-0000-4000-8000-000000000036', 'backup_present')
  and not pg_temp.p75_gate('75000000-0000-4000-8000-000000000036', 'eligible'),
  'E1 gate 4 / E8: a backup with no verified restore did not block the candidate');

-- ===== E2 -- an unknown hold state is a hold =====
select pg_temp.p75_assert(
  not pg_temp.p75_gate('75000000-0000-4000-8000-000000000037', 'legal_hold_clear')
  and not pg_temp.p75_gate('75000000-0000-4000-8000-000000000037', 'eligible'),
  'E2: an organization with no readable hold state was treated as having no hold -- 0103:58 '
  || 'makes legal_hold not null default true precisely so unknown fails closed');

-- ===== E10 -- the hold has a lift, and lifting it is what opens the gate (#306, 0257) =====
--
-- E2 above proves the hold fails closed. This proves it can be opened -- which until 0257 nothing
-- in the product could do, so the controlled-purge route DEBT §66 and 0254 finished could not
-- open for any tenant in production, ever. Everything below goes through
-- public.release_organization_legal_hold; no statement here writes legal_hold directly.
create function pg_temp.p75_refused(p_sql text, p_expected text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm not like '%' || p_expected || '%' then
      raise exception 'P75 expected refusal %, got: %', p_expected, sqlerrm;
    end if;
    return;
  end;
  raise exception 'P75 expected refusal % but the statement succeeded: %', p_expected, p_sql;
end
$$;

select pg_temp.p75_assert(
  exists (select 1 from private.platform_capability_definitions
           where capability = 'offboarding.legal_hold'
             and sensitivity = 'high' and requires_step_up),
  'E10: offboarding.legal_hold is not declared a high-sensitivity step-up capability');

-- One role, counted rather than assumed: "does super_admin hold it" is a different and much
-- weaker question than "who holds it".
select pg_temp.p75_assert(
  (select array_agg(role_key order by role_key) from platform_role_capabilities
    where capability = 'offboarding.legal_hold') = array['super_admin'],
  'E10: offboarding.legal_hold is held by a role other than super_admin -- #306 named one');

-- Reachability from the catalogue, never by calling as a role that lacks EXECUTE.
select pg_temp.p75_assert(
  has_function_privilege('anon',
    'public.release_organization_legal_hold(uuid,text)', 'execute') = false
  and has_function_privilege('service_role',
    'public.release_organization_legal_hold(uuid,text)', 'execute') = false
  and has_function_privilege('authenticated',
    'public.release_organization_legal_hold(uuid,text)', 'execute'),
  'E10: the release command is reachable by a role a scheduler can hold, or is unreachable by '
  || 'the browser role that is supposed to call it');

-- Gate 2 is the ONLY gate this tenant fails.
select pg_temp.p75_assert(
  pg_temp.p75_gate('75000000-0000-4000-8000-000000000039', 'retention_eligible')
  and not pg_temp.p75_gate('75000000-0000-4000-8000-000000000039', 'legal_hold_clear')
  and pg_temp.p75_gate('75000000-0000-4000-8000-000000000039', 'export_ready')
  and pg_temp.p75_gate('75000000-0000-4000-8000-000000000039', 'backup_present')
  and not pg_temp.p75_gate('75000000-0000-4000-8000-000000000039', 'eligible'),
  'E10: the hold is not the only gate the release fixture fails, so nothing below is '
  || 'attributable to lifting it');

-- customer_ops may approve this very offboarding and may run the executor. It may not lift the
-- hold. This is the assertion that would fail if the command had reused offboarding.handle.
select pg_temp.p75_as('76000000-0000-4000-8000-000000000006', true);
select pg_temp.p75_assert(
  public.platform_has_capability('offboarding.handle')
  and not public.platform_has_capability('offboarding.legal_hold'),
  'E10: the customer_ops fixture does not hold offboarding.handle without the hold capability, '
  || 'so refusing it below would prove nothing');
select pg_temp.p75_refused(
  $$select public.release_organization_legal_hold(
      '75000000-0000-4000-8000-000000000039', 'P75 customer_ops attempt')$$,
  'not_platform_capability');

-- The step-up is not decorative: right operator, right capability, stale authentication.
select pg_temp.p75_as('76000000-0000-4000-8000-000000000003', false);
select pg_temp.p75_refused(
  $$select public.release_organization_legal_hold(
      '75000000-0000-4000-8000-000000000039', 'P75 stale authentication')$$,
  'fresh_authentication_required');

-- A reason is mandatory, and blank is not a reason.
select pg_temp.p75_as('76000000-0000-4000-8000-000000000003', true);
select pg_temp.p75_refused(
  $$select public.release_organization_legal_hold(
      '75000000-0000-4000-8000-000000000039', '   ')$$,
  'reason_required');

-- An organization with no offboarding request is refused by name, not silently accepted.
select pg_temp.p75_refused(
  $$select public.release_organization_legal_hold(
      '75000000-0000-4000-8000-000000000037', 'P75 nothing here to release')$$,
  'offboarding_request_unknown');

select pg_temp.p75_assert(
  not pg_temp.p75_gate('75000000-0000-4000-8000-000000000039', 'legal_hold_clear'),
  'E10: one of the refusals above lifted the hold anyway');

-- The lift itself.
select public.release_organization_legal_hold(
  '75000000-0000-4000-8000-000000000039',
  'P75 hold lifted: the matter it was taken for closed') as hold_release \gset p75_
select pg_temp.p75_as(null);

select pg_temp.p75_assert(
  (:'p75_hold_release'::jsonb ->> 'changed')::boolean
  and (:'p75_hold_release'::jsonb ->> 'request_id') = '77000000-0000-4000-8000-000000000039'
  and (:'p75_hold_release'::jsonb ->> 'purge_gate_legal_hold_clear')::boolean,
  'E10: the release did not report a change on the organization''s live request');

-- THIS IS THE DECISION. #261 built four gates; #306 is the only thing that can open the second.
select pg_temp.p75_assert(
  pg_temp.p75_gate('75000000-0000-4000-8000-000000000039', 'legal_hold_clear')
  and pg_temp.p75_gate('75000000-0000-4000-8000-000000000039', 'eligible'),
  'E10: lifting the hold did not clear the purge gate -- #306 exists for exactly this');

-- Both trails, both carrying the reason (CLAUDE.md: every sensitive action, with its reason).
select pg_temp.p75_assert(
  exists (select 1 from public.audit_logs
           where org_id = '75000000-0000-4000-8000-000000000039'
             and action = 'organization_offboarding_legal_hold_released'
             and entity_type = 'organization_offboarding_requests'
             and entity_id = '77000000-0000-4000-8000-000000000039'
             and reason like 'P75 hold lifted%'
             and old_values = jsonb_build_object('legal_hold', true)
             and new_values = jsonb_build_object('legal_hold', false)),
  'E10: the lift is missing from the tenant''s own audit trail, or lost its reason');
select pg_temp.p75_assert(
  exists (select 1 from platform_lifecycle_events
           where org_id = '75000000-0000-4000-8000-000000000039'
             and action = 'organization_offboarding_legal_hold_released'
             and entity_id = '77000000-0000-4000-8000-000000000039'
             and reason like 'P75 hold lifted%'),
  'E10: the lift is missing from the platform timeline the console reads back');

-- Idempotence is reported, not re-written: a no-op writes NEITHER trail, so "how many times was
-- this hold lifted" stays answerable from the logs.
select pg_temp.p75_as('76000000-0000-4000-8000-000000000003', true);
select public.release_organization_legal_hold(
  '75000000-0000-4000-8000-000000000039', 'P75 repeat') as hold_release_again \gset p75_
select pg_temp.p75_as(null);
select pg_temp.p75_assert(
  (:'p75_hold_release_again'::jsonb ->> 'changed')::boolean = false
  and (:'p75_hold_release_again'::jsonb ->> 'purge_gate_legal_hold_clear')::boolean,
  'E10: a repeat lift reported a change it did not make');
select pg_temp.p75_assert(
  (select count(*) from public.audit_logs
    where org_id = '75000000-0000-4000-8000-000000000039'
      and action = 'organization_offboarding_legal_hold_released') = 1
  and (select count(*) from platform_lifecycle_events
    where org_id = '75000000-0000-4000-8000-000000000039'
      and action = 'organization_offboarding_legal_hold_released') = 1,
  'E10: a no-op lift wrote a second row to one of the two trails');

select pg_temp.p75_assert(
  to_regprocedure('public.release_organization_legal_hold(uuid,text)') is not null,
  'contract: the legal-hold release does not exist under that exact signature');

-- Every negative is also refused by the approval command, not only by the report.
create function pg_temp.p75_approval_refused(p_org_id uuid)
returns boolean language plpgsql as $$
begin
  perform pg_temp.p75_as('76000000-0000-4000-8000-000000000003', true);
  perform public.approve_organization_purge_batch(array[p_org_id], 'P75 negative gate probe');
  perform pg_temp.p75_as(null);
  return false;
exception when others then
  return sqlerrm like '%not_eligible%';
end
$$;
select pg_temp.p75_assert(
  pg_temp.p75_approval_refused('75000000-0000-4000-8000-000000000033')
  and pg_temp.p75_approval_refused('75000000-0000-4000-8000-000000000034')
  and pg_temp.p75_approval_refused('75000000-0000-4000-8000-000000000035')
  and pg_temp.p75_approval_refused('75000000-0000-4000-8000-000000000036')
  and pg_temp.p75_approval_refused('75000000-0000-4000-8000-000000000037'),
  'E1: a batch approval accepted an organization that fails a gate');
select pg_temp.p75_as(null);

-- ===== E7 -- nothing reaches the executor without an approval a person created =====
select pg_temp.p75_assert(
  (select pronargs from pg_catalog.pg_proc
   where oid = 'public.execute_organization_purge_batch(uuid)'::regprocedure) = 1,
  'E7: the executor takes more than an approval id, so it can select its own targets');
select pg_temp.p75_assert(
  (select p.prosrc from pg_catalog.pg_proc p
   where p.oid = 'public.execute_organization_purge_batch(uuid)'::regprocedure)
    !~* 'operational_purge_eligible_at|platform_purge_candidates',
  'E7: the executor contains a candidate query -- it must replay a manifest, not select targets');
-- The grant assertion is the structural half of "no clock reaches it": the executor is granted
-- to no role a scheduler can hold, and its body demands a platform-admin identity with a fresh
-- password AMR claim, which no cron job can present. Asserted from the catalogue, never by
-- calling it as a role that lacks EXECUTE.
select pg_temp.p75_assert(
  has_function_privilege('anon', 'public.execute_organization_purge_batch(uuid)', 'execute')
    = false
  and has_function_privilege('service_role', 'public.execute_organization_purge_batch(uuid)',
    'execute') = false
  and has_function_privilege('anon', 'public.approve_organization_purge_batch(uuid[],text)',
    'execute') = false,
  'E7: a role a scheduler can hold has EXECUTE on a purge command');
select pg_temp.p75_assert(
  (select p.prosrc from pg_catalog.pg_proc p
   where p.oid = 'public.execute_organization_purge_batch(uuid)'::regprocedure)
    ~ 'assert_recent_password_authentication'
  and (select p.prosrc from pg_catalog.pg_proc p
   where p.oid = 'public.execute_organization_purge_batch(uuid)'::regprocedure)
    ~ 'is_platform_admin',
  'E7: the executor does not demand a platform-admin identity with a fresh password');
select pg_temp.p75_assert(
  to_regclass('cron.job') is null or not exists (
    select 1 from cron.job
    where command like '%purge%organization%' or command like '%organization%purge%'),
  'E7: a scheduled job names a purge command -- #261 forbids a purge that fires on a clock');
do $$
begin
  perform pg_temp.p75_as('76000000-0000-4000-8000-000000000003', true);
  perform public.execute_organization_purge_batch('00000000-0000-4000-8000-0000000000ff');
  raise exception 'E7: the executor ran for an approval that does not exist';
exception when sqlstate 'P0002' then
  perform pg_temp.p75_as(null);
end
$$;

-- ===== E6 -- the manifest is append-only for every role =====
-- MEASURED: the table OWNER always carries the full grant set -- that is what ownership is, and
-- it cannot be revoked away. So the grant arm asserts that no role BESIDES the owner holds a
-- mutating privilege, and the behavioural arm below covers the owner: the trigger refuses an
-- UPDATE and a DELETE issued by the owning role itself.
select pg_temp.p75_assert(
  not exists (
    select 1 from information_schema.role_table_grants grant_row
    where grant_row.table_schema = 'private'
      and grant_row.table_name in ('organization_purge_batches',
                                   'organization_purge_manifest_items',
                                   'organization_purge_executions',
                                   'organization_purge_backup_evidence')
      and grant_row.privilege_type in ('UPDATE', 'DELETE', 'TRUNCATE')
      and grant_row.grantee <> (
        select owner.tableowner from pg_catalog.pg_tables owner
        where owner.schemaname = 'private' and owner.tablename = grant_row.table_name)),
  'E6: a role that does not own the purge ledger holds UPDATE, DELETE or TRUNCATE on it');
select pg_temp.p75_assert(
  not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'private'
      and table_name in ('organization_purge_batches', 'organization_purge_manifest_items',
                         'organization_purge_executions',
                         'organization_purge_backup_evidence')
      and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')),
  'E6: a browser or service role holds any grant at all on the purge ledger');

-- ===== Approve a batch of exactly two, then move the world underneath it =====
select pg_temp.p75_as('76000000-0000-4000-8000-000000000003', true);
select public.approve_organization_purge_batch(
  array['75000000-0000-4000-8000-000000000031'::uuid,
        '75000000-0000-4000-8000-000000000032'::uuid],
  'P75 approved purge batch') as batch_id \gset p75_
select pg_temp.p75_as(null);

select pg_temp.p75_assert(
  (select count(*) from private.organization_purge_manifest_items
   where batch_id = :'p75_batch_id'::uuid) = 2,
  'the approved manifest does not hold exactly the two organizations that were approved');

-- E9 -- containment: every organization in the manifest was created by this transaction.
select pg_temp.p75_assert(
  not exists (
    select 1 from private.organization_purge_manifest_items item
    where item.batch_id = :'p75_batch_id'::uuid
      and not exists (
        select 1 from pg_temp.p75_fixture_orgs fixture where fixture.org_id = item.org_id)),
  'E9 BLAST RADIUS: the manifest names an organization this transaction did not create');

select set_config('p75.batch', :'p75_batch_id', true);

-- E6 continued: the manifest cannot be rewritten, even by the role that wrote it.
do $$
begin
  update private.organization_purge_manifest_items set organization_name = 'rewritten'
  where batch_id = current_setting('p75.batch')::uuid;
  raise exception 'E6: the approved manifest was rewritten';
exception when insufficient_privilege then
  if sqlerrm not like '%append_only%' then raise; end if;
end
$$;
do $$
begin
  delete from private.organization_purge_manifest_items
  where batch_id = current_setting('p75.batch')::uuid;
  raise exception 'E6: a row was deleted from the approved manifest';
exception when insufficient_privilege then
  if sqlerrm not like '%append_only%' then raise; end if;
end
$$;
select pg_temp.p75_assert(
  (select count(*) from private.organization_purge_manifest_items
   where batch_id = :'p75_batch_id'::uuid) = 2
  and (select count(*) from private.organization_purge_manifest_items
       where batch_id = :'p75_batch_id'::uuid and organization_name = 'rewritten') = 0,
  'E6: the manifest changed despite the refusals');

-- E4 -- a legal hold arrives AFTER approval, on one tenant of the two.
--
-- WHAT IS STILL EMULATED HERE, AND WHY -- narrowed by 0257, not resolved. LIFTING a hold is now
-- a real command and E10 above exercises it. PLACING one is not, and deliberately so: #306 ruled
-- on the exit, and `not null default true` (0103:58) already places a hold on every request 0103
-- creates, so no tenant reaches the executor unheld. This arm needs a hold to ARRIVE after
-- approval on a request that had none, which no product command does, so it still writes the
-- column through the documented platform lever the write guard honours for this exact table
-- (private.organization_row_write_guard, v_offboarding_write). The gate this exercises is real;
-- the placement is the half of the pair the owner did not ask for.
select set_config('app.organization_offboarding_writer_org',
                  '75000000-0000-4000-8000-000000000032', true);
select pg_temp.p75_as('76000000-0000-4000-8000-000000000003');
update public.organization_offboarding_requests
set legal_hold = true
where id = '77000000-0000-4000-8000-000000000032';
select set_config('app.organization_offboarding_writer_org', '', true);
select pg_temp.p75_as(null);

-- E3 -- and a NEW organization becomes a candidate after approval. It is not in the manifest,
-- so it must not be touched however eligible it now is.
select pg_temp.p75_assert(
  pg_temp.p75_gate('75000000-0000-4000-8000-000000000038', 'eligible'),
  'E3: the late candidate is not eligible, so the scope-drift test proves nothing');

-- ===== Execute =====
select pg_temp.p75_as('76000000-0000-4000-8000-000000000003', true);
select public.execute_organization_purge_batch(:'p75_batch_id'::uuid) as outcome \gset p75_
select pg_temp.p75_as(null);

select pg_temp.p75_assert(
  (:'p75_outcome'::jsonb ->> 'purged') = '1' and (:'p75_outcome'::jsonb ->> 'skipped') = '1',
  'E4: the batch did not purge exactly one tenant and skip exactly one');

-- E4: the held tenant survived, named, and the rest of the batch proceeded.
select pg_temp.p75_assert(
  (select count(*) from public.organizations
   where id = '75000000-0000-4000-8000-000000000032') = 1
  and exists (
    select 1 from private.organization_purge_executions
    where batch_id = :'p75_batch_id'::uuid
      and org_id = '75000000-0000-4000-8000-000000000032'
      and outcome = 'skipped' and skip_reason like 'gates_changed_since_approval%'),
  'E4: a tenant whose legal hold arrived after approval was purged, or was skipped silently');

-- E3: the late candidate was never in the manifest and was never touched.
select pg_temp.p75_assert(
  (select count(*) from public.organizations
   where id = '75000000-0000-4000-8000-000000000038') = 1
  and not exists (
    select 1 from private.organization_purge_executions
    where org_id = '75000000-0000-4000-8000-000000000038')
  and not exists (
    select 1 from private.organization_purge_manifest_items
    where org_id = '75000000-0000-4000-8000-000000000038'),
  'E3: an organization that became a candidate after approval entered the execution');

-- E5: the purged tenant is gone in stages, with no orphan and no reach beyond it.
select pg_temp.p75_assert(
  (select count(*) from public.organizations
   where id = '75000000-0000-4000-8000-000000000031') = 0
  and (select count(*) from public.profiles
   where org_id = '75000000-0000-4000-8000-000000000031') = 0
  and (select count(*) from public.suppliers
   where org_id = '75000000-0000-4000-8000-000000000031') = 0
  and (select count(*) from public.products
   where org_id = '75000000-0000-4000-8000-000000000031') = 0
  and (select count(*) from public.comments
   where org_id = '75000000-0000-4000-8000-000000000031') = 0
  and (select count(*) from public.organization_offboarding_requests
   where org_id = '75000000-0000-4000-8000-000000000031') = 0
  and (select count(*) from public.audit_logs
   where org_id = '75000000-0000-4000-8000-000000000031') = 0,
  'E5: the staged delete left tenant rows behind');
select pg_temp.p75_assert(
  (select count(*) from public.suppliers
   where org_id = '75000000-0000-4000-8000-000000000032') = 1
  and (select count(*) from public.organizations
   where id in ('75000000-0000-4000-8000-000000000033',
                '75000000-0000-4000-8000-000000000034',
                '75000000-0000-4000-8000-000000000035',
                '75000000-0000-4000-8000-000000000036',
                '75000000-0000-4000-8000-000000000037')) = 5,
  'E5: the purge reached beyond the tenant it was executing');

-- The execution ledger states what it removed, and the backup evidence outlived the tenant.
select pg_temp.p75_assert(
  (select removed_row_counts ? 'public.suppliers' from private.organization_purge_executions
   where batch_id = :'p75_batch_id'::uuid
     and org_id = '75000000-0000-4000-8000-000000000031') ,
  'E5: the execution ledger does not record what the staged delete removed');
select pg_temp.p75_assert(
  (select count(*) from private.organization_purge_backup_evidence
   where org_id = '75000000-0000-4000-8000-000000000031') = 1,
  'E8: the restore evidence died with the tenant it is evidence about');

-- A second execution of the same approval is refused: an approval authorizes one run.
do $$
begin
  perform pg_temp.p75_as('76000000-0000-4000-8000-000000000003', true);
  perform public.execute_organization_purge_batch(current_setting('p75.batch')::uuid);
  raise exception 'E3: the same approval was executed twice';
exception when sqlstate '42501' then
  perform pg_temp.p75_as(null);
end
$$;

-- ===== Contract existence -- every RPC the operator console calls resolves =====
-- Mocks agree with the UI by construction. This does not.
select pg_temp.p75_assert(
  to_regprocedure('public.set_organization_lifecycle(uuid,public.org_status,timestamptz,text,text,text)') is not null
  and to_regprocedure('public.platform_organization_lifecycle_notes(uuid)') is not null
  and to_regprocedure('public.organization_lifecycle_reason_labels()') is not null
  and to_regprocedure('public.platform_abandoned_signup_candidates(integer)') is not null
  and to_regprocedure('public.platform_quarantine_queue()') is not null
  and to_regprocedure('public.platform_resolve_quarantine(uuid,text,text)') is not null
  and to_regprocedure('public.platform_purge_candidates()') is not null
  and to_regprocedure('public.platform_purge_batches()') is not null
  and to_regprocedure('public.platform_purge_batch_items(uuid)') is not null
  and to_regprocedure('public.approve_organization_purge_batch(uuid[],text)') is not null
  and to_regprocedure('public.record_organization_purge_backup_evidence(uuid,text,timestamptz,timestamptz,text)') is not null
  and to_regprocedure('public.execute_organization_purge_batch(uuid)') is not null,
  'contract: an RPC the operator console calls does not exist under that exact signature');

rollback;

\echo 'p75_platform_lifecycle_passed'
