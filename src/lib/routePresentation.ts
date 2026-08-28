import type { TKey } from './i18n/t.ts';

/**
 * Canonical user-facing names for authenticated routes.
 *
 * Authorization stays in App.tsx and Layout's role-aware navigation. This catalogue owns only
 * presentation, so a route cannot quietly acquire a different name in the drawer, sticky phone
 * header and browser title.
 */
export const STATIC_ROUTE_TITLES = {
  '/dashboard': 'nav.routeTitle_dashboard',
  '/suppliers': 'nav.routeTitle_suppliers',
  '/products': 'nav.routeTitle_products',
  '/inventory': 'nav.routeTitle_inventory',
  '/prices': 'nav.routeTitle_prices',
  '/orders/new': 'nav.routeTitle_ordersNew',
  '/orders': 'nav.routeTitle_orders',
  '/receiving': 'nav.routeTitle_receiving',
  '/invoices/new': 'nav.routeTitle_invoicesNew',
  '/invoices': 'nav.routeTitle_invoices',
  '/documents': 'nav.routeTitle_documents',
  '/documents/operations': 'nav.routeTitle_documentsOperations',
  '/documents/consolidated-invoices': 'nav.routeTitle_documentsConsolidatedInvoices',
  '/documents/archive': 'nav.routeTitle_documentsArchive',
  '/credits': 'nav.routeTitle_credits',
  '/payment-requests': 'nav.routeTitle_paymentRequests',
  '/payments': 'nav.routeTitle_payments',
  '/pay': 'nav.routeTitle_pay',
  '/bank': 'nav.routeTitle_bank',
  '/exceptions': 'nav.routeTitle_exceptions',
  '/alerts': 'nav.routeTitle_alerts',
  '/expenses': 'nav.routeTitle_expenses',
  '/reports': 'nav.routeTitle_reports',
  '/reports/products': 'nav.routeTitle_reportsProducts',
  '/analytics': 'nav.routeTitle_analytics',
  '/supplier-log': 'nav.routeTitle_supplierLog',
  '/settings': 'nav.routeTitle_settings',
  '/settings/subscription': 'nav.routeTitle_settingsSubscription',
  '/onboarding': 'nav.routeTitle_onboarding',
} as const satisfies Record<string, TKey>;

export type StaticRoutePath = keyof typeof STATIC_ROUTE_TITLES;

export function staticRouteTitle(path: StaticRoutePath): TKey {
  return STATIC_ROUTE_TITLES[path];
}

/**
 * The one-line answer to "what do I do on this screen", per route.
 *
 * A separate map rather than a `{ title, description }` record on purpose: the titles above are
 * already read by the drawer, the sticky phone header and the browser title, and widening that
 * shape would push a sentence into three places that want a name. `Record<StaticRoutePath, string>`
 * is what keeps the two maps honest — adding a route to `STATIC_ROUTE_TITLES` without describing it
 * is a type error here, not a screen that quietly ships without a description.
 *
 * These sentences say what a person DOES here; they do not restate the title, and they are not a
 * status line. A screen with live numbers to report (`/alerts` freshness, `/supplier-log` row
 * count) keeps reporting them through `meta` — the description sits above that, unchanging.
 */
export const STATIC_ROUTE_DESCRIPTIONS: Record<StaticRoutePath, TKey> = {
  '/dashboard': 'nav.routeDesc_dashboard',
  '/suppliers': 'nav.routeDesc_suppliers',
  '/products': 'nav.routeDesc_products',
  '/inventory': 'nav.routeDesc_inventory',
  '/prices': 'nav.routeDesc_prices',
  '/orders/new': 'nav.routeDesc_ordersNew',
  '/orders': 'nav.routeDesc_orders',
  '/receiving': 'nav.routeDesc_receiving',
  '/invoices/new': 'nav.routeDesc_invoicesNew',
  '/invoices': 'nav.routeDesc_invoices',
  '/documents': 'nav.routeDesc_documents',
  '/documents/operations': 'nav.routeDesc_documentsOperations',
  '/documents/consolidated-invoices': 'nav.routeDesc_documentsConsolidatedInvoices',
  '/documents/archive': 'nav.routeDesc_documentsArchive',
  '/credits': 'nav.routeDesc_credits',
  '/payment-requests': 'nav.routeDesc_paymentRequests',
  '/payments': 'nav.routeDesc_payments',
  '/pay': 'nav.routeDesc_pay',
  '/bank': 'nav.routeDesc_bank',
  '/exceptions': 'nav.routeDesc_exceptions',
  '/alerts': 'nav.routeDesc_alerts',
  '/expenses': 'nav.routeDesc_expenses',
  '/reports': 'nav.routeDesc_reports',
  '/reports/products': 'nav.routeDesc_reportsProducts',
  '/analytics': 'nav.routeDesc_analytics',
  '/supplier-log': 'nav.routeDesc_supplierLog',
  '/settings': 'nav.routeDesc_settings',
  '/settings/subscription': 'nav.routeDesc_settingsSubscription',
  '/onboarding': 'nav.routeDesc_onboarding',
};

