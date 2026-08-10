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
