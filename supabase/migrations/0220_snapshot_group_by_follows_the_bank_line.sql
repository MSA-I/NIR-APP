-- 0220: `create_monthly_report_snapshot` learns that a bank line has one more column.
--
-- WHAT BROKE, AND HOW IT WAS FOUND. `0217` added `bank_transactions.currency`. The monthly
-- snapshot builds a CTE `relevant_bank_transactions` and then aggregates `select b.*` from it with
-- a GROUP BY that ENUMERATES every column of a bank transaction by name. Postgres can normally
-- infer the rest of a row from a grouped primary key — but only for a real table; a CTE carries no
-- primary key, so the enumeration is load-bearing, and one new column makes the whole function
-- fail to plan:
--
--   ERROR: column "b.currency" must appear in the GROUP BY clause or be used in an aggregate
--
-- It was found by running `supabase/tests/monthly_report_snapshots.sql` against the migrated
-- schema, which is the only reason it is being fixed in the same wave rather than discovered in
-- CI. Nothing else in the schema has this shape: a search of every function body that carries both
-- `group by` and a column of an altered table returns five, and the other four group by columns of
-- REAL tables (`purchase_order_items`, `invoice_lines`), neither of which gained a column, so the
-- primary-key dependency covers them.
--
-- WHY AN ANCHORED REPLACEMENT AND NOT A RESTATEMENT. The function is 21,000 characters of
-- legal-entity resolution, immutable snapshot construction and hashing. Retyping it to change one
-- GROUP BY is how a clause goes missing, which is exactly what `check:anchored-replacements`
-- exists to prevent. The live body is read, the carriage returns are stripped (a body applied from
-- Windows carries CRLF and a body applied on a Linux runner does not — the difference that aborted
-- the 0171–0205 rollout at 0181), one anchor is replaced, and the result is re-executed. If the
-- anchor is not found the migration fails rather than silently doing nothing.
--
-- WHAT THIS IS NOT. It is not the report's per-currency work. `#287` — a currency column on every
-- money sheet and a sheet per currency only in a mixed month — is phase 5, together with
-- `report_version` and the reading of an older snapshot as ILS. This file keeps the existing
-- snapshot buildable; it does not change what the workbook says.

do $anchor_0220$
declare
  v_definition text;
  v_patched    text;
  v_anchor     constant text :=
    'b.is_debit, b.reference, b.raw, b.supplier_id, b.status, b.row_hash';
begin
  v_definition := replace(
    pg_get_functiondef('public.create_monthly_report_snapshot(date,uuid)'::regprocedure),
    e'\r', '');

  v_patched := replace(v_definition, v_anchor, v_anchor || ', b.currency');

  if v_patched = v_definition then
    raise exception '0220: the bank_source GROUP BY anchor was not found in the live body';
  end if;
  -- Exactly one site. Two would mean the anchor is not the one this migration reasoned about.
  if (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception '0220: the GROUP BY anchor appears more than once';
  end if;

  execute v_patched;
end
$anchor_0220$;

-- The body changed, so A5's pinned hash has to be recomputed here or every later migration fails
-- with "stale scope enforcement registration". Computed from pg_proc, never written as a literal.
update private.scope_definer_enforcements enforcement
set body_hash = md5(replace(proc.prosrc, e'\r', '')),
    scope_proof = '0220 changes one GROUP BY list so the snapshot can still be planned after '
      || 'bank_transactions gained a currency column. The legal-entity assertion, the payable '
      || 'filter and the immutable hashing are untouched.'
from pg_catalog.pg_proc proc
where proc.oid = pg_catalog.to_regprocedure('public.create_monthly_report_snapshot(date,uuid)')
  and enforcement.function_signature = 'create_monthly_report_snapshot(date,uuid)';

do $assert_0220$
declare
  v_violations text;
begin
  if position('b.row_hash, b.currency' in (
       select replace(prosrc, e'\r', '') from pg_proc
        where oid = 'public.create_monthly_report_snapshot(date,uuid)'::regprocedure)) = 0 then
    raise exception '0220: the patched GROUP BY is not in the live body';
  end if;
  -- The properties the anchored replacement must not have dropped.
  if not (select prosecdef from pg_proc
           where oid = 'public.create_monthly_report_snapshot(date,uuid)'::regprocedure) then
    raise exception '0220: the snapshot command stopped being SECURITY DEFINER';
  end if;
  if position('financial_role = ''payable''' in (
       select prosrc from pg_proc
        where oid = 'public.create_monthly_report_snapshot(date,uuid)'::regprocedure)) = 0 then
    raise exception '0220: the payable filter is gone from the snapshot command';
  end if;

  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0220 scope assertions failed:\n%', v_violations;
  end if;
end
$assert_0220$;
