import { test, expect } from '@playwright/test';
import { createQaConfig } from '../config/qa.config.ts';
import { QA_ROLES } from '../config/roles.ts';
import { setupRoleAuthentication } from './auth.setup.ts';

const qa = createQaConfig();

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

test('authenticate all canonical roles through the UI and verify their REST profiles', async () => {
  const result = await setupRoleAuthentication({
    apiUrl: qa.supabaseUrl,
    anonKey: qa.supabaseAnonKey,
    credentialsPath: qa.credentialsManifest,
    authDirectory: qa.authStateRoot,
    runId: process.env.QA_RUN_ID?.trim() || 'playwright-auth-setup',
    baseUrl: qa.baseUrl,
  });
  expect(Object.keys(result.states).sort()).toEqual([...QA_ROLES].sort());
  expect(Object.keys(result.userIds).sort()).toEqual([...QA_ROLES].sort());
  for (const userId of Object.values(result.userIds)) {
    expect(userId).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
  }
});
