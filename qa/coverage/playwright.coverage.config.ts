import { defineConfig, devices } from '@playwright/test';
import { join } from 'node:path';
import { storageStatePath } from '../auth/storage-state.ts';
import { createQaConfig } from '../config/qa.config.ts';
import { QA_ROLES } from '../config/roles.ts';

/**
 * A separate Playwright config for the coverage walk.
 *
 * It deliberately does not extend qa/playwright.config.ts. That config is invoked without
 * `--project`, so every project declared in it runs as part of the mandatory deterministic gate —
 * adding the coverage projects there would silently change what that gate means and how long it
 * takes. The two runs share the auth setup and the artifact root and nothing else.
 */

const qa = createQaConfig();

const coverageProjects = QA_ROLES.map((role) => ({
  name: `coverage-${role}`,
  testDir: './specs',
  dependencies: ['auth-setup'],
  use: {
    ...devices['Desktop Chrome'],
    storageState: storageStatePath(qa.authStateRoot, role),
  },
}));

export default defineConfig({
  testDir: '.',
  outputDir: join(qa.artifactRoot, 'coverage-playwright'),
  preserveOutput: 'always',
  // Roles run one after another: they share one local Supabase project, and a parallel walk would
  // make "this row was not visible to kitchen" indistinguishable from "office was mid-mutation".
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  // A retry would write a second set of coverage records for the same route and double-count it.
  retries: 0,
  timeout: 180_000,
  expect: { timeout: qa.actionTimeoutMs },
  reporter: [['line'], ['json', { outputFile: join(qa.artifactRoot, 'coverage-playwright-results.json') }]],
  use: {
    baseURL: qa.baseUrl,
    locale: 'he-IL',
    timezoneId: 'Asia/Jerusalem',
    colorScheme: 'light',
    serviceWorkers: 'block',
    actionTimeout: qa.actionTimeoutMs,
    navigationTimeout: qa.navigationTimeoutMs,
    screenshot: 'off',
    video: 'off',
    trace: { mode: 'on', screenshots: false, snapshots: false, sources: false, attachments: false },
  },
  projects: [
    {
      name: 'auth-setup',
      testDir: '../auth',
      testMatch: 'auth.setup.spec.ts',
      use: { storageState: undefined, trace: 'off', video: 'off', screenshot: 'off' },
    },
    ...coverageProjects,
  ],
});
