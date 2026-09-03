// get_business_summary -- the section-10 business summary, server-side.
//
// Since 0165 the metric DEFINITIONS live in SQL. Since 0219 the public reader is
// p2_business_summary_rows_by_currency(), SECURITY
// INVOKER, STABLE, granted to authenticated -- because the summary has two consumers: the screen
// (src/lib/summary.ts) and this tool. One server-side definition is the only arrangement under
// which they cannot silently diverge. The RPC returns (metric_key, value, measured) and wraps
// each metric in its own exception block, so a failed metric arrives as measured:false and never
// blanks its four neighbours -- a partial envelope is normal and must be reported as partial.
//
// The Hebrew labels, units and routes come from src/lib/assistant/summaryLines.ts -- the same
// dependency-free table the /alerts screen renders, imported here directly so a metric can never
// reach one consumer carrying a name the other does not know. Since 03.09.2026 the same module
// also owns the READING of a money metric (readCurrencyMetric): this file and src/lib/summary.ts
// each kept a private copy of the `/^[A-Z]{3}$/` filter, both dropped the RPC's deliberate
// currency-less measured zero, and both then reported "nothing is owed" as "we could not measure".
import { z } from "zod";
import type {
  Fact,
  FactKind,
  SourceReference,
  ToolEnvelope,
} from "../../../../src/lib/assistant/contracts.ts";
import {
  readCurrencyMetric,
  SUMMARY_ABSENCE_KEYS,
  SUMMARY_METRIC_LINES,
  type SummaryMetricRowLike,
} from "../../../../src/lib/assistant/summaryLines.ts";
import { readerText } from "../reader-locale.ts";
import type { AssistantTool, ToolContext } from "./registry.ts";

// The trailing windows are defined in 0165 (and echoed by the labels in summaryLines.ts); these
// literals only state the envelope's own scope in `filters`.
const WEEK_DAYS = 7;
const PRICE_INCREASE_WINDOW_DAYS = 30;

interface SummaryMetricRow {
  metric_key: string;
  value: number | string | null;
  measured: boolean;
  currency: string | null;
}

function metricRows(data: unknown): SummaryMetricRow[] {
  const rows: SummaryMetricRow[] = [];
  if (!Array.isArray(data)) return rows;
  for (const raw of data) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.metric_key !== "string") continue;
    rows.push({
      metric_key: row.metric_key,
      value: row.value as number | string | null,
      measured: row.measured === true,
      currency: typeof row.currency === "string" ? row.currency : null,
    });
  }
  return rows;
}

/** Same guard summary.ts applies: PostgREST may serialize numeric as a string, so coerce with
 * Number(); a non-finite or negative figure is no figure. */
