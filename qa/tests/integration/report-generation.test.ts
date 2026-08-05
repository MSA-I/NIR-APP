import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { coverageExceptions, statistics, exitDecision, roleScorecards } from '../../reporting/aggregate.ts';
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
    blockerType: 'PRODUCT',
  };
  const role: RoleResult = {
    role: 'owner',
    purpose: 'קבלת החלטות ואישור חריגים',
    status: 'FAILED',
    scenarioIds: [scenario.id],
    tasksAttempted: ['שמירה'],
    tasksCompleted: [],
    tasksBlocked: ['שמירה'],
    accessibleAreas: ['/dashboard'],
    unexpectedlyInaccessibleAreas: ['/orders'],
    unexpectedlyAccessibleAreas: [],
    functionalDefects: ['high: שמירה נכשלה'],
    permissionDefects: [],
    accessibilityFindings: [],
    usabilityObservations: [],
    unclearWording: [],
    recoveryProblems: [],
    evidence: scenario.evidence,
    confidence: 1,
    recommendations: ['לתקן את השמירה'],
    limitations: ['נדרשת בדיקת קורא מסך אנושית'],
  };
  const optionalPlatform: ScenarioResult = {
    id: 'platform-admin',
    name: 'ניהול פלטפורמה',
    role: 'platform',
    required: false,
    status: 'OPTIONAL_BLOCKED',
    startedAt: timestamp,
    endedAt: timestamp,
    durationMs: 0,
    steps: [],
    findingIds: [],
    evidence: [],
    limitation: 'fixture מאושר אינו זמין',
    blockerType: 'CONFIGURATION',
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
  const decision = exitDecision([scenario, optionalPlatform], [finding], false);
  const report = RunReportSchema.parse({
    schemaVersion: 2,
    runId: 'qa-test-run',
    generatedAt: timestamp,
    runStatus: decision.runStatus,
    productQualityStatus: decision.productQualityStatus,
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
    scenarios: [scenario, optionalPlatform],
    roles: [role],
    findings: [finding],
    scorecards: roleScorecards([role], [scenario, optionalPlatform], [finding]),
    statistics: statistics([scenario, optionalPlatform], [finding]),
    coverageExceptions: coverageExceptions([scenario, optionalPlatform]),
    limitations: role.limitations,
    humanTestingRequired: ['קורא מסך אמיתי'],
    evidencePaths: scenario.evidence,
    exitDecision: decision,
  });
  assert.throws(
    () => RunReportSchema.parse({ ...report, coverageExceptions: [] }),
    /Every blocked or skipped scenario/,
  );

  try {
    const files = await generateReports(root, report);
    assert.equal(files.length, 4);
    const json = await readFile(path.join(root, 'report.json'), 'utf8');
    const markdown = await readFile(path.join(root, 'executive.he.md'), 'utf8');
    const html = await readFile(path.join(root, 'report.html'), 'utf8');
    assert.match(json, /\[EMAIL_REDACTED\]/);
    assert.doesNotMatch(json, /owner@example\.com/);
    assert.match(json, /"optionalBlockedScenarios": 1/);
    assert.match(markdown, /דוח QA מנהלים/);
    assert.match(markdown, /מצב הריצה/);
    assert.match(markdown, /מצב איכות המוצר/);
    assert.match(markdown, /platform-admin/);
    assert.match(markdown, /fixture מאושר אינו זמין/);
    assert.match(html, /<html lang="he" dir="rtl">/);
    assert.match(html, /OPTIONAL_BLOCKED/);
    const roleMarkdown = await readFile(path.join(root, 'roles', 'owner', 'report.he.md'), 'utf8');
    for (const heading of ['משימות שנוסו', 'אזורים נגישים', 'תקלות הרשאה', 'ממצאי נגישות', 'תצפיות שימושיות', 'ניסוחים לא ברורים', 'בעיות התאוששות', 'ראיות', 'ביטחון', 'המלצות']) {
      assert.match(roleMarkdown, new RegExp(heading));
    }
    assert.match(roleMarkdown, /\.\.\/\.\.\/evidence\/shot\.png/);
    assert.doesNotMatch(html, /https?:\/\/(?:cdn|unpkg|jsdelivr)/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
