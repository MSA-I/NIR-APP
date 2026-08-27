import { he } from './i18n/dictionaries/he';
import { describe, expect, it } from 'vitest';
import { canStartSupplierCommerce, NEW_COMMERCE_SUPPLIER_STATUSES, PAYMENT_REQUEST_STATUS } from './status';

describe('supplier commerce status', () => {
  it('allows only active and problematic suppliers to start new commerce', () => {
    expect(NEW_COMMERCE_SUPPLIER_STATUSES).toEqual(['active', 'problematic']);
    expect(canStartSupplierCommerce('active')).toBe(true);
    expect(canStartSupplierCommerce('problematic')).toBe(true);
    expect(canStartSupplierCommerce('inactive')).toBe(false);
    expect(canStartSupplierCommerce('pending')).toBe(false);
  });

  it('describes an executed payment request as a completed transfer', () => {
    expect(he.status[PAYMENT_REQUEST_STATUS.executed.key]).toBe('העברה בוצעה');
  });
});
