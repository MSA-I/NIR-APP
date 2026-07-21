import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Plus, Phone, Mail, MapPin, Clock, Truck, Star, TrendingUp, TrendingDown } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { toHebrewError } from '../lib/errors';
import { useAuth } from '../auth/AuthContext';
import { DataTable, StatusBadge, PageLoader, useToast, Modal, ErrorNote, type Column } from '../components/ui';
import { Scorecard, RatingStars, PriceSparkline, fmtPct, fmtLeadDays, type SupplierMetrics, type ScoreItem, type ScoreTone } from '../components/supplier-metrics';
import { SUPPLIER_STATUS, PO_STATUS, INVOICE_REVIEW_STATUS, INVOICE_PAYMENT_STATUS, CREDIT_STATUS, CREDIT_REASON } from '../lib/status';
import { fmtMoney, fmtMoneyExact, fmtDate, fmtDays } from '../lib/format';
import type { Supplier, Category, PurchaseOrder, Invoice, Payment, CreditRequest, SupplierStatus, SupplierProduct, PriceHistory } from '../lib/types';

// suppliers.rating* are added in migration 0011. The hand-written Supplier type (types.ts) is
// read-only this wave and does not carry them yet, so extend it locally.
type SupplierRow = Supplier & {
  rating: number | null;
  rating_updated_at: string | null;
  rating_note: string | null;
};

type PricedProduct = SupplierProduct & { product: { id: string; name: string; unit: string } };

interface SupplierWithBalance extends SupplierRow {
  open_balance?: number;
  categories?: string[];
  metrics?: SupplierMetrics;
}

// On-time tone: green ≥90 / amber ≥75 / red <75 — but slate below 5 samples. A red tag drawn
// from 3 deliveries is a confident lie; a null pct (no promised dates at all) is slate too.
function otdTone(m: SupplierMetrics | null | undefined): ScoreTone {
  if (!m || m.on_time_pct == null || m.otd_samples < 5) return 'slate';
  if (m.on_time_pct >= 90) return 'green';
  if (m.on_time_pct >= 75) return 'amber';
  return 'red';
}

// The one decision-support column: open exceptions + open credits, empty (calm) when clean.
// Raw utility pills rather than badge-* classes — index.css is mid-rewrite by another agent this
// wave; these are visually identical to the app's soft badges but immune to that churn.
function RiskCell({ m }: { m?: SupplierMetrics }) {
  const ex = m?.open_exceptions ?? 0;
  const cr = m?.open_credits ?? 0;
  if (!ex && !cr) return <span className="text-slate-300">—</span>;
  return (
    <span className="flex items-center gap-1">
      {ex > 0 && <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-rose-100 text-rose-800 whitespace-nowrap">{ex} חריגים</span>}
      {cr > 0 && <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-800 whitespace-nowrap">{cr} זיכויים</span>}
    </span>
  );
}

export function SuppliersList() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const [editing, setEditing] = useState<SupplierRow | null | 'new'>(null);

  const { data, loading, error, refetch } = useQuery(async () => {
    // Same shape as the card query (Promise.all): suppliers + balances + metrics in parallel,
    // merged through Maps. The list answers "who needs my attention"; the card answers "why".
    const [supRes, balRes, metRes] = await Promise.all([
      supabase.from('suppliers').select('*, supplier_categories(category_id, categories(name))').is('deleted_at', null).order('name'),
      supabase.from('supplier_balances').select('*'),
      supabase.from('supplier_metrics').select('*'),
    ]);
    const suppliers = unwrap(supRes) as (SupplierRow & { supplier_categories: { categories: { name: string } }[] })[];
    const balances = unwrap(balRes) as { supplier_id: string; open_balance: number }[];
    const metrics = unwrap(metRes) as SupplierMetrics[];
    const balMap = new Map(balances.map((b) => [b.supplier_id, b.open_balance]));
    const metMap = new Map(metrics.map((m) => [m.supplier_id, m]));
    return suppliers.map((s) => ({
      ...s,
      open_balance: balMap.get(s.id) ?? 0,
      categories: s.supplier_categories?.map((c) => c.categories?.name).filter(Boolean),
      metrics: metMap.get(s.id),
    }));
  });

  const canWrite = profile?.role === 'owner' || profile?.role === 'office';

  const columns: Column<SupplierWithBalance>[] = [
    { key: 'name', header: 'ספק', sortValue: (r) => r.name, render: (r) => <span className="font-medium text-slate-900">{r.name}</span> },
    { key: 'rating', header: 'דירוג', className: 'num', sortValue: (r) => r.rating ?? 0, render: (r) => r.rating != null
        ? <span className="inline-flex items-center gap-1"><Star size={13} className="fill-amber-400 text-amber-400" />{r.rating}</span>
        : <span className="text-slate-300">—</span> },
    { key: 'cats', header: 'קטגוריות', render: (r) => <span className="text-slate-500">{r.categories?.join(', ') || '—'}</span> },
    { key: 'contact', header: 'איש קשר', render: (r) => r.contact_name || '—' },
    { key: 'phone', header: 'טלפון', render: (r) => <span dir="ltr">{r.phone || '—'}</span> },
    { key: 'min', header: 'מינ׳ הזמנה', className: 'num', sortValue: (r) => r.min_order_amount ?? 0, render: (r) => fmtMoney(r.min_order_amount) },
    { key: 'risk', header: 'התראות', render: (r) => <RiskCell m={r.metrics} /> },
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
        searchFn={(r, q) => r.name.toLowerCase().includes(q) || (r.contact_name ?? '').toLowerCase().includes(q) || (r.tax_id ?? '').toLowerCase().includes(q)}
        onRowClick={(r) => navigate(`/suppliers/${r.id}`)} />
      {editing && <SupplierForm supplier={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void refetch(); }} />}
    </div>
  );
}

