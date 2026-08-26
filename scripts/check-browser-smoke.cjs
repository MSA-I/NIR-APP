const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

for (const name of ['QUALITY_BASE_URL', 'QUALITY_API_URL', 'QUALITY_SERVICE_ROLE_KEY', 'QUALITY_ARTIFACT_DIR', 'QUALITY_PASSWORD_SEED', 'QUALITY_BROWSER_PATH', 'PLAYWRIGHT_CORE_PATH']) {
  if (!process.env[name]) throw new Error(`Missing required browser-gate environment: ${name}`);
}

const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH);
const baseURL = process.env.QUALITY_BASE_URL;
const apiURL = process.env.QUALITY_API_URL;
const serviceRoleKey = process.env.QUALITY_SERVICE_ROLE_KEY;
const outDir = process.env.QUALITY_ARTIFACT_DIR;
const browserPath = process.env.QUALITY_BROWSER_PATH;
const passwordSeed = process.env.QUALITY_PASSWORD_SEED;
// content-range must be CORS-exposed or the browser hides it from supabase-js and
// count:'exact' reads null -> count_unavailable. Real Kong/PostgREST exposes it; the
// mock must speak the same protocol. (Found when the wave-2 server lists hit /bank.)
const jsonHeaders = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'content-range',
  'content-type': 'application/json',
  'content-range': '0-0/1',
};

fs.mkdirSync(outDir, { recursive: true });

const report = {
  generatedAt: new Date().toISOString(),
  passed: [],
  skipped: [],
  failures: [],
  viewports: [],
  accessibility: [],
  screenshots: [],
  pdf: null,
  consoleErrors: [],
};

const OCR_REVIEW_DOCUMENT_ID = '97000000-0000-4000-8000-000000000004';
const OCR_DELIVERY_DOCUMENT_ID = '97000000-0000-4000-8000-000000000005';
const OCR_CREDIT_DOCUMENT_ID = '97000000-0000-4000-8000-000000000003';
const OCR_PAYMENT_DOCUMENT_ID = '97000000-0000-4000-8000-000000000002';
const OCR_PRICE_LIST_DOCUMENT_ID = '97000000-0000-4000-8000-000000000007';
// The 22-row price list that no automation was allowed to apply: the shape the confirmation screen
// exists for, seeded with a shadow prediction covering 20 rows and leaving 2 for a person.
const OCR_MANUAL_PRICE_LIST_DOCUMENT_ID = '97000000-0000-4000-8000-000000000008';
// [documentId, internal stage, what a person reads]. The badge now follows the canonical document
// status precedence rather than showing processing and filing as two competing claims. The raw
// stage remains on `data-stage` for diagnostics; the Hebrew label says the single action-relevant
// truth. In particular, a completed inbox row is "לא משויך", while an active row is only
// "ממתין לעיבוד"/"בעיבוד" and never simultaneously unassigned.
const OCR_STAGE_FIXTURES = [
  ['97000000-0000-4000-8000-000000000001', 'unprocessed', 'לא משויך'],
  ['97000000-0000-4000-8000-000000000002', 'queued', 'ממתין לעיבוד'],
  ['97000000-0000-4000-8000-000000000003', 'processing', 'בעיבוד'],
  ['97000000-0000-4000-8000-000000000004', 'review', 'נדרשת בדיקה'],
  ['97000000-0000-4000-8000-000000000005', 'completed', 'לא משויך'],
  ['97000000-0000-4000-8000-000000000006', 'failed', 'העיבוד נכשל'],
];

const homes = {
  owner: '/dashboard',
  office: '/dashboard',
  accountant: '/dashboard',
};

function credentials(role) {
  return {
    email: `${role}@demo.supplyflow.local`,
    password: `P4!${passwordSeed}-${role}-Aa7`,
  };
}

async function closeContext(context) {
  await context.unrouteAll({ behavior: 'wait' }).catch(() => {});
  await context.close();
}

function captureConsole(page, scope, ignore = [], ignoreResponse = () => false) {
  const sanitize = (value) => value.replace(/([?&]apikey=)[^&'\s]+/gi, '$1[redacted]');
  const isExpected = (value) => ignore.some((pattern) => pattern.test(value));
  page.on('pageerror', (error) => report.consoleErrors.push({ scope, text: sanitize(error.message).slice(0, 400) }));
  page.on('response', (response) => {
    if (response.status() < 400) return;
    const value = `HTTP ${response.status()} ${sanitize(response.url())}`;
    if (ignoreResponse(response)) return;
    if (!isExpected(value)) report.consoleErrors.push({ scope, text: value.slice(0, 400) });
  });
  page.on('requestfailed', (request) => {
    const errorText = request.failure()?.errorText ?? 'unknown error';
    // React route changes and context teardown cancel stale Supabase reads by design.
    if (errorText === 'net::ERR_ABORTED') return;
    const value = `REQUEST FAILED ${sanitize(request.url())}: ${errorText}`;
    if (!isExpected(value)) report.consoleErrors.push({ scope, text: value.slice(0, 400) });
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const value = message.text();
    // Realtime is deliberately disabled in the isolated Supabase config. Chromium logs its
    // rejected WebSocket handshake even though the app's HTTP behavior remains valid.
    if (value.includes('/realtime/v1/websocket')) return;
    // Chromium's generic resource error contains no URL or actionable detail. Purpose-built
    // failure-path assertions below verify the relevant HTTP failures explicitly.
    if (value.startsWith('Failed to load resource:')) return;
    if (isExpected(value)) return;
    report.consoleErrors.push({ scope, text: sanitize(value).slice(0, 400) });
  });
}

async function login(page, role = 'owner') {
  const account = credentials(role);
  await page.goto(`${baseURL}/login`);
  await page.locator('#email').fill(account.email);
  await page.locator('#password').fill(account.password);
  await page.getByRole('button', { name: 'התחברות' }).click();
  await page.waitForFunction((expected) => location.pathname === expected, homes[role], { timeout: 25_000 });
  await page.locator('#main').waitFor({ state: 'visible', timeout: 25_000 });
}

async function settle(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.locator('#main').waitFor({ state: 'visible', timeout: 25_000 });
  await page.locator('#main h1').first().waitFor({ state: 'visible', timeout: 25_000 }).catch((error) => {
    throw new Error(`${new URL(page.url()).pathname}: main heading did not become visible — ${error.message}`);
  });
  await page.waitForTimeout(250);
}

async function retiredPersonasBlocked(browser) {
  for (const role of ['kitchen', 'payer', 'supplier']) {
    const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    captureConsole(page, `retired-persona:${role}`, [
      /HTTP 400 .*\/auth\/v1\/token\?grant_type=password/,
      /\[supplyflow\] Invalid login credentials/,
    ]);
    try {
      const account = credentials(role);
      await page.goto(`${baseURL}/login`);
      await page.locator('#email').fill(account.email);
      await page.locator('#password').fill(account.password);
      await page.getByRole('button', { name: 'התחברות' }).click();
      await page.locator('[role="alert"]').waitFor({ state: 'visible', timeout: 15_000 });
      assert.equal(new URL(page.url()).pathname, '/login', `${role}: retired account left the login screen`);
      assert.equal(await page.locator('#main').count(), 0, `${role}: retired account reached the product shell`);
    } finally {
      await closeContext(context);
    }
  }
}

async function auditAccessibility(page, scope, expectedLang = 'he', expectedDir = 'rtl') {
  const audit = await page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const referencedText = (value) => (value || '').split(/\s+/).filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent?.trim() || '').join(' ').trim();
    const accessibleName = (element) => {
      const aria = element.getAttribute('aria-label')?.trim();
      if (aria) return aria;
      const labelled = referencedText(element.getAttribute('aria-labelledby'));
      if (labelled) return labelled;
      if ('labels' in element && element.labels?.length) {
        const label = [...element.labels].map((node) => node.textContent?.trim() || '').join(' ').trim();
        if (label) return label;
      }
      const alt = element.getAttribute('alt')?.trim();
      if (alt) return alt;
      const title = element.getAttribute('title')?.trim();
      if (title) return title;
      return element.textContent?.replace(/\s+/g, ' ').trim() || '';
    };
    const selector = (element) => {
      if (element.id) return `#${element.id}`;
      const name = element.getAttribute('name');
      return `${element.tagName.toLowerCase()}${name ? `[name="${name}"]` : ''}`;
    };
    const controls = [...document.querySelectorAll('input:not([type="hidden"]), select, textarea')]
      .filter(visible).filter((element) => !accessibleName(element)).map(selector);
    const actions = [...document.querySelectorAll('button, a[href], [role="button"], [role="menuitem"]')]
      .filter(visible).filter((element) => !accessibleName(element)).map(selector);
    const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
    const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    const main = document.querySelector('#main, main');
    return {
      lang: document.documentElement.lang,
      dir: document.documentElement.dir,
      h1: main?.querySelectorAll('h1').length ?? 0,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      controls,
      actions,
      duplicateIds,
    };
  });
  report.accessibility.push({ scope, ...audit });
  assert.equal(audit.lang, expectedLang, `${scope}: document language is not ${expectedLang}`);
  assert.equal(audit.dir, expectedDir, `${scope}: document direction is not ${expectedDir}`);
  assert(audit.h1 >= 1, `${scope}: no level-one heading`);
  assert(audit.overflow <= 1, `${scope}: horizontal overflow ${audit.overflow}px`);
  assert.deepEqual(audit.controls, [], `${scope}: visible form controls without accessible names`);
  assert.deepEqual(audit.actions, [], `${scope}: visible actions without accessible names`);
  assert.deepEqual(audit.duplicateIds, [], `${scope}: duplicate DOM ids`);
  return audit;
}

async function assertAccessibilityTreeNames(page, scope, expectedNames) {
  const session = await page.context().newCDPSession(page);
  try {
    const tree = await session.send('Accessibility.getFullAXTree');
    const names = tree.nodes.map((node) => node.name?.value).filter(Boolean);
    for (const expected of expectedNames) {
      assert(names.includes(expected), `${scope}: Chromium accessibility tree has no «${expected}»`);
    }
  } finally {
    await session.detach();
  }
}

async function assertKeyContrast(page) {
  const results = await page.evaluate(() => {
    const parse = (value) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return null;
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
      return alpha ? [red, green, blue] : null;
    };
    const luminance = (rgb) => {
      const channels = rgb.map((value) => {
        const channel = value / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const background = (element) => {
      for (let node = element; node; node = node.parentElement) {
        const value = getComputedStyle(node).backgroundColor;
        if (value && value !== 'rgba(0, 0, 0, 0)' && value !== 'transparent') return parse(value);
      }
      return [255, 255, 255];
    };
    const firstVisible = (selector) => [...document.querySelectorAll(selector)].find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && (element.textContent || '').trim();
    });
    return ['.page-title', '.text-ink-muted', '.text-ink-body', '#main'].flatMap((selector) => {
      const element = firstVisible(selector);
      if (!element) return [];
      const style = getComputedStyle(element);
      const foreground = parse(style.color);
      const behind = background(element);
      if (!foreground || !behind) return [];
      const light = Math.max(luminance(foreground), luminance(behind));
      const dark = Math.min(luminance(foreground), luminance(behind));
      const ratio = (light + 0.05) / (dark + 0.05);
      const size = Number.parseFloat(style.fontSize);
      const weight = Number.parseInt(style.fontWeight, 10) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      return [{ selector, ratio, required: large ? 3 : 4.5 }];
    });
  });
  assert(results.length >= 3, 'contrast probe could not find enough key UI samples');
  for (const result of results) {
    assert(result.ratio + 0.01 >= result.required, `${result.selector}: contrast ${result.ratio.toFixed(2)} below ${result.required}`);
  }
  return results;
}

async function assertMobileSpeedDialHidden(page, scope) {
  assert.equal(await page.locator('.speed-dial-trigger:visible').count(), 0,
    `${scope}: desktop speed-dial is visible`);
  assert.equal(await page.getByRole('button', { name: 'פתיחת פעולות מהירות' }).count(), 0,
    `${scope}: hidden desktop speed-dial remains in the accessibility tree`);
}

/**
 * Long-form routes keep the complete role-aware action bar. Form-level navigation guards own data
 * safety: orders flush the server draft, receiving flushes IndexedDB, and invoices confirm before
 * discarding dirty data. Stated as an exact list so a missing or reordered action still fails here.
 */
async function assertFullMobileActions(page, scope, expectedKeys) {
  const keys = await page.locator('.mobile-action-bar .mobile-action')
    .evaluateAll((nodes) => nodes.map((node) => node.dataset.quickActionKey));
  assert.deepEqual(keys, expectedKeys, `${scope}: wrong mobile actions ${JSON.stringify(keys)}`);
  await assertMobileSpeedDialHidden(page, scope);

  /**
   * The half of finding 7 that only a browser can answer.
   *
   * /receiving/:orderId already carries a fixed contextual taskbar ("שמירת ביניים" / "סיום קבלה")
   * at `z-30`, and the action bar is `z-40` — so keeping the camera here put two fixed bars on the
   * same bottom edge, with the newer one on top. `.phone-taskbar` is offset above it in index.css;
   * this measures that the offset actually holds, because a camera that covers the save button is
   * a worse dead end than the missing camera it replaced.
   */
  const taskbar = page.locator('.phone-taskbar');
  if (await taskbar.count()) {
    const boxes = await page.evaluate(() => {
      const rect = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const { top, bottom } = node.getBoundingClientRect();
        return { top, bottom };
      };
      return { bar: rect('.mobile-action-bar'), taskbar: rect('.phone-taskbar') };
    });
    assert(boxes.bar && boxes.taskbar, `${scope}: expected both the action bar and the contextual taskbar`);
    assert(boxes.taskbar.bottom <= boxes.bar.top + 1,
      `${scope}: the quick-action bar overlaps the contextual taskbar (taskbar bottom ${boxes.taskbar.bottom}, bar top ${boxes.bar.top})`);
  }
}

