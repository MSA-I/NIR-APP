import { useT } from '../lib/i18n/LocaleProvider';
import { useEffect, useState } from 'react';
import { Eye, RotateCcw } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router';
import { useParamState } from '../lib/useParamState';
import { supabase } from '../lib/supabase';
import { useQuery } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { DataTable, StatusBadge, useToast, Modal, ErrorNote, PageHeader, SkeletonTable, ICON, type Column } from '../components/ui';
import { CREDIT_REASON, CREDIT_STATUS } from '../lib/status';
import { fmtMoneyExact, fmtDate } from '../lib/format';
import { MoneyByCurrency, totalsByCurrency } from '../components/Money';
import type { CreditRequest, CreditStatus } from '../lib/types';
import { fetchAll } from '../lib/supabasePaging';
import { financialSupplierMap } from '../lib/financialSuppliers';

type Row = Omit<CreditRequest, 'supplier' | 'invoice'> & {
  supplier: { name: string };
  invoice: { id: string; invoice_number: string; review_status: string } | null;
};

export default function Credits() {
  const { t } = useT();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { profile, org, organizationAccess } = useAuth();
  const [statusFilter, setStatusFilter] = useParamState('status', 'active');
  const [monthFilter, setMonthFilter] = useParamState('month');
  const [selected, setSelected] = useState<Row | null>(null);

  const { data, loading, fetching, error, refetch } = useQuery(async () => {
    const rows = await fetchAll<Omit<Row, 'supplier'>>((from, to) => supabase.from('credit_requests')
      .select('*, invoice:invoices!p0_credits_invoice_tenant_fk(id, invoice_number, review_status)')
      .order('created_at', { ascending: false }).order('id').range(from, to));
    const suppliers = await financialSupplierMap(rows.map((row) => row.supplier_id));
    return rows.map((row) => ({
      ...row,
      supplier: { name: suppliers.get(row.supplier_id)?.name ?? '—' },
    }));
  });

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

  const rows = (data ?? []).filter((r) =>
    (statusFilter === 'all' || ['open', 'requested', 'received'].includes(r.status)) &&
    (!monthFilter || r.created_at.startsWith(monthFilter)));
  // Summed WITHIN each currency (0217, #277). A supplier can hold a shekel credit and a dollar
  // credit at once, and one header figure covering both would be a number nobody is owed.
  const openTotals = totalsByCurrency((data ?? [])
    .filter((r) => ['open', 'requested', 'received'].includes(r.status)
      && (!monthFilter || r.created_at.startsWith(monthFilter)))
    .map((r) => ({ currency: r.currency, amount: r.amount })));

  const columns: Column<Row>[] = [
    { key: 'num', header: t('credits.numberHeader'), sortValue: (r) => r.number, render: (r) => `#${r.number}` },
    { key: 'supplier', header: t('credits.text'), sortValue: (r) => r.supplier.name, render: (r) => r.supplier.name },
    { key: 'reason', header: t('credits.statusLabel'), render: (r) => CREDIT_REASON[r.reason] },
    { key: 'amount', header: t('credits.fmtMoneyExact'), className: 'num', sortValue: (r) => r.amount, render: (r) => fmtMoneyExact(r.amount, r.currency) },
    { key: 'invoice', header: t('credits.text_2'), render: (r) => r.invoice ? <span dir="ltr">{r.invoice.invoice_number}</span> : '—' },
    { key: 'status', header: t('credits.text_3'), render: (r) => <StatusBadge meta={CREDIT_STATUS[r.status]} /> },
    { key: 'created', header: t('credits.fmtDate'), sortValue: (r) => r.created_at, render: (r) => fmtDate(r.created_at) },
  ];

  if (loading) return <SkeletonTable cols={6} />;
  if (error && !data) return <ErrorNote message={error} />;

  return (
    <div className="space-y-4">
      {error && <ErrorNote message={error} />}
      {fetching && data && <div className="text-xs text-ink-muted" role="status">{t('credits.text_4')}</div>}
      <PageHeader title={<span className="flex items-center gap-2"><RotateCcw size={ICON.xl} aria-hidden="true" /> {t('credits.text_5')}</span>}
        meta={<>{t('credits.fmtMoneyExact_2')} <b className="text-await-fg"><MoneyByCurrency amounts={openTotals} baseCurrency={org?.base_currency} /></b></>} />
      <DataTable rows={rows} columns={columns} searchable
        searchFn={(r, q) => r.supplier.name.toLowerCase().includes(q) || (r.notes ?? '').toLowerCase().includes(q)}
        searchLabel={t('credits.searchLabel')}
        rowLabel={(r) => t('credits.rowLabel', { number: r.number, supplier: r.supplier.name })}
        onRowClick={(r) => setSelected(r)}
        rowActions={(r) => [
          { key: 'open', label: t('credits.setSelected'), icon: Eye, onSelect: () => setSelected(r) },
        ]}
        toolbar={
          <>
            <select className="input w-auto!" aria-label={t('credits.aria_label')} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="active">{t('credits.text_6')}</option>
              <option value="all">{t('credits.text_7')}</option>
            </select>
            <input type="month" className="input w-auto!" aria-label={t('credits.aria_label_2')} value={monthFilter} onChange={(e) => setMonthFilter(e.target.value)} />
          </>
        }
        /* #49, decided 09.08.2026 (package 2): damaged and returned lines joined the receipt
           automation (0087), under the same checkbox the shortage credit uses. What still goes
           through the invoice is everything the receipt cannot know — wrong price, duplicate
           charge — so the subtitle names both routes for what they actually do. */
        emptyTitle={t('credits.emptyTitle')}
        emptySubtitle={t('credits.emptySubtitle')} />

      {selected && (
        <CreditDetail credit={selected} onClose={() => setSelected(null)}
          onChanged={() => { setSelected(null); void refetch(); }}
          onOpenInvoice={(id) => navigate(`/invoices/${id}`)}
          /* owner/office only, mirroring the server. transition_credit_request rejects accountant
             outright (0024:286-288, `v_role not in ('owner','office','kitchen')`), so an
             accountant was shown enabled lifecycle buttons — "קוזז בתשלום" among them — that
             always came back credit_request_transition_not_authorized. Widening the RPC instead
             would be granting a role a financial command, which is the owner's call, not a
             rendering fix. */
          canWrite={organizationAccess.canWrite && !!profile && ['owner', 'office'].includes(profile.role)} />
      )}
    </div>
  );
}

