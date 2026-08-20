// The deterministic business tools: schema refusals, named failures instead of empty successes,
// null-stays-null, projections that never widen, and deltas that only ever come from the server.
// Every database interaction is a fake -- nothing here touches a live Supabase.
import assert from "node:assert/strict";
import type { ActorContext } from "../../../../src/lib/assistant/contracts.ts";
import { compareOrderReceiptInvoice } from "./compareOrderReceiptInvoice.ts";
import { explainInvoiceBlock } from "./explainInvoiceBlock.ts";
import { findEntity } from "./findEntity.ts";
import { getDashboardSnapshot } from "./getDashboardSnapshot.ts";
import { getInventoryRisk } from "./getInventoryRisk.ts";
import { getOpenCredits } from "./getOpenCredits.ts";
import { getOrdersAwaitingConfirmation } from "./getOrdersAwaitingConfirmation.ts";
import { getPaymentExposure } from "./getPaymentExposure.ts";
import { getPurchaseMetrics } from "./getPurchaseMetrics.ts";
import { getSupplierPerformance } from "./getSupplierPerformance.ts";
import { getUnmatchedBankTransactions } from "./getUnmatchedBankTransactions.ts";
import {
  buildRegistry,
  RunEvidence,
  runRegisteredTool,
  serializeEnvelopeForProvider,
  type ToolContext,
} from "./registry.ts";
import type { ReadError, RowsResult, ToolReads } from "./reads.ts";
import { deterministicBusinessTools } from "./business.ts";

const INVOICE_ID = "11111111-1111-4111-8111-111111111111";
const SUPPLIER_ID = "22222222-2222-4222-8222-222222222222";
const ORDER_ID = "33333333-3333-4333-8333-333333333333";

function actor(role: ActorContext["role"] = "owner"): ActorContext {
  return {
    userId: "44444444-4444-4444-8444-444444444444",
    orgId: "55555555-5555-4555-8555-555555555555",
    role,
    scopes: [],
    canWrite: true,
    capabilities: { ui: true, history: false, drafts: false, confirmedActions: false },
  };
}

function emptyRows<T>(): RowsResult<T> {
  return { rows: [], hasMore: false, error: null };
}

function failedRows<T>(message: string): RowsResult<T> {
  return { rows: null, hasMore: false, error: { message } };
}

interface FakeDbConfig {
  rpc?: Record<string, { data: unknown; error: ReadError | null }>;
  reads?: Partial<ToolReads>;
}

function fakeDb(config: FakeDbConfig = {}): ToolReads {
  return {
    rpc(name) {
      const canned = config.rpc?.[name];
      if (!canned) return Promise.resolve({ data: null, error: { message: `no fake for ${name}` } });
      return Promise.resolve(canned);
    },
    countSentOrders: () => Promise.resolve({ count: 0, error: null }),
    listSentOrders: () => Promise.resolve(emptyRows()),
    listUnmatchedBankTransactions: () => Promise.resolve(emptyRows()),
    listSupplierMetrics: () => Promise.resolve(emptyRows()),
    listSupplierNames: () => Promise.resolve({ rows: [], error: null }),
    listSupplierOpenCredits: () => Promise.resolve(emptyRows()),
    listInventoryRisk: () => Promise.resolve(emptyRows()),
    ...config.reads,
  };
}

function ctxWith(db: ToolReads, role: ActorContext["role"] = "owner"): ToolContext {
  return {
    db,
    actor: actor(role),
    evidence: new RunEvidence(),
    now: () => new Date("2026-08-20T08:00:00.000Z"),
  };
}

/* ============================================================================
 * Input schemas refuse malformed input
 * ==========================================================================*/

