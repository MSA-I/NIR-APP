import { useT } from '../lib/i18n/LocaleProvider';
import type { TKey } from '../lib/i18n/t.ts';
import { useEffect, useId, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { fmtDateTime, formatQuantity } from '../lib/format';
import { RECEIPT_LINE_STATUS } from '../lib/status';
import { receiptClock, type ReceiptConflictCode } from '../lib/offlineQueue';
import type { OfflineReceiptLine, ReceiptLineStatusValue } from '../lib/offlineDb';
import { Modal, Note, ToggleGroup } from './ui';

/**
 * The decision screen a rejected goods receipt opens (ADR-0006:40-42, `OFFLINE-SYNC-DESIGN.md` §5).
 *
 * **There is no automatic quantity merge, and there will not be one.** A quantity is a claim about
 * goods that arrived on a truck; picking a number for someone by rule is a guess about physical
 * reality and about money. What this screen does is show both claims — local and server — with their
 * timestamps and (when RLS allows it) who changed the server side, and then ask.
 *
 * Detection is **re-read-and-compare**: `purchase_order_items` has no updated-at column and no
 * trigger (`0001:164-171,415`), and `OFFLINE-SYNC-DESIGN.md` forbids adding one. So the client re-reads the rows it
 * cares about and compares them with what it holds. That is weaker than a version stamp and it is
 * said out loud rather than dressed up: the comparison shows the state at read time, and the server
 * remains the only authority — every resolution goes back through `save_goods_receipt`, which
 * validates again under row locks.
 */

export interface ReceiptConflictLine {
  orderItemId: string;
  productName: string;
  unit: string;
  localQty: number;
  localStatus: ReceiptLineStatusValue;
  localNotes: string | null;
  orderedQty: number | null;
  serverReceivedQty: number | null;
  /** What the server would accept for a `full` line right now (`0023:1518`: exactly this). */
  serverRemaining: number | null;
  /** The quantity on the server's own draft line for this item, when a server draft exists. */
  serverDraftQty: number | null;
}

export interface ReceiptConflictState {
  code: ReceiptConflictCode;
  orderId: string;
  orderNumber: number | null;
  supplierName: string;
  /** The persisted idempotency key this receipt was submitted under. */
  receiptId: string;
  lines: ReceiptConflictLine[];
  /** Device clock when the person recorded the goods. */
  localObservedAt: number;
  /**
   * Whether the rejection came back from a receipt that had waited in the offline queue, rather
   * than from a submission that went straight to the server.
   *
   * It decides which cause the dialog names. An offline race — somebody else receiving against
   * the order while this device was away — is a real thing that happens to a queued replay, and a
   * plain fiction for a quantity typed and sent seconds earlier on a connected device. Naming it
   * anyway sent a clerk looking for a colleague who never touched the order (`PROC-04`).
   */
  queuedReplay: boolean;
  serverReceiptId: string | null;
  serverReceiptStatus: 'draft' | 'completed' | null;
  serverReceiptAt: string | null;
  /** '—' whenever the name is unknown or RLS hides it, exactly like `fetchActorNames`. */
  serverActorName: string;
  serverOrderStatus: string | null;
  /** Set when the re-read itself could not be completed; the screen says so instead of guessing. */
  rereadErrorKey: TKey | null;
}

export type ConflictOptionKind = 'resend-decided' | 'keep-local' | 'discard-local';

export interface ConflictPresentation {
  titleKey: TKey;
  /** What the server actually said, in Hebrew, naming the situation rather than the error code. */
  summaryKey: TKey;
  /** Whether a per-line human decision (local value / server value) is offered. */
  perLineDecision: boolean;
  /** Whether a resolution can produce a new server write at all. */
  resendable: boolean;
  requiresExplanation: boolean;
  options: { kind: ConflictOptionKind; labelKey: TKey; danger?: boolean }[];
  /** Honest note when a resolution writes nothing to the server, so no audit row is created. */
  localOnlyNoteKey: TKey | null;
}

/**
 * One place that decides what each of the five rejections offers.
 *
 * Exported and pure so the mapping is a tested claim rather than JSX nobody can assert on.
 */
export function conflictPresentation(
  code: ReceiptConflictCode,
  context: { queuedReplay?: boolean } = {},
): ConflictPresentation {
  const keepLocal = { kind: 'keep-local' as const, labelKey: 'receiptConflict.keepLocal' as TKey };
  const discardLocal = { kind: 'discard-local' as const, labelKey: 'receiptConflict.discardLocal' as TKey, danger: true };
  const localOnly: TKey = 'receiptConflict.localOnlyNote';

  switch (code) {
    case 'receipt_qty_exceeds_order':
      return {
        titleKey: 'receiptConflict.qtyExceedsTitle',
        // Both sentences are true of a queued replay; only one is true of a live submission, and
        // the comparison table below already holds the two numbers that prove which.
        summaryKey: context.queuedReplay
          ? 'receiptConflict.qtyExceedsSummaryQueued'
          : 'receiptConflict.qtyExceedsSummary',
        perLineDecision: true,
        resendable: true,
        requiresExplanation: true,
        options: [{ kind: 'resend-decided', labelKey: 'receiptConflict.resendDecided' }, keepLocal],
        localOnlyNoteKey: null,
      };
    case 'receipt_draft_conflict':
      return {
        titleKey: 'receiptConflict.draftConflictTitle',
        summaryKey: 'receiptConflict.draftConflictSummary',
        perLineDecision: false,
        resendable: false,
        requiresExplanation: false,
        options: [keepLocal, discardLocal],
        localOnlyNoteKey: localOnly,
      };
    case 'receipt_already_completed':
      return {
        titleKey: 'receiptConflict.alreadyCompletedTitle',
        summaryKey: 'receiptConflict.alreadyCompletedSummary',
        perLineDecision: false,
        resendable: false,
        requiresExplanation: false,
        options: [keepLocal, discardLocal],
        localOnlyNoteKey: localOnly,
      };
    case 'receipt_idempotency_conflict':
      return {
        titleKey: 'receiptConflict.idempotencyTitle',
        summaryKey: 'receiptConflict.idempotencySummary',
        perLineDecision: false,
        resendable: false,
        requiresExplanation: false,
        options: [keepLocal, discardLocal],
        localOnlyNoteKey: localOnly,
      };
    case 'purchase_order_not_receivable':
      return {
        titleKey: 'receiptConflict.notReceivableTitle',
        summaryKey: 'receiptConflict.notReceivableSummary',
        perLineDecision: false,
        resendable: false,
        requiresExplanation: false,
        options: [keepLocal, discardLocal],
        localOnlyNoteKey: localOnly,
      };
  }
}

/* ============================ the re-read ============================ */

/**
 * Every column this re-read names — selected, filtered or ordered — as data rather than as
 * strings scattered through the calls.
 *
 * The query below is built from this object, so the two cannot drift, and
 * `receiptConflictReread.spec.ts` checks every name here against the columns the migrations
 * actually create. That guard exists because a name that is only a string got one wrong:
 * `created_at` on `goods_receipts`, a column no migration ever added. PostgREST answered
 * `42703` on every call for a month, and the only symptom anyone saw was this dialog showing
 * em dashes where the server's own values belong.
 */
export const RECEIPT_CONFLICT_READ = {
  purchase_order_items: { select: 'id, qty, received_qty', filter: ['order_id'] },
  purchase_orders: { select: 'status', filter: ['id'] },
  goods_receipts: {
    select: 'id, status, received_at, received_by, items:goods_receipt_items(order_item_id, qty_received)',
    filter: ['order_id'],
    // `received_at` is the receipt's only timestamp (`0001_init.sql:174-183`) and it is
    // `not null default now()`, so ordering by it is both legal and the ordering that was meant.
    order: 'received_at',
  },
  profiles: { select: 'full_name', filter: ['id'] },
  audit_logs: {
    select: 'user_id',
    filter: ['entity_type', 'entity_id'],
    order: 'created_at',
  },
} as const satisfies Record<string, {
  readonly select: string;
  readonly filter: readonly string[];
  readonly order?: string;
}>;

interface ConflictReadInput {
  orderId: string;
  receiptId: string;
  orderNumber: number | null;
  supplierName: string;
  localLines: OfflineReceiptLine[];
  /**
   * Per order item, the name to SHOW and the unit. Called `label` and not `name` on purpose: the
   * caller has already chosen between the approved canonical name and the raw one, and a field
   * spelled like the raw column invites this dialog to make that choice a second time.
   */
  products: Map<string, { label: string; unit: string }>;
  localObservedAt: number;
  code: ReceiptConflictCode;
  /** See `ReceiptConflictState.queuedReplay`: it decides which cause the dialog names. */
  queuedReplay: boolean;
}

/**
 * Re-reads the server rows the conflict is about and pairs them with the local claim.
 *
 * A blocked or partial read degrades to `—` and a stated `rereadErrorKey`. Local work can still be kept
 * or discarded, but re-send is fail-closed: unknown server quantities are never converted to zero.
 */
export async function loadReceiptConflict(input: ConflictReadInput): Promise<ReceiptConflictState> {
  const state: ReceiptConflictState = {
    code: input.code,
    orderId: input.orderId,
    orderNumber: input.orderNumber,
    supplierName: input.supplierName,
    receiptId: input.receiptId,
    lines: [],
    localObservedAt: input.localObservedAt,
    queuedReplay: input.queuedReplay,
    serverReceiptId: null,
    serverReceiptStatus: null,
    serverReceiptAt: null,
    serverActorName: '—',
    serverOrderStatus: null,
    rereadErrorKey: null,
  };

  const [items, order, receipts] = await Promise.all([
    supabase.from('purchase_order_items')
      .select(RECEIPT_CONFLICT_READ.purchase_order_items.select).eq('order_id', input.orderId),
    supabase.from('purchase_orders')
      .select(RECEIPT_CONFLICT_READ.purchase_orders.select).eq('id', input.orderId).maybeSingle(),
    supabase.from('goods_receipts')
      .select(RECEIPT_CONFLICT_READ.goods_receipts.select)
      .eq('order_id', input.orderId)
      .order(RECEIPT_CONFLICT_READ.goods_receipts.order, { ascending: false }),
  ]);

  if (items.error || order.error || receipts.error) {
    state.rereadErrorKey = 'receiptConflict.rereadFailed';
  }

  const serverItems = new Map(
    ((items.data ?? []) as { id: string; qty: number; received_qty: number }[])
      .map((row) => [row.id, row]),
  );
  state.serverOrderStatus = (order.data as { status: string } | null)?.status ?? null;

  type ServerReceipt = {
    // `received_at` is `not null` in the schema, so there is nothing to fall back to and no
    // second timestamp to fall back on — the fallback that used to sit here named the absent column.
    id: string; status: 'draft' | 'completed'; received_at: string;
    received_by: string | null; items: { order_item_id: string; qty_received: number }[];
  };
  const serverReceipts = (receipts.data ?? []) as ServerReceipt[];
  // The receipt this key refers to, if the server knows it; otherwise the draft that blocks us.
  const relevant = serverReceipts.find((row) => row.id === input.receiptId)
    ?? serverReceipts.find((row) => row.status === 'draft')
    ?? serverReceipts[0]
    ?? null;
  if (relevant) {
    state.serverReceiptId = relevant.id;
    state.serverReceiptStatus = relevant.status;
    state.serverReceiptAt = relevant.received_at;
    if (relevant.received_by) {
      // Same lookup AuditLog/fetchActorNames use, and the same fallback: RLS may hide the name,
      // and an unknown actor reads as — rather than as a guess.
      const { data } = await supabase.from('profiles')
        .select(RECEIPT_CONFLICT_READ.profiles.select).eq('id', relevant.received_by).maybeSingle();
      state.serverActorName = (data as { full_name: string } | null)?.full_name ?? '—';
    }
    if (state.serverActorName === '—') {
      const { data } = await supabase.from('audit_logs')
        .select(RECEIPT_CONFLICT_READ.audit_logs.select)
        .eq('entity_type', 'goods_receipts')
        .eq('entity_id', relevant.id)
        .order(RECEIPT_CONFLICT_READ.audit_logs.order, { ascending: false })
        .limit(1)
        .maybeSingle();
      const actorId = (data as { user_id: string | null } | null)?.user_id ?? null;
      if (actorId) {
        const profile = await supabase.from('profiles')
          .select(RECEIPT_CONFLICT_READ.profiles.select).eq('id', actorId).maybeSingle();
        state.serverActorName = (profile.data as { full_name: string } | null)?.full_name ?? '—';
      }
    }
  }

  const serverDraftQty = new Map<string, number>(
    (relevant?.items ?? []).map((row) => [row.order_item_id, row.qty_received]),
  );

  state.lines = input.localLines.map((line) => {
    const item = serverItems.get(line.order_item_id);
    const product = input.products.get(line.order_item_id);
    const orderedQty = item?.qty ?? null;
    const serverReceivedQty = item?.received_qty ?? null;
    return {
      orderItemId: line.order_item_id,
      productName: product?.label ?? '—',
      unit: product?.unit ?? '',
      localQty: line.qty_received,
      localStatus: line.status,
      localNotes: line.notes,
      orderedQty,
      serverReceivedQty,
      serverRemaining: orderedQty !== null && serverReceivedQty !== null
        ? Math.max(0, orderedQty - serverReceivedQty)
        : null,
      serverDraftQty: serverDraftQty.get(line.order_item_id) ?? null,
    };
  });

  return state;
}

/**
 * Derives the line payload for a re-send from a per-line human decision.
 *
 * The status is re-derived from the chosen quantity against the server's remaining, because the
 * server validates the pair (`0023:1518-1522`) and a stale `full` on a reduced remainder is exactly
 * what produced the rejection. `damaged`/`returned` are quality judgements about goods and are never
 * overwritten by arithmetic.
 */
export function decidedLines(
  lines: readonly ReceiptConflictLine[],
  choice: Readonly<Record<string, 'local' | 'server'>>,
): OfflineReceiptLine[] {
  return lines.map((line) => {
    if (line.serverRemaining === null) {
      throw new Error('receipt_conflict_server_state_unknown');
    }
    const takeServer = choice[line.orderItemId] === 'server';
    const qty = takeServer ? line.serverDraftQty ?? line.serverRemaining : line.localQty;
    const bounded = Math.max(0, Math.min(qty, line.serverRemaining));
    const status: ReceiptLineStatusValue = ['damaged', 'returned'].includes(line.localStatus)
      ? line.localStatus
      : bounded === 0 ? 'missing' : bounded < line.serverRemaining ? 'partial' : 'full';
    return {
      order_item_id: line.orderItemId,
      qty_received: bounded,
      status,
      notes: line.localNotes,
    };
  });
}

/* ============================ the dialog ============================ */

export interface ReceiptConflictResolution {
  kind: ConflictOptionKind;
  lines: OfflineReceiptLine[];
  explanation: string;
}

export default function ReceiptConflictDialog({ conflict, busy, onClose, onResolve }: {
  conflict: ReceiptConflictState | null;
  busy?: boolean;
  onClose: () => void;
  onResolve: (resolution: ReceiptConflictResolution) => void;
}) {
  const { locale, statusLabel, t } = useT();
  const explanationId = useId();
  const [explanation, setExplanation] = useState('');
  const [choice, setChoice] = useState<Record<string, 'local' | 'server'>>({});

  useEffect(() => {
    if (!conflict) return;
    setExplanation('');
    setChoice(Object.fromEntries(conflict.lines.map((line) => [line.orderItemId, 'local' as const])));
  }, [conflict]);

  const presentation = useMemo(
    () => (conflict ? conflictPresentation(conflict.code, { queuedReplay: conflict.queuedReplay }) : null),
    [conflict],
  );

  if (!conflict || !presentation) return null;

  const canResend = presentation.resendable
    && conflict.rereadErrorKey === null
    && conflict.lines.length > 0
    && conflict.lines.every((line) => (
      line.orderedQty !== null
      && line.serverReceivedQty !== null
      && line.serverRemaining !== null
    ));
  const showLineDecision = presentation.perLineDecision && canResend;
  const availableOptions = presentation.options.filter((option) => (
    option.kind !== 'resend-decided' || canResend
  ));

  const disagreeing = conflict.lines.filter((line) =>
    line.serverRemaining !== null && (
      line.localQty !== (line.serverDraftQty ?? line.localQty)
      || line.localQty > line.serverRemaining
    ));

  const submit = (kind: ConflictOptionKind) => {
    if (kind === 'resend-decided' && !canResend) return;
    onResolve({
      kind,
      lines: kind === 'resend-decided' ? decidedLines(conflict.lines, choice) : [],
      explanation: explanation.trim(),
    });
  };

  return (
    <Modal open onClose={onClose} title={t(presentation.titleKey)} wide busy={busy}
      description={t(presentation.summaryKey)}>
      <div className="space-y-4">
        {/* The summary is the Modal's `description` — rendered once, under the title, and named by
            `aria-describedby`. It used to be printed a second time here, word for word, which
            pushed the comparison table (the part that carries the information) off the screen. */}
        {conflict.rereadErrorKey && <Note tone="await">{t(conflict.rereadErrorKey)}</Note>}

        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-ink-soft">{t('receiptConflict.text')}</dt>
            <dd className="text-ink">
              {conflict.supplierName} · <span className="num">#{conflict.orderNumber ?? '—'}</span>
            </dd>
          </div>
          <div>
            <dt className="text-ink-soft">{t('receiptConflict.text_2')}</dt>
            <dd className="text-ink">{conflict.serverOrderStatus ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-ink-soft">{t('receiptConflict.text_3')}</dt>
            <dd className="text-ink num">{receiptClock(conflict.localObservedAt)}</dd>
          </div>
          <div>
            <dt className="text-ink-soft">{t('receiptConflict.text_4')}</dt>
            <dd className="text-ink num">{fmtDateTime(conflict.serverReceiptAt)}</dd>
          </div>
          <div>
            <dt className="text-ink-soft">{t('receiptConflict.text_5')}</dt>
            <dd className="text-ink">{conflict.serverActorName}</dd>
          </div>
          <div>
            <dt className="text-ink-soft">{t('receiptConflict.text_6')}</dt>
            <dd className="text-ink">
              {conflict.serverReceiptStatus === 'completed' ? t('receiptConflict.text_7')
                : conflict.serverReceiptStatus === 'draft' ? t('receiptConflict.text_8') : '—'}
            </dd>
          </div>
        </dl>

        {/* A wide table is a keyboard-scrollable region, not a mouse-only viewport — the same
            contract DataTable's scroller carries. `.table-scroll` also contains the inline size,
            which is what stops the widest product name from pushing the dialog past 390px.
            `.th`/`.td` are the shared cell classes: without `.th` these headers were dark ink on
            the oceanic `.table-head` bar, because that rule is scoped to `.th`. `whitespace-normal`
            is a deliberate local narrowing of `.td` for the two cells that hold prose. */}
        <div className="table-scroll overflow-x-auto" role="region" tabIndex={0}
          aria-label={t('receiptConflict.aria_label')}>
          <table className="w-full text-sm">
            <caption className="sr-only">{t('receiptConflict.text_9')}</caption>
            <thead className="table-head">
              <tr className="border-b border-line">
                <th scope="col" className="th">{t('receiptConflict.text_10')}</th>
                <th scope="col" className="th">{t('receiptConflict.text_11')}</th>
                <th scope="col" className="th">{t('receiptConflict.text_12')}</th>
                {showLineDecision && (
                  <th scope="col" className="th">{t('receiptConflict.text_13')}</th>
                )}
              </tr>
            </thead>
            <tbody>
              {conflict.lines.map((line) => (
                <tr key={line.orderItemId} className="border-b border-line-soft align-top">
                  <td className="td whitespace-normal">
                    <div className="text-ink"><bdi>{line.productName}</bdi></div>
                    <div className="text-xs text-ink-muted">
                      {t('receiptConflict.orderedWord')}{' '}<span className="num">{formatQuantity(line.orderedQty, line.unit, locale)}</span>
                    </div>
                  </td>
                  <td className="td">
                    <span className="num">{line.localQty}</span>{' '}
                    <span className="text-xs text-ink-muted">
                      {statusLabel(RECEIPT_LINE_STATUS[line.localStatus]) || line.localStatus}
                    </span>
                  </td>
                  <td className="td whitespace-normal">
                    <div>
                      {t('receiptConflict.remainingWord')}{' '}<span className="num">{line.serverRemaining ?? '—'}</span>
                    </div>
                    <div className="text-xs text-ink-muted">
                      {t('receiptConflict.receivedBeforeWord')}{' '}<span className="num">{line.serverReceivedQty ?? '—'}</span>
                      {line.serverDraftQty !== null && (
                        <> {t('receiptConflict.text_14')} <span className="num">{line.serverDraftQty}</span></>
                      )}
                    </div>
                  </td>
                  {showLineDecision && (
                    <td className="td">
                      {/* One of the app's three hand-rolled pick-one controls; now the shared
                          ToggleGroup. The per-line identity stays inside each button's accessible
                          name — a screen-reader user meeting one chip out of context still hears
                          which product it decides. */}
                      <ToggleGroup
                        label={t('receiptConflict.decisionFor', { product: line.productName })}
                        value={choice[line.orderItemId]}
                        onChange={(value) => setChoice((current) => ({ ...current, [line.orderItemId]: value }))}
                        items={([['local', t('receiptConflict.map')], ['server', t('receiptConflict.map_2')]] as const).map(([value, label]) => ({
                          key: value,
                          // Two spans, not one string with a hidden tail: the accessible-name
                          // algorithm trims every text node before joining them, so a leading
                          // space would be eaten and the name would read "המכשירעבור עגבניות".
                          // The whole sentence is therefore ONE text node in the sr-only span,
                          // and the visible chip is aria-hidden.
                          label: (
                            <>
                              <span aria-hidden="true">{label}</span>
                              <span className="sr-only">{t('receiptConflict.optionFor', { option: label, product: line.productName })}</span>
                            </>
                          ),
                        }))}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {showLineDecision && (
          <p className="text-xs text-ink-muted">
            {disagreeing.length
              ? <>{t('receiptConflict.text_15')} <span className="num">{disagreeing.length}</span>{t('receiptConflict.text_16')}</>
              : t('receiptConflict.text_17')}
          </p>
        )}

        {presentation.requiresExplanation && canResend && (
          <div>
            <label className="label" htmlFor={explanationId}>
              {t('receiptConflict.text_18')}
            </label>
            <textarea id={explanationId} className="input" rows={2} maxLength={1000}
              value={explanation} onChange={(event) => setExplanation(event.target.value)} />
          </div>
        )}

        {presentation.localOnlyNoteKey && <Note tone="info">{t(presentation.localOnlyNoteKey)}</Note>}

        <div className="flex flex-wrap justify-end gap-2">
          {/* Not "סגירה": the Modal's own close control already answers to that name, and one dialog
              must not offer two identically named buttons. */}
          <button type="button" className="btn-secondary min-h-11" disabled={busy} onClick={onClose}>
            {t('receiptConflict.text_19')}
          </button>
          {availableOptions.map((option) => (
            <button key={option.kind} type="button"
              className={`${option.danger ? 'btn-danger' : 'btn-primary'} min-h-11`}
              disabled={busy || (option.kind === 'resend-decided' && presentation.requiresExplanation && !explanation.trim())}
              onClick={() => submit(option.kind)}>
              {t(option.labelKey)}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
