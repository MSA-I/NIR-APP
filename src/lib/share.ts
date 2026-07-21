import { supabase } from './supabase';
import { logAction } from './audit';
import { toHebrewError } from './errors';
import { fmtDate, fmtMoneyExact } from './format';

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
 * Opens WhatsApp with the order text, marks a draft/ready order as sent (sent_at stamped) and
 * logs `order_sent_whatsapp` — the flow OrderDetail always had, now shared with the Orders
 * list. Returns whether the status changed (the caller toasts + refetches) and a Hebrew error
 * when the status update failed — in that case the message WAS still opened, which is the
 * truth the caller should report.
 */
export async function sendOrderWhatsApp(order: WhatsAppOrder, orgName: string): Promise<{ opened: boolean; statusChanged: boolean; error?: string }> {
  const link = orderWhatsAppLink(order, orgName);
  if (!link) return { opened: false, statusChanged: false };
  window.open(link, '_blank');
  void logAction({ orgId: order.org_id, action: 'order_sent_whatsapp', entityType: 'purchase_orders', entityId: order.id });
  if (order.status !== 'draft' && order.status !== 'ready') return { opened: true, statusChanged: false };
  const res = await supabase.from('purchase_orders')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .eq('id', order.id);
  if (res.error) return { opened: true, statusChanged: false, error: toHebrewError(res.error.message) };
  await logAction({ orgId: order.org_id, action: 'order_status:sent', entityType: 'purchase_orders', entityId: order.id });
  return { opened: true, statusChanged: true };
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
