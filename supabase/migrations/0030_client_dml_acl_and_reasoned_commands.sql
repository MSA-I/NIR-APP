-- P0 follow-up: explicit browser DML allowlist and reasoned catalog/order commands.
-- Forward-only after 0029. Sensitive lifecycle changes are RPC-only; RLS remains the
-- tenant/role boundary and the trigger guards also protect upgraded databases that once had
-- broader column grants.

-- ===== Remove implicit browser DML, including any historical column grants =====

do $$
declare
  v_table text;
  v_column text;
begin
  foreach v_table in array array[
    'organizations',
    'categories',
    'suppliers',
    'products',
    'purchase_requests',
    'purchase_request_items',
    'purchase_orders',
    'exceptions',
    'documents',
    'push_subscriptions'
  ]
  loop
    execute format(
      'revoke insert, update, delete on table public.%I from public, anon, authenticated',
      v_table
    );

    for v_column in
      select a.attname
      from pg_catalog.pg_attribute a
      where a.attrelid = format('public.%I', v_table)::regclass
        and a.attnum > 0
        and not a.attisdropped
    loop
      execute format(
        'revoke insert (%I), update (%I) on table public.%I from public, anon, authenticated',
        v_column,
        v_column,
        v_table
      );
    end loop;
  end loop;
end
$$;

-- Only columns sent by current browser code are writable. Generated IDs, tenant identity,
-- timestamps and sensitive lifecycle columns deliberately stay outside this allowlist.
grant update (name, vat_rate, settings)
  on table public.organizations to authenticated;

grant insert (org_id, name, sort)
  on table public.categories to authenticated;
grant update (name)
  on table public.categories to authenticated;
grant delete
  on table public.categories to authenticated;

grant insert (
  org_id, name, tax_id, contact_name, phone, whatsapp, email, address, delivery_days,
  cutoff_time, min_order_amount, payment_terms, bank_details, notes, status,
  rating, rating_updated_at, rating_note
)
  on table public.suppliers to authenticated;
grant update (
  name, tax_id, contact_name, phone, whatsapp, email, address, delivery_days,
  cutoff_time, min_order_amount, payment_terms, bank_details, notes, status,
  rating, rating_updated_at, rating_note
)
  on table public.suppliers to authenticated;

grant insert (org_id, name, category_id, unit, sku, barcode, notes, active, min_stock)
  on table public.products to authenticated;
grant update (name, category_id, unit, sku, barcode, notes, min_stock)
  on table public.products to authenticated;

grant update (status, sent_at, confirmed_at, confirmation_note, expected_date)
  on table public.purchase_orders to authenticated;

grant update (status, resolved_at, resolved_by, resolution_note)
  on table public.exceptions to authenticated;

grant insert (
  org_id, entity_type, entity_id, storage_path, file_name, mime_type, uploaded_by,
  document_kind, supplier_id, document_date
)
  on table public.documents to authenticated;
grant update (deleted_at, deleted_by)
  on table public.documents to authenticated;

grant delete
  on table public.push_subscriptions to authenticated;

-- ===== Draft RPCs own all purchase-request mutations =====

-- 0018 created these two live functions as SECURITY INVOKER. A clean reset intentionally has
-- no browser DML on purchase_requests/items, so the command boundary must own its table writes.
alter function public.save_purchase_request_draft(uuid, text, date, smallint, jsonb)
  security definer;
alter function public.save_purchase_request_draft(uuid, text, date, smallint, jsonb)
  set search_path = public, pg_temp;
alter function public.cancel_purchase_request_draft(uuid, text)
  security definer;
alter function public.cancel_purchase_request_draft(uuid, text)
  set search_path = public, pg_temp;

-- 0023 replaced the two-argument finalize overload with a reasoned three-argument SECURITY
-- DEFINER command. Harden the live overload again and conditionally close the obsolete overload
-- if an upgraded environment still carries it because of historical schema drift.
alter function public.finalize_purchase_request_draft(uuid, numeric, text)
  security definer;
alter function public.finalize_purchase_request_draft(uuid, numeric, text)
  set search_path = public, pg_temp;

do $$
begin
  if to_regprocedure('public.finalize_purchase_request_draft(uuid,numeric)') is not null then
    execute 'alter function public.finalize_purchase_request_draft(uuid, numeric) security definer';
    execute 'alter function public.finalize_purchase_request_draft(uuid, numeric) set search_path = public, pg_temp';
    execute 'revoke all on function public.finalize_purchase_request_draft(uuid, numeric) from public, anon, authenticated';
  end if;