function metricValue(row: SummaryMetricRowLike | undefined): number | null {
  if (!row || !row.measured || row.value == null) return null;
  const value = Number(row.value);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * What a STATED ABSENCE is a fact about (decision F, owner 03.09.2026).
 *
 * Deliberately a status kind and never `payment_request.total`: the currency-less measured zero
 * must not become a money fact, so `contracts.ts` is left exactly as it is — no widened unit, no
 * `count` (which would be a different lie: nothing is owed is not "zero of something counted"),
 * and no invented currency. The fact's VALUE is the sentence and its unit is `text`, so every
 * surface that renders it prints words where a figure would otherwise have gone. `unit: "text"`
 * also keeps it out of `factValueText`'s money branch in AnswerView.tsx, which formats a
 * three-letter unit as currency.
 *
 * A currency metric present in SUMMARY_ABSENCE_KEYS but missing here — or the reverse — cannot be
 * stated, and the tool names the miss instead of guessing at either half.
 */
const ABSENCE_FACT_KIND: Record<string, FactKind> = {
  expected_payments: "payment_request.status",
};

export const getBusinessSummaryTool: AssistantTool = {
  name: "get_business_summary",
  description:
    "מחזיר את הסיכום העסקי של הארגון: חשבוניות שנקלטו השבוע, חשבוניות הממתינות לאישור, " +
    "סכום פתוח בדרישות תשלום, ספקים שהעלו מחיר וחריגים פתוחים. " +
    "ערך שלא נמדד מסומן ככזה ואינו אפס. " +
    "כשאין כלל התחייבות פתוחה מוחזר משפט במקום סכום — זו תשובה מלאה, לא מדידה חסרה.",
  inputSchema: z.object({}).strict(),
  inputJsonSchema: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  requiredRoles: ["owner", "office"],
  classification: "financial_sensitive",
  async run(ctx: ToolContext): Promise<ToolEnvelope> {
    const asOf = ctx.now().toISOString();
    const result = await ctx.db.rpc("p2_business_summary_rows_by_currency");
    // An RPC failure means every metric is unknown -- five named failures, never a blank sheet
    // and never a fabricated one.
    const rows = result.error
      ? []
      : metricRows(result.data);

    const facts: Fact[] = [];
    const sources: SourceReference[] = [];
    const failures: { code: string; label: string }[] = [];
    for (const line of SUMMARY_METRIC_LINES) {
      const matching = rows.filter((row) => row.metric_key === line.key);
      const lineLabel = readerText(ctx.locale, line.labelKey, line.labelVars);
      let selected: SummaryMetricRowLike[];
      if (line.unit === "currency") {
        // The one reading of a money metric, shared with /alerts (src/lib/assistant/summaryLines.ts).
        const reading = readCurrencyMetric(matching);
        if (reading.state === "absent") {
          // Decision F: nothing is owed is a SENTENCE, not a number — and emphatically not a
          // failure. This branch is the whole repair: until 03.09.2026 the currency-less measured
          // zero was filtered out here, `complete` went false, and AnswerView painted the answer
          // as partial. We measured, the answer is "none", and it says so in words.
          const absenceKey = SUMMARY_ABSENCE_KEYS[line.key];
          const absenceKind = ABSENCE_FACT_KIND[line.key];
          if (!absenceKey || !absenceKind) {
            failures.push({ code: `${line.key}:unstated_absence`, label: lineLabel });
            continue;
          }
          facts.push(ctx.evidence.fact({
            kind: absenceKind,
            subject: null,
            label: lineLabel,
            value: readerText(ctx.locale, absenceKey),
            unit: "text",
            tool: "get_business_summary",
            as_of: asOf,
            classification: "financial_sensitive",
          }));
          sources.push(ctx.evidence.source({
            entity: "organization",
            entity_id: ctx.actor.orgId,
            label: lineLabel,
            route: line.to,
            classification: "tenant_standard",
          }));
          continue;
        }
        selected = reading.state === "measured" ? reading.rows : [];
      } else {
        selected = [matching.find((row) => row.currency == null) ?? matching[0]].filter(Boolean) as SummaryMetricRowLike[];
      }
      if (selected.length === 0) {
        failures.push({ code: line.key, label: lineLabel });
        // Counts still have a truthful unit when the whole RPC failed, so retain their null facts:
        // the model may say they were not measured but can never turn them into zero. A missing
        // money row has no currency to attach to it, and inventing ILS would violate the contract
        // this reader exists to enforce, so that one remains a named failure without a fact.
        if (line.unit !== "currency") {
          facts.push(ctx.evidence.fact({
            kind: "metric.count",
            subject: null,
            label: lineLabel,
            value: null,
            unit: "count",
            tool: "get_business_summary",
            as_of: asOf,
            classification: "tenant_standard",
          }));
          sources.push(ctx.evidence.source({
            entity: "organization",
            entity_id: ctx.actor.orgId,
            label: lineLabel,
            route: line.to,
            classification: "tenant_standard",
          }));
        }
        continue;
      }
      for (const row of selected) {
        const value = metricValue(row);
        const currency = line.unit === "currency" ? row.currency : null;
        const label = currency ? `${lineLabel} (${currency})` : lineLabel;
        if (value === null) failures.push({ code: currency ? `${line.key}:${currency}` : line.key, label });
        facts.push(ctx.evidence.fact({
          kind: line.unit === "currency" ? "metric.money" : "metric.count",
          subject: null,
          label,
          value,
          unit: currency ? currency.toLowerCase() : "count",
          tool: "get_business_summary",
          as_of: asOf,
          classification: line.unit === "currency"
            ? "financial_sensitive"
            : "tenant_standard",
        }));
        sources.push(ctx.evidence.source({
          entity: "organization",
          entity_id: ctx.actor.orgId,
          label,
          route: line.to,
          classification: "tenant_standard",
        }));
      }
    }

    return {
      data: [],
      complete: failures.length === 0,
      failures,
      filters: {
        week_days: WEEK_DAYS,
        price_increase_window_days: PRICE_INCREASE_WINDOW_DAYS,
      },
      as_of: asOf,
      result_count: facts.length,
      has_more: false,
      facts,
      sources,
      warnings: [],
    };
  },
};
