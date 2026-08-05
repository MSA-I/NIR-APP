import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  AgentEvidenceSchema,
  AgentObservationSchema,
  RoleStepDecisionSchema,
  RoleSummarySchema,
} from '../agents/contracts.ts';
import { BrowserMutationEvidenceSchema, VerifierResultSchema } from '../agents/verifier-agent.ts';
import { QA_ROLES, type QaRole } from '../config/roles.ts';
import { getScenario } from '../scenarios/index.ts';
import { coverageExceptions, exitDecision, roleScorecards, statistics } from '../reporting/aggregate.ts';
import { deduplicateFindings } from '../reporting/deduplicate.ts';
import { createFinding, enforceAgentEvidence } from '../reporting/finding.ts';
import { generateReports } from '../reporting/generate.ts';
import {
  isPlaywrightInfrastructureFailureText,
  readPlaywrightReport,
} from '../reporting/playwright.ts';
import { redactText, safeJson } from '../reporting/redact.ts';
import {
  EnvironmentSchema,
  RunReportSchema,
  type Finding,
  type BlockerType,
  type RoleResult,
  type RunReport,
  type RunStatus,
  type ScenarioResult,
  type StepResult,
} from '../reporting/schemas.ts';
import {
  LOCAL_QA_API_URL,
  LOCAL_QA_PROJECT_ID,
  assertIsolatedLocalTarget,
} from './lock.ts';
import { loadReadyQaState } from './runtime-state.ts';
import {
  QA_ARTIFACTS_RELATIVE_ROOT,
  QA_STATE_RELATIVE_PATH,
  type ReadyQaRunState,
} from './setup.ts';

const execFileAsync = promisify(execFile);
const RUN_ID_PATTERN = /^qa-\d{14}-[0-9a-f]{8}$/;
const REPORT_METADATA_RELATIVE_PATH = path.join('results', 'report-metadata.json');
const DETERMINISTIC_RESULT_RELATIVE_PATH = path.join('results', 'deterministic.json');
const AGENT_RESULT_RELATIVE_PATH = path.join('results', 'agents.json');
const CLEANUP_RESULT_RELATIVE_PATH = path.join('results', 'cleanup.json');
const PLAYWRIGHT_RESULT_RELATIVE_PATH = 'playwright-results.json';

const DeterministicPhaseSchema = z.object({
  name: z.string().min(1),
  status: z.enum(['PASSED', 'FAILED', 'BLOCKED', 'SKIPPED_BY_CONFIGURATION']),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().nonnegative(),
  reason: z.string().optional(),
}).strict();

const DeterministicRunSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  status: z.enum(['PASSED', 'FAILED', 'BLOCKED']),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  phases: z.array(DeterministicPhaseSchema),
  redactedTraces: z.array(z.string()),
  playwrightReport: z.string().min(1),
  exitCode: z.number().int().min(0).max(2),
}).strict();

const ModelReceiptSchema = z.object({
  step: z.number().int().nonnegative(),
  actionType: z.string().min(1),
  status: z.enum(['completed', 'failed', 'denied']),
  summary: z.string(),
  verificationStatus: z.enum(['verified', 'failed', 'blocked', 'not_requested']),
  evidenceRefs: z.array(z.string()),
}).strict();

const AgentRoleRunSchema = z.object({
  runId: z.string().min(1),
  role: z.enum(QA_ROLES),
  scenarioId: z.string().min(1),
  scenarioName: z.string().min(1),
  status: z.enum(['completed', 'blocked', 'failed', 'step_limit']),
  blockerType: z.enum(['PRODUCT', 'INFRASTRUCTURE', 'CONFIGURATION']).nullable(),
  terminalReason: z.string(),
  steps: z.array(z.object({
    step: z.number().int().nonnegative(),
    decision: z.unknown(),
    receipt: ModelReceiptSchema.nullable(),
  }).strict()),
  receipts: z.array(ModelReceiptSchema),
  verificationResults: z.array(z.object({
    step: z.number().int().nonnegative(),
    checkId: z.string().min(1),
    actionId: z.string().uuid().nullable().optional().default(null),
    mutationEvidence: BrowserMutationEvidenceSchema.nullable().optional().default(null),
    result: VerifierResultSchema,
  }).strict()),
  observations: z.array(AgentObservationSchema),
  summary: RoleSummarySchema.nullable(),
  evidence: z.array(AgentEvidenceSchema),
  evidenceRefs: z.array(z.string()),
  missingEvidenceKinds: z.array(z.string()),
  unverifiedMeaningfulActions: z.number().int().nonnegative(),
  helpQuestion: z.string().nullable(),
  diagnostics: z.array(z.string()),
}).strict().superRefine((result, context) => {
  const validPair = (result.status === 'completed' && result.blockerType === null)
    || (result.status === 'failed'
      && (result.blockerType === 'PRODUCT' || result.blockerType === 'INFRASTRUCTURE'))
    || (result.status === 'blocked'
      && (result.blockerType === 'INFRASTRUCTURE' || result.blockerType === 'CONFIGURATION'))
    || (result.status === 'step_limit' && result.blockerType === 'INFRASTRUCTURE');
  if (!validPair) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['blockerType'],
      message: 'blockerType must match the exact persisted role status contract.',
    });
  }
});

export const AgentRunSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  status: z.enum(['PASSED', 'FAILED', 'BLOCKED', 'SKIPPED_BY_CONFIGURATION']),
  blockerType: z.enum(['PRODUCT', 'INFRASTRUCTURE', 'CONFIGURATION']).nullable(),
  reason: z.string(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  orchestrator: z.object({
    runId: z.string().min(1),
    status: z.enum(['completed', 'partial', 'blocked', 'failed']),
    provider: z.string(),
    model: z.string().nullable(),
    roleResults: z.array(AgentRoleRunSchema),
    roleOrder: z.array(z.enum(QA_ROLES)),
    statistics: z.object({
      assigned: z.number().int().nonnegative(),
      completed: z.number().int().nonnegative(),
      blocked: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      stepLimit: z.number().int().nonnegative(),
      observations: z.number().int().nonnegative(),
      verifiedChecks: z.number().int().nonnegative(),
      unverifiedMeaningfulActions: z.number().int().nonnegative(),
    }).strict(),
    diagnostics: z.array(z.string()),
  }).strict().nullable(),
  evidencePaths: z.array(z.string()),
  exitCode: z.number().int().min(0).max(2),
}).strict().superRefine((result, context) => {
  const validPair = (result.status === 'PASSED' && result.blockerType === null)
    || (result.status === 'FAILED'
      && (result.blockerType === 'PRODUCT' || result.blockerType === 'INFRASTRUCTURE'))
    || (result.status === 'BLOCKED'
      && (result.blockerType === 'INFRASTRUCTURE' || result.blockerType === 'CONFIGURATION'))
    || (result.status === 'SKIPPED_BY_CONFIGURATION'
      && result.blockerType === 'CONFIGURATION');
  if (!validPair) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['blockerType'],
      message: 'blockerType must match the exact persisted agent status contract.',
    });
  }
});

const ReportMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().regex(RUN_ID_PATTERN),
  capturedAt: z.string().datetime(),
  agentMode: z.enum(['enabled', 'disabled']),
  environment: EnvironmentSchema,
}).strict();

const CleanupRunSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().regex(RUN_ID_PATTERN),
  status: z.enum(['CLEAN', 'FAILED', 'BLOCKED']),
  reason: z.string().min(1),
  resetPerformed: z.boolean(),
  artifactsPreserved: z.boolean(),
}).strict();

