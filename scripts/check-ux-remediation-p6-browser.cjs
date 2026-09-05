const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(path.resolve('node_modules/playwright-core'));
const { installReviewMocks, login, reviewFixture, settle } = require('./check-ux-remediation-p1-p2a-browser.cjs');

const BASE_URL = process.env.UX_REMEDIATION_BASE_URL || 'http://localhost:5200';
const OUT = path.resolve('artifacts/ux-remediation-p2b-p10');

async function checkViewport(browser, name, viewport) {
  const context = await browser.newContext({ viewport, locale: 'he-IL', reducedMotion: 'reduce' });
  const page = await context.newPage();
  try {
    await login(page);
    const actorId = await page.evaluate(() => {
      for (const value of Object.values(localStorage)) {
        try {
          const parsed = JSON.parse(value);
          if (parsed?.user?.id) return parsed.user.id;
        } catch { /* not a session entry */ }
      }
      return null;
    });
    assert.ok(actorId, 'authenticated actor id missing');
    const fixture = reviewFixture('invoice', actorId);
    fixture.documentReviewFeedback = [];
    await installReviewMocks(page, fixture);
    await page.goto(`${BASE_URL}/documents/${fixture.id}/review`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    await page.getByTestId('document-source-viewer').waitFor({ timeout: 20_000 });

    const measurements = await page.evaluate(() => {
      const source = document.querySelector('[data-testid="document-source-viewer"]');
      const approval = [...document.querySelectorAll('button')]
        .find((button) => button.textContent?.trim() === 'אישור המסמך');
      const decision = document.querySelector('[data-testid="primary-decision"]');
      const reconciliation = document.querySelector('[data-testid="reconciliation-fold"]');
      const sourceRect = source?.getBoundingClientRect();
      const approvalRect = approval?.getBoundingClientRect();
      return {
        sourceY: sourceRect ? sourceRect.top + scrollY : null,
        sourceBottom: sourceRect ? sourceRect.bottom + scrollY : null,
        approvalY: approvalRect ? approvalRect.top + scrollY : null,
        bodyHeight: document.documentElement.scrollHeight,
        screenRatio: document.documentElement.scrollHeight / innerHeight,
        decisionBackground: decision ? getComputedStyle(decision).backgroundColor : '',
        reconciliationFolded: reconciliation instanceof HTMLDetailsElement && !reconciliation.open,
        storedSentences: [...document.querySelectorAll('p')]
          .filter((node) => node.textContent?.includes('הקובץ נשמר באחסון הפרטי')).length,
        approvalSentences: [...document.querySelectorAll('p')]
          .filter((node) => node.textContent?.includes('הנתונים עדיין לא אושרו')).length,
      };
    });
    assert.notEqual(measurements.sourceY, null);
    assert.notEqual(measurements.approvalY, null);
    assert.equal(measurements.reconciliationFolded, true);
    assert.equal(measurements.storedSentences, 1);
    assert.equal(measurements.approvalSentences, 1);
    assert.notEqual(measurements.decisionBackground, 'rgba(0, 0, 0, 0)');
    if (name === 'mobile') {
      assert.ok(measurements.sourceY < 1200, `mobile source starts at ${measurements.sourceY}`);
      assert.ok(measurements.approvalY > measurements.sourceBottom,
        `approval ${measurements.approvalY} does not follow source ${measurements.sourceBottom}`);
      assert.ok(measurements.screenRatio <= 3, `mobile page is ${measurements.screenRatio.toFixed(2)} screens`);
    } else {
      assert.ok(measurements.screenRatio <= 2.5, `desktop page is ${measurements.screenRatio.toFixed(2)} screens`);
    }
    await page.screenshot({ path: path.join(OUT, `${name}-review-layout-p6.png`), fullPage: true });
    return measurements;
  } finally {
    await context.close();
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const candidates = [
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const executablePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executablePath) throw new Error('supported browser missing');
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const evidence = {
      desktop: await checkViewport(browser, 'desktop', { width: 1440, height: 900 }),
      mobile: await checkViewport(browser, 'mobile', { width: 390, height: 844 }),
    };
    fs.writeFileSync(path.join(OUT, 'p6-metrics.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  } finally {
    await browser.close();
  }
  process.stdout.write('ux-remediation P6 browser passed\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
