import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { resolveResultsDir } from '../src/paths.mjs';

test('results directory resolves to the external NIR-APP-DOCS sibling', async () => {
  const rootDir = path.resolve(import.meta.dirname, '..', '..', '..');
  const resolved = await resolveResultsDir(rootDir, {});
  assert.ok(path.isAbsolute(resolved));
  assert.match(resolved.replaceAll('\\', '/'), /NIR-APP-DOCS\/owner-decisions$/);
  assert.equal(resolved.includes('owner-decisions-console\\NIR-APP-DOCS'), false);
});
test('explicit result override must be absolute', async () => {
  const rootDir = path.resolve(import.meta.dirname, '..', '..', '..');
  await assert.rejects(() => resolveResultsDir(rootDir, { OWNER_DECISIONS_RESULTS_DIR: 'relative/path' }), /results_path_must_be_absolute/);
});
