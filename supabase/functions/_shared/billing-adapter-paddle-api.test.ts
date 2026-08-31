// The Paddle API operations, proved against a stubbed provider.
//
// WHAT THESE TESTS ARE, AND WHAT THEY ARE NOT. They pin the REQUESTS this adapter makes and the
// REFUSALS it produces: the base URL it would call, the body it would send, the field it reads
// back, and — most importantly — that it does none of those things without a credential. They are
// not evidence that Paddle accepts any of it. There is no Paddle account (#213); the first live
// call is the only thing that can prove the contract, and it has not happened.
//
// The stub is a replaced `globalThis.fetch`. That is the whole seam: the adapter takes its
// credential as an argument and reaches the network through one helper, so a test can hold both.

// No assertion library: interpret-document/deno.lock is frozen and every sibling test throws
// plain Errors. `eq` is what that convention costs, and it is four lines.
import {
  billingAdapterFor,
  createPaddleAdapter,
  type PaddleApiConfig,
} from "./billing-adapter.ts";

/** Deep-equals by JSON shape, which is all any assertion in this file needs. */
function eq(actual: unknown, expected: unknown, message?: string): void {
  const a = JSON.stringify(actual) ?? "undefined";
  const b = JSON.stringify(expected) ?? "undefined";
  if (a !== b) throw new Error(`${message ?? "not equal"}: got ${a}, expected ${b}`);
}

const SECRET = "pdl_ntfset_01test0000000000000000000000000000000000";
const SANDBOX: PaddleApiConfig = { apiKey: "pdl_sdbx_apikey_01test", environment: "sandbox" };
const LIVE: PaddleApiConfig = { apiKey: "pdl_live_apikey_01test", environment: "production" };

const CHECKOUT = {
  orgId: "51000000-0000-4000-8000-000000000001",
  planKey: "pro" as const,
  interval: "monthly" as const,
  customerId: "ctm_01hv6y1jedq4p1n0yqn5ba3ky4",
  priceId: "pri_01hv8wptq8987qeep44cyrewp9",
};

interface Captured {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

/** Replaces fetch with a scripted responder and records every request the adapter made. */
async function withStubbedFetch(
  script: (request: Captured) => { status: number; body: unknown },
  run: (calls: Captured[]) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const calls: Captured[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const captured: Captured = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      headers,
    };
    calls.push(captured);
    const { status, body } = script(captured);
    return Promise.resolve(new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }));
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

// ===== The switch: no key, no live call. This is the invariant the rest of the file protects. =====

Deno.test("without an API key every live operation refuses by name and touches no network", async () => {
  const adapter = createPaddleAdapter(SECRET);
  await withStubbedFetch(() => ({ status: 200, body: {} }), async (calls) => {
    for (
      const outcome of [
        await adapter.createCustomer(CHECKOUT.orgId, "owner@tenant.example"),
        await adapter.createCheckoutSession(CHECKOUT),
        await adapter.cancelSubscription("sub_1"),
        await adapter.customerPortalUrl("ctm_1"),
      ]
    ) {
      eq(outcome.ok, false);
      if (!outcome.ok) eq(outcome.code, "not_configured");
    }
    eq(calls.length, 0, "an unconfigured adapter must not reach the provider at all");
  });
});

Deno.test("an unset or unrecognized PADDLE_ENVIRONMENT yields no configuration, never a default", async () => {
  // Forgetting a variable must not be what decides whether a customer is charged in sandbox or
  // for real. Both worlds are opt-in by name.
  for (const environment of [undefined, "", "prod", "live", "Production", "SANDBOX"]) {
    const env = (name: string) =>
      name === "PADDLE_WEBHOOK_SECRET"
        ? SECRET
        : name === "PADDLE_API_KEY"
        ? "pdl_live_apikey_01test"
        : name === "PADDLE_ENVIRONMENT"
        ? environment
        : undefined;
    const resolved = billingAdapterFor("paddle", env);
    eq(resolved.ok, true);
    if (!resolved.ok) return;
    await withStubbedFetch(() => ({ status: 200, body: {} }), async (calls) => {
      const outcome = await resolved.value.createCheckoutSession(CHECKOUT);
      eq(outcome.ok, false);
      eq(calls.length, 0);
    });
  }
});

Deno.test("sandbox and production are different hosts, and the environment picks which", async () => {
  for (const [config, host] of [[SANDBOX, "sandbox-api.paddle.com"], [LIVE, "api.paddle.com"]] as const) {
    const adapter = createPaddleAdapter(SECRET, config);
    await withStubbedFetch(
      () => ({ status: 201, body: { data: { id: "ctm_new" } } }),
      async (calls) => {
        await adapter.createCustomer(CHECKOUT.orgId, "owner@tenant.example");
        eq(new URL(calls[0].url).host, host);
      },
    );
  }
});

// ===== Customers =====

