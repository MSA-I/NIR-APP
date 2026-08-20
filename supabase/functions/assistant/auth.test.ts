// Identity, capability and limit contracts. Everything here fails CLOSED: a missing flag row, a
// failing RPC, an unreachable enforcement door and an unmeasurable ceiling are all refusals, and
// none of them is ever read as permission.
import assert from "node:assert/strict";
import {
  assertRunAllowed,
  assertWithinLimits,
  resolveActorContext,
  resolveCapabilities,
  type RpcPort,
  type RpcResult,
} from "./auth.ts";
import { AssistantEdgeError } from "./errors.ts";
import type { AssistantConfig } from "./config.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

function port(
  responses: Record<string, RpcResult | (() => RpcResult)>,
): RpcPort {
  return {
    rpc(name) {
      const entry = responses[name];
      const result = typeof entry === "function"
        ? entry()
        : entry ?? { data: null, error: { message: `unexpected rpc ${name}` } };
      return Promise.resolve(result);
    },
  };
}

function baseConfig(overrides: Partial<AssistantConfig> = {}): AssistantConfig {
  return {
    provider: "openai",
    model: "test-model",
    fastModel: "test-model",
    maxOutputTokens: 4096,
    timeoutMs: 30_000,
    maxToolCallsPerTurn: 4,
    dailyUserLimit: null,
    dailyOrgLimit: null,
    monthlyOrgLimit: null,
    softCostCap: null,
    hardCostCap: null,
    contextMessageLimit: 12,
    ...overrides,
  };
}

const liveIdentity = {
  auth_org: { data: ORG, error: null },
  auth_role: { data: "owner", error: null },
  auth_scopes: { data: [], error: null },
  organization_access_state: {
    data: [{ access_mode: "active" }],
    error: null,
  },
};

const allFlagsOn = {
  resolve_feature_flags: {
    data: [
      { flag_key: "assistant.ui", state: true },
      { flag_key: "assistant.history", state: true },
      { flag_key: "assistant.drafts", state: false },
    ],
    error: null,
  },
};

Deno.test("flags fail closed: an RPC failure reads as every flag off", async () => {
  const capabilities = await resolveCapabilities(
    port({
      resolve_feature_flags: { data: null, error: { message: "boom" } },
    }),
  );
  assert.deepEqual(capabilities, {
    ui: false,
    history: false,
    drafts: false,
    confirmedActions: false,
  });
});

Deno.test("flags fail closed: a missing definition row reads as off", async () => {
  const capabilities = await resolveCapabilities(
    port({
      resolve_feature_flags: {
        data: [{ flag_key: "assistant.ui", state: true }],
        error: null,
      },
    }),
  );
  assert.equal(capabilities.ui, true);
  assert.equal(capabilities.history, false);
});

Deno.test("confirmedActions never comes from a flag -- only the policy read raises it", async () => {
  // A flag row claiming the name cannot raise it: ENTERPRISE-SECURITY-MODEL §8 -- a flag never
  // widens permission. The switch is the 0076-shape policy (OPEN-DECISIONS #109), and an
  // unreachable policy read is off, not on.
  const flagOnly = await resolveCapabilities(
    port({
      resolve_feature_flags: {
        data: [{ flag_key: "assistant.confirmed_actions", state: true }],
        error: null,
      },
    }),
  );
  assert.equal(flagOnly.confirmedActions, false);
  const policyOn = await resolveCapabilities(
    port({
      resolve_feature_flags: { data: [], error: null },
      assistant_confirmed_actions_enabled: { data: true, error: null },
    }),
  );
  assert.equal(policyOn.confirmedActions, true);
});

Deno.test("a null auth_org (suspended organization) is a refusal", async () => {
  await assert.rejects(
    resolveActorContext(
      port({ ...liveIdentity, ...allFlagsOn, auth_org: { data: null, error: null } }),
      USER,
    ),
    (error: unknown) =>
      error instanceof AssistantEdgeError && error.code === "assistant_disabled",
  );
});

