-- P1 — atomic financial command boundaries.
-- Depends on P0 migrations 0020-0022; integrate P0 before applying this migration.
-- Forward-only: command functions/guards can be replaced, but financial rows are never
-- deleted as rollback. Run supabase/tests/p1_preflight.sql before this file.

-- ===== Constraints whose live preflight is clean =====

alter table payment_allocations
  add constraint payment_allocations_amount_positive check (amount > 0) not valid,
  add constraint payment_allocations_one_target check (
    num_nonnulls(invoice_id, credit_id) = 1
  ) not valid;

alter table bank_allocations
  add constraint bank_allocations_amount_positive check (amount > 0) not valid,
  add constraint bank_allocations_confidence_range check (
    confidence is null or confidence between 0 and 1
  ) not valid;

-- Deliberately absent for now: CHECK (num_nonnulls(invoice_id,payment_id)=1).
-- Preflight found seven historical rows with both targets populated. New writes are validated
-- by match_bank_transaction and direct writes are closed below; historical repair needs an
-- explicit data decision and must not be guessed in this migration.

alter table goods_receipt_items
  add constraint goods_receipt_items_qty_nonnegative check (qty_received >= 0) not valid;

alter table monthly_exports
  add column invoice_ids uuid[],
  add constraint monthly_exports_first_day check (
    month = date_trunc('month', month)::date
  ) not valid;

alter table payment_allocations validate constraint payment_allocations_amount_positive;
alter table payment_allocations validate constraint payment_allocations_one_target;
alter table bank_allocations validate constraint bank_allocations_amount_positive;
alter table bank_allocations validate constraint bank_allocations_confidence_range;
alter table goods_receipt_items validate constraint goods_receipt_items_qty_nonnegative;
alter table monthly_exports validate constraint monthly_exports_first_day;

create unique index payments_one_execution_per_request_idx
  on payments (org_id, payment_request_id)
  where payment_request_id is not null;

create unique index bank_transactions_org_row_hash_idx
  on bank_transactions (org_id, row_hash);

create unique index goods_receipt_items_receipt_order_item_idx
  on goods_receipt_items (receipt_id, order_item_id);

-- ===== Direct-write boundary =====

create or replace function p1_financial_command_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_authorized boolean := current_setting('app.p1_financial_writer', true)
                          is not distinct from auth.uid()::text;
begin
  -- Migrations, seeds and trusted server jobs have no end-user subject.
  if v_user is null or v_authorized then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  -- Invoice soft-delete remains a separate, existing command until P0 closes it. Every other
  -- invoice mutation owned by P1 must pass through its RPC.
  if tg_table_name = 'invoices' and tg_op = 'UPDATE'
     and (to_jsonb(new) - 'deleted_at' - 'updated_at')
         is not distinct from (to_jsonb(old) - 'deleted_at' - 'updated_at') then
    return new;
  end if;

  -- Receipt completion owns received_qty only; order-item creation remains owned by finalize.
  if tg_table_name = 'purchase_order_items' and tg_op = 'UPDATE'
     and new.received_qty is not distinct from old.received_qty then
    return new;
  end if;

  -- Other order status transitions remain in Orders.tsx/P2. Only the receipt-derived states
  -- partial/received are protected here.
  if tg_table_name = 'purchase_orders' and tg_op = 'UPDATE'
     and (
       new.status is not distinct from old.status
       or (new.status not in ('partial', 'received') and old.status not in ('partial', 'received'))
     ) then
    return new;
  end if;

  raise exception 'financial_command_rpc_required' using errcode = '42501';
end
$$;

create trigger p1_payments_guard
  before insert or update or delete on payments
  for each row execute function p1_financial_command_guard();
create trigger p1_payment_allocations_guard
  before insert or update or delete on payment_allocations
  for each row execute function p1_financial_command_guard();
create trigger p1_bank_imports_guard
  before insert or update or delete on bank_imports
  for each row execute function p1_financial_command_guard();
create trigger p1_bank_transactions_guard
  before insert or update or delete on bank_transactions
  for each row execute function p1_financial_command_guard();
create trigger p1_bank_allocations_guard
  before insert or update or delete on bank_allocations
  for each row execute function p1_financial_command_guard();
create trigger p1_goods_receipts_guard
  before insert or update or delete on goods_receipts
  for each row execute function p1_financial_command_guard();
create trigger p1_goods_receipt_items_guard
  before insert or update or delete on goods_receipt_items
  for each row execute function p1_financial_command_guard();
create trigger p1_purchase_order_items_guard
  before update on purchase_order_items
  for each row execute function p1_financial_command_guard();
create trigger p1_purchase_orders_guard
  before update on purchase_orders
  for each row execute function p1_financial_command_guard();
create trigger p1_invoices_guard
  before insert or update on invoices
  for each row execute function p1_financial_command_guard();
create trigger p1_invoice_order_links_guard
  before insert or update or delete on invoice_order_links
  for each row execute function p1_financial_command_guard();
create trigger p1_invoice_receipt_links_guard
  before insert or update or delete on invoice_receipt_links
  for each row execute function p1_financial_command_guard();
create trigger p1_credit_requests_guard
  before insert or update or delete on credit_requests
  for each row execute function p1_financial_command_guard();
create trigger p1_payment_requests_guard
  before insert or update or delete on payment_requests
  for each row execute function p1_financial_command_guard();
create trigger p1_payment_request_invoices_guard
  before insert or update or delete on payment_request_invoices
  for each row execute function p1_financial_command_guard();
create trigger p1_supplier_products_guard
  before insert or update or delete on supplier_products
  for each row execute function p1_financial_command_guard();
create trigger p1_price_history_guard
  before insert or update or delete on price_history
  for each row execute function p1_financial_command_guard();
create trigger p1_monthly_exports_guard
  before insert or update or delete on monthly_exports
  for each row execute function p1_financial_command_guard();

-- Payer can no longer assemble a payment with table writes. Owner/office policies stay for
-- reads and unrelated legacy flows, but the guards above reject protected direct mutations.
drop policy if exists payment_requests_payer_update on payment_requests;
drop policy if exists payments_payer_insert on payments;
drop policy if exists pa_payer_insert on payment_allocations;

-- Table grants close every surface whose writes are fully owned by P1. Security-definer RPCs
-- below do not need these grants. Invoice/order UPDATE remains because soft-delete and other
-- status transitions are outside P1; the column-sensitive guard narrows it.
revoke insert, update, delete on payments from authenticated;
revoke insert, update, delete on payment_allocations from authenticated;
revoke insert, update, delete on bank_imports from authenticated;
revoke insert, update, delete on bank_transactions from authenticated;
revoke insert, update, delete on bank_allocations from authenticated;
revoke insert, update, delete on goods_receipts from authenticated;
revoke insert, update, delete on goods_receipt_items from authenticated;
revoke update on purchase_order_items from authenticated;
revoke insert on invoices from authenticated;
revoke insert, update, delete on invoice_order_links from authenticated;
revoke insert, update, delete on invoice_receipt_links from authenticated;
revoke insert, update, delete on credit_requests from authenticated;
revoke insert, update, delete on payment_requests from authenticated;
revoke insert, update, delete on payment_request_invoices from authenticated;
revoke insert, update, delete on supplier_products from authenticated;
revoke insert, update, delete on price_history from authenticated;
revoke insert, update, delete on monthly_exports from authenticated;

-- Shared by payment execution and bank matching. It recomputes; it never stores a balance.
create or replace function p1_refresh_invoice_payment_statuses(
  p_org uuid,
  p_invoice_ids uuid[]
)
returns void
language sql
security definer
set search_path = public
as $$
  update invoices i
  set payment_status = case
    when i.total_amount
         - coalesce((select sum(pa.amount) from payment_allocations pa where pa.invoice_id = i.id), 0)
         - coalesce((select sum(cr.amount) from credit_requests cr
                     where cr.invoice_id = i.id and cr.status in ('offset', 'closed')), 0) <= 1
      then 'paid'::invoice_payment_status
    when coalesce((select sum(pa.amount) from payment_allocations pa where pa.invoice_id = i.id), 0) > 0
      then 'partial'::invoice_payment_status
    else 'unpaid'::invoice_payment_status
  end
  where i.org_id = p_org and i.id = any(coalesce(p_invoice_ids, '{}'::uuid[]));
$$;

revoke all on function public.p1_refresh_invoice_payment_statuses(uuid, uuid[]) from public;
revoke all on function public.p1_refresh_invoice_payment_statuses(uuid, uuid[]) from authenticated;

-- Keep the existing public helper safe under the new invoice guard.
create or replace function refresh_invoice_payment_status(inv_id uuid) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
begin
  if v_org is null or v_user is null or not exists (
    select 1 from invoices i where i.id = inv_id and i.org_id = v_org
  ) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform set_config('app.p1_financial_writer', v_user::text, true);
  perform p1_refresh_invoice_payment_statuses(v_org, array[inv_id]);
end
$$;

revoke all on function public.refresh_invoice_payment_status(uuid) from public;
grant execute on function public.refresh_invoice_payment_status(uuid) to authenticated;

-- ===== 1. Execute an approved payment request =====

