-- 0221: the purchase-analytics readers stop adding unlike money.
--
-- 0218 and 0219 covered the balance and summary readers. Three readers are left, and they are the
-- ones a manager actually opens to decide something: what a window of purchasing cost, what a
-- product costs, and which supplier is cheaper for a basket. Each of them added money across
-- currencies, and the third did something worse — it RANKED across them.
--
--   private.canonical_purchase_metrics   five money scalars for a date window: committed, gross,
--                                        credits recognised, credits pending, net.
--   private.product_purchase_summary     per-product spend and average unit price.
--   public.purchase_comparison           picks the cheapest supplier per product by comparing
--                                        `current_price` numerically. 12 dollars sorted below
--                                        40 shekels is not a cheaper offer, it is a different unit.
--
-- WHAT DOES NOT CHANGE FOR A SHEKEL-ONLY BUSINESS. Every one of these behaves exactly as it does
-- today when a window, a product or a basket holds one currency — which is every window, product
-- and basket in existence, because 0108 has refused anything else since it was written. What is
-- added is what happens when that stops being true, and the answer is never a converted number.

-- ===== 1. The window's money, one figure per currency =====
create or replace function private.canonical_purchase_metrics(p_org_id uuid, p_from date, p_to date)
returns jsonb
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  with base as (
    -- Ordering only. The organisation's own currency goes first so a shekel business reads its own
    -- figure first; it is never a conversion target and never a fallback.
    select organization.base_currency from public.organizations organization
    where organization.id = p_org_id
  ),
  committed as (
    -- WHAT WAS ORDERED, at the prices agreed when it was ordered. `unit_price` on the order item
    -- is the snapshot (ARCHITECTURE.md), never today's price list -- otherwise a price rise would
    -- retroactively change what a past month cost. Cancelled orders are excluded because nothing
    -- was committed; drafts are excluded because nothing was sent. The currency is the ORDER's:
    -- 0217 puts it on the head and the lines inherit it, because an order is placed in one.
    select per_order.currency,
           count(*)::bigint as order_count,
           sum(per_order.item_total) as value
    from (
      select po.id, po.currency, sum(poi.qty * poi.unit_price) as item_total
      from public.purchase_orders po
      join public.purchase_order_items poi
        on poi.org_id = po.org_id and poi.order_id = po.id
      where po.org_id = p_org_id
        and po.status not in ('draft', 'cancelled')
        -- The business day, not the UTC day. `created_at` is an instant; a month boundary is a
        -- local calendar fact, and this is the conversion the two dashboards disagreed about.
        and (po.created_at at time zone 'Asia/Jerusalem')::date between p_from and p_to
      group by po.id, po.currency
    ) per_order
    group by per_order.currency
  ),
  gross as (
    -- WHAT WE WERE BILLED. Approved invoices only: an invoice still in review is a claim, not an
    -- expense, and counting it would make every month's figure move as the office works through
    -- its queue. By `invoice_date` -- the date the supplier billed -- because that is what the
    -- label on every screen says, and what an accountant reconciles against.
    select i.currency,
           count(*)::bigint as invoice_count,
           sum(i.total_amount) as value
    from public.invoices i
    where i.org_id = p_org_id
      and i.deleted_at is null
      and i.review_status = 'approved'
      and i.financial_role = 'payable'
      and i.invoice_date between p_from and p_to
    group by i.currency
  ),
  credits as (
    select c.currency,
      count(*) filter (where c.status in ('offset', 'closed'))::bigint as recognised_count,
      sum(c.amount) filter (where c.status in ('offset', 'closed')) as recognised,
      count(*) filter (where c.status in ('open', 'requested', 'received'))::bigint as pending_count,
      sum(c.amount) filter (where c.status in ('open', 'requested', 'received')) as pending
    from public.credit_requests c
    where c.org_id = p_org_id
      and coalesce(c.resolved_at, c.created_at)::date between p_from and p_to
    group by c.currency
  ),
  -- Net is gross minus recognised credits IN THE SAME CURRENCY. A dollar credit does not reduce a
  -- shekel bill, and a full outer join is what says so: a currency that has only credits reports
  -- no net at all rather than a negative expense nobody was billed.
  net as (
    select coalesce(gross.currency, credits.currency) as currency,
           gross.invoice_count,
           gross.value - coalesce(credits.recognised, 0) as value
    from gross
    full outer join credits on credits.currency = gross.currency
    where gross.invoice_count > 0
  ),
  totals as (
    select (select coalesce(sum(order_count), 0) from committed) as committed_order_count,
           (select coalesce(sum(invoice_count), 0) from gross) as gross_invoice_count,
           (select coalesce(sum(recognised_count), 0) from credits) as recognised_count,
           (select coalesce(sum(pending_count), 0) from credits) as pending_count
  )
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'time_zone', 'Asia/Jerusalem',
    -- Committed and gross stay SEPARATE and are never summed or netted against each other. They
    -- are not two views of one number: an order placed in March and billed in April belongs to
    -- both months, in different senses, and a screen that adds them is double counting.
    'committed_by_currency', case when totals.committed_order_count > 0 then (
      select coalesce(jsonb_agg(jsonb_build_object('currency', row.currency, 'amount', round(row.value, 3))
        order by (row.currency = (select base_currency from base)) desc, row.currency), '[]'::jsonb)
      from committed row) end,
    'committed_order_count', totals.committed_order_count,
    'gross_expense_by_currency', case when totals.gross_invoice_count > 0 then (
      select coalesce(jsonb_agg(jsonb_build_object('currency', row.currency, 'amount', round(row.value, 3))
        order by (row.currency = (select base_currency from base)) desc, row.currency), '[]'::jsonb)
      from gross row) end,
    'gross_invoice_count', totals.gross_invoice_count,
    'credits_recognised_by_currency', case when totals.recognised_count > 0 then (
      select coalesce(jsonb_agg(jsonb_build_object('currency', row.currency, 'amount', round(row.recognised, 3))
        order by (row.currency = (select base_currency from base)) desc, row.currency), '[]'::jsonb)
      from credits row where row.recognised_count > 0) end,
    'credits_pending_by_currency', case when totals.pending_count > 0 then (
      select coalesce(jsonb_agg(jsonb_build_object('currency', row.currency, 'amount', round(row.pending, 3))
        order by (row.currency = (select base_currency from base)) desc, row.currency), '[]'::jsonb)
      from credits row where row.pending_count > 0) end,
    'net_expense_by_currency', case when totals.gross_invoice_count > 0 then (
      select coalesce(jsonb_agg(jsonb_build_object('currency', row.currency, 'amount', round(row.value, 3))
        order by (row.currency = (select base_currency from base)) desc, row.currency), '[]'::jsonb)
      from net row) end,
    'net_definition', 'gross_minus_offset_and_closed_credits_within_one_currency'
  )
  from totals
