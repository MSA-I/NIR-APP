import { AxeBuilder } from '@axe-core/playwright';
import { test as base, expect, type Page, type TestInfo } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ConsoleMonitor } from '../../browser/console-monitor.ts';
import { NetworkMonitor } from '../../browser/network-monitor.ts';
import { redactText, sensitiveScreenshotMasks } from '../../browser/redaction.ts';
import { createQaConfig } from '../../config/qa.config.ts';
import { QA_ROLES, type QaRole } from '../../config/roles.ts';
import { COVERAGE_DIR } from '../build-manifest.ts';
import {
  emptyRouteResult,
  writeRouteRecord,
  type CoverageObservation,
  type RouteRecordFile,
} from '../record-store.ts';
import {
  inspectOpenDialog,
  inspectSemantics,
  measureOverflow,
  snapshotControls,
  undersizedTouchTargets,
  probeServerAccess,
  type RuntimeControl,
} from '../runtime.ts';
import {
  ApplicationManifestSchema,
  RoleRouteMatrixSchema,
  type ApplicationManifest,
  type ComponentCoverageResult,
  type CoverageState,
  type RoleRouteMatrix,
  type RouteCoverageResult,
  type StateCoverageRecord,
  type StateCoverageStatus,
} from '../types.ts';

/**
 * The role coverage walk.
 *
 * One test per route per role, so every row of the matrix ends with a written result rather than a
 * silence that a reader could mistake for a pass. Tests are independent on purpose: a route that
 * fails must not prevent the next twenty routes from being inspected, because an unwalked route is
 * a coverage gap and a failed route is a product finding, and the two must never be confused.
 *
 * The walk reads and navigates. It does not create, approve, pay or delete: those mutations are
 * already owned by qa/deterministic/critical-workflows.spec.ts with independent verifiers, and
 * repeating them here against shared local state would corrupt the very fixtures that suite needs.
 * Controls that would move money or destroy a record are recorded as deliberately not exercised.
 */

const qa = createQaConfig();
const RUN_ID = process.env.QA_RUN_ID?.trim() || 'coverage-walk';
const HOME = '/dashboard';
const MAX_STEPS_PER_ROUTE = Number(process.env.QA_COVERAGE_MAX_STEPS_PER_ROUTE ?? '40');

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

const manifest: ApplicationManifest = ApplicationManifestSchema.parse(
  JSON.parse(readFileSync(path.join(COVERAGE_DIR, 'application-manifest.json'), 'utf8')),
);
const routeMatrix: RoleRouteMatrix = RoleRouteMatrixSchema.parse(
  JSON.parse(readFileSync(path.join(COVERAGE_DIR, 'role-route-matrix.json'), 'utf8')),
);

function roleFromCoverageProject(projectName: string): QaRole {
  const value = projectName.replace(/^coverage-/, '');
  if (!(QA_ROLES as readonly string[]).includes(value)) {
    throw new Error(`Coverage project does not identify a QA role: ${projectName}`);
  }
  return value as QaRole;
}

interface Monitors {
  readonly console: ConsoleMonitor;
  readonly network: NetworkMonitor;
}

const test = base.extend<{ qaRole: QaRole; monitors: Monitors }>({
  qaRole: async ({}, use, testInfo) => {
    await use(roleFromCoverageProject(testInfo.project.name));
  },
  // The deterministic suite fails a test on any unexpected 4xx. A coverage walk deliberately
  // knocks on doors that must be locked, so here the same monitors feed the record instead of
  // ending the run — the report decides what an observation means, not the fixture.
  monitors: async ({ page }, use) => {
    const monitors = { console: new ConsoleMonitor(page), network: new NetworkMonitor(page) };
    await use(monitors);
    monitors.console.stop();
    monitors.network.stop();
  },
});

class Recorder {
  readonly components: ComponentCoverageResult[] = [];
  readonly states: StateCoverageRecord[] = [];
  readonly observations: CoverageObservation[] = [];
  private observationCounter = 0;

  constructor(
    private readonly role: QaRole,
    private readonly route: string,
  ) {}

  component(input: Omit<ComponentCoverageResult, 'runId' | 'role' | 'route'>): void {
    this.components.push({ runId: RUN_ID, role: this.role, route: this.route, ...input });
  }

  state(state: CoverageState, status: StateCoverageStatus, rationale: string, evidence: string[] = []): void {
    this.states.push({ runId: RUN_ID, role: this.role, route: this.route, state, status, rationale, evidence });
  }

  observe(
    title: string,
    detail: string,
    category: CoverageObservation['category'],
    severityHint: CoverageObservation['severityHint'],
    evidence: string[] = [],
  ): void {
    this.observationCounter += 1;
    this.observations.push({
      id: `${this.role}:${this.route}:${this.observationCounter}`,
      title,
      detail,
      category,
      severityHint,
      evidence,
    });
  }

