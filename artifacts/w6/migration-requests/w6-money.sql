-- =============================================================================================
-- WAVE 6 — MIGRATION REQUEST: the stored `invoices.payment_status` teardown, in three steps.
--
-- THIS FILE IS A REQUEST, NOT A MIGRATION. Wave 6 does not own `supabase/migrations/`. The three
-- STEP sections below are separately applicable: each is a complete migration body, in order,
-- and each is safe to stop at. Take the number for each from `npm run next-number -- migration`
-- at the moment you write it — do not read the highest number you can see and add one; that is
-- how six numbering collisions happened on 01.09.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT WAS MEASURED, AND HOW
--
-- Every claim below was read from the LIVE bodies on `supabase_db_supplyflow-p0`, never from the
-- migration that created them:
--
--   docker exec supabase_db_supplyflow-p0 psql -U postgres -d postgres -t -A \
--     -c "select pg_get_functiondef('public.fn(argtypes)'::regprocedure);"
--
-- THE WRITE PATH — exactly one function writes the column:
--
--   public.p1_refresh_invoice_payment_statuses(uuid, uuid[])   SECURITY DEFINER, language sql
--     update invoices i set payment_status = case
--       when i.total_amount - <cash allocated> - <credit allocated> <= 1 then 'paid'
--       when <cash allocated> > 0 then 'partial'
--       else 'unpaid' end
--     where i.org_id = p_org and i.id = any(coalesce(p_invoice_ids, '{}'::uuid[]));
--
--   Its four callers, all live-verified:
--     public.refresh_invoice_payment_status(uuid)      — the browser-facing wrapper
--     public.execute_payment_request(...)              — perform p1_refresh_invoice_payment_statuses(v_org, v_invoice_ids)
--     public.match_bank_transaction(...)               — perform p1_refresh_invoice_payment_statuses(v_org, v_invoice_ids)
--     public.transition_credit_request(...)            — perform p1_refresh_invoice_payment_statuses(v_org, array[v_invoice_id])
--
--   No other path can write it. `p1_financial_command_guard` (BEFORE INSERT/UPDATE/DELETE on
--   `invoices`) raises `financial_command_rpc_required` for any invoice UPDATE by a real user
--   that changes anything other than `deleted_at`/`updated_at`, so the RLS `invoices_update`
--   policy — which nominally lets owner and office update the row — cannot reach this column.
--
-- THE READ PATH — nine database readers, one index, no policy, no constraint, no view:
--
--   | reader | what it does with it | pinned? |
--   |---|---|---|
--   | `soft_delete_invoice(uuid,text)` | `<> 'unpaid'` blocks the delete | exempt (`rls-preread-single-unit`) |
--   | `private.assert_invoice_supporting_conversion(uuid)` | `<> 'unpaid'` blocks the conversion | not registered |
--   | `private.document_removal_impact(uuid,uuid)` | `<> 'unpaid'` emits an `invoice_paid` blocker | not registered |
--   | `reverse_invoice_three_way_approval_consumption(uuid,text)` | `<> 'unpaid'` blocks the reversal | **PINNED** |
--   | `invoice_financial_check_signals(uuid)` | office/procurement arm only: `= 'paid'` | exempt |
--   | `create_monthly_report_snapshot(date,uuid)` | writes it into the snapshot JSON + `unpaid_count` | **PINNED** |
--   | `get_consolidated_invoice_workspace(uuid)` | writes it into the anchor JSON | **PINNED** |
--   | `global_search(text,integer)` | returns it as a result field | not registered |
--   | index `invoices_org_live_payment_date_idx` | `(org_id, payment_status, invoice_date desc, id) where deleted_at is null` | — |
--
--   `select * from pg_policies where qual||with_check ilike '%payment_status%'` → zero rows.
--   `select * from pg_constraint where pg_get_constraintdef ilike '%payment_status%'` → zero rows.
--   `select * from pg_views where definition ilike '%payment_status%'` → zero rows.
--
--   Client readers (step 2's other half, outside this file): `checks.ts:101-110`,
--   `types.ts:355`, `Bank.tsx:536`, `Dashboard.tsx:577,614`, `Expenses.tsx:36,149,331,559`,
--   `FinancialSupplier.tsx:15,54,142`, `InvoiceDetail.tsx:266-268,702,723`,
--   `Invoices.tsx:166-167,266,343`, `PaymentRequests.tsx:33,238,242,263-272`,
--   `Reports.tsx:160,626,684`, `Suppliers.tsx:894`, plus the gate scripts
--   `check-p4-integrated-journey.cjs` and `check-browser-smoke.cjs`.
--   `checks.ts:317 refreshInvoicePaymentStatus` is exported and called from NOWHERE — the
--   browser-facing `refresh_invoice_payment_status` RPC has zero live callers.
--
-- THE DERIVED ANSWER, PER CURRENCY
--
--   `payment_allocations` carries a composite FK
--     (org_id, invoice_id, currency) → invoices(org_id, id, currency)
--   so an allocation against an invoice is FORCED into the invoice's own currency. The derived
--   answer is therefore single-currency by construction; there is no summing across currencies
--   to avoid, and no row needs splitting. The canonical surface already exists:
--   `p0_invoice_balance_rows_by_currency()` / `invoice_balances_by_currency`, whose balance is
--     total_amount − Σ(cash allocations) − Σ(credit allocations via credit_requests).
--
-- THE THREE DIVERGENCES THIS TEARDOWN CLOSES — all measured, not inferred
--
--   1. A DRIFTED ROW. Over every invoice in the database, stored ≠ derived exactly once:
--      invoice 3377, stored 'paid', derived balance 150.000 ILS. Fixed by
--      `artifacts/w6/data-remediation/invoice-3377.sql` and by `supabase/demo/demo_seed.sql`,
--      NOT by this file. That runbook is a PRECONDITION of STEP 3 below.
--
--   2. A THIRD ANSWER. `invoice_financial_check_signals` computes its own balance and uses a
--      DIFFERENT credit rule — `sum(credit_requests.amount) where status in ('offset','closed')`
--      instead of the credit allocations. On invoice 3377 it returns 0 while
--      `p0_invoice_balance_rows_by_currency` returns 150. Three surfaces, three answers, one
--      invoice. STEP 2 collapses them to one.
--
--   3. AN UNLISTED, CURRENCY-BLIND MONEY TOLERANCE. The `<= 1` in the refresh body is a money
--      tolerance in everything but name: one unit of ANY currency, so 1 JPY and 1 BHD and 1 ILS
--      all count as "close enough to paid". `check:tolerance-surfaces` cannot see it, because
--      that guard's regex only finds `money_tolerance(…, '<key>')` call sites. Under #288/#294's
--      own rule — an amount the owner cannot state is an amount the product invented — this is a
--      fifth tolerance that was born without a screen. STEP 1 routes it through
--      `private.money_tolerance`, whose default for a two-decimal currency is
--      `100 * 10^-2 = 1.00` — **byte-identical behaviour for the shekel today**, and correct for
--      every other currency for the first time.
--
--      >>> THE ONE OWNER DECISION IN THIS WAVE. The alternative is no tolerance at all
--      >>> (`balance <= 0`), which is truer to "balances are computed, not stored" and makes the
--      >>> badge and the balance on `FinancialSupplier.tsx:142` mathematically unable to
--      >>> disagree. It is NOT chosen here, because it changes what "paid" means for a 50-agorot
--      >>> remainder and that is a business answer nobody has given. The tolerance route is the
--      >>> documented default precisely because it changes nothing the current tenant can see.
--
-- WHY THE OFFICE ROLE MAKES THIS HARDER THAN IT LOOKS
--
--   `invoices_select` admits owner, office, and accountant-on-approved. `pa_select` on
--   `payment_allocations` admits ONLY owner and accountant. So `office` can see an invoice and
--   cannot see its allocations: the stored column is today the ONLY paid/unpaid signal an office
--   user has, and it is deliberately coarse —
--   `invoice_financial_check_signals` says so in its own comment: "Procurement roles may already
--   read the invoice's coarse payment status. They never get a bank fact or a balance-derived
--   oracle from this SECURITY DEFINER function."
--   A plain (non-definer) computed column would therefore read 0 allocations for office and
--   report every invoice unpaid. The read model in STEP 1 is SECURITY DEFINER for exactly this
--   reason, and returns the LABEL without the numbers.
--
-- SECURITY DEFINER PINS — READ THIS BEFORE APPLYING ANYTHING
--
--   `private.scope_definer_marker_violations()` compares `md5(replace(prosrc, e'\r', ''))`
--   against `private.scope_definer_enforcements.body_hash`. Rewriting a pinned body without
--   moving its pin fails the A5 assertion.
--
--   PINS THIS REQUEST MOVES:
--     STEP 1 — `p0_invoice_balance_rows_by_currency()`            (adds `payment_state`)
--              plus ONE NEW registration: `invoice_payment_state(invoices)`
--     STEP 2 — `reverse_invoice_three_way_approval_consumption(uuid,text)`
--              `create_monthly_report_snapshot(date,uuid)`
--              `get_consolidated_invoice_workspace(uuid)`
--     STEP 3 — none. Nothing pinned is rewritten; two exempt functions are dropped, and their
--              rows must be deleted from `private.scope_definer_exemptions` in the same
--              migration or the exemption pin goes stale.
--
--   PINS THIS REQUEST DOES NOT MOVE, and must not: `create_payment_request`,
--   `p1_transition_payment_request`, `payment_request_financial_check_signals`. None of them
--   reads or writes `payment_status`; they appear in this wave only through
--   `src/lib/errors.ts`, which is not SQL.
--
--   Every body change below is an ANCHORED PATCH of the LIVE body, in the `0232` idiom:
--   read with `replace(pg_get_functiondef(...), e'\r', '')`, assert the anchor occurs exactly
--   once, replace, `execute`. NEVER re-declare from the creating migration — that silently
--   reverts every patch made since, which is how this repository lost currency handling once
--   already.
-- =============================================================================================


-- #############################################################################################
-- STEP 1 — GIVE THE DERIVED ANSWER A NAME. ADDITIVE ONLY.
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

-- --- 1c. The balance surface carries the state, so one query answers both. ---------------------
-- ANCHORED PATCH of the live body. Do NOT re-declare from 0218 — `0232` and its successors have
-- moved this function since, and re-declaring would revert them.
do $patch_balance_rows$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.p0_invoice_balance_rows_by_currency()'::regprocedure), e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  v_anchor := 'RETURNS TABLE(invoice_id uuid, currency text, total_amount numeric, '
    || 'paid_amount numeric, credited_amount numeric, balance_in_currency numeric)';
  v_replacement := 'RETURNS TABLE(invoice_id uuid, currency text, total_amount numeric, '
    || 'paid_amount numeric, credited_amount numeric, balance_in_currency numeric, '
    || 'payment_state public.invoice_payment_status)';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, '')))
             / length(v_anchor);
  if v_count <> 1 then
    raise exception 'w6/step1: balance signature anchor count %', v_count;
  end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := e'         (i.total_amount - coalesce(p.amount, 0) - coalesce(c.amount, 0))::numeric(14,3)\n  from public.invoices i';
  v_replacement := e'         (i.total_amount - coalesce(p.amount, 0) - coalesce(c.amount, 0))::numeric(14,3),\n'
    || e'         private.invoice_payment_state(i)\n  from public.invoices i';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, '')))
             / length(v_anchor);
  if v_count <> 1 then
    raise exception 'w6/step1: balance projection anchor count %', v_count;
  end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_balance_rows$;

