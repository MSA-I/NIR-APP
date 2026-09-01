// Tool 3 -- get_dashboard_snapshot: the management picture for the current business day.
// Every figure is the snapshot's own; a JSON null means "not measured" and stays null.
import { z } from "zod";
import type {
  DataClass,
  Fact,
  FactKind,
  FactUnit,
  SourceReference,
} from "../../../../src/lib/assistant/contracts.ts";
import type { AssistantTool, ToolContext } from "./registry.ts";
import { readerText } from "../reader-locale.ts";
import type { TKey } from "../../../../src/lib/i18n/t.ts";
import { fetchDashboardSnapshot } from "./dashboardSnapshot.ts";
import {
  EMPTY_OBJECT_JSON_SCHEMA,
  list,
  num,
  record,
  sanitizeText,
  str,
  UNTRUSTED_TEXT_WARNING,
} from "./shared.ts";

const inputSchema = z.object({}).strict();

interface MetricSpec {
  block: string;
  key: string;
  kind: FactKind;
  unit: FactUnit;
  classification: DataClass;
  labelKey: TKey;
  /**
   * FINDING (role matrix vs. object gate): the snapshot gates itself to owner/office, but its
   * bank counts and supplier-balance rows read tables whose RLS stops at owner(+accountant) --
   * for office they come back as EMPTY, and the aggregate renders that refusal as a measured 0.
   * PRODUCT.md says office does not see bank, and OPEN-DECISIONS #151 says office does not see
   * open supplier balances. So these figures are emitted for owner only; office receives a named
   * not_permitted failure instead of a false zero.
   */
  ownerOnly?: boolean;
}

// One row per snapshot figure. The labels state the measurement's own boundary -- especially the
// due-window figures, which cover ONLY payment requests that carry a due date (0148).
const METRICS: readonly MetricSpec[] = [
  { block: "money", key: "openBalance", kind: "metric.money", unit: "ils", classification: "financial_sensitive", labelKey: "assistantTools.dashboardOpenBalance" },
  { block: "money", key: "openInvoiceCount", kind: "metric.count", unit: "count", classification: "tenant_standard", labelKey: "assistantTools.dashboardOpenInvoiceCount" },
  { block: "paymentRequests", key: "pendingApproval", kind: "metric.count", unit: "count", classification: "tenant_standard", labelKey: "assistantTools.dashboardPaymentPendingApproval" },
  { block: "paymentRequests", key: "drafts", kind: "metric.count", unit: "count", classification: "tenant_standard", labelKey: "assistantTools.dashboardPaymentDrafts" },
  { block: "paymentRequests", key: "activeCount", kind: "metric.count", unit: "count", classification: "tenant_standard", labelKey: "assistantTools.dashboardPaymentActive" },
  { block: "paymentRequests", key: "dueDateCoverage", kind: "metric.count", unit: "count", classification: "tenant_standard", labelKey: "assistantTools.dashboardPaymentDueDateCoverage" },
  { block: "paymentRequests", key: "overdue", kind: "metric.count", unit: "count", classification: "tenant_standard", labelKey: "assistantTools.dashboardPaymentOverdue" },
  { block: "paymentRequests", key: "overdueAmount", kind: "metric.money", unit: "ils", classification: "financial_sensitive", labelKey: "assistantTools.dashboardPaymentOverdueAmount" },
  { block: "paymentRequests", key: "dueToday", kind: "metric.count", unit: "count", classification: "tenant_standard", labelKey: "assistantTools.dashboardPaymentDueToday" },
  { block: "paymentRequests", key: "dueWithin7Count", kind: "metric.count", unit: "count", classification: "tenant_standard", labelKey: "assistantTools.dashboardPaymentDueWithin7Count" },
  { block: "paymentRequests", key: "dueWithin7Amount", kind: "metric.money", unit: "ils", classification: "financial_sensitive", labelKey: "assistantTools.dashboardPaymentDueWithin7Amount" },
  { block: "credits", key: "count", kind: "metric.count", unit: "count", classification: "tenant_standard", labelKey: "assistantTools.dashboardCreditsCount" },
  { block: "credits", key: "sum", kind: "credit.open_amount", unit: "ils", classification: "financial_sensitive", labelKey: "assistantTools.dashboardCreditsSum" },
  { block: "bank", key: "unmatched", kind: "metric.count", unit: "count", classification: "tenant_standard", labelKey: "assistantTools.dashboardBankUnmatched", ownerOnly: true },
  { block: "bank", key: "suggested", kind: "metric.count", unit: "count", classification: "tenant_standard", labelKey: "assistantTools.dashboardBankSuggested", ownerOnly: true },
  { block: "invoices", key: "pendingApproval", kind: "metric.count", unit: "count", classification: "tenant_standard", labelKey: "assistantTools.dashboardInvoicesPendingApproval" },
  { block: "invoices", key: "toReview", kind: "metric.count", unit: "count", classification: "tenant_standard", labelKey: "assistantTools.dashboardInvoicesToReview" },
  { block: "invoices", key: "notSent", kind: "metric.count", unit: "count", classification: "tenant_standard", labelKey: "assistantTools.dashboardInvoicesNotSent" },
  { block: "openOrders", key: "count", kind: "metric.count", unit: "count", classification: "tenant_standard", labelKey: "assistantTools.dashboardOpenOrdersCount" },
  { block: "openOrders", key: "committed", kind: "metric.money", unit: "ils", classification: "financial_sensitive", labelKey: "assistantTools.dashboardOpenOrdersCommitted" },
  { block: "openOrders", key: "remaining", kind: "metric.money", unit: "ils", classification: "financial_sensitive", labelKey: "assistantTools.dashboardOpenOrdersRemaining" },
  { block: "openOrders", key: "noDate", kind: "metric.count", unit: "count", classification: "tenant_standard", labelKey: "assistantTools.dashboardOpenOrdersNoDate" },
  { block: "openOrders", key: "late", kind: "metric.count", unit: "count", classification: "tenant_standard", labelKey: "assistantTools.dashboardOpenOrdersLate" },
  { block: "openOrders", key: "awaitingConfirmation", kind: "metric.count", unit: "count", classification: "tenant_standard", labelKey: "assistantTools.dashboardOpenOrdersAwaitingConfirmation" },
];

