import { useEffect, useRef, useState } from 'react';
import { toHebrewError } from '../lib/errors';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { FileDown, Loader2, Send, CheckCircle2, RotateCcw, SearchCheck, FilePenLine } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { Breadcrumbs, useToast, StatusBadge, LifecycleStrip, Modal, ConfirmDialog, ErrorNote, Note, RecordHeader, RecordSkeleton, Card, ICON } from '../components/ui';
import { InvoiceAttachments } from '../components/AttachmentsPanel';
import { CheckList } from './Invoices';
import { runInvoiceChecks, type CheckResult } from '../lib/checks';
import { reasonOr } from '../lib/reason';
import { downloadElementPdf } from '../lib/pdf';
import { exportWatermark } from '../lib/exportBranding';
import { reasonDemandFor } from '../lib/transitionIntent';
import { INVOICE_REVIEW_STATUS, INVOICE_PAYMENT_STATUS, INVOICE_EXPORT_STATUS, CREDIT_REASON } from '../lib/status';
import { fmtMoneyExact, fmtDate, formatQuantity, formatUnit, todayISO } from '../lib/format';
import { creditDraftFromInterpretation, type CreditDraft } from '../components/document-review/model';
import type { InterpretationContract } from '../lib/useDocumentProcessing';
import type { Invoice, InvoiceReviewStatus, CreditReason } from '../lib/types';
import { financialSupplierMap } from '../lib/financialSuppliers';
import { ReauthModal } from '../components/ReauthModal';
import {
  InvoiceLineReviewModal,
  type InvoiceReviewCandidate,
  type InvoiceReviewLine,
} from '../components/InvoiceLineReviewModal';

type FullInvoice = Omit<Invoice, 'supplier'> & {
  supplier: { id: string; name: string };
  orders: { order_id: string; purchase_orders: { id: string; number: number; status: string } }[];
  receipts: { receipt_id: string; goods_receipts: { id: string; number: number; received_at: string } }[];
};

type ThreeWayReason = {
  code: string;
  severity: 'critical' | 'error' | 'warning' | 'info';
  line_number?: number;
  expected?: number;
  actual?: number;
  ordered_unit_price?: number;
  invoice_unit_price_normalized?: number;
  difference_amount?: number;
  difference_percent?: number;
  ordered_quantity?: number;
  received_quantity?: number;
  prior_approved_invoiced_quantity?: number;
  current_invoice_quantity?: number;
  invoiced_quantity?: number;
  invoice_quantity?: number;
  allocated_quantity?: number;
  invoice_unit?: string;
  order_unit?: string;
  expected_vat_rate?: number;
  actual_vat_rate?: number;
};

type ThreeWayAssessment = {
  status: 'review_required' | 'not_comparable' | 'matched_with_warnings' | 'matched';
  approval_blocked: boolean;
  approval_allowed: boolean;
  definite_duplicate_invoice: boolean;
  assessment_hash: string;
  override_active: boolean;
  override?: { reason: string; created_at: string } | null;
  reasons: ThreeWayReason[];
  evidence_batch_id?: string | null;
  lines: (InvoiceReviewLine & { reasons: ThreeWayReason[] })[];
  candidate_context?: InvoiceReviewCandidate[];
};

