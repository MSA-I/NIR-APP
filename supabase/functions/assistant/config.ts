// Assistant runtime configuration. Every knob is an environment variable with a documented
// default, and every malformed value FAILS CLOSED: a knob that cannot be read refuses runs
// rather than guessing. The provider key is deliberately its own variable -- the assistant's
// provider configuration must be separable from document OCR/interpretation, so OPENAI_API_KEY
// is never consulted here.
//
// What is deliberately NOT here: a history-retention knob. Retention is owned by the database
// (a scheduled purge on the run tables), because an Edge variable can only stop NEW writes --
// it cannot expire what is already stored, and two owners for one policy is how the two drift.
//
// What IS here, and is not a knob: the provider-governance gate (#179). Incomplete governance
// evidence refuses through the same ConfigResult every malformed knob refuses through, so a
// boundary that starts without it cannot reach a provider at all. It is placed with the
// configuration on purpose -- governance is a precondition of having a provider, not a check
// somebody remembers to call before using one.
import {
  assertProviderGovernance,
  type ProviderGovernanceDecision,
  readPrelaunchException,
  readProviderGovernanceEvidence,
} from "./governance.ts";

/**
 * Prompt version, following interpret-document's PROMPT_VERSION convention: bump on ANY change
 * to the system prompt, the tool descriptions, or the answer schema handed to the provider, so a
 * quality regression can be attributed to a prompt rotation after the fact.
 *
 * Changelog:
 *   assistant-v1 (2026-08-20) -- first version. Hebrew answers, evidence-only quantities, tool
 *     results fenced as data, closed no-answer vocabulary.
 *   assistant-v2 (2026-08-20) -- values-only numerals: digits may never be copied out of labels
 *     or names; windows and scopes are described in words. Matches the validator ruling.
 */
// v3: the answer language follows the reader instead of being pinned to Hebrew
// (`OPEN-DECISIONS #283`). Any edit to `buildInstructions` is a bump here — the version is
// stamped on every recorded run, so a stored answer can be traced to the instruction that
// produced it.
export const ASSISTANT_PROMPT_VERSION = "assistant-v4";

// The egress lease and the budget that must never outlive it -- interpret-document's arithmetic,
// copied deliberately: total budget = lease TTL minus a settlement margin, and every provider
// attempt and tool call is clamped to what remains.
export const ASSISTANT_EGRESS_TTL_SECONDS = 120;
export const ASSISTANT_EGRESS_MARGIN_MS = 20_000;
export const ASSISTANT_TOTAL_BUDGET_MS = ASSISTANT_EGRESS_TTL_SECONDS * 1000 -
  ASSISTANT_EGRESS_MARGIN_MS;

export const ASSISTANT_PROVIDER_MAX_ATTEMPTS = 2;
export const ASSISTANT_RETRY_DELAY_MAX_MS = 5_000;
export const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
export const MAX_PROVIDER_OUTPUT_BYTES = 256 * 1024;

export interface AssistantConfig {
  /**
   * AI_ASSISTANT_PROVIDER -- default "openai". Any other value is a refusal, not a fallback.
   *
   * OpenAI is a GOVERNANCE decision, not a preference: OPEN-DECISIONS #124 pins the real
   * sub-processors named in /terms and /privacy (Supabase, OpenAI, Cloudflare, Resend, Sentry),
   * and TERMS_VERSION consent is server-enforced (0089). Switching or adding a model vendor is a
   * new sub-processor -- a consent-document change with a version bump, never a config change.
   */
  provider: "openai";
  /** AI_ASSISTANT_MODEL -- required. No default on purpose: a silently chosen model is spend
   * nobody approved. Unset refuses every run. */
  model: string;
  /** AI_ASSISTANT_FAST_MODEL -- default = model. Reserved for a cheaper triage pass; parsed and
   * validated now so enabling it later is a code change, not a config surprise. */
  fastModel: string;
  /** AI_ASSISTANT_MAX_OUTPUT_TOKENS -- default 4096, bounds 256..32768. */
  maxOutputTokens: number;
  /** AI_ASSISTANT_TIMEOUT_MS -- per provider attempt, default 30000, bounds 1000..90000. The
   * total across attempts and tool calls is still bounded by ASSISTANT_TOTAL_BUDGET_MS. */
  timeoutMs: number;
  /** AI_ASSISTANT_MAX_TOOL_CALLS_PER_TURN -- default 4, bounds 1..8. */
  maxToolCallsPerTurn: number;
  /** AI_ASSISTANT_DAILY_USER_LIMIT / _DAILY_ORG_LIMIT / _MONTHLY_ORG_LIMIT -- additional
   * ceilings ON TOP of the entitlement, never instead of it. Unset = no additional ceiling
   * (the entitlement still rules). A set ceiling that cannot be measured refuses. */
  dailyUserLimit: number | null;
  dailyOrgLimit: number | null;
  monthlyOrgLimit: number | null;
  /** AI_ASSISTANT_SOFT_COST_CAP / _HARD_COST_CAP -- monthly cost ceilings in the currency the
   * run rows record cost in. Soft logs, hard refuses. Unset = no cap. */
  softCostCap: number | null;
  hardCostCap: number | null;
  /** AI_ASSISTANT_CONTEXT_MESSAGE_LIMIT -- default 12, bounds 0..50. */
  contextMessageLimit: number;
  /**
   * The #179 decision, carried rather than discarded: parseAssistantConfig never returns a
   * config whose governance is anything but an allow, and the provider-construction site
   * revalidates these rows before a client exists. Keeping the evidence on the config is what
   * makes that second check possible without re-reading the environment.
   */
  governance: ProviderGovernanceDecision;
}

