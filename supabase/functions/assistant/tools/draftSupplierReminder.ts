// Tool 15 -- draft_supplier_reminder: the EVIDENCE a supplier reminder may quote (#191/#193).
//
// What this tool is: a read. It returns the order number, the expected delivery date and the days
// of delay for purchase orders that were sent to a supplier and did not arrive by their own
// expected date. It composes no prose -- the model writes the body into a `draft` block, and
// validate.ts pins every numeral in that body to one of the values issued here.
//
// What this tool is NOT, and what nothing downstream of it is either (#182/#191):
//   * it does not choose a recipient -- no contact, no phone, no email leaves here, and
//     `personal_contact` is a provider-forbidden class in the first place;
//   * it does not choose a channel -- there is no WhatsApp, mail or SMS path in the assistant;
//   * it does not send, queue, schedule or mark anything as sent;
//   * it writes nothing at all. Its only data access is the existing `listSentOrders` read port:
//     the caller's own JWT, RLS as the boundary, an explicit column projection, no new query
//     surface of its own on `purchase_orders`/`purchase_order_items`, and no write path to reach.
// The person copies the text and sends it themselves. Any future send re-opens #182 and #191.
import { z } from "zod";
import type {
  Fact,
  SourceReference,
} from "../../../../src/lib/assistant/contracts.ts";
import { toZoneISO } from "../time.ts";
import type { AssistantTool, ToolContext } from "./registry.ts";
import {
  failure,
  limitSchema,
  LIMIT_JSON_SCHEMA,
  readsOrNull,
  READS_UNAVAILABLE,
  sanitizeText,
  UNTRUSTED_TEXT_WARNING,
} from "./shared.ts";

const inputSchema = z
  .object({
    /** One specific order, when the person named it. Empty means "every late sent order". */
    order_id: z.string().trim().max(64).default(""),
    limit: limitSchema,
  })
  .strict();

/**
 * Whole calendar days between two YYYY-MM-DD dates, positive when `later` is after `earlier`.
 *
 * Both operands are already calendar dates in ORG_TIME_ZONE (`expected_date` is a DATE column,
 * `toZoneISO` renders "today" in the same zone), so UTC midnight arithmetic on them is exact and
 * carries no DST hazard -- the same reason src/lib/format.ts's addCalendarDays works this way.
 */
function calendarDaysBetween(earlier: string, later: string): number | null {
  const parse = (value: string) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    return match
      ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
      : null;
  };
  const from = parse(earlier);
  const to = parse(later);
  if (from === null || to === null) return null;
  return Math.round((to - from) / 86_400_000);
}

export const NO_SEND_WARNING =
  "העוזר אינו שולח הודעות לספקים ואינו בוחר נמען או ערוץ. הנתונים כאן נועדו לניסוח טיוטה " +
  "שהמשתמש מעתיק ושולח בעצמו.";

