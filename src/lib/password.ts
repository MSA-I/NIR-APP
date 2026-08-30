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
