// Headed capture. Memory: headless Chrome 151 misses injected CSS, so every visual claim in this
// branch is measured against a headed browser.
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync } from 'node:fs';

// The bundled Playwright chromium on this machine will not start — "side-by-side configuration is
// incorrect", a broken VC++ runtime inside that install. Real Chrome is used instead.
const EXECUTABLE = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const OUT = process.argv[2];
// Read from a file, not argv: PowerShell strips quotes when passing a JSON literal to a native exe.
const SHOTS = JSON.parse(readFileSync(process.argv[3], 'utf8'));

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: EXECUTABLE, headless: false });
const results = [];

for (const shot of SHOTS) {
  const context = await browser.newContext({
    viewport: { width: shot.width ?? 1440, height: shot.height ?? 1000 },
    locale: shot.locale ?? 'he-IL',
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  const bad = [];
  page.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });

  await page.goto(shot.url, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {});
  if (shot.waitFor) await page.waitForSelector(shot.waitFor, { timeout: 20_000 }).catch(() => {});
  if (shot.settleMs) await page.waitForTimeout(shot.settleMs);

  const measured = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
    stored: (() => { try { return localStorage.getItem('inplace.locale'); } catch { return 'unavailable'; } })(),
  }));

  const file = `${OUT}/${shot.name}.png`;
  await page.screenshot({ path: file, fullPage: shot.fullPage ?? false });
  results.push({ name: shot.name, url: shot.url, ...measured, consoleErrors: consoleErrors.slice(0, 5), bad: bad.slice(0, 5) });
  await context.close();
}

await browser.close();
console.log(JSON.stringify(results, null, 2));
