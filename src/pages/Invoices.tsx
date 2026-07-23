import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useParamState } from '../lib/useParamState';
import { Plus, AlertTriangle, AlertOctagon, Info, Pencil, Copy, Share2, Printer, Trash2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { toHebrewError } from '../lib/errors';
import { useQuery } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { DataTable, StatusBadge, ErrorNote, SkeletonTable, Note, ConfirmDialog, useToast, type Column } from '../components/ui';
import { INVOICE_REVIEW_STATUS, INVOICE_PAYMENT_STATUS, INVOICE_EXPORT_STATUS } from '../lib/status';
import { fmtMoneyExact, fmtDate } from '../lib/format';
import { logAction } from '../lib/audit';
import { canShare, shareInvoice } from '../lib/share';
import type { Invoice } from '../lib/types';
import type { CheckResult } from '../lib/checks';
import { fetchAll } from '../lib/supabasePaging';

export type InvoiceRow = Invoice & { supplier: { name: string }; balance?: number };

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
            <Icon size={16} className="mt-0.5 shrink-0" />
            <span>{c.message}</span>
          </Note>
        );
      })}
    </div>
  );
}

export function InvoicesList() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const toast = useToast();
  const [reviewFilter, setReviewFilter] = useParamState('review');
  const [payFilter, setPayFilter] = useParamState('pay');
  const [exportFilter, setExportFilter] = useParamState('export');
  const [monthFilter, setMonthFilter] = useParamState('month');
  const [deleteTarget, setDeleteTarget] = useState<InvoiceRow | null>(null);
  const [busyDelete, setBusyDelete] = useState(false);
  const isProcurementManager = profile?.role === 'office';

  const { data, loading, fetching, error, refetch } = useQuery(async () => {
    const invoices = await fetchAll<InvoiceRow>((from, to) => supabase.from('invoices')
      .select('*, supplier:suppliers(name)').is('deleted_at', null)
      .order('invoice_date', { ascending: false }).order('id').range(from, to));
    const balances = isProcurementManager ? [] : await fetchAll<{ invoice_id: string; balance: number }>((from, to) => supabase.from('invoice_balances')
      .select('invoice_id, balance').order('invoice_id').range(from, to));
    const balMap = new Map(balances.map((b) => [b.invoice_id, b.balance]));
    return invoices.map((i) => ({ ...i, balance: balMap.get(i.id) }));
  }, [isProcurementManager]);

  const canCreate = profile && ['owner', 'office', 'kitchen'].includes(profile.role);
  const isOffice = profile && ['owner', 'office'].includes(profile.role);
  const canViewExport = profile?.role !== 'office';

  const rows = useMemo(() => (data ?? []).filter((r) =>
    (!reviewFilter || r.review_status === reviewFilter) &&
    (!payFilter || (payFilter === 'open' ? r.payment_status !== 'paid' : r.payment_status === payFilter)) &&
    (!canViewExport || !exportFilter || r.export_status === exportFilter) &&
    (!monthFilter || r.invoice_date.startsWith(monthFilter))),
  [data, reviewFilter, payFilter, exportFilter, monthFilter, canViewExport]);

  // Delete guard (adversarial review round): a soft-deleted invoice disappears from the list
  // and from invoice_balances, but its payment_allocations / credit_requests rows survive —
  // the money would still be allocated to a record nobody can see. Refuse the delete while
  // anything points at the invoice; the user resolves it from the payments/credits screens.
  async function requestDelete(inv: InvoiceRow) {
    const [alloc, credits] = await Promise.all([
      supabase.from('payment_allocations').select('id', { count: 'exact', head: true }).eq('invoice_id', inv.id),
      supabase.from('credit_requests').select('id', { count: 'exact', head: true }).eq('invoice_id', inv.id),
    ]);
    const err = alloc.error ?? credits.error;
    // If the check itself failed we cannot prove the invoice is safe to delete — refuse.
    if (err) { toast(toHebrewError(err.message), 'error'); return; }
    if ((alloc.count ?? 0) > 0 || (credits.count ?? 0) > 0) {
      toast('לא ניתן למחוק חשבונית שיש לה תשלומים או זיכויים משויכים — יש לטפל דרך מסך התשלומים/זיכויים', 'error');
      return;
    }
    setDeleteTarget(inv);
  }

  // Soft delete only (CLAUDE.md): invoices carry deleted_at (no deleted_by column on this
  // table); the list query already filters .is('deleted_at', null), so refetch drops the row.
  async function deleteInvoice(reason?: string) {
    if (!deleteTarget) return;
    setBusyDelete(true);
    const res = await supabase.from('invoices').update({ deleted_at: new Date().toISOString() }).eq('id', deleteTarget.id);
    setBusyDelete(false);
    if (res.error) { setDeleteTarget(null); toast(toHebrewError(res.error.message), 'error'); return; }
    await logAction({ orgId: deleteTarget.org_id, action: 'invoice_deleted', entityType: 'invoices', entityId: deleteTarget.id, reason });
    setDeleteTarget(null);
    toast('החשבונית נמחקה');
    void refetch();
  }

  const columns: Column<InvoiceRow>[] = [
    { key: 'number', header: 'מס׳ חשבונית', priority: 3, className: 'num', sortValue: (r) => r.invoice_number, render: (r) => <span className="font-medium text-ink" dir="ltr">{r.invoice_number}</span> },
    { key: 'supplier', header: 'ספק', priority: 3, sortValue: (r) => r.supplier.name, render: (r) => r.supplier.name },
    { key: 'date', header: 'תאריך', sortValue: (r) => r.invoice_date, render: (r) => fmtDate(r.invoice_date) },
    { key: 'total', header: 'סה״כ', className: 'num', sortValue: (r) => r.total_amount, render: (r) => fmtMoneyExact(r.total_amount) },
    { key: 'review', header: 'בדיקה', mobileLabel: null, render: (r) => <StatusBadge meta={INVOICE_REVIEW_STATUS[r.review_status]} /> },
    { key: 'payment', header: 'תשלום', priority: 3, render: (r) => <StatusBadge meta={INVOICE_PAYMENT_STATUS[r.payment_status]} /> },
  ];
  if (!isProcurementManager) {
    columns.splice(4, 0, { key: 'balance', header: 'יתרה', className: 'num', sortValue: (r) => r.balance ?? 0, render: (r) => (r.balance != null && r.balance > 0 ? <span className="text-await-fg">{fmtMoneyExact(r.balance)}</span> : <span className="text-done-solid">—</span>) });
  }
  if (canViewExport) {
    columns.push({ key: 'export', header: 'רו״ח', priority: 3, render: (r) => <StatusBadge meta={INVOICE_EXPORT_STATUS[r.export_status]} /> });
  }

  if (loading) return <SkeletonTable cols={6} />;
  if (error && !data) return <ErrorNote message={error} />;

  return (
    <div className="space-y-4">
      {error && <ErrorNote message={error} />}
      {fetching && data && <div className="text-xs text-ink-muted" role="status">מתעדכן…</div>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="page-title">חשבוניות</h1>
        {canCreate && <button className="btn-primary" onClick={() => navigate('/invoices/new')}><Plus size={16} /> חשבונית חדשה</button>}
      </div>
      <DataTable rows={rows} columns={columns} searchable
        searchFn={(r, q) => r.invoice_number.toLowerCase().includes(q) || r.supplier.name.toLowerCase().includes(q)}
        searchLabel="חיפוש בחשבוניות"
        rowLabel={(r) => `חשבונית ${r.invoice_number} של ${r.supplier.name}`}
        onRowClick={(r) => navigate(`/invoices/${r.id}`)}
        mobile="cards"
        mobileTitle={(r) => <><span dir="ltr" className="num">{r.invoice_number}</span> · {r.supplier.name}</>}
        mobileTrailing={(r) => <StatusBadge meta={INVOICE_PAYMENT_STATUS[r.payment_status]} />}
        rowActions={(r) => [
          { key: 'edit', label: 'עריכה', icon: Pencil, hidden: !canCreate, onSelect: () => navigate(`/invoices/${r.id}`) },
          { key: 'duplicate', label: 'שכפול כטיוטה', icon: Copy, hidden: !canCreate, onSelect: () => navigate(`/invoices/new?from=${r.id}`) },
          { key: 'share', label: 'שליחה', icon: Share2, hidden: !canShare(), onSelect: () => void shareInvoice(r, r.supplier.name) },
          { key: 'print', label: 'הדפסה', icon: Printer, onSelect: () => navigate(`/invoices/${r.id}?print=1`) },
          { key: 'delete', label: 'מחיקה', icon: Trash2, tone: 'danger', hidden: !isOffice, onSelect: () => void requestDelete(r) },
        ]}
        toolbar={
          <>
            <select className="input w-auto!" aria-label="סינון חשבוניות לפי סטטוס בדיקה" value={reviewFilter} onChange={(e) => setReviewFilter(e.target.value)}>
              <option value="">כל סטטוסי הבדיקה</option>
              {Object.entries(INVOICE_REVIEW_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <select className="input w-auto!" aria-label="סינון חשבוניות לפי סטטוס תשלום" value={payFilter} onChange={(e) => setPayFilter(e.target.value)}>
              <option value="">כל סטטוסי התשלום</option>
              <option value="open">פתוחות לתשלום</option>
              {Object.entries(INVOICE_PAYMENT_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <input type="month" className="input w-auto!" aria-label="סינון חשבוניות לפי חודש" value={monthFilter} onChange={(e) => setMonthFilter(e.target.value)} />
            {canViewExport && (
              <select className="input w-auto!" aria-label="סינון חשבוניות לפי סטטוס העברה לרואה חשבון" value={exportFilter} onChange={(e) => setExportFilter(e.target.value)}>
                <option value="">כל סטטוסי הרו״ח</option>
                {Object.entries(INVOICE_EXPORT_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
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
