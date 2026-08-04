import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  LOCAL_QA_API_URL,
  LOCAL_QA_PROJECT_ID,
  assertIsolatedLocalTarget,
  detectCompetingQualityProcesses,
} from '../runner/lock.ts';

const execFileAsync = promisify(execFile);

export interface AcquireVerificationRuntimeOptions {
  repoRoot?: string;
  apiUrl?: string;
}

export interface LocalVerificationRuntime {
  readonly target: 'local-isolated';
  readonly projectId: typeof LOCAL_QA_PROJECT_ID;
  readonly apiUrl: typeof LOCAL_QA_API_URL;
  readonly repoRoot: string;
  createServiceClient(): SupabaseClient;
  dispose(): void;
  toJSON(): Record<string, unknown>;
}

function cleanChildEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(result)) {
    if (/^QA_|^(?:VITE_)?SUPABASE_|^(?:DATABASE_URL|POSTGRES_URL|PGPASSWORD)$/i.test(key)) delete result[key];
  }
  return result;
}

function parseStatus(output: string): { apiUrl: string; serviceRoleKey: string } {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) values.set(match[1], match[2].replace(/^"|"$/g, ''));
  }
  const apiUrl = values.get('API_URL');
  const serviceRoleKey = values.get('SERVICE_ROLE_KEY');
  if (apiUrl !== LOCAL_QA_API_URL) throw new Error('Verification runtime refused a non-isolated Supabase URL.');
  if (!serviceRoleKey) throw new Error('Local service-role credential is unavailable.');
  return { apiUrl, serviceRoleKey };
}

export async function acquireLocalVerificationRuntime(
  options: AcquireVerificationRuntimeOptions = {},
): Promise<LocalVerificationRuntime> {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  await assertIsolatedLocalTarget(repoRoot, options.apiUrl ?? LOCAL_QA_API_URL);
  let competing;
  try {
    competing = await detectCompetingQualityProcesses();
  } catch {
    throw new Error('Unable to prove local verification process stability.');
  }
  if (competing.length > 0) {
    throw new Error('Local verification is BLOCKED by a competing quality/reset process.');
  }

  let stdout: string;
  try {
    const result = await execFileAsync('supabase', ['status', '-o', 'env'], {
      cwd: repoRoot,
      env: cleanChildEnvironment(),
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
    });
    stdout = result.stdout;
  } catch {
    throw new Error('Unable to acquire the isolated local verification runtime; CLI output was withheld.');
  }

  const parsed = parseStatus(stdout);
  let serviceRoleKey: string | undefined = parsed.serviceRoleKey;

  return Object.freeze({
    target: 'local-isolated' as const,
    projectId: LOCAL_QA_PROJECT_ID,
    apiUrl: LOCAL_QA_API_URL,
    repoRoot,
    createServiceClient(): SupabaseClient {
      if (!serviceRoleKey) throw new Error('Verification runtime was disposed.');
      return createClient(LOCAL_QA_API_URL, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { headers: { 'X-Client-Info': 'supplyflow-qa-select-verifier' } },
      });
    },
    dispose(): void {
      serviceRoleKey = undefined;
    },
    toJSON(): Record<string, unknown> {
      return {
        target: 'local-isolated',
        projectId: LOCAL_QA_PROJECT_ID,
        apiUrl: LOCAL_QA_API_URL,
        repoRoot,
        credentials: 'runtime-only',
      };
    },
  });
}
