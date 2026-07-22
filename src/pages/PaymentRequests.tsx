import { useEffect, useMemo, useRef, useState } from 'react';
import { toHebrewError } from '../lib/errors';
import { useSearchParams } from 'react-router-dom';
import { useParamState } from '../lib/useParamState';
import { Plus, Loader2, Send, CheckCircle2, ShieldAlert, XCircle, Pencil } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { DataTable, StatusBadge, useToast, Modal, ConfirmDialog, ErrorNote, Note, SkeletonTable, type Column } from '../components/ui';
import { CheckList } from './Invoices';
import { runPaymentRequestChecks, type CheckResult } from '../lib/checks';
import { PAYMENT_REQUEST_STATUS } from '../lib/status';
import { fmtMoneyExact, fmtDate, todayISO } from '../lib/format';
import type { PaymentRequest, PaymentRequestStatus, Supplier } from '../lib/types';
import { fetchAll, fetchInChunks } from '../lib/supabasePaging';
import { paymentRequestCheckFingerprint } from '../lib/checkFingerprint';

type Row = PaymentRequest & { supplier: { name: string } };

export default function PaymentRequests() {
  const [params, setParams] = useSearchParams();
  const { profile } = useAuth();
  const toast = useToast();
  const [statusFilter, setStatusFilter] = useParamState('status', 'active');
  const [dueFilter, setDueFilter] = useParamState('due');
  const [manualCreateOpen, setManualCreateOpen] = useState(false);
  const presetInvoiceId = params.get('new');
  const createOpen = manualCreateOpen || !!presetInvoiceId;
  const [selected, setSelected] = useState<Row | null>(null);
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
      .select('*, supplier:suppliers(name)')
      .order('created_at', { ascending: false }).order('id').range(from, to)));

  const today = todayISO();  // local calendar day; due_date is a plain date, string compare is correct
  const rows = (data ?? []).filter((r) => {
    const active = !['matched', 'cancelled', 'executed'].includes(r.status);
    const statusOk = statusFilter === 'all' ? true : statusFilter === 'active' ? active : r.status === statusFilter;
    const dueOk = !dueFilter ? true
      : dueFilter === 'today' ? active && r.due_date === today
      : dueFilter === 'overdue' ? active && !!r.due_date && r.due_date < today
      : true;
    return statusOk && dueOk;
  });

  const isOffice = !!profile && ['owner', 'office'].includes(profile.role);

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
    { key: 'num', header: 'מס׳', priority: 3, sortValue: (r) => r.number, render: (r) => `#${r.number}` },
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
        {isOffice && <button className="btn-primary" onClick={() => setManualCreateOpen(true)}><Plus size={16} /> דרישה חדשה</button>}
      </div>
      <DataTable rows={rows} columns={columns} searchable
        searchFn={(r, q) => r.supplier.name.toLowerCase().includes(q) || String(r.number).includes(q)}
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
            <select className="input w-auto!" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="active">דרישות פעילות</option>
              <option value="all">הכל</option>
              {Object.entries(PAYMENT_REQUEST_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <select className="input w-auto!" value={dueFilter} onChange={(e) => setDueFilter(e.target.value)}>
              <option value="">כל מועדי היעד</option>
              <option value="today">יעד היום</option>
              <option value="overdue">באיחור</option>
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

  const { data: suppliers, loading: suppliersLoading, error: suppliersError } = useQuery<Supplier[]>(async () =>
    fetchAll<Supplier>((from, to) => supabase.from('suppliers').select('*').is('deleted_at', null)
      .order('name').order('id').range(from, to)));

  const { data: invoices, loading: invoicesLoading, error: invoicesError } = useQuery(async () => {
    if (!supplierId) return [];
    const inv = await fetchAll<{ id: string; invoice_number: string; invoice_date: string; total_amount: number; review_status: string }>((from, to) => supabase.from('invoices')
      .select('id, invoice_number, invoice_date, total_amount, review_status')
      .eq('supplier_id', supplierId).neq('payment_status', 'paid').is('deleted_at', null)
      .order('invoice_date').order('id').range(from, to));
    const ids = inv.map((i) => i.id);
    const bals = ids.length ? await fetchInChunks(ids, (chunk) => fetchAll<{ invoice_id: string; balance: number }>((from, to) => supabase.from('invoice_balances')
      .select('invoice_id, balance').in('invoice_id', chunk).order('invoice_id').range(from, to))) : [];
    const balMap = new Map(bals.map((b) => [b.invoice_id, b.balance]));
    return inv.map((i) => ({ ...i, balance: balMap.get(i.id) ?? i.total_amount })).filter((i) => i.balance > 0);
  }, [supplierId]);

  // preset from invoice detail page
  useEffect(() => {
    if (!presetInvoiceId) return;
    let cancelled = false;
    void (async () => {
      const invoiceResult = await supabase.from('invoices').select('id, supplier_id, total_amount')
        .eq('id', presetInvoiceId).is('deleted_at', null).neq('payment_status', 'paid').maybeSingle();
      if (cancelled) return;
      if (invoiceResult.error || !invoiceResult.data) {
        toast('החשבונית שבקישור אינה זמינה או שכבר שולמה.', 'error');
        onClose();
        return;
      }
      const inv = invoiceResult.data as { id: string; supplier_id: string; total_amount: number };
      const balanceResult = await supabase.from('invoice_balances').select('balance').eq('invoice_id', inv.id).maybeSingle();
      if (cancelled) return;
      if (balanceResult.error) {
        toast('טעינת יתרת החשבונית שבקישור נכשלה.', 'error');
        onClose();
        return;
      }
      const balance = (balanceResult.data as { balance: number } | null)?.balance ?? inv.total_amount;
      if (balance <= 0) {
        toast('לחשבונית שבקישור אין יתרה פתוחה.', 'error');
        onClose();
        return;
      }
      setSupplierId(inv.supplier_id);
      setChosen({ [inv.id]: balance });
    })().catch(() => {
      if (!cancelled) {
        toast('טעינת החשבונית שבקישור נכשלה.', 'error');
        onClose();
      }
    });
    return () => { cancelled = true; };
    // `onClose` and `toast` are context callbacks; the deep-link id owns this request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetInvoiceId]);

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
    <Modal open onClose={onClose} title="דרישת תשלום חדשה" wide>
      <div className="space-y-4">
        {suppliersError && <ErrorNote message={suppliersError} />}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="sm:col-span-2">
            <label className="label">ספק *</label>
            <select className="input" value={supplierId} disabled={suppliersLoading || !!suppliersError}
              onChange={(e) => { setSupplierId(e.target.value); setChosen({}); }}>
              <option value="">בחר ספק...</option>
              {suppliers?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div><label className="label">תאריך יעד</label><input type="date" className="input" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></div>
        </div>

        {supplierId && (
          <div>
            <label className="label">חשבוניות פתוחות לתשלום</label>
            {invoicesError ? <ErrorNote message={invoicesError} /> : invoicesLoading ? (
              <Note tone="idle">טוען חשבוניות ויתרות…</Note>
            ) : invoices?.length ? (
              <div className="border border-line rounded-lg divide-y divide-line-soft max-h-56 overflow-y-auto">
                {invoices.map((inv) => {
                  const checked = inv.id in chosen;
                  return (
                    <div key={inv.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <input type="checkbox" className="rounded" checked={checked}
                        onChange={(e) => setChosen((c) => {
                          const next = { ...c };
                          if (e.target.checked) next[inv.id] = inv.balance; else delete next[inv.id];
                          return next;
                        })} />
                      <span className="flex-1">
                        חשבונית <b dir="ltr">{inv.invoice_number}</b> · {fmtDate(inv.invoice_date)}
                        {inv.review_status !== 'approved' && <span className="badge-await ms-2">טרם אושרה</span>}
                      </span>
                      <span className="text-ink-muted text-xs num">יתרה {fmtMoneyExact(inv.balance)}</span>
                      {checked && (
                        <input type="number" step="0.01" className="input w-28! num" value={chosen[inv.id]}
                          onChange={(e) => setChosen((c) => ({ ...c, [inv.id]: Number(e.target.value) || 0 }))} />
                      )}
                    </div>
                  );
                })}
              </div>
            ) : <div className="text-sm text-ink-muted border border-dashed rounded-lg px-3 py-4 text-center">אין חשבוניות פתוחות לספק זה — ניתן לשמור דרישה ללא חשבונית (תסומן כחריג בהתאמות)</div>}
          </div>
        )}

        <div className="flex items-center justify-between rounded-lg bg-surface-sunken px-4 py-3">
          <span className="text-sm text-ink-soft">סכום הדרישה</span>
          <span className="text-lg font-bold num">{fmtMoneyExact(amount)}</span>
        </div>

        <div><label className="label">הערות</label><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        <div><label className="label">סיבת יצירת הדרישה *</label><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></div>

        {checking && <Note tone="idle">בודק כפילויות ויתרות עדכניות…</Note>}
        {checkError && <Note tone="alert">{checkError}</Note>}
        {checks && <CheckList checks={checks} />}

        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>ביטול</button>
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
    <Modal open onClose={onClose} title={`דרישת תשלום #${pr.number} — ${pr.supplier.name}`} wide>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge meta={PAYMENT_REQUEST_STATUS[pr.status]} />
          <span className="text-lg font-bold num">{fmtMoneyExact(pr.amount)}</span>
          {pr.due_date && <span className="text-sm text-ink-muted">יעד: {fmtDate(pr.due_date)}</span>}
        </div>
        {pr.notes && <div className="text-sm text-ink-soft bg-surface-sunken rounded-lg px-3 py-2">{pr.notes}</div>}

        {linksError ? <ErrorNote message={linksError} /> : linksLoading ? (
          <Note tone="idle">טוען חשבוניות מקושרות…</Note>
        ) : links?.length ? (
          <div>
            <div className="text-sm font-medium text-ink-soft mb-1.5">חשבוניות מקושרות</div>
            <ul className="divide-y divide-line-soft border border-line-soft rounded-lg text-sm">
              {links.map((l) => (
                <li key={l.invoice_id} className="flex justify-between px-3 py-2">
                  <span>חשבונית <b dir="ltr">{l.invoice.invoice_number}</b> · {fmtDate(l.invoice.invoice_date)}</span>
                  <span className="num font-medium">{fmtMoneyExact(l.amount_allocated)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : <div className="text-sm text-await-fg">דרישה ללא חשבוניות מקושרות</div>}

        <div>
          <div className="text-sm font-medium text-ink-soft mb-1.5">בדיקות לפני אישור</div>
          {(checkError || linksError) && <Note tone="alert">{checkError ?? linksError}</Note>}
          {checks ? <CheckList checks={checks} /> : checking && <Loader2 size={16} className="animate-spin text-ink-faint" />}
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
