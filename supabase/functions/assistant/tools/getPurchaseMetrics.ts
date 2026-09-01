// Tool 4 -- get_purchase_metrics: the canonical purchase-money figures for a trailing window,
// from public.get_purchase_metrics(p_from, p_to) (0113; live gross reader carries 0137's payable
// fence). The window anchors on the current business day in Asia/Jerusalem and uses the product's
// own trailing definition (0165: `>= today - N`). Committed and gross are never netted against
// each other, and gross buckets by invoice_date -- the day the supplier billed, not intake day.
import { z } from "zod";
import {
  type Fact,
  TIME_WINDOW_DAYS,
  TIME_WINDOW_LABEL_KEYS,
  TIME_WINDOWS,
} from "../../../../src/lib/assistant/contracts.ts";
import { addCalendarDays, toZoneISO } from "../time.ts";
import { readerText } from "../reader-locale.ts";
import type { AssistantTool, ToolContext } from "./registry.ts";
import { failure, num, record } from "./shared.ts";

const inputSchema = z
  .object({
    window: z.enum(TIME_WINDOWS).nullish().transform((value) => value ?? "last_30_days"),
  })
  .strict();

export const getPurchaseMetrics: AssistantTool = {
  name: "get_purchase_metrics",
  description:
    "מדדי הרכש הקנוניים לחלון נגרר (7/30/90 יום אחורה מהיום העסקי): התחייבות — הזמנות שאינן " +
    "טיוטה ולא בוטלו, במחירי הרגע שבו הוזמנו, לפי יום היצירה העסקי; הוצאה ברוטו — חשבוניות ספק " +
    "מאושרות בלבד, לפי תאריך החשבונית (מתי הספק חייב) ולא לפי מועד הקליטה; זיכויים שהוכרו — " +
    "offset/closed בלבד; זיכויים ממתינים בנפרד; ונטו = ברוטו פחות זיכויים שהוכרו. " +
    "ערך שמקורו ריק מוחזר null, לא אפס. התחייבות והוצאה הם שני מובנים שונים ואין לחבר אותם.",
  inputSchema,
  inputJsonSchema: {
    type: "object",
    properties: {
      window: {
        anyOf: [
          { type: "string", enum: [...TIME_WINDOWS] },
          { type: "null" },
        ],
        description: "החלון הנגרר למדידה, או null לברירת המחדל (30 הימים האחרונים)",
      },
    },
    required: ["window"],
    additionalProperties: false,
  },
  requiredRoles: ["owner", "office", "accountant"],
  classification: "financial_sensitive",
  async run(ctx: ToolContext, input: unknown) {
    const { window } = inputSchema.parse(input);
    const asOf = ctx.now().toISOString();
    const to = toZoneISO(ctx.now());
    const from = addCalendarDays(to, -TIME_WINDOW_DAYS[window]);
    // Resolved in the run's language: this label is appended to a fact label a PERSON reads,
    // so a Hebrew constant here would put Hebrew inside an English answer.
    const windowLabel = readerText(ctx.locale, TIME_WINDOW_LABEL_KEYS[window]);
    const filters: Record<string, string | number | boolean | null> = {
      window,
      from,
      to,
      time_zone: "Asia/Jerusalem",
    };

    const result = await ctx.db.rpc("get_purchase_metrics", {
      p_from: from,
      p_to: to,
    });
    if (result.error) {
      const message = result.error.message ?? "";
      if (message.includes("not_authorized")) {
        return failure(ctx, "not_permitted", readerText(ctx.locale, "assistantTools.purchaseMetricsNotPermitted"), filters);
      }
      return failure(ctx, "purchase_metrics_failed", readerText(ctx.locale, "assistantTools.purchaseMetricsFetchFailed"), filters);
    }
    const metrics = record(result.data);
    if (!metrics) {
      return failure(
        ctx,
        "purchase_metrics_malformed",
        readerText(ctx.locale, "assistantTools.purchaseMetricsBadShape"),
        filters,
      );
    }
    // OPEN-DECISIONS #147: the product's own definition of "net" is RELAYED, never restated.
    // The RPC names it; the answer quotes it from here rather than the model composing one.
    const netDefinition = typeof metrics.net_definition === "string"
      ? metrics.net_definition
      : null;
    filters.net_definition = netDefinition;

    const facts: Fact[] = [];
    const money = (key: string, label: string) => {
      facts.push(ctx.evidence.fact({
        kind: "metric.money",
        subject: null,
        label: `${label} — ${windowLabel}`,
        value: num(metrics[key]),
        unit: "ils",
        tool: getPurchaseMetrics.name,
        as_of: asOf,
        classification: "financial_sensitive",
      }));
    };
    const count = (key: string, label: string) => {
      facts.push(ctx.evidence.fact({
        kind: "metric.count",
        subject: null,
        label: `${label} — ${windowLabel}`,
        value: num(metrics[key]),
        unit: "count",
        tool: getPurchaseMetrics.name,
        as_of: asOf,
        classification: "tenant_standard",
      }));
    };
    money("committed", readerText(ctx.locale, "assistantTools.purchaseCommitted"));
    count("committed_order_count", readerText(ctx.locale, "assistantTools.purchaseCommittedOrderCount"));
    money("gross_expense", readerText(ctx.locale, "assistantTools.purchaseGrossExpense"));
    count("gross_invoice_count", readerText(ctx.locale, "assistantTools.purchaseGrossInvoiceCount"));
    money("credits_recognised", readerText(ctx.locale, "assistantTools.purchaseCreditsRecognised"));
    money("credits_pending", readerText(ctx.locale, "assistantTools.purchaseCreditsPending"));
    money("net_expense", readerText(ctx.locale, "assistantTools.purchaseNetExpense"));

    // /expenses is an owner+accountant route; office reads these same figures on the dashboard.
    // A source must point at a screen its reader can actually open.
    const officeActor = ctx.actor.role === "office";
    const source = ctx.evidence.source({
      entity: "organization",
      entity_id: ctx.actor.orgId,
      label: officeActor
        ? readerText(ctx.locale, "assistantTools.screenControlCentre")
        : readerText(ctx.locale, "assistantTools.screenExpenses"),
      route: officeActor ? "/dashboard" : "/expenses",
      classification: "financial_sensitive",
    });

    return {
      data: [metrics],
      complete: true,
      failures: [],
      filters,
      as_of: asOf,
      result_count: 1,
      has_more: false,
      facts,
      sources: [source],
      warnings: [
        readerText(ctx.locale, "assistantTools.purchaseTwoMeaningsWarning"),
        netDefinition
          ? readerText(ctx.locale, "assistantTools.purchaseNetDefinition", { definition: netDefinition })
          : readerText(ctx.locale, "assistantTools.purchaseNetDefinitionMissing"),
      ],
    };
  },
};
