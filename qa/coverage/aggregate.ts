import { readFileSync } from 'node:fs';
import path from 'node:path';
import { QA_ROLES, type QaRole } from '../config/roles.ts';
import { COVERAGE_DIR } from './build-manifest.ts';
import { readRouteRecords, type RouteRecordFile } from './record-store.ts';
import {
  ApplicationManifestSchema,
  RoleActionMatrixSchema,
  RoleRouteMatrixSchema,
  type ApplicationManifest,
  type ComponentCoverageResult,
  type CoverageStatus,
  type CoveragePercentages,
  type RoleActionMatrix,
  type RoleCoverageSummary,
  type RoleRouteMatrix,
  type StateCoverageRecord,
} from './types.ts';

/**
 * Turning records into numbers.
 *
 * Every percentage here has one definition and it is printed next to the number in the report,
 * because "87% coverage" without a denominator is not a measurement. Where a denominator is zero
 * the value is reported as 0 with the count shown, never as 100 — an empty set is not full
 * coverage, and rounding it up would be the single most misleading thing this file could do.
 */

export interface RoleAggregate {
  readonly role: QaRole;
  readonly records: readonly RouteRecordFile[];
  readonly summary: RoleCoverageSummary;
  readonly components: readonly ComponentCoverageResult[];
  readonly states: readonly StateCoverageRecord[];
}

export interface CoverageMetricDefinition {
  readonly key: keyof CoveragePercentages;
  readonly label: string;
  readonly definition: string;
}

export const METRIC_DEFINITIONS: readonly CoverageMetricDefinition[] = [
  { key: 'routes', label: 'מסלולים', definition: 'מסלולים שנכתבה להם תוצאה חלקי כל המסלולים שהוקצו לתפקיד.' },
  { key: 'components', label: 'רכיבים', definition: 'בקרות מהמניפסט שקיבלו הכרעת נוכחות בזמן ריצה חלקי הבקרות במסלולים הנגישים.' },
  { key: 'actions', label: 'פעולות', definition: 'פעולות שהבקרה שלהן אותרה במסך חלקי הפעולות במסלולים הנגישים. הפעלה בפועל נספרת בנפרד.' },
  { key: 'forms', label: 'טפסים', definition: 'שדות טופס שקיבלו הכרעה חלקי שדות הטופס שהתגלו.' },
  { key: 'tables', label: 'טבלאות', definition: 'בקרות טבלה שקיבלו הכרעה חלקי בקרות הטבלה שהתגלו.' },
  { key: 'dialogs', label: 'דיאלוגים', definition: 'דיאלוגים שקיבלו הכרעה חלקי הדיאלוגים שהתגלו.' },
  { key: 'permissions', label: 'הרשאות', definition: 'תאי מטריצת מסלול-תפקיד שנמדדו בפועל חלקי כל התאים של התפקיד.' },
  { key: 'accessibility', label: 'נגישות', definition: 'מסלולים נגישים שעברו סריקת Axe ובדיקת סמנטיקה חלקי המסלולים הנגישים.' },
  { key: 'states', label: 'מצבים', definition: 'מצבים שנצפו בפועל חלקי המצבים הישימים. מצב שלא נצפה נשאר מפורט ואינו נספר.' },
  { key: 'responsiveViewports', label: 'רספונסיביות', definition: 'מסלולים נגישים שנמדדו בשלושה viewports חלקי המסלולים הנגישים.' },
  { key: 'dataPersistence', label: 'שרידות נתונים', definition: 'מסלולים נגישים שנבדקה בהם יציבות אחרי רענון חלקי המסלולים הנגישים.' },
];

