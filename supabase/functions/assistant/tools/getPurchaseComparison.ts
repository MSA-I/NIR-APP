// Tool 13 -- get_purchase_comparison: EXPLAINS the comparison the product already makes
// (OPEN-DECISIONS #190, #145, #155, #182). It does not make one of its own.
//
// Two halves, both borrowed rather than rebuilt:
//   * the offers, the automatic supplier choice and the supplier-minimum breaches come from
//     public.purchase_comparison() (0203), priced at run time under the caller's own RLS;
//   * `savedByCurrency` / `extraByCurrency` come from src/lib/orderComparison.ts -- the SAME
//     compareLine() and summarizeComparison() the New Order comparison panel calls. One formula in one file: a
//     second implementation here would be a second answer waiting to disagree with the screen the
//     user is about to be sent to.
//
// The input is quantities the USER typed or a draft that already exists. It is never a quantity
// the model chose, and there is no code path in which this tool proposes one: a supplier minimum
// the basket does not clear comes back as a BREACH with its shortfall, never as a raised quantity
// (#190), and nothing here writes anything at all -- purchase_orders and purchase_order_items are
// named forbidden by #182 and are not reachable from the read model this wraps.
//
// A product with no alternative offer yields `single_offer` and a null gap, which the answer must
// render as `—`. A zero there would claim the buyer saved nothing, when the truth is that there was
// nothing to compare against (#155).
import { z } from "zod";
import type {
  Fact,
  FactUnit,
  SourceReference,
} from "../../../../src/lib/assistant/contracts.ts";
import {
  compareLine,
  type LineComparison,
  type OfferQuote,
  summarizeComparison,
} from "../../../../src/lib/orderComparison.ts";
import type { AssistantTool, ToolContext } from "./registry.ts";
import {
  failure,
  list,
  num,
  record,
  sanitizeText,
  str,
  UNTRUSTED_TEXT_WARNING,
} from "./shared.ts";

const MAX_LINES = 60;

function currencyCode(value: unknown): string | null {
  const code = str(value);
  return code && /^[A-Z]{3}$/.test(code) ? code : null;
}

function currencyUnit(code: string): FactUnit {
  // currencyCode() proved the upper-case ISO shape before this conversion.
  return code.toLowerCase() as FactUnit;
}

