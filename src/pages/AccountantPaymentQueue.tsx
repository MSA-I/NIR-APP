import { useState } from 'react';
import { reasonOr } from '../lib/reason';
import { Landmark, CheckCircle2, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useToast, StatusBadge, Modal, EmptyState, ErrorNote, PageHeader, SkeletonList, Note, Card, SubPanel, ICON } from '../components/ui';
import { ReauthModal } from '../components/ReauthModal';
import { DocumentList } from '../components/FileUpload';
import { PAYMENT_REQUEST_STATUS } from '../lib/status';
import { bidiIsolate, fmtMoneyExact, fmtDate, todayISO } from '../lib/format';
import { ALLOCATION_REFUSAL_MESSAGES, toHebrewError } from '../lib/errors';
import type { PaymentRequest } from '../lib/types';
import { useAuth } from '../auth/AuthContext';
import {
  financialSupplierBankAccountMap,
  financialSupplierMap,
  formatSupplierBankAccount,
} from '../lib/financialSuppliers';

interface InvoiceAllocationInput {
  invoice_id: string;
  amount_allocated: number;
}

interface SelectedCreditAllocation {
  credit_id: string;
  /**
   * The invoice this credit is ALREADY tied to, straight from `credit_request_balance_rows`.
   * `null` means nobody has tied it yet — not that it may land anywhere by default.
   */
  invoice_id: string | null;
  /**
   * The invoice the accountant picked for this credit on screen. It matters only while
   * `invoice_id` is null: a credit that already names an invoice closes that one and no other,
   * and a target that disagrees with it is refused rather than followed.
   */
  target_invoice_id: string | null;
  amount: number;
  remaining: number;
}

/**
 * One row of `execute_payment_request(p_allocations)`.
 *
 * Exactly ONE of `invoice_id` / `credit_id` is set — the executor still refuses a row that names
 * both, and reusing `invoice_id` for a credit's target would count the offset as cash and inflate
 * `payments.amount`. So the target of a credit travels in its own key, and only on a credit row.
 */
interface PaymentAllocationPayload {
  invoice_id: string | null;
  credit_id: string | null;
  amount: number;
  /**
   * The invoice an unlinked credit lands on (0173). Required by the executor when
   * `credit_requests.invoice_id IS NULL` — it writes the link from this value, once, inside the
   * same transaction. Omitted for a credit that already names an invoice: that one is not
   * movable, and repeating its link here would only add a second place to get it wrong.
   */
  credit_invoice_id?: string;
}

/** One row of `credit_request_balance_rows` (0173, currency added in 0219). */
export interface SupplierCreditBalance {
  credit_id: string;
  invoice_id: string | null;
  credit_number: number;
  /** The credit's own currency — it can only ever be offset against a debt in the same one. */
  currency: string;
  amount: number;
  allocated_amount: number;
  remaining_amount: number;
  status: string;
}

/**
 * Splits the supplier's open credits into the two ways this request may offset them, and the one
 * way it may not.
 *
 * `credit_request_balance_rows` returns every open credit of the supplier — so supplier identity
 * is settled by the query, and the only remaining question is WHICH INVOICE each credit closes.
 *
 * - `available` — the credit already names an invoice of this request. It closes that invoice and
 *   no other; there is nothing to choose.
 * - `unlinked` — the credit names no invoice yet. Owner ruling, 23.08.2026 (OPEN-DECISIONS #243,
 *   #244): such a credit may be offset against ANY invoice of the same supplier, and the link is
 *   recorded at the moment of allocation. It is offered, and the accountant picks the invoice.
 *   Nothing here picks one for them — see `buildPaymentAllocations`.
 * - `otherRequests` — the credit names an invoice outside this request. Still refused: offsetting
 *   it here would shrink the transfer while the request's own invoices stay open, and the invoice
 *   ledger and the payment ledger would drift apart. Returned rather than dropped, so the screen
 *   can say why a credit it clearly holds is not on offer.
 * - `otherCurrency` — the credit is money of a different kind from the debt this request pays
 *   (0217, OPEN-DECISIONS #277). A ₪500 credit does not reduce a $3,100 invoice by 500 of
 *   anything, and there is no rate here to make it reduce it by some other number either. Refused
 *   for the same reason as `otherRequests` and returned for the same reason: the accountant can
 *   see the supplier holds it, and read why it is not on offer against THIS transfer.
 */
