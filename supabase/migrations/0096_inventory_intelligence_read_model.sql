-- 0096 -- Read-only inventory intelligence from measured stock, recorded consumption and open POs.
-- Suggestions never mutate procurement. A missing count or missing consumption evidence stays NULL.

create view public.inventory_intelligence
with (security_invoker = on, security_barrier = on)
as
with balances as (
  select * from public.inventory_balances
), consumption as (
  select
    b.product_id,
    count(m.id)::integer as consumption_sample_count,
    coalesce(sum(-m.quantity_delta), 0)::numeric(14,2) as consumption_quantity,
    greatest(
      1::numeric,
      extract(epoch from (current_timestamp - greatest(
        b.last_counted_at,
        current_timestamp - interval '30 days'
      ))) / 86400
    ) as observed_days
  from balances b
  left join public.inventory_movements m
    on m.org_id = public.auth_org()
   and m.product_id = b.product_id
   and m.movement_type = 'consumption'
   and m.created_at >= greatest(b.last_counted_at, current_timestamp - interval '30 days')
  where b.is_counted
  group by b.product_id, b.last_counted_at
), incoming as (
  select
    poi.product_id,
    sum(greatest(poi.qty - poi.received_qty, 0))::numeric(14,2) as expected_incoming_quantity,
    sum(greatest(poi.qty - poi.received_qty, 0))
      filter (where po.expected_date is null)::numeric(14,2) as incoming_without_date_quantity,
    min(po.expected_date)
      filter (where po.expected_date is not null
        and greatest(poi.qty - poi.received_qty, 0) > 0) as next_expected_incoming_date
  from public.purchase_order_items poi
  join public.purchase_orders po
    on po.org_id = poi.org_id and po.id = poi.order_id
  where po.org_id = public.auth_org()
    and po.status in ('sent', 'confirmed', 'partial')
  group by poi.product_id
), ranked_prices as (
  select
    sp.product_id,
    sp.supplier_id,
    s.name as supplier_name,
    sp.current_price,
    sp.price_effective_date,
    row_number() over (
      partition by sp.product_id
      order by sp.current_price, sp.price_effective_date desc, sp.id
    ) as price_rank,
    count(*) over (partition by sp.product_id)::integer as supplier_price_count
  from public.supplier_products sp
  join public.suppliers s
    on s.org_id = sp.org_id and s.id = sp.supplier_id
  where sp.org_id = public.auth_org()
    and sp.available
    and s.deleted_at is null
    and s.status in ('active', 'problematic')
), price_summary as (
  select
    product_id,
    (max(supplier_id::text) filter (where price_rank = 1))::uuid as cheapest_supplier_id,
    max(supplier_name) filter (where price_rank = 1) as cheapest_supplier_name,
    max(current_price) filter (where price_rank = 1) as cheapest_unit_price,
    max(price_effective_date) filter (where price_rank = 1) as cheapest_price_effective_date,
    max(current_price) filter (where price_rank = 2)
      - max(current_price) filter (where price_rank = 1) as price_advantage,
    max(supplier_price_count) as supplier_price_count
  from ranked_prices
  group by product_id
), latest_purchase as (
  select distinct on (poi.product_id)
    poi.product_id,
    poi.unit_price as latest_purchase_unit_price,
    po.created_at as latest_purchase_at
  from public.purchase_order_items poi
  join public.purchase_orders po
    on po.org_id = poi.org_id and po.id = poi.order_id
  where po.org_id = public.auth_org()
    -- Draft/ready orders are proposals, not purchase-cost evidence. Only externally committed or
    -- received orders may become the latest historical purchase snapshot.
    and po.status in ('sent', 'confirmed', 'partial', 'received')
  order by poi.product_id, po.created_at desc, poi.id desc
), evidence as (
  select
    b.*,
    c.consumption_sample_count,
    case when c.consumption_sample_count > 0 then c.consumption_quantity else null end
      as consumption_quantity,
    case when c.consumption_sample_count > 0
      then round(c.consumption_quantity / c.observed_days, 4)
      else null
    end as average_daily_consumption,
    coalesce(i.expected_incoming_quantity, 0)::numeric(14,2) as expected_incoming_quantity,
    coalesce(i.incoming_without_date_quantity, 0)::numeric(14,2)
      as incoming_without_date_quantity,
    i.next_expected_incoming_date
  from balances b
  left join consumption c on c.product_id = b.product_id
  left join incoming i on i.product_id = b.product_id
)
select
  e.*,
  case
    when e.quantity_on_hand is null or e.average_daily_consumption is null then null
    else round(
      -- Incoming orders are not credited before their expected date. A quantity with no
      -- date is evidence of incoming supply, not evidence that today's stockout is avoided.
      greatest(e.quantity_on_hand, 0)
      / nullif(e.average_daily_consumption, 0),
      1
    )
  end as projected_stockout_days,
  case
    when e.quantity_on_hand is null or e.min_stock is null then null
    else greatest(
      -- The minimum-stock suggestion is deliberately conservative. Timing policy for
      -- incoming POs is not a business rule we may invent; show those quantities separately.
      e.min_stock - e.quantity_on_hand,
      0
    )::numeric(14,2)
  end as suggested_reorder_quantity,
  ps.cheapest_supplier_id,
  ps.cheapest_supplier_name,
  ps.cheapest_unit_price,
  ps.cheapest_price_effective_date,
  ps.price_advantage,
  ps.supplier_price_count,
  lp.latest_purchase_unit_price,
  lp.latest_purchase_at
from evidence e
left join price_summary ps on ps.product_id = e.product_id
left join latest_purchase lp on lp.product_id = e.product_id
where public.auth_role() in ('owner', 'office', 'kitchen');

revoke all on public.inventory_intelligence from public, anon, authenticated;
grant select on public.inventory_intelligence to authenticated;

comment on view public.inventory_intelligence is
  'Tenant-scoped read model. Consumption uses recorded consumption since the latest count, capped at 30 days. Stockout and reorder use measured on-hand stock only; incoming quantity/date evidence is shown separately and never assumed available early. Suggestions never write.';

do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0096 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
