// Tool 2 -- compare_order_receipt_invoice: the ordered / received / previously-invoiced /
// this-invoice quantities and the normalized unit-price comparison for one invoice, from the same
// RPC as explain_invoice_block. THE DELTAS COME FROM THE RPC -- difference_amount and
// difference_percent are surfaced exactly as computed; no difference is ever derived here.
import { z } from "zod";
import type { Fact } from "../../../../src/lib/assistant/contracts.ts";
import type { AssistantTool, ToolContext } from "./registry.ts";
import { list, num, record, sanitizeText, str, UNTRUSTED_TEXT_WARNING } from "./shared.ts";
import { fetchThreeWayAssessment } from "./threeWay.ts";

const inputSchema = z
  .object({ invoice_id: z.string().uuid() })
  .strict();

/** Facts are emitted for at most this many order items; the rest stay in has_more territory. */
const ORDER_ITEM_FACT_CAP = 25;

export const compareOrderReceiptInvoice: AssistantTool = {
  name: "compare_order_receipt_invoice",
  description:
    "משווה עבור חשבונית אחת בין ההזמנה, הקבלה והחשבונית: לכל פריט הזמנה — הכמות שהוזמנה, " +
    "שהתקבלה, שחויבה בחשבוניות מאושרות קודמות ובחשבונית הזו; ולכל שורת חשבונית — השוואת מחיר " +
    "היחידה המנורמל מול מחיר ההזמנה, עם הפרש בש\"ח ובאחוזים כפי שחושבו בשרת. " +
    "'חויב בעבר' נמדד מצילומי האישור הקבועים של חשבוניות שאושרו: חשבונית שעברה אחר כך לחקירה " +
    "עדיין צורכת את הכמות — זה מה שהמספר מודד, ואין להציגו כאילו החקירה שחררה אותה. " +
    "חשבונית ללא הזמנה מקושרת מוחזרת כ'לא ניתנת להשוואה', לא כתקינה.",
  inputSchema,
  inputJsonSchema: {
    type: "object",
    properties: {
      invoice_id: {
        type: "string",
        description: "מזהה החשבונית (UUID), למשל מתוצאת find_entity",
      },
    },
    required: ["invoice_id"],
    additionalProperties: false,
  },
  requiredRoles: ["owner", "office", "accountant"],
  classification: "financial_sensitive",
  async run(ctx: ToolContext, input: unknown) {
    const { invoice_id } = inputSchema.parse(input);
    const asOf = ctx.now().toISOString();
    const fetched = await fetchThreeWayAssessment(ctx, invoice_id);
    if (fetched.failed || !fetched.raw) return fetched.failed!;
    const raw = fetched.raw;

    const totals = record(raw.totals) ?? {};
    const orderItems = list(raw.order_items).map((entry) => record(entry) ?? {});
    const lines = list(raw.lines).map((entry) => record(entry) ?? {});
    const linkedOrderCount = num(raw.linked_order_count) ?? 0;
    const facts: Fact[] = [];
    const warnings: string[] = [];

    facts.push(ctx.evidence.fact({
      kind: "invoice.total",
      subject: { entity: "invoice", id: invoice_id },
      label: "סכום החשבונית כולל מע\"מ",
      value: num(totals.invoice_grand),
      unit: "ils",
      tool: compareOrderReceiptInvoice.name,
      as_of: asOf,
      classification: "financial_sensitive",
    }));

    // Line descriptions are supplier/OCR text; map them to order items only for fact labels.
    const itemDescription = new Map<string, string>();
    for (const line of lines) {
      const description = sanitizeText(line.description, 60);
      for (const match of list(line.matches)) {
        const matchRecord = record(match);
        const itemId = matchRecord ? str(matchRecord.purchase_order_item_id) : null;
        if (itemId && description && !itemDescription.has(itemId)) {
          itemDescription.set(itemId, description);
        }
      }
    }

    let cappedItems = 0;
    for (const item of orderItems.slice(0, ORDER_ITEM_FACT_CAP)) {
      const itemId = str(item.purchase_order_item_id) ?? "";
      const orderId = str(item.purchase_order_id) ?? itemId;
      const unit = sanitizeText(item.unit, 20);
      const named = itemDescription.get(itemId);
      const suffix = `${named ? ` — ${named}` : ""}${unit ? ` (${unit})` : ""}`;
      const subject = { entity: "purchase_order" as const, id: orderId };
      const shared = {
        subject,
        unit: "count" as const,
        tool: compareOrderReceiptInvoice.name,
        as_of: asOf,
        classification: "tenant_standard" as const,
      };
      facts.push(ctx.evidence.fact({
        ...shared,
        kind: "metric.count",
        label: `כמות שהוזמנה בפריט ההזמנה${suffix}`,
        value: num(item.ordered_quantity),
      }));
      facts.push(ctx.evidence.fact({
        ...shared,
        kind: "metric.count",
        label: `כמות שהתקבלה בפועל בפריט ההזמנה${suffix}`,
        value: num(item.received_quantity),
      }));
      facts.push(ctx.evidence.fact({
        ...shared,
        kind: "metric.count",
        label: `כמות שחויבה במצטבר (חשבוניות מאושרות קודמות + החשבונית הזו)${suffix}`,
        value: num(item.invoiced_quantity),
      }));
    }
    if (orderItems.length > ORDER_ITEM_FACT_CAP) {
      cappedItems = orderItems.length - ORDER_ITEM_FACT_CAP;
      warnings.push(
        "לא הונפקו עובדות לכל פריטי ההזמנה; חלקם מופיעים רק בנתונים הגולמיים.",
      );
    }

    // The price comparison lives on line reasons. difference_amount / difference_percent are the
    // RPC's own numbers.
    for (const line of lines) {
      const lineNumber = num(line.line_number);
      const description = sanitizeText(line.description, 60);
      const label = description !== ""
        ? `שורה ${lineNumber ?? "?"} — ${description}`
        : `שורה ${lineNumber ?? "?"}`;
      for (const reasonEntry of list(line.reasons)) {
        const reason = record(reasonEntry);
        if (!reason) continue;
        const differenceAmount = num(reason.difference_amount);
        const differencePercent = num(reason.difference_percent);
        if (differenceAmount === null && differencePercent === null) continue;
        if (differenceAmount !== null) {
          facts.push(ctx.evidence.fact({
            kind: "order_invoice.delta",
            subject: { entity: "invoice", id: invoice_id },
            label: `הפרש מחיר יחידה מנורמל מול מחיר ההזמנה, בש"ח — ${label}`,
            value: differenceAmount,
            unit: "ils",
            tool: compareOrderReceiptInvoice.name,
            as_of: asOf,
            classification: "financial_sensitive",
          }));
        }
        if (differencePercent !== null) {
          facts.push(ctx.evidence.fact({
            kind: "metric.percent",
            subject: { entity: "invoice", id: invoice_id },
            label: `הפרש מחיר יחידה מנורמל מול מחיר ההזמנה, באחוזים — ${label}`,
            value: differencePercent,
            unit: "percent",
            tool: compareOrderReceiptInvoice.name,
            as_of: asOf,
            classification: "financial_sensitive",
          }));
        }
      }
    }

    if (orderItems.length > 0) {
      warnings.push(
        "הכמות שחויבה בעבר נספרת מצילומי אישור קבועים; מעבר של חשבונית קודמת לחקירה אינו משחרר את הכמות שנצרכה.",
      );
    }
    if (lines.some((line) => sanitizeText(line.description, 60) !== "")) {
      warnings.push(UNTRUSTED_TEXT_WARNING);
    }
    if (linkedOrderCount === 0) {
      warnings.push(
        "אין הזמנה מקושרת לחשבונית, ולכן אין בסיס להשוואה — זו קביעה, לא תקינות.",
      );
    }

    const source = ctx.evidence.source({
      entity: "invoice",
      entity_id: invoice_id,
      label: "החשבונית המושוות",
      route: `/invoices/${invoice_id}`,
      classification: "financial_sensitive",
    });

    return {
      data: [{
        invoice_id,
        comparison_state: str(raw.comparison_state),
        linked_order_count: linkedOrderCount,
        order_items: orderItems,
        lines: lines.map((line) => ({
          id: str(line.id),
          line_number: num(line.line_number),
          description: sanitizeText(line.description, 140),
          quantity: num(line.quantity),
          unit: str(line.unit),
          unit_price: num(line.unit_price),
          line_total: num(line.line_total),
          reasons: list(line.reasons),
          matches: list(line.matches),
        })),
        totals: {
          line_grand: num(totals.line_grand),
          invoice_grand: num(totals.invoice_grand),
        },
      }],
      complete: true,
      failures: [],
      filters: { invoice_id },
      as_of: asOf,
      result_count: 1,
      has_more: cappedItems > 0,
      facts,
      sources: [source],
      warnings,
    };
  },
};