async function roleAndViewportMatrix(browser) {
  const viewports = [
    ['320', 320, 720], ['360', 360, 800], ['390', 390, 844], ['430', 430, 932],
    ['768', 768, 1024], ['1024', 1024, 768], ['1440', 1440, 900],
  ];
  for (const [role, expectedHome] of Object.entries(homes)) {
    const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    captureConsole(page, `matrix:${role}`);
    try {
      await login(page, role);
      assert.equal(new URL(page.url()).pathname, expectedHome, `${role}: wrong home route`);
      const hasMobileActions = ['owner', 'office', 'accountant'].includes(role);
      assert.equal(await page.getByRole('group', { name: 'קיצורי דרך ופעולות' }).count(), hasMobileActions ? 1 : 0,
        `${role}: wrong mobile action group visibility`);
      assert.equal(await page.locator('.mobile-action-bar').count(), hasMobileActions ? 1 : 0,
        `${role}: wrong mobile action bar visibility`);
      await assertMobileSpeedDialHidden(page, `${role}/390`);
      for (const [label, width, height] of viewports) {
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(100);
        const metrics = await page.evaluate(() => ({
          width: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        const overflow = metrics.documentWidth - metrics.clientWidth;
        report.viewports.push({ role, label, ...metrics, overflow });
        assert(overflow <= 1, `${role}/${label}: horizontal overflow ${overflow}px`);
      }
      // login() waits for #main only; a dashboard still loading shows the skeleton,
      // which renders no h1 by design. Wait for the heading like settle() does, so
      // the audit measures the loaded page instead of racing the heaviest dashboard.
      await page.locator('#main h1').first().waitFor({ state: 'visible', timeout: 25_000 }).catch((error) => {
        throw new Error(`home:${role}: main heading did not become visible — ${error.message}`);
      });
      await auditAccessibility(page, `home:${role}`);
    } finally {
      await closeContext(context);
    }
  }

  const denied = [
    ['accountant', '/products', '/dashboard'],
  ];
  for (const [role, requested, expected] of denied) {
    const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block' });
    const page = await context.newPage();
    try {
      await login(page, role);
      await page.goto(`${baseURL}${requested}`);
      await page.waitForFunction((path) => location.pathname === path, expected, { timeout: 20_000 });
      assert.equal(new URL(page.url()).pathname, expected);
    } finally {
      await closeContext(context);
    }
  }
}

async function quickActionsContract(browser) {
  const roleLabels = {
    owner: ['הזמנה חדשה', 'מרכז הבקרה', 'צילום מסמך', 'קבלת סחורה', 'בקרת מסמכים'],
    office: ['הזמנה חדשה', 'מרכז הבקרה', 'צילום מסמך', 'קבלת סחורה', 'מסמכים'],
    // 'תשלומים לביצוע', not 'תשלומים'. The bar used to hand-write the second, which is
    // `/payments`'s canonical name, while its own target is `/pay` — so for the ONE role that
    // holds both screens, the bar's "תשלומים" opened the execution queue and the drawer's
    // "תשלומים", one swipe away, opened the ledger of payments already made. The labels now come
    // from `routePresentation`, which has always called `/pay` 'תשלומים לביצוע'. This line was the
    // old collision written down as an expectation; it is the canonical name now.
    accountant: ['מרכז הבקרה', 'חשבוניות', 'תשלומים לביצוע'],
  };
  const roleTargets = {
    owner: ['/orders/new?fresh=1', '/dashboard', null, '/receiving', '/documents/operations'],
    office: ['/orders/new?fresh=1', '/dashboard', null, '/receiving', '/documents'],
    accountant: ['/dashboard', '/invoices', '/pay'],
  };

  for (const [role, expectedLabels] of Object.entries(roleLabels)) {
    const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    captureConsole(page, `mobile-action-bar:${role}`);
    try {
      await login(page, role);
      const group = page.getByRole('group', { name: 'קיצורי דרך ופעולות' });
      await group.waitFor();
      const bar = page.locator('.mobile-action-bar');
      assert.equal(await bar.count(), 1, `${role}: mobile action bar is not unique`);
      assert(await bar.evaluate((node) => node === document.querySelector('[role="group"][aria-label="קיצורי דרך ופעולות"]')),
        `${role}: .mobile-action-bar is not the named role=group`);
      await assertMobileSpeedDialHidden(page, `${role}/390`);
      const items = bar.locator('.mobile-action');
      assert.deepEqual((await items.allTextContents()).map((label) => label.trim()), expectedLabels,
        `${role}: wrong mobile action labels or order`);
        const targets = await items.evaluateAll((nodes) => nodes.map((node) => {
        const href = node.getAttribute('href');
        if (!href) return null;
        const url = new URL(href, window.location.origin);
        return `${url.pathname}${url.search}`;
      }));
      assert.deepEqual(targets, roleTargets[role], `${role}: wrong mobile action destinations or order`);

      if (role === 'owner' || role === 'office') {
        const centers = await items.evaluateAll((nodes) => nodes.map((node) => {
          const rect = node.getBoundingClientRect();
          return rect.left + rect.width / 2;
        }));
        assert(Math.abs(centers[2] - 195) <= 1,
          `${role}: capture is not centered at 390px (${JSON.stringify(centers)})`);
      }

      if (role === 'owner') {
        await page.screenshot({ path: path.join(outDir, 'mobile-action-bar-390.png') });
        report.screenshots.push('mobile-action-bar-390.png');

        const chooser = page.waitForEvent('filechooser');
        await group.getByRole('button', { name: 'צילום מסמך' }).click();
        await chooser;

        for (const [width, height] of [[320, 720], [360, 800], [390, 844], [430, 932], [768, 1024]]) {
          await page.setViewportSize({ width, height });
          await page.waitForTimeout(100);
          assert(await bar.isVisible(), `mobile action bar hidden at ${width}px`);
          await assertMobileSpeedDialHidden(page, `owner/${width}`);
          const layout = await items.evaluateAll((nodes) => nodes.map((node) => {
            const rect = node.getBoundingClientRect();
            const textRects = [];
            const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
              if (!walker.currentNode.textContent?.trim()) continue;
              const range = document.createRange();
              range.selectNodeContents(walker.currentNode);
              textRects.push(...[...range.getClientRects()].map((line) => ({
                top: Math.round(line.top), left: line.left, right: line.right,
              })));
            }
            return {
              width: rect.width,
              height: rect.height,
              scrollWidth: node.scrollWidth,
              clientWidth: node.clientWidth,
              lineCount: new Set(textRects.map((line) => line.top)).size,
              textInside: textRects.every((line) => line.left >= rect.left - 1 && line.right <= rect.right + 1),
            };
          }));
          assert(layout.every(({ width: itemWidth, height: itemHeight }) => itemWidth >= 44 && itemHeight >= 44),
            `mobile action below 44px at ${width}px: ${JSON.stringify(layout)}`);
          assert(layout.every(({ lineCount }) => lineCount >= 1 && lineCount <= 2),
            `mobile action label exceeds two lines at ${width}px: ${JSON.stringify(layout)}`);
          assert(layout.every(({ scrollWidth, clientWidth, textInside }) => scrollWidth <= clientWidth + 1 && textInside),
            `mobile action label overflows at ${width}px: ${JSON.stringify(layout)}`);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          assert(overflow <= 1, `mobile-action-bar/${width}: horizontal overflow ${overflow}px`);
        }

        for (const route of ['/orders/new', '/invoices/new']) {
          await page.setViewportSize({ width: 390, height: 844 });
          await page.goto(`${baseURL}${route}`);
          await settle(page);
          await assertFullMobileActions(page, route,
            ['order', 'dashboard', 'capture', 'receive', 'document-operations']);
        }

        await page.goto(`${baseURL}/receiving/f0000000-0000-4000-8000-000000000011`);
        await settle(page);
        await assertFullMobileActions(page, 'receiving detail',
          ['order', 'dashboard', 'capture', 'receive', 'document-operations']);
        assert.equal(await page.locator('.phone-taskbar').count(), 1, 'receiving detail lost its contextual phone taskbar');
      }
    } finally {
      await closeContext(context);
    }
  }

  // The desktop speed-dial was removed (owner decision 09.08.2026). What stood here was ~120 lines
  // asserting a trigger, a roving-focus menu, a focus hand-off between two surfaces and a
  // reduced-motion companion — all of it protecting code that no longer exists. The contract that
  // replaced it is one claim in both directions: on a desktop there is no quick-action surface at
  // all, in the DOM or in the accessibility tree, and no layout shifted when it left.
  const desktop = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
  const desktopPage = await desktop.newPage();
  captureConsole(desktopPage, 'desktop-no-speed-dial');
  try {
    await login(desktopPage, 'owner');
    for (const [width, height] of [[1024, 768], [1440, 900]]) {
      await desktopPage.setViewportSize({ width, height });
      await desktopPage.waitForTimeout(100);
      assert.equal(await desktopPage.locator('.mobile-action-bar:visible').count(), 0,
        `mobile action bar visible at ${width}px`);
      assert.equal(await desktopPage.locator('.speed-dial-trigger').count(), 0,
        `desktop speed-dial is still in the DOM at ${width}px`);
      assert.equal(await desktopPage.getByRole('button', { name: 'פתיחת פעולות מהירות' }).count(), 0,
        `desktop quick-actions trigger is still in the accessibility tree at ${width}px`);
      const overflow = await desktopPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert(overflow <= 1, `desktop/${width}: horizontal overflow ${overflow}px`);
    }
    await desktopPage.screenshot({ path: path.join(outDir, 'desktop-no-speed-dial-1440.png') });
    report.screenshots.push('desktop-no-speed-dial-1440.png');
  } finally {
    await closeContext(desktop);
  }
}

async function overlayStacking(browser) {
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  captureConsole(page, 'overlay-stacking');
  const overlapAreas = async () => page.evaluate(() => {
    const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect();
    const area = (a, b) => {
      if (!a || !b) return null;
      return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
        * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    };
    const notice = rect('.phone-update-notice');
    return {
      noticeBar: area(notice, rect('.mobile-action-bar')),
      noticeToast: area(notice, rect('[data-p4-toast-viewport]')),
      // noticeFab / noticeMenu went with the desktop speed-dial (09.08.2026). On a desktop the PWA
      // notice now has nothing to collide with in that corner.
    };
  });
  try {
    await login(page, 'owner');
    await page.evaluate(() => window.dispatchEvent(new Event('supplyflow:service-worker-updated')));
    await page.locator('.phone-update-notice').waitFor();
    assert.equal((await overlapAreas()).noticeBar, 0, 'PWA update notice overlaps the mobile action bar');

    await page.evaluate(() => {
      const stack = document.querySelector('.mobile-overlay-stack');
      const notice = document.querySelector('.phone-update-notice');
      if (!stack || !notice) throw new Error('mobile overlay stack is missing');
      const viewport = document.createElement('div');
      viewport.dataset.p4ToastViewport = '';
      viewport.className = 'mobile-toast-offset flex flex-col gap-2 items-center pointer-events-auto';
      const toast = document.createElement('div');
      toast.className = 'rounded-lg px-4 py-2.5 text-sm text-white shadow-lg bg-ink-body';
      toast.textContent = 'הפעולה נשמרה בהצלחה';
      viewport.append(toast);
      stack.insertBefore(viewport, notice);
    });
    assert.equal((await overlapAreas()).noticeToast, 0, 'toast overlaps the PWA update notice');

    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    await page.waitForTimeout(100);
    const zoomed = await overlapAreas();
    assert.equal(zoomed.noticeToast, 0, 'toast overlaps the PWA notice at 200% text size');
    assert.equal(zoomed.noticeBar, 0, 'PWA notice overlaps the mobile action bar at 200% text size');
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(100);
    // The desktop half of this scenario used to prove the PWA notice cleared the speed-dial and its
    // open menu. With that surface gone, what is left worth asserting is that the notice is still
    // reachable on a desktop and did not follow the FAB out of the layout.
    await page.locator('.phone-update-notice').waitFor();
    assert(await page.locator('.phone-update-notice').isVisible(),
      'PWA update notice disappeared on desktop after the speed-dial was removed');
  } finally {
    await closeContext(context);
  }
}

async function dashboardAndDialogs(browser) {
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  captureConsole(page, 'dashboard-dialogs');
  try {
    await login(page, 'owner');
    await page.goto(`${baseURL}/dashboard`);
    await settle(page);
    const dataHeadings = page.locator('#main .dash-enter h2');
    await dataHeadings.first().waitFor();
    assert((await dataHeadings.first().innerText()).includes('דורש טיפול'), 'dashboard does not begin with the attention briefing');
    assert((await dataHeadings.nth(1).innerText()).includes('אספקות היום ומחר'), 'deliveries are not second, after the attention briefing');
    assert.equal(await page.locator('.speed-dial-trigger').count(), 0,
      'the dashboard still renders a desktop speed-dial — it was removed 09.08.2026');
    const contrast = await assertKeyContrast(page);
    await page.screenshot({ path: path.join(outDir, 'dashboard-1440.png'), fullPage: true });
    report.screenshots.push('dashboard-1440.png');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseURL}/dashboard`);
    await settle(page);
    await page.screenshot({ path: path.join(outDir, 'dashboard-390.png'), fullPage: true });
    report.screenshots.push('dashboard-390.png');

    const menuButton = page.getByRole('button', { name: 'פתיחת תפריט' });
    await menuButton.click();
    const drawer = page.getByRole('dialog', { name: 'תפריט ראשי' });
    await drawer.waitFor();
    assert(await drawer.evaluate((node) => node.contains(document.activeElement)), 'drawer did not take focus');
    for (let index = 0; index < 30; index += 1) await page.keyboard.press('Tab');
    assert(await drawer.evaluate((node) => node.contains(document.activeElement)), 'drawer focus trap leaked');
    await page.screenshot({ path: path.join(outDir, 'drawer-390.png') });
    report.screenshots.push('drawer-390.png');
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'hidden' });
    const menuButtonHandle = await menuButton.elementHandle();
    await page.waitForFunction((node) => document.activeElement === node, menuButtonHandle, { timeout: 3_000 });
    assert(await menuButton.evaluate((node) => document.activeElement === node), 'drawer did not restore focus');

    await page.goto(`${baseURL}/suppliers`);
    await settle(page);
    const supplierButton = page.getByRole('button', { name: /ספק חדש/ });
    await supplierButton.click();
    const supplierDialog = page.getByRole('dialog', { name: 'ספק חדש' });
    await supplierDialog.waitFor();
    await auditAccessibility(page, 'supplier-dialog');
    for (let index = 0; index < 25; index += 1) await page.keyboard.press('Tab');
    assert(await supplierDialog.evaluate((node) => node.contains(document.activeElement)), 'supplier dialog focus trap leaked');
    await page.screenshot({ path: path.join(outDir, 'supplier-modal-390.png') });
    report.screenshots.push('supplier-modal-390.png');
    await page.keyboard.press('Escape');
    await supplierDialog.waitFor({ state: 'hidden' });
    assert(await supplierButton.evaluate((node) => document.activeElement === node), 'supplier dialog did not restore focus');

    report.accessibility.push({ scope: 'key-contrast', samples: contrast });
  } finally {
    await closeContext(context);
  }
}

async function goldenScreens(browser) {
  const loginContext = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
  const loginPage = await loginContext.newPage();
  captureConsole(loginPage, 'golden:login');
  try {
    await loginPage.goto(`${baseURL}/login`);
    // The screen's OWN name, at level 1. This waited for a heading called 'InPlace' back when the
    // brand lockup was the auth screens' only <h1> and the actual subject was demoted to <h2> or a
    // bare <p> — a page whose one top-level heading names the vendor tells a screen-reader user
    // nothing about where they are. The lockup is an <img> with the product name as its alt now,
    // and the <h1> is the task. Asserting the task is also the stronger claim: 'InPlace' rendered
    // on every auth screen alike, so it could not tell login from signup from password reset.
    await loginPage.getByRole('heading', { level: 1, name: 'כניסה לחשבון' }).waitFor();
    for (const [label, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
      await loginPage.setViewportSize({ width, height });
      await auditAccessibility(loginPage, `golden:login:${label}`);
      const fileName = `golden-01-login-${label}.png`;
      await loginPage.screenshot({ path: path.join(outDir, fileName) });
      report.screenshots.push(fileName);
    }
  } finally {
    await closeContext(loginContext);
  }

  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  captureConsole(page, 'golden:product');
  const screens = [
    ['02-dashboard', '/dashboard'],
    ['03-suppliers', '/suppliers'],
    ['04-supplier-detail', '/suppliers/aa000000-0000-4000-8000-000000000001'],
    ['05-orders', '/orders'],
    ['06-order-detail', '/orders/f0000000-0000-4000-8000-000000000011'],
    ['07-receiving', '/receiving'],
    ['08-invoices', '/invoices'],
    ['09-invoice-detail', '/invoices/f4000000-0000-4000-8000-000000000010'],
    ['10-documents', '/documents'],
  ];
  try {
    await login(page, 'owner');
    for (const [slug, route] of screens) {
      for (const [label, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
        await page.setViewportSize({ width, height });
        await page.goto(`${baseURL}${route}`);
        await settle(page);
        await page.waitForFunction(() => !document.querySelector('#main .animate-pulse'), null, { timeout: 25_000 });
        await auditAccessibility(page, `golden:${slug}:${label}`);
        const fileName = `golden-${slug}-${label}.png`;
        await page.screenshot({ path: path.join(outDir, fileName) });
        report.screenshots.push(fileName);
      }
    }
  } finally {
    await closeContext(context);
  }
}

async function tableKeyboardAndSearch(browser) {
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 1024, height: 768 } });
  const page = await context.newPage();
  captureConsole(page, 'table-keyboard-search');
  try {
    await login(page, 'owner');
    await page.goto(`${baseURL}/invoices`);
    await settle(page);
    await page.waitForTimeout(1_000);
    const titleAtDeepLink = await page.title();
    const routeTitleUpdated = titleAtDeepLink.includes('חשבוניות');
    const routeFocusMoved = await page.waitForFunction(() => document.activeElement?.id === 'main', null, { timeout: 4_000 })
      .then(() => true).catch(() => false);

    const invoiceButton = page.locator('button[aria-label^="פתיחת חשבונית "]').first();
    await invoiceButton.waitFor({ timeout: 20_000 });
    await invoiceButton.press('Enter');
    await page.waitForURL((url) => /^\/invoices\/[^/]+$/.test(url.pathname), { timeout: 20_000 });
    await page.goBack();
    await settle(page);

    await page.setViewportSize({ width: 320, height: 250 });
    const trigger = page.locator('button[aria-haspopup="menu"]').first();
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    const menu = page.getByRole('menu').first();
    await menu.waitFor();
    const rect = await menu.boundingBox();
    assert(rect, 'action menu has no bounds');
    assert(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 320.5 && rect.y + rect.height <= 250.5,
      `action menu outside effective 200% zoom viewport: ${JSON.stringify(rect)}`);
    await page.keyboard.press('End');
    const endItem = await page.locator('[role="menuitem"]:focus').innerText();
    await page.keyboard.press('Home');
    const homeItem = await page.locator('[role="menuitem"]:focus').innerText();
    assert.notEqual(endItem, homeItem, 'Home/End did not move inside the action menu');
    await page.keyboard.press('Escape');
    assert(await trigger.evaluate((node) => document.activeElement === node), 'action menu did not restore focus');

    await page.setViewportSize({ width: 390, height: 844 });
    const searchButton = page.getByRole('button', { name: 'חיפוש', exact: true });
    await searchButton.click();
    const searchDialog = page.getByRole('dialog', { name: 'חיפוש כללי' });
    await searchDialog.waitFor();
    const searchInput = searchDialog.getByRole('combobox', { name: 'חיפוש כללי' });
    await searchInput.fill('7702');
    const option = searchDialog.getByRole('option').first();
    await option.waitFor({ timeout: 20_000 });
    await option.click();
    const resultPath = new URL(page.url()).pathname;
    assert(/^\/(invoices|orders|suppliers)\//.test(resultPath), `mobile search opened unexpected route ${resultPath}`);
    await page.goBack();
    await page.goForward();
    assert.equal(new URL(page.url()).pathname, resultPath, 'back/forward lost the mobile-search deep link');
    assert(routeFocusMoved, 'route navigation did not move focus to main');
    assert(routeTitleUpdated, `deep-link route title was not updated; actual title: ${titleAtDeepLink}`);
  } finally {
    await closeContext(context);
  }
}

async function receivingAccessibility(browser) {
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  const order = {
    id: 'p4-ui-order', org_id: 'p4-ui-org', supplier_id: 'p4-ui-supplier', number: 9001,
    status: 'confirmed', order_date: '2026-07-20', expected_date: '2026-07-23', total_amount: 120,
    created_at: '2026-07-20T08:00:00Z',
    notes: null, supplier: { id: 'p4-ui-supplier', name: 'ספק בדיקת נגישות' },
    items: [{
      id: 'p4-ui-item', org_id: 'p4-ui-org', order_id: 'p4-ui-order', product_id: 'p4-ui-product',
      qty: 10, received_qty: 2, unit_price: 12, product: { name: 'מוצר בדיקת נגישות', unit: 'יחידה' },
    }],
  };
  const receiptReasons = [];
  const page = await context.newPage();
  const flagsRecovered = page.waitForResponse((response) =>
    response.request().method() === 'POST'
    && response.url().includes('/rest/v1/rpc/resolve_feature_flags')
    && response.ok(), { timeout: 25_000 });
  // TanStack retries this fail-closed read. A transient gateway response is acceptable only when
  // the same page subsequently observes a successful resolution; a persistent outage still fails.
  captureConsole(page, 'receiving-accessibility', [], (response) =>
    response.status() === 502 && response.url().includes('/rest/v1/rpc/resolve_feature_flags'));
  try {
    await login(page, 'office');
    await flagsRecovered;
    await settle(page);
    await context.route('**/rest/v1/purchase_orders?**', (route) => {
      const url = new URL(route.request().url());
      const detail = (url.searchParams.get('id') || '') === 'eq.p4-ui-order';
      return route.fulfill({ status: 200, headers: jsonHeaders, json: detail ? order : [order] });
    });
    await context.route('**/rest/v1/goods_receipts?**', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: null }));
    await context.route('**/rest/v1/rpc/save_goods_receipt', (route) => {
      receiptReasons.push(route.request().postDataJSON().p_reason);
      return route.fulfill({ status: 200, headers: jsonHeaders, json: { receipt_id: 'a0000000-0000-4000-8000-000000000001' } });
    });
    await page.goto(`${baseURL}/receiving`);
    await settle(page);
    await page.getByText('ספק בדיקת נגישות').first().click();
    await page.waitForURL((url) => url.pathname === '/receiving/p4-ui-order');
    await page.getByRole('button', { name: 'הגדלת הכמות שהתקבלה עבור מוצר בדיקת נגישות' }).waitFor();
    // The office receiver keeps the complete role-aware bar on the exact screen under audit.
    await assertFullMobileActions(page, 'receiving detail accessibility',
      ['order', 'dashboard', 'capture', 'receive', 'documents']);
    assert.equal(await page.locator('.phone-taskbar').count(), 1, 'receiving detail lost its contextual phone taskbar');
    assert.equal(await page.getByText('סיבת השמירה / ההשלמה').count(), 0, 'routine receiving must not ask for a reason');
    await page.getByRole('button', { name: 'מלא עבור מוצר בדיקת נגישות' }).waitFor();
    assert.equal(await page.locator('button[aria-pressed]').count(), 5, 'receiving status controls lost pressed state');
    await page.screenshot({ path: path.join(outDir, 'receiving-390.png'), fullPage: true });
    report.screenshots.push('receiving-390.png');
    const audit = await auditAccessibility(page, 'receiving-detail');
    assert.deepEqual(audit.controls, [], 'receiving detail contains an unlabeled control');
    await page.getByRole('button', { name: 'שמירת ביניים' }).click();
    await page.waitForURL((url) => url.pathname === '/receiving');
    assert.equal(receiptReasons[0], 'שמירת ביניים של קבלת סחורה', 'draft receipt audit reason was not system-authored');
    await page.goto(`${baseURL}/receiving/p4-ui-order`);
    await settle(page);
    await page.getByRole('button', { name: /סיום קבלה/ }).click();
    await page.getByRole('heading', { name: 'הקבלה נשמרה!' }).waitFor();
    assert.equal(receiptReasons[1], 'השלמת קבלת סחורה', 'completed receipt audit reason was not system-authored');
  } finally {
    await closeContext(context);
  }
}

/* ===================== wave 8: offline receiving and the barcode flag ===================== */

const OFFLINE_ORDER_ID = 'p8-offline-order';
const OFFLINE_RECEIPT_ID = 'b8000000-0000-4000-8000-000000000001';
const OFFLINE_PRODUCT_BARCODE = '7290000000019';

function offlineReceivingOrder() {
  return {
    id: OFFLINE_ORDER_ID, org_id: 'p8-org', supplier_id: 'p8-supplier', number: 9101,
    status: 'confirmed', order_date: '2026-07-20', expected_date: '2026-07-23', total_amount: 240,
    created_at: '2026-07-20T08:00:00Z', notes: null,
    supplier: { id: 'p8-supplier', name: 'ספק בדיקת לא-מקוון' },
    items: [{
      id: 'p8-offline-item', org_id: 'p8-org', order_id: OFFLINE_ORDER_ID, product_id: 'p8-product',
      qty: 10, received_qty: 0, unit_price: 12,
      product: {
        id: 'p8-product', name: 'עגבניות בדיקה', unit: 'ק"ג',
        sku: 'VEG-P8', barcode: OFFLINE_PRODUCT_BARCODE,
      },
    }],
  };
}

/** Reads the app's own IndexedDB, so persistence is asserted as a fact rather than inferred. */
function readOfflineStore(page, orderId = OFFLINE_ORDER_ID) {
  return page.evaluate(async ({ targetOrderId }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('supplyflow-offline');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const readAll = (name) => new Promise((resolve, reject) => {
      if (!db.objectStoreNames.contains(name)) return resolve([]);
      const request = db.transaction(name, 'readonly').objectStore(name).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    // v1 order/draft stores are recovery-only. Production reads and writes the actor/tenant-scoped
    // v2 stores, so reading v1 here would make both persistence and never-cache assertions vacuous.
    const drafts = (await readAll('receipt_drafts_v2'))
      .filter((draft) => draft.orderId === targetOrderId);
    const queue = (await readAll('sync_queue'))
      .filter((action) => action.orderId === targetOrderId
        || (action.payload && action.payload.p_order_id === targetOrderId));
    const openOrders = (await readAll('open_orders_v2'))
      .filter((entry) => entry.orderId === targetOrderId);
    db.close();
    return {
      drafts: drafts.map((draft) => ({
        orderId: draft.orderId,
        receiptId: draft.receiptId,
        keySource: draft.keySource,
        syncedAt: draft.syncedAt,
        lines: (draft.lines || []).map((line) => ({
          orderItemId: line.order_item_id,
          qtyReceived: line.qty_received,
          status: line.status,
          notes: line.notes,
        })),
      })),
      queue: queue.map((action) => ({
        key: action.idempotencyKey,
        receiptId: action.payload && action.payload.p_receipt_id,
        state: action.state,
        attempts: action.attempts,
        lines: (action.payload && action.payload.p_lines) || [],
      })),
      openOrderCount: openOrders.length,
      cachedItemCount: openOrders.reduce((count, entry) => count + ((entry.order && entry.order.items) || []).length, 0),
      openOrderKeys: openOrders.map((entry) => Object.keys(entry.order || {})),
      cachedItemKeys: openOrders.flatMap((entry) => ((entry.order && entry.order.items) || []).map((item) => Object.keys(item))),
    };
  }, { targetOrderId: orderId });
}

/**
 * Offline goods receiving, end to end (`OFFLINE-SYNC-DESIGN.md`).
 *
 * `serviceWorkers: 'block'` stays on deliberately: the queue is plain JS plus IndexedDB and owes
 * nothing to a service worker. App-shell precaching is covered by its own scenario, and this one
 * isolates the queue contract by closing the receiving tab before the pending write is accepted.
 */
async function offlineReceiving(browser) {
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  const order = offlineReceivingOrder();
  const receiptRequests = [];
  let holdReceiptSync = false;
  let releaseReceiptSync;
  const receiptSyncGate = new Promise((resolve) => { releaseReceiptSync = resolve; });
  // The offline period legitimately produces failed requests: background reads, the flag resolver
  // and the auth refresh all lose the network at once. Their absence would be the surprise.
  const offlineNoise = [
    /net::ERR_INTERNET_DISCONNECTED/,
    /net::ERR_NETWORK_CHANGED/,
    /net::ERR_NAME_NOT_RESOLVED/,
    /Failed to fetch/,
    /TypeError: Failed to fetch/,
    /\[supplyflow\]/,
    /AuthRetryableFetchError/,
  ];
  try {
    await context.route('**/rest/v1/purchase_orders?**', (route) => {
      const url = new URL(route.request().url());
      const detail = (url.searchParams.get('id') || '') === `eq.${OFFLINE_ORDER_ID}`;
      return route.fulfill({ status: 200, headers: jsonHeaders, json: detail ? order : [order] });
    });
    await context.route('**/rest/v1/goods_receipts?**', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: null }));
    // This scenario owns the offline queue, not the flag resolver. Keep that cross-cutting
    // dependency deterministic while the same browser context flips offline and online; P4 and
    // barcodeFlagAndCamera own the resolver's policy and UI contracts.
    await context.route('**/rest/v1/rpc/resolve_feature_flags', (route) =>
      route.fulfill({ status: 200, headers: jsonHeaders, json: [] }));
    await context.route('**/rest/v1/rpc/save_goods_receipt', async (route) => {
      receiptRequests.push(route.request().postDataJSON());
      if (holdReceiptSync) await receiptSyncGate;
      return route.fulfill({ status: 200, headers: jsonHeaders, json: { receipt_id: OFFLINE_RECEIPT_ID } });
    });

    let page = await context.newPage();
    captureConsole(page, 'offline-receiving', offlineNoise);
    await login(page, 'office');
    await page.goto(`${baseURL}/receiving/${OFFLINE_ORDER_ID}`);
    await settle(page);
    await page.getByRole('button', { name: 'הגדלת הכמות שהתקבלה עבור עגבניות בדיקה' }).waitFor();

    // The key is minted and stored at draft creation, before anything is sent (ADR-0006:37-39).
    await page.waitForFunction(async ({ storeName, targetOrderId }) => {
      const db = await new Promise((resolve) => {
        const request = indexedDB.open('supplyflow-offline');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      });
      if (!db) return false;
      if (!db.objectStoreNames.contains(storeName)) {
        db.close();
        return false;
      }
      const rows = await new Promise((resolve) => {
        const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve([]);
      });
      db.close();
      return rows.some((draft) => draft.orderId === targetOrderId);
    }, { storeName: 'receipt_drafts_v2', targetOrderId: OFFLINE_ORDER_ID }, { timeout: 20_000 });
    const atDraft = await readOfflineStore(page);
    assert.equal(atDraft.drafts.length, 1, 'no receipt draft was persisted at draft creation');
    const persistedKey = atDraft.drafts[0].receiptId;
    assert.match(persistedKey, /^[0-9a-f-]{36}$/i, `persisted receipt key is not a uuid: ${persistedKey}`);
    // The cached order carries no money: the never-cache rule is structural here, not a promise.
    assert.equal(atDraft.openOrderCount, 1, 'the target order was not present in the scoped offline cache');
    assert.equal(atDraft.cachedItemCount, order.items.length,
      'the target order items were not present in the scoped offline cache');
    for (const keys of atDraft.cachedItemKeys) {
      assert.equal(keys.includes('unit_price'), false, 'the offline order cache stored a price');
    }
    for (const keys of atDraft.openOrderKeys) {
      assert.equal(keys.includes('total_amount'), false, 'the offline order cache stored an order total');
    }

    await context.setOffline(true);
    // spinbutton, not getByLabel: the +/- buttons' own labels contain the same phrase.
    await page.getByRole('spinbutton', { name: 'כמות שהתקבלה עבור עגבניות בדיקה' }).fill('4');

    // An edit is durable before the user presses save. Wait for the app's actual IndexedDB row,
    // kill the tab, reopen the order, and prove the UI hydrates the same value from that row.
    await page.waitForFunction(async ({ storeName, targetOrderId, targetItemId }) => {
      const db = await new Promise((resolve) => {
        const request = indexedDB.open('supplyflow-offline');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      });
      if (!db || !db.objectStoreNames.contains(storeName)) return false;
      const rows = await new Promise((resolve) => {
        const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve([]);
      });
      db.close();
      const draft = rows.find((row) => row.orderId === targetOrderId);
      const line = draft && (draft.lines || []).find((row) => row.order_item_id === targetItemId);
      return line && Number(line.qty_received) === 4;
    }, {
      storeName: 'receipt_drafts_v2',
      targetOrderId: OFFLINE_ORDER_ID,
      targetItemId: 'p8-offline-item',
    }, { timeout: 20_000 });
    const editedDraft = await readOfflineStore(page);
    assert.equal(editedDraft.drafts[0].lines[0].qtyReceived, 4,
      'the quantity edit was not persisted before an explicit save');

    await page.close();
    await context.setOffline(false);
    page = await context.newPage();
    captureConsole(page, 'offline-receiving-edit-recovery', offlineNoise);
    await page.goto(`${baseURL}/receiving/${OFFLINE_ORDER_ID}`);
    if (new URL(page.url()).pathname === '/login') {
      await login(page, 'office');
      await page.goto(`${baseURL}/receiving/${OFFLINE_ORDER_ID}`);
    }
    await settle(page);
    const restoredQuantity = page.getByRole('spinbutton', { name: 'כמות שהתקבלה עבור עגבניות בדיקה' });
    await restoredQuantity.waitFor({ timeout: 20_000 });
    assert.equal(await restoredQuantity.inputValue(), '4',
      'the receipt quantity did not survive a tab crash before explicit save');

    await context.setOffline(true);
    await page.getByRole('button', { name: /סיום קבלה/ }).click();

    const completion = page.locator('[data-testid="receiving-completion"][data-sync-state="pending"]');
    await completion.waitFor({ timeout: 15_000 });
    const status = page.locator('[data-testid="offline-queue-status"]');
    await status.waitFor();
    // Two counters, separate, and a sync time that is a real `—` rather than "just now".
    assert.equal((await status.locator('[data-testid="offline-pending-actions"]').innerText()).trim(), '1',
      'the pending-actions counter did not report the queued receipt');
    assert.equal((await status.locator('[data-testid="offline-pending-uploads"]').innerText()).trim(), '0',
      'pending uploads were folded into the actions counter');
    assert.equal((await status.locator('[data-testid="offline-last-sync"]').innerText()).trim(), '—',
      'an unknown last-sync time was rendered as something other than —');
    assert.equal(receiptRequests.length, 0, 'a receipt was sent to the server while the device was offline');

    const queued = await readOfflineStore(page);
    assert.equal(queued.queue.length, 1, 'the receipt was not queued on the device');
    assert.equal(queued.queue[0].receiptId, persistedKey,
      'the queued payload does not carry the key persisted at draft creation');
    assert.equal(Number(queued.queue[0].lines[0].qty_received), 4,
      'the queued receipt lost the quantity restored from the autosaved draft');
    const toast = page.locator('.mobile-toast-offset [role]').first();
    await toast.waitFor();
    const toastBox = await toast.boundingBox();
    const viewport = page.viewportSize();
    assert(toastBox && viewport && toastBox.y >= 0 && toastBox.y + toastBox.height <= viewport.height,
      `offline feedback is outside the visible completion screen: toast=${JSON.stringify(toastBox)} viewport=${JSON.stringify(viewport)}`);
    await page.screenshot({ path: path.join(outDir, 'receiving-offline-390.png'), fullPage: true });
    report.screenshots.push('receiving-offline-390.png');

    // The tab dies with the work still queued — the case ADR-0006 actually cares about. Hold the
    // first accepted response so persistence can be observed before the reopened app drains it.
    holdReceiptSync = true;
    await page.close();
    await context.setOffline(false);

    const resumed = await context.newPage();
    captureConsole(resumed, 'offline-receiving-resumed', offlineNoise);
    await resumed.goto(`${baseURL}/receiving/${OFFLINE_ORDER_ID}`);
    // The stored session normally survives with the context; a token refresh that died mid-offline
    // can still bounce this page to /login, and that is not what this scenario is measuring.
    if (new URL(resumed.url()).pathname === '/login') {
      await login(resumed, 'office');
      await resumed.goto(`${baseURL}/receiving/${OFFLINE_ORDER_ID}`);
    }
    await settle(resumed);
    const resumedStatus = resumed.locator('[data-testid="offline-queue-status"]');
    await resumedStatus.waitFor({ timeout: 20_000 });
    assert.equal((await resumedStatus.locator('[data-testid="offline-pending-actions"]').innerText()).trim(), '1',
      'the queued receipt did not survive the closed tab');

    releaseReceiptSync();
    await resumed.waitForTimeout(1_500);
    const stillPending = await resumed.locator('[data-testid="offline-pending-actions"]').textContent().catch(() => null);
    if (stillPending?.trim() === '1') {
      await resumedStatus.getByRole('button', { name: /ניסיון סנכרון עכשיו/ }).click();
    }
    await resumed.waitForFunction(
      () => document.querySelector('[data-testid="offline-pending-actions"]') === null
        || document.querySelector('[data-testid="offline-pending-actions"]').textContent.trim() === '0',
      null,
      { timeout: 20_000 },
    );
    assert.equal(receiptRequests.length, 1, `save_goods_receipt was called ${receiptRequests.length} times for one receipt`);
    assert.equal(receiptRequests[0].p_receipt_id, persistedKey,
      'the receipt was sent under a different key than the one persisted at draft creation');
    assert.equal(receiptRequests[0].p_complete, true, 'the queued completion was sent as a draft save');
    assert.equal(Number(receiptRequests[0].p_lines[0].qty_received), 4,
      'the server request lost the quantity restored from the autosaved draft');
    // The observed device clock travels in the reason (#100), never in the signature.
    assert.match(receiptRequests[0].p_reason, /^השלמת קבלת סחורה/,
      `queued reason was not system-authored: ${receiptRequests[0].p_reason}`);
    assert.equal(Object.keys(receiptRequests[0]).sort().join(','),
      'p_complete,p_lines,p_notes,p_open_credits,p_order_id,p_reason,p_receipt_id',
      'the offline queue sent a different argument set than the screen does');

    const synced = await readOfflineStore(resumed);
    assert.equal(synced.queue.length, 0, 'the accepted receipt stayed in the queue');
  } finally {
    await context.setOffline(false).catch(() => {});
    await closeContext(context);
  }
}

/**
 * The barcode flag boundary and a denied camera (`OFFLINE-SYNC-DESIGN.md`, second scenario).
 *
 * No real camera is exercised: the match itself is a unit-tested pure function, including the
 * ambiguity case. What is asserted here is the part only a browser can answer — that the flag being
 * off means nothing renders, and that a refused permission produces a Hebrew explanation plus a
 * working manual entry rather than a broken screen.
 */
async function barcodeFlagAndCamera(browser) {
  const order = offlineReceivingOrder();
  const routeOrder = async (context) => {
    await context.route('**/rest/v1/purchase_orders?**', (route) => {
      const url = new URL(route.request().url());
      const detail = (url.searchParams.get('id') || '') === `eq.${OFFLINE_ORDER_ID}`;
      return route.fulfill({ status: 200, headers: jsonHeaders, json: detail ? order : [order] });
    });
    await context.route('**/rest/v1/goods_receipts?**', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: null }));
  };

  const off = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  try {
    await routeOrder(off);
    await off.route('**/rest/v1/rpc/resolve_feature_flags', (route) =>
      route.fulfill({ status: 200, headers: jsonHeaders, json: [{ flag_key: 'receiving.barcode', state: false }] }));
    const page = await off.newPage();
    captureConsole(page, 'barcode-flag-off');
    await login(page, 'office');
    await page.goto(`${baseURL}/receiving/${OFFLINE_ORDER_ID}`);
    await settle(page);
    await page.getByRole('button', { name: 'הגדלת הכמות שהתקבלה עבור עגבניות בדיקה' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'סריקת ברקוד' }).count(), 0,
      'the scanner rendered while receiving.barcode was off');
  } finally {
    await closeContext(off);
  }

  const on = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  try {
    await routeOrder(on);
    await on.route('**/rest/v1/rpc/resolve_feature_flags', (route) =>
      route.fulfill({ status: 200, headers: jsonHeaders, json: [{ flag_key: 'receiving.barcode', state: true }] }));
    // The addInitScript override idiom (:1441): a refused camera, deterministically, with the same
    // DOMException name a browser raises when someone taps "block".
    await on.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: async () => {
            const error = new Error('camera blocked by p8 fixture');
            error.name = 'NotAllowedError';
            throw error;
          },
          enumerateDevices: async () => [],
        },
      });
    });
    const page = await on.newPage();
    captureConsole(page, 'barcode-camera-denied');
    await login(page, 'office');
    await page.goto(`${baseURL}/receiving/${OFFLINE_ORDER_ID}`);
    await settle(page);
    await page.getByRole('button', { name: 'סריקת ברקוד' }).click();
    const dialog = page.getByRole('dialog', { name: 'סריקת ברקוד' });
    await dialog.waitFor();
    await dialog.getByText(/הרשאה למצלמה/).waitFor({ timeout: 15_000 });
    const manual = dialog.getByLabel('הזנת קוד ידנית');
    await manual.waitFor();
    // The fallback is not decoration: a typed code resolves through the same match chain.
    await manual.fill(OFFLINE_PRODUCT_BARCODE);
    await dialog.getByRole('button', { name: 'בדיקת הקוד' }).click();
    await dialog.getByText(/עגבניות בדיקה/).waitFor({ timeout: 15_000 });
    await dialog.getByText(/הכמות נשארת להזנה שלך/).waitFor();
    await page.screenshot({ path: path.join(outDir, 'barcode-camera-denied-390.png'), fullPage: true });
    report.screenshots.push('barcode-camera-denied-390.png');
    await dialog.getByRole('button', { name: 'סיום סריקה' }).click();
    await auditAccessibility(page, 'receiving-barcode');
  } finally {
    await closeContext(on);
  }
}

async function orderSupplierComparison(browser) {
  const context = await browser.newContext({
    locale: 'he-IL', serviceWorkers: 'block', reducedMotion: 'reduce', viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  captureConsole(page, 'order-split-journey', [/finalize_purchase_request_draft/, /draft_price_changed/]);
  const product = 'לחמניות המבורגר (ארגז 48)';
  const ownerAuth = await fetch(`${apiURL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: serviceRoleKey, 'content-type': 'application/json' },
    body: JSON.stringify(credentials('owner')),
  });
  assert(ownerAuth.ok, `quality owner authentication failed with HTTP ${ownerAuth.status}`);
  const ownerToken = (await ownerAuth.json()).access_token;
  const offerResponse = await fetch(`${apiURL}/rest/v1/supplier_products?select=id,price_effective_date,available&supplier_id=eq.aa000000-0000-4000-8000-000000000004&product_id=eq.bb000000-0000-4000-8000-000000000009`, {
    headers: { apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}` },
  });
  assert(offerResponse.ok, `quality supplier offer lookup failed with HTTP ${offerResponse.status}`);
  const [offer] = await offerResponse.json();
  assert(offer, 'quality supplier offer lookup did not match the seeded offer');
  const qualitySupplierPrice = async (price) => {
    const response = await fetch(`${apiURL}/rest/v1/rpc/set_supplier_product_price`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${ownerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        p_supplier_product_id: offer.id,
        p_price: price,
        p_effective_date: offer.price_effective_date,
        p_available: offer.available,
        p_reason: 'בדיקת איכות אוטומטית של שינוי מחיר בטיוטה',
      }),
    });
    assert(response.ok, `quality price update failed with HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  };
  const waitForDraftSave = () => page.waitForResponse((response) =>
    response.request().method() === 'POST'
    && response.url().includes('/rest/v1/rpc/save_purchase_request_draft'));
  const waitForSaved = () => page.getByRole('heading', { name: 'הזמנה חדשה' }).locator('..')
    .getByRole('status').filter({ hasText: 'נשמר' }).waitFor({ timeout: 25_000 });
  const captureOrderState = async (state, fullPage = true) => {
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(100);
      await auditAccessibility(page, `new-order:${state}:${width}`);
      const fileName = `new-order-${state}-${width}.png`;
      await page.screenshot({ path: path.join(outDir, fileName), fullPage });
      report.screenshots.push(fileName);
    }
  };

  try {
    await login(page, 'office');
    await page.goto(`${baseURL}/orders/new?fresh=1`);
    await settle(page);
    assert(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
      'new-order context did not honor prefers-reduced-motion');

    await page.getByRole('button', { name: `בחירת ${product}` }).click();
    await page.getByRole('button', { name: `הוספת כמות ${product}` }).click();
    await page.waitForURL((url) => url.pathname === '/orders/new' && url.searchParams.has('draft'), { timeout: 25_000 });
    await waitForSaved();

    const stepTwoSave = waitForDraftSave();
    await page.getByRole('button', { name: 'המשך לספקים' }).click();
    assert((await stepTwoSave).ok(), 'saving supplier step failed');
    await waitForSaved();
    let comparison = page.locator('section[aria-labelledby="supplier-comparison-title"]');
    await comparison.waitFor();
    const goldPick = comparison.getByRole('button', { name: `בחירת מאפה זהב עבור ${product}` });
    assert.equal(await goldPick.getAttribute('aria-pressed'), 'true', 'cheapest supplier was not selected automatically');

    const pinSave = waitForDraftSave();
    await goldPick.click();
    assert((await pinSave).ok(), 'pinning the cheapest supplier was not saved');
    await waitForSaved();
    await comparison.getByRole('button', { name: 'חזרה לבחירה אוטומטית' }).waitFor();
    const draftUrl = page.url();

    await page.reload();
    await settle(page);
    assert.equal(page.url(), draftUrl, 'draft URL changed during reload');
    const supplierStep = page.getByRole('button', { name: /02.*ספקים וחלוקה/ });
    assert.equal(await supplierStep.getAttribute('aria-current'), 'step', 'draft did not restore supplier step');
    comparison = page.locator('section[aria-labelledby="supplier-comparison-title"]');
    await comparison.getByRole('button', { name: 'חזרה לבחירה אוטומטית' }).waitFor();
    assert.equal(await comparison.getByRole('button', { name: `בחירת מאפה זהב עבור ${product}` }).getAttribute('aria-pressed'), 'true',
      'pinned cheapest supplier did not survive reload');

    const brokenPinSave = waitForDraftSave();
    await page.getByRole('button', { name: /01.*מוצרים וכמויות/ }).click();
    await page.getByRole('button', { name: `הפחתת כמות ${product}` }).click();
    await page.getByRole('button', { name: 'המשך לספקים' }).click();
    assert((await brokenPinSave).ok(), 'saving the below-minimum pin state failed');
    await waitForSaved();

    const blocked = page.locator('section[aria-labelledby="blocked-lines-title"]');
    await blocked.waitFor();
    assert.match(await blocked.innerText(), /הצמדה לא תקפה · מינימום\s*2/, 'broken pin did not expose min_qty 2');
    const growBrokenPin = blocked.getByRole('button', { name: /^הגדל ל-\s*2/ });
    assert((await growBrokenPin.innerText()).includes('58.50'), 'broken-pin increase did not show the exact added cost');
    await blocked.getByRole('button', { name: 'חזרה לבחירה אוטומטית' }).waitFor();
    assert(await page.getByRole('button', { name: /03.*סיכום ואישור/ }).isDisabled(), 'broken pin did not gate summary step');
    await captureOrderState('blocked-pin');

    const unpinSave = waitForDraftSave();
    await blocked.getByRole('button', { name: 'חזרה לבחירה אוטומטית' }).click();
    assert((await unpinSave).ok(), 'unpinning the broken supplier was not saved');
    await waitForSaved();
    await blocked.waitFor({ state: 'hidden' });
    const splitSection = page.locator('section[aria-labelledby="supplier-split-title"]');
    await splitSection.getByText('מאפיית הלחם החם', { exact: true }).waitFor();

    const underMinimumSave = waitForDraftSave();
    await page.getByRole('button', { name: /01.*מוצרים וכמויות/ }).click();
    await page.getByRole('button', { name: `הוספת כמות ${product}` }).click();
    await page.getByRole('button', { name: `הוספת כמות ${product}` }).click();
    await page.getByRole('button', { name: 'המשך לספקים' }).click();
    assert((await underMinimumSave).ok(), 'saving the under-minimum basket failed');
    await waitForSaved();

    await splitSection.getByText('מאפה זהב', { exact: true }).waitFor();
    const underMinimumText = await splitSection.innerText();
    for (const amount of ['175.50', '200.00', '24.50']) {
      assert(underMinimumText.includes(amount), `under-minimum supplier group omitted ${amount}`);
    }
    await captureOrderState('under-minimum');

    const fixOpener = splitSection.getByRole('button', { name: /הצג פתרונות/ });
    await fixOpener.focus();
    await page.keyboard.press('Enter');
    const fixes = page.getByRole('dialog', { name: 'פתרונות עבור מאפה זהב' });
    await fixes.waitFor();
    const fixesHandle = await fixes.elementHandle();
    await page.waitForFunction((node) => document.activeElement === node, fixesHandle, { timeout: 3_000 });

    const increase = fixes.getByRole('button', { name: /הגדל "לחמניות המבורגר \(ארגז 48\)" מ-\s*3 ל-\s*4/ });
    const moveLine = fixes.getByRole('button', { name: /^העבר "לחמניות המבורגר \(ארגז 48\)" ל"מאפיית הלחם החם"/ });
    const moveGroup = fixes.getByRole('button', { name: /העבר את כל\s*1 הפריטים ל"מאפיית הלחם החם"/ });
    const remove = fixes.getByRole('button', { name: /הסר "לחמניות המבורגר \(ארגז 48\)" מההזמנה/ });
    const defer = fixes.getByRole('button', { name: /הסר ושמור את "לחמניות המבורגר \(ארגז 48\)" להזמנה הבאה/ });
    assert((await fixes.innerText()).includes('24.50'), 'fix panel omitted the exact shortfall');
    assert((await increase.innerText()).includes('58.50') && (await increase.innerText()).includes('234.00'),
      'increase option omitted its exact cost or resulting subtotal');
    assert((await moveLine.innerText()).includes('10.50'), 'move-line option omitted its exact cost');
    assert((await moveGroup.innerText()).includes('10.50'), 'move-group option omitted its exact cost');
    assert((await remove.innerText()).includes('175.50'), 'remove option omitted its exact refund');
    assert((await defer.innerText()).includes('175.50'), 'defer option omitted its exact refund');
    await captureOrderState('minimum-fixes', false);

    const modalTargets = await fixes.getByRole('button').evaluateAll((nodes) => nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { width: rect.width, height: rect.height, text: node.textContent?.trim() };
    }));
    assert(modalTargets.every(({ width, height }) => width >= 44 && height >= 44),
      `minimum-fix target below 44px at 390px: ${JSON.stringify(modalTargets)}`);
    const moving = await fixes.evaluate((node) => {
      const milliseconds = (value) => Math.max(...value.split(',').map((part) => {
        const duration = Number.parseFloat(part) || 0;
        return part.trim().endsWith('ms') ? duration : duration * 1000;
      }));
      return [node, ...node.querySelectorAll('*')].flatMap((element) => {
        const style = getComputedStyle(element);
        return style.animationName !== 'none' && milliseconds(style.animationDuration) > 20
          ? [{ tag: element.tagName, animation: style.animationName, duration: style.animationDuration }]
          : [];
      });
    });
    assert.deepEqual(moving, [], `minimum-fix panel ignored reduced motion: ${JSON.stringify(moving)}`);

    await page.keyboard.press('Tab');
    const closeFixes = fixes.getByRole('button', { name: 'סגירה' });
    assert(await closeFixes.evaluate((node) => document.activeElement === node), 'Tab did not reach the fix-panel close button');
    const optionButtons = fixes.locator('.dialog-safe-body button');
    await page.keyboard.press('Tab');
    assert(await optionButtons.first().evaluate((node) => document.activeElement === node), 'Tab did not enter the fix options');
    await page.keyboard.press('Tab');
    assert(await optionButtons.nth(1).evaluate((node) => document.activeElement === node), 'Tab did not advance between fix options');
    await page.keyboard.press('Escape');
    await fixes.waitFor({ state: 'hidden' });
    const openerHandle = await fixOpener.elementHandle();
    await page.waitForFunction((node) => document.activeElement === node, openerHandle, { timeout: 3_000 });

    await fixOpener.focus();
    await page.keyboard.press('Enter');
    await fixes.waitFor();
    const moveLineSave = waitForDraftSave();
    await moveLine.click();
    assert((await moveLineSave).ok(), 'moving the line to the alternative supplier was not saved');
    await waitForSaved();
    await fixes.waitFor({ state: 'hidden' });
    await splitSection.getByText('מאפיית הלחם החם', { exact: true }).waitFor();
    assert.equal(await splitSection.getByText('מאפה זהב', { exact: true }).count(), 0,
      'move-line left the source supplier group in the split');
    assert(!(await splitSection.innerText()).includes('חסרים'), 'move-line did not clear the minimum shortfall');
    assert(await page.getByRole('button', { name: 'המשך לסיכום ואישור' }).isEnabled(),
      'move-line resolution did not leave the order eligible for summary');
    const bakeryPick = comparison.getByRole('button', { name: `בחירת מאפיית הלחם החם עבור ${product}` });
    assert.equal(await bakeryPick.getAttribute('aria-pressed'), 'true', 'move-line did not pin the alternative supplier');

    const restoreAutomaticSave = waitForDraftSave();
    await comparison.getByRole('button', { name: 'חזרה לבחירה אוטומטית' }).click();
    assert((await restoreAutomaticSave).ok(), 'returning the moved line to automatic assignment was not saved');
    await waitForSaved();
    await splitSection.getByText('מאפה זהב', { exact: true }).waitFor();
    await fixOpener.waitFor();
    assert.equal(await goldPick.getAttribute('aria-pressed'), 'true',
      'automatic assignment did not return the line to the cheapest supplier');

    await fixOpener.focus();
    await page.keyboard.press('Enter');
    await fixes.waitFor();
    const reopenedFixesHandle = await fixes.elementHandle();
    await page.waitForFunction((node) => document.activeElement === node, reopenedFixesHandle, { timeout: 3_000 });
    const increaseSave = waitForDraftSave();
    await increase.press('Enter');
    assert((await increaseSave).ok(), 'live minimum resolution was not saved');
    await waitForSaved();
    await fixes.getByText('הקבוצה עוברת כעת את מינימום ההזמנה.').waitFor();
    assert((await fixes.innerText()).includes('234.00'), 'live minimum resolution did not update the subtotal');
    await page.keyboard.press('Escape');
    await fixes.waitFor({ state: 'hidden' });

    const restoreUnderMinimumSave = waitForDraftSave();
    await page.getByRole('button', { name: /01.*מוצרים וכמויות/ }).click();
    await page.getByRole('button', { name: `הפחתת כמות ${product}` }).click();
    await page.getByRole('button', { name: 'המשך לספקים' }).click();
    assert((await restoreUnderMinimumSave).ok(), 'restoring the under-minimum basket failed');
    await waitForSaved();
    await splitSection.getByRole('button', { name: /הצג פתרונות/ }).click();
    await fixes.waitFor();

    const deferWrite = page.waitForResponse((response) =>
      response.request().method() === 'POST' && response.url().includes('/rest/v1/next_order_items'));
    const emptyDraftSave = waitForDraftSave();
    await fixes.getByRole('button', { name: /הסר ושמור את "לחמניות המבורגר \(ארגז 48\)" להזמנה הבאה/ }).click();
    assert((await deferWrite).ok(), 'defer did not persist the next-order item');
    await page.getByText('הפריט נשמר להזמנה הבאה', { exact: true }).waitFor();
    assert((await emptyDraftSave).ok(), 'defer did not remove the line from the saved draft');
    await waitForSaved();
    await fixes.waitFor({ state: 'hidden' });
    await page.getByRole('heading', { name: 'בחירת מוצרים' }).waitFor();

    await page.goto(`${baseURL}/orders/new?fresh=1`);
    await settle(page);
    const reminder = page.locator('section[aria-labelledby="next-order-title"]');
    await reminder.waitFor();
    await reminder.getByText(product, { exact: true }).waitFor();
    assert.match(await reminder.innerText(), /כמות\s*3/, 'next-order reminder did not preserve quantity 3');
    await captureOrderState('products');

    const reminderWrites = [];
    const trackReminderRequest = (request) => {
      if (request.method() === 'DELETE' && request.url().includes('/rest/v1/next_order_items')) reminderWrites.push('delete-request');
    };
    const trackReminderResponse = (response) => {
      if (response.ok() && response.request().method() === 'POST'
          && response.url().includes('/rest/v1/rpc/save_purchase_request_draft')) reminderWrites.push('save-response');
    };
    page.on('request', trackReminderRequest);
    page.on('response', trackReminderResponse);
    const reminderSave = waitForDraftSave();
    const reminderDelete = page.waitForResponse((response) =>
      response.request().method() === 'DELETE' && response.url().includes('/rest/v1/next_order_items'));
    await reminder.getByRole('button', { name: 'הוסף להזמנה' }).click();
    assert((await reminderSave).ok(), 'adding the reminder was not saved before dismissal');
    assert((await reminderDelete).ok(), 'adding the reminder did not dismiss its stored row');
    page.off('request', trackReminderRequest);
    page.off('response', trackReminderResponse);
    assert(reminderWrites.indexOf('save-response') >= 0 && reminderWrites.indexOf('save-response') < reminderWrites.indexOf('delete-request'),
      `next-order reminder was deleted before its draft save: ${JSON.stringify(reminderWrites)}`);
    await reminder.waitFor({ state: 'hidden' });
    await page.waitForURL((url) => url.pathname === '/orders/new' && url.searchParams.has('draft'), { timeout: 25_000 });
    await waitForSaved();
    // The cart quantity is an editable `input[type=number]` since the steppers converged, so it
    // lives in `value` and not in a text node — `innerText` on a spinbutton is always empty.
    // Reading it by role also pins WHAT the control is, which the raw attribute selector did not.
    assert(await page.getByRole('spinbutton', { name: `כמות ${product}` }).inputValue() === '3',
      'reminder did not restore quantity 3 to the cart');

    const restoredStepTwoSave = waitForDraftSave();
    await page.getByRole('button', { name: 'המשך לספקים' }).click();
    assert((await restoredStepTwoSave).ok(), 'saving the restored reminder basket failed');
    await waitForSaved();
    await splitSection.getByText('מאפה זהב', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'המשך לסיכום ואישור' }).click();
    await page.getByRole('heading', { name: 'סיכום ההזמנה' }).waitFor();

    const summaryStep = page.getByRole('button', { name: /03.*סיכום ואישור/ });
    assert.equal(await summaryStep.getAttribute('aria-current'), 'step', 'summary step did not become current');
    assert.equal(await page.getByRole('dialog', { name: 'סיכום ההזמנה' }).count(), 0, 'summary regressed to a review dialog');
    const minimumSummary = page.locator('section[aria-labelledby="minimum-summary-title"]');
    await minimumSummary.getByRole('heading', { name: /1 ספקים מתחת למינימום ההזמנה שלהם.*תישלח כרגיל/ }).waitFor();
    assert((await minimumSummary.innerText()).includes('24.50'), 'summary omitted the exact supplier shortfall');
    const confirm = page.getByRole('button', { name: 'אשר ושלח הזמנות' });
    assert(await confirm.isEnabled(), 'supplier minimum incorrectly blocked final approval');
    assert.equal(await page.getByText('סיבת אישור ההזמנה').count(), 0, 'routine order approval asks for a reason');
    await captureOrderState('summary');

    await qualitySupplierPrice(60);
    const firstPriceReject = page.waitForResponse((response) =>
      response.request().method() === 'POST'
      && response.url().includes('/rest/v1/rpc/finalize_purchase_request_draft'));
    await confirm.click();
    assert.equal((await firstPriceReject).status(), 400, 'first changed price did not reject the stale total');
    const priceDiff = page.getByRole('dialog', { name: 'המחירים השתנו' });
    await priceDiff.waitFor({ timeout: 25_000 });
    const priceLine = priceDiff.getByText(product, { exact: true }).locator('..').locator('..');
    const normalizeMoneyText = (value) => value.replace(/[\u061c\u200e\u200f]/g, '').replace(/\s+/g, ' ').trim();
    const firstLineText = normalizeMoneyText(await priceLine.innerText());
    const firstPriceText = normalizeMoneyText(await priceDiff.innerText());
    assert.match(firstLineText, /לפני · מאפה זהב 58\.50 ₪ ליחידה ← עכשיו · מאפה זהב 60\.00 ₪ ליחידה \+4\.50 ₪/,
      'first price diff reversed or mislabeled the unit-price change');
    assert.match(firstLineText, /סכום שורה: 175\.50 ₪ ← 180\.00 ₪/,
      'first price diff reversed or omitted the line totals');
    assert.match(firstPriceText, /סכום ההזמנה 175\.50 ₪ ← 180\.00 ₪ · \+4\.50 ₪/,
      'first price diff reversed or omitted the order totals');
    await captureOrderState('price-change', false);
    await priceDiff.getByRole('button', { name: 'חזרה לסיכום ולאישור מחדש' }).click();
    await priceDiff.waitFor({ state: 'hidden' });

    await qualitySupplierPrice(61.5);
    const secondPriceReject = page.waitForResponse((response) =>
      response.request().method() === 'POST'
      && response.url().includes('/rest/v1/rpc/finalize_purchase_request_draft'));
    await confirm.click();
    assert.equal((await secondPriceReject).status(), 400, 'second changed price did not reject the stale total');
    await priceDiff.waitFor({ timeout: 25_000 });
    const secondLineText = normalizeMoneyText(await priceLine.innerText());
    const secondPriceText = normalizeMoneyText(await priceDiff.innerText());
    assert.match(secondLineText, /לפני · מאפה זהב 60\.00 ₪ ליחידה ← עכשיו · מאפה זהב 61\.50 ₪ ליחידה \+4\.50 ₪/,
      'second price diff reversed or mislabeled the unit-price change');
    assert.match(secondLineText, /סכום שורה: 180\.00 ₪ ← 184\.50 ₪/,
      'second price diff reversed or omitted the line totals');
    assert.match(secondPriceText, /סכום ההזמנה 180\.00 ₪ ← 184\.50 ₪ · \+4\.50 ₪/,
      'second price diff reversed or omitted the order totals');
    await priceDiff.getByRole('button', { name: 'חזרה לסיכום ולאישור מחדש' }).click();
    await priceDiff.waitFor({ state: 'hidden' });

    const finalize = page.waitForResponse((response) =>
      response.request().method() === 'POST'
      && response.url().includes('/rest/v1/rpc/finalize_purchase_request_draft'));
    await confirm.click();
    assert((await finalize).ok(), 'under-minimum draft was rejected during finalize');
    const sendQueue = page.getByRole('dialog', { name: 'שליחת הזמנות לספקים' });
    await sendQueue.waitFor({ timeout: 25_000 });
    await sendQueue.getByText('מאפה זהב', { exact: true }).waitFor();
    // 'פתיחת WhatsApp', not 'שליחה ב-WhatsApp' (H5, 10.08.2026). Opening the WhatsApp window
    // prepares a message; only the operator knows whether it was actually sent, so marking the
    // order sent is a second, explicit confirmation rather than a side effect of a link opening.
    await sendQueue.getByRole('button', { name: 'פתיחת WhatsApp' }).waitFor();
    // Two-message flow (18.08.2026): the row button now opens a numbered two-step dialog. The
    // image step is exercised for real — this is the only place the offscreen html2canvas render
    // meets an actual layout engine, so the PNG must exist and be non-trivial. Step 1 is only
    // asserted present: clicking it would open wa.me in a new tab, which a smoke has no use for.
    await sendQueue.getByRole('button', { name: 'פתיחת WhatsApp' }).first().click();
    const waDialog = page.getByRole('dialog', { name: /שליחת הזמנה #\d+ ב-WhatsApp/ });
    await waDialog.waitFor({ timeout: 25_000 });
    await waDialog.getByRole('button', { name: '1. שליחת הודעת הטקסט' }).waitFor();
    const orderImageButton = waDialog.getByRole('button', { name: '2. הורדת תמונת ההזמנה' });
    const downloadEvent = page.waitForEvent('download', { timeout: 25_000 });
    await orderImageButton.click(); // auto-waits for the render to enable the button
    const orderImageDownload = await downloadEvent;
    assert(orderImageDownload.suggestedFilename().endsWith('.png'),
      `order image download is not a PNG (${orderImageDownload.suggestedFilename()})`);
    const orderImageBytes = require('node:fs').statSync(await orderImageDownload.path()).size;
    assert(orderImageBytes > 20_000, `order image PNG suspiciously small (${orderImageBytes} bytes)`);
    await waDialog.getByRole('button', { name: 'סיום' }).click();
    await sendQueue.getByRole('button', { name: 'פתיחת WhatsApp' }).first().waitFor();
  } finally {
    try {
      await qualitySupplierPrice(58.5);
    } finally {
      await closeContext(context);
    }
  }
}

