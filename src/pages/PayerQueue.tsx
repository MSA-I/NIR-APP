import { useState } from 'react';
import { Landmark, CheckCircle2, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useToast, StatusBadge, Modal, EmptyState, ErrorNote, SkeletonList, Note } from '../components/ui';
import { DocumentList } from '../components/FileUpload';
import { PAYMENT_REQUEST_STATUS } from '../lib/status';
import { fmtMoneyExact, fmtDate, todayISO } from '../lib/format';
import { toHebrewError } from '../lib/errors';
import type { PaymentRequest } from '../lib/types';
import { useAuth } from '../auth/AuthContext';

/**
 * Focused execution view for payment executors (payer and accountant roles).
 * Shows ONLY approved payment requests + the details needed to perform a transfer.
 */
type Row = PaymentRequest & {
  supplier: { id: string; name: string; bank_details: string | null };
  invoices: { invoice_id: string; amount_allocated: number; invoice: { invoice_number: string } }[];
  approver: { full_name: string } | null;
};

type PayerQueueMode = 'regular' | 'emergency';

export default function PayerQueue({ mode = 'regular' }: { mode?: PayerQueueMode }) {
  const [selected, setSelected] = useState<Row | null>(null);

  const { data, loading, error, refetch } = useQuery(async () =>
    unwrap(await supabase.from('payment_requests')
      .select('*, supplier:suppliers(id, name, bank_details), invoices:payment_request_invoices(invoice_id, amount_allocated, invoice:invoices(invoice_number)), approver:profiles!payment_requests_approved_by_fkey(full_name)')
      .in('status', ['approved', 'sent_for_execution', 'executed', 'matched'])
      .order('due_date', { ascending: true, nullsFirst: false })) as Promise<Row[]>);

  if (loading) return <SkeletonList />;
  if (error) return <ErrorNote message={error} />;

  const pending = (data ?? []).filter((r) => ['approved', 'sent_for_execution'].includes(r.status));
  const done = (data ?? []).filter((r) => ['executed', 'matched'].includes(r.status));

  return (
    <div className="space-y-5 max-w-2xl">
      <h1 className="page-title">{mode === 'emergency' ? 'מסלול חירום לביצוע תשלום' : 'תשלומים לביצוע'}</h1>

      {mode === 'emergency' && (
        <Note tone="alert">מסלול זה מיועד לבעלים בלבד. כל ביצוע דורש אימות סיסמה טרי, סיבה מפורשת ונרשם ביומן הביקורת כפעולת חירום נפרדת.</Note>
      )}

      {!pending.length ? (
        <div className="card"><EmptyState title="אין העברות שממתינות לביצוע" subtitle={mode === 'emergency' ? 'רק דרישות תשלום מאושרות זמינות במסלול החירום' : 'דרישות תשלום מאושרות יופיעו כאן'} /></div>
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

      {selected && <ExecuteModal pr={selected} mode={mode} onClose={() => setSelected(null)} onDone={() => { setSelected(null); void refetch(); }} />}
    </div>
  );
}

function ExecuteModal({ pr, mode, onClose, onDone }: { pr: Row; mode: PayerQueueMode; onClose: () => void; onDone: () => void }) {
  const { session, profile } = useAuth();
  const toast = useToast();
  const [f, setF] = useState({ paid_date: todayISO(), reference: '', notes: '', reason: '' });
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [paymentId, setPaymentId] = useState<string | null>(null);

  async function execute() {
    if (!f.reference.trim()) { toast('נדרשת אסמכתת העברה', 'error'); return; }
    if (!f.reason.trim()) { toast('נדרשת סיבה לביצוע ההעברה', 'error'); return; }
    if (mode === 'emergency' && !password) { toast('נדרשת סיסמה לאימות זהות טרי', 'error'); return; }
    setBusy(true);
    try {
      if (mode === 'emergency') {
        const expectedUserId = session?.user.id;
        const email = session?.user.email;
        if (!expectedUserId || !email) throw new Error('לא ניתן לאמת את זהות המשתמש המחובר. יש להתחבר מחדש.');
        const authResult = await supabase.auth.signInWithPassword({ email, password }).finally(() => setPassword(''));
        if (authResult.error) throw authResult.error;
        if (authResult.data.user?.id !== expectedUserId) {
          await supabase.auth.signOut();
          throw new Error('זהות המשתמש השתנתה בזמן האימות. יש להתחבר מחדש.');
        }
      }

      const payment = unwrap(await supabase.rpc(mode === 'emergency' ? 'execute_emergency_payment_request' : 'execute_payment_request', {
        p_payment_request_id: pr.id,
        p_paid_date: f.paid_date,
        p_method: 'העברה בנקאית',
        p_reference: f.reference.trim(),
        p_notes: f.notes.trim() || null,
        p_allocations: pr.invoices.map((link) => ({
          invoice_id: link.invoice_id,
          credit_id: null,
          amount: link.amount_allocated,
        })),
        p_reason: f.reason.trim(),
      })) as { payment_id: string };

      setPaymentId(payment.payment_id);
      toast(mode === 'emergency' ? 'העברת החירום נרשמה בהצלחה' : 'ההעברה נרשמה בהצלחה');
    } catch (e) {
      toast(toHebrewError(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (paymentId) {
    return (
      <Modal open onClose={onDone} title="ההעברה נרשמה">
        <div className="text-center mb-4">
          <CheckCircle2 size={40} className="text-done-solid mx-auto mb-2" />
          <p className="text-sm text-ink-soft">אפשר לצרף עכשיו אישור העברה (צילום מסך / PDF).</p>
        </div>
        <DocumentList entityType="payment" entityId={paymentId} capture />
        <div className="flex justify-end mt-4"><button className="btn-primary" onClick={onDone}>סיום</button></div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} title={`${mode === 'emergency' ? 'ביצוע חירום' : 'ביצוע העברה'} — ${pr.supplier.name}`} busy={busy} statusMessage={busy ? 'רושם את ההעברה' : undefined}>
      <div className="space-y-4">
        <div className="rounded-lg bg-surface-sunken border border-line px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-ink-mid mb-1"><Landmark size={15} /> פרטי חשבון להעברה</div>
          <div className="text-sm text-ink-body text-start" dir="ltr">{pr.supplier.bank_details ?? 'לא הוזנו פרטי בנק — יש לברר מול המשרד'}</div>
        </div>

        <dl className="text-sm space-y-1.5">
          <div className="flex justify-between"><dt className="text-ink-muted">סכום מאושר</dt><dd className="font-bold num">{fmtMoneyExact(pr.amount)}</dd></div>
          {pr.due_date && <div className="flex justify-between"><dt className="text-ink-muted">תאריך יעד</dt><dd>{fmtDate(pr.due_date)}</dd></div>}
          <div className="flex justify-between"><dt className="text-ink-muted">חשבוניות</dt>
            <dd dir="ltr">{pr.invoices.map((i) => i.invoice.invoice_number).join(', ') || '—'}</dd></div>
          <div className="flex justify-between"><dt className="text-ink-muted">אושר על ידי</dt><dd>{pr.approver?.full_name ?? 'לא זמין'}</dd></div>
          <div className="flex justify-between"><dt className="text-ink-muted">מבוצע על ידי</dt><dd>{profile?.full_name ?? 'המשתמש המחובר'}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-ink-muted">רישום ביומן</dt><dd className="text-start">{mode === 'emergency' ? 'ביצוע תשלום במסלול חירום והסיבה' : 'ביצוע תשלום והסיבה'}</dd></div>
          {pr.notes && <Note tone="await">{pr.notes}</Note>}
        </dl>

        <hr className="border-line-soft" />

        <div className="grid grid-cols-2 gap-3">
          <div><label className="label" htmlFor="payment-execution-date">תאריך ביצוע</label><input id="payment-execution-date" type="date" className="input" value={f.paid_date} onChange={(e) => setF((s) => ({ ...s, paid_date: e.target.value }))} /></div>
          <div><label className="label" htmlFor="payment-execution-amount">סכום מאושר להעברה</label><input id="payment-execution-amount" type="number" className="input num" value={pr.amount} readOnly /></div>
        </div>
        <div><label className="label" htmlFor="payment-execution-reference">אסמכתת העברה *</label><input id="payment-execution-reference" className="input num" dir="ltr" value={f.reference} onChange={(e) => setF((s) => ({ ...s, reference: e.target.value }))} /></div>
        <div><label className="label" htmlFor="payment-execution-notes">הערות</label><input id="payment-execution-notes" className="input" value={f.notes} onChange={(e) => setF((s) => ({ ...s, notes: e.target.value }))} /></div>
        <div><label className="label" htmlFor="payment-execution-reason">סיבת ביצוע / אישור הפעולה *</label><input id="payment-execution-reason" className="input" value={f.reason} onChange={(e) => setF((s) => ({ ...s, reason: e.target.value }))} /></div>
        {mode === 'emergency' && (
          <div>
            <label className="label" htmlFor="emergency-payment-password">סיסמת הבעלים לאימות טרי *</label>
            <input id="emergency-payment-password" type="password" autoComplete="current-password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button className="btn-secondary" disabled={busy} onClick={onClose}>ביטול</button>
          <button className="btn-primary" disabled={busy} onClick={() => void execute()}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />} {mode === 'emergency' ? 'ביצוע חירום ורישום ההעברה' : 'ההעברה בוצעה'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
