-- 0226: the consolidated workspace payload names the currency of every figure it carries.
--
-- WHAT WAS LEFT BEHIND BY 0222. That migration re-grained the reconciliation itself: the case
-- lines are keyed by `(identity_key, currency)` and every comparison is joined on both, so a
-- `difference_amount` is a subtraction inside one currency and never across two. It stopped at
-- the lines. The same payload also carries an ANCHOR object and a SOURCES array, and those two
-- still hand the browser bare numbers — `total_amount`, `amount_before_vat`, `vat_amount` — with
-- nothing saying what kind of money they are. The screen then had no honest way to render them,
-- which is how this was found: `ConsolidatedInvoices.tsx` could not call `fmtMoneyExact` without
-- a currency, and there was none to pass.
--
-- WHAT IT ADDS, AND THE ONE THING IT FIXES.
--   * the anchor gains `currency` — the anchor is one invoice, so this is that invoice's own.
--   * an interim-invoice source gains `currency` — likewise, one invoice.
--   * a goods-receipt source gains `currency`, and its total stops being a cross-currency sum.
--     A receipt's value was `sum(qty_received * order_item.unit_price)` over the receipt's lines,
--     and those lines can belong to purchase orders in different currencies. That sum is the
--     forbidden number: it adds unlike money and prints it as one figure next to the anchor's.
--     From here it is computed per currency, and a receipt whose lines span two currencies
--     reports `total_amount` null with `currency` null and `spans_currencies` true — the screen
--     says so in words rather than showing a total that is not a total.
--
-- WHY AN ANCHORED REPLACEMENT. `get_consolidated_invoice_workspace` is ~7,000 characters of
-- case resolution, source assembly, revision history and warning aggregation. Retyping it to add
-- three keys is how a clause goes missing — the rule `check:anchored-replacements` enforces. The
-- live body is read, carriage returns are stripped (the CRLF difference that aborted the 0181
-- rollout), the three anchors are replaced, and the result is re-executed. A missing anchor
-- fails the migration rather than silently doing nothing.
--
-- WHAT THIS IS NOT. It is not a change to what a consolidated case MEANS, and it is not the
-- intake path: whether a case may hold sources in more than one currency at all is a question
-- for phase 4, where a document's currency stops being assumed. This file only stops the read
-- model from handing the browser money with no unit on it.

do $anchor_0226$
declare
  v_definition text;
  v_patched    text;
  v_anchor_anchor constant text :=
    '''total_amount'',invoice.total_amount,''financial_role'',invoice.financial_role,';
  v_source_anchor constant text :=
    '''total_amount'',case when source.source_type=''interim_invoice''
      then invoice.total_amount else receipt_total.total_amount end,';
  v_lateral_anchor constant text :=
    '    select sum(item.qty_received*order_item.unit_price) as total_amount
    from public.goods_receipt_items item
    join public.purchase_order_items order_item
      on order_item.org_id=item.org_id and order_item.id=item.order_item_id
    where item.org_id=source.org_id and item.receipt_id=source.receipt_id
      and item.status in (''full'',''partial'')';
  v_probe      text;
  v_count int;
begin
  v_definition := replace(
    pg_get_functiondef('public.get_consolidated_invoice_workspace(uuid)'::regprocedure),
    e'\r', '');

  -- Each anchor exactly once. Two would mean the anchor is not the one this migration reasoned
  -- about, and a blind replace would edit a second site nobody read.
  foreach v_probe in array array[v_anchor_anchor, v_source_anchor, v_lateral_anchor] loop
    v_count := (length(v_definition) - length(replace(v_definition, v_probe, '')))
               / length(v_probe);
    if v_count <> 1 then
      raise exception '0226: an anchor appears % times, not once: %', v_count, left(v_probe, 60);
    end if;
  end loop;

  v_patched := v_definition;

  -- 1. the anchor invoice states its own currency.
  v_patched := replace(v_patched, v_anchor_anchor,
    '''total_amount'',invoice.total_amount,''currency'',invoice.currency,'
    || '''financial_role'',invoice.financial_role,');

  -- 2. the source's total, and the currency it is in. A receipt spanning two currencies has no
  --    single total, so it reports none — `—` on the screen, never a number that adds them.
  v_patched := replace(v_patched, v_source_anchor,
    '''total_amount'',case when source.source_type=''interim_invoice''
      then invoice.total_amount else receipt_total.total_amount end,
    ''currency'',case when source.source_type=''interim_invoice''
      then invoice.currency else receipt_total.currency end,
    ''spans_currencies'',coalesce(receipt_total.currency_count,0) > 1,');

  -- 3. the receipt's value, computed inside each currency instead of across all of them.
  v_patched := replace(v_patched, v_lateral_anchor,
    '    select
      case when count(distinct order_item_currency.currency) = 1
        then sum(item.qty_received*order_item.unit_price) end as total_amount,
      case when count(distinct order_item_currency.currency) = 1
        then min(order_item_currency.currency) end as currency,
      count(distinct order_item_currency.currency) as currency_count
    from public.goods_receipt_items item
    join public.purchase_order_items order_item
      on order_item.org_id=item.org_id and order_item.id=item.order_item_id
    join public.purchase_orders order_item_currency
      on order_item_currency.org_id=order_item.org_id
     and order_item_currency.id=order_item.order_id
    where item.org_id=source.org_id and item.receipt_id=source.receipt_id
      and item.status in (''full'',''partial'')');

  if v_patched = v_definition then
    raise exception '0226: nothing was replaced in the live body';
  end if;

  execute v_patched;
end
$anchor_0226$;

-- A5: the body changed, so the pinned hash is recomputed here — from `pg_proc`, never written as
-- a literal digest, because a body applied from Windows carries CRLF and one applied on a Linux
-- runner does not.
update private.scope_definer_enforcements enforcement
set body_hash = md5(replace(proc.prosrc, e'\r', '')),
    scope_proof = '0226 adds the currency of the anchor invoice and of each source to the '
      || 'workspace payload, and computes a goods receipt''s value inside one currency instead '
      || 'of summing across the currencies of the orders its lines came from. The case '
      || 'resolution, the org and legal-entity scoping and the read-only nature of the function '
      || 'are untouched.'
from pg_catalog.pg_proc proc
where proc.oid = pg_catalog.to_regprocedure('public.get_consolidated_invoice_workspace(uuid)')
  and enforcement.function_signature = 'get_consolidated_invoice_workspace(uuid)';

do $assert_0226$
declare
  v_body       text;
  v_violations text;
begin
  select replace(prosrc, e'\r', '') into v_body
  from pg_proc where oid = 'public.get_consolidated_invoice_workspace(uuid)'::regprocedure;

  if position('''currency'',invoice.currency' in v_body) = 0 then
    raise exception '0226: the anchor does not name its currency';
  end if;
  if position('''spans_currencies''' in v_body) = 0 then
    raise exception '0226: a source does not report whether it spans currencies';
  end if;
  if position('count(distinct order_item_currency.currency)' in v_body) = 0 then
    raise exception '0226: the receipt total is still summed across currencies';
  end if;

  -- The properties the anchored replacement must not have dropped.
  if not (select prosecdef from pg_proc
           where oid = 'public.get_consolidated_invoice_workspace(uuid)'::regprocedure) then
    raise exception '0226: the workspace reader stopped being SECURITY DEFINER';
  end if;

  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception '0226: scope enforcement violations remain:%', e'\n' || v_violations;
  end if;
end
$assert_0226$;
