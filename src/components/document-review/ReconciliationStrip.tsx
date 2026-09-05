import { useT } from '../../lib/i18n/LocaleProvider';
import type { TKey } from '../../lib/i18n/t';
import { fmtMoneyExact } from '../../lib/format';
import { Note } from '../ui';
import type { DocumentAssessment } from './assessment';
import { formatLineRanges } from './assessment';

/**
 * The document's own arithmetic, shown as a ladder.
 *
 * WHAT THE SCREEN USED TO SAY. The server has computed this since `0108` and compared it against a
 * tolerance since `0227`: it knows the line sum, the header's three figures, and — since `0260` —
 * the computed total and the gap between them. The review screen printed a SENTENCE about it
 * ("the header total does not equal the sum of the lines") and none of the numbers behind it. A
 * reviewer could see that something was wrong and not how wrong, which is the difference between a
 * rounding artefact and a discount line the reader never extracted.
 *
 * NOT ONE FIGURE IS COMPUTED HERE. Every number is read from `totals`, including `computed_total`
 * and `unexplained_gap`, and that is a rule rather than a preference: adding `header_net +
 * header_vat` in React would round by React's rules rather than by the currency's minor units,
 * and would therefore be able to disagree with the arithmetic that decided whether to block the
 * document. The tolerance printed is `document_tolerance` — the one the server actually used, not
 * one this component looked up for itself.
 *
 * ONE LADDER, FROM VALUES THE SERVER ACTUALLY PUBLISHES. A former second card permanently showed
 * withholding and bank receipt as "not extracted" because no pipeline supplies either value.
 * The owner ruling in `UX-REMEDIATION-DECISIONS-20260904.md` removed that empty promise; it can
 * return when the read model carries data.
 *
 * AND A RUNG THAT WAS NEVER READ IS NOT A ZERO. `missing_rungs` names the ones the extractor could
 * not produce, so each row says "not extracted" against its own label rather than showing a dash
 * the reader has to interpret. Where a missing rung makes the gap unknowable, the gap row says so
 * in words instead of printing a number derived from an absence.
 */

/**
 * Why the numbers disagree, as far as the server's own finding codes can say.
 *
 * BOTH VOCABULARIES, ONE MAP. The document assessment and the invoice's three-way match name the
 * same four failures with different codes, because they were written years apart. Translating one
 * set into the other in an adapter would put a rename between a server's finding and the sentence
 * a reader acts on; listing both here keeps every code that can classify a gap in one place a
 * person can read.
 */
const GAP_CLASSIFICATION: Readonly<Record<string, TKey>> = {
  // The document assessment (0108 → 0260).
  header_arithmetic_discrepancy: 'reconciliation.classArithmetic',
  header_total_differs_from_lines: 'reconciliation.classCommercial',
  line_arithmetic_discrepancy: 'reconciliation.classArithmetic',
  credit_required: 'reconciliation.classEvidence',
  // The invoice's three-way match (0099 → 0261). `invoice_header_arithmetic_discrepancy` is the
  // header failing its own identity; the other two are the lines disagreeing with the header,
  // which is the commercial gap a missing discount or an extra charge produces.
  invoice_header_arithmetic_discrepancy: 'reconciliation.classArithmetic',
  invoice_net_total_discrepancy: 'reconciliation.classCommercial',
  invoice_grand_total_discrepancy: 'reconciliation.classCommercial',
  invoice_vat_total_discrepancy: 'reconciliation.classArithmetic',
};

/**
 * What the strip needs, and nothing else.
 *
 * It used to take a `DocumentAssessment`, which made it look like a document component. It is not:
 * the invoice's three-way match publishes the same ladder since `0261`, and the strip draws both.
 * Narrowing the prop to the three fields it reads is what lets a second caller pass its own shape
 * without either screen pretending to be the other.
 */
export type LadderFinding = { code: string; line_index?: number | null };
export type LadderSource = {
  totals: DocumentAssessment['totals'];
  currency: string | null;
  findings: readonly LadderFinding[];
};

function Rung({ label, value, currency, missing, strong = false, negative = false }: {
  label: string;
  value: number | null;
  currency: string | null;
  missing: boolean;
  strong?: boolean;
  negative?: boolean;
}) {
  const { t } = useT();
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className={`text-sm ${strong ? 'font-medium text-ink-body' : 'text-ink-muted'}`}>{label}</span>
      {missing ? (
        /* Named, not dashed. "Zero" and "we could not read it" are different facts about the
           document, and the reader is the one who has to tell them apart. */
        <span className="text-xs text-ink-ghost">{t('reconciliation.notExtracted')}</span>
      ) : (
        /* The sign goes THROUGH the formatter, not beside it. A minus rendered as its own text
           node next to a currency-shaped string is a bidi hazard — the screenshot showed it
           detached from its digits — and it would also be money shaped outside `fmtMoneyExact`,
           which is the one thing `check:money` exists to prevent. `-0` is not a discount. */
        <span className={`num text-sm ${strong ? 'font-semibold text-ink' : 'text-ink-body'}`} dir="ltr">
          {fmtMoneyExact(
            value == null ? null : negative && value !== 0 ? -Math.abs(value) : value, currency)}
        </span>
      )}
    </div>
  );
}