async function paymentRequestNamesAndModalStack(browser) {
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 1024, height: 768 } });
  const supplierId = '94000000-0000-4000-8000-000000000001';
  const request = {
    id: 'p4-request', org_id: 'p4-org', supplier_id: supplierId, number: 7001, amount: 850,
    due_date: '2026-07-30', status: 'draft', notes: 'בדיקת שכבות', created_at: '2026-07-22T08:00:00Z',
    supplier: { name: 'ספק בדיקת שכבות' },
  };
  await context.route('**/rest/v1/payment_requests?**', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: [request] }));
  await context.route('**/rest/v1/payment_request_invoices?**', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: [] }));
  await context.route('**/rest/v1/financial_supplier_directory?**', (route) => route.fulfill({
    status: 200,
    headers: jsonHeaders,
    json: [{ id: supplierId, name: 'ספק בדיקת שכבות', tax_id: null, payment_terms: null, status: 'active', bank_details: null }],
  }));
  await context.route('**/rest/v1/invoices?**', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: [{ id: 'p4-invoice', supplier_id: supplierId, invoice_number: 'INV-P4-01', invoice_date: '2026-07-01', total_amount: 850, review_status: 'approved' }] }));
  await context.route('**/rest/v1/invoice_balances?**', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: [{ invoice_id: 'p4-invoice', balance: 850 }] }));
  await context.route('**/rest/v1/bank_transactions?**', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: [] }));
  await context.route('**/rest/v1/credit_requests?**', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: [] }));
  await context.route('**/rest/v1/rpc/payment_request_financial_check_signals', (route) => route.fulfill({
    status: 200,
    headers: jsonHeaders,
    json: {
      requested_invoice_count: 1,
      visible_invoice_count: 1,
      paid_invoice_count: 0,
      unapproved_invoice_count: 0,
      amount_matches_open_balance: true,
      similar_bank_transfer_check: 'unavailable',
      open_credit_total: 0,
    },
  }));
  const page = await context.newPage();
  captureConsole(page, 'payment-request-modal');
  try {
    await login(page, 'owner');
    await page.goto(`${baseURL}/payment-requests`);
    await settle(page);
    const opener = page.getByRole('button', { name: 'פתיחת דרישת תשלום מספר 7001 עבור ספק בדיקת שכבות' });
    await opener.click();
    const parent = page.getByRole('dialog', { name: /דרישת תשלום #7001/ });
    await parent.waitFor();
    await parent.getByRole('button', { name: 'ביטול', exact: true }).click();
    const child = page.getByRole('dialog', { name: 'ביטול דרישת תשלום' });
    await child.waitFor();
    assert.equal(await page.getByRole('dialog').count(), 2, 'nested modal stack is not preserved');
    await page.keyboard.press('Shift+Tab');
    assert(await child.evaluate((node) => node.contains(document.activeElement)), 'focus escaped the top modal');
    await page.keyboard.press('Escape');
    await child.waitFor({ state: 'hidden' });
    assert(await parent.isVisible(), 'Escape closed more than the top modal');
    await page.keyboard.press('Escape');
    await parent.waitFor({ state: 'hidden' });
    const openerHandle = await opener.elementHandle();
    await page.waitForFunction((node) => document.activeElement === node, openerHandle, { timeout: 3_000 });
    assert(await opener.evaluate((node) => document.activeElement === node), 'nested modal did not restore opener focus');

    const createButton = page.getByRole('button', { name: 'דרישה חדשה' });
    await createButton.click();
    const create = page.getByRole('dialog', { name: 'דרישת תשלום חדשה' });
    await create.locator('#payment-request-supplier').selectOption(supplierId);
    const checkbox = create.getByRole('checkbox', { name: 'בחירת חשבונית INV-P4-01 של ספק בדיקת שכבות להקצאה בדרישת התשלום' });
    await checkbox.waitFor({ timeout: 20_000 });
    await checkbox.check();
    await create.getByRole('spinbutton', { name: 'סכום ההקצאה לחשבונית INV-P4-01 של ספק בדיקת שכבות' }).waitFor();
    await page.keyboard.press('Escape');
    await create.waitFor({ state: 'hidden' });
  } finally {
    await closeContext(context);
  }
}

async function bankContextualNames(browser) {
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 1024, height: 768 } });
  const supplierId = '94000000-0000-4000-8000-000000000002';
  const transaction = {
    id: 'p4-bank-row', org_id: 'p4-bank-org', import_id: 'p4-bank-import', tx_date: '2026-07-20',
    amount: 850, description: 'העברה לספק בדיקת נגישות', reference: 'P4-REF',
    row_hash: 'p4-bank-row-hash', supplier_id: supplierId, status: 'unmatched',
    created_at: '2026-07-20T08:00:00Z', supplier: { name: 'ספק בדיקת נגישות' },
  };
  await context.route('**/rest/v1/bank_transactions?**', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: [transaction] }));
  await context.route('**/rest/v1/bank_imports?**', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: [] }));
  await context.route('**/rest/v1/financial_supplier_directory?**', (route) => route.fulfill({
    status: 200,
    headers: jsonHeaders,
    json: [{ id: supplierId, name: 'ספק בדיקת נגישות', tax_id: null, payment_terms: null, status: 'active', bank_details: null }],
  }));
  await context.route('**/rest/v1/payments?**', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: [] }));
  await context.route('**/rest/v1/bank_allocations?**', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: [] }));
  await context.route('**/rest/v1/invoices?**', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: [{
    id: 'p4-bank-invoice', supplier_id: supplierId, invoice_number: 'BANK-P4-01',
    invoice_date: '2026-07-18', total_amount: 850,
  }] }));
  await context.route('**/rest/v1/invoice_balances?**', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: [{ invoice_id: 'p4-bank-invoice', balance: 850 }] }));
  const page = await context.newPage();
  captureConsole(page, 'bank-accessibility');
  try {
    await login(page, 'owner');
    await page.goto(`${baseURL}/bank`);
    await settle(page);
    const row = page.locator('button[aria-label^="פתיחת תנועת בנק "]').first();
    await row.waitFor({ timeout: 20_000 });
    await row.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'התאמת תנועת בנק' });
    await dialog.waitFor();
    await dialog.getByText(/BANK-P4-01/).first().waitFor({ timeout: 20_000 });
    const contextualButtons = dialog.locator('button[aria-label^="אישור "]');
    const contextualChecks = dialog.locator('input[type="checkbox"][aria-label^="בחירת חשבונית "]');
    const contextualAmounts = dialog.locator('input[type="number"][aria-label^="סכום ההקצאה "]');
    assert(
      await contextualButtons.count() + await contextualChecks.count() + await contextualAmounts.count() > 0,
      'bank dialog exposed no record-specific accessible control',
    );
    await page.screenshot({ path: path.join(outDir, 'bank-match-dialog.png'), fullPage: true });
    report.screenshots.push('bank-match-dialog.png');
    await auditAccessibility(page, 'bank-match-dialog');
  } finally {
    await closeContext(context);
  }
}

