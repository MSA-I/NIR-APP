// The two read-model tools added for OPEN-DECISIONS #189 and #190. Every database interaction is a
// fake -- nothing here touches a live Supabase. What is asserted is the part a live database cannot
// prove: that the tool relays the server's numbers instead of restating them, that "cannot measure"
// never turns into a zero, that a supplier minimum comes back as a breach rather than as a raised
// quantity, and that the saving is the shared formula's answer and not a second implementation.
import assert from "node:assert/strict";
import type { ActorContext } from "../../../../src/lib/assistant/contracts.ts";
import { compareLine, summarizeComparison } from "../../../../src/lib/orderComparison.ts";
import { assistantSourceRouteDecision } from "../../../../src/lib/assistant/routeAccess.ts";
import { getMonthlyPriceRises } from "./getMonthlyPriceRises.ts";
import { getPurchaseComparison } from "./getPurchaseComparison.ts";
import { deterministicBusinessTools } from "./business.ts";
import { buildRegistry, RunEvidence, runRegisteredTool, type ToolContext } from "./registry.ts";
import type { ReadError, RowsResult, ToolReads } from "./reads.ts";

const ORG_ID = "55555555-5555-4555-8555-555555555555";
const SUPPLIER_A = "aaaaaaaa-1111-4111-8111-111111111111";
const SUPPLIER_B = "bbbbbbbb-2222-4222-8222-222222222222";
const PRODUCT_A = "cccccccc-3333-4333-8333-333333333333";
const PRODUCT_B = "dddddddd-4444-4444-8444-444444444444";
const REQUEST_ID = "eeeeeeee-5555-4555-8555-555555555555";

function actor(role: ActorContext["role"] = "owner"): ActorContext {
  return {
    userId: "44444444-4444-4444-8444-444444444444",
    orgId: ORG_ID,
    role,
    scopes: [],
    canWrite: true,
    capabilities: { ui: true, history: false, drafts: false, confirmedActions: false },
  };
}

function emptyRows<T>(): RowsResult<T> {
  return { rows: [], hasMore: false, error: null };
}

function fakeDb(
  rpc: Record<string, { data: unknown; error: ReadError | null }> = {},
): ToolReads {
  return {
    rpc(name) {
      const canned = rpc[name];
      if (!canned) {
        return Promise.resolve({ data: null, error: { message: `no fake for ${name}` } });
      }
      return Promise.resolve(canned);
    },
    countSentOrders: () => Promise.resolve({ count: 0, error: null }),
    listSentOrders: () => Promise.resolve(emptyRows()),
    listUnmatchedBankTransactions: () => Promise.resolve(emptyRows()),
    listSupplierMetrics: () => Promise.resolve(emptyRows()),
    listSupplierNames: () => Promise.resolve({ rows: [], error: null }),
    listSupplierOpenCredits: () => Promise.resolve(emptyRows()),
    listInventoryRisk: () => Promise.resolve(emptyRows()),
    ...rpc.reads as unknown as Partial<ToolReads>,
  };
}

function ctxWith(db: ToolReads, role: ActorContext["role"] = "owner"): ToolContext {
  return {
    db,
    actor: actor(role),
    evidence: new RunEvidence(),
    now: () => new Date("2026-08-20T08:00:00.000Z"),
    locale: "he",
  };
}

const MONTH_START = "2026-08-01T00:00:00+03:00";
const MONTH_END = "2026-09-01T00:00:00+03:00";

function riseRow(overrides: Record<string, unknown> = {}) {
  return {
    supplier_id: SUPPLIER_A,
    supplier_name: "ספק א",
    product_id: PRODUCT_A,
    product_name: "עגבניות",
    supplier_product_id: "ffffffff-6666-4666-8666-666666666666",
    measurable: true,
    unmeasurable_reason: null,
    baseline_price: 10,
    baseline_source: "price_history",
    baseline_as_of: "2026-07-22",
    current_price: 12,
    current_as_of: "2026-08-11",
    delta_amount: 2,
    delta_percent: 20,
    supplier_rise_count: 1,
    supplier_rise_total: 2,
    supplier_unmeasurable_count: 1,
    measured_rise_rows: 1,
    unmeasurable_rows: 1,
    month_start: MONTH_START,
    month_end: MONTH_END,
    time_zone: "Asia/Jerusalem",
    ...overrides,
  };
}

