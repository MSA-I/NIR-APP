export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export function organizationCanManageBranding(
  profile: { active: boolean; role: string } | null,
  organization: OrganizationAccessRow | null,
) {
  return profile?.active === true && profile.role === "owner" &&
    organizationWriteAllowed(organization);
}

const matches = (bytes: Uint8Array, expected: number[]) =>
  expected.every((value, index) => bytes[index] === value);

export function validatedLogoType(
  bytes: Uint8Array,
  claimedType: string,
  size: number,
) {
  if (size < 1 || size > MAX_LOGO_BYTES || bytes.length < 12) return null;
  if (
    claimedType === "image/png" &&
    matches(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    return { extension: "png", contentType: "image/png" };
  }
  if (claimedType === "image/jpeg" && matches(bytes, [0xff, 0xd8, 0xff])) {
    return { extension: "jpg", contentType: "image/jpeg" };
  }
  if (
    claimedType === "image/webp" && matches(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    matches(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    return { extension: "webp", contentType: "image/webp" };
  }
  return null;
}
import {
  type OrganizationAccessRow,
  organizationWriteAllowed,
} from "../_shared/organization-access.ts";

/**
 * A supplier logo is written by owner OR office, and the organisation logo by owner alone.
 *
 * The difference is deliberate rather than an oversight in one of them. Supplier records are the
 * office role's daily surface -- it already creates suppliers and edits their details -- so
 * requiring the owner for a supplier's logo would push routine work onto the wrong person without
 * protecting anything. The organisation's own logo is tenant identity and stays with the owner.
 *
 * `organizationWriteAllowed` still gates both: a suspended or read-only tenant writes no branding
 * at all, whoever is asking.
 */
export function supplierCanManageBranding(
  profile: { active: boolean; role: string } | null,
  organization: OrganizationAccessRow | null,
) {
  return profile?.active === true &&
    (profile.role === "owner" || profile.role === "office") &&
    organizationWriteAllowed(organization);
}

/**
 * The storage path for a supplier logo, built here and never accepted from the caller.
 *
 * The bucket's policy reads the first segment as the organisation id, and `0275` puts the same
 * shape in a CHECK constraint on `suppliers.logo_path`. Both halves have to agree, so the single
 * place that builds it is a function the contract tests can call directly -- a path assembled
 * inline in the request handler is one nobody can test without a running tenant.
 */
export function supplierLogoObjectPath(
  orgId: string,
  supplierId: string,
  objectId: string,
  extension: string,
) {
  return `${orgId}/suppliers/${supplierId}/${objectId}.${extension}`;
}
