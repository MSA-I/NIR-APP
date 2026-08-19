// One-off visual verification of the supplier portal entry (0167). Serves the built dist with
// `vite preview`, intercepts the Edge endpoint with a fixture, and screenshots the three states
// the supplier meets: the open form (mobile + desktop), the submitted state, and the dead link.
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

async function main() {
  mkdirSync(OUT, { recursive: true });
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT, shell: true, stdio: 'pipe',
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('preview did not start')), 30000);
    preview.stdout.on('data', (d) => { if (String(d).includes('Local')) { clearTimeout(timer); resolve(); } });
    preview.on('exit', () => reject(new Error('preview exited')));
  });

  const browser = await chromium.launch({ headless: false });
  try {
    for (const [label, width, height] of [['mobile', 390, 844], ['desktop', 1440, 900]]) {
      const context = await browser.newContext({
        viewport: { width, height }, reducedMotion: 'reduce', locale: 'he-IL',
      });
      const page = await context.newPage();
      await page.route('**/functions/v1/supplier-portal', (route) => route.fulfill({ json: view }));
      await page.goto(`http://localhost:${PORT}/portal.html#token=${TOKEN}`);
      await page.getByText('#238').waitFor();
      await page.screenshot({ path: join(OUT, `portal-open-${label}.png`), fullPage: true });

      // horizontal overflow check
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 0) throw new Error(`horizontal overflow ${overflow}px at ${label}`);
      await context.close();
    }

    // Submitted + dead-link states, mobile only.
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.route('**/functions/v1/supplier-portal', (route) => route.fulfill({
      json: { ...view, state: 'submitted', proposal: {
        status: 'submitted', submitted_at: new Date().toISOString(),
        proposed_delivery_date: '2026-08-29', total_delta: -42.5,
      } },
    }));
    await page.goto(`http://localhost:${PORT}/portal.html#token=${TOKEN}`);
    await page.getByText('כבר נשלחה תשובה להזמנה זו').waitFor();
    await page.screenshot({ path: join(OUT, 'portal-submitted-mobile.png'), fullPage: true });

    const page2 = await context.newPage();
    await page2.route('**/functions/v1/supplier-portal', (route) => route.fulfill({
      status: 404, json: { error: 'link_invalid' },
    }));
    await page2.goto(`http://localhost:${PORT}/portal.html#token=${TOKEN}`);
    await page2.getByText('הקישור אינו פעיל').waitFor();
    await page2.screenshot({ path: join(OUT, 'portal-invalid-mobile.png'), fullPage: true });
    await context.close();
    console.log('portal visual check: OK, shots in', OUT);
  } finally {
    await browser.close();
    preview.kill('SIGTERM');
    setTimeout(() => { try { process.kill(preview.pid); } catch { /* gone */ } }, 1500);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
