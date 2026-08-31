import type { TKey } from '../lib/i18n/t';
import type { Locale } from '../lib/i18n/locale';
import { useT } from '../lib/i18n/LocaleProvider';
import { useEffect, useRef, useState } from 'react';
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
import { downloadDocumentPdf } from '../lib/pdf';
import { exportWatermark } from '../lib/exportBranding';
import { reasonDemandFor } from '../lib/transitionIntent';
import { INVOICE_REVIEW_STATUS, INVOICE_PAYMENT_STATUS, INVOICE_EXPORT_STATUS, CREDIT_REASON } from '../lib/status';
import { fmtMoneyExact, fmtDate, formatQuantity, formatUnit, todayISO } from '../lib/format';
import { creditDraftFromInterpretation, type CreditDraft } from '../components/document-review/model';
import { ReconciliationStrip, type LadderSource } from '../components/document-review/ReconciliationStrip';
import type { InterpretationContract } from '../lib/useDocumentProcessing';
import type { Invoice, InvoiceReviewStatus, CreditReason } from '../lib/types';
import { financialSupplierMap } from '../lib/financialSuppliers';
import { ReauthModal } from '../components/ReauthModal';
import { ImpactDialog, type ActionImpact } from '../components/ImpactDialog';
import {
  InvoiceLineReviewModal,
  type InvoiceReviewCandidate,
  type InvoiceReviewLine,
} from '../components/InvoiceLineReviewModal';

const INVOICE_LINES_FOLD_ID = 'invoice-lines-fold';

