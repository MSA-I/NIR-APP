import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDeliveryHeaders,
  type ClaimedRow,
  resolveTarget,
  signedPayload,
} from "./core.ts";

// The SAME known-answer vector p7_integration_adapters.sql pins against
// extensions.hmac in Postgres: proving the Edge side and the SQL side agree on the
// signed-string format byte for byte.
const KAV_SECRET = "p7-known-answer-secret";
const KAV_BODY = '{"p7":"known-answer"}';
const KAV_TIMESTAMP = "1754400000";
const KAV_HEX = "4e3f7e7c2061cba6aa5de9f70b941753e26dc9f33cabd8830a9244608aa94f75";

function claimedRow(overrides: Partial<ClaimedRow> = {}): ClaimedRow {
  return {
    outbox_id: "0b000000-0000-4000-8000-000000000001",
    target: "webhook:a7000000-0000-4000-8000-000000000001",
    attempt: 1,
    idempotency_key:
      "sf:e7000000-0000-4000-8000-000000000001:webhook:a7000000-0000-4000-8000-000000000001",
    url: "https://receiver.example.test/hooks/orders",
    body: KAV_BODY,
    timestamp: KAV_TIMESTAMP,
    signature: KAV_HEX,
    event: {
      id: "e7000000-0000-4000-8000-000000000001",
      sequence: 42,
      event_type: "invoice.approved",
      schema_version: 1,
      org_id: "17000000-0000-0000-0000-000000000001",
      unit_id: null,
      entity_type: "invoices",
      entity_id: "47000000-0000-0000-0000-000000000001",
      actor_id: null,
      correlation_id: "a7b00000-0000-4000-8000-00000000000a",
      causation_id: null,
      occurred_at: "2026-08-05T12:00:00+00:00",
      payload: { review_status: "approved" },
      metadata: { audit_action: "invoice_review_status_changed" },
    },
    ...overrides,
  };
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

test("signedPayload is body, a literal dot, then the timestamp", () => {
  assert.equal(signedPayload(KAV_BODY, KAV_TIMESTAMP), `${KAV_BODY}.${KAV_TIMESTAMP}`);
});

test("the known-answer vector matches the SQL-side pinned hex", async () => {
  const hex = await hmacSha256Hex(KAV_SECRET, signedPayload(KAV_BODY, KAV_TIMESTAMP));
  assert.equal(hex, KAV_HEX);
});

test("resolveTarget maps a fully resolved row to url, verbatim body and headers", () => {
  const resolved = resolveTarget(claimedRow());
  assert.ok(resolved);
  assert.equal(resolved.url, "https://receiver.example.test/hooks/orders");
  // Verbatim: the exact string the database signed, never a re-serialization.
  assert.equal(resolved.body, KAV_BODY);
  assert.deepEqual(resolved.headers, {
    "Content-Type": "application/json",
    "x-correlation-id": "a7b00000-0000-4000-8000-00000000000a",
    "x-idempotency-key":
      "sf:e7000000-0000-4000-8000-000000000001:webhook:a7000000-0000-4000-8000-000000000001",
    "x-supplyflow-signature": `sha256=${KAV_HEX}`,
    "x-supplyflow-timestamp": KAV_TIMESTAMP,
  });
});

test("an unresolved target answers null — the target_unregistered fail path", () => {
  assert.equal(resolveTarget(claimedRow({ url: null })), null);
  assert.equal(resolveTarget(claimedRow({ body: null })), null);
  assert.equal(resolveTarget(claimedRow({ signature: null })), null);
  assert.equal(resolveTarget(claimedRow({ timestamp: null })), null);
});

test("buildDeliveryHeaders carries the five mandatory headers and nothing else", () => {
  const headers = buildDeliveryHeaders({
    idempotency_key: "sf:key",
    event: claimedRow().event,
    signature: "abc123",
    timestamp: "1754400000",
  });
  assert.deepEqual(Object.keys(headers).sort(), [
    "Content-Type",
    "x-correlation-id",
    "x-idempotency-key",
    "x-supplyflow-signature",
    "x-supplyflow-timestamp",
  ]);
  assert.equal(headers["x-supplyflow-signature"], "sha256=abc123");
});

test("a receiver following the handoff recipe verifies the signature", async () => {
  const row = claimedRow();
  const resolved = resolveTarget(row);
  assert.ok(resolved);
  // The receiver's side: raw request body + '.' + x-supplyflow-timestamp, HMAC with the
  // shared secret, compare against x-supplyflow-signature after the sha256= prefix.
  const presented = resolved.headers["x-supplyflow-signature"].replace(/^sha256=/, "");
  const recomputed = await hmacSha256Hex(
    KAV_SECRET,
    signedPayload(resolved.body, resolved.headers["x-supplyflow-timestamp"]),
  );
  assert.equal(presented, recomputed);
});
