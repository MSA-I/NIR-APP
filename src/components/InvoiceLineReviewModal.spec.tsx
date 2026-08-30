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
      ordered_quantity: 6, received_quantity: 6, unit: 'kg', unit_price: 42, currency: 'ILS',
    },
    {
      invoice_line_id: 'line-1', purchase_order_item_id: 'item-2',
      purchase_order_id: 'order-2', product_id: 'product-1',
      ordered_quantity: 4, received_quantity: 4, unit: 'kg', unit_price: 42, currency: 'ILS',
    },
    {
      invoice_line_id: 'line-2', purchase_order_item_id: 'item-3',
      purchase_order_id: 'order-3', product_id: 'product-2',
      ordered_quantity: 3, received_quantity: 3, unit: 'unit', unit_price: 5, currency: 'ILS',
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
    fireEvent.change(screen.getByLabelText('סיבת תיקון השורות (רשות)'), {
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
    fireEvent.change(screen.getByLabelText('סיבת ההקצאה הידנית (רשות)'), {
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

  // The two halves of the owner's 11.08.2026 ruling, one test per box: an empty reason must not
  // block a legitimate correction, and it must not reach the server as a blank either — the
  // command raises `reason_required` on a blank, and an audit row reading "" explains nothing.
  it('שומר תיקון שורות גם כשלא נכתבה סיבה, ושולח משפט ליומן', async () => {
    const onSaved = renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'שמירת שורות ובדיקה מחדש' }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));
    const payload = mocks.rpc.mock.calls[0][1] as { p_reason: string };
    expect(payload.p_reason).toContain('ללא הערה');
    expect(payload.p_reason.trim().length).toBeGreaterThan(0);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('שומר הקצאה ידנית גם כשלא נכתבה סיבה, ושולח משפט ליומן', async () => {
    const onSaved = renderModal();
    fireEvent.change(screen.getByLabelText('כמות להקצאה להזמנה 101'), { target: { value: '6' } });
    fireEvent.change(screen.getByLabelText('כמות להקצאה להזמנה 102'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'שמירת הקצאות ובדיקה מחדש' }));

    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));
    expect(mocks.rpc.mock.calls[0][0]).toBe('record_invoice_line_matches');
    const payload = mocks.rpc.mock.calls[0][1] as { p_reason: string };
    expect(payload.p_reason).toContain('ללא הערה');
    expect(payload.p_reason.trim().length).toBeGreaterThan(0);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});
