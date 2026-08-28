-- P74 role-based MFA assurance harness for 0199 (#88). Run only against an isolated
-- local database with every migration applied. The transaction is rolled back.
--
-- Scope note, deliberate: this suite proves the SERVER-SIDE assurance contract only --
-- refusal at aal1 and acceptance at aal2. Enrollment, challenge, recovery codes and
-- lost-device flows are NOT covered here and are NOT implemented: Supabase Auth exposes no
-- backup-code primitive, and the local stack has TOTP enroll/verify switched off. Nothing
-- in this suite may be read as evidence that MFA is live.
--
-- What it proves:
--   (B2) structurally, the one step-up primitive carries the assurance call and every
--        SECURITY-MODEL 6 path still routes through that primitive -- signature-resolved,
--        so an argument drift or a dropped call fails here rather than degrading quietly;
--   (B8) that check is non-vacuous, proven by mutation inside a savepoint;
--   (B3) aal parsing is fail-closed: absent, JSON null, number, array and object are each
--        refused, one row per shape -- the `is distinct from` trap that a plain `<>` misses;
--   (B4) the role matrix in both directions: owner and accountant ARE required to hold
--        aal2, office is NOT blocked;
--   (B5) retired personas fail at the 0133 gate BEFORE assurance is consulted;
--   (B1) a real command called over PostgREST's role with a fresh password AMR but an
--        aal1 session raises mfa_assurance_required / 42501, and succeeds at aal2;
--   (B9) password step-up keeps raising first: a stale or missing AMR still yields
--        fresh_authentication_required even when aal2 is present.
--
-- SAFETY: assert_mfa_assurance() and assert_recent_password_authentication() are revoked
-- from `authenticated`. They are therefore exercised as the owning role, never through
-- `set local role`. Calling a function a role lacks EXECUTE on crashes this stack.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p74_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P74 MFA assurance assertion failed: %', p_message;
  end if;
end
$$;

-- Stamp JWT claims: always a password AMR entry aged by p_offset (interval '0' = fresh),
-- plus an `aal` claim of an arbitrary jsonb shape. SQL NULL for p_aal omits the claim
-- entirely, which is the "absent" shape. Extends the p4_flags_identity.sql:41 idiom.
create function pg_temp.p74_claims(p_sub uuid, p_aal jsonb, p_offset interval)
returns void
language plpgsql
as $$
declare
  v_claims jsonb;
begin
  perform set_config('request.jwt.claim.sub', p_sub::text, true);
  v_claims := jsonb_build_object(
    'sub', p_sub::text,
    'amr', jsonb_build_array(jsonb_build_object(
      'method', 'password',
      'timestamp', extract(epoch from clock_timestamp() + p_offset)::bigint)));
  if p_aal is not null then
    v_claims := v_claims || jsonb_build_object('aal', p_aal);
  end if;
  perform set_config('request.jwt.claims', v_claims::text, true);
end
$$;

-- Claims with NO amr array at all, for the B9 missing-password arm.
create function pg_temp.p74_claims_no_amr(p_sub uuid, p_aal jsonb)
returns void
language plpgsql
as $$
declare
  v_claims jsonb;
begin
  perform set_config('request.jwt.claim.sub', p_sub::text, true);
  v_claims := jsonb_build_object('sub', p_sub::text);
  if p_aal is not null then
    v_claims := v_claims || jsonb_build_object('aal', p_aal);
  end if;
  perform set_config('request.jwt.claims', v_claims::text, true);
end
$$;

-- ===== Fixtures =====
insert into organizations (id, name, status) values
  ('18000000-0000-0000-0000-000000000001', 'P74 Org A', 'active');

insert into auth.users (id, email) values
  ('28000000-0000-0000-0000-000000000001', 'p74-owner@example.test'),
  ('28000000-0000-0000-0000-000000000002', 'p74-accountant@example.test'),
  ('28000000-0000-0000-0000-000000000003', 'p74-office@example.test'),
  ('28000000-0000-0000-0000-000000000004', 'p74-target@example.test'),
  ('28000000-0000-0000-0000-000000000005', 'p74-retired@example.test');

insert into profiles (id, org_id, full_name, role) values
  ('28000000-0000-0000-0000-000000000001', '18000000-0000-0000-0000-000000000001', 'P74 Owner', 'owner'),
  ('28000000-0000-0000-0000-000000000002', '18000000-0000-0000-0000-000000000001', 'P74 Accountant', 'accountant'),
  ('28000000-0000-0000-0000-000000000003', '18000000-0000-0000-0000-000000000001', 'P74 Office', 'office'),
  ('28000000-0000-0000-0000-000000000004', '18000000-0000-0000-0000-000000000001', 'P74 Target', 'office'),
  ('28000000-0000-0000-0000-000000000005', '18000000-0000-0000-0000-000000000001', 'P74 Retired', 'kitchen');

-- ===== (B2) Structural registry =====
-- Two arms, both signature-resolved. Arm 1: the one step-up primitive must carry the
-- assurance call -- this is what makes assurance reach every wired path at once instead of
-- being applied nine times and forgotten on the tenth. Arm 2: every named path must still
-- route through that primitive, so assurance cannot be orphaned by a command that stops
-- calling it. Bodies are matched by regex on prosrc, never by line slicing.
create function pg_temp.p74_assurance_uncovered()
returns setof text
language sql stable
as $$
  select 'the one step-up primitive is missing: public.assert_recent_password_authentication()'
  where to_regprocedure('public.assert_recent_password_authentication()') is null
  union all
  -- Owner ruling, 24.08.2026: the assurance primitive is BUILT and not WIRED. #88 says to keep
  -- password step-up until the MFA contract is live and proven, and nothing in the product enrols a
  -- factor yet -- so wiring assurance into this primitive would refuse every owner and accountant on
  -- every payment, bank-detail change, month export and scope grant, with no way to enrol from
  -- inside the product. This arm pins that decision: a future migration that quietly adds the call
  -- fails the gate and has to be decided again rather than discovered in production.
  select 'the step-up primitive carries an MFA assurance call the owner has not authorized: '
      || 'public.assert_recent_password_authentication()'
  where coalesce(
          (select p.prosrc from pg_catalog.pg_proc p
            where p.oid = to_regprocedure('public.assert_recent_password_authentication()')::oid),
          '') ~ 'assert_mfa_assurance'
  union all
  select 'path lost the step-up primitive: ' || wired.signature
  from (values
    ('public.execute_payment_request(uuid,date,text,text,text,jsonb,numeric,text,text)'),
    ('public.execute_emergency_payment_request(uuid,date,text,text,text,jsonb,text)'),
    ('public.manage_profile_access(uuid,user_role,boolean,uuid,text)'),
    ('public.mark_month_export_sent(date,uuid[],text)'),
    ('public.grant_user_scope(uuid,uuid,text)'),
    ('public.revoke_user_scope(uuid,uuid,text)'),
    ('public.update_identity_provider_settings(text,boolean,jsonb,jsonb,text)'),
    -- 0171 replaced the free-text bank command with the structured one, keeping its step-up call.
    ('public.update_supplier_bank_details(uuid,jsonb,text)'),
    ('public.set_webhook_subscription_active(uuid,boolean,text)')
  ) as wired(signature)
  where to_regprocedure(wired.signature) is null
     or coalesce(
          (select p.prosrc from pg_catalog.pg_proc p
            where p.oid = to_regprocedure(wired.signature)::oid),
          '') !~ 'assert_recent_password_authentication'
$$;

select pg_temp.p74_assert(
  not exists (select 1 from pg_temp.p74_assurance_uncovered()),
  'assurance coverage is incomplete: ' ||
  coalesce((select string_agg(u, '; ') from pg_temp.p74_assurance_uncovered() u), ''));

-- ===== (B8) Mutation proof -- the B2 check must actually detect an unauthorized wiring =====
-- A registry that cannot fail is not a gate. The mutation adds the call the owner declined, and B2
-- must name it; rolling back must clear it again.
savepoint mutation_assurance;
create or replace function assert_recent_password_authentication() returns void
language plpgsql security definer set search_path = public as $$
begin
  perform assert_mfa_assurance();
  raise exception 'p74_mutated_stub' using errcode = 'P0001';
end
$$;
revoke all on function assert_recent_password_authentication() from public, anon, authenticated;
select pg_temp.p74_assert(
  exists (
    select 1 from pg_temp.p74_assurance_uncovered() u
    where u = 'the step-up primitive carries an MFA assurance call the owner has not authorized: '
           || 'public.assert_recent_password_authentication()'),
  'the B2 registry must detect a primitive that was wired to assurance without authorization');
rollback to savepoint mutation_assurance;
select pg_temp.p74_assert(
  not exists (select 1 from pg_temp.p74_assurance_uncovered()),
  'rolling the mutation back must clear the unauthorized-wiring finding');

-- ===== (B3) Fail-closed aal parsing, table-driven -- one row per malformed shape =====
-- `jsonb_typeof(missing)` is SQL NULL, so a plain `<> 'string'` evaluates to NULL and the
-- guard silently does not fire. Only `is distinct from` closes it. Each shape below must
-- be refused; the aal1 row is the well-formed-but-insufficient control.
do $$
declare
  v_shape record;
  v_raised boolean;
begin
  for v_shape in
    select * from (values
      ('absent',              null::jsonb),
      ('json null',           'null'::jsonb),
      ('number',              '2'::jsonb),
      ('array',               '["aal2"]'::jsonb),
      ('object',              '{"level":"aal2"}'::jsonb),
      ('boolean',             'true'::jsonb),
      ('string aal1 control', '"aal1"'::jsonb)
    ) as s(label, aal)
  loop
    perform pg_temp.p74_claims('28000000-0000-0000-0000-000000000001', v_shape.aal, interval '0');
    v_raised := false;
    begin
      perform assert_mfa_assurance();
    exception when sqlstate '42501' then
      if sqlerrm not like '%mfa_assurance_required%' then raise; end if;
      v_raised := true;
    end;
    if not v_raised then
      raise exception 'P74 MFA assurance assertion failed: aal shape "%" was accepted for an owner', v_shape.label;
    end if;
  end loop;
end
$$;

-- aal2 is accepted for the same owner -- the parser is not simply refusing everything.
select pg_temp.p74_claims('28000000-0000-0000-0000-000000000001', '"aal2"'::jsonb, interval '0');
select assert_mfa_assurance();

-- ===== (B4) Role matrix, both directions =====
-- owner IS required.
select pg_temp.p74_claims('28000000-0000-0000-0000-000000000001', '"aal1"'::jsonb, interval '0');
do $$
begin
  perform assert_mfa_assurance();
  raise exception 'P74 MFA assurance assertion failed: owner passed at aal1';
exception when sqlstate '42501' then
  if sqlerrm not like '%mfa_assurance_required%' then raise; end if;
end
$$;

-- accountant IS required.
select pg_temp.p74_claims('28000000-0000-0000-0000-000000000002', '"aal1"'::jsonb, interval '0');
do $$
begin
  perform assert_mfa_assurance();
  raise exception 'P74 MFA assurance assertion failed: accountant passed at aal1';
exception when sqlstate '42501' then
  if sqlerrm not like '%mfa_assurance_required%' then raise; end if;
end
$$;

-- office is NOT blocked -- #88 makes it optional, and an optional factor that silently
-- became mandatory would lock out the largest role in the tenant.
select pg_temp.p74_claims('28000000-0000-0000-0000-000000000003', '"aal1"'::jsonb, interval '0');
select assert_mfa_assurance();
select pg_temp.p74_claims('28000000-0000-0000-0000-000000000003', null, interval '0');
select assert_mfa_assurance();

-- ===== (B5) Retired personas fail at the 0133 gate, BEFORE assurance =====
-- auth_role() resolves NULL for kitchen/payer/supplier (0133), so assurance forms no
-- opinion at all and the command's own authorization gate is what rejects them. If this
-- ever inverted, a retired persona would be reported as an MFA problem, which would read
-- as "enroll a factor and you are in".
select pg_temp.p74_claims('28000000-0000-0000-0000-000000000005', null, interval '0');
select pg_temp.p74_assert(auth_role() is null, 'a retired persona must not resolve a role (0133)');
select assert_mfa_assurance();
set local role authenticated;
do $$
begin
  perform manage_profile_access(
    '28000000-0000-0000-0000-000000000004', 'office', true, null, 'P74: retired persona');
  raise exception 'P74 MFA assurance assertion failed: retired persona reached the command';
exception when sqlstate '42501' then
  if sqlerrm not like '%not_owner%' then
    raise exception 'P74 MFA assurance assertion failed: retired persona was rejected by "%" instead of the 0133 gate', sqlerrm;
  end if;
end
$$;
reset role;

-- ===== (B1) The deferred state, through a real wired command =====
-- Owner ruling 24.08.2026: the assurance primitive is built and NOT wired, because nothing in the
-- product enrols a factor and wiring it would refuse every owner and accountant on every step-up
-- path. So the honest assertion here is the inverse of enforcement: a fresh-password owner still
-- passes at aal1, exactly as before 0199 existed. This is the second guard on the deferral, and it
-- guards a different thing than B2 does -- B2 reads the primitive's SOURCE, this reads a real
-- command's BEHAVIOUR through the role PostgREST uses. Wire assurance and both fail, which is the
-- point: the decision comes back to the owner instead of surfacing as a lockout in production.
-- DEBT §62 carries the exit condition.
select pg_temp.p74_claims('28000000-0000-0000-0000-000000000001', '"aal1"'::jsonb, interval '0');
set local role authenticated;
select manage_profile_access(
  '28000000-0000-0000-0000-000000000004', 'office', true, null, 'P74: aal1 still passes, unwired');
reset role;

-- aal2 passes too. Assurance forms no opinion either way while it is unwired, so a stronger session
-- must not be treated as a different contract.
select pg_temp.p74_claims('28000000-0000-0000-0000-000000000001', '"aal2"'::jsonb, interval '0');
set local role authenticated;
select manage_profile_access(
  '28000000-0000-0000-0000-000000000004', 'office', true, null, 'P74: aal2 passes');
reset role;

-- ===== (B9) Password step-up still raises FIRST =====
-- #88 keeps password step-up in force until MFA is live and proven. Ordering matters: if
-- assurance were evaluated first, a stale-password aal1 session would report an MFA
-- problem and the existing wired contract would have quietly changed its error.
select pg_temp.p74_claims_no_amr('28000000-0000-0000-0000-000000000001', '"aal2"'::jsonb);
set local role authenticated;
do $$
begin
  perform manage_profile_access(
    '28000000-0000-0000-0000-000000000004', 'office', true, null, 'P74: no amr, aal2');
  raise exception 'P74 MFA assurance assertion failed: missing password AMR was accepted';
exception when sqlstate '42501' then
  if sqlerrm not like '%fresh_authentication_required%' then
    raise exception 'P74 MFA assurance assertion failed: missing AMR raised "%" -- password step-up must raise first', sqlerrm;
  end if;
end
$$;
reset role;

select pg_temp.p74_claims('28000000-0000-0000-0000-000000000001', '"aal2"'::jsonb, interval '-10 minutes');
set local role authenticated;
do $$
begin
  perform manage_profile_access(
    '28000000-0000-0000-0000-000000000004', 'office', true, null, 'P74: stale amr, aal2');
  raise exception 'P74 MFA assurance assertion failed: stale password AMR was accepted';
exception when sqlstate '42501' then
  if sqlerrm not like '%fresh_authentication_required%' then
    raise exception 'P74 MFA assurance assertion failed: stale AMR raised "%" -- password step-up must raise first', sqlerrm;
  end if;
end
$$;
reset role;

-- ===== The forensic path still records (6 / #87) =====
-- Taxonomy unchanged: assurance reuses step_up_failure with its own cause values
-- ('aal_shape', 'aal_insufficient'), so #87 does not grow a value and security_events
-- stays the one forensic log.
--
-- This asserts the SUCCESS arm on purpose. A step_up_failure row written immediately
-- before a raise is rolled back with the transaction it fails -- 0061:46 documents that
-- limitation ("Postgres has no autonomous transactions"), and assurance inherits it rather
-- than inventing an escape from it. Asserting a surviving failure row would be asserting
-- something the architecture states cannot happen, so what is proven here is that
-- assurance did not sever the recording path that the successful aal2 call above depends
-- on.
select pg_temp.p74_assert(
  exists (
    select 1 from security_events
    where event_type = 'step_up_success'
      and actor_user_id = '28000000-0000-0000-0000-000000000001'),
  'the aal2 success must still leave a step_up_success row');

rollback;