$$;

comment on function private.canonical_purchase_metrics(uuid, date, date) is
  'One definition of what a window of purchasing cost (0113, per-currency since 0221). Every money '
  'figure is an array of {currency, amount} with the organisation''s own currency first; the counts '
  'stay scalar. Net subtracts a credit only from the currency it was issued in — a dollar credit '
  'does not reduce a shekel bill.';

-- ===== 2. A product's spend, per currency, and an average that refuses to be invented =====
--
-- `gross_amount` summed `invoice_lines.line_total` for a product across every invoice that named
-- it, and `average_unit_price` divided that by the canonical quantity. Both are per-currency now,
-- and the average has a rule the sum does not need:
--
--   ONE CURRENCY  -- exactly today's number, with the currency stated beside it. Every product in
--                    existence is in this case.
--   TWO OR MORE   -- the spend splits, and the average is NULL for all of them. The divisor is the
--                    canonical quantity, which is a physical fact with no currency: 25 kg received
--                    is 25 kg whether it was billed in shekels or dollars, and dividing part of
--                    the money by all of the quantity produces a unit price nobody was charged.
--                    `spans_currencies` says which rows are in that state, so the screen can show
--                    the split spend and explain the missing average rather than print a number.
--
-- That is the same rule the function already applies to an unknown spend: it renders `—` rather
-- than 0, because "nobody has billed us" and "it was free" are different sentences.
create or replace function private.product_purchase_summary(
  p_org_id uuid, p_from date, p_to date, p_supplier_id uuid default null::uuid
)
returns jsonb
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  with base as (
    select organization.base_currency from public.organizations organization
    where organization.id = p_org_id
  ),
  order_items as (
    -- The grain. Every de-duplicated number below hangs off exactly one of these rows.
    select poi.id, poi.product_id, poi.qty, poi.unit_price, poi.unit_snapshot,
           po.supplier_id, po.id as order_id
    from public.purchase_order_items poi
    join public.purchase_orders po
      on po.org_id = poi.org_id and po.id = poi.order_id
    where poi.org_id = p_org_id
      and po.status not in ('draft', 'cancelled')
      and (p_supplier_id is null or po.supplier_id = p_supplier_id)
      and (po.created_at at time zone 'Asia/Jerusalem')::date between p_from and p_to
  ),
  received as (
    -- COMPLETED receipts only. A draft is a proposal somebody has not confirmed, and counting it
    -- as arrival is how a document approves itself through a receipt nobody signed.
    select gri.order_item_id,
           sum(gri.qty_received) as qty,
           count(distinct gr.id) as receipt_count
    from public.goods_receipt_items gri
    join public.goods_receipts gr
      on gr.org_id = gri.org_id and gr.id = gri.receipt_id
    join order_items oi on oi.id = gri.order_item_id
    where gri.org_id = p_org_id and gr.status = 'completed'
    group by gri.order_item_id
  ),
  invoiced as (
    -- Approved invoices only, matched to the order item explicitly. The transitive path through
    -- the order item is the ONLY link that exists between an invoice line and physical receipt.
    -- 0221: grouped by the INVOICE's currency as well, because one order item can be billed by two
    -- invoices and there is nothing that says they were printed in the same money.
    select ilm.purchase_order_item_id as order_item_id,
           i.currency,
           sum(ilm.allocated_quantity) as qty,
           sum(il.line_total) as amount,
           count(distinct i.id) as invoice_count
    from public.invoice_line_matches ilm
    join public.invoice_lines il
      on il.org_id = ilm.org_id and il.id = ilm.invoice_line_id
    join public.invoices i
      on i.org_id = ilm.org_id and i.id = ilm.invoice_id
    join order_items oi on oi.id = ilm.purchase_order_item_id
    where ilm.org_id = p_org_id
      and i.deleted_at is null and i.review_status = 'approved'
      and i.financial_role = 'payable'
    group by ilm.purchase_order_item_id, i.currency
  ),
  invoiced_item as (
    select order_item_id,
           sum(qty) as qty,
           sum(invoice_count) as invoice_count,
           count(distinct currency) as currency_count
    from invoiced
    group by order_item_id
  ),
  per_item as (
    select oi.product_id,
           oi.supplier_id,
           oi.order_id,
           oi.qty as ordered_qty,
           coalesce(r.qty, 0) as received_qty,
           coalesce(v.qty, 0) as invoiced_qty,
           -- The canonical quantity, and the sentence that says which source it came from.
           case when r.qty is not null then r.qty else coalesce(v.qty, 0) end as canonical_qty,
           case when r.qty is not null then 'completed_receipt'
                when v.qty is not null then 'approved_invoice'
                else 'not_yet_evidenced' end as canonical_source,
           coalesce(r.receipt_count, 0) as receipt_count,
           coalesce(v.invoice_count, 0) as invoice_count,
           coalesce(v.currency_count, 0) as currency_count
    from order_items oi
    left join received r on r.order_item_id = oi.id
    left join invoiced_item v on v.order_item_id = oi.id
  ),
  -- The money, kept at its own grain: product × currency. It never joins back into a row that
  -- would let it be summed with another currency.
  per_product_currency as (
    select oi.product_id, inv.currency, sum(inv.amount) as amount
    from invoiced inv
    join order_items oi on oi.id = inv.order_item_id
    group by oi.product_id, inv.currency
  ),
  unmapped as (
    -- Invoice lines on approved invoices in this window that no order item claims. They are real
    -- money and they are NOT added to any product's total, because the product they belong to is
    -- not established. A count, deliberately: a work list, not a rounding error.
    select i.currency,
           count(*)::bigint as line_count,
           coalesce(sum(il.line_total), 0) as amount
    from public.invoice_lines il
    join public.invoices i on i.org_id = il.org_id and i.id = il.invoice_id
    where il.org_id = p_org_id
      and i.deleted_at is null and i.review_status = 'approved'
      and i.financial_role = 'payable'
      and i.invoice_date between p_from and p_to
      and (p_supplier_id is null or i.supplier_id = p_supplier_id)
      and not exists (
        select 1 from public.invoice_line_matches ilm
        where ilm.org_id = il.org_id and ilm.invoice_line_id = il.id)
    group by i.currency
  ),
  rows_out as (
    select p.id as product_id,
           coalesce(p.display_name, p.name) as product_name,
           p.unit,
           sum(pi.ordered_qty) as ordered_qty,
           -- NULL when the source contributed nothing at all; 0 only when it contributed rows
           -- that sum to zero. Caught by looking at the screen: a product with 25 kg received and
           -- no invoice matched to it yet was rendering ₪0.00 spend, which reads as "this was
           -- free" rather than "nobody has billed us for it". Same class of lie as a fabricated
           -- zero anywhere else in this product.
           case when sum(pi.receipt_count) > 0 then sum(pi.received_qty) end as received_qty,
           case when sum(pi.invoice_count) > 0 then sum(pi.invoiced_qty) end as invoiced_qty,
           sum(pi.canonical_qty) as canonical_qty,
           -- One product can be bought from several suppliers on several orders, and the row is
           -- only readable if it says how many of each it is standing on.
           count(distinct pi.supplier_id)::bigint as supplier_count,
           count(distinct pi.order_id)::bigint as order_count,
           sum(pi.invoice_count)::bigint as invoice_count,
           (select count(*) from per_product_currency ppc where ppc.product_id = p.id) as currency_count,
           bool_or(pi.canonical_source = 'approved_invoice') as includes_invoice_only_quantity,
           bool_or(pi.canonical_source = 'not_yet_evidenced') as includes_unevidenced_quantity,
           (select sum(ppc.amount) from per_product_currency ppc where ppc.product_id = p.id)
             as single_currency_amount
    from per_item pi
    join public.products p on p.org_id = p_org_id and p.id = pi.product_id
    group by p.id, p.name, p.display_name, p.unit
  )
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'time_zone', 'Asia/Jerusalem',
    'supplier_id', p_supplier_id,
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'product_id', row.product_id,
        'product_name', row.product_name,
        'unit', row.unit,
        'ordered_qty', row.ordered_qty,
        'received_qty', row.received_qty,
        'invoiced_qty', row.invoiced_qty,
        'canonical_qty', row.canonical_qty,
        'supplier_count', row.supplier_count,
        'order_count', row.order_count,
        'invoice_count', row.invoice_count,
        'spans_currencies', row.currency_count > 1,
        'gross_amount_by_currency', case when row.invoice_count > 0 then (
          select coalesce(jsonb_agg(jsonb_build_object('currency', ppc.currency, 'amount', round(ppc.amount, 3))
            order by (ppc.currency = (select base_currency from base)) desc, ppc.currency), '[]'::jsonb)
          from per_product_currency ppc where ppc.product_id = row.product_id) end,
        -- Unknown spend divided by a known quantity is not zero, it is unknown. The same screen
        -- that showed ₪0.00 spend was showing ₪0.00 average beside it, which is the more
        -- convincing of the two lies: it looks like a price somebody negotiated. Two currencies
        -- over one physical quantity is the same lie in a newer costume.
        'average_unit_price', case
          when row.invoice_count > 0 and row.currency_count = 1 and row.canonical_qty > 0
          then round(row.single_currency_amount / row.canonical_qty, 4) end,
        'average_unit_price_currency', case
          when row.invoice_count > 0 and row.currency_count = 1
          then (select ppc.currency from per_product_currency ppc where ppc.product_id = row.product_id) end,
        'includes_invoice_only_quantity', row.includes_invoice_only_quantity,
        'includes_unevidenced_quantity', row.includes_unevidenced_quantity
      ) order by row.single_currency_amount desc nulls last, row.product_name)
      from rows_out row), '[]'::jsonb),
    'unmapped_invoice_lines', (select coalesce(sum(line_count), 0) from unmapped),
    'unmapped_invoice_amount_by_currency', coalesce((
      select jsonb_agg(jsonb_build_object('currency', u.currency, 'amount', round(u.amount, 3))
        order by (u.currency = (select base_currency from base)) desc, u.currency)
      from unmapped u), '[]'::jsonb),
    'quantity_rule', 'completed_receipt_else_approved_invoice_never_both'
  )
