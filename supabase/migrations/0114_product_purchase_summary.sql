-- 0114 -- How much of this product did we actually buy? Once.
--
-- THE WHOLE DIFFICULTY IS COUNTING ONCE. One delivery of tomatoes can leave three records: a
-- purchase order line, a goods-receipt line, and an invoice line. They are not three purchases.
-- Summing them naively triples the quantity and triples the spend, and the resulting number looks
-- perfectly plausible on a screen -- which is what makes it dangerous rather than merely wrong.
--
-- THE ONLY SAFE DE-DUPLICATION KEY IS `purchase_order_items.id`, and that was measured, not
-- chosen. There is NO link at all between an invoice line and a goods-receipt line: grep 0099 for
-- `goods_receipt` and the answer is zero. The only connection is transitive, through the order
-- item both sides reference -- `goods_receipt_items.order_item_id` and
-- `invoice_line_matches.purchase_order_item_id`. So the order item is the grain, and anything with
-- no order item behind it CANNOT be de-duplicated by this function and is reported separately
-- rather than folded in and hoped about.
--
-- WHICH NUMBER IS "THE" QUANTITY, when three sources disagree:
--   * A COMPLETED goods receipt wins. Someone stood at the delivery and counted.
--   * An approved invoice is the fallback, and only when there is no receipt evidence at all.
--     A supplier's word is evidence; it is just weaker than our own count.
--   * Ordered is never the answer. It is what we asked for.
-- `canonical_source` travels with every row saying which of the two answered, because a quantity
-- whose provenance is invisible is a quantity nobody can defend in a supplier conversation.
--
-- ORDERED / RECEIVED / INVOICED STAY AS SEPARATE COLUMNS. The campaign plan asks for this
-- explicitly and it is right: the interesting rows are exactly the ones where they disagree, and a
-- single merged figure hides the disagreement that makes the screen worth opening.
--
-- WHAT THIS DOES NOT DO. It does not merge products by name similarity -- ever. "עגבניות שרי" and
-- "עגבניות שרי 500 גרם" are one product to a person and two rows to Postgres, and merging them on
-- a screen that drives purchasing decisions would be inventing a fact. Unmapped invoice lines are
-- counted in `unmapped_line_count`, which is a work list, not a rounding error.

create or replace function private.product_purchase_summary(
  p_org_id uuid,
  p_from date,
  p_to date,
  p_supplier_id uuid default null
) returns jsonb
language sql
stable
set search_path = public, pg_temp
as $fn$
  with order_items as (
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
    select ilm.purchase_order_item_id as order_item_id,
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
    group by ilm.purchase_order_item_id
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
           coalesce(v.amount, 0) as invoiced_amount,
           coalesce(r.receipt_count, 0) as receipt_count,
           coalesce(v.invoice_count, 0) as invoice_count
    from order_items oi
    left join received r on r.order_item_id = oi.id
    left join invoiced v on v.order_item_id = oi.id
  ),
  unmapped as (
    -- Invoice lines on approved invoices in this window that no order item claims. They are real
    -- money and they are NOT added to any product's total, because the product they belong to is
    -- not established. A count, deliberately: a work list, not a rounding error.
    select count(*)::bigint as line_count, coalesce(sum(il.line_total), 0) as amount
    from public.invoice_lines il
    join public.invoices i on i.org_id = il.org_id and i.id = il.invoice_id
    where il.org_id = p_org_id
      and i.deleted_at is null and i.review_status = 'approved'
      and i.invoice_date between p_from and p_to
      and (p_supplier_id is null or i.supplier_id = p_supplier_id)
      and not exists (
        select 1 from public.invoice_line_matches ilm
        where ilm.org_id = il.org_id and ilm.invoice_line_id = il.id)
  ),
  rows_out as (
    select p.id as product_id,
           p.name as product_name,
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
           case when sum(pi.invoice_count) > 0 then sum(pi.invoiced_amount) end as gross_amount,
           -- Unknown spend divided by a known quantity is not zero, it is unknown. The same
           -- screen that showed ₪0.00 spend was showing ₪0.00 average beside it, which is the
           -- more convincing of the two lies: it looks like a price somebody negotiated.
           case when sum(pi.invoice_count) > 0 and sum(pi.canonical_qty) > 0
                then round(sum(pi.invoiced_amount) / sum(pi.canonical_qty), 4) end
             as average_unit_price,
           -- If ANY line under this product still leans on the supplier's word, the row says so.
           bool_or(pi.canonical_source = 'approved_invoice') as includes_invoice_only_quantity,
           bool_or(pi.canonical_source = 'not_yet_evidenced') as includes_unevidenced_quantity
    from per_item pi
    join public.products p on p.org_id = p_org_id and p.id = pi.product_id
    group by p.id, p.name, p.unit
  )
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'time_zone', 'Asia/Jerusalem',
    'supplier_id', p_supplier_id,
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'product_id', product_id,
        'product_name', product_name,
        'unit', unit,
        'ordered_qty', ordered_qty,
        'received_qty', received_qty,
        'invoiced_qty', invoiced_qty,
        'canonical_qty', canonical_qty,
        'supplier_count', supplier_count,
        'order_count', order_count,
        'invoice_count', invoice_count,
        'gross_amount', round(gross_amount, 2),
        'average_unit_price', average_unit_price,
        'includes_invoice_only_quantity', includes_invoice_only_quantity,
        'includes_unevidenced_quantity', includes_unevidenced_quantity
      ) order by gross_amount desc, product_name)
      from rows_out), '[]'::jsonb),
    'unmapped_invoice_lines', (select line_count from unmapped),
    'unmapped_invoice_amount', (select round(amount, 2) from unmapped),
    'quantity_rule', 'completed_receipt_else_approved_invoice_never_both'
  )
