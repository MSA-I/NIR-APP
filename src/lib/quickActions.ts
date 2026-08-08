import {
  Camera, CreditCard, FilePlus, FileText, FolderOpen, Landmark, LayoutDashboard,
  MoreHorizontal, PackageCheck, ShoppingCart, Tags, type LucideIcon,
} from 'lucide-react';
import type { Role } from './types';

export interface QuickAction {
  key: string;
  label: string;
  icon: LucideIcon;
  roles: readonly Role[];
  kind: 'link' | 'capture';
  to?: string;
}

// Desktop speed-dial: commands only. Navigation belongs to the sidebar, and on mobile to the
// dedicated role-aware navigation below. Mixing both was why the old mobile surface could not say
// where the user was.
const QUICK_ACTIONS: readonly QuickAction[] = [
  { key: 'order', label: 'הזמנה חדשה', icon: ShoppingCart, kind: 'link', to: '/orders/new?fresh=1', roles: ['owner', 'office', 'kitchen'] },
  { key: 'capture', label: 'צילום מסמך', icon: Camera, kind: 'capture', roles: ['owner', 'office', 'kitchen'] },
  { key: 'invoice', label: 'חשבונית חדשה', icon: FilePlus, kind: 'link', to: '/invoices/new', roles: ['owner', 'office', 'kitchen'] },
];

export interface MobileNavigationItem {
  key: string;
  label: string;
  icon: LucideIcon;
  kind: 'link' | 'capture' | 'more';
  to?: string;
}

const HOME: MobileNavigationItem = { key: 'dashboard', label: 'בית', icon: LayoutDashboard, kind: 'link', to: '/dashboard' };
const CAPTURE: MobileNavigationItem = { key: 'capture', label: 'צילום מסמך', icon: Camera, kind: 'capture' };
const MORE: MobileNavigationItem = { key: 'more', label: 'עוד', icon: MoreHorizontal, kind: 'more' };

const MOBILE_NAVIGATION: Record<Role, readonly MobileNavigationItem[]> = {
  owner: [
    HOME,
    { key: 'invoices', label: 'חשבוניות', icon: FileText, kind: 'link', to: '/invoices' },
    CAPTURE,
    { key: 'orders', label: 'הזמנות', icon: ShoppingCart, kind: 'link', to: '/orders' },
    MORE,
  ],
  office: [
    HOME,
    { key: 'orders', label: 'הזמנות', icon: ShoppingCart, kind: 'link', to: '/orders' },
    CAPTURE,
    { key: 'invoices', label: 'חשבוניות', icon: FileText, kind: 'link', to: '/invoices' },
    MORE,
  ],
  kitchen: [
    HOME,
    { key: 'receiving', label: 'קבלה', icon: PackageCheck, kind: 'link', to: '/receiving' },
    CAPTURE,
    { key: 'documents', label: 'מסמכים', icon: FolderOpen, kind: 'link', to: '/documents' },
    MORE,
  ],
  accountant: [
    HOME,
    { key: 'invoices', label: 'חשבוניות', icon: FileText, kind: 'link', to: '/invoices' },
    { key: 'pay', label: 'לביצוע', icon: CreditCard, kind: 'link', to: '/pay' },
    { key: 'bank', label: 'בנק', icon: Landmark, kind: 'link', to: '/bank' },
    MORE,
  ],
  payer: [HOME, { key: 'pay', label: 'לביצוע', icon: CreditCard, kind: 'link', to: '/pay' }],
  supplier: [HOME, { key: 'prices', label: 'המחירון שלי', icon: Tags, kind: 'link', to: '/my-prices' }],
};

const FOCUS_PATHS = ['/orders/new', '/invoices/new', '/receiving/:orderId'] as const;

export function quickActionsFor(role: Role | null | undefined): QuickAction[] {
  return role ? QUICK_ACTIONS.filter((action) => action.roles.includes(role)) : [];
}

export function isFocusPath(pathname: string): boolean {
  return FOCUS_PATHS.some((path) => path.includes(':')
    ? pathname.startsWith(`${path.slice(0, path.indexOf('/:'))}/`)
    : pathname === path);
}

export function mobileNavigationFor(role: Role | null | undefined): MobileNavigationItem[] {
  return role ? [...MOBILE_NAVIGATION[role]] : [];
}

export function mobileNavigationForPath(role: Role | null | undefined, pathname: string): MobileNavigationItem[] {
  const items = mobileNavigationFor(role);
  return isFocusPath(pathname) ? items.filter((item) => item.kind === 'capture') : items;
}

/** One route-family rule shared by the desktop sidebar, drawer and mobile navigation. */
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
