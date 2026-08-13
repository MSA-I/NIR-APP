export function activePriceListRoleAllowed(role: string): boolean {
  return role === 'owner' || role === 'office';
}
