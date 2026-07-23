-- P0 persona contract: owner governs, office manages procurement, accountant executes
-- approved accounting work. The user_role enum is deliberately unchanged.
-- Forward-only and additive after 0024_p2_data_reliability.sql.

-- ===== Row visibility follows the approved capability matrix =====

drop policy if exists categories_select on public.categories;
create policy categories_select on public.categories for select to authenticated using (
  org_id = auth_org() and auth_role() in ('owner', 'office', 'kitchen')
);

drop policy if exists products_select on public.products;
create policy products_select on public.products for select to authenticated using (
  org_id = auth_org() and auth_role() in ('owner', 'office', 'kitchen', 'supplier')
);

drop policy if exists supplier_categories_select on public.supplier_categories;
create policy supplier_categories_select on public.supplier_categories for select to authenticated using (
  org_id = auth_org() and auth_role() in ('owner', 'office', 'kitchen')
);

drop policy if exists supplier_products_select on public.supplier_products;
create policy supplier_products_select on public.supplier_products for select to authenticated using (
  org_id = auth_org() and auth_role() in ('owner', 'office', 'kitchen')
);

drop policy if exists price_history_select on public.price_history;
create policy price_history_select on public.price_history for select to authenticated using (
  org_id = auth_org() and auth_role() in ('owner', 'office', 'kitchen')
);

drop policy if exists purchase_requests_select on public.purchase_requests;
create policy purchase_requests_select on public.purchase_requests for select to authenticated using (
  org_id = auth_org()
  and auth_role() in ('owner', 'office', 'kitchen')
  and (status <> 'draft' or created_by = auth.uid())
);

drop policy if exists pri_select on public.purchase_request_items;
create policy pri_select on public.purchase_request_items for select to authenticated using (
  org_id = auth_org()
  and auth_role() in ('owner', 'office', 'kitchen')
  and exists (
    select 1
    from public.purchase_requests r
    where r.org_id = purchase_request_items.org_id
      and r.id = purchase_request_items.request_id
      and (r.status <> 'draft' or r.created_by = auth.uid())
  )
);

drop policy if exists invoices_select on public.invoices;
create policy invoices_select on public.invoices for select to authenticated using (
  org_id = auth_org() and (
    auth_role() in ('owner', 'office', 'kitchen')
    or (auth_role() = 'accountant' and review_status = 'approved')
    or (auth_role() = 'payer' and exists (
      select 1
      from public.payment_request_invoices pri
      join public.payment_requests pr
        on pr.org_id = pri.org_id and pr.id = pri.payment_request_id
      where pri.org_id = invoices.org_id and pri.invoice_id = invoices.id
        and pr.status in ('approved', 'sent_for_execution', 'executed', 'matched')
    ))
  )
);

drop policy if exists iol_select on public.invoice_order_links;
create policy iol_select on public.invoice_order_links for select to authenticated using (
  org_id = auth_org()
  and exists (
    select 1
    from public.invoices i
    where i.org_id = invoice_order_links.org_id
      and i.id = invoice_order_links.invoice_id
      and (
        auth_role() in ('owner', 'office', 'kitchen')
        or (auth_role() = 'accountant' and i.review_status = 'approved')
      )
  )
);

drop policy if exists irl_select on public.invoice_receipt_links;
create policy irl_select on public.invoice_receipt_links for select to authenticated using (
  org_id = auth_org()
  and exists (
    select 1
    from public.invoices i
    where i.org_id = invoice_receipt_links.org_id
      and i.id = invoice_receipt_links.invoice_id
      and (
        auth_role() in ('owner', 'office', 'kitchen')
        or (auth_role() = 'accountant' and i.review_status = 'approved')
      )
  )
);

drop policy if exists purchase_orders_select on public.purchase_orders;
create policy purchase_orders_select on public.purchase_orders for select to authenticated using (
  org_id = auth_org() and (
    auth_role() in ('owner', 'office', 'kitchen')
    or (auth_role() = 'accountant' and exists (
      select 1
      from public.invoice_order_links iol
      join public.invoices i
        on i.org_id = iol.org_id and i.id = iol.invoice_id
      where iol.org_id = purchase_orders.org_id
        and iol.order_id = purchase_orders.id
        and i.review_status = 'approved'
    ))
  )
);

drop policy if exists poi_select on public.purchase_order_items;
create policy poi_select on public.purchase_order_items for select to authenticated using (
  org_id = auth_org() and (
    auth_role() in ('owner', 'office', 'kitchen')
    or (auth_role() = 'accountant' and exists (
      select 1
      from public.purchase_orders po
      where po.org_id = purchase_order_items.org_id
        and po.id = purchase_order_items.order_id
    ))
  )
);

drop policy if exists goods_receipts_select on public.goods_receipts;
create policy goods_receipts_select on public.goods_receipts for select to authenticated using (
  org_id = auth_org() and (
    auth_role() in ('owner', 'office', 'kitchen')
    or (auth_role() = 'accountant' and exists (
      select 1
      from public.invoice_receipt_links irl
      join public.invoices i
        on i.org_id = irl.org_id and i.id = irl.invoice_id
      where irl.org_id = goods_receipts.org_id
        and irl.receipt_id = goods_receipts.id
        and i.review_status = 'approved'
    ))
  )
);

drop policy if exists gri_select on public.goods_receipt_items;
create policy gri_select on public.goods_receipt_items for select to authenticated using (
  org_id = auth_org() and (
    auth_role() in ('owner', 'office', 'kitchen')
    or (auth_role() = 'accountant' and exists (
      select 1
      from public.goods_receipts gr
      where gr.org_id = goods_receipt_items.org_id
        and gr.id = goods_receipt_items.receipt_id
    ))
  )
);

