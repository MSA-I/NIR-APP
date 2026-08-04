import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { exitDecision, roleScorecards, statistics } from '../../reporting/aggregate.ts';
import { redactText, redactUnknown } from '../../reporting/redact.ts';
import { parsePlaywrightReport } from '../../reporting/playwright.ts';
import { FindingSchema, type RoleResult, type ScenarioResult } from '../../reporting/schemas.ts';

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
  test('blocks required coverage and high confirmed findings', () => {
    assert.equal(exitDecision([scenario('BLOCKED')], [], false).status, 'BLOCKED');
    assert.equal(exitDecision([scenario('PASSED')], [finding()], false).status, 'FAILED');
    assert.equal(exitDecision([scenario('PASSED')], [], false).status, 'PASSED');
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
      successfulTasks: [],
      blockedTasks: [],
      inaccessibleAreas: [],
      unexpectedAccessibleAreas: [],
      evidence: [],
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
