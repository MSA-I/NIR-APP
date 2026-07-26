-- Immutable single-warehouse inventory ledger.

alter table products
  add constraint products_min_stock_nonnegative check (min_stock is null or min_stock >= 0) not valid;
alter table products validate constraint products_min_stock_nonnegative;

create type inventory_movement_type as enum (
  'receipt', 'consumption', 'adjustment', 'stocktake', 'reversal'
);

create table inventory_movements (
  id uuid primary key,
  sequence_number bigint generated always as identity unique,
  org_id uuid not null default auth_org() references organizations(id),
  product_id uuid not null,
  movement_type inventory_movement_type not null,
  quantity_delta numeric(12,2) not null,
  counted_quantity numeric(12,2),
  receipt_item_id uuid,
  reverses_movement_id uuid,
  negative_override boolean not null default false,
  reason text not null check (trim(reason) <> ''),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint inventory_movements_org_id_id_key unique (org_id, id),
  constraint inventory_movements_product_fk
    foreign key (org_id, product_id) references products(org_id, id) on delete restrict,
  constraint inventory_movements_actor_fk
    foreign key (org_id, created_by) references profiles(org_id, id) on delete restrict,
  constraint inventory_movements_receipt_item_fk
    foreign key (org_id, receipt_item_id) references goods_receipt_items(org_id, id) on delete restrict,
  constraint inventory_movements_reversal_fk
    foreign key (org_id, reverses_movement_id) references inventory_movements(org_id, id) on delete restrict,
  constraint inventory_movements_shape_check check (
    (movement_type = 'receipt' and quantity_delta > 0 and counted_quantity is null
      and receipt_item_id is not null and reverses_movement_id is null and not negative_override)
    or
    (movement_type = 'consumption' and quantity_delta < 0 and counted_quantity is null
      and receipt_item_id is null and reverses_movement_id is null)
    or
    (movement_type = 'adjustment' and quantity_delta <> 0 and counted_quantity is null
      and receipt_item_id is null and reverses_movement_id is null)
    or
    (movement_type = 'stocktake' and counted_quantity >= 0
      and receipt_item_id is null and reverses_movement_id is null and not negative_override)
    or
    (movement_type = 'reversal' and quantity_delta <> 0 and counted_quantity is null
      and receipt_item_id is null and reverses_movement_id is not null)
  )
);

create unique index inventory_movements_receipt_item_idx
  on inventory_movements (org_id, receipt_item_id) where receipt_item_id is not null;
create unique index inventory_movements_reversal_target_idx
  on inventory_movements (org_id, reverses_movement_id) where reverses_movement_id is not null;
create index inventory_movements_org_product_created_idx
  on inventory_movements (org_id, product_id, created_at desc, id);

alter table inventory_movements enable row level security;
create policy inventory_movements_select on inventory_movements for select to authenticated using (
  org_id = auth_org() and auth_role() in ('owner', 'office', 'kitchen')
);

revoke all on table inventory_movements from public, anon, authenticated;
grant select on table inventory_movements to authenticated;

create or replace function reject_inventory_movement_mutation()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  raise exception 'inventory_movements_are_immutable' using errcode = '42501';
end
$$;

create trigger inventory_movements_immutable
before update or delete on inventory_movements
for each row execute function reject_inventory_movement_mutation();

create or replace function audit_inventory_movement()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, new_values, reason
  ) values (
    new.org_id,
    new.created_by,
    'inventory_movement_recorded',
    'inventory_movements',
    new.id,
    jsonb_build_object(
      'product_id', new.product_id,
      'movement_type', new.movement_type,
      'quantity_delta', new.quantity_delta,
      'counted_quantity', new.counted_quantity,
      'receipt_item_id', new.receipt_item_id,
      'reverses_movement_id', new.reverses_movement_id,
      'negative_override', new.negative_override
    ),
    new.reason
  );
  return new;
end
$$;

create trigger inventory_movements_audit
after insert on inventory_movements
for each row execute function audit_inventory_movement();

revoke all on function reject_inventory_movement_mutation() from public, anon, authenticated;
revoke all on function audit_inventory_movement() from public, anon, authenticated;