type StoredDeterministicRun = z.infer<typeof DeterministicRunSchema>;
export type StoredAgentRun = z.infer<typeof AgentRunSchema>;
type StoredAgentRoleRun = z.infer<typeof AgentRoleRunSchema>;
type ReportMetadata = z.infer<typeof ReportMetadataSchema>;
type StoredCleanupRun = z.infer<typeof CleanupRunSchema>;

export interface ReportRunnerOptions {
  repoRoot?: string;
  artifactRoot?: string;
  failOnMedium?: boolean;
  includePlatformAdmin?: boolean;
}

export interface ReportRunResult {
  schemaVersion: 2;
  runId: string | null;
  runStatus: 'COMPLETED' | 'BLOCKED' | 'INFRASTRUCTURE_FAILED';
  productQualityStatus: 'PASS' | 'PASS_WITH_FINDINGS' | 'FAIL';
  generatedAt: string;
  artifactRoot: string | null;
  reportPaths: string[];
  reason: string;
  exitCode: 0 | 1 | 2;
}

interface ReportContext {
  repoRoot: string;
  artifactRoot: string;
  metadata: ReportMetadata;
}

export interface AgentCoverage {
  scenarios: ScenarioResult[];
  findings: Finding[];
  blockedItems: string[];
  limitations: string[];
  humanTestingRequired: string[];
  evidencePaths: string[];
  roleRuns: Map<QaRole, StoredAgentRoleRun>;
}

class ReportRunnerIssue extends Error {
  readonly status: 'FAILED' | 'BLOCKED';

  constructor(status: 'FAILED' | 'BLOCKED', message: string) {
    super(message);
    this.name = 'ReportRunnerIssue';
    this.status = status;
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function exitCodeFor(status: 'PASSED' | 'FAILED' | 'BLOCKED'): 0 | 1 | 2 {
  return status === 'PASSED' ? 0 : status === 'FAILED' ? 1 : 2;
}

function assertLoopbackBaseUrl(value: string): void {
  const parsed = new URL(value);
  const port = Number(parsed.port);
  if (parsed.protocol !== 'http:'
      || parsed.hostname !== '127.0.0.1'
      || !Number.isInteger(port)
      || port < 1
      || port > 65_535
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/') {
    throw new ReportRunnerIssue('BLOCKED', 'Report metadata does not prove an isolated loopback application target.');
  }
}

function assertManagedArtifactRoot(repoRoot: string, candidate: string): { artifactRoot: string; runId: string } {
  const repository = path.resolve(repoRoot);
  const runsRoot = path.join(repository, QA_ARTIFACTS_RELATIVE_ROOT);
  const artifactRoot = path.resolve(repository, candidate);
  const relative = path.relative(runsRoot, artifactRoot);
  if (!relative
      || relative.startsWith('..')
      || path.isAbsolute(relative)
      || relative.includes(path.sep)) {
    throw new ReportRunnerIssue('BLOCKED', 'Artifact root must be one direct child of the repository .qa-runs directory.');
  }
  const runId = path.basename(artifactRoot);
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new ReportRunnerIssue('BLOCKED', 'Artifact root does not use a managed QA run identifier.');
  }
  return { artifactRoot, runId };
}

async function readJson(filePath: string, maximumBytes: number): Promise<unknown> {
  const details = await stat(filePath);
  if (!details.isFile() || details.size > maximumBytes) {
    throw new ReportRunnerIssue('FAILED', `Stored QA result is not a bounded regular file: ${path.basename(filePath)}.`);
  }
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch {
    throw new ReportRunnerIssue('FAILED', `Stored QA result is not valid JSON: ${path.basename(filePath)}.`);
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = filePath + '.tmp';
  await writeFile(temporary, safeJson(value) + '\n', 'utf8');
  await rename(temporary, filePath);
}

function agentModeFromEnvironment(value: string | undefined): ReportMetadata['agentMode'] {
  if (value === undefined || value === '' || value === 'false') return 'disabled';
  if (value === 'true') return 'enabled';
  throw new ReportRunnerIssue('FAILED', 'QA_AGENT_ENABLED must be true or false.');
}

async function gitValue(repoRoot: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    throw new ReportRunnerIssue('FAILED', 'Git metadata could not be captured for the tested build.');
  }
}

async function createMetadata(state: ReadyQaRunState): Promise<ReportMetadata> {
  assertLoopbackBaseUrl(state.environment.baseUrl);
  const [gitSha, gitBranchValue, worktreeStatus] = await Promise.all([
    gitValue(state.repoRoot, ['rev-parse', 'HEAD']),
    gitValue(state.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
    gitValue(state.repoRoot, ['status', '--porcelain=v1']),
  ]);
  if (!/^[0-9a-f]{40}$/i.test(gitSha)) {
    throw new ReportRunnerIssue('FAILED', 'Git HEAD is not a full commit identifier.');
  }
  const gitBranch = gitBranchValue === 'HEAD' || !gitBranchValue
    ? `detached@${gitSha.slice(0, 12)}`
    : gitBranchValue;
  return ReportMetadataSchema.parse({
    schemaVersion: 1,
    runId: state.runId,
    capturedAt: new Date().toISOString(),
    agentMode: agentModeFromEnvironment(process.env.QA_AGENT_ENABLED),
    environment: {
      ...state.environment,
      gitSha,
      gitBranch,
      nodeVersion: process.version,
      localProof: [
        `Supabase project_id=${LOCAL_QA_PROJECT_ID}`,
        `Supabase API=${LOCAL_QA_API_URL}`,
        `Application URL=${state.environment.baseUrl}`,
        `Working tree dirty=${worktreeStatus.length > 0}`,
      ],
    },
  });
}

function validateMetadata(metadata: ReportMetadata, artifactRoot: string): ReportMetadata {
  const runId = path.basename(artifactRoot);
  if (metadata.runId !== runId
      || metadata.environment.projectId !== LOCAL_QA_PROJECT_ID
      || metadata.environment.supabaseUrl !== LOCAL_QA_API_URL
      || metadata.environment.target !== 'local-isolated') {
    throw new ReportRunnerIssue('BLOCKED', 'Report metadata does not match the managed local QA artifact.');
  }
  assertLoopbackBaseUrl(metadata.environment.baseUrl);
  return metadata;
}

async function readMetadata(artifactRoot: string): Promise<ReportMetadata> {
  const metadataPath = path.join(artifactRoot, REPORT_METADATA_RELATIVE_PATH);
  if (!await exists(metadataPath)) {
    throw new ReportRunnerIssue(
      'BLOCKED',
      'Stored QA artifacts do not include report metadata; environment and build identity cannot be inferred safely.',
    );
  }
  try {
    const parsed = ReportMetadataSchema.parse(await readJson(metadataPath, 128 * 1024));
    return validateMetadata(parsed, artifactRoot);
  } catch (error) {
    if (error instanceof ReportRunnerIssue) throw error;
    throw new ReportRunnerIssue('BLOCKED', 'Stored report metadata is invalid; refusing to infer environment details.');
  }
}

async function contextFromReadyState(repoRoot: string): Promise<ReportContext> {
  const state = await loadReadyQaState(repoRoot);
  if (!RUN_ID_PATTERN.test(state.runId)) {
    throw new ReportRunnerIssue('BLOCKED', 'READY state does not use a managed QA run identifier.');
  }
  const managed = assertManagedArtifactRoot(repoRoot, state.artifactRoot);
  if (managed.runId !== state.runId) {
    throw new ReportRunnerIssue('BLOCKED', 'READY state runId and artifact root do not match.');
  }
  const metadataPath = path.join(managed.artifactRoot, REPORT_METADATA_RELATIVE_PATH);
  let metadata: ReportMetadata;
  if (await exists(metadataPath)) {
    metadata = await readMetadata(managed.artifactRoot);
    if (metadata.environment.baseUrl !== state.environment.baseUrl) {
      throw new ReportRunnerIssue('BLOCKED', 'Stored report metadata conflicts with READY state.');
    }
  } else {
    metadata = await createMetadata(state);
    await writeJsonAtomic(metadataPath, metadata);
  }
  return { repoRoot, artifactRoot: managed.artifactRoot, metadata };
}

export async function prepareQaReportMetadata(repoRoot = process.cwd()): Promise<string> {
  const context = await contextFromReadyState(path.resolve(repoRoot));
  return path.join(context.artifactRoot, REPORT_METADATA_RELATIVE_PATH);
}

async function contextFromArtifact(repoRoot: string, candidate: string): Promise<ReportContext> {
  await assertIsolatedLocalTarget(repoRoot, LOCAL_QA_API_URL);
  const managed = assertManagedArtifactRoot(repoRoot, candidate);
  const details = await stat(managed.artifactRoot).catch(() => null);
  if (!details?.isDirectory()) {
    throw new ReportRunnerIssue('BLOCKED', 'The requested QA artifact root does not exist as a directory.');
  }
  const metadata = await readMetadata(managed.artifactRoot);
  return { repoRoot, artifactRoot: managed.artifactRoot, metadata };
}

async function latestArtifactRoot(repoRoot: string): Promise<string> {
  const runsRoot = path.join(repoRoot, QA_ARTIFACTS_RELATIVE_ROOT);
  let entries;
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ReportRunnerIssue('BLOCKED', 'No stored QA artifact directory exists.');
    }
    throw error;
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name))
    .map(({ name }) => name)
    .sort((left, right) => right.localeCompare(left));
  const latest = candidates[0];
  if (!latest) throw new ReportRunnerIssue('BLOCKED', 'No managed QA run artifacts were found.');
  return path.join(runsRoot, latest);
}

