import { describe, expect, it, vi } from 'vitest';

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
  isTransportFailure,
  receiptAuditReason,
  receiptConflictCode,
  type OfflineQueueDeps,
} from './offlineQueue';
import type {
  OfflineQueuedAction, OfflineQueueStore, OfflineReceiptDraft, SaveGoodsReceiptPayload,
} from './offlineDb';

function memoryStore(seed: Omit<OfflineQueuedAction, 'id'>[] = []) {
  const queue = new Map<number, OfflineQueuedAction>();
  const drafts = new Map<string, OfflineReceiptDraft>();
  let nextId = 1;
  let photos = 0;
  let lastSync: number | null = null;
  for (const action of seed) queue.set(nextId, { ...action, id: nextId++ });

  const store: OfflineQueueStore = {
    listQueuedActions: async () => [...queue.values()].sort((a, b) => (a.id ?? 0) - (b.id ?? 0)),
    putQueuedAction: async (action) => { if (action.id != null) queue.set(action.id, action); },
    deleteQueuedAction: async (id) => { queue.delete(id); },
    enqueueAction: async (action) => {
      const id = nextId++;
      queue.set(id, { ...action, id });
      return id;
    },
    countPendingPhotos: async () => photos,
    getLastSuccessfulSyncAt: async () => lastSync,
    setLastSuccessfulSyncAt: async (at) => { lastSync = at; },
    getReceiptDraft: async (orderId) => drafts.get(orderId) ?? null,
    putReceiptDraft: async (draft) => { drafts.set(draft.orderId, draft); },
  };
  return {
    store, queue, drafts,
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
    hasUsableSession: overrides.hasUsableSession ?? (async () => true),
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
});

describe('submitting a receipt', () => {
  it('queues with a Hebrew reason while offline and sends nothing', async () => {
    const memory = memoryStore();
    const send = vi.fn();
    const queue = build({ store: memory.store, send, isOnline: () => false });

    const outcome = await queue.submitReceipt({
      orderId: 'order-1', orderLabel: 'ספק · הזמנה #7', payload: payload('receipt-1'), observedAt: 1_000,
    });

    expect(outcome.kind).toBe('queued');
    expect(send).not.toHaveBeenCalled();
    expect(outcome.kind === 'queued' && outcome.reason).toMatch(/[֐-׿]/);
    expect(queue.getSnapshot().pendingActions).toBe(1);
  });

  it('keeps the draft and sends nothing when the session has expired', async () => {
    // OFFLINE-SYNC-DESIGN §7: a queued action never travels with stale credentials.
    const memory = memoryStore();
    const send = vi.fn();
    const queue = build({ store: memory.store, send, hasUsableSession: async () => false });

    const outcome = await queue.submitReceipt({
      orderId: 'order-1', orderLabel: 'ספק', payload: payload('receipt-1'), observedAt: 1_000,
    });

    expect(send).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('queued');
    expect(queue.getSnapshot().sessionExpired).toBe(true);
    expect(queue.getSnapshot().pendingActions).toBe(1);
  });

  it('opens a conflict instead of queueing a rejection that a retry cannot fix', async () => {
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
    // Nothing was queued: re-sending would just re-collect the same rejection.
    expect(queue.getSnapshot().pendingActions).toBe(0);
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
});

describe('syncing the queue', () => {
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
    expect(failed.reason).toMatch(/[֐-׿]/);
    expect(failed.reason).not.toMatch(/הסנכרון נכשל/);
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

  it('sends nothing at all while offline or without a session', async () => {
    const memory = memoryStore([queued('receipt-1')]);
    const send = vi.fn();
    const offline = build({ store: memory.store, send, isOnline: () => false });
    await offline.sync();
    const stale = build({ store: memory.store, send, hasUsableSession: async () => false });
    const snapshot = await stale.sync();
    expect(send).not.toHaveBeenCalled();
    expect(snapshot.sessionExpired).toBe(true);
    expect(snapshot.pendingActions).toBe(1);
  });

  it('marks the local draft synced once the server accepts it', async () => {
    const memory = memoryStore([queued('receipt-1')]);
    await memory.store.putReceiptDraft({
      orderId: 'order-1', receiptId: 'receipt-1', keySource: 'device',
      lines: [], openCredits: true, notes: null,
      observedAt: 1_000, updatedAt: 1_000, syncedAt: null, completed: false,
    });
    const queue = build({ store: memory.store, now: () => 8_000 });
    await queue.sync();
    expect(memory.drafts.get('order-1')?.syncedAt).toBe(8_000);
    expect(memory.drafts.get('order-1')?.completed).toBe(true);
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
