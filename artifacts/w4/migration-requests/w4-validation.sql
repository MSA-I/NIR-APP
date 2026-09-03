-- =====================================================================================
-- Wave 4 — migration REQUEST: refuse invalid input at the server boundary.
--
-- THIS FILE IS NOT A MIGRATION AND MUST NOT BE APPLIED AS ONE.
-- It is a request written by the Wave 4 agent, which does not own `supabase/migrations/`.
-- The migration owner assigns the number, splits or merges the sections as they see fit, and
-- runs it. No number is claimed here on purpose. `npm run next-number` at the time of writing
-- reported migration head 0290 on origin/main, 0291 through 0294 already taken in this worktree
-- by other agents, four live branches, and 0295 as the next free one — with an explicit
-- COLLISION warning that git would merge two claims on the same number without a conflict.
-- A number chosen by this file would be stale before it was read, so the migration owner runs
-- `npm run next-number` themselves at the moment they write the migration.
--
-- Scope: `organizations.vat_rate` (RC4), the quantity columns, and the identity problem behind
-- the triple-submit finding.
--
-- NOTHING HERE PATCHES AN EXISTING FUNCTION BODY. Sections A-C are additive DDL only, so the
-- anchored-replacement idiom is not needed for them. Section D is the exception and says so.
-- =====================================================================================


-- =====================================================================================
-- SECTION A — MEASUREMENT. Run this FIRST, and run it again on production.
--
-- The plan requires the out-of-range population to be counted before any constraint is chosen,
-- because zero rows and non-zero rows lead to different migrations and only one of them is
-- allowed to be written without an owner ruling.
--
-- ALREADY RUN, read-only, on the LOCAL stack (`supabase_db_supplyflow-p0`) on 2026-09-03:
--
--   organizations                                  6 rows, 0 out of range, min 18.00 max 18.00
--   purchase_order_items.qty                      50 rows, 0 above 1000000, max 80.00
--   purchase_request_items.qty                    17 rows, 0 above 1000000, max 80.00
--   next_order_items.qty                           0 rows
--   goods_receipt_items.qty_received              39 rows, 0 above 1000000, max 80.00
--   purchase_order_items.received_qty             50 rows, 0 above 1000000, max 80.00
--   invoice_lines.quantity                         0 rows
--   invoice_line_matches.allocated_quantity        0 rows
--   inventory_movements.counted_quantity           0 rows
--   inventory_movements.quantity_delta             0 rows
--   delivery_note_interpretation_lines.qty_received 0 rows
--   supplier_products.min_qty                     67 rows, 0 above 1000000, max 20.00
--
-- => ZERO out-of-range rows everywhere. That is the branch that permits ADD CONSTRAINT ... NOT
--    VALID followed immediately by VALIDATE CONSTRAINT, with no remediation policy and no data
--    rewrite of any kind.
--
-- THE LOCAL RESULT DOES NOT LICENSE THE PRODUCTION APPLY. The local stack is the demo database;
-- it is six organizations of fixtures, not the customer's data. Re-run Section A against
-- production before applying Section B or C, and take the branch the PRODUCTION number gives:
--
--   * production result is also 0  -> apply as written below.
--   * production result is NOT 0   -> STOP. Do not widen the bound to fit the data and do not
--                                     clamp the offending rows. Silently rewriting somebody's
--                                     tax rate is a worse defect than the missing constraint.
--                                     The out-of-range rows go to the owner as a list, with the
--                                     org id and the value, for a ruling; the constraint then
--                                     lands NOT VALID only, and VALIDATE waits for that ruling.
-- =====================================================================================

-- A1. The VAT population.
select
  count(*)                                                as total_orgs,
  count(*) filter (where vat_rate is null)                as null_rate,
  count(*) filter (where vat_rate < 0)                    as below_zero,
  count(*) filter (where vat_rate > 100)                  as above_hundred,
  count(*) filter (where vat_rate < 0 or vat_rate > 100)  as out_of_range,
  min(vat_rate)                                           as min_rate,
  max(vat_rate)                                           as max_rate
from public.organizations;

