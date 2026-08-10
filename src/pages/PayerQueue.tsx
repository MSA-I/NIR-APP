import { useState } from 'react';
import { Landmark, CheckCircle2, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useToast, StatusBadge, Modal, EmptyState, ErrorNote, PageHeader, SkeletonList, Note } from '../components/ui';
import { ReauthModal } from '../components/ReauthModal';
import { DocumentList } from '../components/FileUpload';
import { PAYMENT_REQUEST_STATUS } from '../lib/status';
import { fmtMoneyExact, fmtDate, todayISO } from '../lib/format';
import { toHebrewError } from '../lib/errors';
import type { PaymentRequest } from '../lib/types';
import { useAuth } from '../auth/AuthContext';
import { financialSupplierMap } from '../lib/financialSuppliers';

/**
 * Focused execution view for payment executors (payer and accountant roles).
 * Shows ONLY approved payment requests + the details needed to perform a transfer.
 */
type Row = Omit<PaymentRequest, 'supplier'> & {
  supplier: { id: string; name: string; bank_details: string | null };
  invoices: { invoice_id: string; amount_allocated: number; invoice: { invoice_number: string } | null }[];
  approver: { full_name: string } | null;
};
type RawRow = Omit<Row, 'supplier'>;

/**
 * The one payment-execution queue (G4, 10.08.2026).
 *
 * There used to be a second mode here — the owner's emergency route, reached from
 * /pay/emergency. The owner asked for it to go, and what makes that safe rather than lossy is
 * that it never did anything this path cannot: the same approved payment requests, the same
 * reference, the same mandatory reason, the same audit row. Its only differences were an
 * unconditional password prompt and a separate RPC — and 0061 asserts password freshness on
 * this RPC too.
 *
 * Emergency payments already executed keep their payments, their audit rows and their history.
 * Only the ability to start a NEW one is gone.
 */
