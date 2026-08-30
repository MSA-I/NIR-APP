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
 * These mirror `private.money_tolerance` EXACTLY, including the part that looks like a bug and is
 * not: the legacy scalar answers for `ILS` and no other code, even in a business whose base
 * currency is something else. The server decides; a client that "improves" on the rule would show
 * a number the server will not honour.
 *
 * THREE QUESTIONS, THREE FUNCTIONS, and confusing them is how the screen came to lie:
 *
 *   storedTolerance     what did this organisation actually say? Empty is a real answer, and it
 *                       is what belongs in a settings input box.
 *   derivedTolerance    what is this currency worth checking to, from its own units? (`#294`)
 *   effectiveTolerance  what is actually in force — the first, or else the second.
 *
 * `#294` (owner, 30.08.2026) replaced the half of `#288` that made a non-shekel currency unusable
 * until somebody typed a number. The reason it could be replaced: the shekel's `1` and `0.05` were
 * never shekel figures. They are a hundred minor units and five, and that rule reads in any
 * currency. **Nothing here is a conversion** — a dollar threshold of 1.00 is a hundred cents, not
 * "one shekel in dollars" — so `#287` and `#290` are untouched: no rate, no amount computed from
 * another currency, no external source.
 *
 * NULL SURVIVES, for a currency this platform cannot describe, and still means "cannot compare"
 * rather than some number.
 */

import { currencyMinorUnits } from './format';

/** The two shapes `organizations.settings[<key>]` is allowed to hold. */
export type ToleranceSetting = number | Record<string, number>;

/** The one currency the legacy scalar shape answers for. Mirrors 0219; do not widen it here. */
const LEGACY_SCALAR_CURRENCY = 'ILS';

/** The key whose threshold is small change rather than an ordinary unit. */
const LINE_KEY = 'invoice_line_amount_tolerance';

/**
 * The currency's own threshold, in minor units. Mirrors `0245`; keep the two in step.
 *
 * `100` and `5` are not new numbers — they are what the shekel's `1` and `0.05` always were. The
 * shekel has two decimals, so a hundred agorot is 1.00 and five agorot is 0.05.
 */
const MINOR_UNITS_PER_TOLERANCE = { line: 5, ordinary: 100 } as const;

/**
 * What a currency is worth checking to, derived from ITS OWN units (`#294`).
 *
 * ILS 1.00 and 0.05 · USD 1.00 and 0.05 · JPY 100 and 5 · KWD 0.100 and 0.005.
 *
 * NOTHING HERE IS A CONVERSION. A dollar threshold of 1.00 is a hundred cents, not "one shekel in
 * dollars", and no amount is computed from another currency (`#287`, `#290`). A code this platform
 * cannot describe answers `null`, which keeps "cannot compare" reachable exactly as the server
 * keeps it for a currency it does not recognise.
 */
export function derivedTolerance(key: string, currency: string | null | undefined): number | null {
  if (!currency) return null;
  const minorUnits = currencyMinorUnits(currency);
  if (minorUnits == null) return null;
  const units = key === LINE_KEY ? MINOR_UNITS_PER_TOLERANCE.line : MINOR_UNITS_PER_TOLERANCE.ordinary;
  // Rounded to the currency's own scale so a three-decimal currency does not pick up float dust.
  return Number((units * 10 ** -minorUnits).toFixed(minorUnits));
}

/**
 * ONLY what this organisation actually stated, or `null`.
 *
 * This is what the settings screen puts in the input box: an empty field means "you have not
 * overridden anything", which is a different fact from "there is no threshold".
 */
export function storedTolerance(
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
 * The threshold actually in force: what the organisation said, or else the currency's own.
 *
 * Mirrors `private.money_tolerance` after `0245`. `null` still happens — for a currency this
 * platform cannot describe — and still means "cannot compare", never some number.
 */
export function effectiveTolerance(
  setting: ToleranceSetting | null | undefined,
  currency: string | null | undefined,
  key: string,
): number | null {
  return storedTolerance(setting, currency) ?? derivedTolerance(key, currency);
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
export function currenciesWithStatedTolerance(
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
