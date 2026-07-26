import type { OrderSavings, SavingsLine } from './orderSavings';
// @ts-expect-error The direct Node check needs an explicit extension; Vite accepts it.
import { calculateOrderSavings, centsFromUnits, hundredths, lineUnits, moneyFromCents } from './orderSavings.ts';
import type { Product } from './types';

export type { OrderSavings } from './orderSavings';

export type Assignment = { mode: 'auto' } | { mode: 'pinned'; supplierId: string };

export interface SplitLine { productId: string; qty: number; assignment: Assignment }

export interface SplitOffer { supplierId: string; unitPrice: number; minQty: number | null }
export interface SplitSupplier { id: string; name: string; minOrderAmount: number | null }

export interface SplitInput {
  lines: readonly SplitLine[];
  offersByProduct: ReadonlyMap<string, readonly SplitOffer[]>;
  suppliers: ReadonlyMap<string, SplitSupplier>;
}

export type LineStatus =
  | 'ok'
  | 'pin_below_min_qty'
  | 'pin_supplier_gone'
  | 'no_usable_offer'
  | 'no_offers';

export interface ResolvedLine {
  productId: string;
  qty: number;
  assignment: Assignment;
  supplierId: string | null;
  unitPrice: number | null;
  lineTotal: number | null;
  status: LineStatus;
}

export interface SupplierGroup {
  supplier: SplitSupplier;
  lines: ResolvedLine[];
  subtotal: number;
  shortfall: number | null;
  belowMinimum: boolean;
  savingsContribution: number | null;
}

export interface OrderSplit {
  groups: SupplierGroup[];
  blocked: ResolvedLine[];
  total: number;
  savings: OrderSavings;
  breachCount: number;
}

export type ResolutionOption =
  | { kind: 'increase_qty'; productId: string; fromQty: number; toQty: number;
      qtyDelta: number; costDelta: number; subtotalAfter: number; clearsMinimum: boolean }
  | { kind: 'move_line'; productId: string; toSupplierId: string; unitPriceDelta: number;
      costDelta: number; sourceSubtotalAfter: number; sourceStillBelow: boolean;
      targetSubtotalAfter: number; targetClearsMin: boolean; requiresQty: number | null }
  | { kind: 'move_group'; productIds: string[]; toSupplierId: string; lineCount: number;
      costDelta: number; targetSubtotalAfter: number; targetClearsMin: boolean }
  | { kind: 'remove_line'; productId: string; refund: number; sourceSubtotalAfter: number; savingsDelta: number }
  | { kind: 'defer_line'; productId: string; refund: number; sourceSubtotalAfter: number; savingsDelta: number };

export interface CartState {
  order: string[];
  byId: Record<string, SplitLine>;
  products: Record<string, Product>;
}

export type SplitAction =
  | { type: 'HYDRATE'; state: CartState }
  | { type: 'ADD_PRODUCT'; product: Product }
  | { type: 'REMOVE_PRODUCT'; productId: string }
  | { type: 'SET_QTY'; productId: string; qty: number }
  | { type: 'BUMP_QTY'; productId: string; toQty: number }
  | { type: 'PIN_SUPPLIER'; productId: string; supplierId: string }
  | { type: 'UNPIN'; productId: string }
  | { type: 'MOVE_GROUP'; fromSupplierId: string; toSupplierId: string; productIds: readonly string[] }
  | { type: 'CONSOLIDATE'; supplierId: string }
  | { type: 'RESET_ALL_AUTO' }
  | { type: 'DEFER_PRODUCT'; productId: string };

const compareOffers = (a: SplitOffer, b: SplitOffer) =>
  a.unitPrice - b.unitPrice
  || (a.supplierId < b.supplierId ? -1 : a.supplierId > b.supplierId ? 1 : 0);

// A client-only rule. The server does not enforce min_qty anywhere; keeping the UI stricter is
// what stops us from ordering below a supplier's minimum.
const meetsMin = (offer: SplitOffer, qty: number) => offer.minQty == null || qty >= offer.minQty;

const blockedLine = (line: SplitLine, status: Exclude<LineStatus, 'ok'>): ResolvedLine => ({
  ...line,
  supplierId: null,
  unitPrice: null,
  lineTotal: null,
  status,
});

