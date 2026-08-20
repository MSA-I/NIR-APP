-- P56 -- Assistant foundations (0164): a conversation belongs to the person who had it, an owner
-- reads cost and health but never text, an unstated quota refuses rather than allows, the hourly
-- rate limit is counted in the database, the confirmed-actions switch is a reasoned policy and
-- not a flag, the proposal state machine is a database fact, and deletion/retention remove
-- dialogue while the audit ledger does not move.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p56_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P56 assistant assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p56_as(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_user, 'amr', '[]'::jsonb)::text, true);
end
$$;

create function pg_temp.p56_capabilities(p_history boolean)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'ui', true,
    'history', p_history,
    'drafts', false,
    'confirmedActions', false
  )
$$;

create function pg_temp.p56_lease(
  p_org uuid,
  p_run uuid,
  p_outcome text default 'delivered'
) returns jsonb
language plpgsql security definer set search_path = public, private, pg_temp as $$
declare
  v_lease private.organization_external_egress_leases;
begin
  insert into private.organization_external_egress_leases (
    org_id, kind, correlation_id, status, outcome, evidence_code,
    reserved_at, expires_at, settled_at
  ) values (
    p_org, 'assistant', p_run, 'settled', p_outcome, 'p56_assistant_run',
    statement_timestamp(), statement_timestamp() + interval '60 seconds', statement_timestamp()
  ) returning * into v_lease;
  insert into private.organization_external_egress_evidence (
    lease_id, org_id, kind, correlation_id, outcome, evidence_code,
    evidence, evidence_sha256
  ) values (
    v_lease.lease_id, p_org, 'assistant', p_run, p_outcome, 'p56_assistant_run',
    '{}'::jsonb, repeat('a', 64)
  );
  return jsonb_build_object(
    'lease_id', v_lease.lease_id,
    'lease_token', v_lease.lease_token
  );
end
$$;

-- ===== Structural claims =====
select pg_temp.p56_assert(
  (select count(*) from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace space on space.oid = relation.relnamespace
    where space.nspname = 'public'
      and relation.relname in (
        'assistant_conversations', 'assistant_runs', 'assistant_messages',
        'assistant_tool_calls', 'assistant_facts', 'assistant_source_references',
        'assistant_action_proposals', 'assistant_feedback', 'org_assistant_policies')
      and relation.relrowsecurity) = 9,
  'an assistant table is missing row level security');

select pg_temp.p56_assert(
  not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in (
        'assistant_conversations', 'assistant_runs', 'assistant_messages',
        'assistant_tool_calls', 'assistant_facts', 'assistant_source_references',
        'assistant_action_proposals', 'assistant_feedback', 'org_assistant_policies')
      and grantee in ('anon', 'authenticated')
      and privilege_type <> 'SELECT'),
  'a browser role holds a DML grant on an assistant table');

select pg_temp.p56_assert(
  not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in (
        'assistant_messages', 'assistant_tool_calls',
        'assistant_facts', 'assistant_source_references')
      and grantee = 'authenticated' and privilege_type = 'SELECT'),
  'raw assistant dialogue or evidence is directly selectable by the browser');

select pg_temp.p56_assert(
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'assistant_runs'
      and column_name in (
        'actor_role', 'actor_scopes', 'actor_access_mode', 'actor_capabilities')) = 4,
  'assistant_runs does not retain the authorization snapshot needed for history rechecks');

select pg_temp.p56_assert(
  to_regprocedure(
    'public.assistant_record_run(uuid,uuid,boolean,text,jsonb,text,text,text,text,integer,integer,bigint,integer,boolean,jsonb,jsonb,jsonb,jsonb,uuid,uuid,jsonb)'
  ) is not null,
  'assistant_record_run is not fenced by an egress lease id and token');

select pg_temp.p56_assert(
  to_regprocedure(
    'public.service_assistant_conversation_snapshot(uuid,uuid,uuid,integer)'
  ) is not null
  and not has_function_privilege(
    'authenticated',
    'public.service_assistant_conversation_snapshot(uuid,uuid,uuid,integer)',
    'execute')
  and has_function_privilege(
    'service_role',
    'public.service_assistant_conversation_snapshot(uuid,uuid,uuid,integer)',
    'execute'),
  'the structured history snapshot is not service-role-only');

select pg_temp.p56_assert(
  not has_function_privilege(
    'authenticated',
    'public.assistant_record_proposal_outcome(uuid,uuid,uuid,boolean,uuid,text)',
    'execute')
  and has_function_privilege(
    'service_role',
    'public.assistant_record_proposal_outcome(uuid,uuid,uuid,boolean,uuid,text)',
    'execute'),
  'proposal outcomes can be forged outside the service boundary');

-- The policy table's only writer is the reasoned command: even service_role lost its default
-- CRUD, the org_autonomy_policies precedent.
select pg_temp.p56_assert(
  not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'org_assistant_policies'
      and grantee = 'service_role'
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')),
  'service_role can write org_assistant_policies around the reasoned command');

-- ===== Fixture =====
insert into public.organizations (id, name, status) values
  ('56000000-0000-4000-8000-000000000001', 'P56 tenant A', 'active'),
  ('56000000-0000-4000-8000-000000000002', 'P56 tenant B', 'active');

insert into auth.users (id, email) values
  ('66000000-0000-4000-8000-000000000001', 'owner-a-p56@example.test'),
  ('66000000-0000-4000-8000-000000000002', 'office-one-p56@example.test'),
  ('66000000-0000-4000-8000-000000000003', 'office-two-p56@example.test'),
  ('66000000-0000-4000-8000-000000000004', 'owner-b-p56@example.test'),
  ('66000000-0000-4000-8000-000000000005', 'ops-p56@example.test');

