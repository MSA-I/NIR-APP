import assert from 'node:assert/strict';
import path from 'node:path';

import { buildCatalog } from '../src/catalog.mjs';

const rootDir = path.resolve(import.meta.dirname, '..', '..', '..');
const catalog = await buildCatalog({ rootDir, sourceCommit: 'catalog-verification' });

assert.deepEqual(catalog.counts, { decisions: 264, debts: 51 });
assert.equal(catalog.items.length, 315);
assert.equal(new Set(catalog.items.map((item) => item.key)).size, 315);
assert.equal(catalog.items.filter((item) => item.requiresOwnerDecision).length, 4);

for (const item of catalog.items) {
  assert.ok(item.plainQuestion.length >= 4, `${item.key}: plain question missing`);
  assert.ok(item.plainContext.length >= 30, `${item.key}: plain context too short`);
  assert.ok(item.whyItMatters.length >= 30, `${item.key}: why-it-matters too short`);
  assert.ok(item.whatItDoesNotDo.length >= 30, `${item.key}: boundary too short`);
  assert.equal(Object.keys(item.impactAreas).length, 5, `${item.key}: impact areas incomplete`);
  assert.doesNotMatch(`${item.plainQuestion} ${item.plainContext} ${item.whyItMatters}`, /`/u, `${item.key}: raw code marker in primary copy`);
  if (item.requiresOwnerDecision) {
    assert.ok(item.options.length >= 3, `${item.key}: owner options missing`);
    assert.ok(item.recommendation, `${item.key}: recommendation missing`);
  }
}

console.log('owner-decisions catalog verified');
