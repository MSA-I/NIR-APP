const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(path.resolve('node_modules/playwright-core'));
const {
  installReviewMocks,
  login,
  reviewFixture,
  settle,
} = require('./check-ux-remediation-p1-p2a-browser.cjs');

const BASE_URL = process.env.UX_REMEDIATION_BASE_URL || 'http://localhost:5200';
const OUT = path.resolve('artifacts/ux-remediation-p2b-p10');

function feedbackFixture(actorId) {
  const fixture = reviewFixture('invoice', actorId);
  fixture.annotations = [{
    id: 'annotation-hidden', org_id: 'org-1', document_id: fixture.id,
    interpretation_id: fixture.interpretation.id, extraction_id: fixture.extraction.id,
    target_kind: 'mark', target_id: 'mark-hidden', tag_key: 'supplier_name',
    label: 'Training control must stay hidden', source: 'rule', active: true,
    rule_id: 'rule-hidden', rule_version: 3, confidence: 0.8,
    created_by: actorId, created_at: new Date().toISOString(),
  }];
  fixture.ruleApplications = [{
    id: 'application-hidden', org_id: 'org-1', document_id: fixture.id,
    interpretation_id: fixture.interpretation.id, extraction_id: fixture.extraction.id,
    rule_id: 'rule-hidden', rule_version: 3, applied_for_user_id: actorId,
    target_kind: 'mark', target_id: 'mark-hidden', confidence: 0.8,
    annotation_id: 'annotation-hidden', created_at: new Date().toISOString(),
  }];
  fixture.learningRules = [{
    id: 'rule-hidden', org_id: 'org-1', family_id: 'rule-family', version: 3,
    user_id: null, document_type: 'invoice', supplier_id: null, mark_kind: 'circle',
    mark_fingerprint: null, tag_key: 'supplier_name', label: 'Training rule must stay hidden',
    active: true, created_by: actorId, created_at: new Date().toISOString(),
  }];
  fixture.annotationFeedback = [];
  fixture.documentReviewFeedback = [];
  fixture.documentFeedbackBodies = [];
  return fixture;
}

async function checkViewport(browser, name, viewport) {
  const context = await browser.newContext({ viewport, locale: 'he-IL', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
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
    const fixture = feedbackFixture(actorId);
    await installReviewMocks(page, fixture);
    await page.goto(`${BASE_URL}/documents/${fixture.id}/review`, { waitUntil: 'domcontentloaded' });
    await settle(page);

    const feedback = page.getByRole('button', { name: 'זה לא נכון' });
    await feedback.waitFor({ timeout: 20_000 });
    assert.equal(await feedback.count(), 1);
    assert.equal(await page.getByText('הערות והחלטות').count(), 0);
    assert.equal(await page.getByText('כללים שהופעלו').count(), 0);
    assert.equal(await page.getByText('Training control must stay hidden').count(), 0);
    assert.equal(await page.getByText('Training rule must stay hidden').count(), 0);
    await page.screenshot({ path: path.join(OUT, `${name}-document-feedback-rest-p4.png`), fullPage: true });

    await feedback.click();
    const note = page.getByRole('textbox', { name: 'מה לא נכון במסמך?' });
    await note.fill('סכום המע״מ לא נכון');
    await page.screenshot({ path: path.join(OUT, `${name}-document-feedback-form-p4.png`), fullPage: true });
    await page.getByRole('button', { name: 'שמירת המשוב' }).click();
    await page.getByText('סכום המע״מ לא נכון').waitFor({ timeout: 20_000 });
    assert.equal(fixture.documentFeedbackBodies.length, 1);
    const body = fixture.documentFeedbackBodies[0];
    assert.equal(body.p_document_id, fixture.id);
    assert.equal(body.p_interpretation_id, fixture.interpretation.id);
    assert.equal(body.p_note, 'סכום המע״מ לא נכון');
    assert.equal(body.p_reason, body.p_note);
    assert.ok(body.p_idempotency_key);
    await page.screenshot({ path: path.join(OUT, `${name}-document-feedback-recorded-p4.png`), fullPage: true });
    assert.deepEqual(pageErrors, []);
    return { controlsAtRest: 1, noteReread: true, reasonPresent: Boolean(body.p_reason) };
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
    fs.writeFileSync(path.join(OUT, 'p4-metrics.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  } finally {
    await browser.close();
  }
  process.stdout.write('ux-remediation P4 browser passed\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
