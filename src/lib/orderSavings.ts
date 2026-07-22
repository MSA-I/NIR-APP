export interface SavingsLine {
  productId: string;
  qty: number;
  chosenSupplierId: string | null;
  offers: { supplierId: string; unitPrice: number }[];
}

export interface OrderSavings {
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
const hundredths = (value: number) => BigInt(Math.round(value * 100));
const lineUnits = (qty: number, unitPrice: number) => hundredths(qty) * hundredths(unitPrice);
const centsFromUnits = (value: bigint) => (value + 50n) / 100n;
const moneyFromCents = (value: bigint) => Number(value) / 100;

export function calculateOrderSavings(lines: SavingsLine[]): OrderSavings {
  const selected = lines.map((line) => {
    const sorted = [...line.offers].sort((a, b) => a.unitPrice - b.unitPrice);
    const offer = line.chosenSupplierId
      ? sorted.find((candidate) => candidate.supplierId === line.chosenSupplierId) ?? null
      : sorted[0] ?? null;
    return { line, offer, cheapest: sorted[0] ?? null };
  });

  const complete = lines.length > 0 && selected.every(({ offer }) => offer !== null);
  const splitCents = complete
    ? centsFromUnits(selected.reduce((sum, { line, offer }) => sum + lineUnits(line.qty, offer!.unitPrice), 0n))
    : null;
  const splitTotal = splitCents === null ? null : moneyFromCents(splitCents);
  const supplierCount = complete ? new Set(selected.map(({ offer }) => offer!.supplierId)).size : 0;
  const allCheapest = complete && selected.every(({ offer, cheapest }) => offer!.unitPrice === cheapest!.unitPrice);

  let singleSupplierId: string | null = null;
  let singleSupplierUnits: bigint | null = null;
  const candidates = new Set(lines.flatMap((line) => line.offers.map((offer) => offer.supplierId)));
  for (const supplierId of candidates) {
    let total = 0n;
    let coversBasket = true;
    for (const line of lines) {
      const offers = line.offers.filter((offer) => offer.supplierId === supplierId);
      if (!offers.length) { coversBasket = false; break; }
      total += lineUnits(line.qty, Math.min(...offers.map((offer) => offer.unitPrice)));
    }
    if (coversBasket && (singleSupplierUnits === null || total < singleSupplierUnits)) {
      singleSupplierId = supplierId;
      singleSupplierUnits = total;
    }
  }

  const singleSupplierCents = singleSupplierUnits === null ? null : centsFromUnits(singleSupplierUnits);
  const singleSupplierTotal = singleSupplierCents === null ? null : moneyFromCents(singleSupplierCents);
  const savingsCents = splitCents !== null && singleSupplierCents !== null ? singleSupplierCents - splitCents : null;
  const savings = savingsCents === null ? null : moneyFromCents(savingsCents);
  return {
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
