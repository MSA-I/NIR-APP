import { useT } from '../lib/i18n/LocaleProvider';
import { useEffect, useMemo, useRef, useState } from 'react';
import { reasonOr } from '../lib/reason';
import { reasonDemandFor } from '../lib/transitionIntent';
import { useSearchParams } from 'react-router';
import { useParamState } from '../lib/useParamState';
import { Plus, Loader2, Send, CheckCircle2, ShieldAlert, XCircle, Pencil } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { DataTable, StatusBadge, useToast, Modal, ConfirmDialog, Disclosure, ErrorNote, Note, PageHeader, SkeletonTable, SubPanel, ICON, type Column } from '../components/ui';
import { CheckList } from './Invoices';
import { checkText, runPaymentRequestChecks, type CheckResult } from '../lib/checks';
import { summarizeChecks, type ChecksSummary } from '../lib/checkSummary';
import { PAYMENT_REQUEST_STATUS } from '../lib/status';
import { addCalendarDays, fmtMoneyExact, fmtDate, todayISO } from '../lib/format';
import type { PaymentRequest, PaymentRequestStatus } from '../lib/types';
import { fetchAll, fetchInChunks } from '../lib/supabasePaging';
import { paymentRequestCheckFingerprint } from '../lib/checkFingerprint';
import { SupplierSelectField, useQuickSupplier, type SupplierOption } from '../components/QuickSupplierPicker';
import { financialSupplierMap, readFinancialSuppliers } from '../lib/financialSuppliers';

type Row = Omit<PaymentRequest, 'supplier'> & { supplier: { name: string }; approver: { full_name: string } | null };
type RawRow = Omit<Row, 'supplier'>;
type PaymentInvoiceCandidate = {
  id: string;
  invoice_number: string;
  invoice_date: string;
  total_amount: number;
  /** The invoice's own currency (0217) — and, once picked, the whole request's. */
  currency: string;
  review_status: string;
  payment_status: string;
  balance: number | null;
  allocationAmount: number;
};