Deno.test("input schemas reject what they must", () => {
  assert.equal(explainInvoiceBlock.inputSchema.safeParse({ invoice_id: "4471" }).success, false);
  assert.equal(explainInvoiceBlock.inputSchema.safeParse({}).success, false);
  assert.equal(
    compareOrderReceiptInvoice.inputSchema.safeParse({ invoice_id: INVOICE_ID, extra: 1 }).success,
    false,
  );
  assert.equal(getPurchaseMetrics.inputSchema.safeParse({ window: "calendar_month" }).success, false);
  assert.equal(getSupplierPerformance.inputSchema.safeParse({ limit: 0 }).success, false);
  assert.equal(getSupplierPerformance.inputSchema.safeParse({ limit: 5000 }).success, false);
  assert.equal(getInventoryRisk.inputSchema.safeParse({ limit: 2.5 }).success, false);
  assert.equal(findEntity.inputSchema.safeParse({ query: "x" }).success, false);
  assert.equal(findEntity.inputSchema.safeParse({ query: "מלפפון", kind: "budget" }).success, false);
  // And the well-formed baseline parses, so the refusals above are the schema, not a typo.
  assert.equal(explainInvoiceBlock.inputSchema.safeParse({ invoice_id: INVOICE_ID }).success, true);
  assert.equal(getPurchaseMetrics.inputSchema.safeParse({}).success, true);
});

/* ============================================================================
 * A failing underlying call is a named failure, never an empty success
 * ==========================================================================*/

Deno.test("three-way lookup failure yields complete:false with a named failure", async () => {
  const envelope = await explainInvoiceBlock.run(
    ctxWith(fakeDb({ rpc: { get_invoice_three_way_match: { data: null, error: { message: "boom" } } } })),
    { invoice_id: INVOICE_ID },
  );
  assert.equal(envelope.complete, false);
  assert.equal(envelope.failures[0].code, "three_way_lookup_failed");
  assert.deepEqual(envelope.data, []);
  assert.deepEqual(envelope.facts, []);
});

Deno.test("invoice_not_found maps to its own safe code, without raw database text", async () => {
  const envelope = await explainInvoiceBlock.run(
    ctxWith(fakeDb({
      rpc: {
        get_invoice_three_way_match: {
          data: null,
          error: { message: 'invoice_not_found: relation "public.invoices" row missing' },
        },
      },
    })),
    { invoice_id: INVOICE_ID },
  );
  assert.equal(envelope.complete, false);
  assert.equal(envelope.failures[0].code, "invoice_not_found");
  assert.ok(!JSON.stringify(envelope).includes("relation"));
});

Deno.test("a failed read is a named failure for every table-backed tool", async () => {
  const supplier = await getSupplierPerformance.run(
    ctxWith(fakeDb({ reads: { listSupplierMetrics: () => Promise.resolve(failedRows("x")) } })),
    {},
  );
  assert.equal(supplier.complete, false);
  assert.equal(supplier.failures[0].code, "supplier_metrics_failed");

  const bank = await getUnmatchedBankTransactions.run(
    ctxWith(
      fakeDb({ reads: { listUnmatchedBankTransactions: () => Promise.resolve(failedRows("x")) } }),
    ),
    {},
  );
  assert.equal(bank.complete, false);
  assert.equal(bank.failures[0].code, "bank_transactions_failed");

  const inventory = await getInventoryRisk.run(
    ctxWith(fakeDb({ reads: { listInventoryRisk: () => Promise.resolve(failedRows("x")) } })),
    {},
  );
  assert.equal(inventory.complete, false);
  assert.equal(inventory.failures[0].code, "inventory_risk_failed");

  const orders = await getOrdersAwaitingConfirmation.run(
    ctxWith(fakeDb({ reads: { listSentOrders: () => Promise.resolve(failedRows("x")) } })),
    {},
  );
  assert.equal(orders.complete, false);
  assert.equal(orders.failures[0].code, "orders_awaiting_confirmation_failed");

  const search = await findEntity.run(
    ctxWith(fakeDb({ rpc: { global_search: { data: null, error: { message: "x" } } } })),
    { query: "אחים כהן" },
  );
  assert.equal(search.complete, false);
  assert.equal(search.failures[0].code, "entity_search_failed");
});

Deno.test("a snapshot NULL (the role gate) is a refusal, never a clean sheet", async () => {
  const envelope = await getDashboardSnapshot.run(
    ctxWith(fakeDb({ rpc: { management_dashboard_snapshot: { data: null, error: null } } })),
    {},
  );
  assert.equal(envelope.complete, false);
  assert.equal(envelope.failures[0].code, "not_permitted");
});

Deno.test("registry role gate refuses an accountant before the dashboard tool runs", async () => {
  const registry = buildRegistry(deterministicBusinessTools);
  const envelope = await runRegisteredTool(
    registry,
    ctxWith(fakeDb(), "accountant"),
    "get_dashboard_snapshot",
    {},
  );
  assert.equal(envelope.complete, false);
  assert.equal(envelope.failures[0].code, "not_permitted");
});

