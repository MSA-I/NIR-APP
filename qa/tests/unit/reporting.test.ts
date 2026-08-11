import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { deduplicateFindings } from '../../reporting/deduplicate.ts';
import {
  createFinding,
  findingFingerprint,
  retryClassification,
  severityFor,
} from '../../reporting/finding.ts';
import { coverageExceptions, exitDecision, roleScorecards, statistics } from '../../reporting/aggregate.ts';
import { redactText, redactUnknown } from '../../reporting/redact.ts';
import { parsePlaywrightReport } from '../../reporting/playwright.ts';
import { FindingSchema, type RoleResult, type ScenarioResult } from '../../reporting/schemas.ts';
import { QA_ROLES } from '../../config/roles.ts';
import {
  agentDataRefreshPhase,
  deterministicAgentPreconditionsSatisfied,
  mergeFullRunStatus,
  mergeProductQualityStatus,
  reportPhase,
  type FullPhaseResult,
} from '../../runner/full-runner.ts';
import type { DeterministicRunResult } from '../../runner/deterministic-runner.ts';
import { validateQaRunId, type SetupResult } from '../../runner/setup.ts';
import type { CleanupResult } from '../../runner/clean.ts';
import {
  AgentRunSchema,
  buildAgentCoverage,
  buildRoles,
  cleanupVerificationScenario,
  completedOpenAreas,
} from '../../runner/report-runner.ts';

const now = '2026-08-04T10:00:00.000Z';

function scenario(status: ScenarioResult['status'], overrides: Partial<ScenarioResult> = {}): ScenarioResult {
  return {
    id: 'owner-core',
    name: 'owner core workflow',
    role: 'owner',
    required: true,
    status,
    startedAt: now,
    endedAt: now,
    durationMs: 0,
    steps: [],
    findingIds: [],
    evidence: [],
    ...overrides,
  };
}

function finding(overrides: Parameters<typeof createFinding>[0] = {
  runId: 'run-1',
  source: 'playwright',
  role: 'owner',
  scenarioId: 'owner-core',
  scenarioName: 'owner core workflow',
  title: 'שמירה נכשלה',
  category: 'functional',
  severity: 'high',
  confidence: 1,
  reproducibility: 'persistent',
  status: 'confirmed',
  expected: 'שמירה',
  actual: 'שגיאה',
  userImpact: 'cannot complete core workflow',
  reproductionSteps: ['פתח', 'שמור'],
  evidence: { screenshots: ['shot.png'] },
  humanReviewRequired: false,
  createdAt: now,
}) {
  return createFinding(overrides);
}

describe('finding contract', () => {
  test('rejects malformed findings', () => {
    assert.throws(() => FindingSchema.parse({ severity: 'urgent' }));
  });

  test('assigns security and functional severity conservatively', () => {
    assert.equal(severityFor('authorization', 'cross-tenant data exposed'), 'critical');
    assert.equal(severityFor('functional', 'cannot complete core workflow'), 'high');
    assert.equal(severityFor('accessibility', 'missing label'), 'medium');
  });

  test('normalizes volatile identifiers in fingerprints', () => {
    const base = {
      role: 'owner',
      scenarioId: 'owner-core',
      category: 'functional' as const,
      route: '/orders?from=qa',
      title: 'Order 1234 failed',
      actual: 'Entity 550e8400-e29b-41d4-a716-446655440000 failed',
    };
    assert.equal(
      findingFingerprint(base),
      findingFingerprint({ ...base, route: '/orders?from=other', title: 'Order 9999 failed' }),
    );
  });

  test('merges duplicate evidence and affected coverage', () => {
    const first = finding();
    const second = {
      ...first,
      id: 'finding-second',
      role: 'office',
      affectedRoles: ['office'],
      affectedScenarios: ['office-core'],
      evidence: { screenshots: ['other.png'] },
    };
    const [merged] = deduplicateFindings([first, FindingSchema.parse(second)]);
    assert.equal(merged.reproductionCount, 2);
    assert.deepEqual(merged.affectedRoles.sort(), ['office', 'owner']);
    assert.deepEqual(merged.evidence.screenshots?.sort(), ['other.png', 'shot.png']);
  });

  test('classifies deterministic retries truthfully', () => {
    assert.equal(retryClassification([false]), 'not_retested');
    assert.equal(retryClassification([false, false]), 'persistent');
    assert.equal(retryClassification([false, true]), 'intermittent');
  });
});

