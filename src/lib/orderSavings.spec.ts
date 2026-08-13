import { describe, expect, it } from 'vitest';
import { calculateOrderSavings, type SavingsLine } from './orderSavings';

const basket: SavingsLine[] = [
  { productId: 'a', qty: 2, chosenSupplierId: 's1', offers: [{ supplierId: 's1', unitPrice: 10, minQty: null }, { supplierId: 's2', unitPrice: 12, minQty: null }] },
  { productId: 'b', qty: 1, chosenSupplierId: 's2', offers: [{ supplierId: 's1', unitPrice: 20, minQty: null }, { supplierId: 's2', unitPrice: 15, minQty: null }] },
];

describe('order savings', () => {
  it('compares a split basket with the cheapest complete single supplier', () => {
    expect(calculateOrderSavings(basket)).toEqual({
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
    ).savings).toBe(-5);
  });

  it('uses quantities, money rounding and deterministic tie-breaking', () => {
    expect(calculateOrderSavings([
      { productId: 'quantity-saving', qty: 3, chosenSupplierId: 's2', offers: [{ supplierId: 's1', unitPrice: 10, minQty: null }, { supplierId: 's2', unitPrice: 12, minQty: null }] },
    ]).savings).toBe(-6);
    expect(calculateOrderSavings([
      { productId: 'decimal', qty: 2.5, chosenSupplierId: 's1', offers: [{ supplierId: 's1', unitPrice: 4.03, minQty: null }] },
    ]).splitTotal).toBe(10.08);
    const tie = calculateOrderSavings([
      { productId: 'tie', qty: 1, chosenSupplierId: null, offers: [
        { supplierId: '00000000-0000-0000-0000-000000000002', unitPrice: 10, minQty: null },
        { supplierId: '00000000-0000-0000-0000-000000000001', unitPrice: 10, minQty: null },
      ] },
    ]);
    expect(tie.singleSupplierId).toBe('00000000-0000-0000-0000-000000000001');
    expect(tie.allCheapest).toBe(true);
  });

  it('requires a complete usable offer set for a single-supplier baseline', () => {
    expect(calculateOrderSavings([
      { ...basket[0], offers: basket[0].offers.slice(0, 1) },
      { ...basket[1], offers: basket[1].offers.slice(1) },
    ]).singleSupplierTotal).toBeNull();
    expect(calculateOrderSavings([
      { productId: 'min-a', qty: 2, chosenSupplierId: null, offers: [
        { supplierId: 's1', unitPrice: 10, minQty: null },
        { supplierId: 's2', unitPrice: 5, minQty: 10 },
      ] },
      { productId: 'min-b', qty: 2, chosenSupplierId: null, offers: [
        { supplierId: 's1', unitPrice: 10, minQty: null },
        { supplierId: 's2', unitPrice: 5, minQty: null },
      ] },
    ]).singleSupplierId).toBe('s1');
  });
});
