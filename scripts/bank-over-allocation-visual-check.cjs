// Visual verification of the /bank un-match dialog's allocation figure (MON-04, migration 0322).
//
// The claim under test is not "a sentence renders" — `src/pages/bankStatementLineAllocation.spec.tsx`
// already pins that in jsdom. It is the part only a picture settles: that a discrepancy in money
// reads as one on a real screen — that the alert is visible above the fold of the dialog rather
// than below its scroll, that the RTL panel puts the figure and the line amount in the same
// column, and that the ordinary case (a split that adds up) does NOT get a red band.
//
// HEADED ON PURPOSE — headless misses injected CSS on this machine (memory:
// headless-screenshot-stale-css). Serving and fixture patterns copied from
// `scripts/toast-undo-visual-check.cjs`, which is the shape this repo already trusts.
//
// FIXTURES, NOT THE DEMO STACK. Other agents share this machine's local Supabase and this campaign
// serialises it; a screenshot run must not read or write it. Every response below is routed.
//
// Not wired into any gate; run manually:
//   node scripts/bank-over-allocation-visual-check.cjs
const { chromium } = require('playwright-core');
const { spawn } = require('node:child_process');
const { dirname, join } = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');

const ROOT = join(__dirname, '..');
const OUT = process.env.BANK_SHOT_DIR || join(ROOT, '.bank-shots');
const PORT = 5199 + 711; // away from dev, the gate and the other visual checks
const API = 'http://127.0.0.1:55431'; // matches VITE_SUPABASE_URL in .env.local

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const TX_ID = 'fa000000-0000-4000-8000-000000000008';

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
  logo_path: null, logo_updated_at: null, settings: {}, base_currency: 'ILS',
};
const SUPPLIER = { id: 'sup-1', name: 'דגי הים התיכון', tax_id: null, payment_terms: null, status: 'active' };

// A matched 2,950.00 ILS line — the one MON-04 was found on.
const TRANSACTION = {
  id: TX_ID, org_id: ORG_ID, import_id: 'imp-1', tx_date: '2026-07-14',
  description: 'העברה לדגי הים התיכון', amount: 2950, currency: 'ILS', is_debit: true,
  reference: '782044', raw: {}, supplier_id: 'sup-1', status: 'matched', row_hash: 'r-782044',
};

// Two scenarios, one screen. The first is the defect as the finding describes it; the second is
// the ordinary case that must NOT be dressed up as one.
const SCENARIOS = [
  {
    label: 'over-allocated',
    allocations: [
      { id: 'ba-1', amount: 2950, currency: 'ILS' },
      { id: 'ba-2', amount: 2950, currency: 'ILS' },
    ],
    expectAlert: true,
  },
  {
    label: 'split-that-adds-up',
    allocations: [
      { id: 'ba-3', amount: 1000, currency: 'ILS' },
      { id: 'ba-4', amount: 1950, currency: 'ILS' },
    ],
    expectAlert: false,
  },
];