/* ============================================================================
 * Unmeasured stays null and never becomes 0
 * ==========================================================================*/

const SNAPSHOT_WITH_NULLS = {
  money: { openBalance: null, openInvoiceCount: 0 },
  paymentRequests: {
    pendingApproval: 0,
    drafts: 0,
    activeCount: 3,
    dueDateCoverage: 0,
    overdue: null,
    overdueAmount: null,
    dueToday: null,
    dueWithin7Count: null,
    dueWithin7Amount: null,
  },
  credits: { count: 0, sum: null },
  bank: { unmatched: 2, suggested: 1 },
  invoices: { pendingApproval: 1, toReview: 0, notSent: 0 },
  openOrders: {
    count: 0,
    committed: null,
    remaining: 0,
    noDate: 0,
    late: 0,
    awaitingConfirmation: 0,
  },
  openSupplierCount: 0,
  topBalances: [],
};

Deno.test("dashboard nulls survive as null facts; measured zeros stay zero", async () => {
  const envelope = await getDashboardSnapshot.run(
    ctxWith(fakeDb({
      rpc: { management_dashboard_snapshot: { data: SNAPSHOT_WITH_NULLS, error: null } },
    })),
    {},
  );
  assert.equal(envelope.complete, true);
  const byLabel = new Map(envelope.facts.map((fact) => [fact.label, fact.value]));
  assert.equal(byLabel.get("יתרה פתוחה לספקים (חשבוניות payable בקיזוז תשלומים וזיכויים)"), null);
  assert.equal(byLabel.get("סכום הזיכויים הפתוחים"), null);
  assert.equal(byLabel.get("חשבוניות עם יתרה פתוחה"), 0);
  assert.equal(byLabel.get("תנועות בנק ללא התאמה"), 2);
  for (const fact of envelope.facts) {
    assert.notEqual(fact.value, undefined);
    if (fact.value === null) continue;
    assert.ok(Number.isFinite(fact.value as number) || typeof fact.value === "string");
  }
});

Deno.test("office never receives the snapshot's RLS-empty bank and balance zeros", async () => {
  // For office, bank_transactions RLS (owner+accountant) and p0_supplier_balance_rows
  // (owner+accountant) return zero rows UNDER the aggregate, so the snapshot's 0s are refusals
  // wearing a measurement's clothes. The tool must convert them to a named failure.
  const envelope = await getDashboardSnapshot.run(
    ctxWith(
      fakeDb({
        rpc: { management_dashboard_snapshot: { data: SNAPSHOT_WITH_NULLS, error: null } },
      }),
      "office",
    ),
    {},
  );
  assert.equal(envelope.complete, false);
  assert.equal(envelope.failures[0].code, "not_permitted");
  assert.equal(
    envelope.facts.some((fact) => fact.label.includes("תנועות בנק")),
    false,
    "a bank count fact leaked to office",
  );
  assert.equal(
    envelope.facts.some((fact) => fact.label === "ספקים עם יתרה פתוחה"),
    false,
    "the open-supplier count leaked to office",
  );
  const data = envelope.data[0] as Record<string, unknown>;
  assert.equal("bank" in data, false);
  assert.equal("openSupplierCount" in data, false);
  assert.equal("topBalances" in data, false);
  // The open balance itself stays, as the null the snapshot computes for office by design.
  const openBalance = envelope.facts.find((fact) =>
    fact.label.startsWith("יתרה פתוחה לספקים")
  );
  assert.equal(openBalance?.value, null);
});

Deno.test("owner still receives the bank counts the office test strips", async () => {
  const envelope = await getDashboardSnapshot.run(
    ctxWith(fakeDb({
      rpc: { management_dashboard_snapshot: { data: SNAPSHOT_WITH_NULLS, error: null } },
    })),
    {},
  );
  assert.equal(envelope.complete, true);
  assert.deepEqual(envelope.failures, []);
  assert.equal(
    envelope.facts.some((fact) => fact.label === "תנועות בנק ללא התאמה"),
    true,
  );
});

