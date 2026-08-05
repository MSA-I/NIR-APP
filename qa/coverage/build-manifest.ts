import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QA_ROLES, type QaRole } from '../config/roles.ts';
import {
  extractComponentSources,
  extractControls,
  extractNavigation,
  extractRoutes,
  resolveLocalImports,
  slug,
  type ExtractedControl,
} from './extract.ts';
import { ROUTE_METADATA, statesForRoute } from './route-metadata.ts';
import {
  ApplicationManifestSchema,
  type ActionManifestEntry,
  type ApplicationManifest,
  type ControlManifestEntry,
  type RouteManifestEntry,
  type SectionManifestEntry,
} from './types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const COVERAGE_DIR = path.join(REPO_ROOT, 'qa', 'coverage');

const LIMITATIONS = [
  'המניפסט נבנה מניתוח סטטי של JSX. בקרה שמופיעה כאן היא השערה על הקוד, לא הוכחה שהיא מרונדרת — רק שלב הריצה מכריע.',
  'בקרה שמופיעה רק בענף תלוי-נתונים, מאחורי בדיקת תפקיד או בתוך דיאלוג סגור אינה ניתנת להבחנה סטטית מבקרה שתמיד מרונדרת.',
  'expectedRoles של בקרה יורש מהמסלול. שלילה ברמת הבקרה בתוך המסך אינה נגזרת סטטית ומאומתת רק בריצה.',
  'actionType, destructive ו-financial נגזרים מהתווית העברית. תווית חדשה שלא תואמת את הדפוסים תסווג שמרנית ותדרוש תיקון ידני.',
  'הענף הזה נבנה על codex/qa-multi-agent, שהוא 43 קומיטים מאחורי main. המניפסט מתאר את המצב בענף הזה ולא את main.',
];