drop policy if exists payment_requests_select on public.payment_requests;
create policy payment_requests_select on public.payment_requests for select to authenticated using (
  org_id = auth_org() and (
    auth_role() in ('owner', 'office')
    or (auth_role() in ('accountant', 'payer')
        and status in ('approved', 'sent_for_execution', 'executed', 'matched'))
  )
);

drop policy if exists pri2_select on public.payment_request_invoices;
create policy pri2_select on public.payment_request_invoices for select to authenticated using (
  org_id = auth_org() and exists (
    select 1
    from public.payment_requests pr
    where pr.org_id = payment_request_invoices.org_id
      and pr.id = payment_request_invoices.payment_request_id
      and (
        auth_role() in ('owner', 'office')
        or (auth_role() in ('accountant', 'payer')
            and pr.status in ('approved', 'sent_for_execution', 'executed', 'matched'))
      )
  )
);

drop policy if exists payments_select on public.payments;
create policy payments_select on public.payments for select to authenticated using (
  org_id = auth_org() and (
    auth_role() in ('owner', 'accountant')
    or (auth_role() = 'payer' and executed_by = auth.uid())
  )
);

drop policy if exists pa_select on public.payment_allocations;
create policy pa_select on public.payment_allocations for select to authenticated using (
  org_id = auth_org() and auth_role() in ('owner', 'accountant')
);

drop policy if exists bank_imports_select on public.bank_imports;
create policy bank_imports_select on public.bank_imports for select to authenticated using (
  org_id = auth_org() and auth_role() in ('owner', 'accountant')
);

drop policy if exists bank_tx_select on public.bank_transactions;
create policy bank_tx_select on public.bank_transactions for select to authenticated using (
  org_id = auth_org() and auth_role() in ('owner', 'accountant')
);

drop policy if exists bank_alloc_select on public.bank_allocations;
create policy bank_alloc_select on public.bank_allocations for select to authenticated using (
  org_id = auth_org() and auth_role() in ('owner', 'accountant')
);

drop policy if exists audit_select on public.audit_logs;
create policy audit_select on public.audit_logs for select to authenticated using (
  org_id = auth_org() and auth_role() in ('owner', 'accountant')
);

drop policy if exists monthly_exports_select on public.monthly_exports;
create policy monthly_exports_select on public.monthly_exports for select to authenticated using (
  org_id = auth_org() and auth_role() in ('owner', 'accountant')
);

-- Financial tables are command-only. Security-definer RPCs own every mutation.
drop policy if exists payments_insert on public.payments;
drop policy if exists payments_update on public.payments;
drop policy if exists pa_insert on public.payment_allocations;
drop policy if exists pa_update on public.payment_allocations;
drop policy if exists bank_imports_insert on public.bank_imports;
drop policy if exists bank_imports_update on public.bank_imports;
drop policy if exists bank_tx_insert on public.bank_transactions;
drop policy if exists bank_tx_update on public.bank_transactions;
drop policy if exists bank_alloc_insert on public.bank_allocations;
drop policy if exists bank_alloc_update on public.bank_allocations;
drop policy if exists monthly_exports_insert on public.monthly_exports;
drop policy if exists monthly_exports_update on public.monthly_exports;

-- Computed balances remain the sole balance source. Office uses invoice.payment_status only.
create or replace function public.p0_invoice_balance_rows()
returns table (
  invoice_id uuid,
  total_amount numeric(12,2),
  paid_amount numeric(12,2),
  credited_amount numeric(12,2),
  balance numeric(12,2)
)
language sql stable security definer set search_path = public as $$
  with paid as (
    select pa.org_id, pa.invoice_id, sum(pa.amount) as amount
    from public.payment_allocations pa
    where pa.org_id = auth_org() and pa.invoice_id is not null
    group by pa.org_id, pa.invoice_id
  ), credited as (
    select cr.org_id, cr.invoice_id, sum(cr.amount) as amount
    from public.credit_requests cr
    where cr.org_id = auth_org() and cr.invoice_id is not null
      and cr.status in ('offset','closed')
    group by cr.org_id, cr.invoice_id
  )
  select i.id,
         i.total_amount,
         coalesce(p.amount, 0)::numeric(12,2),
         coalesce(c.amount, 0)::numeric(12,2),
         (i.total_amount - coalesce(p.amount, 0) - coalesce(c.amount, 0))::numeric(12,2)
  from public.invoices i
  left join paid p on p.org_id = i.org_id and p.invoice_id = i.id
  left join credited c on c.org_id = i.org_id and c.invoice_id = i.id
  where i.org_id = auth_org() and i.deleted_at is null
    and (
      auth_role() in ('owner', 'kitchen')
      or (auth_role() = 'accountant' and i.review_status = 'approved')
      or (auth_role() = 'payer' and exists (
        select 1
        from public.payment_request_invoices pri
        join public.payment_requests pr
          on pr.org_id = pri.org_id and pr.id = pri.payment_request_id
        where pri.org_id = i.org_id and pri.invoice_id = i.id
          and pr.status in ('approved','sent_for_execution','executed','matched')
      ))
    )
$$;

create or replace function public.p0_supplier_balance_rows()
returns table (supplier_id uuid, open_balance numeric(12,2), open_invoices bigint)
language sql stable security definer set search_path = public as $$
  with balances as (
    select * from public.p0_invoice_balance_rows()
  )
  select s.id,
         coalesce(sum(b.balance), 0)::numeric(12,2),
         count(b.invoice_id) filter (where b.balance > 0)
  from public.suppliers s
  left join public.invoices i
    on i.org_id = s.org_id and i.supplier_id = s.id and i.deleted_at is null
  left join balances b on b.invoice_id = i.id
  where s.org_id = auth_org() and auth_role() in ('owner', 'kitchen', 'accountant')
  group by s.id
