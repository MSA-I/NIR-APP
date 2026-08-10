-- 0094 -- Inactive or pending suppliers remain readable for history and financial closing, but
-- cannot be used to start a purchase order or a new price-list/catalog mutation.

create or replace function private.guard_new_supplier_commerce()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_status public.supplier_status;
begin
  -- Existing obligations may still progress to confirmed/received/cancelled. Only a transition
  -- that initiates supplier activity (ready/sent), or a supplier change, starts new commerce.
  -- Keep table-specific fields in a nested branch. PostgreSQL may reorder boolean terms, so an
  -- AND guard is not sufficient protection for supplier_products, which has no status column.
  if tg_table_name = 'purchase_orders' then
    if tg_op = 'UPDATE'
       and new.supplier_id is not distinct from old.supplier_id
       and new.status is distinct from old.status
       and new.status not in ('ready', 'sent') then
      return new;
    end if;
  end if;

  select s.status into v_status
  from public.suppliers s
  where s.org_id = new.org_id and s.id = new.supplier_id and s.deleted_at is null;

  if v_status is null then
    raise exception 'supplier_unknown' using errcode = 'P0002';
  end if;
  if v_status not in ('active', 'problematic')
     and current_setting('app.price_list_auto_writer', true) is distinct from 'revert' then
    raise exception 'supplier_inactive_for_new_commerce' using errcode = '55000';
  end if;
  return new;
end
$$;

revoke all on function private.guard_new_supplier_commerce()
  from public, anon, authenticated, service_role;

drop trigger if exists supplier_commerce_guard_purchase_orders on public.purchase_orders;
create trigger supplier_commerce_guard_purchase_orders
before insert or update of supplier_id, status on public.purchase_orders
for each row execute function private.guard_new_supplier_commerce();

drop trigger if exists supplier_commerce_guard_price_reservations
  on public.supplier_price_document_upload_reservations;
create trigger supplier_commerce_guard_price_reservations
before insert on public.supplier_price_document_upload_reservations
for each row execute function private.guard_new_supplier_commerce();

drop trigger if exists supplier_commerce_guard_price_submissions
  on public.supplier_price_submissions;
create trigger supplier_commerce_guard_price_submissions
before insert on public.supplier_price_submissions
for each row execute function private.guard_new_supplier_commerce();

drop trigger if exists supplier_commerce_guard_supplier_products on public.supplier_products;
create trigger supplier_commerce_guard_supplier_products
before insert or update on public.supplier_products
for each row execute function private.guard_new_supplier_commerce();

do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0094 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
