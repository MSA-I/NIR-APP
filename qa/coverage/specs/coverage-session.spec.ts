import { test as base, expect, type Page } from '@playwright/test';
import { ConsoleMonitor } from '../../browser/console-monitor.ts';
import { NetworkMonitor } from '../../browser/network-monitor.ts';
import { sensitiveScreenshotMasks } from '../../browser/redaction.ts';
import { createQaConfig } from '../../config/qa.config.ts';
import { QA_ROLES, type QaRole } from '../../config/roles.ts';
import { emptyRouteResult, writeRouteRecord, type CoverageObservation } from '../record-store.ts';
import { measureOverflow, snapshotControls } from '../runtime.ts';
import type { ComponentCoverageResult, StateCoverageRecord } from '../types.ts';

/**
 * Cross-route coverage: the states and journeys that do not belong to any single screen.
 *
 * Session loss, a failed API and browser navigation are conditions the whole shell has to survive,
 * so they are measured once per role against the role's home rather than repeated on every route.
 * Each one writes its own pseudo-route record so the summary can show it was actually exercised
 * instead of implying it from a green run.
 */

const qa = createQaConfig();
const RUN_ID = process.env.QA_RUN_ID?.trim() || 'coverage-walk';
const HOME = '/dashboard';

function roleFromCoverageProject(projectName: string): QaRole {
  const value = projectName.replace(/^coverage-/, '');
  if (!(QA_ROLES as readonly string[]).includes(value)) {
    throw new Error(`Coverage project does not identify a QA role: ${projectName}`);
  }
  return value as QaRole;
}

const test = base.extend<{ qaRole: QaRole; monitors: { console: ConsoleMonitor; network: NetworkMonitor } }>({
  qaRole: async ({}, use, testInfo) => {
    await use(roleFromCoverageProject(testInfo.project.name));
  },
  monitors: async ({ page }, use) => {
    const monitors = { console: new ConsoleMonitor(page), network: new NetworkMonitor(page) };
    await use(monitors);
    monitors.console.stop();
    monitors.network.stop();
  },
});

function pathOf(page: Page): string {
  try {
    return new URL(page.url()).pathname;
  } catch {
    return 'unavailable';
  }
}

interface PseudoRoute {
  readonly route: string;
  readonly states: StateCoverageRecord[];
  readonly observations: CoverageObservation[];
  readonly components: ComponentCoverageResult[];
  readonly evidence: string[];
}

function write(role: QaRole, pseudo: PseudoRoute, status: 'PASSED' | 'FAILED' | 'BLOCKED', rationale: string): void {
  writeRouteRecord(qa.artifactRoot, {
    runId: RUN_ID,
    role,
    route: pseudo.route,
    recordedAt: new Date().toISOString(),
    routeResult: {
      ...emptyRouteResult(role, pseudo.route, 'EXPECTED_ACCESS', status, rationale),
      directAccessOutcome: 'RENDERED',
      evidence: pseudo.evidence,
    },
    components: pseudo.components,
    states: pseudo.states,
    observations: pseudo.observations,
  });
}

