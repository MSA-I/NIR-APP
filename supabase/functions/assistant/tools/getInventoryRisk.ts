// Tool 6 -- get_inventory_risk: the public.inventory_intelligence view (0102; display columns
// touched by 0150). projected_stockout_days is null unless BOTH a counted quantity and measured
// consumption exist, and incoming purchase orders are deliberately NOT credited against it --
// a quantity on the way is evidence of supply, not proof today's stockout is avoided.
// suggested_reorder_quantity is a formula over min_stock, never a recommendation.
import { z } from "zod";
import type {
  Fact,
  SourceReference,
} from "../../../../src/lib/assistant/contracts.ts";
import type { AssistantTool, ToolContext } from "./registry.ts";
import { readerText } from "../reader-locale.ts";
import {
  failure,
  limitSchema,
  LIMIT_JSON_SCHEMA,
  readsOrNull,
  READS_UNAVAILABLE,
  sanitizeText,
  UNTRUSTED_TEXT_WARNING,
} from "./shared.ts";

const inputSchema = z.object({ limit: limitSchema }).strict();

export const getInventoryRisk: AssistantTool = {
  name: "get_inventory_risk",
  description:
    "סיכון מלאי לפי מודל הקריאה של המוצר: כמות במלאי (נמדדת רק למוצרים שנספרו), צריכה יומית " +
    "ממוצעת מאז הספירה האחרונה (עד 30 יום של תיעוד), וימים חזויים עד אזילה — ערך שקיים רק כאשר " +
    "גם המלאי וגם הצריכה נמדדו, ואחרת null. הזמנות רכש בדרך אינן מנוכות מחישוב האזילה בכוונה, " +
    "והכמות הצפויה מהן מוחזרת בנפרד. suggested_reorder_quantity היא נוסחה של השלמה עד מלאי " +
    "המינימום — לא המלצת רכש, לא בסיס להצעת הזמנה, והמלאי לעולם אינו יוצר רכש. " +
    "השורות מוחזרות מהאזילה הקרובה ביותר ואילך; מוצרים שלא נמדדו בסוף.",
  inputSchema,
  inputJsonSchema: {
    type: "object",
    properties: { limit: LIMIT_JSON_SCHEMA },
    required: ["limit"],
    additionalProperties: false,
  },
  requiredRoles: ["owner", "office"],
  classification: "tenant_standard",
  async run(ctx: ToolContext, input: unknown) {
    const { limit } = inputSchema.parse(input);
    const asOf = ctx.now().toISOString();
    const filters = { limit, consumption_window_days: 30 };
    const reads = readsOrNull(ctx);
    if (!reads) {
      return failure(ctx, READS_UNAVAILABLE.code, READS_UNAVAILABLE.label(ctx), filters);
    }

    const result = await reads.listInventoryRisk(limit);
    if (result.error || result.rows === null) {
      return failure(
        ctx,
        "inventory_risk_failed",
        readerText(ctx.locale, "assistantTools.inventoryFetchFailed"),
        filters,
      );
    }

    const facts: Fact[] = [];
    const sources: SourceReference[] = [];
    for (const row of result.rows) {
      const name = sanitizeText(row.product_name, 60) || readerText(ctx.locale, "assistantTools.productUnnamed");
      const unit = sanitizeText(row.unit, 20);
      const suffix = unit ? `${name} (${unit})` : name;
      const subject = { entity: "product" as const, id: row.product_id };
      const shared = {
        subject,
        unit: "count" as const,
        tool: getInventoryRisk.name,
        as_of: asOf,
        classification: "tenant_standard" as const,
      };
      facts.push(ctx.evidence.fact({
        ...shared,
        kind: "metric.count",
        label: `${readerText(ctx.locale, "assistantTools.inventoryOnHand")} — ${suffix}`,
        value: row.is_counted ? row.quantity_on_hand : null,
      }));
      facts.push(ctx.evidence.fact({
        ...shared,
        kind: "metric.count",
        label: `${readerText(ctx.locale, "assistantTools.inventoryDailyUse")} — ${suffix}`,
        value: row.average_daily_consumption,
      }));
      facts.push(ctx.evidence.fact({
        ...shared,
        kind: "metric.count",
        label: `${readerText(ctx.locale, "assistantTools.inventoryDaysToStockout")} — ${suffix}`,
        value: row.projected_stockout_days,
      }));
      facts.push(ctx.evidence.fact({
        ...shared,
        kind: "metric.count",
        label: `${readerText(ctx.locale, "assistantTools.inventoryTopUpFormula")} — ${suffix}`,
        value: row.suggested_reorder_quantity,
      }));
      facts.push(ctx.evidence.fact({
        ...shared,
        kind: "metric.count",
        label: `${readerText(ctx.locale, "assistantTools.inventoryIncomingQuantity")} — ${suffix}`,
        value: row.expected_incoming_quantity,
      }));
      if (row.next_expected_incoming_date) {
        facts.push(ctx.evidence.fact({
          ...shared,
          kind: "metric.count",
          label: `${readerText(ctx.locale, "assistantTools.inventoryNextDelivery")} — ${suffix}`,
          value: row.next_expected_incoming_date,
          unit: "date",
        }));
      }
      sources.push(ctx.evidence.source({
        entity: "product",
        entity_id: row.product_id,
        label: suffix,
        route: "/inventory",
        classification: "tenant_standard",
      }));
    }

    return {
      data: result.rows,
      complete: true,
      failures: [],
      filters,
      as_of: asOf,
      result_count: result.rows.length,
      has_more: result.hasMore,
      facts,
      sources,
      warnings: [
        "מוצר שלא נספר מעולם מוחזר עם null במלאי ובאזילה — 'לא נמדד', לא אפס.",
        UNTRUSTED_TEXT_WARNING,
      ],
    };
  },
};
