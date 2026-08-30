import { describe, expect, it } from 'vitest';
import { currenciesWithTolerance, readTolerance, writeTolerance } from './tolerances';

/**
 * These tests exist because of a defect that shipped, not a defect that was imagined.
 *
 * `#288` made a tolerance per-currency in the database (0219). The settings screen kept saving
 * `bank_match_amount_tolerance: Number(field)` — a whole-key overwrite — so a business that had
 * stated a dollar tolerance lost it the next time anybody pressed "save" on a screen that never
 * mentions dollars. Nothing failed, nothing was logged, and the next dollar statement line was
 * refused by the server for a setting that had been there the day before.
 */
describe('readTolerance mirrors private.money_tolerance', () => {
  it('reads a per-currency map by code', () => {
    expect(readTolerance({ ILS: 1, USD: 0.3 }, 'USD')).toBe(0.3);
    expect(readTolerance({ ILS: 1, USD: 0.3 }, 'ILS')).toBe(1);
  });

  it('answers null for a currency the map does not mention', () => {
    // Not 0, and not the shekel figure. "Cannot compare" is the answer the server gives.
    expect(readTolerance({ ILS: 1 }, 'USD')).toBeNull();
  });

  it('reads the legacy bare number as the ILS value and as nothing else', () => {
    expect(readTolerance(1, 'ILS')).toBe(1);
    expect(readTolerance(1, 'USD')).toBeNull();
    // 0219 hard-codes ILS for the scalar shape. A base currency of USD does not change that, and a
    // client that "improved" on the rule would display a number the server will not honour.
    expect(readTolerance(1, 'EUR')).toBeNull();
  });

  it('answers null when nothing was ever stored', () => {
    expect(readTolerance(undefined, 'ILS')).toBeNull();
    expect(readTolerance(null, 'ILS')).toBeNull();
    expect(readTolerance({}, 'ILS')).toBeNull();
  });

  it('treats a zero tolerance as a stated value, because it is one', () => {
    // Zero says "nothing may differ at all". That is a decision, not an absence.
    expect(readTolerance({ USD: 0 }, 'USD')).toBe(0);
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
    expect(readTolerance(writeTolerance({ USD: 0.3 }, 'USD', null), 'USD')).toBeNull();
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
    expect(readTolerance(after, 'USD')).toBe(0.3);
  });

  it('is what the replaced code could not do', () => {
    // The old line was `bank_match_amount_tolerance: Number(field)`. Kept here as the measurement,
    // so the reason for this module is legible without reading history.
    const overwritten = Number('1.5');
    expect(readTolerance(overwritten, 'USD')).toBeNull();
  });
});

describe('currenciesWithTolerance orders by the base currency first', () => {
  it('puts the organisation currency first, then ISO ascending', () => {
    expect(currenciesWithTolerance({ USD: 0.3, EUR: 0.25, ILS: 1 }, 'ILS')).toEqual(['ILS', 'EUR', 'USD']);
  });

  it('falls back to plain alphabetical before the organisation row has loaded', () => {
    expect(currenciesWithTolerance({ USD: 0.3, EUR: 0.25 }, null)).toEqual(['EUR', 'USD']);
  });

  it('reports the legacy scalar as a stated ILS value', () => {
    expect(currenciesWithTolerance(1, 'ILS')).toEqual(['ILS']);
  });
});
