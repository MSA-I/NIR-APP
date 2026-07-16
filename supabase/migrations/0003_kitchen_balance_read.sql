-- Balance views must show correct paid amounts to every operational role (kitchen sees
-- supplier open balances), but payment_allocations RLS is office-only. Recreate the views
-- WITHOUT security_invoker (definer: bypasses RLS) and guard by organization inside the
-- view itself. They expose aggregate amounts only.
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
  and i.org_id = auth_org();

create view supplier_balances as
select s.id as supplier_id,
       coalesce(sum(ib.balance), 0)::numeric(12,2) as open_balance,
       count(ib.invoice_id) filter (where ib.balance > 0) as open_invoices
from suppliers s
left join invoices i on i.supplier_id = s.id and i.deleted_at is null
left join invoice_balances ib on ib.invoice_id = i.id
where s.org_id = auth_org()
group by s.id;
