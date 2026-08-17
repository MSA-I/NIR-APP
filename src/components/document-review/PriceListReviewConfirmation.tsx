import { useEffect, useMemo, useRef, useState } from 'react';
import { reasonOr } from '../../lib/reason';
import { CheckCircle2, Loader2, Plus } from 'lucide-react';
import { Link } from 'react-router';
import { toHebrewError } from '../../lib/errors';
import { supabase } from '../../lib/supabase';
import type { PriceListPredictedLine } from '../../lib/useDocumentProcessing';
import { useAuth } from '../../auth/AuthContext';
import { ConfirmDialog, Note } from '../ui';
import { FILING_REASON_LABELS, type ReviewSnapshot } from './model';
import { formatUnit, normalizeUnitInput } from '../../lib/format';

interface PriceListReviewConfirmationProps {
  snapshot: ReviewSnapshot;
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

const MATCHED_BY_LABELS: Record<string, string> = {
  supplier_sku: 'מק״ט הספק',
  sku: 'מק״ט',
  barcode: 'ברקוד',
};

/**
 * The newest shadow prediction per line, keyed by line index.
 *
 * A reprocess writes a second shadow run over the same lines and both stay readable. Taking
 * whichever row arrived last would mix two generations of matching on one screen, so the newest
 * (created_at, then id) wins per line — the ordering `apply_eligible_price_list_interpretation`
 * itself uses when it picks the run to act on.
 */
function predictionsByLine(
  rows: readonly PriceListPredictedLine[],
): Map<number, PriceListPredictedLine> {
  const byLine = new Map<number, PriceListPredictedLine>();
  for (const row of rows) {
    const previous = byLine.get(row.line_index);
    if (!previous
        || previous.created_at < row.created_at
        || (previous.created_at === row.created_at && previous.id < row.id)) {
      byLine.set(row.line_index, row);
    }
  }
  return byLine;
}

/**
 * Whether a prediction may fill a line in for the person, rather than only be shown to them.
 *
 * Three conditions, and all three are about money rather than convenience. The server's own verdict
 * has to be `apply_existing_price` — the arm where a SKU or barcode identified exactly one product,
 * never a name. The product has to still be in the catalogue this screen loaded, so an inactive or
 * deleted product cannot ride in on a prefill nobody chose. And the price has to be positive finite
 * money, because `submit-price-list` rejects anything else and a filled field that cannot be
 * submitted is worse than an empty one.
 *
 * Everything that fails stays unapproved and visible. A prefill is a draft the human confirms: the
 * server still takes the approved rows, still writes the audit reason, and still refuses a product
 * the catalogue does not have.
 */
function prefillable(
  prediction: PriceListPredictedLine | undefined,
  catalogue: ReadonlySet<string>,
): prediction is PriceListPredictedLine & { product_id: string; proposed_unit_price: number } {
  return !!prediction
    && prediction.predicted_action === 'apply_existing_price'
    && !!prediction.product_id
    && catalogue.has(prediction.product_id)
    && typeof prediction.proposed_unit_price === 'number'
    && Number.isFinite(prediction.proposed_unit_price)
    && prediction.proposed_unit_price > 0;
}

function prefilledDrafts(
  count: number,
  byLine: Map<number, PriceListPredictedLine>,
  catalogue: ReadonlySet<string>,
): LineDraft[] {
  return Array.from({ length: count }, (_, index) => {
    const prediction = byLine.get(index);
    if (!prefillable(prediction, catalogue)) {
      return { approved: false, productId: '', priceText: '', available: true };
    }
    return {
      approved: true,
      productId: prediction.product_id,
      priceText: String(prediction.proposed_unit_price),
      available: true,
    };
  });
}

/**
 * The month the prices land in, defaulting to the one we are in (OPEN-DECISIONS #150).
 *
 * A price list a supplier sends today prices today, so an empty required field was asking the
 * reviewer to restate the obvious on every upload. It stays an ordinary editable input with its
 * explanation beside it, because a list arriving in the last days of a month is sometimes next
 * month's — the default has to be cheap to change, not impossible to notice.
 */
function currentMonth(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
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
  actorId,
  onRefetch,
}: PriceListReviewConfirmationProps) {
  const interpretation = snapshot.interpretation;
  const lineItems = interpretation?.payload.line_items ?? [];
  const autoDecision = snapshot.priceListDecision;
  const autoLines = new Map(snapshot.priceListLines.map((line) => [line.line_index, line]));
  // What the automation already worked out for every line, whether or not it was allowed to act.
  const predictions = useMemo(
    () => predictionsByLine(snapshot.priceListPredictions ?? []),
    [snapshot.priceListPredictions],
  );
  const ownsDocument = Boolean(
    snapshot.document
    && snapshot.document.uploaded_by === actorId
  );
  const { profile } = useAuth();
  // Manual recovery stays a staff act; the trusted automatic command may create a keyed product.
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
  const [revertOpen, setRevertOpen] = useState(false);
  const [revertBusy, setRevertBusy] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Default on, and only ever seen when something actually needs a person: the point of the screen
  // is that a fully-read list costs one button, not 338 decisions.
  const [onlyUnmatched, setOnlyUnmatched] = useState(true);
  // Prefill runs once per interpretation. Re-running it after somebody edited a line would silently
  // undo their correction, which on a price is the one unacceptable outcome.
  const prefilledFor = useRef<string | null>(null);
  const payloadMatchesCurrent = attemptedPayload?.documentId === snapshot.documentId
    && attemptedPayload.interpretationId === interpretation?.id;
  const canStart = ownsDocument
    && snapshot.job?.status === 'review'
    && !autoDecision?.submission_id
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
    setTargetMonth(currentMonth(new Date()));
    setReason('');
    // Folded, deliberately. This used to open every line by default, which on a real 338-row price
    // list met the reviewer with 338 empty product selects and made the automatic matching look
    // like it had never run. The per-line form is still here, one click away, for the lines that
    // need a person.
    setDetailsOpen(false);
    setOnlyUnmatched(true);
    prefilledFor.current = null;
  }, [canStart, interpretation?.id, lineItems.length]);

  // Prefill from the server's own matching, once the catalogue that validates it has arrived.
  useEffect(() => {
    // `products.length` is the real gate, not `catalogLoading`: that flag is false for the render
    // before the catalogue fetch starts, and prefilling there validated every prediction against an
    // empty catalogue, marked the interpretation done and left all 338 lines unticked.
    if (!canStart || !interpretation || receipt || catalogLoading || catalogError) return;
    if (!products.length || prefilledFor.current === interpretation.id) return;
    prefilledFor.current = interpretation.id;
    const catalogue = new Set(products.map(({ id }) => id));
    setDrafts(prefilledDrafts(lineItems.length, predictions, catalogue));
  }, [
    canStart,
    catalogError,
    catalogLoading,
    interpretation,
    lineItems.length,
    predictions,
    products,
    receipt,
  ]);

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
        const result = await supabase.from('products')
          .select('id,name,unit,sku')
          .eq('active', true)
          .order('name');
        if (result.error) throw result.error;
        const options = (result.data ?? []) as ProductOption[];
        options.sort((left, right) => left.name.localeCompare(right.name, 'he'));
        if (!cancelled) setProducts(options);
      } catch (loadError) {
        if (!cancelled) setCatalogError(toHebrewError(loadError));
      } finally {
        if (!cancelled) setCatalogLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [canStart, catalogRevision, receipt]);

  useEffect(() => {
    let cancelled = false;
    if (!interpretation || !ownsDocument
        || (snapshot.job?.status !== 'completed' && !autoDecision?.submission_id)
        || receipt) {
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
  }, [
    autoDecision?.submission_id,
    interpretation?.id,
    ownsDocument,
    receipt,
    recoveryRevision,
    snapshot.job?.status,
  ]);

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
        .insert({ org_id: profile.org_id, name, unit: normalizeUnitInput(newProductUnit || 'יחידה'), active: true })
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

  async function revertAutoIntake(reason: string) {
    if (!autoDecision) return;
    setRevertBusy(true);
    setError(null);
    const result = await supabase.rpc('revert_price_list_auto_action', {
      p_decision_id: autoDecision.id,
      p_reason: reason.trim(),
    });
    setRevertBusy(false);
    if (result.error) {
      setError(toHebrewError(result.error.message));
      return;
    }
    setRevertOpen(false);
    await onRefetch();
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
      reason: reasonOr(reason, 'אישור מחירון שהתקבל'),
    };
    setAttemptedPayload(payload);
    await submitPayload(payload);
  }

  const showControls = canStart;
  const selectedCount = drafts.filter((draft) => draft.approved).length;
  const returnPath = '/prices';
  // Counted off the predictions rather than off the drafts: these two numbers state what the machine
  // read, and they have to stay true after somebody unticks a line they want to check by hand.
  const catalogue = new Set(products.map(({ id }) => id));
  const readyIndexes = lineItems.flatMap((_, index) =>
    prefillable(predictions.get(index), catalogue) ? [index] : []);
  const unmatchedIndexes = lineItems.flatMap((_, index) =>
    prefillable(predictions.get(index), catalogue) ? [] : [index]);
  const predictionsMissing = showControls && lineItems.length > 0 && predictions.size === 0;
  const visibleIndexes = showControls && onlyUnmatched && unmatchedIndexes.length > 0
    ? unmatchedIndexes
    : lineItems.map((_, index) => index);
  const detailsToggle = lineItems.length > 0 && (
    <button type="button" className="btn-secondary" data-testid="price-list-details-toggle"
      aria-expanded={detailsOpen} aria-controls="price-list-line-details"
      onClick={() => setDetailsOpen((open) => !open)}>
      {detailsOpen ? 'הסתר פרטים' : 'פרטים נוספים'}
    </button>
  );

  return (
    <section className="card card-pad min-w-0" aria-labelledby="price-list-review-title" data-testid="price-list-review-confirmation">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="price-list-review-title" className="section-title">תוצאות העלאת המחירון האחרונה</h2>
          <p className="mt-1 text-sm text-ink-muted">המערכת קולטת אוטומטית שורות בטוחות ויוצרת מוצר חדש כשיש שם ומק״ט או ברקוד. רק חריגים נשארים לבדיקה.</p>
        </div>
        <span className={receipt || autoDecision?.submission_id ? 'badge-done' : autoDecision ? 'badge-await' : 'badge-info'}>
          {receipt || autoDecision?.submission_id ? 'המחירון עודכן' : autoDecision ? 'נדרשת בדיקה' : 'הקליטה בעיבוד'}
        </span>
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg bg-surface-sunken p-3">
          <dt className="text-sm font-medium text-ink-soft">הספק שהוצע בפירוש</dt>
          <dd className="mt-1 break-words text-ink-body">{currentInterpretation.payload.supplier.suggested_name || 'לא זוהה'}</dd>
        </div>
        <div className="rounded-lg bg-surface-sunken p-3">
          <dt className="text-sm font-medium text-ink-soft">מספר שורות שזוהו</dt>
          <dd className="num mt-1 text-ink-body">{lineItems.length}</dd>
        </div>
        <div className="rounded-lg bg-surface-sunken p-3">
          <dt className="text-sm font-medium text-ink-soft">עמודים שנקראו</dt>
          <dd className="num mt-1 text-ink-body">{snapshot.extraction?.payload.document.page_count ?? '—'}</dd>
        </div>
      </dl>

      {autoDecision && (
        <div className="mt-4 rounded-lg border border-line bg-surface-sunken p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold text-ink-body">תוצאת הקליטה האוטומטית</h3>
            <span className={autoDecision.reverted_at
              ? 'badge-idle'
              : autoDecision.submission_id ? 'badge-done' : 'badge-await'}>
              {autoDecision.reverted_at
                ? 'בוטלה'
                : autoDecision.outcome === 'auto_applied'
                  ? 'נקלט במלואו'
                  : autoDecision.outcome === 'partially_applied'
                    ? 'נקלט חלקית'
                    : 'ממתין לבדיקה'}
            </span>
          </div>
          <p className="mt-2 text-sm text-ink-body">
            <span className="num">{autoDecision.accepted_count}</span> שורות נקלטו ·{' '}
            <span className="num">{autoDecision.waiting_count}</span> שורות ממתינות ·{' '}
            <span className="num">{autoDecision.created_product_count}</span> מוצרים חדשים נוצרו
          </p>
          {autoDecision.reason_code && FILING_REASON_LABELS[autoDecision.reason_code] && (
            <p className="mt-2 text-sm text-ink-muted">
              {FILING_REASON_LABELS[autoDecision.reason_code]}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            {detailsToggle}
            {!autoDecision.reverted_at && autoDecision.submission_id && (
              <button type="button" className="btn-danger" onClick={() => setRevertOpen(true)}>
                ביטול הקליטה האוטומטית
              </button>
              )}
          </div>
        </div>
      )}

      {!autoDecision && !showControls && detailsToggle && (
        <div className="mt-4 flex justify-start">{detailsToggle}</div>
      )}

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

      {/* The whole decision, above the lines rather than below them: what was read, what is
          missing, and one button. The per-line form is the exception path, not the route. */}
      {showControls && lineItems.length > 0 && (
        <div className="mt-4 border-t border-line pt-4" data-testid="price-list-intake-action">
          {catalogLoading ? (
            <p className="flex items-center gap-2 text-sm text-ink-muted" role="status">
              <Loader2 className="animate-spin motion-reduce:animate-none" size={17} aria-hidden="true" />
              מתאים את השורות לקטלוג המוצרים…
            </p>
          ) : (
            <p className="text-sm font-medium text-ink-body" role="status" data-testid="price-list-intake-summary">
              <span className="num">{readyIndexes.length}</span> מתוך <span className="num">{lineItems.length}</span> שורות זוהו במלואן — מוצר קיים ומחיר
              {unmatchedIndexes.length > 0 && (
                <> · <span className="num">{unmatchedIndexes.length}</span> שורות דורשות טיפול</>
              )}
            </p>
          )}
          {selectedCount !== readyIndexes.length && !catalogLoading && (
            <p className="mt-1 text-xs text-ink-muted" role="status">
              נבחרו כרגע <span className="num">{selectedCount}</span> שורות לקליטה.
            </p>
          )}
          {predictionsMissing && !catalogLoading && (
            <Note tone="info" className="mt-3">
              לא נמצאה התאמה אוטומטית שמורה למסמך הזה, ולכן אין מה למלא מראש. אפשר לאשר את השורות
              ידנית תחת „פרטים נוספים”.
            </Note>
          )}
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label>
              <span className="label">חודש יעד *</span>
              <input type="month" className="input num" value={targetMonth} onChange={(event) => setTargetMonth(event.target.value)} disabled={busy} />
              <span className="mt-1 block text-xs text-ink-muted">החודש קובע לאיזו גרסת מחירון ישויכו המחירים שנבחרו.</span>
            </label>
            <label>
              <span className="label">הערה ליומן הביקורת — רשות</span>
              <textarea className="input" rows={2} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} disabled={busy} />
            </label>
          </div>
          {error && <Note tone="alert" role="alert" className="mt-3">{error}</Note>}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            {detailsToggle}
            <button type="button" className="btn-primary" data-testid="price-list-intake-confirm"
              disabled={busy || selectedCount === 0 || catalogLoading || !!catalogError || products.length === 0}
              onClick={() => void confirmPriceList()}>
              {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" size={17} aria-hidden="true" /> : <CheckCircle2 size={17} aria-hidden="true" />}
              {busy ? 'קולט את המחירון…' : <>קליטת <span className="num">{selectedCount}</span> המחירים שנבחרו</>}
            </button>
          </div>
          {unmatchedIndexes.length > 0 && !catalogLoading && (
            <Note tone="await" className="mt-3 flex-wrap">
              <span className="min-w-0 flex-1">
                <span className="num">{unmatchedIndexes.length}</span> שורות לא הותאמו לבד ולא ייקלטו בלחיצה הזאת — מק״ט או ברקוד חסר, לא חד־משמעי, או מחיר שלא נקרא.
              </span>
              <button type="button" className="btn-secondary" data-testid="price-list-show-unmatched"
                onClick={() => { setOnlyUnmatched(true); setDetailsOpen(true); }}>
                טיפול בשורות שנותרו
              </button>
            </Note>
          )}
        </div>
      )}

      {lineItems.length === 0 && <p className="mt-4 text-sm text-ink-muted">לא זוהו שורות מחיר לאישור.</p>}
      {detailsOpen && lineItems.length > 0 && (
      <div id="price-list-line-details" className="mt-4 space-y-3">
        {showControls && unmatchedIndexes.length > 0 && (
          <label className="flex min-h-11 items-center gap-3 text-sm text-ink-body">
            <input type="checkbox" className="size-5" checked={onlyUnmatched}
              data-testid="price-list-unmatched-filter"
              onChange={(event) => setOnlyUnmatched(event.target.checked)} />
            הצג רק את <span className="num">{unmatchedIndexes.length}</span> השורות שדורשות טיפול
          </label>
        )}
        {visibleIndexes.map((index) => {
          const item = lineItems[index];
          const draft = drafts[index] ?? emptyDrafts(1)[0];
          const autoLine = autoLines.get(index);
          const prediction = predictions.get(index);
          const matched = prefillable(prediction, catalogue);
          const matchedProductName = matched
            ? products.find((product) => product.id === prediction.product_id)?.name ?? null
            : null;
          return (
            <article key={`${item.source_row ?? 'none'}-${index}`} className="rounded-lg border border-line bg-surface p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold text-ink-body">שורה <span className="num">{index + 1}</span></h3>
                <div className="flex items-center gap-2">
                  {autoLine && (
                    <span className={autoLine.outcome === 'applied' ? 'badge-done' : 'badge-await'}>
                      {autoLine.outcome === 'applied'
                        ? autoLine.product_created ? 'מוצר חדש נוצר ונקלט' : 'נקלטה אוטומטית'
                        : 'ממתינה'}
                    </span>
                  )}
                  <span className="text-xs text-ink-muted">שורת מקור <span className="num">{item.source_row ?? '—'}</span></span>
                </div>
              </div>
              <div className="mt-3 rounded-lg border border-line bg-surface p-3">
                  <dl className="grid gap-2 sm:grid-cols-2">
                    {Object.entries(item.values).map(([key, value]) => (
                      <div key={key} className="min-w-0 rounded-lg bg-surface-sunken p-2">
                        <dt className="text-xs font-medium text-ink-muted">{key}</dt>
                        <dd className="mt-1 break-words text-sm text-ink-body">{valueText(value)}</dd>
                      </div>
                    ))}
                  </dl>

                  {autoLine?.reason_code && (
                    <Note tone="await" className="mt-3">
                      {FILING_REASON_LABELS[autoLine.reason_code]
                        ?? 'השורה ממתינה לבדיקה ידנית.'}
                    </Note>
                  )}

                  {/* What the machine matched, said in full: which product, by which key, at which
                      price. The person is confirming a price, so the evidence for the prefill has
                      to be on the same card as the checkbox — not implied by a ticked box. */}
                  {prediction && (
                    <Note tone={matched ? 'done' : 'await'} className="mt-3">
                      {matched
                        ? <>הותאם לפי {MATCHED_BY_LABELS[prediction.matched_by ?? ''] ?? 'מפתח שלא נרשם'} למוצר „{matchedProductName ?? '—'}”; המחיר שנקרא <span className="num">{prediction.proposed_unit_price}</span>{prediction.current_unit_price !== null && <> במקום <span className="num">{prediction.current_unit_price}</span></>}</>
                        : prediction.reason_code && FILING_REASON_LABELS[prediction.reason_code]
                          ? FILING_REASON_LABELS[prediction.reason_code]
                          : 'המערכת לא התאימה את השורה לבד. ההכרעה כאן.'}
                    </Note>
                  )}

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
                          <option key={product.id} value={product.id}>{product.name} · {formatUnit(product.unit)}{product.sku ? ` · ${product.sku}` : ''}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span className="label">מחיר ידני *</span>
                      <input className="input num" inputMode="decimal" maxLength={64} value={draft.priceText} onChange={(event) => updateDraft(index, { priceText: event.target.value })} disabled={!draft.approved || busy} />
                    </label>
                  </div>
                  {draft.approved && (
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
              </div>
            </article>
          );
        })}
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
            <div><dt className="inline font-medium">מזהה הגשה: </dt><dd className="inline break-all tech-id" dir="ltr">{receipt.submission_id}</dd></div>
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

      <ConfirmDialog
        open={revertOpen}
        busy={revertBusy}
        danger
        requireReason
        title="ביטול קליטת המחירון האוטומטית"
        message="המחירים יוחזרו בפעולת פיצוי מתועדת. אם מחיר השתנה מאז הקליטה, הביטול ייחסם כדי לא לדרוס שינוי מאוחר."
        confirmLabel="ביטול הקליטה"
        onClose={() => setRevertOpen(false)}
        onConfirm={(reason) => void revertAutoIntake(reason ?? '')}
      />
    </section>
  );
}
