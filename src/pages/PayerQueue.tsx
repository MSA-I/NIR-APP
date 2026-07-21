import { useState } from 'react';
import { Landmark, CheckCircle2, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { useToast, StatusBadge, Modal, EmptyState, ErrorNote, SkeletonList, Note } from '../components/ui';
import { DocumentList } from '../components/FileUpload';
import { refreshInvoicePaymentStatus } from '../lib/checks';
import { PAYMENT_REQUEST_STATUS } from '../lib/status';
import { fmtMoneyExact, fmtDate, todayISO } from '../lib/format';
import type { PaymentRequest } from '../lib/types';

/**
 * Focused execution view for the payment executor (payer role).
 * Shows ONLY approved payment requests + the details needed to perform a transfer.
 */
type Row = PaymentRequest & {
  supplier: { id: string; name: string; bank_details: string | null };
  invoices: { invoice_id: string; amount_allocated: number; invoice: { invoice_number: string } }[];
};

export default function PayerQueue() {
  const [selected, setSelected] = useState<Row | null>(null);

  const { data, loading, error, refetch } = useQuery(async () =>
    unwrap(await supabase.from('payment_requests')
      .select('*, supplier:suppliers(id, name, bank_details), invoices:payment_request_invoices(invoice_id, amount_allocated, invoice:invoices(invoice_number))')
      .in('status', ['approved', 'sent_for_execution', 'executed', 'matched'])
      .order('due_date', { ascending: true, nullsFirst: false })) as Promise<Row[]>);

  if (loading) return <SkeletonList />;
  if (error) return <ErrorNote message={error} />;

  const pending = (data ?? []).filter((r) => ['approved', 'sent_for_execution'].includes(r.status));
  const done = (data ?? []).filter((r) => ['executed', 'matched'].includes(r.status));

  return (
    <div className="space-y-5 max-w-2xl">
      <h1 className="page-title">תשלומים לביצוע</h1>

      {!pending.length ? (
        <div className="card"><EmptyState title="אין העברות שממתינות לביצוע" subtitle="דרישות תשלום מאושרות יופיעו כאן" /></div>
      ) : (
        <div className="space-y-3">
          {pending.map((r) => (
            <button key={r.id} className="card w-full text-start p-4 hover:border-action-line transition-all" onClick={() => setSelected(r)}>
              <div className="flex items-center justify-between">
                <span className="font-semibold text-ink">{r.supplier.name}</span>
                <span className="text-lg font-bold num">{fmtMoneyExact(r.amount)}</span>
              </div>
              <div className="flex items-center gap-3 mt-1.5 text-sm text-ink-muted">
                <StatusBadge meta={PAYMENT_REQUEST_STATUS[r.status]} />
                {r.due_date && <span>לתשלום עד {fmtDate(r.due_date)}</span>}
                <span>{r.invoices.length} חשבוניות</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {done.length > 0 && (
        <div>
          <h2 className="section-title mb-2 text-ink-muted">בוצעו לאחרונה</h2>
          <div className="card divide-y divide-line-soft">
            {done.slice(0, 8).map((r) => (
              <div key={r.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                <span>{r.supplier.name}</span>
                <span className="flex items-center gap-3">
                  <StatusBadge meta={PAYMENT_REQUEST_STATUS[r.status]} />
                  <span className="num font-medium">{fmtMoneyExact(r.amount)}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {selected && <ExecuteModal pr={selected} onClose={() => setSelected(null)} onDone={() => { setSelected(null); void refetch(); }} />}
    </div>
  );
}

function ExecuteModal({ pr, onClose, onDone }: { pr: Row; onClose: () => void; onDone: () => void }) {
  const { profile } = useAuth();
  const toast = useToast();
  const [f, setF] = useState({ paid_date: todayISO(), amount: pr.amount.toString(), reference: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [paymentId, setPaymentId] = useState<string | null>(null);

  async function execute() {
    const amount = Number(f.amount);
    if (!amount || amount <= 0) { toast('סכום לא תקין', 'error'); return; }
    if (!f.reference.trim()) { toast('נדרשת אסמכתת העברה', 'error'); return; }
    setBusy(true);
    try {
      const payment = unwrap(await supabase.from('payments').insert({
        org_id: profile!.org_id, supplier_id: pr.supplier.id, payment_request_id: pr.id,
        amount, paid_date: f.paid_date, method: 'העברה בנקאית', reference: f.reference.trim(),
        executed_by: profile!.id, notes: f.notes || null,
      }).select('id').single()) as { id: string };

      // allocate against the linked invoices, proportional to the request allocations, capped by the actual amount
      let remaining = amount;
      for (const link of pr.invoices) {
        if (remaining <= 0) break;
        const alloc = Math.min(link.amount_allocated, remaining);
        const ins = await supabase.from('payment_allocations').insert({
          payment_id: payment.id, invoice_id: link.invoice_id, amount: alloc,
        });
        if (ins.error) throw new Error(ins.error.message);
        remaining -= alloc;
        await refreshInvoicePaymentStatus(link.invoice_id);
      }

      const upd = await supabase.from('payment_requests').update({
        status: 'executed', executor_notes: f.notes || null,
      }).eq('id', pr.id);
      if (upd.error) throw new Error(upd.error.message);

      setPaymentId(payment.id);
      toast('ההעברה נרשמה בהצלחה');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'שגיאה ברישום ההעברה', 'error');
    } finally {
      setBusy(false);
    }
  }

  if (paymentId) {
    return (
      <Modal open onClose={onDone} title="ההעברה נרשמה">
        <div className="text-center mb-4">
          <CheckCircle2 size={40} className="text-emerald-500 mx-auto mb-2" />
          <p className="text-sm text-ink-soft">אפשר לצרף עכשיו אישור העברה (צילום מסך / PDF).</p>
        </div>
        <DocumentList entityType="payment" entityId={paymentId} capture />
        <div className="flex justify-end mt-4"><button className="btn-primary" onClick={onDone}>סיום</button></div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} title={`ביצוע העברה — ${pr.supplier.name}`}>
      <div className="space-y-4">
        <div className="rounded-lg bg-surface-sunken border border-line px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-ink-mid mb-1"><Landmark size={15} /> פרטי חשבון להעברה</div>
          <div className="text-sm text-ink-body" dir="ltr" style={{ textAlign: 'right' }}>{pr.supplier.bank_details ?? 'לא הוזנו פרטי בנק — יש לברר מול המשרד'}</div>
        </div>

        <dl className="text-sm space-y-1.5">
          <div className="flex justify-between"><dt className="text-ink-muted">סכום מאושר</dt><dd className="font-bold num">{fmtMoneyExact(pr.amount)}</dd></div>
          {pr.due_date && <div className="flex justify-between"><dt className="text-ink-muted">תאריך יעד</dt><dd>{fmtDate(pr.due_date)}</dd></div>}
          <div className="flex justify-between"><dt className="text-ink-muted">חשבוניות</dt>
            <dd dir="ltr">{pr.invoices.map((i) => i.invoice.invoice_number).join(', ') || '—'}</dd></div>
          {pr.notes && <Note tone="await">{pr.notes}</Note>}
        </dl>

        <hr className="border-line-soft" />

        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">תאריך ביצוע</label><input type="date" className="input" value={f.paid_date} onChange={(e) => setF((s) => ({ ...s, paid_date: e.target.value }))} /></div>
          <div><label className="label">סכום שהועבר בפועל</label><input type="number" step="0.01" className="input num" value={f.amount} onChange={(e) => setF((s) => ({ ...s, amount: e.target.value }))} /></div>
        </div>
        <div><label className="label">אסמכתת העברה *</label><input className="input" dir="ltr" value={f.reference} onChange={(e) => setF((s) => ({ ...s, reference: e.target.value }))} /></div>
        <div><label className="label">הערות</label><input className="input" value={f.notes} onChange={(e) => setF((s) => ({ ...s, notes: e.target.value }))} /></div>

        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>ביטול</button>
          <button className="btn-primary" disabled={busy} onClick={() => void execute()}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />} ההעברה בוצעה
          </button>
        </div>
      </div>
    </Modal>
  );
}
