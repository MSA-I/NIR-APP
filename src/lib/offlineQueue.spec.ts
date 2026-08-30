import { toErrorKey, toHebrewError } from './errors';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * `src/lib/supabase.ts` throws at module load without `VITE_SUPABASE_URL`, and nothing here talks to
 * a server: every test drives `createOfflineQueue` with its own `send` and its own storage. The
 * production singleton is created at import time, so the module still needs the symbol to exist.
 */
vi.mock('./supabase', () => ({
  supabase: {
    rpc: async () => ({ data: null, error: null }),
    auth: { getSession: async () => ({ data: { session: null }, error: null }) },
  },
}));

import {
  createOfflineQueue,
  isPermanentQueueFailure,
  isTransportFailure,
  receiptAuditReason,
  receiptConflictCode,
  type OfflineQueueDeps,
} from './offlineQueue';
import { OfflineStorageError, receiptPendingServerAcceptanceFromRows } from './offlineDb';
import { he } from './i18n/dictionaries/he';
import { en } from './i18n/dictionaries/en';
import type {
  OfflineQueuedAction, OfflineQueueStore, OfflineReceiptDraft, SaveGoodsReceiptPayload,
} from './offlineDb';

function memoryStore(seed: Omit<OfflineQueuedAction, 'id'>[] = []) {
  const queue = new Map<number, OfflineQueuedAction>();
  const drafts = new Map<string, OfflineReceiptDraft>();
  const openOrders = new Set<string>();
  let nextId = 1;
  let photos = 0;
  let lastSync: number | null = null;
  for (const action of seed) queue.set(nextId, {
    ...action, id: nextId++, syncVersion: action.syncVersion ?? 1,
    syncLeaseOwner: null, syncLeaseExpiresAt: null,
  });

  const store: OfflineQueueStore = {
    listQueuedActions: async () => [...queue.values()].sort((a, b) => (a.id ?? 0) - (b.id ?? 0)),
    upsertQueuedAction: async (action) => {
      const existing = [...queue.values()].find((row) => row.idempotencyKey === action.idempotencyKey);
      const keepCompletion = !!existing?.payload.p_complete && !action.payload.p_complete;
      const id = existing?.id ?? nextId++;
      const row: OfflineQueuedAction = {
        ...(existing ?? {}), ...action, id,
        payload: keepCompletion ? existing!.payload : action.payload,
        observedAt: keepCompletion ? existing!.observedAt : action.observedAt,
        syncVersion: (existing?.syncVersion ?? 0) + 1,
        syncLeaseOwner: null,
        syncLeaseExpiresAt: null,
      };
      queue.set(id, row);
      return row;
    },
    claimQueuedAction: async (id, owner, now) => {
      const row = queue.get(id);
      if (!row || row.state === 'conflict' || row.state === 'needs_attention'
        || (row.syncLeaseOwner && (row.syncLeaseExpiresAt ?? 0) > now)) return null;
      const claimed = {
        ...row,
        syncVersion: (row.syncVersion ?? 0) + 1,
        syncLeaseOwner: owner,
        syncLeaseExpiresAt: now + 60_000,
      };
      queue.set(id, claimed);
      return claimed;
    },
    updateClaimedQueuedAction: async (id, owner, version, patch, now) => {
      const row = queue.get(id);
      if (!row || row.syncLeaseOwner !== owner || row.syncVersion !== version
        || (row.syncLeaseExpiresAt ?? 0) <= now) return false;
      queue.set(id, { ...row, ...patch, syncLeaseOwner: null, syncLeaseExpiresAt: null });
      return true;
    },
    finalizeClaimedQueuedAction: async (id, owner, version, acceptedAt, now) => {
      const row = queue.get(id);
      if (!row || row.syncLeaseOwner !== owner || row.syncVersion !== version
        || (row.syncLeaseExpiresAt ?? 0) <= now) return false;
      const draft = drafts.get(row.orderId);
      const currentDraft = draft?.receiptId === row.idempotencyKey
        && draft.updatedAt === row.observedAt;
      if (row.payload.p_complete) {
        if (currentDraft) drafts.delete(row.orderId);
        if (!draft || currentDraft) openOrders.delete(row.orderId);
      } else if (draft && currentDraft) {
        drafts.set(row.orderId, { ...draft, syncedAt: acceptedAt, updatedAt: acceptedAt });
      }
      queue.delete(id);
      return true;
    },
    discardConflictedQueuedAction: async (id, expectedVersion, expectedState) => {
      const row = queue.get(id);
      if (!row || row.syncVersion !== expectedVersion || row.state !== expectedState
        || row.state !== 'conflict' || row.syncLeaseOwner) return false;
      const draft = drafts.get(row.orderId);
      if (draft?.receiptId === row.idempotencyKey && draft.updatedAt !== row.observedAt) return false;
      if (draft?.receiptId === row.idempotencyKey) drafts.delete(row.orderId);
      queue.delete(id);
      return true;
    },
    countPendingPhotos: async () => photos,
    getLastSuccessfulSyncAt: async () => lastSync,
    setLastSuccessfulSyncAt: async (at) => { lastSync = at; },
  };
  return {
    store, queue, drafts, openOrders,
    addOpenOrder: (orderId: string) => { openOrders.add(orderId); },
    putDraft: (draft: OfflineReceiptDraft) => { drafts.set(draft.orderId, draft); },
    setPhotos: (count: number) => { photos = count; },
    lastSync: () => lastSync,
  };
}