create or replace function execute_payment_request(
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
  if v_org is null or v_user is null or v_role <> 'payer' then
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
  from payment_requests
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
  from payments
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
    from payment_allocations pa
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
        from payment_allocations pa
        left join credit_requests cr on cr.id = pa.credit_id
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

  -- Invoice rows are the serialization point for every command that consumes a balance.
  perform 1
  from invoices i
  join (
    select distinct invoice_id
    from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, credit_id uuid, amount numeric)
    where invoice_id is not null
  ) input on input.invoice_id = i.id
  order by i.id
  for update of i;

  perform 1
  from credit_requests c
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
    left join invoices i on i.id = a.invoice_id
    left join payment_request_invoices pri
      on pri.payment_request_id = v_request.id and pri.invoice_id = a.invoice_id
    left join credit_requests c on c.id = a.credit_id
    where (a.invoice_id is not null and (
             i.id is null or i.org_id <> v_org or i.supplier_id <> v_request.supplier_id
             or i.deleted_at is not null or pri.invoice_id is null
             or round(a.amount, 2) > round(pri.amount_allocated, 2)
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
    join invoices i on i.id = a.invoice_id
    where round(a.amount, 2) > round(
      i.total_amount
      - coalesce((select sum(pa.amount) from payment_allocations pa where pa.invoice_id = i.id), 0)
      - coalesce((select sum(cr.amount) from credit_requests cr
                  where cr.invoice_id = i.id and cr.status in ('offset', 'closed')), 0),
      2
    )
  ) then
    raise exception 'allocation_exceeds_balance' using errcode = 'P0001';
  end if;

  perform set_config('app.p1_financial_writer', v_user::text, true);

  insert into payments (
    org_id, supplier_id, payment_request_id, amount, paid_date,
    method, reference, executed_by, notes
  ) values (
    v_org, v_request.supplier_id, v_request.id, round(v_request.amount, 2), p_paid_date,
    v_method, v_reference, v_user, v_notes
  ) returning * into v_payment;

  insert into payment_allocations (payment_id, invoice_id, credit_id, amount)
  select v_payment.id, invoice_id, credit_id, round(amount, 2)
  from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, credit_id uuid, amount numeric)
  order by coalesce(invoice_id::text, credit_id::text);

  update credit_requests c
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
    join credit_requests c on c.id = a.credit_id
    where c.invoice_id is not null
  ) affected;

  perform p1_refresh_invoice_payment_statuses(v_org, v_invoice_ids);

  update payment_requests
  set status = 'executed', executor_notes = v_notes
  where id = v_request.id;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_user, 'payment_request_executed', 'payment_requests', v_request.id,
    jsonb_build_object('status', v_request.status),
    jsonb_build_object(
      'status', 'executed',
      'payment_id', v_payment.id,
      'amount', v_payment.amount,
      'reference', v_reference
    ),
    v_reason
  );

  return jsonb_build_object(
    'payment_id', v_payment.id,
    'payment_request_id', v_request.id,
    'status', 'executed',
    'invoice_ids', to_jsonb(v_invoice_ids),
    'idempotent', false
  );
end
$$;

revoke all on function public.execute_payment_request(uuid, date, text, text, text, jsonb, text) from public;
grant execute on function public.execute_payment_request(uuid, date, text, text, text, jsonb, text) to authenticated;

-- ===== 5. Create and transition payment requests =====

create or replace function create_payment_request(
  p_request_id uuid,
  p_supplier_id uuid,
  p_due_date date,
  p_notes text,
  p_requested_status text,
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
  v_request payment_requests;
  v_reason text := nullif(trim(p_reason), '');
  v_notes text := nullif(trim(p_notes), '');
  v_status payment_request_status;
  v_amount numeric;
  v_count int;
  v_distinct int;
  v_duplicate boolean;
  v_input jsonb;
  v_existing jsonb;
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null or p_supplier_id is null or v_reason is null
     or p_requested_status not in ('draft', 'pending_approval') then
    raise exception 'payment_request_invalid' using errcode = '22023';
  end if;
  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array' then
    raise exception 'allocation_invalid' using errcode = '22023';
  end if;

  select count(*), count(distinct invoice_id), round(coalesce(sum(amount), 0), 2),
         coalesce(jsonb_agg(
           jsonb_build_object('invoice_id', invoice_id, 'amount', round(amount, 2))
           order by invoice_id
         ), '[]'::jsonb)
    into v_count, v_distinct, v_amount, v_input
  from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, amount numeric);

  if v_count = 0 or v_count <> v_distinct or v_amount <= 0 or exists (
    select 1
    from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, amount numeric)
    where invoice_id is null or amount is null or amount <= 0
  ) then
    raise exception 'allocation_invalid' using errcode = '22023';
  end if;

  select * into v_request
  from payment_requests
  where id = p_request_id and org_id = v_org
  for update;

  if found then
    select coalesce(jsonb_agg(
      jsonb_build_object('invoice_id', pri.invoice_id, 'amount', round(pri.amount_allocated, 2))
      order by pri.invoice_id
    ), '[]'::jsonb)
      into v_existing
    from payment_request_invoices pri
    where pri.payment_request_id = v_request.id;

    if v_request.supplier_id <> p_supplier_id
       or round(v_request.amount, 2) <> v_amount
       or v_request.due_date is distinct from p_due_date
       or v_request.notes is distinct from v_notes
       or v_existing is distinct from v_input then
      raise exception 'payment_request_idempotency_conflict' using errcode = 'P0001';
    end if;

    return jsonb_build_object(
      'payment_request_id', v_request.id,
      'number', v_request.number,
      'status', v_request.status,
      'amount', v_request.amount,
      'idempotent', true
    );
  end if;

  if not exists (
    select 1 from suppliers s
    where s.id = p_supplier_id and s.org_id = v_org and s.deleted_at is null
  ) then
    raise exception 'payment_request_supplier_invalid' using errcode = '22023';
  end if;

  perform 1
  from invoices i
  join (
    select distinct invoice_id
    from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, amount numeric)
  ) input on input.invoice_id = i.id
  order by i.id
  for update of i;

  if exists (
    select 1
    from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, amount numeric)
    left join invoices i on i.id = a.invoice_id
    where i.id is null or i.org_id <> v_org or i.supplier_id <> p_supplier_id
       or i.deleted_at is not null
       or round(a.amount, 2) > round(
         i.total_amount
         - coalesce((select sum(pa.amount) from payment_allocations pa where pa.invoice_id = i.id), 0)
         - coalesce((select sum(cr.amount) from credit_requests cr
                     where cr.invoice_id = i.id and cr.status in ('offset', 'closed')), 0),
         2
       )
  ) then
    raise exception 'payment_request_allocation_invalid' using errcode = 'P0001';
  end if;

  select exists (
    select 1
    from payment_requests pr
    where pr.org_id = v_org
      and pr.supplier_id = p_supplier_id
      and round(pr.amount, 2) = v_amount
      and pr.status in ('draft', 'pending_approval', 'approved', 'sent_for_execution', 'executed', 'matched')
  ) into v_duplicate;

  v_status := case
    when v_duplicate then 'suspected_duplicate'::payment_request_status
    else p_requested_status::payment_request_status
  end;

  perform set_config('app.p1_financial_writer', v_user::text, true);

  insert into payment_requests (
    id, org_id, supplier_id, amount, due_date, status, notes, created_by
  ) values (
    p_request_id, v_org, p_supplier_id, v_amount, p_due_date, v_status, v_notes, v_user
  ) returning * into v_request;

  insert into payment_request_invoices (payment_request_id, invoice_id, amount_allocated)
  select v_request.id, invoice_id, round(amount, 2)
  from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, amount numeric)
  order by invoice_id;

  if v_duplicate then
    insert into exceptions (
      org_id, type, severity, status, title, details,
      supplier_id, payment_request_id, assigned_role
    ) values (
      v_org, 'duplicate_payment', 'high', 'open',
      'חשד לדרישת תשלום כפולה — #' || v_request.number,
      jsonb_build_object('code', 'similar_payment_request'),
      p_supplier_id, v_request.id, 'office'
    );
  end if;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_org, v_user, 'payment_request_created', 'payment_requests', v_request.id,
    jsonb_build_object(
      'status', v_request.status,
      'amount', v_request.amount,
      'invoice_count', v_count
    ),
    v_reason
  );

  return jsonb_build_object(
    'payment_request_id', v_request.id,
    'number', v_request.number,
    'status', v_request.status,
    'amount', v_request.amount,
    'idempotent', false
  );
end
$$;

