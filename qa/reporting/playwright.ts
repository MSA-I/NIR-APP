import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { createFinding, retryClassification, severityFor } from './finding.ts';
import { redactText } from './redact.ts';
import type { Finding, ScenarioResult, StepResult } from './schemas.ts';

const PLAYWRIGHT_INFRASTRUCTURE_FAILURE = /(?:target\s+(?:page,\s*context\s+or\s+browser|page|context|browser)\s+(?:has\s+been\s+)?closed|target\s+crashed|browser(?:type)?\.launch|browser\s+process\s+exited|worker\s+process\s+exited|executable\s+doesn['’]?t\s+exist|protocol\s+error|(?:net::)?err_connection_(?:refused|reset)|econnrefused|\benoent\b|qa\s+mutex|environment\s+lock|chromium\s+(?:is\s+)?(?:missing|unavailable)|preview\s+(?:is\s+)?(?:missing|unavailable|not\s+ready|stopped)|fixture[^\n]*(?:missing|unavailable)|verifier[^\n]*(?:missing|unavailable)|evidence[^\n]*(?:missing|unavailable|malformed)|report[^\n]*(?:missing|unavailable|malformed))/i;

export function isPlaywrightInfrastructureFailureText(value: string): boolean {
  return PLAYWRIGHT_INFRASTRUCTURE_FAILURE.test(value);
}

const AttachmentSchema = z.object({
  name: z.string(),
  contentType: z.string().optional(),
  path: z.string().optional(),
}).passthrough();

const AnnotationSchema = z.object({
  type: z.string(),
  description: z.string().optional(),
}).passthrough();

const ResultSchema = z.object({
  status: z.string(),
  duration: z.number().nonnegative().default(0),
  startTime: z.string().optional(),
  error: z.object({ message: z.string().optional() }).passthrough().optional(),
  errors: z.array(z.object({ message: z.string().optional() }).passthrough()).optional(),
  attachments: z.array(AttachmentSchema).default([]),
}).passthrough();

const TestSchema = z.object({
  projectName: z.string(),
  results: z.array(ResultSchema),
  annotations: z.array(AnnotationSchema).default([]),
}).passthrough();

const SpecSchema = z.object({
  title: z.string(),
  file: z.string().default('unknown'),
  tests: z.array(TestSchema),
}).passthrough();

type Suite = {
  title?: string;
  specs?: z.infer<typeof SpecSchema>[];
  suites?: Suite[];
};

const SuiteSchema: z.ZodTypeAny = z.lazy(() => z.object({
  title: z.string().optional(),
  specs: z.array(SpecSchema).optional(),
  suites: z.array(SuiteSchema).optional(),
}).passthrough());

const PlaywrightReportSchema = z.object({
  suites: z.array(SuiteSchema),
}).passthrough();

function identifier(project: string, file: string, title: string): string {
  return 'pw-' + createHash('sha256').update([project, file, title].join('|')).digest('hex').slice(0, 16);
}

function runStatus(value: string | undefined, blocked = false): ScenarioResult['status'] {
  if (value === 'passed') return 'PASSED';
  if (value === 'skipped' && blocked) return 'BLOCKED';
  if (value === 'skipped') return 'SKIPPED_BY_CONFIGURATION';
  if (!value) return 'BLOCKED';
  return 'FAILED';
}

function category(title: string): Finding['category'] {
  if (/authorization|permission|route matrix|rls/i.test(title)) return 'authorization';
  if (/axe|accessibility|keyboard/i.test(title)) return 'accessibility';
  if (/export|download|xlsx/i.test(title)) return 'data_integrity';
  if (/tenant|supplier isolation|security/i.test(title)) return 'security';
  return 'functional';
}

function timestamp(value: string | undefined, fallback: string): string {
  const parsed = value ? new Date(value) : new Date(fallback);
  return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : fallback;
}

function relativeEvidence(root: string, candidate: string | undefined): string | undefined {
  if (!candidate) return undefined;
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  let details;
  try {
    details = statSync(path.resolve(candidate));
  } catch {
    throw new Error('Playwright report references a missing managed attachment.');
  }
  if (!details.isFile()) throw new Error('Playwright report attachment is not a regular file.');
  return relative.replaceAll('\\', '/');
}

function evidencePaths(root: string, attachments: z.infer<typeof AttachmentSchema>[]): string[] {
  return attachments.flatMap((attachment) => {
    const value = relativeEvidence(root, attachment.path);
    return value ? [value] : [];
  });
}

function steps(
  results: z.infer<typeof ResultSchema>[],
  artifactRoot: string,
  generatedAt: string,
  blocked: boolean,
): StepResult[] {
  return results.map((result, index) => {
    const startedAt = timestamp(result.startTime, generatedAt);
    return {
      step: index,
      name: index === 0 ? 'attempt' : 'retry ' + index,
      status: runStatus(result.status, blocked),
      startedAt,
      endedAt: new Date(new Date(startedAt).valueOf() + result.duration).toISOString(),
      durationMs: result.duration,
      evidence: evidencePaths(artifactRoot, result.attachments),
      message: result.status === 'passed' ? undefined : redactText(
        result.error?.message
          ?? result.errors?.map((error) => error.message).filter(Boolean).join('; ')
          ?? result.status,
      ),
    };
  });
}

function collectSpecs(suite: Suite, parents: readonly string[] = []): Array<{
  title: string;
  file: string;
  tests: z.infer<typeof TestSchema>[];
}> {
  const prefix = suite.title ? [...parents, suite.title] : [...parents];
  const own = (suite.specs ?? []).map((spec) => ({
    title: [...prefix, spec.title].filter(Boolean).join(' › '),
    file: spec.file,
    tests: spec.tests,
  }));
  return [...own, ...(suite.suites ?? []).flatMap((child) => collectSpecs(child, prefix))];
}

export interface ParsedPlaywrightResults {
  scenarios: ScenarioResult[];
  findings: Finding[];
}

export function parsePlaywrightReport(
  input: unknown,
  options: { runId: string; artifactRoot: string; generatedAt?: string },
): ParsedPlaywrightResults {
  const report = PlaywrightReportSchema.parse(input) as { suites: Suite[] };
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const scenarios: ScenarioResult[] = [];
  const findings: Finding[] = [];

  for (const spec of report.suites.flatMap((suite) => collectSpecs(suite))) {
    for (const test of spec.tests) {
      const id = identifier(test.projectName, spec.file, spec.title);
      const skipReason = test.annotations
        .find(({ type, description }) => type === 'skip' && description?.trim())?.description?.trim();
      const blockedReason = skipReason?.startsWith('BLOCKED ') ? skipReason : undefined;
      const attempts = steps(test.results, options.artifactRoot, generatedAt, Boolean(blockedReason));
      const final = test.results.at(-1);
      const status = runStatus(final?.status, Boolean(blockedReason));
      const criticalRole = spec.title.match(/\[critical:(supplier|kitchen|office|owner|payer|accountant)-/)?.[1];
      const role = criticalRole ?? (test.projectName.startsWith('role-')
        ? test.projectName.slice('role-'.length)
        : 'system');
      const evidence = [...new Set(attempts.flatMap((attempt) => attempt.evidence))];
      const scenario: ScenarioResult = {
        id,
        name: spec.title,
        role,
        required: Boolean(blockedReason) || status !== 'SKIPPED_BY_CONFIGURATION',
        status,
        startedAt: attempts[0]?.startedAt ?? generatedAt,
        endedAt: attempts.at(-1)?.endedAt ?? generatedAt,
        durationMs: attempts.reduce((total, attempt) => total + attempt.durationMs, 0),
        steps: attempts,
        findingIds: [],
        evidence,
        limitation: status === 'BLOCKED'
          ? redactText(blockedReason ?? 'Playwright did not return an execution result.')
          : status === 'SKIPPED_BY_CONFIGURATION'
            ? redactText(skipReason ?? 'Playwright skipped this configured project.')
            : undefined,
      };

      const attemptPasses = test.results.map((result) => result.status === 'passed');
      const flaky = status === 'PASSED' && attemptPasses.some((passed) => !passed);
      if (status === 'FAILED' || flaky) {
        const findingCategory = flaky ? 'resilience' : category(spec.title);
        const attachments = final?.attachments ?? [];
        const trace = attachments.find(({ name, contentType }) =>
          /trace/i.test(name) || contentType === 'application/zip');
        const screenshots = attachments
          .filter(({ contentType, name }) => contentType?.startsWith('image/') || /screenshot/i.test(name))
          .flatMap((attachment) => {
            const value = relativeEvidence(options.artifactRoot, attachment.path);
            return value ? [value] : [];
          });
        const actual = redactText(
          final?.error?.message
            ?? final?.errors?.map((error) => error.message).filter(Boolean).join('; ')
            ?? (flaky ? 'The test passed only after a retry.' : 'Playwright test failed.'),
        );
        const userImpact = flaky
          ? 'התרחיש אינו יציב ודורש אימות חוזר לפני הסתמכות על התוצאה.'
          : 'המשתמש אינו יכול להשלים את הבדיקה הדטרמיניסטית כצפוי.';
        const finding = createFinding({
          runId: options.runId,
          source: 'playwright',
          role,
          scenarioId: id,
          scenarioName: spec.title,
          title: flaky ? 'תרחיש עבר רק לאחר retry' : 'בדיקת Playwright נכשלה',
          category: findingCategory,
          severity: severityFor(findingCategory, flaky ? 'intermittent test' : 'cannot complete core workflow'),
          confidence: flaky ? 0.8 : 1,
          reproducibility: retryClassification(attemptPasses),
          status: flaky ? 'observation' : 'confirmed',
          expected: 'התרחיש יסתיים ללא כשל.',
          actual,
          userImpact,
          reproductionSteps: ['הרץ את ' + spec.title + ' בפרויקט ' + test.projectName + '.'],
          evidence: {
            screenshots,
            trace: relativeEvidence(options.artifactRoot, trace?.path),
            actionTrace: evidence.find((value) => /evidence\.json$/i.test(value)),
          },
          humanReviewRequired: flaky,
          createdAt: scenario.endedAt,
        });
        scenario.findingIds.push(finding.id);
        findings.push(finding);
      }
      scenarios.push(scenario);
    }
  }
  return { scenarios, findings };
}

export async function readPlaywrightReport(
  filePath: string,
  options: { runId: string; artifactRoot: string; generatedAt?: string },
): Promise<ParsedPlaywrightResults> {
  return parsePlaywrightReport(JSON.parse(await readFile(filePath, 'utf8')) as unknown, options);
}