$$;

-- Supplier performance contains procurement and price-list intelligence, not accounting context.
create or replace view public.supplier_metrics
with (security_invoker = on, security_barrier = on) as
with cfg as (
  select (now() - interval '180 days') as since
), deliveries as (
  select po.org_id, po.supplier_id, po.expected_date, po.sent_at,
         (select min(g.received_at)
          from public.goods_receipts g
          where g.org_id = po.org_id and g.order_id = po.id and g.status = 'completed') as received_at
  from public.purchase_orders po
  where po.org_id = auth_org() and po.status in ('received', 'partial')
), d as (
  select v.org_id, v.supplier_id,
    count(*) filter (where v.expected_date is not null) as otd_samples,
    count(*) filter (
      where v.expected_date is not null
        and (v.received_at at time zone 'Asia/Jerusalem')::date <= v.expected_date
    ) as otd_on_time,
    count(*) filter (where v.sent_at is not null) as lead_samples,
    avg((v.received_at at time zone 'Asia/Jerusalem')::date
      - (v.sent_at at time zone 'Asia/Jerusalem')::date)
      filter (where v.sent_at is not null) as avg_lead_days
  from deliveries v, cfg
  where v.received_at is not null and v.received_at >= cfg.since
  group by v.org_id, v.supplier_id
), x as (
  select e.org_id, e.supplier_id,
    count(*) filter (where e.status in ('open','in_progress')) as open_exceptions,
    count(*) filter (where e.created_at >= (select since from cfg)) as exceptions_window,
    count(*) as exceptions_lifetime
  from public.exceptions e
  where e.org_id = auth_org() and e.supplier_id is not null
  group by e.org_id, e.supplier_id
), c as (
  select cr.org_id, cr.supplier_id,
    count(*) filter (where cr.status in ('open','requested','received')) as open_credits,
    coalesce(sum(cr.amount) filter (where cr.status in ('open','requested','received')), 0)
      as open_credits_amount,
    count(*) filter (where cr.created_at >= (select since from cfg)) as credits_window,
    count(*) as credits_lifetime
  from public.credit_requests cr
  where cr.org_id = auth_org()
  group by cr.org_id, cr.supplier_id
), p as (
  select sp.org_id, sp.supplier_id,
         count(distinct sp.id) as priced_items,
         count(h.id) as price_changes_window,
         max(h.effective_date) as last_price_change
  from public.supplier_products sp
  left join public.price_history h
    on h.org_id = sp.org_id and h.supplier_product_id = sp.id
   and h.effective_date >= (select since::date from cfg)
  where sp.org_id = auth_org()
  group by sp.org_id, sp.supplier_id
)
select s.id as supplier_id,
  coalesce(d.otd_samples, 0) as otd_samples,
  coalesce(d.otd_on_time, 0) as otd_on_time,
  case when coalesce(d.otd_samples, 0) = 0 then null
       else round(d.otd_on_time::numeric * 100 / d.otd_samples, 0) end as on_time_pct,
  coalesce(d.lead_samples, 0) as lead_samples,
  round(d.avg_lead_days::numeric, 1) as avg_lead_days,
  coalesce(x.open_exceptions, 0) as open_exceptions,
  coalesce(x.exceptions_window, 0) as exceptions_window,
  coalesce(x.exceptions_lifetime, 0) as exceptions_lifetime,
  coalesce(c.open_credits, 0) as open_credits,
  coalesce(c.open_credits_amount, 0)::numeric(12,2) as open_credits_amount,
  coalesce(c.credits_window, 0) as credits_window,
  coalesce(c.credits_lifetime, 0) as credits_lifetime,
  coalesce(p.priced_items, 0) as priced_items,
  coalesce(p.price_changes_window, 0) as price_changes_window,
  p.last_price_change
from public.suppliers s
left join d on d.org_id = s.org_id and d.supplier_id = s.id
left join x on x.org_id = s.org_id and x.supplier_id = s.id
left join c on c.org_id = s.org_id and c.supplier_id = s.id
left join p on p.org_id = s.org_id and p.supplier_id = s.id
where s.org_id = auth_org() and s.deleted_at is null
  and auth_role() in ('owner', 'office', 'kitchen');

revoke all on public.supplier_metrics from public, anon;
grant select on public.supplier_metrics to authenticated;

drop policy if exists documents_select on public.documents;
create policy documents_select on public.documents for select to authenticated using (
  org_id = auth_org() and (
    auth_role() in ('owner', 'office', 'kitchen')
    or (auth_role() = 'accountant' and (
      (entity_type = 'invoice' and exists (
        select 1 from public.invoices i
        where i.org_id = documents.org_id and i.id = documents.entity_id
          and i.review_status = 'approved'
      ))
      or (entity_type = 'goods_receipt' and exists (
        select 1
        from public.invoice_receipt_links irl
        join public.invoices i on i.org_id = irl.org_id and i.id = irl.invoice_id
        where irl.org_id = documents.org_id and irl.receipt_id = documents.entity_id
          and i.review_status = 'approved'
      ))
      or (entity_type = 'payment' and exists (
        select 1 from public.payments p
        where p.org_id = documents.org_id and p.id = documents.entity_id
      ))
    ))
    or (auth_role() = 'payer' and uploaded_by = auth.uid())
  )
);

