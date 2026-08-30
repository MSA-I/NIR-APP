import { describe, expect, it } from 'vitest';
import {
  currenciesWithStatedTolerance, derivedTolerance, effectiveTolerance, storedTolerance, writeTolerance,
} from './tolerances';

/**
 * These tests exist because of a defect that shipped, not a defect that was imagined.
 *
 * `#288` made a tolerance per-currency in the database (0219). The settings screen kept saving
 * `bank_match_amount_tolerance: Number(field)` — a whole-key overwrite — so a business that had
 * stated a dollar tolerance lost it the next time anybody pressed "save" on a screen that never
 * mentions dollars. Nothing failed, nothing was logged, and the next dollar statement line was
 * refused by the server for a setting that had been there the day before.
 */
describe('storedTolerance reports only what the organisation said', () => {
  it('reads a per-currency map by code', () => {
    expect(storedTolerance({ ILS: 1, USD: 0.3 }, 'USD')).toBe(0.3);
    expect(storedTolerance({ ILS: 1, USD: 0.3 }, 'ILS')).toBe(1);
  });

  it('answers null for a currency the map does not mention', () => {
    // Not 0, and not the shekel figure. "Cannot compare" is the answer the server gives.
    expect(storedTolerance({ ILS: 1 }, 'USD')).toBeNull();
  });

  it('reads the legacy bare number as the ILS value and as nothing else', () => {
    expect(storedTolerance(1, 'ILS')).toBe(1);
    expect(storedTolerance(1, 'USD')).toBeNull();
    // 0219 hard-codes ILS for the scalar shape. A base currency of USD does not change that, and a
    // client that "improved" on the rule would display a number the server will not honour.
    expect(storedTolerance(1, 'EUR')).toBeNull();
  });

  it('answers null when nothing was ever stored', () => {
    expect(storedTolerance(undefined, 'ILS')).toBeNull();
    expect(storedTolerance(null, 'ILS')).toBeNull();
    expect(storedTolerance({}, 'ILS')).toBeNull();
  });

  it('treats a zero tolerance as a stated value, because it is one', () => {
    // Zero says "nothing may differ at all". That is a decision, not an absence.
    expect(storedTolerance({ USD: 0 }, 'USD')).toBe(0);
  });
});

describe('writeTolerance changes one currency and leaves the rest alone', () => {
  it('keeps every other currency when one is edited — the defect this module exists for', () => {
    const stored = { ILS: 1, USD: 0.3, EUR: 0.25 };
    expect(writeTolerance(stored, 'ILS', 2)).toEqual({ ILS: 2, USD: 0.3, EUR: 0.25 });
  });

  it('does not mutate the object it was handed', () => {
    const stored = { ILS: 1, USD: 0.3 };
    writeTolerance(stored, 'USD', 0.5);
    expect(stored).toEqual({ ILS: 1, USD: 0.3 });
  });

  it('promotes the legacy scalar to a map without losing the shekel figure', () => {
    expect(writeTolerance(1, 'USD', 0.3)).toEqual({ ILS: 1, USD: 0.3 });
  });

  it('leaves a shekel-only business on the scalar shape', () => {
    // No diff on a financial settings row that nobody asked to change shape.
    expect(writeTolerance(1, 'ILS', 2)).toBe(2);
  });

  it('clears a currency back to "never stated", which is not zero', () => {
    expect(writeTolerance({ ILS: 1, USD: 0.3 }, 'USD', null)).toEqual({ ILS: 1 });
    expect(storedTolerance(writeTolerance({ USD: 0.3 }, 'USD', null), 'USD')).toBeNull();
  });

  it('returns undefined rather than an empty map when the last value is cleared', () => {
    expect(writeTolerance({ USD: 0.3 }, 'USD', null)).toBeUndefined();
  });

  it('refuses a value that is not a finite number', () => {
    expect(writeTolerance({ ILS: 1 }, 'USD', Number.NaN)).toEqual({ ILS: 1 });
  });
});

describe('the settings save path', () => {
  it('preserves a dollar tolerance across a save from the shekel-only screen', () => {
    // The exact regression: the screen edits ILS, the business also trades in USD.
    const before = { ILS: 1, USD: 0.3 };
    const after = writeTolerance(before, 'ILS', 1.5);
    expect(storedTolerance(after, 'USD')).toBe(0.3);
  });

  it('is what the replaced code could not do', () => {
    // The old line was `bank_match_amount_tolerance: Number(field)`. Kept here as the measurement,
    // so the reason for this module is legible without reading history.
    const overwritten = Number('1.5');
    expect(storedTolerance(overwritten, 'USD')).toBeNull();
  });
});

