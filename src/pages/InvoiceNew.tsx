import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, ShieldAlert } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { PageLoader, useToast, ConfirmDialog, ErrorNote, Note } from '../components/ui';
import { CheckList } from './Invoices';
import { runInvoiceChecks, type CheckResult } from '../lib/checks';
import { logAction } from '../lib/audit';
import { todayISO } from '../lib/format';
import type { Supplier } from '../lib/types';
import { fetchAll } from '../lib/supabasePaging';
import { invoiceCheckFingerprint } from '../lib/checkFingerprint';

export default function InvoiceNew() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { profile, org } = useAuth();
  const toast = useToast();

  const presetSupplier = params.get('supplier') ?? '';
  const presetOrder = params.get('order');
  const presetReceipt = params.get('receipt');
  const presetFrom = params.get('from'); // duplicate-as-draft from the Invoices list

  const [f, setF] = useState({
    supplier_id: presetSupplier, invoice_number: '', invoice_date: todayISO(),
    before_vat: '', vat: '', total: '', notes: '',
  });

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
  const [checked, setChecked] = useState<{ fingerprint: string; results: CheckResult[] } | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const checkSequence = useRef(0);
  const [busy, setBusy] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);

  const { data: suppliers, loading, error } = useQuery<Supplier[]>(async () =>
    fetchAll<Supplier>((from, to) => supabase.from('suppliers').select('*').is('deleted_at', null)
      .order('name').order('id').range(from, to)));

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

  const linkedOrderIds = presetOrder ? [presetOrder] : [];
  const checkFingerprint = f.supplier_id && f.invoice_number.trim() && Number(f.total) > 0
    ? invoiceCheckFingerprint({
      supplierId: f.supplier_id, invoiceNumber: f.invoice_number, invoiceDate: f.invoice_date,
      totalAmount: Number(f.total), linkedOrderIds,
    })
    : null;
  const latestFingerprint = useRef(checkFingerprint);
  latestFingerprint.current = checkFingerprint;

  // Invalidate immediately, then debounce. A response is accepted only for the exact current form.
  useEffect(() => {
    const sequence = ++checkSequence.current;
    setChecked(null);
    setCheckError(null);
    if (!checkFingerprint) { setChecking(false); return; }
    setChecking(true);
    const t = setTimeout(() => {
      void runInvoiceChecks({
        supplier_id: f.supplier_id, invoice_number: f.invoice_number.trim(), invoice_date: f.invoice_date,
        total_amount: Number(f.total), linkedOrderIds,
      }).then((results) => {
        if (checkSequence.current === sequence && latestFingerprint.current === checkFingerprint) {
          setChecked({ fingerprint: checkFingerprint, results });
        }
      }).catch(() => {
        if (checkSequence.current === sequence) setCheckError('בדיקות הכפילות נכשלו. לא ניתן לשמור עד לניסיון חוזר מוצלח.');
      }).finally(() => {
        if (checkSequence.current === sequence) setChecking(false);
      });
    }, 500);
    return () => {
      clearTimeout(t);
      if (checkSequence.current === sequence) checkSequence.current += 1;
    };
  }, [checkFingerprint]);

  const checks = checked?.fingerprint === checkFingerprint ? checked.results : null;
  const hasCritical = checks?.some((c) => c.severity === 'critical') ?? false;
  const checksReady = checkFingerprint != null && checks != null && !checking && !checkError;

  async function save(overrideReason?: string) {
    if (!f.supplier_id || !f.invoice_number.trim() || !Number(f.total)) {
      toast('ספק, מספר חשבונית וסכום הם שדות חובה', 'error');
      return;
    }
    if (!checkFingerprint || !checksReady) {
      toast(checkError ?? 'יש להמתין לסיום בדיקות הכפילות', 'error');
      return;
    }
    setBusy(true);
    try {
      let freshChecks: CheckResult[];
      try {
        freshChecks = await runInvoiceChecks({
          supplier_id: f.supplier_id, invoice_number: f.invoice_number.trim(), invoice_date: f.invoice_date,
          total_amount: Number(f.total), linkedOrderIds,
        });
      } catch (checkFailure) {
        setChecked(null);
        setCheckError('בדיקות הכפילות נכשלו. החשבונית לא נשמרה.');
        throw checkFailure;
      }
      if (latestFingerprint.current !== checkFingerprint) throw new Error('פרטי החשבונית השתנו במהלך הבדיקה. יש להמתין לבדיקה העדכנית.');
      setChecked({ fingerprint: checkFingerprint, results: freshChecks });
      setCheckError(null);
      const freshHasCritical = freshChecks.some((check) => check.severity === 'critical');
      const inv = unwrap(await supabase.from('invoices').insert({
        org_id: profile!.org_id, supplier_id: f.supplier_id, invoice_number: f.invoice_number.trim(),
        invoice_date: f.invoice_date, received_date: todayISO(), received_by: profile!.id,
        amount_before_vat: Number(f.before_vat) || 0, vat_amount: Number(f.vat) || 0, total_amount: Number(f.total),
        review_status: freshHasCritical && !overrideReason ? 'investigation' : 'received',
        notes: f.notes || null,
      }).select('id').single()) as { id: string };

      if (presetOrder) await supabase.from('invoice_order_links').insert({ invoice_id: inv.id, order_id: presetOrder });
      if (presetReceipt) await supabase.from('invoice_receipt_links').insert({ invoice_id: inv.id, receipt_id: presetReceipt });

      if (freshHasCritical && overrideReason) {
        await logAction({
          orgId: profile!.org_id, action: 'override_duplicate_warning', entityType: 'invoices', entityId: inv.id,
          reason: overrideReason, newValues: { checks: freshChecks.map((c) => c.message) },
        });
      }
      if (freshHasCritical && !overrideReason) {
        // saved for investigation — also open an exception so it lands on the exceptions board
        await supabase.from('exceptions').insert({
          org_id: profile!.org_id, type: 'duplicate_invoice', severity: 'high', status: 'open',
          title: `חשד לחשבונית כפולה — מס׳ ${f.invoice_number.trim()}`,
          details: { checks: freshChecks.filter((c) => c.severity === 'critical').map((c) => c.message) },
          supplier_id: f.supplier_id, invoice_id: inv.id, assigned_role: 'office',
        });
      }
      toast('החשבונית נשמרה');
      navigate(`/invoices/${inv.id}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'שגיאה בשמירה', 'error');
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
      </div>

      {(checks || checking || checkError) && (
        <div className="card card-pad">
          <div className="section-title mb-3 flex items-center gap-2">
            בדיקות אוטומטיות
            {checking && <Loader2 size={14} className="animate-spin text-ink-faint" />}
          </div>
          {checkError && <Note tone="alert">{checkError}</Note>}
          {checks && <CheckList checks={checks} />}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button className="btn-secondary" onClick={() => navigate(-1)}>ביטול</button>
        {hasCritical ? (
          <>
            <button className="btn-secondary" disabled={busy || !checksReady} onClick={() => void save()}>שמירה כ״דורשת בירור״</button>
            <button className="btn-danger" disabled={busy || !checksReady} onClick={() => setOverrideOpen(true)}>
              <ShieldAlert size={15} /> אישור למרות האזהרה
            </button>
          </>
        ) : (
          <button className="btn-primary" disabled={busy || !checksReady} onClick={() => void save()}>שמירת חשבונית</button>
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
