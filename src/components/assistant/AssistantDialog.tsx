import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router';
import { ClipboardCheck, Loader2, RotateCcw, Send, Trash2, X } from 'lucide-react';
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
import { ConfirmDialog, ErrorNote, Note, Skeleton, useDialogLayer } from '../ui';
import AnswerView from './AnswerView';

/**
 * Refusals with a working deterministic alternative. For these the panel does not stop at the
 * Hebrew sentence — it wires the user to the screens that keep answering without any model:
 * /alerts scans what needs attention, /dashboard holds the live picture. A dead end here would
 * make the assistant look load-bearing when it is deliberately not.
 */
const FALLBACK_CODES = [
  'assistant_disabled',
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

const ROLE_EXAMPLES = {
  owner: ['כמה כסף ממתין לזיכוי?', 'כמה חשבוניות נקלטו ב־7 הימים האחרונים?'],
  office: ['למה החשבונית חסומה?', 'אילו הזמנות נשלחו ולא אושרו?'],
  accountant: ['אילו תנועות בנק אינן מותאמות?', 'כמה כסף ממתין לזיכוי?'],
} as const;

function needsFallback(rawError: string): boolean {
  return FALLBACK_CODES.some((code) => rawError.includes(code));
}

/**
 * Stored history, mounted only while `assistant.history` is on — off means runs are not stored,
 * and fetching an empty table just to prove it would be noise. Rows arrive through RLS.
 */
function ConversationHistory({ authorizationFingerprint, onOpen }: {
  authorizationFingerprint: string;
  onOpen: (view: AssistantHistoryView, expectedAuthorizationFingerprint: string) => void;
}) {
  const { data, loading, error, refetch } = useAssistantConversations(authorizationFingerprint);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  if (loading) {
    return (
      <div role="status" aria-busy="true" className="space-y-2">
        <span className="sr-only">טוען שיחות קודמות</span>
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }
  if (error) return <ErrorNote message={error} />;
  if (!data || data.length === 0) return null;

  return (
    <div>
      <h3 className="mb-1 text-xs font-medium text-ink-muted">בדיקות קודמות</h3>
      {openError && <ErrorNote message={openError} />}
      {deleteError && <ErrorNote message={deleteError} />}
      <ul className="divide-y divide-line-soft">
        {data.map((conversation) => (
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
                  .then((view) => {
                    setOpeningId(null);
                    onOpen(view, expectedAuthorizationFingerprint);
                  })
                  .catch((e) => {
                    setOpeningId(null);
                    setOpenError(toHebrewError(e));
                  });
              }}
            >
              <span className="min-w-0 flex-1 truncate text-sm text-ink-body">{conversation.title}</span>
              <span className="num shrink-0 text-xs text-ink-muted">{fmtDateTime(conversation.updated_at)}</span>
              {openingId === conversation.id && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            </button>
            <button
              type="button"
              className="btn-ghost p-1.5! min-h-11 min-w-11"
              aria-label={`מחיקת הבדיקה ${conversation.title}`}
              onClick={() => setPendingDelete(conversation.id)}
            >
              <Trash2 size={14} aria-hidden="true" />
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
        <div className="flex items-center gap-2 border-b border-line-soft px-4 py-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-action-wash text-action" aria-hidden="true">
            <ClipboardCheck size={19} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate font-semibold text-ink">העוזר של {APP_NAME}</h2>
            <p className="truncate text-xs text-ink-muted">בדיקה תפעולית מבוססת ראיות · לקריאה בלבד</p>
          </div>
          {(result || conversationId) && (
            <button
              type="button"
              className="btn-ghost gap-1 px-2! py-1! text-xs"
              disabled={pending}
              onClick={resetConversation}
            >
              <RotateCcw size={13} aria-hidden="true" /> בדיקה חדשה
            </button>
          )}
          <button type="button" className="btn-ghost p-1.5! min-h-11 min-w-11" onClick={() => requestClose()} aria-label="סגירת הבדיקה">
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <p id={descriptionId} className="text-xs text-ink-muted">
            העוזר מציג רק נתונים שהמערכת מדדה, ולכל ממצא מצרף עדכניות ומקור לבדיקה.
          </p>

          {submittedQuestion && (
            <section className="rounded-lg bg-surface-sunken p-3" aria-labelledby={`${titleId}-question`}>
              <h3 id={`${titleId}-question`} className="text-xs font-medium text-ink-muted">השאלה שנבדקה</h3>
              <p className="mt-1 text-sm font-medium leading-relaxed text-ink">{submittedQuestion}</p>
              {result && (
                <p className="mt-2 text-xs text-ink-muted">
                  עודכן ל־<span className="num">{fmtDateTime(result.as_of)}</span>
                </p>
              )}
            </section>
          )}

          {pending && (
            <div role="status" aria-busy="true" className="space-y-2">
              <span className="sr-only">בודק את הנתונים המורשים</span>
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          )}

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

          {!pending && !errorText && result && role && (
            <AnswerView result={result} role={role} onNavigate={closeForProductNavigation} />
          )}

          {!pending && !result && !errorText && (
            <section aria-labelledby={`${titleId}-start`}>
              <h3 id={`${titleId}-start`} className="section-title">מה תרצה לבדוק?</h3>
              <p className="mt-1 text-sm text-ink-muted">אפשר להתחיל מדוגמה שמתאימה להרשאות שלך.</p>
              <div className="mt-3 flex flex-col gap-2">
                {examples.map((example) => (
                  <button
                    key={example}
                    type="button"
                    className="min-h-11 rounded-lg bg-action-wash px-3 text-start text-sm font-medium text-action-on-soft transition-colors hover:bg-action-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    onClick={() => setQuestion(example)}
                  >
                    {example}
                  </button>
                ))}
              </div>
              {isEnabled(ASSISTANT_FLAG_KEYS.history) && (
                <div className="mt-5">
                  <ConversationHistory
                    authorizationFingerprint={authorizationFingerprint}
                    onOpen={(view, expected) => restoreHistory(view, expected)}
                  />
                </div>
              )}
            </section>
          )}
        </div>

        <form
          className="border-t border-line-soft p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(location.pathname);
          }}
        >
          <div className="flex items-end gap-2">
            <textarea
              className="input min-h-11 flex-1 resize-none"
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
            <button type="submit" className="btn-primary min-h-11" disabled={pending || !question.trim()}>
              {pending
                ? <><Loader2 size={16} className="animate-spin" aria-hidden="true" /><span className="sr-only">שולח</span></>
                : <><Send size={16} aria-hidden="true" /> בדיקה</>}
            </button>
          </div>
        </form>

        <div aria-live="polite" className="sr-only">{announcement}</div>
    </div>,
    document.body,
  );
}
