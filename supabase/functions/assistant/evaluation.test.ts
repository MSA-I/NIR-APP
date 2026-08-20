import assert from "node:assert/strict";
import { AssistantRunResultSchema } from "../../../src/lib/assistant/contracts.ts";
import { classifyAssistantProviderText } from "./input-classification.ts";
import { validateAnswer } from "./validate.ts";
import {
  ASSISTANT_EVALUATION_CORPUS,
  resolveAssistantLiveEvaluationGate,
  runOptedInAssistantLiveEvaluation,
} from "./evaluation.ts";

Deno.test("the synthetic corpus is unique and passes the production classifiers and validators", () => {
  const ids = new Set<string>();
  for (const testCase of ASSISTANT_EVALUATION_CORPUS) {
    assert.ok(!ids.has(testCase.id), `duplicate corpus id ${testCase.id}`);
    ids.add(testCase.id);
    const classification = classifyAssistantProviderText(testCase.question);
    assert.equal(classification.allowed, testCase.allowed, testCase.id);
    assert.equal(classification.classification, testCase.expectedClassification, testCase.id);
    if (!testCase.allowed) continue;

    const validated = validateAnswer(
      testCase.expectedAnswer,
      [testCase.fact],
      [testCase.source],
      "owner",
    );
    assert.equal(validated.ok, true, testCase.id);
    const runtime = AssistantRunResultSchema.safeParse({
      run_id: "33333333-3333-4333-8333-333333333333",
      conversation_id: null,
      answer: testCase.expectedAnswer,
      facts: [testCase.fact],
      sources: [testCase.source],
      tools_used: [{ tool: "get_evaluation_evidence", complete: true }],
      complete: true,
      as_of: testCase.fact.as_of,
      proposal: null,
    });
    assert.equal(runtime.success, true, testCase.id);
  }
});

Deno.test("tampering with every allowed corpus claim is rejected", () => {
  for (const testCase of ASSISTANT_EVALUATION_CORPUS) {
    if (!testCase.allowed) continue;
    const first = testCase.expectedAnswer.blocks[0];
    assert.equal(first.type, "claim", testCase.id);
    if (first.type !== "claim") continue;
    const changedValue = typeof first.claim_value === "number"
      ? first.claim_value + 1
      : `${String(first.claim_value)}-changed`;
    const tampered = {
      ...testCase.expectedAnswer,
      blocks: [{ ...first, claim_value: changedValue }],
    };
    assert.equal(
      validateAnswer(tampered, [testCase.fact], [testCase.source], "owner").ok,
      false,
      testCase.id,
    );
  }
});

Deno.test("live evaluation cannot execute without both opt-in acknowledgements and credentials", async () => {
  const cases: Record<string, string>[] = [
    {},
    { AI_ASSISTANT_LIVE_EVALUATION: "1" },
    {
      AI_ASSISTANT_LIVE_EVALUATION: "1",
      AI_ASSISTANT_LIVE_EVALUATION_ACK: "synthetic-provider-spend",
    },
    {
      AI_ASSISTANT_LIVE_EVALUATION: "1",
      AI_ASSISTANT_LIVE_EVALUATION_ACK: "synthetic-provider-spend",
      AI_ASSISTANT_API_KEY: "test-only-key",
    },
  ];
  for (const values of cases) {
    let executions = 0;
    const result = await runOptedInAssistantLiveEvaluation(
      (name) => values[name],
      async () => {
        executions += 1;
        return "unexpected";
      },
    );
    assert.equal(result.status, "skipped");
    assert.equal(executions, 0);
  }
});

Deno.test("the fully explicit live gate invokes only the injected executor", async () => {
  const values: Record<string, string> = {
    AI_ASSISTANT_LIVE_EVALUATION: "1",
    AI_ASSISTANT_LIVE_EVALUATION_ACK: "synthetic-provider-spend",
    AI_ASSISTANT_API_KEY: "test-only-key",
    AI_ASSISTANT_MODEL: "test-only-model",
  };
  const gate = resolveAssistantLiveEvaluationGate((name) => values[name]);
  assert.equal(gate.ok, true);
  let executions = 0;
  const result = await runOptedInAssistantLiveEvaluation(
    (name) => values[name],
    async (config) => {
      executions += 1;
      assert.equal(config.model, "test-only-model");
      return { passed: 3 };
    },
  );
  assert.deepEqual(result, { status: "executed", value: { passed: 3 } });
  assert.equal(executions, 1);
});
