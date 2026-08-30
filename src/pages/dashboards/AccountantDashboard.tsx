import { useT } from '../../lib/i18n/LocaleProvider';
import { Link } from 'react-router';
import { Banknote, ReceiptText } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useQuery } from '../../lib/useQuery';
import { fetchAll } from '../../lib/supabasePaging';
import { AttentionZone, SkeletonCards, ErrorNote, ICON, type AttentionItem } from '../../components/ui';
import { Scorecard, type ScoreItem } from '../../components/supplier-metrics';
import { CategoryDonut, GroupedBarChart, SpendBarChart, money, type LinePoint } from '../../components/charts';
import { comparisonSeries } from '../../lib/theme';
import { topCategoriesWithOther } from '../../lib/dashboardSeries';
import { fmtMonth, fmtMoneyRounded, fmtNum, monthlyBuckets, shiftCalendarMonth, todayISO, weeklyBuckets } from '../../lib/format';
import { DashboardFrame, ChartCard } from './parts';
import { readFinancialSuppliers } from '../../lib/financialSuppliers';

type Payment = { amount: number; paid_date: string };
type Bank = { status: string; tx_date: string; amount: number; is_debit: boolean };
type Credit = { amount: number; status: string };
type Invoice = { review_status: string; export_status: string };
type SupBal = { supplier_id: string; open_balance: number };

/**
 * Accountant control room (finance execution). RLS-scoped to finance the accountant may read:
 * payments, bank transactions, credit requests, approved invoices, and the balance views. No catalog,
 * prices, purchase orders or supplier_metrics (RLS returns nothing there). Empty → "—"/empty-state.
 */
