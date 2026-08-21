-- P61 -- browser history handoff (0170): the browser receives neither raw tables nor the
-- service snapshot. Service-only RPCs return candidate ids and structured run evidence; the
-- Edge reauthorizes every fact/source before emitting title, date, question or answer.
\set ON_ERROR_STOP on

begin;

create function pg_temp.p61_assert(p_condition boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'P61 assistant history assertion failed: %', p_message;
  end if;
end
$$;

create function pg_temp.p61_service()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end
$$;

create function pg_temp.p61_authenticated(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', p_user, 'role', 'authenticated', 'amr', '[]'::jsonb
  )::text, true);
end
$$;

insert into public.organizations (id, name, status) values
  ('59000000-0000-4000-8000-000000000001', 'P61 tenant', 'active');

insert into auth.users (id, email) values
  ('69000000-0000-4000-8000-000000000001', 'owner-p61@example.test'),
  ('69000000-0000-4000-8000-000000000002', 'other-p61@example.test');

insert into public.assistant_conversations (
  id, org_id, user_id, title, started_at, updated_at
) values (
  '59000000-0000-4000-8000-000000000010',
  '59000000-0000-4000-8000-000000000001',
  '69000000-0000-4000-8000-000000000001',
  'P61 raw title must stay inside service boundary',
  '2026-08-20T10:00:00Z', '2026-08-20T10:00:02Z'
);

insert into public.assistant_runs (
  id, org_id, user_id, conversation_id, status, complete, tool_call_count,
  actor_role, actor_scopes, actor_access_mode, actor_capabilities, created_at
) values (
  '59000000-0000-4000-8000-000000000020',
  '59000000-0000-4000-8000-000000000001',
  '69000000-0000-4000-8000-000000000001',
  '59000000-0000-4000-8000-000000000010',
  'succeeded', true, 1, 'owner', '{}'::uuid[], 'active',
  '{"ui":true,"history":true,"drafts":false,"confirmedActions":false}'::jsonb,
  '2026-08-20T10:00:01Z'
);

insert into public.assistant_messages (
  id, org_id, conversation_id, run_id, author, question, blocks, created_at
) values
  ('59000000-0000-4000-8000-000000000030',
   '59000000-0000-4000-8000-000000000001',
   '59000000-0000-4000-8000-000000000010',
   '59000000-0000-4000-8000-000000000020',
   'user', 'כמה חשבוניות נקלטו?', null, '2026-08-20T10:00:00Z'),
  ('59000000-0000-4000-8000-000000000031',
   '59000000-0000-4000-8000-000000000001',
   '59000000-0000-4000-8000-000000000010',
   '59000000-0000-4000-8000-000000000020',
   'assistant', null,
   '{"blocks":[{"type":"claim","text":"נקלטו 12 חשבוניות.","claim_kind":"metric.count","subject":null,"claim_unit":"count","claim_value":12,"fact_ids":["f1"],"source_ids":["s1"]}],"next_steps":[],"no_answer_reason":null}'::jsonb,
   '2026-08-20T10:00:02Z');

insert into public.assistant_tool_calls (
  id, org_id, run_id, tool, arguments, result_count, complete, failures, duration_ms
) values (
  '59000000-0000-4000-8000-000000000040',
  '59000000-0000-4000-8000-000000000001',
  '59000000-0000-4000-8000-000000000020',
  'get_purchase_metrics', '{}'::jsonb, 1, true, '[]'::jsonb, 8
);

insert into public.assistant_facts (
  id, org_id, run_id, fact_ref, kind, entity, entity_id, label, tool,
  value_numeric, unit, classification, as_of
) values (
  '59000000-0000-4000-8000-000000000050',
  '59000000-0000-4000-8000-000000000001',
  '59000000-0000-4000-8000-000000000020',
  'f1', 'metric.count', null, null, 'חשבוניות שנקלטו', 'get_purchase_metrics',
  12, 'count', 'tenant_standard', '2026-08-20T10:00:01Z'
);

insert into public.assistant_source_references (
  id, org_id, run_id, source_ref, entity, entity_id, label, route, classification
) values (
  '59000000-0000-4000-8000-000000000060',
  '59000000-0000-4000-8000-000000000001',
  '59000000-0000-4000-8000-000000000020',
  's1', 'organization', '59000000-0000-4000-8000-000000000001',
  'רשימת החשבוניות', '/invoices', 'tenant_standard'
);

select pg_temp.p61_assert(
  not has_function_privilege(
    'authenticated',
    'public.service_assistant_recent_conversations(uuid,uuid,integer)',
    'execute')
  and has_function_privilege(
    'service_role',
    'public.service_assistant_recent_conversations(uuid,uuid,integer)',
    'execute'),
  'recent-conversations RPC is not service-role-only');

select pg_temp.p61_assert(
  not has_function_privilege(
    'authenticated',
    'public.service_assistant_conversation_snapshot(uuid,uuid,uuid,integer)',
    'execute')
  and has_function_privilege(
    'service_role',
    'public.service_assistant_conversation_snapshot(uuid,uuid,uuid,integer)',
    'execute'),
  'structured snapshot RPC is not service-role-only');

select pg_temp.p61_service();
set local role service_role;

select pg_temp.p61_assert(
  jsonb_array_length(public.service_assistant_recent_conversations(
    '59000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000001', 10) -> 'conversations') = 1,
  'the owning user did not receive one candidate conversation');

select pg_temp.p61_assert(
  jsonb_array_length(public.service_assistant_recent_conversations(
    '59000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000002', 10) -> 'conversations') = 0,
  'another user received conversation metadata');

select public.service_assistant_conversation_snapshot(
  '59000000-0000-4000-8000-000000000001',
  '69000000-0000-4000-8000-000000000001',
  '59000000-0000-4000-8000-000000000010', 12
) as snapshot \gset

select pg_temp.p61_assert(
  jsonb_array_length(:'snapshot'::jsonb -> 'messages') = 2
  and (:'snapshot'::jsonb #>> '{messages,0,run_as_of}')::timestamptz
    = '2026-08-20T10:00:01+00:00'::timestamptz
  and (:'snapshot'::jsonb #>> '{messages,0,complete}')::boolean
  and :'snapshot'::jsonb #>> '{messages,0,tools,0,tool}' = 'get_purchase_metrics'
  and (:'snapshot'::jsonb #>> '{messages,0,tools,0,complete}')::boolean,
  'snapshot omitted run freshness, completeness or tool shape');

reset role;
select pg_temp.p61_authenticated('69000000-0000-4000-8000-000000000001');
set local role service_role;
do $$
begin
  perform public.service_assistant_recent_conversations(
    '59000000-0000-4000-8000-000000000001',
    '69000000-0000-4000-8000-000000000001', 10);
  raise exception 'expected browser JWT to fail the in-function service guard';
exception when insufficient_privilege then
  if sqlerrm <> 'service_role_required' then raise; end if;
end
$$;

rollback;

\echo 'p61_assistant_history_ui_passed'
