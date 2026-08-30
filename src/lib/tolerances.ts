/**
 * One place that knows how a money tolerance is stored, read and written.
 *
 * A tolerance is an amount, so it has a currency (`#288`). "Within 1" meant "within one shekel"
 * only because there was nothing else it could mean; in dollars the same number is a window
 * several times wider than anybody agreed to.
 *
 * THE STORED SHAPE IS TWO SHAPES, and both are correct:
 *
 *   number                     what every organisation wrote when the product was shekels only.
 *                              It answers for ILS and for nothing else.
 *   { ILS: 1, USD: 0.3, … }    the per-currency map (#288, #290).
 *
 * `readTolerance` mirrors `private.money_tolerance` (0219) EXACTLY, including the part that looks
 * like a bug and is not: the legacy scalar answers for `ILS` and no other code, even in a business
 * whose base currency is something else. The server decides; a client that "improves" on the rule
 * would show a number the server will not honour.
 *
 * NULL IS AN ANSWER, and it is the whole point. It means "this organisation has never stated a
 * tolerance for this currency", and it must never be replaced by a default — not 1, not 0, not one
 * derived from the currency's minor units. `#290` is explicit that the per-currency number is typed
 * by the owner and is NOT an exchange rate: nothing here converts, derives an amount from another
 * currency, or stores a ratio.
 */

/** The two shapes `organizations.settings[<key>]` is allowed to hold. */
export type ToleranceSetting = number | Record<string, number>;

/** The one currency the legacy scalar shape answers for. Mirrors 0219; do not widen it here. */
const LEGACY_SCALAR_CURRENCY = 'ILS';

/**
 * The configured tolerance for one currency, or `null` when none was ever stated.
 *
 * `null` means "cannot compare". Callers must say so rather than substituting a number.
 */
export function readTolerance(
  setting: ToleranceSetting | null | undefined,
  currency: string | null | undefined,
): number | null {
  if (setting == null || !currency) return null;
  if (typeof setting === 'number') {
    return currency === LEGACY_SCALAR_CURRENCY && Number.isFinite(setting) ? setting : null;
  }
  const value = setting[currency];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * One currency's value changed, every other currency's left exactly as it was.
 *
 * THIS FUNCTION IS THE REASON PHASE 1 EXISTS. The settings screen used to save
 * `bank_match_amount_tolerance: Number(field)` — a whole-key overwrite — so one press of "save"
 * on a screen that only knows about shekels would delete every other currency's tolerance and
 * leave no trace that it had.
 *
 * Passing `null` as the value clears that currency: it returns to "never stated", which is a
 * different fact from a tolerance of zero. Zero is a claim — that nothing may differ at all.
 */
export function writeTolerance(
  setting: ToleranceSetting | null | undefined,
  currency: string,
  value: number | null,
): ToleranceSetting | undefined {
  // The legacy scalar is promoted to a map the moment a second currency needs a value, so the
  // shekel figure the business already relies on survives the promotion rather than being dropped.
  const map: Record<string, number> = typeof setting === 'number'
    ? (Number.isFinite(setting) ? { [LEGACY_SCALAR_CURRENCY]: setting } : {})
    : { ...(setting ?? {}) };

  if (value == null || !Number.isFinite(value)) delete map[currency];
  else map[currency] = value;

  // An empty map and an absent key are the same fact; storing `{}` would be a shape with nothing
  // in it, and the next reader would have to know that means the same as nothing.
  if (Object.keys(map).length === 0) return undefined;

  // A map that says only what the scalar said stays a scalar. Nothing is gained by rewriting the
  // stored shape of an organisation that has not left shekels, and a diff nobody asked for on a
  // financial settings row is a diff somebody has to explain later.
  const codes = Object.keys(map);
  if (typeof setting === 'number' && codes.length === 1 && codes[0] === LEGACY_SCALAR_CURRENCY) {
    return map[LEGACY_SCALAR_CURRENCY];
  }
  return map;
}

/** Every currency this setting states a value for, base currency first, then ISO ascending. */
export function currenciesWithTolerance(
  setting: ToleranceSetting | null | undefined,
  baseCurrency: string | null | undefined,
): string[] {
  const codes = setting == null ? []
    : typeof setting === 'number' ? (Number.isFinite(setting) ? [LEGACY_SCALAR_CURRENCY] : [])
    : Object.keys(setting).filter((code) => Number.isFinite(setting[code]));

  return codes.sort((a, b) => {
    if (a === b) return 0;
    if (baseCurrency) {
      if (a === baseCurrency) return -1;
      if (b === baseCurrency) return 1;
    }
    return a < b ? -1 : 1;
  });
}