function SupplierForm({ supplier, onClose, onSaved }: { supplier: SupplierRow | null; onClose: () => void; onSaved: () => void }) {
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
    rating: (supplier?.rating ?? null) as number | null,
    rating_note: supplier?.rating_note ?? '',
  });

  const set = (k: string, v: unknown) => setF((s) => ({ ...s, [k]: v }));

  async function save() {
    if (!f.name.trim()) { toast('שם ספק הוא שדה חובה', 'error'); return; }
    setBusy(true);
    const newRating = f.rating || null; // 0 (cleared) → null; DB checks 1..5
    const ratingChanged = newRating !== (supplier?.rating ?? null);
    const row = {
      org_id: profile!.org_id, name: f.name.trim(), tax_id: f.tax_id || null, contact_name: f.contact_name || null,
      phone: f.phone || null, whatsapp: f.whatsapp || null, email: f.email || null, address: f.address || null,
      min_order_amount: f.min_order_amount ? Number(f.min_order_amount) : null,
      payment_terms: f.payment_terms || null, bank_details: f.bank_details || null, notes: f.notes || null,
      status: f.status, delivery_days: f.delivery_days, cutoff_time: f.cutoff_time || null,
      rating: newRating, rating_note: f.rating_note || null,
      // Timestamp moves only when the rating itself changed — otherwise "עודכן {date}" would lie.
      rating_updated_at: ratingChanged ? new Date().toISOString() : (supplier?.rating_updated_at ?? null),
    };
    const res = supplier
      ? await supabase.from('suppliers').update(row).eq('id', supplier.id)
      : await supabase.from('suppliers').insert(row);
    setBusy(false);
    if (res.error) { toast(toHebrewError(res.error.message), 'error'); return; }
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
        <div>
          <label className="label">דירוג ספק</label>
          <div className="pt-1"><RatingStars value={f.rating} onChange={(n) => set('rating', n || null)} /></div>
        </div>
        <div className="sm:col-span-2"><label className="label">הערת דירוג</label><input className="input" placeholder="למה הדירוג הזה?" value={f.rating_note} onChange={(e) => set('rating_note', e.target.value)} /></div>
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
  const [tab, setTab] = useState<'orders' | 'invoices' | 'payments' | 'credits' | 'prices'>('orders');
  const [editing, setEditing] = useState(false);

  const { data, loading, error, refetch } = useQuery(async () => {
    const supplier = unwrap(await supabase.from('suppliers').select('*').eq('id', id!).single()) as SupplierRow;
    const [orders, invoices, payments, credits, balance, metrics, sps] = await Promise.all([
      supabase.from('purchase_orders').select('*').eq('supplier_id', id!).order('created_at', { ascending: false }).limit(50),
      supabase.from('invoices').select('*').eq('supplier_id', id!).is('deleted_at', null).order('invoice_date', { ascending: false }).limit(50),
      supabase.from('payments').select('*').eq('supplier_id', id!).order('paid_date', { ascending: false }).limit(50),
      supabase.from('credit_requests').select('*').eq('supplier_id', id!).order('created_at', { ascending: false }).limit(50),
      supabase.from('supplier_balances').select('*').eq('supplier_id', id!).single(),
      supabase.from('supplier_metrics').select('*').eq('supplier_id', id!).maybeSingle(), // maybeSingle: a role-guarded view may return no row
      supabase.from('supplier_products').select('*, product:products(id,name,unit)').eq('supplier_id', id!).order('updated_at', { ascending: false }),
    ]);
    const prices = unwrap(sps) as PricedProduct[];
    const spIds = prices.map((p) => p.id);
    const history = spIds.length
      ? unwrap(await supabase.from('price_history').select('*').in('supplier_product_id', spIds).order('effective_date', { ascending: true })) as PriceHistory[]
      : [];
    return {
      supplier,
      orders: unwrap(orders) as PurchaseOrder[],
      invoices: unwrap(invoices) as Invoice[],
      payments: unwrap(payments) as Payment[],
      credits: unwrap(credits) as CreditRequest[],
      balance: (balance.data as { open_balance: number } | null)?.open_balance ?? 0,
      metrics: (metrics.data as SupplierMetrics | null) ?? null,
      prices,
      history,
    };
  }, [id]);

  const canWrite = profile?.role === 'owner' || profile?.role === 'office';

  const tabs = useMemo(() => ([
    { key: 'orders' as const, label: `הזמנות (${data?.orders.length ?? 0})` },
    { key: 'invoices' as const, label: `חשבוניות (${data?.invoices.length ?? 0})` },
    { key: 'payments' as const, label: `תשלומים (${data?.payments.length ?? 0})` },
    { key: 'credits' as const, label: `זיכויים (${data?.credits.length ?? 0})` },
    { key: 'prices' as const, label: `מחירים (${data?.prices.length ?? 0})` },
  ]), [data]);

  if (loading) return <PageLoader />;
  if (error || !data) return <ErrorNote message={error ?? 'ספק לא נמצא'} />;
  const s = data.supplier;
  const m = data.metrics;

  // One card, one grid — the spec sheet (§4.4). Balance + honest metrics; OTD renders — (never
  // 0%) when no promised delivery date was ever recorded (open decision #28, not yet answered).
  const scoreItems: ScoreItem[] = [
    { label: 'יתרה פתוחה', value: fmtMoneyExact(data.balance), tone: data.balance > 0 ? 'amber' : 'green' },
    {
      label: 'עמידה בזמנים',
      value: m && m.otd_samples > 0 ? fmtPct(m.on_time_pct) : '—',
      sub: m && m.otd_samples > 0 ? `${m.otd_samples} אספקות` : 'אין תאריך אספקה מוזן',
      tone: otdTone(m),
    },
    { label: 'זמן אספקה ממוצע', value: fmtLeadDays(m?.avg_lead_days ?? null), sub: 'מהשליחה ועד קבלה', tone: 'slate' },
    { label: 'חריגים פתוחים', value: String(m?.open_exceptions ?? 0), sub: `${m?.exceptions_lifetime ?? 0} בסה״כ`, tone: (m?.open_exceptions ?? 0) > 0 ? 'red' : 'slate' },
    { label: 'זיכויים פתוחים', value: String(m?.open_credits ?? 0), sub: fmtMoney(m?.open_credits_amount ?? 0), tone: (m?.open_credits ?? 0) > 0 ? 'amber' : 'slate' },
    { label: 'שינויי מחיר (180 יום)', value: String(m?.price_changes_window ?? 0), sub: `${m?.priced_items ?? 0} פריטים`, tone: 'slate' },
    { label: 'מינימום הזמנה', value: fmtMoney(s.min_order_amount), tone: 'slate' },
    { label: 'תנאי תשלום', value: s.payment_terms ?? '—', tone: 'slate', numeric: false },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title flex flex-wrap items-center gap-x-3 gap-y-1">
            {s.name}
            <StatusBadge meta={SUPPLIER_STATUS[s.status]} />
            <span className="inline-flex items-center gap-2">
              <RatingStars value={s.rating} />
              {s.rating != null && s.rating_updated_at && (
                <span className="text-xs font-normal text-slate-400" title={s.rating_note ?? undefined}>עודכן {fmtDate(s.rating_updated_at)}</span>
              )}
            </span>
          </h1>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-sm text-slate-500">
            {s.contact_name && <span>{s.contact_name}</span>}
            {s.phone && <span className="flex items-center gap-1"><Phone size={13} /><span dir="ltr">{s.phone}</span></span>}
            {s.email && <span className="flex items-center gap-1"><Mail size={13} /><span dir="ltr">{s.email}</span></span>}
            {s.address && <span className="flex items-center gap-1"><MapPin size={13} />{s.address}</span>}
            {s.delivery_days.length > 0 && <span className="flex items-center gap-1"><Truck size={13} />ימי אספקה {fmtDays(s.delivery_days)}</span>}
            {s.cutoff_time && <span className="flex items-center gap-1"><Clock size={13} />סגירת הזמנות {s.cutoff_time.slice(0, 5)}</span>}
          </div>
        </div>
        {canWrite && <button className="btn-secondary" onClick={() => setEditing(true)}>עריכה</button>}
      </div>

      <Scorecard items={scoreItems} />

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
      {tab === 'prices' && <SupplierPricesTab rows={data.prices} history={data.history} />}

      {editing && <SupplierForm supplier={s} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void refetch(); }} />}
    </div>
  );
}

