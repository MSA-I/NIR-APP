// Visual verification of the reversible-action toast (30.08.2026, decision #290).
//
// The claim under test is not "a toast appears" — the unit tests already pin that. It is the part
// only a picture can settle: that an interactive control sitting on a solid dark pill is legible,
// that it does not push the pill off a 390px viewport, and that the pill still clears the mobile
// action bar it has always had to clear.
//
// HEADED ON PURPOSE — headless misses injected CSS on this machine (memory:
// headless-screenshot-stale-css). Serving and fixture patterns copied from
// `scripts/subscription-visual-check.cjs`, which is the shape this repo already trusts.
//
// WHY FIXTURES AND NOT THE DEMO STACK: other agents share this machine's local Supabase, and a
// screenshot run must not write to it. Toggling a product is a real write.
//
// Not wired into any gate; run manually:
//   node scripts/toast-undo-visual-check.cjs
const { chromium } = require('playwright-core');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { mkdirSync } = require('node:fs');

const ROOT = join(__dirname, '..');
const OUT = process.env.TOAST_SHOT_DIR || join(ROOT, '.toast-shots');
const PORT = 5199 + 703; // away from dev, the gate, the portal and the plan checks
const API = 'http://127.0.0.1:55431'; // matches VITE_SUPABASE_URL in .env.local

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = () => [
  b64({ alg: 'HS256', typ: 'JWT' }),
  b64({
    sub: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'shots@example.test',
    exp: Math.floor(Date.now() / 1000) + 3600,
  }),
  'signature-not-verified-in-browser',
].join('.');

const USER = {
  id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'shots@example.test',
  app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString(),
};
const SESSION = () => ({
  access_token: token(), token_type: 'bearer', expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'refresh-not-used', user: USER,
});
const PROFILE = {
  id: USER_ID, org_id: ORG_ID, full_name: 'בעלים לבדיקה', role: 'owner',
  phone: null, active: true, supplier_id: null,
};
const ORGANIZATION = {
  id: ORG_ID, name: 'מסעדת הגן הקסום', vat_rate: 18, status: 'active',
  logo_path: null, logo_updated_at: null, settings: {},
};

const PRODUCTS = [
  ['עגבניות שרי', 'ירקות'], ['חזה עוף טרי', 'בשר ועוף'], ['שמן זית כתית', 'יבשים'],
].map(([name, category], i) => ({
  id: `prod-${i + 1}`, org_id: ORG_ID, name, display_name: null, sku: `SKU-${100 + i}`,
  barcode: null, unit: 'ק״ג', category_id: `cat-${i + 1}`, active: true,
  min_stock: null, track_inventory: false, notes: null, created_at: new Date().toISOString(),
  category: { id: `cat-${i + 1}`, name: category },
}));

async function installFixtures(context) {
  await context.route(`${API}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body, status = 200) => route.fulfill({
      status, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body),
    });
    /* `.maybeSingle()` asks PostgREST for ONE object by Accept header, and supabase-js fails the
       whole account bootstrap if it gets an array back. Honour the header rather than guessing per
       table — that is what cost the first run of this script. */
    const wantsObject = (route.request().headers().accept || '').includes('pgrst.object');
    const row = (value) => json(wantsObject ? (value ?? null) : (value ? [value] : []));
    if (route.request().method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*', 'access-control-allow-headers': '*',
          'access-control-allow-methods': '*',
        },
      });
    }
    if (path.startsWith('/auth/v1/token')) return json(SESSION());
    if (path.startsWith('/auth/v1/user')) return json(USER);
    if (path.startsWith('/auth/v1/logout')) return json({});
    // The write under test. It answers exactly as the real command does, so the screen takes the
    // success path and raises the toast — without touching anybody's database.
    if (path.endsWith('/rpc/set_product_active')) return json({ idempotent: false });
    // The account bootstrap refuses to finish unless this returns exactly one row.
    if (path.endsWith('/rpc/organization_access_state')) return json([{ access_mode: 'active' }]);
    if (path.startsWith('/rest/v1/rpc/')) return json(null);
    if (path.startsWith('/rest/v1/profiles')) return row(PROFILE);
    if (path.startsWith('/rest/v1/organizations')) return row(ORGANIZATION);
    if (path.startsWith('/rest/v1/products')) return json(PRODUCTS);
    if (path.startsWith('/rest/v1/platform_admins')) return row(null);
    if (path.startsWith('/rest/v1/')) return json([]);
    return json({});
  });
}

async function signIn(page, baseURL) {
  await page.goto(`${baseURL}/login`);
  await page.locator('#email').fill('shots@example.test');
  await page.locator('#password').fill('not-a-real-password');
  await page.getByRole('button', { name: /התחברות|כניסה/ }).first().click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20000 });
}

/** The rule the repo already holds: the body never scrolls sideways. Name the offender, not just the delta. */
async function overflowReport(page) {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    const delta = document.documentElement.scrollWidth - limit;
    if (delta <= 0) return null;
    const guilty = [...document.querySelectorAll('body *')]
      .map((el) => ({ el, rect: el.getBoundingClientRect() }))
      .filter(({ rect }) => rect.right > limit + 1 || rect.left < -1)
      .slice(0, 4)
      .map(({ el, rect }) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}`
        + ` [${Math.round(rect.left)}..${Math.round(rect.right)}]`);
    return `horizontal overflow ${delta}px (client ${limit}) — ${guilty.join(' | ') || 'none named'}`;
  });
}

