/**
 * parsePrice — the one reading of a price cell, on the client side of the same rule the database
 * enforces in `private.parse_price`.
 *
 * WHY THIS FILE EXISTS. The upload dialog previews a spreadsheet before importing it, and the
 * preview used to mirror the writer's rules by hand: `cellNumber` stripped `₪`, commas and spaces
 * and then deleted every remaining character that was not a digit, a dot or a minus. The writer
 * did nothing of the kind — it stripped only whitespace, `₪` and commas, then demanded
 * `^[0-9]+([.][0-9]{1,4})?$`. So the two disagreed in both directions and the disagreement was
 * silent:
 *
 *   `$12.50`      preview: accepted as 12.50      writer: rejected as "invalid price"
 *   `12.50 USD`   preview: accepted as 12.50      writer: rejected as "invalid price"
 *   `-5`          preview: rejected as "missing name or valid price"   (the sign was the cause,
 *                                                                       and the message hid it)
 *   `1.2345`      preview: shown as 1.2345        writer: stored 1.23, silently
 *
 * And one more, which is the reason the whole wave exists: the preview labelled every row with
 * the SUPPLIER's currency (`fmtMoneyExact(r.price, supplierCurrency)`) while the writer named no
 * currency column at all, so the row landed as ILS. A dollar list previewed in dollars and was
 * stored in shekels.
 *
 * THE CONTRACT, IDENTICAL ON BOTH SIDES:
 *   - a currency other than the list's is REFUSED, never converted and never relabelled;
 *   - the sign is preserved, so `-5` comes back as `-5` with `price_not_positive`;
 *   - a comma is a thousands separator only when it groups in threes, so `1,5` is refused rather
 *     than read as 15;
 *   - the value is rounded to the currency's own minor units, and says so when rounding changed it.
 *
 * `price.spec.ts` runs the same table of cases this module's SQL twin asserts in its postflight,
 * so the two cannot drift apart without one of them going red.
 */
import { currencyMinorUnits } from './format';

export type PriceRejectionReason =
  | 'price_missing'
  | 'price_unreadable'
  | 'price_not_positive'
  | 'price_below_minor_unit'
  | 'price_above_cap'
  | 'price_currency_mismatch'
  | 'price_currency_unknown';

export interface ParsedPrice {
  ok: boolean;
  /** The signed value that was read, or null when nothing could be read at all. */
  value: number | null;
  reason: PriceRejectionReason | null;
  /** The currency this list is in — what the row will be stored as. */
  currency: string | null;
  /** The currency the CELL named, when it named one. Null when the cell carried no marker. */
  printedCurrency: string | null;
  minorUnits: number | null;
  /** True when rounding to `minorUnits` changed the value the cell actually stated. */
  rounded: boolean;
}

/** A ceiling on the SIZE OF THE NUMBER, carrying no currency — the same bare cap the writer uses. */
const MAX_PRICE = 1_000_000;

const SYMBOL_TO_CODE: Record<string, string> = {
  '₪': 'ILS', ILS: 'ILS', NIS: 'ILS', 'ש"ח': 'ILS', 'ש״ח': 'ILS', שח: 'ILS', 'ש.ח': 'ILS',
  שקל: 'ILS', שקלים: 'ILS',
  $: 'USD', דולר: 'USD',
  '€': 'EUR', אירו: 'EUR', יורו: 'EUR',
  '£': 'GBP',
};

const MARKER = /₪|\$|€|£|¥|ש"ח|ש״ח|ש\.ח|שח|[\p{L}]+/u;

