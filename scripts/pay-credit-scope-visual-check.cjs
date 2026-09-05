// `MON-06` — what /pay tells the accountant about credits it cannot see.
//
// The claim only a picture settles: that the execution dialog printed a credit figure of ₪50.00
// and, one panel below it, the sentence "אין זיכויים פתוחים לספק זה" — *this supplier has no open
// credits*. Two answers to what a reader takes for one question, on one screen, at one time.
//
// THE FIXTURES ARE THE MEASUREMENT, not an invention. They reproduce production payment request
// #15 (approved, 299.00 ILS, `open_credit_override_total` = 50.00, supplier חוות השדה) and the
// answer `credit_request_balance_rows` actually returns for `accountant@gamos.demo` on the
// guarded path: an empty array. Both were read read-only from the production project on
// 05.09.2026 and are recorded in `docs/qa/2026-09-04/evidence/PR15-MON-06-MEASUREMENT.txt`.
//
// HEADED ON PURPOSE — headless misses injected CSS on this machine (memory:
// headless-screenshot-stale-css), and a dev server serves its stylesheet through JS.
//
// WHY FIXTURES AND NOT THE LOCAL STACK: other agents share this machine's Supabase and this PR
// does not hold its lock. Route interception touches nobody's database. Nothing here executes a
// payment — the dialog is opened and photographed, never submitted.
//
// Not wired into any gate; run manually:
//   node scripts/pay-credit-scope-visual-check.cjs
const { chromium } = require('playwright-core');
const { spawn } = require('node:child_process');
const { join, dirname } = require('node:path');
const { mkdirSync, existsSync } = require('node:fs');

/**
 * This worktree's `node_modules` holds two entries; everything else resolves by walking up to the
 * main checkout. `join(ROOT, 'node_modules', ...)` — the pattern the other visual checks use —
 * therefore points at a file that is not there, and vite exits before the browser ever launches.
 */
function findViteBin(from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', 'vite', 'bin', 'vite.js');
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) throw new Error('vite/bin/vite.js not found above ' + from);
  }
}

const ROOT = join(__dirname, '..');
const OUT = process.env.PAY_SHOT_DIR || join(ROOT, '.pay-shots');
const LABEL = process.env.PAY_SHOT_LABEL || 'after';
// Away from dev (5199), the gate and the other visual checks — and deliberately NOT 6000, which
// every Chromium blocks as `ERR_UNSAFE_PORT` (the X11 range) before the request leaves the browser.
const PORT = 5199 + 100;
const API = process.env.VITE_SUPABASE_URL || 'http://127.0.0.1:55431';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '4ca9a395-e386-48e1-9e4e-9ac5f7e77e2d'; // the accountant's real subject

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
  id: USER_ID, org_id: ORG_ID, full_name: 'רואת חשבון', role: 'accountant',
  phone: null, active: true, supplier_id: null,
};
const ORGANIZATION = {
  id: ORG_ID, name: 'מסעדת הגן הקסום', vat_rate: 18, status: 'active',
  logo_path: null, logo_updated_at: null, settings: {},
};

/** Production request #15, to the figure. */
const REQUEST = {
  id: 'pr-15', org_id: ORG_ID, unit_id: null, number: 15, supplier_id: 'sup-2',
  amount: 299, currency: 'ILS', due_date: '2026-09-12', status: 'approved',
  notes: null, created_by: 'user-2', approved_by: 'user-3', approved_at: '2026-09-01T09:00:00Z',
  open_credit_override_total: 50,
  open_credit_override_reason: 'הזיכוי ייושב מול הספק בנפרד',
  open_credit_override_at: '2026-09-01T09:00:00Z',
  executor_notes: null, created_at: '2026-08-30T09:00:00Z',
  invoices: [{ invoice_id: 'inv-3011', amount_allocated: 299, invoice: { invoice_number: '3011' } }],
  approver: { full_name: 'בעל העסק' },
};
const SUPPLIER = {
  id: 'sup-2', name: 'חוות השדה', tax_id: null, payment_terms: null,
  status: 'active', bank_details: null,
};
const BALANCE = {
  invoice_id: 'inv-3011', currency: 'ILS',
  total_amount: 299, paid_amount: 0, credited_amount: 0, balance_in_currency: 299,
};

