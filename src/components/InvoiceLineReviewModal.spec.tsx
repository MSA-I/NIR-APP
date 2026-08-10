import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from './ui';
import { InvoiceLineReviewModal, type InvoiceLineReviewAssessment } from './InvoiceLineReviewModal';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }));

const assessment: InvoiceLineReviewAssessment = {
  evidence_batch_id: 'batch-1',
  lines: [
    {
      id: 'line-1', line_number: 1, description: 'קמח', supplier_sku: 'SUP-1',
      barcode: '7290001', product_id: 'product-1', quantity: 10, unit: 'kg',
      unit_price: 42, discount_amount: 0, vat_rate: 17, line_total: 420, matches: [],
    },
    {
      id: 'line-2', line_number: 2, description: 'שימורים', supplier_sku: 'SUP-2',
      barcode: '7290002', product_id: 'product-2', quantity: 3, unit: 'unit',
      unit_price: 5, discount_amount: 0, vat_rate: 17, line_total: 15, matches: [],
    },
  ],
  candidate_context: [
    {
      invoice_line_id: 'line-1', purchase_order_item_id: 'item-1',
      purchase_order_id: 'order-1', product_id: 'product-1',
      ordered_quantity: 6, received_quantity: 6, unit: 'kg', unit_price: 42,
    },
    {
      invoice_line_id: 'line-1', purchase_order_item_id: 'item-2',
      purchase_order_id: 'order-2', product_id: 'product-1',
      ordered_quantity: 4, received_quantity: 4, unit: 'kg', unit_price: 42,
    },
    {
      invoice_line_id: 'line-2', purchase_order_item_id: 'item-3',
      purchase_order_id: 'order-3', product_id: 'product-2',
      ordered_quantity: 3, received_quantity: 3, unit: 'unit', unit_price: 5,
    },
  ],
};

function renderModal(onSaved = vi.fn()) {
  render(
    <ToastProvider>
      <InvoiceLineReviewModal
        invoiceId="invoice-1"
        actorId="actor-1"
        assessment={assessment}
        orderNumbers={{ 'order-1': 101, 'order-2': 102, 'order-3': 103 }}
        onClose={vi.fn()}
        onSaved={onSaved}
      />
    </ToastProvider>,
  );
  return onSaved;
}

describe('InvoiceLineReviewModal', () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.rpc.mockResolvedValue({ data: {}, error: null });
  });

  it('appends a reasoned manual evidence revision without using product name as identity', async () => {
    const onSaved = renderModal();
    fireEvent.change(screen.getByLabelText('סיבת תיקון השורות'), {
      target: { value: 'תיקון מול החשבונית המקורית' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'שמירת שורות ובדיקה מחדש' }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));
    expect(mocks.rpc).toHaveBeenCalledWith('record_invoice_line_evidence', expect.objectContaining({
      p_invoice_id: 'invoice-1',
      p_actor_id: 'actor-1',
      p_source_type: 'manual_entry',
      p_reason: 'תיקון מול החשבונית המקורית',
      p_lines: expect.arrayContaining([expect.objectContaining({
        description: 'קמח',
        supplier_sku: 'SUP-1',
        barcode: '7290001',
        product_id: 'product-1',
        quantity: 10,
      })]),
    }));
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('requires and records an exact explicit split across ambiguous linked orders', async () => {
    const onSaved = renderModal();
    fireEvent.change(screen.getByLabelText('כמות להקצאה להזמנה 101'), {
      target: { value: '6' },
    });
    fireEvent.change(screen.getByLabelText('כמות להקצאה להזמנה 102'), {
      target: { value: '4' },
    });
    fireEvent.change(screen.getByLabelText('סיבת ההקצאה הידנית'), {
      target: { value: 'פיצול מאומת מול שתי תעודות המשלוח' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'שמירת הקצאות ובדיקה מחדש' }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));
    expect(mocks.rpc).toHaveBeenCalledWith('record_invoice_line_matches', expect.objectContaining({
      p_invoice_id: 'invoice-1',
      p_evidence_batch_id: 'batch-1',
      p_reason: 'פיצול מאומת מול שתי תעודות המשלוח',
      p_matches: [
        { invoice_line_id: 'line-1', purchase_order_item_id: 'item-1', allocated_quantity: 6 },
        { invoice_line_id: 'line-1', purchase_order_item_id: 'item-2', allocated_quantity: 4 },
      ],
    }));
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});
