// Tool 7b -- get_payment_exposure: the paymentRequests block of the dashboard snapshot (0100 +
// 0148's due-window money). The exposure covers ONLY payment requests that carry a due date --
// a large share have none -- so dueDateCoverage out of activeCount always travels with the
// answer, and a null means no dated request existed to measure, never zero shekels.
import { z } from "zod";
import type { Fact } from "../../../../src/lib/assistant/contracts.ts";
import { fetchDashboardSnapshot } from "./dashboardSnapshot.ts";
import type { AssistantTool, ToolContext } from "./registry.ts";
import { readerText } from "../reader-locale.ts";
import { EMPTY_OBJECT_JSON_SCHEMA, num, record } from "./shared.ts";

const inputSchema = z.object({}).strict();

export const getPaymentExposure: AssistantTool = {
  name: "get_payment_exposure",
  description:
    "חשיפת תשלומים לפי תאריכי יעד: כמה כסף בדרישות תשלום פעילות שמועדן כבר עבר, וכמה נופל " +
    "בשבעת הימים הקרובים — נמדד אך ורק על דרישות שהוזן להן תאריך יעד. חלק ניכר מהדרישות ללא " +
    "תאריך, ולכן זו אינה החשיפה הכוללת: הכיסוי (כמה מהדרישות הפעילות מתוארכות) מוחזר תמיד לצד " +
    "הסכומים. null פירושו שאין אף דרישה מתוארכת למדוד — לא אפס.",
  inputSchema,
  inputJsonSchema: EMPTY_OBJECT_JSON_SCHEMA,
  requiredRoles: ["owner", "office"],
  classification: "financial_sensitive",
  async run(ctx: ToolContext, input: unknown) {
    inputSchema.parse(input);
    const asOf = ctx.now().toISOString();
    const fetched = await fetchDashboardSnapshot(ctx);
    if (fetched.failed || !fetched.snapshot) return fetched.failed!;
    const block = record(fetched.snapshot.paymentRequests) ?? {};
    const filters = { business_date: fetched.businessDate };

    const values = {
      activeCount: num(block.activeCount),
      dueDateCoverage: num(block.dueDateCoverage),
      overdue: num(block.overdue),
      overdueAmount: num(block.overdueAmount),
      dueToday: num(block.dueToday),
      dueWithin7Count: num(block.dueWithin7Count),
      dueWithin7Amount: num(block.dueWithin7Amount),
      pendingApproval: num(block.pendingApproval),
    };

    const facts: Fact[] = [];
    const fact = (
      label: string,
      value: number | null,
      unit: "ils" | "count",
    ) => {
      facts.push(ctx.evidence.fact({
        kind: unit === "ils" ? "metric.money" : "metric.count",
        subject: null,
        label,
        value,
        unit,
        tool: getPaymentExposure.name,
        as_of: asOf,
        classification: unit === "ils" ? "financial_sensitive" : "tenant_standard",
      }));
    };
    fact(readerText(ctx.locale, "assistantTools.exposureActiveRequests"), values.activeCount, "count");
    fact(
      readerText(ctx.locale, "assistantTools.exposureDatedCoverage"),
      values.dueDateCoverage,
      "count",
    );
    fact(
      readerText(ctx.locale, "assistantTools.exposureOverdueAmount"),
      values.overdueAmount,
      "ils",
    );
    fact(readerText(ctx.locale, "assistantTools.exposureOverdueCount"), values.overdue, "count");
    fact(readerText(ctx.locale, "assistantTools.exposureDueToday"), values.dueToday, "count");
    fact(
      readerText(ctx.locale, "assistantTools.exposureDueWithin7Amount"),
      values.dueWithin7Amount,
      "ils",
    );
    fact(
      readerText(ctx.locale, "assistantTools.exposureDueWithin7Count"),
      values.dueWithin7Count,
      "count",
    );
    fact(readerText(ctx.locale, "assistantTools.exposurePendingApproval"), values.pendingApproval, "count");

    const source = ctx.evidence.source({
      entity: "organization",
      entity_id: ctx.actor.orgId,
      label: readerText(ctx.locale, "assistantTools.exposureScreen"),
      route: "/payment-requests",
      classification: "financial_sensitive",
    });

    const undatedKnown = values.activeCount !== null &&
      values.dueDateCoverage !== null;
    const warnings = [
      undatedKnown && values.activeCount! > values.dueDateCoverage!
        ? readerText(ctx.locale, "assistantTools.exposureUndatedWarning")
        : "מדדי החשיפה נמדדים רק על דרישות עם תאריך יעד.",
    ];

    return {
      data: [values],
      complete: true,
      failures: [],
      filters,
      as_of: asOf,
      result_count: 1,
      has_more: false,
      facts,
      sources: [source],
      warnings,
    };
  },
};
