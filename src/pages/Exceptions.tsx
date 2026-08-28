import { useT } from '../lib/i18n/LocaleProvider';
import type { TKey } from '../lib/i18n/t.ts';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useParamState } from '../lib/useParamState';
import { AlertTriangle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { DataTable, StatusBadge, useToast, Modal, ErrorNote, PageHeader, SkeletonTable, Note, ICON, type Column } from '../components/ui';
import { EXCEPTION_TYPE, EXCEPTION_STATUS, SEVERITY } from '../lib/status';
import { fmtDate, fmtMoneyExact } from '../lib/format';
import { logAction } from '../lib/audit';
import { financialSupplierMap } from '../lib/financialSuppliers';
import type { ExceptionRow, ExceptionStatus } from '../lib/types';

type Row = Omit<ExceptionRow, 'supplier'> & { supplier: { name: string } | null };

const DETAIL_LABEL_KEYS: Record<string, TKey> = {
  evidence: 'exceptions.detailEvidence',
  description: 'exceptions.detailDescription',
  date: 'exceptions.detailDate',
  amount: 'exceptions.detailAmount',
  expected: 'exceptions.detailExpected',
  actual: 'exceptions.detailActual',
  difference: 'exceptions.detailDifference',
  reason: 'exceptions.detailReason',
  notes: 'exceptions.detailNotes',
  invoice_number: 'exceptions.detailInvoiceNumber',
  payment_number: 'exceptions.detailPaymentNumber',
};

/**
 * The detail lines a person reads under an exception. The translator is a parameter rather than a
 * hook, because this is a pure function over a row's `details` object and its only caller already
 * has one; making it a component would move a formatting decision into the render tree.
 */
function businessDetailLines(
  details: Record<string, unknown> | null,
  t: (key: TKey, vars?: Record<string, string | number>) => string,
): string[] {
  if (!details) return [];
  return Object.entries(details).flatMap(([key, raw]) => {
    if (raw == null || key === 'code' || key === 'checks') return [];
    const values = Array.isArray(raw)
      ? raw
      : typeof raw === 'object'
        ? Object.values(raw as Record<string, unknown>)
        : [raw];
    const label = t(DETAIL_LABEL_KEYS[key] ?? 'exceptions.detailOther');
    return values.flatMap((value) => {
      if (!['string', 'number', 'boolean'].includes(typeof value)) return [];
      const text = key === 'amount' && typeof value === 'number'
        ? fmtMoneyExact(value)
        : key === 'date' && typeof value === 'string'
          ? fmtDate(value)
          : typeof value === 'boolean'
            ? t(value ? 'exceptions.yes' : 'exceptions.no')
            : String(value);
      return `${label}: ${text}`;
    });
  });
}

export default function Exceptions() {
  const navigate = useNavigate();
  const { profile, roleLabels, organizationAccess } = useAuth();
  const { statusLabel, t } = useT();
  const [statusFilter, setStatusFilter] = useParamState('status', 'open');
  const [typeFilter, setTypeFilter] = useParamState('type');
  const [severityFilter, setSeverityFilter] = useParamState('severity');
  // ?id=<exception_id> from the dashboard/alerts deep-links to a single exception. When set it
  // pins the list to that one row regardless of the other filters (so a resolved exception the
  // dashboard points at still shows); the first dropdown change clears it back to normal filtering.
  const [idFilter, setIdFilter] = useParamState('id');
  const [selected, setSelected] = useState<Row | null>(null);

  const { data, loading, error, refetch } = useQuery(async () => {
    const rows = unwrap(await supabase.from('exceptions').select('*')
      .order('created_at', { ascending: false })) as ExceptionRow[];
    const suppliers = await financialSupplierMap(rows.flatMap((row) => row.supplier_id ? [row.supplier_id] : []));
    return rows.map<Row>((row) => ({
      ...row,
      supplier: row.supplier_id ? { name: suppliers.get(row.supplier_id)?.name ?? '—' } : null,
    }));
  });

  // Deep-link auto-open (audit round 2): arriving via /exceptions?id=X previously pinned the list
  // to that one row but still made the user click it. Open its detail modal once on load so the
  // user lands directly on the resolution flow. The ref caps it to a single open per id, so closing
  // the modal — or a refetch after resolving — does not reopen it; clearing the filter still works.
  const autoOpenedId = useRef<string | null>(null);
  useEffect(() => {
    if (!idFilter || !data) return;
    if (autoOpenedId.current === idFilter) return;
    const match = data.find((r) => r.id === idFilter);
    if (match) { autoOpenedId.current = idFilter; setSelected(match); }
  }, [idFilter, data]);

  const rows = (data ?? []).filter((r) => idFilter
    ? r.id === idFilter
    : (statusFilter === 'all' || (statusFilter === 'open' ? ['open', 'in_progress'].includes(r.status) : r.status === statusFilter)) &&
      (!typeFilter || typeFilter.split(',').includes(r.type)) &&
      (!severityFilter || r.severity === severityFilter));

  const canWrite = organizationAccess.canWrite && !!profile && ['owner', 'office'].includes(profile.role);

  const columns: Column<Row>[] = [
    { key: 'severity', header: t('exceptions.text'), sortValue: (r) => r.severity, render: (r) => <StatusBadge meta={SEVERITY[r.severity]} /> },
    { key: 'type', header: t('exceptions.statusLabel'), render: (r) => <span className="text-ink-soft">{statusLabel(EXCEPTION_TYPE[r.type])}</span> },
    { key: 'title', header: t('exceptions.text_2'), render: (r) => <span className="font-medium text-ink max-w-96 truncate inline-block">{r.title}</span> },
    { key: 'supplier', header: t('exceptions.text_3'), render: (r) => r.supplier?.name ?? '—' },
    { key: 'assigned', header: t('exceptions.text_4'), render: (r) => (r.assigned_role ? roleLabels[r.assigned_role] : '—') },
    { key: 'created', header: t('exceptions.fmtDate'), sortValue: (r) => r.created_at, render: (r) => fmtDate(r.created_at) },
    { key: 'status', header: t('exceptions.text_5'), render: (r) => <StatusBadge meta={EXCEPTION_STATUS[r.status]} /> },
  ];

  if (loading) return <SkeletonTable cols={5} />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="space-y-4">
      <PageHeader title={<span className="flex items-center gap-2"><AlertTriangle size={ICON.xl} className="text-await-fg" aria-hidden="true" /> {t('exceptions.text_6')}</span>}
        meta={t('exceptions.rowsShown', { count: rows.length })} />
      <DataTable rows={rows} columns={columns} searchable
        searchFn={(r, q) => r.title.toLowerCase().includes(q) || (r.supplier?.name ?? '').toLowerCase().includes(q)}
        searchLabel={t('exceptions.searchLabel')}
        rowLabel={(r) => t('exceptions.rowLabel', { title: r.title })}
        onRowClick={(r) => setSelected(r)}
        toolbar={
          <>
            {idFilter && (
              <button className="btn-ghost text-sm text-action" onClick={() => setIdFilter('')}>{t('exceptions.setIdFilter')}</button>
            )}
            <select className="input w-auto!" aria-label={t('exceptions.aria_label')} value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setIdFilter(''); }}>
              <option value="open">{t('exceptions.text_7')}</option>
              <option value="resolved">{t('exceptions.text_8')}</option>
              <option value="dismissed">{t('exceptions.text_9')}</option>
              <option value="all">{t('exceptions.text_10')}</option>
            </select>
            <select className="input w-auto!" aria-label={t('exceptions.aria_label_2')} value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); setIdFilter(''); }}>
              <option value="">{t('exceptions.text_11')}</option>
              {Object.entries(EXCEPTION_TYPE).map(([k, v]) => <option key={k} value={k}>{statusLabel(v)}</option>)}
            </select>
            <select className="input w-auto!" aria-label={t('exceptions.aria_label_3')} value={severityFilter} onChange={(e) => { setSeverityFilter(e.target.value); setIdFilter(''); }}>
              <option value="">{t('exceptions.text_12')}</option>
              {Object.entries(SEVERITY).map(([k, v]) => <option key={k} value={k}>{statusLabel(v)}</option>)}
            </select>
          </>
        }
        emptyTitle={t('exceptions.emptyTitle')} emptySubtitle={t('exceptions.emptySubtitle')} />

      {selected && (
        <ExceptionDetail row={selected} canWrite={canWrite} canOpenProcurement={profile?.role !== 'accountant'}
          onClose={() => setSelected(null)}
          onChanged={() => { setSelected(null); void refetch(); }}
          onNavigate={(path) => navigate(path)} />
      )}
    </div>
  );
}

