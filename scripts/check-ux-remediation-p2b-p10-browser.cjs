const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(path.resolve('node_modules/playwright-core'));
const {
  installReviewMocks,
  metrics: reviewMetrics,
  reviewFixture,
} = require('./check-ux-remediation-p1-p2a-browser.cjs');

const ROOT = 'D:\\משה פרוייקטים\\פיתוח אתרים\\NIR-APP';
const BASE_URL = process.env.UX_REMEDIATION_BASE_URL || 'http://localhost:5200';
const MANIFEST = 'D:\\משה פרוייקטים\\פיתוח אתרים\\NIR-APP-DOCS\\DEMO-USERS.local.json';
const OUT = path.resolve(ROOT, 'artifacts/ux-remediation-p2b-p10');

function ownerCredentials() {
  const payload = JSON.parse(fs.readFileSync(MANIFEST, 'utf8').replace(/^\uFEFF/, ''));
  const account = payload.accounts.find((item) => item.email === 'owner@demo.supplyflow.local');
  if (!account) throw new Error('owner demo account missing');
  return account;
}

async function settle(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => page.waitForTimeout(750));
}

async function login(page) {
  const account = ownerCredentials();
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
  await settle(page);
  if (!page.url().includes('/login')) return;
  await page.locator('input[type="email"]').fill(account.email);
  await page.locator('input[type="password"]').fill(account.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 20_000 });
  await settle(page);
}

async function visibleControlCount(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    return [...document.querySelectorAll('button,a,input,select,textarea,summary')].filter(visible).length;
  });
}

async function checkViewport(browser, name, viewport, baselineControls) {
  const context = await browser.newContext({ viewport, locale: 'he-IL', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    await login(page);
    await page.goto(`${BASE_URL}/inbox`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    const redirected = new URL(page.url());
    assert.equal(redirected.pathname, '/documents');
    assert.equal(redirected.searchParams.get('processing'), 'unassigned');
    assert.equal(redirected.searchParams.has('filing'), false);
    const processing = page.getByTestId('documents-processing-filter');
    await processing.waitFor({ timeout: 20_000 });
    assert.equal(await processing.inputValue(), 'unassigned');
    assert.equal(await page.getByLabel('סטטוס תיוק').count(), 0);

    const controls = await visibleControlCount(page);
    assert.ok(controls < baselineControls, `documents controls did not fall (${baselineControls} -> ${controls})`);
    fs.mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: path.join(OUT, `${name}-documents-p2b.png`), fullPage: true });

    await page.getByRole('button', { name: 'העלאת מסמך' }).click();
    const dialog = page.getByRole('dialog', { name: 'העלאת מסמך' });
    const limit = dialog.getByText(/10MB/);
    await limit.waitFor();
    const order = await dialog.evaluate((element) => {
      const limitElement = [...element.querySelectorAll('*')].find((candidate) => candidate.textContent?.includes('10MB'));
      const input = element.querySelector('input[type="file"]');
      return limitElement && input ? Boolean(limitElement.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING) : false;
    });
    assert.equal(order, true, '10MB limit is not before the file input');
    await page.screenshot({ path: path.join(OUT, `${name}-upload-limit-p2b.png`), fullPage: true });

    const actorId = await page.evaluate(() => {
      for (const value of Object.values(localStorage)) {
        try {
          const parsed = JSON.parse(value);
          if (parsed?.user?.id) return parsed.user.id;
        } catch { /* not a JSON session entry */ }
      }
      return null;
    });
    assert.ok(actorId, 'authenticated actor id missing');
    const fixture = reviewFixture('invoice', actorId);
    await installReviewMocks(page, fixture);
    await page.goto(`${BASE_URL}/documents/${fixture.id}/review`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    await page.getByTestId('document-static-status').waitFor({ timeout: 20_000 });
    assert.equal(await page.getByRole('heading', { name: 'מצב המסמך' }).count(), 0);
    const review = await reviewMetrics(page);
    const baselinePath = path.resolve(
      ROOT,
      `artifacts/ux-remediation-p1-p2a-20260904/after/${name}-metrics.json`,
    );
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')).invoiceReview;
    assert.ok(review.panels < baseline.panels, `review panels did not fall (${baseline.panels} -> ${review.panels})`);
    assert.ok(review.textBlocks < baseline.textBlocks, `review text did not fall (${baseline.textBlocks} -> ${review.textBlocks})`);
    await page.screenshot({ path: path.join(OUT, `${name}-review-status-p2b.png`), fullPage: true });
    assert.deepEqual(pageErrors, []);
    return {
      controls,
      baselineControls,
      redirected: redirected.pathname + redirected.search,
      reviewPanels: { before: baseline.panels, after: review.panels },
      reviewTextBlocks: { before: baseline.textBlocks, after: review.textBlocks },
    };
  } finally {
    await context.close();
  }
}

async function main() {
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
      desktop: await checkViewport(browser, 'desktop', { width: 1440, height: 900 }, 24),
      mobile: await checkViewport(browser, 'mobile', { width: 390, height: 844 }, 21),
    };
    fs.writeFileSync(path.join(OUT, 'p2b-metrics.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  } finally {
    await browser.close();
  }
  process.stdout.write('ux-remediation-p2b-p10 browser passed\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
