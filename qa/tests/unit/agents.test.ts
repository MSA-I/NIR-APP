import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createBlockedModelAdapter } from '../../agents/blocked-adapter.ts';
import { createAgentScenarioContext, SafeBrowserActionSchema } from '../../agents/contracts.ts';
import { reviewAgentFinding } from '../../agents/finding-reviewer.ts';
import { QaModelBlockedError } from '../../agents/model-adapter.ts';
import { createOpenAiResponsesAdapter } from '../../agents/openai-responses-adapter.ts';
import { DEFAULT_CROSS_ROLE_ORDER } from '../../agents/orchestrator.ts';
import { blockedRoleRunResult, classifyRoleRunBlocker } from '../../agents/role-agent.ts';
import type { BrowserMutationNetworkEvidence } from '../../browser/browser-tools.ts';
import { QA_ROLES } from '../../config/roles.ts';
import {
  agentRunExitCode,
  buildMonthlyPaymentExportExpectation,
  classifyAgentOrchestrationOutcome,
  evaluateAgentMutationNetworkOutcome,
  evaluateAgentMutationStepEvidenceContract,
  evaluateActionAuditWindow,
  isAllowedAgentMutationEndpoint,
  mergeAgentOrchestrationOutcomes,
  ROLE_SCENARIOS,
  trustedCrossRoleHandoffCheck,
  trustedMeaningfulExpectations,
  verifierFailureIsProduct,
} from '../../runner/agent-runner.ts';
import { getScenario } from '../../scenarios/index.ts';

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
    steps: [{
      id: 'inspect-payment-request',
      route: '/payment-requests',
      action: 'Inspect the visible request.',
      expected: 'The request is tenant scoped.',
      mutatesData: false,
      verifierIds: ['database'],
    }],
    completedStepIds: [],
    pendingMutationStepId: null,
    pendingVerificationStepId: null,
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
    labeledControls: [],
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

  test('allows filling a visible numeric spinbutton', () => {
    assert.equal(SafeBrowserActionSchema.safeParse({
      type: 'fill',
      route: null,
      target: {
        kind: 'role',
        role: 'spinbutton',
        name: 'כמות שהתקבלה עבור עגבניות',
        label: null,
        text: null,
        exact: true,
      },
      value: '2',
      fixtureName: null,
      key: null,
      direction: null,
      text: null,
      label: null,
    }).success, true);
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

describe('trusted cross-role handoff contract', () => {
  const requestId = '11000000-0000-4000-8000-000000000001';
  const invoiceId = '22000000-0000-4000-8000-000000000002';
  const paymentId = '33000000-0000-4000-8000-000000000003';
  const actorUserId = '44000000-0000-4000-8000-000000000004';
  const bankTransactionId = '66000000-0000-4000-8000-000000000006';
  const createdAfter = '2026-08-04T10:00:00.000Z';
  const trusted = new Map([
    ['office:payment_request', requestId],
    ['owner:payment_request', requestId],
    ['office:invoice', invoiceId],
    ['payer:payment', paymentId],
    ['accountant:bank_transaction', bankTransactionId],
  ]);

  test('payer and accountant must target the exact upstream entities', () => {
    assert.equal(trustedCrossRoleHandoffCheck('payer', 'execute-transfer', [
      { kind: 'payment_request', visibleReference: requestId },
      { kind: 'invoice', visibleReference: invoiceId },
      { kind: 'payment', visibleReference: paymentId },
    ], trusted)?.status, 'PASS');
    assert.equal(trustedCrossRoleHandoffCheck('payer', 'execute-transfer', [
      { kind: 'payment_request', visibleReference: '55000000-0000-4000-8000-000000000005' },
      { kind: 'invoice', visibleReference: invoiceId },
      { kind: 'payment', visibleReference: paymentId },
    ], trusted)?.status, 'BLOCKED');
    assert.equal(trustedCrossRoleHandoffCheck('accountant', 'match-bank-payment', [
      { kind: 'bank_transaction', visibleReference: bankTransactionId },
      { kind: 'payment', visibleReference: paymentId },
      { kind: 'invoice', visibleReference: invoiceId },
    ], trusted)?.status, 'PASS');
    assert.equal(trustedCrossRoleHandoffCheck('accountant', 'match-bank-payment', [
      { kind: 'bank_transaction', visibleReference: '77000000-0000-4000-8000-000000000007' },
      { kind: 'payment', visibleReference: paymentId },
      { kind: 'invoice', visibleReference: invoiceId },
    ], trusted)?.status, 'BLOCKED');
  });

  test('office payment request expectation binds the verified invoice id', () => {
    const expectations = trustedMeaningfulExpectations(
      'office',
      [{ kind: 'payment_request', visibleReference: requestId }],
      actorUserId,
      createdAfter,
      'request-payment',
      trusted,
    );
    assert.ok(expectations);
    assert.deepEqual(expectations.database[2]?.expectedSubsets, [{
      org_id: '11111111-1111-4111-8111-111111111111',
      payment_request_id: requestId,
      invoice_id: invoiceId,
    }]);
  });
});

describe('trusted document mutation contract', () => {
  const documentId = 'dd000000-0000-4000-8000-000000000001';
  const actorUserId = 'aa000000-0000-4000-8000-000000000099';
  const createdAfter = '2026-08-04T10:00:00.000Z';

  test('requires one exact actor-bound enqueue audit in addition to the document row and integrity checks', () => {
    const expectations = trustedMeaningfulExpectations(
      'supplier',
      [{ kind: 'document', visibleReference: documentId }],
      actorUserId,
      createdAfter,
    );

    assert.ok(expectations);
    assert.equal(expectations.database.length, 1);
    assert.equal(expectations.database[0]?.table, 'documents');
    assert.equal(expectations.database[0]?.expectedCount, 1);
    assert.deepEqual(expectations.database[0]?.expectedSubsets, [{
      id: documentId,
      org_id: '11111111-1111-4111-8111-111111111111',
      uploaded_by: actorUserId,
      deleted_at: null,
      entity_type: 'supplier',
      entity_id: 'aa000000-0000-4000-8000-000000000001',
      supplier_id: 'aa000000-0000-4000-8000-000000000001',
    }]);
    assert.deepEqual(expectations.integrity.entities, [{
      id: 'agent-supplier-document-owner-integrity',
      table: 'documents',
      rowId: documentId,
      orgId: '11111111-1111-4111-8111-111111111111',
      expectedFields: {
        entity_type: 'supplier',
        entity_id: 'aa000000-0000-4000-8000-000000000001',
        supplier_id: 'aa000000-0000-4000-8000-000000000001',
        uploaded_by: actorUserId,
        deleted_at: null,
      },
    }]);
    assert.deepEqual(expectations.integrity.documents, [{
      id: 'agent-supplier-document-integrity',
      documentId,
      orgId: '11111111-1111-4111-8111-111111111111',
      expectedDeleted: false,
    }]);
    assert.equal(expectations.audit.length, 1);
    assert.deepEqual(expectations.audit[0], {
      id: 'agent-supplier-document-processing-audit',
      orgId: '11111111-1111-4111-8111-111111111111',
      action: 'document_processing_enqueued',
      entityType: 'document_processing_jobs',
      actorUserId,
      createdAfter,
      reasonRequired: true,
      exactCount: 1,
    });
    assert.deepEqual(expectations.auditWindow?.map(({ action, entityType, exactCount }) => ({
      action,
      entityType,
      exactCount,
    })), [{
      action: 'insert',
      entityType: 'documents',
      exactCount: 1,
    }, {
      action: 'document_processing_enqueued',
      entityType: 'document_processing_jobs',
      exactCount: 1,
    }]);
    assert.equal(trustedMeaningfulExpectations(
      'payer',
      [{ kind: 'document', visibleReference: documentId }],
      actorUserId,
      createdAfter,
    ), null);
  });

  test('requires one historical submission audit but zero new audit events for idempotent replay', () => {
    const expectations = trustedMeaningfulExpectations(
      'supplier',
      [{ kind: 'supplier_price_submission', visibleReference: documentId }],
      actorUserId,
      createdAfter,
      'replay-price-workbook',
    );
    assert.ok(expectations);
    assert.equal(expectations.audit.length, 1);
    assert.equal(expectations.audit[0]?.createdAfter, createdAfter);
    assert.equal(expectations.audit[0]?.exactCount, 1);
    assert.deepEqual(expectations.auditWindow, []);
  });

  test('binds a kitchen document to the goods-receipt entity type', () => {
    const expectations = trustedMeaningfulExpectations(
      'kitchen',
      [{ kind: 'document', visibleReference: documentId }],
      actorUserId,
      createdAfter,
      'attach-receipt-document',
    );
    assert.ok(expectations);
    assert.deepEqual(expectations.database[0]?.expectedSubsets, [{
      id: documentId,
      org_id: '11111111-1111-4111-8111-111111111111',
      uploaded_by: actorUserId,
      deleted_at: null,
      entity_type: 'goods_receipt',
    }]);
    assert.equal(
      expectations.integrity.entities?.[0]?.expectedFields?.entity_type,
      'goods_receipt',
    );
  });

  test('allows only POST requests to role-specific document mutation endpoints', () => {
    assert.equal(isAllowedAgentMutationEndpoint(
      'supplier',
      'POST',
      '/rest/v1/rpc/register_supplier_price_document',
    ), true);
    assert.equal(isAllowedAgentMutationEndpoint(
      'supplier',
      'POST',
      '/rest/v1/rpc/enqueue_document_processing',
    ), true);
    assert.equal(isAllowedAgentMutationEndpoint('office', 'POST', '/rest/v1/documents'), true);
    assert.equal(isAllowedAgentMutationEndpoint(
      'kitchen',
      'POST',
      '/storage/v1/object/documents/tenant/file.pdf',
    ), true);
    assert.equal(isAllowedAgentMutationEndpoint(
      'kitchen',
      'POST',
      '/rest/v1/documents',
      'attach-receipt-document',
    ), true);
    assert.equal(isAllowedAgentMutationEndpoint('office', 'DELETE', '/rest/v1/documents'), false);
    assert.equal(isAllowedAgentMutationEndpoint('owner', 'POST', '/rest/v1/documents'), false);
    assert.equal(isAllowedAgentMutationEndpoint(
      'supplier',
      'DELETE',
      '/storage/v1/object/price-submissions',
      'replay-price-workbook',
    ), true);
    assert.equal(isAllowedAgentMutationEndpoint(
      'supplier',
      'DELETE',
      '/storage/v1/object/price-submissions',
      'submit-price-workbook',
    ), false);
  });
});

describe('per-step browser mutation protocol', () => {
  const ref = (kind: string) => ({
    kind,
    visibleReference: '11111111-1111-4111-8111-111111111111',
  });
  const entry = (
    pathname: string,
    responseFacts: BrowserMutationNetworkEvidence['responseFacts'] = {},
    entityRefs: BrowserMutationNetworkEvidence['entityRefs'] = [],
    method = 'POST',
  ): BrowserMutationNetworkEvidence => ({
    requestId: `${method}:${pathname}`,
    method,
    pathname,
    resourceType: 'fetch',
    startedAt: '2026-08-04T10:00:00.000Z',
    completedAt: '2026-08-04T10:00:00.100Z',
    durationMs: 100,
    status: 200,
    failure: null,
    mutationCandidate: true,
    responseBodyParsed: true,
    responseFacts,
    entityRefs,
  });
  const cases = [{
    role: 'supplier' as const,
    step: 'submit-price-workbook',
    refs: [ref('supplier_price_submission')],
    entries: [
      entry('/storage/v1/object/price-submissions/run/file.xlsx'),
      entry('/functions/v1/submit-price-list', {
        status: 'accepted', accepted_count: 3, rejected_count: 0,
        unchanged_count: 0, idempotent: false,
      }, [ref('supplier_price_submission')]),
    ],
  }, {
    role: 'supplier' as const,
    step: 'replay-price-workbook',
    refs: [ref('supplier_price_submission')],
    entries: [
      entry('/storage/v1/object/price-submissions/run/replay.xlsx'),
      entry('/functions/v1/submit-price-list', {
        status: 'accepted', accepted_count: 3, rejected_count: 0,
        unchanged_count: 0, idempotent: true,
      }, [ref('supplier_price_submission')]),
      entry('/storage/v1/object/price-submissions', {}, [], 'DELETE'),
    ],
  }, {
    role: 'kitchen' as const,
    step: 'record-partial-receipt',
    refs: [ref('goods_receipt')],
    entries: [entry('/rest/v1/rpc/save_goods_receipt', {
      status: 'completed', order_status: 'partial', credit_count: 1, idempotent: false,
    }, [ref('goods_receipt')])],
  }, {
    role: 'kitchen' as const,
    step: 'attach-receipt-document',
    refs: [ref('document')],
    entries: [
      entry('/storage/v1/object/documents/tenant/receipt/file.jpg'),
      entry('/rest/v1/documents', {}, [ref('document')]),
      entry('/rest/v1/rpc/enqueue_document_processing'),
    ],
  }, {
    role: 'office' as const,
    step: 'create-invoice',
    refs: [ref('invoice')],
    entries: [entry('/rest/v1/rpc/create_invoice', {
      review_status: 'received', idempotent: false,
    }, [ref('invoice')])],
  }, {
    role: 'office' as const,
    step: 'start-invoice-review',
    refs: [ref('invoice')],
    entries: [entry('/rest/v1/rpc/set_invoice_review_status', {
      review_status: 'in_review', idempotent: false,
    }, [ref('invoice')])],
  }, {
    role: 'office' as const,
    step: 'approve-invoice-for-payment',
    refs: [ref('invoice')],
    entries: [entry('/rest/v1/rpc/set_invoice_review_status', {
      review_status: 'approved', idempotent: false,
    }, [ref('invoice')])],
  }, {
    role: 'office' as const,
    step: 'request-payment',
    refs: [ref('payment_request')],
    entries: [entry('/rest/v1/rpc/create_payment_request', {
      number: 42, status: 'pending_approval', idempotent: false,
    }, [ref('payment_request')])],
  }, {
    role: 'owner' as const,
    step: 'approve-payment-request',
    refs: [ref('payment_request')],
    entries: [entry('/rest/v1/rpc/approve_payment_request_with_credit_override', {
      status: 'approved', open_credit_override: true, idempotent: false,
    }, [ref('payment_request')])],
  }, {
    role: 'payer' as const,
    step: 'execute-transfer',
    refs: [ref('payment'), ref('payment_request'), ref('invoice')],
    entries: [entry('/rest/v1/rpc/execute_payment_request', {
      status: 'executed', idempotent: false,
    }, [ref('payment'), ref('payment_request'), ref('invoice')])],
  }, {
    role: 'accountant' as const,
    step: 'import-bank-csv',
    refs: [ref('bank_import')],
    entries: [entry('/rest/v1/rpc/import_bank_transactions', {
      row_count: 1, idempotent: false,
    }, [ref('bank_import')])],
  }, {
    role: 'accountant' as const,
    step: 'match-bank-payment',
    refs: [ref('bank_transaction'), ref('payment'), ref('invoice')],
    entries: [entry('/rest/v1/rpc/match_bank_transaction', {
      status: 'matched', idempotent: false,
    }, [ref('bank_transaction'), ref('payment'), ref('invoice')])],
  }];

  test('binds every mutating scenario step to exact requests, entity kinds, and response facts', () => {
    for (const item of cases) {
      const result = evaluateAgentMutationStepEvidenceContract({
        role: item.role,
        mutationStepId: item.step,
        mutationEntries: item.entries,
        entityRefs: item.refs,
      });
      assert.equal(result.contractAvailable, true, item.step);
      assert.equal(result.endpointsAllowed, true, item.step);
      assert.equal(result.requiredRequestsObserved, true, item.step);
      assert.equal(result.requiredEntityKindsPresent, true, item.step);
      assert.equal(result.entityKindsAllowed, true, item.step);
      assert.equal(result.responseFactsMatch, true, item.step);
    }
  });

  test('fails closed on replay cleanup, entity-kind, or response-fact mismatches', () => {
    const replay = cases.find(({ step }) => step === 'replay-price-workbook')!;
    assert.equal(evaluateAgentMutationStepEvidenceContract({
      role: replay.role,
      mutationStepId: replay.step,
      mutationEntries: replay.entries.filter(({ method }) => method !== 'DELETE'),
      entityRefs: replay.refs,
    }).requiredRequestsObserved, false);

    const submit = cases[0]!;
    assert.equal(evaluateAgentMutationStepEvidenceContract({
      role: submit.role,
      mutationStepId: submit.step,
      mutationEntries: submit.entries.map((item) => item.pathname.includes('submit-price-list')
        ? { ...item, responseFacts: { ...item.responseFacts, idempotent: true } }
        : item),
      entityRefs: submit.refs,
    }).responseFactsMatch, false);

    const execute = cases.find(({ step }) => step === 'execute-transfer')!;
    assert.equal(evaluateAgentMutationStepEvidenceContract({
      role: execute.role,
      mutationStepId: execute.step,
      mutationEntries: execute.entries,
      entityRefs: [ref('payment')],
    }).requiredEntityKindsPresent, false);

    const documentUpload = cases.find(({ step }) => step === 'attach-receipt-document')!;
    assert.equal(evaluateAgentMutationStepEvidenceContract({
      role: 'kitchen',
      mutationStepId: 'record-partial-receipt',
      mutationEntries: documentUpload.entries,
      entityRefs: documentUpload.refs,
    }).endpointsAllowed, false);
  });

  test('blocks a success envelope while any sibling mutation request is still pending', () => {
    const success = entry('/rest/v1/rpc/create_invoice', {
      review_status: 'received', idempotent: false,
    }, [ref('invoice')]);
    const pending: BrowserMutationNetworkEvidence = {
      ...entry('/rest/v1/rpc/create_invoice'),
      requestId: 'pending-request',
      status: null,
      completedAt: null,
      durationMs: null,
    };
    const outcome = evaluateAgentMutationNetworkOutcome([success, pending]);
    assert.equal(outcome.mutationSucceeded, true);
    assert.equal(outcome.networkPending, true);
    assert.equal(outcome.status, 'BLOCKED');
  });
});

describe('action audit-window proof', () => {
  const allowed = [{
    id: 'expected-audit',
    orgId: '11111111-1111-4111-8111-111111111111',
    action: 'invoice_created',
    entityType: 'invoices',
    entityId: '11111111-1111-4111-8111-111111111111',
    exactCount: 1,
  }];

  test('passes only the exact allowlisted count and rejects duplicates or extra event types', () => {
    const expectedRow = {
      action: 'invoice_created',
      entity_type: 'invoices',
      entity_id: '11111111-1111-4111-8111-111111111111',
    };
    assert.equal(evaluateActionAuditWindow([expectedRow], allowed).status, 'PASS');
    assert.equal(evaluateActionAuditWindow([expectedRow, expectedRow], allowed).status, 'FAIL');
    assert.equal(evaluateActionAuditWindow([expectedRow, {
      action: 'payment_request_created',
      entity_type: 'payment_requests',
      entity_id: '22222222-2222-4222-8222-222222222222',
    }], allowed).status, 'FAIL');
  });

  test('proves a replay audit window must remain empty', () => {
    assert.equal(evaluateActionAuditWindow([], []).status, 'PASS');
    assert.equal(evaluateActionAuditWindow([{
      action: 'supplier_price_submission_processed',
      entity_type: 'supplier_price_submissions',
      entity_id: '33333333-3333-4333-8333-333333333333',
    }], []).status, 'FAIL');
  });

  test('checks each expectation count instead of accepting an equal total with a missing event', () => {
    const invoiceId = '11111111-1111-4111-8111-111111111111';
    const twoEvents = [allowed[0]!, {
      ...allowed[0]!,
      id: 'expected-generic-insert',
      action: 'insert',
    }];
    const duplicateBusinessEvent = {
      action: 'invoice_created',
      entity_type: 'invoices',
      entity_id: invoiceId,
    };
    assert.equal(evaluateActionAuditWindow([
      duplicateBusinessEvent,
      duplicateBusinessEvent,
    ], twoEvents).status, 'FAIL');
  });
});

describe('trusted accountant export contract', () => {
  test('binds the workbook to the exact DB month and one payer mutation from this run', () => {
    const rows = [{
      amount: 125.5,
      reference: 'QA-PAY-1',
      executedBy: 'payer-user',
      createdAt: '2026-08-04T10:01:00.000Z',
      supplierName: 'ספק א',
    }, {
      amount: 74.5,
      reference: 'SEED-PAYMENT',
      executedBy: 'seed-user',
      createdAt: '2026-08-01T08:00:00.000Z',
      supplierName: 'ספק ב',
    }];
    const expectation = buildMonthlyPaymentExportExpectation({
      id: 'agent-export-1',
      filePath: 'C:\\qa\\report-2026-08.xlsx',
      rows,
      agentStartedAt: '2026-08-04T10:00:00.000Z',
      payerUserId: 'payer-user',
    });
    assert.ok(expectation && expectation.kind === 'xlsx');
    assert.equal(expectation.exactRowCount, 2);
    assert.equal(expectation.expectedRowSubsets?.length, 2);
    assert.equal(expectation.total?.expected, 200);

    assert.equal(buildMonthlyPaymentExportExpectation({
      id: 'agent-export-duplicate',
      filePath: 'C:\\qa\\report-2026-08.xlsx',
      rows: [...rows, { ...rows[0]!, reference: 'QA-PAY-2' }],
      agentStartedAt: '2026-08-04T10:00:00.000Z',
      payerUserId: 'payer-user',
    }), null);
  });
});

describe('agent run blocker classification', () => {
  test('uses BLOCKED infrastructure for unverified or otherwise unproven orchestration failures', () => {
    assert.deepEqual(classifyAgentOrchestrationOutcome({
      orchestratorStatus: 'failed',
      unverifiedMeaningfulActions: 1,
      blockedRoleCount: 0,
      infrastructureFailedRoleCount: 0,
      productVerifierFailure: true,
    }), {
      status: 'BLOCKED',
      blockerType: 'INFRASTRUCTURE',
      reason: 'One or more meaningful business actions lacked independent verification.',
    });
    assert.equal(classifyAgentOrchestrationOutcome({
      orchestratorStatus: 'failed',
      unverifiedMeaningfulActions: 0,
      blockedRoleCount: 0,
      infrastructureFailedRoleCount: 1,
      productVerifierFailure: false,
    }).blockerType, 'INFRASTRUCTURE');
  });

  test('uses FAILED product only for an explicit failed verifier product fact', () => {
    const proven = {
      status: 'failed' as const,
      summary: 'Database mismatch.',
      evidence: [],
      facts: [{ key: 'product_evidence', value: true }],
    };
    assert.equal(verifierFailureIsProduct(proven), true);
    assert.equal(verifierFailureIsProduct({ ...proven, status: 'blocked' }), false);
    assert.deepEqual(classifyAgentOrchestrationOutcome({
      orchestratorStatus: 'failed',
      unverifiedMeaningfulActions: 0,
      blockedRoleCount: 0,
      infrastructureFailedRoleCount: 0,
      productVerifierFailure: verifierFailureIsProduct(proven),
    }), {
      status: 'FAILED',
      blockerType: 'PRODUCT',
      reason: 'One or more trusted verifier checks proved a product-state mismatch.',
    });
  });

  test('keeps passed, blocked, failed, and configuration exit codes consistent', () => {
    assert.deepEqual(classifyAgentOrchestrationOutcome({
      orchestratorStatus: 'completed',
      unverifiedMeaningfulActions: 0,
      blockedRoleCount: 0,
      infrastructureFailedRoleCount: 0,
      productVerifierFailure: false,
    }), {
      status: 'PASSED',
      blockerType: null,
      reason: 'Agent orchestration completed with independently verified actions.',
    });
    assert.equal(agentRunExitCode('PASSED'), 0);
    assert.equal(agentRunExitCode('SKIPPED_BY_CONFIGURATION'), 0);
    assert.equal(agentRunExitCode('FAILED'), 1);
    assert.equal(agentRunExitCode('BLOCKED'), 2);
  });

  test('keeps the run BLOCKED when required role coverage is missing despite product evidence', () => {
    assert.deepEqual(classifyAgentOrchestrationOutcome({
      orchestratorStatus: 'failed',
      unverifiedMeaningfulActions: 0,
      blockedRoleCount: 2,
      infrastructureFailedRoleCount: 0,
      productVerifierFailure: true,
    }), {
      status: 'BLOCKED',
      blockerType: 'INFRASTRUCTURE',
      reason: 'One or more required role scenarios were blocked or not executed.',
    });
  });

  test('counts failed infrastructure roles before product verifier evidence', () => {
    assert.deepEqual(classifyAgentOrchestrationOutcome({
      orchestratorStatus: 'failed',
      unverifiedMeaningfulActions: 0,
      blockedRoleCount: 0,
      infrastructureFailedRoleCount: 1,
      productVerifierFailure: true,
    }), {
      status: 'BLOCKED',
      blockerType: 'INFRASTRUCTURE',
      reason: 'One or more required role scenarios failed without verified product evidence.',
    });
  });

  test('keeps infrastructure BLOCKED when a later role exposes product evidence', () => {
    const infrastructure = {
      status: 'BLOCKED' as const,
      blockerType: 'INFRASTRUCTURE' as const,
      reason: 'Download evidence could not be persisted.',
    };
    const product = {
      status: 'FAILED' as const,
      blockerType: 'PRODUCT' as const,
      reason: 'A later role emitted a console error.',
    };

    assert.deepEqual(
      mergeAgentOrchestrationOutcomes(infrastructure, product),
      infrastructure,
    );
    assert.deepEqual(
      mergeAgentOrchestrationOutcomes(product, infrastructure),
      infrastructure,
    );
  });
});

describe('cross-role orchestration order', () => {
  test('contains every QA role exactly once and places every dependency first', () => {
    assert.equal(DEFAULT_CROSS_ROLE_ORDER.length, QA_ROLES.length);
    assert.deepEqual(
      [...new Set(DEFAULT_CROSS_ROLE_ORDER)].sort(),
      [...QA_ROLES].sort(),
    );

    const scenarioPositions = new Map(DEFAULT_CROSS_ROLE_ORDER.map((role, index) => [
      ROLE_SCENARIOS[role],
      index,
    ]));
    for (const [roleIndex, role] of DEFAULT_CROSS_ROLE_ORDER.entries()) {
      const scenario = getScenario(ROLE_SCENARIOS[role]);
      for (const dependency of scenario.dependsOn) {
        const dependencyIndex = scenarioPositions.get(dependency);
        assert.ok(dependencyIndex !== undefined, `Missing dependency scenario ${dependency}.`);
        assert.ok(
          dependencyIndex < roleIndex,
          `${dependency} must run before ${scenario.id}.`,
        );
      }
    }
  });

  test('payer retry is observation-only because deterministic exact replay owns the mutation', () => {
    const retry = getScenario('payer-transfer-execution').steps.find(({ id }) => id === 'retry-transfer');
    assert.ok(retry);
    assert.equal(retry.mutatesData, false);
    assert.match(retry.action, /deterministic exact-request replay/i);
  });
});

describe('per-role blocker classification', () => {
  const productVerification = [{
    step: 1,
    checkId: 'data-integrity',
    actionId: null,
    mutationEvidence: null,
    result: {
      status: 'failed' as const,
      summary: 'Database state mismatched.',
      evidence: [],
      facts: [{ key: 'product_evidence', value: true }],
    },
  }];

  test('assigns null only to completed and PRODUCT only to a proven failed verifier result', () => {
    assert.equal(classifyRoleRunBlocker('completed', []), null);
    assert.equal(classifyRoleRunBlocker('failed', productVerification), 'PRODUCT');
    assert.equal(classifyRoleRunBlocker('failed', []), 'INFRASTRUCTURE');
    assert.equal(classifyRoleRunBlocker('blocked', productVerification), 'INFRASTRUCTURE');
    assert.equal(classifyRoleRunBlocker('step_limit', []), 'INFRASTRUCTURE');
  });

  test('allows a configuration-owned blocked orchestrator result to mark each role explicitly', () => {
    const role = 'supplier' as const;
    const scenario = createAgentScenarioContext(getScenario(ROLE_SCENARIOS[role]), role);
    const result = blockedRoleRunResult({
      runId: 'configuration-blocked-run',
      role,
      scenario,
      reason: 'QA_MODEL_API_KEY is missing',
      blockerType: 'CONFIGURATION',
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.blockerType, 'CONFIGURATION');
  });
});
