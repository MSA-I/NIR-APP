import { useSyncExternalStore } from 'react';
import { supabase } from './supabase';
import { unwrap } from './useQuery';
import { toHebrewError } from './errors';
import { BUSINESS_TIME_ZONE } from './format';
import {
  indexedDbQueueStore,
  isOfflineStorageAvailable,
  type OfflineQueueStore,
  type OfflineQueuedAction,
  type SaveGoodsReceiptPayload,
} from './offlineDb';

/**
 * The goods-receiving sync queue (`OFFLINE-SYNC-DESIGN.md` §4-§6, ADR-0006).
 *
 * It sends the *same* `save_goods_receipt` argument object the screen sends when online — one RPC,
 * one contract, no offline-only server path — and it carries the receipt's persisted idempotency
 * key on every attempt, so a lost response is answered with the same receipt instead of a second
 * one (`0023:1472-1503`).
 *
 * Three properties are load-bearing and each is a rule from the design document:
 *  - **Continue after failure** (`uploadBatch.ts:40-56` pattern): one bad action does not stop the
 *    rest, and a retry can then contain only what actually failed.
 *  - **A Hebrew reason per action**, never a collective "הסנכרון נכשל" (:90). Nobody standing at a
 *    truck can act on a sentence that does not say which receipt failed or why.
 *  - **An expired session sends nothing.** The draft is kept and the person is asked to sign in
 *    (:97-98). Sending business writes with stale credentials is how a queue turns into a
 *    permission bypass, and RLS is not weakened for convenience.
 *
 * There is **no service worker involved**: this is plain JS plus IndexedDB. App-shell precaching is
 * a separate, deliberately deferred decision (OPEN-DECISIONS #101), and its absence is stated out
 * loud rather than papered over: a reload while offline loses the shell; the queue survives it.
 */

/* ============================ conflict codes ============================ */

/**
 * The five rejections `save_goods_receipt` can answer a queued receipt with. Every one of them is a
 * decision for a person, not something a retry loop can fix by trying harder.
 */
export const RECEIPT_CONFLICT_CODES = [
  // The likeliest by far: 'full' must equal the remaining quantity EXACTLY (0023:1518), and
  // somebody else received against this order while the device was offline.
  'receipt_qty_exceeds_order',
  'receipt_draft_conflict',
  'receipt_already_completed',
  'receipt_idempotency_conflict',
  'purchase_order_not_receivable',
] as const;

export type ReceiptConflictCode = typeof RECEIPT_CONFLICT_CODES[number];

/** Matched on the message, exactly like `toHebrewError`: PostgREST gives supabase-js no stable code. */
export function receiptConflictCode(error: unknown): ReceiptConflictCode | null {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  return RECEIPT_CONFLICT_CODES.find((code) => raw.includes(code)) ?? null;
}

const NETWORK_PATTERN =
  /Failed to fetch|NetworkError|ERR_NETWORK|ERR_INTERNET_DISCONNECTED|fetch failed|Load failed|network error|net::ERR/i;

/** A transport failure is worth queueing; a business rejection is not. */
export function isTransportFailure(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  return NETWORK_PATTERN.test(raw);
}

/* ============================ the audited reason (#100) ============================ */

const clockFormat = new Intl.DateTimeFormat('he-IL', {
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: BUSINESS_TIME_ZONE,
});

export const receiptClock = (at: number) => clockFormat.format(new Date(at));

/**
 * The observed device time travels in the **reason**, not in the signature (OPEN-DECISIONS #100).
 *
 * A receipt entered at 08:14 and synced at 14:02 is stored with `received_at = now()` (`0023:1645`),
 * which is the sync time. That gap is a real truth gap, and this is where it is told: the audited
 * reason names both clocks, in the same transaction as the command, with zero schema change and
 * zero change to a 300-line financial function's signature.
 *
 * The clause appears **only when the two clocks differ**. A save that goes straight to the server is
 * observed and synced in the same act, so its reason stays exactly the system-authored base string —
 * which is also what the existing browser-gate assertion reads.
 */
