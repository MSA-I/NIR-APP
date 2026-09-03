import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACTIVE_ROLES, type ActiveRole } from '../types';
import {
  APP_ROUTE_POLICY,
  type AppRoutePolicyKey,
} from '../routePolicy';
import type { SourceReference } from './contracts';
import {
  ASSISTANT_DYNAMIC_ROUTE_RULES,
  ASSISTANT_ENTITY_PARAM_ROUTE_RULES,
  ASSISTANT_EXACT_ROUTE_RULES,
  ASSISTANT_SHAPED_PARAM_ROUTE_RULES,
  assistantSourceRouteDecision,
} from './routeAccess';

const appSource = readFileSync('src/App.tsx', 'utf8');

function source(route: string, entity: SourceReference['entity'], entityId = 'entity-1'): SourceReference {
  return {
    id: 's1',
    entity,
    entity_id: entityId,
    label: 'מקור',
    route,
    classification: 'tenant_standard',
  };
}

/** A source that also declares the shaped window it stands for, the way a tool issues one. */
function shaped(
  route: string,
  entity: SourceReference['entity'],
  routeParams: Record<string, string>,
): SourceReference {
  return { ...source(route, entity), route_params: routeParams };
}

function expectedDecision(appRoute: AppRoutePolicyKey, role: ActiveRole) {
  const roles = APP_ROUTE_POLICY[appRoute].roles as readonly ActiveRole[];
  return roles.includes(role) ? 'allowed' : 'not_permitted';
}