drop policy if exists documents_insert on public.documents;
create policy documents_insert on public.documents for insert to authenticated with check (
  org_id = auth_org()
  and uploaded_by = auth.uid()
  and storage_path like auth_org()::text || '/%'
  and entity_type in ('inbox','invoice','goods_receipt','payment')
  and mime_type is not null
  and public.p0_document_object_owned(storage_path, mime_type)
  and (
    auth_role() in ('owner', 'office', 'kitchen')
    or (
      auth_role() in ('accountant', 'payer') and entity_type = 'payment'
      and exists (
        select 1 from public.payments p
        where p.org_id = documents.org_id and p.id = documents.entity_id
          and p.executed_by = auth.uid()
      )
    )
  )
);

drop policy if exists docs_storage_read on storage.objects;
create policy docs_storage_read on storage.objects for select to authenticated using (
  bucket_id = 'documents'
  and exists (
    select 1
    from public.documents d
    where d.storage_path = storage.objects.name and d.org_id = auth_org()
      and (
        auth_role() in ('owner', 'office', 'kitchen')
        or (auth_role() = 'accountant' and (
          (d.entity_type = 'invoice' and exists (
            select 1 from public.invoices i
            where i.org_id = d.org_id and i.id = d.entity_id and i.review_status = 'approved'
          ))
          or (d.entity_type = 'goods_receipt' and exists (
            select 1
            from public.invoice_receipt_links irl
            join public.invoices i on i.org_id = irl.org_id and i.id = irl.invoice_id
            where irl.org_id = d.org_id and irl.receipt_id = d.entity_id
              and i.review_status = 'approved'
          ))
          or (d.entity_type = 'payment' and exists (
            select 1 from public.payments p
            where p.org_id = d.org_id and p.id = d.entity_id
          ))
        ))
        or (auth_role() = 'payer' and d.uploaded_by = auth.uid())
      )
  )
);

drop policy if exists docs_storage_insert on storage.objects;
create policy docs_storage_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'documents'
  and (storage.foldername(name))[1] = auth_org()::text
  and (owner = auth.uid() or owner_id = auth.uid()::text)
  and lower(coalesce(metadata ->> 'mimetype', '')) in (
    'application/pdf','image/jpeg','image/png','image/webp','image/heic','image/heif',
    'image/gif','image/avif'
  )
  and auth_role() in ('owner', 'office', 'kitchen', 'payer', 'accountant')
);

drop policy if exists docs_storage_delete on storage.objects;
create policy docs_storage_delete on storage.objects for delete to authenticated using (
  bucket_id = 'documents'
  and (storage.foldername(name))[1] = auth_org()::text
  and (owner = auth.uid() or owner_id = auth.uid()::text)
  and auth_role() in ('owner', 'office', 'kitchen', 'payer', 'accountant')
  and not public.p0_document_path_registered(name)
);

-- ===== Payment execution: regular path and isolated owner emergency path =====

