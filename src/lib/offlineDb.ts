import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

/**
 * Local store for the ONE offline path this product allows: goods receiving
 * (`docs/adr/0006-offline-scoped-to-goods-receiving.md`, `docs/OFFLINE-SYNC-DESIGN.md` §2-§3).
 *
 * IndexedDB through `idb` (ISC), not `localStorage` — ADR-0006 rejected `localStorage` for three
 * reasons that all still hold: it is synchronous, it is size-limited, and it cannot hold the photo
 * Blobs this queue carries.
 *
 * **Nothing financial is ever written here.** No balance, no amount due, no payment status, no
 * supplier bank details — the never-cache list of `OFFLINE-SYNC-DESIGN.md:36` is a hard boundary,
 * not a preference. What lands here is a report of what the device saw: quantities, line statuses,
 * notes, photos, and the receipt's idempotency key.
 */

export const OFFLINE_DB_NAME = 'supplyflow-offline';

/**
 * Schema version. Bumping it means adding a `stepUpgrade` branch below — never editing an
 * existing one, because an existing branch is the only description of what already ran on a
 * user's device.
 */
export const OFFLINE_DB_VERSION = 1;

/** Downloaded open orders go stale after 24 hours. Stale is DISPLAYED, never silently deleted. */
export const OPEN_ORDER_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export const OFFLINE_STORES = {
  openOrders: 'open_orders',
  receiptDrafts: 'receipt_drafts',
  pendingPhotos: 'pending_photos',
  syncQueue: 'sync_queue',
  syncMeta: 'sync_meta',
} as const;

export type ReceiptLineStatusValue = 'full' | 'partial' | 'missing' | 'damaged' | 'returned';

export interface OfflineReceiptLine {
  order_item_id: string;
  qty_received: number;
  status: ReceiptLineStatusValue;
  notes: string | null;
}

/** Exactly the argument object `save_goods_receipt` is called with, offline or online. */
export interface SaveGoodsReceiptPayload {
  p_order_id: string;
  p_receipt_id: string;
  p_complete: boolean;
  p_notes: string | null;
  p_open_credits: boolean;
  p_lines: OfflineReceiptLine[];
  /** System-authored; the queue re-derives it at send time so the observed clock stays truthful. */
  p_reason: string;
}

export interface OfflineOpenOrder {
  orderId: string;
  /**
   * When this snapshot was read from the server. Kept so staleness can be SHOWN
   * (`OFFLINE-SYNC-DESIGN.md:44`): after 24h the order reads as "מיושן", and it is still there —
   * deleting a warehouse worker's only copy of an order to protect them from its age would be
   * worse than telling them how old it is.
   */
  fetchedAt: number;
  supplierName: string;
  number: number | null;
  order: unknown;
}

export interface OfflineReceiptDraft {
  orderId: string;
  /**
   * The idempotency key of this receipt, minted ONCE and persisted at draft creation
   * (ADR-0006:37-39). Every attempt — this session, after a reload, after a crash, from the
   * queue — sends this exact value, so the server answers with the same receipt instead of
   * creating a second one.
   */
  receiptId: string;
  /** Which read produced the key. `server-draft` outranks `device` only at creation time. */
  keySource: 'server-draft' | 'device';
  lines: OfflineReceiptLine[];
  openCredits: boolean;
  notes: string | null;
  /** Device clock at the moment the person recorded the goods. Feeds the audited reason (#100). */
  observedAt: number;
  updatedAt: number;
  /** Epoch ms of the successful server write, or null while the draft is still local-only. */
  syncedAt: number | null;
  /** True once a completing save has been accepted by the server. */
  completed: boolean;
}

export interface OfflinePendingPhoto {
  id?: number;
  entityType: string;
  entityId: string;
  fileName: string;
  blob: Blob;
  createdAt: number;
}

export type QueuedActionState = 'pending' | 'failed' | 'conflict';

export interface OfflineQueuedAction {
  id?: number;
  kind: 'save_goods_receipt';
  /** Same value as the draft's `receiptId`; carried so a retry can never mint a new one. */
  idempotencyKey: string;
  orderId: string;
  orderLabel: string;
  payload: SaveGoodsReceiptPayload;
  observedAt: number;
  attempts: number;
  state: QueuedActionState;
  /** Hebrew, per action. Never "הסנכרון נכשל" — the doc forbids a collective excuse (:90). */
  lastError: string | null;
  /** The server's own code, kept so the conflict screen can pick the right decision. */
  lastErrorCode: string | null;
  lastAttemptAt: number | null;
  createdAt: number;
}

