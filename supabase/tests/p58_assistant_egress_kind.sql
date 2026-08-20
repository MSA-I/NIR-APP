-- P58 -- the eighth egress kind: assistant enters the leased-egress boundary (0166) with the
-- same fencing as the seven before it -- service-only, active-tenant-only, TTL-bounded,
-- idempotent per (org, kind, correlation) -- and the boundary stays closed to a ninth value.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p58_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P58 assistant egress assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p58_service()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end
$$;

create function pg_temp.p58_authenticated()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '68000000-0000-4000-8000-000000000001', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    '{"sub":"68000000-0000-4000-8000-000000000001","role":"authenticated","amr":[]}', true);
end
$$;

create function pg_temp.p58_expect_error(p_sql text, p_fragment text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
    raise exception 'P58 expected error containing %, statement succeeded: %', p_fragment, p_sql;
  exception when others then
    if sqlerrm like 'P58 expected error%' or position(p_fragment in sqlerrm) = 0 then
      raise;
    end if;
  end;
end
$$;

create function pg_temp.p58_operator(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', p_user, 'role', 'authenticated',
    'amr', jsonb_build_array(jsonb_build_object(
      'method', 'password', 'timestamp', extract(epoch from clock_timestamp())
    ))
  )::text, true);
end
$$;

-- ===== Fixture =====
-- Both organizations start active; the second is then suspended through the real lifecycle
-- command rather than a fabricated row, because the organizations write guard (0134) refuses a
-- direct fixture write against a suspended tenant -- the same fence the product runs behind.
insert into public.organizations (id, name, status) values
  ('58000000-0000-4000-8000-000000000001', 'P58 active tenant', 'active'),
  ('58000000-0000-4000-8000-000000000002', 'P58 suspended tenant', 'active');

insert into auth.users (id, email) values
  ('68000000-0000-4000-8000-000000000002', 'super-p58@example.test');
insert into public.platform_admins (user_id, note) values
  ('68000000-0000-4000-8000-000000000002', 'P58 super operator');
insert into public.platform_admin_roles (user_id, role_key) values
  ('68000000-0000-4000-8000-000000000002', 'super_admin');

select pg_temp.p58_operator('68000000-0000-4000-8000-000000000002');
select public.set_organization_lifecycle(
  '58000000-0000-4000-8000-000000000002', 'suspended', null,
  'P58: suspend before proving the egress refusal');

-- ===== The table constraint: all eight kinds in, a ninth out =====
do $$
declare
  v_kind text;
begin
  foreach v_kind in array array[
    'document_interpretation', 'invitation_email', 'push_notification',
    'integration_webhook', 'document_signed_url', 'whatsapp_reminder',
    'organization_logo_storage', 'assistant'
  ] loop
    insert into private.organization_external_egress_leases (
      org_id, kind, correlation_id, expires_at
    ) values (
      '58000000-0000-4000-8000-000000000001', v_kind, gen_random_uuid(),
      statement_timestamp() + interval '60 seconds'
    );
  end loop;
end
$$;
select pg_temp.p58_assert(
  (select count(distinct kind) from private.organization_external_egress_leases
    where org_id = '58000000-0000-4000-8000-000000000001') = 8,
  'the table constraint did not accept all eight kinds');

select pg_temp.p58_expect_error(
  $$insert into private.organization_external_egress_leases (org_id, kind, correlation_id, expires_at)
    values ('58000000-0000-4000-8000-000000000001', 'assistant_v2', gen_random_uuid(),
            statement_timestamp() + interval '60 seconds')$$,
  'organization_external_egress_leases_kind_check');

-- assistant has NO expiry carve-out: the ordinary unacknowledged 120-second cap refuses at the
-- constraint, exactly as it would for any of the original seven.
select pg_temp.p58_expect_error(
  $$insert into private.organization_external_egress_leases (org_id, kind, correlation_id, expires_at)
    values ('58000000-0000-4000-8000-000000000001', 'assistant', gen_random_uuid(),
            statement_timestamp() + interval '121 seconds')$$,
  'organization_external_egress_expiry_check');

-- ===== The reservation function: assistant behaves like the seven before it =====
select pg_temp.p58_service();
set local role service_role;

select pg_temp.p58_assert(
  (select (result ->> 'egress_allowed')::boolean
      and result ->> 'lease_token' is not null
      and not (result ->> 'idempotent')::boolean
      and result ->> 'kind' = 'assistant'
   from (select public.service_reserve_organization_external_egress(
     '58000000-0000-4000-8000-000000000001', 'assistant',
     '58000000-0000-4000-8000-00000000c001', 90
   ) result) reserved),
  'an active organization was not granted a fresh assistant lease');

-- Replay of the same (org, kind, correlation) returns the SAME live lease, idempotently.
select result ->> 'lease_id' as lease_a,
       result ->> 'lease_token' as lease_token_a