Deno.test("a retired role is a refusal, never a default", async () => {
  await assert.rejects(
    resolveActorContext(
      port({
        ...liveIdentity,
        ...allFlagsOn,
        auth_role: { data: "kitchen", error: null },
      }),
      USER,
    ),
    (error: unknown) =>
      error instanceof AssistantEdgeError && error.code === "assistant_disabled",
  );
});

Deno.test("a non-active access mode resolves canWrite=false but still answers", async () => {
  const actor = await resolveActorContext(
    port({
      ...liveIdentity,
      ...allFlagsOn,
      organization_access_state: {
        data: [{ access_mode: "read_only" }],
        error: null,
      },
    }),
    USER,
  );
  assert.equal(actor.canWrite, false);
  assert.equal(actor.orgId, ORG);
});

// ---- The pre-spend enforcement door (assistant_assert_run_allowed, 0164) ----

function doorRefusing(code: string): RpcPort {
  return port({
    assistant_assert_run_allowed: { data: null, error: { message: code } },
  });
}

for (
  const code of [
    "assistant_rate_limited",
    "assistant_limit_reached",
    "assistant_limit_unknown",
    "assistant_not_entitled",
  ] as const
) {
  Deno.test(`the enforcement door's ${code} refusal surfaces before any provider spend`, async () => {
    await assert.rejects(
      assertRunAllowed(doorRefusing(code)),
      (error: unknown) =>
        error instanceof AssistantEdgeError && error.code === code,
    );
  });
}

Deno.test("an unreachable enforcement door is a refusal, not a pass", async () => {
  await assert.rejects(
    assertRunAllowed(doorRefusing("function assistant_assert_run_allowed does not exist")),
    (error: unknown) =>
      error instanceof AssistantEdgeError &&
      error.code === "assistant_provider_unavailable",
  );
});

Deno.test("an allowed run passes the door silently", async () => {
  await assertRunAllowed(port({
    assistant_assert_run_allowed: {
      data: { allowed: true, unlimited: true },
      error: null,
    },
  }));
});

// ---- The env-var ceilings (additional, never instead) ----

Deno.test("no env caps set means no extra RPC and no refusal", async () => {
  // The port would fail on any call; with no caps configured nothing is called.
  await assertWithinLimits(port({}), baseConfig());
});

Deno.test("a set env ceiling that cannot be measured refuses", async () => {
  await assert.rejects(
    assertWithinLimits(
      port({
        assistant_run_totals: { data: null, error: { message: "missing" } },
      }),
      baseConfig({ dailyOrgLimit: 100 }),
    ),
    (error: unknown) =>
      error instanceof AssistantEdgeError &&
      error.code === "assistant_limit_unknown",
  );
});

Deno.test("an unmeasurable configured soft cost cap also refuses fail-closed", async () => {
  await assert.rejects(
    assertWithinLimits(
      port({
        assistant_run_totals: {
          data: [{ user_today: 0, org_today: 0, org_month: 0, org_month_cost: null }],
          error: null,
        },
      }),
      baseConfig({ softCostCap: 10_000 }),
    ),
    (error: unknown) =>
      error instanceof AssistantEdgeError &&
      error.code === "assistant_limit_unknown",
  );
});

Deno.test("a measured env ceiling at its cap refuses", async () => {
  await assert.rejects(
    assertWithinLimits(
      port({
        assistant_run_totals: {
          data: [{ user_today: 2, org_today: 50, org_month: 10, org_month_cost: 0 }],
          error: null,
        },
      }),
      baseConfig({ dailyOrgLimit: 50 }),
    ),
    (error: unknown) =>
      error instanceof AssistantEdgeError &&
      error.code === "assistant_limit_reached",
  );
});

Deno.test("a measured env ceiling under its cap passes", async () => {
  await assertWithinLimits(
    port({
      assistant_run_totals: {
        data: [{ user_today: 2, org_today: 5, org_month: 10, org_month_cost: 0 }],
        error: null,
      },
    }),
    baseConfig({ dailyUserLimit: 20, dailyOrgLimit: 50, monthlyOrgLimit: 500 }),
  );
});
