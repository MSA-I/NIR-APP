import { supabase } from './supabase';
import { scanAlerts, type Alert } from './alerts';
import { SUMMARY_METRIC_LINES, type SummaryUnit } from './assistant/summaryLines.ts';
import type { TKey } from './i18n/t';

/**
 * Business summary (סעיף 10).
 *
 * The client asked for an "AI Assistant" that answers, at a button press: how many invoices
 * came in this week, what is awaiting approval, what payments are expected, which suppliers
 * raised prices, which exceptions need attention, and what to do about it.
 *
 * Every one of those is a query. The original spec also lists "Advanced AI recommendations"
 * as explicitly out of MVP scope, so this is deliberately a plain data function — no model,
 * no API key, no per-call cost. The "recommendations" line is the alert scan, which is the
 * honest version of the same idea: conditions that actually hold, not generated prose.
 *
 * Since 0165 the METRIC DEFINITIONS live in SQL — `p2_business_summary_rows()` — because the
 * summary now has two consumers: this screen and the assistant tool `get_business_summary`.
 * One server-side definition is the only arrangement under which they cannot silently
 * diverge; this module keeps the labels, routes and the null-vs-zero discipline, and
 * `summary.spec.ts` fails the build if a direct table query for these metrics ever returns
 * here. The per-metric failure isolation that Promise.allSettled used to provide is now the
 * function's own exception blocks: a failed metric arrives as `measured: false` and never
 * blanks its four neighbours.
 *
 * ponytail: swap in a language model only when the questions stop being countable.
 */

export type { SummaryUnit } from './assistant/summaryLines.ts';

export interface SummaryLine {
  key: string;
  labelKey: TKey;
  labelVars?: Record<string, string | number>;
  /** null means "no data behind this figure" and must render as `—`. Zero is a real zero. */
  value: number | null;
  unit: SummaryUnit;
  /** Money lines carry their ISO code; counts carry null. */
  currency: string | null;
  to: string;
}

// The wording, unit and route per metric live in ./assistant/summaryLines.ts — a dependency-free
// module, because the assistant Edge function consumes the same table and cannot import this
// file (it pulls in the Supabase browser client).

interface SummaryMetricRow {
  metric_key: string;
  value: number | string | null;
  measured: boolean;
  currency: string | null;
}

/** One round-trip for all five metrics. null means the call itself failed — every metric is unknown. */
async function fetchMetricRows(): Promise<SummaryMetricRow[] | null> {
  const { data, error } = await supabase.rpc('p2_business_summary_rows_by_currency');
  if (error || !Array.isArray(data)) return null;
  return data as SummaryMetricRow[];
}

/** Same guard the per-metric rpcNumber applied: a non-finite or negative figure is no figure. */
function metricValue(row: SummaryMetricRow | undefined): number | null {
  if (!row || !row.measured || row.value == null) return null;
  const value = Number(row.value);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export interface Summary {
  lines: SummaryLine[];
  alerts: Alert[];
  complete: boolean;
  failures: SummaryFailure[];
  generatedAt: Date;
}

/**
 * A scan or metric that could not be measured, named so a reader knows what the answer is missing.
 *
 * Both halves carry a KEY. The alert scans always did; the metric lines pushed their Hebrew
 * SENTENCE into a field called `labelKey`, and `/alerts` renders it with `tDynamic(key) ?? key` —
 * so the miss fell through to the raw Hebrew and the field's name hid it. It read correctly in
 * Hebrew, which is why nothing caught it.
 */
export interface SummaryFailure {
  code: string;
  labelKey: TKey;
  labelVars?: Record<string, string | number>;
  /** Present when the failure is one currency's row of a money metric. */
  currency?: string;
}

export async function buildSummary(): Promise<Summary> {
  const [rows, alertScan] = await Promise.all([fetchMetricRows(), scanAlerts()]);
  const failures: SummaryFailure[] = [...alertScan.failures];
  const lines = SUMMARY_METRIC_LINES.flatMap((definition): SummaryLine[] => {
    const matching = rows?.filter((row) => row.metric_key === definition.key) ?? [];
    if (definition.unit === 'currency') {
      const currencyRows = matching
        .filter((row): row is SummaryMetricRow & { currency: string } =>
          typeof row.currency === 'string' && /^[A-Z]{3}$/.test(row.currency))
        .sort((a, b) => a.currency.localeCompare(b.currency));
      if (currencyRows.length === 0) {
        failures.push({ code: definition.key, labelKey: definition.labelKey, labelVars: definition.labelVars });
        return [{ ...definition, value: null, currency: null }];
      }
      return currencyRows.map((row) => {
        const value = metricValue(row);
        if (value == null) failures.push({
          code: `${definition.key}:${row.currency}`,
          labelKey: definition.labelKey,
          labelVars: definition.labelVars,
          currency: row.currency,
        });
        return { ...definition, value, currency: row.currency };
      });
    }
    const value = metricValue(matching.find((row) => row.currency == null) ?? matching[0]);
    if (value == null) {
      failures.push({ code: definition.key, labelKey: definition.labelKey, labelVars: definition.labelVars });
    }
    return [{ ...definition, value, currency: null }];
  });

  return { lines, alerts: alertScan.alerts, complete: failures.length === 0, failures, generatedAt: new Date() };
}
