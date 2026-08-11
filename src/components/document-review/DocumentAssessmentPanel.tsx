import { useCallback, useEffect, useMemo, useState } from 'react';
import { reasonOr } from '../../lib/reason';
import { AlertTriangle, Check, CircleCheck, Info, Loader2, ShieldAlert } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { toHebrewError } from '../../lib/errors';
import { fmtMoneyExact, fmtNum } from '../../lib/format';
import { Note, useToast } from '../ui';
import {
  advisoryFindings,
  approvalEffects,
  blockingFindings,
  canSubmit,
  findingLabel,
  resolutionLabel,
  reviewedProposal,
  storageAndApprovalSentences,
  type AssessmentFinding,
  type AssessmentLine,
  type DocumentReviewRead,
  type FindingSeverity,
  type ReviewedLineEdit,
} from './assessment';

interface DocumentAssessmentPanelProps {
  documentId: string;
  onApplied?: () => void;
}

const SEVERITY_TONE: Record<FindingSeverity, 'alert' | 'await' | 'info' | 'idle'> = {
  critical: 'alert', error: 'alert', warning: 'await', info: 'info',
};

/**
 * A dash, not a zero.
 *
 * `fmtMoneyExact` and `fmtNum` already print `—` for null, and that is the whole reason they are
 * used here for every number on this screen. A missing baseline price rendered as ₪0.00 is a claim
 * that the supplier agreed to give it away.
 */
function Cell({ children }: { children: React.ReactNode }) {
  return <td className="td num">{children}</td>;
}

function FindingRow({ finding }: { finding: AssessmentFinding }) {
  const Icon = finding.severity === 'warning' ? AlertTriangle
    : finding.severity === 'info' ? Info : ShieldAlert;
  return (
    <li className="flex items-start gap-2 text-sm">
      <Icon size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>
        {findingLabel(finding)}
        {finding.line_index != null && (
          <span className="text-ink-muted"> · שורה <span className="num">{finding.line_index + 1}</span></span>
        )}
      </span>
    </li>
  );
}

