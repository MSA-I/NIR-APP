import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Plus } from 'lucide-react';
import { Link } from 'react-router';
import type { Role } from '../../lib/types';
import { toHebrewError } from '../../lib/errors';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../auth/AuthContext';
import { Note } from '../ui';
import type { ReviewSnapshot } from './model';

interface PriceListReviewConfirmationProps {
  snapshot: ReviewSnapshot;
  role: Role;
  actorId: string;
  onRefetch: () => Promise<boolean>;
}

interface ProductOption {
  id: string;
  name: string;
  unit: string;
  sku: string | null;
}

interface LineDraft {
  approved: boolean;
  productId: string;
  priceText: string;
  available: boolean;
}

interface ConfirmPayload {
  readonly mode: 'confirm';
  readonly documentId: string;
  readonly interpretationId: string;
  readonly targetMonth: string;
  readonly approvedRows: ReadonlyArray<{
    readonly lineItemIndex: number;
    readonly productId: string;
    readonly priceText: string;
    readonly available: boolean;
  }>;
  readonly reason: string;
}

interface SubmissionReceipt {
  submission_id: string;
  revision: number;
  accepted_count: number;
  rejected_count: number;
  unchanged_count: number;
  idempotent: boolean;
}

interface SupplierPortalContext {
  prices: Array<{
    product_id: string;
    product_name: string;
    unit: string;
  }>;
}

function valueText(value: string | number | null): string {
  return value === null ? 'לא זוהה' : String(value);
}

/** Best-effort name prefill for a new product, taken from the line's own extracted values. */
function guessLineName(values: Record<string, string | number | null>): string {
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string' && value.trim() && /שם|מוצר|פריט|תיאור|name|product|item|desc/i.test(key)) {
      return value.trim().slice(0, 120);
    }
  }
  return '';
}

function emptyDrafts(count: number): LineDraft[] {
  return Array.from({ length: count }, () => ({
    approved: false,
    productId: '',
    priceText: '',
    available: true,
  }));
}

function parseReceipt(value: unknown): SubmissionReceipt {
  if (!value || typeof value !== 'object') throw new Error('השרת לא החזיר קבלת הגשה תקינה.');
  const row = value as Record<string, unknown>;
  if (typeof row.submission_id !== 'string'
      || typeof row.revision !== 'number'
      || typeof row.accepted_count !== 'number'
      || typeof row.rejected_count !== 'number'
      || typeof row.unchanged_count !== 'number'
      || typeof row.idempotent !== 'boolean') {
    throw new Error('השרת לא החזיר קבלת הגשה תקינה.');
  }
  return row as unknown as SubmissionReceipt;
}

async function recoverStoredReceipt(interpretationId: string): Promise<SubmissionReceipt | null> {
  const result = await supabase.from('supplier_price_submissions')
    .select('id,revision,accepted_count,rejected_count,unchanged_count')
    .eq('id', interpretationId)
    .eq('source_interpretation_id', interpretationId)
    .maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) return null;
  return parseReceipt({
    submission_id: result.data.id,
    revision: result.data.revision,
    accepted_count: result.data.accepted_count,
    rejected_count: result.data.rejected_count,
    unchanged_count: result.data.unchanged_count,
    idempotent: true,
  });
}

function hasHttpResponse(error: unknown): boolean {
  const context = (error as { context?: Response } | null)?.context;
  return Boolean(context && typeof context.json === 'function' && typeof context.status === 'number');
}

async function edgeErrorMessage(error: unknown) {
  const context = (error as { context?: Response } | null)?.context;
  if (context && typeof context.json === 'function') {
    try {
      const body = await context.json() as { error?: { message?: string; detail?: string } };
      if (body.error?.message) {
        return body.error.detail ? `${body.error.message} (${body.error.detail})` : body.error.message;
      }
    } catch { /* use the transport mapping below */ }
    if (context.status === 401) return 'פג תוקף החיבור. יש להתחבר מחדש לפני אישור המחירון.';
    if (context.status === 403) return 'אין לך הרשאה לאשר את המחירון הזה.';
    if (context.status === 409) return 'מצב המסמך השתנה. רענן את המסך ובדוק שוב.';
    if (context.status === 404 || context.status >= 500) return 'שירות קליטת המחירונים אינו זמין כרגע.';
  }
  return toHebrewError(error);
}

