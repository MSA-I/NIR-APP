import { useState } from 'react';
import { Link } from 'react-router';
import { Check, ExternalLink, ThumbsDown, ThumbsUp } from 'lucide-react';
import type {
  AssistantRunResult,
  Fact,
  NoAnswerReason,
  SourceReference,
} from '../../lib/assistant/contracts';
import { sendAssistantFeedback } from '../../lib/assistant/client';
import { toHebrewError } from '../../lib/errors';
import { fmtDate, fmtMoneyExact, fmtNum } from '../../lib/format';
import { Disclosure, Note } from '../ui';

/**
 * Renders one settled assistant answer, blocks in server order.
 *
 * The product rule this file exists for: prose may carry meaning, only a claim may carry a
 * quantity — and every claim must be visibly traceable. A claim block therefore shows the very
 * facts the server issued for it (label + value through the repo's one set of formatters) and
 * links to the routes the server returned. A number the user cannot trace back to a place in the
 * product is exactly what this feature exists to prevent.
 */

/** `value: null` is "not measured". It renders as `—`, never as 0 — zero is a claim about the business. */
function factValueText(fact: Fact): string {
  if (fact.value === null) return '—';
  if (typeof fact.value === 'string') return fact.unit === 'date' ? fmtDate(fact.value) : fact.value;
  switch (fact.unit) {
    case 'ils':
      return fmtMoneyExact(fact.value);
    case 'percent':
      return `${fmtNum(fact.value)}%`;
    case 'date':
      return fmtDate(new Date(fact.value));
    default:
      return fmtNum(fact.value);
  }
}

/**
 * Honest Hebrew for each named absence. `undefined_business_rule` says the PRODUCT has not
 * defined the rule — not that there is no data; the two would send the user in opposite
 * directions.
 */
const NO_ANSWER_TEXT: Record<NoAnswerReason, string> = {
  no_capability:
    'אין לעוזר יכולת בדוקה שעונה על השאלה הזו, ולכן לא ניתנה תשובה. הנתונים עצמם זמינים במסכים.',
  not_measured:
    'הבדיקה רצה אך לא הצליחה למדוד את הנתון המבוקש, ולכן אין תשובה — וזה שונה מ"הכול תקין".',
  not_permitted:
    'ההרשאות של החשבון הזה אינן מגיעות לנתונים שהשאלה דורשת, ולכן לא ניתנה תשובה.',
  undefined_business_rule:
    'המוצר טרם הגדיר את הכלל העסקי שהשאלה נשענת עליו, ולכן העוזר לא ענה. אין פירוש הדבר שאין נתונים.',
};

function SourceLink({ source, onNavigate }: { source: SourceReference; onNavigate: () => void }) {
  if (!source.route) return <span className="text-xs text-ink-muted">{source.label}</span>;
  return (
    <Link
      to={source.route}
      onClick={onNavigate}
      className="inline-flex items-center gap-1 rounded-sm text-xs text-action-on-soft underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
    >
      <ExternalLink size={12} aria-hidden="true" />
      {source.label}
    </Link>
  );
}

