import assert from 'node:assert/strict';
import {
  resolveSplit,
  resolutionOptions,
  splitReducer,
  type CartState,
  type ResolutionOption,
  type SplitInput,
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
const splitInput = (
  lines: readonly SplitLine[],
  offers: ReadonlyArray<readonly [string, readonly SplitOffer[]]>,
  supplierRows: readonly SplitSupplier[] = [supplier(CHEAP), supplier(EXPENSIVE), supplier(THIRD)],
): SplitInput => ({
  lines,
  offersByProduct: new Map(offers),
  suppliers: new Map(supplierRows.map((row) => [row.id, row])),
});
const resolve = (
  lines: readonly SplitLine[],
  offers: ReadonlyArray<readonly [string, readonly SplitOffer[]]>,
  supplierRows?: readonly SplitSupplier[],
) => resolveSplit(splitInput(lines, offers, supplierRows));

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
const belowMinPinInput = splitInput(
  [pinned('a', EXPENSIVE, 2)],
  [['a', [offer(CHEAP, 9), offer(EXPENSIVE, 8, 3)]]],
);
const belowMinPin = resolveSplit(belowMinPinInput);
assert.equal(belowMinPin.blocked[0].status, 'pin_below_min_qty');
assert.deepEqual(belowMinPin.blocked[0].assignment, { mode: 'pinned', supplierId: EXPENSIVE });
assert.equal(belowMinPin.blocked[0].supplierId, null);
assert.equal(belowMinPin.groups.length, 0);

// 4. A pin whose supplier is gone is blocked.
const gonePinInput = splitInput(
  [pinned('a', THIRD)],
  [['a', [offer(CHEAP, 9)]]],
  [supplier(CHEAP), supplier(EXPENSIVE)],
);
const gonePin = resolveSplit(gonePinInput);
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

// A price refresh changes only derived money; it never hydrates over a fresh pin.
const pinnedBeforePriceChange = resolve([pinnedState.byId.a], [['a', [offer(CHEAP, 10), offer(EXPENSIVE, 12)]]]);
const pinnedAfterPriceChange = resolve([pinnedState.byId.a], [['a', [offer(CHEAP, 10), offer(EXPENSIVE, 14)]]]);
assert.deepEqual(pinnedState.byId.a.assignment, { mode: 'pinned', supplierId: EXPENSIVE });
assert.equal(pinnedBeforePriceChange.groups[0].supplier.id, EXPENSIVE);
assert.equal(pinnedAfterPriceChange.groups[0].supplier.id, EXPENSIVE);
assert.equal(pinnedBeforePriceChange.groups[0].lines[0].unitPrice, 12);
assert.equal(pinnedAfterPriceChange.groups[0].lines[0].unitPrice, 14);
assert.equal(pinnedBeforePriceChange.groups[0].lines[0].lineTotal, 12);
assert.equal(pinnedAfterPriceChange.groups[0].lines[0].lineTotal, 14);

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
  quantityChanges: [],
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

const minimumInput = splitInput(
  [auto('minimum', 3)],
  [['minimum', [offer(CHEAP, 12.5)]]],
  [supplier(CHEAP, 100)],
);
const minimumSplit = resolveSplit(minimumInput);
const [increase] = resolutionOptions(minimumSplit, minimumInput, CHEAP);
assert.equal(increase.kind, 'increase_qty');
if (increase.kind === 'increase_qty') {
  assert.equal(increase.qtyDelta, 5);
  assert.equal(increase.toQty, 8);
  assert.equal(increase.costDelta, 62.5);
  assert.equal(increase.subtotalAfter, 100);
  assert.equal(increase.clearsMinimum, true);
}

const unevenInput = splitInput(
  [auto('uneven', 3)],
  [['uneven', [offer(CHEAP, 12.3)]]],
  [supplier(CHEAP, 100)],
);
const unevenIncrease = resolutionOptions(resolveSplit(unevenInput), unevenInput, CHEAP)
  .find((option) => option.kind === 'increase_qty');
assert.equal(unevenIncrease?.kind, 'increase_qty');
if (unevenIncrease?.kind === 'increase_qty') {
  assert.equal(unevenIncrease.qtyDelta, 6);
  assert.ok(unevenIncrease.subtotalAfter >= 100);
}

const moveLineInput = splitInput(
  [auto('move', 3)],
  [['move', [offer(CHEAP, 10), offer(EXPENSIVE, 12, 10)]]],
  [supplier(CHEAP, 100), supplier(EXPENSIVE, 50)],
);
const moveLine = resolutionOptions(resolveSplit(moveLineInput), moveLineInput, CHEAP)
  .find((option) => option.kind === 'move_line' && option.toSupplierId === EXPENSIVE);
assert.equal(moveLine?.kind, 'move_line');
if (moveLine?.kind === 'move_line') {
  assert.equal(moveLine.requiresQty, 10);
  assert.equal(moveLine.costDelta, 90);
  assert.equal(moveLine.sourceStillBelow, false);
  assert.equal(moveLine.targetSubtotalAfter, 120);
}

const groupInput = splitInput(
  [auto('g1'), auto('g2'), auto('g3')],
  [
    ['g1', [offer(CHEAP, 10), offer(EXPENSIVE, 11), offer(THIRD, 12)]],
    ['g2', [offer(CHEAP, 10), offer(EXPENSIVE, 11), offer(THIRD, 12)]],
    ['g3', [offer(CHEAP, 10), offer(EXPENSIVE, 11)]],
  ],
  [supplier(CHEAP, 100), supplier(EXPENSIVE, 30), supplier(THIRD, 20)],
);
const groupMoves = resolutionOptions(resolveSplit(groupInput), groupInput, CHEAP)
  .filter((option): option is Extract<ResolutionOption, { kind: 'move_group' }> => option.kind === 'move_group');
assert.equal(groupMoves.length, 1);
assert.equal(groupMoves[0].toSupplierId, EXPENSIVE);
assert.deepEqual(groupMoves[0].productIds, ['g1', 'g2', 'g3']);

// Group moves apply target minQty increases atomically, matching the option's displayed total.
const groupMinQtyInput = splitInput(
  [auto('gm1', 2), auto('gm2', 3)],
  [
    ['gm1', [offer(CHEAP, 10), offer(EXPENSIVE, 12, 5)]],
    ['gm2', [offer(CHEAP, 10), offer(EXPENSIVE, 11)]],
  ],
  [supplier(CHEAP, 100), supplier(EXPENSIVE, 50)],
);
const groupMinQtyOption = resolutionOptions(resolveSplit(groupMinQtyInput), groupMinQtyInput, CHEAP)
  .find((option) => option.kind === 'move_group' && option.toSupplierId === EXPENSIVE);
assert.equal(groupMinQtyOption?.kind, 'move_group');
if (groupMinQtyOption?.kind === 'move_group') {
  assert.deepEqual(groupMinQtyOption.quantityChanges, [{ productId: 'gm1', toQty: 5 }]);
  const state: CartState = {
    order: ['gm1', 'gm2'],
    byId: { gm1: auto('gm1', 2), gm2: auto('gm2', 3) },
    products: { gm1: product('gm1'), gm2: product('gm2') },
  };
  const applied = splitReducer(state, {
    type: 'MOVE_GROUP',
    fromSupplierId: CHEAP,
    toSupplierId: EXPENSIVE,
    productIds: groupMinQtyOption.productIds,
    quantityChanges: groupMinQtyOption.quantityChanges,
  });
  const appliedSplit = resolveSplit({ ...groupMinQtyInput, lines: applied.order.map((id) => applied.byId[id]) });
  assert.equal(applied.byId.gm1.qty, 5);
  assert.equal(appliedSplit.blocked.length, 0);
  assert.equal(appliedSplit.groups[0].subtotal, groupMinQtyOption.targetSubtotalAfter);
}

const removalOptions = resolutionOptions(minimumSplit, minimumInput, CHEAP);
const remove = removalOptions.find((option) => option.kind === 'remove_line');
const defer = removalOptions.find((option) => option.kind === 'defer_line');
assert.equal(remove?.kind, 'remove_line');
assert.equal(defer?.kind, 'defer_line');
if (remove?.kind === 'remove_line' && defer?.kind === 'defer_line') {
  assert.equal(remove.refund, 37.5);
  assert.equal(remove.savingsDelta, -37.5);
  assert.equal(defer.refund, 37.5);
  assert.equal(defer.savingsDelta, -37.5);
}

const unaffectedInput = splitInput(
  [auto('left'), auto('right', 2)],
  [['left', [offer(CHEAP, 10)]], ['right', [offer(EXPENSIVE, 20)]]],
  [supplier(CHEAP, 100), supplier(EXPENSIVE, 100)],
);
const rightBeforeRemoval = resolutionOptions(resolveSplit(unaffectedInput), unaffectedInput, EXPENSIVE);
const rightOnlyInput = splitInput(
  [auto('right', 2)],
  [['right', [offer(EXPENSIVE, 20)]]],
  [supplier(CHEAP, 100), supplier(EXPENSIVE, 100)],
);
assert.deepEqual(
  resolutionOptions(resolveSplit(rightOnlyInput), rightOnlyInput, EXPENSIVE),
  rightBeforeRemoval,
);

const rankedInput = splitInput(
  [auto('ranked', 5)],
  [['ranked', [offer(CHEAP, 10), offer(EXPENSIVE, 10)]]],
  [supplier(CHEAP, 100), supplier(EXPENSIVE, 50)],
);
const rankedSplit = resolveSplit(rankedInput);
const ranked = resolutionOptions(rankedSplit, rankedInput, CHEAP);
assert.deepEqual(ranked.map((option) => option.kind), [
  'move_line',
  'move_group',
  'increase_qty',
  'remove_line',
  'defer_line',
]);
assert.deepEqual(resolutionOptions(rankedSplit, rankedInput, CHEAP), ranked);

const noAlternativeInput = splitInput(
  [auto('only')],
  [['only', [offer(CHEAP, 10)]]],
  [supplier(CHEAP, 100)],
);
const noAlternative = resolutionOptions(resolveSplit(noAlternativeInput), noAlternativeInput, CHEAP);
assert.ok(noAlternative.length > 0);
assert.ok(noAlternative.every((option) => option.kind !== 'move_line' && option.kind !== 'move_group'));

const signedRoundingInput = splitInput(
  [pinned('signed', CHEAP, 0.5)],
  [['signed', [offer(CHEAP, 4.03), offer(EXPENSIVE, 4.02)]]],
  [supplier(CHEAP, 10), supplier(EXPENSIVE)],
);
const signedMove = resolutionOptions(resolveSplit(signedRoundingInput), signedRoundingInput, CHEAP)
  .find((option) => option.kind === 'move_line' && option.toSupplierId === EXPENSIVE);
assert.equal(signedMove?.kind, 'move_line');
if (signedMove?.kind === 'move_line') assert.equal(signedMove.costDelta, -0.01);

const repair = resolutionOptions(belowMinPin, belowMinPinInput, EXPENSIVE)
  .find((option) => option.kind === 'increase_qty' && option.productId === 'a');
assert.equal(repair?.kind, 'increase_qty');
if (repair?.kind === 'increase_qty') {
  assert.equal(repair.toQty, 3);
  assert.equal(repair.costDelta, 8);
}
assert.ok(resolutionOptions(gonePin, gonePinInput, THIRD)
  .some((option) => option.kind === 'move_line' && option.toSupplierId === CHEAP));

// A missing pinned offer still gets repair options when the same supplier owns other valid lines.
const mixedGonePinInput = splitInput(
  [pinned('valid', EXPENSIVE), pinned('gone', EXPENSIVE)],
  [
    ['valid', [offer(EXPENSIVE, 5)]],
    ['gone', [offer(CHEAP, 7)]],
  ],
  [supplier(CHEAP), supplier(EXPENSIVE, 20)],
);
const mixedGoneRepair = resolutionOptions(resolveSplit(mixedGonePinInput), mixedGonePinInput, EXPENSIVE)
  .find((option) => option.kind === 'move_line' && option.productId === 'gone' && option.toSupplierId === CHEAP);
assert.equal(mixedGoneRepair?.kind, 'move_line');
if (mixedGoneRepair?.kind === 'move_line') assert.equal(mixedGoneRepair.sourceStillBelow, true);

console.log('order split checks passed');
