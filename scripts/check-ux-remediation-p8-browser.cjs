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
const API_URL = 'http://127.0.0.1:55431';
const OUT = path.resolve('artifacts/ux-remediation-p2b-p10');

function browserPath() {
  return [
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find((candidate) => fs.existsSync(candidate));
}

function failedScan(documentId, jobId, scanId, code) {
  return {
    document_id: documentId,
    scan_job_id: scanId,
    processing_job_id: jobId,
    status: 'failed',
    requested_mode: 'auto',
    manual_corners: null,
    last_error_code: code,
    last_error_message: null,
    output_id: null,
    output_storage_path: null,
    output_mode: null,
    detected_corners: null,
    corners_source: null,
    rotation_degrees: null,
    accepted: false,
    updated_at: '2026-09-05T09:00:00Z',
  };
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
        } catch { /* not a Supabase session */ }
      }
      return null;
    });
    assert.ok(actorId, 'authenticated actor id missing');

    const fixture = reviewFixture('invoice', actorId);
    const idPrefix = name === 'desktop' ? '88000000' : '89000000';
    fixture.id = `${idPrefix}-0000-4000-8000-000000000101`;
    fixture.document.id = fixture.id;
    fixture.document.file_name = `p8-${name}-failed.pdf`;
    fixture.document.storage_path = `org-1/${fixture.id}.pdf`;
    fixture.job.id = `${idPrefix}-0000-4000-8000-000000000301`;
    fixture.job.document_id = fixture.id;
    fixture.job.status = 'failed';
    fixture.job.last_error_code = 'processing_timeout';
    fixture.job.last_error_message = 'fixture failure';
    const replacementId = `${idPrefix}-0000-4000-8000-000000000102`;
    const replacementDocument = {
      ...fixture.document,
      id: replacementId,
      file_name: `p8-${name}-replacement.pdf`,
      storage_path: `org-1/${replacementId}.pdf`,
      deleted_at: null,
      deleted_by: null,
    };
    const replacementJob = {
      ...fixture.job,
      id: `${idPrefix}-0000-4000-8000-000000000302`,
      document_id: replacementId,
      status: 'queued',
      last_error_code: null,
      last_error_message: null,
    };
    let scan = failedScan(
      fixture.id,
      fixture.job.id,
      `${idPrefix}-0000-4000-8000-000000000401`,
      'processing_timeout',
    );
    let superseded = false;
    const registrationBodies = [];
    const supersedeBodies = [];
    let tusPosts = 0;

    await installReviewMocks(page, fixture);
    // Registered after the shared broad mock: Playwright gives the most recent matching route
    // first refusal, so these P8 states remain local to this proof.
    await page.route('**/rest/v1/rpc/get_document_scan_states', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(superseded ? [] : [scan]),
    }));
    await page.route('**/rest/v1/rpc/get_document_processing_statuses', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([superseded ? replacementJob : fixture.job]),
    }));
    await page.route('**/rest/v1/rpc/get_document_folder_review_states', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: '[]',
    }));
    await page.route('**/rest/v1/documents**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([superseded ? replacementDocument : fixture.document]),
    }));
    await page.route('**/rest/v1/document_processing_jobs**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([superseded ? replacementJob : fixture.job]),
    }));
    await page.route('**/storage/v1/upload/resumable**', (route) => {
      const method = route.request().method();
      const common = {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST,HEAD,PATCH,OPTIONS',
        'access-control-allow-headers': '*',
        'access-control-expose-headers': 'Location,Upload-Offset,Tus-Resumable',
        'tus-resumable': '1.0.0',
      };
      if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: common });
      if (method === 'POST') {
        tusPosts += 1;
        return route.fulfill({
          status: 201,
          headers: {
            ...common,
            location: `${API_URL}/storage/v1/upload/resumable/${replacementId}`,
            'upload-offset': String(route.request().postDataBuffer()?.length ?? 0),
          },
        });
      }
      if (method === 'HEAD') return route.fulfill({
        status: 200, headers: { ...common, 'upload-offset': '8', 'upload-length': '8' },
      });
      return route.fulfill({ status: 204, headers: { ...common, 'upload-offset': '8' } });
    });
    await page.route('**/rest/v1/rpc/register_uploaded_document', (route) => {
      registrationBodies.push(route.request().postDataJSON());
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ document_id: replacementId, idempotent: false }),
      });
    });
    await page.route('**/rest/v1/rpc/begin_document_intake', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ processing_job_id: replacementJob.id }),
    }));
    await page.route('**/rest/v1/rpc/supersede_failed_document', (route) => {
      supersedeBodies.push(route.request().postDataJSON());
      superseded = true;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          failed_document_id: fixture.id,
          replacement_document_id: replacementId,
          idempotent: false,
          original_file_retained: true,
        }),
      });
    });

    const cases = [
      ['corrupt_document', 'replace'],
      ['decompressed_size_limit', 'replace'],
      ['file_size_limit', 'replace'],
      ['processing_resource_failure', 'retry'],
      ['processing_timeout', 'retry'],
      ['scan_image_too_small', 'replace'],
      ['claim_attempt_limit_exceeded', 'retry'],
      ['document_deleted', 'none'],
      ['unknown_from_worker', 'none'],
    ];
    const observed = [];
    for (const [code, expected] of cases) {
      scan = { ...scan, last_error_code: code };
      await page.goto(`${BASE_URL}/documents/${fixture.id}/review`, { waitUntil: 'domcontentloaded' });
      await settle(page);
      const card = page.getByTestId('document-scan-preview');
      try {
        await card.waitFor({ timeout: 20_000 });
      } catch (error) {
        throw new Error(`${code}: scan card missing at ${page.url()} — ${(await page.locator('body').innerText()).slice(0, 800)}`, { cause: error });
      }
      assert.equal(await card.getByRole('button', { name: /פינה .* אחוזים/ }).count(), 0, `${code}: corner editor rendered`);
      assert.equal(await card.getByText('קרא כמו שהוא').count(), 0, `${code}: unsafe full-frame action rendered`);
      const retryCount = await card.getByRole('button', { name: 'ניסיון נוסף' }).count();
      const replaceCount = await card.locator('input[type="file"]').count();
      const noActionCount = await card.getByText(/אין פעולת שחזור בטוחה/).count();
      assert.equal(retryCount + replaceCount + noActionCount, 1, `${code}: not exactly one recovery outcome`);
      assert.equal(retryCount === 1 ? 'retry' : replaceCount === 1 ? 'replace' : 'none', expected, `${code}: wrong recovery`);
      observed.push({ code, action: expected });
      if (code === 'processing_timeout' || code === 'corrupt_document' || code === 'unknown_from_worker') {
        await page.screenshot({ path: path.join(OUT, `${name}-p8-${expected}.png`), fullPage: true });
      }
    }

    scan = { ...scan, last_error_code: 'corrupt_document' };
    await page.goto(`${BASE_URL}/documents/${fixture.id}/review`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    await page.getByTestId('document-scan-preview').locator('input[type="file"]').setInputFiles({
      name: `p8-${name}-replacement.pdf`,
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n% P8 replacement\n%%EOF\n'),
    });
    await page.waitForURL(`${BASE_URL}/documents/${replacementId}/review`, { timeout: 20_000 });
    await settle(page);
    assert.equal(tusPosts, 1, 'replacement source uploaded more than once');
    assert.equal(registrationBodies.length, 1, 'replacement registered more than once');
    assert.equal(supersedeBodies.length, 1, 'supersede command did not run exactly once');
    assert.deepEqual(supersedeBodies[0], {
      p_failed_document_id: fixture.id,
      p_replacement_document_id: replacementId,
      p_idempotency_key: supersedeBodies[0].p_idempotency_key,
      p_reason: 'החלפת מסמך שסריקתו נכשלה',
    });
    assert.match(supersedeBodies[0].p_idempotency_key, /^[0-9a-f-]{36}$/i);
    await page.screenshot({ path: path.join(OUT, `${name}-p8-replacement-opened.png`), fullPage: true });

    await page.goto(`${BASE_URL}/documents`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    assert.equal((await page.locator('body').innerText()).includes(fixture.document.file_name), false,
      'superseded document remained in the active list');
    await page.screenshot({ path: path.join(OUT, `${name}-p8-old-hidden.png`), fullPage: true });
    assert.deepEqual(pageErrors, []);
    return { observed, tusPosts, registrationCount: registrationBodies.length, supersedeBodies };
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
    fs.writeFileSync(path.join(OUT, 'p8-metrics.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  } finally {
    await browser.close();
  }
  process.stdout.write('ux-remediation P8 browser passed\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
