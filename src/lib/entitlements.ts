/**
 * Which menu destinations a plan actually includes.
 *
 * Owner report 28.08.2026: "צריך לסדר את זה שהקטגוריות מתגלות בהדרגה בהתאם למה שכל מנוי מקבל,
 * למשל מנוי חינמי לא יכול לראות קטגוריות שקשורות להוספת משתמשים או שליחה לרואה חשבון וכדומה."
 * The rung he named, the same day: everything on that list opens at `pro`.
 *
 * ── Where the answer comes from, and where it does NOT ──────────────────────────────────────
 *
 * `my_entitlements()` (0154), which resolves a live per-organization override over the plan
 * catalogue over nothing. That is the single resolution the whole product already uses, so the
 * menu cannot develop a second opinion about what a customer bought. In particular this file
 * holds NO plan names: which rung includes `reports.advanced` is a row in `plan_entitlements`,
 * changed by an UPDATE, and a hardcoded `plan_key === 'free'` here would be exactly the second
 * source of truth `PlanBadge` was written to avoid.
 *
 * ── The one rule, and why it is the safe direction ──────────────────────────────────────────
 *
 * A destination is withheld ONLY when the server says, measurably, that the plan does not include
 * it. `measured: false` means "we cannot state what this customer is entitled to" — a
 * configuration gap on our side, never a claim of zero — and an unmeasured answer, a failed read
 * or a read still in flight all leave the menu as it was.
 *
 * That is deliberately the opposite of `assistant/contracts.ts`, which fails CLOSED, and the
 * difference is what each surface does with the answer. The assistant is a permission gate: a
 * wrong "yes" there runs something a customer did not buy. This is a DISCLOSURE surface: a wrong
 * "no" deletes destinations from a paying customer's menu because a bootstrap read hiccuped, and
 * they have no way to tell that from the product being broken.
 *
 * ── Which is also the honest limit of this file ──────────────────────────────────────────────
 *
 * Hiding a link is not enforcement. The routes remain reachable by typing the address, and the
 * data behind them is protected by RLS and by role, not by plan. This closes the owner's
 * complaint — the menu now shows what the plan includes — and `DEBT §68` carries the rest.
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from './supabase';
import { DOMAIN, key } from './query/keys';
import { useOrgScope } from './query/orgScope';

/**
 * Menu destination → the entitlement that decides whether it is included.
 *
 * Only what the owner named, and only where the destination IS a menu category. "הוספת משתמשים"
 * (`users.max`) and the export templates (`exports.custom`) are controls inside /settings rather
 * than rows in the menu, so they are not gated here — gating a row that does not exist would be
 * a rule with nothing to apply it to.
 */
export const NAV_ENTITLEMENTS: Readonly<Record<string, string>> = {
  // "שליחה לרואה חשבון" is `/reports` — the catalogue's own name for it is "דוח לרו״ח".
  '/reports': 'reports.advanced',
  '/analytics': 'reports.advanced',
  '/bank': 'bank.reconciliation',
};

/** One row of `my_entitlements()`. Only the fields this decision needs are named. */
export interface EntitlementRow {
  entitlement_key: string;
  kind: string;
  boolean_value: boolean | null;
  measured: boolean;
}

export const entitlementsKey = (org: string | null) => key(org, DOMAIN.subscription, 'entitlements');

const fetchEntitlements = async (): Promise<EntitlementRow[]> => {
  const { data, error } = await supabase.rpc('my_entitlements');
  if (error) throw new Error(error.message);
  return (data ?? []) as EntitlementRow[];
};

export const entitlementsQuery = (org: string | null) => ({
  queryKey: entitlementsKey(org),
  queryFn: fetchEntitlements,
});

/**
 * The menu paths this plan does not include — measured refusals only.
 *
 * Returns paths rather than entitlement keys because the caller filters a menu, and mapping twice
 * is how the two lists drift.
 */
export function withheldNavPaths(rows: readonly EntitlementRow[] | undefined): ReadonlySet<string> {
  if (!rows?.length) return EMPTY;
  const refused = new Set(rows
    .filter((row) => row.kind === 'boolean' && row.measured && row.boolean_value === false)
    .map((row) => row.entitlement_key));
  if (refused.size === 0) return EMPTY;
  return new Set(Object.entries(NAV_ENTITLEMENTS)
    .filter(([, entitlement]) => refused.has(entitlement))
    .map(([path]) => path));
}

const EMPTY: ReadonlySet<string> = new Set();

/**
 * Waits for the tenant scope, not for a role.
 *
 * `my_entitlements()` is a tenant resolver that `anon` holds no EXECUTE on, so calling it before
 * AuthProvider has an organisation leaves an ANONYMOUS request that can only come back 502. That
 * lesson is already written down twice in this codebase — `useFeatureFlags` and `PlanBadge`, the
 * latter after it cost a browser-gate run — and `useOrgScope()` is the same gate from the same
 * place.
 */
export function useWithheldNavPaths(): ReadonlySet<string> {
  const org = useOrgScope();
  const { data } = useQuery({ ...entitlementsQuery(org), enabled: org !== null });
  return withheldNavPaths(data);
}
