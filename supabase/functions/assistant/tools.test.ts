// Tool honesty contracts: a failing scan is a named failure and flips `complete`, an absent
// summary RPC is a named failure and never a fabricated sheet, and the registry refuses tools,
// roles and inputs outside its allowlist -- as envelopes, never as silence.
import assert from "node:assert/strict";
import type { ActorContext } from "../../../src/lib/assistant/contracts.ts";
import { SUMMARY_ABSENCE_KEYS } from "../../../src/lib/assistant/summaryLines.ts";
import { readerText } from "./reader-locale.ts";
import { getBusinessSummaryTool } from "./tools/business-summary.ts";
import { getOpenAlertsTool } from "./tools/open-alerts.ts";
import {
  buildRegistry,
  RunEvidence,
  runRegisteredTool,
  serializeEnvelopeForProvider,
  type ToolContext,
  type ToolDataPort,
} from "./tools/registry.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const REGISTRY = buildRegistry([getBusinessSummaryTool, getOpenAlertsTool]);

function actorWithRole(role: ActorContext["role"]): ActorContext {
  return {
    userId: "22222222-2222-4222-8222-222222222222",
    orgId: ORG,
    role,
    scopes: [],
    canWrite: true,
    capabilities: {
      ui: true,
      history: false,
      drafts: false,
      confirmedActions: false,
    },
  };
}

function context(db: ToolDataPort, role: ActorContext["role"] = "owner"): ToolContext {
  return {
    db,
    actor: actorWithRole(role),
    evidence: new RunEvidence(),
    now: () => new Date("2026-08-20T10:00:00Z"),
    locale: "he",
  };
}

function alertsDb(failing: Set<string>): ToolDataPort {
  const counts: Record<string, unknown> = {
    p2_duplicate_invoice_group_count: 2,
    p2_recent_price_increase_count: 0,
    p2_above_average_offer_count: 1,
    p2_invoice_without_order_count: 0,
    p2_payment_due_counts: { total: 3, late: 1 },
  };
  return {
    rpc: (name) =>
      Promise.resolve(
        failing.has(name)
          ? { data: null, error: { message: "boom" } }
          : { data: counts[name] ?? null, error: null },
      ),
    countSentOrders: () =>
      failing.has("purchase_orders")
        ? Promise.resolve({ count: null, error: { message: "boom" } })
        : Promise.resolve({ count: 4, error: null }),
  };
}

Deno.test("get_open_alerts: every scan lands as a fact, zero included", async () => {
  const ctx = context(alertsDb(new Set()));
  const envelope = await runRegisteredTool(REGISTRY, ctx, "get_open_alerts", {});
  assert.equal(envelope.complete, true);
  assert.deepEqual(envelope.failures, []);
  // Six scans, payment_due contributes two facts: measured zeros are real zeros.
  assert.equal(envelope.facts.length, 7);
  const zero = envelope.facts.find((fact) =>
    fact.label.includes("מחירים שעלו")
  );
  assert.ok(zero);
  assert.equal(zero.value, 0);
});

Deno.test("get_open_alerts: a failing scan is a named failure, never a clean sheet", async () => {
  const ctx = context(
    alertsDb(new Set(["p2_duplicate_invoice_group_count", "purchase_orders"])),
  );
  const envelope = await runRegisteredTool(REGISTRY, ctx, "get_open_alerts", {});
  assert.equal(envelope.complete, false);
  assert.deepEqual(envelope.failures, [
    { code: "duplicate_invoice", label: "חשבוניות כפולות" },
    { code: "orders_awaiting_confirmation", label: "הזמנות ללא אישור" },
  ]);
  // The surviving scans still contribute -- one failure does not blank the rest.
  assert.ok(envelope.facts.length >= 5);
});

Deno.test("get_open_alerts: the scope-limit sentences ride along verbatim", async () => {
  const ctx = context(alertsDb(new Set()));
  const envelope = await runRegisteredTool(REGISTRY, ctx, "get_open_alerts", {});
  assert.ok(envelope.warnings.includes(
    "לפי המחירון בלבד. מחירי שורות החשבונית בפועל אינם חלק מהסריקה הזאת",
  ));
  assert.ok(!envelope.warnings.some((warning) =>
    warning.includes("לחשבונית אין שורות פריטים")
  ));
  assert.ok(envelope.warnings.includes(
    "מכסה רק דרישות תשלום שהוזן להן תאריך. לחשבוניות אין מועד פירעון במערכת",
  ));
});

Deno.test("get_business_summary: registry refuses accountant before the invoker RPC runs", async () => {
  let rpcCalled = false;
  const ctx = context({
    rpc: () => {
      rpcCalled = true;
      return Promise.resolve({ data: [], error: null });
    },
    countSentOrders: () => Promise.resolve({ count: 0, error: null }),
  }, "accountant");
  const envelope = await runRegisteredTool(
    REGISTRY,
    ctx,
    "get_business_summary",
    {},
  );
  assert.equal(envelope.complete, false);
  assert.equal(envelope.failures[0].code, "not_permitted");
  assert.equal(rpcCalled, false);
});

