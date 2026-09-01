import { handleCheckout, type CheckoutAuthorization, type CheckoutPorts } from "./core.ts";
import type { BillingAdapter, BillingOutcome } from "../_shared/billing-adapter.ts";

// ===== Fixtures =====
const ORG_A = "71000000-0000-4000-8000-000000000001";
const ORG_B = "71000000-0000-4000-8000-000000000002";

/** A record of every provider call, in the order it happened. The orderings ARE the security. */
interface Journal {
  calls: string[];
}

function adapterFor(journal: Journal, overrides: Partial<BillingAdapter> = {}): BillingAdapter {
  const ok = <T>(value: T): BillingOutcome<T> => ({ ok: true, value });
  return {
    provider: "paddle",
    createCustomer: (orgId) => {
      journal.calls.push(`createCustomer:${orgId}`);
      return Promise.resolve(ok({ customerId: "ctm_created" }));
    },
    createCheckoutSession: (request) => {
      journal.calls.push(`createCheckout:${request.providerPriceId}:${request.providerCustomerId}`);
      return Promise.resolve(ok({
        kind: "provider_transaction" as const,
        provider: "paddle",
        transactionId: "txn_created",
      }));
    },
    cancelSubscription: (id) => {
      journal.calls.push(`cancel:${id}`);
      return Promise.resolve(ok({ canceledAt: "2026-09-30T00:00:00.000Z" }));
    },
    changePlan: (subscriptionId, priceId) => {
      journal.calls.push(`changePlan:${subscriptionId}:${priceId}`);
      return Promise.resolve(ok({ scheduledFor: "2026-09-30T00:00:00.000Z" }));
    },
    createPortalSession: (customerId) => {
      journal.calls.push(`portal:${customerId}`);
      return Promise.resolve(ok({ url: "https://sandbox-customer-portal.paddle.com/x" }));
    },
    verifyAndParse: () =>
      Promise.resolve({ ok: false as const, code: "not_configured" as const, detail: "n/a" }),
    ...overrides,
  };
}

const ALLOWED: CheckoutAuthorization = {
  allowed: true,
  org_id: ORG_A,
  provider: "paddle",
  provider_price_id: "pri_pro_monthly",
  plan_key: "pro",
  billing_interval: "monthly",
  provider_customer_id: null,
  provider_subscription_id: null,
  current_plan_key: "free",
};

function portsFor(
  journal: Journal,
  overrides: Partial<CheckoutPorts> = {},
  authorization: CheckoutAuthorization = ALLOWED,
): CheckoutPorts {
  return {
    adapter: adapterFor(journal),
    authorizeCheckout: (planKey, interval) => {
      journal.calls.push(`authorizeCheckout:${planKey}:${interval}`);
      return Promise.resolve(authorization);
    },
    authorizeManagement: () => {
      journal.calls.push("authorizeManagement");
      return Promise.resolve(authorization);
    },
    callerEmail: () => {
      journal.calls.push("callerEmail");
      return Promise.resolve("owner@example.test");
    },
    linkCustomer: (orgId, provider, customerId) => {
      journal.calls.push(`linkCustomer:${orgId}:${provider}:${customerId}`);
      return Promise.resolve({ ok: true });
    },
    ...overrides,
  };
}

const post = (body: unknown) =>
  new Request("https://edge.test/billing-checkout", { method: "POST", body: JSON.stringify(body) });

// ===== The ordering that is not interchangeable =====

Deno.test("the provider-customer link is written BEFORE any transaction can be created", async () => {
  // If a transaction existed before the link did, a customer could pay in the gap. The activation
  // event would name a provider customer we had not recorded, dead-letter as unattributable, and
  // the money would have moved with no entitlement and no way to attribute it after the fact.
  const journal: Journal = { calls: [] };
  const response = await handleCheckout(post({ action: "checkout", plan_key: "pro", billing_interval: "monthly" }), portsFor(journal));
  if (response.status !== 200) throw new Error(`checkout answered ${response.status}`);

  const link = journal.calls.findIndex((call) => call.startsWith("linkCustomer:"));
  const transaction = journal.calls.findIndex((call) => call.startsWith("createCheckout:"));
  if (link < 0 || transaction < 0) throw new Error(`missing step: ${journal.calls.join(" -> ")}`);
  if (link > transaction) {
    throw new Error(`a transaction was created before the link: ${journal.calls.join(" -> ")}`);
  }
});

