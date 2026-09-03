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
 *
 * **The filtered entries are not a convenience.** A source is the place a person goes to check a
 * claim for themselves, so a route that opens a screen holding a DIFFERENT population than the
 * claim is not a weaker source — it is a contradicting one. The measured case: "no supplier
 * raised a price" cited `/prices?increases=1`, a screen headed "7 price rises". Every entry here
 * that carries a query string carries it because some tool's claim is narrower than the screen's
 * default, and the narrowing has to survive the click.
 */
export const ASSISTANT_EXACT_ROUTE_RULES: readonly AssistantExactRouteRule[] = [
  { route: APP_ROUTE_POLICY.dashboard.path, appRoute: 'dashboard', entities: ['organization'] },
  { route: APP_ROUTE_POLICY.invoices.path, appRoute: 'invoices', entities: ['organization'] },
  { route: `${APP_ROUTE_POLICY.invoices.path}?attention=duplicates`, appRoute: 'invoices', entities: ['organization'] },
  { route: `${APP_ROUTE_POLICY.invoices.path}?attention=without-order`, appRoute: 'invoices', entities: ['organization'] },
  { route: `${APP_ROUTE_POLICY.invoices.path}?review=pending_approval`, appRoute: 'invoices', entities: ['organization'] },
  { route: `${APP_ROUTE_POLICY.orders.path}?status=sent`, appRoute: 'orders', entities: ['organization'] },
  { route: APP_ROUTE_POLICY.prices.path, appRoute: 'prices', entities: ['organization'] },
  { route: `${APP_ROUTE_POLICY.prices.path}?increases=1`, appRoute: 'prices', entities: ['organization'] },
  // The trailing window `p2_suppliers_with_price_increase_since` measures on. Without it the
  // screen answers a question with no clock in it.
  { route: `${APP_ROUTE_POLICY.prices.path}?increases=1&days=30`, appRoute: 'prices', entities: ['organization'] },
  { route: APP_ROUTE_POLICY.paymentRequests.path, appRoute: 'paymentRequests', entities: ['payment_request', 'organization'] },
  { route: `${APP_ROUTE_POLICY.paymentRequests.path}?status=active&due=soon`, appRoute: 'paymentRequests', entities: ['organization'] },
  { route: `${APP_ROUTE_POLICY.paymentRequests.path}?due=overdue`, appRoute: 'paymentRequests', entities: ['organization'] },
  { route: `${APP_ROUTE_POLICY.paymentRequests.path}?due=today`, appRoute: 'paymentRequests', entities: ['organization'] },
  // The statuses `p2_active_payment_request_total_by_currency()` sums — narrower than the
  // screen's `active`, which also holds `investigation` and `suspected_duplicate`.
  { route: `${APP_ROUTE_POLICY.paymentRequests.path}?status=draft,pending_approval,approved,sent_for_execution`, appRoute: 'paymentRequests', entities: ['organization'] },
  { route: APP_ROUTE_POLICY.credits.path, appRoute: 'credits', entities: ['credit_note', 'organization'] },
  { route: `${APP_ROUTE_POLICY.credits.path}?status=active`, appRoute: 'credits', entities: ['organization'] },
  { route: APP_ROUTE_POLICY.inventory.path, appRoute: 'inventory', entities: ['product', 'organization'] },
  { route: APP_ROUTE_POLICY.products.path, appRoute: 'products', entities: ['product'] },
  { route: APP_ROUTE_POLICY.suppliers.path, appRoute: 'suppliers', entities: ['organization'] },
  { route: APP_ROUTE_POLICY.bank.path, appRoute: 'bank', entities: ['bank_transaction', 'organization'] },
  // `status=attention` is the screen's own name for `in ('unmatched','suggested')` — exactly the
  // population `get_unmatched_bank_transactions` returns.
  { route: `${APP_ROUTE_POLICY.bank.path}?status=attention`, appRoute: 'bank', entities: ['bank_transaction', 'organization'] },
  { route: APP_ROUTE_POLICY.exceptions.path, appRoute: 'exceptions', entities: ['exception', 'organization'] },
  { route: `${APP_ROUTE_POLICY.exceptions.path}?status=open`, appRoute: 'exceptions', entities: ['organization'] },
  { route: APP_ROUTE_POLICY.expenses.path, appRoute: 'expenses', entities: ['organization'] },
  { route: APP_ROUTE_POLICY.alerts.path, appRoute: 'alerts', entities: ['organization'] },
  { route: APP_ROUTE_POLICY.productReport.path, appRoute: 'productReport', entities: ['product', 'organization'] },
  { route: APP_ROUTE_POLICY.analytics.path, appRoute: 'analytics', entities: ['supplier', 'organization'] },
  { route: APP_ROUTE_POLICY.payments.path, appRoute: 'payments', entities: ['payment', 'organization'] },
];