Deno.test("get_business_summary: a failed RPC is five named failures, not a fabrication", async () => {
  const ctx = context({
    rpc: () =>
      Promise.resolve({
        data: null,
        error: { message: "p2_business_summary_rows unavailable" },
      }),
    countSentOrders: () => Promise.resolve({ count: 0, error: null }),
  });
  const envelope = await runRegisteredTool(
    REGISTRY,
    ctx,
    "get_business_summary",
    {},
  );
  assert.equal(envelope.complete, false);
  assert.deepEqual(
    envelope.failures.map((failure) => failure.code),
    ["received_week", "awaiting_approval", "expected_payments", "suppliers_raised", "open_exceptions"],
  );
  // The four counts still exist as null facts. The money line cannot: an unavailable RPC did not
  // tell us which currency the missing amount belongs to, and inventing ILS would be a false fact.
  assert.equal(envelope.facts.length, 4);
  assert.ok(envelope.facts.every((fact) => fact.value === null));
  assert.ok(envelope.facts.every((fact) => fact.unit === "count"));
});

Deno.test("get_business_summary: an unmeasured line stays null and never blanks its neighbours", async () => {
  const ctx = context({
    rpc: () =>
      Promise.resolve({
        data: [
          { metric_key: "received_week", value: 12, measured: true },
          { metric_key: "awaiting_approval", value: 3, measured: true },
          // The RPC's own exception block reported this one as unmeasurable.
          { metric_key: "expected_payments", value: null, measured: false, currency: "ILS" },
          { metric_key: "suppliers_raised", value: "0", measured: true },
          { metric_key: "open_exceptions", value: 2, measured: true },
        ],
        error: null,
      }),
    countSentOrders: () => Promise.resolve({ count: 0, error: null }),
  });
  const envelope = await runRegisteredTool(
    REGISTRY,
    ctx,
    "get_business_summary",
    {},
  );
  assert.equal(envelope.complete, false);
  assert.deepEqual(envelope.failures, [{
    code: "expected_payments:ILS",
    label: "סכום פתוח בדרישות תשלום (ILS)",
  }]);
  const money = envelope.facts.find((fact) => fact.unit === "ils");
  assert.ok(money);
  assert.equal(money.value, null);
  // PostgREST string-serialized numeric coerced; a measured zero stays a real zero.
  const raised = envelope.facts[3];
  assert.equal(raised.value, 0);
});

/* ---------------------------------------------------------------------------
 * Decision F (owner 03.09.2026) -- the three readings of the money line, and the
 * two of them that must never read the same way again.
 * -------------------------------------------------------------------------*/

/** The four count metrics, always measured, so each case below varies only the money line. */
const COUNT_ROWS = [
  { metric_key: "received_week", value: 12, measured: true, currency: null },
  { metric_key: "awaiting_approval", value: 3, measured: true, currency: null },
  { metric_key: "suppliers_raised", value: 1, measured: true, currency: null },
  { metric_key: "open_exceptions", value: 2, measured: true, currency: null },
];

function summaryDb(moneyRows: Record<string, unknown>[]): ToolDataPort {
  return {
    rpc: () =>
      Promise.resolve({ data: [...COUNT_ROWS, ...moneyRows], error: null }),
    countSentOrders: () => Promise.resolve({ count: 0, error: null }),
  };
}

/** The money unit shape `FactUnitSchema` accepts. A stated absence must never carry one. */
const MONEY_UNIT = /^[a-z]{3}$/;

Deno.test("get_business_summary: nothing owed is a SENTENCE -- complete, no failure, no figure", async () => {
  // 0219 metric 3 answers a CURRENCY-LESS measured zero when nothing is committed, because
  // "nothing is owed" is true in every currency at once. This tool used to drop that row on
  // `/^[A-Z]{3}$/`, report `complete: false`, and AnswerView painted the answer as partial.
  const ctx = context(
    summaryDb([{
      metric_key: "expected_payments",
      value: 0,
      measured: true,
      currency: null,
    }]),
  );
  const envelope = await runRegisteredTool(
    REGISTRY,
    ctx,
    "get_business_summary",
    {},
  );
  assert.equal(envelope.complete, true);
  assert.deepEqual(envelope.failures, []);
  // Five facts: the four counts and the money line's stated absence -- which is a fact, so the
  // model may state it and the reader can trace it, and it is not a money fact, so `contracts.ts`
  // never had to widen.
  assert.equal(envelope.facts.length, 5);
  const stated = envelope.facts.find((fact) => fact.unit === "text");
  assert.ok(stated);
  assert.equal(stated.label, "סכום פתוח בדרישות תשלום");
  assert.equal(stated.kind, "payment_request.status");
  // The sentence comes from the table both consumers share, in the run's language -- never a
  // literal in this file, and never `0`, `—` or an invented currency.
  assert.equal(
    stated.value,
    readerText("he", SUMMARY_ABSENCE_KEYS.expected_payments),
  );
  assert.equal(typeof stated.value, "string");
  assert.ok(!envelope.facts.some((fact) => MONEY_UNIT.test(fact.unit)));
  // The route is still offered, so "nothing is owed" remains checkable rather than asserted.
  assert.ok(
    envelope.sources.some((source) => source.route === "/payment-requests"),
  );
});

