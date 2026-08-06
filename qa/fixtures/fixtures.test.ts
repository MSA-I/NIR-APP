import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createSyntheticQaData,
  generateSyntheticFixtureFiles,
  loadGeneratedFixtureManifest,
} from './index.ts';

test('synthetic fixture generator writes and reloads four run-scoped files', async () => {
  const managedRoot = path.join(tmpdir(), 'supplyflow-qa-generator-tests');
  await mkdir(managedRoot, { recursive: true });
  const directory = await mkdtemp(path.join(managedRoot, 'run-'));
  const runId = 'qa-fixture-self-check-001';
  try {
    const generated = await generateSyntheticFixtureFiles({ runId, directory });
    const loaded = await loadGeneratedFixtureManifest(directory);
    assert.equal(generated.files.length, 4);
    assert.equal(loaded.runId, runId);
    assert.deepEqual(
      new Set(loaded.files.map(({ kind }) => kind)),
      new Set(['bank-csv', 'price-list-xlsx', 'invoice-pdf', 'receipt-jpg']),
    );
    assert.ok(loaded.files.every(({ path: filePath }) => path.basename(filePath).includes(runId)));
  } finally {
    const relative = path.relative(managedRoot, directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(directory, { recursive: true, force: true });
  }
});

test('synthetic data contains no real email domain and uses deterministic demo product ids', () => {
  const first = createSyntheticQaData('qa-data-self-check-001');
  const second = createSyntheticQaData('qa-data-self-check-001');
  assert.deepEqual(first, second);
  assert.match(first.supplier.email, /@example\.invalid$/);
  assert.equal(first.products.length, 3);
  assert.ok(first.products.every(({ id }) => /^bb0{6}/.test(id)));
});
