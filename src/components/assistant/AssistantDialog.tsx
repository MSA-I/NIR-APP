import { useT } from '../../lib/i18n/LocaleProvider';
import type { TKey } from '../../lib/i18n/t.ts';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router';
import { Loader2, Plus, Send, Sparkles, Trash2, X } from 'lucide-react';
import {
  ASSISTANT_FLAG_KEYS,
  ASSISTANT_QUESTION_MAX_CHARS,
} from '../../lib/assistant/contracts';
import {
  deleteAssistantConversation,
  loadAssistantConversation,
  useAssistantConversations,
} from '../../lib/assistant/client';
import type { AssistantHistoryView } from '../../lib/assistant/contracts';
import type { AssistantRunSession } from '../../lib/assistant/runSession';
import { useFeatureFlags } from '../../lib/flags';
import { APP_NAME } from '../../lib/branding';
import { fmtDateTime } from '../../lib/format';
import { useAuth } from '../../auth/AuthContext';
import { isActiveRole } from '../../lib/types';
import { APP_ROUTE_POLICY, appRouteAllowsRole } from '../../lib/routePolicy';
import { ConfirmDialog, ErrorNote, ICON, Note, Skeleton, useDialogLayer } from '../ui';
import AnswerView from './AnswerView';
import CollapsibleAnswer from './CollapsibleAnswer';

/**
 * Refusals with a working deterministic alternative. For these the panel does not stop at the
 * Hebrew sentence — it wires the user to the screens that keep answering without any model:
 * /alerts scans what needs attention, /dashboard holds the live picture. A dead end here would
 * make the assistant look load-bearing when it is deliberately not.
 */
const FALLBACK_CODES = [
  'assistant_disabled',
  // A refused question is still a person who came here for an answer. Without this the input
  // refusal was the one failure that offered no way forward at all — just a red paragraph.
  'assistant_input_restricted',
  'assistant_not_entitled',
  'assistant_limit_reached',
  'assistant_limit_unknown',
  'assistant_provider_unavailable',
  'assistant_provider_timeout',
  'assistant_unsupported_answer',
  'assistant_tool_failed',
] as const;

const ASSISTANT_DESKTOP_QUERY = '(min-width: 64rem)';

function useAssistantDesktopMode(): boolean {
  const [desktop, setDesktop] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(ASSISTANT_DESKTOP_QUERY).matches
      : false);

  useEffect(() => {
    const query = window.matchMedia(ASSISTANT_DESKTOP_QUERY);
    const sync = () => setDesktop(query.matches);
    query.addEventListener('change', sync);
    sync();
    return () => query.removeEventListener('change', sync);
  }, []);

  return desktop;
}

/**
 * The openings each role is offered. Decision #370 replaces a fixed count with two useful sets:
 * usage guidance while the business has no working data, and data questions once it does.
 *
 * EVERY ENTRY IS CHECKED AGAINST THE TOOL THAT WOULD ANSWER IT, and against that tool's
 * `requiredRoles` in `supabase/functions/assistant/tools/`. That check is the reason the
 * accountant's list changes rather than only growing: it used to offer "כמה כסף ממתין לזיכוי?",
 * which is `get_open_credits`, and that tool is `["owner", "office"]`. The panel was handing the
 * accountant a question the server would refuse — a suggested dead end, which is worse than no
 * suggestion, because the person reasonably reads the refusal as the assistant being broken.
 *
 * The mapping, so the next edit can be checked the same way:
 *   get_open_alerts, get_purchase_metrics, explain_invoice_block, find_entity, get_product_help,
 *   compare_order_receipt_invoice   -> all three roles
 *   get_business_summary, get_open_credits, get_monthly_price_rises, get_payment_exposure,
 *   get_supplier_performance, get_inventory_risk, get_orders_awaiting_confirmation,
 *   get_purchase_comparison, get_dashboard_snapshot, draft_supplier_reminder -> owner + office
 *   get_unmatched_bank_transactions -> owner + accountant
 */