function FeedbackControl({ runId }: { runId: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function send(helpful: boolean) {
    setState('busy');
    setError(null);
    try {
      await sendAssistantFeedback(runId, helpful);
      setState('sent');
    } catch (e) {
      // Write path: translated here, where it is shown (the useQuery.ts convention).
      setError(toHebrewError(e));
      setState('idle');
    }
  }

  if (state === 'sent') {
    return (
      <p className="flex items-center gap-1.5 text-xs text-ink-muted">
        <Check size={13} className="text-done-fg" aria-hidden="true" /> המשוב נרשם. תודה.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-ink-muted">האם התשובה עזרה?</span>
      <button type="button" className="btn-ghost gap-1 px-2! py-1! text-xs" disabled={state === 'busy'} onClick={() => void send(true)}>
        <ThumbsUp size={13} aria-hidden="true" /> מועיל
      </button>
      <button type="button" className="btn-ghost gap-1 px-2! py-1! text-xs" disabled={state === 'busy'} onClick={() => void send(false)}>
        <ThumbsDown size={13} aria-hidden="true" /> לא מועיל
      </button>
      {error && <span role="alert" className="text-xs text-alert-fg">{error}</span>}
    </div>
  );
}

export default function AnswerView({ result, onNavigate }: {
  result: AssistantRunResult;
  /** A source link leaves the panel for the screen it names; the dialog closes itself here. */
  onNavigate: () => void;
}) {
  const factById = new Map(result.facts.map((fact) => [fact.id, fact]));
  const sourceById = new Map(result.sources.map((source) => [source.id, source]));
  const incompleteTools = result.tools_used.filter((tool) => !tool.complete).map((tool) => tool.tool);

  return (
    <div className="space-y-3">
      {/* Mirrors /alerts: a partial scan is named, and a partial answer is never presented as whole. */}
      {!result.complete && (
        <Note tone="alert">
          <span className="min-w-0 flex-1">
            הבדיקה חלקית{incompleteTools.length > 0 ? ` — לא הושלמו: ${incompleteTools.join(', ')}` : ''}.
            הממצאים שכן נבדקו מוצגים, אך אי אפשר לקבוע שהכול תקין.
          </span>
        </Note>
      )}

      {result.answer.blocks.map((block, index) => {
        if (block.type === 'text') {
          return (
            <p key={index} className="text-sm leading-relaxed text-ink-body">
              {block.text}
            </p>
          );
        }
        const facts = block.fact_ids
          .map((id) => factById.get(id))
          .filter((fact): fact is Fact => fact !== undefined);
        const sources = block.source_ids
          .map((id) => sourceById.get(id))
          .filter((source): source is SourceReference => source !== undefined);
        return (
          <div key={index} className="rounded-xl bg-surface-sunken p-3">
            <p className="text-sm leading-relaxed text-ink-body">{block.text}</p>
            {facts.length > 0 && (
              <dl className="mt-2 space-y-1 border-t border-line-soft pt-2">
                {facts.map((fact) => (
                  <div key={fact.id} className="flex items-baseline justify-between gap-3">
                    <dt className="min-w-0 text-xs text-ink-muted">{fact.label}</dt>
                    <dd className="num shrink-0 text-sm font-medium text-ink-mid">{factValueText(fact)}</dd>
                  </div>
                ))}
              </dl>
            )}
            {sources.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                {sources.map((source) => (
                  <SourceLink key={source.id} source={source} onNavigate={onNavigate} />
                ))}
              </div>
            )}
          </div>
        );
      })}

      {result.answer.no_answer_reason && (
        <Note tone={result.answer.no_answer_reason === 'not_measured' ? 'alert' : 'info'}>
          <span className="min-w-0 flex-1">{NO_ANSWER_TEXT[result.answer.no_answer_reason]}</span>
        </Note>
      )}

      {result.answer.next_steps.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-xs font-medium text-ink-muted">להמשך:</span>
          {result.answer.next_steps.map((step) => {
            const source = sourceById.get(step.source_id);
            return source ? (
              <SourceLink key={step.source_id} source={{ ...source, label: step.label }} onNavigate={onNavigate} />
            ) : null;
          })}
        </div>
      )}

      {result.tools_used.length > 0 && (
        <div className="rounded-xl ring-1 ring-line-soft">
          <Disclosure title="מה נבדק" count={result.tools_used.length}>
            <ul className="space-y-1 text-xs text-ink-muted">
              {result.tools_used.map((tool) => (
                <li key={tool.tool} className="flex items-center justify-between gap-3">
                  <span dir="ltr">{tool.tool}</span>
                  <span>{tool.complete ? 'הושלם' : 'חלקי'}</span>
                </li>
              ))}
            </ul>
          </Disclosure>
        </div>
      )}

      <FeedbackControl runId={result.run_id} />
    </div>
  );
}