async function installFixtures(context) {
  await context.route(`${API}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (process.env.PAY_SHOT_TRACE) step(`  route ${route.request().method()} ${route.request().url().slice(0, 190)}`);
    const json = (body, status = 200) => route.fulfill({
      status, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body),
    });
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
    if (path.endsWith('/rpc/organization_access_state')) return json([{ access_mode: 'active' }]);
    // `/pay` sits behind `capability="payments.accountant_queue"`, and the Guard renders a
    // skeleton for as long as this resolver has not answered in the shape `capabilityValue`
    // reads. A generic `null` here is what left the first three runs staring at a loading card.
    if (path.endsWith('/rpc/my_entitlements')) {
      return json([{
        entitlement_key: 'payments.accountant_queue', kind: 'boolean',
        label: 'תור התשלומים', boolean_value: true, measured: true, source: 'plan',
        unlimited: true, numeric_limit: null,
      }]);
    }
    if (path.endsWith('/rpc/resolve_feature_flags')) return json([]);
    // THE MEASURED ANSWER. Empty for this role, against a tenant holding nine open credits.
    if (path.endsWith('/rpc/credit_request_balance_rows')) return json([]);
    if (path.startsWith('/rest/v1/rpc/')) return json(null);
    if (path.startsWith('/rest/v1/profiles')) return row(PROFILE);
    if (path.startsWith('/rest/v1/organizations')) return row(ORGANIZATION);
    if (path.startsWith('/rest/v1/platform_admins')) return row(null);
    if (path.startsWith('/rest/v1/payment_requests')) return json([REQUEST]);
    if (path.startsWith('/rest/v1/financial_supplier_directory')) return json([SUPPLIER]);
    if (path.startsWith('/rest/v1/financial_supplier_bank_accounts')) return json([]);
    if (path.startsWith('/rest/v1/currencies')) return json([{ code: 'ILS', minor_units: 2 }]);
    if (path.startsWith('/rest/v1/invoice_balances_by_currency')) return json([BALANCE]);
    if (path.startsWith('/rest/v1/exceptions')) return json([]);
    if (path.startsWith('/rest/v1/')) return json([]);
    return json({});
  });
}

const t0 = Date.now();
const step = (m) => process.stdout.write(`[${String((Date.now() - t0) / 1000).padStart(6)}s] ${m}\n`);

async function signIn(page, baseURL) {
  await page.goto(`${baseURL}/login`);
  await page.locator('#email').fill('shots@example.test');
  await page.locator('#password').fill('not-a-real-password');
  await page.getByRole('button', { name: /התחברות|כניסה/ }).first().click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30000 });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const viteBin = findViteBin(ROOT);
  const dev = spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort'], {
    cwd: ROOT, shell: false, stdio: 'pipe',
    env: { ...process.env, VITE_SUPABASE_URL: API, VITE_SUPABASE_ANON_KEY: 'anon-not-verified-in-browser' },
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dev server did not start')), 60000);
    let stderr = '';
    dev.stderr.on('data', (d) => { stderr += String(d); });
    dev.stdout.on('data', (d) => { if (String(d).includes('Local')) { clearTimeout(timer); resolve(); } });
    dev.on('exit', () => {
      clearTimeout(timer);
      reject(new Error(`dev server exited${stderr ? `: ${stderr.trim()}` : ''}`));
    });
  });
  const baseURL = `http://localhost:${PORT}`;

  step(`dev server up on ${baseURL}`);

  const browser = await chromium.launch({
    headless: false,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
  });
  step('browser launched');
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 }, locale: 'he-IL', serviceWorkers: 'block',
    });
    context.setDefaultTimeout(25000);
    await installFixtures(context);
    const page = await context.newPage();
    // A blank screen with a stack trace in the console is the failure mode these checks hit most,
    // and without this it looks identical to "the selector did not match".
    page.on('console', (m) => { if (m.type() === 'error') step(`CONSOLE ERROR: ${m.text().slice(0, 300)}`); });
    page.on('pageerror', (e) => step(`PAGE ERROR: ${String(e).slice(0, 300)}`));
    page.on('requestfailed', (r) => step(`REQ FAILED: ${r.url().slice(0, 160)}`));

    await signIn(page, baseURL);
    step('signed in, at ' + page.url());
    await page.goto(`${baseURL}/pay`);
    step('navigated to /pay');
    await page.screenshot({ path: join(OUT, `pay-landing-${LABEL}.png`) });

    const card = page.getByRole('button', { name: /חוות השדה/ });
    await card.waitFor({ timeout: 25000 });
    step('queue card visible');
    // The card repaints when the balance and exception reads land, so a click issued the instant
    // it first appears can be delivered to a node React has already replaced — the click is then
    // silently lost and only the missing dialog reports it. Let the list settle, then click, and
    // treat one lost click as expected rather than as a failure.
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1000);
    await page.screenshot({ path: join(OUT, `pay-queue-card-${LABEL}.png`) });

    const dialog = page.getByRole('dialog');
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await card.click({ timeout: 10000 }).catch(() => {});
      try {
        await dialog.waitFor({ timeout: 8000 });
        break;
      } catch {
        step(`click ${attempt} did not open the dialog; retrying`);
        if (attempt === 3) throw new Error('dialog never opened');
      }
    }
    step('dialog open');
    // Wait for the credits READ to settle before framing anything. The panel swaps its own child
    // from "טוען יתרות זיכוי…" to the answer, so a scroll issued while the spinner is still up
    // detaches mid-action — which is exactly how the previous run died.
    await dialog.getByText(/אין זיכויים פתוחים לספק זה|לא ניתן להציג כאן את זיכויי הספק/)
      .first().waitFor({ timeout: 20000 });
    step('credits panel settled');
    await dialog.getByText('זיכויים זמינים לקיזוז').first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(OUT, `pay-dialog-${LABEL}.png`) });
    step('dialog photographed');

    // What the two panels literally say, so the evidence file carries the words and not only a
    // picture of them.
    const said = await page.evaluate(() => {
      const text = (sel) => [...document.querySelectorAll(sel)].map((n) => n.textContent.trim());
      const dlg = document.querySelector('[role="dialog"]');
      return {
        overrideNote: text('[role="dialog"] .note, [role="dialog"] [class*="note"]')
          .filter((s) => s.includes('קוזזו')),
        creditsPanelText: dlg
          ? (dlg.textContent.match(/זיכויים זמינים לקיזוז[\s\S]{0,320}/) || [''])[0].replace(/\s+/g, ' ').trim()
          : null,
        claimsNoOpenCredits: !!dlg && dlg.textContent.includes('אין זיכויים פתוחים לספק זה'),
        namesRoleScope: !!dlg && dlg.textContent.includes('חשבוניות מאושרות בלבד'),
        namesApprovalMoment: !!dlg && dlg.textContent.includes('נמדד ברגע האישור'),
        quotesFifty: !!dlg && /50\.00/.test(dlg.textContent),
      };
    });
    console.log(JSON.stringify(said, null, 2));
    await context.close();
  } finally {
    dev.kill();
  }
}

// A hard stop, so a stall reports where it stalled instead of holding the machine. The other
// visual checks have no watchdog and this one waited seven minutes in silence before it got one.
const watchdog = setTimeout(() => {
  step('WATCHDOG: giving up');
  process.exit(1);
}, Number(process.env.PAY_SHOT_BUDGET_MS || 180000));
watchdog.unref?.();

main()
  .then(() => { clearTimeout(watchdog); process.exit(0); })
  .catch((error) => { step('FAILED: ' + String(error).slice(0, 400)); clearTimeout(watchdog); process.exit(1); });
