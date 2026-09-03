// Tool 3 -- get_dashboard_snapshot: the management picture for the current business day.
// Every figure is the snapshot's own; a JSON null means "not measured" and stays null.
//
// MONEY IS PER CURRENCY (0218/0221). The live body of
// `public.management_dashboard_snapshot(date)` returns every money figure as
// `<name>ByCurrency` -- an ARRAY of `{currency, amount}` rows, or a JSON null when the guard
// above the aggregate found nothing to measure. The flat scalars this tool used to read
// (`openBalance`, `overdueAmount`, `sum`, `committed`, `remaining`) no longer exist, and
// `topBalances` is now `topBalancesByCurrency`: a list of per-currency groups, each with its own
// six biggest suppliers. So this emits ONE fact per currency, with the unit read off the row --
// never a sum across currencies, and never a hardcoded `ils`.
import { z } from "zod";
import type {
  DataClass,
  Fact,
  FactKind,
  SourceReference,
} from "../../../../src/lib/assistant/contracts.ts";
import type { AssistantTool, ToolContext } from "./registry.ts";
import { readerText } from "../reader-locale.ts";
import type { TKey } from "../../../../src/lib/i18n/t.ts";
import { fetchDashboardSnapshot } from "./dashboardSnapshot.ts";
import { currencyUnit, moneyByCurrency } from "./moneyByCurrency.ts";
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

interface MoneyMetricSpec extends MetricSpec {
  kind: FactKind;
  classification: DataClass;
}

// One row per snapshot COUNT. The labels state the measurement's own boundary -- especially the
// due-window figures, which cover ONLY payment requests that carry a due date (0148).
const COUNT_METRICS: readonly MetricSpec[] = [
  { block: "money", key: "openInvoiceCount", labelKey: "assistantTools.dashboardOpenInvoiceCount" },
  { block: "paymentRequests", key: "pendingApproval", labelKey: "assistantTools.dashboardPaymentPendingApproval" },
  { block: "paymentRequests", key: "drafts", labelKey: "assistantTools.dashboardPaymentDrafts" },
  { block: "paymentRequests", key: "activeCount", labelKey: "assistantTools.dashboardPaymentActive" },
  { block: "paymentRequests", key: "dueDateCoverage", labelKey: "assistantTools.dashboardPaymentDueDateCoverage" },
  { block: "paymentRequests", key: "overdue", labelKey: "assistantTools.dashboardPaymentOverdue" },
  { block: "paymentRequests", key: "dueToday", labelKey: "assistantTools.dashboardPaymentDueToday" },
  { block: "paymentRequests", key: "dueWithin7Count", labelKey: "assistantTools.dashboardPaymentDueWithin7Count" },
  { block: "credits", key: "count", labelKey: "assistantTools.dashboardCreditsCount" },
  { block: "bank", key: "unmatched", labelKey: "assistantTools.dashboardBankUnmatched", ownerOnly: true },
  { block: "bank", key: "suggested", labelKey: "assistantTools.dashboardBankSuggested", ownerOnly: true },
  { block: "invoices", key: "pendingApproval", labelKey: "assistantTools.dashboardInvoicesPendingApproval" },
  { block: "invoices", key: "toReview", labelKey: "assistantTools.dashboardInvoicesToReview" },
  { block: "invoices", key: "notSent", labelKey: "assistantTools.dashboardInvoicesNotSent" },
  { block: "openOrders", key: "count", labelKey: "assistantTools.dashboardOpenOrdersCount" },
  { block: "openOrders", key: "noDate", labelKey: "assistantTools.dashboardOpenOrdersNoDate" },
  { block: "openOrders", key: "late", labelKey: "assistantTools.dashboardOpenOrdersLate" },
  { block: "openOrders", key: "awaitingConfirmation", labelKey: "assistantTools.dashboardOpenOrdersAwaitingConfirmation" },
];

// One row per snapshot MONEY figure. Each of these keys is an array of per-currency rows, so each
// one becomes as many facts as the organisation has currencies with something to report -- and
// none at all when there is nothing to report, because there is no currency to say it in. The
// COUNT beside it is what says "none": `openInvoiceCount`, `credits.count`, `openOrders.count`
// and `dueDateCoverage` are measured zeros in exactly the cases where these arrive null.
const MONEY_METRICS: readonly MoneyMetricSpec[] = [
  { block: "money", key: "openBalanceByCurrency", kind: "metric.money", classification: "financial_sensitive", labelKey: "assistantTools.dashboardOpenBalance" },
  { block: "paymentRequests", key: "overdueAmountByCurrency", kind: "metric.money", classification: "financial_sensitive", labelKey: "assistantTools.dashboardPaymentOverdueAmount" },
  { block: "paymentRequests", key: "dueWithin7AmountByCurrency", kind: "metric.money", classification: "financial_sensitive", labelKey: "assistantTools.dashboardPaymentDueWithin7Amount" },
  { block: "credits", key: "sumByCurrency", kind: "credit.open_amount", classification: "financial_sensitive", labelKey: "assistantTools.dashboardCreditsSum" },
  { block: "openOrders", key: "committedByCurrency", kind: "metric.money", classification: "financial_sensitive", labelKey: "assistantTools.dashboardOpenOrdersCommitted" },
  { block: "openOrders", key: "remainingByCurrency", kind: "metric.money", classification: "financial_sensitive", labelKey: "assistantTools.dashboardOpenOrdersRemaining" },
];

