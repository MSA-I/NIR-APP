-- 0301 — a purchase report that names its cost, and a payment sheet that reports the portion it
-- may report. Wave 5, and owner decision E.
--
-- THE PURCHASE REPORT HAD NO COST AT ALL, and the measurement is the argument: over a whole year
-- of the demo tenant's purchasing, **35 products out of 35** returned a null money figure. The
-- report's only money came from `invoice_lines.line_total` on approved invoices matched to an
-- order item, so a product ordered and received but not yet billed carried a quantity and
-- nothing else. Its own grain CTE already read `purchase_order_items.unit_price` and then never
-- used it again anywhere in the body.
--
-- The committed figure comes from the ORDER SNAPSHOT, not from `supplier_products.currency` that
-- Wave 2 has just threaded: a catalogue price is what a supplier asks today, not what this
-- purchase cost. The order carries its own currency, so nothing is invented — and the ordered
-- figure is never summed with the billed one and never crosses a currency, because those are two
-- different facts about the same product and adding them would be a third.
--
-- DECISION E — the payment sheet is filtered too, and reports only the approved-invoice portion.
-- The plan says this out loud so nobody discovers it late: **row-level security can hide a
-- payment or reveal it; it cannot report a different amount.** So this is NOT a change to
-- `payments_select`, which is deliberately untouched and asserted untouched below. It is a read
-- model — a `security_invoker` view that returns, per payment, the sum of its allocations to
-- invoices the caller may see — and the report reads that instead of the raw row. Answering
-- "invoices the caller may see" with `invoices_select` and the scope rider, rather than with a
-- second copy of those rules inside a definer, is what keeps the two from drifting apart.
--
-- FOUR CONSEQUENCES, recorded here rather than filed later as bugs. The first three the plan
-- predicted; the fourth the implementation found:
--   * the accountant's "paid this month" will legitimately differ from the owner's, whenever a
--     payment touches an unapproved invoice;
--   * the accountant's total will NOT reconcile against the bank statement, by design: it is the
--     approved-invoice portion of money that moved, not the money that moved;
--   * a payment with no visible allocation has no reportable portion, so it does not appear —
--     it is dropped, never reported as zero;
--   * a PARTLY allocated payment is reported at its allocated portion for every reader, the
--     owner included. That difference is money that moved with no invoice behind it, which is
--     what the `payment_without_invoice` exception exists to surface — not something a supplier's
--     line in this report should quietly absorb.
--
-- DECISION D IS SETTLED THE OTHER WAY and nothing here touches it: the invoice sheet stays as it
-- is, approved invoices only, and the export says nothing at all about what was omitted. The
-- "declare the omission" fix was rejected by the owner and is not in this file.
--
-- NO SECURITY DEFINER BODY IS REWRITTEN, so no pinned hash moves — stated because a rewrite that
-- leaves a pin behind fails the scope assertions, and because the pinned wrapper
-- `get_product_purchase_summary` sits directly above the function this file does patch.
-- `private.product_purchase_summary` is plain `language sql stable`, invoker, and registered in
-- neither pin registry.