const UNMEASURABLE_ROW = riseRow({
  product_id: PRODUCT_B,
  product_name: "מלפפונים",
  measurable: false,
  unmeasurable_reason: "no_baseline_at_month_start",
  baseline_price: null,
  baseline_source: null,
  baseline_as_of: null,
  delta_amount: null,
  delta_percent: null,
});

/* ============================================================================
 * Registration and contract shape
 * ==========================================================================*/

Deno.test("both read-model tools are registered exactly once, for owner and office only", () => {
  const registry = buildRegistry([...deterministicBusinessTools]);
  for (const tool of [getMonthlyPriceRises, getPurchaseComparison]) {
    assert.equal(registry.get(tool.name), tool);
    assert.deepEqual([...tool.requiredRoles], ["owner", "office"]);
    assert.equal(tool.classification, "financial_sensitive");
  }
});

Deno.test("an accountant cannot run either read model", async () => {
  const registry = buildRegistry([...deterministicBusinessTools]);
  for (const tool of [getMonthlyPriceRises, getPurchaseComparison]) {
    const envelope = await runRegisteredTool(
      registry,
      ctxWith(fakeDb(), "accountant"),
      tool.name,
      {},
    );
    assert.equal(envelope.complete, false);
    assert.equal(envelope.failures[0]?.code, "not_permitted");
  }
});

Deno.test("the price-rise description states the calendar month and the unmeasurable rule", () => {
  const description = getMonthlyPriceRises.description;
  assert.ok(description.includes("חודש הקלנדרי"));
  assert.ok(description.includes("1 בחודש"));
  assert.ok(description.includes("לא ניתן למדוד"));
  assert.ok(description.includes("אינו נספר כאפס"));
  // The trailing window must be named as what it is not, so the model cannot describe the month
  // as "the last 30 days" (#178).
  assert.ok(description.includes("ולא חלון נגרר של 30 יום"));
});

/* ============================================================================
 * get_monthly_price_rises
 * ==========================================================================*/

Deno.test("a rise is relayed with the server's delta, baseline, source and as-of", async () => {
  const envelope = await getMonthlyPriceRises.run(
    ctxWith(fakeDb({
      supplier_monthly_price_rises: { data: [riseRow(), UNMEASURABLE_ROW], error: null },
    })),
    {},
  );
  assert.equal(envelope.complete, true);
  assert.equal(envelope.result_count, 2);
  assert.equal(envelope.filters.month_start, MONTH_START);
  assert.equal(envelope.filters.month_end, MONTH_END);
  assert.equal(envelope.filters.period, "calendar_month");

  const delta = envelope.facts.find(
    (fact) => fact.kind === "supplier.price_change" && fact.subject?.id === PRODUCT_A,
  );
  assert.equal(delta?.value, 2);
  assert.equal(delta?.unit, "ils");
  assert.ok(delta?.label.includes("בסיס 10"));
  assert.ok(delta?.label.includes("2026-07-22"));
  const percent = envelope.facts.find(
    (fact) => fact.kind === "metric.percent" && fact.subject?.id === PRODUCT_A,
  );
  assert.equal(percent?.value, 20);
});

Deno.test("an unmeasurable row is null and never zero, and is counted separately", async () => {
  const envelope = await getMonthlyPriceRises.run(
    ctxWith(fakeDb({
      supplier_monthly_price_rises: { data: [riseRow(), UNMEASURABLE_ROW], error: null },
    })),
    {},
  );
  const unmeasurable = envelope.facts.find(
    (fact) => fact.kind === "supplier.price_change" && fact.subject?.id === PRODUCT_B,
  );
  assert.equal(unmeasurable?.value, null);
  assert.ok(unmeasurable?.label.includes("לא ניתן למדוד"));

  const counts = envelope.facts.filter(
    (fact) => fact.kind === "metric.count" && fact.subject === null,
  );
  assert.equal(counts.length, 2);
  assert.equal(counts[0]?.value, 1);
  assert.equal(counts[1]?.value, 1);
  assert.ok(counts[1]?.label.includes("אינם נספרים כאפס"));
  assert.ok(
    envelope.warnings.some((warning) => warning.includes("אינו מוצר שמחירו לא השתנה")),
  );
});

