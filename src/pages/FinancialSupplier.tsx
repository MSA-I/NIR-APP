import { useT } from '../lib/i18n/LocaleProvider';
import { Link, useParams } from 'react-router';
import { Banknote, ReceiptText } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { fetchAll } from '../lib/supabasePaging';
import { useQuery, unwrap } from '../lib/useQuery';
import { fmtDate, fmtMoneyRounded, todayISO } from '../lib/format';
import { BANK_TX_STATUS, CREDIT_STATUS, INVOICE_PAYMENT_STATUS, PAYMENT_REQUEST_STATUS, SUPPLIER_STATUS } from '../lib/status';
import { Breadcrumbs, Card, EmptyState, ErrorNote, Note, RecordHeader, RecordSkeleton, StatusBadge, ICON } from '../components/ui';
import { MoneyByCurrency, totalsByCurrency } from '../components/Money';
import { useAuth } from '../auth/AuthContext';
import type { MoneyAmount } from '../lib/types';

type SupplierFinance = { id: string; name: string; tax_id: string | null; payment_terms: string | null; status: string };
type InvoiceRow = { id: string; invoice_number: string; invoice_date: string; total_amount: number; currency: string; payment_status: string };
type BalanceRow = { invoice_id: string; currency: string; balance_in_currency: number; paid_amount: number; credited_amount: number };
type CreditRow = { id: string; number: number; amount: number; currency: string; status: string; created_at: string };
type PaymentRow = { id: string; number: number; amount: number; currency: string; paid_date: string; method: string | null; reference: string | null };
type RequestRow = { id: string; number: number; amount: number; currency: string; due_date: string | null; status: string };
type AllocationRow = { payment_id: string; amount: number; currency: string };
type BankRow = { id: string; tx_date: string; amount: number; currency: string; status: string };

/**
 * What has already come due, ONE FIGURE PER CURRENCY (0217, #277). `null` keeps its old meaning
 * exactly — no dated request exists, so the exposure is unknown rather than zero — and a supplier
 * with dated requests in two currencies gets two figures, never their sum.
 */
export function financialDueExposure(requests: RequestRow[], today: string): MoneyAmount[] | null {
  const dated = requests.filter((request) =>
    ['approved', 'sent_for_execution'].includes(request.status) && request.due_date !== null);
  if (dated.length === 0) return null;
  return totalsByCurrency(dated.filter((request) => request.due_date! <= today)
    .map((request) => ({ currency: request.currency, amount: request.amount })));
}

export function financialBankStatusCounts(rows: BankRow[]) {
  return {
    unmatched: rows.filter((row) => row.status === 'unmatched').length,
    suggested: rows.filter((row) => row.status === 'suggested').length,
  };
}

