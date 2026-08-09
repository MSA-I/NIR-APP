import { useEffect, useRef, useState } from 'react';
import { toHebrewError } from '../lib/errors';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Loader2, Send, CheckCircle2, RotateCcw, SearchCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { Breadcrumbs, useToast, StatusBadge, LifecycleStrip, Modal, ConfirmDialog, ErrorNote, Note, RecordHeader, RecordSkeleton } from '../components/ui';
import { InvoiceAttachments } from '../components/AttachmentsPanel';
import { CheckList } from './Invoices';
import { runInvoiceChecks, type CheckResult } from '../lib/checks';
import { INVOICE_REVIEW_STATUS, INVOICE_PAYMENT_STATUS, INVOICE_EXPORT_STATUS, CREDIT_REASON } from '../lib/status';
import { fmtMoneyExact, fmtDate, todayISO } from '../lib/format';
import { creditDraftFromInterpretation, type CreditDraft } from '../components/document-review/model';
import type { InterpretationContract } from '../lib/useDocumentProcessing';
import type { Invoice, InvoiceReviewStatus, CreditReason } from '../lib/types';

type FullInvoice = Invoice & {
  supplier: { id: string; name: string };
  orders: { order_id: string; purchase_orders: { id: string; number: number; status: string } }[];
  receipts: { receipt_id: string; goods_receipts: { id: string; number: number; received_at: string } }[];
};

/**
 * The review actions this screen can offer, in reading order.
 *
 * This is **copy and order only** — which of them is legal from the current status is answered by
 * `read_allowed_transitions('invoice_review', …)` (migration 0070), because the graph belongs to
 * `set_invoice_review_status` and a second copy of it in the browser is a second answer. The reader
 * returns an unordered set by contract, so the order lives here, next to the labels, in the same
 * sequence as `INVOICE_REVIEW_STATUS` in `src/lib/status.ts`.
 *
 * OPEN-DECISIONS #105 — the one visible consequence of deleting the local matrix:
 * **`approved` → `investigation` is now offered.** The server has allowed it since 0023 (any status
 * other than `investigation` may move INTO investigation) and it is the right behaviour: finding a
 * problem in an already-approved invoice is exactly when an investigation is needed. The browser was
 * hiding a legal, reasoned, audited transition. Anything else that appears or disappears here is a
 * bug, not this change.
 */
export const INVOICE_REVIEW_ACTIONS: { to: InvoiceReviewStatus; label: string }[] = [
  { to: 'in_review', label: 'העברה לבדיקה' },
  { to: 'pending_approval', label: 'העברה לאישור' },
  { to: 'approved', label: 'אישור לתשלום' },
  { to: 'investigation', label: 'סימון לבירור' },
];

export type InvoicePrimaryAction = InvoiceReviewStatus | 'payment-request';

export function invoicePrimaryAction(
  transitions: readonly { to: InvoiceReviewStatus }[],
  reviewStatus: InvoiceReviewStatus,
  paymentStatus: string,
): InvoicePrimaryAction | null {
  if (reviewStatus === 'approved' && paymentStatus !== 'paid') return 'payment-request';
  return transitions.find((action) => action.to !== 'investigation')?.to ?? null;
}

export function invoiceLifecycle(status: InvoiceReviewStatus) {
  if (status === 'received' || status === 'in_review') return [
    { key: 'received', label: 'התקבלה' },
    { key: 'in_review', label: 'בבדיקה' },
    { key: 'pending_approval', label: 'ממתינה לאישור' },
    { key: 'approved', label: 'מאושרת' },
  ];
  if (status === 'pending_approval') return [
    { key: 'pending_approval', label: 'ממתינה לאישור' },
    { key: 'approved', label: 'מאושרת' },
  ];
  if (status === 'approved') return [{ key: 'approved', label: 'מאושרת' }];
  return [];
}

