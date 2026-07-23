const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const XLSX = require('xlsx');

for (const name of ['QUALITY_BASE_URL', 'QUALITY_ARTIFACT_DIR', 'QUALITY_PASSWORD_SEED', 'QUALITY_BROWSER_PATH', 'PLAYWRIGHT_CORE_PATH']) {
  if (!process.env[name]) throw new Error(`Missing required browser-gate environment: ${name}`);
}

const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH);
const baseURL = process.env.QUALITY_BASE_URL;
const outDir = process.env.QUALITY_ARTIFACT_DIR;
const browserPath = process.env.QUALITY_BROWSER_PATH;
const passwordSeed = process.env.QUALITY_PASSWORD_SEED;
const jsonHeaders = { 'access-control-allow-origin': '*', 'content-type': 'application/json', 'content-range': '0-0/1' };

fs.mkdirSync(outDir, { recursive: true });

const report = {
  generatedAt: new Date().toISOString(),
  passed: [],
  failures: [],
  viewports: [],
  accessibility: [],
  screenshots: [],
  pdf: null,
  excel: null,
  consoleErrors: [],
  tasks: [],
  blocked: [],
};

const homes = {
  owner: '/dashboard',
  office: '/dashboard',
  kitchen: '/receiving',
  payer: '/pay',
  accountant: '/pay',
  supplier: '/my-prices',
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
  await page.waitForURL((url) => url.pathname === homes[role], { timeout: 25_000 });
  await page.locator('#main').waitFor({ state: 'visible', timeout: 25_000 });
}

async function settle(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.locator('#main').waitFor({ state: 'visible', timeout: 25_000 });
  await page.locator('#main h1').first().waitFor({ state: 'visible', timeout: 25_000 });
  await page.waitForTimeout(250);
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

async function assertMinTouchSize(locator, scope) {
  const sizes = await locator.evaluateAll((nodes) => nodes
    .filter((node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    })
    .map((node) => {
      const rect = node.getBoundingClientRect();
      return { name: node.getAttribute('aria-label') || node.textContent?.trim() || node.tagName, width: rect.width, height: rect.height };
    }));
  assert(sizes.length > 0, `${scope}: no visible touch targets found`);
  assert(sizes.every(({ width, height }) => width >= 44 && height >= 44), `${scope}: target below 44px ${JSON.stringify(sizes)}`);
}

async function assertVisibleFocus(locator, scope) {
  const style = await locator.evaluate((node) => {
    const computed = getComputedStyle(node);
    return { outlineStyle: computed.outlineStyle, outlineWidth: computed.outlineWidth, boxShadow: computed.boxShadow };
  });
  assert((style.outlineStyle !== 'none' && style.outlineWidth !== '0px') || style.boxShadow !== 'none',
    `${scope}: focused control has no visible focus indicator ${JSON.stringify(style)}`);
}

async function assertFabDoesNotCoverMain(page, scope) {
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
  await page.waitForTimeout(50);
  const overlaps = await page.evaluate(() => {
    const fab = document.querySelector('.speed-dial-trigger')?.getBoundingClientRect();
    if (!fab) return ['missing FAB'];
    return [...document.querySelectorAll('#main a[href], #main button, #main input, #main select, #main textarea')]
      .filter((node) => {
        if (!node.checkVisibility()) return false;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
          && rect.left < fab.right && rect.right > fab.left && rect.top < fab.bottom && rect.bottom > fab.top;
      })
      .map((node) => node.getAttribute('aria-label') || node.textContent?.replace(/\s+/g, ' ').trim() || node.tagName);
  });
  assert.deepEqual(overlaps, [], `${scope}: FAB covers main action or information target ${JSON.stringify(overlaps)}`);
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

async function assertNoRawMetadata(page, scope) {
  const text = await page.locator('#main').innerText();
  assert(!/\b(?:evidence|description)\s*:/i.test(text), `${scope}: raw metadata label is visible`);
  assert(!/\b[a-z][a-z0-9]*_[a-z0-9_]+\s*:/i.test(text), `${scope}: raw data key is visible`);
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
      const quickActionsTrigger = page.getByRole('button', { name: 'פתיחת פעולות מהירות' });
      assert.equal(await quickActionsTrigger.count(), ['owner', 'office', 'kitchen'].includes(role) ? 1 : 0,
        `${role}: wrong quick-actions trigger visibility`);
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
    ['kitchen', '/dashboard', '/receiving'],
    ['payer', '/dashboard', '/pay'],
    ['accountant', '/products', '/pay'],
  ];
  for (const [role, requested, expected] of denied) {
    const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block' });
    const page = await context.newPage();
    try {
      await login(page, role);
      await page.goto(`${baseURL}${requested}`);
      await page.waitForURL((url) => url.pathname === expected, { timeout: 20_000 });
      assert.equal(new URL(page.url()).pathname, expected);
    } finally {
      await closeContext(context);
    }
  }
}

async function speedDialContract(browser) {
  const roleLabels = {
    owner: ['הזמנה חדשה', 'מרכז הבקרה', 'צילום מסמך', 'קבלת סחורה', 'חשבונית חדשה'],
    office: ['הזמנה חדשה', 'מרכז הבקרה', 'צילום מסמך', 'קבלת סחורה', 'חשבונית חדשה'],
    kitchen: ['הזמנה חדשה', 'צילום מסמך', 'קבלת סחורה', 'חשבונית חדשה'],
  };
  const roleTargets = {
    owner: ['/orders/new?fresh=1', '/dashboard', null, '/receiving', '/invoices/new'],
    office: ['/orders/new?fresh=1', '/dashboard', null, '/receiving', '/invoices/new'],
    kitchen: ['/orders/new?fresh=1', null, '/receiving', '/invoices/new'],
  };

  for (const [role, expectedLabels] of Object.entries(roleLabels)) {
    const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    captureConsole(page, `speed-dial:${role}`);
    try {
      await login(page, role);
      assert.equal(await page.getByRole('button', { name: 'פתיחת פעולות מהירות' }).count(), 1,
        `${role}: speed-dial trigger is not uniquely named`);
      const trigger = page.locator('.speed-dial-trigger');
      assert.equal(await trigger.count(), 1, `${role}: speed-dial trigger is not unique`);
      assert.equal(await trigger.getAttribute('aria-expanded'), 'false', `${role}: trigger starts expanded`);
      await trigger.click();
      assert.equal(await trigger.getAttribute('aria-expanded'), 'true', `${role}: trigger did not expose expanded state`);
      assert.equal(await trigger.getAttribute('aria-label'), 'סגירת פעולות מהירות', `${role}: open trigger does not expose its close action`);
      assert.equal(await trigger.getAttribute('aria-controls'), 'global-quick-actions', `${role}: trigger does not identify its menu`);
      const menu = page.getByRole('menu', { name: 'פעולות מהירות' });
      await menu.waitFor();
      const items = menu.getByRole('menuitem');
      assert.deepEqual((await items.allTextContents()).map((label) => label.trim()), expectedLabels,
        `${role}: wrong speed-dial labels or order`);
      const targets = await items.evaluateAll((nodes) => nodes.map((node) => {
        const href = node.getAttribute('href');
        if (!href) return null;
        const url = new URL(href, window.location.origin);
        return `${url.pathname}${url.search}`;
      }));
      assert.deepEqual(targets, roleTargets[role], `${role}: wrong speed-dial destinations or order`);
      assert(await items.first().evaluate((node) => document.activeElement === node), `${role}: first action did not receive focus`);

      if (role === 'owner') {
        await page.waitForTimeout(220);
        await page.screenshot({ path: path.join(outDir, 'speed-dial-open-390.png') });
        report.screenshots.push('speed-dial-open-390.png');
        await page.keyboard.press('ArrowDown');
        assert(await items.nth(1).evaluate((node) => document.activeElement === node), 'ArrowDown did not advance in speed-dial');
        await page.keyboard.press('ArrowUp');
        assert(await items.first().evaluate((node) => document.activeElement === node), 'ArrowUp did not move back in speed-dial');
        await page.keyboard.press('End');
        assert(await items.last().evaluate((node) => document.activeElement === node), 'End did not focus the last speed-dial action');
        await page.keyboard.press('Home');
        assert(await items.first().evaluate((node) => document.activeElement === node), 'Home did not focus the first speed-dial action');

        const triggerSize = await trigger.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        });
        assert(triggerSize.width >= 44 && triggerSize.height >= 44, `speed-dial trigger below 44px: ${JSON.stringify(triggerSize)}`);
        const sizes = await items.evaluateAll((nodes) => nodes.map((node) => {
          const rect = node.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        }));
        assert(sizes.every(({ width, height }) => width >= 44 && height >= 44), `speed-dial target below 44px: ${JSON.stringify(sizes)}`);
        const textLayout = await items.evaluateAll((nodes) => nodes.map((node) => ({
          whiteSpace: getComputedStyle(node).whiteSpace,
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
        })));
        assert(textLayout.every(({ whiteSpace, scrollWidth, clientWidth }) => whiteSpace === 'nowrap' && scrollWidth <= clientWidth + 1),
          `speed-dial label wraps or overflows: ${JSON.stringify(textLayout)}`);

        for (const [width, height] of [[320, 720], [360, 800], [390, 844], [430, 932], [768, 1024], [1024, 768], [1440, 900]]) {
          await page.setViewportSize({ width, height });
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          assert(overflow <= 1, `speed-dial/${width}: horizontal overflow ${overflow}px`);
        }
        await page.waitForTimeout(100);
        await page.screenshot({ path: path.join(outDir, 'speed-dial-open-1440.png') });
        report.screenshots.push('speed-dial-open-1440.png');

        await page.keyboard.press('Escape');
        await menu.waitFor({ state: 'hidden' });
        assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'Escape did not collapse speed-dial');
        assert.equal(await trigger.getAttribute('aria-label'), 'פתיחת פעולות מהירות', 'Escape did not restore the trigger action name');
        assert(await trigger.evaluate((node) => document.activeElement === node), 'Escape did not restore speed-dial trigger focus');

        await trigger.click();
        await page.locator('#main h1').first().click();
        await menu.waitFor({ state: 'hidden' });
        assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'outside press did not collapse speed-dial');

        for (const [width, height] of [[390, 844], [1024, 768]]) {
          await page.setViewportSize({ width, height });
          await assertFabDoesNotCoverMain(page, `dashboard FAB/${width}`);
        }

        await page.goto(`${baseURL}/receiving`);
        await settle(page);
        const receivingTrigger = page.locator('.speed-dial-trigger');
        await receivingTrigger.click();
        await page.getByRole('menuitem', { name: 'מרכז הבקרה' }).click();
        await page.waitForURL((url) => url.pathname === '/dashboard');
        assert.equal(await page.getByRole('menu').count(), 0, 'speed-dial stayed open after link navigation');
        assert.equal(await receivingTrigger.getAttribute('aria-expanded'), 'false', 'link navigation did not reset expanded state');

        const dashboardTrigger = page.locator('.speed-dial-trigger');
        await dashboardTrigger.click();
        const chooser = page.waitForEvent('filechooser');
        await page.getByRole('menuitem', { name: 'צילום מסמך' }).click();
        await chooser;
        assert.equal(await dashboardTrigger.getAttribute('aria-expanded'), 'false', 'camera action did not collapse speed-dial');

        for (const route of ['/orders/new', '/invoices/new']) {
          await page.goto(`${baseURL}${route}`);
          await settle(page);
          assert.equal(await page.locator('.speed-dial-trigger').count(), 0, `${route}: speed-dial must be hidden`);
        }
      } else {
        await page.keyboard.press('Escape');
      }
    } finally {
      await closeContext(context);
    }
  }

  const reduced = await browser.newContext({
    locale: 'he-IL', serviceWorkers: 'block', reducedMotion: 'reduce', viewport: { width: 390, height: 844 },
  });
  const page = await reduced.newPage();
  captureConsole(page, 'speed-dial:reduced-motion');
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
    `reduced-motion leaves speed-dial movement enabled: ${JSON.stringify(motion)}`);
  } finally {
    await closeContext(reduced);
  }
}

