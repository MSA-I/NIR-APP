import { useEffect, useMemo, useRef, useState } from 'react';
import { toHebrewError } from '../lib/errors';
import { Link, useSearchParams } from 'react-router-dom';
import { useParamState } from '../lib/useParamState';
import { Plus, Loader2, Send, CheckCircle2, ShieldAlert, XCircle, Pencil } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { DataTable, StatusBadge, useToast, Modal, ConfirmDialog, ErrorNote, Note, SkeletonTable, type Column } from '../components/ui';
import { CheckList } from './Invoices';
import { runPaymentRequestChecks, type CheckResult } from '../lib/checks';
import { PAYMENT_REQUEST_STATUS } from '../lib/status';
import { addCalendarDays, fmtMoneyExact, fmtDate, todayISO } from '../lib/format';
import type { PaymentRequest, PaymentRequestStatus, Supplier } from '../lib/types';
import { fetchAll, fetchInChunks } from '../lib/supabasePaging';
import { paymentRequestCheckFingerprint } from '../lib/checkFingerprint';

type Row = PaymentRequest & { supplier: { name: string }; approver: { full_name: string } | null };
type PaymentInvoiceCandidate = {
  id: string;
  invoice_number: string;
  invoice_date: string;
  total_amount: number;
  review_status: string;
  payment_status: string;
  balance: number | null;
  allocationAmount: number;
};