/**
 * Round a clean decimal STRING to `places`, the way `numeric` does — half away from zero, on the
 * digits, without ever multiplying by a power of ten.
 *
 * WHY THIS EXISTS (finding 8 of the 03.09.2026 review, and it is the second half of the defect
 * this whole file was written to close). The obvious `Math.round(value * 10 ** places) / 10 **
 * places` disagrees with Postgres, because the multiplication happens in binary floating point
 * and lands just under the halfway mark:
 *
 *   1.005 * 100 = 100.49999999999999  ->  JS 1.00   ·  round(1.005, 2) = 1.01
 *   1.015 * 100 = 101.49999999999999  ->  JS 1.01   ·  round(1.015, 2) = 1.02
 *   0.145 * 100 =  14.499999999999998 ->  JS 0.14   ·  round(0.145, 2) = 0.15
 *
 * So the preview showed one price and the writer stored another — preview/write divergence,
 * exactly what `0298` exists to end, reintroduced by the arithmetic rather than by the rules.
 *
 * The caller has already proved `digits` matches `^[0-9]+([.][0-9]+)?$`, so there is no sign, no
 * exponent and no separator left to handle here; the sign is reapplied by the caller.
 */
function roundDecimalDigits(digits: string, places: number): number {
  const point = digits.indexOf('.');
  const whole = point === -1 ? digits : digits.slice(0, point);
  const fraction = point === -1 ? '' : digits.slice(point + 1);
  if (fraction.length <= places) return Number(digits);

  const kept = `${whole}${fraction.slice(0, places)}`;
  // Half away from zero. The magnitude is unsigned here, so "away from zero" is "up".
  const carry = fraction.charCodeAt(places) >= 53; /* '5' */
  const shifted = carry ? (BigInt(kept) + 1n).toString().padStart(kept.length, '0') : kept;
  if (places === 0) return Number(shifted);
  const padded = shifted.padStart(places + 1, '0');
  return Number(`${padded.slice(0, -places)}.${padded.slice(-places)}`);
}

function reject(
  reason: PriceRejectionReason,
  currency: string | null,
  printedCurrency: string | null,
  minorUnits: number | null,
  value: number | null = null,
): ParsedPrice {
  return { ok: false, value, reason, currency, printedCurrency, minorUnits, rounded: false };
}

/**
 * WHY THE CALLER PASSES THE CURRENCY LIST, AND WHAT HAPPENS WHEN IT DOES NOT.
 *
 * `currencyMinorUnits` asks `Intl.NumberFormat`, and `Intl` accepts ANY well-formed three-letter
 * code: `KGM` and `ZZZ` both come back as two-decimal currencies. The database asks
 * `public.currencies`, which holds 157 real, active codes. Without the list the client would call
 * a unit-of-measure abbreviation a currency and refuse the row as a currency mismatch — a message
 * naming the wrong cause, which is the defect this wave is closing, not one to introduce.
 *
 * So: pass `knownCurrencies` (the `currencies` table, which every authenticated user may read) and
 * the client resolves exactly as the database does. Omit it and the parser recognises only the
 * expected currency's own code and the printed symbols, and calls every other word UNREADABLE —
 * conservative, never a guess, and never a foreign-currency claim it cannot support.
 */
