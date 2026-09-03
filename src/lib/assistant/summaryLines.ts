/**
 * The business summary's presentation table — Hebrew label, unit and navigation route for each
 * of the five metric keys returned by `p2_business_summary_rows()` (0165).
 *
 * Split out of `summary.ts` for the same reason `errorCodes.ts` exists: `summary.ts` imports the
 * Supabase browser client, which the assistant Edge function can never load. The metric VALUES
 * have exactly one definition, in SQL (0165); this file is the one definition of their WORDING —
 * consumed by `summary.ts` for the /alerts screen and by `supabase/functions/assistant` for the
 * `get_business_summary` tool, so a number can never reach one consumer carrying a name the
 * other does not know. `summary.spec.ts` fails the build if this table and the migration's
 * metric keys drift apart in either direction.
 *
 * This file must stay dependency-free: any import added here lands in both runtimes.
 * Relative imports of this file must spell the `.ts` extension — Deno cannot resolve an
 * extension-less path, and `allowImportingTsExtensions` is on for exactly this reason.
 */
// A TYPE import, erased at build time, so the dependency-free rule above still holds in both
// runtimes. It is what makes a wrong key a compile error rather than a sentence on a screen.
import type { TKey } from '../i18n/t.ts';

export type SummaryUnit = 'count' | 'currency';

export interface SummaryMetricLine {
  key: string;
  /**
   * The dictionary key for the line's wording. Named `labelKey`, not `label`, because a `TKey` is
   * a string: the previous shape let both consumers print whatever this field held, and the field
   * held Hebrew. `/alerts` already fell through to it raw, so an English reader was told which
   * scan had failed in Hebrew.
   */
  labelKey: TKey;
  /**
   * What the wording interpolates. It travels beside the key rather than being baked into a
   * sentence, so the trailing windows below still have exactly one definition each.
   */
  labelVars?: Record<string, string | number>;
  unit: SummaryUnit;
  /** In-app route where the figure can be inspected — the claim's evidence trail. */
  to: string;
  /**
   * The screen STATE that reproduces this metric's population exactly, or `null` when no state of
   * any existing screen does.
   *
   * Split from `to` on purpose, because the two are asked to do different jobs. `to` is
   * navigation: /alerts puts it behind a line so a reader can go and work on the subject. This
   * one is evidence: the assistant issues it as a source, and a source is a promise that the
   * reader will find the claim there. `/prices` under "5 suppliers raised a price in the last 30
   * days" is a fine place to go and a false promise to keep — the screen holds every price the
   * business has, and the count is a bounded question about a fraction of them.
   *
   * `null` therefore means "this figure cannot be shown to you anywhere as itself", and the
   * consumer must say nothing rather than pointing at the nearest screen. Two of the five are
   * null today and both are named at the entry.
   */
  evidenceRoute: string | null;
}

// Label text only — the trailing windows themselves are defined in 0165 and proven by
// p57_business_summary_parity.sql, so a window change there must update these labels too.
const WEEK_DAYS = 7;
const PRICE_INCREASE_WINDOW_DAYS = 30;

/**
 * Order is the /alerts display order. `awaiting_approval` reads invoices.review_status
 * literally, because the line says "חשבוניות" — the divergence from Dashboard.tsx's own card is
 * open decision #1 in docs/OPEN-DECISIONS.md, documented at the definition (0165).
 */
export const SUMMARY_METRIC_LINES: readonly SummaryMetricLine[] = [
  // No screen state narrows the invoice list to a TRAILING SEVEN DAYS on `received_date`. The
  // month picker there reads `invoice_date`, which is a different column and a different period —
  // an invoice dated the 28th and received on the 2nd belongs to this metric and not to that
  // month, and the reverse. So: navigable, not citable.
  { key: 'received_week', labelKey: 'businessSummary.receivedWeek', labelVars: { days: WEEK_DAYS }, unit: 'count', to: '/invoices', evidenceRoute: null },
  { key: 'awaiting_approval', labelKey: 'businessSummary.awaitingApproval', unit: 'count', to: '/invoices', evidenceRoute: '/invoices?review=pending_approval' },
  // `p2_active_payment_request_total_by_currency` sums `draft, pending_approval, approved,
  // sent_for_execution`. The screen's own `status=active` is "not matched, cancelled or
  // executed", which ALSO holds `investigation` and `suspected_duplicate` — two statuses this
  // total leaves out, so an answer reading "nothing is open" could send the reader to a screen
  // holding money. The set is named in the URL instead, and offered in that screen's dropdown.
  { key: 'expected_payments', labelKey: 'businessSummary.expectedPayments', unit: 'currency', to: '/payment-requests', evidenceRoute: '/payment-requests?status=draft,pending_approval,approved,sent_for_execution' },
  // `p2_suppliers_with_price_increase_since(today - 30)`, and `?days=30` is that window on the
  // screen. Without it `?increases=1` answers a question with no clock in it.
  { key: 'suppliers_raised', labelKey: 'businessSummary.suppliersRaised', labelVars: { days: PRICE_INCREASE_WINDOW_DAYS }, unit: 'count', to: '/prices', evidenceRoute: '/prices?increases=1&days=30' },
  // `status in ('open','in_progress')` on both sides: the metric's own filter, and what
  // `?status=open` means on that screen.
  { key: 'open_exceptions', labelKey: 'businessSummary.openExceptions', unit: 'count', to: '/exceptions', evidenceRoute: '/exceptions?status=open' },
];

