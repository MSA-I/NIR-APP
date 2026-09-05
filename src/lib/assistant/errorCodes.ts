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

export type AssistantErrorRecovery =
  | 'retry'
  | 'edit'
  | 'sign_in'
  | 'use_screens'
  | 'new_check'
  | 'none';

/**
 * One explicit way forward for every canonical failure.
 *
 * This is presentation guidance, not authorization. The Edge function still decides whether a
 * run or proposal is allowed; the panel uses this closed matrix only to avoid a red sentence with
 * no next action. Messages that already name the action still carry the same classification here
 * so a new code cannot arrive without somebody deciding its recovery contract.
 */
export const ASSISTANT_ERROR_RECOVERY = {
  assistant_unauthenticated: 'sign_in',
  assistant_disabled: 'use_screens',
  assistant_not_entitled: 'use_screens',
  assistant_limit_reached: 'use_screens',
  assistant_limit_unknown: 'use_screens',
  assistant_rate_limited: 'retry',
  assistant_question_too_long: 'edit',
  assistant_input_restricted: 'edit',
  assistant_provider_unavailable: 'retry',
  assistant_provider_timeout: 'retry',
  assistant_unsupported_answer: 'new_check',
  assistant_tool_failed: 'retry',
  assistant_history_unavailable: 'retry',
  assistant_proposal_unavailable: 'new_check',
  assistant_proposal_expired: 'new_check',
  assistant_proposal_state: 'retry',
  assistant_read_only_organization: 'none',
  assistant_invalid_request: 'edit',
  assistant_persistence_failed: 'retry',
} as const satisfies Record<AssistantErrorCode, AssistantErrorRecovery>;