export function ReconciliationStrip({ ladder, title, onGoToLines }: {
  ladder: LadderSource | null;
  /**
   * What the record is called on THIS screen. A document's account and an invoice's account are
   * the same arithmetic about two different objects, and a strip that called both "the document"
   * would be telling half its readers about a record they are not looking at.
   */
  title?: string;
  /** Takes the reader to the lines the gap points at. Absent where there is nowhere to go. */
  onGoToLines?: (lines: number[]) => void;
}) {
  const { t } = useT();
  if (!ladder) return null;

  const totals = ladder.totals;
  const currency = totals.currency ?? ladder.currency;
  const missing = new Set(totals.missing_rungs ?? []);

  /* Nothing to draw a ladder from: no header figures and no lines. An empty ladder is a frame
     around an absence, and the findings list above already says the document could not be read. */
  if (missing.size === 4) return null;

  const gapKnown = totals.unexplained_gap != null;
  const overTolerance = gapKnown && totals.document_tolerance != null
    && Math.abs(totals.unexplained_gap as number) > (totals.document_tolerance as number);

  /* The classification is the SERVER'S, read off the finding it raised. An OCR gap is the one
     case the codes cannot name, because a rung nobody extracted produces no finding at all — so
     it is derived from `missing_rungs`, which is the same evidence stated the other way. */
  const money = ladder.findings.find((finding) => finding.code in GAP_CLASSIFICATION);
  const classification = missing.size > 0 && !money
    ? t('reconciliation.classExtraction')
    : money ? t(GAP_CLASSIFICATION[money.code]) : null;

  const suspectLines = ladder.findings
    .filter((finding) => finding.code in GAP_CLASSIFICATION && finding.line_index != null)
    .map((finding) => (finding.line_index as number) + 1);

  const foldable = gapKnown && !overTolerance && missing.size === 0;
  const section = (
      <section className={foldable ? 'p-4 pt-0' : 'card p-4'} aria-labelledby="reconciliation-account">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h3 id="reconciliation-account" className="text-sm font-semibold text-ink-body">
            {title ?? t('reconciliation.accountTitle')}
          </h3>
          {currency && (
            <span className="text-xs text-ink-muted">
              {t('reconciliation.documentCurrency')} <span className="num" dir="ltr">{currency}</span>
            </span>
          )}
        </div>

        <div className="divide-y divide-line-soft">
          <Rung label={t('reconciliation.linesNet')} value={totals.lines_net} currency={currency}
            missing={missing.has('lines_net')} />
          <Rung label={t('reconciliation.discounts')} value={totals.lines_discount} currency={currency}
            missing={missing.has('lines_net')} negative />
          <Rung label={t('reconciliation.headerNet')} value={totals.header_net} currency={currency}
            missing={missing.has('header_net')} />
          <Rung label={t('reconciliation.vat')} value={totals.header_vat} currency={currency}
            missing={missing.has('header_vat')} />
          <Rung label={t('reconciliation.computed')} value={totals.computed_total} currency={currency}
            missing={totals.computed_total == null} strong />
          <Rung label={t('reconciliation.statedTotal')} value={totals.header_total} currency={currency}
            missing={missing.has('header_total')} strong />
        </div>

        <div className="mt-2 border-t-2 border-line pt-2">
          {gapKnown ? (
            <Rung label={t('reconciliation.gap')} value={totals.unexplained_gap} currency={currency}
              missing={false} strong />
          ) : (
            /* A gap derived from an absence is not a gap. The row says which rung is missing
               rather than printing a number the document does not support. */
            <div className="flex items-baseline justify-between gap-3 py-1">
              <span className="text-sm font-medium text-ink-body">{t('reconciliation.gap')}</span>
              <span className="text-xs text-ink-ghost">{t('reconciliation.cannotCalculate')}</span>
            </div>
          )}
        </div>

        {/* One block child inside the Note, because `.note` is `flex items-start` (index.css:398):
            four bare children became four flex ITEMS laid out across the row. A screenshot showed
            that; reading the JSX did not. */}
        {overTolerance && (
          <Note tone="alert" className="mt-3">
            <div className="min-w-0">
            <p className="font-medium">{t('reconciliation.overTolerance')}</p>
            {classification && <p className="mt-0.5 text-sm">{classification}</p>}
            <p className="mt-0.5 text-xs">
              {t('reconciliation.toleranceUsed')}{' '}
              <span className="num" dir="ltr">
                {fmtMoneyExact(totals.document_tolerance, currency)}
              </span>
            </p>
            {onGoToLines && suspectLines.length > 0 && (
              <button type="button" className="btn-secondary btn-sm mt-2 min-h-11"
                onClick={() => onGoToLines(suspectLines.map((line) => line - 1))}>
                {t('reconciliation.goToLines', { lines: formatLineRanges(suspectLines) })}
              </button>
            )}
            </div>
          </Note>
        )}

        {!foldable && !overTolerance && gapKnown && (
          <Note tone="idle" className="mt-3">{t('reconciliation.withinTolerance')}</Note>
        )}
      </section>
  );

  return (
    <div className="space-y-3">
      {foldable ? (
        <details className="card group" data-testid="reconciliation-fold">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
            <span className="text-sm font-semibold text-ink-body">
              {title ?? t('reconciliation.accountTitle')}
            </span>
            <span className="badge-done">{t('reconciliation.withinTolerance')}</span>
          </summary>
          {section}
        </details>
      ) : section}
    </div>
  );
}
