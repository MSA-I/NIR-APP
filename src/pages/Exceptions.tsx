import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { DataTable, StatusBadge, useToast, Modal, ErrorNote, SkeletonTable, type Column } from '../components/ui';
import { EXCEPTION_TYPE, EXCEPTION_STATUS, SEVERITY } from '../lib/status';
import { fmtDate } from '../lib/format';
import { logAction } from '../lib/audit';
import type { ExceptionRow, ExceptionStatus } from '../lib/types';

type Row = ExceptionRow & { supplier: { name: string } | null };

export default function Exceptions() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { profile, roleLabels } = useAuth();
  const [statusFilter, setStatusFilter] = useState(params.get('status') ?? 'open');
  const [typeFilter, setTypeFilter] = useState(params.get('type') ?? '');
  const [selected, setSelected] = useState<Row | null>(null);

  const { data, loading, error, refetch } = useQuery(async () =>
    unwrap(await supabase.from('exceptions')
      .select('*, supplier:suppliers(name)')
      .order('created_at', { ascending: false })) as Promise<Row[]>);

  const rows = (data ?? []).filter((r) =>
    (statusFilter === 'all' || (statusFilter === 'open' ? ['open', 'in_progress'].includes(r.status) : r.status === statusFilter)) &&
    (!typeFilter || r.type === typeFilter));

  const canWrite = !!profile && ['owner', 'office', 'kitchen'].includes(profile.role);

  const columns: Column<Row>[] = [
    { key: 'severity', header: 'חומרה', sortValue: (r) => r.severity, render: (r) => <StatusBadge meta={SEVERITY[r.severity]} /> },
    { key: 'type', header: 'סוג', render: (r) => <span className="text-slate-600">{EXCEPTION_TYPE[r.type]}</span> },
    { key: 'title', header: 'תיאור', render: (r) => <span className="font-medium text-slate-900 max-w-96 truncate inline-block">{r.title}</span> },
    { key: 'supplier', header: 'ספק', render: (r) => r.supplier?.name ?? '—' },
    { key: 'assigned', header: 'באחריות', render: (r) => (r.assigned_role ? roleLabels[r.assigned_role] : '—') },
    { key: 'created', header: 'נפתח', sortValue: (r) => r.created_at, render: (r) => fmtDate(r.created_at) },
    { key: 'status', header: 'סטטוס', render: (r) => <StatusBadge meta={EXCEPTION_STATUS[r.status]} /> },
  ];

  if (loading) return <SkeletonTable cols={5} />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="space-y-4">
      <h1 className="page-title flex items-center gap-2"><AlertTriangle size={22} className="text-amber-500" /> חריגים</h1>
      <DataTable rows={rows} columns={columns} searchable
        searchFn={(r, q) => r.title.toLowerCase().includes(q) || (r.supplier?.name ?? '').toLowerCase().includes(q)}
        onRowClick={(r) => setSelected(r)}
        toolbar={
          <>
            <select className="input w-auto!" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="open">פתוחים ובטיפול</option>
              <option value="resolved">טופלו</option>
              <option value="dismissed">נדחו</option>
              <option value="all">הכל</option>
            </select>
            <select className="input w-auto!" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="">כל הסוגים</option>
              {Object.entries(EXCEPTION_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </>
        }
        emptyTitle="אין חריגים 🎉" emptySubtitle="חריגים נפתחים אוטומטית מבדיקות חשבוניות, תשלומים והתאמות בנק" />

      {selected && (
        <ExceptionDetail row={selected} canWrite={canWrite}
          onClose={() => setSelected(null)}
          onChanged={() => { setSelected(null); void refetch(); }}
          onNavigate={(path) => navigate(path)} />
      )}
    </div>
  );
}

function ExceptionDetail({ row, canWrite, onClose, onChanged, onNavigate }: {
  row: Row; canWrite: boolean; onClose: () => void; onChanged: () => void; onNavigate: (p: string) => void;
}) {
  const { profile } = useAuth();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function setStatus(status: ExceptionStatus) {
    if (['resolved', 'dismissed'].includes(status) && !note.trim()) {
      toast('נדרשת הערת סיכום לסגירת חריג', 'error');
      return;
    }
    setBusy(true);
    const res = await supabase.from('exceptions').update({
      status,
      resolved_at: ['resolved', 'dismissed'].includes(status) ? new Date().toISOString() : null,
      resolved_by: ['resolved', 'dismissed'].includes(status) ? profile!.id : null,
      resolution_note: note.trim() || null,
    }).eq('id', row.id);
    setBusy(false);
    if (res.error) { toast(res.error.message, 'error'); return; }
    await logAction({ orgId: row.org_id, action: `exception:${status}`, entityType: 'exceptions', entityId: row.id, reason: note.trim() || undefined });
    toast('החריג עודכן');
    onChanged();
  }

  const links: { label: string; path: string }[] = [];
  if (row.invoice_id) links.push({ label: 'לחשבונית', path: `/invoices/${row.invoice_id}` });
  if (row.payment_request_id) links.push({ label: 'לדרישות תשלום', path: '/payment-requests' });
  if (row.bank_transaction_id) links.push({ label: 'להתאמות בנק', path: '/bank' });
  if (row.supplier_id) links.push({ label: 'לכרטיס הספק', path: `/suppliers/${row.supplier_id}` });

  const detailLines: string[] = [];
  if (row.details) {
    for (const [k, v] of Object.entries(row.details)) {
      if (Array.isArray(v)) detailLines.push(...v.map(String));
      else if (k !== 'checks') detailLines.push(`${k}: ${String(v)}`);
    }
  }

  return (
    <Modal open onClose={onClose} title={EXCEPTION_TYPE[row.type]}>
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <StatusBadge meta={SEVERITY[row.severity]} />
          <StatusBadge meta={EXCEPTION_STATUS[row.status]} />
          <span className="text-xs text-slate-400">נפתח {fmtDate(row.created_at)}</span>
        </div>
        <div className="font-medium text-slate-900">{row.title}</div>
        {detailLines.length > 0 && (
          <ul className="text-sm text-slate-600 bg-slate-50 rounded-lg px-4 py-3 space-y-1 list-disc list-inside">
            {detailLines.map((l, i) => <li key={i}>{l}</li>)}
          </ul>
        )}
        {row.resolution_note && (
          <div className="text-sm bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2 text-emerald-800">סיכום: {row.resolution_note}</div>
        )}
        {links.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {links.map((l) => <button key={l.path} className="btn-secondary py-1.5!" onClick={() => onNavigate(l.path)}>{l.label}</button>)}
          </div>
        )}
        {canWrite && ['open', 'in_progress'].includes(row.status) && (
          <>
            <div>
              <label className="label">הערת טיפול / סיכום</label>
              <textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              {row.status === 'open' && <button className="btn-secondary" disabled={busy} onClick={() => void setStatus('in_progress')}>סימון בטיפול</button>}
              <button className="btn-ghost text-slate-500" disabled={busy} onClick={() => void setStatus('dismissed')}>דחייה (לא רלוונטי)</button>
              <button className="btn-primary" disabled={busy} onClick={() => void setStatus('resolved')}>סימון כטופל</button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
