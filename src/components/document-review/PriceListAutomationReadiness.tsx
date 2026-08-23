import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { useAuth } from '../../auth/AuthContext';
import { fmtMoneyExact } from '../../lib/format';
import { toHebrewError } from '../../lib/errors';
import { supabase } from '../../lib/supabase';
import { Note } from '../ui';

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
  already_reviewed: boolean;
  preparation_id: string | null;
  prepared_by: string | null;
  prepared_role: 'owner' | 'office' | null;
  preparation_created_at: string | null;
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

const sampleLabel = (row: QualifiedProductRow) => row.product_name?.trim()
  || row.sku?.trim()
  || row.barcode?.trim()
  || 'שורה ללא שם';

function stableKey(keys: Map<string, string>, identity: string) {
  const existing = keys.get(identity);
  if (existing) return existing;
  const created = crypto.randomUUID();
  keys.set(identity, created);
  return created;
}

export function PriceListAutomationReadiness({ documentId, interpretationId }: {
  documentId: string;
  interpretationId: string;
}) {
  const { profile } = useAuth();
  const allowed = profile?.role === 'owner' || profile?.role === 'office';
  const [queue, setQueue] = useState<CalibrationPreparationRow[] | null>(null);
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
    if (!allowed) return;
    let cancelled = false;
    setQueue(null);
    setQueueError(null);
    setDryRun(null);
    setDryRunError(null);
    void Promise.all([
      supabase.rpc('get_price_list_calibration_preparation_queue', { p_limit: 50 }),
      supabase.rpc('get_qualified_product_creation_dry_run', { p_interpretation_id: interpretationId }),
    ]).then(([queueResult, dryRunResult]) => {
      if (cancelled) return;
      if (queueResult.error) setQueueError(toHebrewError(queueResult.error.message));
      else setQueue(((queueResult.data ?? []) as CalibrationPreparationRow[])
        .filter((row) => row.document_id === documentId && !row.already_reviewed));
      if (dryRunResult.error) setDryRunError(`בדיקת הכשירות נכשלה: ${toHebrewError(dryRunResult.error.message)}`);
      else {
        const result = dryRunResult.data as QualifiedProductDryRun;
        if (!result || result.interpretation_id !== interpretationId || result.mutated !== false) {
          setDryRunError('בדיקת הכשירות לא החזירה תוצאת dry-run תקינה.');
        } else setDryRun(result);
      }
    }).catch((error) => {
      if (cancelled) return;
      const message = toHebrewError(error);
      setQueueError(message);
      setDryRunError(`בדיקת הכשירות נכשלה: ${message}`);
    });
    return () => { cancelled = true; };
  }, [allowed, documentId, interpretationId]);

  const groups = useMemo(() => {
    const grouped = new Map<string, CalibrationPreparationRow[]>();
    for (const row of queue ?? []) {
      grouped.set(row.shadow_run_id, [...(grouped.get(row.shadow_run_id) ?? []), row]);
    }
    return [...grouped.entries()].map(([shadowRunId, rows]) => ({
      shadowRunId,
      rows: rows.sort((left, right) => left.line_index - right.line_index),
      serverPreparation: rows[0]?.preparation_id ? {
        preparation_id: rows[0].preparation_id,
        line_count: rows.length,
        idempotent: true,
      } satisfies PreparationReceipt : null,
      preparedRole: rows[0]?.prepared_role ?? null,
    }));
  }, [queue]);

  if (!allowed) return null;

  async function prepareBatch(shadowRunId: string, rows: CalibrationPreparationRow[]) {
    const reason = (prepareReasons[shadowRunId] ?? '').trim();
    if (!reason) {
      setActionError((current) => ({ ...current, [shadowRunId]: 'יש לציין סיבה להכנת האצווה.' }));
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
      setActionError((current) => ({ ...current, [shadowRunId]: toHebrewError(response.error.message) }));
      return;
    }
    setPrepared((current) => ({ ...current, [shadowRunId]: response.data as PreparationReceipt }));
  }

  async function reviewBatch(shadowRunId: string, receipt: PreparationReceipt) {
    const reason = (reviewReasons[shadowRunId] ?? '').trim();
    if (!reason) {
      setActionError((current) => ({ ...current, [shadowRunId]: 'יש לציין סיבה לאישור האצווה.' }));
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
      setActionError((current) => ({ ...current, [shadowRunId]: toHebrewError(response.error.message) }));
      return;
    }
    setReviewed((current) => ({ ...current, [shadowRunId]: response.data as ReviewReceipt }));
  }

  const qualifiedSamples = dryRun?.rows.filter((row) => row.outcome === 'qualified_create').slice(0, 5) ?? [];

  return (
    <div className="mt-5 space-y-4 border-t border-line pt-5">
      <section className="space-y-3" aria-labelledby="qualified-product-dry-run-title">
        <div>
          <h3 id="qualified-product-dry-run-title" className="text-base font-semibold text-ink">
            בדיקת כשירות לאוטומציית מוצרים
          </h3>
          <p className="mt-1 text-sm text-ink-muted">
            dry-run בלבד. הספירות והדוגמאות אינן יוצרות מוצר ואינן מפעילות אוטומציה.
          </p>
        </div>
        {!dryRun && !dryRunError && <p className="text-sm text-ink-muted" role="status">טוען בדיקת כשירות…</p>}
        {dryRunError && <Note tone="alert" role="alert">{dryRunError}</Note>}
        {dryRun && (
          <>
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {[
                ['מוכנים ליצירה', dryRun.qualified_create_count],
                ['מוצרים קיימים', dryRun.existing_product_count],
                ['עמימות', dryRun.ambiguous_count],
                ['חסרה כשירות', dryRun.missing_qualification_count],
                ['מחיר לא תקין', dryRun.invalid_price_count],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-lg bg-surface-sunken p-3">
                  <dt className="text-xs text-ink-muted">{label}</dt>
                  <dd className="num mt-1 font-semibold text-ink">{value}</dd>
                </div>
              ))}
            </dl>
            {qualifiedSamples.length > 0 && (
              <div>
                <p className="text-sm font-medium text-ink-soft">דוגמאות מתוך המועמדים</p>
                <ul className="mt-2 space-y-2">
                  {qualifiedSamples.map((row, index) => (
                    <li key={`${row.source_row ?? index}-${row.sku ?? row.barcode ?? index}`}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-sunken p-3 text-sm">
                      <span className="min-w-0 break-words"><bdi>{sampleLabel(row)}</bdi></span>
                      <span className="text-ink-muted">
                        {row.source_row != null && <>שורה <span className="num">{row.source_row}</span> · </>}
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
          <h3 id="calibration-batch-title" className="text-base font-semibold text-ink">כיול מחירון באצווה</h3>
          <p className="mt-1 text-sm text-ink-muted">
            מנהל המשרד מכין בלבד. בעלים בודק ומאשר שהשורות המוכנות נכונות. הפעלת Platform אינה זמינה כאן.
          </p>
        </div>
        {!queue && !queueError && <p className="text-sm text-ink-muted" role="status">טוען שורות כיול…</p>}
        {queueError && <Note tone="alert" role="alert">{queueError}</Note>}
        {queue && groups.length === 0 && (
          <Note tone="idle">אין שורות כיול שממתינות להכנה במסמך הזה.</Note>
        )}
        {groups.map(({ shadowRunId, rows, serverPreparation, preparedRole }) => {
          const receipt = prepared[shadowRunId] ?? serverPreparation;
          const reviewReceipt = reviewed[shadowRunId];
          const preparing = busyAction === `prepare:${shadowRunId}`;
          const reviewing = busyAction === `review:${shadowRunId}`;
          return (
            <div key={shadowRunId} className="rounded-lg border border-line bg-surface p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-ink"><span className="num">{rows.length}</span> שורות מוכנות לבדיקה</p>
                <span className={reviewReceipt ? 'badge-done' : receipt ? 'badge-info' : 'badge-await'}>
                  {reviewReceipt ? 'האצווה אושרה' : receipt ? 'הוכנה לבעלים' : 'טרם הוכנה'}
                </span>
              </div>
              <ul className="space-y-1 text-sm text-ink-soft">
                {rows.slice(0, 5).map((row) => (
                  <li key={row.shadow_line_id} className="flex flex-wrap justify-between gap-2">
                    <span><bdi>{row.product_name ?? row.matched_product_name ?? 'שורה ללא שם'}</bdi></span>
                    <span className="text-ink-muted">שורה <span className="num">{row.source_row ?? row.line_index + 1}</span> · {fmtMoneyExact(row.proposed_unit_price)}</span>
                  </li>
                ))}
              </ul>
              {!receipt && (
                <div className="space-y-2">
                  <label className="label" htmlFor={`calibration-prepare-reason-${shadowRunId}`}>סיבת הכנת האצווה</label>
                  <textarea id={`calibration-prepare-reason-${shadowRunId}`} className="input" rows={2} maxLength={1000}
                    value={prepareReasons[shadowRunId] ?? ''}
                    onChange={(event) => setPrepareReasons((current) => ({ ...current, [shadowRunId]: event.target.value }))} />
                  <button type="button" className="btn-secondary" disabled={preparing}
                    onClick={() => void prepareBatch(shadowRunId, rows)}>
                    {preparing && <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                    הכנת האצווה לבדיקת בעלים
                  </button>
                </div>
              )}
              {receipt && profile?.role === 'office' && !reviewReceipt && (
                <Note tone="done" role="status">האצווה הוכנה לבדיקת בעלים.</Note>
              )}
              {receipt && preparedRole === 'office' && profile?.role === 'owner' && !reviewReceipt && (
                <Note tone="idle">האצווה הוכנה על ידי מנהל המשרד.</Note>
              )}
              {receipt && profile?.role === 'owner' && !reviewReceipt && (
                <div className="space-y-2">
                  <label className="label" htmlFor={`calibration-review-reason-${shadowRunId}`}>סיבת אישור האצווה</label>
                  <textarea id={`calibration-review-reason-${shadowRunId}`} className="input" rows={2} maxLength={1000}
                    value={reviewReasons[shadowRunId] ?? ''}
                    onChange={(event) => setReviewReasons((current) => ({ ...current, [shadowRunId]: event.target.value }))} />
                  <button type="button" className="btn-primary" disabled={reviewing}
                    onClick={() => void reviewBatch(shadowRunId, receipt)}>
                    {reviewing
                      ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      : <CheckCircle2 size={16} aria-hidden="true" />}
                    אישור האצווה כמסומנת נכונה
                  </button>
                </div>
              )}
              {reviewReceipt && <Note tone="done" role="status">כל שורות האצווה אושרו ונרשמו.</Note>}
              {actionError[shadowRunId] && <Note tone="alert" role="alert">{actionError[shadowRunId]}</Note>}
            </div>
          );
        })}
      </section>
    </div>
  );
}
