// Upload Center. The live resume/offline contract is in docs/OFFLINE-SYNC-DESIGN.md.
//
// One global upload queue for every screen that uploads files. The store lives at module
// level so plain libraries (`runUploadBatch`) and components alike feed the same queue;
// the surface component renders wherever an uploading screen mounts it, and a singleton
// guard keeps exactly one visible surface even when several screens embed it.
//
// The rule that protects the money (UI-PLAN §5): once the source object is safely stored,
// a later registration/processing failure shows the stored document and NEVER invites a
// re-upload — the retry runner re-runs only the failed step. The pattern is adopted from
// PriceListUpload's pending-registration flow.

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router';
import { ShieldCheck, X } from 'lucide-react';
import { toHebrewError } from '../lib/errors';
import { TusUploadCancelledError } from '../lib/tusUpload';
import {
  useDocumentProcessing,
  type DocumentProcessingStage,
} from '../lib/useDocumentProcessing';
import { documentUiStatus } from '../lib/documentStatus';
import type { StatusMeta } from '../lib/status';
import { setUploadBatchDelegate, type UploadBatchResult } from '../lib/uploadBatch';
import { Note, StatusBadge } from './ui';
import { DocumentStatusBadge } from './DocumentStatusBadge';

/* ================= queue model ================= */

/**
 * The upload-side states. Together with the processing stages a registered document
 * reports (`useDocumentProcessing`: queued/processing/extracted/review/completed/failed)
 * and the per-batch "completed partially" summary, these are the ten mandated states.
 */
export type UploadCenterStatus =
  | 'queued'      // לא הועלה
  | 'uploading'   // מעלה
  | 'stored'      // הועלה אך לא נרשם — the money state
  | 'registered'  // נרשם; processing stages take over from here
  | 'failed'      // נכשל לפני שהמקור נשמר
  | 'canceled';

export interface UploadCenterEntry {
  id: string;
  batchId: string;
  fileName: string;
  mimeType: string;
  size: number;
  status: UploadCenterStatus;
  /** null until the first progress event (indeterminate). */
  percent: number | null;
  documentId: string | null;
  /** True the moment the source object is durable in storage. */
  storedSafely: boolean;
  /** Hebrew label of the originating entity/screen. */
  source: string | null;
  supplierName: string | null;
  error: string | null;
  waitingForNetwork: boolean;
  canRetry: boolean;
  canCancel: boolean;
}

export interface UploadCenterItemDescriptor {
  name: string;
  type: string;
  size: number;
}

/** What a runner may report while it executes; all methods are safe to skip. */
export interface UploadCenterTaskContext {
  onProgress: (percent: number) => void;
  /** The source object is durable in storage; registration may still be pending. */
  markStored: (documentId?: string | null) => void;
  /** The registry row exists — a failure past this point must never invite re-upload. */
  markRegistered: (documentId?: string | null) => void;
  registerAbort: (abort: (() => void | Promise<void>) | null) => void;
  isCanceled: () => boolean;
}

export interface UploadFailureShape {
  message: string;
  /** True when re-running the runner is safe (the runner resumes only the failed step). */
  retryable: boolean;
  /** The object survived the failure. */
  storedSafely?: boolean;
  /** The registry row survived the failure (registration succeeded, a later step failed). */
  registered?: boolean;
  documentId?: string | null;
}

export interface UploadCenterBatchOptions<T> {
  source?: string | null;
  supplierName?: string | null;
  /**
   * Enables the per-entry retry button. Only pass true when the runner resumes from the
   * failed step on a re-run (the money rule); consumers whose runner would re-upload from
   * scratch keep their own retry UI and leave this off.
   */
  retry?: boolean;
  describe?: (item: T) => UploadCenterItemDescriptor;
  classifyFailure?: (item: T, error: unknown) => UploadFailureShape;
}