create or replace function record_receipt_inventory_movements()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'draft' and new.status = 'completed' then
    if new.received_by is null then
      raise exception 'inventory_receipt_actor_required' using errcode = '23514';
    end if;

    -- Keep product locks in a deterministic order with manual inventory commands.
    perform 1
    from products p
    join goods_receipt_items gri
      on gri.org_id = p.org_id and gri.product_id = p.id and gri.receipt_id = new.id
    where p.org_id = new.org_id
      and gri.status in ('full', 'partial') and gri.qty_received > 0
    order by p.id
    for update of p;

    insert into inventory_movements (
      id, org_id, product_id, movement_type, quantity_delta, receipt_item_id,
      negative_override, reason, created_by, created_at
    )
    select
      gen_random_uuid(),
      new.org_id,
      gri.product_id,
      'receipt',
      round(gri.qty_received, 2),
      gri.id,
      false,
      'השלמת קבלת סחורה #' || new.number,
      new.received_by,
      new.received_at
    from goods_receipt_items gri
    where gri.org_id = new.org_id and gri.receipt_id = new.id
      and gri.status in ('full', 'partial') and gri.qty_received > 0
    order by gri.product_id, gri.id;
  end if;
  return new;
end
$$;

create trigger goods_receipts_inventory_transition
after update of status on goods_receipts
for each row execute function record_receipt_inventory_movements();

revoke all on function record_receipt_inventory_movements() from public, anon, authenticated;

create or replace function record_inventory_movement(
  p_movement_id uuid,
  p_product_id uuid,
  p_movement_type inventory_movement_type,
  p_quantity numeric,
  p_allow_negative boolean,
  p_reason text
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role user_role := auth_role();
  v_reason text := nullif(trim(p_reason), '');
  v_delta numeric(12,2);
  v_current numeric(12,2);
  v_after numeric(12,2);
  v_existing inventory_movements;
  v_override boolean := false;
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office', 'kitchen') then
    raise exception 'inventory_not_authorized' using errcode = '42501';
  end if;
  if p_movement_id is null or p_product_id is null or p_movement_type is null or p_quantity is null
     or p_allow_negative is null or v_reason is null
     or p_movement_type not in ('consumption', 'adjustment') then
    raise exception 'inventory_movement_invalid' using errcode = '22023';
  end if;
  if p_allow_negative and v_role <> 'owner' then
    raise exception 'inventory_negative_override_forbidden' using errcode = '42501';
  end if;
  if p_movement_type = 'adjustment' and v_role not in ('owner', 'office') then
    raise exception 'inventory_not_authorized' using errcode = '42501';
  end if;

  v_delta := case
    when p_movement_type = 'consumption' then -round(p_quantity, 2)
    else round(p_quantity, 2)
  end;
  if (p_movement_type = 'consumption' and (p_quantity <= 0 or p_quantity > 1000000))
     or (p_movement_type = 'adjustment' and (v_delta = 0 or abs(v_delta) > 1000000)) then
    raise exception 'inventory_movement_invalid' using errcode = '22023';
  end if;

  -- The UUID is the command idempotency key; serialize retries even when they name
  -- different products and therefore would not meet on the product-row lock.
  perform pg_advisory_xact_lock(hashtextextended(p_movement_id::text, 0));

  select * into v_existing
  from inventory_movements m
  where m.org_id = v_org and m.id = p_movement_id;
  if found then
    if v_existing.product_id <> p_product_id
       or v_existing.movement_type <> p_movement_type
       or v_existing.quantity_delta <> v_delta
       or v_existing.reason <> v_reason
       or (v_existing.negative_override and not p_allow_negative) then
      raise exception 'inventory_movement_id_conflict' using errcode = 'P0001';
    end if;
    select coalesce(sum(quantity_delta), 0)::numeric(12,2) into v_after
    from inventory_movements where org_id = v_org and product_id = p_product_id;
    return jsonb_build_object(
      'movement_id', v_existing.id,
      'quantity_delta', v_existing.quantity_delta,
      'quantity_on_hand', v_after,
      'idempotent', true
    );
  end if;

  perform 1 from products
  where org_id = v_org and id = p_product_id and active
  for update;
  if not found then
    raise exception 'inventory_product_unknown' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from inventory_movements
    where org_id = v_org and product_id = p_product_id and movement_type = 'stocktake'
  ) then
    raise exception 'inventory_stocktake_required' using errcode = 'P0001';
  end if;

  select coalesce(sum(quantity_delta), 0)::numeric(12,2) into v_current
  from inventory_movements where org_id = v_org and product_id = p_product_id;
  v_after := v_current + v_delta;
  if v_after < 0 then
    if not p_allow_negative then
      raise exception 'inventory_insufficient_stock' using errcode = '23514';
    end if;
    v_override := true;
  end if;

  insert into inventory_movements (
    id, org_id, product_id, movement_type, quantity_delta,
    negative_override, reason, created_by
  ) values (
    p_movement_id, v_org, p_product_id, p_movement_type, v_delta,
    v_override, v_reason, v_user
  );

  return jsonb_build_object(
    'movement_id', p_movement_id,
    'quantity_delta', v_delta,
    'quantity_on_hand', v_after,
    'idempotent', false
  );
