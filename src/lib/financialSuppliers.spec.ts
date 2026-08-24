import { describe, expect, it } from 'vitest';
import { formatSupplierBankAccount } from './financialSuppliers';

describe('formatSupplierBankAccount', () => {
  it('formats full Israel details only for an explicitly fetched structured account', () => {
    expect(formatSupplierBankAccount({
      supplier_id: 'supplier-1', account_holder: 'ספק בדיקה בעמ', country_code: 'IL',
      bank_code: '12', branch_code: '345', account_number: '123456', iban: null, bic: null,
    })).toBe('ספק בדיקה בעמ · בנק 12 · סניף 345 · חשבון 123456');
  });

  it('formats international details without inventing an optional BIC', () => {
    expect(formatSupplierBankAccount({
      supplier_id: 'supplier-2', account_holder: 'Global GmbH', country_code: 'DE',
      bank_code: null, branch_code: null, account_number: null,
      iban: 'DE89370400440532013000', bic: null,
    })).toBe('Global GmbH · IBAN DE89370400440532013000');
  });
});