export function partitionSupplierCredits(
  balances: SupplierCreditBalance[],
  requestInvoiceIds: ReadonlySet<string>,
  requestCurrency: string,
): { open: SupplierCreditBalance[]; available: SupplierCreditBalance[];
     unlinked: SupplierCreditBalance[]; otherRequests: SupplierCreditBalance[];
     otherCurrency: SupplierCreditBalance[] } {
  const open = balances.filter(
    (credit) => credit.status === 'received' && credit.remaining_amount > 0);
  // The currency test comes FIRST, so a credit in another currency never reaches the two buckets
  // the screen offers — whether or not it names an invoice of this request.
  const sameCurrency = open.filter((credit) => credit.currency === requestCurrency);
  return {
    open,
    available: sameCurrency.filter(
      (credit) => credit.invoice_id != null && requestInvoiceIds.has(credit.invoice_id)),
    unlinked: sameCurrency.filter((credit) => credit.invoice_id == null),
    otherRequests: sameCurrency.filter(
      (credit) => credit.invoice_id != null && !requestInvoiceIds.has(credit.invoice_id)),
    otherCurrency: open.filter((credit) => credit.currency !== requestCurrency),
  };
}

const agora = (value: number) => Math.round(value * 100);
const money = (value: number) => value / 100;

/** Ties the visible refusal to the control it disables. */
const ALLOCATION_ERROR_ID = 'payment-execution-allocation-error';

/**
 * The inline reason next to the disabled button.
 *
 * The sentences live in `src/lib/errors.ts` with every other Hebrew refusal, so a failure the
 * browser caught before the RPC and the same failure returned by the server read identically.
 * Only the fallback differs, and deliberately: here we know the operation, so "the split could
 * not be computed" beats the generic "the action failed".
 */
const allocationRefusal = (error: unknown) =>
  ALLOCATION_REFUSAL_MESSAGES[(error as Error | undefined)?.message ?? '']
  ?? 'לא ניתן לחשב את פיצול התשלום מהזיכויים שנבחרו';

/**
 * Replaces part of the approved liability with supplier credit while preserving the approved
 * total. Invoice allocations are the cash transfer; credit allocations are the offset. Integer
 * agorot keep the browser from manufacturing a rounding remainder that the database rejects.
 *
 * EVERY credit offsets exactly ONE invoice, and the offset is subtracted from the cash of THAT
 * invoice, never from a pooled figure: an earlier version reduced one shared pot and then filled
 * invoices in array order, which left whichever invoice happened to come last short by the credit
 * — an invoice the credit had nothing to do with, chosen by an unordered
 * `payment_request_invoices` read.
 *
 * WHICH invoice depends on how the credit arrived:
 * - A credit that already names one (`credit_requests.invoice_id`, reported by
 *   `credit_request_balance_rows`) closes that one. `p0_invoice_balance_rows` closes the same
 *   invoice once the credit is consumed, so there is nothing to choose and a `target_invoice_id`
 *   that disagrees is refused instead of followed.
 * - A credit that names none takes the invoice the accountant chose (owner, 23.08.2026). A
 *   missing choice is a refusal by name — never the first entry of the invoice array, never "the
 *   first that fits". The invoice this lands on is the invoice that ends up short, and picking it
 *   quietly would hand a decision with a money consequence to array order. The choice rides out
 *   to the executor as `credit_invoice_id` on that credit's allocation row, which is what records
 *   the link.
 */
