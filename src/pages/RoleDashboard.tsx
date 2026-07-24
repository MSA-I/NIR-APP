import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { PackageCheck, ShoppingCart, ReceiptText, Banknote, Camera, ShieldCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { AttentionZone, SkeletonCards, ErrorNote, type AttentionItem } from '../components/ui';
import { todayISO, fmtDate } from '../lib/format';

/**
 * Role-tailored control room for non-finance roles (owner/office keep the full Dashboard).
 * Each branch queries ONLY what that role's RLS allows — never a table the role cannot read
 * (e.g. the accountant view never touches purchase_orders, which is STAFF-only). Every count is
 * a real measure; "all clear" renders as the muted clearLabel, never a fake 0 (CLAUDE.md).
 */
export default function RoleDashboard() {
  const { profile } = useAuth();
  switch (profile?.role) {
    case 'kitchen': return <KitchenDashboard />;
    case 'accountant': return <AccountantDashboard />;
    case 'payer': return <PayerDashboard />;
    case 'supplier': return <SupplierDashboard />;
    default: return null;
  }
}

function Shell({ title, items, actions }: { title: string; items: AttentionItem[]; actions?: ReactNode }) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="page-title">{title}</h1>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      <AttentionZone items={items} />
    </div>
  );
}

function KitchenDashboard() {
  const { data, loading, error } = useQuery<{ status: string; expected_date: string | null }[]>(async () =>
    unwrap(await supabase.from('purchase_orders')
      .select('status, expected_date')
      .in('status', ['sent', 'confirmed', 'partial'])));
  if (loading) return <SkeletonCards count={3} cols={3} title />;
  if (error) return <ErrorNote message={error} />;
  const rows = data ?? [];
  const today = todayISO();
  const late = rows.filter((o) => o.expected_date && o.expected_date < today).length;
  const dueToday = rows.filter((o) => o.expected_date === today).length;
  const items: AttentionItem[] = [
    { key: 'late', label: 'הזמנות באיחור באספקה', count: late, tone: 'alert', to: '/receiving', clearLabel: 'אין הזמנות באיחור' },
    { key: 'today', label: 'לקבלה היום', count: dueToday, tone: 'await', to: '/receiving', clearLabel: 'אין קבלות מתוכננות להיום' },
    { key: 'open', label: 'הזמנות פתוחות לקבלת סחורה', count: rows.length, tone: 'idle', to: '/receiving', clearLabel: 'אין הזמנות פתוחות' },
  ];
  return <Shell title="מרכז הבקרה — מטבח" items={items} actions={<>
    <Link to="/orders/new" className="btn-primary"><ShoppingCart size={16} /> הזמנה חדשה</Link>
    <Link to="/receiving" className="btn-secondary"><PackageCheck size={16} /> קבלת סחורה</Link>
  </>} />;
}

function PayerDashboard() {
  const { data, loading, error } = useQuery<{ status: string; due_date: string | null; amount: number }[]>(async () =>
    unwrap(await supabase.from('payment_requests')
      .select('status, due_date, amount')
      .in('status', ['approved', 'sent_for_execution'])));
  if (loading) return <SkeletonCards count={3} cols={3} title />;
  if (error) return <ErrorNote message={error} />;
  const rows = data ?? [];
  const today = todayISO();
  const sum = (list: typeof rows) => list.reduce((s, r) => s + (r.amount ?? 0), 0);
  const overdue = rows.filter((r) => r.due_date && r.due_date < today);
  const dueToday = rows.filter((r) => r.due_date === today);
  const items: AttentionItem[] = [
    { key: 'overdue', label: 'תשלומים באיחור', count: overdue.length, amount: sum(overdue), tone: 'alert', to: '/pay', clearLabel: 'אין תשלומים באיחור' },
    { key: 'today', label: 'תשלומים לביצוע היום', count: dueToday.length, amount: sum(dueToday), tone: 'await', to: '/pay', clearLabel: 'אין תשלומים להיום' },
    { key: 'pending', label: 'ממתינים לביצוע העברה', count: rows.length, amount: sum(rows), tone: 'idle', to: '/pay', clearLabel: 'אין העברות ממתינות' },
  ];
  return <Shell title="מרכז הבקרה — ביצוע העברות" items={items} actions={
    <Link to="/pay" className="btn-primary"><Banknote size={16} /> לביצוע העברות</Link>
  } />;
}

