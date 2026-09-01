// The two tools the read-model plan adds on top of the deterministic set: product help sourced
// only from the #192 registry, and the evidence a #191 supplier reminder may quote. Every
// database interaction is a fake -- nothing here touches a live Supabase and nothing calls a model.
import assert from "node:assert/strict";
import type { ActorContext } from "../../../../src/lib/assistant/contracts.ts";
import { ASSISTANT_DRAFT_ROLES } from "../../../../src/lib/assistant/contracts.ts";
import { assistantSourceRouteDecision } from "../../../../src/lib/assistant/routeAccess.ts";
import {
  PRODUCT_HELP_ENTRIES,
  productHelpPath,
} from "../../../../src/lib/assistant/productHelpRegistry.ts";
import { validateAnswer } from "../validate.ts";
import { draftSupplierReminder } from "./draftSupplierReminder.ts";
import { getProductHelp } from "./getProductHelp.ts";
import {
  buildRegistry,
  RunEvidence,
  runRegisteredTool,
  serializeEnvelopeForProvider,
  type ToolContext,
} from "./registry.ts";
import type { ReadError, RowsResult, SentOrderRow, ToolReads } from "./reads.ts";

const ORG_ID = "55555555-5555-4555-8555-555555555555";
const ORDER_ID = "33333333-3333-4333-8333-333333333333";
const SUPPLIER_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-08-20T08:00:00.000Z");

function actor(
  role: ActorContext["role"] = "owner",
  drafts = true,
): ActorContext {
  return {
    userId: "44444444-4444-4444-8444-444444444444",
    orgId: ORG_ID,
    role,
    scopes: [],
    canWrite: true,
    capabilities: { ui: true, history: false, drafts, confirmedActions: false },
  };
}

function emptyRows<T>(): RowsResult<T> {
  return { rows: [], hasMore: false, error: null };
}

function sentOrder(over: Partial<SentOrderRow> = {}): SentOrderRow {
  return {
    id: ORDER_ID,
    number: 1042,
    status: "sent",
    expected_date: "2026-08-13",
    sent_at: "2026-08-05T09:00:00.000Z",
    created_at: "2026-08-05T09:00:00.000Z",
    supplier_id: SUPPLIER_ID,
    suppliers: { name: "ירקות השדה" },
    purchase_order_items: [{ qty: 4, unit_price: 25 }],
    ...over,
  };
}

function fakeDb(orders: RowsResult<SentOrderRow> = emptyRows()): ToolReads {
  const rejectRpc = (name: string) =>
    Promise.resolve({ data: null, error: { message: `no fake for ${name}` } as ReadError });
  return {
    rpc: (name) => rejectRpc(name),
    countSentOrders: () => Promise.resolve({ count: 0, error: null }),
    listSentOrders: () => Promise.resolve(orders),
    listUnmatchedBankTransactions: () => Promise.resolve(emptyRows()),
    listSupplierMetrics: () => Promise.resolve(emptyRows()),
    listSupplierNames: () => Promise.resolve({ rows: [], error: null }),
    listSupplierOpenCredits: () => Promise.resolve(emptyRows()),
    listInventoryRisk: () => Promise.resolve(emptyRows()),
  };
}

// The locale defaults to Hebrew, so every existing case keeps asserting the exact Hebrew
// sentence it always asserted. Only the cases about the English reader pass "en".
function ctxWith(
  db: ToolReads,
  role: ActorContext["role"] = "owner",
  drafts = true,
  locale: ToolContext["locale"] = "he",
): ToolContext {
  return {
    db,
    actor: actor(role, drafts),
    evidence: new RunEvidence(),
    now: () => NOW,
    locale,
  };
}

/* ============================================================================
 * get_product_help (#192)
 * ==========================================================================*/

