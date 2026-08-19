// Server-side identity, capability and limit resolution. Nothing in this module reads a value
// the browser sent: the org, the role, the scopes, the flags and the entitlements all come from
// RPCs executed under the caller's own JWT, so RLS and the auth_* functions decide -- the same
// discipline interpret-document applies to its actor.
import {
  ASSISTANT_FLAG_KEYS,
  ASSISTANT_ROLES,
  type ActorContext,
  type AssistantCapabilities,
  type AssistantRole,
} from "../../../src/lib/assistant/contracts.ts";
// ASSISTANT_ACTION_POLICY_KEY names the confirmed-actions policy; it is deliberately NOT read
// here -- see resolveCapabilities.
import type { AssistantConfig } from "./config.ts";
import { AssistantEdgeError } from "./errors.ts";

export interface RpcResult {
  data: unknown;
  error: { message: string } | null;
}

/** The one shape every resolver needs -- a supabase-js client satisfies it structurally. */
export interface RpcPort {
  rpc(
    name: string,
    args?: Record<string, unknown>,
  ): PromiseLike<RpcResult>;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRole(value: unknown): value is AssistantRole {
  return typeof value === "string" &&
    (ASSISTANT_ROLES as readonly string[]).includes(value);
}

/**
 * Flags fail CLOSED: an RPC failure, a missing definition row and an explicit `false` all read
 * as off. 0059's law -- a flag never grants a permission -- is preserved by resolving
 * entitlements separately below.
 */
export async function resolveCapabilities(
  caller: RpcPort,
): Promise<AssistantCapabilities> {
  const [flags, policy] = await Promise.all([
    caller.rpc("resolve_feature_flags"),
    // NOT a flag (contracts §2, ENTERPRISE-SECURITY-MODEL §8): the confirmed-actions switch is
    // the 0076-shape autonomy policy (ASSISTANT_ACTION_POLICY_KEY) -- baseline OFF held by a
    // CHECK, raised per organization only through platform_set_assistant_policy. Anything but
    // an explicit `true` from the policy read is off.
    caller.rpc("assistant_confirmed_actions_enabled"),
  ]);
  const states = new Map<string, boolean>();
  if (!flags.error && Array.isArray(flags.data)) {
    for (const row of flags.data) {
      if (!row || typeof row !== "object") continue;
      const { flag_key, state } = row as Record<string, unknown>;
      if (typeof flag_key === "string") states.set(flag_key, state === true);
    }
  }
  return {
    ui: states.get(ASSISTANT_FLAG_KEYS.ui) ?? false,
    history: states.get(ASSISTANT_FLAG_KEYS.history) ?? false,
    drafts: states.get(ASSISTANT_FLAG_KEYS.drafts) ?? false,
    confirmedActions: !policy.error && policy.data === true,
  };
}

/**
 * Identity from the server, never from the request body. auth_org()/auth_role() already refuse
 * suspended organizations and retired roles by returning null, so a null here is a refusal --
 * not a value to default.
 */
export async function resolveActorContext(
  caller: RpcPort,
  userId: string,
): Promise<ActorContext> {
  const [org, role, scopes, access] = await Promise.all([
    caller.rpc("auth_org"),
    caller.rpc("auth_role"),
    caller.rpc("auth_scopes"),
    caller.rpc("organization_access_state"),
  ]);
  if (org.error || role.error || scopes.error || access.error) {
    throw new AssistantEdgeError("assistant_provider_unavailable", 503);
  }
  if (typeof org.data !== "string" || !UUID.test(org.data)) {
    throw new AssistantEdgeError("assistant_disabled");
  }
  if (!isRole(role.data)) {
    throw new AssistantEdgeError("assistant_disabled");
  }
  const scopeIds = Array.isArray(scopes.data)
    ? scopes.data.filter((id): id is string =>
      typeof id === "string" && UUID.test(id)
    )
    : [];
  const accessRow = Array.isArray(access.data) ? access.data[0] : access.data;
  const accessMode = accessRow && typeof accessRow === "object"
    ? String((accessRow as Record<string, unknown>).access_mode ?? "")
    : "";
  const capabilities = await resolveCapabilities(caller);
  return {
    userId,
    orgId: org.data,
    role: role.data,
    scopes: scopeIds,
    // A read-only organization may still ask; it may not confirm actions. Absent or unknown
    // access mode reads as not-writable -- the closed default.
    canWrite: accessMode === "active",
    capabilities,
  };
}

/** The named refusals the enforcement door may raise, surfaced verbatim to the caller. */
const RUN_ALLOWED_REFUSALS = [
  "assistant_rate_limited",
  "assistant_limit_reached",
  "assistant_limit_unknown",
  "assistant_not_entitled",
  "assistant_unauthenticated",
] as const;

/**
 * The pre-spend enforcement door: public.assistant_assert_run_allowed() (0164) checks the volume
 * entitlement, the quota counter and the per-user rolling-hour rate limit
 * (ASSISTANT_ENTITLEMENTS.runsPerPeriod / ASSISTANT_RUNS_PER_USER_HOUR), all counted in Postgres
 * -- ENTERPRISE-SECURITY-MODEL §10: a per-instance counter is not a limit. Called BEFORE the
 * egress reservation, so a refused user costs no provider spend. The transactional backstop
 * stays inside assistant_record_run, which counts every run that actually happened.
 *
 * A door that cannot be reached is a refusal: an uncheckable limit is no limit.
 */
export async function assertRunAllowed(caller: RpcPort): Promise<void> {
  const result = await caller.rpc("assistant_assert_run_allowed");
  if (!result.error) return;
  const message = result.error.message;
  for (const code of RUN_ALLOWED_REFUSALS) {
    if (message.includes(code)) throw new AssistantEdgeError(code);
  }
  throw new AssistantEdgeError("assistant_provider_unavailable", 503);
}

/**
 * The env-var ceilings -- an ADDITIONAL ceiling on top of the database-enforced entitlement,
 * never instead of it. A cap that is set but cannot be measured refuses: assistant_run_totals()
 * reporting null for a capped dimension means nobody can say the cap holds.
 */
export async function assertWithinLimits(
  caller: RpcPort,
  config: AssistantConfig,
): Promise<void> {
  const capped = config.dailyUserLimit !== null ||
    config.dailyOrgLimit !== null || config.monthlyOrgLimit !== null ||
    config.hardCostCap !== null || config.softCostCap !== null;
  if (!capped) return;

  // assistant_run_totals() (0164) -- null for a dimension means "unmeasured".
  const totals = await caller.rpc("assistant_run_totals");
  const row = totals.error
    ? null
    : (Array.isArray(totals.data) ? totals.data[0] : totals.data) as
      | Record<string, unknown>
      | null;
  const measure = (key: string): number | null => {
    const value = row?.[key];
    if (value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  const ceilings: {
    cap: number | null;
    current: number | null;
    hard: boolean;
    name: string;
  }[] = [
    {
      cap: config.dailyUserLimit,
      current: measure("user_today"),
      hard: true,
      name: "daily_user",
    },
    {
      cap: config.dailyOrgLimit,
      current: measure("org_today"),
      hard: true,
      name: "daily_org",
    },
    {
      cap: config.monthlyOrgLimit,
      current: measure("org_month"),
      hard: true,
      name: "monthly_org",
    },
    {
      cap: config.hardCostCap,
      current: measure("org_month_cost"),
      hard: true,
      name: "hard_cost",
    },
    {
      cap: config.softCostCap,
      current: measure("org_month_cost"),
      hard: false,
      name: "soft_cost",
    },
  ];
  for (const ceiling of ceilings) {
    if (ceiling.cap === null) continue;
    if (ceiling.current === null) {
      if (ceiling.hard) {
        // A set ceiling nobody can measure. Fail closed rather than run unmetered.
        throw new AssistantEdgeError("assistant_limit_unknown");
      }
      console.error("assistant soft cap unmeasurable", ceiling.name);
      continue;
    }
    if (ceiling.current >= ceiling.cap) {
      if (ceiling.hard) {
        throw new AssistantEdgeError("assistant_limit_reached");
      }
      // Soft cap: observable, never a refusal. No tenant value on this line.
      console.error("assistant soft cost cap crossed", ceiling.name);
    }
  }
}