  /** Every state the manifest says applies to this route must end with an explicit verdict. */
  fillUnobservedStates(applicable: readonly CoverageState[], rationale: string): void {
    const decided = new Set(this.states.map((record) => record.state));
    for (const state of applicable) {
      if (!decided.has(state)) this.state(state, 'NOT_OBSERVED', rationale);
    }
  }
}

function pathOf(page: Page): string {
  try {
    return new URL(page.url()).pathname;
  } catch {
    return 'unavailable';
  }
}

async function screenshot(page: Page, testInfo: TestInfo, label: string): Promise<string> {
  const name = `${label.replace(/[^A-Za-z0-9_-]+/g, '-')}.png`;
  await page
    .screenshot({ path: testInfo.outputPath(name), fullPage: true, mask: [...sensitiveScreenshotMasks(page)] })
    .catch(() => undefined);
  return name;
}

/**
 * A usable id for a parameterised route, taken from the list screen a user would come from.
 * If the role cannot reach that list, there is no id — and the detail route is honestly blocked
 * rather than probed with an invented UUID that would only ever prove "not found".
 */
async function resolveConcreteRoute(page: Page, route: string): Promise<string | null> {
  if (!route.includes(':')) return route;
  const listPath = route.slice(0, route.indexOf('/:')) || '/';
  const pattern = new RegExp(`^${route.replace(/:[A-Za-z0-9_]+/g, '[^/]+')}$`);
  await page.goto(listPath).catch(() => undefined);
  if (pathOf(page) !== listPath) return null;
  await page.waitForLoadState('networkidle').catch(() => undefined);

  const hrefs = await page.evaluate(() =>
    [...document.querySelectorAll('a[href]')].map((anchor) => anchor.getAttribute('href') ?? ''),
  );
  const linked = hrefs
    .map((href) => {
      try {
        return new URL(href, 'http://127.0.0.1').pathname;
      } catch {
        return '';
      }
    })
    .find((candidate) => pattern.test(candidate));
  if (linked) return linked;

  // The lists do not use anchors: DataTable rows navigate through onRowClick. Opening a row is
  // exactly how a user reaches the detail screen, so the id comes from doing that rather than from
  // inventing a UUID — an invented id would only ever prove that "not found" renders.
  const row = page.locator('table tbody tr').first();
  if (await row.count()) {
    await row.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForLoadState('networkidle').catch(() => undefined);
    if (pattern.test(pathOf(page))) return pathOf(page);

    // Card layout, or a row whose navigation lives on a control inside it.
    await page.goto(listPath).catch(() => undefined);
    await page.waitForLoadState('networkidle').catch(() => undefined);
  }

  const rowButton = page.locator('table tbody tr button, [data-testid="card"] button, ul li button').first();
  if (await rowButton.count()) {
    await rowButton.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForLoadState('networkidle').catch(() => undefined);
    if (pattern.test(pathOf(page))) return pathOf(page);
  }
  return null;
}

/** Match a manifest control to something on screen. Names are the contract both sides can see. */
function findRuntimeMatch(
  controls: readonly RuntimeControl[],
  accessibleName: string | undefined,
): RuntimeControl | undefined {
  if (!accessibleName) return undefined;
  const target = accessibleName.replace(/\s+/g, ' ').trim();
  if (!target) return undefined;
  return (
    controls.find((control) => control.accessibleName === target) ??
    controls.find((control) => control.accessibleName.includes(target) && target.length >= 4) ??
    controls.find((control) => target.includes(control.accessibleName) && control.accessibleName.length >= 4)
  );
}

function isSafeToClick(control: RuntimeControl, financial: boolean, destructive: boolean): boolean {
  if (financial || destructive) return false;
  if (control.disabled || !control.visible) return false;
  const name = control.accessibleName;
  // Anything that reads like it commits work stays untouched, even when the manifest missed it.
  return !/שמיר|שמור|אישור|אשר|מחיק|מחק|שליח|שלח|ביצוע|בצע|יצירת|צור|הגשת|הגש|ייבוא|ייצוא|התנתק/.test(name);
}

async function runAxe(page: Page, testInfo: TestInfo, label: string): Promise<{ blocking: string[]; total: number }> {
  try {
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    const summary = result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.length,
      targets: violation.nodes.flatMap((node) => node.target.map((target) => redactText(String(target)))).slice(0, 8),
    }));
    await testInfo.attach(`axe-${label}`, {
      body: Buffer.from(`${JSON.stringify(summary, null, 2)}\n`, 'utf8'),
      contentType: 'application/json',
    });
    const blocking = result.violations
      .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
      .map((violation) => `${violation.id} (${violation.impact}, ${violation.nodes.length})`);
    return { blocking, total: result.violations.length };
  } catch (error) {
    return { blocking: [`axe-failed: ${error instanceof Error ? error.name : 'unknown'}`], total: -1 };
  }
}