export default function PaymentRequests() {
  const [params, setParams] = useSearchParams();
  const { profile } = useAuth();
  const toast = useToast();
  const [statusFilter, setStatusFilter] = useParamState('status', 'active');
  const [dueFilter, setDueFilter] = useParamState('due');
  const [manualCreateOpen, setManualCreateOpen] = useState(false);
  const presetInvoiceId = params.get('new');
  const idFilter = params.get('id');
  const createOpen = manualCreateOpen || !!presetInvoiceId;
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

  const { data, loading, fetching, error, refetch } = useQuery(async () =>
    fetchAll<Row>((from, to) => supabase.from('payment_requests')
      .select('*, supplier:suppliers(name), approver:profiles!p0_pr_approved_actor_tenant_fk(full_name)')
      .order('created_at', { ascending: false }).order('id').range(from, to)));

  useEffect(() => {
    if (!idFilter || !data || autoOpenedId.current === idFilter) return;
    const match = data.find((request) => request.id === idFilter);
    if (match) { autoOpenedId.current = idFilter; setSelected(match); }
  }, [idFilter, data]);

  const today = todayISO();  // local calendar day; due_date is a plain date, string compare is correct
  const dueSoon = addCalendarDays(today, 7);
  const rows = (data ?? []).filter((r) => {
    if (idFilter) return r.id === idFilter;
    const active = !['matched', 'cancelled', 'executed'].includes(r.status);
    const statusOk = statusFilter === 'all' ? true : statusFilter === 'active' ? active : r.status === statusFilter;
    const dueOk = !dueFilter ? true
      : dueFilter === 'today' ? active && r.due_date === today
      : dueFilter === 'overdue' ? active && !!r.due_date && r.due_date < today
      : dueFilter === 'soon' ? ['draft', 'pending_approval', 'approved', 'sent_for_execution'].includes(r.status) && !!r.due_date && r.due_date <= dueSoon
      : true;
    return statusOk && dueOk;
  });

  const isOffice = !!profile && ['owner', 'office'].includes(profile.role);
  const isOwner = profile?.role === 'owner';

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
    if (res.error) { setCancelTarget(null); toast(toHebrewError(res.error.message), 'error'); return; }
    setCancelTarget(null);
    toast('הדרישה בוטלה');
    void refetch();
  }

  const columns: Column<Row>[] = [
    { key: 'num', header: 'מס׳', priority: 3, className: 'num', sortValue: (r) => r.number, render: (r) => `#${r.number}` },
    { key: 'supplier', header: 'ספק', priority: 3, sortValue: (r) => r.supplier.name, render: (r) => r.supplier.name },
    { key: 'amount', header: 'סכום', mobileLabel: null, className: 'num', sortValue: (r) => r.amount, render: (r) => <span className="font-semibold">{fmtMoneyExact(r.amount)}</span> },
    { key: 'due', header: 'יעד', sortValue: (r) => r.due_date ?? '', render: (r) => fmtDate(r.due_date) },
    { key: 'status', header: 'סטטוס', priority: 3, render: (r) => <StatusBadge meta={PAYMENT_REQUEST_STATUS[r.status]} /> },
    { key: 'created', header: 'נוצרה', priority: 3, sortValue: (r) => r.created_at, render: (r) => fmtDate(r.created_at) },
  ];

  if (loading) return <SkeletonTable cols={6} />;
  if (error && !data) return <ErrorNote message={error} />;

  return (
    <div className="space-y-4">
      {error && <ErrorNote message={error} />}
      {fetching && data && <div className="text-xs text-ink-muted" role="status">מתעדכן…</div>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="page-title">דרישות תשלום</h1>
        <div className="flex flex-wrap items-center gap-2">
          {isOwner && <Link className="btn-secondary" to="/pay/emergency"><ShieldAlert size={16} /> מסלול חירום לביצוע</Link>}
          {isOffice && <button className="btn-primary" onClick={() => setManualCreateOpen(true)}><Plus size={16} /> דרישה חדשה</button>}
        </div>
      </div>
      <DataTable rows={rows} columns={columns} searchable
        searchFn={(r, q) => r.supplier.name.toLowerCase().includes(q) || String(r.number).includes(q)}
        searchLabel="חיפוש בדרישות תשלום"
        rowLabel={(r) => `דרישת תשלום מספר ${r.number} עבור ${r.supplier.name}`}
        onRowClick={(r) => setSelected(r)}
        mobile="cards"
        mobileTitle={(r) => <>#{r.number} · {r.supplier.name}</>}
        mobileTrailing={(r) => <StatusBadge meta={PAYMENT_REQUEST_STATUS[r.status]} />}
        rowActions={(r) => [
          { key: 'edit', label: 'עריכה', icon: Pencil, onSelect: () => setSelected(r) },
          {
            key: 'cancel', label: 'ביטול', icon: XCircle, tone: 'danger',
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
              }}>הצג את כל הדרישות</button>
            )}
            <select className="input w-auto!" aria-label="סינון דרישות תשלום לפי סטטוס" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="active">דרישות פעילות</option>
              <option value="all">הכל</option>
              {Object.entries(PAYMENT_REQUEST_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <select className="input w-auto!" aria-label="סינון דרישות תשלום לפי מועד יעד" value={dueFilter} onChange={(e) => setDueFilter(e.target.value)}>
              <option value="">כל מועדי היעד</option>
              <option value="today">יעד היום</option>
              <option value="overdue">באיחור</option>
              <option value="soon">עד 7 ימים, כולל איחורים</option>
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
        title="ביטול דרישת תשלום" message="הביטול יתועד ביומן הביקורת."
        danger requireReason busy={busyCancel} />
    </div>
  );
}

/* ---------- creation ---------- */
function CreatePaymentRequest({ presetInvoiceId, onClose, onSaved }: {
  presetInvoiceId: string | null; onClose: () => void; onSaved: () => void;
}) {
  const { profile } = useAuth();
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

  const { data: suppliers, loading: suppliersLoading, error: suppliersError } = useQuery<Supplier[]>(async () =>
    fetchAll<Supplier>((from, to) => supabase.from('suppliers').select('*').is('deleted_at', null)
      .order('name').order('id').range(from, to)));

  const { data: invoices, loading: invoicesLoading, error: invoicesError } = useQuery(async () => {
    if (!supplierId) return [];
    const inv = await fetchAll<Omit<PaymentInvoiceCandidate, 'balance' | 'allocationAmount'>>((from, to) => {
      let query = supabase.from('invoices')
        .select('id, invoice_number, invoice_date, total_amount, review_status, payment_status')
        .eq('supplier_id', supplierId).is('deleted_at', null);
      // Procurement may use the invoice total only while the invoice is wholly unpaid. Once
      // partial, its exact balance belongs to the owner/accounting boundary.
      query = isOwner ? query.neq('payment_status', 'paid') : query.eq('payment_status', 'unpaid');
      return query.order('invoice_date').order('id').range(from, to);
    });
    const ids = inv.map((i) => i.id);
    const bals = isOwner && ids.length ? await fetchInChunks(ids, (chunk) => fetchAll<{ invoice_id: string; balance: number }>((from, to) => supabase.from('invoice_balances')
      .select('invoice_id, balance').in('invoice_id', chunk).order('invoice_id').range(from, to))) : [];
    const balMap = new Map(bals.map((b) => [b.invoice_id, b.balance]));
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
      const invoiceResult = await supabase.from('invoices').select('id, supplier_id, total_amount, payment_status')
        .eq('id', presetInvoiceId).is('deleted_at', null).neq('payment_status', 'paid').maybeSingle();
      if (cancelled) return;
      if (invoiceResult.error || !invoiceResult.data) {
        toast('החשבונית שבקישור אינה זמינה או שכבר שולמה.', 'error');
        onClose();
        return;
      }
      const inv = invoiceResult.data as { id: string; supplier_id: string; total_amount: number; payment_status: string };
      if (!isOwner && inv.payment_status !== 'unpaid') {
        toast('חשבונית ששולמה חלקית אינה זמינה לדרישת תשלום של מנהל הרכש.', 'error');
        onClose();
        return;
      }
      let allocationAmount = inv.total_amount;
      if (isOwner) {
        const balanceResult = await supabase.from('invoice_balances').select('balance').eq('invoice_id', inv.id).maybeSingle();
        if (cancelled) return;
        if (balanceResult.error || !balanceResult.data) {
          toast('טעינת יתרת החשבונית שבקישור נכשלה.', 'error');
          onClose();
          return;
        }
        allocationAmount = (balanceResult.data as { balance: number }).balance;
      }
      if (allocationAmount <= 0) {
        toast('לחשבונית שבקישור אין יתרה פתוחה.', 'error');
        onClose();
        return;
      }
      setSupplierId(inv.supplier_id);
      setChosen({ [inv.id]: allocationAmount });
    })().catch(() => {
      if (!cancelled) {
        toast('טעינת החשבונית שבקישור נכשלה.', 'error');
        onClose();
      }
    });
    return () => { cancelled = true; };
    // `onClose` and `toast` are context callbacks; the deep-link id owns this request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetInvoiceId, isOwner]);

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
    const t = setTimeout(() => {
      void runPaymentRequestChecks({ supplier_id: supplierId, amount, invoiceIds }).then((results) => {
        if (checkSequence.current === sequence && latestFingerprint.current === checkFingerprint) {
          setChecked({ fingerprint: checkFingerprint, results });
        }
      }).catch(() => {
        if (checkSequence.current === sequence) setCheckError('בדיקות הכפילות נכשלו. לא ניתן לשמור עד לניסיון חוזר מוצלח.');
      }).finally(() => {
        if (checkSequence.current === sequence) setChecking(false);
      });
    }, 400);
    return () => {
      clearTimeout(t);
      if (checkSequence.current === sequence) checkSequence.current += 1;
    };
  }, [checkFingerprint]);

  const checks = checked?.fingerprint === checkFingerprint ? checked.results : null;
  const hasCritical = checks?.some((c) => c.severity === 'critical') ?? false;
  const supplierName = suppliers?.find((supplier) => supplier.id === supplierId)?.name ?? 'הספק הנבחר';
  const checksReady = checkFingerprint != null && checks != null && !checking && !checkError;

  async function save(toApproval: boolean) {
    if (!supplierId || amount <= 0) { toast('בחר ספק וחשבוניות לתשלום', 'error'); return; }
    if (!reason.trim()) { toast('נדרשת סיבה ליצירת דרישת התשלום', 'error'); return; }
    if (!checkFingerprint || !checksReady) {
      toast(checkError ?? 'יש להמתין לסיום בדיקות הכפילות', 'error');
      return;
    }
    setBusy(true);
    try {
      let freshChecks: CheckResult[];
      try {
        freshChecks = await runPaymentRequestChecks({ supplier_id: supplierId, amount, invoiceIds });
      } catch (checkFailure) {
        setChecked(null);
        setCheckError('בדיקות הכפילות נכשלו. הדרישה לא נשמרה.');
        throw checkFailure;
      }
      if (latestFingerprint.current !== checkFingerprint) throw new Error('פרטי הדרישה השתנו במהלך הבדיקה. יש להמתין לבדיקה העדכנית.');
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
        p_reason: reason.trim(),
      })) as { payment_request_id: string; number: number; status: PaymentRequestStatus };

      if (pr.status === 'suspected_duplicate') {
        toast('הדרישה נשמרה עם חשד לכפילות ונפתח חריג לבדיקה', 'error');
      } else {
        toast(toApproval ? 'הדרישה נשלחה לאישור' : 'הדרישה נשמרה כטיוטה');
      }
      onSaved();
    } catch (e) {
      toast(toHebrewError(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="דרישת תשלום חדשה" wide busy={busy} statusMessage={busy ? 'שומר את דרישת התשלום' : undefined}>
      <div className="space-y-4">
        {suppliersError && <ErrorNote message={suppliersError} />}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="payment-request-supplier">ספק *</label>
            <select id="payment-request-supplier" className="input" value={supplierId} disabled={suppliersLoading || !!suppliersError}
              onChange={(e) => { setSupplierId(e.target.value); setChosen({}); }}>
              <option value="">בחר ספק...</option>
              {suppliers?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div><label className="label" htmlFor="payment-request-due-date">תאריך יעד</label><input id="payment-request-due-date" type="date" className="input" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></div>
        </div>

        {supplierId && (
          <fieldset>
            <legend className="label">חשבוניות פתוחות לתשלום</legend>
            {invoicesError ? <ErrorNote message={invoicesError} /> : invoicesLoading ? (
              <Note tone="idle">טוען חשבוניות ויתרות…</Note>
            ) : invoices?.length ? (
              <div className="border border-line rounded-lg divide-y divide-line-soft max-h-56 overflow-y-auto">
                {invoices.map((inv) => {
                  const checked = inv.id in chosen;
                  return (
                    <div key={inv.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <input type="checkbox" className="rounded" checked={checked}
                        aria-label={`בחירת חשבונית ${inv.invoice_number} של ${supplierName} להקצאה בדרישת התשלום`}
                        onChange={(e) => setChosen((c) => {
                          const next = { ...c };
                           if (e.target.checked) next[inv.id] = inv.allocationAmount; else delete next[inv.id];
                          return next;
                        })} />
                      <span className="flex-1">
                        חשבונית <b dir="ltr" className="num">{inv.invoice_number}</b> · {fmtDate(inv.invoice_date)}
                        {inv.review_status !== 'approved' && <span className="badge-await ms-2">טרם אושרה</span>}
                      </span>
                      <span className="text-ink-muted text-xs num">
                        {isOwner ? 'יתרה' : 'סכום חשבונית'} {fmtMoneyExact(inv.allocationAmount)}
                      </span>
                      {checked && (
                        <input type="number" step="0.01" className="input w-28! num" value={chosen[inv.id]}
                          aria-label={`סכום ההקצאה לחשבונית ${inv.invoice_number} של ${supplierName}`}
                          onChange={(e) => setChosen((c) => ({ ...c, [inv.id]: Number(e.target.value) || 0 }))} />
                      )}
                    </div>
                  );
                })}
              </div>
            ) : <div className="text-sm text-ink-muted border border-dashed rounded-lg px-3 py-4 text-center">אין חשבוניות פתוחות לספק זה — ניתן לשמור דרישה ללא חשבונית (תסומן כחריג בהתאמות)</div>}
          </fieldset>
        )}

        <div className="flex items-center justify-between rounded-lg bg-surface-sunken px-4 py-3">
          <span className="text-sm text-ink-soft">סכום הדרישה</span>
          <span className="text-lg font-bold num">{fmtMoneyExact(amount)}</span>
        </div>

        <div><label className="label" htmlFor="payment-request-notes">הערות</label><input id="payment-request-notes" className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        <div><label className="label" htmlFor="payment-request-reason">סיבת יצירת הדרישה *</label><input id="payment-request-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></div>

        {checking && <Note tone="idle">בודק כפילויות ויתרות עדכניות…</Note>}
        {checkError && <Note tone="alert">{checkError}</Note>}
        {checks && <CheckList checks={checks} />}

        <div className="flex justify-end gap-2">
          <button className="btn-secondary" disabled={busy} onClick={onClose}>ביטול</button>
          <button className="btn-secondary" disabled={busy || amount <= 0 || !checksReady || !!suppliersError || !!invoicesError} onClick={() => void save(false)}>שמירה כטיוטה</button>
          <button className={hasCritical ? 'btn-danger' : 'btn-primary'} disabled={busy || amount <= 0 || !checksReady || !!suppliersError || !!invoicesError} onClick={() => void save(true)}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : hasCritical ? <ShieldAlert size={15} /> : <Send size={15} />}
            {hasCritical ? 'שמירה (יסומן כחשד לכפילות)' : 'שליחה לאישור'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ---------- detail + approval flow ---------- */
export function PaymentRequestDetail({ pr, isOffice, onClose, onChanged }: {
  pr: Row; isOffice: boolean; onClose: () => void; onChanged: () => void;
}) {
  const toast = useToast();
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const checkSequence = useRef(0);
  const [busy, setBusy] = useState(false);
  const [transitionTarget, setTransitionTarget] = useState<PaymentRequestStatus | null>(null);

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
      if (checkSequence.current === sequence) setCheckError('בדיקות האישור נכשלו. לא ניתן לאשר את הדרישה.');
    }).finally(() => {
      if (checkSequence.current === sequence) setChecking(false);
    });
    return () => {
      if (checkSequence.current === sequence) checkSequence.current += 1;
    };
  }, [checkFingerprint]);

  async function setStatus(status: PaymentRequestStatus, reason?: string) {
    if (status === 'approved') {
      if (!checkFingerprint || !links || checks == null || checking || checkError || linksError) {
        toast(checkError ?? linksError ?? 'יש להמתין לסיום בדיקות האישור', 'error');
        return;
      }
    }
    setBusy(true);
    if (status === 'approved' && checkFingerprint && links) {
      try {
        const freshChecks = await runPaymentRequestChecks({
          id: pr.id, supplier_id: pr.supplier_id, amount: pr.amount, invoiceIds: links.map((link) => link.invoice_id),
        });
        if (latestFingerprint.current !== checkFingerprint) throw new Error('פרטי הדרישה השתנו במהלך הבדיקה.');
        setChecks(freshChecks);
        setCheckError(null);
      } catch (failure) {
        setChecks(null);
        setCheckError('בדיקות האישור נכשלו. הדרישה לא אושרה.');
        setBusy(false);
        toast(failure instanceof Error ? failure.message : 'בדיקות האישור נכשלו', 'error');
        return;
      }
    }
    const res = await supabase.rpc('transition_payment_request', {
      p_payment_request_id: pr.id,
      p_target_status: status,
      p_reason: reason?.trim() || null,
    });
    setBusy(false);
    if (res.error) { toast(toHebrewError(res.error.message), 'error'); return; }
    setTransitionTarget(null);
    toast('הסטטוס עודכן');
    onChanged();
  }

  const hasCritical = checks?.some((c) => c.severity === 'critical') ?? false;
  const checksReady = checks != null && !checking && !checkError && !linksError;

  return (
    <Modal open onClose={onClose} title={`דרישת תשלום #${pr.number} — ${pr.supplier.name}`} wide busy={busy} statusMessage={busy ? 'מעדכן את דרישת התשלום' : undefined}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge meta={PAYMENT_REQUEST_STATUS[pr.status]} />
          <span className="text-lg font-bold num">{fmtMoneyExact(pr.amount)}</span>
          {pr.due_date && <span className="text-sm text-ink-muted">יעד: {fmtDate(pr.due_date)}</span>}
          {pr.approved_at && <span className="text-sm text-ink-muted">אושר על ידי {pr.approver?.full_name ?? 'משתמש לא זמין'} · {fmtDate(pr.approved_at)}</span>}
        </div>
        {pr.notes && <div className="text-sm text-ink-soft bg-surface-sunken rounded-lg px-3 py-2">{pr.notes}</div>}

        {linksError ? <ErrorNote message={linksError} /> : linksLoading ? (
          <div role="status" className="text-sm text-ink-muted">טוען חשבוניות מקושרות…</div>
        ) : links?.length ? (
          <div>
            <div className="text-sm font-medium text-ink-soft mb-1.5">חשבוניות מקושרות</div>
            <ul className="divide-y divide-line-soft border border-line-soft rounded-lg text-sm">
              {links.map((l) => (
                <li key={l.invoice_id} className="flex justify-between px-3 py-2">
                  <span>חשבונית <b dir="ltr" className="num">{l.invoice.invoice_number}</b> · {fmtDate(l.invoice.invoice_date)}</span>
                  <span className="num font-medium">{fmtMoneyExact(l.amount_allocated)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : <div className="text-sm text-await-fg">דרישה ללא חשבוניות מקושרות</div>}

        <div>
          <div className="text-sm font-medium text-ink-soft mb-1.5">בדיקות לפני אישור</div>
          {(checkError || linksError) && <Note tone="alert">{checkError ?? linksError}</Note>}
          {checks ? <CheckList checks={checks} /> : checking && (
            <div role="status" className="flex items-center gap-2 text-sm text-ink-muted">
              <Loader2 size={16} className="animate-spin text-ink-faint" aria-hidden="true" /> בודק את הדרישה…
            </div>
          )}
        </div>

        {isOffice && (
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            {['draft'].includes(pr.status) && (
              <button className="btn-primary" disabled={busy} onClick={() => setTransitionTarget('pending_approval')}><Send size={15} /> שליחה לאישור</button>
            )}
            {['pending_approval', 'suspected_duplicate', 'investigation'].includes(pr.status) && (
              <button className={hasCritical ? 'btn-danger' : 'btn-primary'} disabled={busy || !checksReady}
                onClick={() => setTransitionTarget('approved')}>
                <CheckCircle2 size={15} /> {hasCritical ? 'אישור למרות האזהרות' : 'אישור הדרישה'}
              </button>
            )}
            {['approved'].includes(pr.status) && (
              <button className="btn-primary" disabled={busy} onClick={() => setTransitionTarget('sent_for_execution')}><Send size={15} /> העברה לגורם המבצע</button>
            )}
            {!['cancelled', 'executed', 'matched'].includes(pr.status) && (
              <button className="btn-ghost text-alert-solid" disabled={busy} onClick={() => setTransitionTarget('cancelled')}><XCircle size={15} /> ביטול</button>
            )}
          </div>
        )}
      </div>

      <ConfirmDialog open={transitionTarget !== null} onClose={() => setTransitionTarget(null)}
        onConfirm={(reason) => transitionTarget && void setStatus(transitionTarget, reason)}
        title={transitionTarget === 'cancelled' ? 'ביטול דרישת תשלום' : 'עדכון דרישת תשלום'}
        message="המעבר והסיבה יישמרו יחד ביומן הביקורת."
        danger={transitionTarget === 'cancelled' || (transitionTarget === 'approved' && hasCritical)}
        requireReason busy={busy} />
    </Modal>
  );
}
