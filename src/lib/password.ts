// One source of truth for the password rule. It has to match Supabase Auth's
// minimum_password_length (supabase/config.toml) — when the client is more permissive the server
// rejects the sign-up and the user reads a raw English error instead of the Hebrew one below.
export const MIN_PASSWORD_LENGTH = 10;

/** Returns a Hebrew message when the pair is unusable, or null when it is fine. */
export function passwordProblem(password: string, confirmation: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `הסיסמה חייבת להכיל לפחות ${MIN_PASSWORD_LENGTH} תווים.`;
  }
  if (password !== confirmation) return 'הסיסמאות אינן זהות.';
  return null;
}
