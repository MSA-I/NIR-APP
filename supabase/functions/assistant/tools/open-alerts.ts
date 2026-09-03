// get_open_alerts -- the standing-condition scanner, server-side. Wraps exactly the scan RPCs
// src/lib/alerts.ts already uses, under the caller's JWT so RLS scopes every count. The Hebrew
// labels and the scope-limit sentences are reused from alerts.ts VERBATIM -- they were written
// deliberately, and an assistant that paraphrases a scope limit is an assistant that widens it.
//
// A scan that fails contributes a `failures` entry and flips `complete` to false. It must never
// silently report a clean sheet: zero findings with complete=true means "measured, none"; zero
// findings with complete=false means "could not measure", and the two are different answers.
import { z } from "zod";
import type {
  Fact,
  SourceReference,
  ToolEnvelope,
} from "../../../../src/lib/assistant/contracts.ts";
import { PRICE_INCREASE_SCOPE_DETAIL_KEY } from "../../../../src/lib/alertRules.ts";
import type { TKey } from "../../../../src/lib/i18n/t.ts";
import { readerText } from "../reader-locale.ts";
import { addCalendarDays, toZoneISO } from "../time.ts";
import type { AssistantTool, ToolContext } from "./registry.ts";

// Documented defaults (docs/OPEN-DECISIONS.md), mirrored from src/lib/alerts.ts -- same values,
// same names, so the assistant and the /alerts screen can never disagree about a threshold.
const ABOVE_AVG_MARGIN = 0.15;
const PRICE_INCREASE_WINDOW_DAYS = 30;
const DUE_SOON_DAYS = 7;

interface ScanFinding {
  facts: Omit<Fact, "id">[];
  sources: Omit<SourceReference, "id">[];
  warnings: string[];
}

async function rpcCount(
  request: PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<number> {
  const { data, error } = await request;
  if (error) throw new Error(error.message);
  const count = Number(data);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("count_unavailable");
  }
  return count;
}