insert into public.profiles (id, org_id, full_name, role) values
  ('66000000-0000-4000-8000-000000000001', '56000000-0000-4000-8000-000000000001', 'P56 owner A',  'owner'),
  ('66000000-0000-4000-8000-000000000002', '56000000-0000-4000-8000-000000000001', 'P56 office 1', 'office'),
  ('66000000-0000-4000-8000-000000000003', '56000000-0000-4000-8000-000000000001', 'P56 office 2', 'office'),
  ('66000000-0000-4000-8000-000000000004', '56000000-0000-4000-8000-000000000002', 'P56 owner B',  'owner');

insert into public.suppliers (id, org_id, name) values
  ('56000000-0000-4000-8000-0000000000aa',
   '56000000-0000-4000-8000-000000000001', 'P56 supplier A'),
  ('56000000-0000-4000-8000-0000000000bb',
   '56000000-0000-4000-8000-000000000002', 'P56 supplier B');

insert into public.platform_admins (user_id, note) values
  ('66000000-0000-4000-8000-000000000005', 'P56 platform ops');

-- ===== An unstated quota refuses, rather than being treated as infinite =====
-- As shipped, assistant_runs.monthly is the explicit unknown state for every plan.
select pg_temp.p56_assert(
  not coalesce((public.effective_entitlement(
    '56000000-0000-4000-8000-000000000001', 'assistant_runs.monthly') ->> 'measured')::boolean, false),
  'the shipped assistant run quota claims to be measured');

select pg_temp.p56_as('66000000-0000-4000-8000-000000000002');
set local role authenticated;
do $$
begin
  perform public.assistant_assert_run_allowed();
  raise exception 'expected an unstated assistant quota to refuse';
exception when raise_exception then
  if sqlerrm <> 'assistant_limit_unknown' then raise; end if;
end
$$;
reset role;

-- ===== A plan with no assistant row at all is equally unknown, and equally a refusal =====
insert into public.subscription_plans (plan_key, label, tier_order, active)
values ('p56_probe', 'P56 probe plan', 99, true);
update public.organization_subscriptions
   set plan_key = 'p56_probe'
 where org_id = '56000000-0000-4000-8000-000000000002';

select pg_temp.p56_assert(
  not coalesce((public.effective_entitlement(
    '56000000-0000-4000-8000-000000000002', 'assistant_runs.monthly') ->> 'measured')::boolean, false),
  'a plan with no assistant quota row reported itself as measured');

select pg_temp.p56_as('66000000-0000-4000-8000-000000000004');
set local role authenticated;
do $$
begin
  perform public.assistant_assert_run_allowed();
  raise exception 'expected a plan with no assistant row to refuse, not to allow';
exception when raise_exception then
  if sqlerrm <> 'assistant_limit_unknown' then raise; end if;
end
$$;
reset role;

-- ===== A stated quota admits, and one recorded run counts exactly once =====
update public.plan_entitlements
   set unlimited = false, numeric_limit = 2, updated_at = now()
 where plan_key = 'free' and entitlement_key = 'assistant_runs.monthly';

select pg_temp.p56_as('66000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.p56_assert(
  (public.assistant_assert_run_allowed() ->> 'allowed')::boolean,
  'a stated quota with room refused the preflight');

do $$
begin
  perform public.assistant_record_run(
    '56000000-0000-4000-8000-00000000afff'::uuid, null, false,
    'forged browser run', null, 'failed', 'assistant_provider_unavailable',
    null, null, null, null, null, 1, false,
    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null,
    '56000000-0000-4000-8000-00000000eeee'::uuid,
    '56000000-0000-4000-8000-00000000dddd'::uuid,
    pg_temp.p56_capabilities(false));
  raise exception 'expected a browser-forged run without the Edge lease secret to refuse';
exception when insufficient_privilege then
  if sqlerrm <> 'assistant_egress_lease_invalid' then raise; end if;
end
$$;

do $$
declare
  v_result jsonb;
  v_lease jsonb;
begin
  v_lease := pg_temp.p56_lease(
    '56000000-0000-4000-8000-000000000001',
    '56000000-0000-4000-8000-00000000a001');
  v_result := public.assistant_record_run(
    '56000000-0000-4000-8000-00000000a001'::uuid, null, true,
    'כמה ספקים פעילים יש לנו?',
    '{"blocks":[{"type":"text","text":"תשובה"}],"next_steps":[],"no_answer_reason":null}'::jsonb,
    'succeeded', null, 'p56-model', 'v1', 1000, 200, 350, 900, true,
    jsonb_build_array(jsonb_build_object(
      'tool', 'summary.metrics', 'arguments', '{}'::jsonb, 'result_count', 3,
      'complete', true, 'failures', '[]'::jsonb, 'duration_ms', 120)),
    jsonb_build_array(
      jsonb_build_object('id', 'f1', 'kind', 'metric.count', 'subject', null,
        'label', 'ספקים פעילים', 'value', 3, 'unit', 'count',
        'tool', 'summary.metrics', 'classification', 'tenant_standard', 'as_of', now()),
      jsonb_build_object('id', 'f2', 'kind', 'supplier.balance',
        'subject', jsonb_build_object('entity', 'supplier',
                                      'id', '56000000-0000-4000-8000-0000000000aa'),
        'label', 'יתרת ספק', 'value', 118.5, 'unit', 'ils',
        'tool', 'summary.metrics', 'classification', 'financial_sensitive', 'as_of', now())),
    jsonb_build_array(jsonb_build_object(
      'id', 's1', 'entity', 'supplier',
      'entity_id', '56000000-0000-4000-8000-0000000000aa',
      'label', 'ספק לדוגמה',
      'route', '/suppliers/56000000-0000-4000-8000-0000000000aa',
      'classification', 'tenant_standard')),
    null,
    (v_lease ->> 'lease_id')::uuid,
    (v_lease ->> 'lease_token')::uuid,
    pg_temp.p56_capabilities(true));
  if coalesce((v_result ->> 'idempotent')::boolean, true) then
    raise exception 'a first run reported itself as a replay';
  end if;
  perform set_config('p56.conversation', v_result ->> 'conversation_id', true);
  perform set_config('p56.lease_a001', v_lease ->> 'lease_id', true);
  perform set_config('p56.token_a001', v_lease ->> 'lease_token', true);
