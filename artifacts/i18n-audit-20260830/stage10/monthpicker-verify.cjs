const { chromium } = require('playwright-core');
const CHROME = 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:5290';

async function settle(page) {
  for (let i = 0; i < 40; i += 1) {
    const len = await page.evaluate(() => document.body.innerText.length).catch(() => 0);
    const busy = await page.locator('.animate-spin').count().catch(() => 0);
    if (len > 120 && busy === 0) { await page.waitForTimeout(900); return; }
    await page.waitForTimeout(400);
  }
}

(async () => {
  const browser = await chromium.launch({ headless: false, executablePath: CHROME });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', reducedMotion: 'reduce' });
  await context.addInitScript(() => { try { window.localStorage.setItem('inplace.locale', 'en'); } catch { /* private */ } });
  const page = await context.newPage();

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await settle(page);
  await page.locator('summary').first().click();
  await page.getByRole('button', { name: /owner|manager|בעלים|מנהל/i }).first().click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 45000 });
  await settle(page);
  if (await page.evaluate(() => document.documentElement.lang) !== 'en') {
    await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    await page.selectOption('#settings-ui-locale', 'en');
    await page.waitForFunction(() => document.documentElement.lang === 'en', null, { timeout: 15000 });
  }

  for (const [name, route] of [['reports', '/reports'], ['invoices', '/invoices'], ['credits', '/credits'], ['bank', '/bank']]) {
    await page.goto(BASE + route, { waitUntil: 'domcontentloaded' });
    await settle(page);
    await page.screenshot({ path: `artifacts/i18n-audit-20260830/stage10/shots/${name}.png`, fullPage: false });
    const selects = await page.locator('select').evaluateAll((els) => els.map((e) => e.options[e.selectedIndex]?.text ?? ''));
    console.log(name.padEnd(10) + ' selects: ' + JSON.stringify(selects.slice(0, 6)));
  }
  // The same control in Hebrew: if it did not follow the interface language it would be no better
  // than the native input it replaced.
  await page.goto(BASE + '/settings', { waitUntil: 'domcontentloaded' });
  await settle(page);
  await page.waitForSelector('#settings-ui-locale', { timeout: 60000 });
  await page.selectOption('#settings-ui-locale', 'he');
  await page.waitForFunction(() => document.documentElement.lang === 'he', null, { timeout: 15000 });
  for (const [name, route] of [['reports-he', '/reports'], ['invoices-he', '/invoices']]) {
    await page.goto(BASE + route, { waitUntil: 'domcontentloaded' });
    await settle(page);
    await page.screenshot({ path: `artifacts/i18n-audit-20260830/stage10/shots/${name}.png` });
    const selects = await page.locator('select').evaluateAll((els) => els.map((e) => e.options[e.selectedIndex]?.text ?? ''));
    console.log(name.padEnd(12) + ' selects: ' + JSON.stringify(selects.slice(0, 6)));
  }
  // Leave the fixture as it was found. The control only exists on /settings, and the loop above
  // left the page elsewhere.
  await page.goto(BASE + '/settings', { waitUntil: 'domcontentloaded' });
  await settle(page);
  await page.waitForSelector('#settings-ui-locale', { timeout: 60000 });
  await page.selectOption('#settings-ui-locale', 'en');
  await page.waitForFunction(() => document.documentElement.lang === 'en', null, { timeout: 15000 });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
