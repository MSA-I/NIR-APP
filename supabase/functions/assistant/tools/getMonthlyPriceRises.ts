// Tool 12 -- get_monthly_price_rises: which suppliers raised a price THIS CALENDAR MONTH, from
// public.supplier_monthly_price_rises() (0203, OPEN-DECISIONS #189/#178).
//
// The server owns every number here. The month is the 1st at 00:00 in Asia/Jerusalem -- not a
// trailing thirty days, and not the 180-day `price_changes_window` that supplier_metrics counts
// volatility with. The baseline is the last price that was actually in effect when the month
// opened, and only a NET positive difference is a rise: a price that went up mid-month and came
// back is not news and is absent from the answer entirely.
//
// A product whose baseline nobody can establish is returned as UNMEASURABLE and is excluded from
// every count and total. It is never a zero -- a zero would claim the supplier held their price,
// which is exactly what we do not know.
import { z } from "zod";
import type {
  Fact,
  SourceReference,
} from "../../../../src/lib/assistant/contracts.ts";
import type { AssistantTool, ToolContext } from "./registry.ts";
import {
  failure,
  LIMIT_JSON_SCHEMA,
  limitSchema,
  list,
  num,
  record,
  sanitizeText,
  str,
  UNTRUSTED_TEXT_WARNING,
} from "./shared.ts";

const inputSchema = z.object({ limit: limitSchema }).strict();

interface RiseRow {
  supplier_id: string;
  supplier_name: string;
  product_id: string;
  product_name: string;
  measurable: boolean;
  unmeasurable_reason: string | null;
  baseline_price: number | null;
  baseline_source: string | null;
  baseline_as_of: string | null;
  current_price: number | null;
  current_as_of: string | null;
  delta_amount: number | null;
  delta_percent: number | null;
  supplier_rise_count: number | null;
  supplier_rise_total: number | null;
  supplier_unmeasurable_count: number | null;
  measured_rise_rows: number | null;
  unmeasurable_rows: number | null;
  month_start: string | null;
  month_end: string | null;
  time_zone: string | null;
}

/** Explicit projection: the tool states which fields it reads, and reads no others. */
function projectRow(raw: Record<string, unknown>): RiseRow | null {
  const supplierId = str(raw.supplier_id);
  const productId = str(raw.product_id);
  if (!supplierId || !productId) return null;
  return {
    supplier_id: supplierId,
    supplier_name: sanitizeText(raw.supplier_name, 60),
    product_id: productId,
    product_name: sanitizeText(raw.product_name, 80),
    measurable: raw.measurable === true,
    unmeasurable_reason: str(raw.unmeasurable_reason),
    baseline_price: num(raw.baseline_price),
    baseline_source: str(raw.baseline_source),
    baseline_as_of: str(raw.baseline_as_of),
    current_price: num(raw.current_price),
    current_as_of: str(raw.current_as_of),
    delta_amount: num(raw.delta_amount),
    delta_percent: num(raw.delta_percent),
    supplier_rise_count: num(raw.supplier_rise_count),
    supplier_rise_total: num(raw.supplier_rise_total),
    supplier_unmeasurable_count: num(raw.supplier_unmeasurable_count),
    measured_rise_rows: num(raw.measured_rise_rows),
    unmeasurable_rows: num(raw.unmeasurable_rows),
    month_start: str(raw.month_start),
    month_end: str(raw.month_end),
    time_zone: str(raw.time_zone),
  };
}

