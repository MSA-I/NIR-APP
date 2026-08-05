import { randomBytes, randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import {
  FIXTURE_MANIFEST_FILE,
  generateSyntheticFixtureFiles,
  installCrossTenantInvoiceContextFixture,
  loadGeneratedFixtureManifest,
  type GeneratedFixtureManifest,
  type SyntheticFixtureKind,
} from '../fixtures/index.ts';
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

const execFileAsync = promisify(execFile);

export const QA_STATE_RELATIVE_PATH = path.join('.qa-state', 'current.json');
export const QA_ARTIFACTS_RELATIVE_ROOT = '.qa-runs';
export const QA_AUTH_RELATIVE_ROOT = '.qa-auth';
export const QA_BASE_URL = 'http://127.0.0.1:4173';
export const QA_DATABASE_CONTAINER = 'supabase_db_supplyflow-p0';
export const QA_REST_CONTAINER = 'supabase_rest_supplyflow-p0';
export const QA_API_GATEWAY_CONTAINER = 'supabase_kong_supplyflow-p0';
export const QA_RUN_ID_PATTERN = /^qa-\d{14}-[0-9a-f]{8}$/;

export const QA_ACCOUNT_ROLES = [
  'owner',
  'office',
  'kitchen',
  'payer',
  'accountant',
  'supplier',
] as const;

export type QaAccountRole = (typeof QA_ACCOUNT_ROLES)[number];

interface CredentialAccount {
  email: string;
  password: string;
}

interface CredentialManifest {
  accounts: CredentialAccount[];
}

interface LocalSupabaseEnvironment {
  apiUrl: typeof LOCAL_QA_API_URL;
  anonKey: string;
  serviceRoleKey: string;
}

export interface SetupEnvironment {
  target: 'local-isolated';
  projectId: typeof LOCAL_QA_PROJECT_ID;
  supabaseUrl: typeof LOCAL_QA_API_URL;
  baseUrl: string;
  timezone: 'Asia/Jerusalem';
  locale: 'he-IL';
}

export interface QaRunState {
  schemaVersion: 1;
  status: 'SETTING_UP' | 'READY' | 'SETUP_FAILED' | 'CLEANING';
  runId: string;
  repoRoot: string;
  statePath: string;
  artifactRoot: string;
  authRoot: string;
  fixtureRoot: string;
  fixtureManifestPath: string;
  fixtureFiles: Partial<Record<SyntheticFixtureKind, string>>;
  credentialsManifest: string;
  environment: SetupEnvironment;
  browserPublic: { supabaseAnonKey: string } | null;
  authStates: Partial<Record<QaAccountRole, string>>;
  setupSteps: string[];
  createdAt: string;
  updatedAt: string;
  cleanupRequired: boolean;
}

export type ReadyQaRunState = QaRunState & {
  status: 'READY';
  browserPublic: { supabaseAnonKey: string };
};

export function isReadyQaRunState(state: QaRunState): state is ReadyQaRunState {
  return state.status === 'READY' && Boolean(state.browserPublic?.supabaseAnonKey);
}

export interface SetupOptions {
  repoRoot?: string;
  baseUrl?: string;
  runId?: string;
}

interface SetupResultBase {
  runId: string;
  artifactRoot: string;
  environment: SetupEnvironment;
  credentialsManifest: string;
  statePath: string;
}

export type SetupResult =
  | (SetupResultBase & {
      status: 'READY';
      authRoot: string;
      fixtureManifest: GeneratedFixtureManifest;
      cleanupRequired: true;
    })
  | (SetupResultBase & {
      status: 'BLOCKED' | 'FAILED';
      code: string;
      reason: string;
      cleanupRequired: boolean;
    });

class SetupStepError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SetupStepError';
    this.code = code;
  }
}

function createRunId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `qa-${timestamp}-${randomUUID().slice(0, 8)}`;
}

export function validateQaRunId(value: string): string {
  if (!QA_RUN_ID_PATTERN.test(value)) {
    throw new SetupStepError(
      'invalid_run_id',
      'QA runId must match qa-YYYYMMDDHHMMSS-xxxxxxxx and contain no path characters.',
    );
  }
  return value;
}

export function canonicalQaStatePath(repoRoot: string): string {
  return path.join(path.resolve(repoRoot), QA_STATE_RELATIVE_PATH);
}

