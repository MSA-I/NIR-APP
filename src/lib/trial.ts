/**
 * Trial expiry — OPEN-DECISIONS #15, decided 09.08.2026 (owner): SOFT block.
 *
 * Soft means exactly this: when a `trial` organization's `trial_ends_at` has passed, the app
 * stops at a truthful full-screen notice instead of its screens. Nothing in the database is
 * touched, no RLS changes — `suspended` (0006) remains the hard tool, and the operator
 * extends or activates from /admin. A platform operator is never blocked (they are the one
 * who can fix it).
 *
 * The date comparison is strict-after: on the last day the trial still works — "ends at" a
 * moment that has not arrived yet is not "ended".
 */
export interface TrialSubject {
  status: string;
  trial_ends_at: string | null;
}

export function isTrialExpired(org: TrialSubject | null | undefined, now: Date = new Date()): boolean {
  if (!org || org.status !== 'trial' || !org.trial_ends_at) return false;
  const endsAt = new Date(org.trial_ends_at);
  return Number.isFinite(endsAt.getTime()) && endsAt.getTime() <= now.getTime();
}

/**
 * How close to the end the app starts saying so.
 *
 * This is a PRESENTATION threshold, not the business rule: #15 decided what happens when a trial
 * ends, and deliberately left collection out of scope. Nothing downstream branches on this number —
 * it only decides when a notice appears. If the owner wants it treated as a business decision it
 * belongs in OPEN-DECISIONS.md, and changing it is this one line.
 */
export const TRIAL_WARNING_DAYS = 7;

/**
 * Whole days left in the trial, or `null` when the question does not apply — not a trial, no end
 * date, an unparsable one, or already expired (that case belongs to isTrialExpired and its screen,
 * and a warning about something that has already happened is not a warning).
 *
 * Rounded UP, deliberately: with 30 hours left, "נותר יום אחד" understates it and "נותרו 2 ימים"
 * is what a person planning their week needs to hear. Zero is never returned — the last partial day
 * still reads as one.
 */
export function trialDaysRemaining(
  org: TrialSubject | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!org || org.status !== 'trial' || !org.trial_ends_at) return null;
  const endsAt = new Date(org.trial_ends_at);
  if (!Number.isFinite(endsAt.getTime())) return null;
  const ms = endsAt.getTime() - now.getTime();
  if (ms <= 0) return null;
  return Math.max(1, Math.ceil(ms / 86_400_000));
}
