import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { statistics, exitDecision, roleScorecards } from '../../reporting/aggregate.ts';
import { createFinding } from '../../reporting/finding.ts';
import { generateReports } from '../../reporting/generate.ts';
import { RunReportSchema, type RoleResult, type ScenarioResult } from '../../reporting/schemas.ts';

test('generates redacted JSON, Hebrew Markdown, role reports and standalone HTML', async () => {
  const root = path.join(process.cwd(), '.qa-test-' + randomUUID());
  const timestamp = '2026-08-04T10:00:00.000Z';
  const scenario: ScenarioResult = {
    id: 'owner-core',
    name: 'מסע ליבה לבעלים',
    role: 'owner',
    required: true,
    status: 'FAILED',
    startedAt: timestamp,
    endedAt: timestamp,
    durationMs: 12,
    steps: [],
    findingIds: [],
    evidence: ['evidence/shot.png'],
  };
  const role: RoleResult = {
    role: 'owner',
    purpose: 'קבלת החלטות ואישור חריגים',
    status: 'FAILED',
    scenarioIds: [scenario.id],
    successfulTasks: [],
    blockedTasks: ['שמירה'],
    inaccessibleAreas: [],
    unexpectedAccessibleAreas: [],
    evidence: scenario.evidence,
    limitations: ['נדרשת בדיקת קורא מסך אנושית'],
  };
  const finding = createFinding({
    runId: 'qa-test-run',
    source: 'playwright',
    role: 'owner',
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    title: 'שמירה נכשלה',
    category: 'functional',
    severity: 'high',
    confidence: 1,
    reproducibility: 'persistent',
    status: 'confirmed',
    expected: 'שמירה',
    actual: 'contact owner@example.com',
    userImpact: 'לא ניתן להשלים תהליך ליבה',
    reproductionSteps: ['פתח', 'שמור'],
    evidence: { screenshots: ['evidence/shot.png'], trace: 'evidence/trace.zip' },
    humanReviewRequired: false,
    createdAt: timestamp,
  });
  scenario.findingIds.push(finding.id);
  const decision = exitDecision([scenario], [finding], false);
  const report = RunReportSchema.parse({
    schemaVersion: 1,
    runId: 'qa-test-run',
    generatedAt: timestamp,
    overallStatus: decision.status,
    environment: {
      target: 'local-isolated',
      baseUrl: 'http://127.0.0.1:4173',
      supabaseUrl: 'http://127.0.0.1:55431',
      projectId: 'supplyflow-p0',
      gitSha: '366ba767',
      gitBranch: 'codex/qa-multi-agent',
      nodeVersion: process.version,
      timezone: 'Asia/Jerusalem',
      locale: 'he-IL',
      localProof: ['loopback URL'],
    },
    scenarios: [scenario],
    roles: [role],
    findings: [finding],
    scorecards: roleScorecards([role], [scenario], [finding]),
    statistics: statistics([scenario], [finding]),
    blockedItems: [],
    limitations: role.limitations,
    humanTestingRequired: ['קורא מסך אמיתי'],
    evidencePaths: scenario.evidence,
    exitDecision: decision,
  });

  try {
    const files = await generateReports(root, report);
    assert.equal(files.length, 4);
    const json = await readFile(path.join(root, 'report.json'), 'utf8');
    const markdown = await readFile(path.join(root, 'executive.he.md'), 'utf8');
    const html = await readFile(path.join(root, 'report.html'), 'utf8');
    assert.match(json, /\[EMAIL_REDACTED\]/);
    assert.doesNotMatch(json, /owner@example\.com/);
    assert.match(markdown, /דוח QA מנהלים/);
    assert.match(html, /<html lang="he" dir="rtl">/);
    assert.doesNotMatch(html, /https?:\/\/(?:cdn|unpkg|jsdelivr)/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
