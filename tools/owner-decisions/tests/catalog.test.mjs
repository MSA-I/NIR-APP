import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCatalog } from '../src/catalog.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, '..', '..', '..');

test('catalog covers the exact current decision and debt registries', async () => {
  const catalog = await buildCatalog({ rootDir, sourceCommit: 'test-sha' });

  assert.equal(catalog.counts.decisions, 264);
  assert.equal(catalog.counts.debts, 51);
  assert.equal(catalog.items.length, 315);
  assert.equal(new Set(catalog.items.map((item) => item.key)).size, 315);
  assert.equal(catalog.sourceCommit, 'test-sha');
  assert.ok(catalog.items.some((item) => item.key === 'decision:270'));
  assert.ok(catalog.items.some((item) => item.key === 'debt:16-24'));
});

test('every catalog item has a complete plain-language layer', async () => {
  const catalog = await buildCatalog({ rootDir, sourceCommit: 'test-sha' });
  const unexplainedJargon = /accountant|expected_date|\/expenses|\/inbox|\bpush\b|rollout|increase_qty|metadata|ledger|pipeline|checksum|worker|bbox|offline|unit_id|step-up|feature flags|security_events|outbox|idempotency|\baudit\b|precache|snapshot|runtime|merchant of record|\bMoR\b|payouts|self-referral|referrer|referral|reply-to|\baccepted\b|\bbounced\b|HEIC|full-frame|\bscope\b|Drift|Shadow|modality|domain events|re-assert|InitPlan|pg_trgm|invoice_has_duplicate|count:\s*'exact'|FileStore|heuristic|\blease\b|bootstrap|assessment|source_partial|corners_source|zz_organization|PriceSparkline|Rules Engine|Report Jobs|Workflow Engine|management_dashboard_snapshot|quickCreateProduct|\bPR\b|\bmain\b|\bsent\b/iu;

  for (const item of catalog.items) {
    assert.match(item.plainQuestion, /\S/, `${item.key}: missing plain question`);
    assert.match(item.plainContext, /\S/, `${item.key}: missing plain context`);
    assert.match(item.whyItMatters, /\S/, `${item.key}: missing consequence explanation`);
    assert.match(item.whatItDoesNotDo, /\S/, `${item.key}: missing boundary explanation`);
    assert.ok(item.currentDecisionPlain.length <= 240, `${item.key}: current decision is too long`);
    assert.ok(item.implications.length >= 2, `${item.key}: too few implications`);
    assert.match(item.sourceHash, /^[a-f0-9]{64}$/);
    assert.ok(Number.isInteger(item.sourceLine) && item.sourceLine > 0);
    assert.doesNotMatch(item.plainQuestion, unexplainedJargon, `${item.key}: unexplained jargon in question`);
  }
});

test('only current owner questions are answerable and historical decisions request reconsideration', async () => {
  const catalog = await buildCatalog({ rootDir, sourceCommit: 'test-sha' });
  const appleRelay = catalog.items.find((item) => item.key === 'decision:270');
  const historical = catalog.items.find((item) => item.key === 'decision:1');
  const technicalDebt = catalog.items.find((item) => item.key === 'debt:1');

  assert.equal(appleRelay.requiresOwnerDecision, true);
  assert.equal(appleRelay.status, 'needs-owner-decision');
  assert.equal(appleRelay.currentDecisionPlain, 'טרם התקבלה החלטה.');
  assert.ok(appleRelay.options.length >= 3);
  assert.ok(appleRelay.options.every((option) => option.implication.length > 20));

  assert.equal(historical.requiresOwnerDecision, false);
  assert.equal(historical.changeMode, 'reconsideration-only');
  assert.equal(technicalDebt.requiresOwnerDecision, false);
});