$$;

comment on function private.product_purchase_summary(uuid, date, date, uuid) is
  'Per-product purchase rollup (0114, per-currency since 0221). Spend is an array of '
  '{currency, amount}; the average unit price exists only when the product was billed in ONE '
  'currency, because the divisor is a physical quantity and part of the money over all of the '
  'quantity is a unit price nobody was charged. `spans_currencies` names the rows in that state.';

-- ===== 3. The comparison stops ranking dollars against shekels =====
--
-- This is the worst of the three, because it does not merely ADD unlike money — it ORDERS by it.
-- `order by offers.current_price` sorted a $12 offer below a ₪40 offer and called it the cheaper
-- supplier. That is a false comparison presented as a recommendation, on the screen a person uses
-- to decide who to buy from.
--
-- There is no conversion to reach for (§4.7), so the rule is the one the plan gives everywhere
-- else: a comparison is only defined inside one currency.
--
--   ALL OFFERS FOR A PRODUCT IN ONE CURRENCY  -- exactly today's answer, tie-break and all, with
--                                                the currency stated. Every basket today.
--   OFFERS SPANNING TWO OR MORE               -- status `offers_span_currencies`, no chosen
--                                                supplier, and every offer listed WITH its
--                                                currency so a person can decide. The product is
--                                                not silently dropped and no offer is silently
--                                                preferred.
--
-- The supplier minimum follows the same rule. `min_order_amount` is stated in the supplier's own
-- `default_currency` (0217), so a subtotal in another currency cannot be compared to it:
-- `below_minimum` is null rather than false, because false claims the minimum was cleared.
create or replace function public.purchase_comparison(
  p_lines jsonb default null::jsonb, p_request_id uuid default null::uuid
)
returns jsonb
language plpgsql
stable
set search_path to 'public', 'pg_temp'
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
           supplier.default_currency as supplier_currency,
           sp.current_price,
           sp.currency,
           sp.min_qty
    from validated
    join supplier_products sp on sp.product_id = validated.product_id and sp.available
    join suppliers supplier
      on supplier.id = sp.supplier_id
     and supplier.deleted_at is null
     and supplier.status = 'active'
  ),
  -- 0221: how many currencies this product is quoted in. One is comparable; two is not.
  product_currencies as (
    select offers.product_id, count(distinct offers.currency) as currency_count,
           min(offers.currency) as single_currency
    from offers
    group by offers.product_id
  ),
  chosen as (
    select distinct on (offers.product_id)
           offers.product_id, offers.supplier_id, offers.current_price, offers.currency, offers.qty
    from offers
    join product_currencies pc on pc.product_id = offers.product_id
    where (offers.min_qty is null or offers.qty >= offers.min_qty)
      -- The whole of 0221's change to this function. A product quoted in two currencies has no
      -- cheapest offer, and picking one by numeric value would be a recommendation nobody could
      -- defend.
      and pc.currency_count = 1
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
           chosen.currency as chosen_currency,
           case when chosen.supplier_id is not null
                then round(validated.qty * chosen.current_price, 3) end as line_total,
           case
             when not exists (select 1 from offers where offers.product_id = validated.product_id)
               then 'no_offers'
             when coalesce((select pc.currency_count from product_currencies pc
                            where pc.product_id = validated.product_id), 0) > 1
               then 'offers_span_currencies'
             when chosen.supplier_id is null then 'no_usable_offer'
             else 'ok'
           end as status,
           coalesce((
             select jsonb_agg(jsonb_build_object(
                      'supplier_id', offers.supplier_id,
                      'supplier_name', offers.supplier_name,
                      'preferred', offers.preferred,
                      'unit_price', offers.current_price,
                      'currency', offers.currency,
                      'min_qty', offers.min_qty,
                      'meets_min_qty', offers.min_qty is null or offers.qty >= offers.min_qty)
                    order by offers.currency, offers.current_price, offers.preferred desc, offers.supplier_id)
             from offers where offers.product_id = validated.product_id), '[]'::jsonb) as offer_rows
    from validated
    left join products product on product.id = validated.product_id
    left join chosen on chosen.product_id = validated.product_id
  ),
  supplier_totals as (
    select lines.chosen_supplier_id as supplier_id,
           lines.chosen_currency as currency,
           sum(lines.line_total) as subtotal
    from lines
    where lines.chosen_supplier_id is not null
    group by lines.chosen_supplier_id, lines.chosen_currency
  ),
  -- The supplier minimum is REPORTED, never resolved. #190 forbids raising a quantity to clear it
  -- and #182 forbids the assistant proposing anything at all; the shortfall is the fact the user
  -- needs in order to decide for themselves.
  --
  -- 0221: the minimum is stated in the supplier's own currency. Compared against a subtotal in
  -- another one, `below_minimum` is NULL -- unknown -- rather than false, because false is a claim
  -- that the minimum was cleared.
  supplier_rows as (
    select supplier_totals.supplier_id,
           supplier.name as supplier_name,
           supplier_totals.currency,
           supplier_totals.subtotal,
           supplier.min_order_amount,
           supplier.default_currency as min_order_currency,
           case when supplier.min_order_amount is null then false
                when supplier.default_currency is distinct from supplier_totals.currency then null
                else supplier_totals.subtotal < supplier.min_order_amount end as below_minimum,
           case when supplier.min_order_amount is not null
                 and supplier.default_currency is not distinct from supplier_totals.currency
                 and supplier_totals.subtotal < supplier.min_order_amount
                then round(supplier.min_order_amount - supplier_totals.subtotal, 3) end as shortfall
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
               'chosen_currency', lines.chosen_currency,
               'line_total', lines.line_total,
               'offers', lines.offer_rows)
             order by lines.position)
      from lines), '[]'::jsonb),
    'suppliers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'supplier_id', supplier_rows.supplier_id,
               'supplier_name', supplier_rows.supplier_name,
               'currency', supplier_rows.currency,
               'subtotal', supplier_rows.subtotal,
               'min_order_amount', supplier_rows.min_order_amount,
               'min_order_currency', supplier_rows.min_order_currency,
               'below_minimum', supplier_rows.below_minimum,
               'shortfall', supplier_rows.shortfall)
             order by supplier_rows.supplier_name, supplier_rows.supplier_id, supplier_rows.currency)
      from supplier_rows), '[]'::jsonb),
    'minimum_breaches', (select count(*) from supplier_rows where below_minimum),
    'lines_spanning_currencies', (select count(*) from lines where status = 'offers_span_currencies')
  ) into v_result;

  return v_result;
