-- p104 -- a platform writer carries the capability it was declared to need (0286).
--
-- THE GATE THIS SUITE IS. 0151 built the capability axis and said in its own header that every
-- capability except `customer.view` was DECLARED and not yet ENFORCED, each to be wired by the
-- wave that owns its surface. Five commands were never wired, so until 0286 any row in
-- `platform_admins` -- a support operator, a billing operator, an analyst whose four capabilities
-- are all reads, or an operator holding no role at all -- could suspend and reactivate any tenant,
-- flip any tenant's feature flags, and rewrite any tenant's approval, autonomy and assistant
-- policies. This file is the behavioural proof that it can no longer, and that the operators who
-- SHOULD be able to still can.
--
-- WHAT IT PROVES, and why each case is here rather than trusted:
--   1. The two capabilities 0286 added are declared as it says, and are held by exactly two roles.
--      A capability that quietly reached `support` would leave the hole open under a new name.
--   2. Each of the five commands refuses a narrowed operator BY NAME -- `not_platform_capability`,
--      not a generic 42501 -- and refuses an operator with membership and no role at all. Both
--      arms matter: the first is the realistic hire, the second is the fail-closed default.
--   3. The refusal is a refusal, not a rollback: no configuration row and no audit row appears.
--      A command that writes and then raises would pass a message assertion and still be a hole.
--   4. An operator who HOLDS the capability succeeds on all five, with the step-up the lifecycle
--      command has always demanded. A guard that closed the door on everybody would satisfy (2).
--   5. Every by-name refusal these four commands already made -- unknown flag, blank reason,
--      unknown policy, a loosening -- still fires with its own name. 0286 appended a check; it did
--      not replace the vocabulary the operator reads.
--   6. The structural claim 0286 asserts at migration time is still true of the LIVE bodies, and
--      no platform writer of this shape escaped the list.
--
-- Runs inside one transaction and rolls back. Every organization, user and operator it touches is
-- created here.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p104_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P104 platform capability assertion failed: %', p_message;
  end if;
end
$$;

-- The session-identity helper every platform suite uses (p50:17-33, p75:39, p85:22).
-- `p_fresh_password` mints the AMR shape assert_recent_password_authentication() (0061:51) wants.
create function pg_temp.p104_as(p_user uuid, p_fresh_password boolean default false)
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

