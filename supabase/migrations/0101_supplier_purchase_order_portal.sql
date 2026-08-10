-- Supplier portal purchase orders: extend the existing narrow projection and the existing
-- sent -> confirmed command. Base-table RLS remains the primary deny boundary.

create or replace function public.supplier_portal_context()
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_org uuid := public.auth_org();
  v_supplier uuid := public.auth_supplier();
  v_org_name text;
  v_supplier_name text;
  v_supplier_status public.supplier_status;
  v_prices jsonb;
  v_orders jsonb;
begin
  if v_org is null or auth.uid() is null or public.auth_role() <> 'supplier' or v_supplier is null then
    raise exception 'supplier_portal_not_authorized' using errcode = '42501';
  end if;

  select o.name, s.name, s.status into v_org_name, v_supplier_name, v_supplier_status
  from public.organizations o
  join public.suppliers s
    on s.org_id = o.id
   and s.id = v_supplier
   and s.deleted_at is null
  where o.id = v_org;
  if not found then
    raise exception 'supplier_portal_not_authorized' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'supplier_product_id', sp.id,
    'product_id', p.id,
    'product_name', p.name,
    'unit', p.unit,
    'current_price', sp.current_price,
    'previous_price', sp.previous_price,
    'price_effective_date', sp.price_effective_date,
    'available', sp.available,
    'supplier_sku', sp.supplier_sku,
    'min_qty', sp.min_qty,
    'package_size', sp.package_size,
    'updated_at', sp.updated_at
  ) order by p.name, p.id), '[]'::jsonb)
  into v_prices
  from public.supplier_products sp
  join public.products p
    on p.org_id = sp.org_id
   and p.id = sp.product_id
   and p.active
  where sp.org_id = v_org
    and sp.supplier_id = v_supplier;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', source.id,
    'number', source.number,
    'status', source.status,
    'expected_date', source.expected_date,
    'sent_at', source.sent_at,
    'confirmed_at', source.confirmed_at,
    'items', source.items
  ) order by source.sent_at desc, source.id), '[]'::jsonb)
  into v_orders
  from (
    select
      po.id,
      po.number,
      po.status,
      po.expected_date,
      po.sent_at,
      po.confirmed_at,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', poi.id,
          'product_name', p.name,
          'unit', p.unit,
          'supplier_sku', sp.supplier_sku,
          'qty', poi.qty,
          'unit_price', poi.unit_price,
          'received_qty', poi.received_qty
        ) order by p.name, poi.id)
        from public.purchase_order_items poi
        join public.products p
          on p.org_id = poi.org_id
         and p.id = poi.product_id
        left join public.supplier_products sp
          on sp.org_id = po.org_id
         and sp.supplier_id = po.supplier_id
         and sp.product_id = poi.product_id
        where poi.org_id = po.org_id
          and poi.order_id = po.id
      ), '[]'::jsonb) as items
    from public.purchase_orders po
    where po.org_id = v_org
      and po.supplier_id = v_supplier
      and (po.unit_id is null or po.unit_id = any(public.auth_scopes()))
      -- A draft or ready order has not been issued to the supplier. sent_at preserves
      -- previously-issued history even if the order was later cancelled.
      and po.sent_at is not null
  ) source;

  return jsonb_build_object(
    'organization_name', v_org_name,
    'supplier', jsonb_build_object(
      'id', v_supplier,
      'name', v_supplier_name,
      'status', v_supplier_status
    ),
    'current_month', date_trunc('month', now() at time zone 'Asia/Jerusalem')::date,
    'prices', v_prices,
    'orders', v_orders
  );
end
$$;

revoke all on function public.supplier_portal_context() from public, anon;
grant execute on function public.supplier_portal_context() to authenticated;

comment on function public.supplier_portal_context() is
  'SECURITY DEFINER: supplier-only projection filtered by auth_org, auth_supplier and null-or-auth_scopes purchase-order unit.';

insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
)
select
  'supplier_portal_context()',
  md5(p.prosrc),
  'filtered_read',
  '0101 binds the actor to auth_org and auth_supplier, then filters every issued purchase order to null-or-auth_scopes unit before returning the narrow supplier projection.'
from pg_catalog.pg_proc p
where p.oid = 'public.supplier_portal_context()'::regprocedure
on conflict (function_signature) do update
set body_hash = excluded.body_hash,
    enforcement_kind = excluded.enforcement_kind,
    scope_proof = excluded.scope_proof;