Deno.test("createCustomer posts the address, pins the API version, and returns the id", async () => {
  const adapter = createPaddleAdapter(SECRET, SANDBOX);
  await withStubbedFetch(
    () => ({ status: 201, body: { data: { id: "ctm_01hv6y1jedq4p1n0yqn5ba3ky4" } } }),
    async (calls) => {
      const outcome = await adapter.createCustomer(CHECKOUT.orgId, "  Owner@Tenant.example  ");
      eq(outcome.ok, true);
      if (outcome.ok) eq(outcome.value.customerId, "ctm_01hv6y1jedq4p1n0yqn5ba3ky4");
      eq(calls[0].method, "POST");
      eq(new URL(calls[0].url).pathname, "/customers");
      eq(calls[0].body?.email, "Owner@Tenant.example");
      eq(calls[0].headers["paddle-version"], "1");
      eq(calls[0].headers["authorization"], `Bearer ${SANDBOX.apiKey}`);
    },
  );
});

Deno.test("a duplicate customer resolves to the existing one, so a retry is idempotent", async () => {
  const adapter = createPaddleAdapter(SECRET, SANDBOX);
  await withStubbedFetch(
    (request) =>
      request.method === "POST"
        ? { status: 409, body: { error: { code: "customer_already_exists" } } }
        : { status: 200, body: { data: { items: [{ id: "ctm_existing" }] } } },
    async (calls) => {
      const outcome = await adapter.createCustomer(CHECKOUT.orgId, "owner@tenant.example");
      eq(outcome.ok, true);
      if (outcome.ok) eq(outcome.value.customerId, "ctm_existing");
      eq(calls.length, 2);
      eq(calls[1].method, "GET");
      eq(new URL(calls[1].url).searchParams.get("email"), "owner@tenant.example");
    },
  );
});

Deno.test("a conflict that resolves to no existing customer refuses rather than inventing one", async () => {
  const adapter = createPaddleAdapter(SECRET, SANDBOX);
  await withStubbedFetch(
    (request) =>
      request.method === "POST"
        ? { status: 409, body: { error: { code: "customer_already_exists" } } }
        : { status: 200, body: { data: { items: [] } } },
    async () => {
      const outcome = await adapter.createCustomer(CHECKOUT.orgId, "owner@tenant.example");
      eq(outcome.ok, false);
    },
  );
});

// ===== Checkout =====

Deno.test("a checkout is a transaction for the MAPPED price, charged automatically", async () => {
  const adapter = createPaddleAdapter(SECRET, SANDBOX);
  await withStubbedFetch(
    () => ({
      status: 201,
      body: { data: { id: "txn_1", checkout: { url: "https://pay.paddle.io/hsc_01" } } },
    }),
    async (calls) => {
      const outcome = await adapter.createCheckoutSession(CHECKOUT);
      eq(outcome.ok, true);
      if (outcome.ok) eq(outcome.value.url, "https://pay.paddle.io/hsc_01");
      eq(new URL(calls[0].url).pathname, "/transactions");
      eq(calls[0].body?.customer_id, CHECKOUT.customerId);
      eq(calls[0].body?.collection_mode, "automatic");
      eq(calls[0].body?.items, [{ price_id: CHECKOUT.priceId, quantity: 1 }]);
    },
  );
});

Deno.test("an unmapped price refuses instead of opening a checkout for a guessed plan", async () => {
  const adapter = createPaddleAdapter(SECRET, SANDBOX);
  await withStubbedFetch(() => ({ status: 201, body: {} }), async (calls) => {
    for (const bad of [{ ...CHECKOUT, priceId: "" }, { ...CHECKOUT, customerId: "   " }]) {
      const outcome = await adapter.createCheckoutSession(bad);
      eq(outcome.ok, false);
      if (!outcome.ok) eq(outcome.code, "payload_invalid");
    }
    eq(calls.length, 0);
  });
});

Deno.test("a transaction with no checkout url is refused, not reported as a url of nothing", async () => {
  const adapter = createPaddleAdapter(SECRET, SANDBOX);
  await withStubbedFetch(
    () => ({ status: 201, body: { data: { id: "txn_1" } } }),
    async () => {
      const outcome = await adapter.createCheckoutSession(CHECKOUT);
      eq(outcome.ok, false);
      if (!outcome.ok) eq(outcome.code, "payload_invalid");
    },
  );
});

// ===== Cancellation =====

Deno.test("cancellation is scheduled for the period boundary, never immediate (#219)", async () => {
  const adapter = createPaddleAdapter(SECRET, SANDBOX);
  await withStubbedFetch(
    () => ({
      status: 200,
      body: { data: { scheduled_change: { effective_at: "2026-09-30T00:00:00Z" } } },
    }),
    async (calls) => {
      const outcome = await adapter.cancelSubscription("sub_01hv8wptq8987qeep44cyrewp9");
      eq(outcome.ok, true);
      if (outcome.ok) eq(outcome.value.canceledAt, "2026-09-30T00:00:00Z");
      eq(
        new URL(calls[0].url).pathname,
        "/subscriptions/sub_01hv8wptq8987qeep44cyrewp9/cancel",
      );
      // The decided behaviour, asserted so a future edit cannot quietly delete paid-for access.
      eq(calls[0].body?.effective_from, "next_billing_period");
    },
  );
});

