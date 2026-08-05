import path from 'node:path';
import {
  expect,
  test,
  type Browser,
  type Locator,
  type Page,
  type Request,
  type TestInfo,
} from '@playwright/test';
import { storageStatePath } from '../auth/storage-state.ts';
import { ConsoleMonitor } from '../browser/console-monitor.ts';
import { DownloadMonitor, type DownloadEvidence } from '../browser/download-monitor.ts';
import { EvidenceCollector } from '../browser/evidence.ts';
import { NetworkMonitor } from '../browser/network-monitor.ts';
import { createQaConfig } from '../config/qa.config.ts';
import {
  QA_ORGANIZATION_ID,
  QA_SUPPLIER_PROFILE_ID,
  type QaRole,
} from '../config/roles.ts';
import { createSyntheticQaData } from '../fixtures/data-factory.ts';
import type { SyntheticFixtureKind } from '../fixtures/files/generator.ts';
import { loadReadyQaState } from '../runner/runtime-state.ts';
import {
  acquireLocalVerificationRuntime,
  verifyAuditLogs,
  verifyDatabaseRows,
  verifyDataIntegrity,
  verifyExportFiles,
  type LocalVerificationRuntime,
  type VerificationResult,
} from '../verification/index.ts';

const qa = createQaConfig();
const MEAT_SUPPLIER_ID = 'aa000000-0000-4000-8000-000000000005';
const MEAT_SUPPLIER_NAME = 'בשר והבן שיווק בשרים';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ReadyState = Awaited<ReturnType<typeof loadReadyQaState>>;
type SyntheticData = ReturnType<typeof createSyntheticQaData>;

interface WorkflowState {
  supplierSubmissionId?: string;
  supplierTargetMonth?: string;
  orderId?: string;
  receiptId?: string;
  receiptDocumentId?: string;
  invoiceId?: string;
  paymentRequestId?: string;
  paymentId?: string;
  paymentMonth?: string;
  bankImportId?: string;
  bankTransactionId?: string;
  reportDownload?: DownloadEvidence;
}

interface RoleSession {
  page: Page;
  evidence: EvidenceCollector;
  downloadMonitor: DownloadMonitor;
}

interface CapturedMutation {
  request: Request;
  requestBody: Record<string, unknown>;
  responseBody: unknown;
}

interface ProfileLookupResponse {
  data: Array<{ id: string }> | null;
  error: { message?: string } | null;
}

interface ProfileLookupQuery extends PromiseLike<ProfileLookupResponse> {
  eq(column: string, value: string | boolean): ProfileLookupQuery;
}

let readyState: ReadyState;
let synthetic: SyntheticData;
const workflow: WorkflowState = {};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} did not contain a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function responseRecord(value: unknown, label: string): Record<string, unknown> {
  const candidate = Array.isArray(value) ? value[0] : value;
  return asRecord(candidate, label);
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`${label} did not expose a valid UUID.`);
  return value;
}

function workflowValue(key: keyof WorkflowState): string {
  const value = workflow[key];
  if (typeof value !== 'string' || !value) throw new Error(`Workflow state is missing ${key}.`);
  return value;
}

function nextMonthStart(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new Error(`Invalid report month: ${month}.`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]), 1)).toISOString().slice(0, 10);
}

async function roleUserId(runtime: LocalVerificationRuntime, role: QaRole): Promise<string> {
  const client = runtime.createServiceClient() as unknown as {
    from(table: 'profiles'): { select(columns: 'id'): ProfileLookupQuery };
  };
  const result = await client.from('profiles').select('id')
    .eq('org_id', QA_ORGANIZATION_ID)
    .eq('role', role)
    .eq('active', true);
  if (result.error || result.data?.length !== 1) {
    throw new Error(`The local ${role} actor profile was missing or ambiguous.`);
  }
  return uuid(result.data[0].id, `${role} actor`);
}

function endpointPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

async function captureMutation(
  page: Page,
  pathname: string,
  action: () => Promise<void>,
): Promise<CapturedMutation> {
  const matches = (url: string, method: string) => method === 'POST' && endpointPath(url) === pathname;
  const requestPromise = page.waitForRequest((request) => matches(request.url(), request.method()));
  const responsePromise = page.waitForResponse((response) => matches(response.url(), response.request().method()));
  const [request, response] = await Promise.all([requestPromise, responsePromise, action()]);
  expect(response.ok(), `${pathname} returned HTTP ${response.status()}.`).toBe(true);
  const requestBody = asRecord(request.postDataJSON(), `${pathname} request`);
  const responseBody: unknown = await response.json().catch(() => null);
  return { request, requestBody, responseBody };
}

async function chooseFile(page: Page, button: Locator, filePath: string): Promise<void> {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    button.click(),
  ]);
  await chooser.setFiles(filePath);
}