function CreditDetail({ credit, onClose, onChanged, onOpenInvoice, canWrite }: {
  credit: Row; onClose: () => void; onChanged: () => void; onOpenInvoice: (id: string) => void; canWrite: boolean;
}) {
  const { errorText, t } = useT();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const flow: { from: CreditStatus[]; to: CreditStatus; label: string }[] = [
    { from: ['open'], to: 'requested', label: t('credits.text_8') },
    { from: ['requested'], to: 'received', label: t('credits.text_9') },
    { from: ['received'], to: 'offset', label: t('credits.text_10') },
    { from: ['offset'], to: 'closed', label: t('credits.text_11') },
  ];

  async function setStatus(status: CreditStatus) {
    setBusy(true);
    const transition = flow.find((item) => item.to === status && item.from.includes(credit.status));
    const res = await supabase.rpc('transition_credit_request', {
      p_credit_request_id: credit.id,
      p_status: status,
      p_reason: transition?.label ?? t('credits.text_12'),
    });
    setBusy(false);
    if (res.error) { toast(errorText(res.error.message), 'error'); return; }
    toast(t('credits.toast'));
    onChanged();
  }

  return (
    <Modal open onClose={onClose} title={t('credits.modalTitle', { number: credit.number, supplier: credit.supplier.name })} busy={busy} statusMessage={busy ? t('credits.updatingStatus') : undefined}>
      <dl className="text-sm space-y-2 mb-4">
        <div className="flex justify-between"><dt className="text-ink-muted">{t('credits.statusLabel_2')}</dt><dd>{CREDIT_REASON[credit.reason]}</dd></div>
        <div className="flex justify-between"><dt className="text-ink-muted">{t('credits.fmtMoneyExact_3')}</dt><dd className="num font-semibold">{fmtMoneyExact(credit.amount, credit.currency)}</dd></div>
        <div className="flex justify-between"><dt className="text-ink-muted">{t('credits.text_13')}</dt><dd><StatusBadge meta={CREDIT_STATUS[credit.status]} /></dd></div>
        {credit.invoice && (
          <div className="flex justify-between"><dt className="text-ink-muted">{t('credits.text_14')}</dt>
            <dd><button className="link num" onClick={() => onOpenInvoice(credit.invoice!.id)}>{credit.invoice.invoice_number}</button></dd></div>
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
