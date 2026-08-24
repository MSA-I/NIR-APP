// Boundary contracts that need the real handler: method discipline and unauthenticated
// rejection. verify_jwt=true means the PLATFORM gate rejects a missing/invalid JWT in
// production before this handler runs; that gate is not exercisable in a unit test, so these
// prove the in-handler half -- the handler refuses a request whose token it did not verify
// itself (defence in depth, not a substitute). Requires --allow-env (the handler reads its
// configuration from the environment); no network is touched on any path exercised here.
import assert from "node:assert/strict";
import { GOVERNANCE_ENV_VARS, GOVERNANCE_ROWS } from "./governance.ts";
import { handler, parseAssistantRequest } from "./index.ts";

function withEnv() {
  Deno.env.set("SUPABASE_URL", "http://127.0.0.1:54321");
  Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
  Deno.env.set("AI_ASSISTANT_API_KEY", "test-provider-key");
  Deno.env.set("AI_ASSISTANT_MODEL", "test-model");
  // #179 evidence is checked before the model, so without it every case below would refuse for
  // the governance reason and the model case would stop proving what it claims to prove. These
  // are fixture SHAPES; the dated evidence lives in docs/ASSISTANT-ACTIVATION-EVIDENCE.md.
  for (const row of GOVERNANCE_ROWS) {
    Deno.env.set(
      GOVERNANCE_ENV_VARS[row],
      `status=VERIFIED;claim=${row}_fixture;source=https://example.test/${row};retrieved=2026-08-24;verifier=test-fixture`,
    );
  }
}

Deno.test("a non-POST method is refused", async () => {
  withEnv();
  const response = await handler(
    new Request("http://localhost/assistant", { method: "GET" }),
  );
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, "assistant_invalid_request");
});

Deno.test("a request without a bearer token is rejected before anything runs", async () => {
  withEnv();
  const response = await handler(
    new Request("http://localhost/assistant", {
      method: "POST",
      body: JSON.stringify({ question: "כמה חשבוניות נקלטו השבוע?" }),
      headers: { "content-type": "application/json" },
    }),
  );
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.code, "assistant_unauthenticated");
});

Deno.test("an unset model refuses every run -- no silent default", async () => {
  withEnv();
  Deno.env.delete("AI_ASSISTANT_MODEL");
  const response = await handler(
    new Request("http://localhost/assistant", {
      method: "POST",
      body: JSON.stringify({ question: "שאלה" }),
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer irrelevant",
      },
    }),
  );
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, "assistant_provider_unavailable");
});

Deno.test("one missing governance row refuses the ask before any provider work (#179)", async () => {
  // The whole point of the gate: a boundary whose provider evidence is incomplete does not
  // degrade, warn or retry -- it refuses, and the browser is told the data is on the screens.
  withEnv();
  Deno.env.delete(GOVERNANCE_ENV_VARS.dpa);
  const response = await handler(
    new Request("http://localhost/assistant", {
      method: "POST",
      body: JSON.stringify({ question: "שאלה" }),
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer irrelevant",
      },
    }),
  );
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, "assistant_provider_unavailable");
});

Deno.test("OPTIONS answers the preflight without touching anything", async () => {
  withEnv();
  const response = await handler(
    new Request("http://localhost/assistant", { method: "OPTIONS" }),
  );
  assert.equal(response.status, 200);
});

Deno.test("request router separates provider turns from history reads before any spend path", () => {
  assert.deepEqual(
    parseAssistantRequest({ question: "שאלה", conversation_id: null, route: null }),
    {
      kind: "ask",
      request: { question: "שאלה", conversation_id: null, route: null },
    },
  );
  assert.deepEqual(
    parseAssistantRequest({ operation: "history_list" }),
    { kind: "history_list", request: { operation: "history_list", limit: 10 } },
  );
  assert.deepEqual(
    parseAssistantRequest({
      operation: "history_load",
      conversation_id: "33333333-3333-4333-8333-333333333333",
    }),
    {
      kind: "history_load",
      request: {
        operation: "history_load",
        conversation_id: "33333333-3333-4333-8333-333333333333",
      },
    },
  );
  assert.deepEqual(
    parseAssistantRequest({ operation: "history_delete" }),
    { kind: "invalid", questionTooLong: false },
  );
});
