import { useEffect, useId, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { fmtDateTime, formatQuantity } from '../lib/format';
import { RECEIPT_LINE_STATUS } from '../lib/status';
import { receiptClock, type ReceiptConflictCode } from '../lib/offlineQueue';
import type { OfflineReceiptLine, ReceiptLineStatusValue } from '../lib/offlineDb';
import { Modal, Note } from './ui';

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
  serverReceiptId: string | null;
  serverReceiptStatus: 'draft' | 'completed' | null;
  serverReceiptAt: string | null;
  /** '—' whenever the name is unknown or RLS hides it, exactly like `fetchActorNames`. */
  serverActorName: string;
  serverOrderStatus: string | null;
  /** Set when the re-read itself could not be completed; the screen says so instead of guessing. */
  rereadError: string | null;
}

export type ConflictOptionKind = 'resend-decided' | 'keep-local' | 'discard-local';

export interface ConflictPresentation {
  title: string;
  /** What the server actually said, in Hebrew, naming the situation rather than the error code. */
  summary: string;
  /** Whether a per-line human decision (local value / server value) is offered. */
  perLineDecision: boolean;
  /** Whether a resolution can produce a new server write at all. */
  resendable: boolean;
  requiresExplanation: boolean;
  options: { kind: ConflictOptionKind; label: string; danger?: boolean }[];
  /** Honest note when a resolution writes nothing to the server, so no audit row is created. */
  localOnlyNote: string | null;
}

/**
 * One place that decides what each of the five rejections offers.
 *
 * Exported and pure so the mapping is a tested claim rather than JSX nobody can assert on.
 */
export function conflictPresentation(code: ReceiptConflictCode): ConflictPresentation {
  const keepLocal = { kind: 'keep-local' as const, label: 'השארת הטיוטה במכשיר' };
  const discardLocal = { kind: 'discard-local' as const, label: 'מחיקת הטיוטה המקומית', danger: true };
  const localOnly =
    'הכרעה זו אינה שולחת פעולה לשרת, ולכן אינה נרשמת ביומן הביקורת. הרישום נוצר רק כשנשלחת קבלה.';

  switch (code) {
    case 'receipt_qty_exceeds_order':
      return {
        title: 'הכמויות בקבלה אינן תואמות למה שנותר בהזמנה',
        summary:
          'השרת דחה את הקבלה: לפחות שורה אחת חורגת מהכמות שנותרה, או שסטטוס "מלא" אינו שווה בדיוק ליתרה. '
          + 'ייתכן שאדם אחר קלט מהזמנה זו בזמן שהמכשיר היה לא־מקוון. בחר לכל שורה מה נכון — הכמות שנרשמה '
          + 'במכשיר או הכמות שהשרת מכיר — ואל תסמוך על מיזוג אוטומטי: אין כזה.',
        perLineDecision: true,
        resendable: true,
        requiresExplanation: true,
        options: [{ kind: 'resend-decided', label: 'שליחה לפי ההכרעה' }, keepLocal],
        localOnlyNote: null,
      };
    case 'receipt_draft_conflict':
      return {
        title: 'קיימת טיוטת קבלה אחרת להזמנה הזו',
        summary:
          'בשרת פתוחה טיוטת קבלה אחרת לאותה הזמנה, ולכן הקבלה שנרשמה במכשיר לא נשלחה. '
          + 'שתי טיוטות לאותה הזמנה אינן ניתנות למיזוג אוטומטי — צריך להחליט איזו מהן מתארת את המשלוח.',
        perLineDecision: false,
        resendable: false,
        requiresExplanation: false,
        options: [keepLocal, discardLocal],
        localOnlyNote: localOnly,
      };
    case 'receipt_already_completed':
      return {
        title: 'הקבלה הזו כבר הושלמה בשרת',
        summary:
          'הקבלה נסגרה בשרת עם תוכן אחר ממה שנרשם במכשיר. קבלה שהושלמה אינה נדרסת — '
          + 'הטיוטה המקומית נשמרת ומוצגת, וההכרעה אנושית ומפורשת.',
        perLineDecision: false,
        resendable: false,
        requiresExplanation: false,
        options: [keepLocal, discardLocal],
        localOnlyNote: localOnly,
      };
    case 'receipt_idempotency_conflict':
      return {
        title: 'אותה קבלה כבר נשלחה עם פרטים אחרים',
        summary:
          'מפתח הקבלה מוכר לשרת, אך התוכן שנשמר תחתיו שונה מהתוכן שבמכשיר. השרת אינו מחליף תוכן של קבלה '
          + 'קיימת בשקט, ולכן שום דבר לא נכתב. יש לבדוק מה נשמר בשרת לפני שמחליטים.',
        perLineDecision: false,
        resendable: false,
        requiresExplanation: false,
        options: [keepLocal, discardLocal],
        localOnlyNote: localOnly,
      };
    case 'purchase_order_not_receivable':
      return {
        title: 'ההזמנה אינה במצב שמאפשר קבלת סחורה',
        summary:
          'סטטוס ההזמנה בשרת השתנה (למשל בוטלה) בזמן שהמכשיר היה לא־מקוון, ולכן לא ניתן לקלוט אליה סחורה. '
          + 'הטיוטה נשמרת כדי שהדיווח על מה שהגיע לא יאבד; הטיפול דורש הכרעה עסקית בהזמנה עצמה.',
        perLineDecision: false,
        resendable: false,
        requiresExplanation: false,
        options: [keepLocal, discardLocal],
        localOnlyNote: localOnly,
      };
  }
}

