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
 * TWO LADDERS, AND A MISSING RUNG ONLY CANCELS ITS OWN. "The document's account" is a closed sum
 * whose every rung exists on every document today. "What will actually be paid" — withholding at
 * source, what landed in the bank — is a second ladder whose rungs are NOT extracted at all.
 * Merging them would make every document in the country read "cannot be calculated", because
 * withholding is never known, and that would delete the feature rather than build it. So the
 * second block says "not extracted" and does not touch the first block's gap.
 *
 * AND A RUNG THAT WAS NEVER READ IS NOT A ZERO. `missing_rungs` names the ones the extractor could
 * not produce, so each row says "not extracted" against its own label rather than showing a dash
 * the reader has to interpret. Where a missing rung makes the gap unknowable, the gap row says so
 * in words instead of printing a number derived from an absence.
 */

/** Why the numbers disagree, as far as the server's own finding codes can say. */
const GAP_CLASSIFICATION: Readonly<Record<string, TKey>> = {
  header_arithmetic_discrepancy: 'reconciliation.classArithmetic',
  header_total_differs_from_lines: 'reconciliation.classCommercial',
  line_arithmetic_discrepancy: 'reconciliation.classArithmetic',
  credit_required: 'reconciliation.classEvidence',
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

export function ReconciliationStrip({ assessment, onGoToLines }: {
  assessment: DocumentAssessment | null;
  /** Takes the reader to the lines the gap points at. Absent where there is nowhere to go. */
  onGoToLines?: (lines: number[]) => void;
}) {
  const { t } = useT();
  if (!assessment) return null;

  const totals = assessment.totals;
  const currency = totals.currency ?? assessment.currency;
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
  const money = assessment.findings.find((finding) => finding.code in GAP_CLASSIFICATION);
  const classification = missing.size > 0 && !money
    ? t('reconciliation.classExtraction')
    : money ? t(GAP_CLASSIFICATION[money.code]) : null;

  const suspectLines = assessment.findings
    .filter((finding) => finding.code in GAP_CLASSIFICATION && finding.line_index != null)
    .map((finding) => (finding.line_index as number) + 1);

  return (
    <div className="space-y-3">
      <section className="card p-4" aria-labelledby="reconciliation-account">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h3 id="reconciliation-account" className="text-sm font-semibold text-ink-body">
            {t('reconciliation.accountTitle')}
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

        {!overTolerance && gapKnown && (
          <Note tone="idle" className="mt-3">{t('reconciliation.withinTolerance')}</Note>
        )}
      </section>

      {/* THE SECOND LADDER. Its rungs are not extracted by anything today, and saying so is the
          honest report — a zero here would claim the document was read and found to withhold
          nothing. It deliberately does not participate in the gap above. */}
      <section className="card p-4" aria-labelledby="reconciliation-payable">
        <h3 id="reconciliation-payable" className="mb-2 text-sm font-semibold text-ink-body">
          {t('reconciliation.payableTitle')}
        </h3>
        <div className="divide-y divide-line-soft">
          <Rung label={t('reconciliation.withholding')} value={null} currency={currency} missing />
          <Rung label={t('reconciliation.actuallyReceived')} value={null} currency={currency} missing />
        </div>
        <p className="mt-2 text-xs text-ink-muted">{t('reconciliation.payableNote')}</p>
      </section>
    </div>
  );
}