Deno.test("purchase metrics relays the product's own net definition, never a restatement", async () => {
  const envelope = await getPurchaseMetrics.run(
    ctxWith(fakeDb({
      rpc: {
        get_purchase_metrics: {
          data: {
            gross_expense: 100,
            gross_invoice_count: 1,
            net_expense: 100,
            net_definition: "gross_minus_offset_and_closed_credits",
          },
          error: null,
        },
      },
    })),
    {},
  );
  assert.equal(envelope.filters.net_definition, "gross_minus_offset_and_closed_credits");
  assert.equal(
    envelope.warnings.some((warning) =>
      warning.includes("gross_minus_offset_and_closed_credits")
    ),
    true,
    "the relayed definition is not in the warnings",
  );
});

Deno.test("payment exposure keeps nulls null and always carries the coverage", async () => {
  const envelope = await getPaymentExposure.run(
    ctxWith(fakeDb({
      rpc: { management_dashboard_snapshot: { data: SNAPSHOT_WITH_NULLS, error: null } },
    })),
    {},
  );
  assert.equal(envelope.complete, true);
  const byLabel = new Map(envelope.facts.map((fact) => [fact.label, fact.value]));
  assert.equal(byLabel.get("סכום דרישות שמועדן עבר (רק דרישות מתוארכות)"), null);
  assert.equal(
    byLabel.get("דרישות פעילות עם תאריך יעד (הכיסוי של כל מדדי החשיפה)"),
    0,
  );
  assert.equal(byLabel.get("דרישות תשלום פעילות"), 3);
  assert.equal(envelope.sources[0]?.entity, "organization");
  assert.equal(envelope.sources[0]?.entity_id, actor().orgId);
});

Deno.test("an unmeasured on_time_pct stays null and the sample size travels beside it", async () => {
  const envelope = await getSupplierPerformance.run(
    ctxWith(fakeDb({
      reads: {
        listSupplierMetrics: () =>
          Promise.resolve({
            rows: [{
              supplier_id: SUPPLIER_ID,
              open_orders: 1,
              late_open_orders: 0,
              otd_samples: 0,
              otd_on_time: 0,
              on_time_pct: null,
              lead_samples: 0,
              avg_lead_days: null,
              open_exceptions: 0,
              open_credits: 0,
              open_credits_amount: 0,
              price_changes_window: 0,
              last_price_change: null,
            }],
            hasMore: false,
            error: null,
          }),
        listSupplierNames: () =>
          Promise.resolve({ rows: [{ id: SUPPLIER_ID, name: "אחים כהן" }], error: null }),
      },
    })),
    {},
  );
  assert.equal(envelope.complete, true);
  const pct = envelope.facts.find((fact) => fact.label.startsWith("אחוז אספקה בזמן"));
  const samples = envelope.facts.find((fact) =>
    fact.label.startsWith("מספר האספקות המתוארכות")
  );
  assert.equal(pct?.value, null);
  assert.equal(samples?.value, 0);
  assert.ok(pct?.label.includes("180"));
});

Deno.test("purchase metrics passes the server's nulls through untouched", async () => {
  const envelope = await getPurchaseMetrics.run(
    ctxWith(fakeDb({
      rpc: {
        get_purchase_metrics: {
          data: {
            from: "2026-07-21",
            to: "2026-08-20",
            time_zone: "Asia/Jerusalem",
            committed: null,
            committed_order_count: 0,
            gross_expense: 1234.56,
            gross_invoice_count: 3,
            credits_recognised: null,
            credits_pending: null,
            net_expense: 1234.56,
            net_definition: "gross_minus_offset_and_closed_credits",
          },
          error: null,
        },
      },
    })),
    { window: "last_30_days" },
  );
  assert.equal(envelope.complete, true);
  const byLabel = new Map(envelope.facts.map((fact) => [fact.label, fact.value]));
  assert.equal(
    byLabel.get("התחייבות בהזמנות (במחירי הזמנה, לפי יום יצירה עסקי) — 30 הימים האחרונים"),
    null,
  );
  assert.equal(
    byLabel.get("הוצאה ברוטו (חשבוניות מאושרות, לפי תאריך החשבונית) — 30 הימים האחרונים"),
    1234.56,
  );
});

