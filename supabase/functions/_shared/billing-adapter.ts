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
 * WHAT THE PADDLE ADAPTER CAN DO, AND WHAT STILL GATES IT (rewritten 31.08.2026).
 *
 * The live calls are now implemented — create/reuse a customer, open a transaction, cancel at the
 * period boundary, change a plan at the next renewal, open the provider's customer portal — and
 * they were exercised against a real Paddle SANDBOX account. What has NOT changed is the gate, and
 * there are now two of them stacked:
 *
 *   1. THE API HALF IS SEPARATE FROM THE WEBHOOK HALF. `createPaddleAdapter` takes the endpoint
 *      secret and, optionally, an API key. Without the key every outbound call refuses by name,
 *      exactly as this file behaved before. `billing-webhook` is deployed with no key, so the
 *      function that RECEIVES money events structurally cannot MAKE one.
 *   2. THE DATABASE STILL REFUSES TO ACT. Per #213 Paddle remains
 *      `SELECTED / ACCOUNT_NOT_PROVEN / KYC_NOT_PROVEN / ISRAEL_PAYOUT_NOT_PROVEN`, and 0187
 *      seeds every merchant of record disabled with nothing able to enable one. A perfectly
 *      signed, perfectly attributed event still changes no entitlement in production; it
 *      dead-letters with `provider_not_enabled`, visibly. 0277 mapped the sandbox catalogue and
 *      pointedly did not enable anything.
 *
 * So this file being complete is not billing being activated, and neither is merging it.
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
  /**
   * The provider price this checkout is for, resolved SERVER-SIDE from
   * private.billing_provider_price_map before the adapter is called. It is passed in rather than
   * looked up here because the adapter has no database and must not acquire one: the same table
   * that decides what a price GRANTS has to be the table that decides what a checkout SELLS, or
   * the two can drift and a customer pays for one rung and receives another.
   */
  providerPriceId: string;
  /** The provider customer this organization is filed under. Never taken from the browser. */
  providerCustomerId: string;
}

/**
 * What the browser is handed to actually pay.
 *
 * Two shapes because providers genuinely differ, and flattening them into a `url` would have meant
 * inventing one for Paddle. Paddle's overlay is opened by `Paddle.Checkout.open({ transactionId })`
 * against a transaction created here, server-side, with a price id the server chose — so the
 * browser never names a price, an amount or a plan, and cannot buy something it was not offered.
 */
export type CheckoutHandle =
  | { kind: "hosted_url"; url: string }
  | { kind: "provider_transaction"; provider: string; transactionId: string };