Deno.test("authorization happens before the provider is touched at all", async () => {
  const journal: Journal = { calls: [] };
  await handleCheckout(post({ action: "checkout", plan_key: "pro", billing_interval: "monthly" }), portsFor(journal));
  if (!journal.calls[0].startsWith("authorizeCheckout:")) {
    throw new Error(`the first step was ${journal.calls[0]}`);
  }
});

Deno.test("a refused caller reaches no provider call and learns nothing", async () => {
  for (const reason of ["not_authorized", "price_unmapped", "organization_not_active", "subscription_row_absent"]) {
    const journal: Journal = { calls: [] };
    const response = await handleCheckout(
      post({ action: "checkout", plan_key: "pro", billing_interval: "monthly" }),
      portsFor(journal, {}, { allowed: false, reason_code: reason }),
    );
    if (response.status !== 403) throw new Error(`${reason} answered ${response.status}`);
    // One body for all four: a caller must not be able to map the platform by reading refusals.
    const body = await response.json();
    if (body.error !== "refused") throw new Error(`${reason} leaked ${JSON.stringify(body)}`);
    if (journal.calls.some((call) => call.startsWith("create") || call.startsWith("link"))) {
      throw new Error(`${reason} reached the provider: ${journal.calls.join(" -> ")}`);
    }
  }
});

Deno.test("a shut merchant of record refuses the purchase, by name", async () => {
  // The one refusal a customer may read: their own screen already knows it from
  // my_billing_availability() (0189), and "something went wrong" would be a worse lie.
  const journal: Journal = { calls: [] };
  const response = await handleCheckout(
    post({ action: "checkout", plan_key: "pro", billing_interval: "monthly" }),
    portsFor(journal, {}, { allowed: false, reason_code: "provider_not_enabled" }),
  );
  if (response.status !== 409) throw new Error(`answered ${response.status}`);
  if ((await response.json()).error !== "provider_not_enabled") throw new Error("wrong body");
  if (journal.calls.some((call) => call.startsWith("create"))) {
    throw new Error("a shut provider was still called");
  }
});

// ===== The browser names nothing =====

Deno.test("the price and the customer come from the authorization, never from the request", async () => {
  const journal: Journal = { calls: [] };
  await handleCheckout(
    // A caller trying to name its own price, customer and organization. All three are ignored:
    // the handler never reads them, and the values used are the ones the database chose.
    post({
      action: "checkout",
      plan_key: "pro",
      billing_interval: "monthly",
      provider_price_id: "pri_attacker_chose",
      provider_customer_id: "ctm_attacker_chose",
      org_id: ORG_B,
    }),
    portsFor(journal),
  );
  const checkout = journal.calls.find((call) => call.startsWith("createCheckout:"));
  if (checkout !== "createCheckout:pri_pro_monthly:ctm_created") {
    throw new Error(`the request steered the checkout: ${checkout}`);
  }
  const link = journal.calls.find((call) => call.startsWith("linkCustomer:"));
  if (!link?.startsWith(`linkCustomer:${ORG_A}:`)) {
    throw new Error(`the request steered the tenant: ${link}`);
  }
});

Deno.test("an existing provider customer is reused rather than created a second time", async () => {
  const journal: Journal = { calls: [] };
  await handleCheckout(
    post({ action: "checkout", plan_key: "pro", billing_interval: "monthly" }),
    portsFor(journal, {}, { ...ALLOWED, provider_customer_id: "ctm_already_ours" }),
  );
  if (journal.calls.some((call) => call.startsWith("createCustomer:"))) {
    throw new Error("a second provider customer was created for a linked organization");
  }
  if (!journal.calls.includes("createCheckout:pri_pro_monthly:ctm_already_ours")) {
    throw new Error(`the existing customer was not used: ${journal.calls.join(" -> ")}`);
  }
});

