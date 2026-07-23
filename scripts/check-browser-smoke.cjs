const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

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
  consoleErrors: [],
};

const homes = {
  owner: '/dashboard',
  office: '/dashboard',
  kitchen: '/receiving',
  payer: '/pay',
  accountant: '/reports',
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

async function roleAndViewportMatrix(browser) {
  const viewports = [
    ['320', 320, 720], ['390', 390, 844], ['768', 768, 1024], ['1024', 1024, 768],
  ];
  for (const [role, expectedHome] of Object.entries(homes)) {
    const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    captureConsole(page, `matrix:${role}`);
    try {
      await login(page, role);
      assert.equal(new URL(page.url()).pathname, expectedHome, `${role}: wrong home route`);
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
    ['accountant', '/products', '/reports'],
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

async function dashboardAndDialogs(browser) {
  const context = await browser.newContext({ locale: 'he-IL', serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  captureConsole(page, 'dashboard-dialogs');
  try {
    await login(page, 'owner');
    await page.goto(`${baseURL}/dashboard`);
    await settle(page);
    const firstDataHeading = page.locator('#main .dash-enter h2').first();
    await firstDataHeading.waitFor();
    assert((await firstDataHeading.innerText()).includes('דורש טיפול'), 'dashboard does not begin with the attention zone');
    assert.equal(await page.getByText('פעולות מהירות', { exact: true }).count(), 0, 'Quick Actions returned');
    assert.equal(await page.getByRole('button', { name: 'צילום מסמך' }).count(), 1, 'dashboard FAB missing');
    const contrast = await assertKeyContrast(page);
    await page.screenshot({ path: path.join(outDir, 'dashboard-1440.png'), fullPage: true });
    report.screenshots.push('dashboard-1440.png');

    for (const route of ['/orders/new', '/invoices/new']) {
      await page.goto(`${baseURL}${route}`);
      await settle(page);
      assert.equal(await page.getByRole('button', { name: 'צילום מסמך' }).count(), 0, `${route}: FAB must be hidden`);
    }

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
  const page = await context.newPage();
  captureConsole(page, 'receiving-accessibility');
  try {
    await login(page, 'kitchen');
    await page.goto(`${baseURL}/receiving`);
    await settle(page);
    await page.getByText('ספק בדיקת נגישות').first().click();
    await settle(page);
    assert.equal(await page.getByRole('button', { name: 'צילום מסמך' }).count(), 0, 'receiving detail FAB must be hidden');
    await page.getByRole('button', { name: 'הגדלת הכמות שהתקבלה עבור מוצר בדיקת נגישות' }).waitFor();
    await page.getByRole('button', { name: 'מלא עבור מוצר בדיקת נגישות' }).waitFor();
    assert.equal(await page.locator('button[aria-pressed]').count(), 5, 'receiving status controls lost pressed state');
    await page.screenshot({ path: path.join(outDir, 'receiving-390.png'), fullPage: true });
    report.screenshots.push('receiving-390.png');
    const audit = await auditAccessibility(page, 'receiving-detail');
    assert.deepEqual(audit.controls, [], 'receiving detail contains an unlabeled control');
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

async function run(name, check) {
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
    await run('dashboard, FAB and dialogs', () => dashboardAndDialogs(browser));
    await run('DataTable, ActionMenu, route focus and mobile search', () => tableKeyboardAndSearch(browser));
    await run('receiving contextual names and accessibility', () => receivingAccessibility(browser));
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
  } finally {
    await browser.close();
  }

  if (report.consoleErrors.length) {
    report.failures.push({ name: 'unexpected browser console errors', message: JSON.stringify(report.consoleErrors) });
  }
  fs.writeFileSync(path.join(outDir, 'p4-browser-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({
    passed: report.passed.length,
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
