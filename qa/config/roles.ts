export const QA_ROLES = ['owner', 'office', 'kitchen', 'payer', 'accountant', 'supplier'] as const;
export const QA_ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
export const QA_SUPPLIER_PROFILE_ID = 'aa000000-0000-4000-8000-000000000001';

export type QaRole = (typeof QA_ROLES)[number];

export const ROLE_EMAILS: Readonly<Record<QaRole, string>> = {
  owner: 'owner@demo.supplyflow.local',
  office: 'office@demo.supplyflow.local',
  kitchen: 'kitchen@demo.supplyflow.local',
  payer: 'payer@demo.supplyflow.local',
  accountant: 'accountant@demo.supplyflow.local',
  supplier: 'supplier@demo.supplyflow.local',
};

export type UiRole = 'button' | 'link' | 'combobox' | 'heading';

export interface RouteExpectation {
  readonly path: string;
  readonly heading: string;
}

export interface DeniedRouteExpectation {
  readonly path: string;
  readonly redirectedTo: '/dashboard';
}

export interface RoleContract {
  readonly role: QaRole;
  readonly home: '/dashboard';
  readonly dashboardHeading: string;
  readonly coreRoute: RouteExpectation;
  readonly coreControl: {
    readonly role: UiRole;
    readonly name: string;
  };
  readonly representativeAllowedRoutes: readonly RouteExpectation[];
  readonly deniedRoutes: readonly DeniedRouteExpectation[];
}

const denied = (...paths: readonly string[]): readonly DeniedRouteExpectation[] =>
  paths.map((path) => ({ path, redirectedTo: '/dashboard' as const }));

export const ROLE_CONTRACTS: Readonly<Record<QaRole, RoleContract>> = {
  owner: {
    role: 'owner',
    home: '/dashboard',
    dashboardHeading: 'מרכז הבקרה',
    coreRoute: { path: '/dashboard', heading: 'מרכז הבקרה' },
    coreControl: { role: 'button', name: 'רענון נתוני מרכז הבקרה' },
    representativeAllowedRoutes: [
      { path: '/dashboard', heading: 'מרכז הבקרה' },
      { path: '/settings', heading: 'הגדרות מערכת' },
    ],
    deniedRoutes: denied('/my-prices', '/pay'),
  },
  office: {
    role: 'office',
    home: '/dashboard',
    dashboardHeading: 'מרכז הבקרה',
    coreRoute: { path: '/invoices', heading: 'חשבוניות' },
    coreControl: { role: 'button', name: 'חשבונית חדשה' },
    representativeAllowedRoutes: [
      { path: '/invoices', heading: 'חשבוניות' },
      { path: '/payment-requests', heading: 'דרישות תשלום' },
    ],
    deniedRoutes: denied('/payments', '/pay', '/bank', '/reports', '/audit', '/settings', '/my-prices'),
  },
  kitchen: {
    role: 'kitchen',
    home: '/dashboard',
    dashboardHeading: 'מרכז הבקרה — מטבח',
    coreRoute: { path: '/receiving', heading: 'קבלת סחורה' },
    coreControl: { role: 'combobox', name: 'סינון הזמנות לקבלה' },
    representativeAllowedRoutes: [
      { path: '/receiving', heading: 'קבלת סחורה' },
      { path: '/orders', heading: 'הזמנות רכש' },
    ],
    deniedRoutes: denied('/payment-requests', '/payments', '/pay', '/bank', '/reports', '/audit', '/settings', '/my-prices'),
  },
  payer: {
    role: 'payer',
    home: '/dashboard',
    dashboardHeading: 'מרכז הבקרה — ביצוע העברות',
    coreRoute: { path: '/pay', heading: 'תשלומים לביצוע' },
    coreControl: { role: 'link', name: 'תשלומים לביצוע' },
    representativeAllowedRoutes: [
      { path: '/dashboard', heading: 'מרכז הבקרה — ביצוע העברות' },
      { path: '/pay', heading: 'תשלומים לביצוע' },
    ],
    deniedRoutes: denied(
      '/suppliers',
      '/orders',
      '/receiving',
      '/invoices',
      '/documents',
      '/payment-requests',
      '/payments',
      '/bank',
      '/reports',
      '/audit',
      '/settings',
      '/my-prices',
    ),
  },
  accountant: {
    role: 'accountant',
    home: '/dashboard',
    dashboardHeading: 'מרכז הבקרה — הנהלת חשבונות',
    coreRoute: { path: '/reports', heading: 'דוח חודשי לרואת חשבון' },
    coreControl: { role: 'button', name: 'ייצוא Excel' },
    representativeAllowedRoutes: [
      { path: '/reports', heading: 'דוח חודשי לרואת חשבון' },
      { path: '/bank', heading: 'התאמות בנק' },
    ],
    deniedRoutes: denied('/suppliers', '/orders', '/receiving', '/documents', '/payment-requests', '/settings', '/my-prices'),
  },
  supplier: {
    role: 'supplier',
    home: '/dashboard',
    dashboardHeading: 'מרכז הבקרה — ספק',
    coreRoute: { path: '/my-prices', heading: 'המחירון שלי' },
    coreControl: { role: 'button', name: 'הגשת מחירון חודשי' },
    representativeAllowedRoutes: [
      { path: '/dashboard', heading: 'מרכז הבקרה — ספק' },
      { path: '/my-prices', heading: 'המחירון שלי' },
    ],
    deniedRoutes: denied(
      '/suppliers',
      '/orders',
      '/receiving',
      '/invoices',
      '/payment-requests',
      '/pay',
      '/payments',
      '/bank',
      '/reports',
      '/audit',
      '/settings',
    ),
  },
};