Deno.test("purchase metrics window anchors on the business day with the product's trailing shape", async () => {
  let captured: Record<string, unknown> | undefined;
  const db = fakeDb();
  db.rpc = (name, args) => {
    captured = args;
    return Promise.resolve({
      data: { committed: null },
      error: null,
    });
  };
  await getPurchaseMetrics.run(ctxWith(db), { window: "last_7_days" });
  // 2026-08-20T08:00Z is 11:00 in Asia/Jerusalem -- the business day is the 20th, and the
  // trailing window is `>= today - 7` (0165's shape), so from is the 13th.
  assert.equal(captured?.p_to, "2026-08-20");
  assert.equal(captured?.p_from, "2026-08-13");
});

Deno.test("inventory nulls stay null: an uncounted product never reads as zero stock", async () => {
  const envelope = await getInventoryRisk.run(
    ctxWith(fakeDb({
      reads: {
        listInventoryRisk: () =>
          Promise.resolve({
            rows: [{
              product_id: "66666666-6666-4666-8666-666666666666",
              product_name: "קמח",
              unit: 'ק"ג',
              min_stock: 10,
              quantity_on_hand: null,
              is_counted: false,
              last_counted_at: null,
              consumption_sample_count: null,
              average_daily_consumption: null,
              projected_stockout_days: null,
              suggested_reorder_quantity: null,
              expected_incoming_quantity: 0,
              incoming_without_date_quantity: 0,
              next_expected_incoming_date: null,
            }],
            hasMore: false,
            error: null,
          }),
      },
    })),
    {},
  );
  const onHand = envelope.facts.find((fact) => fact.label.startsWith("כמות במלאי"));
  const stockout = envelope.facts.find((fact) => fact.label.startsWith("ימים חזויים"));
  assert.equal(onHand?.value, null);
  assert.equal(stockout?.value, null);
});

/* ============================================================================
 * Deltas come from the RPC; totals come from snapshots; projections never widen
 * ==========================================================================*/

Deno.test("compare surfaces the RPC's own difference numbers, verbatim", async () => {
  const raw = {
    invoice_id: INVOICE_ID,
    status: "review_required",
    severity: "error",
    approval_blocked: true,
    definite_duplicate_invoice: false,
    comparison_state: "comparable",
    linked_order_count: 1,
    override_active: false,
    override: null,
    approval_allowed: false,
    totals: { line_grand: 117, invoice_grand: 117 },
    reasons: [],
    order_items: [{
      purchase_order_item_id: "77777777-7777-4777-8777-777777777777",
      purchase_order_id: ORDER_ID,
      ordered_quantity: 10,
      received_quantity: 8,
      prior_approved_invoiced_quantity: 0,
      current_invoice_quantity: 9,
      invoiced_quantity: 9,
      unit: 'ק"ג',
      unit_resolved: true,
    }],
    lines: [{
      id: "88888888-8888-4888-8888-888888888888",
      line_number: 1,
      description: "עגבניות שרי",
      quantity: 9,
      unit: 'ק"ג',
      unit_price: 13,
      line_total: 117,
      reasons: [{
        code: "unit_price_above_order",
        severity: "error",
        difference_amount: 1.5,
        difference_percent: 13.0435,
      }],
      matches: [{
        purchase_order_item_id: "77777777-7777-4777-8777-777777777777",
        purchase_order_id: ORDER_ID,
      }],
    }],
  };
  const envelope = await compareOrderReceiptInvoice.run(
    ctxWith(fakeDb({ rpc: { get_invoice_three_way_match: { data: raw, error: null } } })),
    { invoice_id: INVOICE_ID },
  );
  assert.equal(envelope.complete, true);
  const ilsDelta = envelope.facts.find((fact) => fact.kind === "order_invoice.delta");
  const pctDelta = envelope.facts.find((fact) => fact.kind === "metric.percent");
  assert.equal(ilsDelta?.value, 1.5);
  assert.equal(pctDelta?.value, 13.0435);
  const ordered = envelope.facts.find((fact) => fact.label.startsWith("כמות שהוזמנה"));
  const received = envelope.facts.find((fact) => fact.label.startsWith("כמות שהתקבלה"));
  const invoiced = envelope.facts.find((fact) => fact.label.startsWith("כמות שחויבה"));
  assert.equal(ordered?.value, 10);
  assert.equal(received?.value, 8);
  assert.equal(invoiced?.value, 9);
});