async function dashboardAndDialogs(browser) {
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const dashboardRows = new Map();
  const dashboardReads = [];
  page.on('response', (response) => {
    if (response.status() !== 200 || response.request().method() !== 'GET') return;
    const url = new URL(response.url());
    const table = url.pathname.match(/\/rest\/v1\/(exceptions|payments)$/)?.[1];
    if (!table || (table === 'exceptions' && !url.searchParams.has('status'))
      || (table === 'payments' && !url.searchParams.has('paid_date'))) return;
    dashboardReads.push(response.json().then((rows) => {
      if (Array.isArray(rows)) dashboardRows.set(table, rows);
    }));
  });
  captureConsole(page, 'dashboard-dialogs');
  try {
    await login(page, 'owner');
    await page.goto(`${baseURL}/dashboard`);
    await settle(page);
    const firstDataHeading = page.locator('#main .dash-enter h2').first();
    await firstDataHeading.waitFor();
    assert((await firstDataHeading.innerText()).includes('דורש טיפול'), 'dashboard does not begin with the attention zone');
    await page.waitForTimeout(100);
    await Promise.all(dashboardReads);
    const exceptionRows = dashboardRows.get('exceptions');
    const paymentRows = dashboardRows.get('payments');
    assert(Array.isArray(exceptionRows) && Array.isArray(paymentRows), 'dashboard did not expose its authenticated REST evidence');
    const attention = page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'דורש טיפול היום' }) });
    const exceptionLink = attention.locator('a[href="/exceptions?status=open"]');
    const exceptionCount = Number((await exceptionLink.locator('span.num').first().innerText()).replace(/[^\d.-]/g, ''));
    assert.equal(exceptionCount, exceptionRows.length, 'dashboard open-exception count differs from REST');
    const paidLink = page.locator('a[href^="/payments?month="]').filter({ hasText: 'שולם לספקים החודש' }).first();
    const paidMonth = new URL(await paidLink.getAttribute('href'), baseURL).searchParams.get('month');
    const paidExpected = paymentRows.filter((row) => row.paid_date.startsWith(paidMonth))
      .reduce((total, row) => total + Number(row.amount), 0);
    const paidRendered = Number((await paidLink.locator('.text-xl.num').innerText()).replace(/[^\d,.-]/g, '').replace(/,/g, ''));
    assert.equal(paidRendered, Math.round(paidExpected), `dashboard MTD payments differ from REST for ${paidMonth}`);
    assert.equal(await page.getByRole('button', { name: 'פתיחת פעולות מהירות' }).count(), 1, 'dashboard speed-dial missing');
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
    await assertMinTouchSize(drawer.locator('a[href], button'), 'mobile drawer');
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
    await assertVisibleFocus(menuButton, 'mobile drawer trigger');

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
    return {
      steps: 7,
      backtracks: 0,
      evidence: [
        `dashboard exceptions=${exceptionRows.length} from authenticated REST`,
        `dashboard payments MTD ${paidMonth}=${paidExpected} from authenticated REST`,
        'dashboard-1440.png',
        'dashboard-390.png',
      ],
    };
  } finally {
    await closeContext(context);
  }
}

