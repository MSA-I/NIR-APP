// assistant -- the InPlace Assistant's server boundary. The ONLY path between a browser and a
// model provider: identity, flags and limits are resolved server-side, tools run under the
// caller's own JWT, the provider call runs under a database egress reservation, and nothing
// reaches the browser that post-generation validation did not verify.
//
// verify_jwt is TRUE in config.toml. Every function in this repo that sets false has a concrete
// reason -- an anonymous door (public-signup), a worker with a shared secret (document-processing,
// outbox-worker, send-push), a hashed export token on GET (tenant-export), or a cron path beside
// browser calls (interpret-document). The assistant has none of those: its only caller is a
// signed-in browser, so the platform rejects an unauthenticated request before this handler runs.
// The in-handler getUser()/auth_*() resolution below is DEFENCE IN DEPTH, not a substitute -- the
// handler still refuses any token it did not verify itself, and identity, flags, entitlements and
// limits are all decided here, in one audited place.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  AssistantAskRequestSchema,
  type AssistantRunResult,
  type Fact,
  type SourceReference,
} from "../../../src/lib/assistant/contracts.ts";
import {
  assertRunAllowed,
  assertWithinLimits,
  resolveActorContext,
} from "./auth.ts";
import {
  ASSISTANT_EGRESS_TTL_SECONDS,
  ASSISTANT_PROMPT_VERSION,
  ASSISTANT_TOTAL_BUDGET_MS,
  parseAssistantConfig,
} from "./config.ts";
import {
  EgressReservationDeniedError,
  runAssistantEgress,
  type ServiceRpc,
  type ServiceRpcResult,
} from "./egress.ts";
import { AssistantEdgeError, corsFor, fail, json } from "./errors.ts";
import {
  type AssistantTurnOutcome,
  buildInstructions,
  type ConversationMessage,
  createOpenAiAssistantProvider,
  type ProviderUsageTotals,
  runAssistantTurn,
  type ToolCallRecord,
} from "./provider.ts";
import { getBusinessSummaryTool } from "./tools/business-summary.ts";
import { deterministicBusinessTools } from "./tools/business.ts";
import { getOpenAlertsTool } from "./tools/open-alerts.ts";
import {
  createSupabaseToolReads,
  type MinimalReadClient,
} from "./tools/reads.ts";
import { buildRegistry, RunEvidence } from "./tools/registry.ts";

const REGISTRY = buildRegistry([
  getBusinessSummaryTool,
  getOpenAlertsTool,
  ...deterministicBusinessTools,
]);

function serviceRpc(admin: SupabaseClient): ServiceRpc {
  return (name, args) =>
    admin.rpc(name, args) as unknown as PromiseLike<ServiceRpcResult>;
}

async function loadConversationContext(
  caller: SupabaseClient,
  conversationId: string,
  limit: number,
): Promise<ConversationMessage[]> {
  if (limit === 0) return [];
  // assistant_conversation_context: the caller's own conversation, newest-last, bounded.
  // Ownership is decided by the RPC under the caller's JWT -- never by trusting the id.
  const result = await caller.rpc("assistant_conversation_context", {
    p_conversation_id: conversationId,
    p_limit: limit,
  });
  if (result.error) {
    throw new AssistantEdgeError("assistant_history_unavailable");
  }
  const rows = Array.isArray(result.data) ? result.data : [];
  const messages: ConversationMessage[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    // 0164's column is `author`; content is the question for user rows and the stored
    // AssistantAnswer JSON for assistant rows -- our own previously validated output.
    const { author, content } = row as Record<string, unknown>;
    if (
      (author === "user" || author === "assistant") &&
      typeof content === "string" && content.length > 0
    ) {
      messages.push({ role: author, content });
    }
  }
  return messages;
}

interface RecordRunValues {
  runId: string;
  conversationId: string | null;
  storeHistory: boolean;
  question: string;
  answer: unknown | null;
  status: "succeeded" | "refused" | "failed";
  errorCode: string | null;
  model: string | null;
  usage: ProviderUsageTotals;
  latencyMs: number;
  complete: boolean;
  toolRecords: ToolCallRecord[];
  facts: Fact[];
  sources: SourceReference[];
}

/**
 * One transactional call (assistant_record_run, 0164): conversation, messages, run row, tool
 * shapes, facts, sources, the usage event and the audit row. The run uuid is generated here and
 * is the idempotency key -- a retried call returns idempotent:true and moves nothing. Recording
 * never refuses on quota: refusing to record a run that happened would undercount, so a bounded
 * overshoot of one run under concurrency is accepted (the 0162 trade).
 */