Deno.test("product help answers from the registry, and every fact points at a real screen", async () => {
  const ctx = ctxWith(fakeDb());
  const envelope = await getProductHelp.run(ctx, { question: "איך משווים מחירי ספקים?" });

  assert.equal(envelope.complete, true);
  assert.equal(envelope.failures.length, 0);
  assert.equal(envelope.result_count, 1);
  const [row] = envelope.data as { id: string; path: string; steps: string[] }[];
  assert.equal(row.id, "compare_supplier_prices");
  assert.equal(row.path, "/prices");

  // One anchor fact per entry, valued by the canonical PATH -- plus one fact per step, so the
  // authoritative wording reaches the provider and the renderer instead of dying in `data`.
  assert.equal(envelope.facts.length, 1 + row.steps.length);
  for (const fact of envelope.facts) {
    assert.equal(fact.kind, "product_help.entry");
    assert.equal(fact.unit, "text");
    assert.equal(fact.value, "/prices");
    assert.equal(fact.classification, "public_product_metadata");
    assert.equal(fact.subject, null);
  }
  assert.equal(envelope.facts[0].label, "רשומת עזרה — השוואת מחירי ספקים");
  assert.ok(envelope.facts[1].label.startsWith("1. "));
});

Deno.test("a product-help source is issued only where routeAccess already allowlists the screen", async () => {
  for (const entry of PRODUCT_HELP_ENTRIES) {
    if (entry.locale !== "he") continue;
    const role = entry.roles[0];
    const ctx = ctxWith(fakeDb(), role);
    const envelope = await getProductHelp.run(ctx, {
      question: "",
      entry_id: entry.id,
      locale: entry.locale,
    });
    assert.equal(envelope.result_count, 1, entry.id);

    if (envelope.sources.length === 0) {
      // No link is allowed, but never silent: the envelope has to say the screen is unreachable.
      assert.ok(
        envelope.warnings.some((warning) => warning.includes(entry.label)),
        `${entry.id} dropped its source without saying so`,
      );
      continue;
    }
    const [source] = envelope.sources;
    assert.equal(source.route, productHelpPath(entry), entry.id);
    assert.equal(source.entity, "organization", entry.id);
    assert.equal(source.entity_id, ORG_ID, entry.id);
    // The tool may not widen the allowlist: what it issues must survive the very check that
    // validate.ts runs over it after generation.
    assert.equal(assistantSourceRouteDecision(source, role), "allowed", entry.id);
  }
});

Deno.test("an English reader gets the English entry without the model having to ask for it", async () => {
  // No `locale` in the tool arguments AT ALL. Before `OPEN-DECISIONS #283` that meant Hebrew,
  // so an English speaker got English steps only when the model happened to guess; the run’s
  // own locale is now the fallback, and it is a fact the server holds.
  const envelope = await getProductHelp.run(ctxWith(fakeDb(), "owner", true, "en"), {
    question: "",
    entry_id: "compare_supplier_prices",
  });
  assert.equal(envelope.result_count, 1);
  const [row] = envelope.data as { locale: string; label: string; steps: string[] }[];
  assert.equal(row.locale, "en");
  assert.equal(row.label, "Comparing supplier prices");
  // The whole label, not only the half the registry supplied. Until 01.09.2026 this asserted
  // `רשומת עזרה — Comparing supplier prices`: the English entry arrived under a Hebrew prefix the
  // tool had hard-coded, and the test pinned that as correct. Measured live the same day, an
  // English run came back with 8 Hebrew fact labels and 4 Hebrew screen names; this was one of
  // the 178 strings that moved into the dictionaries.
  assert.equal(envelope.facts[0].label, "Help entry — Comparing supplier prices");

  // The source label is the SCREEN’s name, and `routePresentationTitle` returns a dictionary
  // key since the interface was extracted. Unresolved it would put `nav.routeTitle_prices` in
  // front of a person, and `tsc` would have been happy: `TKey` is a string.
  assert.equal(envelope.sources[0].label, "Price lists");
  for (const source of envelope.sources) {
    assert.ok(!source.label.startsWith("nav."), source.label);
  }
});

