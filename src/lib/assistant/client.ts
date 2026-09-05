import { supabase } from '../supabase';
import { ok } from '../errors';
import { useQuery, type QueryState } from '../useQuery';
import {
  AssistantHistoryListResponseSchema,
  AssistantHistoryTranscriptSchema,
  AssistantRunResultSchema,
  type AssistantAskRequest,
  type AssistantConversationRow as AssistantConversationRowContract,
  type AssistantHistoryListRequest,
  type AssistantHistoryLoadRequest,
  type AssistantHistoryView,
  type AssistantRunResult,
} from './contracts';

/**
 * The browser side of the InPlace assistant.
 *
 * One rule shapes everything here: the panel renders only what the server issued. The client
 * never recomputes a number, never composes a route, never decides an entitlement — it carries
 * the envelope from `contracts.ts` across the wire and hands it to the renderer untouched.
 *
 * The response is ONE WHOLE PAYLOAD, not a stream, on purpose. The repo has zero streaming
 * precedent in the client, and a token stream would also force inventing a screen-reader pattern
 * for incrementally-arriving text — an `aria-live` region that re-announces on every chunk is
 * exactly the noise the settled-answer announcement exists to avoid. Post-generation validation
 * on the server also needs the finished answer before anything is shown, so streaming would buy
 * perceived speed for text that could still be rejected.
 */

/** Query-key domain for the assistant. Suffixes passed to `useQuery`, which roots them at the org. */
const ASSISTANT_DOMAIN = 'assistant';

interface EdgeErrorBody {
  error?: { code?: string; message?: string };
}

/**
 * supabase-js swallows the response body on non-2xx (`send-feedback`'s `edgeMessage` precedent).
 * The assistant function answers refusals with `{ error: { code } }` where `code` is one of
 * `ASSISTANT_ERROR_CODES` — the code is preferred over any message so `toHebrewError` resolves it
 * through the single wording in `src/lib/errors.ts`, not a second one baked into a response body.
 *
 * A 401 with no code in the body is the gateway itself: the function ships with `verify_jwt = true`,
 * so an expired or malformed token is rejected before our handler ever runs and the body carries
 * nothing of ours. That refusal must still speak the product's Hebrew — it maps to
 * `assistant_unauthenticated` here rather than falling through to the generic Edge sentence.
 */
async function edgeErrorCode(error: unknown): Promise<string | null> {
  const ctx = (error as { context?: Response } | null)?.context;
  if (!ctx) return null;
  let code: string | null = null;
  if (typeof ctx.json === 'function') {
    try {
      const body = (await ctx.json()) as EdgeErrorBody;
      code = body?.error?.code ?? body?.error?.message ?? null;
    } catch {
      /* empty or non-JSON body — the status decides below */
    }
  }
  if (!code && ctx.status === 401) return 'assistant_unauthenticated';
  return code;
}

/**
 * Ask the assistant one question.
 *
 * Write-shaped call: it throws the raw code/message and the CALL SITE translates through
 * `toHebrewError` (the `useQuery.ts` convention — reads translate internally, writes translate
 * where the failure is shown). The panel needs the raw code anyway, to decide whether the
 * deterministic fallback applies.
 */
async function invokeAssistant(
  body: AssistantAskRequest | AssistantHistoryListRequest | AssistantHistoryLoadRequest,
): Promise<unknown> {
  const { data, error } = await supabase.functions.invoke<unknown>('assistant', {
    body,
  });
  if (error) {
    const code = await edgeErrorCode(error);
    throw new Error(code ?? (error instanceof Error ? error.message : String(error)));
  }
  // A 2xx body can still carry a refusal (the send-feedback convention).
  const refused = (data as unknown as EdgeErrorBody | null)?.error;
  if (refused) throw new Error(refused.code ?? refused.message ?? 'assistant_provider_unavailable');
  if (!data) throw new Error('assistant_provider_unavailable');
  return data;
}

export async function askAssistant(request: AssistantAskRequest): Promise<AssistantRunResult> {
  const data = await invokeAssistant(request);
  const parsed = AssistantRunResultSchema.safeParse(data);
  if (!parsed.success) throw new Error('assistant_unsupported_answer');
  return parsed.data;
}

/**
 * One stored conversation, as the panel lists it (0164). Read through RLS — the policy already
 * filters to the asker's own rows and hides tombstoned (`deleted_at`) conversations.
 */
export type AssistantConversationRow = AssistantConversationRowContract;

export async function listAssistantConversations(
  limit = 10,
): Promise<AssistantConversationRow[]> {
  const data = await invokeAssistant({ operation: 'history_list', limit });
  const parsed = AssistantHistoryListResponseSchema.safeParse(data);
  if (!parsed.success) throw new Error('assistant_unsupported_answer');
  return parsed.data.conversations;
}

const listConversations = () => listAssistantConversations(10);

/**
 * The conversation list, cached under `['org', <tenant>, 'assistant', 'conversations']`.
 * Rooted at the tenant by `useQuery` itself (the `flags.ts` contract): an org switch invalidates
 * the whole subtree, so one tenant's conversations can never be served to another from cache.
 */
export function useAssistantConversations(
  authorizationFingerprint = 'assistant-authorization-unscoped',
): QueryState<AssistantConversationRow[]> {
  return useQuery(
    listConversations,
    [],
    [ASSISTANT_DOMAIN, 'conversations', authorizationFingerprint],
  );
}

/** The whole conversation, oldest turn first. Every turn was re-authorized server-side. */
export async function loadAssistantConversation(
  conversationId: string,
): Promise<AssistantHistoryView[]> {
  const data = await invokeAssistant({
    operation: 'history_load',
    conversation_id: conversationId,
  });
  const parsed = AssistantHistoryTranscriptSchema.safeParse(data);
  if (!parsed.success) throw new Error('assistant_unsupported_answer');
  return parsed.data.turns;
}

/**
 * The privacy delete (0164): messages, facts and sources are hard-deleted server-side, the
 * conversation row is tombstoned so it stops listing. The definer writes its own audit row.
 */
export async function deleteAssistantConversation(conversationId: string): Promise<void> {
  ok(await supabase.rpc('assistant_delete_conversation', { p_conversation_id: conversationId }));
}

export interface AssistantFeedbackReadback {
  helpful: boolean;
  note: string | null;
}

/** Helpful / not helpful on one run. Confirmation comes from a tenant-scoped read after write. */
export async function sendAssistantFeedback(
  runId: string,
  helpful: boolean,
  note?: string | null,
): Promise<AssistantFeedbackReadback> {
  const cleanNote = note?.trim() || null;
  ok(await supabase.rpc('assistant_record_feedback', {
    p_run_id: runId,
    p_helpful: helpful,
    p_note: cleanNote,
  }));
  const read = ok(await supabase.from('assistant_feedback')
    .select('rating, note')
    .eq('run_id', runId)
    .single());
  const row = read.data as { rating?: unknown; note?: unknown } | null;
  if (!row || !['helpful', 'not_helpful'].includes(String(row.rating))
      || (row.note !== null && typeof row.note !== 'string')) {
    throw new Error('assistant_persistence_failed');
  }
  return { helpful: row.rating === 'helpful', note: row.note as string | null };
}
