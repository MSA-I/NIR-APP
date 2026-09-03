/**
 * The payment-request refusals that reach the user as "the action failed — contact support".
 *
 * Wave 1 fixed this shape once, for `bank_direct_match_requires_financial_correction`
 * (`errors.spec.ts`). Wave 6 measured the same shape across the whole payment-request family:
 * every `raise exception '<code>'` in the LIVE bodies of `create_payment_request`,
 * `p1_transition_payment_request`, `execute_payment_request`,
 * `payment_request_financial_check_signals`, `transition_credit_request` and the
 * `guard_payable_invoice_reference` trigger was listed from `pg_get_functiondef`, then fed
 * through `toErrorKey`. Eight came back `fallback`.
 *
 * These are not hypothetical strings. Each is quoted from the live body, and each has a
 * browser-reachable caller:
 *
 * | code | live raiser | screen |
 * |---|---|---|
 * | `payment_request_currency_invalid` | `create_payment_request`, `p1_transition_payment_request` | PaymentRequests.tsx:370, :107/:739 |
 * | `payment_execution_currency_invalid` | `execute_payment_request` | AccountantPaymentQueue.tsx:448 |
 * | `payment_settlement_pair_invalid` | `execute_payment_request` | AccountantPaymentQueue.tsx:448 |
 * | `payment_settlement_invalid` | `execute_payment_request` | AccountantPaymentQueue.tsx:448 |
 * | `payment_request_checks_invalid` | `payment_request_financial_check_signals` | checks.ts:220 |
 * | `payment_request_checks_currency_mismatch` | `payment_request_financial_check_signals` | checks.ts:220 |
 * | `credit_request_concurrent_change` | `transition_credit_request` | Credits.tsx:140 |
 * | `invoice_not_payable` | `guard_payable_invoice_reference` (trigger) | every allocation write |
 *
 * The dictionary half is asserted against `artifacts/w6/i18n/w6.json` rather than against
 * `he.ts`/`en.ts`: Wave 6 does not own those two files, and a key that exists in the code but
 * not in the pending dictionary would restore the original defect in silence at merge time.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { toErrorKey } from './errors';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

/** code as the server raises it → the dictionary key it must resolve to. */
const REFUSALS: [string, string][] = [
  ['payment_request_currency_invalid', 'payment_request_currency_invalid'],
  ['payment_execution_currency_invalid', 'payment_execution_currency_invalid'],
  ['payment_settlement_pair_invalid', 'payment_settlement_pair_invalid'],
  ['payment_settlement_invalid', 'payment_settlement_invalid'],
  ['payment_request_checks_invalid', 'payment_request_checks_invalid'],
  ['payment_request_checks_currency_mismatch', 'payment_request_checks_currency_mismatch'],
  ['credit_request_concurrent_change', 'credit_request_concurrent_change'],
  ['invoice_not_payable', 'invoice_not_payable'],
];

describe('the payment-request family of refusals', () => {
  it.each(REFUSALS)('%s does not fall through to the generic fallback', (raw, key) => {
    expect(toErrorKey(new Error(raw))).toBe(key);
    expect(toErrorKey(raw)).toBe(key);
  });

  it.each(REFUSALS)('%s survives the shapes a driver or a rethrow produces', (raw, key) => {
    for (const shape of [`Error: ${raw}`, `${raw} (22023)`, `  ${raw}\n`]) {
      expect(toErrorKey(new Error(shape))).toBe(key);
    }
  });

  /**
   * Order matters and the list is scanned top to bottom, so each new pattern is asserted NOT to
   * have been swallowed by, and NOT to have swallowed, its nearest existing neighbour.
   */
  it('does not collide with the patterns that were already there', () => {
    expect(toErrorKey(new Error('payment_request_currency_mixed')))
      .toBe('payment_request_currency_mixed');
    expect(toErrorKey(new Error('payment_request_checks_mismatch')))
      .toBe('payment_request_checks_mismatch');
    expect(toErrorKey(new Error('payment_request_checks_failed')))
      .toBe('payment_request_checks_failed');
    expect(toErrorKey(new Error('payment_request_invalid')))
      .toBe('payment_request_supplier_invalid');
    expect(toErrorKey(new Error('payment_execution_conflict')))
      .toBe('payment_execution_conflict');
    expect(toErrorKey(new Error('payment_execution_fields_required')))
      .toBe('payment_execution_fields_required');
    expect(toErrorKey(new Error('credit_request_transition_invalid')))
      .toBe('credit_request_transition_invalid');
    expect(toErrorKey(new Error('credit_request_not_fully_allocated')))
      .toBe('credit_request_not_fully_allocated');
    expect(toErrorKey(new Error('invoice_not_found'))).toBe('invoice_not_found');
  });

  it('still returns the fallback for a code nobody mapped', () => {
    expect(toErrorKey(new Error('zzz_no_such_condition'))).toBe('fallback');
  });

  /**
   * Every key the code now produces has a Hebrew AND an English sentence waiting for it, and
   * neither is the fallback sentence. Wave 6 writes them to `artifacts/w6/i18n/w6.json`; the
   * dictionary owner merges that file.
   */
  it('has a pending Hebrew and English sentence for every new key', () => {
    // Resolved from the repo root: under Vitest `import.meta.url` is the dev server's URL,
    // not a file URL, so `fileURLToPath` throws on it.
    const path = 'artifacts/w6/i18n/w6.json';
    const pending = JSON.parse(readFileSync(path, 'utf8')) as
      Record<string, { he: string; en: string }>;
    for (const [, key] of REFUSALS) {
      const entry = pending[`errors.${key}`];
      expect(entry, `errors.${key} missing from artifacts/w6/i18n/w6.json`).toBeTruthy();
      expect(entry.he.length).toBeGreaterThan(20);
      expect(entry.en.length).toBeGreaterThan(20);
    }
  });
});