export function parsePrice(
  text: string | null | undefined,
  expectedCurrency: string | null | undefined,
  knownCurrencies?: ReadonlySet<string> | null,
): ParsedPrice {
  const expected = (expectedCurrency ?? '').trim().toUpperCase() || null;
  const known = (code: string) => (knownCurrencies ? knownCurrencies.has(code) : code === expected);
  const minorUnits = expected && (!knownCurrencies || knownCurrencies.has(expected))
    ? currencyMinorUnits(expected)
    : null;
  if (expected === null || minorUnits === null) {
    // Nobody could say which currency this list is in. Reading the number anyway would produce a
    // number with no unit, which is the failure this whole wave exists to end.
    return reject('price_currency_unknown', expected, null, null);
  }

  const raw = (text ?? '').trim();
  if (!raw) return reject('price_missing', expected, null, minorUnits);
  if (raw.length > 64) return reject('price_unreadable', expected, null, minorUnits);

  // Invisible bidirectional marks travel inside Hebrew price cells and are not part of the number.
  let body = raw.replace(/[‎‏؜]/g, '');
  body = body.replace(/[    ]/g, ' ').replace(/\s+/g, ' ').trim();

  // Currency markers, one at a time. Each is either recognised and removed, or it is a word this
  // parser will not guess at and the cell is unreadable. Nothing is stripped without being
  // understood first — that is exactly what `[^0-9.]` got wrong.
  let printed: string | null = null;
  for (;;) {
    const found = MARKER.exec(body);
    if (!found) break;
    const token = found[0];
    const upper = token.toUpperCase();
    let code: string | null = SYMBOL_TO_CODE[token] ?? SYMBOL_TO_CODE[upper] ?? null;
    if (code === null && /^[A-Z]{3}$/.test(upper) && known(upper)) code = upper;
    if (code === null) return reject('price_unreadable', expected, printed, minorUnits);
    // A CURRENCY MARKER BELONGS AT ONE END OF THE CELL, NEVER BETWEEN TWO DIGITS. Removing the
    // marker leaves a space, and the spaces are deleted a few lines below, so `1 USD 2` and
    // `1USD2` were both read as the number TWELVE — a wrong price that looked like a clean parse.
    // A cell with digits on both sides of a marker is not one price, and this parser says so
    // instead of joining them.
    if (/[0-9]/.test(body.slice(0, found.index)) && /[0-9]/.test(body.slice(found.index + token.length))) {
      return reject('price_unreadable', expected, printed, minorUnits);
    }
    if (printed === null) printed = code;
    else if (printed !== code) return reject('price_currency_mismatch', expected, printed, minorUnits);
    body = `${body.slice(0, found.index)} ${body.slice(found.index + token.length)}`
      .replace(/\s+/g, ' ').trim();
  }

  if (printed !== null && printed !== expected) {
    // REFUSED, NEVER COERCED. There is no conversion and no rate source anywhere in this system.
    return reject('price_currency_mismatch', expected, printed, minorUnits);
  }

  let negative = false;
  if (/^\(.*\)$/.test(body)) {
    negative = true;
    body = body.slice(1, -1).trim();
  }
  body = body.replace(/−/g, '-');
  if (/^[+-]/.test(body)) {
    negative = negative || body.startsWith('-');
    body = body.slice(1).trim();
  }
  body = body.replace(/ /g, '');

  // A comma groups thousands only when it groups in threes. Stripping every comma turned `1,5`
  // into 15 — a fifteenfold error that looked like a successful import.
  if (/^[0-9]{1,3}(,[0-9]{3})+([.][0-9]+)?$/.test(body)) body = body.replace(/,/g, '');
  if (!/^[0-9]+([.][0-9]+)?$/.test(body) || body.length > 20) {
    return reject('price_unreadable', expected, printed, minorUnits);
  }

  const magnitude = Number(body);
  if (!Number.isFinite(magnitude)) return reject('price_unreadable', expected, printed, minorUnits);
  const value = negative ? -magnitude : magnitude;
  const roundedMagnitude = roundDecimalDigits(body, minorUnits);
  const roundedValue = negative ? -roundedMagnitude : roundedMagnitude;

  // The signed value travels back with every refusal below: a reader can see it was minus five,
  // not a five that failed some unnamed test.
  if (value <= 0) return reject('price_not_positive', expected, printed, minorUnits, value);
  if (roundedValue <= 0) return reject('price_below_minor_unit', expected, printed, minorUnits, value);
  if (roundedValue > MAX_PRICE) return reject('price_above_cap', expected, printed, minorUnits, value);

  return {
    ok: true,
    value: roundedValue,
    reason: null,
    currency: expected,
    printedCurrency: printed,
    minorUnits,
    rounded: roundedValue !== value,
  };
}

/**
 * The i18n key that names the actual cause. The keys themselves live in
 * `artifacts/w2/i18n/w2.json` until they are merged into the dictionaries.
 */
export const PRICE_REASON_KEYS: Record<PriceRejectionReason, string> = {
  price_missing: 'priceUpload.reason_price_missing',
  price_unreadable: 'priceUpload.reason_price_unreadable',
  price_not_positive: 'priceUpload.reason_price_not_positive',
  price_below_minor_unit: 'priceUpload.reason_price_below_minor_unit',
  price_above_cap: 'priceUpload.reason_price_above_cap',
  price_currency_mismatch: 'priceUpload.reason_price_currency_mismatch',
  price_currency_unknown: 'priceUpload.reason_price_currency_unknown',
};
