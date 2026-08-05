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

export type WindowsJobCommandResult =
  | { status: 'EXITED'; exitCode: number }
  | { status: 'TIMED_OUT'; exitCode: null }
  | { status: 'BLOCKED'; exitCode: null; reason: string };

interface WindowsJobProtocolResult {
  schemaVersion: 1;
  token: string;
  status: 'EXITED' | 'TIMED_OUT' | 'BLOCKED';
  exitCode: number | null;
  cleanup: 'JOB_EMPTY' | 'JOB_CLOSED';
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
  if (result.cleanup !== 'JOB_EMPTY' && result.cleanup !== 'JOB_CLOSED') return undefined;
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

async function waitForHelperExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
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
    helper.stdin.end(JSON.stringify(specification), 'utf8');

    let watchdogExpired = false;
    const watchdog = setTimeout(() => {
      watchdogExpired = true;
      // Terminating the helper closes its non-inheritable Job handle. KILL_ON_JOB_CLOSE
      // then terminates every process that was attached before it was resumed.
      helper.kill();
    }, timeoutMs + descendantGraceMs + cleanupTimeoutMs + HELPER_STARTUP_GRACE_MS);
    let helperExitCode: number | null;
    try {
      helperExitCode = await waitForHelperExit(helper);
    } finally {
      clearTimeout(watchdog);
    }
    if (watchdogExpired) {
      return {
        status: 'BLOCKED',
        exitCode: null,
        reason: 'The Windows Job helper exceeded its bounded lifetime and was closed.',
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(resultPath, 'utf8'));
    } catch {
      return {
        status: 'BLOCKED',
        exitCode: null,
        reason: `The Windows Job helper exited with code ${helperExitCode ?? '<signal>'} without a valid result.`,
      };
    }
    const result = protocolResult(parsed, token);
    if (!result) {
      return {
        status: 'BLOCKED',
        exitCode: null,
        reason: 'The Windows Job helper returned a malformed or mismatched result.',
      };
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
