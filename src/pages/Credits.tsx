import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { toHebrewError } from '../lib/errors';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useParamState } from '../lib/useParamState';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { DataTable, StatusBadge, useToast, Modal, ErrorNote, SkeletonTable, type Column } from '../components/ui';
import { CREDIT_REASON, CREDIT_STATUS } from '../lib/status';
import { fmtMoneyExact, fmtDate } from '../lib/format';
import { refreshInvoicePaymentStatus } from '../lib/checks';
import { logAction } from '../lib/audit';
import type { CreditRequest, CreditStatus } from '../lib/types';

type Row = CreditRequest & { supplier: { name: string }; invoice: { id: string; invoice_number: string } | null };

export default function Credits() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { profile } = useAuth();
  const [statusFilter, setStatusFilter] = useParamState('status', 'active');
  const [selected, setSelected] = useState<Row | null>(null);

  const { data, loading, error, refetch } = useQuery(async () =>
    unwrap(await supabase.from('credit_requests')
      .select('*, supplier:suppliers(name), invoice:invoices(id, invoice_number)')
      .order('created_at', { ascending: false })) as Promise<Row[]>);

  // Open a credit card straight from a global-search result (?id=). Clear the param once
  // consumed so closing the modal doesn't reopen it and the URL stays clean.
  useEffect(() => {
    const id = params.get('id');
    if (!id || !data) return;
    const row = data.find((r) => r.id === id);
    if (row) setSelected(row);
    const next = new URLSearchParams(params);
    next.delete('id');
    setParams(next, { replace: true });
  }, [params, data, setParams]);

  const rows = (data ?? []).filter((r) => statusFilter === 'all' || ['open', 'requested', 'received'].includes(r.status));
  const openSum = (data ?? []).filter((r) => ['open', 'requested', 'received'].includes(r.status)).reduce((s, r) => s + r.amount, 0);

  const columns: Column<Row>[] = [
    { key: 'num', header: 'מס׳', sortValue: (r) => r.number, render: (r) => `#${r.number}` },
    { key: 'supplier', header: 'ספק', sortValue: (r) => r.supplier.name, render: (r) => r.supplier.name },
    { key: 'reason', header: 'סיבה', render: (r) => CREDIT_REASON[r.reason] },
    { key: 'amount', header: 'סכום', className: 'num', sortValue: (r) => r.amount, render: (r) => fmtMoneyExact(r.amount) },
    { key: 'invoice', header: 'חשבונית', render: (r) => r.invoice ? <span dir="ltr">{r.invoice.invoice_number}</span> : '—' },
    { key: 'status', header: 'סטטוס', render: (r) => <StatusBadge meta={CREDIT_STATUS[r.status]} /> },
    { key: 'created', header: 'נפתח', sortValue: (r) => r.created_at, render: (r) => fmtDate(r.created_at) },
  ];

  if (loading) return <SkeletonTable cols={6} />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="page-title flex items-center gap-2"><RotateCcw size={22} /> זיכויים</h1>
        {/* open credits are open work (house idiom: "an open balance is open work") — await, not the retired violet (audit 2026-07-21) */}
        <div className="text-sm text-ink-muted">סה״כ זיכויים פתוחים: <b className="num text-await-fg">{fmtMoneyExact(openSum)}</b></div>
      </div>
      <DataTable rows={rows} columns={columns} searchable
        searchFn={(r, q) => r.supplier.name.toLowerCase().includes(q) || (r.notes ?? '').toLowerCase().includes(q)}
        onRowClick={(r) => setSelected(r)}
        toolbar={
          <select className="input w-auto!" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="active">זיכויים פעילים</option>
            <option value="all">הכל</option>
          </select>
        }
        emptyTitle="אין זיכויים" emptySubtitle="דרישות זיכוי נפתחות ממסך קבלת סחורה או מחשבונית" />

      {selected && (
        <CreditDetail credit={selected} onClose={() => setSelected(null)}
          onChanged={() => { setSelected(null); void refetch(); }}
          onOpenInvoice={(id) => navigate(`/invoices/${id}`)}
          canWrite={!!profile && ['owner', 'office', 'kitchen'].includes(profile.role)} />
      )}
    </div>
  );
}

function CreditDetail({ credit, onClose, onChanged, onOpenInvoice, canWrite }: {
  credit: Row; onClose: () => void; onChanged: () => void; onOpenInvoice: (id: string) => void; canWrite: boolean;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const flow: { from: CreditStatus[]; to: CreditStatus; label: string }[] = [
    { from: ['open'], to: 'requested', label: 'נדרש מהספק' },
    { from: ['requested', 'open'], to: 'received', label: 'הזיכוי התקבל' },
    { from: ['received'], to: 'offset', label: 'קוזז בתשלום' },
    { from: ['received', 'offset'], to: 'closed', label: 'סגירה' },
  ];

  async function setStatus(status: CreditStatus) {
    setBusy(true);
    const res = await supabase.from('credit_requests').update({
      status, resolved_at: ['offset', 'closed', 'received'].includes(status) ? new Date().toISOString() : null,
    }).eq('id', credit.id);
    setBusy(false);
    if (res.error) { toast(toHebrewError(res.error.message), 'error'); return; }
    await logAction({ orgId: credit.org_id, action: `credit_status:${status}`, entityType: 'credit_requests', entityId: credit.id });
    // offset credits change the linked invoice's effective balance
    if (credit.invoice && ['offset', 'closed'].includes(status)) await refreshInvoicePaymentStatus(credit.invoice.id);
    toast('סטטוס הזיכוי עודכן');
    onChanged();
  }

  return (
    <Modal open onClose={onClose} title={`זיכוי #${credit.number} — ${credit.supplier.name}`}>
      <dl className="text-sm space-y-2 mb-4">
        <div className="flex justify-between"><dt className="text-ink-muted">סיבה</dt><dd>{CREDIT_REASON[credit.reason]}</dd></div>
        <div className="flex justify-between"><dt className="text-ink-muted">סכום</dt><dd className="num font-semibold">{fmtMoneyExact(credit.amount)}</dd></div>
        <div className="flex justify-between"><dt className="text-ink-muted">סטטוס</dt><dd><StatusBadge meta={CREDIT_STATUS[credit.status]} /></dd></div>
        {credit.invoice && (
          <div className="flex justify-between"><dt className="text-ink-muted">חשבונית</dt>
            <dd><button className="link" onClick={() => onOpenInvoice(credit.invoice!.id)}>{credit.invoice.invoice_number}</button></dd></div>
        )}
        {credit.notes && <div className="bg-surface-sunken rounded-lg px-3 py-2 text-ink-soft">{credit.notes}</div>}
      </dl>
      {canWrite && (
        <div className="flex flex-wrap gap-2 justify-end">
          {flow.filter((f) => f.from.includes(credit.status)).map((f) => (
            <button key={f.to} className="btn-primary" disabled={busy} onClick={() => void setStatus(f.to)}>{f.label}</button>
          ))}
        </div>
      )}
    </Modal>
  );
}
