import { useT } from '../../lib/i18n/LocaleProvider';
import type { TKey } from '../../lib/i18n/t';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { useAuth } from '../../auth/AuthContext';
import { fmtMoneyExact } from '../../lib/format';
import { supabase } from '../../lib/supabase';
import { ICON, Note } from '../ui';

interface CalibrationPreparationRow {
  shadow_run_id: string;
  shadow_line_id: string;
  document_id: string;
  file_name: string;
  supplier_id: string | null;
  supplier_name: string | null;
  line_index: number;
  source_row: number | null;
  predicted_action: string;
  reason_code: string | null;
  product_id: string | null;
  matched_product_name: string | null;
  sku: string | null;
  barcode: string | null;
  product_name: string | null;
  unit: string | null;
  proposed_unit_price: number | null;
  current_unit_price: number | null;
  preparation_id: string | null;
  prepared_by: string | null;
  prepared_role: 'owner' | 'office' | null;
  preparation_created_at: string | null;
  /** Lines covered by the newest preparation of this run — the run's number, not this page's. */
  preparation_line_count: number | null;
  /** Rows still awaiting review for this document, counted before OFFSET/LIMIT. */
  pending_total_count: number;
}

interface QualifiedProductRow {
  source_row: number | null;
  sku: string | null;
  barcode: string | null;
  product_name: string | null;
  unit_price: number | null;
  outcome: 'qualified_create' | 'existing_product' | 'ambiguous_input' | 'ambiguous_catalog'
    | 'missing_qualification' | 'invalid_price';
}

interface QualifiedProductDryRun {
  interpretation_id: string;
  supplier_id: string;
  qualified_create_count: number;
  existing_product_count: number;
  ambiguous_count: number;
  missing_qualification_count: number;
  invalid_price_count: number;
  rows: QualifiedProductRow[];
  mutated: boolean;
}

interface PreparationReceipt {
  preparation_id: string;
  line_count: number;
  idempotent: boolean;
}

interface ReviewReceipt {
  preparation_id: string;
  reviewed_count: number;
  idempotent: boolean;
}

/**
 * The whole document, walked. A live price list is 338 lines (DEBT-REGISTER §42) and a batch may
 * only be approved once every one of its lines has been rendered, so the screen pages the queue to
 * the end instead of reading one window and calling it the answer.
 */
const QUEUE_PAGE_SIZE = 200;
/** Above this the screen refuses to claim a count rather than paging forever. */
const QUEUE_MAX_ROWS = 2000;

interface CalibrationQueue {
  rows: CalibrationPreparationRow[];
  /** What the server says is outstanding for this document. */
  total: number;
  /** True when `rows` is not the whole of `total` — then no count is honest and nothing is actionable. */
  truncated: boolean;
}

async function loadCalibrationQueue(documentId: string): Promise<CalibrationQueue> {
  const rows: CalibrationPreparationRow[] = [];
  let total = 0;
  for (let offset = 0; ; offset += QUEUE_PAGE_SIZE) {
    const response = await supabase.rpc('get_price_list_calibration_preparation_queue', {
      p_document_id: documentId,
      p_limit: QUEUE_PAGE_SIZE,
      p_offset: offset,
    });
    if (response.error) throw new Error(response.error.message);
    const page = (response.data ?? []) as CalibrationPreparationRow[];
    if (page.length > 0) total = Number(page[0].pending_total_count);
    rows.push(...page);
    if (page.length < QUEUE_PAGE_SIZE) break;
    if (rows.length >= QUEUE_MAX_ROWS) return { rows, total, truncated: true };
  }
  // Rows can also move under a walk that spans several requests; fewer rows than the server
  // counted is the same problem as a hard truncation and gets the same answer.
  return { rows, total, truncated: rows.length !== total };
}

const sampleLabel = (row: QualifiedProductRow, t: (key: TKey) => string) => row.product_name?.trim()
  || row.sku?.trim()
  || row.barcode?.trim()
  || t('priceListReadiness.unnamedRow');

function stableKey(keys: Map<string, string>, identity: string) {
  const existing = keys.get(identity);
  if (existing) return existing;
  const created = crypto.randomUUID();
  keys.set(identity, created);
  return created;
}

