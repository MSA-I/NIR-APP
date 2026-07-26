import assert from 'node:assert/strict';
import {
  resolveSplit,
  splitReducer,
  type CartState,
  type SplitLine,
  type SplitOffer,
  type SplitSupplier,
} from '../src/lib/orderSplit.ts';
import type { Product } from '../src/lib/types.ts';

const CHEAP = '00000000-0000-0000-0000-000000000001';
const EXPENSIVE = '00000000-0000-0000-0000-000000000002';
const THIRD = '00000000-0000-0000-0000-000000000003';

const supplier = (id: string, minOrderAmount: number | null = null): SplitSupplier => ({
  id,
  name: `Supplier ${id.at(-1)}`,
  minOrderAmount,
});
const product = (id: string): Product => ({
  id,
  org_id: 'org',
  name: `Product ${id}`,
  category_id: null,
  unit: 'unit',
  sku: null,
  barcode: null,
  notes: null,
  active: true,
  min_stock: null,
});
const auto = (productId: string, qty = 1): SplitLine => ({
  productId,
  qty,
  assignment: { mode: 'auto' },
});
const pinned = (productId: string, supplierId: string, qty = 1): SplitLine => ({
  productId,
  qty,
  assignment: { mode: 'pinned', supplierId },
});
const offer = (supplierId: string, unitPrice: number, minQty: number | null = null): SplitOffer => ({
  supplierId,
  unitPrice,
  minQty,
});
const resolve = (
  lines: readonly SplitLine[],
  offers: ReadonlyArray<readonly [string, readonly SplitOffer[]]>,
  supplierRows: readonly SplitSupplier[] = [supplier(CHEAP), supplier(EXPENSIVE), supplier(THIRD)],
) => resolveSplit({
  lines,
  offersByProduct: new Map(offers),
  suppliers: new Map(supplierRows.map((row) => [row.id, row])),
});

// 1. Auto lines split to each product's cheapest usable supplier.
const automatic = resolve(
  [auto('a'), auto('b')],
  [
    ['a', [offer(EXPENSIVE, 4), offer(CHEAP, 3)]],
    ['b', [offer(CHEAP, 9), offer(EXPENSIVE, 5)]],
  ],
);
assert.equal(automatic.groups.length, 2);
assert.equal(automatic.groups.find((group) => group.supplier.id === CHEAP)?.lines[0].productId, 'a');
assert.equal(automatic.groups.find((group) => group.supplier.id === EXPENSIVE)?.lines[0].productId, 'b');

// 2. A pin may deliberately choose the expensive supplier.
const expensivePin = resolve(
  [pinned('a', EXPENSIVE)],
  [['a', [offer(CHEAP, 10), offer(EXPENSIVE, 12)]]],
);
assert.equal(expensivePin.groups[0].supplier.id, EXPENSIVE);
assert.equal(expensivePin.savings.allCheapest, false);
assert.equal(expensivePin.savings.savings, -2);

// 3. A pin below minQty is blocked and never silently falls back.
const belowMinPin = resolve(
  [pinned('a', EXPENSIVE, 2)],
  [['a', [offer(CHEAP, 9), offer(EXPENSIVE, 8, 3)]]],
);
assert.equal(belowMinPin.blocked[0].status, 'pin_below_min_qty');
assert.equal(belowMinPin.blocked[0].supplierId, null);
assert.equal(belowMinPin.groups.length, 0);

// 4. A pin whose supplier is gone is blocked.
const gonePin = resolve(
  [pinned('a', THIRD)],
  [['a', [offer(CHEAP, 9)]]],
  [supplier(CHEAP), supplier(EXPENSIVE)],
);
assert.equal(gonePin.blocked[0].status, 'pin_supplier_gone');

// 5. No offers and 6. no usable offers are distinct operational states.
assert.equal(resolve([auto('a')], []).blocked[0].status, 'no_offers');
assert.equal(resolve([auto('a', 2)], [['a', [offer(CHEAP, 9, 3), offer(EXPENSIVE, 8, 4)]]]).blocked[0].status, 'no_usable_offer');

// 7. Supplier minimum shortfall is exact and counted once.
const belowOrderMinimum = resolve(
  [auto('a')],
  [['a', [offer(CHEAP, 10)]]],
  [supplier(CHEAP, 15)],
);
assert.equal(belowOrderMinimum.groups[0].belowMinimum, true);
assert.equal(belowOrderMinimum.groups[0].shortfall, 5);
assert.equal(belowOrderMinimum.breachCount, 1);

