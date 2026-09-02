import type { TKey } from './i18n/t.ts';

// One source of truth for the password rule. It has to match Supabase Auth's
// minimum_password_length (supabase/config.toml) — when the client is more permissive the server
// rejects the sign-up and the user reads a raw English error instead of the Hebrew one below.
export const MIN_PASSWORD_LENGTH = 10;

/** Returns a Hebrew message when the pair is unusable, or null when it is fine. */
/**
 * The `{ key, vars }` shape `alerts.ts` established for a sentence that carries a number: the
 * minimum length has ONE definition, and it travels with the key instead of being baked into a
 * string this module could not translate anyway.
 */
export type PasswordProblem = { key: TKey; vars?: Record<string, string | number> };

export function passwordProblemOf(password: string, confirmation: string): PasswordProblem | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { key: 'password.tooShort', vars: { min: MIN_PASSWORD_LENGTH } };
  }
  if (password !== confirmation) return { key: 'password.mismatch' };
  return null;
}

/**
 * Owner ruling #332: an account created by the anonymous signup form has NO password until the
 * address behind it has been confirmed. `public-signup` marks the owner it creates with
 * `user_metadata.password_pending`, `/set-password` clears it, and this reads it.
 *
 * IT IS A HINT, NEVER AN AUTHORIZATION. `user_metadata` is self-asserted — anybody holding a
 * session can write anything into it — so the only thing this is ever allowed to decide is which
 * screen to offer. What actually protects the account is the password GoTrue holds: the admin
 * create was given none, so GoTrue generated a random one nobody has, and a stranger who
 * pre-registered somebody else's address cannot sign in with the value they typed — whatever this
 * function returns. Clearing the flag by hand grants nothing; it only skips a screen.
 *
 * Typed structurally so the rule can be tested without an auth client.
 */
export function passwordPendingOf(
  user: { user_metadata?: Record<string, unknown> | null } | null | undefined,
): boolean {
  return user?.user_metadata?.password_pending === true;
}