end
$$;

select pg_temp.p56_assert(
  (select used from public.organization_usage_snapshot()
    where metric_key = 'assistant_runs.monthly') = 1,
  'a recorded run did not count towards the assistant usage');

-- The client's conversation list works through RLS with the columns it actually selects.
select pg_temp.p56_assert(
  (select count(*) from (
    select id, title, created_at, updated_at from assistant_conversations
    order by updated_at desc limit 20) listed) = 1,
  'the conversation list shape the client selects did not return the conversation');
select pg_temp.p56_assert(
  (select title from assistant_conversations limit 1) = 'שיחה עם העוזר',
  'a conversation title retained the user question instead of the generic title');

-- A replayed Edge call finds its run and moves nothing.
do $$
declare
  v_result jsonb;
  v_lease jsonb;
begin
  v_lease := pg_temp.p56_lease(
    '56000000-0000-4000-8000-000000000001',
    '56000000-0000-4000-8000-00000000a002');
  perform set_config('p56.lease_a002', v_lease ->> 'lease_id', true);
  perform set_config('p56.token_a002', v_lease ->> 'lease_token', true);
  v_result := public.assistant_record_run(
    '56000000-0000-4000-8000-00000000a001'::uuid, null, true, 'replay', null,
    'succeeded', null, null, null, null, null, null, null, true,
    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null,
    current_setting('p56.lease_a001')::uuid,
    current_setting('p56.token_a001')::uuid,
    pg_temp.p56_capabilities(true));
  if not coalesce((v_result ->> 'idempotent')::boolean, false) then
    raise exception 'a replayed run id was recorded as a new run';
  end if;
end
$$;
select pg_temp.p56_assert(
  (select used from public.organization_usage_snapshot()
    where metric_key = 'assistant_runs.monthly') = 1,
  'a replayed run moved the usage counter a second time');
reset role;
select pg_temp.p56_assert(
  (select count(*) from assistant_messages
    where conversation_id = current_setting('p56.conversation')::uuid) = 2,
  'a replayed run duplicated the stored messages');

do $$
begin
  insert into assistant_facts (
    org_id, run_id, fact_ref, kind, entity, entity_id, label, tool,
    value_numeric, unit, classification, as_of
  ) values (
    '56000000-0000-4000-8000-000000000001',
    '56000000-0000-4000-8000-00000000a001', 'foreign', 'supplier.balance',
    'supplier', '56000000-0000-4000-8000-0000000000bb',
    'foreign supplier balance', 'p56', 1, 'ils', 'financial_sensitive', now());
  raise exception 'expected a cross-tenant polymorphic fact subject to refuse';
exception when foreign_key_violation then
  if sqlerrm <> 'assistant_evidence_entity_invalid' then raise; end if;
end
$$;

-- Headroom for the proposal runs below; the write-time enforcement is proven separately.
update public.plan_entitlements
   set unlimited = false, numeric_limit = 10, updated_at = now()
 where plan_key = 'free' and entitlement_key = 'assistant_runs.monthly';

-- ===== A user cannot read another user''s conversation in the same organization =====
select pg_temp.p56_as('66000000-0000-4000-8000-000000000003');
set local role authenticated;
select pg_temp.p56_assert(
  (select count(*) from assistant_conversations) = 0
  and (select count(*) from assistant_runs) = 0,
  'a colleague in the same organization read another user''s conversation metadata');
do $$
begin
  perform count(*) from assistant_messages;
  raise exception 'expected raw messages to be unavailable through PostgREST role grants';
exception when insufficient_privilege then null;
end
$$;
reset role;

-- ===== A user cannot read another organization''s conversation =====
select pg_temp.p56_as('66000000-0000-4000-8000-000000000004');
set local role authenticated;
select pg_temp.p56_assert(
  (select count(*) from assistant_conversations) = 0
  and (select count(*) from assistant_runs) = 0,
  'a user read another organization''s assistant metadata');
reset role;

-- ===== The owner reads health and cost, never text =====
select pg_temp.p56_as('66000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.p56_assert(
  (select count(*) from assistant_conversations) = 0,
  'the organization owner read an employee''s conversation rows');
select pg_temp.p56_assert(
  (select run_count from public.assistant_org_health()) = 1
  and (select input_tokens from public.assistant_org_health()) = 1000
  and (select cost_micros from public.assistant_org_health()) = 350,
  'the owner health aggregate did not report the recorded run');
reset role;

-- A non-owner gets zero rows from the aggregate, not an error and not data.
select pg_temp.p56_as('66000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.p56_assert(
  (select count(*) from public.assistant_org_health()) = 0,
  'a non-owner read the organization health aggregate');
reset role;