export type ConfigResult =
  | { ok: true; config: AssistantConfig }
  | { ok: false; reason: string };

type EnvReader = (name: string) => string | undefined;

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < min || value > max) return null;
  return value;
}

/** Optional non-negative number. `undefined` distinguishes "malformed" from "unset" (null). */
function optionalNumber(raw: string | undefined): number | null | undefined {
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value;
}

export function parseAssistantConfig(env: EnvReader): ConfigResult {
  const provider = (env("AI_ASSISTANT_PROVIDER") ?? "openai").trim();
  if (provider !== "openai") {
    return { ok: false, reason: "assistant_provider_unsupported" };
  }
  // Governance is decided BEFORE the model and the knobs, so an operator with incomplete
  // provider evidence is told that -- not that a model is unset. The rows are named in the
  // reason, which index.ts already logs verbatim on the refusal path.
  // A pre-launch exception that does not parse is reported, never read as "no exception". The
  // silent reading would refuse for the wrong reason and send an operator to look at the five
  // evidence rows, which are not what is broken.
  const exceptionRead = readPrelaunchException(env);
  if (exceptionRead.kind === "unparsable") {
    return { ok: false, reason: "assistant_prelaunch_exception_unparsable" };
  }
  const governance = assertProviderGovernance(
    readProviderGovernanceEvidence(env, provider),
    { exception: exceptionRead.kind === "valid" ? exceptionRead.exception : null },
  );
  if (!governance.allowed) return { ok: false, reason: governance.reason };

  const model = env("AI_ASSISTANT_MODEL")?.trim() ?? "";
  if (!model) return { ok: false, reason: "assistant_model_unset" };
  const fastModel = env("AI_ASSISTANT_FAST_MODEL")?.trim() || model;

  const maxOutputTokens = boundedInteger(
    env("AI_ASSISTANT_MAX_OUTPUT_TOKENS"),
    4096,
    256,
    32_768,
  );
  const timeoutMs = boundedInteger(
    env("AI_ASSISTANT_TIMEOUT_MS"),
    30_000,
    1_000,
    90_000,
  );
  const maxToolCallsPerTurn = boundedInteger(
    env("AI_ASSISTANT_MAX_TOOL_CALLS_PER_TURN"),
    4,
    1,
    8,
  );
  const contextMessageLimit = boundedInteger(
    env("AI_ASSISTANT_CONTEXT_MESSAGE_LIMIT"),
    12,
    0,
    50,
  );
  if (
    maxOutputTokens === null || timeoutMs === null ||
    maxToolCallsPerTurn === null || contextMessageLimit === null
  ) {
    return { ok: false, reason: "assistant_knob_malformed" };
  }

  const dailyUserLimit = optionalNumber(env("AI_ASSISTANT_DAILY_USER_LIMIT"));
  const dailyOrgLimit = optionalNumber(env("AI_ASSISTANT_DAILY_ORG_LIMIT"));
  const monthlyOrgLimit = optionalNumber(env("AI_ASSISTANT_MONTHLY_ORG_LIMIT"));
  const softCostCap = optionalNumber(env("AI_ASSISTANT_SOFT_COST_CAP"));
  const hardCostCap = optionalNumber(env("AI_ASSISTANT_HARD_COST_CAP"));
  if (
    dailyUserLimit === undefined || dailyOrgLimit === undefined ||
    monthlyOrgLimit === undefined || softCostCap === undefined ||
    hardCostCap === undefined
  ) {
    return { ok: false, reason: "assistant_cap_malformed" };
  }

  return {
    ok: true,
    config: {
      provider: "openai",
      model,
      fastModel,
      maxOutputTokens,
      timeoutMs,
      maxToolCallsPerTurn,
      dailyUserLimit,
      dailyOrgLimit,
      monthlyOrgLimit,
      softCostCap,
      hardCostCap,
      contextMessageLimit,
      governance,
    },
  };
}
