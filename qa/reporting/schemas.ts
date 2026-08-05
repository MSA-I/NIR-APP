import { z } from 'zod';

export const RunStatusSchema = z.enum([
  'PASSED',
  'FAILED',
  'BLOCKED',
  'SKIPPED_BY_CONFIGURATION',
  'OPTIONAL_BLOCKED',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunExecutionStatusSchema = z.enum(['COMPLETED', 'BLOCKED', 'INFRASTRUCTURE_FAILED']);
export type RunExecutionStatus = z.infer<typeof RunExecutionStatusSchema>;

export const ProductQualityStatusSchema = z.enum(['PASS', 'PASS_WITH_FINDINGS', 'FAIL']);
export type ProductQualityStatus = z.infer<typeof ProductQualityStatusSchema>;

export const BlockerTypeSchema = z.enum(['PRODUCT', 'INFRASTRUCTURE', 'CONFIGURATION']);
export type BlockerType = z.infer<typeof BlockerTypeSchema>;

export const FindingSourceSchema = z.enum([
  'playwright',
  'agent',
  'database',
  'network',
  'console',
  'accessibility',
  'export',
  'security',
]);

export const FindingCategorySchema = z.enum([
  'functional',
  'authorization',
  'security',
  'data_integrity',
  'accessibility',
  'usability',
  'visual',
  'performance',
  'resilience',
  'copy',
  'rtl',
  'infrastructure',
]);

export const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);
export type Severity = z.infer<typeof SeveritySchema>;

export const FindingEvidenceSchema = z.object({
  screenshots: z.array(z.string()).optional(),
  trace: z.string().optional(),
  console: z.array(z.string()).optional(),
  network: z.array(z.string()).optional(),
  database: z.array(z.string()).optional(),
  accessibility: z.array(z.string()).optional(),
  downloads: z.array(z.string()).optional(),
  actionTrace: z.string().optional(),
}).strict();

export const FindingSchema = z.object({
  id: z.string().min(1),
  fingerprint: z.string().regex(/^[a-f0-9]{32}$/),
  runId: z.string().min(1),
  source: FindingSourceSchema,
  role: z.string().min(1),
  scenarioId: z.string().min(1),
  scenarioName: z.string().min(1),
  route: z.string().optional(),
  step: z.number().int().nonnegative().optional(),
  title: z.string().min(1),
  category: FindingCategorySchema,
  severity: SeveritySchema,
  confidence: z.number().min(0).max(1),
  reproducibility: z.enum(['persistent', 'intermittent', 'single_observation', 'not_retested']),
  status: z.enum(['confirmed', 'probable', 'observation', 'blocked', 'false_positive']),
  expected: z.string().optional(),
  actual: z.string().optional(),
  userImpact: z.string().min(1),
  businessImpact: z.string().optional(),
  reproductionSteps: z.array(z.string()),
  evidence: FindingEvidenceSchema,
  recommendedFix: z.string().optional(),
  humanReviewRequired: z.boolean(),
  createdAt: z.string().datetime(),
  affectedRoles: z.array(z.string()).default([]),
  affectedScenarios: z.array(z.string()).default([]),
  reproductionCount: z.number().int().positive().default(1),
  firstOccurrence: z.string().datetime(),
  latestOccurrence: z.string().datetime(),
}).strict();
export type Finding = z.infer<typeof FindingSchema>;

export const StepResultSchema = z.object({
  step: z.number().int().nonnegative(),
  name: z.string().min(1),
  status: RunStatusSchema,
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  durationMs: z.number().nonnegative(),
  route: z.string().optional(),
  evidence: z.array(z.string()).default([]),
  message: z.string().optional(),
}).strict();
export type StepResult = z.infer<typeof StepResultSchema>;

export const ScenarioResultSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string().min(1),
  required: z.boolean(),
  status: RunStatusSchema,
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  durationMs: z.number().nonnegative(),
  steps: z.array(StepResultSchema),
  findingIds: z.array(z.string()),
  evidence: z.array(z.string()),
  limitation: z.string().optional(),
  blockerType: BlockerTypeSchema.optional(),
}).strict();
export type ScenarioResult = z.infer<typeof ScenarioResultSchema>;

export const CoverageExceptionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string().min(1),
  reason: z.string().min(1),
  required: z.boolean(),
  status: z.enum(['BLOCKED', 'SKIPPED_BY_CONFIGURATION', 'OPTIONAL_BLOCKED']),
  blockerType: BlockerTypeSchema,
}).strict();
export type CoverageException = z.infer<typeof CoverageExceptionSchema>;

export const RoleResultSchema = z.object({
  role: z.string().min(1),
  purpose: z.string().min(1),
  status: RunStatusSchema,
  scenarioIds: z.array(z.string()),
  tasksAttempted: z.array(z.string()),
  tasksCompleted: z.array(z.string()),
  tasksBlocked: z.array(z.string()),
  accessibleAreas: z.array(z.string()),
  unexpectedlyInaccessibleAreas: z.array(z.string()),
  unexpectedlyAccessibleAreas: z.array(z.string()),
  functionalDefects: z.array(z.string()),
  permissionDefects: z.array(z.string()),
  accessibilityFindings: z.array(z.string()),
  usabilityObservations: z.array(z.string()),
  unclearWording: z.array(z.string()),
  recoveryProblems: z.array(z.string()),
  evidence: z.array(z.string()),
  confidence: z.number().min(0).max(1).nullable(),
  recommendations: z.array(z.string()),
  limitations: z.array(z.string()),
}).strict();
export type RoleResult = z.infer<typeof RoleResultSchema>;