export function receiptAuditReason(base: string, observedAt: number, syncedAt: number): string {
  const observed = receiptClock(observedAt);
  const synced = receiptClock(syncedAt);
  if (observed === synced) return base;
  return `${base} · נרשמה במכשיר ${observed} · סונכרנה ${synced}`;
}

/* ============================ snapshot ============================ */

export interface OfflineQueueActionView {
  id: number;
  orderId: string;
  orderLabel: string;
  idempotencyKey: string;
  complete: boolean;
  attempts: number;
  state: OfflineQueuedAction['state'];
  reason: string | null;
  conflictCode: ReceiptConflictCode | null;
  observedAt: number;
}

export interface OfflineQueueSnapshot {
  /** Two counters, deliberately separate (`OFFLINE-SYNC-DESIGN.md:84`). */
  pendingActions: number;
  pendingUploads: number;
  /** Real epoch ms of the last accepted write, or null — which the UI renders as `—`, never "now". */
  lastSuccessfulSyncAt: number | null;
  syncing: boolean;
  online: boolean;
  /** True when a send was withheld because the session is gone. The draft is still stored. */
  sessionExpired: boolean;
  storageAvailable: boolean;
  actions: OfflineQueueActionView[];
}

const EMPTY_SNAPSHOT: OfflineQueueSnapshot = {
  pendingActions: 0,
  pendingUploads: 0,
  lastSuccessfulSyncAt: null,
  syncing: false,
  online: true,
  sessionExpired: false,
  storageAvailable: false,
  actions: [],
};

export type SubmitReceiptOutcome =
  | { kind: 'sent'; receiptId: string; result: { receipt_id: string } }
  | { kind: 'queued'; reason: string }
  | { kind: 'conflict'; code: ReceiptConflictCode; message: string }
  | { kind: 'rejected'; message: string };

export interface SubmitReceiptInput {
  orderId: string;
  orderLabel: string;
  payload: SaveGoodsReceiptPayload;
  /** Device clock at the moment the person recorded the goods. */
  observedAt: number;
}

export interface OfflineQueueDeps {
  store: OfflineQueueStore;
  send: (payload: SaveGoodsReceiptPayload) => Promise<{ receipt_id: string }>;
  hasUsableSession: () => Promise<boolean>;
  isOnline: () => boolean;
  now: () => number;
  storageAvailable: () => boolean;
}

export interface OfflineQueue {
  getSnapshot: () => OfflineQueueSnapshot;
  subscribe: (listener: () => void) => () => void;
  refresh: () => Promise<OfflineQueueSnapshot>;
  submitReceipt: (input: SubmitReceiptInput) => Promise<SubmitReceiptOutcome>;
  /** Manual retry — what the design document mandates (:85). */
  sync: () => Promise<OfflineQueueSnapshot>;
  /** Drops one action after a human decided its fate on the conflict screen. */
  discardAction: (id: number) => Promise<void>;
  /** Wires the auto-resume listener. Idempotent. */
  start: () => void;
  stop: () => void;
}

/* ============================ implementation ============================ */

