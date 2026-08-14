export type OrganizationAccessMode = 'active' | 'read_only' | 'offboarding' | 'suspended';

export interface OrganizationAccess {
  mode: OrganizationAccessMode;
  canWrite: boolean;
}

export type OrganizationAccessStateRow = {
  access_mode: string;
};

export const ACTIVE_ORGANIZATION_ACCESS: OrganizationAccess = {
  mode: 'active',
  canWrite: true,
};

export const READ_ONLY_ORGANIZATION_ACCESS: OrganizationAccess = {
  mode: 'read_only',
  canWrite: false,
};

const MODES = new Set<OrganizationAccessMode>([
  'active', 'read_only', 'offboarding', 'suspended',
]);

/** Converts the server's lifecycle projection to UI state. Unknown and retired modes fail closed. */
export function organizationAccessFromServer(
  row: OrganizationAccessStateRow | null | undefined,
): OrganizationAccess {
  if (!row || !MODES.has(row.access_mode as OrganizationAccessMode)) {
    return READ_ONLY_ORGANIZATION_ACCESS;
  }
  const mode = row.access_mode as OrganizationAccessMode;
  return { mode, canWrite: mode === 'active' };
}
