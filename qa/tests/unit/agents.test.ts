import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createBlockedModelAdapter } from '../../agents/blocked-adapter.ts';
import { SafeBrowserActionSchema } from '../../agents/contracts.ts';
import { reviewAgentFinding } from '../../agents/finding-reviewer.ts';
import { QaModelBlockedError } from '../../agents/model-adapter.ts';
import { createOpenAiResponsesAdapter } from '../../agents/openai-responses-adapter.ts';

const stepInput = {
  runId: 'run-1',
  role: 'owner' as const,
  roleInstructions: 'Inspect only the allowed route.',
  scenario: {
    id: 'owner-payment-approval',
    name: 'Owner approval',
    objective: 'Inspect the visible state.',
    allowedRoutes: ['/payment-requests'],
    allowedFixtureNames: [],
    allowedVerificationChecks: ['database'],
    evidenceRequirements: ['screenshot'],
  },
  currentStep: 1,
  maxSteps: 10,
  remainingSteps: 9,
  maxRetries: 1,
  visibleUiSnapshot: {
    contentOrigin: 'untrusted-application-ui' as const,
    url: '/payment-requests',
    title: 'SupplyFlow',
    heading: 'דרישות תשלום',
    visibleText: 'אין דרישות',
    controls: [],
  },
  recentReceipts: [],
  availableBrowserActions: ['snapshot'],
};

describe('model boundary', () => {
  test('allows exactly one schema correction and returns validated output', async () => {
    const responses = [
      '{}',
      JSON.stringify({
        decision: 'finish',
        reason: 'The visible objective is complete.',
        action: null,
        expectedObservation: null,
        meaningfulBusinessAction: false,
        verification: null,
        observations: [],
        helpQuestion: null,
        finishStatus: 'completed',
        finishSummary: 'No mutation was attempted.',
      }),
    ];
    let calls = 0;
    const fetchImpl = async () => new Response(JSON.stringify({
      id: 'response-' + calls,
      status: 'completed',
      model: 'qa-model',
      output_text: responses[calls++] ?? '{}',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const adapter = createOpenAiResponsesAdapter({
      apiKey: 'test-key-not-real',
      model: 'qa-model',
      fetchImpl: fetchImpl as typeof fetch,
    });
    const result = await adapter.runRoleStep(stepInput);
    assert.equal(calls, 2);
    assert.equal(result.decision, 'finish');
    assert.equal(result.finishStatus, 'completed');
  });

  test('reports a missing provider as blocked instead of passing', async () => {
    const adapter = createBlockedModelAdapter('QA_MODEL_API_KEY is missing');
    assert.equal(adapter.availability.status, 'blocked');
    await assert.rejects(adapter.runRoleStep(stepInput), QaModelBlockedError);
  });

  test('rejects browser actions outside the constrained allowlist', () => {
    assert.equal(SafeBrowserActionSchema.safeParse({
      type: 'evaluate',
      route: null,
      targetId: null,
      value: null,
      fixtureName: null,
      key: null,
      direction: null,
      text: null,
      label: null,
    }).success, false);
  });
});

describe('agent finding review', () => {
  const observation = {
    title: 'The approval wording is unclear',
    category: 'usability' as const,
    severityHint: 'medium' as const,
    description: 'The visible wording does not identify the next state.',
    expected: 'A clear next-state explanation.',
    actual: 'Generic confirmation copy.',
    route: '/payment-requests',
    reproductionSteps: ['Open the request.'],
    evidenceRefs: ['screenshots/approval.png'],
    humanReviewRequired: true,
  };

  test('does not promote repeated model opinion to a confirmed high finding', () => {
    const reviewed = reviewAgentFinding({
      role: 'owner',
      scenarioId: 'owner-payment-approval',
      observation,
      repeatCount: 3,
      objectiveEvidence: [],
      blockedReason: null,
    });
    assert.equal(reviewed.status, 'probable');
    assert.equal(reviewed.severity, 'medium');
  });

  test('requires independent verified evidence for confirmation', () => {
    const reviewed = reviewAgentFinding({
      role: 'owner',
      scenarioId: 'owner-payment-approval',
      observation,
      repeatCount: 1,
      objectiveEvidence: [{
        id: 'axe-1',
        source: 'accessibility',
        verified: true,
        supportsObservation: true,
        summary: 'Independent deterministic evidence.',
        severity: 'high',
        evidenceRefs: ['axe/result.json'],
      }],
      blockedReason: null,
    });
    assert.equal(reviewed.status, 'confirmed');
    assert.equal(reviewed.severity, 'high');
  });
});
