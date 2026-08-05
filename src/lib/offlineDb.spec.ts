import { describe, expect, it } from 'vitest';
import {
  OFFLINE_DB_VERSION,
  OFFLINE_STORES,
  OPEN_ORDER_STALE_AFTER_MS,
  applyOfflineDbUpgrade,
  ensureReceiptKey,
  isOpenOrderStale,
  type OfflineOpenOrder,
  type OfflineReceiptDraft,
  type OfflineReceiptLine,
  type OfflineUpgradeIndexTarget,
  type OfflineUpgradeTarget,
  type ReceiptDraftStore,
} from './offlineDb';

/**
 * The upgrade function is driven over a recording double rather than a real IndexedDB.
 *
 * jsdom ships no IndexedDB at all, so the alternative would be a shim dependency whose behaviour is
 * then the thing under test. What is asserted here is the claim this module actually makes: which
 * stores and indexes version 1 creates, and that re-opening an up-to-date database creates nothing.
 * The real engine is exercised where it is real — the browser gate reloads the page mid-receipt and
 * asserts the draft and the queue survived.
 */
function recordingTarget(existing: string[] = []) {
  const stores = new Map<string, { options: unknown; indexes: [string, string | string[]][] }>();
  const names = new Set(existing);
  const target: OfflineUpgradeTarget = {
    objectStoreNames: { contains: (name) => names.has(name) },
    createObjectStore(name, options) {
      const record = { options, indexes: [] as [string, string | string[]][] };
      stores.set(name, record);
      names.add(name);
      const store: OfflineUpgradeIndexTarget = {
        createIndex(indexName, keyPath) {
          record.indexes.push([indexName, keyPath]);
          return undefined;
        },
      };
      return store;
    },
  };
  return { target, stores };
}

/** An in-memory draft store that outlives a simulated reload. */
function memoryDraftStore(seed: OfflineReceiptDraft[] = []) {
  const rows = new Map(seed.map((draft) => [draft.orderId, draft]));
  const store: ReceiptDraftStore = {
    getReceiptDraft: async (orderId) => rows.get(orderId) ?? null,
    putReceiptDraft: async (draft) => { rows.set(draft.orderId, draft); },
  };
  return { store, rows };
}

const line = (id: string): OfflineReceiptLine => ({
  order_item_id: id, qty_received: 3, status: 'partial', notes: null,
});

describe('offline database schema', () => {
  it('creates the four documented stores plus the sync-time keyval, with their indexes', () => {
    const { target, stores } = recordingTarget();
    const created = applyOfflineDbUpgrade(target, 0);

    expect(created).toEqual([
      OFFLINE_STORES.openOrders,
      OFFLINE_STORES.receiptDrafts,
      OFFLINE_STORES.pendingPhotos,
      OFFLINE_STORES.syncQueue,
      OFFLINE_STORES.syncMeta,
    ]);
    // open_orders and receipt_drafts are keyed by the order: one download and one draft per order.
    expect(stores.get(OFFLINE_STORES.openOrders)?.options).toEqual({ keyPath: 'orderId' });
    expect(stores.get(OFFLINE_STORES.receiptDrafts)?.options).toEqual({ keyPath: 'orderId' });
    // The queue's autoIncrement key IS its order — insertion order is send order.
    expect(stores.get(OFFLINE_STORES.syncQueue)?.options).toEqual({ keyPath: 'id', autoIncrement: true });
    expect(stores.get(OFFLINE_STORES.pendingPhotos)?.options).toEqual({ keyPath: 'id', autoIncrement: true });
    expect(stores.get(OFFLINE_STORES.syncQueue)?.indexes).toEqual([
      ['by-key', 'idempotencyKey'],
      ['by-createdAt', 'createdAt'],
    ]);
    expect(stores.get(OFFLINE_STORES.pendingPhotos)?.indexes).toEqual([
      ['by-entity', ['entityType', 'entityId']],
      ['by-createdAt', 'createdAt'],
    ]);
  });

  it('creates nothing when the device is already at the current version', () => {
    const { target, stores } = recordingTarget(Object.values(OFFLINE_STORES));
    expect(applyOfflineDbUpgrade(target, OFFLINE_DB_VERSION)).toEqual([]);
    expect(stores.size).toBe(0);
  });

  it('never re-creates a store that already exists on a partially upgraded device', () => {
    // A device that was interrupted mid-upgrade must be repaired, not crashed: createObjectStore on
    // an existing name throws in a real IndexedDB transaction.
    const { target, stores } = recordingTarget([OFFLINE_STORES.openOrders, OFFLINE_STORES.syncQueue]);
    const created = applyOfflineDbUpgrade(target, 0);
    expect(created).toEqual([
      OFFLINE_STORES.receiptDrafts, OFFLINE_STORES.pendingPhotos, OFFLINE_STORES.syncMeta,
    ]);
    expect(stores.has(OFFLINE_STORES.openOrders)).toBe(false);
  });
});

