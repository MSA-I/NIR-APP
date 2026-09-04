import { useT } from '../lib/i18n/LocaleProvider';
import type { TKey } from '../lib/i18n/t';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useParamState } from '../lib/useParamState';
import { FileDown, Loader2, Printer, Send, CheckCircle2, XCircle, PackageCheck, MessageCircle, Pencil, Copy, Plus, FileText, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { Breadcrumbs, DataTable, MonthPicker, StatusBadge, useToast, ConfirmDialog, LifecycleStrip, Modal, ErrorNote, PageHeader, RecordHeader, RecordSkeleton, SkeletonTable, Note, EmptyState, Card, ICON, type Column } from '../components/ui';
import { PO_STATUS } from '../lib/status';
import { fmtMoneyExact, fmtDate, fmtDateTime, formatQuantity, formatUnit, localDateKey, productLabel, todayISO } from '../lib/format';
import { orderWhatsAppLink, markOrderSentToSupplier, needsSentConfirmation } from '../lib/share';
import { downloadDocumentPdf } from '../lib/pdf';
import { exportWatermark } from '../lib/exportBranding';
import { WhatsAppSendDialog } from '../components/WhatsAppSendDialog';
import { SupplierPortalCard } from '../components/SupplierPortalCard';
import { EmailOrderCard } from '../components/EmailOrderCard';
import { cancelOrderDraft } from '../lib/orderDrafts';
import type { PurchaseOrder, PurchaseOrderItem, PoStatus } from '../lib/types';
import { DocumentPlate } from '../components/DocumentPlate';

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
  /** The draft's currency (0217) — the unit its line prices are quoted in. */
  currency: string;
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
    ...(status === 'draft' ? [{ key: 'draft', labelKey: 'orders.lifecycleDraft' as TKey }] : []),
    ...(status === 'ready' ? [{ key: 'ready', labelKey: 'orders.lifecycleReady' as TKey }] : []),
    ...(wasSent || status === 'sent' ? [{ key: 'sent', labelKey: 'orders.lifecycleSent' as TKey }] : []),
    ...(wasConfirmed || status === 'confirmed' || status === 'partial' ? [{ key: 'confirmed', labelKey: 'orders.lifecycleConfirmed' as TKey }] : []),
    ...(status === 'partial' ? [{ key: 'partial', labelKey: 'orders.lifecyclePartial' as TKey }] : []),
    ...(status === 'received' ? [{ key: 'received', labelKey: 'orders.lifecycleReceived' as TKey }] : []),
  ];
}

/**
 * `open_orders` in `management_dashboard_snapshot`, spelled for the URL: an order that has left
 * the building and has not finished arriving.
 */
export const WITH_SUPPLIER_FILTER = 'sent,confirmed,partial';

/**
 * Every order that was actually placed — `not status in ('draft','cancelled')`, which is exactly
 * the set the control centre's "נרכש החודש" figure is summed over (`Dashboard.tsx` reads
 * `purchase_orders` with `.not('status','in','(draft,cancelled)')`). Spelled for the URL for the
 * same reason `WITH_SUPPLIER_FILTER` is: the tile that counts this set has to be able to open it,
 * and `?status=all` — the link it used to carry — also holds drafts and cancellations.
 */
export const PLACED_FILTER = 'ready,sent,confirmed,partial,received';

/**
 * `open_order_metrics.no_date` in `management_dashboard_snapshot` (`0218:473`,
 * `count(*) filter (where expected_date is null)`), spelled for the URL.
 *
 * It is a SEPARATE parameter from `?status=` rather than another status token, because the count
 * it mirrors is the intersection of two independent questions — which statuses are open, and
 * whether a delivery date was ever given. Folding it into the status set would have made
 * "open and undated" unrepresentable the moment either half changed.
 */
export const UNDATED_DELIVERY_FILTER = 'undated';

/** The four narrowings `/orders` reads from the URL. Every one of them is also a visible control. */
export interface OrderListFilters {
  /** `all`, `open` (not finished), one status, or a comma-separated set. */
  status: string;
  /** `undated` keeps only orders that carry no `expected_date` at all. */
  delivery: string;
  /** `YYYY-MM` against `created_at`, read in the business time zone. Anything else is no filter. */
  month: string;
  /**
   * One ISO code. This NARROWS to a unit; it never converts and never sums — a per-currency figure
   * on the control centre has to be able to open the rows it was taken over.
   */
  currency: string;
}