export const getOpenAlertsTool: AssistantTool = {
  name: "get_open_alerts",
  description:
    "סורק את ההתראות העומדות של הארגון: חשבוניות כפולות, הזמנות שנשלחו וטרם אושרו, " +
    "עליות מחיר במחירון, הצעות מחיר מעל הממוצע, חשבוניות ללא הזמנה ומועדי תשלום קרבים. " +
    "מחזיר ספירות בלבד, עם ציון מפורש של מה שלא נמדד.",
  inputSchema: z.object({}).strict(),
  inputJsonSchema: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  requiredRoles: ["owner", "office", "accountant"],
  classification: "tenant_standard",
  async run(ctx: ToolContext): Promise<ToolEnvelope> {
    const now = ctx.now();
    const asOf = now.toISOString();
    const today = toZoneISO(now);
    const aggregate = (label: string, value: number): Omit<Fact, "id"> => ({
      kind: "alert.occurrence",
      subject: null,
      label,
      value,
      unit: "count",
      tool: "get_open_alerts",
      as_of: asOf,
      classification: "tenant_standard",
    });
    const listSource = (
      label: string,
      route: string,
    ): Omit<SourceReference, "id"> => ({
      // An aggregate route has no single row to point at; the organization is the subject the
      // reference is re-authorized against when read back from history.
      entity: "organization",
      entity_id: ctx.actor.orgId,
      label,
      route,
      classification: "tenant_standard",
    });

    // Codes and Hebrew labels verbatim from src/lib/alerts.ts SCANS.
    const scans: {
      code: string;
      label: string;
      run: () => Promise<ScanFinding>;
    }[] = [
      {
        code: "duplicate_invoice",
        label: readerText(ctx.locale, "assistantTools.alertDuplicateInvoices"),
        run: async () => {
          const dupes = await rpcCount(
            ctx.db.rpc("p2_duplicate_invoice_group_count"),
          );
          return {
            facts: [aggregate(readerText(ctx.locale, "assistantTools.alertDuplicateInvoicesFact"), dupes)],
            sources: dupes
              ? [listSource(
                readerText(ctx.locale, "assistantTools.alertDuplicateInvoices"),
                "/invoices?attention=duplicates",
              )]
              : [],
            warnings: [readerText(ctx.locale, "assistantTools.alertDuplicateInvoicesWarning")],
          };
        },
      },
      {
        code: "orders_awaiting_confirmation",
        label: readerText(ctx.locale, "assistantTools.alertOrdersUnconfirmed"),
        run: async () => {
          const { count, error } = await ctx.db.countSentOrders();
          if (error) throw new Error(error.message);
          const total = count ?? 0;
          return {
            facts: [aggregate(readerText(ctx.locale, "assistantTools.alertOrdersUnconfirmedFact"), total)],
            sources: total
              ? [listSource(readerText(ctx.locale, "assistantTools.alertOrdersUnconfirmed"), "/orders?status=sent")]
              : [],
            warnings: [
              readerText(ctx.locale, "assistantTools.alertOrdersUnconfirmedWarning"),
            ],
          };
        },
      },
      {
        code: "price_increase",
        label: readerText(ctx.locale, "assistantTools.alertPriceIncreases"),
        run: async () => {
          const raised = await rpcCount(
            ctx.db.rpc("p2_recent_price_increase_count", {
              p_since: addCalendarDays(today, -PRICE_INCREASE_WINDOW_DAYS),
            }),
          );
          return {
            facts: [aggregate(
              readerText(ctx.locale, "assistantTools.alertPriceIncreasesFact", { days: PRICE_INCREASE_WINDOW_DAYS }),
              raised,
            )],
            sources: raised
              ? [listSource(readerText(ctx.locale, "assistantTools.alertPriceIncreases"), "/prices?increases=1&days=30")]
              : [],
            warnings: [
              // The scope-limit sentence is still `alerts.ts`’s own, resolved rather than
              // retyped: extraction moved it into the dictionaries under this key, and a
              // paraphrase of a scope limit is a widening of it.
              readerText(ctx.locale, PRICE_INCREASE_SCOPE_DETAIL_KEY as TKey),
            ],
          };
        },
      },
      {
        code: "above_average_price",
        label: readerText(ctx.locale, "assistantTools.alertAboveAveragePrices"),
        run: async () => {
          const over = await rpcCount(
            ctx.db.rpc("p2_above_average_offer_count", {
              p_margin: ABOVE_AVG_MARGIN,
            }),
          );
          return {
            facts: [aggregate(
              readerText(ctx.locale, "assistantTools.alertAboveAveragePricesFact", { percent: Math.round(ABOVE_AVG_MARGIN * 100) }),
              over,
            )],
            sources: over ? [listSource(readerText(ctx.locale, "assistantTools.alertAboveAveragePrices"), "/prices")] : [],
            warnings: [readerText(ctx.locale, "assistantTools.alertAboveAveragePricesWarning")],
          };
        },
      },
      {
        code: "invoice_without_order",
        label: readerText(ctx.locale, "assistantTools.alertInvoiceWithoutOrder"),
        run: async () => {
          // DEBT-REGISTER §10 (OPEN): p2_invoice_without_order_count() is SECURITY INVOKER with
          // an RLS-sensitive NOT EXISTS, and its owner/office role contract is NOT enforced in
          // the function body -- a caller in another role gets a wrong number, not a refusal.
          // Enforce the contract here until the debt closes: any other role lands as the named
          // failure below, never as a silently wrong count.
          if (ctx.actor.role !== "owner" && ctx.actor.role !== "office") {
            throw new Error("not_permitted");
          }
          const orphans = await rpcCount(
            ctx.db.rpc("p2_invoice_without_order_count"),
          );
          return {
            facts: [aggregate(readerText(ctx.locale, "assistantTools.alertInvoiceWithoutOrderFact"), orphans)],
            sources: orphans
              ? [listSource(
                readerText(ctx.locale, "assistantTools.alertInvoiceWithoutOrder"),
                "/invoices?attention=without-order",
              )]
              : [],
            warnings: [
              readerText(ctx.locale, "assistantTools.alertInvoiceWithoutOrderWarning"),
            ],
          };
        },
      },
      {
        code: "payment_due_soon",
        label: readerText(ctx.locale, "assistantTools.alertPaymentDue"),
        run: async () => {
          const { data, error } = await ctx.db.rpc("p2_payment_due_counts", {
            p_today: today,
            p_until: addCalendarDays(today, DUE_SOON_DAYS),
          });
          if (error) throw new Error(error.message);
          const counts = data as { total?: unknown; late?: unknown } | null;
          const total = Number(counts?.total);
          const late = Number(counts?.late);
          if (
            !Number.isSafeInteger(total) || total < 0 ||
            !Number.isSafeInteger(late) || late < 0 || late > total
          ) {
            throw new Error("due_counts_unavailable");
          }
          return {
            facts: [
              aggregate(
                readerText(ctx.locale, "assistantTools.alertPaymentDueFact", { days: DUE_SOON_DAYS }),
                total,
              ),
              aggregate(readerText(ctx.locale, "assistantTools.alertPaymentOverdueFact"), late),
            ],
            sources: total
              ? [listSource(
                readerText(ctx.locale, "assistantTools.alertPaymentDue"),
                "/payment-requests?status=active&due=soon",
              )]
              : [],
            warnings: [
              readerText(ctx.locale, "assistantTools.alertPaymentDueWarning"),
            ],
          };
        },
      },
    ];

    const settled = await Promise.allSettled(scans.map((scan) => scan.run()));
    const failures: { code: string; label: string }[] = [];
    const facts: Fact[] = [];
    const sources: SourceReference[] = [];
    const warnings: string[] = [];
    settled.forEach((result, index) => {
      if (result.status !== "fulfilled") {
        failures.push({ code: scans[index].code, label: scans[index].label });
        return;
      }
      for (const fact of result.value.facts) {
        facts.push(ctx.evidence.fact(fact));
      }
      for (const source of result.value.sources) {
        sources.push(ctx.evidence.source(source));
      }
      warnings.push(...result.value.warnings);
    });

    return {
      data: [],
      complete: failures.length === 0,
      failures,
      filters: {
        price_increase_window_days: PRICE_INCREASE_WINDOW_DAYS,
        above_average_margin: ABOVE_AVG_MARGIN,
        due_soon_days: DUE_SOON_DAYS,
      },
      as_of: asOf,
      result_count: facts.length,
      has_more: false,
      facts,
      sources,
      warnings,
    };
  },
};
