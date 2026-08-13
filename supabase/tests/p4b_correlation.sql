-- P4b correlation-id harness for 0062. Run only against an isolated local database with
-- every migration applied. The transaction is rolled back.
--
-- What it proves for the correlation contract:
--   (a) a simulated PostgREST header (`request.headers` GUC) lands in
--       audit_logs.correlation_id through an EXISTING reasoned command -- revoke_invitation
--       -- whose body was not edited for correlation (asserted structurally against
--       pg_proc), i.e. the column DEFAULT alone carries the id;
--   (b) an explicit `app.correlation_id` GUC (the server-minted root id) takes precedence
--       over the header, both in the helper and at the write path;
--   (c) a malformed headers JSON, a non-uuid header value and a garbage GUC value all fail
--       to NULL -- the helper never raises, and an audited command still succeeds while
--       recording NULL;
--   (d) a service-role direct insert with explicit columns (the check-p0-security.ps1
--       fixture path) still evaluates the DEFAULT -- proving service_role kept EXECUTE on
--       the helper after the 0062 revoke;
--   (e) with neither source set the helper answers NULL cleanly.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p4b_assert(p_condition boolean, p_message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P4b correlation assertion failed: %', p_message;
  end if;
end
$$;

-- JWT-claims stamp, the p4_flags_identity.sql / p1_financial_commands.sql:1219-1225 idiom.
create function pg_temp.p4b_claims(p_sub uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claim.sub', p_sub::text, true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_sub::text)::text, true);
end
$$;

-- ===== Trusted fixtures (no JWT: migration/seed-style work) =====

insert into organizations (id, name, status) values
  ('18000000-0000-0000-0000-000000000001', 'P4b correlation tenant', 'active');

insert into auth.users (id, email) values
  ('28000000-0000-0000-0000-000000000001', 'p4b-owner@example.test');

insert into profiles (id, org_id, full_name, role) values
  ('28000000-0000-0000-0000-000000000001', '18000000-0000-0000-0000-000000000001',
   'P4b Owner', 'owner');

insert into invitations (id, org_id, email, role, token_hash, expires_at, invited_by) values
  ('48000000-0000-0000-0000-000000000001', '18000000-0000-0000-0000-000000000001',
   'p4b-invitee-1@example.test', 'office', 'p4b-token-hash-1', now() + interval '7 days',
   '28000000-0000-0000-0000-000000000001'),
  ('48000000-0000-0000-0000-000000000002', '18000000-0000-0000-0000-000000000001',
   'p4b-invitee-2@example.test', 'office', 'p4b-token-hash-2', now() + interval '7 days',
   '28000000-0000-0000-0000-000000000001'),
  ('48000000-0000-0000-0000-000000000003', '18000000-0000-0000-0000-000000000001',
   'p4b-invitee-3@example.test', 'office', 'p4b-token-hash-3', now() + interval '7 days',
   '28000000-0000-0000-0000-000000000001');

-- ===== (e) Neither source set: NULL, cleanly =====

select pg_temp.p4b_assert(
  public.request_correlation_id() is null,
  'helper must answer NULL when neither GUC nor header is set');

-- ===== (c) Malformed inputs fail to NULL, never raise =====

select set_config('request.headers', 'this is not json', true);
select pg_temp.p4b_assert(
  public.request_correlation_id() is null,
  'malformed request.headers JSON must fail to NULL');

select set_config('request.headers', '{"x-correlation-id":"not-a-uuid"}', true);
select pg_temp.p4b_assert(
  public.request_correlation_id() is null,
  'non-uuid header value must fail to NULL');

select set_config('app.correlation_id', 'garbage-root-id', true);
select set_config('request.headers',
  '{"x-correlation-id":"a4b00000-0000-4000-8000-00000000000a"}', true);
select pg_temp.p4b_assert(
  public.request_correlation_id() is null,
  'a garbage app.correlation_id wins the coalesce and must still fail to NULL');
select set_config('app.correlation_id', '', true);

-- ===== (a) Simulated PostgREST header reaches the column through an UNMODIFIED command =====

-- Structural proof first: no revoke_invitation overload was edited for correlation --
-- the id below can only arrive through the 0062 column DEFAULT.
select pg_temp.p4b_assert(
  not exists (
    select 1 from pg_proc
    where proname = 'revoke_invitation' and prosrc ilike '%correlation%'),
  'revoke_invitation must not mention correlation -- the DEFAULT alone carries the id');

select set_config('request.headers',
  '{"x-correlation-id":"a4b00000-0000-4000-8000-00000000000a"}', true);
select pg_temp.p4b_claims('28000000-0000-0000-0000-000000000001');
set local role authenticated;
select revoke_invitation('48000000-0000-0000-0000-000000000001',
  'P4b header correlation proof');
reset role;

select pg_temp.p4b_assert(
  (select correlation_id from audit_logs
   where action = 'invitation_revoked'
     and entity_id = '48000000-0000-0000-0000-000000000001')
  = 'a4b00000-0000-4000-8000-00000000000a'::uuid,
  'the x-correlation-id header must land on the reasoned-command audit row');

-- ===== (b) app.correlation_id (server-minted root) wins over the header =====

select set_config('app.correlation_id', 'a4b00000-0000-4000-8000-00000000000b', true);
select pg_temp.p4b_assert(
  public.request_correlation_id() = 'a4b00000-0000-4000-8000-00000000000b'::uuid,
  'the app.correlation_id GUC must take precedence over the header in the helper');

set local role authenticated;
select revoke_invitation('48000000-0000-0000-0000-000000000002',
  'P4b GUC precedence proof');
reset role;

select pg_temp.p4b_assert(
  (select correlation_id from audit_logs
   where action = 'invitation_revoked'
     and entity_id = '48000000-0000-0000-0000-000000000002')
  = 'a4b00000-0000-4000-8000-00000000000b'::uuid,
  'the GUC root id must win over the header at the write path');

-- ===== (c, write path) A malformed header must not fail the audited command =====

select set_config('app.correlation_id', '', true);
select set_config('request.headers', '{"x-correlation-id":"still-not-a-uuid"}', true);
set local role authenticated;
select revoke_invitation('48000000-0000-0000-0000-000000000003',
  'P4b malformed header fail-to-NULL proof');
reset role;

select pg_temp.p4b_assert(
  exists (
    select 1 from audit_logs
    where action = 'invitation_revoked'
      and entity_id = '48000000-0000-0000-0000-000000000003'
      and correlation_id is null),
  'a malformed header must record NULL, not fail the reasoned command');

-- ===== (d) The service_role direct-insert path still evaluates the DEFAULT =====

select set_config('request.headers',
  '{"x-correlation-id":"a4b00000-0000-4000-8000-00000000000d"}', true);
set local role service_role;
insert into audit_logs (org_id, user_id, action, entity_type, entity_id, reason) values
  ('18000000-0000-0000-0000-000000000001', '28000000-0000-0000-0000-000000000001',
   'p4b_service_probe', 'organizations', '18000000-0000-0000-0000-000000000001',
   'P4b service_role default proof');
reset role;

select pg_temp.p4b_assert(
  (select correlation_id from audit_logs where action = 'p4b_service_probe')
  = 'a4b00000-0000-4000-8000-00000000000d'::uuid,
  'a service_role explicit-column insert must still get the DEFAULT (EXECUTE survives 0062)');

rollback;

\echo 'p4b_correlation_passed'