const ALL = QA_ROLES;
const STAFF = ['owner', 'office', 'kitchen'] as const;
const FINANCE = ['owner', 'office'] as const;
const READERS = ['owner', 'office', 'kitchen', 'accountant'] as const;

interface RouteRule {
  readonly pattern: RegExp;
  readonly roles: readonly QaRole[];
}

// Mirrors App.tsx. Platform administration is intentionally absent: it is not a tenant role.
export const ROUTE_RULES: readonly RouteRule[] = [
  { pattern: /^\/dashboard$/, roles: ALL },
  { pattern: /^\/(?:suppliers(?:\/[^/]+)?|products|prices|orders(?:\/new|\/[^/]+)?|receiving(?:\/[^/]+)?|invoices\/new|documents)$/, roles: STAFF },
  { pattern: /^\/invoices(?:\/[^/]+)?$/, roles: READERS },
  { pattern: /^\/documents\/[^/]+\/review$/, roles: ['owner', 'office', 'kitchen', 'supplier'] },
  { pattern: /^\/inbox$/, roles: STAFF },
  { pattern: /^\/credits$/, roles: READERS },
  { pattern: /^\/payment-requests$/, roles: FINANCE },
  { pattern: /^\/payments$/, roles: ['owner', 'accountant'] },
  { pattern: /^\/pay\/emergency$/, roles: ['owner'] },
  { pattern: /^\/pay$/, roles: ['payer', 'accountant'] },
  { pattern: /^\/bank$/, roles: ['owner', 'accountant'] },
  { pattern: /^\/exceptions$/, roles: READERS },
  { pattern: /^\/alerts$/, roles: FINANCE },
  { pattern: /^\/(?:expenses|reports|audit)$/, roles: ['owner', 'accountant'] },
  { pattern: /^\/analytics$/, roles: ['owner', 'office', 'accountant'] },
  { pattern: /^\/(?:settings|onboarding)$/, roles: ['owner'] },
  { pattern: /^\/my-prices$/, roles: ['supplier'] },
];

export function isQaRole(value: unknown): value is QaRole {
  return typeof value === 'string' && QA_ROLES.includes(value as QaRole);
}

export function roleFromProjectName(projectName: string): QaRole {
  const value = projectName.replace(/^role-/, '');
  if (!isQaRole(value)) throw new Error(`Playwright project does not identify a QA role: ${projectName}`);
  return value;
}

export function isRouteAllowed(role: QaRole, route: string): boolean {
  if (!route.startsWith('/') || route.startsWith('//')) return false;
  const url = new URL(route, 'http://127.0.0.1');
  if (url.origin !== 'http://127.0.0.1') return false;
  const path = url.pathname;
  const rule = ROUTE_RULES.find(({ pattern }) => pattern.test(path));
  return rule?.roles.includes(role) ?? false;
}
