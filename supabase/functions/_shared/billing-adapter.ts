/**
 * The billing provider boundary (0157, extended 0187/0188) — the contract, and the two
 * implementations that exist: `manual`, and a Paddle adapter that can verify a signature and
 * parse an envelope, and can do nothing else.
 *
 * The point of this file is that the domain never learns any provider's payload shape. Every
 * provider-specific concern lives behind `BillingAdapter`, and the database, which is where
 * attribution and idempotency actually happen, receives four flat strings plus an opaque payload
 * it stores and does not interpret.
 *
 * `manual` is a real implementation, not a stub: today an operator sets a customer's plan by hand
 * through platform_set_org_subscription, with step-up, a reason and an audit entry. Naming that
 * "manual" is more honest than a null provider meaning "we do not know". What manual cannot do —
 * hosted checkout, and verifying a signature it was never given a secret for — it refuses by name
 * rather than by pretending to succeed.
 *
 * WHAT THE PADDLE ADAPTER DELIBERATELY CANNOT DO. Per OPEN-DECISIONS #213 Paddle is
 * `SELECTED / ACCOUNT_NOT_PROVEN / KYC_NOT_PROVEN / ISRAEL_PAYOUT_NOT_PROVEN / NOT_INTEGRATED`.
 * Verifying a signature is arithmetic against a published contract and needs no account, so it is
 * implemented here. Creating a customer, opening a hosted checkout and cancelling a subscription
 * are live calls to an account that does not exist, so they refuse by name. This is not a
 * placeholder to be filled in casually: it is the line between code that is merged and billing
 * that is activated.
 *
 * WHY STRIPE AND MORNING RESOLVE TO NOTHING. #207 and #256 make Stripe direct and Morning /
 * חשבונית ירוקה a fallback that is explicitly NOT authorized. The interface exists so a second
 * adapter is possible; there is deliberately no configuration, environment variable or flag that
 * turns one on, because a second commercial truth source that can appear by accident is worse
 * than none. They refuse with `not_authorized`, which is a different fact from "unknown provider".
 */

/** What a verified, parsed provider event looks like by the time the domain sees it. */
export interface BillingEvent {
  provider: string;
  /** The provider's own event id. This is the replay key; the database uniques on it. */
  providerEventId: string;
  eventType: string;
  /**
   * The provider's customer identifier — the ONLY thing attribution is allowed to use. It is
   * matched against organization_subscriptions.provider_customer_id, which we wrote ourselves.
   * An org id read out of provider metadata would let an untrusted payload choose whose
   * subscription changes, which is exactly the attack 0157 is shaped against.
   *
   * Note what is NOT on this interface: there is no org field of any name. A caller cannot
   * accidentally take one from a payload, because a verified event has never carried one.
   */
  providerCustomerId: string | null;
  payload: Record<string, unknown>;
}

export type BillingOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; code: BillingRefusal; detail: string };

export type BillingRefusal =
  | "not_configured"
  /** The provider exists in this file but is a fallback nobody has authorized (#207, #256). */
  | "not_authorized"
  | "unsupported"
  | "signature_invalid"
  | "payload_invalid";

export interface CheckoutRequest {
  orgId: string;
  planKey: string;
  interval: "monthly" | "yearly";
}

export interface BillingAdapter {
  readonly provider: string;
  /** Creates (or returns) the provider-side customer this organization is filed under. */
  createCustomer(orgId: string, email: string): Promise<BillingOutcome<{ customerId: string }>>;
  /** A hosted payment page. `not_configured` while no provider account is proven. */
  createCheckoutSession(request: CheckoutRequest): Promise<BillingOutcome<{ url: string }>>;
  cancelSubscription(providerSubscriptionId: string): Promise<BillingOutcome<{ canceledAt: string }>>;
  /**
   * Verifies the raw body against the provider's signature header and parses it. Verification and
   * parsing are one call on purpose: a parsed-but-unverified event is a thing nobody should be
   * able to hold, and separating them is how one gets used by mistake.
   *
   * Asynchronous because a real HMAC is: Web Crypto's sign() returns a promise, and a synchronous
   * signature would have to be computed by something weaker.
   */
  verifyAndParse(rawBody: string, headers: Headers): Promise<BillingOutcome<BillingEvent>>;
}

