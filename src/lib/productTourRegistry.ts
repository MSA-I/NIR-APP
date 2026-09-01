import type { ProductHelpEntry, ProductHelpLocale } from './assistant/contracts.ts';
import { PRODUCT_HELP_ENTRIES } from './assistant/productHelpRegistry.ts';
import { APP_ROUTE_POLICY } from './routePolicy.ts';

export const OWNER_FIRST_RUN_TOUR_ID = 'owner-first-run-v1';

export type TourAnchor =
  | 'dashboard-heading'
  | 'dashboard-attention'
  | 'global-search'
  | 'primary-navigation'
  | 'nav-suppliers'
  | 'suppliers-new'
  | 'nav-prices'
  | 'prices-upload'
  | 'new-order-flow'
  | 'receiving-overview'
  | 'documents-upload'
  | 'invoices-overview'
  | 'payment-requests-overview'
  | 'reports-overview'
  | 'onboarding-start';

const NAVIGATION_ANCHORS: Readonly<Record<string, TourAnchor>> = {
  '/suppliers': 'nav-suppliers',
  '/prices': 'nav-prices',
  '/onboarding': 'onboarding-start',
};

export function tourNavigationAnchor(path: string): TourAnchor | undefined {
  return NAVIGATION_ANCHORS[path];
}

export type ProductTourStepId =
  | 'welcome'
  | 'attention'
  | 'search'
  | 'navigation'
  | 'open-suppliers'
  | 'supplier-screen'
  | 'open-prices'
  | 'price-list-screen'
  | 'open-new-order'
  | 'new-order-screen'
  | 'receiving-screen'
  | 'documents-screen'
  | 'invoices-screen'
  | 'payment-requests-screen'
  | 'reports-screen'
  | 'start-onboarding';

export interface ProductTourStep {
  id: ProductTourStepId;
  route: string;
  anchor: TourAnchor;
  helpId: string;
  helpStep: number;
  advance: 'next' | 'click';
  /** Route reached by the highlighted link. Omitted for informational steps. */
  destination?: string;
  /**
   * This step's anchor is inside the navigation, so the navigation has to be opened before the
   * spotlight can find it — the phone drawer, or the desktop disclosure holding `destination`.
   *
   * A FLAG, deliberately, and not the name of a group. It used to be
   * `'navigation' | 'management' | 'control' | 'account'`, and `Layout.tsx` turned those words
   * into group keys through a literal map. When the menu was regrouped by subject on 28.08.2026
   * the map kept naming groups that no longer existed and the tour stalled on a closed dropdown.
   * WHICH group to open is not a fact this registry knows — it is a fact `NAV_GROUPS` knows about
   * `destination`, and `tourGroupForDestination` reads it there.
   */
  prepare?: true;
}

export const OWNER_FIRST_RUN_TOUR: readonly ProductTourStep[] = [
  { id: 'welcome', route: '/dashboard', anchor: 'dashboard-heading', helpId: 'see_business_state_now', helpStep: 0, advance: 'next' },
  { id: 'attention', route: '/dashboard', anchor: 'dashboard-attention', helpId: 'see_dashboard_attention', helpStep: 0, advance: 'next' },
  { id: 'search', route: '/dashboard', anchor: 'global-search', helpId: 'use_global_search', helpStep: 0, advance: 'next' },
  { id: 'navigation', route: '/dashboard', anchor: 'primary-navigation', helpId: 'navigate_product_workspace', helpStep: 0, advance: 'next' },
  { id: 'open-suppliers', route: '/dashboard', destination: '/suppliers', anchor: 'nav-suppliers', helpId: 'add_supplier', helpStep: 0, advance: 'click', prepare: true },
  { id: 'supplier-screen', route: '/suppliers', anchor: 'suppliers-new', helpId: 'add_supplier', helpStep: 1, advance: 'next' },
  { id: 'open-prices', route: '/suppliers', destination: '/prices', anchor: 'nav-prices', helpId: 'upload_price_list', helpStep: 0, advance: 'click', prepare: true },
  { id: 'price-list-screen', route: '/prices', anchor: 'prices-upload', helpId: 'upload_price_list', helpStep: 1, advance: 'next' },
  { id: 'open-new-order', route: '/prices', destination: '/orders/new', anchor: 'primary-navigation', helpId: 'explain_purchase_order_flow', helpStep: 0, advance: 'next' },
  { id: 'new-order-screen', route: '/orders/new', anchor: 'new-order-flow', helpId: 'explain_purchase_order_flow', helpStep: 1, advance: 'next' },
  { id: 'receiving-screen', route: '/receiving', anchor: 'receiving-overview', helpId: 'receive_goods', helpStep: 0, advance: 'next' },
  { id: 'documents-screen', route: '/documents', anchor: 'documents-upload', helpId: 'upload_document', helpStep: 0, advance: 'next' },
  { id: 'invoices-screen', route: '/invoices', anchor: 'invoices-overview', helpId: 'check_invoice_status', helpStep: 3, advance: 'next' },
  { id: 'payment-requests-screen', route: '/payment-requests', anchor: 'payment-requests-overview', helpId: 'open_a_payment_request', helpStep: 0, advance: 'next' },
  { id: 'reports-screen', route: '/reports', anchor: 'reports-overview', helpId: 'prepare_monthly_report', helpStep: 0, advance: 'next' },
  { id: 'start-onboarding', route: '/dashboard', destination: '/onboarding', anchor: 'onboarding-start', helpId: 'start_owner_onboarding', helpStep: 0, advance: 'click', prepare: true },
] as const;