async function alertsPartialFailure(browser) {
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  let notificationPatches = 0;
  await context.route('**/rest/v1/rpc/p2_duplicate_invoice_group_count*', (route) => route.fulfill({
    status: 500, headers: jsonHeaders, json: { code: 'P4_FORCED', message: 'forced partial scan' },
  }));
  await context.route('**/rest/v1/notifications?**', (route) => {
    if (route.request().method() === 'PATCH') notificationPatches += 1;
    return route.continue();
  });
  const page = await context.newPage();
  captureConsole(page, 'alerts-partial', [/HTTP 500 .*p2_duplicate_invoice_group_count/]);
  try {
    await login(page, 'owner');
    await page.goto(`${baseURL}/alerts`);
    await settle(page);
    const body = await page.locator('#main').innerText();
    assert(body.includes('הסריקה חלקית') || body.includes('אין אפשרות לקבוע שהכול תקין'), 'partial alert failure was not disclosed');
    assert(!body.includes('לא נמצאו התראות פתוחות בבדיקות שהמערכת יודעת להריץ'), 'partial scan displayed a false all-clear');
    await page.waitForTimeout(400);
    assert.equal(notificationPatches, 0, 'partial alert scan marked notifications as read');
    await page.screenshot({ path: path.join(outDir, 'alerts-partial-390.png'), fullPage: true });
    report.screenshots.push('alerts-partial-390.png');
  } finally {
    await closeContext(context);
  }
}

async function settingsFalseSuccess(browser) {
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 1024, height: 768 } });
  await context.route('**/rest/v1/rpc/manage_profile_access*', (route) => route.fulfill({
    status: 500, headers: jsonHeaders, json: { code: 'P4_FORCED', message: 'forced settings failure' },
  }));
  const page = await context.newPage();
  captureConsole(page, 'settings-failure', [/HTTP 500 .*manage_profile_access/, /forced settings failure/]);
  try {
    await login(page, 'owner');
    await page.goto(`${baseURL}/settings`);
    await settle(page);
    /*
     * The roster is a DataTable now, and its row actions are the shared ActionMenu (`rowActions`,
     * the connection ADR-0007 gave the table). So 'השבתה' is no longer a button sitting in the
     * row: it is one of that row's TWO actions — 'שינוי תפקיד' and 'השבתה'/'הפעלה' — behind a
     * permanently visible 44px kebab named after the person. That is the sanctioned surface, not a
     * hover reveal: DESIGN.md's ActionMenu section requires a destructive action to be visible
     * whenever the menu is open, and it is.
     *
     * What this scenario is actually about is unchanged and is asserted below: a failed mutation
     * must not close the dialog, must not claim success, and must not repaint the row. Only the
     * two clicks that reach the dialog moved.
     */
    const userRow = page.getByRole('row').filter({ has: page.getByRole('button', { name: /^פעולות עבור / }) }).first();
    /*
     * Scroll FIRST, then click — and the order is load-bearing, not tidiness.
     *
     * `ActionMenu` closes on scroll by design (DESIGN.md: the anchor moved, so closing is honest
     * and cheaper than repositioning). The roster sits far down a long settings page, so
     * `.click()` scrolls the row into view itself — and Chromium dispatches that scroll's event on
     * the next frame, which is AFTER the click's handlers have already opened the menu. The menu
     * then closes itself and the run reports a menu that "never opened". Measured here at 1024x768
     * on 26.08.2026. Scrolling and letting it settle first removes a scroll the automation
     * invents; it does not stand in for anything a person does.
     */
    await userRow.scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    await userRow.getByRole('button', { name: /^פעולות עבור / }).click();
    // The menu is portalled to document.body, so it is addressed on the page, not inside the row.
    const deactivate = page.getByRole('menuitem', { name: 'השבתה' });
    await deactivate.waitFor({ timeout: 10_000 });
    await deactivate.click();
    const dialog = page.getByRole('dialog', { name: 'השבתת משתמש' });
    await dialog.getByRole('textbox', { name: /סיבה/ }).fill('בדיקת כשל רשת מקומי');
    await dialog.getByRole('button', { name: 'השבתה' }).click();
    await page.getByRole('alert').waitFor({ timeout: 10_000 });
    assert(await dialog.isVisible(), 'failed mutation closed the confirmation dialog');
    assert.equal(await page.getByText('המשתמש הושבת', { exact: true }).count(), 0, 'failed mutation displayed success');
    assert.equal(await userRow.getByText('פעיל', { exact: true }).count(), 1, 'failed mutation changed the rendered status');
  } finally {
    await closeContext(context);
  }
}

async function bootstrapRetry(browser) {
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 1024, height: 768 } });
  let allowBootstrap = false;
  await context.route('**/rest/v1/profiles?**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const bootstrap = request.method() === 'GET' && url.searchParams.get('select') === '*' && (url.searchParams.get('id') || '').startsWith('eq.');
    if (bootstrap && !allowBootstrap) {
      return route.fulfill({ status: 503, headers: jsonHeaders, json: { code: 'P4_FORCED', message: 'temporary bootstrap failure' } });
    }
    return route.continue();
  });
  const page = await context.newPage();
  captureConsole(page, 'bootstrap-retry', [/HTTP 503 .*\/profiles\?/, /temporary bootstrap failure/]);
  try {
    const account = credentials('owner');
    await page.goto(`${baseURL}/login`);
    await page.locator('#email').fill(account.email);
    await page.locator('#password').fill(account.password);
    await page.getByRole('button', { name: 'התחברות' }).click();
    await page.getByRole('heading', { name: 'לא ניתן לטעון את החשבון' }).waitFor({ timeout: 25_000 });
    assert(!new URL(page.url()).pathname.startsWith('/login'), 'temporary bootstrap failure forced logout');
    allowBootstrap = true;
    await page.getByRole('button', { name: 'ניסיון חוזר' }).click();
    await page.waitForURL((url) => url.pathname === '/dashboard', { timeout: 25_000 });
    await page.locator('#main').waitFor({ state: 'visible', timeout: 25_000 });
    assert.equal(new URL(page.url()).pathname, '/dashboard', 'bootstrap retry did not recover the session');
  } finally {
    await closeContext(context);
  }
}

async function lazyChunkRecovery(browser) {
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 1024, height: 768 } });
  const page = await context.newPage();
  captureConsole(page, 'lazy-recovery', [/Failed to fetch dynamically imported module/, /\/assets\/Bank-[^/]+\.js/]);
  try {
    await login(page, 'owner');
    const chunkPattern = '**/assets/Bank-*.js';
    await context.route(chunkPattern, (route) => route.abort('failed'));
    await page.goto(`${baseURL}/bank`);
    const boundary = page.getByRole('alert').filter({ hasText: 'לא ניתן לטעון את המסך' });
    await boundary.waitFor({ timeout: 20_000 });
    const recovery = boundary.getByRole('button', { name: 'רענון וטעינה מחדש' });
    assert.equal(await recovery.count(), 1, 'lazy chunk error has no recovery action');
    await context.unroute(chunkPattern);
    await recovery.click();
    await page.getByRole('heading', { name: 'התאמות בנק' }).waitFor({ timeout: 25_000 });
  } finally {
    await closeContext(context);
  }
}

async function reportsAndPdf(browser) {
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  captureConsole(page, 'reports-pdf');
  try {
    await login(page, 'accountant');
    await page.goto(`${baseURL}/reports`);
    await settle(page);
    const table = page.locator('table.report-invoices');
    await table.waitFor();
    const headings = (await table.locator('thead th').allTextContents()).map((value) => value.trim());
    // Eleven since 19.08.2026 (owner review, defect 12): the printed sheet promised eight columns
    // while the screen showed more, so the accountant was reconciling from a narrower page than the
    // one they had been looking at. תאריך קליטה, שולם and יתרה joined the grid; הערות went to a
    // print-only second row per invoice rather than a twelfth column, because twelve columns across
    // 279mm of A4 landscape leaves 23mm each and breaks the supplier name.
    assert.equal(headings.length, 11, `monthly print report has ${headings.length}/11 columns`);
    for (const required of ['שולם', 'יתרה', 'תאריך קליטה']) {
      assert.ok(headings.includes(required), `printed report lost the ${required} column: ${headings.join(' · ')}`);
    }
    // The screen defaults to the CURRENT month, and the demo fixture's invoices are dated June-July,
    // so on this tenant the printed sheet is usually an empty month. This assertion used to demand a
    // totals row unconditionally and therefore pinned a `סה״כ ₪0.00 ₪0.00 ₪0.00` line standing over
    // an empty body — straight onto the PDF the accountant receives. Assert what the screen actually
    // promises in each state instead: totals when there is something to total, and a named empty row
    // with NO totals when there is not.
    const invoiceRows = await table.locator('tbody tr').count();
    const emptyRow = table.locator('tbody tr', { hasText: 'אין חשבוניות בחודש זה' });
    if (await emptyRow.count()) {
      assert.equal(invoiceRows, 1, 'empty monthly report renders rows beside its empty sentence');
      assert.equal(await table.locator('tfoot').count(), 0, 'monthly report totals a month with no invoices');
    } else {
      assert(invoiceRows > 0, 'monthly print report has neither invoice rows nor an empty sentence');
      assert((await table.locator('tfoot').innerText()).trim(), 'monthly print report has no totals row');
    }
    await page.emulateMedia({ media: 'print' });
    await page.screenshot({ path: path.join(outDir, 'reports-print.png'), fullPage: true });
    report.screenshots.push('reports-print.png');
    const pdfPath = path.join(outDir, 'monthly-report.pdf');
    await page.pdf({ path: pdfPath, printBackground: true, preferCSSPageSize: true });
    const bytes = fs.statSync(pdfPath).size;
    assert(bytes > 5_000, `monthly report PDF is unexpectedly small (${bytes} bytes)`);
    report.pdf = { file: 'monthly-report.pdf', bytes, headings };
  } finally {
    await closeContext(context);
  }
}

async function pwaUpdate(browser) {
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'allow', viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await page.goto(`${baseURL}/login`);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
      }
      window.__p4Marker = 'preserved';
      window.__p4Loads = (window.__p4Loads || 0) + 1;
    });
    const before = await page.evaluate(() => ({ marker: window.__p4Marker, loads: window.__p4Loads }));
    await page.evaluate(async () => navigator.serviceWorker.register(`/sw.js?p4-update=${Date.now()}`, { scope: '/' }));
    await page.getByText('גרסה חדשה מוכנה').waitFor({ timeout: 20_000 });
    const after = await page.evaluate(() => ({ marker: window.__p4Marker, loads: window.__p4Loads }));
    assert.deepEqual(after, before, 'PWA update reloaded or erased the open tab');
    assert.equal(await page.getByRole('button', { name: 'רענון' }).count(), 1, 'PWA update notice lacks one refresh action');
  } finally {
    await closeContext(context);
  }
}

async function pushLogout(browser, name, serverSuccess, localSuccess) {
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'allow', viewport: { width: 1440, height: 900 } });
  await context.addInitScript(({ localSuccess }) => {
    const registration = {
      pushManager: {
        getSubscription: async () => ({
          endpoint: 'https://push.invalid/p4-local-endpoint',
          unsubscribe: async () => {
            window.__p4UnsubscribeCalls = (window.__p4UnsubscribeCalls || 0) + 1;
            return localSuccess;
          },
        }),
      },
    };
    Object.defineProperty(ServiceWorkerContainer.prototype, 'getRegistration', { configurable: true, value: async () => registration });
  }, { localSuccess });
  await context.route('**/rest/v1/push_subscriptions?**', (route) => {
    if (serverSuccess) return route.fulfill({ status: 200, headers: jsonHeaders, json: [{ id: 'p4-local-row' }] });
    return route.fulfill({ status: 500, headers: jsonHeaders, json: { code: 'P4_FORCED', message: 'forced push cleanup failure' } });
  });
  const page = await context.newPage();
  // Push cleanup runs BEFORE auth.signOut and can take long enough for an exact Dashboard read to
  // start after the click while the authenticated screen is still mounted. auth.signOut can then
  // revoke that request before its response. Keep the exception structural: exact endpoint and
  // method, a Bearer header, an exact Request object observed while transition tracking is open,
  // and a 401 observed only after logout began. Do not infer lifecycle from `page.url()`: Chromium
  // can commit /login before Playwright delivers the request event for a read the old shell began.
  const logoutTransitionReads = new Map([
    ['/rest/v1/invoices', 'GET'],
    ['/rest/v1/payments', 'GET'],
    ['/rest/v1/purchase_orders', 'GET'],
    ['/rest/v1/exceptions', 'GET'],
    ['/rest/v1/supplier_products', 'GET'],
    ['/rest/v1/purchase_request_items', 'GET'],
    ['/rest/v1/rpc/management_dashboard_snapshot', 'POST'],
    ['/rest/v1/suppliers', 'GET'],
    ['/rest/v1/purchase_order_items', 'GET'],
  ]);
  const authenticatedTransitionReads = new WeakSet();
  let transitionReadTrackingOpen = true;
  let logoutStarted = false;
  page.on('request', (request) => {
    if (!transitionReadTrackingOpen) return;
    const url = new URL(request.url());
    const authorization = request.headers().authorization ?? '';
    if (
      authorization.startsWith('Bearer ')
      && url.origin === apiURL
      && logoutTransitionReads.get(url.pathname) === request.method()
    ) {
      authenticatedTransitionReads.add(request);
    }
  });
  captureConsole(page, `push:${name}`, [/HTTP 500 .*push_subscriptions/], (response) => {
    if (!logoutStarted || response.status() !== 401) return false;
    const request = response.request();
    const url = new URL(response.url());
    return url.origin === apiURL
      && logoutTransitionReads.get(url.pathname) === request.method()
      && authenticatedTransitionReads.has(request);
  });
  try {
    await login(page, 'owner');
    // T7.3: the desktop shell is the floating pill nav — signing out lives inside the account
    // menu behind the avatar, not on a permanent sidebar strip. Open it, then sign out.
    await page.getByRole('button', { name: /^תפריט החשבון של/ }).click();
    logoutStarted = true;
    await page.getByRole('button', { name: 'התנתקות' }).click();
    await page.waitForURL((url) => url.pathname === '/login', { timeout: 25_000 });
    // The transition is now settled. New reads, even with a stale Bearer header, must fail the
    // console gate; responses for exact requests already in the WeakSet remain transition reads.
    transitionReadTrackingOpen = false;
    await page.waitForTimeout(250);
    const body = await page.locator('body').innerText();
    const expected = serverSuccess && localSuccess ? null
      : localSuccess ? 'מנוי ההתראות במכשיר בוטל, אך ניקוי הרשומה בשרת לא אומת'
        : serverSuccess ? 'רשומת ההתראות בשרת הוסרה, אך ביטול המנוי בדפדפן לא אומת'
          : 'ניקוי מנוי ההתראות נכשל בשרת ובדפדפן';
    if (expected) assert(body.includes(expected), `${name}: truthful Push cleanup warning missing`);
    else assert(!body.includes('ניקוי מנוי ההתראות') && !body.includes('לא אומת'), `${name}: false Push cleanup warning`);
    assert.equal(await page.evaluate(() => window.__p4UnsubscribeCalls || 0), 1, `${name}: local unsubscribe was not attempted exactly once`);
  } finally {
    transitionReadTrackingOpen = false;
    await closeContext(context);
  }
}

async function adminState(browser) {
  // The console left the tenant application (defect 14): /admin no longer exists there, and the
  // operator surface is the second Vite entry served at /operator. The platform membership is
  // mocked, so this exercises the operator app's guard and screens with a real signed-in session.
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 1024, height: 900 } });
  await context.route('**/rest/v1/platform_admins?**', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: { user_id: 'p4-platform-admin' } }));
  await context.route('**/rest/v1/rpc/is_platform_admin*', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: true }));
  await context.route('**/rest/v1/rpc/platform_orgs*', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: [] }));
  await context.route('**/functions/v1/admin-provision*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    return route.fulfill({ status: 200, headers: jsonHeaders, json: { org_id: 'p4-org', owner_user_id: 'p4-owner', categories_created: 2 } });
  });
  const page = await context.newPage();
  captureConsole(page, 'admin-state');
  try {
    await login(page, 'owner');
    await page.goto(`${baseURL}/operator`);
    await page.getByRole('heading', { name: 'ניהול פלטפורמה' }).waitFor({ timeout: 20_000 });
    const opener = page.getByRole('button', { name: 'ארגון חדש' });
    await opener.click();
    let dialog = page.getByRole('dialog', { name: 'הקמת ארגון חדש' });
    await dialog.locator('#new-org-name').fill('ערך שחייב להתאפס');
    await dialog.locator('#new-org-password').fill('P4-close-reset-check!');
    await dialog.getByRole('button', { name: 'ביטול' }).click();
    await opener.click();
    dialog = page.getByRole('dialog', { name: 'הקמת ארגון חדש' });
    assert.equal(await dialog.locator('#new-org-name').inputValue(), '', 'admin form retained organization name after close');
    assert.notEqual(await dialog.locator('#new-org-password').inputValue(), 'P4-close-reset-check!', 'admin form retained password after close');

    await dialog.locator('#new-org-name').fill('ארגון בדיקת P4');
    await dialog.locator('#new-org-owner-name').fill('בעלים בדיקה');
    await dialog.locator('#new-org-owner-email').fill('p4-owner@example.invalid');
    await dialog.locator('#new-org-password').fill('P4-success-reset-check!');
    await dialog.getByRole('button', { name: 'הקמה' }).click();
    await page.waitForFunction(() => document.querySelector('[role="dialog"][aria-busy="true"]'));
    await page.keyboard.press('Escape');
    assert(await dialog.isVisible(), 'busy admin modal closed on Escape');
    const handover = page.getByRole('dialog', { name: 'הארגון הוקם — פרטי כניסה למסירה' });
    await handover.waitFor({ timeout: 20_000 });
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async () => { throw new Error('blocked'); } },
    }));
    await handover.getByRole('button', { name: 'העתקת אימייל' }).click();
    await page.getByText('ההעתקה נכשלה — יש להעתיק ידנית').waitFor();
    await handover.locator('button.btn-primary').filter({ hasText: 'סגירה' }).click();
    await opener.click();
    dialog = page.getByRole('dialog', { name: 'הקמת ארגון חדש' });
    assert.notEqual(await dialog.locator('#new-org-password').inputValue(), 'P4-success-reset-check!', 'admin form retained password after success');
  } finally {
    await closeContext(context);
  }
}