const refuse = (code: BillingRefusal, detail: string): BillingOutcome<never> =>
  ({ ok: false, code, detail });

// ===========================================================================================
// Paddle
// ===========================================================================================

/**
 * PADDLE WEBHOOK SIGNATURE VERIFICATION — implemented from the official published contract.
 *
 * Sources, read 23.08.2026:
 *   https://developer.paddle.com/webhooks/about/signature-verification/
 *   https://developer.paddle.com/webhooks/respond-to-webhooks
 *   https://developer.paddle.com/webhooks/subscriptions/subscription-activated
 *   https://developer.paddle.com/llms/webhooks.txt
 *
 * The mechanics that document states, and that this file implements:
 *   * Header `Paddle-Signature`, whose value is semicolon-separated `key=value` pairs, e.g.
 *     `ts=1671552777;h1=eb4d0dc8853be92b7f063b9f3ba5233eb920a09459b6e6b2c26705b4364db151`.
 *   * `ts` is a Unix timestamp; `h1` is the event signature in hex. "Signatures contain at least
 *     one h1... During secret rotation, more than one h1 is returned" — so every h1 is tried.
 *   * The signed payload is the timestamp, a colon, and the RAW request body:  ts + ":" + body.
 *     "Don't transform or process the raw body of the request, including adding whitespace or
 *     applying other formatting." This adapter is therefore handed the raw text and never a
 *     re-serialized object; re-serializing would let a body we never saw verify.
 *   * HMAC-SHA256, keyed with the notification destination's endpoint secret (`pdl_ntfset_…`).
 *   * The comparison must be timing-safe.
 *   * Replay: "check the timestamp (ts) against the current time and reject events that are too
 *     old"; the published SDK default tolerance is five seconds, which is the value used here.
 *     The window is applied SYMMETRICALLY — a timestamp far in the future is a signature with no
 *     expiry, which is the same replay problem pointed the other way.
 *
 * Envelope, from the same documentation: `event_id` (prefixed `evt_`), `event_type`,
 * `occurred_at`, `notification_id` (prefixed `ntf_`), and `data`. The customer identifier is
 * `data.customer_id` (prefixed `ctm_`) for subscription, transaction and adjustment events.
 *
 * NOT DONE HERE, and it matters: nothing in this file has ever contacted Paddle. No account,
 * no sandbox credential, no registered endpoint, no live call. This is an implementation of a
 * published document, and it is not evidence that the provider works.
 */
export const PADDLE_SIGNATURE_HEADER = "Paddle-Signature";

/** Paddle's own published SDK default. Widening it is a decision, not a convenience. */
export const PADDLE_REPLAY_TOLERANCE_SECONDS = 5;

interface PaddleSignature {
  /** The timestamp token exactly as delivered — it is part of the signed bytes verbatim. */
  timestampToken: string;
  timestampSeconds: number;
  hashes: string[];
}

/**
 * Splits the header into its `ts` and one-or-more `h1` parts. Returns null for anything that is
 * not a usable signature at all, which the caller reports as `signature_invalid` — the same
 * answer as a wrong signature, so the endpoint never explains which of the two it was.
 */
