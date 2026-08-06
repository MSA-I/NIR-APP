import path from 'node:path';
import { assertIsolatedLocalTarget } from './lock.ts';
import {
  QA_ARTIFACTS_RELATIVE_ROOT,
  QA_AUTH_RELATIVE_ROOT,
  QA_STATE_RELATIVE_PATH,
  isReadyQaRunState,
  readQaRunState,
  type QaRunState,
  type ReadyQaRunState,
} from './setup.ts';

function assertManagedPath(target: string, root: string, runId: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
      || path.basename(path.resolve(target)) !== runId) {
    throw new Error('QA state contains an unmanaged runtime path.');
  }
}

export async function loadReadyQaState(repoRoot = process.cwd()): Promise<ReadyQaRunState> {
  const repository = path.resolve(repoRoot);
  await assertIsolatedLocalTarget(repository);
  const state = await readQaRunState(path.join(repository, QA_STATE_RELATIVE_PATH));
  if (!isReadyQaRunState(state)) throw new Error('QA state is not READY; rerun setup or cleanup.');
  if (path.resolve(state.repoRoot) !== repository) throw new Error('QA state belongs to another repository.');
  if (!state.browserPublic?.supabaseAnonKey) throw new Error('QA state omits the browser-public local anon key.');
  assertManagedPath(state.artifactRoot, path.join(repository, QA_ARTIFACTS_RELATIVE_ROOT), state.runId);
  assertManagedPath(state.authRoot, path.join(repository, QA_AUTH_RELATIVE_ROOT), state.runId);
  return state;
}

export function deterministicChildEnvironment(state: QaRunState): NodeJS.ProcessEnv {
  const anonKey = state.browserPublic?.supabaseAnonKey;
  if (!anonKey) throw new Error('QA state omits the browser-public local anon key.');
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (/^(?:VITE_)?SUPABASE_|^QA_MODEL_|^QA_AGENT_ENABLED$/i.test(key)) delete environment[key];
  }
  return {
    ...environment,
    QA_RUN_ID: state.runId,
    QA_BASE_URL: state.environment.baseUrl,
    QA_SUPABASE_URL: state.environment.supabaseUrl,
    QA_SUPABASE_PROJECT_ID: state.environment.projectId,
    QA_SUPABASE_ANON_KEY: anonKey,
    QA_CREDENTIALS_MANIFEST: state.credentialsManifest,
    QA_ARTIFACT_ROOT: state.artifactRoot,
    QA_AUTH_STATE_ROOT: state.authRoot,
    QA_AGENT_ENABLED: 'false',
  };
}
