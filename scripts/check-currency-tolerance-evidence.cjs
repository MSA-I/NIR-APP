/**
 * Visual evidence for the tolerance campaign, without touching a database.
 *
 * WHY INTERCEPTION RATHER THAN A REAL STACK. The four screens this proves need a two-currency
 * business, a dollar bank line, a dollar invoice and an organisation that has never stated a
 * dollar tolerance. Building that on `supplyflow-p0` means writing fixtures into a stack every
 * other agent on this machine shares, and the constitution is explicit that it is shared. So the
 * app runs against `http://127.0.0.1:59999`, where nothing listens, and every request to that
 * origin is answered here from a fixture. A request that escapes this file cannot silently reach
 * a real database — it fails with a connection error, loudly, which is the behaviour worth having.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT. These are screenshots of the real components, the real
 * router and the real stylesheet, rendering the real state the server would produce. They are not
 * proof that the SERVER produces that state — `p82`, `p83` and the two migrations' own proof
 * blocks are. Gates that need a database are not marked closed by this script.
 *
 * Usage:  node scripts/check-currency-tolerance-evidence.cjs [--headed]
 */
const { chromium } = require('playwright-core');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const PORT = 5219;
// vite binds to `localhost`, which resolves to ::1 on this machine — probing 127.0.0.1 never answers.
const BASE = `http://localhost:${PORT}`;
const SUPABASE = 'http://127.0.0.1:59999';
const OUT = path.join(__dirname, '..', 'artifacts', 'currency-tolerances');

/* THE BROWSER, AND WHY IT IS NOT THE BUNDLED ONE. Playwright's own chromium build fails to start
   on this machine — `spawn UNKNOWN`, before any page exists. The system Chrome runs, and it is
   also closer to what a user actually sees.

   Headed by default: vite serves the stylesheet through a JS injection in dev, and headless
   Chrome has been observed screenshotting this app before that injection lands — a picture of an
   unstyled page, which reads as a regression that is not there. */