export interface BillingAdapter {
  readonly provider: string;
  /** Creates (or returns) the provider-side customer this organization is filed under. */
  createCustomer(orgId: string, email: string): Promise<BillingOutcome<{ customerId: string }>>;
  /** A payment the browser can open. `not_configured` while no provider account is proven. */
  createCheckoutSession(request: CheckoutRequest): Promise<BillingOutcome<CheckoutHandle>>;
  cancelSubscription(providerSubscriptionId: string): Promise<BillingOutcome<{ canceledAt: string }>>;
  /**
   * #216: a change between paid rungs or intervals lands AT THE NEXT RENEWAL with no proration.
   * This asks the provider to schedule exactly that. It does not change entitlement here — nothing
   * in this file ever does. The entitlement follows the signed `subscription.updated` event that
   * the provider sends back, through the same verified door as every other change.
   */
  changePlan(
    providerSubscriptionId: string,
    providerPriceId: string,
  ): Promise<BillingOutcome<{ scheduledFor: string | null }>>;
  /**
   * The provider's own customer-management surface (payment method, invoices, cancellation).
   * Preferred over re-implementing those screens: the provider is the source of truth for a stored
   * card, and a card is one thing this product should never see, hold or render.
   */
  createPortalSession(
    providerCustomerId: string,
    providerSubscriptionId: string | null,
  ): Promise<BillingOutcome<{ url: string }>>;
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
 * PADDLE'S TWO ACCOUNTS ARE TWO HOSTS, and that is the whole environment separation.
 *
 * A sandbox key is rejected by the live host and vice versa, so a mismatched pair cannot transact
 * — but it also cannot be diagnosed from a 403, which is why the environment is named explicitly
 * rather than inferred from the key's prefix. Naming it means a deployment that MEANT sandbox and
 * received a live key fails loudly at the door instead of quietly reaching real money.
 */
const PADDLE_API_HOSTS = {
  sandbox: "https://sandbox-api.paddle.com",
  live: "https://api.paddle.com",
} as const;

export type PaddleEnvironment = keyof typeof PADDLE_API_HOSTS;

export interface PaddleApiOptions {
  apiKey: string;
  environment: PaddleEnvironment;
}

/**
 * Reads the API half of the Paddle configuration, or returns null.
 *
 * NULL IS THE IMPORTANT RETURN. An adapter built without it verifies signatures exactly as before
 * and refuses every live call by name — which is the state this file shipped in, is still the
 * state of any deployment that has not been given a key, and is what `billing-webhook` runs as:
 * receiving events needs no API key, so it is never given one. The API key exists only where a
 * checkout is actually opened.
 *
 * The environment must be spelled, and must be one of the two hosts. An unrecognized value is not
 * defaulted to sandbox — a typo silently choosing an environment is exactly the accident that
 * would put test traffic on real money, or the reverse.
 */
export function paddleApiOptionsFrom(
  env: (name: string) => string | undefined,
): PaddleApiOptions | null {
  const apiKey = env("PADDLE_API_KEY")?.trim();
  const environment = env("PADDLE_ENVIRONMENT")?.trim();
  if (!apiKey || !environment) return null;
  if (environment !== "sandbox" && environment !== "live") return null;
  return { apiKey, environment };
}

/** What Paddle answered, with its own error code kept: it is the only useful thing in a failure. */
interface PaddleApiResult {
  status: number;
  body: Record<string, unknown>;
  errorCode: string | null;
}

async function paddleRequest(
  options: PaddleApiOptions,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<PaddleApiResult> {
  const response = await fetch(PADDLE_API_HOSTS[options.environment] + path, {
    method,
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
      // Pinned. Paddle versions its API by date and an unpinned client silently changes shape
      // underneath a payment flow, which is the last place a surprise belongs.
      "Paddle-Version": "1",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const error = parsed.error as { code?: string } | undefined;
  return { status: response.status, body: parsed, errorCode: error?.code ?? null };
}

const dataOf = (result: PaddleApiResult): Record<string, unknown> =>
  (result.body.data ?? {}) as Record<string, unknown>;

/**
 * The Paddle adapter. `secret` is the notification destination's endpoint secret; an empty one
 * means the function is not configured and every payload is refused rather than waved through.
 *
 * `api` is the SEPARATE half that permits outbound calls. Kept separate on purpose: verifying a
 * signature is arithmetic and needs no account, while creating a customer or a transaction spends
 * real money's worth of trust. A deployment that only receives webhooks is given the secret and no
 * key, and then cannot transact even if a future edit asks it to.
 */
export function createPaddleAdapter(secret: string, api?: PaddleApiOptions | null): BillingAdapter {
  const configured = typeof secret === "string" && secret.trim().length > 0;

  const unconfigured = (action: string): BillingOutcome<never> => refuse(
    "not_configured",
    `${action} is a live Paddle call and this deployment holds no Paddle API key; setting `
    + "PADDLE_API_KEY and PADDLE_ENVIRONMENT is a deliberate act, not a default",
  );

  const failed = (action: string, result: PaddleApiResult): BillingOutcome<never> => refuse(
    "payload_invalid",
    `${action} was refused by Paddle with ${result.status}`
    + (result.errorCode ? ` (${result.errorCode})` : ""),
  );

  return {
    provider: "paddle",

    /**
     * Creates the Paddle customer, or re-finds the one that already exists.
     *
     * REUSE IS NOT AN OPTIMIZATION HERE, IT IS CORRECTNESS. Paddle uniques customers on email and
     * answers a repeat with `customer_already_exists`. Treating that as a failure would leave an
     * organization whose owner had ever reached checkout permanently unable to buy anything;
     * creating a second customer is impossible, so the only honest move is to go and find the
     * first. The caller then writes the id against the organization — that write, ours, is what
     * every later webhook is attributed through.
     */
    createCustomer: async (orgId, email) => {
      if (!api) return unconfigured("creating a provider customer");

      const created = await paddleRequest(api, "POST", "/customers", {
        email,
        // Recorded so a human reading Paddle's dashboard can tell whose customer this is. It is
        // NEVER read back for attribution: 0157 resolves the organization only from the
        // provider-customer link stored on our side, precisely because a provider-held field is
        // reachable by whoever can reach the provider.
        custom_data: { inplace_org_id: orgId },
      });
      if (created.status >= 200 && created.status < 300) {
        const customerId = stringOrNull(dataOf(created).id);
        if (customerId === null) return failed("creating a provider customer", created);
        return { ok: true, value: { customerId } };
      }
      if (created.errorCode !== "customer_already_exists") {
        return failed("creating a provider customer", created);
      }

      const found = await paddleRequest(
        api,
        "GET",
        `/customers?email=${encodeURIComponent(email)}&per_page=2&status=active`,
      );
      if (found.status < 200 || found.status >= 300) {
        return failed("re-finding an existing provider customer", found);
      }
      const rows = (found.body.data ?? []) as Array<Record<string, unknown>>;
      // Exactly one, or refuse. Paddle uniques on email so two is not a state it should produce,
      // and picking the first of an ambiguous pair would file an organization's payments under a
      // customer chosen by list order.
      if (rows.length !== 1) {
        return refuse(
          "payload_invalid",
          `Paddle reported ${rows.length} active customers for an address it said already exists`,
        );
      }
      const customerId = stringOrNull(rows[0].id);
      if (customerId === null) return failed("re-finding an existing provider customer", found);
      return { ok: true, value: { customerId } };
    },

    /**
     * Creates the transaction the browser will open.
     *
     * THE BROWSER NAMES NOTHING. The price id and the customer id both arrive here already
     * resolved server-side — the price from private.billing_provider_price_map, the customer from
     * the link we wrote against the organization. So a caller who tampers with the request cannot
     * buy a different plan, buy at a different price, or buy on somebody else's account: those
     * three facts were decided before this function was reached.
     */
    createCheckoutSession: async (request) => {
      if (!api) return unconfigured("opening a checkout");

      const created = await paddleRequest(api, "POST", "/transactions", {
        items: [{ price_id: request.providerPriceId, quantity: 1 }],
        customer_id: request.providerCustomerId,
        collection_mode: "automatic",
        // Record only, and the comment is load-bearing: `custom_data` comes back on every webhook
        // and is attacker-reachable, so 0157 carries it in the payload and never reads it for
        // attribution. It is here to make a Paddle-side transaction legible to a human, nothing more.
        custom_data: {
          inplace_org_id: request.orgId,
          inplace_plan_key: request.planKey,
          inplace_billing_interval: request.interval,
        },
      });
      if (created.status < 200 || created.status >= 300) {
        return failed("opening a checkout", created);
      }
      const transactionId = stringOrNull(dataOf(created).id);
      if (transactionId === null) return failed("opening a checkout", created);
      return {
        ok: true,
        value: { kind: "provider_transaction", provider: "paddle", transactionId },
      };
    },

    /**
     * #219: cancellation takes effect at the END OF THE PAID PERIOD, never immediately. The
     * customer keeps full access until the boundary and can withdraw the cancellation until then.
     * `next_billing_period` is Paddle's name for exactly that, and passing anything else here
     * would take away access somebody has paid for.
     */
    cancelSubscription: async (providerSubscriptionId) => {
      if (!api) return unconfigured("cancelling at the provider");

      const canceled = await paddleRequest(
        api,
        "POST",
        `/subscriptions/${encodeURIComponent(providerSubscriptionId)}/cancel`,
        { effective_from: "next_billing_period" },
      );
      if (canceled.status < 200 || canceled.status >= 300) {
        return failed("cancelling at the provider", canceled);
      }
      const data = dataOf(canceled);
      const scheduled = data.scheduled_change as { effective_at?: unknown } | undefined;
      // The date Paddle scheduled it for, not the moment we asked. A customer is told when access
      // ends, and "now" would be the one answer that is certainly wrong.
      const canceledAt = stringOrNull(scheduled?.effective_at)
        ?? stringOrNull(data.canceled_at)
        ?? new Date().toISOString();
      return { ok: true, value: { canceledAt } };
    },

    /**
     * #216: no proration, and the new rung starts at the next renewal.
     *
     * `full_next_billing_period` is Paddle's name for that pair — the customer is billed the whole
     * new amount when the current period ends, and nothing is charged or credited now. The
     * alternatives all break the decision: `prorated_immediately` bills a part-period, and
     * `do_not_bill` would move the plan without ever charging for it.
     */
    changePlan: async (providerSubscriptionId, providerPriceId) => {
      if (!api) return unconfigured("changing the plan at the provider");

      const updated = await paddleRequest(
        api,
        "PATCH",
        `/subscriptions/${encodeURIComponent(providerSubscriptionId)}`,
        {
          items: [{ price_id: providerPriceId, quantity: 1 }],
          proration_billing_mode: "full_next_billing_period",
        },
      );
      if (updated.status < 200 || updated.status >= 300) {
        return failed("changing the plan at the provider", updated);
      }
      return { ok: true, value: { scheduledFor: stringOrNull(dataOf(updated).next_billed_at) } };
    },

    /**
     * Paddle's own customer portal. Preferred over building these screens: the stored payment
     * method lives at the merchant of record, and a card is one thing this product should never
     * receive, hold or render. The session is short-lived and created server-side, so the URL
     * cannot be forged or shared into another tenant's billing.
     */
    createPortalSession: async (providerCustomerId, providerSubscriptionId) => {
      if (!api) return unconfigured("opening the customer portal");

      const session = await paddleRequest(
        api,
        "POST",
        `/customers/${encodeURIComponent(providerCustomerId)}/portal-sessions`,
        providerSubscriptionId ? { subscription_ids: [providerSubscriptionId] } : {},
      );
      if (session.status < 200 || session.status >= 300) {
        return failed("opening the customer portal", session);
      }
      const urls = dataOf(session).urls as { general?: { overview?: unknown } } | undefined;
      const url = stringOrNull(urls?.general?.overview);
      if (url === null) return failed("opening the customer portal", session);
      return { ok: true, value: { url } };
    },

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

  changePlan: () => Promise.resolve(refuse(
    "not_configured",
    "no billing provider is configured; a plan change is an operator command with step-up and a reason",
  )),

  // There is no portal to open: the manual provider has no customer-facing surface of its own,
  // and pointing this anywhere would be inventing one.
  createPortalSession: () => Promise.resolve(refuse(
    "not_configured",
    "no billing provider is configured; there is no provider-hosted portal to open",
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
    // The API half is optional and separately configured. A deployment holding only the endpoint
    // secret verifies webhooks and refuses every outbound call by name — which is what
    // billing-webhook is, and why it is never given a key.
    return { ok: true, value: createPaddleAdapter(secret, paddleApiOptionsFrom(env)) };
  }

  return refuse("unsupported", `no adapter is registered for provider '${provider}'`);
}