Deno.test("the price-rise source is the allowlisted increases route", () => {
  const rules = getMonthlyPriceRises;
  assert.ok(rules); // keeps the import honest if the assertion below is ever loosened
  const source = {
    id: "s1",
    entity: "organization" as const,
    entity_id: ORG_ID,
    label: "מסך המחירים — התייקרויות",
    route: "/prices?increases=1",
    classification: "financial_sensitive" as const,
  };
  assert.equal(assistantSourceRouteDecision(source, "owner"), "allowed");
  assert.equal(assistantSourceRouteDecision(source, "office"), "allowed");
  assert.equal(assistantSourceRouteDecision(source, "accountant"), "not_permitted");
});

Deno.test("every source the price-rise tool issues survives the route allowlist", async () => {
  const envelope = await getMonthlyPriceRises.run(
    ctxWith(fakeDb({
      supplier_monthly_price_rises: { data: [riseRow(), UNMEASURABLE_ROW], error: null },
    })),
    {},
  );
  for (const source of envelope.sources) {
    assert.equal(assistantSourceRouteDecision(source, "owner"), "allowed", source.route ?? "null");
  }
});

Deno.test("a truncated page says so instead of reading as the whole month", async () => {
  const rows = Array.from({ length: 3 }, (_unused, index) =>
    riseRow({ product_id: `cccccccc-3333-4333-8333-00000000000${index}` }));
  const envelope = await getMonthlyPriceRises.run(
    ctxWith(fakeDb({ supplier_monthly_price_rises: { data: rows, error: null } })),
    { limit: 2 },
  );
  assert.equal(envelope.result_count, 2);
  assert.equal(envelope.has_more, true);
  assert.equal(envelope.complete, false);
  assert.equal(envelope.failures[0]?.code, "monthly_price_rises_truncated");
});

Deno.test("a failed read is a named failure, not an empty month", async () => {
  const envelope = await getMonthlyPriceRises.run(
    ctxWith(fakeDb({
      supplier_monthly_price_rises: { data: null, error: { message: "boom" } },
    })),
    {},
  );
  assert.equal(envelope.complete, false);
  assert.equal(envelope.result_count, 0);
  assert.equal(envelope.failures[0]?.code, "monthly_price_rises_failed");
});

/* ============================================================================
 * get_purchase_comparison
 * ==========================================================================*/

function comparisonPayload(overrides: Record<string, unknown> = {}) {
  return {
    as_of: "2026-08-20T08:00:00+00:00",
    source: "input",
    request_id: null,
    time_zone: "Asia/Jerusalem",
    requested_lines: 2,
    result_count: 2,
    complete: true,
    has_more: false,
    lines: [
      {
        product_id: PRODUCT_A,
        product_name: "עגבניות",
        unit: "ק\"ג",
        qty: 10,
        status: "ok",
        chosen_supplier_id: SUPPLIER_A,
        chosen_unit_price: 12,
        chosen_currency: "ILS",
        line_total: 120,
        offers: [
          {
            supplier_id: SUPPLIER_A,
            supplier_name: "ספק א",
            preferred: false,
            unit_price: 12,
            currency: "ILS",
            min_qty: null,
            meets_min_qty: true,
          },
          {
            supplier_id: SUPPLIER_B,
            supplier_name: "ספק ב",
            preferred: true,
            unit_price: 14,
            currency: "ILS",
            min_qty: null,
            meets_min_qty: true,
          },
        ],
      },
      {
        product_id: PRODUCT_B,
        product_name: "מלפפונים",
        unit: "ק\"ג",
        qty: 4,
        status: "ok",
        chosen_supplier_id: SUPPLIER_B,
        chosen_unit_price: 7,
        chosen_currency: "ILS",
        line_total: 28,
        offers: [
          {
            supplier_id: SUPPLIER_B,
            supplier_name: "ספק ב",
            preferred: true,
            unit_price: 7,
            currency: "ILS",
            min_qty: null,
            meets_min_qty: true,
          },
        ],
      },
    ],
    suppliers: [
      {
        supplier_id: SUPPLIER_A,
        supplier_name: "ספק א",
        subtotal: 120,
        currency: "ILS",
        min_order_amount: 400,
        min_order_currency: "ILS",
        below_minimum: true,
        shortfall: 280,
      },
      {
        supplier_id: SUPPLIER_B,
        supplier_name: "ספק ב",
        subtotal: 28,
        currency: "ILS",
        min_order_amount: null,
        min_order_currency: "ILS",
        below_minimum: false,
        shortfall: null,
      },
    ],
    minimum_breaches: 1,
    ...overrides,
  };
}

