import { Link } from 'react-router-dom';
import { Banknote, ReceiptText } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useQuery } from '../../lib/useQuery';
import { fetchAll } from '../../lib/supabasePaging';
import { AttentionZone, SkeletonCards, ErrorNote, type AttentionItem } from '../../components/ui';
import { Scorecard, type ScoreItem } from '../../components/supplier-metrics';
import { CategoryDonut, ComparisonLineChart, SpendBarChart, money, type LinePoint } from '../../components/charts';
import { chartTheme } from '../../lib/theme';
import { topCategoriesWithOther } from '../../lib/dashboardSeries';
import { fmtMonth, fmtMoney, fmtNum, monthlyBuckets, shiftCalendarMonth, todayISO, weeklyBuckets } from '../../lib/format';
import { DashboardFrame, ChartCard } from './parts';

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
  const { data, loading, error } = useQuery(async () => {
    const today = todayISO();
    const monthKey = today.slice(0, 7);
    const chartsFrom = `${shiftCalendarMonth(monthKey, -3)}-01`;

    const [paymentsRes, bankRes, creditsRes, invoicesRes, invBalRes, supBalRes, suppliersRes] = await Promise.all([
      fetchAll((from, to) => supabase.from('payments').select('amount, paid_date').gte('paid_date', chartsFrom).lte('paid_date', today).order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('bank_transactions').select('status, tx_date, amount, is_debit').order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('credit_requests').select('amount, status').order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('invoices').select('review_status, export_status').is('deleted_at', null).order('id').range(from, to)),
      fetchAll((from, to) => supabase.from('invoice_balances').select('balance').order('invoice_id').range(from, to)),
      fetchAll((from, to) => supabase.from('supplier_balances').select('supplier_id, open_balance').gt('open_balance', 0).order('supplier_id').range(from, to)),
      fetchAll((from, to) => supabase.from('suppliers').select('id, name').order('id').range(from, to)),
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
    const unmatchedBank = bank.filter((b) => ['unmatched', 'suggested'].includes(b.status)).length;
    // Fix (was `status === 'active'`, never true): open credits are open/requested/received (enum values).
    const openCreditRows = credits.filter((c) => ['open', 'requested', 'received'].includes(c.status));
    const openCreditsSum = openCreditRows.length ? openCreditRows.reduce((s, c) => s + c.amount, 0) : null;
    const notSent = invoices.filter((i) => i.export_status === 'not_sent' && i.review_status === 'approved').length;

    const kpis: ScoreItem[] = [
      { label: 'שולם החודש', value: fmtMoney(paidMonth) },
      { label: 'יתרת חשבוניות פתוחות', value: fmtMoney(openInvoiceBalance), tone: openInvoiceBalance ? 'amber' : 'slate' },
      { label: 'תנועות בנק לא מותאמות', value: fmtNum(unmatchedBank), tone: unmatchedBank ? 'amber' : 'slate' },
      { label: 'זיכויים פתוחים', value: fmtNum(openCreditRows.length), sub: openCreditsSum != null ? fmtMoney(openCreditsSum) : undefined },
      { label: 'ממתין להעברה לרו״ח', value: fmtNum(notSent), tone: notSent ? 'amber' : 'slate' },
    ];

    // ── attention. NOTE: "חשבוניות לבדיקה" (received/in_review) is structurally ~0 for the accountant —
    // RLS only exposes approved invoices; pre-approval review is office/kitchen work. Kept to match the
    // prior dashboard; flagged for a follow-up (a review queue belongs on the office dashboard).
    const toReview = invoices.filter((i) => ['received', 'in_review'].includes(i.review_status)).length;
    const attention: AttentionItem[] = [
      { key: 'review', label: 'חשבוניות לבדיקה', count: toReview, tone: 'await', to: '/invoices', clearLabel: 'אין חשבוניות לבדיקה' },
      { key: 'not-sent', label: 'חשבוניות מאושרות שלא נשלחו לרו״ח', count: notSent, tone: 'await', to: '/invoices', clearLabel: 'הכול נשלח לרו״ח' },
      { key: 'bank', label: 'תנועות בנק לא מותאמות', count: unmatchedBank, tone: 'await', to: '/bank', clearLabel: 'אין תנועות פתוחות' },
      { key: 'credits', label: 'זיכויים פתוחים', count: openCreditRows.length, amount: openCreditsSum, tone: 'info', to: '/credits?status=active', clearLabel: 'אין זיכויים פתוחים' },
    ];

    // ── charts
    const monthly = monthlyBuckets(payments.map((p) => ({ date: p.paid_date, value: p.amount })), { monthKey, months: 4 })
      .map((b) => ({ key: fmtMonth(`${b.key}-01`), label: b.count ? money(b.total) : '', total: b.total }));

    const paidW = weeklyBuckets(payments.map((p) => ({ date: p.paid_date, value: p.amount })), { todayISO: today });
    const debitW = weeklyBuckets(bank.filter((b) => b.is_debit).map((b) => ({ date: b.tx_date, value: Math.abs(b.amount) })), { todayISO: today });
    const weekly: LinePoint[] = paidW.map((p, i) => ({
      week: p.week,
      payments: p.count > 0 ? p.total : null,
      bank: (debitW[i]?.count ?? 0) > 0 ? debitW[i].total : null,
    }));

    const supplierSlices = topCategoriesWithOther(
      supBal.map((b) => ({ name: suppliers.get(b.supplier_id) ?? '—', total: b.open_balance })),
    );
    const supplierTotal = supplierSlices.reduce((s, c) => s + c.total, 0);

    return { kpis, attention, monthly, weekly, supplierSlices, supplierTotal };
  });

  if (loading) return <SkeletonCards count={5} cols={5} title />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;
  const t = chartTheme();

  return (
    <DashboardFrame title="מרכז הבקרה — הנהלת חשבונות" actions={<>
      <Link to="/pay" className="btn-primary"><Banknote size={16} /> תשלומים</Link>
      <Link to="/invoices" className="btn-secondary"><ReceiptText size={16} /> חשבוניות</Link>
    </>}>
      <Scorecard items={data.kpis} />
      <AttentionZone items={data.attention} />
      <div className="grid gap-5 lg:grid-cols-2">
        <ChartCard title="תשלומים לפי חודש" subtitle="סך התשלומים לספקים בארבעת החודשים האחרונים">
          <SpendBarChart points={data.monthly}
            ariaLabel={`תשלומים לפי חודש: ${data.monthly.map((p) => `${p.key} ${p.label || 'אין תשלומים'}`).join(', ')}`}
            emptyMessage="אין תשלומים לתקופה" />
        </ChartCard>
        <ChartCard title="יתרות פתוחות לפי ספק" subtitle="ארבעת הספקים עם היתרה הגבוהה וכל היתר">
          <CategoryDonut slices={data.supplierSlices} total={data.supplierTotal}
            ariaLabel={`יתרות פתוחות לפי ספק, סה״כ ${fmtMoney(data.supplierTotal)}`}
            emptyMessage="אין יתרות פתוחות" />
        </ChartCard>
        <ChartCard title="תשלומים מול חיובי בנק" subtitle="שמונה השבועות האחרונים" className="lg:col-span-2">
          <ComparisonLineChart points={data.weekly} xKey="week" legend
            series={[{ key: 'payments', name: 'תשלומים', color: t.bars[0] }, { key: 'bank', name: 'חיובי בנק', color: t.bars[2], dashed: true }]}
            ariaLabel="השוואת תשלומים שבוצעו מול חיובי בנק, שמונה שבועות"
            emptyMessage="אין תשלומים או תנועות בנק בשמונת השבועות האחרונים" />
        </ChartCard>
      </div>
    </DashboardFrame>
  );
}
