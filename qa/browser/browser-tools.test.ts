import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from '@playwright/test';
import {
  createSafeBrowserTools,
  extractResponseEntityRefs,
  hasObservedMutationRequest,
  matchesAllowedRoute,
  networkCaptureSettled,
  networkClassification,
} from './browser-tools.ts';

test('safe route templates match one concrete segment without widening the allowlist', () => {
  assert.equal(matchesAllowedRoute('/receiving/order-1', '/receiving/:orderId'), true);
  assert.equal(matchesAllowedRoute('/receiving', '/receiving/:orderId'), false);
  assert.equal(matchesAllowedRoute('/receiving/order-1/items', '/receiving/:orderId'), false);
  assert.equal(matchesAllowedRoute('/receiving/%2Fadmin', '/receiving/:orderId'), false);
  assert.equal(matchesAllowedRoute('/receiving/%5Cadmin', '/receiving/:orderId'), false);
});

test('exact and explicitly broad wildcard routes retain their narrow semantics', () => {
  assert.equal(matchesAllowedRoute('/dashboard', '/dashboard'), true);
  assert.equal(matchesAllowedRoute('/dashboard/other', '/dashboard'), false);
  assert.equal(matchesAllowedRoute('/documents/item/review', '/documents/*'), true);
  assert.equal(matchesAllowedRoute('/document/item/review', '/documents/*'), false);
});

function pageAt(url: string): Page {
  return {
    url: () => url,
    on: () => undefined,
  } as unknown as Page;
}

test('current URL inspection refuses indirect navigation outside the scenario origin or routes', async () => {
  const options = {
    baseUrl: 'http://127.0.0.1:4173',
    allowedRoutes: ['/dashboard', '/documents/:documentId/review'],
    fixtures: {},
    screenshotDirectory: 'unused',
  } as const;
  const allowed = createSafeBrowserTools({ ...options, page: pageAt('http://127.0.0.1:4173/dashboard?token=hidden') });
  assert.equal(await allowed.currentUrl(), '/dashboard');

  const wrongRoute = createSafeBrowserTools({ ...options, page: pageAt('http://127.0.0.1:4173/settings') });
  await assert.rejects(() => wrongRoute.currentUrl(), /escaped the scenario route allowlist/);

  const wrongOrigin = createSafeBrowserTools({ ...options, page: pageAt('https://example.test/dashboard') });
  await assert.rejects(() => wrongOrigin.currentUrl(), /escaped the scenario route allowlist/);
});

test('open resolves an allowlisted application path against the configured base URL', async () => {
  let navigatedTo = '';
  const page = {
    url: () => 'http://127.0.0.1:4173/dashboard',
    on: () => undefined,
    goto: async (url: string) => {
      navigatedTo = url;
      throw new Error('stop-after-navigation');
    },
  } as unknown as Page;
  const tools = createSafeBrowserTools({
    page,
    baseUrl: 'http://127.0.0.1:4173',
    allowedRoutes: ['/dashboard', '/receiving'],
    fixtures: {},
    screenshotDirectory: 'unused',
  });

  await assert.rejects(() => tools.open('/receiving'), /stop-after-navigation/);
  assert.equal(navigatedTo, 'http://127.0.0.1:4173/receiving');
});

test('open cannot drop a trusted query scope from the current route', async () => {
  let navigatedTo = '';
  const page = {
    url: () => 'http://127.0.0.1:4173/dashboard',
    on: () => undefined,
    goto: async (url: string) => {
      navigatedTo = url;
      throw new Error('stop-after-navigation');
    },
  } as unknown as Page;
  const tools = createSafeBrowserTools({
    page,
    baseUrl: 'http://127.0.0.1:4173',
    allowedRoutes: ['/pay'],
    fixtures: {},
    screenshotDirectory: 'unused',
    protectedSearches: new Map([['/pay', '?id=trusted-request']]),
  });

  await assert.rejects(() => tools.open('/pay'), /stop-after-navigation/);
  assert.equal(navigatedTo, 'http://127.0.0.1:4173/pay?id=trusted-request');
  await assert.rejects(() => tools.open('/pay?id=other-request'), /protected query scope/);
});