create or replace function public.transition_purchase_order_status(
  p_purchase_order_id uuid,
  p_target_status text,
  p_reason text,
  p_confirmation_note text,
  p_expected_date date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org uuid := public.auth_org();
  v_user uuid := auth.uid();
  v_role public.user_role := public.auth_role();
  v_supplier uuid := public.auth_supplier();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_note text := nullif(btrim(coalesce(p_confirmation_note, '')), '');
  v_target public.po_status;
  v_order public.purchase_orders;
  v_updated public.purchase_orders;
  v_previous_writer text := coalesce(
    current_setting('app.p1_financial_writer', true),
    ''
  );
begin
  if v_org is null or v_user is null or v_role is null
     or v_role not in ('owner', 'office', 'kitchen', 'supplier') then
    raise exception 'purchase_order_status_not_authorized' using errcode = '42501';
  end if;
  if p_purchase_order_id is null or v_reason is null or p_target_status is null
     or p_target_status not in ('ready', 'sent', 'confirmed') then
    raise exception 'purchase_order_status_invalid' using errcode = '22023';
  end if;
  if p_target_status <> 'confirmed'
     and (v_note is not null or p_expected_date is not null) then
    raise exception 'purchase_order_confirmation_fields_invalid' using errcode = '22023';
  end if;
  if v_role = 'supplier' and p_target_status <> 'confirmed' then
    raise exception 'purchase_order_status_not_authorized' using errcode = '42501';
  end if;
  -- A supplier may acknowledge the issued order, but may not silently negotiate a new
  -- delivery date through the generic staff confirmation parameter.
  if v_role = 'supplier' and p_expected_date is not null then
    raise exception 'purchase_order_confirmation_fields_invalid' using errcode = '22023';
  end if;
  v_target := p_target_status::public.po_status;

  select po.* into v_order
  from public.purchase_orders po
  where po.id = p_purchase_order_id
    and po.org_id = v_org
    and (v_role <> 'supplier' or po.supplier_id = v_supplier)
    and (v_role <> 'supplier' or po.unit_id is null or po.unit_id = any(public.auth_scopes()))
  for update;

  if not found then
    raise exception 'purchase_order_unknown' using errcode = 'P0002';
  end if;

  if v_order.status = v_target then
    if v_target = 'confirmed' and (
      v_order.confirmation_note is distinct from v_note
      or (p_expected_date is not null and v_order.expected_date is distinct from p_expected_date)
    ) then
      raise exception 'purchase_order_status_idempotency_conflict' using errcode = 'P0001';
    end if;
    return jsonb_build_object(
      'purchase_order_id', v_order.id,
      'status', v_order.status,
      'sent_at', v_order.sent_at,
      'confirmed_at', v_order.confirmed_at,
      'confirmation_note', v_order.confirmation_note,
      'expected_date', v_order.expected_date,
      'idempotent', true
    );
  end if;

  if not (
       (v_order.status = 'draft' and v_target in ('ready', 'sent'))
    or (v_order.status = 'ready' and v_target = 'sent')
    or (v_order.status = 'sent' and v_target = 'confirmed')
  ) then
    raise exception 'purchase_order_status_transition_invalid' using errcode = 'P0001';
  end if;

  perform set_config('app.p1_financial_writer', v_user::text, true);
  begin
    update public.purchase_orders
    set status = v_target,
        sent_at = case when v_target = 'sent' then clock_timestamp() else sent_at end,
        confirmed_at = case when v_target = 'confirmed' then clock_timestamp() else confirmed_at end,
        confirmation_note = case when v_target = 'confirmed' then v_note else confirmation_note end,
        expected_date = case
          when v_target = 'confirmed' and p_expected_date is not null then p_expected_date
          else expected_date
        end
    where id = v_order.id and org_id = v_org
    returning * into v_updated;
  exception when others then
    perform set_config('app.p1_financial_writer', v_previous_writer, true);
    raise;
  end;
  perform set_config('app.p1_financial_writer', v_previous_writer, true);

  insert into public.audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org,
    v_user,
    'purchase_order_status_changed',
    'purchase_orders',
    v_order.id,
    jsonb_build_object(
      'status', v_order.status,
      'sent_at', v_order.sent_at,
      'confirmed_at', v_order.confirmed_at,
      'confirmation_note', v_order.confirmation_note,
      'expected_date', v_order.expected_date
    ),
    jsonb_build_object(
      'status', v_updated.status,
      'sent_at', v_updated.sent_at,
      'confirmed_at', v_updated.confirmed_at,
      'confirmation_note', v_updated.confirmation_note,
      'expected_date', v_updated.expected_date
    ),
    v_reason
  );

  return jsonb_build_object(
    'purchase_order_id', v_updated.id,
    'status', v_updated.status,
    'sent_at', v_updated.sent_at,
    'confirmed_at', v_updated.confirmed_at,
    'confirmation_note', v_updated.confirmation_note,
    'expected_date', v_updated.expected_date,
    'idempotent', false
  );
end
$$;

revoke all on function public.transition_purchase_order_status(uuid, text, text, text, date)
  from public, anon, authenticated;
grant execute on function public.transition_purchase_order_status(uuid, text, text, text, date)
  to authenticated;

comment on function public.transition_purchase_order_status(uuid, text, text, text, date) is
  'Reasoned purchase-order transitions; supplier actors may only confirm an issued order bound to their supplier_id.';

do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0101 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