-- The view is a plain projection of the function; recreate it so the new column reaches
-- PostgREST. `create or replace view` cannot add a column in the middle, and this one is added
-- at the end, so replace is enough. Grants are re-asserted because a drop/create would lose them.
create or replace view public.invoice_balances_by_currency as
  select invoice_id, currency, total_amount, paid_amount, credited_amount,
         balance_in_currency, payment_state
  from public.p0_invoice_balance_rows_by_currency();
grant select on public.invoice_balances_by_currency to authenticated;

update private.scope_definer_enforcements
set body_hash = md5(replace((select prosrc from pg_proc
                             where oid = 'public.p0_invoice_balance_rows_by_currency()'::regprocedure),
                            e'\r', ''))
where function_signature = 'p0_invoice_balance_rows_by_currency()';

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


-- #############################################################################################
-- STEP 2 — MOVE EVERY READER ONTO THE DERIVED ANSWER. THE COLUMN IS STILL WRITTEN.
--
-- WHY THIS IS SAFE ON ITS OWN: the write path is untouched and the column still exists, so any
-- reader that is mis-ported can be reverted by a one-line patch back to `payment_status`, and
-- `private.p1_payment_status_drift()` from STEP 1 still proves the two agree while the porting
-- happens. Nothing is dropped in this step. It is the step that must NOT also remove the write
-- path — a step that changed both would leave no reference to compare against.
--
-- THE CLIENT HALF SHIPS IN THE SAME MERGE AS THIS MIGRATION AND NOT BEFORE. `select('*,
-- invoice_payment_state')` against a database without STEP 1 returns HTTP 400, so the eleven
-- screens listed in the header cannot be converted on a branch that does not carry STEP 1.
-- #############################################################################################

