// Tool 7b -- get_payment_exposure: the paymentRequests block of the dashboard snapshot (0100 +
// 0148's due-window money). The exposure covers ONLY payment requests that carry a due date --
// a large share have none -- so dueDateCoverage out of activeCount always travels with the
// answer, and a null means no dated request existed to measure, never zero shekels.
//
// The money is PER CURRENCY (0218/0221). The live snapshot returns
// `overdueAmountByCurrency` / `dueWithin7AmountByCurrency` as arrays of `{currency, amount}`,
// grouped by the payment request's own currency; the flat `overdueAmount` / `dueWithin7Amount`
// scalars this tool used to read no longer exist. A shekel exposure and a dollar exposure are two
// figures, and this tool emits two facts -- it never adds them and never labels one as the other.
import { z } from "zod";
import type { Fact } from "../../../../src/lib/assistant/contracts.ts";
import { fetchDashboardSnapshot } from "./dashboardSnapshot.ts";
import type { AssistantTool, ToolContext } from "./registry.ts";
import { readerText } from "../reader-locale.ts";
import { currencyUnit, moneyByCurrency } from "./moneyByCurrency.ts";
import { EMPTY_OBJECT_JSON_SCHEMA, num, record } from "./shared.ts";
import type { TKey } from "../../../../src/lib/i18n/t.ts";

const inputSchema = z.object({}).strict();

export const getPaymentExposure: AssistantTool = {
  name: "get_payment_exposure",
  description:
    "חשיפת תשלומים לפי תאריכי יעד: כמה כסף בדרישות תשלום פעילות שמועדן כבר עבר, וכמה נופל " +
    "בשבעת הימים הקרובים — נמדד אך ורק על דרישות שהוזן להן תאריך יעד. חלק ניכר מהדרישות ללא " +
    "תאריך, ולכן זו אינה החשיפה הכוללת: הכיסוי (כמה מהדרישות הפעילות מתוארכות) מוחזר תמיד לצד " +
    "הסכומים. null פירושו שאין אף דרישה מתוארכת למדוד — לא אפס. " +
    "הסכומים מוחזרים שורה לכל מטבע, עם קוד המטבע בתווית וביחידה: חשיפה בשקלים וחשיפה בדולרים " +
    "הן שתי חשיפות ואין לחבר אותן או להמיר ביניהן.",
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
      overdueAmountByCurrency: moneyByCurrency(block.overdueAmountByCurrency)?.rows ?? null,
      dueToday: num(block.dueToday),
      dueWithin7Count: num(block.dueWithin7Count),
      dueWithin7AmountByCurrency: moneyByCurrency(block.dueWithin7AmountByCurrency)?.rows ?? null,
      pendingApproval: num(block.pendingApproval),
    };

    const facts: Fact[] = [];
    const failures: { code: string; label: string }[] = [];
    const count = (label: string, value: number | null) => {
      facts.push(ctx.evidence.fact({
        kind: "metric.count",
        subject: null,
        label,
        value,
        unit: "count",
        tool: getPaymentExposure.name,
        as_of: asOf,
        classification: "tenant_standard",
      }));
    };
    /**
     * One money fact per currency. When the snapshot measured no dated request at all the array
     * is a JSON null and there is no currency to state the exposure in -- so nothing is emitted
     * and the absence is NAMED. `dueDateCoverage` beside it is the measured zero that says why.
     */
    const money = (key: string, labelKey: TKey, raw: unknown) => {
      const label = readerText(ctx.locale, labelKey);
      const parsed = moneyByCurrency(raw);
      if (parsed === null || parsed.rows.length === 0) {
        failures.push({ code: `${key}:not_measured`, label });
        return;
      }
      if (parsed.skipped > 0) failures.push({ code: `${key}:currency_unrecognised`, label });
      for (const row of parsed.rows) {
        facts.push(ctx.evidence.fact({
          kind: "metric.money",
          subject: null,
          label: `${label} (${row.currency})`,
          value: row.amount,
          unit: currencyUnit(row.currency),
          tool: getPaymentExposure.name,
          as_of: asOf,
          classification: "financial_sensitive",
        }));
      }
    };

    count(readerText(ctx.locale, "assistantTools.exposureActiveRequests"), values.activeCount);
    count(
      readerText(ctx.locale, "assistantTools.exposureDatedCoverage"),
      values.dueDateCoverage,
    );
    money(
      "overdueAmountByCurrency",
      "assistantTools.exposureOverdueAmount",
      block.overdueAmountByCurrency,
    );
    count(readerText(ctx.locale, "assistantTools.exposureOverdueCount"), values.overdue);
    count(readerText(ctx.locale, "assistantTools.exposureDueToday"), values.dueToday);
    money(
      "dueWithin7AmountByCurrency",
      "assistantTools.exposureDueWithin7Amount",
      block.dueWithin7AmountByCurrency,
    );
    count(
      readerText(ctx.locale, "assistantTools.exposureDueWithin7Count"),
      values.dueWithin7Count,
    );
    count(readerText(ctx.locale, "assistantTools.exposurePendingApproval"), values.pendingApproval);

    /**
     * One source per WINDOW, not one per screen.
     *
     * The single `/payment-requests` reference this replaces opened the screen's default list —
     * every request that is not finished — under an answer about what is already late or falls
     * inside seven days. A reader following it counted a different population from the one they
     * had just been told about, which is the failure a source exists to prevent.
     *
     * Each route below is the screen state that reproduces its own figure exactly: after the
     * list's `due=overdue` and `due=today` branches were corrected (they kept drafts, which
     * `management_dashboard_snapshot` excludes from every due-date metric), all three due filters
     * measure the same statuses the server does. The plain screen link stays for the two figures
     * it really does isolate — the active count and the coverage beside it, whose definition IS
     * the list's own `status=active`.
     */
    const screenSource = (labelKey: TKey, route: string) =>
      ctx.evidence.source({
        entity: "organization",
        entity_id: ctx.actor.orgId,
        label: readerText(ctx.locale, labelKey),
        route,
        classification: "financial_sensitive",
      });
    const sources = [
      screenSource("assistantTools.exposureScreen", "/payment-requests"),
      screenSource("assistantTools.exposureScreenOverdue", "/payment-requests?due=overdue"),
      screenSource("assistantTools.exposureScreenDueToday", "/payment-requests?due=today"),
      screenSource("assistantTools.exposureScreenDueSoon", "/payment-requests?status=active&due=soon"),
    ];

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
      failures,
      filters,
      as_of: asOf,
      result_count: 1,
      has_more: false,
      facts,
      sources,
      warnings,
    };
  },
};
