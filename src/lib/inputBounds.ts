/**
 * Bounds the product enforces on numbers a person types, in ONE place.
 *
 * The rule this file exists to keep: **the client bound is a courtesy, the server bound is the
 * control.** Every constant here has a server counterpart, and neither may stand in for the
 * other. A `max` attribute stops a slip; it does not stop a crafted request, an offline replay
 * or a future screen that forgets to ask.
 *
 * Why the numbers are these numbers — both are read off the live catalogue, not invented:
 *
 * - `VAT_RATE_MIN/MAX` mirror the check this repository already places on a VAT rate that
 *   arrives on an invoice line (`0099:108`, `vat_rate between 0 and 100`), and the same 0-100
 *   test the provisioning boundary already applies to a new tenant's rate
 *   (`supabase/functions/_shared/provision.ts:170-172`). `organizations.vat_rate` is the one
 *   surface that carried neither, which is why a matching CHECK is requested for it.
 *
 * - `QUANTITY_MAX` is this repository's own magnitude ceiling for a quantity, already enforced
 *   at four server boundaries before this file existed: the three inventory commands
 *   (`0026:202-203` consumption and adjustment, `0026:294` stocktake) and the supplier-portal
 *   proposal column (`0167:145`, `proposed_qty <= 1000000`). The supplier portal's own client
 *   already parses to the same ceiling (`src/portal/PortalApp.tsx:47`).
 *
 * It is a **magnitude guard, not a business rule.** It exists to refuse a fat finger and a
 * hostile payload, not to express an opinion about how much a business may legitimately buy.
 * Whether a *specific* quantity is sensible for a specific unit is a business question this
 * file deliberately does not answer.
 */

/** Lowest VAT rate a form may submit. Mirrors `0099:108` and `provision.ts:170-172`. */
export const VAT_RATE_MIN = 0;

/** Highest VAT rate a form may submit. Mirrors `0099:108` and `provision.ts:170-172`. */
export const VAT_RATE_MAX = 100;

/**
 * Highest quantity a form may submit. Mirrors `0026:202-203`, `0026:294` and `0167:145`.
 * Deliberately shared by order, receipt, stocktake and invoice-line quantities so the four
 * cannot drift apart the way the VAT rate drifted from its own invoice-line check.
 */
export const QUANTITY_MAX = 1_000_000;

/** True when `value` is a real number inside the inclusive VAT range. Blank/NaN is NOT in range. */
export function isVatRateInRange(value: number): boolean {
  return Number.isFinite(value) && value >= VAT_RATE_MIN && value <= VAT_RATE_MAX;
}

/**
 * True when `value` is a real number no larger than `QUANTITY_MAX` in magnitude.
 * `abs` because an inventory adjustment is signed — `0026:203` bounds `abs(v_delta)`, and a
 * delta of minus ten million is the same fat finger as a delta of plus ten million.
 */
export function isQuantityInRange(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= QUANTITY_MAX;
}
