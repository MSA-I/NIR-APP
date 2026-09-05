const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(path.resolve('node_modules/playwright-core'));
const { login, settle } = require('./check-ux-remediation-p1-p2a-browser.cjs');

const BASE_URL = process.env.UX_REMEDIATION_BASE_URL || 'http://localhost:5200';
const OUT = path.resolve('artifacts/ux-remediation-p2b-p10');

function browserPath() {
  return [
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find((candidate) => fs.existsSync(candidate));
}

function resultWithText(text, ids = {}) {
  return {
    run_id: ids.runId ?? '99100000-0000-4000-8000-000000000001',
    conversation_id: ids.conversationId ?? '99100000-0000-4000-8000-000000000002',
    answer: { blocks: [{ type: 'text', text }], next_steps: [], no_answer_reason: null },
    facts: [],
    sources: [],
    tools_used: [],
    complete: true,
    as_of: '2026-09-05T09:00:00+03:00',
    proposal: null,
  };
}

function productHelpResult() {
  return {
    run_id: '99200000-0000-4000-8000-000000000001',
    conversation_id: '99200000-0000-4000-8000-000000000002',
    answer: {
      blocks: [{
        type: 'claim',
        text: 'את הספק משייכים במסך המסמכים לפני אישור המסמך.',
        claim_kind: 'product_help.entry',
        subject: null,
        claim_unit: 'text',
        claim_value: '/documents',
        fact_ids: ['p9-help-fact'],
        source_ids: ['p9-help-source'],
      }],
      next_steps: [],
      no_answer_reason: null,
    },
    facts: [{
      id: 'p9-help-fact',
      kind: 'product_help.entry',
      subject: null,
      label: 'מדריך שימוש — שיוך ספק למסמך שלא זוהה',
      value: '/documents',
      unit: 'text',
      tool: 'get_product_help',
      as_of: '2026-09-05T00:00:00Z',
      classification: 'public_product_metadata',
    }],
    sources: [{
      id: 'p9-help-source',
      entity: 'organization',
      entity_id: 'demo-organization',
      label: 'מסמכים',
      route: '/documents',
      classification: 'public_product_metadata',
    }],
    tools_used: [{ tool: 'get_product_help', complete: true }],
    complete: true,
    as_of: '2026-09-05T09:00:00+03:00',
    proposal: null,
  };
}

async function openPanel(page, desktop) {
  await page.getByRole('button', { name: /העוזר של InPlace/ }).click();
  return page.getByRole(desktop ? 'complementary' : 'dialog', { name: /העוזר של InPlace/ });
}

async function closePanel(page) {
  await page.getByRole('button', { name: 'סגירת הבדיקה' }).click();
  await page.locator('#inplace-assistant-panel').waitFor({ state: 'detached', timeout: 10_000 });
}

async function checkViewport(browser, name, viewport) {
  const desktop = viewport.width >= 1024;
  const context = await browser.newContext({ viewport, locale: 'he-IL', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  let supplierCount = 0;
  let askMode = 'basic';
  let failedOnce = false;
  let historyMode = 'none';
  let storedFeedback = null;
  const feedbackBodies = [];
  try {
    await page.route('**/rest/v1/suppliers**', async (route) => {
      const request = route.request();
      if (request.method() !== 'HEAD') return route.continue();
      return route.fulfill({
        status: 200,
        headers: {
          'content-range': `*/${supplierCount}`,
          'access-control-expose-headers': 'Content-Range',
        },
        body: '',
      });
    });
    await page.route('**/rest/v1/rpc/assistant_record_feedback', (route) => {
      const body = route.request().postDataJSON();
      feedbackBodies.push(body);
      storedFeedback = {
        rating: body.p_helpful ? 'helpful' : 'not_helpful',
        note: body.p_note,
      };
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ feedback_id: '99300000-0000-4000-8000-000000000001' }),
      });
    });
    await page.route('**/rest/v1/assistant_feedback**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/vnd.pgrst.object+json',
      body: JSON.stringify(storedFeedback),
    }));
    await page.route('**/functions/v1/assistant', (route) => {
      const body = route.request().postDataJSON();
      if (body?.operation === 'history_list') {
        if (historyMode === 'none') return route.fulfill({ json: { conversations: [] } });
        const age = historyMode === 'fresh' ? 5 * 60 * 1000 : 10 * 60 * 1000 + 1;
        return route.fulfill({ json: { conversations: [{
          id: '99400000-0000-4000-8000-000000000001',
          title: 'שיחה שמורה',
          updated_at: new Date(Date.now() - age).toISOString(),
        }] } });
      }
      if (body?.operation === 'history_load') {
        return route.fulfill({ json: {
          turns: [{
            question: 'מה נשמר?',
            result: resultWithText('שיחה טרייה שוחזרה.', {
              runId: '99400000-0000-4000-8000-000000000002',
              conversationId: body.conversation_id,
            }),
          }],
        } });
      }
      if (askMode === 'fail-once' && !failedOnce) {
        failedOnce = true;
        return route.fulfill({
          status: 504,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'assistant_provider_timeout' } }),
        });
      }
      return route.fulfill({ json: askMode === 'help'
        ? productHelpResult()
        : resultWithText('הבדיקה הצליחה בלי רענון הדף.') });
    });

    await login(page);
    await page.goto(`${BASE_URL}/documents`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    let panel = await openPanel(page, desktop);
    await panel.waitFor({ timeout: 15_000 });

    // P9d: the card remains, but decorative glass and light bodies do not.
    const visual = await panel.evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        mode: element.getAttribute('data-assistant-mode'),
        backdropFilter: style.backdropFilter || style.webkitBackdropFilter || '',
        width: rect.width,
        viewportWidth: innerWidth,
        decorativeBodies: element.querySelectorAll('.assistant-gradient,.assistant-mote').length,
        text: element.textContent ?? '',
      };
    });
    assert.equal(visual.decorativeBodies, 0);
    assert.ok(visual.backdropFilter === '' || visual.backdropFilter === 'none');
    assert.equal(/בינה מלאכותית|\bAI\b/.test(visual.text), false, 'AI disclosure was added');
    assert.equal(visual.mode, desktop ? 'docked' : 'fullscreen');
    assert.equal(desktop ? visual.width < visual.viewportWidth : visual.width === visual.viewportWidth, true);

    // No suppliers is the same first-run oracle the dashboard uses: usage questions, not figures.
    await panel.getByRole('button', { name: 'איך מתחילים לעבוד במערכת?' }).waitFor({ timeout: 10_000 });
    assert.equal(await panel.getByRole('button', { name: 'מה דורש טיפול עכשיו?' }).count(), 0);
    await page.screenshot({ path: path.join(OUT, `${name}-p9-usage-suggestions.png`), fullPage: true });

    // A failed suggestion returns intact to the composer and succeeds from the same page.
    askMode = 'fail-once';
    failedOnce = false;
    const navigationCount = await page.evaluate(() => performance.getEntriesByType('navigation').length);
    await panel.getByRole('button', { name: 'איך מתחילים לעבוד במערכת?' }).click();
    await panel.getByText(/העוזר לא השיב בזמן/).waitFor({ timeout: 15_000 });
    const composer = panel.getByLabel('שאלה לבדיקה');
    assert.equal(await composer.inputValue(), 'איך מתחילים לעבוד במערכת?');
    assert.equal(await panel.getByRole('button', { name: 'בדיקה חדשה' }).count(), 1);
    await page.screenshot({ path: path.join(OUT, `${name}-p9-suggestion-recovery.png`), fullPage: true });
    await panel.getByRole('button', { name: 'בדיקה', exact: true }).click();
    await panel.getByText('הבדיקה הצליחה בלי רענון הדף.').waitFor({ timeout: 15_000 });
    assert.equal(await page.evaluate(() => performance.getEntriesByType('navigation').length), navigationCount);

    // P9c: note is written and only the DB readback is shown as confirmation.
    await panel.getByRole('button', { name: 'לא מועיל' }).click();
    await panel.getByRole('textbox', { name: 'הערה למשוב' }).fill('הסבר חסר על מקור הנתון');
    await panel.getByRole('button', { name: 'שמירת משוב' }).click();
    await panel.getByText('הסבר חסר על מקור הנתון').waitFor({ timeout: 10_000 });
    assert.deepEqual(feedbackBodies, [{
      p_run_id: '99100000-0000-4000-8000-000000000001',
      p_helpful: false,
      p_note: 'הסבר חסר על מקור הנתון',
    }]);
    await page.screenshot({ path: path.join(OUT, `${name}-p9-feedback-readback.png`), fullPage: true });

    await closePanel(page);
    supplierCount = 5;
    askMode = 'help';
    historyMode = 'none';
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page);
    panel = await openPanel(page, desktop);
    await panel.getByRole('button', { name: 'מה דורש טיפול עכשיו?' }).waitFor({ timeout: 10_000 });
    assert.equal(await panel.getByRole('button', { name: 'איך מתחילים לעבוד במערכת?' }).count(), 0);
    await page.screenshot({ path: path.join(OUT, `${name}-p9-data-suggestions.png`), fullPage: true });

    await panel.getByLabel('שאלה לבדיקה').fill('המסמך לא מצא ספק, מה עושים?');
    await panel.getByRole('button', { name: 'בדיקה', exact: true }).click();
    const source = panel.getByRole('link', { name: /מסמכים/ });
    await source.waitFor({ timeout: 15_000 });
    assert.equal(new URL(await source.getAttribute('href'), BASE_URL).pathname, '/documents');
    assert.equal(await panel.getByText(/מדריך שימוש — שיוך ספק למסמך/).count(), 1);
    assert.equal(await panel.getByText(/עודכן ב־/).count(), 1);
    await page.screenshot({ path: path.join(OUT, `${name}-p9-product-help-link.png`), fullPage: true });

    // Fresh history opens itself; stale history remains available only through its explicit row.
    historyMode = 'fresh';
    askMode = 'basic';
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page);
    panel = await openPanel(page, desktop);
    await panel.getByText('שיחה טרייה שוחזרה.').waitFor({ timeout: 15_000 });
    await page.screenshot({ path: path.join(OUT, `${name}-p9-fresh-history.png`), fullPage: true });

    historyMode = 'stale';
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page);
    panel = await openPanel(page, desktop);
    await panel.getByRole('button', { name: /פתיחת הבדיקה שיחה שמורה/ }).waitFor({ timeout: 15_000 });
    assert.equal(await panel.getByText('שיחה טרייה שוחזרה.').count(), 0);
    assert.equal(await panel.getByRole('button', { name: 'מה דורש טיפול עכשיו?' }).count(), 1);
    await page.screenshot({ path: path.join(OUT, `${name}-p9-stale-history.png`), fullPage: true });

    assert.deepEqual(pageErrors, []);
    return { visual, navigationCount, feedbackBodies, helpLink: '/documents' };
  } finally {
    await context.close();
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const executablePath = browserPath();
  if (!executablePath) throw new Error('supported browser missing');
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const evidence = {
      desktop: await checkViewport(browser, 'desktop', { width: 1440, height: 900 }),
      mobile: await checkViewport(browser, 'mobile', { width: 390, height: 844 }),
    };
    fs.writeFileSync(path.join(OUT, 'p9-metrics.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  } finally {
    await browser.close();
  }
  process.stdout.write('ux-remediation P9 browser passed\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
