/** Database history still contains all six enum values; browser accounts cover the active product. */
export const HISTORICAL_ROLES = ['owner', 'office', 'kitchen', 'payer', 'accountant', 'supplier'] as const;
export type HistoricalRole = (typeof HISTORICAL_ROLES)[number];

export const QA_ROLES = ['owner', 'office', 'accountant'] as const;
export const QA_ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';
export const QA_SUPPLIER_PROFILE_ID = 'aa000000-0000-4000-8000-000000000001';

/** Scenario/evidence vocabulary remains able to read archived six-role QA artifacts. */
export type QaRole = HistoricalRole;
/** Only these roles may own credentials, storage state or a live browser project. */
export type ActiveQaRole = (typeof QA_ROLES)[number];

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
  readonly role: ActiveQaRole;
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

export const ROLE_CONTRACTS: Readonly<Record<ActiveQaRole, RoleContract>> = {
  owner: {
    role: 'owner',
    home: '/dashboard',
    dashboardHeading: 'מרכז הבקרה',
    coreRoute: { path: '/dashboard', heading: 'מרכז הבקרה' },
    coreControl: { role: 'button', name: 'רענון נתוני מרכז הבקרה' },
    representativeAllowedRoutes: [
      { path: '/dashboard', heading: 'מרכז הבקרה' },
      { path: '/settings', heading: 'הגדרות מערכת' },
      { path: '/inventory', heading: 'מלאי' },
      { path: '/documents/operations', heading: 'מרכז תפעול מסמכים' },
    ],
    deniedRoutes: denied('/my-prices', '/pay'),
  },
  office: {
    role: 'office',
    home: '/dashboard',
    dashboardHeading: 'מרכז הבקרה',
    coreRoute: { path: '/invoices', heading: 'חשבוניות' },
    coreControl: { role: 'button', name: 'העלאת מסמך שהתקבל' },
    representativeAllowedRoutes: [
      { path: '/invoices', heading: 'חשבוניות' },
      { path: '/payment-requests', heading: 'דרישות תשלום' },
      { path: '/inventory', heading: 'מלאי' },
    ],
    deniedRoutes: denied('/documents/operations', '/payments', '/pay', '/bank', '/reports', '/audit', '/settings', '/my-prices'),
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
    deniedRoutes: denied('/suppliers', '/orders', '/receiving', '/receipts/example-id', '/documents', '/documents/operations', '/inventory', '/payment-requests', '/analytics', '/settings'),
  },
};

const ALL = QA_ROLES;
const STAFF = ['owner', 'office'] as const;
const FINANCE = ['owner', 'office'] as const;
const READERS = ['owner', 'office', 'accountant'] as const;

interface RouteRule {
  readonly pattern: RegExp;
  readonly roles: readonly ActiveQaRole[];
}

// Mirrors App.tsx. Platform administration is intentionally absent: it is not a tenant role.
export const ROUTE_RULES: readonly RouteRule[] = [
  { pattern: /^\/dashboard$/, roles: ALL },
  { pattern: /^\/documents\/operations$/, roles: ['owner'] },
  { pattern: /^\/finance\/suppliers\/[^/]+$/, roles: ['owner', 'accountant'] },
  { pattern: /^\/(?:suppliers(?:\/[^/]+)?|products|inventory|prices|orders(?:\/new|\/[^/]+)?|receiving(?:\/[^/]+)?|invoices\/new|documents(?:\/archive)?)$/, roles: STAFF },
  { pattern: /^\/receipts\/[^/]+$/, roles: STAFF },
  { pattern: /^\/invoices(?:\/[^/]+)?$/, roles: READERS },
  { pattern: /^\/documents\/[^/]+\/review$/, roles: ['owner', 'office'] },
  { pattern: /^\/inbox$/, roles: STAFF },
  { pattern: /^\/credits$/, roles: READERS },
  { pattern: /^\/payment-requests$/, roles: FINANCE },
  { pattern: /^\/payments$/, roles: ['owner', 'accountant'] },
  { pattern: /^\/pay$/, roles: ['accountant'] },
  { pattern: /^\/bank$/, roles: ['owner', 'accountant'] },
  { pattern: /^\/exceptions$/, roles: READERS },
  { pattern: /^\/alerts$/, roles: FINANCE },
  { pattern: /^\/(?:expenses|reports)$/, roles: ['owner', 'accountant'] },
  { pattern: /^\/reports\/products$/, roles: ALL },
  { pattern: /^\/analytics$/, roles: ['owner', 'office'] },
  { pattern: /^\/(?:settings|onboarding)$/, roles: ['owner'] },
];

export function isQaRole(value: unknown): value is QaRole {
  return typeof value === 'string' && HISTORICAL_ROLES.includes(value as QaRole);
}

export function roleFromProjectName(projectName: string): ActiveQaRole {
  const value = projectName.replace(/^role-/, '');
  if (!(QA_ROLES as readonly string[]).includes(value)) {
    throw new Error(`Playwright project does not identify an active QA role: ${projectName}`);
  }
  return value as ActiveQaRole;
}

export function isRouteAllowed(role: HistoricalRole, route: string): boolean {
  if (!(QA_ROLES as readonly string[]).includes(role)) return false;
  if (!route.startsWith('/') || route.startsWith('//')) return false;
  const url = new URL(route, 'http://127.0.0.1');
  if (url.origin !== 'http://127.0.0.1') return false;
  const path = url.pathname;
  const rule = ROUTE_RULES.find(({ pattern }) => pattern.test(path));
  return rule?.roles.includes(role as ActiveQaRole) ?? false;
}