async function tableKeyboardAndSearch(browser) {
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 1024, height: 768 } });
  const page = await context.newPage();
  captureConsole(page, 'table-keyboard-search');
  let steps = 0;
  let backtracks = 0;
  const evidence = [];
  try {
    await login(page, 'owner');
    steps += 1;
    await page.goto(`${baseURL}/invoices`);
    await settle(page);
    steps += 1;
    await page.waitForTimeout(1_000);
    const titleAtDeepLink = await page.title();
    const routeTitleUpdated = titleAtDeepLink.includes('חשבוניות');
    const routeFocusMoved = await page.waitForFunction(() => document.activeElement?.id === 'main', null, { timeout: 4_000 })
      .then(() => true).catch(() => false);

    const invoiceButton = page.locator('button[aria-label^="פתיחת חשבונית "]').first();
    await invoiceButton.waitFor({ timeout: 20_000 });
    await invoiceButton.press('Enter');
    await page.waitForURL((url) => /^\/invoices\/[^/]+$/.test(url.pathname), { timeout: 20_000 });
    steps += 1;
    await page.goBack();
    backtracks += 1;
    await settle(page);

    await page.setViewportSize({ width: 320, height: 250 });
    const trigger = page.locator('button[aria-haspopup="menu"]').first();
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    const menu = page.getByRole('menu').first();
    await menu.waitFor();
    await assertMinTouchSize(trigger, 'ActionMenu trigger');
    await assertMinTouchSize(menu.getByRole('menuitem'), 'ActionMenu items');
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
    await assertVisibleFocus(trigger, 'ActionMenu trigger');
    steps += 1;

    await page.setViewportSize({ width: 390, height: 844 });
    const searchButton = page.getByRole('button', { name: 'חיפוש', exact: true });
    await searchButton.click();
    const searchDialog = page.getByRole('dialog', { name: 'חיפוש כללי' });
    await searchDialog.waitFor();
    const searchInput = searchDialog.getByRole('combobox', { name: 'חיפוש כללי' });
    await searchInput.fill('7702');
    await assertMinTouchSize(searchInput, 'mobile global search');
    await assertVisibleFocus(searchInput, 'mobile global search');
    const option = searchDialog.getByRole('option').first();
    await option.waitFor({ timeout: 20_000 });
    await option.click();
    const resultPath = new URL(page.url()).pathname;
    assert(/^\/(invoices|orders|suppliers)\//.test(resultPath), `mobile search opened unexpected route ${resultPath}`);
    steps += 2;
    await page.goBack();
    backtracks += 1;
    await page.goForward();
    assert.equal(new URL(page.url()).pathname, resultPath, 'back/forward lost the mobile-search deep link');
    assert(routeFocusMoved, 'route navigation did not move focus to main');
    assert(routeTitleUpdated, `deep-link route title was not updated; actual title: ${titleAtDeepLink}`);

    await page.goto(`${baseURL}/alerts`);
    await settle(page);
    steps += 1;
    const duplicateAlert = page.getByRole('button').filter({ hasText: /מספרי חשבונית מופיעים יותר מפעם אחת/ });
    await duplicateAlert.waitFor({ timeout: 20_000 });
    await duplicateAlert.click();
    await page.waitForURL((url) => url.pathname === '/invoices' && url.searchParams.get('attention') === 'duplicates');
    assert.equal(await page.getByRole('combobox', { name: 'סינון חשבוניות לפי צורך בטיפול' }).inputValue(), 'duplicates');
    await page.getByText('7702', { exact: true }).first().waitFor({ timeout: 20_000 });
    await assertNoRawMetadata(page, 'duplicate invoice alert target');
    steps += 1;
    evidence.push('/alerts -> /invoices?attention=duplicates');

    await page.goto(`${baseURL}/alerts`);
    await settle(page);
    const dueAlert = page.getByRole('button').filter({ hasText: /דרישות תשלום.*(?:פירעון|מועד)/ });
    await dueAlert.waitFor({ timeout: 20_000 });
    await dueAlert.click();
    await page.waitForURL((url) => url.pathname === '/payment-requests'
      && url.searchParams.get('status') === 'active' && url.searchParams.get('due') === 'soon');
    assert.equal(await page.getByRole('combobox', { name: 'סינון דרישות תשלום לפי מועד יעד' }).inputValue(), 'soon');
    await assertNoRawMetadata(page, 'payment due alert target');
    steps += 1;
    evidence.push('/alerts -> /payment-requests?status=active&due=soon');

    const exceptionId = 'fc000000-0000-4000-8000-000000000003';
    const paymentRequestId = 'f6000000-0000-4000-8000-000000000002';
    await page.goto(`${baseURL}/exceptions?status=open&severity=high`);
    await settle(page);
    assert.equal(await page.getByRole('combobox', { name: 'סינון חריגים לפי חומרה' }).inputValue(), 'high');
    assert.equal(new URL(page.url()).searchParams.get('severity'), 'high');
    await page.locator('#main .badge-alert:visible').filter({ hasText: /^גבוהה$/ }).first().waitFor({ timeout: 20_000 });
    await assertNoRawMetadata(page, 'stable exception severity filter');
    steps += 1;
    evidence.push('/exceptions?status=open&severity=high');

    await page.goto(`${baseURL}/exceptions?id=${exceptionId}`);
    const exceptionDialog = page.getByRole('dialog');
    await exceptionDialog.waitFor({ timeout: 20_000 });
    await assertNoRawMetadata(page, 'exception deep link');
    await exceptionDialog.getByRole('button', { name: 'לדרישת התשלום' }).click();
    await page.waitForURL((url) => url.pathname === '/payment-requests' && url.searchParams.get('id') === paymentRequestId);
    await page.getByRole('dialog').waitFor({ timeout: 20_000 });
    await assertNoRawMetadata(page, 'payment request record deep link');
    steps += 2;
    evidence.push(`/exceptions?id=${exceptionId} -> /payment-requests?id=${paymentRequestId}`);

    return { steps, backtracks, evidence: [`global search -> ${resultPath}`, ...evidence] };
  } finally {
    await closeContext(context);
  }
}

