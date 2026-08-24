-- 0209 -- Every function body stores LF, so an anchored replacement can find its anchor.
--
-- WHAT THIS FIXES, AND HOW IT WAS FOUND.
--
-- The first dry run of `0171`-`0205` against production aborted at `0181`:
--
--     ERROR: P0001: 0181: platform scope lock anchor moved
--
-- The anchor had not moved. `0181` builds a multi-line anchor with `e'\n'` and searches the live
-- body for it; 58.8% of production function bodies store `\r\n`, so the search could never match.
--
-- CI never sees this. A Linux runner checks out with LF and applies from `0001`, so every
-- `prosrc` is LF and every anchor matches. Production was migrated from Windows through
-- `scripts/db-query.ps1`, which read each file as-is and posted CRLF. The two environments have
-- been building different bodies from the same files since the beginning, and the gate could not
-- tell, because the gate only ever sees one of them.
--
-- 18 of those 31 migrations read a live body with `pg_get_functiondef`, and only some strip `\r`
-- first. `0181` aborted first merely because it is the earliest unstripped reader whose anchor
-- spans lines; a single-line token search is CR-insensitive and passes by luck. Fixing `0181`
-- alone would move the failure, not remove it.
--
-- WHY THIS IS SAFE, MEASURED RATHER THAN ASSUMED.
--
-- Every `\r` in every body is part of a `\r\n` pair: across production, 16,362 CR and 16,362 CRLF,
-- so **zero lone CR**. No body carries an `e'\r'` literal. The one function that cares about
-- carriage returns at all -- `private.sql_has_executable_scope_marker`, the A5 marker lexer --
-- reaches them through `chr(13)`, which is a function call and is not touched by stripping line
-- endings from the source text.
--
-- The rewrite replays each function's OWN `pg_get_functiondef`, so volatility, `SECURITY DEFINER`,
-- `SET search_path`, argument names and return type all survive by construction. This is the
-- opposite of redeclaring a function from the migration that first created it, which silently
-- reverts whatever later migrations changed about it.
--
-- Extension-owned functions are excluded: they belong to their extension's own upgrade path, and
-- rewriting one here would make the next `ALTER EXTENSION UPDATE` fight this migration.

do $normalise$
declare
  v_function record;
  v_rewritten int := 0;
  v_lone_cr int;
begin
  -- Refuse before touching anything if the safety property does not hold. A lone CR would mean
  -- some body contains a carriage return that is NOT a line ending, and stripping it would be a
  -- content change rather than a formatting one.
  select count(*) into v_lone_cr
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private')
     and (length(p.prosrc) - length(replace(p.prosrc, e'\r', '')))
       > (length(p.prosrc) - length(replace(p.prosrc, e'\r\n', ''))) / 2;
  if v_lone_cr > 0 then
    raise exception
      '0209: % function(s) contain a carriage return that is not a line ending -- normalising '
      'would change content, not formatting', v_lone_cr;
  end if;

  for v_function in
    select p.oid,
           p.oid::regprocedure::text as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'private')
       and p.prolang in (select oid from pg_language where lanname in ('plpgsql', 'sql'))
       and p.prokind = 'f'
       and position(e'\r' in p.prosrc) > 0
       -- Not ours to rewrite: an extension owns its own function bodies.
       and not exists (
         select 1 from pg_depend d
          where d.objid = p.oid and d.classid = 'pg_proc'::regclass and d.deptype = 'e'
       )
     order by p.oid
  loop
    execute replace(pg_get_functiondef(v_function.oid), e'\r', '');
    v_rewritten := v_rewritten + 1;
  end loop;

  raise notice '0209: normalised % function bod(y/ies) to LF', v_rewritten;
end
$normalise$;

do $$
declare v_remaining int; v_violations text;
begin
  -- The sentinel is the property this migration CREATES: no body in our schemas stores a CR.
  select count(*) into v_remaining
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private')
     and p.prolang in (select oid from pg_language where lanname in ('plpgsql', 'sql'))
     and p.prokind = 'f'
     and position(e'\r' in p.prosrc) > 0
     and not exists (
       select 1 from pg_depend d
        where d.objid = p.oid and d.classid = 'pg_proc'::regclass and d.deptype = 'e'
     );
  if v_remaining > 0 then
    raise exception '0209: % function bod(y/ies) still store CRLF', v_remaining;
  end if;

  -- Rewriting 300+ definitions is exactly the moment to re-ask whether the trust boundary held.
  select string_agg(assertion||' -- '||detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0209 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
