import { describe, expect, it } from 'vitest';
import {
  OFFLINE_DB_VERSION,
  OFFLINE_STORES,
  OFFLINE_V1_STORES,
  OPEN_ORDER_STALE_AFTER_MS,
  applyOfflineDbUpgrade,
  legacyReceiptRecoveryPlan,
  ensureReceiptKey,
  offlineOrderStorageKey,
  isOpenOrderStale,
  type OfflineOpenOrder,
  type OfflineReceiptDraft,
  type OfflineReceiptLine,
  type OfflineUpgradeIndexTarget,
  type OfflineUpgradeTarget,
  type ReceiptDraftStore,
} from './offlineDb';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The upgrade function is driven over a recording double rather than a real IndexedDB.
 *
 * jsdom ships no IndexedDB at all, so the alternative would be a shim dependency whose behaviour is
 * then the thing under test. What is asserted here is the claim this module actually makes: which
 * stores and indexes the current schema creates, and that re-opening an up-to-date database creates nothing.
 * The real engine is exercised where it is real — the browser gate reloads the page mid-receipt and
 * asserts the draft and the queue survived.
 */
function recordingTarget(existing: string[] = []) {
  const stores = new Map<string, { options: unknown; indexes: [string, string | string[]][] }>();
  const upgradedIndexes = new Map<string, [string, string | string[]][]>();
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
  const existingStore = (name: string): OfflineUpgradeIndexTarget => ({
    createIndex(indexName, keyPath) {
      const indexes = upgradedIndexes.get(name) ?? [];
      indexes.push([indexName, keyPath]);
      upgradedIndexes.set(name, indexes);
      return undefined;
    },
  });
  return { target, stores, existingStore, upgradedIndexes };
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
  it('keeps v1 stores for recovery and creates scoped v2 order and draft stores', () => {
    const { target, stores } = recordingTarget();
    const created = applyOfflineDbUpgrade(target, 0);

    expect(created).toEqual([
      OFFLINE_V1_STORES.openOrders,
      OFFLINE_V1_STORES.receiptDrafts,
      OFFLINE_STORES.pendingPhotos,
      OFFLINE_STORES.syncQueue,
      OFFLINE_STORES.syncMeta,
      OFFLINE_STORES.openOrders,
      OFFLINE_STORES.receiptDrafts,
    ]);
    expect(stores.get(OFFLINE_V1_STORES.openOrders)?.options).toEqual({ keyPath: 'orderId' });
    expect(stores.get(OFFLINE_V1_STORES.receiptDrafts)?.options).toEqual({ keyPath: 'orderId' });
    expect(stores.get(OFFLINE_STORES.openOrders)?.options).toEqual({
      keyPath: ['orgId', 'actorUserId', 'orderId'],
    });
    expect(stores.get(OFFLINE_STORES.receiptDrafts)?.options).toEqual({
      keyPath: ['orgId', 'actorUserId', 'orderId'],
    });
    // The queue's autoIncrement key IS its order — insertion order is send order.
    expect(stores.get(OFFLINE_STORES.syncQueue)?.options).toEqual({ keyPath: 'id', autoIncrement: true });
    expect(stores.get(OFFLINE_STORES.pendingPhotos)?.options).toEqual({ keyPath: 'id', autoIncrement: true });
    expect(stores.get(OFFLINE_STORES.syncQueue)?.indexes).toEqual([
      ['by-key', 'idempotencyKey'],
      ['by-createdAt', 'createdAt'],
      ['by-scope', ['orgId', 'actorUserId']],
      ['by-scope-key', ['orgId', 'actorUserId', 'idempotencyKey']],
    ]);
    expect(stores.get(OFFLINE_STORES.pendingPhotos)?.indexes).toEqual([
      ['by-entity', ['entityType', 'entityId']],
      ['by-createdAt', 'createdAt'],
      ['by-scope', ['orgId', 'actorUserId']],
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
      OFFLINE_V1_STORES.openOrders,
      OFFLINE_V1_STORES.receiptDrafts,
      OFFLINE_STORES.pendingPhotos,
      OFFLINE_STORES.syncMeta,
      OFFLINE_STORES.receiptDrafts,
    ]);
    expect(stores.has(OFFLINE_STORES.openOrders)).toBe(false);
  });

  it('upgrades v1 by adding separate v2 stores without assigning legacy rows', () => {
    const v1Stores = [
      ...Object.values(OFFLINE_V1_STORES),
      OFFLINE_STORES.pendingPhotos,
      OFFLINE_STORES.syncQueue,
      OFFLINE_STORES.syncMeta,
    ];
    const { target, existingStore, upgradedIndexes, stores } = recordingTarget(v1Stores);
    expect(applyOfflineDbUpgrade(target, 1, existingStore)).toEqual([
      OFFLINE_STORES.openOrders,
      OFFLINE_STORES.receiptDrafts,
    ]);
    expect(stores.get(OFFLINE_STORES.openOrders)?.options).toEqual({
      keyPath: ['orgId', 'actorUserId', 'orderId'],
    });
    expect(upgradedIndexes.has(OFFLINE_V1_STORES.openOrders)).toBe(false);
    expect(upgradedIndexes.has(OFFLINE_V1_STORES.receiptDrafts)).toBe(false);
    expect(upgradedIndexes.get(OFFLINE_STORES.syncQueue)).toEqual([
      ['by-scope', ['orgId', 'actorUserId']],
      ['by-scope-key', ['orgId', 'actorUserId', 'idempotencyKey']],
    ]);
  });

  it('uses different physical keys for two actors receiving the same order', () => {
    const actorA = offlineOrderStorageKey({ orgId: 'org-1', actorUserId: 'user-a' }, 'order-1');
    const actorB = offlineOrderStorageKey({ orgId: 'org-1', actorUserId: 'user-b' }, 'order-1');
    const rows = new Map<string, string>();
    rows.set(JSON.stringify(actorA), 'draft-a');
    rows.set(JSON.stringify(actorB), 'draft-b');

    expect(actorA).not.toEqual(actorB);
    expect(rows.size).toBe(2);
    expect(rows.get(JSON.stringify(actorA))).toBe('draft-a');
    expect(rows.get(JSON.stringify(actorB))).toBe('draft-b');
  });
});

