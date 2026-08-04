import { execFile } from 'node:child_process';
import { access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  LOCAL_QA_API_URL,
  LOCAL_QA_PROJECT_ID,
  acquireQaLock,
  assertIsolatedLocalTarget,
  assertNoCompetingQualityProcess,
  assertQaLockOwned,
  releaseQaLock,
  type QaLockHandle,
} from './lock.ts';
import {
  QA_ARTIFACTS_RELATIVE_ROOT,
  QA_AUTH_RELATIVE_ROOT,
  QA_STATE_RELATIVE_PATH,
  readQaRunState,
  writeQaRunState,
  type QaRunState,
} from './setup.ts';

const execFileAsync = promisify(execFile);

export interface CleanupOptions {
  repoRoot?: string;
  statePath?: string;
  keepArtifacts?: boolean;
}

export type CleanupResult =
  | {
      status: 'CLEAN';
      runId: string;
      statePath: string;
      resetPerformed: true;
      artifactsPreserved: boolean;
      removed: string[];
    }
  | {
      status: 'BLOCKED' | 'FAILED';
      runId?: string;
      statePath: string;
      code: string;
      reason: string;
      resetPerformed: boolean;
      artifactsPreserved: boolean;
      removed: string[];
    };

class CleanupError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CleanupError';
    this.code = code;
  }
}

function cleanChildEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(result)) {
    if (/^QA_|^(?:VITE_)?SUPABASE_|^(?:DATABASE_URL|POSTGRES_URL|PGPASSWORD)$/i.test(key)) delete result[key];
  }
  return result;
}

function assertExactDescendant(target: string, root: string, expectedLeaf?: string): string {
  const absoluteTarget = path.resolve(target);
  const absoluteRoot = path.resolve(root);
  const relative = path.relative(absoluteRoot, absoluteTarget);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new CleanupError('unsafe_cleanup_path', `Refusing cleanup outside ${absoluteRoot}.`);
  }
  if (expectedLeaf && path.basename(absoluteTarget) !== expectedLeaf) {
    throw new CleanupError('unsafe_cleanup_path', `Refusing unexpected cleanup leaf ${path.basename(absoluteTarget)}.`);
  }
  return absoluteTarget;
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

async function command(
  executable: string,
  args: readonly string[],
  repoRoot: string,
  label: string,
  timeoutMs = 300_000,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(executable, [...args], {
      cwd: repoRoot,
      env: cleanChildEnvironment(),
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return stdout;
  } catch (error) {
    const exitCode = (error as { code?: unknown }).code;
    const safeExit = typeof exitCode === 'number' || typeof exitCode === 'string' ? String(exitCode) : 'unknown';
    throw new CleanupError(
      'cleanup_command_failed',
      `${label} failed (exit ${safeExit}); child output is intentionally withheld.`,
    );
  }
}

async function runGuarded(
  lock: QaLockHandle,
  executable: string,
  args: readonly string[],
  repoRoot: string,
  label: string,
  timeoutMs?: number,
): Promise<string> {
  await assertQaLockOwned(lock);
  await assertNoCompetingQualityProcess();
  return command(executable, args, repoRoot, label, timeoutMs);
}

function parseApiUrl(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const match = /^API_URL=(.*)$/.exec(line.trim());
    if (match) return match[1].replace(/^"|"$/g, '');
  }
  return undefined;
}

async function resetLocal(repoRoot: string, lock: QaLockHandle): Promise<void> {
  await assertIsolatedLocalTarget(repoRoot, LOCAL_QA_API_URL);
  await runGuarded(
    lock,
    'supabase',
    ['db', 'reset'],
    repoRoot,
    'Reset isolated local Supabase database',
    300_000,
  );
}

async function verifyLocalAfterReset(repoRoot: string, lock: QaLockHandle): Promise<void> {
  const status = await runGuarded(
    lock,
    'supabase',
    ['status', '-o', 'env'],
    repoRoot,
    'Verify isolated local Supabase status after cleanup',
    30_000,
  );
  if (parseApiUrl(status) !== LOCAL_QA_API_URL) {
    throw new CleanupError('cleanup_target_unverified', 'Post-cleanup Supabase status did not match the isolated API URL.');
  }
}

function validateStatePaths(state: QaRunState, repoRoot: string, actualStatePath: string): {
  authRoot: string;
  artifactRoot: string;
  credentialsManifest: string;
} {
  if (path.resolve(state.repoRoot) !== path.resolve(repoRoot)) {
    throw new CleanupError('state_repo_mismatch', 'QA state belongs to a different repository root.');
  }
  if (path.resolve(state.statePath) !== path.resolve(actualStatePath)) {
    throw new CleanupError('state_path_mismatch', 'QA statePath does not match the file being cleaned.');
  }
  if (state.environment.projectId !== LOCAL_QA_PROJECT_ID || state.environment.supabaseUrl !== LOCAL_QA_API_URL) {
    throw new CleanupError('state_target_mismatch', 'QA state does not describe the isolated local target.');
  }
  const authRoot = assertExactDescendant(
    state.authRoot,
    path.join(repoRoot, QA_AUTH_RELATIVE_ROOT),
    state.runId,
  );
  const artifactRoot = assertExactDescendant(
    state.artifactRoot,
    path.join(repoRoot, QA_ARTIFACTS_RELATIVE_ROOT),
    state.runId,
  );
  const credentialsRoot = assertExactDescendant(
    path.dirname(state.credentialsManifest),
    path.join(tmpdir(), 'supplyflow-qa'),
    state.runId,
  );
  const credentialsManifest = assertExactDescendant(state.credentialsManifest, credentialsRoot, 'credentials.json');
  return { authRoot, artifactRoot, credentialsManifest };
}