/**
 * Reads the status graph from the server.
 *
 * Returns `null` — never a guess — when the read fails: the caller disables the controls and says
 * so. Inventing a fallback matrix here would recreate the very duplicate this replaces, and the
 * duplicate is what drifted. `read_allowed_transitions` is SECURITY INVOKER and answers a question
 * about the machine ("what would the command accept from here"), not about the caller; role
 * authorisation stays inside `set_invoice_review_status`, where it is audited.
 */
export async function readAllowedInvoiceTransitions(
  currentStatus: string,
): Promise<InvoiceReviewStatus[] | null> {
  const { data, error } = await supabase.rpc('read_allowed_transitions', {
    p_entity_type: 'invoice_review',
    p_current_status: currentStatus,
  });
  if (error) return null;
  const rows = (data ?? []) as { next_status: string }[];
  const known = new Set(rows.map((row) => row.next_status));
  // Zero rows is a legitimate answer (a terminal status), and it is NOT the same value as a failed
  // read: it yields an empty array, which hides the buttons instead of disabling them.
  return INVOICE_REVIEW_ACTIONS.filter((action) => known.has(action.to)).map((action) => action.to);
}

export default function InvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const toast = useToast();
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const checkSequence = useRef(0);
  const [checking, setChecking] = useState(false);
  const [creditOpen, setCreditOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reviewTarget, setReviewTarget] = useState<InvoiceReviewStatus | null>(null);
  const isProcurementManager = profile?.role === 'office';
  const canOpenProcurement = profile?.role !== 'accountant';

  const { data, loading, error, refetch } = useQuery(async () => {
    const invoice = unwrap(await supabase.from('invoices')
      .select('*, supplier:suppliers(id, name), orders:invoice_order_links(order_id, purchase_orders(id, number, status)), receipts:invoice_receipt_links(receipt_id, goods_receipts(id, number, received_at))')
      .eq('id', id!).single()) as FullInvoice;
    const balance = isProcurementManager
      ? null
      : unwrap(await supabase.from('invoice_balances').select('*').eq('invoice_id', id!).maybeSingle()) as
        { paid_amount: number; credited_amount: number; balance: number } | null;
    const allocations = isProcurementManager
      ? []
      : unwrap(await supabase.from('payment_allocations')
        .select('amount, payment:payments(id, number, paid_date, reference, amount)')
        .eq('invoice_id', id!)) as { amount: number; payment: { number: number; paid_date: string; reference: string | null } }[];
    // Fetched with the invoice on purpose: the graph depends on the status this read just returned,
    // so a separate query would need its own loading state and would blank or flicker the action
    // row. `readAllowedInvoiceTransitions` resolves to null instead of throwing, so a failure of
    // the graph read cannot take the invoice down with it.
    const allowedTransitions = await readAllowedInvoiceTransitions(invoice.review_status);
    return { invoice, balance, allocations, allowedTransitions };
  }, [id, isProcurementManager]);

  const inv = data?.invoice;
  const canEdit = profile && ['owner', 'office', 'kitchen'].includes(profile.role);
  const isOffice = profile && ['owner', 'office'].includes(profile.role);

  // ?print=1 (Invoices list "הדפסה" action): print once when the data is on screen, then strip
  // the param so refresh/back does not re-open the dialog. Same one-shot pattern as OrderDetail.
  const [params, setParams] = useSearchParams();
  const printedRef = useRef<string | null>(null);
  useEffect(() => {
    if (printedRef.current === inv?.id || params.get('print') !== '1' || !inv) return;
    printedRef.current = inv.id;
    window.print();
    const next = new URLSearchParams(params);
    next.delete('print');
    setParams(next, { replace: true });
  }, [params, inv, setParams]);

  // ?credit=<documentId> (review screen, "פתיחת דרישת זיכוי מהמסמך"): open the ordinary credit
  // modal prefilled from the scanned credit note. Same one-shot pattern as ?print above -- the
  // param is stripped once consumed so a refresh does not reopen it over a credit already made.
  const [creditDraft, setCreditDraft] = useState<CreditDraft | null>(null);
  const creditDocumentRef = useRef<string | null>(null);
  useEffect(() => {
    const documentId = params.get('credit');
    if (!documentId || !inv || creditDocumentRef.current === documentId) return;
    creditDocumentRef.current = documentId;
    void (async () => {
      const res = await supabase.from('document_interpretations').select('payload')
        .eq('document_id', documentId).order('created_at', { ascending: false }).limit(1).maybeSingle();
      // A missing interpretation is not a reason to refuse: the modal still opens, empty, and the
      // reviewer types what the paper says.
      setCreditDraft(res.error || !res.data
        ? { amount: '', creditedInvoiceNumber: '', notes: '' }
        : creditDraftFromInterpretation((res.data as { payload: InterpretationContract }).payload));
      setCreditOpen(true);
      const next = new URLSearchParams(params);
      next.delete('credit');
      setParams(next, { replace: true });
    })();
  }, [params, inv, setParams]);

  useEffect(() => {
    checkSequence.current += 1;
    setChecks(null);
    setCheckError(null);
    setChecking(false);
  }, [id]);

  async function runChecks() {
    if (!inv) return;
    const sequence = ++checkSequence.current;
    setChecking(true);
    setChecks(null);
    setCheckError(null);
    try {
      const res = await runInvoiceChecks({
        id: inv.id, supplier_id: inv.supplier.id, invoice_number: inv.invoice_number,
        invoice_date: inv.invoice_date, total_amount: inv.total_amount,
        linkedOrderIds: inv.orders.map((o) => o.order_id),
      });
      if (checkSequence.current === sequence && id === inv.id) setChecks(res);
    } catch {
      if (checkSequence.current === sequence) setCheckError('הרצת הבדיקות נכשלה. לא ניתן להסיק שאין כפילות או תשלום קודם.');
    } finally {
      if (checkSequence.current === sequence) setChecking(false);
    }
  }

  async function setReviewStatus(status: InvoiceReviewStatus, reason?: string) {
    if (!inv) return;
    setBusy(true);
    const res = await supabase.rpc('set_invoice_review_status', {
      p_invoice_id: inv.id,
      p_status: status,
      p_reason: reason?.trim() || null,
    });
    setBusy(false);
    if (res.error) { toast(toHebrewError(res.error.message), 'error'); return; }
    setReviewTarget(null);
    toast('הסטטוס עודכן');
    void refetch();
  }

  if (loading) return <RecordSkeleton />;
  if (error && !data) return <ErrorNote message={error} />;
  if (!inv || !data) return <ErrorNote message="חשבונית לא נמצאה" />;

  // null = the graph could not be read. The controls are then rendered DISABLED rather than
  // filtered by a guess: offering a transition the server may reject, or hiding one it would
  // accept, are both worse than saying "not right now" out loud.
  const graphUnavailable = data.allowedTransitions === null;
  const transitions = graphUnavailable
    ? INVOICE_REVIEW_ACTIONS
    : INVOICE_REVIEW_ACTIONS.filter((action) => data.allowedTransitions!.includes(action.to));
  const primaryKey = graphUnavailable ? null : invoicePrimaryAction(transitions, inv.review_status, inv.payment_status);
  const primaryTransition = transitions.find((action) => action.to === primaryKey);
  const primaryAction = !isOffice ? null : primaryKey === 'payment-request' ? (
    <button className="btn-primary" onClick={() => navigate(`/payment-requests?new=${inv.id}`)}><Send size={15} /> יצירת דרישת תשלום</button>
  ) : primaryTransition ? (
    <button className="btn-primary" disabled={busy} onClick={() => setReviewTarget(primaryTransition.to)}>
      {primaryTransition.to === 'approved' ? <CheckCircle2 size={15} /> : <Send size={15} />}{primaryTransition.label}
    </button>
  ) : null;
  const nextAction = primaryKey === 'payment-request' ? 'יצירת דרישת תשלום'
    : primaryTransition?.label;
  const lifecycleSteps = invoiceLifecycle(inv.review_status);

  return (
    <div className="space-y-4 max-w-4xl">
      {error && <ErrorNote message={error} />}
      <RecordHeader className="no-print"
        breadcrumbs={<Breadcrumbs items={[{ label: 'חשבוניות', to: '/invoices' }, { label: inv.invoice_number }]} />}
        title={<>חשבונית <span dir="ltr" className="num">{inv.invoice_number}</span> — {inv.supplier.name}</>}
        status={<StatusBadge meta={INVOICE_REVIEW_STATUS[inv.review_status]} />}
        meta={<><span className="num font-semibold text-ink-body">{fmtMoneyExact(inv.total_amount)}</span><StatusBadge meta={INVOICE_PAYMENT_STATUS[inv.payment_status]} />{!isProcurementManager && <StatusBadge meta={INVOICE_EXPORT_STATUS[inv.export_status]} />}</>}
        primaryAction={primaryAction}
        secondaryActions={<>
          {isOffice && transitions.filter((transition) => transition.to !== primaryKey).map((transition) => (
            <button key={transition.to} className="btn-secondary" disabled={busy || graphUnavailable}
              onClick={() => setReviewTarget(transition.to)}>
              {transition.to === 'investigation' ? <SearchCheck size={15} /> : transition.to === 'approved' ? <CheckCircle2 size={15} /> : <Send size={15} />}{transition.label}
            </button>
          ))}
          {canEdit && <button className="btn-secondary" onClick={() => setCreditOpen(true)}><RotateCcw size={15} /> דרישת זיכוי</button>}
        </>}
        lifecycle={lifecycleSteps.length ? <LifecycleStrip steps={lifecycleSteps} current={inv.review_status} nextAction={nextAction} /> : undefined} />

      {/* Finding 8 / decision ח (08.08.2026): kitchen may CREATE an invoice (0023) but cannot
          amend or soft-delete one in any status (0034: owner/office only) — and until now the
          screen said nothing, so the person who typed the wrong amount had no next step. The
          decision was a reporting channel, not an edit path: the sentence names who can fix it
          and how, instead of offering a control the server would refuse. */}
      {profile?.role === 'kitchen' && (
        <p className="text-sm text-ink-muted no-print">
          טעות בסכום או בפרטי החשבונית? חשבונית אינה ניתנת לעריכה. יש לעדכן את מנהל הרכש —
          הוא יכול למחוק אותה (מחיקה רכה) וליצור אותה מחדש כטיוטה עם הקישורים להזמנה ולקבלה.
        </p>
      )}

      {isOffice && graphUnavailable && (
        <Note tone="alert" role="alert">
          לא ניתן לקרוא כרגע מהשרת אילו מעברי סטטוס מותרים מהמצב הנוכחי, ולכן עדכון הסטטוס חסום.
          רענן את המסך ונסה שוב.
        </Note>
      )}

      <ConfirmDialog open={reviewTarget !== null} onClose={() => setReviewTarget(null)}
        onConfirm={(reason) => reviewTarget && void setReviewStatus(reviewTarget, reason)}
        title="עדכון סטטוס בדיקת חשבונית"
        message="המעבר והסיבה יישמרו יחד ביומן הביקורת."
        confirmLabel="עדכון סטטוס" requireReason busy={busy} />

      {/* print-area on the money + details cards: shadows/borders drop in print so the sheet
          stays a clean invoice document (same convention as the Orders print sheet). */}
      <div className={`card grid overflow-hidden ${isProcurementManager ? 'grid-cols-1' : 'grid-cols-2 sm:grid-cols-4'}`}>
        <div className="p-4 print-area"><div className="text-xs text-ink-muted">סה״כ חשבונית</div><div className="text-lg font-bold num text-start">{fmtMoneyExact(inv.total_amount)}</div>
          <div className="text-xs text-ink-muted mt-0.5">לפני מע״מ {fmtMoneyExact(inv.amount_before_vat)} + מע״מ {fmtMoneyExact(inv.vat_amount)}</div></div>
        {!isProcurementManager && (
          <>
            {/* No invoice_balances row = the ledger has not been computed for this invoice, which is a
                different claim from "₪0.00 paid". fmtMoneyExact(null) renders — so the tile stays honest.
                The balance tile below keeps its ?? total_amount fallback: an invoice with no ledger row
                genuinely owes its full amount, which is a derivation, not an invented figure. */}
            <div className="border-s border-line-soft p-4 print-area"><div className="text-xs text-ink-muted">שולם</div><div className="text-lg font-bold num text-start text-done-fg">{fmtMoneyExact(data.balance?.paid_amount ?? null)}</div></div>
            {/* credited = already offset, a settled claim like "paid" — done, not the retired violet (audit 2026-07-21) */}
            <div className="border-t border-line-soft p-4 print-area sm:border-s sm:border-t-0"><div className="text-xs text-ink-muted">זוכה</div><div className="text-lg font-bold num text-start text-done-fg">{fmtMoneyExact(data.balance?.credited_amount ?? null)}</div></div>
            <div className="border-s border-t border-line-soft p-4 print-area sm:border-t-0"><div className="text-xs text-ink-muted">יתרה לתשלום</div><div className={`text-lg font-bold num text-start ${data.balance && data.balance.balance > 0 ? 'text-await-fg' : 'text-done-fg'}`}>{fmtMoneyExact(data.balance?.balance ?? inv.total_amount)}</div></div>
          </>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card card-pad space-y-3 print-area">
          <div className="section-title">פרטים</div>
          <dl className="text-sm space-y-2">
            <div className="flex justify-between"><dt className="text-ink-muted">תאריך חשבונית</dt><dd>{fmtDate(inv.invoice_date)}</dd></div>
            <div className="flex justify-between"><dt className="text-ink-muted">נקלטה במערכת</dt><dd>{fmtDate(inv.received_date)}</dd></div>
            <div className="flex justify-between"><dt className="text-ink-muted">ספק</dt><dd>{canOpenProcurement ? <Link className="link" to={`/suppliers/${inv.supplier.id}`}>{inv.supplier.name}</Link> : inv.supplier.name}</dd></div>
            <div className="flex justify-between"><dt className="text-ink-muted">הזמנות מקושרות</dt>
              <dd className="flex gap-2">{inv.orders.length ? inv.orders.map((o) => (
                canOpenProcurement
                  ? <Link key={o.order_id} className="link" to={`/orders/${o.order_id}`}>#{o.purchase_orders.number}</Link>
                  : <span key={o.order_id}>#{o.purchase_orders.number}</span>
              )) : '—'}</dd></div>
            <div className="flex justify-between"><dt className="text-ink-muted">קבלות סחורה</dt>
              <dd>{inv.receipts.length ? inv.receipts.map((r) => `#${r.goods_receipts.number}`).join(', ') : '—'}</dd></div>
          </dl>
          {inv.notes && <div className="text-sm text-ink-soft bg-surface-sunken rounded-lg px-3 py-2">{inv.notes}</div>}
        </div>

        {/* attachments/allocations are working-screen material, not part of the printed sheet */}
        <div className="card card-pad no-print">
          <InvoiceAttachments invoiceId={inv.id} receipts={inv.receipts.map((r) => r.goods_receipts)} />
          {data.allocations.length > 0 && (
            <div className="mt-4">
              <div className="text-sm font-medium text-ink-soft mb-2">תשלומים שהוקצו לחשבונית</div>
              <ul className="divide-y divide-line-soft border border-line-soft rounded-lg text-sm">
                {data.allocations.map((a, i) => (
                  <li key={i} className="flex justify-between px-3 py-2">
                    <span>תשלום #{a.payment.number} · {fmtDate(a.payment.paid_date)} {a.payment.reference && <span className="text-ink-muted" dir="ltr">({a.payment.reference})</span>}</span>
                    <span className="num font-medium">{fmtMoneyExact(a.amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      <div className="card card-pad no-print">
        <div className="flex items-center justify-between mb-3">
          <div className="section-title">בדיקות אוטומטיות</div>
          <button className="btn-secondary py-1.5!" onClick={() => void runChecks()} disabled={checking}>
            {checking ? <Loader2 size={14} className="animate-spin" /> : <SearchCheck size={15} />} הרצת בדיקות
          </button>
        </div>
        {checkError && <Note tone="alert">{checkError}</Note>}
        {checks ? <CheckList checks={checks} /> : !checking && !checkError && <div className="text-sm text-ink-muted">לחץ ״הרצת בדיקות״ להשוואת החשבונית מול הזמנות, קבלות, תשלומים ותנועות בנק.</div>}
      </div>

      {creditOpen && (
        <CreditFromInvoice invoice={inv} draft={creditDraft}
          onClose={() => { setCreditOpen(false); setCreditDraft(null); }}
          onSaved={() => { setCreditOpen(false); setCreditDraft(null); toast('דרישת הזיכוי נפתחה'); void refetch(); }} />
      )}
    </div>
  );
}

function CreditFromInvoice({ invoice, draft, onClose, onSaved }: {
  invoice: FullInvoice;
  /** Prefill from a scanned credit note; absent when the modal was opened by hand. */
  draft?: CreditDraft | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [creditRequestId] = useState(() => crypto.randomUUID());
  // The reason is never prefilled. `credit_reason` says why the business is owed money -- missing,
  // damaged, returned, wrong price -- and a credit note states an amount, not a cause.
  const [reason, setReason] = useState<CreditReason>('wrong_price');
  const [amount, setAmount] = useState(draft?.amount ?? '');
  const [notes, setNotes] = useState(draft?.notes ?? '');
  const [busy, setBusy] = useState(false);

  async function save() {
    const a = Number(amount);
    if (!a || a <= 0) { toast('סכום זיכוי לא תקין', 'error'); return; }
    setBusy(true);
    const res = await supabase.rpc('create_invoice_credit_request', {
      p_credit_request_id: creditRequestId,
      p_invoice_id: invoice.id,
      p_reason: reason,
      p_amount: a,
      p_notes: notes.trim() || null,
      p_audit_reason: 'פתיחת דרישת זיכוי מחשבונית',
    });
    setBusy(false);
    if (res.error) { toast(toHebrewError(res.error.message), 'error'); return; }
    onSaved();
  }

  return (
    <Modal open onClose={onClose} title={`דרישת זיכוי — חשבונית ${invoice.invoice_number}`} busy={busy} statusMessage={busy ? 'פותח את דרישת הזיכוי' : undefined}>
      <div className="space-y-4">
        <div>
          <label className="label" htmlFor="invoice-credit-reason">סיבת הזיכוי</label>
          <select id="invoice-credit-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value as CreditReason)}>
            {Object.entries(CREDIT_REASON).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div><label className="label" htmlFor="invoice-credit-amount">סכום (₪)</label><input id="invoice-credit-amount" type="number" step="0.01" className="input num" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        <div><label className="label" htmlFor="invoice-credit-notes">פירוט</label><textarea id="invoice-credit-notes" className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        <div className="text-xs text-ink-muted">נפתח בתאריך {fmtDate(todayISO())} · הזיכוי ישפיע על יתרת הספק לאחר אישור/קיזוז</div>
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <button className="btn-secondary" disabled={busy} onClick={onClose}>ביטול</button>
        <button className="btn-primary" disabled={busy} onClick={() => void save()}>פתיחת דרישת זיכוי</button>
      </div>
    </Modal>
  );
}
