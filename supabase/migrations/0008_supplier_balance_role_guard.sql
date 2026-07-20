-- Closes an intra-organization leak in the two balance views (docs/PROGRESS.md).
--
-- THE DEFECT
-- 0003 re-created `invoice_balances` and `supplier_balances` WITHOUT `security_invoker`,
-- deliberately: they must read `payment_allocations`, whose RLS is office-only, so that a
-- kitchen user can still see what is owed. A definer view carries no RLS of its own, so it
-- has to self-guard in its WHERE clause -- and 0003 guarded on organization ONLY.
--
-- `supplier` (a vendor's own agent, 0004) is a member of the buying organization. auth_org()
-- therefore matches for them, and the org-only guard let a vendor read the open balance of
-- every supplier in the org -- their competitors' included. 0004 exists precisely to confine
-- that role to its own price rows (sp_supplier_select, 0004:31), so this is a direct
-- contradiction of its premise, not a gap in it.
--
-- Both views carry the defect. `supplier_balances` derives from `invoice_balances`, but
-- fixing only the inner view is NOT sufficient: the outer one LEFT JOINs it, so a blocked
-- role would still receive one row per supplier with open_balance 0 -- the amounts hidden but
-- the organization's full supplier list still enumerable. Each view is guarded independently.
--
-- WHO IS ALLOWED, AND WHY
--   owner, office, kitchen, accountant -- unchanged from 0003. Kitchen is the reason 0003
--     exists; accountant is read-only over invoices/payments by design (OPEN-DECISIONS #13).
--   supplier -- REMOVED. The whole point of this migration.
--   payer -- see below. It is the only role that needed a judgement call.
--
-- THE `payer` DECISION
-- PROGRESS.md proposed a flat `auth_role() in (...,'payer')`. That would make it the only
-- UNSCOPED payer grant in the schema. Every other one is a keyhole onto the single work item
-- in front of them:
--     suppliers_select        (0001:502) supplier has an approved+ payment request
--     invoices_select         (0001:556) invoice is referenced by an approved+ request
--     payment_requests_select (0001:581) status is approved+
--     payments_select         (0001:598) payment was executed by them
--     documents_select        (0001:630) document was uploaded by them
-- A flat grant here would also be strictly WIDER than invoices_select: the payer would read
-- the balance of invoices whose rows they cannot open. So:
--
--   invoice_balances  -- payer allowed, scoped by exactly the invoices_select predicate.
--     This is the real transfer context: the remaining balance of the invoice being paid,
--     which is what tells them a request is stale or already partly settled.
--
--   supplier_balances -- payer NOT allowed. Deliberate, and not merely least-privilege:
--     this view SUMs invoice_balances, so a payer-visible aggregate would silently total
--     only their restricted slice of invoices. `open_balance` would mean one thing for an
--     owner and a smaller thing for a payer, under one column name, in a financial system.
--     A partial number wearing the name of a total is worse than no number
--     (CLAUDE.md: a metric without data shows an em dash, never a misleading figure).
--
-- Verified against the app before choosing: src/pages/PayerQueue.tsx reads neither view, and
-- every screen that does read them is route-guarded to owner/office/kitchen/accountant
-- (src/App.tsx). No client code changes behaviour.
--
-- NOTE for future edits: neither view exposes an `org_id` column, which is what keeps the
-- 0005 self-check block passing -- it fails the migration for any public `org_id` column
-- without a leading index, and a view cannot be indexed. Do not add org_id to these views.

drop view supplier_balances;
drop view invoice_balances;

create view invoice_balances as
select i.id as invoice_id,
       i.total_amount,
       coalesce(pa.paid, 0)::numeric(12,2) as paid_amount,
       coalesce(cr.credited, 0)::numeric(12,2) as credited_amount,
       (i.total_amount - coalesce(pa.paid, 0) - coalesce(cr.credited, 0))::numeric(12,2) as balance
from invoices i
left join (select invoice_id, sum(amount) as paid from payment_allocations where invoice_id is not null group by invoice_id) pa
  on pa.invoice_id = i.id
left join (select invoice_id, sum(amount) as credited from credit_requests where status in ('offset','closed') and invoice_id is not null group by invoice_id) cr
  on cr.invoice_id = i.id
where i.deleted_at is null
  and i.org_id = auth_org()
  and (
    auth_role() in ('owner','office','kitchen','accountant')
    or (auth_role() = 'payer' and exists (
        select 1 from payment_request_invoices pri
        join payment_requests pr on pr.id = pri.payment_request_id
        where pri.invoice_id = i.id
          and pr.status in ('approved','sent_for_execution','executed','matched')))
  );

create view supplier_balances as
select s.id as supplier_id,
       coalesce(sum(ib.balance), 0)::numeric(12,2) as open_balance,
       count(ib.invoice_id) filter (where ib.balance > 0) as open_invoices
from suppliers s
left join invoices i on i.supplier_id = s.id and i.deleted_at is null
left join invoice_balances ib on ib.invoice_id = i.id
where s.org_id = auth_org()
  and auth_role() in ('owner','office','kitchen','accountant')
group by s.id;
