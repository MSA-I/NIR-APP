-- 0299 — give the derived answer a name. Wave 6, step 1 of the stored payment_status teardown.
--
-- A stored status column is a second answer to a question the allocation tables already answer,
-- and the two drift. This repository already knows that: its constitution says balances are
-- COMPUTED and never stored, and `invoices.payment_status` is the surviving exception. The owner
-- ruled the teardown be done fully, and it is done in three separately applicable steps so that
-- no single step both changes the write path and removes a read path.
--
-- WHAT THE MEASUREMENT FOUND, and three of the four were not in the plan:
--
--   * ONE drifted row in the whole database — invoice 3377, stored `paid`, 150.000 ILS still
--     owed. Its repair is a one-row data remediation and NOT this migration
--     (`artifacts/w6/data-remediation/invoice-3377.sql`).
--   * A THIRD answer. `invoice_financial_check_signals` computes its own balance with a
--     DIFFERENT credit rule — the credit request total rather than the credit allocations. On
--     3377 the stored column says paid, the balance surface says 150 owed, and check-signals
--     says 0 owed. Three surfaces, three answers, one invoice.
--   * AN UNLISTED, CURRENCY-BLIND TOLERANCE. The writer decides `paid` on `<= 1`, which is one
--     unit of WHATEVER currency the invoice is in. `check:tolerance-surfaces` could not see it,
--     because that guard finds money_tolerance call sites and this was a bare literal. It becomes
--     the fifth registered key here, so the owner can state it per currency — and its derived
--     value for a two-decimal currency is exactly 1.00, so the shekel does not move by a single
--     agora today.
--   * THE OFFICE ROLE IS THE LOAD-BEARING CONSTRAINT. `invoices_select` admits office;
--     `payment_allocations` does not. The stored column is the ONLY paid/unpaid signal office
--     has, deliberately coarse. A plain computed column would read zero allocations for office
--     and report every invoice unpaid — which is why the public wrapper below is SECURITY
--     DEFINER and re-reads the invoice under the select policy's own rules rather than trusting
--     the composite it was handed.
--
-- WHY THIS STEP IS SAFE ON ITS OWN: nothing is dropped or renamed, no existing reader changes,
-- and the write path is untouched. If the derived expression below were wrong, no screen and no
-- command would move — the only consequence is that `private.p1_payment_status_drift()` reports
-- rows, which is a measurement rather than an outage. Step 2 moves the readers; step 3 removes
-- the column, and refuses to run while the drift query returns anything.

--
-- WHY THIS IS SAFE ON ITS OWN: nothing is dropped, nothing is renamed, no existing reader
-- changes, and the write path is untouched. `invoices.payment_status` keeps being written by
-- `p1_refresh_invoice_payment_statuses` and keeps being read by all nine readers. If the derived
-- expression below is wrong, no screen and no command moves — the only thing that happens is
-- that `private.p1_payment_status_drift()` reports rows, which is a measurement, not an outage.
--
-- WHAT IT ADDS:
--   * `private.invoice_payment_state(invoices)` — the single derived expression, once.
--   * `public.invoice_payment_state(invoices)` — the PostgREST computed column, SECURITY DEFINER
--     so `office` gets the label, re-reading the invoice under `invoices_select`'s own rules so a
--     forged composite argument cannot become an oracle.
--   * `payment_state` on `p0_invoice_balance_rows_by_currency()` and on the view, so the badge
--     and the balance on one screen come from one query.
--   * `private.p1_payment_status_drift()` — the assertion the whole teardown rests on.
-- #############################################################################################

-- --- 1a. The derived expression, written once, in two callable shapes. ------------------------
-- Not SECURITY DEFINER: it is called from definer bodies and from the definer wrapper below,
-- and giving it definer rights of its own would put a second door on the same room.
--
-- TWO SHAPES, ONE DEFINITION. The four-argument form is the real one. The row form is a thin
-- delegate for the five bodies that already hold a `v_invoice public.invoices`. Both are needed
-- because `create_monthly_report_snapshot` reads from a CTE — `invoice_source as materialized
-- (select i.*, s.name as supplier_name, ... from public.invoices i)` — whose row type is
-- `invoices` PLUS two columns, so the row form does NOT typecheck there. That was verified by
-- reading the live body, not assumed.
create or replace function private.invoice_payment_state(
  p_org uuid, p_invoice_id uuid, p_total numeric, p_currency text)