/**
 * Price trend for one supplier. Kept local to this file — it is not used anywhere else, and a
 * similarly-named src/pages/SupplierPrices.tsx is the supplier AGENT portal (/my-prices), which
 * must not be confused with it.
 */
function SupplierPricesTab({ rows, history }: { rows: PricedProduct[]; history: PriceHistory[] }) {
  const histBySp = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const h of history) {
      const arr = map.get(h.supplier_product_id) ?? [];
      arr.push(h.price);
      map.set(h.supplier_product_id, arr);
    }
    return map;
  }, [history]);

  const changePct = (r: PricedProduct) => r.previous_price ? ((r.current_price - r.previous_price) / r.previous_price) * 100 : 0;

  // The actual decision answer, computed client-side: how many rose / fell, and the median move.
  const summary = useMemo(() => {
    let up = 0, down = 0;
    const pcts: number[] = [];
    for (const r of rows) {
      if (r.previous_price == null) continue;
      const pct = changePct(r);
      if (pct > 0) up++; else if (pct < 0) down++;
      pcts.push(pct);
    }
    pcts.sort((a, b) => a - b);
    const median = pcts.length ? pcts[Math.floor((pcts.length - 1) / 2)] : null;
    return { up, down, median };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const columns: Column<PricedProduct>[] = [
    { key: 'product', header: 'מוצר', sortValue: (r) => r.product.name, render: (r) => <span className="font-medium text-slate-900">{r.product.name}</span> },
    { key: 'price', header: 'מחיר נוכחי', className: 'num', sortValue: (r) => r.current_price, render: (r) => <span className="font-semibold">₪{r.current_price.toFixed(2)}</span> },
    { key: 'prev', header: 'מחיר קודם', className: 'num', render: (r) => (r.previous_price != null ? `₪${r.previous_price.toFixed(2)}` : '—') },
    {
      key: 'change', header: 'שינוי', sortValue: changePct,
      render: (r) => {
        const pct = changePct(r);
        if (!r.previous_price || pct === 0) return <span className="text-slate-400">—</span>;
        // Same treatment as PriceLists.tsx:50-56 (LRM keeps the sign on the correct side in RTL).
        return pct > 0
          ? <span className="inline-flex items-center gap-1 text-rose-600 font-medium"><TrendingUp size={14} />{'‎'}+{pct.toFixed(1)}%</span>
          : <span className="inline-flex items-center gap-1 text-emerald-600 font-medium"><TrendingDown size={14} />{'‎'}{pct.toFixed(1)}%</span>;
      },
    },
    {
      key: 'trend', header: 'מגמה',
      render: (r) => {
        const pts = histBySp.get(r.id) ?? [];
        return pts.length >= 2 ? <PriceSparkline points={pts} /> : <span className="text-slate-300">—</span>;
      },
    },
    { key: 'date', header: 'בתוקף מ־', sortValue: (r) => r.price_effective_date, render: (r) => fmtDate(r.price_effective_date) },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-4 text-sm">
        <span className="text-slate-600">התייקרו: <b className="text-rose-600">{summary.up}</b></span>
        <span className="text-slate-600">הוזלו: <b className="text-emerald-600">{summary.down}</b></span>
        <span className="text-slate-600">שינוי חציוני: <b className="num">{summary.median == null ? '—' : `${summary.median > 0 ? '+' : ''}${summary.median.toFixed(1)}%`}</b></span>
      </div>
      <DataTable rows={rows} columns={columns} searchable
        searchFn={(r, q) => r.product.name.toLowerCase().includes(q)}
        emptyTitle="אין מחירון לספק זה" />
    </div>
  );
}

export function useCategories() {
  return useQuery<Category[]>(async () => unwrap(await supabase.from('categories').select('*').order('sort')));
}