test('session expiry is handled without a silent blank screen', async ({ page, qaRole }, testInfo) => {
  const pseudo: PseudoRoute = { route: '__session-expiry__', states: [], observations: [], components: [], evidence: [] };
  await page.goto(HOME);
  await page.waitForLoadState('networkidle').catch(() => undefined);

  // Clearing the stored session is the closest safe analogue of an expired token: it removes the
  // client's credential without touching the server, so no other role's fixtures are disturbed.
  await page.evaluate(() => {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith('sb-')) window.localStorage.removeItem(key);
    }
  });
  await page.reload().catch(() => undefined);
  await page.waitForLoadState('networkidle').catch(() => undefined);

  const landed = pathOf(page);
  const bodyText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 400));
  const name = `session-expiry-${qaRole}.png`;
  await page
    .screenshot({ path: testInfo.outputPath(name), fullPage: true, mask: [...sensitiveScreenshotMasks(page)] })
    .catch(() => undefined);
  pseudo.evidence.push(name);

  const reachedLogin = landed === '/login';
  const explained = bodyText.length > 0;
  pseudo.states.push({
    runId: RUN_ID,
    role: qaRole,
    route: pseudo.route,
    state: 'expired_session',
    status: reachedLogin || explained ? 'OBSERVED' : 'NOT_OBSERVED',
    rationale: reachedLogin
      ? 'איבוד הסשן הפנה למסך הכניסה.'
      : explained
        ? `הסשן אבד והמסך הציג טקסט: "${bodyText.slice(0, 80)}".`
        : 'הסשן אבד והמסך נשאר ריק.',
    evidence: pseudo.evidence,
  });
  if (!reachedLogin && !explained) {
    pseudo.observations.push({
      id: `${qaRole}:session:1`,
      title: 'איבוד סשן מוביל למסך ריק',
      detail: `אחרי הסרת הסשן המסלול הוא ${landed} ואין טקסט על המסך.`,
      category: 'functional',
      severityHint: 'high',
      evidence: pseudo.evidence,
    });
  }
  write(qaRole, pseudo, reachedLogin || explained ? 'PASSED' : 'FAILED', 'התנהגות המערכת באיבוד סשן.');
  expect(landed).not.toBe('unavailable');
});

test('a failing API leaves an explained screen rather than a stalled one', async ({ page, qaRole }, testInfo) => {
  const pseudo: PseudoRoute = { route: '__failed-request__', states: [], observations: [], components: [], evidence: [] };

  // Aborting in the browser only. Nothing is sent to Supabase, so no shared state can change.
  await page.route('**/rest/v1/**', (route) => route.abort('failed'));
  await page.goto(HOME).catch(() => undefined);
  await page.waitForTimeout(2_500);

  const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
  const name = `failed-request-${qaRole}.png`;
  await page
    .screenshot({ path: testInfo.outputPath(name), fullPage: true, mask: [...sensitiveScreenshotMasks(page)] })
    .catch(() => undefined);
  pseudo.evidence.push(name);
  await page.unroute('**/rest/v1/**');

  const stillSpinning = await page.locator('[role="status"], .animate-pulse').count().catch(() => 0);
  const explained = /שגיא|תקלה|לא ניתן|נסה|ניסיון/.test(text);
  pseudo.states.push({
    runId: RUN_ID,
    role: qaRole,
    route: pseudo.route,
    state: 'offline_or_failed_request',
    status: 'OBSERVED',
    rationale: explained
      ? 'כשל רשת הציג הודעה מוסברת.'
      : `כשל רשת לא הציג הודעה מוסברת; ${stillSpinning} אלמנטים עדיין במצב טעינה.`,
    evidence: pseudo.evidence,
  });
  pseudo.states.push({
    runId: RUN_ID,
    role: qaRole,
    route: pseudo.route,
    state: 'server_error',
    status: 'OBSERVED',
    rationale: 'הבקשות ל-REST הופלו בדפדפן בלבד; התגובה של המסך נמדדה.',
    evidence: pseudo.evidence,
  });
  if (!explained && stillSpinning > 0) {
    pseudo.observations.push({
      id: `${qaRole}:failed-request:1`,
      title: 'טעינה תקועה בכשל רשת',
      detail: `אחרי הפלת קריאות ה-REST נשארו ${stillSpinning} מחווני טעינה ואין הודעת שגיאה.`,
      category: 'functional',
      severityHint: 'medium',
      evidence: pseudo.evidence,
    });
  }
  write(qaRole, pseudo, 'PASSED', 'התנהגות המסך תחת כשל רשת מדומה בדפדפן.');
});

