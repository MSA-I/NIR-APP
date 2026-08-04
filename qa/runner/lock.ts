import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { open, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const LOCAL_QA_PROJECT_ID = 'supplyflow-p0' as const;
export const LOCAL_QA_API_URL = 'http://127.0.0.1:55431' as const;
export const QA_LOCK_PATH = path.join(tmpdir(), `${LOCAL_QA_PROJECT_ID}-qa.lock`);

const COMPETING_PROCESS_PATTERNS: ReadonlyArray<{
  readonly kind: CompetingProcess['kind'];
  readonly pattern: RegExp;
}> = [
  { kind: 'quality-gate', pattern: /check-quality-gates(?:\.ps1)?/i },
  { kind: 'quality-gate', pattern: /npm(?:\.cmd)?\s+(?:run\s+)?quality(?:\s|$)/i },
  { kind: 'database-reset', pattern: /supabase(?:\.exe)?\s+db\s+reset(?:\s|$)/i },
  { kind: 'p0-security-gate', pattern: /check-p0-security(?:\.ps1)?/i },
];

export interface CompetingProcess {
  pid: number;
  kind: 'quality-gate' | 'database-reset' | 'p0-security-gate' | 'qa-runner';
}

interface ProcessSnapshot {
  pid: number;
  commandLine: string;
}

interface QaLockRecord {
  schemaVersion: 1;
  pid: number;
  token: string;
  runId: string;
  repoRoot: string;
  acquiredAt: string;
}

export interface QaLockHandle {
  path: string;
  token: string;
  runId: string;
  pid: number;
}

export type QaLockResult =
  | { status: 'LOCKED'; handle: QaLockHandle }
  | {
      status: 'BLOCKED';
      code: 'competing_quality_process' | 'qa_mutex_held' | 'qa_mutex_invalid';
      message: string;
      competingProcesses: CompetingProcess[];
    };

export interface LocalTargetProof {
  projectId: typeof LOCAL_QA_PROJECT_ID;
  apiUrl: typeof LOCAL_QA_API_URL;
  configPath: string;
}

function normalizePath(value: string): string {
  return path.resolve(value).replaceAll('\\', '/').toLowerCase();
}

function parseProjectId(config: string): string | undefined {
  return /^project_id\s*=\s*["']([^"']+)["']/m.exec(config)?.[1];
}

export async function assertIsolatedLocalTarget(
  repoRoot: string,
  apiUrl: string = LOCAL_QA_API_URL,
): Promise<LocalTargetProof> {
  if (apiUrl !== LOCAL_QA_API_URL) {
    throw new Error(`Refusing non-isolated Supabase URL. Expected ${LOCAL_QA_API_URL}.`);
  }

  const configPath = path.join(path.resolve(repoRoot), 'supabase', 'config.toml');
  const config = await readFile(configPath, 'utf8');
  const projectId = parseProjectId(config);
  if (projectId !== LOCAL_QA_PROJECT_ID) {
    throw new Error(`Refusing project_id=${projectId ?? '<missing>'}; expected ${LOCAL_QA_PROJECT_ID}.`);
  }

  return { projectId: LOCAL_QA_PROJECT_ID, apiUrl: LOCAL_QA_API_URL, configPath };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asPid(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

async function windowsProcessSnapshot(): Promise<ProcessSnapshot[]> {
  const script = [
    'Get-CimInstance Win32_Process',
    "Select-Object ProcessId,CommandLine",
    'ConvertTo-Json -Compress',
  ].join(' | ');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 10_000 },
  );
  if (!stdout.trim()) return [];
  const parsed: unknown = JSON.parse(stdout);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const record = row as Record<string, unknown>;
    const pid = asPid(record.ProcessId);
    if (!pid) return [];
    return [{ pid, commandLine: asString(record.CommandLine) }];
  });
}

async function unixProcessSnapshot(): Promise<ProcessSnapshot[]> {
  const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,args='], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10_000,
  });
  return stdout.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), commandLine: match[2] }] : [];
  });
}