create or replace function transition_payment_request(
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
  from payment_requests
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
    from invoices i
    join payment_request_invoices pri on pri.invoice_id = i.id
    where pri.payment_request_id = v_request.id
    order by i.id
    for update of i;

    if not exists (
      select 1 from payment_request_invoices pri where pri.payment_request_id = v_request.id
    ) or exists (
      select 1
      from payment_request_invoices pri
      left join invoices i on i.id = pri.invoice_id
      where pri.payment_request_id = v_request.id
        and (
          i.id is null or i.org_id <> v_org or i.supplier_id <> v_request.supplier_id
          or i.deleted_at is not null
          or round(pri.amount_allocated, 2) > round(
            i.total_amount
            - coalesce((select sum(pa.amount) from payment_allocations pa where pa.invoice_id = i.id), 0)
            - coalesce((select sum(cr.amount) from credit_requests cr
                        where cr.invoice_id = i.id and cr.status in ('offset', 'closed')), 0),
            2
          )
        )
    ) then
      raise exception 'payment_request_checks_failed' using errcode = 'P0001';
    end if;
  end if;

  perform set_config('app.p1_financial_writer', v_user::text, true);

  update payment_requests
  set status = v_target,
      approved_by = case when v_target = 'approved' then v_user else approved_by end,
      approved_at = case when v_target = 'approved' then now() else approved_at end
  where id = v_request.id;

  insert into audit_logs (
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

revoke all on function public.create_payment_request(uuid, uuid, date, text, text, jsonb, text) from public;
revoke all on function public.transition_payment_request(uuid, text, text) from public;
grant execute on function public.create_payment_request(uuid, uuid, date, text, text, jsonb, text) to authenticated;
grant execute on function public.transition_payment_request(uuid, text, text) to authenticated;

-- ===== 2. Bank matching and its adjacent state commands =====

create or replace function match_bank_transaction(
  p_bank_transaction_id uuid,
  p_supplier_id uuid,
  p_existing_payment_id uuid,
  p_payment_id uuid,
  p_allocations jsonb,
  p_confidence numeric,
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
  v_tx bank_transactions;
  v_payment payments;
  v_supplier uuid;
  v_reason text := nullif(trim(p_reason), '');
  v_tolerance numeric;
  v_count int := 0;
  v_distinct int := 0;
  v_sum numeric := 0;
  v_input jsonb := '[]'::jsonb;
  v_existing jsonb := '[]'::jsonb;
  v_invoice_ids uuid[] := '{}'::uuid[];
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_bank_transaction_id is null or v_reason is null
     or num_nonnulls(p_existing_payment_id, p_payment_id) <> 1
     or (p_confidence is not null and (p_confidence < 0 or p_confidence > 1)) then
    raise exception 'bank_match_invalid' using errcode = '22023';
  end if;

  if p_payment_id is not null then
    if p_allocations is null or jsonb_typeof(p_allocations) <> 'array' then
      raise exception 'allocation_invalid' using errcode = '22023';
    end if;
    select count(*), count(distinct invoice_id), round(coalesce(sum(amount), 0), 2),
           coalesce(jsonb_agg(
             jsonb_build_object('invoice_id', invoice_id, 'amount', round(amount, 2))
             order by invoice_id
           ), '[]'::jsonb)
      into v_count, v_distinct, v_sum, v_input
    from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, amount numeric);

    if v_count = 0 or v_count <> v_distinct or exists (
      select 1
      from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, amount numeric)
      where invoice_id is null or amount is null or amount <= 0
    ) then
      raise exception 'allocation_invalid' using errcode = '22023';
    end if;
  elsif p_allocations is not null and p_allocations <> '[]'::jsonb then
    raise exception 'bank_match_invalid' using errcode = '22023';
  end if;

  select * into v_tx
  from bank_transactions
  where id = p_bank_transaction_id and org_id = v_org
  for update;

  if not found then
    raise exception 'bank_transaction_unknown' using errcode = 'P0002';
  end if;

  if v_tx.status = 'matched' then
    if p_existing_payment_id is not null and exists (
      select 1
      from bank_allocations ba
      where ba.bank_transaction_id = v_tx.id
        and ba.payment_id = p_existing_payment_id
        and ba.invoice_id is null
        and ba.confirmed
    ) then
      return jsonb_build_object(
        'bank_transaction_id', v_tx.id,
        'payment_id', p_existing_payment_id,
        'status', 'matched',
        'idempotent', true
      );
    end if;

    if p_payment_id is not null and exists (
      select 1 from payments p where p.id = p_payment_id and p.org_id = v_org
    ) then
      select coalesce(jsonb_agg(
        jsonb_build_object('invoice_id', ba.invoice_id, 'amount', round(ba.amount, 2))
        order by ba.invoice_id
      ), '[]'::jsonb)
        into v_existing
      from bank_allocations ba
      where ba.bank_transaction_id = v_tx.id
        and ba.invoice_id is not null
        and ba.payment_id is null
        and ba.confirmed;

      if v_existing is not distinct from v_input then
        return jsonb_build_object(
          'bank_transaction_id', v_tx.id,
          'payment_id', p_payment_id,
          'status', 'matched',
          'idempotent', true
        );
      end if;
    end if;

    raise exception 'bank_transaction_already_matched' using errcode = 'P0001';
  end if;

  if v_tx.status not in ('unmatched', 'suggested') then
    raise exception 'bank_transaction_not_matchable' using errcode = 'P0001';
  end if;

  v_supplier := coalesce(p_supplier_id, v_tx.supplier_id);
  if v_supplier is null or not exists (
    select 1 from suppliers s
    where s.id = v_supplier and s.org_id = v_org and s.deleted_at is null
  ) then
    raise exception 'bank_supplier_invalid' using errcode = '22023';
  end if;

  select coalesce(nullif(o.settings->>'bank_match_amount_tolerance', '')::numeric, 1)
    into v_tolerance
  from organizations o
  where o.id = v_org;

  perform set_config('app.p1_financial_writer', v_user::text, true);

  if p_existing_payment_id is not null then
    select * into v_payment
    from payments
    where id = p_existing_payment_id and org_id = v_org
    for update;

    if not found or v_payment.supplier_id <> v_supplier
       or abs(round(v_payment.amount, 2) - round(v_tx.amount, 2)) > v_tolerance then
      raise exception 'bank_payment_invalid' using errcode = 'P0001';
    end if;
    if exists (
      select 1
      from bank_allocations ba
      join bank_transactions other_tx on other_tx.id = ba.bank_transaction_id
      where ba.payment_id = v_payment.id and ba.confirmed and other_tx.id <> v_tx.id
    ) then
      raise exception 'payment_already_bank_matched' using errcode = 'P0001';
    end if;

    insert into bank_allocations (
      bank_transaction_id, invoice_id, payment_id, amount, confidence, confirmed, created_by
    ) values (
      v_tx.id, null, v_payment.id, round(v_tx.amount, 2), p_confidence, true, v_user
    );

    if v_payment.payment_request_id is not null then
      update payment_requests
      set status = 'matched'
      where id = v_payment.payment_request_id
        and org_id = v_org
        and status = 'executed';
    end if;

    select coalesce(array_agg(distinct pa.invoice_id order by pa.invoice_id), '{}'::uuid[])
      into v_invoice_ids
    from payment_allocations pa
    where pa.payment_id = v_payment.id and pa.invoice_id is not null;
  else
    if abs(v_sum - round(v_tx.amount, 2)) > v_tolerance or v_sum > round(v_tx.amount, 2) then
      raise exception 'bank_allocation_total_mismatch' using errcode = '22023';
    end if;

    perform 1
    from invoices i
    join (
      select distinct invoice_id
      from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, amount numeric)
    ) input on input.invoice_id = i.id
    order by i.id
    for update of i;

    if exists (
      select 1
      from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, amount numeric)
      left join invoices i on i.id = a.invoice_id
      where i.id is null or i.org_id <> v_org or i.supplier_id <> v_supplier
         or i.deleted_at is not null
         or round(a.amount, 2) > round(
           i.total_amount
           - coalesce((select sum(pa.amount) from payment_allocations pa where pa.invoice_id = i.id), 0)
           - coalesce((select sum(cr.amount) from credit_requests cr
                       where cr.invoice_id = i.id and cr.status in ('offset', 'closed')), 0),
           2
         )
    ) then
      raise exception 'allocation_exceeds_balance' using errcode = 'P0001';
    end if;

    if exists (select 1 from payments p where p.id = p_payment_id) then
      raise exception 'bank_payment_idempotency_conflict' using errcode = 'P0001';
    end if;

    insert into payments (
      id, org_id, supplier_id, amount, paid_date, method,
      reference, executed_by, notes
    ) values (
      p_payment_id, v_org, v_supplier, round(v_tx.amount, 2), v_tx.tx_date,
      'העברה בנקאית', v_tx.reference, v_user,
      'נוצר מהתאמת תנועת בנק'
    ) returning * into v_payment;

    insert into payment_allocations (payment_id, invoice_id, amount)
    select v_payment.id, invoice_id, round(amount, 2)
    from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, amount numeric)
    order by invoice_id;

    -- A direct invoice match points the bank allocation at the invoice. The payment link is
    -- represented separately in payment_allocations; each junction therefore has one target.
    insert into bank_allocations (
      bank_transaction_id, invoice_id, payment_id, amount, confidence, confirmed, created_by
    )
    select v_tx.id, invoice_id, null, round(amount, 2), p_confidence, true, v_user
    from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, amount numeric)
    order by invoice_id;

    select coalesce(array_agg(distinct invoice_id order by invoice_id), '{}'::uuid[])
      into v_invoice_ids
    from jsonb_to_recordset(p_allocations) as a(invoice_id uuid, amount numeric);
  end if;

  update bank_transactions
  set status = 'matched', supplier_id = v_supplier
  where id = v_tx.id;

  perform p1_refresh_invoice_payment_statuses(v_org, v_invoice_ids);

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_user, 'bank_match_confirmed', 'bank_transactions', v_tx.id,
    jsonb_build_object('status', v_tx.status, 'supplier_id', v_tx.supplier_id),
    jsonb_build_object(
      'status', 'matched',
      'supplier_id', v_supplier,
      'payment_id', v_payment.id,
      'confidence', p_confidence
    ),
    v_reason
  );

  return jsonb_build_object(
    'bank_transaction_id', v_tx.id,
    'payment_id', v_payment.id,
    'status', 'matched',
    'invoice_ids', to_jsonb(v_invoice_ids),
    'idempotent', false
  );
end
$$;

create or replace function assign_bank_transaction_supplier(
  p_bank_transaction_id uuid,
  p_supplier_id uuid,
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
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_reason is null or (p_supplier_id is not null and not exists (
    select 1 from suppliers s
    where s.id = p_supplier_id and s.org_id = v_org and s.deleted_at is null
  )) then
    raise exception 'bank_supplier_invalid' using errcode = '22023';
  end if;

  select * into v_tx from bank_transactions
  where id = p_bank_transaction_id and org_id = v_org for update;
  if not found then raise exception 'bank_transaction_unknown' using errcode = 'P0002'; end if;
  if v_tx.status not in ('unmatched', 'suggested') then
    raise exception 'bank_transaction_not_matchable' using errcode = 'P0001';
  end if;
  if v_tx.supplier_id = p_supplier_id then
    return jsonb_build_object('bank_transaction_id', v_tx.id, 'supplier_id', p_supplier_id, 'idempotent', true);
  end if;

  perform set_config('app.p1_financial_writer', v_user::text, true);
  update bank_transactions set supplier_id = p_supplier_id where id = v_tx.id;
  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason)
  values (v_org, v_user, 'bank_supplier_assigned', 'bank_transactions', v_tx.id,
          jsonb_build_object('supplier_id', v_tx.supplier_id),
          jsonb_build_object('supplier_id', p_supplier_id), v_reason);
  return jsonb_build_object('bank_transaction_id', v_tx.id, 'supplier_id', p_supplier_id, 'idempotent', false);
end
$$;

