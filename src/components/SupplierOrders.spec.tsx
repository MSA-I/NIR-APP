import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from './ui';
import { SupplierOrders, type SupplierPortalOrder } from './SupplierOrders';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));

const sent: SupplierPortalOrder = {
  id: 'order-sent',
  number: 17,
  status: 'sent',
  expected_date: '2026-08-20',
  sent_at: '2026-08-09T08:00:00Z',
  confirmed_at: null,
  items: [{
    id: 'item-1', product_name: 'עגבניות', unit: 'kg', supplier_sku: 'T-1',
    qty: 5, unit_price: 12, received_qty: 0,
  }],
};

const renderOrders = (canWrite: boolean, onChanged = vi.fn()) => render(
  <ToastProvider><SupplierOrders orders={[sent]} canWrite={canWrite} onChanged={onChanged} /></ToastProvider>,
);

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: { idempotent: false }, error: null });
});

describe('SupplierOrders', () => {
  it('keeps issued order details visible without exposing a write action in read-only mode', () => {
    renderOrders(false);
    expect(screen.getByText('הזמנה #17')).toBeInTheDocument();
    expect(screen.getByText('צפייה בפריטי ההזמנה')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'אישור קבלת ההזמנה' })).not.toBeInTheDocument();
  });

  it('acknowledges only through the reasoned status command without changing delivery date', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    renderOrders(true, onChanged);

    await user.click(screen.getByRole('button', { name: 'אישור קבלת ההזמנה' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('הערה (לא חובה)'), 'התקבל אצלנו');
    await user.click(within(dialog).getByRole('button', { name: 'אישור' }));

    await waitFor(() => expect(rpc).toHaveBeenCalledWith('transition_purchase_order_status', {
      p_purchase_order_id: 'order-sent',
      p_target_status: 'confirmed',
      p_reason: 'אישור קבלת הזמנה בפורטל הספק',
      p_confirmation_note: 'התקבל אצלנו',
      p_expected_date: null,
    }));
    expect(onChanged).toHaveBeenCalledOnce();
  });
});
