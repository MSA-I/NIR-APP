import type { OrderSavings, SavingsLine } from './orderSavings';
// The direct Node check needs an explicit extension; Vite accepts it. The suppression that used to
// sit here is gone: `allowImportingTsExtensions` is now on in tsconfig, so the extension type-checks
// on its own, and a `@ts-expect-error` that no longer expects an error is a compile error itself.
import { calculateOrderSavings, centsFromUnits, hundredths, lineUnits, moneyFromCents } from './orderSavings.ts';
import type { Product } from './types';

export type { OrderSavings } from './orderSavings';

export type Assignment = { mode: 'auto' } | { mode: 'pinned'; supplierId: string };

export interface SplitLine { productId: string; qty: number; assignment: Assignment }

export interface SplitOffer { supplierId: string; unitPrice: number; currency: string; minQty: number | null }
/** `currency` is the supplier's own (0217) — the unit `minOrderAmount` is stated in. */
export interface SplitSupplier { id: string; name: string; minOrderAmount: number | null; currency: string }

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
  | 'no_offers'
  /**
   * The product is offered in more than one currency, so it has no cheapest offer (#277). Sorting
   * a $12 offer below a ₪40 one is not a comparison, and picking the smaller number would hand a
   * supplier the order because of the unit its price happens to be quoted in. The line waits for a
   * person, with every offer visible in its own currency.
   */
  | 'offers_span_currencies';

export interface ResolvedLine {
  productId: string;
  qty: number;
  assignment: Assignment;
  supplierId: string | null;
  unitPrice: number | null;
  /** The chosen supplier's currency; null when nothing was chosen. */
  currency: string | null;
  lineTotal: number | null;
  status: LineStatus;
}

export interface SupplierGroup {
  supplier: SplitSupplier;
  lines: ResolvedLine[];
  /**
   * The group's one currency, which is the supplier's own. It cannot hold two: an offer priced in
   * anything other than its supplier's currency is not usable (see `usableOffers`), so every line
   * under a supplier is in that supplier's money and the minimum below is comparable to it.
   */
  currency: string;
  subtotal: number;
  shortfall: number | null;
  belowMinimum: boolean;
  savingsContribution: number | null;
}

export interface OrderSplit {
  groups: SupplierGroup[];
  blocked: ResolvedLine[];
  /**
   * One entry per currency. RENAMED from `total`, and deliberately: a basket split across a
   * shekel supplier and a dollar supplier has two totals and no third, and a reader still asking
   * for `total` should fail to compile rather than receive the first of them (plan §3.2).
   */
  totalsByCurrency: { currency: string; amount: number }[];
  /** The single currency the whole basket resolved in, or null when it holds more than one. */
  basketCurrency: string | null;
  savings: OrderSavings;
  breachCount: number;
}

export type ResolutionOption =
  | { kind: 'increase_qty'; productId: string; fromQty: number; toQty: number;
      qtyDelta: number; costDelta: number; subtotalAfter: number; clearsMinimum: boolean }
  | { kind: 'move_line'; productId: string; toSupplierId: string; unitPriceDelta: number;
      costDelta: number; sourceSubtotalAfter: number; sourceStillBelow: boolean;
      targetSubtotalAfter: number; targetClearsMin: boolean; requiresQty: number | null }
  | { kind: 'move_group'; productIds: string[]; quantityChanges: { productId: string; toQty: number }[];
      toSupplierId: string; lineCount: number;
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
  | { type: 'MOVE_GROUP'; fromSupplierId: string; toSupplierId: string; productIds: readonly string[];
      quantityChanges: readonly { productId: string; toQty: number }[] }
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
  currency: null,
  lineTotal: null,
  status,
});

const resolvedLine = (line: SplitLine, offer: SplitOffer): ResolvedLine => ({
  ...line,
  supplierId: offer.supplierId,
  unitPrice: offer.unitPrice,
  currency: offer.currency,
  lineTotal: moneyFromCents(centsFromUnits(lineUnits(line.qty, offer.unitPrice))),
  status: 'ok',
});

/**
 * An offer counts only when it is priced in ITS OWN SUPPLIER's currency.
 *
 * A supplier quoting one product in a currency other than the one they trade in is a data
 * anomaly, and admitting it would break the one property everything downstream leans on: that a
 * supplier's group is in a single currency, so its subtotal is a real number and its minimum order
 * — stated in that same currency — is comparable to it.
 */
