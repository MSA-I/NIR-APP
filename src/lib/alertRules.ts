/**
 * The counting logic behind the alert scans, kept free of any import so it can be exercised
 * without a database or a browser. `alerts.ts` fetches; this decides.
 *
 * Runnable check: `npm run check:alerts`
 */

/** Number of (supplier, invoice number) pairs that appear more than once. */
export function countDuplicateKeys(rows: { supplier_id: string; invoice_number: string }[]): number {
  const seen = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.supplier_id}|${r.invoice_number}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  let dupes = 0;
  for (const n of seen.values()) if (n > 1) dupes++;
  return dupes;
}

/**
 * Offers priced more than `margin` above the average for their product.
 *
 * Two suppressions, both deliberate:
 *  - a product with a single supplier is skipped. Its own price is the average, so it can
 *    never exceed it, and reporting a deviation of zero would be a finding about nothing.
 *  - a non-positive average is skipped rather than divided by.
 */
export function countAboveAverage(
  rows: { product_id: string; current_price: number }[],
  margin: number,
): number {
  const byProduct = new Map<string, number[]>();
  for (const r of rows) {
    const list = byProduct.get(r.product_id) ?? [];
    list.push(r.current_price);
    byProduct.set(r.product_id, list);
  }

  let over = 0;
  for (const prices of byProduct.values()) {
    if (prices.length < 2) continue;
    const avg = prices.reduce((s, p) => s + p, 0) / prices.length;
    if (avg <= 0) continue;
    over += prices.filter((p) => p > avg * (1 + margin)).length;
  }
  return over;
}

export interface AlertScanDefinition<T> {
  code: string;
  label: string;
  run: () => Promise<T | null>;
}

export async function settleAlertScans<T>(scans: readonly AlertScanDefinition<T>[]) {
  const settled = await Promise.allSettled(scans.map((scan) => scan.run()));
  const alerts: T[] = [];
  const failures: { code: string; label: string }[] = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      if (result.value) alerts.push(result.value);
    } else {
      failures.push({ code: scans[index].code, label: scans[index].label });
    }
  });
  return { alerts, failures, complete: failures.length === 0 };
}
