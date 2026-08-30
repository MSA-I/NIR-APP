import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router';
import { Loader2, RotateCcw, Send, Sparkles, Trash2, X } from 'lucide-react';
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
import { toHebrewError } from '../../lib/errors';
import { useFeatureFlags } from '../../lib/flags';
import { APP_NAME } from '../../lib/branding';
import { fmtDateTime } from '../../lib/format';
import { useAuth } from '../../auth/AuthContext';
import { isActiveRole } from '../../lib/types';
import { APP_ROUTE_POLICY, appRouteAllowsRole } from '../../lib/routePolicy';
import { ConfirmDialog, ErrorNote, ICON, Note, Skeleton, useDialogLayer } from '../ui';
import AnswerView from './AnswerView';

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
 * The openings each role is offered — six per role since 26.08.2026 (owner: "צריך להוסיף יותר
 * הצעות מבחינת השאלות"). Two was not a menu, it was a pair of samples, and a person who wanted
 * neither of them was left facing an empty box with no idea what this surface can be asked.
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
const ROLE_EXAMPLES = {
  owner: [
    'מה דורש טיפול עכשיו?',
    'איך נראית תמונת המצב העסקית החודש?',
    'כמה כסף ממתין לזיכוי?',
    'אילו מוצרים התייקרו החודש?',
    'מה החשיפה לתשלומים בשבוע הקרוב?',
    'אילו תנועות בנק אינן מותאמות?',
  ],
  office: [
    'מה דורש טיפול עכשיו?',
    'למה החשבונית חסומה?',
    'אילו הזמנות נשלחו ולא אושרו?',
    'אילו מוצרים התייקרו החודש?',
    'אילו ספקים מאחרים באספקה?',
    'אילו פריטים במלאי בסיכון?',
  ],
  accountant: [
    'אילו תנועות בנק אינן מותאמות?',
    'מה דורש טיפול עכשיו?',
    'למה החשבונית חסומה?',
    'כמה חשבוניות נקלטו ב־7 הימים האחרונים?',
    'האם ההזמנה, הקבלה והחשבונית מתאימות זו לזו?',
    'איפה רואים חשבוניות שממתינות לאישור?',
  ],
} as const;

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
      <h3 className="mb-1 text-xs font-medium text-ink-muted">בדיקות קודמות</h3>
      {loading && (
        <div role="status" aria-busy="true" className="space-y-2 py-1">
          <span className="sr-only">טוען שיחות קודמות</span>
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      )}
      {openError && <ErrorNote message={openError} />}
      {deleteError && <ErrorNote message={deleteError} />}
      <ul className="divide-y divide-line-soft">
        {(data ?? []).map((conversation) => (
          <li key={conversation.id} className="flex min-h-11 items-center gap-2 py-1">
            <button
              type="button"
              className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-start transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              disabled={openingId !== null}
              aria-label={`פתיחת הבדיקה ${conversation.title}`}
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
                    setOpenError(toHebrewError(e));
                  });
              }}
            >
              <span className="min-w-0 flex-1 truncate text-sm text-ink-body">{conversation.title}</span>
              <span className="num shrink-0 text-xs text-ink-muted">{fmtDateTime(conversation.updated_at)}</span>
                {openingId === conversation.id && <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" />}
            </button>
            <button
              type="button"
              className="btn-ghost btn-icon rounded-full"
              aria-label={`מחיקת הבדיקה ${conversation.title}`}
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
        title="מחיקת בדיקה"
        message="השאלה והממצאים שנשמרו בבדיקה יימחקו. הנתונים העסקיים עצמם אינם מושפעים."
        confirmLabel="מחיקה"
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          const id = pendingDelete;
          setPendingDelete(null);
          if (!id) return;
          void deleteAssistantConversation(id)
            .then(() => refetch())
            .catch((e) => setDeleteError(toHebrewError(e)));
        }}
      />
    </div>
  );
}

