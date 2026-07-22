import { useEffect, useMemo, useRef, useState } from 'react';
import { toHebrewError } from "../lib/errors";
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useParamState } from '../lib/useParamState';
import { Printer, Send, CheckCircle2, XCircle, PackageCheck, MessageCircle, Pencil, Copy, Plus } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { DataTable, StatusBadge, PageLoader, useToast, ConfirmDialog, Modal, ErrorNote, SkeletonTable, Note, type Column } from '../components/ui';
import { PO_STATUS } from '../lib/status';
import { fmtMoneyExact, fmtDate, fmtDateTime, todayISO } from '../lib/format';
import { logAction } from '../lib/audit';
import { sendOrderWhatsApp, orderWhatsAppLink } from '../lib/share';
import { cancelOrderDraft } from '../lib/orderDrafts';
import type { PurchaseOrder, PurchaseOrderItem, PoStatus } from '../lib/types';

type OrderRow = PurchaseOrder & {
  supplier: { name: string; phone: string | null; whatsapp: string | null };
  items: { qty: number; unit_price: number; product: { name: string; unit: string } }[];
};

type DraftListRow = {
  id: string;
  number: number;
  updated_at: string;
  notes: string | null;
  editor_step: number;
  items: { qty: number; unit_price: number | null; product: { name: string } }[];
};

