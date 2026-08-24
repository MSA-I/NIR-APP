// Live smoke for the app.inplace.digital cutover.
//
// Read-only against production: it signs in with the three authorised demo identities, navigates,
// signs out, and observes. It submits no business form. The one non-GET it exercises besides
// sign-in/sign-out is the password-recovery call, and that request is INTERCEPTED AND ABORTED after
// its payload is read — the point is to prove which `redirect_to` the client constructs, not to send
// a recovery email.
//
// Ported 1:1 in shape from rollout-evidence/20260823-15baeac-final/authenticated-readonly-smoke.cjs.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const evidenceDir = __dirname;
const baseUrl = process.env.SMOKE_BASE_URL || 'https://app.inplace.digital';
const credentialsPath = process.env.SMOKE_CREDENTIALS;
const executablePath = process.env.CHROME_PATH;
if (!credentialsPath || !fs.existsSync(credentialsPath)) throw new Error('Credentials file unavailable.');
if (!executablePath || !fs.existsSync(executablePath)) throw new Error('CHROME_PATH unavailable.');

const roleByEmail = new Map([
  ['owner@gamos.demo', 'owner'],
  ['office@gamos.demo', 'office'],
  ['accountant@gamos.demo', 'accountant'],
]);
const credentialRows = fs.readFileSync(credentialsPath, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.match(/^\s*([^#\s:]+@gamos\.demo)\s*:\s*(.+?)\s*$/i))
  .filter(Boolean)
  .map((m) => ({ email: m[1].toLowerCase(), password: m[2] }))
  .filter((row) => roleByEmail.has(row.email));
if (credentialRows.length !== 3) throw new Error('Credentials file must contain the three active demo identities.');

const sanitize = (raw) => { const u = new URL(raw); return `${u.origin}${u.pathname}`; };

function watch(page) {
  const obs = { consoleErrors: [], pageErrors: [], requestFailures: [], httpErrors: [], corsErrors: [] };
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    obs.consoleErrors.push(m.text());
    if (/CORS|Cross-Origin|Access-Control/i.test(m.text())) obs.corsErrors.push(m.text());
  });
  page.on('pageerror', (e) => obs.pageErrors.push(e.message));
  page.on('requestfailed', (r) => obs.requestFailures.push({ url: sanitize(r.url()), error: r.failure()?.errorText || 'unknown' }));
  page.on('response', (r) => { if (r.status() >= 400) obs.httpErrors.push({ status: r.status(), url: sanitize(r.url()) }); });
  return obs;
}

async function signIn(page, credential) {
  await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.getByLabel('אימייל').fill(credential.email);
  await page.locator('#password').fill(credential.password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.endsWith('/login'), { timeout: 45000 }),
    page.getByRole('button', { name: 'התחברות' }).click(),
  ]);
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
}

async function overflow(page) {
  return page.evaluate(() => {
    const d = document.documentElement;
    return { clientWidth: d.clientWidth, scrollWidth: d.scrollWidth, overflow: d.scrollWidth > d.clientWidth };
  }).catch(() => ({ clientWidth: null, scrollWidth: null, overflow: null }));
}