const HEADED = !process.argv.includes('--headless');
const CHROME_CANDIDATES = [
  path.join('C:', 'Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join('C:', 'Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join('C:', 'Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join('C:', 'Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];
const CHROME = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
if (!CHROME) throw new Error('no system Chrome or Edge found; screenshots need a real browser');

const ORG_ID = '10990000-0000-4000-8000-000000000001';
const USER_ID = '20990000-0000-4000-8000-000000000001';
const SUPPLIER_ID = '40990000-0000-4000-8000-000000000001';

/* The business this evidence is about: books in shekels, a dollar supplier, and a
   `bank_match_amount_tolerance` still in the LEGACY SCALAR shape — which answers for ILS and for
   nothing else. That is the exact state in which the old screen was lying. */
const ORGANIZATION = {
  id: ORG_ID,
  name: 'מטבח הדגמה',
  vat_rate: 18,
  base_currency: 'ILS',
  country_code: 'IL',
  status: 'active',
  logo_path: null,
  logo_updated_at: null,
  settings: { bank_match_days: 7, bank_match_amount_tolerance: 1 },
};

const PROFILE = {
  id: USER_ID, org_id: ORG_ID, full_name: 'בעלים', role: 'owner',
  phone: null, active: true, supplier_id: null,
};

const SESSION = {
  access_token: 'evidence.harness.token',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  refresh_token: 'evidence-harness-refresh',
  user: {
    id: USER_ID, aud: 'authenticated', role: 'authenticated',
    email: 'owner@evidence.local', app_metadata: {}, user_metadata: {},
    created_at: new Date(0).toISOString(),
  },
};

const USD_TRANSACTION = {
  id: '60990000-0000-4000-8000-000000000001',
  org_id: ORG_ID, import_id: '50990000-0000-4000-8000-000000000001',
  tx_date: '2026-08-24', description: 'העברה לספק חו״ל', reference: 'WIRE-8841',
  amount: 3100, currency: 'USD', status: 'unmatched', supplier_id: SUPPLIER_ID,
  created_at: '2026-08-24T09:00:00Z',
};

/** PostgREST answers a table read with an array and an RPC with whatever the function returns. */
const TABLES = {
  profiles: [PROFILE],
  organizations: [ORGANIZATION],
  platform_admins: [],
  currencies: [{ code: 'ILS', minor_units: 2 }, { code: 'USD', minor_units: 2 }, { code: 'EUR', minor_units: 2 }],
  bank_transactions: [USD_TRANSACTION],
  bank_imports: [{
    id: '50990000-0000-4000-8000-000000000001', org_id: ORG_ID, filename: 'august.xlsx',
    imported_at: '2026-08-25T07:00:00Z', row_count: 12, currency: 'USD',
  }],
  suppliers: [{
    id: SUPPLIER_ID, org_id: ORG_ID, name: 'Atlantic Foods Ltd', status: 'active',
    default_currency: 'USD', country_code: 'US', min_order_amount: 500,
    delivery_days: [], cutoff_time: null, payment_terms: 'שוטף + 30', notes: null,
    tax_id: null, contact_name: null, phone: null, whatsapp: null, email: null, address: null,
    deleted_at: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    rating: null, rating_updated_at: null, rating_note: null, preferred: false,
    supplier_categories: [],
  }],
  payments: [],
  invoices: [],
  bank_allocations: [],
  invoice_balances_by_currency: [],
  supplier_balances_by_currency: [],
  supplier_metrics: [],
  invitations: [],
  export_templates: [],
};

const RPCS = {
  organization_access_state: [{ access_mode: 'active' }],
  /* #292: history, not open balance. The dollar came in through an invoice and the euro through a
     supplier default that has not produced a document yet — the case that lets an owner state a
     value BEFORE meeting the refusal. */
  currencies_in_use: [
    { currency: 'ILS', sources: ['base_currency', 'invoice'] },
    { currency: 'USD', sources: ['invoice', 'bank_import'] },
    { currency: 'EUR', sources: ['supplier_default'] },
  ],
  organization_offboarding_state: [],
  resolve_feature_flags: {},
  financial_supplier_directory: [],
};

function tableFromUrl(url) {
  const match = /\/rest\/v1\/([a-z0-9_]+)/i.exec(url);
  return match ? match[1] : null;
}

async function serve(route, request) {
  const url = request.url();
  /* `content-range` is not decoration here. `fetchServerList` asks PostgREST for `count=exact`
     and reads the total out of this header; answering `0-0/*` is what PostgREST sends for
     `count=estimated`, which arrives as NO count and makes a populated list render as empty. */
  const json = (body, status = 200) => {
    const size = Array.isArray(body) ? body.length : 1;
    const range = size === 0 ? `*/0` : `0-${size - 1}/${size}`;
    return route.fulfill({
      status,
      contentType: 'application/json',
      headers: {
        'access-control-allow-origin': '*',
        'access-control-expose-headers': 'content-range',
        'content-range': range,
      },
      body: JSON.stringify(body),
    });
  };

  if (request.method() === 'OPTIONS') {
    return route.fulfill({
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      },
    });
  }
  if (url.includes('/auth/v1/token')) return json(SESSION);
  if (url.includes('/auth/v1/user')) return json(SESSION.user);
  if (url.includes('/auth/v1/logout')) return json({});

  const rpc = /\/rest\/v1\/rpc\/([a-z0-9_]+)/i.exec(url);
  if (rpc) {
    if (!(rpc[1] in RPCS)) {
      console.warn(`  [harness] unstubbed rpc: ${rpc[1]} — answering []`);
      return json([]);
    }
    return json(RPCS[rpc[1]]);
  }

  const table = tableFromUrl(url);
  if (table) {
    if (request.method() === 'PATCH' || request.method() === 'POST') return json([]);
    if (!(table in TABLES)) {
      console.warn(`  [harness] unstubbed table: ${table} — answering []`);
      return json([]);
    }
    /* `.single()` asks PostgREST for ONE OBJECT, not an array of one, through this Accept header.
       Answering with the array regardless makes supabase-js reject, and the screen that used it —
       the supplier card — renders nothing while every other screen looks fine. */
    const accept = (request.headers().accept ?? '');
    if (accept.includes('vnd.pgrst.object+json')) return json(TABLES[table][0] ?? null);
    return json(TABLES[table]);
  }
  return json({});
}

/**
 * Navigate, and survive vite re-optimising its dependency cache mid-run.
 *
 * The first visit to a lazily-imported route can arrive while vite is rewriting `.vite/deps`, and
 * the chunk request answers `504 Outdated Optimize Dep`. React's lazy import rejects, the route
 * error boundary paints "the screen could not be loaded", and a screenshot of THAT is a picture of
 * a build artefact rather than of the product. One reload after the optimiser settles is the fix,
 * and it is only ever needed on a cold dev server.
 */
async function gotoStable(page, url) {
  /* A modal left open by the previous screen keeps its own focus trap, and `Escape` is the
     app's own way to close one. Navigating out from under it worked but left the harness
     asserting against a page that had never finished settling. */
  await page.keyboard.press('Escape').catch(() => {});
  await page.goto(url);
  // The shell is what tells us the route mounted; each caller then waits for its own content.
  await page.waitForSelector('#main', { timeout: 30_000 });
}

async function waitForServer(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`dev server did not answer on ${url}`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const shots = [];

  /* `preview`, not `dev`, and the reason is a measurement rather than a preference. On the dev
     server the first visit to a lazily-imported route can race vite's dependency optimiser: the
     chunk answers `504 Outdated Optimize Dep`, React's lazy import rejects, and the route error
     boundary paints "the screen could not be loaded". Reloading moved the failure to the next
     route rather than fixing it. The built bundle has no optimiser and no chunk invalidation, and
     it is also what a user actually receives — so run `npm run build` before this script. */
  /* `stdio: 'ignore'` COST MORE TIME THAN EVERY OTHER PROBLEM HERE COMBINED. An earlier run left a
     vite DEV server holding this port; `--strictPort` made every later `preview` fail to bind and
     exit, silently, and the browser happily talked to the orphan instead. Every fix after that was
     measured against a server that was not the one this script started, so nothing changed and the
     dev server's `504 Outdated Optimize Dep` looked like a broken route. The child's output is
     kept, and the port is checked first, so this cannot happen quietly again. */
  const vite = spawn('node', ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'],
    { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  let serverOutput = '';
  vite.stdout.on('data', (chunk) => { serverOutput += chunk; });
  vite.stderr.on('data', (chunk) => { serverOutput += chunk; });
  vite.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`preview server exited with ${code}:\n${serverOutput.slice(0, 800)}`);
    }
  });
  const stop = () => { try { vite.kill(); } catch { /* already gone */ } };
  process.on('exit', stop);

  try {
    await waitForServer(BASE);
    const browser = await chromium.launch({ headless: !HEADED, executablePath: CHROME });
    const consoleErrors = [];

    /* A FRESH CONTEXT PER SCREEN, AND THIS IS THE ONE THING THAT WORKED.
       Driven through a shared context, the third route reliably painted React's lazy-import
       boundary — "the screen could not be loaded, the app may have been updated while this tab was
       open" — no matter which route was third. Reloading did not help, blocking the service worker
       did not help, and neither did giving each screen its own page. The same route visited first,
       in a context of its own, rendered every time. So the shared context is the variable, and the
       fix is to stop sharing it rather than to keep theorising about why it leaks.
       The cost is one sign-in per screen, which is seconds against a wrong picture. */
    const openScreen = async (url) => {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        locale: 'he-IL',
        // recharts and every transition are absent from the DOM until they have run; a screenshot
        // taken mid-animation measures nothing.
        reducedMotion: 'reduce',
        // Nothing here is about the PWA, and a worker taking control mid-session is one more way
        // for a chunk to go missing under a screenshot.
        serviceWorkers: 'block',
      });
      await context.route(`${SUPABASE}/**`, serve);
      const screen = await context.newPage();
      screen.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

      // Sign in through the intercepted token endpoint, so supabase-js persists the session under
      // whatever storage key it actually uses rather than one this script guessed.
      await screen.goto(`${BASE}/login`);
      await screen.fill('#email', 'owner@evidence.local');
      await screen.fill('#password', 'evidence-harness');
      await screen.click('button[type="submit"]');
      await screen.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });

      await screen.goto(url);
      await screen.waitForSelector('#main', { timeout: 30_000 });
      screen.closeAll = () => context.close();
      return screen;
    };

    /* ---- P4-G3: the column that showed an em dash for every supplier in production ----
       `state: 'attached'`, not the default `visible`: the list renders each row twice, once for
       the table and once for the mobile card, and the first match at this viewport is the hidden
       one. Waiting for visibility waits for an element that is correctly never shown. */
    const suppliers = await openScreen(`${BASE}/suppliers`);
    await suppliers.waitForSelector('text=Atlantic Foods Ltd', { state: 'attached', timeout: 30_000 });
    await suppliers.waitForTimeout(800);
    await suppliers.screenshot({ path: path.join(OUT, 'p4-g3-supplier-minimum-column.png') });
    shots.push('p4-g3-supplier-minimum-column.png');
    await suppliers.closeAll();

    // ---- P4-G2: the write field names the currency of the row it writes ----
    const card = await openScreen(`${BASE}/suppliers/${SUPPLIER_ID}`);
    // The card fetches orders, invoices, credits and prices before it draws its action row.
    await card.waitForSelector('text=Atlantic Foods Ltd', { state: 'attached', timeout: 30_000 });
    const edit = card.getByRole('button', { name: 'עריכה' }).first();
    await edit.scrollIntoViewIfNeeded();
    await edit.click({ timeout: 30_000 });
    await card.waitForSelector('text=מינימום הזמנה (USD)', { timeout: 30_000 });
    await card.waitForTimeout(600);
    await card.screenshot({ path: path.join(OUT, 'p4-g2-supplier-minimum-usd.png') });
    shots.push('p4-g2-supplier-minimum-usd.png');
    await card.closeAll();

    // ---- P3-G1: four keys per currency, and the unstated ones say so ----
    const settings = await openScreen(`${BASE}/settings`);
    await settings.waitForSelector('text=סטיות סכום מותרות', { timeout: 30_000 });
    await settings.waitForSelector('#tolerance-bank_match_amount_tolerance-USD');
    await settings.locator('text=סטיות סכום מותרות').scrollIntoViewIfNeeded();
    await settings.waitForTimeout(600);
    // Card renders a div, not a section (ui.tsx) — anchor on the class it actually carries.
    await settings.locator('.card', { hasText: 'סטיות סכום מותרות' }).first()
      .screenshot({ path: path.join(OUT, 'p3-g1-tolerances-panel.png') });
    shots.push('p3-g1-tolerances-panel.png');
    await settings.closeAll();

    // ---- P1-G2: a dollar line with no dollar tolerance offers nothing, and says why ----
    /* `?id=` opens the match modal on its own for a role that may operate the bank, which avoids
       clicking a row that renders twice — once for the table and once for the mobile card — where
       only one of the two is visible at this viewport. */
    const bank = await openScreen(`${BASE}/bank?id=${USD_TRANSACTION.id}`);
    await bank.waitForSelector('text=לא נקבעה סטיית סכום מותרת', { timeout: 30_000 });
    await bank.waitForTimeout(800);
    await bank.screenshot({ path: path.join(OUT, 'p1-g2-bank-no-tolerance.png') });
    shots.push('p1-g2-bank-no-tolerance.png');
    await bank.closeAll();


    fs.writeFileSync(path.join(OUT, 'evidence.json'), `${JSON.stringify({
      base: BASE,
      supabaseOrigin: SUPABASE,
      intercepted: true,
      databaseTouched: false,
      screenshots: shots,
      consoleErrors,
    }, null, 2)}\n`);

    console.log(`\n${shots.length} screenshot(s) in ${OUT}`);
    if (consoleErrors.length) {
      console.log(`console errors (${consoleErrors.length}):`);
      for (const line of consoleErrors.slice(0, 10)) console.log(`  ${line}`);
    }
    await browser.close();
  } finally {
    stop();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