-- A2. The offending rows themselves, so a non-zero A1 produces a list and not just a number.
--     `id` and the value only — no name, so the output can be pasted into a ticket.
select id, vat_rate
from public.organizations
where vat_rate < 0 or vat_rate > 100
order by vat_rate;

-- A3. The quantity population, one row per column, same shape.
select 'purchase_order_items.qty' as col, count(*) as rows,
       count(*) filter (where qty > 1000000) as over, max(qty) as max_seen
  from public.purchase_order_items
union all select 'purchase_order_items.received_qty', count(*),
       count(*) filter (where received_qty > 1000000), max(received_qty)
  from public.purchase_order_items
union all select 'purchase_request_items.qty', count(*),
       count(*) filter (where qty > 1000000), max(qty)
  from public.purchase_request_items
union all select 'next_order_items.qty', count(*),
       count(*) filter (where qty > 1000000), max(qty)
  from public.next_order_items
union all select 'goods_receipt_items.qty_received', count(*),
       count(*) filter (where qty_received > 1000000), max(qty_received)
  from public.goods_receipt_items
union all select 'invoice_lines.quantity', count(*),
       count(*) filter (where quantity > 1000000), max(quantity)
  from public.invoice_lines
union all select 'invoice_line_matches.allocated_quantity', count(*),
       count(*) filter (where allocated_quantity > 1000000), max(allocated_quantity)
  from public.invoice_line_matches
union all select 'inventory_movements.counted_quantity', count(*),
       count(*) filter (where abs(counted_quantity) > 1000000), max(counted_quantity)
  from public.inventory_movements
union all select 'inventory_movements.quantity_delta', count(*),
       count(*) filter (where abs(quantity_delta) > 1000000), max(abs(quantity_delta))
  from public.inventory_movements
union all select 'delivery_note_interpretation_lines.qty_received', count(*),
       count(*) filter (where qty_received > 1000000), max(qty_received)
  from public.delivery_note_interpretation_lines
union all select 'supplier_products.min_qty', count(*),
       count(*) filter (where min_qty > 1000000), max(min_qty)
  from public.supplier_products;


-- =====================================================================================
-- SECTION B — RC4. Bound `organizations.vat_rate` at the server.
--
-- Why a CHECK and not "fix the two screens".
--
-- The live catalogue says `organizations` carries five constraints and not one of them touches
-- `vat_rate`:
--     organizations_base_currency_fkey, organizations_country_code_check,
--     organizations_logo_shape, organizations_pkey, organizations_trial_retired
-- The column is `numeric(5,2) not null default 18.00`, so the ONLY bound that exists today is
-- the precision: anything in [-999.99, 999.99] is accepted, including a negative rate.
--
-- And the screens are not the boundary. `authenticated` holds a direct column grant —
-- `UPDATE (name, settings, vat_rate)` on `public.organizations`, confirmed in
-- `information_schema.column_privileges` and granted at `0036:51` — so any session can PATCH
-- the column through PostgREST without going near a screen. The two client fixes shipped with
-- this wave are courtesies. THIS is the control.
--
-- Why 0 and 100 rather than some other pair: it is the bound this repository already applies to
-- a VAT rate everywhere else it appears. `0099:108` declares
-- `vat_rate numeric(7,4) not null check (vat_rate between 0 and 100)` on an invoice line, and
-- `0099:1424` compares that line's rate directly against `organizations.vat_rate`, so the two
-- are necessarily on the same scale. The provisioning boundary already refuses the same range
-- for a new tenant (`supabase/functions/_shared/provision.ts:170-172`). No new business
-- judgement is being made here — the organization column is simply the one surface that was
-- left out.
--
-- NOT VALID then VALIDATE, rather than a plain ADD CONSTRAINT, is deliberate even at zero rows:
-- the two-step takes only a SHARE UPDATE EXCLUSIVE lock for the scan instead of holding ACCESS
-- EXCLUSIVE for it, and it keeps the shape of the migration identical whichever branch
-- production turns out to be on.
-- =====================================================================================

alter table public.organizations
  add constraint organizations_vat_rate_range
  check (vat_rate >= 0 and vat_rate <= 100) not valid;

-- Run ONLY when Section A1 returned out_of_range = 0 on THIS database.
alter table public.organizations
  validate constraint organizations_vat_rate_range;

