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

// Each role sees only the actions it is allowed to perform. The bar is only worthwhile for
// roles with several day-to-day actions: procurement (owner/office/kitchen) and accountant.
// payer and supplier each live on a single screen, so quickActionsFor returns nothing for them
// and Fab renders no bar — we don't force a bar where there is little to do.
const QUICK_ACTIONS: readonly QuickAction[] = [
  { key: 'order', label: 'הזמנה חדשה', icon: ShoppingCart, kind: 'link', to: '/orders/new?fresh=1', roles: ['owner', 'office', 'kitchen'] },
  { key: 'dashboard', label: 'מרכז הבקרה', icon: LayoutDashboard, kind: 'link', to: '/dashboard', roles: ['owner', 'office', 'kitchen', 'accountant'] },
  { key: 'capture', label: 'צילום מסמך', icon: Camera, kind: 'capture', roles: ['owner', 'office', 'kitchen'] },
  { key: 'receive', label: 'קבלת סחורה', icon: PackageCheck, kind: 'link', to: '/receiving', roles: ['owner', 'office', 'kitchen'] },
  { key: 'invoice', label: 'חשבונית חדשה', icon: FilePlus, kind: 'link', to: '/invoices/new', roles: ['owner', 'office', 'kitchen'] },
  { key: 'invoices', label: 'חשבוניות', icon: FileText, kind: 'link', to: '/invoices', roles: ['accountant'] },
  { key: 'pay', label: 'תשלומים', icon: CreditCard, kind: 'link', to: '/pay', roles: ['accountant'] },
];

export function quickActionsFor(role: Role | null | undefined): QuickAction[] {
  return role ? QUICK_ACTIONS.filter((action) => action.roles.includes(role)) : [];
}