-- --- 2a. `soft_delete_invoice` — the guard that blocks deleting an invoice money touched. ------
do $patch_soft_delete$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.soft_delete_invoice(uuid,text)'::regprocedure), e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  v_anchor := e'  if v_invoice.payment_status <> \'unpaid\'\n'
    || e'     or v_invoice.export_status <> \'not_sent\'';
  v_replacement := e'  if private.invoice_payment_state(v_invoice) <> \'unpaid\'\n'
    || e'     or v_invoice.export_status <> \'not_sent\'';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, '')))
             / length(v_anchor);
  if v_count <> 1 then raise exception 'w6/step2: soft_delete anchor count %', v_count; end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_soft_delete$;

-- --- 2b. `private.assert_invoice_supporting_conversion`. ---------------------------------------
-- Note this body ALREADY tests `exists (select 1 from payment_allocations a where
-- a.invoice_id = ...)` two lines later, so the stored test was mostly redundant — except that
-- the existing `exists` misses a credit-only offset, which the derived state catches.
do $patch_supporting$
declare
  v_definition text := replace(pg_get_functiondef(
    'private.assert_invoice_supporting_conversion(uuid)'::regprocedure), e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  v_anchor := e'  if v_invoice.payment_status <> \'unpaid\'\n'
    || e'     or v_invoice.review_status = \'approved\'';
  v_replacement := e'  if private.invoice_payment_state(v_invoice) <> \'unpaid\'\n'
    || e'     or v_invoice.review_status = \'approved\'';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, '')))
             / length(v_anchor);
  if v_count <> 1 then raise exception 'w6/step2: supporting anchor count %', v_count; end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_supporting$;

