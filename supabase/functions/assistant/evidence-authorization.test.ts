import assert from "node:assert/strict";
import type {
  ActorContext,
  AssistantAnswer,
  EvidenceEntity,
  Fact,
  SourceReference,
} from "../../../src/lib/assistant/contracts.ts";
import {
  assistantActorContextsEqual,
  authorizeAssistantEvidence,
  createSupabaseEvidenceAuthorizationPort,
  type EvidenceAuthorizationPort,
} from "./evidence-authorization.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const INVOICE = "33333333-3333-4333-8333-333333333333";

const actor: ActorContext = {
  userId: USER,
  orgId: ORG,
  role: "owner",
  scopes: ["44444444-4444-4444-8444-444444444444"],
  canWrite: true,
  capabilities: {
    ui: true,
    history: true,
    drafts: false,
    confirmedActions: false,
  },
};

const answer: AssistantAnswer = {
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

const fact: Fact = {
  id: "f1",
  kind: "invoice.total",
  subject: { entity: "invoice", id: INVOICE },
  label: "סכום החשבונית",
  value: 12,
  unit: "ils",
  tool: "explain_invoice_block",
  as_of: "2026-08-20T10:00:00.000Z",
  classification: "financial_sensitive",
};

const source: SourceReference = {
  id: "s1",
  entity: "invoice",
  entity_id: INVOICE,
  label: "החשבונית",
  route: `/invoices/${INVOICE}`,
  classification: "financial_sensitive",
};

function port(overrides: Partial<EvidenceAuthorizationPort> = {}): EvidenceAuthorizationPort {
  return {
    resolveCurrentActor: () => Promise.resolve(actor),
    visibleEntityIds: (_entity: EvidenceEntity, ids: readonly string[]) =>
      Promise.resolve([...ids]),
    ...overrides,
  };
}

Deno.test("unchanged actor and currently visible evidence are authorized", async () => {
  const result = await authorizeAssistantEvidence(
    port(),
    actor,
    answer,
    [fact],
    [source],
  );
  assert.deepEqual(result, { ok: true });
});

Deno.test("role or scope changes revoke even aggregate facts that cannot be re-read", async () => {
  const aggregate = { ...fact, subject: null, kind: "metric.money" as const };
  const changed = {
    ...actor,
    scopes: ["55555555-5555-4555-8555-555555555555"],
  };
  let entityReads = 0;
  const result = await authorizeAssistantEvidence(
    port({
      resolveCurrentActor: () => Promise.resolve(changed),
      visibleEntityIds: (_entity, ids) => {
        entityReads += 1;
        return Promise.resolve([...ids]);
      },
    }),
    actor,
    answer,
    [aggregate],
    [],
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.includes("evidence:actor_context_changed"));
  assert.equal(entityReads, 0);
});

Deno.test("a deleted, foreign, or newly hidden entity revokes its fact and source", async () => {
  const result = await authorizeAssistantEvidence(
    port({ visibleEntityIds: () => Promise.resolve([]) }),
    actor,
    answer,
    [fact],
    [source],
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.includes("fact:f1:subject_not_authorized"));
    assert.ok(result.errors.includes("source:s1:entity_not_authorized"));
  }
});

Deno.test("actor equality is order-insensitive for scopes and strict for lifecycle capabilities", () => {
  assert.equal(
    assistantActorContextsEqual(
      { ...actor, scopes: [...actor.scopes].reverse() },
      actor,
    ),
    true,
  );
  assert.equal(
    assistantActorContextsEqual(
      {
        ...actor,
        capabilities: { ...actor.capabilities, history: false },
      },
      actor,
    ),
    false,
  );
});

Deno.test("a tenant change revokes evidence before entity reads", async () => {
  let entityReads = 0;
  const result = await authorizeAssistantEvidence(
    port({
      resolveCurrentActor: () => Promise.resolve({
        ...actor,
        orgId: "66666666-6666-4666-8666-666666666666",
      }),
      visibleEntityIds: (_entity, ids) => {
        entityReads += 1;
        return Promise.resolve([...ids]);
      },
    }),
    actor,
    answer,
    [fact],
    [source],
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.errors.includes("evidence:actor_context_changed"));
  assert.equal(entityReads, 0);
});

