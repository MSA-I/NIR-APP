import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, ShieldAlert } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { PageLoader, useToast, ConfirmDialog, ErrorNote } from '../components/ui';
import { CheckList } from './Invoices';
import { runInvoiceChecks, type CheckResult } from '../lib/checks';
import { todayISO } from '../lib/format';
import { toHebrewError } from '../lib/errors';
import type { Supplier } from '../lib/types';

export default function InvoiceNew() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { org } = useAuth();
  const toast = useToast();

  const presetSupplier = params.get('supplier') ?? '';
  const presetOrder = params.get('order');
  const presetReceipt = params.get('receipt');
  const presetFrom = params.get('from'); // duplicate-as-draft from the Invoices list

  const [f, setF] = useState({
    supplier_id: presetSupplier, invoice_number: '', invoice_date: todayISO(),
    before_vat: '', vat: '', total: '', notes: '', reason: '',
  });
  const [invoiceId] = useState(() => crypto.randomUUID());

  // ?from=<invoiceId> ("שכפול כטיוטה"): prefill supplier, amounts and notes from the source.
  // invoice_number stays EMPTY and the date stays today — a duplicated number would trip the
  // duplicate checks below, and rightly so.
  useEffect(() => {
    if (!presetFrom) return;
    void (async () => {
      const res = await supabase.from('invoices')
        .select('supplier_id, amount_before_vat, vat_amount, total_amount, notes')
        .eq('id', presetFrom).maybeSingle();
      if (res.error || !res.data) { toast('טעינת חשבונית המקור נכשלה', 'error'); return; }
      const src = res.data as { supplier_id: string; amount_before_vat: number; vat_amount: number; total_amount: number; notes: string | null };
      setF((s) => ({
        ...s,
        supplier_id: src.supplier_id,
        before_vat: src.amount_before_vat ? String(src.amount_before_vat) : '',
        vat: src.vat_amount ? String(src.vat_amount) : '',
        total: src.total_amount ? String(src.total_amount) : '',
        notes: src.notes ?? '',
      }));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetFrom]);
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);

  const { data: suppliers, loading, error } = useQuery<Supplier[]>(async () =>
    unwrap(await supabase.from('suppliers').select('*').is('deleted_at', null).order('name')));

  const vatRate = (org?.vat_rate ?? 18) / 100;
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));

  // auto-complete VAT math from whichever field the user fills
  function onBeforeVat(v: string) {
    const n = Number(v);
    setF((s) => ({ ...s, before_vat: v, vat: n ? (n * vatRate).toFixed(2) : s.vat, total: n ? (n * (1 + vatRate)).toFixed(2) : s.total }));
  }
  function onTotal(v: string) {
    const n = Number(v);
    setF((s) => ({ ...s, total: v, before_vat: n ? (n / (1 + vatRate)).toFixed(2) : s.before_vat, vat: n ? (n - n / (1 + vatRate)).toFixed(2) : s.vat }));
  }

  // debounce-run duplicate checks as the key fields fill in
  useEffect(() => {
    if (!f.supplier_id || !f.invoice_number || !Number(f.total)) { setChecks(null); return; }
    const t = setTimeout(() => {
      setChecking(true);
      void runInvoiceChecks({
        supplier_id: f.supplier_id, invoice_number: f.invoice_number.trim(),
        invoice_date: f.invoice_date, total_amount: Number(f.total),
        linkedOrderIds: presetOrder ? [presetOrder] : [],
      }).then(setChecks).finally(() => setChecking(false));
    }, 500);
    return () => clearTimeout(t);
  }, [f.supplier_id, f.invoice_number, f.invoice_date, f.total, presetOrder]);

  const hasCritical = checks?.some((c) => c.severity === 'critical') ?? false;

  async function save(overrideReason?: string) {
    if (!f.supplier_id || !f.invoice_number.trim() || !Number(f.total)) {
      toast('ספק, מספר חשבונית וסכום הם שדות חובה', 'error');
      return;
    }
    if (!f.reason.trim()) { toast('נדרשת סיבה לקליטת החשבונית', 'error'); return; }
    setBusy(true);
    try {
      const inv = unwrap(await supabase.rpc('create_invoice', {
        p_invoice_id: invoiceId,
        p_supplier_id: f.supplier_id,
        p_invoice_number: f.invoice_number.trim(),
        p_invoice_date: f.invoice_date,
        p_amount_before_vat: Number(f.before_vat) || 0,
        p_vat_amount: Number(f.vat) || 0,
        p_total_amount: Number(f.total),
        p_notes: f.notes.trim() || null,
        p_order_id: presetOrder,
        p_receipt_id: presetReceipt,
        p_override_reason: overrideReason?.trim() || null,
        p_reason: f.reason.trim(),
      })) as { invoice_id: string; review_status: string; duplicate_detected: boolean };

      toast(inv.review_status === 'investigation'
        ? 'החשבונית נשמרה כדורשת בירור ונפתח חריג לבדיקה'
        : 'החשבונית נשמרה');
      navigate(`/invoices/${inv.invoice_id}`);
    } catch (e) {
      toast(toHebrewError(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <PageLoader />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="page-title">חשבונית חדשה</h1>
      {presetOrder && <div className="text-sm text-ink-muted">החשבונית תקושר אוטומטית להזמנה ולקבלת הסחורה שממנה הגעת.</div>}

      <div className="card card-pad grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2">
          <label className="label">ספק *</label>
          <select className="input" value={f.supplier_id} onChange={(e) => set('supplier_id', e.target.value)}>
            <option value="">בחר ספק...</option>
            {suppliers?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div><label className="label">מספר חשבונית *</label><input className="input" dir="ltr" value={f.invoice_number} onChange={(e) => set('invoice_number', e.target.value)} /></div>
        <div><label className="label">תאריך חשבונית *</label><input type="date" className="input" value={f.invoice_date} onChange={(e) => set('invoice_date', e.target.value)} /></div>
        <div><label className="label">סכום לפני מע״מ</label><input type="number" step="0.01" className="input num" value={f.before_vat} onChange={(e) => onBeforeVat(e.target.value)} /></div>
        <div><label className="label">מע״מ ({org?.vat_rate ?? 18}%)</label><input type="number" step="0.01" className="input num" value={f.vat} onChange={(e) => set('vat', e.target.value)} /></div>
        <div><label className="label">סה״כ לתשלום *</label><input type="number" step="0.01" className="input num font-semibold" value={f.total} onChange={(e) => onTotal(e.target.value)} /></div>
        <div className="sm:col-span-2"><label className="label">הערות</label><textarea className="input" rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></div>
        <div className="sm:col-span-2"><label className="label">סיבת קליטת החשבונית *</label><input className="input" value={f.reason} onChange={(e) => set('reason', e.target.value)} /></div>
      </div>

      {(checks || checking) && (
        <div className="card card-pad">
          <div className="section-title mb-3 flex items-center gap-2">
            בדיקות אוטומטיות
            {checking && <Loader2 size={14} className="animate-spin text-ink-faint" />}
          </div>
          {checks && <CheckList checks={checks} />}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button className="btn-secondary" onClick={() => navigate(-1)}>ביטול</button>
        {hasCritical ? (
          <>
            <button className="btn-secondary" disabled={busy} onClick={() => void save()}>שמירה כ״דורשת בירור״</button>
            <button className="btn-danger" disabled={busy} onClick={() => {
              if (!f.reason.trim()) toast('נדרשת סיבה לקליטת החשבונית', 'error');
              else setOverrideOpen(true);
            }}>
              <ShieldAlert size={15} /> אישור למרות האזהרה
            </button>
          </>
        ) : (
          <button className="btn-primary" disabled={busy} onClick={() => void save()}>שמירת חשבונית</button>
        )}
      </div>

      <ConfirmDialog open={overrideOpen} onClose={() => setOverrideOpen(false)}
        onConfirm={(reason) => { setOverrideOpen(false); void save(reason); }}
        title="אישור חריגה — חשד לכפילות"
        message="נמצאו ממצאים קריטיים. אישור ישמור את החשבונית כרגילה למרות האזהרות. הפעולה והסיבה יתועדו ביומן הביקורת."
        confirmLabel="אישור ושמירה" danger requireReason busy={busy} />
    </div>
  );
}
