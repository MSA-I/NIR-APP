// Boundary contracts that need the real handler: method discipline and unauthenticated
// rejection. verify_jwt=true means the PLATFORM gate rejects a missing/invalid JWT in
// production before this handler runs; that gate is not exercisable in a unit test, so these
// prove the in-handler half -- the handler refuses a request whose token it did not verify
// itself (defence in depth, not a substitute). Requires --allow-env (the handler reads its
// configuration from the environment); no network is touched on any path exercised here.
import assert from "node:assert/strict";
import { handler } from "./index.ts";

function withEnv() {
  Deno.env.set("SUPABASE_URL", "http://127.0.0.1:54321");
  Deno.env.set("SUPABASE_ANON_KEY", "test-anon-key");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
  Deno.env.set("AI_ASSISTANT_API_KEY", "test-provider-key");
  Deno.env.set("AI_ASSISTANT_MODEL", "test-model");
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

Deno.test("OPTIONS answers the preflight without touching anything", async () => {
  withEnv();
  const response = await handler(
    new Request("http://localhost/assistant", { method: "OPTIONS" }),
  );
  assert.equal(response.status, 200);
});