/* ---------------------------------------------------------------------------
 * The three readings of a money metric — one definition, two consumers
 * -------------------------------------------------------------------------*/

/**
 * `p2_business_summary_rows_by_currency()` answers a money metric in one of THREE ways, and until
 * 03.09.2026 both readers collapsed two of them into one.
 *
 * Metric 3 of `0219` returns a deliberately CURRENCY-LESS measured zero when nothing is owed,
 * because "nothing is owed" is true in every currency at once. Each reader then kept its own copy
 * of the same `/^[A-Z]{3}$/` filter — `summary.ts` and `assistant/tools/business-summary.ts` —
 * dropped that row, and reported the metric as one that could not be measured. The result was a
 * red bar over a perfectly healthy organisation on `/alerts` and a partial answer in the
 * assistant: *nothing is owed* read exactly like *we could not find out what is owed*.
 *
 * The filter was never the bug; the SECOND COPY of it was. There is one reading function now, and
 * it lives here beside the wording table both consumers already share, for the same reason that
 * table does — a metric cannot reach one consumer meaning something the other does not know.
 */

/** Upper-case ISO-4217, as the RPC returns it. The lower-case form is a FACT unit, not this. */
const ISO_CURRENCY_CODE = /^[A-Z]{3}$/;

/**
 * The row shape both readers hand in. Structural rather than shared-by-import: the browser row and
 * the Edge row are declared in their own modules and neither should have to import the other.
 */
export interface SummaryMetricRowLike {
  value: number | string | null;
  measured: boolean;
  currency: string | null;
}

export type SummaryCurrencyRow = SummaryMetricRowLike & { currency: string };

export type SummaryCurrencyReading =
  /** Real obligations: one row per currency, ordered, never summed across them. */
  | { state: 'measured'; rows: SummaryCurrencyRow[] }
  /** Measured, and there is positively nothing open. A SENTENCE, not a figure — decision F. */
  | { state: 'absent' }
  /** We could not measure. The named failure, and the only one of the three that is one. */
  | { state: 'unmeasured' };

export function readCurrencyMetric(
  rows: readonly SummaryMetricRowLike[],
): SummaryCurrencyReading {
  const byCurrency = rows
    .filter((row): row is SummaryCurrencyRow =>
      typeof row.currency === 'string' && ISO_CURRENCY_CODE.test(row.currency))
    .sort((a, b) => a.currency.localeCompare(b.currency));
  if (byCurrency.length > 0) return { state: 'measured', rows: byCurrency };

  const unpriced = rows.find((row) => row.currency == null);
  // A MEASURED ZERO with no currency on it is the RPC stating that nothing is owed. Anything else
  // without a currency is not something this product may state: a non-zero amount whose currency
  // is unknown is not a measurement, and naming a currency for it would be exactly the invention
  // the money rules exist to prevent. `value == null` is caught first because `Number(null)` is 0.
  if (unpriced && unpriced.measured && unpriced.value != null && Number(unpriced.value) === 0) {
    return { state: 'absent' };
  }
  return { state: 'unmeasured' };
}

/**
 * What a measured absence SAYS, per metric (decision F, owner 03.09.2026).
 *
 * Not `—`: this product reserves the em dash for UNKNOWN, and "nothing is owed" is something we
 * positively know. Not `0 ILS` either — that asserts something about one currency while saying
 * nothing at all about the others. It is a sentence, and no figure beside it.
 *
 * A currency metric with no entry here has no sanctioned wording, and both readers say so as a
 * named miss rather than writing a sentence of their own.
 */
export const SUMMARY_ABSENCE_KEYS: Readonly<Record<string, TKey>> = {
  expected_payments: 'businessSummary.expectedPaymentsNone',
};