/** What the list filter needs of a row, and nothing more. */
export type OrderFilterRow = {
  status: string;
  expected_date: string | null;
  created_at: string;
  currency: string;
};

/**
 * The whole of what `?status=`, `?delivery=`, `?month=` and `?currency=` mean on this screen, as
 * one pure function.
 *
 * Pure and exported so a control-centre tile's count and the list its link opens can be checked
 * against each other without rendering either (`src/pages/dashboardTileDestinations.spec.ts`).
 * `DASH-04`/`DASH-05`/`DASH-06` all had the same shape: the count and the destination's filter
 * were written independently, and nothing in the repository could compare them.
 */
export function orderMatchesListFilters(row: OrderFilterRow, filters: OrderListFilters): boolean {
  const { status, delivery, month, currency } = filters;
  if (status === 'all') {
    // every status
  } else if (status === 'open') {
    /* A comma carries a SET (the shape /exceptions already uses for `?type=`). `?status=open`
       here means "not finished", which is the right default for someone working the screen but
       is NOT what `open_orders` means anywhere else in the product: the control centre's
       "התחייבויות פתוחות" — count and committed money both — is `status in
       ('sent','confirmed','partial')`, because an order still in draft is not a commitment to
       anyone. The tile links to that set by name instead of to the wider default. */
    if (['received', 'cancelled'].includes(row.status)) return false;
  } else if (status.includes(',')) {
    if (!status.split(',').filter(Boolean).includes(row.status)) return false;
  } else if (row.status !== status) {
    return false;
  }
  if (delivery === UNDATED_DELIVERY_FILTER && row.expected_date != null) return false;
  // A crafted `?month=` degrades to "no month filter", the same way `monthRangePredicates` does.
  if (/^\d{4}-\d{2}$/.test(month) && localDateKey(row.created_at).slice(0, 7) !== month) return false;
  if (currency && row.currency !== currency) return false;
  return true;
}

