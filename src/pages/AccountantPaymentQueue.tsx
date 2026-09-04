import type { TKey } from '../lib/i18n/t';
import { useT } from '../lib/i18n/LocaleProvider';
import { useState } from 'react';
import { Link } from 'react-router';
import { reasonOr } from '../lib/reason';
import { Landmark, CheckCircle2, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { fetchAll, fetchInChunks } from '../lib/supabasePaging';
import { useToast, StatusBadge, Modal, EmptyState, ErrorNote, PageHeader, SkeletonList, Note, Card, SubPanel, ICON } from '../components/ui';
import { ReauthModal } from '../components/ReauthModal';
import { DocumentList } from '../components/FileUpload';
import { EXCEPTION_TYPE, PAYMENT_REQUEST_STATUS } from '../lib/status';
import { bidiIsolate, fmtMoneyExact, fmtDate, todayISO } from '../lib/format';
import { ALLOCATION_REFUSAL_MESSAGES } from '../lib/errors';
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

const minorAmount = (value: number, minorUnits: number) => Math.round(value * (10 ** minorUnits));
const majorAmount = (value: number, minorUnits: number) => value / (10 ** minorUnits);

/** One row of `invoice_balances_by_currency` (0218), narrowed to what this screen reads. */
export interface QueueInvoiceBalance {
  invoice_id: string;
  balance_in_currency: number;
}

/** An open `exceptions` row this screen may have to mention. */
export interface QueueException {
  id: string;
  type: string;
  severity: 'low' | 'medium' | 'high';
  title: string;
  payment_request_id: string | null;
  invoice_id: string | null;
}

/**
 * What is still owed on the invoices of one approved request, read NOW rather than at approval.
 *
 * `FIN-03`. `payment_request_invoices.amount_allocated` is written when the request is created and
 * never recomputed, so a request approved in August can be sitting in this queue in September
 * against invoices that were paid in the meantime — which is exactly what the sweep measured: two
 * of two queued transfers targeted invoices whose balance was already zero, and the dialog showed
 * no balance at all.
 *
 * THREE ANSWERS, NOT TWO, and the middle one is the point. `invoice_balances_by_currency` returns
 * NO ROW for an invoice the reader's role may not value (`0218` — the accountant sees approved
 * invoices only). That is genuinely unknown, and this returns `null` for the whole request rather
 * than summing the invoices it happens to know: a partial sum printed as a balance is a claim
 * about money that was never measured. A measured `0` is the opposite claim — "these are settled"
 * — and it is reported as `0`, never as the em dash. Same rule as the balance column on
 * `/invoices` (`FIN-09`/`MON-09`), decided in one place instead of twice.
 *
 * Ids are de-duplicated because a request MAY carry two rows for one invoice — `buildPaymentAllocations`
 * above sums them on purpose — and counting one invoice's balance twice would understate what is
 * left. The arithmetic runs in minor units for the same reason the allocation split does: summing
 * `0.1 + 0.2` in floating point is how a settled invoice acquires a balance of 0.00000000000000004
 * and stops being reported as settled.
 *
 * `settled` is deliberately NOT a permission. Ruling #353 (04.09.2026) says the recording is always
 * accepted, because `/pay` documents a transfer that has already left the bank. This is information
 * the accountant reads before deciding, and nothing in this file turns it into a refusal.
 */
export function paymentRequestBalance(
  invoices: readonly { invoice_id: string }[],
  balances: Readonly<Record<string, number | undefined>>,
  minorUnits = 2,
): { total: number | null; settled: boolean } {
  const seen = new Set<string>();
  let minor = 0;
  for (const invoice of invoices) {
    if (seen.has(invoice.invoice_id)) continue;
    seen.add(invoice.invoice_id);
    const balance = balances[invoice.invoice_id];
    if (balance == null || !Number.isFinite(balance)) return { total: null, settled: false };
    minor += minorAmount(balance, minorUnits);
  }
  if (!seen.size) return { total: null, settled: false };
  return { total: majorAmount(minor, minorUnits), settled: minor <= 0 };
}

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
const allocationRefusal = (error: unknown, t: (key: TKey) => string) =>
  ALLOCATION_REFUSAL_MESSAGES[(error as Error | undefined)?.message ?? '']
  ?? t('payQueue.toast');

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
  minorUnits = 2,
): { allocations: PaymentAllocationPayload[]; cashAmount: number; creditAmount: number } {
  // One entry per invoice: the executor rejects two allocations naming the same invoice.
  const cashByInvoice = new Map<string, number>();
  for (const invoice of invoices) {
    cashByInvoice.set(
      invoice.invoice_id,
      (cashByInvoice.get(invoice.invoice_id) ?? 0) + minorAmount(invoice.amount_allocated, minorUnits),
    );
  }

  let creditTotal = 0;
  // The invoice each unlinked credit was pointed at, so the payload can carry to the executor the
  // same target this arithmetic used. A linked credit is absent from here on purpose: the server
  // already knows its invoice, and sending it again would be a second place to get it wrong.
  const chosenTargetByCredit = new Map<string, string>();
  for (const credit of credits) {
    const amount = minorAmount(credit.amount, minorUnits);
    if (amount <= 0) continue;
    if (amount > minorAmount(credit.remaining, minorUnits)) throw new Error('credit_allocation_exceeds_remaining');
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
    allocations.push({ invoice_id: invoiceId, credit_id: null, amount: majorAmount(cash, minorUnits) });
  }
  if (cashTotal < 1) throw new Error('payment_cash_amount_required');

  for (const credit of credits) {
    const amount = minorAmount(credit.amount, minorUnits);
    if (amount > 0) {
      const chosenTarget = chosenTargetByCredit.get(credit.credit_id);
      allocations.push({
        invoice_id: null,
        credit_id: credit.credit_id,
        amount: majorAmount(amount, minorUnits),
        // Present only for a credit that had no invoice: the executor writes the link from it,
        // once, in the same transaction. Spread so the key is absent — not `undefined` — on the
        // linked path, which keeps that payload byte-identical to what it has always sent.
        ...(chosenTarget ? { credit_invoice_id: chosenTarget } : {}),
      });
    }
  }
  return {
    allocations,
    cashAmount: majorAmount(cashTotal, minorUnits),
    creditAmount: majorAmount(creditTotal, minorUnits),
  };
}

