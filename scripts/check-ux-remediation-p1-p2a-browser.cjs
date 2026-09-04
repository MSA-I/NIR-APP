const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(path.resolve('node_modules/playwright-core'));

const ROOT = 'D:\\משה פרוייקטים\\פיתוח אתרים\\NIR-APP';
const MANIFEST = 'D:\\משה פרוייקטים\\פיתוח אתרים\\NIR-APP-DOCS\\DEMO-USERS.local.json';
const BASE_URL = process.env.UX_REMEDIATION_BASE_URL || 'http://localhost:5200';
const API_URL = process.env.UX_REMEDIATION_API_URL || 'http://127.0.0.1:55431';

function parseArgs() {
  const values = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, args) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), args[index + 1]]);
    return pairs;
  }, []));
  if (!['desktop', 'mobile'].includes(values.viewport) || !values['evidence-dir']) {
    throw new Error('usage: node check-ux-remediation-p1-p2a-browser.cjs --viewport desktop|mobile --evidence-dir <path>');
  }
  return { viewport: values.viewport, evidenceDir: values['evidence-dir'] };
}

function envValue(name) {
  const files = ['.env.local', '.env'];
  for (const file of files) {
    const fullPath = path.resolve(ROOT, file);
    if (!fs.existsSync(fullPath)) continue;
    const line = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/)
      .find((candidate) => candidate.trim().startsWith(`${name}=`));
    if (!line) continue;
    return line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  throw new Error(`${name} missing from local environment`);
}

async function accessToken(page) {
  return page.evaluate(() => {
    for (const value of Object.values(localStorage)) {
      try {
        const parsed = JSON.parse(value);
        if (parsed?.access_token) return parsed.access_token;
      } catch { /* not a JSON session entry */ }
    }
    return null;
  });
}

async function retireTestDocument(page, documentId) {
  if (!documentId) return;
  const token = await accessToken(page);
  assert.ok(token, 'authenticated access token missing during cleanup');
  const response = await fetch(`${API_URL}/rest/v1/rpc/remove_document`, {
    method: 'POST',
    headers: {
      apikey: envValue('VITE_SUPABASE_ANON_KEY'),
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      p_document_id: documentId,
      p_mode: 'document_only',
      p_reason: 'ניקוי מסמך בדיקת UX מקומית',
    }),
  });
  assert.ok(response.ok, `test document cleanup failed (${response.status})`);
}

async function retireStaleTestDocuments(page) {
  const token = await accessToken(page);
  assert.ok(token, 'authenticated access token missing during stale-fixture cleanup');
  const headers = {
    apikey: envValue('VITE_SUPABASE_ANON_KEY'),
    authorization: `Bearer ${token}`,
  };
  const query = new URL(`${API_URL}/rest/v1/documents`);
  query.searchParams.set('select', 'id,file_name');
  query.searchParams.set('file_name', 'like.ux-remediation-%.pdf');
  query.searchParams.set('deleted_at', 'is.null');
  const response = await fetch(query, { headers });
  assert.ok(response.ok, `stale test document lookup failed (${response.status})`);
  const rows = await response.json();
  for (const row of rows) {
    if (typeof row.id === 'string' && /^ux-remediation-(desktop|mobile)\.pdf$/.test(row.file_name ?? '')) {
      await retireTestDocument(page, row.id);
    }
  }
}

function ownerCredentials() {
  const payload = JSON.parse(fs.readFileSync(MANIFEST, 'utf8').replace(/^\uFEFF/, ''));
  const account = payload.accounts.find((item) => item.email === 'owner@demo.supplyflow.local');
  if (!account) throw new Error('owner demo account missing');
  return account;
}

async function settle(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => page.waitForTimeout(1_000));
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