const payload = (receiptId: string, orderId = 'order-1'): SaveGoodsReceiptPayload => ({
  p_order_id: orderId,
  p_receipt_id: receiptId,
  p_complete: true,
  p_notes: null,
  p_open_credits: true,
  p_lines: [{ order_item_id: 'item-1', qty_received: 4, status: 'partial', notes: null }],
  p_reason: 'השלמת קבלת סחורה',
});

const queued = (receiptId: string, orderId = 'order-1'): Omit<OfflineQueuedAction, 'id'> => ({
  kind: 'save_goods_receipt',
  orgId: 'org-1',
  actorUserId: 'user-1',
  idempotencyKey: receiptId,
  orderId,
  orderLabel: `ספק · הזמנה #${orderId}`,
  payload: payload(receiptId, orderId),
  observedAt: 1_000,
  attempts: 0,
  state: 'pending',
  lastError: null,
  lastErrorCode: null,
  lastAttemptAt: null,
  createdAt: 1_000,
});

function build(overrides: Partial<OfflineQueueDeps> & { store: OfflineQueueStore }) {
  const deps: OfflineQueueDeps = {
    store: overrides.store,
    send: overrides.send ?? (async () => ({ receipt_id: 'server-receipt' })),
    getUsableActorId: overrides.getUsableActorId ?? (async () => 'user-1'),
    resolveScope: overrides.resolveScope ?? (async () => ({ orgId: 'org-1', actorUserId: 'user-1' })),
    isOnline: overrides.isOnline ?? (() => true),
    now: overrides.now ?? (() => 5_000),
    storageAvailable: overrides.storageAvailable ?? (() => true),
  };
  return createOfflineQueue(deps);
}

describe('the audited reason (#100)', () => {
  it('names both clocks only when they differ', () => {
    // 05:14Z and 11:02Z are 08:14 and 14:02 in Asia/Jerusalem — the plan's own example.
    const observed = Date.UTC(2026, 7, 5, 5, 14);
    const synced = Date.UTC(2026, 7, 5, 11, 2);
    expect(receiptAuditReason('השלמת קבלת סחורה', observed, synced))
      .toBe('השלמת קבלת סחורה · נרשמה במכשיר 08:14 · סונכרנה 14:02');
    // A send that happens in the same act is not two events, so the base string stands alone —
    // which is also what the existing browser-gate assertion reads.
    expect(receiptAuditReason('השלמת קבלת סחורה', observed, observed)).toBe('השלמת קבלת סחורה');
  });
});

