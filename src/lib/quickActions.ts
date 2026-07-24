import { Camera, FilePlus, PackageCheck, PieChart, ShoppingCart, type LucideIcon } from 'lucide-react';
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
  { key: 'capture', label: 'צילום מסמך', icon: Camera, kind: 'capture', roles: ['owner', 'office', 'kitchen'] },
  { key: 'order', label: 'הזמנה חדשה', icon: ShoppingCart, kind: 'link', to: '/orders/new', roles: ['owner', 'office', 'kitchen'] },
  { key: 'receive', label: 'קבלת סחורה', icon: PackageCheck, kind: 'link', to: '/receiving', roles: ['owner', 'office', 'kitchen'] },
  { key: 'invoice', label: 'חשבונית חדשה', icon: FilePlus, kind: 'link', to: '/invoices/new', roles: ['owner', 'office', 'kitchen'] },
  { key: 'expenses', label: 'ריכוז הוצאות', icon: PieChart, kind: 'link', to: '/expenses', roles: ['owner', 'office'] },
];

export function quickActionsFor(role: string | null | undefined): QuickAction[] {
  return role ? QUICK_ACTIONS.filter((action) => action.roles.includes(role as Role)) : [];
}