create or replace function ignore_bank_transaction(
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
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_reason is null then raise exception 'reason_required' using errcode = '22023'; end if;
  select * into v_tx from bank_transactions
  where id = p_bank_transaction_id and org_id = v_org for update;
  if not found then raise exception 'bank_transaction_unknown' using errcode = 'P0002'; end if;
  if v_tx.status = 'ignored' then
    return jsonb_build_object('bank_transaction_id', v_tx.id, 'status', 'ignored', 'idempotent', true);
  end if;
  if v_tx.status not in ('unmatched', 'suggested') then
    raise exception 'bank_transaction_not_ignorable' using errcode = 'P0001';
  end if;
  perform set_config('app.p1_financial_writer', v_user::text, true);
  update bank_transactions set status = 'ignored' where id = v_tx.id;
  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason)
  values (v_org, v_user, 'bank_transaction_ignored', 'bank_transactions', v_tx.id,
          jsonb_build_object('status', v_tx.status), jsonb_build_object('status', 'ignored'), v_reason);
  return jsonb_build_object('bank_transaction_id', v_tx.id, 'status', 'ignored', 'idempotent', false);
end
$$;

create or replace function open_bank_transaction_exception(
  p_bank_transaction_id uuid,
  p_supplier_id uuid,
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
  v_exception_id uuid;
  v_supplier uuid;
  v_reason text := nullif(trim(p_reason), '');
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_reason is null then raise exception 'reason_required' using errcode = '22023'; end if;
  select * into v_tx from bank_transactions
  where id = p_bank_transaction_id and org_id = v_org for update;
  if not found then raise exception 'bank_transaction_unknown' using errcode = 'P0002'; end if;
  if v_tx.status not in ('unmatched', 'suggested') then
    raise exception 'bank_transaction_not_matchable' using errcode = 'P0001';
  end if;
  v_supplier := coalesce(p_supplier_id, v_tx.supplier_id);
  if v_supplier is not null and not exists (
    select 1 from suppliers s where s.id = v_supplier and s.org_id = v_org and s.deleted_at is null
  ) then
    raise exception 'bank_supplier_invalid' using errcode = '22023';
  end if;

  select e.id into v_exception_id
  from exceptions e
  where e.org_id = v_org and e.bank_transaction_id = v_tx.id
    and e.status in ('open', 'in_progress')
  order by e.created_at
  limit 1
  for update;
  if found then
    return jsonb_build_object('exception_id', v_exception_id, 'bank_transaction_id', v_tx.id, 'idempotent', true);
  end if;

  insert into exceptions (
    org_id, type, severity, status, title, details,
    supplier_id, bank_transaction_id, assigned_role
  ) values (
    v_org,
    case when v_supplier is null then 'unknown_supplier'::exception_type else 'payment_without_invoice'::exception_type end,
    'medium', 'open',
    case when v_supplier is null then 'העברה לגורם לא מזוהה' else 'תשלום ללא חשבונית' end,
    jsonb_build_object('date', v_tx.tx_date, 'amount', v_tx.amount),
    v_supplier, v_tx.id, 'office'
  ) returning id into v_exception_id;

  insert into audit_logs (org_id, user_id, action, entity_type, entity_id, new_values, reason)
  values (v_org, v_user, 'bank_exception_opened', 'bank_transactions', v_tx.id,
          jsonb_build_object('exception_id', v_exception_id), v_reason);
  return jsonb_build_object('exception_id', v_exception_id, 'bank_transaction_id', v_tx.id, 'idempotent', false);
end
$$;

revoke all on function public.match_bank_transaction(uuid, uuid, uuid, uuid, jsonb, numeric, text) from public;
revoke all on function public.assign_bank_transaction_supplier(uuid, uuid, text) from public;
revoke all on function public.ignore_bank_transaction(uuid, text) from public;
revoke all on function public.open_bank_transaction_exception(uuid, uuid, text) from public;
grant execute on function public.match_bank_transaction(uuid, uuid, uuid, uuid, jsonb, numeric, text) to authenticated;
grant execute on function public.assign_bank_transaction_supplier(uuid, uuid, text) to authenticated;
grant execute on function public.ignore_bank_transaction(uuid, text) to authenticated;
grant execute on function public.open_bank_transaction_exception(uuid, uuid, text) to authenticated;

-- ===== 7. Atomic, retry-safe bank import =====

create or replace function import_bank_transactions(
  p_filename text,
  p_file_hash text,
  p_column_mapping jsonb,
  p_rows jsonb,
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
  v_import bank_imports;
  v_filename text := nullif(trim(p_filename), '');
  v_file_hash text := lower(nullif(trim(p_file_hash), ''));
  v_reason text := nullif(trim(p_reason), '');
  v_count int;
  v_distinct int;
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_filename is null or v_file_hash is null or v_file_hash !~ '^[0-9a-f]{64}$'
     or v_reason is null or p_column_mapping is null
     or jsonb_typeof(p_column_mapping) <> 'object'
     or p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'bank_import_invalid' using errcode = '22023';
  end if;

  -- One import per organization at a time makes both file and row replay checks race-free.
  perform 1 from organizations where id = v_org for update;

  select * into v_import
  from bank_imports
  where org_id = v_org and file_hash = v_file_hash
  for update;

  if found then
    return jsonb_build_object(
      'import_id', v_import.id,
      'row_count', v_import.row_count,
      'idempotent', true
    );
  end if;

  select count(*), count(distinct row_hash)
    into v_count, v_distinct
  from jsonb_to_recordset(p_rows) as r(
    tx_date date,
    description text,
    amount numeric,
    is_debit boolean,
    reference text,
    raw jsonb,
    supplier_id uuid,
    row_hash text
  );

  if v_count = 0 or v_count <> v_distinct or exists (
    select 1
    from jsonb_to_recordset(p_rows) as r(
      tx_date date,
      description text,
      amount numeric,
      is_debit boolean,
      reference text,
      raw jsonb,
      supplier_id uuid,
      row_hash text
    )
    where tx_date is null or nullif(trim(description), '') is null
       or amount is null or amount <= 0 or is_debit is null or raw is null
       or nullif(trim(row_hash), '') is null or lower(trim(row_hash)) !~ '^[0-9a-f]{64}$'
       or (supplier_id is not null and not exists (
         select 1 from suppliers s
         where s.id = r.supplier_id and s.org_id = v_org and s.deleted_at is null
       ))
  ) then
    raise exception 'bank_import_invalid_rows' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_rows) as r(
      tx_date date,
      description text,
      amount numeric,
      is_debit boolean,
      reference text,
      raw jsonb,
      supplier_id uuid,
      row_hash text
    )
    join bank_transactions bt
      on bt.org_id = v_org and bt.row_hash = lower(trim(r.row_hash))
  ) then
    raise exception 'bank_row_replayed' using errcode = '23505';
  end if;

  perform set_config('app.p1_financial_writer', v_user::text, true);

  insert into bank_imports (
    org_id, filename, file_hash, column_mapping, row_count, imported_by
  ) values (
    v_org, v_filename, v_file_hash, p_column_mapping, v_count, v_user
  ) returning * into v_import;

  insert into bank_transactions (
    org_id, import_id, tx_date, description, amount, is_debit,
    reference, raw, supplier_id, status, row_hash
  )
  select
    v_org,
    v_import.id,
    tx_date,
    trim(description),
    round(amount, 2),
    is_debit,
    nullif(trim(reference), ''),
    raw,
    supplier_id,
    'unmatched',
    lower(trim(row_hash))
  from jsonb_to_recordset(p_rows) as r(
    tx_date date,
    description text,
    amount numeric,
    is_debit boolean,
    reference text,
    raw jsonb,
    supplier_id uuid,
    row_hash text
  )
  order by tx_date, row_hash;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_org, v_user, 'bank_import_created', 'bank_imports', v_import.id,
    jsonb_build_object('file_hash', v_file_hash, 'row_count', v_count),
    v_reason
  );

  return jsonb_build_object(
    'import_id', v_import.id,
    'row_count', v_count,
    'idempotent', false
  );
end
$$;

revoke all on function public.import_bank_transactions(text, text, jsonb, jsonb, text) from public;
grant execute on function public.import_bank_transactions(text, text, jsonb, jsonb, text) to authenticated;

-- ===== 3. Save/complete a goods receipt =====