Deno.test("a link that cannot be written stops the payment", async () => {
  // The cross-tenant case: service_link_billing_customer refuses a customer another organization
  // already holds. If the checkout continued anyway, the payment would attribute to that other
  // organization -- which is the one outcome this whole boundary exists to make impossible.
  const journal: Journal = { calls: [] };
  const response = await handleCheckout(
    post({ action: "checkout", plan_key: "pro", billing_interval: "monthly" }),
    portsFor(journal, {
      linkCustomer: () => {
        journal.calls.push("linkCustomer:REFUSED");
        return Promise.resolve({ ok: false, detail: "provider_customer_claimed_by_another_org" });
      },
    }),
  );
  if (response.status !== 409) throw new Error(`answered ${response.status}`);
  if (journal.calls.some((call) => call.startsWith("createCheckout:"))) {
    throw new Error("a transaction was created after the link was refused");
  }
});

// ===== Nothing here is ever a receipt =====

Deno.test("no response from this function can be read as proof of payment", async () => {
  const journal: Journal = { calls: [] };
  const responses = [
    await handleCheckout(post({ action: "checkout", plan_key: "pro", billing_interval: "monthly" }), portsFor(journal)),
    await handleCheckout(post({ action: "change_plan", plan_key: "pro", billing_interval: "monthly" }),
      portsFor(journal, {}, { ...ALLOWED, provider_subscription_id: "sub_1", provider_customer_id: "ctm_1" })),
    await handleCheckout(post({ action: "cancel" }),
      portsFor(journal, {}, { ...ALLOWED, provider_subscription_id: "sub_1", provider_customer_id: "ctm_1" })),
  ];
  for (const response of responses) {
    const text = JSON.stringify(await response.json());
    // #217: entitlement opens on a signed server event. A field the screen could mistake for a
    // settled payment is how that rule gets broken by a well-meaning edit six months from now.
    if (/\b(paid|active|entitled|granted|succeeded|plan_active)\b/.test(text)) {
      throw new Error(`a checkout response looks like a receipt: ${text}`);
    }
  }
});

Deno.test("the source contains no path from this function to an entitlement write", async () => {
  const source = await Deno.readTextFile(new URL("./core.ts", import.meta.url));
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  for (const forbidden of ["organization_subscriptions", "plan_key =", "service_apply_billing_event"]) {
    if (code.includes(forbidden)) {
      throw new Error(`billing-checkout reaches for ${forbidden}; entitlement follows a signed event`);
    }
  }
});

// ===== Shape =====

Deno.test("a GET, a malformed body and an unknown action are all refused", async () => {
  const journal: Journal = { calls: [] };
  const get = await handleCheckout(
    new Request("https://edge.test/billing-checkout", { method: "GET" }), portsFor(journal));
  if (get.status !== 405) throw new Error(`GET answered ${get.status}`);

  const malformed = await handleCheckout(
    new Request("https://edge.test/billing-checkout", { method: "POST", body: "{" }), portsFor(journal));
  if (malformed.status !== 400) throw new Error(`malformed answered ${malformed.status}`);

  const unknown = await handleCheckout(post({ action: "refund_everything" }), portsFor(journal));
  if (unknown.status !== 400) throw new Error(`unknown action answered ${unknown.status}`);

  if (journal.calls.length > 0) throw new Error(`a malformed request reached ${journal.calls.join(" -> ")}`);
});

Deno.test("with no adapter the function refuses rather than improvising", async () => {
  const journal: Journal = { calls: [] };
  const response = await handleCheckout(
    post({ action: "checkout", plan_key: "pro", billing_interval: "monthly" }),
    portsFor(journal, { adapter: null, adapterRefusal: { code: "not_configured", detail: "no key" } }),
  );
  if (response.status !== 503) throw new Error(`answered ${response.status}`);
});

Deno.test("cancellation is scheduled, never applied here", async () => {
  const journal: Journal = { calls: [] };
  const response = await handleCheckout(post({ action: "cancel" }),
    portsFor(journal, {}, { ...ALLOWED, provider_customer_id: "ctm_1", provider_subscription_id: "sub_1" }));
  const body = await response.json();
  // #219: the boundary is the end of the paid period, and the date is the provider's answer.
  if (body.scheduled !== true || !body.effective_at) throw new Error(`wrong body: ${JSON.stringify(body)}`);
  if (!journal.calls.includes("cancel:sub_1")) throw new Error("the provider was not asked to cancel");
});