async function publicSignupSurface(browser) {
  // The anonymous door, checked for the two things that make it safe to have at all: the form
  // cannot ask for a plan, and the answer is identical whether or not the address already exists.
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  let sent = null;
  await context.route('**/functions/v1/public-signup*', async (route) => {
    sent = JSON.parse(route.request().postData() || '{}');
    return route.fulfill({
      status: 202,
      headers: jsonHeaders,
      json: {
        status: 'pending_confirmation',
        message: 'אם הכתובת אינה רשומה עדיין — נשלח אליה מייל אישור, ויש להשלים ממנו את ההרשמה. אם היא כבר רשומה — יש להיכנס עם הסיסמה הקיימת או לאפס אותה.',
      },
    });
  });

  const page = await context.newPage();
  captureConsole(page, 'public-signup');
  try {
    await page.goto(`${baseURL}/signup`);
    await page.getByRole('heading', { level: 1, name: /פתיחת חשבון/ }).waitFor({ timeout: 20_000 });

    // No plan, tier or price control anywhere on the page: choosing one would be a free upgrade.
    const body = await page.content();
    for (const forbidden of ['Business', 'Pro ', 'מסלול Free']) {
      assert(!body.includes(forbidden), `the signup form offers a plan choice (${forbidden})`);
    }

    await page.locator('#signup-organization').fill('עסק בדיקה');
    await page.locator('#signup-name').fill('בעלים בדיקה');
    await page.locator('#signup-email').fill('p4-signup@example.invalid');
    await page.locator('#signup-password').fill('a-long-enough-password');
    await page.getByRole('button', { name: 'פתיחת חשבון' }).click();

    await page.getByText('בדקו את תיבת הדואר').waitFor({ timeout: 20_000 });
    assert(sent !== null, 'the signup form sent nothing');
    assert.deepEqual(
      Object.keys(sent).sort(),
      ['email', 'full_name', 'organization_name', 'password'],
      'the signup form sent a field the visitor does not get to choose',
    );

    await auditAccessibility(page, 'public-signup');
  } finally {
    await closeContext(context);
  }
}

async function operatorCustomers(browser) {
  // The customer list, and the two things about it that are easy to get wrong:
  //   * a customer that never acted must read as an em dash, not a date and not a zero;
  //   * an operator without customer.view must be told so, because platform_customers() answers
  //     that caller with zero rows and an empty table would claim the platform has no customers.
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  await context.route('**/rest/v1/platform_admins?**', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: { user_id: 'p4-platform-admin' } }));
  await context.route('**/rest/v1/rpc/is_platform_admin*', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: true }));
  await context.route('**/rest/v1/rpc/platform_offboarding_requests*', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: [] }));

  let capabilities = ['customer.view', 'org.lifecycle'];
  await context.route('**/rest/v1/rpc/platform_my_capabilities*', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: capabilities }));
  await context.route('**/rest/v1/rpc/platform_operators*', (route) => route.fulfill({
    status: 200, headers: jsonHeaders,
    json: [{ user_id: 'p4-operator', email: 'ops@inplace.invalid', note: null, roles: ['customer_ops'] }],
  }));
  await context.route('**/rest/v1/rpc/platform_customer_detail*', (route) => route.fulfill({
    status: 200,
    headers: jsonHeaders,
    json: {
      org_id: 'p4-customer-active', name: 'לקוח פעיל בבדיקה', status: 'active', vat_rate: 18,
      created_at: '2026-02-01T08:00:00.000Z', access_mode: 'active', active_user_count: 4,
      last_activity_at: '2026-08-18T09:30:00.000Z', internal_owner: null,
      internal_owner_email: null, customer_since: null, open_follow_up_count: 0,
      offboarding_status: null,
    },
  }));
  await context.route('**/rest/v1/rpc/platform_customer_contacts*', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: [] }));
  await context.route('**/rest/v1/rpc/platform_customer_notes*', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: [] }));
  await context.route('**/rest/v1/rpc/platform_customer_timeline*', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: [] }));
  await context.route('**/rest/v1/rpc/platform_customer_onboarding*', (route) => route.fulfill({
    status: 200,
    headers: jsonHeaders,
    json: [
      { step_key: 'suppliers_imported', label: 'ספקים הוזנו', sort_order: 20, state: 'completed',
        source: 'product_event', achieved_at: '2026-02-05T08:00:00.000Z', reason: null,
        recorded_by_email: null, recorded_at: null },
      { step_key: 'team_invited', label: 'הצוות הוזמן', sort_order: 50, state: 'not_started',
        source: 'none', achieved_at: null, reason: null, recorded_by_email: null, recorded_at: null },
    ],
  }));
  await context.route('**/rest/v1/rpc/platform_customer_health*', (route) => route.fulfill({
    status: 200,
    headers: jsonHeaders,
    json: {
      org_id: 'p4-customer-active', status: 'needs_attention',
      evaluated_at: '2026-08-19T18:00:00.000Z', last_activity_at: '2026-08-05T10:00:00.000Z',
      signals: [{ code: 'activity_slowing', severity: 'warn',
                  detail: 'הפעילות האחרונה הייתה לפני יותר משבועיים' }],
    },
  }));
  await context.route('**/rest/v1/rpc/platform_customers*', (route) => route.fulfill({
    status: 200,
    headers: jsonHeaders,
    json: [
      {
        id: 'p4-customer-active', name: 'לקוח פעיל בבדיקה', status: 'active', vat_rate: 18,
        created_at: '2026-02-01T08:00:00.000Z', active_user_count: 4,
        last_activity_at: '2026-08-18T09:30:00.000Z', offboarding_status: null, total_count: 2,
      },
      {
        id: 'p4-customer-silent', name: 'לקוח ללא פעילות בבדיקה', status: 'active', vat_rate: 18,
        created_at: '2026-03-01T08:00:00.000Z', active_user_count: 0,
        last_activity_at: null, offboarding_status: null, total_count: 2,
      },
    ],
  }));

  const page = await context.newPage();
  captureConsole(page, 'operator-customers');
  try {
    await login(page, 'owner');
    await page.goto(`${baseURL}/operator#/admin/customers`);
    await page.getByRole('heading', { name: 'לקוחות' }).waitFor({ timeout: 20_000 });
    // By cell role, not by text: DataTable keeps BOTH layouts mounted and hides one in CSS
    // (ui.tsx:1009). `getByText(...).first()` picks the mobile card, which at this width is
    // display:none, so it is found and never becomes visible. Only the desktop table has cells.
    await page.getByRole('cell', { name: 'לקוח ללא פעילות בבדיקה' })
      .first().waitFor({ timeout: 20_000 });

    // The dash belongs to the customer that never acted, and only to it.
    const dashes = await page.locator('td, .num').filter({ hasText: /^—$/ }).count();
    assert(dashes > 0, 'a customer with no recorded activity rendered something other than an em dash');
    assert(!(await page.content()).includes('לקוח ללא פעילות בבדיקה: 0'), 'a never-active customer reported a zero');

    await auditAccessibility(page, 'operator-customers');

    // The row opens the customer card, and the card says what it cannot yet measure rather than
    // showing an empty panel that reads like a measurement returning nothing.
    await page.getByRole('cell', { name: 'לקוח פעיל בבדיקה' }).first().click();
    await page.getByRole('heading', { level: 1, name: /לקוח פעיל בבדיקה/ }).waitFor({ timeout: 20_000 });
    await page.getByText(/אינן ניתנות למדידה/).waitFor({ timeout: 20_000 });
    assert(
      !(await page.content()).includes('הערות פנימיות'),
      'the notes panel rendered for an operator holding no notes.view',
    );
    // Health shows the reason, never a score; a step the product completed offers no manual
    // record, because there is nothing to record.
    await page.getByText('דורש תשומת לב').first().waitFor({ timeout: 20_000 });
    await page.getByText('לפני יותר משבועיים').first().waitFor({ timeout: 20_000 });
    assert(
      (await page.getByText('לפי פעולה במוצר').count()) > 0,
      'a step completed by a product event did not say so',
    );

    await auditAccessibility(page, 'operator-customer-detail');
    await page.goto(`${baseURL}/operator#/admin/customers`);
    await page.getByRole('heading', { name: 'לקוחות' }).waitFor({ timeout: 20_000 });

    // Now the same screen for an operator who may not read customers at all.
    capabilities = [];
    await page.reload();
    await page.getByText('הרשאת צפייה בלקוחות').waitFor({ timeout: 20_000 });
    assert(!(await page.content()).includes('אין לקוחות'), 'a refused operator was shown the empty-customer-base state');
  } finally {
    await closeContext(context);
  }
}

async function operatorRefusal(browser) {
  // The other half of the operator boundary: a signed-in tenant who is NOT a platform admin
  // (no platform_admins mock — the live table answers false) lands on /operator and is handed
  // back to the tenant application by a full document navigation, seeing nothing of the console.
  // The build separation is not the security boundary — the platform RPCs refuse server-side —
  // but the guard must still never RENDER the console to a tenant.
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  captureConsole(page, 'operator-refusal');
  try {
    await login(page, 'accountant');
    await page.goto(`${baseURL}/operator`);
    await page.waitForFunction(() => location.pathname === '/dashboard', null, { timeout: 25_000 });
    await page.locator('#main').waitFor({ state: 'visible', timeout: 25_000 });
    assert(!(await page.content()).includes('תפעול פלטפורמה'), 'a tenant without platform membership reached the operator console');

    // And the other direction: /admin is not merely un-navigable, it is not a route in the tenant
    // application any more. A bundle grep proves the code is absent; only a real navigation proves
    // the PATH is. It falls through the catch-all to the tenant home, which is what "the routes and
    // the imports left the tenant app" has to mean in practice.
    await page.goto(`${baseURL}/admin`);
    await page.waitForFunction(() => location.pathname === '/dashboard', null, { timeout: 25_000 });
    assert(!(await page.content()).includes('תפעול פלטפורמה'), '/admin still resolves to the operator console inside the tenant app');
  } finally {
    await closeContext(context);
  }
}

async function documentOcrAcceptance(browser) {
  const mobile = await browser.newContext({
    locale: 'he-IL', serviceWorkers: 'block', reducedMotion: 'reduce', viewport: { width: 390, height: 844 },
  });
  const gallery = await mobile.newPage();
  captureConsole(gallery, 'ocr-documents');
  try {
    await login(gallery, 'owner');
    await gallery.goto(`${baseURL}/documents`);
    await settle(gallery);
    await gallery.locator('[data-testid="documents-page"]').waitFor({ timeout: 25_000 });

    for (const [documentId, expectedStage, expectedLabel] of OCR_STAGE_FIXTURES) {
      const badge = gallery.locator(
        `[data-testid="document-processing-status"][data-document-id="${documentId}"]:visible`,
      );
      await badge.waitFor({ state: 'visible', timeout: 25_000 });
      assert.equal(await badge.getAttribute('data-stage'), expectedStage, `${documentId}: unexpected OCR stage`);
      assert.equal((await badge.innerText()).trim(), expectedLabel, `${documentId}: unexpected status wording`);
    }

    const processingFilter = gallery.locator('[data-testid="documents-processing-filter"]');
    await processingFilter.selectOption('failed');
    await gallery.waitForFunction((failedId) => {
      const visible = [...document.querySelectorAll('[data-testid="document-processing-status"]')]
        .filter((element) => element.getBoundingClientRect().height > 0)
        .map((element) => element.getAttribute('data-document-id'));
      return visible.length === 1 && visible[0] === failedId;
    }, OCR_STAGE_FIXTURES[5][0]);
    await auditAccessibility(gallery, 'ocr-documents/390');
    await gallery.screenshot({ path: path.join(outDir, 'ocr-documents-390.png'), fullPage: true });
    report.screenshots.push('ocr-documents-390.png');
  } finally {
    await closeContext(mobile);
  }

  const desktop = await browser.newContext({
    locale: 'he-IL', serviceWorkers: 'block', reducedMotion: 'reduce', viewport: { width: 1440, height: 900 },
  });
  const review = await desktop.newPage();
  captureConsole(review, 'ocr-review');
  try {
    await login(review, 'owner');
    await review.goto(`${baseURL}/documents/${OCR_REVIEW_DOCUMENT_ID}/review?panel=export`);
    await settle(review);
    await review.locator('[data-testid="document-review-page"]').waitFor({ timeout: 25_000 });
    await review.locator('[data-testid="document-source-viewer"]').waitFor();
    await review.locator('[data-testid="document-review-proposals"]').waitFor();
    assert.equal(await review.getByRole('button', { name: 'אישור הסוג המוצע' }).count(), 0,
      'document review still requires manual type approval');
    await review.getByText('המערכת מסווגת את המסמך אוטומטית. אין צורך באישור ידני.').waitFor();
    // The per-block keyboard list, the bbox overlay and the grades left this screen with the
    // owner's second pass over it ("בפירוש אין צורך לראות את הקווים הכחולים הללו"). Asserted as an
    // absence, in a real browser, because that is the claim now: the viewer shows the document.
    await review.locator('[data-testid="document-annotations-keyboard"]').waitFor({ state: 'detached' });
    if (await review.locator('[data-testid="document-source-viewer"]').getByText(/מיקום בעמוד/).count()) {
      throw new Error('document review source viewer still prints extraction coordinates');
    }
    const exportPreview = review.locator('[data-testid="document-export-preview"]');
    await exportPreview.waitFor();
    await auditAccessibility(review, 'ocr-review/1440');
    await review.screenshot({ path: path.join(outDir, 'ocr-review-1440.png'), fullPage: true });
    report.screenshots.push('ocr-review-1440.png');

    await exportPreview.getByRole('button', { name: 'הפקת תצוגה מקדימה' }).click();
    await exportPreview.getByRole('heading', { name: 'תוצאת התצוגה המקדימה' }).waitFor({ timeout: 10_000 });
    assert.equal(await exportPreview.locator('thead th').count(), 3, 'OCR export preview did not render three fixture columns');
    assert.equal(await exportPreview.locator('tbody tr').count(), 2, 'OCR export preview did not render two fixture rows');
    assert.equal(await exportPreview.getByText(/טביעת מקור:/).count(), 1, 'OCR export preview did not expose a checksum');
    await review.screenshot({ path: path.join(outDir, 'ocr-export-preview-1440.png'), fullPage: true });
    report.screenshots.push('ocr-export-preview-1440.png');

    // A classified invoice drafts into the ordinary invoice form. What matters is that the values
    // arrive AND that the form is still the real one -- the duplicate checks and the reason field
    // are what stop a misread number becoming a financial record, so their absence would be worse
    // than an empty draft.
    await review.getByRole('button', { name: 'יצירת טיוטת חשבונית מהמסמך' }).click();
    await review.waitForURL(/\/invoices\/new\?document=/, { timeout: 10_000 });
    await settle(review);
    // Addressed by id, not by label text: these labels carry Hebrew gershayim and a required-field
    // asterisk, and a selector that has to reproduce them exactly breaks on punctuation alone.
    const draftNumber = review.locator('#invoice-new-number');
    await draftNumber.waitFor({ timeout: 10_000 });
    // The prefill is two Supabase round-trips that settle() does not wait for, so wait on the
    // value rather than on a fixed pause. Asserting straight after settle() passed once and failed
    // the next run on the same code -- a race in the check, not in the page.
    await review.waitForFunction(
      () => document.querySelector('#invoice-new-number').value.length > 0,
      null,
      { timeout: 15_000 },
    ).catch(() => { throw new Error('invoice draft never populated the invoice number field'); });
    assert.equal(await draftNumber.inputValue(), 'INV-2026-1042', 'invoice draft did not carry the interpreted invoice number');
    assert.equal(await review.locator('#invoice-new-total').inputValue(), '745.6', 'invoice draft did not carry the interpreted total');
    assert.equal(await review.locator('#invoice-new-supplier').inputValue(), 'aa000000-0000-4000-8000-000000000008', 'invoice draft did not carry the matched supplier');
    assert.equal(await review.locator('#invoice-new-vat').inputValue(), '', 'invoice draft invented a VAT amount the interpretation never offered');
    assert.match(await review.locator('#invoice-new-reason').inputValue(), /ocr-04-review\.png/, 'invoice draft did not name its source document in the reason');
    await review.screenshot({ path: path.join(outDir, 'ocr-invoice-draft-1440.png'), fullPage: true });
    report.screenshots.push('ocr-invoice-draft-1440.png');

    // A delivery note drafts a goods receipt, but only as far as the document can honestly go: it
    // names the supplier and seeds the search, and the order stays the receiver's choice. The
    // check is that the handover carries the document and says which one, not that anything was
    // decided for them.
    await review.goto(`${baseURL}/documents/${OCR_DELIVERY_DOCUMENT_ID}/review`);
    await settle(review);
    await review.getByRole('button', { name: 'קליטת סחורה מתעודת המשלוח' }).click();
    await review.waitForURL(/\/receiving\?document=/, { timeout: 10_000 });
    await settle(review);
    const receivingSearch = review.locator('#receiving-search');
    await receivingSearch.waitFor({ timeout: 10_000 });
    await review.waitForFunction(
      () => document.querySelector('#receiving-search').value.length > 0,
      null,
      { timeout: 15_000 },
    ).catch(() => { throw new Error('receiving draft never seeded the supplier search') });
    // Matched, not compared: the seeded supplier name is whatever the suppliers row holds, and its
    // gershayim differ between the seed and the interpretation payload.
    assert.match(await receivingSearch.inputValue(), /משקאות אור/, 'receiving draft did not seed the supplier from the delivery note');
    const receivingBody = await review.locator('#main').innerText();
    assert.match(receivingBody, /ocr-05-completed\.png/, 'receiving draft did not name the delivery note it came from');
    assert.match(receivingBody, /בחר את ההזמנה/, 'receiving draft did not leave the order to the receiver');
    await review.screenshot({ path: path.join(outDir, 'ocr-receiving-draft-1440.png'), fullPage: true });
    report.screenshots.push('ocr-receiving-draft-1440.png');

    // A credit note drafts a credit request against the invoice it names. Landing on an invoice at
    // all is the first assertion: the alternative to resolving the reference is landing on the
    // wrong invoice, which is invisible once it happens.
    await review.goto(`${baseURL}/documents/${OCR_CREDIT_DOCUMENT_ID}/review`);
    await settle(review);
    await review.getByRole('button', { name: 'פתיחת דרישת זיכוי מהמסמך' }).click();
    await review.waitForURL(/\/invoices\/[0-9a-f-]{36}/, { timeout: 15_000 });
    await settle(review);
    const creditAmount = review.locator('#invoice-credit-amount');
    await creditAmount.waitFor({ timeout: 15_000 });
    await review.waitForFunction(
      () => document.querySelector('#invoice-credit-amount').value.length > 0,
      null,
      { timeout: 15_000 },
    ).catch(() => { throw new Error('credit draft never populated the amount') });
    assert.equal(await creditAmount.inputValue(), '745.6', 'credit draft did not carry the interpreted amount');
    assert.match(await review.locator('#invoice-credit-notes').inputValue(), /לפי המסמך/, 'credit draft did not quote the document lines');
    // credit_reason says WHY money is owed and the document states an amount only, so the dropdown
    // must still be sitting on its untouched default rather than on something inferred.
    assert.equal(await review.locator('#invoice-credit-reason').inputValue(), 'wrong_price', 'credit draft inferred a reason the document never stated');
    await review.screenshot({ path: path.join(outDir, 'ocr-credit-draft-1440.png'), fullPage: true });
    report.screenshots.push('ocr-credit-draft-1440.png');

    // A payment confirmation is reconciled, never executed: the reviewer's role cannot call
    // execute_payment_request and the accountant does not review this interpretation. So the check
    // is that the panel answers "is this real money we moved?" and says where execution lives --
    // and above all that it offers no button to move money from here.
    await review.goto(`${baseURL}/documents/${OCR_PAYMENT_DOCUMENT_ID}/review`);
    await settle(review);
    const matchPanel = review.getByRole('heading', { name: 'התאמה לתשלומים במערכת' });
    await matchPanel.waitFor({ timeout: 15_000 });
    await review.waitForFunction(
      () => /נמצא תשלום רשום תואם|לא נמצא תשלום/.test(document.querySelector('#main').innerText),
      null,
      { timeout: 15_000 },
    ).catch(() => { throw new Error('payment confirmation panel never reached a verdict') });
    const paymentPanel = review.locator('[data-testid="payment-confirmation-match"]');
    const paymentBody = await paymentPanel.innerText();
    assert.match(paymentBody, /נמצא תשלום רשום תואם/, 'payment confirmation did not match the seeded payment');
    assert.match(paymentBody, /בעל תפקיד תשלומים/, 'payment confirmation did not say where execution actually happens');
    // Scoped to the panel, not the page: the sidebar and speed-dial legitimately contain buttons
    // whose names mention payments, and asserting across the whole document caught those instead.
    assert.equal(await paymentPanel.getByRole('button').count(), 0,
      'payment confirmation panel offered a button; executing a payment must not be reachable from the review screen');
    await review.screenshot({ path: path.join(outDir, 'ocr-payment-match-1440.png'), fullPage: true });
    report.screenshots.push('ocr-payment-match-1440.png');
  } finally {
    await closeContext(desktop);
  }
}

