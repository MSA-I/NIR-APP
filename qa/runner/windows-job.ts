import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WINDOWS_JOB_HELPER = fileURLToPath(new URL('./windows-job.ps1', import.meta.url));
const DEFAULT_DESCENDANT_GRACE_MS = 10_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 10_000;
const HELPER_STARTUP_GRACE_MS = 20_000;
const HELPER_SHUTDOWN_GRACE_MS = 10_000;
const CONTAINMENT_NOTICE_MS = 30_000;

export type WindowsJobCommandResult =
  | { status: 'EXITED'; exitCode: number }
  | { status: 'TIMED_OUT'; exitCode: null }
  | { status: 'BLOCKED'; exitCode: null; reason: string };

interface WindowsJobProtocolResult {
  schemaVersion: 1;
  token: string;
  status: 'EXITED' | 'TIMED_OUT' | 'BLOCKED';
  exitCode: number | null;
  cleanup: 'JOB_EMPTY';
  reason?: string;
}

interface WindowsJobOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  descendantGraceMs?: number;
  cleanupTimeoutMs?: number;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function childEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function protocolResult(value: unknown, token: string): WindowsJobProtocolResult | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const result = value as Partial<WindowsJobProtocolResult>;
  if (result.schemaVersion !== 1 || result.token !== token) return undefined;
  if (result.cleanup !== 'JOB_EMPTY') return undefined;
  if (
    result.status === 'EXITED'
    && result.cleanup === 'JOB_EMPTY'
    && Number.isSafeInteger(result.exitCode)
  ) {
    return result as WindowsJobProtocolResult;
  }
  if (
    (result.status === 'TIMED_OUT' || result.status === 'BLOCKED')
    && result.exitCode === null
    && (result.reason === undefined || typeof result.reason === 'string')
  ) {
    return result as WindowsJobProtocolResult;
  }
  return undefined;
}

type HelperEvent =
  | { kind: 'EXIT'; code: number | null }
  | { kind: 'ERROR'; error: Error };

function waitForHelperExit(child: ReturnType<typeof spawn>): Promise<HelperEvent> {
  return new Promise((resolve) => {
    child.once('error', (error) => resolve({ kind: 'ERROR', error }));
    child.once('exit', (code) => resolve({ kind: 'EXIT', code }));
  });
}

function holdWindowsContainment(reason: string): Promise<never> {
  // This is intentionally the only unbounded path: without JOB_EMPTY, returning
  // would let runDeterministicQa reach its finally block and release the mutex.
  const notify = (): void => {
    process.stderr.write(
      `[QA BLOCKED] ${reason} The shared QA mutex remains held because ACTIVE_PROCESS_ZERO was not proven.\n`,
    );
  };
  notify();
  setInterval(notify, CONTAINMENT_NOTICE_MS);
  return new Promise<never>(() => undefined);
}

export async function runWindowsJobCommand(
  executable: string,
  args: readonly string[],
  options: WindowsJobOptions,
): Promise<WindowsJobCommandResult> {
  if (process.platform !== 'win32') {
    throw new Error('Windows Job Object commands can only run on Windows.');
  }
  const timeoutMs = positiveInteger(options.timeoutMs, 'timeoutMs');
  const descendantGraceMs = positiveInteger(
    options.descendantGraceMs ?? DEFAULT_DESCENDANT_GRACE_MS,
    'descendantGraceMs',
  );
  const cleanupTimeoutMs = positiveInteger(
    options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
    'cleanupTimeoutMs',
  );
  const token = randomUUID();
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'supplyflow-qa-job-'));
  const resultPath = path.join(temporaryRoot, 'result.json');
  const specification = {
    schemaVersion: 1,
    token,
    parentPid: process.pid,
    executable,
    args: [...args],
    cwd: path.resolve(options.cwd),
    environment: childEnvironment(options.env),
    timeoutMs,
    descendantGraceMs,
    cleanupTimeoutMs,
    resultPath,
  };

  try {
    const helper = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WINDOWS_JOB_HELPER],
      {
        cwd: specification.cwd,
        env: options.env,
        stdio: ['pipe', 'inherit', 'inherit'],
        windowsHide: true,
      },
    );
    helper.stdin.on('error', () => undefined);
    const helperEvent = waitForHelperExit(helper);
    helper.stdin.end(JSON.stringify(specification), 'utf8');

    let secondDeadline: NodeJS.Timeout | undefined;
    let resolveSecondDeadline!: (event: { kind: 'SECOND_DEADLINE' }) => void;
    const secondDeadlineEvent = new Promise<{ kind: 'SECOND_DEADLINE' }>((resolve) => {
      resolveSecondDeadline = resolve;
    });
    const lifetimeWatchdog = setTimeout(() => {
      process.stderr.write(
        '[QA BLOCKED] The Windows Job helper exceeded its expected lifetime; requesting helper termination.\n',
      );
      helper.kill();
      secondDeadline = setTimeout(
        () => resolveSecondDeadline({ kind: 'SECOND_DEADLINE' }),
        HELPER_SHUTDOWN_GRACE_MS,
      );
    }, timeoutMs + descendantGraceMs + cleanupTimeoutMs + HELPER_STARTUP_GRACE_MS);
    const event = await Promise.race([helperEvent, secondDeadlineEvent]);
    clearTimeout(lifetimeWatchdog);
    if (secondDeadline) clearTimeout(secondDeadline);
    if (event.kind === 'SECOND_DEADLINE') {
      return holdWindowsContainment(
        'The Windows Job helper did not exit by its second shutdown deadline.',
      );
    }
    if (event.kind === 'ERROR') {
      if (helper.pid === undefined) throw event.error;
      return holdWindowsContainment(
        'The started Windows Job helper reported an error without JOB_EMPTY evidence.',
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(resultPath, 'utf8'));
    } catch {
      return holdWindowsContainment(
        `The Windows Job helper exited with code ${event.code ?? '<signal>'} without JOB_EMPTY evidence.`,
      );
    }
    const result = protocolResult(parsed, token);
    if (!result) {
      return holdWindowsContainment(
        'The Windows Job helper returned a malformed, mismatched or non-empty result.',
      );
    }
    if (result.status === 'EXITED') return { status: 'EXITED', exitCode: result.exitCode! };
    if (result.status === 'TIMED_OUT') return { status: 'TIMED_OUT', exitCode: null };
    return {
      status: 'BLOCKED',
      exitCode: null,
      reason: result.reason ?? 'The Windows Job helper could not verify safe command completion.',
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
