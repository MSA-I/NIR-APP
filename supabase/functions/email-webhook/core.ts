// email-webhook/core.ts -- the pure, testable half of the signed Resend delivery webhook
// (the interpret-document / outbox-worker core.ts precedent: deterministic, imports nothing,
// no Deno.env and no network at import time, so core.test.ts runs with zero permissions).
//
// WHAT THIS IS FOR. 0168 stamps an order `sent` when Resend ACCEPTED the message (#187). What
// the provider does afterwards -- delivered, bounced, delayed, complained -- is knowledge that
// only arrives asynchronously, and only over a signed webhook. This module verifies that
// signature and reduces the provider's payload to five bounded fields. It decides NOTHING about
// state: the monotonic transition rule lives in migration 0190, in SQL, so a late or duplicated
// event cannot regress a further-along state no matter what any Edge deployment believes.
//
// ============================ THE PROVIDER CONTRACT, READ 2026-08-23 ========================
// Resend signs webhooks with Svix.
//
//   https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests   (read 2026-08-23)
//     Three headers carry the proof: `svix-id`, `svix-timestamp`, `svix-signature`. The page is
//     explicit that verification must use the RAW request body -- "The cryptographic signature is
//     sensitive to even the slightest change."
//
//   https://docs.svix.com/receiving/verifying-payloads/how-manual         (read 2026-08-23)
//     signed content = `${svix-id}.${svix-timestamp}.${raw body}` -- periods as separators.
//     The signing secret is `whsec_` + base64; strip the prefix and base64-DECODE the remainder
//     to get the raw HMAC key bytes. Algorithm: HMAC-SHA256; the signature is base64-encoded.
//     `svix-signature` carries SPACE-SEPARATED versioned entries, `v1,<sig> v1,<sig>` -- more than
//     one during key rotation -- and a verifier accepts if ANY entry matches. Compare in constant
//     time. Enterprise tiers may send the same three headers under `webhook-` names instead.
//
//   https://docs.svix.com/receiving/verifying-payloads/why                (read 2026-08-23)
//     Timestamps "more than five minutes away (past or future) from the current time" are
//     rejected; that is the replay window, and `svix-id` is the per-delivery identifier a
//     receiver stores to drop duplicates.
//
//   https://resend.com/docs/webhooks/introduction                         (read 2026-08-23)
//     Payload shape: top-level `type` and `created_at`; `data.email_id` is Resend's own message
//     identifier -- the same value `POST /emails` returned as `id`, which 0168 stored in
//     email_order_messages.provider_message_id -- while `data.message_id` is the RFC-5322
//     Message-ID header. A bounce carries `data.bounce.{type, subType, message}`; the published
//     example shows `type: "Permanent"`, `subType: "Suppressed"`.
//
//   https://resend.com/docs/dashboard/webhooks/event-types                (read 2026-08-23)
//     The full vocabulary: email.sent, email.delivered, email.delivery_delayed, email.complained,
//     email.bounced, email.opened, email.clicked, email.failed, email.received, email.scheduled,
//     email.suppressed, plus domain.*, contact.* and suppression.*. Only the four delivery-outcome
//     events are meaningful here; every other type is ignored BY NAME rather than defaulted.
// ===========================================================================================
//
// No Svix SDK and no npm dependency: the scheme above is eight lines of Web Crypto, and an Edge
// Function that verifies its own trust boundary should not import one to do it.

/** Svix rejects anything more than five minutes from now, in either direction. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** The cap 0168 already applies to a provider error message (0168:456). Reused rather than
 *  invented, so one bound governs every provider sentence this system stores. */
export const REASON_MESSAGE_MAX = 500;

const SECRET_PREFIX = 'whsec_';
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export interface WebhookHeaders {
  id: string;
  timestamp: string;
  signature: string;
}

export type VerificationFailure =
  | 'missing_headers'
  | 'misconfigured_secret'
  | 'timestamp_out_of_tolerance'
  | 'signature_mismatch';

export type VerificationResult =
  | { ok: true; eventId: string }
  | { ok: false; reason: VerificationFailure };

/** The four provider events that say something about DELIVERY. Everything else is ignored. */
export type DeliveryEventType = 'delivered' | 'bounced' | 'delivery_delayed' | 'complained';