comment on constraint organizations_vat_rate_range on public.organizations is
  'A VAT rate is a percentage: 0 to 100 inclusive. Same bound as the invoice-line check and as '
  'the provisioning boundary, so a rate cannot be compared against a rate it could never equal. '
  'The column grant lets any session PATCH vat_rate directly, so this constraint -- not the '
  'settings screen -- is what makes an out-of-range rate impossible.';


-- =====================================================================================
-- SECTION C — quantity ceilings.
--
-- What exists today, read from `pg_constraint` (not from the migration that created it):
--
--   invoice_lines.quantity                          CHECK (quantity > 0)
--   invoice_line_matches.allocated_quantity         CHECK (allocated_quantity > 0)
--   purchase_order_items.qty                        CHECK (qty > 0)
--   purchase_request_items.qty                      CHECK (qty > 0)
--   next_order_items.qty                            CHECK (qty > 0)
--   goods_receipt_items.qty_received                CHECK (qty_received >= 0)
--   supplier_order_proposal_lines.proposed_qty      CHECK (>= 0 AND <= 1000000)   <-- has a ceiling
--   purchase_order_items.received_qty               (no check)
--   inventory_movements.counted_quantity            (no check)
--   inventory_movements.quantity_delta              (no check)
--   delivery_note_interpretation_lines.qty_received (no check)
--   supplier_products.min_qty                       (no check)
--
-- So every quantity has a floor and exactly ONE has a ceiling. `numeric(12,2)` lets the rest
-- reach 9,999,999,999.99, and `invoice_lines.quantity` is `numeric(18,6)`.
--
-- WHERE 1000000 COMES FROM, AND WHY IT IS NOT AN INVENTED BUSINESS ANSWER.
-- It is this repository's own magnitude ceiling for a quantity, already enforced at four places
-- before this request existed: `0026:202` (consumption), `0026:203` (adjustment, on `abs()`),
-- `0026:294` (stocktake count) and `0167:145` (the supplier-portal proposal column above). The
-- supplier portal's client parses to the same number (`src/portal/PortalApp.tsx:47`). What this
-- section does is apply an existing, four-times-repeated decision to the columns that were left
-- out — it does not choose a new number.
--
-- It is a MAGNITUDE GUARD, not a business rule. It refuses a fat finger and a hostile payload.
-- It says nothing about whether a given quantity is commercially sensible, and it deliberately
-- does not encode any relationship between ordered and received quantity — see the open
-- question at the foot of this file.
--
-- The three commands at `0026` already reject an over-ceiling value before writing, so the
-- CHECKs below are a backstop for every OTHER writer of those columns, not a duplicate of the
-- command logic. `inventory_movements` is written by more than the three commands.
-- =====================================================================================

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
-- Nullable: only a stocktake row carries a count. NULL passes a CHECK, which is what we want.
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

-- Run ONLY when Section A3 returned over = 0 for every row on THIS database.
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


