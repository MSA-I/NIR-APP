import { describe, expect, it } from 'vitest';
import type { AdapterResult } from '../types';
import { MockAccountingAdapter } from './accounting';

const ORG = '11111111-1111-4111-8111-111111111111';

const supplier = { id: 'sup-1', name: 'ספק בדיקה', taxId: '513889900', active: true };
const invoice = {
  id: 'inv-1',
  supplierId: 'sup-1',
  invoiceNumber: '7702',
  invoiceDate: '2026-08-05',
  totalAmount: 4720,
  currency: 'ILS',
};

function expectOk<T>(result: AdapterResult<T>): Extract<AdapterResult<T>, { status: 'ok' }> {
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error('unreachable');
  return result;
}

describe('MockAccountingAdapter', () => {
  it('syncSupplier mints a stable external reference carrying the 0066 tuple', async () => {
    const adapter = new MockAccountingAdapter(ORG);
    const first = expectOk(await adapter.syncSupplier(supplier));
    expect(first.reference).toEqual({
      orgId: ORG,
      provider: 'mock-accounting',
      entityType: 'supplier',
      internalId: 'sup-1',
      externalId: expect.stringMatching(/^mock-supplier-\d{4}$/),
    });
    // The bijection in miniature: the same internal entity keeps the same external id.
    const second = expectOk(await adapter.syncSupplier(supplier));
    expect(second.reference).toEqual(first.reference);
  });

  it('posts invoices, credit notes and payments under their own entity types', async () => {
    const adapter = new MockAccountingAdapter(ORG);
    const posted = expectOk(await adapter.postVendorInvoice(invoice));
    expect(posted.reference?.entityType).toBe('invoice');
    const credit = expectOk(
      await adapter.postCreditNote({
        id: 'cr-1',
        supplierId: 'sup-1',
        invoiceId: 'inv-1',
        amount: 390,
        reason: 'סחורה פגומה',
      }),
    );
    expect(credit.reference?.entityType).toBe('credit_note');
    const payment = expectOk(
      await adapter.postPayment({
        id: 'pay-1',
        supplierId: 'sup-1',
        paidDate: '2026-08-05',
        amount: 4720,
        method: 'העברה בנקאית',
        reference: '781200',
      }),
    );
    expect(payment.reference?.entityType).toBe('payment');
    const status = expectOk(await adapter.updatePaymentStatus('pay-1', 'reconciled'));
    expect(status.value).toBe('reconciled');
  });

  it('answers null for an unmapped ledger account — an answer, not an error', async () => {
    const adapter = new MockAccountingAdapter(ORG);
    const missing = expectOk(await adapter.retrieveAccountMapping('supplier', 'sup-1'));
    expect(missing.value).toBeNull();
    adapter.setAccountMapping({
      entityType: 'supplier',
      internalId: 'sup-1',
      accountCode: '4001',
      accountName: 'ספקים',
    });
    const mapped = expectOk(await adapter.retrieveAccountMapping('supplier', 'sup-1'));
    expect(mapped.value?.accountCode).toBe('4001');
  });

  it('an injected failure surfaces exactly once, then the adapter recovers', async () => {
    const adapter = new MockAccountingAdapter(ORG);
    adapter.injectFailure({ code: 'provider_down', retryable: true });
    const failed = await adapter.postVendorInvoice(invoice);
    expect(failed).toMatchObject({
      status: 'failed',
      error: { code: 'provider_down', retryable: true },
    });
    expectOk(await adapter.postVendorInvoice(invoice));
  });

  it('an injected conflict carries its suggested resolution, then clears', async () => {
    const adapter = new MockAccountingAdapter(ORG);
    adapter.injectConflict('remote_wins', { code: 'duplicate_invoice_number' });
    const conflicted = await adapter.postVendorInvoice(invoice);
    expect(conflicted).toMatchObject({
      status: 'conflict',
      suggestedResolution: 'remote_wins',
      error: { code: 'duplicate_invoice_number' },
    });
    expectOk(await adapter.postVendorInvoice(invoice));
  });

  it('sync status reports honest nulls before any success and counts failures', async () => {
    const adapter = new MockAccountingAdapter(ORG);
    const before = await adapter.retrieveSyncStatus();
    expect(before.lastSuccessAt).toBeNull();
    adapter.injectFailure();
    await adapter.syncSupplier(supplier);
    await adapter.syncSupplier(supplier);
    const after = await adapter.retrieveSyncStatus();
    expect(after.failedCount).toBe(1);
    expect(after.lastSuccessAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
