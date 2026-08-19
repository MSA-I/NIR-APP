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
  label: string;
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
  { block: "money", key: "openBalance", kind: "metric.money", unit: "ils", classification: "financial_sensitive", label: "יתרה פתוחה לספקים (חשבוניות payable בקיזוז תשלומים וזיכויים)" },
  { block: "money", key: "openInvoiceCount", kind: "metric.count", unit: "count", classification: "tenant_standard", label: "חשבוניות עם יתרה פתוחה" },
  { block: "paymentRequests", key: "pendingApproval", kind: "metric.count", unit: "count", classification: "tenant_standard", label: "דרישות תשלום הממתינות לאישור" },
  { block: "paymentRequests", key: "drafts", kind: "metric.count", unit: "count", classification: "tenant_standard", label: "דרישות תשלום בטיוטה" },
  { block: "paymentRequests", key: "activeCount", kind: "metric.count", unit: "count", classification: "tenant_standard", label: "דרישות תשלום פעילות (שאינן בוצעו/הותאמו/בוטלו)" },
  { block: "paymentRequests", key: "dueDateCoverage", kind: "metric.count", unit: "count", classification: "tenant_standard", label: "דרישות פעילות שהוזן להן תאריך יעד, מתוך הפעילות" },
  { block: "paymentRequests", key: "overdue", kind: "metric.count", unit: "count", classification: "tenant_standard", label: "דרישות עם תאריך יעד שכבר עבר (רק דרישות מתוארכות)" },
  { block: "paymentRequests", key: "overdueAmount", kind: "metric.money", unit: "ils", classification: "financial_sensitive", label: "סכום הדרישות שמועדן עבר (רק דרישות מתוארכות)" },
  { block: "paymentRequests", key: "dueToday", kind: "metric.count", unit: "count", classification: "tenant_standard", label: "דרישות שמועדן היום (רק דרישות מתוארכות)" },
  { block: "paymentRequests", key: "dueWithin7Count", kind: "metric.count", unit: "count", classification: "tenant_standard", label: "דרישות שמועדן בשבעת הימים הקרובים (רק דרישות מתוארכות)" },
  { block: "paymentRequests", key: "dueWithin7Amount", kind: "metric.money", unit: "ils", classification: "financial_sensitive", label: "סכום הדרישות שמועדן בשבעת הימים הקרובים (רק דרישות מתוארכות)" },
  { block: "credits", key: "count", kind: "metric.count", unit: "count", classification: "tenant_standard", label: "זיכויים פתוחים (open/requested/received)" },
  { block: "credits", key: "sum", kind: "credit.open_amount", unit: "ils", classification: "financial_sensitive", label: "סכום הזיכויים הפתוחים" },
  { block: "bank", key: "unmatched", kind: "metric.count", unit: "count", classification: "tenant_standard", label: "תנועות בנק ללא התאמה", ownerOnly: true },
  { block: "bank", key: "suggested", kind: "metric.count", unit: "count", classification: "tenant_standard", label: "תנועות בנק עם הצעת התאמה הממתינה לאדם", ownerOnly: true },
  { block: "invoices", key: "pendingApproval", kind: "metric.count", unit: "count", classification: "tenant_standard", label: "חשבוניות הממתינות לאישור" },
  { block: "invoices", key: "toReview", kind: "metric.count", unit: "count", classification: "tenant_standard", label: "חשבוניות שנקלטו וטרם נסקרו" },
  { block: "invoices", key: "notSent", kind: "metric.count", unit: "count", classification: "tenant_standard", label: "חשבוניות מאושרות שטרם נשלחו להנהלת חשבונות" },
  { block: "openOrders", key: "count", kind: "metric.count", unit: "count", classification: "tenant_standard", label: "הזמנות רכש פתוחות" },
  { block: "openOrders", key: "committed", kind: "metric.money", unit: "ils", classification: "financial_sensitive", label: "שווי ההזמנות הפתוחות במחירי ההזמנה" },
  { block: "openOrders", key: "remaining", kind: "metric.money", unit: "ils", classification: "financial_sensitive", label: "שווי הכמות שטרם התקבלה בהזמנות הפתוחות" },
  { block: "openOrders", key: "noDate", kind: "metric.count", unit: "count", classification: "tenant_standard", label: "הזמנות פתוחות ללא תאריך אספקה צפוי" },
  { block: "openOrders", key: "late", kind: "metric.count", unit: "count", classification: "tenant_standard", label: "הזמנות פתוחות שתאריך האספקה שלהן עבר" },
  { block: "openOrders", key: "awaitingConfirmation", kind: "metric.count", unit: "count", classification: "tenant_standard", label: "הזמנות שנשלחו וממתינות לאישור ספק" },
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
        label: metric.label,
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
        label: "ספקים עם יתרה פתוחה",
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
      label: "תנועות בנק ויתרות ספקים אינם נמדדים לתפקיד משרד (זמין לבעלים בלבד)",
    }];

    const warnings: string[] = [];
    if (unmeasured > 0) {
      warnings.push(
        "ערכי null בתמונה הם 'לא נמדד' — אין להציגם כאפס. היתרה הפתוחה אינה נמדדת לתפקיד משרד, וכסף לפי תאריך יעד אינו נמדד כשאין אף דרישה מתוארכת.",
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
      const name = sanitizeText(row.name, 60) || "ספק ללא שם";
      namedSuppliers = true;
      facts.push(ctx.evidence.fact({
        kind: "supplier.balance",
        subject: { entity: "supplier", id: supplierId },
        label: `יתרה פתוחה — ${name}`,
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
