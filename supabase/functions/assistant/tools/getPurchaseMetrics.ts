// Tool 4 -- get_purchase_metrics: the canonical purchase-money figures for a trailing window,
// from public.get_purchase_metrics(p_from, p_to) (0113; live gross reader carries 0137's payable
// fence). The window anchors on the current business day in Asia/Jerusalem and uses the product's
// own trailing definition (0165: `>= today - N`). Committed and gross are never netted against
// each other, and gross buckets by invoice_date -- the day the supplier billed, not intake day.
//
// EVERY MONEY FIGURE IS PER CURRENCY (0221). The live body behind the RPC --
// `private.canonical_purchase_metrics(uuid,date,date)`, which is what
// `public.get_purchase_metrics` returns unchanged -- emits `committed_by_currency`,
// `gross_expense_by_currency`, `credits_recognised_by_currency`, `credits_pending_by_currency`
// and `net_expense_by_currency`, each an array of `{currency, amount}` or a JSON null. ALL FIVE
// flat scalars this tool used to read are gone, not just `gross_expense`. Net is gross minus
// recognised credits WITHIN ONE CURRENCY -- a dollar credit does not reduce a shekel bill -- so
// the per-currency rows must survive all the way into the facts.
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
import { currencyUnit, moneyByCurrency } from "./moneyByCurrency.ts";
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
    "offset/closed בלבד; זיכויים ממתינים בנפרד; ונטו = ברוטו פחות זיכויים שהוכרו באותו מטבע. " +
    "ערך שמקורו ריק מוחזר null, לא אפס. התחייבות והוצאה הם שני מובנים שונים ואין לחבר אותם. " +
    "כל סכום מוחזר שורה לכל מטבע, עם קוד המטבע בתווית וביחידה. אין המרה בין מטבעות ואין לחבר " +
    "או להשוות סכומים ממטבעות שונים; מדד שאין לו אף שורת מטבע מוחזר ככשל מוצהר, לא כאפס.",
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
    const failures: { code: string; label: string }[] = [];
    /**
     * One money fact per currency. A null array means the window contained nothing of this kind
     * to measure -- there is no currency in which to state it, so nothing is emitted and the
     * absence is NAMED. `committed_order_count` and `gross_invoice_count` are the measured zeros
     * that say why, and inventing `ils` here is exactly the defect this replaced.
     */
    const money = (key: string, label: string) => {
      const parsed = moneyByCurrency(metrics[key]);
      if (parsed === null || parsed.rows.length === 0) {
        failures.push({ code: `${key}:not_measured`, label: `${label} — ${windowLabel}` });
        return;
      }
      if (parsed.skipped > 0) {
        failures.push({ code: `${key}:currency_unrecognised`, label: `${label} — ${windowLabel}` });
      }
      for (const row of parsed.rows) {
        facts.push(ctx.evidence.fact({
          kind: "metric.money",
          subject: null,
          label: `${label} (${row.currency}) — ${windowLabel}`,
          value: row.amount,
          unit: currencyUnit(row.currency),
          tool: getPurchaseMetrics.name,
          as_of: asOf,
          classification: "financial_sensitive",
        }));
      }
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
    money("committed_by_currency", readerText(ctx.locale, "assistantTools.purchaseCommitted"));
    count("committed_order_count", readerText(ctx.locale, "assistantTools.purchaseCommittedOrderCount"));
    money("gross_expense_by_currency", readerText(ctx.locale, "assistantTools.purchaseGrossExpense"));
    count("gross_invoice_count", readerText(ctx.locale, "assistantTools.purchaseGrossInvoiceCount"));
    money("credits_recognised_by_currency", readerText(ctx.locale, "assistantTools.purchaseCreditsRecognised"));
    money("credits_pending_by_currency", readerText(ctx.locale, "assistantTools.purchaseCreditsPending"));
    money("net_expense_by_currency", readerText(ctx.locale, "assistantTools.purchaseNetExpense"));

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
      failures,
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