Deno.test("explain surfaces each reason as a fact carrying the server's code", async () => {
  const raw = {
    invoice_id: INVOICE_ID,
    status: "review_required",
    severity: "critical",
    approval_blocked: true,
    definite_duplicate_invoice: true,
    comparison_state: "comparable",
    linked_order_count: 1,
    override_active: false,
    override: null,
    approval_allowed: false,
    totals: { invoice_grand: 500 },
    reasons: [
      { code: "definite_duplicate_invoice", severity: "critical" },
      { code: "invoice_net_total_discrepancy", severity: "error", tolerance: 1 },
    ],
    order_items: [],
    lines: [],
  };
  const envelope = await explainInvoiceBlock.run(
    ctxWith(fakeDb({ rpc: { get_invoice_three_way_match: { data: raw, error: null } } })),
    { invoice_id: INVOICE_ID },
  );
  const reasonFacts = envelope.facts.filter((fact) => fact.kind === "invoice.block_reason");
  assert.deepEqual(reasonFacts.map((fact) => fact.value), [
    "definite_duplicate_invoice",
    "invoice_net_total_discrepancy",
  ]);
  const total = envelope.facts.find((fact) => fact.kind === "invoice.total");
  assert.equal(total?.value, 500);
  assert.equal(envelope.sources[0].route, `/invoices/${INVOICE_ID}`);
});

Deno.test("order totals are the sum of the order's own snapshots and has_more is honest", async () => {
  const envelope = await getOrdersAwaitingConfirmation.run(
    ctxWith(fakeDb({
      reads: {
        listSentOrders: () =>
          Promise.resolve({
            rows: [{
              id: ORDER_ID,
              number: 42,
              status: "sent",
              expected_date: null,
              sent_at: "2026-08-18T10:00:00Z",
              created_at: "2026-08-18T09:00:00Z",
              supplier_id: SUPPLIER_ID,
              suppliers: { name: "אחים כהן" },
              purchase_order_items: [
                { qty: 2, unit_price: 10 },
                { qty: 1, unit_price: 5.55 },
              ],
            }],
            hasMore: true,
            error: null,
          }),
      },
    })),
    {},
  );
  const total = envelope.facts.find((fact) => fact.kind === "order.total");
  assert.equal(total?.value, 25.55);
  assert.equal(envelope.has_more, true);
  const count = envelope.facts.find((fact) => fact.kind === "metric.count");
  assert.ok(String(count?.label).includes("קיימות נוספות"));
});

Deno.test("bank rows carry exactly the operational projection and nothing more", async () => {
  const envelope = await getUnmatchedBankTransactions.run(
    ctxWith(
      fakeDb({
        reads: {
          listUnmatchedBankTransactions: () =>
            Promise.resolve({
              rows: [{
                id: "99999999-9999-4999-8999-999999999999",
                tx_date: "2026-08-19",
                description: "העברה לספק\n בע\"מ",
                amount: 1200,
                is_debit: true,
                status: "unmatched",
              }],
              hasMore: false,
              error: null,
            }),
        },
      }),
      "accountant",
    ),
    {},
  );
  assert.equal(envelope.complete, true);
  const row = envelope.data[0] as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(row).sort(),
    ["amount", "description", "id", "is_debit", "status", "tx_date"],
  );
  // Control characters are gone; the text survives as data.
  assert.equal(row.description, 'העברה לספק בע"מ');
  const amount = envelope.facts.find((fact) => fact.kind === "metric.money");
  assert.equal(amount?.value, 1200);
  const providerPayload = JSON.stringify(serializeEnvelopeForProvider(envelope));
  assert.ok(!providerPayload.includes("העברה לספק"));
});