function ensureLoopbackBaseUrl(value: string): string {
  const parsed = new URL(value);
  const port = Number(parsed.port);
  if (parsed.protocol !== 'http:'
      || parsed.hostname !== '127.0.0.1'
      || !Number.isInteger(port)
      || port < 1
      || port > 65_535
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash) {
    throw new SetupStepError(
      'non_local_base_url',
      'QA base URL must be an HTTP origin on 127.0.0.1 with an explicit port and no path, query, credentials, or fragment.',
    );
  }
  return parsed.origin;
}

function buildEnvironment(baseUrl: string): SetupEnvironment {
  return {
    target: 'local-isolated',
    projectId: LOCAL_QA_PROJECT_ID,
    supabaseUrl: LOCAL_QA_API_URL,
    baseUrl,
    timezone: 'Asia/Jerusalem',
    locale: 'he-IL',
  };
}

function credentialsRuntimeRoot(runId: string): string {
  return path.join(tmpdir(), 'supplyflow-qa', runId);
}

function safeChildEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(clean)) {
    if (/^QA_|^(?:VITE_)?SUPABASE_|^(?:DATABASE_URL|POSTGRES_URL|PGPASSWORD)$/i.test(key)) {
      delete clean[key];
    }
  }
  return { ...clean, ...overrides };
}

async function command(
  executable: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; label: string; timeoutMs?: number },
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(executable, [...args], {
      cwd: options.cwd,
      env: options.env ?? safeChildEnvironment(),
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      timeout: options.timeoutMs ?? 300_000,
    });
    return stdout;
  } catch (error) {
    const exitCode = (error as { code?: unknown }).code;
    const safeExit = typeof exitCode === 'number' || typeof exitCode === 'string' ? String(exitCode) : 'unknown';
    throw new SetupStepError(
      'command_failed',
      `${options.label} failed (exit ${safeExit}); child output is intentionally withheld to protect credentials.`,
    );
  }
}

function parseSupabaseEnvironment(output: string): LocalSupabaseEnvironment {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    values.set(match[1], match[2].replace(/^"|"$/g, ''));
  }
  const apiUrl = values.get('API_URL');
  const anonKey = values.get('ANON_KEY');
  const serviceRoleKey = values.get('SERVICE_ROLE_KEY');
  if (apiUrl !== LOCAL_QA_API_URL) {
    throw new SetupStepError('non_local_supabase_status', 'Supabase CLI did not report the isolated local API URL.');
  }
  if (!anonKey || !serviceRoleKey) {
    throw new SetupStepError('local_supabase_credentials_missing', 'Supabase CLI omitted required local runtime keys.');
  }
  return { apiUrl: LOCAL_QA_API_URL, anonKey, serviceRoleKey };
}

async function getLocalSupabaseEnvironment(
  repoRoot: string,
  lock: QaLockHandle,
): Promise<LocalSupabaseEnvironment> {
  const output = await runGuardedCommand(lock, 'supabase', ['status', '-o', 'env'], {
    cwd: repoRoot,
    label: 'Read isolated Supabase runtime status',
    timeoutMs: 30_000,
  });
  return parseSupabaseEnvironment(output);
}

function passwordFor(role: QaAccountRole): string {
  return `Qa!7-${role}-${randomBytes(18).toString('base64url')}`;
}

async function createCredentialsManifest(runId: string): Promise<string> {
  const runtimeRoot = credentialsRuntimeRoot(runId);
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const manifestPath = path.join(runtimeRoot, 'credentials.json');
  const manifest: CredentialManifest = {
    accounts: QA_ACCOUNT_ROLES.map((role) => ({
      email: `${role}@demo.supplyflow.local`,
      password: passwordFor(role),
    })),
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return manifestPath;
}

function isQaRunState(value: unknown): value is QaRunState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<QaRunState>;
  return state.schemaVersion === 1
    && typeof state.runId === 'string'
    && typeof state.repoRoot === 'string'
    && typeof state.statePath === 'string'
    && typeof state.artifactRoot === 'string'
    && typeof state.authRoot === 'string'
    && typeof state.fixtureRoot === 'string'
    && typeof state.fixtureManifestPath === 'string'
    && typeof state.fixtureFiles === 'object'
    && state.fixtureFiles !== null
    && typeof state.credentialsManifest === 'string'
    && typeof state.environment === 'object'
    && state.environment !== null
    && state.environment.projectId === LOCAL_QA_PROJECT_ID
    && state.environment.supabaseUrl === LOCAL_QA_API_URL
    && (state.browserPublic === null
      || (typeof state.browserPublic === 'object'
        && typeof state.browserPublic.supabaseAnonKey === 'string'
        && state.browserPublic.supabaseAnonKey.length > 0));
}

