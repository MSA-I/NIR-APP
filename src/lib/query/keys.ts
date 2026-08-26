/**
 * Query-key convention.
 *
 * **Every key opens with the tenant.** Today `org_id` is never sent on a read — the app relies
 * entirely on RLS (`org_id = auth_org()`), and `src/lib/alerts.ts:17-18` says so outright. A cache
 * keyed without the tenant would therefore be the one place in the system where one organisation's
 * rows can be handed to another: the request was scoped, the cache entry was not. Rooting every key
 * at the org makes a tenant switch a single-subtree invalidation instead of a scavenger hunt.
 *
 * `null` is a real, distinct root. `auth_org()` returns null for a suspended organisation and for a
 * user whose profile has not loaded, and those results must not share a cache entry with a live
 * tenant's.
 */
export type OrgScope = string | null;

/** Root of every key. Invalidate this to drop an entire tenant's cache. */
export const orgRoot = (org: OrgScope) => ['org', org] as const;

/**
 * Build a key inside the tenant subtree.
 *
 * `key(org, 'suppliers')` -> `['org', <id>, 'suppliers']`
 * `key(org, 'invoices', 'detail', id)` -> `['org', <id>, 'invoices', 'detail', <id>]`
 */
export const key = (org: OrgScope, domain: string, ...rest: readonly unknown[]) =>
  [...orgRoot(org), domain, ...rest] as const;

/**
 * The domains migrated first, per ADR-0003. Named rather than stringly-typed at the call site so a
 * typo becomes a compile error instead of a second, silently-never-invalidated cache entry.
 */
export const DOMAIN = {
  suppliers: 'suppliers',
  products: 'products',
  priceLists: 'price-lists',
  documents: 'documents',
  invoices: 'invoices',
  purchaseOrders: 'purchase-orders',
  notifications: 'notifications',
  organization: 'organization',
  // Wave 2: the two server-list screens that are not invoices. Named after their tables,
  // in the same kebab style as `price-lists`.
  payments: 'payments',
  bank: 'bank-transactions',
  // Wave 9: the control-room aggregates. Named after the screen rather than a table on purpose —
  // one dashboard entry is composed of several independent per-metric reads (migrations 0068-0070), so
  // there is no single table whose name would describe it. Sub-key it by role so two active
  // personas asking the same question of different RLS projections never share a cache entry.
  dashboard: 'dashboard',
  // The commercial surface: `my_subscription`, `my_upgrade_options`, `my_plan_grant`,
  // `get_public_plan_quotas` and `organization_usage_snapshot`. One domain rather than five,
  // because they are read together by one screen and invalidated together by one plan change.
  // The usage snapshot lives here and NOT under `organization` on purpose: it is the read that
  // ADR-0003 names as the motivating duplicate, fetched once by the quota note and once by the
  // plans panel on the same screen, and a shared key is the whole fix.
  subscription: 'subscription',
} as const;

export type Domain = (typeof DOMAIN)[keyof typeof DOMAIN];
