import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from '@playwright/test';
import { createSafeBrowserTools, matchesAllowedRoute } from './browser-tools.ts';

test('safe route templates match one concrete segment without widening the allowlist', () => {
  assert.equal(matchesAllowedRoute('/receiving/order-1', '/receiving/:orderId'), true);
  assert.equal(matchesAllowedRoute('/receiving', '/receiving/:orderId'), false);
  assert.equal(matchesAllowedRoute('/receiving/order-1/items', '/receiving/:orderId'), false);
  assert.equal(matchesAllowedRoute('/receiving/%2Fadmin', '/receiving/:orderId'), false);
  assert.equal(matchesAllowedRoute('/receiving/%5Cadmin', '/receiving/:orderId'), false);
});

test('exact and explicitly broad wildcard routes retain their narrow semantics', () => {
  assert.equal(matchesAllowedRoute('/dashboard', '/dashboard'), true);
  assert.equal(matchesAllowedRoute('/dashboard/other', '/dashboard'), false);
  assert.equal(matchesAllowedRoute('/documents/item/review', '/documents/*'), true);
  assert.equal(matchesAllowedRoute('/document/item/review', '/documents/*'), false);
});

function pageAt(url: string): Page {
  return {
    url: () => url,
    on: () => undefined,
  } as unknown as Page;
}

test('current URL inspection refuses indirect navigation outside the scenario origin or routes', async () => {
  const options = {
    baseUrl: 'http://127.0.0.1:4173',
    allowedRoutes: ['/dashboard', '/documents/:documentId/review'],
    fixtures: {},
    screenshotDirectory: 'unused',
  } as const;
  const allowed = createSafeBrowserTools({ ...options, page: pageAt('http://127.0.0.1:4173/dashboard?token=hidden') });
  assert.equal(await allowed.currentUrl(), '/dashboard');

  const wrongRoute = createSafeBrowserTools({ ...options, page: pageAt('http://127.0.0.1:4173/settings') });
  await assert.rejects(() => wrongRoute.currentUrl(), /escaped the scenario route allowlist/);

  const wrongOrigin = createSafeBrowserTools({ ...options, page: pageAt('https://example.test/dashboard') });
  await assert.rejects(() => wrongOrigin.currentUrl(), /escaped the scenario route allowlist/);
});
