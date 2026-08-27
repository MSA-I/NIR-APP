import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { buildCatalog } from '../src/catalog.mjs';
import { createOwnerDecisionServer } from '../src/server.mjs';

const rootDir = path.resolve(import.meta.dirname, '..', '..', '..');

async function post(url, pathname, body) {
  return fetch(new URL(pathname, url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: url.replace(/\/$/, '') },
    body: JSON.stringify(body),
  });
}

test('server autosaves an answer and restores it through the state endpoint', async (t) => {
  const resultsDir = await mkdtemp(path.join(tmpdir(), 'owner-decisions-server-'));
  const server = createOwnerDecisionServer({ rootDir, resultsDir, port: 0, sourceCommit: 'server-test' });
  const { url } = await server.start();
  t.after(() => server.close());

  const health = await (await fetch(new URL('/api/health', url))).json();
  assert.match(health.instanceId, /^[a-f0-9]{24}$/);
  assert.equal(health.sourceCommit, 'server-test');
  assert.ok(health.sourceFiles.decisions);
  const catalog = await (await fetch(new URL('/api/catalog', url))).json();
  const state = await (await fetch(new URL('/api/state', url))).json();
  const item = catalog.items.find((candidate) => candidate.key === 'decision:270');
  const response = await post(url, '/api/answer', {
    key: item.key,
    sourceHash: item.sourceHash,
    selection: item.options[0].id,
    note: 'נשמר אוטומטית',
    expectedRevision: state.revision,
  });

  assert.equal(response.status, 200);
  const updated = await response.json();
  assert.equal(updated.revision, 1);
  assert.equal(updated.answers['decision:270'].selection, item.options[0].id);
  const onDisk = JSON.parse(await readFile(path.join(resultsDir, 'current.json'), 'utf8'));
  assert.equal(onDisk.revision, 1);
  const restored = await (await fetch(new URL('/api/state', url))).json();
  assert.deepEqual(restored, updated);
});
test('server blocks historical overwrite, remote host headers and stale catalog writes', async (t) => {
  const resultsDir = await mkdtemp(path.join(tmpdir(), 'owner-decisions-security-'));
  let catalog = await buildCatalog({ rootDir, sourceCommit: 'server-test' });
  const server = createOwnerDecisionServer({
    rootDir,
    resultsDir,
    port: 0,
    sourceCommit: 'server-test',
    catalogProvider: async () => catalog,
  });
  const { url, port } = await server.start();
  t.after(() => server.close());

  const historical = catalog.items.find((item) => item.key === 'decision:1');
  const overwrite = await post(url, '/api/answer', {
    key: historical.key,
    sourceHash: historical.sourceHash,
    selection: 'replacement',
    expectedRevision: 0,
  });
  assert.equal(overwrite.status, 409);
  assert.equal((await overwrite.json()).error, 'reconsideration_required');

  const remoteStatus = await new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: '/api/health', headers: { host: 'evil.example' } }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(remoteStatus, 403);

  const openItem = catalog.items.find((item) => item.key === 'decision:270');
  catalog = {
    ...catalog,
    sourceFiles: { ...catalog.sourceFiles, decisions: 'changed' },
    items: catalog.items.map((item) => item.key === openItem.key ? { ...item, sourceHash: 'f'.repeat(64) } : item),
  };
  const stale = await post(url, '/api/answer', {
    key: openItem.key,
    sourceHash: openItem.sourceHash,
    selection: openItem.options[0].id,
    expectedRevision: 0,
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, 'source_changed');
});
