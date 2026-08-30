import { useT } from '../../lib/i18n/LocaleProvider';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { reasonOr } from '../../lib/reason';
import { todayISO } from '../../lib/format';
import { AlertTriangle, Check, CircleCheck, Info, Loader2, ShieldAlert } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { fmtMoneyExact, fmtNum } from '../../lib/format';
import { Disclosure, ICON, Note, useToast } from '../ui';
import { DocumentLineMapping } from './DocumentLineMapping';
import { PrimaryDecision } from './PrimaryDecision';
import {
  advisoryFindings,
  approvalEffects,
  blockingFindings,
  canSubmit,
  findingText,
  formatLineRanges,
  groupFindings,
  priceSeedRows,
  resolutionText,
  reviewedProposal,
  storageAndApprovalKeys,
  type AssessmentLine,
  type DocumentReviewRead,
  type FindingGroup,
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
/** Above this many distinct complaints the tail folds; five fits a phone without scrolling. */
const VISIBLE_BLOCKING_GROUPS = 5;

function Cell({ children }: { children: React.ReactNode }) {
  return <td className="td num">{children}</td>;
}

function FindingRow({ group }: { group: FindingGroup }) {
  const { t } = useT();
  const { finding, lines } = group;
  const Icon = finding.severity === 'warning' ? AlertTriangle
    : finding.severity === 'info' ? Info : ShieldAlert;
  return (
    <li className="flex items-start gap-2 text-sm">
      <Icon size={ICON.sm} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>
        {findingText(finding, t)}
        {lines.length === 1 && (
          <span className="text-ink-muted"> {t('docAssessment.text')} <span className="num">{lines[0]}</span></span>
        )}
        {lines.length > 1 && (
          <span className="text-ink-muted">
            {' · '}<span className="num">{lines.length}</span> {t('docAssessment.formatLineRanges')} <span className="num">{formatLineRanges(lines)}</span>
          </span>
        )}
      </span>
    </li>
  );
}

export function DocumentAssessmentPanel({ documentId, onApplied }: DocumentAssessmentPanelProps) {
  const { errorText, t } = useT();
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
  /**
   * Write the document's prices into the supplier's price list — but only where there is no agreed
   * price yet (owner, 28.08.2026: "המחירים והמוצרים יתעדכנו בהעלאת חשבונית של הספק, כי לא תמיד יש
   * מחירון של ספק").
   *
   * SEEDING, NEVER OVERWRITING, and the distinction is the whole safety of it. `baseline_price` is
   * what every price finding on this screen compares the document against; letting an invoice
   * rewrite an EXISTING baseline would make each invoice agree with itself and quietly retire
   * "מחיר מעל המחיר המוסכם" as a check. A line with no baseline has no such check to lose — the
   * server already reports it as `price_baseline_unknown` — so filling it in only adds a
   * comparison the business did not have before.
   */
  const [seedPrices, setSeedPrices] = useState(true);
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    const result = await supabase.rpc('get_document_review_assessment', {
      p_document_id: documentId,
    });
    setLoading(false);
    if (result.error) {
      setLoadError(errorText(result.error));
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

  /** The lines the server could not attach to a product. Membership is fixed by the server's own
   *  answer, so a line does not leave the list the moment it is mapped — the list is the work, and
   *  a row vanishing under the cursor is how a person loses their place in it. */
  const unmatchedLines = useMemo(
    () => (read?.assessment?.lines ?? []).filter((line) => line.product_id === null),
    [read?.assessment]);

  /** line_index → the product the reviewer chose. `edits` is the record; this is its projection. */
  const mappedProducts = useMemo(() => {
    const rows: Record<number, string> = {};
    for (const [index, edit] of Object.entries(edits)) {
      if (edit.product_id) rows[Number(index)] = edit.product_id;
    }
    return rows;
  }, [edits]);

  const mapLine = useCallback((lineIndex: number, productId: string | null) => {
    setEdits((current) => {
      const next = { ...current };
      const line = { ...(next[lineIndex] ?? {}) };
      if (productId) line.product_id = productId;
      else delete line.product_id;
      if (Object.keys(line).length === 0) delete next[lineIndex];
      else next[lineIndex] = line;
      return next;
    });
  }, []);

  /** What an approval would write into the price list. The rule itself lives in assessment.ts. */
  const seedRows = useMemo(() => priceSeedRows(read, edits, supplierId), [read, edits, supplierId]);

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
      p_reason: reasonOr(reason, t('docAssessment.reasonOr')),
    });
    if (result.error) {
      toast(errorText(result.error), 'error');
      return;
    }

    /**
     * The price list is filled in AFTER the approval and only then, in a second command.
     *
     * It is not one transaction and cannot be made into one: `apply_reviewed_document` records the
     * document, `import_supplier_prices` owns every `supplier_products` write (0023 revoked direct
     * DML), and no RPC spans the two. The order is what makes the split honest — the document is
     * recorded first, so a failure here leaves a correctly recorded document with an unchanged
     * price list, which is exactly the state that existed before this feature. The reverse order
     * could leave prices moved by a document nobody approved.
     */
    let seedFailure: string | null = null;
    if (seedPrices && seedRows.length > 0) {
      const seeded = await supabase.rpc('import_supplier_prices', {
        p_rows: seedRows,
        p_effective_date: read.document_date ?? todayISO(),
        p_reason: reasonOr(reason, 'קביעת מחיר ראשוני מתוך מסמך שהתקבל'),
      });
      if (seeded.error) seedFailure = errorText(seeded.error);
    }
    setBusy(false);

    toast(seedFailure
      ? t('docAssessment.approvedSeedFailed', { error: seedFailure })
      : seedRows.length > 0 && seedPrices
        ? t('docAssessment.approvedWithSeed', { count: seedRows.length })
        : t('docAssessment.approved'), seedFailure ? 'error' : 'success');
    setReason('');
    await load();
    onApplied?.();
  }, [read, supplierId, orderId, edits, reason, toast, load, onApplied, seedPrices, seedRows]);

  if (loading && !read) return <Note tone="info" role="status">{t('docAssessment.text_2')}</Note>;
  if (loadError) return <Note tone="alert" role="alert">{loadError}</Note>;
  if (!read) return null;

  const [storedKey, approvedKey] = storageAndApprovalKeys(read);
  const assessment = read.assessment;
  const intakeCurrency = assessment?.currency ?? null;
  const editable = !read.data_approved && read.state !== 'awaiting_interpretation';

  return (
    <section className="space-y-5" aria-label={t('docAssessment.aria_label')}>
      {/* The two states, as two sentences with two icons. Never one word covering both. */}
      <div className="card p-4">
        <p className="flex items-start gap-2 text-sm text-ink-body">
          <CircleCheck size={ICON.sm} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>{t(storedKey)}</span>
        </p>
        <p className="mt-2 flex items-start gap-2 text-sm text-ink-body">
          {read.data_approved
            ? <CircleCheck size={ICON.sm} aria-hidden="true" className="mt-0.5 shrink-0" />
            : <Info size={ICON.sm} aria-hidden="true" className="mt-0.5 shrink-0" />}
          <span>{t(approvedKey)}</span>
        </p>
      </div>

      {read.state === 'awaiting_interpretation' && (
        <Note tone="info" role="status">
          {t('docAssessment.text_3')}
        </Note>
      )}

      {/* The exceptions, first and open. Nothing folds above this line. */}
      {blocking.length > 0 && (
        <Note tone="alert" role="alert">
          <div className="min-w-0">
            <p className="font-medium">{t('docAssessment.text_4')}</p>
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
                  {t('docAssessment.moreGroupsLead')}{' '}<span className="num">{blockingGroups.length - VISIBLE_BLOCKING_GROUPS}</span>{' '}{t('docAssessment.moreGroupsTail')}
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

      {/* Directly under the complaint it answers. "מוצר לא מזוהה" is the most common blocking
          finding on a new account — where the catalogue is empty, so EVERY line raises it — and
          until 28.08.2026 the screen named the remedy without offering it. */}
      {editable && unmatchedLines.length > 0 && (
        <DocumentLineMapping
          lines={unmatchedLines}
          supplierId={supplierId}
          currency={intakeCurrency}
          mapped={mappedProducts}
          onMap={mapLine}
          disabled={busy}
        />
      )}

      {/* Supplier and order, each with the evidence that decided it. A resolution with no
          explanation is indistinguishable from a guess. */}
      {read.supplier_resolution && (
        <div className="card p-4">
          <h3 className="text-sm font-medium text-ink-soft">{t('docAssessment.text_5')}</h3>
          <p className="mt-1 text-sm text-ink-body">
            {read.supplier_resolution.resolved
              ? t('docAssessment.supplierResolved', { evidence: resolutionText(read.supplier_resolution.matched_by, t) ?? '' })
              : read.supplier_resolution.reason === 'ambiguous'
                ? t('docAssessment.text_6')
                : t('docAssessment.text_7')}
          </p>
          {read.supplier_resolution.candidates.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm text-ink-muted">
              {read.supplier_resolution.candidates.map((candidate, index) => (
                <li key={index}>
                  {String(candidate.name ?? candidate.supplier_id ?? '')}
                  {candidate.evidence ? ` — ${candidate.evidence}` : ''}
                  {candidate.authoritative ? '' : t('docAssessment.text_8')}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {read.order_resolution && (
        <div className="card p-4">
          <h3 className="text-sm font-medium text-ink-soft">{t('docAssessment.text_9')}</h3>
          <p className="mt-1 text-sm text-ink-body">
            {read.order_resolution.resolved
              ? t('docAssessment.orderResolved', { evidence: resolutionText(read.order_resolution.matched_by, t) ?? '' })
              : read.order_resolution.reason === 'ambiguous'
                ? t('docAssessment.text_10')
                /* A document with no order is legitimate, not a failure (0107). */
                : t('docAssessment.text_11')}
          </p>
          {read.order_resolution.candidates.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm text-ink-muted">
              {read.order_resolution.candidates.map((candidate, index) => (
                <li key={index}>
                  {t('docAssessment.orderWord')}{' '}<span className="num">{String(candidate.number ?? '')}</span>
                  {candidate.evidence ? ` — ${candidate.evidence}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {read.document_type === 'credit_note' && read.credit_resolution && (
        <div className="card p-4">
          <h3 className="text-sm font-medium text-ink-soft">{t('docAssessment.text_12')}</h3>
          {read.credit_resolution.resolved ? (
            <dl className="mt-2 space-y-1.5 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-ink-muted">{t('docAssessment.text_13')}</dt>
                <dd><bdi>{read.credit_resolution.reference_invoice_number ?? '—'}</bdi></dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-ink-muted">{t('docAssessment.text_14')}</dt>
                <dd className="num font-medium">{fmtMoneyExact(read.credit_resolution.amount, intakeCurrency)}</dd>
              </div>
            </dl>
          ) : (
            <p className="mt-2 text-sm text-alert-fg">
              {read.credit_resolution.reason === 'ambiguous'
                ? t('docAssessment.text_15')
                : t('docAssessment.text_16')}
            </p>
          )}
        </div>
      )}

      {/* What will happen — and, just as importantly, what will not. Immediately above the button
          it describes, because that ordering is the whole point of the sentences (DESIGN.md §2). */}
      <div className="card p-4">
        <h3 className="text-sm font-medium text-ink-soft">{t('docAssessment.text_17')}</h3>
        <ul className="mt-2 space-y-1.5">
          {effects.map((effect, index) => (
            <li key={index} className="flex items-start gap-2 text-sm text-ink-body">
              {effect.happens
                ? <Check size={ICON.sm} aria-hidden="true" className="mt-0.5 shrink-0" />
                : <span aria-hidden="true" className="mt-0.5 shrink-0 text-ink-muted">✕</span>}
              <span>{t(effect.textKey)}</span>
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
            {t('docAssessment.text_18')}
          </label>
          <textarea
            id="review-reason"
            className="mt-2 min-h-20 w-full rounded-md border border-line bg-surface p-2 text-sm"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={1000}
          />
          {/* Only where there is something to fill in. An always-present switch over an empty set
              is a promise the approval will not keep. */}
          {seedRows.length > 0 && (
            <label className="mt-3 flex items-start gap-2 text-sm text-ink-body">
              <input
                type="checkbox"
                className="mt-0.5 size-4 shrink-0"
                checked={seedPrices}
                onChange={(event) => setSeedPrices(event.target.checked)}
              />
              <span>
                {t('docAssessment.seedLead')} <span className="num">{seedRows.length}</span>{' '}
                {seedRows.length === 1 ? t('docAssessment.seedProductOne') : t('docAssessment.seedProductOther')} {t('docAssessment.seedTail')}
                <span className="block text-xs text-ink-muted">
                  {t('docAssessment.seedKeepsExisting')}
                </span>
              </span>
            </label>
          )}
          {/* The button stays exactly where it was written, at every width: between "מה יקרה
              באישור" and the folded working. The blocking sentence is passed as the button's hint
              rather than left here, so it is read before the press and not five screens up. */}
          <PrimaryDecision
            className="mt-3"
            label={t('docAssessment.label')}
            hint={blocking.length > 0
              /* The button stays live: the server is the gate, and it names what it refused. A
                 client-side block would put a second decision-maker in the path and let the two
                 drift apart. */
              ? t('docAssessment.text_19')
              : null}
          >
            <button
              type="button"
              className="btn btn-primary min-h-11"
              disabled={busy || !canSubmit(read, supplierId)}
              onClick={() => void submit()}
            >
              {busy && <Loader2 size={ICON.sm} aria-hidden="true" className="animate-spin" />}
              {t('docAssessment.text_20')}
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
              title={t('docAssessment.title')}
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
              title={t('docAssessment.title_2')}
              count={assessment.lines.length}
              onToggle={setLinesOpen}
            >
              {linesOpen && (
                <div
                  className="table-scroll overflow-x-auto rounded-lg border border-line"
                  role="region"
                  tabIndex={0}
                  aria-label={t('docAssessment.aria_label_2')}
                >
                  <table className="min-w-full bg-surface">
                    <caption className="px-3 pt-2 text-start text-xs font-medium text-ink-soft">
                      {t('docAssessment.text_21')}
                    </caption>
                    <thead className="table-head">
                      <tr className="border-b border-line">
                        <th className="th" scope="col">{t('docAssessment.text_22')}</th>
                        <th className="th" scope="col">{t('docAssessment.text_23')}</th>
                        <th className="th" scope="col">{t('docAssessment.text_24')}</th>
                        <th className="th" scope="col">{t('docAssessment.text_25')}</th>
                        <th className="th" scope="col">{t('docAssessment.text_26')}</th>
                        <th className="th" scope="col">{t('docAssessment.text_27')}</th>
                        <th className="th" scope="col">{t('docAssessment.text_28')}</th>
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
                                <span className="block text-xs text-ink-muted">{t('docAssessment.text_29')}</span>
                              )}
                            </td>
                            <Cell>{fmtNum(line.quantity)}</Cell>
                            <Cell>{orderItem ? fmtNum(orderItem.ordered_quantity) : '—'}</Cell>
                            <Cell>{orderItem ? fmtNum(orderItem.received_quantity) : '—'}</Cell>
                            <Cell>{fmtMoneyExact(line.unit_price, intakeCurrency)}</Cell>
                            <Cell>{fmtMoneyExact(line.baseline_price, intakeCurrency)}</Cell>
                            <Cell>{difference === null ? '—' : fmtMoneyExact(difference, intakeCurrency)}</Cell>
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
            <p className="font-medium">{t('docAssessment.text_30')}</p>
            <ul className="mt-2 space-y-1 text-sm">
              {assessment.order_items.filter((item) => !item.on_this_document).map((item) => (
                <li key={item.purchase_order_item_id}>
                  <bdi>{item.product_name}</bdi> {t('docAssessment.fmtNum')} <span className="num">{fmtNum(item.ordered_quantity)}</span>
                </li>
              ))}
            </ul>
            {/* The server states this as a fact on every such finding; the screen must not quietly
                turn it into a shortage. A supplier bills in instalments. */}
            <p className="mt-2 text-sm">{t('docAssessment.text_31')}</p>
          </div>
        </Note>
      )}

{/* The mapping UI landed (28.08.2026), so the reviewer's decisions now arrive from a control
          instead of from an `sr-only` button whose only job was to CLEAR them. The count stays: it
          is the one place the screen says how much of this document is a person's judgement rather
          than the machine's reading, and the ledger records it as such. */}
      {Object.keys(edits).length > 0 && (
        <p className="text-sm text-ink-muted">
          <span className="num">{Object.keys(edits).length}</span>{' '}{t('docAssessment.linesEditedManually')}
        </p>
      )}
    </section>
  );
}
