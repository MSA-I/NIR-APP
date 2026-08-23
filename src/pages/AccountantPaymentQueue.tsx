import { useState } from 'react';
import { reasonOr } from '../lib/reason';
import { Landmark, CheckCircle2, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useToast, StatusBadge, Modal, EmptyState, ErrorNote, PageHeader, SkeletonList, Note } from '../components/ui';
import { ReauthModal } from '../components/ReauthModal';
import { DocumentList } from '../components/FileUpload';
import { PAYMENT_REQUEST_STATUS } from '../lib/status';
import { fmtMoneyExact, fmtDate, todayISO } from '../lib/format';
import { toHebrewError } from '../lib/errors';
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
  /** The invoice this credit belongs to, straight from `credit_request_balance_rows`. */
  invoice_id: string | null;
  amount: number;
  remaining: number;
}

interface PaymentAllocationPayload {
  invoice_id: string | null;
  credit_id: string | null;
  amount: number;
}

/** One row of `credit_request_balance_rows` (0173). */
export interface SupplierCreditBalance {
  credit_id: string;
  invoice_id: string | null;
  credit_number: number;
  amount: number;
  allocated_amount: number;
  remaining_amount: number;
  status: string;
}

/**
 * Splits the supplier's open credits into what THIS request may offset and what it may not.
 *
 * `credit_request_balance_rows` returns every open credit of the supplier, and a credit closes
 * the one invoice it names. Offering a credit that names an invoice outside this request would
 * let the accountant shrink the transfer while the request's own invoices stay open — cash down,
 * invoice ledger and payment ledger apart. Both exclusions are returned rather than dropped, so
 * the screen can say why a credit it clearly holds is not on offer.
 */
export function partitionSupplierCredits(
  balances: SupplierCreditBalance[],
  requestInvoiceIds: ReadonlySet<string>,
): { open: SupplierCreditBalance[]; available: SupplierCreditBalance[];
     unlinked: SupplierCreditBalance[]; otherRequests: SupplierCreditBalance[] } {
  const open = balances.filter(
    (credit) => credit.status === 'received' && credit.remaining_amount > 0);
  return {
    open,
    available: open.filter(
      (credit) => credit.invoice_id != null && requestInvoiceIds.has(credit.invoice_id)),
    // OPEN-DECISIONS: which invoice an unlinked credit offsets is a business question the owner
    // has not answered. Until it is, such a credit is not selectable and the reason is shown.
    unlinked: open.filter((credit) => credit.invoice_id == null),
    otherRequests: open.filter(
      (credit) => credit.invoice_id != null && !requestInvoiceIds.has(credit.invoice_id)),
  };
}

const agora = (value: number) => Math.round(value * 100);
const money = (value: number) => value / 100;

/** Named refusals of `buildPaymentAllocations`, said in the accountant's language. */
const ALLOCATION_REFUSALS: Record<string, string> = {
  credit_allocation_exceeds_remaining: 'סכום הקיזוז חורג מיתרת הזיכוי הזמינה',
  credit_allocation_exceeds_invoice: 'סכום הקיזוז חורג מסכום החשבונית שאליה משויך הזיכוי',
  credit_invoice_not_in_request: 'זיכוי שנבחר אינו משויך לחשבונית מדרישת התשלום הזו',
  payment_cash_amount_required:
    'חייב להישאר סכום להעברה בפועל — לא ניתן לכסות את מלוא הדרישה בזיכויים',
};

const allocationRefusal = (error: unknown) =>
  ALLOCATION_REFUSALS[(error as Error | undefined)?.message ?? '']
  ?? 'לא ניתן לחשב את פיצול התשלום מהזיכויים שנבחרו';

