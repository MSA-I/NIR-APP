-- 0267 — the frozen forecast cohort joins the declared organization-teardown window.
--
-- WHY THIS FILE EXISTS, AND WHY IT IS A MERGE ARTEFACT RATHER THAN A MISTAKE IN EITHER BRANCH.
-- 0254 gave every DELETE guard standing on an org-scoped table one narrow window: inside a
-- declared teardown, and for DELETE alone, the guard returns instead of raising. It patched the
-- guards that existed when it was written. 0265 was authored on a branch that never saw 0254's
-- list and created a new frozen table, so `private.forecast_snapshot_rows_are_frozen` refuses
-- DELETE unconditionally — which means a tenant that ever had a monthly snapshot taken can no
-- longer be deleted at all. Each branch was correct alone; the pair is not.
--
-- p86_full_tenant_purge is the suite that names it. E1 enumerates every BEFORE DELETE row trigger
-- on a table carrying `org_id` whose function raises, and requires each one to declare a window.
-- It passed on both branches and failed on the merge — which is the failure E1 exists to produce.
--
-- WHAT DOES NOT CHANGE. UPDATE stays refused unconditionally on both tables, and DELETE stays
-- refused everywhere outside the window. The cohort is still frozen against every repair, every
-- backfill and every well-meaning correction. It simply stops outliving the tenant it describes.
--
-- WHY AN ANCHORED REPLACEMENT AND NOT A REDECLARATION. Re-issuing the function from 0265's own
-- text would silently restore whatever security properties 0265 happened to declare and drop
-- anything a later migration added. The body is read from the live catalogue, the anchor is
-- counted before anything is written, and a body that already carries a window is refused rather
-- than patched twice. This is 0254's mechanism, applied to the one guard it could not know about.

do $forecast_teardown_window$
declare
  v_sig    text := 'private.forecast_snapshot_rows_are_frozen()';
  v_def    text;
  v_count  integer;
  v_anchor text := chr(10) || 'begin' || chr(10);
  v_window text := chr(10) || 'begin' || chr(10) || $window$  -- 0254: the declared organization-teardown window (0175:347). Transaction-local GUC, a
  -- name test rather than a role test, and DELETE only -- UPDATE stays refused unconditionally.
  if tg_op = 'DELETE'
     and current_setting('app.audit_purge', true) = 'organization_teardown' then
    return old;
  end if;
$window$;
begin
  -- `chr(13)` rather than a carriage return typed into the literal: git's line-ending
  -- normalisation rewrites that byte, and a strip that has been rewritten returns the body
  -- unchanged while still looking like a strip.
  v_def := replace(pg_get_functiondef(v_sig::regprocedure), chr(13), '');

  if position('organization_teardown' in v_def) > 0 then
    raise exception '0267: % already declares a purge window -- refusing to patch it twice', v_sig;
  end if;

  v_count := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then
    raise exception '0267: the body of % carries % candidate anchors, not one -- refusing to '
                    'patch blindly', v_sig, v_count;
  end if;

  execute replace(v_def, v_anchor, v_window);
end
$forecast_teardown_window$;

-- =====================================================================================
-- The window landed, in the DELETE-only shape, and nothing stopped refusing
-- =====================================================================================
do $verify_0267$
declare
  v_def        text;
  v_violations text;
begin
  v_def := replace(
    pg_get_functiondef('private.forecast_snapshot_rows_are_frozen()'::regprocedure), chr(13), '');

  -- Present, and exactly once. Twice would mean the patch ran on an already-patched body.
  if (length(v_def) - length(replace(v_def, 'organization_teardown', '')))
     / length('organization_teardown') <> 1 then
    raise exception '0267: the teardown window is not declared exactly once';
  end if;

  -- DELETE only. A window that also opened UPDATE would let a repair rewrite a frozen cohort,
  -- which is the whole thing 0265 built these triggers to make impossible.
  if position('tg_op = ''DELETE''' in v_def) = 0 then
    raise exception '0267: the window is not restricted to DELETE';
  end if;

  -- And the guard still refuses outside it, by the same name the callers already match on.
  if position('raise exception ''forecast_snapshot_rows_are_frozen''' in v_def) = 0 then
    raise exception '0267: the guard stopped refusing';
  end if;

  -- Both triggers 0265 declared are still attached. A window on a function nothing calls would
  -- assert nothing at all.
  if not exists (select 1 from pg_catalog.pg_trigger
                 where tgname = 'forecast_snapshot_requests_frozen' and not tgisinternal)
     or not exists (select 1 from pg_catalog.pg_trigger
                    where tgname = 'forecast_snapshots_frozen' and not tgisinternal) then
    raise exception '0267: a frozen-row trigger went missing';
  end if;

  select string_agg(detail, chr(10) order by detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception '0267 scope assertions failed: %', v_violations;
  end if;
end
$verify_0267$;