async function metrics(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const count = (selector) => [...document.querySelectorAll(selector)].filter(visible).length;
    const textBlocks = [...document.querySelectorAll('h1,h2,h3,h4,p,li,dt,dd,label,summary,[role="status"],[role="alert"]')]
      .filter((element) => visible(element) && (element.innerText || '').trim().length > 0).length;
    return {
      controls: count('button,a,input,select,textarea,summary'),
      panels: count('.card,.subpanel,.note,[role="dialog"],[role="region"]'),
      textBlocks,
      documentRows: count('[data-document-id]'),
      progressTelemetry: count('[data-document-status-progress],[data-document-status-age]'),
      viewport: { width: innerWidth, height: innerHeight },
      bodyHeight: document.documentElement.scrollHeight,
    };
  });
}

function reviewFixture(kind, actorId) {
  const id = kind === 'invoice' ? 'ux-mock-invoice' : 'ux-mock-price-list';
  const jobId = `${id}-job`;
  const interpretationId = `${id}-interpretation`;
  const now = new Date().toISOString();
  const document = {
    id, org_id: 'org-1', unit_id: null, entity_type: 'inbox', entity_id: null,
    storage_path: `org-1/${id}.png`, file_name: `${id}.png`, mime_type: 'image/png',
    document_kind: kind === 'invoice' ? 'invoice' : 'price_list', uploaded_by: actorId,
    supplier_id: kind === 'invoice' ? 'supplier-1' : null, document_date: '2026-09-04',
    deleted_at: null, deleted_by: null, created_at: now,
  };
  const job = {
    id: jobId, org_id: 'org-1', document_id: id, requested_by: 'owner-1',
    status: kind === 'invoice' ? 'review' : 'completed', input_checksum: 'etag:ux-fixture',
    contract_version: '1', priority: 0, attempts: 1, max_attempts: 3,
    next_attempt_at: null, leased_at: null, lease_expires_at: null, leased_by: null,
    started_at: now, finished_at: kind === 'invoice' ? null : now,
    last_error_code: null, last_error_message: null, resource_metadata: {},
    created_at: now, updated_at: now, queue_age_seconds: 0, is_stuck: false, stuck_reason: null,
  };
  const extraction = {
    id: `${id}-extraction`, org_id: 'org-1', document_id: id, job_id: jobId,
    engine: 'fixture', model: 'fixture', model_version: '1', input_checksum: 'etag:ux-fixture',
    contract_version: '1', created_at: now,
    payload: {
      schema_version: '1',
      document: { page_count: 1, detected_languages: ['heb'], plain_text: 'מסמך בדיקה', partial: false },
      blocks: [{ id: 'block-1', page: 1, type: 'text', bbox: [0, 0.2, 1, 0.3], text: 'מסמך בדיקה', confidence: 0.99 }],
      tables: [], marks: [],
    },
  };
  const interpretation = {
    id: interpretationId, org_id: 'org-1', document_id: id, job_id: jobId,
    provider: 'fixture', model: 'fixture', prompt_version: '1', schema_version: '1',
    suggested_supplier_id: kind === 'invoice' ? 'supplier-1' : null, created_at: now,
    payload: {
      schema_version: '1', document_type: kind === 'invoice' ? 'invoice' : 'price_list',
      document_type_confidence: 0.99,
      supplier: { suggested_id: kind === 'invoice' ? 'supplier-1' : null, suggested_name: 'ספק בדיקה', confidence: 0.99, evidence_block_ids: ['block-1'] },
      fields: [], line_items: [], suggested_annotations: [],
    },
  };
  const assessment = {
    document_id: id, file_name: document.file_name, document_kind: 'invoice', document_type: 'invoice',
    document_date: '2026-09-04', file_stored: true, data_approved: false,
    interpretation_id: interpretationId, supplier_resolution: null, order_resolution: null,
    credit_resolution: null, state: 'ready_for_approval',
    assessment: {
      document_type: 'invoice', currency: 'ILS', document_number: 'UX-1', document_date: '2026-09-04',
      supplier_id: 'supplier-1', order_id: null,
      sources: { document: true, ordered: false, received: false, baseline: false },
      totals: {
        lines_net: 100, lines_discount: 0, header_net: 100, header_vat: 18,
        header_total: 118, computed_total: 118, unexplained_gap: 0, lines_vs_header_gap: 0,
        overcharge_total: 0, line_tolerance: 0.05, document_tolerance: 1,
        currency: 'ILS', missing_rungs: [],
      },
      severity: 'info', approval_blocked: false, lines: [], order_items: [], findings: [],
    },
  };
  return { id, document, job, extraction, interpretation, assessment };
}