async function installFixtures(context, allocations) {
  await context.route(`${API}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body, status = 200, headers = {}) => route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range', ...headers },
      body: JSON.stringify(body),
    });
    const wantsObject = (request.headers().accept || '').includes('pgrst.object');
    const row = (value) => json(wantsObject ? (value ?? null) : (value ? [value] : []));
    if (request.method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*', 'access-control-allow-headers': '*',
          'access-control-allow-methods': '*', 'access-control-expose-headers': 'content-range',
        },
      });
    }
    if (path.startsWith('/auth/v1/token')) return json(SESSION());
    if (path.startsWith('/auth/v1/user')) return json(USER);
    if (path.startsWith('/auth/v1/logout')) return json({});
    if (path.endsWith('/rpc/organization_access_state')) return json([{ access_mode: 'active' }]);
    // `/bank` sits behind the `bank.reconciliation` capability (`App.tsx`, and the same key gates
    // the table in `0252`). Without a measured `true` the route renders the upgrade page and there
    // is no dialog to photograph.
    if (path.endsWith('/rpc/my_entitlements')) {
      return json([{
        entitlement_key: 'bank.reconciliation', kind: 'boolean', boolean_value: true, measured: true,
      }]);
    }
    if (path.startsWith('/rest/v1/rpc/')) return json(null);
    if (path.startsWith('/rest/v1/profiles')) return row(PROFILE);
    if (path.startsWith('/rest/v1/organizations')) return row(ORGANIZATION);
    if (path.startsWith('/rest/v1/platform_admins')) return row(null);
    // `fetchServerList` asks for an exact count and refuses to serve a page without one.
    if (path.startsWith('/rest/v1/bank_transactions')) {
      return json(request.method() === 'HEAD' ? [] : [TRANSACTION], 200, { 'content-range': '0-0/1' });
    }
    if (path.startsWith('/rest/v1/bank_allocations')) return json(allocations);
    if (path.startsWith('/rest/v1/financial_supplier_directory')) return json([SUPPLIER]);
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

async function main() {
  mkdirSync(OUT, { recursive: true });
  // Resolved, not assembled: in a git worktree `node_modules` is a junction one level up, so
  // `<root>/node_modules/vite` does not exist and the preview server never starts.
  const viteBin = join(dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
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

  // System Edge, headed. Playwright's own bundled Chromium fails to spawn on this machine
  // (`spawn UNKNOWN`), and headless misses injected CSS here in any case.
  const browser = await chromium.launch({
    headless: false,
    executablePath: process.env.VISUAL_CHECK_BROWSER
      || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  });
  const findings = [];
  const readings = [];
  try {
    for (const scenario of SCENARIOS) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 }, locale: 'he-IL', serviceWorkers: 'block',
      });
      await installFixtures(context, scenario.allocations);
      const page = await context.newPage();
      await signIn(page, baseURL);
      // `?id=` pins the list to one line and opens its dialog, which is the surface under test.
      await page.goto(`${baseURL}/bank?id=${TX_ID}`);
      try {
        await page.getByRole('dialog').waitFor({ timeout: 20000 });
      } catch (error) {
        console.error('page text at failure:',
          (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 900));
        throw error;
      }
      await page.getByText('משויך מהתנועה (מאושר)').waitFor({ timeout: 20000 });

      const probe = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const label = [...dialog.querySelectorAll('span')]
          .find((s) => s.textContent.trim() === 'משויך מהתנועה (מאושר)');
        const rowText = label ? label.parentElement.textContent.replace(/\s+/g, ' ').trim() : null;
        const alert = dialog.querySelector('[role="alert"]');
        const dialogBody = dialog.querySelector('.dialog-safe-body');
        const visibleInBody = (el) => {
          if (!el) return null;
          const a = el.getBoundingClientRect();
          const b = dialogBody.getBoundingClientRect();
          return a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
        };
        return {
          allocatedRow: rowText,
          alertText: alert ? alert.textContent.replace(/\s+/g, ' ').trim() : null,
          alertFullyVisible: visibleInBody(alert),
          dialogScrolls: dialogBody.scrollHeight > dialogBody.clientHeight + 1,
          direction: getComputedStyle(document.documentElement).direction,
        };
      });
      readings.push({ scenario: scenario.label, ...probe });

      const file = join(OUT, `bank-unmatch-${scenario.label}-1440x900.png`);
      await page.screenshot({ path: file });

      if (!probe.allocatedRow) findings.push(`${scenario.label}: the allocated row is not on screen`);
      if (scenario.expectAlert) {
        if (!probe.alertText) findings.push(`${scenario.label}: no alert names the over-allocation`);
        else if (probe.alertFullyVisible === false) {
          findings.push(`${scenario.label}: the alert is below the dialog's visible area`);
        }
      } else if (probe.alertText) {
        findings.push(`${scenario.label}: an alert fired on a split that adds up — ${probe.alertText}`);
      }
      if (probe.direction !== 'rtl') findings.push(`${scenario.label}: document direction is ${probe.direction}`);

      console.log(`${scenario.label}:`, JSON.stringify(probe));
      await context.close();
    }

    writeFileSync(join(OUT, 'bank-over-allocation-readings.json'),
      `${JSON.stringify({ viewport: '1440x900', findings, readings }, null, 2)}\n`, 'utf8');

    if (findings.length) {
      console.error(`\nFINDINGS:\n${findings.map((f) => ` - ${f}`).join('\n')}`);
      process.exitCode = 1;
    } else {
      console.log(`\nbank over-allocation visual check: OK, ${SCENARIOS.length} shots in ${OUT}`);
    }
  } finally {
    await browser.close();
    preview.kill('SIGTERM');
    setTimeout(() => { try { process.kill(preview.pid); } catch { /* gone */ } }, 1500);
  }
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(e); process.exit(1); });