function percent(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export function loadManifest(): ApplicationManifest {
  return ApplicationManifestSchema.parse(
    JSON.parse(readFileSync(path.join(COVERAGE_DIR, 'application-manifest.json'), 'utf8')),
  );
}

export function loadRouteMatrix(): RoleRouteMatrix {
  return RoleRouteMatrixSchema.parse(
    JSON.parse(readFileSync(path.join(COVERAGE_DIR, 'role-route-matrix.json'), 'utf8')),
  );
}

export function loadActionMatrix(): RoleActionMatrix {
  return RoleActionMatrixSchema.parse(
    JSON.parse(readFileSync(path.join(COVERAGE_DIR, 'role-action-matrix.json'), 'utf8')),
  );
}

const PSEUDO_ROUTES = ['__session-expiry__', '__failed-request__', '__navigation__'];

export function aggregateRole(
  role: QaRole,
  artifactRoot: string,
  manifest: ApplicationManifest,
  matrix: RoleRouteMatrix,
): RoleAggregate {
  const records = readRouteRecords(artifactRoot, role);
  const byRoute = new Map(records.map((record) => [record.route, record]));

  const assignedRoutes = matrix.rows.map((row) => row.route);
  const accessibleRoutes = matrix.rows
    .filter((row) => row.cells[role]?.verdict === 'EXPECTED_ACCESS')
    .map((row) => row.route);

  const inspected = assignedRoutes.filter((route) => byRoute.has(route));
  const notInspected = assignedRoutes.filter((route) => !byRoute.has(route));

  const components = records.flatMap((record) => record.components);
  const states = records.flatMap((record) => record.states);

  const manifestControlsOnAccessible = manifest.routes
    .filter((entry) => accessibleRoutes.includes(entry.route))
    .flatMap((entry) => entry.majorSections.flatMap((section) => section.controls));
  const manifestControlIds = new Set(manifestControlsOnAccessible.map((control) => control.id));
  const classifiedManifestControls = new Set(
    components.filter((record) => manifestControlIds.has(record.controlId)).map((record) => record.controlId),
  );

  const actionsOnAccessible = manifest.routes
    .filter((entry) => accessibleRoutes.includes(entry.route))
    .flatMap((entry) => entry.knownActions);
  const locatedControlIds = new Set(
    components.filter((record) => record.actualAvailability).map((record) => record.controlId),
  );
  const actionsLocated = actionsOnAccessible.filter((action) => {
    const controlId = action.id.slice(action.id.indexOf('#') + 1);
    return locatedControlIds.has(controlId);
  }).length;

  const controlsByType = (types: readonly string[]): { total: number; classified: number } => {
    const wanted = manifestControlsOnAccessible.filter((control) => types.includes(control.controlType));
    return {
      total: wanted.length,
      classified: wanted.filter((control) => classifiedManifestControls.has(control.id)).length,
    };
  };
  const forms = controlsByType(['input', 'textarea', 'select', 'checkbox', 'radio', 'file_upload']);
  const tables = controlsByType(['table_action', 'pagination']);
  const dialogs = controlsByType(['dialog', 'drawer', 'menu']);

  const accessibleInspected = accessibleRoutes.filter((route) => byRoute.has(route));
  const withAxe = accessibleInspected.filter((route) => {
    const record = byRoute.get(route);
    return record ? typeof record.routeResult.timingsMs.axeViolations === 'number' : false;
  }).length;
  const withResponsive = accessibleInspected.filter((route) =>
    byRoute.get(route)?.routeResult.evidence.some((entry) => entry.startsWith('responsive:')),
  ).length;
  const withRefresh = accessibleInspected.filter((route) => byRoute.get(route)?.routeResult.refreshStable !== null).length;

  const applicableStates = states.filter((record) => record.status !== 'NOT_APPLICABLE');
  const observedStates = states.filter((record) => record.status === 'OBSERVED');

  const permissionCells = matrix.rows.length;
  const measuredCells = matrix.rows.filter((row) => {
    const record = byRoute.get(row.route);
    return record ? record.routeResult.directAccessOutcome !== 'NOT_ATTEMPTED' : false;
  }).length;

  const percentages: CoveragePercentages = {
    routes: percent(inspected.length, assignedRoutes.length),
    components: percent(classifiedManifestControls.size, manifestControlsOnAccessible.length),
    actions: percent(actionsLocated, actionsOnAccessible.length),
    forms: percent(forms.classified, forms.total),
    tables: percent(tables.classified, tables.total),
    dialogs: percent(dialogs.classified, dialogs.total),
    permissions: percent(measuredCells, permissionCells),
    accessibility: percent(withAxe, accessibleInspected.length),
    states: percent(observedStates.length, applicableStates.length),
    responsiveViewports: percent(withResponsive, accessibleInspected.length),
    dataPersistence: percent(withRefresh, accessibleInspected.length),
  };

  const blockedItems = records
    .filter((record) => record.routeResult.status === 'BLOCKED')
    .map((record) => `${record.route}: ${record.routeResult.rationale}`);

  const unexplainedGaps: string[] = [];
  for (const route of notInspected) unexplainedGaps.push(`אין תוצאה כלל למסלול ${route}.`);
  for (const pseudo of PSEUDO_ROUTES) {
    if (!byRoute.has(pseudo)) unexplainedGaps.push(`לא נכתבה תוצאה לבדיקת ${pseudo}.`);
  }
  const unmatchedControls = manifestControlsOnAccessible.length - classifiedManifestControls.size;
  if (unmatchedControls > 0) {
    unexplainedGaps.push(`${unmatchedControls} בקרות מהמניפסט לא קיבלו הכרעת נוכחות במסלולים הנגישים.`);
  }

  // Coverage completeness, deliberately blind to whether the product behaved well. A role can be
  // COVERAGE_COMPLETED while every one of its screens is broken; those are different questions.
  const coverageStatus: CoverageStatus = (() => {
    if (records.length === 0) return 'INFRASTRUCTURE_FAILED';
    if (notInspected.length > 0) return 'COVERAGE_PARTIAL';
    if (blockedItems.length > 0) return 'COVERAGE_BLOCKED';
    if (unexplainedGaps.length > 0) return 'COVERAGE_PARTIAL';
    return 'COVERAGE_COMPLETED';
  })();

  return {
    role,
    records,
    components,
    states,
    summary: {
      role,
      coverageStatus,
      assignedRoutes: assignedRoutes.length,
      inspectedRoutes: inspected.length,
      notInspectedRoutes: notInspected,
      discoveredControls: manifestControlsOnAccessible.length + components.filter((record) => record.section === 'runtime-only').length,
      testedControls: components.length,
      percentages,
      unexplainedGaps,
      blockedItems,
    },
  };
}

export function aggregateAll(artifactRoot: string): {
  manifest: ApplicationManifest;
  matrix: RoleRouteMatrix;
  roles: RoleAggregate[];
} {
  const manifest = loadManifest();
  const matrix = loadRouteMatrix();
  const roles = QA_ROLES.map((role) => aggregateRole(role, artifactRoot, manifest, matrix));
  return { manifest, matrix, roles };
}

/**
 * Fill the action matrix with what the walk actually saw.
 *
 * A cell only moves off NOT_TESTED when there is a record behind it. UI visibility is observed;
 * whether the server would have allowed the call is left null unless a probe answered it, because
 * inferring a server verdict from a hidden button is exactly the mistake the matrix exists to find.
 */
export function applyRuntimeToActionMatrix(
  actionMatrix: RoleActionMatrix,
  aggregates: readonly RoleAggregate[],
): RoleActionMatrix {
  const byRole = new Map(aggregates.map((aggregate) => [aggregate.role, aggregate]));

  const rows = actionMatrix.rows.map((row) => {
    const controlId = row.actionId.slice(row.actionId.indexOf('#') + 1);
    const cells = { ...row.cells };
    for (const role of QA_ROLES) {
      const aggregate = byRole.get(role);
      const cell = cells[role];
      if (!aggregate || !cell) continue;
      const record = aggregate.records.find((entry) => entry.route === row.route);
      if (!record) continue;

      const routeRendered = record.routeResult.directAccessOutcome === 'RENDERED';
      const component = record.components.find((entry) => entry.controlId === controlId);
      const serverLeak = record.observations.some((observation) => observation.title.includes('אך השרת מחזיר נתונים'));

      if (!routeRendered) {
        cells[role] = {
          verdict: serverLeak ? 'HIDDEN_BUT_SERVER_ALLOWS' : 'DENIED_IN_UI',
          uiVisible: false,
          serverAllows: serverLeak ? true : null,
          rationale: serverLeak
            ? 'המסך נחסם אך בדיקת שרת עם הטוקן של התפקיד החזירה נתונים.'
            : `המסך לא רונדר לתפקיד (${record.routeResult.directAccessOutcome}); הפעולה אינה נגישה דרך ה-UI.`,
          evidence: record.routeResult.evidence.slice(0, 3),
        };
        continue;
      }

      if (!component) {
        cells[role] = {
          verdict: 'NOT_TESTED',
          uiVisible: null,
          serverAllows: null,
          rationale: 'המסך רונדר אך לא נכתבה רשומת בקרה לפעולה הזו.',
          evidence: [],
        };
        continue;
      }

      cells[role] = {
        verdict: component.actualAvailability
          ? component.interactionAttempted && component.interactionResult === 'PASSED'
            ? 'ALLOWED_AND_SUCCEEDS'
            : 'CONDITIONAL'
          : 'DENIED_IN_UI',
        uiVisible: component.actualAvailability,
        serverAllows: null,
        rationale: component.actualAvailability
          ? component.interactionAttempted
            ? 'הבקרה אותרה והופעלה בהילוך הכיסוי.'
            : 'הבקרה אותרה במסך אך לא הופעלה: הפעלה כספית או הרסנית אינה בהיקף סריקת הכיסוי.'
          : 'הבקרה לא אותרה במסך עבור התפקיד.',
        evidence: component.evidence.slice(0, 3),
      };
    }
    return { ...row, cells };
  });

  return RoleActionMatrixSchema.parse({ ...actionMatrix, rows });
}