-- =====================================================================================
-- SECTION D — the triple-submit. NOT WRITTEN AS SQL, because the fix needs a decision first.
--
-- THE REPRO, measured against the live catalogue rather than assumed:
--
--   Screen : מוצרים (/products), "מוצר חדש". Identically: ספקים (/suppliers), "ספק חדש".
--   Action : type a name, press שמירה.
--   Write  : `supabase.from('products').insert({ ...row, org_id, active })`
--            at `src/pages/Products.tsx:348`, and
--            `supabase.from('suppliers').insert({ ...row, org_id })`
--            at `src/pages/Suppliers.tsx:499`.
--   Repro  : press שמירה; while the request is in flight, drop the connection (DevTools ->
--            Network -> Offline, or simply lose signal on a phone). The row COMMITS; the
--            response never arrives; supabase-js surfaces a network error; `setBusy(false)`
--            re-enables the button and the modal stays open showing the same form. Restore the
--            connection and press שמירה again -> a second identical row. Again -> a third.
--            Three products named the same thing, three different ids, and nothing anywhere
--            refused any of them.
--
-- WHY THE DISABLED BUTTON IS NOT THE FIX HERE, AND WHY IT CANNOT BE.
-- `disabled={busy}` is already present on both screens (`Products.tsx:380`,
-- `Suppliers.tsx`), and it does stop a fast double-click. It cannot stop the sequence above,
-- because that sequence is a legitimate human retry after an apparent failure. The defect is
-- that the server accepts three identical creates. Evidence, all from the live catalogue:
--
--   * `products` carries exactly two unique constraints, `products_pkey (id)` and
--     `p0_products_org_id_id_key (org_id, id)`. `suppliers` mirrors it. BOTH are on the
--     surrogate id. There is no uniqueness on `(org_id, name)`, on a SKU, or on anything else
--     a replay would collide with.
--   * There is no BEFORE INSERT trigger that deduplicates. The triggers on both tables are
--     `zz_organization_write_guard`, the audit trigger, `p0_tenant_identity_guard` (UPDATE
--     only), `products_touch`/`suppliers_touch` (UPDATE only) and the active/soft-delete
--     guards (UPDATE only).
--   * Neither table's insert path takes an idempotency key. Eighteen live commands do
--     (`request_organization_offboarding`, `apply_reviewed_document`,
--     `record_invoice_line_evidence`, ...); these two are not commands at all, they are raw
--     PostgREST inserts.
--   * AND THE CLIENT CANNOT FIX THIS ALONE. `authenticated` may insert
--     `active, barcode, category_id, min_stock, name, notes, org_id, sku, unit` on `products` —
--     `id` IS NOT IN THE GRANT. The browser is structurally unable to supply a stable identity,
--     so the "mint a UUID and let the primary key refuse the replay" fix is not available
--     without a migration. Same on `suppliers`.
--
-- NOTE FOR THE RECORD: every other write path checked in this wave is already protected, and by
-- this repository's own pattern rather than by a disabled button — `InvoiceNew.tsx:47,289`
-- mints `p_invoice_id`, `PaymentRequests.tsx:370` passes `p_request_id`, `Inventory.tsx:497,503`
-- passes `p_movement_id` and renders the returned `idempotent` flag, `Receiving.tsx:776` passes
-- `p_receipt_id`, and `InvoiceLineReviewModal.tsx:190` passes `p_idempotency_key`. Product and
-- supplier creation are the two that were never converted from a raw insert to a command.
--
-- TWO WAYS TO FIX IT. The choice is the migration owner's; the second is recommended.
--
--   OPTION D1 (small): grant INSERT on `products.id` and `suppliers.id` to `authenticated`, and
--     have the two modals mint a stable UUID the way `InvoiceNew` already does
--     (`useState(() => crypto.randomUUID())`). A replay then violates the primary key and the
--     database refuses it. Cheap, invents no business rule, and needs one line of client change
--     per screen. Weaker than the house pattern: the replay surfaces as error 23505 rather than
--     as `{"idempotent": true}`, so the screen has to translate that into "already saved".
--
--   OPTION D2 (recommended): give both tables the command treatment the rest of the product
--     already has — `create_product(p_product_id uuid, ...)` and
--     `create_supplier(p_supplier_id uuid, ...)`, SECURITY DEFINER, returning
--     `{"product_id": ..., "idempotent": true|false}`, refusing a replay whose payload differs
--     with a `*_conflict` error exactly as `execute_payment_request` does at `0023:332`.
--     This matches the eighteen commands already in the catalogue, keeps the audit reason in
--     the same place as every other reasoned command, and lets the browser's INSERT grant on
--     these two tables be withdrawn afterwards.
--
-- THE BUSINESS QUESTION I AM NOT ANSWERING, AND WILL NOT GUESS AT.
-- The tempting one-line fix is `unique (org_id, name)` on `products` and on `suppliers`. I have
-- deliberately NOT written it, because it is not a validation rule, it is a business ruling:
--   * May one catalogue hold two products with the same name and different units or pack sizes
--     ("קמח" in 1kg and in 25kg)? Today it may, and 271 products exist under that assumption.
--   * May two supplier rows share a name — two branches of one chain, or a supplier re-created
--     after a soft delete? `suppliers` has `deleted_at`, so a unique index would also have to
--     decide whether a deleted row still reserves its name.
--   * Neither question is answerable from the code, and getting it wrong makes legitimate data
--     unenterable rather than merely permitting a duplicate.
-- This belongs in `docs/OPEN-DECISIONS.md` as a numbered row with a proposed default. The number
-- must come from `npm run next-number` at the time of writing, not from this file — it reported
-- #347 as next free while this was written, but four branches are live and the row is
-- deliberately NOT added here, because a decision number picked now and merged later is the
-- exact collision the constitution records six of.
-- PROPOSED DEFAULT, for the owner to accept or reject: names are NOT unique; duplicate creation
-- is prevented by identity (D1/D2), not by name; and the screens warn about a same-name row
-- without refusing it. That keeps the fix a validation fix and leaves the catalogue policy
-- where it belongs.
--
-- Note that D1 and D2 both close the triple-submit WITHOUT needing this question answered.


