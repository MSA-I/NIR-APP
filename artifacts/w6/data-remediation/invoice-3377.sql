-- =============================================================================================
-- WAVE 6 — DATA REMEDIATION, INVOICE 3377.  NOT A MIGRATION.
--
-- This file is a runbook, not a schema change. It writes exactly one business row and one audit
-- row, on one named tenant, and it refuses to run when the state it expects is not the state it
-- finds. It is deliberately NOT in supabase/migrations/: a migration runs everywhere forever;
-- this runs once, on one row, under a person who read the snapshot first.
--
-- W0-G6 settled that no migration is needed. The live body of `transition_credit_request`
-- already refuses a manual move to `offset` unless the credit is allocated
-- (`credit_request_not_fully_allocated`, added by 0173), so no NEW invoice can reach this shape.
-- 3377 predates that guard. The earlier plan read `0024` — a dead body — and concluded the guard
-- was missing. It is not.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT IS WRONG, MEASURED
--
-- Invoice 3377 (900.000 ILS) was settled by a 750.000 ILS bank transfer plus a 150.000 ILS
-- credit note. The payment's own note says so: "חשבונית 3377 בקיזוז זיכוי 150 ₪". The credit
-- request was moved to `offset` and stamped `resolved_at`. The cash allocation exists. The
-- CREDIT allocation was never written.
--
-- So one invoice has three different answers to "is it paid?":
--
--   stored `invoices.payment_status`                        = 'paid'
--   p0_invoice_balance_rows_by_currency (the balance screen) = 150.000 ILS still owed
--   invoice_financial_check_signals (owner/accountant arm)   = 0 owed, already_paid = true
--
-- measured on the local stack, 2026-09-03:
--
--   invoice_number | stored_label | p0_balance_surface | check_signals_balance
--   ---------------+--------------+--------------------+----------------------
--   3377           | paid         |            150.000 |                 0.000
--
-- The same query over every invoice in the database returns exactly this one row. 3377 is the
-- only place where the stored label and the derived balance disagree.
--
-- The consequence is not cosmetic. `PaymentRequests.tsx:242` offers the owner invoices whose
-- STORED status is not 'paid', and then allocates the DERIVED balance. 3377 is stored 'paid',
-- so 150 ILS of genuinely open debt is invisible on the one screen that exists to pay it.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT THIS FIXES, AND WHY THIS DIRECTION
--
-- The owner ruled [owner 03.09] that "a manual credit offset must really offset". The business
-- truth is 900 = 750 cash + 150 credit; the ledger is missing the 150 credit row. So the fix
-- ADDS the allocation. It does not walk the credit back to `received`, which would be the
-- opposite claim — that the offset never happened — and would contradict both the payment note
-- and the credit's own `resolved_at`.
--
-- After the insert all three answers agree on 0 / paid, and `invoices.payment_status` needs no
-- update at all: it already says 'paid', and 'paid' becomes true. THE ONE ROW THIS WRITES IS THE
-- ALLOCATION. That is why there is no UPDATE here — an update guarded on expected old values
-- would have to invent a column to change.
--
-- ---------------------------------------------------------------------------------------------
-- WHY IT MUST RUN BEFORE THE payment_status TEARDOWN
--
-- Step 3 of the teardown deletes the stored column and lets the derived answer speak. Run today,
-- that would flip invoice 3377 from "paid" to "partially paid" in front of the owner — a
-- correct number arriving as an apparent regression. Fix the row first; then the teardown moves
-- nothing anybody can see. The drift query at the foot of this file is the precondition: it must
-- return zero rows before step 3 is applied.
--
-- ---------------------------------------------------------------------------------------------
-- ALSO REQUIRED, AND NOT IN THIS FILE
--
-- `supabase/demo/demo_seed.sql` CREATES this defect. Its `payment_allocations` insert carries the
-- 750 cash row and no credit row, so every `npm run demo:restore` and every `supabase db reset`
-- puts 3377 back. The seed is fixed in the same change as this runbook. Fixing only the seed
-- leaves production wrong; fixing only production leaves every local stack wrong.
--
-- ---------------------------------------------------------------------------------------------
-- HOW TO RUN
--
--   local   : docker exec -i supabase_db_supplyflow-p0 psql -U postgres -d postgres \
--                 -v ON_ERROR_STOP=1 -f - < artifacts/w6/data-remediation/invoice-3377.sql
--   remote  : scripts/db-query.ps1 -SqlFile artifacts/w6/data-remediation/invoice-3377.sql \
--                 -ProjectRef <ref>            ← OWNER-AUTHORISED STEP. Not run by an agent.
--
-- Read the BEFORE snapshot. If it does not match what is written above, STOP.
--
-- The write path this uses is the trusted one, not the product one:
--   * `p1_financial_command_guard` lets a null-`auth.uid()` session through (migrations, seeds
--     and trusted server jobs have no end-user subject). A session with a JWT would be refused
--     with `financial_command_rpc_required`, which is correct and is why this runs as postgres.
--   * `private.organization_row_write_guard` still requires the organization to be in
--     `active` / `trial` / `grace`. The preconditions assert that rather than discovering it.
--   * `allocation_derive_org`, `payment_allocations_audit` and `aa_assign_audit_scope` all fire
--     normally. The automatic audit row is NOT the marker; the explicit one below is.
-- =============================================================================================