interface OfflineDbSchema extends DBSchema {
  open_orders: { key: string; value: OfflineOpenOrder; indexes: { 'by-fetchedAt': number } };
  receipt_drafts: { key: string; value: OfflineReceiptDraft; indexes: { 'by-updatedAt': number } };
  pending_photos: {
    key: number;
    value: OfflinePendingPhoto;
    indexes: { 'by-entity': [string, string]; 'by-createdAt': number };
  };
  sync_queue: {
    key: number;
    value: OfflineQueuedAction;
    indexes: { 'by-key': string; 'by-createdAt': number };
  };
  sync_meta: { key: string; value: { key: string; value: number | string | null } };
}

/* ============================ schema migration ============================ */

/**
 * The minimum of IndexedDB's upgrade surface this module uses.
 *
 * Declared as an interface so `applyOfflineDbUpgrade` is testable without a browser: jsdom has no
 * IndexedDB at all, and a suite that needed one would either add a shim dependency or not exist.
 * The real engine is exercised where it is real — the browser gate reloads the page mid-receipt and
 * asserts the draft survived.
 */
export interface OfflineUpgradeIndexTarget {
  createIndex(name: string, keyPath: string | string[], options?: { unique?: boolean }): unknown;
}

export interface OfflineUpgradeTarget {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(
    name: string,
    options?: { keyPath?: string; autoIncrement?: boolean },
  ): OfflineUpgradeIndexTarget;
}

/**
 * Creates what version `oldVersion + 1 … OFFLINE_DB_VERSION` requires, and nothing else.
 *
 * Written as explicit version steps rather than "create anything missing" so an upgrade path is
 * readable years later, and so re-opening an up-to-date database provably creates nothing.
 */
export function applyOfflineDbUpgrade(target: OfflineUpgradeTarget, oldVersion: number): string[] {
  const created: string[] = [];
  const store = (name: string, options?: { keyPath?: string; autoIncrement?: boolean }) => {
    if (target.objectStoreNames.contains(name)) return null;
    created.push(name);
    return target.createObjectStore(name, options);
  };

  if (oldVersion < 1) {
    store(OFFLINE_STORES.openOrders, { keyPath: 'orderId' })
      ?.createIndex('by-fetchedAt', 'fetchedAt');
    store(OFFLINE_STORES.receiptDrafts, { keyPath: 'orderId' })
      ?.createIndex('by-updatedAt', 'updatedAt');
    const photos = store(OFFLINE_STORES.pendingPhotos, { keyPath: 'id', autoIncrement: true });
    photos?.createIndex('by-entity', ['entityType', 'entityId']);
    photos?.createIndex('by-createdAt', 'createdAt');
    const queue = store(OFFLINE_STORES.syncQueue, { keyPath: 'id', autoIncrement: true });
    queue?.createIndex('by-key', 'idempotencyKey');
    queue?.createIndex('by-createdAt', 'createdAt');
    // The four stores above are the ones OFFLINE-SYNC-DESIGN.md:42-47 names. `sync_meta` is a
    // fifth, deliberate addition: the same document (:83) requires a REAL last-successful-sync
    // time or `—`, and a real timestamp has to survive a reload like everything else here. It
    // holds one scalar per key and never any business data.
    store(OFFLINE_STORES.syncMeta, { keyPath: 'key' });
  }

  return created;
}

/* ============================ availability ============================ */

/**
 * IndexedDB is missing in some private-browsing modes and in every non-browser runtime.
 *
 * That is not something to swallow: if the device cannot store a draft, the receiving screen must
 * say so rather than let someone walk to the truck believing their work is safe.
 */
export function isOfflineStorageAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

let dbPromise: Promise<IDBPDatabase<OfflineDbSchema>> | null = null;