// 8. Missing minOrderAmount is unknown, never a synthetic zero.
const noOrderMinimum = resolve([auto('a')], [['a', [offer(CHEAP, 10)]]], [supplier(CHEAP)]);
assert.equal(noOrderMinimum.groups[0].belowMinimum, false);
assert.equal(noOrderMinimum.groups[0].shortfall, null);

// 9. Equal prices use the lower supplier UUID, independent of input order.
const tie = resolve([auto('a')], [['a', [offer(EXPENSIVE, 10), offer(CHEAP, 10)]]]);
assert.equal(tie.groups[0].supplier.id, CHEAP);

// 10. Line totals use the same half-cent path as orderSavings/Postgres.
const rounded = resolve([auto('a', 2.5)], [['a', [offer(CHEAP, 4.03)]]]);
assert.equal(rounded.groups[0].lines[0].lineTotal, 10.08);
assert.equal(rounded.total, 10.08);

// Savings contribution is measured against the one-supplier baseline and reconciles exactly.
assert.equal(automatic.groups.reduce((sum, group) => sum + group.savingsContribution!, 0), automatic.savings.savings);

const emptyState: CartState = { order: [], byId: {}, products: {} };
const withProduct = splitReducer(emptyState, { type: 'ADD_PRODUCT', product: product('a') });

// 11. Quantity edits never erase a user pin.
const pinnedState = splitReducer(withProduct, { type: 'PIN_SUPPLIER', productId: 'a', supplierId: EXPENSIVE });
const setQtyState = splitReducer(pinnedState, { type: 'SET_QTY', productId: 'a', qty: 4 });
const bumpedState = splitReducer(setQtyState, { type: 'BUMP_QTY', productId: 'a', toQty: 8 });
assert.deepEqual(pinnedState.byId.a.assignment, { mode: 'pinned', supplierId: EXPENSIVE });
assert.deepEqual(setQtyState.byId.a.assignment, pinnedState.byId.a.assignment);
assert.deepEqual(bumpedState.byId.a.assignment, pinnedState.byId.a.assignment);

// 12. Every newly added product begins in auto mode.
assert.deepEqual(withProduct.byId.a.assignment, { mode: 'auto' });

// 13. UNPIN stores no derived split; changed prices resolve the auto line again.
const unpinnedState = splitReducer(pinnedState, { type: 'UNPIN', productId: 'a' });
const beforePriceChange = resolve([unpinnedState.byId.a], [['a', [offer(CHEAP, 10), offer(EXPENSIVE, 12)]]]);
const afterPriceChange = resolve([unpinnedState.byId.a], [['a', [offer(CHEAP, 13), offer(EXPENSIVE, 9)]]]);
assert.deepEqual(unpinnedState.byId.a.assignment, { mode: 'auto' });
assert.equal(beforePriceChange.groups[0].supplier.id, CHEAP);
assert.equal(afterPriceChange.groups[0].supplier.id, EXPENSIVE);

// MOVE_GROUP gets the exact product ids from the current derived SupplierGroup.
const twoProducts = splitReducer(withProduct, { type: 'ADD_PRODUCT', product: product('b') });
const currentSplit = resolve(
  twoProducts.order.map((id) => twoProducts.byId[id]),
  [
    ['a', [offer(CHEAP, 2), offer(EXPENSIVE, 3)]],
    ['b', [offer(CHEAP, 8), offer(EXPENSIVE, 4)]],
  ],
);
const cheapProductIds = currentSplit.groups.find((group) => group.supplier.id === CHEAP)!.lines.map((line) => line.productId);
const moved = splitReducer(twoProducts, {
  type: 'MOVE_GROUP',
  fromSupplierId: CHEAP,
  toSupplierId: THIRD,
  productIds: cheapProductIds,
});
assert.deepEqual(moved.byId.a.assignment, { mode: 'pinned', supplierId: THIRD });
assert.deepEqual(moved.byId.b.assignment, { mode: 'auto' });

const consolidated = splitReducer(twoProducts, { type: 'CONSOLIDATE', supplierId: THIRD });
assert.ok(consolidated.order.every((id) => consolidated.byId[id].assignment.mode === 'pinned'
  && consolidated.byId[id].assignment.supplierId === THIRD));
const reset = splitReducer(consolidated, { type: 'RESET_ALL_AUTO' });
assert.ok(reset.order.every((id) => reset.byId[id].assignment.mode === 'auto'));
const deferred = splitReducer(twoProducts, { type: 'DEFER_PRODUCT', productId: 'a' });
assert.deepEqual(deferred.order, ['b']);
assert.equal(deferred.byId.a, undefined);
assert.equal(deferred.products.a, undefined);

console.log('order split checks passed');
