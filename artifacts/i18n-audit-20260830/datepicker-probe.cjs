/**
 * What decides the language of the DATE PICKER?
 *
 * The product has no date-picker component: 23 `<input type="date">` / `type="month"` and nothing
 * else, so the calendar that drops down is drawn by the browser. Three candidates could decide its
 * language — the page's `lang`, the browser context's locale, or Chrome's own UI language — and
 * only the first would be ours to change. This varies each one and reads back the format Chrome
 * renders the VALUE in, which is drawn from the same setting as the calendar.
 */
const { chromium } = require('playwright-core');
const CHROME = 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe';

const PAGE = (lang) => `<!doctype html><html lang="${lang}"><body>
  <input id="d" type="date" value="2026-08-01">
</body></html>`;

(async () => {
  const browser = await chromium.launch({ headless: false, executablePath: CHROME });
  for (const locale of ['en-US', 'he-IL', 'de-DE']) {
    const context = await browser.newContext({ locale });
    const page = await context.newPage();
    for (const lang of ['en', 'he']) {
      await page.setContent(PAGE(lang));
      // The shadow field Chrome draws the value into; its order is the locale's date order.
      const shown = await page.evaluate(() => {
        const el = document.getElementById('d');
        el.focus();
        return { value: el.value, nav: navigator.language, htmlLang: document.documentElement.lang };
      });
      console.log('context=' + locale.padEnd(6) + ' html lang=' + lang
        + '  navigator.language=' + shown.nav.padEnd(6) + '  value=' + shown.value);
      await page.screenshot({ path: `artifacts/i18n-audit-20260830/datepicker-${locale}-${lang}.png`, clip: { x: 0, y: 0, width: 320, height: 60 } });
    }
    await context.close();
  }
  await browser.close();
  console.log('one screenshot per combination written — the rendered order is what to compare');
})().catch((e) => { console.error(e); process.exit(1); });