const THREE_WAY_REASON_LABELS: Record<string, string> = {
  definite_duplicate_invoice: 'נמצאה חשבונית נוספת של אותו ספק עם אותו מספר — יש לתקן את הכפילות לפני אישור.',
  no_order_not_comparable: 'לחשבונית זו אין הזמנת רכש להשוואה',
  invoice_lines_missing: 'אין שורות חשבונית זמינות להתאמה.',
  duplicate_invoice_line_suspected: 'שורה זו חשודה ככפולה ונדרשת בדיקה; היא לא נמחקה ולא מוזגה.',
  missing_order_item: 'לא נמצא פריט הזמנה תואם באופן חד־משמעי.',
  multi_order_ambiguity: 'קיימות כמה התאמות אפשריות להזמנות שונות — נדרשת בחירה ידנית.',
  incomplete_explicit_allocation: 'הכמות בשורה לא הוקצתה במלואה לפריטי ההזמנה.',
  product_mismatch: 'המוצר בחשבונית שונה מהמוצר שהוזמן.',
  unit_or_packaging_conversion_requires_review: 'היחידות דורשות יחס אריזה מפורש ומאושר; המערכת לא הסיקה המרה מהטקסט.',
  legacy_order_unit_snapshot_missing: 'חסרה יחידת המידה שנשמרה בהזמנה, ולכן אי־אפשר להשוות בבטחה.',
  unit_price_above_order: 'מחיר היחידה בחשבונית גבוה ממחיר ההזמנה ביותר מ־1%.',
  unit_price_within_tolerance: 'מחיר היחידה שונה, אך הפער אינו עולה על 1%.',
  unit_price_below_order: 'מחיר היחידה בחשבונית נמוך ממחיר ההזמנה.',
  invoiced_quantity_above_ordered: 'הכמות שחויבה גבוהה מהכמות שהוזמנה.',
  invoiced_quantity_above_received: 'הכמות שחויבה גבוהה מהכמות שהתקבלה.',
  received_but_not_invoiced: 'התקבלה כמות שטרם חויבה בחשבונית.',
  line_arithmetic_discrepancy: 'חישוב השורה אינו מסתכם נכון מעבר ל־₪0.05.',
  invoice_net_total_discrepancy: 'סכום שורות החשבונית לפני מע״מ אינו תואם לסכום החשבונית.',
  invoice_vat_total_discrepancy: 'סכום המע״מ בשורות אינו תואם לסכום המע״מ בחשבונית מעבר ל־₪1.',
  invoice_grand_total_discrepancy: 'סך השורות אינו תואם לסך החשבונית מעבר ל־₪1.',
  vat_rate_mismatch: 'שיעור המע״מ בשורה שונה משיעור המע״מ המצופה.',
  expected_vat_rate_missing: 'אין שיעור מע״מ ארגוני מאושר להשוואה, ולכן לא ניתן לאשר את השורה.',
};

function threeWayReasonDetails(reason: ThreeWayReason) {
  if (reason.ordered_unit_price != null && reason.invoice_unit_price_normalized != null) {
    const difference = reason.difference_amount
      ?? reason.invoice_unit_price_normalized - reason.ordered_unit_price;
    const percent = reason.difference_percent
      ?? (reason.ordered_unit_price === 0 ? null : difference / reason.ordered_unit_price * 100);
    return `מחיר בהזמנה ${fmtMoneyExact(reason.ordered_unit_price)}, בחשבונית ${fmtMoneyExact(reason.invoice_unit_price_normalized)}, הפרש ${fmtMoneyExact(difference)}${percent == null ? '' : ` (${percent.toFixed(2)}%)`}`;
  }
  if (reason.invoiced_quantity != null) {
    const values = [
      reason.ordered_quantity == null ? null : `הוזמן ${reason.ordered_quantity}`,
      reason.received_quantity == null ? null : `התקבל ${reason.received_quantity}`,
      reason.prior_approved_invoiced_quantity == null
        ? null : `אושר בחשבוניות קודמות ${reason.prior_approved_invoiced_quantity}`,
      reason.current_invoice_quantity == null
        ? null : `בחשבונית זו ${reason.current_invoice_quantity}`,
      `חויב במצטבר ${reason.invoiced_quantity}`,
    ].filter(Boolean);
    return values.join(' · ');
  }
  if (reason.invoice_quantity != null && reason.allocated_quantity != null) {
    return `כמות בחשבונית ${reason.invoice_quantity} · הוקצתה ${reason.allocated_quantity}`;
  }
  if (reason.expected_vat_rate != null && reason.actual_vat_rate != null) {
    return `שיעור מצופה ${reason.expected_vat_rate}% · בפועל ${reason.actual_vat_rate}%`;
  }
  if (reason.actual_vat_rate != null) return `שיעור בפועל ${reason.actual_vat_rate}%`;
  if (reason.expected != null && reason.actual != null) {
    return `מצופה ${fmtMoneyExact(reason.expected)} · בפועל ${fmtMoneyExact(reason.actual)}`;
  }
  if (reason.invoice_unit && reason.order_unit) {
    return `יחידה בחשבונית: ${formatUnit(reason.invoice_unit)} · יחידה בהזמנה: ${formatUnit(reason.order_unit)}`;
  }
  return null;
}

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

