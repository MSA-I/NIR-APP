import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QA_ROLES, isRouteAllowed, type QaRole } from '../config/roles.ts';
import { extractNavigation } from './extract.ts';
import { COVERAGE_DIR, REPO_ROOT } from './build-manifest.ts';
import {
  ApplicationManifestSchema,
  RoleActionMatrixSchema,
  RoleRouteMatrixSchema,
  type ApplicationManifest,
  type RoleActionCell,
  type RoleActionMatrix,
  type RoleRouteCell,
  type RoleRouteMatrix,
} from './types.ts';

/**
 * The two matrices the coverage run is driven from.
 *
 * They are generated as *expectations* only. A cell says what App.tsx and Layout.tsx imply, never
 * what the running app did — the runtime pass overwrites the action verdicts and records the route
 * outcomes separately. Generating a verdict like ALLOWED_AND_SUCCEEDS here would be a claim about
 * behaviour that nothing has observed.
 */

function git(...args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

export function loadManifest(): ApplicationManifest {
  const file = path.join(COVERAGE_DIR, 'application-manifest.json');
  return ApplicationManifestSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

/**
 * A concrete path for a parameterised route, so `isRouteAllowed` (which matches on real paths)
 * can be asked about `/suppliers/:id` without the colon reaching the regular expressions.
 */
export function concreteRoute(route: string): string {
  return route.replace(/:[A-Za-z0-9_]+/g, 'fixture-id');
}

export function buildRoleRouteMatrix(manifest: ApplicationManifest): RoleRouteMatrix {
  const navigation = extractNavigation(path.join(REPO_ROOT, 'src', 'components', 'Layout.tsx'));

  const rows = manifest.routes.map((route) => {
    const cells: Record<string, RoleRouteCell> = {};
    const navItem = navigation.find((item) => item.to === route.route);

    for (const role of QA_ROLES) {
      const navigationVisible = navItem ? navItem.roles.includes(role) : false;

      if (route.outsideTenantRoleModel) {
        cells[role] = {
          verdict: 'NOT_APPLICABLE',
          rationale:
            'מסלול קונסולת פלטפורמה. מפעיל פלטפורמה אינו תפקיד דייר, ולכן PlatformGuard אינו נגזר ממודל התפקידים — תפקיד דייר צפוי להיות מופנה החוצה.',
          navigationVisible,
          redirectsTo: '/',
        };
        continue;
      }

      if (route.redirectsTo) {
        cells[role] = {
          verdict: 'CONDITIONAL_ACCESS',
          rationale: `המסלול אינו מרנדר מסך אלא מפנה אל ${route.redirectsTo}. ההרשאה נקבעת ביעד, לא כאן.`,
          navigationVisible,
          redirectsTo: route.redirectsTo,
        };
        continue;
      }

      // Public routes sit outside the Layout guard: an authenticated visitor is not bounced by a
      // route guard, so what happens is decided by the screen itself and must be observed.
      if (route.route === '/login' || route.route === '/accept-invite') {
        cells[role] = {
          verdict: 'CONDITIONAL_ACCESS',
          rationale: 'מסלול ציבורי מחוץ ל-Layout. אין guard, ולכן התנהגות מול סשן פעיל נקבעת במסך עצמו ונמדדת בריצה.',
          navigationVisible,
        };
        continue;
      }

      const allowedByApp = route.expectedRoles.includes(role);
      const allowedByQaConfig = isRouteAllowed(role, concreteRoute(route.route));

      // qa/config/roles.ts carries a second, independent copy of the route rules. When the two
      // disagree, one of them is wrong and neither may be used as an expectation — the cell says
      // so instead of silently picking a side.
      if (allowedByApp !== allowedByQaConfig) {
        cells[role] = {
          verdict: 'UNKNOWN_REQUIRES_REVIEW',
          rationale: `סתירה בין App.tsx (${allowedByApp ? 'מותר' : 'אסור'}) לבין ROUTE_RULES ב-qa/config/roles.ts (${allowedByQaConfig ? 'מותר' : 'אסור'}). אחד מהם שגוי; לא נבחרה ציפייה.`,
          navigationVisible,
        };
        continue;
      }

      cells[role] = allowedByApp
        ? {
            verdict: 'EXPECTED_ACCESS',
            rationale: `Guard ב-App.tsx מתיר ${role} למסלול ${route.route}.`,
            navigationVisible,
          }
        : {
            verdict: 'EXPECTED_DENIAL',
            rationale: `Guard ב-App.tsx אינו כולל ${role}; הצפי הוא הפניה לבית של התפקיד.`,
            navigationVisible,
            redirectsTo: 'homeFor(role)',
          };
    }

    return { route: route.route, pageComponent: route.pageComponent, cells };
  });

  return RoleRouteMatrixSchema.parse({
    generatedFrom: { commit: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD') },
    roles: [...QA_ROLES],
    rows,
  });
}

export function buildRoleActionMatrix(manifest: ApplicationManifest): RoleActionMatrix {
  const rows = manifest.routes.flatMap((route) =>
    route.knownActions.map((action) => {
      const cells: Record<string, RoleActionCell> = {};
      for (const role of QA_ROLES) {
        const expected = action.expectedRoles.includes(role) && !route.outsideTenantRoleModel;
        cells[role] = {
          verdict: 'NOT_TESTED',
          uiVisible: null,
          serverAllows: null,
          rationale: expected
            ? 'צפוי להיות זמין לפי ה-guard של המסלול. הכרעה בפועל נקבעת בריצה בלבד.'
            : 'צפוי להיחסם: התפקיד אינו רשאי להגיע למסלול. הכרעה בפועל נקבעת בריצה בלבד.',
          evidence: [],
        };
      }
      return {
        actionId: action.id,
        route: route.route,
        name: action.name,
        actionType: action.actionType,
        destructive: action.destructive,
        financial: action.financial,
        cells,
      };
    }),
  );

  return RoleActionMatrixSchema.parse({
    generatedFrom: { commit: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD') },
    roles: [...QA_ROLES],
    rows,
  });
}

export function writeMatrices(): {
  routeMatrixPath: string;
  actionMatrixPath: string;
  conflicts: { route: string; role: QaRole }[];
} {
  const manifest = loadManifest();
  const routeMatrix = buildRoleRouteMatrix(manifest);
  const actionMatrix = buildRoleActionMatrix(manifest);

  mkdirSync(COVERAGE_DIR, { recursive: true });
  const routeMatrixPath = path.join(COVERAGE_DIR, 'role-route-matrix.json');
  const actionMatrixPath = path.join(COVERAGE_DIR, 'role-action-matrix.json');
  writeFileSync(routeMatrixPath, `${JSON.stringify(routeMatrix, null, 2)}\n`, 'utf8');
  writeFileSync(actionMatrixPath, `${JSON.stringify(actionMatrix, null, 2)}\n`, 'utf8');

  const conflicts = routeMatrix.rows.flatMap((row) =>
    QA_ROLES.filter((role) => row.cells[role]?.verdict === 'UNKNOWN_REQUIRES_REVIEW').map((role) => ({
      route: row.route,
      role,
    })),
  );

  return { routeMatrixPath, actionMatrixPath, conflicts };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { routeMatrixPath, actionMatrixPath, conflicts } = writeMatrices();
  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'WRITTEN',
        routeMatrix: path.relative(REPO_ROOT, routeMatrixPath),
        actionMatrix: path.relative(REPO_ROOT, actionMatrixPath),
        unknownRequiresReview: conflicts,
      },
      null,
      2,
    )}\n`,
  );
}
