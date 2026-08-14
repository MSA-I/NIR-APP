import { useEffect, useRef, useState } from 'react';
import { reasonOr } from '../lib/reason';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Loader2, ShieldAlert } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { Breadcrumbs, PageHeader, RecordSkeleton, useToast, ConfirmDialog, ErrorNote, Note, StatusBadge } from '../components/ui';
import { CheckList } from './Invoices';
import { runInvoiceChecks, type CheckResult } from '../lib/checks';
import { fmtDate, todayISO } from '../lib/format';
import { toHebrewError } from '../lib/errors';
import type { Supplier } from '../lib/types';
import { type PageResponse, fetchAll } from '../lib/supabasePaging';
import { invoiceCheckFingerprint } from '../lib/checkFingerprint';
import { invoiceDraftFromInterpretation } from '../components/document-review/model';
import type { InterpretationContract } from '../lib/useDocumentProcessing';
import { PO_STATUS } from '../lib/status';
import { SupplierSelectField, useQuickSupplier } from '../components/QuickSupplierPicker';
import { SUPPLIER_COLUMNS } from '../lib/supplierColumns';
import {
  isUuid,
  resolveInvoiceLinkedContext,
  type InvoiceContextOrder,
  type InvoiceContextReceipt,
  type InvoiceContextSupplier,
} from '../lib/invoiceLinkedContext';

