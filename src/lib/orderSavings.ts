export interface SavingsLine {
  productId: string;
  qty: number;
  chosenSupplierId: string | null;
  offers: { supplierId: string; unitPrice: number; currency: string; minQty: number | null }[];
}

export interface OrderSavings {
  /**
   * The currency the whole comparison was made in, or null when the basket did not have one
   * (OPEN-DECISIONS #277). Every figure below is in it, and when it is null they are all null:
   * "split across three suppliers saves 240" is a sentence about one kind of money, and comparing
   * a shekel basket against a dollar one produces a saving nobody banked.
   */
  currency: string | null;
  splitTotal: number | null;
  singleSupplierTotal: number | null;
  singleSupplierId: string | null;
  savings: number | null;
  savingsPercent: number | null;
  supplierCount: number;
  allCheapest: boolean;
}

// Both qty and unit_price are NUMERIC(..., 2) in Postgres. Multiplying their
// integer hundredths keeps the browser on the same decimal path as Postgres,
// including half-cent cases such as 2.50 × 4.03 = 10.075 → 10.08.
// Exported for orderSplit.ts — one money implementation for the whole order editor.
export const hundredths = (value: number) => BigInt(Math.round(value * 100));
export const lineUnits = (qty: number, unitPrice: number) => hundredths(qty) * hundredths(unitPrice);
export const centsFromUnits = (value: bigint) => (value + 50n) / 100n;
export const moneyFromCents = (value: bigint) => Number(value) / 100;

/**
 * `basketCurrency` is supplied by the caller rather than inferred, because the caller is the one
 * that already decided which currency this basket is being priced in — and an inference here would
 * silently answer for a basket that has no single answer. An offer in any other currency is not
 * considered at all: it is not cheaper and it is not dearer, it is a different question.
 */
export function calculateOrderSavings(lines: SavingsLine[], basketCurrency: string | null): OrderSavings {
  if (basketCurrency == null) {
    return {
      currency: null,
      splitTotal: null,
      singleSupplierTotal: null,
      singleSupplierId: null,
      savings: null,
      savingsPercent: null,
      supplierCount: 0,
      allCheapest: false,
    };
  }
  const inCurrency = lines.map((line) => ({
    ...line,
    offers: line.offers.filter((offer) => offer.currency === basketCurrency),
  }));
  const selected = inCurrency.map((line) => {
    const sorted = [...line.offers].sort((a, b) =>
      a.unitPrice - b.unitPrice
      || (a.supplierId < b.supplierId ? -1 : a.supplierId > b.supplierId ? 1 : 0));
    // A client-only rule. The server does not enforce min_qty anywhere; keeping the UI stricter
    // is what stops us from ordering below a supplier's minimum.
    const usable = sorted.filter((candidate) => candidate.minQty == null || line.qty >= candidate.minQty);
    const chosen = line.chosenSupplierId ? usable.find((candidate) => candidate.supplierId === line.chosenSupplierId) : undefined;
    const offer = chosen ?? usable[0] ?? null;
    return { line, offer, cheapest: usable[0] ?? null };
  });

  const complete = inCurrency.length > 0 && selected.every(({ offer }) => offer !== null);
  const splitCents = complete
    ? centsFromUnits(selected.reduce((sum, { line, offer }) => sum + lineUnits(line.qty, offer!.unitPrice), 0n))
    : null;
  const splitTotal = splitCents === null ? null : moneyFromCents(splitCents);
  const supplierCount = complete ? new Set(selected.map(({ offer }) => offer!.supplierId)).size : 0;
  const allCheapest = complete && selected.every(({ offer, cheapest }) => offer!.unitPrice === cheapest!.unitPrice);

  let singleSupplierId: string | null = null;
  let singleSupplierUnits: bigint | null = null;
  const candidates = [...new Set(inCurrency.flatMap((line) => line.offers.map((offer) => offer.supplierId)))].sort();
  for (const supplierId of candidates) {
    let total = 0n;
    let coversBasket = true;
    for (const line of inCurrency) {
      const offers = line.offers.filter((offer) => offer.supplierId === supplierId
        && (offer.minQty == null || line.qty >= offer.minQty));
      if (!offers.length) { coversBasket = false; break; }
      total += lineUnits(line.qty, Math.min(...offers.map((offer) => offer.unitPrice)));
    }
    if (coversBasket && (
      singleSupplierUnits === null
      || total < singleSupplierUnits
      || (total === singleSupplierUnits && (singleSupplierId === null || supplierId < singleSupplierId))
    )) {
      singleSupplierId = supplierId;
      singleSupplierUnits = total;
    }
  }

  const singleSupplierCents = singleSupplierUnits === null ? null : centsFromUnits(singleSupplierUnits);
  const singleSupplierTotal = singleSupplierCents === null ? null : moneyFromCents(singleSupplierCents);
  const savingsCents = splitCents !== null && singleSupplierCents !== null ? singleSupplierCents - splitCents : null;
  const savings = savingsCents === null ? null : moneyFromCents(savingsCents);
  return {
    currency: basketCurrency,
    splitTotal,
    singleSupplierTotal,
    singleSupplierId,
    savings,
    savingsPercent: savings !== null && singleSupplierTotal! > 0
      ? Math.round((savings / singleSupplierTotal!) * 1000) / 10
      : null,
    supplierCount,
    allCheapest,
  };
}
