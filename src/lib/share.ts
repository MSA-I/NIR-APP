import { supabase } from './supabase';
import { toHebrewError } from './errors';
import { fmtDate, fmtMoneyExact } from './format';
import { openExternalPopup } from './popup';

/**
 * The slice of a purchase order the WhatsApp share needs. Both the Orders list rows and the
 * OrderDetail record satisfy it structurally — this module owns the one send flow they share.
 */
export interface WhatsAppOrder {
  id: string;
  org_id: string;
  number: number;
  status: string;
  expected_date: string | null;
  notes: string | null;
  supplier: { phone: string | null; whatsapp: string | null };
  items: { qty: number; unit_price: number; product: { name: string; unit: string } }[];
}

/** wa.me deep link with the full order text prefilled (no WhatsApp Business API needed). */
export function orderWhatsAppLink(order: WhatsAppOrder, orgName: string): string | null {
  const raw = order.supplier.whatsapp || order.supplier.phone;
  if (!raw) return null;
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('0')) digits = '972' + digits.slice(1);
  const total = order.items.reduce((s, i) => s + i.qty * i.unit_price, 0);
  const lines = [
    `הזמנת רכש #${order.number}${orgName ? ` — ${orgName}` : ''}`,
    order.expected_date ? `אספקה מבוקשת: ${fmtDate(order.expected_date)}` : '',
    '',
    ...order.items.map((i) => `• ${i.product.name} — ${i.qty} ${i.product.unit}`),
    '',
    `סה"כ משוער: ${fmtMoneyExact(total)}`,
    order.notes ? `הערות: ${order.notes}` : '',
    'נא לאשר קבלת ההזמנה 🙏',
  ];
  return `https://wa.me/${digits}?text=${encodeURIComponent(lines.join('\n'))}`;
}

/**
 * Opens WhatsApp with the order text prefilled. **It does not touch the order's status.**
 *
 * It used to: opening the wa.me window was immediately followed by a transition to `sent`. But
 * wa.me only hands the draft message to WhatsApp — the person still has to press Send, and may
 * close the tab, pick the wrong contact, or edit the text and give up. There is no callback and
 * no receipt, so the app was recording a fact it could not observe, and `sent_at` — which the
 * on-time-delivery metric and the supplier's confirmation window both read — carried a
 * timestamp for a message that may never have left.
 *
 * `needsSentConfirmation` below decides whether to ASK afterwards; `markOrderSentToSupplier` is
 * the answer. Automatic confirmation waits for a verified WhatsApp Business delivery webhook.
 */
export function openOrderWhatsApp(order: WhatsAppOrder, orgName: string): { opened: boolean; error?: string } {
  const link = orderWhatsAppLink(order, orgName);
  if (!link) return { opened: false, error: 'לספק אין מספר WhatsApp זמין' };
  if (openExternalPopup(link) !== 'opened') {
    return { opened: false, error: 'הדפדפן חסם את חלון WhatsApp. יש לאפשר חלונות קופצים ולנסות שוב.' };
  }
  return { opened: true };
}

/** Only an order still on our side of the fence has anything to confirm. */
export function needsSentConfirmation(status: string): boolean {
  return status === 'draft' || status === 'ready';
}

/**
 * The human's answer to "did it actually go out?", through the existing reasoned server
 * transition — which is what stamps `sent_at`.
 */
export async function markOrderSentToSupplier(orderId: string): Promise<{ error?: string }> {
  const res = await supabase.rpc('transition_purchase_order_status', {
    p_purchase_order_id: orderId,
    p_target_status: 'sent',
    p_reason: 'המשתמש אישר שההזמנה נשלחה לספק',
    p_confirmation_note: null,
    p_expected_date: null,
  });
  return res.error ? { error: toHebrewError(res.error.message) } : {};
}

/** True when the Web Share API is available (mobile browsers, some desktops). */
export function canShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

/** Shares a Hebrew invoice summary (number, supplier, date, amount) via the Web Share API. */
export async function shareInvoice(
  inv: { invoice_number: string; invoice_date: string; total_amount: number },
  supplierName: string,
): Promise<void> {
  if (!canShare()) return;
  const text = [
    `חשבונית ${inv.invoice_number} — ${supplierName}`,
    `תאריך: ${fmtDate(inv.invoice_date)}`,
    `סה"כ: ${fmtMoneyExact(inv.total_amount)}`,
  ].join('\n');
  try {
    await navigator.share({ title: `חשבונית ${inv.invoice_number}`, text });
  } catch {
    // AbortError when the user dismisses the share sheet — nothing to surface.
  }
}
