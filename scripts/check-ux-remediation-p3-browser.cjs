const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(path.resolve('node_modules/playwright-core'));
const { installReviewMocks, reviewFixture } = require('./check-ux-remediation-p1-p2a-browser.cjs');

const ROOT = 'D:\\משה פרוייקטים\\פיתוח אתרים\\NIR-APP';
const BASE_URL = process.env.UX_REMEDIATION_BASE_URL || 'http://localhost:5200';
const MANIFEST = 'D:\\משה פרוייקטים\\פיתוח אתרים\\NIR-APP-DOCS\\DEMO-USERS.local.json';
const OUT = path.resolve(ROOT, 'artifacts/ux-remediation-p2b-p10');

function ownerCredentials() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8').replace(/^\uFEFF/, ''));
  const account = manifest.accounts.find((item) => item.email === 'owner@demo.supplyflow.local');
  if (!account) throw new Error('owner demo account missing');
  return account;
}

async function settle(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForLoadState('networkidle', { timeout: 15_000 })
    .catch(() => page.waitForTimeout(750));
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

function p3Fixture(actorId) {
  const fixture = reviewFixture('invoice', actorId);
  fixture.document.supplier_id = null;
  fixture.assessment.state = 'supplier_unresolved';
  fixture.assessment.supplier_resolution = {
    resolved: false,
    supplier_id: null,
    matched_by: null,
    reason: 'no_evidence',
    suggested_name: 'ספק חדש מהמסמך',
    candidates: [],
  };
  fixture.assessment.order_resolution = {
    resolved: false,
    order_id: null,
    matched_by: null,
    reason: 'missing_identifiers',
    candidates: [],
  };
  fixture.assessment.assessment.supplier_id = null;
  fixture.assessment.assessment.order_id = null;
  fixture.suppliers = [
    { id: 'supplier-existing', name: 'ספק קיים' },
    { id: 'supplier-other', name: 'ספק נוסף' },
  ];
  fixture.purchaseOrders = [
    { id: 'order-cancelled', number: 701, status: 'cancelled', currency: 'ILS', items: [{ qty: 2, received_qty: 0 }] },
    { id: 'order-closed', number: 702, status: 'closed', currency: 'ILS', items: [{ qty: 2, received_qty: 1 }] },
    { id: 'order-received', number: 703, status: 'received', currency: 'ILS', items: [{ qty: 2, received_qty: 2 }] },
    { id: 'order-open', number: 704, status: 'sent', currency: 'ILS', items: [{ qty: 2, received_qty: 0 }] },
  ];
  fixture.createdSupplier = { id: 'supplier-created', name: 'ספק חדש מהמסמך' };
  fixture.supplierCreateBodies = [];
  fixture.reviewApplyBodies = [];
  return fixture;
}

async function checkReview(browser, viewportName, viewport) {
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

    const fixture = p3Fixture(actorId);
    await installReviewMocks(page, fixture);
    await page.goto(`${BASE_URL}/documents/${fixture.id}/review`, { waitUntil: 'domcontentloaded' });
    await settle(page);

    const supplier = page.getByRole('combobox', { name: 'הספק' });
    await supplier.waitFor({ timeout: 20_000 });
    assert.equal(await supplier.inputValue(), '');
    await page.getByText(/קריאת המכונה.*ספק חדש מהמסמך/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'אישור המסמך' }).isDisabled(), true);
    await page.screenshot({ path: path.join(OUT, `${viewportName}-supplier-unresolved-p3.png`), fullPage: true });

    await supplier.selectOption('supplier-existing');
    await page.getByText(/נבחר ידנית.*ספק קיים/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'אישור המסמך' }).isEnabled(), true);

    await supplier.selectOption('');
    await page.getByRole('button', { name: 'ספק חדש' }).click();
    const dialog = page.getByRole('dialog', { name: 'ספק חדש' });
    await dialog.waitFor();
    assert.equal(await dialog.getByLabel('שם הספק *').inputValue(), 'ספק חדש מהמסמך');
    assert.equal(await dialog.getByRole('button', { name: 'שמירה' }).isDisabled(), true);
    await page.screenshot({ path: path.join(OUT, `${viewportName}-supplier-confirm-p3.png`), fullPage: true });
    await dialog.getByRole('checkbox', { name: /אני מאשר/ }).check();
    await dialog.getByRole('button', { name: 'שמירה' }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await supplier.inputValue(), 'supplier-created');
    assert.equal(fixture.supplierCreateBodies.length, 1);
    assert.equal(fixture.supplierCreateBodies[0].p_document_id, fixture.id);
    assert.ok(fixture.supplierCreateBodies[0].p_reason);
    assert.ok(fixture.supplierCreateBodies[0].p_idempotency_key);

    const order = page.getByRole('combobox', { name: 'ההזמנה' });
    await order.getByRole('option', { name: /הזמנה 701.*בוטלה/ }).waitFor({ state: 'attached' });
    await order.getByRole('option', { name: /הזמנה 702.*סגורה/ }).waitFor({ state: 'attached' });
    await order.getByRole('option', { name: /הזמנה 703.*סגורה.*התקבלה במלואה/ }).waitFor({ state: 'attached' });
    await order.selectOption('order-cancelled');
    await page.getByRole('alert').filter({ hasText: 'בוטלה' }).waitFor();
    await page.screenshot({ path: path.join(OUT, `${viewportName}-order-warning-p3.png`), fullPage: true });

    await page.getByRole('button', { name: 'אישור המסמך' }).click();
    await page.waitForFunction(() => document.body.innerText.includes('המסמך אושר ונרשם'));
    assert.equal(fixture.reviewApplyBodies.length, 1);
    assert.equal(fixture.reviewApplyBodies[0].p_reviewed.supplier_id, 'supplier-created');
    assert.equal(fixture.reviewApplyBodies[0].p_reviewed.order_id, 'order-cancelled');
    assert.deepEqual(pageErrors, []);

    return {
      supplierCreate: {
        documentId: fixture.supplierCreateBodies[0].p_document_id,
        reasonPresent: Boolean(fixture.supplierCreateBodies[0].p_reason),
        idempotencyPresent: Boolean(fixture.supplierCreateBodies[0].p_idempotency_key),
      },
      approval: {
        supplierId: fixture.reviewApplyBodies[0].p_reviewed.supplier_id,
        orderId: fixture.reviewApplyBodies[0].p_reviewed.order_id,
      },
    };
  } finally {
    await context.close();
  }
}