Deno.test("the model may still name a language, and it beats the reader’s own", async () => {
  // A Hebrew reader asking in English, or the other way round: the argument is a deliberate
  // override, so it wins. What changed is only what SILENCE means.
  const envelope = await getProductHelp.run(ctxWith(fakeDb(), "owner", true, "en"), {
    question: "",
    entry_id: "compare_supplier_prices",
    locale: "he",
  });
  const [row] = envelope.data as { locale: string; label: string }[];
  assert.equal(row.locale, "he");
  assert.equal(row.label, "השוואת מחירי ספקים");
  assert.equal(envelope.sources[0].label, "מחירונים");
});

Deno.test("an unanswered product question is a named failure, never a nearest-entry guess", async () => {
  const ctx = ctxWith(fakeDb());
  const envelope = await getProductHelp.run(ctx, {
    question: "איך מגדירים תקציב חודשי למחלקה?",
  });
  assert.equal(envelope.result_count, 0);
  assert.deepEqual(envelope.facts, []);
  assert.deepEqual(envelope.sources, []);
  assert.equal(envelope.complete, false);
  assert.equal(envelope.failures[0].code, "product_help_not_registered");
});

Deno.test("product help is role-narrowed by the registry, not only by the tool's role list", async () => {
  // All three roles may CALL the tool...
  assert.deepEqual([...getProductHelp.requiredRoles], ["owner", "office", "accountant"]);
  // ...and an accountant asking a staff-only question still gets nothing, because `prices` is
  // staff-only in APP_ROUTE_POLICY and the entry may not widen it.
  const envelope = await getProductHelp.run(ctxWith(fakeDb(), "accountant"), {
    question: "איך משווים מחירי ספקים?",
  });
  assert.equal(envelope.result_count, 0);
  assert.equal(envelope.failures[0].code, "product_help_not_registered");

  // Even by exact id, which is the path a previous turn would use.
  const byId = await getProductHelp.run(ctxWith(fakeDb(), "accountant"), {
    question: "",
    entry_id: "compare_supplier_prices",
  });
  assert.equal(byId.result_count, 0);
});

Deno.test("product help reaches no database at all", async () => {
  let touched = 0;
  const db = fakeDb();
  const spy: ToolReads = {
    ...db,
    rpc: (name) => {
      touched += 1;
      return db.rpc(name);
    },
    listSentOrders: (limit) => {
      touched += 1;
      return db.listSentOrders(limit);
    },
  };
  await getProductHelp.run(ctxWith(spy), { question: "איך משווים מחירי ספקים?" });
  assert.equal(touched, 0);
});

/* ============================================================================
 * draft_supplier_reminder (#191/#193)
 * ==========================================================================*/

Deno.test("the reminder tool returns quotable facts and one link to the order's own screen", async () => {
  const ctx = ctxWith(fakeDb({ rows: [sentOrder()], hasMore: false, error: null }));
  const envelope = await draftSupplierReminder.run(ctx, {});

  assert.equal(envelope.complete, true);
  assert.equal(envelope.result_count, 1);
  const [row] = envelope.data as { number: number; days_late: number; expected_date: string }[];
  assert.equal(row.number, 1042);
  assert.equal(row.expected_date, "2026-08-13");
  // 13.08 expected, business date 20.08 in Asia/Jerusalem -> seven whole calendar days.
  assert.equal(row.days_late, 7);

  const values = envelope.facts.map((fact) => fact.value);
  assert.deepEqual(values, ["1042", "2026-08-13", 7]);
  assert.deepEqual(envelope.facts.map((fact) => fact.unit), ["text", "date", "count"]);
  for (const fact of envelope.facts) {
    assert.deepEqual(fact.subject, { entity: "purchase_order", id: ORDER_ID });
    // Nothing here is money and nothing here is a contact: a reminder about a late delivery has
    // no business carrying either across the provider boundary.
    assert.equal(fact.classification, "tenant_standard");
  }
  assert.equal(envelope.sources.length, 1);
  assert.equal(envelope.sources[0].route, `/orders/${ORDER_ID}`);
  assert.equal(
    assistantSourceRouteDecision(envelope.sources[0], "office"),
    "allowed",
  );
});