test('upload uses the file chooser opened by the visible control', async () => {
  let controlClicks = 0;
  let uploadedPath = '';
  const control = {
    first: () => control,
    waitFor: async () => undefined,
    filter: () => control,
    count: async () => 1,
    click: async () => { controlClicks += 1; },
  };
  const page = {
    url: () => 'http://127.0.0.1:4173/my-prices',
    on: () => undefined,
    locator: (selector: string) => selector.includes('[role="dialog"]')
      ? { count: async () => 0 }
      : { getByRole: () => control },
    waitForEvent: async (event: string) => {
      assert.equal(event, 'filechooser');
      return {
        setFiles: async (path: string) => {
          uploadedPath = path;
          throw new Error('stop-after-upload');
        },
      };
    },
  } as unknown as Page;
  const tools = createSafeBrowserTools({
    page,
    baseUrl: 'http://127.0.0.1:4173',
    allowedRoutes: ['/my-prices'],
    fixtures: { 'price-list-xlsx': 'C:\\fixtures\\price-list.xlsx' },
    screenshotDirectory: 'unused',
  });

  await assert.rejects(
    () => tools.upload({ kind: 'role', role: 'button', name: 'בחירת קובץ', exact: true }, 'price-list-xlsx'),
    /stop-after-upload/,
  );
  assert.equal(controlClicks, 1);
  assert.equal(uploadedPath, 'C:\\fixtures\\price-list.xlsx');
});

test('click reports when a file control requires the atomic upload action', async () => {
  let fileChooserListener: (() => void) | null = null;
  const control = {
    first: () => control,
    waitFor: async () => undefined,
    filter: () => control,
    count: async () => 1,
    click: async () => { fileChooserListener?.(); },
  };
  const page = {
    url: () => 'http://127.0.0.1:4173/receiving/order-1',
    on: (event: string, listener: () => void) => {
      if (event === 'filechooser') fileChooserListener = listener;
    },
    off: (event: string, listener: () => void) => {
      if (event === 'filechooser' && fileChooserListener === listener) fileChooserListener = null;
    },
    locator: (selector: string) => selector.includes('[role="dialog"]')
      ? { count: async () => 0 }
      : { getByRole: () => control },
  } as unknown as Page;
  const tools = createSafeBrowserTools({
    page,
    baseUrl: 'http://127.0.0.1:4173',
    allowedRoutes: ['/receiving/:orderId'],
    fixtures: { 'receipt-jpg': 'C:\\fixtures\\receipt.jpg' },
    screenshotDirectory: 'unused',
  });

  await assert.rejects(
    () => tools.click({ kind: 'role', role: 'button', name: 'צילום / העלאה', exact: true }),
    /file_chooser_requires_upload_action/,
  );
});

test('actions are scoped to the visible modal dialog', async () => {
  let modalClicks = 0;
  let backgroundClicks = 0;
  const control = (click: () => void) => ({
    first() { return this; },
    filter() { return this; },
    waitFor: async () => undefined,
    count: async () => 1,
    click: async () => { click(); throw new Error('stop-after-click'); },
  });
  const modal = { getByRole: () => control(() => { modalClicks += 1; }) };
  const main = { getByRole: () => control(() => { backgroundClicks += 1; }) };
  const page = {
    url: () => 'http://127.0.0.1:4173/invoices/invoice-1',
    on: () => undefined,
    locator: (selector: string) => selector.includes('[role="dialog"]')
      ? { count: async () => 1, last: () => modal }
      : main,
  } as unknown as Page;
  const tools = createSafeBrowserTools({
    page,
    baseUrl: 'http://127.0.0.1:4173',
    allowedRoutes: ['/invoices/:invoiceId'],
    fixtures: {},
    screenshotDirectory: 'unused',
  });

  await assert.rejects(
    () => tools.click({ kind: 'role', role: 'button', name: 'Update status', exact: true }),
    /stop-after-click/,
  );
  assert.equal(modalClicks, 1);
  assert.equal(backgroundClicks, 0);
});