async function installReviewMocks(page, fixture) {
  const emptyTables = new Set([
    'document_annotations', 'document_rule_applications', 'document_review_corrections',
    'document_type_review_decisions', 'document_filings', 'price_list_interpretation_decisions',
    'price_list_interpretation_lines', 'price_list_shadow_lines', 'document_feedback',
    'document_exports', 'document_export_templates', 'document_packets',
    'document_learning_rules', 'document_export_template_versions',
    'document_packet_segments', 'products', 'suppliers',
  ]);
  await page.route('**/rest/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const table = url.pathname.split('/').at(-1);
    if (table === 'get_document_processing_statuses') return route.fulfill({ json: [fixture.job] });
    if (table === 'get_document_scan_states') return route.fulfill({ json: [] });
    if (table === 'get_document_review_assessment') return route.fulfill({ json: fixture.assessment });
    if (table === 'documents') return route.fulfill({ json: [fixture.document] });
    if (table === 'document_processing_jobs') return route.fulfill({ json: [fixture.job] });
    if (table === 'document_extractions') return route.fulfill({ json: [fixture.extraction] });
    if (table === 'document_interpretations') return route.fulfill({ json: [fixture.interpretation] });
    if (table === 'supplier_price_submissions') {
      return route.fulfill({ json: {
        id: fixture.interpretation.id, revision: 2, accepted_count: 12,
        rejected_count: 1, unchanged_count: 3,
      } });
    }
    if (emptyTables.has(table)) return route.fulfill({ json: [] });
    return route.continue();
  });
  await page.route('**/storage/v1/object/sign/documents/**', (route) => route.fulfill({
    json: { signedURL: '/storage/v1/object/sign/documents/ux-fixture?token=fixture' },
  }));
  await page.route('**/storage/v1/object/sign/documents/ux-fixture?token=fixture', (route) => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z6JkAAAAASUVORK5CYII=', 'base64'),
  }));
}

function assistantResult() {
  return {
    run_id: '11111111-1111-4111-8111-111111111111',
    conversation_id: '22222222-2222-4222-8222-222222222222',
    answer: {
      blocks: [{
        type: 'claim', text: 'היתרה הפתוחה לספק גבוהה מהרגיל.', claim_kind: 'supplier.balance',
        subject: { entity: 'supplier', id: 'supplier-1' }, claim_unit: 'ils', claim_value: 1650.6,
        fact_ids: ['f1'], source_ids: ['s1'],
      }],
      next_steps: [], no_answer_reason: null,
    },
    facts: [{
      id: 'f1', kind: 'supplier.balance', subject: { entity: 'supplier', id: 'supplier-1' },
      label: 'יתרה פתוחה לספק', value: 1650.6, unit: 'ils', tool: 'supplier_balances',
      as_of: '2026-09-04T09:00:00+03:00', classification: 'financial_sensitive',
    }],
    sources: [{
      id: 's1', entity: 'supplier', entity_id: 'supplier-1', label: 'ספק בדיקה',
      route: '/suppliers/supplier-1', classification: 'tenant_standard',
    }],
    tools_used: [{ tool: 'get_open_credits', complete: true }],
    complete: true, as_of: '2026-09-04T09:00:00+03:00', proposal: null,
  };
}

