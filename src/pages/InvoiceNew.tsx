import { useT } from '../lib/i18n/LocaleProvider';
import { useEffect, useRef, useState } from 'react';
import { reasonOr } from '../lib/reason';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Loader2, ShieldAlert } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { Breadcrumbs, PageHeader, RecordSkeleton, useToast, ConfirmDialog, ErrorNote, Note, StatusBadge, Card, ICON } from '../components/ui';
import { CheckList } from './Invoices';
import { runInvoiceChecks, type CheckResult } from '../lib/checks';
import { fmtDate, todayISO } from '../lib/format';
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
  const { errorText, t } = useT();
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
        toast(t('invoiceNew.toast'), 'error');
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
        // The audit reason, and it stays Hebrew on purpose: it is written to `p_reason` in
        // `audit_logs`, which is a protected class. A log whose wording follows whoever happened
        // to be reading the screen is a log nobody can search.
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
    // `debounce`, not `t`: this file is about to hold the translation function under that name,
    // and a shadowed `t` inside one effect is the kind of thing that compiles and then renders
    // a timer handle. `PriceLists.tsx` hit exactly this.
    const debounce = setTimeout(() => {
      void runInvoiceChecks({
        supplier_id: effectiveSupplierId, invoice_number: f.invoice_number.trim(), invoice_date: f.invoice_date,
        total_amount: Number(f.total), linkedOrderIds,
      }).then((results) => {
        if (checkSequence.current === sequence && latestFingerprint.current === checkFingerprint) {
          setChecked({ fingerprint: checkFingerprint, results });
        }
      }).catch(() => {
        if (checkSequence.current === sequence) setCheckError(t('invoiceNew.setCheckError'));
      }).finally(() => {
        if (checkSequence.current === sequence) setChecking(false);
      });
    }, 500);
    return () => {
      clearTimeout(debounce);
      if (checkSequence.current === sequence) checkSequence.current += 1;
    };
  }, [checkFingerprint]);

  const checks = checked?.fingerprint === checkFingerprint ? checked.results : null;
  const hasCritical = checks?.some((c) => c.severity === 'critical') ?? false;
  const checksReady = checkFingerprint != null && checks != null && !checking && !checkError;

  async function save(overrideReason?: string) {
    if (!effectiveSupplierId || !f.invoice_number.trim() || !Number(f.total)) {
      toast(t('invoiceNew.toast_2'), 'error');
      return;
    }
    if (!checkFingerprint || !checksReady) {
      toast(checkError ?? t('invoiceNew.toast_3'), 'error');
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
        setCheckError(t('invoiceNew.setCheckError_2'));
        throw checkFailure;
      }
      if (latestFingerprint.current !== checkFingerprint) throw new Error(t('invoiceNew.Error'));
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
        p_reason: reasonOr(f.reason, t('invoiceNew.reasonOr')),
      })) as { invoice_id: string; review_status: string; duplicate_detected: boolean };

      toast(inv.review_status === 'investigation'
        ? t('invoiceNew.text')
        : t('invoiceNew.text_2'));
      setDirty(false);
      navigate(`/invoices/${inv.invoice_id}`);
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (loading || linksLoading) return <RecordSkeleton />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="max-w-2xl space-y-4">
      <PageHeader title={t('invoiceNew.title')} breadcrumbs={<Breadcrumbs items={[{ label: t('invoiceNew.text_3'), to: '/invoices' }, { label: t('invoiceNew.text_4') }]} />} />
      {linkedContext && (
        <section className="note-info space-y-3" aria-labelledby="invoice-linked-context-title" data-testid="invoice-linked-context">
          <div>
            <h2 id="invoice-linked-context-title" className="font-semibold text-ink">{t('invoiceNew.text_5')}</h2>
            <p className="mt-1 text-sm">
              {t('invoiceNew.willBeLinkedLead')}{' '}{linkedContext.orderId && linkedContext.receiptId
                ? t('invoiceNew.text_6')
                : linkedContext.orderId ? t('invoiceNew.text_7') : t('invoiceNew.text_8')}{' '}{t('invoiceNew.willBeLinkedTail')}
            </p>
          </div>
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-ink-muted">{t('invoiceNew.text_9')}</dt>
              <dd className="mt-0.5 font-medium" data-testid="invoice-linked-supplier">{linkedContext.supplier.name}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">{linkedContext.orderId ? t('invoiceNew.text_10') : t('invoiceNew.text_11')}</dt>
              <dd className="mt-0.5 flex flex-wrap items-center gap-2">
                {canOpenProcurement
                  ? <Link className="link" to={`/orders/${linkedContext.order.id}`} data-testid="invoice-linked-order">{t('invoiceNew.orderWord')} <span className="num">#{linkedContext.order.number}</span></Link>
                  : <span data-testid="invoice-linked-order">{t('invoiceNew.text_12')} <span className="num">#{linkedContext.order.number}</span></span>}
                <StatusBadge meta={PO_STATUS[linkedContext.order.status]} />
              </dd>
            </div>
            {linkedContext.receipt && (
              <div>
                <dt className="text-ink-muted">{t('invoiceNew.text_13')}</dt>
                <dd className="mt-0.5 flex flex-wrap items-center gap-2 font-medium">
                  {canOpenProcurement
                    ? <Link
                        className="link num"
                        to={`/receipts/${linkedContext.receipt.id}`}
                        data-testid="invoice-linked-receipt"
                        aria-label={t('invoiceNew.viewReceiptLabel', { number: linkedContext.receipt.number })}
                      >{t('invoiceNew.receiptWord')} #{linkedContext.receipt.number}</Link>
                    : <span data-testid="invoice-linked-receipt">{t('invoiceNew.text_14')} <span className="num">#{linkedContext.receipt.number}</span></span>}
                </dd>
              </div>
            )}
            {linkedContext.receipt && (
              <div>
                <dt className="text-ink-muted">{t('invoiceNew.text_15')}</dt>
                <dd className="mt-0.5 num">{fmtDate(linkedContext.receipt.received_at)}</dd>
              </div>
            )}
          </dl>
        </section>
      )}
      {linksRequested && linkResolution?.status === 'invalid' && (
        <div data-testid="invoice-linked-context-unavailable">
          <Note tone="await" role="status">
            {t('invoiceNew.text_16')}
          </Note>
        </div>
      )}

      <Card className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2">
          {/* `disabled` when the invoice is linked covers the create button too: a supplier the
              linked order already decided is not one the user may add to here. */}
          <SupplierSelectField picker={supplierPicker} id="invoice-new-supplier" label={t('invoiceNew.label')}
            placeholder={t('invoiceNew.placeholder')} value={effectiveSupplierId} disabled={!!linkedContext}
            describedBy={linkedContext ? 'invoice-linked-supplier-help' : undefined} />
          {linkedContext && <div id="invoice-linked-supplier-help" className="mt-1 text-xs text-ink-muted">{t('invoiceNew.text_17')}</div>}
        </div>
        <div><label className="label" htmlFor="invoice-new-number">{t('invoiceNew.set')}</label><input id="invoice-new-number" className="input num" dir="ltr" value={f.invoice_number} onChange={(e) => set('invoice_number', e.target.value)} /></div>
        <div><label className="label" htmlFor="invoice-new-date">{t('invoiceNew.set_2')}</label><input id="invoice-new-date" type="date" className="input" value={f.invoice_date} onChange={(e) => set('invoice_date', e.target.value)} /></div>
        <div><label className="label" htmlFor="invoice-new-before-vat">{t('invoiceNew.onBeforeVat')}</label><input id="invoice-new-before-vat" type="number" step="0.01" className="input num" value={f.before_vat} onChange={(e) => onBeforeVat(e.target.value)} /></div>
        <div><label className="label" htmlFor="invoice-new-vat">{t('invoiceNew.vatLabel', { rate: org?.vat_rate ?? 18 })}</label><input id="invoice-new-vat" type="number" step="0.01" className="input num" value={f.vat} onChange={(e) => set('vat', e.target.value)} /></div>
        <div><label className="label" htmlFor="invoice-new-total">{t('invoiceNew.onTotal')}</label><input id="invoice-new-total" type="number" step="0.01" className="input num font-semibold" value={f.total} onChange={(e) => onTotal(e.target.value)} /></div>
        <div className="sm:col-span-2"><label className="label" htmlFor="invoice-new-notes">{t('invoiceNew.set_3')}</label><textarea id="invoice-new-notes" className="input" rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></div>
        <div className="sm:col-span-2"><label className="label" htmlFor="invoice-new-reason">{t('invoiceNew.set_4')}</label><input id="invoice-new-reason" className="input" value={f.reason} onChange={(e) => set('reason', e.target.value)} /></div>
      </Card>

      {(checks || checking || checkError) && (
        <Card>
          <div className="section-title mb-3 flex items-center gap-2">
            {t('invoiceNew.text_18')}
            {checking && <span role="status" className="flex items-center gap-1 text-sm text-ink-muted"><Loader2 size={ICON.sm} className="animate-spin text-ink-faint" aria-hidden="true" /> {t('invoiceNew.text_19')}</span>}
          </div>
          {checkError && <Note tone="alert">{checkError}</Note>}
          {checks && <CheckList checks={checks} />}
        </Card>
      )}

      <div className="flex justify-end gap-2">
        <button className="btn-secondary" onClick={() => dirty ? setLeaveTarget('/invoices') : navigate('/invoices')}>{t('invoiceNew.setLeaveTarget')}</button>
        {hasCritical ? (
          <>
            <button className="btn-secondary" disabled={busy || !checksReady} onClick={() => void save()}>
              {busy && <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" />} {t('invoiceNew.saveAsNeedsReview')}
            </button>
            <button className="btn-danger" disabled={busy || !checksReady} onClick={() => setOverrideOpen(true)}>
              <ShieldAlert size={ICON.sm} aria-hidden="true" /> {t('invoiceNew.approveDespiteWarning')}
            </button>
          </>
        ) : (
          <button className="btn-primary" disabled={busy || !checksReady} onClick={() => void save()}>
            {busy && <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" />} {t('invoiceNew.saveInvoice')}
          </button>
        )}
      </div>

      <ConfirmDialog open={overrideOpen} onClose={() => setOverrideOpen(false)}
        onConfirm={(reason) => { setOverrideOpen(false); void save(reason); }}
        title={t('invoiceNew.title_2')}
        message={t('invoiceNew.message')}
        confirmLabel={t('invoiceNew.confirmLabel')} danger requireReason busy={busy} />
      <ConfirmDialog open={leaveTarget !== null} onClose={() => setLeaveTarget(null)}
        onConfirm={() => {
          const target = leaveTarget;
          setLeaveTarget(null);
          setDirty(false);
          if (target) navigate(target);
        }}
        title={t('invoiceNew.title_3')}
        message={t('invoiceNew.message_2')}
        confirmLabel={t('invoiceNew.confirmLabel_2')} danger busy={busy} />
    </div>
  );
}