describe('aggregation and redaction', () => {
  test('separates run completion from product quality and ignores optional platform coverage', () => {
    const infrastructureBlock = exitDecision([
      scenario('BLOCKED', { blockerType: 'INFRASTRUCTURE' }),
    ], [], false);
    assert.equal(infrastructureBlock.runStatus, 'BLOCKED');
    assert.equal(infrastructureBlock.productQualityStatus, 'PASS');
    assert.equal(exitDecision([
      scenario('FAILED', { blockerType: 'INFRASTRUCTURE' }),
    ], [], false).runStatus, 'INFRASTRUCTURE_FAILED');
    assert.equal(exitDecision([
      scenario('SKIPPED_BY_CONFIGURATION', { blockerType: 'CONFIGURATION' }),
    ], [], false).runStatus, 'BLOCKED');

    const productFailure = exitDecision([
      scenario('FAILED', { blockerType: 'PRODUCT' }),
    ], [], false);
    assert.equal(productFailure.runStatus, 'COMPLETED');
    assert.equal(productFailure.productQualityStatus, 'FAIL');

    const findingFailure = exitDecision([scenario('PASSED')], [finding()], false);
    assert.equal(findingFailure.runStatus, 'COMPLETED');
    assert.equal(findingFailure.productQualityStatus, 'FAIL');
    assert.equal(exitDecision([scenario('PASSED')], [{
      ...finding(),
      severity: 'low',
      status: 'observation',
    }], false).productQualityStatus, 'PASS_WITH_FINDINGS');

    const optional = scenario('OPTIONAL_BLOCKED', {
      id: 'platform-admin',
      name: 'platform admin',
      role: 'platform',
      required: false,
      blockerType: 'CONFIGURATION',
      limitation: 'fixture not approved',
    });
    const optionalDecision = exitDecision([scenario('PASSED'), optional], [], false);
    assert.equal(optionalDecision.runStatus, 'COMPLETED');
    assert.equal(optionalDecision.productQualityStatus, 'PASS');
    assert.deepEqual(coverageExceptions([optional]), [{
      id: 'platform-admin',
      name: 'platform admin',
      role: 'platform',
      reason: 'fixture not approved',
      required: false,
      status: 'OPTIONAL_BLOCKED',
      blockerType: 'CONFIGURATION',
    }]);
  });

  test('aggregates scenario and role measurements', () => {
    const scenarios = [
      scenario('PASSED'),
      scenario('FAILED', { id: 'owner-accessibility', name: 'owner axe accessibility' }),
    ];
    const role: RoleResult = {
      role: 'owner',
      purpose: 'ניהול',
      status: 'FAILED',
      scenarioIds: scenarios.map(({ id }) => id),
      tasksAttempted: [],
      tasksCompleted: [],
      tasksBlocked: [],
      accessibleAreas: [],
      unexpectedlyInaccessibleAreas: [],
      unexpectedlyAccessibleAreas: [],
      functionalDefects: [],
      permissionDefects: [],
      accessibilityFindings: [],
      usabilityObservations: [],
      unclearWording: [],
      recoveryProblems: [],
      evidence: [],
      confidence: null,
      recommendations: [],
      limitations: [],
    };
    assert.equal(statistics(scenarios, []).failedScenarios, 1);
    assert.equal(roleScorecards([role], scenarios, [])[0]?.accessibility, 0);
  });

  test('redacts tokens, passwords and emails recursively', () => {
    const text = redactText('Bearer abc.def.ghi user@example.com');
    assert.equal(text.includes('abc.def.ghi'), false);
    assert.equal(text.includes('user@example.com'), false);
    assert.deepEqual(redactUnknown({ password: 'secret', nested: ['user@example.com'] }), {
      password: '[REDACTED]',
      nested: ['[EMAIL_REDACTED]'],
    });
  });
});