export default function FinancialSupplier() {
  const { t } = useT();
  const { id } = useParams<{ id: string }>();
  const { org } = useAuth();
  const { data, loading, error } = useQuery(async () => {
    const supplier = unwrap(await supabase.rpc('read_financial_supplier', { p_supplier_id: id! })
      .maybeSingle()) as SupplierFinance | null;
    if (!supplier) throw new Error('supplier_not_found');

    const [invoices, credits, payments, requests, supplierBalance, bank] = await Promise.all([
      fetchAll<InvoiceRow>((from, to) => supabase.from('invoices')
        .select('id, invoice_number, invoice_date, total_amount, currency, payment_status')
        .eq('supplier_id', supplier.id).eq('financial_role', 'payable').is('deleted_at', null).order('invoice_date', { ascending: false }).order('id').range(from, to)),
      fetchAll<CreditRow>((from, to) => supabase.from('credit_requests')
        .select('id, number, amount, currency, status, created_at').eq('supplier_id', supplier.id)
        .order('created_at', { ascending: false }).order('id').range(from, to)),
      fetchAll<PaymentRow>((from, to) => supabase.from('payments')
        .select('id, number, amount, currency, paid_date, method, reference').eq('supplier_id', supplier.id)
        .order('paid_date', { ascending: false }).order('id').range(from, to)),
      fetchAll<RequestRow>((from, to) => supabase.from('payment_requests')
        .select('id, number, amount, currency, due_date, status').eq('supplier_id', supplier.id)
        .in('status', ['approved', 'sent_for_execution', 'executed', 'matched'])
        .order('due_date', { ascending: true, nullsFirst: false }).order('id').range(from, to)),
      supabase.from('supplier_balances_by_currency').select('currency, open_balance_in_currency').eq('supplier_id', supplier.id),
      fetchAll<BankRow>((from, to) => supabase.from('bank_transactions')
        .select('id, tx_date, amount, currency, status').eq('supplier_id', supplier.id)
        .order('tx_date', { ascending: false }).order('id').range(from, to)),
    ]);
    if (supplierBalance.error) throw supplierBalance.error;

    const invoiceIds = invoices.map((invoice) => invoice.id);
    const paymentIds = payments.map((payment) => payment.id);
    const [balances, allocations] = await Promise.all([
      invoiceIds.length ? fetchAll<BalanceRow>((from, to) => supabase.from('invoice_balances_by_currency')
        .select('invoice_id, currency, balance_in_currency, paid_amount, credited_amount').in('invoice_id', invoiceIds)
        .order('invoice_id').range(from, to)) : Promise.resolve([]),
      paymentIds.length ? fetchAll<AllocationRow>((from, to) => supabase.from('payment_allocations')
        .select('payment_id, amount, currency').in('payment_id', paymentIds).order('id').range(from, to)) : Promise.resolve([]),
    ]);

    const balanceByInvoice = new Map(balances.map((row) => [row.invoice_id, row]));
    const today = todayISO();
    const dueExposure = financialDueExposure(requests, today);
    const bankStatusCounts = financialBankStatusCounts(bank);
    /* One entry per currency (#277): this supplier's shekel debt and their dollar debt are two
       debts, and this is the accountant's own card — the last screen that may fold them together. */
    const openBalances = supplierBalance.data
      ? (supplierBalance.data as { currency: string; open_balance_in_currency: number }[])
        .map((row) => ({ currency: row.currency, amount: row.open_balance_in_currency }))
      : null;
    const allocatedByPayment = new Map<string, number>();
    for (const allocation of allocations) {
      allocatedByPayment.set(allocation.payment_id, (allocatedByPayment.get(allocation.payment_id) ?? 0) + allocation.amount);
    }

    // A feed, not a total: each line keeps its own currency and nothing here adds two of them.
    const activity = [
      ...invoices.map((row) => ({ date: row.invoice_date, label: `חשבונית ${row.invoice_number}`, amount: row.total_amount, currency: row.currency })),
      ...payments.map((row) => ({ date: row.paid_date, label: `תשלום #${row.number}`, amount: -row.amount, currency: row.currency })),
      ...credits.filter((row) => ['offset', 'closed'].includes(row.status))
        .map((row) => ({ date: row.created_at, label: `זיכוי #${row.number}`, amount: -row.amount, currency: row.currency })),
    ].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10);

    return { supplier, invoices, credits, payments, requests, bank, balanceByInvoice, allocatedByPayment, openBalances, dueExposure, bankStatusCounts, activity };
  }, [id]);

  if (loading) return <RecordSkeleton />;
  if (error || !data) return <ErrorNote message={error ?? t('financialSupplier.text')} />;

  return (
    <div className="space-y-5">
      <RecordHeader
        breadcrumbs={<Breadcrumbs items={[{ label: t('financialSupplier.dashboardCrumb'), to: '/dashboard' }, { label: t('financialSupplier.recordTitle', { supplier: data.supplier.name }) }]} />}
        title={t('financialSupplier.recordTitle', { supplier: data.supplier.name })}
        status={<StatusBadge meta={SUPPLIER_STATUS[data.supplier.status]} />}
        meta={(
          <>
            <span>{t('financialSupplier.text_2')} <span className="num">{data.supplier.tax_id ?? '—'}</span></span>
            <span>{t('financialSupplier.paymentTermsLabel')} {data.supplier.payment_terms ?? '—'}</span>
          </>
        )} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card><div className="text-sm text-ink-muted">יתרה פתוחה</div><div className="mt-1 kpi-value"><MoneyByCurrency amounts={data.openBalances} baseCurrency={org?.base_currency} shape="rounded" /></div></Card>
        <Card><div className="text-sm text-ink-muted">חשיפה שהגיעה למועד</div><div className="mt-1 kpi-value"><MoneyByCurrency amounts={data.dueExposure} baseCurrency={org?.base_currency} shape="rounded" /></div></Card>
        <Card><div className="text-sm text-ink-muted">{t('financialSupplier.text_3')}</div><div className="mt-1 kpi-value num">{data.bankStatusCounts.unmatched}</div></Card>
        <Card><div className="text-sm text-ink-muted">{t('financialSupplier.text_4')}</div><div className="mt-1 kpi-value num">{data.bankStatusCounts.suggested}</div></Card>
      </div>

      {data.dueExposure == null && <Note tone="info">אין במערכת מועדי פירעון שמאפשרים לחשב חשיפה שהגיעה למועד; לכן מוצג — ולא אפס.</Note>}

      <Card as="section" aria-labelledby="finance-invoices">
        <h2 id="finance-invoices" className="section-title flex items-center gap-2"><ReceiptText size={ICON.md} aria-hidden="true" /> {t('financialSupplier.text_6')}</h2>
        {!data.invoices.length ? <EmptyState title={t('financialSupplier.title')} /> : (
          <div className="mt-3 divide-y divide-line">
            {data.invoices.map((invoice) => {
              const balance = data.balanceByInvoice.get(invoice.id);
              return <Link key={invoice.id} to={`/invoices/${invoice.id}`} className="flex min-h-12 items-center justify-between gap-3 py-2">
                <span><span className="font-medium">{invoice.invoice_number}</span><span className="block text-xs text-ink-muted num">{fmtDate(invoice.invoice_date)}</span></span>
                <span className="text-end"><StatusBadge meta={INVOICE_PAYMENT_STATUS[invoice.payment_status]} /><span className="ms-2 num">{fmtMoneyRounded(balance?.balance_in_currency ?? null, invoice.currency)}</span></span>
              </Link>;
            })}
          </div>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card as="section" aria-labelledby="finance-payments">
          <h2 id="finance-payments" className="section-title flex items-center gap-2"><Banknote size={ICON.md} aria-hidden="true" /> {t('financialSupplier.text_7')}</h2>
          {!data.payments.length ? <EmptyState title={t('financialSupplier.title_2')} /> : <div className="mt-3 divide-y divide-line">
            {data.payments.map((payment) => <div key={payment.id} className="flex min-h-12 items-center justify-between gap-3 py-2 text-sm">
              <span>{t('financialSupplier.fmtDate')} <span className="num">#{payment.number}</span><span className="block text-xs text-ink-muted num">{fmtDate(payment.paid_date)} · {payment.method ?? '—'}</span></span>
              <span className="text-end num">{fmtMoneyRounded(payment.amount, payment.currency)}<span className="block text-xs text-ink-muted">{t('financialSupplier.allocatedLabel')} {fmtMoneyRounded(data.allocatedByPayment.get(payment.id) ?? 0, payment.currency)}</span></span>
            </div>)}
          </div>}
        </Card>

        <Card as="section" aria-labelledby="finance-credits">
          <h2 id="finance-credits" className="section-title">{t('financialSupplier.text_8')}</h2>
          {!data.credits.length ? <EmptyState title={t('financialSupplier.title_3')} /> : <div className="mt-3 divide-y divide-line">
            {data.credits.map((credit) => <div key={credit.id} className="flex min-h-12 items-center justify-between gap-3 py-2 text-sm">
              <span>{t('financialSupplier.fmtDate_2')} <span className="num">#{credit.number}</span><span className="block text-xs text-ink-muted num">{fmtDate(credit.created_at)}</span></span>
              <span className="text-end"><StatusBadge meta={CREDIT_STATUS[credit.status]} /><span className="ms-2 num">{fmtMoneyRounded(credit.amount, credit.currency)}</span></span>
            </div>)}
          </div>}
        </Card>
      </div>

      <Card as="section" aria-labelledby="finance-requests">
        <h2 id="finance-requests" className="section-title">{t('financialSupplier.text_9')}</h2>
        {!data.requests.length ? <EmptyState title={t('financialSupplier.title_4')} /> : <div className="mt-3 divide-y divide-line">
          {data.requests.map((request) => <div key={request.id} className="flex min-h-12 items-center justify-between gap-3 py-2 text-sm">
            <span>{t('financialSupplier.fmtDate_3')} <span className="num">#{request.number}</span><span className="block text-xs text-ink-muted">{t('financialSupplier.fmtDate_4')} <span className="num">{fmtDate(request.due_date)}</span></span></span>
            <span className="text-end"><StatusBadge meta={PAYMENT_REQUEST_STATUS[request.status]} /><span className="ms-2 num">{fmtMoneyRounded(request.amount, request.currency)}</span></span>
          </div>)}
        </div>}
      </Card>

      <Card as="section" aria-labelledby="finance-bank">
        <div className="flex items-center justify-between gap-3">
          <h2 id="finance-bank" className="section-title">{t('financialSupplier.text_10')}</h2>
          <Link className="link text-sm" to="/bank">{t('financialSupplier.text_11')}</Link>
        </div>
        {!data.bank.length ? <EmptyState title={t('financialSupplier.title_5')} /> : <div className="mt-3 divide-y divide-line">
          {data.bank.slice(0, 10).map((row) => <Link key={row.id} to={`/bank?id=${row.id}`} className="flex min-h-12 items-center justify-between gap-3 py-2 text-sm">
            <span>{t('financialSupplier.fmtDate_5')} <span className="num">{fmtDate(row.tx_date)}</span></span>
            <span className="text-end"><StatusBadge meta={BANK_TX_STATUS[row.status]} /><span className="ms-2 num">{fmtMoneyRounded(row.amount, row.currency)}</span></span>
          </Link>)}
        </div>}
      </Card>

      <Card as="section" aria-labelledby="finance-activity">
        <h2 id="finance-activity" className="section-title">{t('financialSupplier.text_12')}</h2>
        {!data.activity.length ? <EmptyState title={t('financialSupplier.title_6')} /> : <div className="mt-3 divide-y divide-line">
          {data.activity.map((row, index) => <div key={`${row.label}-${row.date}-${index}`} className="flex min-h-11 items-center justify-between gap-3 py-2 text-sm">
            <span>{row.label}<span className="block text-xs text-ink-muted num">{fmtDate(row.date)}</span></span>
            <span className="num">{fmtMoneyRounded(row.amount, row.currency)}</span>
          </div>)}
        </div>}
      </Card>
    </div>
  );
}