-- =====================================================================================
-- SECTION E — SUITE ASSERTIONS REQUESTED, by existing suite file.
--
-- These are requests, not written tests: `supabase/tests/` follows `supabase/migrations/` and
-- this agent owns neither.
-- =====================================================================================
--
-- IN `supabase/tests/p0_client_dml_acl.sql`  (the browser-write ACL harness — the right home,
-- because the point is what a BROWSER session can write, not what a command permits):
--
--   E1. As `authenticated` in an org, `update public.organizations set vat_rate = 150` raises
--       `check_violation` (23514) naming `organizations_vat_rate_range`. Repeat with -1.
--       This is the assertion that actually proves RC4 closed: it goes through the same column
--       grant the two screens use, so it fails if the constraint is dropped even when both
--       screens still look correct.
--   E2. The same UPDATE with `vat_rate = 0`, `= 18` and `= 100` succeeds. A bound that refuses
--       a legal value is a worse defect than the one being fixed, and 0 is legal (an exempt
--       organization) — it must not be mistaken for "unset".
--   E3. `vat_rate = 17.5` succeeds, so the constraint does not accidentally imply integers.
--
-- IN `supabase/tests/live_schema_alignment.sql`  (catalogue-shape assertions):
--
--   E4. `organizations_vat_rate_range` exists in `pg_constraint` AND `convalidated` is true.
--       The NOT VALID / VALIDATE pair means a half-applied migration leaves a constraint that
--       guards new rows while silently not describing old ones; asserting `convalidated`
--       is what distinguishes "applied" from "applied and finished".
--   E5. Every column named in Section C carries its ceiling constraint and each is
--       `convalidated`. Assert by iterating the column list, not by naming eleven constraints
--       in eleven separate assertions — a list that has to be extended by hand is a list that
--       silently stops covering the next column.
--
-- IN `supabase/tests/p24_inventory_intelligence.sql`  (inventory commands):
--
--   E6. `record_inventory_movement` with `p_quantity = 1000001` still raises, and now so does a
--       direct `insert into inventory_movements` with a delta of 1000001 — the command guard and
--       the column guard are separate controls and the suite should prove both, since the whole
--       reason for the column CHECK is the writer that does not go through the command.
--   E7. A stocktake of exactly 1000000 is still accepted. The boundary is inclusive on both
--       sides and an off-by-one here silently blocks a legitimate count.
--
-- IN `supabase/tests/p20_invoice_three_way_match.sql`  (invoice lines):
--
--   E8. `record_invoice_line_evidence` with a line quantity of 1000001 raises `check_violation`
--       rather than writing an evidence batch. The batch is a financial record; a partially
--       written one is worse than a refused one, so assert no batch row remains afterwards.
--
-- IN `supabase/tests/p1_financial_commands.sql`  (only once Section D is implemented):
--
--   E9. Calling the new create command twice with the SAME caller-supplied id creates one row
--       and returns `idempotent: false` then `idempotent: true`.
--   E10. Calling it twice with the same id and a DIFFERENT payload raises a `*_conflict` error
--        and leaves the first row untouched — the replay must not become an accidental UPDATE.
--   E11. After the change, `authenticated` has no direct INSERT grant on `products` /
--        `suppliers` (D2 only). Without this the old raw-insert door stays open beside the new
--        command and the defect is merely relocated.
-- =====================================================================================