/**
 * `#294`: every currency answers from its own units, so a business abroad needs no setup at all.
 *
 * The numbers below are not new. `1` and `0.05` were always "a hundred minor units" and "five" —
 * the shekel has two decimals, so that is what they came out as. Reading the rule instead of the
 * instance is what lets a dollar, a yen and a dinar each get a sensible threshold with no exchange
 * rate anywhere near the calculation.
 */
describe('derivedTolerance reads the currency, never another currency', () => {
  it('gives the shekel exactly what 0227 hard-coded for it', () => {
    expect(derivedTolerance('invoice_line_amount_tolerance', 'ILS')).toBe(0.05);
    expect(derivedTolerance('invoice_document_amount_tolerance', 'ILS')).toBe(1);
    expect(derivedTolerance('bank_match_amount_tolerance', 'ILS')).toBe(1);
    expect(derivedTolerance('payment_request_amount_tolerance', 'ILS')).toBe(1);
  });

  it('gives a two-decimal currency the same figures, in its own money', () => {
    // 1.00 dollars is a hundred CENTS. It is not one shekel converted, and no rate was consulted.
    expect(derivedTolerance('bank_match_amount_tolerance', 'USD')).toBe(1);
    expect(derivedTolerance('invoice_line_amount_tolerance', 'EUR')).toBe(0.05);
  });

  it('scales to a currency with no minor unit at all', () => {
    // A yen tolerance of 1 would be roughly half a New Israeli agora — absurdly tight. A hundred
    // minor units of a currency whose minor unit IS the yen is 100.
    expect(derivedTolerance('invoice_document_amount_tolerance', 'JPY')).toBe(100);
    expect(derivedTolerance('invoice_line_amount_tolerance', 'JPY')).toBe(5);
  });

  it('scales to a currency with three decimals', () => {
    expect(derivedTolerance('invoice_document_amount_tolerance', 'KWD')).toBe(0.1);
    expect(derivedTolerance('invoice_line_amount_tolerance', 'KWD')).toBe(0.005);
  });

  it('answers null for something that is not shaped like a currency', () => {
    expect(derivedTolerance('bank_match_amount_tolerance', 'shekel')).toBeNull();
    expect(derivedTolerance('bank_match_amount_tolerance', null)).toBeNull();
  });

  /* WHERE THE CLIENT'S KNOWLEDGE ENDS, stated rather than discovered later. The browser derives
     minor units from `Intl`, which answers two decimals for any well-formed three-letter code —
     including one this database has never heard of. The server reads the `currencies` table and
     answers null for exactly those. The divergence cannot be reached through normal data (every
     currency column carries a foreign key into that table) and matters only for a code the owner
     has DEACTIVATED, where the screen may offer a comparison the server then refuses with a
     sentence that says so. The settings panel does not rely on this: it filters against the live
     catalogue it fetches, which is authoritative. */
  it('cannot tell that a well-formed code is unknown to the database', () => {
    expect(derivedTolerance('bank_match_amount_tolerance', 'ZZZ')).toBe(1);
  });
});

describe('effectiveTolerance prefers what the owner said', () => {
  it('uses the stated value when there is one', () => {
    expect(effectiveTolerance({ USD: 7 }, 'USD', 'bank_match_amount_tolerance')).toBe(7);
  });

  it('falls back to the currency\'s own threshold when there is not', () => {
    // The case that used to stop the bank screen dead until somebody typed a number.
    expect(effectiveTolerance(undefined, 'USD', 'bank_match_amount_tolerance')).toBe(1);
    expect(effectiveTolerance({ ILS: 1 }, 'USD', 'invoice_line_amount_tolerance')).toBe(0.05);
  });

  it('lets a stated zero win, because zero is a decision', () => {
    expect(effectiveTolerance({ USD: 0 }, 'USD', 'bank_match_amount_tolerance')).toBe(0);
  });

  it('still answers null when the code is not shaped like a currency', () => {
    expect(effectiveTolerance({ ILS: 1 }, 'shekel', 'bank_match_amount_tolerance')).toBeNull();
  });
});

describe('currenciesWithStatedTolerance orders by the base currency first', () => {
  it('puts the organisation currency first, then ISO ascending', () => {
    expect(currenciesWithStatedTolerance({ USD: 0.3, EUR: 0.25, ILS: 1 }, 'ILS')).toEqual(['ILS', 'EUR', 'USD']);
  });

  it('falls back to plain alphabetical before the organisation row has loaded', () => {
    expect(currenciesWithStatedTolerance({ USD: 0.3, EUR: 0.25 }, null)).toEqual(['EUR', 'USD']);
  });

  it('reports the legacy scalar as a stated ILS value', () => {
    expect(currenciesWithStatedTolerance(1, 'ILS')).toEqual(['ILS']);
  });
});
