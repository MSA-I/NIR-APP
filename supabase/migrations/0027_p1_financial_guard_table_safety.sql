-- P1C runtime guard safety.
-- The shared trigger runs against several table shapes. Access trigger rows through jsonb so
-- a branch for one table can never fail field resolution while another table is being updated.

create or replace function public.p1_financial_command_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_authorized boolean := current_setting('app.p1_financial_writer', true)
                          is not distinct from auth.uid()::text;
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
begin
  -- Migrations, seeds and trusted server jobs have no end-user subject.
  if v_user is null or v_authorized then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  -- Invoice soft-delete remains a separate, existing command. Every other invoice mutation
  -- owned by P1 must pass through its RPC.
  if tg_table_name = 'invoices' and tg_op = 'UPDATE'
     and (v_new - 'deleted_at' - 'updated_at')
         is not distinct from (v_old - 'deleted_at' - 'updated_at') then
    return new;
  end if;

  -- Receipt completion owns received_qty. Other legacy order-item updates remain outside P1.
  -- jsonb access is deliberate: this trigger function is also attached to purchase_orders.
  if tg_table_name = 'purchase_order_items' and tg_op = 'UPDATE'
     and v_new -> 'received_qty' is not distinct from v_old -> 'received_qty' then
    return new;
  end if;

  -- Other order status transitions remain in the client. Only receipt-derived states are
  -- protected here. jsonb access keeps this branch safe on tables without a status column.
  if tg_table_name = 'purchase_orders' and tg_op = 'UPDATE'
     and (
       v_new -> 'status' is not distinct from v_old -> 'status'
       or (
         v_new ->> 'status' not in ('partial', 'received')
         and v_old ->> 'status' not in ('partial', 'received')
       )
     ) then
    return new;
  end if;

  raise exception 'financial_command_rpc_required' using errcode = '42501';
end
$$;