-- ===== The three exposure flags exist, born off, and resolve off for a fresh organization =====
select pg_temp.p56_assert(
  (select count(*) from private.flag_definitions
    where flag_key in ('assistant.ui', 'assistant.history', 'assistant.drafts')
      and default_state = false and kill_switch = false) = 3
  and not exists (
    select 1 from private.flag_definitions where flag_key = 'assistant.confirmed_actions'),
  'the assistant flag surface is not exactly the three exposure switches, all born off');

select pg_temp.p56_as('66000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.p56_assert(
  (select count(*) from resolve_feature_flags()
    where flag_key like 'assistant.%' and state = false) = 3
  and not exists (
    select 1 from resolve_feature_flags()
    where flag_key like 'assistant.%' and state),
  'an assistant flag resolved on for a fresh organization');
reset role;

-- ===== Confirmed actions: a reasoned policy, baseline off by CHECK, never a flag =====
select pg_temp.p56_assert(
  exists (select 1 from private.assistant_policy_definitions
    where policy_key = 'assistant.confirmed_actions'
      and baseline_enabled = false and kill_switch = false),
  'the confirmed-actions policy baseline is not off');

-- The CHECK is what keeps the baseline honest: flipping it is not an UPDATE anyone can run.
do $$
begin
  update private.assistant_policy_definitions set baseline_enabled = true
  where policy_key = 'assistant.confirmed_actions';
  raise exception 'expected the baseline-off CHECK to refuse a force-on';
exception when check_violation then null;
end
$$;

-- Unconfigured resolves to off.
select pg_temp.p56_as('66000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.p56_assert(
  public.assistant_confirmed_actions_enabled() = false,
  'an unconfigured organization resolved confirmed actions to something other than off');
reset role;

-- A tenant owner is not a platform operator.
select pg_temp.p56_as('66000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$
begin
  perform public.platform_set_assistant_policy(
    '56000000-0000-4000-8000-000000000001', 'assistant.confirmed_actions', true, 'self service');
  raise exception 'expected a tenant owner to be refused the platform policy command';
exception when insufficient_privilege then
  if sqlerrm <> 'not_platform_admin' then raise; end if;
end
$$;
reset role;

-- The platform operator enables it, with a reason, and the audit row lands on the target tenant.
select pg_temp.p56_as('66000000-0000-4000-8000-000000000005');
set local role authenticated;
do $$
begin
  begin
    perform public.platform_set_assistant_policy(
      '56000000-0000-4000-8000-000000000001', 'assistant.confirmed_actions', true, '');
    raise exception 'expected a reasonless policy write to be refused';
  exception when invalid_parameter_value then
    if sqlerrm <> 'assistant_policy_reason_required' then raise; end if;
  end;
  perform public.platform_set_assistant_policy(
    '56000000-0000-4000-8000-000000000001', 'assistant.confirmed_actions', true,
    'P56: pilot tenant approved for confirmed actions');
end
$$;
reset role;

select pg_temp.p56_assert(
  exists (select 1 from audit_logs
    where org_id = '56000000-0000-4000-8000-000000000001'
      and action = 'assistant_policy_configured'
      and reason = 'P56: pilot tenant approved for confirmed actions'),
  'the policy write did not leave its reasoned audit row on the target tenant');

select pg_temp.p56_as('66000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.p56_assert(
  public.assistant_confirmed_actions_enabled() = true,
  'the enabled policy did not resolve on for the configured organization');
reset role;
select pg_temp.p56_as('66000000-0000-4000-8000-000000000004');
set local role authenticated;
select pg_temp.p56_assert(
  public.assistant_confirmed_actions_enabled() = false,
  'one organization''s policy leaked into another');
reset role;

-- The kill switch forces off regardless of configuration, and only off.
update private.assistant_policy_definitions set kill_switch = true
where policy_key = 'assistant.confirmed_actions';
select pg_temp.p56_as('66000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.p56_assert(
  public.assistant_confirmed_actions_enabled() = false,
  'a raised kill switch did not force the policy off');
reset role;
update private.assistant_policy_definitions set kill_switch = false
where policy_key = 'assistant.confirmed_actions';

-- ===== The proposal state machine is enforced by the database =====
select pg_temp.p56_as('66000000-0000-4000-8000-000000000002');
set local role authenticated;
do $$
declare v_result jsonb;
begin
  v_result := public.assistant_record_run(
    '56000000-0000-4000-8000-00000000a002'::uuid,
    current_setting('p56.conversation')::uuid, true,
    'תכין טיוטת הזמנה', '{"blocks":[{"type":"text","text":"טיוטה"}]}'::jsonb,
    'succeeded', null, 'p56-model', 'v1', 500, 100, 200, 400, true,
    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
    jsonb_build_object(
      'command', 'create_purchase_order_draft',
      'summary', 'טיוטת הזמנה לספק לדוגמה',
      'payload', jsonb_build_object('supplier_id', '56000000-0000-4000-8000-0000000000aa'),
      'expires_at', now() + interval '1 hour'),
    current_setting('p56.lease_a002')::uuid,
    current_setting('p56.token_a002')::uuid,
    pg_temp.p56_capabilities(true));
  perform set_config('p56.proposal', v_result ->> 'proposal_id', true);
end
$$;
reset role;

-- A direct jump to executed is refused even for a caller RLS does not bind.
do $$
begin
  update assistant_action_proposals set state = 'executed'
  where id = current_setting('p56.proposal')::uuid;
  raise exception 'expected the state machine to refuse awaiting_confirmation -> executed';
exception when raise_exception then
  if sqlerrm <> 'assistant_proposal_state' then raise; end if;
end
$$;

-- Somebody else's proposal is indistinguishable from an unknown one.
select pg_temp.p56_as('66000000-0000-4000-8000-000000000003');
set local role authenticated;
do $$
begin
  perform public.assistant_confirm_proposal(current_setting('p56.proposal')::uuid);
  raise exception 'expected a colleague to be unable to confirm another user''s proposal';
exception when insufficient_privilege then
  if sqlerrm <> 'assistant_proposal_unavailable' then raise; end if;
end
$$;
reset role;

-- The author confirms, the Edge records the executed outcome, and the trail survives.
select pg_temp.p56_as('66000000-0000-4000-8000-000000000002');
set local role authenticated;
select pg_temp.p56_assert(
  (public.assistant_confirm_proposal(current_setting('p56.proposal')::uuid)
    ->> 'state') = 'confirmed',
  'the author could not confirm their own awaiting proposal');
reset role;
-- The ACL itself is pinned above. Exercise the function's independent JWT-role
-- guard through a role that may execute it, so this negative test does not rely
-- on PostgreSQL's denied-EXECUTE path (which can terminate a backend on the CI
-- image before the expected exception reaches this block).
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role service_role;
do $$
begin
  perform public.assistant_record_proposal_outcome(
    '56000000-0000-4000-8000-000000000001',
    '66000000-0000-4000-8000-000000000002',
    current_setting('p56.proposal')::uuid, true,
    '56000000-0000-4000-8000-0000000000ee'::uuid, null);
  raise exception 'expected an authenticated caller to be unable to forge an execution outcome';