test('snapshot reads the visible modal heading and controls only', async () => {
  const button = {
    isVisible: async () => true,
    evaluate: async () => ({
      name: 'Update status',
      label: '',
      disabled: false,
      value: null,
      checked: null,
      pressed: null,
    }),
  };
  const emptyRole = { all: async () => [] };
  const modal = {
    getByRole: (role: string) => role === 'heading'
      ? { all: async () => [], first: () => ({ textContent: async () => 'Confirm update' }) }
      : role === 'button' ? { all: async () => [button] } : emptyRole,
    locator: () => ({ all: async () => [] }),
    innerText: async () => 'Confirm update',
  };
  const page = {
    url: () => 'http://127.0.0.1:4173/invoices/invoice-1',
    on: () => undefined,
    locator: (selector: string) => selector.includes('[role="dialog"]')
      ? { count: async () => 1, last: () => modal }
      : { getByRole: () => { throw new Error('background controls must stay hidden'); } },
    title: async () => 'SupplyFlow',
  } as unknown as Page;
  const tools = createSafeBrowserTools({
    page,
    baseUrl: 'http://127.0.0.1:4173',
    allowedRoutes: ['/invoices/:invoiceId'],
    fixtures: {},
    screenshotDirectory: 'unused',
  });

  const result = await tools.snapshot();
  assert.equal(result.heading, 'Confirm update');
  assert.equal(result.visibleText, 'Confirm update');
  assert.deepEqual(result.controls.map(({ name }) => name), ['Update status']);
});

test('waitForText cannot be satisfied by covered background text', async () => {
  let backgroundReads = 0;
  const modal = {
    getByText: () => ({
      first: () => ({ waitFor: async () => { throw new Error('modal-text-missing'); } }),
    }),
  };
  const page = {
    url: () => 'http://127.0.0.1:4173/invoices/invoice-1',
    on: () => undefined,
    locator: (selector: string) => selector.includes('[role="dialog"]')
      ? { count: async () => 1, last: () => modal }
      : {
        getByText: () => {
          backgroundReads += 1;
          return { first: () => ({ waitFor: async () => undefined }) };
        },
      },
  } as unknown as Page;
  const tools = createSafeBrowserTools({
    page,
    baseUrl: 'http://127.0.0.1:4173',
    allowedRoutes: ['/invoices/:invoiceId'],
    fixtures: {},
    screenshotDirectory: 'unused',
  });

  await assert.rejects(() => tools.waitForText('Saved'), /modal-text-missing/);
  assert.equal(backgroundReads, 0);
});

test('snapshot exposes labels and current state for numeric form controls', async () => {
  const candidate = {
    isVisible: async () => true,
    isDisabled: async () => false,
    evaluate: async () => ({
      name: 'כמות שהתקבלה עבור עגבניות',
      label: 'כמות שהתקבלה עבור עגבניות',
      disabled: false,
      value: '2',
      checked: null,
      pressed: null,
    }),
  };
  const emptyRole = { all: async () => [] };
  const main = {
    locator: () => ({ all: async () => [candidate] }),
    getByRole: (role: string) => role === 'heading'
      ? { all: async () => [], first: () => ({ textContent: async () => null }) }
      : role === 'spinbutton' ? { all: async () => [candidate] } : emptyRole,
    innerText: async () => 'קבלת סחורה',
  };
  const page = {
    url: () => 'http://127.0.0.1:4173/receiving/order-1',
    on: () => undefined,
    locator: (selector: string) => selector.includes('[role="dialog"]')
      ? { count: async () => 0 }
      : main,
    title: async () => 'SupplyFlow',
  } as unknown as Page;
  const tools = createSafeBrowserTools({
    page,
    baseUrl: 'http://127.0.0.1:4173',
    allowedRoutes: ['/receiving/:orderId'],
    fixtures: {},
    screenshotDirectory: 'unused',
  });

  const result = await tools.snapshot();
  assert.deepEqual(result.controls, [{
    role: 'spinbutton',
    name: 'כמות שהתקבלה עבור עגבניות',
    disabled: false,
    value: '2',
    checked: null,
    pressed: null,
  }]);
  assert.deepEqual(result.labeledControls, [{
    label: 'כמות שהתקבלה עבור עגבניות',
    disabled: false,
    value: '2',
    checked: null,
  }]);
});

