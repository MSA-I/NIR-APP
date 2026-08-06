import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveInvoiceLinkedContext,
  type InvoiceContextOrder,
  type InvoiceContextReceipt,
  type InvoiceContextSupplier,
} from '../../../src/lib/invoiceLinkedContext.ts';

const order: InvoiceContextOrder = {
  id: 'f0000000-0000-4000-8000-000000000001',
  number: 17,
  supplier_id: 'aa000000-0000-4000-8000-000000000001',
  status: 'received',
};
const receipt: InvoiceContextReceipt = {
  id: 'f2000000-0000-4000-8000-000000000001',
  number: 23,
  order_id: order.id,
  received_at: '2026-06-02T04:30:00Z',
};
const supplier: InvoiceContextSupplier = { id: order.supplier_id, name: 'משק ירוק' };

test('matched order and receipt retain their exact save identifiers and supplier', () => {
  assert.deepEqual(resolveInvoiceLinkedContext(order.id, receipt.id, order, receipt, supplier), {
    status: 'linked', order, receipt, supplier, orderId: order.id, receiptId: receipt.id,
  });
});

test('receipt-only and direct invoice creation remain supported', () => {
  assert.deepEqual(resolveInvoiceLinkedContext(null, receipt.id, order, receipt, supplier), {
    status: 'linked', order, receipt, supplier, orderId: null, receiptId: receipt.id,
  });
  assert.deepEqual(resolveInvoiceLinkedContext(null, null, null, null, null), { status: 'none' });
});

test('malformed, missing, supplier-mismatched, and cross-order contexts are rejected as one non-disclosing state', () => {
  assert.deepEqual(resolveInvoiceLinkedContext('not-a-uuid', receipt.id, null, null, null), { status: 'invalid' });
  assert.deepEqual(resolveInvoiceLinkedContext(order.id, receipt.id, null, receipt, supplier), { status: 'invalid' });
  assert.deepEqual(resolveInvoiceLinkedContext(order.id, receipt.id, order, receipt, { ...supplier, id: crypto.randomUUID() }), { status: 'invalid' });
  assert.deepEqual(resolveInvoiceLinkedContext(order.id, receipt.id, order, { ...receipt, order_id: crypto.randomUUID() }, supplier), { status: 'invalid' });
});