-- =====================================================================================
-- 1. THE PRODUCT PURCHASE REPORT REPORTS A COST
--
-- WHAT IT REPORTS TODAY. Per product, in a window: ordered / received / invoiced / canonical
-- quantity, three source counts, and money from EXACTLY ONE PLACE -- `invoice_lines.line_total`
-- on APPROVED payable invoices, matched to an order item. So:
--
--   * a product ordered and received but not yet invoiced carries a quantity and NO MONEY AT
--     ALL. `gross_amount_by_currency` is null and `average_unit_price` is null, and the screen
--     prints an em dash in both columns. The em dash is correct for what it says -- nobody has
--     billed us yet, so we do not know what we were billed -- but the report then has nothing
--     to say about what the purchase cost, even though the order said so at the moment it was
--     placed and the constitution protects that snapshot as a first-class fact.
--   * the body already reads `poi.unit_price`, in the `order_items` CTE that is the grain of
--     every other figure, and never uses it.
--
-- MEASURED, NOT SUPPOSED. The patched body was assembled offline from the printed live definition
-- and run as a plain read-only SELECT against the demo organisation on 2026-09-03, window
-- 2026-01-01..2026-12-31: 35 products, and ALL 35 of them return
-- `gross_amount_by_currency: null`. So today this report answers a whole year of purchasing with
-- no money on a single row. After the patch all 35 carry a committed cost -- e.g. "אנטריקוט",
-- 16 units received, billed money still null, committed 2,856.000 ILS.
--
-- WHAT THIS PATCH ADDS. `ordered_amount_by_currency`: per product, the sum of
-- `qty * unit_price` over the window's non-draft, non-cancelled order lines, GROUPED BY THE
-- ORDER'S OWN CURRENCY (`purchase_orders.currency`, NOT NULL). One entry per currency, ordered
-- with the organisation's base currency first exactly as the billed figure already is, never
-- summed across currencies, and never added to the billed figure -- they answer two different
-- questions and a single "cost" column covering both would be the merged number this function's
-- own comments spend three paragraphs refusing to produce.
--
-- WHY THE ORDER SNAPSHOT AND NOT THE SUPPLIER PRICE LIST. Wave 2 gave `supplier_products` and
-- `price_history` an honest currency, and it was tempting to read the catalogue here. A
-- catalogue price is what a supplier is asking today; it is not what this purchase cost. The
-- price snapshotted onto the order line at the moment of ordering is the committed cost of THIS
-- purchase, it is already in scope, it is already immutable
-- (`purchase_order_item_unit_snapshot_immutable`), and it needs no currency invention: the order
-- carries its own.
--
-- WHAT IT DOES NOT DO. It does not change `canonical_qty`, the counting rule, the quantity
-- provenance flags, the unmapped-invoice figures, the ordering of the product list, or the
-- billed figure. A product with no order line in the window still does not appear, because the
-- grain has not moved.
-- =====================================================================================

do $patch_product_purchase_summary$
declare
  v_definition text := replace(pg_get_functiondef(
    'private.product_purchase_summary(uuid,date,date,uuid)'::regprocedure), e'\r', '');
  v_anchor text; v_replacement text; v_count integer;
