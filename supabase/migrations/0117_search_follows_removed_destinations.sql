-- 0117 -- A search result whose destination no longer exists is worse than no result.
--
-- This campaign took two destinations away. G2 removed the supplier card from a kitchen manager --
-- they order from suppliers and receive goods; managing the supplier record is back-office work,
-- and 0112 enforced the half of that boundary a policy can enforce. G5 removed the audit-log
-- screen from the product entirely.
--
-- The global search never learned. `global_search` (0069) still hands a kitchen manager
-- `supplier` rows, and every one of them is a link to `/suppliers/:id`, a route that role no
-- longer has. What the person experiences is a result that looks like an answer and behaves like a
-- broken link -- which teaches them the search is unreliable, and that lesson generalises to the
-- results that DO work.
--
-- WHY THE SERVER AND NOT THE MENU. `src/components/GlobalSearch.tsx` carries a per-role map, and
-- the comment above it is careful to say what it is: display order, not a gate. Since 0069 the
-- reachable TYPES are decided here, from `auth_role()`, because a decision taken in the browser
-- over a function granted to `authenticated` is a suggestion. Removing the group from the menu
-- without removing it here would leave the rows crossing the network to a client that hides them.
--
-- WHAT A KITCHEN MANAGER KEEPS: products, invoices, orders and credits -- every type whose
-- destination they still have. This is a narrowing of one type, and section 3 asserts the others
-- survived it.
--
-- ANCHORED REPLACEMENT, not create-or-replace, for the reason this campaign has now hit twice:
-- the live body of a function here is not necessarily the text of the migration that created it
-- (0061 rewrites `execute_payment_request` in place). Replacing one exact line preserves anything
-- else that was injected, and a missing anchor fails loudly instead of writing an older version
-- back.

do $$
declare
  v_def text;
  v_old constant text :=
    'when ''kitchen''    then array[''supplier'', ''product'', ''invoice'', ''order'', ''credit'']';
  v_new constant text :=
    'when ''kitchen''    then array[''product'', ''invoice'', ''order'', ''credit'']';
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'global_search';
  if v_def is null then
    raise exception '0117: public.global_search is gone.';
  end if;
  -- Idempotent, and that is not a nicety. A migration whose first statement mutates and whose
  -- later statement fails leaves the mutation applied; re-running must then find its own result
  -- and continue, not mistake success for a drifted anchor. (Learned here: this migration failed
  -- on a signature typo AFTER the replacement had already committed.)
  if position(v_new in v_def) > 0 then
    return;
  end if;
  if position(v_old in v_def) = 0 then
    raise exception
      '0117: the kitchen row of the search type gate matches neither its anchor nor its own '
      'result. Fix the anchor deliberately rather than letting this migration write an older body '
      'back.';
  end if;
  execute replace(v_def, v_old, v_new);
end
$$;

comment on function public.global_search(text, integer) is
  'Cross-entity search whose reachable result TYPES are decided here, from auth_role(), not in the '
  'browser (0069, narrowed 0117). A kitchen manager no longer receives supplier rows: G2 took the '
  'supplier card away from that role, and a result that links somewhere the reader cannot go is '
  'worse than no result -- it teaches them the search is unreliable, and that lesson generalises '
  'to the results that work. They keep products, invoices, orders and credits.';

-- ===== A1/A3/A5 re-assertion =====
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0117 scope assertions failed:\n%', v_violations;
  end if;
end
$$;

-- ===== Anchors =====
do $$
declare
  v_src text;
begin
  select p.prosrc into v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'global_search';

  -- (a) The narrowing happened, on the server, where the gate is.
  if position('when ''kitchen''    then array[''product''' in v_src) = 0 then
    raise exception
      '0117: a kitchen manager still receives supplier rows from the search. Every one is a link '
      'to a route that role no longer has.';
  end if;

  -- (b) ...and it narrowed ONE type. A search that answers nothing is not a boundary, it is a
  -- broken feature, and the role that lost the supplier card still orders and receives every day.
  if position('''product''' in v_src) = 0 or position('''invoice''' in v_src) = 0
     or position('''order''' in v_src) = 0 or position('''credit''' in v_src) = 0 then
    raise exception '0117: the kitchen search lost a type it still has a destination for.';
  end if;

  -- (c) The roles that still manage suppliers keep finding them.
  if position('when ''owner''      then array[''supplier''' in v_src) = 0
     or position('when ''office''     then array[''supplier''' in v_src) = 0 then
    raise exception '0117: owner or office lost supplier search results.';
  end if;

  -- (d) The fail-closed arm survives. A role this map does not name -- including a null one --
  -- must receive nothing rather than everything.
  if position('else ''{}''::text[]' in v_src) = 0 then
    raise exception
      '0117: the search no longer fails closed for an unrecognised role.';
  end if;
end
$$;