test('snapshot skips a control detached by a concurrent render', async () => {
  const detached = {
    isVisible: async () => true,
    isDisabled: async () => false,
    evaluate: async () => { throw new Error('detached'); },
  };
  const emptyRole = { all: async () => [] };
  const main = {
    locator: () => ({ all: async () => [] }),
    getByRole: (role: string) => role === 'heading'
      ? { all: async () => [], first: () => ({ textContent: async () => 'Done' }) }
      : role === 'button' ? { all: async () => [detached] } : emptyRole,
    innerText: async () => 'Done',
  };
  const page = {
    url: () => 'http://127.0.0.1:4173/receiving/order-1',
    on: () => undefined,
    locator: (selector: string) => selector.includes('[role="dialog"]')
      ? { count: async () => 0 }
      : main,
    title: async () => 'SupplyFlow',
  } as unknown as Page;
  const tools = createSafeBrowserTools({
    page,
    baseUrl: 'http://127.0.0.1:4173',
    allowedRoutes: ['/receiving/:orderId'],
    fixtures: {},
    screenshotDirectory: 'unused',
  });

  const result = await tools.snapshot();
  assert.deepEqual(result.controls, []);
  assert.equal(result.heading, 'Done');
});

test('entity references are extracted only from allowlisted fields in actual response bodies', () => {
  const paymentId = '11111111-1111-4111-8111-111111111111';
  const requestId = '22222222-2222-4222-8222-222222222222';
  const invoiceId = '33333333-3333-4333-8333-333333333333';
  assert.deepEqual(extractResponseEntityRefs({
    payment_id: paymentId,
    payment_request_id: requestId,
    invoice_ids: [invoiceId],
    attacker_supplied_id: '44444444-4444-4444-8444-444444444444',
  }, '/rest/v1/rpc/execute_payment_request'), [
    { kind: 'payment', visibleReference: paymentId },
    { kind: 'payment_request', visibleReference: requestId },
    { kind: 'invoice', visibleReference: invoiceId },
  ]);

  const documentId = '55555555-5555-4555-8555-555555555555';
  assert.deepEqual(extractResponseEntityRefs([{ id: documentId }], '/rest/v1/documents'), [
    { kind: 'document', visibleReference: documentId },
  ]);
  assert.deepEqual(extractResponseEntityRefs([{ id: documentId }], '/rest/v1/untrusted_table'), []);
});

test('a dispatched mutation candidate remains a mutation even when its response is non-2xx', () => {
  assert.equal(hasObservedMutationRequest([{
    mutationCandidate: true,
    status: 500,
  }]), true);
  assert.equal(hasObservedMutationRequest([{
    mutationCandidate: false,
    status: 500,
  }]), false);
});

test('storage signing POST is captured as read-only network evidence', () => {
  assert.deepEqual(networkClassification({
    method: () => 'POST',
    url: () => 'http://127.0.0.1:55431/storage/v1/object/sign/documents',
  }), { capture: true, mutationCandidate: false });
});

test('meaningful capture waits for a delayed mutation before accepting network quiet', () => {
  assert.equal(networkCaptureSettled(true, false, false, 5_000), false);
  assert.equal(networkCaptureSettled(true, true, false, 300), true);
  assert.equal(networkCaptureSettled(false, false, false, 300), true);
  assert.equal(networkCaptureSettled(true, true, true, 5_000), false);
});