async function recordRun(
  caller: SupabaseClient,
  values: RecordRunValues,
): Promise<{ conversationId: string | null }> {
  const recorded = await caller.rpc("assistant_record_run", {
    p_run_id: values.runId,
    p_conversation_id: values.conversationId,
    p_store_history: values.storeHistory,
    p_question: values.question,
    p_answer: values.answer,
    p_status: values.status,
    p_error_code: values.errorCode,
    p_model: values.model,
    p_prompt_version: ASSISTANT_PROMPT_VERSION,
    p_input_tokens: values.usage.input_tokens,
    p_output_tokens: values.usage.output_tokens,
    // Cost has no price source yet -- null is "not measured", never zero.
    p_cost_micros: null,
    p_latency_ms: values.latencyMs,
    p_complete: values.complete,
    p_tool_calls: values.toolRecords,
    p_facts: values.facts,
    p_sources: values.sources,
    p_proposal: null,
  });
  if (recorded.error) {
    const message = recorded.error.message;
    console.error("assistant_record_run failed", values.runId);
    if (message.includes("assistant_read_only_organization")) {
      throw new AssistantEdgeError("assistant_read_only_organization");
    }
    if (message.includes("assistant_history_unavailable")) {
      throw new AssistantEdgeError("assistant_history_unavailable");
    }
    if (message.includes("assistant_question_too_long")) {
      throw new AssistantEdgeError("assistant_question_too_long");
    }
    if (message.includes("assistant_unauthenticated")) {
      throw new AssistantEdgeError("assistant_unauthenticated");
    }
    // The write-time quota backstop (0164 enforces the counter inside this same transaction).
    // Racing past the pre-spend door and losing here still FAILS the turn -- nothing was stored,
    // the counter did not move, and the named refusal is more truthful than a generic failure.
    if (message.includes("assistant_rate_limited")) {
      throw new AssistantEdgeError("assistant_rate_limited");
    }
    if (message.includes("assistant_limit_reached")) {
      throw new AssistantEdgeError("assistant_limit_reached");
    }
    if (message.includes("assistant_limit_unknown")) {
      throw new AssistantEdgeError("assistant_limit_unknown");
    }
    // Internal refusals that must never reach a browser as themselves: a malformed payload is OUR
    // bug (assistant_run_payload_invalid / assistant_invalid_request from the RPC's own checks),
    // and `not_authorized` is a cross-tenant run-id collision that must stay indistinguishable
    // from any other failure -- no oracle.
    if (
      message.includes("assistant_run_payload_invalid") ||
      message.includes("not_authorized")
    ) {
      throw new AssistantEdgeError("assistant_tool_failed");
    }
    // A run whose counter did not move is a run that escaped the quota it was measured against --
    // reporting success here would let a tenant outrun their own limit. Fail the turn.
    throw new AssistantEdgeError("assistant_persistence_failed");
  }
  const row = recorded.data && typeof recorded.data === "object"
    ? recorded.data as Record<string, unknown>
    : {};
  return {
    conversationId: typeof row.conversation_id === "string"
      ? row.conversation_id
      : null,
  };
}