export function openOfflineDb(): Promise<IDBPDatabase<OfflineDbSchema>> | null {
  if (!isOfflineStorageAvailable()) return null;
  dbPromise ??= openDB<OfflineDbSchema>(OFFLINE_DB_NAME, OFFLINE_DB_VERSION, {
    upgrade(db, oldVersion) {
      applyOfflineDbUpgrade(db as unknown as OfflineUpgradeTarget, oldVersion);
    },
  }).catch((error) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

/** Test seam: drops the cached connection so a suite can reopen a fresh handle. */
export function resetOfflineDbHandle() {
  dbPromise = null;
}

async function withDb<T>(run: (db: IDBPDatabase<OfflineDbSchema>) => Promise<T>, fallback: T): Promise<T> {
  const opening = openOfflineDb();
  if (!opening) return fallback;
  try {
    return await run(await opening);
  } catch (error) {
    console.error('[supplyflow] offline store unavailable', error);
    return fallback;
  }
}

/* ============================ open orders ============================ */

export async function putOpenOrder(entry: OfflineOpenOrder): Promise<void> {
  await withDb(async (db) => { await db.put(OFFLINE_STORES.openOrders, entry); }, undefined);
}

export async function getOpenOrder(orderId: string): Promise<OfflineOpenOrder | null> {
  return withDb(async (db) => (await db.get(OFFLINE_STORES.openOrders, orderId)) ?? null, null);
}

export async function listOpenOrders(): Promise<OfflineOpenOrder[]> {
  return withDb(async (db) => db.getAll(OFFLINE_STORES.openOrders), []);
}

/** Age as a fact, not a verdict: the caller labels it, and nothing here deletes it. */
export function isOpenOrderStale(entry: OfflineOpenOrder, now = Date.now()): boolean {
  return now - entry.fetchedAt > OPEN_ORDER_STALE_AFTER_MS;
}

/* ============================ receipt drafts ============================ */

export async function getReceiptDraft(orderId: string): Promise<OfflineReceiptDraft | null> {
  return withDb(async (db) => (await db.get(OFFLINE_STORES.receiptDrafts, orderId)) ?? null, null);
}

export async function putReceiptDraft(draft: OfflineReceiptDraft): Promise<void> {
  await withDb(async (db) => { await db.put(OFFLINE_STORES.receiptDrafts, draft); }, undefined);
}

export async function deleteReceiptDraft(orderId: string): Promise<void> {
  await withDb(async (db) => { await db.delete(OFFLINE_STORES.receiptDrafts, orderId); }, undefined);
}

export async function listReceiptDrafts(): Promise<OfflineReceiptDraft[]> {
  return withDb(async (db) => db.getAll(OFFLINE_STORES.receiptDrafts), []);
}

/** Orders whose local work has not been accepted by the server yet — the "טיוטה מקומית" marker. */
export async function listUnsyncedDraftOrderIds(): Promise<string[]> {
  const drafts = await listReceiptDrafts();
  return drafts.filter((draft) => draft.syncedAt === null).map((draft) => draft.orderId);
}

/** The two draft operations the key rule needs, so it can be driven without a browser engine. */
export interface ReceiptDraftStore {
  getReceiptDraft(orderId: string): Promise<OfflineReceiptDraft | null>;
  putReceiptDraft(draft: OfflineReceiptDraft): Promise<void>;
}

export const indexedDbDraftStore: ReceiptDraftStore = { getReceiptDraft, putReceiptDraft };

export interface ReceiptKeyResolution {
  receiptId: string;
  keySource: 'server-draft' | 'device';
  /** False when the key could not be stored: the screen must not promise a durable draft. */
  persisted: boolean;
  /** True when this call minted the key rather than reusing a stored one. */
  minted: boolean;
}

/**
 * The persisted-key rule, in one place.
 *
 * `Receiving.tsx:312` used to send `draft.id ?? newReceiptId`, which made the key depend on whether
 * a read succeeded: the same physical receipt could be submitted under one key while online and
 * another after a failed read, and the server would have every right to record it twice.
 *
 * The rule now: **the key is minted once and stored at draft creation.** If a server draft was read
 * successfully, ITS id becomes the key — adopting the row that already exists. If not, a device
 * UUID does. Either way the stored value wins for the life of the receipt, on every later visit,
 * reload and retry.
 */
export async function ensureReceiptKey(input: {
  orderId: string;
  serverDraftId: string | null;
  lines: OfflineReceiptLine[];
  openCredits: boolean;
  notes?: string | null;
  now?: number;
  mintId?: () => string;
  /** Storage seam. Defaults to this module's IndexedDB stores; a suite passes its own. */
  store?: ReceiptDraftStore;
}): Promise<ReceiptKeyResolution> {
  const store = input.store ?? indexedDbDraftStore;
  const existing = await store.getReceiptDraft(input.orderId);
  if (existing) {
    return { receiptId: existing.receiptId, keySource: existing.keySource, persisted: true, minted: false };
  }
  const mint = input.mintId ?? (() => crypto.randomUUID());
  const now = input.now ?? Date.now();
  const receiptId = input.serverDraftId ?? mint();
  const draft: OfflineReceiptDraft = {
    orderId: input.orderId,
    receiptId,
    keySource: input.serverDraftId ? 'server-draft' : 'device',
    lines: input.lines,
    openCredits: input.openCredits,
    notes: input.notes ?? null,
    observedAt: now,
    updatedAt: now,
    syncedAt: null,
    completed: false,
  };
  await store.putReceiptDraft(draft);
  const stored = await store.getReceiptDraft(input.orderId);
  return {
    receiptId,
    keySource: draft.keySource,
    persisted: stored !== null,
    minted: true,
  };
}

/* ============================ pending photos ============================ */

export async function putPendingPhoto(photo: Omit<OfflinePendingPhoto, 'id'>): Promise<void> {
  await withDb(async (db) => { await db.add(OFFLINE_STORES.pendingPhotos, photo as OfflinePendingPhoto); }, undefined);
}

export async function listPendingPhotos(): Promise<OfflinePendingPhoto[]> {
  return withDb(async (db) => db.getAll(OFFLINE_STORES.pendingPhotos), []);
}

export async function deletePendingPhoto(id: number): Promise<void> {
  await withDb(async (db) => { await db.delete(OFFLINE_STORES.pendingPhotos, id); }, undefined);
}

export async function countPendingPhotos(): Promise<number> {
  return withDb(async (db) => db.count(OFFLINE_STORES.pendingPhotos), 0);
}

/* ============================ sync queue ============================ */

export async function enqueueAction(action: Omit<OfflineQueuedAction, 'id'>): Promise<number | null> {
  return withDb(async (db) => {
    const key = await db.add(OFFLINE_STORES.syncQueue, action as OfflineQueuedAction);
    return typeof key === 'number' ? key : null;
  }, null);
}

/** Insertion order is the send order: the autoIncrement key IS the queue position. */
export async function listQueuedActions(): Promise<OfflineQueuedAction[]> {
  const rows = await withDb(async (db) => db.getAll(OFFLINE_STORES.syncQueue), []);
  return rows.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
}

export async function findQueuedActionByKey(idempotencyKey: string): Promise<OfflineQueuedAction | null> {
  return withDb(
    async (db) => (await db.getFromIndex(OFFLINE_STORES.syncQueue, 'by-key', idempotencyKey)) ?? null,
    null,
  );
}

export async function putQueuedAction(action: OfflineQueuedAction): Promise<void> {
  await withDb(async (db) => { await db.put(OFFLINE_STORES.syncQueue, action); }, undefined);
}

export async function deleteQueuedAction(id: number): Promise<void> {
  await withDb(async (db) => { await db.delete(OFFLINE_STORES.syncQueue, id); }, undefined);
}

export async function countQueuedActions(): Promise<number> {
  return withDb(async (db) => db.count(OFFLINE_STORES.syncQueue), 0);
}

/* ============================ sync metadata ============================ */

const LAST_SYNC_KEY = 'lastSuccessfulSyncAt';

export async function getLastSuccessfulSyncAt(): Promise<number | null> {
  return withDb(async (db) => {
    const row = await db.get(OFFLINE_STORES.syncMeta, LAST_SYNC_KEY);
    return typeof row?.value === 'number' ? row.value : null;
  }, null);
}

export async function setLastSuccessfulSyncAt(at: number): Promise<void> {
  await withDb(async (db) => {
    await db.put(OFFLINE_STORES.syncMeta, { key: LAST_SYNC_KEY, value: at });
  }, undefined);
}

/**
 * Everything the sync queue needs from storage, as an interface.
 *
 * The queue is the part with the interesting behaviour (order, retries, per-action reasons), and it
 * has to be testable without a browser engine. Passing this in keeps the production path on real
 * IndexedDB while the suite drives the same logic over a plain Map.
 */
export interface OfflineQueueStore {
  listQueuedActions(): Promise<OfflineQueuedAction[]>;
  putQueuedAction(action: OfflineQueuedAction): Promise<void>;
  deleteQueuedAction(id: number): Promise<void>;
  enqueueAction(action: Omit<OfflineQueuedAction, 'id'>): Promise<number | null>;
  countPendingPhotos(): Promise<number>;
  getLastSuccessfulSyncAt(): Promise<number | null>;
  setLastSuccessfulSyncAt(at: number): Promise<void>;
  getReceiptDraft(orderId: string): Promise<OfflineReceiptDraft | null>;
  putReceiptDraft(draft: OfflineReceiptDraft): Promise<void>;
}

export const indexedDbQueueStore: OfflineQueueStore = {
  listQueuedActions,
  putQueuedAction,
  deleteQueuedAction,
  enqueueAction,
  countPendingPhotos,
  getLastSuccessfulSyncAt,
  setLastSuccessfulSyncAt,
  getReceiptDraft,
  putReceiptDraft,
};