async function exerciseInboxUpload(page, evidence, viewport) {
  await retireStaleTestDocuments(page);
  const registrationBodies = [];
  const registrationResponses = [];
  let tusPosts = 0;
  await page.route('**/storage/v1/upload/resumable**', async (route) => {
    if (route.request().method() === 'POST') tusPosts += 1;
    return route.continue();
  });
  await page.route('**/rest/v1/rpc/begin_document_intake', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ processing_job_id: crypto.randomUUID() }),
  }));
  await page.route('**/rest/v1/rpc/register_uploaded_document', async (route) => {
    registrationBodies.push(route.request().postDataJSON());
    const response = await route.fetch();
    if (!response.ok()) {
      const errorBody = (await response.text()).slice(0, 500);
      throw new Error(`register_uploaded_document failed (${response.status()}): ${errorBody}`);
    }
    const data = await response.json();
    registrationResponses.push(data);
    if (registrationBodies.length % 2 === 1) {
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'gateway timeout' }),
      });
    }
    return route.fulfill({ response });
  });

  await page.goto(`${BASE_URL}/documents`, { waitUntil: 'domcontentloaded' });
  await settle(page);
  await page.getByRole('button', { name: 'העלאת מסמך' }).click();
  const dialog = page.getByRole('dialog', { name: 'העלאת מסמך' });
  await dialog.waitFor();
  const date = dialog.locator('input[type="date"]');
  assert.equal(await date.inputValue(), '', 'untouched optional document date must start empty');
  await dialog.locator('input[type="file"]').setInputFiles({
    name: `ux-remediation-${viewport}.pdf`,
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n% UX remediation fixture\n%%EOF\n'),
  });
  await dialog.getByRole('button', { name: 'העלאה', exact: true }).click();
  const failure = page.getByText(/הקובץ נשמר בבטחה, אך הרישום לא הושלם בגלל תקלה זמנית/).first();
  await failure.waitFor({ timeout: 20_000 });
  assert.equal((await page.locator('body').innerText()).includes('document_registration_transient'), false,
    'internal upload code leaked into visible text');
  await page.screenshot({ path: path.join(evidence, `${viewport}-upload-retry.png`), fullPage: true });
  await dialog.getByRole('button', { name: 'ניסיון חוזר לנכשלים בלבד' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 20_000 });

  assert.equal(tusPosts, 1, 'the original file was uploaded more than once');
  assert.equal(registrationBodies.length, 2, 'registration was not retried exactly once');
  assert.equal(registrationBodies[0].p_client_upload_key, registrationBodies[1].p_client_upload_key,
    'retry changed the client upload key');
  assert.equal(registrationBodies[0].p_storage_path, registrationBodies[1].p_storage_path,
    'retry changed the stored path');
  assert.equal(registrationBodies[0].p_document_date, null,
    'untouched optional date was not sent as null');
  const firstId = registrationResponses[0]?.document_id ?? registrationResponses[0];
  const secondId = registrationResponses[1]?.document_id ?? registrationResponses[1];
  assert.equal(secondId, firstId, 'idempotent registration returned a duplicate document');
  await retireTestDocument(page, firstId);

  let quickCapture = null;
  if (viewport === 'mobile') {
    await page.goto(`${BASE_URL}/documents`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    const captureInput = page.locator('input[data-document-upload-input][capture="environment"]').last();
    await captureInput.setInputFiles({
      name: 'ux-remediation-mobile.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n% UX retry action fixture\n%%EOF\n'),
    });
    const retryAction = page.getByRole('button', { name: 'ניסיון חוזר להעלאת 1 מסמכים' });
    await retryAction.waitFor({ timeout: 20_000 });
    assert.equal((await retryAction.innerText()).trim(), 'ניסיון חוזר (1)',
      'retry action is not visible text');
    assert.equal(await retryAction.locator('.lucide-rotate-ccw').count(), 1, 'retry action kept the camera icon');
    assert.equal(await retryAction.locator('.lucide-camera').count(), 0, 'camera icon remains on retry action');
    await page.screenshot({ path: path.join(evidence, 'mobile-quick-capture-retry.png'), fullPage: true });
    await retryAction.click();
    await page.waitForURL(/\/documents\/[^/]+\/review/, { timeout: 20_000 });
    assert.equal(tusPosts, 2, 'quick-capture retry uploaded the original bytes again');
    assert.equal(registrationBodies.length, 4, 'quick capture did not retry registration exactly once');
    assert.equal(registrationBodies[2].p_client_upload_key, registrationBodies[3].p_client_upload_key,
      'quick-capture retry changed the client upload key');
    const quickFirstId = registrationResponses[2]?.document_id ?? registrationResponses[2];
    const quickSecondId = registrationResponses[3]?.document_id ?? registrationResponses[3];
    assert.equal(quickSecondId, quickFirstId, 'quick-capture retry created a duplicate document');
    await retireTestDocument(page, quickFirstId);
    quickCapture = { tusPosts: 1, registrationCalls: 2, visibleRetry: true };
  }
  await page.unroute('**/rest/v1/rpc/register_uploaded_document');
  await page.unroute('**/rest/v1/rpc/begin_document_intake');
  await page.unroute('**/storage/v1/upload/resumable**');
  return {
    tusPosts: viewport === 'mobile' ? 1 : tusPosts,
    registrationCalls: 2,
    documentDate: registrationBodies[0].p_document_date,
    quickCapture,
  };
}