export function OrdersList() {
  const navigate = useNavigate();
  const { profile, org } = useAuth();
  const toast = useToast();
  const [statusFilter, setStatusFilter] = useParamState('status', 'open');
  const [cancelTarget, setCancelTarget] = useState<OrderRow | null>(null);
  const [draftCancelTarget, setDraftCancelTarget] = useState<DraftListRow | null>(null);
  const [busy, setBusy] = useState(false);
  const canWrite = !!profile && ['owner', 'office', 'kitchen'].includes(profile.role);

  const { data, loading, error, refetch } = useQuery(async () => {
    const [orders, drafts] = await Promise.all([
      supabase.from('purchase_orders')
        .select('*, supplier:suppliers(name, phone, whatsapp), items:purchase_order_items(qty, unit_price, product:products(name, unit))')
        .order('created_at', { ascending: false }),
      canWrite
        ? supabase.from('purchase_requests')
          .select('id, number, updated_at, notes, editor_step, items:purchase_request_items(qty, unit_price, product:products(name))')
          .eq('status', 'draft').eq('created_by', profile!.id).order('updated_at', { ascending: false })
        : Promise.resolve({ data: [], error: null }),
    ]);
    return { orders: unwrap(orders) as OrderRow[], drafts: unwrap(drafts) as DraftListRow[] };
  }, [profile?.id]);

  const rows = useMemo(() => {
    const all = data?.orders ?? [];
    if (statusFilter === 'all') return all;
    if (statusFilter === 'open') return all.filter((o) => !['received', 'cancelled'].includes(o.status));
    return all.filter((o) => o.status === statusFilter);
  }, [data, statusFilter]);

  const orderTotal = (o: OrderRow) => o.items.reduce((s, i) => s + i.qty * i.unit_price, 0);

  // Mirrors OrderDetail's cancel flow: status → cancelled, reason recorded in audit_logs.
  async function cancelOrder(reason?: string) {
    if (!cancelTarget) return;
    setBusy(true);
    const res = await supabase.from('purchase_orders').update({ status: 'cancelled' }).eq('id', cancelTarget.id);
    setBusy(false);
    if (res.error) { setCancelTarget(null); toast(toHebrewError(res.error.message), 'error'); return; }
    await logAction({ orgId: cancelTarget.org_id, action: 'order_status:cancelled', entityType: 'purchase_orders', entityId: cancelTarget.id, reason });
    setCancelTarget(null);
    toast('ההזמנה בוטלה');
    void refetch();
  }

  async function sendWhatsApp(r: OrderRow) {
    const res = await sendOrderWhatsApp(r, org?.name ?? '');
    if (res.error) { toast(res.error, 'error'); return; }
    if (res.statusChanged) { toast('הסטטוס עודכן'); void refetch(); }
  }

  async function cancelDraft(reason?: string) {
    if (!draftCancelTarget) return;
    setBusy(true);
    try {
      await cancelOrderDraft(draftCancelTarget.id, reason ?? 'ביטול טיוטה');
      toast('הטיוטה בוטלה');
      setDraftCancelTarget(null);
      void refetch();
    } catch (failure) {
      toast(toHebrewError(failure), 'error');
    } finally {
      setBusy(false);
    }
  }

  const draftTotal = (draft: DraftListRow) => draft.items.length && draft.items.every((item) => item.unit_price != null)
    ? draft.items.reduce((sum, item) => sum + item.qty * item.unit_price!, 0)
    : null;

  const columns: Column<OrderRow>[] = [
    { key: 'num', header: 'מס׳', priority: 3, sortValue: (r) => r.number, render: (r) => <span className="font-medium">#{r.number}</span> },
    { key: 'supplier', header: 'ספק', priority: 3, sortValue: (r) => r.supplier.name, render: (r) => r.supplier.name },
    { key: 'created', header: 'נוצרה', sortValue: (r) => r.created_at, render: (r) => fmtDate(r.created_at) },
    { key: 'expected', header: 'אספקה', sortValue: (r) => r.expected_date ?? '', render: (r) => fmtDate(r.expected_date) },
    { key: 'items', header: 'פריטים', priority: 3, render: (r) => r.items.length },
    { key: 'total', header: 'סה״כ', className: 'num', mobileLabel: null, sortValue: orderTotal, render: (r) => fmtMoneyExact(orderTotal(r)) },
    { key: 'status', header: 'סטטוס', priority: 3, render: (r) => <StatusBadge meta={PO_STATUS[r.status]} /> },
  ];

  if (loading) return <SkeletonTable cols={6} />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="page-title">הזמנות רכש</h1>
        {canWrite && <button type="button" className="btn-primary" onClick={() => navigate('/orders/new?fresh=1')}><Plus size={15} /> טיוטה חדשה</button>}
      </div>

      {canWrite && (
        <section aria-labelledby="my-drafts-title" className="border-y border-line-strong bg-surface">
          <div className="flex items-center justify-between gap-2 border-b border-line-soft px-3 py-3 sm:px-4">
            <div><h2 id="my-drafts-title" className="section-title">הטיוטות שלי</h2><p className="mt-0.5 text-xs text-ink-muted">המשך בדיוק מהמקום שבו הפסקת</p></div>
            <span className="badge badge-idle num">{data?.drafts.length ?? 0}</span>
          </div>
          {data?.drafts.length ? (
            <div className="divide-y divide-line-soft">
              {data.drafts.map((draft) => (
                <div key={draft.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-3 sm:px-4">
                  <div className="min-w-0">
                    <div className="font-medium text-ink-body">טיוטה #{draft.number}</div>
                    <div className="text-xs text-ink-muted">עודכנה {fmtDateTime(draft.updated_at)} · <span className="num">{draft.items.length}</span> מוצרים · {fmtMoneyExact(draftTotal(draft))}</div>
                  </div>
                  <div className="ms-auto flex gap-2">
                    <button type="button" className="btn-secondary" onClick={() => navigate(`/orders/new?draft=${draft.id}`)}>המשך עריכה</button>
                    <button type="button" className="btn-ghost text-alert-solid" onClick={() => setDraftCancelTarget(draft)}>ביטול</button>
                  </div>
                </div>
              ))}
            </div>
          ) : <div className="px-4 py-6 text-sm text-ink-muted">אין טיוטות פעילות.</div>}
        </section>
      )}

      <DataTable rows={rows} columns={columns} searchable
        searchFn={(r, q) => r.supplier.name.toLowerCase().includes(q) || String(r.number).includes(q)}
        onRowClick={(r) => navigate(`/orders/${r.id}`)}
        mobile="cards"
        mobileTitle={(r) => <>#{r.number} · {r.supplier.name}</>}
        mobileTrailing={(r) => <StatusBadge meta={PO_STATUS[r.status]} />}
        rowActions={(r) => [
          { key: 'edit', label: 'עריכה', icon: Pencil, hidden: !canWrite, onSelect: () => navigate(`/orders/${r.id}`) },
          { key: 'duplicate', label: 'שכפול', icon: Copy, hidden: !canWrite, onSelect: () => navigate(`/orders/new?from=${r.id}`) },
          {
            key: 'whatsapp', label: 'שליחה בוואטסאפ', icon: MessageCircle,
            hidden: !canWrite || !(r.supplier.whatsapp || r.supplier.phone) || !['draft', 'ready', 'sent'].includes(r.status),
            onSelect: () => void sendWhatsApp(r),
          },
          { key: 'print', label: 'הדפסה', icon: Printer, onSelect: () => navigate(`/orders/${r.id}?print=1`) },
          {
            key: 'cancel', label: 'ביטול', icon: XCircle, tone: 'danger',
            hidden: !canWrite || ['received', 'cancelled'].includes(r.status),
            onSelect: () => setCancelTarget(r),
          },
        ]}
        toolbar={
          <select className="input w-auto!" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="open">הזמנות פתוחות</option>
            <option value="all">הכל</option>
            {Object.entries(PO_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        }
        emptyTitle="אין הזמנות" emptySubtitle="צור הזמנה חדשה ממסך ״הזמנה חדשה״" />

      <ConfirmDialog open={!!cancelTarget} onClose={() => setCancelTarget(null)}
        onConfirm={(reason) => void cancelOrder(reason)}
        title="ביטול הזמנה" message="האם לבטל את ההזמנה? הפעולה תתועד ביומן הביקורת."
        danger requireReason busy={busy} />
      <ConfirmDialog open={!!draftCancelTarget} onClose={() => setDraftCancelTarget(null)}
        onConfirm={(reason) => void cancelDraft(reason)}
        title="ביטול טיוטה" message="הטיוטה תבוטל ולא תופיע עוד להמשך. הפעולה תתועד ביומן הביקורת."
        confirmLabel="ביטול הטיוטה" danger requireReason busy={busy} />
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
  const [confirmExpected, setConfirmExpected] = useState('');  // optional: set/correct אספקה מבוקשת at confirmation
  const [busy, setBusy] = useState(false);
  const [params, setParams] = useSearchParams();
  const printedRef = useRef(false);

  const { data: order, loading, error, refetch } = useQuery(async () =>
    unwrap(await supabase.from('purchase_orders')
      .select('*, supplier:suppliers(id, name, phone, whatsapp, email, min_order_amount), items:purchase_order_items(*, product:products(name, unit))')
      .eq('id', id!).single()) as Promise<FullOrder>, [id]);

  // ?print=1 (Orders list "הדפסה" action): print once when the data is on screen, then strip
  // the param so refresh/back does not re-open the dialog.
  useEffect(() => {
    if (printedRef.current || params.get('print') !== '1' || !order) return;
    printedRef.current = true;
    window.print();
    const next = new URLSearchParams(params);
    next.delete('print');
    setParams(next, { replace: true });
  }, [params, order, setParams]);

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

  // The WhatsApp order-send flow (link building, wa.me open, mark-as-sent, audit log) lives in
  // lib/share.ts and is shared with the Orders list row actions.
  async function sendWhatsApp() {
    if (!order) return;
    const res = await sendOrderWhatsApp(order, orgName);
    if (res.error) { toast(res.error, 'error'); return; }
    if (res.statusChanged) { toast('הסטטוס עודכן'); void refetch(); }
  }

  if (loading) return <PageLoader />;
  if (error || !order) return <ErrorNote message={error ?? 'הזמנה לא נמצאה'} />;

  const total = order.items.reduce((s, i) => s + i.qty * i.unit_price, 0);
  const underMin = order.supplier.min_order_amount != null && total < order.supplier.min_order_amount;

  const transitions: { from: PoStatus[]; to: PoStatus; label: string; icon: typeof Send }[] = [
    { from: ['draft'], to: 'ready', label: 'סימון כמוכנה', icon: CheckCircle2 },
    { from: ['ready'], to: 'sent', label: 'סימון כנשלחה לספק', icon: Send },
  ];
  const waLink = orderWhatsAppLink(order, orgName);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 no-print">
        <div>
          <h1 className="page-title flex items-center gap-3">הזמנה #{order.number} <StatusBadge meta={PO_STATUS[order.status]} /></h1>
          <div className="text-sm text-ink-muted mt-1">
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
            <button className="btn text-white bg-done-solid hover:bg-done-on-soft" onClick={() => void sendWhatsApp()}>
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
            <button className="btn-ghost text-alert-solid" onClick={() => setConfirm({ status: 'cancelled', label: 'ביטול הזמנה' })}><XCircle size={15} /> ביטול</button>
          )}
        </div>
      </div>

      {order.confirmed_at && (
        <Note tone="done" className="no-print">
          <CheckCircle2 size={15} className="mt-0.5 shrink-0" />
          <span>
            הספק אישר את קבלת ההזמנה ב-{fmtDateTime(order.confirmed_at)}
            {order.confirmation_note && <span className="text-done-fg"> · {order.confirmation_note}</span>}
          </span>
        </Note>
      )}

      {underMin && (
        <Note tone="await" className="no-print">
          שים לב: סכום ההזמנה ({fmtMoneyExact(total)}) נמוך ממינימום ההזמנה של הספק ({fmtMoneyExact(order.supplier.min_order_amount!)}).
        </Note>
      )}

      {/* Printable order sheet */}
      <div className="card card-pad print-area">
        <div className="hidden print:block mb-4">
          <h2 className="text-xl font-bold">{`הזמנת רכש #${order.number}${orgName ? ` — ${orgName}` : ''}`}</h2>
          <div className="text-sm mt-1">ספק: {order.supplier.name} · תאריך: {fmtDate(order.created_at)} {order.expected_date && `· אספקה מבוקשת: ${fmtDate(order.expected_date)}`}</div>
        </div>
        <div className="overflow-x-auto print:overflow-visible">
        <table className="w-full">
          <thead className="bg-surface-sunken border-b border-line-soft">
            <tr>
              <th className="th">מוצר</th><th className="th">יח׳</th><th className="th">כמות</th>
              <th className="th">מחיר יח׳ (בעת ההזמנה)</th><th className="th">סה״כ</th>
              {order.status !== 'draft' && <th className="th no-print">התקבל</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {order.items.map((i) => (
              <tr key={i.id}>
                <td className="td font-medium text-ink-body">{i.product.name}</td>
                <td className="td">{i.product.unit}</td>
                <td className="td num">{i.qty}</td>
                <td className="td num">₪{i.unit_price.toFixed(2)}</td>
                <td className="td num">{fmtMoneyExact(i.qty * i.unit_price)}</td>
                {order.status !== 'draft' && (
                  <td className="td no-print num">
                    {i.received_qty > 0 ? <span className={i.received_qty >= i.qty ? 'text-done-fg' : 'text-await-fg'}>{i.received_qty}</span> : '—'}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-line">
              <td className="td font-bold" colSpan={4}>סה״כ להזמנה</td>
              <td className="td num font-bold">{fmtMoneyExact(total)}</td>
              {order.status !== 'draft' && <td className="no-print" />}
            </tr>
          </tfoot>
        </table>
        </div>
        {order.notes && <div className="mt-3 text-sm text-ink-soft">הערות: {order.notes}</div>}
      </div>

      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)}
        onConfirm={(reason) => confirm && void setStatus(confirm.status, reason)}
        title={confirm?.label ?? ''} message="האם לבטל את ההזמנה? הפעולה תתועד ביומן הביקורת." danger requireReason busy={busy} />

      <Modal open={supplierConfirmOpen} onClose={() => setSupplierConfirmOpen(false)} title="אישור קבלת הזמנה ע״י הספק">
        <p className="text-sm text-ink-soft mb-3">מועד האישור והמשתמש המסמן יתועדו במערכת וביומן הביקורת.</p>
        <label className="label">איך התקבל האישור? (לא חובה)</label>
        <input className="input" placeholder='למשל: "אושר ב-WhatsApp ע״י דוד"' value={confirmNote} onChange={(e) => setConfirmNote(e.target.value)} />
        <label className="label mt-3">אספקה מבוקשת (לא חובה — לעדכון תאריך היעד)</label>
        <input type="date" className="input" min={todayISO()} value={confirmExpected} onChange={(e) => setConfirmExpected(e.target.value)} />
        <div className="flex justify-end gap-2 mt-5">
          <button className="btn-secondary" onClick={() => setSupplierConfirmOpen(false)}>ביטול</button>
          <button className="btn-primary" disabled={busy} onClick={() => {
            setSupplierConfirmOpen(false);
            void setStatus('confirmed', confirmNote || undefined, {
              confirmed_at: new Date().toISOString(),
              confirmation_note: confirmNote.trim() || null,
              ...(confirmExpected ? { expected_date: confirmExpected } : {}),
            });
          }}>
            <CheckCircle2 size={15} /> אישור
          </button>
        </div>
      </Modal>
    </div>
  );
}
