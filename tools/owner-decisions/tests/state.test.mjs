import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  createInitialState,
  finalizeState,
  loadState,
  recordAnswer,
  recordDebtPriority,
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
    {
      key: 'debt:1',
      type: 'debt',
      sourceHash: 'e'.repeat(64),
      requiresOwnerDecision: false,
      recommendedPriority: 'plan_now',
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

test('an answer to a question the register has since closed keeps its history without blocking finalization', () => {
  const initial = createInitialState(catalog, '2026-08-30T00:00:00.000Z');
  const answered = recordAnswer(initial, catalog, {
    key: 'decision:270',
    sourceHash: 'a'.repeat(64),
    selection: 'accept',
    note: '',
    expectedRevision: 0,
  }, '2026-08-30T00:01:00.000Z');

  // The register closes the item: its text changes and it stops being an owner question.
  // The old answer can no longer be renewed, because the card offers no options at all.
  const closedCatalog = {
    ...catalog,
    sourceFiles: { ...catalog.sourceFiles, decisions: 'new-decisions-hash' },
    items: catalog.items.map((item) => item.key === 'decision:270'
      ? { ...item, sourceHash: 'c'.repeat(64), requiresOwnerDecision: false, options: [] }
      : item),
  };
  const reconciled = reconcileSavedState(answered, closedCatalog, '2026-08-30T00:02:00.000Z');

  assert.equal(reconciled.staleAnswers['decision:270'].selection, 'accept', 'the earlier choice stays as history');
  assert.deepEqual(reconciled.staleItems, [], 'a closed item must not gate the finish button');
  assert.doesNotThrow(() => finalizeState(reconciled, closedCatalog, {
    expectedRevision: reconciled.revision,
    sourceCommit: closedCatalog.sourceCommit,
  }, '2026-08-30T00:03:00.000Z'));
});

test('changed historical source preserves reconsideration and blocks finalization until renewed', () => {
  const initial = createInitialState(catalog, '2026-08-27T00:00:00.000Z');
  const requested = recordReconsideration(initial, catalog, {
    key: 'decision:1',
    sourceHash: 'b'.repeat(64),
    requestedChoice: 'בחירה חדשה',
    reason: 'המצב העסקי השתנה ודורש החלטה מעודכנת',
    expectedRevision: 0,
  }, '2026-08-27T00:01:00.000Z');
  const changedCatalog = {
    ...catalog,
    sourceCommit: 'changed-history-sha',
    sourceFiles: { ...catalog.sourceFiles, decisions: 'new-decisions-hash' },
    items: catalog.items.map((item) => item.key === 'decision:1' ? { ...item, sourceHash: 'd'.repeat(64) } : item),
  };
  const reconciled = reconcileSavedState(requested, changedCatalog, '2026-08-27T00:02:00.000Z');

  assert.equal(reconciled.reconsiderations.length, 0);
  assert.equal(reconciled.staleReconsiderations.length, 1);
  assert.deepEqual(reconciled.staleItems, ['decision:1']);
  assert.throws(() => finalizeState(reconciled, changedCatalog, {
    expectedRevision: reconciled.revision,
    sourceCommit: changedCatalog.sourceCommit,
  }), /source_changed/);

  const renewed = recordReconsideration(reconciled, changedCatalog, {
    key: 'decision:1',
    sourceHash: 'd'.repeat(64),
    requestedChoice: 'בחירה מעודכנת',
    reason: 'קראתי את המקור החדש ואני מבקש שינוי חדש',
    expectedRevision: reconciled.revision,
  }, '2026-08-27T00:03:00.000Z');
  assert.deepEqual(renewed.staleItems, []);
  assert.ok(renewed.staleReconsiderations[0].supersededAt);
});

test('JSON remains canonical and temporary files are cleaned when Markdown replacement fails', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'owner-decisions-fault-'));
  const state = createInitialState(catalog, '2026-08-27T00:00:00.000Z');
  const result = await saveStateAtomic(dir, state, catalog, {
    renameFile: async (from, to) => {
      if (to.endsWith('current.md')) throw Object.assign(new Error('simulated markdown failure'), { code: 'EACCES' });
      return rename(from, to);
    },
  });

  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'current.json'), 'utf8')), state);
  assert.deepEqual(result.warnings, ['markdown_not_updated']);
  assert.equal((await readdir(dir)).some((name) => name.endsWith('.tmp')), false);
});

test('technical debt accepts business priority without pretending it is a technical decision', () => {
  const initial = createInitialState(catalog, '2026-08-27T00:00:00.000Z');
  const prioritized = recordDebtPriority(initial, catalog, {
    key: 'debt:1',
    sourceHash: 'e'.repeat(64),
    priority: 'plan_now',
    expectedRevision: 0,
  }, '2026-08-27T00:01:00.000Z');

  assert.equal(prioritized.debtPriorities['debt:1'].priority, 'plan_now');
  assert.equal(prioritized.answers['debt:1'], undefined);
  assert.throws(() => recordDebtPriority(initial, catalog, {
    key: 'decision:1',
    sourceHash: 'b'.repeat(64),
    priority: 'plan_now',
    expectedRevision: 0,
  }), /technical_debt_required/);

  const recommended = recordDebtPriority(initial, catalog, {
    key: 'debt:1',
    sourceHash: 'e'.repeat(64),
    priority: 'follow_recommendation',
    expectedRevision: 0,
  }, '2026-08-27T00:02:00.000Z');
  assert.equal(recommended.debtPriorities['debt:1'].priority, 'follow_recommendation');
  assert.equal(recommended.debtPriorities['debt:1'].resolvedPriority, 'plan_now');
});
