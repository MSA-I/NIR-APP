import { useMemo, useState } from 'react';
import { toHebrewError } from "../lib/errors";
import { useNavigate, useParams } from 'react-router-dom';
import { useParamState } from '../lib/useParamState';
import { Printer, Send, CheckCircle2, XCircle, PackageCheck, MessageCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { DataTable, StatusBadge, PageLoader, useToast, ConfirmDialog, Modal, ErrorNote, SkeletonTable, type Column } from '../components/ui';
import { PO_STATUS } from '../lib/status';
import { fmtMoneyExact, fmtDate, fmtDateTime } from '../lib/format';
import { logAction } from '../lib/audit';
import type { PurchaseOrder, PurchaseOrderItem, PoStatus } from '../lib/types';

type OrderRow = PurchaseOrder & { supplier: { name: string }; items: { qty: number; unit_price: number }[] };

export function OrdersList() {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useParamState('status', 'open');

  const { data, loading, error } = useQuery(async () =>
    unwrap(await supabase.from('purchase_orders')
      .select('*, supplier:suppliers(name), items:purchase_order_items(qty, unit_price)')
      .order('created_at', { ascending: false })) as Promise<OrderRow[]>);

  const rows = useMemo(() => {
    const all = data ?? [];
    if (statusFilter === 'all') return all;
    if (statusFilter === 'open') return all.filter((o) => !['received', 'cancelled'].includes(o.status));
    return all.filter((o) => o.status === statusFilter);
  }, [data, statusFilter]);

  const orderTotal = (o: OrderRow) => o.items.reduce((s, i) => s + i.qty * i.unit_price, 0);

  const columns: Column<OrderRow>[] = [
    { key: 'num', header: 'מס׳', sortValue: (r) => r.number, render: (r) => <span className="font-medium">#{r.number}</span> },
    { key: 'supplier', header: 'ספק', sortValue: (r) => r.supplier.name, render: (r) => r.supplier.name },
    { key: 'created', header: 'נוצרה', sortValue: (r) => r.created_at, render: (r) => fmtDate(r.created_at) },
    { key: 'expected', header: 'אספקה צפויה', sortValue: (r) => r.expected_date ?? '', render: (r) => fmtDate(r.expected_date) },
    { key: 'items', header: 'פריטים', render: (r) => r.items.length },
    { key: 'total', header: 'סה״כ', className: 'num', sortValue: orderTotal, render: (r) => fmtMoneyExact(orderTotal(r)) },
    { key: 'status', header: 'סטטוס', render: (r) => <StatusBadge meta={PO_STATUS[r.status]} /> },
  ];

  if (loading) return <SkeletonTable cols={6} />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="space-y-4">
      <h1 className="page-title">הזמנות רכש</h1>
      <DataTable rows={rows} columns={columns} searchable
        searchFn={(r, q) => r.supplier.name.toLowerCase().includes(q) || String(r.number).includes(q)}
        onRowClick={(r) => navigate(`/orders/${r.id}`)}
        toolbar={
          <select className="input w-auto!" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="open">הזמנות פתוחות</option>
            <option value="all">הכל</option>
            {Object.entries(PO_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        }
        emptyTitle="אין הזמנות" emptySubtitle="צור הזמנה חדשה ממסך ״הזמנה חדשה״" />
    </div>
  );
}

type FullOrder = PurchaseOrder & {
  supplier: { id: string; name: string; phone: string | null; whatsapp: string | null; email: string | null; min_order_amount: number | null };
  items: (PurchaseOrderItem & { product: { name: string; unit: string } })[];
};

export function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile, org } = useAuth();
  // The order sheet and the WhatsApp message both leave the building — they must carry
  // the buying organization's own name, never the vendor's or another tenant's.
  const orgName = org?.name ?? '';
  const toast = useToast();
  const [confirm, setConfirm] = useState<{ status: PoStatus; label: string } | null>(null);
  const [supplierConfirmOpen, setSupplierConfirmOpen] = useState(false);
  const [confirmNote, setConfirmNote] = useState('');
  const [busy, setBusy] = useState(false);

  const { data: order, loading, error, refetch } = useQuery(async () =>
    unwrap(await supabase.from('purchase_orders')
      .select('*, supplier:suppliers(id, name, phone, whatsapp, email, min_order_amount), items:purchase_order_items(*, product:products(name, unit))')
      .eq('id', id!).single()) as Promise<FullOrder>, [id]);

  const canWrite = profile && ['owner', 'office', 'kitchen'].includes(profile.role);

  async function setStatus(status: PoStatus, reason?: string, extra?: Record<string, unknown>) {
    if (!order) return;
    setBusy(true);
    const patch: Record<string, unknown> = { status, ...extra };
    if (status === 'sent') patch.sent_at = new Date().toISOString();
    const res = await supabase.from('purchase_orders').update(patch).eq('id', order.id);
    setBusy(false);
    setConfirm(null);
    if (res.error) { toast(toHebrewError(res.error.message), 'error'); return; }
    await logAction({ orgId: order.org_id, action: `order_status:${status}`, entityType: 'purchase_orders', entityId: order.id, reason });
    toast('הסטטוס עודכן');
    void refetch();
  }

  /** wa.me deep link with the full order text prefilled (no WhatsApp Business API needed) */
  function whatsAppLink(): string | null {
    if (!order) return null;
    const raw = order.supplier.whatsapp || order.supplier.phone;
    if (!raw) return null;
    let digits = raw.replace(/\D/g, '');
    if (digits.startsWith('0')) digits = '972' + digits.slice(1);
    const total = order.items.reduce((s, i) => s + i.qty * i.unit_price, 0);
    const lines = [
      `הזמנת רכש #${order.number}${orgName ? ` — ${orgName}` : ''}`,
      order.expected_date ? `אספקה מבוקשת: ${fmtDate(order.expected_date)}` : '',
      '',
      ...order.items.map((i) => `• ${i.product.name} — ${i.qty} ${i.product.unit}`),
      '',
      `סה"כ משוער: ${fmtMoneyExact(total)}`,
      order.notes ? `הערות: ${order.notes}` : '',
      'נא לאשר קבלת ההזמנה 🙏',
    ];
    return `https://wa.me/${digits}?text=${encodeURIComponent(lines.join('\n'))}`;
  }

  function sendWhatsApp() {
    const link = whatsAppLink();
    if (!link || !order) return;
    window.open(link, '_blank');
    if (order.status === 'ready' || order.status === 'draft') void setStatus('sent');
    void logAction({ orgId: order.org_id, action: 'order_sent_whatsapp', entityType: 'purchase_orders', entityId: order.id });
  }

  if (loading) return <PageLoader />;
  if (error || !order) return <ErrorNote message={error ?? 'הזמנה לא נמצאה'} />;

  const total = order.items.reduce((s, i) => s + i.qty * i.unit_price, 0);
  const underMin = order.supplier.min_order_amount != null && total < order.supplier.min_order_amount;

  const transitions: { from: PoStatus[]; to: PoStatus; label: string; icon: typeof Send }[] = [
    { from: ['draft'], to: 'ready', label: 'סימון כמוכנה', icon: CheckCircle2 },
    { from: ['ready'], to: 'sent', label: 'סימון כנשלחה לספק', icon: Send },
  ];
  const waLink = whatsAppLink();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 no-print">
        <div>
          <h1 className="page-title flex items-center gap-3">הזמנה #{order.number} <StatusBadge meta={PO_STATUS[order.status]} /></h1>
          <div className="text-sm text-slate-500 mt-1">
            {order.supplier.name} · נוצרה {fmtDateTime(order.created_at)}
            {order.sent_at && <> · נשלחה {fmtDateTime(order.sent_at)}</>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {canWrite && transitions.filter((t) => t.from.includes(order.status)).map((t) => (
            <button key={t.to} className="btn-primary" disabled={busy} onClick={() => void setStatus(t.to)}>
              <t.icon size={15} /> {t.label}
            </button>
          ))}
          {canWrite && waLink && ['draft', 'ready', 'sent'].includes(order.status) && (
            <button className="btn text-white bg-emerald-600 hover:bg-emerald-700" onClick={sendWhatsApp}>
              <MessageCircle size={15} /> שליחה ב-WhatsApp
            </button>
          )}
          {canWrite && order.status === 'sent' && (
            <button className="btn-primary" disabled={busy} onClick={() => setSupplierConfirmOpen(true)}>
              <CheckCircle2 size={15} /> הספק אישר
            </button>
          )}
          {canWrite && ['sent', 'confirmed', 'partial'].includes(order.status) && (
            <button className="btn-primary" onClick={() => navigate(`/receiving/${order.id}`)}><PackageCheck size={15} /> קבלת סחורה</button>
          )}
          <button className="btn-secondary" onClick={() => window.print()}><Printer size={15} /> הדפסה</button>
          {canWrite && !['received', 'cancelled'].includes(order.status) && (
            <button className="btn-ghost text-rose-600" onClick={() => setConfirm({ status: 'cancelled', label: 'ביטול הזמנה' })}><XCircle size={15} /> ביטול</button>
          )}
        </div>
      </div>

      {order.confirmed_at && (
        <div className="no-print rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-4 py-2.5 flex items-center gap-2">
          <CheckCircle2 size={15} />
          הספק אישר את קבלת ההזמנה ב-{fmtDateTime(order.confirmed_at)}
          {order.confirmation_note && <span className="text-emerald-700">· {order.confirmation_note}</span>}
        </div>
      )}

      {underMin && (
        <div className="no-print rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm px-4 py-2.5">
          שים לב: סכום ההזמנה ({fmtMoneyExact(total)}) נמוך ממינימום ההזמנה של הספק ({fmtMoneyExact(order.supplier.min_order_amount!)}).
        </div>
      )}

      {/* Printable order sheet */}
      <div className="card card-pad print-area">
        <div className="hidden print:block mb-4">
          <h2 className="text-xl font-bold">{`הזמנת רכש #${order.number}${orgName ? ` — ${orgName}` : ''}`}</h2>
          <div className="text-sm mt-1">ספק: {order.supplier.name} · תאריך: {fmtDate(order.created_at)} {order.expected_date && `· אספקה מבוקשת: ${fmtDate(order.expected_date)}`}</div>
        </div>
        <table className="w-full">
          <thead className="bg-slate-50 border-b border-slate-100">
            <tr>
              <th className="th">מוצר</th><th className="th">יח׳</th><th className="th">כמות</th>
              <th className="th">מחיר יח׳ (בעת ההזמנה)</th><th className="th">סה״כ</th>
              {order.status !== 'draft' && <th className="th no-print">התקבל</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {order.items.map((i) => (
              <tr key={i.id}>
                <td className="td font-medium text-slate-800">{i.product.name}</td>
                <td className="td">{i.product.unit}</td>
                <td className="td num">{i.qty}</td>
                <td className="td num">₪{i.unit_price.toFixed(2)}</td>
                <td className="td num">{fmtMoneyExact(i.qty * i.unit_price)}</td>
                {order.status !== 'draft' && (
                  <td className="td no-print num">
                    {i.received_qty > 0 ? <span className={i.received_qty >= i.qty ? 'text-emerald-600' : 'text-amber-600'}>{i.received_qty}</span> : '—'}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-200">
              <td className="td font-bold" colSpan={4}>סה״כ להזמנה</td>
              <td className="td num font-bold">{fmtMoneyExact(total)}</td>
              {order.status !== 'draft' && <td className="no-print" />}
            </tr>
          </tfoot>
        </table>
        {order.notes && <div className="mt-3 text-sm text-slate-600">הערות: {order.notes}</div>}
      </div>

      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)}
        onConfirm={(reason) => confirm && void setStatus(confirm.status, reason)}
        title={confirm?.label ?? ''} message="האם לבטל את ההזמנה? הפעולה תתועד ביומן הביקורת." danger requireReason busy={busy} />

      <Modal open={supplierConfirmOpen} onClose={() => setSupplierConfirmOpen(false)} title="אישור קבלת הזמנה ע״י הספק">
        <p className="text-sm text-slate-600 mb-3">מועד האישור והמשתמש המסמן יתועדו במערכת וביומן הביקורת.</p>
        <label className="label">איך התקבל האישור? (לא חובה)</label>
        <input className="input" placeholder='למשל: "אושר ב-WhatsApp ע״י דוד"' value={confirmNote} onChange={(e) => setConfirmNote(e.target.value)} />
        <div className="flex justify-end gap-2 mt-5">
          <button className="btn-secondary" onClick={() => setSupplierConfirmOpen(false)}>ביטול</button>
          <button className="btn-primary" disabled={busy} onClick={() => {
            setSupplierConfirmOpen(false);
            void setStatus('confirmed', confirmNote || undefined, {
              confirmed_at: new Date().toISOString(),
              confirmation_note: confirmNote.trim() || null,
            });
          }}>
            <CheckCircle2 size={15} /> אישור
          </button>
        </div>
      </Modal>
    </div>
  );
}