export default function PaymentRequests() {
  const [params, setParams] = useSearchParams();
  const { profile, organizationAccess } = useAuth();
  const { errorText, statusLabel, t } = useT();
  const toast = useToast();
  const [statusFilter, setStatusFilter] = useParamState('status', 'active');
  const [dueFilter, setDueFilter] = useParamState('due');
  const [manualCreateOpen, setManualCreateOpen] = useState(false);
  const presetInvoiceId = params.get('new');
  const idFilter = params.get('id');
  const createOpen = organizationAccess.canWrite && (manualCreateOpen || !!presetInvoiceId);
  const [selected, setSelected] = useState<Row | null>(null);
  const autoOpenedId = useRef<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Row | null>(null);
  const [busyCancel, setBusyCancel] = useState(false);

  function closeCreate() {
    setManualCreateOpen(false);
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete('new');
      return next;
    }, { replace: true });
  }

  const { data, loading, fetching, error, refetch } = useQuery(async () => {
    const rows = await fetchAll<RawRow>((from, to) => supabase.from('payment_requests')
      .select('*, approver:profiles!p0_pr_approved_actor_tenant_fk(full_name)')
      .order('created_at', { ascending: false }).order('id').range(from, to));
    const suppliers = await financialSupplierMap(rows.map((row) => row.supplier_id));
    return rows.map<Row>((row) => ({
      ...row,
      supplier: { name: suppliers.get(row.supplier_id)?.name ?? '—' },
    }));
  });

  useEffect(() => {
    if (!idFilter || !data || autoOpenedId.current === idFilter) return;
    const match = data.find((request) => request.id === idFilter);
    if (match) { autoOpenedId.current = idFilter; setSelected(match); }
  }, [idFilter, data]);

  const today = todayISO();  // local calendar day; due_date is a plain date, string compare is correct
  // +6, not +7: the window is seven days INCLUDING today, which is what the dashboard tile
  // says and what management_dashboard_snapshot measures since 0168. `today + 7` spans eight.
  const dueSoon = addCalendarDays(today, 6);
  const rows = (data ?? []).filter((r) => {
    if (idFilter) return r.id === idFilter;
    const active = !['matched', 'cancelled', 'executed'].includes(r.status);
    const statusOk = statusFilter === 'all' ? true : statusFilter === 'active' ? active : r.status === statusFilter;
    const dueOk = !dueFilter ? true
      : dueFilter === 'today' ? active && r.due_date === today
      : dueFilter === 'overdue' ? active && !!r.due_date && r.due_date < today
      // Drafts are excluded here for the same reason 0168 excludes them from the aggregate:
      // a request still being written is not a claim on cash. Keeping them would show more
      // rows than the tile counted, and the tile is where people arrive from.
      : dueFilter === 'soon' ? ['pending_approval', 'approved', 'sent_for_execution', 'investigation', 'suspected_duplicate'].includes(r.status) && !!r.due_date && r.due_date <= dueSoon
      : true;
    return statusOk && dueOk;
  });

  const isOffice = organizationAccess.canWrite && !!profile && ['owner', 'office'].includes(profile.role);

  // Mirrors the detail modal's cancel flow: status → cancelled, reason recorded in audit_logs.
  // Terminal statuses (cancelled/executed/matched — same set the detail modal treats as final)
  // hide the action entirely.
  async function cancelRequest(reason?: string) {
    if (!cancelTarget) return;
    setBusyCancel(true);
    const res = await supabase.rpc('transition_payment_request', {
      p_payment_request_id: cancelTarget.id,
      p_target_status: 'cancelled',
      p_reason: reason?.trim() || null,
    });
    setBusyCancel(false);
    if (res.error) { setCancelTarget(null); toast(errorText(res.error.message), 'error'); return; }
    setCancelTarget(null);
    toast(t('paymentRequests.toast'));
    void refetch();
  }

  const columns: Column<Row>[] = [
    { key: 'num', header: t('paymentRequests.numHeader'), priority: 3, className: 'num', sortValue: (r) => r.number, render: (r) => `#${r.number}` },
    { key: 'supplier', header: t('paymentRequests.text'), priority: 3, sortValue: (r) => r.supplier.name, render: (r) => r.supplier.name },
    { key: 'amount', header: t('paymentRequests.fmtMoneyExact'), mobileLabel: null, className: 'num', sortValue: (r) => r.amount, render: (r) => <span className="font-semibold">{fmtMoneyExact(r.amount, r.currency)}</span> },
    { key: 'due', header: t('paymentRequests.fmtDate'), sortValue: (r) => r.due_date ?? '', render: (r) => fmtDate(r.due_date) },
    { key: 'status', header: t('paymentRequests.text_2'), priority: 3, render: (r) => <StatusBadge meta={PAYMENT_REQUEST_STATUS[r.status]} /> },
    { key: 'created', header: t('paymentRequests.fmtDate_2'), priority: 3, sortValue: (r) => r.created_at, render: (r) => fmtDate(r.created_at) },
  ];

  if (loading) return <SkeletonTable cols={6} />;
  if (error && !data) return <ErrorNote message={error} />;

  return (
    <div className="space-y-4">
      {error && <ErrorNote message={error} />}
      {fetching && data && <div className="text-xs text-ink-muted" role="status">{t('paymentRequests.text_3')}</div>}
      <div data-tour-anchor="payment-requests-overview">
      <PageHeader title={t('paymentRequests.pageTitle')} meta={t('paymentRequests.pageMeta', { count: rows.length })}
        actions={<>
          {/* The owner's emergency execution route was removed (G4, 10.08.2026). An approved
              request is executed on /pay, with the same step-up, the same mandatory reason and
              the same audit row the emergency path had. */}
          {isOffice && <button className="btn-primary" onClick={() => setManualCreateOpen(true)}><Plus size={ICON.sm} aria-hidden="true" /> {t('paymentRequests.setManualCreateOpen')}</button>}
        </>} />
      </div>
      <DataTable rows={rows} columns={columns} searchable
        emptyTitle={t('paymentRequests.emptyTitle')}
        emptySubtitle={t('paymentRequests.text_4')}
        searchFn={(r, q) => r.supplier.name.toLowerCase().includes(q) || String(r.number).includes(q)}
        searchLabel={t('paymentRequests.searchLabel')}
        rowLabel={(r) => t('paymentRequests.rowLabel', { number: r.number, supplier: r.supplier.name })}
        onRowClick={(r) => setSelected(r)}
        mobile="cards"
        mobileTitle={(r) => <>#{r.number} · {r.supplier.name}</>}
        mobileTrailing={(r) => <StatusBadge meta={PAYMENT_REQUEST_STATUS[r.status]} />}
        rowActions={(r) => [
          { key: 'edit', label: t('paymentRequests.setSelected'), icon: Pencil, onSelect: () => setSelected(r) },
          {
            key: 'cancel', label: t('paymentRequests.text_5'), icon: XCircle, tone: 'danger',
            hidden: !isOffice || ['cancelled', 'executed', 'matched'].includes(r.status),
            onSelect: () => setCancelTarget(r),
          },
        ]}
        toolbar={
          <>
            {idFilter && (
              <button className="btn-ghost text-sm text-action" onClick={() => {
                setParams((current) => {
                  const next = new URLSearchParams(current);
                  next.delete('id');
                  return next;
                }, { replace: true });
              }}>{t('paymentRequests.text_6')}</button>
            )}
            <select className="input w-auto!" aria-label={t('paymentRequests.aria_label')} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="active">{t('paymentRequests.text_7')}</option>
              <option value="all">{t('paymentRequests.text_8')}</option>
              {Object.entries(PAYMENT_REQUEST_STATUS).map(([k, v]) => <option key={k} value={k}>{statusLabel(v)}</option>)}
            </select>
            <select className="input w-auto!" aria-label={t('paymentRequests.aria_label_2')} value={dueFilter} onChange={(e) => setDueFilter(e.target.value)}>
              <option value="">{t('paymentRequests.text_9')}</option>
              <option value="today">{t('paymentRequests.text_10')}</option>
              <option value="overdue">{t('paymentRequests.text_11')}</option>
              <option value="soon">{t('paymentRequests.text_12')}</option>
            </select>
          </>
        } />

      {createOpen && (
        <CreatePaymentRequest key={presetInvoiceId ?? 'manual'} presetInvoiceId={presetInvoiceId} onClose={closeCreate}
          onSaved={() => { closeCreate(); void refetch(); }} />
      )}
      {selected && (
        <PaymentRequestDetail pr={selected} isOffice={isOffice} onClose={() => setSelected(null)}
          onChanged={() => { setSelected(null); void refetch(); }} />
      )}

      <ConfirmDialog open={!!cancelTarget} onClose={() => setCancelTarget(null)}
        onConfirm={(reason) => void cancelRequest(reason)}
        title={t('paymentRequests.title')} message={t('paymentRequests.message')}
        danger requireReason busy={busyCancel} />
    </div>
  );
}