async function blockScenario(
  testInfo: TestInfo,
  scenarioId: string,
  reason: string,
  evidence: Record<string, unknown> = {},
): Promise<never> {
  await testInfo.attach(`blocked-${scenarioId}`, {
    body: Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      status: 'BLOCKED',
      scenarioId,
      reason,
      evidence,
    }, null, 2)}\n`, 'utf8'),
    contentType: 'application/json',
  });
  test.skip(true, `BLOCKED ${scenarioId}: ${reason}`);
  throw new Error(`BLOCKED ${scenarioId}`);
}

async function fixturePath(
  testInfo: TestInfo,
  scenarioId: string,
  kind: SyntheticFixtureKind,
): Promise<string> {
  const value = readyState.fixtureFiles[kind];
  return value ?? await blockScenario(testInfo, scenarioId, `Required synthetic fixture is missing: ${kind}.`);
}

async function runAsRole(
  browser: Browser,
  testInfo: TestInfo,
  role: QaRole,
  action: (session: RoleSession) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext({
    baseURL: qa.baseUrl,
    storageState: storageStatePath(qa.authStateRoot, role),
    locale: 'he-IL',
    timezoneId: 'Asia/Jerusalem',
    colorScheme: 'light',
    serviceWorkers: 'block',
    acceptDownloads: true,
    viewport: role === 'kitchen' ? { width: 390, height: 844 } : { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const consoleMonitor = new ConsoleMonitor(page);
  const networkMonitor = new NetworkMonitor(page);
  const downloadMonitor = new DownloadMonitor(page, testInfo.outputPath('downloads'));
  const evidence = new EvidenceCollector(page, testInfo, role, consoleMonitor, networkMonitor, downloadMonitor);
  let failure: unknown;

  try {
    await action({ page, evidence, downloadMonitor });
    const issues = await evidence.blockingIssues();
    if (issues.length > 0) throw new Error(`Browser evidence contains unexpected failures: ${issues.slice(0, 5).join('; ')}`);
    await evidence.screenshot('persisted-state');
  } catch (error) {
    failure = error;
    await evidence.screenshot('failure').catch(() => undefined);
  }

  try {
    await evidence.finalize(failure ? 'ui-failed-or-blocked' : 'ui-completed');
  } catch (error) {
    failure ??= error;
  }
  try {
    await context.close();
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
}

async function verifyAfterUi(
  testInfo: TestInfo,
  scenarioId: string,
  build: (runtime: LocalVerificationRuntime) => Promise<readonly VerificationResult[]>,
): Promise<void> {
  let runtime: LocalVerificationRuntime | undefined;
  let results: readonly VerificationResult[];
  try {
    runtime = await acquireLocalVerificationRuntime({ repoRoot: qa.repoRoot, apiUrl: qa.supabaseUrl });
    results = await build(runtime);
  } catch {
    await blockScenario(testInfo, scenarioId, 'The SELECT-only local verifier was unavailable after the UI action.');
  } finally {
    runtime?.dispose();
  }

  for (const [index, result] of results!.entries()) {
    await testInfo.attach(`verifier-${String(index + 1).padStart(2, '0')}-${result.verifier}`, {
      body: Buffer.from(`${JSON.stringify(result, null, 2)}\n`, 'utf8'),
      contentType: 'application/json',
    });
    if (result.status === 'BLOCKED') {
      await blockScenario(testInfo, scenarioId, `Verifier ${result.verifier} could not establish objective evidence.`);
    }
    expect(result.status, `${result.verifier}: ${result.summary}`).toBe('PASS');
  }
}

test.describe.serial('critical cross-role workflow', () => {
  test.beforeAll(async () => {
    readyState = await loadReadyQaState(qa.repoRoot);
    synthetic = createSyntheticQaData(readyState.runId);
  });

  test('[critical:supplier-price-list] supplier submits and replays the monthly workbook', async ({ browser }, testInfo) => {
    const scenarioId = 'supplier-price-list';
    const workbook = await fixturePath(testInfo, scenarioId, 'price-list-xlsx');
    const startedAt = new Date().toISOString();

    await runAsRole(browser, testInfo, 'supplier', async ({ page, evidence }) => {
      await page.goto('/my-prices');
      await expect(page.getByRole('heading', { level: 1, name: 'המחירון שלי', exact: true })).toBeVisible();
      for (const product of synthetic.products) {
        await expect(page.getByRole('cell', { name: product.name, exact: true })).toBeVisible();
      }

      const submit = async (replay: boolean): Promise<CapturedMutation> => {
        await page.getByRole('button', { name: 'הגשת מחירון חודשי', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'הגשת מחירון חודשי', exact: true });
        await chooseFile(page, dialog.getByRole('button', { name: 'בחירת קובץ', exact: true }), workbook);
        await expect(dialog.getByText(/זוהו 3 שורות/)).toBeVisible();
        const month = dialog.getByLabel('חודש יעד *', { exact: true });
        workflow.supplierTargetMonth ??= await month.inputValue();
        await dialog.getByLabel('סיבת ההגשה *', { exact: true }).fill(`QA ${readyState.runId} monthly price list`);
        evidence.record(replay ? 'replay-price-list' : 'submit-price-list', path.basename(workbook));
        const mutation = await captureMutation(page, '/functions/v1/submit-price-list', () =>
          dialog.getByRole('button', { name: 'אישור והגשה', exact: true }).click());
        await expect(dialog.getByRole('status')).toContainText('נקלטו');
        if (replay) await expect(dialog.getByText(/זהו ניסיון חוזר/)).toBeVisible();
        await dialog.getByRole('button', { name: 'סיום', exact: true }).click();
        await expect(dialog).toBeHidden();
        return mutation;
      };

      const first = await submit(false);
      workflow.supplierSubmissionId = uuid(first.requestBody.submissionId, 'supplier submission');
      const replay = await submit(true);
      expect(uuid(replay.requestBody.submissionId, 'supplier replay submission')).not.toBe(workflow.supplierSubmissionId);
      await page.reload();
      await expect(page.getByRole('heading', { name: 'היסטוריית הגשות', exact: true })).toBeVisible();
      await expect(page.getByText(path.basename(workbook), { exact: true })).toHaveCount(1);
    });

    const submissionId = workflowValue('supplierSubmissionId');
    const targetMonth = `${workflowValue('supplierTargetMonth')}-01`;
    await verifyAfterUi(testInfo, scenarioId, async (runtime) => {
      const actorUserId = await roleUserId(runtime, 'supplier');
      return [
      await verifyDatabaseRows(runtime, [{
        id: 'supplier-ledger-idempotent',
        table: 'supplier_price_submissions',
        select: 'id,org_id,supplier_id,target_month,status,accepted_count,rejected_count,revision,submitted_by',
        filters: [
          { column: 'org_id', operator: 'eq', value: QA_ORGANIZATION_ID },
          { column: 'supplier_id', operator: 'eq', value: QA_SUPPLIER_PROFILE_ID },
          { column: 'target_month', operator: 'eq', value: targetMonth },
        ],
        expectedCount: 1,
        expectedSubsets: [{
          id: submissionId,
          org_id: QA_ORGANIZATION_ID,
          supplier_id: QA_SUPPLIER_PROFILE_ID,
          target_month: targetMonth,
          status: 'accepted',
          accepted_count: 3,
          rejected_count: 0,
          revision: 1,
          submitted_by: actorUserId,
        }],
      }]),
      await verifyDatabaseRows(runtime, [{
        id: 'supplier-canonical-products-updated',
        table: 'supplier_products',
        select: 'id,org_id,supplier_id,product_id,current_price',
        filters: [
          { column: 'org_id', operator: 'eq', value: QA_ORGANIZATION_ID },
          { column: 'supplier_id', operator: 'eq', value: QA_SUPPLIER_PROFILE_ID },
          { column: 'product_id', operator: 'in', value: synthetic.products.map(({ id }) => id) },
        ],
        expectedCount: synthetic.products.length,
        expectedSubsets: synthetic.products.map((product) => ({
          org_id: QA_ORGANIZATION_ID,
          supplier_id: QA_SUPPLIER_PROFILE_ID,
          product_id: product.id,
          current_price: product.price,
        })),
      }]),
      await verifyAuditLogs(runtime, [{
        id: 'supplier-submission-audit-once',
        orgId: QA_ORGANIZATION_ID,
        action: 'supplier_price_submission_processed',
        entityType: 'supplier_price_submissions',
        entityId: submissionId,
        createdAfter: startedAt,
        actorUserId,
        reasonRequired: true,
        exactCount: 1,
      }]),
    ];
    });
  });

  test('[critical:kitchen-receiving] kitchen completes a partial receipt and uploads evidence', async ({ browser }, testInfo) => {
    const scenarioId = 'kitchen-receiving';
    const receiptImage = await fixturePath(testInfo, scenarioId, 'receipt-jpg');
    const startedAt = new Date().toISOString();

    await runAsRole(browser, testInfo, 'kitchen', async ({ page, evidence }) => {
      await page.goto('/receiving');
      await expect(page.getByRole('heading', { level: 1, name: 'קבלת סחורה', exact: true })).toBeVisible();
      await page.getByLabel('חיפוש הזמנה לקבלה', { exact: true }).fill(MEAT_SUPPLIER_NAME);
      const order = page.getByRole('button').filter({ hasText: MEAT_SUPPLIER_NAME }).filter({ hasText: /הזמנה #/ });
      await expect(order).toHaveCount(1);
      await order.click();
      await expect(page).toHaveURL(/\/receiving\/[0-9a-f-]{36}$/i);
      workflow.orderId = uuid(new URL(page.url()).pathname.split('/').at(-1), 'receiving order');

      await page.getByLabel('כמות שהתקבלה עבור חזה עוף טרי', { exact: true }).fill('44');
      await page.getByLabel('הערה לקבלת חזה עוף טרי', { exact: true }).fill(`QA ${readyState.runId} partial delivery`);
      await expect(page.getByLabel('כמות שהתקבלה עבור אנטריקוט', { exact: true })).toHaveValue('12');
      evidence.record('complete-partial-receipt', workflow.orderId);
      const receipt = await captureMutation(page, '/rest/v1/rpc/save_goods_receipt', () =>
        page.getByRole('button', { name: /סיום קבלה \(2 פריטים\)/ }).click());
      workflow.receiptId = uuid(receipt.requestBody.p_receipt_id, 'goods receipt');
      expect(receipt.requestBody.p_complete).toBe(true);
      await expect(page.getByRole('heading', { name: 'הקבלה נשמרה!', exact: true })).toBeVisible();

      evidence.record('upload-receipt-document', path.basename(receiptImage));
      const document = await captureMutation(page, '/rest/v1/documents', () =>
        chooseFile(page, page.getByRole('button', { name: 'צילום / העלאה', exact: true }), receiptImage));
      workflow.receiptDocumentId = uuid(responseRecord(document.responseBody, 'document response').id, 'receipt document');
      await expect(page.getByText(path.basename(receiptImage), { exact: true })).toBeVisible();

      await page.goto(`/receiving/${workflow.orderId}`);
      await expect(page.getByText(/התקבל בעבר: 44/)).toBeVisible();
      await expect(page.getByText(/התקבל בעבר: 12/)).toBeVisible();
    });

    const orderId = workflowValue('orderId');
    const receiptId = workflowValue('receiptId');
    const documentId = workflowValue('receiptDocumentId');
    await verifyAfterUi(testInfo, scenarioId, async (runtime) => {
      const actorUserId = await roleUserId(runtime, 'kitchen');
      return [
      await verifyDatabaseRows(runtime, [{
        id: 'completed-receipt',
        table: 'goods_receipts',
        select: 'id,org_id,order_id,status,received_by',
        filters: [{ column: 'id', operator: 'eq', value: receiptId }],
        expectedCount: 1,
        expectedSubsets: [{ id: receiptId, org_id: QA_ORGANIZATION_ID, order_id: orderId, status: 'completed', received_by: actorUserId }],
      }, {
        id: 'receipt-lines',
        table: 'goods_receipt_items',
        select: 'receipt_id,org_id,product_id,qty_received,status',
        filters: [{ column: 'receipt_id', operator: 'eq', value: receiptId }],
        expectedCount: 2,
        expectedSubsets: [
          { receipt_id: receiptId, org_id: QA_ORGANIZATION_ID, product_id: 'bb000000-0000-4000-8000-000000000012', qty_received: 44, status: 'partial' },
          { receipt_id: receiptId, org_id: QA_ORGANIZATION_ID, product_id: 'bb000000-0000-4000-8000-000000000015', qty_received: 12, status: 'full' },
        ],
      }, {
        id: 'partial-order-status',
        table: 'purchase_orders',
        select: 'id,org_id,supplier_id,status',
        filters: [{ column: 'id', operator: 'eq', value: orderId }],
        expectedCount: 1,
        expectedSubsets: [{ id: orderId, org_id: QA_ORGANIZATION_ID, supplier_id: MEAT_SUPPLIER_ID, status: 'partial' }],
      }]),
      await verifyDataIntegrity(runtime, {
        entities: [{ id: 'receipt-tenant-integrity', table: 'goods_receipts', rowId: receiptId, orgId: QA_ORGANIZATION_ID, expectedFields: { status: 'completed', order_id: orderId } }],
        documents: [{ id: 'receipt-document-integrity', documentId, orgId: QA_ORGANIZATION_ID, expectedDeleted: false }],
      }),
      await verifyAuditLogs(runtime, [{
        id: 'receipt-completed-audit',
        orgId: QA_ORGANIZATION_ID,
        action: 'goods_receipt_completed',
        entityType: 'goods_receipts',
        entityId: receiptId,
        createdAfter: startedAt,
        actorUserId,
        reasonRequired: true,
        exactCount: 1,
      }]),
    ];
    });
  });

  test('[critical:office-invoice-review] office creates, reviews, approves, and requests payment', async ({ browser }, testInfo) => {
    const scenarioId = 'office-invoice-review';
    const orderId = workflowValue('orderId');
    const receiptId = workflowValue('receiptId');
    const startedAt = new Date().toISOString();

    await runAsRole(browser, testInfo, 'office', async ({ page, evidence }) => {
      await page.goto(`/invoices/new?supplier=${MEAT_SUPPLIER_ID}&order=${orderId}&receipt=${receiptId}`);
      await expect(page.getByRole('heading', { name: 'חשבונית חדשה', exact: true })).toBeVisible();
      await page.getByLabel('מספר חשבונית *', { exact: true }).fill(synthetic.invoice.number);
      await page.getByLabel('סה״כ לתשלום *', { exact: true }).fill(synthetic.invoice.total.toFixed(2));
      await page.getByLabel('סיבת קליטת החשבונית *', { exact: true }).fill(`QA ${readyState.runId} receiving invoice`);
      const save = page.getByRole('button', { name: 'שמירת חשבונית', exact: true });
      await expect(save).toBeEnabled({ timeout: 20_000 });
      evidence.record('create-invoice', synthetic.invoice.number);
      const invoice = await captureMutation(page, '/rest/v1/rpc/create_invoice', () => save.click());
      workflow.invoiceId = uuid(invoice.requestBody.p_invoice_id, 'invoice');
      await expect(page).toHaveURL(`/invoices/${workflow.invoiceId}`);

      const transitionInvoice = async (buttonName: string, expectedStatus: string): Promise<void> => {
        await page.getByRole('button', { name: buttonName, exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'עדכון סטטוס בדיקת חשבונית', exact: true });
        await dialog.getByLabel('סיבה (חובה — נרשם ביומן הביקורת)', { exact: true })
          .fill(`QA ${readyState.runId} ${expectedStatus}`);
        const mutation = await captureMutation(page, '/rest/v1/rpc/set_invoice_review_status', () =>
          dialog.getByRole('button', { name: 'עדכון סטטוס', exact: true }).click());
        expect(mutation.requestBody.p_status).toBe(expectedStatus);
        await expect(dialog).toBeHidden();
      };

      await transitionInvoice('העברה לבדיקה', 'in_review');
      await transitionInvoice('אישור לתשלום', 'approved');
      await page.reload();
      await expect(page.getByRole('button', { name: 'יצירת דרישת תשלום', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'יצירת דרישת תשלום', exact: true }).click();
      const requestDialog = page.getByRole('dialog', { name: 'דרישת תשלום חדשה', exact: true });
      await requestDialog.getByLabel('סיבת יצירת הדרישה *', { exact: true }).fill(`QA ${readyState.runId} payment request`);
      const submit = requestDialog.getByRole('button', { name: 'שליחה לאישור', exact: true });
      await expect(submit).toBeEnabled({ timeout: 20_000 });
      evidence.record('create-payment-request', workflow.invoiceId);
      const request = await captureMutation(page, '/rest/v1/rpc/create_payment_request', () => submit.click());
      workflow.paymentRequestId = uuid(request.requestBody.p_request_id, 'payment request');

      await page.goto(`/payment-requests?id=${workflow.paymentRequestId}`);
      await expect(page.getByRole('dialog', { name: new RegExp(`דרישת תשלום #.*${MEAT_SUPPLIER_NAME}`) })).toBeVisible();
      await expect(page.getByText(synthetic.invoice.number, { exact: true })).toBeVisible();
    });

    const invoiceId = workflowValue('invoiceId');
    const requestId = workflowValue('paymentRequestId');
    await verifyAfterUi(testInfo, scenarioId, async (runtime) => {
      const actorUserId = await roleUserId(runtime, 'office');
      return [
      await verifyDatabaseRows(runtime, [{
        id: 'approved-invoice',
        table: 'invoices',
        select: 'id,org_id,supplier_id,total_amount,review_status,payment_status,received_by',
        filters: [{ column: 'id', operator: 'eq', value: invoiceId }],
        expectedCount: 1,
        expectedSubsets: [{ id: invoiceId, org_id: QA_ORGANIZATION_ID, supplier_id: MEAT_SUPPLIER_ID, total_amount: synthetic.invoice.total, review_status: 'approved', payment_status: 'unpaid', received_by: actorUserId }],
      }, {
        id: 'pending-payment-request',
        table: 'payment_requests',
        select: 'id,org_id,supplier_id,amount,status,created_by',
        filters: [{ column: 'id', operator: 'eq', value: requestId }],
        expectedCount: 1,
        expectedSubsets: [{ id: requestId, org_id: QA_ORGANIZATION_ID, supplier_id: MEAT_SUPPLIER_ID, amount: synthetic.invoice.total, status: 'pending_approval', created_by: actorUserId }],
      }, {
        id: 'request-invoice-link',
        table: 'payment_request_invoices',
        select: 'org_id,payment_request_id,invoice_id,amount_allocated',
        filters: [{ column: 'payment_request_id', operator: 'eq', value: requestId }],
        expectedCount: 1,
        expectedSubsets: [{ org_id: QA_ORGANIZATION_ID, payment_request_id: requestId, invoice_id: invoiceId, amount_allocated: synthetic.invoice.total }],
      }]),
      await verifyDataIntegrity(runtime, {
        entities: [{ id: 'request-tenant-integrity', table: 'payment_requests', rowId: requestId, orgId: QA_ORGANIZATION_ID, expectedFields: { status: 'pending_approval', supplier_id: MEAT_SUPPLIER_ID } }],
        invoices: [{ id: 'invoice-unpaid-balance', invoiceId, orgId: QA_ORGANIZATION_ID, expectedPaidAmount: 0, expectedBalance: synthetic.invoice.total, expectedPaymentStatus: 'unpaid' }],
      }),
      await verifyAuditLogs(runtime, [{
        id: 'invoice-created-audit', orgId: QA_ORGANIZATION_ID, action: 'invoice_created', entityType: 'invoices', entityId: invoiceId, actorUserId, createdAfter: startedAt, reasonRequired: true, exactCount: 1,
      }, {
        id: 'invoice-review-audit', orgId: QA_ORGANIZATION_ID, action: 'invoice_review_status_changed', entityType: 'invoices', entityId: invoiceId, actorUserId, createdAfter: startedAt, reasonRequired: true, exactCount: 2,
      }, {
        id: 'payment-request-created-audit', orgId: QA_ORGANIZATION_ID, action: 'payment_request_created', entityType: 'payment_requests', entityId: requestId, actorUserId, createdAfter: startedAt, reasonRequired: true, exactCount: 1,
      }]),
    ];
    });
  });

  test('[critical:owner-payment-approval] owner approves the run payment request', async ({ browser }, testInfo) => {
    const scenarioId = 'owner-payment-approval';
    const requestId = workflowValue('paymentRequestId');
    const startedAt = new Date().toISOString();
    const creditOverrideReason = `QA ${readyState.runId} owner credit override`;
    let creditOverrideTotal = 0;

    await runAsRole(browser, testInfo, 'owner', async ({ page, evidence }) => {
      await page.goto(`/payment-requests?id=${requestId}`);
      const detail = page.getByRole('dialog', { name: new RegExp(`דרישת תשלום #.*${MEAT_SUPPLIER_NAME}`) });
      await expect(detail).toBeVisible();
      await expect(detail).toContainText('לספק קיימים זיכויים פתוחים שטרם קוזזו');
      await expect(detail).toContainText('אישור זה אינו מקזז את הזיכויים ואינו משנה את סכום הדרישה');
      await expect(detail.getByRole('button', { name: 'אישור רגיל חסום בגלל זיכויים פתוחים', exact: true })).toBeDisabled();
      const override = detail.getByRole('button', { name: 'אישור חריג ללא קיזוז הזיכוי', exact: true });
      await expect(override).toBeDisabled();
      await detail.getByLabel('קראתי והבנתי שהזיכויים לא יקוזזו אוטומטית', { exact: true }).check();
      await expect(override).toBeEnabled({ timeout: 20_000 });
      await override.click();
      const confirm = page.getByRole('dialog', { name: 'אישור חריג ללא קיזוז הזיכוי', exact: true });
      await confirm.getByLabel('סיבת אישור החריגה', { exact: true }).fill(creditOverrideReason);
      evidence.record('approve-payment-request', requestId);
      const mutation = await captureMutation(page, '/rest/v1/rpc/approve_payment_request_with_credit_override', () =>
        confirm.getByRole('button', { name: 'אישור חריג ללא קיזוז הזיכוי', exact: true }).click());
      creditOverrideTotal = Number(mutation.requestBody.p_expected_open_credit_total);
      expect(creditOverrideTotal).toBeGreaterThan(0);
      expect(mutation.requestBody.p_supplier_id).toBe(MEAT_SUPPLIER_ID);
      expect(mutation.requestBody.p_override_reason).toBe(creditOverrideReason);

      await page.goto(`/payment-requests?id=${requestId}`);
      await expect(page.getByRole('button', { name: 'העברה לגורם המבצע', exact: true })).toBeVisible();
      await expect(page.getByText('הדרישה אושרה באישור חריג ללא קיזוז הזיכוי.', { exact: true })).toBeVisible();
    });

    await verifyAfterUi(testInfo, scenarioId, async (runtime) => {
      const actorUserId = await roleUserId(runtime, 'owner');
      return [
      await verifyDatabaseRows(runtime, [{
        id: 'approved-payment-request',
        table: 'payment_requests',
        select: 'id,org_id,supplier_id,amount,status,approved_by,approved_at,open_credit_override_total,open_credit_override_reason,open_credit_override_at',
        filters: [{ column: 'id', operator: 'eq', value: requestId }],
        expectedCount: 1,
        expectedSubsets: [{
          id: requestId,
          org_id: QA_ORGANIZATION_ID,
          supplier_id: MEAT_SUPPLIER_ID,
          amount: synthetic.invoice.total,
          status: 'approved',
          approved_by: actorUserId,
          open_credit_override_total: creditOverrideTotal,
          open_credit_override_reason: creditOverrideReason,
        }],
      }]),
      await verifyDataIntegrity(runtime, {
        entities: [{ id: 'approved-request-integrity', table: 'payment_requests', rowId: requestId, orgId: QA_ORGANIZATION_ID, expectedFields: { status: 'approved' } }],
      }),
      await verifyAuditLogs(runtime, [{
        id: 'owner-approval-audit',
        orgId: QA_ORGANIZATION_ID,
        action: 'payment_request_transitioned',
        entityType: 'payment_requests',
        entityId: requestId,
        actorUserId,
        createdAfter: startedAt,
        reasonRequired: true,
        exactCount: 1,
      }]),
    ];
    });
  });

  test('[critical:payer-transfer-execution] payer execution replay is idempotent', async ({ browser }, testInfo) => {
    const scenarioId = 'payer-transfer-execution';
    const requestId = workflowValue('paymentRequestId');
    const invoiceId = workflowValue('invoiceId');
    const startedAt = new Date().toISOString();

    await runAsRole(browser, testInfo, 'payer', async ({ page, evidence }) => {
      await page.goto('/pay');
      await expect(page.getByRole('heading', { name: 'תשלומים לביצוע', exact: true })).toBeVisible();
      const request = page.getByRole('button').filter({ hasText: MEAT_SUPPLIER_NAME })
        .filter({ hasText: synthetic.invoice.total.toFixed(2) });
      await expect(request).toHaveCount(1);
      await request.click();
      const dialog = page.getByRole('dialog', { name: `ביצוע העברה — ${MEAT_SUPPLIER_NAME}`, exact: true });
      const paidDate = await dialog.getByLabel('תאריך ביצוע', { exact: true }).inputValue();
      workflow.paymentMonth = paidDate.slice(0, 7);
      await dialog.getByLabel('אסמכתת העברה *', { exact: true }).fill(synthetic.payment.reference);
      await dialog.getByLabel('סיבת ביצוע / אישור הפעולה *', { exact: true }).fill(`QA ${readyState.runId} transfer execution`);
      evidence.record('execute-payment-request', requestId);
      let uiExecutionRequestCount = 0;
      const countUiExecution = (request: Request) => {
        if (request.method() === 'POST' && endpointPath(request.url()) === '/rest/v1/rpc/execute_payment_request') {
          uiExecutionRequestCount += 1;
        }
      };
      page.on('request', countUiExecution);
      let mutation: CapturedMutation;
      try {
        mutation = await captureMutation(page, '/rest/v1/rpc/execute_payment_request', () =>
          dialog.getByRole('button', { name: 'ההעברה בוצעה', exact: true }).dblclick());
      } finally {
        page.off('request', countUiExecution);
      }
      expect(uiExecutionRequestCount, 'A payer double-click must dispatch one execution RPC.').toBe(1);
      expect(mutation.requestBody.p_payment_request_id).toBe(requestId);
      workflow.paymentId = uuid(responseRecord(mutation.responseBody, 'payment response').payment_id, 'payment');
      const success = page.getByRole('dialog', { name: 'ההעברה נרשמה', exact: true });
      await expect(success).toBeVisible();

      evidence.record('replay-payment-request', requestId);
      const replayResponse = await page.request.fetch(mutation.request);
      expect(replayResponse.ok(), `payment replay returned HTTP ${replayResponse.status()}.`).toBe(true);
      const replay = responseRecord(await replayResponse.json(), 'payment replay response');
      expect(replay.idempotent).toBe(true);
      expect(replay.payment_id).toBe(workflow.paymentId);
      expect(replay.payment_request_id).toBe(requestId);
      expect(replay.status).toBe('executed');

      await success.getByRole('button', { name: 'סיום', exact: true }).click();
      await page.reload();
      await expect(page.getByRole('heading', { name: 'תשלומים לביצוע', exact: true })).toBeVisible();
      await expect(page.getByRole('button').filter({ hasText: MEAT_SUPPLIER_NAME })
        .filter({ hasText: synthetic.invoice.total.toFixed(2) })).toHaveCount(0);
    });

    const paymentId = workflowValue('paymentId');
    await verifyAfterUi(testInfo, scenarioId, async (runtime) => {
      const actorUserId = await roleUserId(runtime, 'payer');
      return [
      await verifyDatabaseRows(runtime, [{
        id: 'single-payment-row-and-reference',
        table: 'payments',
        select: 'id,org_id,supplier_id,payment_request_id,amount,reference,executed_by',
        filters: [{ column: 'payment_request_id', operator: 'eq', value: requestId }],
        expectedCount: 1,
        expectedSubsets: [{ id: paymentId, org_id: QA_ORGANIZATION_ID, supplier_id: MEAT_SUPPLIER_ID, payment_request_id: requestId, amount: synthetic.invoice.total, reference: synthetic.payment.reference, executed_by: actorUserId }],
      }, {
        id: 'single-payment-allocation',
        table: 'payment_allocations',
        select: 'org_id,payment_id,invoice_id,credit_id,amount',
        filters: [{ column: 'payment_id', operator: 'eq', value: paymentId }],
        expectedCount: 1,
        expectedSubsets: [{ org_id: QA_ORGANIZATION_ID, payment_id: paymentId, invoice_id: invoiceId, credit_id: null, amount: synthetic.invoice.total }],
      }, {
        id: 'executed-request',
        table: 'payment_requests',
        select: 'id,org_id,status',
        filters: [{ column: 'id', operator: 'eq', value: requestId }],
        expectedCount: 1,
        expectedSubsets: [{ id: requestId, org_id: QA_ORGANIZATION_ID, status: 'executed' }],
      }]),
      await verifyDataIntegrity(runtime, {
        invoices: [{ id: 'paid-invoice-balance', invoiceId, orgId: QA_ORGANIZATION_ID, expectedPaidAmount: synthetic.invoice.total, expectedBalance: 0, expectedPaymentStatus: 'paid' }],
      }),
      await verifyAuditLogs(runtime, [{
        id: 'payment-executed-audit',
        orgId: QA_ORGANIZATION_ID,
        action: 'payment_request_executed',
        entityType: 'payment_requests',
        entityId: requestId,
        actorUserId,
        createdAfter: startedAt,
        reasonRequired: true,
        exactCount: 1,
      }]),
    ];
    });
  });

  test('[critical:accountant-reconciliation] accountant imports, reconciles, reports and exports', async ({ browser }, testInfo) => {
    const scenarioId = 'accountant-reconciliation';
    const bankFile = await fixturePath(testInfo, scenarioId, 'bank-csv');
    const startedAt = new Date().toISOString();

    await runAsRole(browser, testInfo, 'accountant', async ({ page, evidence, downloadMonitor }) => {
      await page.goto('/bank');
      await expect(page.getByRole('heading', { name: 'התאמות בנק', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'ייבוא תדפיס בנק', exact: true }).click();
      const importDialog = page.getByRole('dialog', { name: 'ייבוא תדפיס בנק', exact: true });
      await chooseFile(page, importDialog.getByRole('button', { name: 'בחירת קובץ', exact: true }), bankFile);
      for (const label of ['תאריך *', 'תיאור *', 'סכום (חובה) *']) {
        await expect(importDialog.getByLabel(label, { exact: true })).not.toHaveValue('');
      }

      const accessibleReason = importDialog.getByRole('textbox', { name: 'סיבת הייבוא *', exact: true });
      if (await accessibleReason.count() !== 1) {
        await blockScenario(testInfo, scenarioId,
          'The mandatory bank-import reason input has no accessible name; a structural locator is intentionally not guessed.',
          { fileParsedThroughUi: true, requiredControl: 'bank-import-reason', accessibleMatchCount: await accessibleReason.count() });
      }
      await accessibleReason.fill(`QA ${readyState.runId} bank import`);
      evidence.record('import-bank-statement', path.basename(bankFile));
      const imported = await captureMutation(page, '/rest/v1/rpc/import_bank_transactions', () =>
        importDialog.getByRole('button', { name: 'ייבוא', exact: true }).click());
      workflow.bankImportId = uuid(responseRecord(imported.responseBody, 'bank import response').import_id, 'bank import');
      await importDialog.getByRole('button', { name: 'סיום', exact: true }).click();

      await page.getByLabel('חיפוש בתנועות בנק', { exact: true }).fill(synthetic.bankTransaction.description);
      const transaction = page.getByRole('button', { name: new RegExp(`פתיחת תנועת בנק.*${synthetic.tag}`) });
      await expect(transaction).toHaveCount(1);
      await transaction.click();
      const matchDialog = page.getByRole('dialog', { name: 'התאמת תנועת בנק', exact: true });
      await matchDialog.getByLabel('ספק', { exact: true }).selectOption({ value: MEAT_SUPPLIER_ID });
      await matchDialog.getByLabel('סיבת הפעולה *', { exact: true }).fill(`QA ${readyState.runId} bank match`);
      const confirm = matchDialog.getByRole('button', { name: new RegExp(`אישור תשלום.*${synthetic.tag}`) });
      await expect(confirm).toBeVisible({ timeout: 20_000 });
      evidence.record('match-bank-payment', workflowValue('paymentId'));
      const matched = await captureMutation(page, '/rest/v1/rpc/match_bank_transaction', () => confirm.click());
      workflow.bankTransactionId = uuid(matched.requestBody.p_bank_transaction_id, 'bank transaction');

      await page.getByLabel('חיפוש בתנועות בנק', { exact: true }).fill(synthetic.bankTransaction.description);
      const matchedRow = page.getByRole('table').getByRole('row')
        .filter({ hasText: synthetic.bankTransaction.description });
      await expect(matchedRow).toHaveCount(1);
      await expect(matchedRow.getByText('מותאמת', { exact: true })).toBeVisible();
      await page.goto('/reports');
      await expect(page.getByRole('heading', { name: 'דוח חודשי לרואת חשבון', exact: true })).toBeVisible();
      await page.getByLabel('חודש הדוח', { exact: true }).fill(workflowValue('paymentMonth'));
      const exportButton = page.getByRole('button', { name: 'ייצוא Excel', exact: true });
      await expect(exportButton).toBeEnabled();
      workflow.reportDownload = await downloadMonitor.waitForNext(() => exportButton.click());
      expect(workflow.reportDownload.failure).toBeNull();
      expect(workflow.reportDownload.path).not.toBeNull();
    });

    const importId = workflowValue('bankImportId');
    const transactionId = workflowValue('bankTransactionId');
    const requestId = workflowValue('paymentRequestId');
    const paymentId = workflowValue('paymentId');
    const invoiceId = workflowValue('invoiceId');
    const download = workflow.reportDownload;
    const downloadPath = download?.path
      ?? await blockScenario(testInfo, scenarioId, 'The monthly workbook download was not captured.');
    await verifyAfterUi(testInfo, scenarioId, async (runtime) => {
      const actorUserId = await roleUserId(runtime, 'accountant');
      const reportMonth = workflowValue('paymentMonth');
      const reportPaymentsResponse = await runtime.createServiceClient()
        .from('payments')
        .select('id,amount,reference')
        .eq('org_id', QA_ORGANIZATION_ID)
        .gte('paid_date', `${reportMonth}-01`)
        .lt('paid_date', nextMonthStart(reportMonth));
      if (reportPaymentsResponse.error) {
        throw new Error('The verifier could not read the trusted monthly payment total from the local database.');
      }
      const reportPayments = (reportPaymentsResponse.data ?? []) as Array<{
        id: string;
        amount: number | string;
        reference: string | null;
      }>;
      const exportedPayment = reportPayments.find(({ id }) => id === paymentId);
      if (!exportedPayment || exportedPayment.reference !== synthetic.payment.reference) {
        throw new Error('The run payment was missing from the trusted monthly database slice.');
      }
      const databasePaymentTotal = reportPayments.reduce((sum, row) => sum + Number(row.amount), 0);
      if (!Number.isFinite(databasePaymentTotal)) {
        throw new Error('The trusted monthly payment total was not numeric.');
      }
      return [
      await verifyDatabaseRows(runtime, [{
        id: 'bank-import-row',
        table: 'bank_imports',
        select: 'id,org_id,filename,row_count,imported_by',
        filters: [{ column: 'id', operator: 'eq', value: importId }],
        expectedCount: 1,
        expectedSubsets: [{ id: importId, org_id: QA_ORGANIZATION_ID, filename: path.basename(bankFile), row_count: 1, imported_by: actorUserId }],
      }, {
        id: 'matched-bank-transaction',
        table: 'bank_transactions',
        select: 'id,org_id,import_id,supplier_id,amount,reference,status',
        filters: [{ column: 'import_id', operator: 'eq', value: importId }],
        expectedCount: 1,
        expectedSubsets: [{ id: transactionId, org_id: QA_ORGANIZATION_ID, import_id: importId, supplier_id: MEAT_SUPPLIER_ID, amount: synthetic.bankTransaction.amount, reference: synthetic.bankTransaction.reference, status: 'matched' }],
      }, {
        id: 'single-bank-allocation',
        table: 'bank_allocations',
        select: 'org_id,bank_transaction_id,payment_id,amount,confirmed,created_by',
        filters: [{ column: 'bank_transaction_id', operator: 'eq', value: transactionId }],
        expectedCount: 1,
        expectedSubsets: [{ org_id: QA_ORGANIZATION_ID, bank_transaction_id: transactionId, payment_id: paymentId, amount: synthetic.bankTransaction.amount, confirmed: true, created_by: actorUserId }],
      }, {
        id: 'matched-payment-request',
        table: 'payment_requests',
        select: 'id,org_id,status',
        filters: [{ column: 'id', operator: 'eq', value: requestId }],
        expectedCount: 1,
        expectedSubsets: [{ id: requestId, org_id: QA_ORGANIZATION_ID, status: 'matched' }],
      }]),
      await verifyDataIntegrity(runtime, {
        entities: [
          { id: 'bank-import-integrity', table: 'bank_imports', rowId: importId, orgId: QA_ORGANIZATION_ID },
          { id: 'bank-transaction-integrity', table: 'bank_transactions', rowId: transactionId, orgId: QA_ORGANIZATION_ID, expectedFields: { status: 'matched', supplier_id: MEAT_SUPPLIER_ID } },
        ],
        invoices: [{ id: 'reconciled-invoice-balance', invoiceId, orgId: QA_ORGANIZATION_ID, expectedPaidAmount: synthetic.invoice.total, expectedBalance: 0, expectedPaymentStatus: 'paid' }],
      }),
      await verifyAuditLogs(runtime, [{
        id: 'bank-import-audit', orgId: QA_ORGANIZATION_ID, action: 'bank_import_created', entityType: 'bank_imports', entityId: importId, actorUserId, createdAfter: startedAt, reasonRequired: true, exactCount: 1,
      }, {
        id: 'bank-match-audit', orgId: QA_ORGANIZATION_ID, action: 'bank_match_confirmed', entityType: 'bank_transactions', entityId: transactionId, actorUserId, createdAfter: startedAt, reasonRequired: true, exactCount: 1,
      }]),
      await verifyExportFiles([{
        id: 'monthly-payment-workbook',
        kind: 'xlsx',
        filePath: downloadPath,
        sheetName: 'תשלומים',
        expectedHeaders: ['ספק', 'תאריך', 'סכום', 'אמצעי', 'אסמכתא'],
        expectedRowSubsets: [{
          'ספק': MEAT_SUPPLIER_NAME,
          'סכום': Number(exportedPayment.amount),
          'אסמכתא': exportedPayment.reference,
        }],
        exactRowCount: reportPayments.length,
        forbidFormulas: true,
        total: { column: 'סכום', expected: databasePaymentTotal },
      }], readyState.artifactRoot),
    ];
    });
  });
});
