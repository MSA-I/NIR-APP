-- P55 -- The anonymous signup door is bounded by a limit the database counts, records only
-- hashes, and cannot be reached by a browser role (0159).
\set ON_ERROR_STOP on

begin;

create function pg_temp.p55_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P55 signup assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p55_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_user, 'amr', '[]'::jsonb)::text, true);
end
$$;

create function pg_temp.p55_as_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
end
$$;

create function pg_temp.p55_hash(p_value text) returns text
language sql immutable as $$ select encode(digest(p_value, 'sha256'), 'hex') $$;

-- ===== Structural claims =====
select pg_temp.p55_assert(
  not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'private' and table_name = 'signup_attempts'
      and grantee in ('anon', 'authenticated', 'service_role')),
  'a role holds a direct grant on the signup attempt table');

-- The table must not be able to hold anything that reads back as a visitor's identity.
select pg_temp.p55_assert(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'private' and table_name = 'signup_attempts'
      and column_name in ('ip', 'ip_address', 'email', 'user_agent')),
  'the signup attempt table grew a column that identifies a visitor');

-- Every signup door is service_role only. An anonymous caller reaching the limiter directly could
-- burn the window for everybody else.
select pg_temp.p55_assert(
  not exists (
    select 1 from information_schema.role_routine_grants
    where routine_schema = 'public'
      and routine_name in ('service_check_signup_rate', 'service_mark_signup_rejected',
                           'service_record_product_event')
      and grantee in ('anon', 'authenticated')),
  'a browser role can execute a signup service function');

-- Counting and recording must be one serialized decision. Persistence alone is insufficient:
-- without a transaction lock, concurrent anonymous requests can all observe the same count below
-- the threshold and all insert an accepted row.
select pg_temp.p55_assert(
  (select position('pg_advisory_xact_lock' in prosrc) > 0
          and position('pg_advisory_xact_lock' in prosrc)
              < position('select count(*) into v_ip_count' in prosrc)
     from pg_catalog.pg_proc
    where oid = to_regprocedure('public.service_check_signup_rate(text,text)')),
  'the signup limiter does not serialize before its first count');

-- ===== Fixture =====
insert into public.organizations (id, name, status) values
  ('55000000-0000-4000-8000-000000000001', 'P55 tenant', 'active');
insert into auth.users (id, email) values
  ('65000000-0000-4000-8000-000000000001', 'owner-p55@example.test'),
  ('65000000-0000-4000-8000-000000000002', 'ops-p55@example.test');
insert into public.profiles (id, org_id, full_name, role) values
  ('65000000-0000-4000-8000-000000000001', '55000000-0000-4000-8000-000000000001', 'P55 owner', 'owner');
insert into public.platform_admins (user_id, note) values
  ('65000000-0000-4000-8000-000000000002', 'P55 customer ops');
insert into public.platform_admin_roles (user_id, role_key) values
  ('65000000-0000-4000-8000-000000000002', 'customer_ops');

-- ===== A signed-in user cannot reach the door at all =====
select pg_temp.p55_as('65000000-0000-4000-8000-000000000001');
-- PostgreSQL 17.6 in the local Supabase image segfaults instead of returning 42501 when SET ROLE
-- directly invokes a function whose EXECUTE grant was revoked. The structural assertion above
-- proves the outer ACL; run as the test owner so the authenticated JWT claim reaches and proves
-- each function's inner service-role guard as well.
do $$
begin
  perform public.service_check_signup_rate(
    repeat('a', 64), repeat('b', 64));
  raise exception 'expected a user JWT to be refused at the rate limiter';
exception when insufficient_privilege then null;
end
$$;
do $$
begin
  perform public.service_record_product_event(
    '55000000-0000-4000-8000-000000000001', 'signup.completed', '{}'::jsonb, 'p55');
  raise exception 'expected a user JWT to be refused at the product event seam';
exception when insufficient_privilege then null;
end
$$;

-- ===== The limiter counts, and refuses =====
select pg_temp.p55_as_service();

-- A malformed hash is refused rather than stored: the column shape is the guarantee that this
-- table holds hashes, and accepting anything else would quietly break it.
do $$
begin
  perform public.service_check_signup_rate(repeat('a', 64), 'not-a-hash');
  raise exception 'expected a malformed hash to be refused';
exception when invalid_parameter_value then null;
end
$$;

-- Three attempts from one email address are allowed; the fourth is not.
select pg_temp.p55_assert(
  (public.service_check_signup_rate(pg_temp.p55_hash('1.2.3.4'), pg_temp.p55_hash('a@example.test'))
    ->> 'allowed')::boolean,
  'the first signup attempt was refused');