async function receivingAccessibility(browser) {
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  const order = {
    id: 'p4-ui-order', org_id: 'p4-ui-org', supplier_id: 'p4-ui-supplier', number: 9001,
    status: 'confirmed', order_date: '2026-07-20', expected_date: '2026-07-23', total_amount: 120,
    notes: null, supplier: { id: 'p4-ui-supplier', name: 'ספק בדיקת נגישות' },
    items: [{
      id: 'p4-ui-item', org_id: 'p4-ui-org', order_id: 'p4-ui-order', product_id: 'p4-ui-product',
      qty: 10, received_qty: 2, unit_price: 12, product: { name: 'מוצר בדיקת נגישות', unit: 'יחידה' },
    }],
  };
  await context.route('**/rest/v1/purchase_orders?**', (route) => {
    const url = new URL(route.request().url());
    const detail = (url.searchParams.get('id') || '') === 'eq.p4-ui-order';
    return route.fulfill({ status: 200, headers: jsonHeaders, json: detail ? order : [order] });
  });
  await context.route('**/rest/v1/goods_receipts?**', (route) => route.fulfill({ status: 200, headers: jsonHeaders, json: null }));
  const receiptReasons = [];
  await context.route('**/rest/v1/rpc/save_goods_receipt', (route) => {
    receiptReasons.push(route.request().postDataJSON().p_reason);
    return route.fulfill({ status: 200, headers: jsonHeaders, json: { receipt_id: 'a0000000-0000-4000-8000-000000000001' } });
  });
  const page = await context.newPage();
  captureConsole(page, 'receiving-accessibility');
  try {
    await login(page, 'kitchen');
    await page.goto(`${baseURL}/receiving`);
    await settle(page);
    await page.getByText('ספק בדיקת נגישות').first().click();
    await settle(page);
    assert.equal(await page.locator('.speed-dial-trigger').count(), 0, 'receiving detail speed-dial must be hidden');
    assert.equal(await page.getByText('סיבת השמירה / ההשלמה').count(), 0, 'routine receiving must not ask for a reason');
    await page.getByRole('button', { name: 'הגדלת הכמות שהתקבלה עבור מוצר בדיקת נגישות' }).waitFor();
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

async function orderSupplierComparison(browser) {
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  captureConsole(page, 'order-supplier-comparison');
  try {
    await login(page, 'office');
    await page.goto(`${baseURL}/orders/new?fresh=1`);
    await settle(page);
    await page.getByRole('button', { name: 'בחירת מלפפונים' }).click();
    await page.getByRole('button', { name: 'המשך לספקים' }).click();
    const supplierSelect = page.getByRole('combobox', { name: 'ספק עבור מלפפונים' });
    await supplierSelect.selectOption('aa000000-0000-4000-8000-000000000002');

    const comparison = page.locator('section[aria-labelledby="supplier-comparison-title"]');
    await comparison.getByText('משק ירוק').waitFor();
    await comparison.getByText('חוות השדה').waitFor();
    await comparison.getByText(/בחירה בזול תחסוך/).waitFor();
    await auditAccessibility(page, 'order-supplier-comparison-1440');
    await page.screenshot({ path: path.join(outDir, 'order-supplier-comparison-1440.png'), fullPage: true });
    report.screenshots.push('order-supplier-comparison-1440.png');

    await page.setViewportSize({ width: 390, height: 844 });
    await comparison.scrollIntoViewIfNeeded();
    const width = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(width.scroll <= width.client, `order comparison overflowed at 390px: ${width.scroll} > ${width.client}`);
    await auditAccessibility(page, 'order-supplier-comparison-390');
    await page.screenshot({ path: path.join(outDir, 'order-supplier-comparison-390.png'), fullPage: true });
    report.screenshots.push('order-supplier-comparison-390.png');

    await page.getByRole('button', { name: 'סקירה ואישור' }).click();
    const review = page.getByRole('dialog', { name: 'סיכום ההזמנה' });
    await review.waitFor();
    assert.equal(await review.getByText('סיבת אישור ההזמנה').count(), 0, 'routine order approval must not ask for a reason');
    await review.getByRole('button', { name: 'אשר ושלח הזמנה' }).click();
    await page.getByRole('dialog', { name: 'שליחת הזמנות לספקים' }).waitFor({ timeout: 25_000 });
    return {
      steps: 6,
      backtracks: 0,
      evidence: ['office selected a product', 'supplier comparison rendered', 'order finalized with system-authored audit reason'],
    };
  } finally {
    await closeContext(context);
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
  await context.route('**/rest/v1/rpc/payment_request_financial_check_signals*', (route) => route.fulfill({
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
    await login(page, 'accountant');
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
    return { steps: 4, backtracks: 0, evidence: ['accountant opened an unmatched bank transaction', 'record-specific matching controls are named'] };
  } finally {
    await closeContext(context);
  }
}

async function personaContractRegression(browser, role) {
  const expectedHome = homes[role];
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  captureConsole(page, `contract-regression:${role}`);
  try {
    await login(page, role);
    assert.equal(new URL(page.url()).pathname, expectedHome, `${role}: home contract changed`);
    await page.goto(`${baseURL}/dashboard`);
    await page.waitForURL((url) => url.pathname === expectedHome, { timeout: 20_000 });
    await settle(page);
    const quickActions = await page.getByRole('button', { name: 'פתיחת פעולות מהירות' }).count();
    assert.equal(quickActions, role === 'kitchen' ? 1 : 0, `${role}: quick-action contract changed`);
    return {
      steps: 3,
      backtracks: 0,
      evidence: [`${role} home=${expectedHome}`, `${role} denied /dashboard`, `${role} quick-actions=${quickActions}`],
    };
  } finally {
    await closeContext(context);
  }
}

async function accountantFinanceJourney(browser) {
  const paymentRequestId = 'f6000000-0000-4000-8000-000000000001';
  const creditId = 'f5000000-0000-4000-8000-000000000004';
  const paymentReason = 'אימות P3 — ביצוע רגיל בידי הנהלת חשבונות';
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 1024, height: 768 } });
  const page = await context.newPage();
  let restOrigin = '';
  let restHeaders = null;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!restHeaders && url.pathname.startsWith('/rest/v1/')) {
      const headers = request.headers();
      if (headers.authorization && headers.apikey) {
        restOrigin = url.origin;
        restHeaders = { authorization: headers.authorization, apikey: headers.apikey };
      }
    }
  });
  captureConsole(page, 'accountant-finance-journey');
  try {
    await login(page, 'accountant');
    assert(restHeaders && restOrigin, 'accountant journey did not capture its authenticated REST session');
    const getRows = async (table, query) => {
      const url = new URL(`/rest/v1/${table}`, restOrigin);
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      const response = await context.request.get(url.toString(), { headers: restHeaders });
      assert.equal(response.status(), 200, `accountant REST read failed for ${table}: ${response.status()}`);
      return response.json();
    };
    const [paymentBefore] = await getRows('payment_requests', { select: 'id,status', id: `eq.${paymentRequestId}` });
    const [creditBefore] = await getRows('credit_requests', { select: 'id,status', id: `eq.${creditId}` });
    assert.equal(paymentBefore?.status, 'approved', 'fresh fixture payment request is not approved');
    assert.equal(creditBefore?.status, 'offset', 'fresh fixture credit is not ready for the permitted accountant transition');
    await page.goto(`${baseURL}/pay`);
    await settle(page);
    const approved = page.locator('#main button.card').filter({ hasText: 'משקאות אור' }).first();
    await approved.waitFor({ timeout: 20_000 });
    await approved.click();
    const execution = page.getByRole('dialog');
    await execution.waitFor();
    for (const label of ['אושר על ידי', 'מבוצע על ידי', 'רישום ביומן']) {
      await execution.getByText(label, { exact: true }).waitFor();
    }
    assert.equal(await execution.locator('#emergency-payment-password').count(), 0, 'regular accountant execution exposed emergency authentication');
    assert.equal(await execution.getByRole('button', { name: 'ההעברה בוצעה' }).count(), 1, 'accountant cannot reach regular execution action');
    await execution.locator('#payment-execution-reference').fill('P3-ACCOUNTANT-001');
    await execution.locator('#payment-execution-reason').fill(paymentReason);
    await execution.getByRole('button', { name: 'ההעברה בוצעה' }).click();
    const recorded = page.getByRole('dialog', { name: 'ההעברה נרשמה' });
    await recorded.waitFor({ timeout: 20_000 });
    await recorded.getByRole('button', { name: 'סיום' }).click();
    await recorded.waitFor({ state: 'hidden' });

    await page.goto(`${baseURL}/bank?month=2026-07&status=attention`);
    await settle(page);
    assert.equal(await page.getByRole('combobox', { name: 'סינון תנועות בנק לפי סטטוס' }).inputValue(), 'attention');
    assert.equal(await page.locator('input[aria-label="סינון תנועות בנק לפי חודש"]').inputValue(), '2026-07');
    await page.locator('button[aria-label^="פתיחת תנועת בנק "]').first().waitFor({ timeout: 20_000 });

    await page.goto(`${baseURL}/credits?status=all&id=${creditId}`);
    const credit = page.getByRole('dialog');
    await credit.waitFor({ timeout: 20_000 });
    await credit.locator('button.btn-primary').filter({ hasText: 'סגירה' }).click();
    await credit.waitFor({ state: 'hidden', timeout: 20_000 });
    await page.getByRole('heading', { name: 'זיכויים' }).waitFor();
    assert.equal(await page.getByRole('combobox', { name: 'סינון דרישות זיכוי לפי סטטוס' }).inputValue(), 'all');
    const [paymentAfter] = await getRows('payment_requests', { select: 'id,status', id: `eq.${paymentRequestId}` });
    const [creditAfter] = await getRows('credit_requests', { select: 'id,status', id: `eq.${creditId}` });
    const audits = await getRows('audit_logs', {
      select: 'action,entity_type,entity_id,reason,user_id',
      entity_id: `in.(${paymentRequestId},${creditId})`,
      order: 'created_at.desc',
    });
    assert.equal(paymentAfter?.status, 'executed', 'accountant payment write did not persist');
    assert.equal(creditAfter?.status, 'closed', 'accountant credit transition did not persist');
    const paymentAudit = audits.find((row) => row.action === 'payment_request_executed' && row.entity_id === paymentRequestId);
    const creditAudit = audits.find((row) => row.action === 'credit_request_transitioned' && row.entity_id === creditId);
    assert.equal(paymentAudit?.reason, paymentReason, 'accountant payment audit reason is missing or changed');
    assert.equal(creditAudit?.reason, 'סגירה', 'accountant credit audit reason is missing or changed');
    assert(paymentAudit?.user_id && paymentAudit.user_id === creditAudit?.user_id, 'finance writes were not attributed to the same accountant session');
    return {
      steps: 11,
      backtracks: 0,
      evidence: [
        `payment_requests/${paymentRequestId}: approved -> executed`,
        `credit_requests/${creditId}: offset -> closed`,
        'accountant-session audit: payment_request_executed',
        'accountant-session audit: credit_request_transitioned',
        '/bank?month=2026-07&status=attention',
      ],
    };
  } finally {
    await closeContext(context);
  }
}

