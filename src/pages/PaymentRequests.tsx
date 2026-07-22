import { useEffect, useMemo, useState } from 'react';
import { toHebrewError } from '../lib/errors';
import { useSearchParams } from 'react-router-dom';
import { useParamState } from '../lib/useParamState';
import { Plus, Loader2, Send, CheckCircle2, ShieldAlert, XCircle, Pencil } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { DataTable, StatusBadge, useToast, Modal, ConfirmDialog, ErrorNote, SkeletonTable, type Column } from '../components/ui';
import { CheckList } from './Invoices';
import { runPaymentRequestChecks, type CheckResult } from '../lib/checks';
import { logAction } from '../lib/audit';
import { PAYMENT_REQUEST_STATUS } from '../lib/status';
import { fmtMoneyExact, fmtDate, todayISO } from '../lib/format';
import type { PaymentRequest, PaymentRequestStatus, Supplier } from '../lib/types';

type Row = PaymentRequest & { supplier: { name: string } };

export default function PaymentRequests() {
  const [params, setParams] = useSearchParams();
  const { profile } = useAuth();
  const toast = useToast();
  const [statusFilter, setStatusFilter] = useParamState('status', 'active');
  const [dueFilter, setDueFilter] = useParamState('due');
  const [createOpen, setCreateOpen] = useState(!!params.get('new'));
  const [selected, setSelected] = useState<Row | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Row | null>(null);
  const [busyCancel, setBusyCancel] = useState(false);

  const { data, loading, error, refetch } = useQuery(async () =>
    unwrap(await supabase.from('payment_requests')
      .select('*, supplier:suppliers(name)')
      .order('created_at', { ascending: false })) as Promise<Row[]>);

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
    const res = await supabase.from('payment_requests').update({ status: 'cancelled' }).eq('id', cancelTarget.id);
    setBusyCancel(false);
    if (res.error) { setCancelTarget(null); toast(toHebrewError(res.error.message), 'error'); return; }
    await logAction({ orgId: cancelTarget.org_id, action: 'payment_request:cancelled', entityType: 'payment_requests', entityId: cancelTarget.id, reason });
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
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="page-title">דרישות תשלום</h1>
        {isOffice && <button className="btn-primary" onClick={() => setCreateOpen(true)}><Plus size={16} /> דרישה חדשה</button>}
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
            <select className="input w-auto!" aria-label="סינון דרישות תשלום לפי סטטוס" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="active">דרישות פעילות</option>
              <option value="all">הכל</option>
              {Object.entries(PAYMENT_REQUEST_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <select className="input w-auto!" aria-label="סינון דרישות תשלום לפי מועד יעד" value={dueFilter} onChange={(e) => setDueFilter(e.target.value)}>
              <option value="">כל מועדי היעד</option>
              <option value="today">יעד היום</option>
              <option value="overdue">באיחור</option>
            </select>
          </>
        } />

      {createOpen && (
        <CreatePaymentRequest presetInvoiceId={params.get('new')} onClose={() => { setCreateOpen(false); setParams({}); }}
          onSaved={() => { setCreateOpen(false); setParams({}); void refetch(); }} />
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
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: suppliers } = useQuery<Supplier[]>(async () =>
    unwrap(await supabase.from('suppliers').select('*').is('deleted_at', null).order('name')));

  const { data: invoices } = useQuery(async () => {
    if (!supplierId) return [];
    const inv = unwrap(await supabase.from('invoices')
      .select('id, invoice_number, invoice_date, total_amount, review_status')
      .eq('supplier_id', supplierId).neq('payment_status', 'paid').is('deleted_at', null)
      .order('invoice_date')) as { id: string; invoice_number: string; invoice_date: string; total_amount: number; review_status: string }[];
    const ids = inv.map((i) => i.id);
    const bals = ids.length ? unwrap(await supabase.from('invoice_balances').select('*').in('invoice_id', ids)) as { invoice_id: string; balance: number }[] : [];
    const balMap = new Map(bals.map((b) => [b.invoice_id, b.balance]));
    return inv.map((i) => ({ ...i, balance: balMap.get(i.id) ?? i.total_amount })).filter((i) => i.balance > 0);
  }, [supplierId]);

  // preset from invoice detail page
  useEffect(() => {
    if (!presetInvoiceId) return;
    void (async () => {
      const inv = unwrap(await supabase.from('invoices').select('id, supplier_id').eq('id', presetInvoiceId).single()) as { id: string; supplier_id: string };
      setSupplierId(inv.supplier_id);
    })();
  }, [presetInvoiceId]);

  useEffect(() => {
    if (presetInvoiceId && invoices?.length) {
      const inv = invoices.find((i) => i.id === presetInvoiceId);
      if (inv) setChosen({ [inv.id]: inv.balance });
    }
  }, [invoices, presetInvoiceId]);

  const amount = useMemo(() => Object.values(chosen).reduce((s, v) => s + v, 0), [chosen]);

  useEffect(() => {
    if (!supplierId || amount <= 0) { setChecks(null); return; }
    const t = setTimeout(() => {
      void runPaymentRequestChecks({ supplier_id: supplierId, amount, invoiceIds: Object.keys(chosen) }).then(setChecks);
    }, 400);
    return () => clearTimeout(t);
  }, [supplierId, amount, chosen]);

  const hasCritical = checks?.some((c) => c.severity === 'critical') ?? false;
  const supplierName = suppliers?.find((supplier) => supplier.id === supplierId)?.name ?? 'הספק הנבחר';

  async function save(toApproval: boolean) {
    if (!supplierId || amount <= 0) { toast('בחר ספק וחשבוניות לתשלום', 'error'); return; }
    setBusy(true);
    try {
      const status: PaymentRequestStatus = hasCritical ? 'suspected_duplicate' : toApproval ? 'pending_approval' : 'draft';
      const pr = unwrap(await supabase.from('payment_requests').insert({
        org_id: profile!.org_id, supplier_id: supplierId, amount, due_date: dueDate || null,
        status, notes: notes || null, created_by: profile!.id,
      }).select('id, number').single()) as { id: string; number: number };

      const links = Object.entries(chosen).filter(([, v]) => v > 0)
        .map(([invoice_id, amount_allocated]) => ({ payment_request_id: pr.id, invoice_id, amount_allocated }));
      if (links.length) {
        const ins = await supabase.from('payment_request_invoices').insert(links);
        if (ins.error) throw new Error(ins.error.message);
      }

      if (hasCritical) {
        await supabase.from('exceptions').insert({
          org_id: profile!.org_id, type: 'duplicate_payment', severity: 'high', status: 'open',
          title: `חשד לדרישת תשלום כפולה — #${pr.number}`,
          details: { checks: checks?.filter((c) => c.severity === 'critical').map((c) => c.message) },
          supplier_id: supplierId, payment_request_id: pr.id, assigned_role: 'office',
        });
        toast('הדרישה נשמרה עם חשד לכפילות ונפתח חריג לבדיקה', 'error');
      } else {
        toast(toApproval ? 'הדרישה נשלחה לאישור' : 'הדרישה נשמרה כטיוטה');
      }
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'שגיאה בשמירה', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="דרישת תשלום חדשה" wide busy={busy} statusMessage={busy ? 'שומר את דרישת התשלום' : undefined}>
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="payment-request-supplier">ספק *</label>
            <select id="payment-request-supplier" className="input" value={supplierId} onChange={(e) => { setSupplierId(e.target.value); setChosen({}); }}>
              <option value="">בחר ספק...</option>
              {suppliers?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div><label className="label" htmlFor="payment-request-due-date">תאריך יעד</label><input id="payment-request-due-date" type="date" className="input" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></div>
        </div>

        {supplierId && (
          <fieldset>
            <legend className="label">חשבוניות פתוחות לתשלום</legend>
            {invoices?.length ? (
              <div className="border border-line rounded-lg divide-y divide-line-soft max-h-56 overflow-y-auto">
                {invoices.map((inv) => {
                  const checked = inv.id in chosen;
                  return (
                    <div key={inv.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <input type="checkbox" className="rounded" checked={checked}
                        aria-label={`בחירת חשבונית ${inv.invoice_number} של ${supplierName} להקצאה בדרישת התשלום`}
                        onChange={(e) => setChosen((c) => {
                          const next = { ...c };
                          if (e.target.checked) next[inv.id] = inv.balance; else delete next[inv.id];
                          return next;
                        })} />
                      <span className="flex-1">
                        חשבונית <b dir="ltr" className="num">{inv.invoice_number}</b> · {fmtDate(inv.invoice_date)}
                        {inv.review_status !== 'approved' && <span className="badge-await ms-2">טרם אושרה</span>}
                      </span>
                      <span className="text-ink-muted text-xs num">יתרה {fmtMoneyExact(inv.balance)}</span>
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

        {supplierId && amount > 0 && !checks && <div role="status" className="text-sm text-ink-muted">בודק את דרישת התשלום…</div>}
        {checks && <CheckList checks={checks} />}

        <div className="flex justify-end gap-2">
          <button className="btn-secondary" disabled={busy} onClick={onClose}>ביטול</button>
          <button className="btn-secondary" disabled={busy || amount <= 0} onClick={() => void save(false)}>שמירה כטיוטה</button>
          <button className={hasCritical ? 'btn-danger' : 'btn-primary'} disabled={busy || amount <= 0} onClick={() => void save(true)}>
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
  const { profile } = useAuth();
  const toast = useToast();
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  const { data: links, loading: linksLoading, error: linksError } = useQuery(async () =>
    unwrap(await supabase.from('payment_request_invoices')
      .select('invoice_id, amount_allocated, invoice:invoices(invoice_number, invoice_date, total_amount)')
      .eq('payment_request_id', pr.id)) as Promise<{ invoice_id: string; amount_allocated: number; invoice: { invoice_number: string; invoice_date: string } }[]>, [pr.id]);

  useEffect(() => {
    void runPaymentRequestChecks({
      id: pr.id, supplier_id: pr.supplier_id, amount: pr.amount,
      invoiceIds: links?.map((l) => l.invoice_id) ?? [],
    }).then(setChecks);
  }, [pr.id, pr.supplier_id, pr.amount, links]);

  async function setStatus(status: PaymentRequestStatus, reason?: string) {
    setBusy(true);
    const patch: Record<string, unknown> = { status };
    if (status === 'approved') { patch.approved_by = profile!.id; patch.approved_at = new Date().toISOString(); }
    const res = await supabase.from('payment_requests').update(patch).eq('id', pr.id);
    if (res.error) { setBusy(false); toast(toHebrewError(res.error.message), 'error'); return; }
    await logAction({ orgId: pr.org_id, action: `payment_request:${status}`, entityType: 'payment_requests', entityId: pr.id, reason });
    setBusy(false);
    toast('הסטטוס עודכן');
    onChanged();
  }

  const hasCritical = checks?.some((c) => c.severity === 'critical') ?? false;

  return (
    <Modal open onClose={onClose} title={`דרישת תשלום #${pr.number} — ${pr.supplier.name}`} wide busy={busy} statusMessage={busy ? 'מעדכן את דרישת התשלום' : undefined}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge meta={PAYMENT_REQUEST_STATUS[pr.status]} />
          <span className="text-lg font-bold num">{fmtMoneyExact(pr.amount)}</span>
          {pr.due_date && <span className="text-sm text-ink-muted">יעד: {fmtDate(pr.due_date)}</span>}
        </div>
        {pr.notes && <div className="text-sm text-ink-soft bg-surface-sunken rounded-lg px-3 py-2">{pr.notes}</div>}

        {linksLoading ? <div role="status" className="text-sm text-ink-muted">טוען חשבוניות מקושרות…</div> : linksError ? <ErrorNote message={linksError} /> : links?.length ? (
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
          {checks ? <CheckList checks={checks} /> : <div role="status" className="flex items-center gap-2 text-sm text-ink-muted"><Loader2 size={16} className="animate-spin text-ink-faint" aria-hidden="true" /> בודק את הדרישה…</div>}
        </div>

        {isOffice && (
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            {['draft'].includes(pr.status) && (
              <button className="btn-primary" disabled={busy} onClick={() => void setStatus('pending_approval')}><Send size={15} /> שליחה לאישור</button>
            )}
            {['pending_approval', 'suspected_duplicate', 'investigation'].includes(pr.status) && (
              <button className={hasCritical ? 'btn-danger' : 'btn-primary'} disabled={busy} onClick={() => void setStatus('approved')}>
                <CheckCircle2 size={15} /> {hasCritical ? 'אישור למרות האזהרות' : 'אישור הדרישה'}
              </button>
            )}
            {['approved'].includes(pr.status) && (
              <button className="btn-primary" disabled={busy} onClick={() => void setStatus('sent_for_execution')}><Send size={15} /> העברה לגורם המבצע</button>
            )}
            {!['cancelled', 'executed', 'matched'].includes(pr.status) && (
              <button className="btn-ghost text-alert-solid" disabled={busy} onClick={() => setCancelOpen(true)}><XCircle size={15} /> ביטול</button>
            )}
          </div>
        )}
      </div>

      <ConfirmDialog open={cancelOpen} onClose={() => setCancelOpen(false)}
        onConfirm={(reason) => void setStatus('cancelled', reason)}
        title="ביטול דרישת תשלום" message="הביטול יתועד ביומן הביקורת." danger requireReason busy={busy} />
    </Modal>
  );
}
