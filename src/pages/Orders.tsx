import { useEffect, useMemo, useRef, useState } from 'react';
import { toHebrewError } from "../lib/errors";
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useParamState } from '../lib/useParamState';
import { FileDown, Loader2, Printer, Send, CheckCircle2, XCircle, PackageCheck, MessageCircle, Pencil, Copy, Plus, FileText } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { Breadcrumbs, DataTable, StatusBadge, useToast, ConfirmDialog, LifecycleStrip, Modal, ErrorNote, PageHeader, RecordHeader, RecordSkeleton, SkeletonTable, Note, EmptyState, Card, ICON, type Column } from '../components/ui';
import { PO_STATUS } from '../lib/status';
import { fmtMoneyExact, fmtDate, fmtDateTime, formatQuantity, formatUnit, productLabel, todayISO } from '../lib/format';
import { orderWhatsAppLink, markOrderSentToSupplier, needsSentConfirmation } from '../lib/share';
import { downloadElementPdf } from '../lib/pdf';
import { useExportWatermark } from '../lib/exportBranding';
import { WhatsAppSendDialog } from '../components/WhatsAppSendDialog';
import { SupplierPortalCard } from '../components/SupplierPortalCard';
import { EmailOrderCard } from '../components/EmailOrderCard';
import { cancelOrderDraft } from '../lib/orderDrafts';
import type { PurchaseOrder, PurchaseOrderItem, PoStatus } from '../lib/types';

/**
 * The list row. Its items are never rendered here — they feed the line total and the WhatsApp
 * payload — so this shape deliberately carries the raw name only. The supplier reads their own
 * wording; see `productLabel` in lib/format.ts for the whole rule.
 */
type OrderRow = PurchaseOrder & {
  supplier: { name: string; phone: string | null; whatsapp: string | null };
  items: { qty: number; unit_price: number; product: { name: string; unit: string; sku: string | null } }[];
};

type DraftListRow = {
  id: string;
  number: number;
  updated_at: string;
  notes: string | null;
  editor_step: number;
  items: { qty: number; unit_price: number | null; product: { name: string } }[];
};

export type OrderPrimaryActionKey = 'ready' | 'sent' | 'whatsapp' | 'confirm' | 'receive';

export function orderPrimaryAction(status: PoStatus, hasWhatsApp: boolean): OrderPrimaryActionKey | null {
  if (status === 'draft') return 'ready';
  if (status === 'ready') return hasWhatsApp ? 'whatsapp' : 'sent';
  if (status === 'sent') return 'confirm';
  if (status === 'confirmed' || status === 'partial') return 'receive';
  return null;
}

export function orderLifecycle(status: PoStatus, wasSent: boolean, wasConfirmed: boolean) {
  return [
    ...(status === 'draft' ? [{ key: 'draft', label: 'טיוטה' }] : []),
    ...(status === 'ready' ? [{ key: 'ready', label: 'מוכנה לשליחה לספק' }] : []),
    ...(wasSent || status === 'sent' ? [{ key: 'sent', label: 'נשלחה לספק' }] : []),
    ...(wasConfirmed || status === 'confirmed' || status === 'partial' ? [{ key: 'confirmed', label: 'אושרה' }] : []),
    ...(status === 'partial' ? [{ key: 'partial', label: 'התקבלה חלקית' }] : []),
    ...(status === 'received' ? [{ key: 'received', label: 'התקבלה' }] : []),
  ];
}

