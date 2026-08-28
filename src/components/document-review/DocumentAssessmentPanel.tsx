import { useCallback, useEffect, useMemo, useState } from 'react';
import { reasonOr } from '../../lib/reason';
import { AlertTriangle, Check, CircleCheck, Info, Loader2, ShieldAlert } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { toHebrewError } from '../../lib/errors';
import { fmtMoneyExact, fmtNum } from '../../lib/format';
import { Disclosure, ICON, Note, useToast } from '../ui';
import { PrimaryDecision } from './PrimaryDecision';
import {
  advisoryFindings,
  approvalEffects,
  blockingFindings,
  canSubmit,
  findingLabel,
  formatLineRanges,
  groupFindings,
  resolutionLabel,
  reviewedProposal,
  storageAndApprovalSentences,
  type AssessmentLine,
  type DocumentReviewRead,
  type FindingGroup,
  type FindingSeverity,
  type ReviewedLineEdit,
  INTAKE_CURRENCY,
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
/** Above this many distinct complaints the tail folds; five fits a phone without scrolling. */
const VISIBLE_BLOCKING_GROUPS = 5;

function Cell({ children }: { children: React.ReactNode }) {
  return <td className="td num">{children}</td>;
}

function FindingRow({ group }: { group: FindingGroup }) {
  const { finding, lines } = group;
  const Icon = finding.severity === 'warning' ? AlertTriangle
    : finding.severity === 'info' ? Info : ShieldAlert;
  return (
    <li className="flex items-start gap-2 text-sm">
      <Icon size={ICON.sm} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>
        {findingLabel(finding)}
        {lines.length === 1 && (
          <span className="text-ink-muted"> · שורה <span className="num">{lines[0]}</span></span>
        )}
        {lines.length > 1 && (
          <span className="text-ink-muted">
            {' · '}<span className="num">{lines.length}</span> שורות: <span className="num">{formatLineRanges(lines)}</span>
          </span>
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
  /**
   * The reconciliation table builds its cells only once someone opens it.
   *
   * Seven columns over a 338-line document is ~2,366 cells, and a shut `<details>` still renders
   * every one of them — so the fold has to gate construction, not only visibility. Nothing is lost
   * by folding it: the findings above are what the server concluded FROM these rows, and they stay
   * on the surface. This is the working, not the verdict.
   */
  const [linesOpen, setLinesOpen] = useState(false);
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
  // Grouped, because a document whose every line failed the same check produced 18 identical
  // sentences and buried the two problems that were not identical.
  const blockingGroups = useMemo(() => groupFindings(blocking), [blocking]);
  const advisoryGroups = useMemo(() => groupFindings(advisory), [advisory]);
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
      <div className="card p-4">
        <p className="flex items-start gap-2 text-sm text-ink-body">
          <CircleCheck size={ICON.sm} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>{storedSentence}</span>
        </p>
        <p className="mt-2 flex items-start gap-2 text-sm text-ink-body">
          {read.data_approved
            ? <CircleCheck size={ICON.sm} aria-hidden="true" className="mt-0.5 shrink-0" />
            : <Info size={ICON.sm} aria-hidden="true" className="mt-0.5 shrink-0" />}
          <span>{approvedSentence}</span>
        </p>
      </div>

      {read.state === 'awaiting_interpretation' && (
        <Note tone="info" role="status">
          המסמך נשמר וטרם נקרא. המסך יתעדכן כשתתקבל תוצאת עיבוד.
        </Note>
      )}

      {/* The exceptions, first and open. Nothing folds above this line. */}
      {blocking.length > 0 && (
        <Note tone="alert" role="alert">
          <div className="min-w-0">
            <p className="font-medium">יש לטפל לפני אישור:</p>
            <ul className="mt-2 space-y-1">
              {blockingGroups.slice(0, VISIBLE_BLOCKING_GROUPS).map((group, index) => (
                <FindingRow key={index} group={group} />
              ))}
            </ul>
            {/* Only the tail folds. What is above the fold is still the whole work list when the
                document has the handful of problems a document usually has. */}
            {blockingGroups.length > VISIBLE_BLOCKING_GROUPS && (
              <details className="group mt-2">
                <summary className="min-h-11 cursor-pointer list-none py-2 text-sm font-medium underline underline-offset-4 [&::-webkit-details-marker]:hidden">
                  עוד <span className="num">{blockingGroups.length - VISIBLE_BLOCKING_GROUPS}</span> סוגי חריגה
                </summary>
                <ul className="mt-2 space-y-1">
                  {blockingGroups.slice(VISIBLE_BLOCKING_GROUPS).map((group, index) => (
                    <FindingRow key={index} group={group} />
                  ))}
                </ul>
              </details>
            )}
          </div>
        </Note>
      )}

      {/* Supplier and order, each with the evidence that decided it. A resolution with no
          explanation is indistinguishable from a guess. */}
      {read.supplier_resolution && (
        <div className="card p-4">
          <h3 className="text-sm font-medium text-ink-soft">הספק</h3>
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
        <div className="card p-4">
          <h3 className="text-sm font-medium text-ink-soft">ההזמנה</h3>
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

      {read.document_type === 'credit_note' && read.credit_resolution && (
        <div className="card p-4">
          <h3 className="text-sm font-medium text-ink-soft">חשבונית המקור לזיכוי</h3>
          {read.credit_resolution.resolved ? (
            <dl className="mt-2 space-y-1.5 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-ink-muted">מספר חשבונית</dt>
                <dd><bdi>{read.credit_resolution.reference_invoice_number ?? '—'}</bdi></dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-ink-muted">סכום הזיכוי במסמך</dt>
                <dd className="num font-medium">{fmtMoneyExact(read.credit_resolution.amount, INTAKE_CURRENCY)}</dd>
              </div>
            </dl>
          ) : (
            <p className="mt-2 text-sm text-alert-fg">
              {read.credit_resolution.reason === 'ambiguous'
                ? 'נמצאה יותר מחשבונית מקור אחת. המסמך נשאר לבדיקה עד לבחירה חד־משמעית.'
                : 'לא ניתן לזהות חשבונית מקור אחת. המסמך נשאר לבדיקה ולא יירשם זיכוי.'}
            </p>
          )}
        </div>
      )}

      {/* What will happen — and, just as importantly, what will not. Immediately above the button
          it describes, because that ordering is the whole point of the sentences (DESIGN.md §2). */}
      <div className="card p-4">
        <h3 className="text-sm font-medium text-ink-soft">מה יקרה באישור</h3>
        <ul className="mt-2 space-y-1.5">
          {effects.map((effect, index) => (
            <li key={index} className="flex items-start gap-2 text-sm text-ink-body">
              {effect.happens
                ? <Check size={ICON.sm} aria-hidden="true" className="mt-0.5 shrink-0" />
                : <span aria-hidden="true" className="mt-0.5 shrink-0 text-ink-muted">✕</span>}
              <span>{effect.text}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* The decision, above the folded evidence rather than below it. The reconciliation table
          used to stand between the findings and this button — 2,366 cells of scrolling before the
          one control on the screen, on a phone. Folding it and leaving the button here is the
          same information in the order a decision is actually made. */}
      {editable && (
        <div className="card p-4">
          <label className="block text-sm font-medium text-ink-soft" htmlFor="review-reason">
            סיבה (רשות — נרשמת ביומן הביקורת ובתיק המסמך)
          </label>
          <textarea
            id="review-reason"
            className="mt-2 min-h-20 w-full rounded-md border border-line bg-surface p-2 text-sm"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={1000}
          />
          {/* The button stays exactly where it was written, at every width: between "מה יקרה
              באישור" and the folded working. The blocking sentence is passed as the button's hint
              rather than left here, so it is read before the press and not five screens up. */}
          <PrimaryDecision
            className="mt-3"
            label="אישור המסמך שהתקבל"
            hint={blocking.length > 0
              /* The button stays live: the server is the gate, and it names what it refused. A
                 client-side block would put a second decision-maker in the path and let the two
                 drift apart. */
              ? 'יש ממצאים חוסמים. אפשר לנסות לאשר — השרת יבדוק שוב ויסביר בדיוק מה מונע.'
              : null}
          >
            <button
              type="button"
              className="btn btn-primary min-h-11"
              disabled={busy || !canSubmit(read, supplierId)}
              onClick={() => void submit()}
            >
              {busy && <Loader2 size={ICON.sm} aria-hidden="true" className="animate-spin" />}
              אישור המסמך
            </button>
          </PrimaryDecision>
        </div>
      )}

      {/* Below the decision: what the machine checked and settled. Folded, counted, one click
          away — never deleted, and never a finding. */}
      {(advisory.length > 0 || (assessment && assessment.lines.length > 0)) && (
        <div className="overflow-hidden card" data-testid="assessment-detail">
          {advisory.length > 0 && (
            <Disclosure
              title="שווה לשים לב"
              count={advisoryGroups.length}
              tone={SEVERITY_TONE[advisory.some((finding) => finding.severity === 'warning') ? 'warning' : 'info']}
            >
              <ul className="space-y-1">
                {advisoryGroups.map((group, index) => <FindingRow key={index} group={group} />)}
              </ul>
            </Disclosure>
          )}

          {assessment && assessment.lines.length > 0 && (
            <Disclosure
              className={advisory.length > 0 ? 'border-t border-line-soft' : ''}
              title="שורות מול המקורות"
              count={assessment.lines.length}
              onToggle={setLinesOpen}
            >
              {linesOpen && (
                <div
                  className="table-scroll overflow-x-auto rounded-lg border border-line"
                  role="region"
                  tabIndex={0}
                  aria-label="שורות המסמך מול ההזמנה, הקבלה והמחירון; ניתן לגלול בתוך הטבלה"
                >
                  <table className="min-w-full bg-surface">
                    <caption className="px-3 pt-2 text-start text-xs font-medium text-ink-soft">
                      כל שורה מול ארבעת המקורות. ערך שאינו ידוע מוצג כמקף, לא כאפס.
                    </caption>
                    <thead className="table-head">
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
                            <Cell>{fmtMoneyExact(line.unit_price, INTAKE_CURRENCY)}</Cell>
                            <Cell>{fmtMoneyExact(line.baseline_price, INTAKE_CURRENCY)}</Cell>
                            <Cell>{difference === null ? '—' : fmtMoneyExact(difference, INTAKE_CURRENCY)}</Cell>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Disclosure>
          )}
        </div>
      )}

      {/* Stays open: it names ordered goods this document does not account for, and that is an
          inventory statement, not detail. */}
      {assessment && assessment.order_items.some((item) => !item.on_this_document) && (
        <Note tone="idle" role="status">
          <div className="min-w-0">
            <p className="font-medium">הוזמן ואינו מופיע במסמך הזה:</p>
            <ul className="mt-2 space-y-1 text-sm">
              {assessment.order_items.filter((item) => !item.on_this_document).map((item) => (
                <li key={item.purchase_order_item_id}>
                  <bdi>{item.product_name}</bdi> · הוזמן <span className="num">{fmtNum(item.ordered_quantity)}</span>
                </li>
              ))}
            </ul>
            {/* The server states this as a fact on every such finding; the screen must not quietly
                turn it into a shortage. A supplier bills in instalments. */}
            <p className="mt-2 text-sm">אין בכך טענה שהפריטים חסרים פיזית.</p>
          </div>
        </Note>
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