const resolvedLine = (line: SplitLine, offer: SplitOffer): ResolvedLine => ({
  ...line,
  supplierId: offer.supplierId,
  unitPrice: offer.unitPrice,
  lineTotal: moneyFromCents(centsFromUnits(lineUnits(line.qty, offer.unitPrice))),
  status: 'ok',
});

interface GroupAccumulator {
  supplier: SplitSupplier;
  lines: ResolvedLine[];
  units: bigint;
}

// N=80 lines, S=12 suppliers, k<=S offers per line.
// resolveSplit itself is O(N*k) ~ 960.
// calculateOrderSavings dominates at O(S*N*k) ~ 11,500 BigInt ops because of the per-candidate
// filter in its single-supplier loop (orderSavings.ts:50-67). That is already today's cost on
// every cart change and is sub-millisecond — do not add a second pass.
export function resolveSplit(input: SplitInput): OrderSplit {
  const blocked: ResolvedLine[] = [];
  const groupBySupplier = new Map<string, GroupAccumulator>();
  const knownOffersByProduct = new Map<string, SplitOffer[]>();
  const savingsLines: SavingsLine[] = [];
  let totalUnits = 0n;

  for (const line of input.lines) {
    const offers = [...(input.offersByProduct.get(line.productId) ?? [])]
      .filter((candidate) => input.suppliers.has(candidate.supplierId))
      .sort(compareOffers);
    knownOffersByProduct.set(line.productId, offers);

    let resolved: ResolvedLine;
    if (line.assignment.mode === 'pinned') {
      const pinnedSupplierId = line.assignment.supplierId;
      if (!input.suppliers.has(pinnedSupplierId)) {
        resolved = blockedLine(line, 'pin_supplier_gone');
      } else {
        const pinnedOffer = offers.find((candidate) => candidate.supplierId === pinnedSupplierId);
        resolved = !pinnedOffer
          ? blockedLine(line, 'pin_supplier_gone')
          : !meetsMin(pinnedOffer, line.qty)
            ? blockedLine(line, 'pin_below_min_qty')
            : resolvedLine(line, pinnedOffer);
      }
    } else if (offers.length === 0) {
      resolved = blockedLine(line, 'no_offers');
    } else {
      const cheapest = offers.find((candidate) => meetsMin(candidate, line.qty));
      resolved = cheapest ? resolvedLine(line, cheapest) : blockedLine(line, 'no_usable_offer');
    }

    savingsLines.push({
      productId: line.productId,
      qty: line.qty,
      chosenSupplierId: resolved.supplierId,
      offers: resolved.status === 'ok' ? offers : [],
    });

    if (resolved.status !== 'ok') {
      blocked.push(resolved);
      continue;
    }

    const units = lineUnits(resolved.qty, resolved.unitPrice!);
    totalUnits += units;
    const supplier = input.suppliers.get(resolved.supplierId!)!;
    const group = groupBySupplier.get(supplier.id);
    if (group) {
      group.lines.push(resolved);
      group.units += units;
    } else {
      groupBySupplier.set(supplier.id, { supplier, lines: [resolved], units });
    }
  }

  const savings = calculateOrderSavings(savingsLines);
  const accumulators = [...groupBySupplier.values()].sort((a, b) =>
    a.supplier.id < b.supplier.id ? -1 : a.supplier.id > b.supplier.id ? 1 : 0);
  const groups = accumulators.map(({ supplier, lines, units }): SupplierGroup => {
    const subtotalCents = centsFromUnits(units);
    const shortfallCents = supplier.minOrderAmount == null
      ? null
      : hundredths(supplier.minOrderAmount) - subtotalCents;
    return {
      supplier,
      lines,
      subtotal: moneyFromCents(subtotalCents),
      shortfall: shortfallCents === null ? null : moneyFromCents(shortfallCents),
      belowMinimum: shortfallCents !== null && shortfallCents > 0n,
      savingsContribution: null,
    };
  });

  if (blocked.length === 0 && savings.savings !== null && savings.singleSupplierId !== null && groups.length > 0) {
    const totalSavingsCents = hundredths(savings.savings);
    let assignedCents = 0n;
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      let contributionCents: bigint;
      if (index === groups.length - 1) {
        contributionCents = totalSavingsCents - assignedCents;
      } else {
        const baselineUnits = group.lines.reduce((sum, line) => {
          const prices = (knownOffersByProduct.get(line.productId) ?? [])
            .filter((candidate) => candidate.supplierId === savings.singleSupplierId)
            .map((candidate) => candidate.unitPrice);
          return sum + lineUnits(line.qty, Math.min(...prices));
        }, 0n);
        contributionCents = centsFromUnits(baselineUnits) - hundredths(group.subtotal);
        assignedCents += contributionCents;
      }
      group.savingsContribution = moneyFromCents(contributionCents);
    }
  }

  return {
    groups,
    blocked,
    total: moneyFromCents(centsFromUnits(totalUnits)),
    savings,
    breachCount: groups.filter((group) => group.belowMinimum).length,
  };
}