describe('assistant route policy parity', () => {
  it('App.tsx צורך את ה-path ואת ה-roles של כל route שהעוזר רשאי להנפיק מאותו מקור אמת', () => {
    for (const key of Object.keys(APP_ROUTE_POLICY) as AppRoutePolicyKey[]) {
      expect(appSource).toContain(`path={APP_ROUTE_POLICY.${key}.path}`);
      expect(appSource).toContain(`roles={APP_ROUTE_POLICY.${key}.roles}`);
    }
  });

  it('כל exact source route נשען על path קנוני ומקבל בדיוק את תפקידי ה-Guard שלו', () => {
    expect(new Set(ASSISTANT_EXACT_ROUTE_RULES.map((rule) => rule.route)).size)
      .toBe(ASSISTANT_EXACT_ROUTE_RULES.length);

    for (const rule of ASSISTANT_EXACT_ROUTE_RULES) {
      expect(rule.route.split('?')[0]).toBe(APP_ROUTE_POLICY[rule.appRoute].path);
      const issued = source(rule.route, rule.entities[0]);
      for (const role of ACTIVE_ROLES) {
        expect(assistantSourceRouteDecision(issued, role))
          .toBe(expectedDecision(rule.appRoute, role));
      }
    }
  });

  it('כל dynamic source route נגזר מ-pattern קנוני ומקבל בדיוק את תפקידי ה-Guard שלו', () => {
    for (const rule of ASSISTANT_DYNAMIC_ROUTE_RULES) {
      const pattern = APP_ROUTE_POLICY[rule.appRoute].path;
      expect(pattern).toMatch(/:[^/]+$/);
      const issued = source(pattern.replace(/:[^/]+$/, 'entity-1'), rule.entity);
      for (const role of ACTIVE_ROLES) {
        expect(assistantSourceRouteDecision(issued, role))
          .toBe(expectedDecision(rule.appRoute, role));
      }
    }
  });

  it('route עם פרמטר-ישות מתקבל רק כשהערך הוא ה-entity_id עצמו', () => {
    for (const rule of ASSISTANT_ENTITY_PARAM_ROUTE_RULES) {
      const path = APP_ROUTE_POLICY[rule.appRoute].path;
      expect(path).not.toContain(':');
      const good = source(`${path}?${rule.param}=entity-1`, rule.entity, 'entity-1');
      for (const role of ACTIVE_ROLES) {
        expect(assistantSourceRouteDecision(good, role))
          .toBe(expectedDecision(rule.appRoute, role));
      }
      // The value is compared with the id the tool returned, so a route pointing at a DIFFERENT
      // row is refused — the model cannot compose a reference of its own out of this rule.
      expect(assistantSourceRouteDecision(source(`${path}?${rule.param}=entity-2`, rule.entity, 'entity-1')))
        .toBe('not_allowlisted');
      // One parameter, and only the named one.
      expect(assistantSourceRouteDecision(source(`${path}?${rule.param}=entity-1&next=x`, rule.entity, 'entity-1')))
        .toBe('not_allowlisted');
      expect(assistantSourceRouteDecision(source(`${path}?other=entity-1`, rule.entity, 'entity-1')))
        .toBe('not_allowlisted');
      // The entity has to match too: /payments?id=<x> is not a reference to a product.
      const wrongEntity = rule.entity === 'product' ? 'invoice' : 'product';
      expect(assistantSourceRouteDecision(source(`${path}?${rule.param}=entity-1`, wrongEntity, 'entity-1')))
        .toBe('not_allowlisted');
    }
  });

  it('לא כל צורה היא תאריך, ולא כל צמד הוא טווח', () => {
    /* Round 2, finding 6. `2026-02-31` satisfies the ISO shape and then makes the destination
       screen throw `Invalid calendar date`; a reversed pair lands on an invalid-range screen.
       Either way the reader follows a citation to an error instead of to the evidence. */
    const path = APP_ROUTE_POLICY.expenses.path;
    const refused: readonly [string, string][] = [
      ['2026-02-31', '2026-02-31'],   // February has no thirty-first
      ['2026-13-01', '2026-13-05'],   // no thirteenth month
      ['2026-09-10', '2026-09-01'],   // the range runs backwards
      ['2026-00-10', '2026-00-11'],   // no zeroth month
      // Year 0000 round-trips through Date and is still refused by the calendar parser the
      // destination screen uses, so a citation to it passed here and threw there.
      ['0000-01-01', '0000-01-01'],
      // And every year below 0100: Date.UTC maps a one- or two-digit year onto 19xx, so the
      // canonical parser sees 1901 and throws on what round-tripped fine here.
      ['0001-01-01', '0001-01-01'],
      ['0099-12-31', '0099-12-31'],
    ];
    for (const [from, to] of refused) {
      const declared = { from, to };
      expect(
        assistantSourceRouteDecision(shaped(`${path}?from=${from}&to=${to}`, 'organization', declared)),
        `${from}..${to}`,
      ).toBe('not_allowlisted');
    }
    // A real single-day range is still a range, and a leap day in a leap year is still a day.
    for (const [from, to] of [['2026-09-03', '2026-09-03'], ['2024-02-29', '2024-03-01']] as const) {
      expect(
        assistantSourceRouteDecision(shaped(`${path}?from=${from}&to=${to}`, 'organization', { from, to })),
        `${from}..${to}`,
      ).not.toBe('not_allowlisted');
    }
    // ...and a leap day in a NON-leap year is not.
    expect(assistantSourceRouteDecision(
      shaped(`${path}?from=2026-02-29&to=2026-03-01`, 'organization', { from: '2026-02-29', to: '2026-03-01' }),
    )).toBe('not_allowlisted');
  });
  it('route עם פרמטרים מעוצבים מתקבל רק בצורה המדויקת שהוגדרה לו', () => {
    for (const rule of ASSISTANT_SHAPED_PARAM_ROUTE_RULES) {
      const path = APP_ROUTE_POLICY[rule.appRoute].path;
      const names = Object.keys(rule.params);
      const declared = Object.fromEntries(names.map((name) => [name, '2026-09-03']));
      const query = names.map((name) => `${name}=2026-09-03`).join('&');
      const good = shaped(`${path}?${query}`, rule.entities[0], declared);
      for (const role of ACTIVE_ROLES) {
        expect(assistantSourceRouteDecision(good, role))
          .toBe(expectedDecision(rule.appRoute, role));
      }
      // A value that is not the declared shape is refused rather than passed through — on BOTH
      // sides, because either side alone would be a hole.
      const badValues = Object.fromEntries(names.map((name, index) => [name, index === 0 ? 'yesterday' : '2026-09-03']));
      const bad = names.map((name) => `${name}=${badValues[name]}`).join('&');
      expect(assistantSourceRouteDecision(shaped(`${path}?${bad}`, rule.entities[0], badValues)))
        .toBe('not_allowlisted');
      // Every declared parameter is required, and nothing else is accepted alongside them.
      expect(assistantSourceRouteDecision(shaped(`${path}?${names[0]}=2026-09-03`, rule.entities[0], declared)))
        .toBe(names.length === 1 ? 'allowed' : 'not_allowlisted');
      expect(assistantSourceRouteDecision(shaped(`${path}?${query}&extra=1`, rule.entities[0], declared)))
        .toBe('not_allowlisted');
    }
  });

  /**
   * Finding 9 of the adversarial review, and the reason the rule stopped being a shape check.
   *
   * Validating only that `from`/`to` parse as ISO dates admitted `0001-01-01`..`9999-12-31`: a
   * window that can be any window, cited under a figure measured over seven days. These four
   * cases are the boundary, and they fail on the version of this rule that checked shape alone.
   */
  describe('a shaped route may only carry the window its own reference declares', () => {
    const WINDOW = { from: '2026-08-28', to: '2026-09-03' } as const;
    const cited = '/expenses?from=2026-08-28&to=2026-09-03';

    it('הטווח שהעובדה מדדה עובר', () => {
      expect(assistantSourceRouteDecision(shaped(cited, 'organization', WINDOW), 'owner'))
        .toBe('allowed');
    });

    it('טווח שנפתח לכל ההיסטוריה נדחה, גם כשהוא בצורת תאריך תקינה', () => {
      expect(assistantSourceRouteDecision(
        shaped('/expenses?from=0001-01-01&to=9999-12-31', 'organization', WINDOW),
        'owner',
      )).toBe('not_allowlisted');
    });

    it('הזזה של קצה אחד בלבד נדחית — אין כאן "כמעט אותו חלון"', () => {
      for (const widened of ['/expenses?from=2026-01-01&to=2026-09-03', '/expenses?from=2026-08-28&to=2026-12-31']) {
        expect(assistantSourceRouteDecision(shaped(widened, 'organization', WINDOW), 'owner'))
          .toBe('not_allowlisted');
      }
    });

    it('מקור שלא הצהיר על חלון כלל אינו מקבל חלון', () => {
      expect(assistantSourceRouteDecision(source(cited, 'organization'), 'owner'))
        .toBe('not_allowlisted');
    });

    it('הצהרה שאינה בצורת תאריך נדחית גם כשהיא תואמת לקישור', () => {
      expect(assistantSourceRouteDecision(
        shaped('/expenses?from=always&to=always', 'organization', { from: 'always', to: 'always' }),
        'owner',
      )).toBe('not_allowlisted');
    });

    it('הצהרה עם פרמטר עודף נדחית — לא מתעלמים ממנו', () => {
      expect(assistantSourceRouteDecision(
        shaped(cited, 'organization', { ...WINDOW, days: '30' }),
        'owner',
      )).toBe('not_allowlisted');
    });

    it('/expenses ללא חלון נשאר מותר דרך ה-exact rule ואינו נוגע בכלל המעוצב', () => {
      expect(assistantSourceRouteDecision(source('/expenses', 'organization'), 'owner'))
        .toBe('allowed');
    });
  });
});

