import { useT } from '../../lib/i18n/LocaleProvider';
import { Link } from 'react-router';
import { Banknote, ReceiptText } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useQuery } from '../../lib/useQuery';
import { fetchAll } from '../../lib/supabasePaging';
import { AttentionZone, SkeletonCards, ErrorNote, ICON, type AttentionItem } from '../../components/ui';
import { Scorecard, type ScoreItem } from '../../components/supplier-metrics';
import { CategoryDonut, GroupedBarChart, SpendBarChart, moneyFor, type LinePoint } from '../../components/charts';
import { totalsByCurrency } from '../../components/Money';
import { useAuth } from '../../auth/AuthContext';
import { comparisonSeries } from '../../lib/theme';
import { topCategoriesWithOther } from '../../lib/dashboardSeries';
import { fmtMonth, fmtMoneyRounded, fmtNum, monthlyBuckets, shiftCalendarMonth, todayISO, weeklyBuckets } from '../../lib/format';
import { DashboardFrame, ChartCard } from './parts';
import { readFinancialSuppliers } from '../../lib/financialSuppliers';

type Payment = { amount: number; currency: string; paid_date: string };
type Bank = { status: string; tx_date: string; amount: number; currency: string; is_debit: boolean };
type Credit = { amount: number; currency: string; status: string };
type Invoice = { review_status: string; export_status: string };
type SupBal = { supplier_id: string; currency: string; open_balance_in_currency: number };

/**
 * Accountant control room (finance execution). RLS-scoped to finance the accountant may read:
 * payments, bank transactions, credit requests, approved invoices, and the balance views. No catalog,
 * prices, purchase orders or supplier_metrics (RLS returns nothing there). Empty → "—"/empty-state.
 */