from (select public.service_reserve_organization_external_egress(
  '58000000-0000-4000-8000-000000000001', 'assistant',
  '58000000-0000-4000-8000-00000000c002', 90
) result) reserved \gset
select pg_temp.p58_assert(
  (select result ->> 'lease_id' = :'lease_a'
      and result ->> 'lease_token' = :'lease_token_a'
      and (result ->> 'idempotent')::boolean
      and (result ->> 'egress_allowed')::boolean
   from (select public.service_reserve_organization_external_egress(
     '58000000-0000-4000-8000-000000000001', 'assistant',
     '58000000-0000-4000-8000-00000000c002', 90
   ) result) repeated),
  'replaying the same (org, assistant, correlation) did not return the same live lease idempotently');

-- The other seven kinds still reserve after the list grew.
do $$
declare
  v_kind text;
  v_result jsonb;
  v_i integer := 0;
begin
  foreach v_kind in array array[
    'document_interpretation', 'invitation_email', 'push_notification',
    'integration_webhook', 'document_signed_url', 'whatsapp_reminder',
    'organization_logo_storage'
  ] loop
    v_i := v_i + 1;
    v_result := public.service_reserve_organization_external_egress(
      '58000000-0000-4000-8000-000000000001', v_kind,
      ('58000000-0000-4000-8000-00000000d00' || v_i)::uuid, 90);
    if not (v_result ->> 'egress_allowed')::boolean then
      raise exception 'P58: kind % was refused after assistant was added', v_kind;
    end if;
  end loop;
end
$$;

-- A ninth, invented kind is refused by the function's own closed list.
select pg_temp.p58_expect_error(
  $$select public.service_reserve_organization_external_egress(
      '58000000-0000-4000-8000-000000000001', 'assistant_v2',
      '58000000-0000-4000-8000-00000000c003', 90)$$,
  'organization_external_egress_reservation_invalid');

-- The TTL bound did not move: 121 seconds is out, and so is 4.
select pg_temp.p58_expect_error(
  $$select public.service_reserve_organization_external_egress(
      '58000000-0000-4000-8000-000000000001', 'assistant',
      '58000000-0000-4000-8000-00000000c004', 121)$$,
  'organization_external_egress_reservation_invalid');
select pg_temp.p58_expect_error(
  $$select public.service_reserve_organization_external_egress(
      '58000000-0000-4000-8000-000000000001', 'assistant',
      '58000000-0000-4000-8000-00000000c005', 4)$$,
  'organization_external_egress_reservation_invalid');

-- A suspended organization is refused, and the refusal writes nothing.
select pg_temp.p58_expect_error(
  $$select public.service_reserve_organization_external_egress(
      '58000000-0000-4000-8000-000000000002', 'assistant',
      '58000000-0000-4000-8000-00000000c006', 90)$$,
  'organization_external_egress_not_allowed');
reset role;
select pg_temp.p58_assert(
  not exists (
    select 1 from private.organization_external_egress_leases
    where org_id = '58000000-0000-4000-8000-000000000002'),
  'a refused reservation for a suspended organization still wrote a lease');

-- ===== Service-only, at both fences =====
-- Pin the grant surface through the catalog instead of issuing denied EXECUTE:
-- the local Supabase PostgreSQL image can terminate the backend on that generic
-- ACL path before PL/pgSQL can catch the expected error.
select pg_temp.p58_assert(
  not has_function_privilege(
    'authenticated',
    'public.service_reserve_organization_external_egress(uuid,text,uuid,integer)',
    'execute')
  and has_function_privilege(
    'service_role',
    'public.service_reserve_organization_external_egress(uuid,text,uuid,integer)',
    'execute'),
  'the reservation function is not service-role-only');

-- The body guard: a caller that CAN execute but does not carry a service_role JWT is refused
-- by the in-function check, independently of grants.
select pg_temp.p58_authenticated();
select pg_temp.p58_expect_error(
  $$select public.service_reserve_organization_external_egress(
      '58000000-0000-4000-8000-000000000001', 'assistant',
      '58000000-0000-4000-8000-00000000c008', 90)$$,
  'service_role_required');

-- ===== The live body is the reviewed body =====
-- 0166 pins the replaced function to the hash of the reviewed source (0132 plus 'assistant',
-- nothing else). The suite re-checks the same pin so drift between migration and database is
-- caught here, not in production.
select pg_temp.p58_assert(
  (select md5(replace(proc.prosrc, e'\r', ''))
   from pg_catalog.pg_proc proc
   where proc.oid = pg_catalog.to_regprocedure(
     'public.service_reserve_organization_external_egress(uuid,text,uuid,integer)')
     and proc.prosecdef) = 'aa98553801b844f570f6a3d9c90b1133',
  'the live reservation function is not the reviewed 0166 body');

rollback;

\echo 'p58_assistant_egress_kind_passed'