export const getDashboardSnapshot: AssistantTool = {
  name: "get_dashboard_snapshot",
  description:
    "תמונת המצב הניהולית של היום העסקי הנוכחי (Asia/Jerusalem, מחושב בשרת): יתרה פתוחה, " +
    "דרישות תשלום — כולל הכסף שמועדו עבר והכסף שנופל בשבעת הימים הקרובים, שנמדדים רק על דרישות " +
    "עם תאריך יעד — זיכויים פתוחים, חשבוניות בטיפול והזמנות פתוחות. תנועות בנק ויתרות ספקים " +
    "(כולל היתרה הפתוחה הכוללת) נמדדים לבעלים בלבד; לתפקיד משרד הם מוחזרים ככשל מוצהר או null, " +
    "לעולם לא כאפס. ערך שאינו נמדד מוחזר null ולעולם אינו אפס. " +
    "כל סכום כסף מוחזר שורה לכל מטבע, עם קוד המטבע בתווית וביחידה. אין המרה בין מטבעות ואין " +
    "לחבר או להשוות סכומים ממטבעות שונים; מדד שאין לו אף שורת מטבע מוחזר ככשל מוצהר, לא כאפס.",
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

    // See MetricSpec.ownerOnly. For office these blocks are RLS-empty underneath the aggregate,
    // so the honest shape is a named refusal, never a zero that reads as a measurement. It stays
    // FIRST in the list: the money entries appended below are "not measured", not "not allowed".
    const failures: { code: string; label: string }[] = isOwner ? [] : [{
      code: "not_permitted",
      label: readerText(ctx.locale, "assistantTools.dashboardOfficeNotPermitted"),
    }];

    const facts: Fact[] = [];
    let unmeasured = 0;
    for (const metric of COUNT_METRICS) {
      if (metric.ownerOnly && !isOwner) continue;
      const block = record(snapshot[metric.block]) ?? {};
      const value = num(block[metric.key]);
      if (value === null) unmeasured += 1;
      facts.push(ctx.evidence.fact({
        kind: "metric.count",
        subject: null,
        label: readerText(ctx.locale, metric.labelKey),
        value,
        unit: "count",
        tool: getDashboardSnapshot.name,
        as_of: asOf,
        classification: "tenant_standard",
      }));
    }

    for (const metric of MONEY_METRICS) {
      if (metric.ownerOnly && !isOwner) continue;
      const block = record(snapshot[metric.block]) ?? {};
      const label = readerText(ctx.locale, metric.labelKey);
      const money = moneyByCurrency(block[metric.key]);
      // No rows means there is no currency in which this figure exists. Emitting a zero here
      // would be a claim about money; emitting `ils` would be a claim about a currency. Both are
      // inventions, so the honest answer is a named failure beside the count that says "none".
      if (money === null || money.rows.length === 0) {
        unmeasured += 1;
        failures.push({ code: `${metric.block}.${metric.key}:not_measured`, label });
        continue;
      }
      if (money.skipped > 0) {
        failures.push({ code: `${metric.block}.${metric.key}:currency_unrecognised`, label });
      }
      for (const row of money.rows) {
        if (row.amount === null) unmeasured += 1;
        facts.push(ctx.evidence.fact({
          kind: metric.kind,
          subject: null,
          label: `${label} (${row.currency})`,
          value: row.amount,
          unit: currencyUnit(row.currency),
          tool: getDashboardSnapshot.name,
          as_of: asOf,
          classification: metric.classification,
        }));
      }
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

    const warnings: string[] = [];
    if (unmeasured > 0) {
      warnings.push(
        readerText(ctx.locale, "assistantTools.dashboardNullWarning"),
      );
    }

    // `topBalancesByCurrency` is a list of per-currency GROUPS, each already ranked and capped at
    // six inside its own currency (the snapshot ranks per currency on purpose: "the six biggest"
    // across two currencies is a ranking of unlike numbers). One fact per supplier per currency,
    // with that group's currency as the unit -- the old flat list hardcoded `ils` here.
    const sources: SourceReference[] = [];
    let namedSuppliers = false;
    const seenSuppliers = new Set<string>();
    for (const groupEntry of isOwner ? list(snapshot.topBalancesByCurrency) : []) {
      const group = record(groupEntry);
      if (!group) continue;
      const currency = str(group.currency);
      // A group whose currency this product cannot name has no unit to state its money in.
      if (!currency || !/^[A-Z]{3}$/.test(currency)) {
        failures.push({
          code: "topBalancesByCurrency:currency_unrecognised",
          label: readerText(ctx.locale, "assistantTools.dashboardOpenSupplierCount"),
        });
        continue;
      }
      for (const entry of list(group.rows)) {
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
          label: `${readerText(ctx.locale, "assistantTools.dashboardSupplierOpenBalance", { name })} (${currency})`,
          value: balance,
          unit: currencyUnit(currency),
          tool: getDashboardSnapshot.name,
          as_of: asOf,
          classification: "financial_sensitive",
        }));
        // One supplier owed money in two currencies is ONE supplier to open, not two links.
        if (seenSuppliers.has(supplierId)) continue;
        seenSuppliers.add(supplierId);
        sources.push(ctx.evidence.source({
          entity: "supplier",
          entity_id: supplierId,
          label: name,
          route: `/suppliers/${supplierId}`,
          classification: "tenant_standard",
        }));
      }
    }
    if (namedSuppliers) warnings.push(UNTRUSTED_TEXT_WARNING);

    // The office copy also drops the unpermitted blocks from data -- an RLS-empty zero must not
    // survive into history or the browser either.
    const {
      bank: _bank,
      openSupplierCount: _openSupplierCount,
      topBalancesByCurrency: _topBalancesByCurrency,
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
