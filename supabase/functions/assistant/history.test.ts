import assert from "node:assert/strict";
import type {
  ActorContext,
  EvidenceEntity,
} from "../../../src/lib/assistant/contracts.ts";
import type { EvidenceAuthorizationPort } from "./evidence-authorization.ts";
import { AssistantEdgeError } from "./errors.ts";
import { loadAuthorizedConversationContext } from "./history.ts";

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
    fact_ids: ["f1"],
    source_ids: ["s1"],
  }],
  next_steps: [],
  no_answer_reason: null,
};

function snapshot(blocks: unknown = answer) {
  const shared = {
    run_id: RUN,
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
        question: "מה סכום החשבונית?",
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

Deno.test("a role or scope change removes the whole old run from provider context", async () => {
  const rpc = service(snapshot());
  const messages = await loadAuthorizedConversationContext(
    rpc,
    access({ ...actor, role: "office" }),
    { actor, conversationId: CONVERSATION, limit: 12 },
  );
  assert.deepEqual(messages, []);
});

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
