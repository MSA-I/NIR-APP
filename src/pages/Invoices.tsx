import { useT } from '../lib/i18n/LocaleProvider';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useParamState } from '../lib/useParamState';
import { Plus, AlertTriangle, AlertOctagon, Info, Eye, Share2, Printer, Trash2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { toHebrewError } from '../lib/errors';
import { useQuery } from '../lib/useQuery';
import { DOMAIN } from '../lib/query/keys';
import { useAuth } from '../auth/AuthContext';
import { DataTable, StatusBadge, ErrorNote, SkeletonTable, Note, ConfirmDialog, PageHeader, useToast, ToggleGroup, ICON, type ServerColumn } from '../components/ui';
import { INVOICE_REVIEW_STATUS, INVOICE_PAYMENT_STATUS, INVOICE_EXPORT_STATUS } from '../lib/status';
import { fmtMoneyExact, fmtDate } from '../lib/format';
import { canShare, shareInvoice } from '../lib/share';
import type { Invoice } from '../lib/types';
import type { CheckResult } from '../lib/checks';
import {
  SUPPLIER_SEARCH_NARROWED,
  fetchServerList,
  formatSortParam,
  monthRangePredicates,
  pageFromParam,
  pageToParam,
  parseSortParam,
  searchSupplierIds,
  twoStepSearchPredicate,
  type ServerListPageReset,
  type ServerPredicate,
  type ServerSort,
} from '../lib/serverList';
import { financialSupplierMap } from '../lib/financialSuppliers';

export type InvoiceRow = Omit<Invoice, 'supplier'> & {
  supplier: { name: string };
  order_links: { order_id: string }[];
  balance?: number;
};

/*
 * There is no correction path for an invoice on this screen, and that is the decision rather than a
 * gap (owner, 11.08.2026).
 *
 * "שכפול כטיוטה" used to be it: no RPC edits an invoice's amount, so correcting one meant soft
 * deleting it and re-typing a duplicate. But the premise underneath that was that a wrong invoice
 * is OURS to fix. It is not. Every invoice here is a document a supplier issued and sent us; the
 * business does not issue invoices at all. A supplier's invoice with a wrong amount is corrected by
 * the supplier, who sends a corrected document or a credit note — and both of those arrive through
 * the document gallery like any other paper. Retyping their document into a draft of our own
 * produces a record that looks authoritative and matches nothing the supplier holds.
 *
 * What remains for a wrong invoice: a credit request (the overcharge path 0118 already opens
 * automatically), or soft deletion with a reason. If this product ever issues invoices to its own
 * customers, that is a different document, a different table and a different button.
 */

/** Shared renderer for automatic-check results. */
export function CheckList({ checks }: { checks: CheckResult[] }) {
  if (!checks.length) {
    return <Note tone="done">כל הבדיקות האוטומטיות עברו ללא ממצאים.</Note>;
  }
  const icon = { critical: AlertOctagon, warning: AlertTriangle, info: Info };
  // Severity → semantic tone: critical is a loss-risk (alert), warning needs our action (await),
  // info is context (info). The shared Note recolours all three from index.css.
  const tone = { critical: 'alert', warning: 'await', info: 'info' } as const;
  return (
    <div className="space-y-2">
      {checks.map((c, i) => {
        const Icon = icon[c.severity];
        return (
          <Note key={i} tone={tone[c.severity]}>
            <Icon size={ICON.sm} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{c.message}</span>
          </Note>
        );
      })}
    </div>
  );
}

const PAGE_SIZE = 15;
/**
 * The one sortable column, by DataTable key. `invoices_org_live_date_idx` (0053) is the only
 * ordering the server can serve without a sort step; `total`, `supplier.name` and `balance` sorts
 * were dropped with the conversion — no index, no embed-order measurement, and no server
 * expression respectively. Balance stays visible; it just cannot order the table.
 */
const SORTABLE_COLUMNS: ReadonlySet<string> = new Set(['date']);
/** DataTable column key → the DB column its index is built on. */
const SORT_COLUMN: Record<string, string> = { date: 'invoice_date' };
const DEFAULT_SORT: readonly ServerSort[] = [{ column: 'invoice_date', ascending: false }];
/**
 * A function rather than a module-level constant: the labels now come from the dictionary, and a
 * constant evaluated at import time would freeze whichever language happened to load first.
 */
function reviewFilterOptions(
  statusLabel: (meta: { key: string } | null | undefined) => string,
): ReadonlyArray<readonly [string, string]> {
  return [
    ['', 'הכל'],
    ...Object.entries(INVOICE_REVIEW_STATUS).map(([key, value]) => [key, statusLabel(value)] as const),
  ];
}
// Phone quick filters are the stages that start or unblock work. Every stage remains in the
// existing filter sheet, and a deep-linked/active secondary stage makes itself visible here.
const MOBILE_PRIMARY_REVIEW_FILTERS = new Set(['', 'received', 'pending_approval', 'investigation']);

export function InvoicesList() {
  const navigate = useNavigate();
  const { profile, organizationAccess } = useAuth();
  const { statusLabel } = useT();
  const toast = useToast();
  const [, setParams] = useSearchParams();
  const [reviewFilter] = useParamState('review');
  const [payFilter] = useParamState('pay');
  const [exportFilter] = useParamState('export');
  const [monthFilter] = useParamState('month');
  const [attentionFilter] = useParamState('attention');
  const [searchTerm] = useParamState('q');
  const [pageParam] = useParamState('page');
  const [sortParam] = useParamState('sort');
  const [deleteTarget, setDeleteTarget] = useState<InvoiceRow | null>(null);
  const [busyDelete, setBusyDelete] = useState(false);
  const isProcurementManager = profile?.role === 'office';
  const canCreate = organizationAccess.canWrite && profile && ['owner', 'office'].includes(profile.role);
  const isOffice = profile && ['owner', 'office'].includes(profile.role);
  const canViewExport = profile?.role !== 'office';

  /**
   * Every URL write goes through one `setParams` call. React Router's functional updater reads the
   * params captured by the hook, so two setter calls in the same handler see the same stale
   * snapshot and the second silently drops the first's change — and nearly every change on this
   * screen is compound ("set the filter AND return to the first page").
   */
  const patchParams = useCallback((patch: Record<string, string>) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      for (const [name, value] of Object.entries(patch)) {
        if (value) next.set(name, value);
        else next.delete(name);
      }
      return next;
    }, { replace: true });
  }, [setParams]);

  const page = pageFromParam(pageParam);
  const uiSort = parseSortParam(sortParam, SORTABLE_COLUMNS);

  const { data, loading, fetching, error, refetch } = useQuery(
    async () => {
      // Always sent, filter or not: the 0053 indexes are partial on `deleted_at is null`, and a
      // query that omits it cannot use them.
      const predicates: ServerPredicate[] = [
        { kind: 'eq', column: 'financial_role', value: 'payable' },
        { kind: 'is', column: 'deleted_at', value: null },
      ];
      if (reviewFilter) predicates.push({ kind: 'eq', column: 'review_status', value: reviewFilter });
      if (payFilter) {
        predicates.push(payFilter === 'open'
          ? { kind: 'neq', column: 'payment_status', value: 'paid' }
          : { kind: 'eq', column: 'payment_status', value: payFilter });
      }
      if (canViewExport && exportFilter) {
        predicates.push({ kind: 'eq', column: 'export_status', value: exportFilter });
      }
      predicates.push(...monthRangePredicates('invoice_date', monthFilter));
      // The attention filters are 0053's computed fields — whole-table questions the old
      // client-side computation could not answer once the screen stopped downloading the table.
      if (attentionFilter === 'duplicates') {
        predicates.push({ kind: 'eq', column: 'invoice_has_duplicate', value: true });
      }
      if (attentionFilter === 'without-order') {
        predicates.push({ kind: 'eq', column: 'invoice_without_order', value: true });
      }

      let narrowed = false;
      if (searchTerm) {
        const suppliers = await searchSupplierIds(supabase, searchTerm);
        narrowed = suppliers.narrowed;
        predicates.push(twoStepSearchPredicate(['invoice_number'], searchTerm, suppliers.ids));
      }

      const result = await fetchServerList<InvoiceRow>(supabase, {
        table: 'invoices',
        select: '*, order_links:invoice_order_links(order_id)',
        predicates,
        sort: uiSort
          ? [{ column: SORT_COLUMN[uiSort[0].column], ascending: uiSort[0].ascending }]
          : DEFAULT_SORT,
        page,
        pageSize: PAGE_SIZE,
      });

      // Balance is display-only (its sort was dropped — no server expression), so it is fetched
      // for this page's rows alone instead of the whole-table pull the screen used to make.
      const suppliers = await financialSupplierMap(result.rows.map((row) => row.supplier_id));
      let rows = result.rows.map((row) => ({
        ...row,
        supplier: { name: suppliers.get(row.supplier_id)?.name ?? '—' },
      }));
      if (!isProcurementManager && rows.length > 0) {
        const balances = await supabase.from('invoice_balances')
          .select('invoice_id, balance')
          .in('invoice_id', rows.map((row) => row.id));
        if (balances.error) throw new Error(balances.error.message);
        const byId = new Map((balances.data as { invoice_id: string; balance: number }[])
          .map((balance) => [balance.invoice_id, balance.balance]));
        rows = rows.map((row) => ({ ...row, balance: byId.get(row.id) }));
      }
      return { ...result, rows, narrowed };
    },
    [],
    [DOMAIN.invoices, 'list', {
      review: reviewFilter,
      pay: payFilter,
      export: canViewExport ? exportFilter : '',
      month: monthFilter,
      attention: attentionFilter,
      q: searchTerm,
      sort: sortParam,
      page,
      balances: !isProcurementManager,
    }],
    { keepPreviousData: true, structuralSharing: false },
  );

  // A 416 was already recovered inside fetchServerList; here the URL catches up with the page that
  // was actually served, and the user hears why in Hebrew rather than staring at a shorter list.
  const handledReset = useRef<ServerListPageReset | null>(null);
  useEffect(() => {
    const reset = data?.pageReset ?? null;
    if (!reset || reset === handledReset.current) return;
    handledReset.current = reset;
    toast(reset.message);
    patchParams({ page: pageToParam(reset.servedPage) });
  }, [data, toast, patchParams]);

  // The server owns the reference check, row lock, soft delete and reasoned audit in one
  // transaction. A client-side preflight would be incomplete under role-scoped RLS.
  async function deleteInvoice(reason?: string) {
    if (!deleteTarget) return;
    setBusyDelete(true);
    const res = await supabase.rpc('soft_delete_invoice', {
      p_invoice_id: deleteTarget.id,
      p_reason: reason?.trim() || null,
    });
    setBusyDelete(false);
    if (res.error) { setDeleteTarget(null); toast(toHebrewError(res.error.message), 'error'); return; }
    setDeleteTarget(null);
    toast('החשבונית נמחקה');
    void refetch();
  }

  const columns: ServerColumn<InvoiceRow>[] = [
    { key: 'number', header: 'מס׳ חשבונית', priority: 3, className: 'num', render: (r) => <span className="font-medium text-ink" dir="ltr">{r.invoice_number}</span> },
    { key: 'supplier', header: 'ספק', priority: 3, render: (r) => r.supplier.name },
    { key: 'date', header: 'תאריך', render: (r) => fmtDate(r.invoice_date) },
    { key: 'total', header: 'סה״כ', className: 'num', render: (r) => fmtMoneyExact(r.total_amount) },
    { key: 'review', header: 'בדיקה', mobileLabel: null, render: (r) => <StatusBadge meta={INVOICE_REVIEW_STATUS[r.review_status]} /> },
    { key: 'payment', header: 'תשלום', priority: 3, render: (r) => <StatusBadge meta={INVOICE_PAYMENT_STATUS[r.payment_status]} /> },
  ];
  if (!isProcurementManager) {
    columns.splice(4, 0, { key: 'balance', header: 'יתרה', className: 'num', render: (r) => (r.balance != null && r.balance > 0 ? <span className="text-await-fg">{fmtMoneyExact(r.balance)}</span> : <span className="text-done-fg">—</span>) });
  }
  if (canViewExport) {
    columns.push({ key: 'export', header: 'רו״ח', priority: 3, render: (r) => <StatusBadge meta={INVOICE_EXPORT_STATUS[r.export_status]} /> });
  }

  const activeFilters = [reviewFilter, payFilter, canViewExport ? exportFilter : '', monthFilter, attentionFilter]
    .filter(Boolean).length;
  const clearFilters = useCallback(() => {
    // `q` is cleared here too: DataTable clears its own search first, but its two calls share one
    // stale params snapshot (see `patchParams`), so this patch must stand on its own.
    patchParams({ review: '', pay: '', export: '', month: '', attention: '', q: '', page: '' });
  }, [patchParams]);

  if (loading) return <SkeletonTable cols={6} />;
  if (error && !data) return <ErrorNote message={error} />;
  if (!data) return <SkeletonTable cols={6} />;

  return (
    <div className="space-y-4">
      {error && <ErrorNote message={error} />}
      {fetching && <div className="text-xs text-ink-muted" role="status">מתעדכן…</div>}
      {/* No "new invoice" action (G1, 10.08.2026). An invoice arrives from a supplier; it is not
          something this business creates. The way one comes into existence is: photograph the
          document, let it be read, approve it. The gallery is where that starts. */}
      <PageHeader title="חשבוניות"
        meta={`${data.total} חשבוניות${activeFilters ? ` · ${activeFilters} מסננים פעילים` : ''}`}
        actions={canCreate && (
          <button className="btn-primary" onClick={() => navigate('/documents')}>
            <Plus size={ICON.sm} aria-hidden="true" /> העלאת מסמך שהתקבל
          </button>
        )} />
      {/* ToggleGroup owns the chip geometry; the per-item className is what keeps the phone
          strip to the stages that start or unblock work — a secondary stage stays hidden below
          `sm` unless it is the active one, and every stage remains in the filter sheet. */}
      <ToggleGroup<string>
        label="סינון חשבוניות לפי שלב הבדיקה"
        className="gap-1.5"
        value={reviewFilter}
        onChange={(value) => patchParams({ review: value, page: '' })}
        items={reviewFilterOptions(statusLabel).map(([value, label]) => ({
          key: value,
          label,
          className: MOBILE_PRIMARY_REVIEW_FILTERS.has(value) || reviewFilter === value ? '' : 'max-sm:hidden',
        }))} />
      <DataTable rows={data.rows} columns={columns}
        emptyTitle="אין חשבוניות עדיין"
        emptySubtitle={canCreate
          ? 'חשבונית נקלטת מצילום או מהעלאת המסמך שהתקבל מהספק, בתיקיית המסמכים.'
          : 'קליטת חשבוניות זמינה למנהל ולמנהל הרכש.'}
        error={error}
        server={{
          total: data.total,
          page,
          pageSize: PAGE_SIZE,
          onPageChange: (next) => patchParams({ page: pageToParam(next) }),
          onSortChange: (next) => patchParams({ sort: formatSortParam(next), page: '' }),
          sort: uiSort,
          sortableColumns: SORTABLE_COLUMNS,
          search: { value: searchTerm, onChange: (value) => patchParams({ q: value, page: '' }) },
          fetching,
        }}
        activeFilters={activeFilters}
        onClearFilters={clearFilters}
        columnPicker="invoices"
        searchLabel="חיפוש בחשבוניות"
        rowLabel={(r) => `חשבונית ${r.invoice_number} של ${r.supplier.name}`}
        onRowClick={(r) => navigate(`/invoices/${r.id}`)}
        mobile="cards"
        mobileTitle={(r) => <><span dir="ltr" className="num">{r.invoice_number}</span> · {r.supplier.name}</>}
        mobileTrailing={(r) => <StatusBadge meta={INVOICE_PAYMENT_STATUS[r.payment_status]} />}
        rowActions={(r) => [
          // "עריכה" was a false affordance: there is no invoice-edit command anywhere in the
          // system, and the row action navigated to a detail screen whose amount is plain text
          // (InvoiceDetail.tsx:248-249). "פתיחה" is the same navigation under its real name.
          { key: 'edit', label: 'פתיחה', icon: Eye, hidden: !canCreate, onSelect: () => navigate(`/invoices/${r.id}`) },
          { key: 'share', label: 'שליחה', icon: Share2, hidden: !canShare(), onSelect: () => void shareInvoice(r, r.supplier.name) },
          { key: 'print', label: 'הדפסה', icon: Printer, onSelect: () => navigate(`/invoices/${r.id}?print=1`) },
          { key: 'delete', label: 'מחיקה', icon: Trash2, tone: 'danger', hidden: !isOffice, onSelect: () => setDeleteTarget(r) },
        ]}
        toolbar={
          <>
            {data.narrowed && <span className="text-xs text-await-fg" role="status">{SUPPLIER_SEARCH_NARROWED}</span>}
            <select className="input w-auto! md:hidden" aria-label="סינון חשבוניות לפי שלב הבדיקה"
              value={reviewFilter} onChange={(e) => patchParams({ review: e.target.value, page: '' })}>
              {reviewFilterOptions(statusLabel).map(([value, label]) => <option key={value || 'all'} value={value}>{label}</option>)}
            </select>
            {/* `without-order` is available only on the active invoice-reading surface. */}
            <select className="input w-auto!" aria-label="סינון חשבוניות לפי צורך בטיפול" value={attentionFilter} onChange={(e) => patchParams({ attention: e.target.value, page: '' })}>
              <option value="">כל החשבוניות</option>
              <option value="duplicates">חשד לכפילות</option>
              <option value="without-order">ללא הזמנת רכש</option>
            </select>
            <select className="input w-auto!" aria-label="סינון חשבוניות לפי סטטוס תשלום" value={payFilter} onChange={(e) => patchParams({ pay: e.target.value, page: '' })}>
              <option value="">כל סטטוסי התשלום</option>
              <option value="open">פתוחות לתשלום</option>
              {Object.entries(INVOICE_PAYMENT_STATUS).map(([k, v]) => <option key={k} value={k}>{statusLabel(v)}</option>)}
            </select>
            <input type="month" className="input w-auto!" aria-label="סינון חשבוניות לפי חודש" value={monthFilter} onChange={(e) => patchParams({ month: e.target.value, page: '' })} />
            {canViewExport && (
              <select className="input w-auto!" aria-label="סינון חשבוניות לפי סטטוס העברה לרואה חשבון" value={exportFilter} onChange={(e) => patchParams({ export: e.target.value, page: '' })}>
                <option value="">כל סטטוסי הרו״ח</option>
                {Object.entries(INVOICE_EXPORT_STATUS).map(([k, v]) => <option key={k} value={k}>{statusLabel(v)}</option>)}
              </select>
            )}
          </>
        } />

      <ConfirmDialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)}
        onConfirm={(reason) => void deleteInvoice(reason)}
        title="מחיקת חשבונית"
        message={`חשבונית ${deleteTarget?.invoice_number ?? ''} תימחק (מחיקה רכה — הרשומה נשמרת ביומן). הפעולה תתועד ביומן הביקורת.`}
        confirmLabel="מחיקה" danger requireReason busy={busyDelete} />
    </div>
  );
}
