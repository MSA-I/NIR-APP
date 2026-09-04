import type { TKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/LocaleProvider';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { reasonOr } from '../../lib/reason';
import { CheckCircle2, Loader2, Plus } from 'lucide-react';
import { Link } from 'react-router';
import { supabase } from '../../lib/supabase';
import type { PriceListPredictedLine } from '../../lib/useDocumentProcessing';
import { useAuth } from '../../auth/AuthContext';
import { ConfirmDialog, ICON, MonthPicker, Note, SubPanel } from '../ui';
import { PrimaryDecision } from './PrimaryDecision';
import { FILING_REASON_KEYS, type ReviewSnapshot } from './model';
import { bidiIsolate, formatUnit, normalizeUnitInput } from '../../lib/format';

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

function valueText(value: string | number | null, t: (key: TKey) => string): string {
  return value === null ? t('priceListReview.valueNotRecognised') : String(value);
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

const MATCHED_BY_KEYS: Record<string, TKey> = {
  supplier_sku: 'priceListReview.matchedBySupplierSku',
  sku: 'priceListReview.matchedBySku',
  barcode: 'priceListReview.matchedByBarcode',
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

// A real price list is 338 lines. Rendering all of them as one column of open forms is what made
// the screen unusable; a page is a window on the same list, not a different list.
const PAGE_SIZE = 50;

function parseReceipt(value: unknown, t: (key: TKey) => string): SubmissionReceipt {
  if (!value || typeof value !== 'object') throw new Error(t('priceListReview.receiptMalformed'));
  const row = value as Record<string, unknown>;
  if (typeof row.submission_id !== 'string'
      || typeof row.revision !== 'number'
      || typeof row.accepted_count !== 'number'
      || typeof row.rejected_count !== 'number'
      || typeof row.unchanged_count !== 'number'
      || typeof row.idempotent !== 'boolean') {
    throw new Error(t('priceListReview.receiptMalformed'));
  }
  return row as unknown as SubmissionReceipt;
}

async function recoverStoredReceipt(interpretationId: string, t: (key: TKey) => string): Promise<SubmissionReceipt | null> {
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
  }, t);
}

function hasHttpResponse(error: unknown): boolean {
  const context = (error as { context?: Response } | null)?.context;
  return Boolean(context && typeof context.json === 'function' && typeof context.status === 'number');
}

async function edgeErrorCondition(error: unknown) {
  const context = (error as { context?: Response } | null)?.context;
  if (context && typeof context.json === 'function') {
    try {
      const body = await context.json() as { error?: { message?: string; detail?: string } };
      if (body.error?.message) {
        return body.error.detail ? `${body.error.message} (${body.error.detail})` : body.error.message;
      }
    } catch { /* use the transport mapping below */ }
    // Conditions, not sentences: all four are registered in src/lib/errors.ts, so the screen
    // resolves them like every other failure instead of this file owning four private wordings.
    if (context.status === 401) return 'price_list_confirm_session_expired';
    if (context.status === 403) return 'price_list_confirm_forbidden';
    if (context.status === 409) return 'price_list_confirm_conflict';
    if (context.status === 404 || context.status >= 500) return 'price_list_confirm_unavailable';
  }
  return error instanceof Error ? error.message : String(error);
}

export function PriceListReviewConfirmation({
  snapshot,
  actorId,
  onRefetch,
}: PriceListReviewConfirmationProps) {
  const { errorText, locale, t } = useT();
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
  /** How many products the bulk create made, so the screen can say so instead of just changing. */
  const [bulkCreated, setBulkCreated] = useState<number | null>(null);
  const createErrorId = useId();
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
  const [page, setPage] = useState(0);
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
    setPage(0);
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
        if (!cancelled) setCatalogError(errorText(loadError));
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
    void recoverStoredReceipt(interpretation.id, t).then((storedReceipt) => {
      if (cancelled) return;
      if (storedReceipt) setReceipt(storedReceipt);
      else setRecoveryError(t('priceListReview.setRecoveryError'));
    }).catch((loadError) => {
      if (!cancelled) setRecoveryError(t('priceListReview.receiptRecoveryFailed', { message: errorText(loadError) }));
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

  /**
   * A line that has just become complete is a line the reviewer meant to take.
   *
   * The per-line form used to disable the product select and the price field until the reviewer
   * ticked "אני מאשר שורה זו לקליטה" — asking them to approve a line before they were allowed to
   * say what it was. That is one tap per exception, in the wrong order, on the only part of this
   * screen a person actually works. The fields are live now, and the tick follows the work instead
   * of gating it.
   *
   * This is not a new rule about money, it is the rule this screen already ran on everywhere else:
   * `prefilledDrafts` ticks every line the server matched. Nothing is submitted by ticking — the
   * confirm button still names the count, the price
   * stays visible and editable in its field, and the server still refuses a row whose product is
   * not in the catalogue.
   *
   * It fires only on the edit that COMPLETES a line, never again: an explicit untick is the
   * reviewer's decision, and a later price correction must not silently overturn it.
   */
  function updateDraft(index: number, patch: Partial<LineDraft>) {
    setDrafts((current) => current.map((draft, draftIndex) => {
      if (draftIndex !== index) return draft;
      const next = { ...draft, ...patch };
      if ('approved' in patch) return next;
      const wasComplete = !!draft.productId && !!draft.priceText.trim();
      const isComplete = !!next.productId && !!next.priceText.trim();
      return wasComplete || !isComplete ? next : { ...next, approved: true };
    }));
  }

  /**
   * The price this very row printed, put in the field when a product is chosen for it.
   *
   * The number is already on the screen — the machine read it, stored it on the prediction and the
   * review path submits it verbatim. Making the reviewer retype it into "מחיר ידני" was
   * asking them to key in what the system already knew. Guarded by the same three conditions
   * `prefillable` uses for money, and never overwrites a value someone typed.
   */
  function predictedPriceText(index: number, draft: LineDraft | undefined): string | null {
    if (draft?.priceText.trim()) return null;
    const price = predictions.get(index)?.proposed_unit_price;
    return typeof price === 'number' && Number.isFinite(price) && price > 0 ? String(price) : null;
  }

  // Explicit, per-line product creation. The product exists BEFORE the confirm payload is built,
  // so the server invariant "האישור אינו יוצר מוצרים" stays intact — creation is its own user act.
  async function createProduct(index: number) {
    const name = newProductName.trim();
    if (!name) { setCreateError(t('priceListReview.newProductNameRequired')); return; }
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
      const price = predictedPriceText(index, drafts[index]);
      updateDraft(index, { productId: product.id, ...(price === null ? {} : { priceText: price }) });
      setNewProductFor(null);
    } catch (insertError) {
      setCreateError(errorText(insertError));
    } finally {
      setBusyCreate(false);
    }
  }

  async function finishWithReceipt(nextReceipt: SubmissionReceipt) {
    setReceipt(nextReceipt);
    setRecoveryError(null);
    if (!await onRefetch()) {
      setRefreshWarning(t('priceListReview.setRefreshWarning'));
    }
  }

  async function recoverAfterSubmission(interpretationId: string): Promise<'found' | 'missing' | 'failed'> {
    try {
      const storedReceipt = await recoverStoredReceipt(interpretationId, t);
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
      setError(errorText(result.error.message));
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
        const message = errorText(await edgeErrorCondition(response.error));
        const recovery = await recoverAfterSubmission(payload.interpretationId);
        if (recovery === 'found') return;
        if (responseReceived && recovery === 'missing' && snapshot.job?.status === 'review') {
          setAttemptedPayload(null);
        }
        setError(recovery === 'failed'
          ? t('priceListReview.receiptUnverified', { message })
          : message);
        return;
      }

      try {
        await finishWithReceipt(parseReceipt(response.data, t));
      } catch (receiptError) {
        const recovery = await recoverAfterSubmission(payload.interpretationId);
        if (recovery !== 'found') {
          setError(recovery === 'failed'
            ? t('priceListReview.text')
            : receiptError instanceof Error ? receiptError.message : errorText(receiptError));
        }
      }
    } catch (submitError) {
      const recovery = await recoverAfterSubmission(payload.interpretationId);
      if (recovery !== 'found') {
        const message = submitError instanceof Error ? submitError.message : errorText(submitError);
        setError(recovery === 'failed'
          ? t('priceListReview.receiptUnverified', { message })
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
      setError(t('priceListReview.setError'));
      return;
    }
    if (!approvedRows.length) {
      setError(t('priceListReview.setError_2'));
      return;
    }
    if (approvedRows.some((row) => !allowedProductIds.has(row.productId) || !row.priceText)) {
      setError(t('priceListReview.setError_3'));
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
  /* `priceListIngested` lived here until 04.09.2026. Its only reader was the automation-readiness
     disclosure, which told an already-ingested document that it had nothing left to prepare. Both
     went together; the receipt block below is what says a price list has been taken in. */
  const selectedCount = drafts.filter((draft) => draft.approved).length;
  const returnPath = '/prices';
  // Counted off the predictions rather than off the drafts: this states what the machine read, and
  // it has to stay true after somebody unticks a line they want to check by hand.
  //
  // `readyIndexes` — its mirror image — stood beside it until 04.09.2026 and served one purpose:
  // the summary "N מתוך M שורות זוהו במלואן". That sentence went with the rest of the six-block
  // header. What the screen states now is what the reader can act on (`pendingIndexes`), not what
  // the matcher managed, and the difference is not cosmetic: after a bulk creation the machine's
  // count is still zero while every line is ready to submit.
  const catalogue = new Set(products.map(({ id }) => id));
  const unmatchedIndexes = lineItems.flatMap((_, index) =>
    prefillable(predictions.get(index), catalogue) ? [] : [index]);
  const predictionsMissing = showControls && lineItems.length > 0 && predictions.size === 0;
  /**
   * Lines still waiting for a person: unmatched, and not yet carrying BOTH a product and a price.
   *
   * It used to test the product alone, and the exception filter is what made that wrong: choosing
   * a product removed the row from the "needs you" list *while the reviewer was still standing in
   * it*, taking the empty price field with it. The line was then linked, unpriced and invisible —
   * and `submit-price-list` refuses exactly that row. Product and price are the two things the
   * server will not take an approved row without, so they are the two things that decide whether a
   * line is still open.
   */
  const pendingIndexes = unmatchedIndexes.filter((index) => {
    const draft = drafts[index];
    return !draft?.productId || !draft.priceText.trim();
  });
  // Filtered on what is still open, not on what the machine failed to match: a line the reviewer
  // has since given a product to by hand is handled, and keeping
  // it in the "needs you" list would send them back to work that is already done.
  const visibleIndexes = showControls && onlyUnmatched && pendingIndexes.length > 0
    ? pendingIndexes
    : lineItems.map((_, index) => index);
  const pageCount = Math.max(1, Math.ceil(visibleIndexes.length / PAGE_SIZE));
  // Clamped rather than reset: switching the filter shortens the list under a reader who was on
  // page 5, and an out-of-range page renders an empty list that looks like lost lines.
  const currentPage = Math.min(page, pageCount - 1);
  const pageStart = currentPage * PAGE_SIZE;
  const pageIndexes = visibleIndexes.slice(pageStart, pageStart + PAGE_SIZE);
  // A line is markable only once it carries a product and a price, because those are exactly the
  // two things the server refuses an approved row without. Ticking the rest in bulk would build a
  // payload that fails as a whole and takes the good lines down with it.
  const markableOnPage = pageIndexes.filter((index) => {
    const draft = drafts[index];
    return !!draft?.productId && !!draft.priceText.trim();
  });
  const allMarkedOnPage = markableOnPage.length > 0
    && markableOnPage.every((index) => drafts[index]?.approved);

  function setApprovedOnPage(approved: boolean) {
    const targets = new Set(markableOnPage);
    setDrafts((current) => current.map((draft, index) =>
      targets.has(index) ? { ...draft, approved } : draft));
  }

  /**
   * Create, in one act, a product for every line the matcher could not attach to the catalogue.
   *
   * This is the first-run path. A new tenant's catalogue is empty, so nothing matches, the confirm
   * button below is disabled by construction, and it read "קליטת 0" — it offered the customer the
   * one thing it could never do. Creating the products is what they came to do, so it is offered
   * as an action rather than left per-line behind "פרטים נוספים", 74 forms deep.
   *
   * It creates products ONLY. Prices still go through the ordinary confirmation below, so the
   * server invariant `createProduct` records — "האישור אינו יוצר מוצרים" — holds exactly as it did
   * when creation was one line at a time: creation stays its own user act, and this is that act
   * performed once instead of seventy-four times.
   *
   * Two lines naming the same product create it once. A line whose name cannot be read is skipped
   * rather than creating a product called nothing — the same choice `planBulkCreate` makes.
   */
  async function createAllMissingProducts() {
    if (!profile) return;
    const known = new Set(products.map((product) => product.name.trim().toLowerCase()));
    const wanted = new Map<string, { name: string; unit: string; indexes: number[] }>();
    for (const index of unmatchedIndexes) {
      const item = lineItems[index];
      if (!item) continue;
      const prediction = predictions.get(index);
      const name = (prediction?.product_name ?? guessLineName(item.values)).trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (known.has(key)) continue;
      const already = wanted.get(key);
      if (already) { already.indexes.push(index); continue; }
      wanted.set(key, {
        name,
        unit: (prediction?.unit ?? '').trim() || t('priceListReview.createAllDefaultUnit'),
        indexes: [index],
      });
    }
    const rows = [...wanted.values()];
    if (rows.length === 0) { setCreateError(t('priceListReview.createAllNone')); return; }
    setBusyCreate(true);
    setCreateError(null);
    try {
      const inserted = await supabase.from('products')
        .insert(rows.map((row) => ({
          org_id: profile.org_id, name: row.name, unit: normalizeUnitInput(row.unit), active: true,
        })))
        .select('id,name,unit,sku');
      if (inserted.error) throw inserted.error;
      const created = (inserted.data ?? []) as ProductOption[];
      // Claim the prefill BEFORE the catalogue grows. The prefill effect above skips an empty
      // catalogue without claiming it, so the moment `setProducts` makes the catalogue non-empty
      // that effect fires — and it prefills from `predictions`, which were computed when these
      // products did not exist and therefore carry `product_id: null`. It would overwrite every
      // draft this function is about to fill, one render later, and the screen would go back to
      // "קליטת 0" with the products silently created. Marking it here says what is true: this
      // interpretation's drafts have been filled, by hand, from the lines themselves.
      prefilledFor.current = currentInterpretation.id;
      setProducts((current) => [...current, ...created]
        .sort((left, right) => left.name.localeCompare(right.name, 'he')));
      // Joined by name, never by position: the insert preserves order today, and relying on that
      // would be a silent mis-mapping the day it stops.
      const byName = new Map(created.map((product) => [product.name.trim().toLowerCase(), product]));
      for (const row of rows) {
        const product = byName.get(row.name.toLowerCase());
        if (!product) continue;
        for (const index of row.indexes) {
          const price = predictedPriceText(index, drafts[index]);
          updateDraft(index, { productId: product.id, ...(price === null ? {} : { priceText: price }) });
        }
      }
      setBulkCreated(created.length);
    } catch (insertError) {
      setCreateError(errorText(insertError));
    } finally {
      setBusyCreate(false);
    }
  }

  const pager = pageCount > 1 && (
    <div className="flex flex-wrap items-center justify-between gap-2" data-testid="price-list-pager">
      <span className="text-sm text-ink-muted">
        {t('priceListReview.pagerLines')}<span className="num">{pageStart + 1}</span>–<span className="num">{pageStart + pageIndexes.length}</span>{' '}
        {t('priceListReview.text_3')} <span className="num">{visibleIndexes.length}</span> {t('priceListReview.text_2')} <span className="num">{currentPage + 1}</span> {t('priceListReview.text_3')} <span className="num">{pageCount}</span>
      </span>
      <div className="flex items-center gap-2">
        <button type="button" className="btn-secondary" data-testid="price-list-page-previous"
          disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
          {t('priceListReview.text_4')}
        </button>
        <button type="button" className="btn-secondary" data-testid="price-list-page-next"
          disabled={currentPage >= pageCount - 1} onClick={() => setPage(currentPage + 1)}>
          {t('priceListReview.text_5')}
        </button>
      </div>
    </div>
  );
  /**
   * The way back out of the line list, and the ONLY toggle this screen still has.
   *
   * "פרטים נוספים" — a button that opened 74 forms on a screen whose whole promise is that a
   * read price list costs one click — was removed by owner ruling 04.09.2026 ("להסיר לגמרי").
   * The line list is now reached by exactly one door, „טיפול בשורות שנותרו”, which is offered only
   * while lines are actually still open and which opens them already filtered to those lines. A
   * reader who took that door needs a way back, so the close half of the old toggle survives —
   * inside the panel it closes, where it is an exit rather than an invitation.
   */
  const detailsClose = (
    <button type="button" className="btn-secondary" data-testid="price-list-details-close"
      aria-expanded={detailsOpen} aria-controls="price-list-line-details"
      onClick={() => setDetailsOpen(false)}>
      {t('priceListReview.text_6')}
    </button>
  );

  /**
   * The one sentence the screen leads with. Four states, one line each, and each names the thing
   * the button beside it is about to do.
   *
   * The counts come from the DRAFTS (`pendingIndexes`), never from the matcher's own tally. After a
   * bulk creation the matcher has still matched nothing — its predictions were computed before
   * those products existed — while every line now carries a product and a price. A sentence written
   * off the matcher would say "אף אחד מהם עדיין לא קיים אצלך" above a button offering to take all
   * 74 prices in.
   */
  const linkedCount = lineItems.length - pendingIndexes.length;
  const intakeSummary = predictionsMissing
    // Not the same fact as "nothing matched": nothing was ever compared. Saying the products do not
    // exist would be a claim about the catalogue that no run of the matcher supports.
    ? t('priceListReview.firstRunNoMatching', { count: lineItems.length })
    : pendingIndexes.length === 0
      ? bulkCreated !== null
        ? t('priceListReview.createAllDone', { count: bulkCreated })
        : t('priceListReview.firstRunAllExisting', { count: lineItems.length })
      : linkedCount === 0
        ? t('priceListReview.firstRunNoneExisting', { count: lineItems.length })
        : t('priceListReview.firstRunPartial', {
          total: lineItems.length, ready: linkedCount, missing: pendingIndexes.length,
        });

  return (
    <section className="card card-pad min-w-0" aria-labelledby="price-list-review-title" data-testid="price-list-review-confirmation">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="price-list-review-title" className="section-title">{t('priceListReview.text_8')}</h2>
          {/* Two different documents, two different true sentences. Describing the automatic intake
              on a document where it never ran — the ordinary case, because the calibrated scope gate
              of 0096 is not reachable from the product (DEBT-REGISTER §42) — told the reader the
              system had done something it had not. */}
          <p className="mt-1 text-sm text-ink-muted">
            {autoDecision || receipt
              ? t('priceListReview.text_9')
              : showControls
                ? t('priceListReview.text_10')
                : t('priceListReview.text_11')}
          </p>
        </div>
        {/* „הקליטה בעיבוד” was shown on a document whose reading had finished and whose intake was
            waiting for a person — a reassurance about work nobody was doing. */}
        <span className={receipt || autoDecision?.submission_id
          ? 'badge-done'
          : autoDecision || showControls ? 'badge-await' : 'badge-info'}>
          {receipt || autoDecision?.submission_id
            ? t('priceListReview.text_12')
            : autoDecision ? t('priceListReview.text_13') : showControls ? t('priceListReview.text_14') : t('priceListReview.text_15')}
        </span>
      </div>

      {/* The supplier / line-count / page-count tiles stood here until 04.09.2026. Three boxes of
          metadata above the one decision the screen exists to take, and none of them changed what
          the reader was going to do next: the line count is inside the sentence below, the page
          count answers a question nobody asked, and the suggested supplier name is already the
          document's own title on the page above. Owner report: "יש יותר מדי פרטים … זהו, לא שום
          פרט מעבר".

          The „כלי הכנה לאוטומציה (למתקדמים)" disclosure went at the same time, and it took
          `PriceListAutomationReadiness` with it. It was an operator tool wearing a customer's
          screen — dry runs, calibration batches, Platform activation — and its dry run greeted a
          first-time reader with "בדיקת הכשירות נכשלה — פנה לתמיכה", a red failure for a check they
          never asked to run and cannot act on. Folding it was not enough; it is gone. The
          calibration gate it was preparing is `DEBT §42`, which was already blocked for a
          different reason, and §42 now records that its only surface has to be rebuilt inside the
          operator console rather than on the customer's document. */}

      {autoDecision && (
        <SubPanel className="mt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold text-ink-body">{t('priceListReview.text_20')}</h3>
            <span className={autoDecision.reverted_at
              ? 'badge-idle'
              : autoDecision.submission_id ? 'badge-done' : 'badge-await'}>
              {autoDecision.reverted_at
                ? t('priceListReview.text_21')
                : autoDecision.outcome === 'auto_applied'
                  ? t('priceListReview.text_22')
                  : autoDecision.outcome === 'partially_applied'
                    ? t('priceListReview.text_23')
                    : t('priceListReview.text_24')}
            </span>
          </div>
          <p className="mt-2 text-sm text-ink-body">
            <span className="num">{autoDecision.accepted_count}</span>{t('priceListReview.autoAccepted')}{' '}
            <span className="num">{autoDecision.waiting_count}</span>{t('priceListReview.autoWaiting')}{' '}
            <span className="num">{autoDecision.created_product_count}</span>{t('priceListReview.autoCreated')}
          </p>
          {autoDecision.reason_code && FILING_REASON_KEYS[autoDecision.reason_code] && (
            <p className="mt-2 text-sm text-ink-muted">
              {t(FILING_REASON_KEYS[autoDecision.reason_code])}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            {/* NOT the "פרטים נוספים" toggle that was removed from the intake screen, and the
                difference is the whole reason this one stays. There it opened 74 empty forms in
                front of somebody who had not yet decided anything. Here the decision is over and
                the rows are the receipt: this is the only way to see which lines a completed intake
                actually took, so it is named after them instead of after itself. */}
            {!detailsOpen && lineItems.length > 0 ? (
              <button type="button" className="btn-secondary" data-testid="price-list-show-lines"
                aria-expanded={false} aria-controls="price-list-line-details"
                onClick={() => { setOnlyUnmatched(false); setDetailsOpen(true); }}>
                {t('priceListReview.showIngestedLines')}
              </button>
            ) : <span />}
            {!autoDecision.reverted_at && autoDecision.submission_id && (
              <button type="button" className="btn-danger" onClick={() => setRevertOpen(true)}>
                {t('priceListReview.text_25')}
              </button>
            )}
          </div>
        </SubPanel>
      )}

      {recoveryLoading && !receipt && (
        <Note tone="info" role="status" className="mt-4">
          <Loader2 className="animate-spin" size={ICON.md} aria-hidden="true" />
          <span className="min-w-0 flex-1">{t('priceListReview.text_26')}</span>
        </Note>
      )}
      {recoveryError && !receipt && (
        <Note tone="alert" role="alert" className="mt-4 flex-wrap">
          <span className="min-w-0 flex-1">{recoveryError}</span>
          <button type="button" className="btn-secondary" disabled={recoveryLoading} onClick={() => setRecoveryRevision((value) => value + 1)}>{t('priceListReview.setRecoveryRevision')}</button>
        </Note>
      )}
      {!ownsDocument && !receipt && (
        <Note tone="idle" className="mt-4">{t('priceListReview.text_27')}</Note>
      )}
      {ownsDocument && !receipt && !attemptedPayload && !recoveryLoading && !recoveryError
        && snapshot.job?.status !== 'review' && snapshot.job?.status !== 'completed' && (
        <Note tone="idle" className="mt-4">{t('priceListReview.text_28')}</Note>
      )}
      {attemptedPayload && !receipt && (
        <Note tone="await" className="mt-4 flex-wrap">
          <span className="min-w-0 flex-1">
            {t('priceListReview.lockedAfterFirst')}<span className="num">{attemptedPayload.approvedRows.length}</span> {t('priceListReview.slice')} <span className="num">{attemptedPayload.targetMonth.slice(0, 7)}</span>{t('priceListReview.replayNoChanges')}
          </span>
          {canReplay && (
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => void submitPayload(attemptedPayload)}>
              {busy && <Loader2 className="animate-spin" size={ICON.md} aria-hidden="true" />}
              {t('priceListReview.text_29')}
            </button>
          )}
        </Note>
      )}
      {catalogError && showControls && (
        <Note tone="alert" role="alert" className="mt-4 flex-wrap">
          <span className="min-w-0 flex-1">{t('priceListReview.catalogLoadFailed')} {catalogError}</span>
          <button type="button" className="btn-secondary" onClick={() => setCatalogRevision((value) => value + 1)}>{t('priceListReview.setCatalogRevision')}</button>
        </Note>
      )}
      {/* ONE sentence and ONE button. Rebuilt 04.09.2026 on an owner report from the live site:
          "אם אני מעלה מסמך ולא קיים שום מוצר זה אמור להראות שאין שום מוצר והאם הוא רוצה לקלוט
          אותם — זהו".

          What stood here was six blocks that all described the same 74 lines: a summary counting
          what the machine matched, a second line counting what was ticked, an info note explaining
          that nothing was prefilled, an amber note naming why lines went unmatched, a blue
          first-run note offering to create the products, and a month field with a free-text audit
          note above the button. On a first price list every one of them was true and the reader
          still could not tell what to press — the button said "קליטת 0 המחירים שנבחרו" and was
          disabled.

          The state machine underneath is unchanged, and it is what makes one button possible: the
          primary is "take these prices in" whenever there is anything to take in, and "create the
          products" only when there is not. A first price list against an empty catalogue therefore
          offers creation, and every state after it offers the intake — including the mixed list,
          where the forty matched lines are taken in by the same one click that a fully matched list
          uses, and the thirty-four that need a person wait behind „טיפול בשורות שנותרו”.

          The bulk creation follows them in there rather than crowding the front of the screen with
          a third control: a reader who has lines to correct is already in the panel, and that is
          where creating the missing products in one act belongs.

          The month and the audit note moved into the line panel. `targetMonth` already defaults to
          the current month on mount and `reason` already falls back through `reasonOr`, so neither
          field was ever a question the ordinary reader had to answer; they were two inputs standing
          between a person and the only button on the screen. */}
      {showControls && lineItems.length > 0 && (
        <div className="mt-4 border-t border-line pt-4" data-testid="price-list-intake-action">
          {catalogLoading ? (
            <p className="flex items-center gap-2 text-sm text-ink-muted" role="status">
              <Loader2 className="animate-spin" size={ICON.md} aria-hidden="true" />
              {t('priceListReview.text_31')}
            </p>
          ) : (
            <>
              <p className="text-sm font-medium text-ink-body" role="status" data-testid="price-list-intake-summary">
                {intakeSummary}
              </p>
              {error && <Note tone="alert" role="alert" className="mt-3">{error}</Note>}
              {createError && <Note tone="alert" role="alert" className="mt-3">{t('priceListReview.createAllFailed')}{createError}</Note>}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {/* The switch is `selectedCount`, not `pendingIndexes`: it asks "is there anything
                    to take in", which is the only question the primary button can answer. Switching
                    on the pending lines instead would hide the intake from a mixed list — forty
                    matched lines the reader is entitled to take in with the same one click that a
                    fully matched list gets, held hostage by thirty-four that need a person. */}
                {selectedCount > 0 ? (
                  <PrimaryDecision label={t('priceListReview.label')}>
                    <button type="button" className="btn-primary" data-testid="price-list-intake-confirm"
                      disabled={busy || !!catalogError || products.length === 0}
                      onClick={() => void confirmPriceList()}>
                      {busy ? <Loader2 className="animate-spin" size={ICON.md} aria-hidden="true" /> : <CheckCircle2 size={ICON.md} aria-hidden="true" />}
                      {busy ? t('priceListReview.text_39') : t('priceListReview.confirmAction', { count: selectedCount })}
                    </button>
                  </PrimaryDecision>
                ) : (
                  <button type="button" className="btn-primary" data-testid="price-list-create-all"
                    disabled={busyCreate || unmatchedIndexes.length === 0} onClick={() => void createAllMissingProducts()}>
                    {busyCreate
                      ? <Loader2 className="animate-spin" size={ICON.md} aria-hidden="true" />
                      : <Plus size={ICON.md} aria-hidden="true" />}
                    {busyCreate
                      ? t('priceListReview.createAllBusy')
                      : t('priceListReview.createAllAction', { count: pendingIndexes.length })}
                  </button>
                )}
                {/* The single remaining door into the 74 forms, and it is offered only while lines
                    are genuinely still open. It opens them already filtered to those lines. */}
                {pendingIndexes.length > 0 && !detailsOpen && (
                  <button type="button" className="btn-secondary" data-testid="price-list-show-unmatched"
                    onClick={() => { setOnlyUnmatched(true); setDetailsOpen(true); }}>
                    {t('priceListReview.text_42')}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {lineItems.length === 0 && <p className="mt-4 text-sm text-ink-muted">{t('priceListReview.text_43')}</p>}
      {detailsOpen && lineItems.length > 0 && (
      <div id="price-list-line-details" className="mt-4 space-y-3">
        {/* Creating every missing product in one act. It is the front screen's primary button only
            while there is nothing to take in; once there is, it belongs here — beside the lines it
            is about to fill, and in front of the reader who opened this panel to deal with them. */}
        {showControls && selectedCount > 0 && unmatchedIndexes.length > 0 && (
          <button type="button" className="btn-secondary" data-testid="price-list-create-all-remaining"
            disabled={busyCreate} onClick={() => void createAllMissingProducts()}>
            {busyCreate
              ? <Loader2 className="animate-spin" size={ICON.md} aria-hidden="true" />
              : <Plus size={ICON.md} aria-hidden="true" />}
            {busyCreate
              ? t('priceListReview.createAllBusy')
              : t('priceListReview.createAllAction', { count: pendingIndexes.length })}
          </button>
        )}
        {/* The two fields that used to stand between the reader and the only button on the screen.
            Both already answer themselves — `targetMonth` is set to the current month on mount and
            `reason` falls back through `reasonOr` — so they belong where somebody who wants to
            override them will look, which is the same panel as the per-line corrections. */}
        {showControls && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <span className="label">{t('priceListReview.text_36')}</span>
              <MonthPicker label={t('priceListReview.text_36')} value={targetMonth} onChange={setTargetMonth} disabled={busy} />
              <span className="mt-1 block text-xs text-ink-muted">{t('priceListReview.text_37')}</span>
            </div>
            <label>
              <span className="label">{t('priceListReview.text_38')}</span>
              <textarea className="input" rows={2} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} disabled={busy} />
            </label>
          </div>
        )}
        {showControls && pendingIndexes.length > 0 && (
          <label className="flex min-h-11 items-center gap-3 text-sm text-ink-body">
            <input type="checkbox" className="size-5 shrink-0" checked={onlyUnmatched}
              data-testid="price-list-unmatched-filter"
              onChange={(event) => { setOnlyUnmatched(event.target.checked); setPage(0); }} />
            {t('priceListReview.showOnlyBefore')}<span className="num">{pendingIndexes.length}</span>{t('priceListReview.showOnlyAfter')}
          </label>
        )}
        {showControls && markableOnPage.length > 0 && (
          <label className="flex min-h-11 items-center gap-3 text-sm text-ink-body">
            <input type="checkbox" className="size-5 shrink-0" checked={allMarkedOnPage} disabled={busy}
              data-testid="price-list-page-select-all"
              onChange={(event) => setApprovedOnPage(event.target.checked)} />
            {t('priceListReview.markReadyBefore')}<span className="num">{markableOnPage.length}</span>{t('priceListReview.markReadyAfter')}
          </label>
        )}
        {pager}
        {pageIndexes.map((index) => {
          const item = lineItems[index];
          const draft = drafts[index] ?? emptyDrafts(1)[0];
          const autoLine = autoLines.get(index);
          const prediction = predictions.get(index);
          const matched = prefillable(prediction, catalogue);
          const matchedProductName = matched
            ? products.find((product) => product.id === prediction.product_id)?.name ?? null
            : null;
          return (
            <SubPanel as="article" key={`${item.source_row ?? 'none'}-${index}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold text-ink-body">{t('priceListReview.text_44')} <span className="num">{index + 1}</span></h3>
                <div className="flex items-center gap-2">
                  {autoLine && (
                    <span className={autoLine.outcome === 'applied' ? 'badge-done' : 'badge-await'}>
                      {autoLine.outcome === 'applied'
                        ? autoLine.product_created ? t('priceListReview.text_45') : t('priceListReview.text_46')
                        : t('priceListReview.text_47')}
                    </span>
                  )}
                  <span className="text-xs text-ink-muted">{t('priceListReview.text_48')} <span className="num">{item.source_row ?? '—'}</span></span>
                </div>
              </div>
              <SubPanel className="mt-3">
                  <dl className="grid gap-2 sm:grid-cols-2">
                    {Object.entries(item.values).map(([key, value]) => (
                      <div key={key} className="min-w-0 rounded-lg bg-surface-sunken p-2">
                        <dt className="text-xs font-medium text-ink-muted">{key}</dt>
                        <dd className="mt-1 break-words text-sm text-ink-body">{valueText(value, t)}</dd>
                      </div>
                    ))}
                  </dl>

                  {autoLine?.reason_code && (
                    <Note tone="await" className="mt-3">
                      {autoLine.reason_code in FILING_REASON_KEYS
                        ? t(FILING_REASON_KEYS[autoLine.reason_code])
                        : t('priceListReview.text_49')}
                    </Note>
                  )}

                  {/* What the machine matched, said in full: which product, by which key, at which
                      price. The person is confirming a price, so the evidence for the prefill has
                      to be on the same card as the checkbox — not implied by a ticked box. */}
                  {prediction && (
                    <Note tone={matched ? 'done' : 'await'} className="mt-3">
                      {matched
                        ? <>{t('priceListReview.matchedByBefore')} {(prediction.matched_by ?? '') in MATCHED_BY_KEYS ? t(MATCHED_BY_KEYS[prediction.matched_by ?? '']) : t('priceListReview.text_50')} {t('priceListReview.matchedForProduct')} „{matchedProductName ?? '—'}”{t('priceListReview.matchedPriceRead')} <span className="num">{prediction.proposed_unit_price}</span>{prediction.current_unit_price !== null && <> {t('priceListReview.text_51')} <span className="num">{prediction.current_unit_price}</span></>}</>
                        : prediction.reason_code && prediction.reason_code in FILING_REASON_KEYS
                          ? t(FILING_REASON_KEYS[prediction.reason_code])
                          : t('priceListReview.text_52')}
                    </Note>
                  )}

                  {showControls && (
                    <div className="mt-3 border-t border-line pt-3">
                  <label className="flex min-h-11 items-center gap-3 font-medium text-ink-body">
                    <input type="checkbox" className="size-5 shrink-0" checked={draft.approved} onChange={(event) => updateDraft(index, { approved: event.target.checked })} disabled={busy} />
                    {t('priceListReview.text_53')}
                  </label>
                  {/* Live regardless of the tick above: describing the line is the work, approving
                      it is the conclusion. Choosing a product also drops in the price this row
                      printed, so an exception line costs one control, not three. */}
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label>
                      <span className="label">{t('priceListReview.text_54')}</span>
                      <select className="input" data-testid="price-list-row-product" value={draft.productId} disabled={busy || catalogLoading || !!catalogError}
                        onChange={(event) => {
                          const price = event.target.value ? predictedPriceText(index, draft) : null;
                          updateDraft(index, { productId: event.target.value, ...(price === null ? {} : { priceText: price }) });
                        }}>
                        <option value="">{t('priceListReview.text_55')}</option>
                        {products.map((product) => (
                          <option key={product.id} value={product.id}>{bidiIsolate(product.name)} · {formatUnit(product.unit, locale)}{product.sku ? ` · ${product.sku}` : ''}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span className="label">{t('priceListReview.text_56')}</span>
                      <input className="input num" inputMode="decimal" maxLength={64} value={draft.priceText} onChange={(event) => updateDraft(index, { priceText: event.target.value })} disabled={busy} />
                    </label>
                  </div>
                  {/* No longer gated on the tick either: creating the catalogue product IS how an
                      unmatched line gets described, so requiring approval first asked for the
                      conclusion before the work. Creating it now also carries the price this row
                      printed into the field, which is what completes the line in one act. */}
                  {newProductFor === index ? (
                      <SubPanel className="mt-3">
                        <div className="grid gap-3 sm:grid-cols-2">
                          <label>
                            <span className="label">{t('priceListReview.text_57')}</span>
                            <input className="input" maxLength={120} value={newProductName} disabled={busyCreate}
                              aria-invalid={createError === t('priceListReview.newProductNameRequired') || undefined}
                              aria-describedby={createError ? createErrorId : undefined}
                              onChange={(event) => setNewProductName(event.target.value)} />
                          </label>
                          <label>
                            <span className="label">{t('priceListReview.text_58')}</span>
                            <input className="input" maxLength={30} value={newProductUnit} onChange={(event) => setNewProductUnit(event.target.value)} disabled={busyCreate} />
                          </label>
                        </div>
                        {createError && <div id={createErrorId}><Note tone="alert" role="alert" className="mt-3">{createError}</Note></div>}
                        <div className="mt-3 flex justify-end gap-2">
                          <button type="button" className="btn-secondary" disabled={busyCreate} onClick={() => { setNewProductFor(null); setCreateError(null); }}>{t('priceListReview.setNewProductFor')}</button>
                          <button type="button" className="btn-primary" disabled={busyCreate} onClick={() => void createProduct(index)}>
                            {busyCreate && <Loader2 className="animate-spin" size={ICON.sm} aria-hidden="true" />}
                            {t('priceListReview.text_59')}
                          </button>
                        </div>
                      </SubPanel>
                    ) : (
                      <button type="button" className="btn-ghost mt-2 text-sm text-action" disabled={busy || busyCreate}
                        onClick={() => { setNewProductFor(index); setNewProductName(guessLineName(item.values)); setNewProductUnit('יח׳'); setCreateError(null); }}>
                        <Plus size={ICON.sm} aria-hidden="true" /> {t('priceListReview.createProductFromLine')}
                      </button>
                    )}
                  <label className="mt-3 flex min-h-11 items-center gap-3 text-sm text-ink-body">
                    <input type="checkbox" className="size-5 shrink-0" checked={draft.available} onChange={(event) => updateDraft(index, { available: event.target.checked })} disabled={busy} />
                    {t('priceListReview.text_60')}
                  </label>
                    </div>
                  )}
              </SubPanel>
            </SubPanel>
          );
        })}
        {pager}
        <div className="flex justify-start">{detailsClose}</div>
      </div>
      )}

      {error && !showControls && <Note tone="alert" role="alert" className="mt-4">{error}</Note>}
      {refreshWarning && <Note tone="alert" role="alert" className="mt-4">{refreshWarning}</Note>}
      {receipt && (
        <div className="mt-4 rounded-lg border border-done-line bg-done-wash p-4" aria-live="polite">
          <h3 className="font-semibold text-ink-body">{t('priceListReview.text_61')}</h3>
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="inline font-medium">שורות שהתקבלו: </dt><dd className="inline num">{receipt.accepted_count}</dd></div>
            <div><dt className="inline font-medium">שורות שנדחו: </dt><dd className="inline num">{receipt.rejected_count}</dd></div>
            <div><dt className="inline font-medium">שורות ללא שינוי: </dt><dd className="inline num">{receipt.unchanged_count}</dd></div>
          </dl>
          <div className="mt-4">
            <Link className="btn-secondary" to={returnPath}>{t('priceListReview.text_69')}</Link>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={revertOpen}
        busy={revertBusy}
        danger
        requireReason
        title={t('priceListReview.title')}
        message={t('priceListReview.message')}
        confirmLabel={t('priceListReview.confirmLabel')}
        onClose={() => setRevertOpen(false)}
        onConfirm={(reason) => void revertAutoIntake(reason ?? '')}
      />
    </section>
  );
}
