-- Durable price-comparison evidence and supplier operational KPIs.

alter table purchase_requests
  add column split_total numeric(12,2),
  add column single_supplier_total numeric(12,2),
  add column single_supplier_id uuid,
  add column savings_amount numeric(12,2),
  add column savings_percent numeric(8,1),
  add column pricing_snapshot_at timestamptz,
  add constraint purchase_requests_split_total_nonnegative
    check (split_total is null or split_total >= 0),
  add constraint purchase_requests_single_supplier_total_nonnegative
    check (single_supplier_total is null or single_supplier_total >= 0),
  add constraint purchase_requests_savings_snapshot_shape check (
    (
      split_total is null and single_supplier_total is null and single_supplier_id is null
      and savings_amount is null and savings_percent is null and pricing_snapshot_at is null
    )
    or
    (
      split_total is not null and pricing_snapshot_at is not null
      and (
        (
          single_supplier_total is null and single_supplier_id is null
          and savings_amount is null and savings_percent is null
        )
        or
        (
          single_supplier_total is not null and single_supplier_id is not null
          and savings_amount = single_supplier_total - split_total
          and (
            (single_supplier_total = 0 and savings_percent is null)
            or
            (single_supplier_total > 0 and savings_percent = round(
              ((single_supplier_total - split_total) / single_supplier_total) * 100, 1
            ))
          )
        )
      )
    )
  ),
  add constraint purchase_requests_single_supplier_fk
    foreign key (org_id, single_supplier_id) references suppliers(org_id, id) on delete restrict;

create or replace function guard_purchase_request_savings_snapshot()
returns trigger
language plpgsql security invoker set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_changed boolean;
begin
  if tg_op = 'INSERT' then
    if new.split_total is not null or new.single_supplier_total is not null
       or new.single_supplier_id is not null or new.savings_amount is not null
       or new.savings_percent is not null or new.pricing_snapshot_at is not null then
      raise exception 'purchase_request_snapshot_rpc_required' using errcode = '42501';
    end if;
    return new;
  end if;

  v_changed := row(
    old.split_total, old.single_supplier_total, old.single_supplier_id,
    old.savings_amount, old.savings_percent, old.pricing_snapshot_at
  ) is distinct from row(
    new.split_total, new.single_supplier_total, new.single_supplier_id,
    new.savings_amount, new.savings_percent, new.pricing_snapshot_at
  );

  if v_changed and not (
    old.status = 'draft' and new.status = 'split'
    and v_user is not null
    and current_setting('app.purchase_request_draft_writer', true) = v_user::text
  ) then
    raise exception 'purchase_request_snapshot_immutable' using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger purchase_requests_savings_snapshot_guard
before insert or update on purchase_requests
for each row execute function guard_purchase_request_savings_snapshot();

revoke all on function guard_purchase_request_savings_snapshot() from public, anon, authenticated;

-- Draft recommendations and explicit selections use the same minimum-quantity eligibility rule.
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
          and (sp.min_qty is null or item.qty >= sp.min_qty)
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
      and (sp.min_qty is null or item.qty >= sp.min_qty)
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
      and (sp.min_qty is null or item.qty >= sp.min_qty)
      and s.org_id = v_org
      and s.deleted_at is null
      and s.status in ('active', 'problematic')
  ) chosen on true;

  update purchase_requests set updated_at = now() where id = v_request.id
  returning updated_at into v_updated_at;

  return jsonb_build_object('request_id', v_request.id, 'updated_at', v_updated_at);