export default function AccountantDashboard() {
  const { t, locale } = useT();
  const { org } = useAuth();
  const baseCurrency = org?.base_currency ?? null;
  const { data, loading, error } = useQuery(async () => {
    const today = todayISO();
    const monthKey = today.slice(0, 7);
    const chartsFrom = `${shiftCalendarMonth(monthKey, -3)}-01`;

    const [paymentsRes, bankRes, creditsRes, invoicesRes, invBalRes, supBalRes, suppliersRes] = await Promise.all([
      fetchAll((from, to) => supabase.from('payments').select('amount, currency, paid_date').gte('paid_date', chartsFrom).lte('paid_date', today).order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('bank_transactions').select('status, tx_date, amount, currency, is_debit').order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('credit_requests').select('amount, currency, status').order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('invoices').select('review_status, export_status').eq('financial_role', 'payable').is('deleted_at', null).order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('invoice_balances_by_currency').select('currency, balance_in_currency').order('invoice_id').range(from, to)),
      fetchAll((from, to) => supabase.from('supplier_balances_by_currency').select('supplier_id, currency, open_balance_in_currency').gt('open_balance_in_currency', 0).order('supplier_id').range(from, to)),
      readFinancialSuppliers(),
    ]);

    const payments = paymentsRes as unknown as Payment[];
    const bank = bankRes as unknown as Bank[];
    const credits = creditsRes as unknown as Credit[];
    const invoices = invoicesRes as unknown as Invoice[];
    const invBal = invBalRes as unknown as { currency: string; balance_in_currency: number }[];
    const supBal = supBalRes as unknown as SupBal[];
    const suppliers = new Map((suppliersRes as unknown as { id: string; name: string }[]).map((s) => [s.id, s.name]));

    // ── KPIs
    /* Every figure below is summed WITHIN a currency (0217, #277). The accountant's screen is
       the last place a total may quietly cover two kinds of money: this is the person who
       reconciles it against a bank statement. */
    const paymentsThisMonth = payments.filter((p) => p.paid_date.slice(0, 7) === monthKey);
    const paidMonth = totalsByCurrency(paymentsThisMonth.map((p) => ({ currency: p.currency, amount: p.amount })));
    const openInvoiceBalance = totalsByCurrency(
      invBal.map((b) => ({ currency: b.currency, amount: Math.max(0, b.balance_in_currency) })),
    );
    const unmatchedBank = bank.filter((b) => b.status === 'unmatched').length;
    const suggestedBank = bank.filter((b) => b.status === 'suggested').length;
    // Fix (was `status === 'active'`, never true): the not-yet-offset set is open/requested/received
    // (enum values) — the same three `0218`'s `credit_metrics` and `supplier_metrics.open_credits`
    // count, and `DASH-10` is why the label over them no longer says "open".
    const openCreditRows = credits.filter((c) => ['open', 'requested', 'received'].includes(c.status));
    const openCreditsByCurrency = totalsByCurrency(openCreditRows.map((c) => ({ currency: c.currency, amount: c.amount })));
    /**
     * `ASSIST-12` — WHAT AN EMPTY CREDITS READ MEANS FOR THIS ROLE, AND WHY IT IS NOT ZERO.
     *
     * `credit_requests` carries a restrictive rider (`0073:208-240`): a row is visible only when
     * its anchor is. An invoice-anchored credit needs the invoice, and the accountant's `invoices`
     * scope stops at approved; a receipt-anchored credit needs the receipt's purchase order, which
     * is outside this role's scope entirely. So an accountant can be shown NOTHING while the
     * organisation holds nine credits worth ₪3,423.20 — measured on 04.09.2026, when this tile
     * read `0` beside an assistant that answered the same question with a named refusal.
     *
     * An empty array is therefore two different facts wearing one shape, and the count is only
     * one of them. `null` says the honest thing — this role cannot measure it — and the
     * constitution's rule then draws `—` rather than a zero that claims the credits do not exist.
     * `getDashboardSnapshot.ts:40-48` already reached this conclusion for office and the bank
     * figures: a named `not_permitted` "instead of a false zero".
     *
     * A read that returned rows is a different matter. Rows came back, none of them is open, and
     * `0` is then a measurement — hiding THAT behind an em dash would be the mirror mistake, and
     * the constitution forbids that one too.
     */
    const creditsAreReadable = credits.length > 0;
    const openCreditCount = creditsAreReadable ? openCreditRows.length : null;
    const notSent = invoices.filter((i) => i.export_status === 'not_sent' && i.review_status === 'approved').length;

    const asLines = (entries: { currency: string; amount: number }[]) => (entries.length
      ? entries.map((entry) => fmtMoneyRounded(entry.amount, entry.currency)).join(' · ')
      : '—');
    const kpis: ScoreItem[] = [
      { label: t('accountantDashboard.fmtMoneyRounded'), value: asLines(paidMonth) },
      { label: t('accountantDashboard.fmtMoneyRounded_2'), value: asLines(openInvoiceBalance), tone: openInvoiceBalance.length ? 'await' : 'idle' },
      { label: t('accountantDashboard.fmtNum'), value: fmtNum(unmatchedBank), tone: unmatchedBank ? 'await' : 'idle' },
      { label: t('accountantDashboard.fmtNum_2'), value: fmtNum(suggestedBank), tone: suggestedBank ? 'await' : 'idle' },
      {
        label: t('accountantDashboard.fmtNum_3'),
        value: fmtNum(openCreditCount),
        // An unexplained dash reads as a broken screen. The reason belongs beside it — the same
        // way the assistant names its refusal rather than returning an empty answer.
        sub: openCreditsByCurrency.length ? asLines(openCreditsByCurrency)
          : creditsAreReadable ? undefined : t('accountantDashboard.creditsOutOfScope'),
      },
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
      // `count: null` here is load-bearing: `AttentionZone` routes an unmeasurable row to its own
      // neutral tier instead of the muted all-clear list, so the screen never says "אין זיכויים
      // שטרם קוזזו" about a population it was not shown.
      { key: 'credits', label: t('accountantDashboard.text_9'), count: openCreditCount, amounts: openCreditsByCurrency, tone: 'info', to: '/credits?status=active', hint: creditsAreReadable ? undefined : t('accountantDashboard.creditsOutOfScope'), clearLabel: t('accountantDashboard.text_10') },
    ];

    // ── charts
    // A chart is one currency (charts.tsx). The organisation's own is the one it draws; money in
    // any other currency is reported by the KPI lines above, which list every currency they hold.
    const basePayments = payments.filter((p) => p.currency === baseCurrency);
    const baseBank = bank.filter((b) => b.currency === baseCurrency);
    const monthly = monthlyBuckets(basePayments.map((p) => ({ date: p.paid_date, value: p.amount })), { monthKey, months: 4 })
      .map((b) => ({ key: fmtMonth(`${b.key}-01`, locale), label: b.count ? moneyFor(baseCurrency)(b.total) : '', total: b.total }));

    const paidW = weeklyBuckets(basePayments.map((p) => ({ date: p.paid_date, value: p.amount })), { todayISO: today });
    const debitW = weeklyBuckets(baseBank.filter((b) => b.is_debit).map((b) => ({ date: b.tx_date, value: Math.abs(b.amount) })), { todayISO: today });
    // T7.2 zero policy: both series bucket the same fully-fetched window, so a rowless week is a
    // measured ₪0 — bars simply have zero height. A truly all-quiet window renders the empty
    // state instead (weeklyActive guard below), never a fabricated chart.
    const weekly: LinePoint[] = paidW.map((p, i) => ({
      week: p.week,
      payments: p.count > 0 ? p.total : 0,
      bank: (debitW[i]?.count ?? 0) > 0 ? debitW[i].total : 0,
    }));
    const weeklyActive = paidW.some((p) => p.count > 0) || debitW.some((b) => b.count > 0);

    // The donut is one currency too: a slice is a share of a whole, and two currencies have no
    // shared whole to take a share of.
    const baseSupBal = supBal.filter((b) => b.currency === baseCurrency);
    const supplierSlices = topCategoriesWithOther(
      baseSupBal.map((b) => ({ name: suppliers.get(b.supplier_id) ?? '—', total: b.open_balance_in_currency })),
    );
    const supplierTotal = supplierSlices.reduce((s, c) => s + c.total, 0);

    // The list, unlike the donut, may show every currency: it is a list of debts, not a share of
    // one whole, and it is ordered inside each currency rather than across them.
    const supplierBalances = supBal
      .map((row) => ({ ...row, name: suppliers.get(row.supplier_id) ?? '—' }))
      .sort((a, b) => (a.currency === b.currency
        ? b.open_balance_in_currency - a.open_balance_in_currency
        : a.currency === baseCurrency ? -1 : b.currency === baseCurrency ? 1 : a.currency < b.currency ? -1 : 1))
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
      <AttentionZone items={data.attention} baseCurrency={baseCurrency} />
      <Scorecard items={data.kpis} />
      <div className="grid gap-5 lg:grid-cols-2">
        <ChartCard title={t('accountantDashboard.title_2')} subtitle={t('accountantDashboard.subtitle')}>
          <SpendBarChart points={data.monthly}
            ariaLabel={t('accountantDashboard.monthlyAria', {
              points: data.monthly.map((p) => `${p.key} ${p.label || t('accountantDashboard.noPayments')}`).join(', '),
            })}
            emptyMessage={t('accountantDashboard.emptyMessage')} currency={baseCurrency} />
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
          <CategoryDonut slices={data.supplierSlices} total={data.supplierTotal} currency={baseCurrency}
            ariaLabel={t('accountantDashboard.supplierBalancesAria', { total: fmtMoneyRounded(data.supplierTotal, baseCurrency) })}
            hrefFor={(slice) => (slice.aggregate || slice.name === '—'
              ? null
              : `/invoices?q=${encodeURIComponent(slice.name)}&pay=open`)}
            hrefLabel={(slice) => t('accountantDashboard.openInvoicesOf', { supplier: slice.name })}
            emptyMessage={t('accountantDashboard.emptyMessage_2')} />
          {data.supplierBalances.length > 0 && <div className="mt-4 divide-y divide-line border-t border-line">
            {data.supplierBalances.map((supplier) => <Link key={supplier.supplier_id}
              to={`/finance/suppliers/${supplier.supplier_id}`}
              className="flex min-h-11 items-center justify-between gap-3 py-2 text-sm">
              <span>{supplier.name}</span><span className="num font-medium">{fmtMoneyRounded(supplier.open_balance_in_currency, supplier.currency)}</span>
            </Link>)}
          </div>}
        </ChartCard>
        {/* T7.2: the reference's paired-bars rendering — each week gets a payments bar beside a
            bank-debits bar, round caps, dot legend below. */}
        <ChartCard title={t('accountantDashboard.title_4')} subtitle={t('accountantDashboard.subtitle_3')} className="lg:col-span-2">
          <GroupedBarChart points={data.weeklyActive ? data.weekly : []} xKey="week"
            series={comparisonSeries({ key: 'payments', name: t('accountantDashboard.comparisonSeries') }, { key: 'bank', name: t('accountantDashboard.comparisonSeries_2') })}
            ariaLabel={t('accountantDashboard.ariaLabel')}
            emptyMessage={t('accountantDashboard.emptyMessage_3')} currency={baseCurrency} />
        </ChartCard>
      </div>
    </DashboardFrame>
  );
}
