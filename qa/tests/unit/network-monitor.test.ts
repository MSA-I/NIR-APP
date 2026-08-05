import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page, Request, Response } from '@playwright/test';
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

test('repeat detection blocks bursts but allows a ten-second polling interval', () => {
  const originalNow = Date.now;
  let now = 0;
  Date.now = () => now;
  try {
    const createMonitor = () => {
      const handlers = new Map<string, (value: unknown) => void>();
      const page = {
        on: (event: string, handler: (value: unknown) => void) => { handlers.set(event, handler); },
        off: () => undefined,
      } as unknown as Page;
      return { monitor: new NetworkMonitor(page), handlers };
    };
    const request = {
      method: () => 'GET',
      resourceType: () => 'fetch',
    } as unknown as Request;
    const response = {
      request: () => request,
      url: () => 'http://127.0.0.1/rest/v1/document_processing_jobs',
      status: () => 200,
    } as unknown as Response;

    const polling = createMonitor();
    for (let index = 0; index < 57; index += 1) {
      now += 10_000;
      polling.handlers.get('response')?.(response);
    }
    assert.deepEqual(polling.monitor.blockingIssues(), []);

    const burst = createMonitor();
    for (let index = 0; index < 21; index += 1) {
      now += 100;
      burst.handlers.get('response')?.(response);
    }
    assert.deepEqual(
      burst.monitor.blockingIssues(),
      ['GET http://127.0.0.1/rest/v1/document_processing_jobs: repeated 21 times'],
    );

    for (let index = 0; index < 36; index += 1) {
      now += 10_000;
      burst.handlers.get('response')?.(response);
    }
    assert.deepEqual(
      burst.monitor.blockingIssues(),
      ['GET http://127.0.0.1/rest/v1/document_processing_jobs: repeated 57 times'],
    );
  } finally {
    Date.now = originalNow;
  }
});
