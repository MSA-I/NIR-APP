-- OWNER DECISIONS #189 and #190 (21.08.2026) -- the two server read models the assistant is
-- allowed to explain, and is not allowed to compute.
--
-- ===== WHY BOTH LIVE HERE =====
--
-- #189 ("which suppliers raised a price this month") and #190 ("supplier recommendation, estimated
-- saving, purchase proposal") are one campaign with one rule behind them: the SERVER owns the
-- calculation and the assistant may only cite what the server returned. Splitting them across two
-- migrations would split that rule across two files while the tools that consume them ship
-- together. The two functions share nothing but the discipline, and each is documented on its own
-- terms below.
--
-- ===== #189 -- WHAT "A SUPPLIER RAISED A PRICE THIS MONTH" MEANS =====
--
-- Calendar month in `Asia/Jerusalem`, from the 1st at 00:00 local (#178: the product's word "month"
-- is a calendar month, and a trailing window may only ever be called "the last 30 days"). For every
-- `supplier_product`, the CURRENT effective price is compared against the last price that was in
-- effect at that month start, and only a NET POSITIVE difference is reported. A price that rose
-- mid-month and came back to -- or below -- the baseline is not a rise, because the comparison is
-- against the baseline and not against the peak. There is no threshold: #189 says every positive
-- delta, in money and in percent.
--
-- This deliberately does NOT use `supplier_metrics.price_changes_window`, which counts changes over
-- a trailing 180 days (0012, #31). That number answers "how volatile is this supplier", not "what
-- did they raise this month", and it counts changes in both directions.
--
-- THE BASELINE, in three cases, none of which is a guess:
--
--   1. A `price_history` row whose `effective_date` is on or before the month start. That is the
--      price the organization was paying when the month opened, and it is the authoritative
--      baseline. Ties break `(effective_date desc, created_at desc, id desc)` -- the ordering
--      0027, 0031 and 0105 already use, and the one that makes a price-list reversal's
--      compensating row win over the row it compensates.
--
--   2. No such row, but the product's `price_effective_date` predates the month start. Then the
--      current price was already in effect when the month opened: the delta is provably zero, the
--      row is measurable and it is simply not a rise. Calling that "unmeasurable" would be false
--      caution -- we can see the price did not move this month.
--
--   3. No such row and `price_effective_date` falls inside the month. The price changed, or first
--      appeared, after the month opened and we hold no record of what preceded it. That row is
--      UNMEASURABLE (`לא ניתן למדוד`) and is excluded from every count and total. #189 is explicit
--      that this must never be counted as zero: zero is a claim that the supplier held their price,
--      and we do not know that.
--
-- 0105's `private.supplier_price_effective_on()` is deliberately not reused. Its job is to answer
-- "what did we agree to pay on the day this DOCUMENT is dated", and to keep answering when history
-- runs out it falls back to `earliest_price_history` and then to `current_price`, labelling each so
-- the reviewer can see which. Those fallbacks are exactly what #189 forbids here: a comparison of
-- the current price against the current price is a manufactured zero.
--
-- SECURITY INVOKER, on purpose. `supplier_products` and `price_history` already carry RLS policies
-- that admit `org_id = auth_org()` and `auth_role() in ('owner','office')` -- the same pair
-- `APP_ROUTE_POLICY.prices` grants the /prices screen. Running as the invoker makes those policies
-- the boundary, so an accountant receives zero rows rather than an error that would confirm the
-- rows exist. A definer here would need its own role check, would be a second copy of the
-- authorization rule, and would cost an A5 review for no gain.
--
-- ===== #190 -- WHAT THE COMPARISON READ MODEL IS, AND WHAT IT REFUSES TO DO =====
--
-- At launch the assistant EXPLAINS the existing comparison. It does not invent one. So this read
-- model returns the same offer set, the same automatic choice and the same supplier-minimum facts
-- the New Order screen works from, computed on the server at run time:
--
--   * The input is quantities the USER entered, or an existing draft (`purchase_requests` in
--     `draft`, read under the caller's own RLS, which already limits a draft to the person who
--     created it). It is never a quantity a model chose.
--   * The automatic choice is `order by current_price, preferred desc, supplier_id` -- 0115
--     verbatim. A preferred supplier breaks a tie and never wins one (#145).
--   * A supplier minimum that the basket does not clear is returned as a BREACH with its shortfall.
--     The quantity is never raised to clear it: #190 says return the breach, and #182 forbids the
--     assistant proposing or writing anything at all.
--   * `purchase_orders` and `purchase_order_items` are not read and not written. #182 names them
--     explicitly, and an order that already exists keeps its price snapshot regardless.
--
-- What it does NOT return is the saving. `saved`/`extra` are computed by `src/lib/orderComparison.ts`
-- (`compareLine`/`summarizeComparison`), which the product's own comparison panel uses and which
-- the Edge tool imports directly. One formula, one file -- a second implementation in SQL would be
-- a second answer waiting to disagree with the screen the user is being sent to.
--
-- A product with no alternative offer is `—` and not `0`: the read model returns its single offer
-- and the shared formula returns `single_offer` with a null gap, because "you saved nothing" and
-- "there was nothing to compare against" are different statements.

-- =====================================================================================
-- 1. #189 -- the monthly supplier price-rise read model
-- =====================================================================================
create or replace function public.supplier_monthly_price_rises(p_limit integer default 100)
returns table (
  supplier_id                 uuid,
  supplier_name               text,
  product_id                  uuid,
  product_name                text,
  supplier_product_id         uuid,
  measurable                  boolean,
  unmeasurable_reason         text,
  baseline_price              numeric,
  baseline_source             text,
  baseline_as_of              date,
  current_price               numeric,
  current_as_of               date,
  delta_amount                numeric,
  delta_percent               numeric,
  supplier_rise_count         bigint,
  supplier_rise_total         numeric,
  supplier_unmeasurable_count bigint,
  measured_rise_rows          bigint,
  unmeasurable_rows           bigint,
  month_start                 timestamptz,
  month_end                   timestamptz,
  time_zone                   text
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with bounds as (
    select date_trunc('month', now() at time zone 'Asia/Jerusalem') as local_start,
           (date_trunc('month', now() at time zone 'Asia/Jerusalem') + interval '1 month')
             as local_end
  ),
  window_bounds as (
    select (local_start at time zone 'Asia/Jerusalem') as month_start,
           (local_end   at time zone 'Asia/Jerusalem') as month_end,
           local_start::date as month_start_date
    from bounds
  ),
  -- RLS on supplier_products, price_history, suppliers and products is the tenancy and role
  -- boundary here; nothing below re-states it, so the two rules cannot drift apart.
  offers as (
    select sp.id as supplier_product_id,
           sp.supplier_id,
           supplier.name as supplier_name,
           sp.product_id,
           coalesce(product.display_name, product.name) as product_name,
           sp.current_price,
           sp.price_effective_date,
           window_bounds.month_start,
           window_bounds.month_end,
           window_bounds.month_start_date
    from supplier_products sp
    cross join window_bounds
    join suppliers supplier
      on supplier.id = sp.supplier_id and supplier.deleted_at is null
    join products product
      on product.id = sp.product_id and product.active
  ),
  baselined as (
    select offers.*,
           baseline.price as history_price,
           baseline.effective_date as history_as_of
    from offers
    left join lateral (
      select history.price, history.effective_date
      from price_history history
      where history.supplier_product_id = offers.supplier_product_id
        and history.effective_date <= offers.month_start_date
      order by history.effective_date desc, history.created_at desc, history.id desc
      limit 1
    ) baseline on true
  ),
  classified as (
    select baselined.*,
           case
             when baselined.history_price is not null then 'price_history'
             when baselined.price_effective_date < baselined.month_start_date
               then 'current_price_effective_before_month'
             else null
           end as baseline_source,
           case
             when baselined.history_price is not null then baselined.history_price
             when baselined.price_effective_date < baselined.month_start_date
               then baselined.current_price
             else null
           end as baseline_price,
           case
             when baselined.history_price is not null then baselined.history_as_of
             when baselined.price_effective_date < baselined.month_start_date
               then baselined.price_effective_date
             else null
           end as baseline_as_of
    from baselined
  ),
  measured as (
    select classified.*,
           classified.baseline_price is not null as measurable,
           case when classified.baseline_price is null
                then 'no_baseline_at_month_start' end as unmeasurable_reason,
           case when classified.baseline_price is not null
                then classified.current_price - classified.baseline_price end as delta_amount
    from classified
  ),
  -- Only two kinds of row leave this function: a NET RISE, and a row nobody can measure. A product
  -- whose price fell, or rose and returned to the baseline, is silent -- it is not news, and
  -- reporting it as a zero rise would put a number on a screen that claims something happened.
  reported as (
    select * from measured
    where (measurable and delta_amount > 0) or not measurable
  ),
  counted as (
    select reported.*,
           count(*) filter (where reported.measurable)
             over (partition by reported.supplier_id) as supplier_rise_count,
           coalesce(sum(reported.delta_amount) filter (where reported.measurable)
             over (partition by reported.supplier_id), 0) as supplier_rise_total,
           count(*) filter (where not reported.measurable)
             over (partition by reported.supplier_id) as supplier_unmeasurable_count,
           count(*) filter (where reported.measurable) over () as measured_rise_rows,
           count(*) filter (where not reported.measurable) over () as unmeasurable_rows
    from reported
  )
  select counted.supplier_id,
         counted.supplier_name,
         counted.product_id,
         counted.product_name,
         counted.supplier_product_id,
         counted.measurable,
         counted.unmeasurable_reason,
         counted.baseline_price,
         counted.baseline_source,
         counted.baseline_as_of,
         counted.current_price,
         counted.price_effective_date,
         counted.delta_amount,
         -- A baseline of zero has no percentage. `null` and not `0`: the money delta is still true
         -- and the percentage is genuinely undefined.
         case when counted.delta_amount is not null and counted.baseline_price > 0
              then round(counted.delta_amount * 100 / counted.baseline_price, 1) end,
         counted.supplier_rise_count,
         counted.supplier_rise_total,
         counted.supplier_unmeasurable_count,
         counted.measured_rise_rows,
         counted.unmeasurable_rows,
         counted.month_start,
         counted.month_end,
         'Asia/Jerusalem'
  from counted
  -- Grouped by supplier with per-product detail (#189), and deterministic so a truncated read is
  -- the same truncated read next time. Measurable rises come first within a supplier; the
  -- unmeasurable rows follow, still visible, still not counted.
  order by counted.supplier_name, counted.supplier_id,
           counted.measurable desc, counted.delta_amount desc nulls last,
           counted.product_name, counted.product_id
  limit greatest(coalesce(p_limit, 100), 1)
$$;
revoke all on function public.supplier_monthly_price_rises(integer) from public, anon;
grant execute on function public.supplier_monthly_price_rises(integer) to authenticated;

comment on function public.supplier_monthly_price_rises(integer) is
  'Net price rises this CALENDAR month in Asia/Jerusalem, per supplier with product detail (0203, '
  '#189/#178). The baseline is the last price_history row in effect at the month start; a product '
  'whose price rose and returned to that baseline is absent, and a product with no authoritative '
  'baseline is returned with measurable=false and counted nowhere -- never as a zero. SECURITY '
  'INVOKER: the existing owner/office RLS on supplier_products and price_history is the boundary.';

-- =====================================================================================
-- 2. #190 -- the purchase comparison read model
-- =====================================================================================
create or replace function public.purchase_comparison(
  p_lines      jsonb default null,
  p_request_id uuid  default null
) returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_limit    constant integer := 60;
  v_lines    jsonb;
  v_source   text;
  v_request  purchase_requests;
  v_count    integer;
  v_result   jsonb;
begin
  -- Exactly one input. Accepting both and preferring one would let a caller pass a draft id and a
  -- different set of quantities and never learn which the answer described.
  if (p_lines is null) = (p_request_id is null) then
    raise exception 'purchase_comparison_input_ambiguous' using errcode = '22023';
  end if;

  if p_request_id is not null then
    -- Under the caller's own RLS: `purchase_requests_select` already limits a draft to the person
    -- who created it, so this cannot become a way to read somebody else's basket.
    select * into v_request from purchase_requests
    where id = p_request_id and status = 'draft';
    if not found then
      raise exception 'purchase_comparison_draft_unknown' using errcode = 'P0002';
    end if;
    select jsonb_agg(jsonb_build_object('product_id', item.product_id, 'qty', item.qty)
                     order by item.product_id)
      into v_lines
    from purchase_request_items item
    where item.request_id = v_request.id;
    v_lines := coalesce(v_lines, '[]'::jsonb);
    v_source := 'draft';
  else
    if jsonb_typeof(p_lines) <> 'array' then
      raise exception 'purchase_comparison_input_invalid' using errcode = '22023';
    end if;
    v_lines := p_lines;
    v_source := 'input';
  end if;

  select count(*) into v_count from jsonb_array_elements(v_lines);
  if v_count > v_limit then
    raise exception 'purchase_comparison_too_many_lines' using errcode = '22023';
  end if;

  with requested as (
    select (line ->> 'product_id')::uuid as product_id,
           (line ->> 'qty')::numeric     as qty,
           ordinality                    as position
    from jsonb_array_elements(v_lines) with ordinality as entry(line, ordinality)
  ),
  validated as (
    select * from requested
    where product_id is not null and qty is not null and qty > 0
  ),
  -- Every offer the product itself would show: available, from a live supplier, at the price that
  -- is current AT RUN TIME (#190 -- the comparison is priced now, and an order already created
  -- keeps its own snapshot).
  offers as (
    select validated.product_id,
           validated.qty,
           validated.position,
           sp.supplier_id,
           supplier.name as supplier_name,
           supplier.preferred,
           supplier.min_order_amount,
           sp.current_price,
           sp.min_qty
    from validated
    join supplier_products sp on sp.product_id = validated.product_id and sp.available
    join suppliers supplier
      on supplier.id = sp.supplier_id
     and supplier.deleted_at is null
     and supplier.status = 'active'
  ),
  chosen as (
    select distinct on (offers.product_id)
           offers.product_id, offers.supplier_id, offers.current_price, offers.qty
    from offers
    where offers.min_qty is null or offers.qty >= offers.min_qty
    -- 0115 verbatim: price first, preference only as the tie-break, supplier id to make the
    -- outcome deterministic rather than a coin flip (#145).
    order by offers.product_id, offers.current_price, offers.preferred desc, offers.supplier_id
  ),
  lines as (
    select validated.product_id,
           coalesce(product.display_name, product.name) as product_name,
           product.unit,
           validated.qty,
           validated.position,
           chosen.supplier_id as chosen_supplier_id,
           chosen.current_price as chosen_unit_price,
           case when chosen.supplier_id is not null
                then round(validated.qty * chosen.current_price, 2) end as line_total,
           case
             when not exists (select 1 from offers where offers.product_id = validated.product_id)
               then 'no_offers'
             when chosen.supplier_id is null then 'no_usable_offer'
             else 'ok'
           end as status,
           coalesce((
             select jsonb_agg(jsonb_build_object(
                      'supplier_id', offers.supplier_id,
                      'supplier_name', offers.supplier_name,
                      'preferred', offers.preferred,
                      'unit_price', offers.current_price,
                      'min_qty', offers.min_qty,
                      'meets_min_qty', offers.min_qty is null or offers.qty >= offers.min_qty)
                    order by offers.current_price, offers.preferred desc, offers.supplier_id)
             from offers where offers.product_id = validated.product_id), '[]'::jsonb) as offer_rows
    from validated
    left join products product on product.id = validated.product_id
    left join chosen on chosen.product_id = validated.product_id
  ),
  supplier_totals as (
    select lines.chosen_supplier_id as supplier_id,
           sum(lines.line_total) as subtotal
    from lines
    where lines.chosen_supplier_id is not null
    group by lines.chosen_supplier_id
  ),
  -- The supplier minimum is REPORTED, never resolved. #190 forbids raising a quantity to clear it
  -- and #182 forbids the assistant proposing anything at all; the shortfall is the fact the user
  -- needs in order to decide for themselves.
  supplier_rows as (
    select supplier_totals.supplier_id,
           supplier.name as supplier_name,
           supplier_totals.subtotal,
           supplier.min_order_amount,
           supplier.min_order_amount is not null
             and supplier_totals.subtotal < supplier.min_order_amount as below_minimum,
           case when supplier.min_order_amount is not null
                 and supplier_totals.subtotal < supplier.min_order_amount
                then round(supplier.min_order_amount - supplier_totals.subtotal, 2) end as shortfall
    from supplier_totals
    join suppliers supplier on supplier.id = supplier_totals.supplier_id
  )
  select jsonb_build_object(
    'as_of', now(),
    'source', v_source,
    'request_id', v_request.id,
    'time_zone', 'Asia/Jerusalem',
    'requested_lines', v_count,
    'result_count', (select count(*) from lines),
    -- A line whose product id was unreadable, or whose quantity was absent or not positive, is
    -- dropped rather than defaulted, and `complete` says so instead of the answer looking whole.
    'complete', (select count(*) from lines) = v_count,
    'has_more', false,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'product_id', lines.product_id,
               'product_name', lines.product_name,
               'unit', lines.unit,
               'qty', lines.qty,
               'status', lines.status,
               'chosen_supplier_id', lines.chosen_supplier_id,
               'chosen_unit_price', lines.chosen_unit_price,
               'line_total', lines.line_total,
               'offers', lines.offer_rows)
             order by lines.position)
      from lines), '[]'::jsonb),
    'suppliers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'supplier_id', supplier_rows.supplier_id,
               'supplier_name', supplier_rows.supplier_name,
               'subtotal', supplier_rows.subtotal,
               'min_order_amount', supplier_rows.min_order_amount,
               'below_minimum', supplier_rows.below_minimum,
               'shortfall', supplier_rows.shortfall)
             order by supplier_rows.supplier_name, supplier_rows.supplier_id)
      from supplier_rows), '[]'::jsonb),
    'minimum_breaches', (select count(*) from supplier_rows where below_minimum)
  ) into v_result;

  return v_result;
