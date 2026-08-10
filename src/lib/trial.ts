export type OrganizationAccessMode = 'active' | 'trial' | 'grace' | 'read_only' | 'offboarding' | 'suspended';

export interface OrganizationAccess {
  mode: OrganizationAccessMode;
  graceDaysRemaining: number | null;
  canWrite: boolean;
}

export type OrganizationAccessStateRow = {
  access_mode: string;
  trial_ends_at?: string | null;
  grace_ends_at?: string | null;
  grace_days_remaining: number | null;
};

export const ACTIVE_ORGANIZATION_ACCESS: OrganizationAccess = {
  mode: 'active',
  graceDaysRemaining: null,
  canWrite: true,
};

export const READ_ONLY_ORGANIZATION_ACCESS: OrganizationAccess = {
  mode: 'read_only',
  graceDaysRemaining: null,
  canWrite: false,
};

const MODES = new Set<OrganizationAccessMode>([
  'active', 'trial', 'grace', 'read_only', 'offboarding', 'suspended',
]);

/**
 * Converts the database's canonical lifecycle projection into UI state. Trial and grace
 * boundaries use the database clock; invalid or missing evidence fails closed.
 */
export function organizationAccessFromServer(
  row: OrganizationAccessStateRow | null | undefined,
): OrganizationAccess {
  if (!row || !MODES.has(row.access_mode as OrganizationAccessMode)) {
    return READ_ONLY_ORGANIZATION_ACCESS;
  }
  const mode = row.access_mode as OrganizationAccessMode;
  return {
    mode,
    graceDaysRemaining: mode === 'grace'
      && Number.isInteger(row.grace_days_remaining)
      && (row.grace_days_remaining ?? -1) >= 0
      ? row.grace_days_remaining
      : null,
    canWrite: mode === 'active' || mode === 'trial' || mode === 'grace',
  };
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
 * The organization shape the countdown needs, and nothing more. Kept separate from the
 * server-projected `OrganizationAccessStateRow` above: this one reads the plain organizations
 * row that the layout already holds, so the banner costs no extra query.
 */
export interface TrialSubject {
  status: string;
  trial_ends_at: string | null;
}

/**
 * Whole days left in the trial, or `null` when the question does not apply — not a trial, no end
 * date, an unparsable one, or already expired (an expired tenant is the server's read-only mode,
 * surfaced by `organizationAccessFromServer`, and a warning about something that has already
 * happened is not a warning).
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