const moneyFromUnits = (units: bigint) => moneyFromCents(
  units < 0n ? -centsFromUnits(-units) : centsFromUnits(units),
);

const resolvedUnits = (line: ResolvedLine) => line.unitPrice == null
  ? 0n
  : lineUnits(line.qty, line.unitPrice);

const supplierGroupUnits = (group: SupplierGroup | undefined) => group?.lines
  .reduce((sum, line) => sum + resolvedUnits(line), 0n) ?? 0n;

const clearsMinimum = (supplier: SplitSupplier, units: bigint) => supplier.minOrderAmount == null
  || centsFromUnits(units) >= hundredths(supplier.minOrderAmount);

function supplierOffer(input: SplitInput, productId: string, supplierId: string): SplitOffer | null {
  return [...(input.offersByProduct.get(productId) ?? [])]
    .filter((candidate) => candidate.supplierId === supplierId)
    .sort(compareOffers)[0] ?? null;
}

const optionBucket = (option: ResolutionOption) => {
  if (option.kind === 'increase_qty') return option.clearsMinimum ? 0 : 1;
  if (option.kind === 'move_line') return !option.sourceStillBelow && option.targetClearsMin ? 0 : 1;
  if (option.kind === 'move_group') return option.targetClearsMin ? 0 : 1;
  return 2;
};

const optionCost = (option: ResolutionOption) => option.kind === 'remove_line' || option.kind === 'defer_line'
  ? option.savingsDelta
  : option.costDelta;

const kindOrder: Record<ResolutionOption['kind'], number> = {
  increase_qty: 0,
  move_line: 1,
  move_group: 2,
  remove_line: 3,
  defer_line: 4,
};

const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function compareOptions(a: ResolutionOption, b: ResolutionOption) {
  const bucketDifference = optionBucket(a) - optionBucket(b);
  if (bucketDifference) return bucketDifference;
  const costDifference = optionCost(a) - optionCost(b);
  if (costDifference) return costDifference;
  const kindDifference = kindOrder[a.kind] - kindOrder[b.kind];
  if (kindDifference) return kindDifference;
  const productA = 'productId' in a ? a.productId : '';
  const productB = 'productId' in b ? b.productId : '';
  const productDifference = compareText(productA, productB);
  if (productDifference) return productDifference;
  const supplierA = 'toSupplierId' in a ? a.toSupplierId : '';
  const supplierB = 'toSupplierId' in b ? b.toSupplierId : '';
  return compareText(supplierA, supplierB);
}