Deno.test("the reminder tool has no recipient, no channel and no send path anywhere in it", async () => {
  // The tool's own body, read from the loaded function rather than from disk: this needs no file
  // permission, and it scans exactly the code that runs rather than a file that merely sits beside it.
  const source = `${draftSupplierReminder.run}\n${draftSupplierReminder.description}`;
  // Code, not prose: strip the comment lines before searching, so a comment EXPLAINING that the
  // product never sends cannot be mistaken for a send path -- nor hide one.
  //
  // `נשלח` is deliberately NOT on this list. #191 forbids the assistant from telling a person that
  // something WAS SENT, and that ban is enforced where the sentence is produced -- validate.ts
  // refuses a draft block containing it, proven further down this file, and AnswerView carries no
  // such string. Here the same letters spell the purchase-order status the product itself uses
  // ("הזמנות שנשלחו לספק"), and banning the substring would force this tool to misname its own
  // domain while catching nothing.
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  for (
    const forbidden of [
      "whatsapp",
      "sendMessage",
      "send_message",
      "mailto:",
      "fetch(",
      "recipient",
      "channel",
      "phone",
      "email",
      "insert(",
      "update(",
      "upsert(",
      "delete(",
    ]
  ) {
    assert.equal(
      code.toLowerCase().includes(forbidden.toLowerCase()),
      false,
      `draftSupplierReminder.ts must not contain ${forbidden}`,
    );
  }

  // And at runtime the projection carries no contact detail either.
  const ctx = ctxWith(fakeDb({ rows: [sentOrder()], hasMore: false, error: null }));
  const envelope = await draftSupplierReminder.run(ctx, {});
  const serialized = JSON.stringify(serializeEnvelopeForProvider(envelope));
  for (const leak of ["@", "05", "+972", "bank_details", "iban"]) {
    assert.equal(serialized.toLowerCase().includes(leak.toLowerCase()), false, leak);
  }
});

Deno.test("an order with no expected date is excluded, and the exclusion is stated", async () => {
  const ctx = ctxWith(fakeDb({
    rows: [sentOrder({ expected_date: null })],
    hasMore: false,
    error: null,
  }));
  const envelope = await draftSupplierReminder.run(ctx, {});
  assert.equal(envelope.result_count, 0);
  assert.equal(envelope.complete, false);
  assert.equal(envelope.failures[0].code, "expected_date_missing");
  // An unmeasurable order must never read as "this supplier is fine".
  assert.deepEqual(envelope.facts, []);
});

Deno.test("an order that is not yet late yields no reminder evidence", async () => {
  const ctx = ctxWith(fakeDb({
    rows: [sentOrder({ expected_date: "2026-08-25" })],
    hasMore: false,
    error: null,
  }));
  const envelope = await draftSupplierReminder.run(ctx, {});
  assert.equal(envelope.result_count, 0);
  assert.deepEqual(envelope.facts, []);
  assert.equal(envelope.complete, true);
});

Deno.test("accountant cannot reach the reminder tool at all (#191)", async () => {
  assert.deepEqual([...draftSupplierReminder.requiredRoles], [...ASSISTANT_DRAFT_ROLES]);
  const registry = buildRegistry([draftSupplierReminder, getProductHelp]);
  const ctx = ctxWith(fakeDb({ rows: [sentOrder()], hasMore: false, error: null }), "accountant");
  const envelope = await runRegisteredTool(registry, ctx, "draft_supplier_reminder", {});
  assert.equal(envelope.failures[0].code, "not_permitted");
  assert.deepEqual(envelope.facts, []);
  assert.equal(envelope.complete, false);
});

