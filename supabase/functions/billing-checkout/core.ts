// billing-checkout/core.ts -- the whole decision, extracted from Deno.serve so it is provable
// without a network, a database or a Paddle account (the billing-webhook/core.ts precedent).
//
// WHAT THIS FUNCTION IS FOR, AND WHAT IT IS CAREFULLY NOT FOR. It starts a payment and it manages
// a subscription that already exists. It NEVER grants, changes or removes an entitlement. Not on
// success, not on a returned transaction, not on anything the browser tells it afterwards. #217
// makes a paid entitlement open on a SIGNED SERVER EVENT and on nothing else, so the only thing
// this function can do to a subscription row is write the provider-customer link -- which is not
// an entitlement, it is the address every later signed event is delivered to.
//
// THAT IS WHY THERE IS NO SUCCESS CALLBACK HERE. Paddle's overlay resolves in the customer's
// browser the moment their card is accepted, and the obvious next line is to mark the plan paid.
// It would be wrong every time: the browser is not a witness, a resolved overlay is not a settled
// payment, and a caller can produce that resolution without paying anything. The customer's screen
// is told "we are waiting for the provider to confirm", and the plan changes when
// subscription.activated arrives through billing-webhook, verified.
//
// THE ORDER, AND WHY IT IS THIS ORDER:
//   1. authorize AS THE CALLER  -- the database decides, from auth_org(), which organization this
//      is and whether it may buy. Nothing after this point takes an organization from the request.
//   2. create or re-find the provider customer
//   3. WRITE THE LINK, and only then
//   4. create the transaction.
//
// Step 3 before step 4 is the one that is not interchangeable. If a transaction were created first
// and the link written after, a customer could pay in the window between them; the activation
// event would arrive naming a provider customer we had not yet recorded, fail to attribute, and
// dead-letter -- money taken, entitlement not granted, and the only trace an unattributable event.
// Writing the link first makes the worst case the harmless one: a link with no purchase behind it,
// which costs nothing and is reused the next time the customer tries.

import type { BillingAdapter, CheckoutHandle } from "../_shared/billing-adapter.ts";

/** What the database said about the caller. Every field here was decided server-side. */
export interface CheckoutAuthorization {
  allowed: boolean;
  reason_code?: string;
  org_id?: string;
  provider?: string;
  provider_price_id?: string;
  plan_key?: string;
  billing_interval?: string;
  provider_customer_id?: string | null;
  provider_subscription_id?: string | null;
  current_plan_key?: string;
  current_billing_interval?: string;
}

export interface CheckoutPorts {
  adapter: BillingAdapter | null;
  adapterRefusal?: { code: string; detail: string };
  /** Runs `authorize_billing_checkout` AS THE CALLER, so auth_org() is the caller's own. */
  authorizeCheckout(planKey: string, interval: string): Promise<CheckoutAuthorization | null>;
  /** Runs `authorize_billing_management` AS THE CALLER. */
  authorizeManagement(): Promise<CheckoutAuthorization | null>;
  /** The address to file the provider customer under. Never reached before authorization. */
  callerEmail(): Promise<string | null>;
  linkCustomer(orgId: string, provider: string, customerId: string): Promise<{ ok: boolean; detail?: string }>;
}

export type CheckoutAction = "checkout" | "portal" | "cancel" | "change_plan";

export interface CheckoutRequestBody {
  action?: string;
  plan_key?: string;
  billing_interval?: string;
}

/**
 * One refusal body, like billing-webhook. A response that distinguished "you are not an owner"
 * from "that plan is not sold" from "the provider is shut" would let anyone with a login map the
 * commercial state of the platform. The operator reads the real reason from the logs.
 *
 * The ONE exception is `provider_not_enabled`, which is returned by name: the customer's screen has
 * to be able to say "purchasing is not available yet" rather than "something went wrong", and that
 * fact is already public through my_billing_availability() (0189). Telling them twice costs nothing.
 */
const REFUSED = JSON.stringify({ error: "refused" });
const UNAVAILABLE = JSON.stringify({ error: "provider_not_enabled" });