create or replace function public.execute_payment_request(
  p_payment_request_id uuid,
  p_paid_date date,
  p_method text,
  p_reference text,
  p_notes text,
  p_allocations jsonb,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role user_role := auth_role();
  v_emergency boolean := coalesce(
    auth_role() = 'owner'
    and current_setting('app.p0_owner_emergency_payment', true) = auth.uid()::text,
    false
  );
  v_request payment_requests;
  v_payment payments;
  v_reason text := nullif(trim(p_reason), '');
  v_method text := nullif(trim(p_method), '');
  v_reference text := nullif(trim(p_reference), '');
  v_notes text := nullif(trim(p_notes), '');
  v_count int;
  v_distinct_count int;
  v_sum numeric;
  v_input jsonb;
  v_existing jsonb;
  v_invoice_ids uuid[] := '{}'::uuid[];
begin
  if v_org is null or v_user is null
     or (v_role not in ('payer', 'accountant') and not v_emergency) then
    raise exception 'payment_request_not_executable' using errcode = '42501';
  end if;
  if p_payment_request_id is null or p_paid_date is null or v_method is null
     or v_reference is null or v_reason is null then
    raise exception 'payment_execution_fields_required' using errcode = '22023';
  end if;
  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array' then
    raise exception 'allocation_invalid' using errcode = '22023';
  end if;

  select * into v_request
  from public.payment_requests
  where id = p_payment_request_id and org_id = v_org
  for update;

  if not found then
    raise exception 'payment_request_not_executable' using errcode = 'P0002';
  end if;

  select count(*),
         count(distinct coalesce('i:' || invoice_id::text, 'c:' || credit_id::text)),
         round(coalesce(sum(amount), 0), 2),
         coalesce(jsonb_agg(
           jsonb_build_object(
             'invoice_id', invoice_id,
             'credit_id', credit_id,
             'amount', round(amount, 2)
           ) order by coalesce(invoice_id::text, credit_id::text)
         ), '[]'::jsonb)
    into v_count, v_distinct_count, v_sum, v_input
  from jsonb_to_recordset(p_allocations) as a(
    invoice_id uuid,
    credit_id uuid,
    amount numeric
  );

  if v_count = 0 or v_count <> v_distinct_count or exists (
    select 1
    from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, credit_id uuid, amount numeric)
    where num_nonnulls(invoice_id, credit_id) <> 1 or amount is null or amount <= 0
  ) then
    raise exception 'allocation_invalid' using errcode = '22023';
  end if;

  select * into v_payment
  from public.payments
  where payment_request_id = v_request.id and org_id = v_org
  for update;

  if found then
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'invoice_id', pa.invoice_id,
        'credit_id', pa.credit_id,
        'amount', round(pa.amount, 2)
      ) order by coalesce(pa.invoice_id::text, pa.credit_id::text)
    ), '[]'::jsonb)
      into v_existing
    from public.payment_allocations pa
    where pa.payment_id = v_payment.id;

    if v_payment.supplier_id <> v_request.supplier_id
       or round(v_payment.amount, 2) <> round(v_request.amount, 2)
       or v_payment.paid_date <> p_paid_date
       or v_payment.method is distinct from v_method
       or v_payment.reference is distinct from v_reference
       or v_payment.notes is distinct from v_notes
       or v_existing is distinct from v_input then
      raise exception 'payment_execution_conflict' using errcode = 'P0001';
    end if;

    return jsonb_build_object(
      'payment_id', v_payment.id,
      'payment_request_id', v_request.id,
      'status', v_request.status,
      'invoice_ids', coalesce((
        select jsonb_agg(distinct coalesce(pa.invoice_id, cr.invoice_id))
        from public.payment_allocations pa
        left join public.credit_requests cr on cr.id = pa.credit_id
        where pa.payment_id = v_payment.id
          and coalesce(pa.invoice_id, cr.invoice_id) is not null
      ), '[]'::jsonb),
      'idempotent', true
    );
  end if;

  if v_request.status not in ('approved', 'sent_for_execution') then
    raise exception 'payment_request_not_executable' using errcode = 'P0001';
  end if;
  if v_sum <> round(v_request.amount, 2) then
    raise exception 'allocation_total_mismatch' using errcode = '22023';
  end if;

  perform 1
  from public.invoices i
  join (
    select distinct invoice_id
    from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, credit_id uuid, amount numeric)
    where invoice_id is not null
  ) input on input.invoice_id = i.id
  order by i.id
  for update of i;

  perform 1
  from public.credit_requests c
  join (
    select distinct credit_id
    from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, credit_id uuid, amount numeric)
    where credit_id is not null
  ) input on input.credit_id = c.id
  order by c.id
  for update of c;

  if exists (
    select 1
    from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, credit_id uuid, amount numeric)
    left join public.invoices i on i.id = a.invoice_id
    left join public.payment_request_invoices pri
      on pri.payment_request_id = v_request.id and pri.invoice_id = a.invoice_id
    left join public.credit_requests c on c.id = a.credit_id
    where (a.invoice_id is not null and (
             i.id is null or i.org_id <> v_org or i.supplier_id <> v_request.supplier_id
             or i.deleted_at is not null or pri.invoice_id is null
             or round(a.amount, 2) > round(pri.amount_allocated, 2)
             or ((v_role = 'accountant' or v_emergency) and i.review_status <> 'approved')
           ))
       or (a.credit_id is not null and (
             c.id is null or c.org_id <> v_org or c.supplier_id <> v_request.supplier_id
             or c.status <> 'received' or round(a.amount, 2) <> round(c.amount, 2)
           ))
  ) then
    raise exception 'allocation_target_invalid' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, credit_id uuid, amount numeric)
    join public.invoices i on i.id = a.invoice_id
    where round(a.amount, 2) > round(
      i.total_amount
      - coalesce((select sum(pa.amount) from public.payment_allocations pa where pa.invoice_id = i.id), 0)
      - coalesce((select sum(cr.amount) from public.credit_requests cr
                  where cr.invoice_id = i.id and cr.status in ('offset', 'closed')), 0),
      2
    )
  ) then
    raise exception 'allocation_exceeds_balance' using errcode = 'P0001';
  end if;

  perform set_config('app.p1_financial_writer', v_user::text, true);

  insert into public.payments (
    org_id, supplier_id, payment_request_id, amount, paid_date,
    method, reference, executed_by, notes
  ) values (
    v_org, v_request.supplier_id, v_request.id, round(v_request.amount, 2), p_paid_date,
    v_method, v_reference, v_user, v_notes
  ) returning * into v_payment;

  insert into public.payment_allocations (payment_id, invoice_id, credit_id, amount)
  select v_payment.id, invoice_id, credit_id, round(amount, 2)
  from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, credit_id uuid, amount numeric)
  order by coalesce(invoice_id::text, credit_id::text);

  update public.credit_requests c
  set status = 'offset', resolved_at = now()
  from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, credit_id uuid, amount numeric)
  where a.credit_id = c.id;

  select coalesce(array_agg(distinct invoice_id order by invoice_id), '{}'::uuid[])
    into v_invoice_ids
  from (
    select a.invoice_id
    from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, credit_id uuid, amount numeric)
    where a.invoice_id is not null
    union
    select c.invoice_id
    from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, credit_id uuid, amount numeric)
    join public.credit_requests c on c.id = a.credit_id
    where c.invoice_id is not null
  ) affected;

  perform public.p1_refresh_invoice_payment_statuses(v_org, v_invoice_ids);

  update public.payment_requests
  set status = 'executed', executor_notes = v_notes
  where id = v_request.id;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_user,
    case when v_emergency then 'payment_request_emergency_executed' else 'payment_request_executed' end,
    'payment_requests', v_request.id,
    jsonb_build_object('status', v_request.status),
    jsonb_build_object(
      'status', 'executed',
      'payment_id', v_payment.id,
      'amount', v_payment.amount,
      'reference', v_reference,
      'emergency', v_emergency
    ),
    v_reason
  );

  return jsonb_build_object(
    'payment_id', v_payment.id,
    'payment_request_id', v_request.id,
    'status', 'executed',
    'invoice_ids', to_jsonb(v_invoice_ids),
    'emergency', v_emergency,
    'idempotent', false
  );
end
$$;

