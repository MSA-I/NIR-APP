import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from '@playwright/test';
import { NetworkMonitor, matchesExpectedNetworkDenial } from '../../browser/network-monitor.ts';

test('expected authorization denials require exact method, path, and status', () => {
  const expected = [{ method: 'POST', pathname: '/rest/v1/rpc/protected', status: 403 as const }];
  assert.equal(matchesExpectedNetworkDenial('POST', 'http://127.0.0.1/rest/v1/rpc/protected', 403, expected), true);
  assert.equal(matchesExpectedNetworkDenial('GET', 'http://127.0.0.1/rest/v1/rpc/protected', 403, expected), false);
  assert.equal(matchesExpectedNetworkDenial('POST', 'http://127.0.0.1/rest/v1/rpc/protected', 500, expected), false);
});

test('an expected denial that was never attempted blocks browser evidence', () => {
  const page = { on() {}, off() {} } as unknown as Page;
  const monitor = new NetworkMonitor(page);
  monitor.expectDenial({ method: 'POST', pathname: '/rest/v1/rpc/protected', status: 403 });
  assert.deepEqual(
    monitor.blockingIssues(),
    ['POST /rest/v1/rpc/protected: expected HTTP 403 denial was not observed'],
  );
});