end
$$;

revoke all on function public.save_purchase_request_draft(uuid, text, date, smallint, jsonb)
  from public, anon, authenticated;
revoke all on function public.cancel_purchase_request_draft(uuid, text)
  from public, anon, authenticated;
revoke all on function public.finalize_purchase_request_draft(uuid, numeric, text)
  from public, anon, authenticated;
grant execute on function public.save_purchase_request_draft(uuid, text, date, smallint, jsonb)
  to authenticated;
grant execute on function public.cancel_purchase_request_draft(uuid, text)
  to authenticated;
grant execute on function public.finalize_purchase_request_draft(uuid, numeric, text)
  to authenticated;

-- ===== Sensitive direct-write guards =====

create or replace function public.p0_supplier_soft_delete_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_authorized boolean := current_setting('app.p0_supplier_soft_delete_writer', true)
                          is not distinct from auth.uid()::text;
begin
  if new.deleted_at is not distinct from old.deleted_at then
    return new;
  end if;

  if v_user is null or v_authorized then
    return new;
  end if;

  raise exception 'supplier_soft_delete_rpc_required' using errcode = '42501';
end
$$;

drop trigger if exists p0_supplier_soft_delete_guard on public.suppliers;
create trigger p0_supplier_soft_delete_guard
  before update of deleted_at on public.suppliers
  for each row execute function public.p0_supplier_soft_delete_guard();

create or replace function public.p0_product_active_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_authorized boolean := current_setting('app.p0_product_active_writer', true)
                          is not distinct from auth.uid()::text;
begin
  if new.active is not distinct from old.active then
    return new;
  end if;

  if v_user is null or v_authorized then
    return new;
  end if;

  raise exception 'product_active_rpc_required' using errcode = '42501';
end
$$;

drop trigger if exists p0_product_active_guard on public.products;
create trigger p0_product_active_guard
  before update of active on public.products
  for each row execute function public.p0_product_active_guard();

create or replace function public.p0_purchase_order_cancel_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_authorized boolean := current_setting('app.p0_purchase_order_cancel_writer', true)
                          is not distinct from auth.uid()::text;
begin
  if new.status is not distinct from old.status
     or (new.status <> 'cancelled' and old.status <> 'cancelled') then
    return new;
  end if;

  if v_user is null or v_authorized then
    return new;
  end if;

  raise exception 'purchase_order_cancel_rpc_required' using errcode = '42501';
end
$$;

drop trigger if exists p0_purchase_order_cancel_guard on public.purchase_orders;
create trigger p0_purchase_order_cancel_guard
  before update of status on public.purchase_orders
  for each row execute function public.p0_purchase_order_cancel_guard();

revoke all on function public.p0_supplier_soft_delete_guard() from public, anon, authenticated;
revoke all on function public.p0_product_active_guard() from public, anon, authenticated;
revoke all on function public.p0_purchase_order_cancel_guard() from public, anon, authenticated;

-- ===== Atomic, reasoned commands =====

