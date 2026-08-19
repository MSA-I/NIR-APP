import { useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router';
import { Loader2, RotateCcw, Send, Trash2, X } from 'lucide-react';
import {
  ASSISTANT_FLAG_KEYS,
  ASSISTANT_QUESTION_MAX_CHARS,
  type AssistantRunResult,
} from '../../lib/assistant/contracts';
import {
  askAssistant,
  deleteAssistantConversation,
  useAssistantConversations,
} from '../../lib/assistant/client';
import { toHebrewError } from '../../lib/errors';
import { useFeatureFlags } from '../../lib/flags';
import { APP_NAME } from '../../lib/branding';
import { fmtDateTime } from '../../lib/format';
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

function needsFallback(rawError: string): boolean {
  return FALLBACK_CODES.some((code) => rawError.includes(code));
}

/**
 * Stored history, mounted only while `assistant.history` is on — off means runs are not stored,
 * and fetching an empty table just to prove it would be noise. Rows arrive through RLS.
 */
function ConversationHistory() {
  const { data, loading, error, refetch } = useAssistantConversations();
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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
      <h3 className="mb-1 text-xs font-medium text-ink-muted">שיחות קודמות</h3>
      {deleteError && <ErrorNote message={deleteError} />}
      <ul className="divide-y divide-line-soft">
        {data.map((conversation) => (
          <li key={conversation.id} className="flex min-h-11 items-center gap-2 py-1">
            <span className="min-w-0 flex-1 truncate text-sm text-ink-body">
              {conversation.title || 'שיחה ללא כותרת'}
            </span>
            <span className="num shrink-0 text-xs text-ink-muted">{fmtDateTime(conversation.updated_at)}</span>
            <button
              type="button"
              className="btn-ghost p-1.5! min-h-9 min-w-9"
              aria-label={`מחיקת השיחה ${conversation.title || 'ללא כותרת'}`}
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
        title="מחיקת שיחה"
        message="השיחה והתשובות שנשמרו בה יימחקו. הנתונים העסקיים עצמם אינם מושפעים."
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

export default function AssistantDialog({ onClose }: { onClose: () => void }) {
  const { isEnabled } = useFeatureFlags();
  const location = useLocation();
  const titleId = useId();
  const descriptionId = useId();

  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<AssistantRunResult | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [rawError, setRawError] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  // Announced ONCE per settled run. The answer arrives as one payload (see client.ts), so there
  // is nothing incremental to narrate — the region speaks only when the result is final.
  const [announcement, setAnnouncement] = useState('');

  const { panelRef, requestClose } = useDialogLayer<HTMLDivElement>({
    open: true,
    onClose,
    busy: pending,
    allowCloseWhileBusy: true,
    initialFocus: (panel) => panel.querySelector<HTMLElement>('textarea'),
  });

  async function submit() {
    const trimmed = question.trim();
    if (!trimmed || pending) return;
    setPending(true);
    setRawError(null);
    setErrorText(null);
    try {
      const run = await askAssistant({
        question: trimmed,
        conversation_id: conversationId,
        // Context only — the server treats it as neither authorization nor a data filter.
        route: location.pathname.slice(0, 200),
      });
      setResult(run);
      setConversationId(run.conversation_id);
      setQuestion('');
      setAnnouncement('התקבלה תשובה מהעוזר');
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      setRawError(raw);
      setErrorText(toHebrewError(e));
      setAnnouncement('הבקשה נכשלה');
    } finally {
      setPending(false);
    }
  }

  function resetConversation() {
    setResult(null);
    setConversationId(null);
    setRawError(null);
    setErrorText(null);
    setAnnouncement('');
  }

  const showFallback = rawError !== null && needsFallback(rawError);

  return createPortal(
    <div className="fixed inset-0 z-50 bg-shell/50 no-print" onClick={() => requestClose()}>
      {/* Mobile: full-screen at 100dvh behind the safe-area paddings. Desktop: an end-anchored
          panel on the dialog shadow. Entrance rides the shared page-fade (150ms ease-out, cancelled
          under prefers-reduced-motion by index.css) — no decorative motion of its own. */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        className="page-fade phone-safe-dialog absolute inset-x-0 top-0 flex h-dvh w-full flex-col bg-surface focus:outline-none sm:inset-x-auto sm:end-4 sm:top-4 sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:w-[27rem] sm:rounded-2xl sm:shadow-dialog sm:ring-1 sm:ring-line-soft"
      >
        <div className="flex items-center gap-2 border-b border-line-soft px-4 py-3">
          <h2 id={titleId} className="min-w-0 flex-1 truncate font-semibold text-ink">
            העוזר של {APP_NAME}
          </h2>
          {(result || conversationId) && (
            <button type="button" className="btn-ghost gap-1 px-2! py-1! text-xs" onClick={resetConversation}>
              <RotateCcw size={13} aria-hidden="true" /> שיחה חדשה
            </button>
          )}
          <button type="button" className="btn-ghost p-1.5! min-h-11 min-w-11" onClick={() => requestClose()} aria-label="סגירה">
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <p id={descriptionId} className="text-xs text-ink-muted">
            העוזר עונה רק על סמך נתונים שהמערכת חישבה, ומצרף לכל מספר את המקור שבו אפשר לבדוק אותו.
          </p>

          {pending && (
            <div role="status" aria-busy="true" className="space-y-2">
              <span className="sr-only">העוזר בודק את הנתונים</span>
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          )}

          {!pending && errorText && (
            <div className="space-y-3">
              <ErrorNote message={errorText} />
              {showFallback && (
                <Note tone="info">
                  <span className="min-w-0 flex-1">
                    המסכים ממשיכים לעבוד גם בלי העוזר:{' '}
                    <Link to="/alerts" onClick={() => requestClose()} className="underline underline-offset-2">
                      מסך ההתראות
                    </Link>{' '}
                    סורק מה דורש טיפול, ו
                    <Link to="/dashboard" onClick={() => requestClose()} className="underline underline-offset-2">
                      מרכז הבקרה
                    </Link>{' '}
                    מציג את תמונת המצב המלאה.
                  </span>
                </Note>
              )}
            </div>
          )}

          {!pending && !errorText && result && <AnswerView result={result} onNavigate={() => requestClose()} />}

          {!pending && !result && !errorText && isEnabled(ASSISTANT_FLAG_KEYS.history) && <ConversationHistory />}
        </div>

        <form
          className="border-t border-line-soft p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="flex items-end gap-2">
            <textarea
              className="input min-h-11 flex-1 resize-none"
              rows={2}
              maxLength={ASSISTANT_QUESTION_MAX_CHARS}
              placeholder="מה תרצה לבדוק? למשל: אילו חשבוניות חורגות מהיתרה?"
              aria-label="שאלה לעוזר"
              value={question}
              disabled={pending}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <button type="submit" className="btn-primary min-h-11" disabled={pending || !question.trim()}>
              {pending
                ? <><Loader2 size={16} className="animate-spin" aria-hidden="true" /><span className="sr-only">שולח</span></>
                : <><Send size={16} aria-hidden="true" /> שאל</>}
            </button>
          </div>
        </form>

        <div aria-live="polite" className="sr-only">{announcement}</div>
      </div>
    </div>,
    document.body,
  );
}
