-- 0295 — the bounds a screen cannot be trusted to keep, and an identity a retry can collide with.
-- Wave 4 of docs/plans/2026-09-03-qa-remediation-plan.md: RC4, the quantity ceilings, and the
-- triple-submit.
--
-- MEASURED FIRST, because the plan requires the out-of-range population to be counted before a
-- constraint is chosen: zero rows and non-zero rows lead to different migrations, and only one of
-- them may be written without an owner ruling. Read-only on the local stack, 03.09.2026:
--
--   organizations.vat_rate                           6 rows, 0 out of range, min 18.00 max 18.00
--   purchase_order_items.qty / .received_qty        50 rows, 0 over 1000000, max 80.00
--   purchase_request_items.qty                      17 rows, 0 over, max 80.00
--   goods_receipt_items.qty_received                39 rows, 0 over, max 80.00
--   supplier_products.min_qty                       67 rows, 0 over, max 20.00
--   next_order_items, invoice_lines, invoice_line_matches,
--   inventory_movements, delivery_note_interpretation_lines   0 rows
--
-- Zero everywhere, which is the branch that permits NOT VALID followed immediately by VALIDATE,
-- with no remediation policy and no data rewrite. **The local result does not license the
-- production apply.** This is the demo database — six organizations of fixtures, not a customer's
-- data. Re-run the measurement on production before applying. If production is NOT zero: stop,
-- do not widen the bound to fit the data and do not clamp the rows. Silently rewriting somebody's
-- tax rate is a worse defect than the missing constraint. The constraint lands NOT VALID only,
-- the offending rows go to the owner as a list, and VALIDATE waits for the ruling.
--
-- RC4 — WHY A CHECK AND NOT "FIX THE TWO SCREENS". The live catalogue says `organizations`
-- carries five constraints and not one touches `vat_rate`; the column is `numeric(5,2)`, so the
-- only bound today is the precision and a NEGATIVE rate is accepted. And the screens are not the
-- boundary: `authenticated` holds a direct column grant `UPDATE (name, settings, vat_rate)`
-- (`0036:51`), so any session can PATCH the column through PostgREST without going near a screen.
-- 0 to 100 is not a new judgement — `0099:108` already bounds an invoice line's `vat_rate` to
-- exactly that, `0099:1424` compares that line's rate directly against this column, and the
-- provisioning boundary refuses the same range for a new tenant.
--
-- TWO CORRECTIONS TO THE PLAN'S RC4 TEXT, both made against the live code. `Admin.tsx` is not an
-- unbounded server path: `_shared/provision.ts:170-172` already refuses a rate outside 0-100 and
-- `admin-provision` calls it, so that screen was missing only the client attributes. And there is
-- a THIRD writer the plan does not name, `Onboarding.tsx`, which was already correct — it is the
-- in-repo precedent the other two were brought up to.
--
-- THE QUANTITY CEILINGS ARE NOT AN INVENTED NUMBER. Every quantity column already has a floor and
-- exactly ONE has a ceiling. `1000000` is this repository's own magnitude ceiling for a quantity,
-- enforced four times before this migration existed: `0026:202` (consumption), `0026:203`
-- (adjustment, on `abs()`), `0026:294` (stocktake) and `0167:145` (`proposed_qty`). This applies a
-- four-times-repeated decision to the columns that were left out. It is a MAGNITUDE guard — it
-- refuses a fat finger and a hostile payload, says nothing about whether a quantity is
-- commercially sensible, and deliberately encodes no relationship between ordered and received.
-- The three commands at `0026` already reject an over-ceiling value, so these are a backstop for
-- every OTHER writer of those columns, not a duplicate of the command logic.
--
-- THE TRIPLE-SUBMIT IS A SERVER DEFECT AND THE DISABLED BUTTON CANNOT FIX IT. Press save on
-- `/products`; drop the connection while the request is in flight. The row COMMITS, the response
-- never arrives, the button re-enables and the form is still there. Press save again and there is
-- a second identical row — a legitimate human retry after an apparent failure, which no
-- `disabled={busy}` can prevent. `products` and `suppliers` carry unique constraints only on the
-- surrogate id, no deduplicating trigger, and no idempotency key; and the browser is
-- STRUCTURALLY unable to fix it, because `id` is not in its INSERT grant, so it cannot mint the
-- stable identity that would let a replay collide.
--
-- SO THIS GRANTS `id`, AND DELIBERATELY DOES NOT CONVERT THE TWO TABLES TO COMMANDS. The house
-- pattern is a SECURITY DEFINER command returning `{"idempotent": true}` — eighteen live commands
-- do it — and converting these two would also let the raw INSERT grant be withdrawn, which is the
-- stronger fix. It is not taken here because `products` is inserted from SIX client call sites
-- and `suppliers` from two, including the bulk onboarding import and the price-list intake, and
-- rewriting all eight to close a duplicate-row defect on two modals is a refactor of the intake
-- paths wearing this finding's clothes. With `id` granted, a retry violates the primary key and
-- the DATABASE refuses the duplicate; the screen reads 23505 on its own id as "this was already
-- saved". The residue, recorded rather than hidden: the replay surfaces as an error code the
-- screen must translate instead of as an `idempotent` flag, and the command conversion remains
-- the better end state.