create or replace function public.soft_delete_supplier(
  p_supplier_id uuid,
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
  v_role public.user_role := auth_role();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_supplier public.suppliers;
  v_deleted_at timestamptz;
  v_open_balance numeric := 0;
  v_previous_writer text := coalesce(
    current_setting('app.p0_supplier_soft_delete_writer', true),
    ''
  );
begin
  if v_org is null or v_user is null or v_role is null
     or v_role not in ('owner', 'office') then
    raise exception 'supplier_soft_delete_not_authorized' using errcode = '42501';
  end if;
  if p_supplier_id is null or v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select s.* into v_supplier
  from public.suppliers s
  where s.id = p_supplier_id and s.org_id = v_org
  for update;

  if not found then
    raise exception 'supplier_not_found' using errcode = 'P0002';
  end if;
  if v_supplier.deleted_at is not null then
    return jsonb_build_object(
      'supplier_id', v_supplier.id,
      'status', 'deleted',
      'idempotent', true
    );
  end if;

  -- Do not call the role-filtered balance helper here: office is intentionally excluded from
  -- that read surface. This SECURITY DEFINER command computes only the deletion predicate and
  -- returns no amount, preserving the office balance-oracle boundary.
  with paid as (
    select pa.invoice_id, sum(pa.amount) as amount
    from public.payment_allocations pa
    where pa.org_id = v_org and pa.invoice_id is not null
    group by pa.invoice_id
  ), credited as (
    select cr.invoice_id, sum(cr.amount) as amount
    from public.credit_requests cr
    where cr.org_id = v_org and cr.invoice_id is not null
      and cr.status in ('offset', 'closed')
    group by cr.invoice_id
  )
  select coalesce(sum(
    i.total_amount - coalesce(p.amount, 0) - coalesce(c.amount, 0)
  ), 0)
  into v_open_balance
  from public.invoices i
  left join paid p on p.invoice_id = i.id
  left join credited c on c.invoice_id = i.id
  where i.org_id = v_org
    and i.supplier_id = v_supplier.id
    and i.deleted_at is null;

  if coalesce(v_open_balance, 0) > 0 then
    raise exception 'supplier_has_open_balance' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from public.purchase_orders po
    where po.org_id = v_org
      and po.supplier_id = v_supplier.id
      and po.status not in ('received', 'cancelled')
  ) then
    raise exception 'supplier_has_active_orders' using errcode = 'P0001';
  end if;

  perform set_config('app.p0_supplier_soft_delete_writer', v_user::text, true);
  begin
    update public.suppliers
    set deleted_at = clock_timestamp()
    where id = v_supplier.id and org_id = v_org
    returning deleted_at into v_deleted_at;
  exception when others then
    perform set_config('app.p0_supplier_soft_delete_writer', v_previous_writer, true);
    raise;
  end;
  perform set_config('app.p0_supplier_soft_delete_writer', v_previous_writer, true);

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org,
    v_user,
    'supplier_deleted',
    'suppliers',
    v_supplier.id,
    jsonb_build_object('deleted_at', v_supplier.deleted_at),
    jsonb_build_object('deleted_at', v_deleted_at),
    v_reason
  );

  return jsonb_build_object(
    'supplier_id', v_supplier.id,
    'status', 'deleted',
    'idempotent', false
  );
end
$$;

create or replace function public.set_product_active(
  p_product_id uuid,
  p_active boolean,
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
  v_role public.user_role := auth_role();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_product public.products;
  v_previous_writer text := coalesce(
    current_setting('app.p0_product_active_writer', true),
    ''
  );
begin
  if v_org is null or v_user is null or v_role is null
     or v_role not in ('owner', 'office', 'kitchen') then
    raise exception 'product_active_not_authorized' using errcode = '42501';
  end if;
  if p_product_id is null or p_active is null or v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select p.* into v_product
  from public.products p
  where p.id = p_product_id and p.org_id = v_org
  for update;

  if not found then
    raise exception 'product_not_found' using errcode = 'P0002';
  end if;
  if v_product.active is not distinct from p_active then
    return jsonb_build_object(
      'product_id', v_product.id,
      'active', v_product.active,
      'idempotent', true
    );
  end if;

  perform set_config('app.p0_product_active_writer', v_user::text, true);
  begin
    update public.products
    set active = p_active
    where id = v_product.id and org_id = v_org;
  exception when others then
    perform set_config('app.p0_product_active_writer', v_previous_writer, true);
    raise;
  end;
  perform set_config('app.p0_product_active_writer', v_previous_writer, true);

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org,
    v_user,
    case when p_active then 'product_activated' else 'product_deactivated' end,
    'products',
    v_product.id,
    jsonb_build_object('active', v_product.active),
    jsonb_build_object('active', p_active),
    v_reason
  );

  return jsonb_build_object(
    'product_id', v_product.id,
    'active', p_active,
    'idempotent', false
  );
end
$$;

