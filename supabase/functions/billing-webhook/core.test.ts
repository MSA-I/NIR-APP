import { createPaddleAdapter, PADDLE_SIGNATURE_HEADER } from "../_shared/billing-adapter.ts";
import { handleWebhook, type WebhookPorts } from "./core.ts";

const SECRET = "pdl_ntfset_01test0000000000000000000000000000000000";

const PAYLOAD = JSON.stringify({
  event_id: "evt_01hv8x2adt2hy58b2w89p4py4d",
  event_type: "subscription.activated",
  occurred_at: "2026-08-23T09:00:00.000000Z",
  notification_id: "ntf_01hv8x2ag2hadnwngnf1qvegrp",
  data: { id: "sub_1", status: "active", customer_id: "ctm_01hv6y1jedq4p1n0yqn5ba3ky4" },
});

const encoder = new TextEncoder();

async function sign(rawBody: string, ts: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${ts}:${rawBody}`));
  return Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signedHeaders(rawBody: string): Promise<Headers> {
  const ts = Math.floor(Date.now() / 1000);
  return new Headers({ [PADDLE_SIGNATURE_HEADER]: `ts=${ts};h1=${await sign(rawBody, ts)}` });
}

interface Recorder {
  verified: string[];
  recorded: Array<{ providerEventId: string; eventType: string; providerCustomerId: string | null }>;
  applied: string[];
  rejected: Array<{ provider: string; reasonCode: string }>;
}

function ports(overrides: Partial<WebhookPorts> = {}): WebhookPorts & { log: Recorder } {
  const log: Recorder = { verified: [], recorded: [], applied: [], rejected: [] };
  const adapter = createPaddleAdapter(SECRET);
  const base: WebhookPorts = {
    adapter: {
      ...adapter,
      verifyAndParse: (rawBody, headers) => {
        // Captures EXACTLY the bytes the handler passed down, so the test below can prove the
        // handler never reformatted them on the way.
        log.verified.push(rawBody);
        return adapter.verifyAndParse(rawBody, headers);
      },
    },
    recordEvent: (event) => {
      log.recorded.push({
        providerEventId: event.providerEventId,
        eventType: event.eventType,
        providerCustomerId: event.providerCustomerId,
      });
      return Promise.resolve({ ok: true as const, status: "stored" });
    },
    applyEvent: (providerEventId) => {
      log.applied.push(providerEventId);
      return Promise.resolve({ ok: true as const, status: "processed", applied: true });
    },
    recordRejection: (provider, reasonCode) => {
      log.rejected.push({ provider, reasonCode });
      return Promise.resolve();
    },
  };
  return { ...base, ...overrides, log };
}

function request(body: string, headers: Headers, method = "POST"): Request {
  return new Request("https://edge.test/billing-webhook", { method, headers, body: method === "POST" ? body : undefined });
}

// ===== The happy path, and the order it happens in =====

Deno.test("a verified event is recorded FIRST, then applied, keyed by the provider event id", async () => {
  // Record-then-apply is the whole idempotency story: the unique on (provider, provider_event_id)
  // has to be taken before anything can change entitlement, so a redelivery loses the race
  // against itself rather than applying twice.
  const p = ports();
  const response = await handleWebhook(request(PAYLOAD, await signedHeaders(PAYLOAD)), p);
  if (response.status !== 200) throw new Error(`a valid event answered ${response.status}`);
  if (p.log.recorded.length !== 1) throw new Error("the event was not recorded exactly once");
  if (p.log.applied.length !== 1) throw new Error("the transition was not dispatched exactly once");
  if (p.log.recorded[0].providerEventId !== "evt_01hv8x2adt2hy58b2w89p4py4d") {
    throw new Error("the replay key is not the envelope's event_id");
  }
  if (p.log.applied[0] !== "evt_01hv8x2adt2hy58b2w89p4py4d") {
    throw new Error("the dispatcher was not asked about the same event that was recorded");
  }
});

Deno.test("the RAW request body reaches verification, byte for byte", async () => {
  // The single most common way this verification is silently broken: something parses the body
  // and the handler verifies a re-serialised string. Paddle's own documentation names it --
  // "even if the JSON looks identical, whitespace and key ordering may differ".
  const awkward = '{"event_id":"evt_raw",  "event_type":"transaction.paid",\n  "data":{"customer_id":"ctm_1"}}';
  const p = ports();
  await handleWebhook(request(awkward, await signedHeaders(awkward)), p);
  if (p.log.verified.length !== 1) throw new Error("verification was not reached");
  if (p.log.verified[0] !== awkward) {
    throw new Error("the handler reformatted the body before verifying it");
  }
});

Deno.test("nothing the payload contains can name the organization", async () => {
  // The handler passes the provider's customer id down and nothing else that could select a
  // tenant. custom_data, passthrough and metadata are attacker-reachable; the organization is
  // resolved in the database from the link we wrote ourselves.
  const hostile = JSON.stringify({
    event_id: "evt_hostile",
    event_type: "subscription.activated",
    data: {
      customer_id: "ctm_real",
      custom_data: { org_id: "51000000-0000-4000-8000-000000000002" },
      passthrough: '{"org_id":"51000000-0000-4000-8000-000000000002"}',
    },
  });
  const p = ports();
  await handleWebhook(request(hostile, await signedHeaders(hostile)), p);
  if (p.log.recorded[0]?.providerCustomerId !== "ctm_real") {
    throw new Error("attribution was given something other than the provider customer id");
  }
  const recorded = p.log.recorded[0] as unknown as Record<string, unknown>;
  for (const field of ["orgId", "org_id", "organizationId"]) {
    if (field in recorded) throw new Error(`the handler passed ${field} to the database`);
  }
});

// ===== Everything that must never reach the ledger =====

Deno.test("an unverifiable request never reaches the event ledger", async () => {
  // private.billing_events uniques on the event id the request CLAIMS. Writing an unverified one
  // would let an attacker pre-register an identifier and make the genuine delivery look like a
  // replay -- so a rejection is counted, and nothing is stored.
  for (const headers of [
    new Headers({}),
    new Headers({ [PADDLE_SIGNATURE_HEADER]: "ts=1;h1=deadbeef" }),
    new Headers({ [PADDLE_SIGNATURE_HEADER]: "garbage" }),
  ]) {
    const p = ports();
    const response = await handleWebhook(request(PAYLOAD, headers), p);
    if (response.status !== 403) throw new Error(`an unverified request answered ${response.status}`);
    if (p.log.recorded.length !== 0) throw new Error("an unverified request was written to the ledger");
    if (p.log.applied.length !== 0) throw new Error("an unverified request reached a transition");
    if (p.log.rejected.length !== 1 || p.log.rejected[0].reasonCode !== "signature_invalid") {
      throw new Error("an unverified request was not counted for the operator");
    }
  }
});

Deno.test("a tampered body is refused and counted, not stored", async () => {
  const p = ports();
  const headers = await signedHeaders(PAYLOAD);
  const response = await handleWebhook(request(PAYLOAD.replace("ctm_", "ctx_"), headers), p);
  if (response.status !== 403) throw new Error(`a tampered body answered ${response.status}`);
  if (p.log.recorded.length !== 0) throw new Error("a tampered body was written to the ledger");
});

Deno.test("a verified body with an unusable envelope is refused, not stored", async () => {
  const body = JSON.stringify({ event_type: "subscription.activated", data: {} });
  const p = ports();
  const response = await handleWebhook(request(body, await signedHeaders(body)), p);
  if (response.status !== 400) throw new Error(`an unusable envelope answered ${response.status}`);
  if (p.log.recorded.length !== 0) throw new Error("an envelope with no event id was stored anyway");
  if (p.log.rejected[0]?.reasonCode !== "payload_invalid") {
    throw new Error("an unusable envelope was not counted");
  }
});

Deno.test("a provider whose fallback is not authorized is refused before any work", async () => {
  // #207/#256. There is no configuration that makes this a 200.
  const p = ports();
  const response = await handleWebhook(request(PAYLOAD, await signedHeaders(PAYLOAD)), {
    ...p,
    adapter: null,
    adapterRefusal: { code: "not_authorized", detail: "stripe is not authorized" },
  });
  if (response.status !== 403) throw new Error(`an unauthorized provider answered ${response.status}`);
  if (p.log.recorded.length !== 0) throw new Error("an unauthorized provider reached the ledger");
  if (p.log.rejected[0]?.reasonCode !== "not_authorized") {
    throw new Error("an unauthorized provider was not counted by name");
  }
});

Deno.test("a deployment with no endpoint secret refuses instead of accepting anything", async () => {
  const p = ports();
  const response = await handleWebhook(request(PAYLOAD, await signedHeaders(PAYLOAD)), {
    ...p,
    adapter: null,
    adapterRefusal: { code: "not_configured", detail: "PADDLE_WEBHOOK_SECRET is not set" },
  });
  if (response.status !== 503) throw new Error(`an unconfigured deployment answered ${response.status}`);
  if (p.log.recorded.length !== 0) throw new Error("an unconfigured deployment stored an event");
});

// ===== Redelivery, and what the answer tells Paddle to do next =====

Deno.test("a redelivered event answers 200 and changes nothing a second time", async () => {
  // Paddle retries a live delivery up to sixty times over three days with the same event_id. The
  // database is the thing that makes that one effect; the handler's job is to stop asking for
  // more retries once the event is safely held.
  const p = ports({
    recordEvent: () => Promise.resolve({ ok: true as const, status: "stored", idempotent: true }),
    applyEvent: () => Promise.resolve({ ok: true as const, status: "processed", applied: false, idempotent: true }),
  });
  const response = await handleWebhook(request(PAYLOAD, await signedHeaders(PAYLOAD)), p);
  if (response.status !== 200) throw new Error(`a redelivery answered ${response.status}`);
});

Deno.test("an event that dead-letters still answers 200: it is held, and retrying will not help", async () => {
  const p = ports({
    applyEvent: () => Promise.resolve({
      ok: true as const, status: "stored", applied: false, reasonCode: "provider_not_enabled",
    }),
  });
  const response = await handleWebhook(request(PAYLOAD, await signedHeaders(PAYLOAD)), p);
  if (response.status !== 200) throw new Error(`a dead-lettered event answered ${response.status}`);
});

Deno.test("an unattributable event answers 200 rather than inviting sixty retries", async () => {
  const p = ports({
    recordEvent: () => Promise.resolve({ ok: true as const, status: "dead_letter" }),
  });
  const response = await handleWebhook(request(PAYLOAD, await signedHeaders(PAYLOAD)), p);
  if (response.status !== 200) throw new Error(`an unattributable event answered ${response.status}`);
  if (p.log.applied.length !== 0) {
    throw new Error("a transition was dispatched for an event that belongs to no customer");
  }
});

Deno.test("a database failure answers 500, because a retry genuinely could help", async () => {
  const p = ports({
    recordEvent: () => Promise.resolve({ ok: false as const, detail: "connection reset" }),
  });
  const response = await handleWebhook(request(PAYLOAD, await signedHeaders(PAYLOAD)), p);
  if (response.status !== 500) throw new Error(`a storage failure answered ${response.status}`);
});

Deno.test("a failure to dispatch answers 500 even though the event is stored", async () => {
  // The event is safe, but nobody has decided what it means yet, and the provider retrying is the
  // cheapest way to reach that decision. The redelivery is a no-op if it turns out to have run.
  const p = ports({
    applyEvent: () => Promise.resolve({ ok: false as const, detail: "deadlock detected" }),
  });
  const response = await handleWebhook(request(PAYLOAD, await signedHeaders(PAYLOAD)), p);
  if (response.status !== 500) throw new Error(`a dispatch failure answered ${response.status}`);
});

// ===== The door itself =====

Deno.test("only POST is a webhook", async () => {
  for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
    const p = ports();
    const response = await handleWebhook(request("", new Headers({}), method), p);
    if (response.status !== 405) throw new Error(`${method} answered ${response.status}`);
    if (p.log.rejected.length !== 0) throw new Error(`${method} was counted as a provider rejection`);
  }
});

Deno.test("no response body ever explains which check failed", async () => {
  // A refusal that distinguishes "bad signature" from "stale timestamp" from "unknown customer"
  // is a free oracle for whoever is probing the endpoint.
  const bodies: string[] = [];
  for (const headers of [new Headers({}), new Headers({ [PADDLE_SIGNATURE_HEADER]: "ts=1;h1=00" })]) {
    const response = await handleWebhook(request(PAYLOAD, headers), ports());
    bodies.push(await response.text());
  }
  if (bodies[0] !== bodies[1]) throw new Error("two different refusals answered differently");
  for (const body of bodies) {
    if (/timestamp|tolerance|hmac|secret|customer|organization/i.test(body)) {
      throw new Error(`a refusal body explains itself: ${body}`);
    }
  }
});

// ===== The wiring index.ts is allowed to have =====

Deno.test("index.ts never touches the request body; only the tested handler does", async () => {
  // A source assertion on purpose. The hole it guards is reintroduced by a refactor, not by a bug:
  // someone writes `await request.json()` in the wiring because it reads better, and either every
  // signature silently starts failing or -- worse -- one keeps passing against a re-serialised
  // string. Body access lives in exactly one place, and that place is covered by the byte-for-byte
  // test above.
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  for (const forbidden of [/request\.json\s*\(/, /JSON\.parse/, /request\.text\s*\(/, /request\.body/]) {
    if (forbidden.test(source)) {
      throw new Error(`index.ts reads or parses the body itself (${forbidden}); the raw bytes `
        + "must reach verification through handleWebhook untouched");
    }
  }
  if (!/handleWebhook\s*\(/.test(source)) {
    throw new Error("index.ts does not delegate to the tested handler");
  }
  // The service key must never be handed to anything but the platform client.
  if (/SUPABASE_SERVICE_ROLE_KEY/.test(source) && !/createClient/.test(source)) {
    throw new Error("index.ts reads the service key without building the admin client from it");
  }
});

Deno.test("core.ts reads the raw body exactly once, with request.text()", async () => {
  const source = await Deno.readTextFile(new URL("./core.ts", import.meta.url));
  const reads = source.match(/request\.text\s*\(/g) ?? [];
  if (reads.length !== 1) {
    throw new Error(`core.ts reads the body ${reads.length} times; a Request body can only be `
      + "consumed once and the bytes that are verified must be the bytes that arrived");
  }
  if (/request\.json\s*\(/.test(source)) {
    throw new Error("core.ts calls request.json(); the raw bytes are what Paddle signed");
  }
});
