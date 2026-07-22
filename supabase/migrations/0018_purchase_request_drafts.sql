-- 0018 — Durable personal purchase-request drafts and atomic finalization.
-- The RPCs are the write boundary for auto-save: tenant, role, ownership and live prices are
-- checked once on the server, and replacing the draft items is a single transaction.

alter table purchase_requests
  add column expected_date date,
  add column editor_step smallint not null default 1
    constraint purchase_requests_editor_step_check check (editor_step in (1, 2)),
  add column updated_at timestamptz not null default now();

create trigger purchase_requests_touch
  before update on purchase_requests
  for each row execute function set_updated_at();

create index purchase_requests_personal_drafts_idx
  on purchase_requests (org_id, created_by, updated_at desc)
  where status = 'draft';

-- Existing RLS intentionally permits staff to operate the purchasing tables, but it cannot
-- express "a draft may only change through the atomic RPC that owns its audit/price rules".
-- A transaction-local marker closes that bypass without affecting non-draft request updates.
create or replace function purchase_requests_guard_draft_rpc()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_protected boolean;
begin
  -- Migrations/service jobs have no end-user JWT and remain able to seed/reset known data.
  -- Anonymous API writes still fail RLS; this exception only preserves trusted DB work.
  if v_user is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    v_protected := new.status = 'draft';
  elsif tg_op = 'DELETE' then
    v_protected := old.status = 'draft';
  else
    v_protected := old.status = 'draft' or new.status = 'draft';
  end if;

  if v_protected
     and current_setting('app.purchase_request_draft_writer', true) is distinct from v_user::text then
    raise exception 'purchase_request_draft_rpc_required' using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

create or replace function purchase_request_items_guard_draft_rpc()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_protected boolean;
begin
  if v_user is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    select exists (
      select 1 from purchase_requests r where r.id = new.request_id and r.status = 'draft'
    ) into v_protected;
  elsif tg_op = 'DELETE' then
    select exists (
      select 1 from purchase_requests r where r.id = old.request_id and r.status = 'draft'
    ) into v_protected;
  else
    select exists (
      select 1 from purchase_requests r
      where r.id in (old.request_id, new.request_id) and r.status = 'draft'
    ) into v_protected;
  end if;

  if v_protected
     and current_setting('app.purchase_request_draft_writer', true) is distinct from v_user::text then
    raise exception 'purchase_request_draft_rpc_required' using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

create trigger purchase_requests_draft_rpc_guard
  before insert or update or delete on purchase_requests
  for each row execute function purchase_requests_guard_draft_rpc();

create trigger purchase_request_items_draft_rpc_guard
  before insert or update or delete on purchase_request_items
  for each row execute function purchase_request_items_guard_draft_rpc();

