/**
 * Assistant error vocabulary — codes and their Hebrew wording.
 *
 * Split out of `contracts.ts` for one reason: `src/lib/errors.ts` is imported by most of the app,
 * and `contracts.ts` imports Zod for its schemas. Routing the error map through that file would
 * have pulled Zod into the eager import graph of every screen, including the ones that will never
 * open the assistant. This file has no dependencies at all, so `errors.ts` can hold one wording
 * without carrying a schema library behind it.
 *
 * A closed union of codes, and NOTHING ELSE. The wording used to live here beside them; it now
 * lives in the `errors` namespace of the dictionaries under these exact codes, so each one has
 * one answer per language instead of a Hebrew copy here and a translated copy there. The same
 * codes are registered in `src/lib/errors.ts`, so a failure reads identically whether it
 * surfaced from the assistant function or from a direct RPC — one error vocabulary, not one
 * per feature.
 */

export const ASSISTANT_ERROR_CODES = [
  'assistant_unauthenticated',
  'assistant_disabled',
  'assistant_not_entitled',
  'assistant_limit_reached',
  'assistant_limit_unknown',
  'assistant_rate_limited',
  'assistant_question_too_long',
  'assistant_input_restricted',
  'assistant_provider_unavailable',
  'assistant_provider_timeout',
  'assistant_unsupported_answer',
  'assistant_tool_failed',
  'assistant_history_unavailable',
  'assistant_proposal_unavailable',
  'assistant_proposal_expired',
  'assistant_proposal_state',
  'assistant_read_only_organization',
  'assistant_invalid_request',
  'assistant_persistence_failed',
] as const;
export type AssistantErrorCode = (typeof ASSISTANT_ERROR_CODES)[number];
