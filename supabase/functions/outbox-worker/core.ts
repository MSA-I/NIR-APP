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
// Signed-string contract (OPEN-DECISIONS #97, INTEGRATION-ARCHITECTURE.md):
//   signature = hex( HMAC-SHA256( body || '.' || timestamp, secret ) )
// sent as `x-supplyflow-signature: sha256=<hex>` + `x-supplyflow-timestamp: <timestamp>`.
// A receiver recomputes the HMAC over the raw request body, a literal '.', and the
// timestamp header value, then compares in constant time.
//
// A row whose target is unknown, inactive, or whose Vault secret does not resolve
// arrives WITHOUT url/signature/timestamp; resolveTarget() answers null and the worker
// records a failed attempt (`target_unregistered`) — the wave-5 accounting, preserved.

import { classifyWebhookUrl, guardedFetch } from '../webhook-verify/ssrf.ts';

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

/**
 * Webhooks are an outbound trust boundary, and this is the FIRST of two gates.
 *
 * The string half now delegates to `classifyWebhookUrl` (webhook-verify/ssrf.ts) so the
 * delivery path and the verification handshake reject the same URL for the same reason — the
 * previous inline check and the registration-time check could drift apart, and a validator that
 * disagrees with itself across two files is how an encoding gets through one of them. The
 * behaviour it replaces is preserved exactly, including that a literal address is refused in
 * every encoding, plus the encodings the inline version missed (`0x7f.1`, `2130706433`).
 *
 * The operator allowlist stays on top of it, unchanged: `OUTBOX_ALLOWED_HOSTS` is a deployment
 * decision about which hosts this worker may talk to at all, and it is deliberately NOT relaxed
 * here — see the report accompanying this change.
 *
 * The SECOND gate is connect time (`guardedFetch` below), which is the only one that closes DNS
 * rebinding: a host that passes here can still resolve to a private address a moment later.
 */
export function isAllowedWebhookUrl(value: string, allowedHosts: ReadonlySet<string>): boolean {
  const classified = classifyWebhookUrl(value);
  if (!classified.ok) return false;
  return allowedHosts.has(classified.value.host);
}

export interface DeliveryOutcome { ok: boolean; code?: number; error?: string }

/**
 * The default transport: resolve once, refuse the hostname if any answer is non-public, dial the
 * validated ADDRESS, and carry the registered name only as SNI. `fetch` cannot do this — it
 * resolves the name again inside the TLS stack, which is exactly the window a rebinding resolver
 * needs. Redirects are not followed by construction; the caller still classifies a 3xx below so
 * the recorded outcome is unchanged.
 */
const pinnedWebhookFetch: typeof fetch = (input, init) =>
  guardedFetch(typeof input === 'string' ? input : String(input), {
    method: (init?.method as string | undefined) ?? 'POST',
    headers: (init?.headers as Record<string, string> | undefined) ?? {},
    body: typeof init?.body === 'string' ? init.body : '',
  });

export async function deliverWebhook(
  resolved: ResolvedDelivery,
  allowedHosts: ReadonlySet<string>,
  fetcher: typeof fetch = pinnedWebhookFetch,
): Promise<DeliveryOutcome> {
  if (!isAllowedWebhookUrl(resolved.url, allowedHosts)) {
    return { ok: false, error: 'target_url_rejected' };
  }
  try {
    const response = await fetcher(resolved.url, {
      method: 'POST',
      headers: resolved.headers,
      body: resolved.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status >= 300 && response.status < 400) {
      return { ok: false, code: response.status, error: 'target_redirect_rejected' };
    }
    if (response.ok) return { ok: true, code: response.status };
    return { ok: false, code: response.status, error: `target_status_${response.status}` };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 500) : 'delivery_failed',
    };
  }
}

/** The exact string the database signed: body, a literal dot, the timestamp. */
export function signedPayload(body: string, timestamp: string): string {
  return `${body}.${timestamp}`;
}

/** The five mandatory outbound headers from the canonical integration contract. */
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
