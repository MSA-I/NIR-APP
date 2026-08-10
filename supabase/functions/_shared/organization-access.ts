export interface OrganizationAccessRow {
  access_mode: string;
}

/** Edge preflight projection returned by the canonical database access-mode function. */
export function organizationWriteAllowed(
  organization: OrganizationAccessRow | null,
): boolean {
  return organization !== null
    && ["active", "trial", "grace"].includes(organization.access_mode);
}
