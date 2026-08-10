import { useSyncExternalStore } from 'react';
import { supabase } from './supabase';
import { unwrap } from './useQuery';
import { toHebrewError } from './errors';
import { BUSINESS_TIME_ZONE } from './format';
import {
  configureOfflineScopeResolver,
  getRememberedOfflineScope,
  indexedDbQueueStore,
  isOfflineStorageAvailable,
  OfflineStorageError,
  rememberOfflineScope,
  type OfflineScope,
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
 * The queue itself is plain JS plus IndexedDB. The service worker caches only the static app shell;
 * no API response or business data is cached, and every queued write still crosses the live RPC.
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

const PERMANENT_SCOPE_PATTERN =
  /not_authorized|organization_not_active|profile_inactive|permission denied|row-level security|invalid jwt|jwt expired|PGRST301|42501|\b401\b|\b403\b/i;

/** Authorization/scope failures need intervention; retrying them on every reconnect cannot help. */
export function isPermanentQueueFailure(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  return PERMANENT_SCOPE_PATTERN.test(`${code} ${raw}`);
}

function localStorageMessage(error: unknown): string {
  return error instanceof OfflineStorageError
    ? error.message
    : 'לא ניתן לשמור את הקבלה במכשיר. הפעולה לא הוכנסה לתור.';
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
  syncVersion: number;
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
  /** A fresh check; called immediately before every network write. */
  getUsableActorId: () => Promise<string | null>;
  /** Scope for local persistence. May come from the actor's remembered offline binding. */
  resolveScope: () => Promise<OfflineScope | null>;
  isOnline: () => boolean;
  now: () => number;
  storageAvailable: () => boolean;
  /** Stable for one queue instance/tab; tests set it to make lease races explicit. */
  workerId?: string;
}

export interface OfflineQueue {
  getSnapshot: () => OfflineQueueSnapshot;
  subscribe: (listener: () => void) => () => void;
  refresh: () => Promise<OfflineQueueSnapshot>;
  submitReceipt: (input: SubmitReceiptInput) => Promise<SubmitReceiptOutcome>;
  /** Manual retry — what the design document mandates (:85). */
  sync: () => Promise<OfflineQueueSnapshot>;
  /** Drops one action after a human decided its fate on the conflict screen. */
  discardAction: (
    id: number,
    expectedSyncVersion: number,
    expectedState: OfflineQueuedAction['state'],
  ) => Promise<boolean>;
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
  const leaseOwner = deps.workerId ?? (
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `offline-queue-${Math.random().toString(36).slice(2)}`
  );

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
    syncVersion: action.syncVersion ?? 0,
  });

  async function refresh(): Promise<OfflineQueueSnapshot> {
    try {
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
    } catch (error) {
      console.error('[supplyflow] failed to read offline queue', error);
      // Keep the last known counts. Zero would be a fabricated claim that no local work exists.
      snapshot = {
        ...snapshot,
        syncing,
        online: deps.isOnline(),
        sessionExpired,
        storageAvailable: false,
      };
    }
    emit();
    return snapshot;
  }

  async function enqueue(input: SubmitReceiptInput, reason: string | null): Promise<OfflineQueuedAction> {
    const scope = await deps.resolveScope();
    if (!scope) {
      throw new OfflineStorageError('לא ניתן לזהות את הארגון והמשתמש עבור השמירה המקומית.');
    }
    const now = deps.now();
    return deps.store.upsertQueuedAction({
      kind: 'save_goods_receipt',
      orgId: scope.orgId,
      actorUserId: scope.actorUserId,
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
      try {
        await enqueue(input, reason);
      } catch (error) {
        await refresh();
        return { kind: 'rejected', message: localStorageMessage(error) };
      }
      await refresh();
      return { kind: 'queued', reason };
    }
    const actorUserId = await deps.getUsableActorId();
    const scope = await deps.resolveScope();
    if (!actorUserId || !scope || actorUserId !== scope.actorUserId) {
      // The draft is kept and NOTHING is sent: stale credentials never carry a business write.
      sessionExpired = true;
      const reason = 'פג תוקף החיבור. הקבלה נשמרה במכשיר ותישלח לאחר התחברות מחדש.';
      try {
        await enqueue(input, reason);
      } catch (error) {
        await refresh();
        return { kind: 'rejected', message: localStorageMessage(error) };
      }
      await refresh();
      return { kind: 'queued', reason };
    }
    sessionExpired = false;
    const sentAt = deps.now();
    let queued: OfflineQueuedAction;
    try {
      // Persist and claim before the network call. A replacement in another tab increments the
      // payload version and clears this lease, so this sender can no longer delete it afterwards.
      queued = await enqueue(input, null);
    } catch (error) {
      await refresh();
      return { kind: 'rejected', message: localStorageMessage(error) };
    }
    if (queued.id == null) {
      await refresh();
      return { kind: 'rejected', message: 'לא ניתן לזהות את הפעולה המקומית שנשמרה.' };
    }
    const claimed = await deps.store.claimQueuedAction(queued.id, leaseOwner, sentAt);
    if (!claimed || claimed.syncVersion == null) {
      const reason = 'הקבלה נשמרה במכשיר ומסונכרנת כעת בחלון אחר.';
      await refresh();
      return { kind: 'queued', reason };
    }
    let serverAccepted = false;
    try {
      const result = await deps.send({
        ...claimed.payload,
        p_reason: receiptAuditReason(claimed.payload.p_reason, claimed.observedAt, sentAt),
      });
      serverAccepted = true;
      const accepted = await deps.store.finalizeClaimedQueuedAction(
        claimed.id!, leaseOwner, claimed.syncVersion, sentAt, deps.now(),
      );
      if (!accepted) {
        const reason = 'השרת קיבל גרסה קודמת, ושינויים חדשים יותר נשארו במכשיר לסנכרון.';
        await refresh();
        return { kind: 'queued', reason };
      }
      try {
        await deps.store.setLastSuccessfulSyncAt(sentAt);
      } catch (metadataError) {
        console.error('[supplyflow] receipt accepted but sync timestamp was not stored', metadataError);
      }
      await refresh();
      return { kind: 'sent', receiptId: result.receipt_id, result };
    } catch (error) {
      const conflict = receiptConflictCode(error);
      const permanentFailure = isPermanentQueueFailure(error);
      const transportFailure = isTransportFailure(error);
      const finalizationFailure = serverAccepted;
      const failureMessage = finalizationFailure
        ? 'השרת קיבל את הקבלה, אך הניקוי המקומי לא הושלם. הפעולה נשארה לתיקון בטוח בניסיון הבא.'
        : toHebrewError(error);
      const updated = await deps.store.updateClaimedQueuedAction(
        claimed.id!,
        leaseOwner,
        claimed.syncVersion,
        {
          attempts: claimed.attempts + 1,
          state: finalizationFailure || transportFailure
            ? 'failed'
            : conflict ? 'conflict' : permanentFailure || !transportFailure ? 'needs_attention' : 'failed',
          lastError: failureMessage,
          lastErrorCode: conflict ?? (permanentFailure ? 'permanent_scope_rejection' : null),
          lastAttemptAt: sentAt,
        },
        deps.now(),
      );
      if (!updated) {
        const reason = 'הפעולה השתנתה בחלון אחר ונשארה במכשיר לסנכרון.';
        await refresh();
        return { kind: 'queued', reason };
      }
      if (finalizationFailure) {
        await refresh();
        return { kind: 'queued', reason: failureMessage };
      }
      if (conflict) {
        await refresh();
        return { kind: 'conflict', code: conflict, message: toHebrewError(error) };
      }
      if (transportFailure) {
        const reason = 'השליחה נכשלה בגלל תקלת רשת. הקבלה נשמרה במכשיר ותישלח בניסיון הבא.';
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
    if (!(await deps.getUsableActorId())) {
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
        if (action.state === 'conflict' || action.state === 'needs_attention' || action.id == null) continue;
        const sentAt = deps.now();
        const claimed = await deps.store.claimQueuedAction(action.id, leaseOwner, sentAt);
        if (!claimed || claimed.syncVersion == null || claimed.id == null) continue;
        let serverAccepted = false;
        try {
          // Do not rely on the actor checked at the start of the batch. A sign-out/sign-in can
          // happen between two actions, so identity and scope are rechecked immediately before
          // every RPC invocation.
          const actorUserId = await deps.getUsableActorId();
          const scope = await deps.resolveScope();
          if (!actorUserId || !scope) {
            sessionExpired = true;
            break;
          }
          if (
            !claimed.actorUserId
            || !claimed.orgId
            || actorUserId !== claimed.actorUserId
            || scope.actorUserId !== claimed.actorUserId
            || scope.orgId !== claimed.orgId
          ) {
            // Do not mutate another actor's record either. It stays bound to its owner and becomes
            // visible again only when that same owner signs in.
            sessionExpired = true;
            break;
          }
          await deps.send({
            ...claimed.payload,
            p_reason: receiptAuditReason(claimed.payload.p_reason, claimed.observedAt, sentAt),
          });
          serverAccepted = true;
          const accepted = await deps.store.finalizeClaimedQueuedAction(
            claimed.id, leaseOwner, claimed.syncVersion, sentAt, deps.now(),
          );
          if (accepted) {
            try {
              await deps.store.setLastSuccessfulSyncAt(sentAt);
            } catch (metadataError) {
              console.error('[supplyflow] receipt accepted but sync timestamp was not stored', metadataError);
            }
          }
        } catch (error) {
          // Continue after failure (the runUploadBatch rule): every remaining action still gets
          // its turn, and each keeps its own reason so a retry targets only what failed.
          const conflict = receiptConflictCode(error);
          const permanentFailure = isPermanentQueueFailure(error);
          const failureMessage = serverAccepted
            ? 'השרת קיבל את הקבלה, אך הניקוי המקומי לא הושלם. הפעולה נשארה לתיקון בטוח בניסיון הבא.'
            : toHebrewError(error);
          await deps.store.updateClaimedQueuedAction(
            claimed.id,
            leaseOwner,
            claimed.syncVersion,
            {
              attempts: claimed.attempts + 1,
              state: serverAccepted ? 'failed' : conflict ? 'conflict' : permanentFailure ? 'needs_attention' : 'failed',
              lastError: failureMessage,
              lastErrorCode: conflict ?? (permanentFailure ? 'permanent_scope_rejection' : null),
              lastAttemptAt: sentAt,
            },
            deps.now(),
          );
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
    discardAction: async (id, expectedSyncVersion, expectedState) => {
      const discarded = await deps.store.discardConflictedQueuedAction(
        id, expectedSyncVersion, expectedState,
      );
      await refresh();
      return discarded;
    },
    start,
    stop,
  };
}

/* ============================ the app's instance ============================ */

async function getUsableActorId(): Promise<string | null> {
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session) return null;
    const expiresAt = data.session.expires_at ? data.session.expires_at * 1000 : null;
    return expiresAt === null || expiresAt > Date.now() ? data.session.user.id : null;
  } catch {
    return null;
  }
}

let serverVerifiedScope: OfflineScope | null = null;

async function resolveProductionScope(): Promise<OfflineScope | null> {
  try {
    const { data, error } = await supabase.auth.getSession();
    const actorUserId = data.session?.user.id ?? null;
    if (error || !actorUserId) return null;
    if (serverVerifiedScope?.actorUserId === actorUserId) return serverVerifiedScope;

    let remembered: OfflineScope | null = null;
    try {
      remembered = await getRememberedOfflineScope(actorUserId);
    } catch {
      // The profile can still provide the scope. The actual write will report an IndexedDB failure.
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) return remembered;

    const profileResult = await supabase
      .from('profiles')
      .select('org_id')
      .eq('id', actorUserId)
      .maybeSingle();
    const orgId = profileResult.data?.org_id;
    if (!profileResult.error && orgId) {
      const scope = { actorUserId, orgId };
      serverVerifiedScope = scope;
      try {
        await rememberOfflineScope(scope);
      } catch {
        // Do not mask the authenticated scope; a subsequent local write will fail explicitly.
      }
      return scope;
    }

    // Remembered scope is only a local ownership binding. It cannot authorize a send: the live
    // actor check above and the server-side RPC scope still decide whether a write is permitted.
    return remembered;
  } catch {
    return null;
  }
}

configureOfflineScopeResolver(resolveProductionScope);

export const offlineQueue = createOfflineQueue({
  store: indexedDbQueueStore,
  send: async (payload) => unwrap(await supabase.rpc('save_goods_receipt', payload)) as { receipt_id: string },
  getUsableActorId,
  resolveScope: resolveProductionScope,
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