/**
 * Focused execution view for the accountant persona.
 * Shows ONLY approved payment requests + the details needed to perform a transfer.
 */
type Row = Omit<PaymentRequest, 'supplier'> & {
  supplier: { id: string; name: string; bank_details: string | null };
  invoices: { invoice_id: string; amount_allocated: number; invoice: { invoice_number: string } | null }[];
  approver: { full_name: string } | null;
  minor_units: number;
  /**
   * The live balance of each invoice under this request. A MISSING key is "not measured" — the
   * balance view returns no row for an invoice the reader's role may not value — and is not the
   * same statement as a balance of zero. `paymentRequestBalance` is the one place that decides
   * what either means.
   */
  invoice_balances: Record<string, number | undefined>;
  /** Open exceptions the product already raised against this request or one of its invoices. */
  open_exceptions: QueueException[];
};
type RawRow = Omit<Row, 'supplier' | 'minor_units' | 'invoice_balances' | 'open_exceptions'>;

const QUEUED_STATUSES = ['approved', 'sent_for_execution'];
const RECORDED_STATUSES = ['executed', 'matched'];
/** `Exceptions.tsx` treats these two as "open" and so does the dashboard; one definition, not three. */
const OPEN_EXCEPTION_STATUSES = ['open', 'in_progress'];

/**
 * The live balance of every invoice sitting in the queue, keyed by invoice.
 *
 * Read for the QUEUED requests only. A recorded transfer's balance is a fact about the past and
 * nothing on this screen asks for it, so fetching it would be a larger `in (...)` list for no
 * reader.
 */
async function readQueueInvoiceBalances(invoiceIds: readonly string[]) {
  if (!invoiceIds.length) return {} as Record<string, number>;
  const rows = await fetchInChunks(invoiceIds, (chunk) => fetchAll<QueueInvoiceBalance>((from, to) =>
    supabase.from('invoice_balances_by_currency')
      .select('invoice_id, balance_in_currency')
      .in('invoice_id', chunk)
      .order('invoice_id')
      .range(from, to)));
  return Object.fromEntries(rows.map((row) => [row.invoice_id, Number(row.balance_in_currency)]));
}