describe('runner status and coverage contracts', () => {
  const prerequisiteNames = [
    'qa-typecheck',
    'qa-unit-integration',
    'document-export-contract',
    'chromium-installed',
    'preview-ready',
    'playwright-runtime-integrity',
    'trace-redaction',
    'preview-stopped',
    'environment-lock-release',
  ] as const;

  function deterministicResult(
    productStatus: 'PASSED' | 'FAILED' = 'FAILED',
  ): DeterministicRunResult {
    return {
      schemaVersion: 1,
      runId: 'qa-test',
      status: productStatus === 'FAILED' ? 'FAILED' : 'PASSED',
      startedAt: now,
      endedAt: now,
      phases: [
        ...prerequisiteNames.map((name) => ({
          name,
          status: 'PASSED' as const,
          exitCode: 0,
          durationMs: 0,
        })),
        {
          name: 'playwright-deterministic',
          status: productStatus,
          exitCode: productStatus === 'PASSED' ? 0 : 1,
          durationMs: 0,
        },
        {
          name: 'critical-workflow-coverage',
          status: productStatus,
          exitCode: productStatus === 'PASSED' ? 0 : 1,
          durationMs: 0,
        },
      ],
      redactedTraces: [],
      playwrightReport: 'playwright-results.json',
      exitCode: productStatus === 'PASSED' ? 0 : 1,
    };
  }

  function storedAgent(
    status: 'FAILED' | 'BLOCKED',
    blockerType: 'PRODUCT' | 'INFRASTRUCTURE' | 'CONFIGURATION',
  ) {
    return AgentRunSchema.parse({
      schemaVersion: 1,
      runId: 'qa-test',
      status,
      blockerType,
      reason: 'explicit test classification',
      startedAt: now,
      endedAt: now,
      orchestrator: {
        runId: 'qa-test',
        status: status === 'FAILED' ? 'failed' : 'blocked',
        provider: 'test',
        model: 'test-model',
        roleResults: [],
        roleOrder: [...QA_ROLES],
        statistics: {
          assigned: 0,
          completed: 0,
          blocked: 0,
          failed: 0,
          stepLimit: 0,
          observations: 0,
          verifiedChecks: 0,
          unverifiedMeaningfulActions: 0,
        },
        diagnostics: [],
      },
      evidencePaths: [],
      exitCode: status === 'FAILED' ? 1 : 2,
    });
  }

  test('continues agents after product failures only when every infrastructure precondition passed', () => {
    const productFailure = deterministicResult('FAILED');
    assert.equal(deterministicAgentPreconditionsSatisfied(productFailure), true);

    for (const name of prerequisiteNames) {
      const failed = deterministicResult('FAILED');
      failed.phases.find((phase) => phase.name === name)!.status = 'FAILED';
      assert.equal(
        deterministicAgentPreconditionsSatisfied(failed),
        false,
        `${name} must remain a hard agent precondition`,
      );
    }

    const incompleteCriticalEvidence = deterministicResult('FAILED');
    incompleteCriticalEvidence.phases.find(({ name }) => name === 'critical-workflow-coverage')!.status = 'BLOCKED';
    assert.equal(deterministicAgentPreconditionsSatisfied(incompleteCriticalEvidence), false);

    const missingLockRelease = deterministicResult('FAILED');
    missingLockRelease.phases = missingLockRelease.phases.filter(
      ({ name }) => name !== 'environment-lock-release',
    );
    assert.equal(deterministicAgentPreconditionsSatisfied(missingLockRelease), false);
  });

  test('requires a clean local reset and the exact original run identity before agents', () => {
    const runId = validateQaRunId('qa-20260804123456-abcdef12');
    const artifactRoot = path.join(process.cwd(), '.qa-runs', runId);
    const clean = {
      status: 'CLEAN',
      runId,
      statePath: path.join(process.cwd(), '.qa-state', 'current.json'),
      resetPerformed: true,
      artifactsPreserved: true,
      removed: [],
    } satisfies CleanupResult;
    const ready = {
      status: 'READY',
      runId,
      artifactRoot,
    } as SetupResult;

    assert.equal(agentDataRefreshPhase({ runId, artifactRoot }, clean, ready).status, 'PASSED');
    const wrongRoot = agentDataRefreshPhase(
      { runId, artifactRoot },
      clean,
      { ...ready, artifactRoot: path.join(process.cwd(), '.qa-runs', 'other') },
    );
    assert.equal(wrongRoot.status, 'FAILED');
    assert.equal(wrongRoot.blockerType, 'INFRASTRUCTURE');
    const wrongCleanupRun = agentDataRefreshPhase(
      { runId, artifactRoot },
      { ...clean, runId: 'qa-20260804123456-deadbeef' },
      ready,
    );
    assert.equal(wrongCleanupRun.status, 'FAILED');
    assert.equal(wrongCleanupRun.blockerType, 'INFRASTRUCTURE');
    assert.match(wrongCleanupRun.reason, /cleanup result does not belong/);
    assert.throws(() => validateQaRunId('../production'), /QA runId must match/);
  });

  test('uses explicit agents.json blockerType instead of treating every FAILED run as product failure', () => {
    const infrastructureAgent = storedAgent('FAILED', 'INFRASTRUCTURE');
    const coverage = buildAgentCoverage(infrastructureAgent, {
      runId: 'qa-test',
      artifactRoot: process.cwd(),
      generatedAt: now,
      deterministicStatus: 'FAILED',
      agentMode: 'enabled',
    });
    assert.equal(
      coverage.scenarios.find(({ id }) => id === 'agent-orchestrator-gate')?.blockerType,
      'INFRASTRUCTURE',
    );
    assert.throws(() => AgentRunSchema.parse({
      ...infrastructureAgent,
      blockerType: null,
    }), /exact persisted agent status contract/);
  });

  test('parses the real per-role blockerType and preserves it instead of the global agent blocker', () => {
    const infrastructureAgent = storedAgent('FAILED', 'INFRASTRUCTURE');
    const roleRun = {
      runId: 'qa-test',
      role: 'accountant' as const,
      scenarioId: 'accountant-reconciliation',
      scenarioName: 'Accountant transfer execution, bank reconciliation and reporting',
      status: 'failed' as const,
      blockerType: 'PRODUCT' as const,
      terminalReason: 'required_verification_failed',
      steps: [],
      receipts: [],
      verificationResults: [],
      observations: [],
      summary: null,
      evidence: [],
      evidenceRefs: [],
      missingEvidenceKinds: [],
      unverifiedMeaningfulActions: 0,
      helpQuestion: null,
      diagnostics: [],
    };
    const parsed = AgentRunSchema.parse({
      ...infrastructureAgent,
      orchestrator: {
        ...infrastructureAgent.orchestrator!,
        roleResults: [roleRun],
        statistics: {
          ...infrastructureAgent.orchestrator!.statistics,
          assigned: 1,
          failed: 1,
        },
      },
    });
    const coverage = buildAgentCoverage(parsed, {
      runId: 'qa-test',
      artifactRoot: process.cwd(),
      generatedAt: now,
      deterministicStatus: 'PASSED',
      agentMode: 'enabled',
    });
    assert.equal(
      coverage.scenarios.find(({ id }) => id === 'agent-accountant-accountant-reconciliation')?.blockerType,
      'PRODUCT',
    );
    assert.throws(() => AgentRunSchema.parse({
      ...parsed,
      orchestrator: {
        ...parsed.orchestrator!,
        roleResults: [{ ...roleRun, blockerType: undefined }],
      },
    }));
    assert.throws(() => AgentRunSchema.parse({
      ...parsed,
      orchestrator: {
        ...parsed.orchestrator!,
        roleResults: [{ ...roleRun, status: 'completed' }],
      },
    }), /exact persisted role status contract/);
  });

  test('accepts only the exact persisted status and blockerType pairs for agent and role runs', () => {
    const statuses = ['PASSED', 'FAILED', 'BLOCKED', 'SKIPPED_BY_CONFIGURATION'] as const;
    const roleStatuses = ['completed', 'failed', 'blocked', 'step_limit'] as const;
    const blockerTypes = [null, 'PRODUCT', 'INFRASTRUCTURE', 'CONFIGURATION'] as const;
    const allowedAgentPairs = new Set([
      'PASSED/null',
      'FAILED/PRODUCT',
      'FAILED/INFRASTRUCTURE',
      'BLOCKED/INFRASTRUCTURE',
      'BLOCKED/CONFIGURATION',
      'SKIPPED_BY_CONFIGURATION/CONFIGURATION',
    ]);
    const allowedRolePairs = new Set([
      'completed/null',
      'failed/PRODUCT',
      'failed/INFRASTRUCTURE',
      'blocked/INFRASTRUCTURE',
      'blocked/CONFIGURATION',
      'step_limit/INFRASTRUCTURE',
    ]);
    const base = storedAgent('FAILED', 'INFRASTRUCTURE');
    const roleBase = {
      runId: 'qa-test',
      role: 'accountant' as const,
      scenarioId: 'accountant-reconciliation',
      scenarioName: 'Accountant transfer execution, bank reconciliation and reporting',
      status: 'failed' as const,
      blockerType: 'INFRASTRUCTURE' as const,
      terminalReason: 'matrix-test',
      steps: [],
      receipts: [],
      verificationResults: [],
      observations: [],
      summary: null,
      evidence: [],
      evidenceRefs: [],
      missingEvidenceKinds: [],
      unverifiedMeaningfulActions: 0,
      helpQuestion: null,
      diagnostics: [],
    };

    for (const status of statuses) {
      for (const blockerType of blockerTypes) {
        const key = `${status}/${blockerType ?? 'null'}`;
        assert.equal(
          AgentRunSchema.safeParse({ ...base, status, blockerType }).success,
          allowedAgentPairs.has(key),
          `unexpected persisted agent pair result for ${key}`,
        );
      }
    }
    for (const status of roleStatuses) {
      for (const blockerType of blockerTypes) {
        const key = `${status}/${blockerType ?? 'null'}`;
        assert.equal(
          AgentRunSchema.safeParse({
            ...base,
            orchestrator: {
              ...base.orchestrator!,
              roleResults: [{ ...roleBase, status, blockerType }],
            },
          }).success,
          allowedRolePairs.has(key),
          `unexpected persisted role pair result for ${key}`,
        );
      }
    }
  });

  test('represents completed report generation with failed product quality as a product phase failure', () => {
    const phase = reportPhase({
      schemaVersion: 2,
      runId: 'qa-test',
      runStatus: 'COMPLETED',
      productQualityStatus: 'FAIL',
      generatedAt: now,
      artifactRoot: process.cwd(),
      reportPaths: ['report.json'],
      reason: 'product scenario failed',
      exitCode: 1,
    });
    assert.equal(phase.status, 'FAILED');
    assert.equal(phase.blockerType, 'PRODUCT');
    assert.equal(phase.exitCode, 1);
  });

  test('keeps an infrastructure phase failure above a blocked report without reclassifying product failure', () => {
    const infrastructureRefresh = {
      name: 'agent-data-refresh',
      status: 'FAILED',
      blockerType: 'INFRASTRUCTURE',
      exitCode: 1,
      reason: 'cleanup runId mismatch',
    } satisfies FullPhaseResult;
    const unexpectedAgentFailure = {
      name: 'agents',
      status: 'FAILED',
      exitCode: 1,
      reason: 'agent runner threw unexpectedly',
    } satisfies FullPhaseResult;
    const productFailure = {
      name: 'deterministic',
      status: 'FAILED',
      blockerType: 'PRODUCT',
      exitCode: 1,
      reason: 'a product assertion failed',
    } satisfies FullPhaseResult;

    assert.equal(mergeFullRunStatus([infrastructureRefresh], 'BLOCKED'), 'INFRASTRUCTURE_FAILED');
    assert.equal(mergeFullRunStatus([unexpectedAgentFailure], 'BLOCKED'), 'INFRASTRUCTURE_FAILED');
    assert.equal(mergeFullRunStatus([productFailure], 'COMPLETED'), 'COMPLETED');
    assert.equal(mergeFullRunStatus([productFailure], 'BLOCKED'), 'BLOCKED');
    assert.equal(mergeProductQualityStatus([productFailure], 'PASS'), 'FAIL');
    assert.equal(mergeProductQualityStatus([productFailure], undefined), 'FAIL');
    assert.equal(
      mergeProductQualityStatus([infrastructureRefresh], 'PASS_WITH_FINDINGS'),
      'PASS_WITH_FINDINGS',
    );
  });

  test('maps an agent step limit to blocked infrastructure coverage instead of an infrastructure failure', () => {
    const agent = storedAgent('BLOCKED', 'INFRASTRUCTURE');
    const parsed = AgentRunSchema.parse({
      ...agent,
      orchestrator: {
        ...agent.orchestrator!,
        status: 'partial',
        roleResults: [{
          runId: 'qa-test',
          role: 'office',
          scenarioId: 'office-invoice-review',
          scenarioName: 'Office invoice review',
          status: 'step_limit',
          blockerType: 'INFRASTRUCTURE',
          terminalReason: 'agent_step_limit_reached',
          steps: [],
          receipts: [],
          verificationResults: [],
          observations: [],
          summary: null,
          evidence: [],
          evidenceRefs: [],
          missingEvidenceKinds: [],
          unverifiedMeaningfulActions: 0,
          helpQuestion: null,
          diagnostics: [],
        }],
        statistics: {
          ...agent.orchestrator!.statistics,
          assigned: 1,
          stepLimit: 1,
        },
      },
    });
    const coverage = buildAgentCoverage(parsed, {
      runId: 'qa-test',
      artifactRoot: process.cwd(),
      generatedAt: now,
      deterministicStatus: 'PASSED',
      agentMode: 'enabled',
    });
    const roleScenario = coverage.scenarios.find(
      ({ id }) => id === 'agent-office-office-invoice-review',
    )!;

    assert.equal(roleScenario.status, 'BLOCKED');
    assert.equal(roleScenario.blockerType, 'INFRASTRUCTURE');
    assert.equal(exitDecision([roleScenario], [], false).runStatus, 'BLOCKED');
  });

  test('documents payer replay and bank reason as verified rather than open blockers', () => {
    const openQuestions = readFileSync(path.join(process.cwd(), 'qa', 'OPEN-QUESTIONS.md'), 'utf8');
    assert.doesNotMatch(openQuestions, /^\| Retry תשלום דרך UI /m);
    assert.doesNotMatch(openQuestions, /^\| סיבת ייבוא בנק /m);
    assert.match(openQuestions, /replay של ביצוע תשלום נבדק כפעולה idempotent/);
    assert.match(openQuestions, /שדה סיבת ייבוא הבנק מחובר ל־label נגיש ונבדק/);
  });

  test('creates a coverage exception for every role when agents are missing or disabled', () => {
    for (const configuration of [
      { agentMode: 'enabled' as const, status: 'BLOCKED', required: true, roleStatus: 'BLOCKED' },
      {
        agentMode: 'disabled' as const,
        status: 'SKIPPED_BY_CONFIGURATION',
        required: false,
        roleStatus: 'SKIPPED_BY_CONFIGURATION',
      },
    ]) {
      const coverage = buildAgentCoverage(null, {
        runId: 'qa-test',
        artifactRoot: process.cwd(),
        generatedAt: now,
        deterministicStatus: 'PASSED',
        agentMode: configuration.agentMode,
      });
      const exceptions = coverageExceptions(coverage.scenarios);
      const playwrightCoverage = QA_ROLES.map((role) => scenario('PASSED', {
        id: `playwright-${role}`,
        name: `playwright ${role}`,
        role,
      }));
      const roleReports = buildRoles(
        [...playwrightCoverage, ...coverage.scenarios],
        [],
        coverage.roleRuns,
        false,
      );

      for (const role of QA_ROLES) {
        const item = exceptions.find((candidate) => candidate.role === role);
        assert.equal(item?.status, configuration.status);
        assert.equal(item?.required, configuration.required);
        assert.equal(roleReports.find((candidate) => candidate.role === role)?.status, configuration.roleStatus);
      }
    }
  });

  test('blocks completion when cleanup.json proof is missing', () => {
    const cleanup = cleanupVerificationScenario(null, now);
    assert.equal(cleanup.required, true);
    assert.equal(cleanup.status, 'BLOCKED');
    assert.equal(cleanup.blockerType, 'INFRASTRUCTURE');
    assert.match(cleanup.limitation ?? '', /cleanup\.json חסר/);
    assert.equal(exitDecision([cleanup], [], false).runStatus, 'BLOCKED');
    assert.equal(coverageExceptions([cleanup])[0]?.id, 'cleanup-verification');
  });

  test('derives accessible areas only from completed open receipts and keeps permission outcomes structured', () => {
    const openDecision = {
      decision: 'action',
      reason: 'open the dashboard',
      action: {
        type: 'open',
        route: '/dashboard',
        target: null,
        value: null,
        fixtureName: null,
        key: null,
        direction: null,
        text: null,
        label: null,
      },
      expectedObservation: null,
      meaningfulBusinessAction: false,
      verification: null,
      observations: [],
      helpQuestion: null,
      finishStatus: null,
      finishSummary: null,
    };
    assert.deepEqual(completedOpenAreas([{
      decision: openDecision,
      receipt: {
        step: 1,
        actionType: 'open',
        status: 'completed',
        summary: 'opened:/dashboard',
        verificationStatus: 'not_requested',
        evidenceRefs: [],
      },
    }, {
      decision: openDecision,
      receipt: {
        step: 2,
        actionType: 'open',
        status: 'failed',
        summary: 'opened:/dashboard',
        verificationStatus: 'not_requested',
        evidenceRefs: [],
      },
    }]), ['/dashboard']);

    const permissionFinding = createFinding({
      runId: 'qa-test',
      source: 'security',
      role: 'owner',
      scenarioId: 'owner-permission',
      scenarioName: 'owner permission',
      route: '/platform',
      title: 'unexpectedly accessible route',
      category: 'authorization',
      severity: 'high',
      confidence: 1,
      reproducibility: 'persistent',
      status: 'confirmed',
      expected: 'access denied',
      actual: 'route allowed',
      userImpact: 'permission boundary failed',
      reproductionSteps: ['open route'],
      evidence: { screenshots: ['permission.png'] },
      humanReviewRequired: false,
      createdAt: now,
    });
    const owner = buildRoles([
      scenario('PASSED', { id: 'owner-permission', name: 'owner permission', role: 'owner' }),
    ], [permissionFinding], new Map(), false).find(({ role }) => role === 'owner')!;
    assert.deepEqual(owner.accessibleAreas, []);
    assert.deepEqual(owner.unexpectedlyAccessibleAreas, []);
    assert.deepEqual(owner.unexpectedlyInaccessibleAreas, []);
    assert.equal(owner.permissionDefects.length, 1);
  });
});

