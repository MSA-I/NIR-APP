import { useT } from '../../lib/i18n/LocaleProvider';
import type { TKey } from '../../lib/i18n/t';
import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { Check, ChevronLeft, Copy, NotepadText, ThumbsDown, ThumbsUp } from 'lucide-react';
import type {
  AssistantRole,
  AssistantRunResult,
  Fact,
  NoAnswerReason,
  SourceReference,
} from '../../lib/assistant/contracts';
import {
  ASSISTANT_DRAFT_LABEL_KEY,
  ASSISTANT_DRAFT_ROLES,
} from '../../lib/assistant/contracts';
import { assistantSourceRouteDecision } from '../../lib/assistant/routeAccess';
import { sendAssistantFeedback } from '../../lib/assistant/client';
import { fmtDate, fmtDateTime, fmtMoneyExact, fmtNum } from '../../lib/format';
import { Disclosure, ICON, Note } from '../ui';

/**
 * Renders one settled assistant answer, blocks in server order.
 *
 * The product rule this file exists for: prose may carry meaning, only a claim may carry a
 * quantity — and every claim must be visibly traceable. A claim block therefore shows the very
 * facts the server issued for it (label + value through the repo's one set of formatters) and
 * links to the routes the server returned. A number the user cannot trace back to a place in the
 * product is exactly what this feature exists to prevent.
 */

/**
 * `value: null` is "not measured". It renders as `—`, never as 0 — zero is a claim about the
 * business.
 *
 * A `text` fact is the opposite case and the two must not be confused: it is something the server
 * positively KNOWS and states in words. Decision F (owner 03.09.2026) is the reason there is one —
 * when nothing is owed the summary tool issues a sentence rather than a money fact, because
 * `0 ILS` would assert something about one currency while saying nothing about the others, and
 * `—` would call a known state unknown.
 */
function factValueText(fact: Fact): string {
  if (fact.value === null) return '—';
  if (typeof fact.value === 'string') return fact.unit === 'date' ? fmtDate(fact.value) : fact.value;
  // A three-letter unit IS the ISO currency the fact was measured in (0217). The assistant
  // never converts and never assumes: a money fact says which money it is in, or it is not a
  // money fact. Until phase 4 the only such unit a tool can emit is 'ils'.
  if (/^[a-z]{3}$/.test(fact.unit)) return fmtMoneyExact(fact.value, fact.unit.toUpperCase());
  switch (fact.unit) {
    case 'percent':
      return `${fmtNum(fact.value)}%`;
    case 'date':
      return fmtDate(new Date(fact.value));
    default:
      return fmtNum(fact.value);
  }
}

/**
 * An honest sentence for each named absence, in the reader's language. The SERVER names the
 * reason and the name never moves; the sentence is copy. `undefined_business_rule` says the
 * PRODUCT has not defined the rule — not that there is no data; the two would send the user in
 * opposite directions.
 */
const NO_ANSWER_KEY: Record<NoAnswerReason, TKey> = {
  no_capability: 'answerView.noAnswerNoCapability',
  not_measured: 'answerView.noAnswerNotMeasured',
  not_permitted: 'answerView.noAnswerNotPermitted',
  undefined_business_rule: 'answerView.noAnswerUndefinedBusinessRule',
};

const ASSISTANT_TOOL_KEYS: Record<string, TKey> = {
  get_business_summary: 'answerView.toolBusinessSummary',
  get_open_alerts: 'answerView.toolOpenAlerts',
  get_dashboard_snapshot: 'answerView.toolDashboardSnapshot',
  get_purchase_metrics: 'answerView.toolPurchaseMetrics',
  explain_invoice_block: 'answerView.toolInvoiceBlock',
  compare_order_receipt_invoice: 'answerView.toolThreeWayMatch',
  get_open_credits: 'answerView.toolOpenCredits',
  get_orders_awaiting_confirmation: 'answerView.toolOrdersAwaitingConfirmation',
  get_unmatched_bank_transactions: 'answerView.toolUnmatchedBankTransactions',
  get_supplier_performance: 'answerView.toolSupplierPerformance',
  get_inventory_risk: 'answerView.toolInventoryRisk',
  get_payment_exposure: 'answerView.toolPaymentExposure',
  find_entity: 'answerView.toolFindEntity',
  get_product_help: 'answerView.toolProductHelp',
  draft_supplier_reminder: 'answerView.toolSupplierReminder',
};

function toolKey(tool: string): TKey {
  return ASSISTANT_TOOL_KEYS[tool] ?? 'answerView.toolFallback';
}