end
$$;

comment on function public.purchase_comparison(jsonb, uuid) is
  'Which supplier is cheapest for a basket (0203, per-currency since 0221). A product quoted in '
  'more than one currency has NO cheapest offer: the line reports offers_span_currencies, chooses '
  'nobody, and lists every offer with its currency. Ranking numerically across currencies is a '
  'recommendation nobody could defend.';

-- ===== 4. Proof =====
do $assert_0221$
declare
  v_violations text;
  v_body       text;
begin
  -- The comparison must not be able to rank across currencies again: the guard is a clause in the
  -- body, and a body without it is the defect coming back.
  select replace(prosrc, e'\r', '') into v_body
  from pg_proc where oid = 'public.purchase_comparison(jsonb,uuid)'::regprocedure;
  if position('currency_count = 1' in v_body) = 0
     or position('offers_span_currencies' in v_body) = 0 then
    raise exception '0221: purchase_comparison lost the single-currency guard';
  end if;

  -- Every one of the three still answers with the shape its callers read.
  if (private.canonical_purchase_metrics(
        (select id from organizations limit 1), current_date - 30, current_date)
      ? 'gross_expense_by_currency') is not true then
    raise exception '0221: canonical_purchase_metrics did not return gross_expense_by_currency';
  end if;
  if (private.product_purchase_summary(
        (select id from organizations limit 1), current_date - 30, current_date)
      ? 'unmapped_invoice_amount_by_currency') is not true then
    raise exception '0221: product_purchase_summary did not return the per-currency unmapped total';
  end if;

  -- None of them may still offer the single-currency key its consumers used to read.
  if (private.canonical_purchase_metrics(
        (select id from organizations limit 1), current_date - 30, current_date)
      ? 'gross_expense') then
    raise exception '0221: canonical_purchase_metrics still exposes a single-currency money key';
  end if;

  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0221 scope assertions failed:\n%', v_violations;
  end if;
end
$assert_0221$;
