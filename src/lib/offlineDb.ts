import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Organization, Profile } from './types';
import type { OrganizationAccess } from './trial';

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
export const OFFLINE_DB_VERSION = 2;

/** Downloaded open orders go stale after 24 hours. Stale is DISPLAYED, never silently deleted. */
export const OPEN_ORDER_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export const OFFLINE_STORES = {
  openOrders: 'open_orders_v2',
  receiptDrafts: 'receipt_drafts_v2',
  pendingPhotos: 'pending_photos',
  syncQueue: 'sync_queue',
  syncMeta: 'sync_meta',
} as const;

/** Version-1 stores remain untouched for recovery; production never reads or writes them. */
export const OFFLINE_V1_STORES = {
  openOrders: 'open_orders',
  receiptDrafts: 'receipt_drafts',
} as const;

export interface OfflineScope {
  orgId: string;
  actorUserId: string;
}

export interface OfflineBootstrapContext {
  actorUserId: string;
  orgId: string;
  profile: Profile;
  organization: Organization;
  /** Last server-authoritative lifecycle state. Offline use is explicitly cached/stale UI state. */
  organizationAccess: OrganizationAccess;
  cachedAt: number;
}

/**
 * Version-1 rows have no owner. They stay on disk for recovery, but every production read filters
 * them out: silently claiming old work for whichever user happens to sign in next would falsify
 * both tenant isolation and the actor recorded by `save_goods_receipt`.
 */
interface LegacyCompatibleScope {
  orgId?: string;
  actorUserId?: string;
}

export class OfflineStorageError extends Error {
  constructor(message = 'לא ניתן לשמור את העבודה במכשיר הזה.') {
    super(message);
    this.name = 'OfflineStorageError';
  }
}

type OfflineScopeResolver = () => Promise<OfflineScope | null>;
let resolveOfflineScope: OfflineScopeResolver = async () => null;

/** Wired once by `offlineQueue.ts`; kept injectable so the storage module has no auth dependency. */
export function configureOfflineScopeResolver(resolver: OfflineScopeResolver) {
  resolveOfflineScope = resolver;
}

async function requireOfflineScope(): Promise<OfflineScope> {
  const scope = await resolveOfflineScope();
  if (!scope?.orgId || !scope.actorUserId) {
    throw new OfflineStorageError('לא ניתן לזהות את הארגון והמשתמש עבור השמירה המקומית.');
  }
  return scope;
}

function belongsToScope(row: LegacyCompatibleScope | null | undefined, scope: OfflineScope): boolean {
  return row?.orgId === scope.orgId && row.actorUserId === scope.actorUserId;
}

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