export default function InvoiceNew() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { org, profile } = useAuth();
  const toast = useToast();

  const presetSupplier = params.get('supplier') ?? '';
  const presetOrder = params.get('order');
  const presetReceipt = params.get('receipt');
  const presetDocument = params.get('document'); // draft from a reviewed, scanned document

  const [f, setF] = useState({
    supplier_id: presetSupplier, invoice_number: '', invoice_date: todayISO(),
    before_vat: '', vat: '', total: '', notes: '', reason: '',
  });
  const [invoiceId] = useState(() => crypto.randomUUID());
  const [dirty, setDirty] = useState(false);
  const [leaveTarget, setLeaveTarget] = useState<string | null>(null);

  /*
   * `?from=<invoiceId>` is gone (owner, 11.08.2026). It prefilled this form from an existing
   * invoice, and it existed for one reason: correcting a wrong amount meant soft deleting the
   * invoice and re-typing it, because no command edits one. But a supplier's invoice is not ours
   * to correct -- the supplier reissues it or sends a credit note, and both arrive as documents.
   * See the note at the top of Invoices.tsx.
   */

  // ?document=<documentId>: draft from a scanned document whose type a reviewer approved. The
  // interpretation only fills the form -- every value below is still the human's to check, the
  // duplicate checks still run on it, and create_invoice is still what writes the record. A field
  // the model did not read comes through empty rather than guessed.
  useEffect(() => {
    if (!presetDocument) return;
    void (async () => {
      const [interpretation, document] = await Promise.all([
        supabase.from('document_interpretations').select('payload, suggested_supplier_id')
          .eq('document_id', presetDocument).order('created_at', { ascending: false })
          .limit(1).maybeSingle(),
        supabase.from('documents').select('file_name').eq('id', presetDocument).maybeSingle(),
      ]);
      if (interpretation.error || !interpretation.data) {
        toast('לא נמצא פירוש למסמך המבוקש. אפשר למלא את החשבונית ידנית.', 'error');
        return;
      }
      const src = interpretation.data as { payload: InterpretationContract; suggested_supplier_id: string | null };
      const draft = invoiceDraftFromInterpretation(src.payload);
      const fileName = (document.data as { file_name: string } | null)?.file_name;
      setF((s) => ({
        ...s,
        supplier_id: src.suggested_supplier_id ?? s.supplier_id,
        invoice_number: draft.invoice_number || s.invoice_number,
        invoice_date: draft.invoice_date || s.invoice_date,
        before_vat: draft.before_vat || s.before_vat,
        vat: draft.vat || s.vat,
        total: draft.total || s.total,
        // A file name is something a bookkeeper can recognise later; the document uuid is not.
        reason: s.reason || (fileName ? `נקלטה מהמסמך הסרוק ${fileName}` : 'נקלטה ממסמך סרוק'),
      }));
      setDirty(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetDocument]);
  const [checked, setChecked] = useState<{ fingerprint: string; results: CheckResult[] } | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const checkSequence = useRef(0);
  const [busy, setBusy] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);

  const { data: suppliers, loading, error } = useQuery<Supplier[]>(async () =>
    fetchAll<Supplier>((from, to) => supabase.from('suppliers').select(SUPPLIER_COLUMNS)
      .is('deleted_at', null).order('name').order('id')
      .range(from, to) as unknown as PromiseLike<PageResponse<Supplier>>));

  const linksRequested = !!presetOrder || !!presetReceipt;
  const { data: linkResolution, loading: linksLoading } = useQuery(async () => {
    if (!linksRequested) return resolveInvoiceLinkedContext(null, null, null, null, null);
    if ((presetOrder && !isUuid(presetOrder)) || (presetReceipt && !isUuid(presetReceipt))) {
      return resolveInvoiceLinkedContext(presetOrder, presetReceipt, null, null, null);
    }
    try {
      const receipt = presetReceipt
        ? unwrap(await supabase.from('goods_receipts').select('id, number, order_id, received_at')
          .eq('id', presetReceipt).maybeSingle()) as InvoiceContextReceipt | null
        : null;
      const orderId = presetOrder ?? receipt?.order_id ?? null;
      const order = orderId
        ? unwrap(await supabase.from('purchase_orders').select('id, number, supplier_id, status')
          .eq('id', orderId).maybeSingle()) as InvoiceContextOrder | null
        : null;
      const supplier = order
        ? unwrap(await supabase.from('suppliers').select('id, name').eq('id', order.supplier_id)
          .is('deleted_at', null).maybeSingle()) as InvoiceContextSupplier | null
        : null;
      return resolveInvoiceLinkedContext(presetOrder, presetReceipt, order, receipt, supplier);
    } catch {
      // Missing, inaccessible and malformed identifiers deliberately share one outcome. The UI
      // must not reveal whether a record exists outside the current tenant.
      return { status: 'invalid' as const };
    }
  }, [presetOrder, presetReceipt, linksRequested]);

  const linkedContext = linkResolution?.status === 'linked' ? linkResolution : null;
  const effectiveSupplierId = linkedContext?.supplier.id ?? f.supplier_id;
  const linkedOrderId = linkedContext?.orderId ?? null;
  const linkedReceiptId = linkedContext?.receiptId ?? null;
  const canOpenProcurement = profile?.role === 'owner' || profile?.role === 'office';

  const vatRate = (org?.vat_rate ?? 18) / 100;
  const set = (k: string, v: string) => {
    setDirty(true);
    setF((s) => ({ ...s, [k]: v }));
  };

  // A supplier the list does not have used to mean abandoning a half-filled invoice for /suppliers.
  const supplierPicker = useQuickSupplier(suppliers, (supplierId) => set('supplier_id', supplierId));

  // auto-complete VAT math from whichever field the user fills
  function onBeforeVat(v: string) {
    const n = Number(v);
    setDirty(true);
    setF((s) => ({ ...s, before_vat: v, vat: n ? (n * vatRate).toFixed(2) : s.vat, total: n ? (n * (1 + vatRate)).toFixed(2) : s.total }));
  }
  function onTotal(v: string) {
    const n = Number(v);
    setDirty(true);
    setF((s) => ({ ...s, total: v, before_vat: n ? (n / (1 + vatRate)).toFixed(2) : s.before_vat, vat: n ? (n - n / (1 + vatRate)).toFixed(2) : s.vat }));
  }

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const protectLink = (event: MouseEvent) => {
      if (!dirty || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      event.preventDefault();
      event.stopPropagation();
      setLeaveTarget(`${url.pathname}${url.search}${url.hash}`);
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', protectLink, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', protectLink, true);
    };
  }, [dirty]);

  const linkedOrderIds = linkedOrderId ? [linkedOrderId] : [];
  const checkFingerprint = effectiveSupplierId && f.invoice_number.trim() && Number(f.total) > 0
    ? invoiceCheckFingerprint({
      supplierId: effectiveSupplierId, invoiceNumber: f.invoice_number, invoiceDate: f.invoice_date,
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
        supplier_id: effectiveSupplierId, invoice_number: f.invoice_number.trim(), invoice_date: f.invoice_date,
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
    if (!effectiveSupplierId || !f.invoice_number.trim() || !Number(f.total)) {
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
          supplier_id: effectiveSupplierId, invoice_number: f.invoice_number.trim(), invoice_date: f.invoice_date,
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
      const inv = unwrap(await supabase.rpc('create_invoice', {
        p_invoice_id: invoiceId,
        p_supplier_id: effectiveSupplierId,
        p_invoice_number: f.invoice_number.trim(),
        p_invoice_date: f.invoice_date,
        p_amount_before_vat: Number(f.before_vat) || 0,
        p_vat_amount: Number(f.vat) || 0,
        p_total_amount: Number(f.total),
        p_notes: f.notes.trim() || null,
        p_order_id: linkedOrderId,
        p_receipt_id: linkedReceiptId,
        p_override_reason: overrideReason?.trim() || null,
        p_reason: reasonOr(f.reason, 'קליטת חשבונית שהתקבלה'),
      })) as { invoice_id: string; review_status: string; duplicate_detected: boolean };

      toast(inv.review_status === 'investigation'
        ? 'החשבונית נשמרה כדורשת בירור ונפתח חריג לבדיקה'
        : 'החשבונית נשמרה');
      setDirty(false);
      navigate(`/invoices/${inv.invoice_id}`);
    } catch (e) {
      toast(toHebrewError(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (loading || linksLoading) return <RecordSkeleton />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="max-w-2xl space-y-4">
      <PageHeader title="חשבונית חדשה" breadcrumbs={<Breadcrumbs items={[{ label: 'חשבוניות', to: '/invoices' }, { label: 'חשבונית חדשה' }]} />} />
      {linkedContext && (
        <section className="note-info space-y-3" aria-labelledby="invoice-linked-context-title" data-testid="invoice-linked-context">
          <div>
            <h2 id="invoice-linked-context-title" className="font-semibold text-ink">רשומות שיקושרו לחשבונית</h2>
            <p className="mt-1 text-sm">
              החשבונית החדשה תקושר {linkedContext.orderId && linkedContext.receiptId
                ? 'להזמנת הרכש ולקבלת הסחורה הבאות'
                : linkedContext.orderId ? 'להזמנת הרכש הבאה' : 'לקבלת הסחורה הבאה'} לאחר השמירה.
            </p>
          </div>
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-ink-muted">ספק</dt>
              <dd className="mt-0.5 font-medium" data-testid="invoice-linked-supplier">{linkedContext.supplier.name}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">{linkedContext.orderId ? 'הזמנת רכש' : 'הזמנת המקור של הקבלה'}</dt>
              <dd className="mt-0.5 flex flex-wrap items-center gap-2">
                {canOpenProcurement
                  ? <Link className="link num" to={`/orders/${linkedContext.order.id}`} data-testid="invoice-linked-order">הזמנה #{linkedContext.order.number}</Link>
                  : <span className="num" data-testid="invoice-linked-order">הזמנה #{linkedContext.order.number}</span>}
                <StatusBadge meta={PO_STATUS[linkedContext.order.status]} />
              </dd>
            </div>
            {linkedContext.receipt && (
              <div>
                <dt className="text-ink-muted">קבלת סחורה</dt>
                <dd className="mt-0.5 flex flex-wrap items-center gap-2 font-medium">
                  {canOpenProcurement
                    ? <Link
                        className="link num"
                        to={`/receipts/${linkedContext.receipt.id}`}
                        data-testid="invoice-linked-receipt"
                        aria-label={`צפייה בקבלה #${linkedContext.receipt.number}`}
                      >קבלה #{linkedContext.receipt.number}</Link>
                    : <span className="num" data-testid="invoice-linked-receipt">קבלה #{linkedContext.receipt.number}</span>}
                </dd>
              </div>
            )}
            {linkedContext.receipt && (
              <div>
                <dt className="text-ink-muted">תאריך קבלה</dt>
                <dd className="mt-0.5 num">{fmtDate(linkedContext.receipt.received_at)}</dd>
              </div>
            )}
          </dl>
        </section>
      )}
      {linksRequested && linkResolution?.status === 'invalid' && (
        <div data-testid="invoice-linked-context-unavailable">
          <Note tone="await" role="status">
            לא ניתן לטעון את רשומות המקור. אפשר להמשיך ולשמור את החשבונית ללא קישור.
          </Note>
        </div>
      )}

      <div className="card card-pad grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2">
          {/* `disabled` when the invoice is linked covers the create button too: a supplier the
              linked order already decided is not one the user may add to here. */}
          <SupplierSelectField picker={supplierPicker} id="invoice-new-supplier" label="ספק *"
            placeholder="בחר ספק..." value={effectiveSupplierId} disabled={!!linkedContext}
            describedBy={linkedContext ? 'invoice-linked-supplier-help' : undefined} />
          {linkedContext && <div id="invoice-linked-supplier-help" className="mt-1 text-xs text-ink-muted">הספק נקבע לפי הרשומות המקושרות ואינו ניתן לשינוי כאן.</div>}
        </div>
        <div><label className="label" htmlFor="invoice-new-number">מספר חשבונית *</label><input id="invoice-new-number" className="input num" dir="ltr" value={f.invoice_number} onChange={(e) => set('invoice_number', e.target.value)} /></div>
        <div><label className="label" htmlFor="invoice-new-date">תאריך חשבונית *</label><input id="invoice-new-date" type="date" className="input" value={f.invoice_date} onChange={(e) => set('invoice_date', e.target.value)} /></div>
        <div><label className="label" htmlFor="invoice-new-before-vat">סכום לפני מע״מ</label><input id="invoice-new-before-vat" type="number" step="0.01" className="input num" value={f.before_vat} onChange={(e) => onBeforeVat(e.target.value)} /></div>
        <div><label className="label" htmlFor="invoice-new-vat">מע״מ ({org?.vat_rate ?? 18}%)</label><input id="invoice-new-vat" type="number" step="0.01" className="input num" value={f.vat} onChange={(e) => set('vat', e.target.value)} /></div>
        <div><label className="label" htmlFor="invoice-new-total">סה״כ לתשלום *</label><input id="invoice-new-total" type="number" step="0.01" className="input num font-semibold" value={f.total} onChange={(e) => onTotal(e.target.value)} /></div>
        <div className="sm:col-span-2"><label className="label" htmlFor="invoice-new-notes">הערות</label><textarea id="invoice-new-notes" className="input" rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></div>
        <div className="sm:col-span-2"><label className="label" htmlFor="invoice-new-reason">סיבת קליטת החשבונית *</label><input id="invoice-new-reason" className="input" value={f.reason} onChange={(e) => set('reason', e.target.value)} /></div>
      </div>

      {(checks || checking || checkError) && (
        <div className="card card-pad">
          <div className="section-title mb-3 flex items-center gap-2">
            בדיקות אוטומטיות
            {checking && <span role="status" className="flex items-center gap-1 text-sm text-ink-muted"><Loader2 size={14} className="animate-spin text-ink-faint" aria-hidden="true" /> בודק…</span>}
          </div>
          {checkError && <Note tone="alert">{checkError}</Note>}
          {checks && <CheckList checks={checks} />}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button className="btn-secondary" onClick={() => dirty ? setLeaveTarget('/invoices') : navigate('/invoices')}>ביטול</button>
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
      <ConfirmDialog open={leaveTarget !== null} onClose={() => setLeaveTarget(null)}
        onConfirm={() => {
          const target = leaveTarget;
          setLeaveTarget(null);
          setDirty(false);
          if (target) navigate(target);
        }}
        title="יציאה מחשבונית חדשה"
        message="הנתונים שהוזנו בחשבונית עדיין לא נשמרו. יציאה מהמסך תמחק אותם."
        confirmLabel="יציאה ללא שמירה" danger busy={busy} />
    </div>
  );
}