end
$$;

create or replace function record_inventory_stocktake(
  p_movement_id uuid,
  p_product_id uuid,
  p_counted_quantity numeric,
  p_reason text
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_reason text := nullif(trim(p_reason), '');
  v_counted numeric(12,2) := round(p_counted_quantity, 2);
  v_current numeric(12,2);
  v_delta numeric(12,2);
  v_existing inventory_movements;
begin
  if v_org is null or v_user is null or auth_role() not in ('owner', 'office', 'kitchen') then
    raise exception 'inventory_not_authorized' using errcode = '42501';
  end if;
  if p_movement_id is null or p_product_id is null or p_counted_quantity is null
     or v_reason is null or v_counted < 0 or v_counted > 1000000 then
    raise exception 'inventory_movement_invalid' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_movement_id::text, 0));

  select * into v_existing
  from inventory_movements m
  where m.org_id = v_org and m.id = p_movement_id;
  if found then
    if v_existing.product_id <> p_product_id
       or v_existing.movement_type <> 'stocktake'
       or v_existing.counted_quantity <> v_counted
       or v_existing.reason <> v_reason then
      raise exception 'inventory_movement_id_conflict' using errcode = 'P0001';
    end if;
    return jsonb_build_object(
      'movement_id', v_existing.id,
      'quantity_delta', v_existing.quantity_delta,
      'quantity_on_hand', v_existing.counted_quantity,
      'is_counted', true,
      'idempotent', true
    );
  end if;

  perform 1 from products
  where org_id = v_org and id = p_product_id and active
  for update;
  if not found then
    raise exception 'inventory_product_unknown' using errcode = 'P0002';
  end if;

  select coalesce(sum(quantity_delta), 0)::numeric(12,2) into v_current
  from inventory_movements where org_id = v_org and product_id = p_product_id;
  v_delta := v_counted - v_current;

  insert into inventory_movements (
    id, org_id, product_id, movement_type, quantity_delta, counted_quantity,
    negative_override, reason, created_by
  ) values (
    p_movement_id, v_org, p_product_id, 'stocktake', v_delta, v_counted,
    false, v_reason, v_user
  );

  return jsonb_build_object(
    'movement_id', p_movement_id,
    'quantity_delta', v_delta,
    'quantity_on_hand', v_counted,
    'is_counted', true,
    'idempotent', false
  );
end
$$;

create or replace function reverse_inventory_movement(
  p_movement_id uuid,
  p_target_movement_id uuid,
  p_allow_negative boolean,
  p_reason text
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role user_role := auth_role();
  v_reason text := nullif(trim(p_reason), '');
  v_target inventory_movements;
  v_existing inventory_movements;
  v_current numeric(12,2);
  v_after numeric(12,2);
  v_override boolean := false;
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office') then
    raise exception 'inventory_not_authorized' using errcode = '42501';
  end if;
  if p_movement_id is null or p_target_movement_id is null
     or p_allow_negative is null or v_reason is null then
    raise exception 'inventory_movement_invalid' using errcode = '22023';
  end if;
  if p_allow_negative and v_role <> 'owner' then
    raise exception 'inventory_negative_override_forbidden' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_movement_id::text, 0));

  select * into v_existing from inventory_movements
  where org_id = v_org and id = p_movement_id;
  if found then
    if v_existing.movement_type <> 'reversal'
       or v_existing.reverses_movement_id <> p_target_movement_id
       or v_existing.reason <> v_reason
       or (v_existing.negative_override and not p_allow_negative) then
      raise exception 'inventory_movement_id_conflict' using errcode = 'P0001';
    end if;
    select coalesce(sum(quantity_delta), 0)::numeric(12,2) into v_after
    from inventory_movements
    where org_id = v_org and product_id = v_existing.product_id;
    return jsonb_build_object(
      'movement_id', v_existing.id,
      'quantity_delta', v_existing.quantity_delta,
      'quantity_on_hand', v_after,
      'idempotent', true
    );
  end if;

  select * into v_target
  from inventory_movements m
  where m.org_id = v_org and m.id = p_target_movement_id
  for update;
  if not found then
    raise exception 'inventory_target_unknown' using errcode = 'P0002';
  end if;
  if v_target.movement_type not in ('consumption', 'adjustment') then
    raise exception 'inventory_target_not_reversible' using errcode = 'P0001';
  end if;

  -- Stocktakes and reversals serialize on the product. Check for a later physical truth only
  -- after this lock so a concurrent count cannot commit between the check and the reversal.
  perform 1 from products
  where org_id = v_org and id = v_target.product_id
  for update;

  if exists (
    select 1 from inventory_movements later_count
    where later_count.org_id = v_org
      and later_count.product_id = v_target.product_id
      and later_count.movement_type = 'stocktake'
      and later_count.sequence_number > v_target.sequence_number
  ) then
    raise exception 'inventory_target_superseded_by_stocktake' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from inventory_movements
    where org_id = v_org and reverses_movement_id = p_target_movement_id
  ) then
    raise exception 'inventory_target_already_reversed' using errcode = 'P0001';
  end if;

  select coalesce(sum(quantity_delta), 0)::numeric(12,2) into v_current
  from inventory_movements
  where org_id = v_org and product_id = v_target.product_id;
  v_after := v_current - v_target.quantity_delta;
  if v_after < 0 then
    if not p_allow_negative then
      raise exception 'inventory_insufficient_stock' using errcode = '23514';
    end if;
    v_override := true;
  end if;

  insert into inventory_movements (
    id, org_id, product_id, movement_type, quantity_delta, reverses_movement_id,
    negative_override, reason, created_by
  ) values (
    p_movement_id, v_org, v_target.product_id, 'reversal', -v_target.quantity_delta,
    v_target.id, v_override, v_reason, v_user
  );

  return jsonb_build_object(
    'movement_id', p_movement_id,
    'quantity_delta', -v_target.quantity_delta,
    'quantity_on_hand', v_after,
    'idempotent', false
  );
