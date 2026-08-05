import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { QA_ROLES } from '../config/roles.ts';
import { aggregateRole } from './aggregate.ts';
import { buildManifest, REPO_ROOT } from './build-manifest.ts';
import { buildRoleActionMatrix, buildRoleRouteMatrix, concreteRoute } from './build-matrices.ts';
import { extractControls, extractNavigation, extractRoutes } from './extract.ts';
import { routeSlug } from './record-store.ts';
import { ROUTE_METADATA, statesForRoute } from './route-metadata.ts';
import { triage } from './triage.ts';
import type { RoleAggregate } from './aggregate.ts';

const APP = path.join(REPO_ROOT, 'src', 'App.tsx');
const LAYOUT = path.join(REPO_ROOT, 'src', 'components', 'Layout.tsx');

test('route extraction resolves guard role constants and emits each path once', () => {
  const routes = extractRoutes(APP, REPO_ROOT);
  const paths = routes.map((route) => route.route);
  assert.equal(new Set(paths).size, paths.length, 'a duplicated route would double every total downstream');

  const dashboard = routes.find((route) => route.route === '/dashboard');
  assert.ok(dashboard);
  assert.deepEqual([...dashboard.expectedRoles].sort(), [...QA_ROLES].sort());

  const settings = routes.find((route) => route.route === '/settings');
  assert.deepEqual(settings?.expectedRoles, ['owner']);

  const admin = routes.find((route) => route.route === '/admin');
  assert.equal(admin?.outsideTenantRoleModel, true, 'the platform console is not a tenant role route');

  const suppliers = routes.find((route) => route.route === '/suppliers/:id');
  assert.deepEqual(suppliers?.dynamicParameters, ['id']);
});

test('navigation extraction reads the per-role NAV contract', () => {
  const navigation = extractNavigation(LAYOUT);
  assert.ok(navigation.length > 10);
  const myPrices = navigation.find((item) => item.to === '/my-prices');
  assert.deepEqual(myPrices?.roles, ['supplier']);
  const pay = navigation.find((item) => item.to === '/pay');
  assert.deepEqual([...(pay?.roles ?? [])].sort(), ['accountant', 'payer']);
});

test('control extraction finds named controls and the backend calls behind them', () => {
  const facts = extractControls(path.join(REPO_ROOT, 'src', 'pages', 'Login.tsx'), REPO_ROOT);
  assert.ok(facts.controls.length > 0, 'the login screen has interactive controls');
  assert.ok(
    facts.controls.every((control) => control.localId.length > 0),
    'a control without an id cannot be tracked across the run',
  );
});

test('the manifest covers every route and carries curated metadata for each', () => {
  const manifest = buildManifest();
  assert.ok(manifest.totals.routes >= 30);
  assert.ok(manifest.totals.controls > 100);

  const missing = manifest.routes.filter((route) => !ROUTE_METADATA[route.route]);
  assert.deepEqual(missing, [], 'a route without curated metadata would report an invented purpose');

  const duplicates = manifest.routes.filter(
    (route, index) => manifest.routes.findIndex((other) => other.route === route.route) !== index,
  );
  assert.deepEqual(duplicates, []);

  for (const route of manifest.routes) {
    for (const section of route.majorSections) {
      const ids = section.controls.map((control) => control.id);
      assert.equal(new Set(ids).size, ids.length, `duplicate control id on ${route.route}`);
    }
  }
});

test('every applicable state list is non-empty for a rendered screen', () => {
  assert.ok(statesForRoute('/invoices').includes('empty'));
  assert.ok(statesForRoute('/invoices').includes('expired_session'));
  assert.ok(!statesForRoute('/login').includes('expired_session'), 'the login screen has no session to expire');
});

test('the role-route matrix decides every cell and never leaves a hole', () => {
  const manifest = buildManifest();
  const matrix = buildRoleRouteMatrix(manifest);
  assert.equal(matrix.rows.length, manifest.totals.routes);
  for (const row of matrix.rows) {
    for (const role of QA_ROLES) {
      const cell = row.cells[role];
      assert.ok(cell, `${row.route} has no cell for ${role}`);
      assert.ok(cell.rationale.length > 0, `${row.route}/${role} has a verdict with no reason`);
    }
  }

  const settings = matrix.rows.find((row) => row.route === '/settings');
  assert.equal(settings?.cells.owner?.verdict, 'EXPECTED_ACCESS');
  assert.equal(settings?.cells.supplier?.verdict, 'EXPECTED_DENIAL');

  const admin = matrix.rows.find((row) => row.route === '/admin');
  assert.equal(admin?.cells.owner?.verdict, 'NOT_APPLICABLE');
});