end
$$;

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
  v_total numeric(12,2);
  v_single_total numeric(12,2);
  v_single_supplier uuid;
  v_savings numeric(12,2);
  v_savings_percent numeric(8,1);
  v_snapshot_at timestamptz;
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
    select coalesce(jsonb_agg(po.id order by po.supplier_id, po.id), '[]'::jsonb), count(*)
      into v_order_ids, v_order_count
    from purchase_orders po
    where po.org_id = v_org and po.request_id = v_request.id;

    if v_request.split_total is null then
      select round(coalesce(sum(poi.qty * poi.unit_price), 0), 2)
        into v_total
      from purchase_orders po
      join purchase_order_items poi on poi.order_id = po.id
      where po.org_id = v_org and po.request_id = v_request.id;
    else
      v_total := v_request.split_total;
    end if;

    if v_total is distinct from round(p_expected_total, 2) then
      raise exception 'draft_price_changed' using errcode = 'P0001';
    end if;
    return jsonb_build_object(
      'request_id', v_request.id,
      'order_ids', v_order_ids,
      'order_count', v_order_count,
      'total', v_total,
      'split_total', v_request.split_total,
      'single_supplier_total', v_request.single_supplier_total,
      'single_supplier_id', v_request.single_supplier_id,
      'savings_amount', v_request.savings_amount,
      'savings_percent', v_request.savings_percent,
      'pricing_snapshot_at', v_request.pricing_snapshot_at,
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

  -- Match the price-import lock order: suppliers -> products -> supplier_products. Lock all
  -- rows that could affect eligibility, including currently inactive/unavailable offers, so
  -- status, deletion, product activity or availability cannot change under the snapshot.
  perform 1
  from suppliers s
  where s.org_id = v_org and exists (
    select 1
    from supplier_products sp
    join purchase_request_items pri
      on pri.request_id = v_request.id and pri.product_id = sp.product_id
    where sp.org_id = v_org and sp.supplier_id = s.id
  )
  order by s.id
  for update of s;

  perform 1
  from products p
  where p.org_id = v_org and exists (
    select 1 from purchase_request_items pri
    where pri.request_id = v_request.id and pri.product_id = p.id
  )
  order by p.id
  for update of p;

  perform 1
  from supplier_products sp
  where sp.org_id = v_org and exists (
    select 1 from purchase_request_items pri
    where pri.request_id = v_request.id and pri.product_id = sp.product_id
  )
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
     and (sp.min_qty is null or pri.qty >= sp.min_qty)
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

  -- A recommendation is automatic when chosen=recommended. Re-evaluate those lines after
  -- locking every candidate so a newly cheaper competitor cannot silently leave a stale split.
  if exists (
    select 1
    from purchase_request_items pri
    left join lateral (
      select sp.supplier_id, sp.current_price
      from supplier_products sp
      join suppliers s
        on s.org_id = sp.org_id and s.id = sp.supplier_id
       and s.deleted_at is null and s.status in ('active', 'problematic')
      where sp.org_id = v_org
        and sp.product_id = pri.product_id
        and sp.available
        and (sp.min_qty is null or pri.qty >= sp.min_qty)
      order by sp.current_price, sp.supplier_id
      limit 1
    ) cheapest on true
    where pri.request_id = v_request.id
      and pri.chosen_supplier_id = pri.recommended_supplier_id
      and (
        cheapest.supplier_id is distinct from pri.recommended_supplier_id
        or cheapest.current_price is distinct from pri.unit_price
      )
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

  select candidate.supplier_id, candidate.total
    into v_single_supplier, v_single_total
  from (
    select sp.supplier_id, round(sum(pri.qty * sp.current_price), 2)::numeric(12,2) as total
    from purchase_request_items pri
    join supplier_products sp
      on sp.org_id = v_org and sp.product_id = pri.product_id and sp.available
     and (sp.min_qty is null or pri.qty >= sp.min_qty)
    join suppliers s
      on s.org_id = sp.org_id and s.id = sp.supplier_id
     and s.deleted_at is null and s.status in ('active', 'problematic')
    where pri.request_id = v_request.id
    group by sp.supplier_id
    having count(*) = (
      select count(*) from purchase_request_items where request_id = v_request.id
    )
  ) candidate
  order by candidate.total, candidate.supplier_id
  limit 1;

  if v_single_supplier is not null then
    v_savings := v_single_total - v_total;
    v_savings_percent := case
      when v_single_total > 0 then round((v_savings / v_single_total) * 100, 1)
      else null
    end;
  end if;
  v_snapshot_at := now();

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
      v_org, v_supplier_id, v_request.id, 'ready',
      v_request.expected_date, v_request.notes, v_user
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

  update purchase_requests
  set status = 'split',
      split_total = v_total,
      single_supplier_total = v_single_total,
      single_supplier_id = v_single_supplier,
      savings_amount = v_savings,
      savings_percent = v_savings_percent,
      pricing_snapshot_at = v_snapshot_at
  where id = v_request.id;

  insert into audit_logs (
    org_id, user_id, action, entity_type, entity_id, old_values, new_values, reason
  ) values (
    v_org, v_user, 'purchase_request_finalized', 'purchase_requests', v_request.id,
    jsonb_build_object('status', 'draft'),
    jsonb_build_object(
      'status', 'split',
      'order_ids', v_order_ids,
      'order_count', v_order_count,
      'split_total', v_total,
      'single_supplier_total', v_single_total,
      'single_supplier_id', v_single_supplier,
      'savings_amount', v_savings,
      'savings_percent', v_savings_percent,
      'pricing_snapshot_at', v_snapshot_at
    ),
    v_reason
  );

  return jsonb_build_object(
    'request_id', v_request.id,
    'order_ids', v_order_ids,
    'order_count', v_order_count,
    'total', v_total,
    'split_total', v_total,
    'single_supplier_total', v_single_total,
    'single_supplier_id', v_single_supplier,
    'savings_amount', v_savings,
    'savings_percent', v_savings_percent,
    'pricing_snapshot_at', v_snapshot_at,
    'idempotent', false
  );
end
$$;

-- Supplier scorecard now includes the current operational order load.
drop view supplier_metrics;
create view supplier_metrics with (security_invoker = on, security_barrier = on) as
with cfg as (
  select (now() - interval '180 days') as since
), deliveries as (
  select po.org_id, po.supplier_id, po.expected_date, po.sent_at,
         (select max(g.received_at)
          from goods_receipts g
          where g.org_id = po.org_id and g.order_id = po.id and g.status = 'completed') as received_at
  from purchase_orders po
  where po.org_id = auth_org() and po.status = 'received'
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
), o as (
  select po.org_id, po.supplier_id,
    count(*) as open_orders,
    count(*) filter (
      where po.expected_date is not null
        and po.status <> 'ready'
        and po.expected_date < (now() at time zone 'Asia/Jerusalem')::date
    ) as late_open_orders
  from purchase_orders po
  where po.org_id = auth_org() and po.status in ('ready', 'sent', 'confirmed', 'partial')
  group by po.org_id, po.supplier_id
), x as (
  select e.org_id, e.supplier_id,
    count(*) filter (where e.status in ('open','in_progress')) as open_exceptions,
    count(*) filter (where e.created_at >= (select since from cfg)) as exceptions_window,
    count(*) as exceptions_lifetime
  from exceptions e
  where e.org_id = auth_org() and e.supplier_id is not null
  group by e.org_id, e.supplier_id
), c as (
  select cr.org_id, cr.supplier_id,
    count(*) filter (where cr.status in ('open','requested','received')) as open_credits,
    coalesce(sum(cr.amount) filter (where cr.status in ('open','requested','received')), 0)
      as open_credits_amount,
    count(*) filter (where cr.created_at >= (select since from cfg)) as credits_window,
    count(*) as credits_lifetime
  from credit_requests cr
  where cr.org_id = auth_org()
  group by cr.org_id, cr.supplier_id
), price_events as (
  select
    h.id,
    h.org_id,
    h.supplier_product_id,
    h.price,
    h.effective_date,
    lag(h.price) over (
      partition by h.org_id, h.supplier_product_id
      order by h.effective_date, h.created_at, h.id
    ) as previous_price
  from price_history h
  where h.org_id = auth_org()
), p as (
  select sp.org_id, sp.supplier_id,
         count(distinct sp.id) as priced_items,
         count(h.id) as price_changes_window,
         max(h.effective_date) as last_price_change
  from supplier_products sp
  left join price_events h
    on h.org_id = sp.org_id and h.supplier_product_id = sp.id
   and h.effective_date >= (select since::date from cfg)
   and h.previous_price is not null
   and h.price is distinct from h.previous_price
  where sp.org_id = auth_org()
  group by sp.org_id, sp.supplier_id
)
select s.id as supplier_id,
  coalesce(o.open_orders, 0) as open_orders,
  coalesce(o.late_open_orders, 0) as late_open_orders,
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
from suppliers s
left join o on o.org_id = s.org_id and o.supplier_id = s.id
left join d on d.org_id = s.org_id and d.supplier_id = s.id
left join x on x.org_id = s.org_id and x.supplier_id = s.id
left join c on c.org_id = s.org_id and c.supplier_id = s.id
left join p on p.org_id = s.org_id and p.supplier_id = s.id
where s.org_id = auth_org() and s.deleted_at is null
  and auth_role() in ('owner','office','kitchen','accountant');

revoke all on supplier_metrics from public, anon, authenticated;
grant select on supplier_metrics to authenticated;