async function installStatusListMocks(page) {
  const now = new Date().toISOString();
  const documents = [
    {
      id: '33333333-3333-4333-8333-333333333333', org_id: 'org-1', entity_type: 'inbox', entity_id: null,
      storage_path: 'org-1/queued.pdf', file_name: 'ממתין.pdf', mime_type: 'application/pdf',
      document_kind: 'other', supplier_id: null, document_date: null, uploaded_by: null,
      created_at: now, deleted_at: null, deleted_by: null, supplier: null,
    },
    {
      id: '44444444-4444-4444-8444-444444444444', org_id: 'org-1', entity_type: 'inbox', entity_id: null,
      storage_path: 'org-1/stuck.pdf', file_name: 'תקוע.pdf', mime_type: 'application/pdf',
      document_kind: 'other', supplier_id: null, document_date: null, uploaded_by: null,
      created_at: now, deleted_at: null, deleted_by: null, supplier: null,
    },
  ];
  const jobs = documents.map((document, index) => ({
    id: `55555555-5555-4555-8555-55555555555${index}`, org_id: 'org-1', document_id: document.id,
    requested_by: null, status: 'queued', input_checksum: 'etag:status-fixture', contract_version: '1',
    priority: 0, attempts: index + 1, max_attempts: 3, next_attempt_at: null,
    leased_at: null, lease_expires_at: null, leased_by: null, started_at: null, finished_at: null,
    last_error_code: null, last_error_message: null, resource_metadata: {}, progress_done: 4,
    progress_total: 12, progress_stage: 'ocr', created_at: now, updated_at: now,
    queue_age_seconds: index === 0 ? 60 : 7_200, is_stuck: index === 1,
    stuck_reason: index === 1 ? 'queue_age' : null,
  }));
  await page.route('**/rest/v1/documents?**', (route) => route.fulfill({ json: documents }));
  await page.route('**/rest/v1/suppliers?**', (route) => route.fulfill({ json: [] }));
  await page.route('**/rest/v1/document_auto_actions?**', (route) => route.fulfill({ json: [] }));
  await page.route('**/rest/v1/rpc/get_document_processing_statuses**', (route) => route.fulfill({ json: jobs }));
}