async function supplierMobileEditJourney(browser) {
  const supplierId = 'aa000000-0000-4000-8000-000000000001';
  const marker = 'יוסי אדרי — אימות P3';
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  let update = null;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'PATCH' && url.pathname.endsWith('/rest/v1/suppliers') && url.searchParams.get('id') === `eq.${supplierId}`) {
      update = request.postDataJSON();
    }
  });
  captureConsole(page, 'supplier-mobile-edit');
  try {
    await login(page, 'office');
    await page.goto(`${baseURL}/suppliers/${supplierId}`);
    await settle(page);
    await page.getByRole('button', { name: 'עריכה', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: /עריכת ספק/ });
    await dialog.waitFor();
    await dialog.locator('#supplier-contact').fill(marker);
    await dialog.getByRole('button', { name: 'שמירה' }).click();
    await dialog.waitFor({ state: 'hidden', timeout: 20_000 });
    await page.getByText(marker, { exact: true }).waitFor({ timeout: 20_000 });
    assert.equal(update?.contact_name, marker, 'supplier edit did not send the mobile form value');
    await auditAccessibility(page, 'supplier-mobile-edit-390');
    await page.screenshot({ path: path.join(outDir, 'supplier-mobile-edit-390.png'), fullPage: true });
    report.screenshots.push('supplier-mobile-edit-390.png');
    return {
      steps: 5,
      backtracks: 0,
      evidence: [`PATCH /suppliers?id=eq.${supplierId}`, 'supplier-mobile-edit-390.png', `contact=${marker}`],
    };
  } finally {
    await closeContext(context);
  }
}

