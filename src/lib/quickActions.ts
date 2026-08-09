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

// The role-aware quick-action bar, phone only since the desktop speed-dial was removed
// (09.08.2026). Order is canonical and is asserted in layout.spec.ts.
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

// desktopQuickActionsFor was removed with the desktop speed-dial (owner decision 09.08.2026).
// Quick actions are a phone surface now; on a desktop every page carries its own primary action.

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