create or replace function public.cancel_purchase_order(
  p_purchase_order_id uuid,
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
  v_role public.user_role := auth_role();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_order public.purchase_orders;
  v_previous_writer text := coalesce(
    current_setting('app.p0_purchase_order_cancel_writer', true),
    ''
  );
begin
  if v_org is null or v_user is null or v_role is null
     or v_role not in ('owner', 'office', 'kitchen') then
    raise exception 'purchase_order_cancel_not_authorized' using errcode = '42501';
  end if;
  if p_purchase_order_id is null or v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select po.* into v_order
  from public.purchase_orders po
  where po.id = p_purchase_order_id and po.org_id = v_org
  for update;

  if not found then
    raise exception 'purchase_order_unknown' using errcode = 'P0002';
  end if;
  if v_order.status = 'cancelled' then
    return jsonb_build_object(
      'purchase_order_id', v_order.id,
      'status', 'cancelled',
      'idempotent', true
    );
  end if;
  if v_order.status in ('partial', 'received') then
    raise exception 'purchase_order_cancel_invalid' using errcode = 'P0001';
  end if;

  perform set_config('app.p0_purchase_order_cancel_writer', v_user::text, true);
  begin
    update public.purchase_orders
    set status = 'cancelled'
    where id = v_order.id and org_id = v_org;
  exception when others then
    perform set_config('app.p0_purchase_order_cancel_writer', v_previous_writer, true);
    raise;
  end;
  perform set_config('app.p0_purchase_order_cancel_writer', v_previous_writer, true);

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org,
    v_user,
    'order_status:cancelled',
    'purchase_orders',
    v_order.id,
    jsonb_build_object('status', v_order.status),
    jsonb_build_object('status', 'cancelled'),
    v_reason
  );

  return jsonb_build_object(
    'purchase_order_id', v_order.id,
    'status', 'cancelled',
    'idempotent', false
  );
end
$$;

revoke all on function public.soft_delete_supplier(uuid, text) from public, anon, authenticated;
revoke all on function public.set_product_active(uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.cancel_purchase_order(uuid, text) from public, anon, authenticated;
grant execute on function public.soft_delete_supplier(uuid, text) to authenticated;
grant execute on function public.set_product_active(uuid, boolean, text) to authenticated;
grant execute on function public.cancel_purchase_order(uuid, text) to authenticated;

-- Fail the migration if a later edit accidentally widens one of the sensitive columns or
-- omits a direct browser operation that the allowlist is meant to restore.
do $$
begin
  if not has_column_privilege('authenticated', 'public.organizations', 'name', 'UPDATE')
     or not has_column_privilege('authenticated', 'public.categories', 'name', 'UPDATE')
     or not has_column_privilege('authenticated', 'public.suppliers', 'name', 'UPDATE')
     or not has_column_privilege('authenticated', 'public.products', 'name', 'UPDATE')
     or not has_column_privilege('authenticated', 'public.purchase_orders', 'status', 'UPDATE')
     or not has_column_privilege('authenticated', 'public.exceptions', 'status', 'UPDATE')
     or not has_column_privilege('authenticated', 'public.documents', 'storage_path', 'INSERT')
     or not has_table_privilege('authenticated', 'public.push_subscriptions', 'DELETE') then
    raise exception 'client_dml_allowlist_incomplete' using errcode = '42501';
  end if;

  if has_column_privilege('authenticated', 'public.organizations', 'status', 'UPDATE')
     or has_column_privilege('authenticated', 'public.suppliers', 'org_id', 'UPDATE')
     or has_column_privilege('authenticated', 'public.suppliers', 'deleted_at', 'UPDATE')
     or has_column_privilege('authenticated', 'public.products', 'org_id', 'UPDATE')
     or has_column_privilege('authenticated', 'public.products', 'active', 'UPDATE')
     or has_any_column_privilege('authenticated', 'public.purchase_requests', 'INSERT')
     or has_any_column_privilege('authenticated', 'public.purchase_requests', 'UPDATE')
     or has_table_privilege('authenticated', 'public.purchase_requests', 'DELETE')
     or has_any_column_privilege('authenticated', 'public.purchase_request_items', 'INSERT')
     or has_any_column_privilege('authenticated', 'public.purchase_request_items', 'UPDATE')
     or has_table_privilege('authenticated', 'public.purchase_request_items', 'DELETE')
     or has_column_privilege('authenticated', 'public.purchase_orders', 'org_id', 'UPDATE')
     or has_column_privilege('authenticated', 'public.documents', 'org_id', 'UPDATE') then
    raise exception 'client_dml_sensitive_column_exposed' using errcode = '42501';
  end if;

  if to_regprocedure('public.finalize_purchase_request_draft(uuid,numeric)') is not null
     and has_function_privilege(
       'authenticated',
       to_regprocedure('public.finalize_purchase_request_draft(uuid,numeric)'),
       'EXECUTE'
     ) then
    raise exception 'legacy_draft_finalize_overload_executable' using errcode = '42501';
  end if;
end
$$;
