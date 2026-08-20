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
  ASSISTANT_EXACT_ROUTE_RULES,
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
});