// ===== Portal =====

Deno.test("the customer portal url is read from the documented field", async () => {
  const adapter = createPaddleAdapter(SECRET, SANDBOX);
  await withStubbedFetch(
    () => ({
      status: 201,
      body: { data: { urls: { general: { overview: "https://customer-portal.paddle.com/cpl_01" } } } },
    }),
    async (calls) => {
      const outcome = await adapter.customerPortalUrl("ctm_01hv6y1jedq4p1n0yqn5ba3ky4");
      eq(outcome.ok, true);
      if (outcome.ok) eq(outcome.value.url, "https://customer-portal.paddle.com/cpl_01");
      eq(
        new URL(calls[0].url).pathname,
        "/customers/ctm_01hv6y1jedq4p1n0yqn5ba3ky4/portal-sessions",
      );
    },
  );
});

// ===== What a refusal is allowed to say =====

Deno.test("provider wording reaches neither the refusal nor the log", async () => {
  const adapter = createPaddleAdapter(SECRET, SANDBOX);
  const leak = "customer ctm_01hv6y1 for account acct_secret is suspended";
  const original = console.error;
  const logged: string[] = [];
  console.error = (...parts: unknown[]) => { logged.push(parts.map(String).join(" ")); };
  try {
    await withStubbedFetch(
      () => ({ status: 400, body: { error: { code: leak, detail: leak } } }),
      async () => {
        const outcome = await adapter.customerPortalUrl("ctm_01hv6y1jedq4p1n0yqn5ba3ky4");
        eq(outcome.ok, false);
        if (!outcome.ok) eq(outcome.detail.includes(leak), false);
      },
    );
  } finally {
    console.error = original;
  }
  // A code-shaped slug is useful to an operator; a sentence is prose that can carry identifiers,
  // and reshaping its punctuation would keep every one of them. It is replaced, not cleaned.
  eq(logged.some((line) => line.includes("acct_secret")), false);
  eq(logged.some((line) => line.includes("unrecognized_code_shape")), true);
});

Deno.test("a genuine slug code IS logged, because an operator needs it", async () => {
  const adapter = createPaddleAdapter(SECRET, SANDBOX);
  const original = console.error;
  const logged: string[] = [];
  console.error = (...parts: unknown[]) => { logged.push(parts.map(String).join(" ")); };
  try {
    await withStubbedFetch(
      () => ({ status: 400, body: { error: { code: "price_not_found" } } }),
      async () => {
        await adapter.createCheckoutSession(CHECKOUT);
      },
    );
  } finally {
    console.error = original;
  }
  eq(logged.some((line) => line.includes("price_not_found")), true);
});

Deno.test("a wrong credential is our fault and says so, so an operator looks at the deployment", async () => {
  const adapter = createPaddleAdapter(SECRET, SANDBOX);
  for (const status of [401, 403]) {
    await withStubbedFetch(
      () => ({ status, body: { error: { code: "unauthorized" } } }),
      async () => {
        const outcome = await adapter.customerPortalUrl("ctm_1");
        eq(outcome.ok, false);
        if (!outcome.ok) eq(outcome.code, "not_configured");
      },
    );
  }
});

Deno.test("an unreachable provider is 'we could not ask', never 'the answer is no'", async () => {
  const adapter = createPaddleAdapter(SECRET, SANDBOX);
  const original = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new TypeError("network"))) as typeof fetch;
  try {
    const outcome = await adapter.createCheckoutSession(CHECKOUT);
    eq(outcome.ok, false);
    if (!outcome.ok) eq(outcome.code, "not_configured");
  } finally {
    globalThis.fetch = original;
  }
});

// ===== The invariant that outranks all of the above =====

Deno.test("configuring the API key does not make Stripe or Morning reachable", async () => {
  // #207/#256: a second merchant of record that can appear by accident is worse than none.
  const env = (name: string) =>
    ({
      PADDLE_WEBHOOK_SECRET: SECRET,
      PADDLE_API_KEY: "pdl_live_apikey_01test",
      PADDLE_ENVIRONMENT: "production",
      STRIPE_SECRET_KEY: "sk_live_whatever",
      MORNING_API_KEY: "morning_whatever",
    } as Record<string, string>)[name];
  for (const provider of ["stripe", "morning"]) {
    const resolved = billingAdapterFor(provider, env);
    eq(resolved.ok, false);
    if (!resolved.ok) eq(resolved.code, "not_authorized");
  }
  await Promise.resolve();
});