export function OrdersList() {
  const navigate = useNavigate();
  const { profile, org, organizationAccess } = useAuth();
  const toast = useToast();
  const [statusFilter, setStatusFilter] = useParamState('status', 'open');
  const [cancelTarget, setCancelTarget] = useState<OrderRow | null>(null);
  const [draftCancelTarget, setDraftCancelTarget] = useState<DraftListRow | null>(null);
  const [sentConfirmTarget, setSentConfirmTarget] = useState<OrderRow | null>(null);
  const [waTarget, setWaTarget] = useState<OrderRow | null>(null);
  const [busy, setBusy] = useState(false);
  const canWrite = organizationAccess.canWrite && !!profile && ['owner', 'office'].includes(profile.role);

  const { data, loading, error, refetch } = useQuery(async () => {
    const [orders, drafts] = await Promise.all([
      supabase.from('purchase_orders')
        .select('*, supplier:suppliers(name, phone, whatsapp), items:purchase_order_items(qty, unit_price, product:products(name, unit, sku))')
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
    const res = await supabase.rpc('cancel_purchase_order', {
      p_purchase_order_id: cancelTarget.id,
      p_reason: reason ?? null,
    });
    setBusy(false);
    if (res.error) { setCancelTarget(null); toast(toHebrewError(res.error.message), 'error'); return; }
    setCancelTarget(null);
    toast('ההזמנה בוטלה');
    void refetch();
  }

  function sendWhatsApp(r: OrderRow) {
    setWaTarget(r); // the two-step dialog (text + image); confirmation follows on close
  }

  async function confirmSent() {
    if (!sentConfirmTarget) return;
    setBusy(true);
    const res = await markOrderSentToSupplier(sentConfirmTarget.id);
    setBusy(false);
    setSentConfirmTarget(null);
    if (res.error) { toast(res.error, 'error'); return; }
    toast('ההזמנה סומנה כנשלחה לספק');
    void refetch();
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
    { key: 'num', header: 'מס׳', priority: 3, className: 'num', sortValue: (r) => r.number, render: (r) => <span className="font-medium">#{r.number}</span> },
    { key: 'supplier', header: 'ספק', priority: 3, sortValue: (r) => r.supplier.name, render: (r) => r.supplier.name },
    { key: 'created', header: 'נוצרה', sortValue: (r) => r.created_at, render: (r) => fmtDate(r.created_at) },
    { key: 'expected', header: 'אספקה', sortValue: (r) => r.expected_date ?? '', render: (r) => fmtDate(r.expected_date) },
    { key: 'items', header: 'פריטים', priority: 3, className: 'num', render: (r) => r.items.length },
    { key: 'total', header: 'סה״כ', className: 'num', mobileLabel: null, sortValue: orderTotal, render: (r) => fmtMoneyExact(orderTotal(r)) },
    { key: 'status', header: 'סטטוס', priority: 3, render: (r) => <StatusBadge meta={PO_STATUS[r.status]} /> },
  ];

  if (loading) return <SkeletonTable cols={6} />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="space-y-4">
      <PageHeader title="הזמנות רכש"
        meta={`${rows.length} הזמנות בתצוגה · ${data?.orders.length ?? 0} בסך הכול`}
        actions={canWrite && <button type="button" className="btn-primary" onClick={() => navigate('/orders/new?fresh=1')}><Plus size={ICON.sm} aria-hidden="true" /> טיוטה חדשה</button>} />

      {canWrite && !!data?.drafts.length && (
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
                    <div className="font-medium text-ink-body">טיוטה <span className="num">#{draft.number}</span></div>
                    <div className="text-xs text-ink-muted">עודכנה {fmtDateTime(draft.updated_at)} · <span className="num">{draft.items.length}</span> מוצרים · {fmtMoneyExact(draftTotal(draft))}</div>
                  </div>
                  <div className="ms-auto flex gap-2">
                    <button type="button" className="btn-secondary" onClick={() => navigate(`/orders/new?draft=${draft.id}`)}>המשך עריכה</button>
                    <button type="button" className="btn-danger" onClick={() => setDraftCancelTarget(draft)}>ביטול</button>
                  </div>
                </div>
              ))}
            </div>
          ) : <EmptyState title="אין טיוטות פעילות" subtitle="טיוטה שתתחיל ולא תסיים תחכה לך כאן." icon={<FileText size={ICON.hero} />} />}
        </section>
      )}

      <DataTable rows={rows} columns={columns} searchable
        searchFn={(r, q) => r.supplier.name.toLowerCase().includes(q) || String(r.number).includes(q)}
        searchLabel="חיפוש בהזמנות רכש"
        rowLabel={(r) => `הזמנת רכש מספר ${r.number} עבור ${r.supplier.name}`}
        onRowClick={(r) => navigate(`/orders/${r.id}`)}
        mobile="cards"
        mobileTitle={(r) => <><span className="num">#{r.number}</span> · {r.supplier.name}</>}
        mobileTrailing={(r) => <StatusBadge meta={PO_STATUS[r.status]} />}
        rowActions={(r) => [
          { key: 'edit', label: 'עריכה', icon: Pencil, hidden: !canWrite, onSelect: () => navigate(`/orders/${r.id}`) },
          { key: 'duplicate', label: 'שכפול', icon: Copy, hidden: !canWrite, onSelect: () => navigate(`/orders/new?from=${r.id}`) },
          {
            key: 'whatsapp', label: 'פתיחת ההזמנה ב-WhatsApp', icon: MessageCircle,
            hidden: !canWrite || !(r.supplier.whatsapp || r.supplier.phone) || !['draft', 'ready', 'sent'].includes(r.status),
            onSelect: () => sendWhatsApp(r),
          },
          {
            // Reachable without WhatsApp too: the order may have gone out by phone, email or a
            // printed sheet, and the status must still be recordable.
            key: 'mark-sent', label: 'סמן כנשלחה לספק', icon: Send,
            hidden: !canWrite || !needsSentConfirmation(r.status),
            onSelect: () => setSentConfirmTarget(r),
          },
          { key: 'print', label: 'הדפסה', icon: Printer, onSelect: () => navigate(`/orders/${r.id}?print=1`) },
          {
            key: 'cancel', label: 'ביטול', icon: XCircle, tone: 'danger',
            hidden: !canWrite || ['received', 'cancelled'].includes(r.status),
            onSelect: () => setCancelTarget(r),
          },
        ]}
        activeFilters={statusFilter === 'all' ? 0 : 1}
        onClearFilters={() => setStatusFilter('all')}
        toolbar={
          <select className="input w-auto!" aria-label="סינון הזמנות רכש לפי סטטוס" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="open">הזמנות פתוחות</option>
            <option value="all">הכל</option>
            {Object.entries(PO_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        }
        emptyTitle="עדיין אין הזמנות רכש" emptySubtitle="אפשר ליצור טיוטה חדשה כדי להתחיל את תהליך הרכש"
        emptyAction={canWrite && <button type="button" className="btn-primary" onClick={() => navigate('/orders/new?fresh=1')}><Plus size={ICON.sm} aria-hidden="true" /> טיוטה חדשה</button>} />

      <WhatsAppSendDialog order={waTarget} orgName={org?.name ?? ''}
        onClose={(openedText) => {
          const target = waTarget;
          setWaTarget(null);
          // The window is open; whether the message left is the operator's to say.
          if (openedText && target && needsSentConfirmation(target.status)) setSentConfirmTarget(target);
        }} />
      <ConfirmDialog open={!!sentConfirmTarget} onClose={() => setSentConfirmTarget(null)}
        onConfirm={() => void confirmSent()}
        title="סימון ההזמנה כנשלחה לספק"
        message={sentConfirmTarget
          ? `האם ההודעה על הזמנה #${sentConfirmTarget.number} עבור ${sentConfirmTarget.supplier.name} נשלחה בפועל לספק? `
            + 'המערכת אינה יכולה לדעת זאת בעצמה. הסימון יירשם עם מועד השליחה ויתועד ביומן הביקורת.'
          : ''}
        confirmLabel="כן, נשלחה לספק" busy={busy} />
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
  items: (PurchaseOrderItem & {
    product: { name: string; display_name: string | null; unit: string; sku: string | null };
  })[];
};

export function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile, org, organizationAccess } = useAuth();
  // The order sheet and the WhatsApp message both leave the building — they must carry
  // the buying organization's own name, never the vendor's or another tenant's.
  const orgName = org?.name ?? '';
  const toast = useToast();
  const [confirm, setConfirm] = useState<{ status: PoStatus; label: string } | null>(null);
  const [supplierConfirmOpen, setSupplierConfirmOpen] = useState(false);
  const [sentConfirmOpen, setSentConfirmOpen] = useState(false);
  const [waOpen, setWaOpen] = useState(false);
  const [confirmNote, setConfirmNote] = useState('');
  const [confirmExpected, setConfirmExpected] = useState('');  // optional: set/correct אספקה מבוקשת at confirmation
  const [busy, setBusy] = useState(false);
  const [params, setParams] = useSearchParams();
  const printedRef = useRef<string | null>(null);
  const printAreaRef = useRef<HTMLDivElement>(null);
  const watermark = useExportWatermark();
  const [exportingPdf, setExportingPdf] = useState(false);
  const orgLogoUrl = org?.logo_path
    ? `${supabase.storage.from('organization-branding').getPublicUrl(org.logo_path).data.publicUrl}?v=${encodeURIComponent(org.logo_updated_at ?? '')}`
    : null;

  const { data: order, loading, error, refetch } = useQuery(async () =>
    unwrap(await supabase.from('purchase_orders')
      .select('*, supplier:suppliers(id, name, phone, whatsapp, email, min_order_amount), items:purchase_order_items(*, product:products(name, display_name, unit, sku))')
      .eq('id', id!).single()) as Promise<FullOrder>, [id]);

  // ?print=1 (Orders list "הדפסה" action): print once when the data is on screen, then strip
  // the param so refresh/back does not re-open the dialog.
  useEffect(() => {
    if (printedRef.current === order?.id || params.get('print') !== '1' || !order) return;
    printedRef.current = order.id;
    window.print();
    const next = new URLSearchParams(params);
    next.delete('print');
    setParams(next, { replace: true });
  }, [params, order, setParams]);

  const canWrite = organizationAccess.canWrite && profile && ['owner', 'office'].includes(profile.role);

  async function setStatus(
    status: PoStatus,
    reason: string,
    confirmationNote: string | null = null,
    expectedDate: string | null = null,
  ): Promise<boolean> {
    if (!order) return false;
    setBusy(true);
    const res = await supabase.rpc('transition_purchase_order_status', {
      p_purchase_order_id: order.id,
      p_target_status: status,
      p_reason: reason,
      p_confirmation_note: confirmationNote,
      p_expected_date: expectedDate,
    });
    if (res.error) { setBusy(false); toast(toHebrewError(res.error.message), 'error'); return false; }
    setBusy(false);
    setConfirm(null);
    toast('הסטטוס עודכן');
    void refetch();
    return true;
  }

  async function cancelOrder(reason?: string) {
    if (!order) return;
    setBusy(true);
    const res = await supabase.rpc('cancel_purchase_order', {
      p_purchase_order_id: order.id,
      p_reason: reason ?? null,
    });
    setBusy(false);
    if (res.error) { toast(toHebrewError(res.error.message), 'error'); return; }
    setConfirm(null);
    toast('ההזמנה בוטלה');
    void refetch();
  }

  // Link building and the wa.me open live in lib/share.ts, shared with the Orders list row
  // actions. The dialog opens the window and offers the order image — the status still follows
  // a human confirmation after it closes.
  function sendWhatsApp() {
    if (!order) return;
    setWaOpen(true);
  }

  async function confirmSent() {
    if (!order) return;
    setBusy(true);
    const res = await markOrderSentToSupplier(order.id);
    setBusy(false);
    setSentConfirmOpen(false);
    if (res.error) { toast(res.error, 'error'); return; }
    toast('ההזמנה סומנה כנשלחה לספק');
    void refetch();
  }

  /**
   * The order sheet as a branded PDF — the artefact that goes to the supplier by mail.
   *
   * Portrait A4: this is a heading and one item table. Prices ARE included here, unlike the
   * WhatsApp image (owner decision 18.08.2026), because this file is the order document rather
   * than a picking list forwarded around a supplier's shop floor.
   */
  async function exportPdf() {
    const element = printAreaRef.current;
    if (!element || !order) return;
    setExportingPdf(true);
    try {
      await downloadElementPdf({
        element,
        fileName: `purchase-order-${order.number}.pdf`,
        watermark,
      });
      toast('קובץ ה-PDF הורד');
    } catch (e) {
      toast(toHebrewError(e), 'error');
    } finally {
      setExportingPdf(false);
    }
  }

  if (loading) return <RecordSkeleton />;
  if (error || !order) return <ErrorNote message={error ?? 'הזמנה לא נמצאה'} />;

  const total = order.items.reduce((s, i) => s + i.qty * i.unit_price, 0);
  const underMin = order.supplier.min_order_amount != null && total < order.supplier.min_order_amount;

  const waLink = orderWhatsAppLink(order, orgName);
  const primaryKey = canWrite ? orderPrimaryAction(order.status, !!waLink) : null;
  const nextAction = primaryKey === 'ready' ? 'סימון ההזמנה כמוכנה לשליחה'
    : primaryKey === 'sent' ? 'סימון ההזמנה כנשלחה לספק'
      : primaryKey === 'whatsapp' ? 'פתיחת ההזמנה ב-WhatsApp ואישור השליחה'
        : primaryKey === 'confirm' ? 'תיעוד אישור הספק'
          : primaryKey === 'receive' ? 'קבלת הסחורה' : undefined;
  const primaryAction = primaryKey === 'ready' ? (
    <button className="btn-primary" disabled={busy} onClick={() => void setStatus('ready', 'סימון הזמנה כמוכנה לשליחה')}><CheckCircle2 size={ICON.sm} aria-hidden="true" /> סימון כמוכנה לשליחה</button>
  ) : primaryKey === 'sent' ? (
    <button className="btn-primary" disabled={busy} onClick={() => setSentConfirmOpen(true)}><Send size={ICON.sm} aria-hidden="true" /> סימון כנשלחה לספק</button>
  ) : primaryKey === 'whatsapp' ? (
    <button className="btn-primary" disabled={busy} onClick={() => sendWhatsApp()}><MessageCircle size={ICON.sm} aria-hidden="true" /> פתיחה ב-WhatsApp</button>
  ) : primaryKey === 'confirm' ? (
    <button className="btn-primary" disabled={busy} onClick={() => setSupplierConfirmOpen(true)}><CheckCircle2 size={ICON.sm} aria-hidden="true" /> הספק אישר</button>
  ) : primaryKey === 'receive' ? (
    <button className="btn-primary" onClick={() => navigate(`/receiving/${order.id}`)}><PackageCheck size={ICON.sm} aria-hidden="true" /> קבלת סחורה</button>
  ) : null;
  // Only observed/current stages are included. Purchase orders are normally created as `ready`,
  // and a fully received order did not necessarily pass through `confirmed` or `partial`, so
  // rendering the whole theoretical graph as complete
  // would invent history the record does not carry.
  const lifecycleSteps = orderLifecycle(order.status, !!order.sent_at, !!order.confirmed_at);

  return (
    <div className="space-y-4">
      <RecordHeader className="no-print"
        breadcrumbs={<Breadcrumbs items={[{ label: 'הזמנות', to: '/orders' }, { label: `#${order.number}` }]} />}
        title={<span>הזמנה <span className="num">#{order.number}</span></span>}
        status={<StatusBadge meta={PO_STATUS[order.status]} />}
        meta={<><span>{order.supplier.name}</span><span className="num font-semibold text-ink-body">{fmtMoneyExact(total)}</span><span>נוצרה {fmtDateTime(order.created_at)}</span>{order.sent_at && <span>נשלחה {fmtDateTime(order.sent_at)}</span>}{order.revision_number > 1 && order.revised_from_order_id && (
          <button type="button" className="underline" onClick={() => navigate(`/orders/${order.revised_from_order_id}`)}>
            רוויזיה <span className="num">{order.revision_number}</span> — להזמנה המקורית
          </button>
        )}</>}
        primaryAction={primaryAction}
        secondaryActions={<>
          {canWrite && ['draft', 'sent'].includes(order.status) && waLink && primaryKey !== 'whatsapp' && (
            <button className="btn-secondary" disabled={busy} onClick={() => sendWhatsApp()}><MessageCircle size={ICON.sm} aria-hidden="true" /> {order.status === 'sent' ? 'פתיחה חוזרת ב-WhatsApp' : 'פתיחה ב-WhatsApp'}</button>
          )}
          {/* When WhatsApp is the primary action the confirmation still has to be reachable on its
              own: the order may have gone out by phone or email, or the operator may have dismissed
              the prompt after sending. Opening WhatsApp is not what records the send. */}
          {canWrite && primaryKey === 'whatsapp' && (
            <button className="btn-secondary" disabled={busy} onClick={() => setSentConfirmOpen(true)}><Send size={ICON.sm} aria-hidden="true" /> סמן כנשלחה לספק</button>
          )}
          {canWrite && order.status === 'sent' && (
            <button className="btn-secondary" onClick={() => navigate(`/receiving/${order.id}`)}><PackageCheck size={ICON.sm} aria-hidden="true" /> קבלת סחורה</button>
          )}
          {/* G1, finding 14 — the same URL Receiving.tsx:638 builds, from the order this time.
              An invoice can only be linked to an order through these parameters (InvoiceNew.tsx
              reads them and offers no picker), and the link existed on exactly one transient
              screen. Offered from the moment the order has left the building; a cancelled order is
              excluded because there is nothing to be invoiced for. */}
          {/* Retargeted from /invoices/new (G1, 10.08.2026): the invoice for this order arrives
              from the supplier, so the action is to upload it, not to type it. */}
          {canWrite && !['draft', 'cancelled'].includes(order.status) && (
            <button className="btn-secondary" onClick={() => navigate('/documents')}>
              <FileText size={ICON.sm} aria-hidden="true" /> העלאת החשבונית שהתקבלה
            </button>
          )}
          <button className="btn-secondary" disabled={exportingPdf} onClick={() => void exportPdf()} title="הורדת ההזמנה כקובץ PDF מעוצב עם הלוגו של הארגון">{exportingPdf ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" /> : <FileDown size={ICON.sm} aria-hidden="true" />} הורדת PDF</button>
          {/* Print stays beside the generated file: the browser's own print produces SELECTABLE
              text, which the rasterised PDF cannot (src/lib/pdf.ts explains why). */}
          <button className="btn-secondary" onClick={() => window.print()}><Printer size={ICON.sm} aria-hidden="true" /> הדפסה</button>
          {canWrite && !['received', 'cancelled'].includes(order.status) && (
            <button type="button" className="btn-danger" onClick={() => setConfirm({ status: 'cancelled', label: 'ביטול הזמנה' })}><XCircle size={ICON.sm} aria-hidden="true" /> ביטול</button>
          )}
        </>}
        lifecycle={order.status === 'cancelled' ? undefined : <LifecycleStrip steps={lifecycleSteps} current={order.status} nextAction={nextAction} />} />

      {order.confirmed_at && (
        <Note tone="done" className="no-print">
          <CheckCircle2 size={ICON.sm} className="mt-0.5 shrink-0" />
          <span>
            הספק אישר את קבלת ההזמנה ב-{fmtDateTime(order.confirmed_at)}
            {order.confirmation_note && <span className="text-done-fg"> · {order.confirmation_note}</span>}
          </span>
        </Note>
      )}

      {underMin && (
        <Note tone="await" className="no-print">
          <span className="min-w-0 flex-1">
            שים לב: סכום ההזמנה ({fmtMoneyExact(total)}) נמוך ממינימום ההזמנה של הספק ({fmtMoneyExact(order.supplier.min_order_amount!)}).
          </span>
        </Note>
      )}

      {order.status !== 'draft' && (
        <>
          <EmailOrderCard orderId={order.id} supplierId={order.supplier.id}
            orderStatus={order.status} canWrite={!!canWrite} />
          <SupplierPortalCard order={order} orgName={orgName} canWrite={!!canWrite} />
        </>
      )}

      {/* Printable order sheet */}
      <Card ref={printAreaRef} className="print-area">
        {/* `print-only`, not `hidden print:block`: html2canvas renders the live DOM, so a
            display:none heading is simply absent from the generated PDF (src/index.css). */}
        <div className="print-only mb-4">
          {orgLogoUrl && <img src={orgLogoUrl} alt="" className="mb-2 h-14 w-32 object-contain object-right" />}
          <h2 className="text-xl font-semibold">{`הזמנת רכש #${order.number}${orgName ? ` — ${orgName}` : ''}`}</h2>
          <div className="text-sm mt-1">ספק: {order.supplier.name} · תאריך: {fmtDate(order.created_at)} {order.expected_date && `· אספקה מבוקשת: ${fmtDate(order.expected_date)}`}</div>
        </div>
        <ul className="divide-y divide-line-soft lg:hidden print:hidden" aria-label="פריטי ההזמנה">
          {order.items.map((item) => (
            <li key={item.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0"><div className="font-medium text-ink-body"><bdi>{productLabel(item.product)}</bdi></div><div className="mt-1 text-xs text-ink-muted"><span className="num">{formatQuantity(item.qty, item.product.unit)}</span> × <span className="num">{fmtMoneyExact(item.unit_price)}</span></div></div>
                <span className="num shrink-0 font-semibold">{fmtMoneyExact(item.qty * item.unit_price)}</span>
              </div>
              {order.status !== 'draft' && <div className="mt-2 text-xs text-ink-muted">התקבל: <span className={`num ${item.received_qty >= item.qty ? 'text-done-fg' : item.received_qty > 0 ? 'text-await-fg' : ''}`}>{item.received_qty}</span> מתוך <span className="num">{item.qty}</span></div>}
            </li>
          ))}
          <li className="flex items-center justify-between pt-3 font-semibold"><span>סה״כ להזמנה</span><span className="num">{fmtMoneyExact(total)}</span></li>
        </ul>
        <div className="table-scroll hidden overflow-x-auto lg:block print:block print:overflow-visible" tabIndex={0} role="region" aria-label="שורות ההזמנה">
        <table className="w-full">
          <thead className="table-head border-b border-line-soft">
            <tr>
              <th scope="col" className="th">מוצר</th><th scope="col" className="th">יח׳</th><th scope="col" className="th">כמות</th>
              <th scope="col" className="th">מחיר יח׳ (בעת ההזמנה)</th><th scope="col" className="th">סה״כ</th>
              {order.status !== 'draft' && <th scope="col" className="th no-print">התקבל</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {order.items.map((i) => (
              <tr key={i.id}>
                <td className="td font-medium text-ink-body"><bdi>{productLabel(i.product)}</bdi></td>
                <td className="td">{formatUnit(i.product.unit)}</td>
                <td className="td num">{i.qty}</td>
                <td className="td num">{fmtMoneyExact(i.unit_price)}</td>
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
              <th scope="row" className="td text-start font-semibold" colSpan={4}>סה״כ להזמנה</th>
              <td className="td num font-semibold">{fmtMoneyExact(total)}</td>
              {order.status !== 'draft' && <td className="no-print" />}
            </tr>
          </tfoot>
        </table>
        </div>
        {order.notes && <div className="mt-3 text-sm text-ink-soft">הערות: {order.notes}</div>}
      </Card>

      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)}
        onConfirm={(reason) => confirm && void cancelOrder(reason)}
        title={confirm?.label ?? ''} message="האם לבטל את ההזמנה? הפעולה תתועד ביומן הביקורת." danger requireReason busy={busy} />

      <WhatsAppSendDialog order={waOpen ? order : null} orgName={orgName}
        onClose={(openedText) => {
          setWaOpen(false);
          if (openedText && needsSentConfirmation(order.status)) setSentConfirmOpen(true);
        }} />

      {/* The one place `sent` is recorded from this screen. wa.me hands the message to WhatsApp
          and tells us nothing afterwards, so the app asks instead of assuming. */}
      <ConfirmDialog open={sentConfirmOpen} onClose={() => setSentConfirmOpen(false)}
        onConfirm={() => void confirmSent()}
        title="סימון ההזמנה כנשלחה לספק"
        message={`האם ההודעה על הזמנה #${order.number} עבור ${order.supplier.name} נשלחה בפועל לספק? `
          + 'המערכת אינה יכולה לדעת זאת בעצמה. הסימון יירשם עם מועד השליחה ויתועד ביומן הביקורת.'}
        confirmLabel="כן, נשלחה לספק" busy={busy} />

      <Modal open={supplierConfirmOpen} onClose={() => setSupplierConfirmOpen(false)} title="אישור קבלת הזמנה ע״י הספק" busy={busy} statusMessage={busy ? 'שומר את אישור הספק' : undefined}>
        <p className="text-sm text-ink-soft mb-3">מועד האישור והמשתמש המסמן יתועדו במערכת וביומן הביקורת.</p>
        <label className="label" htmlFor="supplier-confirm-note">איך התקבל האישור? (לא חובה)</label>
        <input id="supplier-confirm-note" className="input" placeholder='למשל: "אושר ב-WhatsApp ע״י דוד"' value={confirmNote} onChange={(e) => setConfirmNote(e.target.value)} />
        <label className="label mt-3" htmlFor="supplier-confirm-date">אספקה מבוקשת (לא חובה — לעדכון תאריך היעד)</label>
        <input id="supplier-confirm-date" type="date" className="input" min={todayISO()} value={confirmExpected} onChange={(e) => setConfirmExpected(e.target.value)} />
        <div className="flex justify-end gap-2 mt-5">
          <button className="btn-secondary" disabled={busy} onClick={() => setSupplierConfirmOpen(false)}>ביטול</button>
          <button className="btn-primary" disabled={busy} onClick={() => void (async () => {
            const saved = await setStatus(
              'confirmed',
              'אישור ספק להזמנה',
              confirmNote.trim() || null,
              confirmExpected || null,
            );
            if (saved) {
              setSupplierConfirmOpen(false);
              setConfirmNote('');
              setConfirmExpected('');
            }
          })()}>
            <CheckCircle2 size={ICON.sm} aria-hidden="true" /> אישור
          </button>
        </div>
      </Modal>
    </div>
  );
}
