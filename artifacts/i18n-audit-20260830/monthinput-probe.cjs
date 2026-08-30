/**
 * `<input type="month">` renders a month NAME. `<input type="date">` renders digits.
 *
 * The earlier probe (DATE-PICKER.md) tested `type="date"` and concluded "the widget ignores the
 * page language". That is true, and it hid a difference that matters: a date input shows
 * `01/08/2026` in every language, so nothing about it reads as Hebrew — while a MONTH input shows
 * `אוגוסט 2026`, which does. The owner was pointing at the second, and the first probe never
 * looked at it.
 */
const { chromium } = require('playwright-core');
const CHROME = 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe';

const PAGE = (lang) => `<!doctype html><html lang="${lang}"><body style="font:16px sans-serif">
  <input id="m" type="month" value="2026-08">
  <input id="d" type="date" value="2026-08-01">
</body></html>`;

(async () => {
  const browser = await chromium.launch({ headless: false, executablePath: CHROME });
  for (const locale of ['en-US', 'he-IL', 'de-DE']) {
    const context = await browser.newContext({ locale });
    const page = await context.newPage();
    await page.setContent(PAGE('en'));
    await page.screenshot({ path: `artifacts/i18n-audit-20260830/monthinput-${locale}.png`, clip: { x: 0, y: 0, width: 420, height: 40 } });
    console.log('context=' + locale.padEnd(6) + '  page lang=en  → see monthinput-' + locale + '.png');
    await context.close();
  }
  await browser.close();
  console.log('compare the three: if the month input differs, its language is the browser UI, not the page');
})().catch((e) => { console.error(e); process.exit(1); });