function finish(
  testInfo: TestInfo,
  role: QaRole,
  route: string,
  routeResult: RouteCoverageResult,
  recorder: Recorder,
): void {
  const record: RouteRecordFile = {
    runId: RUN_ID,
    role,
    route,
    recordedAt: new Date().toISOString(),
    routeResult,
    components: recorder.components,
    states: recorder.states,
    observations: recorder.observations,
  };
  writeRouteRecord(qa.artifactRoot, record);
  testInfo.annotations.push({ type: 'coverage-status', description: `${route}: ${routeResult.status}` });
}

for (const row of routeMatrix.rows) {
  const manifestRoute = manifest.routes.find((entry) => entry.route === row.route);

  test(`coverage ${row.route}`, async ({ page, qaRole, monitors }, testInfo) => {
    const cell = row.cells[qaRole];
    const recorder = new Recorder(qaRole, row.route);
    const applicableStates = (manifestRoute?.knownStates ?? []) as CoverageState[];
    const evidence: string[] = [];
    const timings: Record<string, number> = {};

    expect(cell, `role-route matrix must contain a cell for ${qaRole} on ${row.route}`).toBeTruthy();
    const verdict = cell!.verdict;

    /* ------------------------------------------------------ routes outside the role model */
    if (verdict === 'NOT_APPLICABLE') {
      const started = Date.now();
      await page.goto(row.route).catch(() => undefined);
      timings.navigation = Date.now() - started;
      const landed = pathOf(page);
      const rendered = landed === row.route;
      if (rendered) {
        recorder.observe(
          'תפקיד דייר הגיע למסלול פלטפורמה',
          `${qaRole} נשאר על ${row.route} במקום להיות מופנה. PlatformGuard אמור להפנות תפקיד ללא הרשאת פלטפורמה.`,
          'authorization',
          'high',
          [await screenshot(page, testInfo, `platform-${qaRole}`)],
        );
      }
      recorder.state('permission_denied', rendered ? 'NOT_OBSERVED' : 'OBSERVED', rendered
        ? 'המסלול רונדר לתפקיד דייר.'
        : `הופנה אל ${landed}.`);
      recorder.fillUnobservedStates(applicableStates, 'מסלול מחוץ למודל תפקידי הדייר — מצבי המסך אינם ישימים לתפקיד זה.');
      finish(testInfo, qaRole, row.route, {
        ...emptyRouteResult(qaRole, row.route, verdict, rendered ? 'FAILED' : 'NOT_APPLICABLE', rendered
          ? 'מסלול הפלטפורמה רונדר לתפקיד דייר.'
          : 'מסלול קונסולת פלטפורמה — מחוץ למודל תפקידי הדייר, והתפקיד הופנה החוצה כצפוי.'),
        navigationVisible: cell!.navigationVisible,
        directAccessOutcome: rendered ? 'RENDERED' : 'REDIRECTED',
        landedPath: landed,
        protectedContentRendered: rendered,
        timingsMs: timings,
        consoleErrors: monitors.console.blockingIssues().slice(0, 10),
        evidence,
      }, recorder);
      return;
    }

    /* -------------------------------------------------------------- redirects and public */
    if (verdict === 'CONDITIONAL_ACCESS') {
      const started = Date.now();
      await page.goto(row.route).catch(() => undefined);
      timings.navigation = Date.now() - started;
      await page.waitForLoadState('networkidle').catch(() => undefined);
      const landed = pathOf(page);
      const redirected = landed !== row.route;
      evidence.push(await screenshot(page, testInfo, `conditional-${qaRole}`));
      recorder.state('loading', 'OBSERVED', `הניווט הושלם ונחת על ${landed}.`);
      recorder.fillUnobservedStates(
        applicableStates,
        'מסלול מותנה: אינו מרנדר מסך עצמאי לתפקיד, ולכן מצבי המסך נמדדים ביעד ההפניה.',
      );
      finish(testInfo, qaRole, row.route, {
        ...emptyRouteResult(qaRole, row.route, verdict, 'PASSED',
          redirected
            ? `המסלול הפנה אל ${landed}, בהתאם להיותו הפניה או מסך ציבורי.`
            : `המסלול רונדר במקום (${landed}) — מסך ציבורי שאינו מוגן ב-guard.`),
        navigationVisible: cell!.navigationVisible,
        directAccessOutcome: redirected ? 'REDIRECTED' : 'RENDERED',
        landedPath: landed,
        timingsMs: timings,
        consoleErrors: monitors.console.blockingIssues().slice(0, 10),
        evidence,
      }, recorder);
      return;
    }

    /* ------------------------------------------------------------------ expected denial */
    if (verdict === 'EXPECTED_DENIAL' || verdict === 'UNKNOWN_REQUIRES_REVIEW') {
      const target = row.route.includes(':') ? row.route.replace(/:[A-Za-z0-9_]+/g, '00000000-0000-4000-8000-000000000000') : row.route;
      const started = Date.now();
      await page.goto(target).catch(() => undefined);
      timings.navigation = Date.now() - started;

      // The leak question is about the moment before the redirect settles, so it is asked
      // immediately rather than after networkidle.
      const immediate = await page.evaluate(() => ({
        heading: document.querySelector('#main h1')?.textContent?.trim() ?? '',
        path: window.location.pathname,
      }));
      await page.waitForLoadState('networkidle').catch(() => undefined);
      const landed = pathOf(page);
      const leaked = immediate.path === target && immediate.heading !== '' && !immediate.heading.includes('מרכז הבקרה');
      const redirectedHome = landed === HOME;
      evidence.push(await screenshot(page, testInfo, `denied-${qaRole}`));

      if (leaked) {
        recorder.observe(
          'תוכן מוגן הוצג לרגע לפני ההפניה',
          `בכניסה ישירה ל-${target} נצפתה כותרת "${immediate.heading}" לפני שההפניה הושלמה.`,
          'authorization',
          'medium',
          evidence,
        );
      }
      if (!redirectedHome) {
        recorder.observe(
          'הפניה שאינה לבית התפקיד',
          `כניסה ישירה ל-${target} הסתיימה ב-${landed} ולא ב-${HOME}.`,
          'authorization',
          landed === target ? 'high' : 'medium',
          evidence,
        );
      }

      // A hidden screen is not an authorization boundary. Ask the API the same question with the
      // role's own token: if the server answers, the boundary is cosmetic.
      const probeTargets = [
        ...new Set(
          (manifestRoute?.knownActions ?? [])
            .flatMap((action) => action.backend)
            .filter((entry) => entry.startsWith('table:'))
            .map((entry) => entry.slice('table:'.length)),
        ),
      ].slice(0, 4);
      const probes: string[] = [];
      for (const table of probeTargets) {
        const probe = await probeServerAccess(page, qa.supabaseUrl, qa.supabaseAnonKey, table);
        probes.push(`${probe.endpoint} → ${probe.status}${probe.rows === null ? '' : ` (${probe.rows} שורות)`}`);
        if (probe.status >= 200 && probe.status < 300 && (probe.rows ?? 0) > 0) {
          recorder.observe(
            'המסך חסום אך השרת מחזיר נתונים',
            `${qaRole} אינו רשאי להגיע ל-${row.route}, אך ${probe.endpoint} החזיר ${probe.status} עם ${probe.rows} שורות. הסתרה בצד לקוח אינה גבול הרשאה.`,
            'authorization',
            'high',
            evidence,
          );
        }
      }
      if (probes.length) evidence.push(`server-probes: ${probes.join(' | ')}`);

      if (cell!.navigationVisible) {
        recorder.observe(
          'פריט ניווט מוצג לתפקיד חסום',
          `${row.route} מופיע בניווט עבור ${qaRole} למרות ש-App.tsx חוסם אותו.`,
          'authorization',
          'medium',
        );
      }

      recorder.state('permission_denied', redirectedHome ? 'OBSERVED' : 'NOT_OBSERVED',
        redirectedHome ? `הופנה אל ${HOME} כצפוי.` : `הסתיים ב-${landed}.`);
      recorder.fillUnobservedStates(applicableStates, 'התפקיד אינו רשאי לראות את המסך, ולכן מצבי המסך אינם ישימים עבורו.');

      finish(testInfo, qaRole, row.route, {
        ...emptyRouteResult(qaRole, row.route, verdict,
          redirectedHome && !leaked ? 'PASSED' : 'FAILED',
          redirectedHome && !leaked
            ? 'כניסה ישירה נחסמה והופנתה לבית התפקיד ללא דליפת תוכן.'
            : 'החסימה אינה מתנהגת כצפוי — ראה תצפיות.'),
        navigationVisible: cell!.navigationVisible,
        directAccessOutcome: redirectedHome ? 'REDIRECTED' : landed === target ? 'RENDERED' : 'ERROR',
        landedPath: landed,
        protectedContentRendered: landed === target,
        informationLeakBeforeRedirect: leaked,
        timingsMs: timings,
        consoleErrors: monitors.console.blockingIssues().slice(0, 10),
        failedRequests: monitors.network.blockingIssues().slice(0, 10),
        evidence,
      }, recorder);
      return;
    }

    /* ------------------------------------------------------------------ expected access */
    const concrete = await resolveConcreteRoute(page, row.route);
    if (!concrete) {
      recorder.fillUnobservedStates(applicableStates, 'לא נמצאה רשומת דוגמה להרכבת המסלול, ולכן המסך לא נבדק.');
      finish(testInfo, qaRole, row.route, emptyRouteResult(qaRole, row.route, verdict, 'BLOCKED',
        `מסלול פרמטרי: לא נמצא מזהה דוגמה דרך מסך הרשימה ${row.route.slice(0, row.route.indexOf('/:'))}. לא הומצא מזהה.`),
        recorder);
      return;
    }

    const started = Date.now();
    await page.goto(concrete).catch(() => undefined);
    timings.navigation = Date.now() - started;
    await page.waitForLoadState('networkidle').catch(() => undefined);
    timings.networkIdle = Date.now() - started;
    const landed = pathOf(page);

    if (landed !== concrete) {
      recorder.observe(
        'מסלול מותר הפנה את המשתמש',
        `${qaRole} אמור לגשת ל-${concrete} לפי App.tsx, אך נחת על ${landed}.`,
        'authorization',
        'high',
        [await screenshot(page, testInfo, `unexpected-denial-${qaRole}`)],
      );
      recorder.fillUnobservedStates(applicableStates, 'המסך לא רונדר, ולכן אין מצבים למדוד.');
      finish(testInfo, qaRole, row.route, {
        ...emptyRouteResult(qaRole, row.route, verdict, 'FAILED', 'מסלול מותר לא רונדר עבור התפקיד.'),
        navigationVisible: cell!.navigationVisible,
        directAccessOutcome: 'REDIRECTED',
        landedPath: landed,
        protectedContentRendered: false,
        timingsMs: timings,
        consoleErrors: monitors.console.blockingIssues().slice(0, 10),
      }, recorder);
      return;
    }

    /* ---------------------------------------------------------- inventory reconciliation */
    await page.setViewportSize({ width: 1440, height: 900 });
    const snapshot = await snapshotControls(page);
    evidence.push(await screenshot(page, testInfo, `desktop-${qaRole}`));

    if (snapshot.truncated) {
      recorder.observe(
        'מספר הבקרות במסך חרג מתקרת הסריקה',
        `נסרקו 400 בקרות והמסך מכיל יותר. הכיסוי של המסך הזה חלקי ומוצהר ככזה.`,
        'coverage_gap',
        'info',
      );
    }

    const manifestControls = (manifestRoute?.majorSections ?? []).flatMap((section) =>
      section.controls.map((control) => ({ section: section.id, control })),
    );
    const matchedRuntimeKeys = new Set<string>();

    for (const { section, control } of manifestControls) {
      const match = findRuntimeMatch(snapshot.controls, control.accessibleName);
      if (match) matchedRuntimeKeys.add(match.key);
      recorder.component({
        section,
        controlId: control.id,
        visibleLabel: control.visibleLabel,
        accessibleName: match?.accessibleName ?? control.accessibleName,
        semanticRole: match?.semanticRole,
        expectedAvailability: control.expectedRoles.includes(qaRole),
        actualAvailability: Boolean(match?.visible),
        interactionAttempted: false,
        interactionResult: match ? (match.visible ? 'PASSED' : 'NOT_RENDERED') : 'NOT_RENDERED',
        persistenceChecked: false,
        authorizationChecked: true,
        accessibilityChecked: true,
        evidence,
        findingIds: [],
        note: match
          ? undefined
          : 'הבקרה נמצאה בניתוח הסטטי אך לא אותרה במסך. ייתכן ענף תלוי-נתונים, דיאלוג סגור או שינוי תווית.',
      });
    }

    // Controls the parser never saw. These are the ones a source-only inventory would miss, and
    // they are the reason the manifest is not allowed to be the last word.
    for (const control of snapshot.controls) {
      if (matchedRuntimeKeys.has(control.key)) continue;
      if (!control.visible) continue;
      recorder.component({
        section: 'runtime-only',
        controlId: `runtime:${control.key}`,
        visibleLabel: control.visibleLabel || undefined,
        accessibleName: control.accessibleName || undefined,
        semanticRole: control.semanticRole,
        expectedAvailability: true,
        actualAvailability: true,
        interactionAttempted: false,
        interactionResult: 'PASSED',
        persistenceChecked: false,
        authorizationChecked: false,
        accessibilityChecked: true,
        evidence: [],
        findingIds: [],
        note: 'נתגלתה בזמן ריצה בלבד ואינה במניפסט הסטטי.',
      });
      if (!control.accessibleName) {
        recorder.observe(
          'בקרה ללא שם נגיש',
          `${control.semanticRole}/${control.tag} ללא aria-label, תווית או טקסט — לא ניתן להפעיל אותה בזיהוי סמנטי.`,
          'accessibility',
          'medium',
        );
      }
    }

    /* --------------------------------------------------------------------- data states */
    const emptyMarker = await page
      .getByText(/אין .{0,40}(להצגה|עדיין|כרגע|תואמ)/)
      .first()
      .isVisible()
      .catch(() => false);
    const rowCount = await page.locator('table tbody tr').count().catch(() => 0);
    if (emptyMarker) recorder.state('empty', 'OBSERVED', 'מצב ריק מוצג במסך.');
    if (rowCount > 0) recorder.state('populated', 'OBSERVED', `${rowCount} שורות בטבלה.`);
    if (rowCount > 30) recorder.state('large_table', 'OBSERVED', `${rowCount} שורות מוצגות בעמוד אחד.`);
    // The screen finished loading before the snapshot, which says nothing about what the user saw
    // while it loaded. Claiming the loading state was covered here would be a claim about a frame
    // nobody looked at.
    recorder.state('loading', 'NOT_OBSERVED', 'מצב הביניים של הטעינה לא נלכד: הסריקה מתחילה אחרי networkidle.');

    /* --------------------------------------------------------- search, filter, dialogs */
    let steps = 0;
    const searchBox = snapshot.controls.find(
      (control) => control.semanticRole === 'searchbox' || (control.inputType === 'search') || /חיפוש/.test(control.accessibleName),
    );
    // A control with no accessible name cannot be addressed semantically: getByLabel('') matches
    // everything. It is already recorded as an accessibility finding above; here it is skipped.
    if (searchBox?.accessibleName && steps < MAX_STEPS_PER_ROUTE) {
      steps += 1;
      const locator = page.getByRole('searchbox', { name: searchBox.accessibleName }).first();
      const target = (await locator.count()) ? locator : page.getByLabel(searchBox.accessibleName).first();
      const filled = await target.fill('זזזזזזזז').then(() => true).catch(() => false);
      if (filled) {
        await page.waitForTimeout(400);
        const after = await page.locator('table tbody tr').count().catch(() => 0);
        const noResults = after === 0 || (await page.getByText(/אין .{0,40}(תואמ|תוצא)/).first().isVisible().catch(() => false));
        recorder.state('no_search_results', noResults ? 'OBSERVED' : 'NOT_OBSERVED',
          noResults ? 'חיפוש ללא התאמות הציג מצב ריק.' : `חיפוש ללא התאמות עדיין הציג ${after} שורות.`);
        if (!noResults && rowCount > 0) {
          recorder.observe('חיפוש לא סינן', `חיפוש מחרוזת שאינה קיימת השאיר ${after} שורות במסך.`, 'functional', 'medium');
        }
        await target.fill('').catch(() => undefined);
        recorder.component({
          section: 'runtime-only',
          controlId: `interaction:search`,
          accessibleName: searchBox.accessibleName,
          semanticRole: searchBox.semanticRole,
          expectedAvailability: true,
          actualAvailability: true,
          interactionAttempted: true,
          interactionResult: filled ? 'PASSED' : 'BLOCKED',
          persistenceChecked: false,
          authorizationChecked: false,
          accessibilityChecked: true,
          evidence: [],
          findingIds: [],
        });
      }
    }

    const filterControl = snapshot.controls.find(
      (control) => control.tag === 'select' && control.visible && !control.disabled && control.accessibleName !== '',
    );
    if (filterControl && steps < MAX_STEPS_PER_ROUTE) {
      steps += 1;
      const locator = page.getByLabel(filterControl.accessibleName).first();
      const options = await locator.locator('option').count().catch(() => 0);
      if (options > 1) {
        const changed = await locator
          .selectOption({ index: 1 })
          .then(() => true)
          .catch(() => false);
        if (changed) {
          await page.waitForTimeout(400);
          recorder.state('filtered_results', 'OBSERVED', `מסנן "${filterControl.accessibleName}" הוחל.`);
        }
        recorder.component({
          section: 'runtime-only',
          controlId: 'interaction:filter',
          accessibleName: filterControl.accessibleName,
          semanticRole: filterControl.semanticRole,
          expectedAvailability: true,
          actualAvailability: true,
          interactionAttempted: true,
          interactionResult: changed ? 'PASSED' : 'BLOCKED',
          persistenceChecked: false,
          authorizationChecked: false,
          accessibilityChecked: true,
          evidence: [],
          findingIds: [],
        });
      }
    }

    const dialogOpener = snapshot.controls.find(
      (control) =>
        control.semanticRole === 'button' &&
        control.visible &&
        !control.disabled &&
        isSafeToClick(control, false, false) &&
        /פרטים|הצג|תצוגה|עריכת פרטים|בחירת/.test(control.accessibleName),
    );
    if (dialogOpener && steps < MAX_STEPS_PER_ROUTE) {
      steps += 1;
      const opened = await page
        .getByRole('button', { name: dialogOpener.accessibleName, exact: true })
        .first()
        .click({ timeout: 5_000 })
        .then(() => true)
        .catch(() => false);
      if (opened) {
        await page.waitForTimeout(300);
        const dialog = await inspectOpenDialog(page);
        if (dialog.present) {
          recorder.state('dialog_open', 'OBSERVED', `הדיאלוג נפתח מ-"${dialogOpener.accessibleName}".`);
          if (!dialog.focusInsideDialog) {
            recorder.observe('מיקוד לא עבר לדיאלוג', `לאחר פתיחת "${dialogOpener.accessibleName}" המיקוד נשאר מחוץ לדיאלוג.`, 'accessibility', 'medium');
          }
          if (!dialog.hasAccessibleName) {
            recorder.observe('דיאלוג ללא שם נגיש', `הדיאלוג שנפתח מ-"${dialogOpener.accessibleName}" חסר aria-label או aria-labelledby.`, 'accessibility', 'medium');
          }
          if (!dialog.hasCloseControl) {
            recorder.observe('דיאלוג ללא בקרת סגירה גלויה', `לדיאלוג אין כפתור סגירה/ביטול מזוהה.`, 'usability', 'low');
          }
          await page.keyboard.press('Escape');
          await page.waitForTimeout(250);
          const afterEscape = await inspectOpenDialog(page);
          recorder.state('dialog_closed', afterEscape.present ? 'NOT_OBSERVED' : 'OBSERVED',
            afterEscape.present ? 'Escape לא סגר את הדיאלוג.' : 'Escape סגר את הדיאלוג.');
          if (afterEscape.present) {
            recorder.observe('Escape אינו סוגר דיאלוג', `הדיאלוג נשאר פתוח אחרי Escape.`, 'accessibility', 'medium');
          }
        }
      }
    }

    /* ------------------------------------------------------------------ form inspection */
    if (snapshot.formCount > 0) {
      const requiredFields = snapshot.controls.filter((control) => control.required);
      const unlabelled = snapshot.controls.filter(
        (control) => ['textbox', 'combobox', 'checkbox', 'radio', 'searchbox'].includes(control.semanticRole) && !control.accessibleName,
      );
      if (unlabelled.length) {
        recorder.observe(
          'שדות טופס ללא שם נגיש',
          `${unlabelled.length} שדות ללא תווית מקושרת: ${unlabelled.map((field) => field.tag).join(', ')}.`,
          'accessibility',
          'high',
        );
      }
      recorder.state('validation_error', requiredFields.length ? 'NOT_OBSERVED' : 'NOT_APPLICABLE',
        requiredFields.length
          ? 'הגשה שגויה לא בוצעה בהילוך הכיסוי: היא מייצרת mutation על מצב משותף ושייכת לסוויטת תרחישי הליבה.'
          : 'לא נמצאו שדות חובה במסך.');
    }

    /* --------------------------------------------------------------------- persistence */
    const beforeRefresh = snapshot.controls.filter((control) => control.visible).length;
    await page.reload().catch(() => undefined);
    await page.waitForLoadState('networkidle').catch(() => undefined);
    const refreshed = await snapshotControls(page);
    const afterRefresh = refreshed.controls.filter((control) => control.visible).length;
    const refreshStable = pathOf(page) === concrete && afterRefresh > 0;
    if (!refreshStable) {
      recorder.observe(
        'המסך אינו יציב אחרי רענון',
        `אחרי רענון המסלול הוא ${pathOf(page)} עם ${afterRefresh} בקרות גלויות (לפני: ${beforeRefresh}).`,
        'functional',
        'high',
        [await screenshot(page, testInfo, `refresh-${qaRole}`)],
      );
    }

    /* ------------------------------------------------------------------- accessibility */
    const axe = await runAxe(page, testInfo, `${qaRole}-${row.route.replace(/\W+/g, '-')}`);
    if (axe.blocking.length) {
      recorder.observe('הפרות Axe חוסמות', `Axe דיווח: ${axe.blocking.join(', ')}.`, 'accessibility', 'high', evidence);
    }
    const semantics = await inspectSemantics(page);
    if (semantics.h1Count !== 1) {
      recorder.observe('מספר כותרות h1 אינו 1', `נמצאו ${semantics.h1Count} כותרות h1.`, 'accessibility', 'low');
    }
    if (semantics.headingOrderJumps.length) {
      recorder.observe('קפיצה בסדר הכותרות', semantics.headingOrderJumps.join(' | '), 'accessibility', 'low');
    }
    if (semantics.tablesWithoutHeaders > 0) {
      recorder.observe('טבלה ללא כותרות עמודה', `${semantics.tablesWithoutHeaders} טבלאות ללא th.`, 'accessibility', 'medium');
    }
    if (semantics.fieldsWithoutNames.length) {
      recorder.observe('שדות ללא שם נגיש', semantics.fieldsWithoutNames.join(', '), 'accessibility', 'high');
    }

    // Keyboard entry: the shell must be skippable or the route must take focus itself.
    await page.keyboard.press('Tab');
    const focusVisible = await page.evaluate(() => {
      const active = document.activeElement;
      if (!active || active === document.body) return false;
      const style = window.getComputedStyle(active);
      return style.outlineStyle !== 'none' || style.boxShadow !== 'none' || active.matches(':focus-visible');
    });
    if (!focusVisible) {
      recorder.observe('אין חיווי מיקוד גלוי לאחר Tab', 'הפריט הראשון שקיבל מיקוד אינו מציג outline או box-shadow.', 'accessibility', 'medium');
    }

    /* ----------------------------------------------------------------------- responsive */
    const responsive: string[] = [];
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.waitForTimeout(250);
      const overflow = await measureOverflow(page);
      responsive.push(`${viewport.name}: ${overflow.overflow ? `גלישה ${overflow.scrollWidth - overflow.clientWidth}px` : 'ללא גלישה'}`);
      if (overflow.overflow) {
        recorder.observe(
          'גלישה אופקית',
          `ב-${viewport.name} (${viewport.width}px) רוחב הגלילה ${overflow.scrollWidth} מול ${overflow.clientWidth}.`,
          'visual',
          viewport.name === 'mobile' ? 'medium' : 'low',
          [await screenshot(page, testInfo, `${viewport.name}-overflow-${qaRole}`)],
        );
      }
      if (viewport.name !== 'desktop') evidence.push(await screenshot(page, testInfo, `${viewport.name}-${qaRole}`));
      if (viewport.name === 'mobile') {
        const undersized = await undersizedTouchTargets(page, 40);
        if (undersized.length) {
          recorder.observe(
            'יעדי מגע קטנים מ-40px',
            `${undersized.length} בקרות: ${undersized.slice(0, 8).join(', ')}.`,
            'visual',
            qaRole === 'kitchen' ? 'high' : 'low',
          );
        }
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    evidence.push(`responsive: ${responsive.join(' | ')}`);

    /* ---------------------------------------------------------------- discoverability */
    if (!cell!.navigationVisible && !row.route.includes(':') && row.route !== HOME) {
      recorder.observe(
        'מסלול נגיש שאינו מופיע בניווט',
        `${qaRole} רשאי לגשת ל-${row.route}, אך הפריט אינו מופיע בסרגל הניווט. הגישה מחייבת קישור הקשרי או הקלדת כתובת.`,
        'discoverability',
        'info',
      );
    }

    const consoleIssues = monitors.console.blockingIssues();
    const networkIssues = monitors.network.blockingIssues();
    if (consoleIssues.length) {
      recorder.observe('שגיאות console', consoleIssues.slice(0, 5).join(' | '), 'console', 'medium', evidence);
    }
    if (networkIssues.length) {
      recorder.observe('בקשות רשת שנכשלו', networkIssues.slice(0, 5).join(' | '), 'network', 'medium', evidence);
    }

    recorder.fillUnobservedStates(
      applicableStates,
      'המצב לא נצפה בהילוך הכיסוי. הוא לא סומן ככוסה ולא הופק בכוח כדי לא לשנות מצב משותף.',
    );

    const failed = recorder.observations.some((observation) => observation.severityHint === 'high');
    finish(testInfo, qaRole, row.route, {
      ...emptyRouteResult(qaRole, row.route, verdict, failed ? 'FAILED' : 'PASSED',
        failed ? 'המסך נסרק במלואו ונמצאו ממצאים בחומרה גבוהה.' : 'המסך נסרק: בקרות, מצבים, נגישות ורספונסיביות.'),
      navigationVisible: cell!.navigationVisible,
      directAccessOutcome: 'RENDERED',
      landedPath: landed,
      protectedContentRendered: true,
      dataReturned: rowCount > 0 || !emptyMarker,
      refreshStable,
      informationLeakBeforeRedirect: false,
      consoleErrors: consoleIssues.slice(0, 10),
      failedRequests: networkIssues.slice(0, 10),
      timingsMs: { ...timings, axeViolations: axe.total },
      evidence,
    }, recorder);
  });
}
