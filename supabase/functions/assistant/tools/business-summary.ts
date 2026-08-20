// get_business_summary -- the section-10 business summary, server-side.
//
// Since 0165 the metric DEFINITIONS live in SQL -- public.p2_business_summary_rows(), SECURITY
// INVOKER, STABLE, granted to authenticated -- because the summary has two consumers: the screen
// (src/lib/summary.ts) and this tool. One server-side definition is the only arrangement under
// which they cannot silently diverge. The RPC returns (metric_key, value, measured) and wraps
// each metric in its own exception block, so a failed metric arrives as measured:false and never
// blanks its four neighbours -- a partial envelope is normal and must be reported as partial.
//
// The Hebrew labels, units and routes come from src/lib/assistant/summaryLines.ts -- the same
// dependency-free table the /alerts screen renders, imported here directly so a metric can never
// reach one consumer carrying a name the other does not know.
import { z } from "zod";
import type {
  Fact,
  SourceReference,
  ToolEnvelope,
} from "../../../../src/lib/assistant/contracts.ts";
import { SUMMARY_METRIC_LINES } from "../../../../src/lib/assistant/summaryLines.ts";
import type { AssistantTool, ToolContext } from "./registry.ts";

// The trailing windows are defined in 0165 (and echoed by the labels in summaryLines.ts); these
// literals only state the envelope's own scope in `filters`.
const WEEK_DAYS = 7;
const PRICE_INCREASE_WINDOW_DAYS = 30;

interface SummaryMetricRow {
  metric_key: string;
  value: number | string | null;
  measured: boolean;
}

function metricRows(data: unknown): Map<string, SummaryMetricRow> {
  const rows = new Map<string, SummaryMetricRow>();
  if (!Array.isArray(data)) return rows;
  for (const raw of data) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.metric_key !== "string") continue;
    rows.set(row.metric_key, {
      metric_key: row.metric_key,
      value: row.value as number | string | null,
      measured: row.measured === true,
    });
  }
  return rows;
}

/** Same guard summary.ts applies: PostgREST may serialize numeric as a string, so coerce with
 * Number(); a non-finite or negative figure is no figure. */
function metricValue(row: SummaryMetricRow | undefined): number | null {
  if (!row || !row.measured || row.value == null) return null;
  const value = Number(row.value);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export const getBusinessSummaryTool: AssistantTool = {
  name: "get_business_summary",
  description:
    "מחזיר את הסיכום העסקי של הארגון: חשבוניות שנקלטו השבוע, חשבוניות הממתינות לאישור, " +
    "סכום פתוח בדרישות תשלום, ספקים שהעלו מחיר וחריגים פתוחים. " +
    "ערך שלא נמדד מסומן ככזה ואינו אפס.",
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
    const result = await ctx.db.rpc("p2_business_summary_rows");
    // An RPC failure means every metric is unknown -- five named failures, never a blank sheet
    // and never a fabricated one.
    const rows = result.error
      ? new Map<string, SummaryMetricRow>()
      : metricRows(result.data);

    const facts: Fact[] = [];
    const sources: SourceReference[] = [];
    const failures: { code: string; label: string }[] = [];
    for (const line of SUMMARY_METRIC_LINES) {
      const value = metricValue(rows.get(line.key));
      if (value === null) {
        // measured:false, a missing row and a non-finite value are all the same honest answer:
        // unmeasured. The fact still exists with value null so the model can SAY the line is
        // unmeasured -- it can never turn it into a number (validate.ts).
        failures.push({ code: line.key, label: line.label });
      }
      facts.push(ctx.evidence.fact({
        kind: line.unit === "currency" ? "metric.money" : "metric.count",
        subject: null,
        label: line.label,
        value,
        unit: line.unit === "currency" ? "ils" : "count",
        tool: "get_business_summary",
        as_of: asOf,
        classification: line.unit === "currency"
          ? "financial_sensitive"
          : "tenant_standard",
      }));
      sources.push(ctx.evidence.source({
        entity: "organization",
        entity_id: ctx.actor.orgId,
        label: line.label,
        route: line.to,
        classification: "tenant_standard",
      }));
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
