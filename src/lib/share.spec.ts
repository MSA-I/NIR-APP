import { describe, expect, it, vi, beforeEach } from 'vitest';

const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
let rpcError: { message: string } | null = null;

vi.mock('./supabase', () => ({
  supabase: {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return { data: null, error: rpcError };
    },
  },
}));

let popupResult: 'opened' | 'blocked' | 'error' = 'opened';
const openedUrls: string[] = [];

vi.mock('./popup', () => ({
  openExternalPopup: (url: string) => {
    openedUrls.push(url);
    return popupResult;
  },
}));

import { openOrderWhatsApp, markOrderSentToSupplier, needsSentConfirmation, type WhatsAppOrder } from './share';

const order: WhatsAppOrder = {
  id: 'order-1',
  org_id: 'org-1',
  number: 42,
  status: 'ready',
  expected_date: '2026-08-12',
  notes: null,
  supplier: { phone: '050-1234567', whatsapp: null },
  items: [{ qty: 2, unit_price: 10, product: { name: 'עגבניות', unit: 'ק״ג' } }],
};

beforeEach(() => {
  rpcCalls.length = 0;
  openedUrls.length = 0;
  rpcError = null;
  popupResult = 'opened';
});

/**
 * The regression this file exists for: opening wa.me used to be followed immediately by a
 * transition to `sent`. wa.me only hands a draft message to WhatsApp — there is no delivery
 * signal — so the order was recorded as sent whether or not anyone pressed Send, and `sent_at`
 * (read by on-time-delivery and the supplier confirmation window) carried a fabricated time.
 */
describe('WhatsApp order send', () => {
  it('opens the message and changes nothing in the database', () => {
    const result = openOrderWhatsApp(order, 'המסעדה');

    expect(result).toEqual({ opened: true });
    expect(openedUrls[0]).toContain('https://wa.me/972501234567');
    expect(rpcCalls).toEqual([]);
  });

  it('reports a blocked popup and still changes nothing', () => {
    popupResult = 'blocked';
    const result = openOrderWhatsApp(order, 'המסעדה');

    expect(result.opened).toBe(false);
    expect(result.error).toMatch(/חלונות קופצים/);
    expect(rpcCalls).toEqual([]);
  });

  it('refuses a supplier with no reachable number', () => {
    const result = openOrderWhatsApp({ ...order, supplier: { phone: null, whatsapp: null } }, 'המסעדה');

    expect(result).toEqual({ opened: false, error: 'לספק אין מספר WhatsApp זמין' });
    expect(openedUrls).toEqual([]);
  });

  it('records the send only through the reasoned server transition', async () => {
    expect(await markOrderSentToSupplier('order-1')).toEqual({});

    expect(rpcCalls).toEqual([{
      name: 'transition_purchase_order_status',
      args: {
        p_purchase_order_id: 'order-1',
        p_target_status: 'sent',
        p_reason: 'המשתמש אישר שההזמנה נשלחה לספק',
        p_confirmation_note: null,
        p_expected_date: null,
      },
    }]);
  });

  it('surfaces a Hebrew error when the transition is refused', async () => {
    rpcError = { message: 'purchase_order_status_transition_not_allowed' };
    const result = await markOrderSentToSupplier('order-1');

    expect(result.error).toBeTruthy();
    expect(result.error).not.toContain('purchase_order_status_transition_not_allowed');
  });

  it('asks for confirmation only while the order is still on our side', () => {
    expect(needsSentConfirmation('draft')).toBe(true);
    expect(needsSentConfirmation('ready')).toBe(true);
    expect(needsSentConfirmation('sent')).toBe(false);
    expect(needsSentConfirmation('confirmed')).toBe(false);
    expect(needsSentConfirmation('received')).toBe(false);
    expect(needsSentConfirmation('cancelled')).toBe(false);
  });
});
