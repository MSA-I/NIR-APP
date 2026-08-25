import assert from "node:assert/strict";
import type {
  ActorContext,
  EvidenceEntity,
} from "../../../src/lib/assistant/contracts.ts";
import type { EvidenceAuthorizationPort } from "./evidence-authorization.ts";
import { AssistantEdgeError } from "./errors.ts";
import {
  CONVERSATION_IDLE_TTL_MS,
  isConversationExpired,
  listAuthorizedConversations,
  loadAuthorizedConversationContext,
  loadAuthorizedConversationViews,
} from "./history.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const CONVERSATION = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";
const INVOICE = "55555555-5555-4555-8555-555555555555";

const actor: ActorContext = {
  userId: USER,
  orgId: ORG,
  role: "owner",
  scopes: [],
  canWrite: true,
  capabilities: {
    ui: true,
    history: true,
    drafts: false,
    confirmedActions: false,
  },
};

const answer = {
  blocks: [{
    type: "claim",
    text: "סכום החשבונית הוא 12 שקלים.",
    claim_kind: "invoice.total",
    subject: { entity: "invoice", id: INVOICE },
    claim_unit: "ils",
    claim_value: 12,
    fact_ids: ["f1"],
    source_ids: ["s1"],
  }],
  next_steps: [],
  no_answer_reason: null,
};

function snapshot(blocks: unknown = answer, question = "מה סכום החשבונית?") {
  const shared = {
    run_id: RUN,
    run_as_of: "2026-08-20T10:00:01.000Z",
    complete: true,
    tools: [{ tool: "explain_invoice_block", complete: true }],
    actor,
    facts: [{
      id: "f1",
      kind: "invoice.total",
      subject: { entity: "invoice", id: INVOICE },
      label: "סכום החשבונית",
      value: 12,
      unit: "ils",
      tool: "explain_invoice_block",
      as_of: "2026-08-20T10:00:00.000Z",
      classification: "financial_sensitive",
    }],
    sources: [{
      id: "s1",
      entity: "invoice",
      entity_id: INVOICE,
      label: "החשבונית",
      route: `/invoices/${INVOICE}`,
      classification: "financial_sensitive",
    }],
  };
  return {
    conversation_id: CONVERSATION,
    messages: [
      {
        ...shared,
        message_id: "66666666-6666-4666-8666-666666666666",
        author: "user",
        question,
        blocks: null,
        created_at: "2026-08-20T10:00:00.000Z",
      },
      {
        ...shared,
        message_id: "77777777-7777-4777-8777-777777777777",
        author: "assistant",
        question: null,
        blocks,
        created_at: "2026-08-20T10:00:01.000Z",
      },
    ],
  };
}

function service(data: unknown, error: { message: string } | null = null) {
  const calls: unknown[][] = [];
  return {
    calls,
    rpc(name: string, args: Record<string, unknown>) {
      calls.push([name, args]);
      return Promise.resolve({ data, error });
    },
  };
}

function routedService(routes: Record<string, unknown>) {
  const calls: unknown[][] = [];
  return {
    calls,
    rpc(name: string, args: Record<string, unknown>) {
      calls.push([name, args]);
      return Promise.resolve({ data: routes[name] ?? null, error: null });
    },
  };
}

function access(current: ActorContext = actor, visible = true): EvidenceAuthorizationPort {
  return {
    resolveCurrentActor: () => Promise.resolve(current),
    visibleEntityIds: (_entity: EvidenceEntity, ids: readonly string[]) =>
      Promise.resolve(visible ? [...ids] : []),
  };
}

Deno.test("history context uses the service snapshot and revalidates its structured evidence", async () => {
  const rpc = service(snapshot());
  const messages = await loadAuthorizedConversationContext(
    rpc,
    access(),
    { actor, conversationId: CONVERSATION, limit: 12 },
  );
  assert.deepEqual(rpc.calls, [[
    "service_assistant_conversation_snapshot",
    {
      p_org_id: ORG,
      p_user_id: USER,
      p_conversation_id: CONVERSATION,
      p_limit: 12,
    },
  ]]);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], { role: "user", content: "מה סכום החשבונית?" });
  assert.deepEqual(JSON.parse(messages[1].content), answer);
});

