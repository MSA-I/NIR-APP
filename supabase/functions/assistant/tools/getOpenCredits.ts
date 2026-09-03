// Tool 7a -- get_open_credits: the credits block of the dashboard snapshot plus the per-supplier
// open-credit money from supplier_metrics. Open means status in (open, requested, received);
// only offset/closed reduce a balance. Only recorded credit_requests are counted -- a scanned
// credit document that never became a credit record is invisible here (DEBT-REGISTER §49), and
// the description says so rather than letting the total read as the whole truth.
import { z } from "zod";
import type {
  Fact,
  SourceReference,
} from "../../../../src/lib/assistant/contracts.ts";
import { fetchDashboardSnapshot } from "./dashboardSnapshot.ts";
import type { AssistantTool, ToolContext } from "./registry.ts";
import { readerText } from "../reader-locale.ts";
import { currencyUnit, moneyByCurrency } from "./moneyByCurrency.ts";
import {
  EMPTY_OBJECT_JSON_SCHEMA,
  failure,
  num,
  readsOrNull,
  READS_UNAVAILABLE,
  record,
  sanitizeText,
  UNTRUSTED_TEXT_WARNING,
} from "./shared.ts";

const inputSchema = z.object({}).strict();

const PER_SUPPLIER_LIMIT = 50;

