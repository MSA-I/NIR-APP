// Two things the main smoke did not prove on their own:
//   1. the operator route is still an authorisation boundary — a non-platform-admin identity is
//      refused on the new origin exactly as before;
//   2. an invitation link and a supplier-portal link render their own screens on the new origin
//      rather than a Pages 404 or the tenant shell.
// Read-only. The tokens used are deliberately invalid strings, so nothing is consumed.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const baseUrl = process.env.SMOKE_BASE_URL || 'https://app.inplace.digital';
const credentialsPath = process.env.SMOKE_CREDENTIALS;
const executablePath = process.env.CHROME_PATH;
const rows = fs.readFileSync(credentialsPath, 'utf8').split(/\r?\n/)
  .map((l) => l.match(/^\s*([^#\s:]+@gamos\.demo)\s*:\s*(.+?)\s*$/i)).filter(Boolean)
  .map((m) => ({ email: m[1].toLowerCase(), password: m[2] }));
const pick = (email) => rows.find((r) => r.email === email);

(async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  const out = { baseUrl, observedAt: new Date().toISOString() };
  try {
    for (const email of ['office@gamos.demo', 'accountant@gamos.demo']) {
      const credential = pick(email);
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'he-IL', serviceWorkers: 'block' });
      const page = await context.newPage();
      await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.getByLabel('אימייל').fill(credential.email);
      await page.locator('#password').fill(credential.password);
      await Promise.all([
        page.waitForURL((u) => !u.pathname.endsWith('/login'), { timeout: 45000 }),
        page.getByRole('button', { name: 'התחברות' }).click(),
      ]);
      await page.goto(`${baseUrl}/operator`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      out[`operator_as_${email.split('@')[0]}`] = (await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => '')).replace(/\s+/g, ' ').trim();
      await page.screenshot({ path: path.join(__dirname, `smoke-operator-${email.split('@')[0]}.png`) }).catch(() => {});
      await context.close();
    }

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'he-IL', serviceWorkers: 'block' });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/accept-invite?token=not-a-real-token`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);
    out.acceptInvite = { url: page.url(), text: (await page.evaluate(() => document.body.innerText.slice(0, 220))).replace(/\s+/g, ' ').trim() };
    await page.screenshot({ path: path.join(__dirname, 'smoke-accept-invite.png') }).catch(() => {});

    await page.goto(`${baseUrl}/portal#token=not-a-real-token`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3500);
    out.portal = { url: page.url(), text: (await page.evaluate(() => document.body.innerText.slice(0, 220))).replace(/\s+/g, ' ').trim() };
    await page.screenshot({ path: path.join(__dirname, 'smoke-portal.png') }).catch(() => {});
    await context.close();
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(__dirname, 'cutover-boundary-check.json'), `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error('CHECK_FAILED', e.message); process.exit(1); });
