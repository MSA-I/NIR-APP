import { describe, expect, it } from 'vitest';
import { formatSupplierBankAccount } from './financialSuppliers';
import { translateIn } from './i18n/LocaleProvider';
import type { TKey } from './i18n/t';

/**
 * A HEBREW translator is injected rather than the assertions being loosened, which is the
 * `model.spec`/`monthlyReport.spec` precedent: comparing `t(key)` against `t(key)` would pass
 * whether or not the dictionary says anything at all. The exact sentence stays pinned.
 */
const t = (key: TKey, vars?: Record<string, string | number>) => translateIn('he', key, vars);

describe('formatSupplierBankAccount', () => {
  it('formats full Israel details only for an explicitly fetched structured account', () => {
    expect(formatSupplierBankAccount({
      supplier_id: 'supplier-1', account_holder: 'ספק בדיקה בעמ', country_code: 'IL',
      bank_code: '12', branch_code: '345', account_number: '123456', iban: null, bic: null,
    }, t)).toBe('ספק בדיקה בעמ · בנק 12 · סניף 345 · חשבון 123456');
  });

  it('formats international details without inventing an optional BIC', () => {
    expect(formatSupplierBankAccount({
      supplier_id: 'supplier-2', account_holder: 'Global GmbH', country_code: 'DE',
      bank_code: null, branch_code: null, account_number: null,
      iban: 'DE89370400440532013000', bic: null,
    }, t)).toBe('Global GmbH · IBAN DE89370400440532013000');
  });

  it('names the parts in English for an English reader, and keeps every number a fact', () => {
    const english = (key: TKey, vars?: Record<string, string | number>) => translateIn('en', key, vars);
    expect(formatSupplierBankAccount({
      supplier_id: 'supplier-1', account_holder: 'ספק בדיקה בעמ', country_code: 'IL',
      bank_code: '12', branch_code: '345', account_number: '123456', iban: null, bic: null,
    }, english)).toBe('ספק בדיקה בעמ · Bank 12 · Branch 345 · Account 123456');
  });

  it('leaves an absent code empty rather than printing the word null', () => {
    // The previous template interpolated `null` straight onto a payment screen, where it reads
    // as data rather than as a gap.
    expect(formatSupplierBankAccount({
      supplier_id: 'supplier-3', account_holder: 'ספק', country_code: 'IL',
      bank_code: null, branch_code: null, account_number: null, iban: null, bic: null,
    }, t)).not.toContain('null');
  });
});