Deno.test("authorized history view returns one browser-safe run envelope with current evidence", async () => {
  const views = await loadAuthorizedConversationViews(
    service(snapshot()),
    access(),
    { actor, conversationId: CONVERSATION, limit: 12 },
  );

  assert.equal(views.length, 1);
  assert.equal(views[0].question, "מה סכום החשבונית?");
  assert.equal(views[0].result.run_id, RUN);
  assert.equal(views[0].result.conversation_id, CONVERSATION);
  assert.equal(views[0].result.complete, true);
  assert.equal(views[0].result.as_of, "2026-08-20T10:00:01.000Z");
  assert.deepEqual(views[0].result.tools_used, [
    { tool: "explain_invoice_block", complete: true },
  ]);
  assert.deepEqual(views[0].result.answer, answer);
  assert.equal(views[0].result.facts.length, 1);
  assert.equal(views[0].result.sources.length, 1);
});

Deno.test("history list returns only conversations whose latest run passes current reauthorization", async () => {
  const rpc = routedService({
    service_assistant_recent_conversations: {
      conversations: [{ id: CONVERSATION, updated_at: "2026-08-20T10:00:01.000Z" }],
    },
    service_assistant_conversation_snapshot: snapshot(),
  });
  const rows = await listAuthorizedConversations(
    rpc,
    access(),
    // `now` is injected because the list now applies an idle expiry (#272). Without it this
    // fixture would age past the window on its own and the case would start failing by calendar.
    { actor, limit: 10, now: new Date("2026-08-20T12:00:00.000Z") },
  );

  assert.deepEqual(rows, [{
    id: CONVERSATION,
    title: "מה סכום החשבונית?",
    updated_at: "2026-08-20T10:00:01.000Z",
  }]);
  assert.deepEqual(rpc.calls[0], [
    "service_assistant_recent_conversations",
    { p_org_id: ORG, p_user_id: USER, p_limit: 10 },
  ]);
});

Deno.test("history list omits even title and date when current source access is gone", async () => {
  const rpc = routedService({
    service_assistant_recent_conversations: {
      conversations: [{ id: CONVERSATION, updated_at: "2026-08-20T10:00:01.000Z" }],
    },
    service_assistant_conversation_snapshot: snapshot(),
  });
  const rows = await listAuthorizedConversations(
    rpc,
    access(actor, false),
    { actor, limit: 10, now: new Date("2026-08-20T12:00:00.000Z") },
  );
  assert.deepEqual(rows, []);
});

Deno.test("a role or scope change removes the whole old run from provider context", async () => {
  const rpc = service(snapshot());
  const messages = await loadAuthorizedConversationContext(
    rpc,
    access({ ...actor, role: "office" }),
    { actor, conversationId: CONVERSATION, limit: 12 },
  );
  assert.deepEqual(messages, []);
});

Deno.test("revoking the history flag removes the whole old run", async () => {
  const rpc = service(snapshot());
  const messages = await loadAuthorizedConversationContext(
    rpc,
    access({
      ...actor,
      capabilities: { ...actor.capabilities, history: false },
    }),
    { actor, conversationId: CONVERSATION, limit: 12 },
  );
  assert.deepEqual(messages, []);
});

Deno.test("a tenant change removes the whole old run", async () => {
  const rpc = service(snapshot());
  const messages = await loadAuthorizedConversationContext(
    rpc,
    access({
      ...actor,
      orgId: "88888888-8888-4888-8888-888888888888",
    }),
    { actor, conversationId: CONVERSATION, limit: 12 },
  );
  assert.deepEqual(messages, []);
});

for (const lifecycle of ["disabled/offboarded user", "suspended organization"] as const) {
  Deno.test(`${lifecycle} removes the whole old run`, async () => {
    const rpc = service(snapshot());
    const messages = await loadAuthorizedConversationContext(
      rpc,
      {
        resolveCurrentActor: () => Promise.reject(new AssistantEdgeError("assistant_disabled")),
        visibleEntityIds: (_entity, ids) => Promise.resolve([...ids]),
      },
      { actor, conversationId: CONVERSATION, limit: 12 },
    );
    assert.deepEqual(messages, []);
  });
}

Deno.test("a deleted or newly hidden entity removes its question and answer", async () => {
  const rpc = service(snapshot());
  const messages = await loadAuthorizedConversationContext(
    rpc,
    access(actor, false),
    { actor, conversationId: CONVERSATION, limit: 12 },
  );
  assert.deepEqual(messages, []);
});