create or replace function public.execute_emergency_payment_request(
  p_payment_request_id uuid,
  p_paid_date date,
  p_method text,
  p_reference text,
  p_notes text,
  p_allocations jsonb,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role user_role := auth_role();
  v_reauthenticated_at timestamptz;
  v_result jsonb;
begin
  if v_org is null or v_user is null or v_role <> 'owner' then
    raise exception 'owner_emergency_not_authorized' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  if jsonb_typeof(auth.jwt() -> 'amr') <> 'array' then
    raise exception 'fresh_authentication_required' using errcode = '42501';
  end if;

  begin
    select max(to_timestamp((entry ->> 'timestamp')::double precision))
      into v_reauthenticated_at
    from jsonb_array_elements(auth.jwt() -> 'amr') entry
    where entry ->> 'method' = 'password';
  exception when others then
    raise exception 'fresh_authentication_required' using errcode = '42501';
  end;

  if v_reauthenticated_at is null
     or v_reauthenticated_at < clock_timestamp() - interval '5 minutes'
     or v_reauthenticated_at > clock_timestamp() + interval '30 seconds' then
    raise exception 'fresh_authentication_required' using errcode = '42501';
  end if;

  perform set_config('app.p0_owner_emergency_payment', v_user::text, true);
  begin
    v_result := public.execute_payment_request(
      p_payment_request_id,
      p_paid_date,
      p_method,
      p_reference,
      p_notes,
      p_allocations,
      p_reason
    );
  exception when others then
    perform set_config('app.p0_owner_emergency_payment', '', true);
    raise;
  end;
  perform set_config('app.p0_owner_emergency_payment', '', true);

  return v_result;
end
$$;

revoke all on function public.execute_payment_request(uuid, date, text, text, text, jsonb, text) from public;
revoke all on function public.execute_emergency_payment_request(uuid, date, text, text, text, jsonb, text) from public;
grant execute on function public.execute_payment_request(uuid, date, text, text, text, jsonb, text) to authenticated;
grant execute on function public.execute_emergency_payment_request(uuid, date, text, text, text, jsonb, text) to authenticated;

-- Approval remains an owner/procurement-manager decision and is authoritative server-side.
create or replace function public.transition_payment_request(
  p_payment_request_id uuid,
  p_target_status text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role user_role := auth_role();
  v_request payment_requests;
  v_target payment_request_status;
  v_reason text := nullif(trim(p_reason), '');
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_payment_request_id is null or v_reason is null
     or p_target_status not in ('pending_approval', 'approved', 'sent_for_execution', 'investigation', 'cancelled') then
    raise exception 'payment_request_transition_invalid' using errcode = '22023';
  end if;
  v_target := p_target_status::payment_request_status;

  select * into v_request
  from public.payment_requests
  where id = p_payment_request_id and org_id = v_org
  for update;

  if not found then
    raise exception 'payment_request_unknown' using errcode = 'P0002';
  end if;
  if v_request.status = v_target then
    return jsonb_build_object(
      'payment_request_id', v_request.id,
      'status', v_request.status,
      'idempotent', true
    );
  end if;

  if not (
       (v_request.status = 'draft' and v_target in ('pending_approval', 'investigation', 'cancelled'))
    or (v_request.status in ('pending_approval', 'suspected_duplicate', 'investigation')
        and v_target in ('approved', 'investigation', 'cancelled'))
    or (v_request.status = 'approved' and v_target in ('sent_for_execution', 'cancelled'))
    or (v_request.status = 'sent_for_execution' and v_target = 'cancelled')
  ) then
    raise exception 'payment_request_transition_invalid' using errcode = 'P0001';
  end if;

  if v_target = 'approved' then
    perform 1
    from public.invoices i
    join public.payment_request_invoices pri on pri.invoice_id = i.id
    where pri.payment_request_id = v_request.id
    order by i.id
    for update of i;

    if not exists (
      select 1
      from public.payment_request_invoices pri
      where pri.payment_request_id = v_request.id
    ) or exists (
      select 1
      from public.payment_request_invoices pri
      left join public.invoices i on i.id = pri.invoice_id
      where pri.payment_request_id = v_request.id
        and (
          i.id is null or i.org_id <> v_org or i.supplier_id <> v_request.supplier_id
          or i.deleted_at is not null or i.review_status <> 'approved'
          or round(pri.amount_allocated, 2) > round(
            i.total_amount
            - coalesce((select sum(pa.amount) from public.payment_allocations pa where pa.invoice_id = i.id), 0)
            - coalesce((select sum(cr.amount) from public.credit_requests cr
                        where cr.invoice_id = i.id and cr.status in ('offset', 'closed')), 0),
            2
          )
        )
    ) then
      raise exception 'payment_request_checks_failed' using errcode = 'P0001';
    end if;
  end if;

  perform set_config('app.p1_financial_writer', v_user::text, true);

  update public.payment_requests
  set status = v_target,
      approved_by = case when v_target = 'approved' then v_user else approved_by end,
      approved_at = case when v_target = 'approved' then now() else approved_at end
  where id = v_request.id;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_user, 'payment_request_transitioned', 'payment_requests', v_request.id,
    jsonb_build_object('status', v_request.status),
    jsonb_build_object('status', v_target),
    v_reason
  );

  return jsonb_build_object(
    'payment_request_id', v_request.id,
    'status', v_target,
    'idempotent', false
  );
end
$$;

revoke all on function public.transition_payment_request(uuid, text, text) from public;
grant execute on function public.transition_payment_request(uuid, text, text) to authenticated;

-- Narrow signals preserve preflight warnings without exposing bank rows or exact balances.
create or replace function public.invoice_financial_check_signals(p_invoice_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid := auth_org();
  v_role user_role := auth_role();
  v_invoice invoices;
  v_bank_match boolean;
  v_balance numeric;
begin
  if v_org is null or auth.uid() is null
     or v_role not in ('owner', 'office', 'kitchen', 'accountant') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select * into v_invoice
  from public.invoices i
  where i.id = p_invoice_id and i.org_id = v_org and i.deleted_at is null;

  if not found or (v_role = 'accountant' and v_invoice.review_status <> 'approved') then
    raise exception 'invoice_unknown' using errcode = 'P0002';
  end if;

  select exists (
    select 1
    from public.bank_allocations ba
    where ba.org_id = v_org and ba.invoice_id = v_invoice.id and ba.confirmed
  ) into v_bank_match;

  select v_invoice.total_amount
         - coalesce((select sum(pa.amount) from public.payment_allocations pa
                     where pa.org_id = v_org and pa.invoice_id = v_invoice.id), 0)
         - coalesce((select sum(cr.amount) from public.credit_requests cr
                     where cr.org_id = v_org and cr.invoice_id = v_invoice.id
                       and cr.status in ('offset', 'closed')), 0)
    into v_balance;

  return jsonb_build_object(
    'bank_match_exists', v_bank_match,
    'already_paid', v_balance <= 0
  );
end
$$;

create or replace function public.payment_request_financial_check_signals(
  p_supplier_id uuid,
  p_amount numeric,
  p_invoice_ids uuid[],
  p_payment_request_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid := auth_org();
  v_role user_role := auth_role();
  v_requested_count int;
  v_visible_count int;
  v_paid_count int;
  v_unapproved_count int;
  v_open_balance numeric;
  v_similar_bank boolean;
begin
  if v_org is null or auth.uid() is null or v_role not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_supplier_id is null or p_amount is null or p_amount <= 0
     or p_invoice_ids is null or array_position(p_invoice_ids, null) is not null then
    raise exception 'payment_request_checks_invalid' using errcode = '22023';
  end if;
  if p_payment_request_id is not null and not exists (
    select 1 from public.payment_requests pr
    where pr.id = p_payment_request_id and pr.org_id = v_org
  ) then
    raise exception 'payment_request_unknown' using errcode = 'P0002';
  end if;

  select count(*) into v_requested_count
  from (select distinct unnest(p_invoice_ids) as id) requested;

  with requested as (
    select distinct unnest(p_invoice_ids) as id
  ), visible as (
    select i.id, i.review_status,
           i.total_amount
           - coalesce((select sum(pa.amount) from public.payment_allocations pa
                       where pa.org_id = v_org and pa.invoice_id = i.id), 0)
           - coalesce((select sum(cr.amount) from public.credit_requests cr
                       where cr.org_id = v_org and cr.invoice_id = i.id
                         and cr.status in ('offset', 'closed')), 0) as balance
    from requested r
    join public.invoices i on i.id = r.id
    where i.org_id = v_org and i.supplier_id = p_supplier_id and i.deleted_at is null
  )
  select count(*),
         count(*) filter (where balance <= 0),
         count(*) filter (where review_status <> 'approved'),
         coalesce(sum(greatest(balance, 0)), 0)
    into v_visible_count, v_paid_count, v_unapproved_count, v_open_balance
  from visible;

  select exists (
    select 1
    from public.bank_transactions bt
    where bt.org_id = v_org
      and bt.supplier_id = p_supplier_id
      and round(bt.amount, 2) = round(p_amount, 2)
      and bt.is_debit
      and bt.tx_date >= current_date - 45
  ) into v_similar_bank;

  return jsonb_build_object(
    'requested_invoice_count', v_requested_count,
    'visible_invoice_count', v_visible_count,
    'paid_invoice_count', v_paid_count,
    'unapproved_invoice_count', v_unapproved_count,
    'amount_matches_open_balance', abs(round(v_open_balance, 2) - round(p_amount, 2)) <= 1,
    'similar_bank_transfer_exists', v_similar_bank
  );
end
$$;

revoke all on function public.invoice_financial_check_signals(uuid) from public;
revoke all on function public.payment_request_financial_check_signals(uuid, numeric, uuid[], uuid) from public;
grant execute on function public.invoice_financial_check_signals(uuid) to authenticated;
grant execute on function public.payment_request_financial_check_signals(uuid, numeric, uuid[], uuid) to authenticated;

-- Removing a match never removes a payment. Direct invoice matches require a separate
-- financial correction because their payment allocation has already consumed the balance.
create or replace function public.unmatch_bank_transaction(
  p_bank_transaction_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role user_role := auth_role();
  v_tx bank_transactions;
  v_reason text := nullif(trim(p_reason), '');
  v_payment_id uuid;
  v_payment_request_id uuid;
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'accountant') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_bank_transaction_id is null or v_reason is null then
    raise exception 'bank_unmatch_invalid' using errcode = '22023';
  end if;

  select * into v_tx
  from public.bank_transactions
  where id = p_bank_transaction_id and org_id = v_org
  for update;

  if not found then
    raise exception 'bank_transaction_unknown' using errcode = 'P0002';
  end if;
  if v_tx.status <> 'matched' then
    if v_tx.status = 'unmatched' and exists (
      select 1
      from public.audit_logs a
      where a.org_id = v_org and a.entity_type = 'bank_transactions'
        and a.entity_id = v_tx.id and a.action = 'bank_match_removed'
    ) then
      return jsonb_build_object(
        'bank_transaction_id', v_tx.id,
        'status', 'unmatched',
        'idempotent', true
      );
    end if;
    raise exception 'bank_transaction_not_matched' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from public.bank_allocations ba
    where ba.org_id = v_org and ba.bank_transaction_id = v_tx.id
      and ba.invoice_id is not null
  ) then
    raise exception 'bank_direct_match_requires_financial_correction' using errcode = 'P0001';
  end if;

  select ba.payment_id into v_payment_id
  from public.bank_allocations ba
  where ba.org_id = v_org and ba.bank_transaction_id = v_tx.id
    and ba.payment_id is not null and ba.confirmed
  order by ba.id
  limit 1;

  if v_payment_id is null then
    raise exception 'bank_match_allocation_missing' using errcode = 'P0001';
  end if;

  select p.payment_request_id into v_payment_request_id
  from public.payments p
  where p.org_id = v_org and p.id = v_payment_id;

  perform set_config('app.p1_financial_writer', v_user::text, true);

  delete from public.bank_allocations
  where org_id = v_org and bank_transaction_id = v_tx.id;

  update public.bank_transactions
  set status = 'unmatched'
  where id = v_tx.id and org_id = v_org;

  if v_payment_request_id is not null then
    update public.payment_requests
    set status = 'executed'
    where id = v_payment_request_id and org_id = v_org and status = 'matched';
  end if;

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_user, 'bank_match_removed', 'bank_transactions', v_tx.id,
    jsonb_build_object('status', 'matched', 'payment_id', v_payment_id),
    jsonb_build_object('status', 'unmatched', 'payment_id', v_payment_id),
    v_reason
  );

  return jsonb_build_object(
    'bank_transaction_id', v_tx.id,
    'payment_id', v_payment_id,
    'status', 'unmatched',
    'idempotent', false
  );
end
$$;

revoke all on function public.unmatch_bank_transaction(uuid, text) from public;
grant execute on function public.unmatch_bank_transaction(uuid, text) to authenticated;

-- Reuse the reviewed 0023/0024 command bodies verbatim; only their entry-role predicates
-- change. The assertions make reset fail closed if migration ancestry ever drifts.
do $persona_role_rewrite$
declare
  v_signature regprocedure;
  v_definition text;
  v_old text := 'v_role not in (''owner'', ''office'')';
  v_new text := 'v_role not in (''owner'', ''accountant'')';
  v_eol text;
begin
  foreach v_signature in array array[
    'public.match_bank_transaction(uuid,uuid,uuid,uuid,jsonb,numeric,text)'::regprocedure,
    'public.assign_bank_transaction_supplier(uuid,uuid,text)'::regprocedure,
    'public.ignore_bank_transaction(uuid,text)'::regprocedure,
    'public.open_bank_transaction_exception(uuid,uuid,text)'::regprocedure,
    'public.import_bank_transactions(text,text,jsonb,jsonb,text)'::regprocedure,
    'public.mark_month_export_sent(date,uuid[],text)'::regprocedure
  ] loop
    select pg_get_functiondef(v_signature::oid) into v_definition;
    if position(v_old in v_definition) = 0 then
      raise exception 'persona_role_rewrite_source_mismatch: %', v_signature;
    end if;
    execute replace(v_definition, v_old, v_new);
  end loop;

  -- Accountant may directly match or export only approved invoices.
  v_signature := 'public.match_bank_transaction(uuid,uuid,uuid,uuid,jsonb,numeric,text)'::regprocedure;
  select pg_get_functiondef(v_signature::oid) into v_definition;
  v_eol := case when position(E'\r\n' in v_definition) > 0 then E'\r\n' else E'\n' end;
  v_old := '         or i.deleted_at is not null';
  v_new := v_old || v_eol
    || '         or (v_role = ''accountant'' and i.review_status <> ''approved'')';
  if position(v_old in v_definition) = 0 then
    raise exception 'persona_role_rewrite_source_mismatch: % invoice guard', v_signature;
  end if;
  execute replace(v_definition, v_old, v_new);

  v_signature := 'public.mark_month_export_sent(date,uuid[],text)'::regprocedure;
  select pg_get_functiondef(v_signature::oid) into v_definition;
  v_eol := case when position(E'\r\n' in v_definition) > 0 then E'\r\n' else E'\n' end;
  v_old := '              or i.invoice_date < p_month';
  v_new := '              or (v_role = ''accountant'' and i.review_status <> ''approved'')'
    || v_eol || v_old;
  if position(v_old in v_definition) = 0 then
    raise exception 'persona_role_rewrite_source_mismatch: % invoice guard', v_signature;
  end if;
  execute replace(v_definition, v_old, v_new);

  v_signature := 'public.transition_credit_request(uuid,credit_status,text)'::regprocedure;
  select pg_get_functiondef(v_signature::oid) into v_definition;
  v_old := 'v_role not in (''owner'', ''office'', ''kitchen'')';
  v_new := 'v_role not in (''owner'', ''office'', ''kitchen'', ''accountant'')';
  if position(v_old in v_definition) = 0 then
    raise exception 'persona_role_rewrite_source_mismatch: %', v_signature;
  end if;
  v_definition := replace(v_definition, v_old, v_new);
  v_eol := case when position(E'\r\n' in v_definition) > 0 then E'\r\n' else E'\n' end;
  v_old := '  -- Payment execution locks invoices before credits. Use the same order to avoid a cycle.';
  v_new := '  if v_role = ''accountant'' and v_invoice_id is not null and not exists (' || v_eol
    || '    select 1 from invoices i' || v_eol
    || '    where i.id = v_invoice_id and i.org_id = v_org and i.review_status = ''approved''' || v_eol
    || '  ) then' || v_eol
    || '    raise exception ''credit_request_invoice_not_approved'' using errcode = ''42501'';' || v_eol
    || '  end if;' || v_eol || v_eol || v_old;
  if position(v_old in v_definition) = 0 then
    raise exception 'persona_role_rewrite_source_mismatch: % invoice guard', v_signature;
  end if;
  execute replace(v_definition, v_old, v_new);
end
$persona_role_rewrite$;