Deno.test("with drafting switched off the tool refuses by name instead of returning an empty success", async () => {
  const ctx = ctxWith(fakeDb({ rows: [sentOrder()], hasMore: false, error: null }), "owner", false);
  const envelope = await draftSupplierReminder.run(ctx, {});
  assert.equal(envelope.failures[0].code, "drafts_not_enabled");
  assert.equal(envelope.complete, false);
  assert.deepEqual(envelope.facts, []);
});

Deno.test("a named order that is not awaiting a supplier is a named failure, not a blank draft", async () => {
  const ctx = ctxWith(fakeDb({ rows: [sentOrder()], hasMore: false, error: null }));
  const envelope = await draftSupplierReminder.run(ctx, {
    order_id: "99999999-9999-4999-8999-999999999999",
  });
  assert.equal(envelope.failures[0].code, "order_not_awaiting_supplier");
  assert.deepEqual(envelope.facts, []);
});

/* ============================================================================
 * The two tools meet post-generation validation
 * ==========================================================================*/

Deno.test("a draft body built from these facts validates, and one that invents a number does not", async () => {
  const ctx = ctxWith(fakeDb({ rows: [sentOrder()], hasMore: false, error: null }));
  const envelope = await draftSupplierReminder.run(ctx, {});
  const ids = envelope.facts.map((fact) => fact.id);

  const grounded = {
    blocks: [{
      type: "draft",
      text:
        "שלום, נשמח לעדכון על הזמנה 1042 שתאריך האספקה הצפוי שלה היה 13.08.2026 והיא מתעכבת 7 ימים.",
      fact_ids: ids,
      source_ids: envelope.sources.map((source) => source.id),
    }],
    next_steps: [],
    no_answer_reason: null,
  };
  assert.equal(
    validateAnswer(grounded, envelope.facts, envelope.sources, "office").ok,
    true,
  );

  // A number no fact issued is refused, even inside a message body.
  const invented = {
    ...grounded,
    blocks: [{ ...grounded.blocks[0], text: "שלום, ההזמנה מתעכבת 30 ימים." }],
  };
  const rejected = validateAnswer(invented, envelope.facts, envelope.sources, "office");
  assert.equal(rejected.ok, false);
  assert.ok(
    !rejected.ok && rejected.errors.some((error) => error.includes("numeral_without_fact:30")),
  );

  // And a body that claims the product sent something is refused outright.
  const claimsSent = {
    ...grounded,
    blocks: [{ ...grounded.blocks[0], text: "התזכורת על הזמנה 1042 נשלחה לספק." }],
  };
  const sentRejected = validateAnswer(claimsSent, envelope.facts, envelope.sources, "office");
  assert.equal(sentRejected.ok, false);
  assert.ok(
    !sentRejected.ok &&
      sentRejected.errors.some((error) => error.includes("draft_claims_sent")),
  );

  // accountant is refused the block itself, whatever the facts say.
  assert.equal(
    validateAnswer(grounded, envelope.facts, envelope.sources, "accountant").ok,
    false,
  );
});

Deno.test("a product-help claim validates against the entry fact it cites", async () => {
  const ctx = ctxWith(fakeDb());
  const envelope = await getProductHelp.run(ctx, { question: "איך משווים מחירי ספקים?" });
  const anchor = envelope.facts[0];
  const answer = {
    blocks: [{
      type: "claim",
      text: "השוואת מחירי הספקים נמצאת במסך המחירונים.",
      claim_kind: "product_help.entry",
      subject: null,
      claim_unit: "text",
      claim_value: anchor.value,
      fact_ids: [anchor.id],
      source_ids: envelope.sources.map((source) => source.id),
    }],
    next_steps: [],
    no_answer_reason: null,
  };
  assert.equal(validateAnswer(answer, envelope.facts, envelope.sources, "owner").ok, true);
});
