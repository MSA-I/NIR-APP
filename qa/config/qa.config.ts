import { join } from 'node:path';
import { assertQaEnvironment, qaRepositoryRoot, type QaEnvironmentSource } from './environments.ts';

export interface QaRuntimeConfig {
  readonly repoRoot: string;
  readonly baseUrl: string;
  readonly supabaseUrl: string;
  readonly supabaseAnonKey: string;
  readonly projectId: 'supplyflow-p0';
  readonly credentialsManifest: string;
  readonly artifactRoot: string;
  readonly authStateRoot: string;
  readonly playwrightOutput: string;
  readonly actionTimeoutMs: number;
  readonly navigationTimeoutMs: number;
  readonly blockingAxeImpacts: readonly ['serious', 'critical'];
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

export function createQaConfig(
  source: QaEnvironmentSource = process.env,
  repoRoot = qaRepositoryRoot(),
): QaRuntimeConfig {
  const environment = assertQaEnvironment(source, repoRoot);
  return {
    repoRoot,
    ...environment,
    playwrightOutput: join(environment.artifactRoot, 'playwright'),
    actionTimeoutMs: positiveInteger(source.QA_ACTION_TIMEOUT_MS, 10_000, 'QA_ACTION_TIMEOUT_MS'),
    navigationTimeoutMs: positiveInteger(source.QA_NAVIGATION_TIMEOUT_MS, 25_000, 'QA_NAVIGATION_TIMEOUT_MS'),
    blockingAxeImpacts: ['serious', 'critical'],
  };
}