\set ON_ERROR_STOP on

begin;

-- ---------------------------------------------------------------------------------------------
-- BEFORE — the snapshot. Read it. It is printed, never stored.
-- ---------------------------------------------------------------------------------------------
select
  'BEFORE/invoice' as snapshot,
  i.id, i.org_id, i.invoice_number, i.currency, i.total_amount,
  i.review_status::text, i.payment_status::text, i.deleted_at, i.notes
from public.invoices i
where i.id = 'f4000000-0000-4000-8000-000000000014'
  and i.org_id = '11111111-1111-4111-8111-111111111111';

select
  'BEFORE/credit' as snapshot,
  c.id, c.org_id, c.invoice_id, c.supplier_id, c.amount, c.currency,
  c.status::text, c.resolved_at, c.notes
from public.credit_requests c
where c.id = 'f5000000-0000-4000-8000-000000000004'
  and c.org_id = '11111111-1111-4111-8111-111111111111';

select
  'BEFORE/payment' as snapshot,
  p.id, p.org_id, p.supplier_id, p.amount, p.currency,
  p.settlement_amount, p.settlement_currency, p.paid_date, p.reference, p.notes
from public.payments p
where p.id = 'f7000000-0000-4000-8000-000000000006'
  and p.org_id = '11111111-1111-4111-8111-111111111111';

select
  'BEFORE/allocations' as snapshot,
  a.id, a.payment_id, a.invoice_id, a.credit_id, a.amount, a.currency
from public.payment_allocations a
where a.org_id = '11111111-1111-4111-8111-111111111111'
  and (a.invoice_id = 'f4000000-0000-4000-8000-000000000014'
       or a.credit_id = 'f5000000-0000-4000-8000-000000000004')
order by a.credit_id nulls first, a.id;

select
  'BEFORE/three_answers' as snapshot,
  i.payment_status::text as stored_label,
  (i.total_amount
   - coalesce((select sum(a.amount) from public.payment_allocations a
               where a.org_id = i.org_id and a.invoice_id = i.id), 0)
   - coalesce((select sum(a.amount) from public.payment_allocations a
               join public.credit_requests c on c.org_id = a.org_id and c.id = a.credit_id
               where c.org_id = i.org_id and c.invoice_id = i.id), 0)) as p0_balance_surface,
  (i.total_amount
   - coalesce((select sum(a.amount) from public.payment_allocations a
               where a.org_id = i.org_id and a.invoice_id = i.id), 0)
   - coalesce((select sum(c.amount) from public.credit_requests c
               where c.org_id = i.org_id and c.invoice_id = i.id
                 and c.status in ('offset', 'closed')), 0)) as check_signals_balance
from public.invoices i
where i.id = 'f4000000-0000-4000-8000-000000000014'
  and i.org_id = '11111111-1111-4111-8111-111111111111';

