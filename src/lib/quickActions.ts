import { Camera, FilePlus, PackageCheck, PieChart, ShoppingCart, type LucideIcon } from 'lucide-react';
import type { Role } from './types';

/**
 * The single vocabulary behind both quick-action surfaces — the dashboard row and the
 * global FAB speed-dial. One list keeps labels, icons and targets from ever forking.
 * Roles mirror the route guards in App.tsx: capture/order/receive/invoice are STAFF
 * screens; /expenses is listed for owner/office only, so the FAB never offers a route
 * its holder cannot enter.
 */
export interface QuickAction {
  key: string;
  label: string;
  icon: LucideIcon;
  roles: readonly Role[];
  kind: 'link' | 'capture';
  to?: string;
}

export const QUICK_ACTIONS: readonly QuickAction[] = [
  { key: 'capture', label: 'צילום מסמך', icon: Camera, kind: 'capture', roles: ['owner', 'office', 'kitchen'] },
  { key: 'order', label: 'הזמנה חדשה', icon: ShoppingCart, kind: 'link', to: '/orders/new', roles: ['owner', 'office', 'kitchen'] },
  { key: 'receive', label: 'קבלת סחורה', icon: PackageCheck, kind: 'link', to: '/receiving', roles: ['owner', 'office', 'kitchen'] },
  { key: 'invoice', label: 'חשבונית חדשה', icon: FilePlus, kind: 'link', to: '/invoices/new', roles: ['owner', 'office', 'kitchen'] },
  { key: 'expenses', label: 'ריכוז הוצאות', icon: PieChart, kind: 'link', to: '/expenses', roles: ['owner', 'office'] },
];

/** Accepts the loose `string | null | undefined` the auth context exposes mid-load. */
export function quickActionsFor(role: string | null | undefined): QuickAction[] {
  if (!role) return [];
  return QUICK_ACTIONS.filter((action) => action.roles.some((r) => r === role));
}
