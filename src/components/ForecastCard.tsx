import { useT } from '../lib/i18n/LocaleProvider';
import type { TKey } from '../lib/i18n/t';
import { fmtMoneyExact, fmtDate } from '../lib/format';
import { Card, Note, Skeleton } from './ui';

/**
 * What is scheduled to leave in the next thirty days — and how much of the debt that figure can
 * see.
 *
 * THE WORD "FORECAST" APPEARS IN THIS COMMENT AND IN NO STRING A PERSON READS. That is a rule with
 * a reason: coverage will be partial for a long time, and a partial figure presented as cash flow
 * is a claim about reality the product does not get to make. Every visible string says "scheduled
 * payments". The flag key behind it is `insights.forecast`, an internal identifier that never
 * reaches a screen.
 *
 * THE THRESHOLD IS COVERAGE BY AMOUNT, AND ONLY BY AMOUNT (owner ruling 31.08.2026, #308). Not
 * because rows do not matter but because the two numbers can be far apart: half the requests dated
 * can be ninety-four per cent of the money, and a gate on row count would hide an almost-exact
 * figure. Both numbers are always DISPLAYED; only the money one decides whether an amount is shown
 * at all. The threshold is a client-side decision on purpose, so moving it is a literal here and
 * not a migration.
 *
 * BELOW IT, THE CARD SAYS SO IN WORDS AND SHOWS NO NUMBER. Not `0`, not a dash where an amount
 * belongs, and not an estimate: it names how many requests carry a date, what share of the money
 * that is, and the one action that changes it. A zero would be a claim that nothing is due.
 *
 * AND `office` IS REFUSED, NOT EMPTIED. The server returns `not_permitted` with a reason (#151,
 * `0265`); rendering zeros for that role would let a person read "nothing is due" out of a
 * boundary they simply cannot cross — which is `DEBT §59` exactly.
 */

/** Owner ruling #308: seventy per cent of the MONEY. Rows are reported, never gating. */
const COVERAGE_THRESHOLD = 0.7;

export interface OutlookCurrencyRow {
  currency: string;
  amount: number;
  recordCount: number;
  coveredCount: number;
  totalCount: number;
  coveredAmount: number;
  uncoveredAmount: number;
}

export interface ScheduledPaymentsOutlook {
  status: 'measured' | 'not_permitted';
  reason?: string;
  horizonDays?: number;
  horizonEndsAt?: string;
  asOf?: string;
  byCurrency?: OutlookCurrencyRow[];
  undatedCommitmentsByCurrency?: { currency: string; amount: number }[];
}

/** The share of the MONEY that carries a date. Null where there is no money to divide. */
export function amountCoverage(row: OutlookCurrencyRow): number | null {
  const total = row.coveredAmount + row.uncoveredAmount;
  return total > 0 ? row.coveredAmount / total : null;
}

/** Three states, named, so the card cannot render a number in the wrong one. */
export type RowState = 'measured' | 'below_threshold' | 'no_data';

export function rowState(row: OutlookCurrencyRow): RowState {
  if (row.totalCount === 0) return 'no_data';
  const coverage = amountCoverage(row);
  // A cohort whose active requests sum to zero has nothing to be a share OF. That is not a
  // measurement of low coverage; it is an absence of money to measure.
  if (coverage === null) return 'no_data';
  return coverage >= COVERAGE_THRESHOLD ? 'measured' : 'below_threshold';
}

/** Confidence follows the same evidence the amount does — it is a reading, not a mood. */
function confidenceKey(coverage: number): TKey {
  if (coverage >= 0.9) return 'scheduled.confidenceHigh';
  if (coverage >= COVERAGE_THRESHOLD) return 'scheduled.confidenceMedium';
  return 'scheduled.confidenceLow';
}

const percent = (value: number, locale: string) =>
  new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(value);

