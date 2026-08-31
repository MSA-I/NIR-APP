/**
 * The plan badge and the plan names around it, read back in English.
 *
 * `#303` left this open: plan names and entitlement labels live in the database in Hebrew, so an
 * English screen read `The פרימיום plan…` and `Move to חינם`. The owner decided on 31.08.2026 that
 * an English interface names them in English. This reads the rendered text rather than the
 * dictionary, so it measures what a reader actually sees.
 */
const { chromium } = require('playwright-core');
const CHROME = 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:5291';
const HEBREW = /[\u0590-\u05FF]/;

async function settle(page) {
  for (let i = 0; i < 45; i += 1) {
    const len = await page.evaluate(() => document.body.innerText.length).catch(() => 0);
    const busy = await page.locator('.animate-spin').count().catch(() => 0);
    if (len > 120 && busy === 0) { await page.waitForTimeout(1000); return; }
    await page.waitForTimeout(400);
  }
}

async function signIn(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await settle(page);
  await page.locator('summary').first().click();
  await page.getByRole('button', { name: /owner|manager|בעלים|מנהל/i }).first().click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 45000 });
  await settle(page);
}

async function setLocale(page, locale) {
  await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
  await settle(page);
  await page.waitForSelector('#settings-ui-locale', { timeout: 60000 });
  await page.selectOption('#settings-ui-locale', locale);
  await page.waitForFunction((l) => document.documentElement.lang === l, locale, { timeout: 15000 });
}

/** Every string the reader sees on this screen that still carries a Hebrew letter. */
async function hebrewOnScreen(page) {
  return page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const found = new Set();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? '').trim();
      if (text && /[\u0590-\u05FF]/.test(text)) found.add(text.replace(/\s+/g, ' '));
    }
    return [...found];
  });
}

(async () => {
  const browser = await chromium.launch({ headless: false, executablePath: CHROME });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'en-US', reducedMotion: 'reduce' });
  await context.addInitScript(() => { try { window.localStorage.setItem('inplace.locale', 'en'); } catch { /* private */ } });
  const page = await context.newPage();

  await signIn(page);
  await setLocale(page, 'en');

  for (const [name, route] of [['subscription', '/settings/subscription'], ['pricing', '/pricing'], ['dashboard', '/dashboard']]) {
    await page.goto(BASE + route, { waitUntil: 'domcontentloaded' });
    await settle(page);
    await page.screenshot({ path: `artifacts/i18n-audit-20260830/stage11/shots/${name}-en.png`, fullPage: true });
    const hebrew = await hebrewOnScreen(page);
    console.log(`${name.padEnd(13)} ${hebrew.length} Hebrew string(s)`);
    for (const line of hebrew.slice(0, 14)) console.log('    ' + line);
  }

  // The badge itself, on the phone where it is worn, and its accessible name.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US', reducedMotion: 'reduce' });
  await phone.addInitScript(() => { try { window.localStorage.setItem('inplace.locale', 'en'); } catch { /* private */ } });
  const small = await phone.newPage();
  await signIn(small);
  await small.goto(BASE + '/dashboard', { waitUntil: 'domcontentloaded' });
  await settle(small);
  await small.screenshot({ path: 'artifacts/i18n-audit-20260830/stage11/shots/badge-390-en.png' });
  const badge = small.locator('[data-testid="plan-badge"]').first();
  if (await badge.count()) {
    const chip = (await badge.locator('[data-testid="plan-badge-chip"]').innerText()).trim();
    const aria = await badge.getAttribute('aria-label');
    console.log(`badge chip="${chip}" hebrew=${HEBREW.test(chip)}  aria="${aria}" hebrew=${HEBREW.test(aria ?? '')}`);
  } else {
    console.log('badge NOT PRESENT on this viewport');
  }

  await setLocale(page, 'he');
  await page.goto(BASE + '/settings/subscription', { waitUntil: 'domcontentloaded' });
  await settle(page);
  await page.screenshot({ path: 'artifacts/i18n-audit-20260830/stage11/shots/subscription-he.png', fullPage: true });
  await setLocale(page, 'en');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