exception when insufficient_privilege then
  if sqlerrm <> 'service_role_required' then raise; end if;
end
$$;
reset role;

insert into audit_logs (id, org_id, user_id, action, entity_type, entity_id, reason)
values (
  '56000000-0000-4000-8000-0000000000ee',
  '56000000-0000-4000-8000-000000000001',
  '66000000-0000-4000-8000-000000000002',
  'purchase_order_created', 'purchase_orders',
  '56000000-0000-4000-8000-0000000000aa', 'P56 underlying command audit');

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select pg_temp.p56_assert(
  (public.assistant_record_proposal_outcome(
    '56000000-0000-4000-8000-000000000001',
    '66000000-0000-4000-8000-000000000002',
    current_setting('p56.proposal')::uuid, true,
    '56000000-0000-4000-8000-0000000000ee'::uuid, null) ->> 'state') = 'executed',
  'the service boundary could not record the audit-backed executed outcome');
reset role;

-- An expired proposal refuses confirmation; the flip to expired is the retention sweep''s job.
select pg_temp.p56_as('66000000-0000-4000-8000-000000000002');
set local role authenticated;
do $$
declare
  v_result jsonb;
  v_lease jsonb;
begin
  v_lease := pg_temp.p56_lease(
    '56000000-0000-4000-8000-000000000001',
    '56000000-0000-4000-8000-00000000a003');
  v_result := public.assistant_record_run(
    '56000000-0000-4000-8000-00000000a003'::uuid,
    current_setting('p56.conversation')::uuid, true,
    'עוד טיוטה', '{"blocks":[{"type":"text","text":"טיוטה"}]}'::jsonb,
    'succeeded', null, 'p56-model', 'v1', 500, 100, 200, 400, true,
    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
    jsonb_build_object(
      'command', 'create_purchase_order_draft', 'summary', 'טיוטה שפגה',
      'payload', '{}'::jsonb, 'expires_at', now() - interval '1 minute'),
    (v_lease ->> 'lease_id')::uuid,
    (v_lease ->> 'lease_token')::uuid,
    pg_temp.p56_capabilities(true));
  perform set_config('p56.expired_proposal', v_result ->> 'proposal_id', true);
  begin
    perform public.assistant_confirm_proposal((v_result ->> 'proposal_id')::uuid);
    raise exception 'expected an expired proposal to refuse confirmation';
  exception when raise_exception then
    if sqlerrm <> 'assistant_proposal_expired' then raise; end if;
  end;
end
$$;

-- ===== Feedback lands in the exact shape the client calls =====
select pg_temp.p56_assert(
  (public.assistant_record_feedback(
    '56000000-0000-4000-8000-00000000a002'::uuid, true) ->> 'feedback_id') is not null,
  'the client feedback call did not record a rating');
select pg_temp.p56_assert(
  (select rating from assistant_feedback
    where run_id = '56000000-0000-4000-8000-00000000a002') = 'helpful',
  'a helpful rating did not land as helpful');
do $$
begin
  perform public.assistant_record_feedback('56000000-0000-4000-8000-00000000a002'::uuid, false);
end
$$;
reset role;
select pg_temp.p56_assert(
  (select rating from assistant_feedback
    where run_id = '56000000-0000-4000-8000-00000000a002') = 'not_helpful'
  and (select count(*) from assistant_feedback
    where run_id = '56000000-0000-4000-8000-00000000a002') = 1,
  'a revised rating duplicated instead of replacing');

-- The refusal above did not flip state (an exception would roll the flip back anyway).
select pg_temp.p56_assert(
  (select state from assistant_action_proposals
    where id = current_setting('p56.expired_proposal')::uuid) = 'awaiting_confirmation',
  'refusing an expired confirmation unexpectedly changed the proposal state');

-- ===== The quota is enforced at write time, in the same locked transaction as the count =====
-- Three runs are recorded and counted. With the limit set to exactly three, a retried recording
-- of an already-counted run still succeeds (a retry is not a new unit of work), a FOURTH run is
-- refused at the write itself -- not only at the advisory preflight -- and the refusal leaves
-- nothing behind: no run row, no messages, no counter movement.
update public.plan_entitlements
   set unlimited = false, numeric_limit = 3, updated_at = now()
 where plan_key = 'free' and entitlement_key = 'assistant_runs.monthly';