function git(...args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/** Component files whose controls belong to a page. Pure logic modules contribute nothing. */
function contributingFiles(pageFiles: readonly string[]): string[] {
  const collected: string[] = [];
  for (const pageFile of pageFiles) {
    const absolute = path.join(REPO_ROOT, pageFile);
    const imported = resolveLocalImports(absolute, REPO_ROOT, 1).filter(
      (file) => file.startsWith('src/') && !file.includes('.test.') && !file.endsWith('/ui.tsx'),
    );
    for (const file of [pageFile, ...imported]) {
      if (!collected.includes(file)) collected.push(file);
    }
  }
  return collected;
}

function sectionIdFor(file: string, pageFiles: readonly string[]): string {
  // A route served by one page gets a `main` section. A route that picks between pages by role
  // (DashboardHome) has no single main, so each page keeps its own identity in the section id.
  if (pageFiles.length === 1 && file === pageFiles[0]) return 'main';
  return slug(path.basename(file, path.extname(file)));
}

function toControl(
  control: ExtractedControl,
  route: string,
  sectionId: string,
  expectedRoles: readonly QaRole[],
  used: Set<string>,
): ControlManifestEntry {
  let id = `${sectionId}:${control.localId}`;
  let suffix = 2;
  while (used.has(id)) id = `${sectionId}:${control.localId}-${suffix++}`;
  used.add(id);
  return {
    id,
    route,
    section: sectionId,
    controlType: control.controlType,
    visibleLabel: control.visibleLabel,
    accessibleName: control.accessibleName,
    expectedRoles: [...expectedRoles],
    actionType: control.actionType,
    destructive: control.destructive,
    financial: control.financial,
    requiresFixture: control.requiresFixture,
    discoveredBy: 'static',
    sourceFile: control.sourceFile,
    sourceLine: control.sourceLine,
  };
}

const MUTATING = new Set([
  'create',
  'update',
  'delete',
  'approve',
  'reject',
  'upload',
  'import',
  'export',
  'state_change',
]);

export function buildManifest(): ApplicationManifest {
  const appFile = path.join(REPO_ROOT, 'src', 'App.tsx');
  const layoutFile = path.join(REPO_ROOT, 'src', 'components', 'Layout.tsx');

  const routes = extractRoutes(appFile, REPO_ROOT);
  const componentSources = extractComponentSources(appFile, REPO_ROOT);
  const navigation = extractNavigation(layoutFile);

  const entries: RouteManifestEntry[] = routes.map((route) => {
    const metadata = ROUTE_METADATA[route.route];
    const pageFiles = componentSources.get(route.pageComponent) ?? [];
    const files = contributingFiles(pageFiles);
    const expectedRoles = [...route.expectedRoles];
    const deniedRoles = route.outsideTenantRoleModel
      ? [...QA_ROLES]
      : QA_ROLES.filter((role) => !expectedRoles.includes(role));

    const usedControlIds = new Set<string>();
    const sections: SectionManifestEntry[] = [];
    const queryParameters = new Set<string>();
    const backendCalls = new Set<string>();
    const headings: string[] = [];

    for (const file of files) {
      const facts = extractControls(path.join(REPO_ROOT, file), REPO_ROOT);
      for (const parameter of facts.queryParameters) queryParameters.add(parameter);
      for (const call of facts.backendCalls) backendCalls.add(call);
      if (pageFiles.includes(file)) headings.push(...facts.headings);
      if (facts.controls.length === 0) continue;

      const sectionId = sectionIdFor(file, pageFiles);
      const isPage = pageFiles.includes(file);
      sections.push({
        id: sectionId,
        name: sectionId === 'main' ? (metadata?.title ?? route.pageComponent) : path.basename(file, path.extname(file)),
        component: path.basename(file, path.extname(file)),
        purpose: isPage
          ? (metadata?.purpose ?? 'אין מטא-דאטה מתועדת למסלול הזה — פער מדווח, לא הנחה שקטה.')
          : `רכיב משנה שתורם בקרות למסלול ${route.route}.`,
        expectedRoles,
        controls: facts.controls.map((control) => toControl(control, route.route, sectionId, expectedRoles, usedControlIds)),
        discoveredBy: 'static',
      });
    }

    const backend = [...backendCalls];
    const knownActions: ActionManifestEntry[] = sections
      .flatMap((section) => section.controls)
      .filter((control) => MUTATING.has(control.actionType))
      .map((control) => ({
        id: `${route.route}#${control.id}`,
        name: control.accessibleName ?? control.id,
        actionType: control.actionType,
        expectedRoles,
        destructive: control.destructive,
        financial: control.financial,
        backend,
        requiresFixture: control.requiresFixture,
      }));

    return {
      route: route.route,
      pageComponent: route.pageComponent,
      title: metadata?.title ?? headings[0],
      navigationLabel: navigation.find((item) => item.to === route.route)?.label,
      expectedRoles,
      deniedRoles,
      dynamicParameters: route.dynamicParameters.length ? [...route.dynamicParameters] : undefined,
      queryParameters: queryParameters.size ? [...queryParameters] : undefined,
      majorSections: sections,
      knownActions,
      knownStates: statesForRoute(route.route),
      sourceFiles: files.length ? files : [route.sourceFile],
      outsideTenantRoleModel: route.outsideTenantRoleModel,
      redirectsTo: route.redirectsTo,
    };
  });

  const manifest: ApplicationManifest = {
    generatedFrom: {
      commit: git('rev-parse', 'HEAD'),
      branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
      appSource: 'src/App.tsx',
      navigationSource: 'src/components/Layout.tsx',
    },
    limitations: LIMITATIONS,
    routes: entries,
    totals: {
      routes: entries.length,
      sections: entries.reduce((sum, entry) => sum + entry.majorSections.length, 0),
      controls: entries.reduce(
        (sum, entry) => sum + entry.majorSections.reduce((inner, section) => inner + section.controls.length, 0),
        0,
      ),
      actions: entries.reduce((sum, entry) => sum + entry.knownActions.length, 0),
    },
  };

  return ApplicationManifestSchema.parse(manifest);
}

export function writeManifest(): { path: string; manifest: ApplicationManifest } {
  const manifest = buildManifest();
  mkdirSync(COVERAGE_DIR, { recursive: true });
  const target = path.join(COVERAGE_DIR, 'application-manifest.json');
  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { path: target, manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { path: target, manifest } = writeManifest();
  const missing = manifest.routes.filter((route) => !ROUTE_METADATA[route.route]).map((route) => route.route);
  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'WRITTEN',
        target: path.relative(REPO_ROOT, target),
        totals: manifest.totals,
        routesWithoutCuratedMetadata: missing,
      },
      null,
      2,
    )}\n`,
  );
}