create function pg_temp.p104_refused(p_sql text, p_expected text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm not like '%' || p_expected || '%' then
      raise exception 'P104 expected refusal %, got: %', p_expected, sqlerrm;
    end if;
    return;
  end;
  raise exception 'P104 expected refusal % but the statement succeeded: %', p_expected, p_sql;
end
$$;

-- =====================================================================================
-- 1. The declaration, before any fixture
-- =====================================================================================
select pg_temp.p104_assert(
  (select count(*) from private.platform_capability_definitions
    where capability in ('policy.configure', 'flag.configure')
      and sensitivity = 'high' and not requires_step_up and enforced_since = '0286') = 2,
  '0286 capabilities are not declared high / no-step-up / enforced_since 0286');

-- `requires_step_up = false` is not an oversight in this product: it is a promise that the body
-- calls assert_recent_password_authentication(), and 0286 records the console that has no such
-- flow. If a later wave sets the flag, the command must gain the call in the same migration.
select pg_temp.p104_assert(
  (select array_agg(role_key order by role_key) from platform_role_capabilities
    where capability = 'policy.configure') = array['customer_ops', 'super_admin']
  and (select array_agg(role_key order by role_key) from platform_role_capabilities
    where capability = 'flag.configure') = array['customer_ops', 'super_admin'],
  'a 0286 capability reached a role other than customer_ops and super_admin');

select pg_temp.p104_assert(
  (select enforced_since from private.platform_capability_definitions
    where capability = 'org.lifecycle') = '0286',
  'org.lifecycle still reads as declared-but-enforced-nowhere');

-- =====================================================================================
-- 2. Fixture
-- =====================================================================================
insert into public.organizations (id, name, status, created_at) values
  ('a4000000-0000-4000-8000-000000000001', 'P104 configuration tenant', 'active', now() - interval '30 days'),
  ('a4000000-0000-4000-8000-000000000002', 'P104 lifecycle tenant',     'active', now() - interval '30 days');

insert into auth.users (id, email) values
  ('a4100000-0000-4000-8000-000000000001', 'p104-super@example.test'),
  ('a4100000-0000-4000-8000-000000000002', 'p104-analyst@example.test'),
  ('a4100000-0000-4000-8000-000000000003', 'p104-noroles@example.test'),
  ('a4100000-0000-4000-8000-000000000004', 'p104-owner@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('a4100000-0000-4000-8000-000000000004', 'a4000000-0000-4000-8000-000000000001',
   'P104 tenant owner', 'owner');

insert into public.platform_admins (user_id, note) values
  ('a4100000-0000-4000-8000-000000000001', 'P104 super operator'),
  ('a4100000-0000-4000-8000-000000000002', 'P104 read-only analyst'),
  ('a4100000-0000-4000-8000-000000000003', 'P104 operator with no role assigned');

insert into public.platform_admin_roles (user_id, role_key) values
  ('a4100000-0000-4000-8000-000000000001', 'super_admin'),
  ('a4100000-0000-4000-8000-000000000002', 'analyst');
-- ...000003 stays deliberately unassigned. Membership without capability is the fail-closed
-- default 0151 designed and the state this suite must find refused.

select pg_temp.p104_assert(
  (select count(*) from platform_role_capabilities
    where role_key = 'analyst'
      and capability in ('org.lifecycle', 'policy.configure', 'flag.configure')) = 0,
  'the analyst fixture holds one of the three capabilities -- the negative arm proves nothing');

-- =====================================================================================
-- 3. The narrowed operator is refused BY NAME on all five commands
-- =====================================================================================
-- A fresh password is minted for the analyst too, so a refusal can only be about authority. If
-- the capability check ever moved behind the step-up, this arm would start reporting
-- `fresh_authentication_required` and say so.
select pg_temp.p104_as('a4100000-0000-4000-8000-000000000002', true);

select pg_temp.p104_refused(
  $$select public.set_organization_lifecycle(
      'a4000000-0000-4000-8000-000000000002', 'suspended', null, 'P104 analyst suspends')$$,
  'not_platform_capability');

select pg_temp.p104_refused(
  $$select public.platform_set_org_flag(
      'a4000000-0000-4000-8000-000000000001', 'receiving.barcode', true, null, null,
      'P104 analyst flips a flag')$$,
  'not_platform_capability');

select pg_temp.p104_refused(
  $$select public.platform_set_approval_policy(
      'a4000000-0000-4000-8000-000000000001', 'payment_request.approval', null, 2, true,
      'P104 analyst rewrites approvals')$$,
  'not_platform_capability');

select pg_temp.p104_refused(
  $$select public.platform_set_autonomy_policy(
      'a4000000-0000-4000-8000-000000000001', 'document.interpretation', true, 0.950,
      'P104 analyst grants autonomy')$$,
  'not_platform_capability');

select pg_temp.p104_refused(
  $$select public.platform_set_assistant_policy(
      'a4000000-0000-4000-8000-000000000001', 'assistant.confirmed_actions', true,
      'P104 analyst opens the execution road')$$,
  'not_platform_capability');

-- The same five, for an operator who is a member and holds no role at all.
select pg_temp.p104_as('a4100000-0000-4000-8000-000000000003', true);
select pg_temp.p104_assert(
  public.is_platform_admin() and cardinality(public.platform_my_capabilities()) = 0,
  'the role-less fixture operator is not a member, or was handed capabilities -- fixture is wrong');

select pg_temp.p104_refused(
  $$select public.set_organization_lifecycle(
      'a4000000-0000-4000-8000-000000000002', 'suspended', null, 'P104 role-less suspends')$$,
  'not_platform_capability');
select pg_temp.p104_refused(
  $$select public.platform_set_org_flag(
      'a4000000-0000-4000-8000-000000000001', 'receiving.barcode', true, null, null,
      'P104 role-less flips a flag')$$,
  'not_platform_capability');
select pg_temp.p104_refused(
  $$select public.platform_set_approval_policy(
      'a4000000-0000-4000-8000-000000000001', 'payment_request.approval', null, 2, true,
      'P104 role-less rewrites approvals')$$,
  'not_platform_capability');
select pg_temp.p104_refused(
  $$select public.platform_set_autonomy_policy(
      'a4000000-0000-4000-8000-000000000001', 'document.interpretation', true, 0.950,
      'P104 role-less grants autonomy')$$,
  'not_platform_capability');
select pg_temp.p104_refused(
  $$select public.platform_set_assistant_policy(
      'a4000000-0000-4000-8000-000000000001', 'assistant.confirmed_actions', true,
      'P104 role-less opens the execution road')$$,
  'not_platform_capability');

-- A tenant owner is still refused earlier and by the older name: membership is asked first, and
-- 0286 must not have turned "you are not one of us" into "you lack a capability".
select pg_temp.p104_as('a4100000-0000-4000-8000-000000000004', true);
select pg_temp.p104_refused(
  $$select public.platform_set_org_flag(
      'a4000000-0000-4000-8000-000000000001', 'receiving.barcode', true, null, null,
      'P104 tenant owner flips a flag')$$,
  'not_platform_admin');

-- ===== The refusal wrote nothing =====
-- A command that inserts and then raises passes every message assertion above and is still the
-- hole. Three tables that must have no row at all, and one that must be UNCHANGED: 0210:74 and
-- 0211:160 give every newborn organization its assistant flags and its four autonomy policies, so
-- "no autonomy row" would be a false claim about a row the birth trigger wrote. `receiving.barcode`
-- (0059:39) is used throughout precisely because no birth trigger touches it.
select pg_temp.p104_as(null);
select pg_temp.p104_assert(
  (select count(*) from public.org_flag_configurations
    where org_id = 'a4000000-0000-4000-8000-000000000001' and flag_key = 'receiving.barcode') = 0
  and (select count(*) from public.approval_policy_configurations
    where org_id = 'a4000000-0000-4000-8000-000000000001') = 0
  and (select count(*) from public.org_assistant_policies
    where org_id = 'a4000000-0000-4000-8000-000000000001') = 0,
  'a refused command left a configuration row behind');
select pg_temp.p104_assert(
  (select min_confidence from public.org_autonomy_policies
    where org_id = 'a4000000-0000-4000-8000-000000000001'
      and policy_key = 'document.interpretation') = 0.900,
  'a refused autonomy command moved the threshold on the row the birth grant wrote');
select pg_temp.p104_assert(
  (select count(*) from public.audit_logs
    where org_id in ('a4000000-0000-4000-8000-000000000001',
                     'a4000000-0000-4000-8000-000000000002')
      and action in ('org_flag_configured', 'approval_policy_configured',
                     'autonomy_policy_configured', 'assistant_policy_configured',
                     'organization_lifecycle_changed')) = 0,
  'a refused command left an audit row behind');
select pg_temp.p104_assert(
  (select status from public.organizations
    where id = 'a4000000-0000-4000-8000-000000000002') = 'active',
  'a refused lifecycle command changed the tenant status anyway');

-- =====================================================================================
-- 4. The operator who holds the capability still does the work
-- =====================================================================================
select pg_temp.p104_as('a4100000-0000-4000-8000-000000000001', true);

select pg_temp.p104_assert(
  public.platform_set_org_flag(
    'a4000000-0000-4000-8000-000000000001', 'receiving.barcode', true, null, null,
    'P104 super operator turns the assistant panel on') is not null,
  'an operator holding flag.configure could not set a flag');

select pg_temp.p104_assert(
  public.platform_set_approval_policy(
    'a4000000-0000-4000-8000-000000000001', 'payment_request.approval', 1000, 2, true,
    'P104 super operator tightens payment approval') is not null,
  'an operator holding policy.configure could not set an approval policy');

select pg_temp.p104_assert(
  public.platform_set_autonomy_policy(
    'a4000000-0000-4000-8000-000000000001', 'document.interpretation', true, 0.950,
    'P104 super operator tightens the autonomy floor') is not null,
  'an operator holding policy.configure could not set an autonomy policy');

select pg_temp.p104_assert(
  public.platform_set_assistant_policy(
    'a4000000-0000-4000-8000-000000000001', 'assistant.confirmed_actions', true,
    'P104 super operator opens confirmed actions') is not null,
  'an operator holding policy.configure could not set an assistant policy');

-- The four writes landed as values, not merely as return codes: a command that returned an id and
-- wrote nothing would satisfy every `is not null` above.
select pg_temp.p104_assert(
  (select state from public.org_flag_configurations
    where org_id = 'a4000000-0000-4000-8000-000000000001'
      and flag_key = 'receiving.barcode' and unit_id is null)
  and (select required_approvals = 2 and step_up_required from public.approval_policy_configurations
    where org_id = 'a4000000-0000-4000-8000-000000000001'
      and policy_key = 'payment_request.approval')
  and (select min_confidence = 0.950 from public.org_autonomy_policies
    where org_id = 'a4000000-0000-4000-8000-000000000001'
      and policy_key = 'document.interpretation')
  and (select enabled from public.org_assistant_policies
    where org_id = 'a4000000-0000-4000-8000-000000000001'
      and policy_key = 'assistant.confirmed_actions'),
  'a capable operator got an id back but the configuration did not change');

select public.set_organization_lifecycle(
  'a4000000-0000-4000-8000-000000000002', 'suspended', null,
  'P104 super operator suspends the lifecycle tenant');
select pg_temp.p104_assert(
  (select status from public.organizations
    where id = 'a4000000-0000-4000-8000-000000000002') = 'suspended',
  'an operator holding org.lifecycle could not suspend a tenant');

-- ...and back, because a lever that only goes one way is half a lever.
select public.set_organization_lifecycle(
  'a4000000-0000-4000-8000-000000000002', 'active', null,
  'P104 super operator reactivates the lifecycle tenant');
select pg_temp.p104_assert(
  (select status from public.organizations
    where id = 'a4000000-0000-4000-8000-000000000002') = 'active',
  'an operator holding org.lifecycle could not reactivate a tenant');

-- ===== The widening the header declares, measured rather than asserted in prose =====
-- 0286 routes the four configuration commands through a preamble that opens
-- `app.organization_lifecycle_writer`, so an operator may now configure a tenant that
-- private.organization_row_write_guard (0103:2227) had made read-only -- where before, both the
-- configuration row and its audit row were refused. The lifecycle tenant is suspended again to
-- stand still while that is measured on it, then reactivated.
select public.set_organization_lifecycle(
  'a4000000-0000-4000-8000-000000000002', 'suspended', null,
  'P104 suspend before measuring the configuration widening');
select pg_temp.p104_assert(
  (select status from public.organizations
    where id = 'a4000000-0000-4000-8000-000000000002') = 'suspended',
  'the fixture tenant is not suspended -- the widening arm would prove nothing');

-- The guard really is shut for this tenant: the preamble set the writer handshake when it
-- suspended, so it is cleared first (the p44:150 idiom) and a bare INSERT is refused by name.
-- Without this line the arm below could pass because the tenant was writable all along.
select set_config('app.organization_lifecycle_writer', '', true);
select pg_temp.p104_refused(
  $$insert into public.org_flag_configurations (org_id, flag_key, state, targeting, unit_id)
     values ('a4000000-0000-4000-8000-000000000002', 'receiving.barcode', true, '{}'::jsonb, null)$$,
  'organization_read_only');
select pg_temp.p104_assert(
  public.platform_set_org_flag(
    'a4000000-0000-4000-8000-000000000002', 'receiving.barcode', true, null, null,
    'P104 configure a suspended tenant') is not null,
  'a capable operator could not configure a SUSPENDED tenant -- the tenant write handshake the '
  || 'preamble opens did not reach the write guard');
select pg_temp.p104_assert(
  (select state from public.org_flag_configurations
    where org_id = 'a4000000-0000-4000-8000-000000000002'
      and flag_key = 'receiving.barcode' and unit_id is null)
  and (select count(*) from public.audit_logs
    where org_id = 'a4000000-0000-4000-8000-000000000002'
      and action = 'org_flag_configured') = 1,
  'configuring a suspended tenant returned an id but wrote neither the row nor its audit entry');

select public.set_organization_lifecycle(
  'a4000000-0000-4000-8000-000000000002', 'active', null,
  'P104 reactivate after the widening arm');

-- The step-up the lifecycle command has demanded since 0134 is untouched by 0286: the same
-- operator, the same capability, no fresh password, and the answer must still be no.
select pg_temp.p104_as('a4100000-0000-4000-8000-000000000001', false);
select pg_temp.p104_refused(
  $$select public.set_organization_lifecycle(
      'a4000000-0000-4000-8000-000000000002', 'suspended', null,
      'P104 capable operator without a fresh password')$$,
  'fresh_authentication_required');

-- =====================================================================================
-- 5. The named refusals the four commands already made still fire by their own names
-- =====================================================================================
select pg_temp.p104_as('a4100000-0000-4000-8000-000000000001', true);

select pg_temp.p104_refused(
  $$select public.platform_set_org_flag(
      'a4000000-0000-4000-8000-000000000001', 'p104.no.such.flag', true, null, null,
      'P104 unknown flag')$$,
  'flag_unknown');
select pg_temp.p104_refused(
  $$select public.platform_set_org_flag(
      'a4000000-0000-4000-8000-000000000001', 'receiving.barcode', true, null, null, '   ')$$,
  'flag_reason_required');
select pg_temp.p104_refused(
  $$select public.platform_set_approval_policy(
      'a4000000-0000-4000-8000-000000000001', 'payment_request.approval', null, 2, true, '  ')$$,
  'approval_policy_reason_required');
select pg_temp.p104_refused(
  $$select public.platform_set_autonomy_policy(
      'a4000000-0000-4000-8000-000000000001', 'document.interpretation', true, 0.800,
      'P104 below the documented floor')$$,
  'autonomy_policy_not_tightening');
select pg_temp.p104_refused(
  $$select public.platform_set_assistant_policy(
      'a4000000-0000-4000-8000-000000000001', 'p104.no.such.policy', true,
      'P104 unknown assistant policy')$$,
  'assistant_policy_unknown');
select pg_temp.p104_refused(
  $$select public.platform_set_autonomy_policy(
      'a4000000-0000-4000-8000-00000000dead', 'document.interpretation', true, 0.950,
      'P104 unknown organization')$$,
  'organization_unknown');

select pg_temp.p104_as(null);

-- =====================================================================================
-- 6. The structural assertion 0286 makes is live, not merely historical
-- =====================================================================================
-- Bodies are read with carriage returns stripped, so this means the same thing whether the
-- migration was applied from Windows or from a Linux runner (0209).
do $p104_structure$
declare
  v_row       record;
  v_body      text;
  v_uncovered text;
begin
  for v_row in
    select *
    from (values
      ('public.set_organization_lifecycle(uuid,public.org_status,timestamptz,text,text,text)', 'org.lifecycle'),
      ('public.platform_set_org_flag(uuid,text,boolean,jsonb,uuid,text)',                      'flag.configure'),
      ('public.platform_set_approval_policy(uuid,text,numeric,integer,boolean,text)',          'policy.configure'),
      ('public.platform_set_autonomy_policy(uuid,text,boolean,numeric,text)',                  'policy.configure'),
      ('public.platform_set_assistant_policy(uuid,text,boolean,text)',                         'policy.configure'),
      ('public.platform_set_org_subscription(uuid,text,text,text,text)',                       'subscription.edit'),
      ('public.platform_set_user_access(uuid,public.user_role,boolean,text)',                  'user.access'),
      ('public.platform_set_operator_roles(uuid,text[],text)',                                 'operator.manage')
    ) as t(signature, capability)
  loop
    if to_regprocedure(v_row.signature) is null then
      raise exception 'P104: % is not in the catalogue under that signature', v_row.signature;
    end if;
    select replace(proc.prosrc, e'\r', '') into v_body
    from pg_catalog.pg_proc proc where proc.oid = v_row.signature::regprocedure;
    if strpos(v_body, v_row.capability) = 0 then
      raise exception 'P104: % lost the capability % from its body', v_row.signature, v_row.capability;
    end if;
    if position('assert_platform_command' in v_body) = 0
       and position('assert_platform_staff_command' in v_body) = 0
       and position('platform_has_capability' in v_body) = 0 then
      raise exception 'P104: % names its capability but calls no preamble that reads one',
                      v_row.signature;
    end if;
    if not has_function_privilege('authenticated', v_row.signature, 'execute')
       or has_function_privilege('anon', v_row.signature, 'execute') then
      raise exception 'P104: % is unreachable by the browser role or reachable by anon',
                      v_row.signature;
    end if;
  end loop;

  -- Completeness. Without this arm the loop above says nothing about the ninth platform writer
  -- somebody adds next month. `not exists` rather than `not in`, so a signature that stopped
  -- resolving reports the function it was covering instead of turning the whole check NULL.
  select string_agg(candidate.signature, e'\n' order by candidate.signature) into v_uncovered
  from (
    select proc.oid::regprocedure::text as signature, proc.oid as oid
    from pg_catalog.pg_proc proc
    join pg_catalog.pg_namespace space on space.oid = proc.pronamespace
    where space.nspname = 'public'
      and proc.prosecdef
      and (proc.proname like 'platform\_set\_%' or proc.proname like 'set\_organization\_%')
      and has_function_privilege('authenticated', proc.oid, 'execute')
  ) candidate
  where not exists (
    select 1
    from (values
      ('public.set_organization_lifecycle(uuid,public.org_status,timestamptz,text,text,text)'),
      ('public.platform_set_org_flag(uuid,text,boolean,jsonb,uuid,text)'),
      ('public.platform_set_approval_policy(uuid,text,numeric,integer,boolean,text)'),
      ('public.platform_set_autonomy_policy(uuid,text,boolean,numeric,text)'),
      ('public.platform_set_assistant_policy(uuid,text,boolean,text)'),
      ('public.platform_set_org_subscription(uuid,text,text,text,text)'),
      ('public.platform_set_user_access(uuid,public.user_role,boolean,text)'),
      ('public.platform_set_operator_roles(uuid,text[],text)'),
      ('public.platform_set_customer_account(uuid,uuid,date,text)'),
      ('public.platform_set_onboarding_step(uuid,text,text,text)'),
      -- The one platform writer of this shape that still carries NO capability. 0286 records it
      -- by name in its header as a standing finding rather than an omission; when it is wired,
      -- this line moves up into the mapping above.
      ('public.platform_set_price_list_automation_scope(uuid,uuid,text,uuid,text)')
    ) as covered(signature)
    where to_regprocedure(covered.signature)::oid = candidate.oid
  );
  if v_uncovered is not null then
    raise exception e'P104: platform writer(s) that no capability list covers:\n%', v_uncovered;
  end if;

  raise notice 'p104 passed: five commands, two narrowed operators, six cases';
end
$p104_structure$;

rollback;
