import { Camera, FilePlus, LayoutDashboard, PackageCheck, ShoppingCart, type LucideIcon } from 'lucide-react';
import type { Role } from './types';

export interface QuickAction {
  key: string;
  label: string;
  icon: LucideIcon;
  roles: readonly Role[];
  kind: 'link' | 'capture';
  to?: string;
}

const QUICK_ACTIONS: readonly QuickAction[] = [
  { key: 'order', label: 'הזמנה חדשה', icon: ShoppingCart, kind: 'link', to: '/orders/new?fresh=1', roles: ['owner', 'office', 'kitchen'] },
  { key: 'dashboard', label: 'מרכז הבקרה', icon: LayoutDashboard, kind: 'link', to: '/dashboard', roles: ['owner', 'office'] },
  { key: 'capture', label: 'צילום מסמך', icon: Camera, kind: 'capture', roles: ['owner', 'office', 'kitchen'] },
  { key: 'receive', label: 'קבלת סחורה', icon: PackageCheck, kind: 'link', to: '/receiving', roles: ['owner', 'office', 'kitchen'] },
  { key: 'invoice', label: 'חשבונית חדשה', icon: FilePlus, kind: 'link', to: '/invoices/new', roles: ['owner', 'office', 'kitchen'] },
];

export function quickActionsFor(role: Role | null | undefined): QuickAction[] {
  return role ? QUICK_ACTIONS.filter((action) => action.roles.includes(role)) : [];
}
