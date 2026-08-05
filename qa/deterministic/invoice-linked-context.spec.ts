import type { Route } from '@playwright/test';
import { test, expect } from '../browser/fixture.ts';
import {
  QA_FOREIGN_ORDER_ID,
  QA_FOREIGN_RECEIPT_ID,
  QA_FOREIGN_SUPPLIER_NAME,
} from '../fixtures/cross-tenant-invoice-context.ts';
import { loadReadyQaState } from '../runner/runtime-state.ts';

const ORDER_ID = 'f0000000-0000-4000-8000-000000000001';
const RECEIPT_ID = 'f2000000-0000-4000-8000-000000000001';
const SUPPLIER_ID = 'aa000000-0000-4000-8000-000000000001';
const SUPPLIER_NAME = 'משק ירוק — ירקות ופירות';

test('linked order, receipt, supplier and receiving date are visible at 390px', async ({ page, qaRole, evidence }) => {
  test.skip(qaRole !== 'office', 'One staff role supplies deterministic visual coverage; route permissions cover the other staff roles.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/invoices/new?supplier=${SUPPLIER_ID}&order=${ORDER_ID}&receipt=${RECEIPT_ID}`);

  const context = page.getByTestId('invoice-linked-context');
  await expect(context).toBeVisible();
  await expect(context.getByTestId('invoice-linked-order')).toHaveText('הזמנה #1');
  await expect(context.getByTestId('invoice-linked-order')).toHaveAttribute('href', `/orders/${ORDER_ID}`);
  await expect(context.getByTestId('invoice-linked-receipt')).toHaveText('קבלה #1');
  await expect(context.getByTestId('invoice-linked-receipt')).toHaveAttribute('href', `/receiving/${ORDER_ID}`);
  await expect(context.getByTestId('invoice-linked-receipt')).toHaveAccessibleName('קבלה #1 — פתיחת מסך קבלת סחורה להזמנה; המסך מאפשר עדכון קבלה');
  await expect(context).toContainText('המסך מאפשר עדכון קבלה');
  await expect(context.getByTestId('invoice-linked-supplier')).toHaveText(SUPPLIER_NAME);
  await expect(context).toContainText('02.06.2026');
  await expect(context).toContainText('התקבלה');
  await expect(page.getByLabel('ספק *', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('ספק *', { exact: true }).locator('option:checked')).toHaveText(SUPPLIER_NAME);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  evidence.record('linked-invoice-context', 'order #1, receipt #1, supplier and date visible at 390x844');
  await evidence.screenshot('invoice-linked-context-mobile');
});

test('save payload keeps validated links while direct creation keeps both links null', async ({ page, qaRole, evidence }) => {
  test.skip(qaRole !== 'office', 'Financial request payload is exercised once to avoid duplicate fixture writes.');
  const requests: Record<string, unknown>[] = [];
  await page.route('**/rest/v1/rpc/create_invoice', async (route: Route) => {
    const request = route.request().postDataJSON() as Record<string, unknown>;
    requests.push(request);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        invoice_id: request.p_invoice_id,
        review_status: 'pending',
        duplicate_detected: false,
      }),
    });
  });
  const state = await loadReadyQaState();

  const submit = async (suffix: string) => {
    const expectedRequestCount = requests.length + 1;
    await page.getByLabel('מספר חשבונית *', { exact: true }).fill(`CTX-${state.runId.slice(-8)}-${suffix}`);
    await page.getByLabel('סה״כ לתשלום *', { exact: true }).fill('1.18');
    await page.getByLabel('סיבת קליטת החשבונית *', { exact: true }).fill(`QA linked context ${suffix}`);
    const save = page.getByRole('button', { name: /^(?:שמירת חשבונית|שמירה כ״דורשת בירור״)$/ });
    await expect(save).toBeEnabled({ timeout: 20_000 });
    await save.click();
    await expect.poll(() => requests.length).toBe(expectedRequestCount);
  };

  await page.goto(`/invoices/new?supplier=${SUPPLIER_ID}&order=${ORDER_ID}&receipt=${RECEIPT_ID}`);
  await submit('linked');
  expect(requests[0]?.p_supplier_id).toBe(SUPPLIER_ID);
  expect(requests[0]?.p_order_id).toBe(ORDER_ID);
  expect(requests[0]?.p_receipt_id).toBe(RECEIPT_ID);

  await page.goto('/invoices/new');
  await expect(page.getByTestId('invoice-linked-context')).toHaveCount(0);
  await page.getByLabel('ספק *', { exact: true }).selectOption(SUPPLIER_ID);
  await submit('direct');
  expect(requests).toHaveLength(2);
  expect(requests[1]?.p_supplier_id).toBe(SUPPLIER_ID);
  expect(requests[1]?.p_order_id).toBeNull();
  expect(requests[1]?.p_receipt_id).toBeNull();
  evidence.record('create-invoice-payloads', 'validated linked IDs retained; direct invoice IDs null; one request per submit');
});

test('malformed, inaccessible and mismatched identifiers reveal no record and fall back to unlinked creation', async ({ page, qaRole, evidence }) => {
  test.skip(qaRole !== 'office', 'The non-disclosure state is role-independent and is exercised once.');
  const cases = [
    '/invoices/new?order=not-a-uuid&receipt=also-not-a-uuid',
    `/invoices/new?order=${QA_FOREIGN_ORDER_ID}&receipt=${QA_FOREIGN_RECEIPT_ID}`,
    `/invoices/new?order=${ORDER_ID}&receipt=f2000000-0000-4000-8000-000000000002`,
  ];
  for (const route of cases) {
    await page.goto(route);
    await expect(page.getByTestId('invoice-linked-context-unavailable')).toContainText('אפשר להמשיך ולשמור את החשבונית ללא קישור');
    await expect(page.getByTestId('invoice-linked-context')).toHaveCount(0);
    await expect(page.getByLabel('ספק *', { exact: true })).toBeEnabled();
    await expect(page.locator('#main')).not.toContainText(ORDER_ID);
    await expect(page.locator('#main')).not.toContainText(RECEIPT_ID);
    await expect(page.locator('#main')).not.toContainText(QA_FOREIGN_ORDER_ID);
    await expect(page.locator('#main')).not.toContainText(QA_FOREIGN_RECEIPT_ID);
    await expect(page.locator('#main')).not.toContainText(QA_FOREIGN_SUPPLIER_NAME);
  }
  evidence.record('linked-context-nondisclosure', 'malformed, real cross-tenant and cross-order contexts share one non-disclosing unlinked fallback');
});