Deno.test("malformed stored blocks never become provider text", async () => {
  const injected = "raw stored secret 999";
  const rpc = service(snapshot({ raw: injected }));
  const messages = await loadAuthorizedConversationContext(
    rpc,
    access(),
    { actor, conversationId: CONVERSATION, limit: 12 },
  );
  assert.deepEqual(messages, []);
  assert.ok(!JSON.stringify(messages).includes(injected));
});

Deno.test("stored free text is reclassified and restricted runs never re-enter provider context", async () => {
  const restricted = "מספר חשבון הבנק הוא 123456 בסניף 001";
  const rpc = service(snapshot(answer, restricted));
  const messages = await loadAuthorizedConversationContext(
    rpc,
    access(),
    { actor, conversationId: CONVERSATION, limit: 12 },
  );
  assert.deepEqual(messages, []);
  assert.ok(!JSON.stringify(messages).includes(restricted));
});

Deno.test("an unavailable service snapshot maps to the one safe history refusal", async () => {
  const rpc = service(null, { message: "raw database detail" });
  await assert.rejects(
    loadAuthorizedConversationContext(
      rpc,
      access(),
      { actor, conversationId: CONVERSATION, limit: 12 },
    ),
    (error: unknown) =>
      error instanceof AssistantEdgeError &&
      error.code === "assistant_history_unavailable",
  );
});

// ---------------------------------------------------------------------------------------------
// Idle expiry (OPEN-DECISIONS #272, owner 25.08.2026).
//
// "A thread without history — meaning after 24 hours of no use it resets." That is an expiry,
// not the absence of persistence: inside the window a refresh must not end the conversation.
// These cases pin both halves, because only proving the second one would let a regression that
// never resumes anything pass as "working".

const LAST_USED = "2026-08-20T10:00:00.000Z";
const listAt = (now: string, updatedAt: string = LAST_USED) =>
  listAuthorizedConversations(
    routedService({
      service_assistant_recent_conversations: {
        conversations: [{ id: CONVERSATION, updated_at: updatedAt }],
      },
      service_assistant_conversation_snapshot: snapshot(),
    }),
    access(),
    { actor, limit: 10, now: new Date(now) },
  );

Deno.test("a conversation used an hour ago is still offered back", async () => {
  assert.equal((await listAt("2026-08-20T11:00:00.000Z")).length, 1);
});

Deno.test("a conversation idle just under 24 hours survives -- a refresh must not end it", async () => {
  assert.equal((await listAt("2026-08-21T09:59:59.000Z")).length, 1);
});

Deno.test("a conversation idle past 24 hours is not offered back", async () => {
  assert.deepEqual(await listAt("2026-08-21T10:00:01.000Z"), []);
});

Deno.test("the reset is total: days later there is nothing to resume", async () => {
  assert.deepEqual(await listAt("2026-09-01T10:00:00.000Z"), []);
});

Deno.test("an unreadable timestamp expires rather than resurrects", async () => {
  // The safe direction: start a new thread. Resuming a conversation whose age cannot be
  // established is the one outcome the owner's ruling rules out.
  assert.deepEqual(await listAt("2026-08-20T11:00:00.000Z", "not-a-date"), []);
});

Deno.test("expiry is decided per conversation, not for the whole list", async () => {
  const fresh = "66666666-6666-4666-8666-666666666666";
  const rows = await listAuthorizedConversations(
    routedService({
      service_assistant_recent_conversations: {
        conversations: [
          { id: CONVERSATION, updated_at: "2026-08-19T10:00:00.000Z" }, // stale
          { id: fresh, updated_at: "2026-08-21T09:00:00.000Z" }, // fresh
        ],
      },
      service_assistant_conversation_snapshot: snapshot(),
    }),
    access(),
    { actor, limit: 10, now: new Date("2026-08-21T10:00:00.000Z") },
  );
  assert.deepEqual(rows.map((r) => r.id), [fresh]);
});

Deno.test("the window is the documented 24 hours, not a number that drifted", () => {
  assert.equal(CONVERSATION_IDLE_TTL_MS, 24 * 60 * 60 * 1000);
  assert.equal(isConversationExpired(LAST_USED, new Date("2026-08-21T09:59:59.000Z")), false);
  assert.equal(isConversationExpired(LAST_USED, new Date("2026-08-21T10:00:01.000Z")), true);
});