export const EnvironmentSchema = z.object({
  target: z.literal('local-isolated'),
  baseUrl: z.string().url(),
  supabaseUrl: z.string().url(),
  projectId: z.literal('supplyflow-p0'),
  gitSha: z.string().min(7),
  gitBranch: z.string().min(1),
  nodeVersion: z.string().min(1),
  browserVersion: z.string().optional(),
  timezone: z.literal('Asia/Jerusalem'),
  locale: z.literal('he-IL'),
  localProof: z.array(z.string()),
}).strict();

export const RoleScoreSchema = z.object({
  role: z.string(),
  status: z.enum(['OK', 'DEGRADED', 'BLOCKED_BY_HIGH', 'BLOCKED_BY_CRITICAL', 'NO_EVIDENCE']),
  coreTaskCompletion: z.number().min(0).max(100).nullable(),
  correctPermissions: z.number().min(0).max(100).nullable(),
  errorRecovery: z.number().min(0).max(100).nullable(),
  accessibility: z.number().min(0).max(100).nullable(),
  mobileUsability: z.number().min(0).max(100).nullable(),
  clarity: z.number().min(0).max(100).nullable(),
  dataCorrectness: z.number().min(0).max(100).nullable(),
  stability: z.number().min(0).max(100).nullable(),
}).strict();
export type RoleScore = z.infer<typeof RoleScoreSchema>;

export const RunReportSchema = z.object({
  schemaVersion: z.literal(2),
  runId: z.string().min(1),
  generatedAt: z.string().datetime(),
  runStatus: RunExecutionStatusSchema,
  productQualityStatus: ProductQualityStatusSchema,
  environment: EnvironmentSchema,
  scenarios: z.array(ScenarioResultSchema),
  roles: z.array(RoleResultSchema),
  findings: z.array(FindingSchema),
  scorecards: z.array(RoleScoreSchema),
  statistics: z.object({
    bySeverity: z.record(z.string(), z.number().int().nonnegative()),
    byCategory: z.record(z.string(), z.number().int().nonnegative()),
    byStatus: z.record(z.string(), z.number().int().nonnegative()),
    passedScenarios: z.number().int().nonnegative(),
    failedScenarios: z.number().int().nonnegative(),
    blockedScenarios: z.number().int().nonnegative(),
    skippedScenarios: z.number().int().nonnegative(),
    optionalBlockedScenarios: z.number().int().nonnegative(),
    flakyScenarios: z.number().int().nonnegative(),
  }).strict(),
  coverageExceptions: z.array(CoverageExceptionSchema),
  limitations: z.array(z.string()),
  humanTestingRequired: z.array(z.string()),
  evidencePaths: z.array(z.string()),
  exitDecision: z.object({
    runStatus: RunExecutionStatusSchema,
    productQualityStatus: ProductQualityStatusSchema,
    exitCode: z.number().int().nonnegative(),
    reasons: z.array(z.string()),
  }).strict(),
}).strict().superRefine((report, context) => {
  if (report.runStatus !== report.exitDecision.runStatus
      || report.productQualityStatus !== report.exitDecision.productQualityStatus) {
    context.addIssue({
      code: 'custom',
      path: ['exitDecision'],
      message: 'Top-level statuses must match the exit decision.',
    });
  }
  const expectedExitCode = report.runStatus === 'BLOCKED'
    ? 2
    : report.runStatus === 'INFRASTRUCTURE_FAILED' || report.productQualityStatus === 'FAIL' ? 1 : 0;
  if (report.exitDecision.exitCode !== expectedExitCode) {
    context.addIssue({
      code: 'custom',
      path: ['exitDecision', 'exitCode'],
      message: 'Exit code does not match run and product quality statuses.',
    });
  }
  const expected = report.scenarios.filter((scenario) =>
    scenario.status === 'BLOCKED'
      || scenario.status === 'SKIPPED_BY_CONFIGURATION'
      || scenario.status === 'OPTIONAL_BLOCKED');
  if (expected.length !== report.coverageExceptions.length) {
    context.addIssue({
      code: 'custom',
      path: ['coverageExceptions'],
      message: 'Every blocked or skipped scenario must have exactly one coverage exception.',
    });
    return;
  }
  for (const scenario of expected) {
    const matches = report.coverageExceptions.filter((item) =>
      item.id === scenario.id
        && item.name === scenario.name
        && item.role === scenario.role
        && item.required === scenario.required
        && item.status === scenario.status);
    if (matches.length !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['coverageExceptions'],
        message: `Coverage exception is missing or ambiguous for scenario ${scenario.id}.`,
      });
    }
  }
});
export type RunReport = z.infer<typeof RunReportSchema>;
