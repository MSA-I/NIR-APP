import assert from 'node:assert/strict';
import { test } from 'node:test';

import { answerProgress, filterCatalogItems, summarizeCatalog } from '../public/ui-model.mjs';

const items = [
  { key: 'decision:270', type: 'decision', status: 'needs-owner-decision', requiresOwnerDecision: true, plainQuestion: 'כתובת דואר מוסתרת', section: 'כניסה' },
  { key: 'decision:1', type: 'decision', status: 'decided-history', requiresOwnerDecision: false, plainQuestion: 'שיעור מס', section: 'כספים' },
  { key: 'decision:68', type: 'decision', status: 'implementation-gap', requiresOwnerDecision: false, plainQuestion: 'בדיקת התאמה', section: 'בדיקות' },
  { key: 'debt:66', type: 'debt', status: 'needs-owner-decision', requiresOwnerDecision: true, plainQuestion: 'מחיקת ארגון', section: 'ציות' },
  { key: 'debt:1', type: 'debt', status: 'technical-debt', requiresOwnerDecision: false, plainQuestion: 'ביצועים', section: 'ביצועים' },
];

test('summary separates owner decisions, pending implementation, debt and history', () => {
  assert.deepEqual(summarizeCatalog(items, { answers: {}, reconsiderations: [] }), {
    needsDecision: 2,
    pendingImplementation: 1,
    technicalDebt: 1,
    history: 1,
    reconsiderations: 0,
  });
});
test('filters use status and plain-language search', () => {
  assert.deepEqual(filterCatalogItems(items, { view: 'needs-decision', query: '' }).map((item) => item.key), ['decision:270', 'debt:66']);
  assert.deepEqual(filterCatalogItems(items, { view: 'all', query: 'מחיקת' }).map((item) => item.key), ['debt:66']);
});

test('answer progress treats uncertainty and explanation requests as explicit answers', () => {
  const state = { answers: { 'decision:270': { selection: 'not_sure' } } };
  assert.deepEqual(answerProgress(items, state), { answered: 1, total: 2, complete: false });
  const complete = { answers: { 'decision:270': { selection: 'not_sure' }, 'debt:66': { selection: 'needs_explanation' } } };
  assert.deepEqual(answerProgress(items, complete), { answered: 2, total: 2, complete: true });
});
