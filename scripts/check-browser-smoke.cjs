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
const OCR_STAGE_FIXTURES = [
  ['97000000-0000-4000-8000-000000000001', 'טרם נשלח לעיבוד'],
  ['97000000-0000-4000-8000-000000000002', 'ממתין לעיבוד'],
  ['97000000-0000-4000-8000-000000000003', 'בעיבוד'],
  ['97000000-0000-4000-8000-000000000004', 'דורש בדיקה'],
  ['97000000-0000-4000-8000-000000000005', 'הושלם'],
  ['97000000-0000-4000-8000-000000000006', 'נכשל'],
];

const homes = {
  owner: '/dashboard',
  office: '/dashboard',
  kitchen: '/dashboard',
  payer: '/dashboard',
  accountant: '/dashboard',
  supplier: '/dashboard',
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

function captureConsole(page, scope, ignore = []) {
  const sanitize = (value) => value.replace(/([?&]apikey=)[^&'\s]+/gi, '$1[redacted]');
  const isExpected = (value) => ignore.some((pattern) => pattern.test(value));
  page.on('pageerror', (error) => report.consoleErrors.push({ scope, text: sanitize(error.message).slice(0, 400) }));
  page.on('response', (response) => {
    if (response.status() < 400) return;
    const value = `HTTP ${response.status()} ${sanitize(response.url())}`;
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

async function supplierPortalProjection(browser) {
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const requests = [];
  captureConsole(page, 'supplier-portal-projection');
  page.on('request', (request) => requests.push(new URL(request.url()).pathname));
  try {
    await login(page, 'supplier');
    await settle(page);
    requests.length = 0;
    await page.goto(`${baseURL}/my-prices`);
    await settle(page);
    await page.getByRole('heading', { name: 'היסטוריית הגשות' }).waitFor();
    assert(requests.includes('/rest/v1/rpc/supplier_portal_context'), 'supplier portal projection RPC was not used');
    assert.equal(requests.some((requestPath) => /^\/rest\/v1\/(suppliers|supplier_products|products)$/.test(requestPath)), false,
      'supplier portal queried a base catalog table blocked by its RLS contract');
    assert.equal(await page.locator('main [role="alert"]').count(), 0, 'supplier portal rendered an error alert');
    await page.screenshot({ path: path.join(outDir, 'supplier-portal-390.png') });
    report.screenshots.push('supplier-portal-390.png');
  } finally {
    await closeContext(context);
  }
}

async function auditAccessibility(page, scope) {
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
    const main = document.querySelector('#main');
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
  assert.equal(audit.lang, 'he', `${scope}: document language is not Hebrew`);
  assert.equal(audit.dir, 'rtl', `${scope}: document direction is not RTL`);
  assert(audit.h1 >= 1, `${scope}: no level-one heading`);
  assert(audit.overflow <= 1, `${scope}: horizontal overflow ${audit.overflow}px`);
  assert.deepEqual(audit.controls, [], `${scope}: visible form controls without accessible names`);
  assert.deepEqual(audit.actions, [], `${scope}: visible actions without accessible names`);
  assert.deepEqual(audit.duplicateIds, [], `${scope}: duplicate DOM ids`);
  return audit;
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
      const hasMobileActions = ['owner', 'office', 'kitchen', 'accountant'].includes(role);
      assert.equal(await page.getByRole('group', { name: 'פעולות מהירות' }).count(), hasMobileActions ? 1 : 0,
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
      await auditAccessibility(page, `home:${role}`);
    } finally {
      await closeContext(context);
    }
  }

  const denied = [
    ['kitchen', '/bank', '/dashboard'],
    ['payer', '/products', '/dashboard'],
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
    owner: ['הזמנה חדשה', 'מרכז הבקרה', 'צילום מסמך', 'קבלת סחורה', 'חשבונית חדשה'],
    office: ['הזמנה חדשה', 'מרכז הבקרה', 'צילום מסמך', 'קבלת סחורה', 'חשבונית חדשה'],
    kitchen: ['הזמנה חדשה', 'מרכז הבקרה', 'צילום מסמך', 'קבלת סחורה', 'חשבונית חדשה'],
    accountant: ['מרכז הבקרה', 'חשבוניות', 'תשלומים'],
  };
  const roleTargets = {
    owner: ['/orders/new?fresh=1', '/dashboard', null, '/receiving', '/invoices/new'],
    office: ['/orders/new?fresh=1', '/dashboard', null, '/receiving', '/invoices/new'],
    kitchen: ['/orders/new?fresh=1', '/dashboard', null, '/receiving', '/invoices/new'],
    accountant: ['/dashboard', '/invoices', '/pay'],
  };

  for (const [role, expectedLabels] of Object.entries(roleLabels)) {
    const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    captureConsole(page, `mobile-action-bar:${role}`);
    try {
      await login(page, role);
      const group = page.getByRole('group', { name: 'פעולות מהירות' });
      await group.waitFor();
      const bar = page.locator('.mobile-action-bar');
      assert.equal(await bar.count(), 1, `${role}: mobile action bar is not unique`);
      assert(await bar.evaluate((node) => node === document.querySelector('[role="group"][aria-label="פעולות מהירות"]')),
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
          assert.equal(await page.locator('.mobile-action-bar').count(), 0, `${route}: mobile action bar must be hidden`);
          await assertMobileSpeedDialHidden(page, route);
        }

        await page.goto(`${baseURL}/receiving/f0000000-0000-4000-8000-000000000011`);
        await settle(page);
        assert.equal(await page.locator('.mobile-action-bar').count(), 0, 'receiving detail mobile action bar must be hidden');
        await assertMobileSpeedDialHidden(page, 'receiving detail');
        assert.equal(await page.locator('.phone-taskbar').count(), 1, 'receiving detail lost its contextual phone taskbar');
      }
    } finally {
      await closeContext(context);
    }
  }

  for (const role of ['payer']) {
    const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    try {
      await login(page, role);
      assert.equal(await page.getByRole('group', { name: 'פעולות מהירות' }).count(), 0, `${role}: mobile action group must be absent`);
      assert.equal(await page.locator('.mobile-action-bar').count(), 0, `${role}: mobile action bar must be absent`);
      await assertMobileSpeedDialHidden(page, `${role}/390`);
    } finally {
      await closeContext(context);
    }
  }

  const supplierContext = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  await supplierContext.route('**/rest/v1/profiles?**', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const asSupplier = (profile) => ({
      ...profile,
      role: 'supplier',
      supplier_id: 'aa000000-0000-4000-8000-000000000001',
    });
    await route.fulfill({ response, json: Array.isArray(body) ? body.map(asSupplier) : asSupplier(body) });
  });
  // This contract only verifies role-aware shell actions. Keep the supplier dashboard's
  // production-aligned submission projection out of the older isolated migration fixture.
  await supplierContext.route('**/rest/v1/supplier_price_submissions?**', (route) =>
    route.fulfill({ status: 200, headers: jsonHeaders, json: [] }));
  const supplierPage = await supplierContext.newPage();
  captureConsole(supplierPage, 'mobile-action-bar:supplier');
  try {
    const account = credentials('owner');
    await supplierPage.goto(`${baseURL}/login`);
    await supplierPage.locator('#email').fill(account.email);
    await supplierPage.locator('#password').fill(account.password);
    await supplierPage.getByRole('button', { name: 'התחברות' }).click();
    await supplierPage.waitForFunction(() => location.pathname === '/dashboard', null, { timeout: 25_000 });
    await settle(supplierPage);
    assert.equal(await supplierPage.getByRole('group', { name: 'פעולות מהירות' }).count(), 0, 'supplier: mobile action group must be absent');
    assert.equal(await supplierPage.locator('.mobile-action-bar').count(), 0, 'supplier: mobile action bar must be absent');
    await assertMobileSpeedDialHidden(supplierPage, 'supplier/390');
  } finally {
    await closeContext(supplierContext);
  }

  const desktop = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 1024, height: 768 } });
  const desktopPage = await desktop.newPage();
  captureConsole(desktopPage, 'desktop-speed-dial');
  try {
    await login(desktopPage, 'owner');
    for (const [width, height] of [[1024, 768], [1440, 900]]) {
      await desktopPage.setViewportSize({ width, height });
      await desktopPage.waitForTimeout(100);
      assert.equal(await desktopPage.locator('.mobile-action-bar:visible').count(), 0, `mobile action bar visible at ${width}px`);
      const trigger = desktopPage.locator('.speed-dial-trigger');
      assert.equal(await trigger.count(), 1, `desktop speed-dial missing at ${width}px`);
      assert(await trigger.isVisible(), `desktop speed-dial hidden at ${width}px`);
      const overflow = await desktopPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert(overflow <= 1, `desktop-speed-dial/${width}: horizontal overflow ${overflow}px`);
    }

    const trigger = desktopPage.locator('.speed-dial-trigger');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'desktop speed-dial starts expanded');
    await trigger.click();
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true', 'desktop speed-dial did not expose expanded state');
    assert.equal(await trigger.getAttribute('aria-label'), 'סגירת פעולות מהירות', 'desktop speed-dial does not expose its close action');
    assert.equal(await trigger.getAttribute('aria-controls'), 'global-quick-actions', 'desktop speed-dial does not identify its menu');
    const menu = desktopPage.getByRole('menu', { name: 'פעולות מהירות' });
    await menu.waitFor();
    const items = menu.getByRole('menuitem');
    assert.deepEqual((await items.allTextContents()).map((label) => label.trim()), roleLabels.owner,
      'desktop speed-dial labels or order changed');
    const targets = await items.evaluateAll((nodes) => nodes.map((node) => {
      const href = node.getAttribute('href');
      if (!href) return null;
      const url = new URL(href, window.location.origin);
      return `${url.pathname}${url.search}`;
    }));
    assert.deepEqual(targets, roleTargets.owner, 'desktop speed-dial destinations or order changed');
    assert(await items.first().evaluate((node) => document.activeElement === node), 'desktop speed-dial first action did not receive focus');
    await desktopPage.keyboard.press('ArrowDown');
    assert(await items.nth(1).evaluate((node) => document.activeElement === node), 'ArrowDown did not advance in desktop speed-dial');
    await desktopPage.keyboard.press('ArrowUp');
    assert(await items.first().evaluate((node) => document.activeElement === node), 'ArrowUp did not move back in desktop speed-dial');
    await desktopPage.keyboard.press('End');
    assert(await items.last().evaluate((node) => document.activeElement === node), 'End did not focus the last desktop speed-dial action');
    await desktopPage.keyboard.press('Home');
    assert(await items.first().evaluate((node) => document.activeElement === node), 'Home did not focus the first desktop speed-dial action');
    const sizes = await items.evaluateAll((nodes) => nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }));
    assert(sizes.every(({ width, height }) => width + 0.01 >= 44 && height + 0.01 >= 44), `desktop speed-dial target below 44px: ${JSON.stringify(sizes)}`);
    const textLayout = await items.evaluateAll((nodes) => nodes.map((node) => ({
      whiteSpace: getComputedStyle(node).whiteSpace,
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
    })));
    assert(textLayout.every(({ whiteSpace, scrollWidth, clientWidth }) => whiteSpace === 'nowrap' && scrollWidth <= clientWidth + 1),
      `desktop speed-dial label wraps or overflows: ${JSON.stringify(textLayout)}`);
    await desktopPage.screenshot({ path: path.join(outDir, 'desktop-speed-dial-open-1440.png') });
    report.screenshots.push('desktop-speed-dial-open-1440.png');
    await desktopPage.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'Escape did not collapse desktop speed-dial');
    assert.equal(await trigger.getAttribute('aria-label'), 'פתיחת פעולות מהירות', 'Escape did not restore desktop speed-dial action name');
    assert(await trigger.evaluate((node) => document.activeElement === node), 'Escape did not restore desktop speed-dial trigger focus');

    await trigger.click();
    await menu.waitFor();
    await desktopPage.setViewportSize({ width: 390, height: 844 });
    await desktopPage.waitForTimeout(100);
    assert.equal(await desktopPage.locator('#global-quick-actions').count(), 0,
      'desktop speed-dial state survived the switch to the mobile action bar');
    assert(await desktopPage.locator('.mobile-action[data-quick-action-key="order"]').evaluate((node) => document.activeElement === node),
      'focus did not move from the desktop menuitem to the matching mobile action');
    await desktopPage.setViewportSize({ width: 1440, height: 900 });
    await desktopPage.waitForTimeout(100);
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false',
      'desktop speed-dial reopened after a mobile breakpoint round-trip');
    assert(await trigger.evaluate((node) => document.activeElement === node),
      'focus did not move from the mobile action bar to the desktop trigger');

    await trigger.click();
    await desktopPage.locator('#main h1').first().click();
    await menu.waitFor({ state: 'hidden' });
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'outside press did not collapse desktop speed-dial');

    await desktopPage.goto(`${baseURL}/receiving`);
    await settle(desktopPage);
    const receivingTrigger = desktopPage.locator('.speed-dial-trigger');
    await receivingTrigger.click();
    await desktopPage.getByRole('menuitem', { name: 'מרכז הבקרה' }).click();
    await desktopPage.waitForURL((url) => url.pathname === '/dashboard');
    assert.equal(await desktopPage.getByRole('menu').count(), 0, 'desktop speed-dial stayed open after link navigation');
    assert.equal(await receivingTrigger.getAttribute('aria-expanded'), 'false', 'desktop link navigation did not reset expanded state');
  } finally {
    await closeContext(desktop);
  }

  const reduced = await browser.newContext({
    locale: 'he-IL', serviceWorkers: 'block', reducedMotion: 'reduce', viewport: { width: 1024, height: 768 },
  });
  const page = await reduced.newPage();
  captureConsole(page, 'desktop-speed-dial:reduced-motion');
  try {
    await login(page, 'owner');
    await page.getByRole('button', { name: 'פתיחת פעולות מהירות' }).click();
    const moving = page.locator('[role="menuitem"], button[aria-expanded="true"] svg');
    const motion = await moving.evaluateAll((nodes) => nodes.map((node) => {
      const style = getComputedStyle(node);
      return { animationDuration: style.animationDuration, transitionDuration: style.transitionDuration, transitionProperty: style.transitionProperty };
    }));
    const milliseconds = (value) => Math.max(...value.split(',').map((part) => {
      const duration = Number.parseFloat(part) || 0;
      return part.trim().endsWith('ms') ? duration : duration * 1000;
    }));
    assert(motion.every((entry) => milliseconds(entry.animationDuration) <= 20
      && (!/(transform|translate|rotate|scale)/.test(entry.transitionProperty) || milliseconds(entry.transitionDuration) <= 20)),
    `reduced-motion leaves desktop speed-dial movement enabled: ${JSON.stringify(motion)}`);
  } finally {
    await closeContext(reduced);
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
      noticeFab: area(notice, rect('.speed-dial-trigger')),
      noticeMenu: area(notice, rect('.speed-dial-menu')),
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
    assert.equal((await overlapAreas()).noticeFab, 0, 'PWA update notice overlaps the desktop speed-dial');
    await page.locator('.speed-dial-trigger').click();
    await page.locator('.speed-dial-menu').waitFor();
    assert.equal((await overlapAreas()).noticeMenu, 0, 'PWA update notice overlaps the open desktop speed-dial menu');
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
    assert((await dataHeadings.first().innerText()).includes('אספקות היום ומחר'), 'dashboard does not begin with the deliveries card');
    assert((await dataHeadings.nth(1).innerText()).includes('דורש טיפול'), 'attention zone is not second, after the deliveries card');
    assert.equal(await page.locator('.speed-dial-trigger').count(), 1, 'dashboard desktop speed-dial missing');
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
  captureConsole(page, 'receiving-accessibility');
  try {
    await login(page, 'kitchen');
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
    assert.equal(await page.locator('.mobile-action-bar').count(), 0, 'receiving detail mobile action bar must be hidden');
    await assertMobileSpeedDialHidden(page, 'receiving detail accessibility');
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
function readOfflineStore(page) {
  return page.evaluate(async () => {
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
    const drafts = await readAll('receipt_drafts');
    const queue = await readAll('sync_queue');
    const openOrders = await readAll('open_orders');
    db.close();
    return {
      drafts: drafts.map((draft) => ({ orderId: draft.orderId, receiptId: draft.receiptId, keySource: draft.keySource, syncedAt: draft.syncedAt })),
      queue: queue.map((action) => ({ key: action.idempotencyKey, receiptId: action.payload && action.payload.p_receipt_id, state: action.state, attempts: action.attempts })),
      openOrderKeys: openOrders.map((entry) => Object.keys(entry.order || {})),
      cachedItemKeys: openOrders.flatMap((entry) => ((entry.order && entry.order.items) || []).map((item) => Object.keys(item))),
    };
  });
}

/**
 * Offline goods receiving, end to end (PLAN-09 §3).
 *
 * `serviceWorkers: 'block'` stays on deliberately: the queue is plain JS plus IndexedDB and owes
 * nothing to a service worker. App-shell precaching is a separate deferred decision
 * (OPEN-DECISIONS #101), and this scenario is written to be true without it — the tab is closed
 * rather than reloaded offline, which is the honest version of "survives a restart".
 */
async function offlineReceiving(browser) {
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  const order = offlineReceivingOrder();
  const receiptRequests = [];
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
    await context.route('**/rest/v1/rpc/save_goods_receipt', (route) => {
      receiptRequests.push(route.request().postDataJSON());
      return route.fulfill({ status: 200, headers: jsonHeaders, json: { receipt_id: OFFLINE_RECEIPT_ID } });
    });

    const page = await context.newPage();
    captureConsole(page, 'offline-receiving', offlineNoise);
    await login(page, 'kitchen');
    await page.goto(`${baseURL}/receiving/${OFFLINE_ORDER_ID}`);
    await settle(page);
    await page.getByRole('button', { name: 'הגדלת הכמות שהתקבלה עבור עגבניות בדיקה' }).waitFor();

    // The key is minted and stored at draft creation, before anything is sent (ADR-0006:37-39).
    await page.waitForFunction(async () => {
      const db = await new Promise((resolve) => {
        const request = indexedDB.open('supplyflow-offline');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      });
      if (!db || !db.objectStoreNames.contains('receipt_drafts')) return false;
      const rows = await new Promise((resolve) => {
        const request = db.transaction('receipt_drafts', 'readonly').objectStore('receipt_drafts').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve([]);
      });
      db.close();
      return rows.length > 0;
    }, null, { timeout: 20_000 });
    const atDraft = await readOfflineStore(page);
    assert.equal(atDraft.drafts.length, 1, 'no receipt draft was persisted at draft creation');
    const persistedKey = atDraft.drafts[0].receiptId;
    assert.match(persistedKey, /^[0-9a-f-]{36}$/i, `persisted receipt key is not a uuid: ${persistedKey}`);
    // The cached order carries no money: the never-cache rule is structural here, not a promise.
    for (const keys of atDraft.cachedItemKeys) {
      assert.equal(keys.includes('unit_price'), false, 'the offline order cache stored a price');
    }
    for (const keys of atDraft.openOrderKeys) {
      assert.equal(keys.includes('total_amount'), false, 'the offline order cache stored an order total');
    }

    await context.setOffline(true);
    // spinbutton, not getByLabel: the +/- buttons' own labels contain the same phrase.
    await page.getByRole('spinbutton', { name: 'כמות שהתקבלה עבור עגבניות בדיקה' }).fill('4');
    await page.getByRole('button', { name: /סיום קבלה/ }).click();

    await page.locator('[data-testid="receiving-local-draft"]').waitFor({ timeout: 15_000 });
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
    await page.screenshot({ path: path.join(outDir, 'receiving-offline-390.png'), fullPage: true });
    report.screenshots.push('receiving-offline-390.png');

    // The tab dies with the work still queued — the case ADR-0006 actually cares about. A reload
    // while offline is NOT attempted: without app-shell precaching (#101) it would simply fail, and
    // the queue's promise is that IndexedDB survives, not that the shell does.
    await page.close();
    await context.setOffline(false);

    const resumed = await context.newPage();
    captureConsole(resumed, 'offline-receiving-resumed', offlineNoise);
    await resumed.goto(`${baseURL}/receiving/${OFFLINE_ORDER_ID}`);
    // The stored session normally survives with the context; a token refresh that died mid-offline
    // can still bounce this page to /login, and that is not what this scenario is measuring.
    if (new URL(resumed.url()).pathname === '/login') {
      await login(resumed, 'kitchen');
      await resumed.goto(`${baseURL}/receiving/${OFFLINE_ORDER_ID}`);
    }
    await settle(resumed);
    const resumedStatus = resumed.locator('[data-testid="offline-queue-status"]');
    await resumedStatus.waitFor({ timeout: 20_000 });
    assert.equal((await resumedStatus.locator('[data-testid="offline-pending-actions"]').innerText()).trim(), '1',
      'the queued receipt did not survive the closed tab');

    // The manual retry the design document mandates (:85).
    await resumedStatus.getByRole('button', { name: /ניסיון סנכרון עכשיו/ }).click();
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
 * The barcode flag boundary and a denied camera (PLAN-09 §3, second scenario).
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
    await login(page, 'kitchen');
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
    await login(page, 'kitchen');
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
  const qualitySupplierPrice = async (price) => {
    const response = await fetch(`${apiURL}/rest/v1/supplier_products?supplier_id=eq.aa000000-0000-4000-8000-000000000004&product_id=eq.bb000000-0000-4000-8000-000000000009`, {
      method: 'PATCH',
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        'content-type': 'application/json',
        prefer: 'return=representation',
      },
      body: JSON.stringify({ current_price: price }),
    });
    assert(response.ok, `quality price update failed with HTTP ${response.status}`);
    const rows = await response.json();
    assert.equal(rows.length, 1, 'quality price update did not match the seeded supplier offer');
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
    await login(page, 'kitchen');
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
    await comparison.getByRole('button', { name: 'בטל הצמדה' }).waitFor();
    const draftUrl = page.url();

    await page.reload();
    await settle(page);
    assert.equal(page.url(), draftUrl, 'draft URL changed during reload');
    const supplierStep = page.getByRole('button', { name: /02.*ספקים וחלוקה/ });
    assert.equal(await supplierStep.getAttribute('aria-current'), 'step', 'draft did not restore supplier step');
    comparison = page.locator('section[aria-labelledby="supplier-comparison-title"]');
    await comparison.getByRole('button', { name: 'בטל הצמדה' }).waitFor();
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
    await blocked.getByRole('button', { name: 'בטל הצמדה' }).waitFor();
    assert(await page.getByRole('button', { name: /03.*סיכום ואישור/ }).isDisabled(), 'broken pin did not gate summary step');
    await captureOrderState('blocked-pin');

    const unpinSave = waitForDraftSave();
    await blocked.getByRole('button', { name: 'בטל הצמדה' }).click();
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
    await comparison.getByRole('button', { name: 'בטל הצמדה' }).click();
    assert((await restoreAutomaticSave).ok(), 'returning the moved line to automatic assignment was not saved');
    await waitForSaved();
    await splitSection.getByText('מאפה זהב', { exact: true }).waitFor();
    await fixOpener.waitFor();
    assert.equal(await goldPick.getAttribute('aria-pressed'), 'true',
      'automatic assignment did not return the line to the cheapest supplier');

    await fixOpener.focus();
    await page.keyboard.press('Enter');
    await fixes.waitFor();
    const increaseSave = waitForDraftSave();
    await increase.focus();
    await page.keyboard.press('Enter');
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
    assert((await page.locator(`[aria-label="כמות ${product}"]`).innerText()).includes('3'), 'reminder did not restore quantity 3 to the cart');

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
    await sendQueue.getByRole('button', { name: 'שליחה ב-WhatsApp' }).waitFor();
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
  const request = {
    id: 'p4-request', org_id: 'p4-org', supplier_id: 'p4-supplier', number: 7001, amount: 850,
    due_date: '2026-07-30', status: 'draft', notes: 'בדיקת שכבות', created_at: '2026-07-22T08:00:00Z',
    supplier: { name: 'ספק בדיקת שכבות' },
  };
  await context.route('**/rest/v1/payment_requests?**', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: [request] }));
  await context.route('**/rest/v1/payment_request_invoices?**', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: [] }));
  await context.route('**/rest/v1/suppliers?**', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: [{ id: 'p4-supplier', name: 'ספק בדיקת שכבות', deleted_at: null }] }));
  await context.route('**/rest/v1/invoices?**', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: [{ id: 'p4-invoice', supplier_id: 'p4-supplier', invoice_number: 'INV-P4-01', invoice_date: '2026-07-01', total_amount: 850, review_status: 'approved' }] }));
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
      similar_bank_transfer_exists: false,
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
    await create.locator('#payment-request-supplier').selectOption('p4-supplier');
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
  const transaction = {
    id: 'p4-bank-row', org_id: 'p4-bank-org', import_id: 'p4-bank-import', tx_date: '2026-07-20',
    amount: 850, description: 'העברה לספק בדיקת נגישות', reference: 'P4-REF',
    row_hash: 'p4-bank-row-hash', supplier_id: 'p4-bank-supplier', status: 'unmatched',
    created_at: '2026-07-20T08:00:00Z', supplier: { name: 'ספק בדיקת נגישות' },
  };
  await context.route('**/rest/v1/bank_transactions?**', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: [transaction] }));
  await context.route('**/rest/v1/bank_imports?**', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: [] }));
  await context.route('**/rest/v1/suppliers?**', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: [{ id: 'p4-bank-supplier', name: 'ספק בדיקת נגישות' }] }));
  await context.route('**/rest/v1/payments?**', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: [] }));
  await context.route('**/rest/v1/bank_allocations?**', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: [] }));
  await context.route('**/rest/v1/invoices?**', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: [{
    id: 'p4-bank-invoice', supplier_id: 'p4-bank-supplier', invoice_number: 'BANK-P4-01',
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
    const userRow = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'השבתה' }) }).first();
    await userRow.getByRole('button', { name: 'השבתה' }).click();
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
    assert.equal(headings.length, 8, `monthly print report has ${headings.length}/8 columns`);
    assert((await table.locator('tfoot').innerText()).trim(), 'monthly print report has no totals row');
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
  captureConsole(page, `push:${name}`, [/HTTP 500 .*push_subscriptions/]);
  try {
    await login(page, 'owner');
    await page.getByRole('button', { name: 'התנתקות' }).click();
    await page.waitForURL((url) => url.pathname === '/login', { timeout: 25_000 });
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
    await closeContext(context);
  }
}

async function adminState(browser) {
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
    await page.goto(`${baseURL}/admin`);
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

    for (const [documentId, expectedLabel] of OCR_STAGE_FIXTURES) {
      const badge = gallery.locator(
        `[data-testid="document-processing-status"][data-document-id="${documentId}"]:visible`,
      );
      await badge.waitFor({ state: 'visible', timeout: 25_000 });
      assert.equal((await badge.innerText()).trim(), expectedLabel, `${documentId}: unexpected OCR stage`);
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
    await review.locator('[data-testid="document-annotations-keyboard"]').waitFor();
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
    // execute_payment_request and the payer's role cannot read this interpretation. So the check
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

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: browserPath });
  try {
    await run('role and viewport matrix', () => roleAndViewportMatrix(browser));
    await run('supplier portal uses the RLS-safe projection', () => supplierPortalProjection(browser));
    await run('mobile action bar and desktop speed-dial contract', () => quickActionsContract(browser));
    await run('overlay stacking and breakpoint reset', () => overlayStacking(browser));
    await run('dashboard, quick actions and dialogs', () => dashboardAndDialogs(browser));
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
    await run('Admin password and Clipboard state', () => adminState(browser));
    await run('OCR documents, review, status and export', () => documentOcrAcceptance(browser));
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
