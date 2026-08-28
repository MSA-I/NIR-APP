-- 0222: the consolidated-invoice reconciliation stops comparing unlike money.
--
-- `private.consolidated_case_lines` folds three kinds of evidence into one row per identity key:
-- the anchor invoice's lines, the interim invoices' lines, and the priced quantities on completed
-- goods receipts. It then summed `line_total` and `qty_received * unit_price` across whatever fell
-- under that key, and `private.consolidated_comparison` compared the two sides and reported a
-- `difference_amount`.
--
-- With one currency that is a reconciliation. With two it is the plan's central failure wearing a
-- reconciliation's clothes: a supplier who billed part of a month in shekels and part in dollars
-- would produce a single summed line, a unit price that is neither of the two prices charged, and
-- a difference figure computed from the subtraction of unlike things — on the screen whose whole
-- purpose is to decide whether the supplier's monthly bill is right.
--
-- THE GRAIN GAINS THE CURRENCY. A line is now identified by `(identity_key, currency)`, taken from
-- the invoice the line was printed on or from the purchase order the receipt was priced against.
-- The comparison joins on both, so a shekel anchor line and a dollar receipt line for the same
-- product no longer average into one row: they appear as two, each saying which currency it is in,
-- and each with a result that names what is missing on the other side. That is the finding, and it
-- is one a person can act on. A month billed in one currency — which is every month in existence —
-- reads exactly as it does today, with a currency column added.

-- Dropped rather than replaced: the row it returns gains a column, and Postgres will not change
-- the OUT parameters of a live function. `consolidated_comparison` is the only caller and is
-- recreated below in the same migration, so nothing is left pointing at a shape that moved.
drop function if exists private.consolidated_case_lines(uuid, text);