Deno.test("an aggregate source is authorized only for the current organization", async () => {
  const orgSource: SourceReference = {
    ...source,
    entity: "organization",
    entity_id: ORG,
    route: "/dashboard",
  };
  const allowed = await authorizeAssistantEvidence(port(), actor, answer, [], [orgSource]);
  assert.deepEqual(allowed, { ok: true });

  const foreign = await authorizeAssistantEvidence(
    port(),
    actor,
    answer,
    [],
    [{ ...orgSource, entity_id: "66666666-6666-4666-8666-666666666666" }],
  );
  assert.equal(foreign.ok, false);
  if (!foreign.ok) assert.ok(foreign.errors.includes("source:s1:entity_not_authorized"));
});

Deno.test("an entity-access read failure refuses instead of treating evidence as visible", async () => {
  const result = await authorizeAssistantEvidence(
    port({ visibleEntityIds: () => Promise.reject(new Error("db unavailable")) }),
    actor,
    answer,
    [fact],
    [source],
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.errors, ["evidence:authorization_unavailable"]);
});

Deno.test("the Supabase port rechecks only an explicit id projection on the mapped RLS table", async () => {
  const calls: unknown[][] = [];
  const client = {
    rpc: () => Promise.resolve({ data: null, error: null }),
    from(table: string) {
      calls.push(["from", table]);
      return {
        select(columns: string) {
          calls.push(["select", columns]);
          return {
            in(column: string, ids: readonly unknown[]) {
              calls.push(["in", column, ids]);
              return Promise.resolve({ data: [{ id: INVOICE }], error: null });
            },
          };
        },
      };
    },
  };
  const access = createSupabaseEvidenceAuthorizationPort(client, USER);
  assert.deepEqual(await access.visibleEntityIds("invoice", [INVOICE]), [INVOICE]);
  assert.deepEqual(calls, [
    ["from", "invoices"],
    ["select", "id"],
    ["in", "id", [INVOICE]],
  ]);
});

Deno.test("the Supabase port resolves current actor afresh at every authorization moment", async () => {
  let roleReads = 0;
  const client = {
    rpc(name: string) {
      const result = (() => {
        if (name === "auth_org") return { data: ORG, error: null };
        if (name === "auth_role") {
          roleReads += 1;
          return { data: roleReads === 1 ? "owner" : "office", error: null };
        }
        if (name === "auth_scopes") return { data: actor.scopes, error: null };
        if (name === "organization_access_state") {
          return { data: [{ access_mode: "active" }], error: null };
        }
        if (name === "resolve_feature_flags") {
          return {
            data: [
              { flag_key: "assistant.ui", state: true },
              { flag_key: "assistant.history", state: true },
              { flag_key: "assistant.drafts", state: false },
            ],
            error: null,
          };
        }
        if (name === "assistant_confirmed_actions_enabled") {
          return { data: false, error: null };
        }
        return { data: null, error: { message: `unexpected rpc ${name}` } };
      })();
      return Promise.resolve(result);
    },
    from() {
      return {
        select() {
          return {
            in() {
              return Promise.resolve({ data: [], error: null });
            },
          };
        },
      };
    },
  };
  const access = createSupabaseEvidenceAuthorizationPort(client, USER);
  assert.equal((await access.resolveCurrentActor()).role, "owner");
  assert.equal((await access.resolveCurrentActor()).role, "office");
  assert.equal(roleReads, 2);
});

Deno.test("a product source points only to the staff product route", async () => {
  const productId = "77777777-7777-4777-8777-777777777777";
  const productSource: SourceReference = {
    ...source,
    entity: "product",
    entity_id: productId,
    route: "/products",
  };
  const result = await authorizeAssistantEvidence(
    port(),
    actor,
    answer,
    [],
    [productSource],
  );
  assert.deepEqual(result, { ok: true });
});
