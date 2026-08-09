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
