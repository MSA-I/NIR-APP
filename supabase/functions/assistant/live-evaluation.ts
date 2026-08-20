// Manual synthetic live-model evaluation. This file never reads Supabase and never carries
// tenant data. It also cannot create a provider until evaluation.ts's two explicit opt-ins,
// provider key and model are all present. It is not part of ordinary CI or feature activation.
import { z } from "zod";
import type { ActorContext, ToolEnvelope } from "../../../src/lib/assistant/contracts.ts";
import {
  ASSISTANT_EVALUATION_CORPUS,
  type AllowedAssistantEvaluationCase,
  runOptedInAssistantLiveEvaluation,
} from "./evaluation.ts";
import {
  buildInstructions,
  createOpenAiAssistantProvider,
  runAssistantTurn,
} from "./provider.ts";
import {
  buildRegistry,
  RunEvidence,
  type AssistantTool,
  type ToolContext,
} from "./tools/registry.ts";

const SYNTHETIC_ACTOR: ActorContext = {
  userId: "44444444-4444-4444-8444-444444444444",
  orgId: "11111111-1111-4111-8111-111111111111",
  role: "owner",
  scopes: [],
  canWrite: false,
  capabilities: {
    ui: true,
    history: false,
    drafts: false,
    confirmedActions: false,
  },
};

function syntheticTool(testCase: AllowedAssistantEvaluationCase): AssistantTool {
  return {
    name: "get_evaluation_evidence",
    description: "כלי הערכה סינתטי. יש לקרוא לו כדי לענות על שאלת ההערכה הנוכחית.",
    inputSchema: z.object({}).strict(),
    inputJsonSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    requiredRoles: ["owner"],
    classification: "financial_sensitive",
    async run(ctx): Promise<ToolEnvelope> {
      const fact = ctx.evidence.fact({
        kind: testCase.fact.kind,
        subject: testCase.fact.subject,
        label: testCase.fact.label,
        value: testCase.fact.value,
        unit: testCase.fact.unit,
        tool: "get_evaluation_evidence",
        as_of: testCase.fact.as_of,
        classification: testCase.fact.classification,
      });
      const source = ctx.evidence.source({
        entity: testCase.source.entity,
        entity_id: testCase.source.entity_id,
        label: testCase.source.label,
        route: testCase.source.route,
        classification: testCase.source.classification,
      });
      return {
        data: [],
        complete: true,
        failures: [],
        filters: { corpus_case: testCase.id },
        as_of: testCase.fact.as_of,
        result_count: 1,
        has_more: false,
        facts: [fact],
        sources: [source],
        warnings: [],
      };
    },
  };
}

async function executeSyntheticLiveEvaluation(
  apiKey: string,
  model: string,
): Promise<{ passed: number; total: number }> {
  const cases = ASSISTANT_EVALUATION_CORPUS.filter(
    (testCase): testCase is AllowedAssistantEvaluationCase => testCase.allowed,
  );
  let passed = 0;
  for (const testCase of cases) {
    const evidence = new RunEvidence();
    const registry = buildRegistry([syntheticTool(testCase)]);
    const toolContext: ToolContext = {
      actor: SYNTHETIC_ACTOR,
      evidence,
      now: () => new Date(testCase.fact.as_of),
      db: {
        rpc: () => Promise.resolve({ data: null, error: { message: "synthetic_only" } }),
        countSentOrders: () => Promise.resolve({ count: null, error: { message: "synthetic_only" } }),
      },
    };
    const provider = createOpenAiAssistantProvider({
      apiKey,
      model,
      maxOutputTokens: 2048,
      timeoutMs: 30_000,
      instructions: buildInstructions(),
      tools: [...registry.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputJsonSchema,
      })),
    });
    const outcome = await runAssistantTurn({
      provider,
      registry,
      toolContext,
      question: testCase.question,
      conversationContext: [],
      maxToolCalls: 1,
      totalBudgetMs: 60_000,
      authorizeEvidence: () => Promise.resolve({ ok: true }),
    });
    const expected = testCase.fact;
    const matched = outcome.answer.blocks.some((block) =>
      block.type === "claim" && block.claim_kind === expected.kind &&
      block.claim_unit === expected.unit && Object.is(block.claim_value, expected.value)
    );
    if (!matched) throw new Error(`assistant_live_evaluation_case_failed:${testCase.id}`);
    passed += 1;
  }
  return { passed, total: cases.length };
}

if (import.meta.main) {
  const result = await runOptedInAssistantLiveEvaluation(
    (name) => Deno.env.get(name),
    (config) => executeSyntheticLiveEvaluation(config.apiKey, config.model),
  );
  if (result.status === "skipped") {
    console.error("assistant_live_evaluation_skipped", result.reason);
    Deno.exit(2);
  }
  console.log(
    "assistant_live_evaluation_passed",
    String(result.value.passed),
    String(result.value.total),
  );
}