begin
  -- (a) the grain carries the order's currency. `po` is already joined and already filtered to
  --     this organisation through `poi.org_id = p_org_id` and `po.org_id = poi.org_id`; this
  --     adds a column to a row set, not a table to the query.
  v_anchor := $a0$    select poi.id, poi.product_id, poi.qty, poi.unit_price, poi.unit_snapshot,
           po.supplier_id, po.id as order_id$a0$;
  v_replacement := $r0$    select poi.id, poi.product_id, poi.qty, poi.unit_price, poi.unit_snapshot,
           po.supplier_id, po.id as order_id, po.currency as order_currency$r0$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'w5-exports: order_items grain anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- (b) the committed cost, at its own grain: product x ORDER currency. It sits beside the
  --     billed grain and never joins into a row that would let the two be added.
  v_anchor := $a1$  per_product_currency as (
    select oi.product_id, inv.currency, sum(inv.amount) as amount
    from invoiced inv
    join order_items oi on oi.id = inv.order_item_id
    group by oi.product_id, inv.currency
  ),$a1$;
  v_replacement := $r1$  per_product_currency as (
    select oi.product_id, inv.currency, sum(inv.amount) as amount
    from invoiced inv
    join order_items oi on oi.id = inv.order_item_id
    group by oi.product_id, inv.currency
  ),
  -- What the ORDER committed to, in the ORDER's currency. `purchase_order_items.unit_price` is
  -- the snapshot taken when the order was placed; it was already read into the grain above and
  -- then discarded, so a product received and not yet billed had a quantity and no money at all.
  -- Same shape as the billed grain deliberately: one row per product per currency, so the two
  -- can be shown side by side and can never be summed into one another.
  ordered_per_product_currency as (
    select oi.product_id, oi.order_currency as currency,
           sum(oi.qty * oi.unit_price) as amount
    from order_items oi
    group by oi.product_id, oi.order_currency
  ),$r1$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'w5-exports: per_product_currency anchor count %', v_count; end if;
  v_definition := replace(v_definition, v_anchor, v_replacement);

  -- (c) the row emits it. No `case` guard: every product row in this result stands on at least
  --     one order line by construction, so the list is never empty and never a fabricated zero.
  v_anchor := $a2$        'spans_currencies', row.currency_count > 1,$a2$;
  v_replacement := $r2$        'spans_currencies', row.currency_count > 1,
        -- The committed cost. Not the billed one, and never mixed with it: a product ordered in
        -- dollars and billed in dollars has one entry here and one there, and a product ordered
        -- and not yet billed has one entry here and nothing there. Base currency first, the same
        -- ordering the billed figure uses two lines below.
        'ordered_amount_by_currency', (
          select coalesce(jsonb_agg(jsonb_build_object('currency', opc.currency, 'amount', round(opc.amount, 3))
            order by (opc.currency = (select base_currency from base)) desc, opc.currency), '[]'::jsonb)
          from ordered_per_product_currency opc where opc.product_id = row.product_id),$r2$;
  v_count := (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then raise exception 'w5-exports: row emission anchor count %', v_count; end if;

  execute replace(v_definition, v_anchor, v_replacement);
end
$patch_product_purchase_summary$;


-- =====================================================================================
-- 2. THE PAYMENT READ MODEL -- decision E [owner 03.09]
--
-- THE RULING. The accountant's monthly report shows, per payment, only the portion allocated to
-- invoices that reader may see. A payment covering three invoices of which two are approved is
-- reported at the sum allocated to those two, not in full.
--
-- WHY THIS IS NOT A POLICY CHANGE. Row-level security can hide a payment or reveal it; IT
-- CANNOT REPORT A DIFFERENT AMOUNT. `payments_select` is therefore left exactly as it is --
-- unchanged by this file, deliberately, and the accountant's raw table access is neither
-- widened nor withdrawn here. What changes is where the REPORT reads its figure: not from
-- `payments.amount` any more, but from this read model.
--
-- WHY AN INVOKER VIEW AND NOT A DEFINER FUNCTION. The plan sanctioned "a definer view or
-- function". A definer would have to re-state, in its own words, which invoices the caller may
-- see -- a second copy of `invoices_select`, in a place nobody would think to update when the
-- policy changes. This repository has paid for second copies of a rule more than once. A
-- `security_invoker` view delegates the question to the one policy that already answers it: the
-- join to `invoices` is filtered by the caller's own RLS, so an accountant's sum covers approved
-- invoices and an owner's covers all of them, with no rule written twice. `security_barrier` is
-- set alongside it, matching every other read model in this schema
-- (`invoice_balances_by_currency`, `supplier_balances_by_currency`, `inventory_intelligence`).
--
-- THE SCOPE RIDER COMES ALONG FOR FREE, and this is a real consequence rather than a footnote:
-- `invoices` carries `scope_rider_invoices`, so a reader scoped to one legal entity sees only
-- that entity's allocations, and a payment spread across two entities is reported to them at
-- their entity's portion. That is the same rule as the approval filter, applied to the same
-- join, and it is the behaviour a scoped reader should already have had.
--
-- FOUR CONSEQUENCES, RECORDED BEFORE ANYBODY READS THEM AS BUGS. The first three are the plan's
-- own; the fourth follows from the mechanism and belongs beside them.
--   1. The accountant's "paid this month" will legitimately differ from the owner's, whenever a
--      payment touches an unapproved invoice. INTENDED.
--   2. The accountant's total will NOT reconcile against the bank statement. By design: it is
--      the approved-invoice portion of money that moved, not the money that moved.
--   3. A payment with no allocations at all has no approved portion and does not appear -- there
--      is no row for it here, and the report drops it rather than showing it at zero.
--   4. AND THE ONE THE PLAN DID NOT WRITE DOWN: a payment that is only PARTLY allocated is
--      reported at its allocated portion for EVERY reader, the owner included, because the sum
--      of visible allocations is the figure and an unallocated remainder is not allocated to
--      anything. That is money that moved with no invoice behind it, which is what
--      `payment_without_invoice` exists to surface; it is not a figure this report should be
--      quietly folding into a supplier's line. Recorded here so the first person who notices the
--      owner's total move knows it was a decision.
--
-- ONE CURRENCY PER ROW, AND IT IS NOT A CONVENTION. `payment_allocations` carries a FK on
-- `(org_id, payment_id, currency)` into `payments` and another on `(org_id, invoice_id,
-- currency)` into `invoices`, so every allocation of a payment is already in the payment's own
-- currency. Grouping by currency therefore yields exactly one row per payment today -- and if
-- that ever stops being true, this view produces two rows rather than one wrong sum.
-- =====================================================================================

create or replace view public.payment_reportable_amounts
with (security_invoker = on, security_barrier = on) as
select
  allocation.org_id,
  allocation.payment_id,
  allocation.currency,
  sum(allocation.amount) as reportable_amount,
  count(distinct allocation.invoice_id)::bigint as invoice_count
from public.payment_allocations allocation
join public.invoices invoice
  on invoice.org_id = allocation.org_id
 and invoice.id = allocation.invoice_id
 and invoice.deleted_at is null
where allocation.invoice_id is not null
group by allocation.org_id, allocation.payment_id, allocation.currency;

comment on view public.payment_reportable_amounts is
  'Decision E (owner 03.09.2026): per payment, the sum of its allocations to invoices THE CALLER '
  'MAY SEE. security_invoker, so the filtering is done by invoices_select and the scope rider '
  'rather than by a second copy of them. A payment with no visible invoice allocation has no row '
  'here and does not appear in the report. Credit allocations are excluded: a credit is not an '
  'invoice, and the ruling names invoices.';

-- Same grant as every other read model in this schema. `anon` is never a reader of money; the
-- revoke is a no-op today and stays as a statement of intent.
revoke all on public.payment_reportable_amounts from anon;
grant select on public.payment_reportable_amounts to authenticated;


-- =====================================================================================
-- 3. WHAT THIS FILE DELIBERATELY DOES NOT CHANGE
--
--   * `payments_select`. Decision E is not a visibility change. Untouched.
--   * The INVOICE sheet. Decision D is settled the other way: the accountant sees approved
--     invoices only and the export says NOTHING about what was omitted. No omission notice was
--     added anywhere, on any sheet.
--   * `public.create_monthly_report_snapshot(date,uuid)` -- the LOCKED final report. Its payment
--     sheet still carries each payment in full, and that is a decision, not an oversight:
--       - it is SECURITY DEFINER and reads for the ORGANISATION, not for the caller, so
--         "invoices the caller may see" has no meaning inside it;
--       - it stamps a `content_hash` over the rows it assembled. If its content depended on who
--         pressed the button, the owner and the accountant would produce two different hashes for
--         the same month and the same legal entity, and the artifact's whole identity -- one
--         locked version, hash-named, delivered and referenced -- would stop meaning anything;
--       - its invoice sheet is likewise unfiltered by `review_status`, which is why decisions D
--         and E read as descriptions of the LIVE report: the filtering they describe is RLS
--         filtering, and the snapshot has none.
--     If the owner wants the locked artifact filtered too, that is a separate ruling with a
--     separate mechanism (a stated basis recorded ON the snapshot, not a caller-dependent body),
--     and it is not this wave's to invent.
-- =====================================================================================


-- =====================================================================================
-- 4. POSTFLIGHT -- the assertions this migration must not be allowed to skip
-- =====================================================================================

do $assert_w5_exports$
declare v_violations text;
begin
  -- 1. The committed cost is emitted, and the billed one is still emitted beside it.
  if position('ordered_amount_by_currency' in (select prosrc from pg_proc where oid =
       'private.product_purchase_summary(uuid,date,date,uuid)'::regprocedure)) = 0 then
    raise exception 'w5-exports: the product purchase report still reports no committed cost';
  end if;
  if position('gross_amount_by_currency' in (select prosrc from pg_proc where oid =
       'private.product_purchase_summary(uuid,date,date,uuid)'::regprocedure)) = 0 then
    raise exception 'w5-exports: the billed figure was lost while adding the committed one';
  end if;
  -- 2. The payable filter this reader is inventoried for (p46) survived the patch.
  if position('financial_role = ''payable''' in (select prosrc from pg_proc where oid =
       'private.product_purchase_summary(uuid,date,date,uuid)'::regprocedure)) = 0 then
    raise exception 'w5-exports: the payable filter was lost while adding the committed cost';
  end if;
  -- 3. The pinned wrapper did not move. Its hash is in private.scope_definer_enforcements and
  --    nothing in this file touches it; assert that rather than trusting it.
  if exists (
    select 1 from private.scope_definer_enforcements pin
    where pin.function_signature = 'get_product_purchase_summary(date,date,uuid)'
      and pin.body_hash <> '6aba764f7d94d4bbb9003f3e966fd02b'
  ) then
    raise exception 'w5-exports: the pinned wrapper hash moved -- stop and re-measure';
  end if;

  -- 4. The read model exists, runs the caller's own RLS, and is readable by a signed-in user.
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'payment_reportable_amounts' and c.relkind = 'v'
      and 'security_invoker=on' = any(c.reloptions)
  ) then
    raise exception 'w5-exports: the payment read model is missing or is not security_invoker';
  end if;
  if not has_table_privilege('authenticated', 'public.payment_reportable_amounts', 'SELECT') then
    raise exception 'w5-exports: the payment read model is not readable by a signed-in user';
  end if;
  if has_table_privilege('anon', 'public.payment_reportable_amounts', 'SELECT') then
    raise exception 'w5-exports: the payment read model is readable without signing in';
  end if;

  -- 5. `payments_select` was NOT touched. Decision E is not a visibility change, and a migration
  --    that quietly widened or narrowed it would be doing something nobody asked for.
  if (select pg_get_expr(polqual, polrelid) from pg_policy
      where polrelid = 'public.payments'::regclass and polname = 'payments_select')
     <> '((org_id = auth_org()) AND (auth_role() = ANY (ARRAY[''owner''::user_role, ''accountant''::user_role])))'
  then
    raise exception 'w5-exports: payments_select changed, and decision E does not change it';
  end if;

  select string_agg(assertion || ' -- ' || detail, e'\n' order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then raise exception e'w5-exports scope failed:\n%', v_violations; end if;
  select string_agg(detail, e'\n' order by detail) into v_violations
  from private.tenant_export_registry_violations();
  if v_violations is not null then raise exception e'w5-exports export failed:\n%', v_violations; end if;
end
$assert_w5_exports$;


-- =====================================================================================
-- SUITE ASSERTIONS REQUESTED -- named by the existing file each belongs in
--
-- These are the assertions I want. I have not written them into the suites because the suites run
-- against the shared local stack and running one resets it.
--
-- supabase/tests/p34_product_purchase_summary.sql   (the product purchase report)
--   The suite already has the helper these need: `pg_temp.p34_money(product, key, currency)`
--   takes the key name, so it reads `ordered_amount_by_currency` with no new plumbing. Nothing in
--   this suite asserts an exhaustive key set, so the new key breaks none of its 20-odd existing
--   assertions.
--   1. THE ONE THIS WAVE EXISTS FOR. A product on a non-draft order, RECEIVED IN FULL, with no
--      invoice matched to it. Assert `gross_amount_by_currency` is still null (nobody has billed
--      us; that em dash is correct), and assert `ordered_amount_by_currency` is a single entry
--      equal to `qty * unit_price` in the ORDER's currency. Today the row carries no money at
--      all, so this assertion fails before the patch -- which is the point of writing it.
--   2. TWO ORDERS, TWO CURRENCIES, ONE PRODUCT: one order in ILS and one in USD. Assert
--      `ordered_amount_by_currency` has exactly two entries, that neither is the sum of the two,
--      and that the base-currency entry is FIRST -- the same ordering the billed figure uses.
--   3. THE SNAPSHOT IS THE SNAPSHOT. Place an order at 5, then move `supplier_products
--      .current_price` to 999. Assert the committed figure still reads from the order line and
--      does not move. This is p33's price-snapshot proof applied to the new column, and it is
--      the assertion that stops anyone "improving" this by reading the catalogue.
--   4. Draft and cancelled orders contribute NOTHING to the committed figure, exactly as they
--      contribute nothing to every quantity in this report.
--   5. `average_unit_price` did not change: still null when the product spans currencies or has
--      no approved invoice, still the billed money over the canonical quantity otherwise. The
--      committed cost must not have leaked into the unit price.
--
-- supabase/tests/p3_org_scope.sql   (the role and scope contract, which already proves
--                                    "office: zero rows; accountant: approved-only")
--   6. THE RULING ITSELF. One payment of 300 allocated 100 / 100 / 100 across three invoices of
--      which two are approved and one is `pending_approval`. Read
--      `public.payment_reportable_amounts` AS THE ACCOUNTANT: assert exactly one row for that
--      payment and `reportable_amount = 200`. Read it as the owner: assert `reportable_amount =
--      300`. Two readers, two true numbers, one view.
--   7. A payment with NO allocations at all returns no row for either reader -- not a row of
--      zero. A zero row would be this product asserting that nothing was paid.
--   8. A payment allocated ONLY to a credit request returns no row: a credit is not an invoice,
--      and the ruling names invoices.
--   9. THE SCOPE RIDER. A reader scoped to one legal entity sees only the portion allocated to
--      that entity's invoices, and a reader with no scope grant for either sees no row.
--  10. `payments_select` is unchanged and the accountant can still read the raw `payments` row
--      at its full amount. The read model is where the REPORT's figure comes from; it is not a
--      claim that the raw row became invisible.
--
-- supabase/tests/monthly_report_snapshots.sql   (the locked artifact)
--  11. THE DELIBERATE NON-CHANGE, pinned so a later wave cannot drift it without noticing:
--      `create_monthly_report_snapshot` produces the SAME `content_hash` for the same month and
--      legal entity whether the owner or the accountant creates it, with an unapproved invoice
--      present and allocated. The locked artifact does not depend on who pressed the button.
-- =====================================================================================
