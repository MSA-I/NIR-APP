// One canonical reader for the per-currency money arrays every money read model returns since
// 0218/0221. Three adapters need the identical parse, and three copies of it is how the shapes
// drifted apart the first time -- `getDashboardSnapshot`, `getPaymentExposure` and
// `getPurchaseMetrics` all read through here.
//
// WHAT THE READ MODELS ACTUALLY RETURN (verified against the live bodies, not the migration that
// created them: `pg_get_functiondef('public.management_dashboard_snapshot(date)')` and
// `private.canonical_purchase_metrics(uuid,date,date)`):
//   * a JSON `null` when the guard above the aggregate found nothing to measure at all
//     (`case when <count> > 0 then (...) end` with no `else`), and
//   * otherwise an array of `{currency, amount}` -- one row per currency, ordered with the
//     organisation's own currency first. The order is presentation only; it is never a conversion
//     target and the rows are NEVER added together.
//
// So there are exactly three outcomes a caller must handle, and each one is a different sentence:
// rows (state each currency on its own), no rows (nothing exists to measure in ANY currency --
// the count fact beside it carries that), and a currency this product cannot name (`skipped`,
// reported rather than dropped in silence).
import type { FactUnit } from "../../../../src/lib/assistant/contracts.ts";
import { num, record, str } from "./shared.ts";

export interface CurrencyAmount {
  /** Upper-case ISO-4217, exactly as the database stores it. */
  currency: string;
  /** The amount in that currency. `null` is "not measured" and never becomes zero. */
  amount: number | null;
}

export interface MoneyByCurrency {
  rows: CurrencyAmount[];
  /** Rows discarded because their currency was not a recognisable ISO-4217 code. */
  skipped: number;
}

function currencyCode(value: unknown): string | null {
  const code = str(value);
  return code && /^[A-Z]{3}$/.test(code) ? code : null;
}

/**
 * Lower-case ISO-4217 -- the ONLY shape `FactUnitSchema` accepts for money. A money fact whose
 * unit was chosen by the adapter rather than read from the row is the defect this exists to
 * remove, so this function only ever converts a code that came out of the data.
 */
export function currencyUnit(code: string): FactUnit {
  return code.toLowerCase() as FactUnit;
}

/**
 * Reads one `*ByCurrency` / `*_by_currency` value.
 *
 * Returns `null` when the read model did not measure it (JSON null, or a shape that is not an
 * array). It never substitutes an empty list for a null, and never invents a currency: a caller
 * that receives `null` -- or `rows: []` -- has nothing it is allowed to state as money.
 */
export function moneyByCurrency(value: unknown): MoneyByCurrency | null {
  if (!Array.isArray(value)) return null;
  const rows: CurrencyAmount[] = [];
  let skipped = 0;
  for (const entry of value) {
    const row = record(entry);
    const code = row ? currencyCode(row.currency) : null;
    if (!row || !code) {
      skipped += 1;
      continue;
    }
    rows.push({ currency: code, amount: num(row.amount) });
  }
  return { rows, skipped };
}