// O(L*k + S*L) for the one supplier whose panel is open.
export function resolutionOptions(
  split: OrderSplit,
  input: SplitInput,
  supplierId: string,
): ResolutionOption[] {
  const options: ResolutionOption[] = [];
  const sourceGroup = split.groups.find((group) => group.supplier.id === supplierId);
  const sourceUnits = supplierGroupUnits(sourceGroup);
  const inputLineByProduct = new Map(input.lines.map((line) => [line.productId, line]));

  if (sourceGroup?.belowMinimum) {
    const cheapestPositiveLine = [...sourceGroup.lines]
      .filter((line) => hundredths(line.unitPrice ?? 0) > 0n)
      .sort((a, b) => (a.unitPrice! - b.unitPrice!) || compareText(a.productId, b.productId))[0];
    if (cheapestPositiveLine && sourceGroup.supplier.minOrderAmount != null) {
      const shortfallCents = hundredths(sourceGroup.supplier.minOrderAmount) - centsFromUnits(sourceUnits);
      const unitPriceCents = hundredths(cheapestPositiveLine.unitPrice!);
      const qtyDelta = Number((shortfallCents + unitPriceCents - 1n) / unitPriceCents);
      const addedUnits = lineUnits(qtyDelta, cheapestPositiveLine.unitPrice!);
      const subtotalAfterUnits = sourceUnits + addedUnits;
      options.push({
        kind: 'increase_qty',
        productId: cheapestPositiveLine.productId,
        fromQty: cheapestPositiveLine.qty,
        toQty: cheapestPositiveLine.qty + qtyDelta,
        qtyDelta,
        costDelta: moneyFromUnits(addedUnits),
        subtotalAfter: moneyFromUnits(subtotalAfterUnits),
        clearsMinimum: clearsMinimum(sourceGroup.supplier, subtotalAfterUnits),
      });
    }
  }

  for (const blocked of split.blocked) {
    if (blocked.status !== 'pin_below_min_qty'
      || blocked.assignment.mode !== 'pinned'
      || blocked.assignment.supplierId !== supplierId) continue;
    const line = inputLineByProduct.get(blocked.productId);
    const pinnedOffer = line ? supplierOffer(input, line.productId, supplierId) : null;
    const targetSupplier = input.suppliers.get(supplierId);
    if (!line || !pinnedOffer || pinnedOffer.minQty == null || !targetSupplier) continue;
    const qtyDelta = pinnedOffer.minQty - line.qty;
    const addedUnits = lineUnits(qtyDelta, pinnedOffer.unitPrice);
    const subtotalAfterUnits = sourceUnits + lineUnits(pinnedOffer.minQty, pinnedOffer.unitPrice);
    options.push({
      kind: 'increase_qty',
      productId: line.productId,
      fromQty: line.qty,
      toQty: pinnedOffer.minQty,
      qtyDelta,
      costDelta: moneyFromUnits(addedUnits),
      subtotalAfter: moneyFromUnits(subtotalAfterUnits),
      clearsMinimum: clearsMinimum(targetSupplier, subtotalAfterUnits),
    });
  }

  const gonePins = split.blocked.filter((line) => line.status === 'pin_supplier_gone'
    && line.assignment.mode === 'pinned'
    && line.assignment.supplierId === supplierId);
  const movableLines = sourceGroup?.lines ?? gonePins;

  for (const resolved of movableLines) {
    const line = inputLineByProduct.get(resolved.productId);
    if (!line) continue;
    const sourceLineUnits = resolvedUnits(resolved);
    const sourceSubtotalAfterUnits = sourceUnits - sourceLineUnits;
    const sourceStillBelow = sourceGroup != null
      && sourceGroup.lines.length > 1
      && !clearsMinimum(sourceGroup.supplier, sourceSubtotalAfterUnits);
    const targetOffers = new Map<string, SplitOffer>();
    for (const candidate of input.offersByProduct.get(line.productId) ?? []) {
      if (candidate.supplierId === supplierId || !input.suppliers.has(candidate.supplierId)) continue;
      const current = targetOffers.get(candidate.supplierId);
      if (!current || compareOffers(candidate, current) < 0) targetOffers.set(candidate.supplierId, candidate);
    }
    for (const [toSupplierId, target] of [...targetOffers].sort(([a], [b]) => compareText(a, b))) {
      const targetSupplier = input.suppliers.get(toSupplierId)!;
      const qtyAfter = target.minQty != null && line.qty < target.minQty ? target.minQty : line.qty;
      const targetLineUnits = lineUnits(qtyAfter, target.unitPrice);
      const targetSubtotalAfterUnits = supplierGroupUnits(
        split.groups.find((group) => group.supplier.id === toSupplierId),
      ) + targetLineUnits;
      options.push({
        kind: 'move_line',
        productId: line.productId,
        toSupplierId,
        unitPriceDelta: moneyFromCents(hundredths(target.unitPrice) - hundredths(resolved.unitPrice ?? 0)),
        costDelta: moneyFromUnits(targetLineUnits - sourceLineUnits),
        sourceSubtotalAfter: moneyFromUnits(sourceSubtotalAfterUnits),
        sourceStillBelow,
        targetSubtotalAfter: moneyFromUnits(targetSubtotalAfterUnits),
        targetClearsMin: clearsMinimum(targetSupplier, targetSubtotalAfterUnits),
        requiresQty: qtyAfter === line.qty ? null : qtyAfter,
      });
    }
  }

  if (sourceGroup?.lines.length) {
    for (const targetSupplier of [...input.suppliers.values()].sort((a, b) => compareText(a.id, b.id))) {
      if (targetSupplier.id === supplierId) continue;
      const targetLines: { line: ResolvedLine; offer: SplitOffer; qtyAfter: number }[] = [];
      for (const line of sourceGroup.lines) {
        const target = supplierOffer(input, line.productId, targetSupplier.id);
        if (!target) break;
        targetLines.push({
          line,
          offer: target,
          qtyAfter: target.minQty != null && line.qty < target.minQty ? target.minQty : line.qty,
        });
      }
      if (targetLines.length !== sourceGroup.lines.length) continue;
      const movedUnits = targetLines.reduce(
        (sum, entry) => sum + lineUnits(entry.qtyAfter, entry.offer.unitPrice),
        0n,
      );
      const targetSubtotalAfterUnits = supplierGroupUnits(
        split.groups.find((group) => group.supplier.id === targetSupplier.id),
      ) + movedUnits;
      options.push({
        kind: 'move_group',
        productIds: sourceGroup.lines.map((line) => line.productId),
        toSupplierId: targetSupplier.id,
        lineCount: sourceGroup.lines.length,
        costDelta: moneyFromUnits(movedUnits - sourceUnits),
        targetSubtotalAfter: moneyFromUnits(targetSubtotalAfterUnits),
        targetClearsMin: clearsMinimum(targetSupplier, targetSubtotalAfterUnits),
      });
    }

    for (const line of sourceGroup.lines) {
      const refund = moneyFromUnits(resolvedUnits(line));
      const sourceSubtotalAfter = moneyFromUnits(sourceUnits - resolvedUnits(line));
      options.push({ kind: 'remove_line', productId: line.productId, refund, sourceSubtotalAfter, savingsDelta: -refund });
      options.push({ kind: 'defer_line', productId: line.productId, refund, sourceSubtotalAfter, savingsDelta: -refund });
    }
  }

  return options.sort(compareOptions);
}

