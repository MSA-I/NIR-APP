/**
 * The billing provider boundary (0157) — the contract, and the only implementation that exists.
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
   */
  providerCustomerId: string | null;
  payload: Record<string, unknown>;
}

export type BillingOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; code: BillingRefusal; detail: string };

export type BillingRefusal =
  | "not_configured"
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
  /** A hosted payment page. `not_configured` while no provider is wired. */
  createCheckoutSession(request: CheckoutRequest): Promise<BillingOutcome<{ url: string }>>;
  cancelSubscription(providerSubscriptionId: string): Promise<BillingOutcome<{ canceledAt: string }>>;
  /**
   * Verifies the raw body against the provider's signature header and parses it. Verification and
   * parsing are one call on purpose: a parsed-but-unverified event is a thing nobody should be
   * able to hold, and separating them is how one gets used by mistake.
   */
  verifyAndParse(rawBody: string, headers: Headers): BillingOutcome<BillingEvent>;
}

const refuse = (code: BillingRefusal, detail: string): BillingOutcome<never> =>
  ({ ok: false, code, detail });

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
  verifyAndParse: () => refuse(
    "not_configured",
    "the manual provider receives no webhooks and cannot verify a signature",
  ),
};

/**
 * Resolves the adapter for a provider name. Unknown providers refuse rather than defaulting to
 * manual: silently treating an unrecognised provider as the one that accepts nothing would look
 * identical to a correctly refused event, and the difference matters when debugging why a
 * customer's payment did nothing.
 */
export function billingAdapterFor(provider: string): BillingOutcome<BillingAdapter> {
  if (provider === manualBillingAdapter.provider) return { ok: true, value: manualBillingAdapter };
  return refuse("unsupported", `no adapter is registered for provider '${provider}'`);
}
