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
 *
 * ONE ENTRY HERE HAS NO SERVER COUNTERPART, AND SAYS SO RATHER THAN PRETENDING OTHERWISE.
 * `BANK_MATCH_DAYS_MIN` bounds `organizations.settings.bank_match_days`, which lives inside a
 * `jsonb` column with no CHECK, is read by no server function, and is consumed in exactly one
 * place — `Bank.tsx` builds `[tx_date - days, tx_date + days]` with `addCalendarDays` and scores
 * a payment dated inside that window higher. So the rule above is not satisfied and cannot be
 * satisfied by editing this file; a constraint for it is a migration, and PR 42 draws no number.
 * What is written here is therefore only what the ARITHMETIC already decides, which is not a
 * business judgement: a negative window inverts the range into one no date can fall inside, and
 * `Date.UTC` truncates a fractional day, so `7.5` is a value the product cannot honour.
 *
 * THERE IS DELIBERATELY NO MAXIMUM. `docs/OPEN-DECISIONS.md` row 3 records the DEFAULT window
 * (±7 days) and no ceiling, and no server bound exists to mirror. A `max` chosen on this screen
 * would be an owner's answer written by a developer, which is the one thing the constitution
 * forbids outright — so the screen states the unit and what the number does instead, and the
 * ceiling stays an open question rather than a quiet guess.
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
 * Narrowest bank-matching window a form may submit, in whole calendar days.
 *
 * Zero is a real setting — "only a payment dated the same day scores as near" — so the floor is
 * `0` and not `1`. Below it the window inverts and stops being a window at all.
 */
export const BANK_MATCH_DAYS_MIN = 0;

/** The window is counted in whole days; `Date.UTC` cannot honour a fraction of one. */
export const BANK_MATCH_DAYS_STEP = 1;

/**
 * True when `value` is a whole number of days at or above `BANK_MATCH_DAYS_MIN`.
 *
 * Blank is NOT in range, and that is the point of testing it here rather than trusting `type=
 * number`: `Number('')` is `0`, so an empty box that reached the save path would silently store
 * the narrowest window there is as though the owner had asked for it.
 */
export function isBankMatchWindowInRange(value: number): boolean {
  return Number.isInteger(value) && value >= BANK_MATCH_DAYS_MIN;
}

/**
 * True when `value` is a real number no larger than `QUANTITY_MAX` in magnitude.
 * `abs` because an inventory adjustment is signed — `0026:203` bounds `abs(v_delta)`, and a
 * delta of minus ten million is the same fat finger as a delta of plus ten million.
 */
export function isQuantityInRange(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= QUANTITY_MAX;
}
