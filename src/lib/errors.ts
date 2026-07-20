/**
 * Hebrew-facing error text.
 *
 * supabase-js returns `{ data, error }` and never throws, so a failed write reaches the user
 * either as nothing at all or as a raw Postgres string. This maps the messages the app can
 * actually produce onto sentences a business owner can act on, and keeps the original in the
 * console so a developer still sees what really happened.
 *
 * ponytail: a flat pattern list, not an error-code taxonomy. Postgres does not give
 * supabase-js a stable code on every path, and the strings below are the ones this schema
 * can raise.
 */

const PATTERNS: [RegExp, string][] = [
  [/row-level security|permission denied|insufficient privilege/i,
    'אין לך הרשאה לבצע את הפעולה הזו.'],
  [/duplicate key value|already exists/i,
    'הרשומה כבר קיימת במערכת.'],
  [/violates foreign key constraint/i,
    'לא ניתן להשלים את הפעולה — קיימות רשומות אחרות שמקושרות לרשומה זו.'],
  [/null value in column .* violates not-null/i,
    'חסר שדה חובה.'],
  [/violates check constraint/i,
    'אחד הערכים שהוזנו אינו תקין.'],
  [/JWT expired|Invalid Refresh Token|refresh_token_not_found/i,
    'פג תוקף החיבור. יש להתחבר מחדש.'],
  [/Invalid login credentials/i,
    'אימייל או סיסמה שגויים.'],
  [/Email not confirmed/i,
    'כתובת המייל טרם אומתה.'],
  [/already registered/i,
    'כתובת המייל כבר רשומה במערכת.'],
  [/Failed to fetch|NetworkError|ERR_NETWORK|fetch failed/i,
    'אין חיבור לשרת. בדוק את החיבור לאינטרנט ונסה שוב.'],
  [/timeout|timed out/i,
    'הפעולה ארכה זמן רב מדי. נסה שוב.'],
  [/payload too large|exceeded the maximum allowed size/i,
    'הקובץ גדול מדי.'],
];

const FALLBACK = 'הפעולה נכשלה. אם הבעיה חוזרת — פנה לתמיכה.';

/** Turns any thrown value or Supabase error message into Hebrew. */
export function toHebrewError(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : String(e);
  // The original is what a developer needs; the return value is what the user reads.
  if (raw) console.error('[supplyflow]', raw);
  for (const [re, text] of PATTERNS) if (re.test(raw)) return text;
  return FALLBACK;
}

/**
 * Reads a supabase-js result and throws on failure.
 *
 * The reason this exists: `await supabase.from(x).insert(y)` resolves successfully even when
 * the insert was rejected, so `try/catch` around it catches nothing and the next line happily
 * reports success. Every write should pass through here.
 */
export function ok<T extends { error: { message: string } | null }>(res: T): T {
  if (res.error) throw new Error(res.error.message);
  return res;
}
