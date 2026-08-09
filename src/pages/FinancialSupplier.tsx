import { Link, useParams } from 'react-router';
import { ArrowRight, Banknote, ReceiptText } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { fetchAll } from '../lib/supabasePaging';
import { useQuery, unwrap } from '../lib/useQuery';
import { fmtDate, fmtMoney, todayISO } from '../lib/format';
import { BANK_TX_STATUS, CREDIT_STATUS, INVOICE_PAYMENT_STATUS, PAYMENT_REQUEST_STATUS, SUPPLIER_STATUS } from '../lib/status';
import { EmptyState, ErrorNote, Note, PageLoader, StatusBadge } from '../components/ui';

type SupplierFinance = { id: string; name: string; tax_id: string | null; payment_terms: string | null; status: string };
type InvoiceRow = { id: string; invoice_number: string; invoice_date: string; total_amount: number; payment_status: string };
type BalanceRow = { invoice_id: string; balance: number; paid_amount: number; credited_amount: number };
type CreditRow = { id: string; number: number; amount: number; status: string; created_at: string };
type PaymentRow = { id: string; number: number; amount: number; paid_date: string; method: string | null; reference: string | null };
type RequestRow = { id: string; number: number; amount: number; due_date: string | null; status: string };
type AllocationRow = { payment_id: string; amount: number };
type BankRow = { id: string; tx_date: string; amount: number; status: string };

export function financialDueExposure(requests: RequestRow[], today: string): number | null {
  const open = requests.filter((request) => ['approved', 'sent_for_execution'].includes(request.status));
  if (open.length === 0) return 0;
  if (open.some((request) => request.due_date === null)) return null;
  return open.filter((request) => request.due_date! <= today)
    .reduce((sum, request) => sum + request.amount, 0);
}

