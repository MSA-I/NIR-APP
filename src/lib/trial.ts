export type OrganizationAccessMode = 'active' | 'trial' | 'grace' | 'read_only' | 'offboarding' | 'suspended';

export interface OrganizationAccess {
  mode: OrganizationAccessMode;
  graceDaysRemaining: number | null;
  canWrite: boolean;
}

export type OrganizationAccessStateRow = {
  access_mode: string;
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