export default function PayerQueue() {
  const [selected, setSelected] = useState<Row | null>(null);

  const { data, loading, error, refetch } = useQuery(async () => {
    const rows = unwrap(await supabase.from('payment_requests')
      .select('*, invoices:payment_request_invoices(invoice_id, amount_allocated, invoice:invoices(invoice_number)), approver:profiles!p0_pr_approved_actor_tenant_fk(full_name)')
      .in('status', ['approved', 'sent_for_execution', 'executed', 'matched'])
      .order('due_date', { ascending: true, nullsFirst: false })) as RawRow[];
    const suppliers = await financialSupplierMap(rows.map((row) => row.supplier_id));
    return rows.map<Row>((row) => ({
      ...row,
      supplier: suppliers.get(row.supplier_id) ?? { id: row.supplier_id, name: '—', bank_details: null },
    }));
  });

  if (loading) return <SkeletonList />;
  if (error) return <ErrorNote message={error} />;

  const pending = (data ?? []).filter((r) => ['approved', 'sent_for_execution'].includes(r.status));
  const done = (data ?? []).filter((r) => ['executed', 'matched'].includes(r.status));

  return (
    <div className="space-y-5 max-w-2xl">
      <PageHeader title="תשלומים לביצוע"
        meta={`${pending.length} העברות ממתינות לביצוע`} />

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
              {r.open_credit_override_total != null && (
                <div className="mt-3 text-sm text-await-fg">
                  אושר בחריגה ללא קיזוז זיכויים בסך <span className="num font-semibold">{fmtMoneyExact(r.open_credit_override_total)}</span>
                </div>
              )}
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
  const [f, setF] = useState({ paid_date: todayISO(), reference: '', notes: '', reason: '' });
  const [reauthOpen, setReauthOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [paymentId, setPaymentId] = useState<string | null>(null);

  // Field validation first, then the step-up gate. Re-authentication happens only when the JWT's
  // password AMR entry is stale — the server (0061) asserts freshness itself, so a fresh session
  // sees no new modal and a stale one is prompted instead of rejected.
  function requestExecute() {
    if (!f.reference.trim()) { toast('נדרשת אסמכתת העברה', 'error'); return; }
    if (!f.reason.trim()) { toast('נדרשת סיבה לביצוע ההעברה', 'error'); return; }
    setReauthOpen(true);
  }

  async function execute() {
    setBusy(true);
    try {
      const payment = unwrap(await supabase.rpc('execute_payment_request', {
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
      toast('ההעברה נרשמה בהצלחה');
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
    <Modal open onClose={onClose} title={`ביצוע העברה — ${pr.supplier.name}`} busy={busy} statusMessage={busy ? 'רושם את ההעברה' : undefined}>
      <div className="space-y-4">
        <div className="rounded-lg bg-surface-sunken border border-line px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-ink-mid mb-1"><Landmark size={15} /> פרטי חשבון להעברה</div>
          <div className="text-sm text-ink-body text-start" dir="ltr">{pr.supplier.bank_details ?? 'לא הוזנו פרטי בנק'}</div>
        </div>

        {/* G1, finding 11. `payer` reaches two screens in the whole product (/dashboard and /pay),
            has no search and no FAB, and cannot open /suppliers or /exceptions — so a missing or
            wrong bank account had one static string and no channel at all. What could not be built
            here: the audit's suggested "open an exception" button. `exceptions` has no INSERT grant
            for the browser (0036:83 grants UPDATE only) and its policy names owner/office/kitchen
            (0022:346) — `payer` is in neither list, so that button would have failed on click,
            which is the very defect this task removes. Recorded instead as OPEN-DECISIONS #116.
            The sentence that IS true is the one that matters most: the button below records a
            transfer, it does not perform one. */}
        {!pr.supplier.bank_details && (
          <Note tone="alert">
            <span>
              לא הוזנו פרטי בנק לספק זה, ולכן לא ניתן לבצע את ההעברה. יש לפנות לבעלים או למנהל הרכש כדי שיזינו את הפרטים
              בכרטיס הספק. אין במסך זה דרך לדווח על כך.
            </span>
          </Note>
        )}
        <p className="text-xs text-ink-muted">
          הכפתור בתחתית המסך <b>מתעד</b> העברה שכבר בוצעה בבנק — הוא אינו מבצע אותה. אין ללחוץ עליו לפני שההעברה נעשתה בפועל.
        </p>

        <dl className="text-sm space-y-1.5">
          <div className="flex justify-between"><dt className="text-ink-muted">סכום מאושר</dt><dd className="font-bold num">{fmtMoneyExact(pr.amount)}</dd></div>
          {pr.due_date && <div className="flex justify-between"><dt className="text-ink-muted">תאריך יעד</dt><dd>{fmtDate(pr.due_date)}</dd></div>}
          <div className="flex justify-between"><dt className="text-ink-muted">חשבוניות</dt>
            <dd dir="ltr">{pr.invoices.map((i) => i.invoice?.invoice_number).filter(Boolean).join(', ') || 'לא זמינות'}</dd></div>
          <div className="flex justify-between"><dt className="text-ink-muted">אושר על ידי</dt><dd>{pr.approver?.full_name ?? 'לא זמין'}</dd></div>
          <div className="flex justify-between"><dt className="text-ink-muted">מבוצע על ידי</dt><dd>{profile?.full_name ?? 'המשתמש המחובר'}</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-ink-muted">רישום ביומן</dt><dd className="text-start">{'ביצוע תשלום והסיבה'}</dd></div>
          {pr.notes && <Note tone="await">{pr.notes}</Note>}
          {pr.open_credit_override_total != null && (
            <Note tone="alert">
              <strong>אושר באישור חריג ללא קיזוז הזיכוי.</strong>{' '}
              הזיכויים הפתוחים בסך <span className="num">{fmtMoneyExact(pr.open_credit_override_total)}</span> לא קוזזו אוטומטית.
              <span className="block mt-1">סיבת אישור החריגה: {pr.open_credit_override_reason}</span>
            </Note>
          )}
        </dl>

        <hr className="border-line-soft" />

        <div className="grid grid-cols-2 gap-3">
          <div><label className="label" htmlFor="payment-execution-date">תאריך ביצוע</label><input id="payment-execution-date" type="date" className="input" value={f.paid_date} onChange={(e) => setF((s) => ({ ...s, paid_date: e.target.value }))} /></div>
          <div><label className="label" htmlFor="payment-execution-amount">סכום מאושר להעברה</label><input id="payment-execution-amount" type="number" className="input num" value={pr.amount} readOnly /></div>
        </div>
        <div><label className="label" htmlFor="payment-execution-reference">אסמכתת העברה *</label><input id="payment-execution-reference" className="input num" dir="ltr" value={f.reference} onChange={(e) => setF((s) => ({ ...s, reference: e.target.value }))} /></div>
        <div><label className="label" htmlFor="payment-execution-notes">הערות</label><input id="payment-execution-notes" className="input" value={f.notes} onChange={(e) => setF((s) => ({ ...s, notes: e.target.value }))} /></div>
        <div><label className="label" htmlFor="payment-execution-reason">סיבת ביצוע / אישור הפעולה *</label><input id="payment-execution-reason" className="input" value={f.reason} onChange={(e) => setF((s) => ({ ...s, reason: e.target.value }))} /></div>

        <div className="flex justify-end gap-2">
          <button className="btn-secondary" disabled={busy} onClick={onClose}>ביטול</button>
          <button className="btn-primary" disabled={busy} onClick={requestExecute}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />} ההעברה בוצעה
          </button>
        </div>
      </div>

      <ReauthModal
        open={reauthOpen}
        title="אימות זהות לביצוע ההעברה"
        onConfirm={() => { setReauthOpen(false); void execute(); }}
        onCancel={() => setReauthOpen(false)}
      />
    </Modal>
  );
}
