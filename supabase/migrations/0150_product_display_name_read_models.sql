-- 0150 -- The read models that SHOW a product name start reading the approved one (defect 16).
--
-- ==========================================================================================
-- WHAT THIS IS, AND WHY IT IS SAFE TO SHIP TODAY.
--
-- 0149 added `products.display_name` and the reasoned command that writes it, and deliberately
-- backfilled nothing: NULL means "no canonical name has been approved". This file teaches the
-- read models that SHOW a product name to prefer that name when it exists. The whole change is
-- one expression, `coalesce(p.display_name, p.name)`, and because nothing is backfilled it is a
-- strict NO-OP against today's data -- every row still renders exactly the text it renders now,
-- and starts rendering a canonical name only for rows a person has actually reviewed.
--
-- WHAT IS SWITCHED:
--   * public.inventory_balances     -- `/inventory`, through public.inventory_intelligence, which
--                                      selects the whole balances row (0102) and is what the
--                                      screen actually queries.
--   * public.inventory_movement_feed -- the movement history on the same screen.
--   * private.product_purchase_summary -- `/reports/products`, through get_product_purchase_summary.
--
-- WHAT IS DELIBERATELY NOT SWITCHED, each for its own reason:
--   * 0028:357/:919 and 0029:378/:1062 -- `'product_name', p.name` inside the ORDER MESSAGE SENT
--     TO THE SUPPLIER. The supplier recognises THEIR name for the item. A name we composed arrives
--     at somebody who has never seen it and cannot act on it, which is worse than an ugly name
--     they recognise. Raw, always. `src/lib/share.ts` and `src/lib/orderImage.ts` are the client
--     twins of this rule and carry a test that forbids the display helper.
--   * 0137:818 -- `coalesce(min(product.name), min(keyed.description))` reconciles our catalogue
--     against the supplier's own invoice lines. The comparison is only meaningful against what was
--     actually matched.
--   * 0108:530 -- the document-review assessment's order rows. Evidence beside a scanned document.
--   * 0135:175 and 0096:1404 -- `matched_product_name` in the calibration queue, which exists so
--     an owner can judge whether a document line was matched to the right catalogue row.
--   * 0011:56 -- the `global_search` product branch returns `p.name` AND searches on it. Title and
--     predicate are one unit there: switching only the title would show a canonical name that
--     typing it back cannot find. Left whole, for a decision of its own.
--
-- WHY BOTH OBJECTS ARE PATCHED IN PLACE RATHER THAN RE-DECLARED. THIS IS THE LOAD-BEARING
-- DECISION IN THIS FILE, AND IT IS NOT STYLE.
--
-- Neither object's live definition is the text of the migration that created it:
--
--   * 0133:953-983 rewrote inventory_balances, inventory_movement_feed and inventory_intelligence
--     in place to strip `'kitchen'::user_role` from their role gates, because the kitchen persona
--     was retired. Re-declaring these views from 0026's body would silently RE-ADMIT a retired
--     role to two inventory read models.
--   * 0137:2496-2504 patched private.product_purchase_summary in place to add
--     `i.financial_role = 'payable'` to its invoice predicate. Re-declaring it from 0114's body
--     would silently drop that filter and put non-payable invoices back into a money report.
--
-- Both regressions would apply cleanly, pass every syntax check, and be invisible until somebody
-- noticed a number or a permission was wrong. So this file does what 0133 and 0137 did: it reads
-- the CURRENT definition, asserts the anchor it means to change is still there, changes only that,
-- and fails the migration outright if the anchor has moved. A moved anchor is a definition someone
-- else has edited, and re-deriving it from an old file is exactly the mistake to refuse.
--
-- WHY THE GROUP BY IN product_purchase_summary NEEDS NO CHANGE. `rows_out` groups by
-- `p.id, p.name, p.unit`, and `products.id` is the table's primary key (0001:88). PostgreSQL
-- recognises the functional dependency and permits any other column of `products` in the select
-- list, so `p.display_name` is already legal there. Adding it to the GROUP BY would be redundant
-- and would be a second anchor that could move.
--
-- A5 / EXEMPTION PIN -- verified, not assumed.
--
-- Nothing here is SECURITY DEFINER and nothing changes a definer's body. The two views are
-- `security_invoker = on` (0026, re-stated by 0133) and private.product_purchase_summary is
-- `language sql stable` with no security clause (0114:33-40) -- it is `private` and revoked, and
-- its public door get_product_purchase_summary is untouched by this file. No exemption row is
-- added or removed, and the registry pin in p9_five_domains.sql stays at 89.
-- ==========================================================================================