async function supplierPriceJourney(browser) {
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const page = await context.newPage();
  captureConsole(page, 'supplier-price-journey');
  try {
    await login(page, 'supplier');
    await page.locator('#main').getByText(/משק ירוק/).first().waitFor({ timeout: 20_000 });
    const mainText = await page.locator('#main').innerText();
    assert(mainText.includes('משק ירוק'), 'supplier portal omitted its own supplier');
    assert(!mainText.includes('חוות השדה'), 'supplier portal exposed a competing supplier');

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'הורדת תבנית' }).click();
    const download = await downloadPromise;
    const templateFile = path.join(outDir, 'supplier-price-template.csv');
    await download.saveAs(templateFile);
    const template = fs.readFileSync(templateFile, 'utf8');
    assert(template.startsWith('\uFEFFproduct_id,product_name,price'), 'supplier template lacks the canonical product columns');
    assert(template.includes('bb000000-0000-4000-8000-000000000001'), 'supplier template lacks canonical product ids');

    const uploadFile = path.join(outDir, 'supplier-price-preview-with-unknown.csv');
    fs.writeFileSync(uploadFile, [
      'product_id,product_name,price',
      'bb000000-0000-4000-8000-000000000001,עגבנייה,8.75',
      ',מוצר ספק לא מוכר,12.50',
    ].join('\r\n'), 'utf8');
    await page.getByRole('button', { name: 'הגשת מחירון חודשי' }).click();
    const dialog = page.getByRole('dialog', { name: 'הגשת מחירון חודשי' });
    await dialog.locator('input[type="file"]').setInputFiles(uploadFile);
    await dialog.getByText(/זוהו 2 שורות; 1 הותאמו לקטלוג/).waitFor({ timeout: 20_000 });
    assert.equal(await dialog.getByText('מוצר קנוני', { exact: true }).count(), 1);
    assert.equal(await dialog.getByText('לא מוכר', { exact: true }).count(), 1);
    await assertNoRawMetadata(page, 'supplier price exception preview');
    await page.screenshot({ path: path.join(outDir, 'supplier-price-preview-390.png'), fullPage: true });
    report.screenshots.push('supplier-price-preview-390.png');
    return {
      steps: 5,
      backtracks: 0,
      evidence: ['supplier-price-template.csv', 'UTF-8 CSV without BOM parsed', 'one canonical and one unknown row shown before submission'],
    };
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
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const reportRows = new Map();
  const responseReads = [];
  const reportTables = new Set(['invoices', 'payments', 'credit_requests', 'exceptions', 'bank_transactions']);
  page.on('response', (response) => {
    const url = new URL(response.url());
    const table = url.pathname.match(/\/rest\/v1\/([^/]+)$/)?.[1];
    if (response.status() !== 200 || response.request().method() !== 'GET' || !reportTables.has(table)) return;
    const filterKey = table === 'invoices' ? 'invoice_date'
      : table === 'payments' ? 'paid_date'
        : table === 'credit_requests' ? 'created_at'
          : table === 'bank_transactions' ? 'tx_date'
            : 'status';
    if (!url.searchParams.has(filterKey)) return;
    const read = response.json().then((rows) => {
      if (Array.isArray(rows)) reportRows.set(table, rows);
    });
    responseReads.push(read);
  });
  captureConsole(page, 'reports-pdf');
  try {
    await login(page, 'accountant');
    await page.goto(`${baseURL}/reports`);
    await settle(page);
    const month = page.locator('#monthly-report-month');
    if (await month.inputValue() !== '2026-07') {
      const refreshed = page.waitForResponse((response) => response.url().includes('/rest/v1/invoices?')
        && response.url().includes('2026-07-01'));
      await month.fill('2026-07');
      await refreshed;
      await settle(page);
    }
    await page.waitForTimeout(100);
    await Promise.all(responseReads);
    for (const tableName of reportTables) {
      assert(Array.isArray(reportRows.get(tableName)), `monthly report did not load authenticated REST rows for ${tableName}`);
    }

    const rows = Object.fromEntries(reportRows);
    const sum = (values) => values.reduce((total, value) => total + Number(value || 0), 0);
    const expected = {
      invoiceRows: rows.invoices.length,
      beforeVat: sum(rows.invoices.map((row) => row.amount_before_vat)),
      vat: sum(rows.invoices.map((row) => row.vat_amount)),
      invoices: sum(rows.invoices.map((row) => row.total_amount)),
      paymentRows: rows.payments.length,
      payments: sum(rows.payments.map((row) => row.amount)),
      creditRows: rows.credit_requests.length,
      credits: sum(rows.credit_requests.map((row) => row.amount)),
      exceptionRows: rows.exceptions.length,
      unmatchedBank: rows.bank_transactions.filter((row) => ['unmatched', 'suggested'].includes(row.status)).length,
    };
    const equalMoney = (actual, wanted, label) => assert.equal(Math.round(Number(actual) * 100), Math.round(Number(wanted) * 100), label);

    const table = page.locator('table.report-invoices');
    await table.waitFor();
    const headings = (await table.locator('thead th').allTextContents()).map((value) => value.trim());
    assert.equal(headings.length, 8, `monthly print report has ${headings.length}/8 columns`);
    assert((await table.locator('tfoot').innerText()).trim(), 'monthly print report has no totals row');

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'ייצוא Excel' }).click();
    const download = await downloadPromise;
    const excelPath = path.join(outDir, 'monthly-report.xlsx');
    await download.saveAs(excelPath);
    const workbook = XLSX.readFile(excelPath);
    assert.deepEqual(workbook.SheetNames, ['פרטי הדוח', 'חשבוניות', 'תשלומים', 'זיכויים', 'חריגים פתוחים כרגע']);
    const summaryRows = XLSX.utils.sheet_to_json(workbook.Sheets['פרטי הדוח'], { header: 1, raw: true, defval: null });
    const metrics = new Map(summaryRows.slice(6).map(([label, count, amount]) => [label, { count, amount }]));
    const invoiceSheet = XLSX.utils.sheet_to_json(workbook.Sheets['חשבוניות'], { raw: true, defval: null });
    const paymentSheet = XLSX.utils.sheet_to_json(workbook.Sheets['תשלומים'], { raw: true, defval: null });
    const creditSheet = XLSX.utils.sheet_to_json(workbook.Sheets['זיכויים'], { raw: true, defval: null });
    const exceptionSheet = XLSX.utils.sheet_to_json(workbook.Sheets['חריגים פתוחים כרגע'], { raw: true, defval: null });
    assert.equal(invoiceSheet.length, expected.invoiceRows, 'Excel invoice row count differs from REST');
    assert.equal(paymentSheet.length, expected.paymentRows, 'Excel payment row count differs from REST');
    assert.equal(creditSheet.length, expected.creditRows, 'Excel credit row count differs from REST');
    assert.equal(exceptionSheet.length, expected.exceptionRows, 'Excel exception row count differs from REST');
    assert.equal(metrics.get('חשבוניות')?.count, expected.invoiceRows, 'Excel invoice summary count differs from REST');
    assert.equal(metrics.get('תשלומים')?.count, expected.paymentRows, 'Excel payment summary count differs from REST');
    assert.equal(metrics.get('זיכויים')?.count, expected.creditRows, 'Excel credit summary count differs from REST');
    assert.equal(metrics.get('חריגים פתוחים כרגע')?.count, expected.exceptionRows, 'Excel exception summary count differs from REST');
    equalMoney(metrics.get('חשבוניות')?.amount, expected.invoices, 'Excel invoice total differs from REST');
    equalMoney(metrics.get('לפני מע״מ')?.amount, expected.beforeVat, 'Excel pre-VAT total differs from REST');
    equalMoney(metrics.get('מע״מ')?.amount, expected.vat, 'Excel VAT total differs from REST');
    equalMoney(metrics.get('תשלומים')?.amount, expected.payments, 'Excel payment total differs from REST');
    equalMoney(metrics.get('זיכויים')?.amount, expected.credits, 'Excel credit total differs from REST');
    report.excel = {
      file: 'monthly-report.xlsx',
      bytes: fs.statSync(excelPath).size,
      sheets: workbook.SheetNames,
      source: 'authenticated REST fixture',
      expected,
    };

    for (const [width, height] of [[320, 720], [390, 844], [768, 1024], [1024, 768]]) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(50);
      const layout = await page.evaluate(() => {
        const visible = (node) => {
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        return {
          documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          mobileCardGroups: [...document.querySelectorAll('.report-mobile-cards')].filter(visible).length,
          visibleTableWraps: [...document.querySelectorAll('.report-table-wrap')].filter(visible).map((node) => ({
            clientWidth: node.clientWidth, scrollWidth: node.scrollWidth,
          })),
        };
      });
      assert(layout.documentOverflow <= 1, `reports/${width}: page overflow ${layout.documentOverflow}px`);
      assert.equal(layout.mobileCardGroups, 3, `reports/${width}: mobile card groups missing`);
      assert.deepEqual(layout.visibleTableWraps, [], `reports/${width}: internal scrolling table remained visible`);
      await assertMinTouchSize(page.locator('.monthly-report a[href]'), `report metrics/${width}`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(outDir, 'reports-mobile-390.png'), fullPage: true });
    report.screenshots.push('reports-mobile-390.png');
    await page.setViewportSize({ width: 1440, height: 900 });
    await table.waitFor({ state: 'visible' });
    await page.emulateMedia({ media: 'print' });
    const printEvidence = await page.evaluate(() => {
      const number = (value) => Number((value || '').replace(/[^\d,.-]/g, '').replace(/,/g, ''));
      const card = (title) => [...document.querySelectorAll('.monthly-report .card')]
        .find((node) => node.querySelector('.section-title')?.textContent?.trim().startsWith(title));
      const invoiceTable = document.querySelector('table.report-invoices');
      const invoiceTotals = [...invoiceTable.querySelectorAll('tfoot td')].slice(0, 3).map((node) => number(node.textContent));
      const paymentTable = card('תשלומים לפי ספק')?.querySelector('table');
      const paymentRows = [...(paymentTable?.querySelectorAll('tbody tr') ?? [])];
      const creditTable = card('זיכויים')?.querySelector('table');
      const creditRows = [...(creditTable?.querySelectorAll('tbody tr') ?? [])];
      const exceptionHeading = [...document.querySelectorAll('.monthly-report h2')]
        .find((node) => node.textContent?.includes('חריגים פתוחים כרגע'));
      return {
        heading: document.querySelector('.monthly-report .print\\:block h2')?.textContent?.trim() || '',
        invoiceRows: invoiceTable.querySelectorAll('tbody tr').length,
        beforeVat: invoiceTotals[0], vat: invoiceTotals[1], invoices: invoiceTotals[2],
        paymentSupplierRows: paymentRows.length,
        payments: paymentRows.reduce((total, row) => total + number(row.querySelectorAll('td')[1]?.textContent), 0),
        creditRows: creditRows.length,
        credits: creditRows.reduce((total, row) => total + number(row.querySelectorAll('td')[2]?.textContent), 0),
        exceptionRows: exceptionHeading?.nextElementSibling?.querySelectorAll('li').length ?? 0,
      };
    });
    assert(printEvidence.heading.includes('דוח חודשי') && printEvidence.heading.includes('יולי 2026'), 'print report heading lost tenant/month context');
    assert.equal(printEvidence.invoiceRows, expected.invoiceRows, 'print invoice rows differ from REST');
    assert.equal(printEvidence.creditRows, expected.creditRows, 'print credit rows differ from REST');
    assert.equal(printEvidence.exceptionRows, expected.exceptionRows, 'print exception rows differ from REST');
    assert.equal(printEvidence.paymentSupplierRows, new Set(rows.payments.map((row) => row.supplier.name)).size,
      'print payment supplier groups differ from REST');
    equalMoney(printEvidence.beforeVat, expected.beforeVat, 'print pre-VAT total differs from REST');
    equalMoney(printEvidence.vat, expected.vat, 'print VAT total differs from REST');
    equalMoney(printEvidence.invoices, expected.invoices, 'print invoice total differs from REST');
    equalMoney(printEvidence.payments, expected.payments, 'print payment total differs from REST');
    equalMoney(printEvidence.credits, expected.credits, 'print credit total differs from REST');
    await page.screenshot({ path: path.join(outDir, 'reports-print.png'), fullPage: true });
    report.screenshots.push('reports-print.png');
    const pdfPath = path.join(outDir, 'monthly-report.pdf');
    await page.pdf({ path: pdfPath, printBackground: true, preferCSSPageSize: true });
    const bytes = fs.statSync(pdfPath).size;
    assert(bytes > 5_000, `monthly report PDF is unexpectedly small (${bytes} bytes)`);
    report.pdf = { file: 'monthly-report.pdf', bytes, headings, sourceEvidence: printEvidence, expected };
    return {
      steps: 8,
      backtracks: 0,
      evidence: ['authenticated REST fixture rows', 'monthly-report.xlsx', 'reports-print.png', 'monthly-report.pdf'],
    };
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