/**
 * Replaces part of the approved liability with supplier credit while preserving the approved
 * total. Invoice allocations are the cash transfer; credit allocations are the offset. Integer
 * agorot keep the browser from manufacturing a rounding remainder that the database rejects.
 *
 * A credit belongs to exactly ONE invoice (`credit_requests.invoice_id`, reported by
 * `credit_request_balance_rows`), and `p0_invoice_balance_rows` closes that same invoice once the
 * credit is consumed. So the offset is subtracted from the cash of ITS invoice, never from a
 * pooled figure: the earlier version reduced one shared pot and then filled invoices in array
 * order, which left whichever invoice happened to come last short by the credit — an invoice the
 * credit had nothing to do with, chosen by an unordered `payment_request_invoices` read.
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
  for (const credit of credits) {
    const amount = agora(credit.amount);
    if (amount <= 0) continue;
    if (amount > agora(credit.remaining)) throw new Error('credit_allocation_exceeds_remaining');
    // Refused, not silently dropped: offsetting cash here while the invoice the credit actually
    // closes sits in another request is exactly how the invoice ledger and the payment ledger
    // drift apart. The server is not assumed to catch this.
    if (!credit.invoice_id || !cashByInvoice.has(credit.invoice_id)) {
      throw new Error('credit_invoice_not_in_request');
    }
    const invoiceCash = cashByInvoice.get(credit.invoice_id) ?? 0;
    // An offset larger than its own invoice cannot be absorbed without shortening a different
    // invoice. Refuse and say so, rather than truncate.
    if (amount > invoiceCash) throw new Error('credit_allocation_exceeds_invoice');
    cashByInvoice.set(credit.invoice_id, invoiceCash - amount);
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
      allocations.push({ invoice_id: null, credit_id: credit.credit_id, amount: money(amount) });
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
        <div className="card"><EmptyState title="אין העברות שממתינות לביצוע" subtitle="דרישות תשלום מאושרות יופיעו כאן" /></div>
      ) : (
        <div className="space-y-3">
          {pending.map((r) => (
            <button key={r.id} className="card w-full text-start p-4 hover:border-action-line transition-all" onClick={() => setSelected(r)}>
              <div className="flex items-center justify-between">
                <span className="font-semibold text-ink">{r.supplier.name}</span>
                <span className="kpi-value-compact num">{fmtMoneyExact(r.amount)}</span>
              </div>
              <div className="flex items-center gap-3 mt-1.5 text-sm text-ink-muted">
                <StatusBadge meta={PAYMENT_REQUEST_STATUS[r.status]} />
                {r.due_date && <span>לתשלום עד {fmtDate(r.due_date)}</span>}
                <span>{r.invoices.length} חשבוניות</span>
              </div>
              {r.open_credit_override_total != null && (
                <div className="mt-3 text-sm text-await-fg">
                  אושר בחריגה ללא קיזוז זיכויים בסך <span className="num font-semibold">{fmtMoneyExact(r.open_credit_override_total)}</span>
                </div>
              )}
            </button>
          ))}
        </div>
      )}

      {done.length > 0 && (
        <div>
          <h2 className="section-title mb-2 text-ink-muted">בוצעו לאחרונה</h2>
          <div className="card divide-y divide-line-soft">
            {done.slice(0, 8).map((r) => (
              <div key={r.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                <span>{r.supplier.name}</span>
                <span className="flex items-center gap-3">
                  <StatusBadge meta={PAYMENT_REQUEST_STATUS[r.status]} />
                  <span className="num font-medium">{fmtMoneyExact(r.amount)}</span>
                </span>
              </div>
            ))}
          </div>
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
  } = partitionSupplierCredits(creditBalances ?? [], requestInvoiceIds);

  const selectedCredits = availableCredits.map((credit) => ({
    credit_id: credit.credit_id,
    invoice_id: credit.invoice_id,
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
          <CheckCircle2 size={40} className="text-done-fg mx-auto mb-2" />
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
        <div className="rounded-lg bg-surface-sunken border border-line px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-ink-mid mb-1"><Landmark size={15} /> פרטי חשבון להעברה</div>
          <div className="text-sm text-ink-body text-start" dir="ltr">{pr.supplier.bank_details ?? 'לא הוזנו פרטי בנק'}</div>
        </div>

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

        <dl className="text-sm space-y-1.5">
          <div className="flex justify-between"><dt className="text-ink-muted">סכום מאושר</dt><dd className="font-semibold num">{fmtMoneyExact(pr.amount)}</dd></div>
          {/* `—`, never `0`: while the credits load, or while the selection is invalid, the offset
              is unknown — and an unknown offset printed as ₪0.00 is a claim that none was taken. */}
          <div className="flex justify-between"><dt className="text-ink-muted">קיזוז זיכויים</dt><dd className="num">{fmtMoneyExact(allocationPreview?.creditAmount ?? null)}</dd></div>
          <div className="flex justify-between"><dt className="text-ink-muted">סכום להעברה בפועל</dt><dd className="font-semibold num">{fmtMoneyExact(allocationPreview?.cashAmount ?? null)}</dd></div>
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
                הזיכויים הפתוחים בסך <span className="num">{fmtMoneyExact(pr.open_credit_override_total)}</span> לא קוזזו אוטומטית.
                <span className="block mt-1">סיבת אישור החריגה: {pr.open_credit_override_reason}</span>
              </span>
            </Note>
          )}
        </dl>

        <div className="rounded-lg border border-line bg-surface p-4">
          <h3 className="text-sm font-medium text-ink-soft">זיכויים זמינים לקיזוז</h3>
          {creditsLoading && <p className="mt-2 text-sm text-ink-muted" role="status">טוען יתרות זיכוי…</p>}
          {creditsError && <p className="mt-2 text-sm text-alert-fg" role="alert">{creditsError}</p>}
          {!creditsLoading && !creditsError && openCredits.length === 0 && (
            <p className="mt-2 text-sm text-ink-muted">אין זיכויים פתוחים לספק זה</p>
          )}
          {!creditsLoading && !creditsError && openCredits.length > 0 && availableCredits.length === 0 && (
            <p className="mt-2 text-sm text-ink-muted">
              אין זיכויים פתוחים המשויכים לחשבוניות של דרישת התשלום הזו
            </p>
          )}
          {availableCredits.length > 0 && (
            <ul className="mt-3 space-y-3">
              {availableCredits.map((credit) => (
                <li key={credit.credit_id} className="rounded-lg bg-surface-sunken p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span>זיכוי <span className="num">#{credit.credit_number}</span></span>
                    <span className="badge-done">זמין לקיזוז</span>
                  </div>
                  {/* The linkage is the whole point of the selection — the accountant must see
                      WHICH invoice of this request the offset is taken off. */}
                  <p className="mt-1 text-sm text-ink-muted">
                    משויך לחשבונית{' '}
                    <span className="font-medium text-ink-body" dir="ltr">
                      {invoiceNumberById.get(credit.invoice_id ?? '') ?? 'מספר לא זמין'}
                    </span>
                  </p>
                  <p className="mt-1 text-sm text-ink-muted">
                    יתרה זמינה <span className="num font-medium text-ink-body">{fmtMoneyExact(credit.remaining_amount)}</span>
                  </p>
                  <label className="label mt-2 block" htmlFor={`credit-allocation-${credit.credit_id}`}>
                    סכום לקיזוז בהעברה זו
                  </label>
                  <input
                    id={`credit-allocation-${credit.credit_id}`}
                    type="number"
                    min="0"
                    max={Math.min(
                      credit.remaining_amount,
                      invoiceAmountById.get(credit.invoice_id ?? '') ?? credit.remaining_amount,
                    )}
                    step="0.01"
                    className="input num mt-1"
                    value={creditAmounts[credit.credit_id] ?? ''}
                    placeholder="0.00"
                    onChange={(event) => setCreditAmounts((current) => ({
                      ...current,
                      [credit.credit_id]: event.target.value,
                    }))}
                  />
                  <p className="mt-1 text-xs text-ink-muted">
                    הוקצו בעבר <span className="num">{fmtMoneyExact(credit.allocated_amount)}</span>
                    {' · '}סכום מקורי <span className="num">{fmtMoneyExact(credit.amount)}</span>
                  </p>
                </li>
              ))}
            </ul>
          )}

          {unlinkedCredits.length > 0 && (
            <div className="mt-3">
              <Note tone="await">
                <span>
                  <span className="num">{unlinkedCredits.length}</span> זיכויים פתוחים אינם משויכים
                  לחשבונית, ולכן אינם ניתנים לקיזוז כאן. לאיזו חשבונית זיכוי כזה נזקף היא החלטה
                  עסקית שטרם הוכרעה, ואין למערכת ברירת מחדל. יש לשייך את הזיכוי לחשבונית לפני קיזוז.
                </span>
              </Note>
            </div>
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
        </div>

        <hr className="border-line-soft" />

        <div className="grid grid-cols-2 gap-3">
          <div><label className="label" htmlFor="payment-execution-date">תאריך ביצוע</label><input id="payment-execution-date" type="date" className="input" value={f.paid_date} onChange={(e) => setF((s) => ({ ...s, paid_date: e.target.value }))} /></div>
          <div><label className="label" htmlFor="payment-execution-amount">סכום להעברה בפועל</label><input id="payment-execution-amount" type="number" className="input num" value={allocationPreview?.cashAmount ?? ''} readOnly /></div>
        </div>
        <div><label className="label" htmlFor="payment-execution-reference">אסמכתת העברה *</label><input id="payment-execution-reference" className="input num" dir="ltr" value={f.reference} onChange={(e) => setF((s) => ({ ...s, reference: e.target.value }))} /></div>
        <div><label className="label" htmlFor="payment-execution-notes">הערות</label><input id="payment-execution-notes" className="input" value={f.notes} onChange={(e) => setF((s) => ({ ...s, notes: e.target.value }))} /></div>
        <div><label className="label" htmlFor="payment-execution-reason">סיבת ביצוע / אישור הפעולה *</label><input id="payment-execution-reason" className="input" value={f.reason} onChange={(e) => setF((s) => ({ ...s, reason: e.target.value }))} /></div>

        {/* The button below is disabled while the split cannot be computed; the reason is stated
            here instead of leaving the accountant to guess which figure is wrong. */}
        {allocationError && (
          <p className="text-sm text-alert-fg" role="alert">{allocationError}</p>
        )}

        <div className="flex justify-end gap-2">
          <button className="btn-secondary" disabled={busy} onClick={onClose}>ביטול</button>
          <button className="btn-primary" disabled={busy || !allocationPreview} onClick={requestExecute}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />} ההעברה בוצעה
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