create function private.consolidated_case_lines(p_case_id uuid, p_family text)
returns table (
  identity_key text,
  product_id uuid,
  product_name text,
  supplier_sku text,
  barcode text,
  currency text,
  quantity numeric,
  unit_price numeric,
  amount numeric,
  source_ids uuid[],
  ambiguous boolean
)
language sql
stable
set search_path to 'public', 'private', 'pg_temp'
as $$
  with case_row as (
    select * from public.consolidated_invoice_cases where id = p_case_id
  ), invoice_ids as (
    select c.anchor_invoice_id as invoice_id
    from case_row c where p_family = 'anchor' and c.anchor_invoice_id is not null
    union all
    select source.invoice_id
    from public.consolidated_invoice_sources source
    join case_row c on c.org_id = source.org_id and c.id = source.case_id
    where p_family = 'interim' and source.source_type = 'interim_invoice'
  ), latest_batches as (
    select distinct on (batch.invoice_id) batch.invoice_id, batch.id
    from public.invoice_line_evidence_batches batch
    join invoice_ids selected on selected.invoice_id = batch.invoice_id
    order by batch.invoice_id, batch.revision desc
  ), invoice_source as (
    select
      line.invoice_id as source_id,
      line.id as line_id,
      coalesce(line.product_id, sku_match.product_id, barcode_match.product_id) as resolved_product_id,
      line.description,
      nullif(trim(line.supplier_sku),'') as supplier_sku,
      nullif(trim(line.barcode),'') as barcode,
      -- The invoice's own currency. A line has none of its own by design (0217 §2): a document is
      -- not printed in two currencies, so the head is where it lives.
      invoice.currency,
      line.quantity,
      line.unit_price,
      line.line_total as amount,
      line.product_id is null and sku_match.product_id is null and barcode_match.product_id is null
        and nullif(trim(line.supplier_sku),'') is null
        and nullif(trim(line.barcode),'') is null as ambiguous
    from latest_batches batch
    join public.invoice_lines line
      on line.evidence_batch_id = batch.id and line.invoice_id = batch.invoice_id
    join public.invoices invoice
      on invoice.org_id = line.org_id and invoice.id = line.invoice_id
    join case_row c on c.org_id = line.org_id
    left join lateral (
      select (array_agg(distinct sp.product_id order by sp.product_id))[1] as product_id
      from public.supplier_products sp
      where sp.org_id = c.org_id and sp.supplier_id = c.supplier_id
        and line.supplier_sku is not null and sp.supplier_sku is not null
        and lower(trim(sp.supplier_sku)) = lower(trim(line.supplier_sku))
      having count(distinct sp.product_id) = 1
    ) sku_match on true
    left join lateral (
      select (array_agg(distinct product.id order by product.id))[1] as product_id
      from public.products product
      where product.org_id = c.org_id
        and line.barcode is not null and product.barcode is not null
        and regexp_replace(product.barcode, '[[:space:]-]+', '', 'g')
          = regexp_replace(line.barcode, '[[:space:]-]+', '', 'g')
      having count(distinct product.id) = 1
    ) barcode_match on true
    where p_family in ('anchor','interim')
  ), receipt_source as (
    select
      receipt.id as source_id,
      item.id as line_id,
      item.product_id as resolved_product_id,
      product.name as description,
      supplier_product.supplier_sku,
      product.barcode,
      -- A receipt is priced from the order it fulfils, so the money is in the ORDER's currency.
      purchase_order.currency,
      item.qty_received as quantity,
      order_item.unit_price,
      item.qty_received * order_item.unit_price as amount,
      false as ambiguous
    from public.consolidated_invoice_sources source
    join case_row c on c.org_id = source.org_id and c.id = source.case_id
    join public.goods_receipts receipt
      on receipt.org_id = source.org_id and receipt.id = source.receipt_id
      and receipt.status = 'completed'
    join public.goods_receipt_items item
      on item.org_id = receipt.org_id and item.receipt_id = receipt.id
      and item.status in ('full','partial')
    join public.purchase_order_items order_item
      on order_item.org_id = item.org_id and order_item.id = item.order_item_id
    join public.purchase_orders purchase_order
      on purchase_order.org_id = order_item.org_id and purchase_order.id = order_item.order_id
    join public.products product
      on product.org_id = item.org_id and product.id = item.product_id
    left join public.supplier_products supplier_product
      on supplier_product.org_id = c.org_id
      and supplier_product.supplier_id = c.supplier_id
      and supplier_product.product_id = item.product_id
    where p_family = 'receipt' and source.source_type = 'goods_receipt'
  ), selected as (
    select * from invoice_source
    union all
    select * from receipt_source
  ), keyed as (
    select source.*,
      case
        when source.resolved_product_id is not null then 'product:' || source.resolved_product_id::text
        when source.supplier_sku is not null then 'sku:' || lower(trim(source.supplier_sku))
        when source.barcode is not null then 'barcode:' || regexp_replace(source.barcode, '[[:space:]-]+', '', 'g')
        else 'line:' || source.line_id::text
      end as identity_key
    from selected source
  )
  select keyed.identity_key,
    (array_agg(distinct keyed.resolved_product_id order by keyed.resolved_product_id)
      filter (where keyed.resolved_product_id is not null))[1] as product_id,
    coalesce(min(product.name), min(keyed.description)) as product_name,
    min(keyed.supplier_sku) as supplier_sku,
    min(keyed.barcode) as barcode,
    keyed.currency,
    sum(keyed.quantity) as quantity,
    case when sum(keyed.quantity) > 0 then sum(keyed.amount) / sum(keyed.quantity) end as unit_price,
    sum(keyed.amount) as amount,
    array_agg(distinct keyed.source_id order by keyed.source_id) as source_ids,
    bool_or(keyed.ambiguous) as ambiguous
  from keyed
  left join public.products product on product.id = keyed.resolved_product_id
  group by keyed.identity_key, keyed.currency
$$;

comment on function private.consolidated_case_lines(uuid, text) is
  'One row per identity key AND CURRENCY for one side of a consolidated case (0137, per-currency '
  'since 0222). The currency comes from the invoice a line was printed on, or from the order a '
  'receipt was priced against. Two currencies under one key are two rows, never an average of '
  'prices nobody charged.';