/** The whole storable surface of an event: five bounded fields. The raw provider payload is
 *  never persisted anywhere a browser can reach, and is never persisted at all. */
export interface ParsedDeliveryEvent {
  eventType: DeliveryEventType;
  providerMessageId: string;
  occurredAt: string | null;
  reasonCode: string;
  reasonMessage: string | null;
}

export interface RecordOutcome {
  state?: string;
  status?: string;
  delivery_state?: string;
}

const EVENT_TYPES: Readonly<Record<string, DeliveryEventType>> = {
  'email.delivered': 'delivered',
  'email.bounced': 'bounced',
  'email.delivery_delayed': 'delivery_delayed',
  'email.complained': 'complained',
};

/** Bounce classifications, normalized to the closed vocabulary migration 0190 CHECKs. Resend's
 *  published example shows `Permanent`; `Transient` and `Undetermined` are the rest of the
 *  SES-derived triple. Anything the provider adds later lands on `bounce_unclassified` -- an
 *  unrecognized classification must never silently borrow a stronger or weaker meaning. */
const BOUNCE_CODES: Readonly<Record<string, string>> = {
  permanent: 'bounce_permanent',
  transient: 'bounce_transient',
  undetermined: 'bounce_undetermined',
};

const REASON_CODES: Readonly<Record<DeliveryEventType, string>> = {
  delivered: 'delivered',
  bounced: 'bounce_unclassified',
  delivery_delayed: 'delivery_delayed',
  complained: 'complaint',
};

/** Every state migration 0190 can answer. Each one means "the database has decided and nothing
 *  is pending", so each one answers 2xx -- see mapRecordOutcome. */
const HANDLED_STATES: ReadonlySet<string> = new Set([
  'applied', 'duplicate', 'unmatched', 'stale', 'not_settled',
]);

function header(headers: Headers, name: string): string {
  return (headers.get(`svix-${name}`) ?? headers.get(`webhook-${name}`) ?? '').trim();
}

/** Reads the identifying triple. `svix-*` is the Resend/Svix default; `webhook-*` is the same
 *  triple under the Svix enterprise naming. Absent id, timestamp or signature is not a request
 *  worth parsing further. */
export function readWebhookHeaders(headers: Headers): WebhookHeaders | null {
  const id = header(headers, 'id');
  const timestamp = header(headers, 'timestamp');
  const signature = header(headers, 'signature');
  if (!id || !timestamp || !signature) return null;
  return { id, timestamp, signature };
}

/** `whsec_` + base64 -> raw key bytes. A secret that is not base64 is a deployment fault, and a
 *  deployment fault must refuse rather than fall through to "no signature matched". */
export function decodeSigningSecret(secret: string | undefined | null): Uint8Array | null {
  const raw = (secret ?? '').trim();
  if (!raw) return null;
  const encoded = raw.startsWith(SECRET_PREFIX) ? raw.slice(SECRET_PREFIX.length) : raw;
  if (!encoded || !BASE64.test(encoded)) return null;
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes.length ? bytes : null;
  } catch {
    return null;
  }
}

/** The exact string Svix signed: id, a literal dot, timestamp, a literal dot, the RAW body. */
export function signedContent(id: string, timestamp: string, rawBody: string): string {
  return `${id}.${timestamp}.${rawBody}`;
}

/** `v1,<b64> v1,<b64>` -> the base64 signatures of the versions we can actually check. An entry
 *  under an unknown scheme version is dropped: we cannot verify it, so it cannot grant entry. */
export function parseSignatureHeader(header: string): string[] {
  return header.split(/\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('v1,'))
    .map((entry) => entry.slice('v1,'.length))
    .filter(Boolean);
}

function base64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  for (let index = 0; index < view.length; index++) binary += String.fromCharCode(view[index]);
  return btoa(binary);
}

/** The outbox-worker/index.ts:62 idiom: digest both sides and XOR-accumulate over a FIXED length,
 *  so neither the comparison time nor an early return leaks how much of a forgery was correct. */
async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let mismatch = 0;
  for (let index = 0; index < a.length; index++) mismatch |= a[index] ^ b[index];
  return mismatch === 0;
}