Deno.test("find_entity never surfaces a supplier's contact subtitle", async () => {
  const hits = [
    {
      entity: "supplier",
      id: SUPPLIER_ID,
      title: "אחים כהן",
      subtitle: "יוסי כהן · 050-1234567",
      status: "active",
      amount: null,
      occurred_at: null,
      rank: 1,
    },
    {
      entity: "invoice",
      id: INVOICE_ID,
      title: "4471",
      subtitle: "אחים כהן",
      status: "unpaid",
      amount: 500,
      occurred_at: "2026-08-01",
      rank: 1,
    },
    {
      entity: "draft",
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "#7",
      subtitle: null,
      status: "draft",
      amount: null,
      occurred_at: null,
      rank: 2,
    },
  ];
  const envelope = await findEntity.run(
    ctxWith(fakeDb({ rpc: { global_search: { data: hits, error: null } } })),
    { query: "אחים" },
  );
  assert.equal(envelope.result_count, 2, "the draft hit has no evidence entity and is dropped");
  const serialized = JSON.stringify(envelope);
  assert.ok(!serialized.includes("050-1234567"), "supplier contact subtitle leaked");
  assert.ok(!serialized.includes("יוסי"), "supplier contact name leaked");
  const invoiceRow = (envelope.data as { entity: string; label: string; route: string | null }[])
    .find((row) => row.entity === "invoice");
  assert.equal(invoiceRow?.label, "4471 — אחים כהן");
  assert.equal(invoiceRow?.route, `/invoices/${INVOICE_ID}`);
  const amountFact = envelope.facts.find((fact) => fact.kind === "invoice.total");
  assert.equal(amountFact?.value, 500);
});

Deno.test("find_entity kind filter narrows to the requested type", async () => {
  const hits = [
    { entity: "supplier", id: SUPPLIER_ID, title: "אחים כהן", subtitle: null },
    { entity: "invoice", id: INVOICE_ID, title: "4471", subtitle: "אחים כהן" },
  ];
  const envelope = await findEntity.run(
    ctxWith(fakeDb({ rpc: { global_search: { data: hits, error: null } } })),
    { query: "אחים", kind: "supplier" },
  );
  assert.equal(envelope.result_count, 1);
  assert.equal((envelope.data[0] as { entity: string }).entity, "supplier");
});

Deno.test("find_entity overfetches one hit per type and reports honest has_more", async () => {
  let perType: unknown = null;
  const hits = Array.from({ length: 6 }, (_, index) => ({
    entity: "supplier",
    id: `22222222-2222-4222-8222-${String(index + 1).padStart(12, "0")}`,
    title: `ספק ${index + 1}`,
    subtitle: null,
  }));
  const db = fakeDb();
  db.rpc = (_name, args) => {
    perType = args?.per_type;
    return Promise.resolve({ data: hits, error: null });
  };
  const envelope = await findEntity.run(
    ctxWith(db),
    { query: "ספק", kind: "supplier" },
  );
  assert.equal(perType, 6);
  assert.equal(envelope.result_count, 5);
  assert.equal(envelope.sources.length, 5);
  assert.equal(envelope.has_more, true);
});

Deno.test("supplier performance refuses to answer an undefined lateness ranking", () => {
  assert.ok(
    getSupplierPerformance.description.includes(
      "אינו עונה מי הספק שמאחר הכי הרבה",
    ),
  );
});

Deno.test("open credits: a failed per-supplier breakdown degrades to complete:false", async () => {
  const envelope = await getOpenCredits.run(
    ctxWith(fakeDb({
      rpc: { management_dashboard_snapshot: { data: SNAPSHOT_WITH_NULLS, error: null } },
      reads: { listSupplierOpenCredits: () => Promise.resolve(failedRows("x")) },
    })),
    {},
  );
  assert.equal(envelope.complete, false);
  assert.equal(envelope.failures[0].code, "supplier_credit_breakdown_failed");
  // The org-wide figures that DID measure are still there -- zero credits, null sum.
  const count = envelope.facts.find((fact) =>
    fact.label.startsWith("זיכויים פתוחים (open/requested/received)")
  );
  const sum = envelope.facts.find((fact) => fact.kind === "credit.open_amount");
  assert.equal(count?.value, 0);
  assert.equal(sum?.value, null);
  assert.equal(envelope.sources[0]?.entity, "organization");
  assert.equal(envelope.sources[0]?.entity_id, actor().orgId);
});

Deno.test("every tool declares roles, a Hebrew description and a strict JSON schema", () => {
  assert.equal(deterministicBusinessTools.length, 11);
  for (const tool of deterministicBusinessTools) {
    assert.ok(tool.requiredRoles.length > 0, `${tool.name} has no roles`);
    assert.ok(/[֐-׿]/.test(tool.description), `${tool.name} description is not Hebrew`);
    const schema = tool.inputJsonSchema as { additionalProperties?: boolean };
    assert.equal(schema.additionalProperties, false, `${tool.name} schema is not strict`);
  }
  const names = new Set(deterministicBusinessTools.map((tool) => tool.name));
  assert.equal(names.size, 11);
});