export async function handler(req: Request): Promise<Response> {
  const cors = corsFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") {
    return fail(cors, new AssistantEdgeError("assistant_invalid_request"));
  }

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const providerKey = Deno.env.get("AI_ASSISTANT_API_KEY");
  const parsedConfig = parseAssistantConfig((name) => Deno.env.get(name));
  if (!url || !anonKey || !serviceKey || !providerKey || !parsedConfig.ok) {
    // The reason names the knob class, never a value; a misconfigured cap must be visible to an
    // operator without leaking anything tenant-shaped.
    console.error(
      "assistant configuration refused",
      parsedConfig.ok ? "env_missing" : parsedConfig.reason,
    );
    return fail(
      cors,
      new AssistantEdgeError("assistant_provider_unavailable", 503),
    );
  }
  const config = parsedConfig.config;

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return fail(cors, new AssistantEdgeError("assistant_unauthenticated"));
  }
  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const userResult = await caller.auth.getUser();
  if (userResult.error || !userResult.data.user) {
    return fail(cors, new AssistantEdgeError("assistant_unauthenticated"));
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail(cors, new AssistantEdgeError("assistant_invalid_request"));
  }
  const parsedRequest = AssistantAskRequestSchema.safeParse(rawBody);
  if (!parsedRequest.success) {
    const tooLong = parsedRequest.error.issues.some((issue) =>
      issue.path[0] === "question" && issue.code === "too_big"
    );
    return fail(
      cors,
      new AssistantEdgeError(
        tooLong ? "assistant_question_too_long" : "assistant_invalid_request",
      ),
    );
  }
  const request = parsedRequest.data;

  try {
    const actor = await resolveActorContext(caller, userResult.data.user.id);
    if (!actor.capabilities.ui) {
      throw new AssistantEdgeError("assistant_disabled");
    }
    // The pre-spend enforcement door (0164): entitlement, quota and the per-user hourly rate
    // limit, counted in Postgres. Refused here means no provider spend at all. The env caps are
    // an additional ceiling on top, never instead.
    await assertRunAllowed(caller);
    await assertWithinLimits(caller, config);

    // History off means the conversation id is context the product refuses to have: run
    // normally, persist nothing but the run row (0164), remember nothing.
    const conversationId = actor.capabilities.history
      ? request.conversation_id
      : null;
    const conversationContext = conversationId
      ? await loadConversationContext(
        caller,
        conversationId,
        config.contextMessageLimit,
      )
      : [];

    const runId = crypto.randomUUID();
    const evidence = new RunEvidence();
    const toolContext = {
      // The caller-bound client satisfies MinimalReadClient structurally; every tool read runs
      // under the caller's JWT with explicit column projections (reads.ts), so RLS applies and
      // bank_details is never selected.
      db: createSupabaseToolReads(caller as unknown as MinimalReadClient),
      actor,
      evidence,
      now: () => new Date(),
    };
    const provider = createOpenAiAssistantProvider({
      apiKey: providerKey,
      model: config.model,
      maxOutputTokens: config.maxOutputTokens,
      timeoutMs: config.timeoutMs,
      instructions: buildInstructions(),
      tools: [...REGISTRY.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputJsonSchema,
      })),
    });

    // service_role exists in this function for exactly one purpose: the egress reservation RPCs
    // are granted to service_role alone. Every tenant business read and write runs through
    // `caller`.
    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false },
    });
    const rpc = serviceRpc(admin);

    const startedAt = performance.now();
    let outcome: AssistantTurnOutcome;
    try {
      outcome = await runAssistantEgress(
        rpc,
        {
          orgId: actor.orgId,
          runId,
          ttlSeconds: ASSISTANT_EGRESS_TTL_SECONDS,
        },
        () =>
          runAssistantTurn({
            provider,
            registry: REGISTRY,
            toolContext,
            question: request.question,
            conversationContext,
            maxToolCalls: config.maxToolCallsPerTurn,
            totalBudgetMs: ASSISTANT_TOTAL_BUDGET_MS,
          }),
        (settled) => ({
          code: settled.ok
            ? "assistant_run_recorded"
            : (settled.error instanceof AssistantEdgeError
              ? settled.error.code
              : "assistant_run_failed"),
          // Evidence carries versions and counters -- never the question, the answer text or a
          // fact value. Content is owned by the history tables, not the egress ledger.
          body: {
            run_id: runId,
            prompt_version: ASSISTANT_PROMPT_VERSION,
            model: settled.ok ? settled.result.model : null,
            usage: settled.ok ? settled.result.usage : null,
            tools: settled.ok
              ? settled.result.toolsUsed.map((tool) => tool.tool)
              : [],
            duration_ms: Math.max(
              0,
              Math.round(performance.now() - startedAt),
            ),
          },
        }),
      );
    } catch (error) {
      if (error instanceof EgressReservationDeniedError) {
        // A suspended, read-only or offboarding organization never reaches the provider. The
        // reservation cannot say which; the umbrella refusal is deliberate.
        throw new AssistantEdgeError("assistant_disabled");
      }
      // Provider spend may have happened. Runs are counted for EVERY status (0164) -- succeeded,
      // refused, failed -- so record the failed run; whether a failed run is ever refunded is an
      // owner decision, not this handler's. A failure to record a failure is logged, never
      // allowed to mask the original error.
      const edgeError = error instanceof AssistantEdgeError
        ? error
        : new AssistantEdgeError("assistant_provider_unavailable", 503);
      try {
        await recordRun(caller, {
          runId,
          conversationId,
          storeHistory: actor.capabilities.history,
          question: request.question,
          answer: null,
          status: edgeError.code === "assistant_unsupported_answer"
            ? "refused"
            : "failed",
          errorCode: edgeError.code,
          model: null,
          usage: { input_tokens: null, output_tokens: null, total_tokens: null },
          latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
          complete: false,
          toolRecords: [],
          facts: [],
          sources: [],
        });
      } catch {
        console.error("assistant failed-run recording skipped", runId);
      }
      throw edgeError;
    }
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt));

    const persisted = await recordRun(caller, {
      runId,
      conversationId,
      storeHistory: actor.capabilities.history,
      question: request.question,
      answer: outcome.answer,
      status: "succeeded",
      errorCode: null,
      model: outcome.model,
      usage: outcome.usage,
      latencyMs: durationMs,
      complete: outcome.toolsUsed.every((tool) => tool.complete),
      toolRecords: outcome.toolRecords,
      facts: evidence.facts,
      sources: evidence.sources,
    });

    // Allowlisted observability: ids, counters and versions. Never the question, never a value.
    console.log(
      "assistant run",
      runId,
      outcome.model,
      ASSISTANT_PROMPT_VERSION,
      String(outcome.toolsUsed.length),
      String(outcome.usage.total_tokens ?? ""),
      String(durationMs),
      outcome.validationRetried ? "revalidated" : "clean",
    );

    const result: AssistantRunResult = {
      run_id: runId,
      conversation_id: actor.capabilities.history
        ? persisted.conversationId
        : null,
      answer: outcome.answer,
      facts: evidence.facts,
      sources: evidence.sources,
      tools_used: outcome.toolsUsed,
      complete: outcome.toolsUsed.every((tool) => tool.complete),
      as_of: new Date().toISOString(),
      proposal: null,
    };
    return json(cors, result, 200);
  } catch (error) {
    const edgeError = error instanceof AssistantEdgeError
      ? error
      : new AssistantEdgeError("assistant_provider_unavailable", 503);
    console.error("assistant failed", edgeError.code);
    return fail(cors, edgeError);
  }
}

if (import.meta.main) {
  Deno.serve(handler);
}
