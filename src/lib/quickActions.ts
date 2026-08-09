import { Camera, CreditCard, FilePlus, FileText, LayoutDashboard, PackageCheck, ShoppingCart, type LucideIcon } from 'lucide-react';
import type { Role } from './types';

export interface QuickAction {
  key: string;
  label: string;
  icon: LucideIcon;
  roles: readonly Role[];
  kind: 'link' | 'capture';
  to?: string;
}

// Mobile keeps the original role-aware quick-action bar. The desktop speed-dial filters this list
// to commands only so restoring the phone surface does not undo the desktop hierarchy.
const QUICK_ACTIONS: readonly QuickAction[] = [
  { key: 'order', label: 'הזמנה חדשה', icon: ShoppingCart, kind: 'link', to: '/orders/new?fresh=1', roles: ['owner', 'office', 'kitchen'] },
  { key: 'dashboard', label: 'מרכז הבקרה', icon: LayoutDashboard, kind: 'link', to: '/dashboard', roles: ['owner', 'office', 'kitchen', 'accountant'] },
  { key: 'capture', label: 'צילום מסמך', icon: Camera, kind: 'capture', roles: ['owner', 'office', 'kitchen'] },
  { key: 'receive', label: 'קבלת סחורה', icon: PackageCheck, kind: 'link', to: '/receiving', roles: ['owner', 'office', 'kitchen'] },
  { key: 'invoice', label: 'חשבונית חדשה', icon: FilePlus, kind: 'link', to: '/invoices/new', roles: ['owner', 'office', 'kitchen'] },
  { key: 'invoices', label: 'חשבוניות', icon: FileText, kind: 'link', to: '/invoices', roles: ['accountant'] },
  { key: 'pay', label: 'תשלומים', icon: CreditCard, kind: 'link', to: '/pay', roles: ['accountant'] },
];

const FOCUS_PATHS = ['/orders/new', '/invoices/new', '/receiving/:orderId'] as const;

export function quickActionsFor(role: Role | null | undefined): QuickAction[] {
  return role ? QUICK_ACTIONS.filter((action) => action.roles.includes(role)) : [];
}

export function desktopQuickActionsFor(role: Role | null | undefined): QuickAction[] {
  return quickActionsFor(role).filter((action) => ['order', 'capture', 'invoice'].includes(action.key));
}

export function isFocusPath(pathname: string): boolean {
  return FOCUS_PATHS.some((path) => path.includes(':')
    ? pathname.startsWith(`${path.slice(0, path.indexOf('/:'))}/`)
    : pathname === path);
}

/** One route-family rule shared by the desktop sidebar and mobile drawer. */
export function isRouteFamilyActive(pathname: string, to: string): boolean {
  if (to === '/documents') {
    return pathname === to || /^\/documents\/[^/]+\/review$/.test(pathname);
  }
  if (to === '/documents/archive') return pathname === to;
  if (['/orders', '/receiving', '/invoices', '/suppliers'].includes(to)) {
    return pathname === to || pathname.startsWith(`${to}/`);
  }
  return pathname === to;
}