async function automaticPriceListAcceptance(browser) {
  const context = await browser.newContext({
    locale: 'he-IL', serviceWorkers: 'block', reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  captureConsole(page, 'ocr-price-list-automatic');
  try {
    await login(page, 'owner');
    await page.goto(`${baseURL}/documents/${OCR_PRICE_LIST_DOCUMENT_ID}/review`);
    await settle(page);

    const panel = page.locator('[data-testid="price-list-review-confirmation"]');
    await panel.waitFor({ timeout: 25_000 });
    await panel.getByRole('heading', { name: 'קבלת קליטת מחירון' }).waitFor({ timeout: 25_000 });
    assert.equal(await page.locator('[data-testid="document-review-proposals"]').count(), 0,
      'the generic interpretation panels still precede the price-list result');
    assert.equal(await page.locator('[data-testid="document-export-preview"]').count(), 0,
      'the unrelated export panel is still shown for a price list');
    assert.equal(await page.getByRole('heading', { name: /הערות והחלטות|כללים שהופעלו/ }).count(), 0,
      'empty technical review cards are still shown for a price list');
    const body = await panel.innerText();
    assert.match(body, /2 שורות נקלטו/, 'automatic price-list receipt did not report two accepted rows');
    assert.match(body, /1 שורות ממתינות/, 'automatic price-list receipt did not report one waiting row');
    assert.match(body, /1 מוצרים חדשים נוצרו/, 'automatic price-list receipt did not report the created product');
    const detailsToggle = panel.locator('[data-testid="price-list-details-toggle"]');
    assert.equal(await detailsToggle.getAttribute('aria-expanded'), 'false',
      'the global price-list details control was not collapsed by default');
    assert.equal(await panel.locator('#price-list-line-details article').count(), 0,
      'price-list rows were visible before the global details control was opened');

    await auditAccessibility(page, 'ocr-price-list/1440');
    await page.screenshot({ path: path.join(outDir, 'ocr-price-list-collapsed-1440.png'), fullPage: true });
    report.screenshots.push('ocr-price-list-collapsed-1440.png');

    await detailsToggle.click();
    assert.equal(await detailsToggle.getAttribute('aria-expanded'), 'true',
      'the global price-list details control did not open all rows');
    assert.equal(await panel.locator('#price-list-line-details article').count(), 3,
      'the global price-list details control did not reveal every row');
    const expandedBody = await panel.innerText();
    assert.match(expandedBody, /נקלטה אוטומטית/, 'the existing product row was not marked as automatically applied');
    assert.match(expandedBody, /מוצר חדש נוצר ונקלט/, 'the keyed new product row was not marked as created');
    const waitingRow = panel.locator('article').filter({ hasText: 'ממתינה' });
    assert.equal(await waitingRow.count(), 1, 'the waiting price-list row is not uniquely identifiable');
    assert.match(await waitingRow.innerText(), /לא נמצא מק״ט או ברקוד/,
      'the unkeyed row did not explain why it is waiting after opening all details');
    await page.screenshot({ path: path.join(outDir, 'ocr-price-list-expanded-1440.png'), fullPage: true });
    report.screenshots.push('ocr-price-list-expanded-1440.png');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(250);
    await detailsToggle.click();
    assert.equal(await panel.locator('#price-list-line-details article').count(), 0,
      'the global price-list details control did not collapse every row on mobile');
    const [mobileResultBox, mobileSourceBox] = await Promise.all([
      panel.boundingBox(),
      page.locator('[data-testid="document-source-viewer"]').boundingBox(),
    ]);
    assert(mobileResultBox && mobileSourceBox && mobileResultBox.y < mobileSourceBox.y,
      'the original document still appears before the latest price-list result on mobile');
    await auditAccessibility(page, 'ocr-price-list/390');
    await page.screenshot({ path: path.join(outDir, 'ocr-price-list-collapsed-390.png'), fullPage: true });
    report.screenshots.push('ocr-price-list-collapsed-390.png');
  } finally {
    await closeContext(context);
  }
}

/**
 * The manual confirmation of a price list the automation read but was not allowed to apply.
 *
 * The screen this exercises used to open all 22 rows with an empty product select on each, and the
 * only way forward was to fill them in one at a time — while the server had already matched twenty
 * of them by SKU and recorded it. The scenario asserts the three things that fixed it: one primary
 * button carrying the matched count, a folded per-line form, and the two unmatched rows reachable
 * with their reasons. It also measures the mobile width, where the whole point is that a 338-row
 * list must not become a 338-card scroll.
 */
async function manualPriceListConfirmation(browser) {
  const context = await browser.newContext({
    locale: 'he-IL', serviceWorkers: 'block', reducedMotion: 'reduce', viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  captureConsole(page, 'ocr-price-list-manual');
  try {
    await login(page, 'owner');
    await page.goto(`${baseURL}/documents/${OCR_MANUAL_PRICE_LIST_DOCUMENT_ID}/review`);
    await settle(page);

    const panel = page.locator('[data-testid="price-list-review-confirmation"]');
    await panel.waitFor({ timeout: 25_000 });
    const confirm = panel.locator('[data-testid="price-list-intake-confirm"]');
    await confirm.waitFor({ timeout: 25_000 });
    await page.locator('[data-testid="price-list-intake-summary"]').waitFor({ timeout: 25_000 });

    assert.match(await panel.locator('[data-testid="price-list-intake-summary"]').innerText(),
      /20 מתוך 22 שורות זוהו במלואן/,
      'the confirmation screen did not report the twenty rows the server had already matched');
    // The screen must not claim an automatic intake on a document where none happened.
    const headerBody = await panel.innerText();
    assert.match(headerBody, /ממתין לאישורך/,
      'the panel badge still reported processing on a document waiting for a person');
    assert.doesNotMatch(headerBody, /המערכת קולטת אוטומטית שורות בטוחות/,
      'the panel still described an automatic intake that never ran on this document');
    // Enabled with nothing touched: the prefill is what makes this a one-click intake. Waited for
    // rather than read once, because the prefill lands only after the product catalogue arrives.
    await page.waitForFunction(
      () => {
        const button = document.querySelector('[data-testid="price-list-intake-confirm"]');
        return !!button && !button.disabled;
      },
      null,
      { timeout: 25_000 },
    ).catch(() => { throw new Error('the primary intake button never became clickable') });
    assert.match(await confirm.innerText(), /קליטת\s*20\s*המחירים שנבחרו/,
      'the primary button did not carry the matched row count');
    const detailsToggle = panel.locator('[data-testid="price-list-details-toggle"]');
    assert.equal(await detailsToggle.getAttribute('aria-expanded'), 'false',
      'the per-line form was open by default again');
    assert.equal(await panel.locator('#price-list-line-details article').count(), 0,
      'per-line cards were rendered before anybody asked for them');

    await auditAccessibility(page, 'ocr-price-list-manual/1440');
    await page.screenshot({ path: path.join(outDir, 'ocr-price-list-manual-1440.png'), fullPage: true });
    report.screenshots.push('ocr-price-list-manual-1440.png');

    await panel.locator('[data-testid="price-list-show-unmatched"]').click();
    assert.equal(await panel.locator('#price-list-line-details article').count(), 2,
      'opening the exceptions did not show exactly the two unmatched rows');
    const unmatchedBody = await panel.locator('#price-list-line-details').innerText();
    assert.match(unmatchedBody, /לא נמצא מק״ט או ברקוד/,
      'the unmatched row did not explain why the server left it alone');
    assert.match(unmatchedBody, /לא נקרא מחיר יחידה/,
      'the unreadable-price row did not explain why the server left it alone');

    await panel.locator('[data-testid="price-list-unmatched-filter"]').click();
    assert.equal(await panel.locator('#price-list-line-details article').count(), 22,
      'clearing the filter did not reveal every row');
    const matchedBody = await panel.locator('#price-list-line-details article').first().innerText();
    assert.match(matchedBody, /הותאם לפי מק״ט/,
      'a prefilled row did not show which key matched it');
    await page.screenshot({ path: path.join(outDir, 'ocr-price-list-manual-expanded-1440.png'), fullPage: true });
    report.screenshots.push('ocr-price-list-manual-expanded-1440.png');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(250);
    await detailsToggle.click();
    assert.equal(await panel.locator('#price-list-line-details article').count(), 0,
      'the per-line form did not fold away again on mobile');
    // auditAccessibility also fails on any horizontal overflow, which is the measurement that
    // caught the sr-only label escaping this very screen at 390px earlier today.
    await auditAccessibility(page, 'ocr-price-list-manual/390');
    await page.screenshot({ path: path.join(outDir, 'ocr-price-list-manual-390.png'), fullPage: true });
    report.screenshots.push('ocr-price-list-manual-390.png');
  } finally {
    await closeContext(context);
  }
}

/* ===================== wave 9: the global-search type gate (0069) ===================== */

// 'מאפ' matches two seeded suppliers ('מאפיית הלחם החם', 'מאפה זהב'), so an owner is guaranteed a
// supplier hit and the fixture can prove the gate rather than an empty database.
const SEARCH_TYPE_GATE_TERM = 'מאפ';
// The procurement types an accountant cannot open must never cross the wire.
const ACCOUNTANT_FORBIDDEN_TYPES = ['supplier', 'product', 'order'];

/**
 * Lifts the PostgREST credentials the app itself is using out of a live request.
 *
 * Deliberately not reconstructed from env: the point is to call the RPC with **this session's own**
 * JWT, exactly as the browser would. The predicate rejects the pre-login state, where supabase-js
 * sends the anon key in both headers — an anon token would prove nothing about the accountant.
 */
async function postgrestCredentials(page, navigate) {
  const pending = page.waitForRequest((request) => {
    if (!request.url().includes('/rest/v1/')) return false;
    const headers = request.headers();
    return !!headers.apikey && !!headers.authorization
      && headers.authorization !== `Bearer ${headers.apikey}`;
  }, { timeout: 25_000 });
  await navigate();
  const headers = (await pending).headers();
  return { apikey: headers.apikey, authorization: headers.authorization };
}

async function globalSearchWith(credentials, term) {
  const response = await fetch(`${apiURL}/rest/v1/rpc/global_search`, {
    method: 'POST',
    headers: { ...credentials, 'content-type': 'application/json' },
    body: JSON.stringify({ q: term, per_type: 5 }),
  });
  assert(response.ok, `global_search answered HTTP ${response.status}`);
  const rows = await response.json();
  assert(Array.isArray(rows), 'global_search did not answer with a row set');
  return rows;
}

/**
 * The type gate of migration 0069, observed from outside the app.
 *
 * This scenario asserts the gate with real session credentials: the same term returns procurement
 * hits for an owner while an accountant receives only the entity types reachable from the active
 * accounting surfaces.
 */
async function searchTypeGate(browser) {
  const ownerContext = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
  const ownerPage = await ownerContext.newPage();
  captureConsole(ownerPage, 'search-type-gate:owner');
  try {
    await login(ownerPage, 'owner');
    const credentials = await postgrestCredentials(ownerPage, () => ownerPage.goto(`${baseURL}/invoices`));
    await settle(ownerPage);
    const hits = await globalSearchWith(credentials, SEARCH_TYPE_GATE_TERM);
    assert(hits.length > 0, `owner global_search returned nothing for «${SEARCH_TYPE_GATE_TERM}» — the fixture cannot prove the gate`);
    assert(hits.some((hit) => hit.entity === 'supplier'),
      `owner global_search returned no supplier hit for «${SEARCH_TYPE_GATE_TERM}»; got ${JSON.stringify([...new Set(hits.map((hit) => hit.entity))])}`);
  } finally {
    await closeContext(ownerContext);
  }

  const accountantContext = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
  const accountantPage = await accountantContext.newPage();
  captureConsole(accountantPage, 'search-type-gate:accountant');
  try {
    await login(accountantPage, 'accountant');
    await settle(accountantPage);
    assert.equal(await accountantPage.getByRole('combobox', { name: 'חיפוש כללי' }).count(), 1,
      'accountant shell lost its permitted search box');

    const credentials = await postgrestCredentials(accountantPage, () => accountantPage.goto(`${baseURL}/invoices`));
    await settle(accountantPage);
    const hits = await globalSearchWith(credentials, SEARCH_TYPE_GATE_TERM);
    const types = [...new Set(hits.map((hit) => hit.entity))];
    assert.deepEqual(types.filter((type) => ACCOUNTANT_FORBIDDEN_TYPES.includes(type)), [],
      `accountant received forbidden result types: ${JSON.stringify(types)}`);
  } finally {
    await closeContext(accountantContext);
  }
}

/* ============ wave 11: the menu, the supplier door, and the words the machine is given ============ */

/**
 * The sidebar as it is painted: groups in render order, links in render order.
 *
 * Reads each link's OWN text nodes rather than its `textContent`, because `/documents` carries the
 * unfiled-count pill inside the same `<a>` (Layout.tsx:228-230). `textContent` would read
 * "תיקיית המסמכים6" and the assertions below would silently become claims about the fixture's queue
 * depth instead of claims about the menu.
 *
 * A group is `<div>[optional header]<div>links…</div></div>`, so the first child is the header only
 * when it holds no link — that is how the ungrouped first section is told apart from a named one.
 */
function readSidebar(nav) {
  return nav.evaluate((node) => [...node.children].map((group) => {
    const first = group.firstElementChild;
    return {
      section: first && !first.querySelector('a') ? (first.textContent || '').trim() : '',
      items: [...group.querySelectorAll('a')].map((link) => ({
        label: (link.querySelector('span')?.textContent || '').trim(),
        path: new URL(link.href).pathname,
        current: link.getAttribute('aria-current'),
      })),
    };
  }));
}

/**
 * A1 and A2, measured on the rendered menu instead of on the literal that produces it.
 *
 * Both claims had only ever been checked at module level: `layout.spec.ts` reads `NAV_SECTIONS`,
 * `layoutActiveState.spec.tsx` renders in jsdom. Neither can answer the question A2 actually turns
 * on — whether React Router marks one item or two as the current page on `/documents/archive` —
 * because that is a routing decision resolved against a real URL, and because the consequence
 * (`Layout.tsx:150` aims the drawer's opening focus at `[aria-current="page"]`) is a focus fact
 * only a browser has. So the route is loaded for real, and the sidebar is read as a person sees it.
 */
async function navigationOrderAndActiveState(browser) {
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  captureConsole(page, 'navigation-order');
  try {
    await login(page, 'owner');
    await page.goto(`${baseURL}/documents/archive`);
    await settle(page);
    await page.getByRole('heading', { name: 'ארכיון מסמכים' }).waitFor({ timeout: 25_000 });

    // T7.1: desktop navigation is a TOP BAR (owner decision, reference layout) — daily links at
    // top level, ניהול/בקרה as disclosure dropdowns whose panels stay in the DOM while hidden.
    const topNav = page.locator('header nav[aria-label="ניווט ראשי"]:visible');
    await topNav.first().waitFor();
    assert.equal(await topNav.count(), 1, 'the desktop shell rendered more than one visible top navigation');
    /*
     * The bar is read as an ORDERED SEQUENCE of the things a person can see on it — a link, or a
     * group's trigger — not as a flat list of every visible `<a>`.
     *
     * The flat reader could not tell the daily row from the bar. That was harmless only while
     * every named group was a dropdown, because then the only visible links WERE the daily ones.
     * A named group holding exactly one destination is not a dropdown (DESIGN.md:548, „דיסקלוזר
     * מעל פריט אחד הוא דלת עם מכסה"), so 'המנוי' renders as a plain link — and the flat reader
     * counted it as a seventh daily destination. Adding it to the expected array would have made
     * this assertion state the opposite of the architecture it exists to guard.
     */
    const nav = await topNav.evaluate((node) => {
      const readLink = (link) => ({
        label: (link.querySelector('span')?.textContent || '').trim(),
        path: new URL(link.href).pathname,
        current: link.getAttribute('aria-current'),
      });
      const bar = [];
      for (const el of node.querySelectorAll('a, button[aria-expanded]')) {
        if (el.tagName === 'BUTTON') bar.push({ kind: 'group', label: (el.textContent || '').trim() });
        // A closed group's destinations live in its `hidden` panel; they are not on the bar.
        else if (!el.closest('[hidden]')) bar.push({ kind: 'link', ...readLink(el) });
      }
      return {
        bar,
        all: [...node.querySelectorAll('a')].map(readLink),
        groups: [...node.querySelectorAll('button[aria-expanded]')].map((b) => (b.textContent || '').trim()),
      };
    });
    // Daily work is the leading run of links, the one section with no name — everything from the
    // first group trigger onward is a group, named, and not daily work.
    const firstGroupAt = nav.bar.findIndex((entry) => entry.kind === 'group');
    const daily = (firstGroupAt === -1 ? nav.bar : nav.bar.slice(0, firstGroupAt));

    // FIRST, not merely present. The control centre is section 12's answer to "what needs me now",
    // and a link that is somewhere in the menu is not the same claim as the one the plan made.
    assert.deepEqual(
      { label: daily[0] && daily[0].label, path: daily[0] && daily[0].path },
      { label: 'מרכז הבקרה', path: '/dashboard' },
      `the first navigation link is not the control centre: ${JSON.stringify(daily.slice(0, 2))}`,
    );

    // Daily work stays visible at top level. Management and control remain available behind
    // dropdowns without making all of their modules compete with the daily routes.
    assert.deepEqual(daily.map((item) => item.path),
      ['/dashboard', '/orders', '/receiving', '/invoices', '/documents', '/suppliers'],
      `wrong owner daily navigation: ${JSON.stringify(nav.bar)}`);
    // Two dropdowns, and only two. 'המנוי' is NOT among them and must not become one: it holds a
    // single destination, and a disclosure over one item is a door with a lid.
    assert.deepEqual(nav.groups, ['ניהול', 'בקרה'],
      `wrong navigation dropdown groups or order: ${JSON.stringify(nav.groups)}`);
    // 'המנוי' joined the catalogue on 25.08.2026 as its own group — last, after the two work
    // groups, because the three groups above it are the business the tenant runs and this is the
    // contract they run it under. On a bar with no group headers, "its own group, last, not
    // collapsible" is exactly this: a plain link, after both dropdowns, carrying the group's word.
    // Both halves are load-bearing. Behind a disclosure it is a door with a lid; ahead of the
    // dropdowns it has silently rejoined the daily row.
    assert.deepEqual(nav.bar[nav.bar.length - 1], { kind: 'link', label: 'המנוי', path: '/settings/subscription', current: null },
      `'המנוי' is not the last entry on the bar as its own non-collapsible group: ${JSON.stringify(nav.bar)}`);
    assert.equal(nav.all.some((item) => item.path === '/documents/archive'), false,
      'the low-frequency archive still competes in the main navigation');
    assert.equal(nav.all.filter((item) => item.current === 'page').length, 0,
      'the archive incorrectly marked a different navigation destination as current');

    // Dropdown behaviour, measured: opening ניהול reveals its destinations; Escape closes it.
    const visibleLinkCount = () => topNav.locator('a:visible').count();
    const closedCount = await visibleLinkCount();
    await page.getByRole('button', { name: /^ניהול/ }).click();
    await page.waitForFunction((base) =>
      document.querySelectorAll('header nav[aria-label="ניווט ראשי"] a:not([hidden])').length >= base,
    closedCount, { timeout: 5_000 });
    assert((await visibleLinkCount()) > closedCount, 'opening the ניהול dropdown revealed no destinations');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    assert.equal(await visibleLinkCount(), closedCount, 'Escape did not close the navigation dropdown');

    await auditAccessibility(page, 'documents-archive/1440');
    await page.screenshot({ path: path.join(outDir, 'navigation-archive-1440.png') });
    report.screenshots.push('navigation-archive-1440.png');

    // The restored mobile action bar is a shortcut surface, not the navigation contract. Keep
    // every authorised destination in the drawer so the hamburger remains complete on its own.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(100);
    await page.getByRole('button', { name: 'פתיחת תפריט' }).click();
    const drawer = page.getByRole('dialog', { name: 'תפריט ראשי' });
    await drawer.waitFor();
    const drawerGroups = await readSidebar(drawer.locator('nav'));
    const drawerLinks = drawerGroups.flatMap((group) => group.items);
    // The drawer carries TWO groups the desktop sidebar does not, and that is the point of H4
    // (10.08.2026): profile, settings and sign-out used to live in a sticky footer strip that sat
    // over the menu while it scrolled. They moved into the drawer's own flow. The daily
    // destinations below are still asserted to match the sidebar exactly — what changed is where
    // the account surface lives, not which destinations a role has.
    assert.deepEqual(drawerGroups.map((group) => group.section).slice(0, 3), ['עבודה שוטפת', 'ניהול', 'בקרה'],
      'the drawer renders different progressive-disclosure groups than the desktop sidebar');
    assert.deepEqual(drawerGroups[0].items.map((item) => item.path),
      ['/dashboard', '/orders', '/receiving', '/invoices', '/documents', '/suppliers'],
      `the drawer omitted an authorised daily destination: ${JSON.stringify(drawerLinks)}`);
    assert.equal(await drawer.locator('[aria-current="page"]').count(), 0,
      'the archive incorrectly marked a different drawer destination as current');
    await page.waitForFunction(() => {
      const active = document.activeElement;
      return !!active && active.getAttribute('aria-label') === 'סגירת תפריט';
    }, null, { timeout: 5_000 }).catch(() => { throw new Error('the drawer did not open on its safe close action'); });
    await page.screenshot({ path: path.join(outDir, 'navigation-drawer-390.png') });
    report.screenshots.push('navigation-drawer-390.png');
  } finally {
    await closeContext(context);
  }
}

/**
 * The one row these scenarios add to the live database.
 *
 * Timestamped rather than fixed: `QuickCreateSupplier` warns on a duplicate name, so a fixed name
 * left behind by a crashed run would put the NEXT run on the warning path and fail it for a reason
 * that has nothing to do with the claim.
 */
const QUICK_SUPPLIER_NAME = `ספק מחירון בדיקת שער ${Date.now().toString(36)}`;

/**
 * Removes it the way the app itself removes a supplier — `deleted_at`, never DELETE (CLAUDE.md's
 * soft-delete rule) — so the browser gate leaves the database as it found it. Runs as service_role,
 * whose token carries no `sub`; `p0_supplier_soft_delete_guard` admits a null `auth.uid()` and
 * refuses only a signed-in user bypassing `soft_delete_supplier`.
 */
async function retireQuickSupplier() {
  const query = `name=eq.${encodeURIComponent(QUICK_SUPPLIER_NAME)}&deleted_at=is.null`;
  const response = await fetch(`${apiURL}/rest/v1/suppliers?${query}`, {
    method: 'PATCH',
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      'content-type': 'application/json',
      prefer: 'return=representation',
    },
    body: JSON.stringify({ deleted_at: new Date().toISOString() }),
  });
  assert(response.ok, `retiring the scenario's supplier failed with HTTP ${response.status}`);
}

/**
 * E2's claim, on the screen the owner named: a price list arrives from a supplier who is not in the
 * system yet.
 *
 * Driven from `/prices` and not from `/suppliers` deliberately — the supplier card's own
 * `ספק חדש` button and this dialog's would both answer `getByRole('button', { name: /ספק חדש/ })`,
 * and the scenario at :700 already owns that name on that screen.
 *
 * The supplier is really inserted, because the dead end being removed was a real INSERT the user
 * had to leave the task to perform; a mocked one would prove only that a dialog opens. The row is
 * retired in `finally`, and this scenario is registered last so nothing downstream sees it.
 */
async function priceListSupplierDoor(browser) {
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  captureConsole(page, 'price-list-supplier-door');
  try {
    await login(page, 'owner');
    await page.goto(`${baseURL}/prices`);
    await settle(page);

    await page.getByRole('button', { name: 'העלאת מחירון', exact: true }).click();
    const upload = page.getByRole('dialog', { name: 'העלאת מחירון' });
    await upload.waitFor();
    const select = upload.locator('#price-upload-supplier');
    await select.waitFor();
    // The door is not offered while the list is still loading (the field is disabled, and
    // SupplierSelectField refuses to announce an affordance that cannot be used), so the whole
    // scenario starts from the loaded state rather than racing it.
    await page.waitForFunction(() => {
      const node = document.querySelector('#price-upload-supplier');
      return !!node && !node.disabled && node.options.length > 1;
    }, null, { timeout: 25_000 });

    const before = (await select.locator('option').allTextContents()).map((label) => label.trim());
    assert.equal(before.includes(QUICK_SUPPLIER_NAME), false,
      'the fixture already contains the supplier this scenario creates');
    // Said, not merely placed: the button is announced as part of the field, which is the half of
    // E2 that adjacency alone cannot deliver.
    await upload.getByRole('group', { name: 'ספק — בחירה או יצירה' }).waitFor();

    await upload.getByRole('button', { name: 'ספק חדש' }).click();
    const quick = page.getByRole('dialog', { name: 'ספק חדש' });
    await quick.waitFor();
    // Layered, not replaced. Two dialogs is the whole point: the half-filled upload is still there.
    assert.equal(await page.getByRole('dialog').count(), 2,
      'creating a supplier replaced the price-list dialog instead of layering over it');
    assert(await upload.isVisible(), 'the price-list dialog closed behind the supplier form');
    assert.equal(await quick.locator('#quick-supplier-bank-details, [name="bank_details"]').count(), 0,
      'the quick supplier form grew a bank-details field (DEBT-REGISTER §11, OPEN-DECISIONS #106)');

    await quick.locator('#quick-supplier-name').fill(QUICK_SUPPLIER_NAME);
    await quick.locator('#quick-supplier-tax-id').fill('515151515');
    await quick.getByRole('button', { name: 'שמירה' }).click();
    await quick.waitFor({ state: 'hidden', timeout: 20_000 });

    // Nothing navigated, and the dialog the user was working in is still the one on screen.
    assert.equal(new URL(page.url()).pathname, '/prices',
      'creating a supplier navigated away from the price list');
    assert(await upload.isVisible(), 'the price-list dialog did not survive the supplier creation');

    // Selected by VALUE and by what the control actually shows — a select holding an id it cannot
    // render is the exact failure `mergeCreatedSuppliers` exists to prevent.
    await page.waitForFunction((name) => {
      const node = document.querySelector('#price-upload-supplier');
      if (!node || node.selectedIndex < 0) return false;
      return (node.options[node.selectedIndex].textContent || '').trim() === name;
    }, QUICK_SUPPLIER_NAME, { timeout: 20_000 })
      .catch(() => { throw new Error('the new supplier was not selected in the price-list dialog'); });
    const selectedId = await select.inputValue();
    assert.match(selectedId, /^[0-9a-f-]{36}$/i, `the selected supplier is not a row id: ${selectedId}`);
    const after = (await select.locator('option').allTextContents()).map((label) => label.trim());
    assert.equal(after.filter((label) => label === QUICK_SUPPLIER_NAME).length, 1,
      'the created supplier appears more than once in the list');

    await page.screenshot({ path: path.join(outDir, 'price-list-quick-supplier-1440.png') });
    report.screenshots.push('price-list-quick-supplier-1440.png');
  } finally {
    try {
      await retireQuickSupplier();
    } finally {
      await closeContext(context);
    }
  }
}

/** The canonical labels a person may read on a document status badge. Processing and filing are
 *  one precedence ladder here, so an active inbox document never renders a second "לא משויך" badge. */
const DOCUMENT_HUMAN_STATE_LABELS = [
  'עיבוד תקוע', 'העיבוד נכשל', 'ממתין לעיבוד', 'בעיבוד', 'נדרשת בדיקה', 'לא משויך',
  'שויך אוטומטית', 'משויך', 'שויך לחשבונית', 'שויך לקבלת סחורה',
];

/** Pipeline-only labels that still must not leak into the everyday document surface. Labels such
 *  as "בעיבוד" are intentionally absent here now: the canonical status model uses them as the
 *  single user-facing truth while a job is active. */
const DOCUMENT_ENGINEERING_LABELS = [
  'טרם נשלח לעיבוד', 'ממתין לפירוש', 'דורש בדיקה',
];

/**
 * D1 and D2 as one claim, because they are one: the machine's own vocabulary — its queue position
 * and its self-reported number — is not what the everyday screens say.
 *
 * Three things are asserted that no unit test can:
 *
 *  1. The *rendered* state filter uses the same canonical precedence groups as the badges.
 *  2. Every badge on the loaded page reads one of the permitted canonical labels.
 *  3. The proposals panel prints no percentage, and the number is one click away and no closer.
 *
 * Deliberately NOT scanned: the raw stage tokens over the page text. Five of the six fixture
 * documents are named `ocr-0N-<stage>.png` (`prepare-browser-fixture.cjs:17-23`), so the words
 * `queued`, `processing`, `review`, `completed` and `failed` are legitimately on screen as FILE
 * NAMES. The tokens are pinned where they belong instead — on `data-stage`, by the OCR scenario,
 * which asserts the stage and the label of every fixture row as a pair.
 *
 * `textContent`, not `innerText`: the state descriptions ride as `sr-only` siblings of the badge
 * (DocumentsInbox.tsx:111), and a scan that cannot see them would let jargon hide there.
 */
async function documentVocabulary(browser) {
  const context = await browser.newContext({
    locale: 'he-IL', serviceWorkers: 'block', reducedMotion: 'reduce', viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  captureConsole(page, 'document-vocabulary');
  try {
    await login(page, 'owner');
    await page.goto(`${baseURL}/documents`);
    await settle(page);
    await page.locator('[data-testid="documents-page"]').waitFor({ timeout: 25_000 });
    for (const [documentId] of OCR_STAGE_FIXTURES) {
      await page.locator(`[data-testid="document-processing-status"][data-document-id="${documentId}"]:visible`)
        .waitFor({ state: 'visible', timeout: 25_000 });
    }

    const filterOptions = (await page.locator('[data-testid="documents-processing-filter"] option').allTextContents())
      .map((label) => label.trim());
    assert.deepEqual(filterOptions, [
      'הכול', 'עיבוד תקוע', 'העיבוד נכשל', 'בעיבוד או בהמתנה', 'נדרשת בדיקה', 'לא משויך', 'משויך',
    ], `the state filter diverged from canonical document statuses: ${JSON.stringify(filterOptions)}`);

    const badges = (await page.locator('[data-testid="document-processing-status"]:visible').allInnerTexts())
      .map((label) => label.trim());
    assert(badges.length >= OCR_STAGE_FIXTURES.length,
      `only ${badges.length} status badges rendered; the gallery did not finish loading`);
    for (const badge of badges) {
      assert(DOCUMENT_HUMAN_STATE_LABELS.includes(badge),
        `a document status badge reads «${badge}», which is not one of the states a person can act on`);
    }

    const gallery = await page.locator('#main').evaluate((node) => node.textContent || '');
    for (const label of DOCUMENT_ENGINEERING_LABELS) {
      assert.equal(gallery.includes(label), false,
        `the documents folder still shows the pipeline label «${label}»`);
    }
    // The precondition, stated so the percentage scan below cannot quietly become vacuous or
    // spuriously fail: a filing the MACHINE performed does name its confidence, on purpose
    // (FilingBadge / autoActionDescription), and has its own scenario. This fixture contains none.
    assert.equal(await page.getByText('שויך אוטומטית').count(), 0,
      'the fixture now contains an auto-applied document; this scenario measures the reading vocabulary only');
    assert.equal(/\d\s*%/.test(gallery), false,
      `the documents folder prints a confidence percentage: ${(gallery.match(/.{0,24}\d\s*%.{0,12}/) || [])[0]}`);

    await page.goto(`${baseURL}/documents/${OCR_REVIEW_DOCUMENT_ID}/review`);
    await settle(page);
    await page.locator('[data-testid="document-review-page"]').waitFor({ timeout: 25_000 });
    const proposals = page.locator('[data-testid="document-review-proposals"]');
    await proposals.waitFor({ timeout: 25_000 });
    const proposalText = await proposals.evaluate((node) => node.textContent || '');
    assert.equal(/\d\s*%/.test(proposalText), false,
      `the proposals panel still prints a confidence percentage: ${(proposalText.match(/.{0,24}\d\s*%.{0,12}/) || [])[0]}`);
    assert.equal(proposalText.includes('רמת ביטחון'), false,
      'the proposals panel still uses the old confidence wording');
    assert(proposalText.includes('זוהה בבירור'),
      'the proposals panel stopped grading the reading in words as well as dropping the number');

    // 0.95 is the fixture's supplier confidence and nothing else on the page rounds to it — the
    // bbox descriptions in the source viewer are the other percentages here, and none is 95.
    const technical = page.locator('details:has(summary:text-is("פרטים טכניים"))');
    await technical.waitFor();
    assert.equal(await technical.evaluate((node) => node.open), false,
      'the technical disclosure is open before anyone asked for it');
    const closedPage = await page.locator('#main').evaluate((node) => node.textContent || '');
    assert.equal(closedPage.includes('95%'), false,
      'the raw confidence is on the review screen while the disclosure is shut');

    // Wait for the NUMBER, not for the `open` attribute. `open` flips synchronously — it is the
    // browser's own toggle — while the rows are built by React one render after `onToggle` fires
    // (DocumentReviewWorkspace.tsx:221,261 render them lazily so a long price list does not
    // re-diff thousands of hidden rows on every interaction). Waiting on `open` reads the gap
    // between the two and reports a defect that is not there; waiting on the content asserts the
    // claim the scenario is actually making. A number that never arrives still fails, on timeout.
    // The first gate run to include this scenario failed exactly here, which is the difference
    // between jsdom — where testing-library wraps every click in act() and flushes React — and a
    // real browser, which does not.
    await technical.locator('summary').click();
    await page.waitForFunction(() => {
      const node = [...document.querySelectorAll('details')]
        .find((element) => (element.querySelector('summary') || {}).textContent === 'פרטים טכניים');
      return !!node && node.open && (node.textContent || '').includes('95%');
    }, null, { timeout: 10_000 });
    const opened = await technical.evaluate((node) => node.textContent || '');
    assert(opened.includes('95%'),
      'the supplier confidence is not reachable inside פרטים טכניים in one click');

    // Owner report 25.08.2026: no vendor and no model name reaches a tenant. The fixture carries
    // 'openai-fixture' / 'gpt-local-contract-fixture' on the interpretation and
    // 'private-fixture' / 'ocr-acceptance-hebrew' on the extraction precisely so this assertion
    // has something to catch. Asserted on the WHOLE page, not the disclosure, because the rule is
    // that the words are not on the screen -- not that one box happens to hide them.
    const wholePage = await page.locator('#main').evaluate((node) => node.textContent || '');
    for (const banned of ['openai', 'gpt-', 'מנוע פירוש', 'מנוע חילוץ']) {
      assert.equal(wholePage.toLowerCase().includes(banned.toLowerCase()), false,
        `the review screen still prints the processing vendor or model: ${banned}`);
    }
    assert(opened.includes('גרסת עיבוד'),
      'the disclosure lost the processing-version row that replaced the two engine rows');
    await page.screenshot({ path: path.join(outDir, 'document-technical-disclosure-1440.png'), fullPage: true });
    report.screenshots.push('document-technical-disclosure-1440.png');
  } finally {
    await closeContext(context);
  }
}

// The completed fixture row: filed as 'inbox' like every other document the fixture registers, so
// without an auto-action beside it the filing column reads לא משויך. That is what makes it the
// honest row to hang a machine filing on — the badge has to be the thing that changes.
const AUTO_ACTION_DOCUMENT_ID = OCR_STAGE_FIXTURES[4][0];
const AUTO_ACTION_DOCUMENT_FILE = 'ocr-05-completed.png';
const AUTO_ACTION_ID = '97500000-0000-4000-8000-000000000001';
const AUTO_ACTION_INVOICE_ID = '97600000-0000-4000-8000-000000000001';
const AUTO_ACTION_REASON = 'בדיקת שער: החשבונית שנוצרה אוטומטית שויכה למסמך הלא נכון';

/**
 * C5, and the first surface in this application that names what the machine did on its own.
 *
 * `document_auto_actions` is answered from a route rather than from the database because no
 * fixture writes one: an auto-applied row requires a real interpretation, a real invoice and the
 * autonomy flag on, and seeding that would mean a browser scenario manufacturing a financial
 * record. What is under test here is the SCREEN — that a machine-authored filing is
 * distinguishable from a colleague's, that it says at what confidence it acted, that the undo is
 * offered, that it cannot be confirmed without a reason, that the reason reaches the server, and
 * that the row stops claiming to be filed afterwards. The server's own refusals (role, second
 * reversal, allocated money) are `p14_apply_interpretation.sql`'s subject, not a browser's.
 *
 * The document route mirrors the database transition as well as the autonomy ledger: before the
 * reversal the row is filed to the generated invoice; after the mocked RPC it is back in `inbox`.
 * A live auto-action beside an inbox document is impossible under migration 0077 and would make
 * the screen's two sources contradict each other.
 */
async function machineFiledDocument(browser) {
  const context = await browser.newContext({
    locale: 'he-IL', serviceWorkers: 'block', reducedMotion: 'reduce', viewport: { width: 1440, height: 900 },
  });
  let reverted = false;
  const revertCalls = [];
  await context.route('**/rest/v1/documents?**', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const rows = await response.json();
    const documents = Array.isArray(rows) && !reverted
      ? rows.map((row) => row.id === AUTO_ACTION_DOCUMENT_ID
        ? { ...row, entity_type: 'invoice', entity_id: AUTO_ACTION_INVOICE_ID }
        : row)
      : rows;
    return route.fulfill({ response, json: documents });
  });
  await context.route('**/rest/v1/document_auto_actions?**', (route) => route.fulfill({
    status: 200,
    headers: jsonHeaders,
    json: reverted ? [] : [{
      id: AUTO_ACTION_ID,
      document_id: AUTO_ACTION_DOCUMENT_ID,
      invoice_id: AUTO_ACTION_INVOICE_ID,
      decision: { decision_confidence: 0.94 },
    }],
  }));
  await context.route('**/rest/v1/rpc/revert_document_auto_action', (route) => {
    revertCalls.push(route.request().postDataJSON());
    reverted = true;
    return route.fulfill({ status: 200, headers: jsonHeaders, json: { reverted: true } });
  });
  const page = await context.newPage();
  captureConsole(page, 'document-auto-action');
  try {
    await login(page, 'owner');
    await page.goto(`${baseURL}/documents`);
    await settle(page);
    await page.locator('[data-testid="documents-page"]').waitFor({ timeout: 25_000 });

    const badge = page.locator('span:text-is("שויך אוטומטית"):visible');
    await badge.first().waitFor({ timeout: 25_000 });
    assert.equal(await badge.count(), 1,
      'the machine-filing badge is not on exactly one row');
    const gallery = await page.locator('#main').evaluate((node) => node.textContent || '');
    // Not `title` alone: a tooltip does not exist on touch, and this is the only copy separating a
    // record a model wrote from one a colleague typed.
    assert(gallery.includes('ללא אישור אדם'),
      'the machine-filed row never says that no person approved it');
    assert(gallery.includes('ברמת ביטחון 94%'),
      'the machine-filed row does not name the confidence the machine acted on');
    await page.screenshot({ path: path.join(outDir, 'document-auto-filed-1440.png'), fullPage: true });
    report.screenshots.push('document-auto-filed-1440.png');

    // Scoped to the desktop table: DataTable renders a card layer and a table layer, and only one
    // of the two is displayed at any width.
    const actionsLabel = `פעולות עבור מסמך ${AUTO_ACTION_DOCUMENT_FILE}`;
    const actions = page.locator('table').getByRole('button', { name: actionsLabel });
    assert.equal(await actions.count(), 1, `the row actions for ${AUTO_ACTION_DOCUMENT_FILE} are not unique`);
    await actions.click();
    const menu = page.getByRole('menu', { name: actionsLabel });
    await menu.waitFor();
    const undo = menu.getByRole('menuitem', { name: 'ביטול השיוך האוטומטי' });
    assert.equal(await undo.count(), 1, 'the machine-filed row offers no way to undo what the machine did');
    await undo.click();

    const dialog = page.getByRole('dialog', { name: 'ביטול השיוך האוטומטי' });
    await dialog.waitFor();
    const dialogText = await dialog.evaluate((node) => node.textContent || '');
    // The four things the dialog owes a person before it offers the button: what the machine did,
    // at what confidence, what the undo changes, and what survives it.
    for (const sentence of ['ללא אישור אדם', 'ברמת ביטחון 94%', 'הרשומה נשמרת לביקורת', 'יומן הביקורת']) {
      assert(dialogText.includes(sentence), `the reversal dialog does not say «${sentence}»`);
    }
    const confirm = dialog.getByRole('button', { name: 'ביטול השיוך', exact: true });
    // The reason box stopped gating the button on 11.08.2026 (owner: nobody reads these notes).
    // What is asserted below instead is the half that still matters: whatever a person types
    // reaches the server verbatim, and an empty box becomes a sentence rather than nothing.
    assert(await confirm.isEnabled(), 'the reversal button is still gated on a typed reason');
    await dialog.getByRole('textbox', { name: /סיבה/ }).fill(AUTO_ACTION_REASON);
    await confirm.click();
    await dialog.waitFor({ state: 'hidden', timeout: 20_000 });

    assert.equal(revertCalls.length, 1,
      `revert_document_auto_action was called ${revertCalls.length} times for one reversal`);
    assert.equal(revertCalls[0].p_action_id, AUTO_ACTION_ID, 'the reversal named a different auto-action row');
    assert.equal(revertCalls[0].p_reason, AUTO_ACTION_REASON,
      `the operator's reason did not reach the server verbatim: ${JSON.stringify(revertCalls[0].p_reason)}`);

    // One reversal changes two things a person is looking at, and refreshing one and not the other
    // would leave the screen contradicting itself.
    await page.waitForFunction(() => {
      const main = document.querySelector('#main');
      return !!main && !(main.textContent || '').includes('שויך אוטומטית');
    }, null, { timeout: 20_000 })
      .catch(() => { throw new Error('the machine-filing badge survived its own reversal'); });
    // Scoped to THAT row and wait for both refetches: the auto-action may disappear before the
    // document query has returned the row to inbox.
    const reversedRow = page.locator('table tbody tr').filter({ hasText: AUTO_ACTION_DOCUMENT_FILE });
    assert.equal(await reversedRow.count(), 1, `the reversed document is not on exactly one table row`);
    await page.waitForFunction((fileName) => {
      const row = [...document.querySelectorAll('table tbody tr')]
        .find((node) => (node.textContent || '').includes(fileName));
      const text = row?.textContent || '';
      return text.includes('לא משויך') && !text.includes('שויך אוטומטית');
    }, AUTO_ACTION_DOCUMENT_FILE, { timeout: 20_000 });
    const rowText = await reversedRow.evaluate((node) => node.textContent || '');
    assert(rowText.includes('לא משויך'), `the reversed document did not return to the folder as unfiled: ${rowText}`);
    assert.equal(/ברמת ביטחון \d/.test(await page.locator('#main').evaluate((node) => node.textContent || '')), false,
      'a confidence is still printed for a decision that was reverted');
  } finally {
    await closeContext(context);
  }
}

/**
 * Package 5 (#101 / DEBT-REGISTER §2, closed 09.08.2026) — an offline reload keeps the app.
 *
 * The one scenario that runs WITHOUT serviceWorkers:'block', because the worker IS the thing
 * under test: load /login, wait until the worker CONTROLS the page, prove every same-origin
 * resource named by the cached HTML is present, cut the page target's network through CDP, then
 * reload. Page-target emulation matters: Playwright's BrowserContext-wide offline switch bypasses
 * Service Worker fetch dispatch in system Chromium and would test the harness rather than the PWA.
 * Data endpoints remain uncached, so expected offline noise is network failures — never a blank page.
 */
async function offlineShellReload(browser) {
  const context = await browser.newContext({ locale: 'he-IL', viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  captureConsole(page, 'offline-shell-reload', [
    /ERR_INTERNET_DISCONNECTED/, /ERR_NAME_NOT_RESOLVED/, /ERR_FAILED/, /ERR_CONNECTION/,
    /Failed to fetch/, /NetworkError/, /net::/, /TypeError: Failed/,
  ]);
  try {
    await page.goto(`${baseURL}/login`);
    await page.waitForFunction(
      () => 'serviceWorker' in navigator && !!navigator.serviceWorker.controller,
      null, { timeout: 30_000 },
    ).catch(() => { throw new Error('the service worker never took control — precache cannot be proven'); });

    const cacheProof = await page.evaluate(async () => {
      const cacheName = (await caches.keys()).find((name) => name.startsWith('supplyflow-shell-'));
      if (!cacheName) return { cacheName: null, missing: ['index.html'] };
      const cache = await caches.open(cacheName);
      const index = await cache.match('/index.html');
      if (!index) return { cacheName, missing: ['index.html'] };
      const document = new DOMParser().parseFromString(await index.text(), 'text/html');
      const paths = [...document.querySelectorAll('script[src], link[href]')]
        .map((element) => element.getAttribute('src') || element.getAttribute('href'))
        .filter(Boolean)
        .map((value) => new URL(value, location.origin))
        .filter((url) => url.origin === location.origin)
        .map((url) => url.pathname);
      const missing = [];
      for (const resourcePath of [...new Set(paths)]) {
        if (!(await cache.match(resourcePath))) missing.push(resourcePath);
      }
      return { cacheName, missing };
    });
    assert(cacheProof.cacheName, 'the activated worker created no versioned shell cache');
    assert.deepEqual(cacheProof.missing, [], `the cached HTML depends on uncached shell resources: ${cacheProof.missing.join(', ')}`);

    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    try {
      await cdp.send('Network.emulateNetworkConditions', {
        offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('#email').waitFor({ state: 'visible', timeout: 20_000 });
      await page.locator('#password').waitFor({ state: 'visible', timeout: 5_000 });
      await page.screenshot({ path: path.join(outDir, 'offline-shell-390.png') });
      report.screenshots.push('offline-shell-390.png');
    } finally {
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
      }).catch(() => {});
      await cdp.detach().catch(() => {});
    }
  } finally {
    await closeContext(context);
  }
}

/**
 * Package 2 (decisions #49 + #116, 09.08.2026) — the receiving screen's two new affordances,
 * asserted per role, with the same route-mock shape receivingAccessibility uses.
 *
 * Three parts: (A) office with a delivery note sees the unordered-item guidance; (B) office
 * completing a receipt with a
 * damaged line sends p_open_credits=true and the damaged status in the payload — the DB half
 * (the credit rows themselves) is proven in p1_financial_commands.sql against the real
 * function; (C) office gets the button, and confirming the reasoned dialog posts
 * open_manual_exception with item_not_ordered and the typed reason, verbatim.
 */
async function receivingDecisionsContract(browser) {
  const order = {
    id: 'p4-d2-order', org_id: 'p4-ui-org', supplier_id: 'p4-d2-supplier', number: 9002,
    status: 'confirmed', order_date: '2026-08-01', expected_date: '2026-08-03', total_amount: 120,
    created_at: '2026-08-01T08:00:00Z',
    notes: null, supplier: { id: 'p4-d2-supplier', name: 'ספק בדיקת החלטות' },
    items: [{
      id: 'p4-d2-item', org_id: 'p4-ui-org', order_id: 'p4-d2-order', product_id: 'p4-d2-product',
      qty: 10, received_qty: 2, unit_price: 12,
      product: { name: 'מוצר בדיקת החלטות', unit: 'יחידה', sku: null, barcode: null },
    }],
  };
  const interpretation = {
    payload: { line_items: [{ source_row: 3, values: { description: 'ארגז שלא הוזמן', quantity: 3 } }] },
    suggested_supplier_id: null,
  };
  const routeOrder = (context) => Promise.all([
    context.route('**/rest/v1/purchase_orders?**', (route) => {
      const url = new URL(route.request().url());
      const detail = (url.searchParams.get('id') || '') === 'eq.p4-d2-order';
      return route.fulfill({ status: 200, headers: jsonHeaders, json: detail ? order : [order] });
    }),
    context.route('**/rest/v1/goods_receipts?**', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: null })),
    context.route('**/rest/v1/document_interpretations?**', (route) =>
      route.fulfill({ status: 200, headers: jsonHeaders, json: interpretation })),
    context.route('**/rest/v1/supplier_products?**', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: [] })),
  ]);

  // (A) + (B) — office receiving flow.
  const receiverContext = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  const receiverPage = await receiverContext.newPage();
  captureConsole(receiverPage, 'receiving-decisions-office-mobile');
  const savePayloads = [];
  try {
    await login(receiverPage, 'office');
    await routeOrder(receiverContext);
    await receiverContext.route('**/rest/v1/rpc/save_goods_receipt', (route) => {
      savePayloads.push(route.request().postDataJSON());
      return route.fulfill({ status: 200, headers: jsonHeaders, json: { receipt_id: 'a0000000-0000-4000-8000-000000000002' } });
    });

    await receiverPage.goto(`${baseURL}/receiving/p4-d2-order?document=p4-d2-doc`);
    await settle(receiverPage);
    await receiverPage.getByText('שורות בתעודה שלא זוהו במחירון הספק').waitFor();
    await receiverPage.getByText('פתיחת דרישות זיכוי אוטומטית לחוסרים, לפריטים פגומים ולהחזרות').waitFor();

    // (B) — no document param: the same flow receivingAccessibility proves, plus the damaged line.
    await receiverPage.goto(`${baseURL}/receiving/p4-d2-order`);
    await settle(receiverPage);
    await receiverPage.getByRole('button', { name: 'פגום עבור מוצר בדיקת החלטות' }).click();
    await receiverPage.getByRole('button', { name: /סיום קבלה/ }).click();
    await receiverPage.getByRole('heading', { name: 'הקבלה נשמרה!' }).waitFor();
    const completion = savePayloads.find((p) => p.p_complete === true);
    assert(completion, 'no completing save_goods_receipt call was captured');
    assert.equal(completion.p_open_credits, true, 'the damaged receipt did not ask for automatic credits');
    assert(completion.p_lines.some((line) => line.status === 'damaged'),
      'the damaged line did not reach the payload as damaged');
  } finally {
    await closeContext(receiverContext);
  }

  // (C) — office
  const officeContext = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block' });
  const officePage = await officeContext.newPage();
  captureConsole(officePage, 'receiving-decisions-office');
  const exceptionCalls = [];
  try {
    await login(officePage, 'office');
    await routeOrder(officeContext);
    await officeContext.route('**/rest/v1/rpc/open_manual_exception', (route) => {
      exceptionCalls.push(route.request().postDataJSON());
      return route.fulfill({ status: 200, headers: jsonHeaders, json: { exception_id: 'e0000000-0000-4000-8000-000000000001', idempotent: false } });
    });

    await officePage.goto(`${baseURL}/receiving/p4-d2-order?document=p4-d2-doc`);
    await settle(officePage);
    await officePage.getByRole('button', { name: 'פתיחת חריג לבירור', exact: true }).click();
    const dialog = officePage.locator('[role="dialog"]');
    await dialog.waitFor();
    await dialog.locator('textarea').fill('הגיע ארגז שלא הוזמן — נדרש בירור מול הספק');
    await dialog.getByRole('button', { name: 'פתיחת חריג', exact: true }).click();
    await officePage.getByText('החריג נפתח ויופיע במסך החריגים').waitFor({ timeout: 10_000 });
    assert.equal(exceptionCalls.length, 1, `open_manual_exception was called ${exceptionCalls.length} times`);
    assert.equal(exceptionCalls[0].p_type, 'item_not_ordered', 'the manual exception did not use the honest type');
    assert.equal(exceptionCalls[0].p_entity_type, 'purchase_orders', 'the manual exception named the wrong entity type');
    assert.equal(exceptionCalls[0].p_entity_id, 'p4-d2-order', 'the manual exception named the wrong entity');
    assert.equal(exceptionCalls[0].p_reason, 'הגיע ארגז שלא הוזמן — נדרש בירור מול הספק',
      'the operator reason did not reach the server verbatim');
  } finally {
    await closeContext(officeContext);
  }
}

/**
 * Package 1 (OPEN-DECISIONS #114) — the password-recovery path, end to end minus the mailbox.
 *
 * Part 1 proves the app's half of /forgot-password: the form reaches /auth/v1/recover with the
 * typed address and a redirect_to aimed at /reset-password. That response is stubbed, because the
 * isolated stack has no mailbox — GoTrue's half is proven in part 2, which follows a REAL
 * recovery link: GoTrue itself mints it (admin generate_link — the same token the email would
 * carry), the browser lands on /reset-password exactly as a mail client would, sets a new
 * password through the form, and the new password must then open the app from a cold login.
 * The office password is restored through the admin API in `finally`, so later scenarios keep
 * their credentials no matter where this one stops.
 */
async function passwordRecovery(browser) {
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block' });
  const page = await context.newPage();
  captureConsole(page, 'password-recovery');
  const account = credentials('office');
  const newPassword = `P4!${passwordSeed}-office-changed-9`;
  const adminHeaders = {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    'content-type': 'application/json',
  };
  let userId = null;
  let passwordChanged = false;
  try {
    // ---- part 1: the form's half of the contract
    let recover = null;
    await page.route('**/auth/v1/recover*', async (route) => {
      recover = { url: route.request().url(), body: JSON.parse(route.request().postData() || '{}') };
      await route.fulfill({ status: 200, headers: jsonHeaders, body: '{}' });
    });
    await page.goto(`${baseURL}/login`);
    await page.getByRole('link', { name: 'שכחתי סיסמה' }).click();
    await page.waitForFunction(() => location.pathname === '/forgot-password', null, { timeout: 15_000 });
    const recoverySubmit = page.getByRole('button', { name: 'שליחת קישור איפוס' });
    const recoveryForm = page.locator('form').filter({ has: recoverySubmit });
    await recoveryForm.waitFor({ timeout: 15_000 });
    await recoveryForm.locator('#email').fill(account.email);
    await recoverySubmit.click();
    await page.getByText('אם הכתובת רשומה במערכת').waitFor({ timeout: 10_000 });
    assert(recover, 'no /auth/v1/recover request was issued');
    assert.equal(recover.body.email, account.email, 'recover did not carry the typed address');
    assert((recover.url + JSON.stringify(recover.body)).includes('reset-password'),
      'recover did not aim its redirect at /reset-password');
    await page.unroute('**/auth/v1/recover*');

    // ---- part 2: a real GoTrue recovery link, followed like a mail client would
    const linkRes = await fetch(`${apiURL}/auth/v1/admin/generate_link`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ type: 'recovery', email: account.email, redirect_to: `${baseURL}/reset-password` }),
    });
    assert.equal(linkRes.status, 200, `admin generate_link answered HTTP ${linkRes.status}`);
    const link = await linkRes.json();
    const actionLink = link.action_link || (link.properties && link.properties.action_link);
    userId = link.id || (link.user && link.user.id) || null;
    assert(actionLink, 'generate_link returned no action_link');
    assert(userId, 'generate_link did not name the user id (needed to restore the password)');
    assert.equal(new URL(actionLink).searchParams.get('redirect_to'), `${baseURL}/reset-password`,
      'GoTrue did not accept the preview redirect_to — check additional_redirect_urls in supabase/config.toml');

    await page.goto(actionLink);
    await page.waitForFunction(() => location.pathname === '/reset-password', null, { timeout: 15_000 });
    await page.locator('#reset-password-new').fill(newPassword);
    await page.locator('#reset-password-confirm').fill(newPassword);
    await page.getByRole('button', { name: 'החלפת סיסמה' }).click();
    await page.getByText('הסיסמה הוחלפה').waitFor({ timeout: 15_000 });
    passwordChanged = true;
    // The secure completion path revokes every recovery session and returns to a cold login.
    // Staying on /reset-password means global revocation failed and must fail this scenario.
    await page.waitForFunction(() => (
      location.pathname === '/login' && new URLSearchParams(location.search).get('reset') === 'success'
    ), null, { timeout: 25_000 });
    await page.getByText('הסיסמה הוחלפה וכל החיבורים נותקו').waitFor({ timeout: 10_000 });
    await page.screenshot({ path: path.join(outDir, 'password-recovery-done.png') });
    report.screenshots.push('password-recovery-done.png');

    // The credential itself, from a cold login — not merely the recovery session.
    const coldContext = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block' });
    const coldPage = await coldContext.newPage();
    captureConsole(coldPage, 'password-recovery-cold-login');
    try {
      await coldPage.goto(`${baseURL}/login`);
      await coldPage.locator('#email').fill(account.email);
      await coldPage.locator('#password').fill(newPassword);
      await coldPage.getByRole('button', { name: 'התחברות' }).click();
      await coldPage.waitForFunction((expected) => location.pathname === expected, homes.office, { timeout: 25_000 });
    } finally {
      await closeContext(coldContext);
    }
  } finally {
    // Restore no matter where the scenario stopped: later scenarios log in as office.
    if (userId && passwordChanged) {
      const restore = await fetch(`${apiURL}/auth/v1/admin/users/${userId}`, {
        method: 'PUT', headers: adminHeaders, body: JSON.stringify({ password: account.password }),
      });
      if (restore.status !== 200) {
        report.failures.push({ name: 'password recovery cleanup', message: `password restore answered HTTP ${restore.status}` });
      }
    }
    await closeContext(context);
  }
}