test('navigation, history and unknown identifiers behave', async ({ page, qaRole }, testInfo) => {
  const pseudo: PseudoRoute = { route: '__navigation__', states: [], observations: [], components: [], evidence: [] };
  await page.goto(HOME);
  await page.waitForLoadState('networkidle').catch(() => undefined);

  const navLinks = await page.evaluate(() =>
    [...document.querySelectorAll('nav a[href]')].map((anchor) => ({
      href: anchor.getAttribute('href') ?? '',
      label: (anchor.textContent ?? '').replace(/\s+/g, ' ').trim(),
    })),
  );
  pseudo.components.push({
    runId: RUN_ID,
    role: qaRole,
    route: pseudo.route,
    section: 'sidebar',
    controlId: 'nav:sidebar',
    accessibleName: 'סרגל ניווט',
    semanticRole: 'navigation',
    expectedAvailability: true,
    actualAvailability: navLinks.length > 0,
    interactionAttempted: false,
    interactionResult: navLinks.length > 0 ? 'PASSED' : 'NOT_RENDERED',
    persistenceChecked: false,
    authorizationChecked: true,
    accessibilityChecked: true,
    evidence: [],
    findingIds: [],
    note: `${navLinks.length} פריטי ניווט: ${navLinks.map((item) => item.label).filter(Boolean).join(', ')}`,
  });

  // Every sidebar link must actually land where it says, for this role.
  for (const link of navLinks.slice(0, 25)) {
    if (!link.href.startsWith('/')) continue;
    await page.goto(link.href).catch(() => undefined);
    const landed = pathOf(page);
    const ok = landed === link.href;
    pseudo.components.push({
      runId: RUN_ID,
      role: qaRole,
      route: pseudo.route,
      section: 'sidebar',
      controlId: `nav:${link.href}`,
      visibleLabel: link.label,
      accessibleName: link.label,
      semanticRole: 'link',
      expectedAvailability: true,
      actualAvailability: true,
      interactionAttempted: true,
      interactionResult: ok ? 'PASSED' : 'FAILED',
      persistenceChecked: false,
      authorizationChecked: true,
      accessibilityChecked: false,
      evidence: [],
      findingIds: [],
      note: ok ? undefined : `הקישור מוצג אך נחת על ${landed}.`,
    });
    if (!ok) {
      pseudo.observations.push({
        id: `${qaRole}:nav:${link.href}`,
        title: 'פריט ניווט שאינו מוביל ליעדו',
        detail: `"${link.label}" מפנה ל-${link.href} אך המשתמש נחת על ${landed}.`,
        category: 'authorization',
        severityHint: 'high',
        evidence: [],
      });
    }
  }

  // Mobile drawer: on the kitchen viewport the whole navigation lives behind one button.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(HOME).catch(() => undefined);
  const menuButton = page.getByRole('button', { name: 'פתיחת תפריט', exact: true });
  const drawerOpens = await menuButton
    .click({ timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  await page.waitForTimeout(300);
  const drawerLinks = drawerOpens ? await page.locator('nav a[href]:visible').count().catch(() => 0) : 0;
  const overflow = await measureOverflow(page);
  const mobileShot = `navigation-mobile-${qaRole}.png`;
  await page
    .screenshot({ path: testInfo.outputPath(mobileShot), fullPage: true, mask: [...sensitiveScreenshotMasks(page)] })
    .catch(() => undefined);
  pseudo.evidence.push(mobileShot);
  pseudo.components.push({
    runId: RUN_ID,
    role: qaRole,
    route: pseudo.route,
    section: 'mobile-drawer',
    controlId: 'nav:mobile-drawer',
    accessibleName: 'פתיחת תפריט',
    semanticRole: 'button',
    expectedAvailability: true,
    actualAvailability: drawerOpens,
    interactionAttempted: true,
    interactionResult: drawerOpens && drawerLinks > 0 ? 'PASSED' : drawerOpens ? 'FAILED' : 'NOT_RENDERED',
    persistenceChecked: false,
    authorizationChecked: false,
    accessibilityChecked: true,
    evidence: [mobileShot],
    findingIds: [],
    note: `${drawerLinks} קישורים גלויים במגירה`,
  });
  if (overflow.overflow) {
    pseudo.observations.push({
      id: `${qaRole}:nav:overflow`,
      title: 'גלישה אופקית במובייל',
      detail: `ב-390px רוחב הגלילה ${overflow.scrollWidth} מול ${overflow.clientWidth}.`,
      category: 'visual',
      severityHint: qaRole === 'kitchen' ? 'high' : 'low',
      evidence: [mobileShot],
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // Browser history has to work: a user who presses Back must not end on a broken shell.
  await page.goto(HOME);
  const second = navLinks.find((link) => link.href.startsWith('/') && link.href !== HOME)?.href;
  if (second) {
    await page.goto(second).catch(() => undefined);
    await page.goBack().catch(() => undefined);
    await page.waitForLoadState('networkidle').catch(() => undefined);
    const backPath = pathOf(page);
    await page.goForward().catch(() => undefined);
    await page.waitForLoadState('networkidle').catch(() => undefined);
    const forwardPath = pathOf(page);
    const historyOk = backPath === HOME && forwardPath === second;
    pseudo.components.push({
      runId: RUN_ID,
      role: qaRole,
      route: pseudo.route,
      section: 'history',
      controlId: 'nav:back-forward',
      accessibleName: 'ניווט אחורה וקדימה בדפדפן',
      semanticRole: 'navigation',
      expectedAvailability: true,
      actualAvailability: true,
      interactionAttempted: true,
      interactionResult: historyOk ? 'PASSED' : 'FAILED',
      persistenceChecked: true,
      authorizationChecked: false,
      accessibilityChecked: false,
      evidence: [],
      findingIds: [],
      note: `back→${backPath}, forward→${forwardPath}`,
    });
    if (!historyOk) {
      pseudo.observations.push({
        id: `${qaRole}:nav:history`,
        title: 'ניווט היסטוריה אינו מחזיר למסך הצפוי',
        detail: `אחרי מעבר ל-${second}: back הגיע ל-${backPath} (צפוי ${HOME}), forward הגיע ל-${forwardPath}.`,
        category: 'functional',
        severityHint: 'medium',
        evidence: [],
      });
    }
  }

  // An identifier that does not exist must produce a stated outcome, not a blank screen.
  const unknownTargets = ['/suppliers/00000000-0000-4000-8000-000000000000', '/orders/not-a-uuid'];
  for (const target of unknownTargets) {
    await page.goto(target).catch(() => undefined);
    await page.waitForLoadState('networkidle').catch(() => undefined);
    const landed = pathOf(page);
    const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
    const explained = text.length > 0;
    pseudo.states.push({
      runId: RUN_ID,
      role: qaRole,
      route: pseudo.route,
      state: 'empty',
      status: explained ? 'OBSERVED' : 'NOT_OBSERVED',
      rationale: `${target} → ${landed}: ${explained ? `הוצג טקסט ("${text.slice(0, 60)}")` : 'המסך ריק'}.`,
      evidence: [],
    });
    if (!explained) {
      pseudo.observations.push({
        id: `${qaRole}:nav:${target}`,
        title: 'מזהה לא קיים מוביל למסך ריק',
        detail: `${target} נחת על ${landed} ללא טקסט כלשהו.`,
        category: 'usability',
        severityHint: 'medium',
        evidence: [],
      });
    }
  }

  const snapshot = await snapshotControls(page);
  pseudo.states.push({
    runId: RUN_ID,
    role: qaRole,
    route: pseudo.route,
    state: 'populated',
    status: snapshot.controls.length > 0 ? 'OBSERVED' : 'NOT_OBSERVED',
    rationale: `${snapshot.controls.length} בקרות נסרקו במסך האחרון של מסע הניווט.`,
    evidence: [],
  });

  const failed = pseudo.observations.some((observation) => observation.severityHint === 'high');
  write(qaRole, pseudo, failed ? 'FAILED' : 'PASSED', 'כיסוי ניווט, היסטוריה, מגירת מובייל ומזהים לא קיימים.');
});