export async function verifyWebhookSignature(args: {
  /** The body as TEXT, read before any JSON.parse: the signature covers those exact bytes. */
  rawBody: string;
  headers: WebhookHeaders;
  secret: string | undefined | null;
  nowSeconds: number;
}): Promise<VerificationResult> {
  const { rawBody, headers, secret, nowSeconds } = args;
  const presented = (headers.signature ?? '').trim();
  if (!headers.id?.trim() || !headers.timestamp?.trim() || !presented) {
    return { ok: false, reason: 'missing_headers' };
  }

  const key = decodeSigningSecret(secret);
  if (!key) return { ok: false, reason: 'misconfigured_secret' };

  const sentAt = Number.parseInt(headers.timestamp, 10);
  if (!Number.isFinite(sentAt) || Math.abs(nowSeconds - sentAt) > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' };
  }

  const candidates = parseSignatureHeader(presented);
  if (!candidates.length) return { ok: false, reason: 'signature_mismatch' };

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expected = base64(await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    new TextEncoder().encode(signedContent(headers.id, headers.timestamp, rawBody)),
  ));

  // Key rotation means several signatures may ride along; ANY match is acceptance. Every
  // candidate is compared -- no early exit -- so the loop's cost does not depend on which one hit.
  let matched = false;
  for (const candidate of candidates) {
    if (await constantTimeEqual(candidate, expected)) matched = true;
  }
  return matched ? { ok: true, eventId: headers.id } : { ok: false, reason: 'signature_mismatch' };
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Reduces a verified provider payload to the five bounded fields 0190 stores, or null when the
 *  event says nothing about delivery. Returning null is the ONLY treatment of an unrecognized
 *  event: it is never optimistically read as delivered, and never invents a message to attach to. */
export function parseDeliveryEvent(payload: unknown): ParsedDeliveryEvent | null {
  const root = asObject(payload);
  if (!root) return null;
  const type = readString(root, 'type');
  const eventType = type ? EVENT_TYPES[type] : undefined;
  if (!eventType) return null;

  const data = asObject(root.data);
  if (!data) return null;
  const providerMessageId = readString(data, 'email_id');
  if (!providerMessageId) return null;

  const createdAt = readString(root, 'created_at') ?? readString(data, 'created_at');
  const parsedAt = createdAt ? new Date(createdAt) : null;
  const occurredAt = parsedAt && !Number.isNaN(parsedAt.getTime())
    ? parsedAt.toISOString()
    : null;

  const bounce = eventType === 'bounced' ? asObject(data.bounce) : null;
  const bounceType = bounce ? readString(bounce, 'type') : null;
  const reasonCode = eventType === 'bounced'
    ? (bounceType ? BOUNCE_CODES[bounceType.toLowerCase()] : undefined) ?? REASON_CODES.bounced
    : REASON_CODES[eventType];

  const message = bounce ? readString(bounce, 'message') : null;
  const reasonMessage = message ? message.slice(0, REASON_MESSAGE_MAX) : null;

  return { eventType, providerMessageId, occurredAt, reasonCode, reasonMessage };
}

/** Maps the database's answer to an HTTP response.
 *
 *  Every state in HANDLED_STATES answers 200, including duplicate, unmatched and stale. That is
 *  deliberate: a webhook receiver that answers non-2xx is retried by the provider for hours, and
 *  a replayed, unknown or out-of-order event is not a failure -- the database looked at it and
 *  decided. Only an answer the database did not give (a broken deployment) is a 500 worth
 *  retrying. Nothing here reports an ORDER: a bounce settles the email channel, never the order
 *  lifecycle (#238). */
export function mapRecordOutcome(
  outcome: RecordOutcome | null,
): { status: number; body: Record<string, unknown> } {
  const state = outcome?.state;
  if (!state || !HANDLED_STATES.has(state)) {
    return { status: 500, body: { ok: false, error: 'settlement_failed' } };
  }
  const body: Record<string, unknown> = { ok: true, state };
  if (outcome?.status) body.status = outcome.status;
  if (outcome?.delivery_state) body.delivery_state = outcome.delivery_state;
  return { status: 200, body };
}
