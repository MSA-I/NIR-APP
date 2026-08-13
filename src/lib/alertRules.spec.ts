import { describe, expect, it } from 'vitest';
import { countAboveAverage, countDuplicateKeys } from './alertRules';

describe('alert counting rules', () => {
  it('counts duplicate supplier/invoice keys rather than duplicate rows', () => {
    expect(countDuplicateKeys([])).toBe(0);
    expect(countDuplicateKeys([
      { supplier_id: 'a', invoice_number: '1' },
      { supplier_id: 'a', invoice_number: '2' },
    ])).toBe(0);
    expect(countDuplicateKeys([
      { supplier_id: 'a', invoice_number: '1' },
      { supplier_id: 'b', invoice_number: '1' },
    ])).toBe(0);
    expect(countDuplicateKeys([
      { supplier_id: 'a', invoice_number: '1' },
      { supplier_id: 'a', invoice_number: '1' },
      { supplier_id: 'a', invoice_number: '1' },
    ])).toBe(1);
    expect(countDuplicateKeys([
      { supplier_id: 'a', invoice_number: '1' },
      { supplier_id: 'a', invoice_number: '1' },
      { supplier_id: 'b', invoice_number: '9' },
      { supplier_id: 'b', invoice_number: '9' },
    ])).toBe(2);
  });

  it('suppresses single-supplier and within-margin price observations', () => {
    expect(countAboveAverage([], 0.15)).toBe(0);
    expect(countAboveAverage([{ product_id: 'p', current_price: 100 }], 0.15)).toBe(0);
    expect(countAboveAverage([
      { product_id: 'p', current_price: 90 },
      { product_id: 'p', current_price: 110 },
    ], 0.15)).toBe(0);
    expect(countAboveAverage([
      { product_id: 'p', current_price: 0 },
      { product_id: 'p', current_price: 0 },
    ], 0.15)).toBe(0);
  });

  it('evaluates products independently above the configured margin', () => {
    expect(countAboveAverage([
      { product_id: 'p', current_price: 100 },
      { product_id: 'p', current_price: 200 },
      { product_id: 'p', current_price: 0 },
      { product_id: 'q', current_price: 50 },
      { product_id: 'q', current_price: 500 },
    ], 0.15)).toBe(2);
  });
});
