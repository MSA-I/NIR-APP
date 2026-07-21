import { useState } from 'react';
import { toHebrewError } from '../lib/errors';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Loader2, Send, CheckCircle2, RotateCcw, SearchCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { PageLoader, useToast, StatusBadge, Modal, ErrorNote } from '../components/ui';
import { DocumentList } from '../components/FileUpload';
import { CheckList } from './Invoices';
import { runInvoiceChecks, type CheckResult } from '../lib/checks';
import { logAction } from '../lib/audit';
import { INVOICE_REVIEW_STATUS, INVOICE_PAYMENT_STATUS, INVOICE_EXPORT_STATUS, CREDIT_REASON } from '../lib/status';
import { fmtMoneyExact, fmtDate, todayISO } from '../lib/format';
import type { Invoice, InvoiceReviewStatus, CreditReason } from '../lib/types';

type FullInvoice = Invoice & {
  supplier: { id: string; name: string };
  orders: { order_id: string; purchase_orders: { id: string; number: number; status: string } }[];
  receipts: { receipt_id: string; goods_receipts: { id: string; number: number; received_at: string } }[];
};

export default function InvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const toast = useToast();
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [creditOpen, setCreditOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const { data, loading, error, refetch } = useQuery(async () => {
    const invoice = unwrap(await supabase.from('invoices')
      .select('*, supplier:suppliers(id, name), orders:invoice_order_links(order_id, purchase_orders(id, number, status)), receipts:invoice_receipt_links(receipt_id, goods_receipts(id, number, received_at))')
      .eq('id', id!).single()) as FullInvoice;
    const balance = unwrap(await supabase.from('invoice_balances').select('*').eq('invoice_id', id!).maybeSingle()) as
      { paid_amount: number; credited_amount: number; balance: number } | null;
    const allocations = unwrap(await supabase.from('payment_allocations')
      .select('amount, payment:payments(id, number, paid_date, reference, amount)')
      .eq('invoice_id', id!)) as { amount: number; payment: { number: number; paid_date: string; reference: string | null } }[];
    return { invoice, balance, allocations };
  }, [id]);

  const inv = data?.invoice;
  const canEdit = profile && ['owner', 'office', 'kitchen'].includes(profile.role);
  const isOffice = profile && ['owner', 'office'].includes(profile.role);

  async function runChecks() {
    if (!inv) return;
    setChecking(true);
    const res = await runInvoiceChecks({
      id: inv.id, supplier_id: inv.supplier.id, invoice_number: inv.invoice_number,
      invoice_date: inv.invoice_date, total_amount: inv.total_amount,
      linkedOrderIds: inv.orders.map((o) => o.order_id),
    });
    setChecks(res);
    setChecking(false);
  }

  async function setReviewStatus(status: InvoiceReviewStatus) {
    if (!inv) return;
    setBusy(true);
    const res = await supabase.from('invoices').update({ review_status: status }).eq('id', inv.id);
    setBusy(false);
    if (res.error) { toast(toHebrewError(res.error.message), 'error'); return; }
    await logAction({ orgId: inv.org_id, action: `invoice_review:${status}`, entityType: 'invoices', entityId: inv.id });
    toast('הסטטוס עודכן');
    void refetch();
  }

  if (loading) return <PageLoader />;
  if (error || !inv || !data) return <ErrorNote message={error ?? 'חשבונית לא נמצאה'} />;

  const transitions: { from: InvoiceReviewStatus[]; to: InvoiceReviewStatus; label: string }[] = [
    { from: ['received'], to: 'in_review', label: 'העברה לבדיקה' },
    { from: ['in_review', 'investigation'], to: 'pending_approval', label: 'העברה לאישור' },
    { from: ['pending_approval', 'in_review'], to: 'approved', label: 'אישור לתשלום' },
    { from: ['received', 'in_review', 'pending_approval'], to: 'investigation', label: 'סימון לבירור' },
  ];

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">חשבונית {inv.invoice_number} — {inv.supplier.name}</h1>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <StatusBadge meta={INVOICE_REVIEW_STATUS[inv.review_status]} />
            <StatusBadge meta={INVOICE_PAYMENT_STATUS[inv.payment_status]} />
            <StatusBadge meta={INVOICE_EXPORT_STATUS[inv.export_status]} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {isOffice && transitions.filter((t) => t.from.includes(inv.review_status)).map((t) => (
            <button key={t.to} className={t.to === 'investigation' ? 'btn-secondary text-rose-600' : 'btn-primary'} disabled={busy}
              onClick={() => void setReviewStatus(t.to)}>
              {t.to === 'approved' ? <CheckCircle2 size={15} /> : t.to === 'investigation' ? <SearchCheck size={15} /> : <Send size={15} />}
              {t.label}
            </button>
          ))}
          {isOffice && inv.review_status === 'approved' && inv.payment_status !== 'paid' && (
            <button className="btn-primary" onClick={() => navigate(`/payment-requests?new=${inv.id}`)}>
              <Send size={15} /> יצירת דרישת תשלום
            </button>
          )}
          {canEdit && <button className="btn-secondary" onClick={() => setCreditOpen(true)}><RotateCcw size={15} /> דרישת זיכוי</button>}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="card card-pad"><div className="text-xs text-slate-500">סה״כ חשבונית</div><div className="text-lg font-bold num text-start">{fmtMoneyExact(inv.total_amount)}</div>
          <div className="text-xs text-slate-500 mt-0.5">לפני מע״מ {fmtMoneyExact(inv.amount_before_vat)} + מע״מ {fmtMoneyExact(inv.vat_amount)}</div></div>
        <div className="card card-pad"><div className="text-xs text-slate-500">שולם</div><div className="text-lg font-bold num text-start text-done-fg">{fmtMoneyExact(data.balance?.paid_amount ?? 0)}</div></div>
        {/* credited = already offset, a settled claim like "paid" — done, not the retired violet (audit 2026-07-21) */}
        <div className="card card-pad"><div className="text-xs text-slate-500">זוכה</div><div className="text-lg font-bold num text-start text-done-fg">{fmtMoneyExact(data.balance?.credited_amount ?? 0)}</div></div>
        <div className="card card-pad"><div className="text-xs text-slate-500">יתרה לתשלום</div><div className={`text-lg font-bold num text-start ${data.balance && data.balance.balance > 0 ? 'text-await-fg' : 'text-done-fg'}`}>{fmtMoneyExact(data.balance?.balance ?? inv.total_amount)}</div></div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card card-pad space-y-3">
          <div className="section-title">פרטים</div>
          <dl className="text-sm space-y-2">
            <div className="flex justify-between"><dt className="text-slate-500">תאריך חשבונית</dt><dd>{fmtDate(inv.invoice_date)}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">נקלטה במערכת</dt><dd>{fmtDate(inv.received_date)}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">ספק</dt><dd><Link className="text-indigo-700 hover:underline" to={`/suppliers/${inv.supplier.id}`}>{inv.supplier.name}</Link></dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">הזמנות מקושרות</dt>
              <dd className="flex gap-2">{inv.orders.length ? inv.orders.map((o) => (
                <Link key={o.order_id} className="text-indigo-700 hover:underline" to={`/orders/${o.order_id}`}>#{o.purchase_orders.number}</Link>
              )) : '—'}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">קבלות סחורה</dt>
              <dd>{inv.receipts.length ? inv.receipts.map((r) => `#${r.goods_receipts.number}`).join(', ') : '—'}</dd></div>
          </dl>
          {inv.notes && <div className="text-sm text-slate-600 bg-slate-50 rounded-lg px-3 py-2">{inv.notes}</div>}
        </div>

        <div className="card card-pad">
          <DocumentList entityType="invoice" entityId={inv.id} capture />
          {data.allocations.length > 0 && (
            <div className="mt-4">
              <div className="text-sm font-medium text-slate-600 mb-2">תשלומים שהוקצו לחשבונית</div>
              <ul className="divide-y divide-slate-100 border border-slate-100 rounded-lg text-sm">
                {data.allocations.map((a, i) => (
                  <li key={i} className="flex justify-between px-3 py-2">
                    <span>תשלום #{a.payment.number} · {fmtDate(a.payment.paid_date)} {a.payment.reference && <span className="text-slate-500" dir="ltr">({a.payment.reference})</span>}</span>
                    <span className="num font-medium">{fmtMoneyExact(a.amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      <div className="card card-pad">
        <div className="flex items-center justify-between mb-3">
          <div className="section-title">בדיקות אוטומטיות</div>
          <button className="btn-secondary py-1.5!" onClick={() => void runChecks()} disabled={checking}>
            {checking ? <Loader2 size={14} className="animate-spin" /> : <SearchCheck size={15} />} הרצת בדיקות
          </button>
        </div>
        {checks ? <CheckList checks={checks} /> : <div className="text-sm text-slate-500">לחץ ״הרצת בדיקות״ להשוואת החשבונית מול הזמנות, קבלות, תשלומים ותנועות בנק.</div>}
      </div>

      {creditOpen && (
        <CreditFromInvoice invoice={inv} onClose={() => setCreditOpen(false)}
          onSaved={() => { setCreditOpen(false); toast('דרישת הזיכוי נפתחה'); void refetch(); }} />
      )}
    </div>
  );
}

function CreditFromInvoice({ invoice, onClose, onSaved }: { invoice: FullInvoice; onClose: () => void; onSaved: () => void }) {
  const { profile } = useAuth();
  const toast = useToast();
  const [reason, setReason] = useState<CreditReason>('wrong_price');
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    const a = Number(amount);
    if (!a || a <= 0) { toast('סכום זיכוי לא תקין', 'error'); return; }
    setBusy(true);
    const res = await supabase.from('credit_requests').insert({
      org_id: profile!.org_id, supplier_id: invoice.supplier.id, invoice_id: invoice.id,
      reason, amount: a, status: 'open', notes: notes || null, created_by: profile!.id, created_at: new Date().toISOString(),
    });
    setBusy(false);
    if (res.error) { toast(toHebrewError(res.error.message), 'error'); return; }
    onSaved();
  }

  return (
    <Modal open onClose={onClose} title={`דרישת זיכוי — חשבונית ${invoice.invoice_number}`}>
      <div className="space-y-4">
        <div>
          <label className="label">סיבת הזיכוי</label>
          <select className="input" value={reason} onChange={(e) => setReason(e.target.value as CreditReason)}>
            {Object.entries(CREDIT_REASON).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div><label className="label">סכום (₪)</label><input type="number" step="0.01" className="input num" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        <div><label className="label">פירוט</label><textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        <div className="text-xs text-slate-500">נפתח בתאריך {fmtDate(todayISO())} · הזיכוי ישפיע על יתרת הספק לאחר אישור/קיזוז</div>
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <button className="btn-secondary" onClick={onClose}>ביטול</button>
        <button className="btn-primary" disabled={busy} onClick={() => void save()}>פתיחת דרישת זיכוי</button>
      </div>
    </Modal>
  );
}