export function createOfflineQueue(deps: OfflineQueueDeps): OfflineQueue {
  let snapshot: OfflineQueueSnapshot = { ...EMPTY_SNAPSHOT, storageAvailable: deps.storageAvailable() };
  const listeners = new Set<() => void>();
  let syncing = false;
  let sessionExpired = false;
  let started = false;
  let onlineListener: (() => void) | null = null;

  const emit = () => { for (const listener of listeners) listener(); };

  const view = (action: OfflineQueuedAction): OfflineQueueActionView => ({
    id: action.id ?? 0,
    orderId: action.orderId,
    orderLabel: action.orderLabel,
    idempotencyKey: action.idempotencyKey,
    complete: action.payload.p_complete,
    attempts: action.attempts,
    state: action.state,
    reason: action.lastError,
    conflictCode: action.lastErrorCode
      ? RECEIPT_CONFLICT_CODES.find((code) => code === action.lastErrorCode) ?? null
      : null,
    observedAt: action.observedAt,
  });

  async function refresh(): Promise<OfflineQueueSnapshot> {
    const [actions, pendingUploads, lastSuccessfulSyncAt] = await Promise.all([
      deps.store.listQueuedActions(),
      deps.store.countPendingPhotos(),
      deps.store.getLastSuccessfulSyncAt(),
    ]);
    snapshot = {
      pendingActions: actions.length,
      pendingUploads,
      lastSuccessfulSyncAt,
      syncing,
      online: deps.isOnline(),
      sessionExpired,
      storageAvailable: deps.storageAvailable(),
      actions: actions.map(view),
    };
    emit();
    return snapshot;
  }

  async function markDraftSynced(action: OfflineQueuedAction, at: number) {
    const draft = await deps.store.getReceiptDraft(action.orderId);
    if (!draft || draft.receiptId !== action.idempotencyKey) return;
    await deps.store.putReceiptDraft({
      ...draft,
      syncedAt: at,
      completed: draft.completed || action.payload.p_complete,
      updatedAt: at,
    });
  }

  async function enqueue(input: SubmitReceiptInput, reason: string): Promise<void> {
    const existing = (await deps.store.listQueuedActions())
      .find((action) => action.idempotencyKey === input.payload.p_receipt_id);
    const now = deps.now();
    if (existing) {
      // One receipt, one queue entry: the newest local state for this key replaces the older one.
      // Two entries under one key would send the same receipt twice and invite the server's own
      // idempotency comparison to reject the second as a conflict.
      await deps.store.putQueuedAction({
        ...existing,
        payload: input.payload,
        observedAt: input.observedAt,
        orderLabel: input.orderLabel,
        state: 'pending',
        lastError: reason,
        lastErrorCode: null,
        lastAttemptAt: now,
      });
      return;
    }
    await deps.store.enqueueAction({
      kind: 'save_goods_receipt',
      idempotencyKey: input.payload.p_receipt_id,
      orderId: input.orderId,
      orderLabel: input.orderLabel,
      payload: input.payload,
      observedAt: input.observedAt,
      attempts: 0,
      state: 'pending',
      lastError: reason,
      lastErrorCode: null,
      lastAttemptAt: null,
      createdAt: now,
    });
  }

  async function submitReceipt(input: SubmitReceiptInput): Promise<SubmitReceiptOutcome> {
    if (!deps.isOnline()) {
      const reason = 'אין חיבור לרשת. הקבלה נשמרה במכשיר ותישלח כשהחיבור יחזור.';
      await enqueue(input, reason);
      await refresh();
      return { kind: 'queued', reason };
    }
    if (!(await deps.hasUsableSession())) {
      // The draft is kept and NOTHING is sent: stale credentials never carry a business write.
      sessionExpired = true;
      const reason = 'פג תוקף החיבור. הקבלה נשמרה במכשיר ותישלח לאחר התחברות מחדש.';
      await enqueue(input, reason);
      await refresh();
      return { kind: 'queued', reason };
    }
    sessionExpired = false;
    const sentAt = deps.now();
    try {
      // Observed and synced are the same act on this path, so the reason stays the base string.
      const result = await deps.send({
        ...input.payload,
        p_reason: receiptAuditReason(input.payload.p_reason, sentAt, sentAt),
      });
      const stored = (await deps.store.listQueuedActions())
        .find((action) => action.idempotencyKey === input.payload.p_receipt_id);
      if (stored?.id != null) await deps.store.deleteQueuedAction(stored.id);
      await markDraftSynced(
        {
          kind: 'save_goods_receipt',
          idempotencyKey: input.payload.p_receipt_id,
          orderId: input.orderId,
          orderLabel: input.orderLabel,
          payload: input.payload,
          observedAt: input.observedAt,
          attempts: 0,
          state: 'pending',
          lastError: null,
          lastErrorCode: null,
          lastAttemptAt: null,
          createdAt: sentAt,
        },
        sentAt,
      );
      await deps.store.setLastSuccessfulSyncAt(sentAt);
      await refresh();
      return { kind: 'sent', receiptId: result.receipt_id, result };
    } catch (error) {
      const conflict = receiptConflictCode(error);
      if (conflict) {
        // Nothing to retry blindly: a human has to decide. The local draft stays where it is.
        await refresh();
        return { kind: 'conflict', code: conflict, message: toHebrewError(error) };
      }
      if (isTransportFailure(error)) {
        const reason = 'השליחה נכשלה בגלל תקלת רשת. הקבלה נשמרה במכשיר ותישלח בניסיון הבא.';
        await enqueue(input, reason);
        await refresh();
        return { kind: 'queued', reason };
      }
      await refresh();
      return { kind: 'rejected', message: toHebrewError(error) };
    }
  }

  async function sync(): Promise<OfflineQueueSnapshot> {
    if (syncing) return snapshot;
    if (!deps.isOnline()) return refresh();
    if (!(await deps.hasUsableSession())) {
      sessionExpired = true;
      return refresh();
    }
    sessionExpired = false;
    syncing = true;
    await refresh();
    try {
      const actions = await deps.store.listQueuedActions();
      for (const action of actions) {
        // A conflict is a pending human decision, not a transport problem. Re-sending it would
        // just re-collect the same rejection and bury the decision under attempt counters.
        if (action.state === 'conflict' || action.id == null) continue;
        const sentAt = deps.now();
        try {
          await deps.send({
            ...action.payload,
            p_reason: receiptAuditReason(action.payload.p_reason, action.observedAt, sentAt),
          });
          await deps.store.deleteQueuedAction(action.id);
          await markDraftSynced(action, sentAt);
          await deps.store.setLastSuccessfulSyncAt(sentAt);
        } catch (error) {
          // Continue after failure (the runUploadBatch rule): every remaining action still gets
          // its turn, and each keeps its own reason so a retry targets only what failed.
          const conflict = receiptConflictCode(error);
          await deps.store.putQueuedAction({
            ...action,
            attempts: action.attempts + 1,
            state: conflict ? 'conflict' : 'failed',
            lastError: toHebrewError(error),
            lastErrorCode: conflict,
            lastAttemptAt: sentAt,
          });
        }
      }
    } finally {
      syncing = false;
    }
    return refresh();
  }

  function start() {
    if (started || typeof window === 'undefined') return;
    started = true;
    // Auto-resume on `online` is an EXTENSION beyond OFFLINE-SYNC-DESIGN.md, which mandates only a
    // manual retry. It follows the precedent already in the product (`UploadCenter.tsx:218-230`,
    // "the queue waits and says so; it resumes by itself when the network returns"), and the manual
    // button stays: automatic resume must never be the only way for someone to make progress.
    onlineListener = () => { void sync(); };
    window.addEventListener('online', onlineListener);
    void refresh();
  }

  function stop() {
    if (onlineListener) window.removeEventListener('online', onlineListener);
    onlineListener = null;
    started = false;
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    refresh,
    submitReceipt,
    sync,
    discardAction: async (id: number) => {
      await deps.store.deleteQueuedAction(id);
      await refresh();
    },
    start,
    stop,
  };
}

/* ============================ the app's instance ============================ */

async function hasUsableSession(): Promise<boolean> {
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session) return false;
    const expiresAt = data.session.expires_at ? data.session.expires_at * 1000 : null;
    return expiresAt === null || expiresAt > Date.now();
  } catch {
    return false;
  }
}

export const offlineQueue = createOfflineQueue({
  store: indexedDbQueueStore,
  send: async (payload) => unwrap(await supabase.rpc('save_goods_receipt', payload)) as { receipt_id: string },
  hasUsableSession,
  isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
  now: () => Date.now(),
  storageAvailable: isOfflineStorageAvailable,
});

/** Live snapshot for the offline status strip. */
export function useOfflineQueue(): OfflineQueueSnapshot {
  return useSyncExternalStore(
    (listener) => {
      offlineQueue.start();
      return offlineQueue.subscribe(listener);
    },
    offlineQueue.getSnapshot,
    () => EMPTY_SNAPSHOT,
  );
}

/** Counts that decide whether logging out would abandon work. */
export async function pendingOfflineWork(): Promise<{ actions: number; uploads: number }> {
  const snapshot = await offlineQueue.refresh();
  return { actions: snapshot.pendingActions, uploads: snapshot.pendingUploads };
}