(async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  const results = [];
  let recovery = null;
  let operator = null;
  let mobile = null;

  try {
    for (const credential of credentialRows) {
      const role = roleByEmail.get(credential.email);
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'he-IL', serviceWorkers: 'block' });
      const page = await context.newPage();
      const obs = watch(page);
      const entry = { role, origin: baseUrl };

      try {
        await signIn(page, credential);
        entry.loginSucceeded = !new URL(page.url()).pathname.endsWith('/login');
        entry.afterLogin = sanitize(page.url());

        // Session persistence across a full reload of a deep route (SPA deep link + refresh).
        await page.goto(`${baseUrl}/suppliers`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
        entry.deepLinkUrl = sanitize(page.url());
        entry.deepLinkStayedAuthenticated = !new URL(page.url()).pathname.endsWith('/login');
        entry.deepLinkHeading = await page.evaluate(
          () => document.querySelector('h1,h2')?.textContent?.trim() ?? null,
        ).catch(() => null);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
        entry.reloadStayedAuthenticated = !new URL(page.url()).pathname.endsWith('/login');
        Object.assign(entry, await overflow(page));

        await page.screenshot({ path: path.join(evidenceDir, `smoke-${role}-desktop.png`), fullPage: false }).catch(() => {});

        // Owner-only extras: operator boundary and the recovery redirect the client constructs.
        if (role === 'owner') {
          await page.goto(`${baseUrl}/operator`, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
          operator = {
            url: sanitize(page.url()),
            status: 'loaded',
            bodyText: (await page.evaluate(() => document.body.innerText.slice(0, 400)).catch(() => '')).replace(/\s+/g, ' ').trim(),
          };
          await page.screenshot({ path: path.join(evidenceDir, 'smoke-operator-desktop.png'), fullPage: false }).catch(() => {});
        }

        // Sign out.
        const menu = page.getByRole('button', { name: /תפריט החשבון/ });
        if (await menu.count()) await menu.first().click().catch(() => {});
        const logout = page.getByRole('button', { name: 'התנתקות' });
        if (await logout.count()) {
          await logout.first().click().catch(() => {});
          const confirm = page.getByRole('button', { name: 'התנתקות בכל זאת' });
          if (await confirm.count()) await confirm.first().click().catch(() => {});
          await page.waitForURL((u) => u.pathname.endsWith('/login'), { timeout: 20000 }).catch(() => {});
        }
        entry.logoutSucceeded = new URL(page.url()).pathname.endsWith('/login');
        entry.afterLogout = sanitize(page.url());
      } catch (error) {
        entry.error = error.message;
      }

      Object.assign(entry, obs);
      results.push(entry);
      await context.close();
    }

    // Password recovery: read the redirect the client builds, then abort before it reaches the server.
    {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'he-IL', serviceWorkers: 'block' });
      const page = await context.newPage();
      let captured = null;
      await page.route('**/auth/v1/recover*', async (route) => {
        const req = route.request();
        let body = null;
        try { body = JSON.parse(req.postData() || '{}'); } catch { body = { unparsed: true }; }
        captured = { url: req.url(), redirectToInQuery: new URL(req.url()).searchParams.get('redirect_to'), body };
        await route.abort();
      });
      await page.goto(`${baseUrl}/forgot-password`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.getByLabel('אימייל').fill(credentialRows[0].email);
      await page.getByRole('button', { name: /שליחת קישור|איפוס|שליחה/ }).first().click().catch(() => {});
      await page.waitForTimeout(4000);
      recovery = captured ?? { captured: false };
      await context.close();
    }

    // Mobile smoke.
    {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'he-IL', serviceWorkers: 'block', isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
      const page = await context.newPage();
      const obs = watch(page);
      await signIn(page, credentialRows[0]);
      await page.waitForTimeout(1500);
      mobile = { url: sanitize(page.url()), ...(await overflow(page)), ...obs };
      await page.screenshot({ path: path.join(evidenceDir, 'smoke-owner-mobile-390.png'), fullPage: false }).catch(() => {});
      await context.close();
    }
  } finally {
    await browser.close();
  }

  const report = {
    observedAt: new Date().toISOString(),
    baseUrl,
    deploymentId: 'e851dbe8-fcc6-450d-b5b8-d80aace67da0',
    releaseSha: '15baeac',
    roles: results,
    operator,
    recovery,
    mobile,
    summary: {
      loginFailures: results.filter((r) => !r.loginSucceeded).length,
      logoutFailures: results.filter((r) => !r.logoutSucceeded).length,
      deepLinkFailures: results.filter((r) => !r.deepLinkStayedAuthenticated || !r.reloadStayedAuthenticated).length,
      overflowFailures: results.filter((r) => r.overflow).length + (mobile?.overflow ? 1 : 0),
      corsErrorPages: results.filter((r) => r.corsErrors.length).length + ((mobile?.corsErrors?.length ?? 0) ? 1 : 0),
      consoleErrorPages: results.filter((r) => r.consoleErrors.length).length,
      pageErrorPages: results.filter((r) => r.pageErrors.length).length,
      httpErrorPages: results.filter((r) => r.httpErrors.length).length,
      requestFailurePages: results.filter((r) => r.requestFailures.length).length,
    },
  };
  fs.writeFileSync(path.join(evidenceDir, 'cutover-smoke.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ summary: report.summary, recovery, operatorUrl: operator?.url, mobile: { url: mobile?.url, overflow: mobile?.overflow } }, null, 1));
})().catch((error) => { console.error('SMOKE_FAILED', error.message); process.exit(1); });