create or replace function save_goods_receipt(
  p_order_id uuid,
  p_receipt_id uuid,
  p_complete boolean,
  p_notes text,
  p_open_credits boolean,
  p_lines jsonb,
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
  v_order purchase_orders;
  v_receipt goods_receipts;
  v_reason text := nullif(trim(p_reason), '');
  v_notes text := nullif(trim(p_notes), '');
  v_input_count int;
  v_distinct_count int;
  v_order_count int;
  v_input jsonb;
  v_existing jsonb;
  v_credit_count int := 0;
  v_status po_status;
  v_receipt_existed boolean := false;
  v_completion_metadata_found boolean := false;
  v_open_credits_recorded boolean;
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office', 'kitchen') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_order_id is null or p_receipt_id is null or p_complete is null
     or p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'goods_receipt_invalid' using errcode = '22023';
  end if;
  if p_complete and v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  v_reason := coalesce(v_reason, 'שמירת טיוטת קבלה');

  select * into v_order
  from purchase_orders
  where id = p_order_id and org_id = v_org
  for update;

  if not found then raise exception 'purchase_order_unknown' using errcode = 'P0002'; end if;
  if v_order.status not in ('sent', 'confirmed', 'partial', 'received') then
    raise exception 'purchase_order_not_receivable' using errcode = 'P0001';
  end if;

  perform 1
  from purchase_order_items poi
  where poi.order_id = v_order.id
  order by poi.id
  for update;

  select count(*) into v_order_count
  from purchase_order_items where order_id = v_order.id;

  select count(*), count(distinct order_item_id),
         coalesce(jsonb_agg(
           jsonb_build_object(
             'order_item_id', order_item_id,
             'qty_received', round(qty_received, 2),
             'status', status,
             'notes', nullif(trim(notes), '')
           ) order by order_item_id
         ), '[]'::jsonb)
    into v_input_count, v_distinct_count, v_input
  from jsonb_to_recordset(p_lines) as line(
    order_item_id uuid,
    qty_received numeric,
    status receipt_line_status,
    notes text
  );

  -- A completed receipt is checked against its stored payload before validating against the
  -- now-reduced remaining quantities. This is what makes a lost-response retry observable as
  -- the same command instead of a false over-receipt.
  select * into v_receipt
  from goods_receipts
  where id = p_receipt_id and org_id = v_org
  for update;
  v_receipt_existed := found;

  if v_receipt_existed and v_receipt.order_id <> v_order.id then
    raise exception 'receipt_idempotency_conflict' using errcode = 'P0001';
  end if;

  if v_receipt_existed then
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'order_item_id', gri.order_item_id,
        'qty_received', round(gri.qty_received, 2),
        'status', gri.status,
        'notes', nullif(trim(gri.notes), '')
      ) order by gri.order_item_id
    ), '[]'::jsonb)
      into v_existing
    from goods_receipt_items gri
    where gri.receipt_id = v_receipt.id;
  end if;

  if v_receipt_existed and v_receipt.status = 'completed' then
    if not p_complete then
      raise exception 'receipt_already_completed' using errcode = 'P0001';
    end if;
    if v_receipt.notes is distinct from v_notes or v_existing is distinct from v_input then
      raise exception 'receipt_idempotency_conflict' using errcode = 'P0001';
    end if;
    select (al.new_values->>'open_credits')::boolean
      into v_open_credits_recorded
    from audit_logs al
    where al.entity_type = 'goods_receipts'
      and al.entity_id = v_receipt.id
      and al.action = 'goods_receipt_completed'
    order by al.created_at desc, al.id desc
    limit 1;
    v_completion_metadata_found := found;
    if not v_completion_metadata_found
       or v_open_credits_recorded is distinct from coalesce(p_open_credits, false) then
      raise exception 'receipt_idempotency_conflict' using errcode = 'P0001';
    end if;
    select count(*) into v_credit_count
    from credit_requests cr
    join goods_receipt_items gri on gri.id = cr.receipt_item_id
    where gri.receipt_id = v_receipt.id;
    return jsonb_build_object(
      'receipt_id', v_receipt.id,
      'status', v_receipt.status,
      'order_status', v_order.status,
      'credit_count', v_credit_count,
      'idempotent', true
    );
  end if;

  if v_input_count = 0 or v_input_count <> v_distinct_count
     or v_input_count <> v_order_count or exists (
    select 1
    from jsonb_to_recordset(p_lines) as line(
      order_item_id uuid,
      qty_received numeric,
      status receipt_line_status,
      notes text
    )
    left join purchase_order_items poi
      on poi.id = line.order_item_id and poi.order_id = v_order.id
    where poi.id is null or line.qty_received is null or line.qty_received < 0
       or line.qty_received > (poi.qty - poi.received_qty)
       or (line.status = 'full' and round(line.qty_received, 2) <> round(poi.qty - poi.received_qty, 2))
       or (line.status = 'partial' and (
         line.qty_received <= 0 or line.qty_received >= (poi.qty - poi.received_qty)
       ))
       or (line.status = 'missing' and line.qty_received <> 0)
  ) then
    raise exception 'receipt_qty_exceeds_order' using errcode = '22023';
  end if;

  if not v_receipt_existed and exists (
    select 1 from goods_receipts gr
    where gr.org_id = v_org and gr.order_id = v_order.id
      and gr.status = 'draft' and gr.id <> p_receipt_id
  ) then
    raise exception 'receipt_draft_conflict' using errcode = 'P0001';
  end if;

  if v_receipt_existed and not p_complete then
    if v_receipt.notes is not distinct from v_notes and v_existing is not distinct from v_input then
      return jsonb_build_object(
        'receipt_id', v_receipt.id,
        'status', v_receipt.status,
        'order_status', v_order.status,
        'credit_count', 0,
        'idempotent', true
      );
    end if;
  end if;

  perform set_config('app.p1_financial_writer', v_user::text, true);

  if not v_receipt_existed then
    insert into goods_receipts (
      id, org_id, order_id, status, received_by, notes
    ) values (
      p_receipt_id, v_org, v_order.id, 'draft', v_user, v_notes
    ) returning * into v_receipt;
  else
    update goods_receipts
    set received_by = v_user, notes = v_notes
    where id = v_receipt.id;
  end if;

  delete from goods_receipt_items where receipt_id = v_receipt.id;
  insert into goods_receipt_items (
    receipt_id, order_item_id, product_id, qty_received, status, notes
  )
  select
    v_receipt.id,
    line.order_item_id,
    poi.product_id,
    round(line.qty_received, 2),
    line.status,
    nullif(trim(line.notes), '')
  from jsonb_to_recordset(p_lines) as line(
    order_item_id uuid,
    qty_received numeric,
    status receipt_line_status,
    notes text
  )
  join purchase_order_items poi on poi.id = line.order_item_id and poi.order_id = v_order.id
  order by line.order_item_id;

  if p_complete then
    -- Damaged/returned quantities were physically seen, but are not usable delivery. They do
    -- not increment received_qty. Their financial treatment remains a documented open decision.
    update purchase_order_items poi
    set received_qty = round(
      poi.received_qty + case
        when line.status in ('full', 'partial') then line.qty_received
        else 0
      end,
      2
    )
    from jsonb_to_recordset(p_lines) as line(
      order_item_id uuid,
      qty_received numeric,
      status receipt_line_status,
      notes text
    )
    where poi.id = line.order_item_id and poi.order_id = v_order.id;

    select case
      when exists (
        select 1 from purchase_order_items poi
        where poi.order_id = v_order.id and poi.received_qty < poi.qty
      ) then 'partial'::po_status
      else 'received'::po_status
    end into v_status;

    update purchase_orders set status = v_status where id = v_order.id;

    if coalesce(p_open_credits, false) then
      insert into credit_requests (
        org_id, supplier_id, receipt_item_id, reason, amount,
        status, notes, created_by
      )
      select
        v_org,
        v_order.supplier_id,
        gri.id,
        'missing',
        round((poi.qty - old_received - line.qty_received) * poi.unit_price, 2),
        'open',
        'חוסר כמות בקבלה #' || v_receipt.number
          || coalesce(' — ' || nullif(trim(line.notes), ''), ''),
        v_user
      from jsonb_to_recordset(p_lines) as line(
        order_item_id uuid,
        qty_received numeric,
        status receipt_line_status,
        notes text
      )
      join purchase_order_items poi on poi.id = line.order_item_id and poi.order_id = v_order.id
      join goods_receipt_items gri
        on gri.receipt_id = v_receipt.id and gri.order_item_id = line.order_item_id
      cross join lateral (
        select poi.received_qty - case
          when line.status in ('full', 'partial') then line.qty_received else 0
        end as old_received
      ) previous
      where line.status in ('missing', 'partial')
        and round((poi.qty - old_received - line.qty_received) * poi.unit_price, 2) > 0;
      get diagnostics v_credit_count = row_count;
    end if;

    update goods_receipts
    set status = 'completed', received_by = v_user, received_at = now(), notes = v_notes
    where id = v_receipt.id;
  else
    v_status := v_order.status;
  end if;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_user,
    case when p_complete then 'goods_receipt_completed' else 'goods_receipt_draft_saved' end,
    'goods_receipts', v_receipt.id,
    case when v_receipt_existed then jsonb_build_object('status', v_receipt.status) else null end,
    jsonb_build_object(
      'status', case when p_complete then 'completed' else 'draft' end,
      'order_status', v_status,
      'credit_count', v_credit_count,
      'open_credits', coalesce(p_open_credits, false)
    ),
    v_reason
  );

  return jsonb_build_object(
    'receipt_id', v_receipt.id,
    'status', case when p_complete then 'completed' else 'draft' end,
    'order_status', v_status,
    'credit_count', v_credit_count,
    'idempotent', false
  );
end
$$;

revoke all on function public.save_goods_receipt(uuid, uuid, boolean, text, boolean, jsonb, text) from public;
grant execute on function public.save_goods_receipt(uuid, uuid, boolean, text, boolean, jsonb, text) to authenticated;

-- ===== 4. Invoice creation and review transitions =====