-- ===== The two inventory views. 0133's own idiom, for the reason given above. =====
do $display_name_views$
declare
  v_view_name text;
  v_definition text;
  v_rewritten text;
begin
  foreach v_view_name in array array[
    'inventory_balances',
    'inventory_movement_feed'
  ] loop
    v_definition := pg_get_viewdef(format('public.%I', v_view_name)::regclass, true);
    -- Case-insensitive and whitespace-tolerant: the deparser's capitalisation of `AS` and its
    -- exact spacing are not contracts, and neither is what this migration is asserting. Without
    -- `g`, exactly the first occurrence is rewritten -- and there is exactly one target-list entry
    -- aliased `product_name` in each of these two definitions.
    v_rewritten := regexp_replace(
      v_definition,
      'p\.name[[:space:]]+AS[[:space:]]+product_name',
      'COALESCE(p.display_name, p.name) AS product_name',
      'i'
    );
    if v_rewritten is not distinct from v_definition then
      raise exception '0150: product-name anchor moved for view public.%', v_view_name;
    end if;
    execute format(
      'create or replace view public.%I with '
      || '(security_invoker = on, security_barrier = on) as %s',
      v_view_name,
      v_rewritten
    );
  end loop;
end
$display_name_views$;

comment on view public.inventory_balances is
  'Stock on hand per active product. `product_name` is the canonical, owner-approved name when one '
  'exists and the raw `products.name` until then (0149/0150). Read by public.inventory_intelligence, '
  'which projects the whole row.';

comment on view public.inventory_movement_feed is
  'Every inventory movement with its product and actor. `product_name` is the canonical, '
  'owner-approved name when one exists and the raw `products.name` until then (0149/0150).';

-- ===== The product purchase summary. 0137's own idiom, for the reason given above. =====
do $display_name_summary$
declare
  v_def text;
  v_rewritten text;
begin
  -- `pg_get_functiondef` returns the stored source verbatim. A definition first applied from a
  -- CRLF file carries the carriage returns into prosrc, where they defeat a literal anchor and
  -- nothing explains why; 0137 strips them for the same reason before matching.
  v_def := replace(pg_get_functiondef(
    'private.product_purchase_summary(uuid,date,date,uuid)'::regprocedure), e'\r', '');
  v_rewritten := regexp_replace(
    v_def,
    'p\.name[[:space:]]+as[[:space:]]+product_name',
    'coalesce(p.display_name, p.name) as product_name',
    'i'
  );
  if v_rewritten is not distinct from v_def then
    raise exception '0150: product_purchase_summary product-name anchor moved';
  end if;
  execute v_rewritten;
end
$display_name_summary$;

comment on function private.product_purchase_summary(uuid, date, date, uuid) is
  'Per-product purchase rollup de-duplicated on purchase_order_items.id. `product_name` is the '
  'canonical, owner-approved name when one exists and the raw products.name until then '
  '(0149/0150); products are still never merged by name, canonical or raw.';

-- ===== Re-assert A1 / A3 / A5 (the 0058:207-218 idiom; required of every post-0057 file) =====
do $$
declare
  v_violations text;
begin
  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations
  from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception e'0150 scope assertions failed:\n%', v_violations;
  end if;
end
$$;