function parsePaddleSignatureHeader(value: string | null): PaddleSignature | null {
  if (!value) return null;
  let timestampToken: string | null = null;
  const hashes: string[] = [];
  for (const part of value.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const item = part.slice(separator + 1).trim();
    if (item.length === 0) continue;
    if (key === "ts" && timestampToken === null) timestampToken = item;
    // Hex only: a non-hex h1 cannot be a signature, and refusing it here keeps the compare loop
    // working on one alphabet.
    else if (key === "h1" && /^[0-9a-fA-F]+$/.test(item)) hashes.push(item.toLowerCase());
  }
  if (timestampToken === null || hashes.length === 0) return null;
  if (!/^[0-9]{1,15}$/.test(timestampToken)) return null;
  return { timestampToken, timestampSeconds: Number(timestampToken), hashes };
}

/**
 * Compares two hex strings without letting the time taken depend on where they first differ.
 * The length difference is folded into the accumulator rather than returned early, because an
 * early length exit is the usual way a "constant-time" compare stops being one.
 */
export function constantTimeEqualHex(a: string, b: string): boolean {
  let difference = a.length ^ b.length;
  const span = Math.max(a.length, b.length);
  for (let index = 0; index < span; index += 1) {
    // charCodeAt past the end is NaN; `| 0` makes it 0 without branching. A genuine trailing
    // zero byte cannot smuggle a match through, because the length XOR above is already set.
    difference |= (a.charCodeAt(index) | 0) ^ (b.charCodeAt(index) | 0);
  }
  return difference === 0;
}

const encoder = new TextEncoder();

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(mac)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A non-empty string, or null. Never a coerced number, array or object. */
function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * The Paddle adapter. `secret` is the notification destination's endpoint secret; an empty one
 * means the function is not configured and every payload is refused rather than waved through.
 */
export function createPaddleAdapter(secret: string): BillingAdapter {
  const configured = typeof secret === "string" && secret.trim().length > 0;

  const unproven = (action: string): BillingOutcome<never> => refuse(
    "not_configured",
    `${action} is a live Paddle call; the account, KYC and Israel payout are unproven (#213) and `
    + "this build must not attempt one",
  );

  return {
    provider: "paddle",

    createCustomer: () => Promise.resolve(unproven("creating a provider customer")),
    createCheckoutSession: () => Promise.resolve(unproven("opening a hosted checkout")),
    cancelSubscription: () => Promise.resolve(unproven("cancelling at the provider")),

    verifyAndParse: async (rawBody, headers) => {
      if (!configured) {
        return refuse("not_configured", "no Paddle endpoint secret is configured");
      }

      const signature = parsePaddleSignatureHeader(headers.get(PADDLE_SIGNATURE_HEADER));
      if (signature === null) {
        return refuse("signature_invalid", "the Paddle-Signature header is absent or unusable");
      }

      // Replay window first: an old-but-authentically-signed event is still a replay, and there
      // is no reason to spend an HMAC on one.
      const skew = Math.abs(Math.floor(Date.now() / 1000) - signature.timestampSeconds);
      if (skew > PADDLE_REPLAY_TOLERANCE_SECONDS) {
        return refuse(
          "signature_invalid",
          `the signature timestamp is ${skew}s from now, outside the `
          + `${PADDLE_REPLAY_TOLERANCE_SECONDS}s tolerance`,
        );
      }

      // The signed bytes: the timestamp token as delivered, a colon, and the body untouched.
      const expected = await hmacSha256Hex(secret, `${signature.timestampToken}:${rawBody}`);

      // Every candidate is compared; the loop does not stop at the first match, so the number of
      // comparisons does not depend on which h1 was the right one during a secret rotation.
      let matched = 0;
      for (const candidate of signature.hashes) {
        matched |= constantTimeEqualHex(candidate, expected) ? 1 : 0;
      }
      if (matched !== 1) {
        return refuse("signature_invalid", "the Paddle signature did not verify");
      }

      // Only now is the body allowed to become a document. Nothing above this line trusted it.
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return refuse("payload_invalid", "a verified body was not JSON");
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return refuse("payload_invalid", "a verified body was not a JSON object");
      }

      const envelope = parsed as Record<string, unknown>;
      const providerEventId = stringOrNull(envelope.event_id);
      const eventType = stringOrNull(envelope.event_type);
      if (providerEventId === null || eventType === null) {
        return refuse("payload_invalid", "the envelope carries no event_id or no event_type");
      }

      const data = (typeof envelope.data === "object" && envelope.data !== null
        && !Array.isArray(envelope.data))
        ? envelope.data as Record<string, unknown>
        : {};

      return {
        ok: true,
        value: {
          provider: "paddle",
          providerEventId,
          eventType,
          // data.customer_id and nothing else. custom_data, passthrough and metadata are
          // attacker-reachable — whoever opens a checkout can put anything in them — so they are
          // carried in `payload` for the record and are never read for attribution.
          providerCustomerId: stringOrNull(data.customer_id),
          payload: envelope,
        },
      };
    },
  };
}

