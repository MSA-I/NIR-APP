import type { AssistantRole, EvidenceEntity, SourceReference } from './contracts.ts';

type RouteRule = {
  route: string;
  roles: readonly AssistantRole[];
  entities: readonly EvidenceEntity[];
};

const ALL_ASSISTANT_ROLES: readonly AssistantRole[] = ['owner', 'office', 'accountant'];
const STAFF_ROLES: readonly AssistantRole[] = ['owner', 'office'];
const MONEY_ROLES: readonly AssistantRole[] = ['owner', 'accountant'];

/**
 * Exact list routes the current assistant tools may issue. Query strings are part of the
 * allowlist: `/invoices?attention=duplicates` is a product route; `/invoices?next=https://...`
 * is not. This module is shared by Edge validation and the browser renderer.
 */
const EXACT_ROUTE_RULES: readonly RouteRule[] = [
  { route: '/dashboard', roles: ALL_ASSISTANT_ROLES, entities: ['organization'] },
  { route: '/invoices', roles: ALL_ASSISTANT_ROLES, entities: ['organization'] },
  { route: '/invoices?attention=duplicates', roles: ALL_ASSISTANT_ROLES, entities: ['organization'] },
  { route: '/invoices?attention=without-order', roles: STAFF_ROLES, entities: ['organization'] },
  { route: '/orders?status=sent', roles: STAFF_ROLES, entities: ['organization'] },
  { route: '/prices', roles: STAFF_ROLES, entities: ['organization'] },
  { route: '/prices?increases=1', roles: STAFF_ROLES, entities: ['organization'] },
  { route: '/payment-requests', roles: STAFF_ROLES, entities: ['payment_request', 'organization'] },
  { route: '/payment-requests?status=active&due=soon', roles: STAFF_ROLES, entities: ['organization'] },
  { route: '/credits', roles: ALL_ASSISTANT_ROLES, entities: ['credit_note', 'organization'] },
  { route: '/inventory', roles: STAFF_ROLES, entities: ['product', 'organization'] },
  { route: '/products', roles: STAFF_ROLES, entities: ['product'] },
  { route: '/bank', roles: MONEY_ROLES, entities: ['bank_transaction', 'organization'] },
  { route: '/exceptions', roles: ALL_ASSISTANT_ROLES, entities: ['exception', 'organization'] },
  { route: '/expenses', roles: MONEY_ROLES, entities: ['organization'] },
  { route: '/alerts', roles: STAFF_ROLES, entities: ['organization'] },
  { route: '/reports/products', roles: ALL_ASSISTANT_ROLES, entities: ['product', 'organization'] },
  { route: '/analytics', roles: STAFF_ROLES, entities: ['supplier', 'organization'] },
  { route: '/payments', roles: MONEY_ROLES, entities: ['payment', 'organization'] },
];

type DynamicRule = {
  prefix: string;
  roles: readonly AssistantRole[];
  entity: EvidenceEntity;
};

const DYNAMIC_ROUTE_RULES: readonly DynamicRule[] = [
  { prefix: '/suppliers/', roles: STAFF_ROLES, entity: 'supplier' },
  { prefix: '/finance/suppliers/', roles: MONEY_ROLES, entity: 'supplier' },
  { prefix: '/orders/', roles: STAFF_ROLES, entity: 'purchase_order' },
  { prefix: '/invoices/', roles: ALL_ASSISTANT_ROLES, entity: 'invoice' },
];

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

  const exact = EXACT_ROUTE_RULES.find((rule) => rule.route === source.route);
  if (exact) {
    if (!exact.entities.includes(source.entity)) return 'not_allowlisted';
    return role && !exact.roles.includes(role) ? 'not_permitted' : 'allowed';
  }

  if (source.route.includes('?')) return 'not_allowlisted';
  const dynamic = DYNAMIC_ROUTE_RULES.find((rule) => source.route!.startsWith(rule.prefix));
  if (!dynamic || dynamic.entity !== source.entity) return 'not_allowlisted';
  const id = source.route.slice(dynamic.prefix.length);
  if (!id || id.includes('/') || id !== source.entity_id) return 'not_allowlisted';
  return role && !dynamic.roles.includes(role) ? 'not_permitted' : 'allowed';
}
