import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BlockerType, RunStatus } from '../reporting/schemas.ts';
import { redactText, safeJson } from '../reporting/redact.ts';
import { runAgentQa, type AgentRunResult } from './agent-runner.ts';
import { cleanupQaRun, type CleanupResult } from './clean.ts';
import {
  runDeterministicQa,
  type DeterministicRunResult,
} from './deterministic-runner.ts';
import {
  prepareQaReportMetadata,
  runQaReport,
  type ReportRunResult,
} from './report-runner.ts';
import { setupQaRun, type SetupResult } from './setup.ts';

const FULL_RESULT_RELATIVE_PATH = path.join('results', 'full.json');
const CLEANUP_RESULT_RELATIVE_PATH = path.join('results', 'cleanup.json');

export interface FullRunnerOptions {
  repoRoot?: string;
  baseUrl?: string;
  failOnMedium?: boolean;
  includePlatformAdmin?: boolean;
}

export interface FullPhaseResult {
  name: 'setup' | 'deterministic' | 'agent-data-refresh' | 'agents' | 'report' | 'cleanup';
  status: RunStatus;
  blockerType?: BlockerType;
  exitCode: 0 | 1 | 2;
  reason: string;
  artifact?: string;
}

export interface FullRunResult {
  schemaVersion: 2;
  runId: string | null;
  runStatus: 'COMPLETED' | 'BLOCKED' | 'INFRASTRUCTURE_FAILED';
  productQualityStatus: 'PASS' | 'PASS_WITH_FINDINGS' | 'FAIL';
  startedAt: string;
  endedAt: string;
  repoRoot: string;
  artifactRoot: string | null;
  phases: FullPhaseResult[];
  reportPaths: string[];
  issues: string[];
  cleanupVerified: boolean;
  artifactsPreserved: boolean;
  exitCode: 0 | 1 | 2;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function normalizedExit(status: RunStatus): 0 | 1 | 2 {
  if (status === 'PASSED' || status === 'SKIPPED_BY_CONFIGURATION' || status === 'OPTIONAL_BLOCKED') return 0;
  return status === 'FAILED' ? 1 : 2;
}

function fallbackRunStatus(phases: readonly FullPhaseResult[]): FullRunResult['runStatus'] {
  if (phases.some(({ status, blockerType }) => status === 'FAILED' && blockerType !== 'PRODUCT')) {
    return 'INFRASTRUCTURE_FAILED';
  }
  if (phases.some(({ status }) => status === 'BLOCKED')) return 'BLOCKED';
  return 'COMPLETED';
}

export function mergeFullRunStatus(
  phases: readonly FullPhaseResult[],
  reportRunStatus?: FullRunResult['runStatus'] | null,
): FullRunResult['runStatus'] {
  const phaseRunStatus = fallbackRunStatus(phases);
  if (phaseRunStatus === 'INFRASTRUCTURE_FAILED'
      || reportRunStatus === 'INFRASTRUCTURE_FAILED') {
    return 'INFRASTRUCTURE_FAILED';
  }
  if (phaseRunStatus === 'BLOCKED' || reportRunStatus === 'BLOCKED') return 'BLOCKED';
  return 'COMPLETED';
}

export function mergeProductQualityStatus(
  phases: readonly FullPhaseResult[],
  reportProductQualityStatus?: FullRunResult['productQualityStatus'] | null,
): FullRunResult['productQualityStatus'] {
  if (phases.some(({ status, blockerType }) =>
    status === 'FAILED' && blockerType === 'PRODUCT')) {
    return 'FAIL';
  }
  return reportProductQualityStatus ?? 'PASS';
}

const REQUIRED_AGENT_PRECONDITION_PHASES = [
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

const PRODUCT_RESULT_PHASES = [
  'playwright-deterministic',
  'critical-workflow-coverage',
] as const;

/**
 * Agent exploration may continue after a proved product failure, but never when a deterministic
 * prerequisite or evidence-cleanup phase is missing, blocked, or failed.
 */
export function deterministicAgentPreconditionsSatisfied(
  result: DeterministicRunResult,
): boolean {
  const exactlyOneWithStatus = (name: string, accepted: readonly RunStatus[]): boolean => {
    const matching = result.phases.filter((phase) => phase.name === name);
    return matching.length === 1 && accepted.includes(matching[0]!.status);
  };
  const required = new Set<string>(REQUIRED_AGENT_PRECONDITION_PHASES);
  const product = new Set<string>(PRODUCT_RESULT_PHASES);
  return REQUIRED_AGENT_PRECONDITION_PHASES.every((name) =>
    exactlyOneWithStatus(name, ['PASSED']))
    && PRODUCT_RESULT_PHASES.every((name) =>
      exactlyOneWithStatus(name, ['PASSED', 'FAILED']))
    && result.phases.every((phase) =>
      required.has(phase.name)
        ? phase.status === 'PASSED'
        : product.has(phase.name)
          ? phase.status === 'PASSED' || phase.status === 'FAILED'
          : phase.status === 'PASSED');
}

function fullExitCode(
  runStatus: FullRunResult['runStatus'],
  productQualityStatus: FullRunResult['productQualityStatus'],
): 0 | 1 | 2 {
  if (runStatus === 'BLOCKED') return 2;
  if (runStatus === 'INFRASTRUCTURE_FAILED' || productQualityStatus === 'FAIL') return 1;
  return 0;
}

function setupPhase(result: SetupResult): FullPhaseResult {
  const status: RunStatus = result.status === 'READY' ? 'PASSED' : result.status;
  return {
    name: 'setup',
    status,
    exitCode: normalizedExit(status),
    reason: result.status === 'READY'
      ? 'Local isolated QA setup completed.'
      : redactText(result.reason),
    artifact: result.artifactRoot,
  };
}

function deterministicPhase(result: DeterministicRunResult): FullPhaseResult {
  const nonPassing = result.phases
    .filter(({ status }) => status === 'FAILED' || status === 'BLOCKED')
    .map(({ name, reason }) => `${name}: ${redactText(reason ?? 'no safe detail')}`);
  return {
    name: 'deterministic',
    status: result.status,
    blockerType: result.status === 'PASSED'
      ? undefined
      : deterministicAgentPreconditionsSatisfied(result) ? 'PRODUCT' : 'INFRASTRUCTURE',
    exitCode: normalizedExit(result.status),
    reason: nonPassing.length ? nonPassing.join('; ') : 'Deterministic QA gates passed.',
    artifact: result.playwrightReport,
  };
}

function agentPhase(result: AgentRunResult): FullPhaseResult {
  return {
    name: 'agents',
    status: result.status,
    blockerType: result.blockerType ?? undefined,
    exitCode: normalizedExit(result.status),
    reason: redactText(result.reason),
  };
}

export function reportPhase(result: ReportRunResult): FullPhaseResult {
  const status: RunStatus = result.runStatus === 'COMPLETED'
    ? result.productQualityStatus === 'FAIL' ? 'FAILED' : 'PASSED'
    : result.runStatus === 'BLOCKED' ? 'BLOCKED' : 'FAILED';
  return {
    name: 'report',
    status,
    blockerType: status === 'PASSED'
      ? undefined
      : result.runStatus === 'COMPLETED' ? 'PRODUCT' : 'INFRASTRUCTURE',
    exitCode: result.exitCode,
    reason: redactText(result.reason),
    artifact: result.reportPaths.find((value) => path.basename(value) === 'report.json'),
  };
}

function cleanupPhase(result: CleanupResult): FullPhaseResult {
  const status: RunStatus = result.status === 'CLEAN' ? 'PASSED' : result.status;
  return {
    name: 'cleanup',
    status,
    exitCode: normalizedExit(status),
    reason: result.status === 'CLEAN'
      ? 'Cleanup reset and managed-path verification completed; report artifacts were preserved.'
      : redactText(result.reason),
  };
}

export function agentDataRefreshPhase(
  expected: { runId: string; artifactRoot: string },
  cleanupResult: CleanupResult | null,
  refreshedSetup: SetupResult | null,
): FullPhaseResult {
  const name = 'agent-data-refresh' as const;
  if (!cleanupResult) {
    return {
      name,
      status: 'FAILED',
      blockerType: 'INFRASTRUCTURE',
      exitCode: 1,
      reason: 'The pre-agent local cleanup did not return a result.',
      artifact: expected.artifactRoot,
    };
  }
  if (cleanupResult.status !== 'CLEAN') {
    return {
      name,
      status: cleanupResult.status,
      blockerType: 'INFRASTRUCTURE',
      exitCode: normalizedExit(cleanupResult.status),
      reason: redactText(cleanupResult.reason),
      artifact: expected.artifactRoot,
    };
  }
  if (cleanupResult.runId !== expected.runId) {
    return {
      name,
      status: 'FAILED',
      blockerType: 'INFRASTRUCTURE',
      exitCode: 1,
      reason: 'The pre-agent cleanup result does not belong to the expected QA run.',
      artifact: expected.artifactRoot,
    };
  }
  if (!cleanupResult.resetPerformed || !cleanupResult.artifactsPreserved) {
    return {
      name,
      status: 'FAILED',
      blockerType: 'INFRASTRUCTURE',
      exitCode: 1,
      reason: 'The pre-agent cleanup did not prove a local reset with preserved artifacts.',
      artifact: expected.artifactRoot,
    };
  }
  if (!refreshedSetup) {
    return {
      name,
      status: 'FAILED',
      blockerType: 'INFRASTRUCTURE',
      exitCode: 1,
      reason: 'The pre-agent setup did not return a result after the local reset.',
      artifact: expected.artifactRoot,
    };
  }
  if (refreshedSetup.status !== 'READY') {
    return {
      name,
      status: refreshedSetup.status,
      blockerType: 'INFRASTRUCTURE',
      exitCode: normalizedExit(refreshedSetup.status),
      reason: redactText(refreshedSetup.reason),
      artifact: expected.artifactRoot,
    };
  }
  if (refreshedSetup.runId !== expected.runId
      || path.resolve(refreshedSetup.artifactRoot) !== path.resolve(expected.artifactRoot)) {
    return {
      name,
      status: 'FAILED',
      blockerType: 'INFRASTRUCTURE',
      exitCode: 1,
      reason: 'The refreshed setup did not preserve the original runId and artifact root.',
      artifact: expected.artifactRoot,
    };
  }
  return {
    name,
    status: 'PASSED',
    exitCode: 0,
    reason: 'The local database, credentials, fixtures, and role auth states were rebuilt for the AI phase under the original runId.',
    artifact: expected.artifactRoot,
  };
}

function notRunPhase(
  name: FullPhaseResult['name'],
  status: Extract<RunStatus, 'BLOCKED' | 'SKIPPED_BY_CONFIGURATION'>,
  reason: string,
): FullPhaseResult {
  return { name, status, exitCode: normalizedExit(status), reason };
}

function failedPhase(name: FullPhaseResult['name'], error: unknown): FullPhaseResult {
  return {
    name,
    status: 'FAILED',
    exitCode: 1,
    reason: redactText(error instanceof Error ? error.message : `${name} runner failed unexpectedly.`),
  };
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

async function writeFullResult(artifactRoot: string, result: FullRunResult): Promise<void> {
  const outputPath = path.join(artifactRoot, FULL_RESULT_RELATIVE_PATH);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporary = outputPath + '.tmp';
  await writeFile(temporary, safeJson(result) + '\n', 'utf8');
  await rename(temporary, outputPath);
}

async function writeCleanupResult(
  artifactRoot: string,
  runId: string,
  result: CleanupResult | null,
  fallback?: FullPhaseResult,
): Promise<void> {
  const outputPath = path.join(artifactRoot, CLEANUP_RESULT_RELATIVE_PATH);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const stored = {
    schemaVersion: 1,
    runId,
    status: result?.status ?? fallback?.status ?? 'FAILED',
    reason: result?.status === 'CLEAN'
      ? 'Cleanup reset and managed-path verification completed.'
      : redactText(result?.reason ?? fallback?.reason ?? 'Cleanup result was unavailable.'),
    resetPerformed: result?.resetPerformed ?? false,
    artifactsPreserved: result?.artifactsPreserved ?? true,
  };
  const temporary = outputPath + '.tmp';
  await writeFile(temporary, safeJson(stored) + '\n', 'utf8');
  await rename(temporary, outputPath);
}

export async function runFullQa(options: FullRunnerOptions = {}): Promise<FullRunResult> {
  const startedAt = new Date().toISOString();
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const phases: FullPhaseResult[] = [];
  let setup: SetupResult | null = null;
  let deterministic: DeterministicRunResult | null = null;
  let agents: AgentRunResult | null = null;
  let report: ReportRunResult | null = null;
  let cleanup: CleanupResult | null = null;
  let cleanupTarget: SetupResult | null = null;
  let cleanEnvironmentBeforeAgent: CleanupResult | null = null;
  let reportPreparationError: unknown;

  try {
    setup = await setupQaRun({ repoRoot, baseUrl: options.baseUrl });
    cleanupTarget = setup;
    phases.push(setupPhase(setup));
  } catch (error) {
    phases.push(failedPhase('setup', error));
  }

  const initialReadySetup = setup?.status === 'READY' ? setup : null;
  if (initialReadySetup) {
    try {
      await prepareQaReportMetadata(repoRoot);
    } catch (error) {
      reportPreparationError = error;
    }
    try {
      deterministic = await runDeterministicQa(repoRoot);
      phases.push(deterministicPhase(deterministic));
    } catch (error) {
      phases.push(failedPhase('deterministic', error));
    }

    if (deterministic && deterministicAgentPreconditionsSatisfied(deterministic)) {
      let refreshPhase: FullPhaseResult;
      try {
        const refreshCleanup = await cleanupQaRun({
          repoRoot,
          statePath: initialReadySetup.statePath,
          keepArtifacts: true,
        });
        let refreshedSetup: SetupResult | null = null;
        if (refreshCleanup.status === 'CLEAN') {
          cleanEnvironmentBeforeAgent = refreshCleanup;
          cleanupTarget = null;
          refreshedSetup = await setupQaRun({
            repoRoot,
            baseUrl: options.baseUrl,
            runId: initialReadySetup.runId,
          });
          cleanupTarget = refreshedSetup;
        }
        refreshPhase = agentDataRefreshPhase({
          runId: initialReadySetup.runId,
          artifactRoot: initialReadySetup.artifactRoot,
        }, refreshCleanup, refreshedSetup);
      } catch (error) {
        refreshPhase = failedPhase('agent-data-refresh', error);
      }
      phases.push(refreshPhase);

      if (refreshPhase.status === 'PASSED') {
        try {
          agents = await runAgentQa(repoRoot);
          phases.push(agentPhase(agents));
        } catch (error) {
          phases.push(failedPhase('agents', error));
        }
      } else {
        phases.push(notRunPhase(
          'agents',
          'BLOCKED',
          'Agent phase was not run because the isolated pre-agent dataset refresh did not complete safely.',
        ));
      }
    } else {
      phases.push(notRunPhase(
        'agent-data-refresh',
        'BLOCKED',
        'The pre-agent dataset refresh was not run because deterministic infrastructure preconditions did not complete safely.',
      ));
      phases.push(notRunPhase(
        'agents',
        'BLOCKED',
        'Agent phase was not run because one or more deterministic infrastructure preconditions did not complete safely.',
      ));
    }

  } else {
    const prerequisite = setup
      ? `Report and execution phases were not run because setup returned ${setup.status}.`
      : 'Report and execution phases were not run because setup failed unexpectedly.';
    phases.push(notRunPhase('deterministic', 'BLOCKED', prerequisite));
    phases.push(notRunPhase('agent-data-refresh', 'BLOCKED', prerequisite));
    phases.push(notRunPhase('agents', 'BLOCKED', prerequisite));
  }

  const ownsCleanupState = Boolean(
    cleanupTarget?.cleanupRequired
      && (cleanupTarget.status === 'READY'
        || !('code' in cleanupTarget)
        || cleanupTarget.code !== 'existing_qa_state'),
  );
  if (cleanupTarget && ownsCleanupState) {
    try {
      cleanup = await cleanupQaRun({
        repoRoot,
        statePath: cleanupTarget.statePath,
        keepArtifacts: true,
      });
      phases.push(cleanupPhase(cleanup));
    } catch (error) {
      phases.push(failedPhase('cleanup', error));
    }
  } else if (cleanupTarget?.status !== 'READY'
      && cleanupTarget
      && 'code' in cleanupTarget
      && cleanupTarget.code === 'existing_qa_state') {
    phases.push(notRunPhase(
      'cleanup',
      'BLOCKED',
      'An existing QA state belongs to another run; full-runner did not clean it automatically.',
    ));
  } else if (cleanEnvironmentBeforeAgent?.status === 'CLEAN') {
    cleanup = cleanEnvironmentBeforeAgent;
    phases.push(cleanupPhase(cleanup));
  } else {
    phases.push(notRunPhase(
      'cleanup',
      'SKIPPED_BY_CONFIGURATION',
      'Setup did not create managed runtime state, so cleanup was not required.',
    ));
  }

  if (initialReadySetup && await exists(initialReadySetup.artifactRoot)) {
    try {
      const cleanupPhaseResult = [...phases].reverse().find(({ name }) => name === 'cleanup');
      await writeCleanupResult(
        initialReadySetup.artifactRoot,
        initialReadySetup.runId,
        cleanup,
        cleanupPhaseResult,
      );
      if (reportPreparationError) throw reportPreparationError;
      report = await runQaReport({
        repoRoot,
        artifactRoot: initialReadySetup.artifactRoot,
        failOnMedium: options.failOnMedium,
        includePlatformAdmin: options.includePlatformAdmin,
      });
      phases.push(reportPhase(report));
    } catch (error) {
      phases.push(failedPhase('report', error));
    }
  } else {
    const prerequisite = setup
      ? `Report phase was not run because setup returned ${setup.status}.`
      : 'Report phase was not run because setup failed unexpectedly.';
    phases.push(notRunPhase('report', 'BLOCKED', prerequisite));
  }

  const runStatus = mergeFullRunStatus(phases, report?.runStatus);
  const productQualityStatus = mergeProductQualityStatus(phases, report?.productQualityStatus);
  const result: FullRunResult = {
    schemaVersion: 2,
    runId: setup?.runId ?? null,
    runStatus,
    productQualityStatus,
    startedAt,
    endedAt: new Date().toISOString(),
    repoRoot,
    artifactRoot: setup?.artifactRoot ?? report?.artifactRoot ?? null,
    phases,
    reportPaths: report?.reportPaths ?? [],
    issues: unique(phases
      .filter(({ status: phaseStatus }) => phaseStatus === 'FAILED' || phaseStatus === 'BLOCKED')
      .map(({ name, reason }) => `${name}: ${reason}`)),
    cleanupVerified: cleanup?.status === 'CLEAN' && cleanup.resetPerformed,
    artifactsPreserved: cleanup?.status === 'CLEAN'
      ? cleanup.artifactsPreserved
      : Boolean(cleanup?.artifactsPreserved),
    exitCode: fullExitCode(runStatus, productQualityStatus),
  };

  if (result.artifactRoot && await exists(result.artifactRoot)) {
    try {
      await writeFullResult(result.artifactRoot, result);
    } catch (error) {
      const reason = redactText(error instanceof Error ? error.message : 'Full-run result could not be persisted.');
      result.runStatus = 'INFRASTRUCTURE_FAILED';
      result.exitCode = 1;
      result.issues = unique([...result.issues, `full-result: ${reason}`]);
      result.endedAt = new Date().toISOString();
    }
  }

  return result;
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
  const result = await runFullQa({
    repoRoot: argumentValue('repo-root'),
    baseUrl: argumentValue('base-url'),
    failOnMedium: process.argv.includes('--fail-on-medium') ? true : undefined,
    includePlatformAdmin: !process.argv.includes('--no-platform-admin'),
  });
  process.stdout.write(safeJson(result) + '\n');
  process.exitCode = result.exitCode;
}