create or replace function create_invoice(
  p_invoice_id uuid,
  p_supplier_id uuid,
  p_invoice_number text,
  p_invoice_date date,
  p_amount_before_vat numeric,
  p_vat_amount numeric,
  p_total_amount numeric,
  p_notes text,
  p_order_id uuid,
  p_receipt_id uuid,
  p_override_reason text,
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
  v_invoice invoices;
  v_order purchase_orders;
  v_receipt goods_receipts;
  v_reason text := nullif(trim(p_reason), '');
  v_override_reason text := nullif(trim(p_override_reason), '');
  v_number text := nullif(trim(p_invoice_number), '');
  v_notes text := nullif(trim(p_notes), '');
  v_before numeric := round(coalesce(p_amount_before_vat, 0), 2);
  v_vat numeric := round(coalesce(p_vat_amount, 0), 2);
  v_total numeric := round(p_total_amount, 2);
  v_duplicate boolean := false;
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office', 'kitchen') then
    raise exception 'invoice_create_not_authorized' using errcode = '42501';
  end if;
  if p_invoice_id is null or p_supplier_id is null or v_number is null
     or p_invoice_date is null or p_total_amount is null or v_reason is null then
    raise exception 'invoice_fields_required' using errcode = '22023';
  end if;
  if v_before < 0 or v_vat < 0 or v_total < 0
     or round(v_before + v_vat, 2) <> v_total then
    raise exception 'invoice_amounts_invalid' using errcode = '22023';
  end if;

  -- The supplier row serializes duplicate-number checks without inventing a uniqueness rule
  -- that the business has not approved.
  perform 1
  from suppliers s
  where s.id = p_supplier_id and s.org_id = v_org and s.deleted_at is null
  for update;
  if not found then
    raise exception 'invoice_supplier_invalid' using errcode = 'P0002';
  end if;

  select * into v_invoice
  from invoices i
  where i.id = p_invoice_id and i.org_id = v_org
  for update;

  if found then
    if v_invoice.supplier_id <> p_supplier_id
       or v_invoice.invoice_number <> v_number
       or v_invoice.invoice_date <> p_invoice_date
       or round(v_invoice.amount_before_vat, 2) <> v_before
       or round(v_invoice.vat_amount, 2) <> v_vat
       or round(v_invoice.total_amount, 2) <> v_total
       or v_invoice.notes is distinct from v_notes
       or (select count(*) from invoice_order_links iol where iol.invoice_id = v_invoice.id)
          <> (case when p_order_id is null then 0 else 1 end)
       or (p_order_id is not null and not exists (
         select 1 from invoice_order_links iol
         where iol.invoice_id = v_invoice.id and iol.order_id = p_order_id
       ))
       or (select count(*) from invoice_receipt_links irl where irl.invoice_id = v_invoice.id)
          <> (case when p_receipt_id is null then 0 else 1 end)
       or (p_receipt_id is not null and not exists (
         select 1 from invoice_receipt_links irl
         where irl.invoice_id = v_invoice.id and irl.receipt_id = p_receipt_id
       )) then
      raise exception 'invoice_idempotency_conflict' using errcode = 'P0001';
    end if;

    return jsonb_build_object(
      'invoice_id', v_invoice.id,
      'review_status', v_invoice.review_status,
      'duplicate_detected', v_invoice.review_status = 'investigation',
      'idempotent', true
    );
  end if;

  if p_order_id is not null then
    select * into v_order
    from purchase_orders po
    where po.id = p_order_id and po.org_id = v_org
    for update;
    if not found or v_order.supplier_id <> p_supplier_id then
      raise exception 'invoice_order_invalid' using errcode = '22023';
    end if;
  end if;

  if p_receipt_id is not null then
    select gr.* into v_receipt
    from goods_receipts gr
    join purchase_orders po on po.id = gr.order_id
    where gr.id = p_receipt_id and gr.org_id = v_org
      and po.org_id = v_org and po.supplier_id = p_supplier_id
    for update of gr;
    if not found or (p_order_id is not null and v_receipt.order_id <> p_order_id) then
      raise exception 'invoice_receipt_invalid' using errcode = '22023';
    end if;
  end if;

  select exists (
    select 1
    from invoices i
    where i.org_id = v_org
      and i.supplier_id = p_supplier_id
      and i.invoice_number = v_number
      and i.deleted_at is null
  ) into v_duplicate;

  perform set_config('app.p1_financial_writer', v_user::text, true);

  insert into invoices (
    id, org_id, supplier_id, invoice_number, invoice_date, received_date,
    received_by, amount_before_vat, vat_amount, total_amount, review_status, notes
  ) values (
    p_invoice_id, v_org, p_supplier_id, v_number, p_invoice_date, current_date,
    v_user, v_before, v_vat, v_total,
    case when v_duplicate and v_override_reason is null
      then 'investigation'::invoice_review_status
      else 'received'::invoice_review_status
    end,
    v_notes
  ) returning * into v_invoice;

  if p_order_id is not null then
    insert into invoice_order_links (invoice_id, order_id)
    values (v_invoice.id, p_order_id);
  end if;
  if p_receipt_id is not null then
    insert into invoice_receipt_links (invoice_id, receipt_id)
    values (v_invoice.id, p_receipt_id);
  end if;

  if v_duplicate and v_override_reason is null then
    insert into exceptions (
      org_id, type, severity, status, title, details,
      supplier_id, invoice_id, assigned_role
    ) values (
      v_org, 'duplicate_invoice', 'high', 'open',
      'חשד לחשבונית כפולה — מס׳ ' || v_number,
      jsonb_build_object('code', 'duplicate_number'),
      p_supplier_id, v_invoice.id, 'office'
    );
  end if;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org,
    v_user,
    case
      when v_duplicate and v_override_reason is not null then 'invoice_duplicate_overridden'
      else 'invoice_created'
    end,
    'invoices',
    v_invoice.id,
    null,
    jsonb_build_object(
      'supplier_id', p_supplier_id,
      'invoice_number', v_number,
      'total_amount', v_total,
      'review_status', v_invoice.review_status,
      'duplicate_detected', v_duplicate,
      'override_reason', v_override_reason
    ),
    case
      when v_duplicate and v_override_reason is not null
        then v_reason || ' — ' || v_override_reason
      else v_reason
    end
  );

  return jsonb_build_object(
    'invoice_id', v_invoice.id,
    'review_status', v_invoice.review_status,
    'duplicate_detected', v_duplicate,
    'idempotent', false
  );
end
$$;

revoke all on function public.create_invoice(
  uuid, uuid, text, date, numeric, numeric, numeric, text, uuid, uuid, text, text
) from public;
grant execute on function public.create_invoice(
  uuid, uuid, text, date, numeric, numeric, numeric, text, uuid, uuid, text, text
) to authenticated;

create or replace function set_invoice_review_status(
  p_invoice_id uuid,
  p_status invoice_review_status,
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
  v_invoice invoices;
  v_reason text := nullif(trim(p_reason), '');
  v_allowed boolean := false;
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office') then
    raise exception 'invoice_review_not_authorized' using errcode = '42501';
  end if;
  if p_invoice_id is null or p_status is null or v_reason is null then
    raise exception 'invoice_review_fields_required' using errcode = '22023';
  end if;

  select * into v_invoice
  from invoices i
  where i.id = p_invoice_id and i.org_id = v_org and i.deleted_at is null
  for update;
  if not found then
    raise exception 'invoice_not_found' using errcode = 'P0002';
  end if;

  if v_invoice.review_status = p_status then
    return jsonb_build_object(
      'invoice_id', v_invoice.id,
      'review_status', v_invoice.review_status,
      'idempotent', true
    );
  end if;

  v_allowed :=
    (v_invoice.review_status = 'received' and p_status = 'in_review')
    or (v_invoice.review_status = 'in_review' and p_status in ('pending_approval', 'approved'))
    or (v_invoice.review_status = 'pending_approval' and p_status = 'approved')
    or (v_invoice.review_status = 'investigation' and p_status = 'pending_approval')
    or (p_status = 'investigation' and v_invoice.review_status <> 'investigation');

  if not v_allowed then
    raise exception 'invoice_review_transition_invalid' using errcode = 'P0001';
  end if;

  perform set_config('app.p1_financial_writer', v_user::text, true);
  update invoices
  set review_status = p_status
  where id = v_invoice.id;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_user, 'invoice_review_status_changed', 'invoices', v_invoice.id,
    jsonb_build_object('review_status', v_invoice.review_status),
    jsonb_build_object('review_status', p_status),
    v_reason
  );

  return jsonb_build_object(
    'invoice_id', v_invoice.id,
    'review_status', p_status,
    'idempotent', false
  );
end
$$;

revoke all on function public.set_invoice_review_status(uuid, invoice_review_status, text) from public;
grant execute on function public.set_invoice_review_status(uuid, invoice_review_status, text) to authenticated;

-- ===== 4a. Invoice-linked credit commands =====

create or replace function create_invoice_credit_request(
  p_credit_request_id uuid,
  p_invoice_id uuid,
  p_reason credit_reason,
  p_amount numeric,
  p_notes text,
  p_audit_reason text
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
  v_invoice invoices;
  v_credit credit_requests;
  v_amount numeric := round(p_amount, 2);
  v_notes text := nullif(trim(p_notes), '');
  v_audit_reason text := nullif(trim(p_audit_reason), '');
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office', 'kitchen') then
    raise exception 'credit_request_create_not_authorized' using errcode = '42501';
  end if;
  if p_credit_request_id is null or p_invoice_id is null or p_reason is null
     or p_amount is null or v_audit_reason is null then
    raise exception 'credit_request_fields_required' using errcode = '22023';
  end if;
  if v_amount <= 0 then
    raise exception 'credit_request_amount_invalid' using errcode = '22023';
  end if;

  -- Invoice-first locking matches payment execution and credit transitions.
  select * into v_invoice
  from invoices i
  where i.id = p_invoice_id and i.org_id = v_org and i.deleted_at is null
  for update;
  if not found then
    raise exception 'credit_request_invoice_unknown' using errcode = 'P0002';
  end if;

  select * into v_credit
  from credit_requests c
  where c.id = p_credit_request_id
  for update;

  if found then
    if v_credit.org_id <> v_org
       or v_credit.invoice_id is distinct from v_invoice.id
       or v_credit.receipt_item_id is not null
       or v_credit.supplier_id <> v_invoice.supplier_id
       or v_credit.reason <> p_reason
       or round(v_credit.amount, 2) <> v_amount
       or v_credit.notes is distinct from v_notes
       or v_credit.created_by is distinct from v_user then
      raise exception 'credit_request_idempotency_conflict' using errcode = 'P0001';
    end if;

    return jsonb_build_object(
      'credit_request_id', v_credit.id,
      'status', v_credit.status,
      'idempotent', true
    );
  end if;

  perform set_config('app.p1_financial_writer', v_user::text, true);

  insert into credit_requests (
    id, org_id, supplier_id, invoice_id, reason, amount,
    status, notes, created_by
  ) values (
    p_credit_request_id, v_org, v_invoice.supplier_id, v_invoice.id, p_reason, v_amount,
    'open', v_notes, v_user
  ) returning * into v_credit;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    v_org, v_user, 'invoice_credit_requested', 'credit_requests', v_credit.id,
    jsonb_build_object(
      'invoice_id', v_invoice.id,
      'supplier_id', v_invoice.supplier_id,
      'credit_reason', p_reason,
      'amount', v_amount,
      'status', v_credit.status
    ),
    v_audit_reason
  );

  return jsonb_build_object(
    'credit_request_id', v_credit.id,
    'status', v_credit.status,
    'idempotent', false
  );
end
$$;