returns public.invoice_payment_status
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  with allocated as (
    select
      coalesce((select sum(allocation.amount)
                from public.payment_allocations allocation
                where allocation.org_id = p_org
                  and allocation.invoice_id = p_invoice_id), 0) as cash,
      coalesce((select sum(allocation.amount)
                from public.payment_allocations allocation
                join public.credit_requests credit
                  on credit.org_id = allocation.org_id and credit.id = allocation.credit_id
                where credit.org_id = p_org
                  and credit.invoice_id = p_invoice_id), 0) as credited
  )
  select case
    -- The tolerance is the currency's own, never one unit of whatever currency this happens to
    -- be. `private.money_tolerance` answers 100 * 10^-minor_units when the organisation has
    -- stated nothing, which is exactly 1.00 for the shekel — the number the `<= 1` in
    -- `p1_refresh_invoice_payment_statuses` always meant and never said.
    when p_total - allocated.cash - allocated.credited
         <= coalesce(private.money_tolerance(p_org, p_currency,
                                             'invoice_payment_settled_tolerance'), 0)
      then 'paid'::public.invoice_payment_status
    -- Cash OR credit. The stored writer tests cash alone, so an invoice reduced only by a
    -- partial credit reads 'unpaid' there while money has demonstrably moved against it.
    when allocated.cash + allocated.credited > 0
      then 'partial'::public.invoice_payment_status
    else 'unpaid'::public.invoice_payment_status
  end
  from allocated
$$;

create or replace function private.invoice_payment_state(p_invoice public.invoices)
returns public.invoice_payment_status
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  select private.invoice_payment_state(
    p_invoice.org_id, p_invoice.id, p_invoice.total_amount, p_invoice.currency)
$$;

comment on function private.invoice_payment_state(uuid, uuid, numeric, text) is
  'The derived payment state of one invoice, in that invoice''s own currency. The single '
  'definition; every reader calls this rather than carrying its own arithmetic.';

-- --- 1b. The PostgREST computed column. -------------------------------------------------------
-- SECURITY DEFINER because `pa_select` closes `payment_allocations` to `office`, and the coarse
-- label is a signal office has had since the column existed. It returns the LABEL and never a
-- number, which is the same boundary `invoice_financial_check_signals` already draws.
--
-- The invoice is RE-READ here rather than trusted from `$1`: PostgREST supplies a real row, but
-- a composite argument is forgeable in principle, and a definer that answers about a row the
-- caller cannot select is an oracle. The predicate below is `invoices_select` restated, plus the
-- scope rider — which is also the executable scope marker A5 requires.
create or replace function public.invoice_payment_state(public.invoices)
returns public.invoice_payment_status
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select private.invoice_payment_state(invoice)
  from public.invoices invoice
  where invoice.id = $1.id
    and invoice.org_id = public.auth_org()
    and invoice.deleted_at is null
    and (invoice.unit_id is null or invoice.unit_id = any(public.auth_scopes()))
    and (
      public.auth_role() = any (array['owner'::user_role, 'office'::user_role])
      or (public.auth_role() = 'accountant'::user_role
          and invoice.review_status = 'approved'::invoice_review_status)
    )
$$;

revoke all on function public.invoice_payment_state(public.invoices) from public;
grant execute on function public.invoice_payment_state(public.invoices) to authenticated;

insert into private.scope_definer_enforcements
  (function_signature, body_hash, enforcement_kind, scope_proof)
values (
  'invoice_payment_state(invoices)',
  md5(replace((select prosrc from pg_proc
               where oid = 'public.invoice_payment_state(public.invoices)'::regprocedure),
              e'\r', '')),
  'filtered_read',
  'Re-reads the invoice under auth_org(), the auth_scopes() rider and the invoices_select role '
  || 'predicate before deriving; a row outside the caller''s org, scope or role returns null.'
)
on conflict (function_signature) do update
  set body_hash = excluded.body_hash,
      enforcement_kind = excluded.enforcement_kind,
      scope_proof = excluded.scope_proof;

