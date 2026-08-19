/**
 * Assistant error vocabulary — codes and their Hebrew wording.
 *
 * Split out of `contracts.ts` for one reason: `src/lib/errors.ts` is imported by most of the app,
 * and `contracts.ts` imports Zod for its schemas. Routing the error map through that file would
 * have pulled Zod into the eager import graph of every screen, including the ones that will never
 * open the assistant. This file has no dependencies at all, so `errors.ts` can hold one wording
 * without carrying a schema library behind it.
 *
 * Closed union plus Hebrew text, matching the Edge-function convention. The same codes are
 * registered in `src/lib/errors.ts` so a failure reads identically whether it surfaced from the
 * assistant function or from a direct RPC — the product has one error vocabulary, not one per
 * feature.
 */

export const ASSISTANT_ERROR_CODES = [
  'assistant_unauthenticated',
  'assistant_disabled',
  'assistant_not_entitled',
  'assistant_limit_reached',
  'assistant_limit_unknown',
  'assistant_rate_limited',
  'assistant_question_too_long',
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

export const ASSISTANT_ERROR_MESSAGES: Record<AssistantErrorCode, string> = {
  assistant_unauthenticated: 'ההתחברות פגה. יש להיכנס מחדש.',
  assistant_disabled: 'העוזר אינו פעיל בארגון הזה.',
  assistant_not_entitled: 'המסלול הנוכחי אינו כולל את העוזר.',
  assistant_limit_reached: 'נגמרה מכסת השאלות לתקופה הנוכחית.',
  assistant_limit_unknown: 'לא ניתן לקבוע את מכסת העוזר במסלול הזה, ולכן הבקשה נדחתה.',
  assistant_rate_limited: 'נשאלו יותר מדי שאלות בזמן קצר. נסה שוב בעוד כמה דקות.',
  assistant_question_too_long: 'השאלה ארוכה מדי. נסה לנסח אותה קצר יותר.',
  assistant_provider_unavailable: 'העוזר אינו זמין כרגע. הנתונים עצמם זמינים במסכים.',
  assistant_provider_timeout: 'העוזר לא השיב בזמן. אפשר לנסות שוב.',
  assistant_unsupported_answer: 'העוזר לא הצליח לבסס תשובה על נתוני המערכת, ולכן לא הוצגה תשובה.',
  assistant_tool_failed: 'שליפת הנתונים נכשלה, ולכן אי אפשר לקבוע תשובה.',
  assistant_history_unavailable: 'לא ניתן לטעון את היסטוריית השיחות.',
  assistant_proposal_unavailable: 'הטיוטה אינה זמינה.',
  assistant_proposal_expired: 'הטיוטה פגה. יש לבקש אותה מחדש.',
  assistant_proposal_state: 'מצב הטיוטה השתנה. יש לרענן ולנסות שוב.',
  assistant_read_only_organization: 'הארגון במצב קריאה בלבד, ולכן אי אפשר לבצע את הפעולה.',
  assistant_invalid_request: 'בקשת העוזר אינה תקינה.',
  // The run happened but its counter did not move. Reporting success here would let a run escape
  // the quota it was measured against, so the whole turn fails instead.
  assistant_persistence_failed: 'התשובה לא נשמרה, ולכן הריצה לא הושלמה. אפשר לנסות שוב.',
};