function SourceLink({ source, onNavigate, active = false }: {
  source: SourceReference;
  onNavigate: () => void;
  active?: boolean;
}) {
  const { t } = useT();
  if (!source.route) return <span className="text-xs text-ink-muted">{source.label}</span>;
  return (
    <Link
      to={source.route}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={`inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-xs font-medium text-action-on-soft underline underline-offset-2 hover:bg-surface-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-focus ${active ? 'bg-surface-selected text-ink' : ''}`}
    >
      <ChevronLeft size={ICON.sm} aria-hidden="true" />
      {t('answerView.text')} {source.label}
    </Link>
  );
}

/**
 * The evidence under one block: the exact facts the server issued for it, and the screens where a
 * person can go and check them. Shared by claim and draft blocks — a draft that quotes an order
 * number has to be as traceable as a sentence that states one.
 */
function EvidenceTrail({ facts, sources, sourceIsCurrent, onNavigate }: {
  facts: readonly Fact[];
  sources: readonly SourceReference[];
  sourceIsCurrent: (source: SourceReference) => boolean;
  onNavigate: () => void;
}) {
  const { t } = useT();
  return (
    <>
      {facts.length > 0 && (
        <dl className="mt-2 space-y-1 border-t border-line-soft pt-2">
          {facts.map((fact) => (
            <div key={fact.id} className="flex items-start justify-between gap-3">
              <dt className="min-w-0 text-xs text-ink-muted">
                <span className="block">{fact.label}</span>
                <span className="mt-0.5 block text-xs">{t('answerView.fmtDateTime')}<span className="num">{fmtDateTime(fact.as_of)}</span></span>
              </dt>
              {/* `.num` is this repo's marker for a cell holding a FIGURE — tabular lining
                  numerals — and `shrink-0` because a number must never wrap. A `text` fact holds
                  a SENTENCE, so it takes neither: it wraps like the prose it is, and is not
                  dressed up as a quantity in a column of quantities. */}
              <dd className={fact.unit === 'text'
                ? 'min-w-0 text-end text-sm font-medium text-ink-mid'
                : 'num shrink-0 text-sm font-medium text-ink-mid'}>
                {factValueText(fact)}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {sources.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          {sources.map((source) => (
            <SourceLink key={source.id} source={source} active={sourceIsCurrent(source)} onNavigate={onNavigate} />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * A supplier reminder the PERSON sends (OPEN-DECISIONS #191).
 *
 * Everything about this block is shaped by one rule: the product does not contact suppliers. So
 * there is a copy action and nothing else — no recipient field, no channel picker, no "send"
 * button, and no wording anywhere claiming a message went out. The label is the product's own
 * constant rather than anything the model wrote, so a model cannot rename its own output into
 * something that reads like a completed action.
 *
 * The body is `pre-wrap` and `dir="auto"` because #191 allows Hebrew or English and a message
 * keeps its own line breaks; the surrounding page stays RTL either way.
 */
function DraftBlock({ text, facts, sources, sourceIsCurrent, onNavigate }: {
  text: string;
  facts: readonly Fact[];
  sources: readonly SourceReference[];
  sourceIsCurrent: (source: SourceReference) => boolean;
  onNavigate: () => void;
}) {
  const { t } = useT();
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copyDraft() {
    try {
      await navigator.clipboard.writeText(text);
      setCopy('copied');
    } catch {
      // Clipboard access can be refused by the browser; say what to do instead of failing silently.
      setCopy('failed');
    }
  }

  return (
    <section
      aria-label={t(ASSISTANT_DRAFT_LABEL_KEY)}
      className="rounded-2xl border-s-2 border-action-line bg-action-wash p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-medium text-ink-soft">
          <NotepadText size={ICON.sm} aria-hidden="true" /> {t(ASSISTANT_DRAFT_LABEL_KEY)}
        </h3>
        <button
          type="button"
          className="btn-ghost btn-sm"
          onClick={() => void copyDraft()}
        >
          <Copy size={ICON.xs} aria-hidden="true" /> {t('answerView.copyDraft')}
        </button>
      </div>
      <p dir="auto" className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-body">
        {text}
      </p>
      {/* Always present, so a screen reader is told the copy happened rather than only being
          shown it. Empty while idle; `sr-only` keeps the resting state out of the layout. */}
      <p role="status" className={copy === 'idle' ? 'sr-only' : 'mt-1.5 text-xs text-ink-muted'}>
        {copy === 'copied'
          ? t('answerView.text_2')
          : copy === 'failed'
            ? t('answerView.text_3')
            : ''}
      </p>
      <EvidenceTrail facts={facts} sources={sources} sourceIsCurrent={sourceIsCurrent} onNavigate={onNavigate} />
      <p className="mt-2 text-xs text-ink-muted">
        {t('answerView.text_4')}
      </p>
    </section>
  );
}

function FeedbackControl({ runId }: { runId: string }) {
  const { errorText, t } = useT();
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
      setError(errorText(e));
      setState('idle');
    }
  }

  if (state === 'sent') {
    return (
      <p className="flex items-center gap-1.5 text-xs text-ink-muted">
        <Check size={ICON.xs} className="text-done-fg" aria-hidden="true" /> {t('answerView.feedbackRecorded')}
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-ink-muted">{t('answerView.text_5')}</span>
      <button type="button" className="btn-ghost btn-sm" disabled={state === 'busy'} onClick={() => void send(true)}>
        <ThumbsUp size={ICON.xs} aria-hidden="true" /> {t('answerView.helpful')}
      </button>
      <button type="button" className="btn-ghost btn-sm" disabled={state === 'busy'} onClick={() => void send(false)}>
        <ThumbsDown size={ICON.xs} aria-hidden="true" /> {t('answerView.notHelpful')}
      </button>
      {error && <span role="alert" className="text-xs text-alert-fg">{error}</span>}
    </div>
  );
}

export default function AnswerView({ result, role, onNavigate }: {
  result: AssistantRunResult;
  role: AssistantRole;
  /** A source link leaves the panel for the screen it names; the dialog closes itself here. */
  onNavigate: () => void;
}) {
  const { t } = useT();
  const location = useLocation();
  const factById = new Map(result.facts.map((fact) => [fact.id, fact]));
  const sourceById = new Map(result.sources
    .filter((source) => assistantSourceRouteDecision(source, role) === 'allowed')
    .map((source) => [source.id, source]));
  const incompleteTools = result.tools_used.filter((tool) => !tool.complete).map((tool) => t(toolKey(tool.tool)));
  const sourceIsCurrent = (source: SourceReference): boolean => {
    if (!source.route) return false;
    const [path, query = ''] = source.route.split('?', 2);
    return location.pathname === path && (!query || location.search === `?${query}`);
  };

  return (
    <div className="space-y-3">
      {/* Mirrors /alerts: a partial scan is named, and a partial answer is never presented as whole. */}
      {!result.complete && (
        <Note tone="alert">
          <span className="min-w-0 flex-1">
            {incompleteTools.length > 0
              ? t('answerView.partialCheckWithTools', { tools: incompleteTools.join(', ') })
              : t('answerView.partialCheck')}
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
        if (block.type === 'draft') {
          // #191 gives the supplier draft to owner and office only. The Edge refuses it for any
          // other role and so does this renderer: a stored run reopened after a role change must
          // not surface one, the same reason a source is re-authorized on every render.
          if (!ASSISTANT_DRAFT_ROLES.includes(role)) return null;
          return (
            <DraftBlock
              key={index}
              text={block.text}
              facts={facts}
              sources={sources}
              sourceIsCurrent={sourceIsCurrent}
              onNavigate={onNavigate}
            />
          );
        }
        return (
          <div key={index} className="rounded-2xl bg-surface-sunken p-3">
            <p className="text-sm leading-relaxed text-ink-body">{block.text}</p>
            <EvidenceTrail facts={facts} sources={sources} sourceIsCurrent={sourceIsCurrent} onNavigate={onNavigate} />
          </div>
        );
      })}

      {/* Red TEXT, not a filled panel (owner, 25.08.2026 — #273).
          `.note-alert` paints wash + line + on-soft, which is the system's notice box: something
          went wrong with the SYSTEM. This sentence is the opposite — the check ran correctly and
          honestly reports that a number could not be measured. Dressed as an error it read as a
          malfunction. `text-alert-fg` is the treatment index.css:228 reserves for "text/icon on
          white", and the dashboard already uses it 21 times for exactly this register: a red
          statement about the data, on the surface it belongs to. */}
      {result.answer.no_answer_reason && (
        result.answer.no_answer_reason === 'not_measured'
          ? (
            <p className="text-sm font-medium leading-relaxed text-alert-fg">
              {t(NO_ANSWER_KEY[result.answer.no_answer_reason])}
            </p>
          )
          : (
            <Note tone="info">
              <span className="min-w-0 flex-1">{t(NO_ANSWER_KEY[result.answer.no_answer_reason])}</span>
            </Note>
          )
      )}

      {result.answer.next_steps.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-xs font-medium text-ink-muted">{t('answerView.text_7')}</span>
          {result.answer.next_steps.map((step) => {
            const source = sourceById.get(step.source_id);
            return source ? (
              <SourceLink
                key={step.source_id}
                source={{ ...source, label: step.label }}
                active={sourceIsCurrent(source)}
                onNavigate={onNavigate}
              />
            ) : null;
          })}
        </div>
      )}

      {result.tools_used.length > 0 && (
        <div className="rounded-2xl ring-1 ring-line-soft">
          <Disclosure title={t('answerView.title')}>
            <ul className="space-y-1 text-xs text-ink-muted">
              {result.tools_used.map((tool) => (
                <li key={tool.tool} className="flex items-center justify-between gap-3">
                  <span>{t(toolKey(tool.tool))}</span>
                  <span>{tool.complete ? t('answerView.text_8') : t('answerView.text_9')}</span>
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
