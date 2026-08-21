import type { AssistantRole, EvidenceEntity, SourceReference } from './contracts.ts';
import {
  APP_ROUTE_POLICY,
  type AppRoutePolicyKey,
} from '../routePolicy.ts';

export type AssistantExactRouteRule = {
  route: string;
  appRoute: AppRoutePolicyKey;
  entities: readonly EvidenceEntity[];
};

/**
 * Exact list routes the current assistant tools may issue. Query strings are part of the
 * allowlist: `/invoices?attention=duplicates` is a product route; `/invoices?next=https://...`
 * is not. This module is shared by Edge validation and the browser renderer.
 */
export const ASSISTANT_EXACT_ROUTE_RULES: readonly AssistantExactRouteRule[] = [
  { route: APP_ROUTE_POLICY.dashboard.path, appRoute: 'dashboard', entities: ['organization'] },
  { route: APP_ROUTE_POLICY.invoices.path, appRoute: 'invoices', entities: ['organization'] },
  { route: `${APP_ROUTE_POLICY.invoices.path}?attention=duplicates`, appRoute: 'invoices', entities: ['organization'] },
  { route: `${APP_ROUTE_POLICY.invoices.path}?attention=without-order`, appRoute: 'invoices', entities: ['organization'] },
  { route: `${APP_ROUTE_POLICY.orders.path}?status=sent`, appRoute: 'orders', entities: ['organization'] },
  { route: APP_ROUTE_POLICY.prices.path, appRoute: 'prices', entities: ['organization'] },
  { route: `${APP_ROUTE_POLICY.prices.path}?increases=1`, appRoute: 'prices', entities: ['organization'] },
  { route: APP_ROUTE_POLICY.paymentRequests.path, appRoute: 'paymentRequests', entities: ['payment_request', 'organization'] },
  { route: `${APP_ROUTE_POLICY.paymentRequests.path}?status=active&due=soon`, appRoute: 'paymentRequests', entities: ['organization'] },
  { route: APP_ROUTE_POLICY.credits.path, appRoute: 'credits', entities: ['credit_note', 'organization'] },
  { route: APP_ROUTE_POLICY.inventory.path, appRoute: 'inventory', entities: ['product', 'organization'] },
  { route: APP_ROUTE_POLICY.products.path, appRoute: 'products', entities: ['product'] },
  { route: APP_ROUTE_POLICY.bank.path, appRoute: 'bank', entities: ['bank_transaction', 'organization'] },
  { route: APP_ROUTE_POLICY.exceptions.path, appRoute: 'exceptions', entities: ['exception', 'organization'] },
  { route: APP_ROUTE_POLICY.expenses.path, appRoute: 'expenses', entities: ['organization'] },
  { route: APP_ROUTE_POLICY.alerts.path, appRoute: 'alerts', entities: ['organization'] },
  { route: APP_ROUTE_POLICY.productReport.path, appRoute: 'productReport', entities: ['product', 'organization'] },
  { route: APP_ROUTE_POLICY.analytics.path, appRoute: 'analytics', entities: ['supplier', 'organization'] },
  { route: APP_ROUTE_POLICY.payments.path, appRoute: 'payments', entities: ['payment', 'organization'] },
];

export type AssistantDynamicRouteRule = {
  appRoute: AppRoutePolicyKey;
  entity: EvidenceEntity;
};

export const ASSISTANT_DYNAMIC_ROUTE_RULES: readonly AssistantDynamicRouteRule[] = [
  { appRoute: 'supplierDetail', entity: 'supplier' },
  { appRoute: 'financialSupplierDetail', entity: 'supplier' },
  { appRoute: 'orderDetail', entity: 'purchase_order' },
  { appRoute: 'invoiceDetail', entity: 'invoice' },
];

function dynamicPrefix(rule: AssistantDynamicRouteRule): string {
  const path = APP_ROUTE_POLICY[rule.appRoute].path;
  const parameter = path.indexOf(':');
  return parameter === -1 ? '' : path.slice(0, parameter);
}

function rolesFor(appRoute: AppRoutePolicyKey): readonly AssistantRole[] {
  return APP_ROUTE_POLICY[appRoute].roles;
}

export type AssistantRouteDecision = 'allowed' | 'not_allowlisted' | 'not_permitted';

function isPlainInAppRoute(route: string): boolean {
  if (!route.startsWith('/') || route.startsWith('//') || route.includes('#')) return false;
  try {
    const parsed = new URL(route, 'https://inplace.invalid');
    return parsed.origin === 'https://inplace.invalid' && `${parsed.pathname}${parsed.search}` === route;
  } catch {
    return false;
  }
}

/** A route is presentation only after both its shape and current role pass this decision. */
export function assistantSourceRouteDecision(
  source: SourceReference,
  role?: AssistantRole,
): AssistantRouteDecision {
  if (source.route === null) return 'allowed';
  if (!isPlainInAppRoute(source.route)) return 'not_allowlisted';

  const exact = ASSISTANT_EXACT_ROUTE_RULES.find((rule) => rule.route === source.route);
  if (exact) {
    if (!exact.entities.includes(source.entity)) return 'not_allowlisted';
    return role && !rolesFor(exact.appRoute).includes(role) ? 'not_permitted' : 'allowed';
  }

  if (source.route.includes('?')) return 'not_allowlisted';
  const dynamic = ASSISTANT_DYNAMIC_ROUTE_RULES.find((rule) => {
    const prefix = dynamicPrefix(rule);
    return prefix !== '' && source.route!.startsWith(prefix);
  });
  if (!dynamic || dynamic.entity !== source.entity) return 'not_allowlisted';
  const id = source.route.slice(dynamicPrefix(dynamic).length);
  if (!id || id.includes('/') || id !== source.entity_id) return 'not_allowlisted';
  return role && !rolesFor(dynamic.appRoute).includes(role) ? 'not_permitted' : 'allowed';
}