export function buildPaymentAllocations(
  invoices: InvoiceAllocationInput[],
  credits: SelectedCreditAllocation[],
): { allocations: PaymentAllocationPayload[]; cashAmount: number; creditAmount: number } {
  // One entry per invoice: the executor rejects two allocations naming the same invoice.
  const cashByInvoice = new Map<string, number>();
  for (const invoice of invoices) {
    cashByInvoice.set(
      invoice.invoice_id,
      (cashByInvoice.get(invoice.invoice_id) ?? 0) + agora(invoice.amount_allocated),
    );
  }

  let creditTotal = 0;
  // The invoice each unlinked credit was pointed at, so the payload can carry to the executor the
  // same target this arithmetic used. A linked credit is absent from here on purpose: the server
  // already knows its invoice, and sending it again would be a second place to get it wrong.
  const chosenTargetByCredit = new Map<string, string>();
  for (const credit of credits) {
    const amount = agora(credit.amount);
    if (amount <= 0) continue;
    if (amount > agora(credit.remaining)) throw new Error('credit_allocation_exceeds_remaining');
    // A credit that already names an invoice is not portable. Moving it would close an invoice
    // the credit note never referred to while the one it did refer to stays open.
    if (credit.invoice_id && credit.target_invoice_id
        && credit.target_invoice_id !== credit.invoice_id) {
      throw new Error('credit_invoice_link_immutable');
    }
    const target = credit.invoice_id ?? credit.target_invoice_id;
    // No fallback on purpose. An unselected target must stay unselected. Same name the executor
    // raises for the same omission, so the accountant reads one sentence either way.
    if (!target) throw new Error('credit_allocation_invoice_required');
    // Refused, not silently dropped: `invoices` is this request's invoices, all of them this
    // request's supplier, so a target outside the map is an invoice of another request or of
    // another supplier. Offsetting cash here while that invoice sits elsewhere is exactly how the
    // invoice ledger and the payment ledger drift apart. The server is not assumed to catch this.
    if (!cashByInvoice.has(target)) throw new Error('credit_invoice_not_in_request');
    const invoiceCash = cashByInvoice.get(target) ?? 0;
    // An offset larger than the invoice it lands on cannot be absorbed without shortening a
    // different invoice. Refuse and say so, rather than truncate.
    if (amount > invoiceCash) throw new Error('credit_allocation_exceeds_invoice');
    cashByInvoice.set(target, invoiceCash - amount);
    if (!credit.invoice_id) chosenTargetByCredit.set(credit.credit_id, target);
    creditTotal += amount;
  }

  const allocations: PaymentAllocationPayload[] = [];
  let cashTotal = 0;
  for (const [invoiceId, cash] of cashByInvoice) {
    if (cash <= 0) continue; // fully offset by credit — the executor rejects a zero allocation
    cashTotal += cash;
    allocations.push({ invoice_id: invoiceId, credit_id: null, amount: money(cash) });
  }
  if (cashTotal < 1) throw new Error('payment_cash_amount_required');

  for (const credit of credits) {
    const amount = agora(credit.amount);
    if (amount > 0) {
      const chosenTarget = chosenTargetByCredit.get(credit.credit_id);
      allocations.push({
        invoice_id: null,
        credit_id: credit.credit_id,
        amount: money(amount),
        // Present only for a credit that had no invoice: the executor writes the link from it,
        // once, in the same transaction. Spread so the key is absent — not `undefined` — on the
        // linked path, which keeps that payload byte-identical to what it has always sent.
        ...(chosenTarget ? { credit_invoice_id: chosenTarget } : {}),
      });
    }
  }
  return { allocations, cashAmount: money(cashTotal), creditAmount: money(creditTotal) };
}

/**
 * Focused execution view for the accountant persona.
 * Shows ONLY approved payment requests + the details needed to perform a transfer.
 */
type Row = Omit<PaymentRequest, 'supplier'> & {
  supplier: { id: string; name: string; bank_details: string | null };
  invoices: { invoice_id: string; amount_allocated: number; invoice: { invoice_number: string } | null }[];
  approver: { full_name: string } | null;
};
type RawRow = Omit<Row, 'supplier'>;

/**
 * The one payment-execution queue (G4, 10.08.2026).
 *
 * There used to be a second mode here — the owner's emergency route, reached from
 * /pay/emergency. The owner asked for it to go, and what makes that safe rather than lossy is
 * that it never did anything this path cannot: the same approved payment requests, the same
 * reference, the same mandatory reason, the same audit row. Its only differences were an
 * unconditional password prompt and a separate RPC — and 0061 asserts password freshness on
 * this RPC too.
 *
 * Emergency payments already executed keep their payments, their audit rows and their history.
 * Only the ability to start a NEW one is gone.
 */