/**
 * A list screen plus ONE query parameter whose value must be the source's own `entity_id`.
 *
 * This is the row-level counterpart of the dynamic `/invoices/:id` rules below, for the screens
 * that hold a record inside a list rather than on a page of its own. The value is not matched
 * against a pattern — it is compared with `entity_id`, so there is nothing here for a model to
 * compose: it can only point at the row the tool already returned.
 */
export type AssistantEntityParamRouteRule = {
  appRoute: AppRoutePolicyKey;
  param: string;
  entity: EvidenceEntity;
};

export const ASSISTANT_ENTITY_PARAM_ROUTE_RULES: readonly AssistantEntityParamRouteRule[] = [
  { appRoute: 'products', param: 'id', entity: 'product' },
  { appRoute: 'payments', param: 'id', entity: 'payment' },
  { appRoute: 'credits', param: 'id', entity: 'credit_note' },
  { appRoute: 'exceptions', param: 'id', entity: 'exception' },
  // /prices?product=<id> IS the cross-supplier view of one product's offers (18.08.2026), so it
  // isolates a price claim the way an invoice page isolates an invoice one.
  { appRoute: 'prices', param: 'product', entity: 'product' },
];

/**
 * A list screen plus parameters whose values must equal the ones the SOURCE ITSELF declares.
 *
 * One member, and it earns its place: `get_purchase_metrics` measures a trailing window and
 * `/expenses` reads the same window off `?from=`/`?to=` and calls the same RPC, so the tool can
 * hand a reader the range it declared it measured.
 *
 * **The shape is not the check, and an earlier version of this comment said it was.** Validating
 * only that `from`/`to` look like ISO dates admits `?from=0001-01-01&to=9999-12-31` — a window
 * that can be any window isolates nothing, which is the exact failure the header of this file
 * says a filtered entry exists to prevent. So the values are compared against
 * `source.route_params`, the window the tool wrote as a value beside the route rather than
 * inside it; a shaped route whose reference declares no window is refused outright.
 *
 * `params` therefore does two jobs, and neither is redundant with the other. The KEY SET is the
 * exact parameter set the screen may be handed — an unknown parameter is not ignored, it is
 * refused, and a declared parameter the URL omits is refused too. The REGEX bounds what a tool
 * is allowed to declare, so the field cannot become a free-text channel into a query string.
 *
 * What is still outside this rule's reach, stated rather than implied: a tool that widens the
 * link and the declaration together is consistent, and consistency is all a validator can see.
 * Nothing here holds the measurement. Binding a citation to the number it cites is the tool
 * author's obligation; this rule only removes the drift between the two halves.
 */