interface UploadRecord {
  id: string;
  batchId: string;
  item: unknown;
  fileName: string;
  mimeType: string;
  size: number;
  status: UploadCenterStatus;
  percent: number | null;
  documentId: string | null;
  storedSafely: boolean;
  source: string | null;
  supplierName: string | null;
  error: string | null;
  waitingForNetwork: boolean;
  retryEnabled: boolean;
  retryable: boolean;
  running: boolean;
  run: (() => Promise<boolean>) | null;
  abort: (() => void | Promise<void>) | null;
  announced: Set<number>;
}

const TERMINAL_STATUSES: ReadonlySet<UploadCenterStatus> = new Set(['stored', 'registered', 'failed', 'canceled']);

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${++sequence}`;

let records: UploadRecord[] = [];
let announcement = '';
const listeners = new Set<() => void>();

interface UploadCenterSnapshot {
  entries: UploadCenterEntry[];
  announcement: string;
}

let snapshotCache: UploadCenterSnapshot | null = null;

function toPublicEntry(record: UploadRecord): UploadCenterEntry {
  return {
    id: record.id,
    batchId: record.batchId,
    fileName: record.fileName,
    mimeType: record.mimeType,
    size: record.size,
    status: record.status,
    percent: record.percent,
    documentId: record.documentId,
    storedSafely: record.storedSafely,
    source: record.source,
    supplierName: record.supplierName,
    error: record.error,
    waitingForNetwork: record.waitingForNetwork,
    canRetry: record.retryEnabled && record.retryable && !record.running
      && (record.status === 'failed' || record.status === 'stored'
        || (record.status === 'registered' && record.error !== null)),
    // Cancel is offered only while it is still meaningful: before execution starts, or
    // mid-transfer while an abort handle exists and nothing durable was written yet.
    canCancel: record.status === 'queued'
      || (record.status === 'uploading' && record.abort !== null && !record.storedSafely),
  };
}

function emit() {
  snapshotCache = null;
  for (const listener of [...listeners]) listener();
}

export function subscribeUploadCenter(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getUploadCenterSnapshot(): UploadCenterSnapshot {
  snapshotCache ??= { entries: records.map(toPublicEntry), announcement };
  return snapshotCache;
}

/** Spaced `aria-live` announcements — quarter milestones and outcomes, never per-percent. */
function announce(text: string) {
  announcement = text;
  emit();
}

/* ================= ambient task context =================
 *
 * `runUploadBatch` keeps its public signature, so a consumer's `upload(file)` closure has
 * nowhere to accept a reporter. The queue sets the context synchronously around the
 * runner invocation; `uploadDocument` (and friends) claim it in their own synchronous
 * prologue, before any await, so interleaved batches cannot misattribute it.
 */

let ambientContext: UploadCenterTaskContext | null = null;

export function claimActiveUploadTask(): UploadCenterTaskContext | null {
  return ambientContext;
}

/* ================= execution ================= */

function isOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/**
 * Reads the status through a call boundary. `record.status` is mutated by cancel and by
 * async callbacks, so the literal narrowing TS keeps across awaits would otherwise call
 * these checks impossible.
 */
function currentStatus(record: UploadRecord): UploadCenterStatus {
  return record.status;
}

const OFFLINE_ANNOUNCEMENT = 'אין חיבור לרשת. ההעלאות ממתינות ויימשכו אוטומטית כשהחיבור יחזור.';

/** Offline: the queue waits and says so; it resumes by itself when the network returns. */
async function waitForOnline(record: UploadRecord) {
  if (isOnline()) return;
  record.waitingForNetwork = true;
  announce(OFFLINE_ANNOUNCEMENT);
  await new Promise<void>((resolve) => {
    const timer = window.setInterval(check, 2_000);
    function finish() {
      window.removeEventListener('online', check);
      window.clearInterval(timer);
      resolve();
    }
    function check() {
      if (isOnline() || record.status === 'canceled') finish();
    }
    window.addEventListener('online', check);
  });
  record.waitingForNetwork = false;
  // The live region is the only surface with no way to notice on its own that a state ended: the
  // visible offline note is re-evaluated against `navigator.onLine` on every render, while this
  // text just sits there until something overwrites it. "אין חיבור לרשת" is a claim about NOW, so
  // whoever put it there takes it back. Only if it is still the sentence on the channel — a later
  // announcement is a newer truth and must not be undone by an older step finishing.
  if (announcement === OFFLINE_ANNOUNCEMENT) {
    announce(isOnline() && record.status !== 'canceled' ? 'החיבור חזר. ההעלאות ממשיכות.' : '');
    return;
  }
  emit();
}

function defaultDescribe(item: unknown): UploadCenterItemDescriptor {
  if (typeof File !== 'undefined' && item instanceof File) {
    return { name: item.name, type: item.type, size: item.size };
  }
  return { name: 'קובץ', type: '', size: 0 };
}

function defaultClassify(error: unknown): UploadFailureShape {
  const duck = (error ?? {}) as {
    retryable?: unknown;
    registered?: unknown;
    resume?: { storagePath?: unknown; documentId?: unknown } | null;
  };
  const resume = duck.resume && typeof duck.resume === 'object' ? duck.resume : null;
  const shaped: UploadFailureShape = {
    // Errors that carry their own retry verdict (DocumentUploadError, TusUploadError)
    // author Hebrew messages; anything else goes through the translation table.
    message: error instanceof Error && typeof duck.retryable === 'boolean'
      ? error.message
      : toHebrewError(error),
    retryable: duck.retryable === true,
    registered: duck.registered === true,
    storedSafely: resume !== null || duck.registered === true,
  };
  if (resume && typeof resume.documentId === 'string') shaped.documentId = resume.documentId;
  return shaped;
}

async function executeRecord<T>(
  record: UploadRecord,
  run: (item: T, ctx: UploadCenterTaskContext) => Promise<unknown>,
  classify: (item: T, error: unknown) => UploadFailureShape,
): Promise<{ ok: boolean; error?: unknown }> {
  record.status = 'uploading';
  record.error = null;
  record.percent = record.storedSafely ? 100 : null;
  emit();
  let registered = false;
  const ctx: UploadCenterTaskContext = {
    onProgress: (percent) => {
      const bounded = Math.max(0, Math.min(100, Math.round(percent)));
      if (bounded === record.percent) return;
      record.percent = bounded;
      for (const milestone of [25, 50, 75]) {
        if (bounded >= milestone && !record.announced.has(milestone)) {
          record.announced.add(milestone);
          announce(`${record.fileName} — הועלו ${milestone}%`);
        }
      }
      emit();
    },
    markStored: (documentId) => {
      record.storedSafely = true;
      if (documentId) record.documentId = documentId;
      emit();
    },
    markRegistered: (documentId) => {
      registered = true;
      record.storedSafely = true;
      if (documentId) record.documentId = documentId;
      emit();
    },
    registerAbort: (abort) => {
      record.abort = abort;
      emit();
    },
    isCanceled: () => record.status === 'canceled',
  };
  try {
    let result: Promise<unknown>;
    ambientContext = ctx;
    try {
      result = Promise.resolve(run(record.item as T, ctx));
    } finally {
      // Cleared right after the synchronous prologue of the runner; see the note above.
      ambientContext = null;
    }
    await result;
    record.abort = null;
    record.percent = 100;
    // A runner that reported storage but not registration resolved into the pending-
    // registration state (the price flow's contract); everything else is fully done.
    record.status = registered || !record.storedSafely ? 'registered' : 'stored';
    if (record.status === 'stored') {
      record.retryable = true;
      announce(`${record.fileName} — המקור נשמר; הרישום טרם הושלם`);
    } else {
      announce(`${record.fileName} — ההעלאה הושלמה`);
    }
    emit();
    return { ok: true };
  } catch (error) {
    record.abort = null;
    if (error instanceof TusUploadCancelledError || currentStatus(record) === 'canceled') {
      record.status = 'canceled';
      emit();
      return { ok: false, error: error instanceof Error ? error : new TusUploadCancelledError() };
    }
    const shape = classify(record.item as T, error);
    record.error = shape.message;
    record.retryable = shape.retryable;
    if (shape.documentId) record.documentId = shape.documentId;
    if (shape.storedSafely) record.storedSafely = true;
    if (shape.registered) {
      record.storedSafely = true;
      record.status = 'registered';
    } else if (record.storedSafely) {
      record.status = 'stored';
    } else {
      record.status = 'failed';
    }
    announce(record.storedSafely
      ? `${record.fileName} — המקור נשמר אך הטיפול לא הושלם`
      : `${record.fileName} — ההעלאה נכשלה`);
    emit();
    return { ok: false, error };
  }
}

/**
 * Enqueues one batch. Items run sequentially in order — the server contracts assume it —
 * and the returned promise resolves once every item ran exactly once, matching the
 * `runUploadBatch` contract. Center-driven retries happen after and do not change the
 * resolved result; the consumer's own summary logic stays authoritative.
 */
export function enqueueUploadCenterBatch<T>(
  items: readonly T[],
  run: (item: T, ctx: UploadCenterTaskContext) => Promise<unknown>,
  options: UploadCenterBatchOptions<T> = {},
): Promise<UploadBatchResult<T>> {
  if (!items.length) return Promise.resolve({ succeeded: [], failed: [] });
  const batchId = nextId('batch');
  const describe = options.describe ?? defaultDescribe;
  const classify = options.classifyFailure ?? ((_item: T, error: unknown) => defaultClassify(error));
  const newRecords: UploadRecord[] = items.map((item) => {
    const descriptor = describe(item);
    return {
      id: nextId('upload'),
      batchId,
      item,
      fileName: descriptor.name,
      mimeType: descriptor.type,
      size: descriptor.size,
      status: 'queued',
      percent: null,
      documentId: null,
      storedSafely: false,
      source: options.source ?? null,
      supplierName: options.supplierName ?? null,
      error: null,
      waitingForNetwork: false,
      retryEnabled: options.retry === true,
      retryable: false,
      running: false,
      run: null,
      abort: null,
      announced: new Set<number>(),
    };
  });
  for (const record of newRecords) {
    record.run = async () => {
      record.running = true;
      record.status = 'queued';
      record.error = null;
      record.announced.clear();
      emit();
      await waitForOnline(record);
      if (currentStatus(record) === 'canceled') {
        record.running = false;
        emit();
        return false;
      }
      const outcome = await executeRecord(record, run, classify);
      record.running = false;
      emit();
      return outcome.ok;
    };
    // A consumer-driven retry of the same file replaces its stale terminal row instead
    // of stacking a duplicate row for one physical file.
    const staleIndex = records.findIndex((existing) =>
      existing.batchId !== batchId
      && TERMINAL_STATUSES.has(existing.status)
      && !existing.running
      && existing.fileName === record.fileName
      && existing.size === record.size
      && existing.source === record.source);
    if (staleIndex !== -1) records.splice(staleIndex, 1);
  }
  records.push(...newRecords);
  emit();
  return (async () => {
    const succeeded: T[] = [];
    const failed: { item: T; error: unknown }[] = [];
    for (const record of newRecords) {
      if (record.status === 'canceled') {
        failed.push({ item: record.item as T, error: new TusUploadCancelledError() });
        continue;
      }
      record.running = true;
      emit();
      await waitForOnline(record);
      if (currentStatus(record) === 'canceled') {
        record.running = false;
        emit();
        failed.push({ item: record.item as T, error: new TusUploadCancelledError() });
        continue;
      }
      const outcome = await executeRecord(record, run, classify);
      record.running = false;
      emit();
      if (outcome.ok) succeeded.push(record.item as T);
      else failed.push({ item: record.item as T, error: outcome.error });
    }
    return { succeeded, failed };
  })();
}

// Every `runUploadBatch` call in the browser flows through the Center's queue. See the
// note on `setUploadBatchDelegate` for why this is a registration and not a static import.
setUploadBatchDelegate((items, upload) => enqueueUploadCenterBatch(items, (item) => upload(item)));

export function retryUploadCenterEntry(id: string) {
  const record = records.find((candidate) => candidate.id === id);
  if (!record?.run || record.running || !toPublicEntry(record).canRetry) return;
  void record.run();
}

export function cancelUploadCenterEntry(id: string) {
  const record = records.find((candidate) => candidate.id === id);
  if (!record || !toPublicEntry(record).canCancel) return;
  const abort = record.abort;
  record.status = 'canceled';
  record.abort = null;
  emit();
  if (abort) void abort();
}

/**
 * A registration completed outside the queue runner (e.g. the price modal's
 * "ניסיון רישום נוסף") — lift the matching pending entries out of the money state.
 */
export function markUploadCenterDocumentRegistered(documentId: string) {
  let changed = false;
  for (const record of records) {
    if (record.documentId === documentId && record.status === 'stored') {
      record.status = 'registered';
      record.error = null;
      changed = true;
    }
  }
  if (changed) emit();
}

/** Clears settled rows. The 'stored' money state is kept until it is actually resolved. */
export function clearSettledUploadCenterEntries() {
  const kept = records.filter((record) =>
    record.running || !(record.status === 'registered' || record.status === 'failed' || record.status === 'canceled'));
  if (kept.length !== records.length) {
    records = kept;
    emit();
  }
}

/** Test-only: drops every entry and resets the announcement channel. */
export function resetUploadCenterForTests() {
  records = [];
  announcement = '';
  ambientContext = null;
  emit();
}

/* ================= singleton surface guard ================= */

const surfaceStack: object[] = [];
const surfaceListeners = new Set<() => void>();

function subscribeSurfaces(listener: () => void): () => void {
  surfaceListeners.add(listener);
  return () => surfaceListeners.delete(listener);
}

function registerSurface(token: object) {
  surfaceStack.push(token);
  for (const listener of [...surfaceListeners]) listener();
}

function unregisterSurface(token: object) {
  const index = surfaceStack.indexOf(token);
  if (index !== -1) surfaceStack.splice(index, 1);
  for (const listener of [...surfaceListeners]) listener();
}

/* ================= surface ================= */

const UPLOAD_STATE_META: Record<UploadCenterStatus, StatusMeta> = {
  queued: { label: 'ממתין להעלאה', tone: 'idle' },
  uploading: { label: 'מעלה', tone: 'info' },
  stored: { label: 'הועלה אך לא נרשם', tone: 'await' },
  registered: { label: 'נרשם', tone: 'done' },
  failed: { label: 'נכשל', tone: 'alert' },
  canceled: { label: 'בוטל', tone: 'idle' },
};

/**
 * G1, finding 20 — and here the audit's own premise was corrected, so only ONE branch moved.
 *
 * This function merges two different facts: how far the UPLOAD got, and how far the READING got.
 * `unprocessed` is excluded from the processing branch on purpose, because on an upload surface
 * "registered but nothing was ever sent to be read" is the one distinction that matters. The
 * upload lifecycle therefore keeps its own `נרשם` / `נרשם — העיבוד לא החל` answers; once a
 * job exists, `documentUiStatus` owns the wording and precedence.
 */
function displayMeta(entry: UploadCenterEntry, stage: DocumentProcessingStage | null): StatusMeta {
  if (entry.status === 'registered') {
    if (stage && stage !== 'unprocessed') return documentUiStatus({ status: stage });
    // "העיבוד לא החל" is a claim about the server, and it is only allowed where the server is
    // actually being asked: the poll below takes document ids, so a row without one is never
    // checked again and the transport error it carries is history the moment it is caught. Left
    // ungated, that error was rendered as a live state for the rest of the session. With an id the
    // claim stands until a real job supersedes it, which is the branch above. Without one the row
    // says what is certainly true — the document was registered — and the error text underneath
    // says what went wrong, in its own words, as a report rather than as a status.
    if (entry.error && entry.documentId) return { label: 'נרשם — העיבוד לא החל', tone: 'await' };
    return UPLOAD_STATE_META.registered;
  }
  if (entry.status === 'queued' && entry.waitingForNetwork) return { label: 'ממתין לחיבור', tone: 'await' };
  return UPLOAD_STATE_META[entry.status];
}

function formatFileSize(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function useOnlineStatus() {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener('online', listener);
      window.addEventListener('offline', listener);
      return () => {
        window.removeEventListener('online', listener);
        window.removeEventListener('offline', listener);
      };
    },
    isOnline,
    () => true,
  );
}

/**
 * The queue surface. Every uploading screen may embed it; the most recently mounted
 * instance renders (one visible surface), and it disappears while the queue is empty.
 */
export function UploadCenter() {
  const [token] = useState<object>(() => ({}));
  useEffect(() => {
    registerSurface(token);
    return () => unregisterSurface(token);
  }, [token]);
  const owner = useSyncExternalStore(
    subscribeSurfaces,
    () => surfaceStack[surfaceStack.length - 1] === token,
    () => false,
  );
  const { entries, announcement: liveAnnouncement } = useSyncExternalStore(
    subscribeUploadCenter,
    getUploadCenterSnapshot,
    getUploadCenterSnapshot,
  );
  const online = useOnlineStatus();
  const polledIds = useMemo(
    () => (owner ? [...new Set(entries
      // A lost enqueue response leaves an error on a document that may already be queued. Poll it
      // too: once a real processing job appears, that server fact supersedes the transport error.
      // `stored` is polled for the same reason and it is the more important half: that row is the
      // money state, and it was the one row on this surface with no way to ever learn it was wrong.
      .filter((entry) => entry.documentId
        && (entry.status === 'registered' || entry.status === 'stored'))
      .map((entry) => entry.documentId!))] : []),
    [owner, entries],
  );
  const processing = useDocumentProcessing(polledIds);
  const { snapshots } = processing;

  /**
   * The money row, resolved by the server or not at all.
   *
   * `stored` means one specific thing: the object is durable and we do not know whether the
   * registry row exists, because the response that would have said so was lost (`markStored`
   * ran, `markRegistered` never did). The screen therefore told the person not to upload the
   * file again — correct, and it kept telling them that for ever, because nothing on this
   * surface ever asked the server the one question that settles it.
   *
   * A processing job carries a foreign key to `documents`, so a job for this id is proof the
   * registry row exists and the registration did complete. That is the only evidence accepted
   * here. No job — the row does not move: the instruction not to re-upload is a money-safety
   * claim, and silence from the server is not permission to withdraw it.
   */
  useEffect(() => {
    for (const entry of entries) {
      if (entry.status !== 'stored' || !entry.documentId) continue;
      if (snapshots[entry.documentId]?.job) markUploadCenterDocumentRegistered(entry.documentId);
    }
  }, [entries, snapshots]);

  if (!owner || !entries.length) return null;

  const pendingCount = entries.filter((entry) => entry.status === 'queued' || entry.status === 'uploading').length;
  const settledCount = entries.filter((entry) =>
    entry.status === 'registered' || entry.status === 'failed' || entry.status === 'canceled').length;
  const partialBatches = new Set<string>();
  const byBatch = new Map<string, UploadCenterEntry[]>();
  for (const entry of entries) {
    const group = byBatch.get(entry.batchId) ?? [];
    group.push(entry);
    byBatch.set(entry.batchId, group);
  }
  for (const [batchId, group] of byBatch) {
    if (group.length < 2) continue;
    const allSettled = group.every((entry) =>
      entry.status === 'registered' || entry.status === 'stored'
      || entry.status === 'failed' || entry.status === 'canceled');
    const anyDone = group.some((entry) => entry.status === 'registered');
    const anyNot = group.some((entry) => entry.status !== 'registered');
    if (allSettled && anyDone && anyNot) partialBatches.add(batchId);
  }

  return (
    <section aria-label="מרכז ההעלאות" data-upload-center className="mb-3 rounded-lg border border-line bg-surface">
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b border-line-soft px-3 py-1.5">
        <span className="text-sm font-medium text-ink-soft">
          מרכז ההעלאות
          {pendingCount > 0 && <span className="ms-1.5 text-xs text-ink-muted"><span className="num">{pendingCount}</span> בתהליך</span>}
        </span>
        {settledCount > 0 && (
          <button type="button" className="btn-ghost min-h-11 px-2!" onClick={clearSettledUploadCenterEntries}>
            ניקוי שהסתיימו
          </button>
        )}
      </div>
      {!online && pendingCount > 0 && (
        <Note tone="await" role="status" className="m-2">
          אין חיבור לרשת. תור ההעלאות ממתין ויימשך אוטומטית כשהחיבור יחזור.
        </Note>
      )}
      {partialBatches.size > 0 && (
        <Note tone="await" className="m-2">
          אצווה שהושלמה חלקית: חלק מהקבצים נקלטו וחלק עדיין דורשים טיפול.
        </Note>
      )}
      <ul className="divide-y divide-line-soft">
        {entries.map((entry) => {
          const snapshot = entry.documentId ? processing.snapshots[entry.documentId] : undefined;
          const stage = snapshot?.stage ?? null;
          const processingStatus = entry.status === 'registered' && stage && stage !== 'unprocessed'
            ? documentUiStatus({ status: stage, job: snapshot?.job })
            : null;
          return (
            <li key={entry.id} className="px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-ink-mid" title={entry.fileName}>{entry.fileName}</span>
                {entry.size > 0 && <span className="num text-xs text-ink-muted">{formatFileSize(entry.size)}</span>}
                {processingStatus
                  ? <DocumentStatusBadge status={processingStatus} />
                  : <StatusBadge meta={displayMeta(entry, stage)} />}
                {entry.canRetry && !processingStatus && (
                  <button type="button" className="btn-ghost min-h-11 px-2!"
                    onClick={() => retryUploadCenterEntry(entry.id)}>
                    {entry.status === 'registered'
                      ? 'שליחה מחדש לעיבוד'
                      : entry.storedSafely ? 'השלמת רישום' : 'ניסיון חוזר'}
                  </button>
                )}
                {entry.canCancel && (
                  <button type="button" className="btn-ghost min-h-11 min-w-11 p-1.5! text-ink-faint hover:text-alert-solid"
                    aria-label={`ביטול העלאת ${entry.fileName}`}
                    onClick={() => cancelUploadCenterEntry(entry.id)}>
                    <X size={14} />
                  </button>
                )}
              </div>
              {(entry.source || entry.supplierName) && (
                <div className="mt-0.5 text-xs text-ink-muted">
                  {[entry.source, entry.supplierName].filter(Boolean).join(' · ')}
                </div>
              )}
              {entry.status === 'uploading' && (
                <div className="mt-1.5">
                  <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={entry.percent ?? 0}
                    aria-label={`התקדמות העלאה — ${entry.fileName}`}
                    className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
                    <div className="h-full rounded-full bg-action" style={{ width: `${entry.percent ?? 0}%` }} />
                  </div>
                </div>
              )}
              {entry.storedSafely && entry.status !== 'registered' && entry.status !== 'uploading' && (
                <div className="mt-1 flex items-center gap-1.5 text-xs text-ink-soft">
                  <ShieldCheck size={13} className="shrink-0" />
                  קובץ המקור נשמר בבטחה — אין להעלות אותו שוב; נותר רק להשלים את הרישום.
                </div>
              )}
              {entry.error && !processingStatus && <div className="mt-1 text-xs text-alert-fg">{entry.error}</div>}
              {entry.status === 'registered' && entry.documentId && entry.error && !processingStatus && (
                <Link to={`/documents/${entry.documentId}/review`} className="link text-xs">
                  מעבר למסמך הרשום
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      <div aria-live="polite" className="sr-only">{liveAnnouncement}</div>
    </section>
  );
}
