/**
 * The structural guard OPEN-DECISIONS #192 asks for.
 *
 * #192 makes the repository registry the SINGLE authoritative source for "how do I do X in this
 * product", and requires an automatic guard that compares it against `routePolicy.ts` and
 * `routePresentation.ts` and FAILS on a removed route, a drifted role or a missing locale. This
 * file is that guard.
 *
 * It checks the shipped registry, and — because a guard that has only ever seen valid input has
 * proven nothing — it also feeds `productHelpRegistryDefects` deliberately broken synthetic
 * snapshots and asserts each one is rejected by name.
 */
import { describe, expect, it } from 'vitest';
import { ACTIVE_ROLES } from '../types';
import { APP_ROUTE_POLICY, type AppRoutePolicyKey } from '../routePolicy';
import { routePresentationTitle } from '../routePresentation';
import { ASSISTANT_ROLES, PRODUCT_HELP_LOCALES, ProductHelpEntrySchema } from './contracts';
import {
  findProductHelp,
  PRODUCT_HELP_BASE_LOCALE,
  PRODUCT_HELP_ENTRIES,
  PRODUCT_HELP_KEYWORDS,
  PRODUCT_HELP_MATCH_LIMIT,
  productHelpForRole,
  productHelpPath,
  productHelpRegistryDefects,
} from './productHelpRegistry';

/** A known-good entry the falsification cases below mutate one field at a time. */
const HEALTHY = {
  id: 'compare_supplier_prices',
  version: 1,
  owner: 'product',
  locale: 'he' as const,
  roles: ['owner', 'office'] as const,
  route: 'prices',
  label: 'השוואת מחירי ספקים',
  steps: ['נכנסים למסך המחירונים', 'מסננים לפי ספק או מסמנים "רק התייקרויות"'],
  source: 'src/pages/PriceLists.tsx',
  updated_at: '2026-08-24',
};

function snapshot(entries: readonly unknown[], keywords?: Record<string, readonly string[]>) {
  return {
    entries,
    keywords: keywords ?? { [HEALTHY.id]: ['השוואת מחירים'] },
  };
}

describe('the shipped product-help registry', () => {
  it('has no defect at all — this is #192\'s guard, run against the real registry', () => {
    expect(productHelpRegistryDefects({
      entries: PRODUCT_HELP_ENTRIES,
      keywords: PRODUCT_HELP_KEYWORDS,
    })).toEqual([]);
  });

  it('carries entries, and every one of them parses against the canonical entry schema', () => {
    expect(PRODUCT_HELP_ENTRIES.length).toBeGreaterThan(0);
    for (const entry of PRODUCT_HELP_ENTRIES) {
      expect(ProductHelpEntrySchema.safeParse(entry).success).toBe(true);
    }
  });

  it('resolves every entry to a live route that still has a canonical screen name', () => {
    for (const entry of PRODUCT_HELP_ENTRIES) {
      expect(Object.keys(APP_ROUTE_POLICY)).toContain(entry.route);
      const path = productHelpPath(entry);
      expect(path).toBe(APP_ROUTE_POLICY[entry.route as AppRoutePolicyKey].path);
      // routePresentation.ts is the second half of #192's comparison: a route that lost its
      // screen name is a removed screen, and an instruction pointing at it is a dead instruction.
      expect(routePresentationTitle(path)).not.toBeNull();
    }
  });

  it('never widens a route audience — an entry may only narrow the Guard it points at', () => {
    for (const entry of PRODUCT_HELP_ENTRIES) {
      const routeRoles = APP_ROUTE_POLICY[entry.route as AppRoutePolicyKey].roles as readonly string[];
      for (const role of entry.roles) {
        expect(routeRoles, entry.id).toContain(role);
      }
    }
  });

  it('gives every topic a Hebrew original, and keeps a translation on the same route and roles', () => {
    const byId = new Map<string, (typeof PRODUCT_HELP_ENTRIES)[number][]>();
    for (const entry of PRODUCT_HELP_ENTRIES) {
      byId.set(entry.id, [...(byId.get(entry.id) ?? []), entry]);
    }
    for (const [id, entries] of byId) {
      expect(entries.some((entry) => entry.locale === PRODUCT_HELP_BASE_LOCALE), id).toBe(true);
      const locales = entries.map((entry) => entry.locale);
      expect(new Set(locales).size, id).toBe(locales.length);
      for (const entry of entries) {
        expect(PRODUCT_HELP_LOCALES).toContain(entry.locale);
        expect(entry.route, id).toBe(entries[0].route);
        expect([...entry.roles].sort(), id).toEqual([...entries[0].roles].sort());
      }
    }
  });

  it('keeps every topic reachable — an entry no question can reach answers nothing', () => {
    for (const entry of PRODUCT_HELP_ENTRIES) {
      expect(PRODUCT_HELP_KEYWORDS[entry.id]?.length ?? 0, entry.id).toBeGreaterThan(0);
    }
    const ids = new Set(PRODUCT_HELP_ENTRIES.map((entry) => entry.id));
    for (const id of Object.keys(PRODUCT_HELP_KEYWORDS)) {
      expect([...ids], id).toContain(id);
    }
  });
});