create or replace function transition_credit_request(
  p_credit_request_id uuid,
  p_status credit_status,
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
  v_credit credit_requests;
  v_invoice_id uuid;
  v_reason text := nullif(trim(p_reason), '');
  v_allowed boolean := false;
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office', 'kitchen') then
    raise exception 'credit_request_transition_not_authorized' using errcode = '42501';
  end if;
  if p_credit_request_id is null or p_status is null or v_reason is null then
    raise exception 'credit_request_transition_fields_required' using errcode = '22023';
  end if;

  select c.invoice_id into v_invoice_id
  from credit_requests c
  where c.id = p_credit_request_id and c.org_id = v_org;
  if not found then
    raise exception 'credit_request_unknown' using errcode = 'P0002';
  end if;

  -- Payment execution locks invoices before credits. Use the same order to avoid a cycle.
  if v_invoice_id is not null then
    perform 1
    from invoices i
    where i.id = v_invoice_id and i.org_id = v_org
    for update;
    if not found then
      raise exception 'credit_request_invoice_unknown' using errcode = 'P0002';
    end if;
  end if;

  select * into v_credit
  from credit_requests c
  where c.id = p_credit_request_id and c.org_id = v_org
  for update;
  if not found or v_credit.invoice_id is distinct from v_invoice_id then
    raise exception 'credit_request_concurrent_change' using errcode = '40001';
  end if;

  if v_credit.status = p_status then
    return jsonb_build_object(
      'credit_request_id', v_credit.id,
      'status', v_credit.status,
      'idempotent', true
    );
  end if;

  v_allowed :=
    (v_credit.status = 'open' and p_status in ('requested', 'received'))
    or (v_credit.status = 'requested' and p_status = 'received')
    or (v_credit.status = 'received' and p_status in ('offset', 'closed'))
    or (v_credit.status = 'offset' and p_status = 'closed');

  if not v_allowed then
    raise exception 'credit_request_transition_invalid' using errcode = 'P0001';
  end if;

  perform set_config('app.p1_financial_writer', v_user::text, true);

  update credit_requests
  set status = p_status,
      resolved_at = case when p_status in ('received', 'offset', 'closed') then now() else null end
  where id = v_credit.id;

  if v_invoice_id is not null
     and (v_credit.status in ('offset', 'closed') or p_status in ('offset', 'closed')) then
    perform p1_refresh_invoice_payment_statuses(v_org, array[v_invoice_id]);
  end if;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_user, 'credit_request_transitioned', 'credit_requests', v_credit.id,
    jsonb_build_object('status', v_credit.status),
    jsonb_build_object('status', p_status),
    v_reason
  );

  return jsonb_build_object(
    'credit_request_id', v_credit.id,
    'status', p_status,
    'idempotent', false
  );
end
$$;

revoke all on function public.create_invoice_credit_request(
  uuid, uuid, credit_reason, numeric, text, text
) from public;
grant execute on function public.create_invoice_credit_request(
  uuid, uuid, credit_reason, numeric, text, text
) to authenticated;
revoke all on function public.transition_credit_request(uuid, credit_status, text) from public;
grant execute on function public.transition_credit_request(uuid, credit_status, text) to authenticated;

-- ===== 6. Supplier price commands =====

create or replace function set_supplier_product_price(
  p_supplier_product_id uuid,
  p_price numeric,
  p_effective_date date,
  p_available boolean,
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
  v_supplier uuid := auth_supplier();
  v_row supplier_products;
  v_reason text := nullif(trim(p_reason), '');
  v_price numeric := round(p_price, 2);
  v_price_changed boolean;
  v_history_changed boolean;
begin
  if v_org is null or v_user is null
     or v_role not in ('owner', 'office', 'supplier') then
    raise exception 'price_write_not_authorized' using errcode = '42501';
  end if;
  if p_supplier_product_id is null or p_price is null or p_effective_date is null
     or p_available is null or v_reason is null or v_price <= 0 or v_price > 1000000 then
    raise exception 'price_values_invalid' using errcode = '22023';
  end if;

  select * into v_row
  from supplier_products sp
  where sp.id = p_supplier_product_id and sp.org_id = v_org
  for update;
  if not found then
    raise exception 'supplier_product_not_found' using errcode = 'P0002';
  end if;
  if v_role = 'supplier' and (v_supplier is null or v_row.supplier_id <> v_supplier) then
    raise exception 'price_write_not_authorized' using errcode = '42501';
  end if;

  v_price_changed := round(v_row.current_price, 2) <> v_price;
  v_history_changed := v_price_changed or v_row.price_effective_date <> p_effective_date;
  if not v_price_changed
     and v_row.price_effective_date = p_effective_date
     and v_row.available = p_available then
    return jsonb_build_object(
      'supplier_product_id', v_row.id,
      'price', v_row.current_price,
      'available', v_row.available,
      'price_changed', false,
      'idempotent', true
    );
  end if;

  perform set_config('app.p1_financial_writer', v_user::text, true);
  update supplier_products
  set current_price = v_price,
      previous_price = case when v_price_changed then v_row.current_price else v_row.previous_price end,
      price_effective_date = p_effective_date,
      available = p_available
  where id = v_row.id;

  if v_history_changed then
    insert into price_history (
      org_id, supplier_product_id, price, effective_date, created_by
    ) values (
      v_org, v_row.id, v_price, p_effective_date, v_user
    );
  end if;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_user, 'supplier_product_price_set', 'supplier_products', v_row.id,
    jsonb_build_object(
      'price', v_row.current_price,
      'effective_date', v_row.price_effective_date,
      'available', v_row.available
    ),
    jsonb_build_object(
      'price', v_price,
      'effective_date', p_effective_date,
      'available', p_available,
      'price_changed', v_price_changed,
      'history_changed', v_history_changed
    ),
    v_reason
  );

  return jsonb_build_object(
    'supplier_product_id', v_row.id,
    'price', v_price,
    'available', p_available,
    'price_changed', v_price_changed,
    'idempotent', false
  );
end
$$;

revoke all on function public.set_supplier_product_price(uuid, numeric, date, boolean, text) from public;
grant execute on function public.set_supplier_product_price(uuid, numeric, date, boolean, text) to authenticated;

create or replace function import_supplier_prices(
  p_rows jsonb,
  p_effective_date date,
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
  v_supplier uuid := auth_supplier();
  v_reason text := nullif(trim(p_reason), '');
  v_count int;
  v_distinct_count int;
  v_row record;
  v_existing supplier_products;
  v_created int := 0;
  v_updated int := 0;
  v_unchanged int := 0;
begin
  if v_org is null or v_user is null
     or v_role not in ('owner', 'office', 'supplier') then
    raise exception 'price_import_not_authorized' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array'
     or p_effective_date is null or v_reason is null then
    raise exception 'price_import_invalid' using errcode = '22023';
  end if;

  select count(*), count(distinct (supplier_id, product_id))
    into v_count, v_distinct_count
  from jsonb_to_recordset(p_rows) as row(
    supplier_id uuid,
    product_id uuid,
    price numeric,
    available boolean
  );

  if v_count = 0 or v_count > 5000 or v_count <> v_distinct_count
     or exists (
       select 1
       from jsonb_to_recordset(p_rows) as row(
         supplier_id uuid,
         product_id uuid,
         price numeric,
         available boolean
       )
       where supplier_id is null or product_id is null or price is null
          or round(price, 2) <= 0 or round(price, 2) > 1000000
     ) then
    raise exception 'price_import_invalid' using errcode = '22023';
  end if;

  -- Supplier rows serialize creation of a new supplier/product pair. Products and existing
  -- price rows are then locked in UUID order to keep batch and finalize lock order stable.
  perform 1
  from suppliers s
  join (
    select distinct supplier_id
    from jsonb_to_recordset(p_rows) as row(
      supplier_id uuid, product_id uuid, price numeric, available boolean
    )
  ) input on input.supplier_id = s.id
  where s.org_id = v_org and s.deleted_at is null
  order by s.id
  for update of s;

  perform 1
  from products p
  join (
    select distinct product_id
    from jsonb_to_recordset(p_rows) as row(
      supplier_id uuid, product_id uuid, price numeric, available boolean
    )
  ) input on input.product_id = p.id
  where p.org_id = v_org and p.active
  order by p.id
  for update of p;

  perform 1
  from supplier_products sp
  join (
    select supplier_id, product_id
    from jsonb_to_recordset(p_rows) as row(
      supplier_id uuid, product_id uuid, price numeric, available boolean
    )
  ) input on input.supplier_id = sp.supplier_id and input.product_id = sp.product_id
  where sp.org_id = v_org
  order by sp.id
  for update of sp;

  if exists (
    select 1
    from jsonb_to_recordset(p_rows) as row(
      supplier_id uuid, product_id uuid, price numeric, available boolean
    )
    left join suppliers s
      on s.id = row.supplier_id and s.org_id = v_org and s.deleted_at is null
    left join products p
      on p.id = row.product_id and p.org_id = v_org and p.active
    where s.id is null or p.id is null
       or (v_role = 'supplier' and (v_supplier is null or row.supplier_id <> v_supplier))
  ) then
    raise exception 'price_import_target_invalid' using errcode = '22023';
  end if;

  perform set_config('app.p1_financial_writer', v_user::text, true);

  for v_row in
    select supplier_id, product_id, round(price, 2) as price, coalesce(available, true) as available
    from jsonb_to_recordset(p_rows) as row(
      supplier_id uuid, product_id uuid, price numeric, available boolean
    )
    order by supplier_id, product_id
  loop
    v_existing := null;
    select * into v_existing
    from supplier_products sp
    where sp.org_id = v_org
      and sp.supplier_id = v_row.supplier_id
      and sp.product_id = v_row.product_id
    for update;

    if not found then
      insert into supplier_products (
        org_id, supplier_id, product_id, current_price,
        price_effective_date, available
      ) values (
        v_org, v_row.supplier_id, v_row.product_id, v_row.price,
        p_effective_date, v_row.available
      ) returning * into v_existing;

      insert into price_history (
        org_id, supplier_product_id, price, effective_date, created_by
      ) values (
        v_org, v_existing.id, v_row.price, p_effective_date, v_user
      );
      v_created := v_created + 1;
    elsif round(v_existing.current_price, 2) <> v_row.price
       or v_existing.price_effective_date <> p_effective_date
       or v_existing.available <> v_row.available then
      update supplier_products
      set current_price = v_row.price,
          previous_price = case
            when round(v_existing.current_price, 2) <> v_row.price then v_existing.current_price
            else v_existing.previous_price
          end,
          price_effective_date = p_effective_date,
          available = v_row.available
      where id = v_existing.id;

      if round(v_existing.current_price, 2) <> v_row.price
         or v_existing.price_effective_date <> p_effective_date then
        insert into price_history (
          org_id, supplier_product_id, price, effective_date, created_by
        ) values (
          v_org, v_existing.id, v_row.price, p_effective_date, v_user
        );
      end if;
      v_updated := v_updated + 1;
    else
      v_unchanged := v_unchanged + 1;
    end if;
  end loop;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_user, 'supplier_prices_imported', 'supplier_products', null, null,
    jsonb_build_object(
      'row_count', v_count,
      'created', v_created,
      'updated', v_updated,
      'unchanged', v_unchanged,
      'effective_date', p_effective_date
    ),
    v_reason
  );

  return jsonb_build_object(
    'row_count', v_count,
    'created', v_created,
    'updated', v_updated,
    'unchanged', v_unchanged
  );
