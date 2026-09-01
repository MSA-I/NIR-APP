// One-off visual verification of the supplier portal entry (0167). Serves the built dist with
// `vite preview`, intercepts the Edge endpoint with a fixture, and screenshots both locales in
// the three states the supplier meets: the open form (mobile + desktop), submitted, and dead link.
// Headed on purpose — headless misses injected CSS on this machine (memory: headless-screenshot-
// stale-css). Not wired into any gate; run manually: node scripts/portal-visual-check.cjs
const { chromium } = require('playwright-core');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { mkdirSync } = require('node:fs');

const ROOT = join(__dirname, '..');
const OUT = process.env.PORTAL_SHOT_DIR || join(ROOT, '.portal-shots');
const PORT = 5199 + 700; // isolated preview port, away from dev and gate ports
const TOKEN = 'ab'.repeat(32);

const view = {
  state: 'open',
  expires_at: new Date(Date.now() + 12 * 864e5).toISOString(),
  proposal: null,
  snapshot: {
    order_id: 'o-1', order_number: 238, revision_number: 1,
    expected_date: '2026-08-27', notes: 'נא לתאם עם המחסן לפני הגעה',
    supplier_name: 'ירקות השדה בע"מ', org_name: 'מסעדת הגן הקסום',
    issued_at: new Date().toISOString(),
    items: [
      { order_item_id: 'i-1', position: 1, product_name: 'עגבניות שרי 500 גרם', unit: 'unit', qty: 12, unit_price: 8.9 },
      { order_item_id: 'i-2', position: 2, product_name: 'מלפפון בייבי', unit: 'kg', qty: 6, unit_price: 7.5 },
      { order_item_id: 'i-3', position: 3, product_name: 'חסה ערבית (ארגז)', unit: 'unit', qty: 2, unit_price: 34 },
    ],
  },
};

const locales = {
  he: {
    browser: 'he-IL', dir: 'rtl', heading: /הזמנת רכש #238/,
    quantity: 'כמות מוצעת', submitted: 'כבר נשלחה תשובה להזמנה זו', invalid: 'הקישור אינו פעיל',
  },
  en: {
    browser: 'en-US', dir: 'ltr', heading: /Purchase order #238/,
    quantity: 'Proposed quantity', submitted: 'A response has already been sent for this order',
    invalid: 'This link is not active',
  },
};

function captureBrowserFailures(page, label, { allowPortal404 = false } = {}) {
  const failures = [];
  let portal404Responses = 0;
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
  page.on('response', (response) => {
    if (response.status() === 404 && response.url().includes('/functions/v1/supplier-portal')) {
      portal404Responses += 1;
    }
  });
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console: ${message.text()}`);
  });
  return () => {
    let remainingPortal404s = allowPortal404 ? portal404Responses : 0;
    const unexpected = failures.filter((failure) => {
      if (remainingPortal404s > 0
          && failure === 'console: Failed to load resource: the server responded with a status of 404 (Not Found)') {
        remainingPortal404s -= 1;
        return false;
      }
      return true;
    });
    if (unexpected.length) throw new Error(`${label}: ${unexpected.join(' | ')}`);
  };
}

async function assertLocaleAndLayout(page, locale, label) {
  const actual = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  if (actual.lang !== locale || actual.dir !== locales[locale].dir) {
    throw new Error(`${label}: expected ${locale}/${locales[locale].dir}, got ${actual.lang}/${actual.dir}`);
  }
  if (actual.overflow > 0) throw new Error(`${label}: horizontal overflow ${actual.overflow}px`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const viteBin = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const preview = spawn(process.execPath, [viteBin, 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT, shell: false, stdio: 'pipe',
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('preview did not start')), 30000);
    let stderr = '';
    preview.stderr.on('data', (d) => { stderr += String(d); });
    preview.stdout.on('data', (d) => { if (String(d).includes('Local')) { clearTimeout(timer); resolve(); } });
    preview.on('exit', () => {
      clearTimeout(timer);
      reject(new Error(`preview exited${stderr ? `: ${stderr.trim()}` : ''}`));
    });
  });

  const browser = await chromium.launch({ headless: false });
  try {
    for (const [locale, copy] of Object.entries(locales)) {
      for (const [size, width, height] of [['mobile', 390, 844], ['desktop', 1440, 900]]) {
        const label = `${locale}-${size}`;
        const context = await browser.newContext({
          viewport: { width, height }, reducedMotion: 'reduce', locale: copy.browser,
        });
        const page = await context.newPage();
        const assertNoBrowserFailures = captureBrowserFailures(page, label);
        await page.route('**/functions/v1/supplier-portal', (route) => route.fulfill({ json: view }));
        await page.goto(`http://localhost:${PORT}/portal.html?lang=${locale}#token=${TOKEN}`);
        await page.getByRole('heading', { name: copy.heading }).waitFor();
        await page.getByLabel(copy.quantity).first().waitFor();
        await assertLocaleAndLayout(page, locale, label);

        // The language switch is the first interactive control and remains keyboard-reachable.
        await page.keyboard.press('Tab');
        const focused = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
        if (!focused) throw new Error(`${label}: language switch was not keyboard-reachable`);

        await page.screenshot({ path: join(OUT, `portal-open-${label}.png`), fullPage: true });
        assertNoBrowserFailures();
        await context.close();
      }
    }

    // Submitted + dead-link states in both locales, mobile.
    for (const [locale, copy] of Object.entries(locales)) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', locale: copy.browser,
      });
      const page = await context.newPage();
      const assertSubmittedHasNoBrowserFailures = captureBrowserFailures(page, `${locale}-submitted`);
      await page.route('**/functions/v1/supplier-portal', (route) => route.fulfill({
        json: { ...view, state: 'submitted', proposal: {
          status: 'submitted', submitted_at: new Date().toISOString(),
          proposed_delivery_date: '2026-08-29', total_delta: -42.5,
        } },
      }));
      await page.goto(`http://localhost:${PORT}/portal.html?lang=${locale}#token=${TOKEN}`);
      await page.getByText(copy.submitted).waitFor();
      await assertLocaleAndLayout(page, locale, `${locale}-submitted`);
      await page.screenshot({ path: join(OUT, `portal-submitted-${locale}-mobile.png`), fullPage: true });
      assertSubmittedHasNoBrowserFailures();

      const page2 = await context.newPage();
      const assertInvalidHasNoBrowserFailures = captureBrowserFailures(
        page2, `${locale}-invalid`, { allowPortal404: true },
      );
      await page2.route('**/functions/v1/supplier-portal', (route) => route.fulfill({
        status: 404, json: { error: 'link_invalid' },
      }));
      await page2.goto(`http://localhost:${PORT}/portal.html?lang=${locale}#token=${TOKEN}`);
      await page2.getByText(copy.invalid).waitFor();
      await assertLocaleAndLayout(page2, locale, `${locale}-invalid`);
      await page2.screenshot({ path: join(OUT, `portal-invalid-${locale}-mobile.png`), fullPage: true });
      assertInvalidHasNoBrowserFailures();
      await context.close();
    }
    console.log('portal visual check: OK, shots in', OUT);
  } finally {
    await browser.close();
    preview.kill('SIGTERM');
    setTimeout(() => { try { process.kill(preview.pid); } catch { /* gone */ } }, 1500);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