/**
 * Wave 7's own list, spelled out rather than derived.
 *
 * The rules above prove that whatever is allowlisted behaves consistently. They cannot prove that
 * the RIGHT things are allowlisted — a future edit could delete `?days=30` and every test would
 * still pass, because the remaining rules would stay internally consistent. These are the exact
 * claim/screen-state pairs the citation-landing work established, each one measured against the
 * definition that produces the figure, so removing one is a failing test and not a quiet
 * regression.
 */
describe('citation landing (wave 7)', () => {
  const cases: { route: string; entity: SourceReference['entity']; why: string }[] = [
    { route: '/prices?increases=1&days=30', entity: 'organization', why: 'p2_suppliers_with_price_increase_since bounds price_effective_date to thirty days; ?increases=1 alone has no window at all' },
    { route: '/payment-requests?due=overdue', entity: 'organization', why: 'the overdue exposure, matching management_dashboard_snapshot.overdue' },
    { route: '/payment-requests?due=today', entity: 'organization', why: 'the due-today exposure' },
    { route: '/payment-requests?status=active&due=soon', entity: 'organization', why: 'the seven-day exposure' },
    { route: '/bank?status=attention', entity: 'bank_transaction', why: "the screen's own name for in ('unmatched','suggested') — exactly what get_unmatched_bank_transactions returns" },
    { route: '/credits?status=active', entity: 'organization', why: 'open/requested/received — the statuses the credit count and sum are taken over' },
    { route: '/invoices?review=pending_approval', entity: 'organization', why: "the business summary's awaiting_approval metric" },
    { route: '/exceptions?status=open', entity: 'organization', why: "open+in_progress on both sides" },
  ];

  it.each(cases)('$route נשאר משטח מותר — $why', ({ route, entity }) => {
    expect(assistantSourceRouteDecision(source(route, entity), 'owner')).toBe('allowed');
  });

  it('הפניה לשורה בודדת אפשרית בכל אחד מארבעת המסכים שאין בהם דף לרשומה', () => {
    for (const [route, entity] of [
      ['/products?id=p1', 'product'],
      ['/payments?id=p1', 'payment'],
      ['/credits?id=p1', 'credit_note'],
      ['/prices?product=p1', 'product'],
    ] as const) {
      expect(assistantSourceRouteDecision(source(route, entity, 'p1'), 'owner')).toBe('allowed');
    }
  });

  it('חלון המדידה של get_purchase_metrics עובר אל /expenses', () => {
    expect(assistantSourceRouteDecision(
      shaped('/expenses?from=2026-08-04&to=2026-09-03', 'organization', { from: '2026-08-04', to: '2026-09-03' }),
      'owner',
    )).toBe('allowed');
  });
});