function ExceptionDetail({ row, canWrite, canOpenProcurement, onClose, onChanged, onNavigate }: {
  row: Row; canWrite: boolean; canOpenProcurement: boolean; onClose: () => void; onChanged: () => void; onNavigate: (p: string) => void;
}) {
  const { errorText, statusLabel, t } = useT();
  const { profile } = useAuth();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function setStatus(status: ExceptionStatus) {
    if (['resolved', 'dismissed'].includes(status) && !note.trim()) {
      toast(t('exceptions.toast'), 'error');
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
    if (res.error) { toast(errorText(res.error.message), 'error'); return; }
    await logAction({ orgId: row.org_id, action: `exception:${status}`, entityType: 'exceptions', entityId: row.id, reason: note.trim() || undefined });
    toast(t('exceptions.toast_2'));
    onChanged();
  }

  const links: { labelKey: TKey; path: string }[] = [];
  if (row.invoice_id) links.push({ labelKey: 'exceptions.linkInvoice', path: `/invoices/${row.invoice_id}` });
  if (row.payment_request_id) links.push({ labelKey: 'exceptions.linkPaymentRequest', path: `/payment-requests?id=${row.payment_request_id}` });
  if (row.bank_transaction_id) links.push({ labelKey: 'exceptions.linkBankTransaction', path: `/bank?id=${row.bank_transaction_id}` });
  if (row.supplier_id) links.push({
    labelKey: canOpenProcurement ? 'exceptions.text_13' : 'exceptions.text_14',
    path: canOpenProcurement ? `/suppliers/${row.supplier_id}` : `/finance/suppliers/${row.supplier_id}`,
  });

  const detailLines = businessDetailLines(row.details, t);

  return (
    <Modal open onClose={onClose} title={statusLabel(EXCEPTION_TYPE[row.type])} busy={busy} statusMessage={busy ? t('exceptions.statusLabel_2') : undefined}>
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <StatusBadge meta={SEVERITY[row.severity]} />
          <StatusBadge meta={EXCEPTION_STATUS[row.status]} />
          <span className="text-xs text-ink-muted">{t('exceptions.openedOn', { date: fmtDate(row.created_at) })}</span>
        </div>
        <div className="font-medium text-ink">{row.title}</div>
        {detailLines.length > 0 && (
          <ul className="text-sm text-ink-soft bg-surface-sunken rounded-lg px-4 py-3 space-y-1 list-disc list-inside">
            {detailLines.map((l, i) => <li key={i}>{l}</li>)}
          </ul>
        )}
        {row.resolution_note && (
          <Note tone="done"><span className="min-w-0 flex-1">{t('exceptions.resolutionSummary', { note: row.resolution_note })}</span></Note>
        )}
        {links.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {links.map((l) => <button key={l.path} className="btn-secondary btn-sm" onClick={() => onNavigate(l.path)}>{t(l.labelKey)}</button>)}
          </div>
        )}
        {canWrite && ['open', 'in_progress'].includes(row.status) && (
          <>
            <div>
              <label className="label" htmlFor="exception-resolution-note">{t('exceptions.text_15')}</label>
              <textarea id="exception-resolution-note" className="input" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              {row.status === 'open' && <button className="btn-secondary" disabled={busy} onClick={() => void setStatus('in_progress')}>{t('exceptions.setStatus')}</button>}
              <button className="btn-ghost text-ink-muted" disabled={busy} onClick={() => void setStatus('dismissed')}>{t('exceptions.setStatus_2')}</button>
              <button className="btn-primary" disabled={busy} onClick={() => void setStatus('resolved')}>{t('exceptions.setStatus_3')}</button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