Deno.test("the comparison input takes quantities or a draft, never both and never neither", () => {
  const schema = getPurchaseComparison.inputSchema;
  assert.equal(schema.safeParse({}).success, false);
  assert.equal(
    schema.safeParse({
      lines: [{ product_id: PRODUCT_A, qty: 10 }],
      request_id: REQUEST_ID,
    }).success,
    false,
  );
  assert.equal(schema.safeParse({ lines: [{ product_id: PRODUCT_A, qty: 10 }] }).success, true);
  assert.equal(schema.safeParse({ request_id: REQUEST_ID }).success, true);
  // A quantity the model would have to invent is refused at the boundary rather than defaulted.
  assert.equal(schema.safeParse({ lines: [{ product_id: PRODUCT_A }] }).success, false);
  assert.equal(schema.safeParse({ lines: [{ product_id: PRODUCT_A, qty: 0 }] }).success, false);
  assert.equal(schema.safeParse({ lines: [{ product_id: "not-a-uuid", qty: 1 }] }).success, false);
});

Deno.test("the saving is the shared formula's answer, not a second implementation", async () => {
  const payload = comparisonPayload();
  const envelope = await getPurchaseComparison.run(
    ctxWith(fakeDb({ purchase_comparison: { data: payload, error: null } })),
    { lines: [{ product_id: PRODUCT_A, qty: 10 }, { product_id: PRODUCT_B, qty: 4 }] },
  );

  // Recomputed here through the very same exported functions the tool used: if the tool ever grew
  // arithmetic of its own, these two numbers would part company.
  const expected = summarizeComparison([
    compareLine(10, [
      { supplierId: SUPPLIER_A, unitPrice: 12, currency: "ILS", minQty: null },
      { supplierId: SUPPLIER_B, unitPrice: 14, currency: "ILS", minQty: null },
    ], SUPPLIER_A),
    compareLine(4, [
      { supplierId: SUPPLIER_B, unitPrice: 7, currency: "ILS", minQty: null },
    ], SUPPLIER_B),
  ]);
  const row = envelope.data[0] as Record<string, unknown>;
  assert.deepEqual(row.saved_by_currency, expected.savedByCurrency);
  assert.deepEqual(row.extra_by_currency, expected.extraByCurrency);
  assert.equal(row.overpaying_line_count, expected.overpayingCount);
  assert.deepEqual(expected.savedByCurrency, [{ currency: "ILS", amount: 20 }]);
  assert.equal("saved_total" in row, false);
  assert.equal("extra_total" in row, false);
});

Deno.test("a mixed basket returns one assistant fact per currency and never a combined saving", async () => {
  const payload = comparisonPayload();
  payload.lines[1] = {
    ...payload.lines[1],
    chosen_currency: "USD",
    offers: [
      {
        supplier_id: SUPPLIER_B,
        supplier_name: "ספק ב",
        preferred: true,
        unit_price: 7,
        currency: "USD",
        min_qty: null,
        meets_min_qty: true,
      },
      {
        supplier_id: SUPPLIER_A,
        supplier_name: "ספק א",
        preferred: false,
        unit_price: 9,
        currency: "USD",
        min_qty: null,
        meets_min_qty: true,
      },
    ],
  };
  payload.suppliers[1] = {
    ...payload.suppliers[1],
    currency: "USD",
    min_order_currency: "USD",
  };

  const envelope = await getPurchaseComparison.run(
    ctxWith(fakeDb({ purchase_comparison: { data: payload, error: null } })),
    { lines: [{ product_id: PRODUCT_A, qty: 10 }, { product_id: PRODUCT_B, qty: 4 }] },
  );
  const row = envelope.data[0] as Record<string, unknown>;
  assert.deepEqual(row.saved_by_currency, [
    { currency: "ILS", amount: 20 },
    { currency: "USD", amount: 8 },
  ]);
  const basketSavings = envelope.facts
    .filter((fact) => fact.subject === null && fact.kind === "comparison.saved_vs_next")
    .map((fact) => ({ unit: fact.unit, value: fact.value }));
  assert.deepEqual(basketSavings, [
    { unit: "ils", value: 20 },
    { unit: "usd", value: 8 },
  ]);
  assert.equal(basketSavings.some((fact) => fact.value === 28), false);
});