test('the action matrix starts untested rather than claiming an unobserved success', () => {
  const manifest = buildManifest();
  const matrix = buildRoleActionMatrix(manifest);
  assert.ok(matrix.rows.length > 0);
  for (const row of matrix.rows.slice(0, 50)) {
    for (const role of QA_ROLES) {
      assert.equal(row.cells[role]?.verdict, 'NOT_TESTED');
      assert.equal(row.cells[role]?.serverAllows, null);
    }
  }
});

test('a parameterised route becomes a concrete path before the rules are asked about it', () => {
  assert.equal(concreteRoute('/suppliers/:id'), '/suppliers/fixture-id');
  assert.equal(concreteRoute('/documents/:documentId/review'), '/documents/fixture-id/review');
  assert.equal(concreteRoute('/invoices'), '/invoices');
});

test('route slugs stay filesystem-safe for pseudo routes too', () => {
  assert.equal(routeSlug('/documents/:documentId/review'), 'documents_documentId_review');
  assert.equal(routeSlug('/'), 'root');
  assert.equal(routeSlug('__session-expiry__'), 'session_expiry');
});

test('an empty run reports zero coverage, never a vacuous hundred percent', () => {
  const manifest = buildManifest();
  const matrix = buildRoleRouteMatrix(manifest);
  const aggregate = aggregateRole('owner', path.join(REPO_ROOT, 'qa', 'coverage', '__no_such_artifacts__'), manifest, matrix);
  assert.equal(aggregate.summary.coverageStatus, 'INFRASTRUCTURE_FAILED');
  assert.equal(aggregate.summary.inspectedRoutes, 0);
  for (const value of Object.values(aggregate.summary.percentages)) {
    assert.equal(value, 0, 'an empty denominator must round to 0, not to full coverage');
  }
});

function aggregateWith(observations: RoleAggregate['records'][number]['observations']): RoleAggregate[] {
  return [
    {
      role: 'payer',
      components: [],
      states: [],
      records: [
        {
          runId: 'test',
          role: 'payer',
          route: '/invoices',
          recordedAt: new Date(0).toISOString(),
          routeResult: {
            route: '/invoices',
            role: 'payer',
            expectedVerdict: 'EXPECTED_DENIAL',
            navigationVisible: false,
            directAccessOutcome: 'REDIRECTED',
            protectedContentRendered: false,
            dataReturned: null,
            refreshStable: null,
            informationLeakBeforeRedirect: false,
            consoleErrors: [],
            failedRequests: [],
            timingsMs: {},
            status: 'PASSED',
            rationale: 'test',
            evidence: [],
          },
          components: [],
          states: [],
          observations,
        },
      ],
      summary: {
        role: 'payer',
        coverageStatus: 'COVERAGE_PARTIAL',
        assignedRoutes: 1,
        inspectedRoutes: 1,
        notInspectedRoutes: [],
        discoveredControls: 0,
        testedControls: 0,
        percentages: {
          routes: 0, components: 0, actions: 0, forms: 0, tables: 0, dialogs: 0,
          permissions: 0, accessibility: 0, states: 0, responsiveViewports: 0, dataPersistence: 0,
        },
        unexplainedGaps: [],
        blockedItems: [],
      },
    },
  ];
}

test('triage confirms a server that answers behind a blocked screen', () => {
  const results = triage(
    aggregateWith([
      {
        id: 'x',
        title: 'המסך חסום אך השרת מחזיר נתונים',
        detail: '/rest/v1/invoices החזיר 200 עם 1 שורות',
        category: 'authorization',
        severityHint: 'high',
        evidence: [],
      },
    ]),
  );
  assert.equal(results.length, 1);
  assert.equal(results[0]?.classification, 'CONFIRMED_DEFECT');
  assert.match(results[0]?.rationale ?? '', /server-allows-hidden-screen/);
});

test('triage rejects the known local-stack 502 instead of filing it as a product defect', () => {
  const results = triage(
    aggregateWith([
      {
        id: 'y',
        title: 'בקשות רשת שנכשלו',
        detail: 'POST /rest/v1/rpc/p2_above_average_offer_count: HTTP 502',
        category: 'network',
        severityHint: 'medium',
        evidence: [],
      },
    ]),
  );
  assert.equal(results[0]?.classification, 'FALSE_POSITIVE');
});

test('triage leaves a single unreproduced functional observation inconclusive', () => {
  const results = triage(
    aggregateWith([
      {
        id: 'z',
        title: 'המסך אינו יציב אחרי רענון',
        detail: 'אחרי רענון נותרו 0 בקרות',
        category: 'functional',
        severityHint: 'high',
        evidence: [],
      },
    ]),
  );
  assert.equal(results[0]?.classification, 'INCONCLUSIVE');
  assert.equal(results[0]?.reproducedTimes, 1);
});
