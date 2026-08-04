import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { redactText, safeJson } from '../reporting/redact.ts';
import { acquireQaLock, releaseQaLock } from './lock.ts';
import { deterministicChildEnvironment, loadReadyQaState } from './runtime-state.ts';
import { scrubPlaywrightTraces } from './scrub-artifacts.ts';
import { startQaPreview } from './setup.ts';

type PhaseStatus = 'PASSED' | 'FAILED' | 'BLOCKED' | 'SKIPPED_BY_CONFIGURATION';

export interface PhaseResult {
  name: string;
  status: PhaseStatus;
  exitCode: number | null;
  durationMs: number;
  reason?: string;
}

export interface DeterministicRunResult {
  schemaVersion: 1;
  runId: string;
  status: Exclude<PhaseStatus, 'SKIPPED_BY_CONFIGURATION'>;
  startedAt: string;
  endedAt: string;
  phases: PhaseResult[];
  redactedTraces: string[];
  playwrightReport: string;
  exitCode: number;
}

const CRITICAL_WORKFLOW_IDS = [
  'supplier-price-list',
  'kitchen-receiving',
  'office-invoice-review',
  'owner-payment-approval',
  'payer-transfer-execution',
  'accountant-reconciliation',
] as const;

type CriticalWorkflowId = (typeof CRITICAL_WORKFLOW_IDS)[number];