export const getOpenCredits: AssistantTool = {
  name: "get_open_credits",
  description:
    "זיכויים פתוחים מול ספקים: סך הזיכויים במצב open/requested/received (רק offset/closed " +
    "מקטינים יתרה בפועל), והפירוט הכספי פר ספק. נספרות אך ורק רשומות זיכוי שנקלטו במערכת — " +
    "מסמך זיכוי שנסרק ולא הפך לרשומת זיכוי אינו נכלל. הסכום הכולל מוחזר שורה לכל מטבע, עם קוד " +
    "המטבע בתווית וביחידה; אין המרה ואין לחבר סכומים ממטבעות שונים. כשאין אף זיכוי פתוח אין " +
    "מטבע לנקוב בו סכום, ולכן לא מוחזר סכום כלל — המונה שלצדו הוא האפס שנמדד.",
  inputSchema,
  inputJsonSchema: EMPTY_OBJECT_JSON_SCHEMA,
  requiredRoles: ["owner", "office"],
  classification: "financial_sensitive",
  async run(ctx: ToolContext, input: unknown) {
    inputSchema.parse(input);
    const asOf = ctx.now().toISOString();
    const reads = readsOrNull(ctx);
    if (!reads) {
      return failure(ctx, READS_UNAVAILABLE.code, READS_UNAVAILABLE.label(ctx));
    }

    const fetched = await fetchDashboardSnapshot(ctx);
    if (fetched.failed || !fetched.snapshot) return fetched.failed!;
    const credits = record(fetched.snapshot.credits) ?? {};
    const openCount = num(credits.count);
    const filters = { business_date: fetched.businessDate, statuses: "open,requested,received" };

    const facts: Fact[] = [];
    const sources: SourceReference[] = [];
    const failures: { code: string; label: string }[] = [];
    facts.push(ctx.evidence.fact({
      kind: "metric.count",
      subject: null,
      label: readerText(ctx.locale, "assistantTools.creditsOpenCountOrg"),
      value: openCount,
      unit: "count",
      tool: getOpenCredits.name,
      as_of: asOf,
      classification: "tenant_standard",
    }));
    /* A FOURTH ADAPTER READING A KEY THAT NO LONGER EXISTS — the same defect Wave 1b repaired in
       three, found while walking this tool's citations. `management_dashboard_snapshot` has
       returned `credits.sumByCurrency` since 0218; `credits.sum` was never restored, so
       `num(credits.sum)` was null on every run and the answer carried a `credit.open_amount`
       fact valued null and labelled `ils` — a currency nothing in the row had chosen. Null at
       least reads as "not measured" rather than as zero, which is why it was quiet; but the
       organisation's open credits were simply unavailable to the assistant, and the ILS unit was
       a claim about a figure that did not exist.
       One fact per currency now, through the reader the other three already use. */
    const openByCurrency = moneyByCurrency(credits.sumByCurrency);
    const openSumLabel = readerText(ctx.locale, "assistantTools.creditsOpenSumOrg");
    if (openByCurrency === null || openByCurrency.rows.length === 0) {
      // No credit is open in ANY currency, so there is no currency to state a sum in. The count
      // fact above is the measured zero that says so; inventing one here is the defect itself.
      failures.push({ code: "credits_open_sum:not_measured", label: openSumLabel });
    } else {
      if (openByCurrency.skipped > 0) {
        failures.push({ code: "credits_open_sum:currency_unrecognised", label: openSumLabel });
      }
      for (const row of openByCurrency.rows) {
        facts.push(ctx.evidence.fact({
          kind: "credit.open_amount",
          subject: null,
          label: `${openSumLabel} (${row.currency})`,
          value: row.amount,
          unit: currencyUnit(row.currency),
          tool: getOpenCredits.name,
          as_of: asOf,
          classification: "financial_sensitive",
        }));
      }
    }
    sources.push(ctx.evidence.source({
      entity: "organization",
      entity_id: ctx.actor.orgId,
      label: readerText(ctx.locale, "assistantTools.creditsScreen"),
      // The screen's `active` set is `open/requested/received` — exactly the statuses this
      // count and sum are taken over. Its default happens to be the same, but a source states
      // its filter rather than relying on a default staying put.
      route: "/credits?status=active",
      classification: "financial_sensitive",
    }));

    const perSupplier = await reads.listSupplierOpenCredits(PER_SUPPLIER_LIMIT);
    const supplierRows: {
      supplier_id: string;
      supplier_name: string | null;
      open_credits: number;
      open_credits_amount: number;
    }[] = [];
    let hasMore = false;
    if (perSupplier.error || perSupplier.rows === null) {
      failures.push({
        code: "supplier_credit_breakdown_failed",
        label: readerText(ctx.locale, "assistantTools.creditsPerSupplierUnavailable"),
      });
    } else {
      hasMore = perSupplier.hasMore;
      const names = await reads.listSupplierNames(
        perSupplier.rows.map((row) => row.supplier_id),
      );
      const nameOf = new Map<string, string>();
      if (names.rows) {
        for (const row of names.rows) nameOf.set(row.id, sanitizeText(row.name, 60));
      }
      for (const row of perSupplier.rows) {
        const name = nameOf.get(row.supplier_id) ||
          `ספק ${row.supplier_id.slice(0, 8)}`;
        supplierRows.push({
          supplier_id: row.supplier_id,
          supplier_name: nameOf.get(row.supplier_id) ?? null,
          open_credits: row.open_credits,
          open_credits_amount: row.open_credits_amount,
        });
        facts.push(ctx.evidence.fact({
          kind: "credit.open_amount",
          subject: { entity: "supplier", id: row.supplier_id },
          label: `${readerText(ctx.locale, "assistantTools.creditsOpenAmount")} — ${name}`,
          value: row.open_credits_amount,
          unit: "ils",
          tool: getOpenCredits.name,
          as_of: asOf,
          classification: "financial_sensitive",
        }));
        facts.push(ctx.evidence.fact({
          kind: "metric.count",
          subject: { entity: "supplier", id: row.supplier_id },
          label: `${readerText(ctx.locale, "assistantTools.creditsOpenCount")} — ${name}`,
          value: row.open_credits,
          unit: "count",
          tool: getOpenCredits.name,
          as_of: asOf,
          classification: "tenant_standard",
        }));
        sources.push(ctx.evidence.source({
          entity: "supplier",
          entity_id: row.supplier_id,
          label: name,
          route: `/suppliers/${row.supplier_id}`,
          classification: "tenant_standard",
        }));
      }
    }

    return {
      data: [{
        open_count: openCount,
        // Per currency, never one number: the rows are separate figures and adding them is the
        // thing the money rules forbid. `null` means the snapshot measured nothing at all.
        open_sum_by_currency: openByCurrency?.rows ?? null,
        suppliers: supplierRows,
      }],
      complete: failures.length === 0,
      failures,
      filters,
      as_of: asOf,
      result_count: supplierRows.length,
      has_more: hasMore,
      facts,
      sources,
      warnings: [
        readerText(ctx.locale, "assistantTools.creditsRecordsOnlyWarning"),
        UNTRUSTED_TEXT_WARNING,
      ],
    };
  },
};
