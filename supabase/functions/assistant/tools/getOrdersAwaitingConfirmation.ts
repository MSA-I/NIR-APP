// Tool 8 -- get_orders_awaiting_confirmation: purchase_orders with status='sent' under RLS,
// oldest first. The order total is the sum of the order's own item snapshots (qty * unit_price,
// the price agreed at ordering time) -- the same arithmetic 0100's `committed` performs in SQL
// over the same columns; nothing here reads a current price list.
import { z } from "zod";
import type {
  Fact,
  SourceReference,
} from "../../../../src/lib/assistant/contracts.ts";
import type { AssistantTool, ToolContext } from "./registry.ts";
import {
  failure,
  limitSchema,
  LIMIT_JSON_SCHEMA,
  readsOrNull,
  READS_UNAVAILABLE,
  round2,
  sanitizeText,
  UNTRUSTED_TEXT_WARNING,
} from "./shared.ts";

const inputSchema = z.object({ limit: limitSchema }).strict();

export const getOrdersAwaitingConfirmation: AssistantTool = {
  name: "get_orders_awaiting_confirmation",
  description:
    "הזמנות רכש שנשלחו לספק וטרם אושרו על ידו (status='sent'), מהוותיקה ביותר לחדשה: מספר " +
    "ההזמנה, הספק, מועד השליחה, תאריך האספקה הצפוי אם הוזן, וסכום ההזמנה במחירי הרגע שבו הוזמנה.",
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
    const filters = { status: "sent", limit };
    const reads = readsOrNull(ctx);
    if (!reads) {
      return failure(ctx, READS_UNAVAILABLE.code, READS_UNAVAILABLE.label, filters);
    }

    const result = await reads.listSentOrders(limit);
    if (result.error || result.rows === null) {
      return failure(
        ctx,
        "orders_awaiting_confirmation_failed",
        "שליפת ההזמנות הממתינות לאישור ספק נכשלה",
        filters,
      );
    }

    const facts: Fact[] = [];
    const sources: SourceReference[] = [];
    facts.push(ctx.evidence.fact({
      kind: "metric.count",
      subject: null,
      label: result.hasMore
        ? "הזמנות ממתינות לאישור ספק שהוחזרו בעמוד זה (קיימות נוספות)"
        : "הזמנות ממתינות לאישור ספק",
      value: result.rows.length,
      unit: "count",
      tool: getOrdersAwaitingConfirmation.name,
      as_of: asOf,
      classification: "tenant_standard",
    }));

    const dataRows = result.rows.map((row) => {
      const supplierName = sanitizeText(row.suppliers?.name, 60) ||
        `ספק ${row.supplier_id.slice(0, 8)}`;
      const total = round2(
        row.purchase_order_items.reduce(
          (sum, item) => sum + (item.qty ?? 0) * (item.unit_price ?? 0),
          0,
        ),
      );
      const title = `הזמנה #${row.number} — ${supplierName}`;
      facts.push(ctx.evidence.fact({
        kind: "order.total",
        subject: { entity: "purchase_order", id: row.id },
        label: `סכום ההזמנה במחירי ההזמנה — ${title}`,
        value: total,
        unit: "ils",
        tool: getOrdersAwaitingConfirmation.name,
        as_of: asOf,
        classification: "financial_sensitive",
      }));
      facts.push(ctx.evidence.fact({
        kind: "order.status",
        subject: { entity: "purchase_order", id: row.id },
        label: `סטטוס ההזמנה — ${title}`,
        value: "sent",
        unit: "text",
        tool: getOrdersAwaitingConfirmation.name,
        as_of: asOf,
        classification: "tenant_standard",
      }));
      if (row.sent_at) {
        facts.push(ctx.evidence.fact({
          kind: "order.status",
          subject: { entity: "purchase_order", id: row.id },
          label: `מועד השליחה לספק — ${title}`,
          value: row.sent_at,
          unit: "date",
          tool: getOrdersAwaitingConfirmation.name,
          as_of: asOf,
          classification: "tenant_standard",
        }));
      }
      sources.push(ctx.evidence.source({
        entity: "purchase_order",
        entity_id: row.id,
        label: title,
        route: `/orders/${row.id}`,
        classification: "tenant_standard",
      }));
      return {
        id: row.id,
        number: row.number,
        supplier_id: row.supplier_id,
        supplier_name: supplierName,
        status: row.status,
        expected_date: row.expected_date,
        sent_at: row.sent_at,
        created_at: row.created_at,
        total_at_order_prices: total,
      };
    });

    return {
      data: dataRows,
      complete: true,
      failures: [],
      filters,
      as_of: asOf,
      result_count: dataRows.length,
      has_more: result.hasMore,
      facts,
      sources,
      warnings: dataRows.length > 0 ? [UNTRUSTED_TEXT_WARNING] : [],
    };
  },
};
