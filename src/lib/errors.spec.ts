/**
 * `toErrorKey` maps the messages this schema can actually raise onto dictionary keys, and the
 * cost of a miss is invisible: an unmapped code falls through to FALLBACK, which says "the action
 * failed — contact support". For a refusal the business can resolve itself, support is the wrong
 * destination — the reasoning `errors.ts` already carries at its currency block.
 *
 * The case pinned here is the one W0-G3 measured: `unmatch_bank_transaction` refuses a DIRECT bank
 * match with `bank_direct_match_requires_financial_correction`, deliberately, because undoing one
 * would delete a payment record. The refusal is correct. Reaching the user as "contact support"
 * was not.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toErrorKey } from './errors';
import { en } from './i18n/dictionaries/en';
import { he } from './i18n/dictionaries/he';

// `toErrorKey` logs the raw message on purpose — a developer needs it. The test does not.
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the direct bank match refusal', () => {
  it('maps to its own key, whichever shape the message arrives in', () => {
    for (const raw of [
      // The bare `raise ... using errcode = 'P0001'` message, which is what supabase-js hands
      // `ok()`/`unwrap()`, and the two wrapped shapes a rethrow or a driver prefix produces.
      'bank_direct_match_requires_financial_correction',
      'Error: bank_direct_match_requires_financial_correction',
      'bank_direct_match_requires_financial_correction (P0001)',
    ]) {
      expect(toErrorKey(new Error(raw))).toBe('bank_direct_match_requires_financial_correction');
      expect(toErrorKey(raw)).toBe('bank_direct_match_requires_financial_correction');
    }
  });

  it('is not the generic fallback, and not swallowed by a neighbouring bank pattern', () => {
    const key = toErrorKey(new Error('bank_direct_match_requires_financial_correction'));
    expect(key).not.toBe('fallback');
    expect(key).not.toBe('bank_transaction_already_matched');
    expect(key).not.toBe('bank_transaction_not_matchable');
    expect(key).not.toBe('bank_payment_invalid');
    expect(key).not.toBe('bank_match_currency_mismatch');
  });

  it('leaves the fallback intact for a code nobody mapped, so the assertions above mean something',
    () => {
      expect(toErrorKey(new Error('zzz_no_such_condition'))).toBe('fallback');
    });

  /**
   * The half the compiler cannot see.
   *
   * `resolveError` (LocaleProvider.tsx:119-122) looks the key up as `errors.${key}` through
   * `tryTranslate` and returns `dictionary.errors.fallback` when it misses. That lookup is
   * untyped — unlike `t('bank.directMatchCorrection')`, a missing `errors.*` entry is not a
   * compile error, it is the ORIGINAL DEFECT restored in silence. So the entry is asserted here
   * instead, in both languages, where a miss is loud.
   */
  it('resolves to its own sentence in both dictionaries, not to the fallback', () => {
    const key = toErrorKey(new Error('bank_direct_match_requires_financial_correction'));
    for (const dictionary of [he, en]) {
      const errors = dictionary.errors as unknown as Record<string, string | undefined>;
      expect(errors[key]).toBeTypeOf('string');
      expect(errors[key]).not.toBe(errors.fallback);
    }
  });
});