describe('open-order staleness', () => {
  const entry = (fetchedAt: number): OfflineOpenOrder => ({
    orderId: 'order-1', fetchedAt, supplierName: 'ספק', number: 12, order: {},
  });

  it('reports age as a fact after 24 hours and never deletes anything', () => {
    const now = 1_800_000_000_000;
    expect(isOpenOrderStale(entry(now - 1000), now)).toBe(false);
    expect(isOpenOrderStale(entry(now - OPEN_ORDER_STALE_AFTER_MS - 1), now)).toBe(true);
    expect(OPEN_ORDER_STALE_AFTER_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('the persisted idempotency key', () => {
  it('adopts the server draft id when one was read, and stores it', async () => {
    const { store, rows } = memoryDraftStore();
    const resolution = await ensureReceiptKey({
      orderId: 'order-1',
      serverDraftId: 'server-receipt-1',
      lines: [line('item-1')],
      openCredits: true,
      now: 1_000,
      mintId: () => 'device-uuid',
      store,
    });
    expect(resolution).toEqual({
      receiptId: 'server-receipt-1', keySource: 'server-draft', persisted: true, minted: true,
    });
    expect(rows.get('order-1')?.receiptId).toBe('server-receipt-1');
    expect(rows.get('order-1')?.syncedAt).toBeNull();
  });

  it('mints a device key when no server draft could be read', async () => {
    const { store } = memoryDraftStore();
    const resolution = await ensureReceiptKey({
      orderId: 'order-1', serverDraftId: null, lines: [line('item-1')], openCredits: true,
      now: 1_000, mintId: () => 'device-uuid', store,
    });
    expect(resolution.receiptId).toBe('device-uuid');
    expect(resolution.keySource).toBe('device');
  });

  it('reuses the stored key across a reload, even when the next read succeeds differently', async () => {
    // The bug this rule replaces: `draft.id ?? newReceiptId` made the key depend on whether a read
    // succeeded, so the same physical receipt could be submitted under two different keys and be
    // recorded twice. After the first mint, nothing may change it.
    const { store, rows } = memoryDraftStore();
    const first = await ensureReceiptKey({
      orderId: 'order-1', serverDraftId: null, lines: [line('item-1')], openCredits: true,
      now: 1_000, mintId: () => 'device-uuid', store,
    });

    // A second visit — a fresh page load, a different read outcome, a different mint available.
    const second = await ensureReceiptKey({
      orderId: 'order-1', serverDraftId: 'some-other-server-draft', lines: [line('item-1')],
      openCredits: false, now: 9_000, mintId: () => 'another-uuid', store,
    });

    expect(second.receiptId).toBe(first.receiptId);
    expect(second.receiptId).toBe('device-uuid');
    expect(second.minted).toBe(false);
    expect(second.keySource).toBe('device');
    expect(rows.size).toBe(1);
  });

  it('reports persisted:false when the device refused to store the draft', async () => {
    // Private-browsing modes can drop the write. The screen must be able to say so rather than
    // promise a durable draft it does not have.
    const store: ReceiptDraftStore = {
      getReceiptDraft: async () => null,
      putReceiptDraft: async () => {},
    };
    const resolution = await ensureReceiptKey({
      orderId: 'order-1', serverDraftId: null, lines: [], openCredits: true,
      now: 1, mintId: () => 'device-uuid', store,
    });
    expect(resolution.persisted).toBe(false);
    expect(resolution.receiptId).toBe('device-uuid');
  });
});