export default function FinancialSupplier() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, error } = useQuery(async () => {
    const supplier = unwrap(await supabase.rpc('read_financial_supplier', { p_supplier_id: id! })
      .maybeSingle()) as SupplierFinance | null;
    if (!supplier) throw new Error('supplier_not_found');

    const [invoices, credits, payments, requests, supplierBalance, bank] = await Promise.all([
      fetchAll<InvoiceRow>((from, to) => supabase.from('invoices')
        .select('id, invoice_number, invoice_date, total_amount, payment_status')
        .eq('supplier_id', supplier.id).is('deleted_at', null).order('invoice_date', { ascending: false }).order('id').range(from, to)),
      fetchAll<CreditRow>((from, to) => supabase.from('credit_requests')
        .select('id, number, amount, status, created_at').eq('supplier_id', supplier.id)
        .order('created_at', { ascending: false }).order('id').range(from, to)),
      fetchAll<PaymentRow>((from, to) => supabase.from('payments')
        .select('id, number, amount, paid_date, method, reference').eq('supplier_id', supplier.id)
        .order('paid_date', { ascending: false }).order('id').range(from, to)),
      fetchAll<RequestRow>((from, to) => supabase.from('payment_requests')
        .select('id, number, amount, due_date, status').eq('supplier_id', supplier.id)
        .in('status', ['approved', 'sent_for_execution', 'executed', 'matched'])
        .order('due_date', { ascending: true, nullsFirst: false }).order('id').range(from, to)),
      supabase.from('supplier_balances').select('open_balance').eq('supplier_id', supplier.id).maybeSingle(),
      fetchAll<BankRow>((from, to) => supabase.from('bank_transactions')
        .select('id, tx_date, amount, status').eq('supplier_id', supplier.id)
        .order('tx_date', { ascending: false }).order('id').range(from, to)),
    ]);
    if (supplierBalance.error) throw supplierBalance.error;

    const invoiceIds = invoices.map((invoice) => invoice.id);
    const paymentIds = payments.map((payment) => payment.id);
    const [balances, allocations] = await Promise.all([
      invoiceIds.length ? fetchAll<BalanceRow>((from, to) => supabase.from('invoice_balances')
        .select('invoice_id, balance, paid_amount, credited_amount').in('invoice_id', invoiceIds)
        .order('invoice_id').range(from, to)) : Promise.resolve([]),
      paymentIds.length ? fetchAll<AllocationRow>((from, to) => supabase.from('payment_allocations')
        .select('payment_id, amount').in('payment_id', paymentIds).order('id').range(from, to)) : Promise.resolve([]),
    ]);

    const balanceByInvoice = new Map(balances.map((row) => [row.invoice_id, row]));
    const today = todayISO();
    const dueExposure = financialDueExposure(requests, today);
    const openBalance = (supplierBalance.data as { open_balance: number } | null)?.open_balance ?? null;
    const allocatedByPayment = new Map<string, number>();
    for (const allocation of allocations) {
      allocatedByPayment.set(allocation.payment_id, (allocatedByPayment.get(allocation.payment_id) ?? 0) + allocation.amount);
    }

    const activity = [
      ...invoices.map((row) => ({ date: row.invoice_date, label: `חשבונית ${row.invoice_number}`, amount: row.total_amount })),
      ...payments.map((row) => ({ date: row.paid_date, label: `תשלום #${row.number}`, amount: -row.amount })),
      ...credits.filter((row) => ['offset', 'closed'].includes(row.status))
        .map((row) => ({ date: row.created_at, label: `זיכוי #${row.number}`, amount: -row.amount })),
    ].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10);

    return { supplier, invoices, credits, payments, requests, bank, balanceByInvoice, allocatedByPayment, openBalance, dueExposure, activity };
  }, [id]);

  if (loading) return <PageLoader />;
  if (error || !data) return <ErrorNote message={error ?? 'הספק לא נמצא'} />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link className="link inline-flex items-center gap-1 text-sm" to="/dashboard"><ArrowRight size={14} /> מרכז הבקרה</Link>
          <h1 className="page-title mt-2">כרטיס ספק פיננסי — {data.supplier.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink-muted">
            <StatusBadge meta={SUPPLIER_STATUS[data.supplier.status]} />
            <span>עוסק / חברה: <span className="num">{data.supplier.tax_id ?? '—'}</span></span>
            <span>תנאי תשלום: {data.supplier.payment_terms ?? '—'}</span>
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="card card-pad"><div className="text-sm text-ink-muted">יתרה פתוחה</div><div className="mt-1 text-2xl font-bold num">{fmtMoney(data.openBalance)}</div></div>
        <div className="card card-pad"><div className="text-sm text-ink-muted">חשיפה שהגיעה למועד</div><div className="mt-1 text-2xl font-bold num">{fmtMoney(data.dueExposure)}</div></div>
        <div className="card card-pad"><div className="text-sm text-ink-muted">תנועות בנק לא מותאמות</div><div className="mt-1 text-2xl font-bold num">{data.bank.filter((row) => ['unmatched', 'suggested'].includes(row.status)).length}</div></div>
      </div>

      {data.dueExposure === null && <Note tone="info">אין במערכת מועדי פירעון שמאפשרים לחשב חשיפה שהגיעה למועד; לכן מוצג — ולא אפס.</Note>}

      <section className="card card-pad" aria-labelledby="finance-invoices">
        <h2 id="finance-invoices" className="section-title flex items-center gap-2"><ReceiptText size={18} /> חשבוניות זמינות לתפקיד</h2>
        {!data.invoices.length ? <EmptyState title="אין חשבוניות זמינות לספק" /> : (
          <div className="mt-3 divide-y divide-line">
            {data.invoices.map((invoice) => {
              const balance = data.balanceByInvoice.get(invoice.id);
              return <Link key={invoice.id} to={`/invoices/${invoice.id}`} className="flex min-h-12 items-center justify-between gap-3 py-2">
                <span><span className="font-medium">{invoice.invoice_number}</span><span className="block text-xs text-ink-muted num">{fmtDate(invoice.invoice_date)}</span></span>
                <span className="text-end"><StatusBadge meta={INVOICE_PAYMENT_STATUS[invoice.payment_status]} /><span className="ms-2 num">{fmtMoney(balance?.balance ?? null)}</span></span>
              </Link>;
            })}
          </div>
        )}
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="card card-pad" aria-labelledby="finance-payments">
          <h2 id="finance-payments" className="section-title flex items-center gap-2"><Banknote size={18} /> תשלומים והקצאות</h2>
          {!data.payments.length ? <EmptyState title="אין תשלומים לספק" /> : <div className="mt-3 divide-y divide-line">
            {data.payments.map((payment) => <div key={payment.id} className="flex min-h-12 items-center justify-between gap-3 py-2 text-sm">
              <span>תשלום <span className="num">#{payment.number}</span><span className="block text-xs text-ink-muted num">{fmtDate(payment.paid_date)} · {payment.method ?? '—'}</span></span>
              <span className="text-end num">{fmtMoney(payment.amount)}<span className="block text-xs text-ink-muted">הוקצה: {fmtMoney(data.allocatedByPayment.get(payment.id) ?? 0)}</span></span>
            </div>)}
          </div>}
        </section>

        <section className="card card-pad" aria-labelledby="finance-credits">
          <h2 id="finance-credits" className="section-title">זיכויים</h2>
          {!data.credits.length ? <EmptyState title="אין זיכויים לספק" /> : <div className="mt-3 divide-y divide-line">
            {data.credits.map((credit) => <div key={credit.id} className="flex min-h-12 items-center justify-between gap-3 py-2 text-sm">
              <span>זיכוי <span className="num">#{credit.number}</span><span className="block text-xs text-ink-muted num">{fmtDate(credit.created_at)}</span></span>
              <span className="text-end"><StatusBadge meta={CREDIT_STATUS[credit.status]} /><span className="ms-2 num">{fmtMoney(credit.amount)}</span></span>
            </div>)}
          </div>}
        </section>
      </div>

      <section className="card card-pad" aria-labelledby="finance-requests">
        <h2 id="finance-requests" className="section-title">דרישות תשלום</h2>
        {!data.requests.length ? <EmptyState title="אין דרישות תשלום מאושרות לספק" /> : <div className="mt-3 divide-y divide-line">
          {data.requests.map((request) => <div key={request.id} className="flex min-h-12 items-center justify-between gap-3 py-2 text-sm">
            <span>דרישה <span className="num">#{request.number}</span><span className="block text-xs text-ink-muted">מועד: <span className="num">{fmtDate(request.due_date)}</span></span></span>
            <span className="text-end"><StatusBadge meta={PAYMENT_REQUEST_STATUS[request.status]} /><span className="ms-2 num">{fmtMoney(request.amount)}</span></span>
          </div>)}
        </div>}
      </section>

      <section className="card card-pad" aria-labelledby="finance-bank">
        <div className="flex items-center justify-between gap-3">
          <h2 id="finance-bank" className="section-title">התאמת בנק</h2>
          <Link className="link text-sm" to="/bank">למסך ההתאמות</Link>
        </div>
        {!data.bank.length ? <EmptyState title="אין תנועות בנק לספק" /> : <div className="mt-3 divide-y divide-line">
          {data.bank.slice(0, 10).map((row) => <Link key={row.id} to={`/bank?id=${row.id}`} className="flex min-h-12 items-center justify-between gap-3 py-2 text-sm">
            <span>תנועה מיום <span className="num">{fmtDate(row.tx_date)}</span></span>
            <span className="text-end"><StatusBadge meta={BANK_TX_STATUS[row.status]} /><span className="ms-2 num">{fmtMoney(row.amount)}</span></span>
          </Link>)}
        </div>}
      </section>

      <section className="card card-pad" aria-labelledby="finance-activity">
        <h2 id="finance-activity" className="section-title">פעילות פיננסית אחרונה</h2>
        {!data.activity.length ? <EmptyState title="אין פעילות פיננסית להצגה" /> : <div className="mt-3 divide-y divide-line">
          {data.activity.map((row, index) => <div key={`${row.label}-${row.date}-${index}`} className="flex min-h-11 items-center justify-between gap-3 py-2 text-sm">
            <span>{row.label}<span className="block text-xs text-ink-muted num">{fmtDate(row.date)}</span></span>
            <span className="num">{fmtMoney(row.amount)}</span>
          </div>)}
        </div>}
      </section>
    </div>
  );
}