end
$$;

revoke all on function record_inventory_movement(uuid, uuid, inventory_movement_type, numeric, boolean, text)
  from public, anon;
revoke all on function record_inventory_stocktake(uuid, uuid, numeric, text)
  from public, anon;
revoke all on function reverse_inventory_movement(uuid, uuid, boolean, text)
  from public, anon;
grant execute on function record_inventory_movement(uuid, uuid, inventory_movement_type, numeric, boolean, text)
  to authenticated;
grant execute on function record_inventory_stocktake(uuid, uuid, numeric, text)
  to authenticated;
grant execute on function reverse_inventory_movement(uuid, uuid, boolean, text)
  to authenticated;

create view inventory_balances with (security_invoker = on, security_barrier = on) as
with movement_totals as (
  select
    org_id,
    product_id,
    sum(quantity_delta)::numeric(12,2) as quantity_on_hand,
    bool_or(movement_type = 'stocktake') as is_counted,
    max(created_at) filter (where movement_type = 'stocktake') as last_counted_at
  from inventory_movements
  where org_id = auth_org()
  group by org_id, product_id
)
select
  p.id as product_id,
  p.name as product_name,
  p.unit,
  p.min_stock,
  case when coalesce(mt.is_counted, false) then mt.quantity_on_hand else null end as quantity_on_hand,
  coalesce(mt.is_counted, false) as is_counted,
  mt.last_counted_at,
  case
    when not coalesce(mt.is_counted, false) or p.min_stock is null then null
    else mt.quantity_on_hand < p.min_stock
  end as is_low_stock
from products p
left join movement_totals mt on mt.org_id = p.org_id and mt.product_id = p.id
where p.org_id = auth_org() and p.active
  and auth_role() in ('owner', 'office', 'kitchen');

create view inventory_movement_feed with (security_invoker = on, security_barrier = on) as
select
  m.id,
  m.product_id,
  p.name as product_name,
  p.unit,
  m.movement_type,
  m.quantity_delta,
  m.counted_quantity,
  m.negative_override,
  m.reason,
  m.created_by,
  pr.full_name as created_by_name,
  m.created_at,
  gr.id as receipt_id,
  gr.number as receipt_number,
  m.reverses_movement_id
from inventory_movements m
join products p on p.org_id = m.org_id and p.id = m.product_id
join profiles pr on pr.org_id = m.org_id and pr.id = m.created_by
left join goods_receipt_items gri
  on gri.org_id = m.org_id and gri.id = m.receipt_item_id
left join goods_receipts gr
  on gr.org_id = gri.org_id and gr.id = gri.receipt_id
where m.org_id = auth_org()
  and auth_role() in ('owner', 'office', 'kitchen');

revoke all on inventory_balances, inventory_movement_feed from public, anon, authenticated;
grant select on inventory_balances, inventory_movement_feed to authenticated;