export function PriceListReviewConfirmation({
  snapshot,
  role,
  actorId,
  onRefetch,
}: PriceListReviewConfirmationProps) {
  const interpretation = snapshot.interpretation;
  const lineItems = interpretation?.payload.line_items ?? [];
  const ownsDocument = Boolean(
    snapshot.document
    && snapshot.document.uploaded_by === actorId
    && (role === 'owner' || role === 'office' || role === 'supplier'),
  );
  const { profile } = useAuth();
  // Product creation is a staff act (products RLS); the supplier role matches existing items only.
  const staffCanCreate = role === 'owner' || role === 'office';
  const [drafts, setDrafts] = useState(() => emptyDrafts(lineItems.length));
  const [newProductFor, setNewProductFor] = useState<number | null>(null);
  const [newProductName, setNewProductName] = useState('');
  const [newProductUnit, setNewProductUnit] = useState('יח׳');
  const [busyCreate, setBusyCreate] = useState(false);
  // Rendered inside the per-line form — the shared error Note sits below all the lines,
  // far off-screen on a long price list, so a failure there would look like a dead button.
  const [createError, setCreateError] = useState<string | null>(null);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [targetMonth, setTargetMonth] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshWarning, setRefreshWarning] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<SubmissionReceipt | null>(null);
  const [attemptedPayload, setAttemptedPayload] = useState<ConfirmPayload | null>(null);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoveryRevision, setRecoveryRevision] = useState(0);
  const payloadMatchesCurrent = attemptedPayload?.documentId === snapshot.documentId
    && attemptedPayload.interpretationId === interpretation?.id;
  const canStart = ownsDocument
    && snapshot.job?.status === 'review'
    && !attemptedPayload
    && !receipt;
  const canReplay = ownsDocument
    && payloadMatchesCurrent
    && !receipt
    && (snapshot.job?.status === 'review' || snapshot.job?.status === 'completed');

  useEffect(() => {
    setDrafts(emptyDrafts(lineItems.length));
    setReceipt(null);
    setAttemptedPayload(null);
    setError(null);
    setRefreshWarning(null);
    setRecoveryError(null);
    setRecoveryLoading(false);
    setTargetMonth('');
    setReason('');
  }, [interpretation?.id, lineItems.length]);

  useEffect(() => {
    let cancelled = false;
    if (!canStart || receipt) {
      setProducts([]);
      setCatalogError(null);
      setCatalogLoading(false);
      return () => { cancelled = true; };
    }

    setCatalogLoading(true);
    setCatalogError(null);
    void (async () => {
      try {
        let options: ProductOption[];
        if (role === 'supplier') {
          const result = await supabase.rpc('supplier_portal_context');
          if (result.error) throw result.error;
          const portal = result.data as unknown as SupplierPortalContext;
          if (!portal || !Array.isArray(portal.prices)) throw new Error('קטלוג הספק אינו זמין.');
          const unique = new Map<string, ProductOption>();
          for (const price of portal.prices) {
            if (!price?.product_id || !price.product_name) continue;
            unique.set(price.product_id, {
              id: price.product_id,
              name: price.product_name,
              unit: price.unit,
              sku: null,
            });
          }
          options = [...unique.values()];
        } else {
          const result = await supabase.from('products')
            .select('id,name,unit,sku')
            .eq('active', true)
            .order('name');
          if (result.error) throw result.error;
          options = (result.data ?? []) as ProductOption[];
        }
        options.sort((left, right) => left.name.localeCompare(right.name, 'he'));
        if (!cancelled) setProducts(options);
      } catch (loadError) {
        if (!cancelled) setCatalogError(toHebrewError(loadError));
      } finally {
        if (!cancelled) setCatalogLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [canStart, catalogRevision, receipt, role]);

  useEffect(() => {
    let cancelled = false;
    if (!interpretation || !ownsDocument || snapshot.job?.status !== 'completed' || receipt) {
      return () => { cancelled = true; };
    }
    setRecoveryLoading(true);
    setRecoveryError(null);
    void recoverStoredReceipt(interpretation.id).then((storedReceipt) => {
      if (cancelled) return;
      if (storedReceipt) setReceipt(storedReceipt);
      else setRecoveryError('המשימה הושלמה, אך לא נמצאה קבלה תואמת לפירוש הנוכחי. לא ניתן לבנות הגשה חדשה במצב זה.');
    }).catch((loadError) => {
      if (!cancelled) setRecoveryError(`לא ניתן לשחזר את קבלת ההגשה: ${toHebrewError(loadError)}`);
    }).finally(() => {
      if (!cancelled) setRecoveryLoading(false);
    });
    return () => { cancelled = true; };
  }, [interpretation?.id, ownsDocument, receipt, recoveryRevision, snapshot.job?.status]);

  if (!interpretation) return null;
  const currentInterpretation = interpretation;

  function updateDraft(index: number, patch: Partial<LineDraft>) {
    setDrafts((current) => current.map((draft, draftIndex) =>
      draftIndex === index ? { ...draft, ...patch } : draft));
  }

  // Explicit, per-line product creation. The product exists BEFORE the confirm payload is built,
  // so the server invariant "האישור אינו יוצר מוצרים" stays intact — creation is its own user act.
  async function createProduct(index: number) {
    const name = newProductName.trim();
    if (!name) { setCreateError('יש להזין שם למוצר החדש.'); return; }
    if (!profile) return;
    setBusyCreate(true);
    setCreateError(null);
    try {
      const inserted = await supabase.from('products')
        .insert({ org_id: profile.org_id, name, unit: newProductUnit.trim() || 'יח׳', active: true })
        .select('id,name,unit,sku')
        .single();
      if (inserted.error) throw inserted.error;
      const product = inserted.data as ProductOption;
      setProducts((current) => [...current, product].sort((left, right) => left.name.localeCompare(right.name, 'he')));
      updateDraft(index, { productId: product.id });
      setNewProductFor(null);
    } catch (insertError) {
      setCreateError(toHebrewError(insertError));
    } finally {
      setBusyCreate(false);
    }
  }

  async function finishWithReceipt(nextReceipt: SubmissionReceipt) {
    setReceipt(nextReceipt);
    setRecoveryError(null);
    if (!await onRefetch()) {
      setRefreshWarning('המחירון נקלט והקבלה התקבלה, אך רענון המסמך נכשל. יש לרענן ידנית.');
    }
  }

  async function recoverAfterSubmission(interpretationId: string): Promise<'found' | 'missing' | 'failed'> {
    try {
      const storedReceipt = await recoverStoredReceipt(interpretationId);
      if (!storedReceipt) return 'missing';
      await finishWithReceipt(storedReceipt);
      return 'found';
    } catch {
      return 'failed';
    }
  }

  async function submitPayload(payload: ConfirmPayload) {
    setBusy(true);
    setError(null);
    setRefreshWarning(null);
    try {
      const response = await supabase.functions.invoke<SubmissionReceipt>('submit-price-list', { body: payload });
      if (response.error) {
        const responseReceived = hasHttpResponse(response.error);
        const message = await edgeErrorMessage(response.error);
        const recovery = await recoverAfterSubmission(payload.interpretationId);
        if (recovery === 'found') return;
        if (responseReceived && recovery === 'missing' && snapshot.job?.status === 'review') {
          setAttemptedPayload(null);
        }
        setError(recovery === 'failed'
          ? `${message} לא ניתן היה לוודא אם נשמרה קבלה; ניסיון נוסף ישתמש בדיוק באותו אישור.`
          : message);
        return;
      }

      try {
        await finishWithReceipt(parseReceipt(response.data));
      } catch (receiptError) {
        const recovery = await recoverAfterSubmission(payload.interpretationId);
        if (recovery !== 'found') {
          setError(recovery === 'failed'
            ? 'השרת השיב, אך לא ניתן לקרוא או לשחזר את הקבלה. ניסיון נוסף ישתמש בדיוק באותו אישור.'
            : receiptError instanceof Error ? receiptError.message : toHebrewError(receiptError));
        }
      }
    } catch (submitError) {
      const recovery = await recoverAfterSubmission(payload.interpretationId);
      if (recovery !== 'found') {
        const message = submitError instanceof Error ? submitError.message : toHebrewError(submitError);
        setError(recovery === 'failed'
          ? `${message} לא ניתן היה לוודא אם נשמרה קבלה; ניסיון נוסף ישתמש בדיוק באותו אישור.`
          : message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function confirmPriceList() {
    if (!canStart) return;
    const approvedRows = drafts.flatMap((draft, lineItemIndex) => draft.approved ? [{
      lineItemIndex,
      productId: draft.productId,
      priceText: draft.priceText.trim(),
      available: draft.available,
    }] : []);
    const allowedProductIds = new Set(products.map(({ id }) => id));

    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(targetMonth)) {
      setError('יש לבחור חודש יעד.');
      return;
    }
    if (!reason.trim()) {
      setError('יש להזין סיבה לאישור המחירון.');
      return;
    }
    if (!approvedRows.length) {
      setError('יש לאשר לפחות שורה אחת.');
      return;
    }
    if (approvedRows.some((row) => !allowedProductIds.has(row.productId) || !row.priceText)) {
      setError('בכל שורה מאושרת יש לבחור מוצר קיים ולהקליד מחיר.');
      return;
    }

    const payload: ConfirmPayload = {
      mode: 'confirm',
      documentId: snapshot.documentId,
      interpretationId: currentInterpretation.id,
      targetMonth: `${targetMonth}-01`,
      approvedRows,
      reason: reason.trim(),
    };
    setAttemptedPayload(payload);
    await submitPayload(payload);
  }

  const showControls = canStart;
  const returnPath = role === 'supplier' ? '/my-prices' : '/prices';

  return (
    <section className="card card-pad min-w-0" aria-labelledby="price-list-review-title" data-testid="price-list-review-confirmation">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="price-list-review-title" className="section-title">אישור מחירון מפירוש המסמך</h2>
          <p className="mt-1 text-sm text-ink-muted">כל שורה דורשת בחירה מפורשת במוצר ובמחיר. האישור עצמו לעולם אינו יוצר מוצרים — מוצר חדש נוצר רק בפעולה מפורשת שלך משורת המסמך.</p>
        </div>
        <span className={receipt ? 'badge-done' : 'badge-await'}>{receipt ? 'נקלט' : 'ממתין לאישור'}</span>
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg bg-surface-sunken p-3">
          <dt className="text-sm font-medium text-ink-soft">הספק שהוצע בפירוש</dt>
          <dd className="mt-1 break-words text-ink-body">{currentInterpretation.payload.supplier.suggested_name || 'לא זוהה'}</dd>
        </div>
        <div className="rounded-lg bg-surface-sunken p-3">
          <dt className="text-sm font-medium text-ink-soft">מספר שורות שזוהו</dt>
          <dd className="num mt-1 text-ink-body">{lineItems.length}</dd>
        </div>
      </dl>

      {recoveryLoading && !receipt && (
        <Note tone="info" role="status" className="mt-4">
          <Loader2 className="animate-spin motion-reduce:animate-none" size={17} aria-hidden="true" /> בודק אם כבר נשמרה קבלת הגשה לפירוש הזה.
        </Note>
      )}
      {recoveryError && !receipt && (
        <Note tone="alert" role="alert" className="mt-4 flex-wrap">
          <span className="min-w-0 flex-1">{recoveryError}</span>
          <button type="button" className="btn-secondary" disabled={recoveryLoading} onClick={() => setRecoveryRevision((value) => value + 1)}>בדיקה חוזרת של הקבלה</button>
        </Note>
      )}
      {!ownsDocument && !receipt && (
        <Note tone="idle" className="mt-4">האישור זמין רק למעלה המסמך בתפקיד בעלים, משרד או ספק.</Note>
      )}
      {ownsDocument && !receipt && !attemptedPayload && !recoveryLoading && !recoveryError
        && snapshot.job?.status !== 'review' && snapshot.job?.status !== 'completed' && (
        <Note tone="idle" className="mt-4">אפשר להתחיל אישור רק כאשר המשימה במצב „דורש בדיקה”.</Note>
      )}
      {attemptedPayload && !receipt && (
        <Note tone="await" className="mt-4 flex-wrap">
          <span className="min-w-0 flex-1">
            האישור ננעל לאחר הניסיון הראשון: <span className="num">{attemptedPayload.approvedRows.length}</span> שורות לחודש <span className="num">{attemptedPayload.targetMonth.slice(0, 7)}</span>. ניסיון חוזר אינו מאפשר שינוי מוצר, מחיר, זמינות, חודש או סיבה.
          </span>
          {canReplay && (
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => void submitPayload(attemptedPayload)}>
              {busy && <Loader2 className="animate-spin motion-reduce:animate-none" size={17} aria-hidden="true" />}
              שחזור קבלה באותו אישור
            </button>
          )}
        </Note>
      )}
      {catalogError && showControls && (
        <Note tone="alert" role="alert" className="mt-4 flex-wrap">
          <span className="min-w-0 flex-1">לא ניתן לטעון את קטלוג המוצרים: {catalogError}</span>
          <button type="button" className="btn-secondary" onClick={() => setCatalogRevision((value) => value + 1)}>ניסיון נוסף</button>
        </Note>
      )}
      {showControls && !catalogLoading && !catalogError && products.length === 0 && (
        <Note tone="alert" className="mt-4">אין מוצרים קיימים זמינים להתאמה, ולכן לא ניתן לאשר שורות.</Note>
      )}

      <div className="mt-4 space-y-3">
        {lineItems.length === 0 && <p className="text-sm text-ink-muted">לא זוהו שורות מחיר לאישור.</p>}
        {lineItems.map((item, index) => {
          const draft = drafts[index] ?? emptyDrafts(1)[0];
          return (
            <article key={`${item.source_row ?? 'none'}-${index}`} className="rounded-lg border border-line bg-surface p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold text-ink-body">שורה <span className="num">{index + 1}</span></h3>
                <span className="text-xs text-ink-muted">שורת מקור <span className="num">{item.source_row ?? '—'}</span></span>
              </div>
              <dl className="mt-3 grid gap-2 sm:grid-cols-2">
                {Object.entries(item.values).map(([key, value]) => (
                  <div key={key} className="min-w-0 rounded-lg bg-surface-sunken p-2">
                    <dt className="text-xs font-medium text-ink-muted">{key}</dt>
                    <dd className="mt-1 break-words text-sm text-ink-body">{valueText(value)}</dd>
                  </div>
                ))}
              </dl>

              {showControls && (
                <div className="mt-3 border-t border-line pt-3">
                  <label className="flex min-h-11 items-center gap-3 font-medium text-ink-body">
                    <input type="checkbox" className="size-5" checked={draft.approved} onChange={(event) => updateDraft(index, { approved: event.target.checked })} disabled={busy} />
                    אני מאשר שורה זו לקליטה
                  </label>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label>
                      <span className="label">מוצר קיים *</span>
                      <select className="input" value={draft.productId} onChange={(event) => updateDraft(index, { productId: event.target.value })} disabled={!draft.approved || busy || catalogLoading || !!catalogError}>
                        <option value="">בחירת מוצר</option>
                        {products.map((product) => (
                          <option key={product.id} value={product.id}>{product.name} · {product.unit}{product.sku ? ` · ${product.sku}` : ''}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span className="label">מחיר ידני *</span>
                      <input className="input num" inputMode="decimal" maxLength={64} value={draft.priceText} onChange={(event) => updateDraft(index, { priceText: event.target.value })} disabled={!draft.approved || busy} />
                    </label>
                  </div>
                  {staffCanCreate && draft.approved && (
                    newProductFor === index ? (
                      <div className="mt-3 rounded-lg border border-line bg-surface-sunken p-3">
                        <div className="grid gap-3 sm:grid-cols-2">
                          <label>
                            <span className="label">שם המוצר החדש *</span>
                            <input className="input" maxLength={120} value={newProductName} onChange={(event) => setNewProductName(event.target.value)} disabled={busyCreate} />
                          </label>
                          <label>
                            <span className="label">יחידת מידה</span>
                            <input className="input" maxLength={30} value={newProductUnit} onChange={(event) => setNewProductUnit(event.target.value)} disabled={busyCreate} />
                          </label>
                        </div>
                        {createError && <Note tone="alert" role="alert" className="mt-3">{createError}</Note>}
                        <div className="mt-3 flex justify-end gap-2">
                          <button type="button" className="btn-secondary" disabled={busyCreate} onClick={() => { setNewProductFor(null); setCreateError(null); }}>ביטול</button>
                          <button type="button" className="btn-primary" disabled={busyCreate} onClick={() => void createProduct(index)}>
                            {busyCreate && <Loader2 className="animate-spin motion-reduce:animate-none" size={15} aria-hidden="true" />}
                            יצירת המוצר והתאמת השורה
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button type="button" className="btn-ghost mt-2 text-sm text-action" disabled={busy || busyCreate}
                        onClick={() => { setNewProductFor(index); setNewProductName(guessLineName(item.values)); setNewProductUnit('יח׳'); setCreateError(null); }}>
                        <Plus size={14} aria-hidden="true" /> המוצר לא קיים בקטלוג? יצירת מוצר חדש מהשורה
                      </button>
                    )
                  )}
                  <label className="mt-3 flex min-h-11 items-center gap-3 text-sm text-ink-body">
                    <input type="checkbox" className="size-5" checked={draft.available} onChange={(event) => updateDraft(index, { available: event.target.checked })} disabled={!draft.approved || busy} />
                    המוצר זמין אצל הספק
                  </label>
                </div>
              )}
            </article>
          );
        })}
      </div>

      {showControls && lineItems.length > 0 && (
        <div className="mt-4 border-t border-line pt-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label>
              <span className="label">חודש יעד *</span>
              <input type="month" className="input num" value={targetMonth} onChange={(event) => setTargetMonth(event.target.value)} disabled={busy} />
            </label>
            <label>
              <span className="label">סיבת האישור *</span>
              <textarea className="input" rows={2} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} disabled={busy} />
            </label>
          </div>
          {error && <Note tone="alert" role="alert" className="mt-3">{error}</Note>}
          <div className="mt-3 flex justify-end">
            <button type="button" className="btn-primary" disabled={busy || catalogLoading || !!catalogError || products.length === 0} onClick={() => void confirmPriceList()}>
              {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" size={17} aria-hidden="true" /> : <CheckCircle2 size={17} aria-hidden="true" />}
              {busy ? 'קולט את המחירון…' : 'אישור וקליטת השורות שנבחרו'}
            </button>
          </div>
        </div>
      )}

      {error && !showControls && <Note tone="alert" role="alert" className="mt-4">{error}</Note>}
      {refreshWarning && <Note tone="alert" role="alert" className="mt-4">{refreshWarning}</Note>}
      {receipt && (
        <div className="mt-4 rounded-lg border border-done-line bg-done-wash p-4" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold text-ink-body">קבלת קליטת מחירון</h3>
            <span className={receipt.idempotent ? 'badge-info' : 'badge-done'}>{receipt.idempotent ? 'בקשה חוזרת — ללא כפילות' : 'נקלטה הגשה חדשה'}</span>
          </div>
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="inline font-medium">מזהה הגשה: </dt><dd className="inline break-all num" dir="ltr">{receipt.submission_id}</dd></div>
            <div><dt className="inline font-medium">גרסה: </dt><dd className="inline num">{receipt.revision}</dd></div>
            <div><dt className="inline font-medium">שורות שהתקבלו: </dt><dd className="inline num">{receipt.accepted_count}</dd></div>
            <div><dt className="inline font-medium">שורות שנדחו: </dt><dd className="inline num">{receipt.rejected_count}</dd></div>
            <div><dt className="inline font-medium">שורות ללא שינוי: </dt><dd className="inline num">{receipt.unchanged_count}</dd></div>
          </dl>
          <div className="mt-4">
            <Link className="btn-secondary" to={returnPath}>חזרה למסך המחירונים</Link>
          </div>
        </div>
      )}
    </section>
  );
}