export const DYNAMIC_ROUTE_TITLES: readonly [RegExp, TKey][] = [
  [/^\/finance\/suppliers\/[^/]+$/, 'nav.routeTitleDyn_1'],
  [/^\/suppliers\/[^/]+$/, 'nav.routeTitleDyn_2'],
  [/^\/orders\/[^/]+$/, 'nav.routeTitleDyn_3'],
  [/^\/receiving\/[^/]+$/, 'nav.routeTitleDyn_4'],
  [/^\/receipts\/[^/]+$/, 'nav.routeTitleDyn_5'],
  [/^\/invoices\/[^/]+$/, 'nav.routeTitleDyn_6'],
  [/^\/documents\/[^/]+\/review$/, 'nav.routeTitleDyn_7'],
];

/**
 * Same patterns, same order as `DYNAMIC_ROUTE_TITLES`. The type system cannot enforce that for a
 * tuple list the way `Record<StaticRoutePath, string>` does above, so the spec compares the two
 * pattern sources directly — a pattern added to one list and not the other fails the suite.
 */
export const DYNAMIC_ROUTE_DESCRIPTIONS: readonly [RegExp, TKey][] = [
  [/^\/finance\/suppliers\/[^/]+$/, 'nav.routeDescDyn_1'],
  [/^\/suppliers\/[^/]+$/, 'nav.routeDescDyn_2'],
  [/^\/orders\/[^/]+$/, 'nav.routeDescDyn_3'],
  [/^\/receiving\/[^/]+$/, 'nav.routeDescDyn_4'],
  [/^\/receipts\/[^/]+$/, 'nav.routeDescDyn_5'],
  [/^\/invoices\/[^/]+$/, 'nav.routeDescDyn_6'],
  [/^\/documents\/[^/]+\/review$/, 'nav.routeDescDyn_7'],
];

export function routePresentationTitle(pathname: string): TKey | null {
  const exact = STATIC_ROUTE_TITLES[pathname as StaticRoutePath];
  return exact ?? DYNAMIC_ROUTE_TITLES.find(([pattern]) => pattern.test(pathname))?.[1] ?? null;
}

export function routePresentationDescription(pathname: string): TKey | null {
  const exact = STATIC_ROUTE_DESCRIPTIONS[pathname as StaticRoutePath];
  return exact ?? DYNAMIC_ROUTE_DESCRIPTIONS.find(([pattern]) => pattern.test(pathname))?.[1] ?? null;
}

const STATIC_ROUTE_BACK: Partial<Record<StaticRoutePath, { to: string; label: TKey }>> = {
  '/orders/new': { to: '/orders', label: 'nav.backToOrders' },
  '/invoices/new': { to: '/invoices', label: 'nav.backToInvoices' },
  '/reports/products': { to: '/reports', label: 'nav.backToReports' },
};

const DYNAMIC_ROUTE_BACK: readonly [RegExp, { to: string; label: TKey }][] = [
  [/^\/suppliers\/[^/]+$/, { to: '/suppliers', label: 'nav.backToSuppliers' }],
  [/^\/finance\/suppliers\/[^/]+$/, { to: '/dashboard', label: 'nav.backToDashboard' }],
  [/^\/orders\/[^/]+$/, { to: '/orders', label: 'nav.backToOrders' }],
  [/^\/receiving\/[^/]+$/, { to: '/receiving', label: 'nav.backToReceiving' }],
  [/^\/receipts\/[^/]+$/, { to: '/receiving', label: 'nav.backToReceiving' }],
  [/^\/invoices\/[^/]+$/, { to: '/invoices', label: 'nav.backToInvoices' }],
  [/^\/documents\/[^/]+\/review$/, { to: '/documents', label: 'nav.backToDocuments' }],
];

export function routeBackPresentation(pathname: string): { to: string; label: TKey } | null {
  return STATIC_ROUTE_BACK[pathname as StaticRoutePath]
    ?? DYNAMIC_ROUTE_BACK.find(([pattern]) => pattern.test(pathname))?.[1]
    ?? null;
}
