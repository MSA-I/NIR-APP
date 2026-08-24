import assert from "node:assert/strict";
import {
  ASSISTANT_DRAFT_ROLES,
  AssistantRunResultSchema,
} from "../../../src/lib/assistant/contracts.ts";
import { classifyAssistantProviderText } from "./input-classification.ts";
import { validateAnswer } from "./validate.ts";
import {
  ASSISTANT_EVALUATION_CORPUS,
  ASSISTANT_OFFLINE_ANSWER_CORPUS,
  resolveAssistantLiveEvaluationGate,
  runOptedInAssistantLiveEvaluation,
} from "./evaluation.ts";

const RUN_ID = "33333333-3333-4333-8333-333333333333";
// The role live-evaluation.ts's SYNTHETIC_ACTOR resolves to. The allowed corpus is validated
// against exactly that role, so an offline pass and a live pass are asking the same question.
const LIVE_HARNESS_ROLE = "owner" as const;

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
      LIVE_HARNESS_ROLE,
    );
    assert.equal(validated.ok, true, testCase.id);
    const runtime = AssistantRunResultSchema.safeParse({
      run_id: RUN_ID,
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

Deno.test("every allowed corpus row is shaped for the live harness that will drive it", () => {
  for (const testCase of ASSISTANT_EVALUATION_CORPUS) {
    if (!testCase.allowed) continue;
    // live-evaluation.ts issues exactly one fact and one source and then requires a claim block
    // repeating that fact. A row that cannot satisfy that belongs in the offline corpus, not here.
    const matching = testCase.expectedAnswer.blocks.filter((block) =>
      block.type === "claim" && block.claim_kind === testCase.fact.kind &&
      block.claim_unit === testCase.fact.unit &&
      Object.is(block.claim_value, testCase.fact.value)
    );
    assert.equal(matching.length >= 1, true, testCase.id);
    assert.equal(
      testCase.expectedAnswer.blocks.some((block) => block.type === "draft"),
      false,
      `${testCase.id} carries a draft and must move to the offline corpus`,
    );
  }
});

Deno.test("tampering with every allowed corpus claim is rejected", () => {
  for (const testCase of ASSISTANT_EVALUATION_CORPUS) {
    if (!testCase.allowed) continue;
    const index = testCase.expectedAnswer.blocks.findIndex((block) => block.type === "claim");
    assert.notEqual(index, -1, testCase.id);
    const claim = testCase.expectedAnswer.blocks[index];
    if (claim.type !== "claim") continue;
    const changedValue = typeof claim.claim_value === "number"
      ? claim.claim_value + 1
      : `${String(claim.claim_value)}-changed`;
    const blocks = [...testCase.expectedAnswer.blocks];
    blocks[index] = { ...claim, claim_value: changedValue };
    assert.equal(
      validateAnswer(
        { ...testCase.expectedAnswer, blocks },
        [testCase.fact],
        [testCase.source],
        LIVE_HARNESS_ROLE,
      ).ok,
      false,
      testCase.id,
    );
  }
});

/* ============================================================================
 * Offline-only answer shapes
 * ==========================================================================*/

Deno.test("the offline corpus is unique, classified, and valid under its own role", () => {
  const live = new Set(ASSISTANT_EVALUATION_CORPUS.map((testCase) => testCase.id));
  const ids = new Set<string>();
  for (const testCase of ASSISTANT_OFFLINE_ANSWER_CORPUS) {
    assert.ok(!ids.has(testCase.id), `duplicate offline id ${testCase.id}`);
    assert.ok(!live.has(testCase.id), `${testCase.id} exists in both corpora`);
    ids.add(testCase.id);
    assert.ok(testCase.offlineReason.length > 0, testCase.id);

    const classification = classifyAssistantProviderText(testCase.question);
    assert.equal(classification.allowed, true, testCase.id);
    assert.equal(classification.classification, testCase.expectedClassification, testCase.id);

    const validated = validateAnswer(
      testCase.expectedAnswer,
      testCase.facts,
      testCase.sources,
      testCase.role,
    );
    assert.equal(validated.ok, true, `${testCase.id}: ${JSON.stringify(validated)}`);

    // A reason means the run could not answer in full, and `complete` has to agree with it.
    const complete = testCase.expectedAnswer.no_answer_reason === null;
    const runtime = AssistantRunResultSchema.safeParse({
      run_id: RUN_ID,
      conversation_id: null,
      answer: testCase.expectedAnswer,
      facts: testCase.facts,
      sources: testCase.sources,
      tools_used: [{ tool: "get_evaluation_evidence", complete }],
      complete,
      as_of: testCase.facts[0]?.as_of ?? "2026-08-20T10:00:00.000Z",
      proposal: null,
    });
    assert.equal(runtime.success, true, testCase.id);
  }
});

Deno.test("the offline corpus covers a draft, a role refusal and an unanswerable question", () => {
  const byId = new Map(ASSISTANT_OFFLINE_ANSWER_CORPUS.map((testCase) => [testCase.id, testCase]));
  const draft = byId.get("supplier_reminder_draft");
  assert.ok(draft);
  assert.ok(ASSISTANT_DRAFT_ROLES.includes(draft.role));
  assert.equal(draft.expectedAnswer.blocks[0].type, "draft");
  // Nothing in this product sends, so no corpus row may say otherwise -- in any locale.
  for (const testCase of ASSISTANT_OFFLINE_ANSWER_CORPUS) {
    for (const block of testCase.expectedAnswer.blocks) {
      assert.equal(block.text.includes("נשלח"), false, testCase.id);
    }
  }
  const reasons = ASSISTANT_OFFLINE_ANSWER_CORPUS
    .map((testCase) => testCase.expectedAnswer.no_answer_reason)
    .filter((reason) => reason !== null);
  assert.deepEqual([...reasons].sort(), ["no_capability", "not_permitted"]);
});

Deno.test("the offline refusals are refusals, not silent all-clears", () => {
  for (const testCase of ASSISTANT_OFFLINE_ANSWER_CORPUS) {
    if (testCase.expectedAnswer.no_answer_reason === null) continue;
    // No evidence, no claim, and a NAMED reason. Prose alone must never read as "nothing to report".
    assert.deepEqual(testCase.facts, [], testCase.id);
    assert.equal(
      testCase.expectedAnswer.blocks.every((block) => block.type === "text"),
      true,
      testCase.id,
    );
  }
});

Deno.test("a draft is refused for the role #191 excludes, however well cited it is", () => {
  const draft = ASSISTANT_OFFLINE_ANSWER_CORPUS.find((testCase) =>
    testCase.id === "supplier_reminder_draft"
  );
  assert.ok(draft);
  const refused = validateAnswer(
    draft.expectedAnswer,
    draft.facts,
    draft.sources,
    "accountant",
  );
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok && refused.errors.some((error) => error.includes("draft_not_permitted")));

  // And an invented number inside the body is refused for the permitted role too.
  const tampered = {
    ...draft.expectedAnswer,
    blocks: [{
      ...draft.expectedAnswer.blocks[0],
      text: "שלום, נשמח לעדכון על מועד האספקה של הזמנה 1042. ההזמנה מתעכבת 30 ימים.",
    }],
  };
  const invented = validateAnswer(tampered, draft.facts, draft.sources, draft.role);
  assert.equal(invented.ok, false);
  assert.ok(
    !invented.ok && invented.errors.some((error) => error.includes("numeral_without_fact:30")),
  );
});

/* ============================================================================
 * The live spend gate
 * ==========================================================================*/

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