-- ---------------------------------------------------------------------------------------------
-- THE WRITE — guarded on every expected old value, idempotent, exactly one row on the first run.
-- ---------------------------------------------------------------------------------------------
do $w6_invoice_3377$
declare
  -- The identity of the thing being repaired. Nothing here is searched for by name.
  c_org       constant uuid          := '11111111-1111-4111-8111-111111111111';
  c_invoice   constant uuid          := 'f4000000-0000-4000-8000-000000000014';
  c_credit    constant uuid          := 'f5000000-0000-4000-8000-000000000004';
  c_payment   constant uuid          := 'f7000000-0000-4000-8000-000000000006';
  c_supplier  constant uuid          := 'aa000000-0000-4000-8000-000000000013';
  c_currency  constant text          := 'ILS';
  c_total     constant numeric(14,3) := 900.000;
  c_cash      constant numeric(14,3) := 750.000;
  c_credit_am constant numeric(14,3) := 150.000;

  -- THE AUDIT MARKER. Exact, and the only thing that makes a zero-row rerun acceptable.
  c_action    constant text := 'w6_credit_offset_allocation_repair';
  c_reason    constant text :=
    'Wave 6 data remediation, invoice 3377: the 150.000 ILS credit note was moved to '
    || '`offset` before 0173 required an allocation, so the offset was recorded on the credit '
    || 'and never in the ledger. The invoice read `paid` while its derived balance read 150.000 '
    || 'ILS still owed. This writes the missing credit allocation against the same payment that '
    || 'carried the 750.000 ILS cash, making the offset real. No amount is invented: 900 = 750 '
    || 'cash + 150 credit, which is what the payment note already said.';

  v_invoice   public.invoices;
  v_credit    public.credit_requests;
  v_payment   public.payments;
  v_cash_sum  numeric(14,3);
  v_existing  int;
  v_marker    int;
  v_new_id    uuid;
  v_inserted  int;
  v_access    text;