export function OrdersList() {
  const { errorText, statusLabel, t } = useT();
  const navigate = useNavigate();
  const { profile, org, organizationAccess } = useAuth();
  const toast = useToast();
  const [, setParams] = useSearchParams();
  const [statusFilter, setStatusFilter] = useParamState('status', 'open');
  const [deliveryFilter, setDeliveryFilter] = useParamState('delivery');
  const [monthFilter, setMonthFilter] = useParamState('month');
  const [currencyFilter, setCurrencyFilter] = useParamState('currency');
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
          .select('id, number, currency, updated_at, notes, editor_step, items:purchase_request_items(qty, unit_price, product:products(name))')
          .eq('status', 'draft').eq('created_by', profile!.id).order('updated_at', { ascending: false })
        : Promise.resolve({ data: [], error: null }),
    ]);
    return { orders: unwrap(orders) as OrderRow[], drafts: unwrap(drafts) as DraftListRow[] };
  }, [profile?.id]);

  const rows = useMemo(() => (data?.orders ?? []).filter((order) => orderMatchesListFilters(order, {
    status: statusFilter, delivery: deliveryFilter, month: monthFilter, currency: currencyFilter,
  })), [data, statusFilter, deliveryFilter, monthFilter, currencyFilter]);

  const activeFilters = (statusFilter === 'all' ? 0 : 1)
    + [deliveryFilter, monthFilter, currencyFilter].filter(Boolean).length;

  /** One atomic URL write — see the note on `patchParams` in Invoices.tsx: two sequential
      functional `setParams` calls in the same handler read the same stale snapshot, and the
      second silently drops the first's change. */
  const clearFilters = useCallback(() => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set('status', 'all');
      for (const name of ['delivery', 'month', 'currency']) next.delete(name);
      return next;
    }, { replace: true });
  }, [setParams]);

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
    if (res.error) { setCancelTarget(null); toast(errorText(res.error.message), 'error'); return; }
    setCancelTarget(null);
    toast(t('orders.toast'));
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
    toast(t('orders.toast_2'));
    void refetch();
  }

  async function cancelDraft(reason?: string) {
    if (!draftCancelTarget) return;
    setBusy(true);
    try {
      await cancelOrderDraft(draftCancelTarget.id, reason ?? t('orders.cancelOrderDraft'));
      toast(t('orders.toast_3'));
      setDraftCancelTarget(null);
      void refetch();
    } catch (failure) {
      toast(errorText(failure), 'error');
    } finally {
      setBusy(false);
    }
  }

  const draftTotal = (draft: DraftListRow) => draft.items.length && draft.items.every((item) => item.unit_price != null)
    ? draft.items.reduce((sum, item) => sum + item.qty * item.unit_price!, 0)
    : null;

  const columns: Column<OrderRow>[] = [
    { key: 'num', header: t('orders.text'), priority: 3, className: 'num', sortValue: (r) => r.number, render: (r) => <span className="font-medium">#{r.number}</span> },
    { key: 'supplier', header: t('orders.text_2'), priority: 3, sortValue: (r) => r.supplier.name, render: (r) => r.supplier.name },
    { key: 'created', header: t('orders.fmtDate'), sortValue: (r) => r.created_at, render: (r) => fmtDate(r.created_at) },
    { key: 'expected', header: t('orders.fmtDate_2'), sortValue: (r) => r.expected_date ?? '', render: (r) => fmtDate(r.expected_date) },
    { key: 'items', header: t('orders.text_3'), priority: 3, className: 'num', render: (r) => r.items.length },
    { key: 'total', header: t('orders.fmtMoneyExact'), className: 'num', mobileLabel: null, sortValue: orderTotal, render: (r) => fmtMoneyExact(orderTotal(r), r.currency) },
    { key: 'status', header: t('orders.text_4'), priority: 3, render: (r) => <StatusBadge meta={PO_STATUS[r.status]} /> },
  ];

  if (loading) return <SkeletonTable cols={6} />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="space-y-4">
      <PageHeader title={t('orders.title')}
        meta={t('orders.listMeta', { shown: rows.length, total: data?.orders.length ?? 0 })}
        actions={canWrite && <button type="button" className="btn-primary" onClick={() => navigate('/orders/new?fresh=1')}><Plus size={ICON.sm} aria-hidden="true" /> {t('orders.navigate')}</button>} />

      {canWrite && !!data?.drafts.length && (
        <section aria-labelledby="my-drafts-title" className="border-y border-line-strong bg-surface">
          <div className="flex items-center justify-between gap-2 border-b border-line-soft px-3 py-3 sm:px-4">
            <div><h2 id="my-drafts-title" className="section-title">{t('orders.text_5')}</h2><p className="mt-0.5 text-xs text-ink-muted">{t('orders.text_6')}</p></div>
            <span className="badge badge-idle num">{data?.drafts.length ?? 0}</span>
          </div>
          {data?.drafts.length ? (
            <div className="divide-y divide-line-soft">
              {data.drafts.map((draft) => (
                <div key={draft.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-3 sm:px-4">
                  <div className="min-w-0">
                    <div className="font-medium text-ink-body">{t('orders.text_7')} <span className="num">#{draft.number}</span></div>
                    <div className="text-xs text-ink-muted">{t('orders.draftUpdated', { at: fmtDateTime(draft.updated_at) })} · <span className="num">{draft.items.length}</span> {t('orders.productsWord')} · {fmtMoneyExact(draftTotal(draft), draft.currency)}</div>
                  </div>
                  <div className="ms-auto flex gap-2">
                    <button type="button" className="btn-secondary" onClick={() => navigate(`/orders/new?draft=${draft.id}`)}>{t('orders.continueEditing')}</button>
                    <button type="button" className="btn-danger" onClick={() => setDraftCancelTarget(draft)}>{t('orders.setDraftCancelTarget')}</button>
                  </div>
                </div>
              ))}
            </div>
          ) : <EmptyState title={t('orders.title_2')} subtitle={t('orders.subtitle')} icon={<FileText size={ICON.hero} />} />}
        </section>
      )}

      <DataTable rows={rows} columns={columns} searchable
        searchFn={(r, q) => r.supplier.name.toLowerCase().includes(q) || String(r.number).includes(q)}
        searchLabel={t('orders.searchLabel')}
        rowLabel={(r) => t('orders.rowLabel', { number: r.number, supplier: r.supplier.name })}
        onRowClick={(r) => navigate(`/orders/${r.id}`)}
        mobile="cards"
        mobileTitle={(r) => <><span className="num">#{r.number}</span> · {r.supplier.name}</>}
        mobileTrailing={(r) => <StatusBadge meta={PO_STATUS[r.status]} />}
        rowActions={(r) => [
          { key: 'edit', label: t('orders.actionEdit'), icon: Pencil, hidden: !canWrite, onSelect: () => navigate(`/orders/${r.id}`) },
          { key: 'duplicate', label: t('orders.actionDuplicate'), icon: Copy, hidden: !canWrite, onSelect: () => navigate(`/orders/new?from=${r.id}`) },
          {
            key: 'whatsapp', label: t('orders.text_8'), icon: MessageCircle,
            hidden: !canWrite || !(r.supplier.whatsapp || r.supplier.phone) || !['draft', 'ready', 'sent'].includes(r.status),
            onSelect: () => sendWhatsApp(r),
          },
          {
            // Reachable without WhatsApp too: the order may have gone out by phone, email or a
            // printed sheet, and the status must still be recordable.
            key: 'mark-sent', label: t('orders.text_9'), icon: Send,
            hidden: !canWrite || !needsSentConfirmation(r.status),
            onSelect: () => setSentConfirmTarget(r),
          },
          { key: 'print', label: t('orders.actionPrint'), icon: Printer, onSelect: () => navigate(`/orders/${r.id}?print=1`) },
          {
            key: 'cancel', label: t('orders.text_10'), icon: XCircle, tone: 'danger',
            hidden: !canWrite || ['received', 'cancelled'].includes(r.status),
            onSelect: () => setCancelTarget(r),
          },
        ]}
        activeFilters={activeFilters}
        onClearFilters={clearFilters}
        toolbar={
          <>
            <select className="input w-auto!" aria-label={t('orders.aria_label')} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="open">{t('orders.text_11')}</option>
              <option value="all">{t('orders.text_12')}</option>
              {/* Named in the dropdown rather than left as a URL-only state, so a reader arriving
                  from the control centre's commitments tile can see which set is on. */}
              <option value={WITH_SUPPLIER_FILTER}>{t('orders.statusWithSupplier')}</option>
              <option value={PLACED_FILTER}>{t('orders.statusPlaced')}</option>
              {Object.entries(PO_STATUS).map(([k, v]) => <option key={k} value={k}>{statusLabel(v)}</option>)}
            </select>
            {/* The undated set is a control of its own for the same reason it is a separate URL
                parameter: "open" and "no delivery date promised" are two questions, and the
                control centre counts their intersection. */}
            <select className="input w-auto!" aria-label={t('orders.deliveryFilterLabel')} value={deliveryFilter} onChange={(e) => setDeliveryFilter(e.target.value)}>
              <option value="">{t('orders.deliveryFilterAny')}</option>
              <option value={UNDATED_DELIVERY_FILTER}>{t('orders.deliveryFilterUndated')}</option>
            </select>
            <MonthPicker label={t('orders.monthFilterLabel')} value={monthFilter} allowEmpty
              onChange={setMonthFilter} />
            {/* A chip rather than a select: the currency catalogue is not on this screen, and a
                dropdown built from the rows already on it would offer a choice that depends on
                what happens to be loaded. The chip states the narrowing that IS on and removes it
                in one click, which is what stops `?currency=` from being invisible URL-only state. */}
            {currencyFilter && (
              <button type="button" className="btn-ghost min-h-11 text-xs" onClick={() => setCurrencyFilter('')}>
                {t('orders.currencyFilterChip', { currency: currencyFilter })}
                <X size={ICON.xs} aria-hidden="true" />
              </button>
            )}
          </>
        }
        emptyTitle={t('orders.emptyTitle')} emptySubtitle={t('orders.emptySubtitle')}
        emptyAction={canWrite && <button type="button" className="btn-primary" onClick={() => navigate('/orders/new?fresh=1')}><Plus size={ICON.sm} aria-hidden="true" /> {t('orders.navigate_2')}</button>} />

      <WhatsAppSendDialog order={waTarget} orgName={org?.name ?? ''}
        onClose={(openedText) => {
          const target = waTarget;
          setWaTarget(null);
          // The window is open; whether the message left is the operator's to say.
          if (openedText && target && needsSentConfirmation(target.status)) setSentConfirmTarget(target);
        }} />
      <ConfirmDialog open={!!sentConfirmTarget} onClose={() => setSentConfirmTarget(null)}
        onConfirm={() => void confirmSent()}
        title={t('orders.title_3')}
        message={sentConfirmTarget
          ? `${t('orders.sentConfirmQuestion', { number: sentConfirmTarget.number, supplier: sentConfirmTarget.supplier.name })} `
            + t('orders.text_13')
          : ''}
        confirmLabel={t('orders.confirmLabel')} busy={busy} />
      <ConfirmDialog open={!!cancelTarget} onClose={() => setCancelTarget(null)}
        onConfirm={(reason) => void cancelOrder(reason)}
        title={t('orders.title_4')} message={t('orders.message')}
        danger requireReason busy={busy} />
      <ConfirmDialog open={!!draftCancelTarget} onClose={() => setDraftCancelTarget(null)}
        onConfirm={(reason) => void cancelDraft(reason)}
        title={t('orders.title_5')} message={t('orders.message_2')}
        confirmLabel={t('orders.confirmLabel_2')} danger requireReason busy={busy} />
    </div>
  );
}

type FullOrder = PurchaseOrder & {
  supplier: {
    id: string; name: string; phone: string | null; whatsapp: string | null; email: string | null;
    min_order_amount: number | null;
    /**
     * The currency the supplier's own figures are in — `min_order_amount` among them. It is read
     * here to decide whether that minimum is even comparable to this order's total, never to
     * convert either one.
     */
    default_currency: string;
  };
  items: (PurchaseOrderItem & {
    product: { name: string; display_name: string | null; unit: string; sku: string | null };
  })[];
};

export function OrderDetail() {
  const { errorText, locale, t } = useT();
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
  const [exportingPdf, setExportingPdf] = useState(false);
  const orgLogoUrl = org?.logo_path
    ? `${supabase.storage.from('organization-branding').getPublicUrl(org.logo_path).data.publicUrl}?v=${encodeURIComponent(org.logo_updated_at ?? '')}`
    : null;

  /**
   * PROC-06. `maybeSingle()`, not `single()`, and the difference is the whole finding.
   *
   * `single()` demands one row of PostgREST, which answers HTTP 406 over zero — so an id with no
   * record behind it (a stale WhatsApp link, a cancelled order, a half-copied address) threw, and
   * a thrown read is an ERROR. The screen then showed the generic failure sentence, "הפעולה
   * נכשלה. אם הבעיה חוזרת — פנה לתמיכה.", over an empty page: it named the wrong cause and sent
   * the person to open a support ticket for a URL that simply has no order.
   *
   * `maybeSingle()` fetches as a list and enforces cardinality client-side, so zero rows is
   * `data: null` with NO error — an answer, not a fault. The absent record and the failed read
   * are then two different states below, which is what they always were.
   */
  const { data: order, loading, error, refetch } = useQuery(async () =>
    unwrap(await supabase.from('purchase_orders')
      .select('*, supplier:suppliers(id, name, phone, whatsapp, email, min_order_amount, default_currency), items:purchase_order_items(*, product:products(name, display_name, unit, sku))')
      .eq('id', id!).maybeSingle()) as Promise<FullOrder | null>, [id]);

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
    if (res.error) { setBusy(false); toast(errorText(res.error.message), 'error'); return false; }
    setBusy(false);
    setConfirm(null);
    toast(t('orders.toast_4'));
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
    if (res.error) { toast(errorText(res.error.message), 'error'); return; }
    setConfirm(null);
    toast(t('orders.toast_5'));
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
    toast(t('orders.toast_6'));
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
      await downloadDocumentPdf({
        element,
        path: `/orders/${order.id}`,
        fileName: `purchase-order-${order.number}.pdf`,
        watermark: await exportWatermark(),
      });
      toast(t('orders.toastPdf'));
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setExportingPdf(false);
    }
  }

  if (loading) return <RecordSkeleton />;
  // A read that failed is still a failure and still says so. What changed is that "there is no
  // such order" no longer travels through that branch: it gets its own screen, which names the
  // state and offers the one thing a person on a dead link actually wants — the list.
  if (error) return <ErrorNote message={error} />;
  if (!order) {
    return (
      <EmptyState
        title={t('orders.text_14')}
        subtitle={t('orders.orderNotFoundBody')}
        icon={<FileText size={ICON.hero} />}
        action={<Link to="/orders" className="btn-secondary">{t('orders.orderNotFoundAction')}</Link>} />
    );
  }

  // Every price on this sheet is a snapshot taken in the ORDER's currency, so the total is that
  // currency and nothing here needs a second one.
  const total = order.items.reduce((s, i) => s + i.qty * i.unit_price, 0);
  /* The supplier's minimum is a figure in the SUPPLIER's currency (#289). An order placed in a
     different currency cannot be under it or over it — "3,100 is less than 5,000" is not a fact
     when the two are different money — so the warning is withheld and the mismatch is named
     instead. Same rule the server applies in `purchase_comparison.below_minimum`. */
  const minimumComparable = order.currency === order.supplier.default_currency;
  const underMin = minimumComparable && order.supplier.min_order_amount != null && total < order.supplier.min_order_amount;
  const minimumInOtherCurrency = !minimumComparable && order.supplier.min_order_amount != null;

  const waLink = orderWhatsAppLink(order, orgName);
  const primaryKey = canWrite ? orderPrimaryAction(order.status, !!waLink) : null;
  const nextAction = primaryKey === 'ready' ? t('orders.text_15')
    : primaryKey === 'sent' ? t('orders.text_16')
      : primaryKey === 'whatsapp' ? t('orders.text_17')
        : primaryKey === 'confirm' ? t('orders.text_18')
          : primaryKey === 'receive' ? t('orders.text_19') : undefined;
  const primaryAction = primaryKey === 'ready' ? (
    <button className="btn-primary" disabled={busy} onClick={() => void setStatus('ready', t('orders.setStatus'))}><CheckCircle2 size={ICON.sm} aria-hidden="true" /> {t('orders.setStatus_2')}</button>
  ) : primaryKey === 'sent' ? (
    <button className="btn-primary" disabled={busy} onClick={() => setSentConfirmOpen(true)}><Send size={ICON.sm} aria-hidden="true" /> {t('orders.setSentConfirmOpen')}</button>
  ) : primaryKey === 'whatsapp' ? (
    <button className="btn-primary" disabled={busy} onClick={() => sendWhatsApp()}><MessageCircle size={ICON.sm} aria-hidden="true" /> {t('orders.sendWhatsApp')}</button>
  ) : primaryKey === 'confirm' ? (
    <button className="btn-primary" disabled={busy} onClick={() => setSupplierConfirmOpen(true)}><CheckCircle2 size={ICON.sm} aria-hidden="true" /> {t('orders.setSupplierConfirmOpen')}</button>
  ) : primaryKey === 'receive' ? (
    <button className="btn-primary" onClick={() => navigate(`/receiving/${order.id}`)}><PackageCheck size={ICON.sm} aria-hidden="true" /> {t('orders.receiveGoods')}</button>
  ) : null;
  // Only observed/current stages are included. Purchase orders are normally created as `ready`,
  // and a fully received order did not necessarily pass through `confirmed` or `partial`, so
  // rendering the whole theoretical graph as complete
  // would invent history the record does not carry.
  const lifecycleSteps = orderLifecycle(order.status, !!order.sent_at, !!order.confirmed_at)
    .map((step) => ({ key: step.key, label: t(step.labelKey) }));

  return (
    <div className="space-y-4">
      <RecordHeader className="no-print"
        breadcrumbs={<Breadcrumbs items={[{ label: t('orders.ordersCrumb'), to: '/orders' }, { label: `#${order.number}` }]} />}
        title={<span>{t('orders.text_20')} <span className="num">#{order.number}</span></span>}
        status={<StatusBadge meta={PO_STATUS[order.status]} />}
        meta={<><span>{order.supplier.name}</span><span className="num font-semibold text-ink-body">{fmtMoneyExact(total, order.currency)}</span><span>{t('orders.createdAt', { at: fmtDateTime(order.created_at) })}</span>{order.sent_at && <span>{t('orders.sentAt', { at: fmtDateTime(order.sent_at) })}</span>}{order.revision_number > 1 && order.revised_from_order_id && (
          <button type="button" className="underline" onClick={() => navigate(`/orders/${order.revised_from_order_id}`)}>
            {t('orders.revisionWord')} <span className="num">{order.revision_number}</span> {t('orders.toOriginalOrder')}
          </button>
        )}</>}
        primaryAction={primaryAction}
        secondaryActions={<>
          {canWrite && ['draft', 'sent'].includes(order.status) && waLink && primaryKey !== 'whatsapp' && (
            <button className="btn-secondary" disabled={busy} onClick={() => sendWhatsApp()}><MessageCircle size={ICON.sm} aria-hidden="true" /> {order.status === 'sent' ? t('orders.sendWhatsApp_2') : t('orders.sendWhatsApp_3')}</button>
          )}
          {/* When WhatsApp is the primary action the confirmation still has to be reachable on its
              own: the order may have gone out by phone or email, or the operator may have dismissed
              the prompt after sending. Opening WhatsApp is not what records the send. */}
          {canWrite && primaryKey === 'whatsapp' && (
            <button className="btn-secondary" disabled={busy} onClick={() => setSentConfirmOpen(true)}><Send size={ICON.sm} aria-hidden="true" /> {t('orders.setSentConfirmOpen_2')}</button>
          )}
          {canWrite && order.status === 'sent' && (
            <button className="btn-secondary" onClick={() => navigate(`/receiving/${order.id}`)}><PackageCheck size={ICON.sm} aria-hidden="true" /> {t('orders.receiveGoods')}</button>
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
              <FileText size={ICON.sm} aria-hidden="true" /> {t('orders.uploadInvoiceReceived')}
            </button>
          )}
          <button className="btn-secondary" disabled={exportingPdf} onClick={() => void exportPdf()} title={t('orders.exportPdf')}>{exportingPdf ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" /> : <FileDown size={ICON.sm} aria-hidden="true" />} {t('orders.exportPdfLabel')}</button>
          {/* Print stays beside the generated file: the browser's own print produces SELECTABLE
              text, which the rasterised PDF cannot (src/lib/pdf.ts explains why). */}
          <button className="btn-secondary" onClick={() => window.print()}><Printer size={ICON.sm} aria-hidden="true" /> {t('orders.actionPrint')}</button>
          {canWrite && !['received', 'cancelled'].includes(order.status) && (
            <button type="button" className="btn-danger" onClick={() => setConfirm({ status: 'cancelled', label: t('orders.setConfirm') })}><XCircle size={ICON.sm} aria-hidden="true" /> {t('orders.setConfirm_2')}</button>
          )}
        </>}
        lifecycle={order.status === 'cancelled' ? undefined : <LifecycleStrip steps={lifecycleSteps} current={order.status} nextAction={nextAction} />} />

      {order.confirmed_at && (
        <Note tone="done" className="no-print">
          <CheckCircle2 size={ICON.sm} className="mt-0.5 shrink-0" />
          <span>
            {t('orders.fmtDateTime')}{fmtDateTime(order.confirmed_at)}
            {order.confirmation_note && <span className="text-done-fg"> · {order.confirmation_note}</span>}
          </span>
        </Note>
      )}

      {underMin && (
        <Note tone="await" className="no-print">
          <span className="min-w-0 flex-1">
            {t('orders.belowMinimumNote', { total: fmtMoneyExact(total, order.currency), minimum: fmtMoneyExact(order.supplier.min_order_amount!, order.supplier.default_currency) })}
          </span>
        </Note>
      )}

      {minimumInOtherCurrency && (
        <Note tone="idle" className="no-print">
          <span className="min-w-0 flex-1">
            {t('orders.minimumCurrencyMismatch', {
              orderCurrency: order.currency,
              supplierCurrency: order.supplier.default_currency,
              minimum: fmtMoneyExact(order.supplier.min_order_amount!, order.supplier.default_currency),
            })}
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
        <div aria-hidden="true" className="print-only mb-4">
          <DocumentPlate
            family="purchase"
            name={t('orders.printName')}
            number={`#${order.number}`}
            orgLogoUrl={orgLogoUrl}
            subtitle={[
              orgName,
              t('orders.printSupplier', { supplier: order.supplier.name }),
              t('orders.printDate', { date: fmtDate(order.created_at) }),
              order.expected_date ? t('orders.printExpected', { date: fmtDate(order.expected_date) }) : null,
            ].filter(Boolean).join(' · ')} />
        </div>
        <ul className="divide-y divide-line-soft lg:hidden print:hidden" aria-label={t('orders.aria_label_2')}>
          {order.items.map((item) => (
            <li key={item.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0"><div className="font-medium text-ink-body"><bdi>{productLabel(item.product)}</bdi></div><div className="mt-1 text-xs text-ink-muted"><span className="num">{formatQuantity(item.qty, item.product.unit, locale)}</span> × <span className="num">{fmtMoneyExact(item.unit_price, order.currency)}</span></div></div>
                <span className="num shrink-0 font-semibold">{fmtMoneyExact(item.qty * item.unit_price, order.currency)}</span>
              </div>
              {order.status !== 'draft' && <div className="mt-2 text-xs text-ink-muted">{t('orders.receivedLabel')} <span className={`num ${item.received_qty >= item.qty ? 'text-done-fg' : item.received_qty > 0 ? 'text-await-fg' : ''}`}>{item.received_qty}</span> {t('orders.outOfWord')} <span className="num">{item.qty}</span></div>}
            </li>
          ))}
          <li className="flex items-center justify-between pt-3 font-semibold"><span>{t('orders.fmtMoneyExact_2')}</span><span className="num">{fmtMoneyExact(total, order.currency)}</span></li>
        </ul>
        <div className="table-scroll hidden overflow-x-auto lg:block print:block print:overflow-visible" tabIndex={0} role="region" aria-label={t('orders.aria_label_3')}>
        <table className="w-full">
          <thead className="table-head border-b border-line-soft">
            <tr>
              <th scope="col" className="th">{t('orders.text_21')}</th><th scope="col" className="th">{t('orders.text_22')}</th><th scope="col" className="th">{t('orders.text_23')}</th>
              <th scope="col" className="th">{t('orders.text_24')}</th><th scope="col" className="th">{t('orders.text_25')}</th>
              {order.status !== 'draft' && <th scope="col" className="th no-print">{t('orders.text_26')}</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {order.items.map((i) => (
              <tr key={i.id}>
                <td className="td font-medium text-ink-body"><bdi>{productLabel(i.product)}</bdi></td>
                <td className="td">{formatUnit(i.product.unit, locale)}</td>
                <td className="td num">{i.qty}</td>
                <td className="td num">{fmtMoneyExact(i.unit_price, order.currency)}</td>
                <td className="td num">{fmtMoneyExact(i.qty * i.unit_price, order.currency)}</td>
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
              <th scope="row" className="td text-start font-semibold" colSpan={4}>{t('orders.text_27')}</th>
              <td className="td num font-semibold">{fmtMoneyExact(total, order.currency)}</td>
              {order.status !== 'draft' && <td className="no-print" />}
            </tr>
          </tfoot>
        </table>
        </div>
        {order.notes && <div className="mt-3 text-sm text-ink-soft">{t('orders.notesLabel')} {order.notes}</div>}
      </Card>

      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)}
        onConfirm={(reason) => confirm && void cancelOrder(reason)}
        title={confirm?.label ?? ''} message={t('orders.message_3')} danger requireReason busy={busy} />

      <WhatsAppSendDialog order={waOpen ? order : null} orgName={orgName}
        onClose={(openedText) => {
          setWaOpen(false);
          if (openedText && needsSentConfirmation(order.status)) setSentConfirmOpen(true);
        }} />

      {/* The one place `sent` is recorded from this screen. wa.me hands the message to WhatsApp
          and tells us nothing afterwards, so the app asks instead of assuming. */}
      <ConfirmDialog open={sentConfirmOpen} onClose={() => setSentConfirmOpen(false)}
        onConfirm={() => void confirmSent()}
        title={t('orders.title_6')}
        message={`${t('orders.sentConfirmQuestion', { number: order.number, supplier: order.supplier.name })} `
          + t('orders.text_28')}
        confirmLabel={t('orders.confirmLabel_3')} busy={busy} />

      <Modal open={supplierConfirmOpen} onClose={() => setSupplierConfirmOpen(false)} title={t('orders.title_7')} busy={busy} statusMessage={busy ? t('orders.setSupplierConfirmOpen_2') : undefined}>
        <p className="text-sm text-ink-soft mb-3">{t('orders.text_29')}</p>
        <label className="label" htmlFor="supplier-confirm-note">{t('orders.text_30')}</label>
        <input id="supplier-confirm-note" className="input" placeholder={t('orders.setConfirmNote')} value={confirmNote} onChange={(e) => setConfirmNote(e.target.value)} />
        <label className="label mt-3" htmlFor="supplier-confirm-date">{t('orders.text_31')}</label>
        <input id="supplier-confirm-date" type="date" className="input" min={todayISO()} value={confirmExpected} onChange={(e) => setConfirmExpected(e.target.value)} />
        <div className="flex justify-end gap-2 mt-5">
          <button className="btn-secondary" disabled={busy} onClick={() => setSupplierConfirmOpen(false)}>{t('orders.setSupplierConfirmOpen_3')}</button>
          <button className="btn-primary" disabled={busy} onClick={() => void (async () => {
            const saved = await setStatus(
              'confirmed',
              t('orders.text_32'),
              confirmNote.trim() || null,
              confirmExpected || null,
            );
            if (saved) {
              setSupplierConfirmOpen(false);
              setConfirmNote('');
              setConfirmExpected('');
            }
          })()}>
            <CheckCircle2 size={ICON.sm} aria-hidden="true" /> {t('orders.approve')}
          </button>
        </div>
      </Modal>
    </div>
  );
}
