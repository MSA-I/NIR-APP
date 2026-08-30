import { ACTIVE_ROLES, type ActiveRole } from './types.ts';

type AppRoutePolicyEntry = {
  /** React Router path. Query strings are governed separately by the assistant allowlist. */
  path: string;
  roles: readonly ActiveRole[];
};

const STAFF_ROLES = ['owner', 'office'] as const satisfies readonly ActiveRole[];
const MONEY_ROLES = ['owner', 'accountant'] as const satisfies readonly ActiveRole[];

/**
 * Canonical Guard contract for every product route the assistant may issue.
 *
 * App.tsx consumes both `path` and `roles` from this table, and routeAccess.ts points each source
 * allowlist entry back to one key here. That makes a Guard change and an assistant-route change a
 * single reviewed edit instead of two role lists that can silently drift.
 */
export const APP_ROUTE_POLICY = {
  dashboard: { path: '/dashboard', roles: ACTIVE_ROLES },
  // The suppliers LIST was the one screen App.tsx guarded with an inline role array instead of a
  // row here, and the omission was not cosmetic: `route` in the product-help registry must be a
  // key of this table, so no help entry could describe adding or editing a supplier at all. The
  // owner asked "אם אני רוצה להכניס ספק ידני איך אני עושה את זה" in production on 27.08.2026 and
  // was told there was no approved help record for it.
  suppliers: { path: '/suppliers', roles: STAFF_ROLES },
  supplierDetail: { path: '/suppliers/:id', roles: STAFF_ROLES },
  financialSupplierDetail: { path: '/finance/suppliers/:id', roles: MONEY_ROLES },
  products: { path: '/products', roles: STAFF_ROLES },
  inventory: { path: '/inventory', roles: STAFF_ROLES },
  prices: { path: '/prices', roles: STAFF_ROLES },
  newOrder: { path: '/orders/new', roles: STAFF_ROLES },
  orders: { path: '/orders', roles: STAFF_ROLES },
  orderDetail: { path: '/orders/:id', roles: STAFF_ROLES },
  receiving: { path: '/receiving', roles: STAFF_ROLES },
  documents: { path: '/documents', roles: STAFF_ROLES },
  invoices: { path: '/invoices', roles: ACTIVE_ROLES },
  invoiceDetail: { path: '/invoices/:id', roles: ACTIVE_ROLES },
  credits: { path: '/credits', roles: ACTIVE_ROLES },
  paymentRequests: { path: '/payment-requests', roles: STAFF_ROLES },
  payments: { path: '/payments', roles: MONEY_ROLES },
  bank: { path: '/bank', roles: MONEY_ROLES },
  exceptions: { path: '/exceptions', roles: ACTIVE_ROLES },
  alerts: { path: '/alerts', roles: STAFF_ROLES },
  expenses: { path: '/expenses', roles: MONEY_ROLES },
  reports: { path: '/reports', roles: MONEY_ROLES },
  productReport: { path: '/reports/products', roles: ACTIVE_ROLES },
  analytics: { path: '/analytics', roles: STAFF_ROLES },
  onboarding: { path: '/onboarding', roles: ['owner'] },
} as const satisfies Record<string, AppRoutePolicyEntry>;

export type AppRoutePolicyKey = keyof typeof APP_ROUTE_POLICY;

export function appRouteAllowsRole(route: AppRoutePolicyKey, role: ActiveRole): boolean {
  const roles = APP_ROUTE_POLICY[route].roles as readonly ActiveRole[];
  return roles.includes(role);
}