$fn$;

revoke all on function private.product_purchase_summary(uuid, date, date, uuid)
  from public, anon, authenticated, service_role;

comment on function private.product_purchase_summary(uuid, date, date, uuid) is
  'Per-product purchase rollup that counts each purchase ONCE (0114). One delivery can leave an '
  'order line, a receipt line and an invoice line; summing them triples both quantity and spend '
  'and looks plausible. The de-duplication grain is purchase_order_items.id -- the only link that '
  'exists, since nothing joins an invoice line to a receipt line directly. A COMPLETED receipt is '
  'the canonical quantity because a person counted it; an approved invoice is the fallback only '
  'where there is no receipt evidence; ordered is never the answer. Ordered, received and invoiced '
  'stay as separate columns, because the rows worth opening are the ones where they disagree. '
  'Products are NEVER merged by name similarity, and invoice lines no order item claims are '
  'reported as a work list rather than folded in.';

create or replace function public.get_product_purchase_summary(
  p_from date, p_to date, p_supplier_id uuid default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_org uuid := auth_org();
  v_role user_role := auth_role();
begin
  if auth.uid() is null or v_org is null or v_role not in ('owner', 'office', 'accountant') then
    raise exception 'product_purchase_summary_not_authorized' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'product_purchase_summary_invalid_window' using errcode = '22023';
  end if;
  return private.product_purchase_summary(v_org, p_from, p_to, p_supplier_id);
end
$$;

revoke all on function public.get_product_purchase_summary(date, date, uuid) from public, anon;
grant execute on function public.get_product_purchase_summary(date, date, uuid) to authenticated;

comment on function public.get_product_purchase_summary(date, date, uuid) is
  'The product purchase summary for a window, optionally one supplier (0114). Readers are '
  'owner/office/accountant: it carries spend per product, which is the tenant''s commercial '
  'position.';

insert into private.scope_definer_enforcements (
  function_signature, body_hash, enforcement_kind, scope_proof
)
select reviewed.function_signature, md5(replace(proc.prosrc, e'\r', '')),
       'filtered_read', reviewed.scope_proof
from (values (
  'get_product_purchase_summary(date,date,uuid)',
  '0114 aggregates only within auth_org after an explicit role check and returns per-product '
  'totals rather than rows, so no per-unit record crosses the boundary.'
)) as reviewed(function_signature, scope_proof)
join pg_catalog.pg_proc proc
  on proc.oid = pg_catalog.to_regprocedure(reviewed.function_signature)
on conflict (function_signature) do update
  set body_hash = excluded.body_hash,
      enforcement_kind = excluded.enforcement_kind,
      scope_proof = excluded.scope_proof;

-- ===== A1/A3/A5 re-assertion =====
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0114 scope assertions failed:\n%', v_violations;
  end if;
end
$$;

-- ===== Anchors =====
do $$
declare
  v_src text;
begin
  select p.prosrc into v_src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.proname = 'product_purchase_summary';

  -- (a) The de-duplication grain. Losing it is how the same delivery gets counted three times.
  if position('order_item_id' in v_src) = 0
     or position('purchase_order_item_id' in v_src) = 0 then
    raise exception
      '0114: the summary no longer joins receipts and invoices through the order item. That is '
      'the only link that exists between them, and without it one delivery counts three times.';
  end if;

  -- (b) Only completed receipts count as arrival.
  if position('''completed''' in v_src) = 0 then
    raise exception
      '0114: draft receipts count as arrival. A draft is a proposal nobody confirmed.';
  end if;

  -- (c) Approved invoices only.
  if position('''approved''' in v_src) = 0 then
    raise exception '0114: unapproved invoices are counted as spend.';
  end if;

  -- (d) NO NAME MATCHING, ever. This is the one that would look like an improvement.
  if v_src ~* '\msimilarity\M' or v_src ~* '\mlevenshtein\M' or v_src ~* '\mp\.name\s*=\s*' then
    raise exception
      '0114: the summary merges products by name. "עגבניות שרי" and "עגבניות שרי 500 גרם" are one '
      'product to a person and two rows to Postgres; merging them on a screen that drives '
      'purchasing decisions invents a fact.';
  end if;

  -- (e) The browser reaches the wrapper and nothing beneath it.
  if has_function_privilege('authenticated',
       'private.product_purchase_summary(uuid,date,date,uuid)', 'execute') then
    raise exception '0114: authenticated can call the private summary, which takes org_id.';
  end if;
  if not has_function_privilege('authenticated',
       'public.get_product_purchase_summary(date,date,uuid)', 'execute') then
    raise exception '0114: authenticated cannot call the summary wrapper.';
  end if;
end
$$;
