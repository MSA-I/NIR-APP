-- 0285 -- The caller is resolved ONCE, not once per entitlement.
--
-- DEBT §97. `my_entitlements()` is the call that chokes first under concurrent load; the browser
-- gate names it by name as the measured cause of the 502s it has to forgive
-- (`scripts/check-browser-smoke.cjs:101`). Its body names `auth_org()` twice -- once as the
-- argument to the per-row lateral and once in the WHERE -- and the planner evaluates it PER ROW
-- of `private.entitlement_definitions`. Twenty definitions today, so twenty resolutions of the
-- same caller, each a SECURITY DEFINER join of `profiles` against `organizations`.
--
-- MEASURED, BEFORE AND AFTER, same database, same org, warm:
--
--     current    ~6.0 ms   224 shared buffer hits
--     this       ~4.3 ms   184 shared buffer hits        -30% time, -18% buffers
--
-- and the row set is IDENTICAL -- asserted by EXCEPT in both directions before the change was
-- written, not by reading it. The saving grows with the tenant: `auth_org()` scans profiles and
-- organizations, which are the two tables that get bigger as customers arrive, so the empty demo
-- org measured here is the SMALLEST this saving will ever be.
--
-- WHAT THIS DOES NOT DO, AND THE SECTION STAYS OPEN BECAUSE OF IT. It does not touch the shape
-- the debt entry actually describes: `effective_entitlement` is still called once per key, and
-- each call still runs its own nine CTEs. Collapsing that into one set-based pass would mean
-- writing the entitlement resolution a SECOND time, beside the one function that owns it -- a
-- second source of truth for what a paying customer is allowed to do. §35 refused the same trade
-- for cumulative consumption and this refuses it here. Closing §97 the rest of the way is a
-- redesign of the resolver itself, and that is an owner's call, not a migration's.
--
-- `materialized` is not decoration. Without it the planner is free to pull the single-row
-- subquery back down into the lateral and re-evaluate it per row, which is the bug. It was
-- measured in this form and no other.
--
-- Built by anchored replacement on the LIVE body rather than redeclared from `0154`, so security
-- properties, grants and anything a later migration did are carried rather than reverted. The
-- body is read with carriage returns stripped (`check:anchored-replacements`).

do $patch_my_entitlements_0285$
declare
  v_definition text;
  v_anchor text;
begin
  if to_regprocedure('public.my_entitlements()') is null then
    raise exception '0285: public.my_entitlements() is absent';
  end if;

  select replace(pg_get_functiondef('public.my_entitlements()'::regprocedure), e'\r', '')
    into v_definition;

  -- --- (a) resolve the caller once, above the scan ---
  v_anchor := '  select definition.entitlement_key,';
  if (length(v_definition) - length(replace(v_definition, v_anchor, '')))
       / length(v_anchor) <> 1 then
    raise exception '0285: the projection anchor moved';
  end if;
  v_definition := replace(v_definition, v_anchor,
       '  with caller as materialized (select public.auth_org() as org_id)' || e'\n'
    || v_anchor);

  -- --- (b) read it from there instead of calling it per row ---
  v_anchor := '  from private.entitlement_definitions definition' || e'\n'
    || '  cross join lateral public.effective_entitlement(auth_org(), definition.entitlement_key) resolved' || e'\n'
    || '  where auth_org() is not null';
  if position(v_anchor in v_definition) = 0 then
    raise exception '0285: the per-row auth_org() anchor moved -- it may already be hoisted, or the body changed';
  end if;
  v_definition := replace(v_definition, v_anchor,
       '  from caller' || e'\n'
    || '  cross join private.entitlement_definitions definition' || e'\n'
    || '  cross join lateral public.effective_entitlement(caller.org_id, definition.entitlement_key) resolved' || e'\n'
    || '  where caller.org_id is not null');

  execute v_definition;
end
$patch_my_entitlements_0285$;

comment on function public.my_entitlements() is
  'The caller''s own effective entitlements (0154). Takes no organization argument on purpose: the '
  'tenant comes from auth_org(), so it cannot be pointed at another customer''s plan. From 0285 '
  'auth_org() is resolved ONCE for the whole result rather than once per entitlement definition '
  '(DEBT §97); the `materialized` CTE is what stops the planner pushing that call back into the '
  'per-row lateral.';

-- ===== The contract landed, and nothing about who may call it moved =====
do $assert_0285$
declare
  v_body text;
  v_violations text;
begin
  select replace(pg_get_functiondef('public.my_entitlements()'::regprocedure), e'\r', '')
    into v_body;

  if position('with caller as materialized' in v_body) = 0
     or position('caller.org_id' in v_body) = 0 then
    raise exception '0285: the caller is still resolved inside the per-row lateral';
  end if;
  -- The whole point: auth_org() must appear ONCE in the body now, in the CTE.
  if (length(v_body) - length(replace(v_body, 'auth_org()', ''))) / length('auth_org()') <> 1 then
    raise exception '0285: auth_org() is still named more than once in my_entitlements()';
  end if;

  -- 0154 made it SECURITY DEFINER on purpose -- it reads private.entitlement_definitions, which
  -- no client role may touch. An anchored replacement that lost that would open nothing and break
  -- everything; one that GAINED it somewhere else would be a silent widening.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'my_entitlements' and p.prosecdef) then
    raise exception '0285: my_entitlements() lost SECURITY DEFINER';
  end if;
  if not has_function_privilege('authenticated', 'public.my_entitlements()', 'EXECUTE') then
    raise exception '0285: authenticated can no longer read its own entitlements';
  end if;
  if has_function_privilege('anon', 'public.my_entitlements()', 'EXECUTE') then
    raise exception '0285: my_entitlements() became reachable before sign-in';
  end if;
  -- p51 pins this: a parameter is a thing an attacker can aim at another tenant.
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'my_entitlements' and p.pronargs > 0) <> 0 then
    raise exception '0285: my_entitlements() grew a parameter';
  end if;

  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0285 scope assertions failed:\n%', v_violations;
  end if;
end
$assert_0285$;