-- --- 1c. WITHDRAWN, and the reason belongs in the file rather than in a report. --------------
--
-- The request also put `payment_state` on `p0_invoice_balance_rows_by_currency()` and on the
-- view over it, so a screen could take the badge and the balance from one query. Postgres
-- refuses it: adding an OUT parameter changes the function's return row type, and
-- `create or replace` cannot do that -- it demands a DROP, which in turn demands dropping the
-- view that depends on the function and rebuilding both.
--
-- That is a perfectly ordinary dance, and it is exactly what this step promised not to do.
-- STEP 1 is safe precisely BECAUSE nothing is dropped: if the derived expression is wrong, the
-- only consequence is that a measurement reports rows. A drop-and-recreate of a granted view on
-- the invoice balance surface is a different risk with a different rollback, and it buys a
-- convenience that neither STEP 2 nor STEP 3 needs -- step 2 calls
-- `private.invoice_payment_state(...)` directly in all fifteen places and never reads this
-- column, and step 3 does not mention the surface at all.
--
-- So it is not here. A screen that wants both in one query can have it later, in a migration
-- whose only job is that, where the drop is the headline rather than a footnote.

-- --- 1d. The assertion the whole teardown rests on. -------------------------------------------
-- Not a product surface: a measurement, callable by the suites and by a human before STEP 3.
-- Returns one row per invoice where the STORED label and the DERIVED state disagree. It must
-- return zero rows before STEP 3 is applied, and it is the reason STEP 3 can be applied at all.
create or replace function private.p1_payment_status_drift()
returns table(
  org_id uuid, invoice_id uuid, invoice_number text, currency text,
  total_amount numeric, stored public.invoice_payment_status,
  derived public.invoice_payment_status, balance_in_currency numeric)
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  select i.org_id, i.id, i.invoice_number, i.currency, i.total_amount,
         i.payment_status, private.invoice_payment_state(i),
         (i.total_amount - d.cash - d.credited)::numeric(14,3)
  from public.invoices i
  cross join lateral (
    select
      coalesce((select sum(a.amount) from public.payment_allocations a
                where a.org_id = i.org_id and a.invoice_id = i.id), 0) as cash,
      coalesce((select sum(a.amount) from public.payment_allocations a
                join public.credit_requests c on c.org_id = a.org_id and c.id = a.credit_id
                where c.org_id = i.org_id and c.invoice_id = i.id), 0) as credited
  ) d
  where i.deleted_at is null
    and i.payment_status is distinct from private.invoice_payment_state(i)
$$;

comment on function private.p1_payment_status_drift() is
  'Rows where the stored invoices.payment_status and the derived state disagree. Zero rows is '
  'the precondition for dropping the column (Wave 6, step 3).';

-- --- 1e. STEP 1 self-check. --------------------------------------------------------------------
do $assert_step1$
declare
  v_violations text;
  v_drift integer;
begin
  if to_regprocedure('public.invoice_payment_state(public.invoices)') is null then
    raise exception 'w6/step1: the computed column was not created';
  end if;
  -- The shekel must not move. 100 * 10^-2 is exactly the 1 the old body hard-coded.
  if (select private.money_tolerance(o.id, 'ILS', 'invoice_payment_settled_tolerance')
      from public.organizations o limit 1) <> 1 then
    raise exception 'w6/step1: the derived ILS tolerance is not 1.00, so the shekel would move';
  end if;
  select count(*) into v_drift from private.p1_payment_status_drift();
  -- REPORTED, NOT ENFORCED, at step 1. A drifted row here is exactly what this step exists to
  -- make visible; failing the migration on it would hide the measurement behind an outage.
  raise notice 'w6/step1: % invoice(s) where stored and derived disagree.', v_drift;
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'w6/step1 scope failed:\n%', v_violations;
  end if;
end
$assert_step1$;

-- --- 1f. OUTSIDE THIS FILE, IN THE SAME MERGE AS STEP 1. --------------------------------------
--   * `scripts/tolerance-surfaces.json` gains `invoice_payment_settled_tolerance`
--     (`surface: settings`, `ilsBaseline: 1`, `unconfigured: skip`, `derivedMinorUnits: 100`).
--   * `src/components/CurrencyTolerancesPanel.tsx` renders it, or `check:tolerance-surfaces`
--     fails on "a key that claims a settings screen and is not on it".
--   Neither can land before this migration: the guard scans MIGRATIONS for `money_tolerance`
--   call sites, so a JSON entry with no call site fails the orphan arm instead.