function answer(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const ACTIONS: readonly CheckoutAction[] = ["checkout", "portal", "cancel", "change_plan"];

export async function handleCheckout(
  request: Request,
  ports: CheckoutPorts,
): Promise<Response> {
  if (request.method !== "POST") return answer(405, REFUSED);

  let body: CheckoutRequestBody;
  try {
    body = await request.json() as CheckoutRequestBody;
  } catch {
    return answer(400, REFUSED);
  }
  const action = ACTIONS.find((candidate) => candidate === body.action);
  if (action === undefined) return answer(400, REFUSED);

  if (ports.adapter === null) {
    console.error("billing-checkout has no adapter", ports.adapterRefusal?.code);
    return answer(503, REFUSED);
  }

  // ===== 1. The database decides, as the caller =====
  const authorization = action === "checkout" || action === "change_plan"
    ? await ports.authorizeCheckout(String(body.plan_key ?? ""), String(body.billing_interval ?? ""))
    : await ports.authorizeManagement();

  if (authorization === null) return answer(500, REFUSED);
  if (!authorization.allowed) {
    // The one refusal a customer is allowed to read, because their own screen already knows it.
    if (authorization.reason_code === "provider_not_enabled") return answer(409, UNAVAILABLE);
    console.error("billing-checkout refused", action, authorization.reason_code);
    return answer(403, REFUSED);
  }

  const orgId = authorization.org_id;
  const provider = authorization.provider;
  if (!orgId || !provider) return answer(500, REFUSED);

  if (action === "portal" || action === "cancel") {
    return await manageExisting(action, authorization, ports.adapter);
  }

  // ===== 2. The provider customer: reuse whatever we already hold =====
  let customerId = authorization.provider_customer_id ?? null;
  if (customerId === null) {
    const email = await ports.callerEmail();
    if (email === null) return answer(500, REFUSED);

    const created = await ports.adapter.createCustomer(orgId, email);
    if (!created.ok) {
      console.error("billing-checkout customer failed", created.code, created.detail);
      return answer(502, REFUSED);
    }
    customerId = created.value.customerId;

    // ===== 3. The link, BEFORE any money can move =====
    const linked = await ports.linkCustomer(orgId, provider, customerId);
    if (!linked.ok) {
      // Refusing here is the point. A link we could not write means a payment we could not
      // attribute, and an unattributable payment is worse than a checkout that did not open.
      console.error("billing-checkout link failed", linked.detail);
      return answer(409, REFUSED);
    }
  }

  // ===== 4. Only now: the payment =====
  if (action === "change_plan") {
    const subscriptionId = authorization.provider_subscription_id;
    const priceId = authorization.provider_price_id;
    if (!subscriptionId || !priceId) return answer(409, REFUSED);

    const changed = await ports.adapter.changePlan(subscriptionId, priceId);
    if (!changed.ok) {
      console.error("billing-checkout change_plan failed", changed.code, changed.detail);
      return answer(502, REFUSED);
    }
    // #216: the rung moves at the next renewal. The entitlement still does not move here -- the
    // provider's own subscription.updated event carries it through the verified door.
    return answer(200, JSON.stringify({
      scheduled: true,
      scheduled_for: changed.value.scheduledFor,
      plan_key: authorization.plan_key,
      billing_interval: authorization.billing_interval,
    }));
  }

  const priceId = authorization.provider_price_id;
  if (!priceId) return answer(500, REFUSED);

  const checkout = await ports.adapter.createCheckoutSession({
    orgId,
    planKey: authorization.plan_key ?? "",
    interval: (authorization.billing_interval ?? "monthly") as "monthly" | "yearly",
    providerPriceId: priceId,
    providerCustomerId: customerId,
  });
  if (!checkout.ok) {
    console.error("billing-checkout session failed", checkout.code, checkout.detail);
    return answer(502, REFUSED);
  }

  return answer(200, JSON.stringify(checkoutBody(checkout.value)));
}

/**
 * What the browser receives. Deliberately the provider handle and nothing that resembles a
 * receipt: no amount, no plan grant, no "paid" of any kind. A field called `paid` here would be
 * read as one by the next person to touch the screen, whatever its comment said.
 */
function checkoutBody(handle: CheckoutHandle): Record<string, unknown> {
  return handle.kind === "hosted_url"
    ? { checkout: { kind: "hosted_url", url: handle.url } }
    : {
      checkout: {
        kind: "provider_transaction",
        provider: handle.provider,
        transaction_id: handle.transactionId,
      },
    };
}

async function manageExisting(
  action: "portal" | "cancel",
  authorization: CheckoutAuthorization,
  adapter: BillingAdapter,
): Promise<Response> {
  const customerId = authorization.provider_customer_id;
  const subscriptionId = authorization.provider_subscription_id ?? null;
  if (!customerId) return answer(409, REFUSED);

  if (action === "portal") {
    const session = await adapter.createPortalSession(customerId, subscriptionId);
    if (!session.ok) {
      console.error("billing-checkout portal failed", session.code, session.detail);
      return answer(502, REFUSED);
    }
    return answer(200, JSON.stringify({ portal_url: session.value.url }));
  }

  if (!subscriptionId) return answer(409, REFUSED);
  const canceled = await adapter.cancelSubscription(subscriptionId);
  if (!canceled.ok) {
    console.error("billing-checkout cancel failed", canceled.code, canceled.detail);
    return answer(502, REFUSED);
  }
  // #219: scheduled for the period boundary, reversible until then, and -- again -- not applied
  // here. The subscription row moves when the provider's own canceled/updated event arrives.
  return answer(200, JSON.stringify({
    scheduled: true,
    effective_at: canceled.value.canceledAt,
  }));
}
