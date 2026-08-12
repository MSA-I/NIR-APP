import { Activity, Camera, CreditCard, FileText, FolderOpen, LayoutDashboard, PackageCheck, ShoppingCart, type LucideIcon } from 'lucide-react';
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
  { key: 'order', label: 'הזמנה חדשה', icon: ShoppingCart, kind: 'link', to: '/orders/new?fresh=1', roles: ['owner', 'office'] },
  { key: 'dashboard', label: 'מרכז הבקרה', icon: LayoutDashboard, kind: 'link', to: '/dashboard', roles: ['owner', 'office', 'accountant'] },
  { key: 'capture', label: 'צילום מסמך', icon: Camera, kind: 'capture', roles: ['owner', 'office'] },
  { key: 'receive', label: 'קבלת סחורה', icon: PackageCheck, kind: 'link', to: '/receiving', roles: ['owner', 'office'] },
  // Keep five items for both procurement roles so capture stays in the exact middle. Document
  // operations is owner-only; office receives the permitted document gallery in the same slot.
  { key: 'document-operations', label: 'תפעול מסמכים', icon: Activity, kind: 'link', to: '/documents/operations', roles: ['owner'] },
  { key: 'documents', label: 'מסמכים', icon: FolderOpen, kind: 'link', to: '/documents', roles: ['office'] },
  // "חשבונית חדשה" was removed here (G1, 10.08.2026). This application RECEIVES supplier
  // invoices; it does not issue them to anyone. The action that replaces it already sits two rows
  // up: `capture` — photograph the invoice that arrived. `/invoices/new` still exists as a route,
  // reachable from a document that has been reviewed, which is the only way an invoice should
  // come into being.
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
  const targetPath = to.split(/[?#]/, 1)[0];
  if (targetPath === '/documents') {
    return pathname === targetPath || /^\/documents\/[^/]+\/review$/.test(pathname);
  }
  if (targetPath === '/documents/archive') return pathname === targetPath;
  if (['/orders', '/receiving', '/invoices', '/suppliers'].includes(targetPath)) {
    return pathname === targetPath || pathname.startsWith(`${targetPath}/`);
  }
  return pathname === targetPath;
}