const usableOffers = (offers: readonly SplitOffer[], suppliers: SplitInput['suppliers']) =>
  offers.filter((offer) => offer.currency === suppliers.get(offer.supplierId)?.currency);

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
    const offers = usableOffers(
      [...(input.offersByProduct.get(line.productId) ?? [])]
        .filter((candidate) => input.suppliers.has(candidate.supplierId)),
      input.suppliers,
    ).sort(compareOffers);
    knownOffersByProduct.set(line.productId, offers);
    // Whether this product can be compared at all. Two currencies among its offers means the
    // cheapest is undefined, not merely unknown.
    const lineCurrencies = new Set(offers.map((offer) => offer.currency));

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
    } else if (lineCurrencies.size > 1) {
      resolved = blockedLine(line, 'offers_span_currencies');
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

  // The basket's own currency: the one every resolved line landed in, or null when they did not
  // agree. A saving is "split across suppliers costs less than one supplier for everything", and
  // that sentence is only true inside one kind of money.
  const resolvedCurrencies = new Set(
    [...groupBySupplier.values()].map((group) => group.supplier.currency),
  );
  const basketCurrency = resolvedCurrencies.size === 1 ? [...resolvedCurrencies][0] : null;
  const savings = calculateOrderSavings(savingsLines, basketCurrency);
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
      currency: supplier.currency,
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

  const totalsByCurrency = [...groups.reduce((totals, group) => {
    totals.set(group.currency, (totals.get(group.currency) ?? 0n) + hundredths(group.subtotal));
    return totals;
  }, new Map<string, bigint>())].map(([currency, cents]) => ({ currency, amount: moneyFromCents(cents) }))
    .sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));

  return {
    groups,
    blocked,
    totalsByCurrency,
    basketCurrency,
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
  return usableOffers(
    [...(input.offersByProduct.get(productId) ?? [])]
      .filter((candidate) => candidate.supplierId === supplierId),
    input.suppliers,
  ).sort(compareOffers)[0] ?? null;
}

/**
 * Moving a line from a shekel supplier to a dollar one is not a fix for a minimum-order shortfall,
 * and `costDelta` for such a move would be the subtraction of unlike things. The panel offers a
 * move only between suppliers who price in the same money; the alternative offer stays visible on
 * the line itself, where the person can see its currency and decide.
 */
const sameCurrency = (input: SplitInput, a: string, b: string) =>
  input.suppliers.get(a)?.currency === input.suppliers.get(b)?.currency;

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
  const movableLines = [...(sourceGroup?.lines ?? []), ...gonePins];

  for (const resolved of movableLines) {
    const line = inputLineByProduct.get(resolved.productId);
    if (!line) continue;
    const sourceLineUnits = resolvedUnits(resolved);
    const sourceSubtotalAfterUnits = sourceUnits - sourceLineUnits;
    const sourceStillBelow = sourceGroup != null && (resolved.status !== 'ok'
      ? sourceGroup.belowMinimum
      : sourceGroup.lines.length > 1 && !clearsMinimum(sourceGroup.supplier, sourceSubtotalAfterUnits));
    const targetOffers = new Map<string, SplitOffer>();
    for (const candidate of usableOffers(input.offersByProduct.get(line.productId) ?? [], input.suppliers)) {
      if (candidate.supplierId === supplierId || !input.suppliers.has(candidate.supplierId)) continue;
      // `costDelta` below is the subtraction of the two line totals. Across two currencies that is
      // not a cost difference, so the move is not offered at all rather than offered with a
      // meaningless number attached to it.
      if (!sameCurrency(input, supplierId, candidate.supplierId)) continue;
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
      if (!sameCurrency(input, supplierId, targetSupplier.id)) continue;
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
        quantityChanges: targetLines
          .filter((entry) => entry.qtyAfter !== entry.line.qty)
          .map((entry) => ({ productId: entry.line.productId, toQty: entry.qtyAfter })),
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
    case 'MOVE_GROUP': {
      const assigned = assignProducts(state, action.productIds, { mode: 'pinned', supplierId: action.toSupplierId });
      if (!action.quantityChanges.length) return assigned;
      const byId = { ...assigned.byId };
      for (const change of action.quantityChanges) {
        const line = byId[change.productId];
        if (line) byId[change.productId] = { ...line, qty: change.toQty };
      }
      return { ...assigned, byId };
    }
    case 'CONSOLIDATE':
      return assignProducts(state, state.order, { mode: 'pinned', supplierId: action.supplierId });
    case 'RESET_ALL_AUTO':
      return assignProducts(state, state.order, { mode: 'auto' });
  }
}

function autoLine(productId: string): SplitLine {
  return { productId, qty: 1, assignment: { mode: 'auto' } };
}
