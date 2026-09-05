import { useT } from '../i18n/LocaleProvider';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { askAssistant } from './client';
import type { AssistantHistoryView, AssistantRunResult } from './contracts';

/** One settled exchange: what was asked, and the answer that was authorized for it. */
export interface AssistantTurn {
  question: string;
  result: AssistantRunResult;
}

export interface AssistantRunSession {
  authorizationFingerprint: string;
  question: string;
  setQuestion: (question: string) => void;
  /** The exact question whose pending/result state is on screen. */
  submittedQuestion: string | null;
  pending: boolean;
  result: AssistantRunResult | null;
  /**
   * The conversation as a thread, oldest turn first. A run appends; it does not replace. The
   * single `result` above stays the newest turn's result so every existing reader is unchanged.
   */
  turns: AssistantTurn[];
  conversationId: string | null;
  rawError: string | null;
  errorText: string | null;
  announcement: string;
  /**
   * Starts one run, or returns the already-running promise.
   *
   * `askDirectly` exists for the suggested questions. Before 01.09.2026 a suggestion only filled
   * the box and the person had to press send — while the code that owns the list said, in as many
   * words, "Clicking one SENDS it". State could not carry the text: `setQuestion` schedules a
   * render, and `submit` in the same handler would still read the previous value and refuse an
   * empty question. Passing the text is the whole fix, and it keeps the trimming, the in-flight
   * guard and the authorization epoch in one place instead of duplicating them at the call site.
   */
  submit: (route: string | null, askDirectly?: string) => Promise<boolean>;
  /**
   * The person asked for this thread — they pressed a stored conversation in the list. An explicit
   * request may replace what is on screen, including a question they just asked.
   */
  restoreHistory: (
    turns: readonly AssistantHistoryView[],
    expectedAuthorizationFingerprint: string,
  ) => boolean;
  /**
   * Nobody asked for this thread — the panel offers it when it opens onto an empty session. That
   * convenience must never cost the person anything, so it refuses the moment this panel session
   * has produced a question at all. Same write as `restoreHistory`, stricter entry condition; the
   * two are separate because only this one is racing a person.
   */
  adoptHistory: (
    turns: readonly AssistantHistoryView[],
    expectedAuthorizationFingerprint: string,
  ) => boolean;
  resetConversation: () => void;
}

export interface AssistantAuthorizationFingerprintInput {
  userId: string | null | undefined;
  profileId: string | null | undefined;
  orgId: string | null | undefined;
  role: string | null | undefined;
  profileActive: boolean | null | undefined;
  orgStatus: string | null | undefined;
  accessMode: string | null | undefined;
  accessStatus: string | null | undefined;
}

/**
 * Stable, non-secret identity of the authorization state that may keep one assistant result in
 * browser memory. Access tokens are deliberately excluded; actor, tenant, role, lifecycle and
 * organization-access changes are the dimensions the application resolves and can observe.
 */
export function assistantAuthorizationFingerprint(
  input: AssistantAuthorizationFingerprintInput,
): string {
  return JSON.stringify([
    input.userId ?? null,
    input.profileId ?? null,
    input.orgId ?? null,
    input.role ?? null,
    input.profileActive ?? null,
    input.orgStatus ?? null,
    input.accessMode ?? null,
    input.accessStatus ?? null,
  ]);
}

/**
 * One run lifecycle owned above the dialog.
 *
 * Closing the dialog is deliberately not cancellation: a browser abort cannot prove the model
 * provider did not already accept a paid request. The promise therefore stays here while the
 * dialog is unmounted, and reopening observes the same pending/result state. `inFlightRef` is the
 * synchronous duplicate-spend guard — React state alone can lag one event behind a second submit.
 */
