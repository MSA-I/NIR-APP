import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  createInitialState,
  loadState,
  recordAnswer,
  recordReconsideration,
  reconcileSavedState,
  saveStateAtomic,
} from '../src/state.mjs';

const catalog = {
  sourceCommit: 'source-sha',
  sourceFiles: { decisions: 'decisions-hash', debts: 'debts-hash' },
  items: [
    {
      key: 'decision:270',
      sourceHash: 'a'.repeat(64),
      requiresOwnerDecision: true,
      options: [{ id: 'accept', label: 'לקבל' }],
    },
    {
      key: 'decision:1',
      sourceHash: 'b'.repeat(64),
      requiresOwnerDecision: false,
      options: [],
    },
  ],
};

test('answer updates revision without changing catalog history', () => {
  const initial = createInitialState(catalog, '2026-08-27T00:00:00.000Z');
  const next = recordAnswer(initial, catalog, {
    key: 'decision:270',
    sourceHash: 'a'.repeat(64),
    selection: 'accept',
    note: 'בחירה מפורשת',
    expectedRevision: 0,
  }, '2026-08-27T00:01:00.000Z');

  assert.equal(next.revision, 1);
  assert.equal(next.answers['decision:270'].selection, 'accept');
  assert.equal(initial.answers['decision:270'], undefined);
});

test('historical decision cannot be answered and can only create a reasoned reconsideration', () => {
  const initial = createInitialState(catalog, '2026-08-27T00:00:00.000Z');

  assert.throws(() => recordAnswer(initial, catalog, {
    key: 'decision:1',
    sourceHash: 'b'.repeat(64),
    selection: 'replacement',
    expectedRevision: 0,
  }), /reconsideration_required/);

  const next = recordReconsideration(initial, catalog, {
    key: 'decision:1',
    sourceHash: 'b'.repeat(64),
    requestedChoice: 'שיעור אחר',
    reason: 'המצב העסקי השתנה ולכן נדרשת בחינה חדשה',
    expectedRevision: 0,
  }, '2026-08-27T00:02:00.000Z');

  assert.equal(next.revision, 1);
  assert.equal(next.reconsiderations.length, 1);
  assert.equal(next.answers['decision:1'], undefined);
});

test('stale source and stale revision are rejected', () => {
  const initial = createInitialState(catalog, '2026-08-27T00:00:00.000Z');
  const base = {
    key: 'decision:270',
    selection: 'accept',
    note: '',
    expectedRevision: 0,
  };

  assert.throws(() => recordAnswer(initial, catalog, {
    ...base,
    sourceHash: 'c'.repeat(64),
  }), /source_changed/);
  assert.throws(() => recordAnswer(initial, catalog, {
    ...base,
    sourceHash: 'a'.repeat(64),
    expectedRevision: 9,
  }), /revision_conflict/);
});

test('state is written atomically as JSON and readable Markdown', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'owner-decisions-state-'));
  const state = createInitialState(catalog, '2026-08-27T00:00:00.000Z');
  await saveStateAtomic(dir, state, catalog);

  const loaded = await loadState(dir, catalog);
  const markdown = await readFile(path.join(dir, 'current.md'), 'utf8');
  assert.deepEqual(loaded, state);
  assert.match(markdown, /InPlace/);
  assert.match(markdown, /source-sha/);
});

test('new commit preserves current answers when decision sources did not change', () => {
  const initial = createInitialState(catalog, '2026-08-27T00:00:00.000Z');
  const answered = recordAnswer(initial, catalog, {
    key: 'decision:270',
    sourceHash: 'a'.repeat(64),
    selection: 'accept',
    note: '',
    expectedRevision: 0,
  }, '2026-08-27T00:01:00.000Z');
  const nextCatalog = { ...catalog, sourceCommit: 'new-code-only-sha' };
  const reconciled = reconcileSavedState(answered, nextCatalog, '2026-08-27T00:02:00.000Z');

  assert.equal(reconciled.sourceCommit, 'new-code-only-sha');
  assert.equal(reconciled.answers['decision:270'].selection, 'accept');
  assert.deepEqual(reconciled.staleItems, []);
});

test('changed decision source preserves the old answer separately and requires a fresh choice', () => {
  const initial = createInitialState(catalog, '2026-08-27T00:00:00.000Z');
  const answered = recordAnswer(initial, catalog, {
    key: 'decision:270',
    sourceHash: 'a'.repeat(64),
    selection: 'accept',
    note: '',
    expectedRevision: 0,
  }, '2026-08-27T00:01:00.000Z');
  const changedCatalog = {
    ...catalog,
    sourceCommit: 'changed-source-sha',
    sourceFiles: { ...catalog.sourceFiles, decisions: 'new-decisions-hash' },
    items: catalog.items.map((item) => item.key === 'decision:270' ? { ...item, sourceHash: 'c'.repeat(64) } : item),
  };
  const reconciled = reconcileSavedState(answered, changedCatalog, '2026-08-27T00:02:00.000Z');

  assert.equal(reconciled.answers['decision:270'], undefined);
  assert.equal(reconciled.staleAnswers['decision:270'].selection, 'accept');
  assert.deepEqual(reconciled.staleItems, ['decision:270']);
});
