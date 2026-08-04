import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RunStatus } from '../reporting/schemas.ts';
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
  name: 'setup' | 'deterministic' | 'agents' | 'report' | 'cleanup';
  status: RunStatus;
  exitCode: 0 | 1 | 2;
  reason: string;
  artifact?: string;
}

export interface FullRunResult {
  schemaVersion: 1;
  runId: string | null;
  status: 'PASSED' | 'FAILED' | 'BLOCKED';
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

function normalizedExit(status: FullRunResult['status'] | RunStatus): 0 | 1 | 2 {
  if (status === 'PASSED' || status === 'SKIPPED_BY_CONFIGURATION') return 0;
  return status === 'FAILED' ? 1 : 2;
}

function fullStatus(phases: readonly FullPhaseResult[]): FullRunResult['status'] {
  if (phases.some(({ status }) => status === 'FAILED')) return 'FAILED';
  if (phases.some(({ status }) => status === 'BLOCKED')) return 'BLOCKED';
  return 'PASSED';
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
    exitCode: normalizedExit(result.status),
    reason: nonPassing.length ? nonPassing.join('; ') : 'Deterministic QA gates passed.',
    artifact: result.playwrightReport,
  };
}

function agentPhase(result: AgentRunResult): FullPhaseResult {
  return {
    name: 'agents',
    status: result.status,
    exitCode: normalizedExit(result.status),
    reason: redactText(result.reason),
  };
}

function reportPhase(result: ReportRunResult): FullPhaseResult {
  return {
    name: 'report',
    status: result.status,
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
  let reportPreparationError: unknown;

  try {
    setup = await setupQaRun({ repoRoot, baseUrl: options.baseUrl });
    phases.push(setupPhase(setup));
  } catch (error) {
    phases.push(failedPhase('setup', error));
  }

  const setupReady = setup?.status === 'READY';
  if (setupReady) {
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

    if (deterministic?.status === 'PASSED') {
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
        'Agent phase was not run because the deterministic gate did not pass.',
      ));
    }

  } else {
    const prerequisite = setup
      ? `Report and execution phases were not run because setup returned ${setup.status}.`
      : 'Report and execution phases were not run because setup failed unexpectedly.';
    phases.push(notRunPhase('deterministic', 'BLOCKED', prerequisite));
    phases.push(notRunPhase('agents', 'BLOCKED', prerequisite));
  }

  const ownsCleanupState = Boolean(
    setup?.cleanupRequired
      && (setup.status === 'READY' || !('code' in setup) || setup.code !== 'existing_qa_state'),
  );
  if (setup && ownsCleanupState) {
    try {
      cleanup = await cleanupQaRun({
        repoRoot,
        statePath: setup.statePath,
        keepArtifacts: true,
      });
      phases.push(cleanupPhase(cleanup));
    } catch (error) {
      phases.push(failedPhase('cleanup', error));
    }
  } else if (setup?.status !== 'READY' && setup && 'code' in setup && setup.code === 'existing_qa_state') {
    phases.push(notRunPhase(
      'cleanup',
      'BLOCKED',
      'An existing QA state belongs to another run; full-runner did not clean it automatically.',
    ));
  } else {
    phases.push(notRunPhase(
      'cleanup',
      'SKIPPED_BY_CONFIGURATION',
      'Setup did not create managed runtime state, so cleanup was not required.',
    ));
  }

  if (setupReady && setup && await exists(setup.artifactRoot)) {
    try {
      const cleanupPhaseResult = [...phases].reverse().find(({ name }) => name === 'cleanup');
      await writeCleanupResult(setup.artifactRoot, setup.runId, cleanup, cleanupPhaseResult);
      if (reportPreparationError) throw reportPreparationError;
      report = await runQaReport({
        repoRoot,
        artifactRoot: setup.artifactRoot,
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

  const status = fullStatus(phases);
  const result: FullRunResult = {
    schemaVersion: 1,
    runId: setup?.runId ?? null,
    status,
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
    exitCode: normalizedExit(status),
  };

  if (result.artifactRoot && await exists(result.artifactRoot)) {
    try {
      await writeFullResult(result.artifactRoot, result);
    } catch (error) {
      const reason = redactText(error instanceof Error ? error.message : 'Full-run result could not be persisted.');
      result.status = 'FAILED';
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