select pg_temp.p56_as('66000000-0000-4000-8000-000000000002');
set local role authenticated;
do $$
declare v_result jsonb;
begin
  v_result := public.assistant_record_run(
    '56000000-0000-4000-8000-00000000a001'::uuid, null, true, 'retry at the limit', null,
    'succeeded', null, null, null, null, null, null, null, true,
    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null,
    current_setting('p56.lease_a001')::uuid,
    current_setting('p56.token_a001')::uuid,
    pg_temp.p56_capabilities(true));
  if not coalesce((v_result ->> 'idempotent')::boolean, false) then
    raise exception 'a retried recording at the limit was treated as a new run';
  end if;
end
$$;
do $$
declare v_lease jsonb;
begin
  v_lease := pg_temp.p56_lease(
    '56000000-0000-4000-8000-000000000001',
    '56000000-0000-4000-8000-00000000a004');
  perform public.assistant_record_run(
    '56000000-0000-4000-8000-00000000a004'::uuid,
    current_setting('p56.conversation')::uuid, true,
    'שאלה רביעית', '{"blocks":[{"type":"text","text":"תשובה"}]}'::jsonb,
    'succeeded', null, 'p56-model', 'v1', 100, 50, 100, 300, true,
    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null,
    (v_lease ->> 'lease_id')::uuid,
    (v_lease ->> 'lease_token')::uuid,
    pg_temp.p56_capabilities(true));
  raise exception 'expected the write-time quota to refuse a fourth run';
exception when raise_exception then
  if sqlerrm <> 'assistant_limit_reached' then raise; end if;
end
$$;
select pg_temp.p56_assert(
  (select used from public.organization_usage_snapshot()
    where metric_key = 'assistant_runs.monthly') = 3,
  'a refused recording still moved the usage counter');
reset role;
select pg_temp.p56_assert(
  not exists (select 1 from assistant_runs
    where id = '56000000-0000-4000-8000-00000000a004')
  and (select count(*) from assistant_messages
    where conversation_id = current_setting('p56.conversation')::uuid) = 6,
  'a refused recording left run or message rows behind');
update public.plan_entitlements
   set unlimited = false, numeric_limit = 10, updated_at = now()
 where plan_key = 'free' and entitlement_key = 'assistant_runs.monthly';

-- ===== Raw history is service-only and structured; totals stay caller-bound =====
select pg_temp.p56_as('66000000-0000-4000-8000-000000000002');
set local role authenticated;
do $$
begin
  perform public.service_assistant_conversation_snapshot(
    '56000000-0000-4000-8000-000000000001',
    '66000000-0000-4000-8000-000000000002',
    current_setting('p56.conversation')::uuid, 12);
  raise exception 'expected the raw history snapshot to refuse an authenticated browser';
exception when insufficient_privilege then null;
end
$$;
select pg_temp.p56_assert(
  (public.assistant_run_totals() ->> 'org_month')::numeric = 3
  and (public.assistant_run_totals() ->> 'org_month_cost')::bigint = 750,
  'the run totals did not report the metered period count and the summed cost');
reset role;

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select pg_temp.p56_assert(
  jsonb_array_length(public.service_assistant_conversation_snapshot(
    '56000000-0000-4000-8000-000000000001',
    '66000000-0000-4000-8000-000000000002',
    current_setting('p56.conversation')::uuid, 12) -> 'messages') = 6
  and public.service_assistant_conversation_snapshot(
    '56000000-0000-4000-8000-000000000001',
    '66000000-0000-4000-8000-000000000002',
    current_setting('p56.conversation')::uuid, 12)
      #>> '{messages,0,question}' = 'כמה ספקים פעילים יש לנו?',
  'the service snapshot did not preserve structured messages oldest-first');
do $$
begin
  perform public.service_assistant_conversation_snapshot(
    '56000000-0000-4000-8000-000000000001',
    '66000000-0000-4000-8000-000000000003',
    current_setting('p56.conversation')::uuid, 12);
  raise exception 'expected a mismatched user snapshot to refuse';
exception when insufficient_privilege then
  if sqlerrm <> 'assistant_history_unavailable' then raise; end if;
end
$$;
reset role;

-- ===== Deleting a conversation removes its text and does not touch the audit ledger =====
select (select count(*) from audit_logs
  where org_id = '56000000-0000-4000-8000-000000000001')::text as before \gset audit_
select pg_temp.p56_as('66000000-0000-4000-8000-000000000002');
set local role authenticated;
do $$
begin
  perform public.assistant_delete_conversation(current_setting('p56.conversation')::uuid);
end
$$;
select pg_temp.p56_assert(
  (select count(*) from assistant_conversations) = 0,
  'a deleted conversation is still listed to its author');
reset role;
select pg_temp.p56_assert(
  (select count(*) from assistant_messages
    where conversation_id = current_setting('p56.conversation')::uuid) = 0
  and (select count(*) from assistant_facts
    where org_id = '56000000-0000-4000-8000-000000000001') = 0
  and (select count(*) from assistant_source_references
    where org_id = '56000000-0000-4000-8000-000000000001') = 0
  and (select count(*) from assistant_tool_calls
    where org_id = '56000000-0000-4000-8000-000000000001') = 0
  and (select count(*) from assistant_feedback
    where run_id in (
      '56000000-0000-4000-8000-00000000a002',
      '56000000-0000-4000-8000-00000000a003')) = 0,
  format(
    'deleting a conversation left dialogue-derived rows behind: messages=%s facts=%s sources=%s tool_calls=%s feedback=%s',
    (select count(*) from assistant_messages
      where conversation_id = current_setting('p56.conversation')::uuid),
    (select count(*) from assistant_facts
      where org_id = '56000000-0000-4000-8000-000000000001'),
    (select count(*) from assistant_source_references
      where org_id = '56000000-0000-4000-8000-000000000001'),
    (select count(*) from assistant_tool_calls
      where org_id = '56000000-0000-4000-8000-000000000001'),
    (select count(*) from assistant_feedback
      where run_id in (
        '56000000-0000-4000-8000-00000000a002',
        '56000000-0000-4000-8000-00000000a003'))));