/**
 * Package 0 — the design partner's feedback note.
 *
 * What is routed: only the Edge Function. The flag comes from the real demo seed, because this
 * scenario is the regression shield for the option disappearing locally; the INSERT and Storage
 * upload go to the real stack so 0091's column grants, 0125's upload policy and the screenshot
 * metadata contract are exercised from an actual browser session.
 *
 * The FAILURE path is the one asserted end to end, on purpose. Discord delivery cannot be proved
 * from a network-isolated gate, and a scenario that mocked the send and then asserted "נשלח" would
 * be asserting its own mock. What is provable here is the pair that matters: the row lands in the
 * database, and the screen tells the truth about a send that did not happen.
 */
async function feedbackNoteChannel(browser) {
  const context = await browser.newContext({
    locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 390, height: 844 },
  });
  try {
    await context.route('**/functions/v1/send-feedback', (route) => route.fulfill({
      status: 502,
      headers: jsonHeaders,
      json: { error: { code: 'delivery_failed', message: 'ההערה נשמרה, אך השליחה נכשלה' } },
    }));

    const page = await context.newPage();
    // The send is EXPECTED to fail here: the local Edge env deliberately has no
    // DISCORD_FEEDBACK_WEBHOOK_URL, because this scenario asserts the honest-failure path
    // ("ההערה נשמרה, אך השליחה נכשלה"). The HTTP error from send-feedback is therefore part
    // of the script, not an unexpected console error.
    captureConsole(page, 'feedback-note', [/functions\/v1\/send-feedback/]);
    await login(page, 'owner');
    await page.goto(`${baseURL}/dashboard`);
    await settle(page);

    // The trigger lives in the DRAWER on a phone (owner report 25.08.2026): the top bar gave its
    // slot to the subscription tier mark. On desktop it is still in the bar. The menu STAYS OPEN
    // behind the dialog -- see the note in FeedbackButton for why closing it was wrong.
    await page.getByRole('button', { name: 'פתיחת תפריט' }).click();
    await page.locator('#mobile-navigation').waitFor();
    const trigger = page.getByRole('button', { name: 'שליחת הערה' });
    await trigger.waitFor();
    const box = await trigger.boundingBox();
    assert(box && box.width >= 44 && box.height >= 44,
      `the feedback trigger is ${box && Math.round(box.width)}x${box && Math.round(box.height)}, below the 44px touch floor`);

    await trigger.click();
    await page.getByText('לצרף צילום של המסך', { exact: true }).waitFor();
    // The drawer must not reach the picture, and the mechanism is exclusion rather than removal:
    // the panel is already `role="dialog"`, which `SKIP_SELECTOR` skips, and the scrim behind it
    // carries `data-no-capture` so a half-opaque sheet does not tint the whole screenshot. Both
    // markers are asserted, because losing either one is invisible until somebody reads a note
    // with a photograph of the menu attached to it.
    assert.equal(await page.locator('#mobile-navigation[role="dialog"]').count(), 1,
      'the drawer lost role="dialog" -- the screenshot would now include the open menu');
    assert.equal(await page.locator('[data-no-capture]:has(#mobile-navigation)').count(), 1,
      'the drawer scrim is not marked data-no-capture -- the screenshot would be tinted by it');
    await page.getByAltText('תצוגה מקדימה של הצילום שיישלח').waitFor();
    // Unique per run: the lookup below must find this note and not a previous run's.
    const note = `בדיקת שער ${Date.now()}`;
    await page.getByLabel('ההערה').fill(note);
    await page.screenshot({ path: path.join(outDir, 'feedback-note-390.png') });
    report.screenshots.push('feedback-note-390.png');
    await page.getByRole('button', { name: 'שליחה' }).click();

    await page.getByText('ההערה נשמרה, אך השליחה נכשלה').waitFor();
    // Substring, not sentence: this caught a real copy defect on 11.08.2026, when the "saved but
    // not delivered" toast grew a parenthetical about the screenshot that happened to contain the
    // words "ההערה נשלחה". A failure message must not contain a delivery claim
    // anywhere inside it, however it got there.
    assert.equal(await page.getByText(/ההערה נשלחה/).count(), 0,
      'the screen claimed a delivery that failed');

    // The row is the record. It must exist exactly once, name the screen it was written from, and
    // carry no delivery stamp — the browser holds no grant that could have written one.
    const stored = await fetch(
      `${apiURL}/rest/v1/feedback_notes?select=note,route,role,sent_at,send_error,screenshot_path,screenshot_bytes,screenshot_checksum,screenshot_mime&note=eq.${encodeURIComponent(note)}`,
      { headers: { apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}` } },
    );
    assert(stored.ok, `feedback note lookup failed with HTTP ${stored.status}`);
    const rows = await stored.json();
    assert.equal(rows.length, 1, `the note was stored ${rows.length} times, expected exactly once`);
    assert.equal(rows[0].route, '/dashboard',
      `the stored note names ${rows[0].route}, not the screen it was written from`);
    assert.equal(rows[0].sent_at, null, 'a send that failed left sent_at set');
    assert.match(rows[0].screenshot_path ?? '',
      /^11111111-1111-4111-8111-111111111111\/[0-9a-f-]{36}\.png$/,
      `the stored note did not carry its tenant-scoped screenshot path: ${rows[0].screenshot_path}`);
    assert(Number(rows[0].screenshot_bytes) > 0, 'the stored screenshot has no byte count');
    assert.match(rows[0].screenshot_checksum ?? '', /^[0-9a-f]{64}$/,
      'the stored screenshot checksum is missing or malformed');
    assert.equal(rows[0].screenshot_mime, 'image/png', 'the stored screenshot is not a PNG');
  } finally {
    await closeContext(context);
  }
}

async function consolidatedSupplierInvoice(browser) {
  const context = await browser.newContext({
    locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 390, height: 844 },
  });
  const caseId = '13600000-0000-4000-8000-000000000001';
  const supplierId = '13640000-0000-4000-8000-000000000001';
  const legalEntityId = '13620000-0000-4000-8000-000000000001';
  const documentId = '13690000-0000-4000-8000-000000000001';
  const month = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit',
  }).formatToParts(new Date());
  const year = Number(month.find((part) => part.type === 'year').value);
  const monthNumber = Number(month.find((part) => part.type === 'month').value);
  const target = new Date(Date.UTC(year, monthNumber - 2, 1));
  const targetMonth = `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const invoiceDate = `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, '0')}-05`;
  const rpc = (name, json) => context.route(`**/rest/v1/rpc/${name}`, (route) =>
    route.fulfill({ status: 200, headers: jsonHeaders, json }));
  await context.route('**/rest/v1/suppliers?**', (route) => route.fulfill({
    status: 200, headers: jsonHeaders, json: [{ id: supplierId, name: 'ספק בדיקת מרכזת' }],
  }));
  await rpc('list_consolidated_invoice_legal_entities', [{ id: legalEntityId, name: 'הישות הראשית' }]);
  await rpc('list_consolidated_invoice_cases', []);
  await rpc('open_consolidated_invoice_intake', {
    intake_id: '13680000-0000-4000-8000-000000000001', case_id: caseId,
    processing_mode: 'consolidated_supplier_invoice', supplier_id: supplierId,
    target_month: targetMonth, legal_entity_id: legalEntityId, status: 'uploading',
    source_page_count: 1, idempotent: false,
  });
  await rpc('register_consolidated_invoice_page', {
    intake_id: '13680000-0000-4000-8000-000000000001',
    page_id: '13681000-0000-4000-8000-000000000001', page_number: 1,
    document_id: documentId, storage_path: `demo/consolidated/${documentId}.pdf`, idempotent: false,
  });
  await rpc('complete_consolidated_invoice_intake', {
    intake_id: '13680000-0000-4000-8000-000000000001', case_id: caseId,
    status: 'ready', primary_document_id: documentId, document_ids: [documentId],
    source_page_count: 1, idempotent: false,
  });
  await rpc('enqueue_document_processing', { job_id: '13682000-0000-4000-8000-000000000001' });
  await rpc('get_consolidated_invoice_workspace', {
    case: {
      id: caseId, supplier_id: supplierId, supplier_name: 'ספק בדיקת מרכזת',
      target_month: targetMonth, legal_entity_id: legalEntityId, legal_entity_name: 'הישות הראשית',
      status: 'warnings', anchor_invoice_id: '13670000-0000-4000-8000-000000000001',
      current_revision: 2, warning_count: 3,
      created_at: `${invoiceDate}T08:00:00Z`, updated_at: `${invoiceDate}T09:00:00Z`,
    },
    anchor: {
      invoice_id: '13670000-0000-4000-8000-000000000001', document_ids: [documentId],
      invoice_number: 'M-136', invoice_date: invoiceDate, amount_before_vat: 100,
      vat_amount: 18, total_amount: 118, financial_role: 'payable',
      review_status: 'received', payment_status: 'unpaid',
    },
    sources: [{
      source_type: 'interim_invoice', source_id: '13671000-0000-4000-8000-000000000001',
      document_id: null, document_number: 'I-136', document_date: invoiceDate,
      total_amount: 118, financial_role: 'supporting_evidence', status: 'received', late_arrival: false,
    }],
    reconciliation: {
      anchor_vs_interim: [{
        comparison: 'anchor_vs_interim', result: 'matched', product_id: '13630000-0000-4000-8000-000000000001',
        product_name: 'קמח', supplier_sku: 'FLOUR-1', barcode: null,
        anchor_quantity: 1, interim_quantity: 1, received_quantity: null,
        anchor_unit_price: 100, interim_unit_price: 100, anchor_amount: 100,
        interim_amount: 100, difference_quantity: 0, difference_amount: 0,
        source_ids: [], message_key: 'consolidated_invoice.matched', severity: 'info',
      }],
      anchor_vs_receipts: [{
        comparison: 'anchor_vs_receipts', result: 'missing_source', product_id: null,
        product_name: 'שמן', supplier_sku: 'OIL-1', barcode: null,
        anchor_quantity: 2, interim_quantity: null, received_quantity: null,
        anchor_unit_price: 10, interim_unit_price: null, anchor_amount: 20,
        interim_amount: null, difference_quantity: 2, difference_amount: 20,
        source_ids: [], message_key: 'consolidated_invoice.missing_source', severity: 'warning',
      }],
      interim_vs_receipts: [{
        comparison: 'interim_vs_receipts', result: 'ambiguous', product_id: null,
        product_name: 'מוצר לא מזוהה', supplier_sku: null, barcode: null,
        anchor_quantity: null, interim_quantity: 1, received_quantity: 1,
        anchor_unit_price: null, interim_unit_price: 5, anchor_amount: null,
        interim_amount: 5, difference_quantity: 0, difference_amount: 0,
        source_ids: [], message_key: 'consolidated_invoice.ambiguous', severity: 'warning',
      }],
    },
    current_revision: {
      id: '13683000-0000-4000-8000-000000000001', revision: 2,
      trigger: 'late_arrival', created_at: `${invoiceDate}T09:00:00Z`, created_by: null,
    },
    warnings: [{
      code: 'consolidated_late_revision_created', severity: 'warning',
      message_key: 'consolidated_invoice.late_revision', source_type: 'interim_invoice',
      source_id: '13671000-0000-4000-8000-000000000001', product_id: null,
    }],
  });
  await context.route('**/storage/v1/upload/resumable**', async (route) => {
    const method = route.request().method();
    const common = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST,HEAD,PATCH,OPTIONS',
      'access-control-allow-headers': '*',
      'access-control-expose-headers': 'Location,Upload-Offset,Tus-Resumable',
      'tus-resumable': '1.0.0',
    };
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: common });
    if (method === 'POST') return route.fulfill({
      status: 201,
      headers: { ...common, location: `${apiURL}/storage/v1/upload/resumable/${documentId}`, 'upload-offset': String(route.request().postDataBuffer()?.length ?? 0) },
    });
    if (method === 'HEAD') return route.fulfill({ status: 200, headers: { ...common, 'upload-offset': '8', 'upload-length': '8' } });
    return route.fulfill({ status: 204, headers: { ...common, 'upload-offset': '8' } });
  });

  const page = await context.newPage();
  captureConsole(page, 'consolidated-invoice');
  try {
    await login(page, 'owner');
    await page.goto(`${baseURL}/documents/consolidated-invoices`);
    await settle(page);
    await page.locator('#consolidated-supplier').selectOption(supplierId);
    await page.waitForFunction((id) => document.querySelector('#consolidated-legal-entity')?.value === id, legalEntityId);
    await page.getByLabel('העלאת עמודי חשבונית מרכזת').setInputFiles({
      name: 'central-invoice.pdf', mimeType: 'application/pdf', buffer: Buffer.from('p45-file'),
    });
    await page.getByText('עמודים נקלטו כחשבונית מרכזת אחת').waitFor({ timeout: 15_000 });
    await page.getByRole('heading', { name: /ספק בדיקת מרכזת/ }).waitFor();
    for (const title of [
      'מרכזת מול חשבוניות ביניים', 'מרכזת מול קבלות שהושלמו', 'חשבוניות ביניים מול קבלות',
    ]) assert.equal(await page.getByRole('heading', { name: title }).count(), 1, `${title}: missing`);
    await auditAccessibility(page, 'consolidated-invoice:390');
    await page.screenshot({ path: path.join(outDir, 'consolidated-invoice-390.png'), fullPage: true });
    report.screenshots.push('consolidated-invoice-390.png');
    report.viewports.push({ scope: 'consolidated-invoice', width: 390, height: 844 });

    await page.setViewportSize({ width: 1440, height: 900 });
    await auditAccessibility(page, 'consolidated-invoice:1440');
    await page.screenshot({ path: path.join(outDir, 'consolidated-invoice-1440.png'), fullPage: true });
    report.screenshots.push('consolidated-invoice-1440.png');
    report.viewports.push({ scope: 'consolidated-invoice', width: 1440, height: 900 });
  } finally {
    await closeContext(context);
  }
}