export const draftSupplierReminder: AssistantTool = {
  name: "draft_supplier_reminder",
  description:
    "הנתונים שמותר לצטט בטיוטת תזכורת לספק על הזמנה שאיחרה: מספר ההזמנה, תאריך האספקה הצפוי " +
    "ומספר ימי האיחור מולו, להזמנות שנשלחו לספק והתאריך הצפוי שלהן כבר עבר. הכלי מחזיר " +
    "עובדות בלבד — הוא אינו מנסח טקסט, אינו בוחר נמען או ערוץ ואינו שולח דבר; המשתמש מעתיק " +
    "ושולח בעצמו. הזמנות שנשלחו בלי תאריך אספקה צפוי אינן נכללות, כי אי אפשר למדוד עליהן איחור.",
  inputSchema,
  inputJsonSchema: {
    type: "object",
    properties: {
      order_id: {
        type: "string",
        maxLength: 64,
        description: "מזהה הזמנה מסוימת, אם המשתמש נקב בה",
      },
      limit: LIMIT_JSON_SCHEMA,
    },
    required: [],
    additionalProperties: false,
  },
  // #191 is a role decision, not a rendering preference: accountant is offered no supplier-draft
  // capability at all. validate.ts refuses the draft BLOCK for the same role, so the boundary
  // holds even if a future caller registers this tool more widely by mistake.
  requiredRoles: ["owner", "office"],
  classification: "tenant_standard",
  async run(ctx: ToolContext, input: unknown) {
    const { order_id, limit } = inputSchema.parse(input);
    const businessDate = toZoneISO(ctx.now());
    const asOf = ctx.now().toISOString();
    const filters = {
      status: "sent",
      late_before: businessDate,
      order_id: order_id || null,
      limit,
    };

    // A flag may turn a capability OFF; it may never widen one (ENTERPRISE-SECURITY-MODEL §8).
    // This tool exists only to feed a draft block, so with drafting switched off it has nothing
    // legitimate to return -- and says so by name rather than returning an empty success.
    if (!ctx.actor.capabilities.drafts) {
      return failure(
        ctx,
        "drafts_not_enabled",
        "ניסוח טיוטות אינו מופעל בארגון הזה",
        filters,
      );
    }

    const reads = readsOrNull(ctx);
    if (!reads) {
      return failure(ctx, READS_UNAVAILABLE.code, READS_UNAVAILABLE.label, filters);
    }

    const result = await reads.listSentOrders(limit);
    if (result.error || result.rows === null) {
      return failure(
        ctx,
        "sent_orders_read_failed",
        "שליפת ההזמנות שנשלחו לספק נכשלה",
        filters,
      );
    }

    const failures: { code: string; label: string }[] = [];
    const candidates = order_id
      ? result.rows.filter((row) => row.id === order_id)
      : result.rows;
    if (order_id && candidates.length === 0) {
      return failure(
        ctx,
        "order_not_awaiting_supplier",
        "ההזמנה המבוקשת אינה בין ההזמנות שנשלחו וממתינות לספק בעמוד שנקרא",
        filters,
      );
    }
    // An order sent without an expected date cannot be called late -- and cannot be called on time
    // either. It is excluded and the exclusion is stated, exactly as /alerts refuses to read an
    // incomplete scan as a clean sheet.
    if (candidates.some((row) => !row.expected_date)) {
      failures.push({
        code: "expected_date_missing",
        label:
          "להזמנות שנשלחו בלי תאריך אספקה צפוי אי אפשר לחשב איחור, והן אינן נכללות בתזכורת",
      });
    }

    const facts: Fact[] = [];
    const sources: SourceReference[] = [];
    const rows: {
      id: string;
      number: number;
      supplier_id: string;
      supplier_name: string;
      expected_date: string;
      days_late: number;
    }[] = [];

    for (const row of candidates) {
      if (!row.expected_date) continue;
      const daysLate = calendarDaysBetween(row.expected_date, businessDate);
      if (daysLate === null || daysLate <= 0) continue;

      const supplierName = sanitizeText(row.suppliers?.name, 60) ||
        `ספק ${row.supplier_id.slice(0, 8)}`;
      const title = `הזמנה #${row.number} — ${supplierName}`;
      rows.push({
        id: row.id,
        number: row.number,
        supplier_id: row.supplier_id,
        supplier_name: supplierName,
        expected_date: row.expected_date,
        days_late: daysLate,
      });

      // `order.status` is this repo's order-ATTRIBUTE kind, not a status enum:
      // getOrdersAwaitingConfirmation already issues it with unit 'date' for the send date. The
      // order number travels as a string value so the draft may render it exactly -- a numeral in
      // the body is legal only as a rendering of a cited fact's VALUE, never of its label.
      facts.push(ctx.evidence.fact({
        kind: "order.status",
        subject: { entity: "purchase_order", id: row.id },
        label: `מספר ההזמנה — ${title}`,
        value: String(row.number),
        unit: "text",
        tool: draftSupplierReminder.name,
        as_of: asOf,
        classification: "tenant_standard",
      }));
      facts.push(ctx.evidence.fact({
        kind: "order.status",
        subject: { entity: "purchase_order", id: row.id },
        label: `תאריך האספקה הצפוי — ${title}`,
        value: row.expected_date,
        unit: "date",
        tool: draftSupplierReminder.name,
        as_of: asOf,
        classification: "tenant_standard",
      }));
      facts.push(ctx.evidence.fact({
        kind: "metric.count",
        subject: { entity: "purchase_order", id: row.id },
        label: `ימי איחור מול תאריך האספקה הצפוי — ${title}`,
        value: daysLate,
        unit: "count",
        tool: draftSupplierReminder.name,
        as_of: asOf,
        classification: "tenant_standard",
      }));
      // The only destination this tool knows: the order's own screen in the product. It is a
      // place a person can go and look, never a place a message can be sent to.
      sources.push(ctx.evidence.source({
        entity: "purchase_order",
        entity_id: row.id,
        label: title,
        route: `/orders/${row.id}`,
        classification: "tenant_standard",
      }));
    }

    return {
      data: rows,
      complete: failures.length === 0,
      failures,
      filters,
      as_of: asOf,
      result_count: rows.length,
      has_more: order_id ? false : result.hasMore,
      facts,
      sources,
      warnings: [NO_SEND_WARNING, UNTRUSTED_TEXT_WARNING],
    };
  },
};
