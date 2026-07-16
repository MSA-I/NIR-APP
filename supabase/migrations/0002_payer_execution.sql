-- Allows the payment executor to complete the execution flow end-to-end:
-- record allocations for payments it executed, and refresh invoice payment status safely.

create policy pa_payer_insert on payment_allocations for insert with check (
  auth_role() = 'payer'
  and exists (select 1 from payments p where p.id = payment_id and p.executed_by = auth.uid() and p.org_id = auth_org())
);

-- Recomputes invoices.payment_status from allocations + offset credits.
-- SECURITY DEFINER so roles without direct UPDATE on invoices (payer) can trigger the refresh,
-- guarded to the caller's organization.
create or replace function refresh_invoice_payment_status(inv_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_total numeric;
  v_paid numeric;
  v_credited numeric;
  v_status invoice_payment_status;
begin
  select i.total_amount into v_total from invoices i
  where i.id = inv_id and i.org_id = auth_org();
  if v_total is null then return; end if;

  select coalesce(sum(amount), 0) into v_paid from payment_allocations where invoice_id = inv_id;
  select coalesce(sum(amount), 0) into v_credited from credit_requests
  where invoice_id = inv_id and status in ('offset', 'closed');

  v_status := case
    when v_total - v_paid - v_credited <= 1 then 'paid'
    when v_paid > 0 then 'partial'
    else 'unpaid'
  end;

  update invoices set payment_status = v_status where id = inv_id;
end $$;

grant execute on function refresh_invoice_payment_status(uuid) to authenticated;