export function PriceListAutomationReadiness({ documentId, interpretationId, ingested }: {
  documentId: string;
  interpretationId: string;
  /** The document's price list has already been taken in; preparation and qualification are closed. */
  ingested: boolean;
}) {
  const { t, errorText } = useT();
  const { profile } = useAuth();
  const allowed = profile?.role === 'owner' || profile?.role === 'office';
  const [queue, setQueue] = useState<CalibrationQueue | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState<QualifiedProductDryRun | null>(null);
  const [dryRunError, setDryRunError] = useState<string | null>(null);
  const [prepareReasons, setPrepareReasons] = useState<Record<string, string>>({});
  const [reviewReasons, setReviewReasons] = useState<Record<string, string>>({});
  const [prepared, setPrepared] = useState<Record<string, PreparationReceipt>>({});
  const [reviewed, setReviewed] = useState<Record<string, ReviewReceipt>>({});
  const [actionError, setActionError] = useState<Record<string, string>>({});
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const preparationKeys = useRef(new Map<string, string>());
  const reviewKeys = useRef(new Map<string, string>());

  useEffect(() => {
    if (!allowed || ingested) return;
    let cancelled = false;
    setQueue(null);
    setQueueError(null);
    setDryRun(null);
    setDryRunError(null);
    void Promise.allSettled([
      loadCalibrationQueue(documentId),
      supabase.rpc('get_qualified_product_creation_dry_run', { p_interpretation_id: interpretationId }),
    ]).then(([queueResult, dryRunResult]) => {
      if (cancelled) return;
      if (queueResult.status === 'rejected') setQueueError(errorText(queueResult.reason));
      else setQueue(queueResult.value);
      if (dryRunResult.status === 'rejected') {
        setDryRunError(t('priceListReadiness.dryRunFailed', { error: errorText(dryRunResult.reason) }));
        return;
      }
      if (dryRunResult.value.error) {
        setDryRunError(t('priceListReadiness.dryRunFailed', { error: errorText(dryRunResult.value.error.message) }));
        return;
      }
      const result = dryRunResult.value.data as QualifiedProductDryRun;
      if (!result || result.interpretation_id !== interpretationId || result.mutated !== false) {
        setDryRunError(t('priceListReadiness.setDryRunError'));
      } else setDryRun(result);
    });
    return () => { cancelled = true; };
  }, [allowed, documentId, ingested, interpretationId]);

  const groups = useMemo(() => {
    const grouped = new Map<string, CalibrationPreparationRow[]>();
    for (const row of queue?.rows ?? []) {
      grouped.set(row.shadow_run_id, [...(grouped.get(row.shadow_run_id) ?? []), row]);
    }
    return [...grouped.entries()].map(([shadowRunId, rows]) => ({
      shadowRunId,
      rows: rows.sort((left, right) => left.line_index - right.line_index),
      // The server's own count of the preparation, never the length of what this page happened to
      // fetch — a receipt derived from the rows on screen can never contradict the rows on screen.
      serverPreparation: rows[0]?.preparation_id && rows[0].preparation_line_count != null ? {
        preparation_id: rows[0].preparation_id,
        line_count: rows[0].preparation_line_count,
        idempotent: true,
      } satisfies PreparationReceipt : null,
      preparedRole: rows[0]?.prepared_role ?? null,
    }));
  }, [queue]);

  if (!allowed) return null;

  if (ingested) {
    return (
      <div className="mt-5 border-t border-line pt-5">
        <Note tone="idle">
          <span className="min-w-0 flex-1">
            {t('priceListReadiness.text')}
          </span>
        </Note>
      </div>
    );
  }

  async function prepareBatch(shadowRunId: string, rows: CalibrationPreparationRow[]) {
    const reason = (prepareReasons[shadowRunId] ?? '').trim();
    if (!reason) {
      setActionError((current) => ({ ...current, [shadowRunId]: t('priceListReadiness.setActionError') }));
      return;
    }
    setBusyAction(`prepare:${shadowRunId}`);
    setActionError((current) => ({ ...current, [shadowRunId]: '' }));
    const response = await supabase.rpc('prepare_price_list_calibration_batch', {
      p_shadow_run_id: shadowRunId,
      p_line_ids: rows.map((row) => row.shadow_line_id),
      p_idempotency_key: stableKey(preparationKeys.current, shadowRunId),
      p_reason: reason,
    });
    setBusyAction(null);
    if (response.error) {
      setActionError((current) => ({ ...current, [shadowRunId]: errorText(response.error.message) }));
      return;
    }
    setPrepared((current) => ({ ...current, [shadowRunId]: response.data as PreparationReceipt }));
  }

  async function reviewBatch(shadowRunId: string, receipt: PreparationReceipt) {
    const reason = (reviewReasons[shadowRunId] ?? '').trim();
    if (!reason) {
      setActionError((current) => ({ ...current, [shadowRunId]: t('priceListReadiness.setActionError_2') }));
      return;
    }
    setBusyAction(`review:${shadowRunId}`);
    setActionError((current) => ({ ...current, [shadowRunId]: '' }));
    const response = await supabase.rpc('record_price_list_calibration_batch', {
      p_preparation_id: receipt.preparation_id,
      p_idempotency_key: stableKey(reviewKeys.current, receipt.preparation_id),
      p_reason: reason,
    });
    setBusyAction(null);
    if (response.error) {
      setActionError((current) => ({ ...current, [shadowRunId]: errorText(response.error.message) }));
      return;
    }
    setReviewed((current) => ({ ...current, [shadowRunId]: response.data as ReviewReceipt }));
  }

  const qualifiedSamples = dryRun?.rows.filter((row) => row.outcome === 'qualified_create').slice(0, 5) ?? [];
  const truncated = queue?.truncated ?? false;

  return (
    <div className="mt-5 space-y-4 border-t border-line pt-5">
      <section className="space-y-3" aria-labelledby="qualified-product-dry-run-title">
        <div>
          <h3 id="qualified-product-dry-run-title" className="text-base font-semibold text-ink">
            {t('priceListReadiness.text_2')}
          </h3>
          <p className="mt-1 text-sm text-ink-muted">
            {t('priceListReadiness.text_3')}
          </p>
        </div>
        {!dryRun && !dryRunError && <p className="text-sm text-ink-muted" role="status">{t('priceListReadiness.text_4')}</p>}
        {dryRunError && <Note tone="alert" role="alert">{dryRunError}</Note>}
        {dryRun && (
          <>
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {[
                [t('priceListReadiness.text_5'), dryRun.qualified_create_count],
                [t('priceListReadiness.text_6'), dryRun.existing_product_count],
                [t('priceListReadiness.text_7'), dryRun.ambiguous_count],
                [t('priceListReadiness.text_8'), dryRun.missing_qualification_count],
                [t('priceListReadiness.text_9'), dryRun.invalid_price_count],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-lg bg-surface-sunken p-3">
                  <dt className="text-xs text-ink-muted">{label}</dt>
                  <dd className="num mt-1 font-semibold text-ink">{value}</dd>
                </div>
              ))}
            </dl>
            {qualifiedSamples.length > 0 && (
              <div>
                <p className="text-sm font-medium text-ink-soft">{t('priceListReadiness.text_10')}</p>
                <ul className="mt-2 space-y-2">
                  {qualifiedSamples.map((row, index) => (
                    <li key={`${row.source_row ?? index}-${row.sku ?? row.barcode ?? index}`}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-sunken p-3 text-sm">
                      <span className="min-w-0 break-words"><bdi>{sampleLabel(row, t)}</bdi></span>
                      <span className="text-ink-muted">
                        {row.source_row != null && <>{t('priceListReadiness.text_11')} <span className="num">{row.source_row}</span> · </>}
                        <span dir="ltr">{row.sku ?? row.barcode ?? '—'}</span> · {fmtMoneyExact(row.unit_price)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </section>

      <section className="space-y-3" aria-labelledby="calibration-batch-title">
        <div>
          <h3 id="calibration-batch-title" className="text-base font-semibold text-ink">{t('priceListReadiness.text_12')}</h3>
          <p className="mt-1 text-sm text-ink-muted">
            {t('priceListReadiness.text_13')}
          </p>
        </div>
        {!queue && !queueError && <p className="text-sm text-ink-muted" role="status">{t('priceListReadiness.text_14')}</p>}
        {queueError && <Note tone="alert" role="alert">{queueError}</Note>}
        {truncated && (
          <Note tone="alert" role="alert">
            <span className="min-w-0 flex-1">
              {t('priceListReadiness.text_15')}{' '}
              {t('priceListReadiness.text_16')}
            </span>
          </Note>
        )}
        {queue && !truncated && groups.length === 0 && (
          <Note tone="idle">{t('priceListReadiness.text_17')}</Note>
        )}
        {groups.map(({ shadowRunId, rows, serverPreparation, preparedRole }) => {
          const receipt = prepared[shadowRunId] ?? serverPreparation;
          const reviewReceipt = reviewed[shadowRunId];
          const preparing = busyAction === `prepare:${shadowRunId}`;
          const reviewing = busyAction === `review:${shadowRunId}`;
          // Every line of the batch is on screen. Approving „כולן נכונות" over rows the reviewer
          // never saw is the one thing #248 does not permit, so the count the server recorded for
          // the preparation and the count actually rendered here have to be the same number.
          const batchFullyShown = receipt != null && !truncated && receipt.line_count === rows.length;
          return (
            <div key={shadowRunId} className="card p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-ink" data-testid="calibration-row-count">
                  <span className="num">{truncated ? '—' : rows.length}</span> {t('priceListReadiness.rowsReady')}
                </p>
                <span className={reviewReceipt ? 'badge-done' : receipt ? 'badge-info' : 'badge-await'}>
                  {reviewReceipt ? t('priceListReadiness.text_18') : receipt ? t('priceListReadiness.text_19') : t('priceListReadiness.text_20')}
                </span>
              </div>
              <div className="max-h-96 overflow-y-auto rounded-lg bg-surface-sunken p-2"
                tabIndex={0} role="region" aria-label={t('priceListReadiness.aria_label')}>
                <ul className="space-y-1 text-sm text-ink-soft">
                  {rows.map((row) => (
                    <li key={row.shadow_line_id} data-testid="calibration-preparation-row"
                      className="flex flex-wrap justify-between gap-2">
                      <span><bdi>{row.product_name ?? row.matched_product_name ?? t('priceListReadiness.unnamedRow')}</bdi></span>
                      <span className="text-ink-muted">{t('priceListReadiness.fmtMoneyExact')} <span className="num">{row.source_row ?? row.line_index + 1}</span> · {fmtMoneyExact(row.proposed_unit_price)}</span>
                    </li>
                  ))}
                </ul>
              </div>
              {!receipt && (
                <div className="space-y-2">
                  <label className="label" htmlFor={`calibration-prepare-reason-${shadowRunId}`}>{t('priceListReadiness.prepareReasonLabel')}</label>
                  <textarea id={`calibration-prepare-reason-${shadowRunId}`} className="input" rows={2} maxLength={1000}
                    value={prepareReasons[shadowRunId] ?? ''}
                    onChange={(event) => setPrepareReasons((current) => ({ ...current, [shadowRunId]: event.target.value }))} />
                  <button type="button" className="btn-secondary" disabled={preparing || truncated}
                    onClick={() => void prepareBatch(shadowRunId, rows)}>
                      {preparing && <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" />}
                    {t('priceListReadiness.text_22')}
                  </button>
                </div>
              )}
              {receipt && profile?.role === 'office' && !reviewReceipt && (
                <Note tone="done" role="status">{t('priceListReadiness.text_23')}</Note>
              )}
              {receipt && preparedRole === 'office' && profile?.role === 'owner' && !reviewReceipt && (
                <Note tone="idle">{t('priceListReadiness.text_24')}</Note>
              )}
              {receipt && profile?.role === 'owner' && !reviewReceipt && !batchFullyShown && (
                <Note tone="alert" role="alert">
                  <span className="min-w-0 flex-1">
                    {t('priceListReadiness.batchCoverageMismatch', {
                      prepared: receipt.line_count,
                      shown: truncated ? '—' : rows.length,
                    })}
                  </span>
                </Note>
              )}
              {receipt && profile?.role === 'owner' && !reviewReceipt && batchFullyShown && (
                <div className="space-y-2">
                  <label className="label" htmlFor={`calibration-review-reason-${shadowRunId}`}>{t('priceListReadiness.reviewReasonLabel')}</label>
                  <textarea id={`calibration-review-reason-${shadowRunId}`} className="input" rows={2} maxLength={1000}
                    value={reviewReasons[shadowRunId] ?? ''}
                    onChange={(event) => setReviewReasons((current) => ({ ...current, [shadowRunId]: event.target.value }))} />
                  <button type="button" className="btn-primary" disabled={reviewing}
                    onClick={() => void reviewBatch(shadowRunId, receipt)}>
                    {reviewing
                    ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" />
                      : <CheckCircle2 size={ICON.sm} aria-hidden="true" />}
                    {t('priceListReadiness.text_26')}
                  </button>
                </div>
              )}
              {reviewReceipt && <Note tone="done" role="status">{t('priceListReadiness.text_27')}</Note>}
              {actionError[shadowRunId] && <Note tone="alert" role="alert">{actionError[shadowRunId]}</Note>}
            </div>
          );
        })}
      </section>
    </div>
  );
}