begin
  -- ------------------------------------------------------------------------------------------
  -- 1. Preconditions. Each one is an EXPECTED OLD VALUE, and a mismatch stops the run rather
  --    than writing against a state nobody looked at.
  -- ------------------------------------------------------------------------------------------
  select private.organization_access_mode(c_org) into v_access;
  if v_access not in ('active', 'trial', 'grace') then
    raise exception
      'w6/3377 ABORT: organization access mode is %, and organization_row_write_guard refuses '
      'a business write outside active/trial/grace. Nothing was written.', v_access;
  end if;

  select * into v_invoice
  from public.invoices i
  where i.id = c_invoice and i.org_id = c_org
  for update;
  if not found then
    raise exception 'w6/3377 ABORT: invoice % not found in organization %.', c_invoice, c_org;
  end if;
  if v_invoice.deleted_at is not null
     or v_invoice.invoice_number <> '3377'
     or v_invoice.currency <> c_currency
     or v_invoice.total_amount <> c_total
     or v_invoice.financial_role <> 'payable'
     or v_invoice.supplier_id <> c_supplier
     or v_invoice.review_status::text <> 'approved'
     or v_invoice.payment_status::text <> 'paid' then
    raise exception
      'w6/3377 ABORT: the invoice is not in the state this runbook was written against '
      '(number=%, currency=%, total=%, role=%, supplier=%, review=%, payment=%, deleted_at=%). '
      'Something changed since the snapshot. Re-measure before touching it.',
      v_invoice.invoice_number, v_invoice.currency, v_invoice.total_amount,
      v_invoice.financial_role, v_invoice.supplier_id, v_invoice.review_status,
      v_invoice.payment_status, v_invoice.deleted_at;
  end if;

  select * into v_credit
  from public.credit_requests c
  where c.id = c_credit and c.org_id = c_org
  for update;
  if not found then
    raise exception 'w6/3377 ABORT: credit request % not found in organization %.', c_credit, c_org;
  end if;
  if v_credit.invoice_id is distinct from c_invoice
     or v_credit.supplier_id <> c_supplier
     or v_credit.amount <> c_credit_am
     or v_credit.currency <> c_currency
     or v_credit.status::text <> 'offset' then
    raise exception
      'w6/3377 ABORT: the credit is not in the state this runbook was written against '
      '(invoice=%, supplier=%, amount=%, currency=%, status=%).',
      v_credit.invoice_id, v_credit.supplier_id, v_credit.amount,
      v_credit.currency, v_credit.status;
  end if;

  select * into v_payment
  from public.payments p
  where p.id = c_payment and p.org_id = c_org
  for update;
  if not found then
    raise exception 'w6/3377 ABORT: payment % not found in organization %.', c_payment, c_org;
  end if;
  -- The credit allocation rides on the SAME payment as the cash. `execute_payment_request`
  -- writes `payments.amount` as the CASH sum only and then asserts
  -- `round(v_payment.amount) = round(v_cash_sum)` — so adding a credit allocation to this
  -- payment does not over-allocate it and does not break that invariant.
  if v_payment.supplier_id <> c_supplier
     or v_payment.amount <> c_cash
     or v_payment.currency <> c_currency
     or v_payment.settlement_amount is not null
     or v_payment.settlement_currency is not null then
    raise exception
      'w6/3377 ABORT: the payment is not in the state this runbook was written against '
      '(supplier=%, amount=%, currency=%, settlement=%/%).',
      v_payment.supplier_id, v_payment.amount, v_payment.currency,
      v_payment.settlement_amount, v_payment.settlement_currency;
  end if;

  select coalesce(sum(a.amount), 0) into v_cash_sum
  from public.payment_allocations a
  where a.org_id = c_org and a.invoice_id = c_invoice;
  if v_cash_sum <> c_cash then
    raise exception
      'w6/3377 ABORT: cash allocated to the invoice is % ILS, expected %. The arithmetic this '
      'repair rests on (900 = 750 + 150) no longer holds.', v_cash_sum, c_cash;
  end if;

  select count(*) into v_existing
  from public.payment_allocations a
  where a.org_id = c_org and a.credit_id = c_credit;

  select count(*) into v_marker
  from public.audit_logs l
  where l.org_id = c_org and l.action = c_action;

  -- ------------------------------------------------------------------------------------------
  -- 2. Idempotence, stated as the plan states it: ZERO ROWS IS ACCEPTABLE ONLY WHEN THE TARGET
  --    STATE **AND** THE EXACT AUDIT MARKER ARE BOTH ALREADY PRESENT. Anything else that would
  --    write zero rows is a concurrent change or a wrong expected-old-value, and the run stops.
  -- ------------------------------------------------------------------------------------------
  if v_existing > 0 and v_marker > 0 then
    raise notice
      'w6/3377 ALREADY APPLIED: % credit allocation row(s) and % audit marker row(s) present. '
      'Zero rows written, and that is the correct outcome. Read the postflight below.',
      v_existing, v_marker;
    return;
  end if;
  if v_existing > 0 and v_marker = 0 then
    raise exception
      'w6/3377 ABORT: a credit allocation already exists but this runbook''s audit marker (%) '
      'does not. Somebody or something else wrote it. Do not overwrite — investigate.', c_action;
  end if;
  if v_existing = 0 and v_marker > 0 then
    raise exception
      'w6/3377 ABORT: the audit marker (%) exists but the credit allocation does not. A previous '
      'run was rolled back after the marker, or the allocation was deleted. Investigate.',
      c_action;
  end if;

  -- ------------------------------------------------------------------------------------------
  -- 3. THE ONE ROW. `allocation_derive_org` fills org_id; it is passed explicitly anyway so the
  --    row is complete on the page and the trigger has something to agree with.
  -- ------------------------------------------------------------------------------------------
  insert into public.payment_allocations (org_id, payment_id, invoice_id, credit_id, amount, currency)
  values (c_org, c_payment, null, c_credit, c_credit_am, c_currency)
  returning id into v_new_id;
  get diagnostics v_inserted = row_count;
  if v_inserted <> 1 then
    raise exception 'w6/3377 ABORT: expected exactly one inserted row, got %.', v_inserted;
  end if;

  -- ------------------------------------------------------------------------------------------
  -- 4. The audit row WITH A REASON. The trigger already wrote an `insert`/`payment_allocations`
  --    row; that one carries no reason and no intent, and a trigger row is not a decision. This
  --    is the decision, and it is the marker a rerun looks for.
  -- ------------------------------------------------------------------------------------------
  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    c_org,
    null,                                     -- no end-user subject: this is a runbook, not a screen
    c_action,
    'payment_allocations',
    v_new_id,
    jsonb_build_object(
      'invoice_id', c_invoice,
      'invoice_number', '3377',
      'credit_id', c_credit,
      'credit_status', v_credit.status::text,
      'stored_payment_status', v_invoice.payment_status::text,
      'derived_balance_before', c_total - c_cash,
      'currency', c_currency),
    jsonb_build_object(
      'payment_allocation_id', v_new_id,
      'payment_id', c_payment,
      'credit_id', c_credit,
      'amount', c_credit_am,
      'currency', c_currency,
      'derived_balance_after', c_total - c_cash - c_credit_am),
    c_reason
  );

  -- ------------------------------------------------------------------------------------------
  -- 5. Re-derive, so nothing is left resting on the assumption that the stored label was right
  --    for the right reason. It already reads 'paid'; after this row it is 'paid' AND true.
  --    Called with the org directly — the public wrapper needs a JWT and there is none here.
  -- ------------------------------------------------------------------------------------------
  perform public.p1_refresh_invoice_payment_statuses(c_org, array[c_invoice]);

  raise notice 'w6/3377 APPLIED: allocation %, 150.000 ILS credit against invoice 3377.', v_new_id;
