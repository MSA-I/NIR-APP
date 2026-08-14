/**
 * Canonical user-facing names for authenticated routes.
 *
 * Authorization stays in App.tsx and Layout's role-aware navigation. This catalogue owns only
 * presentation, so a route cannot quietly acquire a different name in the drawer, sticky phone
 * header and browser title.
 */
export const STATIC_ROUTE_TITLES = {
  '/admin': 'ניהול פלטפורמה',
  '/dashboard': 'מרכז הבקרה',
  '/suppliers': 'ספקים',
  '/products': 'מוצרים',
  '/inventory': 'מלאי',
  '/prices': 'מחירונים',
  '/orders/new': 'הזמנה חדשה',
  '/orders': 'הזמנות רכש',
  '/receiving': 'קבלת סחורה',
  '/invoices/new': 'חשבונית חדשה',
  '/invoices': 'חשבוניות',
  '/documents': 'תיקיית המסמכים',
  '/documents/operations': 'בקרת מסמכים',
  '/documents/consolidated-invoices': 'חשבוניות מרכזות',
  '/documents/archive': 'ארכיון מסמכים',
  '/credits': 'זיכויים',
  '/payment-requests': 'דרישות תשלום',
  '/payments': 'תשלומים',
  '/pay': 'תשלומים לביצוע',
  '/bank': 'התאמות בנק',
  '/exceptions': 'חריגים',
  '/alerts': 'התראות',
  '/expenses': 'ריכוז הוצאות',
  '/reports': 'דוח לרו״ח',
  '/reports/products': 'סיכום רכישות מוצרים',
  '/analytics': 'ביצועי ספקים',
  '/settings': 'הגדרות מערכת',
  '/onboarding': 'הקמת המערכת',
} as const;

export type StaticRoutePath = keyof typeof STATIC_ROUTE_TITLES;

export function staticRouteTitle(path: StaticRoutePath): string {
  return STATIC_ROUTE_TITLES[path];
}

const DYNAMIC_ROUTE_TITLES: readonly [RegExp, string][] = [
  [/^\/finance\/suppliers\/[^/]+$/, 'כרטיס ספק פיננסי'],
  [/^\/suppliers\/[^/]+$/, 'כרטיס ספק'],
  [/^\/orders\/[^/]+$/, 'פרטי הזמנה'],
  [/^\/receiving\/[^/]+$/, 'קבלת סחורה'],
  [/^\/receipts\/[^/]+$/, 'פרטי קבלה'],
  [/^\/invoices\/[^/]+$/, 'פרטי חשבונית'],
  [/^\/documents\/[^/]+\/review$/, 'בדיקת מסמך'],
];

export function routePresentationTitle(pathname: string): string | null {
  const exact = STATIC_ROUTE_TITLES[pathname as StaticRoutePath];
  return exact ?? DYNAMIC_ROUTE_TITLES.find(([pattern]) => pattern.test(pathname))?.[1] ?? null;
}

const STATIC_ROUTE_BACK: Partial<Record<StaticRoutePath, { to: string; label: string }>> = {
  '/orders/new': { to: '/orders', label: 'חזרה להזמנות רכש' },
  '/invoices/new': { to: '/invoices', label: 'חזרה לחשבוניות' },
  '/reports/products': { to: '/reports', label: 'חזרה לדוח לרו״ח' },
};

const DYNAMIC_ROUTE_BACK: readonly [RegExp, { to: string; label: string }][] = [
  [/^\/suppliers\/[^/]+$/, { to: '/suppliers', label: 'חזרה לספקים' }],
  [/^\/finance\/suppliers\/[^/]+$/, { to: '/dashboard', label: 'חזרה למרכז הבקרה' }],
  [/^\/orders\/[^/]+$/, { to: '/orders', label: 'חזרה להזמנות רכש' }],
  [/^\/receiving\/[^/]+$/, { to: '/receiving', label: 'חזרה לקבלת סחורה' }],
  [/^\/receipts\/[^/]+$/, { to: '/receiving', label: 'חזרה לקבלת סחורה' }],
  [/^\/invoices\/[^/]+$/, { to: '/invoices', label: 'חזרה לחשבוניות' }],
  [/^\/documents\/[^/]+\/review$/, { to: '/documents', label: 'חזרה למסמכים' }],
];

export function routeBackPresentation(pathname: string): { to: string; label: string } | null {
  return STATIC_ROUTE_BACK[pathname as StaticRoutePath]
    ?? DYNAMIC_ROUTE_BACK.find(([pattern]) => pattern.test(pathname))?.[1]
    ?? null;
}