export function useAssistantRunSession(
  authorizationFingerprint = 'assistant-authorization-unscoped',
): AssistantRunSession {
  const { errorText: resolveError, locale, t } = useT();
  const [question, setQuestion] = useState('');
  const [submittedQuestion, setSubmittedQuestion] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [turns, setTurns] = useState<AssistantTurn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [rawError, setRawError] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const inFlightRef = useRef<Promise<boolean> | null>(null);
  /**
   * Has this panel session produced a question at all — which is NOT "is a request in flight".
   * `inFlightRef` is cleared the instant a run settles, while the panel's adoption path re-checks
   * its guard only after two awaits (list the conversations, then load the newest one). A question
   * asked and SETTLED inside that window therefore satisfied the in-flight check and had its
   * question, its answer and its error overwritten by an older answer to a different question.
   * Fast outcomes — every error path — are precisely the ones that land inside the window, which
   * is why the loss was most visible when something had already gone wrong.
   *
   * Deliberately not cleared by `resetConversation`: "בדיקה חדשה" empties the thread, and dragging
   * the old one back in its place is the same surprise from the other direction. Only a new
   * authorization clears it, because that is a different person.
   */
  const askedRef = useRef(false);
  const authorizationRef = useRef(authorizationFingerprint);
  const authorizationEpochRef = useRef(0);
  const authorizationChanged = authorizationRef.current !== authorizationFingerprint;

  useLayoutEffect(() => {
    if (authorizationRef.current === authorizationFingerprint) return;

    // Invalidate before clearing: a response that was authorized under the previous role/org may
    // still settle because aborting a browser request cannot undo provider spend. Its epoch no
    // longer matches, so it cannot write any state under the new authorization context.
    authorizationRef.current = authorizationFingerprint;
    authorizationEpochRef.current += 1;
    inFlightRef.current = null;
    askedRef.current = false;
    setQuestion('');
    setSubmittedQuestion(null);
    setPending(false);
    setTurns([]);
    setConversationId(null);
    setRawError(null);
    setErrorText(null);
    setAnnouncement('');
  }, [authorizationFingerprint]);

  const submit = useCallback((route: string | null, askDirectly?: string): Promise<boolean> => {
    if (authorizationRef.current !== authorizationFingerprint) return Promise.resolve(false);
    if (inFlightRef.current) return inFlightRef.current;
    const trimmed = (askDirectly ?? question).trim();
    if (!trimmed) return Promise.resolve(false);
    const authorizationEpoch = authorizationEpochRef.current;
    // Recorded here, synchronously, and never unset by the run settling — that is the whole
    // difference from `inFlightRef`, and the reason an unrequested thread cannot take this over.
    askedRef.current = true;
    setSubmittedQuestion(trimmed);

    const run = (async () => {
      setPending(true);
      setRawError(null);
      setErrorText(null);
      try {
        const next = await askAssistant({
          question: trimmed,
          conversation_id: conversationId,
          // Context only — the server treats it as neither authorization nor a data filter.
          route: route?.slice(0, 200) ?? null,
          // The language this person is reading the product in, so the answer, the help steps
          // and the warnings under them arrive in it (`OPEN-DECISIONS #283`). A preference, not
          // an identity claim — see the field’s docblock in `contracts.ts`.
          locale,
        });
        if (
          authorizationEpochRef.current !== authorizationEpoch ||
          authorizationRef.current !== authorizationFingerprint
        ) return false;
        setTurns((previous) => [...previous, { question: trimmed, result: next }]);
        setConversationId(next.conversation_id);
        setQuestion('');
        setAnnouncement(t('assistantRun.done'));
        return true;
      } catch (error) {
        if (
          authorizationEpochRef.current !== authorizationEpoch ||
          authorizationRef.current !== authorizationFingerprint
        ) return false;
        const raw = error instanceof Error ? error.message : String(error);
        // A typed question already remains in `question`. A suggestion bypasses that state and
        // used to disappear after a failed run, leaving no retry without retyping it. Put the
        // exact submitted text back in the composer for both paths; the next submit reuses it.
        setQuestion(trimmed);
        setRawError(raw);
        setErrorText(resolveError(error));
        setAnnouncement(t('assistantRun.failed'));
        return false;
      } finally {
        if (
          authorizationEpochRef.current === authorizationEpoch &&
          authorizationRef.current === authorizationFingerprint
        ) setPending(false);
      }
    })();

    inFlightRef.current = run;
    void run.then(() => {
      if (inFlightRef.current === run) inFlightRef.current = null;
    });
    return run;
  }, [authorizationFingerprint, conversationId, question]);

  const resetConversation = useCallback(() => {
    // A response already in flight still belongs to the current conversation. Let it settle; the
    // control is disabled in the dialog too, and this guard protects future callers.
    if (inFlightRef.current) return;
    setTurns([]);
    setConversationId(null);
    setQuestion('');
    setSubmittedQuestion(null);
    setRawError(null);
    setErrorText(null);
    setAnnouncement('');
  }, []);

  const restoreHistory = useCallback((
    restored: readonly AssistantHistoryView[],
    expectedAuthorizationFingerprint: string,
  ): boolean => {
    if (
      inFlightRef.current ||
      restored.length === 0 ||
      authorizationRef.current !== expectedAuthorizationFingerprint ||
      authorizationFingerprint !== expectedAuthorizationFingerprint
    ) return false;
    const newest = restored[restored.length - 1]!;
    setQuestion('');
    setSubmittedQuestion(newest.question);
    setTurns(restored.map((turn) => ({ question: turn.question, result: turn.result })));
    setConversationId(newest.result.conversation_id);
    setRawError(null);
    setErrorText(null);
    setAnnouncement(
      restored.length === 1
        ? t('assistantRun.restoredOne')
        : t('assistantRun.restoredMany', { count: restored.length }),
    );
    return true;
  }, [authorizationFingerprint]);

  const adoptHistory = useCallback((
    restored: readonly AssistantHistoryView[],
    expectedAuthorizationFingerprint: string,
  ): boolean => {
    // Read from a ref, not from state: the caller awaited twice before getting here, so any state
    // this callback closed over is from before the question it must not overwrite.
    if (askedRef.current) return false;
    return restoreHistory(restored, expectedAuthorizationFingerprint);
  }, [restoreHistory]);

  return {
    // `useLayoutEffect` clears before paint; masking here also prevents a stale render during the
    // authorization-changing commit itself, before that effect has run.
    authorizationFingerprint,
    question: authorizationChanged ? '' : question,
    setQuestion,
    submittedQuestion: authorizationChanged ? null : submittedQuestion,
    pending: authorizationChanged ? false : pending,
    // Derived, not stored: one thread is the only source of truth for what is on screen, and a
    // second copy of the newest answer is a second thing that can disagree with it.
    result: authorizationChanged ? null : (turns.at(-1)?.result ?? null),
    turns: authorizationChanged ? [] : turns,
    conversationId: authorizationChanged ? null : conversationId,
    rawError: authorizationChanged ? null : rawError,
    errorText: authorizationChanged ? null : errorText,
    announcement: authorizationChanged ? '' : announcement,
    submit,
    restoreHistory,
    adoptHistory,
    resetConversation,
  };
}