-- ===================================================================================
-- 1. RC4 — a VAT rate is a percentage
-- ===================================================================================
alter table public.organizations
  add constraint organizations_vat_rate_range
  check (vat_rate >= 0 and vat_rate <= 100) not valid;

comment on constraint organizations_vat_rate_range on public.organizations is
  'A VAT rate is a percentage: 0 to 100 inclusive, the same bound the invoice line carries at '
  '0099:108 and the provisioning boundary applies to a new tenant, so a rate can never be '
  'compared against a rate it could not equal. The column grant lets any session PATCH vat_rate '
  'directly, so this constraint -- not the settings screen -- is what makes an out-of-range rate '
  'impossible. 0 is legal: an exempt organization is not an unset one.';

-- ===================================================================================
-- 2. Quantity ceilings, on every column that had a floor and no roof
-- ===================================================================================
alter table public.purchase_order_items
  add constraint purchase_order_items_qty_ceiling check (qty <= 1000000) not valid;
alter table public.purchase_order_items
  add constraint purchase_order_items_received_qty_range
  check (received_qty >= 0 and received_qty <= 1000000) not valid;
alter table public.purchase_request_items
  add constraint purchase_request_items_qty_ceiling check (qty <= 1000000) not valid;
alter table public.next_order_items
  add constraint next_order_items_qty_ceiling check (qty <= 1000000) not valid;
alter table public.goods_receipt_items
  add constraint goods_receipt_items_qty_ceiling check (qty_received <= 1000000) not valid;
alter table public.invoice_lines
  add constraint invoice_lines_quantity_ceiling check (quantity <= 1000000) not valid;
alter table public.invoice_line_matches
  add constraint invoice_line_matches_allocated_qty_ceiling
  check (allocated_quantity <= 1000000) not valid;
-- Signed: an adjustment delta may legitimately be negative, and `0026:203` bounds `abs()`.
alter table public.inventory_movements
  add constraint inventory_movements_quantity_delta_ceiling
  check (abs(quantity_delta) <= 1000000) not valid;
-- Nullable: only a stocktake row carries a count, and NULL passes a CHECK, which is what we want.
alter table public.inventory_movements
  add constraint inventory_movements_counted_quantity_range
  check (counted_quantity is null or (counted_quantity >= 0 and counted_quantity <= 1000000))
  not valid;
alter table public.delivery_note_interpretation_lines
  add constraint delivery_note_interpretation_lines_qty_range
  check (qty_received is null or (qty_received >= 0 and qty_received <= 1000000)) not valid;
alter table public.supplier_products
  add constraint supplier_products_min_qty_range
  check (min_qty is null or (min_qty >= 0 and min_qty <= 1000000)) not valid;