async function fixtureReadiness(browser) {
  const roles = Object.keys(homes);
  for (const role of roles) {
    const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    try {
      await login(page, role);
      assert.equal(new URL(page.url()).pathname, homes[role], `${role}: fixture login did not reach its home`);
      if (role === 'owner') {
        await page.goto(`${baseURL}/invoices`);
        await settle(page);
        await page.getByText('7702', { exact: true }).first().waitFor({ timeout: 20_000 });
      }
    } finally {
      await closeContext(context);
    }
  }
  return { steps: roles.length + 1, backtracks: 0, evidence: [...roles.map((role) => `${role} login ready`), 'fixture sentinel invoice 7702'] };
}

async function run(name, check, meta = {}) {
  if (process.env.QUALITY_ONLY && !meta.always && !name.includes(process.env.QUALITY_ONLY)) return 'SKIPPED';
  const startedAt = Date.now();
  const task = {
    name,
    status: 'FAIL',
    persona: meta.persona ?? 'system',
    durationMs: 0,
    steps: meta.steps ?? 1,
    backtracks: meta.backtracks ?? 0,
    evidence: meta.evidence ?? [],
  };
  try {
    const measured = await check();
    task.status = 'PASS';
    task.steps = measured?.steps ?? task.steps;
    task.backtracks = measured?.backtracks ?? task.backtracks;
    task.evidence = measured?.evidence ?? task.evidence;
    report.passed.push(name);
    console.log(`${name}: PASS`);
  } catch (error) {
    task.status = meta.failureStatus ?? 'FAIL';
    const failure = { name, status: task.status, message: error.message, stack: error.stack?.split('\n').slice(0, 4).join('\n') };
    report.failures.push(failure);
    if (task.status === 'BLOCKED') report.blocked.push({ name, message: error.message });
    console.log(`${name}: ${task.status} — ${error.message}`);
  } finally {
    task.durationMs = Date.now() - startedAt;
    report.tasks.push(task);
  }
  return task.status;
}