describe('failure classification', () => {
  it('recognises the five conflict codes and nothing else', () => {
    expect(receiptConflictCode(new Error('receipt_qty_exceeds_order'))).toBe('receipt_qty_exceeds_order');
    expect(receiptConflictCode(new Error('receipt_draft_conflict'))).toBe('receipt_draft_conflict');
    expect(receiptConflictCode(new Error('receipt_already_completed'))).toBe('receipt_already_completed');
    expect(receiptConflictCode(new Error('receipt_idempotency_conflict'))).toBe('receipt_idempotency_conflict');
    expect(receiptConflictCode(new Error('purchase_order_not_receivable'))).toBe('purchase_order_not_receivable');
    expect(receiptConflictCode(new Error('Failed to fetch'))).toBeNull();
    expect(receiptConflictCode(new Error('not_authorized'))).toBeNull();
  });

  it('separates a transport failure from a business rejection', () => {
    expect(isTransportFailure(new Error('TypeError: Failed to fetch'))).toBe(true);
    expect(isTransportFailure(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe(true);
    expect(isTransportFailure(new Error('receipt_qty_exceeds_order'))).toBe(false);
  });

  it('recognises permanent authorization failures without classifying ordinary server errors', () => {
    expect(isPermanentQueueFailure(new Error('not_authorized'))).toBe(true);
    expect(isPermanentQueueFailure({ code: '42501', message: 'permission denied' })).toBe(true);
    expect(isPermanentQueueFailure(new Error('upstream temporarily unavailable'))).toBe(false);
  });
});

describe('submitting a receipt', () => {
  it('queues with a resolvable condition while offline and sends nothing', async () => {
    const memory = memoryStore();
    const send = vi.fn();
    const queue = build({ store: memory.store, send, isOnline: () => false });

    const outcome = await queue.submitReceipt({
      orderId: 'order-1', orderLabel: 'ספק · הזמנה #7', payload: payload('receipt-1'), observedAt: 1_000,
    });

    expect(outcome.kind).toBe('queued');
    expect(send).not.toHaveBeenCalled();
    // Split deliberately. The queue answers with a CONDITION — that half is what the screen and
    // IndexedDB both receive — and the sentence a person reads is pinned in each dictionary. One
    // assertion comparing a resolved sentence to itself would pass whether or not either language
    // actually says anything.
    expect(outcome.kind === 'queued' && outcome.queuedCondition).toBe('offline_queued_no_network');
    expect(he.errors.offline_queued_no_network)
      .toBe('אין חיבור לרשת. הקבלה נשמרה במכשיר ותישלח כשהחיבור יחזור.');
    expect(en.errors.offline_queued_no_network)
      .toBe('There is no network connection. The receipt is saved on this device and will be sent when the connection returns.');
    expect(queue.getSnapshot().pendingActions).toBe(1);
  });

  it('reports an explicit failure when IndexedDB refuses the queue write', async () => {
    const memory = memoryStore();
    memory.store.upsertQueuedAction = async () => {
      throw new OfflineStorageError('offline_storage_unavailable');
    };
    const queue = build({ store: memory.store, isOnline: () => false });

    const outcome = await queue.submitReceipt({
      orderId: 'order-1', orderLabel: 'ספק', payload: payload('receipt-1'), observedAt: 1_000,
    });

    // The storage error's own condition travels out untouched — it is more specific than anything
    // the queue could substitute — and both languages carry a sentence for it.
    expect(outcome).toEqual({ kind: 'rejected', failureCondition: 'offline_storage_unavailable' });
    expect(he.errors.offline_storage_unavailable).toBe('לא ניתן לשמור את העבודה במכשיר הזה.');
    expect(en.errors.offline_storage_unavailable).toBe('The work could not be saved on this device.');
    expect(queue.getSnapshot().pendingActions).toBe(0);
  });

  it('keeps the draft and sends nothing when the session has expired', async () => {
    // OFFLINE-SYNC-DESIGN §7: a queued action never travels with stale credentials.
    const memory = memoryStore();
    const send = vi.fn();
    const queue = build({ store: memory.store, send, getUsableActorId: async () => null });

    const outcome = await queue.submitReceipt({
      orderId: 'order-1', orderLabel: 'ספק', payload: payload('receipt-1'), observedAt: 1_000,
    });

    expect(send).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('queued');
    expect(queue.getSnapshot().sessionExpired).toBe(true);
    expect(queue.getSnapshot().pendingActions).toBe(1);
  });

  it('persists a conflict so a reload can still show the required decision', async () => {
    const memory = memoryStore();
    const queue = build({
      store: memory.store,
      send: async () => { throw new Error('receipt_qty_exceeds_order'); },
    });

    const outcome = await queue.submitReceipt({
      orderId: 'order-1', orderLabel: 'ספק', payload: payload('receipt-1'), observedAt: 1_000,
    });

    expect(outcome.kind).toBe('conflict');
    expect(outcome.kind === 'conflict' && outcome.code).toBe('receipt_qty_exceeds_order');
    expect(queue.getSnapshot().pendingActions).toBe(1);
    expect(queue.getSnapshot().actions[0]).toMatchObject({
      state: 'conflict', conflictCode: 'receipt_qty_exceeds_order', orderId: 'order-1',
    });
    const reloaded = build({ store: memory.store, send: vi.fn() });
    const reloadedSnapshot = await reloaded.refresh();
    expect(reloadedSnapshot.actions[0]).toMatchObject({
      state: 'conflict', conflictCode: 'receipt_qty_exceeds_order',
    });
  });

  it('refuses a stale conflict discard after another tab replaced the payload', async () => {
    const memory = memoryStore();
    const firstTab = build({
      store: memory.store,
      send: async () => { throw new Error('receipt_qty_exceeds_order'); },
      workerId: 'tab-a',
    });
    await firstTab.submitReceipt({
      orderId: 'order-1', orderLabel: 'ספק', payload: payload('receipt-1'), observedAt: 1_000,
    });
    const staleConflict = firstTab.getSnapshot().actions[0];

    const replacement = payload('receipt-1');
    replacement.p_lines = [{ ...replacement.p_lines[0], qty_received: 9 }];
    const secondTab = build({ store: memory.store, isOnline: () => false, workerId: 'tab-b' });
    await secondTab.submitReceipt({
      orderId: 'order-1', orderLabel: 'ספק', payload: replacement, observedAt: 2_000,
    });

    expect(await firstTab.discardAction(
      staleConflict.id, staleConflict.syncVersion, 'conflict',
    )).toBe(false);
    expect([...memory.queue.values()][0]).toMatchObject({
      state: 'pending', syncVersion: staleConflict.syncVersion + 1,
    });
    expect([...memory.queue.values()][0].payload.p_lines[0].qty_received).toBe(9);
  });

  it('records a real last-successful-sync time on acceptance, and none before', async () => {
    const memory = memoryStore();
    const queue = build({ store: memory.store, now: () => 7_777 });
    expect((await queue.refresh()).lastSuccessfulSyncAt).toBeNull();

    await queue.submitReceipt({
      orderId: 'order-1', orderLabel: 'ספק', payload: payload('receipt-1'), observedAt: 1_000,
    });
    expect(queue.getSnapshot().lastSuccessfulSyncAt).toBe(7_777);
  });

  it('replaces the entry for the same receipt instead of queueing it twice', async () => {
    const memory = memoryStore();
    const queue = build({ store: memory.store, isOnline: () => false });
    await queue.submitReceipt({
      orderId: 'order-1', orderLabel: 'ספק', payload: payload('receipt-1'), observedAt: 1_000,
    });
    await queue.submitReceipt({
      orderId: 'order-1', orderLabel: 'ספק', payload: payload('receipt-1'), observedAt: 2_000,
    });
    expect(queue.getSnapshot().pendingActions).toBe(1);
  });

  it('never downgrades a queued completion back to a draft after a reload', async () => {
    const memory = memoryStore([queued('receipt-1')]);
    const queue = build({ store: memory.store, isOnline: () => false });
    await queue.submitReceipt({
      orderId: 'order-1',
      orderLabel: 'ספק',
      payload: { ...payload('receipt-1'), p_complete: false, p_reason: 'שמירת טיוטה' },
      observedAt: 2_000,
    });
    const [action] = memory.queue.values();
    expect(action.payload.p_complete).toBe(true);
    expect(action.observedAt).toBe(1_000);
  });
});

describe('syncing the queue', () => {
  it('preserves a newer draft written while an accepted request is in flight', async () => {
    const memory = memoryStore();
    memory.addOpenOrder('order-1');
    memory.putDraft({
      orderId: 'order-1', receiptId: 'receipt-1', keySource: 'device', lines: [],
      openCredits: true, notes: null, observedAt: 1_000, updatedAt: 1_000,
      syncedAt: null, completed: true,
    });
    let release!: () => void;
    const send = vi.fn(() => new Promise<{ receipt_id: string }>((resolve) => {
      release = () => resolve({ receipt_id: 'receipt-1' });
    }));
    const queue = build({ store: memory.store, send, workerId: 'tab-a' });
    const submission = queue.submitReceipt({
      orderId: 'order-1', orderLabel: 'ספק', payload: payload('receipt-1'), observedAt: 1_000,
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1), { timeout: 3_000 });

    memory.putDraft({
      orderId: 'order-1', receiptId: 'receipt-1', keySource: 'device',
      lines: [{ ...payload('receipt-1').p_lines[0], qty_received: 9 }],
      openCredits: true, notes: 'newer tab', observedAt: 2_000, updatedAt: 2_000,
      syncedAt: null, completed: true,
    });
    release();

    await expect(submission).resolves.toMatchObject({ kind: 'sent', receiptId: 'receipt-1' });
    expect(memory.queue.size).toBe(0);
    expect(memory.drafts.get('order-1')).toMatchObject({ updatedAt: 2_000, notes: 'newer tab' });
  });

  it('keeps Receiving cleanup delegated to the atomic queue finalizer', () => {
    const source = readFileSync('src/pages/Receiving.tsx', 'utf8');
    expect(source).not.toContain('deleteReceiptDraft(');
    expect(source).toContain('Atomic queue finalization already deleted the exact accepted draft');
  });

  /**
   * The oracle for both halves of the condition boundary, written to need no maintenance: it reads
   * the two offline modules for every `offline_*` literal they can emit and demands that each one
   * resolves to a real sentence in BOTH languages.
   *
   * A hand-kept list would have passed while the bug was live. Two conditions really were emitted
   * with no pattern and no entry, so `errorText` answered with the generic fallback and the screen
   * whose whole purpose is to say WHICH receipt failed and WHY said neither.
   */
  it('resolves every offline condition to a real sentence in both languages', () => {
    const emitted = new Set<string>();
    for (const file of ['src/lib/offlineQueue.ts', 'src/lib/offlineDb.ts']) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/'(offline_[a-z0-9_]+)'/g)) emitted.add(match[1]);
    }
    // Positive control on the scan itself: an empty set would make every assertion below vacuous.
    expect(emitted.size).toBeGreaterThanOrEqual(13);

    for (const condition of emitted) {
      const key = toErrorKey(new Error(condition));
      expect(key, `${condition} matches no pattern in errors.ts`).not.toBe('fallback');
      const hebrew = (he.errors as Record<string, string>)[key];
      const english = (en.errors as Record<string, string>)[key];
      expect(hebrew, `${key} has no Hebrew sentence`).toBeTruthy();
      expect(english, `${key} has no English sentence`).toBeTruthy();
      expect(hebrew).not.toBe(he.errors.fallback);
      expect(english).not.toBe(en.errors.fallback);
      // The English sentence is what an English reader gets; a Hebrew letter in it is a leak.
      expect(english, `${key} leaks Hebrew into the English dictionary`).not.toMatch(/[֐-׿]/);
    }
  });

  /**
   * The other half of the same defect, and the half no unit test could see: the queue returned a
   * condition and `Receiving` toasted it verbatim, so a person standing at a delivery whose send
   * failed on a flaky connection was shown the literal text `offline_transport_failure`.
   */
  it('resolves the queue outcome in Receiving instead of printing the condition', () => {
    const source = readFileSync('src/pages/Receiving.tsx', 'utf8');
    expect(source).toContain('toast(errorText(outcome.queuedCondition))');
    expect(source).toContain("toast(errorText(outcome.failureCondition), 'error')");
    expect(source).not.toContain('toast(outcome.');
  });

  it('keeps an accepted receipt retryable when atomic local finalization fails', async () => {
    const memory = memoryStore([queued('receipt-1')]);
    memory.addOpenOrder('order-1');
    memory.putDraft({
      orderId: 'order-1', receiptId: 'receipt-1', keySource: 'device', lines: [],
      openCredits: true, notes: null, observedAt: 1_000, updatedAt: 1_000,
      syncedAt: null, completed: true,
    });
    const finalize = memory.store.finalizeClaimedQueuedAction;
    memory.store.finalizeClaimedQueuedAction = vi.fn()
      .mockRejectedValueOnce(new OfflineStorageError('cleanup failed'))
      .mockImplementation(finalize);
    const send = vi.fn(async () => ({ receipt_id: 'receipt-1' }));
    const queue = build({ store: memory.store, send, workerId: 'tab-a' });

    const failed = await queue.sync();

    expect(send).toHaveBeenCalledTimes(1);
    expect(failed.actions[0]).toMatchObject({ state: 'failed', idempotencyKey: 'receipt-1' });
    expect(receiptPendingServerAcceptanceFromRows(
      'receipt-1', [...memory.drafts.values()], [...memory.queue.values()],
    )).toBe(true);

    await queue.sync();
    expect(send).toHaveBeenCalledTimes(2);
    expect(memory.queue.size).toBe(0);
    expect(memory.drafts.size).toBe(0);
    expect(receiptPendingServerAcceptanceFromRows(
      'receipt-1', [...memory.drafts.values()], [...memory.queue.values()],
    )).toBe(false);
  });

  it('does not let a stale sender delete a payload replaced by another queue instance', async () => {
    const memory = memoryStore([queued('receipt-1')]);
    let release!: () => void;
    const staleSend = vi.fn(() => new Promise<{ receipt_id: string }>((resolve) => {
      release = () => resolve({ receipt_id: 'receipt-1' });
    }));
    const firstTab = build({ store: memory.store, send: staleSend, workerId: 'tab-a' });
    const firstSync = firstTab.sync();
    await vi.waitFor(() => expect(staleSend).toHaveBeenCalledTimes(1), { timeout: 3_000 });

    const replacement = payload('receipt-1');
    replacement.p_lines = [{ ...replacement.p_lines[0], qty_received: 9 }];
    const secondTabOffline = build({
      store: memory.store, isOnline: () => false, workerId: 'tab-b',
    });
    await secondTabOffline.submitReceipt({
      orderId: 'order-1', orderLabel: 'ספק', payload: replacement, observedAt: 2_000,
    });

    release();
    await firstSync;
    expect([...memory.queue.values()]).toHaveLength(1);
    expect([...memory.queue.values()][0].payload.p_lines[0].qty_received).toBe(9);

    const freshSend = vi.fn(async (sent: SaveGoodsReceiptPayload) => ({ receipt_id: sent.p_receipt_id }));
    const secondTabOnline = build({ store: memory.store, send: freshSend, workerId: 'tab-b' });
    await secondTabOnline.sync();
    expect(freshSend).toHaveBeenCalledWith(expect.objectContaining({
      p_lines: [expect.objectContaining({ qty_received: 9 })],
    }));
    expect(memory.queue.size).toBe(0);
  });

  it('continues after a failure and gives each action its own reason', async () => {
    const memory = memoryStore([queued('receipt-1', 'order-1'), queued('receipt-2', 'order-2'), queued('receipt-3', 'order-3')]);
    const sent: string[] = [];
    const queue = build({
      store: memory.store,
      send: async (sendPayload) => {
        sent.push(sendPayload.p_receipt_id);
        if (sendPayload.p_receipt_id === 'receipt-2') throw new Error('Failed to fetch');
        return { receipt_id: sendPayload.p_receipt_id };
      },
    });

    const snapshot = await queue.sync();

    // Every action got its turn — the middle failure did not stop the third.
    expect(sent).toEqual(['receipt-1', 'receipt-2', 'receipt-3']);
    expect(snapshot.pendingActions).toBe(1);
    const [failed] = snapshot.actions;
    expect(failed.idempotencyKey).toBe('receipt-2');
    expect(failed.attempts).toBe(1);
    expect(failed.state).toBe('failed');
    // The queue stores the RAW condition now, not a sentence: this row goes to IndexedDB and is
    // drawn on a later visit, so it must not carry a language chosen at the moment of failure.
    // Both halves are still pinned — what was stored, and that it resolves to real Hebrew when
    // somebody finally reads it, rather than to the generic sync failure.
    expect(failed.reason).toBe('Failed to fetch');
    expect(toHebrewError(new Error(failed.reason!))).toMatch(/[֐-׿]/);
    expect(toHebrewError(new Error(failed.reason!))).not.toMatch(/הסנכרון נכשל/);
  });

  it('counts pending actions and pending uploads separately', async () => {
    const memory = memoryStore([queued('receipt-1', 'order-1'), queued('receipt-2', 'order-2')]);
    memory.setPhotos(3);
    const queue = build({ store: memory.store, isOnline: () => false });

    const snapshot = await queue.refresh();
    expect(snapshot.pendingActions).toBe(2);
    expect(snapshot.pendingUploads).toBe(3);
  });

  it('sends the same p_receipt_id on every attempt', async () => {
    const memory = memoryStore([queued('receipt-1')]);
    const keys: string[] = [];
    let failNext = true;
    const queue = build({
      store: memory.store,
      send: async (sendPayload) => {
        keys.push(sendPayload.p_receipt_id);
        if (failNext) { failNext = false; throw new Error('Failed to fetch'); }
        return { receipt_id: sendPayload.p_receipt_id };
      },
    });

    await queue.sync();
    await queue.sync();

    expect(keys).toEqual(['receipt-1', 'receipt-1']);
    expect(queue.getSnapshot().pendingActions).toBe(0);
  });

  it('marks a conflicted action and never re-sends it on the next sync', async () => {
    const memory = memoryStore([queued('receipt-1')]);
    const send = vi.fn(async () => { throw new Error('receipt_already_completed'); });
    const queue = build({ store: memory.store, send });

    await queue.sync();
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.getSnapshot().actions[0].state).toBe('conflict');
    expect(queue.getSnapshot().actions[0].conflictCode).toBe('receipt_already_completed');

    // A pending human decision is not a transport problem: a second sync leaves it alone.
    await queue.sync();
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.getSnapshot().pendingActions).toBe(1);
  });

  it('does not retry a permanent authorization or scope rejection forever', async () => {
    const memory = memoryStore([queued('receipt-1')]);
    const send = vi.fn(async () => { throw new Error('not_authorized'); });
    const queue = build({ store: memory.store, send });

    await queue.sync();
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.getSnapshot().actions[0].state).toBe('needs_attention');

    await queue.sync();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('checks the actor again before every send and quarantines work after an account switch', async () => {
    const memory = memoryStore([queued('receipt-1', 'order-1'), queued('receipt-2', 'order-2')]);
    const actors = ['user-1', 'user-1', 'user-2'];
    const send = vi.fn(async (sendPayload: SaveGoodsReceiptPayload) => ({
      receipt_id: sendPayload.p_receipt_id,
    }));
    const queue = build({
      store: memory.store,
      send,
      getUsableActorId: async () => actors.shift() ?? 'user-2',
      resolveScope: async () => ({ orgId: 'org-1', actorUserId: actors.length === 0 ? 'user-2' : 'user-1' }),
    });

    await queue.sync();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ p_receipt_id: 'receipt-1' }));
    expect(queue.getSnapshot().actions[0]).toEqual(expect.objectContaining({
      idempotencyKey: 'receipt-2',
      state: 'pending',
    }));
    expect(queue.getSnapshot().sessionExpired).toBe(true);
  });

  it('never sends an unassigned v1 action', async () => {
    const legacy = { ...queued('receipt-v1'), orgId: undefined, actorUserId: undefined };
    const memory = memoryStore([legacy]);
    const send = vi.fn();
    const queue = build({ store: memory.store, send });

    await queue.sync();

    expect(send).not.toHaveBeenCalled();
    expect(queue.getSnapshot().actions[0].state).toBe('pending');
  });

  it('sends nothing at all while offline or without a session', async () => {
    const memory = memoryStore([queued('receipt-1')]);
    const send = vi.fn();
    const offline = build({ store: memory.store, send, isOnline: () => false });
    await offline.sync();
    const stale = build({ store: memory.store, send, getUsableActorId: async () => null });
    const snapshot = await stale.sync();
    expect(send).not.toHaveBeenCalled();
    expect(snapshot.sessionExpired).toBe(true);
    expect(snapshot.pendingActions).toBe(1);
  });

  it('removes a completed local draft once the server accepts it', async () => {
    const memory = memoryStore([queued('receipt-1')]);
    memory.addOpenOrder('order-1');
    memory.putDraft({
      orderId: 'order-1', receiptId: 'receipt-1', keySource: 'device',
      lines: [], openCredits: true, notes: null,
      observedAt: 1_000, updatedAt: 1_000, syncedAt: null, completed: false,
    });
    const queue = build({ store: memory.store, now: () => 8_000 });
    await queue.sync();
    expect(memory.drafts.has('order-1')).toBe(false);
    expect(memory.openOrders.has('order-1')).toBe(false);
  });

  it('stamps a queued action with both clocks when it finally goes out', async () => {
    const observedAt = Date.UTC(2026, 7, 5, 5, 14);
    const sentAt = Date.UTC(2026, 7, 5, 11, 2);
    const memory = memoryStore([{ ...queued('receipt-1'), observedAt }]);
    const reasons: string[] = [];
    const queue = build({
      store: memory.store,
      now: () => sentAt,
      send: async (sendPayload) => {
        reasons.push(sendPayload.p_reason);
        return { receipt_id: sendPayload.p_receipt_id };
      },
    });

    await queue.sync();
    expect(reasons).toEqual(['השלמת קבלת סחורה · נרשמה במכשיר 08:14 · סונכרנה 14:02']);
  });
});
