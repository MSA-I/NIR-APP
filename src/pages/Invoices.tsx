import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, AlertTriangle, AlertOctagon, Info } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { DataTable, StatusBadge, ErrorNote, SkeletonTable, type Column } from '../components/ui';
import { INVOICE_REVIEW_STATUS, INVOICE_PAYMENT_STATUS, INVOICE_EXPORT_STATUS } from '../lib/status';
import { fmtMoneyExact, fmtDate } from '../lib/format';
import type { Invoice } from '../lib/types';
import type { CheckResult } from '../lib/checks';

export type InvoiceRow = Invoice & { supplier: { name: string }; balance?: number };

/** Shared renderer for automatic-check results. */
export function CheckList({ checks }: { checks: CheckResult[] }) {
  if (!checks.length) {
    return <div className="rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm px-4 py-2.5">כל הבדיקות האוטומטיות עברו ללא ממצאים.</div>;
  }
  const icon = { critical: AlertOctagon, warning: AlertTriangle, info: Info };
  const cls = {
    critical: 'bg-rose-50 border-rose-200 text-rose-800',
    warning: 'bg-amber-50 border-amber-200 text-amber-800',
    info: 'bg-sky-50 border-sky-200 text-sky-800',
  };
  return (
    <div className="space-y-2">
      {checks.map((c, i) => {
        const Icon = icon[c.severity];
        return (
          <div key={i} className={`flex items-start gap-2 rounded-lg border px-3.5 py-2.5 text-sm ${cls[c.severity]}`}>
            <Icon size={16} className="mt-0.5 shrink-0" />
            <span>{c.message}</span>
          </div>
        );
      })}
    </div>
  );
}

export function InvoicesList() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { profile } = useAuth();
  const [reviewFilter, setReviewFilter] = useState(params.get('review') ?? '');
  const [payFilter, setPayFilter] = useState(params.get('pay') ?? '');

  const { data, loading, error } = useQuery(async () => {
    const invoices = unwrap(await supabase.from('invoices')
      .select('*, supplier:suppliers(name)').is('deleted_at', null)
      .order('invoice_date', { ascending: false })) as InvoiceRow[];
    const balances = unwrap(await supabase.from('invoice_balances').select('*')) as { invoice_id: string; balance: number }[];
    const balMap = new Map(balances.map((b) => [b.invoice_id, b.balance]));
    return invoices.map((i) => ({ ...i, balance: balMap.get(i.id) }));
  });

  const rows = useMemo(() => (data ?? []).filter((r) =>
    (!reviewFilter || r.review_status === reviewFilter) &&
    (!payFilter || r.payment_status === payFilter)), [data, reviewFilter, payFilter]);

  const canCreate = profile && ['owner', 'office', 'kitchen'].includes(profile.role);

  const columns: Column<InvoiceRow>[] = [
    { key: 'number', header: 'מס׳ חשבונית', sortValue: (r) => r.invoice_number, render: (r) => <span className="font-medium text-slate-900" dir="ltr">{r.invoice_number}</span> },
    { key: 'supplier', header: 'ספק', sortValue: (r) => r.supplier.name, render: (r) => r.supplier.name },
    { key: 'date', header: 'תאריך', sortValue: (r) => r.invoice_date, render: (r) => fmtDate(r.invoice_date) },
    { key: 'total', header: 'סה״כ', className: 'num', sortValue: (r) => r.total_amount, render: (r) => fmtMoneyExact(r.total_amount) },
    { key: 'balance', header: 'יתרה', className: 'num', sortValue: (r) => r.balance ?? 0, render: (r) => (r.balance != null && r.balance > 0 ? <span className="text-amber-700">{fmtMoneyExact(r.balance)}</span> : <span className="text-emerald-600">—</span>) },
    { key: 'review', header: 'בדיקה', render: (r) => <StatusBadge meta={INVOICE_REVIEW_STATUS[r.review_status]} /> },
    { key: 'payment', header: 'תשלום', render: (r) => <StatusBadge meta={INVOICE_PAYMENT_STATUS[r.payment_status]} /> },
    { key: 'export', header: 'רו״ח', render: (r) => <StatusBadge meta={INVOICE_EXPORT_STATUS[r.export_status]} /> },
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
          </>
        } />
    </div>
  );
}
