-- 0308 — a citation keeps the window it declared, across a reload. Codex round 2, finding 5, and
-- it is the sharpest of the eight: the round-1 fix for finding 9 made history strictly worse.
--
-- WHAT BREAKS WITHOUT THIS. Finding 9's fix stopped `routeAccess` trusting a query string and made
-- it compare the link against `source.route_params`, the window the tool declares as a value. A
-- shaped route arriving WITHOUT that declaration is refused, deliberately — a reference that has
-- not said which range it stands for cannot be handed a range. But the declaration was never
-- persisted:
--
--   `assistant_record_run` writes `org_id, run_id, source_ref, entity, entity_id, label, route,
--   classification` and nothing else. `service_assistant_conversation_snapshot` returns the same
--   eight. `parseSources` does not copy the field either.
--
-- So the answer is correct while it is on screen and breaks on reload: the shaped route comes back
-- with no declaration, `routeAccess` refuses it, `validateAnswer` fails, and **the whole run is
-- dropped from the history** — not the citation, the run. A reader with history on loses the
-- answer entirely, and the failure is silent.
--
-- That is worse than the defect finding 9 reported, and it was introduced by the fix for it. The
-- window has to be stored where the route is stored, which is what this migration does.
--
-- `route_params` is `jsonb`, not a text pair, because the shaped-rule contract is a MAP of
-- parameter names to values — `routeAccess` reads it as the single authority for what the query
-- string may contain, and a second shape here would be a second definition of the same thing.
-- Nullable, because most references declare no shaped filter at all and a route that needs none
-- must not be forced to carry an empty object.
--
-- WHY NO BODY-HASH PIN MOVES. Neither `assistant_record_run` nor
-- `service_assistant_conversation_snapshot` is registered in `private.scope_definer_enforcements`
-- or in `private.document_automation_authoritative_functions` — the only assistant entry in either
-- is `private.assistant_evidence_entity_guard()`, which is untouched. Checked rather than assumed,
-- because a rewrite that leaves a pin behind fails the scope assertions.
--
-- THE EXPORT REGISTRY DOES need its schema hash moved: `assistant_source_references` is
-- classified `exclude`, and the registry stores a hash of the column list so that a table quietly
-- gaining a column cannot slip past the decision that excluded it.

alter table public.assistant_source_references
  add column if not exists route_params jsonb;

comment on column public.assistant_source_references.route_params is
  'The shaped filter this citation stands for -- a map of query-parameter names to the values the '
  'tool measured with. Read by src/lib/assistant/routeAccess.ts as the single authority for what '
  'the link may contain; a shaped route arriving without it is refused. Stored from 0308 because '
  'without it the declaration survived only until the reader refreshed, and the refusal then took '
  'the whole run out of the history rather than just the citation.';

-- ---------------------------------------------------------------------------------------------
-- The writer.
-- ---------------------------------------------------------------------------------------------
do $patch_record_run_0308$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.assistant_record_run(uuid,uuid,boolean,text,jsonb,text,text,text,text,integer,integer,bigint,integer,boolean,jsonb,jsonb,jsonb,jsonb,uuid,uuid,jsonb)'::regprocedure),
    e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  if position('route_params' in v_definition) > 0 then
    return; -- already carried; this migration is being re-applied
  end if;

  v_anchor := $anchor$      insert into assistant_source_references (
        org_id, run_id, source_ref, entity, entity_id, label, route, classification
      ) values (
        v_org, p_run_id,
        v_item ->> 'id',
        v_item ->> 'entity',
        (v_item ->> 'entity_id')::uuid,
        v_item ->> 'label',
        v_item ->> 'route',
        v_item ->> 'classification'
      );$anchor$;
  v_replacement := $replacement$      insert into assistant_source_references (
        org_id, run_id, source_ref, entity, entity_id, label, route, classification, route_params
      ) values (
        v_org, p_run_id,
        v_item ->> 'id',
        v_item ->> 'entity',
        (v_item ->> 'entity_id')::uuid,
        v_item ->> 'label',
        v_item ->> 'route',
        v_item ->> 'classification',
        -- `->` and not `->>`: the declared window is a MAP, and reading it as text would store
        -- the JSON as a string that the snapshot then hands back as a string. Absent stays null.
        v_item -> 'route_params'
      );$replacement$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0308: source reference insert anchor count %', v_count; end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_record_run_0308$;

-- ---------------------------------------------------------------------------------------------
-- The reader.
-- ---------------------------------------------------------------------------------------------
do $patch_snapshot_0308$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.service_assistant_conversation_snapshot(uuid,uuid,uuid,integer)'::regprocedure), e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  if position('route_params' in v_definition) > 0 then
    return;
  end if;

  v_anchor := $anchor$            'route', source.route,
            'classification', source.classification)$anchor$;
  v_replacement := $replacement$            'route', source.route,
            'classification', source.classification,
            'route_params', source.route_params)$replacement$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0308: snapshot source anchor count %', v_count; end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_snapshot_0308$;

-- The registry stores a hash of the column list precisely so a new column cannot slip past the
-- decision that excluded this table from a tenant export.
update private.tenant_export_registry registry
set exported_columns = case when registry.disposition = 'exclude' then '{}'::text[] else (
      select array_agg(c.column_name order by c.ordinal_position)
      from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = registry.table_name
        and not (c.column_name = any(registry.excluded_columns))) end,
    schema_hash = (
      select md5(string_agg(c.column_name || ':' || c.data_type || ':' || c.is_nullable, '|'
        order by c.ordinal_position))
      from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = registry.table_name)
where registry.table_name = 'assistant_source_references';

do $assert_0308$
declare
  v_violations text;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'assistant_source_references'
      and column_name = 'route_params' and data_type = 'jsonb'
  ) then
    raise exception '0308: the declared window has nowhere to live';
  end if;
  if position('route_params' in (select prosrc from pg_proc where oid =
       'public.assistant_record_run(uuid,uuid,boolean,text,jsonb,text,text,text,text,integer,integer,bigint,integer,boolean,jsonb,jsonb,jsonb,jsonb,uuid,uuid,jsonb)'::regprocedure)) = 0
  then
    raise exception '0308: the writer still drops the declared window';
  end if;
  if position('route_params' in (select prosrc from pg_proc where oid =
       'public.service_assistant_conversation_snapshot(uuid,uuid,uuid,integer)'::regprocedure)) = 0
  then
    raise exception '0308: the snapshot still hands back a citation with no window';
  end if;

  select string_agg(assertion || ' -- ' || detail, chr(10) order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception '0308 scope assertions failed:%', chr(10) || v_violations;
  end if;
  select string_agg(detail, chr(10) order by detail) into v_violations
  from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception '0308 export registry failed:%', chr(10) || v_violations;
  end if;
end
$assert_0308$;