export default function AccountantDashboard() {
  const { t } = useT();
  const { data, loading, error } = useQuery(async () => {
    const today = todayISO();
    const monthKey = today.slice(0, 7);
    const chartsFrom = `${shiftCalendarMonth(monthKey, -3)}-01`;

    const [paymentsRes, bankRes, creditsRes, invoicesRes, invBalRes, supBalRes, suppliersRes] = await Promise.all([
      fetchAll((from, to) => supabase.from('payments').select('amount, paid_date').gte('paid_date', chartsFrom).lte('paid_date', today).order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('bank_transactions').select('status, tx_date, amount, is_debit').order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('credit_requests').select('amount, status').order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('invoices').select('review_status, export_status').eq('financial_role', 'payable').is('deleted_at', null).order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('invoice_balances').select('balance').order('invoice_id').range(from, to)),
      fetchAll((from, to) => supabase.from('supplier_balances').select('supplier_id, open_balance').gt('open_balance', 0).order('supplier_id').range(from, to)),
      readFinancialSuppliers(),
    ]);

    const payments = paymentsRes as unknown as Payment[];
    const bank = bankRes as unknown as Bank[];
    const credits = creditsRes as unknown as Credit[];
    const invoices = invoicesRes as unknown as Invoice[];
    const invBal = invBalRes as unknown as { balance: number }[];
    const supBal = supBalRes as unknown as SupBal[];
    const suppliers = new Map((suppliersRes as unknown as { id: string; name: string }[]).map((s) => [s.id, s.name]));

    // ── KPIs
    const paymentsThisMonth = payments.filter((p) => p.paid_date.slice(0, 7) === monthKey);
    const paidMonth = paymentsThisMonth.length ? paymentsThisMonth.reduce((s, p) => s + p.amount, 0) : null;
    const openInvoiceBalance = invBal.length ? invBal.reduce((s, b) => s + Math.max(0, b.balance), 0) : null;
    const unmatchedBank = bank.filter((b) => b.status === 'unmatched').length;
    const suggestedBank = bank.filter((b) => b.status === 'suggested').length;
    // Fix (was `status === 'active'`, never true): open credits are open/requested/received (enum values).
    const openCreditRows = credits.filter((c) => ['open', 'requested', 'received'].includes(c.status));
    const openCreditsSum = openCreditRows.length ? openCreditRows.reduce((s, c) => s + c.amount, 0) : null;
    const notSent = invoices.filter((i) => i.export_status === 'not_sent' && i.review_status === 'approved').length;

    const kpis: ScoreItem[] = [
      { label: t('accountantDashboard.fmtMoneyRounded'), value: fmtMoneyRounded(paidMonth) },
      { label: t('accountantDashboard.fmtMoneyRounded_2'), value: fmtMoneyRounded(openInvoiceBalance), tone: openInvoiceBalance ? 'await' : 'idle' },
      { label: t('accountantDashboard.fmtNum'), value: fmtNum(unmatchedBank), tone: unmatchedBank ? 'await' : 'idle' },
      { label: t('accountantDashboard.fmtNum_2'), value: fmtNum(suggestedBank), tone: suggestedBank ? 'await' : 'idle' },
      { label: t('accountantDashboard.fmtNum_3'), value: fmtNum(openCreditRows.length), sub: openCreditsSum != null ? fmtMoneyRounded(openCreditsSum) : undefined },
      { label: t('accountantDashboard.fmtNum_4'), value: fmtNum(notSent), tone: notSent ? 'await' : 'idle' },
    ];

    // ── attention. NOTE: "חשבוניות לבדיקה" (received/in_review) is structurally ~0 for the accountant —
    // RLS only exposes approved invoices; pre-approval review is owner/office work. Kept to match the
    // prior dashboard; flagged for a follow-up (a review queue belongs on the office dashboard).
    const toReview = invoices.filter((i) => ['received', 'in_review'].includes(i.review_status)).length;
    const attention: AttentionItem[] = [
      { key: 'review', label: t('accountantDashboard.text'), count: toReview, tone: 'await', to: '/invoices', clearLabel: t('accountantDashboard.text_2') },
      { key: 'not-sent', label: t('accountantDashboard.text_3'), count: notSent, tone: 'await', to: '/invoices', clearLabel: t('accountantDashboard.text_4') },
      { key: 'bank', label: t('accountantDashboard.text_5'), count: unmatchedBank, tone: 'await', to: '/bank', clearLabel: t('accountantDashboard.text_6') },
      { key: 'bank-suggested', label: t('accountantDashboard.text_7'), count: suggestedBank, tone: 'await', to: '/bank?status=suggested', clearLabel: t('accountantDashboard.text_8') },
      { key: 'credits', label: t('accountantDashboard.text_9'), count: openCreditRows.length, amount: openCreditsSum, tone: 'info', to: '/credits?status=active', clearLabel: t('accountantDashboard.text_10') },
    ];

    // ── charts
    const monthly = monthlyBuckets(payments.map((p) => ({ date: p.paid_date, value: p.amount })), { monthKey, months: 4 })
      .map((b) => ({ key: fmtMonth(`${b.key}-01`), label: b.count ? money(b.total) : '', total: b.total }));

    const paidW = weeklyBuckets(payments.map((p) => ({ date: p.paid_date, value: p.amount })), { todayISO: today });
    const debitW = weeklyBuckets(bank.filter((b) => b.is_debit).map((b) => ({ date: b.tx_date, value: Math.abs(b.amount) })), { todayISO: today });
    // T7.2 zero policy: both series bucket the same fully-fetched window, so a rowless week is a
    // measured ₪0 — bars simply have zero height. A truly all-quiet window renders the empty
    // state instead (weeklyActive guard below), never a fabricated chart.
    const weekly: LinePoint[] = paidW.map((p, i) => ({
      week: p.week,
      payments: p.count > 0 ? p.total : 0,
      bank: (debitW[i]?.count ?? 0) > 0 ? debitW[i].total : 0,
    }));
    const weeklyActive = paidW.some((p) => p.count > 0) || debitW.some((b) => b.count > 0);

    const supplierSlices = topCategoriesWithOther(
      supBal.map((b) => ({ name: suppliers.get(b.supplier_id) ?? '—', total: b.open_balance })),
    );
    const supplierTotal = supplierSlices.reduce((s, c) => s + c.total, 0);

    const supplierBalances = supBal
      .map((row) => ({ ...row, name: suppliers.get(row.supplier_id) ?? '—' }))
      .sort((a, b) => b.open_balance - a.open_balance)
      .slice(0, 5);
    return { kpis, attention, monthly, weekly, weeklyActive, supplierSlices, supplierTotal, supplierBalances };
  });

  if (loading) return <SkeletonCards count={5} cols={5} title />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;

  return (
    <DashboardFrame title={t('accountantDashboard.title')} actions={<>
      <Link to="/pay" className="btn-primary"><Banknote size={ICON.sm} aria-hidden="true" /> {t('accountantDashboard.text_11')}</Link>
      <Link to="/invoices" className="btn-secondary"><ReceiptText size={ICON.sm} aria-hidden="true" /> {t('accountantDashboard.text_12')}</Link>
    </>}>
      <AttentionZone items={data.attention} />
      <Scorecard items={data.kpis} />
      <div className="grid gap-5 lg:grid-cols-2">
        <ChartCard title={t('accountantDashboard.title_2')} subtitle={t('accountantDashboard.subtitle')}>
          <SpendBarChart points={data.monthly}
            ariaLabel={t('accountantDashboard.monthlyAria', {
              points: data.monthly.map((p) => `${p.key} ${p.label || t('accountantDashboard.noPayments')}`).join(', '),
            })}
            emptyMessage={t('accountantDashboard.emptyMessage')} />
        </ChartCard>
        {/* G1, finding 13. "כמה אני חייב לספק הזה?" ended here for an accountant: four labels in a
            pie and nothing to click. The permission was never the problem — `p0_supplier_balance_rows()`
            names the accountant explicitly (0022:453,:465-466) — the client simply had no door,
            since /suppliers and /suppliers/:id are STAFF-only and the global search excludes
            suppliers for this role. Each named slice now opens the invoice list searched for that
            supplier, which is a screen the accountant already has. Opening /suppliers/:id to the
            role would be a role-contract change (PRODUCT.md:23-30) and is left as
            OPEN-DECISIONS #117. The aggregate slice gets no link: it is several suppliers summed,
            so there is no single thing to open, and a link that lands on a wrong filter is worse
            than none. It is recognised by `slice.aggregate`, NOT by its word — this line used to
            compare a supplier name against `t(...)`, which stops matching the moment the reader
            changes language, and the bucket would then have been linked to a search for a supplier
            that does not exist. */}
        <ChartCard title={t('accountantDashboard.title_3')} subtitle={t('accountantDashboard.subtitle_2')}>
          <CategoryDonut slices={data.supplierSlices} total={data.supplierTotal}
            ariaLabel={t('accountantDashboard.supplierBalancesAria', { total: fmtMoneyRounded(data.supplierTotal) })}
            hrefFor={(slice) => (slice.aggregate || slice.name === '—'
              ? null
              : `/invoices?q=${encodeURIComponent(slice.name)}&pay=open`)}
            hrefLabel={(slice) => t('accountantDashboard.openInvoicesOf', { supplier: slice.name })}
            emptyMessage={t('accountantDashboard.emptyMessage_2')} />
          {data.supplierBalances.length > 0 && <div className="mt-4 divide-y divide-line border-t border-line">
            {data.supplierBalances.map((supplier) => <Link key={supplier.supplier_id}
              to={`/finance/suppliers/${supplier.supplier_id}`}
              className="flex min-h-11 items-center justify-between gap-3 py-2 text-sm">
              <span>{supplier.name}</span><span className="num font-medium">{fmtMoneyRounded(supplier.open_balance)}</span>
            </Link>)}
          </div>}
        </ChartCard>
        {/* T7.2: the reference's paired-bars rendering — each week gets a payments bar beside a
            bank-debits bar, round caps, dot legend below. */}
        <ChartCard title={t('accountantDashboard.title_4')} subtitle={t('accountantDashboard.subtitle_3')} className="lg:col-span-2">
          <GroupedBarChart points={data.weeklyActive ? data.weekly : []} xKey="week"
            series={comparisonSeries({ key: 'payments', name: t('accountantDashboard.comparisonSeries') }, { key: 'bank', name: t('accountantDashboard.comparisonSeries_2') })}
            ariaLabel={t('accountantDashboard.ariaLabel')}
            emptyMessage={t('accountantDashboard.emptyMessage_3')} />
        </ChartCard>
      </div>
    </DashboardFrame>
  );
}