Deno.test("get_business_summary: 'could not measure' stays a named failure, and reads differently", async () => {
  // The other currency-less row: measured false. Same missing currency, opposite meaning.
  const ctx = context(
    summaryDb([{
      metric_key: "expected_payments",
      value: null,
      measured: false,
      currency: null,
    }]),
  );
  const envelope = await runRegisteredTool(
    REGISTRY,
    ctx,
    "get_business_summary",
    {},
  );
  assert.equal(envelope.complete, false);
  assert.deepEqual(envelope.failures, [
    { code: "expected_payments", label: "סכום פתוח בדרישות תשלום" },
  ]);
  // Four count facts and no money line at all: an unmeasured amount has no currency to attach
  // to, and no absence to state either.
  assert.equal(envelope.facts.length, 4);
  assert.ok(!envelope.facts.some((fact) => fact.unit === "text"));
  assert.ok(!envelope.facts.some((fact) => MONEY_UNIT.test(fact.unit)));
});

Deno.test("get_business_summary: two currencies are two money facts, never their sum", async () => {
  const ctx = context(
    summaryDb([
      { metric_key: "expected_payments", value: "3100", measured: true, currency: "USD" },
      { metric_key: "expected_payments", value: 1234.56, measured: true, currency: "ILS" },
    ]),
  );
  const envelope = await runRegisteredTool(
    REGISTRY,
    ctx,
    "get_business_summary",
    {},
  );
  assert.equal(envelope.complete, true);
  assert.deepEqual(envelope.failures, []);
  const money = envelope.facts.filter((fact) => MONEY_UNIT.test(fact.unit));
  assert.deepEqual(
    money.map((fact) => ({ unit: fact.unit, value: fact.value, label: fact.label })),
    [
      { unit: "ils", value: 1234.56, label: "סכום פתוח בדרישות תשלום (ILS)" },
      { unit: "usd", value: 3100, label: "סכום פתוח בדרישות תשלום (USD)" },
    ],
  );
  assert.ok(!money.some((fact) => fact.value === 4334.56));
  // Real obligations are never dressed as an absence.
  assert.ok(!envelope.facts.some((fact) => fact.unit === "text"));
});

Deno.test("get_open_alerts: an accountant gets a named refusal on the §10 debt scan, never a wrong count", async () => {
  // DEBT-REGISTER §10: p2_invoice_without_order_count() does not enforce its owner/office role
  // contract in the body. The tool enforces it instead -- the scan lands as a named failure for
  // any other role, and the five unaffected scans still contribute.
  const ctx = context(alertsDb(new Set()), "accountant");
  const envelope = await runRegisteredTool(REGISTRY, ctx, "get_open_alerts", {});
  assert.equal(envelope.complete, false);
  assert.deepEqual(envelope.failures, [
    { code: "invoice_without_order", label: "חשבוניות ללא הזמנה" },
  ]);
  assert.equal(envelope.facts.length, 6);
});

Deno.test("the registry refuses an unknown tool as an envelope, not silence", async () => {
  const ctx = context(alertsDb(new Set()));
  const envelope = await runRegisteredTool(REGISTRY, ctx, "drop_table", {});
  assert.equal(envelope.complete, false);
  assert.equal(envelope.failures[0].code, "unknown_tool");
  assert.equal(envelope.facts.length, 0);
});

Deno.test("the registry refuses undeclared input keys", async () => {
  const ctx = context(alertsDb(new Set()));
  const envelope = await runRegisteredTool(REGISTRY, ctx, "get_open_alerts", {
    sql: "select 1",
  });
  assert.equal(envelope.complete, false);
  assert.equal(envelope.failures[0].code, "invalid_tool_input");
});

Deno.test("provider serialization withholds forbidden classes and routes", () => {
  const evidence = new RunEvidence();
  const fact = evidence.fact({
    kind: "metric.count",
    subject: null,
    label: "פרט בנקאי",
    value: 1,
    unit: "count",
    tool: "get_business_summary",
    as_of: "2026-08-20T10:00:00Z",
    classification: "bank_restricted",
  });
  const source = evidence.source({
    entity: "organization",
    entity_id: ORG,
    label: "חשבוניות",
    route: "/invoices",
    classification: "tenant_standard",
  });
  const serialized = serializeEnvelopeForProvider({
    data: [],
    complete: true,
    failures: [],
    filters: {},
    as_of: "2026-08-20T10:00:00Z",
    result_count: 1,
    has_more: false,
    facts: [fact],
    sources: [source],
    warnings: [],
  });
  assert.equal(serialized.complete, false);
  const facts = serialized.facts as unknown[];
  assert.equal(facts.length, 0);
  const failures = serialized.failures as { code: string }[];
  assert.ok(
    failures.some((failure) =>
      failure.code === "fact_withheld_by_classification"
    ),
  );
  const sources = serialized.sources as Record<string, unknown>[];
  assert.equal(sources.length, 1);
  assert.ok(!("route" in sources[0]));
});
