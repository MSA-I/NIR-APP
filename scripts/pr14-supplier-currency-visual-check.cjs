// The camera for PR 14 — `MON-03` / `FIN-04` (the supplier card) and `FIN-07` (the label that
// states its scope).
//
// WHY THIS ONE TALKS TO THE REAL DATABASE, unlike most visual checks in this folder. The defect
// under test IS the database function: `0218`'s supplier reader LEFT JOINs balances the caller's
// own invoice read never produced and `coalesce(…, 0)`s the misses, so the accountant's card
// printed `$ 0` over a debt it is not shown. A fixture-stubbed harness would photograph the
// fixture, not the defect. So this signs in for real, through `/login`, against the local stack —
// which means it may only be run by the agent holding `.claude/locks/supabase`.
//
// HEADED ON PURPOSE, and on system Edge: Playwright's bundled chromium fails with `spawn UNKNOWN`
// on this machine, and headless misses injected CSS (memory: headless-screenshot-stale-css).
//
// NO PASSWORD PASSES THROUGH THIS FILE. The dev-only quick-fill block on `/login` fills and submits
// the demo credentials itself from `VITE_DEMO_PASSWORD_SEED`; this script only opens the disclosure
// and clicks the role. Nothing here reads, prints or stores a secret.
//
//   node scripts/pr14-supplier-currency-visual-check.cjs --tag RED   --port 5299
//   node scripts/pr14-supplier-currency-visual-check.cjs --tag GREEN --port 5299
//
// It writes two PNGs and prints, as text, what the two surfaces actually say — the numbers on the
// supplier card and the exact wording of the two balance labels — so the claim in the evidence file
// is a reading rather than a recollection.
const { chromium } = require('playwright-core');
const { join } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');

const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'docs', 'qa', '2026-09-04', 'evidence');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const TAG = arg('--tag', 'RUN').replace(/[^A-Za-z0-9_-]/g, '');
const PORT = Number(arg('--port', '5299'));
// `localhost`, not `127.0.0.1`: vite's dev server binds the IPv6 loopback on this machine and a
// literal v4 address is refused. `--host` is deliberately not passed — the server stays loopback.
const BASE = arg('--base', `http://localhost:${PORT}`);

// The supplier the sweep photographed. Two currencies for the accountant: shekels it may value and
// dollars it may not.
const SUPPLIER = 'aa000000-0000-4000-8000-000000000013';

const EDGE_CANDIDATES = [
  process.env.PLAYWRIGHT_EDGE,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();

async function main() {
  mkdirSync(OUT, { recursive: true });
  const lines = [];
  const say = (text) => { lines.push(text); console.log(text); };

  const browser = await chromium.launch({
    headless: false,
    executablePath: EDGE_CANDIDATES[0],
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  const context = await browser.newContext({
    locale: 'he-IL',
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => say(`  page error: ${clean(error.message).slice(0, 200)}`));

  try {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    // The quick-fill block is inside a <details>; opening it is what makes the role buttons exist.
    await page.locator('details summary').first().click();
    // The button's accessible name is its aria-label (`login.signInAsAria` = "כניסה כ{role}"),
    // not its visible text, so this matches on the composed label rather than the role word alone.
    await page.getByRole('button', { name: 'כניסה כרואה חשבון' }).click();
    await page.waitForURL(/\/dashboard/, { timeout: 60_000 });
    say(`signed in as the demo accountant; landed on ${page.url()}`);

    // --- the dashboard, and the label FIN-07 is about ------------------------------------------
    await page.waitForLoadState('networkidle');
    // The control room settles AFTER networkidle — an earlier shot photographs a spinner.
    await page.getByText('יתרת חשבוניות פתוחות', { exact: false }).first()
      .waitFor({ state: 'visible', timeout: 60_000 });
    await page.waitForTimeout(1500);
    const dashboardShot = join(OUT, `PR14-${TAG}-accountant-dashboard-1440x900.png`);
    await page.screenshot({ path: dashboardShot });
    const kpiLabels = await page.getByText('יתרת חשבוניות פתוחות', { exact: false })
      .allTextContents();
    say(`dashboard label(s) reading "יתרת חשבוניות פתוחות…": ${JSON.stringify(kpiLabels.map(clean))}`);
    say(`  -> ${dashboardShot}`);

    // --- the supplier card, and the number MON-03/FIN-04 are about ------------------------------
    await page.goto(`${BASE}/finance/suppliers/${SUPPLIER}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    const supplierShot = join(OUT, `PR14-${TAG}-accountant-supplier-card-1440x900.png`);
    await page.screenshot({ path: supplierShot });
    say(`  -> ${supplierShot}`);

    // The open-balance KPI, read as text rather than judged from the picture.
    const kpiCards = await page.locator('.kpi-value').allTextContents();
    say(`supplier card KPI values: ${JSON.stringify(kpiCards.map(clean))}`);
    const heading = clean(await page.locator('h1, h2').first().textContent().catch(() => ''));
    say(`supplier heading: ${JSON.stringify(heading)}`);

    // --- the invoice list column header, the second FIN-07 surface ------------------------------
    await page.goto(`${BASE}/invoices`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    const headers = await page.locator('th').allTextContents();
    say(`/invoices column headers: ${JSON.stringify(headers.map(clean).filter(Boolean))}`);
  } finally {
    await context.close();
    await browser.close();
  }

  const readPath = join(OUT, `PR14-${TAG}-screen-read.txt`);
  writeFileSync(readPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(`\nwrote ${readPath}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