-- --- 2c. `private.document_removal_impact` — the `invoice_paid` blocker. ------------------------
do $patch_removal_impact$
declare
  v_definition text := replace(pg_get_functiondef(
    'private.document_removal_impact(uuid,uuid)'::regprocedure), e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  v_anchor := e'        if v_invoice.payment_status <> \'unpaid\' then';
  v_replacement := e'        if private.invoice_payment_state(v_invoice) <> \'unpaid\' then';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, '')))
             / length(v_anchor);
  if v_count <> 1 then raise exception 'w6/step2: removal impact anchor count %', v_count; end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_removal_impact$;
-- `get_document_removal_impact(uuid)` is the PINNED public wrapper and its body does not change,
-- so its hash does not move. Only the private helper is patched.

-- --- 2d. `reverse_invoice_three_way_approval_consumption` — PINNED. ----------------------------
do $patch_reversal$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.reverse_invoice_three_way_approval_consumption(uuid,text)'::regprocedure), e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  v_anchor := e'  if v_invoice.payment_status <> \'unpaid\'\n'
    || e'     or v_invoice.export_status <> \'not_sent\'';
  v_replacement := e'  if private.invoice_payment_state(v_invoice) <> \'unpaid\'\n'
    || e'     or v_invoice.export_status <> \'not_sent\'';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, '')))
             / length(v_anchor);
  if v_count <> 1 then raise exception 'w6/step2: reversal anchor count %', v_count; end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_reversal$;
update private.scope_definer_enforcements
set body_hash = md5(replace((select prosrc from pg_proc
      where oid = 'public.reverse_invoice_three_way_approval_consumption(uuid,text)'::regprocedure),
    e'\r', ''))
where function_signature = 'reverse_invoice_three_way_approval_consumption(uuid,text)';