/**
 * The example questions, as KEYS rather than sentences — and the reason is not tidiness.
 *
 * Clicking one SENDS it: the example becomes the question the assistant is asked. Since
 * `OPEN-DECISIONS #283` the assistant answers in the reader's language, so an English reader
 * clicking a Hebrew example would be asking in a language they did not choose and reading the
 * answer in one they did. The example has to be in their language before it is sent, not after.
 */
const ROLE_DATA_EXAMPLE_KEYS: Record<'owner' | 'office' | 'accountant', readonly TKey[]> = {
  owner: [
    'assistantDialog.exampleWhatNeedsAttention',
    'assistantDialog.exampleBusinessPicture',
    'assistantDialog.exampleCreditsPending',
    'assistantDialog.examplePriceRises',
    'assistantDialog.examplePaymentExposure',
    'assistantDialog.exampleUnmatchedBank',
  ],
  office: [
    'assistantDialog.exampleWhatNeedsAttention',
    'assistantDialog.exampleInvoiceBlocked',
    'assistantDialog.exampleOrdersUnconfirmed',
    'assistantDialog.examplePriceRises',
    'assistantDialog.exampleLateSuppliers',
    'assistantDialog.exampleInventoryRisk',
  ],
  accountant: [
    'assistantDialog.exampleUnmatchedBank',
    'assistantDialog.exampleWhatNeedsAttention',
    'assistantDialog.exampleInvoiceBlocked',
    'assistantDialog.exampleInvoicesLastWeek',
    'assistantDialog.exampleThreeWayMatch',
    'assistantDialog.exampleWhereApprovals',
  ],
};

const ROLE_USAGE_EXAMPLE_KEYS: Record<'owner' | 'office' | 'accountant', readonly TKey[]> = {
  owner: [
    'assistantDialog.exampleHowToStart',
    'assistantDialog.exampleHowToAddSupplier',
    'assistantDialog.exampleHowToUploadDocument',
    'assistantDialog.exampleHowToCreateOrder',
  ],
  office: [
    'assistantDialog.exampleHowToUploadDocument',
    'assistantDialog.exampleHowToAddSupplier',
    'assistantDialog.exampleHowToCreateOrder',
    'assistantDialog.exampleHowToReceiveGoods',
  ],
  accountant: [
    'assistantDialog.exampleHowToFindInvoices',
    'assistantDialog.exampleHowToMatchBank',
    'assistantDialog.exampleHowToExportReport',
    'assistantDialog.exampleHowToFindApprovals',
  ],
};

export function assistantExampleKeysFor(
  role: 'owner' | 'office' | 'accountant',
  hasBusinessData: boolean,
): readonly TKey[] {
  return hasBusinessData ? ROLE_DATA_EXAMPLE_KEYS[role] : ROLE_USAGE_EXAMPLE_KEYS[role];
}

function needsFallback(rawError: string): boolean {
  return FALLBACK_CODES.some((code) => rawError.includes(code));
}

/**
 * One question, as its author.
 *
 * Three sites render it — a settled turn, the question still in flight, and the question whose
 * run failed — and before this they were three copies of one string of classes. The bubble sits
 * at the logical `end` in `bg-action` and squares the corner nearest its own edge, which is what
 * separates a question from an answer without an avatar, a name or a label (DESIGN.md:539-542).
 */
function UserTurn({ question }: { question: string }) {
  return (
    <div className="page-fade flex justify-end">
      <p className="max-w-[85%] rounded-3xl rounded-ee-sm bg-action px-4 py-2.5 text-sm font-medium leading-relaxed text-on-solid shadow-card">
        {question}
      </p>
    </div>
  );
}

/**
 * Stored history, mounted only while `assistant.history` is on — off means runs are not stored,
 * and fetching an empty table just to prove it would be noise. Rows arrive through RLS.
 */