-- ===================================================================================
-- 3. VALIDATE — only because the measurement above returned zero on this database.
--
-- NOT VALID then VALIDATE rather than a plain ADD is deliberate even at zero rows: the two-step
-- takes SHARE UPDATE EXCLUSIVE for the scan instead of holding ACCESS EXCLUSIVE for it, and it
-- keeps the migration the same shape whichever branch production turns out to be on. The verify
-- block below asserts `convalidated`, because a half-applied migration leaves a constraint that
-- guards new rows while silently not describing the old ones.
-- ===================================================================================
alter table public.organizations validate constraint organizations_vat_rate_range;
alter table public.purchase_order_items validate constraint purchase_order_items_qty_ceiling;
alter table public.purchase_order_items validate constraint purchase_order_items_received_qty_range;
alter table public.purchase_request_items validate constraint purchase_request_items_qty_ceiling;
alter table public.next_order_items validate constraint next_order_items_qty_ceiling;
alter table public.goods_receipt_items validate constraint goods_receipt_items_qty_ceiling;
alter table public.invoice_lines validate constraint invoice_lines_quantity_ceiling;
alter table public.invoice_line_matches validate constraint invoice_line_matches_allocated_qty_ceiling;
alter table public.inventory_movements validate constraint inventory_movements_quantity_delta_ceiling;
alter table public.inventory_movements validate constraint inventory_movements_counted_quantity_range;
alter table public.delivery_note_interpretation_lines
  validate constraint delivery_note_interpretation_lines_qty_range;
alter table public.supplier_products validate constraint supplier_products_min_qty_range;

-- ===================================================================================
-- 4. The identity a retry can collide with
--
-- Only `id`, and only on these two tables. Every other column grant is untouched, RLS still
-- decides which organization a row may belong to, and the primary key still decides that an id
-- exists once. What changes is that the browser can now say WHICH row it is creating, so pressing
-- save twice after a dropped connection is one row and a refusal rather than two rows.
-- ===================================================================================
grant insert (id) on public.products to authenticated;
grant insert (id) on public.suppliers to authenticated;

do $assert_0295$
declare
  v_unvalidated text;
  v_violations text;
begin
  select string_agg(conname, ', ' order by conname) into v_unvalidated
  from pg_constraint
  where conname in (
    'organizations_vat_rate_range',
    'purchase_order_items_qty_ceiling', 'purchase_order_items_received_qty_range',
    'purchase_request_items_qty_ceiling', 'next_order_items_qty_ceiling',
    'goods_receipt_items_qty_ceiling', 'invoice_lines_quantity_ceiling',
    'invoice_line_matches_allocated_qty_ceiling',
    'inventory_movements_quantity_delta_ceiling', 'inventory_movements_counted_quantity_range',
    'delivery_note_interpretation_lines_qty_range', 'supplier_products_min_qty_range')
    and not convalidated;
  if v_unvalidated is not null then
    raise exception '0295: constraint(s) guard new rows but do not describe the old ones: %',
      v_unvalidated;
  end if;
  if (select count(*) from pg_constraint where conname in (
        'organizations_vat_rate_range',
        'purchase_order_items_qty_ceiling', 'purchase_order_items_received_qty_range',
        'purchase_request_items_qty_ceiling', 'next_order_items_qty_ceiling',
        'goods_receipt_items_qty_ceiling', 'invoice_lines_quantity_ceiling',
        'invoice_line_matches_allocated_qty_ceiling',
        'inventory_movements_quantity_delta_ceiling',
        'inventory_movements_counted_quantity_range',
        'delivery_note_interpretation_lines_qty_range', 'supplier_products_min_qty_range')) <> 12
  then
    raise exception '0295: not every bound landed';
  end if;

  -- 0 must stay legal. A bound that refuses a legal value is a worse defect than the one it fixes,
  -- and an exempt organization is not an unset one.
  if not (0::numeric >= 0 and 0::numeric <= 100) then
    raise exception '0295: the VAT bound would refuse an exempt organization';
  end if;

  if not has_column_privilege('authenticated', 'public.products', 'id', 'insert')
     or not has_column_privilege('authenticated', 'public.suppliers', 'id', 'insert') then
    raise exception '0295: the browser still cannot name the row it is creating, so a retry still duplicates';
  end if;

  select string_agg(assertion || ' -- ' || detail, chr(10) order by assertion, detail)
    into v_violations from private.scope_enforcement_violations();
  if v_violations is not null then
    raise exception '0295 scope assertions failed:%', chr(10) || v_violations;
  end if;
end
$assert_0295$;