export async function readQaRunState(statePath: string): Promise<QaRunState> {
  const parsed: unknown = JSON.parse(await readFile(statePath, 'utf8'));
  if (!isQaRunState(parsed)) throw new SetupStepError('invalid_state', 'QA state file is malformed.');
  return parsed;
}

export async function writeQaRunState(state: QaRunState): Promise<void> {
  if (path.resolve(state.statePath) !== canonicalQaStatePath(state.repoRoot)) {
    throw new SetupStepError('invalid_state_path', 'QA statePath must be repo/.qa-state/current.json.');
  }
  const stateDirectory = path.dirname(state.statePath);
  await mkdir(stateDirectory, { recursive: true });
  const temporaryPath = path.join(stateDirectory, `.${state.runId}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, state.statePath);
}

async function stateAlreadyExists(statePath: string): Promise<boolean> {
  try {
    await access(statePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function runGuardedCommand(
  lock: QaLockHandle,
  executable: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; label: string; timeoutMs?: number },
): Promise<string> {
  await assertQaLockOwned(lock);
  await assertNoCompetingQualityProcess();
  return command(executable, args, options);
}

async function resetLocalDatabase(repoRoot: string, lock: QaLockHandle): Promise<void> {
  await runGuardedCommand(lock, 'supabase', ['db', 'reset'], {
    cwd: repoRoot,
    label: 'Reset isolated local Supabase database',
    timeoutMs: 300_000,
  });
  await runGuardedCommand(lock, 'supabase', ['start'], {
    cwd: repoRoot,
    label: 'Reconcile isolated local Supabase services after reset',
    timeoutMs: 300_000,
  });
  await runGuardedCommand(lock, 'docker', ['restart', QA_REST_CONTAINER], {
    cwd: repoRoot,
    label: 'Restart isolated local PostgREST container',
    timeoutMs: 60_000,
  });
  await runGuardedCommand(lock, 'docker', ['restart', QA_API_GATEWAY_CONTAINER], {
    cwd: repoRoot,
    label: 'Refresh isolated local API gateway upstreams',
    timeoutMs: 60_000,
  });
}

async function waitForLocalApi(
  environment: LocalSupabaseEnvironment,
  lock: QaLockHandle,
): Promise<void> {
  await assertQaLockOwned(lock);
  await assertNoCompetingQualityProcess();
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const headers = {
        apikey: environment.serviceRoleKey,
        Authorization: `Bearer ${environment.serviceRoleKey}`,
      };
      const [auth, rest] = await Promise.all([
        fetch(`${LOCAL_QA_API_URL}/auth/v1/health`, { headers, signal: AbortSignal.timeout(2_500) }),
        fetch(`${LOCAL_QA_API_URL}/rest/v1/organizations?select=id&limit=0`, {
          headers,
          signal: AbortSignal.timeout(2_500),
        }),
      ]);
      if (auth.ok && rest.ok) {
        await assertQaLockOwned(lock);
        await assertNoCompetingQualityProcess();
        return;
      }
    } catch {
      // The bounded readiness loop owns retry policy; no credential-bearing response is logged.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }
  throw new SetupStepError('local_api_not_ready', 'The isolated Auth/PostgREST APIs did not become ready.');
}

async function createDemoUsers(
  repoRoot: string,
  manifestPath: string,
  environment: LocalSupabaseEnvironment,
  lock: QaLockHandle,
): Promise<void> {
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  await runGuardedCommand(
    lock,
    shell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(repoRoot, 'scripts', 'create-users.ps1'),
      '-ProjectUrl',
      LOCAL_QA_API_URL,
      '-CredentialsPath',
      manifestPath,
    ],
    {
      cwd: repoRoot,
      env: safeChildEnvironment({ SUPABASE_SERVICE_KEY: environment.serviceRoleKey }),
      label: 'Create canonical local QA Auth users',
      timeoutMs: 120_000,
    },
  );
}

async function copySqlAndRun(
  repoRoot: string,
  relativePath: string,
  containerPath: string,
  label: string,
  lock: QaLockHandle,
): Promise<string> {
  const source = path.join(repoRoot, ...relativePath.split('/'));
  await access(source);
  await runGuardedCommand(lock, 'docker', ['cp', source, `${QA_DATABASE_CONTAINER}:${containerPath}`], {
    cwd: repoRoot,
    label: `Copy ${label} into isolated database container`,
    timeoutMs: 60_000,
  });
  return runGuardedCommand(
    lock,
    'docker',
    [
      'exec',
      '-e',
      'PGPASSWORD=postgres',
      '-e',
      'PGTZ=Asia/Jerusalem',
      QA_DATABASE_CONTAINER,
      'psql',
      '-qAt',
      '-F',
      '|',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      containerPath,
    ],
    { cwd: repoRoot, label, timeoutMs: 120_000 },
  );
}

function assertDemoVerification(output: string): void {
  const integrityRows = output.split(/\r?\n/).filter((line) => /^[BC]\./.test(line));
  const sections = new Set(integrityRows.map((line) => line.slice(0, 1)));
  if (integrityRows.length === 0 || !sections.has('B') || !sections.has('C')) {
    throw new SetupStepError('demo_verify_incomplete', 'Demo verification omitted tenant-integrity sections B or C.');
  }
  const malformed = integrityRows.filter((line) => {
    const rawValue = line.split('|').at(-1)?.trim();
    return !rawValue || !/^\d+$/.test(rawValue);
  });
  if (malformed.length > 0) {
    throw new SetupStepError('demo_verify_malformed', 'Demo verification returned malformed integrity rows.');
  }
  const failures = integrityRows.filter((line) => Number(line.split('|').at(-1)) !== 0);
  if (failures.length > 0) {
    throw new SetupStepError('demo_verify_failed', `Demo verification found ${failures.length} tenant-integrity failures.`);
  }
}

async function seedAndVerifyDemo(repoRoot: string, lock: QaLockHandle): Promise<void> {
  await copySqlAndRun(
    repoRoot,
    'supabase/demo/demo_seed.sql',
    '/var/lib/postgresql/qa-demo-seed.sql',
    'Seed isolated demo fixture',
    lock,
  );
  const verification = await copySqlAndRun(
    repoRoot,
    'supabase/demo/demo_verify.sql',
    '/var/lib/postgresql/qa-demo-verify.sql',
    'Verify isolated demo fixture',
    lock,
  );
  assertDemoVerification(verification);
}

async function buildApplication(
  repoRoot: string,
  environment: LocalSupabaseEnvironment,
  lock: QaLockHandle,
): Promise<void> {
  const npmCli = process.env.npm_execpath;
  if (process.platform === 'win32' && (!npmCli || !path.isAbsolute(npmCli))) {
    throw new SetupStepError('npm_cli_missing', 'The npm CLI path is unavailable for the Windows build child process.');
  }
  const executable = process.platform === 'win32' ? process.execPath : 'npm';
  const args = process.platform === 'win32' ? [npmCli!, 'run', 'build'] : ['run', 'build'];
  await runGuardedCommand(lock, executable, args, {
    cwd: repoRoot,
    env: safeChildEnvironment({
      VITE_SUPABASE_URL: LOCAL_QA_API_URL,
      VITE_SUPABASE_ANON_KEY: environment.anonKey,
    }),
    label: 'Build SupplyFlow against isolated local Supabase',
    timeoutMs: 300_000,
  });
}

interface AuthSetupModule {
  setupRoleAuthentication?: (input: {
    apiUrl: string;
    anonKey: string;
    credentialsPath: string;
    authDirectory: string;
    runId: string;
    baseUrl: string;
  }) => Promise<{ states: Record<string, string> }>;
}

async function waitForPreview(baseUrl: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new SetupStepError('preview_exited', 'The isolated preview process exited before authentication setup.');
    }
    try {
      const response = await fetch(baseUrl, { redirect: 'manual', signal: AbortSignal.timeout(2_000) });
      if (response.status >= 200 && response.status < 500) return;
    } catch {
      // Bounded readiness loop; the preview process remains isolated and output is not published.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  throw new SetupStepError('preview_not_ready', 'The isolated preview server did not become ready within 45 seconds.');
}

async function stopPreview(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new SetupStepError('preview_stop_failed', 'The isolated preview process did not stop cleanly.');
  }
}

async function startPreviewProcess(
  repoRoot: string,
  baseUrl: string,
  anonKey: string,
): Promise<ChildProcess> {
  const url = new URL(baseUrl);
  const viteEntry = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  await access(viteEntry);
  const child = spawn(
    process.execPath,
    [viteEntry, 'preview', '--host', '127.0.0.1', '--port', url.port, '--strictPort'],
    {
      cwd: repoRoot,
      env: safeChildEnvironment({
        VITE_SUPABASE_URL: LOCAL_QA_API_URL,
        VITE_SUPABASE_ANON_KEY: anonKey,
      }),
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', () => reject(new SetupStepError('preview_spawn_failed', 'Unable to start isolated preview.')));
    });
    await waitForPreview(baseUrl, child);
    return child;
  } catch (error) {
    await stopPreview(child).catch(() => undefined);
    throw error;
  }
}

export interface QaPreviewHandle {
  readonly baseUrl: string;
  readonly pid: number | undefined;
  stop(): Promise<void>;
  toJSON(): Record<string, unknown>;
}

export async function startQaPreview(input: {
  repoRoot?: string;
  baseUrl?: string;
  anonKey: string;
}): Promise<QaPreviewHandle> {
  const repoRoot = path.resolve(input.repoRoot ?? process.cwd());
  const baseUrl = ensureLoopbackBaseUrl(input.baseUrl ?? QA_BASE_URL);
  const anonKey = input.anonKey.trim();
  if (!anonKey) throw new SetupStepError('anon_key_missing', 'The browser-public local anon key is required.');
  await assertIsolatedLocalTarget(repoRoot, LOCAL_QA_API_URL);
  await access(path.join(repoRoot, 'dist', 'index.html'));
  const child = await startPreviewProcess(repoRoot, baseUrl, anonKey);
  let stopped = false;
  return {
    baseUrl,
    pid: child.pid,
    async stop(): Promise<void> {
      if (stopped) return;
      await stopPreview(child);
      stopped = true;
    },
    toJSON(): Record<string, unknown> {
      return { baseUrl, pid: child.pid, stopped };
    },
  };
}

async function setupAuthenticationStates(
  repoRoot: string,
  authRoot: string,
  credentialsManifest: string,
  runId: string,
  baseUrl: string,
  environment: LocalSupabaseEnvironment,
  lock: QaLockHandle,
): Promise<Partial<Record<QaAccountRole, string>>> {
  await assertQaLockOwned(lock);
  await assertNoCompetingQualityProcess();
  const modulePath = path.join(repoRoot, 'qa', 'auth', 'auth.setup.ts');
  await access(modulePath);
  const authModule = await import(pathToFileURL(modulePath).href) as AuthSetupModule;
  if (typeof authModule.setupRoleAuthentication !== 'function') {
    throw new SetupStepError('auth_setup_contract_missing', 'qa/auth/auth.setup.ts must export setupRoleAuthentication().');
  }
  const result = await authModule.setupRoleAuthentication({
    apiUrl: LOCAL_QA_API_URL,
    anonKey: environment.anonKey,
    credentialsPath: credentialsManifest,
    authDirectory: authRoot,
    runId,
    baseUrl,
  });
  const states: Partial<Record<QaAccountRole, string>> = {};
  for (const role of QA_ACCOUNT_ROLES) {
    const statePath = result.states[role];
    if (!statePath) throw new SetupStepError('auth_state_missing', `Auth setup omitted the ${role} state path.`);
    const relative = path.relative(authRoot, path.resolve(statePath));
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new SetupStepError('auth_state_outside_root', `Auth state for ${role} is outside the run auth directory.`);
    }
    await access(statePath);
    states[role] = path.resolve(statePath);
  }
  return states;
}

function safeFailure(error: unknown): { code: string; reason: string } {
  if (error instanceof SetupStepError) return { code: error.code, reason: error.message };
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('BLOCKED competing_quality_process')) {
    return { code: 'competing_quality_process', reason: message };
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return {
    code: typeof code === 'string' ? code : 'setup_failed',
    reason: 'QA setup failed; raw error output is withheld to avoid leaking credentials.',
  };
}

export async function setupQaRun(options: SetupOptions = {}): Promise<SetupResult> {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const baseUrl = ensureLoopbackBaseUrl(options.baseUrl ?? QA_BASE_URL);
  const runId = validateQaRunId(options.runId ?? createRunId());
  const environment = buildEnvironment(baseUrl);
  const statePath = canonicalQaStatePath(repoRoot);
  const artifactRoot = path.join(repoRoot, QA_ARTIFACTS_RELATIVE_ROOT, runId);
  const authRoot = path.join(repoRoot, QA_AUTH_RELATIVE_ROOT, runId);
  const fixtureRoot = path.join(artifactRoot, 'fixtures');
  const fixtureManifestPath = path.join(fixtureRoot, FIXTURE_MANIFEST_FILE);
  const credentialsManifest = path.join(credentialsRuntimeRoot(runId), 'credentials.json');
  const baseResult: SetupResultBase = {
    runId,
    artifactRoot,
    environment,
    credentialsManifest,
    statePath,
  };

  try {
    await assertIsolatedLocalTarget(repoRoot, LOCAL_QA_API_URL);
  } catch (error) {
    const failure = safeFailure(error);
    return { ...baseResult, status: 'BLOCKED', ...failure, cleanupRequired: false };
  }

  if (await stateAlreadyExists(statePath)) {
    return {
      ...baseResult,
      status: 'BLOCKED',
      code: 'existing_qa_state',
      reason: `A previous QA state exists at ${statePath}; run verified cleanup first.`,
      cleanupRequired: true,
    };
  }

  try {
    await access(chromium.executablePath());
  } catch {
    return {
      ...baseResult,
      status: 'BLOCKED',
      code: 'browser_missing',
      reason: 'Playwright Chromium is not installed; install the pinned browser before QA setup.',
      cleanupRequired: false,
    };
  }
  try {
    await Promise.all([
      access(path.join(repoRoot, 'scripts', 'create-users.ps1')),
      access(path.join(repoRoot, 'supabase', 'demo', 'demo_seed.sql')),
      access(path.join(repoRoot, 'supabase', 'demo', 'demo_verify.sql')),
      access(path.join(repoRoot, 'qa', 'auth', 'auth.setup.ts')),
      access(path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js')),
    ]);
  } catch {
    return {
      ...baseResult,
      status: 'BLOCKED',
      code: 'setup_prerequisite_missing',
      reason: 'A required local QA script, fixture, auth module, or pinned Vite runtime is missing.',
      cleanupRequired: false,
    };
  }

  let lockResult: Awaited<ReturnType<typeof acquireQaLock>>;
  try {
    lockResult = await acquireQaLock({ repoRoot, runId });
  } catch {
    return {
      ...baseResult,
      status: 'BLOCKED',
      code: 'process_inspection_failed',
      reason: 'QA setup could not prove that the isolated stack is free of competing processes.',
      cleanupRequired: false,
    };
  }
  if (lockResult.status === 'BLOCKED') {
    return {
      ...baseResult,
      status: 'BLOCKED',
      code: lockResult.code,
      reason: lockResult.message,
      cleanupRequired: false,
    };
  }
  const lock = lockResult.handle;
  const createdAt = new Date().toISOString();
  let state: QaRunState | undefined;
  let lockReleased = false;

  try {
    try {
      await getLocalSupabaseEnvironment(repoRoot, lock);
    } catch {
      throw new SetupStepError(
        'local_stack_unavailable',
        'The isolated local Supabase stack or CLI status is unavailable; setup did not mutate the database.',
      );
    }
    await mkdir(artifactRoot, { recursive: true });
    await mkdir(authRoot, { recursive: true, mode: 0o700 });
    state = {
      schemaVersion: 1,
      status: 'SETTING_UP',
      runId,
      repoRoot,
      statePath,
      artifactRoot,
      authRoot,
      fixtureRoot,
      fixtureManifestPath,
      fixtureFiles: {},
      credentialsManifest,
      environment,
      browserPublic: null,
      authStates: {},
      setupSteps: [],
      createdAt,
      updatedAt: createdAt,
      cleanupRequired: true,
    };
    await writeQaRunState(state);

    const createdManifest = await createCredentialsManifest(runId);
    if (path.resolve(createdManifest) !== path.resolve(credentialsManifest)) {
      throw new SetupStepError('manifest_path_mismatch', 'Credential manifest was created at an unexpected path.');
    }

    await resetLocalDatabase(repoRoot, lock);
    state.setupSteps.push('database_reset');
    state.updatedAt = new Date().toISOString();
    await writeQaRunState(state);

    const localEnvironment = await getLocalSupabaseEnvironment(repoRoot, lock);
    await waitForLocalApi(localEnvironment, lock);
    state.browserPublic = { supabaseAnonKey: localEnvironment.anonKey };
    state.setupSteps.push('local_api_ready');
    state.updatedAt = new Date().toISOString();
    await writeQaRunState(state);

    await createDemoUsers(repoRoot, credentialsManifest, localEnvironment, lock);
    state.setupSteps.push('canonical_auth_users_created');

    await seedAndVerifyDemo(repoRoot, lock);
    state.setupSteps.push('demo_seed_verified');

    await installCrossTenantInvoiceContextFixture({
      apiUrl: localEnvironment.apiUrl,
      serviceRoleKey: localEnvironment.serviceRoleKey,
    });
    state.setupSteps.push('cross_tenant_invoice_context_fixture_ready');

    const fixtureManifest = await stateAlreadyExists(fixtureManifestPath)
      ? await loadGeneratedFixtureManifest(fixtureRoot)
      : await generateSyntheticFixtureFiles({ runId, directory: fixtureRoot });
    if (fixtureManifest.runId !== runId) {
      throw new SetupStepError('fixture_run_mismatch', 'Synthetic fixtures belong to a different QA run.');
    }
    state.fixtureFiles = Object.fromEntries(
      fixtureManifest.files.map((file) => [file.kind, file.path]),
    ) as Partial<Record<SyntheticFixtureKind, string>>;
    state.setupSteps.push('synthetic_files_verified');
    state.updatedAt = new Date().toISOString();
    await writeQaRunState(state);

    await buildApplication(repoRoot, localEnvironment, lock);
    state.setupSteps.push('application_built');

    const preview = await startQaPreview({ repoRoot, baseUrl, anonKey: localEnvironment.anonKey });
    try {
      state.authStates = await setupAuthenticationStates(
        repoRoot,
        authRoot,
        credentialsManifest,
        runId,
        baseUrl,
        localEnvironment,
        lock,
      );
    } finally {
      await preview.stop();
    }
    state.setupSteps.push('role_authentication_states_created');
    state.status = 'READY';
    state.updatedAt = new Date().toISOString();
    await writeQaRunState(state);
    lockReleased = await releaseQaLock(lock);
    if (!lockReleased) {
      throw new SetupStepError('qa_mutex_release_failed', 'QA setup could not verify mutex release.');
    }

    return {
      ...baseResult,
      status: 'READY',
      authRoot,
      fixtureManifest,
      cleanupRequired: true,
    };
  } catch (error) {
    let failure = safeFailure(error);
    if (!lockReleased) {
      lockReleased = await releaseQaLock(lock).catch(() => false);
      if (!lockReleased) {
        failure = {
          code: 'qa_mutex_release_failed',
          reason: 'QA setup could not verify mutex release.',
        };
      }
    }
    if (state) {
      state.status = 'SETUP_FAILED';
      state.updatedAt = new Date().toISOString();
      state.cleanupRequired = true;
      try {
        await writeQaRunState(state);
      } catch {
        // Keep the original safe failure. A missing state is surfaced by cleanupRequired below.
      }
    }
    return {
      ...baseResult,
      status: ['competing_quality_process', 'local_stack_unavailable'].includes(failure.code)
        ? 'BLOCKED'
        : 'FAILED',
      ...failure,
      cleanupRequired: Boolean(state),
    };
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMainModule()) {
  const repoArgument = process.argv.find((value) => value.startsWith('--repo-root='))?.slice('--repo-root='.length);
  const baseUrlArgument = process.argv.find((value) => value.startsWith('--base-url='))?.slice('--base-url='.length);
  const runIdArgument = process.argv.find((value) => value.startsWith('--run-id='))?.slice('--run-id='.length);
  const result = await setupQaRun({ repoRoot: repoArgument, baseUrl: baseUrlArgument, runId: runIdArgument });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.status === 'READY' ? 0 : result.status === 'BLOCKED' ? 2 : 1;
}
