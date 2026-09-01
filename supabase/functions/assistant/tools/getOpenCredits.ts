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
    "מסמך זיכוי שנסרק ולא הפך לרשומת זיכוי אינו נכלל. סכום כולל מוחזר null כשאין אף זיכוי פתוח.",
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
    const openSum = num(credits.sum);
    const filters = { business_date: fetched.businessDate, statuses: "open,requested,received" };

    const facts: Fact[] = [];
    const sources: SourceReference[] = [];
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
    facts.push(ctx.evidence.fact({
      kind: "credit.open_amount",
      subject: null,
      label: readerText(ctx.locale, "assistantTools.creditsOpenSumOrg"),
      value: openSum,
      unit: "ils",
      tool: getOpenCredits.name,
      as_of: asOf,
      classification: "financial_sensitive",
    }));
    sources.push(ctx.evidence.source({
      entity: "organization",
      entity_id: ctx.actor.orgId,
      label: readerText(ctx.locale, "assistantTools.creditsScreen"),
      route: "/credits",
      classification: "financial_sensitive",
    }));

    const failures: { code: string; label: string }[] = [];
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
        open_sum: openSum,
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
