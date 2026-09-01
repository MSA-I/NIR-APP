// Tool 9 -- get_unmatched_bank_transactions: bank_transactions in status unmatched/suggested
// under RLS (owner and accountant only, 0031). This is the tool closest to restricted data, so
// the projection is exactly what an operational answer needs -- date, amount, description,
// direction, status -- and nothing else: no raw import row, no reference, no supplier column.
// Descriptions are bank-export text: bounded, sanitised, and declared untrusted.
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

const STATUS_HE: Record<string, string> = {
  unmatched: "ללא התאמה",
  suggested: "עם הצעת התאמה",
};

export const getUnmatchedBankTransactions: AssistantTool = {
  name: "get_unmatched_bank_transactions",
  description:
    "תנועות בנק שטרם הותאמו: במצב 'ללא התאמה' או 'עם הצעת התאמה הממתינה לאדם'. מוחזרים תאריך, " +
    "סכום, כיוון (חובה/זכות), תיאור מקוצר וסטטוס בלבד — מהתנועה החדשה לישנה. נתונים פיננסיים " +
    "רגישים; נגיש לבעלים ולרואה החשבון בלבד.",
  inputSchema,
  inputJsonSchema: {
    type: "object",
    properties: { limit: LIMIT_JSON_SCHEMA },
    required: ["limit"],
    additionalProperties: false,
  },
  requiredRoles: ["owner", "accountant"],
  classification: "financial_sensitive",
  async run(ctx: ToolContext, input: unknown) {
    const { limit } = inputSchema.parse(input);
    const asOf = ctx.now().toISOString();
    const filters = { statuses: "unmatched,suggested", limit };
    const reads = readsOrNull(ctx);
    if (!reads) {
      return failure(ctx, READS_UNAVAILABLE.code, READS_UNAVAILABLE.label(ctx), filters);
    }

    const result = await reads.listUnmatchedBankTransactions(limit);
    if (result.error || result.rows === null) {
      return failure(
        ctx,
        "bank_transactions_failed",
        readerText(ctx.locale, "assistantTools.bankFetchFailed"),
        filters,
      );
    }

    const facts: Fact[] = [];
    const sources: SourceReference[] = [];
    const unmatchedCount = result.rows.filter((row) => row.status === "unmatched").length;
    const suggestedCount = result.rows.filter((row) => row.status === "suggested").length;
    const pageSuffix = result.hasMore ? ` ${readerText(ctx.locale, "assistantTools.pageSuffixMore")}` : "";
    facts.push(ctx.evidence.fact({
      kind: "metric.count",
      subject: null,
      label: `${readerText(ctx.locale, "assistantTools.bankUnmatchedCount")}${pageSuffix}`,
      value: unmatchedCount,
      unit: "count",
      tool: getUnmatchedBankTransactions.name,
      as_of: asOf,
      classification: "tenant_standard",
    }));
    facts.push(ctx.evidence.fact({
      kind: "metric.count",
      subject: null,
      label: `${readerText(ctx.locale, "assistantTools.bankSuggestedCount")}${pageSuffix}`,
      value: suggestedCount,
      unit: "count",
      tool: getUnmatchedBankTransactions.name,
      as_of: asOf,
      classification: "tenant_standard",
    }));

    const dataRows = result.rows.map((row) => {
      const description = sanitizeText(row.description, 80);
      const statusHe = STATUS_HE[row.status] ?? row.status;
      const direction = row.is_debit ? readerText(ctx.locale, "assistantTools.bankDebit") : readerText(ctx.locale, "assistantTools.bankCredit");
      // Bank-export descriptions stay in the server/browser data projection. They never ride in a
      // Fact or Source label, because those labels are the provider projection.
      const title = `${readerText(ctx.locale, "assistantTools.bankTransactionWord")} ${direction} ${statusHe} ${row.tx_date}`;
      facts.push(ctx.evidence.fact({
        kind: "metric.money",
        subject: { entity: "bank_transaction", id: row.id },
        label: `${readerText(ctx.locale, "assistantTools.bankTransactionAmount")} — ${title}`,
        value: row.amount,
        unit: "ils",
        tool: getUnmatchedBankTransactions.name,
        as_of: asOf,
        classification: "financial_sensitive",
      }));
      sources.push(ctx.evidence.source({
        entity: "bank_transaction",
        entity_id: row.id,
        label: title,
        route: "/bank",
        classification: "financial_sensitive",
      }));
      return {
        id: row.id,
        tx_date: row.tx_date,
        description,
        amount: row.amount,
        is_debit: row.is_debit,
        status: row.status,
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
      warnings: [
        readerText(ctx.locale, "assistantTools.bankDescriptionsWarning"),
        UNTRUSTED_TEXT_WARNING,
      ],
    };
  },
};
