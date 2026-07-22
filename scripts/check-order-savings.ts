import assert from 'node:assert/strict';
import { calculateOrderSavings, type SavingsLine } from '../src/lib/orderSavings.ts';

const basket: SavingsLine[] = [
  { productId: 'a', qty: 2, chosenSupplierId: 's1', offers: [{ supplierId: 's1', unitPrice: 10 }, { supplierId: 's2', unitPrice: 12 }] },
  { productId: 'b', qty: 1, chosenSupplierId: 's2', offers: [{ supplierId: 's1', unitPrice: 20 }, { supplierId: 's2', unitPrice: 15 }] },
];

assert.deepEqual(calculateOrderSavings(basket), {
  splitTotal: 35, singleSupplierTotal: 39, singleSupplierId: 's2', savings: 4,
  savingsPercent: 10.3, supplierCount: 2, allCheapest: true,
});
assert.equal(calculateOrderSavings(basket.map((line, index) => ({ ...line, chosenSupplierId: index ? 's1' : 's2' }))).savings, -5);
assert.equal(calculateOrderSavings([{ ...basket[0], offers: basket[0].offers.slice(0, 1) }, { ...basket[1], offers: basket[1].offers.slice(1) }]).singleSupplierTotal, null);
assert.equal(calculateOrderSavings([
  { productId: 'decimal', qty: 2.5, chosenSupplierId: 's1', offers: [{ supplierId: 's1', unitPrice: 4.03 }] },
]).splitTotal, 10.08);
const tie = calculateOrderSavings([
  { productId: 'tie', qty: 1, chosenSupplierId: null, offers: [
    { supplierId: '00000000-0000-0000-0000-000000000002', unitPrice: 10 },
    { supplierId: '00000000-0000-0000-0000-000000000001', unitPrice: 10 },
  ] },
]);
assert.equal(tie.singleSupplierId, '00000000-0000-0000-0000-000000000001');
assert.equal(tie.allCheapest, true);

console.log('order savings checks passed');
