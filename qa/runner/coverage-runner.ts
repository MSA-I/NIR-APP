import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QA_ROLES } from '../config/roles.ts';
import { writeManifest } from '../coverage/build-manifest.ts';
import { writeMatrices } from '../coverage/build-matrices.ts';
import { generateReports } from '../coverage/report.ts';
import { acquireQaLock, releaseQaLock, type QaLockHandle } from './lock.ts';
import { deterministicChildEnvironment, loadReadyQaState } from './runtime-state.ts';
import { startQaPreview } from './setup.ts';

/**
 * The full role-coverage run.
 *
 * It is an extension of the existing QA system, not a replacement: it reuses that system's local
 * target proof, mutex, preview server, authentication states and redaction, and it never resets the
 * database. `qa:setup` still owns the fixtures, and `qa:deterministic` still owns the mandatory
 * gate — this run only adds breadth on top of state those two produced.
 *
 * Roles run one at a time. A parallel walk against one shared local Supabase project would make
 * "kitchen could not see this row" indistinguishable from "office was writing at that moment".
 */

interface RoleRunResult {
  readonly role: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly signal: string | null;
}

/**
 * One Playwright invocation for all six roles.
 *
 * Six separate invocations would each pull in the `auth-setup` dependency and log every role in
 * through the UI again — thirty-six logins to walk six roles. A single invocation with `workers: 1`
 * still runs the projects one after another, which is what the isolation requires; it just does not
 * re-authenticate between them.
 */
function runCoverageProjects(repoRoot: string, environment: NodeJS.ProcessEnv): Promise<RoleRunResult> {
  const cli = path.join(repoRoot, 'node_modules', '@playwright', 'test', 'cli.js');
  const projectArgs = QA_ROLES.flatMap((role) => ['--project', `coverage-${role}`]);
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [cli, 'test', '-c', 'qa/coverage/playwright.coverage.config.ts', ...projectArgs],
      { cwd: repoRoot, env: environment, stdio: 'inherit' },
    );
    child.on('close', (exitCode, signal) => {
      resolve({ role: QA_ROLES.join(','), exitCode, durationMs: Date.now() - startedAt, signal });
    });
  });
}

export async function runCoverage(repoRoot = process.cwd()): Promise<{
  status: 'COMPLETED' | 'BLOCKED' | 'INFRASTRUCTURE_FAILED';
  reason: string;
  runId?: string;
  artifactRoot?: string;
  roleRuns?: RoleRunResult[];
  files?: readonly string[];
  summaryPath?: string;
}> {
  const repository = path.resolve(repoRoot);

  let state;
  try {
    state = await loadReadyQaState(repository);
  } catch (error) {
    return {
      status: 'BLOCKED',
      reason: `QA state is not READY. Run "npm.cmd run qa:setup" first. (${error instanceof Error ? error.message : 'unknown'})`,
    };
  }

  const lock = await acquireQaLock({ repoRoot: repository, runId: state.runId });
  if (lock.status === 'BLOCKED') {
    return { status: 'BLOCKED', reason: `${lock.code}: ${lock.message}`, runId: state.runId };
  }
  const handle: QaLockHandle = lock.handle;

  // The inventory is rebuilt from source on every run. A manifest committed yesterday would
  // silently describe a screen that changed this morning, and the whole point of the reconciliation
  // step is that the two halves are generated from the same tree.
  const { manifest } = writeManifest();
  const { conflicts } = writeMatrices();

  const environment = deterministicChildEnvironment(state);
  let preview: Awaited<ReturnType<typeof startQaPreview>> | undefined;
  const roleRuns: RoleRunResult[] = [];

  try {
    preview = await startQaPreview({
      repoRoot: repository,
      baseUrl: state.environment.baseUrl,
      anonKey: state.browserPublic!.supabaseAnonKey,
    });

    roleRuns.push(await runCoverageProjects(repository, environment));
  } catch (error) {
    await preview?.stop().catch(() => undefined);
    await releaseQaLock(handle);
    return {
      status: 'INFRASTRUCTURE_FAILED',
      reason: `Coverage run could not execute: ${error instanceof Error ? error.message : 'unknown'}`,
      runId: state.runId,
      roleRuns,
    };
  }

  await preview.stop().catch(() => undefined);

  // Reports are generated from whatever records exist, including after a failed role run: a role
  // that died halfway still produced evidence for the routes it reached, and hiding that would
  // turn a partial result into no result at all.
  const { summary, files } = generateReports(state.artifactRoot, state.runId);
  await releaseQaLock(handle);

  const noRecords = summary.totals.componentCoverageRecords === 0;
  return {
    status: noRecords ? 'INFRASTRUCTURE_FAILED' : 'COMPLETED',
    reason: noRecords
      ? 'No coverage records were written; the walk did not produce evidence.'
      : `Coverage status ${summary.coverageStatus}; product quality ${summary.productQualityStatus}.`,
    runId: state.runId,
    artifactRoot: state.artifactRoot,
    roleRuns,
    files: [
      ...files,
      ...(conflicts.length ? [`role-route-matrix conflicts: ${conflicts.length}`] : []),
      `manifest totals: ${JSON.stringify(manifest.totals)}`,
    ],
    summaryPath: path.join('qa', 'coverage', 'coverage-summary.json'),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runCoverage();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.status === 'COMPLETED' ? 0 : result.status === 'BLOCKED' ? 2 : 1;
}