-- --- 2e. `invoice_financial_check_signals` — THE THIRD ANSWER, retired. -------------------------
-- Both arms now come from the same expression. The office arm keeps reading a LABEL and gains
-- no number, which is the boundary the body's own comment draws; the owner/accountant arm stops
-- computing a private balance with a credit rule nobody else uses.
do $patch_check_signals$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.invoice_financial_check_signals(uuid)'::regprocedure), e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  v_anchor := e'    select v_invoice.total_amount\n'
    || e'           - coalesce((select sum(pa.amount) from public.payment_allocations pa\n'
    || e'                       where pa.org_id = v_org and pa.invoice_id = v_invoice.id), 0)\n'
    || e'           - coalesce((select sum(cr.amount) from public.credit_requests cr\n'
    || e'                       where cr.org_id = v_org and cr.invoice_id = v_invoice.id\n'
    || e'                         and cr.status in (\'offset\', \'closed\')), 0)\n'
    || e'      into v_balance;\n'
    || e'    v_already_paid := v_balance <= 0;';
  v_replacement :=
       e'    -- 0219 gave this function its own balance, with its own credit rule: the SUM OF THE\n'
    || e'    -- CREDIT REQUESTS in state offset/closed, rather than the credit ALLOCATIONS every\n'
    || e'    -- other surface counts. On invoice 3377 the two disagreed by 150 ILS. One answer now.\n'
    || e'    v_already_paid := private.invoice_payment_state(v_invoice) = \'paid\';';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, '')))
             / length(v_anchor);
  if v_count <> 1 then raise exception 'w6/step2: check signals anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := e'    v_already_paid := v_invoice.payment_status = \'paid\';';
  v_replacement := e'    v_already_paid := private.invoice_payment_state(v_invoice) = \'paid\';';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, '')))
             / length(v_anchor);
  if v_count <> 1 then
    raise exception 'w6/step2: check signals office anchor count %', v_count;
  end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- `v_balance` becomes unused. Removing its declaration keeps the body honest.
  v_anchor := e'  v_balance numeric;\n';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, '')))
             / length(v_anchor);
  if v_count <> 1 then raise exception 'w6/step2: check signals decl anchor count %', v_count; end if;
  execute replace(v_definition, v_anchor, '');
end
$patch_check_signals$;

-- --- 2f. `create_monthly_report_snapshot` — PINNED. --------------------------------------------
-- The snapshot's JSON KEY NAMES DO NOT CHANGE. `monthlyReport.ts` reads `payment_status` and
-- `payment_status_label` out of stored snapshots that already exist and are immutable; renaming
-- the key would make every historical snapshot unreadable. Only the SOURCE of the value moves.
do $patch_snapshot$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.create_monthly_report_snapshot(date,uuid)'::regprocedure), e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  -- `i` here is the `invoice_source` CTE, whose row type is `invoices` PLUS `supplier_name` and
  -- `legal_entity_id`, so the ROW overload would not typecheck. The four-argument form is used
  -- for exactly this reason; it is why that overload exists.
  v_anchor := e'        \'payment_status\', i.payment_status,\n'
    || e'        \'payment_status_label\', case i.payment_status::text';
  v_replacement := e'        \'payment_status\', private.invoice_payment_state(i.org_id, i.id, i.total_amount, i.currency),\n'
    || e'        \'payment_status_label\', case private.invoice_payment_state(i.org_id, i.id, i.total_amount, i.currency)::text';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, '')))
             / length(v_anchor);
  if v_count <> 1 then raise exception 'w6/step2: snapshot rows anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := e'          else i.payment_status::text end';
  v_replacement := e'          else private.invoice_payment_state(i.org_id, i.id, i.total_amount, i.currency)::text end';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, '')))
             / length(v_anchor);
  if v_count <> 1 then raise exception 'w6/step2: snapshot else anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  v_anchor := e'      count(*) filter (where i.payment_status <> \'paid\')::integer as unpaid_count';
  v_replacement := e'      count(*) filter (where private.invoice_payment_state(i.org_id, i.id, i.total_amount, i.currency) <> \'paid\')::integer as unpaid_count';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, '')))
             / length(v_anchor);
  if v_count <> 1 then raise exception 'w6/step2: snapshot count anchor count %', v_count; end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_snapshot$;
update private.scope_definer_enforcements
set body_hash = md5(replace((select prosrc from pg_proc
      where oid = 'public.create_monthly_report_snapshot(date,uuid)'::regprocedure), e'\r', ''))
where function_signature = 'create_monthly_report_snapshot(date,uuid)';
-- PERFORMANCE NOTE, MEASURED NOWHERE YET: the snapshot's row builder now calls the derived
-- expression per invoice, three times per row. Fold it into a lateral once if the monthly
-- snapshot is measured slower; do not fold it before it is measured.

-- --- 2g. `get_consolidated_invoice_workspace` — PINNED. ---------------------------------------
do $patch_workspace$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.get_consolidated_invoice_workspace(uuid)'::regprocedure), e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  v_anchor := e'\'review_status\',invoice.review_status,\'payment_status\',invoice.payment_status';
  v_replacement := e'\'review_status\',invoice.review_status,'
    || e'\'payment_status\',private.invoice_payment_state(invoice)';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, '')))
             / length(v_anchor);
  if v_count <> 1 then raise exception 'w6/step2: workspace anchor count %', v_count; end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_workspace$;