export interface OfflineOpenOrder extends LegacyCompatibleScope {
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

export interface OfflineReceiptDraft extends LegacyCompatibleScope {
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

export type QueuedActionState = 'pending' | 'failed' | 'conflict' | 'needs_attention';

export interface OfflinePendingPhoto extends LegacyCompatibleScope {
  id?: number;
  entityType: string;
  entityId: string;
  fileName: string;
  blob: Blob;
  documentKind?: string;
  /** Stable object-path component. Retries and competing tabs must never mint another path. */
  clientUploadId?: string;
  storagePath?: string | null;
  documentId?: string | null;
  attempts?: number;
  state?: QueuedActionState;
  lastError?: string | null;
  lastAttemptAt?: number | null;
  syncLeaseOwner?: string | null;
  syncLeaseExpiresAt?: number | null;
  createdAt: number;
}

export interface OfflineQueuedAction extends LegacyCompatibleScope {
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
  open_orders_v2: {
    key: [string, string, string];
    value: OfflineOpenOrder;
    indexes: { 'by-fetchedAt': number; 'by-scope': [string, string] };
  };
  receipt_drafts_v2: {
    key: [string, string, string];
    value: OfflineReceiptDraft;
    indexes: { 'by-updatedAt': number; 'by-scope': [string, string] };
  };
  pending_photos: {
    key: number;
    value: OfflinePendingPhoto;
    indexes: {
      'by-entity': [string, string];
      'by-createdAt': number;
      'by-scope': [string, string];
    };
  };
  sync_queue: {
    key: number;
    value: OfflineQueuedAction;
    indexes: {
      'by-key': string;
      'by-createdAt': number;
      'by-scope': [string, string];
      'by-scope-key': [string, string, string];
    };
  };
  sync_meta: {
    key: string;
    value: { key: string; value: number | string | OfflineBootstrapContext | null };
  };
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
    options?: { keyPath?: string | string[]; autoIncrement?: boolean },
  ): OfflineUpgradeIndexTarget;
}

/**
 * Creates what version `oldVersion + 1 … OFFLINE_DB_VERSION` requires, and nothing else.
 *
 * Written as explicit version steps rather than "create anything missing" so an upgrade path is
 * readable years later, and so re-opening an up-to-date database provably creates nothing.
 */
export function applyOfflineDbUpgrade(
  target: OfflineUpgradeTarget,
  oldVersion: number,
  existingStore?: (name: string) => OfflineUpgradeIndexTarget,
): string[] {
  const created: string[] = [];
  const stores = new Map<string, OfflineUpgradeIndexTarget>();
  const store = (name: string, options?: { keyPath?: string | string[]; autoIncrement?: boolean }) => {
    if (target.objectStoreNames.contains(name)) return null;
    created.push(name);
    const createdStore = target.createObjectStore(name, options);
    stores.set(name, createdStore);
    return createdStore;
  };
  const index = (
    storeName: string,
    name: string,
    keyPath: string | string[],
    options?: { unique?: boolean },
  ) => (stores.get(storeName) ?? existingStore?.(storeName))?.createIndex(name, keyPath, options);

  if (oldVersion < 1) {
    store(OFFLINE_V1_STORES.openOrders, { keyPath: 'orderId' })
      ?.createIndex('by-fetchedAt', 'fetchedAt');
    store(OFFLINE_V1_STORES.receiptDrafts, { keyPath: 'orderId' })
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

  if (oldVersion < 2) {
    // IndexedDB cannot change an existing store's keyPath. New stores are therefore required:
    // v1 stays recovery-only, while v2 makes actor and tenant part of the physical primary key.
    const openOrders = store(OFFLINE_STORES.openOrders, {
      keyPath: ['orgId', 'actorUserId', 'orderId'],
    });
    openOrders?.createIndex('by-fetchedAt', 'fetchedAt');
    openOrders?.createIndex('by-scope', ['orgId', 'actorUserId']);
    const drafts = store(OFFLINE_STORES.receiptDrafts, {
      keyPath: ['orgId', 'actorUserId', 'orderId'],
    });
    drafts?.createIndex('by-updatedAt', 'updatedAt');
    drafts?.createIndex('by-scope', ['orgId', 'actorUserId']);
    index(OFFLINE_STORES.pendingPhotos, 'by-scope', ['orgId', 'actorUserId']);
    index(OFFLINE_STORES.syncQueue, 'by-scope', ['orgId', 'actorUserId']);
    index(
      OFFLINE_STORES.syncQueue,
      'by-scope-key',
      ['orgId', 'actorUserId', 'idempotencyKey'],
      { unique: true },
    );
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
    upgrade(db, oldVersion, _newVersion, transaction) {
      applyOfflineDbUpgrade(
        db as unknown as OfflineUpgradeTarget,
        oldVersion,
        (name) => transaction.objectStore(name as (
          'open_orders_v2' | 'receipt_drafts_v2' | 'pending_photos' | 'sync_queue' | 'sync_meta'
        )),
      );
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

async function withDb<T>(run: (db: IDBPDatabase<OfflineDbSchema>) => Promise<T>): Promise<T> {
  const opening = openOfflineDb();
  if (!opening) throw new OfflineStorageError();
  try {
    return await run(await opening);
  } catch (error) {
    console.error('[supplyflow] offline store unavailable', error);
    if (error instanceof OfflineStorageError) throw error;
    throw new OfflineStorageError();
  }
}

const scopeKey = ({ orgId, actorUserId }: OfflineScope) => [orgId, actorUserId] as [string, string];
export const offlineOrderStorageKey = (scope: OfflineScope, orderId: string) => (
  [scope.orgId, scope.actorUserId, orderId] as [string, string, string]
);
const scoped = <T extends LegacyCompatibleScope>(row: T, scope: OfflineScope): T => ({
  ...row,
  orgId: scope.orgId,
  actorUserId: scope.actorUserId,
});

export interface LegacyReceiptRecoveryPreview {
  orderId: string;
  receiptId: string;
  hasDraft: boolean;
  hasOrder: boolean;
  queuedActions: number;
  pendingPhotos: number;
}

function isUnscoped(row: LegacyCompatibleScope) {
  return row.orgId === undefined && row.actorUserId === undefined;
}

export function legacyReceiptRecoveryPlan(
  orderId: string,
  draft: OfflineReceiptDraft | undefined,
  order: OfflineOpenOrder | undefined,
  actions: readonly OfflineQueuedAction[],
  photos: readonly OfflinePendingPhoto[],
) {
  const legacyDraft = draft && isUnscoped(draft) && draft.orderId === orderId ? draft : undefined;
  const legacyActions = actions.filter((action) => isUnscoped(action) && action.orderId === orderId);
  const receiptId = legacyDraft?.receiptId ?? legacyActions[0]?.idempotencyKey;
  if (!receiptId) return null;
  return {
    draft: legacyDraft,
    order: order && isUnscoped(order) && order.orderId === orderId ? order : undefined,
    actions: legacyActions.filter((action) => action.idempotencyKey === receiptId),
    photos: photos.filter((photo) => isUnscoped(photo)
      && photo.entityType === 'goods_receipt' && photo.entityId === receiptId),
    preview: {
      orderId,
      receiptId,
      hasDraft: !!legacyDraft,
      hasOrder: !!order && isUnscoped(order) && order.orderId === orderId,
      queuedActions: legacyActions.filter((action) => action.idempotencyKey === receiptId).length,
      pendingPhotos: photos.filter((photo) => isUnscoped(photo)
        && photo.entityType === 'goods_receipt' && photo.entityId === receiptId).length,
    } satisfies LegacyReceiptRecoveryPreview,
  };
}

/**
 * Read-only probe. Callers may show it only after a live, RLS-protected read proved access to the
 * order; v1 rows have no actor or tenant and are never claimed merely because somebody signed in.
 */
export async function inspectLegacyReceiptRecovery(
  orderId: string,
): Promise<LegacyReceiptRecoveryPreview | null> {
  return withDb(async (db) => {
    const [draft, order, actions, photos] = await Promise.all([
      db.get(OFFLINE_V1_STORES.receiptDrafts, orderId),
      db.get(OFFLINE_V1_STORES.openOrders, orderId),
      db.getAll(OFFLINE_STORES.syncQueue),
      db.getAll(OFFLINE_STORES.pendingPhotos),
    ]);
    return legacyReceiptRecoveryPlan(orderId, draft, order, actions, photos)?.preview ?? null;
  });
}

/** Explicitly claims one legacy receipt after the user confirmed it is their work. */
export async function claimLegacyReceiptRecovery(orderId: string): Promise<boolean> {
  const scope = await requireOfflineScope();
  return withDb(async (db) => {
    const tx = db.transaction([
      OFFLINE_V1_STORES.openOrders,
      OFFLINE_V1_STORES.receiptDrafts,
      OFFLINE_STORES.openOrders,
      OFFLINE_STORES.receiptDrafts,
      OFFLINE_STORES.syncQueue,
      OFFLINE_STORES.pendingPhotos,
    ], 'readwrite');
    const legacyDrafts = tx.objectStore(OFFLINE_V1_STORES.receiptDrafts);
    const legacyOrders = tx.objectStore(OFFLINE_V1_STORES.openOrders);
    const scopedDrafts = tx.objectStore(OFFLINE_STORES.receiptDrafts);
    const scopedOrders = tx.objectStore(OFFLINE_STORES.openOrders);
    const queue = tx.objectStore(OFFLINE_STORES.syncQueue);
    const photos = tx.objectStore(OFFLINE_STORES.pendingPhotos);
    const [draft, order, currentDraft, currentOrder, actions, pendingPhotos] = await Promise.all([
      legacyDrafts.get(orderId),
      legacyOrders.get(orderId),
      scopedDrafts.get(offlineOrderStorageKey(scope, orderId)),
      scopedOrders.get(offlineOrderStorageKey(scope, orderId)),
      queue.getAll(),
      photos.getAll(),
    ]);
    const plan = legacyReceiptRecoveryPlan(orderId, draft, order, actions, pendingPhotos);
    if (!plan) {
      await tx.done;
      return false;
    }
    if (currentDraft) {
      throw new OfflineStorageError('כבר קיימת במכשיר טיוטה חדשה יותר להזמנה הזאת. השחזור לא בוצע.');
    }

    const existing = await queue.index('by-scope-key')
      .get([scope.orgId, scope.actorUserId, plan.preview.receiptId]);
    if (existing) {
      throw new OfflineStorageError('כבר קיימת במכשיר פעולה משויכת לקבלה הזאת. השחזור לא בוצע.');
    }

    if (!currentOrder && plan.order) await scopedOrders.put(scoped(plan.order, scope));
    const recoveredDraft = plan.draft ?? (plan.actions[0] ? {
      orderId,
      receiptId: plan.actions[0].idempotencyKey,
      keySource: 'device' as const,
      lines: plan.actions[0].payload.p_lines,
      openCredits: plan.actions[0].payload.p_open_credits,
      notes: plan.actions[0].payload.p_notes,
      observedAt: plan.actions[0].observedAt,
      updatedAt: plan.actions[0].createdAt,
      syncedAt: null,
      completed: false,
    } : null);
    if (recoveredDraft) await scopedDrafts.put(scoped(recoveredDraft, scope));
    for (const action of plan.actions) await queue.put(scoped(action, scope));
    for (const photo of plan.photos) await photos.put(scoped(photo, scope));
    await legacyOrders.delete(orderId);
    await legacyDrafts.delete(orderId);
    await tx.done;
    return true;
  });
}

/* ============================ open orders ============================ */

export async function putOpenOrder(entry: OfflineOpenOrder): Promise<void> {
  const scope = await requireOfflineScope();
  await withDb(async (db) => { await db.put(OFFLINE_STORES.openOrders, scoped(entry, scope)); });
}

export async function getOpenOrder(orderId: string): Promise<OfflineOpenOrder | null> {
  const scope = await requireOfflineScope();
  return withDb(async (db) => {
    const row = await db.get(OFFLINE_STORES.openOrders, offlineOrderStorageKey(scope, orderId));
    return belongsToScope(row, scope) ? row ?? null : null;
  });
}

export async function listOpenOrders(): Promise<OfflineOpenOrder[]> {
  const scope = await requireOfflineScope();
  return withDb(async (db) => db.getAllFromIndex(OFFLINE_STORES.openOrders, 'by-scope', scopeKey(scope)));
}

export async function deleteOpenOrder(orderId: string): Promise<void> {
  const scope = await requireOfflineScope();
  await withDb(async (db) => {
    const key = offlineOrderStorageKey(scope, orderId);
    const row = await db.get(OFFLINE_STORES.openOrders, key);
    if (belongsToScope(row, scope)) await db.delete(OFFLINE_STORES.openOrders, key);
  });
}

/** Age as a fact, not a verdict: the caller labels it, and nothing here deletes it. */
export function isOpenOrderStale(entry: OfflineOpenOrder, now = Date.now()): boolean {
  return now - entry.fetchedAt > OPEN_ORDER_STALE_AFTER_MS;
}

/* ============================ receipt drafts ============================ */

export async function getReceiptDraft(orderId: string): Promise<OfflineReceiptDraft | null> {
  const scope = await requireOfflineScope();
  return withDb(async (db) => {
    const row = await db.get(OFFLINE_STORES.receiptDrafts, offlineOrderStorageKey(scope, orderId));
    return belongsToScope(row, scope) ? row ?? null : null;
  });
}

export async function putReceiptDraft(draft: OfflineReceiptDraft): Promise<void> {
  const scope = await requireOfflineScope();
  await withDb(async (db) => { await db.put(OFFLINE_STORES.receiptDrafts, scoped(draft, scope)); });
}

export async function deleteReceiptDraft(orderId: string): Promise<void> {
  const scope = await requireOfflineScope();
  await withDb(async (db) => {
    const key = offlineOrderStorageKey(scope, orderId);
    const row = await db.get(OFFLINE_STORES.receiptDrafts, key);
    if (belongsToScope(row, scope)) await db.delete(OFFLINE_STORES.receiptDrafts, key);
  });
}

export async function listReceiptDrafts(): Promise<OfflineReceiptDraft[]> {
  const scope = await requireOfflineScope();
  return withDb(async (db) => db.getAllFromIndex(OFFLINE_STORES.receiptDrafts, 'by-scope', scopeKey(scope)));
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
  const scope = await requireOfflineScope();
  await withDb(async (db) => {
    await db.add(OFFLINE_STORES.pendingPhotos, scoped(photo, scope) as OfflinePendingPhoto);
  });
}

export async function listPendingPhotos(): Promise<OfflinePendingPhoto[]> {
  const scope = await requireOfflineScope();
  return withDb(async (db) => (
    db.getAllFromIndex(OFFLINE_STORES.pendingPhotos, 'by-scope', scopeKey(scope))
  ));
}

export const PENDING_PHOTO_SYNC_LEASE_MS = 15 * 60 * 1000;

export function pendingPhotoCanBeClaimed(
  photo: OfflinePendingPhoto,
  leaseOwner: string,
  now: number,
  includeNeedsAttention: boolean,
) {
  if (photo.state === 'needs_attention' && !includeNeedsAttention) return false;
  return !photo.syncLeaseOwner
    || photo.syncLeaseOwner === leaseOwner
    || (photo.syncLeaseExpiresAt ?? 0) <= now;
}

/**
 * Atomically claims this actor's upload rows. IndexedDB serializes readwrite transactions on the
 * same object store across tabs, so only one tab can observe and lease a row at a time. Expiry
 * recovers a row after a crashed tab; clientUploadId still fixes its storage path across retries.
 */
export async function claimPendingPhotos(
  leaseOwner: string,
  includeNeedsAttention: boolean,
  now = Date.now(),
): Promise<OfflinePendingPhoto[]> {
  const scope = await requireOfflineScope();
  return withDb(async (db) => {
    const tx = db.transaction(OFFLINE_STORES.pendingPhotos, 'readwrite');
    const rows = await tx.store.index('by-scope').getAll(scopeKey(scope));
    const claimed: OfflinePendingPhoto[] = [];
    for (const row of rows) {
      if (row.id == null || !pendingPhotoCanBeClaimed(row, leaseOwner, now, includeNeedsAttention)) continue;
      const leased = {
        ...row,
        syncLeaseOwner: leaseOwner,
        syncLeaseExpiresAt: now + PENDING_PHOTO_SYNC_LEASE_MS,
      };
      await tx.store.put(leased);
      claimed.push(leased);
    }
    await tx.done;
    return claimed;
  });
}

export async function updatePendingPhoto(
  id: number,
  patch: Pick<OfflinePendingPhoto,
    'storagePath' | 'documentId' | 'attempts' | 'state' | 'lastError' | 'lastAttemptAt'
    | 'syncLeaseOwner' | 'syncLeaseExpiresAt'>,
  leaseOwner?: string,
): Promise<void> {
  const scope = await requireOfflineScope();
  await withDb(async (db) => {
    const tx = db.transaction(OFFLINE_STORES.pendingPhotos, 'readwrite');
    const row = await tx.store.get(id);
    if (!row || !belongsToScope(row, scope)) {
      throw new OfflineStorageError();
    }
    if (leaseOwner && row.syncLeaseOwner !== leaseOwner) {
      throw new OfflineStorageError('הסנכרון הועבר לחלון אחר. הנתונים המקומיים לא שונו.');
    }
    await tx.store.put({ ...row, ...patch });
    await tx.done;
  });
}

export async function deletePendingPhoto(id: number, leaseOwner?: string): Promise<void> {
  const scope = await requireOfflineScope();
  await withDb(async (db) => {
    const row = await db.get(OFFLINE_STORES.pendingPhotos, id);
    if (belongsToScope(row, scope) && (!leaseOwner || row?.syncLeaseOwner === leaseOwner)) {
      await db.delete(OFFLINE_STORES.pendingPhotos, id);
    }
  });
}

export async function countPendingPhotos(): Promise<number> {
  const scope = await requireOfflineScope();
  return withDb(async (db) => (
    db.countFromIndex(OFFLINE_STORES.pendingPhotos, 'by-scope', scopeKey(scope))
  ));
}

/* ============================ sync queue ============================ */

export async function enqueueAction(action: Omit<OfflineQueuedAction, 'id'>): Promise<number> {
  const scope = await requireOfflineScope();
  return withDb(async (db) => {
    const key = await db.add(
      OFFLINE_STORES.syncQueue,
      scoped(action, scope) as OfflineQueuedAction,
    );
    if (typeof key !== 'number') throw new OfflineStorageError();
    return key;
  });
}

/** Insertion order is the send order: the autoIncrement key IS the queue position. */
export async function listQueuedActions(): Promise<OfflineQueuedAction[]> {
  const scope = await requireOfflineScope();
  const rows = await withDb(async (db) => (
    db.getAllFromIndex(OFFLINE_STORES.syncQueue, 'by-scope', scopeKey(scope))
  ));
  return rows.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
}

export async function findQueuedActionByKey(idempotencyKey: string): Promise<OfflineQueuedAction | null> {
  const scope = await requireOfflineScope();
  return withDb(async (db) => (
    await db.getFromIndex(
      OFFLINE_STORES.syncQueue,
      'by-scope-key',
      [scope.orgId, scope.actorUserId, idempotencyKey],
    )
  ) ?? null);
}

export async function putQueuedAction(action: OfflineQueuedAction): Promise<void> {
  const scope = await requireOfflineScope();
  if (!belongsToScope(action, scope)) {
    throw new OfflineStorageError('לא ניתן לעדכן פעולה מקומית ששייכת למשתמש או לארגון אחר.');
  }
  await withDb(async (db) => { await db.put(OFFLINE_STORES.syncQueue, action); });
}

export async function deleteQueuedAction(id: number): Promise<void> {
  const scope = await requireOfflineScope();
  await withDb(async (db) => {
    const row = await db.get(OFFLINE_STORES.syncQueue, id);
    if (belongsToScope(row, scope)) await db.delete(OFFLINE_STORES.syncQueue, id);
  });
}

export async function countQueuedActions(): Promise<number> {
  const scope = await requireOfflineScope();
  return withDb(async (db) => (
    db.countFromIndex(OFFLINE_STORES.syncQueue, 'by-scope', scopeKey(scope))
  ));
}

/* ============================ sync metadata ============================ */

const LAST_SYNC_KEY = 'lastSuccessfulSyncAt';
const SCOPE_KEY_PREFIX = 'scope:';
const BOOTSTRAP_KEY_PREFIX = 'bootstrap:';

const lastSyncKey = ({ orgId, actorUserId }: OfflineScope) => (
  `${LAST_SYNC_KEY}:${orgId}:${actorUserId}`
);

/**
 * Keeps only the actor -> organization binding needed to reopen an existing receipt while offline.
 * It is not used as authorization: every send still requires a live session for the same actor,
 * and the RPC remains protected by its server-side scope checks.
 */
export async function rememberOfflineScope(scope: OfflineScope): Promise<void> {
  await withDb(async (db) => {
    await db.put(OFFLINE_STORES.syncMeta, {
      key: `${SCOPE_KEY_PREFIX}${scope.actorUserId}`,
      value: scope.orgId,
    });
  });
}

export async function getRememberedOfflineScope(actorUserId: string): Promise<OfflineScope | null> {
  return withDb(async (db) => {
    const row = await db.get(OFFLINE_STORES.syncMeta, `${SCOPE_KEY_PREFIX}${actorUserId}`);
    return typeof row?.value === 'string' && row.value.length > 0
      ? { actorUserId, orgId: row.value }
      : null;
  });
}

export async function rememberOfflineBootstrap(context: OfflineBootstrapContext): Promise<void> {
  await withDb(async (db) => {
    await db.put(OFFLINE_STORES.syncMeta, {
      key: `${BOOTSTRAP_KEY_PREFIX}${context.actorUserId}`,
      value: context,
    });
  });
}

export async function getRememberedOfflineBootstrap(
  actorUserId: string,
): Promise<OfflineBootstrapContext | null> {
  return withDb(async (db) => {
    const row = await db.get(OFFLINE_STORES.syncMeta, `${BOOTSTRAP_KEY_PREFIX}${actorUserId}`);
    const value = row?.value;
    return typeof value === 'object' && value !== null
      && value.actorUserId === actorUserId && value.profile.id === actorUserId
      && value.profile.org_id === value.orgId && value.organization.id === value.orgId
      ? value
      : null;
  });
}

export async function getLastSuccessfulSyncAt(): Promise<number | null> {
  const scope = await requireOfflineScope();
  return withDb(async (db) => {
    const row = await db.get(OFFLINE_STORES.syncMeta, lastSyncKey(scope));
    return typeof row?.value === 'number' ? row.value : null;
  });
}

export async function setLastSuccessfulSyncAt(at: number): Promise<void> {
  const scope = await requireOfflineScope();
  await withDb(async (db) => {
    await db.put(OFFLINE_STORES.syncMeta, { key: lastSyncKey(scope), value: at });
  });
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
  enqueueAction(action: Omit<OfflineQueuedAction, 'id'>): Promise<number>;
  countPendingPhotos(): Promise<number>;
  getLastSuccessfulSyncAt(): Promise<number | null>;
  setLastSuccessfulSyncAt(at: number): Promise<void>;
  getReceiptDraft(orderId: string): Promise<OfflineReceiptDraft | null>;
  putReceiptDraft(draft: OfflineReceiptDraft): Promise<void>;
  deleteReceiptDraft(orderId: string): Promise<void>;
  deleteOpenOrder(orderId: string): Promise<void>;
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
  deleteReceiptDraft,
  deleteOpenOrder,
};
