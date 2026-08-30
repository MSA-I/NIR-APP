import { toHebrewError } from './errors';
import { en } from './i18n/dictionaries/en';
import { translate, type TKey } from './i18n/t';
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

import { openOrderWhatsApp, orderWhatsAppText, markOrderSentToSupplier, needsSentConfirmation, shareInvoice, type WhatsAppOrder } from './share';

const shareFn = vi.fn();
const sayEn = (key: TKey, vars?: Record<string, string | number>) => translate(en, key, vars);

const order: WhatsAppOrder = {
  id: 'order-1',
  org_id: 'org-1',
  number: 42,
  status: 'ready',
  expected_date: '2026-08-12',
  notes: null,
  supplier: { name: 'ירקות השדה', phone: '050-1234567', whatsapp: null },
  items: [{ qty: 2, unit_price: 10, product: { name: 'עגבניות שרי 500 גרם', unit: 'ק״ג', sku: null } }],
};

beforeEach(() => {
  rpcCalls.length = 0;
  openedUrls.length = 0;
  rpcError = null;
  popupResult = 'opened';
  shareFn.mockReset();
  Object.defineProperty(navigator, 'share', { configurable: true, value: shareFn });
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
    expect(result.errorCode).toBe('popup_blocked');
    expect(rpcCalls).toEqual([]);
  });

  it('refuses a supplier with no reachable number', () => {
    const result = openOrderWhatsApp({ ...order, supplier: { name: 'ירקות השדה', phone: null, whatsapp: null } }, 'המסעדה');

    expect(result).toEqual({ opened: false, errorCode: 'missing_number' });
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

  it('carries the refusal CONDITION, which still resolves to a sentence at the screen', async () => {
    rpcError = { message: 'purchase_order_status_transition_not_allowed' };
    const result = await markOrderSentToSupplier('order-1');

    // The condition travels rather than a pre-resolved sentence, so the dialog can render it in
    // whichever language its reader is using. Both halves are asserted: what travelled, and that
    // it is still something a person can read.
    expect(result.error).toBe('purchase_order_status_transition_not_allowed');
    expect(toHebrewError(new Error(result.error!))).not.toContain('purchase_order_status_transition_not_allowed');
    expect(toHebrewError(new Error(result.error!))).toBeTruthy();
  });

  it('carries no price and points at the image message (owner decision 18.08.2026)', () => {
    const text = orderWhatsAppText(order, 'המסעדה');

    expect(text).not.toContain('סה"כ');
    expect(text).not.toContain('₪');
    expect(text).toContain('נשלח כתמונה בהודעה הבאה');
    expect(text).toContain('פריטים (1):');
    // Product names ride FSI…PDI so mixed Hebrew/digit names don't reorder in WhatsApp.
    expect(text).toContain('⁨עגבניות שרי 500 גרם⁩');
    // Conditional lines collapse instead of leaving blank lines (the old join-'' wart).
    expect(orderWhatsAppText({ ...order, expected_date: null, notes: null }, '')).not.toMatch(/\n\n\n/);
  });

  it('asks for confirmation only while the order is still on our side', () => {
    expect(needsSentConfirmation('draft')).toBe(true);
    expect(needsSentConfirmation('ready')).toBe(true);
    expect(needsSentConfirmation('sent')).toBe(false);
    expect(needsSentConfirmation('confirmed')).toBe(false);
    expect(needsSentConfirmation('received')).toBe(false);
    expect(needsSentConfirmation('cancelled')).toBe(false);
  });

  it('builds invoice share copy in the reader language and preserves supplier data', async () => {
    shareFn.mockResolvedValue(undefined);
    await shareInvoice({
      invoice_number: '1001',
      invoice_date: '2026-08-12',
      total_amount: 118,
      currency: 'ILS',
    }, 'ספק מקור', sayEn);

    expect(shareFn).toHaveBeenCalledOnce();
    const payload = shareFn.mock.calls[0][0] as { title: string; text: string };
    expect(payload.title).toContain('Invoice');
    expect(payload.text).toContain('Invoice');
    expect(payload.text).toContain('ספק מקור');
    expect(payload.text).toContain('Date:');
    expect(payload.text).toContain('Total:');
  });
});