select pg_temp.p55_assert(
  (public.service_check_signup_rate(pg_temp.p55_hash('1.2.3.5'), pg_temp.p55_hash('a@example.test'))
    ->> 'allowed')::boolean,
  'the second signup attempt was refused');
select pg_temp.p55_assert(
  (public.service_check_signup_rate(pg_temp.p55_hash('1.2.3.6'), pg_temp.p55_hash('a@example.test'))
    ->> 'allowed')::boolean,
  'the third signup attempt was refused');
select pg_temp.p55_assert(
  not (public.service_check_signup_rate(pg_temp.p55_hash('1.2.3.7'), pg_temp.p55_hash('a@example.test'))
    ->> 'allowed')::boolean,
  'a fourth attempt on the same email address was allowed');
select pg_temp.p55_assert(
  (public.service_check_signup_rate(pg_temp.p55_hash('1.2.3.7'), pg_temp.p55_hash('a@example.test'))
    ->> 'reason') = 'email_hourly',
  'the email limit did not name itself');

-- Five attempts from one address are allowed; the sixth is not, whatever email it carries.
select pg_temp.p55_assert(
  (public.service_check_signup_rate(pg_temp.p55_hash('9.9.9.9'), pg_temp.p55_hash('b1@example.test'))
    ->> 'allowed')::boolean
  and (public.service_check_signup_rate(pg_temp.p55_hash('9.9.9.9'), pg_temp.p55_hash('b2@example.test'))
    ->> 'allowed')::boolean
  and (public.service_check_signup_rate(pg_temp.p55_hash('9.9.9.9'), pg_temp.p55_hash('b3@example.test'))
    ->> 'allowed')::boolean
  and (public.service_check_signup_rate(pg_temp.p55_hash('9.9.9.9'), pg_temp.p55_hash('b4@example.test'))
    ->> 'allowed')::boolean
  and (public.service_check_signup_rate(pg_temp.p55_hash('9.9.9.9'), pg_temp.p55_hash('b5@example.test'))
    ->> 'allowed')::boolean,
  'five attempts from one address were not all allowed');
select pg_temp.p55_assert(
  (public.service_check_signup_rate(pg_temp.p55_hash('9.9.9.9'), pg_temp.p55_hash('b6@example.test'))
    ->> 'reason') = 'address_hourly',
  'a sixth attempt from the same address was allowed');

-- A refused attempt is recorded too. A limiter that only remembers what it allowed can be walked
-- past by continuing to be refused until the window rolls.
select pg_temp.p55_assert(
  (select count(*) from private.signup_attempts where outcome = 'rate_limited') >= 3,
  'refused attempts were not recorded');

-- Nothing readable was stored: every row holds a 64-character hex digest and nothing else.
select pg_temp.p55_assert(
  not exists (
    select 1 from private.signup_attempts
    where email_hash !~ '^[0-9a-f]{64}$'
       or (ip_hash is not null and ip_hash !~ '^[0-9a-f]{64}$')),
  'a signup attempt stored something other than a hash');
select pg_temp.p55_assert(
  not exists (
    select 1 from private.signup_attempts
    where email_hash = 'a@example.test' or ip_hash = '1.2.3.4'),
  'a signup attempt stored a readable address or email');

-- A signup that fails after the check corrects its own record, so the global counter stays honest
-- about how many organizations were actually created.
select public.service_mark_signup_rejected(pg_temp.p55_hash('a@example.test'));
select pg_temp.p55_assert(
  (select count(*) from private.signup_attempts
    where email_hash = pg_temp.p55_hash('a@example.test') and outcome = 'rejected') = 1,
  'a failed signup did not correct its accepted attempt');

reset role;

-- ===== The operator sees pressure, and only counts =====
select pg_temp.p55_as('65000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.p55_assert(
  (select accepted from public.platform_signup_activity(24)) >= 1
  and (select rate_limited from public.platform_signup_activity(24)) >= 3,
  'the operator could not see signup pressure');
reset role;

-- A tenant sees none of it.
select pg_temp.p55_as('65000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.p55_assert(
  (select count(*) from public.platform_signup_activity(24)) = 0,
  'a tenant owner read the signup activity counts');
do $$
begin
  perform (select count(*) from private.signup_attempts);
  raise exception 'expected a direct tenant read of the attempt table to be refused';
exception when insufficient_privilege then null;
end
$$;
reset role;

rollback;

\echo 'p55_self_signup_rate_limit_passed'
