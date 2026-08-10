# Browser supplier/finance gate repair handoff — 2026-08-09

## What changed

- `supplier_portal_context()` in migration `0109` now returns the authenticated supplier's `status` inside the existing narrow `supplier` object.
- `/my-prices` consumes `portal.supplier.status` and no longer queries the RLS-blocked `suppliers` base table.
- P17 and P23 DB contracts now assert that the supplier-scoped projection includes the expected status while base-table access remains denied.
- The payment-request and bank Browser-smoke scenarios now intercept `financial_supplier_directory`, which is the projection used by the application, instead of the obsolete `suppliers` endpoint.
- Those two Browser fixtures now use valid UUID supplier identifiers and return all fields in the financial directory projection.
- A pure Vitest contract guards both projection choices and the UUID fixture shape.

## Why

- The supplier portal timeout was a product regression introduced when inactive-supplier semantics added a direct `suppliers.status` read. Supplier agents intentionally cannot read that base row, so PostgREST returned `406` and the page rendered an error state without its heading.
- The finance timeouts were stale Browser fixtures. The application had moved to `financial_supplier_directory`, but the harness still mocked `suppliers`; the unmocked projection received non-UUID IDs and PostgREST rejected them with `400`.

## Files touched

- `supabase/migrations/0109_supplier_purchase_order_portal.sql`
- `src/pages/SupplierPrices.tsx`
- `supabase/tests/p17_financial_supplier_view.sql`
- `supabase/tests/p23_supplier_portal.sql`
- `scripts/check-browser-smoke.cjs`
- `src/pages/supplierPortalContract.spec.ts`
- `handoff/improvement-campaign-20260809-browser-supplier-finance.md`

## Migration impact

- No new migration was added. Migration `0109`, which is part of the not-yet-deployed campaign sequence, was extended before production deployment.
- The SECURITY DEFINER boundary and its tenant/supplier filtering did not change; only the authenticated supplier's own commerce status was added to the narrow result.
- The scope-enforcement body hash is populated from the final function body later in the same migration, so it remains aligned after reset/application.

## Tests added or updated

- Updated P17/P23 SQL assertions for the projected status.
- Added `src/pages/supplierPortalContract.spec.ts` with three static/pure contract tests:
  - no direct supplier-base-table read from `/my-prices`;
  - status is present in the RPC projection;
  - finance Browser fixtures mock the correct projection using UUIDs.

## Assumptions

- Campaign migrations `0100`–`0111` have not yet been applied to live production; therefore editing `0109` preserves forward-only production history.
- Supplier status is safe and required within the supplier's own narrow portal context because it controls whether new commercial actions are offered.

## Risks and remaining verification

- A local DB reset/application must still prove the altered function compiles and refreshes the recorded scope hash.
- P17 and P23 must still run against the reset database.
- The focused Browser scenarios and the complete Browser/quality gates must still run against the live local stack.
- No authorization was broadened, but final DB/RLS review should confirm supplier base-table reads remain zero.

## Verification performed

- `git diff --check` on all touched implementation/test files: PASS.
- `node --check scripts/check-browser-smoke.cjs`: PASS.
- `npm.cmd exec vitest run src/pages/supplierPortalContract.spec.ts`: PASS — 1 file, 3 tests, 2.45s.
- DB reset/tests, Browser smoke and `npm run quality`: intentionally not run in this subtask per parent instruction.
