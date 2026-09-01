// Tool 1 -- explain_invoice_block: why an invoice is (or is not) blocked from approval.
// Backed entirely by public.get_invoice_three_way_match (0099; live body patched by 0137). The
// reason codes and every number they carry come from the RPC; this tool surfaces them verbatim.
import { z } from "zod";
import type { Fact } from "../../../../src/lib/assistant/contracts.ts";
import type { AssistantTool, ToolContext } from "./registry.ts";
import { readerText } from "../reader-locale.ts";
import type { TKey } from "../../../../src/lib/i18n/t.ts";
import { list, num, record, str } from "./shared.ts";
import { fetchThreeWayAssessment } from "./threeWay.ts";

const inputSchema = z
  .object({ invoice_id: z.string().uuid() })
  .strict();

/** The server's severity codes, as words the reader of THIS run can read. */
const REASON_SEVERITY_KEYS: Record<string, TKey> = {
  critical: "assistantTools.severityCritical",
  error: "assistantTools.severityError",
  warning: "assistantTools.severityWarning",
  info: "assistantTools.severityInfo",
};

export const explainInvoiceBlock: AssistantTool = {
  name: "explain_invoice_block",
  description:
    "מסביר מדוע חשבונית חסומה לאישור (או מדוע אינה חסומה): תוצאת בדיקת ההצלבה המשולשת " +
    "הזמנה-קבלה-חשבונית — סטטוס, חומרה, כפילות ודאית, רשימת סיבות עם הקוד, החומרה והמספרים " +
    "שכל סיבה נושאת, הסכומים והסבילויות, והאם קיימת עקיפת בעלים פעילה. כל הערכים מחושבים בשרת. " +
    "לתפקיד רואה חשבון נגישות לחשבוניות מאושרות בלבד.",
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
    const reasons = list(raw.reasons).map((entry) => record(entry) ?? {});
    const override = record(raw.override);
    const status = str(raw.status);
    const facts: Fact[] = [];

    facts.push(ctx.evidence.fact({
      kind: "invoice.status",
      subject: { entity: "invoice", id: invoice_id },
      label: readerText(ctx.locale, "assistantTools.invoiceThreeWayStatus"),
      value: status,
      unit: "text",
      tool: explainInvoiceBlock.name,
      as_of: asOf,
      classification: "tenant_standard",
    }));
    facts.push(ctx.evidence.fact({
      kind: "invoice.total",
      subject: { entity: "invoice", id: invoice_id },
      label: readerText(ctx.locale, "assistantTools.invoiceAmountWithVat"),
      value: num(totals.invoice_grand),
      unit: "ils",
      tool: explainInvoiceBlock.name,
      as_of: asOf,
      classification: "financial_sensitive",
    }));
    facts.push(ctx.evidence.fact({
      kind: "metric.count",
      subject: { entity: "invoice", id: invoice_id },
      label: readerText(ctx.locale, "assistantTools.invoiceReasonCount"),
      value: reasons.length,
      unit: "count",
      tool: explainInvoiceBlock.name,
      as_of: asOf,
      classification: "tenant_standard",
    }));
    for (const reason of reasons) {
      const code = str(reason.code) ?? "unknown_reason";
      const severityKey = REASON_SEVERITY_KEYS[str(reason.severity) ?? ""];
      const severity = readerText(
        ctx.locale,
        severityKey ?? "assistantTools.severityUnknown",
      );
      facts.push(ctx.evidence.fact({
        kind: "invoice.block_reason",
        subject: { entity: "invoice", id: invoice_id },
        label: `${readerText(ctx.locale, "assistantTools.invoiceThreeWayReason")} (${severity})`,
        value: code,
        unit: "text",
        tool: explainInvoiceBlock.name,
        as_of: asOf,
        classification: "tenant_standard",
      }));
    }

    const source = ctx.evidence.source({
      entity: "invoice",
      entity_id: invoice_id,
      label: readerText(ctx.locale, "assistantTools.invoiceUnderReview"),
      route: `/invoices/${invoice_id}`,
      classification: "financial_sensitive",
    });

    return {
      data: [{
        invoice_id,
        status,
        severity: str(raw.severity),
        approval_blocked: raw.approval_blocked === true,
        approval_allowed: raw.approval_allowed === true,
        definite_duplicate_invoice: raw.definite_duplicate_invoice === true,
        comparison_state: str(raw.comparison_state),
        linked_order_count: num(raw.linked_order_count),
        override_active: raw.override_active === true,
        override_reason: override ? str(override.reason) : null,
        totals: {
          line_net: num(totals.line_net),
          line_vat: num(totals.line_vat),
          line_grand: num(totals.line_grand),
          invoice_net: num(totals.invoice_net),
          invoice_vat: num(totals.invoice_vat),
          invoice_grand: num(totals.invoice_grand),
          line_tolerance: num(totals.line_tolerance),
          invoice_tolerance: num(totals.invoice_tolerance),
        },
        // Verbatim: code + severity + the numbers each reason carries, exactly as the RPC
        // built them. Paraphrasing them into new prose is what this tool exists to avoid.
        reasons,
      }],
      complete: true,
      failures: [],
      filters: { invoice_id },
      as_of: asOf,
      result_count: 1,
      has_more: false,
      facts,
      sources: [source],
      warnings: [],
    };
  },
};