function blockRemaining(suite, reason) {
  for (const task of suite) {
    if (process.env.QUALITY_ONLY && !task.name.includes(process.env.QUALITY_ONLY)) continue;
    report.tasks.push({
      name: task.name, status: 'BLOCKED', persona: task.persona, durationMs: 0,
      steps: 0, backtracks: 0, evidence: [`not run: ${reason}`],
    });
    report.blocked.push({ name: task.name, message: reason });
  }
}

function writeReport() {
  if (report.consoleErrors.length) {
    const failure = { name: 'unexpected browser console errors', status: 'FAIL', message: JSON.stringify(report.consoleErrors) };
    report.failures.push(failure);
    report.tasks.push({
      name: failure.name, status: 'FAIL', persona: 'all', durationMs: 0,
      steps: report.consoleErrors.length, backtracks: 0, evidence: report.consoleErrors,
    });
  }
  fs.writeFileSync(path.join(outDir, 'p4-browser-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({
    passed: report.passed.length,
    failed: report.failures.length,
    blocked: report.blocked.length,
    viewportChecks: report.viewports.length,
    accessibilityAudits: report.accessibility.length,
    screenshots: report.screenshots,
    pdfBytes: report.pdf?.bytes ?? 0,
    excelBytes: report.excel?.bytes ?? 0,
    failures: report.failures,
  }, null, 2));
  if (report.failures.length) process.exitCode = 1;
}

(async () => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: browserPath });
  } catch (error) {
    report.tasks.push({
      name: 'browser and fixture readiness', status: 'BLOCKED', persona: 'all', durationMs: 0,
      steps: 0, backtracks: 0, evidence: [error.message],
    });
    report.blocked.push({ name: 'browser and fixture readiness', message: error.message });
    report.failures.push({ name: 'browser and fixture readiness', status: 'BLOCKED', message: error.message });
    writeReport();
    return;
  }

  const suite = [
    { name: 'role and viewport matrix', persona: 'all roles', steps: 51, evidence: ['six role homes', '42 viewport checks', 'route denials'], check: () => roleAndViewportMatrix(browser) },
    { name: 'speed-dial roles, keyboard, camera and responsive contract', persona: 'owner, office, kitchen', steps: 20, evidence: ['keyboard', '44px', '320/390/768/1024', 'reduced motion'], check: () => speedDialContract(browser) },
    { name: 'dashboard, speed-dial and dialogs', persona: 'owner', steps: 7, evidence: ['dashboard REST/DOM cross-check', 'dashboard screenshots'], check: () => dashboardAndDialogs(browser) },
    { name: 'DataTable, ActionMenu, route focus and mobile search', persona: 'owner', steps: 12, evidence: ['search and deep links', 'alerts and filters', 'severity filter'], check: () => tableKeyboardAndSearch(browser) },
    { name: 'receiving contextual names and accessibility', persona: 'kitchen', steps: 6, evidence: ['partial and completed receipt reasons'], check: () => receivingAccessibility(browser) },
    { name: 'order supplier savings and reason-free approval', persona: 'office', steps: 6, evidence: ['mutable purchasing journey'], check: () => orderSupplierComparison(browser) },
    { name: 'supplier mobile edit', persona: 'office', steps: 5, evidence: ['390px edit and PATCH verification'], check: () => supplierMobileEditJourney(browser) },
    { name: 'kitchen role regression', persona: 'kitchen', steps: 3, evidence: ['home, denied route, quick actions'], check: () => personaContractRegression(browser, 'kitchen') },
    { name: 'payer role regression', persona: 'payer', steps: 3, evidence: ['home, denied route, no quick actions'], check: () => personaContractRegression(browser, 'payer') },
    { name: 'payment-request names and modal stack', persona: 'owner', steps: 7, evidence: ['record names and nested modal focus'], check: () => paymentRequestNamesAndModalStack(browser) },
    { name: 'bank contextual names and accessibility', persona: 'accountant', steps: 4, evidence: ['bank treatment controls'], check: () => bankContextualNames(browser) },
    { name: 'partial Alerts never all-clear or mark read', persona: 'owner', steps: 4, evidence: ['partial readiness remains disclosed'], check: () => alertsPartialFailure(browser) },
    { name: 'Settings failure never reports success', persona: 'owner', steps: 5, evidence: ['failed mutation remains open'], check: () => settingsFalseSuccess(browser) },
    { name: 'temporary auth bootstrap supports retry', persona: 'owner', steps: 5, evidence: ['bootstrap retry without logout'], check: () => bootstrapRetry(browser) },
    { name: 'lazy chunk failure recovers', persona: 'owner', steps: 5, evidence: ['route chunk recovery'], check: () => lazyChunkRecovery(browser) },
    { name: 'accountant finance write journey', persona: 'accountant', steps: 11, evidence: ['payment and credit before/after with audit'], check: () => accountantFinanceJourney(browser) },
    { name: 'supplier price and exception journey', persona: 'supplier', steps: 5, evidence: ['template and unknown-row preview'], check: () => supplierPriceJourney(browser) },
    { name: 'monthly report print and PDF', persona: 'accountant', steps: 8, evidence: ['REST, XLSX, DOM print and PDF totals'], check: () => reportsAndPdf(browser) },
    { name: 'PWA update preserves open state', persona: 'anonymous', steps: 4, evidence: ['service-worker update without reload'], check: () => pwaUpdate(browser) },
    { name: 'Push logout all success', persona: 'owner', steps: 3, evidence: ['server and browser cleanup'], check: () => pushLogout(browser, 'all-success', true, true) },
    { name: 'Push logout server failure', persona: 'owner', steps: 3, evidence: ['truthful server cleanup failure'], check: () => pushLogout(browser, 'server-failure', false, true) },
    { name: 'Push logout browser failure', persona: 'owner', steps: 3, evidence: ['truthful browser cleanup failure'], check: () => pushLogout(browser, 'browser-failure', true, false) },
    { name: 'Push logout double failure', persona: 'owner', steps: 3, evidence: ['truthful double cleanup failure'], check: () => pushLogout(browser, 'double-failure', false, false) },
    { name: 'Admin password and Clipboard state', persona: 'owner', steps: 8, evidence: ['modal reset and clipboard failure'], check: () => adminState(browser) },
  ];

  try {
    const readiness = await run('browser and fixture readiness', () => fixtureReadiness(browser), {
      always: true, persona: 'all roles', failureStatus: 'BLOCKED', steps: 7,
      evidence: ['six fixture logins', 'invoice 7702 sentinel'],
    });
    if (readiness === 'PASS') {
      for (const task of suite) await run(task.name, task.check, task);
    } else {
      blockRemaining(suite, 'browser/auth/fixture readiness failed');
    }
  } finally {
    await browser.close();
  }

  writeReport();
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
