-- 0148 -- The dashboard stops measuring due-date COVERAGE and starts measuring the MONEY due.
--
-- THE GAP (owner review, defect 11): the snapshot answers "how many active payment requests
-- carry a due date" (dueDateCoverage out of activeCount) and the dashboard draws that ratio as a
-- radial ring. A manager cannot act on it -- it is a data-hygiene statistic wearing a KPI's
-- clothes. What decides the week is the AMOUNT: how much money falls due in the next seven days,
-- and how much of that is already late. Both figures are one aggregate away from the CTE that
-- already counts exactly those rows, so this migration adds the aggregates rather than a reader.
--
-- ANCHORED REPLACEMENT, not create-or-replace (the 0137/0145 pattern): the live body is NOT
-- 0100's text. 0137 patched this function in place to add `and i.financial_role = 'payable'` to
-- its invoice reader. Pasting 0100's body back would silently revert that fence and quietly widen
-- every money figure on the manager's dashboard -- an invoice-scoping bug no test would catch,
-- because the JSON shape would be identical. So: read the live definition, normalise \r (the
-- CRLF trap docs/DEBT-REGISTER.md knows), replace two anchors, fail loudly if either moved.
-- Anchors are assembled from single-line literals joined with an explicit e'\n': a multi-line
-- literal in this file would carry whatever line endings the checkout happened to produce.
--
-- `create or replace` (which is what pg_get_functiondef emits) preserves ownership, the ACLs
-- 0100 set, and the `security invoker` / `stable` / `strict` markers p21 asserts on. The function
-- stays SECURITY INVOKER: RLS remains the authorization boundary, so no definer exemption is
-- added or needed here.
--
-- NULL POLICY, unchanged and deliberate: the three new keys ride the SAME `active_due_dated > 0`
-- guard as `overdue` and `dueToday`. No active dated request at all -> JSON null -> the tile
-- prints a sentence, never a figure. Dated requests exist but none fall in the window -> a
-- genuine 0, because that IS the measurement. The `coalesce` inside the guard is what separates
-- the two cases: `sum(...) filter (...)` returns null for an empty filter, and an empty filter
-- under a non-empty denominator means zero shekels owed, not "unknown". Zero is a claim about
-- reality (CLAUDE.md); it is only allowed where the measurement actually made it.

do $due_window$
declare
  v_def text;
  v_anchor text;
  v_replacement text;
begin
  v_def := replace(pg_get_functiondef(
    'public.management_dashboard_snapshot(date)'::regprocedure), e'\r', '');

  -- Idempotent (the 0117/0145 lesson): re-running must recognise ITS OWN result -- the exact
  -- line this migration writes, not any 'dueWithin7' substring a later patch might introduce.
  -- This probe is load-bearing, not decoration: anchor (1) below is a PREFIX of the line it
  -- produces, so a second pass without this guard would append the aggregates twice.
  if position('      ''dueWithin7Amount'', case' in v_def) > 0 then
    return;
  end if;

  -- (1) The metrics CTE gains three aggregates over rows it already filters. The active
  -- predicate is copied verbatim from the counts beside it -- one wording of "still open",
  -- repeated the way this body already repeats it, so the money and the counts can never end up
  -- disagreeing about which requests are live.
  v_anchor := '      )::int as due_today';
  v_replacement := concat_ws(e'\n',
    '      )::int as due_today,',
    '      sum(amount) filter (',
    '        where due_date < p_today and status not in (''executed'', ''matched'', ''cancelled'')',
    '      )::numeric as overdue_amount,',
    '      sum(amount) filter (',
    '        where due_date between p_today and p_today + 7',
    '          and status not in (''executed'', ''matched'', ''cancelled'')',
    '      )::numeric as due_within_7_amount,',
    '      count(*) filter (',
    '        where due_date between p_today and p_today + 7',
    '          and status not in (''executed'', ''matched'', ''cancelled'')',
    '      )::int as due_within_7');
  if position(v_anchor in v_def) = 0 then
    raise exception
      '0148: payment_request_metrics no longer ends at due_today -- fix this anchor '
      'deliberately rather than letting the migration guess where the CTE closes.';
  end if;
  v_def := replace(v_def, v_anchor, v_replacement);

  -- (2) Three keys after 'dueToday', under that key's own null guard.
  v_anchor := concat_ws(e'\n',
    '        when pr.active_due_dated > 0 then pr.due_today',
    '        else null',
    '      end');
  v_replacement := concat_ws(e'\n',
    '        when pr.active_due_dated > 0 then pr.due_today',
    '        else null',
    '      end,',
    '      -- 0148: the money, under the same evidence guard as the counts above. coalesce turns',
    '      -- "dated requests exist, none in this window" into a measured 0; the guard keeps',
    '      -- "no dated request at all" as null.',
    '      ''overdueAmount'', case',
    '        when pr.active_due_dated > 0 then coalesce(pr.overdue_amount, 0)',
    '        else null',
    '      end,',
    '      ''dueWithin7Amount'', case',
    '        when pr.active_due_dated > 0 then coalesce(pr.due_within_7_amount, 0)',
    '        else null',
    '      end,',
    '      ''dueWithin7Count'', case',
    '        when pr.active_due_dated > 0 then pr.due_within_7',
    '        else null',
    '      end');
  if position(v_anchor in v_def) = 0 then
    raise exception
      '0148: the dueToday null guard is not where 0100 left it -- the new money keys must sit '
      'under the same guard, so this migration refuses to place them by guess.';
  end if;
  v_def := replace(v_def, v_anchor, v_replacement);

  execute v_def;