end
$$;

revoke all on function public.import_supplier_prices(jsonb, date, text) from public;
grant execute on function public.import_supplier_prices(jsonb, date, text) to authenticated;

-- ===== 8. Mark a canonical month export sent =====

create or replace function mark_month_export_sent(
  p_month date,
  p_invoice_ids uuid[],
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
  v_reason text := nullif(trim(p_reason), '');
  v_export monthly_exports;
  v_ids uuid[];
  v_count int;
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office') then
    raise exception 'month_export_not_authorized' using errcode = '42501';
  end if;
  if p_month is null or p_month <> date_trunc('month', p_month)::date
     or p_invoice_ids is null or v_reason is null
     or array_position(p_invoice_ids, null) is not null then
    raise exception 'month_export_invalid' using errcode = '22023';
  end if;

  select coalesce(array_agg(id order by id), '{}'::uuid[]), count(*)
    into v_ids, v_count
  from (select distinct unnest(p_invoice_ids) as id) input;
  if v_count <> cardinality(p_invoice_ids) then
    raise exception 'month_export_duplicate_invoice' using errcode = '22023';
  end if;

  perform 1 from organizations where id = v_org for update;

  select * into v_export
  from monthly_exports me
  where me.org_id = v_org and me.month = p_month
  for update;

  if found and v_export.status = 'sent' then
    if v_export.invoice_ids is null then
      raise exception 'month_export_legacy_snapshot_missing' using errcode = 'P0001';
    end if;
    if v_export.invoice_ids is distinct from v_ids then
      raise exception 'month_export_snapshot_conflict' using errcode = 'P0001';
    end if;
    return jsonb_build_object(
      'export_id', v_export.id,
      'status', v_export.status,
      'invoice_count', cardinality(v_export.invoice_ids),
      'idempotent', true
    );
  end if;

  perform 1
  from invoices i
  join unnest(v_ids) input(id) on input.id = i.id
  where i.org_id = v_org
  order by i.id
  for update of i;

  if (select count(*) from invoices i where i.org_id = v_org and i.id = any(v_ids)) <> v_count
     or exists (
       select 1 from invoices i
       where i.org_id = v_org and i.id = any(v_ids)
         and (i.deleted_at is not null
              or i.invoice_date < p_month
              or i.invoice_date >= (p_month + interval '1 month')::date)
     ) then
    raise exception 'month_export_invoice_invalid' using errcode = '22023';
  end if;

  if v_export.id is not null
     and v_export.invoice_ids is not null
     and v_export.invoice_ids is distinct from v_ids then
    raise exception 'month_export_snapshot_conflict' using errcode = 'P0001';
  end if;

  perform set_config('app.p1_financial_writer', v_user::text, true);

  if v_export.id is null then
    insert into monthly_exports (
      org_id, month, status, invoice_ids
    ) values (
      v_org, p_month, 'open', v_ids
    ) returning * into v_export;
  end if;

  update invoices
  set export_status = 'sent'
  where org_id = v_org and id = any(v_ids);

  update monthly_exports
  set status = 'sent', sent_at = now(), sent_by = v_user,
      invoice_ids = v_ids, notes = v_reason
  where id = v_export.id
  returning * into v_export;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_user, 'month_export_sent', 'monthly_exports', v_export.id,
    jsonb_build_object('status', 'open'),
    jsonb_build_object(
      'status', 'sent',
      'month', p_month,
      'invoice_ids', to_jsonb(v_ids),
      'invoice_count', v_count
    ),
    v_reason
  );

  return jsonb_build_object(
    'export_id', v_export.id,
    'status', v_export.status,
    'invoice_count', v_count,
    'idempotent', false
  );
end
$$;

revoke all on function public.mark_month_export_sent(date, uuid[], text) from public;
grant execute on function public.mark_month_export_sent(date, uuid[], text) to authenticated;

-- ===== 9. Finalize an order draft against locked current prices =====

drop function public.finalize_purchase_request_draft(uuid, numeric);

create or replace function finalize_purchase_request_draft(
  p_request_id uuid,
  p_expected_total numeric,
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
  v_request purchase_requests;
  v_supplier_id uuid;
  v_order_id uuid;
  v_order_ids jsonb := '[]'::jsonb;
  v_order_count int := 0;
  v_total numeric;
  v_reason text := nullif(trim(p_reason), '');
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office', 'kitchen') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_expected_total is null or p_expected_total < 0 or v_reason is null then
    raise exception 'draft_invalid_expected_total' using errcode = '22023';
  end if;

  select * into v_request
  from purchase_requests
  where id = p_request_id
    and org_id = v_org
    and created_by = v_user
  for update;

  if not found then
    raise exception 'draft_unknown' using errcode = 'P0002';
  end if;

  if v_request.status = 'split' then
    select coalesce(jsonb_agg(po.id order by po.supplier_id, po.id), '[]'::jsonb),
           count(*)
      into v_order_ids, v_order_count
    from purchase_orders po
    where po.org_id = v_org and po.request_id = v_request.id;

    select round(coalesce(sum(poi.qty * poi.unit_price), 0), 2)
      into v_total
    from purchase_orders po
    join purchase_order_items poi on poi.order_id = po.id
    where po.org_id = v_org and po.request_id = v_request.id;

    if v_total is distinct from round(p_expected_total, 2) then
      raise exception 'draft_price_changed' using errcode = 'P0001';
    end if;
    return jsonb_build_object(
      'request_id', v_request.id,
      'order_ids', v_order_ids,
      'order_count', v_order_count,
      'total', v_total,
      'idempotent', true
    );
  end if;

  if v_request.status <> 'draft' then
    raise exception 'draft_unknown' using errcode = 'P0002';
  end if;
  if not exists (select 1 from purchase_request_items where request_id = v_request.id) then
    raise exception 'draft_empty' using errcode = '22023';
  end if;

  perform 1
  from purchase_request_items pri
  where pri.request_id = v_request.id
  order by pri.product_id
  for update;

  -- Price commands lock the same rows. Whichever command obtains the lock first defines a
  -- consistent outcome: a verified snapshot, or draft_price_changed after the update commits.
  perform 1
  from supplier_products sp
  join purchase_request_items pri
    on pri.request_id = v_request.id
   and pri.product_id = sp.product_id
   and pri.chosen_supplier_id = sp.supplier_id
  where sp.org_id = v_org
  order by sp.id
  for update of sp;

  if exists (
    select 1
    from purchase_request_items pri
    left join products p
      on p.id = pri.product_id and p.org_id = v_org and p.active
    left join supplier_products sp
      on sp.org_id = v_org
     and sp.product_id = pri.product_id
     and sp.supplier_id = pri.chosen_supplier_id
     and sp.available
    left join suppliers s
      on s.id = pri.chosen_supplier_id
     and s.org_id = v_org
     and s.deleted_at is null
     and s.status in ('active', 'problematic')
    where pri.request_id = v_request.id
      and (p.id is null or pri.chosen_supplier_id is null or sp.id is null or s.id is null)
  ) then
    raise exception 'draft_supplier_unavailable' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from purchase_request_items pri
    join supplier_products sp
      on sp.org_id = v_org
     and sp.product_id = pri.product_id
     and sp.supplier_id = pri.chosen_supplier_id
    where pri.request_id = v_request.id
      and pri.unit_price is distinct from sp.current_price
  ) then
    raise exception 'draft_price_changed' using errcode = 'P0001';
  end if;

  select round(sum(pri.qty * pri.unit_price), 2)
    into v_total
  from purchase_request_items pri
  where pri.request_id = v_request.id;

  if v_total is distinct from round(p_expected_total, 2) then
    raise exception 'draft_price_changed' using errcode = 'P0001';
  end if;

  perform set_config('app.purchase_request_draft_writer', v_user::text, true);

  for v_supplier_id in
    select distinct chosen_supplier_id
    from purchase_request_items
    where request_id = v_request.id
    order by chosen_supplier_id
  loop
    insert into purchase_orders (
      org_id, supplier_id, request_id, status, expected_date, notes, created_by
    ) values (
      v_org,
      v_supplier_id,
      v_request.id,
      'ready',
      v_request.expected_date,
      v_request.notes,
      v_user
    )
    returning id into v_order_id;

    insert into purchase_order_items (order_id, product_id, qty, unit_price)
    select v_order_id, pri.product_id, pri.qty, pri.unit_price
    from purchase_request_items pri
    where pri.request_id = v_request.id
      and pri.chosen_supplier_id = v_supplier_id
    order by pri.product_id;

    v_order_ids := v_order_ids || jsonb_build_array(v_order_id);
    v_order_count := v_order_count + 1;
  end loop;

  update purchase_requests set status = 'split' where id = v_request.id;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_user, 'purchase_request_finalized', 'purchase_requests', v_request.id,
    jsonb_build_object('status', 'draft'),
    jsonb_build_object(
      'status', 'split',
      'order_ids', v_order_ids,
      'order_count', v_order_count,
      'total', v_total
    ),
    v_reason
  );

  return jsonb_build_object(
    'request_id', v_request.id,
    'order_ids', v_order_ids,
    'order_count', v_order_count,
    'total', v_total,
    'idempotent', false
  );
end
$$;

revoke all on function public.finalize_purchase_request_draft(uuid, numeric, text) from public;
grant execute on function public.finalize_purchase_request_draft(uuid, numeric, text) to authenticated;
