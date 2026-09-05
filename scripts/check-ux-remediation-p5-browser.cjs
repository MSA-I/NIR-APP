const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(path.resolve('node_modules/playwright-core'));
const { installReviewMocks, login, reviewFixture, settle } = require('./check-ux-remediation-p1-p2a-browser.cjs');

const BASE_URL = process.env.UX_REMEDIATION_BASE_URL || 'http://localhost:5200';
const OUT = path.resolve('artifacts/ux-remediation-p2b-p10');

const STAGES = [
  ['queued', 'queued', 'ממתין לתחילת הקריאה'],
  ['awaiting_scan', 'scan', 'ממתין לאישור הסריקה'],
  ['leased', 'reading', 'קריאת המסמך'],
  ['extracted', 'preparing', 'הקריאה הסתיימה'],
  ['interpreting', 'interpreting', 'פירוש הנתונים'],
];

async function processingStates(browser, name, viewport) {
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
    fixture.job.progress_done = null;
    fixture.job.progress_total = null;
    await installReviewMocks(page, fixture);
    const seen = [];
    for (const [status, step, wording] of STAGES) {
      fixture.job.status = status;
      fixture.job.is_stuck = false;
      fixture.job.stuck_reason = null;
      await page.goto(`${BASE_URL}/documents/${fixture.id}/review`, { waitUntil: 'domcontentloaded' });
      await settle(page);
      const progress = page.getByTestId('document-processing-progress');
      await progress.waitFor({ timeout: 20_000 });
      assert.equal(await progress.getAttribute('data-step'), step);
      const text = await progress.innerText();
      assert.ok(text.includes(wording), `${status} did not name its real stage: ${text}`);
      assert.equal(text.includes('תור'), false, `${status} leaked queue vocabulary`);
      seen.push(step);
      await page.screenshot({ path: path.join(OUT, `${name}-progress-${step}-p5.png`), fullPage: true });
    }
    assert.deepEqual(seen, ['queued', 'scan', 'reading', 'preparing', 'interpreting']);
    return seen;
  } finally {
    await context.close();
  }
}

async function compactList(browser, name, viewport) {
  const context = await browser.newContext({ viewport, locale: 'he-IL', reducedMotion: 'reduce' });
  const page = await context.newPage();
  try {
    await login(page);
    const now = new Date().toISOString();
    const documents = [
      { id: 'p5-invoice', org_id: 'org-1', entity_type: 'invoice', entity_id: 'invoice-1',
        storage_path: 'org-1/invoice.pdf', file_name: 'משויך-לחשבונית.pdf', mime_type: 'application/pdf',
        document_kind: 'invoice', supplier_id: null, document_date: '2026-09-05', uploaded_by: null,
        created_at: now, deleted_at: null, deleted_by: null, supplier: null },
      { id: 'p5-receipt', org_id: 'org-1', entity_type: 'goods_receipt', entity_id: 'receipt-1',
        storage_path: 'org-1/receipt.pdf', file_name: 'משויך-לקבלה.pdf', mime_type: 'application/pdf',
        document_kind: 'delivery_note', supplier_id: null, document_date: '2026-09-05', uploaded_by: null,
        created_at: now, deleted_at: null, deleted_by: null, supplier: null },
      { id: 'p5-superseded', org_id: 'org-1', entity_type: 'inbox', entity_id: null,
        storage_path: 'org-1/old.pdf', file_name: 'ניסיון-ישן.pdf', mime_type: 'application/pdf',
        document_kind: 'invoice', supplier_id: null, document_date: '2026-09-05', uploaded_by: null,
        created_at: now, deleted_at: null, deleted_by: null, supplier: null },
    ];
    const jobs = documents.map((document, index) => ({
      id: `p5-job-${index}`, org_id: 'org-1', document_id: document.id,
      status: index < 2 ? 'completed' : 'failed', attempts: 1,
      last_error_code: index < 2 ? null : 'superseded_for_reprocess',
      created_at: now, updated_at: now, queue_age_seconds: 0,
      is_stuck: false, stuck_reason: null,
    }));
    await page.route('**/rest/v1/**', (route) => {
      const table = new URL(route.request().url()).pathname.split('/').at(-1);
      if (table === 'documents') return route.fulfill({ json: documents });
      if (table === 'suppliers' || table === 'document_auto_actions') return route.fulfill({ json: [] });
      if (table === 'get_document_processing_statuses') return route.fulfill({ json: jobs });
      if (table === 'get_document_folder_review_states') return route.fulfill({ json: [] });
      return route.continue();
    });
    await page.goto(`${BASE_URL}/documents`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    await page.getByText('משויך-לחשבונית.pdf').filter({ visible: true }).waitFor({ timeout: 20_000 });
    const visibleBadges = page.locator('[data-testid="document-processing-status"]:visible');
    assert.equal(await visibleBadges.count(), 2);
    assert.deepEqual(await visibleBadges.allInnerTexts(), ['משויך', 'משויך']);
    assert.equal((await page.locator('body').innerText()).includes('שויך לחשבונית'), false);
    assert.equal((await page.locator('body').innerText()).includes('הוחלף בניסיון חדש'), false);
    await page.screenshot({ path: path.join(OUT, `${name}-compact-list-statuses-p5.png`), fullPage: true });
    return { visibleBadges: 2, labels: ['assigned', 'assigned'], supersededBadge: false };
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
    const viewports = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };
    const evidence = {};
    for (const [name, viewport] of Object.entries(viewports)) {
      evidence[name] = {
        progressStates: await processingStates(browser, name, viewport),
        list: await compactList(browser, name, viewport),
      };
    }
    fs.writeFileSync(path.join(OUT, 'p5-metrics.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  } finally {
    await browser.close();
  }
  process.stdout.write('ux-remediation P5 browser passed\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