interface CriticalWorkflowObservation {
  id: CriticalWorkflowId;
  resultStatus: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function criticalWorkflowId(value: string): value is CriticalWorkflowId {
  return (CRITICAL_WORKFLOW_IDS as readonly string[]).includes(value);
}

function collectCriticalWorkflowObservations(report: unknown): {
  observations: CriticalWorkflowObservation[];
  invalidMarker: boolean;
} {
  const observations: CriticalWorkflowObservation[] = [];
  let invalidMarker = false;

  const visitSuite = (value: unknown): void => {
    const suite = record(value);
    if (!suite) {
      invalidMarker = true;
      return;
    }
    for (const specValue of array(suite.specs)) {
      const spec = record(specValue);
      if (!spec) {
        invalidMarker = true;
        continue;
      }
      const title = typeof spec.title === 'string' ? spec.title : '';
      const markers = [...title.matchAll(/\[critical:([a-z0-9-]+)\]/g)].map((match) => match[1]);
      if (markers.length === 0) continue;
      if (markers.length !== 1 || !criticalWorkflowId(markers[0])) {
        invalidMarker = true;
        continue;
      }
      for (const testValue of array(spec.tests)) {
        const reportTest = record(testValue);
        if (!reportTest || reportTest.projectName !== 'critical-workflows') continue;
        const results = array(reportTest.results);
        const lastResult = record(results.at(-1));
        observations.push({
          id: markers[0],
          resultStatus: typeof lastResult?.status === 'string' ? lastResult.status : null,
        });
      }
    }
    for (const child of array(suite.suites)) visitSuite(child);
  };

  const root = record(report);
  if (!root) return { observations, invalidMarker: true };
  for (const suite of array(root.suites)) visitSuite(suite);
  return { observations, invalidMarker };
}

export function evaluateCriticalWorkflowCoverage(report: unknown): PhaseResult {
  const { observations, invalidMarker } = collectCriticalWorkflowObservations(report);
  const grouped = new Map<CriticalWorkflowId, CriticalWorkflowObservation[]>();
  for (const id of CRITICAL_WORKFLOW_IDS) grouped.set(id, []);
  for (const observation of observations) grouped.get(observation.id)!.push(observation);

  const missing = CRITICAL_WORKFLOW_IDS.filter((id) => grouped.get(id)!.length === 0);
  const duplicated = CRITICAL_WORKFLOW_IDS.filter((id) => grouped.get(id)!.length > 1);
  const failed = CRITICAL_WORKFLOW_IDS.filter((id) => grouped.get(id)!
    .some(({ resultStatus }) => ['failed', 'timedOut', 'interrupted'].includes(resultStatus ?? '')));
  const incomplete = CRITICAL_WORKFLOW_IDS.filter((id) => {
    const entries = grouped.get(id)!;
    return entries.length === 1 && entries[0].resultStatus !== 'passed'
      && !['failed', 'timedOut', 'interrupted'].includes(entries[0].resultStatus ?? '');
  });

  if (failed.length > 0) {
    return {
      name: 'critical-workflow-coverage',
      status: 'FAILED',
      exitCode: 1,
      durationMs: 0,
      reason: `Critical UI workflow failed: ${failed.join(', ')}.`,
    };
  }
  if (invalidMarker || missing.length > 0 || duplicated.length > 0 || incomplete.length > 0) {
    const details = [
      invalidMarker ? 'invalid marker/report structure' : '',
      missing.length ? `missing: ${missing.join(', ')}` : '',
      duplicated.length ? `duplicate: ${duplicated.join(', ')}` : '',
      incomplete.length ? `skipped or incomplete: ${incomplete.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    return {
      name: 'critical-workflow-coverage',
      status: 'BLOCKED',
      exitCode: null,
      durationMs: 0,
      reason: `Required critical UI workflow evidence is incomplete (${details}).`,
    };
  }
  return {
    name: 'critical-workflow-coverage',
    status: 'PASSED',
    exitCode: 0,
    durationMs: 0,
  };
}

async function criticalWorkflowCoveragePhase(reportPath: string): Promise<PhaseResult> {
  const started = Date.now();
  try {
    const parsed: unknown = JSON.parse(await readFile(reportPath, 'utf8'));
    return { ...evaluateCriticalWorkflowCoverage(parsed), durationMs: Date.now() - started };
  } catch {
    return {
      name: 'critical-workflow-coverage',
      status: 'BLOCKED',
      exitCode: null,
      durationMs: Date.now() - started,
      reason: 'The Playwright JSON report was missing or malformed; critical workflow coverage was not inferred.',
    };
  }
}

async function runCommand(
  name: string,
  executable: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<PhaseResult> {
  const started = Date.now();
  let exitCode: number;
  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(executable, [...args], {
        cwd: options.cwd,
        env: options.env,
        stdio: 'inherit',
        windowsHide: true,
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
  } catch (error) {
    return {
      name,
      status: 'BLOCKED',
      exitCode: null,
      durationMs: Date.now() - started,
      reason: redactText(error instanceof Error ? error.message : name + ' could not start.'),
    };
  }
  return {
    name,
    status: exitCode === 0 ? 'PASSED' : 'FAILED',
    exitCode,
    durationMs: Date.now() - started,
    reason: exitCode === 0 ? undefined : name + ' exited with code ' + exitCode + '.',
  };
}

async function writeResult(filePath: string, result: DeterministicRunResult): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = filePath + '.tmp';
  await writeFile(temporary, safeJson(result) + '\n', 'utf8');
  await rename(temporary, filePath);
}

function overall(phases: readonly PhaseResult[]): {
  status: DeterministicRunResult['status'];
  exitCode: number;
} {
  if (phases.some(({ status }) => status === 'FAILED')) return { status: 'FAILED', exitCode: 1 };
  if (phases.some(({ status }) => status === 'BLOCKED')) return { status: 'BLOCKED', exitCode: 2 };
  return { status: 'PASSED', exitCode: 0 };
}

export async function runDeterministicQa(repoRoot = process.cwd()): Promise<DeterministicRunResult> {
  const repository = path.resolve(repoRoot);
  const state = await loadReadyQaState(repository);
  const resultPath = path.join(state.artifactRoot, 'results', 'deterministic.json');
  const playwrightReport = path.join(state.artifactRoot, 'playwright-results.json');
  const startedAt = new Date().toISOString();
  const phases: PhaseResult[] = [];
  const redactedTraces: string[] = [];
  const lock = await acquireQaLock({ repoRoot: repository, runId: 'deterministic-' + state.runId });

  if (lock.status === 'BLOCKED') {
    const endedAt = new Date().toISOString();
    const result: DeterministicRunResult = {
      schemaVersion: 1,
      runId: state.runId,
      status: 'BLOCKED',
      startedAt,
      endedAt,
      phases: [{
        name: 'environment-lock',
        status: 'BLOCKED',
        exitCode: null,
        durationMs: 0,
        reason: lock.message,
      }],
      redactedTraces,
      playwrightReport,
      exitCode: 2,
    };
    await writeResult(resultPath, result);
    return result;
  }

  const environment = deterministicChildEnvironment(state);
  let preview: Awaited<ReturnType<typeof startQaPreview>> | undefined;
  try {
    const staticCommands: ReadonlyArray<readonly [string, string[]]> = [
      ['qa-typecheck', [path.join(repository, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'qa/tsconfig.json', '--noEmit']],
      ['qa-unit-integration', ['--test', 'qa/**/*.test.ts']],
      ['document-export-contract', ['scripts/check-document-export.ts']],
    ];
    for (const [name, args] of staticCommands) {
      const phase = await runCommand(name, process.execPath, args, { cwd: repository, env: environment });
      phases.push(phase);
      if (phase.status !== 'PASSED') break;
    }

    if (!phases.some(({ status }) => status === 'FAILED')) {
      try {
        await access(chromium.executablePath());
        phases.push({ name: 'chromium-installed', status: 'PASSED', exitCode: 0, durationMs: 0 });
      } catch {
        phases.push({
          name: 'chromium-installed',
          status: 'BLOCKED',
          exitCode: null,
          durationMs: 0,
          reason: 'Playwright Chromium is missing; run npm run qa:install-browser.',
        });
      }
    }

    if (!phases.some(({ status }) => status === 'FAILED' || status === 'BLOCKED')) {
      try {
        preview = await startQaPreview({
          repoRoot: repository,
          baseUrl: state.environment.baseUrl,
          anonKey: state.browserPublic!.supabaseAnonKey,
        });
        phases.push({ name: 'preview-ready', status: 'PASSED', exitCode: 0, durationMs: 0 });
      } catch (error) {
        phases.push({
          name: 'preview-ready',
          status: 'BLOCKED',
          exitCode: null,
          durationMs: 0,
          reason: redactText(error instanceof Error ? error.message : 'Preview unavailable.'),
        });
      }
    }

    if (preview) {
      const playwrightCli = path.join(repository, 'node_modules', '@playwright', 'test', 'cli.js');
      phases.push(await runCommand(
        'playwright-deterministic',
        process.execPath,
        [playwrightCli, 'test', '-c', 'qa/playwright.config.ts'],
        { cwd: repository, env: environment },
      ));
      phases.push(await criticalWorkflowCoveragePhase(playwrightReport));
      try {
        redactedTraces.push(...await scrubPlaywrightTraces(state.artifactRoot));
        phases.push({ name: 'trace-redaction', status: 'PASSED', exitCode: 0, durationMs: 0 });
      } catch (error) {
        phases.push({
          name: 'trace-redaction',
          status: 'FAILED',
          exitCode: 1,
          durationMs: 0,
          reason: redactText(error instanceof Error ? error.message : 'Trace redaction failed.'),
        });
      }
    }
  } finally {
    if (preview) {
      try {
        await preview.stop();
        phases.push({ name: 'preview-stopped', status: 'PASSED', exitCode: 0, durationMs: 0 });
      } catch (error) {
        phases.push({
          name: 'preview-stopped',
          status: 'FAILED',
          exitCode: 1,
          durationMs: 0,
          reason: redactText(error instanceof Error ? error.message : 'Preview cleanup failed.'),
        });
      }
    }
    const released = await releaseQaLock(lock.handle);
    if (!released) {
      phases.push({
        name: 'environment-lock-release',
        status: 'FAILED',
        exitCode: 1,
        durationMs: 0,
        reason: 'QA mutex ownership could not be verified during release.',
      });
    }
  }

  const decision = overall(phases);
  const result: DeterministicRunResult = {
    schemaVersion: 1,
    runId: state.runId,
    status: decision.status,
    startedAt,
    endedAt: new Date().toISOString(),
    phases,
    redactedTraces,
    playwrightReport,
    exitCode: decision.exitCode,
  };
  await writeResult(resultPath, result);
  return result;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMainModule()) {
  try {
    const result = await runDeterministicQa();
    process.stdout.write(safeJson(result) + '\n');
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(redactText(error instanceof Error ? error.message : 'QA deterministic run failed.') + '\n');
    process.exitCode = 2;
  }
}