describe('the guard fires — deliberately broken snapshots are rejected by name', () => {
  it('accepts the healthy synthetic snapshot, so every case below fails for its own reason', () => {
    expect(productHelpRegistryDefects(snapshot([HEALTHY]))).toEqual([]);
  });

  it('rejects a route that is not a key of APP_ROUTE_POLICY (a removed screen)', () => {
    expect(productHelpRegistryDefects(snapshot([{ ...HEALTHY, route: 'removedScreen' }])))
      .toContain('entry[0]:route_not_in_policy:removedScreen');
  });

  it('rejects roles that exceed the route Guard (a drifted role)', () => {
    // `prices` is staff-only. An entry that hands it to `accountant` widens a Guard from a help file.
    expect(productHelpRegistryDefects(
      snapshot([{ ...HEALTHY, roles: ['owner', 'office', 'accountant'] }]),
    )).toContain('entry[0]:roles_exceed_route:accountant');
  });

  it('rejects a route whose path no longer has a canonical screen name', () => {
    // Every live policy key still HAS a title — which is the point — so falsifying this check
    // needs a synthetic policy table with a screen the presentation catalogue never named.
    expect(productHelpRegistryDefects({
      ...snapshot([{ ...HEALTHY, route: 'ghost' }]),
      routes: { ...APP_ROUTE_POLICY, ghost: { path: '/no-such-screen', roles: ACTIVE_ROLES } },
    })).toContain('entry[0]:route_has_no_screen_name:/no-such-screen');
  });

  it('rejects a duplicate id within one locale', () => {
    expect(productHelpRegistryDefects(snapshot([HEALTHY, { ...HEALTHY }])))
      .toContain('entry[1]:duplicate_locale_id:he:compare_supplier_prices');
  });

  it('rejects a topic that exists only in translation — Hebrew is the base locale', () => {
    expect(productHelpRegistryDefects(snapshot([{ ...HEALTHY, locale: 'en' }])))
      .toContain('id:compare_supplier_prices:missing_base_locale');
  });

  it('rejects a translation that drifted from its original on route or roles', () => {
    const drifted = { ...HEALTHY, locale: 'en' as const, route: 'inventory', roles: ['owner'] as const };
    const defects = productHelpRegistryDefects(snapshot([HEALTHY, drifted]));
    expect(defects).toContain('id:compare_supplier_prices:locale_disagrees_on_route');
    expect(defects).toContain('id:compare_supplier_prices:locale_disagrees_on_roles');
  });

  it('rejects an entry that does not parse against the canonical schema', () => {
    const defects = productHelpRegistryDefects(snapshot([{ ...HEALTHY, steps: [] }]));
    expect(defects.some((defect) => defect.startsWith('entry[0]:schema:'))).toBe(true);
  });

  it('rejects a keyword table that drifted away from the entries', () => {
    expect(productHelpRegistryDefects(snapshot([HEALTHY], {})))
      .toContain('id:compare_supplier_prices:no_keywords');
    expect(productHelpRegistryDefects(snapshot([HEALTHY], {
      [HEALTHY.id]: ['השוואת מחירים'],
      ghost_topic: ['רוח רפאים'],
    }))).toContain('keywords:ghost_topic:unknown_entry');
  });
});