function safeFailure(error: unknown): { code: string; reason: string } {
  if (error instanceof CleanupError) return { code: error.code, reason: error.message };
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('BLOCKED competing_quality_process')) {
    return { code: 'competing_quality_process', reason: message };
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return {
    code: typeof code === 'string' ? code : 'cleanup_failed',
    reason: 'QA cleanup failed; raw error output is withheld to avoid leaking credentials.',
  };
}

export async function cleanupQaRun(options: CleanupOptions = {}): Promise<CleanupResult> {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const statePath = path.resolve(options.statePath ?? path.join(repoRoot, QA_STATE_RELATIVE_PATH));
  const keepArtifacts = options.keepArtifacts ?? false;
  const removed: string[] = [];
  let state: QaRunState;

  try {
    await assertIsolatedLocalTarget(repoRoot, LOCAL_QA_API_URL);
    state = await readQaRunState(statePath);
  } catch (error) {
    const failure = safeFailure(error);
    return {
      status: 'BLOCKED',
      statePath,
      ...failure,
      resetPerformed: false,
      artifactsPreserved: keepArtifacts,
      removed,
    };
  }

  let paths: ReturnType<typeof validateStatePaths>;
  try {
    paths = validateStatePaths(state, repoRoot, statePath);
  } catch (error) {
    const failure = safeFailure(error);
    return {
      status: 'BLOCKED',
      runId: state.runId,
      statePath,
      ...failure,
      resetPerformed: false,
      artifactsPreserved: true,
      removed,
    };
  }

  let lockResult: Awaited<ReturnType<typeof acquireQaLock>>;
  try {
    lockResult = await acquireQaLock({ repoRoot, runId: `cleanup-${state.runId}` });
  } catch {
    return {
      status: 'BLOCKED',
      runId: state.runId,
      statePath,
      code: 'process_inspection_failed',
      reason: 'Cleanup could not prove that the isolated stack is free of competing processes.',
      resetPerformed: false,
      artifactsPreserved: true,
      removed,
    };
  }
  if (lockResult.status === 'BLOCKED') {
    return {
      status: 'BLOCKED',
      runId: state.runId,
      statePath,
      code: lockResult.code,
      reason: lockResult.message,
      resetPerformed: false,
      artifactsPreserved: true,
      removed,
    };
  }
  const lock = lockResult.handle;
  let resetPerformed = false;
  let lockReleased = false;

  try {
    state.status = 'CLEANING';
    state.updatedAt = new Date().toISOString();
    await writeQaRunState(state);

    await resetLocal(repoRoot, lock);
    resetPerformed = true;
    await verifyLocalAfterReset(repoRoot, lock);

    for (const target of [paths.authRoot, paths.credentialsManifest]) {
      if (await exists(target)) {
        await rm(target, { recursive: true, force: false });
        removed.push(target);
      }
    }

    if (!keepArtifacts && await exists(paths.artifactRoot)) {
      await rm(paths.artifactRoot, { recursive: true, force: false });
      removed.push(paths.artifactRoot);
    }

    await rm(statePath, { force: false });
    removed.push(statePath);

    const mustBeAbsent = [paths.authRoot, paths.credentialsManifest, statePath];
    if (!keepArtifacts) mustBeAbsent.push(paths.artifactRoot);
    const residual = [];
    for (const target of mustBeAbsent) {
      if (await exists(target)) residual.push(target);
    }
    if (residual.length > 0) {
      throw new CleanupError('cleanup_verification_failed', `Cleanup left ${residual.length} managed paths behind.`);
    }
    lockReleased = await releaseQaLock(lock);
    if (!lockReleased) {
      throw new CleanupError('qa_mutex_release_failed', 'Cleanup could not verify mutex release.');
    }

    return {
      status: 'CLEAN',
      runId: state.runId,
      statePath,
      resetPerformed: true,
      artifactsPreserved: keepArtifacts,
      removed,
    };
  } catch (error) {
    let failure = safeFailure(error);
    if (!lockReleased) {
      lockReleased = await releaseQaLock(lock).catch(() => false);
      if (!lockReleased) {
        failure = {
          code: 'qa_mutex_release_failed',
          reason: 'Cleanup could not verify mutex release.',
        };
      }
    }
    return {
      status: failure.code === 'competing_quality_process' ? 'BLOCKED' : 'FAILED',
      runId: state.runId,
      statePath,
      ...failure,
      resetPerformed,
      artifactsPreserved: true,
      removed,
    };
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMainModule()) {
  const repoArgument = process.argv.find((value) => value.startsWith('--repo-root='))?.slice('--repo-root='.length);
  const stateArgument = process.argv.find((value) => value.startsWith('--state='))?.slice('--state='.length);
  const result = await cleanupQaRun({
    repoRoot: repoArgument,
    statePath: stateArgument,
    keepArtifacts: process.argv.includes('--keep-artifacts'),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.status === 'CLEAN' ? 0 : result.status === 'BLOCKED' ? 2 : 1;
}