end
$due_window$;

comment on function public.management_dashboard_snapshot(date) is
  'Owner/office tenant-scoped dashboard snapshot. SECURITY INVOKER; preserves RLS and '
  'null-vs-zero evidence semantics. 0148 adds the due-window money (overdueAmount, '
  'dueWithin7Amount, dueWithin7Count) under the existing dated-request evidence guard.';

-- ===== A1/A3/A5 re-assertion (the 0058:207-218 idiom) =====
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0148 scope assertions failed:\n%', v_violations;
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
  where n.nspname = 'public' and p.proname = 'management_dashboard_snapshot';

  -- (a) The three money keys exist, each under the dated-request evidence guard.
  if position('''overdueAmount'', case' in v_src) = 0
     or position('''dueWithin7Amount'', case' in v_src) = 0
     or position('''dueWithin7Count'', case' in v_src) = 0 then
    raise exception '0148: the due-window money keys are not in the projection.';
  end if;
  if position('coalesce(pr.overdue_amount, 0)' in v_src) = 0
     or position('coalesce(pr.due_within_7_amount, 0)' in v_src) = 0 then
    raise exception
      '0148: a money key lost its coalesce -- "dated requests exist, none in this window" '
      'would render as unknown instead of the measured zero it is.';
  end if;

  -- (b) The window is the seven days FROM today, and the overdue slice is strictly before it --
  -- the two must not overlap, or the tile would count the same shekel twice.
  if position('sum(amount) filter (' in v_src) = 0
     or position('where due_date < p_today and status not in' in v_src) = 0
     or position('where due_date between p_today and p_today + 7' in v_src) = 0 then
    raise exception '0148: the due-window predicates drifted from overdue-vs-next-seven-days.';
  end if;

  -- (c) 0137's payable fence survived the round trip through pg_get_functiondef.
  if position('i.financial_role = ''payable''' in v_src) = 0 then
    raise exception
      '0148: the invoice reader lost the financial_role fence 0137 installed -- supporting '
      'evidence would be counted as money owed on the manager''s dashboard.';
  end if;

  -- (d) The projection is still SECURITY INVOKER with the grants 0100 set.
  if (select p.prosecdef from pg_proc p where p.oid =
        'public.management_dashboard_snapshot(date)'::regprocedure) then
    raise exception '0148: the dashboard projection must remain SECURITY INVOKER.';
  end if;
  if not has_function_privilege(
       'authenticated', 'public.management_dashboard_snapshot(date)', 'EXECUTE')
     or has_function_privilege(
       'anon', 'public.management_dashboard_snapshot(date)', 'EXECUTE') then
    raise exception '0148: the dashboard projection execute grants drifted.';
  end if;
end
$$;
