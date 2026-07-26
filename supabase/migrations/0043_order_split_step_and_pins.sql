-- 0043 — A third editor step, and pins that survive a reload.
-- Forward-only after 0035. Two independent facts:
--   (a) editor_step gains a third value: the final summary is a step, not a modal.
--   (b) purchase_request_items records WHY a supplier was chosen — user pin vs auto-split.
-- chosen_supplier_id keeps its exact meaning ("what will actually be ordered"), so
-- finalize_purchase_request_draft (0023:2606) is untouched.

-- ===== 1. editor_step in (1, 2, 3) =====

alter table purchase_requests
  drop constraint purchase_requests_editor_step_check;
alter table purchase_requests
  add constraint purchase_requests_editor_step_check check (editor_step in (1, 2, 3));

-- ===== 2. pinned_supplier_id — a user fact, nullable on purpose =====

alter table purchase_request_items
  add column pinned_supplier_id uuid;

-- Mirrors p0_pri_chosen_supplier_tenant_fk (0021:206): a pin may never cross a tenant.
alter table purchase_request_items
  add constraint p0_pri_pinned_supplier_tenant_fk
  foreign key (org_id, pinned_supplier_id) references suppliers(org_id, id) not valid;
alter table purchase_request_items
  validate constraint p0_pri_pinned_supplier_tenant_fk;

comment on column purchase_request_items.pinned_supplier_id is
  'Supplier the user pinned by hand. NULL = the line is auto-split to the cheapest usable offer. '
  'A pin that is currently unusable (qty below min_qty, offer withdrawn, supplier soft-deleted) is '
  'still stored, so a reload returns the user to the same "fix me" state instead of a silent '
  'fallback. chosen_supplier_id stays "what will actually be ordered".';

create or replace function save_purchase_request_draft(
  p_request_id uuid,
  p_notes text,
  p_expected_date date,
  p_editor_step smallint,
  p_items jsonb
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
  v_updated_at timestamptz;
  v_item_count int;
  v_distinct_product_count int;
begin
  if v_org is null or v_user is null or v_role not in ('owner', 'office', 'kitchen') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_editor_step is null or p_editor_step not in (1, 2, 3) then
    raise exception 'draft_invalid_step' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'draft_invalid_items' using errcode = '22023';
  end if;

  with input as (
    select * from jsonb_to_recordset(p_items) as item(
      product_id uuid,
      qty numeric,
      chosen_supplier_id uuid,
      pinned_supplier_id uuid
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
    from jsonb_to_recordset(p_items) as item(product_id uuid, qty numeric, chosen_supplier_id uuid, pinned_supplier_id uuid)
    left join products p
      on p.id = item.product_id and p.org_id = v_org and p.active
    where item.product_id is null or item.qty is null or item.qty <= 0 or p.id is null
  ) then
    raise exception 'draft_invalid_item' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(product_id uuid, qty numeric, chosen_supplier_id uuid, pinned_supplier_id uuid)
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
    unit_price,
    pinned_supplier_id
  )
  select
    v_request.id,
    item.product_id,
    item.qty,
    recommended.supplier_id,
    coalesce(chosen.supplier_id, recommended.supplier_id),
    coalesce(chosen.current_price, recommended.current_price),
    item.pinned_supplier_id
  from jsonb_to_recordset(p_items) as item(product_id uuid, qty numeric, chosen_supplier_id uuid, pinned_supplier_id uuid)
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

do $$
begin
  if not (
    select p.prosecdef
    from pg_proc p
    where p.oid = to_regprocedure('public.save_purchase_request_draft(uuid,text,date,smallint,jsonb)')
  ) then
    raise exception 'save_purchase_request_draft lost SECURITY DEFINER' using errcode = '42501';
  end if;
  if not has_function_privilege(
       'authenticated',
       to_regprocedure('public.save_purchase_request_draft(uuid,text,date,smallint,jsonb)'),
       'EXECUTE'
     ) then
    raise exception 'save_purchase_request_draft lost its authenticated grant' using errcode = '42501';
  end if;
end
$$;