update private.scope_definer_enforcements
set body_hash = md5(replace((select prosrc from pg_proc
      where oid = 'public.get_consolidated_invoice_workspace(uuid)'::regprocedure), e'\r', ''))
where function_signature = 'get_consolidated_invoice_workspace(uuid)';

-- --- 2h. `global_search`. ----------------------------------------------------------------------
do $patch_global_search$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.global_search(text,integer)'::regprocedure), e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  v_anchor := e'            i.payment_status::text, i.total_amount, i.currency, i.invoice_date,';
  v_replacement := e'            private.invoice_payment_state(i)::text, i.total_amount, i.currency, i.invoice_date,';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, '')))
             / length(v_anchor);
  if v_count <> 1 then raise exception 'w6/step2: global_search anchor count %', v_count; end if;
  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_global_search$;

-- --- 2i. STEP 2 self-check. --------------------------------------------------------------------
do $assert_step2$
declare
  v_violations text;
  v_left integer;
begin
  -- Not one product reader may still name the column. The writer and its wrapper still do, by
  -- design: they are STEP 3's job, and naming them here is what makes this step separable.
  select count(*) into v_left
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where p.prokind in ('f','p') and n.nspname in ('public','private')
    and p.prosrc ~ '\mpayment_status\M'
    and p.oid::regprocedure::text not in (
      'p1_refresh_invoice_payment_statuses(uuid,uuid[])',
      'refresh_invoice_payment_status(uuid)',
      'private.invoice_payment_state(invoices)',
      'private.invoice_payment_state(uuid,uuid,numeric,text)',
      'private.p1_payment_status_drift()');
  if v_left > 0 then
    raise exception 'w6/step2: % function(s) still read invoices.payment_status', v_left;
  end if;
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'w6/step2 scope failed:\n%', v_violations;
  end if;
end
$assert_step2$;


-- #############################################################################################
-- STEP 3 — REMOVE THE WRITE PATH AND THE COLUMN.
--
-- WHY THIS IS SAFE ON ITS OWN: STEP 2 removed every reader, and STEP 1's drift assertion proves
-- the stored and derived answers agreed at the moment of removal. This step therefore deletes
-- something nothing reads and whose last recorded value was correct.
--
-- >>> PRECONDITIONS. BOTH, AND NEITHER IS OPTIONAL:
-- >>>   1. `artifacts/w6/data-remediation/invoice-3377.sql` has RUN on this database, and
-- >>>      `supabase/demo/demo_seed.sql` carries the credit allocation, or a `db reset` restores
-- >>>      the defect after the column that hid it is gone.
-- >>>   2. `select count(*) from private.p1_payment_status_drift()` returns 0. The migration
-- >>>      asserts this and REFUSES rather than proceeding — this is the one place where a
-- >>>      drifted row must stop the work, because after this point there is nothing to compare.
-- >>>
-- >>> IF EITHER PRECONDITION FAILS, STOP AT STEP 2 AND SAY SO. Two steps of a three-step
-- >>> teardown is a coherent state: one derived answer, one stored column still written, still
-- >>> agreeing, and nothing reading it. Half of step 3 is not.
-- #############################################################################################

do $assert_step3_preconditions$
declare v_drift integer;
begin
  select count(*) into v_drift from private.p1_payment_status_drift();
  if v_drift <> 0 then
    raise exception
      'w6/step3 REFUSED: % invoice(s) where the stored label and the derived state disagree. '
      'Dropping the column now would change a number in front of the owner. Run '
      'artifacts/w6/data-remediation/invoice-3377.sql, re-measure, and try again.', v_drift;
  end if;
end
$assert_step3_preconditions$;

-- --- 3a. Unhook the four callers of the refresh. -----------------------------------------------
-- Anchored deletions, one per caller. Each removes a `perform` line and nothing else.
do $unhook_execute_payment_request$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.execute_payment_request(uuid,date,text,text,text,jsonb,numeric,text,text)'::regprocedure),
    e'\r', '');
  v_anchor text; v_count integer;
begin
  v_anchor := e'  perform public.p1_refresh_invoice_payment_statuses(v_org, v_invoice_ids);\n';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, '')))
             / length(v_anchor);
  if v_count <> 1 then raise exception 'w6/step3: execute anchor count %', v_count; end if;
  execute replace(v_definition, v_anchor, '');