describe('Playwright result parsing', () => {
  test('preserves retries and converts failures without accepting outside evidence paths', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'supplyflow-playwright-report-'));
    writeFileSync(path.join(root, 'evidence.json'), '{}\n', 'utf8');
    try {
      const parsed = parsePlaywrightReport({
      suites: [{
        title: 'route matrix',
        specs: [{
          title: 'authorization',
          file: 'route.spec.ts',
          tests: [{
            projectName: 'role-supplier',
            results: [
              { status: 'failed', duration: 10, startTime: now, error: { message: 'denied assertion' }, attachments: [] },
              {
                status: 'passed',
                duration: 5,
                startTime: now,
                attachments: [
                  { name: 'redacted-browser-evidence', path: path.join(root, 'evidence.json') },
                  { name: 'outside', path: path.join(process.cwd(), 'secret.txt') },
                ],
              },
            ],
          }],
        }],
      }],
      }, { runId: 'run-1', artifactRoot: root, generatedAt: now });
      assert.equal(parsed.scenarios[0]?.status, 'PASSED');
      assert.deepEqual(parsed.scenarios[0]?.evidence, ['evidence.json']);
      assert.equal(parsed.findings[0]?.reproducibility, 'intermittent');
      assert.equal(parsed.findings[0]?.status, 'observation');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('marks missing execution results as blocked', () => {
    const parsed = parsePlaywrightReport({
      suites: [{ specs: [{ title: 'missing', file: 'missing.spec.ts', tests: [{ projectName: 'role-owner', results: [] }] }] }],
    }, { runId: 'run-1', artifactRoot: process.cwd(), generatedAt: now });
    assert.equal(parsed.scenarios[0]?.status, 'BLOCKED');
  });

  test('marks explicit critical skips as required blockers and rejects missing attachments', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'supplyflow-playwright-report-'));
    try {
      const blocked = parsePlaywrightReport({
        suites: [{ specs: [{
          title: '[critical:payer-transfer-execution] retry',
          file: 'critical-workflows.spec.ts',
          tests: [{
            projectName: 'critical-workflows',
            annotations: [{ type: 'skip', description: 'BLOCKED payer-transfer-execution: retry unavailable' }],
            results: [{ status: 'skipped', duration: 1, attachments: [] }],
          }],
        }] }],
      }, { runId: 'run-1', artifactRoot: root, generatedAt: now });
      assert.equal(blocked.scenarios[0]?.status, 'BLOCKED');
      assert.equal(blocked.scenarios[0]?.required, true);
      assert.equal(blocked.scenarios[0]?.role, 'payer');

      const skipped = parsePlaywrightReport({
        suites: [{ specs: [{
          title: 'accountant-only export',
          file: 'export.spec.ts',
          tests: [{
            projectName: 'role-owner',
            annotations: [{ type: 'skip', description: 'This smoke belongs to export-capable roles.' }],
            results: [{ status: 'skipped', duration: 1, attachments: [] }],
          }],
        }] }],
      }, { runId: 'run-1', artifactRoot: root, generatedAt: now });
      assert.equal(skipped.scenarios[0]?.status, 'SKIPPED_BY_CONFIGURATION');
      assert.equal(skipped.scenarios[0]?.required, false);
      assert.equal(skipped.scenarios[0]?.limitation, 'This smoke belongs to export-capable roles.');

      assert.throws(() => parsePlaywrightReport({
        suites: [{ specs: [{
          title: 'missing attachment',
          file: 'example.spec.ts',
          tests: [{
            projectName: 'role-owner',
            results: [{ status: 'failed', duration: 1, attachments: [{ name: 'evidence', path: path.join(root, 'missing.json') }] }],
          }],
        }] }],
      }, { runId: 'run-1', artifactRoot: root, generatedAt: now }), /missing managed attachment/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