describe('legacy offline recovery', () => {
  const draft: OfflineReceiptDraft = {
    orderId: 'order-1', receiptId: 'receipt-1', keySource: 'device', lines: [line('item-1')],
    openCredits: true, notes: null, observedAt: 1, updatedAt: 2, syncedAt: null, completed: false,
  };
  const action = {
    kind: 'save_goods_receipt' as const, id: 4, idempotencyKey: 'receipt-1', orderId: 'order-1',
    orderLabel: 'הזמנה', payload: {} as never, observedAt: 1, attempts: 0,
    state: 'pending' as const, lastError: null, lastErrorCode: null, lastAttemptAt: null, createdAt: 1,
  };

  it('selects only unscoped work tied to the confirmed order and receipt', () => {
    const plan = legacyReceiptRecoveryPlan('order-1', draft, undefined, [
      action,
      { ...action, id: 5, orgId: 'org-2', actorUserId: 'user-2' },
      { ...action, id: 6, orderId: 'order-2' },
    ], [
      { id: 7, entityType: 'goods_receipt', entityId: 'receipt-1', fileName: 'a.jpg', blob: new Blob(), createdAt: 1 },
      { id: 8, entityType: 'invoice', entityId: 'receipt-1', fileName: 'b.jpg', blob: new Blob(), createdAt: 1 },
    ]);
    expect(plan?.preview).toMatchObject({ receiptId: 'receipt-1', queuedActions: 1, pendingPhotos: 1 });
    expect(plan?.actions.map(({ id }) => id)).toEqual([4]);
    expect(plan?.photos.map(({ id }) => id)).toEqual([7]);
  });

  it('cannot recover a legacy row that has no draft or queued receipt identity', () => {
    expect(legacyReceiptRecoveryPlan('order-1', undefined, undefined, [], [])).toBeNull();
  });

  it('uses one readwrite transaction and waits for commit before reporting success', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'lib', 'offlineDb.ts'), 'utf8');
    const claim = source.slice(source.indexOf('export async function claimLegacyReceiptRecovery'));
    expect(claim).toContain("], 'readwrite')");
    expect(claim).toContain('await tx.done');
    expect(claim.indexOf('await tx.done')).toBeLessThan(claim.indexOf('return true'));
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
