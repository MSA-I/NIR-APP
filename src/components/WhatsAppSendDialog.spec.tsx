import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from './ui';
import type { WhatsAppOrder } from '../lib/share';

/**
 * The dialog's contract: two explicit steps, the image button waits for real bytes, a render
 * failure keeps the text path alive, and closing reports whether the text window was opened —
 * without ever touching order status (the call sites run the human confirmation afterwards).
 */
const renderState = vi.hoisted(() => ({
  resolve: null as null | ((blob: Blob) => void),
  reject: null as null | ((e: Error) => void),
}));
vi.mock('../lib/orderImage', () => ({
  renderOrderImage: () => new Promise<Blob>((resolve, reject) => {
    renderState.resolve = resolve;
    renderState.reject = reject;
  }),
  orderImageFileName: (order: { number: number }) => `order-${order.number}.png`,
}));

const shareCalls = vi.hoisted(() => ({ share: [] as string[], popup: [] as string[] }));
vi.mock('../lib/popup', () => ({
  openExternalPopup: (url: string) => { shareCalls.popup.push(url); return 'opened'; },
}));
const rpcCalls: string[] = [];
vi.mock('../lib/supabase', () => ({
  supabase: { rpc: async (name: string) => { rpcCalls.push(name); return { data: null, error: null }; } },
}));

import { WhatsAppSendDialog } from './WhatsAppSendDialog';

const order: WhatsAppOrder = {
  id: 'order-1', org_id: 'org-1', number: 42, status: 'ready',
  expected_date: null, notes: null,
  supplier: { name: 'ירקות השדה', phone: '050-1234567', whatsapp: null },
  items: [{ qty: 2, unit_price: 10, product: { name: 'עגבניות', unit: 'ק״ג', sku: null } }],
};

function renderDialog(onClose = vi.fn()) {
  render(
    <ToastProvider>
      <WhatsAppSendDialog order={order} orgName="המסעדה" onClose={onClose} />
    </ToastProvider>,
  );
  return onClose;
}

beforeEach(() => {
  renderState.resolve = null;
  renderState.reject = null;
  shareCalls.share.length = 0;
  shareCalls.popup.length = 0;
  rpcCalls.length = 0;
  // jsdom: no URL.createObjectURL
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});

describe('WhatsAppSendDialog', () => {
  it('disables the image step until the render lands, then previews exactly what will be sent', async () => {
    renderDialog();

    const imageButton = screen.getByRole('button', { name: /2\. .*תמונת ההזמנה/ });
    expect(imageButton).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('מכין את תמונת ההזמנה');

    renderState.resolve!(new Blob(['png'], { type: 'image/png' }));
    await waitFor(() => expect(imageButton).toBeEnabled());
    expect(screen.getByRole('img', { name: /תצוגה מקדימה/ })).toHaveAttribute('src', 'blob:preview');
  });

  it('keeps the text step alive when the render fails, and says so', async () => {
    renderDialog();
    renderState.reject!(new Error('לא ניתן היה להפיק את תמונת ההזמנה'));

    expect(await screen.findByText(/ניתן לשלוח את הודעת הטקסט בלבד/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '1. שליחת הודעת הטקסט' }));
    expect(shareCalls.popup).toHaveLength(1);
    expect(shareCalls.popup[0]).toContain('https://wa.me/972501234567');
  });

  it('reports through onClose whether the text window was opened — and never touches the RPC', async () => {
    const user = userEvent.setup();
    const onClose = renderDialog();

    await user.click(screen.getByRole('button', { name: '1. שליחת הודעת הטקסט' }));
    await user.click(screen.getByRole('button', { name: 'סיום' }));

    expect(onClose).toHaveBeenCalledWith(true);
    expect(rpcCalls).toEqual([]);
  });

  it('closing without opening the text reports false', async () => {
    const user = userEvent.setup();
    const onClose = renderDialog();

    await user.click(screen.getByRole('button', { name: 'סיום' }));
    expect(onClose).toHaveBeenCalledWith(false);
    expect(rpcCalls).toEqual([]);
  });
});
