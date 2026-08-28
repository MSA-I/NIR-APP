/**
 * Which menu destinations a plan withholds — and, more importantly, which it must not.
 *
 * Owner report 28.08.2026: "צריך לסדר את זה שהקטגוריות מתגלות בהדרגה בהתאם למה שכל מנוי מקבל."
 * The direction of failure is the whole design here. A wrong "withheld" deletes destinations from
 * a paying customer's menu because a bootstrap read hiccuped, and they cannot tell that from the
 * product being broken; a wrong "included" shows a link that the screen behind it will explain.
 * So only a MEASURED refusal hides anything, and every other state leaves the menu alone.
 */

import { describe, expect, it } from 'vitest';
import { NAV_ENTITLEMENTS, withheldNavPaths, type EntitlementRow } from './entitlements';

const row = (over: Partial<EntitlementRow> = {}): EntitlementRow => ({
  entitlement_key: 'reports.advanced',
  kind: 'boolean',
  boolean_value: false,
  measured: true,
  ...over,
});

describe('a destination is withheld only on a measured refusal', () => {
  it('hides every menu path a refused entitlement covers', () => {
    // One entitlement, two destinations: "דוח לרו״ח" and ביצועי ספקים are both advanced reporting,
    // and a plan that includes neither must not show one of them.
    expect([...withheldNavPaths([row()])].sort()).toEqual(['/analytics', '/reports']);
    expect([...withheldNavPaths([row({ entitlement_key: 'bank.reconciliation' })])]).toEqual(['/bank']);
  });

  it('withholds nothing when the plan includes it', () => {
    expect(withheldNavPaths([row({ boolean_value: true })]).size).toBe(0);
  });

  it('withholds nothing when the answer is unmeasured — that is our gap, not a refusal of zero', () => {
    expect(withheldNavPaths([row({ measured: false })]).size).toBe(0);
    expect(withheldNavPaths([row({ measured: false, boolean_value: null })]).size).toBe(0);
  });

  it('withholds nothing while the read is missing, empty or still in flight', () => {
    expect(withheldNavPaths(undefined).size).toBe(0);
    expect(withheldNavPaths([]).size).toBe(0);
  });

  it('ignores a numeric entitlement, which says nothing about whether a screen exists', () => {
    // `users.max` is a count, not a door. Reading a numeric row as a boolean refusal is how a
    // limit of zero would silently delete a menu row.
    expect(withheldNavPaths([row({ entitlement_key: 'users.max', kind: 'numeric', boolean_value: null })]).size).toBe(0);
  });

  it('ignores an entitlement no menu path is mapped to', () => {
    expect(withheldNavPaths([row({ entitlement_key: 'support.premium' })]).size).toBe(0);
  });
});

describe('the map itself', () => {
  it('names only boolean entitlements the catalogue defines', () => {
    // A key with a typo would silently never match, so the menu would never gate and nobody would
    // see a failure. These four are the boolean keys seeded by 0154.
    const DEFINED = ['reports.advanced', 'bank.reconciliation', 'documents.automation',
      'exports.custom', 'org.multi_unit', 'support.premium'];
    for (const entitlement of Object.values(NAV_ENTITLEMENTS)) {
      expect(DEFINED).toContain(entitlement);
    }
  });

  it('carries no plan name at all', () => {
    // Which rung includes what is a row in `plan_entitlements`, changed by an UPDATE. A plan key
    // in this file would be the second source of truth that `PlanBadge` exists to prevent.
    const serialised = JSON.stringify(NAV_ENTITLEMENTS);
    for (const plan of ['free', 'basic', 'pro', 'premium', 'business', 'legacy']) {
      expect(serialised).not.toContain(plan);
    }
  });
});