export function DocumentAssessmentPanel({ documentId, onApplied }: DocumentAssessmentPanelProps) {
  const [read, setRead] = useState<DocumentReviewRead | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [edits, setEdits] = useState<Record<number, ReviewedLineEdit>>({});
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    const result = await supabase.rpc('get_document_review_assessment', {
      p_document_id: documentId,
    });
    setLoading(false);
    if (result.error) {
      setLoadError(toHebrewError(result.error));
      return;
    }
    setLoadError(null);
    setRead(result.data as DocumentReviewRead);
  }, [documentId]);

  useEffect(() => { void load(); }, [load]);

  const supplierId = read?.assessment?.supplier_id
    ?? read?.supplier_resolution?.supplier_id
    ?? null;
  const orderId = read?.assessment?.order_id ?? null;

  const blocking = useMemo(() => blockingFindings(read?.assessment ?? null), [read]);
  const advisory = useMemo(() => advisoryFindings(read?.assessment ?? null), [read]);
  const effects = useMemo(
    () => approvalEffects(read?.document_type ?? null, Boolean(orderId)),
    [read?.document_type, orderId]);

  /**
   * Every correction is a reason. The server takes one and writes it to the immutable application
   * ledger and to `audit_logs`, so "why did this invoice say ₪240" has an answer months later.
   */
  const submit = useCallback(async () => {
    if (!read || !supplierId || !read.interpretation_id) return;
    setBusy(true);
    const result = await supabase.rpc('apply_reviewed_document', {
      p_document_id: read.document_id,
      p_interpretation_id: read.interpretation_id,
      p_reviewed: reviewedProposal(read, supplierId, orderId, edits),
      // A fresh key per attempt, so a genuine second approval is possible while a retry of THIS
      // attempt — the dropped-connection case 0110 is built for — returns the first result.
      p_idempotency_key: crypto.randomUUID(),
      p_reason: reasonOr(reason, 'אישור מסמך שהתקבל מהספק'),
    });
    setBusy(false);
    if (result.error) {
      toast(toHebrewError(result.error), 'error');
      return;
    }
    toast('המסמך אושר ונרשם', 'success');
    setReason('');
    await load();
    onApplied?.();
  }, [read, supplierId, orderId, edits, reason, toast, load, onApplied]);

  if (loading && !read) return <Note tone="info" role="status">טוען את בדיקת המסמך…</Note>;
  if (loadError) return <Note tone="alert" role="alert">{loadError}</Note>;
  if (!read) return null;

  const [storedSentence, approvedSentence] = storageAndApprovalSentences(read);
  const assessment = read.assessment;
  const editable = !read.data_approved && read.state !== 'awaiting_interpretation';

  return (
    <section className="space-y-5" aria-label="בדיקת מסמך שהתקבל">
      {/* The two states, as two sentences with two icons. Never one word covering both. */}
      <div className="rounded-lg border border-line bg-surface p-4">
        <p className="flex items-start gap-2 text-sm text-ink-body">
          <CircleCheck size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>{storedSentence}</span>
        </p>
        <p className="mt-2 flex items-start gap-2 text-sm text-ink-body">
          {read.data_approved
            ? <CircleCheck size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
            : <Info size={16} aria-hidden="true" className="mt-0.5 shrink-0" />}
          <span>{approvedSentence}</span>
        </p>
      </div>

      {read.state === 'awaiting_interpretation' && (
        <Note tone="info" role="status">
          המסמך נשמר וטרם נקרא. המסך יתעדכן כשתתקבל תוצאת עיבוד.
        </Note>
      )}

      {/* Supplier and order, each with the evidence that decided it. A resolution with no
          explanation is indistinguishable from a guess. */}
      {read.supplier_resolution && (
        <div className="rounded-lg border border-line bg-surface p-4">
          <h3 className="text-sm font-medium text-ink-strong">הספק</h3>
          <p className="mt-1 text-sm text-ink-body">
            {read.supplier_resolution.resolved
              ? `זוהה · ${resolutionLabel(read.supplier_resolution.matched_by)}`
              : read.supplier_resolution.reason === 'ambiguous'
                ? 'יותר ממועמד אחד — נדרשת בחירה'
                : 'לא זוהה מהמסמך'}
          </p>
          {read.supplier_resolution.candidates.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm text-ink-muted">
              {read.supplier_resolution.candidates.map((candidate, index) => (
                <li key={index}>
                  {String(candidate.name ?? candidate.supplier_id ?? '')}
                  {candidate.evidence ? ` — ${candidate.evidence}` : ''}
                  {candidate.authoritative ? '' : ' (הצעה בלבד)'}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {read.order_resolution && (
        <div className="rounded-lg border border-line bg-surface p-4">
          <h3 className="text-sm font-medium text-ink-strong">ההזמנה</h3>
          <p className="mt-1 text-sm text-ink-body">
            {read.order_resolution.resolved
              ? `זוהתה · ${resolutionLabel(read.order_resolution.matched_by)}`
              : read.order_resolution.reason === 'ambiguous'
                ? 'כמה הזמנות אפשריות — נדרשת בחירה'
                /* A document with no order is legitimate, not a failure (0107). */
                : 'לא שויכה הזמנה — מצב לגיטימי'}
          </p>
          {read.order_resolution.candidates.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm text-ink-muted">
              {read.order_resolution.candidates.map((candidate, index) => (
                <li key={index}>
                  הזמנה <span className="num">{String(candidate.number ?? '')}</span>
                  {candidate.evidence ? ` — ${candidate.evidence}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {blocking.length > 0 && (
        <Note tone="alert" role="alert">
          <p className="font-medium">יש לטפל לפני אישור:</p>
          <ul className="mt-2 space-y-1">
            {blocking.map((finding, index) => <FindingRow key={index} finding={finding} />)}
          </ul>
        </Note>
      )}

      {advisory.length > 0 && (
        <Note tone={SEVERITY_TONE[advisory[0].severity]} role="status">
          <p className="font-medium">שווה לשים לב:</p>
          <ul className="mt-2 space-y-1">
            {advisory.map((finding, index) => <FindingRow key={index} finding={finding} />)}
          </ul>
        </Note>
      )}

      {assessment && assessment.lines.length > 0 && (
        <div
          className="max-w-full overflow-x-auto rounded-lg border border-line"
          role="region"
          tabIndex={0}
          aria-label="שורות המסמך מול ההזמנה, הקבלה והמחירון; ניתן לגלול בתוך הטבלה"
        >
          <table className="min-w-full bg-surface">
            <caption className="px-3 pt-2 text-start text-xs font-medium text-ink-soft">
              כל שורה מול ארבעת המקורות. ערך שאינו ידוע מוצג כמקף, לא כאפס.
            </caption>
            <thead>
              <tr className="border-b border-line">
                <th className="th" scope="col">תיאור</th>
                <th className="th" scope="col">כמות במסמך</th>
                <th className="th" scope="col">הוזמן</th>
                <th className="th" scope="col">התקבל</th>
                <th className="th" scope="col">מחיר במסמך</th>
                <th className="th" scope="col">מחיר מוסכם</th>
                <th className="th" scope="col">הפרש</th>
              </tr>
            </thead>
            <tbody>
              {assessment.lines.map((line: AssessmentLine) => {
                const orderItem = assessment.order_items.find(
                  (item) => item.product_id === line.product_id);
                const difference = line.normalized_unit_price != null && line.baseline_price != null
                  ? line.normalized_unit_price - line.baseline_price
                  : null;
                return (
                  <tr key={line.line_index} className="border-b border-line last:border-b-0">
                    <td className="td">
                      {line.description || line.sku || line.barcode || '—'}
                      {line.product_id === null && (
                        <span className="block text-xs text-ink-muted">מוצר לא מזוהה — נדרש מיפוי</span>
                      )}
                    </td>
                    <Cell>{fmtNum(line.quantity)}</Cell>
                    <Cell>{orderItem ? fmtNum(orderItem.ordered_quantity) : '—'}</Cell>
                    <Cell>{orderItem ? fmtNum(orderItem.received_quantity) : '—'}</Cell>
                    <Cell>{fmtMoneyExact(line.unit_price)}</Cell>
                    <Cell>{fmtMoneyExact(line.baseline_price)}</Cell>
                    <Cell>{difference === null ? '—' : fmtMoneyExact(difference)}</Cell>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {assessment && assessment.order_items.some((item) => !item.on_this_document) && (
        <Note tone="idle" role="status">
          <p className="font-medium">הוזמן ואינו מופיע במסמך הזה:</p>
          <ul className="mt-2 space-y-1 text-sm">
            {assessment.order_items.filter((item) => !item.on_this_document).map((item) => (
              <li key={item.purchase_order_item_id}>
                {item.product_name} · הוזמן <span className="num">{fmtNum(item.ordered_quantity)}</span>
              </li>
            ))}
          </ul>
          {/* The server states this as a fact on every such finding; the screen must not quietly
              turn it into a shortage. A supplier bills in instalments. */}
          <p className="mt-2 text-sm">אין בכך טענה שהפריטים חסרים פיזית.</p>
        </Note>
      )}

      {/* What will happen — and, just as importantly, what will not. */}
      <div className="rounded-lg border border-line bg-surface p-4">
        <h3 className="text-sm font-medium text-ink-strong">מה יקרה באישור</h3>
        <ul className="mt-2 space-y-1.5">
          {effects.map((effect, index) => (
            <li key={index} className="flex items-start gap-2 text-sm text-ink-body">
              {effect.happens
                ? <Check size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
                : <span aria-hidden="true" className="mt-0.5 shrink-0 text-ink-muted">✕</span>}
              <span>{effect.text}</span>
            </li>
          ))}
        </ul>
      </div>

      {editable && (
        <div className="rounded-lg border border-line bg-surface p-4">
          <label className="block text-sm font-medium text-ink-strong" htmlFor="review-reason">
            סיבה (רשות — נרשמת ביומן הביקורת ובתיק המסמך)
          </label>
          <textarea
            id="review-reason"
            className="mt-2 min-h-20 w-full rounded-md border border-line bg-surface p-2 text-sm"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={1000}
          />
          <button
            type="button"
            className="btn btn-primary mt-3 min-h-11"
            disabled={busy || !canSubmit(read, supplierId)}
            onClick={() => void submit()}
          >
            {busy && <Loader2 size={16} aria-hidden="true" className="animate-spin" />}
            אישור המסמך
          </button>
          {blocking.length > 0 && (
            /* The button stays live: the server is the gate, and it names what it refused. A
               client-side block would put a second decision-maker in the path and let the two
               drift apart. */
            <p className="mt-2 text-sm text-ink-muted">
              יש ממצאים חוסמים. אפשר לנסות לאשר — השרת יבדוק שוב ויסביר בדיוק מה מונע.
            </p>
          )}
        </div>
      )}

      {/* The edits map is wired for the line editor that lands with the mapping UI; keeping it in
          state here means the proposal builder and its tests already carry the reviewer's
          decisions end to end. */}
      {Object.keys(edits).length > 0 && (
        <p className="text-sm text-ink-muted">
          <span className="num">{Object.keys(edits).length}</span> שורות תוקנו ידנית.
        </p>
      )}
      <button type="button" className="sr-only" onClick={() => setEdits({})}>נקה תיקונים</button>
    </section>
  );
}
