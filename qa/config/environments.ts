import { readFileSync } from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const QA_PROJECT_ID = 'supplyflow-p0';
export const QA_SUPABASE_URL = 'http://127.0.0.1:55431';

export interface QaEnvironment {
  readonly baseUrl: string;
  readonly supabaseUrl: typeof QA_SUPABASE_URL;
  readonly supabaseAnonKey: string;
  readonly projectId: typeof QA_PROJECT_ID;
  readonly credentialsManifest: string;
  readonly artifactRoot: string;
  readonly authStateRoot: string;
}

export type QaEnvironmentSource = Readonly<Record<string, string | undefined>>;

export function qaRepositoryRoot(): string {
  return fileURLToPath(new URL('../..', import.meta.url));
}

function requireValue(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required for local QA.`);
  return normalized;
}

function assertLocalAppUrl(value: string): string {
  const url = new URL(value);
  const port = Number(url.port);
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (url.protocol !== 'http:' || !loopbackHosts.has(url.hostname) || !Number.isInteger(port) || port < 1
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('QA_BASE_URL must be an HTTP loopback origin with an explicit port.');
  }
  return url.origin;
}

function assertIsolatedSupabaseUrl(value: string): typeof QA_SUPABASE_URL {
  const url = new URL(value);
  if (url.origin !== QA_SUPABASE_URL || url.pathname !== '/' || url.search || url.hash
      || url.username || url.password) {
    throw new Error(`Refusing QA Supabase target other than ${QA_SUPABASE_URL}.`);
  }
  return QA_SUPABASE_URL;
}

function configuredProjectId(repoRoot: string): string {
  const configPath = join(repoRoot, 'supabase', 'config.toml');
  const config = readFileSync(configPath, 'utf8');
  const match = /^project_id\s*=\s*"([^"]+)"\s*$/m.exec(config);
  if (!match) throw new Error('supabase/config.toml does not declare project_id.');
  return match[1];
}

function assertArtifactRoot(repoRoot: string, value: string | undefined): string {
  const repository = resolve(repoRoot);
  const artifactRoot = resolve(repository, value?.trim() || '.qa-runs/manual');
  if (artifactRoot === repository || artifactRoot === parse(artifactRoot).root) {
    throw new Error('QA_ARTIFACT_ROOT must be a dedicated directory, not the repository or filesystem root.');
  }
  return artifactRoot;
}

export function assertQaEnvironment(
  source: QaEnvironmentSource = process.env,
  repoRoot = qaRepositoryRoot(),
): QaEnvironment {
  const projectId = source.QA_SUPABASE_PROJECT_ID?.trim() || QA_PROJECT_ID;
  if (projectId !== QA_PROJECT_ID || configuredProjectId(repoRoot) !== QA_PROJECT_ID) {
    throw new Error(`Refusing QA project other than ${QA_PROJECT_ID}.`);
  }

  const credentialsManifest = requireValue(source.QA_CREDENTIALS_MANIFEST, 'QA_CREDENTIALS_MANIFEST');
  if (!isAbsolute(credentialsManifest)) {
    throw new Error('QA_CREDENTIALS_MANIFEST must be an absolute path outside the repository.');
  }

  return {
    baseUrl: assertLocalAppUrl(source.QA_BASE_URL?.trim() || 'http://127.0.0.1:4173'),
    supabaseUrl: assertIsolatedSupabaseUrl(source.QA_SUPABASE_URL?.trim() || QA_SUPABASE_URL),
    supabaseAnonKey: requireValue(source.QA_SUPABASE_ANON_KEY, 'QA_SUPABASE_ANON_KEY'),
    projectId: QA_PROJECT_ID,
    credentialsManifest,
    artifactRoot: assertArtifactRoot(repoRoot, source.QA_ARTIFACT_ROOT),
    authStateRoot: resolve(repoRoot, source.QA_AUTH_STATE_ROOT?.trim() || '.qa-auth'),
  };
}
