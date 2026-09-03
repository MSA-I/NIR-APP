/**
 * Finding 10 of the adversarial review, measured rather than argued.
 *
 * The claim: on the control centre, `byMonth` is filtered to the picked currency but the presence
 * test that decides whether the bar chart has anything to draw reads the UNFILTERED `invoices`.
 * A currency the picker offers but that holds no invoice inside the four-month window therefore
 * yields four zero points, and `SpendBarChart` — which branches on `points.length` — draws axes
 * instead of saying there is nothing to show.
 *
 * WHY AN INTERCEPT AND NOT A FIXTURE. The state under test is "this currency is a tab because the
 * business still owes money in it, and no invoice in it landed in the last four months". The demo
 * organisation holds exactly one USD invoice, dated inside the window, so it renders one real bar.
 * Ageing that invoice out is a DB write and the local stack is shared, so instead the PostgREST
 * response for the charts' invoice read is filtered on the wire: USD rows are dropped, ILS rows
 * are untouched. The tab survives, because it comes from the server-side balance snapshot rather
 * than from this read. That is the same state a business reaches on its own the day a USD invoice
 * turns four months old with its balance still open.
 *
 * HEADED ON PURPOSE — headless misses injected CSS on this machine (memory:
 * headless-screenshot-stale-css). `reducedMotion: 'reduce'` because recharts animates in and a
 * screenshot taken mid-animation photographs an empty container.
 *
 * Reads the demo manifest at run time and never prints a password. Touches no database.
 *
 *   node scripts/currency-empty-series-check.cjs            # after `npm run dev`
 */
const { chromium } = require('playwright-core');
const { readFileSync, mkdirSync, existsSync } = require('node:fs');
const { join, dirname } = require('node:path');

const ROOT = join(__dirname, '..');
/** `before` / `after` so one run cannot overwrite the other half of the evidence. */
const LABEL = process.argv[2] || 'after';
const OUT = join(ROOT, 'artifacts', 'review', 'shots', 'finding-10');
const BASE = process.env.INPLACE_BASE_URL || 'http://localhost:5199';
/**
 * The bundled `ms-playwright/chromium-1234` build refuses to start on this machine — Playwright
 * reports `browserType.launch: spawn UNKNOWN` before any page exists — so the installed Chrome is
 * used instead and the bundle is only the last resort. Set `PLAYWRIGHT_CHROMIUM` to override.
 */
const CHROME = process.env.PLAYWRIGHT_CHROMIUM || [
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe'),
].find((candidate) => existsSync(candidate));

/**
 * `NIR-APP-DOCS` sits beside the repository, so a plain `../..` finds it from a normal checkout
 * and misses it from a worktree, which is four levels deeper. Walk up instead of counting.
 */
function findManifest() {
  if (process.env.INPLACE_DEMO_MANIFEST) return process.env.INPLACE_DEMO_MANIFEST;
  let dir = ROOT;
  for (let up = 0; up < 8; up += 1) {
    const candidate = join(dir, 'NIR-APP-DOCS', 'DEMO-USERS.local.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
const MANIFEST = findManifest();

/** The owner account, read at run time. The password never leaves this function's return value. */
function ownerAccount() {
  if (!MANIFEST) throw new Error('demo manifest not found beside the repository; set INPLACE_DEMO_MANIFEST');
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const owner = manifest.accounts.find((a) => String(a.email).toLowerCase().startsWith('owner@'));
  if (!owner) throw new Error('the demo manifest carries no owner account');
  return { email: String(owner.email).trim().toLowerCase(), password: String(owner.password) };
}

async function signIn(page) {
  const { email, password } = ownerAccount();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: /התחברות|Sign in/ }).first().click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
}

/**
 * Wait for the control centre to settle. `networkidle` alone catches a half-hydrated screen, so
 * the currency picker — which only renders once `data` resolved — is the real signal.
 */
async function settle(page) {
  await page.waitForLoadState('networkidle');
  await page.locator('[data-testid^="dashboard-currency-"]').first()
    .waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(() => document.querySelectorAll('.recharts-wrapper, [data-empty-chart]').length > 0
    || document.body.innerText.length > 0);
}

/** Read what the monthly card is actually showing: bars, axis ticks, or the empty sentence. */
async function readMonthlyCard(page) {
  const card = page.locator('section[aria-labelledby="monthly-trend-title"]');
  await card.scrollIntoViewIfNeeded();
  return card.evaluate((node) => ({
    bars: node.querySelectorAll('.recharts-bar-rectangle').length,
    axisTicks: [...node.querySelectorAll('.recharts-xAxis .recharts-cartesian-axis-tick-value')]
      .map((tick) => tick.textContent.trim()),
    hasChart: node.querySelectorAll('.recharts-wrapper').length > 0,
    text: node.innerText.replace(/\s+/g, ' ').trim(),
  }));
}

async function shoot(page, name) {
  const card = page.locator('section[aria-labelledby="monthly-trend-title"]');
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: join(OUT, `${name}.png`) });
}

(async () => {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: false, executablePath: CHROME });
  const results = { label: LABEL };
  try {
    const context = await browser.newContext({
      locale: 'he-IL',
      viewport: { width: 1440, height: 1000 },
      serviceWorkers: 'block',
      reducedMotion: 'reduce',
    });

    /* Drop USD invoices from the charts' read, and only from it. Everything else — the balance
       snapshot that puts USD in the picker, the orders, the payments — is untouched, so the
       browser sees exactly "a currency this business holds, with no invoice in the window". */
    let dropped = 0;
    await context.route('**/rest/v1/invoices*', async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      let rows;
      try { rows = JSON.parse(body); } catch { return route.fulfill({ response }); }
      if (!Array.isArray(rows)) return route.fulfill({ response });
      const kept = rows.filter((row) => row.currency !== 'USD');
      dropped += rows.length - kept.length;
      return route.fulfill({ response, body: JSON.stringify(kept) });
    });

    const page = await context.newPage();
    await signIn(page);
    await settle(page);

    const currencies = await page.locator('[data-testid^="dashboard-currency-"]')
      .evaluateAll((nodes) => nodes.map((n) => n.dataset.testid.replace('dashboard-currency-', '')));
    results.usdInvoicesDroppedFromChartRead = dropped;
    results.currencyTabs = currencies;

    // ILS first: the control. Real invoices, real bars.
    await page.locator('[data-testid="dashboard-currency-ILS"]').click();
    await page.waitForTimeout(400);
    results.ILS = await readMonthlyCard(page);
    await shoot(page, LABEL + '-ils-control');

    if (!currencies.includes('USD')) {
      results.note = 'USD is not a tab in this state — the case could not be staged.';
    } else {
      await page.locator('[data-testid="dashboard-currency-USD"]').click();
      await page.waitForTimeout(400);
      results.USD = await readMonthlyCard(page);
      await shoot(page, LABEL + '-usd-no-invoices');
    }

    console.log(JSON.stringify(results, null, 2));
    await context.close();
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
