// Tool 5 -- get_supplier_performance: the public.supplier_metrics view (0031:297, kitchen
// stripped by 0133). THE 180-DAY WINDOW IS FIXED IN THE VIEW -- it is stated in the description
// and in every windowed fact label, because a number without its window is a different number.
// on_time_pct is null when otd_samples = 0: not measured, never zero, and the sample size
// travels beside the percentage as its own fact. The tool does not rank; rows are ordered by
// supplier id, and the model orders them by values it can cite.
import { z } from "zod";
import type {
  Fact,
  SourceReference,
} from "../../../../src/lib/assistant/contracts.ts";
import type { AssistantTool, ToolContext } from "./registry.ts";
import { readerText } from "../reader-locale.ts";
import { readsOrNull, READS_UNAVAILABLE } from "./shared.ts";
import {
  failure,
  limitSchema,
  LIMIT_JSON_SCHEMA,
  sanitizeText,
  UNTRUSTED_TEXT_WARNING,
} from "./shared.ts";

const inputSchema = z.object({ limit: limitSchema }).strict();

const windowLabel = (ctx: ToolContext) =>
  readerText(ctx.locale, "assistantTools.supplierWindow180");

export const getSupplierPerformance: AssistantTool = {
  name: "get_supplier_performance",
  description:
    "ביצועי ספקים בחלון קבוע של 180 יום, כפי שהוא מוגדר במסד ואינו ניתן לשינוי מהכלי: אחוז " +
    "אספקה בזמן לצד גודל המדגם (on_time_pct הוא null כשאין אף אספקה מתוארכת בחלון — 'לא נמדד', " +
    "לא אפס), ממוצע ימי אספקה, הזמנות פתוחות באיחור, זיכויים פתוחים בכסף, ומספר שינויי המחיר " +
    "בחלון עם מועד השינוי האחרון. הכלי אינו מדרג ואינו עונה מי הספק שמאחר הכי הרבה; " +
    "שאלת דירוג דורשת כלל עסקי שטרם הוכרע.",
  inputSchema,
  inputJsonSchema: {
    type: "object",
    properties: { limit: LIMIT_JSON_SCHEMA },
    required: ["limit"],
    additionalProperties: false,
  },
  requiredRoles: ["owner", "office"],
  classification: "financial_sensitive",
  async run(ctx: ToolContext, input: unknown) {
    const { limit } = inputSchema.parse(input);
    const asOf = ctx.now().toISOString();
    const filters = { window_days: 180, limit };
    const reads = readsOrNull(ctx);
    if (!reads) {
      return failure(ctx, READS_UNAVAILABLE.code, READS_UNAVAILABLE.label(ctx), filters);
    }

    const metrics = await reads.listSupplierMetrics(limit);
    if (metrics.error || metrics.rows === null) {
      return failure(
        ctx,
        "supplier_metrics_failed",
        readerText(ctx.locale, "assistantTools.supplierMetricsFetchFailed"),
        filters,
      );
    }

    const failures: { code: string; label: string }[] = [];
    const names = await reads.listSupplierNames(
      metrics.rows.map((row) => row.supplier_id),
    );
    const nameOf = new Map<string, string>();
    if (names.error || names.rows === null) {
      failures.push({
        code: "supplier_names_unavailable",
        label: readerText(ctx.locale, "assistantTools.supplierNamesUnavailable"),
      });
    } else {
      for (const row of names.rows) {
        nameOf.set(row.id, sanitizeText(row.name, 60));
      }
    }

    const facts: Fact[] = [];
    const sources: SourceReference[] = [];
    for (const row of metrics.rows) {
      const name = nameOf.get(row.supplier_id) ||
        `${readerText(ctx.locale, "assistantTools.supplierFallbackName")} ${row.supplier_id.slice(0, 8)}`;
      const subject = { entity: "supplier" as const, id: row.supplier_id };
      const shared = {
        subject,
        tool: getSupplierPerformance.name,
        as_of: asOf,
      };
      facts.push(ctx.evidence.fact({
        ...shared,
        kind: "metric.percent",
        label: `${readerText(ctx.locale, "assistantTools.supplierOnTimeRate", { window: windowLabel(ctx) })} — ${name}`,
        value: row.otd_samples > 0 ? row.on_time_pct : null,
        unit: "percent",
        classification: "tenant_standard",
      }));
      facts.push(ctx.evidence.fact({
        ...shared,
        kind: "metric.count",
        label: `${readerText(ctx.locale, "assistantTools.supplierDatedDeliveries", { window: windowLabel(ctx) })} — ${name}`,
        value: row.otd_samples,
        unit: "count",
        classification: "tenant_standard",
      }));
      facts.push(ctx.evidence.fact({
        ...shared,
        kind: "metric.count",
        label: `${readerText(ctx.locale, "assistantTools.supplierAverageLeadDays", { window: windowLabel(ctx) })} — ${name}`,
        value: row.lead_samples > 0 ? row.avg_lead_days : null,
        unit: "count",
        classification: "tenant_standard",
      }));
      facts.push(ctx.evidence.fact({
        ...shared,
        kind: "metric.count",
        label: `${readerText(ctx.locale, "assistantTools.supplierLateOpenOrders")} — ${name}`,
        value: row.late_open_orders,
        unit: "count",
        classification: "tenant_standard",
      }));
      if (row.open_credits > 0) {
        facts.push(ctx.evidence.fact({
          ...shared,
          kind: "credit.open_amount",
          label: `${readerText(ctx.locale, "assistantTools.creditsOpenAmount")} — ${name}`,
          value: row.open_credits_amount,
          unit: "ils",
          classification: "financial_sensitive",
        }));
      }
      facts.push(ctx.evidence.fact({
        ...shared,
        kind: "supplier.price_change",
        label: `${readerText(ctx.locale, "assistantTools.supplierPriceChanges", { window: windowLabel(ctx) })} — ${name}`,
        value: row.price_changes_window,
        unit: "count",
        classification: "tenant_standard",
      }));
      if (row.last_price_change) {
        facts.push(ctx.evidence.fact({
          ...shared,
          kind: "supplier.price_change",
          label: `${readerText(ctx.locale, "assistantTools.supplierLastPriceChange")} — ${name}`,
          value: row.last_price_change,
          unit: "date",
          classification: "tenant_standard",
        }));
      }
      sources.push(ctx.evidence.source({
        entity: "supplier",
        entity_id: row.supplier_id,
        label: name,
        route: `/suppliers/${row.supplier_id}`,
        classification: "tenant_standard",
      }));
    }

    return {
      data: metrics.rows.map((row) => ({
        ...row,
        supplier_name: nameOf.get(row.supplier_id) ?? null,
      })),
      complete: failures.length === 0,
      failures,
      filters,
      as_of: asOf,
      result_count: metrics.rows.length,
      has_more: metrics.hasMore,
      facts,
      sources,
      warnings: [
        readerText(ctx.locale, "assistantTools.supplierWindowWarning", { window: windowLabel(ctx) }),
        UNTRUSTED_TEXT_WARNING,
      ],
    };
  },
};