Deno.test("a product with no alternative is null, never zero", async () => {
  const envelope = await getPurchaseComparison.run(
    ctxWith(fakeDb({ purchase_comparison: { data: comparisonPayload(), error: null } })),
    { lines: [{ product_id: PRODUCT_A, qty: 10 }, { product_id: PRODUCT_B, qty: 4 }] },
  );
  const row = envelope.data[0] as Record<string, unknown>;
  const lines = row.lines as Record<string, unknown>[];
  const single = lines.find((line) => line.product_id === PRODUCT_B);
  assert.equal(single?.comparison_status, "single_offer");
  assert.equal(single?.saved_vs_next, null);
  assert.equal(single?.extra_vs_cheapest, null);
  const fact = envelope.facts.find(
    (candidate) =>
      candidate.subject?.id === PRODUCT_B && candidate.label.includes("אין הצעה חלופית"),
  );
  assert.equal(fact?.value, null);
});

Deno.test("a supplier minimum is a breach with a shortfall, and no quantity moves", async () => {
  const requested = [{ product_id: PRODUCT_A, qty: 10 }, { product_id: PRODUCT_B, qty: 4 }];
  const envelope = await getPurchaseComparison.run(
    ctxWith(fakeDb({ purchase_comparison: { data: comparisonPayload(), error: null } })),
    { lines: requested },
  );
  const row = envelope.data[0] as Record<string, unknown>;
  const breaches = row.minimum_breaches as Record<string, unknown>[];
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0]?.supplier_id, SUPPLIER_A);
  assert.equal(breaches[0]?.shortfall, 280);

  // The quantities that come back are the quantities that went in. Nothing was raised to clear the
  // minimum, and no proposal to raise one exists anywhere in the envelope.
  const lines = row.lines as Record<string, unknown>[];
  assert.deepEqual(lines.map((line) => line.qty), [10, 4]);
  const breachCount = envelope.facts.find(
    (fact) => fact.kind === "metric.count" && fact.label.includes("מינימום ההזמנה"),
  );
  assert.equal(breachCount?.value, 1);
  assert.ok(
    envelope.warnings.some((warning) => warning.includes("אין להציע להעלות כמות")),
  );
});

Deno.test("the draft path names the draft and issues no invented route", async () => {
  const envelope = await getPurchaseComparison.run(
    ctxWith(fakeDb({
      purchase_comparison: {
        data: comparisonPayload({ source: "draft", request_id: REQUEST_ID }),
        error: null,
      },
    })),
    { request_id: REQUEST_ID },
  );
  assert.equal(envelope.filters.source, "draft");
  assert.equal(envelope.filters.request_id, REQUEST_ID);
  const draftSource = envelope.sources.find((source) => source.label.includes(REQUEST_ID));
  assert.equal(draftSource?.route, null);
  for (const source of envelope.sources) {
    assert.equal(assistantSourceRouteDecision(source, "owner"), "allowed", source.label);
  }
});

Deno.test("an incomplete comparison never reads as a whole basket", async () => {
  const envelope = await getPurchaseComparison.run(
    ctxWith(fakeDb({
      purchase_comparison: { data: comparisonPayload({ complete: false }), error: null },
    })),
    { lines: [{ product_id: PRODUCT_A, qty: 10 }] },
  );
  assert.equal(envelope.complete, false);
  assert.equal(envelope.failures[0]?.code, "purchase_comparison_incomplete");
});

Deno.test("an unknown draft and a failed read are named failures", async () => {
  const unknown = await getPurchaseComparison.run(
    ctxWith(fakeDb({
      purchase_comparison: {
        data: null,
        error: { message: "purchase_comparison_draft_unknown" },
      },
    })),
    { request_id: REQUEST_ID },
  );
  assert.equal(unknown.failures[0]?.code, "draft_unknown");

  const broken = await getPurchaseComparison.run(
    ctxWith(fakeDb({ purchase_comparison: { data: null, error: { message: "boom" } } })),
    { lines: [{ product_id: PRODUCT_A, qty: 10 }] },
  );
  assert.equal(broken.failures[0]?.code, "purchase_comparison_failed");
  assert.equal(broken.complete, false);
  assert.equal(broken.result_count, 0);
});