async function checkFolder(browser, viewportName, viewport) {
  const context = await browser.newContext({ viewport, locale: 'he-IL', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const folderBodies = [];
  try {
    await login(page);
    const now = new Date().toISOString();
    const documents = [
      { id: 'p3-folder-unresolved', org_id: 'org-1', entity_type: 'inbox', entity_id: null,
        storage_path: 'org-1/unresolved.pdf', file_name: 'ספק-לא-מזוהה.pdf', mime_type: 'application/pdf',
        document_kind: 'invoice', supplier_id: null, document_date: '2026-09-05', uploaded_by: null,
        created_at: now, deleted_at: null, deleted_by: null, supplier: null },
      { id: 'p3-folder-ready', org_id: 'org-1', entity_type: 'inbox', entity_id: null,
        storage_path: 'org-1/ready.pdf', file_name: 'מוכן-לבדיקה.pdf', mime_type: 'application/pdf',
        document_kind: 'invoice', supplier_id: 'supplier-existing', document_date: '2026-09-05', uploaded_by: null,
        created_at: now, deleted_at: null, deleted_by: null, supplier: { id: 'supplier-existing', name: 'ספק קיים' } },
    ];
    const jobs = documents.map((document, index) => ({
      id: `p3-folder-job-${index}`, org_id: 'org-1', document_id: document.id,
      status: 'review', attempts: 1, created_at: now, updated_at: now,
      last_error_code: null, queue_age_seconds: 0, is_stuck: false, stuck_reason: null,
    }));
    await page.route('**/rest/v1/**', (route) => {
      const request = route.request();
      const table = new URL(request.url()).pathname.split('/').at(-1);
      if (table === 'documents') return route.fulfill({ json: documents });
      if (table === 'suppliers') return route.fulfill({ json: [] });
      if (table === 'document_auto_actions') return route.fulfill({ json: [] });
      if (table === 'get_document_processing_statuses') return route.fulfill({ json: jobs });
      if (table === 'get_document_folder_review_states') {
        folderBodies.push(request.postDataJSON());
        return route.fulfill({ json: [{
          document_id: 'p3-folder-unresolved',
          state: 'supplier_unresolved',
          suggested_supplier_name: 'ספק מהמסמך',
        }] });
      }
      return route.continue();
    });
    await page.goto(`${BASE_URL}/documents`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    await page.locator('[data-testid="document-processing-status"]:visible')
      .filter({ hasText: 'ספק לא מזוהה' }).waitFor({ timeout: 20_000 });
    assert.equal(folderBodies.length, 1);
    assert.deepEqual(folderBodies[0].p_document_ids.sort(), documents.map((item) => item.id).sort());
    await page.screenshot({ path: path.join(OUT, `${viewportName}-folder-supplier-unresolved-p3.png`), fullPage: true });
    return { batchCalls: folderBodies.length, ids: folderBodies[0].p_document_ids.length };
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
    const viewports = {
      desktop: { width: 1440, height: 900 },
      mobile: { width: 390, height: 844 },
    };
    const evidence = {};
    for (const [name, viewport] of Object.entries(viewports)) {
      evidence[name] = {
        review: await checkReview(browser, name, viewport),
        folder: await checkFolder(browser, name, viewport),
      };
    }
    fs.writeFileSync(path.join(OUT, 'p3-metrics.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  } finally {
    await browser.close();
  }
  process.stdout.write('ux-remediation P3 browser passed\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