export const getMonthlyPriceRises: AssistantTool = {
  name: "get_monthly_price_rises",
  description:
    "ספקים שהעלו מחיר בחודש הקלנדרי הנוכחי — מ-1 בחודש בשעה 00:00 לפי שעון ישראל ועד עכשיו. " +
    "זהו חודש קלנדרי ולא חלון נגרר של 30 יום, ואינו נשען על מדד השינויים של 180 הימים. לכל מוצר " +
    "מושווה המחיר הנוכחי למחיר האחרון שהיה בתוקף בתחילת החודש; מוצג רק פער חיובי נטו, בסכום " +
    "ובאחוז, ללא סף מינימלי. מחיר שעלה וחזר לבסיס או מתחתיו אינו נחשב העלאה ואינו מוחזר כלל. " +
    "מוצר שאין לו מחיר בסיס סמכותי בתחילת החודש מוחזר כ׳לא ניתן למדוד׳ ואינו נספר כאפס — אין " +
    "להציג אותו כמוצר שמחירו לא השתנה. יש להצהיר בתשובה על גבולות החודש שהוחזרו מהשרת.",
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
    const filters: Record<string, string | number | boolean | null> = {
      period: "calendar_month",
      time_zone: "Asia/Jerusalem",
    };

    // limit+1 so `has_more` is honest without an exact count (DEBT-REGISTER §15).
    const result = await ctx.db.rpc("supplier_monthly_price_rises", {
      p_limit: limit + 1,
    });
    if (result.error) {
      const message = result.error.message ?? "";
      if (message.includes("not_authorized") || message.includes("permission")) {
        return failure(ctx, "not_permitted", "אין הרשאה לנתוני המחירים", filters);
      }
      return failure(
        ctx,
        "monthly_price_rises_failed",
        "שליפת העלאות המחיר של החודש נכשלה",
        filters,
      );
    }

    const rows = list(result.data)
      .map((row) => record(row))
      .filter((row): row is Record<string, unknown> => row !== null)
      .map(projectRow)
      .filter((row): row is RiseRow => row !== null);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);

    // The month boundaries are the SERVER's, relayed rather than recomputed here: an answer that
    // declares a period the query did not use is worse than an answer with no period at all.
    const monthStart = page[0]?.month_start ?? rows[0]?.month_start ?? null;
    const monthEnd = page[0]?.month_end ?? rows[0]?.month_end ?? null;
    filters.month_start = monthStart;
    filters.month_end = monthEnd;

    const measuredRows = rows[0]?.measured_rise_rows ?? null;
    const unmeasurableRows = rows[0]?.unmeasurable_rows ?? null;

    const facts: Fact[] = [];
    const sources: SourceReference[] = [];

    facts.push(ctx.evidence.fact({
      kind: "metric.count",
      subject: null,
      label: "מוצרים שמחירם עלה נטו בחודש הקלנדרי הנוכחי",
      value: measuredRows,
      unit: "count",
      tool: getMonthlyPriceRises.name,
      as_of: asOf,
      classification: "tenant_standard",
    }));
    // Issued as its own fact, deliberately. The unmeasurable count is not a footnote to the rise
    // count -- it is the size of what this answer could not see, and it must be citable.
    facts.push(ctx.evidence.fact({
      kind: "metric.count",
      subject: null,
      label: "מוצרים שלא ניתן למדוד — אין מחיר בסיס סמכותי בתחילת החודש (אינם נספרים כאפס)",
      value: unmeasurableRows,
      unit: "count",
      tool: getMonthlyPriceRises.name,
      as_of: asOf,
      classification: "tenant_standard",
    }));

    const supplierSeen = new Set<string>();
    for (const row of page) {
      const supplierLabel = row.supplier_name || `ספק ${row.supplier_id.slice(0, 8)}`;
      const productLabel = row.product_name || `מוצר ${row.product_id.slice(0, 8)}`;

      if (!supplierSeen.has(row.supplier_id)) {
        supplierSeen.add(row.supplier_id);
        facts.push(ctx.evidence.fact({
          kind: "metric.money",
          subject: { entity: "supplier", id: row.supplier_id },
          label: `סך ההתייקרות ליחידה החודש — ${supplierLabel}`,
          value: row.supplier_rise_total,
          unit: "ils",
          tool: getMonthlyPriceRises.name,
          as_of: asOf,
          classification: "financial_sensitive",
        }));
        facts.push(ctx.evidence.fact({
          kind: "metric.count",
          subject: { entity: "supplier", id: row.supplier_id },
          label: `מוצרים שהתייקרו החודש — ${supplierLabel}`,
          value: row.supplier_rise_count,
          unit: "count",
          tool: getMonthlyPriceRises.name,
          as_of: asOf,
          classification: "tenant_standard",
        }));
        sources.push(ctx.evidence.source({
          entity: "supplier",
          entity_id: row.supplier_id,
          label: supplierLabel,
          route: `/suppliers/${row.supplier_id}`,
          classification: "tenant_standard",
        }));
      }

      if (!row.measurable) {
        // `null`, never 0. The label carries the reason so the model can say why rather than
        // leaving the reader to assume the price held.
        facts.push(ctx.evidence.fact({
          kind: "supplier.price_change",
          subject: { entity: "product", id: row.product_id },
          label: `לא ניתן למדוד שינוי מחיר החודש — ${productLabel} אצל ${supplierLabel}` +
            ` (אין מחיר בסיס סמכותי ב-1 בחודש)`,
          value: null,
          unit: "ils",
          tool: getMonthlyPriceRises.name,
          as_of: asOf,
          classification: "financial_sensitive",
        }));
        continue;
      }

      facts.push(ctx.evidence.fact({
        kind: "supplier.price_change",
        subject: { entity: "product", id: row.product_id },
        label: `עליית מחיר ליחידה — ${productLabel} אצל ${supplierLabel}` +
          ` (בסיס ${row.baseline_price ?? "—"} מ-${row.baseline_as_of ?? "—"}, ` +
          `מחיר נוכחי ${row.current_price ?? "—"})`,
        value: row.delta_amount,
        unit: "ils",
        tool: getMonthlyPriceRises.name,
        as_of: asOf,
        classification: "financial_sensitive",
      }));
      // #189 requires the answer to carry the BASELINE, its source and its as-of -- and the
      // validator's numeral pool is built from fact VALUES only, never labels, precisely so a
      // tenant-authored name like "ספק 2000" cannot hand a claim a free numeral. That rule cuts
      // both ways: a baseline that lives only inside the label above is a number the assistant
      // may read and may not state. It gets its own fact so it can actually be quoted.
      facts.push(ctx.evidence.fact({
        kind: "supplier.price_baseline",
        subject: { entity: "product", id: row.product_id },
        label: `מחיר הבסיס ב-1 בחודש — ${productLabel} אצל ${supplierLabel}` +
          ` (מקור: ${row.baseline_source ?? "—"})`,
        value: row.baseline_price,
        unit: "ils",
        tool: getMonthlyPriceRises.name,
        as_of: asOf,
        classification: "financial_sensitive",
      }));
      facts.push(ctx.evidence.fact({
        kind: "metric.percent",
        subject: { entity: "product", id: row.product_id },
        label: `שיעור עליית המחיר — ${productLabel} אצל ${supplierLabel}`,
        value: row.delta_percent,
        unit: "percent",
        tool: getMonthlyPriceRises.name,
        as_of: asOf,
        classification: "financial_sensitive",
      }));
    }

    sources.push(ctx.evidence.source({
      entity: "organization",
      entity_id: ctx.actor.orgId,
      label: "מסך המחירים — התייקרויות",
      route: "/prices?increases=1",
      classification: "financial_sensitive",
    }));

    return {
      data: page,
      complete: !hasMore,
      failures: hasMore
        ? [{
          code: "monthly_price_rises_truncated",
          label: "התוצאה נקטעה בגבול השורות; הסכומים הכוללים מתייחסים לכל החודש",
        }]
        : [],
      filters,
      as_of: asOf,
      result_count: page.length,
      has_more: hasMore,
      facts,
      sources,
      warnings: [
        "התקופה היא חודש קלנדרי לפי שעון ישראל, מ-1 בחודש 00:00. אין לתאר אותה כ־30 הימים האחרונים.",
        "מוצר המסומן `לא ניתן למדוד` אינו מוצר שמחירו לא השתנה — אין לספור אותו כאפס ואין להשמיטו מהתשובה בשקט.",
        UNTRUSTED_TEXT_WARNING,
      ],
    };
  },
};