describe('what a role may be shown', () => {
  it('covers exactly the three live roles and nothing retired', () => {
    expect([...ASSISTANT_ROLES]).toEqual([...ACTIVE_ROLES]);
  });

  it('returns only entries the role is authorized for, in the base locale by default', () => {
    for (const role of ASSISTANT_ROLES) {
      const entries = productHelpForRole(role);
      expect(entries.length, role).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.roles, entry.id).toContain(role);
        expect(entry.locale, entry.id).toBe(PRODUCT_HELP_BASE_LOCALE);
      }
    }
  });

  it('never hands accountant an entry for a staff-only screen', () => {
    const staffOnly = (Object.keys(APP_ROUTE_POLICY) as AppRoutePolicyKey[])
      .filter((key) => !(APP_ROUTE_POLICY[key].roles as readonly string[]).includes('accountant'));
    for (const entry of productHelpForRole('accountant')) {
      expect(staffOnly as string[], entry.id).not.toContain(entry.route);
    }
    // And something IS actually withheld, so the assertion above is not vacuously true.
    const withheld = PRODUCT_HELP_ENTRIES.filter((entry) => staffOnly.includes(entry.route as AppRoutePolicyKey));
    expect(withheld.length).toBeGreaterThan(0);
    const visible = new Set(productHelpForRole('accountant').map((entry) => entry.id));
    for (const entry of withheld) expect([...visible], entry.id).not.toContain(entry.id);
  });
});

describe('lookup is deterministic and has no fallback', () => {
  it('matches a question by a registered keyword', () => {
    const [entry] = findProductHelp('איך משווים מחירי ספקים בין הספקים?', 'owner');
    expect(entry?.id).toBe('compare_supplier_prices');
  });

  it('matches by the entry label itself', () => {
    expect(findProductHelp('איפה עושים התאמת תדפיס בנק', 'accountant').map((entry) => entry.id))
      .toContain('reconcile_bank_statement');
  });

  it('resolves an explicit entry id without consulting the query at all', () => {
    expect(findProductHelp('', 'owner', { id: 'compare_supplier_prices' }).map((entry) => entry.id))
      .toEqual(['compare_supplier_prices']);
  });

  it('returns nothing for a question the registry does not answer — no guess, no nearest entry', () => {
    expect(findProductHelp('מה מזג האוויר מחר בתל אביב', 'owner')).toEqual([]);
    expect(findProductHelp('', 'owner')).toEqual([]);
    expect(findProductHelp('איך משווים מחירי ספקים', 'owner', { id: 'no_such_entry' })).toEqual([]);
  });

  it('withholds a match the asking role may not see, rather than showing it', () => {
    // `prices` is staff-only, so the question that answers for an owner answers nothing here.
    expect(findProductHelp('איך משווים מחירי ספקים', 'accountant')).toEqual([]);
  });

  it('is stable and bounded: the same query returns the same bounded list every time', () => {
    const query = 'איך רואים מה דורש טיפול היום ואיפה מצב העסק';
    const first = findProductHelp(query, 'owner').map((entry) => entry.id);
    expect(findProductHelp(query, 'owner').map((entry) => entry.id)).toEqual(first);
    expect(first.length).toBeLessThanOrEqual(PRODUCT_HELP_MATCH_LIMIT);
  });
});