end
$unhook_execute_payment_request$;

do $unhook_match_bank_transaction$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.match_bank_transaction(uuid,uuid,uuid,uuid,jsonb,numeric,text)'::regprocedure),
    e'\r', '');
  v_anchor text; v_count integer;
begin
  v_anchor := e'  perform p1_refresh_invoice_payment_statuses(v_org, v_invoice_ids);\n';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, '')))
             / length(v_anchor);
  if v_count <> 1 then raise exception 'w6/step3: bank match anchor count %', v_count; end if;
  execute replace(v_definition, v_anchor, '');
end
$unhook_match_bank_transaction$;
-- `match_bank_transaction` is EXEMPT, not pinned (`rls-preread-single-unit; 0232 …`), so no hash
-- moves here. Leave the exemption row and its reason exactly as they are.

do $unhook_transition_credit_request$
declare
  v_definition text := replace(pg_get_functiondef(
    'public.transition_credit_request(uuid,credit_status,text)'::regprocedure), e'\r', '');
  v_anchor text; v_count integer;
begin
  v_anchor := e'    perform p1_refresh_invoice_payment_statuses(v_org, array[v_invoice_id]);\n';
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, '')))
             / length(v_anchor);
  if v_count <> 1 then raise exception 'w6/step3: credit transition anchor count %', v_count; end if;
  execute replace(v_definition, v_anchor, '');
end
$unhook_transition_credit_request$;

-- --- 3b. Drop the two refresh functions, and their exemption rows in the same breath. ----------
-- `refresh_invoice_payment_status` had ZERO callers even before this wave: `checks.ts:317`
-- exports a wrapper nothing imports.
drop function if exists public.refresh_invoice_payment_status(uuid);
drop function if exists public.p1_refresh_invoice_payment_statuses(uuid, uuid[]);
delete from private.scope_definer_exemptions
where function_signature in (
  'refresh_invoice_payment_status(uuid)',
  'p1_refresh_invoice_payment_statuses(uuid,uuid[])');

-- --- 3c. Drop the index, then the column, then the enum. ---------------------------------------
-- The index is dropped explicitly rather than left to cascade, so the loss of
-- `(org_id, payment_status, invoice_date desc, id)` is a decision on the page. The list screens
-- that used it now filter on the computed column, which cannot use a b-tree — see the note at
-- the foot of this file. If the invoice list is measured slow after this step, the answer is a
-- materialised derived column with a trigger, NOT the stored label coming back.
drop index if exists public.invoices_org_live_payment_date_idx;
alter table public.invoices drop column payment_status;
-- The ENUM `public.invoice_payment_status` STAYS. `private.invoice_payment_state` and the
-- computed column both return it, and it is the vocabulary the badges render; three labels are
-- not the debt this wave came for. A `drop type` here would simply fail — deliberately not
-- written, so nobody has to discover that during a production rollout.

-- --- 3d. STEP 3 self-check. --------------------------------------------------------------------
do $assert_step3$
declare v_violations text;
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'invoices'
               and column_name = 'payment_status') then
    raise exception 'w6/step3: the column is still there';
  end if;
  if to_regprocedure('public.p1_refresh_invoice_payment_statuses(uuid,uuid[])') is not null then
    raise exception 'w6/step3: the writer is still there';
  end if;
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'w6/step3 scope failed:\n%', v_violations;
  end if;
  select string_agg(detail, e'\n' order by detail) into v_violations
  from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'w6/step3 export failed:\n%', v_violations;
  end if;
end
$assert_step3$;

-- The tenant export registry pins a schema hash per table. Dropping a column from `invoices`
-- moves it, so it must be recomputed in the same migration, exactly as 0232 did for `payments`:
update private.tenant_export_registry registry
set exported_columns = case when registry.disposition = 'exclude' then '{}'::text[] else (
      select array_agg(c.column_name order by c.ordinal_position)
      from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = registry.table_name
        and not (c.column_name = any(registry.excluded_columns))) end,
    schema_hash = (select md5(string_agg(
      c.column_name || ':' || c.data_type || ':' || c.is_nullable, '|'
      order by c.ordinal_position))
      from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = registry.table_name)
where registry.table_name = 'invoices';
-- (Move this UPDATE ABOVE the `$assert_step3$` block when you write the real migration — the
-- assertion reads the registry and will fail if the hash has not been recomputed yet.)


