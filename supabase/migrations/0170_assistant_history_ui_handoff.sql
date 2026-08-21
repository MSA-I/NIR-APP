-- 0170 -- Authorized history UI handoff.
--
-- The browser still receives no direct SELECT policy on assistant_messages/facts/sources/tool
-- calls. Two service-only RPCs give the Edge only what it needs to reauthorize current access:
-- candidate conversation ids/dates, and structured run evidence. A title/date leaves the Edge
-- only after the latest run's actor, facts, sources, route and free text pass current checks.

begin;

create or replace function public.service_assistant_recent_conversations(
  p_org_id uuid, p_user_id uuid, p_limit integer default 10
) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_conversations jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_org_id is null or p_user_id is null then
    raise exception 'assistant_history_unavailable' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', recent.id,
    'updated_at', recent.updated_at
  ) order by recent.updated_at desc, recent.id), '[]'::jsonb)
    into v_conversations
  from (
    select conversation.id, conversation.updated_at
    from assistant_conversations conversation
    where conversation.org_id = p_org_id
      and conversation.user_id = p_user_id
      and conversation.deleted_at is null
    order by conversation.updated_at desc, conversation.id
    limit least(greatest(coalesce(p_limit, 10), 1), 20)
  ) recent;

  return jsonb_build_object('conversations', v_conversations);
end
$$;
revoke all on function public.service_assistant_recent_conversations(uuid, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.service_assistant_recent_conversations(uuid, uuid, integer)
  to service_role;

create or replace function public.service_assistant_conversation_snapshot(
  p_org_id uuid, p_user_id uuid, p_conversation_id uuid, p_limit integer default 12
) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_messages jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_org_id is null or p_user_id is null or p_conversation_id is null then
    raise exception 'assistant_history_unavailable' using errcode = '42501';
  end if;
  if not exists (
    select 1 from assistant_conversations conversation
    where conversation.id = p_conversation_id
      and conversation.org_id = p_org_id and conversation.user_id = p_user_id
      and conversation.deleted_at is null
  ) then
    raise exception 'assistant_history_unavailable' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(recent.payload order by recent.created_at, recent.message_id), '[]'::jsonb)
    into v_messages
  from (
    select message.id as message_id, message.created_at,
      jsonb_build_object(
        'message_id', message.id,
        'run_id', message.run_id,
        'run_as_of', run.created_at,
        'complete', run.complete,
        'author', message.author,
        'question', message.question,
        'blocks', message.blocks,
        'created_at', message.created_at,
        'actor', case when run.id is null then null else jsonb_build_object(
          'userId', run.user_id,
          'orgId', run.org_id,
          'role', run.actor_role,
          'scopes', run.actor_scopes,
          'canWrite', run.actor_access_mode = 'active',
          'capabilities', run.actor_capabilities) end,
        'tools', coalesce((
          select jsonb_agg(jsonb_build_object(
            'tool', tool_call.tool,
            'complete', tool_call.complete)
            order by tool_call.created_at, tool_call.id)
          from assistant_tool_calls tool_call
          where tool_call.run_id = message.run_id and tool_call.org_id = p_org_id
        ), '[]'::jsonb),
        'facts', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', fact.fact_ref,
            'kind', fact.kind,
            'subject', case when fact.entity is null then null else
              jsonb_build_object('entity', fact.entity, 'id', fact.entity_id) end,
            'label', fact.label,
            'value', coalesce(to_jsonb(fact.value_numeric), to_jsonb(fact.value_text), 'null'::jsonb),
            'unit', fact.unit,
            'tool', fact.tool,
            'as_of', fact.as_of,
            'classification', fact.classification)
            order by fact.created_at, fact.id)
          from assistant_facts fact
          where fact.run_id = message.run_id and fact.org_id = p_org_id
        ), '[]'::jsonb),
        'sources', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', source.source_ref,
            'entity', source.entity,
            'entity_id', source.entity_id,
            'label', source.label,
            'route', source.route,
            'classification', source.classification)
            order by source.created_at, source.id)
          from assistant_source_references source
          where source.run_id = message.run_id and source.org_id = p_org_id
        ), '[]'::jsonb)
      ) as payload
    from assistant_messages message
    left join assistant_runs run
      on run.id = message.run_id and run.org_id = p_org_id and run.user_id = p_user_id
    where message.conversation_id = p_conversation_id and message.org_id = p_org_id
    order by message.created_at desc, message.id desc
    limit least(greatest(coalesce(p_limit, 12), 1), 50)
  ) recent;

  return jsonb_build_object(
    'conversation_id', p_conversation_id,
    'messages', v_messages);
end
$$;
revoke all on function public.service_assistant_conversation_snapshot(uuid, uuid, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.service_assistant_conversation_snapshot(uuid, uuid, uuid, integer)
  to service_role;

comment on function public.service_assistant_recent_conversations(uuid, uuid, integer) is
  '0170 service-only candidate ids/dates. The Edge returns neither until latest structured evidence passes current reauthorization.';
comment on function public.service_assistant_conversation_snapshot(uuid, uuid, uuid, integer) is
  '0170 service-only structured history: actor snapshot, answer, facts, sources, tools, completeness and freshness for current Edge reauthorization.';

do $anchor_0170$
begin
  if pg_catalog.to_regprocedure(
       'public.service_assistant_recent_conversations(uuid,uuid,integer)') is null
     or pg_catalog.to_regprocedure(
       'public.service_assistant_conversation_snapshot(uuid,uuid,uuid,integer)') is null then
    raise exception '0170: history service functions are missing';
  end if;
  if has_function_privilege(
       'authenticated',
       'public.service_assistant_recent_conversations(uuid,uuid,integer)', 'execute')
     or not has_function_privilege(
       'service_role',
       'public.service_assistant_recent_conversations(uuid,uuid,integer)', 'execute')
     or has_function_privilege(
       'authenticated',
       'public.service_assistant_conversation_snapshot(uuid,uuid,uuid,integer)', 'execute')
     or not has_function_privilege(
       'service_role',
       'public.service_assistant_conversation_snapshot(uuid,uuid,uuid,integer)', 'execute') then
    raise exception '0170: a history service function is not service-role-only';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc proc
    where proc.oid = pg_catalog.to_regprocedure(
      'public.service_assistant_conversation_snapshot(uuid,uuid,uuid,integer)')
      and proc.prosrc like '%run_as_of%'
      and proc.prosrc like '%assistant_tool_calls%'
      and proc.prosrc like '%complete%'
  ) then
    raise exception '0170: structured snapshot omits freshness, tools or completeness';
  end if;
end
$anchor_0170$;

do $scope_0170$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0170 scope assertions failed:\n%', v_violations;
  end if;

  select string_agg(detail, e'\n' order by detail)
    into v_violations
  from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0170 tenant export assertions failed:\n%', v_violations;
  end if;
end
$scope_0170$;

commit;