end
$w6_invoice_3377$;

-- ---------------------------------------------------------------------------------------------
-- AFTER — the postflight read. All three answers must now say the same thing.
-- ---------------------------------------------------------------------------------------------
select
  'AFTER/three_answers' as postflight,
  i.invoice_number,
  i.payment_status::text as stored_label,
  (i.total_amount
   - coalesce((select sum(a.amount) from public.payment_allocations a
               where a.org_id = i.org_id and a.invoice_id = i.id), 0)
   - coalesce((select sum(a.amount) from public.payment_allocations a
               join public.credit_requests c on c.org_id = a.org_id and c.id = a.credit_id
               where c.org_id = i.org_id and c.invoice_id = i.id), 0)) as p0_balance_surface,
  (i.total_amount
   - coalesce((select sum(a.amount) from public.payment_allocations a
               where a.org_id = i.org_id and a.invoice_id = i.id), 0)
   - coalesce((select sum(c.amount) from public.credit_requests c
               where c.org_id = i.org_id and c.invoice_id = i.id
                 and c.status in ('offset', 'closed')), 0)) as check_signals_balance
from public.invoices i
where i.id = 'f4000000-0000-4000-8000-000000000014'
  and i.org_id = '11111111-1111-4111-8111-111111111111';
--   expected: stored_label = paid, p0_balance_surface = 0.000, check_signals_balance = 0.000

select
  'AFTER/allocations' as postflight,
  a.id, a.payment_id, a.invoice_id, a.credit_id, a.amount, a.currency
from public.payment_allocations a
where a.org_id = '11111111-1111-4111-8111-111111111111'
  and (a.invoice_id = 'f4000000-0000-4000-8000-000000000014'
       or a.credit_id = 'f5000000-0000-4000-8000-000000000004')
order by a.credit_id nulls first, a.id;
--   expected: two rows — 750.000 cash on the invoice, 150.000 credit on the credit request

select
  'AFTER/audit_marker' as postflight,
  l.id, l.action, l.entity_type, l.entity_id, l.user_id, l.created_at, l.reason
from public.audit_logs l
where l.org_id = '11111111-1111-4111-8111-111111111111'
  and l.action = 'w6_credit_offset_allocation_repair';
--   expected: exactly one row, with the reason above

-- The precondition for step 3 of the payment_status teardown. Must return ZERO rows.
select
  'AFTER/drift' as postflight,
  i.id, i.invoice_number, i.currency, i.total_amount, i.payment_status::text as stored,
  d.cash, d.credited, (i.total_amount - d.cash - d.credited) as balance
from public.invoices i
cross join lateral (
  select
    coalesce((select sum(a.amount) from public.payment_allocations a
              where a.org_id = i.org_id and a.invoice_id = i.id), 0) as cash,
    coalesce((select sum(a.amount) from public.payment_allocations a
              join public.credit_requests c on c.org_id = a.org_id and c.id = a.credit_id
              where c.org_id = i.org_id and c.invoice_id = i.id), 0) as credited
) d
where i.payment_status::text <> (case
    when i.total_amount - d.cash - d.credited <= 0 then 'paid'
    when d.cash + d.credited > 0 then 'partial'
    else 'unpaid' end);
--   expected: zero rows. A row here means some OTHER invoice drifted and step 3 is not yet safe.

commit;
