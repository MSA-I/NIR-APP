import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { toHebrewError } from '../errors';
import { askAssistant } from './client';
import type { AssistantHistoryView, AssistantRunResult } from './contracts';

export interface AssistantRunSession {
  authorizationFingerprint: string;
  question: string;
  setQuestion: (question: string) => void;
  /** The exact question whose pending/result state is on screen. */
  submittedQuestion: string | null;
  pending: boolean;
  result: AssistantRunResult | null;
  conversationId: string | null;
  rawError: string | null;
  errorText: string | null;
  announcement: string;
  /** Starts one run, or returns the already-running promise. */
  submit: (route: string | null) => Promise<boolean>;
  restoreHistory: (view: AssistantHistoryView, expectedAuthorizationFingerprint: string) => boolean;
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
  const [question, setQuestion] = useState('');
  const [submittedQuestion, setSubmittedQuestion] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<AssistantRunResult | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [rawError, setRawError] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const inFlightRef = useRef<Promise<boolean> | null>(null);
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
    setQuestion('');
    setSubmittedQuestion(null);
    setPending(false);
    setResult(null);
    setConversationId(null);
    setRawError(null);
    setErrorText(null);
    setAnnouncement('');
  }, [authorizationFingerprint]);

  const submit = useCallback((route: string | null): Promise<boolean> => {
    if (authorizationRef.current !== authorizationFingerprint) return Promise.resolve(false);
    if (inFlightRef.current) return inFlightRef.current;
    const trimmed = question.trim();
    if (!trimmed) return Promise.resolve(false);
    const authorizationEpoch = authorizationEpochRef.current;
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
        });
        if (
          authorizationEpochRef.current !== authorizationEpoch ||
          authorizationRef.current !== authorizationFingerprint
        ) return false;
        setResult(next);
        setConversationId(next.conversation_id);
        setQuestion('');
        setAnnouncement('הבדיקה הושלמה');
        return true;
      } catch (error) {
        if (
          authorizationEpochRef.current !== authorizationEpoch ||
          authorizationRef.current !== authorizationFingerprint
        ) return false;
        const raw = error instanceof Error ? error.message : String(error);
        setRawError(raw);
        setErrorText(toHebrewError(error));
        setAnnouncement('הבקשה נכשלה');
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
    setResult(null);
    setConversationId(null);
    setQuestion('');
    setSubmittedQuestion(null);
    setRawError(null);
    setErrorText(null);
    setAnnouncement('');
  }, []);

  const restoreHistory = useCallback((
    view: AssistantHistoryView,
    expectedAuthorizationFingerprint: string,
  ): boolean => {
    if (
      inFlightRef.current ||
      authorizationRef.current !== expectedAuthorizationFingerprint ||
      authorizationFingerprint !== expectedAuthorizationFingerprint
    ) return false;
    setQuestion('');
    setSubmittedQuestion(view.question);
    setResult(view.result);
    setConversationId(view.result.conversation_id);
    setRawError(null);
    setErrorText(null);
    setAnnouncement('הבדיקה הקודמת נטענה');
    return true;
  }, [authorizationFingerprint]);

  return {
    // `useLayoutEffect` clears before paint; masking here also prevents a stale render during the
    // authorization-changing commit itself, before that effect has run.
    authorizationFingerprint,
    question: authorizationChanged ? '' : question,
    setQuestion,
    submittedQuestion: authorizationChanged ? null : submittedQuestion,
    pending: authorizationChanged ? false : pending,
    result: authorizationChanged ? null : result,
    conversationId: authorizationChanged ? null : conversationId,
    rawError: authorizationChanged ? null : rawError,
    errorText: authorizationChanged ? null : errorText,
    announcement: authorizationChanged ? '' : announcement,
    submit,
    restoreHistory,
    resetConversation,
  };
}