/**
 * The open exceptions attached to what is in the queue.
 *
 * `FIN-03` measured the gap this closes: the product had ALREADY opened a high-severity
 * duplicate-payment exception against one of the two queued transfers, and the one screen whose
 * job is to execute those transfers said nothing about it.
 *
 * TWO READS RATHER THAN ONE `.or(...)`. The predicate is "this request, or any invoice under it",
 * and PostgREST expresses that as a hand-built `or=` string — which becomes a syntax error the
 * moment one of the two id lists is empty, on a money screen, at read time. Two `.in()` reads
 * cannot be malformed and are de-duplicated here, because an exception naming both the request and
 * its invoice legitimately matches both.
 */
async function readQueueExceptions(requestIds: readonly string[], invoiceIds: readonly string[]) {
  const columns = 'id, type, severity, title, payment_request_id, invoice_id';
  const byColumn = (column: 'payment_request_id' | 'invoice_id', ids: readonly string[]) =>
    fetchInChunks(ids, (chunk) => fetchAll<QueueException>((from, to) =>
      supabase.from('exceptions')
        .select(columns)
        .in('status', OPEN_EXCEPTION_STATUSES)
        .in(column, chunk)
        .order('id')
        .range(from, to)));
  const rows = (await Promise.all([
    requestIds.length ? byColumn('payment_request_id', requestIds) : Promise.resolve([]),
    invoiceIds.length ? byColumn('invoice_id', invoiceIds) : Promise.resolve([]),
  ])).flat();
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}

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
  const { t } = useT();
  const [selected, setSelected] = useState<Row | null>(null);

  const { data, loading, error, refetch } = useQuery(async () => {
    const rows = unwrap(await supabase.from('payment_requests')
      .select('*, invoices:payment_request_invoices(invoice_id, amount_allocated, invoice:invoices(invoice_number)), approver:profiles!p0_pr_approved_actor_tenant_fk(full_name)')
      .in('status', ['approved', 'sent_for_execution', 'executed', 'matched'])
      .order('due_date', { ascending: true, nullsFirst: false })) as RawRow[];
    const supplierIds = rows.map((row) => row.supplier_id);
    // What is still owed, and what the product already flagged, are read for the QUEUED rows —
    // those are the only ones this screen offers to act on.
    const queued = rows.filter((row) => QUEUED_STATUSES.includes(row.status));
    const queuedInvoiceIds = [...new Set(queued.flatMap((row) => row.invoices.map((i) => i.invoice_id)))];
    const queuedRequestIds = queued.map((row) => row.id);
    const [suppliers, bankAccounts, currencyRows, invoiceBalances, openExceptions] = await Promise.all([
      financialSupplierMap(supplierIds),
      financialSupplierBankAccountMap(supplierIds),
      rows.length
        ? supabase.from('currencies').select('code, minor_units')
          .in('code', [...new Set(rows.map((row) => row.currency))])
        : Promise.resolve({ data: [], error: null }),
      readQueueInvoiceBalances(queuedInvoiceIds),
      readQueueExceptions(queuedRequestIds, queuedInvoiceIds),
    ]);
    if (currencyRows.error) throw new Error(currencyRows.error.message);
    const minorUnits = new Map(((currencyRows.data ?? []) as { code: string; minor_units: number }[])
      .map((currency) => [currency.code, currency.minor_units]));
    return rows.map<Row>((row) => {
      const units = minorUnits.get(row.currency);
      if (units == null) throw new Error(`currency_minor_units_unavailable:${row.currency}`);
      const rowInvoiceIds = new Set(row.invoices.map((invoice) => invoice.invoice_id));
      return {
        ...row,
        supplier: {
          ...(suppliers.get(row.supplier_id) ?? {
            id: row.supplier_id, name: '—', tax_id: null, payment_terms: null, status: 'active', bank_details: null,
          }),
          bank_details: formatSupplierBankAccount(bankAccounts.get(row.supplier_id), t),
        },
        minor_units: units,
        // Only the invoices this request names, and only the ones the balance view actually
        // answered for. An invoice with no answer stays ABSENT rather than arriving as 0 — that
        // distinction is the whole of `FIN-09`/`MON-09` and it is decided once, here.
        invoice_balances: Object.fromEntries([...rowInvoiceIds]
          .filter((invoiceId) => invoiceBalances[invoiceId] !== undefined)
          .map((invoiceId) => [invoiceId, invoiceBalances[invoiceId]])),
        open_exceptions: openExceptions.filter((exception) =>
          exception.payment_request_id === row.id
          || (exception.invoice_id != null && rowInvoiceIds.has(exception.invoice_id))),
      };
    });
  });

  if (loading) return <SkeletonList />;
  if (error) return <ErrorNote message={error} />;

  const pending = (data ?? []).filter((r) => QUEUED_STATUSES.includes(r.status));
  const done = (data ?? []).filter((r) => RECORDED_STATUSES.includes(r.status));

  return (
    <div className="space-y-5 max-w-2xl">
      <PageHeader title={t('payQueue.title')}
        meta={t('payQueue.pendingMeta', { count: pending.length })} />

      {!pending.length ? (
        <Card pad={false}><EmptyState title={t('payQueue.title_2')} subtitle={t('payQueue.subtitle')} /></Card>
      ) : (
        <div className="space-y-3">
          {pending.map((r) => {
            const balance = paymentRequestBalance(r.invoices, r.invoice_balances, r.minor_units);
            return (
            <Card as="button" key={r.id} pad={false} className="card-link-hover w-full text-start p-4 sm:p-5" onClick={() => setSelected(r)}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="min-w-0 break-words font-semibold text-ink">{r.supplier.name}</span>
                <span className="kpi-value-compact num shrink-0">{fmtMoneyExact(r.amount, r.currency)}</span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-ink-muted">
                <StatusBadge meta={PAYMENT_REQUEST_STATUS[r.status]} />
                {r.due_date && <span>{t('payQueue.payBy')} {fmtDate(r.due_date)}</span>}
                <span>{t('payQueue.invoiceCount', { count: r.invoices.length })}</span>
              </div>
              {/* `FIN-03`: the accountant chooses which card to open from THIS list, so what the
                  invoices still owe — and whether the product has already raised a finding against
                  the request — belongs here and not only two clicks in. Neither mark closes the
                  card or removes the action; ruling #353 keeps the recording available. */}
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
                <span className="text-ink-muted">
                  {t('payQueue.invoiceBalanceLabel')}{' '}
                  <span className="num font-medium text-ink-body">{fmtMoneyExact(balance.total, r.currency)}</span>
                </span>
                {/* Two marks, two weights, on purpose. `alert` is reserved for the finding the
                    PRODUCT raised and a person still has to close; a settled invoice under a
                    queued transfer is something to look at before acting, which is what `await`
                    means everywhere else in this app. A queue where every card wears the same
                    solid red pill teaches the reader to stop seeing red. */}
                {balance.settled && <span className="badge-await">{t('payQueue.settledBadge')}</span>}
                {r.open_exceptions.length > 0 && <span className="badge-alert">{t('payQueue.openExceptionBadge')}</span>}
              </div>
              {r.open_credit_override_total != null && (
                <div className="mt-3 text-sm text-await-fg">
                  {t('payQueue.approvedWithoutOffsetBefore')}<span className="num font-semibold">{fmtMoneyExact(r.open_credit_override_total, r.currency)}</span>
                </div>
              )}
            </Card>
            );
          })}
        </div>
      )}

      {done.length > 0 && (
        <div>
          <h2 className="section-title mb-2 text-ink-muted">{t('payQueue.text')}</h2>
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
  const { errorText, statusLabel, t } = useT();
  const { profile } = useAuth();
  const toast = useToast();
  const [f, setF] = useState({
    paid_date: todayISO(), reference: '', notes: '', reason: '',
    settlement_currency: pr.currency, settlement_amount: '',
  });
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
  const { data: currencyOptions, loading: currenciesLoading, error: currenciesError } = useQuery(async () =>
    unwrap(await supabase.from('currencies').select('code, minor_units')
      .eq('active', true).order('code')) as { code: string; minor_units: number }[], []);
  const crossCurrencySettlement = f.settlement_currency !== pr.currency;
  const settlementMinorUnits = currencyOptions
    ?.find((currency) => currency.code === f.settlement_currency)?.minor_units;
  const settlementStep = settlementMinorUnits === 0 ? '1'
    : `0.${'0'.repeat(Math.max((settlementMinorUnits ?? 2) - 1, 0))}1`;

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
    allocationPreview = buildPaymentAllocations(pr.invoices, selectedCredits, pr.minor_units);
  } catch (error) {
    allocationPreview = null;
    allocationError = allocationRefusal(error, t);
  }

  // What the invoices under this request still owe, read now. Information only — see
  // `paymentRequestBalance` and ruling #353: nothing below turns either figure into a refusal.
  const liveBalance = paymentRequestBalance(pr.invoices, pr.invoice_balances, pr.minor_units);

  // Field validation first, then the step-up gate. Re-authentication happens only when the JWT's
  // password AMR entry is stale — the server (0061) asserts freshness itself, so a fresh session
  // sees no new modal and a stale one is prompted instead of rejected.
  function requestExecute() {
    if (!f.reference.trim()) { toast(t('payQueue.trim'), 'error'); return; }
    if (!allocationPreview) {
      toast(allocationError ?? t('payQueue.toast'), 'error');
      return;
    }
    if (currenciesLoading || currenciesError || settlementMinorUnits == null) {
      toast(currenciesError ?? t('payQueue.currenciesUnavailable'), 'error');
      return;
    }
    if (crossCurrencySettlement
        && (!Number.isFinite(Number(f.settlement_amount)) || Number(f.settlement_amount) <= 0)) {
      toast(t('payQueue.settlementAmountRequired'), 'error');
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
        p_method: t('payQueue.text_2'),
        p_reference: f.reference.trim(),
        p_notes: f.notes.trim() || null,
        p_allocations: allocationPreview?.allocations ?? [],
        p_settlement_amount: crossCurrencySettlement ? Number(f.settlement_amount) : null,
        p_settlement_currency: crossCurrencySettlement ? f.settlement_currency : null,
        p_reason: reasonOr(f.reason, 'ביצוע העברת תשלום'),
      })) as { payment_id: string };

      setPaymentId(payment.payment_id);
      toast(t('payQueue.toast_2'));
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (paymentId) {
    return (
      <Modal open onClose={onDone} title={t('payQueue.title_3')}>
        <div className="text-center mb-4">
          <CheckCircle2 size={ICON.hero} className="text-done-fg mx-auto mb-2" aria-hidden="true" />
          <p className="text-sm text-ink-soft">{t('payQueue.text_3')}</p>
        </div>
        <DocumentList entityType="payment" entityId={paymentId} capture />
        <div className="flex justify-end mt-4"><button className="btn-primary" onClick={onDone}>{t('payQueue.text_4')}</button></div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} title={t('payQueue.executeTitle', { supplier: pr.supplier.name })} busy={busy} statusMessage={busy ? t('payQueue.recordingTransfer') : undefined}>
      <div className="space-y-4">
        <SubPanel className="border border-line">
          <div className="flex items-center gap-2 text-sm font-medium text-ink-mid mb-1"><Landmark size={ICON.sm} aria-hidden="true" /> {t('payQueue.text_5')}</div>
          <div className="text-sm text-ink-body text-start" dir="ltr">{pr.supplier.bank_details ?? t('payQueue.text_6')}</div>
        </SubPanel>

        {/* `FIN-03`. The product had already raised a high-severity duplicate-payment finding
            against one of the two queued transfers and this screen never said so. Named rather
            than counted: "one open exception" tells the accountant nothing they can act on, and
            the row's own title is the sentence somebody wrote about THIS request. */}
        {pr.open_exceptions.length > 0 && (
          <Note tone="alert">
            <span className="min-w-0 flex-1">
              <strong>{t('payQueue.openExceptionHeading')}</strong>{' '}
              {t('payQueue.openExceptionBody')}
              <ul className="mt-1 space-y-1">
                {pr.open_exceptions.map((exception) => (
                  <li key={exception.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span>{statusLabel(EXCEPTION_TYPE[exception.type])} · {exception.title}</span>
                    <Link to={`/exceptions?id=${exception.id}`} className="underline">
                      {t('payQueue.openExceptionLink')}
                    </Link>
                  </li>
                ))}
              </ul>
            </span>
          </Note>
        )}

        {/* `FIN-03`, the settled case. A statement, not a gate: ruling #353 (04.09.2026) says a
            transfer that already left the bank is recorded whatever the balance now reads, so the
            primary below stays enabled and this says what the accountant needs to check first. */}
        {liveBalance.settled && (
          <Note tone="await">
            <span className="min-w-0 flex-1">
              <strong>{t('payQueue.settledHeading')}</strong>{' '}
              {t('payQueue.settledBody')}
            </span>
          </Note>
        )}

        {/* `FIN-10`/`MON-05`. This used to read "…ולכן לא ניתן לבצע את ההעברה" — a refusal, in the
            alert tone, directly above an enabled button that performs the recording, and the sweep
            performed it twice under exactly this block. The FACT is kept because it is true and
            somebody has to act on it; what is gone is the claim that it stops the recording. A
            missing bank account is a note about the NEXT transfer. */}
        {!pr.supplier.bank_details && (
          <Note tone="info">
            <span className="min-w-0 flex-1">
              {t('payQueue.text_7')}{' '}
              {t('payQueue.text_8')}
            </span>
          </Note>
        )}
        <p className="text-xs text-ink-muted">
          {t('payQueue.recordsOnlyBefore')}<b>{t('payQueue.text_9')}</b>{t('payQueue.recordsOnlyAfter')}
        </p>

        <dl className="text-sm space-y-1.5 [&>div]:flex-wrap [&>div]:gap-x-4 [&>div]:gap-y-0.5">
          {/* One transfer, one currency. The request, its invoices, the credits offset against
              them and the payment that results are all money of the same kind — settlement from
              an account in another currency is recorded on the payment (#286) and does not change
              any figure here. */}
          <div className="flex justify-between"><dt className="text-ink-muted">{t('payQueue.fmtMoneyExact')}</dt><dd className="font-semibold num">{fmtMoneyExact(pr.amount, pr.currency)}</dd></div>
          {/* `—`, never `0`: while the credits load, or while the selection is invalid, the offset
              is unknown — and an unknown offset printed as ₪0.00 is a claim that none was taken. */}
          <div className="flex justify-between"><dt className="text-ink-muted">{t('payQueue.fmtMoneyExact_2')}</dt><dd className="num">{fmtMoneyExact(allocationPreview?.creditAmount ?? null, pr.currency)}</dd></div>
          <div className="flex justify-between"><dt className="text-ink-muted">{t('payQueue.text_36')}</dt><dd className="font-semibold num">{fmtMoneyExact(allocationPreview?.cashAmount ?? null, pr.currency)}</dd></div>
          {/* `FIN-03`: the live balance, beside the amount about to be transferred, because the
              allocation above was frozen at approval and the invoice has been moving since. `—`
              here means the balance could not be READ (the accountant values approved invoices
              only, 0218) — never that it is zero. A measured zero prints as 0.00 and is the
              claim "these invoices are settled". */}
          <div className="flex justify-between"><dt className="text-ink-muted">{t('payQueue.invoiceBalanceLabel')}</dt><dd className="num">{fmtMoneyExact(liveBalance.total, pr.currency)}</dd></div>
          {pr.due_date && <div className="flex justify-between"><dt className="text-ink-muted">{t('payQueue.fmtDate')}</dt><dd>{fmtDate(pr.due_date)}</dd></div>}
          <div className="flex justify-between"><dt className="text-ink-muted">{t('payQueue.text_10')}</dt>
            <dd dir="ltr">{pr.invoices.map((i) => i.invoice?.invoice_number).filter(Boolean).join(', ') || t('payQueue.map')}</dd></div>
          <div className="flex justify-between"><dt className="text-ink-muted">{t('payQueue.text_12')}</dt><dd>{pr.approver?.full_name ?? t('payQueue.text_11')}</dd></div>
          <div className="flex justify-between"><dt className="text-ink-muted">{t('payQueue.text_14')}</dt><dd>{profile?.full_name ?? t('payQueue.text_13')}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-ink-muted">{t('payQueue.text_16')}</dt><dd className="text-start">{t('payQueue.text_15')}</dd></div>
          {pr.notes && <Note tone="await">{pr.notes}</Note>}
          {pr.open_credit_override_total != null && (
            <Note tone="alert">
              <span className="min-w-0 flex-1">
                <strong>{t('payQueue.text_17')}</strong>{' '}
                {t('payQueue.openCreditsBefore')}<span className="num">{fmtMoneyExact(pr.open_credit_override_total, pr.currency)}</span>{t('payQueue.openCreditsAfter')}
                <span className="block mt-1">{t('payQueue.overrideReasonLabel')} {pr.open_credit_override_reason}</span>
              </span>
            </Note>
          )}
        </dl>

        <SubPanel>
          <h3 className="text-sm font-medium text-ink-soft">{t('payQueue.text_18')}</h3>
          {creditsLoading && <p className="mt-2 text-sm text-ink-muted" role="status">{t('payQueue.text_19')}</p>}
          {creditsError && <p className="mt-2 text-sm text-alert-fg" role="alert">{creditsError}</p>}
          {!creditsLoading && !creditsError && openCredits.length === 0 && (
            <p className="mt-2 text-sm text-ink-muted">{t('payQueue.text_20')}</p>
          )}
          {!creditsLoading && !creditsError && openCredits.length > 0 && selectableCredits.length === 0 && (
            <p className="mt-2 text-sm text-ink-muted">
              {t('payQueue.text_21')}
            </p>
          )}

          {/* Said out loud rather than left as a shorter list: the accountant can see in the
              supplier card that this credit exists, so silence here would read as a bug. */}
          {otherCurrencyCredits.length > 0 && (
            <Note tone="info" className="mt-3">
              <span>
                <span className="num">{otherCurrencyCredits.length}</span>{t('payQueue.otherCurrencyCreditsAre', { currency: pr.currency })}
              </span>
            </Note>
          )}

          {/* Owner ruling, 23.08.2026: an unlinked credit may be offset against any invoice of the
              same supplier, and the link is recorded when the offset is made. The one thing the
              screen must not do is decide WHICH — that choice is what leaves one invoice short. */}
          {unlinkedCredits.length > 0 && (
            <Note tone="info" className="mt-3">
              <span>
                <span className="num">{unlinkedCredits.length}</span>{t('payQueue.unlinkedCreditsAre')}
                {t('payQueue.text_22')}{' '}
                {t('payQueue.text_23')}
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
                      <span>{t('payQueue.text_24')} <span className="num">#{credit.credit_number}</span></span>
                      {chosenTarget == null
                        ? <span className="badge-await">{t('payQueue.text_25')}</span>
                        : <span className="badge-done">{t('payQueue.text_26')}</span>}
                    </div>

                    {/* The linkage is the whole point of the selection — the accountant must see
                        WHICH invoice of this request the offset is taken off. */}
                    {credit.invoice_id != null ? (
                      <p className="mt-1 text-sm text-ink-muted">
                        {t('payQueue.text_27')}{' '}
                        <span className="font-medium text-ink-body" dir="ltr">
                          {invoiceNumberById.get(credit.invoice_id) ?? t('payQueue.get')}
                        </span>
                      </p>
                    ) : (
                      <>
                        <label className="label mt-2 block" htmlFor={`credit-target-${credit.credit_id}`}>
                          {t('payQueue.text_28')}
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
                          <option value="">{t('payQueue.text_29')}</option>
                          {/* Built from the deduplicated map, not from the raw rows: two options
                              carrying the same value is a picker whose selection cannot be read
                              back, and `buildPaymentAllocations` already sums repeated rows. */}
                          {[...invoiceAmountById].map(([invoiceId, amount]) => (
                            <option key={invoiceId} value={invoiceId}>
                              {bidiIsolate(invoiceNumberById.get(invoiceId) ?? t('payQueue.bidiIsolate'))}
                              {' · '}{fmtMoneyExact(amount, pr.currency)}
                            </option>
                          ))}
                        </select>
                        {/* Stated before the choice, not after it: the executor writes the link
                            once, so a partial offset today decides where the remainder may go. */}
                        <p id={targetHintId} className="mt-1 text-xs text-ink-muted">
                          {t('payQueue.text_30')}{' '}
                          {t('payQueue.text_31')}
                        </p>
                      </>
                    )}

                    <p className="mt-1 text-sm text-ink-muted">
                      {t('payQueue.availableBalance')} <span className="num font-medium text-ink-body">{fmtMoneyExact(credit.remaining_amount, credit.currency)}</span>
                      {targetAmount != null && (
                        <>{' · '}{t('payQueue.requestInvoiceAmount')} <span className="num">{fmtMoneyExact(targetAmount, pr.currency)}</span></>
                      )}
                    </p>

                    <label className="label mt-2 block" htmlFor={`credit-allocation-${credit.credit_id}`}>
                      {t('payQueue.text_32')}
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
                        {t('payQueue.text_33')}
                      </p>
                    )}
                    <p className="mt-1 text-xs text-ink-muted">
                      {t('payQueue.previouslyAllocated')} <span className="num">{fmtMoneyExact(credit.allocated_amount, credit.currency)}</span>
                      {' · '}{t('payQueue.originalAmount')} <span className="num">{fmtMoneyExact(credit.amount, credit.currency)}</span>
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
                  <span className="num">{otherRequestCredits.length}</span>{t('payQueue.otherRequestCreditsAre')}
                  {t('payQueue.text_34')}{' '}
                  {t('payQueue.text_35')}
                </span>
              </Note>
            </div>
          )}
        </SubPanel>

        <hr className="border-line-soft" />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div><label className="label" htmlFor="payment-execution-date">{t('payQueue.setF')}</label><input id="payment-execution-date" type="date" className="input" value={f.paid_date} onChange={(e) => setF((s) => ({ ...s, paid_date: e.target.value }))} /></div>
          <div><label className="label" htmlFor="payment-execution-amount">{t('payQueue.settledDebtAmount', { currency: pr.currency })}</label><input id="payment-execution-amount" type="number" className="input num" value={allocationPreview?.cashAmount ?? ''} readOnly /></div>
          <div>
            <label className="label" htmlFor="payment-settlement-currency">{t('payQueue.settlementCurrency')}</label>
            <select id="payment-settlement-currency" className="input num" dir="ltr"
              value={f.settlement_currency}
              onChange={(event) => setF((current) => ({
                ...current, settlement_currency: event.target.value, settlement_amount: '',
              }))}>
              {(currencyOptions ?? []).map((currency) => (
                <option key={currency.code} value={currency.code}>{currency.code}</option>
              ))}
            </select>
          </div>
          {crossCurrencySettlement && (
            <div>
              <label className="label" htmlFor="payment-settlement-amount">
                {t('payQueue.settlementAmount', { currency: f.settlement_currency })}
              </label>
              <input id="payment-settlement-amount" type="number" min="0" step={settlementStep}
                className="input num" value={f.settlement_amount}
                onChange={(event) => setF((current) => ({ ...current, settlement_amount: event.target.value }))} />
              <p className="mt-1 text-xs text-ink-muted">
                {t('payQueue.settlementRateNote')}
              </p>
            </div>
          )}
        </div>
        <div><label className="label" htmlFor="payment-execution-reference">{t('payQueue.setF_2')}</label><input id="payment-execution-reference" className="input num" dir="ltr" value={f.reference} onChange={(e) => setF((s) => ({ ...s, reference: e.target.value }))} /></div>
        <div><label className="label" htmlFor="payment-execution-notes">{t('payQueue.setF_3')}</label><input id="payment-execution-notes" className="input" value={f.notes} onChange={(e) => setF((s) => ({ ...s, notes: e.target.value }))} /></div>
        <div><label className="label" htmlFor="payment-execution-reason">{t('payQueue.setF_4')}</label><input id="payment-execution-reason" className="input" value={f.reason} onChange={(e) => setF((s) => ({ ...s, reason: e.target.value }))} /></div>

        {/* The button below is disabled while the split cannot be computed; the reason is stated
            here instead of leaving the accountant to guess which figure is wrong, and the button
            POINTS at it — a disabled control whose explanation is only nearby on screen is not an
            explanation to anyone reading the page through a screen reader. */}
        {allocationError && (
          <p id={ALLOCATION_ERROR_ID} className="text-sm text-alert-fg" role="alert">{allocationError}</p>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <button className="btn-secondary" disabled={busy} onClick={onClose}>{t('payQueue.text_37')}</button>
          <button
            className="btn-primary"
            disabled={busy || !allocationPreview}
            // Only while the paragraph exists: a dangling aria-describedby is its own defect.
            aria-describedby={allocationError ? ALLOCATION_ERROR_ID : undefined}
            onClick={requestExecute}
          >
            {busy ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" /> : <CheckCircle2 size={ICON.sm} aria-hidden="true" />} {t('payQueue.transferMade')}
          </button>
        </div>
      </div>

      <ReauthModal
        open={reauthOpen}
        title={t('payQueue.title_4')}
        onConfirm={() => { setReauthOpen(false); void execute(); }}
        onCancel={() => setReauthOpen(false)}
      />
    </Modal>
  );
}