// ===========================================================================================
// manual
// ===========================================================================================

export const manualBillingAdapter: BillingAdapter = {
  provider: "manual",

  // A manual customer is the organization itself: there is no external system filing them under
  // another id, and inventing one would create a link that resolves to nothing.
  createCustomer: (orgId) => Promise.resolve({ ok: true, value: { customerId: `manual:${orgId}` } }),

  createCheckoutSession: () => Promise.resolve(refuse(
    "not_configured",
    "no billing provider is configured; a plan change is an operator command with step-up and a reason",
  )),

  cancelSubscription: () => Promise.resolve(refuse(
    "not_configured",
    "no billing provider is configured; cancellation is an operator command",
  )),

  // Refusing every payload is the correct behaviour, not a placeholder. There is no secret to
  // verify against, and an adapter that accepted unsigned events would be a hole in the boundary
  // this whole layer exists to be.
  verifyAndParse: () => Promise.resolve(refuse(
    "not_configured",
    "the manual provider receives no webhooks and cannot verify a signature",
  )),
};

// ===========================================================================================
// Resolution
// ===========================================================================================

/** The fallback providers named in #207/#256. Listed so they refuse BY NAME, never by omission. */
const UNAUTHORIZED_FALLBACKS: Record<string, string> = {
  stripe:
    "Stripe direct is the documented fallback merchant of record (#207) and is explicitly not "
    + "authorized; activating it requires an owner decision, a tax contract and Morning (#256)",
  morning:
    "Morning / חשבונית ירוקה is the documented fallback tax-document service (#256) and is "
    + "explicitly not authorized; it enters only if the Stripe fallback is separately activated",
};

/**
 * Resolves the adapter for a provider name.
 *
 * Three different refusals, on purpose. `unsupported` means nobody has written this adapter.
 * `not_configured` means the adapter exists but has no secret, so it can verify nothing.
 * `not_authorized` means the adapter is a real fallback that the owner has decided must not run —
 * and no argument to this function, and no environment variable, can change that answer. Silently
 * treating any of the three as "manual" would look identical to a correctly refused event, and
 * the difference matters when debugging why a customer's payment did nothing.
 */
export function billingAdapterFor(
  provider: string,
  env: (name: string) => string | undefined,
): BillingOutcome<BillingAdapter> {
  if (provider === manualBillingAdapter.provider) return { ok: true, value: manualBillingAdapter };

  const unauthorized = UNAUTHORIZED_FALLBACKS[provider];
  // Read before anything else about this provider is considered, and it takes no arguments: the
  // refusal cannot be conditioned on configuration, because configuration is exactly how an
  // unproven second merchant of record would quietly become the live one.
  if (unauthorized !== undefined) return refuse("not_authorized", unauthorized);

  if (provider === "paddle") {
    const secret = env("PADDLE_WEBHOOK_SECRET");
    if (!secret || secret.trim().length === 0) {
      return refuse("not_configured", "PADDLE_WEBHOOK_SECRET is not set for this deployment");
    }
    return { ok: true, value: createPaddleAdapter(secret) };
  }

  return refuse("unsupported", `no adapter is registered for provider '${provider}'`);
}