const removeProduct = (state: CartState, productId: string): CartState => {
  if (!state.byId[productId]) return state;
  const { [productId]: _line, ...byId } = state.byId;
  const { [productId]: _product, ...products } = state.products;
  return { order: state.order.filter((id) => id !== productId), byId, products };
};

const assignProducts = (
  state: CartState,
  productIds: readonly string[],
  assignment: Assignment,
): CartState => {
  const selected = new Set(productIds);
  let changed = false;
  const byId = { ...state.byId };
  for (const productId of selected) {
    const line = state.byId[productId];
    if (!line) continue;
    byId[productId] = { ...line, assignment };
    changed = true;
  }
  return changed ? { ...state, byId } : state;
};

// Quantity actions preserve assignments. Derived supplier groups never enter CartState.
export function splitReducer(state: CartState, action: SplitAction): CartState {
  switch (action.type) {
    case 'HYDRATE':
      return action.state;
    case 'ADD_PRODUCT':
      if (state.byId[action.product.id]) return state;
      return {
        order: [...state.order, action.product.id],
        byId: { ...state.byId, [action.product.id]: autoLine(action.product.id) },
        products: { ...state.products, [action.product.id]: action.product },
      };
    case 'REMOVE_PRODUCT':
    case 'DEFER_PRODUCT':
      return removeProduct(state, action.productId);
    case 'SET_QTY':
    case 'BUMP_QTY': {
      const line = state.byId[action.productId];
      if (!line) return state;
      const qty = action.type === 'SET_QTY' ? action.qty : action.toQty;
      return { ...state, byId: { ...state.byId, [action.productId]: { ...line, qty } } };
    }
    case 'PIN_SUPPLIER':
      return assignProducts(state, [action.productId], { mode: 'pinned', supplierId: action.supplierId });
    case 'UNPIN':
      return assignProducts(state, [action.productId], { mode: 'auto' });
    case 'MOVE_GROUP':
      return assignProducts(state, action.productIds, { mode: 'pinned', supplierId: action.toSupplierId });
    case 'CONSOLIDATE':
      return assignProducts(state, state.order, { mode: 'pinned', supplierId: action.supplierId });
    case 'RESET_ALL_AUTO':
      return assignProducts(state, state.order, { mode: 'auto' });
  }
}

function autoLine(productId: string): SplitLine {
  return { productId, qty: 1, assignment: { mode: 'auto' } };
}