export type AssistantShapedParamRouteRule = {
  appRoute: AppRoutePolicyKey;
  params: Readonly<Record<string, RegExp>>;
  entities: readonly EvidenceEntity[];
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Both halves are real days on the calendar, and the first is not after the second.
 *
 * `ISO_DATE` above is a shape and nothing more: `2026-02-31` and `2026-13-01` satisfy it. The
 * round-trip through `Date` is what settles it — a rolled-over day reappears as a different
 * string, so comparing the formatted value against the input catches February the thirty-first
 * without a month-length table. Both ends are UTC noon so no zone can move the day.
 *
 * `undefined` is a false, deliberately: this is called only after every declared parameter has
 * been matched, so a missing one is already a refusal and this must not turn it into a pass.
 */
function isRealCalendarRange(from: string | undefined, to: string | undefined): boolean {
  if (from === undefined || to === undefined) return false;
  const real = (value: string): number | null => {
    // Year 0000 ROUND-TRIPS through `Date` and is still not a date this product has: the canonical
    // calendar parser the destination screen uses refuses `year < 1` and throws `Invalid calendar
    // date`, so a citation to `0000-01-01` passed here and broke there. The round trip proves the
    // day exists in the proleptic calendar; this proves it exists in the product's.
    if (value < '0001-01-01' || value > '9999-12-31') return null;
    const at = Date.parse(`${value}T12:00:00Z`);
    if (Number.isNaN(at)) return null;
    return new Date(at).toISOString().slice(0, 10) === value ? at : null;
  };
  const start = real(from);
  const end = real(to);
  return start !== null && end !== null && start <= end;
}

export const ASSISTANT_SHAPED_PARAM_ROUTE_RULES: readonly AssistantShapedParamRouteRule[] = [
  { appRoute: 'expenses', params: { from: ISO_DATE, to: ISO_DATE }, entities: ['organization'] },
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

  if (source.route.includes('?')) {
    const [path, query] = source.route.split('?');
    const parameters = new URLSearchParams(query);
    const names = [...parameters.keys()];

    const entityRule = ASSISTANT_ENTITY_PARAM_ROUTE_RULES.find((rule) =>
      APP_ROUTE_POLICY[rule.appRoute].path === path && rule.entity === source.entity);
    if (entityRule) {
      // Exactly one parameter, and its value IS the id the tool returned. Anything else — a second
      // parameter, a different id — is a route the tool did not issue.
      if (names.length !== 1 || names[0] !== entityRule.param) return 'not_allowlisted';
      if (parameters.get(entityRule.param) !== source.entity_id) return 'not_allowlisted';
      return role && !rolesFor(entityRule.appRoute).includes(role) ? 'not_permitted' : 'allowed';
    }

    const shapedRule = ASSISTANT_SHAPED_PARAM_ROUTE_RULES.find((rule) =>
      APP_ROUTE_POLICY[rule.appRoute].path === path && rule.entities.includes(source.entity));
    if (shapedRule) {
      const expected = Object.keys(shapedRule.params);
      if (names.length !== expected.length || expected.some((name) => !parameters.has(name))) {
        return 'not_allowlisted';
      }
      // Fail closed: no declared window, no shaped route. A reference that has not said which
      // range it stands for cannot be handed a range.
      const declared = source.route_params;
      if (!declared) return 'not_allowlisted';
      if (Object.keys(declared).length !== expected.length) return 'not_allowlisted';
      for (const [name, shape] of Object.entries(shapedRule.params)) {
        const value = declared[name];
        // `undefined` fails the regex too, but test it by name so a declaration that simply
        // omits a parameter is refused for the reason it was refused.
        if (value === undefined || !shape.test(value)) return 'not_allowlisted';
        if (parameters.get(name) !== value) return 'not_allowlisted';
      }
      // A SHAPE IS NOT A DATE, and a pair is not a range. Round 2, finding 6: `2026-02-31` passes
      // `^\d{4}-\d{2}-\d{2}$` and then makes the destination screen throw `Invalid calendar date`,
      // and `from=2026-09-10&to=2026-09-01` passes and lands on an invalid-range screen. Either
      // way the reader follows a citation to an error instead of to the evidence, which is the
      // same broken promise as a window that does not isolate the claim.
      if (!isRealCalendarRange(declared.from, declared.to)) return 'not_allowlisted';
      return role && !rolesFor(shapedRule.appRoute).includes(role) ? 'not_permitted' : 'allowed';
    }

    return 'not_allowlisted';
  }
  const dynamic = ASSISTANT_DYNAMIC_ROUTE_RULES.find((rule) => {
    const prefix = dynamicPrefix(rule);
    return prefix !== '' && source.route!.startsWith(prefix);
  });
  if (!dynamic || dynamic.entity !== source.entity) return 'not_allowlisted';
  const id = source.route.slice(dynamicPrefix(dynamic).length);
  if (!id || id.includes('/') || id !== source.entity_id) return 'not_allowlisted';
  return role && !rolesFor(dynamic.appRoute).includes(role) ? 'not_permitted' : 'allowed';
}