select pg_temp.p56_assert(
  not exists (select 1 from assistant_action_proposals
    where id = current_setting('p56.expired_proposal')::uuid)
  and exists (select 1 from assistant_action_proposals
    where id = current_setting('p56.proposal')::uuid and state = 'executed'),
  'conversation deletion did not remove an unconfirmed proposal or removed an executed record');
select pg_temp.p56_assert(
  (select count(*) from assistant_runs
    where org_id = '56000000-0000-4000-8000-000000000001') = 3,
  'deleting a conversation destroyed the billing truth in the run rows');
-- The ledger grew by exactly the delete''s own record; nothing was removed from it.
select pg_temp.p56_assert(
  (select count(*) from audit_logs
    where org_id = '56000000-0000-4000-8000-000000000001') = :'audit_before'::int + 1,
  'deleting a conversation changed audit rows other than adding its own record');

-- ===== Retention purges old dialogue, keeps recent work, executed proposals and the ledger =====
insert into assistant_conversations (id, org_id, user_id, started_at, updated_at, created_at)
values ('56000000-0000-4000-8000-00000000c01d', '56000000-0000-4000-8000-000000000001',
        '66000000-0000-4000-8000-000000000002',
        now() - interval '120 days', now() - interval '120 days', now() - interval '120 days');
insert into assistant_runs (id, org_id, user_id, conversation_id, status, complete, created_at)
values ('56000000-0000-4000-8000-00000000a01d', '56000000-0000-4000-8000-000000000001',
        '66000000-0000-4000-8000-000000000002', '56000000-0000-4000-8000-00000000c01d',
        'succeeded', true, now() - interval '120 days');
insert into assistant_messages (org_id, conversation_id, run_id, author, question, created_at)
values ('56000000-0000-4000-8000-000000000001', '56000000-0000-4000-8000-00000000c01d',
        '56000000-0000-4000-8000-00000000a01d', 'user', 'שאלה ישנה',
        now() - interval '120 days');

-- Exact history boundaries: 89 days survives; 91 days is purged by the 90-day policy.
insert into assistant_conversations (id, org_id, user_id, started_at, updated_at, created_at)
values
  ('56000000-0000-4000-8000-000000000089', '56000000-0000-4000-8000-000000000001',
   '66000000-0000-4000-8000-000000000002',
   now() - interval '89 days', now() - interval '89 days', now() - interval '89 days'),
  ('56000000-0000-4000-8000-000000000091', '56000000-0000-4000-8000-000000000001',
   '66000000-0000-4000-8000-000000000002',
   now() - interval '91 days', now() - interval '91 days', now() - interval '91 days');
insert into assistant_runs (id, org_id, user_id, conversation_id, status, complete, created_at)
values
  ('56000000-0000-4000-8000-00000000a089', '56000000-0000-4000-8000-000000000001',
   '66000000-0000-4000-8000-000000000002', '56000000-0000-4000-8000-000000000089',
   'succeeded', true, now() - interval '89 days'),
  ('56000000-0000-4000-8000-00000000a091', '56000000-0000-4000-8000-000000000001',
   '66000000-0000-4000-8000-000000000002', '56000000-0000-4000-8000-000000000091',
   'succeeded', true, now() - interval '91 days');
insert into assistant_messages (org_id, conversation_id, run_id, author, question, created_at)
values
  ('56000000-0000-4000-8000-000000000001', '56000000-0000-4000-8000-000000000089',
   '56000000-0000-4000-8000-00000000a089', 'user', 'P56 day 89', now() - interval '89 days'),
  ('56000000-0000-4000-8000-000000000001', '56000000-0000-4000-8000-000000000091',
   '56000000-0000-4000-8000-00000000a091', 'user', 'P56 day 91', now() - interval '91 days');

-- An old proposal that never got confirmed, and an old one that WAS executed. The second must
-- survive the purge: it explains a business write.
insert into assistant_action_proposals (
  id, org_id, user_id, run_id, state, command, summary, payload, expires_at, created_at
) values
  ('56000000-0000-4000-8000-00000000b01d', '56000000-0000-4000-8000-000000000001',
   '66000000-0000-4000-8000-000000000002', null, 'awaiting_confirmation',
   'create_purchase_order_draft', 'P56 stale draft', '{}'::jsonb,
   now() - interval '119 days', now() - interval '120 days'),
  ('56000000-0000-4000-8000-00000000b029', '56000000-0000-4000-8000-000000000001',
   '66000000-0000-4000-8000-000000000002', null, 'awaiting_confirmation',
   'create_purchase_order_draft', 'P56 day 29 proposal', '{}'::jsonb,
   now() - interval '28 days', now() - interval '29 days'),
  ('56000000-0000-4000-8000-00000000b031', '56000000-0000-4000-8000-000000000001',
   '66000000-0000-4000-8000-000000000002', null, 'awaiting_confirmation',
   'create_purchase_order_draft', 'P56 day 31 proposal', '{}'::jsonb,
   now() - interval '30 days', now() - interval '31 days'),
  ('56000000-0000-4000-8000-00000000b0dd', '56000000-0000-4000-8000-000000000001',
   '66000000-0000-4000-8000-000000000002', null, 'awaiting_confirmation',
   'create_purchase_order_draft', 'P56 recent overdue proposal', '{}'::jsonb,
   now() - interval '1 minute', now() - interval '1 day'),
  ('56000000-0000-4000-8000-00000000beee', '56000000-0000-4000-8000-000000000001',
   '66000000-0000-4000-8000-000000000002', null, 'awaiting_confirmation',
   'create_purchase_order_draft', 'P56 old executed', '{}'::jsonb,
   now() + interval '1 hour', now() - interval '120 days');