/**
 * The label the audit line carries when the reviewer typed nothing.
 *
 * Same copy as the button that was pressed, so the ledger sentence reads as the action a person
 * would recognise. `received` is not an action this screen offers — the graph never returns it —
 * so it falls back to the screen's own name rather than inventing a verb for it.
 */
function reviewActionLabel(status: InvoiceReviewStatus): string {
  return INVOICE_REVIEW_ACTIONS.find((action) => action.to === status)?.label ?? 'עדכון סטטוס בדיקת חשבונית';
}

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
  const { profile, org, organizationAccess } = useAuth();
  const orgLogoUrl = org?.logo_path
    ? `${supabase.storage.from('organization-branding').getPublicUrl(org.logo_path).data.publicUrl}?v=${encodeURIComponent(org.logo_updated_at ?? '')}`
    : null;
  const toast = useToast();
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const checkSequence = useRef(0);
  const [checking, setChecking] = useState(false);
  const [creditOpen, setCreditOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reviewTarget, setReviewTarget] = useState<InvoiceReviewStatus | null>(null);
  const [overrideConfirmOpen, setOverrideConfirmOpen] = useState(false);
  const [overrideReauthOpen, setOverrideReauthOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [overrideIdempotencyKey, setOverrideIdempotencyKey] = useState(() => crypto.randomUUID());
  const [lineReviewOpen, setLineReviewOpen] = useState(false);
  const isProcurementManager = profile?.role === 'office';
  const canOpenProcurement = profile?.role !== 'accountant';

  const { data, loading, error, refetch } = useQuery(async () => {
    const rawInvoice = unwrap(await supabase.from('invoices')
      .select('*, orders:invoice_order_links(order_id, purchase_orders(id, number, status)), receipts:invoice_receipt_links(receipt_id, goods_receipts(id, number, received_at))')
      .eq('id', id!).eq('financial_role', 'payable').single()) as Omit<FullInvoice, 'supplier'>;
    const suppliers = await financialSupplierMap([rawInvoice.supplier_id]);
    const invoice: FullInvoice = {
      ...rawInvoice,
      supplier: { id: rawInvoice.supplier_id, name: suppliers.get(rawInvoice.supplier_id)?.name ?? '—' },
    };
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
    const threeWayResult = await supabase.rpc('get_invoice_three_way_match', { p_invoice_id: id! });
    return {
      invoice,
      balance,
      allocations,
      allowedTransitions,
      threeWay: threeWayResult.error ? null : threeWayResult.data as ThreeWayAssessment,
      threeWayError: threeWayResult.error ? toHebrewError(threeWayResult.error.message) : null,
    };
  }, [id, isProcurementManager]);

  const inv = data?.invoice;
  const canEdit = organizationAccess.canWrite && profile && ['owner', 'office'].includes(profile.role);
  const isOffice = profile && ['owner', 'office'].includes(profile.role);

  // ?print=1 (Invoices list "הדפסה" action): print once when the data is on screen, then strip
  // the param so refresh/back does not re-open the dialog. Same one-shot pattern as OrderDetail.
  const [params, setParams] = useSearchParams();
  const printedRef = useRef<string | null>(null);
  // The invoice sheet is TWO cards, not one container: the money tiles and the details block, with
  // working-screen material between them. `downloadElementPdf` takes both and flows them onto
  // pages, which is why this screen can export at all.
  const headerRef = useRef<HTMLDivElement>(null);
  const moneyCardRef = useRef<HTMLDivElement>(null);
  const detailsCardRef = useRef<HTMLDivElement>(null);
  const [exportingPdf, setExportingPdf] = useState(false);
  useEffect(() => {
    if (printedRef.current === inv?.id || params.get('print') !== '1' || !inv) return;
    printedRef.current = inv.id;
    window.print();
    const next = new URLSearchParams(params);
    next.delete('print');
    setParams(next, { replace: true });
  }, [params, inv, setParams]);

  /**
   * The invoice as a branded PDF. Portrait, and THREE blocks rather than one subtree: the heading,
   * the money tiles and the details card, with working-screen material (attachments, allocations,
   * the three-way match panel) sitting between them that must not reach the file.
   */
  async function exportPdf() {
    const blocks = [headerRef.current, moneyCardRef.current, detailsCardRef.current]
      .filter((element): element is HTMLDivElement => element !== null);
    if (blocks.length === 0 || !inv) return;
    setExportingPdf(true);
    try {
      await downloadElementPdf({
        element: blocks,
        fileName: `invoice-${inv.invoice_number}.pdf`,
        watermark: await exportWatermark(),
      });
      toast('קובץ ה-PDF הורד');
    } catch (e) {
      toast(toHebrewError(e), 'error');
    } finally {
      setExportingPdf(false);
    }
  }

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
      // Never `null`. The command rejects a blank reason outright — `invoice_review_fields_required`,
      // 0023:1907 — and the transitions that no longer open a dialog arrive here with nothing typed.
      // `reasonOr` writes the honest line instead: the action, and that nobody added a note.
      p_reason: reasonOr(reason, reviewActionLabel(status)),
    });
    setBusy(false);
    if (res.error) { toast(toHebrewError(res.error.message), 'error'); return; }
    setReviewTarget(null);
    toast('הסטטוס עודכן');
    void refetch();
  }

  /**
   * The single door every review button goes through.
   *
   * A move up the ladder is the work, not a decision to defend, so it fires straight away and says
   * so with a toast. Only the moves that undo or divert — investigation, and anything backwards —
   * stop to ask. Both paths write a reason to `audit_logs`; only one of them interrupts a person.
   */
  function requestReview(to: InvoiceReviewStatus) {
    if (!inv) return;
    if (reasonDemandFor('invoice_review', inv.review_status, to)) { setReviewTarget(to); return; }
    void setReviewStatus(to);
  }

  async function overrideThreeWayMatch() {
    if (!inv || !data.threeWay || !overrideReason.trim()) return;
    setBusy(true);
    const res = await supabase.rpc('override_invoice_three_way_match', {
      p_invoice_id: inv.id,
      p_assessment_hash: data.threeWay.assessment_hash,
      p_idempotency_key: overrideIdempotencyKey,
      p_reason: overrideReason.trim(),
    });
    setBusy(false);
    setOverrideReauthOpen(false);
    if (res.error) { toast(toHebrewError(res.error.message), 'error'); return; }
    setOverrideReason('');
    setOverrideIdempotencyKey(crypto.randomUUID());
    toast('עקיפת חסימת ההתאמה נרשמה ביומן הביקורת');
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
    <button className="btn-primary" onClick={() => navigate(`/payment-requests?new=${inv.id}`)}><Send size={ICON.sm} aria-hidden="true" /> יצירת דרישת תשלום</button>
  ) : primaryTransition ? (
    <button className="btn-primary" disabled={busy} onClick={() => requestReview(primaryTransition.to)}>
      {busy ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" />
        : primaryTransition.to === 'approved' ? <CheckCircle2 size={ICON.sm} aria-hidden="true" /> : <Send size={ICON.sm} aria-hidden="true" />}{primaryTransition.label}
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
              onClick={() => requestReview(transition.to)}>
                {busy ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" />
                : transition.to === 'investigation' ? <SearchCheck size={ICON.sm} aria-hidden="true" /> : transition.to === 'approved' ? <CheckCircle2 size={ICON.sm} aria-hidden="true" /> : <Send size={ICON.sm} aria-hidden="true" />}{transition.label}
            </button>
          ))}
          {canEdit && <button className="btn-secondary" onClick={() => setCreditOpen(true)}><RotateCcw size={ICON.sm} aria-hidden="true" /> דרישת זיכוי</button>}
          <button className="btn-secondary" disabled={exportingPdf} onClick={() => void exportPdf()} title="הורדת החשבונית כקובץ PDF מעוצב עם הלוגו של הארגון">{exportingPdf ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" /> : <FileDown size={ICON.sm} aria-hidden="true" />} הורדת PDF</button>
        </>}
        lifecycle={lifecycleSteps.length ? <LifecycleStrip steps={lifecycleSteps} current={inv.review_status} nextAction={nextAction} /> : undefined} />

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

      <ConfirmDialog open={overrideConfirmOpen} onClose={() => setOverrideConfirmOpen(false)}
        onConfirm={(reason) => {
          setOverrideReason(reason ?? '');
          setOverrideConfirmOpen(false);
          setOverrideReauthOpen(true);
        }}
        title="עקיפת חסימת 3-way match"
        message="רק בעלים רשאי לעקוף חסימה. הסיבה, זהות המבצע וגרסת ההתאמה יישמרו ביומן הביקורת. כפילות חשבונית ודאית אינה ניתנת לעקיפה."
        confirmLabel="המשך לאימות זהות" requireReason busy={busy} />

      <ReauthModal open={overrideReauthOpen}
        title="אימות זהות לעקיפת חסימת 3-way match"
        onConfirm={() => void overrideThreeWayMatch()}
        onCancel={() => { setOverrideReauthOpen(false); setOverrideReason(''); }} />

      {/* The document heading, on paper AND in the generated PDF. `print-only` rather than
          `hidden print:block` because html2canvas renders the live DOM. */}
      <div ref={headerRef} aria-hidden="true" className="print-only">
        {orgLogoUrl && <img src={orgLogoUrl} alt="" className="mb-2 h-14 w-32 object-contain object-right" />}
        <h2 className="text-xl font-semibold">{`${org?.name ? `${org.name} — ` : ''}חשבונית ${inv.invoice_number} — ${inv.supplier.name}`}</h2>
        <p className="text-xs">תאריך חשבונית: {fmtDate(inv.invoice_date)}</p>
      </div>

      {/* print-area on the money + details cards: shadows/borders drop in print so the sheet
          stays a clean invoice document (same convention as the Orders print sheet). */}
      <Card ref={moneyCardRef} pad={false} clip className={`grid ${isProcurementManager ? 'grid-cols-1' : 'grid-cols-2 sm:grid-cols-4'}`}>
        <div className="p-4 print-area"><div className="text-xs text-ink-muted">סה״כ חשבונית</div><div className="kpi-value-compact num text-start">{fmtMoneyExact(inv.total_amount)}</div>
          <div className="text-xs text-ink-muted mt-0.5">לפני מע״מ {fmtMoneyExact(inv.amount_before_vat)} + מע״מ {fmtMoneyExact(inv.vat_amount)}</div></div>
        {!isProcurementManager && (
          <>
            {/* No invoice_balances row = the ledger has not been computed for this invoice, which is a
                different claim from "₪0.00 paid". fmtMoneyExact(null) renders — so the tile stays honest.
                The balance tile below keeps its ?? total_amount fallback: an invoice with no ledger row
                genuinely owes its full amount, which is a derivation, not an invented figure. */}
            {/* Tone follows the VALUE, like the balance tile below and like Suppliers.tsx:496-497.
                done-green on a 0.00 read as "paid ✓" to anyone scanning the row — and nothing had
                been paid. Zero is the absence of a claim, which is what `idle` means (DESIGN.md). */}
            <div className="border-s border-line-soft p-4 print-area"><div className="text-xs text-ink-muted">שולם</div><div className={`kpi-value-compact num text-start ${data.balance?.paid_amount ? 'text-done-fg' : 'text-idle-fg'}`}>{fmtMoneyExact(data.balance?.paid_amount ?? null)}</div></div>
            {/* credited = already offset, a settled claim like "paid" — done, not the retired violet
                (audit 2026-07-21) — but only once something actually was credited. */}
            <div className="border-t border-line-soft p-4 print-area sm:border-s sm:border-t-0"><div className="text-xs text-ink-muted">זוכה</div><div className={`kpi-value-compact num text-start ${data.balance?.credited_amount ? 'text-done-fg' : 'text-idle-fg'}`}>{fmtMoneyExact(data.balance?.credited_amount ?? null)}</div></div>
            <div className="border-s border-t border-line-soft p-4 print-area sm:border-t-0"><div className="text-xs text-ink-muted">יתרה לתשלום</div><div className={`kpi-value-compact num text-start ${data.balance && data.balance.balance > 0 ? 'text-await-fg' : 'text-done-fg'}`}>{fmtMoneyExact(data.balance?.balance ?? inv.total_amount)}</div></div>
          </>
        )}
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card ref={detailsCardRef} className="space-y-3 print-area">
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
        </Card>

        {/* attachments/allocations are working-screen material, not part of the printed sheet */}
        <Card className="no-print">
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
        </Card>
      </div>

      <Card as="section" className="no-print" aria-labelledby="invoice-three-way-title">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="invoice-three-way-title" className="section-title">התאמת הזמנה, קבלה וחשבונית</h2>
            <p className="text-sm text-ink-muted mt-1">השוואה ברמת שורה מול הכמות שהוזמנה, הכמות שהתקבלה ומחיר ההזמנה.</p>
          </div>
          {/* The tone dictionary's own class, not a hand-assembled pair: this was the one badge
              in the app wearing bg-*-soft with text-*-fg instead of text-*-on-soft, which is a
              step lighter than every other badge on the same background. */}
          {data.threeWay && (
            <span className={
              data.threeWay.override_active ? 'badge-await'
                : data.threeWay.status === 'review_required' ? 'badge-alert'
                  : data.threeWay.status === 'matched_with_warnings' ? 'badge-await'
                    : data.threeWay.status === 'matched' ? 'badge-done'
                      : 'badge-info'
            }>
              {data.threeWay.override_active ? 'אושרה עקיפה מתועדת'
                : data.threeWay.status === 'review_required' ? 'נדרשת בדיקה'
                  : data.threeWay.status === 'matched_with_warnings' ? 'תואם עם אזהרות'
                    : data.threeWay.status === 'matched' ? 'תואם'
                      : 'אין הזמנה להשוואה'}
            </span>
          )}
          {isOffice && organizationAccess.canWrite && inv.review_status !== 'approved' && (
            <button className="btn-secondary" onClick={() => setLineReviewOpen(true)}>
              <FilePenLine size={ICON.sm} aria-hidden="true" /> בדיקת שורות והתאמות
            </button>
          )}
        </div>

        {data.threeWayError && <ErrorNote message={`לא ניתן לטעון את בדיקת ההתאמה: ${data.threeWayError}`} />}
        {data.threeWay && (
          <div className="mt-4 space-y-3">
            {data.threeWay.reasons.length > 0 ? (
              <ul className="divide-y divide-line-soft border border-line-soft rounded-lg">
                {data.threeWay.reasons.map((reason, index) => {
                  const details = threeWayReasonDetails(reason);
                  return (
                    <li key={`${reason.code}-${reason.line_number ?? 'invoice'}-${index}`} className="px-3 py-2.5 text-sm">
                      <div className="flex items-start gap-2">
                        <span className={`mt-1.5 size-2 rounded-full shrink-0 ${reason.severity === 'critical' || reason.severity === 'error' ? 'bg-alert-solid' : reason.severity === 'warning' ? 'bg-await-solid' : 'bg-info-solid'}`} aria-hidden="true" />
                        <div>
                          <div className="font-medium text-ink">
                            {reason.line_number != null && <span>שורה <span className="num">{reason.line_number}</span>: </span>}
                            {THREE_WAY_REASON_LABELS[reason.code] ?? 'נמצא פער הדורש בדיקה.'}
                          </div>
                          {details && <div className="text-ink-muted num mt-0.5">{details}</div>}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <Note tone="done" role="status">לא נמצאו פערים בהתאמת שורות החשבונית להזמנה ולקבלה.</Note>
            )}

            {data.threeWay.lines.length > 0 && (
              <details>
                <summary className="text-sm font-medium cursor-pointer">הצגת {data.threeWay.lines.length} שורות החשבונית</summary>
                <ul className="mt-2 divide-y divide-line-soft border border-line-soft rounded-lg">
                  {data.threeWay.lines.map((line) => (
                    <li key={line.id} className="px-3 py-2 text-sm flex flex-wrap justify-between gap-2">
                      <span><span className="num text-ink-muted">{line.line_number}.</span> <bdi>{line.description}</bdi></span>
                      <span className="num text-ink-muted">{formatQuantity(line.quantity, line.unit)} × {fmtMoneyExact(line.unit_price)} = {fmtMoneyExact(line.line_total)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {data.threeWay.override_active && data.threeWay.override && (
              <Note tone="await" role="status">
                <span className="min-w-0 flex-1">
                  החסימה נעקפה על ידי בעלים לאחר אימות זהות. סיבה: {data.threeWay.override.reason}
                </span>
              </Note>
            )}

            {profile?.role === 'owner' && organizationAccess.canWrite
              && data.threeWay.approval_blocked && !data.threeWay.override_active
              && !data.threeWay.definite_duplicate_invoice && (
                <div className="flex justify-end">
                  <button className="btn-danger-quiet" disabled={busy}
                    onClick={() => setOverrideConfirmOpen(true)}>
                    עקיפת חסימה לאחר אימות זהות
                  </button>
                </div>
              )}
          </div>
        )}
      </Card>

      <Card className="no-print">
        <div className="flex items-center justify-between mb-3">
          <div className="section-title">בדיקות אוטומטיות</div>
          <button className="btn-secondary btn-sm" onClick={() => void runChecks()} disabled={checking}>
            {checking ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" /> : <SearchCheck size={ICON.sm} aria-hidden="true" />} הרצת בדיקות
          </button>
        </div>
        {checkError && <Note tone="alert">{checkError}</Note>}
        {checks ? <CheckList checks={checks} /> : !checking && !checkError && /* Device-neutral wording: on a phone nobody clicks. */ (
          <div className="text-sm text-ink-muted">״הרצת בדיקות״ משווה את החשבונית מול הזמנות, קבלות, תשלומים ותנועות בנק.</div>
        )}
      </Card>

      {creditOpen && (
        <CreditFromInvoice invoice={inv} draft={creditDraft}
          onClose={() => { setCreditOpen(false); setCreditDraft(null); }}
          onSaved={() => { setCreditOpen(false); setCreditDraft(null); toast('דרישת הזיכוי נפתחה'); void refetch(); }} />
      )}
      {lineReviewOpen && profile && data.threeWay && (
        <InvoiceLineReviewModal
          invoiceId={inv.id}
          actorId={profile.id}
          assessment={data.threeWay}
          orderNumbers={Object.fromEntries(inv.orders.map((order) => [
            order.purchase_orders.id,
            order.purchase_orders.number,
          ]))}
          onClose={() => setLineReviewOpen(false)}
          onSaved={() => {
            setLineReviewOpen(false);
            void refetch();
          }}
        />
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
