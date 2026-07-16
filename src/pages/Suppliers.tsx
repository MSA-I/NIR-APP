import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Plus, Phone, Mail, MapPin, Clock } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { DataTable, StatusBadge, PageLoader, useToast, Modal, ErrorNote, type Column } from '../components/ui';
import { SUPPLIER_STATUS, PO_STATUS, INVOICE_REVIEW_STATUS, INVOICE_PAYMENT_STATUS, CREDIT_STATUS, CREDIT_REASON } from '../lib/status';
import { fmtMoney, fmtMoneyExact, fmtDate, fmtDays } from '../lib/format';
import type { Supplier, Category, PurchaseOrder, Invoice, Payment, CreditRequest, SupplierStatus } from '../lib/types';

interface SupplierWithBalance extends Supplier {
  open_balance?: number;
  categories?: string[];
}

export function SuppliersList() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [editing, setEditing] = useState<Supplier | null | 'new'>(null);

  const { data, loading, error, refetch } = useQuery(async () => {
    const suppliers = unwrap(await supabase.from('suppliers').select('*, supplier_categories(category_id, categories(name))').is('deleted_at', null).order('name')) as (Supplier & { supplier_categories: { categories: { name: string } }[] })[];
    const balances = unwrap(await supabase.from('supplier_balances').select('*')) as { supplier_id: string; open_balance: number }[];
    const balMap = new Map(balances.map((b) => [b.supplier_id, b.open_balance]));
    return suppliers.map((s) => ({ ...s, open_balance: balMap.get(s.id) ?? 0, categories: s.supplier_categories?.map((c) => c.categories?.name).filter(Boolean) }));
  });

  const canWrite = profile?.role === 'owner' || profile?.role === 'office';

  const columns: Column<SupplierWithBalance>[] = [
    { key: 'name', header: 'ספק', sortValue: (r) => r.name, render: (r) => <span className="font-medium text-slate-900">{r.name}</span> },
    { key: 'cats', header: 'קטגוריות', render: (r) => <span className="text-slate-500">{r.categories?.join(', ') || '—'}</span> },
    { key: 'contact', header: 'איש קשר', render: (r) => r.contact_name || '—' },
    { key: 'phone', header: 'טלפון', render: (r) => <span dir="ltr">{r.phone || '—'}</span> },
    { key: 'days', header: 'ימי אספקה', render: (r) => fmtDays(r.delivery_days) },
    { key: 'min', header: 'מינ׳ הזמנה', className: 'num', sortValue: (r) => r.min_order_amount ?? 0, render: (r) => fmtMoney(r.min_order_amount) },
    { key: 'balance', header: 'יתרה פתוחה', className: 'num', sortValue: (r) => r.open_balance ?? 0, render: (r) => <span className={r.open_balance ? 'text-amber-700 font-medium' : ''}>{fmtMoney(r.open_balance)}</span> },
    { key: 'status', header: 'סטטוס', render: (r) => <StatusBadge meta={SUPPLIER_STATUS[r.status]} /> },
  ];

  if (loading) return <PageLoader />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="page-title">ספקים</h1>
        {canWrite && <button className="btn-primary" onClick={() => setEditing('new')}><Plus size={16} /> ספק חדש</button>}
      </div>
      <DataTable rows={data ?? []} columns={columns} searchable
        searchFn={(r, q) => r.name.toLowerCase().includes(q) || (r.contact_name ?? '').toLowerCase().includes(q)}
        onRowClick={(r) => navigate(`/suppliers/${r.id}`)} />
      {editing && <SupplierForm supplier={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void refetch(); }} />}
    </div>
  );
}

