import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useParamState } from '../lib/useParamState';
import { Plus, AlertTriangle, AlertOctagon, Info, Pencil, Copy, Share2, Printer, Trash2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { toHebrewError } from '../lib/errors';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { DataTable, StatusBadge, ErrorNote, SkeletonTable, Note, ConfirmDialog, useToast, type Column } from '../components/ui';
import { INVOICE_REVIEW_STATUS, INVOICE_PAYMENT_STATUS, INVOICE_EXPORT_STATUS } from '../lib/status';
import { fmtMoneyExact, fmtDate } from '../lib/format';
import { logAction } from '../lib/audit';
import { canShare, shareInvoice } from '../lib/share';
import type { Invoice } from '../lib/types';
import type { CheckResult } from '../lib/checks';

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
  const [deleteTarget, setDeleteTarget] = useState<InvoiceRow | null>(null);
  const [busyDelete, setBusyDelete] = useState(false);

  const { data, loading, error, refetch } = useQuery(async () => {
    const invoices = unwrap(await supabase.from('invoices')
      .select('*, supplier:suppliers(name)').is('deleted_at', null)
      .order('invoice_date', { ascending: false })) as InvoiceRow[];
    const balances = unwrap(await supabase.from('invoice_balances').select('*')) as { invoice_id: string; balance: number }[];
    const balMap = new Map(balances.map((b) => [b.invoice_id, b.balance]));
    return invoices.map((i) => ({ ...i, balance: balMap.get(i.id) }));
  });

  const rows = useMemo(() => (data ?? []).filter((r) =>
    (!reviewFilter || r.review_status === reviewFilter) &&
    (!payFilter || r.payment_status === payFilter) &&
    (!exportFilter || r.export_status === exportFilter)), [data, reviewFilter, payFilter, exportFilter]);

  const canCreate = profile && ['owner', 'office', 'kitchen'].includes(profile.role);
  const isOffice = profile && ['owner', 'office'].includes(profile.role);

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
    { key: 'number', header: 'מס׳ חשבונית', priority: 3, sortValue: (r) => r.invoice_number, render: (r) => <span className="font-medium text-ink" dir="ltr">{r.invoice_number}</span> },
    { key: 'supplier', header: 'ספק', priority: 3, sortValue: (r) => r.supplier.name, render: (r) => r.supplier.name },
    { key: 'date', header: 'תאריך', sortValue: (r) => r.invoice_date, render: (r) => fmtDate(r.invoice_date) },
    { key: 'total', header: 'סה״כ', className: 'num', sortValue: (r) => r.total_amount, render: (r) => fmtMoneyExact(r.total_amount) },
    { key: 'balance', header: 'יתרה', className: 'num', sortValue: (r) => r.balance ?? 0, render: (r) => (r.balance != null && r.balance > 0 ? <span className="text-await-fg">{fmtMoneyExact(r.balance)}</span> : <span className="text-done-solid">—</span>) },
    { key: 'review', header: 'בדיקה', mobileLabel: null, render: (r) => <StatusBadge meta={INVOICE_REVIEW_STATUS[r.review_status]} /> },
    { key: 'payment', header: 'תשלום', priority: 3, render: (r) => <StatusBadge meta={INVOICE_PAYMENT_STATUS[r.payment_status]} /> },
    { key: 'export', header: 'רו״ח', priority: 3, render: (r) => <StatusBadge meta={INVOICE_EXPORT_STATUS[r.export_status]} /> },
  ];

  if (loading) return <SkeletonTable cols={6} />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="page-title">חשבוניות</h1>
        {canCreate && <button className="btn-primary" onClick={() => navigate('/invoices/new')}><Plus size={16} /> חשבונית חדשה</button>}
      </div>
      <DataTable rows={rows} columns={columns} searchable
        searchFn={(r, q) => r.invoice_number.toLowerCase().includes(q) || r.supplier.name.toLowerCase().includes(q)}
        onRowClick={(r) => navigate(`/invoices/${r.id}`)}
        mobile="cards"
        mobileTitle={(r) => <><span dir="ltr">{r.invoice_number}</span> · {r.supplier.name}</>}
        mobileTrailing={(r) => <StatusBadge meta={INVOICE_PAYMENT_STATUS[r.payment_status]} />}
        rowActions={(r) => [
          { key: 'edit', label: 'עריכה', icon: Pencil, onSelect: () => navigate(`/invoices/${r.id}`) },
          { key: 'duplicate', label: 'שכפול כטיוטה', icon: Copy, hidden: !canCreate, onSelect: () => navigate(`/invoices/new?from=${r.id}`) },
          { key: 'share', label: 'שליחה', icon: Share2, hidden: !canShare(), onSelect: () => void shareInvoice(r, r.supplier.name) },
          { key: 'print', label: 'הדפסה', icon: Printer, onSelect: () => navigate(`/invoices/${r.id}?print=1`) },
          { key: 'delete', label: 'מחיקה', icon: Trash2, tone: 'danger', hidden: !isOffice, onSelect: () => setDeleteTarget(r) },
        ]}
        toolbar={
          <>
            <select className="input w-auto!" value={reviewFilter} onChange={(e) => setReviewFilter(e.target.value)}>
              <option value="">כל סטטוסי הבדיקה</option>
              {Object.entries(INVOICE_REVIEW_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <select className="input w-auto!" value={payFilter} onChange={(e) => setPayFilter(e.target.value)}>
              <option value="">כל סטטוסי התשלום</option>
              {Object.entries(INVOICE_PAYMENT_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <select className="input w-auto!" value={exportFilter} onChange={(e) => setExportFilter(e.target.value)}>
              <option value="">כל סטטוסי הרו״ח</option>
              {Object.entries(INVOICE_EXPORT_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
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
