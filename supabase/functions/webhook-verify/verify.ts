// webhook-verify/verify.ts — the handshake orchestration, pure and injectable.
//
// The contract, which is OURS and not a provider's (so there is no third-party specification to
// cite): before a customer's endpoint may receive this tenant's business events, it must prove
// it is theirs. The database mints a random challenge, keeps only its SHA-256 digest, and signs
// the verification envelope with the subscription's Vault secret in the EXACT format
// OPEN-DECISIONS #97 already pinned for deliveries — HMAC-SHA256 over `body || '.' || timestamp`,
// hex, sent as `x-supplyflow-signature: sha256=<hex>` and `x-supplyflow-timestamp: <ts>`. An
// integrator therefore verifies the handshake with the same recipe they already need for
// deliveries; nothing new was invented on the signing side.
//
// The endpoint answers 2xx and echoes the challenge back in the `x-inplace-webhook-challenge`
// response header. A header rather than a body, for one reason: this function never reads a
// response body, so a customer endpoint has no channel into our process beyond a status line and
// a bounded set of headers.
//
// Every outbound request goes through guardedRequest (ssrf.ts), which resolves once, refuses the
// hostname if ANY answer is non-public, and dials the validated address with the registered name
// carried only as SNI.

import { guardedRequest, type DialDeps } from './ssrf.ts';

export const CHALLENGE_HEADER = 'x-inplace-webhook-challenge';
export const VERIFICATION_TIMEOUT_MS = 10_000;

export interface BeginEnvelope {
  subscription_id: string;
  url: string;
  /** Posted verbatim — the database signed exactly these bytes. */
  body: string;
  timestamp: string;
  signature: string;
  correlation_id: string;
}

export interface RpcResult<T> {
  data: T | null;
  error: { message: string } | null;
}

export interface VerifyRpc {
  begin(verificationId: string): Promise<RpcResult<BeginEnvelope>>;
  complete(
    verificationId: string,
    echo: string | null,
    failureCode: string | null,
  ): Promise<RpcResult<{ verified: boolean; code?: string }>>;
}

export interface VerificationOutcome {
  verified: boolean;
  /** A named code, always. Never provider text, never a database message (#98, #99). */
  code: string;
}

/**
 * Database refusals the owner is entitled to understand, mapped to their own names. Anything
 * else collapses to one opaque code: a raw Postgres string on the way to a browser is the exact
 * leak #98 forbids, and it can name an internal object.
 */
const BEGIN_REFUSALS = [
  'webhook_verification_unknown',
  'webhook_verification_settled',
  'webhook_verification_expired',
  'webhook_verification_already_dispatched',
  'webhook_verification_endpoint_changed',
  'webhook_secret_unresolved',
] as const;

function beginRefusalCode(message: string): string {
  return BEGIN_REFUSALS.find((code) => message.includes(code)) ?? 'webhook_verification_unavailable';
}

/** Codes must survive the database's own `^[a-z0-9_]{1,100}$` shape check. */
function statusCode(status: number): string {
  return `webhook_verification_status_${status}`;
}

export async function runVerification(
  verificationId: string,
  rpc: VerifyRpc,
  deps: DialDeps,
): Promise<VerificationOutcome> {
  const begun = await rpc.begin(verificationId);
  if (begun.error || !begun.data) {
    // No settle here on purpose: begin refuses precisely when the attempt is not ours to
    // settle — unknown, already settled, expired, or already dispatched.
    return { verified: false, code: beginRefusalCode(begun.error?.message ?? '') };
  }
  const envelope = begun.data;

  const attempt = await guardedRequest(
    envelope.url,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': envelope.correlation_id,
        'x-inplace-webhook-event': 'webhook.verification',
        'x-supplyflow-signature': `sha256=${envelope.signature}`,
        'x-supplyflow-timestamp': envelope.timestamp,
      },
      body: envelope.body,
      timeoutMs: VERIFICATION_TIMEOUT_MS,
    },
    deps,
  );

  if (!attempt.ok) return settle(rpc, verificationId, null, attempt.code);
  if (attempt.status < 200 || attempt.status >= 300) {
    // Includes every 3xx: a redirect is refused at the hop, never followed.
    return settle(rpc, verificationId, null, statusCode(attempt.status));
  }

  const echo = attempt.headers[CHALLENGE_HEADER];
  if (!echo) return settle(rpc, verificationId, null, 'webhook_verification_challenge_absent');
  return settle(rpc, verificationId, echo, null);
}

async function settle(
  rpc: VerifyRpc,
  verificationId: string,
  echo: string | null,
  failureCode: string | null,
): Promise<VerificationOutcome> {
  const settled = await rpc.complete(verificationId, echo, failureCode);
  if (settled.error || !settled.data) {
    return { verified: false, code: 'webhook_verification_unavailable' };
  }
  return {
    verified: settled.data.verified === true,
    code: settled.data.verified === true
      ? 'webhook_verification_succeeded'
      : (settled.data.code ?? failureCode ?? 'webhook_verification_failed'),
  };
}
