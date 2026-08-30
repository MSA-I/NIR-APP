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
  { key: 'received_week', labelKey: 'businessSummary.receivedWeek', labelVars: { days: WEEK_DAYS }, unit: 'count', to: '/invoices' },
  { key: 'awaiting_approval', labelKey: 'businessSummary.awaitingApproval', unit: 'count', to: '/invoices' },
  { key: 'expected_payments', labelKey: 'businessSummary.expectedPayments', unit: 'currency', to: '/payment-requests' },
  { key: 'suppliers_raised', labelKey: 'businessSummary.suppliersRaised', labelVars: { days: PRICE_INCREASE_WINDOW_DAYS }, unit: 'count', to: '/prices' },
  { key: 'open_exceptions', labelKey: 'businessSummary.openExceptions', unit: 'count', to: '/exceptions' },
];