function AccountantDashboard() {
  const { data, loading, error } = useQuery<{
    invoices: { review_status: string; export_status: string }[];
    bank: { status: string }[];
    credits: { status: string }[];
  }>(async () => {
    const [inv, bank, credits] = await Promise.all([
      supabase.from('invoices').select('review_status, export_status'),
      supabase.from('bank_transactions').select('status'),
      supabase.from('credit_requests').select('status'),
    ]);
    return {
      invoices: unwrap(inv) as { review_status: string; export_status: string }[],
      bank: unwrap(bank) as { status: string }[],
      credits: unwrap(credits) as { status: string }[],
    };
  });
  if (loading) return <SkeletonCards count={4} cols={3} title />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;
  const toReview = data.invoices.filter((i) => ['received', 'in_review'].includes(i.review_status)).length;
  const notSent = data.invoices.filter((i) => i.export_status === 'not_sent' && i.review_status === 'approved').length;
  const unmatchedBank = data.bank.filter((b) => ['unmatched', 'suggested'].includes(b.status)).length;
  const openCredits = data.credits.filter((c) => c.status === 'active').length;
  const items: AttentionItem[] = [
    { key: 'review', label: 'חשבוניות לבדיקה', count: toReview, tone: 'await', to: '/invoices', clearLabel: 'אין חשבוניות לבדיקה' },
    { key: 'not-sent', label: 'חשבוניות מאושרות שלא נשלחו לרו״ח', count: notSent, tone: 'await', to: '/invoices', clearLabel: 'הכול נשלח לרו״ח' },
    { key: 'bank', label: 'תנועות בנק לא מותאמות', count: unmatchedBank, tone: 'await', to: '/bank', clearLabel: 'אין תנועות פתוחות' },
    { key: 'credits', label: 'זיכויים פתוחים', count: openCredits, tone: 'info', to: '/credits?status=active', clearLabel: 'אין זיכויים פתוחים' },
  ];
  return <Shell title="מרכז הבקרה — הנהלת חשבונות" items={items} actions={<>
    <Link to="/pay" className="btn-primary"><Banknote size={16} /> תשלומים</Link>
    <Link to="/invoices" className="btn-secondary"><ReceiptText size={16} /> חשבוניות</Link>
  </>} />;
}

function SupplierDashboard() {
  const { data, loading, error } = useQuery<{ target_month: string; created_at: string }[]>(async () =>
    unwrap(await supabase.from('supplier_price_submissions')
      .select('target_month, created_at')
      .order('target_month', { ascending: false })
      .limit(1)));
  if (loading) return <SkeletonCards count={1} cols={3} title />;
  if (error) return <ErrorNote message={error} />;
  const last = (data ?? [])[0];
  const month = todayISO().slice(0, 7);
  const submitted = !!last && last.target_month?.slice(0, 7) === month;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="page-title">מרכז הבקרה — ספק</h1>
        <Link to="/my-prices" className="btn-primary"><Camera size={16} /> הגשת מחירון חודשי</Link>
      </div>
      <div className={`card card-pad flex items-start gap-3 ${submitted ? '' : 'border-await-line'}`}>
        {submitted
          ? <ShieldCheck size={20} className="text-done-solid shrink-0" />
          : <ReceiptText size={20} className="text-await-fg shrink-0" />}
        <div>
          <div className="text-sm font-medium text-ink-body">
            {submitted ? 'המחירון לחודש הנוכחי הוגש' : 'טרם הוגש מחירון לחודש הנוכחי'}
          </div>
          <div className="text-xs text-ink-muted mt-0.5">
            {last ? `הגשה אחרונה: ${fmtDate(last.created_at)}` : 'עדיין לא הוגשו מחירונים'}
          </div>
        </div>
      </div>
    </div>
  );
}