/* ============================ the re-read ============================ */

interface ConflictReadInput {
  orderId: string;
  receiptId: string;
  orderNumber: number | null;
  supplierName: string;
  localLines: OfflineReceiptLine[];
  products: Map<string, { name: string; unit: string }>;
  localObservedAt: number;
  code: ReceiptConflictCode;
}

/**
 * Re-reads the server rows the conflict is about and pairs them with the local claim.
 *
 * A blocked or partial read degrades to `—` and a stated `rereadError`. Local work can still be kept
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
    serverReceiptId: null,
    serverReceiptStatus: null,
    serverReceiptAt: null,
    serverActorName: '—',
    serverOrderStatus: null,
    rereadError: null,
  };

  const [items, order, receipts] = await Promise.all([
    supabase.from('purchase_order_items').select('id, qty, received_qty').eq('order_id', input.orderId),
    supabase.from('purchase_orders').select('status').eq('id', input.orderId).maybeSingle(),
    supabase.from('goods_receipts')
      .select('id, status, received_at, created_at, received_by, items:goods_receipt_items(order_item_id, qty_received)')
      .eq('order_id', input.orderId)
      .order('created_at', { ascending: false }),
  ]);

  if (items.error || order.error || receipts.error) {
    state.rereadError = 'לא ניתן היה לקרוא מחדש את נתוני ההזמנה מהשרת. ערכים לא ידועים מוצגים כ־—, ושליחה מחדש חסומה עד לקריאה מוצלחת.';
  }

  const serverItems = new Map(
    ((items.data ?? []) as { id: string; qty: number; received_qty: number }[])
      .map((row) => [row.id, row]),
  );
  state.serverOrderStatus = (order.data as { status: string } | null)?.status ?? null;

  type ServerReceipt = {
    id: string; status: 'draft' | 'completed'; received_at: string | null; created_at: string;
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
    state.serverReceiptAt = relevant.received_at ?? relevant.created_at;
    if (relevant.received_by) {
      // Same lookup AuditLog/fetchActorNames use, and the same fallback: RLS may hide the name,
      // and an unknown actor reads as — rather than as a guess.
      const { data } = await supabase.from('profiles').select('full_name').eq('id', relevant.received_by).maybeSingle();
      state.serverActorName = (data as { full_name: string } | null)?.full_name ?? '—';
    }
    if (state.serverActorName === '—') {
      const { data } = await supabase.from('audit_logs')
        .select('user_id')
        .eq('entity_type', 'goods_receipts')
        .eq('entity_id', relevant.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const actorId = (data as { user_id: string | null } | null)?.user_id ?? null;
      if (actorId) {
        const profile = await supabase.from('profiles').select('full_name').eq('id', actorId).maybeSingle();
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
      productName: product?.name ?? '—',
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
  const explanationId = useId();
  const [explanation, setExplanation] = useState('');
  const [choice, setChoice] = useState<Record<string, 'local' | 'server'>>({});

  useEffect(() => {
    if (!conflict) return;
    setExplanation('');
    setChoice(Object.fromEntries(conflict.lines.map((line) => [line.orderItemId, 'local' as const])));
  }, [conflict]);

  const presentation = useMemo(
    () => (conflict ? conflictPresentation(conflict.code) : null),
    [conflict],
  );

  if (!conflict || !presentation) return null;

  const canResend = presentation.resendable
    && conflict.rereadError === null
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
    <Modal open onClose={onClose} title={presentation.title} wide busy={busy}
      description={presentation.summary}>
      <div className="space-y-4">
        <Note tone="alert">{presentation.summary}</Note>
        {conflict.rereadError && <Note tone="await">{conflict.rereadError}</Note>}

        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-ink-soft">הזמנה</dt>
            <dd className="text-ink">
              {conflict.supplierName} · <span className="num">#{conflict.orderNumber ?? '—'}</span>
            </dd>
          </div>
          <div>
            <dt className="text-ink-soft">סטטוס ההזמנה בשרת</dt>
            <dd className="text-ink">{conflict.serverOrderStatus ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-ink-soft">נרשם במכשיר</dt>
            <dd className="text-ink num">{receiptClock(conflict.localObservedAt)}</dd>
          </div>
          <div>
            <dt className="text-ink-soft">חותמת הקבלה בשרת</dt>
            <dd className="text-ink num">{fmtDateTime(conflict.serverReceiptAt)}</dd>
          </div>
          <div>
            <dt className="text-ink-soft">מי עדכן בשרת</dt>
            <dd className="text-ink">{conflict.serverActorName}</dd>
          </div>
          <div>
            <dt className="text-ink-soft">סטטוס הקבלה בשרת</dt>
            <dd className="text-ink">
              {conflict.serverReceiptStatus === 'completed' ? 'הושלמה'
                : conflict.serverReceiptStatus === 'draft' ? 'טיוטה' : '—'}
            </dd>
          </div>
        </dl>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">השוואת הכמויות בין המכשיר לשרת</caption>
            <thead className="table-head">
              <tr className="border-b border-line text-start text-xs text-ink-soft">
                <th scope="col" className="py-2 text-start font-medium">פריט</th>
                <th scope="col" className="py-2 text-start font-medium">במכשיר</th>
                <th scope="col" className="py-2 text-start font-medium">בשרת</th>
                {showLineDecision && (
                  <th scope="col" className="py-2 text-start font-medium">ההכרעה</th>
                )}
              </tr>
            </thead>
            <tbody>
              {conflict.lines.map((line) => (
                <tr key={line.orderItemId} className="border-b border-line-soft align-top">
                  <td className="py-2 pe-2">
                    <div className="text-ink">{line.productName}</div>
                    <div className="text-xs text-ink-muted">
                      הוזמן <span className="num">{formatQuantity(line.orderedQty, line.unit)}</span>
                    </div>
                  </td>
                  <td className="py-2 pe-2">
                    <span className="num">{line.localQty}</span>{' '}
                    <span className="text-xs text-ink-muted">
                      {RECEIPT_LINE_STATUS[line.localStatus]?.label ?? line.localStatus}
                    </span>
                  </td>
                  <td className="py-2 pe-2">
                    <div>
                      נותר לקבלה: <span className="num">{line.serverRemaining ?? '—'}</span>
                    </div>
                    <div className="text-xs text-ink-muted">
                      התקבל בעבר: <span className="num">{line.serverReceivedQty ?? '—'}</span>
                      {line.serverDraftQty !== null && (
                        <> · בטיוטת השרת: <span className="num">{line.serverDraftQty}</span></>
                      )}
                    </div>
                  </td>
                  {showLineDecision && (
                    <td className="py-2">
                      <div className="flex flex-wrap gap-1.5">
                        {([['local', 'המכשיר'], ['server', 'השרת']] as const).map(([value, label]) => (
                          <button key={value} type="button"
                            className={`rounded-lg border min-h-11 px-3 text-xs font-medium transition-colors ${
                              choice[line.orderItemId] === value
                                ? 'bg-action text-white border-action'
                                : 'border-line text-ink-soft hover:bg-action-wash'}`}
                            aria-pressed={choice[line.orderItemId] === value}
                            aria-label={`${label} עבור ${line.productName}`}
                            onClick={() => setChoice((current) => ({ ...current, [line.orderItemId]: value }))}>
                            {label}
                          </button>
                        ))}
                      </div>
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
              ? <>שורות שבהן הערכים נבדלים: <span className="num">{disagreeing.length}</span>. מיזוג אוטומטי של כמויות אינו קיים בכוונה — כמות היא טענה על סחורה שהגיעה.</>
              : 'הערכים במכשיר ובשרת זהים בשורות שנקראו. אם השרת דחה בכל זאת, בדוק את סטטוס ההזמנה ואת הקבלה שכבר קיימת.'}
          </p>
        )}

        {presentation.requiresExplanation && canResend && (
          <div>
            <label className="label" htmlFor={explanationId}>
              הסבר להכרעה (חובה — נרשם ביומן הביקורת עם הקבלה)
            </label>
            <textarea id={explanationId} className="input" rows={2} maxLength={1000}
              value={explanation} onChange={(event) => setExplanation(event.target.value)} />
          </div>
        )}

        {presentation.localOnlyNote && <Note tone="info">{presentation.localOnlyNote}</Note>}

        <div className="flex flex-wrap justify-end gap-2">
          {/* Not "סגירה": the Modal's own close control already answers to that name, and one dialog
              must not offer two identically named buttons. */}
          <button type="button" className="btn-secondary min-h-11" disabled={busy} onClick={onClose}>
            סגירה בלי הכרעה
          </button>
          {availableOptions.map((option) => (
            <button key={option.kind} type="button"
              className={`${option.danger ? 'btn-danger' : 'btn-primary'} min-h-11`}
              disabled={busy || (option.kind === 'resend-decided' && presentation.requiresExplanation && !explanation.trim())}
              onClick={() => submit(option.kind)}>
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