create or replace function save_purchase_request_draft(
  p_request_id uuid,
  p_notes text,
  p_expected_date date,
  p_editor_step smallint,
  p_items jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role user_role := auth_role();
  v_request purchase_requests;
  v_updated_at timestamptz;
  v_item_count int;
  v_distinct_product_count int;
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office', 'kitchen') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_editor_step is null or p_editor_step not in (1, 2) then
    raise exception 'draft_invalid_step' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'draft_invalid_items' using errcode = '22023';
  end if;

  with input as (
    select * from jsonb_to_recordset(p_items) as item(
      product_id uuid,
      qty numeric,
      chosen_supplier_id uuid
    )
  )
  select count(*), count(distinct product_id)
    into v_item_count, v_distinct_product_count
  from input;

  if v_item_count <> v_distinct_product_count then
    raise exception 'draft_duplicate_product' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(product_id uuid, qty numeric, chosen_supplier_id uuid)
    left join products p
      on p.id = item.product_id and p.org_id = v_org and p.active
    where item.product_id is null or item.qty is null or item.qty <= 0 or p.id is null
  ) then
    raise exception 'draft_invalid_item' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(product_id uuid, qty numeric, chosen_supplier_id uuid)
    where item.chosen_supplier_id is not null
      and not exists (
        select 1
        from supplier_products sp
        join suppliers s on s.id = sp.supplier_id
        where sp.org_id = v_org
          and sp.product_id = item.product_id
          and sp.supplier_id = item.chosen_supplier_id
          and sp.available
          and s.org_id = v_org
          and s.deleted_at is null
          and s.status in ('active', 'problematic')
      )
  ) then
    raise exception 'draft_invalid_supplier_selection' using errcode = '22023';
  end if;

  perform set_config('app.purchase_request_draft_writer', v_user::text, true);

  if p_request_id is null then
    insert into purchase_requests (
      org_id, status, notes, expected_date, editor_step, created_by
    ) values (
      v_org, 'draft', nullif(trim(p_notes), ''), p_expected_date, p_editor_step, v_user
    )
    returning * into v_request;
  else
    select * into v_request
    from purchase_requests
    where id = p_request_id
      and org_id = v_org
      and created_by = v_user
      and status = 'draft'
    for update;

    if not found then
      raise exception 'draft_unknown' using errcode = 'P0002';
    end if;

    update purchase_requests
    set notes = nullif(trim(p_notes), ''),
        expected_date = p_expected_date,
        editor_step = p_editor_step
    where id = v_request.id;
  end if;

  delete from purchase_request_items where request_id = v_request.id;

  insert into purchase_request_items (
    request_id,
    product_id,
    qty,
    recommended_supplier_id,
    chosen_supplier_id,
    unit_price
  )
  select
    v_request.id,
    item.product_id,
    item.qty,
    recommended.supplier_id,
    coalesce(chosen.supplier_id, recommended.supplier_id),
    coalesce(chosen.current_price, recommended.current_price)
  from jsonb_to_recordset(p_items) as item(product_id uuid, qty numeric, chosen_supplier_id uuid)
  left join lateral (
    select sp.supplier_id, sp.current_price
    from supplier_products sp
    join suppliers s on s.id = sp.supplier_id
    where sp.org_id = v_org
      and sp.product_id = item.product_id
      and sp.available
      and s.org_id = v_org
      and s.deleted_at is null
      and s.status in ('active', 'problematic')
    order by sp.current_price, sp.supplier_id
    limit 1
  ) recommended on true
  left join lateral (
    select sp.supplier_id, sp.current_price
    from supplier_products sp
    join suppliers s on s.id = sp.supplier_id
    where item.chosen_supplier_id is not null
      and sp.org_id = v_org
      and sp.product_id = item.product_id
      and sp.supplier_id = item.chosen_supplier_id
      and sp.available
      and s.org_id = v_org
      and s.deleted_at is null
      and s.status in ('active', 'problematic')
  ) chosen on true;

  -- Item replacement does not touch the parent, so make every successful save observable.
  update purchase_requests set updated_at = now() where id = v_request.id
  returning updated_at into v_updated_at;

  return jsonb_build_object('request_id', v_request.id, 'updated_at', v_updated_at);
end
$$;

create or replace function cancel_purchase_request_draft(
  p_request_id uuid,
  p_reason text
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_org uuid := auth_org();
  v_user uuid := auth.uid();
  v_role user_role := auth_role();
  v_request purchase_requests;
  v_reason text := nullif(trim(p_reason), '');
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office', 'kitchen') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;

  select * into v_request
  from purchase_requests
  where id = p_request_id
    and org_id = v_org
    and created_by = v_user
    and status = 'draft'
  for update;

  if not found then
    raise exception 'draft_unknown' using errcode = 'P0002';
  end if;

  perform set_config('app.purchase_request_draft_writer', v_user::text, true);
  update purchase_requests set status = 'cancelled' where id = v_request.id;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org,
    v_user,
    'purchase_request_cancelled',
    'purchase_requests',
    v_request.id,
    jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'cancelled'),
    v_reason
  );
end
$$;

create or replace function finalize_purchase_request_draft(
  p_request_id uuid,
  p_expected_total numeric
)
returns jsonb
language plpgsql
security invoker
set search_path = public
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
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office', 'kitchen') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_expected_total is null or p_expected_total < 0 then
    raise exception 'draft_invalid_expected_total' using errcode = '22023';
  end if;

  select * into v_request
  from purchase_requests
  where id = p_request_id
    and org_id = v_org
    and created_by = v_user
    and status = 'draft'
  for update;

  if not found then
    raise exception 'draft_unknown' using errcode = 'P0002';
  end if;
  if not exists (select 1 from purchase_request_items where request_id = v_request.id) then
    raise exception 'draft_empty' using errcode = '22023';
  end if;

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
      and pri.chosen_supplier_id = v_supplier_id;

    v_order_ids := v_order_ids || jsonb_build_array(v_order_id);
    v_order_count := v_order_count + 1;
  end loop;

  update purchase_requests set status = 'split' where id = v_request.id;

  return jsonb_build_object(
    'request_id', v_request.id,
    'order_ids', v_order_ids,
    'order_count', v_order_count,
    'total', v_total
  );
end
$$;

revoke all on function public.save_purchase_request_draft(uuid, text, date, smallint, jsonb) from public;
revoke all on function public.cancel_purchase_request_draft(uuid, text) from public;
revoke all on function public.finalize_purchase_request_draft(uuid, numeric) from public;

grant execute on function public.save_purchase_request_draft(uuid, text, date, smallint, jsonb) to authenticated;
grant execute on function public.cancel_purchase_request_draft(uuid, text) to authenticated;
grant execute on function public.finalize_purchase_request_draft(uuid, numeric) to authenticated;