function SupplierForm({ supplier, onClose, onSaved }: { supplier: Supplier | null; onClose: () => void; onSaved: () => void }) {
  const { profile } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({
    name: supplier?.name ?? '', tax_id: supplier?.tax_id ?? '', contact_name: supplier?.contact_name ?? '',
    phone: supplier?.phone ?? '', whatsapp: supplier?.whatsapp ?? '', email: supplier?.email ?? '',
    address: supplier?.address ?? '', min_order_amount: supplier?.min_order_amount?.toString() ?? '',
    payment_terms: supplier?.payment_terms ?? '', bank_details: supplier?.bank_details ?? '',
    notes: supplier?.notes ?? '', status: (supplier?.status ?? 'active') as SupplierStatus,
    delivery_days: supplier?.delivery_days ?? [] as number[],
    cutoff_time: supplier?.cutoff_time?.slice(0, 5) ?? '',
  });

  const set = (k: string, v: unknown) => setF((s) => ({ ...s, [k]: v }));

  async function save() {
    if (!f.name.trim()) { toast('שם ספק הוא שדה חובה', 'error'); return; }
    setBusy(true);
    const row = {
      org_id: profile!.org_id, name: f.name.trim(), tax_id: f.tax_id || null, contact_name: f.contact_name || null,
      phone: f.phone || null, whatsapp: f.whatsapp || null, email: f.email || null, address: f.address || null,
      min_order_amount: f.min_order_amount ? Number(f.min_order_amount) : null,
      payment_terms: f.payment_terms || null, bank_details: f.bank_details || null, notes: f.notes || null,
      status: f.status, delivery_days: f.delivery_days, cutoff_time: f.cutoff_time || null,
    };
    const res = supplier
      ? await supabase.from('suppliers').update(row).eq('id', supplier.id)
      : await supabase.from('suppliers').insert(row);
    setBusy(false);
    if (res.error) { toast(res.error.message, 'error'); return; }
    toast(supplier ? 'הספק עודכן' : 'הספק נוצר');
    onSaved();
  }

  const days = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

  return (
    <Modal open onClose={onClose} title={supplier ? `עריכת ספק — ${supplier.name}` : 'ספק חדש'} wide>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div><label className="label">שם הספק *</label><input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
        <div><label className="label">ח.פ / עוסק</label><input className="input" dir="ltr" value={f.tax_id} onChange={(e) => set('tax_id', e.target.value)} /></div>
        <div><label className="label">איש קשר</label><input className="input" value={f.contact_name} onChange={(e) => set('contact_name', e.target.value)} /></div>
        <div><label className="label">טלפון</label><input className="input" dir="ltr" value={f.phone} onChange={(e) => set('phone', e.target.value)} /></div>
        <div><label className="label">WhatsApp</label><input className="input" dir="ltr" value={f.whatsapp} onChange={(e) => set('whatsapp', e.target.value)} /></div>
        <div><label className="label">אימייל</label><input className="input" dir="ltr" value={f.email} onChange={(e) => set('email', e.target.value)} /></div>
        <div className="sm:col-span-2"><label className="label">כתובת</label><input className="input" value={f.address} onChange={(e) => set('address', e.target.value)} /></div>
        <div>
          <label className="label">ימי אספקה</label>
          <div className="flex flex-wrap gap-1.5">
            {days.map((d, i) => (
              <button type="button" key={i}
                className={`rounded-lg border px-2.5 py-1.5 text-xs ${f.delivery_days.includes(i) ? 'bg-indigo-600 text-white border-indigo-600' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}
                onClick={() => set('delivery_days', f.delivery_days.includes(i) ? f.delivery_days.filter((x) => x !== i) : [...f.delivery_days, i].sort())}>
                {d}
              </button>
            ))}
          </div>
        </div>
        <div><label className="label">שעת סגירת הזמנות</label><input type="time" className="input" value={f.cutoff_time} onChange={(e) => set('cutoff_time', e.target.value)} /></div>
        <div><label className="label">מינימום הזמנה (₪)</label><input type="number" className="input num" value={f.min_order_amount} onChange={(e) => set('min_order_amount', e.target.value)} /></div>
        <div><label className="label">תנאי תשלום</label><input className="input" placeholder="שוטף + 30" value={f.payment_terms} onChange={(e) => set('payment_terms', e.target.value)} /></div>
        <div className="sm:col-span-2"><label className="label">פרטי בנק (מוצג למבצע ההעברות)</label><input className="input" value={f.bank_details} onChange={(e) => set('bank_details', e.target.value)} /></div>
        <div>
          <label className="label">סטטוס</label>
          <select className="input" value={f.status} onChange={(e) => set('status', e.target.value)}>
            {Object.entries(SUPPLIER_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </div>
        <div className="sm:col-span-2"><label className="label">הערות</label><textarea className="input" rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></div>
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <button className="btn-secondary" onClick={onClose}>ביטול</button>
        <button className="btn-primary" disabled={busy} onClick={() => void save()}>שמירה</button>
      </div>
    </Modal>
  );
}

/* ================= Supplier card ================= */
export function SupplierCard() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [tab, setTab] = useState<'orders' | 'invoices' | 'payments' | 'credits'>('orders');
  const [editing, setEditing] = useState(false);

  const { data, loading, error, refetch } = useQuery(async () => {
    const supplier = unwrap(await supabase.from('suppliers').select('*').eq('id', id!).single()) as Supplier;
    const [orders, invoices, payments, credits, balance] = await Promise.all([
      supabase.from('purchase_orders').select('*').eq('supplier_id', id!).order('created_at', { ascending: false }).limit(50),
      supabase.from('invoices').select('*').eq('supplier_id', id!).is('deleted_at', null).order('invoice_date', { ascending: false }).limit(50),
      supabase.from('payments').select('*').eq('supplier_id', id!).order('paid_date', { ascending: false }).limit(50),
      supabase.from('credit_requests').select('*').eq('supplier_id', id!).order('created_at', { ascending: false }).limit(50),
      supabase.from('supplier_balances').select('*').eq('supplier_id', id!).single(),
    ]);
    return {
      supplier,
      orders: unwrap(orders) as PurchaseOrder[],
      invoices: unwrap(invoices) as Invoice[],
      payments: unwrap(payments) as Payment[],
      credits: unwrap(credits) as CreditRequest[],
      balance: (balance.data as { open_balance: number } | null)?.open_balance ?? 0,
    };
  }, [id]);

  const canWrite = profile?.role === 'owner' || profile?.role === 'office';

  const tabs = useMemo(() => ([
    { key: 'orders' as const, label: `הזמנות (${data?.orders.length ?? 0})` },
    { key: 'invoices' as const, label: `חשבוניות (${data?.invoices.length ?? 0})` },
    { key: 'payments' as const, label: `תשלומים (${data?.payments.length ?? 0})` },
    { key: 'credits' as const, label: `זיכויים (${data?.credits.length ?? 0})` },
  ]), [data]);

  if (loading) return <PageLoader />;
  if (error || !data) return <ErrorNote message={error ?? 'ספק לא נמצא'} />;
  const s = data.supplier;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title flex items-center gap-3">{s.name} <StatusBadge meta={SUPPLIER_STATUS[s.status]} /></h1>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-sm text-slate-500">
            {s.contact_name && <span>{s.contact_name}</span>}
            {s.phone && <span className="flex items-center gap-1"><Phone size={13} /><span dir="ltr">{s.phone}</span></span>}
            {s.email && <span className="flex items-center gap-1"><Mail size={13} /><span dir="ltr">{s.email}</span></span>}
            {s.address && <span className="flex items-center gap-1"><MapPin size={13} />{s.address}</span>}
            {s.cutoff_time && <span className="flex items-center gap-1"><Clock size={13} />סגירת הזמנות {s.cutoff_time.slice(0, 5)}</span>}
          </div>
        </div>
        {canWrite && <button className="btn-secondary" onClick={() => setEditing(true)}>עריכה</button>}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="card card-pad"><div className="text-xs text-slate-500">יתרה פתוחה</div><div className={`text-lg font-bold num text-start ${data.balance > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>{fmtMoneyExact(data.balance)}</div></div>
        <div className="card card-pad"><div className="text-xs text-slate-500">ימי אספקה</div><div className="text-sm font-medium mt-1.5">{fmtDays(s.delivery_days)}</div></div>
        <div className="card card-pad"><div className="text-xs text-slate-500">מינימום הזמנה</div><div className="text-lg font-bold num text-start">{fmtMoney(s.min_order_amount)}</div></div>
        <div className="card card-pad"><div className="text-xs text-slate-500">תנאי תשלום</div><div className="text-sm font-medium mt-1.5">{s.payment_terms ?? '—'}</div></div>
      </div>

      {s.notes && <div className="card card-pad text-sm text-slate-600">{s.notes}</div>}

      <div className="flex gap-1 border-b border-slate-200 no-print overflow-x-auto">
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm whitespace-nowrap border-b-2 -mb-px ${tab === t.key ? 'border-indigo-600 text-indigo-700 font-medium' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'orders' && (
        <DataTable rows={data.orders} columns={[
          { key: 'num', header: 'מס׳', render: (r: PurchaseOrder) => `#${r.number}` },
          { key: 'date', header: 'תאריך', sortValue: (r: PurchaseOrder) => r.created_at, render: (r: PurchaseOrder) => fmtDate(r.created_at) },
          { key: 'expected', header: 'אספקה צפויה', render: (r: PurchaseOrder) => fmtDate(r.expected_date) },
          { key: 'status', header: 'סטטוס', render: (r: PurchaseOrder) => <StatusBadge meta={PO_STATUS[r.status]} /> },
        ]} onRowClick={(r) => navigate(`/orders/${r.id}`)} emptyTitle="אין הזמנות לספק זה" />
      )}
      {tab === 'invoices' && (
        <DataTable rows={data.invoices} columns={[
          { key: 'num', header: 'מס׳ חשבונית', render: (r: Invoice) => r.invoice_number },
          { key: 'date', header: 'תאריך', sortValue: (r: Invoice) => r.invoice_date, render: (r: Invoice) => fmtDate(r.invoice_date) },
          { key: 'total', header: 'סה״כ', className: 'num', sortValue: (r: Invoice) => r.total_amount, render: (r: Invoice) => fmtMoneyExact(r.total_amount) },
          { key: 'review', header: 'בדיקה', render: (r: Invoice) => <StatusBadge meta={INVOICE_REVIEW_STATUS[r.review_status]} /> },
          { key: 'payment', header: 'תשלום', render: (r: Invoice) => <StatusBadge meta={INVOICE_PAYMENT_STATUS[r.payment_status]} /> },
        ]} onRowClick={(r) => navigate(`/invoices/${r.id}`)} emptyTitle="אין חשבוניות לספק זה" />
      )}
      {tab === 'payments' && (
        <DataTable rows={data.payments} columns={[
          { key: 'date', header: 'תאריך', sortValue: (r: Payment) => r.paid_date, render: (r: Payment) => fmtDate(r.paid_date) },
          { key: 'amount', header: 'סכום', className: 'num', sortValue: (r: Payment) => r.amount, render: (r: Payment) => fmtMoneyExact(r.amount) },
          { key: 'method', header: 'אמצעי', render: (r: Payment) => r.method ?? '—' },
          { key: 'ref', header: 'אסמכתא', render: (r: Payment) => <span dir="ltr">{r.reference ?? '—'}</span> },
        ]} emptyTitle="אין תשלומים לספק זה" />
      )}
      {tab === 'credits' && (
        <DataTable rows={data.credits} columns={[
          { key: 'num', header: 'מס׳', render: (r: CreditRequest) => `#${r.number}` },
          { key: 'reason', header: 'סיבה', render: (r: CreditRequest) => CREDIT_REASON[r.reason] },
          { key: 'amount', header: 'סכום', className: 'num', sortValue: (r: CreditRequest) => r.amount, render: (r: CreditRequest) => fmtMoneyExact(r.amount) },
          { key: 'status', header: 'סטטוס', render: (r: CreditRequest) => <StatusBadge meta={CREDIT_STATUS[r.status]} /> },
          { key: 'date', header: 'נפתח', sortValue: (r: CreditRequest) => r.created_at, render: (r: CreditRequest) => fmtDate(r.created_at) },
        ]} onRowClick={() => navigate('/credits')} emptyTitle="אין זיכויים לספק זה" />
      )}

      {editing && <SupplierForm supplier={s} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void refetch(); }} />}
    </div>
  );
}

export function useCategories() {
  return useQuery<Category[]>(async () => unwrap(await supabase.from('categories').select('*').order('sort')));
}