export default function AccountantPaymentQueue() {
  const [selected, setSelected] = useState<Row | null>(null);

  const { data, loading, error, refetch } = useQuery(async () => {
    const rows = unwrap(await supabase.from('payment_requests')
      .select('*, invoices:payment_request_invoices(invoice_id, amount_allocated, invoice:invoices(invoice_number)), approver:profiles!p0_pr_approved_actor_tenant_fk(full_name)')
      .in('status', ['approved', 'sent_for_execution', 'executed', 'matched'])
      .order('due_date', { ascending: true, nullsFirst: false })) as RawRow[];
    const supplierIds = rows.map((row) => row.supplier_id);
    const [suppliers, bankAccounts] = await Promise.all([
      financialSupplierMap(supplierIds),
      financialSupplierBankAccountMap(supplierIds),
    ]);
    return rows.map<Row>((row) => ({
      ...row,
      supplier: {
        ...(suppliers.get(row.supplier_id) ?? {
          id: row.supplier_id, name: '—', tax_id: null, payment_terms: null, status: 'active', bank_details: null,
        }),
        bank_details: formatSupplierBankAccount(bankAccounts.get(row.supplier_id)),
      },
    }));
  });

  if (loading) return <SkeletonList />;
  if (error) return <ErrorNote message={error} />;

  const pending = (data ?? []).filter((r) => ['approved', 'sent_for_execution'].includes(r.status));
  const done = (data ?? []).filter((r) => ['executed', 'matched'].includes(r.status));

  return (
    <div className="space-y-5 max-w-2xl">
      <PageHeader title="תשלומים לביצוע"
        meta={`${pending.length} העברות ממתינות לביצוע`} />

      {!pending.length ? (
        <Card pad={false}><EmptyState title="אין העברות שממתינות לביצוע" subtitle="דרישות תשלום מאושרות יופיעו כאן" /></Card>
      ) : (
        <div className="space-y-3">
          {pending.map((r) => (
            <Card as="button" key={r.id} pad={false} className="card-link-hover w-full text-start p-4 sm:p-5" onClick={() => setSelected(r)}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="min-w-0 break-words font-semibold text-ink">{r.supplier.name}</span>
                <span className="kpi-value-compact num shrink-0">{fmtMoneyExact(r.amount, r.currency)}</span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-ink-muted">
                <StatusBadge meta={PAYMENT_REQUEST_STATUS[r.status]} />
                {r.due_date && <span>לתשלום עד {fmtDate(r.due_date)}</span>}
                <span>{r.invoices.length} חשבוניות</span>
              </div>
              {r.open_credit_override_total != null && (
                <div className="mt-3 text-sm text-await-fg">
                  אושר בחריגה ללא קיזוז זיכויים בסך <span className="num font-semibold">{fmtMoneyExact(r.open_credit_override_total, r.currency)}</span>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {done.length > 0 && (
        <div>
          <h2 className="section-title mb-2 text-ink-muted">בוצעו לאחרונה</h2>
          <Card pad={false} className="divide-y divide-line-soft">
            {done.slice(0, 8).map((r) => (
              <div key={r.id} className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                <span className="min-w-0 break-words">{r.supplier.name}</span>
                <span className="flex shrink-0 items-center gap-3">
                  <StatusBadge meta={PAYMENT_REQUEST_STATUS[r.status]} />
                  <span className="num font-medium">{fmtMoneyExact(r.amount, r.currency)}</span>
                </span>
              </div>
            ))}
          </Card>
        </div>
      )}

      {selected && <ExecuteModal pr={selected} onClose={() => setSelected(null)} onDone={() => { setSelected(null); void refetch(); }} />}
    </div>
  );
}

function ExecuteModal({ pr, onClose, onDone }: { pr: Row; onClose: () => void; onDone: () => void }) {
  const { profile } = useAuth();
  const toast = useToast();
  const [f, setF] = useState({ paid_date: todayISO(), reference: '', notes: '', reason: '' });
  const [reauthOpen, setReauthOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [creditAmounts, setCreditAmounts] = useState<Record<string, string>>({});
  // Which invoice the accountant chose for a credit that names none. Starts empty and stays empty
  // until someone picks — there is no seeded first invoice to inherit.
  const [creditTargets, setCreditTargets] = useState<Record<string, string>>({});
  const { data: creditBalances, loading: creditsLoading, error: creditsError } = useQuery(async () =>
    unwrap(await supabase.rpc('credit_request_balance_rows', {
      p_supplier_id: pr.supplier.id,
    })) as SupplierCreditBalance[]);

  const requestInvoiceIds = new Set(pr.invoices.map((invoice) => invoice.invoice_id));
  const invoiceNumberById = new Map(
    pr.invoices.map((invoice) => [invoice.invoice_id, invoice.invoice?.invoice_number ?? null]));
  const invoiceAmountById = new Map(
    pr.invoices.map((invoice) => [invoice.invoice_id, invoice.amount_allocated]));

  const {
    open: openCredits,
    available: availableCredits,
    unlinked: unlinkedCredits,
    otherRequests: otherRequestCredits,
    otherCurrency: otherCurrencyCredits,
  } = partitionSupplierCredits(creditBalances ?? [], requestInvoiceIds, pr.currency);

  // Both buckets are on offer. `target_invoice_id` is read from the picker for every credit, not
  // only for the unlinked ones: that way a linked credit that somehow carries a foreign target is
  // refused by name instead of having its own link quietly reasserted over the accountant's pick.
  const selectableCredits = [...availableCredits, ...unlinkedCredits];
  const selectedCredits = selectableCredits.map((credit) => ({
    credit_id: credit.credit_id,
    invoice_id: credit.invoice_id,
    target_invoice_id: creditTargets[credit.credit_id] || null,
    amount: Number(creditAmounts[credit.credit_id] || 0),
    remaining: credit.remaining_amount,
  })).filter((credit) => Number.isFinite(credit.amount) && credit.amount > 0);
  let allocationPreview: ReturnType<typeof buildPaymentAllocations> | null = null;
  let allocationError: string | null = null;
  try {
    allocationPreview = buildPaymentAllocations(pr.invoices, selectedCredits);
  } catch (error) {
    allocationPreview = null;
    allocationError = allocationRefusal(error);
  }

  // Field validation first, then the step-up gate. Re-authentication happens only when the JWT's
  // password AMR entry is stale — the server (0061) asserts freshness itself, so a fresh session
  // sees no new modal and a stale one is prompted instead of rejected.
  function requestExecute() {
    if (!f.reference.trim()) { toast('נדרשת אסמכתת העברה', 'error'); return; }
    if (!allocationPreview) {
      toast(allocationError ?? 'לא ניתן לחשב את פיצול התשלום מהזיכויים שנבחרו', 'error');
      return;
    }
    setReauthOpen(true);
  }

  async function execute() {
    setBusy(true);
    try {
      const payment = unwrap(await supabase.rpc('execute_payment_request', {
        p_payment_request_id: pr.id,
        p_paid_date: f.paid_date,
        p_method: 'העברה בנקאית',
        p_reference: f.reference.trim(),
        p_notes: f.notes.trim() || null,
        p_allocations: allocationPreview?.allocations ?? [],
        p_reason: reasonOr(f.reason, 'ביצוע העברת תשלום'),
      })) as { payment_id: string };

      setPaymentId(payment.payment_id);
      toast('ההעברה נרשמה בהצלחה');
    } catch (e) {
      toast(toHebrewError(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (paymentId) {
    return (
      <Modal open onClose={onDone} title="ההעברה נרשמה">
        <div className="text-center mb-4">
          <CheckCircle2 size={ICON.hero} className="text-done-fg mx-auto mb-2" aria-hidden="true" />
          <p className="text-sm text-ink-soft">אפשר לצרף עכשיו אישור העברה (צילום מסך / PDF).</p>
        </div>
        <DocumentList entityType="payment" entityId={paymentId} capture />
        <div className="flex justify-end mt-4"><button className="btn-primary" onClick={onDone}>סיום</button></div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} title={`ביצוע העברה — ${pr.supplier.name}`} busy={busy} statusMessage={busy ? 'רושם את ההעברה' : undefined}>
      <div className="space-y-4">
        <SubPanel className="border border-line">
          <div className="flex items-center gap-2 text-sm font-medium text-ink-mid mb-1"><Landmark size={ICON.sm} aria-hidden="true" /> פרטי חשבון להעברה</div>
          <div className="text-sm text-ink-body text-start" dir="ltr">{pr.supplier.bank_details ?? 'לא הוזנו פרטי בנק'}</div>
        </SubPanel>

        {/* The queue records a completed transfer; it never claims to perform the bank action. */}
        {!pr.supplier.bank_details && (
          <Note tone="alert">
            <span>
              לא הוזנו פרטי בנק לספק זה, ולכן לא ניתן לבצע את ההעברה. יש לפנות לבעלים או למנהל הרכש כדי שיזינו את הפרטים
              בכרטיס הספק. אין במסך זה דרך לדווח על כך.
            </span>
          </Note>
        )}
        <p className="text-xs text-ink-muted">
          הכפתור בתחתית המסך <b>מתעד</b> העברה שכבר בוצעה בבנק — הוא אינו מבצע אותה. אין ללחוץ עליו לפני שההעברה נעשתה בפועל.
        </p>

        <dl className="text-sm space-y-1.5 [&>div]:flex-wrap [&>div]:gap-x-4 [&>div]:gap-y-0.5">
          {/* One transfer, one currency. The request, its invoices, the credits offset against
              them and the payment that results are all money of the same kind — settlement from
              an account in another currency is recorded on the payment (#286) and does not change
              any figure here. */}
          <div className="flex justify-between"><dt className="text-ink-muted">סכום מאושר</dt><dd className="font-semibold num">{fmtMoneyExact(pr.amount, pr.currency)}</dd></div>
          {/* `—`, never `0`: while the credits load, or while the selection is invalid, the offset
              is unknown — and an unknown offset printed as ₪0.00 is a claim that none was taken. */}
          <div className="flex justify-between"><dt className="text-ink-muted">קיזוז זיכויים</dt><dd className="num">{fmtMoneyExact(allocationPreview?.creditAmount ?? null, pr.currency)}</dd></div>
          <div className="flex justify-between"><dt className="text-ink-muted">סכום להעברה בפועל</dt><dd className="font-semibold num">{fmtMoneyExact(allocationPreview?.cashAmount ?? null, pr.currency)}</dd></div>
          {pr.due_date && <div className="flex justify-between"><dt className="text-ink-muted">תאריך יעד</dt><dd>{fmtDate(pr.due_date)}</dd></div>}
          <div className="flex justify-between"><dt className="text-ink-muted">חשבוניות</dt>
            <dd dir="ltr">{pr.invoices.map((i) => i.invoice?.invoice_number).filter(Boolean).join(', ') || 'לא זמינות'}</dd></div>
          <div className="flex justify-between"><dt className="text-ink-muted">אושר על ידי</dt><dd>{pr.approver?.full_name ?? 'לא זמין'}</dd></div>
          <div className="flex justify-between"><dt className="text-ink-muted">מבוצע על ידי</dt><dd>{profile?.full_name ?? 'המשתמש המחובר'}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-ink-muted">רישום ביומן</dt><dd className="text-start">{'ביצוע תשלום והסיבה'}</dd></div>
          {pr.notes && <Note tone="await">{pr.notes}</Note>}
          {pr.open_credit_override_total != null && (
            <Note tone="alert">
              <span className="min-w-0 flex-1">
                <strong>אושר באישור חריג ללא קיזוז הזיכוי.</strong>{' '}
                הזיכויים הפתוחים בסך <span className="num">{fmtMoneyExact(pr.open_credit_override_total, pr.currency)}</span> לא קוזזו אוטומטית.
                <span className="block mt-1">סיבת אישור החריגה: {pr.open_credit_override_reason}</span>
              </span>
            </Note>
          )}
        </dl>

        <SubPanel>
          <h3 className="text-sm font-medium text-ink-soft">זיכויים זמינים לקיזוז</h3>
          {creditsLoading && <p className="mt-2 text-sm text-ink-muted" role="status">טוען יתרות זיכוי…</p>}
          {creditsError && <p className="mt-2 text-sm text-alert-fg" role="alert">{creditsError}</p>}
          {!creditsLoading && !creditsError && openCredits.length === 0 && (
            <p className="mt-2 text-sm text-ink-muted">אין זיכויים פתוחים לספק זה</p>
          )}
          {!creditsLoading && !creditsError && openCredits.length > 0 && selectableCredits.length === 0 && (
            <p className="mt-2 text-sm text-ink-muted">
              אין זיכויים פתוחים שניתן לקזז מול חשבוניות דרישת התשלום הזו
            </p>
          )}

          {/* Said out loud rather than left as a shorter list: the accountant can see in the
              supplier card that this credit exists, so silence here would read as a bug. */}
          {otherCurrencyCredits.length > 0 && (
            <Note tone="info" className="mt-3">
              <span>
                <span className="num">{otherCurrencyCredits.length}</span> מהזיכויים הפתוחים של הספק נקובים
                במטבע אחר מההעברה הזו ({pr.currency}), ולכן אינם ניתנים לקיזוז מולה. זיכוי מקזז חוב
                באותו מטבע בלבד — אין כאן המרה.
              </span>
            </Note>
          )}

          {/* Owner ruling, 23.08.2026: an unlinked credit may be offset against any invoice of the
              same supplier, and the link is recorded when the offset is made. The one thing the
              screen must not do is decide WHICH — that choice is what leaves one invoice short. */}
          {unlinkedCredits.length > 0 && (
            <Note tone="info" className="mt-3">
              <span>
                <span className="num">{unlinkedCredits.length}</span> מהזיכויים הפתוחים אינם משויכים
                לחשבונית. ניתן לקזז אותם מול כל אחת מחשבוניות הספק שבדרישה הזו, והשיוך נרשם ברגע
                הקיזוז. יש לבחור את החשבונית במפורש — היא זו שתקוזז, והמערכת לא תבחר עבורך.
              </span>
            </Note>
          )}

          {selectableCredits.length > 0 && (
            <ul className="mt-3 space-y-3">
              {selectableCredits.map((credit) => {
                // A linked credit's target IS its link and the picker is not offered for it. An
                // unlinked one has a target only once somebody chose; `|| null` keeps the empty
                // placeholder from reading as a selection.
                const chosenTarget = credit.invoice_id ?? (creditTargets[credit.credit_id] || null);
                const targetAmount = chosenTarget == null
                  ? null : invoiceAmountById.get(chosenTarget) ?? null;
                const targetHintId = `credit-target-hint-${credit.credit_id}`;
                const amountHintId = `credit-allocation-hint-${credit.credit_id}`;
                return (
                  <li key={credit.credit_id} className="rounded-lg bg-surface-sunken p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                      <span>זיכוי <span className="num">#{credit.credit_number}</span></span>
                      {chosenTarget == null
                        ? <span className="badge-await">דורש בחירת חשבונית</span>
                        : <span className="badge-done">זמין לקיזוז</span>}
                    </div>

                    {/* The linkage is the whole point of the selection — the accountant must see
                        WHICH invoice of this request the offset is taken off. */}
                    {credit.invoice_id != null ? (
                      <p className="mt-1 text-sm text-ink-muted">
                        משויך לחשבונית{' '}
                        <span className="font-medium text-ink-body" dir="ltr">
                          {invoiceNumberById.get(credit.invoice_id) ?? 'מספר לא זמין'}
                        </span>
                      </p>
                    ) : (
                      <>
                        <label className="label mt-2 block" htmlFor={`credit-target-${credit.credit_id}`}>
                          חשבונית שממנה יקוזז הזיכוי
                        </label>
                        <select
                          id={`credit-target-${credit.credit_id}`}
                          className="input mt-1"
                          aria-describedby={targetHintId}
                          value={creditTargets[credit.credit_id] ?? ''}
                          onChange={(event) => setCreditTargets((current) => ({
                            ...current,
                            [credit.credit_id]: event.target.value,
                          }))}
                        >
                          {/* No preselected invoice. The empty option is not a choice, and the
                              allocation refuses by name while it is the one showing. */}
                          <option value="">בחר חשבונית…</option>
                          {/* Built from the deduplicated map, not from the raw rows: two options
                              carrying the same value is a picker whose selection cannot be read
                              back, and `buildPaymentAllocations` already sums repeated rows. */}
                          {[...invoiceAmountById].map(([invoiceId, amount]) => (
                            <option key={invoiceId} value={invoiceId}>
                              {bidiIsolate(invoiceNumberById.get(invoiceId) ?? 'מספר לא זמין')}
                              {' · '}{fmtMoneyExact(amount, pr.currency)}
                            </option>
                          ))}
                        </select>
                        {/* Stated before the choice, not after it: the executor writes the link
                            once, so a partial offset today decides where the remainder may go. */}
                        <p id={targetHintId} className="mt-1 text-xs text-ink-muted">
                          הזיכוי אינו משויך לחשבונית. השיוך שייבחר כאן נרשם עם ביצוע ההעברה ואינו ניתן לשינוי לאחר מכן —
                          גם יתרת הזיכוי שתישאר תוכל להתקזז רק מול אותה חשבונית.
                        </p>
                      </>
                    )}

                    <p className="mt-1 text-sm text-ink-muted">
                      יתרה זמינה <span className="num font-medium text-ink-body">{fmtMoneyExact(credit.remaining_amount, credit.currency)}</span>
                      {targetAmount != null && (
                        <>{' · '}סכום החשבונית בדרישה <span className="num">{fmtMoneyExact(targetAmount, pr.currency)}</span></>
                      )}
                    </p>

                    <label className="label mt-2 block" htmlFor={`credit-allocation-${credit.credit_id}`}>
                      סכום לקיזוז בהעברה זו
                    </label>
                    <input
                      id={`credit-allocation-${credit.credit_id}`}
                      type="number"
                      min="0"
                      max={Math.min(credit.remaining_amount, targetAmount ?? credit.remaining_amount)}
                      step="0.01"
                      className="input num mt-1"
                      value={creditAmounts[credit.credit_id] ?? ''}
                      placeholder="0.00"
                      // Not a hidden rule: without a target there is no invoice to take the offset
                      // off, and the sentence below says so rather than leaving a dead field.
                      disabled={chosenTarget == null}
                      aria-describedby={chosenTarget == null ? amountHintId : undefined}
                      onChange={(event) => setCreditAmounts((current) => ({
                        ...current,
                        [credit.credit_id]: event.target.value,
                      }))}
                    />
                    {chosenTarget == null && (
                      <p id={amountHintId} className="mt-1 text-xs text-await-fg">
                        בחר חשבונית תחילה — בלעדיה אין לדעת מאיזו חשבונית ירד הסכום.
                      </p>
                    )}
                    <p className="mt-1 text-xs text-ink-muted">
                      הוקצו בעבר <span className="num">{fmtMoneyExact(credit.allocated_amount, credit.currency)}</span>
                      {' · '}סכום מקורי <span className="num">{fmtMoneyExact(credit.amount, credit.currency)}</span>
                    </p>
                  </li>
                );
              })}
            </ul>
          )}

          {otherRequestCredits.length > 0 && (
            <div className="mt-3">
              <Note tone="await">
                <span>
                  <span className="num">{otherRequestCredits.length}</span> זיכויים פתוחים משויכים
                  לחשבוניות שאינן בדרישת תשלום זו. קיזוזם כאן היה מקטין את ההעברה מבלי לסגור את
                  החשבוניות שבדרישה.
                </span>
              </Note>
            </div>
          )}
        </SubPanel>

        <hr className="border-line-soft" />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div><label className="label" htmlFor="payment-execution-date">תאריך ביצוע</label><input id="payment-execution-date" type="date" className="input" value={f.paid_date} onChange={(e) => setF((s) => ({ ...s, paid_date: e.target.value }))} /></div>
          <div><label className="label" htmlFor="payment-execution-amount">סכום להעברה בפועל</label><input id="payment-execution-amount" type="number" className="input num" value={allocationPreview?.cashAmount ?? ''} readOnly /></div>
        </div>
        <div><label className="label" htmlFor="payment-execution-reference">אסמכתת העברה *</label><input id="payment-execution-reference" className="input num" dir="ltr" value={f.reference} onChange={(e) => setF((s) => ({ ...s, reference: e.target.value }))} /></div>
        <div><label className="label" htmlFor="payment-execution-notes">הערות</label><input id="payment-execution-notes" className="input" value={f.notes} onChange={(e) => setF((s) => ({ ...s, notes: e.target.value }))} /></div>
        <div><label className="label" htmlFor="payment-execution-reason">סיבת ביצוע / אישור הפעולה *</label><input id="payment-execution-reason" className="input" value={f.reason} onChange={(e) => setF((s) => ({ ...s, reason: e.target.value }))} /></div>

        {/* The button below is disabled while the split cannot be computed; the reason is stated
            here instead of leaving the accountant to guess which figure is wrong, and the button
            POINTS at it — a disabled control whose explanation is only nearby on screen is not an
            explanation to anyone reading the page through a screen reader. */}
        {allocationError && (
          <p id={ALLOCATION_ERROR_ID} className="text-sm text-alert-fg" role="alert">{allocationError}</p>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <button className="btn-secondary" disabled={busy} onClick={onClose}>ביטול</button>
          <button
            className="btn-primary"
            disabled={busy || !allocationPreview}
            // Only while the paragraph exists: a dangling aria-describedby is its own defect.
            aria-describedby={allocationError ? ALLOCATION_ERROR_ID : undefined}
            onClick={requestExecute}
          >
            {busy ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" /> : <CheckCircle2 size={ICON.sm} aria-hidden="true" />} ההעברה בוצעה
          </button>
        </div>
      </div>

      <ReauthModal
        open={reauthOpen}
        title="אימות זהות לביצוע ההעברה"
        onConfirm={() => { setReauthOpen(false); void execute(); }}
        onCancel={() => setReauthOpen(false)}
      />
    </Modal>
  );
}