/** Open the row menu and press השבתה, which is the action that raises the undo toast. */
async function raiseToast(page) {
  await page.getByRole('button', { name: /פעולות/ }).first().click();
  await page.getByRole('menuitem', { name: 'השבתה' }).click();
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
  const baseURL = `http://localhost:${PORT}`;

  const browser = await chromium.launch({
    headless: false,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  });
  const shots = [];
  const findings = [];
  try {
    for (const [label, width, height] of [['390', 390, 844], ['1280', 1280, 900]]) {
      const context = await browser.newContext({
        viewport: { width, height }, locale: 'he-IL', serviceWorkers: 'block',
      });
      await installFixtures(context);
      const page = await context.newPage();
      await signIn(page, baseURL);
      await page.goto(`${baseURL}/products`);
      /* Wait on the row-actions trigger, not on the product name: `DataTable` paints a card list
         under `sm` and a table above it, so the name node that is visible at 390 is the hidden one
         at 1280. The trigger is the control this check is about to press either way. */
      await page.getByRole('button', { name: /פעולות/ }).first().waitFor({ timeout: 20000 });

      await raiseToast(page);

      const undo = page.getByRole('button', { name: 'ביטול הפעולה' });
      await undo.waitFor({ timeout: 10000 });

      // The three things a picture alone cannot assert, measured while it is on screen.
      const probe = await page.evaluate(() => {
        const button = [...document.querySelectorAll('button')]
          .find((b) => b.textContent.trim() === 'ביטול הפעולה');
        if (!button) return { error: 'undo button not found' };
        const pill = button.parentElement;
        const live = pill.querySelector('[role="status"], [role="alert"]');
        const rect = button.getBoundingClientRect();
        const pillRect = pill.getBoundingClientRect();
        return {
          buttonInsideLiveRegion: !!(live && live.contains(button)),
          liveRegionText: live ? live.textContent.trim() : null,
          touchHeight: Math.round(rect.height),
          pillWithinViewport: pillRect.left >= -1
            && pillRect.right <= document.documentElement.clientWidth + 1,
          pillBottom: Math.round(window.innerHeight - pillRect.bottom),
        };
      });

      const file = join(OUT, `toast-undo-${label}.png`);
      await page.screenshot({ path: file });
      shots.push(file);

      const overflow = await overflowReport(page);
      if (overflow) findings.push(`${label}: ${overflow}`);
      if (probe.error) findings.push(`${label}: ${probe.error}`);
      // DESIGN.md: the message is the live region, the button is its SIBLING — a button announced
      // as part of the sentence is the defect this structure exists to avoid.
      if (probe.buttonInsideLiveRegion) findings.push(`${label}: undo button sits INSIDE the live region`);
      if (!probe.pillWithinViewport) findings.push(`${label}: toast pill escapes the viewport`);
      if (probe.touchHeight < 44) findings.push(`${label}: undo touch height ${probe.touchHeight}px < 44px`);
      console.log(`${label}:`, JSON.stringify(probe));

      await context.close();
    }

    if (findings.length) {
      console.error('\nFINDINGS:\n' + findings.map((f) => ` - ${f}`).join('\n'));
      process.exitCode = 1;
    } else {
      console.log(`\ntoast undo visual check: OK, ${shots.length} shots in ${OUT}`);
    }
  } finally {
    await browser.close();
    preview.kill('SIGTERM');
    setTimeout(() => { try { process.kill(preview.pid); } catch { /* gone */ } }, 1500);
  }
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(e); process.exit(1); });