function ConversationHistory({ authorizationFingerprint, onOpen }: {
  authorizationFingerprint: string;
  onOpen: (turns: AssistantHistoryView[], expectedAuthorizationFingerprint: string) => void;
}) {
  const { errorText, t } = useT();
  const { data, loading, error, refetch } = useAssistantConversations(authorizationFingerprint);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  /* The heading is OUTSIDE the loading branch (owner report 26.08.2026, the assistant's bugs).
     Only the sighted reader was left without it: the loading state announced "טוען שיחות קודמות"
     to assistive tech and drew two anonymous grey bars for everyone else, hanging under the
     example chips with nothing saying what they were. They read as a rendering failure — which
     on a surface whose whole promise is "what you see was measured" is the worst possible thing
     for an empty rectangle to imply. Same heading, both states, so the bars are captioned. */
  if (error) return <ErrorNote message={error} />;
  if (!loading && (!data || data.length === 0)) return null;

  return (
    <div>
      <h3 className="mb-1 text-xs font-medium text-shell-ink-dim">{t('assistantDialog.text')}</h3>
      {loading && (
        <div role="status" aria-busy="true" className="space-y-2 py-1">
          <span className="sr-only">{t('assistantDialog.text_2')}</span>
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      )}
      {openError && <ErrorNote message={openError} />}
      {deleteError && <ErrorNote message={deleteError} />}
      <ul>
        {(data ?? []).map((conversation) => (
          <li key={conversation.id} className="assistant-divider flex min-h-11 items-center gap-2 border-t py-1 first:border-t-0">
            <button
              type="button"
              className="assistant-focus flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-start transition-colors hover:bg-assistant-bubble focus-visible:outline-none"
              disabled={openingId !== null}
              aria-label={t('assistantDialog.openCheckLabel', { title: conversation.title })}
              onClick={() => {
                const expectedAuthorizationFingerprint = authorizationFingerprint;
                setOpeningId(conversation.id);
                setOpenError(null);
                void loadAssistantConversation(conversation.id)
                  .then((restored) => {
                    setOpeningId(null);
                    onOpen(restored, expectedAuthorizationFingerprint);
                  })
                  .catch((e) => {
                    setOpeningId(null);
                    setOpenError(errorText(e));
                  });
              }}
            >
              <span className="min-w-0 flex-1 truncate text-sm text-shell-ink-soft">{conversation.title}</span>
              <span className="num shrink-0 text-xs text-shell-ink-dim">{fmtDateTime(conversation.updated_at)}</span>
                {openingId === conversation.id && <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" />}
            </button>
            <button
              type="button"
              className="assistant-focus grid size-11 shrink-0 place-items-center rounded-full text-shell-ink-dim transition-colors hover:bg-assistant-bubble hover:text-shell-ink focus-visible:outline-none"
              aria-label={t('assistantDialog.deleteCheckLabel', { title: conversation.title })}
              onClick={() => setPendingDelete(conversation.id)}
            >
              <Trash2 size={ICON.sm} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      {/* No reason box: 0164's delete is the user removing their OWN dialogue text (a privacy
          command, not a business mutation) and the definer writes its own audit row. */}
      <ConfirmDialog
        open={pendingDelete !== null}
        danger
        title={t('assistantDialog.title')}
        message={t('assistantDialog.message')}
        confirmLabel={t('assistantDialog.confirmLabel')}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          const id = pendingDelete;
          setPendingDelete(null);
          if (!id) return;
          void deleteAssistantConversation(id)
            .then(() => refetch())
            .catch((e) => setDeleteError(errorText(e)));
        }}
      />
    </div>
  );
}

export default function AssistantDialog({ session, hasBusinessData, onClose, onMobileSourceNavigate }: {
  session: AssistantRunSession;
  hasBusinessData: boolean;
  onClose: () => void;
  onMobileSourceNavigate: () => void;
}) {
  const { t } = useT();
  const { isEnabled } = useFeatureFlags();
  const { profile } = useAuth();
  const desktop = useAssistantDesktopMode();
  const location = useLocation();
  const titleId = useId();
  const descriptionId = useId();
  const {
    authorizationFingerprint,
    question,
    setQuestion,
    submittedQuestion,
    pending,
    result,
    turns,
    conversationId,
    rawError,
    errorText,
    announcement,
    submit,
    restoreHistory,
    resetConversation,
  } = session;

  const { panelRef, requestClose } = useDialogLayer<HTMLDivElement>({
    open: true,
    onClose,
    busy: pending,
    allowCloseWhileBusy: true,
    modal: !desktop,
    initialFocus: (panel) => panel.querySelector<HTMLElement>('textarea'),
  });

  /**
   * The thread follows the conversation (measured defect, 01.09.2026: after three questions the
   * scroller was still at `scrollTop: 0` with 2,426px of content in a 656px port — the answer a
   * person had just asked for was below the fold, and nothing on screen said so).
   *
   * Why this is a FOLLOW and not a single scroll call. The first attempt scrolled once per turn,
   * in a frame after the commit, and still finished 36px short: `CollapsibleAnswer` measures after
   * paint and only then renders its „הצג עוד" control, so the content grew after the scroll had
   * already run. Chasing that with a second frame would be a guess about one layout. Instead the
   * content is observed, and the thread keeps its bottom edge while the reader is at the bottom.
   *
   * `followRef` is what keeps that from being hostile: scroll up to re-read an earlier answer and
   * the thread stops chasing, because a surface that yanks you back to the newest message is worse
   * than one that never scrolled at all. Asking a new question opts back in — that is the one
   * moment a person has said what they want to see.
   */
  const threadRef = useRef<HTMLDivElement>(null);
  const threadContentRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const followRef = useRef(true);

  const scrollThreadToEnd = useCallback((smooth: boolean) => {
    const thread = threadRef.current;
    if (!thread) return;
    // `scrollTo` carries the motion preference; the assignment is the floor that always works,
    // including in jsdom, where the smooth API does not exist at all.
    if (typeof thread.scrollTo === 'function') {
      thread.scrollTo({ top: thread.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    } else {
      thread.scrollTop = thread.scrollHeight;
    }
  }, []);

  useEffect(() => {
    followRef.current = true;
    const smooth = typeof window.matchMedia === 'function'
      && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const frame = requestAnimationFrame(() => scrollThreadToEnd(smooth));
    return () => cancelAnimationFrame(frame);
  }, [turns.length, pending, scrollThreadToEnd]);

  useEffect(() => {
    const content = threadContentRef.current;
    if (!content || typeof ResizeObserver !== 'function') return;
    // Not smooth: this fires for content settling — a control appearing, a font arriving — and
    // animating those would read as the panel drifting on its own.
    const observer = new ResizeObserver(() => {
      if (followRef.current) scrollThreadToEnd(false);
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollThreadToEnd]);

  const showFallback = rawError !== null && needsFallback(rawError);
  const role = profile && isActiveRole(profile.role) ? profile.role : null;
  const canOpenAlerts = role !== null && appRouteAllowsRole('alerts', role);
  const canOpenDashboard = role !== null && appRouteAllowsRole('dashboard', role);
  const examples = role ? assistantExampleKeysFor(role, hasBusinessData) : [];
  const closeForProductNavigation = () => {
    if (!desktop) onMobileSourceNavigate();
  };
  /** `result` is `turns.at(-1)`, so this reads "nothing asked yet under this authorization". */
  const nothingAskedYet = !pending && !result && !errorText;

  /**
   * The sentence that describes the whole surface. It is the target of `aria-describedby`, so it
   * has to exist in every state — but visually it is the empty state's one line of guidance and
   * nothing more. Once the thread has content it keeps doing its job for a screen reader and
   * stops restating itself above every answer.
   */
  const description = t('assistantDialog.text_3');

  return createPortal(
    <div
      id="inplace-assistant-panel"
      ref={panelRef}
      role={desktop ? 'complementary' : 'dialog'}
      aria-modal={desktop ? undefined : true}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-assistant-mode={desktop ? 'docked' : 'fullscreen'}
      tabIndex={-1}
      className="assistant-surface assistant-frame page-fade phone-safe-dialog z-50 overflow-hidden focus:outline-none no-print"
    >
      <div className="assistant-inner relative z-10 flex h-full flex-col overflow-hidden rounded-xl">
        {/* Band 1 of 3 — the titled header. A plain <div> and not <header>: the panel root is a
            `div` carrying an ARIA role rather than a sectioning element, so a nested <header>
            would map to a second `banner` landmark on the page. */}
        <div className="assistant-divider shrink-0 border-b px-4 py-3">
          <div className="flex items-center gap-2">
            {/* Oceanic at full strength, which on this card is now also the contrast step: the
                mark used to be brand-on-paper and is brand-on-dark since the card ruling. The
                reference puts an emoji here; it does not travel (owner: „רק תוריד אימוג'ים").
                The sparkle is the product's own mark and stays. */}
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-action text-on-solid" aria-hidden="true">
              <Sparkles size={ICON.lg} />
            </span>
            <h2 id={titleId} className="min-w-0 flex-1 truncate font-semibold text-shell-ink">{t('assistantDialog.heading', { app: APP_NAME })}</h2>
            {(result || conversationId || errorText) && (
              <button
                type="button"
                className="assistant-focus btn-sm inline-flex items-center gap-1.5 rounded-lg px-2 font-medium text-shell-ink-soft transition-colors hover:bg-assistant-bubble hover:text-shell-ink focus-visible:outline-none disabled:opacity-50"
                disabled={pending}
                onClick={resetConversation}
              >
                <Plus size={ICON.xs} aria-hidden="true" /> {t('assistantDialog.newCheck')}
              </button>
            )}
            <button
              type="button"
              className="assistant-focus grid size-11 shrink-0 place-items-center rounded-full text-shell-ink-soft transition-colors hover:bg-assistant-bubble hover:text-shell-ink focus-visible:outline-none"
              onClick={() => requestClose()}
              aria-label={t('assistantDialog.aria_label')}
            >
              <X size={ICON.lg} aria-hidden="true" />
            </button>
          </div>
          {/* Its own row, indented to the title's start (mark 2.5rem + gap 0.5rem = `ps-12`), and
              never truncated. On the same line as the controls it was the first thing to clip, and
              what clipped was the end of the sentence: at 27.5rem with „בדיקה חדשה” present the
              subtitle read „בדיקה תפעולית מבוססת ר…”, which drops exactly the two words the header
              is required to keep. A promise about what the surface may do cannot be the part that
              ellipsis eats. */}
          <p className="mt-0.5 text-xs leading-snug text-shell-ink-dim ps-12">{t('assistantDialog.text_4')}</p>
        </div>

        {/* Band 2 of 3 — the scrolling conversation, one tonal step below the header and the
            composer so the answers read as paper laid ON the thread instead of as more frame.
            DESIGN.md:541 records the inverse (the answer on `surface-sunken`); the code has
            painted the answer on `.card` since the thread landed. Reported, not silently kept. */}
        {/* `safe center` and not plain `justify-center`: the empty state is the only child while
            the thread is empty, and centring it inside a scroll container is exactly the case
            where ordinary centring puts the overflow above the scrollport and makes it
            unreachable. `safe` falls back to start-alignment the moment the content is taller
            than the panel, and a browser that does not know the keyword drops the declaration
            and lands on the same top-aligned layout. */}
        <div
          ref={threadRef}
          data-assistant-thread
          onScroll={(event) => {
            const thread = event.currentTarget;
            // 96px of slack: "at the bottom" has to survive a rubber-band and a rounding error,
            // or the follow switches itself off the first time the panel settles.
            followRef.current =
              thread.scrollHeight - thread.scrollTop - thread.clientHeight < 96;
          }}
          className={`assistant-scroll flex-1 overflow-y-auto p-4 ${
            nothingAskedYet ? 'flex flex-col [justify-content:safe_center]' : ''}`}
        >
          <div ref={threadContentRef} className="space-y-4">
          {!nothingAskedYet && <p id={descriptionId} className="sr-only">{description}</p>}

          {/*
            The conversation as a thread: every question the person asked and every answer that
            was authorized for it, oldest first. Owner decision 24.08.2026 replaced the earlier
            single-exchange surface — the answer is still an evidence card, not prose in a bubble,
            so a fact keeps its value, its freshness and its source wherever it sits in the thread.
          */}
          {turns.length > 0 && (
            <ol className="space-y-5" aria-label={t('assistantDialog.aria_label_2')}>
              {turns.map((turn) => (
                <li key={turn.result.run_id} className="space-y-2">
                  <UserTurn question={turn.question} />
                  {/* The answer stays a LIGHT evidence card, now floating on a dark thread rather
                      than on cream. That is the same tonal relationship DESIGN.md settled on
                      26.08.2026 — the thread is the well, the answer is paper laid on it — read at
                      a bigger interval. It is also why the dark card cost nothing in legibility:
                      every token inside `AnswerView` still paints on `surface`, so a claim, its
                      facts and its sources keep the contrast they were measured at. */}
                  <div className="card page-fade rounded-ss-sm p-3">
                    <p className="mb-2 text-xs text-ink-muted">
                      {t('assistantDialog.updatedTo')}<span className="num">{fmtDateTime(turn.result.as_of)}</span>
                    </p>
                    {role && (
                      <CollapsibleAnswer>
                        <AnswerView
                          result={turn.result}
                          role={role}
                          onNavigate={closeForProductNavigation}
                        />
                      </CollapsibleAnswer>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}

          {/* The question that is still in flight sits at the end of the thread, as its author. */}
          {pending && submittedQuestion && <UserTurn question={submittedQuestion} />}

          {/* In flight: three dots in the ANSWER's bubble position — the reference's one honest
              idea about waiting, and the only thing on screen saying the run is still going.
              It reports state and nothing else: the dots are `aria-hidden`, the `role="status"`
              sentence is what assistive tech hears, and neither carries a name, an avatar or an
              "…is typing" (DESIGN.md:515). The pulse keeps running under reduced motion for the
              same reason index.css:1163 keeps `.animate-spin` running — stopping the only live
              signal reads as a hang — and at 2s it is already calmer than the slowed spinner. */}
          {pending && (
            <div role="status" aria-busy="true" className="page-fade flex justify-start">
              <span className="sr-only">{t('assistantDialog.text_5')}</span>
              <span data-assistant-typing className="flex items-center gap-1.5 rounded-2xl rounded-ss-sm bg-assistant-bubble px-4 py-4" aria-hidden="true">
                <span className="size-2 animate-pulse rounded-full bg-shell-ink-soft [animation-delay:0ms]" />
                <span className="size-2 animate-pulse rounded-full bg-shell-ink-soft [animation-delay:200ms]" />
                <span className="size-2 animate-pulse rounded-full bg-shell-ink-soft [animation-delay:400ms]" />
              </span>
            </div>
          )}

          {/* A failed run leaves no turn, so its question would otherwise vanish with the error. */}
          {!pending && errorText && submittedQuestion && <UserTurn question={submittedQuestion} />}

          {!pending && errorText && (
            <div className="space-y-3">
              <ErrorNote message={errorText} />
              {showFallback && canOpenDashboard && (
                <Note tone="info">
                  <span className="min-w-0 flex-1">
                    {t('assistantDialog.screensStillWork')}{' '}
                    {canOpenAlerts && (
                      <>
                        <Link to={APP_ROUTE_POLICY.alerts.path} onClick={closeForProductNavigation} className="underline underline-offset-2">
                          {t('assistantDialog.text_6')}
                        </Link>{' '}
                        {t('assistantDialog.text_7')}
                      </>
                    )}
                    <Link to={APP_ROUTE_POLICY.dashboard.path} onClick={closeForProductNavigation} className="underline underline-offset-2">
                      {t('assistantDialog.text_8')}
                    </Link>{' '}
                    {t('assistantDialog.text_9')}
                  </span>
                </Note>
              )}
            </div>
          )}

          {/* A real empty state instead of a blank area: the mark, the question this surface
              exists to ask, one line of guidance — and only then the openings this role is
              actually allowed to take. */}
          {nothingAskedYet && (
            <section aria-labelledby={`${titleId}-start`} className="page-fade mx-auto w-full max-w-sm">
              <div className="flex flex-col items-center pt-2 text-center">
                <span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-action text-on-solid" aria-hidden="true">
                  <Sparkles size={ICON.xl} />
                </span>
                <h3 id={`${titleId}-start`} className="mt-3 text-base font-semibold text-shell-ink">{t('assistantDialog.whatToCheck')}</h3>
                <p id={descriptionId} className="mt-1 text-sm leading-relaxed text-shell-ink-dim">{description}</p>
              </div>
              {examples.length > 0 && (
                <>
                  <p className="mt-6 text-xs font-medium text-shell-ink-dim">{t('assistantDialog.text_10')}</p>
                  {/* A soft step ON the card, which is what the reference's `white/10` bubbles are
                      in a palette that has an Onyx. They used to be paper on paper; on a dark card
                      paper would be six white slabs in a column, which is the "block of colour
                      belonging to no other screen" the 26.08.2026 report was about, inverted.
                      ONE CLICK SENDS (measured defect, 01.09.2026): filling the box and waiting
                      for a second press contradicted this file's own note on the list above, and
                      cost a person two actions for a question the product wrote for them. */}
                  <div className="mt-2 flex flex-col gap-2">
                    {examples.map((exampleKey) => (
                      <button
                        key={exampleKey}
                        type="button"
                        className="assistant-focus min-h-11 rounded-2xl bg-assistant-bubble px-4 text-start text-sm font-medium text-shell-ink transition-colors hover:bg-assistant-bubble-hover focus-visible:outline-none disabled:opacity-60"
                        disabled={pending}
                        onClick={() => {
                          /* Focus moves to the composer BEFORE the run starts, because sending
                             unmounts this whole empty state and takes the focused button with it
                             — the same defect as a disabled composer, arriving by a different
                             road (measured 01.09.2026: `activeElement` was `<body>` right after
                             a suggestion was clicked). The composer is where the next question
                             is typed, so this is also where focus wanted to be. */
                          composerRef.current?.focus();
                          void submit(location.pathname, t(exampleKey));
                        }}
                      >
                        {t(exampleKey)}
                      </button>
                    ))}
                  </div>
                </>
              )}
              {isEnabled(ASSISTANT_FLAG_KEYS.history) && (
                <div className="mt-6">
                  <ConversationHistory
                    authorizationFingerprint={authorizationFingerprint}
                    onOpen={(restored, expected) => restoreHistory(restored, expected)}
                  />
                </div>
              )}
            </section>
          )}
          </div>
        </div>

        {/* Band 3 of 3 — the composer, pinned. The reference puts the field and the send button
            side by side rather than nesting the button inside the field, and that shape is what
            removed the overhang this comment used to describe: a 44px disc can no longer cross a
            corner it does not sit in. */}
        <form
          className="assistant-divider shrink-0 border-t p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(location.pathname);
          }}
        >
          <div className="flex items-end gap-2">
            <textarea
              ref={composerRef}
              /* `readOnly`, NOT `disabled`, while a run is in flight (measured defect,
                 01.09.2026: `document.activeElement` was `<body>` 200ms after submit). A disabled
                 control cannot hold focus, so the browser moved focus out of the panel — and on
                 mobile the panel is `aria-modal`, so the focus trap it depends on was broken by
                 its own composer. `readOnly` refuses the edit and keeps the caret; the submit
                 paths are guarded below and in `submit()` itself, which returns the in-flight
                 promise rather than starting a second run. */
              className="assistant-field max-h-32 min-w-0 flex-1 resize-none"
              rows={2}
              maxLength={ASSISTANT_QUESTION_MAX_CHARS}
              placeholder={examples[0] ? t(examples[0]) : t('assistantDialog.text_11')}
              aria-label={t('assistantDialog.aria_label_3')}
              value={question}
              readOnly={pending}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  if (!pending) void submit(location.pathname);
                }
              }}
            />
            <button
              type="submit"
              className="assistant-focus grid size-11 shrink-0 place-items-center rounded-xl bg-action text-on-solid transition-colors hover:bg-action-solid focus-visible:outline-none disabled:opacity-45"
              aria-label={pending ? t('assistantDialog.text_12') : t('assistantDialog.text_13')}
              disabled={pending || !question.trim()}
            >
              {pending
                ? <Loader2 size={ICON.md} className="animate-spin" aria-hidden="true" />
                : <Send size={ICON.md} aria-hidden="true" />}
            </button>
          </div>
        </form>

        <div aria-live="polite" className="sr-only">{announcement}</div>
      </div>
    </div>,
    document.body,
  );
}