const inputSchema = z
  .object({
    lines: z
      .array(
        z
          .object({
            product_id: z.string().uuid(),
            qty: z.number().finite().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_LINES)
      .nullish(),
    request_id: z.string().uuid().nullish(),
  })
  .strict()
  // Exactly one input, enforced before the call rather than trusted afterwards: accepting both
  // would let a caller pass a draft id and a different basket and never learn which was answered.
  .refine(
    (value) => (value.lines == null) !== (value.request_id == null),
    { message: "lines_or_request_id_exactly_one" },
  );

interface ComparisonOffer {
  supplier_id: string;
  supplier_name: string;
  preferred: boolean;
  unit_price: number | null;
  currency: string | null;
  min_qty: number | null;
  meets_min_qty: boolean;
}

interface ComparisonLine {
  product_id: string;
  product_name: string;
  unit: string | null;
  qty: number | null;
  status: string;
  chosen_supplier_id: string | null;
  chosen_unit_price: number | null;
  chosen_currency: string | null;
  line_total: number | null;
  offers: ComparisonOffer[];
}

interface SupplierRow {
  supplier_id: string;
  supplier_name: string;
  subtotal: number | null;
  currency: string | null;
  min_order_amount: number | null;
  min_order_currency: string | null;
  below_minimum: boolean | null;
  shortfall: number | null;
}

function projectOffer(raw: Record<string, unknown>): ComparisonOffer | null {
  const supplierId = str(raw.supplier_id);
  if (!supplierId) return null;
  return {
    supplier_id: supplierId,
    supplier_name: sanitizeText(raw.supplier_name, 60),
    preferred: raw.preferred === true,
    unit_price: num(raw.unit_price),
    currency: currencyCode(raw.currency),
    min_qty: num(raw.min_qty),
    meets_min_qty: raw.meets_min_qty === true,
  };
}

function projectLine(raw: Record<string, unknown>): ComparisonLine | null {
  const productId = str(raw.product_id);
  if (!productId) return null;
  return {
    product_id: productId,
    product_name: sanitizeText(raw.product_name, 80),
    unit: str(raw.unit),
    qty: num(raw.qty),
    status: str(raw.status) ?? "unknown",
    chosen_supplier_id: str(raw.chosen_supplier_id),
    chosen_unit_price: num(raw.chosen_unit_price),
    chosen_currency: currencyCode(raw.chosen_currency),
    line_total: num(raw.line_total),
    offers: list(raw.offers)
      .map((offer) => record(offer))
      .filter((offer): offer is Record<string, unknown> => offer !== null)
      .map(projectOffer)
      .filter((offer): offer is ComparisonOffer => offer !== null),
  };
}

function projectSupplier(raw: Record<string, unknown>): SupplierRow | null {
  const supplierId = str(raw.supplier_id);
  if (!supplierId) return null;
  return {
    supplier_id: supplierId,
    supplier_name: sanitizeText(raw.supplier_name, 60),
    subtotal: num(raw.subtotal),
    currency: currencyCode(raw.currency),
    min_order_amount: num(raw.min_order_amount),
    min_order_currency: currencyCode(raw.min_order_currency),
    below_minimum: typeof raw.below_minimum === "boolean" ? raw.below_minimum : null,
    shortfall: num(raw.shortfall),
  };
}

/** The offer shape the shared formula takes. Only usable, priced offers can enter it. */
function toQuotes(line: ComparisonLine): OfferQuote[] {
  const quotes: OfferQuote[] = [];
  for (const offer of line.offers) {
    if (offer.unit_price === null || offer.currency === null) continue;
    quotes.push({
      supplierId: offer.supplier_id,
      unitPrice: offer.unit_price,
      currency: offer.currency,
      minQty: offer.min_qty,
    });
  }
  return quotes;
}

const STATUS_LABELS: Record<string, string> = {
  saved: "נחסך מול האפשרות הזולה הבאה",
  same_price: "אותו מחיר גם אצל הבא בתור",
  overpaying: "משולם יותר מהאפשרות הזולה ביותר",
  single_offer: "אין הצעה חלופית — לא ניתן להשוות",
  no_basis: "אין בסיס להשוואה",
};

export const getPurchaseComparison: AssistantTool = {
  name: "get_purchase_comparison",
  description:
    "מסביר את השוואת הרכש הקיימת של המערכת עבור כמויות שהמשתמש הזין או עבור טיוטת הזמנה קיימת " +
    "(request_id). יש להעביר אחד מהשניים בלבד, ולעולם לא כמויות שהמודל בחר. השרת מחזיר את כל " +
    "ההצעות לכל מוצר במחירי הרגע, את הבחירה האוטומטית (הזול ביותר; ספק מועדף הוא שובר שוויון " +
    "בלבד), ואת מינימום ההזמנה של כל ספק. חריגה ממינימום ספק מוחזרת כהפרה מפורשת עם הפער החסר — " +
    "הכלי אינו מעלה כמות כדי לעקוף מינימום ואינו יוצר, משנה או שולח הזמנה. חיסכון מחושב מול " +
    "האפשרות הזולה הבאה באותו מטבע בלבד; מוצר בלי חלופה מוחזר כ־null ויש להציגו כ־`—` ולא כאפס. " +
    "סיכומי סל מוחזרים כשורה לכל מטבע ולעולם לא כסכום מאוחד.",
  inputSchema,
  inputJsonSchema: {
    type: "object",
    properties: {
      lines: {
        type: ["array", "null"],
        minItems: 1,
        maxItems: MAX_LINES,
        description:
          "הכמויות שהמשתמש הזין. יש להעביר lines או request_id, לא את שניהם.",
        items: {
          type: "object",
          properties: {
            product_id: { type: "string", description: "מזהה המוצר" },
            qty: { type: "number", description: "כמות שהמשתמש הזין (גדולה מאפס)" },
          },
          required: ["product_id", "qty"],
          additionalProperties: false,
        },
      },
      request_id: {
        type: ["string", "null"],
        description:
          "מזהה טיוטת הזמנה קיימת, או null. יש להעביר lines או request_id, לא את שניהם.",
      },
    },
    // Strict mode requires every property here, so the either/or is expressed by nullability:
    // exactly one of the two carries a value and the other is null. `inputSchema` refuses both
    // and refuses neither, so the rule is enforced where it was always enforced.
    required: ["lines", "request_id"],
    additionalProperties: false,
  },
  requiredRoles: ["owner", "office"],
  classification: "financial_sensitive",
  async run(ctx: ToolContext, input: unknown) {
    const parsed = inputSchema.parse(input);
    const asOf = ctx.now().toISOString();
    const filters: Record<string, string | number | boolean | null> = {
      source: parsed.request_id ? "draft" : "input",
      request_id: parsed.request_id ?? null,
      priced_at: "run_time",
    };

    const result = await ctx.db.rpc("purchase_comparison", {
      p_lines: parsed.lines ?? null,
      p_request_id: parsed.request_id ?? null,
    });
    if (result.error) {
      const message = result.error.message ?? "";
      if (message.includes("purchase_comparison_draft_unknown")) {
        return failure(ctx, "draft_unknown", "טיוטת ההזמנה לא נמצאה", filters);
      }
      if (message.includes("purchase_comparison_input")) {
        return failure(ctx, "invalid_tool_input", "קלט ההשוואה אינו תקין", filters);
      }
      if (message.includes("not_authorized") || message.includes("permission")) {
        return failure(ctx, "not_permitted", "אין הרשאה להשוואת הרכש", filters);
      }
      return failure(ctx, "purchase_comparison_failed", "שליפת ההשוואה נכשלה", filters);
    }

    const payload = record(result.data);
    if (!payload) {
      return failure(
        ctx,
        "purchase_comparison_malformed",
        "ההשוואה לא התקבלה במבנה תקין",
        filters,
      );
    }

    const lines = list(payload.lines)
      .map((line) => record(line))
      .filter((line): line is Record<string, unknown> => line !== null)
      .map(projectLine)
      .filter((line): line is ComparisonLine => line !== null);
    const suppliers = list(payload.suppliers)
      .map((row) => record(row))
      .filter((row): row is Record<string, unknown> => row !== null)
      .map(projectSupplier)
      .filter((row): row is SupplierRow => row !== null);
    const complete = payload.complete === true;
    filters.source = str(payload.source) ?? filters.source;

    const facts: Fact[] = [];
    const sources: SourceReference[] = [];
    const comparisons: LineComparison[] = [];
    const rows: {
      product_id: string;
      product_name: string;
      qty: number | null;
      status: string;
      chosen_supplier_id: string | null;
      chosen_unit_price: number | null;
      chosen_currency: string | null;
      line_total: number | null;
      comparison_status: LineComparison["status"];
      comparison_currency: string | null;
      saved_vs_next: number | null;
      extra_vs_cheapest: number | null;
      offer_count: number;
    }[] = [];

    for (const line of lines) {
      // The shared formula, called exactly as the comparison panel calls it. The quantity handed
      // in is the server's copy of what the user asked for -- never one adjusted to clear a
      // minimum.
      const comparison = line.qty === null
        ? { status: "no_basis", currency: null, savedVsNext: null, extraVsCheapest: null } as LineComparison
        : compareLine(line.qty, toQuotes(line), line.chosen_supplier_id);
      comparisons.push(comparison);

      const productLabel = line.product_name || `מוצר ${line.product_id.slice(0, 8)}`;
      rows.push({
        product_id: line.product_id,
        product_name: line.product_name,
        qty: line.qty,
        status: line.status,
        chosen_supplier_id: line.chosen_supplier_id,
        chosen_unit_price: line.chosen_unit_price,
        chosen_currency: line.chosen_currency,
        line_total: line.line_total,
        comparison_status: comparison.status,
        comparison_currency: comparison.currency,
        saved_vs_next: comparison.savedVsNext,
        extra_vs_cheapest: comparison.extraVsCheapest,
        offer_count: line.offers.length,
      });

      if (line.chosen_currency) {
        facts.push(ctx.evidence.fact({
          kind: "metric.money",
          subject: { entity: "product", id: line.product_id },
          label: `סכום השורה במחירי הרגע — ${productLabel} (${line.chosen_currency})` +
            (line.qty === null ? "" : ` (כמות ${line.qty})`),
          value: line.line_total,
          unit: currencyUnit(line.chosen_currency),
          tool: getPurchaseComparison.name,
          as_of: asOf,
          classification: "financial_sensitive",
        }));
      }
      // "You saved X" and "you are paying X more than you had to" are opposite statements, and
      // src/lib/orderComparison.ts sums them separately for exactly that reason. Emitting both
      // under `metric.money` on the same product would hand the validator two facts it cannot
      // tell apart, so a claim citing the overpayment could legitimately call it a saving --
      // the label says which, and labels are deliberately not checkable. The kind carries the
      // direction instead.
      if (comparison.currency) {
        facts.push(ctx.evidence.fact({
          kind: comparison.status === "overpaying"
            ? "comparison.extra_vs_cheapest"
            : "comparison.saved_vs_next",
          subject: { entity: "product", id: line.product_id },
          label: `${STATUS_LABELS[comparison.status] ?? comparison.status} — ${productLabel} (${comparison.currency})`,
          // null, not 0: `single_offer` means there was nothing to compare against.
          value: comparison.savedVsNext ?? comparison.extraVsCheapest,
          unit: currencyUnit(comparison.currency),
          tool: getPurchaseComparison.name,
          as_of: asOf,
          classification: "financial_sensitive",
        }));
      }
    }

    const summary = summarizeComparison(comparisons);
    for (const saved of summary.savedByCurrency ?? []) {
      facts.push(ctx.evidence.fact({
        kind: "comparison.saved_vs_next",
        subject: null,
        label: `סך החיסכון מול האפשרות הזולה הבאה בכל הסל (${saved.currency})`,
        value: saved.amount,
        unit: currencyUnit(saved.currency),
        tool: getPurchaseComparison.name,
        as_of: asOf,
        classification: "financial_sensitive",
      }));
    }
    for (const extra of summary.extraByCurrency ?? []) {
      facts.push(ctx.evidence.fact({
        kind: "comparison.extra_vs_cheapest",
        subject: null,
        label: `סך התשלום העודף מול האפשרות הזולה ביותר בכל הסל (${extra.currency})`,
        value: extra.amount,
        unit: currencyUnit(extra.currency),
        tool: getPurchaseComparison.name,
        as_of: asOf,
        classification: "financial_sensitive",
      }));
    }

    // The breaches are their own result field, not a footnote on a supplier row: #190 makes
    // "this basket does not clear the supplier's minimum" a first-class answer, and the shortfall
    // is what the user needs in order to decide -- the assistant does not decide for them.
    const breaches = suppliers.filter((supplier) => supplier.below_minimum === true);
    facts.push(ctx.evidence.fact({
      kind: "metric.count",
      subject: null,
      label: "ספקים שהסל אינו מגיע אצלם למינימום ההזמנה",
      value: breaches.length,
      unit: "count",
      tool: getPurchaseComparison.name,
      as_of: asOf,
      classification: "tenant_standard",
    }));
    for (const supplier of suppliers) {
      const supplierLabel = supplier.supplier_name ||
        `ספק ${supplier.supplier_id.slice(0, 8)}`;
      if (supplier.currency) {
        facts.push(ctx.evidence.fact({
          kind: "metric.money",
          subject: { entity: "supplier", id: supplier.supplier_id },
          label: `סכום הסל אצל ${supplierLabel} (${supplier.currency})`,
          value: supplier.subtotal,
          unit: currencyUnit(supplier.currency),
          tool: getPurchaseComparison.name,
          as_of: asOf,
          classification: "financial_sensitive",
        }));
      }
      if (supplier.below_minimum === true && supplier.currency) {
        facts.push(ctx.evidence.fact({
          // Not `metric.money`: the basket subtotal at this same supplier is also money about
          // this same supplier, and a shortfall claimed as a subtotal reads as a much larger
          // order than the customer has.
          kind: "comparison.minimum_breach",
          subject: { entity: "supplier", id: supplier.supplier_id },
          label: `חסר כדי להגיע למינימום ההזמנה של ${supplierLabel}` +
            ` (מינימום ${supplier.min_order_amount ?? "—"} ${supplier.min_order_currency ?? supplier.currency})`,
          value: supplier.shortfall,
          unit: currencyUnit(supplier.currency),
          tool: getPurchaseComparison.name,
          as_of: asOf,
          classification: "financial_sensitive",
        }));
      }
      sources.push(ctx.evidence.source({
        entity: "supplier",
        entity_id: supplier.supplier_id,
        label: supplierLabel,
        route: `/suppliers/${supplier.supplier_id}`,
        classification: "tenant_standard",
      }));
    }

    sources.push(ctx.evidence.source({
      entity: "organization",
      entity_id: ctx.actor.orgId,
      label: "מסך המחירים — ההצעות שההשוואה מבוססת עליהן",
      route: "/prices",
      classification: "financial_sensitive",
    }));
    if (parsed.request_id) {
      // The New Order comparison screen is not in the assistant's route allowlist, so this source
      // carries no route rather than an invented one. It still names the draft, so the answer can
      // tell the user which basket was compared instead of describing an anonymous one.
      sources.push(ctx.evidence.source({
        entity: "organization",
        entity_id: ctx.actor.orgId,
        label: `טיוטת ההזמנה הקיימת ${parsed.request_id}`,
        route: null,
        classification: "tenant_standard",
      }));
    }

    return {
      data: [{
        source: filters.source,
        request_id: parsed.request_id ?? null,
        lines: rows,
        suppliers,
        minimum_breaches: breaches,
        saved_by_currency: summary.savedByCurrency,
        extra_by_currency: summary.extraByCurrency,
        overpaying_line_count: summary.overpayingCount,
      }],
      complete,
      failures: complete ? [] : [{
        code: "purchase_comparison_incomplete",
        label: "חלק מהשורות שהתבקשו לא ניתנות להשוואה ולא נכללו בסיכום",
      }],
      filters,
      as_of: asOf,
      result_count: rows.length,
      has_more: payload.has_more === true,
      facts,
      sources,
      warnings: [
        "המחירים הם מחירי הרגע. הזמנה שכבר נוצרה שומרת snapshot מחיר משלה ואינה משתנה.",
        "חריגה ממינימום ספק מוחזרת כהפרה בלבד — אין להציע להעלות כמות, ליצור טיוטה או לשלוח הזמנה.",
        "מוצר בלי הצעה חלופית מקבל null ויש להציגו כ־`—`, לא כאפס.",
        UNTRUSTED_TEXT_WARNING,
      ],
    };
  },
};
