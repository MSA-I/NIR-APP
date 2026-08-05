// outbox-worker/core.ts — the pure, testable delivery logic (the interpret-document
// core.ts precedent: everything here is deterministic, imports nothing, and is exercised
// by core.test.ts in the quality gate's dedicated deno step).
//
// Wave-7 contract (0066_integration_adapters.sql): the DATABASE signs. Each claimed row
// may carry `url`, `body`, `timestamp` and `signature`, resolved and computed inside
// claim_integration_outbox from the webhook_subscriptions registry and the
// subscription's Vault secret. The worker never sees the secret and never re-serializes
// the event: it posts `body` VERBATIM — the signature covers exactly those bytes.
//
// Signed-string contract (OPEN-DECISIONS #97, handoff/07-adapters-contract.md):
//   signature = hex( HMAC-SHA256( body || '.' || timestamp, secret ) )
// sent as `x-supplyflow-signature: sha256=<hex>` + `x-supplyflow-timestamp: <timestamp>`.
// A receiver recomputes the HMAC over the raw request body, a literal '.', and the
// timestamp header value, then compares in constant time.
//
// A row whose target is unknown, inactive, or whose Vault secret does not resolve
// arrives WITHOUT url/signature/timestamp; resolveTarget() answers null and the worker
// records a failed attempt (`target_unregistered`) — the wave-5 accounting, preserved.

export interface ClaimedRow {
  outbox_id: string;
  target: string;
  attempt: number;
  idempotency_key: string;
  url: string | null;
  body: string | null;
  timestamp: string | null;
  signature: string | null;
  event: {
    id: string;
    sequence: number;
    event_type: string;
    schema_version: number;
    org_id: string;
    unit_id: string | null;
    entity_type: string;
    entity_id: string | null;
    actor_id: string | null;
    correlation_id: string;
    causation_id: string | null;
    occurred_at: string;
    payload: Record<string, unknown>;
    metadata: Record<string, unknown>;
  };
}

export interface ResolvedDelivery {
  url: string;
  /** Posted verbatim — the signature covers exactly these bytes. */
  body: string;
  headers: Record<string, string>;
}

/** The exact string the database signed: body, a literal dot, the timestamp. */
export function signedPayload(body: string, timestamp: string): string {
  return `${body}.${timestamp}`;
}

/** The five mandatory outbound headers (handoff/05 §6.3 + the wave-7 signature pair). */
export function buildDeliveryHeaders(
  row: Pick<ClaimedRow, 'idempotency_key' | 'event'> & { signature: string; timestamp: string },
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-correlation-id': row.event.correlation_id,
    'x-idempotency-key': row.idempotency_key,
    'x-supplyflow-signature': `sha256=${row.signature}`,
    'x-supplyflow-timestamp': row.timestamp,
  };
}

/** Maps a claimed row to a concrete delivery, or null when the target is unresolvable —
 * the caller then records the `target_unregistered` failed attempt (wave-5 behavior). */
export function resolveTarget(row: ClaimedRow): ResolvedDelivery | null {
  if (!row.url || !row.body || !row.signature || !row.timestamp) return null;
  return {
    url: row.url,
    body: row.body,
    headers: buildDeliveryHeaders({
      idempotency_key: row.idempotency_key,
      event: row.event,
      signature: row.signature,
      timestamp: row.timestamp,
    }),
  };
}