export async function detectCompetingQualityProcesses(
  ignoredPids: readonly number[] = [process.pid],
): Promise<CompetingProcess[]> {
  const ignored = new Set(ignoredPids);
  const snapshot = process.platform === 'win32'
    ? await windowsProcessSnapshot()
    : await unixProcessSnapshot();
  const result = new Map<number, CompetingProcess>();
  for (const processInfo of snapshot) {
    if (ignored.has(processInfo.pid)) continue;
    const match = COMPETING_PROCESS_PATTERNS.find(({ pattern }) => pattern.test(processInfo.commandLine));
    if (match) result.set(processInfo.pid, { pid: processInfo.pid, kind: match.kind });
  }
  return [...result.values()].sort((a, b) => a.pid - b.pid);
}

export async function assertNoCompetingQualityProcess(
  ignoredPids: readonly number[] = [process.pid],
): Promise<void> {
  const competing = await detectCompetingQualityProcesses(ignoredPids);
  if (competing.length > 0) {
    const summary = competing.map(({ pid, kind }) => `${kind}:${pid}`).join(', ');
    throw new Error(`BLOCKED competing_quality_process (${summary})`);
  }
}

function isLockRecord(value: unknown): value is QaLockRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<QaLockRecord>;
  return record.schemaVersion === 1
    && typeof record.pid === 'number'
    && Number.isInteger(record.pid)
    && record.pid > 0
    && typeof record.token === 'string'
    && record.token.length >= 16
    && typeof record.runId === 'string'
    && record.runId.length > 0
    && typeof record.repoRoot === 'string'
    && record.repoRoot.length > 0
    && typeof record.acquiredAt === 'string';
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

async function readLockRecord(): Promise<QaLockRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(QA_LOCK_PATH, 'utf8'));
    return isLockRecord(parsed) ? parsed : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return undefined;
  }
}

export async function acquireQaLock(input: {
  repoRoot: string;
  runId: string;
  ignoredPids?: readonly number[];
}): Promise<QaLockResult> {
  const ignoredPids = input.ignoredPids ?? [process.pid];
  const competingProcesses = await detectCompetingQualityProcesses(ignoredPids);
  if (competingProcesses.length > 0) {
    return {
      status: 'BLOCKED',
      code: 'competing_quality_process',
      message: 'A competing SupplyFlow quality/reset process is using the isolated local stack.',
      competingProcesses,
    };
  }

  const record: QaLockRecord = {
    schemaVersion: 1,
    pid: process.pid,
    token: randomUUID(),
    runId: input.runId,
    repoRoot: path.resolve(input.repoRoot),
    acquiredAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const file = await open(QA_LOCK_PATH, 'wx', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
      } finally {
        await file.close();
      }
      return {
        status: 'LOCKED',
        handle: {
          path: QA_LOCK_PATH,
          token: record.token,
          runId: record.runId,
          pid: record.pid,
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readLockRecord();
      if (!existing) {
        return {
          status: 'BLOCKED',
          code: 'qa_mutex_invalid',
          message: `QA mutex at ${QA_LOCK_PATH} is malformed or unreadable; manual review is required.`,
          competingProcesses: [],
        };
      }
      if (isPidAlive(existing.pid)) {
        return {
          status: 'BLOCKED',
          code: 'qa_mutex_held',
          message: `QA mutex is held by process ${existing.pid} for run ${existing.runId}.`,
          competingProcesses: [{ pid: existing.pid, kind: 'qa-runner' }],
        };
      }
      await unlink(QA_LOCK_PATH);
    }
  }

  return {
    status: 'BLOCKED',
    code: 'qa_mutex_held',
    message: 'QA mutex could not be acquired after removing a stale owner.',
    competingProcesses: [],
  };
}

export async function assertQaLockOwned(handle: QaLockHandle): Promise<void> {
  if (normalizePath(handle.path) !== normalizePath(QA_LOCK_PATH)) {
    throw new Error('QA lock path does not match the isolated lock path.');
  }
  const record = await readLockRecord();
  if (!record || record.token !== handle.token || record.runId !== handle.runId) {
    throw new Error('QA mutex ownership was lost.');
  }
}

export async function releaseQaLock(handle: QaLockHandle): Promise<boolean> {
  if (normalizePath(handle.path) !== normalizePath(QA_LOCK_PATH)) return false;
  const record = await readLockRecord();
  if (!record || record.token !== handle.token || record.runId !== handle.runId) return false;
  await unlink(QA_LOCK_PATH);
  return true;
}