update assistant_action_proposals set state = 'confirmed', confirmed_at = now(),
  confirmed_by = '66000000-0000-4000-8000-000000000002'
where id = '56000000-0000-4000-8000-00000000beee';
update assistant_action_proposals set state = 'executed', executed_at = now(),
  execution_audit_id = '56000000-0000-4000-8000-0000000000ee'
where id = '56000000-0000-4000-8000-00000000beee';

select (select count(*) from audit_logs)::text as before \gset purge_audit_
select set_config(
  'p56.purge_result', private.purge_assistant_history(90)::text, true);

select pg_temp.p56_assert(
  (current_setting('p56.purge_result')::jsonb ->> 'retention_days')::int = 90
  and (current_setting('p56.purge_result')::jsonb ->> 'proposal_retention_days')::int = 30,
  'the purge did not report the independent history and proposal retention windows');

select pg_temp.p56_assert(
  not exists (select 1 from assistant_runs
    where id = '56000000-0000-4000-8000-00000000a01d')
  and not exists (select 1 from assistant_messages
    where conversation_id = '56000000-0000-4000-8000-00000000c01d')
  and not exists (select 1 from assistant_conversations
    where id = '56000000-0000-4000-8000-00000000c01d'),
  'the purge left dialogue older than the retention window');
select pg_temp.p56_assert(
  exists (select 1 from assistant_runs
    where id = '56000000-0000-4000-8000-00000000a089')
  and exists (select 1 from assistant_messages
    where conversation_id = '56000000-0000-4000-8000-000000000089')
  and exists (select 1 from assistant_conversations
    where id = '56000000-0000-4000-8000-000000000089')
  and not exists (select 1 from assistant_runs
    where id = '56000000-0000-4000-8000-00000000a091')
  and not exists (select 1 from assistant_messages
    where conversation_id = '56000000-0000-4000-8000-000000000091')
  and not exists (select 1 from assistant_conversations
    where id = '56000000-0000-4000-8000-000000000091'),
  'the 89/91-day history boundary was not enforced');
select pg_temp.p56_assert(
  not exists (select 1 from assistant_action_proposals
    where id in (
      '56000000-0000-4000-8000-00000000b01d',
      '56000000-0000-4000-8000-00000000b031'))
  and exists (select 1 from assistant_action_proposals
    where id = '56000000-0000-4000-8000-00000000b029'),
  'the 29/31-day unexecuted proposal boundary was not enforced');
-- The sweep half of the purge: the recent-but-overdue proposal from the confirmation test above
-- is flipped to expired rather than deleted -- it is inside the retention window.
select pg_temp.p56_assert(
  (select state from assistant_action_proposals
    where id = '56000000-0000-4000-8000-00000000b0dd') = 'expired',
  'the retention sweep did not expire an overdue awaiting proposal');
select pg_temp.p56_assert(
  exists (select 1 from assistant_action_proposals
    where id = '56000000-0000-4000-8000-00000000beee' and state = 'executed'),
  'the purge deleted an EXECUTED proposal -- the record of a business write');
select pg_temp.p56_assert(
  (select count(*) from audit_logs) = :'purge_audit_before'::int,
  'the purge touched the audit ledger');

-- ===== The hourly rate limit is counted in the database, per user =====
-- Thirty recent runs (contracts.ts ASSISTANT_RUNS_PER_USER_HOUR) put owner B at the ceiling; a
-- thirty-first is refused, and the count cannot be reset by deleting a conversation because run
-- rows survive deletion.
insert into assistant_runs (id, org_id, user_id, status, complete, created_at)
select gen_random_uuid(), '56000000-0000-4000-8000-000000000002',
       '66000000-0000-4000-8000-000000000004', 'succeeded', true,
       now() - (series || ' minutes')::interval
from generate_series(1, 30) series;

select pg_temp.p56_as('66000000-0000-4000-8000-000000000004');
set local role authenticated;
do $$
begin
  perform public.assistant_assert_run_rate_limit();
  raise exception 'expected the thirty-first run in an hour to be rate limited';
exception when raise_exception then
  if sqlerrm <> 'assistant_rate_limited' then raise; end if;
end
$$;
reset role;

-- One run ages out of the rolling hour and the same user is admitted again.
update assistant_runs set created_at = now() - interval '2 hours'
where org_id = '56000000-0000-4000-8000-000000000002'
  and user_id = '66000000-0000-4000-8000-000000000004'
  and id = (select id from assistant_runs
             where org_id = '56000000-0000-4000-8000-000000000002'
               and user_id = '66000000-0000-4000-8000-000000000004'
             limit 1);
select pg_temp.p56_as('66000000-0000-4000-8000-000000000004');
set local role authenticated;
do $$
begin
  perform public.assistant_assert_run_rate_limit();
end
$$;
-- And it binds the USER, not the organization: a colleague of the rate-limited user is untouched.
reset role;
select pg_temp.p56_as('66000000-0000-4000-8000-000000000002');
set local role authenticated;
do $$
begin
  perform public.assistant_assert_run_rate_limit();
end
$$;
reset role;

rollback;

\echo 'p56_assistant_foundations_passed'