/* ---------- creation ---------- */
function CreatePaymentRequest({ presetInvoiceId, onClose, onSaved }: {
  presetInvoiceId: string | null; onClose: () => void; onSaved: () => void;
}) {
  const { errorText, t } = useT();
  const { profile, org } = useAuth();
  const toast = useToast();
  const [supplierId, setSupplierId] = useState('');
  const [chosen, setChosen] = useState<Record<string, number>>({}); // invoice_id -> allocation
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');
  const [requestId] = useState(() => crypto.randomUUID());
  const [checked, setChecked] = useState<{ fingerprint: string; results: CheckResult[] } | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const checkSequence = useRef(0);
  const [busy, setBusy] = useState(false);
  const isOwner = profile?.role === 'owner';

  const { data: suppliers, loading: suppliersLoading, error: suppliersError } = useQuery<SupplierOption[]>(async () =>
    (await readFinancialSuppliers()).sort((a, b) => a.name.localeCompare(b.name, 'he')));

  // Changing the supplier — by picking one or by creating one — invalidates the chosen invoices,
  // which belong to the previous supplier. One callback, so neither route can forget it.
  const supplierPicker = useQuickSupplier(suppliers, (nextSupplierId) => {
    setSupplierId(nextSupplierId);
    setChosen({});
  });

  const { data: invoices, loading: invoicesLoading, error: invoicesError } = useQuery(async () => {
    if (!supplierId) return [];
    const inv = await fetchAll<Omit<PaymentInvoiceCandidate, 'balance' | 'allocationAmount'>>((from, to) => {
      let query = supabase.from('invoices')
        .select('id, invoice_number, invoice_date, total_amount, currency, review_status, payment_status')
        .eq('supplier_id', supplierId).eq('financial_role', 'payable').is('deleted_at', null);
      // Procurement may use the invoice total only while the invoice is wholly unpaid. Once
      // partial, its exact balance belongs to the owner/accounting boundary.
      query = isOwner ? query.neq('payment_status', 'paid') : query.eq('payment_status', 'unpaid');
      return query.order('invoice_date').order('id').range(from, to);
    });
    const ids = inv.map((i) => i.id);
    const bals = isOwner && ids.length ? await fetchInChunks(ids, (chunk) => fetchAll<{ invoice_id: string; balance_in_currency: number }>((from, to) => supabase.from('invoice_balances_by_currency')
      .select('invoice_id, balance_in_currency').in('invoice_id', chunk).order('invoice_id').range(from, to))) : [];
    const balMap = new Map(bals.map((b) => [b.invoice_id, b.balance_in_currency]));
    return inv.flatMap<PaymentInvoiceCandidate>((i) => {
      const balance = isOwner ? balMap.get(i.id) ?? null : null;
      const allocationAmount = isOwner ? balance : i.total_amount;
      return allocationAmount != null && allocationAmount > 0
        ? [{ ...i, balance, allocationAmount }]
        : [];
    });
  }, [supplierId, isOwner]);

  // preset from invoice detail page
  useEffect(() => {
    if (!presetInvoiceId) return;
    let cancelled = false;
    void (async () => {
      const invoiceResult = await supabase.from('invoices').select('id, supplier_id, total_amount, currency, payment_status')
        .eq('id', presetInvoiceId).eq('financial_role', 'payable').is('deleted_at', null).neq('payment_status', 'paid').maybeSingle();
      if (cancelled) return;
      if (invoiceResult.error || !invoiceResult.data) {
        toast(t('paymentRequests.toast_2'), 'error');
        onClose();
        return;
      }
      const inv = invoiceResult.data as { id: string; supplier_id: string; total_amount: number; currency: string; payment_status: string };
      if (!isOwner && inv.payment_status !== 'unpaid') {
        toast(t('paymentRequests.toast_3'), 'error');
        onClose();
        return;
      }
      let allocationAmount = inv.total_amount;
      if (isOwner) {
        const balanceResult = await supabase.from('invoice_balances_by_currency').select('balance_in_currency').eq('invoice_id', inv.id).maybeSingle();
        if (cancelled) return;
        if (balanceResult.error || !balanceResult.data) {
          toast(t('paymentRequests.toast_4'), 'error');
          onClose();
          return;
        }
        allocationAmount = (balanceResult.data as { balance_in_currency: number }).balance_in_currency;
      }
      if (allocationAmount <= 0) {
        toast(t('paymentRequests.toast_5'), 'error');
        onClose();
        return;
      }
      setSupplierId(inv.supplier_id);
      setChosen({ [inv.id]: allocationAmount });
    })().catch(() => {
      if (!cancelled) {
        toast(t('paymentRequests.toast_6'), 'error');
        onClose();
      }
    });
    return () => { cancelled = true; };
    // `onClose` and `toast` are context callbacks; the deep-link id owns this request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetInvoiceId, isOwner]);

  /* A PAYMENT REQUEST IS ONE TRANSFER, SO IT IS ONE CURRENCY (0217, #277). `amount` is the sum
     of the ticked allocations, and a sum only exists inside one currency — so the first ticked
     invoice fixes the request's currency and the rest of the list is refused by name rather than
     silently added on top. Nothing here converts: a supplier billing in two currencies is paid by
     two transfers, which is the same thing the supplier's balance already says. */
  const requestCurrency = useMemo(() => {
    const first = Object.keys(chosen).find((id) => (chosen[id] ?? 0) >= 0);
    return (invoices ?? []).find((invoice) => invoice.id === first)?.currency ?? null;
  }, [chosen, invoices]);
  const amount = useMemo(() => Object.values(chosen).reduce((s, v) => s + v, 0), [chosen]);
  const invoiceIds = Object.entries(chosen).filter(([, value]) => value > 0).map(([id]) => id);
  const checkFingerprint = supplierId && amount > 0
    ? paymentRequestCheckFingerprint({ supplierId, amount, invoiceIds })
    : null;
  const latestFingerprint = useRef(checkFingerprint);
  latestFingerprint.current = checkFingerprint;

  useEffect(() => {
    const sequence = ++checkSequence.current;
    setChecked(null);
    setCheckError(null);
    if (!checkFingerprint) { setChecking(false); return; }
    setChecking(true);
    const timer = setTimeout(() => {
      void runPaymentRequestChecks({ supplier_id: supplierId, amount, invoiceIds }).then((results) => {
        if (checkSequence.current === sequence && latestFingerprint.current === checkFingerprint) {
          setChecked({ fingerprint: checkFingerprint, results });
        }
      }).catch(() => {
        if (checkSequence.current === sequence) setCheckError(t('paymentRequests.setCheckError'));
      }).finally(() => {
        if (checkSequence.current === sequence) setChecking(false);
      });
    }, 400);
    return () => {
      clearTimeout(timer);
      if (checkSequence.current === sequence) checkSequence.current += 1;
    };
  }, [checkFingerprint]);

  const checks = checked?.fingerprint === checkFingerprint ? checked.results : null;
  const hasCritical = checks?.some((c) => c.severity === 'critical') ?? false;
  const supplierName = supplierPicker.suppliers.find((supplier) => supplier.id === supplierId)?.name ?? t('paymentRequests.find');
  const checksReady = checkFingerprint != null && checks != null && !checking && !checkError;

  async function save(toApproval: boolean) {
    if (!supplierId || amount <= 0) { toast(t('paymentRequests.toast_7'), 'error'); return; }
    if (!checkFingerprint || !checksReady) {
      toast(checkError ?? t('paymentRequests.toast_8'), 'error');
      return;
    }
    setBusy(true);
    try {
      let freshChecks: CheckResult[];
      try {
        freshChecks = await runPaymentRequestChecks({ supplier_id: supplierId, amount, invoiceIds });
      } catch (checkFailure) {
        setChecked(null);
        setCheckError(t('paymentRequests.setCheckError_2'));
        throw checkFailure;
      }
      if (latestFingerprint.current !== checkFingerprint) throw new Error(t('paymentRequests.Error'));
      setChecked({ fingerprint: checkFingerprint, results: freshChecks });
      setCheckError(null);
      const pr = unwrap(await supabase.rpc('create_payment_request', {
        p_request_id: requestId,
        p_supplier_id: supplierId,
        p_due_date: dueDate || null,
        p_notes: notes.trim() || null,
        p_requested_status: toApproval ? 'pending_approval' : 'draft',
        p_allocations: Object.entries(chosen).filter(([, value]) => value > 0)
          .map(([invoice_id, value]) => ({ invoice_id, amount: value })),
        p_reason: reasonOr(reason, 'יצירת דרישת תשלום'),
      })) as { payment_request_id: string; number: number; status: PaymentRequestStatus };

      if (pr.status === 'suspected_duplicate') {
        toast(t('paymentRequests.toast_9'), 'error');
      } else {
        toast(toApproval ? t('paymentRequests.toast_10') : t('paymentRequests.toast_11'));
      }
      onSaved();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={t('paymentRequests.title_2')} wide busy={busy} statusMessage={busy ? t('paymentRequests.text_13') : undefined}>
      <div className="space-y-4">
        {suppliersError && <ErrorNote message={suppliersError} />}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <SupplierSelectField picker={supplierPicker} className="sm:col-span-2"
            id="payment-request-supplier" label={t('paymentRequests.label')} placeholder={t('paymentRequests.placeholder')}
            value={supplierId} disabled={suppliersLoading || !!suppliersError} />
          <div><label className="label" htmlFor="payment-request-due-date">{t('paymentRequests.setDueDate')}</label><input id="payment-request-due-date" type="date" className="input" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></div>
        </div>

        {supplierId && (
          <fieldset>
            <legend className="label">{t('paymentRequests.text_14')}</legend>
            {invoicesError ? <ErrorNote message={invoicesError} /> : invoicesLoading ? (
              <Note tone="idle">{t('paymentRequests.text_15')}</Note>
            ) : invoices?.length ? (
              <div className="max-h-56 divide-y divide-line-soft overflow-y-auto rounded-lg border border-line" tabIndex={0} role="region" aria-label={t('paymentRequests.aria_label_3')}>
                {invoices.map((inv) => {
                  const checked = inv.id in chosen;
                  // Blocked, not hidden: the accountant can see this invoice is open, and a list
                  // that quietly dropped it would read as missing data rather than as a rule.
                  const otherCurrency = requestCurrency != null && inv.currency !== requestCurrency;
                  return (
                    <div key={inv.id} className={`flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 text-sm ${otherCurrency ? 'opacity-60' : ''}`}>
                      <label className="flex min-h-11 min-w-0 flex-1 basis-full cursor-pointer items-center gap-3 sm:basis-auto">
                        <input type="checkbox" className="size-5 shrink-0 accent-action" checked={checked}
                          disabled={otherCurrency}
                          aria-label={otherCurrency
                            ? t('paymentRequests.invoiceOtherCurrencyLabel', {
                              invoice: inv.invoice_number,
                              supplier: supplierName,
                              invoiceCurrency: inv.currency,
                              requestCurrency: requestCurrency ?? '',
                            })
                            : t('paymentRequests.invoicePickLabel', { invoice: inv.invoice_number, supplier: supplierName })}
                          onChange={(e) => setChosen((c) => {
                            const next = { ...c };
                            if (e.target.checked) next[inv.id] = inv.allocationAmount; else delete next[inv.id];
                            return next;
                          })} />
                        <span className="min-w-0 break-words">
                          {t('paymentRequests.fmtDate_4')} <b dir="ltr" className="num">{inv.invoice_number}</b> · {fmtDate(inv.invoice_date)}
                          {inv.review_status !== 'approved' && <span className="badge-await ms-2">{t('paymentRequests.text_16')}</span>}
                        </span>
                      </label>
                      <span className="text-ink-muted text-xs num">
                        {isOwner ? t('paymentRequests.fmtMoneyExact_2') : t('paymentRequests.fmtMoneyExact_3')} {fmtMoneyExact(inv.allocationAmount, inv.currency)}
                      </span>
                      {otherCurrency && (
                        <span className="basis-full text-xs text-ink-muted">
                          {t('paymentRequests.invoiceOtherCurrencyNote', {
                            invoiceCurrency: inv.currency,
                            requestCurrency: requestCurrency ?? '',
                          })}
                        </span>
                      )}
                      {checked && (
                        <input type="number" step="0.01" className="input w-28! num" value={chosen[inv.id]}
                          aria-label={t('paymentRequests.allocationAmountLabel', { invoice: inv.invoice_number, supplier: supplierName })}
                          onChange={(e) => setChosen((c) => ({ ...c, [inv.id]: Number(e.target.value) || 0 }))} />
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              /* G1, finding 1. This box used to read "ניתן לשמור דרישה ללא חשבונית", and that was
                 false in three layers: `amount` is derived only from the ticked invoices (:284),
                 both save buttons are hard-disabled on `amount <= 0` (:427-428), and the RPC would
                 refuse with `allocation_invalid` (0023:528) even if they were not. A financial
                 screen may not promise a route it blocks — PRODUCT.md:62, "אמת מעל נוחות".
                 Whether an advance to a supplier SHOULD be possible is a business question and
                 stays one: OPEN-DECISIONS #113. This sentence only stops the lie. */
              <div className="text-sm text-ink-muted border border-dashed rounded-lg px-3 py-4 text-center">
                {t('paymentRequests.text_17')}
              </div>
            )}
          </fieldset>
        )}

        <SubPanel className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <span className="text-sm text-ink-soft">{t('paymentRequests.text_18')}</span>
          {/* Before anything is ticked there is no invoice to take a currency from, and the
              request would be built in the organisation's own — so that is what the zero is in.
              The CHECKBOX guard above still keys off `requestCurrency`, which stays null until a
              real selection fixes it; nothing is refused on the strength of a default. */}
          <span className="kpi-value-compact num">{fmtMoneyExact(amount, requestCurrency ?? org?.base_currency)}</span>
        </SubPanel>

        <div><label className="label" htmlFor="payment-request-notes">{t('paymentRequests.setNotes')}</label><input id="payment-request-notes" className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        <div><label className="label" htmlFor="payment-request-reason">{t('paymentRequests.reasonOptionalLabel')}</label><input id="payment-request-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></div>

        {checking && <Note tone="idle">{t('paymentRequests.text_19')}</Note>}
        {checkError && <Note tone="alert">{checkError}</Note>}
        {checks && <CheckList checks={checks} />}

        <div className="flex flex-wrap justify-end gap-2">
          <button className="btn-secondary" disabled={busy} onClick={onClose}>{t('paymentRequests.text_20')}</button>
          <button className="btn-secondary" disabled={busy || amount <= 0 || !checksReady || !!suppliersError || !!invoicesError} onClick={() => void save(false)}>{t('paymentRequests.save')}</button>
          <button className={hasCritical ? 'btn-danger' : 'btn-primary'} disabled={busy || amount <= 0 || !checksReady || !!suppliersError || !!invoicesError} onClick={() => void save(true)}>
            {busy ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" /> : hasCritical ? <ShieldAlert size={ICON.sm} aria-hidden="true" /> : <Send size={ICON.sm} aria-hidden="true" />}
            {hasCritical ? t('paymentRequests.text_21') : t('paymentRequests.text_22')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The label the audit line carries when the approver typed nothing — the same words as the button
 * that was pressed, so the ledger sentence reads as an action a person would recognise.
 *
 * Only the destinations this screen's buttons can actually reach are listed. `investigation` and
 * `suspected_duplicate` are legal server-side but no button here goes to them, so naming a verb for
 * them would be inventing copy for a path that does not exist.
 */
const PAYMENT_REQUEST_ACTION_LABEL: Record<string, string> = {
  pending_approval: 'שליחה לאישור',
  approved: 'אישור הדרישה',
  sent_for_execution: 'העברה לגורם המבצע',
  cancelled: 'ביטול דרישת תשלום',
};

const paymentRequestActionLabel = (status: PaymentRequestStatus) =>
  PAYMENT_REQUEST_ACTION_LABEL[status] ?? 'עדכון דרישת תשלום';

/**
 * One summary of the pre-approval checks, in place of the stack the owner reported (19.08.2026):
 * the full check list, then a panel repeating its one critical row underneath it, then a toast
 * repeating it a third time on approve. Three boxes, one fact.
 *
 * What stays in the open: the state in one sentence, how many findings of each kind, every
 * blocking sentence, and the step that clears it. What folds: the per-check detail, through the
 * shared `Disclosure` — DESIGN.md's staged-disclosure law folds secondary detail and never folds
 * an error, so the criticals are above the fold and the advisory rows are behind it.
 *
 * `CheckList` is rendered unchanged inside the fold and is MOUNTED ONLY ONCE OPENED. That is not
 * an optimisation: a shut `<details>` still holds its children in the DOM, so a blocking sentence
 * sitting inside it, directly under the same sentence above it, would be the same stack the fold
 * was supposed to remove. The precedent is DocumentReviewWorkspace's "פרטים טכניים", which gates
 * its rows on the same `onToggle` flag.
 *
 * Local to this screen on purpose. `CheckList` has four consumers and only this one repeated
 * itself; reshaping the shared component would push a fix onto three screens nobody complained about.
 */
const isAllocationVsBalanceCheck = (check: CheckResult) =>
  check.code === 'allocation_vs_balance_one' || check.code === 'allocation_vs_balance_many';

function CheckSummary({ summary, checks }: { summary: ChecksSummary; checks: CheckResult[] }) {
  const { t } = useT();
  const [detailOpen, setDetailOpen] = useState(false);
  const blocked = summary.blocking.length > 0;

  const counts: string[] = [];
  if (summary.blocking.length) {
    counts.push(summary.blocking.length === 1 ? t('paymentRequests.blockingOne') : t('paymentRequests.blockingMany', { count: summary.blocking.length }));
  }
  if (summary.warnings.length) {
    counts.push(summary.warnings.length === 1 ? t('paymentRequests.warningOne') : t('paymentRequests.warningMany', { count: summary.warnings.length }));
  }
  if (summary.info.length) {
    counts.push(summary.info.length === 1 ? t('paymentRequests.infoOne') : t('paymentRequests.infoMany', { count: summary.info.length }));
  }

  // Tone carries the state a second time, never the first: every line below says it in words too,
  // because a summary whose meaning lives in a colour has no meaning for a colour-blind approver.
  const tone = blocked ? 'alert' : summary.warnings.length ? 'await' : 'done';
  const headline = blocked
    ? t('paymentRequests.text_23')
    : summary.warnings.length
      ? t('paymentRequests.text_24')
      : checks.length
        ? t('paymentRequests.text_25')
        : t('paymentRequests.text_26');

  // The action gets its own line only when no blocking sentence already ends with it.
  // The allocation-vs-balance codes carry their remedy inside their own message, and
  // printing it again under "פעולה נדרשת" would rebuild — inside one box this time — the exact
  // repetition this summary exists to remove.
  const action = summary.actionKey ? t(summary.actionKey) : null;
  const unsaidAction = action != null && !summary.blocking.some(isAllocationVsBalanceCheck)
    ? action
    : null;

  return (
    <Note tone={tone}>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="font-semibold">{headline}</p>
        {counts.length > 0 && <p className="text-xs">{counts.join(' · ')}</p>}
        {blocked && (
          <ul className="space-y-1">
            {summary.blocking.map((check, index) => <li key={index}>{checkText(check, t)}</li>)}
          </ul>
        )}
        {unsaidAction && <p><span className="font-medium">{t('paymentRequests.text_27')}</span> {unsaidAction}</p>}
        {checks.length > 0 && (
          <Disclosure title={t('paymentRequests.title_3')} count={checks.length} tone={tone}
            className="-mx-4 -mb-3 mt-2 border-t border-line-soft" onToggle={setDetailOpen}>
            {detailOpen ? <CheckList checks={checks} /> : null}
          </Disclosure>
        )}
      </div>
    </Note>
  );
}

/* ---------- detail + approval flow ---------- */
export function PaymentRequestDetail({ pr, isOffice, onClose, onChanged }: {
  pr: Row; isOffice: boolean; onClose: () => void; onChanged: () => void;
}) {
  const { errorText, t } = useT();
  const toast = useToast();
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const checkSequence = useRef(0);
  const [busy, setBusy] = useState(false);
  const [transitionTarget, setTransitionTarget] = useState<PaymentRequestStatus | null>(null);
  const [creditOverrideOpen, setCreditOverrideOpen] = useState(false);
  const [creditOverrideAcknowledged, setCreditOverrideAcknowledged] = useState(false);

  const { data: links, loading: linksLoading, error: linksError } = useQuery(async () => {
    const rows = await fetchAll<{
      invoice_id: string;
      amount_allocated: number;
      invoice: { invoice_number: string; invoice_date: string } | { invoice_number: string; invoice_date: string }[];
    }>((from, to) => supabase.from('payment_request_invoices')
      .select('invoice_id, amount_allocated, invoice:invoices(invoice_number, invoice_date)')
      .eq('payment_request_id', pr.id).order('invoice_id').range(from, to));
    return rows.map((row) => ({
      ...row,
      invoice: Array.isArray(row.invoice) ? row.invoice[0] : row.invoice,
    }));
  }, [pr.id]);

  const checkFingerprint = links ? paymentRequestCheckFingerprint({
    supplierId: pr.supplier_id, amount: pr.amount, invoiceIds: links.map((link) => link.invoice_id),
  }) : null;
  const latestFingerprint = useRef(checkFingerprint);
  latestFingerprint.current = checkFingerprint;

  useEffect(() => {
    const sequence = ++checkSequence.current;
    setChecks(null);
    setCheckError(null);
    if (!checkFingerprint || !links) { setChecking(false); return; }
    setChecking(true);
    void runPaymentRequestChecks({
      id: pr.id, supplier_id: pr.supplier_id, amount: pr.amount, invoiceIds: links.map((link) => link.invoice_id),
    }).then((results) => {
      if (checkSequence.current === sequence && latestFingerprint.current === checkFingerprint) setChecks(results);
    }).catch(() => {
      if (checkSequence.current === sequence) setCheckError(t('paymentRequests.setCheckError_3'));
    }).finally(() => {
      if (checkSequence.current === sequence) setChecking(false);
    });
    return () => {
      if (checkSequence.current === sequence) checkSequence.current += 1;
    };
  }, [checkFingerprint]);

  /* One finding per currency since 0219 — a dollar credit does not offset a shekel request, so
     they are never one figure on screen. */
  const openCreditFindings = (checks ?? []).filter((check) => check.code === 'payment_request_open_credit');
  /* The number the SERVER computes and this screen echoes back to it, never renders.
     `approve_payment_request` (0073) still sums the supplier's open credits across currencies, so
     for a supplier holding two this token is a figure with no unit — it is compared, not read.
     Making the server's own check per-currency is P5-G6; until then the gate stays "any open
     credit blocks a plain approval", which is a COUNT and true in every currency. */
  const openCreditTotal = openCreditFindings.reduce((sum, check) => sum + (check.amount ?? 0), 0);
  /** The open credit that CAN reduce this request: the one in its own currency, if there is one. */
  const sameCurrencyCredit = openCreditFindings.find((check) => check.currency === pr.currency)?.amount ?? null;

  useEffect(() => {
    setCreditOverrideAcknowledged(false);
    setCreditOverrideOpen(false);
  }, [pr.id, openCreditTotal]);

  async function setStatus(status: PaymentRequestStatus, reason?: string, withCreditOverride = false) {
    let freshOpenCreditTotal = 0;
    if (status === 'approved') {
      if (!checkFingerprint || !links || checks == null || checking || checkError || linksError) {
        toast(checkError ?? linksError ?? t('paymentRequests.toast_12'), 'error');
        return;
      }
    }
    setBusy(true);
    if (status === 'approved' && checkFingerprint && links) {
      try {
        const freshChecks = await runPaymentRequestChecks({
          id: pr.id, supplier_id: pr.supplier_id, amount: pr.amount, invoiceIds: links.map((link) => link.invoice_id),
        });
        if (latestFingerprint.current !== checkFingerprint) throw new Error(t('paymentRequests.Error_2'));
        setChecks(freshChecks);
        setCheckError(null);
        freshOpenCreditTotal = freshChecks.find((check) => check.code === 'payment_request_open_credit')?.amount ?? 0;
        // 0146: re-read on the fresh signals, not the rendered ones. A credit offset between
        // opening the modal and pressing approve lands here, and the server would answer with a
        // bare payment_request_checks_failed.
        //
        // The toast reports the EVENT — the checks moved under you and approval is now closed —
        // and stops there. `setChecks(freshChecks)` above has already re-rendered the summary,
        // which states the rule and the required action; reciting them here too was the third
        // copy of one sentence the owner asked us to stop printing (19.08.2026).
        if (freshChecks.some(isAllocationVsBalanceCheck)) {
          setBusy(false);
          toast(t('paymentRequests.toast_13'), 'error');
          return;
        }
      } catch (failure) {
        setChecks(null);
        setCheckError(t('paymentRequests.setCheckError_4'));
        setBusy(false);
        toast(failure instanceof Error ? failure.message : t('paymentRequests.toast_14'), 'error');
        return;
      }
      if (withCreditOverride && freshOpenCreditTotal !== openCreditTotal) {
        setCreditOverrideAcknowledged(false);
        setCreditOverrideOpen(false);
        setBusy(false);
        toast(t('paymentRequests.toast_15'), 'error');
        return;
      }
      if (!withCreditOverride && freshOpenCreditTotal > 0) {
        setBusy(false);
        toast(t('paymentRequests.toast_16'), 'error');
        return;
      }
    }
    // Never `null` on either arm. `p1_transition_payment_request` rejects a blank transition reason
    // (`payment_request_transition_invalid`, 0073:575) and a blank override reason
    // (`payment_request_credit_override_invalid`), and the ordinary forward steps now arrive here
    // with nothing typed. `reasonOr` writes the honest line: the action, and that nobody explained it.
    const auditReason = reasonOr(reason, withCreditOverride
      ? 'אישור חריג ללא קיזוז הזיכוי'
      : paymentRequestActionLabel(status));
    const res = withCreditOverride
      ? await supabase.rpc('approve_payment_request_with_credit_override', {
        p_payment_request_id: pr.id,
        p_supplier_id: pr.supplier_id,
        p_expected_open_credit_total: freshOpenCreditTotal,
        p_override_reason: auditReason,
      })
      : await supabase.rpc('transition_payment_request', {
        p_payment_request_id: pr.id,
        p_target_status: status,
        p_reason: auditReason,
      });
    setBusy(false);
    if (res.error) { toast(errorText(res.error.message), 'error'); return; }
    setTransitionTarget(null);
    setCreditOverrideOpen(false);
    setCreditOverrideAcknowledged(false);
    toast(t('paymentRequests.toast_17'));
    onChanged();
  }

  /**
   * The single door every transition button goes through.
   *
   * Sending a draft for approval, approving a clean request, handing an approved one to the payer —
   * these are the work, and they now fire straight away with a toast. Cancelling, returning from an
   * investigation or a duplicate suspicion, and approving past a warning still stop to ask, because
   * those are the lines an auditor will actually want a sentence next to.
   *
   * Both paths land in `setStatus`, so the pre-approval freshness re-read happens either way — a
   * silent approval is not an unchecked one.
   */
  function requestTransition(to: PaymentRequestStatus, exceptional = false) {
    if (reasonDemandFor('payment_request', pr.status, to, { exceptional })) { setTransitionTarget(to); return; }
    void setStatus(to);
  }

  const summary = useMemo(() => (checks ? summarizeChecks(checks) : null), [checks]);
  const hasCritical = (summary?.blocking.length ?? 0) > 0;
  const checksReady = checks != null && !checking && !checkError && !linksError;
  // 0146. Not one more warning to approve past: the server rejects this request at approval
  // (payment_request_checks_failed) and again at execution (allocation_exceeds_balance), and no
  // screen can repair an allocation. Both approval routes are closed here so the refusal arrives
  // with its reason attached instead of as a server error the user cannot act on.
  const overAllocated = summary?.blocking.some(isAllocationVsBalanceCheck) ?? false;

  return (
    <Modal open onClose={onClose} title={t('paymentRequests.detailTitle', { number: pr.number, supplier: pr.supplier.name })} wide busy={busy} statusMessage={busy ? t('paymentRequests.detailBusy') : undefined}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge meta={PAYMENT_REQUEST_STATUS[pr.status]} />
          <span className="kpi-value-compact num">{fmtMoneyExact(pr.amount, pr.currency)}</span>
          {pr.due_date && <span className="text-sm text-ink-muted">{t('paymentRequests.dueLabel')} {fmtDate(pr.due_date)}</span>}
          {pr.approved_at && <span className="text-sm text-ink-muted">{t('paymentRequests.approvedByLabel')} {pr.approver?.full_name ?? t('paymentRequests.fmtDate_3')} · {fmtDate(pr.approved_at)}</span>}
        </div>
        {pr.notes && <div className="text-sm text-ink-soft bg-surface-sunken rounded-lg px-3 py-2">{pr.notes}</div>}
        {pr.open_credit_override_total != null && (
          <Note tone="alert">
            <span className="min-w-0 flex-1">
              <strong>{t('paymentRequests.text_29')}</strong>{' '}
              {t('paymentRequests.creditOverrideBefore')}<span className="num">{fmtMoneyExact(pr.open_credit_override_total, pr.currency)}</span>{t('paymentRequests.creditOverrideAfter')}
              <span className="block mt-1">{t('paymentRequests.creditOverrideReasonLabel')} {pr.open_credit_override_reason}</span>
            </span>
          </Note>
        )}

        {linksError ? <ErrorNote message={linksError} /> : linksLoading ? (
          <div role="status" className="text-sm text-ink-muted">{t('paymentRequests.text_30')}</div>
        ) : links?.length ? (
          <div>
            <div className="text-sm font-medium text-ink-soft mb-1.5">{t('paymentRequests.text_31')}</div>
            <ul className="divide-y divide-line-soft border border-line-soft rounded-lg text-sm">
              {links.map((l) => (
                <li key={l.invoice_id} className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2">
                  <span>{t('paymentRequests.fmtDate_4')} <b dir="ltr" className="num">{l.invoice.invoice_number}</b> · {fmtDate(l.invoice.invoice_date)}</span>
                  {/* An allocation is money in the debt's currency, which is the request's. */}
                  <span className="num font-medium">{fmtMoneyExact(l.amount_allocated, pr.currency)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : <div className="text-sm text-await-fg">{t('paymentRequests.text_32')}</div>}

        <div>
          <div className="text-sm font-medium text-ink-soft mb-1.5">{t('paymentRequests.text_33')}</div>
          {(checkError || linksError) && <Note tone="alert">{checkError ?? linksError}</Note>}
          {checks && summary ? <CheckSummary summary={summary} checks={checks} /> : checking && (
            <div role="status" className="flex items-center gap-2 text-sm text-ink-muted">
              <Loader2 size={ICON.sm} className="animate-spin text-ink-faint" aria-hidden="true" /> {t('paymentRequests.checkingRequest')}
            </div>
          )}
        </div>

        {openCreditTotal > 0 && !overAllocated && (
          <Note tone="alert">
            <div className="space-y-3">
              <p className="font-semibold">{t('paymentRequests.text_34')}</p>
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <div><dt className="text-ink-muted">{t('paymentRequests.text_35')}</dt><dd className="font-medium">{pr.supplier.name}</dd></div>
                <div><dt className="text-ink-muted">{t('paymentRequests.fmtMoneyExact_4')}</dt>
                  <dd className="font-semibold">
                    {openCreditFindings.map((credit) => (
                      <span key={credit.currency} className="num block">{fmtMoneyExact(credit.amount ?? null, credit.currency)}</span>
                    ))}
                  </dd></div>
                <div><dt className="text-ink-muted">{t('paymentRequests.fmtMoneyExact_5')}</dt><dd className="font-semibold num">{fmtMoneyExact(pr.amount, pr.currency)}</dd></div>
                {/* The net line exists only when the credits and the request are the same money.
                    Subtracting a dollar credit from a shekel request produces a number that is
                    not the net of anything — so the sentence takes its place. */}
                {sameCurrencyCredit != null ? (
                  <div><dt className="text-ink-muted">{t('paymentRequests.fmtMoneyExact_6')}</dt><dd className="font-semibold num">{fmtMoneyExact(pr.amount - sameCurrencyCredit, pr.currency)}</dd></div>
                ) : (
                  <div><dt className="text-ink-muted">{t('paymentRequests.fmtMoneyExact_6')}</dt><dd className="text-sm">{t('paymentRequests.creditsOtherCurrencyNet')}</dd></div>
                )}
              </dl>
              <label className="flex min-h-11 items-start gap-2 text-sm font-medium">
                <input type="checkbox" className="mt-1 size-5 shrink-0 accent-action" checked={creditOverrideAcknowledged}
                  onChange={(event) => setCreditOverrideAcknowledged(event.target.checked)} />
                <span>{t('paymentRequests.text_36')}</span>
              </label>
            </div>
          </Note>
        )}

        {isOffice && (
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            {['draft'].includes(pr.status) && (
              <button className="btn-primary" disabled={busy} onClick={() => requestTransition('pending_approval')}>{busy ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" /> : <Send size={ICON.sm} aria-hidden="true" />} {t('paymentRequests.text_22')}</button>
            )}
            {['pending_approval', 'suspected_duplicate', 'investigation'].includes(pr.status) && (
              overAllocated ? (
                <button className="btn-secondary" disabled aria-label={t('paymentRequests.aria_label_4')}>
                  <CheckCircle2 size={ICON.sm} aria-hidden="true" /> {t('paymentRequests.text_38')}
                </button>
              ) : openCreditTotal > 0 ? (
                <>
                  <button className="btn-secondary" disabled aria-label={t('paymentRequests.aria_label_5')}>
                    <CheckCircle2 size={ICON.sm} aria-hidden="true" /> {t('paymentRequests.text_38')}
                  </button>
                  <button className="btn-primary" disabled={busy || !checksReady || !creditOverrideAcknowledged}
                    onClick={() => setCreditOverrideOpen(true)}>
                    <ShieldAlert size={ICON.sm} aria-hidden="true" /> {t('paymentRequests.title_4')}
                  </button>
                </>
              ) : (
                <button className={hasCritical ? 'btn-danger' : 'btn-primary'} disabled={busy || !checksReady}
                  onClick={() => requestTransition('approved', hasCritical)}>
                  <CheckCircle2 size={ICON.sm} aria-hidden="true" /> {hasCritical ? t('paymentRequests.text_37') : t('paymentRequests.text_38')}
                </button>
              )
            )}
            {['approved'].includes(pr.status) && (
              <button className="btn-primary" disabled={busy} onClick={() => requestTransition('sent_for_execution')}>{busy ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" /> : <Send size={ICON.sm} aria-hidden="true" />} {t('paymentRequests.sendToPayer')}</button>
            )}
            {!['cancelled', 'executed', 'matched'].includes(pr.status) && (
              <button className="btn-danger" disabled={busy} onClick={() => requestTransition('cancelled')}><XCircle size={ICON.sm} aria-hidden="true" /> {t('paymentRequests.requestTransition')}</button>
            )}
          </div>
        )}
      </div>

      <ConfirmDialog open={transitionTarget !== null} onClose={() => setTransitionTarget(null)}
        onConfirm={(reason) => transitionTarget && void setStatus(transitionTarget, reason)}
        title={transitionTarget === 'cancelled' ? t('paymentRequests.text_39') : t('paymentRequests.text_40')}
        message={t('paymentRequests.message_2')}
        danger={transitionTarget === 'cancelled' || (transitionTarget === 'approved' && hasCritical)}
        requireReason busy={busy} />
      <ConfirmDialog open={creditOverrideOpen} onClose={() => setCreditOverrideOpen(false)}
        onConfirm={(reason) => void setStatus('approved', reason, true)}
        title={t('paymentRequests.title_4')}
        message={t('paymentRequests.message_3')}
        confirmLabel={t('paymentRequests.confirmLabel')}
        reasonLabel={t('paymentRequests.reasonLabel')}
        danger requireReason busy={busy} />
    </Modal>
  );
}