type FullInvoice = Omit<Invoice, 'supplier'> & {
  supplier: { id: string; name: string };
  /** From 0264. Null is a real answer — "nobody knows" — and never a date derived from terms. */
  due_date: string | null;
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

export type ThreeWayAssessment = {
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
  /**
   * The ladder, from `0261`. Every field is optional in the TYPE and none of them is optional in
   * the SERVER: a deployment where the migration has not run yet must render no strip rather than
   * a strip full of undefined, which is exactly what the guard in `invoiceLadder` enforces.
   */
  totals?: {
    line_net?: number | null;
    invoice_net?: number | null;
    invoice_vat?: number | null;
    invoice_grand?: number | null;
    line_tolerance?: number | null;
    invoice_tolerance?: number | null;
    currency?: string | null;
    lines_discount?: number | null;
    computed_total?: number | null;
    unexplained_gap?: number | null;
    lines_vs_header_gap?: number | null;
    missing_rungs?: string[] | null;
  } | null;
};

/**
 * The invoice's totals in the shape the ladder draws, and NOT ONE ARITHMETIC OPERATION.
 *
 * The two read models were written years apart and name the same rungs differently — `invoice_net`
 * here, `header_net` on a document. This renames them and stops. Every figure, including the
 * computed total and the gap, comes from `0261`, rounded by the currency's minor units on the
 * server that decided whether to block.
 *
 * IT RETURNS NULL RATHER THAN A PARTIAL LADDER. Without a tolerance there is nothing to compare
 * the gap against, and a strip that printed "checked against 1" beside an invoice the server
 * judged by something else would be stating a rule the product does not enforce — the failure the
 * whole per-currency campaign exists to end. A currency this database does not carry produces a
 * null tolerance and a warning of its own (`amount_check_skipped_no_tolerance`, 0259), which the
 * reasons list above already shows.
 */
export function invoiceLadder(threeWay: ThreeWayAssessment | null): LadderSource | null {
  const totals = threeWay?.totals;
  if (!totals || totals.invoice_tolerance == null || totals.currency == null) return null;
  if (totals.computed_total == null || totals.unexplained_gap == null) return null;
  // The four rungs the strip can name. A rung a later server invents is dropped rather than
  // widening the type: an unlabelled row would be worse than one fewer honest label.
  const known = ['lines_net', 'header_net', 'header_vat', 'header_total'] as const;
  const missing = (totals.missing_rungs ?? [])
    .filter((rung): rung is (typeof known)[number] => (known as readonly string[]).includes(rung));
  return {
    currency: totals.currency,
    totals: {
      lines_net: totals.line_net ?? null,
      lines_discount: totals.lines_discount ?? null,
      header_net: totals.invoice_net ?? null,
      header_vat: totals.invoice_vat ?? null,
      header_total: totals.invoice_grand ?? null,
      computed_total: totals.computed_total,
      unexplained_gap: totals.unexplained_gap,
      lines_vs_header_gap: totals.lines_vs_header_gap ?? null,
      overcharge_total: null,
      line_tolerance: totals.line_tolerance ?? null,
      document_tolerance: totals.invoice_tolerance,
      currency: totals.currency,
      missing_rungs: missing,
    },
    // `line_number` is what an invoice reason carries, and it counts from one. The strip speaks
    // zero-based indexes because the document assessment does, so the conversion happens here
    // rather than inside a component that would then have to know which screen it is on.
    findings: threeWay.reasons.map((reason) => ({
      code: reason.code,
      line_index: reason.line_number == null ? null : reason.line_number - 1,
    })),
  };
}

const THREE_WAY_REASON_KEYS: Record<string, TKey> = {
  definite_duplicate_invoice: 'invoices.reason_definite_duplicate_invoice',
  no_order_not_comparable: 'invoices.reason_no_order_not_comparable',
  invoice_lines_missing: 'invoices.reason_invoice_lines_missing',
  duplicate_invoice_line_suspected: 'invoices.reason_duplicate_invoice_line_suspected',
  missing_order_item: 'invoices.reason_missing_order_item',
  multi_order_ambiguity: 'invoices.reason_multi_order_ambiguity',
  incomplete_explicit_allocation: 'invoices.reason_incomplete_explicit_allocation',
  product_mismatch: 'invoices.reason_product_mismatch',
  unit_or_packaging_conversion_requires_review: 'invoices.reason_unit_or_packaging_conversion_requires_review',
  legacy_order_unit_snapshot_missing: 'invoices.reason_legacy_order_unit_snapshot_missing',
  unit_price_above_order: 'invoices.reason_unit_price_above_order',
  unit_price_within_tolerance: 'invoices.reason_unit_price_within_tolerance',
  unit_price_below_order: 'invoices.reason_unit_price_below_order',
  invoiced_quantity_above_ordered: 'invoices.reason_invoiced_quantity_above_ordered',
  invoiced_quantity_above_received: 'invoices.reason_invoiced_quantity_above_received',
  received_but_not_invoiced: 'invoices.reason_received_but_not_invoiced',
  line_arithmetic_discrepancy: 'invoices.reason_line_arithmetic_discrepancy',
  invoice_net_total_discrepancy: 'invoices.reason_invoice_net_total_discrepancy',
  invoice_vat_total_discrepancy: 'invoices.reason_invoice_vat_total_discrepancy',
  invoice_grand_total_discrepancy: 'invoices.reason_invoice_grand_total_discrepancy',
  vat_rate_mismatch: 'invoices.reason_vat_rate_mismatch',
  expected_vat_rate_missing: 'invoices.reason_expected_vat_rate_missing',
  // 0259: the server could not resolve a tolerance for this invoice's currency, so it did
  // not run the amount comparisons and says so. Without this line the screen would render
  // its generic "unknown reason", which is the silence the finding exists to break.
  amount_check_skipped_no_tolerance: 'invoices.reason_amount_check_skipped_no_tolerance',
};

/**
 * `currency` is the invoice's own (0217). Every figure in a reason — the ordered price, the
 * invoiced price, the difference between them — is money in that one currency, because a
 * three-way match compares an invoice line against the order line it was matched to and a
 * matched pair the server would not have produced across two currencies.
 */
function threeWayReasonDetails(
  reason: ThreeWayReason,
  t: (key: TKey, vars?: Record<string, string | number>) => string,
  locale: Locale,
  currency: string,
) {
  if (reason.ordered_unit_price != null && reason.invoice_unit_price_normalized != null) {
    const difference = reason.difference_amount
      ?? reason.invoice_unit_price_normalized - reason.ordered_unit_price;
    const percent = reason.difference_percent
      ?? (reason.ordered_unit_price === 0 ? null : difference / reason.ordered_unit_price * 100);
    return `מחיר בהזמנה ${fmtMoneyExact(reason.ordered_unit_price, currency)}, בחשבונית ${fmtMoneyExact(reason.invoice_unit_price_normalized, currency)}, הפרש ${fmtMoneyExact(difference, currency)}${percent == null ? '' : ` (${percent.toFixed(2)}%)`}`;
  }
  if (reason.invoiced_quantity != null) {
    const values = [
      reason.ordered_quantity == null ? null : t('invoices.detailOrdered', { qty: reason.ordered_quantity }),
      reason.received_quantity == null ? null : t('invoices.detailReceived', { qty: reason.received_quantity }),
      reason.prior_approved_invoiced_quantity == null
        ? null : t('invoices.detailPriorApproved', { qty: reason.prior_approved_invoiced_quantity }),
      reason.current_invoice_quantity == null
        ? null : t('invoices.detailThisInvoice', { qty: reason.current_invoice_quantity }),
      t('invoices.detailInvoicedTotal', { qty: reason.invoiced_quantity }),
    ].filter(Boolean);
    return values.join(' · ');
  }
  if (reason.invoice_quantity != null && reason.allocated_quantity != null) {
    return t('invoices.detailAllocation', { invoiced: reason.invoice_quantity, allocated: reason.allocated_quantity });
  }
  if (reason.expected_vat_rate != null && reason.actual_vat_rate != null) {
    return t('invoices.detailVatRates', { expected: reason.expected_vat_rate, actual: reason.actual_vat_rate });
  }
  if (reason.actual_vat_rate != null) return t('invoices.detailVatActual', { actual: reason.actual_vat_rate });
  if (reason.expected != null && reason.actual != null) {
    return t('invoices.detailExpectedActual', { expected: fmtMoneyExact(reason.expected, currency), actual: fmtMoneyExact(reason.actual, currency) });
  }
  if (reason.invoice_unit && reason.order_unit) {
    return t('invoices.detailUnits', { invoiceUnit: formatUnit(reason.invoice_unit, locale), orderUnit: formatUnit(reason.order_unit, locale) });
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
export const INVOICE_REVIEW_ACTIONS: { to: InvoiceReviewStatus; labelKey: TKey; auditLabel: string }[] = [
  { to: 'in_review', labelKey: 'invoices.actionInReview', auditLabel: 'העברה לבדיקה' },
  { to: 'pending_approval', labelKey: 'invoices.actionPendingApproval', auditLabel: 'העברה לאישור' },
  { to: 'approved', labelKey: 'invoices.actionApproved', auditLabel: 'אישור לתשלום' },
  { to: 'investigation', labelKey: 'invoices.actionInvestigation', auditLabel: 'סימון לבירור' },
];

/**
 * The label the audit line carries when the reviewer typed nothing.
 *
 * Same copy as the button that was pressed, so the ledger sentence reads as the action a person
 * would recognise. `received` is not an action this screen offers — the graph never returns it —
 * so it falls back to the screen's own name rather than inventing a verb for it.
 */
function reviewActionLabel(status: InvoiceReviewStatus): string {
  return INVOICE_REVIEW_ACTIONS.find((action) => action.to === status)?.auditLabel ?? 'עדכון סטטוס בדיקת חשבונית';
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
    { key: 'received', labelKey: 'invoices.lifecycleReceived' },
    { key: 'in_review', labelKey: 'invoices.lifecycleInReview' },
    { key: 'pending_approval', labelKey: 'invoices.lifecyclePendingApproval' },
    { key: 'approved', labelKey: 'invoices.lifecycleApproved' },
  ] as const satisfies readonly { key: string; labelKey: TKey }[];
  if (status === 'pending_approval') return [
    { key: 'pending_approval', labelKey: 'invoices.lifecyclePendingApproval' },
    { key: 'approved', labelKey: 'invoices.lifecycleApproved' },
  ] as const satisfies readonly { key: string; labelKey: TKey }[];
  if (status === 'approved') return [{ key: 'approved', labelKey: 'invoices.lifecycleApproved' }] as const satisfies readonly { key: string; labelKey: TKey }[];
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
  const { errorText, locale, t } = useT();
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
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideReauthOpen, setOverrideReauthOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [overrideIdempotencyKey, setOverrideIdempotencyKey] = useState(() => crypto.randomUUID());
  /* A refusal shown INSIDE the dialog rather than as a toast that closes it. The staleness case
     is the reason this exists: the reader has to see what changed, in the same window, with the
     reason they already typed still in it. */
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [lineReviewOpen, setLineReviewOpen] = useState(false);
  const [mismatchOpen, setMismatchOpen] = useState(false);
  const [mismatchBusy, setMismatchBusy] = useState(false);
  const [linesFoldTarget, setLinesFoldTarget] = useState<number | null>(null);
  useEffect(() => {
    if (linesFoldTarget == null) return;
    const fold = document.getElementById(INVOICE_LINES_FOLD_ID);
    if (fold instanceof HTMLDetailsElement && !fold.open) { fold.open = true; return; }
    // The strip counts from zero because the document assessment does; the list is numbered the
    // way a person reads an invoice.
    document.getElementById(`invoice-line-${linesFoldTarget + 1}`)
      ?.scrollIntoView({ block: 'center' });
    setLinesFoldTarget(null);
  }, [linesFoldTarget]);
  const [dueDate, setDueDate] = useState('');
  const [dueDateBusy, setDueDateBusy] = useState(false);
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
      /* One row per invoice still, because an invoice is issued in ONE currency — the reader is
         per-currency (0218) so that a supplier's two debts stay two, and the row it returns for
         this invoice is in the invoice's own currency. */
      : unwrap(await supabase.from('invoice_balances_by_currency').select('*').eq('invoice_id', id!).maybeSingle()) as
        { currency: string; paid_amount: number; credited_amount: number; balance_in_currency: number } | null;
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
      threeWayError: threeWayResult.error ? errorText(threeWayResult.error.message) : null,
    };
  }, [id, isProcurementManager]);

  const inv = data?.invoice;
  const canEdit = organizationAccess.canWrite && profile && ['owner', 'office'].includes(profile.role);

  /* The ladder and whether it is over its tolerance — both read off the server's own figures.
     `document_tolerance` is the number `0259` derived for THIS currency and enforced; comparing
     against anything else here would put a second rule on the screen. */
  const ladder = invoiceLadder(data?.threeWay ?? null);
  const ladderOverTolerance = ladder != null
    && ladder.totals.unexplained_gap != null && ladder.totals.document_tolerance != null
    && Math.abs(ladder.totals.unexplained_gap) > ladder.totals.document_tolerance;

  /**
   * "Go to line 3" goes to line 3. The list is a native `<details>`, so it is opened through the
   * element and the row is reached on the render after it — the same two-pass shape the document
   * review panel uses, for the same reason: there is no row to scroll to on the first pass.
   */
  function goToInvoiceLines(lines: number[]) {
    if (lines.length > 0) setLinesFoldTarget(lines[0]);
  }
  /* The field shows what the RECORD holds. Seeding it from state alone would let a stale value
     survive a refetch and read as saved. */
  const invoiceDueDate = data?.invoice?.due_date ?? '';
  useEffect(() => { setDueDate(invoiceDueDate); }, [invoiceDueDate]);
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
      await downloadDocumentPdf({
        element: blocks,
        path: `/invoices/${inv.id}`,
        fileName: `invoice-${inv.invoice_number}.pdf`,
        watermark: await exportWatermark(),
      });
      toast('קובץ ה-PDF הורד');
    } catch (e) {
      toast(errorText(e), 'error');
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
        : creditDraftFromInterpretation((res.data as { payload: InterpretationContract }).payload, t));
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
        invoice_date: inv.invoice_date, total_amount: inv.total_amount, currency: inv.currency,
        linkedOrderIds: inv.orders.map((o) => o.order_id),
      });
      if (checkSequence.current === sequence && id === inv.id) setChecks(res);
    } catch {
      if (checkSequence.current === sequence) setCheckError(t('invoices.setCheckError'));
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
    if (res.error) { toast(errorText(res.error.message), 'error'); return; }
    setReviewTarget(null);
    toast(t('invoices.toast'));
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

  /**
   * The field writes through a command, because it has to. `p1_financial_command_guard` (0023)
   * refuses every invoice UPDATE that does not arrive through an RPC holding the writer token, so
   * there is no version of this that is a plain update. `set_invoice_due_date` audits the change
   * with the old and new value and is idempotent, so a re-render that resends the same date
   * writes nothing.
   */
  async function saveDueDate(next: string) {
    if (!inv) return;
    setDueDate(next);
    setDueDateBusy(true);
    const res = await supabase.rpc('set_invoice_due_date', {
      p_invoice_id: inv.id,
      p_due_date: next === '' ? null : next,
    });
    setDueDateBusy(false);
    if (res.error) {
      // Put the field back to what the server still holds, rather than leaving a value on screen
      // that nothing stored.
      setDueDate(inv.due_date ?? '');
      toast(errorText(res.error.message), 'error');
      return;
    }
    if ((res.data as { changed?: boolean } | null)?.changed) {
      toast(next === '' ? t('invoices.dueDateCleared') : t('invoices.dueDateSaved'));
      void refetch();
    }
  }

  /**
   * The gap, handed to the person whose job it is. `open_manual_exception` (0087) is idempotent
   * while an exception of the same type is still open, so a second press does not create a second
   * one — it says so, which is a truer report than a silent success and than a duplicate row.
   */
  async function openAmountMismatch(reason: string) {
    if (!inv) return;
    setMismatchBusy(true);
    const res = await supabase.rpc('open_manual_exception', {
      p_entity_type: 'invoices',
      p_entity_id: inv.id,
      p_type: 'amount_mismatch',
      p_reason: reason,
    });
    setMismatchBusy(false);
    if (res.error) { toast(errorText(res.error.message), 'error'); return; }
    setMismatchOpen(false);
    toast((res.data as { idempotent?: boolean } | null)?.idempotent
      ? t('invoices.amountMismatchAlreadyOpen')
      : t('invoices.amountMismatchOpened'));
  }

  /**
   * Override the three-way match, and survive the state moving underneath.
   *
   * WHAT THIS USED TO DO WITH A REFUSAL, AND WHY IT WAS WRONG. It closed the step-up dialog, threw
   * the server's message into a toast, and stopped. For every refusal that was merely unhelpful.
   * For ONE of them it was actively misleading: `invoice_three_way_assessment_stale` (`0099:1972`)
   * means the assessment CHANGED between the moment the reader read it and the moment they
   * approved it — the invoice may now match, or fail for a different reason entirely — and the
   * old path answered that by closing the window over it, keeping the stale hash, and leaving a
   * generic "the action failed" behind. Approving again would have failed identically, forever,
   * because nothing reloaded.
   *
   * Now: the dialog STAYS OPEN, the assessment is refetched, the sentence says the state changed,
   * and a NEW idempotency key is minted — the next approval is a new decision about a new state,
   * which is what it actually is. Every other refusal is shown in place too, for the same reason:
   * a toast that closes the window takes the reader's typed reason with it.
   */
  async function overrideThreeWayMatch(reason: string) {
    if (!inv || !data.threeWay) return;
    setBusy(true);
    setOverrideError(null);
    const res = await supabase.rpc('override_invoice_three_way_match', {
      p_invoice_id: inv.id,
      p_assessment_hash: data.threeWay.assessment_hash,
      p_idempotency_key: overrideIdempotencyKey,
      p_reason: reason,
    });
    setBusy(false);
    setOverrideReauthOpen(false);
    if (res.error) {
      setOverrideError(errorText(res.error.message));
      /* A stale hash is the one refusal that a retry alone can never clear: the key is part of
         the decision, so a new state gets a new key, and the impact is read again. */
      if (/invoice_three_way_assessment_stale/i.test(res.error.message)) {
        setOverrideIdempotencyKey(crypto.randomUUID());
        void refetch();
      }
      return;
    }
    setOverrideOpen(false);
    setOverrideReason('');
    setOverrideIdempotencyKey(crypto.randomUUID());
    toast(t('invoices.toast_2'));
    void refetch();
  }

  if (loading) return <RecordSkeleton />;
  if (error && !data) return <ErrorNote message={error} />;
  if (!inv || !data) return <ErrorNote message={t('invoices.message')} />;

  /**
   * What overriding the three-way match actually does, read from the server's own assessment.
   *
   * NOTHING HERE IS GUESSED. The count is one invoice because that is what the command takes; the
   * blocking reasons are the server's list, rendered as warnings rather than blockers because the
   * whole point of an override is to proceed past them and the server checks them again anyway;
   * and the one genuine hard blocker is the duplicate, which `0099:1975` refuses outright — the
   * button is hidden in that case today, and the dialog would still refuse if it ever were not.
   *
   * `null` while the assessment has not loaded, which is what locks the confirm and draws the
   * skeleton instead of a wall of consequences that arrives late.
   */
  const overrideImpact: ActionImpact | null = data.threeWay == null ? null : {
    actionLabel: t('invoices.confirmLabel_2'),
    scopeLabel: t('invoices.overrideScope', { number: inv.invoice_number, supplier: inv.supplier.name }),
    affectedCount: 1,
    entityKinds: [{ label: t('invoices.overrideEntityInvoice'), count: 1 }],
    changes: [{
      label: t('invoices.overrideChangeLabel'),
      before: t('invoices.overrideChangeBefore'),
      after: t('invoices.overrideChangeAfter'),
    }],
    amounts: [{ currency: inv.currency, amount: inv.total_amount }],
    /* An override is a standing record with no command to lift it — `0099` has one writer and no
       eraser — so this says so instead of offering a way back that does not exist. */
    reversible: false,
    effects: [
      { kind: 'approval', happens: true, description: t('invoices.overrideEffectApproval') },
      { kind: 'ledger', happens: true, description: t('invoices.overrideEffectLedger') },
      { kind: 'amounts', happens: false, description: t('invoices.overrideEffectNoAmounts') },
      { kind: 'lines', happens: false, description: t('invoices.overrideEffectNoLines') },
    ],
    /* The server's own list, worded exactly as the panel below words it — same key, same detail
       line — so the dialog cannot describe the blockage differently from the screen it opened on. */
    warnings: data.threeWay.reasons.map((reason, index) => {
      const label = reason.code in THREE_WAY_REASON_KEYS
        ? t(THREE_WAY_REASON_KEYS[reason.code]) : t('invoices.text_18');
      const line = reason.line_number != null ? `${t('invoices.text_17')} ${reason.line_number}: ` : '';
      const details = threeWayReasonDetails(reason, t, locale, inv.currency);
      return {
        kind: `${reason.code}-${reason.line_number ?? 'invoice'}-${index}`,
        description: `${line}${label}${details ? ` · ${details}` : ''}`,
      };
    }),
    hardBlockers: data.threeWay.definite_duplicate_invoice
      ? [{ kind: 'definite_duplicate', description: t('invoices.overrideBlockedDuplicate') }]
      : [],
    requiresStepUp: true,
    assessmentHash: data.threeWay.assessment_hash,
  };

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
    <button className="btn-primary" onClick={() => navigate(`/payment-requests?new=${inv.id}`)}><Send size={ICON.sm} aria-hidden="true" /> {t('invoices.text')}</button>
  ) : primaryTransition ? (
    <button className="btn-primary" disabled={busy} onClick={() => requestReview(primaryTransition.to)}>
      {busy ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" />
        : primaryTransition.to === 'approved' ? <CheckCircle2 size={ICON.sm} aria-hidden="true" /> : <Send size={ICON.sm} aria-hidden="true" />}{t(primaryTransition.labelKey)}
    </button>
  ) : null;
  const nextAction = primaryKey === 'payment-request' ? t('invoices.text')
    : primaryTransition ? t(primaryTransition.labelKey) : undefined;
  const lifecycleSteps = invoiceLifecycle(inv.review_status).map((s) => ({ key: s.key, label: t(s.labelKey) }));

  return (
    <div className="space-y-4 max-w-4xl">
      {error && <ErrorNote message={error} />}
      <RecordHeader className="no-print"
        breadcrumbs={<Breadcrumbs items={[{ label: t('invoices.text_2'), to: '/invoices' }, { label: inv.invoice_number }]} />}
        title={<>{t('invoices.text_3')} <span dir="ltr" className="num">{inv.invoice_number}</span> — {inv.supplier.name}</>}
        status={<StatusBadge meta={INVOICE_REVIEW_STATUS[inv.review_status]} />}
        meta={<><span className="num font-semibold text-ink-body">{fmtMoneyExact(inv.total_amount, inv.currency)}</span><StatusBadge meta={INVOICE_PAYMENT_STATUS[inv.payment_status]} />{!isProcurementManager && <StatusBadge meta={INVOICE_EXPORT_STATUS[inv.export_status]} />}</>}
        primaryAction={primaryAction}
        secondaryActions={<>
          {isOffice && transitions.filter((transition) => transition.to !== primaryKey).map((transition) => (
            <button key={transition.to} className="btn-secondary" disabled={busy || graphUnavailable}
              onClick={() => requestReview(transition.to)}>
                {busy ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" />
                : transition.to === 'investigation' ? <SearchCheck size={ICON.sm} aria-hidden="true" /> : transition.to === 'approved' ? <CheckCircle2 size={ICON.sm} aria-hidden="true" /> : <Send size={ICON.sm} aria-hidden="true" />}{t(transition.labelKey)}
            </button>
          ))}
          {canEdit && <button className="btn-secondary" onClick={() => setCreditOpen(true)}><RotateCcw size={ICON.sm} aria-hidden="true" /> דרישת זיכוי</button>}
          <button className="btn-secondary" disabled={exportingPdf} onClick={() => void exportPdf()} title="הורדת החשבונית כקובץ PDF מעוצב עם הלוגו של הארגון">{exportingPdf ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" /> : <FileDown size={ICON.sm} aria-hidden="true" />} הורדת PDF</button>
        </>}
        lifecycle={lifecycleSteps.length ? <LifecycleStrip steps={lifecycleSteps} current={inv.review_status} nextAction={nextAction} /> : undefined} />

      {isOffice && graphUnavailable && (
        <Note tone="alert" role="alert">
          {t('invoices.text_4')}{' '}
          {t('invoices.text_5')}
        </Note>
      )}

      <ConfirmDialog open={reviewTarget !== null} onClose={() => setReviewTarget(null)}
        onConfirm={(reason) => reviewTarget && void setReviewStatus(reviewTarget, reason)}
        title={t('invoices.title')}
        message={t('invoices.message_2')}
        confirmLabel={t('invoices.confirmLabel')} requireReason busy={busy} />

      {/* THREE LAYERS BECAME TWO, AND ONE OF THEM ONLY WHEN IT IS NEEDED. This used to be a
          `ConfirmDialog` that collected a reason, closed, and opened `ReauthModal` — two windows
          for one decision, the first of which could not say what the override would actually do.
          `ImpactDialog` states the extent and hands the reason straight to the step-up, which was
          built to REPLACE a reason-only dialog rather than to stack after one. */}
      <ImpactDialog open={overrideOpen}
        onClose={() => { setOverrideOpen(false); setOverrideReason(''); setOverrideError(null); }}
        onConfirm={(reason) => { setOverrideReason(reason); setOverrideReauthOpen(true); }}
        impact={overrideImpact}
        busy={busy}
        error={overrideError}
        baseCurrency={inv.currency}
        danger
        reasonLabel={t('invoices.overrideReasonLabel')} />

      {/* The reason is already collected; this asks for the password and nothing else. On cancel
          the impact dialog is still open behind it, with what was typed still in it. */}
      <ReauthModal open={overrideReauthOpen}
        title={t('invoices.title_3')}
        details={t('invoices.message_3')}
        onConfirm={() => void overrideThreeWayMatch(overrideReason)}
        onCancel={() => setOverrideReauthOpen(false)} />

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
        <div className="p-4 print-area"><div className="text-xs text-ink-muted">{t('invoices.fmtMoneyExact')}</div><div className="kpi-value-compact num text-start">{fmtMoneyExact(inv.total_amount, inv.currency)}</div>
          <div className="text-xs text-ink-muted mt-0.5">{t('invoices.beforeVat')} {fmtMoneyExact(inv.amount_before_vat, inv.currency)}{t('invoices.plusVat')} {fmtMoneyExact(inv.vat_amount, inv.currency)}</div></div>
        {!isProcurementManager && (
          <>
            {/* No invoice_balances row = the ledger has not been computed for this invoice, which is a
                different claim from "₪0.00 paid". fmtMoneyExact(null) renders — so the tile stays honest.
                The balance tile below keeps its ?? total_amount fallback: an invoice with no ledger row
                genuinely owes its full amount, which is a derivation, not an invented figure. */}
            {/* Tone follows the VALUE, like the balance tile below and like Suppliers.tsx:496-497.
                done-green on a 0.00 read as "paid ✓" to anyone scanning the row — and nothing had
                been paid. Zero is the absence of a claim, which is what `idle` means (DESIGN.md). */}
            <div className="border-s border-line-soft p-4 print-area"><div className="text-xs text-ink-muted">{t('invoices.kpiPaid')}</div><div className={`kpi-value-compact num text-start ${data.balance?.paid_amount ? 'text-done-fg' : 'text-idle-fg'}`}>{fmtMoneyExact(data.balance?.paid_amount ?? null, inv.currency)}</div></div>
            {/* credited = already offset, a settled claim like "paid" — done, not the retired violet
                (audit 2026-07-21) — but only once something actually was credited. */}
            <div className="border-t border-line-soft p-4 print-area sm:border-s sm:border-t-0"><div className="text-xs text-ink-muted">{t('invoices.kpiCredited')}</div><div className={`kpi-value-compact num text-start ${data.balance?.credited_amount ? 'text-done-fg' : 'text-idle-fg'}`}>{fmtMoneyExact(data.balance?.credited_amount ?? null, inv.currency)}</div></div>
            <div className="border-s border-t border-line-soft p-4 print-area sm:border-t-0"><div className="text-xs text-ink-muted">{t('invoices.kpiBalance')}</div><div className={`kpi-value-compact num text-start ${data.balance && data.balance.balance_in_currency > 0 ? 'text-await-fg' : 'text-done-fg'}`}>{fmtMoneyExact(data.balance?.balance_in_currency ?? inv.total_amount, inv.currency)}</div></div>
          </>
        )}
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card ref={detailsCardRef} className="space-y-3 print-area">
          <div className="section-title">{t('invoices.text_6')}</div>
          <dl className="text-sm space-y-2">
            <div className="flex justify-between"><dt className="text-ink-muted">{t('invoices.fmtDate')}</dt><dd>{fmtDate(inv.invoice_date)}</dd></div>
            <div className="flex justify-between"><dt className="text-ink-muted">{t('invoices.fmtDate_2')}</dt><dd>{fmtDate(inv.received_date)}</dd></div>
            {/* THE DATE NOBODY HAD. Payment requests have carried one since 0001; invoices never
                did, so "what leaves the business in the next thirty days" could only be answered
                from requests somebody had already scheduled. Optional on purpose: an empty field
                means NOT KNOWN, and nothing derives a date from payment terms — that column is
                free text nobody parses, and parsing it would invent a debt with a date on it. */}
            <div className="flex items-center justify-between gap-2">
              <dt className="text-ink-muted">{t('invoices.dueDate')}</dt>
              <dd>
                {canEdit ? (
                  <input type="date" className="input h-9 w-40 text-sm" value={dueDate}
                    aria-label={t('invoices.dueDate')} disabled={dueDateBusy}
                    onChange={(event) => void saveDueDate(event.target.value)} />
                ) : (
                  fmtDate(inv.due_date)
                )}
              </dd>
            </div>
            <div className="flex justify-between"><dt className="text-ink-muted">{t('invoices.detailSupplier')}</dt><dd>{canOpenProcurement ? <Link className="link" to={`/suppliers/${inv.supplier.id}`}>{inv.supplier.name}</Link> : inv.supplier.name}</dd></div>
            <div className="flex justify-between"><dt className="text-ink-muted">{t('invoices.text_7')}</dt>
              <dd className="flex gap-2">{inv.orders.length ? inv.orders.map((o) => (
                canOpenProcurement
                  ? <Link key={o.order_id} className="link" to={`/orders/${o.order_id}`}>#{o.purchase_orders.number}</Link>
                  : <span key={o.order_id}>#{o.purchase_orders.number}</span>
              )) : '—'}</dd></div>
            <div className="flex justify-between"><dt className="text-ink-muted">{t('invoices.text_8')}</dt>
              <dd>{inv.receipts.length ? inv.receipts.map((r) => `#${r.goods_receipts.number}`).join(', ') : '—'}</dd></div>
          </dl>
          {inv.notes && <div className="text-sm text-ink-soft bg-surface-sunken rounded-lg px-3 py-2">{inv.notes}</div>}
        </Card>

        {/* attachments/allocations are working-screen material, not part of the printed sheet */}
        <Card className="no-print">
          <InvoiceAttachments invoiceId={inv.id} receipts={inv.receipts.map((r) => r.goods_receipts)} />
          {data.allocations.length > 0 && (
            <div className="mt-4">
              <div className="text-sm font-medium text-ink-soft mb-2">{t('invoices.text_9')}</div>
              <ul className="divide-y divide-line-soft border border-line-soft rounded-lg text-sm">
                {data.allocations.map((a, i) => (
                  <li key={i} className="flex justify-between px-3 py-2">
                    <span>{t('invoices.paymentNo')}{a.payment.number} · {fmtDate(a.payment.paid_date)} {a.payment.reference && <span className="text-ink-muted" dir="ltr">({a.payment.reference})</span>}</span>
                    {/* An allocation is recorded in the DEBT's currency (#286), which is this
                        invoice's — a payment made from an account in another currency records
                        its settlement separately and never changes what the invoice owes. */}
                    <span className="num font-medium">{fmtMoneyExact(a.amount, inv.currency)}</span>
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
            <h2 id="invoice-three-way-title" className="section-title">{t('invoices.text_10')}</h2>
            <p className="text-sm text-ink-muted mt-1">{t('invoices.text_11')}</p>
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
              {data.threeWay.override_active ? t('invoices.text_12')
                : data.threeWay.status === 'review_required' ? t('invoices.text_13')
                  : data.threeWay.status === 'matched_with_warnings' ? t('invoices.text_14')
                    : data.threeWay.status === 'matched' ? t('invoices.text_15')
                      : t('invoices.text_16')}
            </span>
          )}
          {isOffice && organizationAccess.canWrite && inv.review_status !== 'approved' && (
            <button className="btn-secondary" onClick={() => setLineReviewOpen(true)}>
              <FilePenLine size={ICON.sm} aria-hidden="true" /> {t('invoices.lineReview')}
            </button>
          )}
        </div>

        {data.threeWayError && <ErrorNote message={t('invoices.threeWayLoadFailed', { message: data.threeWayError })} />}
        {data.threeWay && (
          <div className="mt-4 space-y-3">
            {/* The numbers first, the reasons after them. The reasons are the working; the ladder
                is the question a person came to this screen to answer, and until 0261 the server
                published every rung of it and the screen showed none. Absent — no tolerance, no
                currency, or a deployment where 0261 has not run — it renders nothing at all
                rather than a tolerance the server does not enforce. */}
            <ReconciliationStrip ladder={ladder} title={t('reconciliation.accountTitleInvoice')}
              onGoToLines={goToInvoiceLines} />

            {/* The gap has a name in this product: `amount_mismatch`. Offering it HERE, beside the
                number, is the difference between a screen that reports a problem and one that
                hands the reader the next move. Owner/office only, matching what
                `open_manual_exception` enforces on the server rather than guessing at it. */}
            {ladderOverTolerance && canEdit && (
              <div>
                <button type="button" className="btn-secondary min-h-11"
                  onClick={() => setMismatchOpen(true)}>
                  <SearchCheck size={ICON.sm} aria-hidden="true" /> {t('invoices.openAmountMismatch')}
                </button>
              </div>
            )}

            {data.threeWay.reasons.length > 0 ? (
              <ul className="divide-y divide-line-soft border border-line-soft rounded-lg">
                {data.threeWay.reasons.map((reason, index) => {
                  const details = threeWayReasonDetails(reason, t, locale, inv.currency);
                  return (
                    <li key={`${reason.code}-${reason.line_number ?? 'invoice'}-${index}`} className="px-3 py-2.5 text-sm">
                      <div className="flex items-start gap-2">
                        <span className={`mt-1.5 size-2 rounded-full shrink-0 ${reason.severity === 'critical' || reason.severity === 'error' ? 'bg-alert-solid' : reason.severity === 'warning' ? 'bg-await-solid' : 'bg-info-solid'}`} aria-hidden="true" />
                        <div>
                          <div className="font-medium text-ink">
                            {reason.line_number != null && <span>{t('invoices.text_17')} <span className="num">{reason.line_number}</span>: </span>}
                            {reason.code in THREE_WAY_REASON_KEYS ? t(THREE_WAY_REASON_KEYS[reason.code]) : t('invoices.text_18')}
                          </div>
                          {details && <div className="text-ink-muted num mt-0.5">{details}</div>}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <Note tone="done" role="status">{t('invoices.text_19')}</Note>
            )}

            {data.threeWay.lines.length > 0 && (
              <details id={INVOICE_LINES_FOLD_ID}>
                <summary className="text-sm font-medium cursor-pointer">{t('invoices.showInvoiceLines', { count: data.threeWay.lines.length })}</summary>
                <ul className="mt-2 divide-y divide-line-soft border border-line-soft rounded-lg">
                  {data.threeWay.lines.map((line) => (
                    <li key={line.id} id={`invoice-line-${line.line_number}`}
                      className="px-3 py-2 text-sm flex flex-wrap justify-between gap-2">
                      <span><span className="num text-ink-muted">{line.line_number}.</span> <bdi>{line.description}</bdi></span>
                      <span className="num text-ink-muted">{formatQuantity(line.quantity, line.unit, locale)} × {fmtMoneyExact(line.unit_price, inv.currency)} = {fmtMoneyExact(line.line_total, inv.currency)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {data.threeWay.override_active && data.threeWay.override && (
              <Note tone="await" role="status">
                <span className="min-w-0 flex-1">
                  {t('invoices.text_20')} {data.threeWay.override.reason}
                </span>
              </Note>
            )}

            {profile?.role === 'owner' && organizationAccess.canWrite
              && data.threeWay.approval_blocked && !data.threeWay.override_active
              && !data.threeWay.definite_duplicate_invoice && (
                <div className="flex justify-end">
                  <button className="btn-danger-quiet" disabled={busy}
                    onClick={() => { setOverrideError(null); setOverrideOpen(true); }}>
                    {t('invoices.text_21')}
                  </button>
                </div>
              )}
          </div>
        )}
      </Card>

      <Card className="no-print">
        <div className="flex items-center justify-between mb-3">
          <div className="section-title">{t('invoices.text_22')}</div>
          <button className="btn-secondary btn-sm" onClick={() => void runChecks()} disabled={checking}>
            {checking ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" /> : <SearchCheck size={ICON.sm} aria-hidden="true" />} {t('invoices.runChecks')}
          </button>
        </div>
        {checkError && <Note tone="alert">{checkError}</Note>}
        {checks ? <CheckList checks={checks} /> : !checking && !checkError && /* Device-neutral wording: on a phone nobody clicks. */ (
          <div className="text-sm text-ink-muted">{t('invoices.text_23')}</div>
        )}
      </Card>

      {creditOpen && (
        <CreditFromInvoice invoice={inv} draft={creditDraft}
          onClose={() => { setCreditOpen(false); setCreditDraft(null); }}
          onSaved={() => { setCreditOpen(false); setCreditDraft(null); toast(t('invoices.setCreditOpen_2')); void refetch(); }} />
      )}
      {/* THE REASON IS REQUIRED, AND IT IS THE EXCEPTION'S CONTENT. `open_manual_exception` copies
          it into `details.reason` and writes the audit row itself; a blank one is refused server
          side with `reason_required`. The dialog names the amount so the person justifying the
          exception is looking at the figure they are justifying. */}
      <ConfirmDialog open={mismatchOpen} onClose={() => setMismatchOpen(false)}
        title={t('invoices.amountMismatchTitle')}
        message={t('invoices.amountMismatchMessage', {
          amount: fmtMoneyExact(ladder?.totals.unexplained_gap ?? null, inv.currency),
        })}
        reasonLabel={t('invoices.amountMismatchReason')}
        confirmLabel={t('invoices.openAmountMismatch')}
        requireReason busy={mismatchBusy}
        onConfirm={(reason) => void openAmountMismatch(reason ?? '')} />

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
  const { errorText, statusLabel, t } = useT();
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
    if (!a || a <= 0) { toast(t('invoices.toast_3'), 'error'); return; }
    setBusy(true);
    const res = await supabase.rpc('create_invoice_credit_request', {
      p_credit_request_id: creditRequestId,
      p_invoice_id: invoice.id,
      p_reason: reason,
      p_amount: a,
      p_notes: notes.trim() || null,
      p_audit_reason: t('invoices.text_24'),
    });
    setBusy(false);
    if (res.error) { toast(errorText(res.error.message), 'error'); return; }
    onSaved();
  }

  return (
    <Modal open onClose={onClose} title={t('invoices.creditModalTitle', { invoice: invoice.invoice_number })} busy={busy} statusMessage={busy ? t('invoices.creditModalBusy') : undefined}>
      <div className="space-y-4">
        <div>
          <label className="label" htmlFor="invoice-credit-reason">{t('invoices.text_25')}</label>
          <select id="invoice-credit-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value as CreditReason)}>
            {Object.entries(CREDIT_REASON).map(([k, v]) => <option key={k} value={k}>{statusLabel(v)}</option>)}
          </select>
        </div>
        <div><label className="label" htmlFor="invoice-credit-amount">{`${t('invoices.setAmount')} (${invoice.currency})`}</label><input id="invoice-credit-amount" type="number" step="0.01" className="input num" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        <div><label className="label" htmlFor="invoice-credit-notes">{t('invoices.setNotes')}</label><textarea id="invoice-credit-notes" className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        <div className="text-xs text-ink-muted">{t('invoices.creditOpenedOn')} {fmtDate(todayISO())}{t('invoices.creditAffectsBalance')}</div>
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <button className="btn-secondary" disabled={busy} onClick={onClose}>{t('invoices.text_26')}</button>
        <button className="btn-primary" disabled={busy} onClick={() => void save()}>{t('invoices.save')}</button>
      </div>
    </Modal>
  );
}