export interface ProductTourProgress {
  tourId: typeof OWNER_FIRST_RUN_TOUR_ID;
  status: 'active' | 'dismissed' | 'completed';
  stepId: ProductTourStepId;
  updatedAt: string;
}

export function productTourProgressKey(orgId: string, userId: string): string {
  return `inplace.product-tour.${OWNER_FIRST_RUN_TOUR_ID}.${orgId}.${userId}`;
}

function isStepId(value: unknown): value is ProductTourStepId {
  return typeof value === 'string' && OWNER_FIRST_RUN_TOUR.some((step) => step.id === value);
}

export function loadProductTourProgress(orgId: string, userId: string): ProductTourProgress | null {
  try {
    const raw = localStorage.getItem(productTourProgressKey(orgId, userId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<ProductTourProgress>;
    if (value.tourId !== OWNER_FIRST_RUN_TOUR_ID) return null;
    if (!['active', 'dismissed', 'completed'].includes(value.status ?? '')) return null;
    if (!isStepId(value.stepId) || typeof value.updatedAt !== 'string') return null;
    return value as ProductTourProgress;
  } catch {
    return null;
  }
}

export function saveProductTourProgress(orgId: string, userId: string, progress: ProductTourProgress): void {
  try {
    localStorage.setItem(productTourProgressKey(orgId, userId), JSON.stringify(progress));
  } catch {
    // The tour remains usable for this render when storage is unavailable.
  }
}

export function resolveProductTourCopy(
  step: ProductTourStep,
  entries: readonly ProductHelpEntry[] = PRODUCT_HELP_ENTRIES,
  locale: ProductHelpLocale = 'he',
): { title: string; body: string } {
  const entry = entries.find((candidate) => candidate.locale === locale && candidate.id === step.helpId);
  if (!entry || !entry.roles.includes('owner') || !entry.steps[step.helpStep]) {
    throw new Error(`invalid owner product-tour copy: ${locale}:${step.id}`);
  }
  return { title: entry.label, body: entry.steps[step.helpStep] };
}

export function productTourRegistryDefects(
  steps: readonly ProductTourStep[],
  entries: readonly ProductHelpEntry[] = PRODUCT_HELP_ENTRIES,
): readonly string[] {
  const defects: string[] = [];
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) defects.push(`duplicate_step:${step.id}`);
    ids.add(step.id);
    for (const locale of ['he', 'en'] as const satisfies readonly ProductHelpLocale[]) {
      const entry = entries.find((candidate) => candidate.locale === locale && candidate.id === step.helpId);
      if (!entry) {
        defects.push(`missing_help:${locale}:${step.id}:${step.helpId}`);
        continue;
      }
      if (!entry.roles.includes('owner')) defects.push(`help_not_for_owner:${locale}:${step.id}`);
      const route = APP_ROUTE_POLICY[entry.route as keyof typeof APP_ROUTE_POLICY];
      if (!route) defects.push(`help_route_missing:${locale}:${step.id}:${entry.route}`);
      else if (route.path !== (step.destination ?? step.route)) {
        defects.push(`route_mismatch:${locale}:${step.id}:${route.path}:${step.destination ?? step.route}`);
      }
      if (!entry.steps[step.helpStep]) defects.push(`help_step_missing:${locale}:${step.id}:${step.helpStep}`);
    }
  }
  return defects;
}

const TOUR_DEFECTS = productTourRegistryDefects(OWNER_FIRST_RUN_TOUR);
if (TOUR_DEFECTS.length > 0) throw new Error(`owner product-tour defects: ${TOUR_DEFECTS.join(', ')}`);
