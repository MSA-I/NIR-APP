import {
  billingAdapterFor,
  createPaddleAdapter,
  manualBillingAdapter,
  PADDLE_REPLAY_TOLERANCE_SECONDS,
  PADDLE_SIGNATURE_HEADER,
} from "./billing-adapter.ts";

// ===== Fixtures =====
// The endpoint secret shape is Paddle's own (`pdl_ntfset_…`); the value is invented for this test
// and is not a credential. Nothing here reaches a provider: these tests sign locally and verify
// locally, which is the whole point of testing a signature scheme without an account.
const SECRET = "pdl_ntfset_01test0000000000000000000000000000000000";

/** The documented envelope: event_id, event_type, occurred_at, notification_id, data. */
const PAYLOAD = JSON.stringify({
  event_id: "evt_01hv8x2adt2hy58b2w89p4py4d",
  event_type: "subscription.activated",
  occurred_at: "2026-08-23T09:00:00.000000Z",
  notification_id: "ntf_01hv8x2ag2hadnwngnf1qvegrp",
  data: {
    id: "sub_01hv8wptq8987qeep44cyrewp9",
    status: "active",
    customer_id: "ctm_01hv6y1jedq4p1n0yqn5ba3ky4",
  },
});

const encoder = new TextEncoder();

/** Signs exactly the way the published contract says Paddle does: HMAC-SHA256 over `ts:rawBody`. */
async function sign(rawBody: string, ts: number, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${ts}:${rawBody}`));
  return Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function headersFor(value: string): Headers {
  return new Headers({ [PADDLE_SIGNATURE_HEADER]: value });
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

async function signedHeaders(rawBody: string, ts = nowSeconds()): Promise<Headers> {
  return headersFor(`ts=${ts};h1=${await sign(rawBody, ts)}`);
}

function refusalOf<T>(outcome: { ok: true; value: T } | { ok: false; code: string; detail: string }): string {
  if (outcome.ok) throw new Error("expected a refusal, got an accepted outcome");
  return outcome.code;
}

// ===== The manual adapter still refuses what it cannot do =====

Deno.test("the manual adapter refuses what it cannot do, by name", async () => {
  const checkout = await manualBillingAdapter.createCheckoutSession({
    orgId: "51000000-0000-4000-8000-000000000001",
    planKey: "pro",
    interval: "monthly",
    customerId: "ctm_01hv6y1jedq4p1n0yqn5ba3ky4",
    priceId: "pri_01hv6y1jedq4p1n0yqn5ba3ky4",
  });
  if (checkout.ok) throw new Error("a checkout session was produced with no provider configured");
  if (checkout.code !== "not_configured") throw new Error(`wrong refusal code: ${checkout.code}`);

  const cancel = await manualBillingAdapter.cancelSubscription("sub_whatever");
  if (cancel.ok) throw new Error("a cancellation succeeded with no provider configured");
});

Deno.test("an unsigned webhook body is never parsed into an event", async () => {
  // The refusal is the correct behaviour, not a placeholder: there is no secret to verify
  // against, and an adapter that accepted unsigned payloads would be the hole this boundary
  // exists to prevent.
  const parsed = await manualBillingAdapter.verifyAndParse(
    JSON.stringify({ id: "evt_1", type: "invoice.paid", data: { customer: "cus_1" } }),
    new Headers({ "x-signature": "anything" }),
  );
  if (parsed.ok) throw new Error("an unverified payload became a BillingEvent");
  if (parsed.code !== "not_configured") throw new Error(`wrong refusal code: ${parsed.code}`);
});

Deno.test("a manual customer id is derived from the organization, never invented", async () => {
  // There is no external system filing this customer under another identifier; a random id would
  // create a provider link that resolves to nothing and would then dead-letter every event.
  const result = await manualBillingAdapter.createCustomer(
    "51000000-0000-4000-8000-000000000001",
    "owner@example.test",
  );
  if (!result.ok) throw new Error("the manual adapter refused to name its own customer");
  if (!result.value.customerId.includes("51000000-0000-4000-8000-000000000001")) {
    throw new Error("the manual customer id is not derived from the organization");
  }
});

// ===== Paddle signature verification =====
// Contract read 23.08.2026 from https://developer.paddle.com/webhooks/about/signature-verification/

Deno.test("a correctly signed Paddle webhook is verified and parsed", async () => {
  const adapter = createPaddleAdapter(SECRET);
  const result = await adapter.verifyAndParse(PAYLOAD, await signedHeaders(PAYLOAD));
  if (!result.ok) throw new Error(`a valid signature was refused: ${result.code} ${result.detail}`);
  if (result.value.provider !== "paddle") throw new Error("the event was filed under another provider");
  if (result.value.providerEventId !== "evt_01hv8x2adt2hy58b2w89p4py4d") {
    throw new Error("the replay key is not the envelope's event_id");
  }
  if (result.value.eventType !== "subscription.activated") throw new Error("the event type was lost");
  if (result.value.providerCustomerId !== "ctm_01hv6y1jedq4p1n0yqn5ba3ky4") {
    throw new Error("attribution did not read data.customer_id");
  }
});

Deno.test("a wrong signature is refused", async () => {
  const adapter = createPaddleAdapter(SECRET);
  const ts = nowSeconds();
  const wrong = await sign(PAYLOAD, ts, "pdl_ntfset_someone_elses_secret_value_0000000");
  const result = await adapter.verifyAndParse(PAYLOAD, headersFor(`ts=${ts};h1=${wrong}`));
  if (refusalOf(result) !== "signature_invalid") throw new Error("a foreign signature was accepted");
});

Deno.test("a missing Paddle-Signature header is refused", async () => {
  const adapter = createPaddleAdapter(SECRET);
  const result = await adapter.verifyAndParse(PAYLOAD, new Headers({ "content-type": "application/json" }));
  if (refusalOf(result) !== "signature_invalid") throw new Error("an unsigned request was accepted");
});

Deno.test("a malformed Paddle-Signature header is refused", async () => {
  const adapter = createPaddleAdapter(SECRET);
  for (const value of ["", "garbage", "ts=;h1=", "h1=abc", "ts=1671552777", "ts=abc;h1=deadbeef"]) {
    const result = await adapter.verifyAndParse(PAYLOAD, headersFor(value));
    if (refusalOf(result) !== "signature_invalid") {
      throw new Error(`a malformed signature header was accepted: ${JSON.stringify(value)}`);
    }
  }
});

Deno.test("a tampered body is refused even though the signature is otherwise well formed", async () => {
  const adapter = createPaddleAdapter(SECRET);
  const ts = nowSeconds();
  const authentic = `ts=${ts};h1=${await sign(PAYLOAD, ts)}`;
  const tampered = PAYLOAD.replace("ctm_01hv6y1jedq4p1n0yqn5ba3ky4", "ctm_attacker000000000000000");
  const result = await adapter.verifyAndParse(tampered, headersFor(authentic));
  if (refusalOf(result) !== "signature_invalid") throw new Error("a body swapped under a valid signature was accepted");
});

Deno.test("the signed bytes are the RAW body, never a re-serialized object", async () => {
  // Paddle: "Don't transform or process the raw body of the request, including adding whitespace
  // or applying other formatting." A verifier that re-serialized the parsed JSON would accept a
  // body it never actually saw, so a semantically identical but differently formatted body must
  // fail against a signature made over the original bytes.
  const adapter = createPaddleAdapter(SECRET);
  const ts = nowSeconds();
  const reserialized = JSON.stringify(JSON.parse(PAYLOAD), null, 2);
  if (reserialized === PAYLOAD) throw new Error("the fixture cannot distinguish raw from re-serialized bytes");
  const result = await adapter.verifyAndParse(
    reserialized,
    headersFor(`ts=${ts};h1=${await sign(PAYLOAD, ts)}`),
  );
  if (refusalOf(result) !== "signature_invalid") throw new Error("a re-serialized body verified against the raw signature");
});

Deno.test("a stale timestamp outside the tolerance window is refused", async () => {
  const adapter = createPaddleAdapter(SECRET);
  const ts = nowSeconds() - (PADDLE_REPLAY_TOLERANCE_SECONDS + 60);
  const result = await adapter.verifyAndParse(PAYLOAD, headersFor(`ts=${ts};h1=${await sign(PAYLOAD, ts)}`));
  if (refusalOf(result) !== "signature_invalid") throw new Error("a replayed old event was accepted");
});

Deno.test("a future timestamp outside the tolerance window is refused", async () => {
  // The published guidance names only stale events, but a signature valid arbitrarily far into
  // the future is a replay token with no expiry. The window is applied symmetrically.
  const adapter = createPaddleAdapter(SECRET);
  const ts = nowSeconds() + (PADDLE_REPLAY_TOLERANCE_SECONDS + 60);
  const result = await adapter.verifyAndParse(PAYLOAD, headersFor(`ts=${ts};h1=${await sign(PAYLOAD, ts)}`));
  if (refusalOf(result) !== "signature_invalid") throw new Error("an event timestamped in the future was accepted");
});

Deno.test("a timestamp inside the tolerance window is accepted", async () => {
  const adapter = createPaddleAdapter(SECRET);
  const ts = nowSeconds() - Math.max(0, PADDLE_REPLAY_TOLERANCE_SECONDS - 1);
  const result = await adapter.verifyAndParse(PAYLOAD, headersFor(`ts=${ts};h1=${await sign(PAYLOAD, ts)}`));
  if (!result.ok) throw new Error(`an in-window event was refused: ${result.code} ${result.detail}`);
});

Deno.test("a truncated signature is refused rather than matching a prefix", async () => {
  // A comparison that returned early on length, or compared only the overlapping span, would
  // accept a one-character h1. Both are the classic ways a constant-time compare is undone.
  const adapter = createPaddleAdapter(SECRET);
  const ts = nowSeconds();
  const full = await sign(PAYLOAD, ts);
  for (const truncated of [full.slice(0, 1), full.slice(0, 32), full.slice(0, 63), `${full}00`]) {
    const result = await adapter.verifyAndParse(PAYLOAD, headersFor(`ts=${ts};h1=${truncated}`));
    if (refusalOf(result) !== "signature_invalid") {
      throw new Error(`a signature of length ${truncated.length} was accepted`);
    }
  }
});

Deno.test("secret rotation: a header carrying several h1 values verifies if any one matches", async () => {
  // Paddle: "Signatures contain at least one h1... During secret rotation, more than one h1 is
  // returned." Reading only the first would drop every event mid-rotation.
  const adapter = createPaddleAdapter(SECRET);
  const ts = nowSeconds();
  const mine = await sign(PAYLOAD, ts);
  const other = await sign(PAYLOAD, ts, "pdl_ntfset_the_other_half_of_the_rotation_00");
  const result = await adapter.verifyAndParse(PAYLOAD, headersFor(`ts=${ts};h1=${other};h1=${mine}`));
  if (!result.ok) throw new Error(`a rotating signature was refused: ${result.code}`);
});

Deno.test("an adapter with no secret refuses every payload instead of verifying nothing", async () => {
  const adapter = createPaddleAdapter("");
  const result = await adapter.verifyAndParse(PAYLOAD, await signedHeaders(PAYLOAD));
  if (refusalOf(result) !== "not_configured") throw new Error("an unconfigured adapter verified a payload");
});

// ===== The attack this boundary exists to close =====

Deno.test("NO payload field can name the organization", async () => {
  // custom_data, passthrough and metadata are attacker-reachable: whoever opens a checkout can
  // put anything there. A verified event therefore exposes the provider's customer id and
  // nothing else that could select a tenant; the organization is resolved in the database from
  // the link we wrote ourselves (0154/0157).
  const adapter = createPaddleAdapter(SECRET);
  const hostile = JSON.stringify({
    event_id: "evt_forged",
    event_type: "subscription.activated",
    occurred_at: "2026-08-23T09:00:00.000000Z",
    data: {
      id: "sub_1",
      customer_id: "ctm_01hv6y1jedq4p1n0yqn5ba3ky4",
      custom_data: { org_id: "51000000-0000-4000-8000-000000000002" },
      passthrough: JSON.stringify({ org_id: "51000000-0000-4000-8000-000000000002" }),
      metadata: { org_id: "51000000-0000-4000-8000-000000000002", organization_id: "whatever" },
    },
  });
  const result = await adapter.verifyAndParse(hostile, await signedHeaders(hostile));
  if (!result.ok) throw new Error(`a well-signed hostile payload was refused for the wrong reason: ${result.code}`);

  const event = result.value as unknown as Record<string, unknown>;
  for (const field of ["orgId", "org_id", "organizationId", "organization_id"]) {
    if (field in event) throw new Error(`the verified event exposes ${field}, which a payload can set`);
  }
  if (result.value.providerCustomerId !== "ctm_01hv6y1jedq4p1n0yqn5ba3ky4") {
    throw new Error("attribution read something other than data.customer_id");
  }
});

Deno.test("a customer id that is not a string is refused rather than coerced", async () => {
  const adapter = createPaddleAdapter(SECRET);
  for (const customerId of [{ toString: "x" }, 12345, ["ctm_1"], true]) {
    const body = JSON.stringify({
      event_id: "evt_coerce",
      event_type: "subscription.activated",
      data: { customer_id: customerId },
    });
    const result = await adapter.verifyAndParse(body, await signedHeaders(body));
    if (!result.ok) continue;
    if (result.value.providerCustomerId !== null) {
      throw new Error(`a non-string customer id was coerced into ${result.value.providerCustomerId}`);
    }
  }
});

Deno.test("an envelope without an event_id or an event_type is refused", async () => {
  const adapter = createPaddleAdapter(SECRET);
  for (const body of [
    JSON.stringify({ event_type: "subscription.activated", data: {} }),
    JSON.stringify({ event_id: "evt_1", data: {} }),
    JSON.stringify({ event_id: "", event_type: "subscription.activated", data: {} }),
    JSON.stringify(["not", "an", "object"]),
    "not json at all",
  ]) {
    const result = await adapter.verifyAndParse(body, await signedHeaders(body));
    if (refusalOf(result) !== "payload_invalid") {
      throw new Error(`an unusable envelope was accepted: ${body.slice(0, 40)}`);
    }
  }
});

// ===== The fallback boundary is closed and cannot be opened by configuration =====

Deno.test("an unknown provider refuses rather than falling back to manual", () => {
  // Falling back would make an unrecognised provider look identical to a correctly refused
  // event, which is precisely the confusion to avoid when a customer's payment did nothing.
  const resolved = billingAdapterFor("nonesuch", () => undefined);
  if (resolved.ok) throw new Error("an unregistered provider resolved to an adapter");
  if (resolved.code !== "unsupported") throw new Error(`wrong refusal code: ${resolved.code}`);

  const manual = billingAdapterFor("manual", () => undefined);
  if (!manual.ok) throw new Error("the manual adapter did not resolve");
});

Deno.test("the Stripe and Morning fallbacks cannot be activated by ANY environment", async () => {
  // OPEN-DECISIONS #207 and #256: Stripe direct and Morning are fallback only and are explicitly
  // not authorized. The interface exists so a second adapter is possible; there must be no
  // configuration under which one becomes the active merchant of record.
  const generousEnvironment = () => "yes";
  for (const provider of ["stripe", "morning"]) {
    const resolved = billingAdapterFor(provider, generousEnvironment);
    if (resolved.ok) {
      throw new Error(`${provider} resolved to a live adapter; the fallback boundary is open`);
    }
    if (resolved.code !== "not_authorized") {
      throw new Error(`${provider} refused with ${resolved.code} rather than not_authorized`);
    }
  }
});

Deno.test("Paddle resolves only when its endpoint secret is present, and never verifies without one", async () => {
  const withoutSecret = billingAdapterFor("paddle", () => undefined);
  if (withoutSecret.ok) throw new Error("Paddle resolved with no endpoint secret configured");
  if (withoutSecret.code !== "not_configured") {
    throw new Error(`Paddle refused with ${withoutSecret.code} rather than not_configured`);
  }

  const withSecret = billingAdapterFor("paddle", (name) =>
    name === "PADDLE_WEBHOOK_SECRET" ? SECRET : undefined);
  if (!withSecret.ok) throw new Error(`Paddle did not resolve with its secret: ${withSecret.code}`);
  const verified = await withSecret.value.verifyAndParse(PAYLOAD, await signedHeaders(PAYLOAD));
  if (!verified.ok) throw new Error("the resolved Paddle adapter could not verify its own signature");
});

Deno.test("no adapter offers hosted checkout or cancellation while no provider is proven", async () => {
  // Paddle is SELECTED / ACCOUNT_NOT_PROVEN / KYC_NOT_PROVEN / ISRAEL_PAYOUT_NOT_PROVEN /
  // NOT_INTEGRATED (#213). Signature verification is code against a published contract; a
  // checkout session is a live provider call, and this build must not be able to make one.
  const adapter = createPaddleAdapter(SECRET);
  const checkout = await adapter.createCheckoutSession({
    orgId: "51000000-0000-4000-8000-000000000001",
    planKey: "pro",
    interval: "monthly",
    customerId: "ctm_01hv6y1jedq4p1n0yqn5ba3ky4",
    priceId: "pri_01hv6y1jedq4p1n0yqn5ba3ky4",
  });
  if (checkout.ok) throw new Error("a hosted checkout was produced against an unproven account");
  if (checkout.code !== "not_configured") throw new Error(`wrong refusal code: ${checkout.code}`);

  const cancel = await adapter.cancelSubscription("sub_1");
  if (cancel.ok) throw new Error("a provider-side cancellation was attempted against an unproven account");

  const customer = await adapter.createCustomer("51000000-0000-4000-8000-000000000001", "o@example.test");
  if (customer.ok) throw new Error("a provider-side customer was created against an unproven account");
});