export default function AssistantDialog({ session, onClose, onMobileSourceNavigate }: {
  session: AssistantRunSession;
  onClose: () => void;
  onMobileSourceNavigate: () => void;
}) {
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

  const showFallback = rawError !== null && needsFallback(rawError);
  const role = profile && isActiveRole(profile.role) ? profile.role : null;
  const canOpenAlerts = role !== null && appRouteAllowsRole('alerts', role);
  const canOpenDashboard = role !== null && appRouteAllowsRole('dashboard', role);
  const examples = role ? ROLE_EXAMPLES[role] : [];
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
  const description = 'העוזר מציג רק נתונים שהמערכת מדדה, ולכל ממצא מצרף עדכניות ומקור לבדיקה.';

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
      className="assistant-surface page-fade phone-safe-dialog z-50 flex flex-col bg-surface focus:outline-none no-print"
    >
        {/* Band 1 of 3 — the titled header. A plain <div> and not <header>: the panel root is a
            `div` carrying an ARIA role rather than a sectioning element, so a nested <header>
            would map to a second `banner` landmark on the page. */}
        <div className="shrink-0 border-b border-line-soft bg-surface px-4 py-3">
          <div className="flex items-center gap-2">
            {/* SOLID oceanic, not the pale wash it wore before (owner report 26.08.2026: the
                assistant "carries colours from the old palette"). The wash is a cool
                near-white — `action-wash` is oklch(96.6% .011 195) — and this panel is painted
                on warm cream paper (`surface-sunken`, hue 80). Two near-whites from opposite
                sides of neutral in one 40px square is what read as a leftover from another
                palette: too little chroma to be a brand mark, enough to fight the paper. The
                brand keeps its one place in the header by being the brand, at full strength. */}
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-action text-on-solid" aria-hidden="true">
              <Sparkles size={ICON.lg} />
            </span>
            <h2 id={titleId} className="min-w-0 flex-1 truncate font-semibold text-ink">העוזר של {APP_NAME}</h2>
            {(result || conversationId) && (
              <button
                type="button"
                className="btn-ghost btn-sm"
                disabled={pending}
                onClick={resetConversation}
              >
                <RotateCcw size={ICON.xs} aria-hidden="true" /> בדיקה חדשה
              </button>
            )}
            <button type="button" className="btn-ghost btn-icon rounded-full" onClick={() => requestClose()} aria-label="סגירת הבדיקה">
              <X size={ICON.lg} aria-hidden="true" />
            </button>
          </div>
          {/* Its own row, indented to the title's start (mark 2.5rem + gap 0.5rem = `ps-12`), and
              never truncated. On the same line as the controls it was the first thing to clip, and
              what clipped was the end of the sentence: at 27.5rem with „בדיקה חדשה” present the
              subtitle read „בדיקה תפעולית מבוססת ר…”, which drops exactly the two words the header
              is required to keep. A promise about what the surface may do cannot be the part that
              ellipsis eats. */}
          <p className="mt-0.5 text-xs leading-snug text-ink-muted ps-12">בדיקה תפעולית מבוססת ראיות · לקריאה בלבד</p>
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
        <div className={`flex-1 space-y-4 overflow-y-auto bg-surface-sunken p-4 ${
          nothingAskedYet ? 'flex flex-col [justify-content:safe_center]' : ''}`}>
          {!nothingAskedYet && <p id={descriptionId} className="sr-only">{description}</p>}

          {/*
            The conversation as a thread: every question the person asked and every answer that
            was authorized for it, oldest first. Owner decision 24.08.2026 replaced the earlier
            single-exchange surface — the answer is still an evidence card, not prose in a bubble,
            so a fact keeps its value, its freshness and its source wherever it sits in the thread.
          */}
          {turns.length > 0 && (
            <ol className="space-y-5" aria-label="השיחה עם העוזר">
              {turns.map((turn) => (
                <li key={turn.result.run_id} className="space-y-2">
                  <UserTurn question={turn.question} />
                  <div className="card page-fade rounded-ss-sm p-3">
                    <p className="mb-2 text-xs text-ink-muted">
                      עודכן ל־<span className="num">{fmtDateTime(turn.result.as_of)}</span>
                    </p>
                    {role && (
                      <AnswerView
                        result={turn.result}
                        role={role}
                        onNavigate={closeForProductNavigation}
                      />
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
              <span className="sr-only">בודק את הנתונים המורשים</span>
              <span data-assistant-typing className="card flex items-center gap-1.5 rounded-ss-sm px-4 py-4" aria-hidden="true">
                <span className="size-2 animate-pulse rounded-full bg-action [animation-delay:0ms]" />
                <span className="size-2 animate-pulse rounded-full bg-action [animation-delay:200ms]" />
                <span className="size-2 animate-pulse rounded-full bg-action [animation-delay:400ms]" />
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
                    המסכים ממשיכים לעבוד גם בלי העוזר:{' '}
                    {canOpenAlerts && (
                      <>
                        <Link to={APP_ROUTE_POLICY.alerts.path} onClick={closeForProductNavigation} className="underline underline-offset-2">
                          מסך ההתראות
                        </Link>{' '}
                        סורק מה דורש טיפול, ו
                      </>
                    )}
                    <Link to={APP_ROUTE_POLICY.dashboard.path} onClick={closeForProductNavigation} className="underline underline-offset-2">
                      מרכז הבקרה
                    </Link>{' '}
                    מציג את תמונת המצב המלאה.
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
                <h3 id={`${titleId}-start`} className="section-title mt-3">מה תרצה לבדוק?</h3>
                <p id={descriptionId} className="mt-1 text-sm leading-relaxed text-ink-muted">{description}</p>
              </div>
              {examples.length > 0 && (
                <>
                  <p className="mt-6 text-xs font-medium text-ink-muted">אפשר להתחיל מדוגמה שמתאימה להרשאות שלך.</p>
                  {/* Paper on paper, not a wash. Six of these stacked in the old cool tint turned
                      the empty state into a block of colour that belonged to no other screen; as
                      cards on the sunken band they read the way every other list of choices in
                      the product reads, and the hover is the app's one neutral pointer step. */}
                  <div className="mt-2 flex flex-col gap-2">
                    {examples.map((example) => (
                      <button
                        key={example}
                        type="button"
                        className="row-hover min-h-11 rounded-2xl border border-line-soft bg-surface px-4 text-start text-sm font-medium text-ink-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                        onClick={() => setQuestion(example)}
                      >
                        {example}
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

        {/* Band 3 of 3 — the composer, pinned. The send control sits INSIDE the field's trailing
            edge, so the pill IS the field: `.input` keeps the 3:1 boundary and owns the focus
            ring (focus belongs to the control that receives it, not to a wrapper), `rounded-3xl`
            is the house 24px, and `pe-14` is the lane the button stands in. Empty and in-flight
            are the button's two disabled states, which `btn` already paints. */}
        <form
          className="shrink-0 border-t border-line-soft bg-surface p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(location.pathname);
          }}
        >
          <div className="relative">
            <textarea
              /* `rounded-2xl`, not `3xl`: measured, not tasted. The field is 58px tall and the
                 send disc is the 44px touch minimum, which leaves 7px of margin — and a 24px
                 corner eats 24px of the edge, so the disc crossed the curve by 2.4px at the
                 bottom-start corner and appeared to hang outside the pill. 16px leaves the disc
                 4.8px of clear straight edge at its widest point. */
              className="input resize-none rounded-2xl pe-14"
              rows={2}
              maxLength={ASSISTANT_QUESTION_MAX_CHARS}
              placeholder={examples[0] ?? 'מה תרצה לבדוק?'}
              aria-label="שאלה לבדיקה"
              value={question}
              disabled={pending}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void submit(location.pathname);
                }
              }}
            />
            {/* CENTRED in the field, not pinned to its bottom corner (owner report 26.08.2026).
                `bottom-1.5 end-1.5` put a 44px disc 6px from a corner whose radius is 24px, so
                the disc crossed the curve and hung outside the pill — the composer looked broken
                rather than styled. Centring keeps it inside the straight part of the edge at any
                field height, which is the property that matters here: the textarea is two rows
                today and a taller composer must not reintroduce the overhang. */}
            <button
              type="submit"
              className="btn-primary btn-icon absolute end-2.5 top-1/2 -translate-y-1/2 rounded-full"
              aria-label={pending ? 'שולח' : 'בדיקה'}
              disabled={pending || !question.trim()}
            >
              {pending
                ? <Loader2 size={ICON.md} className="animate-spin" aria-hidden="true" />
                : <Send size={ICON.md} aria-hidden="true" />}
            </button>
          </div>
        </form>

        <div aria-live="polite" className="sr-only">{announcement}</div>
    </div>,
    document.body,
  );
}