async function supplierPortalLocales(browser) {
  const token = 'ab'.repeat(32);
  const portalView = {
    state: 'open',
    expires_at: '2026-09-01T09:00:00.000Z',
    proposal: null,
    snapshot: {
      order_id: 'c8600000-0000-4000-8000-000000000001',
      order_number: 238,
      revision_number: 1,
      expected_date: '2026-08-27',
      notes: 'נא לתאם עם המחסן לפני הגעה',
      supplier_name: 'ירקות השדה בע"מ',
      org_name: 'מסעדת הגן הקסום',
      issued_at: '2026-08-20T09:00:00.000Z',
      items: [
        {
          order_item_id: 'c8610000-0000-4000-8000-000000000001', position: 1,
          product_name: 'עגבניות שרי 500 גרם', unit: 'unit', qty: 12, unit_price: 8.9,
        },
        {
          order_item_id: 'c8610000-0000-4000-8000-000000000002', position: 2,
          product_name: 'מלפפון בייבי', unit: 'kg', qty: 6, unit_price: 7.5,
        },
      ],
    },
  };
  const locales = {
    he: {
      browser: 'he-IL', dir: 'rtl', title: 'אישור הזמנת רכש', heading: /הזמנה #238/,
      quantity: 'כמות מוצעת', submit: 'אישור ההזמנה כפי שנשלחה',
      switchName: 'מעבר לאנגלית', submitted: 'כבר נשלחה תשובה להזמנה זו', invalid: 'הקישור אינו פעיל',
    },
    en: {
      browser: 'en-US', dir: 'ltr', title: 'Purchase order response', heading: /Order #238/,
      quantity: 'Proposed quantity', submit: 'Approve the order as sent',
      switchName: 'Switch to Hebrew', submitted: 'A response has already been sent for this order',
      invalid: 'This link is not active',
    },
  };

  for (const [locale, copy] of Object.entries(locales)) {
    for (const [size, width, height] of [['390', 390, 844], ['1440', 1440, 900]]) {
      const scope = `supplier-portal:${locale}:${size}`;
      const context = await browser.newContext({
        locale: copy.browser, serviceWorkers: 'block', viewport: { width, height }, reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      captureConsole(page, scope);
      try {
        await page.route('**/functions/v1/supplier-portal', (route) => route.fulfill({ json: portalView }));
        await page.goto(`${baseURL}/portal.html?lang=${locale}#token=${token}`);
        await page.getByRole('heading', { name: copy.heading }).waitFor({ timeout: 15_000 });
        await page.getByLabel(copy.quantity).first().waitFor();
        assert.equal(await page.title(), copy.title, `${scope}: wrong document title`);
        await auditAccessibility(page, scope, locale, copy.dir);
        await assertAccessibilityTreeNames(page, scope, [copy.switchName, copy.quantity, copy.submit]);

        // The language switch is the first interactive control in the standalone portal entry.
        await page.keyboard.press('Tab');
        assert.equal(
          await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
          copy.switchName,
          `${scope}: language switch is not first in keyboard order`,
        );

        const fileName = `supplier-portal-open-${locale}-${size}.png`;
        await page.screenshot({ path: path.join(outDir, fileName), fullPage: true });
        report.screenshots.push(fileName);
        report.viewports.push({ scope, width, height });
      } finally {
        await closeContext(context);
      }
    }

    const context = await browser.newContext({
      locale: copy.browser, serviceWorkers: 'block', viewport: { width: 390, height: 844 },
      reducedMotion: 'reduce',
    });
    try {
      const submitted = await context.newPage();
      captureConsole(submitted, `supplier-portal:${locale}:submitted`);
      await submitted.route('**/functions/v1/supplier-portal', (route) => route.fulfill({
        json: {
          ...portalView,
          state: 'submitted',
          proposal: {
            status: 'submitted', submitted_at: '2026-08-20T10:00:00.000Z',
            proposed_delivery_date: '2026-08-29', total_delta: -42.5,
          },
        },
      }));
      await submitted.goto(`${baseURL}/portal.html?lang=${locale}#token=${token}`);
      await submitted.getByText(copy.submitted).waitFor({ timeout: 15_000 });
      await auditAccessibility(submitted, `supplier-portal:${locale}:submitted`, locale, copy.dir);
      const submittedShot = `supplier-portal-submitted-${locale}-390.png`;
      await submitted.screenshot({ path: path.join(outDir, submittedShot), fullPage: true });
      report.screenshots.push(submittedShot);

      const invalid = await context.newPage();
      captureConsole(
        invalid,
        `supplier-portal:${locale}:invalid`,
        [],
        (response) => response.status() === 404
          && response.url().includes('/functions/v1/supplier-portal'),
      );
      await invalid.route('**/functions/v1/supplier-portal', (route) => route.fulfill({
        status: 404, json: { error: 'link_invalid' },
      }));
      await invalid.goto(`${baseURL}/portal.html?lang=${locale}#token=${token}`);
      await invalid.getByText(copy.invalid).waitFor({ timeout: 15_000 });
      await auditAccessibility(invalid, `supplier-portal:${locale}:invalid`, locale, copy.dir);
      const invalidShot = `supplier-portal-invalid-${locale}-390.png`;
      await invalid.screenshot({ path: path.join(outDir, invalidShot), fullPage: true });
      report.screenshots.push(invalidShot);
    } finally {
      await closeContext(context);
    }
  }
}

async function run(name, check) {
  if (process.env.QUALITY_ONLY && !name.includes(process.env.QUALITY_ONLY)) {
    const reason = `QUALITY_ONLY=${process.env.QUALITY_ONLY}`;
    report.skipped.push({ name, reason });
    console.log(`${name}: SKIP — ${reason}`);
    return;
  }
  try {
    await check();
    report.passed.push(name);
    console.log(`${name}: PASS`);
  } catch (error) {
    report.failures.push({ name, message: error.message, stack: error.stack?.split('\n').slice(0, 4).join('\n') });
    console.log(`${name}: FAIL — ${error.message}`);
  }
}

async function supplierEmailDeliverySurface(browser) {
  const context = await browser.newContext({
    locale: 'he-IL',
    serviceWorkers: 'block',
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  captureConsole(page, 'supplier-email-delivery');
  try {
    await login(page, 'owner');

    await page.goto(`${baseURL}/suppliers/aa000000-0000-4000-8000-000000000012`);
    await settle(page);
    const communicationHeading = page.getByRole('heading', { name: 'תקשורת עם הספק', exact: true });
    await communicationHeading.waitFor();
    const communicationCard = communicationHeading.locator('xpath=ancestor::div[contains(@class,"card")][1]');
    await communicationCard.getByRole('button', { name: 'עריכה', exact: true }).click();

    const preferences = page.getByRole('dialog', { name: 'העדפות תקשורת עם הספק' });
    await preferences.waitFor();
    await preferences.locator('#comm-channel').selectOption('email');
    await preferences.locator('#comm-locale').selectOption('en');
    await preferences.locator('#comm-reason').fill('Browser gate: supplier email delivery');
    await auditAccessibility(page, 'supplier-email-preferences');
    await page.screenshot({ path: path.join(outDir, 'supplier-email-preferences-1440.png'), fullPage: true });
    report.screenshots.push('supplier-email-preferences-1440.png');
    await preferences.getByRole('button', { name: 'שמירה', exact: true }).click();
    await preferences.waitFor({ state: 'hidden' });
    await communicationCard.getByText('מייל', { exact: true }).waitFor();
    await communicationCard.getByText('alon@hadpaami-alef.demo', { exact: true }).waitFor();

    await page.goto(`${baseURL}/orders/f0000000-0000-4000-8000-000000000014`);
    await settle(page);
    const emailHeading = page.getByRole('heading', { name: 'מסירת ההזמנה במייל', exact: true });
    await emailHeading.waitFor();
    const emailCard = emailHeading.locator('xpath=ancestor::div[contains(@class,"card")][1]');
    const send = emailCard.getByRole('button', { name: 'שליחת ההזמנה במייל', exact: true });
    await send.waitFor();
    await page.screenshot({ path: path.join(outDir, 'supplier-email-order-1440.png'), fullPage: true });
    report.screenshots.push('supplier-email-order-1440.png');

    await send.click();
    const confirm = page.getByRole('dialog', { name: 'שליחת ההזמנה לספק במייל' });
    await confirm.waitFor();
    assert.match(await confirm.textContent(), /תסומן כנשלחה רק לאחר שספק המייל יאשר/,
      'email confirmation implied click success instead of provider acceptance');
    await auditAccessibility(page, 'supplier-email-confirm');
    await confirm.getByRole('button', { name: 'ביטול', exact: true }).click();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(outDir, 'supplier-email-order-390.png'), fullPage: true });
    report.screenshots.push('supplier-email-order-390.png');
    const metrics = await page.evaluate(() => ({
      width: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    const overflow = metrics.documentWidth - metrics.clientWidth;
    report.viewports.push({ role: 'owner', label: 'supplier-email-390', ...metrics, overflow });
    assert(overflow <= 1, `supplier-email/390: horizontal overflow ${overflow}px`);
    await auditAccessibility(page, 'supplier-email-order-mobile');
  } finally {
    await closeContext(context);
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: browserPath });
  try {
    await run('role and viewport matrix', () => roleAndViewportMatrix(browser));
    await run('retired kitchen, payer and supplier accounts cannot sign in', () => retiredPersonasBlocked(browser));
    await run('mobile action bar, and no quick-action surface on desktop', () => quickActionsContract(browser));
    await run('overlay stacking and breakpoint reset', () => overlayStacking(browser));
    await run('dashboard, quick actions and dialogs', () => dashboardAndDialogs(browser));
    await run('golden screen visual baseline', () => goldenScreens(browser));
    await run('DataTable, ActionMenu, route focus and mobile search', () => tableKeyboardAndSearch(browser));
    await run('receiving contextual names and accessibility', () => receivingAccessibility(browser));
    await run('offline receiving queues once and keeps its key', () => offlineReceiving(browser));
    await run('barcode flag off and camera denied', () => barcodeFlagAndCamera(browser));
    await run('order split, minimum fixes and reason-free approval', () => orderSupplierComparison(browser));
    await run('payment-request names and modal stack', () => paymentRequestNamesAndModalStack(browser));
    await run('bank contextual names and accessibility', () => bankContextualNames(browser));
    await run('partial Alerts never all-clear or mark read', () => alertsPartialFailure(browser));
    await run('Settings failure never reports success', () => settingsFalseSuccess(browser));
    await run('temporary auth bootstrap supports retry', () => bootstrapRetry(browser));
    await run('lazy chunk failure recovers', () => lazyChunkRecovery(browser));
    await run('monthly report print and PDF', () => reportsAndPdf(browser));
    await run('PWA update preserves open state', () => pwaUpdate(browser));
    await run('Push logout all success', () => pushLogout(browser, 'all-success', true, true));
    await run('Push logout server failure', () => pushLogout(browser, 'server-failure', false, true));
    await run('Push logout browser failure', () => pushLogout(browser, 'browser-failure', true, false));
    await run('Push logout double failure', () => pushLogout(browser, 'double-failure', false, false));
    await run('operator console: platform admin lands on /operator, password and clipboard state', () => adminState(browser));
    await run('public signup asks for four fields and answers the same either way', () => publicSignupSurface(browser));
    await run('operator console: the customer list gates on capability and never invents activity', () => operatorCustomers(browser));
    await run('operator console refuses a tenant who is not a platform admin', () => operatorRefusal(browser));
    await run('OCR documents, review, status and export', () => documentOcrAcceptance(browser));
    await run('automatic price list creates keyed products and leaves unsafe rows for review', () => automaticPriceListAcceptance(browser));
    await run('a read price list is accepted in one click, per-line approval stays the exception', () => manualPriceListConfirmation(browser));
    await run('global search type gate: accountant receives only reachable types', () => searchTypeGate(browser));
    await run('navigation opens on the control centre and the archive is current alone', () => navigationOrderAndActiveState(browser));
    await run('documents speak human states and keep the numbers behind the disclosure', () => documentVocabulary(browser));
    await run('a machine-filed document names its author and can be undone', () => machineFiledDocument(browser));
    await run('receiving speaks the #49/#116 decisions per role', () => receivingDecisionsContract(browser));
    await run('an offline reload keeps the app shell', () => offlineShellReload(browser));
    // Late on purpose: it rotates the office password against the live GoTrue and restores it
    // in `finally` — running it after the scenarios that log in as office keeps a mid-scenario
    // crash from cascading into theirs.
    await run('forgotten password recovers by mail link and the new password signs in', () => passwordRecovery(browser));
    // Registered last on purpose: it is the only scenario that inserts a row into the live
    // database, and running it after everything else keeps that row out of every other check.
    await run('a supplier is created inside the price-list dialog', () => priceListSupplierDoor(browser));
    // Also writes a live row, for the same reason and with the same placement.
    await run('a feedback note is stored and a failed send says so', () => feedbackNoteChannel(browser));
    await run('consolidated supplier invoice uploads once and exposes three RTL reconciliation channels', () => consolidatedSupplierInvoice(browser));
    await run('supplier portal is bilingual, isolated, keyboard reachable and screen-reader named', () => supplierPortalLocales(browser));
    await run('supplier email preferences and provider-accepted delivery stay explicit and responsive', () => supplierEmailDeliverySurface(browser));
  } finally {
    await browser.close();
  }

  if (process.env.QUALITY_REQUIRE_ALL === '1' && report.skipped.length) {
    report.failures.push({
      name: 'browser checks were skipped',
      message: JSON.stringify(report.skipped),
    });
  }
  if (report.consoleErrors.length) {
    report.failures.push({ name: 'unexpected browser console errors', message: JSON.stringify(report.consoleErrors) });
  }
  fs.writeFileSync(path.join(outDir, 'p4-browser-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({
    passed: report.passed.length,
    skipped: report.skipped,
    failed: report.failures.length,
    viewportChecks: report.viewports.length,
    accessibilityAudits: report.accessibility.length,
    screenshots: report.screenshots,
    pdfBytes: report.pdf?.bytes ?? 0,
    failures: report.failures,
  }, null, 2));
  if (report.failures.length) process.exitCode = 1;
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