end
$$;
revoke all on function public.purchase_comparison(jsonb, uuid) from public, anon;
grant execute on function public.purchase_comparison(jsonb, uuid) to authenticated;

comment on function public.purchase_comparison(jsonb, uuid) is
  'The canonical purchase comparison as of NOW (0203, #190/#145/#155/#182): every available offer '
  'per line, the automatic choice by price with preference only as a tie-break, per-supplier '
  'subtotals and supplier-minimum breaches with their shortfall. Input is user quantities or an '
  'existing draft, never a model''s. It writes nothing, reads no purchase order, and computes no '
  'saving -- src/lib/orderComparison.ts owns that formula for the screen and the assistant alike.';

-- =====================================================================================
-- 3. Structural re-assertion
-- =====================================================================================
do $assert_0203$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0203 scope assertions failed:\n%', v_violations;
  end if;
  select string_agg(detail, e'\n' order by detail)
    into v_violations from private.tenant_export_registry_violations();
  if v_violations is not null then
    raise exception e'0203 tenant export assertions failed:\n%', v_violations;
  end if;
end
$assert_0203$;

-- =====================================================================================
-- 4. Anchors
-- =====================================================================================
do $anchor_0203$
declare
  v_secdef boolean;
  v_count  integer;
begin
  -- (a) Neither read model is a definer. That is the whole authorization design: RLS decides, and
  -- an accountant gets an empty answer rather than an error that confirms the rows exist.
  select count(*) into v_count
  from pg_catalog.pg_proc proc
  join pg_catalog.pg_namespace space on space.oid = proc.pronamespace
  where space.nspname = 'public'
    and proc.proname in ('supplier_monthly_price_rises', 'purchase_comparison')
    and proc.prosecdef;
  if v_count > 0 then
    raise exception '0203: % read model(s) became SECURITY DEFINER and bypass the RLS they rely on', v_count;
  end if;
  select prosecdef into v_secdef from pg_catalog.pg_proc
  where oid = pg_catalog.to_regprocedure('public.supplier_monthly_price_rises(integer)');
  if v_secdef is null then
    raise exception '0203: the monthly price-rise read model is missing';
  end if;

  -- (b) The RLS both models lean on is actually there, and is actually the owner/office pair the
  -- /prices route grants. A policy loosened elsewhere would silently widen these two functions.
  if exists (
    select 1 from unnest(array['supplier_products', 'price_history']) as required(table_name)
    join pg_catalog.pg_class relation on relation.relname = required.table_name
    join pg_catalog.pg_namespace space
      on space.oid = relation.relnamespace and space.nspname = 'public'
    where not relation.relrowsecurity
  ) then
    raise exception '0203: the price tables lost row level security -- the read models have no boundary';
  end if;
  select count(*) into v_count
  from pg_catalog.pg_policies
  where schemaname = 'public'
    and tablename in ('supplier_products', 'price_history')
    and cmd = 'SELECT'
    and qual like '%auth_org()%'
    and qual like '%owner%'
    and qual like '%office%';
  if v_count <> 2 then
    raise exception '0203: the owner/office SELECT policies the price read model relies on are not both present';
  end if;

  -- (c) #182: the comparison model must not so much as read a purchase order, let alone write one.
  if exists (
    select 1 from pg_catalog.pg_proc
    where oid = pg_catalog.to_regprocedure('public.purchase_comparison(jsonb,uuid)')
      and (prosrc ~ '\mpurchase_orders\M' or prosrc ~ '\mpurchase_order_items\M')
  ) then
    raise exception '0203: the comparison read model reaches purchase_orders -- #182 forbids it by name';
  end if;
  if exists (
    select 1 from pg_catalog.pg_proc
    where oid in (
        pg_catalog.to_regprocedure('public.purchase_comparison(jsonb,uuid)'),
        pg_catalog.to_regprocedure('public.supplier_monthly_price_rises(integer)'))
      and provolatile = 'v'
  ) then
    raise exception '0203: a read model became volatile -- a read model that may write is not a read model';
  end if;

  -- (d) The month is the calendar month #178 defines, taken in the product's one timezone, and the
  -- 180-day supplier window is not involved.
  if exists (
    select 1 from pg_catalog.pg_proc
    where oid = pg_catalog.to_regprocedure('public.supplier_monthly_price_rises(integer)')
      and (prosrc not like '%Asia/Jerusalem%'
        or prosrc not like '%date_trunc(''month''%'
        or prosrc like '%price_changes_window%')
  ) then
    raise exception '0203: the price-rise month is not the Asia/Jerusalem calendar month #189 decided';
  end if;

  -- (e) Both are callable by a signed-in user and by nobody else.
  if not has_function_privilege('authenticated', 'public.supplier_monthly_price_rises(integer)', 'execute')
     or not has_function_privilege('authenticated', 'public.purchase_comparison(jsonb,uuid)', 'execute')
     or has_function_privilege('anon', 'public.supplier_monthly_price_rises(integer)', 'execute')
     or has_function_privilege('anon', 'public.purchase_comparison(jsonb,uuid)', 'execute') then
    raise exception '0203: the read-model grants are not authenticated-only';
  end if;
end
$anchor_0203$;