function CurrencyBlock({ row, locale }: { row: OutlookCurrencyRow; locale: string }) {
  const { t } = useT();
  const coverage = amountCoverage(row);
  const state = rowState(row);
  const countShare = row.totalCount > 0 ? row.coveredCount / row.totalCount : null;

  return (
    <div className="border-t border-line-soft pt-3 first:border-t-0 first:pt-0">
      {state === 'measured' && coverage !== null ? (
        <>
          <div className="num text-2xl font-semibold text-ink" dir="ltr">
            {fmtMoneyExact(row.amount, row.currency)}
          </div>
          <p className="mt-0.5 text-sm text-ink-muted">
            {t('scheduled.recordCount', { count: row.recordCount })}
          </p>
        </>
      ) : (
        /* NO NUMBER HERE, AND NOT A DASH EITHER. The reader is told what is missing and what
           would change it, because a figure they cannot trust is worse than a sentence. */
        <p className="text-base font-medium text-ink-body">
          {state === 'no_data' ? t('scheduled.noData') : t('scheduled.notEnough')}
        </p>
      )}

      {/* THE COVERAGE IS ALWAYS HERE, above the threshold and below it. Both numbers: the share
          of the money, which decides, and the share of the requests, which does not. */}
      <dl className="mt-2 space-y-1 text-xs text-ink-muted">
        <div className="flex flex-wrap justify-between gap-2">
          <dt>{t('scheduled.coverageAmountLabel')}</dt>
          <dd className="num" dir="ltr">
            {coverage === null ? t('scheduled.notMeasurable') : percent(coverage, locale)}
          </dd>
        </div>
        <div className="flex flex-wrap justify-between gap-2">
          <dt>{t('scheduled.coverageCountLabel')}</dt>
          <dd>
            {t('scheduled.coverageCount', { covered: row.coveredCount, total: row.totalCount })}
            {/* A literal space, not a logical margin: the span is `dir="ltr"` inside an RTL line,
                so `ms-*` lands on the side the reader does not see it on. The screenshot showed
                `23(39%)` glued together. */}
            {countShare !== null && (
              <>{' '}<span className="num" dir="ltr">({percent(countShare, locale)})</span></>
            )}
          </dd>
        </div>
        <div className="flex flex-wrap justify-between gap-2">
          <dt>{t('scheduled.confidenceLabel')}</dt>
          <dd>{coverage === null ? t('scheduled.notMeasurable') : t(confidenceKey(coverage))}</dd>
        </div>
        {/* Known versus estimated, and the honest answer today is that nothing is estimated:
            every figure above is a request somebody dated. */}
        <div className="flex flex-wrap justify-between gap-2">
          <dt>{t('scheduled.knownLabel')}</dt>
          <dd>{t('scheduled.knownValue', { count: row.coveredCount })}</dd>
        </div>
      </dl>

      {state !== 'measured' && (
        <p className="mt-2 text-xs text-ink-body">{t('scheduled.whatWouldChangeIt')}</p>
      )}
    </div>
  );
}

export function ForecastCard({ outlook, loading, error, currency, locale, onOpenRecords }: {
  outlook: ScheduledPaymentsOutlook | null;
  loading?: boolean;
  error?: string | null;
  /** The currency the reader picked (#305). One at a time, and never a conversion. */
  currency: string | null;
  locale: string;
  onOpenRecords?: () => void;
}) {
  const { t } = useT();

  if (loading) {
    return (
      <Card className="space-y-3">
        <div className="section-title">{t('scheduled.title')}</div>
        <Skeleton className="h-24" />
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="space-y-3">
        <div className="section-title">{t('scheduled.title')}</div>
        <Note tone="alert">{error}</Note>
      </Card>
    );
  }

  // A REFUSAL IS NOT AN EMPTY RESULT. Saying "you may not see this" is the only honest render;
  // zeros would read as "nothing is due" to somebody who cannot check.
  if (outlook?.status === 'not_permitted') {
    return (
      <Card className="space-y-3">
        <div className="section-title">{t('scheduled.title')}</div>
        <Note tone="info" role="status">{t('scheduled.notPermitted')}</Note>
      </Card>
    );
  }

  if (!outlook || outlook.status !== 'measured') return null;

  const rows = outlook.byCurrency ?? [];
  // One currency at a time, chosen by the reader (#305). There is no conversion anywhere here.
  const row = currency ? rows.find((candidate) => candidate.currency === currency) : rows[0];
  const undated = (outlook.undatedCommitmentsByCurrency ?? [])
    .find((candidate) => candidate.currency === (row?.currency ?? currency));

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="section-title">{t('scheduled.title')}</div>
        {outlook.horizonEndsAt && (
          <span className="text-xs text-ink-muted">
            {t('scheduled.horizon', { date: fmtDate(outlook.horizonEndsAt) })}
          </span>
        )}
      </div>

      {row ? (
        <CurrencyBlock row={row} locale={locale} />
      ) : (
        <p className="text-base font-medium text-ink-body">{t('scheduled.noData')}</p>
      )}

      {/* OUTSIDE THE HORIZON, AND SAID SO. Money committed to an open order is not money owed on
          a day; inside the figure it would schedule a payment nobody dated. */}
      {undated && undated.amount > 0 && (
        <p className="border-t border-line-soft pt-3 text-xs text-ink-muted">
          {t('scheduled.undatedCommitments')}{' '}
          <span className="num font-medium text-ink-body" dir="ltr">
            {fmtMoneyExact(undated.amount, undated.currency)}
          </span>
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-soft pt-3">
        <span className="text-xs text-ink-ghost">
          {t('scheduled.source')}
          {outlook.asOf && <> · {t('scheduled.asOf', { date: fmtDate(outlook.asOf.slice(0, 10)) })}</>}
        </span>
        {/* The card is ALWAYS openable, in every state. Below the threshold this is the action
            that changes the state; above it, it is how a reader checks the figure. */}
        {onOpenRecords && (
          <button type="button" className="btn-secondary btn-sm min-h-11" onClick={onOpenRecords}>
            {t('scheduled.openRecords')}
          </button>
        )}
      </div>
    </Card>
  );
}