create or replace function private.consolidated_comparison(
  p_case_id uuid, p_left text, p_right text, p_comparison text
)
returns jsonb
language sql
stable
set search_path to 'public', 'private', 'pg_temp'
as $$
  with left_rows as (
    select * from private.consolidated_case_lines(p_case_id, p_left)
  ), right_rows as (
    select * from private.consolidated_case_lines(p_case_id, p_right)
  ), compared as (
    select coalesce(l.identity_key, r.identity_key) as identity_key,
      coalesce(l.currency, r.currency) as currency,
      coalesce(l.product_id, r.product_id) as product_id,
      coalesce(l.product_name, r.product_name) as product_name,
      coalesce(l.supplier_sku, r.supplier_sku) as supplier_sku,
      coalesce(l.barcode, r.barcode) as barcode,
      l.quantity as left_quantity, r.quantity as right_quantity,
      l.unit_price as left_unit_price, r.unit_price as right_unit_price,
      l.amount as left_amount, r.amount as right_amount,
      coalesce(l.source_ids,'{}'::uuid[]) || coalesce(r.source_ids,'{}'::uuid[]) as source_ids,
      case
        when l.identity_key is null then 'source_not_on_anchor'
        when r.identity_key is null then 'missing_source'
        when l.ambiguous or r.ambiguous then 'ambiguous'
        when abs(l.quantity - r.quantity) > 0.000001 then 'quantity_mismatch'
        when abs(l.unit_price - r.unit_price) > 0.01 then 'price_mismatch'
        else 'matched'
      end as result
    -- 0222: joined on the currency as well. Two sides of the same product in two currencies are
    -- two rows, each naming what the other side does not have, instead of one row whose price is
    -- an average of two prices and whose difference is a subtraction of unlike things.
    from left_rows l full join right_rows r using (identity_key, currency)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'comparison', p_comparison,
    'result', result,
    'product_id', product_id,
    'product_name', product_name,
    'supplier_sku', supplier_sku,
    'barcode', barcode,
    'currency', currency,
    'anchor_quantity', case
      when p_left = 'anchor' then left_quantity when p_right = 'anchor' then right_quantity end,
    'interim_quantity', case
      when p_left = 'interim' then left_quantity when p_right = 'interim' then right_quantity end,
    'received_quantity', case
      when p_left = 'receipt' then left_quantity when p_right = 'receipt' then right_quantity end,
    'anchor_unit_price', case
      when p_left = 'anchor' then left_unit_price when p_right = 'anchor' then right_unit_price end,
    'interim_unit_price', case
      when p_left = 'interim' then left_unit_price when p_right = 'interim' then right_unit_price end,
    'anchor_amount', case
      when p_left = 'anchor' then left_amount when p_right = 'anchor' then right_amount end,
    'interim_amount', case
      when p_left = 'interim' then left_amount when p_right = 'interim' then right_amount end,
    'difference_quantity', round(coalesce(left_quantity,0) - coalesce(right_quantity,0), 6),
    -- Both sides of this subtraction are in `currency` by construction: the join key says so.
    'difference_amount', round(coalesce(left_amount,0) - coalesce(right_amount,0), 3),
    'source_ids', to_jsonb(source_ids),
    'message_key', 'consolidated_invoice.' || result,
    'severity', case when result = 'matched' then 'info' else 'warning' end
  ) order by result, product_name, identity_key, currency), '[]'::jsonb)
  from compared
$$;

comment on function private.consolidated_comparison(uuid, text, text, text) is
  'One reconciliation channel of a consolidated case (0137, per-currency since 0222). Rows are '
  'joined on identity AND currency, so every difference_amount is a subtraction inside one '
  'currency and never across two.';

do $assert_0222$
declare
  v_violations text;
  v_body       text;
begin
  select replace(prosrc, e'\r', '') into v_body
  from pg_proc where oid = 'private.consolidated_comparison(uuid,text,text,text)'::regprocedure;
  if position('using (identity_key, currency)' in v_body) = 0 then
    raise exception '0222: the comparison is not joined on the currency';
  end if;

  if (select count(*) from information_schema.routines r
      where r.routine_schema = 'private' and r.routine_name = 'consolidated_case_lines') = 0 then
    raise exception '0222: consolidated_case_lines is missing';
  end if;
  if not exists (
    select 1 from information_schema.parameters p
    where p.specific_schema = 'private'
      and p.specific_name = (select specific_name from information_schema.routines
                              where routine_schema = 'private' and routine_name = 'consolidated_case_lines')
      and p.parameter_mode = 'OUT' and p.parameter_name = 'currency') then
    raise exception '0222: consolidated_case_lines does not return a currency';
  end if;

  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0222 scope assertions failed:\n%', v_violations;
  end if;
end
$assert_0222$;
