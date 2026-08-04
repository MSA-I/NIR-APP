import { defineConfig, devices } from '@playwright/test';
import { join } from 'node:path';
import { storageStatePath } from './auth/storage-state.ts';
import { createQaConfig } from './config/qa.config.ts';
import { QA_ROLES } from './config/roles.ts';

const qa = createQaConfig();

const roleProjects = QA_ROLES.map((role) => ({
  name: `role-${role}`,
  testDir: './deterministic',
  testIgnore: 'critical-workflows.spec.ts',
  dependencies: ['auth-setup'],
  use: {
    ...devices['Desktop Chrome'],
    storageState: storageStatePath(qa.authStateRoot, role),
  },
}));

export default defineConfig({
  testDir: '.',
  outputDir: qa.playwrightOutput,
  preserveOutput: 'always',
  fullyParallel: false,
  forbidOnly: true,
  retries: 1,
  timeout: 45_000,
  expect: { timeout: qa.actionTimeoutMs },
  reporter: [
    ['line'],
    ['json', { outputFile: join(qa.artifactRoot, 'playwright-results.json') }],
  ],
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
    // Authentication traces remain disabled below. Role traces are retained only for a
    // failing attempt, without embedded screenshots or source files, and MUST be passed
    // through qa/reporting/scrub-traces.ts before publication; the runner removes the raw zip.
    trace: {
      mode: 'on-first-retry',
      screenshots: false,
      snapshots: false,
      sources: false,
      attachments: false,
    },
  },
  projects: [
    {
      name: 'auth-setup',
      testDir: './auth',
      testMatch: 'auth.setup.spec.ts',
      use: { storageState: undefined, trace: 'off', video: 'off', screenshot: 'off' },
    },
    ...roleProjects,
    {
      name: 'critical-workflows',
      testDir: './deterministic',
      testMatch: 'critical-workflows.spec.ts',
      dependencies: roleProjects.map(({ name }) => name),
      retries: 0,
      timeout: 120_000,
      use: {
        ...devices['Desktop Chrome'],
        storageState: undefined,
      },
    },
  ],
});