async function resolveReportContext(options: ReportRunnerOptions): Promise<ReportContext> {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  if (options.artifactRoot) return contextFromArtifact(repoRoot, options.artifactRoot);

  const statePath = path.join(repoRoot, QA_STATE_RELATIVE_PATH);
  if (await exists(statePath)) {
    try {
      return await contextFromReadyState(repoRoot);
    } catch (error) {
      if (error instanceof ReportRunnerIssue) throw error;
      throw new ReportRunnerIssue('BLOCKED', 'Current QA state is not safe and READY; cleanup or repair it before reporting.');
    }
  }

  await assertIsolatedLocalTarget(repoRoot, LOCAL_QA_API_URL);
  return contextFromArtifact(repoRoot, await latestArtifactRoot(repoRoot));
}

function managedEvidenceRef(artifactRoot: string, candidate: string): string | undefined {
  const raw = redactText(candidate.trim());
  if (!raw || raw.includes('[REDACTED]')) return undefined;
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(artifactRoot, raw);
  const relative = path.relative(path.resolve(artifactRoot), absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  try {
    if (!statSync(absolute).isFile()) return undefined;
  } catch {
    return undefined;
  }
  return relative.replaceAll('\\', '/');
}

function assertManagedEvidenceFiles(
  artifactRoot: string,
  candidates: readonly string[],
  label: string,
): void {
  if (candidates.some((candidate) => !managedEvidenceRef(artifactRoot, candidate))) {
    throw new ReportRunnerIssue('FAILED', `${label} references missing or unmanaged evidence.`);
  }
}

function booleanEnvironment(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ReportRunnerIssue('FAILED', `${name} must be true or false.`);
}

function deterministicScenario(
  result: StoredDeterministicRun,
  evidence: readonly string[],
): ScenarioResult {
  const startedValue = new Date(result.startedAt).valueOf();
  let elapsed = 0;
  const steps: StepResult[] = result.phases.map((phase, index) => {
    const startedAt = new Date(startedValue + elapsed).toISOString();
    elapsed += phase.durationMs;
    return {
      step: index + 1,
      name: phase.name,
      status: phase.status,
      startedAt,
      endedAt: new Date(startedValue + elapsed).toISOString(),
      durationMs: phase.durationMs,
      evidence: [],
      message: phase.reason ? redactText(phase.reason) : undefined,
    };
  });
  const blockerReason = result.phases
    .filter(({ status }) => status === 'BLOCKED')
    .map(({ name, reason }) => `${name}: ${redactText(reason ?? 'לא נאספה סיבת חסימה.')}`)
    .join('; ');
  return {
    id: 'deterministic-runner-gates',
    name: 'שערי ההרצה הדטרמיניסטית',
    role: 'system',
    required: true,
    status: result.status,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    durationMs: result.phases.reduce((total, phase) => total + phase.durationMs, 0),
    steps,
    findingIds: [],
    evidence: [...evidence],
    limitation: result.status === 'BLOCKED'
      ? blockerReason || 'אחד משערי ההרצה הדטרמיניסטית נחסם ללא ראיה מספקת.'
      : undefined,
  };
}

function syntheticScenario(input: {
  id: string;
  name: string;
  role?: string;
  required: boolean;
  status: RunStatus;
  blockerType?: BlockerType;
  generatedAt: string;
  message: string;
}): ScenarioResult {
  return {
    id: input.id,
    name: input.name,
    role: input.role ?? 'system',
    required: input.required,
    status: input.status,
    startedAt: input.generatedAt,
    endedAt: input.generatedAt,
    durationMs: 0,
    steps: [{
      step: 1,
      name: input.name,
      status: input.status,
      startedAt: input.generatedAt,
      endedAt: input.generatedAt,
      durationMs: 0,
      evidence: [],
      message: input.message,
    }],
    findingIds: [],
    evidence: [],
    limitation: input.message,
    blockerType: input.status === 'PASSED'
      ? undefined
      : input.blockerType
        ?? (input.status === 'SKIPPED_BY_CONFIGURATION' || input.status === 'OPTIONAL_BLOCKED'
          ? 'CONFIGURATION'
          : 'INFRASTRUCTURE'),
  };
}

function playwrightBlockerType(scenario: ScenarioResult): BlockerType | undefined {
  if (scenario.status === 'PASSED') return undefined;
  if (scenario.status === 'SKIPPED_BY_CONFIGURATION' || scenario.status === 'OPTIONAL_BLOCKED') {
    return 'CONFIGURATION';
  }
  const failureText = [
    scenario.limitation,
    ...scenario.steps.map(({ message }) => message),
  ].filter((value): value is string => Boolean(value)).join('\n');
  if (isPlaywrightInfrastructureFailureText(failureText)) return 'INFRASTRUCTURE';
  if (scenario.status === 'FAILED') return 'PRODUCT';
  return scenario.name.includes('[critical:')
    ? 'PRODUCT'
    : 'INFRASTRUCTURE';
}

function deterministicBlockerType(
  result: StoredDeterministicRun,
  playwrightScenarios: readonly ScenarioResult[],
  playwrightExists: boolean,
): BlockerType | undefined {
  if (result.status === 'PASSED') return undefined;
  const productPhaseNames = new Set(['playwright-deterministic', 'critical-workflow-coverage']);
  const nonPassing = result.phases.filter(({ status }) => status === 'FAILED' || status === 'BLOCKED');
  if (!playwrightExists || nonPassing.some(({ name }) => !productPhaseNames.has(name))) return 'INFRASTRUCTURE';
  return playwrightScenarios.some((scenario) =>
    scenario.required && scenario.status === 'BLOCKED' && scenario.blockerType !== 'PRODUCT')
    ? 'INFRASTRUCTURE'
    : 'PRODUCT';
}

function agentScenarioStatus(status: StoredAgentRoleRun['status']): ScenarioResult['status'] {
  if (status === 'completed') return 'PASSED';
  if (status === 'blocked' || status === 'step_limit') return 'BLOCKED';
  return 'FAILED';
}

function receiptStatus(receipt: z.infer<typeof ModelReceiptSchema>): StepResult['status'] {
  if (receipt.status === 'failed' || receipt.status === 'denied' || receipt.verificationStatus === 'failed') {
    return 'FAILED';
  }
  if (receipt.verificationStatus === 'blocked') return 'BLOCKED';
  return 'PASSED';
}

function findingEvidence(
  artifactRoot: string,
  evidence: readonly { kind: z.infer<typeof AgentEvidenceSchema>['kind']; ref: string }[],
  allowedRefs?: ReadonlySet<string>,
): Finding['evidence'] {
  const result: Finding['evidence'] = {};
  for (const item of evidence) {
    if (allowedRefs && !allowedRefs.has(item.ref)) continue;
    const ref = managedEvidenceRef(artifactRoot, item.ref);
    if (!ref) continue;
    if (item.kind === 'screenshot') result.screenshots = unique([...(result.screenshots ?? []), ref]);
    else if (item.kind === 'action-trace') result.actionTrace ??= ref;
    else if (item.kind === 'console') result.console = unique([...(result.console ?? []), ref]);
    else if (item.kind === 'network') result.network = unique([...(result.network ?? []), ref]);
    else if (item.kind === 'database' || item.kind === 'audit') {
      result.database = unique([...(result.database ?? []), ref]);
    } else if (item.kind === 'download') result.downloads = unique([...(result.downloads ?? []), ref]);
    else if (item.kind === 'accessibility') {
      result.accessibility = unique([...(result.accessibility ?? []), ref]);
    }
  }
  return result;
}

function verifierCategory(checkId: string): Finding['category'] {
  if (/authorization|permission|rls/i.test(checkId)) return 'authorization';
  if (/security|static/i.test(checkId)) return 'security';
  if (/accessibility|axe|keyboard/i.test(checkId)) return 'accessibility';
  if (/database|integrity|audit|export/i.test(checkId)) return 'data_integrity';
  return 'functional';
}

function verifierSource(checkId: string): Finding['source'] {
  if (/authorization|permission|security|static|rls/i.test(checkId)) return 'security';
  if (/accessibility|axe|keyboard/i.test(checkId)) return 'accessibility';
  if (/export/i.test(checkId)) return 'export';
  return 'database';
}

function appendUnavailableRoleCoverage(
  coverage: AgentCoverage,
  input: {
    generatedAt: string;
    required: boolean;
    status: Extract<RunStatus, 'BLOCKED' | 'SKIPPED_BY_CONFIGURATION'>;
    blockerType: Extract<BlockerType, 'INFRASTRUCTURE' | 'CONFIGURATION'>;
    reason: string;
  },
): void {
  for (const role of QA_ROLES) {
    const message = `${input.reason} תפקיד: ${role}.`;
    coverage.scenarios.push(syntheticScenario({
      id: `agent-${role}-${input.status === 'BLOCKED' ? 'missing' : 'disabled'}`,
      name: `כיסוי סוכן AI — ${role}`,
      role,
      required: input.required,
      status: input.status,
      blockerType: input.blockerType,
      generatedAt: input.generatedAt,
      message,
    }));
    if (input.status === 'BLOCKED') coverage.blockedItems.push(message);
  }
}

export function buildAgentCoverage(
  agent: StoredAgentRun | null,
  input: {
    runId: string;
    artifactRoot: string;
    generatedAt: string;
    deterministicStatus: StoredDeterministicRun['status'] | null;
    agentMode: ReportMetadata['agentMode'];
  },
): AgentCoverage {
  const coverage: AgentCoverage = {
    scenarios: [],
    findings: [],
    blockedItems: [],
    limitations: [],
    humanTestingRequired: [],
    evidencePaths: [],
    roleRuns: new Map(),
  };

  if (!agent) {
    const expected = input.agentMode === 'enabled';
    const status: RunStatus = expected ? 'BLOCKED' : 'SKIPPED_BY_CONFIGURATION';
    const message = expected
      ? 'שלב סוכני ה-AI הוגדר לפעול אך קובץ התוצאה השמור חסר.'
      : input.deterministicStatus === 'PASSED'
      ? 'שלב סוכני ה-AI לא הופעל לפי התצורה.'
      : 'שלב סוכני ה-AI לא הופעל לאחר ששער דטרמיניסטי לא עבר.';
    coverage.scenarios.push(syntheticScenario({
      id: 'agent-phase',
      name: 'שלב סוכני AI חקרניים',
      required: expected,
      status,
      blockerType: expected ? 'INFRASTRUCTURE' : 'CONFIGURATION',
      generatedAt: input.generatedAt,
      message,
    }));
    appendUnavailableRoleCoverage(coverage, {
      generatedAt: input.generatedAt,
      required: expected,
      status,
      blockerType: expected ? 'INFRASTRUCTURE' : 'CONFIGURATION',
      reason: message,
    });
    coverage.limitations.push(message);
    if (expected) coverage.blockedItems.push(message);
    return coverage;
  }

  const agentResultRef = managedEvidenceRef(input.artifactRoot, AGENT_RESULT_RELATIVE_PATH);
  if (agentResultRef) coverage.evidencePaths.push(agentResultRef);
  coverage.evidencePaths.push(...agent.evidencePaths.flatMap((candidate) => {
    const ref = managedEvidenceRef(input.artifactRoot, candidate);
    return ref ? [ref] : [];
  }));

  if (agent.status === 'SKIPPED_BY_CONFIGURATION') {
    const message = redactText(agent.reason || 'שלב סוכני ה-AI דולג לפי התצורה.');
    coverage.scenarios.push(syntheticScenario({
      id: 'agent-phase',
      name: 'שלב סוכני AI חקרניים',
      required: false,
      status: 'SKIPPED_BY_CONFIGURATION',
      blockerType: 'CONFIGURATION',
      generatedAt: input.generatedAt,
      message,
    }));
    appendUnavailableRoleCoverage(coverage, {
      generatedAt: input.generatedAt,
      required: false,
      status: 'SKIPPED_BY_CONFIGURATION',
      blockerType: 'CONFIGURATION',
      reason: message,
    });
    coverage.limitations.push(message);
    return coverage;
  }

  if (!agent.orchestrator) {
    const message = 'תוצאת שלב הסוכנים חסרה orchestrator מובנה.';
    coverage.scenarios.push(syntheticScenario({
      id: 'agent-phase',
      name: 'שלב סוכני AI חקרניים',
      required: true,
      status: 'BLOCKED',
      blockerType: 'INFRASTRUCTURE',
      generatedAt: input.generatedAt,
      message,
    }));
    appendUnavailableRoleCoverage(coverage, {
      generatedAt: input.generatedAt,
      required: true,
      status: 'BLOCKED',
      blockerType: 'INFRASTRUCTURE',
      reason: message,
    });
    coverage.blockedItems.push(message);
    return coverage;
  }

  const agentGate = syntheticScenario({
    id: 'agent-orchestrator-gate',
    name: 'שער תזמור סוכני AI',
    required: true,
    status: agent.status,
    blockerType: agent.blockerType ?? undefined,
    generatedAt: input.generatedAt,
    message: redactText(agent.reason),
  });
  agentGate.startedAt = agent.startedAt;
  agentGate.endedAt = agent.endedAt;
  agentGate.evidence = agentResultRef ? [agentResultRef] : [];
  coverage.scenarios.push(agentGate);

  for (const roleRun of agent.orchestrator.roleResults) {
    coverage.roleRuns.set(roleRun.role, roleRun);
    const scenarioId = `agent-${roleRun.role}-${roleRun.scenarioId}`;
    const roleEvidence = unique([
      ...roleRun.evidenceRefs,
      ...roleRun.evidence.map(({ ref }) => ref),
      ...roleRun.verificationResults.flatMap(({ mutationEvidence }) => mutationEvidence?.evidenceRefs ?? []),
    ].flatMap((candidate) => {
      const ref = managedEvidenceRef(input.artifactRoot, candidate);
      return ref ? [ref] : [];
    }));
    coverage.evidencePaths.push(...roleEvidence);

    const findings: Finding[] = [];
    const verifierBlockers: string[] = [];
    for (const observation of roleRun.observations) {
      const allowedRefs = new Set(observation.evidenceRefs);
      findings.push(enforceAgentEvidence(createFinding({
        runId: input.runId,
        source: 'agent',
        role: roleRun.role,
        scenarioId,
        scenarioName: redactText(roleRun.scenarioName),
        route: observation.route ? redactText(observation.route) : undefined,
        title: redactText(observation.title),
        category: observation.category,
        severity: observation.severityHint,
        confidence: allowedRefs.size > 0 ? 0.7 : 0.45,
        reproducibility: 'single_observation',
        status: 'observation',
        expected: observation.expected ? redactText(observation.expected) : undefined,
        actual: observation.actual ? redactText(observation.actual) : undefined,
        userImpact: redactText(observation.description),
        reproductionSteps: observation.reproductionSteps.map(redactText),
        evidence: findingEvidence(input.artifactRoot, roleRun.evidence, allowedRefs),
        humanReviewRequired: true,
        createdAt: agent.endedAt,
      })));
    }

    for (const verification of roleRun.verificationResults) {
      if (verification.result.status === 'blocked') {
        const message = `${roleRun.role}: המאמת ${verification.checkId} נחסם — ${redactText(verification.result.summary)}`;
        coverage.blockedItems.push(message);
        verifierBlockers.push(message);
        continue;
      }
      if (verification.result.status !== 'failed') continue;
      const category = verifierCategory(verification.checkId);
      findings.push(createFinding({
        runId: input.runId,
        source: verifierSource(verification.checkId),
        role: roleRun.role,
        scenarioId,
        scenarioName: redactText(roleRun.scenarioName),
        step: verification.step,
        title: `בדיקת מאמת נכשלה: ${redactText(verification.checkId)}`,
        category,
        severity: category === 'accessibility' ? 'medium' : 'high',
        confidence: 1,
        reproducibility: 'not_retested',
        status: 'confirmed',
        expected: 'המאמת העצמאי יאשר את תוצאת הפעולה המשמעותית.',
        actual: redactText(verification.result.summary),
        userImpact: category === 'authorization' || category === 'security'
          ? 'גבול ההרשאה שנבדק לא הוכח כנכון.'
          : 'תוצאת הפעולה העסקית אינה תואמת את הבדיקה העצמאית.',
        reproductionSteps: [`הרץ מחדש את המאמת ${redactText(verification.checkId)} בתרחיש ${scenarioId}.`],
        evidence: findingEvidence(input.artifactRoot, verification.result.evidence),
        humanReviewRequired: false,
        createdAt: agent.endedAt,
      }));
    }

    const steps: StepResult[] = roleRun.receipts.map((receipt) => ({
      step: receipt.step,
      name: redactText(receipt.actionType),
      status: receiptStatus(receipt),
      startedAt: agent.startedAt,
      endedAt: agent.startedAt,
      durationMs: 0,
      evidence: receipt.evidenceRefs.flatMap((candidate) => {
        const ref = managedEvidenceRef(input.artifactRoot, candidate);
        return ref ? [ref] : [];
      }),
      message: redactText(receipt.summary),
    }));
    const status = agentScenarioStatus(roleRun.status);
    const limitationParts = [
      ...roleRun.missingEvidenceKinds.map((kind) => `חסרה ראיה מסוג ${redactText(kind)}.`),
      ...verifierBlockers,
      ...(roleRun.status === 'blocked' ? [redactText(roleRun.terminalReason)] : []),
      ...(roleRun.unverifiedMeaningfulActions > 0
        ? [`${roleRun.unverifiedMeaningfulActions} פעולות משמעותיות לא אומתו באופן עצמאי.`]
        : []),
    ];
    coverage.scenarios.push({
      id: scenarioId,
      name: `בדיקה חקרנית — ${redactText(roleRun.scenarioName)}`,
      role: roleRun.role,
      required: true,
      status,
      startedAt: agent.startedAt,
      endedAt: agent.endedAt,
      durationMs: 0,
      steps,
      findingIds: findings.map(({ id }) => id),
      evidence: roleEvidence,
      limitation: limitationParts.length ? limitationParts.join(' ') : undefined,
      blockerType: status === 'PASSED' ? undefined : roleRun.blockerType ?? 'INFRASTRUCTURE',
    });
    coverage.findings.push(...findings);
    coverage.limitations.push(...limitationParts);
    if (status === 'BLOCKED') {
      coverage.blockedItems.push(`${roleRun.role}: ${redactText(roleRun.terminalReason)}`);
    }
    if (roleRun.summary?.humanReviewRequired) {
      coverage.humanTestingRequired.push(`סקירה אנושית לממצאי סוכן התפקיד ${roleRun.role}.`);
    }
  }

  for (const role of QA_ROLES.filter((candidate) => !coverage.roleRuns.has(candidate))) {
    const message = `לא קיימת תוצאת סוכן AI שמורה לתפקיד ${role}.`;
    coverage.scenarios.push(syntheticScenario({
      id: `agent-${role}-missing`,
      name: `AI role-agent coverage — ${role}`,
      role,
      required: true,
      status: 'BLOCKED',
      blockerType: 'INFRASTRUCTURE',
      generatedAt: input.generatedAt,
      message,
    }));
    coverage.blockedItems.push(message);
  }

  if (agent.status === 'BLOCKED') {
    coverage.blockedItems.push(`שלב סוכני ה-AI נחסם: ${redactText(agent.reason)}`);
  }
  coverage.limitations.push(...agent.orchestrator.diagnostics.map((value) => redactText(value)));
  return coverage;
}

const ROLE_PURPOSES: Readonly<Record<QaRole | 'platform', string>> = {
  owner: 'שליטה עסקית, אישור תשלומים וקבלת החלטות על חריגים.',
  office: 'קליטת מסמכים, בדיקת חשבוניות והכנת דרישות תשלום.',
  kitchen: 'קבלת סחורה ותיעוד התאמה להזמנה בתנאי עבודה ניידים.',
  payer: 'ביצוע העברות מאושרות בלבד ללא חשיפה מיותרת למידע כספי.',
  accountant: 'התאמות בנק, בקרת כספים והפקת דוחות חשבונאיים.',
  supplier: 'הגשת מחירון חודשי ומעקב אחר המסמכים המותרים לספק.',
  platform: 'ניהול פלטפורמה באמצעות זהות platform-admin נפרדת ומאושרת.',
};

function aggregateRoleStatus(scenarios: readonly ScenarioResult[]): RoleResult['status'] {
  if (!scenarios.length) return 'BLOCKED';
  if (scenarios.some(({ status }) => status === 'FAILED')) return 'FAILED';
  if (scenarios.some(({ required, status }) => required && status === 'BLOCKED')) return 'BLOCKED';
  const agentScenarios = scenarios.filter(({ id }) => id.startsWith('agent-'));
  if (agentScenarios.length > 0
      && agentScenarios.every(({ status }) => status === 'SKIPPED_BY_CONFIGURATION')) {
    return 'SKIPPED_BY_CONFIGURATION';
  }
  if (scenarios.every(({ status }) => status === 'SKIPPED_BY_CONFIGURATION')) {
    return 'SKIPPED_BY_CONFIGURATION';
  }
  if (scenarios.every(({ status }) => status === 'OPTIONAL_BLOCKED')) return 'OPTIONAL_BLOCKED';
  if (scenarios.some(({ status }) => status === 'PASSED')) return 'PASSED';
  return 'BLOCKED';
}

export function completedOpenAreas(
  steps: readonly {
    decision?: unknown;
    receipt: z.infer<typeof ModelReceiptSchema> | null;
  }[],
): string[] {
  return unique(steps.flatMap(({ decision, receipt }) => {
    if (receipt?.status !== 'completed' || receipt.actionType !== 'open') return [];
    const parsed = RoleStepDecisionSchema.safeParse(decision);
    if (!parsed.success
        || parsed.data.decision !== 'action'
        || parsed.data.action?.type !== 'open'
        || !parsed.data.action.route
        || receipt.summary !== `opened:${parsed.data.action.route}`) return [];
    return [redactText(parsed.data.action.route)];
  }));
}

export function buildRoles(
  scenarios: readonly ScenarioResult[],
  findings: readonly Finding[],
  roleRuns: ReadonlyMap<QaRole, StoredAgentRoleRun>,
  includePlatformAdmin: boolean,
): RoleResult[] {
  const roles: Array<QaRole | 'platform'> = [
    ...QA_ROLES,
    ...(includePlatformAdmin ? ['platform' as const] : []),
  ];
  return roles.map((role) => {
    const roleScenarios = scenarios.filter((scenario) => scenario.role === role);
    const roleFindings = findings.filter((finding) =>
      finding.role === role || finding.affectedRoles.includes(role));
    const agent = role === 'platform' ? undefined : roleRuns.get(role);
    const completedGoals = agent?.summary?.completedGoals.map(redactText) ?? [];
    const blockedGoals = agent?.summary?.blockedGoals.map(redactText) ?? [];
    const limitations = [
      ...(!roleScenarios.length ? ['לא נאספו תרחישים או ראיות לתפקיד בהרצה זו.'] : []),
      ...(agent?.missingEvidenceKinds.map((kind) => `חסרה ראיה מסוג ${redactText(kind)}.`) ?? []),
      ...(agent && agent.status !== 'completed' ? [redactText(agent.terminalReason)] : []),
    ];
    const findingText = (finding: Finding) => `${finding.severity}: ${finding.title} — ${finding.status}`;
    const permissionFindings = roleFindings.filter((finding) =>
      finding.category === 'authorization' || finding.category === 'security');
    const confidence = roleFindings.length
      ? roleFindings.reduce((total, finding) => total + finding.confidence, 0) / roleFindings.length
      : null;
    return {
      role,
      purpose: ROLE_PURPOSES[role],
      status: aggregateRoleStatus(roleScenarios),
      scenarioIds: roleScenarios.map(({ id }) => id),
      tasksAttempted: unique([
        ...completedGoals,
        ...blockedGoals,
        ...roleScenarios
          .filter(({ status }) => status !== 'SKIPPED_BY_CONFIGURATION' && status !== 'OPTIONAL_BLOCKED')
          .map(({ name }) => name),
      ]),
      tasksCompleted: unique([
        ...completedGoals,
        ...roleScenarios.filter(({ status }) => status === 'PASSED').map(({ name }) => name),
      ]),
      tasksBlocked: unique([
        ...blockedGoals,
        ...roleScenarios
          .filter(({ status }) => status === 'BLOCKED' || status === 'FAILED')
          .map(({ name }) => name),
      ]),
      accessibleAreas: completedOpenAreas(agent?.steps ?? []),
      unexpectedlyInaccessibleAreas: [],
      unexpectedlyAccessibleAreas: [],
      functionalDefects: roleFindings
        .filter((finding) => finding.category === 'functional' || finding.category === 'data_integrity')
        .map(findingText),
      permissionDefects: permissionFindings.map(findingText),
      accessibilityFindings: roleFindings
        .filter((finding) => finding.category === 'accessibility')
        .map(findingText),
      usabilityObservations: roleFindings
        .filter((finding) => ['usability', 'visual', 'performance', 'rtl'].includes(finding.category))
        .map(findingText),
      unclearWording: roleFindings.filter((finding) => finding.category === 'copy').map(findingText),
      recoveryProblems: roleFindings.filter((finding) => finding.category === 'resilience').map(findingText),
      evidence: unique(roleScenarios.flatMap(({ evidence }) => evidence)),
      confidence,
      recommendations: unique(roleFindings.flatMap(({ recommendedFix }) =>
        recommendedFix ? [recommendedFix] : [])),
      limitations: unique(limitations),
    };
  });
}

function platformAdminScenario(generatedAt: string, enabled: boolean): ScenarioResult {
  const definition = getScenario('platform-admin');
  const reason = definition.blockedReason
    ?? 'לא קיימת זהות platform-admin מקומית ומאושרת.';
  return syntheticScenario({
    id: definition.id,
    name: definition.title,
    role: 'platform',
    required: false,
    status: enabled ? 'OPTIONAL_BLOCKED' : 'SKIPPED_BY_CONFIGURATION',
    blockerType: 'CONFIGURATION',
    generatedAt,
    message: enabled ? reason : 'כיסוי platform-admin האופציונלי הושבת לפי הגדרה.',
  });
}

export function cleanupVerificationScenario(
  cleanup: StoredCleanupRun | null,
  generatedAt: string,
): ScenarioResult {
  if (!cleanup) {
    return syntheticScenario({
      id: 'cleanup-verification',
      name: 'אימות ניקוי סביבת QA',
      required: true,
      status: 'BLOCKED',
      blockerType: 'INFRASTRUCTURE',
      generatedAt,
      message: 'קובץ cleanup.json חסר; לא ניתן להוכיח שה-state הזמני נוקה ושמשאבי ההרצה שוחררו.',
    });
  }
  const status: RunStatus = cleanup.status === 'CLEAN' ? 'PASSED' : cleanup.status;
  return syntheticScenario({
    id: 'cleanup-verification',
    name: 'אימות ניקוי סביבת QA',
    required: true,
    status,
    blockerType: status === 'PASSED' ? undefined : 'INFRASTRUCTURE',
    generatedAt,
    message: redactText(cleanup.reason),
  });
}

function truthfulDecision(
  scenarios: readonly ScenarioResult[],
  findings: readonly Finding[],
  failOnMedium: boolean,
): RunReport['exitDecision'] {
  return exitDecision(scenarios, findings, failOnMedium);
}

async function loadDeterministicResult(context: ReportContext): Promise<StoredDeterministicRun | null> {
  const resultPath = path.join(context.artifactRoot, DETERMINISTIC_RESULT_RELATIVE_PATH);
  if (!await exists(resultPath)) return null;
  let result: StoredDeterministicRun;
  try {
    result = DeterministicRunSchema.parse(await readJson(resultPath, 2 * 1024 * 1024));
  } catch (error) {
    if (error instanceof ReportRunnerIssue) throw error;
    throw new ReportRunnerIssue('FAILED', 'Stored deterministic result does not satisfy its schema.');
  }
  const expectedPlaywright = path.join(context.artifactRoot, PLAYWRIGHT_RESULT_RELATIVE_PATH);
  if (result.runId !== context.metadata.runId
      || path.resolve(result.playwrightReport) !== path.resolve(expectedPlaywright)
      || result.exitCode !== exitCodeFor(result.status)) {
    throw new ReportRunnerIssue('FAILED', 'Stored deterministic result conflicts with its run identity or exit policy.');
  }
  const computedStatus: StoredDeterministicRun['status'] = result.phases.some(({ status }) => status === 'FAILED')
    ? 'FAILED'
    : result.phases.some(({ status }) => status === 'BLOCKED')
    ? 'BLOCKED'
    : 'PASSED';
  if (computedStatus !== result.status || new Date(result.endedAt) < new Date(result.startedAt)) {
    throw new ReportRunnerIssue('FAILED', 'Stored deterministic phase status or timing is internally inconsistent.');
  }
  assertManagedEvidenceFiles(context.artifactRoot, result.redactedTraces, 'Stored deterministic result');
  return result;
}

async function loadAgentResult(context: ReportContext): Promise<StoredAgentRun | null> {
  const resultPath = path.join(context.artifactRoot, AGENT_RESULT_RELATIVE_PATH);
  if (!await exists(resultPath)) return null;
  let result: StoredAgentRun;
  try {
    result = AgentRunSchema.parse(await readJson(resultPath, 32 * 1024 * 1024));
  } catch (error) {
    if (error instanceof ReportRunnerIssue) throw error;
    throw new ReportRunnerIssue('FAILED', 'Stored agent result does not satisfy its schema.');
  }
  const expectedExit = result.status === 'PASSED' || result.status === 'SKIPPED_BY_CONFIGURATION'
    ? 0
    : result.status === 'FAILED' ? 1 : 2;
  if (result.runId !== context.metadata.runId
      || result.orchestrator?.runId !== context.metadata.runId
      || result.exitCode !== expectedExit) {
    throw new ReportRunnerIssue('FAILED', 'Stored agent result conflicts with its run identity or exit policy.');
  }
  if (new Date(result.endedAt) < new Date(result.startedAt)
      || (result.status === 'PASSED'
        && (result.orchestrator?.status !== 'completed'
          || result.orchestrator.statistics.unverifiedMeaningfulActions !== 0))) {
    throw new ReportRunnerIssue('FAILED', 'Stored agent status or timing is internally inconsistent.');
  }
  const roleEvidence = result.orchestrator?.roleResults.flatMap((roleRun) => [
    ...roleRun.evidence.map(({ ref }) => ref),
    ...roleRun.evidenceRefs,
    ...roleRun.verificationResults.flatMap(({ mutationEvidence }) => mutationEvidence?.evidenceRefs ?? []),
    ...roleRun.verificationResults.flatMap(({ result: verification }) =>
      verification.evidence.map(({ ref }) => ref)),
  ]) ?? [];
  assertManagedEvidenceFiles(
    context.artifactRoot,
    [...result.evidencePaths, ...roleEvidence],
    'Stored agent result',
  );
  return result;
}

async function loadCleanupResult(context: ReportContext): Promise<StoredCleanupRun | null> {
  const resultPath = path.join(context.artifactRoot, CLEANUP_RESULT_RELATIVE_PATH);
  if (!await exists(resultPath)) return null;
  let result: StoredCleanupRun;
  try {
    result = CleanupRunSchema.parse(await readJson(resultPath, 256 * 1024));
  } catch (error) {
    if (error instanceof ReportRunnerIssue) throw error;
    throw new ReportRunnerIssue('FAILED', 'Stored cleanup result does not satisfy its schema.');
  }
  if (result.runId !== context.metadata.runId
      || (result.status === 'CLEAN' && !result.resetPerformed)) {
    throw new ReportRunnerIssue('FAILED', 'Stored cleanup result conflicts with its run identity or verified reset status.');
  }
  return result;
}

async function buildReport(
  context: ReportContext,
  options: ReportRunnerOptions,
  generatedAt: string,
): Promise<RunReport> {
  const deterministic = await loadDeterministicResult(context);
  const agent = await loadAgentResult(context);
  const cleanup = await loadCleanupResult(context);
  const scenarios: ScenarioResult[] = [];
  const findings: Finding[] = [];
  const limitations: string[] = [
    'בדיקות axe אוטומטיות אינן כיסוי נגישות מלא ומעבר שלהן אינו הסמכת WCAG.',
    'אוטומציית מקלדת אינה מחליפה בדיקה אנושית באמצעות קורא מסך.',
    'ממצאי סוכני AI הם תצפיות בלבד עד לאימות דטרמיניסטי או אנושי.',
    'ההרצה משתמשת בנתוני fixture ובסביבת Supabase מקומית מבודדת, לא בנתוני ייצור.',
    'מטריצת המסלולים בדוח זה בודקת הרשאת UI בלבד; שער quality הקיים לבידוד RLS, Storage ורב-דיירות נשאר שער חובה ונפרד.',
  ];
  const blockedItems: string[] = [];
  const evidencePaths: string[] = [];
  let deterministicGateScenario: ScenarioResult | undefined;
  let playwrightScenarios: ScenarioResult[] = [];

  const deterministicResultRef = managedEvidenceRef(context.artifactRoot, DETERMINISTIC_RESULT_RELATIVE_PATH);
  const playwrightResultPath = path.join(context.artifactRoot, PLAYWRIGHT_RESULT_RELATIVE_PATH);
  const playwrightExists = await exists(playwrightResultPath);
  if (deterministic) {
    const deterministicEvidence = [
      ...(deterministicResultRef ? [deterministicResultRef] : []),
      ...(playwrightExists ? [PLAYWRIGHT_RESULT_RELATIVE_PATH] : []),
      ...deterministic.redactedTraces.flatMap((candidate) => {
        const ref = managedEvidenceRef(context.artifactRoot, candidate);
        return ref ? [ref] : [];
      }),
    ];
    const scenario = deterministicScenario(deterministic, deterministicEvidence);
    deterministicGateScenario = scenario;
    scenarios.push(scenario);
    if (scenario.status === 'BLOCKED') {
      blockedItems.push(`השער הדטרמיניסטי: ${scenario.limitation ?? 'חסרה ראיה מספקת.'}`);
    }
    evidencePaths.push(...deterministicEvidence);
  } else {
    const message = 'קובץ תוצאת השער הדטרמיניסטי חסר; לא ניתן להוכיח שה-preconditions עברו.';
    scenarios.push(syntheticScenario({
      id: 'deterministic-runner-gates',
      name: 'שערי ההרצה הדטרמיניסטית',
      required: true,
      status: 'BLOCKED',
      generatedAt,
      message,
    }));
    blockedItems.push(message);
  }

  if (playwrightExists) {
    let parsed;
    try {
      parsed = await readPlaywrightReport(playwrightResultPath, {
        runId: context.metadata.runId,
        artifactRoot: context.artifactRoot,
        generatedAt,
      });
    } catch {
      throw new ReportRunnerIssue('FAILED', 'Stored Playwright report is malformed and cannot be aggregated.');
    }
    playwrightScenarios = parsed.scenarios.map((scenario) => ({
      ...scenario,
      blockerType: playwrightBlockerType(scenario),
    }));
    scenarios.push(...playwrightScenarios);
    findings.push(...parsed.findings);
    evidencePaths.push(PLAYWRIGHT_RESULT_RELATIVE_PATH);
  } else if (deterministic?.status === 'PASSED') {
    const message = 'השער הדטרמיניסטי סומן PASSED אך קובץ Playwright JSON חסר.';
    scenarios.push(syntheticScenario({
      id: 'playwright-result-integrity',
      name: 'שלמות תוצאת Playwright',
      required: true,
      status: 'FAILED',
      generatedAt,
      message,
    }));
    limitations.push(message);
  } else {
    limitations.push('לא נוצר דוח Playwright משום שההרצה הדטרמיניסטית לא הגיעה לשלב הדפדפן.');
  }

  if (deterministic && deterministicGateScenario) {
    deterministicGateScenario.blockerType = deterministicBlockerType(
      deterministic,
      playwrightScenarios,
      playwrightExists,
    );
  }

  const agentCoverage = buildAgentCoverage(agent, {
    runId: context.metadata.runId,
    artifactRoot: context.artifactRoot,
    generatedAt,
    deterministicStatus: deterministic?.status ?? null,
    agentMode: context.metadata.agentMode,
  });
  scenarios.push(...agentCoverage.scenarios);
  findings.push(...agentCoverage.findings);
  blockedItems.push(...agentCoverage.blockedItems);
  limitations.push(...agentCoverage.limitations);
  evidencePaths.push(...agentCoverage.evidencePaths);

  const cleanupScenario = cleanupVerificationScenario(cleanup, generatedAt);
  scenarios.push(cleanupScenario);
  if (cleanup) {
    const cleanupRef = managedEvidenceRef(context.artifactRoot, CLEANUP_RESULT_RELATIVE_PATH);
    cleanupScenario.evidence = cleanupRef ? [cleanupRef] : [];
    if (cleanupRef) evidencePaths.push(cleanupRef);
    if (cleanupScenario.status === 'BLOCKED') blockedItems.push(redactText(cleanup.reason));
    if (cleanupScenario.status !== 'PASSED') limitations.push(redactText(cleanup.reason));
  } else {
    blockedItems.push(cleanupScenario.limitation!);
    limitations.push(cleanupScenario.limitation!);
  }

  const includePlatformAdmin = options.includePlatformAdmin ?? true;
  const platform = platformAdminScenario(generatedAt, includePlatformAdmin);
  scenarios.push(platform);
  limitations.push('כיסוי platform-admin אופציונלי עד ליצירת fixture מקומי נפרד ומאושר.');

  const deduplicatedFindings = deduplicateFindings(findings);
  const findingIdsByScenario = new Map<string, string[]>();
  for (const finding of deduplicatedFindings) {
    for (const scenarioId of unique([finding.scenarioId, ...finding.affectedScenarios])) {
      const current = findingIdsByScenario.get(scenarioId) ?? [];
      current.push(finding.id);
      findingIdsByScenario.set(scenarioId, unique(current));
    }
  }
  for (const scenario of scenarios) {
    scenario.findingIds = unique([
      ...scenario.findingIds,
      ...(findingIdsByScenario.get(scenario.id) ?? []),
    ]);
  }

  const roles = buildRoles(scenarios, deduplicatedFindings, agentCoverage.roleRuns, includePlatformAdmin);
  const decision = truthfulDecision(
    scenarios,
    deduplicatedFindings,
    options.failOnMedium ?? booleanEnvironment('QA_FAIL_ON_MEDIUM', false),
  );
  const humanTestingRequired = unique([
    'בדיקה עם קורא מסך אמיתי בכל תהליכי הליבה.',
    'סקירת מומחה כספים לנכונות הסכומים, ההקצאות ומעברי הסטטוס.',
    'שימוש אמיתי במובייל במטבח, כולל תאורה חלשה וכפפות.',
    'סקירת רואת חשבון לקובצי הייצוא ולסיכומים החודשיים.',
    'בדיקת הבנת ספק אמיתי את תהליך הגשת המחירון החודשי.',
    'בדיקת שימושיות והתאוששות תחת רשת איטית או לא יציבה.',
    'סקירה ידנית של עברית, RTL, סדר focus ותצוגה ברזולוציות מייצגות.',
    'בדיקת משתמשים עם מוגבלויות בתהליכים הקריטיים.',
    ...agentCoverage.humanTestingRequired,
  ]);

  limitations.push(...blockedItems);

  return RunReportSchema.parse({
    schemaVersion: 2,
    runId: context.metadata.runId,
    generatedAt,
    runStatus: decision.runStatus,
    productQualityStatus: decision.productQualityStatus,
    environment: context.metadata.environment,
    scenarios,
    roles,
    findings: deduplicatedFindings,
    scorecards: roleScorecards(roles, scenarios, deduplicatedFindings),
    statistics: statistics(scenarios, deduplicatedFindings),
    coverageExceptions: coverageExceptions(scenarios),
    limitations: unique(limitations),
    humanTestingRequired,
    evidencePaths: unique(evidencePaths),
    exitDecision: decision,
  });
}

export async function runQaReport(options: ReportRunnerOptions = {}): Promise<ReportRunResult> {
  const generatedAt = new Date().toISOString();
  let context: ReportContext | undefined;
  try {
    context = await resolveReportContext(options);
    const report = await buildReport(context, options, generatedAt);
    const reportPaths = await generateReports(context.artifactRoot, report);
    const reasons = report.exitDecision.reasons;
    return {
      schemaVersion: 2,
      runId: report.runId,
      runStatus: report.runStatus,
      productQualityStatus: report.productQualityStatus,
      generatedAt,
      artifactRoot: context.artifactRoot,
      reportPaths,
      reason: reasons.length
        ? reasons.join('; ')
        : 'Reports generated successfully.',
      exitCode: report.exitDecision.exitCode as 0 | 1 | 2,
    };
  } catch (error) {
    const runStatus = error instanceof ReportRunnerIssue && error.status === 'BLOCKED'
      ? 'BLOCKED' as const
      : 'INFRASTRUCTURE_FAILED' as const;
    const reason = redactText(error instanceof Error ? error.message : 'QA report generation failed.');
    return {
      schemaVersion: 2,
      runId: context?.metadata.runId ?? null,
      runStatus,
      productQualityStatus: 'PASS',
      generatedAt,
      artifactRoot: context?.artifactRoot ?? null,
      reportPaths: [],
      reason,
      exitCode: runStatus === 'BLOCKED' ? 2 : 1,
    };
  }
}

function argumentValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMainModule()) {
  const result = await runQaReport({
    repoRoot: argumentValue('repo-root'),
    artifactRoot: argumentValue('artifact-root'),
    failOnMedium: process.argv.includes('--fail-on-medium') ? true : undefined,
    includePlatformAdmin: !process.argv.includes('--no-platform-admin'),
  });
  process.stdout.write(safeJson(result) + '\n');
  process.exitCode = result.exitCode;
}
