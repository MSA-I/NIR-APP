-- Dashboard aggregation: one tenant-scoped snapshot replaces seven independent browser reads.
-- The function is deliberately SECURITY INVOKER. Existing RLS remains the authorization boundary,
-- while the explicit owner/office gate prevents the management projection being used by other roles.

create or replace function public.management_dashboard_snapshot(p_today date)
returns jsonb
language sql
stable
strict
security invoker
set search_path = public, pg_temp
as $$
  with actor as (
    select public.auth_org() as org_id
    where public.auth_role() in ('owner', 'office')
  ),
  invoice_balance_metrics as (
    select
      count(*)::int as source_count,
      coalesce(sum(greatest(balance, 0)), 0)::numeric as open_balance,
      count(*) filter (where balance > 0)::int as open_invoice_count
    from public.invoice_balances, actor
  ),
  payment_request_metrics as (
    select
      count(*) filter (where status = 'pending_approval')::int as pending_approval,
      count(*) filter (where status = 'draft')::int as drafts,
      count(*) filter (
        where due_date is not null and status not in ('executed', 'matched', 'cancelled')
      )::int as active_due_dated,
      count(*) filter (
        where status not in ('executed', 'matched', 'cancelled')
      )::int as active_total,
      count(*) filter (
        where due_date < p_today and status not in ('executed', 'matched', 'cancelled')
      )::int as overdue,
      count(*) filter (
        where due_date = p_today and status not in ('executed', 'matched', 'cancelled')
      )::int as due_today
    from public.payment_requests p
    join actor a on a.org_id = p.org_id
  ),
  credit_metrics as (
    select
      count(*)::int as open_count,
      coalesce(sum(c.amount), 0)::numeric as open_sum
    from public.credit_requests c
    join actor a on a.org_id = c.org_id
    where c.status in ('open', 'requested', 'received')
  ),
  bank_metrics as (
    select
      count(*) filter (where b.status = 'unmatched')::int as unmatched,
      count(*) filter (where b.status = 'suggested')::int as suggested
    from public.bank_transactions b
    join actor a on a.org_id = b.org_id
  ),
  invoice_metrics as (
    select
      count(*) filter (where i.review_status = 'pending_approval')::int as pending_approval,
      count(*) filter (where i.review_status in ('received', 'in_review'))::int as to_review,
      count(*) filter (
        where i.review_status = 'approved' and i.export_status = 'not_sent'
      )::int as not_sent
    from public.invoices i
    join actor a on a.org_id = i.org_id
    where i.deleted_at is null
  ),
  open_orders as (
    select
      po.id,
      po.status,
      po.expected_date,
      coalesce(sum(poi.qty * poi.unit_price), 0)::numeric as committed,
      coalesce(sum(greatest(0, poi.qty - poi.received_qty) * poi.unit_price), 0)::numeric as remaining
    from public.purchase_orders po
    join actor a on a.org_id = po.org_id
    left join public.purchase_order_items poi on poi.order_id = po.id
    where po.status in ('sent', 'confirmed', 'partial')
    group by po.id, po.status, po.expected_date
  ),
  open_order_metrics as (
    select
      count(*)::int as open_count,
      coalesce(sum(committed), 0)::numeric as committed,
      coalesce(sum(remaining), 0)::numeric as remaining,
      count(*) filter (where expected_date is null)::int as no_date,
      count(*) filter (where expected_date < p_today)::int as late,
      count(*) filter (where status = 'sent')::int as awaiting_confirmation
    from open_orders
  ),
  supplier_balance_rows as (
    select sb.supplier_id, s.name, sb.open_balance
    from public.supplier_balances sb
    join public.suppliers s on s.id = sb.supplier_id
    join actor a on a.org_id = s.org_id
    where sb.open_balance > 0
  ),
  supplier_balance_metrics as (
    select count(*)::int as open_supplier_count from supplier_balance_rows
  ),
  top_balances as (
    select coalesce(
      jsonb_agg(jsonb_build_object(
        'id', ranked.supplier_id,
        'name', ranked.name,
        'balance', ranked.open_balance
      ) order by ranked.open_balance desc, ranked.supplier_id),
      '[]'::jsonb
    ) as rows
    from (
      select * from supplier_balance_rows
      order by open_balance desc, supplier_id
      limit 6
    ) ranked
  )
  select case when exists (select 1 from actor) then jsonb_build_object(
    'money', jsonb_build_object(
      'openBalance', case when ib.source_count > 0 then ib.open_balance else null end,
      'openInvoiceCount', ib.open_invoice_count
    ),
    'paymentRequests', jsonb_build_object(
      'pendingApproval', pr.pending_approval,
      'drafts', pr.drafts,
      'dueDateCoverage', pr.active_due_dated,
      'activeCount', pr.active_total,
      -- Measure only explicitly dated active requests. Undated active rows do not suppress a
      -- valid measurement, while zero dated rows remains unknown (JSON null), never a fake zero.
      'overdue', case
        when pr.active_due_dated > 0 then pr.overdue
        else null
      end,
      'dueToday', case
        when pr.active_due_dated > 0 then pr.due_today
        else null
      end
    ),
    'credits', jsonb_build_object(
      'count', cr.open_count,
      'sum', case when cr.open_count > 0 then cr.open_sum else null end
    ),
    'bank', jsonb_build_object('unmatched', bm.unmatched, 'suggested', bm.suggested),
    'invoices', jsonb_build_object(
      'pendingApproval', im.pending_approval,
      'toReview', im.to_review,
      'notSent', im.not_sent
    ),
    'openOrders', jsonb_build_object(
      'count', oom.open_count,
      'committed', case when oom.open_count > 0 then oom.committed else null end,
      'remaining', oom.remaining,
      'noDate', oom.no_date,
      'late', oom.late,
      'awaitingConfirmation', oom.awaiting_confirmation
    ),
    'openSupplierCount', sbm.open_supplier_count,
    'topBalances', tb.rows
  ) else null end
  from invoice_balance_metrics ib
  cross join payment_request_metrics pr
  cross join credit_metrics cr
  cross join bank_metrics bm
  cross join invoice_metrics im
  cross join open_order_metrics oom
  cross join supplier_balance_metrics sbm
  cross join top_balances tb
$$;

revoke all on function public.management_dashboard_snapshot(date) from public, anon;
grant execute on function public.management_dashboard_snapshot(date) to authenticated;

comment on function public.management_dashboard_snapshot(date) is
  'Owner/office tenant-scoped dashboard snapshot. SECURITY INVOKER; preserves RLS and null-vs-zero evidence semantics.';

do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0100 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