-- =============================================================================================
-- SUITE ASSERTIONS REQUESTED, BY EXISTING SUITE FILE
--
-- No new suite file. `check:suite-manifest` and `check:baseline-drift` both punish a new file
-- and a sharpened label; each claim below is carried inside a suite that already exists and
-- already exercises the surface it belongs to.
--
-- `supabase/tests/p1_financial_commands.sql`   (already names payment_status twice)
--   S1  After `execute_payment_request`, `private.invoice_payment_state(i)` equals what the
--       stored column said — asserted while BOTH exist, i.e. between steps 1 and 3. This is the
--       assertion that makes step 2 reversible.
--   S2  An invoice reduced ONLY by a credit allocation, and by less than its total, derives
--       `partial`. The stored writer returns `unpaid` for this shape because it tests cash
--       alone. Falsification: assert the OLD expression returns 'unpaid' on the same fixture, so
--       the test proves a behaviour change rather than agreeing with itself.
--   S3  `private.p1_payment_status_drift()` returns zero rows at the end of the suite. After
--       step 3 this becomes: the column does not exist and `to_regprocedure` on both refresh
--       functions is null.
--
-- `supabase/tests/p63_financial_credit_contracts.sql`   (already names payment_status twice)
--   S4  The 3377 shape, rebuilt from scratch: an invoice, a cash allocation short of its total,
--       a credit at `offset` with NO allocation. Assert (a) `transition_credit_request` refuses
--       to create it today by name — `credit_request_not_fully_allocated`, W0-G6 — and (b) if
--       the shape is forced in as trusted-server data, `private.invoice_payment_state` reports
--       `partial` while the stored column reports `paid`. That is the drift, reproduced.
--   S5  Once the credit allocation exists, all three former answers agree: the derived state,
--       `invoice_balances_by_currency.balance_in_currency = 0`, and
--       `invoice_financial_check_signals.already_paid = true`.
--
-- `supabase/tests/p17_financial_supplier_view.sql`   (the role-boundary suite)
--   S6  `office` reads `invoice_payment_state` on an invoice it can see, gets a LABEL, and gets
--       nothing from `invoice_balances_by_currency` — the coarse/precise boundary survives the
--       teardown. This is the assertion that would have caught the office regression.
--   S7  `accountant` gets null from `invoice_payment_state` for a NON-approved invoice, proving
--       the definer re-reads the row instead of trusting its composite argument.
--   S8  A second tenant's invoice returns null.
--
-- `supabase/tests/p81_multi_currency_payments_and_bank.sql`   (already names payment_status)
--   S9  The ILS tolerance does not move: with no organisation setting,
--       `private.money_tolerance(org,'ILS','invoice_payment_settled_tolerance') = 1.00`, the
--       exact number the old `<= 1` hard-coded.
--   S10 A 0-minor-unit currency (e.g. JPY) and a 3-minor-unit currency (e.g. BHD) get their own
--       thresholds rather than 1 of whatever the currency happens to be — the defect the old
--       body could not express.
--
-- `supabase/tests/monthly_report_snapshots.sql`   (already names payment_status)
--   S11 The snapshot JSON still carries `payment_status` and `payment_status_label` under those
--       exact key names, and an EXISTING immutable snapshot still parses. `monthlyReport.ts`
--       reads stored snapshots; renaming the key would make history unreadable.
--
-- `supabase/tests/p36_document_removal_impact.sql`   (already names payment_status)
--   S12 The `invoice_paid` blocker still fires on an invoice with an allocation, and now also
--       fires on one reduced only by a credit offset.
--
-- `supabase/tests/live_schema_alignment.sql`
--   S13 After step 3: `invoices` has no `payment_status` column, and the pins in
--       `private.scope_definer_enforcements` for the three patched pinned functions match their
--       live `md5(replace(prosrc, e'\r', ''))`. This is the guard against a re-declaration
--       silently reverting step 2.
--
--
-- WHAT THIS REQUEST DOES NOT CLAIM
--
--   * None of the SQL above has been APPLIED. Wave 6 is forbidden to write to the shared local
--     stack, so every anchor was verified by string-matching the live `pg_get_functiondef`
--     output, and NO patch was executed. The one hunk whose typing is unverified is flagged
--     in place (2f).
--   * The dropped index is a real loss. `invoices_org_live_payment_date_idx` served the "open
--     for payment" filter on the invoice list; a computed column cannot use it. Measure the list
--     before and after step 3 rather than assuming either way.
-- =============================================================================================
