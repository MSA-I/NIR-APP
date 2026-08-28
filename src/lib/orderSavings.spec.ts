import { describe, expect, it } from 'vitest';
import { calculateOrderSavings, type SavingsLine } from './orderSavings';

const basket: SavingsLine[] = [
  { productId: 'a', qty: 2, chosenSupplierId: 's1', offers: [{ supplierId: 's1', unitPrice: 10, currency: 'ILS', minQty: null }, { supplierId: 's2', unitPrice: 12, currency: 'ILS', minQty: null }] },
  { productId: 'b', qty: 1, chosenSupplierId: 's2', offers: [{ supplierId: 's1', unitPrice: 20, currency: 'ILS', minQty: null }, { supplierId: 's2', unitPrice: 15, currency: 'ILS', minQty: null }] },
];

describe('order savings', () => {
  it('compares a split basket with the cheapest complete single supplier', () => {
    expect(calculateOrderSavings(basket, 'ILS')).toEqual({
      // The answer states the currency it is an answer IN — every figure below is that currency.
      currency: 'ILS',
      splitTotal: 35,
      singleSupplierTotal: 39,
      singleSupplierId: 's2',
      savings: 4,
      savingsPercent: 10.3,
      supplierCount: 2,
      allCheapest: true,
    });
    expect(calculateOrderSavings(
      basket.map((line, index) => ({ ...line, chosenSupplierId: index ? 's1' : 's2' })),
      'ILS',
    ).savings).toBe(-5);
  });

  it('uses quantities, money rounding and deterministic tie-breaking', () => {
    expect(calculateOrderSavings([
      { productId: 'quantity-saving', qty: 3, chosenSupplierId: 's2', offers: [{ supplierId: 's1', unitPrice: 10, currency: 'ILS', minQty: null }, { supplierId: 's2', unitPrice: 12, currency: 'ILS', minQty: null }] },
    ], 'ILS').savings).toBe(-6);
    expect(calculateOrderSavings([
      { productId: 'decimal', qty: 2.5, chosenSupplierId: 's1', offers: [{ supplierId: 's1', unitPrice: 4.03, currency: 'ILS', minQty: null }] },
    ], 'ILS').splitTotal).toBe(10.08);
    const tie = calculateOrderSavings([
      { productId: 'tie', qty: 1, chosenSupplierId: null, offers: [
        { supplierId: '00000000-0000-0000-0000-000000000002', unitPrice: 10, currency: 'ILS', minQty: null },
        { supplierId: '00000000-0000-0000-0000-000000000001', unitPrice: 10, currency: 'ILS', minQty: null },
      ] },
    ], 'ILS');
    expect(tie.singleSupplierId).toBe('00000000-0000-0000-0000-000000000001');
    expect(tie.allCheapest).toBe(true);
  });

  it('requires a complete usable offer set for a single-supplier baseline', () => {
    expect(calculateOrderSavings([
      { ...basket[0], offers: basket[0].offers.slice(0, 1) },
      { ...basket[1], offers: basket[1].offers.slice(1) },
    ], 'ILS').singleSupplierTotal).toBeNull();
    expect(calculateOrderSavings([
      { productId: 'min-a', qty: 2, chosenSupplierId: null, offers: [
        { supplierId: 's1', unitPrice: 10, currency: 'ILS', minQty: null },
        { supplierId: 's2', unitPrice: 5, currency: 'ILS', minQty: 10 },
      ] },
      { productId: 'min-b', qty: 2, chosenSupplierId: null, offers: [
        { supplierId: 's1', unitPrice: 10, currency: 'ILS', minQty: null },
        { supplierId: 's2', unitPrice: 5, currency: 'ILS', minQty: null },
      ] },
    ], 'ILS').singleSupplierId).toBe('s1');
  });

  /* OPEN-DECISIONS #277. "Cheaper" is a comparison, and a comparison between 10 of one currency
     and 8 of another is not a comparison at all — there is no rate in this product and no screen
     may invent one. So an offer outside the basket's currency is not a cheaper option and not a
     dearer one: it is not an option, and the basket is answered without it. */
  it('ignores an offer in another currency rather than ranking it', () => {
    const mixed = calculateOrderSavings([
      { productId: 'a', qty: 1, chosenSupplierId: 's1', offers: [
        { supplierId: 's1', unitPrice: 10, currency: 'ILS', minQty: null },
        { supplierId: 's2', unitPrice: 8, currency: 'USD', minQty: null },
      ] },
    ], 'ILS');

    expect(mixed.splitTotal).toBe(10);
    // s2 quoted a smaller NUMBER and is still not the cheapest single supplier, because its quote
    // is not a price in this basket's money.
    expect(mixed.singleSupplierId).toBe('s1');
    expect(mixed.singleSupplierTotal).toBe(10);
    expect(mixed.allCheapest).toBe(true);
    expect(mixed.currency).toBe('ILS');
  });

  it('answers nothing when the basket has no currency of its own', () => {
    const unpriced = calculateOrderSavings([
      { productId: 'a', qty: 1, chosenSupplierId: 's1', offers: [
        { supplierId: 's1', unitPrice: 10, currency: 'ILS', minQty: null },
      ] },
    ], null);

    expect(unpriced.splitTotal).toBeNull();
    expect(unpriced.singleSupplierTotal).toBeNull();
    expect(unpriced.savings).toBeNull();
  });
});