Deno.test("neither read model can be talked into a write", () => {
  // #182 in the tool contract itself: the only database verb either tool names is a read model.
  const sources = [getMonthlyPriceRises, getPurchaseComparison].map((tool) => tool.run.toString());
  for (const body of sources) {
    assert.ok(!/\binsert\b|\bupdate\b|\bdelete\b/i.test(body), body.slice(0, 120));
    assert.ok(!body.includes("purchase_orders"));
    assert.ok(!body.includes("purchase_order_items"));
  }
});

// ---------------------------------------------------------------------------
// Fact kinds carry the SEMANTIC, not just the unit. validateAnswer() decides whether a fact
// supports a claim by matching kind, subject, unit and value -- so two facts about the same
// subject, in the same unit, under the same kind are interchangeable to it, whatever their labels
// say. src/lib/orderComparison.ts exists because "you saved X" and "you are paying X too much"
// must never be netted; these cases stop the fact vocabulary from netting them back together.
// ---------------------------------------------------------------------------

Deno.test("a saving and an overpayment are never the same kind of fact", async () => {
  const envelope = await getPurchaseComparison.run(
    ctxWith(fakeDb({ purchase_comparison: { data: comparisonPayload(), error: null } })),
    { lines: [{ product_id: PRODUCT_A, qty: 10 }, { product_id: PRODUCT_B, qty: 4 }] },
  );
  const saved = envelope.facts.filter((fact) => fact.kind === "comparison.saved_vs_next");
  const extra = envelope.facts.filter((fact) => fact.kind === "comparison.extra_vs_cheapest");
  assert.ok(saved.length > 0, "no saving fact was issued");
  // Neither direction may hide under the generic money kind, at line level or at basket level.
  for (const fact of [...saved, ...extra]) {
    assert.notEqual(fact.kind, "metric.money");
  }
  // The two basket totals are both subject:null and both ILS. Under one kind a claim citing the
  // overpayment total could assert it as the saving total, and the value check would pass.
  const basket = envelope.facts.filter((fact) => fact.subject === null && fact.unit === "ils");
  const basketKinds = new Set(basket.map((fact) => fact.kind));
  assert.equal(basketKinds.size, basket.length, "two basket money facts share one kind");
});

Deno.test("a minimum-order shortfall cannot be claimed as the basket subtotal", async () => {
  const envelope = await getPurchaseComparison.run(
    ctxWith(fakeDb({ purchase_comparison: { data: comparisonPayload(), error: null } })),
    { lines: [{ product_id: PRODUCT_A, qty: 10 }, { product_id: PRODUCT_B, qty: 4 }] },
  );
  const perSupplier = envelope.facts.filter(
    (fact) => fact.subject?.entity === "supplier" && fact.subject.id === SUPPLIER_A &&
      fact.unit === "ils",
  );
  assert.ok(perSupplier.length >= 2, "expected a subtotal and a shortfall for the same supplier");
  const kinds = new Set(perSupplier.map((fact) => fact.kind));
  assert.equal(kinds.size, perSupplier.length, "subtotal and shortfall share one kind");
  assert.ok(kinds.has("comparison.minimum_breach"));
});

Deno.test("the price baseline is a value the assistant may state, not a number stuck in a label", async () => {
  const envelope = await getMonthlyPriceRises.run(
    ctxWith(fakeDb({ supplier_monthly_price_rises: { data: [riseRow()], error: null } })),
    {},
  );
  const baseline = envelope.facts.find((fact) => fact.kind === "supplier.price_baseline");
  assert.ok(baseline, "no baseline fact was issued");
  // The validator's numeral pool comes from fact VALUES only -- never labels -- so a baseline
  // that exists only inside a label is a number the assistant may read and may not say.
  assert.equal(typeof baseline!.value, "number");
  assert.equal(baseline!.unit, "ils");
  assert.equal(baseline!.subject?.id, PRODUCT_A);
});
