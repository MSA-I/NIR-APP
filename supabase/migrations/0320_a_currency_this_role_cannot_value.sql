-- 0320: a currency this role cannot value is not a currency this supplier does not owe.
--
-- `MON-03` (high) and `FIN-04` (medium) are one mechanism, and `FIN-07` is the same mechanism seen
-- from the dashboard. `0218` wrote the supplier ledger in two halves that disagree about the role:
--
--   `0218:88-93`  the INVOICE reader filters the accountant's arm to `review_status = 'approved'`,
--                 so an unapproved invoice produces no balance row for that role at all.
--   `0218:118-130` the SUPPLIER reader joins `public.invoices` with NO such predicate, LEFT JOINs
--                 the balances onto it, and `coalesce(sum(...), 0)`s what comes back.
--
-- So for an accountant every currency the supplier trades in still produces a row, and the row the
-- role could not value is filled in with a zero. `/finance/suppliers/…/0013` printed `$ 0` directly
-- above the banner that states this product's own policy — and the truth behind that zero was a
-- real `$300` the accountant is not shown. `FIN-04` recorded it as "a phantom row on a supplier
-- with no dollar activity"; that reading is INVERTED. The dollar activity exists. The supplier owes
-- the money. What the screen printed was not a phantom, it was a false statement of settlement.
--
-- The constitution's sentence is the whole fix: a metric with no data shows `—`, never `0`, because
-- zero is itself a claim about reality — here the claim "this supplier owes nothing in dollars",
-- made to the one person whose job is to reconcile against a bank statement.
--
-- WHAT CHANGES, AND WHAT DELIBERATELY DOES NOT. The join becomes INNER, so every row this function
-- emits was valued by the caller's OWN read, and a currency the role cannot value produces no row
-- instead of a zero. `0218`'s header already decided what the screen must then draw and
-- `components/Money.tsx:67` already draws it: no rows is an em dash. Nothing is widened. The
-- accountant is shown NEITHER the dollar balance nor a zero standing in for it — widening the
-- population so two roles agree would be a privilege leak, and `FIN-07` is answered by the LABEL
-- stating its scope (`accountantDashboard.fmtMoneyRounded_2`, `invoiceList.spliceApprovedScope`),
-- never by the query.
--
-- THE OWNER'S FIGURES ARE PROVABLY UNCHANGED, and this is not a hope. The four predicates the
-- supplier reader puts on `public.invoices` -- same org, `deleted_at is null`,
-- `financial_role = 'payable'`, and the canonical null-or-`auth_scopes()` legal-entity test -- are
-- exactly the four the invoice reader applies, and the owner's arm adds nothing else. So for an
-- owner every joined invoice already has a balance row and the INNER join drops nothing. Only the
-- accountant's approval predicate can make the two sides differ, which is the defect. `p113` proves
-- this on the guarded path rather than asserting it here.
--
-- THE `coalesce(..., 0)` GOES WITH IT. `public.invoices.total_amount` is NOT NULL (measured against
-- production, 05.09.2026), so `balance_in_currency` is never null and a `sum()` over a group that
-- an inner join guarantees is non-empty is never null either: the coalesce is now unreachable. It
-- is removed rather than left in place because it is half of the mechanism this file exists to
-- close, and a dead expression that manufactures a zero is exactly the thing that comes back.
--
-- ANCHORED, against the body production is actually running. `pg_get_functiondef` was read from the
-- production project before this was written: the live body is byte-for-byte `0218`'s, LF, md5
-- `5d2fbb0deeb160fbf9071ac3aec4d264` -- so for THIS function `0218` really is the ancestor. That was
-- checked rather than assumed, because the campaign has already been bitten by a function that
-- looked like its creating migration and had been patched four times since. Re-declaring from
-- `0218` would still have been wrong: it silently restores whatever security properties a later
-- migration might have added, and there is no way to tell from the migration text that it did not.

do $patch_supplier_balance_role_predicate_0320$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.p0_supplier_balance_rows_by_currency()'::regprocedure),
    e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  -- (1) The join that manufactured the row. Anchored on the whole line including its indentation:
  -- `balances b on b.invoice_id = i.id` appears once, and the count is asserted rather than assumed.
  v_anchor := $anchor$  left join balances b on b.invoice_id = i.id$anchor$;
  v_replacement := $replacement$  join balances b on b.invoice_id = i.id$replacement$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0320: balance join anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- (2) The zero that filled it in. Unreachable after (1), and removed so it cannot come back.
  v_anchor := $anchor$         coalesce(sum(b.balance_in_currency), 0)::numeric(14,3),$anchor$;
  v_replacement := $replacement$         sum(b.balance_in_currency)::numeric(14,3),$replacement$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception '0320: balance coalesce anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  execute v_definition;
end
$patch_supplier_balance_role_predicate_0320$;