export const getDashboardSnapshot: AssistantTool = {
  name: "get_dashboard_snapshot",
  description:
    "תמונת המצב הניהולית של היום העסקי הנוכחי (Asia/Jerusalem, מחושב בשרת): יתרה פתוחה, " +
    "דרישות תשלום — כולל הכסף שמועדו עבר והכסף שנופל בשבעת הימים הקרובים, שנמדדים רק על דרישות " +
    "עם תאריך יעד — זיכויים פתוחים, חשבוניות בטיפול והזמנות פתוחות. תנועות בנק ויתרות ספקים " +
    "(כולל היתרה הפתוחה הכוללת) נמדדים לבעלים בלבד; לתפקיד משרד הם מוחזרים ככשל מוצהר או null, " +
    "לעולם לא כאפס. ערך שאינו נמדד מוחזר null ולעולם אינו אפס.",
  inputSchema,
  inputJsonSchema: EMPTY_OBJECT_JSON_SCHEMA,
  requiredRoles: ["owner", "office"],
  classification: "financial_sensitive",
  async run(ctx: ToolContext, input: unknown) {
    inputSchema.parse(input);
    const asOf = ctx.now().toISOString();
    const fetched = await fetchDashboardSnapshot(ctx);
    if (fetched.failed || !fetched.snapshot) return fetched.failed!;
    const snapshot = fetched.snapshot;

    const isOwner = ctx.actor.role === "owner";
    const facts: Fact[] = [];
    let unmeasured = 0;
    for (const metric of METRICS) {
      if (metric.ownerOnly && !isOwner) continue;
      const block = record(snapshot[metric.block]) ?? {};
      const value = num(block[metric.key]);
      if (value === null) unmeasured += 1;
      facts.push(ctx.evidence.fact({
        kind: metric.kind,
        subject: null,
        label: readerText(ctx.locale, metric.labelKey),
        value,
        unit: metric.unit,
        tool: getDashboardSnapshot.name,
        as_of: asOf,
        classification: metric.classification,
      }));
    }
    if (isOwner) {
      facts.push(ctx.evidence.fact({
        kind: "metric.count",
        subject: null,
        label: readerText(ctx.locale, "assistantTools.dashboardOpenSupplierCount"),
        value: num(snapshot.openSupplierCount),
        unit: "count",
        tool: getDashboardSnapshot.name,
        as_of: asOf,
        classification: "tenant_standard",
      }));
    }

    // See MetricSpec.ownerOnly. For office these blocks are RLS-empty underneath the aggregate,
    // so the honest shape is a named refusal, never a zero that reads as a measurement.
    const failures = isOwner ? [] : [{
      code: "not_permitted",
      label: readerText(ctx.locale, "assistantTools.dashboardOfficeNotPermitted"),
    }];

    const warnings: string[] = [];
    if (unmeasured > 0) {
      warnings.push(
        readerText(ctx.locale, "assistantTools.dashboardNullWarning"),
      );
    }

    const sources: SourceReference[] = [];
    let namedSuppliers = false;
    for (const entry of isOwner ? list(snapshot.topBalances) : []) {
      const row = record(entry);
      if (!row) continue;
      const supplierId = str(row.id);
      const balance = num(row.balance);
      if (!supplierId) continue;
      const name = sanitizeText(row.name, 60) || readerText(ctx.locale, "assistantTools.supplierUnnamed");
      namedSuppliers = true;
      facts.push(ctx.evidence.fact({
        kind: "supplier.balance",
        subject: { entity: "supplier", id: supplierId },
        label: readerText(ctx.locale, "assistantTools.dashboardSupplierOpenBalance", { name }),
        value: balance,
        unit: "ils",
        tool: getDashboardSnapshot.name,
        as_of: asOf,
        classification: "financial_sensitive",
      }));
      sources.push(ctx.evidence.source({
        entity: "supplier",
        entity_id: supplierId,
        label: name,
        route: `/suppliers/${supplierId}`,
        classification: "tenant_standard",
      }));
    }
    if (namedSuppliers) warnings.push(UNTRUSTED_TEXT_WARNING);

    // The office copy also drops the unpermitted blocks from data -- an RLS-empty zero must not
    // survive into history or the browser either.
    const {
      bank: _bank,
      openSupplierCount: _openSupplierCount,
      topBalances: _topBalances,
      ...officeSnapshot
    } = snapshot;

    return {
      data: [isOwner ? snapshot : officeSnapshot],
      complete: isOwner,
      failures,
      filters: { business_date: fetched.businessDate },
      as_of: asOf,
      result_count: 1,
      has_more: false,
      facts,
      sources,
      warnings,
    };
  },
};