async function main() {
  const args = parseArgs();
  const size = args.viewport === 'desktop' ? { width: 1440, height: 900 } : { width: 390, height: 844 };
  const evidence = path.resolve(ROOT, args.evidenceDir);
  fs.mkdirSync(evidence, { recursive: true });
  const browserPaths = [
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const executablePath = browserPaths.find((candidate) => fs.existsSync(candidate));
  if (!executablePath) throw new Error('supported browser missing');

  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const context = await browser.newContext({ viewport: size, locale: 'he-IL' });
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await login(page);

    await page.goto(`${BASE_URL}/documents`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    await page.locator('[data-testid="documents-page"]').waitFor({ timeout: 20_000 });
    const result = { documents: await metrics(page) };
    await page.getByText('איתור כל מסמך שנקלט למערכת ושיוכו לרשומה העסקית שלו.').waitFor();
    assert.equal(await page.getByText('כל החשבוניות, תעודות המשלוח, הזיכויים והמסמכים הנוספים במקום אחד.').count(), 0,
      'duplicate documents-page meta remains visible');
    await page.screenshot({ path: path.join(evidence, `${args.viewport}-documents.png`), fullPage: true });

    await page.goto(`${BASE_URL}/inbox?filing=unfiled`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    await page.locator('[data-testid="documents-page"]').waitFor({ timeout: 20_000 });
    result.inboxRedirect = {
      url: page.url(),
      metrics: await metrics(page),
      rowIds: await page.locator('[data-document-id]').evaluateAll((elements) =>
        [...new Set(elements.map((element) => element.getAttribute('data-document-id')).filter(Boolean))]),
    };
    assert.equal(new URL(result.inboxRedirect.url).pathname, '/documents', 'legacy inbox route did not reach documents');
    assert.equal(new URL(result.inboxRedirect.url).searchParams.get('filing'), 'unfiled', 'legacy inbox filter was lost');

    result.uploadRecovery = await exerciseInboxUpload(page, evidence, args.viewport);

    const actorId = await page.evaluate(() => {
      for (const value of Object.values(localStorage)) {
        try {
          const parsed = JSON.parse(value);
          if (parsed?.user?.id) return parsed.user.id;
        } catch { /* not a JSON session entry */ }
      }
      return null;
    });
    if (!actorId) throw new Error('authenticated actor id missing');

    await installStatusListMocks(page);
    await page.goto(`${BASE_URL}/documents`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    try {
      await page.locator('.badge-alert:visible', { hasText: 'עיבוד תקוע' }).first().waitFor({ timeout: 20_000 });
    } catch (error) {
      await page.screenshot({ path: path.join(evidence, `${args.viewport}-status-debug.png`), fullPage: true });
      fs.writeFileSync(path.join(evidence, `${args.viewport}-status-debug.txt`), await page.locator('body').innerText(), 'utf8');
      throw error;
    }
    assert.equal(await page.locator('[data-document-status-progress],[data-document-status-age]').count(), 0,
      'row-level processing telemetry remains visible');
    result.statusList = await metrics(page);
    await page.screenshot({ path: path.join(evidence, `${args.viewport}-status-list.png`), fullPage: true });
    await page.unroute('**/rest/v1/documents?**');
    await page.unroute('**/rest/v1/suppliers?**');
    await page.unroute('**/rest/v1/document_auto_actions?**');
    await page.unroute('**/rest/v1/rpc/get_document_processing_statuses**');

    const invoice = reviewFixture('invoice', actorId);
    await installReviewMocks(page, invoice);
    await page.goto(`${BASE_URL}/documents/${invoice.id}/review`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    await page.getByRole('button', { name: 'אישור המסמך' }).waitFor({ timeout: 20_000 });
    assert.equal(await page.getByText('מה ישולם בפועל').count(), 0, 'empty payable card remains visible');
    result.invoiceReview = await metrics(page);
    await page.screenshot({ path: path.join(evidence, `${args.viewport}-invoice-review.png`), fullPage: true });
    await page.unroute('**/rest/v1/**');

    const priceList = reviewFixture('price-list', actorId);
    await installReviewMocks(page, priceList);
    await page.goto(`${BASE_URL}/documents/${priceList.id}/review`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    const receiptHeading = page.getByRole('heading', { name: 'קבלת קליטת מחירון' });
    await receiptHeading.waitFor({ timeout: 20_000 });
    const receiptCard = receiptHeading.locator('..');
    const receiptText = await receiptCard.innerText();
    assert.equal(receiptText.includes('גרסה:'), false, 'receipt revision remains visible');
    assert.equal(receiptText.includes('בקשה חוזרת — ללא כפילות'), false, 'receipt idempotency badge remains visible');
    assert.equal(receiptText.includes('נקלטה הגשה חדשה'), false, 'receipt submission badge remains visible');
    assert.match(receiptText, /שורות שהתקבלו/);
    assert.match(receiptText, /שורות שנדחו/);
    assert.match(receiptText, /שורות ללא שינוי/);
    result.priceListReview = await metrics(page);
    await page.screenshot({ path: path.join(evidence, `${args.viewport}-price-list-receipt.png`), fullPage: true });
    await page.unroute('**/rest/v1/**');

    await page.route('**/functions/v1/assistant', (route) => {
      const body = route.request().postDataJSON();
      if (body?.operation === 'history_list') return route.fulfill({ json: { conversations: [] } });
      if (body?.operation === 'history_load') return route.fulfill({ json: { conversation_id: body.conversation_id, turns: [] } });
      return route.fulfill({ json: assistantResult() });
    });
    await page.goto(`${BASE_URL}/documents`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    await page.getByRole('button', { name: /העוזר של InPlace/ }).click();
    await page.getByLabel('שאלה לבדיקה').fill('מה דורש טיפול?');
    await page.getByRole('button', { name: 'בדיקה', exact: true }).click();
    const scopeTitle = page.getByText('היקף הבדיקה');
    await scopeTitle.waitFor({ timeout: 20_000 });
    const scopeSummary = scopeTitle.locator('xpath=ancestor::summary');
    assert.equal(await scopeSummary.locator('.badge-idle').count(), 0, 'scope count badge remains visible');
    await scopeSummary.click();
    await page.getByText('זיכויים פתוחים').waitFor();
    result.assistant = await metrics(page);
    await page.screenshot({ path: path.join(evidence, `${args.viewport}-assistant-scope.png`), fullPage: true });
    result.consoleErrorCount = consoleErrors.length;
    result.pageErrorCount = pageErrors.length;
    assert.equal(pageErrors.some((message) => /Invalid hook call/i.test(message)), false, 'invalid React hook call reached browser');

    const beforePath = path.resolve(evidence, '..', 'before', `${args.viewport}-metrics.json`);
    assert.ok(fs.existsSync(beforePath), `baseline metrics missing: ${beforePath}`);
    const before = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
    assert.ok(result.invoiceReview.panels < before.invoiceReview.panels,
      `invoice panels did not decrease (${before.invoiceReview.panels} -> ${result.invoiceReview.panels})`);
    assert.ok(result.invoiceReview.textBlocks < before.invoiceReview.textBlocks,
      `invoice text blocks did not decrease (${before.invoiceReview.textBlocks} -> ${result.invoiceReview.textBlocks})`);
    assert.ok(result.priceListReview.textBlocks < before.priceListReview.textBlocks,
      `price-list text blocks did not decrease (${before.priceListReview.textBlocks} -> ${result.priceListReview.textBlocks})`);
    for (const surface of ['documents', 'invoiceReview', 'priceListReview', 'assistant']) {
      assert.ok(result[surface].controls <= before[surface].controls,
        `${surface} controls increased (${before[surface].controls} -> ${result[surface].controls})`);
      assert.ok(result[surface].panels <= before[surface].panels,
        `${surface} panels increased (${before[surface].panels} -> ${result[surface].panels})`);
    }
    fs.writeFileSync(
      path.join(evidence, `${args.viewport}-metrics.json`),
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8',
    );
  } finally {
    await browser.close();
  }
  process.stdout.write(`ux-remediation-p1-p2a browser ${args.viewport} passed\n`);
}

module.exports = { installReviewMocks, metrics, reviewFixture, settle };

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