comment on function public.p0_supplier_balance_rows_by_currency() is
  'What each supplier is still owed, ONE ROW PER CURRENCY (0218, #277), counted only from invoices '
  'THE CALLER MAY VALUE (0320, MON-03/FIN-04). A supplier with shekel and dollar invoices returns '
  'two rows and nothing may add them. A currency whose invoices this role cannot read -- the '
  'accountant''s arm of p0_invoice_balance_rows_by_currency() stops at approved -- returns NO ROW, '
  'exactly as a supplier with no invoices does, and the screen draws the em dash the constitution '
  'requires of a metric with no data. It never returns a zero: zero is the sentence "this supplier '
  'owes nothing here", and that sentence was false against a real $300.';

-- A5 keeps a row per SECURITY DEFINER function that reads an enforced table, pinning the body it
-- was reviewed against. The body moved, so the hash is recomputed here or every later migration
-- fails with "stale scope enforcement registration". Read from `pg_proc`, never written as a
-- literal: a digest typed into a migration is a value produced on a machine whose line endings may
-- not match CI's (0141, and the CRLF rollout that aborted at 0181).
update private.scope_definer_enforcements enforcement
set body_hash = md5(replace(proc.prosrc, e'\r', '')),
    scope_proof = '0320 keeps 0218''s filter unchanged -- payable invoices in null-or-auth_scopes '
      || 'scope, one row per supplier AND currency -- and narrows the balance join from LEFT to '
      || 'INNER so every emitted row was valued by the caller''s own read. A currency this role '
      || 'may not value emits no row rather than a zero, which is the same answer 0218 already '
      || 'gave for a supplier with no invoices at all.'
from pg_proc proc
where proc.oid = 'public.p0_supplier_balance_rows_by_currency()'::regprocedure
  and enforcement.function_signature = 'p0_supplier_balance_rows_by_currency()';

do $assert_0320$
declare
  v_src        text;
  v_violations text;
begin
  select prosrc into v_src from pg_proc
  where oid = 'public.p0_supplier_balance_rows_by_currency()'::regprocedure;

  -- The sentinel is a property this patch CREATES and the old body could not contain: the old text
  -- was `coalesce(sum(b.balance_in_currency), 0)::numeric`, which does not carry this substring.
  -- Testing only for the ABSENCE of the old shape would pass on a body that never had it.
  if position('sum(b.balance_in_currency)::numeric(14,3)' in v_src) = 0 then
    raise exception '0320: the supplier ledger does not sum the valued rows without a coalesce';
  end if;
  if position('left join balances' in v_src) <> 0 then
    raise exception '0320: the supplier ledger still LEFT JOINs the balances it cannot value';
  end if;
  if position('coalesce(sum(b.balance_in_currency)' in v_src) <> 0 then
    raise exception '0320: the zero that filled an unvalued currency survives';
  end if;

  -- An anchored replacement executes a whole CREATE OR REPLACE, so the security properties travel
  -- with the text. They are asserted rather than trusted: this is the exact failure a partial
  -- re-declaration causes, and it is silent.
  if not (select prosecdef from pg_proc
          where oid = 'public.p0_supplier_balance_rows_by_currency()'::regprocedure) then
    raise exception '0320: the supplier ledger stopped being SECURITY DEFINER';
  end if;
  if not (select 'search_path=public' = any(coalesce(proconfig, array[]::text[])) from pg_proc
          where oid = 'public.p0_supplier_balance_rows_by_currency()'::regprocedure) then
    raise exception '0320: the supplier ledger lost its pinned search_path';
  end if;
  -- Asked with `has_function_privilege` rather than by reading as the role and catching
  -- `insufficient_privilege`: that standard shape takes the backend down on this database.
  --
  -- Only the two grants 0218 wrote are asserted. `anon` also carries EXECUTE here and always has
  -- -- Supabase's default privileges in `public` grant it at CREATE time, and 0218's
  -- `revoke all ... from public` does not reach a role-specific grant (it revoked `anon` from the
  -- VIEWS, which are the client surface, and those are still closed). It is harmless -- `auth_org()`
  -- and `auth_role()` are null for anon, so the body returns no rows -- and it is NOT this
  -- migration's to change: a CREATE OR REPLACE preserves the ACL, so asserting `not anon` here
  -- would fail on an untouched property and hide the one that moved.
  if not has_function_privilege('authenticated', 'public.p0_supplier_balance_rows_by_currency()', 'execute')
     or not has_function_privilege('service_role', 'public.p0_supplier_balance_rows_by_currency()', 'execute') then
    raise exception '0320: the supplier ledger lost a grant the client reads through';
  end if;

  -- 0058:207-218: the standing contracts are re-asserted where they can still be fixed cheaply.
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0320 scope assertions failed:\n%', v_violations;
  end if;
end
$assert_0320$;
