-- 0176 -- Supplier metrics use one explicit rolling window: 90 days.
-- Lifetime counters and first completed receipt semantics remain byte-for-byte equivalent to 0031.

create or replace view public.supplier_metrics
with (security_invoker = on, security_barrier = on) as
with cfg as (
  select (now() - interval '90 days') as since
), deliveries as (
  select po.org_id, po.supplier_id, po.expected_date, po.sent_at,
         (select min(g.received_at)
          from public.goods_receipts g
          where g.org_id = po.org_id and g.order_id = po.id and g.status = 'completed') as received_at
  from public.purchase_orders po
  where po.org_id = auth_org() and po.status in ('received', 'partial')
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
  from public.purchase_orders po
  where po.org_id = auth_org()
    and po.status in ('ready', 'sent', 'confirmed', 'partial')
  group by po.org_id, po.supplier_id
), x as (
  select e.org_id, e.supplier_id,
    count(*) filter (where e.status in ('open','in_progress')) as open_exceptions,
    count(*) filter (where e.created_at >= (select since from cfg)) as exceptions_window,
    count(*) as exceptions_lifetime
  from public.exceptions e
  where e.org_id = auth_org() and e.supplier_id is not null
  group by e.org_id, e.supplier_id
), c as (
  select cr.org_id, cr.supplier_id,
    count(*) filter (where cr.status in ('open','requested','received')) as open_credits,
    coalesce(sum(cr.amount) filter (where cr.status in ('open','requested','received')), 0)
      as open_credits_amount,
    count(*) filter (where cr.created_at >= (select since from cfg)) as credits_window,
    count(*) as credits_lifetime
  from public.credit_requests cr
  where cr.org_id = auth_org()
  group by cr.org_id, cr.supplier_id
), price_events as (
  select h.id, h.org_id, h.supplier_product_id, h.price, h.effective_date,
    lag(h.price) over (
      partition by h.org_id, h.supplier_product_id
      order by h.effective_date, h.created_at, h.id
    ) as previous_price
  from public.price_history h
  where h.org_id = auth_org()
), p as (
  select sp.org_id, sp.supplier_id,
         count(distinct sp.id) as priced_items,
         count(h.id) as price_changes_window,
         max(h.effective_date) as last_price_change
  from public.supplier_products sp
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
from public.suppliers s
left join o on o.org_id = s.org_id and o.supplier_id = s.id
left join d on d.org_id = s.org_id and d.supplier_id = s.id
left join x on x.org_id = s.org_id and x.supplier_id = s.id
left join c on c.org_id = s.org_id and c.supplier_id = s.id
left join p on p.org_id = s.org_id and p.supplier_id = s.id
where s.org_id = auth_org() and s.deleted_at is null
  and auth_role() in ('owner', 'office');

revoke all on public.supplier_metrics from public, anon, authenticated;
grant select on public.supplier_metrics to authenticated;

do $$
declare v_definition text; v_violations text;
begin
  -- Needles are the LITERALS only, never the surrounding cast syntax. pg_get_viewdef is a
  -- deparser: it re-prints a constant from the parse tree as '90 days'::interval and never in the
  -- `interval '90 days'` prefix form this view is written in. Pinning the prefix form makes the
  -- positive test fail on every run whatever the view says, and -- worse -- makes the 180-day
  -- negative test unable to fire even if a 180-day window really did survive. The quoted literal
  -- is printed verbatim in either rendering, so it is the part that can be pinned. Same reasoning
  -- as 0171's move from pg_get_viewdef text to pg_depend: assert what the deparser cannot restyle.
  select lower(pg_get_viewdef('public.supplier_metrics'::regclass)) into v_definition;
  if position('''90 days''' in v_definition)=0
     or position('''180 days''' in v_definition)>0
     or position('min(g.received_at)' in v_definition)=0
     or position('exceptions_lifetime' in v_definition)=0
     or position('credits_lifetime' in v_definition)=0 then
    raise exception '0176: supplier metric window or preserved contracts drifted';
  end if;
  select string_agg(assertion||' -- '||detail,e'\n' order by assertion,detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0176 scope assertions failed:\n%',v_violations;
  end if;
end
$$;
