import { supabase } from './supabase';
import { bidiIsolate, fmtDate, fmtMoneyExact, formatQuantity } from './format';
import { openExternalPopup } from './popup';
import type { TKey } from './i18n/t';

/**
 * The slice of a purchase order the WhatsApp share needs. Both the Orders list rows and the
 * OrderDetail record satisfy it structurally — this module owns the one send flow they share.
 *
 * `product` carries the RAW catalogue name and nothing else, and that is the contract, not an
 * omission: everything in this file is read by the supplier, who recognises their own wording for
 * an item. A canonical name the business approved for its own screens would arrive at somebody
 * who has never seen it and cannot act on it. `productLabel` in ./format.ts states the whole
 * rule, and `productLabel.spec.ts` fails the build if this file ever reaches for it.
 */
export interface WhatsAppOrder {
  id: string;
  org_id: string;
  number: number;
  status: string;
  expected_date: string | null;
  notes: string | null;
  supplier: { name: string; phone: string | null; whatsapp: string | null };
  items: { qty: number; unit_price: number; product: { name: string; unit: string; sku: string | null } }[];
}

/**
 * The first of the two WhatsApp messages: a compact, priced-nothing text.
 *
 * No total line ON PURPOSE (owner decision 18.08.2026): the chat message is the one artifact
 * that gets forwarded around a supplier's shop floor, and the snapshot total is a negotiation
 * fact, not a picking fact. The item list stays — it is the complete fallback when the operator
 * never attaches the image the closing line promises. Product names ride FSI/PDI so mixed
 * Hebrew/digit names don't reorder inside WhatsApp (חוק בידוד השמות).
 */
export function orderWhatsAppText(order: WhatsAppOrder, orgName: string, portalUrl?: string | null): string {
  return [
    `הזמנת רכש #${order.number}${orgName ? ` — ${orgName}` : ''}`,
    ...(order.expected_date ? [`אספקה מבוקשת: ${fmtDate(order.expected_date)}`] : []),
    ...(order.notes ? [`הערות: ${order.notes}`] : []),
    '',
    `פריטים (${order.items.length}):`,
    // The unit is pinned to Hebrew for the same reason the product name is raw: this message is
    // read by the supplier, not by the person who sent it. An English `2 crates` would arrive at
    // a picker who counts ארגזים, and the whole message around it is Hebrew anyway.
    ...order.items.map((i) => `• ${bidiIsolate(i.product.name)} — ${formatQuantity(i.qty, i.product.unit, 'he')}`),
    '',
    // The portal link (0167) rides the message when the operator issued one: the supplier can
    // approve or propose changes there instead of answering in free text. The closing lines
    // adjust — with a portal there is a button to press, without one we ask for a reply.
    ...(portalUrl
      ? [`לאישור ההזמנה או להצעת שינויים: ${portalUrl}`, '']
      : []),
    '📎 פירוט מלא של ההזמנה נשלח כתמונה בהודעה הבאה.',
    ...(portalUrl ? [] : ['נא לאשר את קבלת ההזמנה 🙏']),
  ].join('\n');
}

/** wa.me deep link with the order text prefilled (no WhatsApp Business API needed). */
export function orderWhatsAppLink(order: WhatsAppOrder, orgName: string, portalUrl?: string | null): string | null {
  const raw = order.supplier.whatsapp || order.supplier.phone;
  if (!raw) return null;
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('0')) digits = '972' + digits.slice(1);
  return `https://wa.me/${digits}?text=${encodeURIComponent(orderWhatsAppText(order, orgName, portalUrl))}`;
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
export type OpenOrderWhatsAppErrorCode = 'missing_number' | 'popup_blocked';
export const OPEN_ORDER_WHATSAPP_ERROR_KEY: Readonly<Record<OpenOrderWhatsAppErrorCode, TKey>> = {
  missing_number: 'share.whatsappMissingNumber',
  popup_blocked: 'share.whatsappPopupBlocked',
};
export function openOrderWhatsApp(order: WhatsAppOrder, orgName: string, portalUrl?: string | null): {
  opened: boolean;
  errorCode?: OpenOrderWhatsAppErrorCode;
} {
  const link = orderWhatsAppLink(order, orgName, portalUrl);
  if (!link) return { opened: false, errorCode: 'missing_number' };
  if (openExternalPopup(link) !== 'opened') {
    return { opened: false, errorCode: 'popup_blocked' };
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
  // The condition, not a sentence: WhatsAppSendDialog draws it and resolves it there.
  return res.error ? { error: res.error.message } : {};
}

/** True when the Web Share API is available (mobile browsers, some desktops). */
export function canShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

/** True when the platform can hand these FILES to a share target (mobile; not desktop Chrome). */
export function canShareFiles(files: File[]): boolean {
  return typeof navigator !== 'undefined'
    && typeof navigator.canShare === 'function'
    && typeof navigator.share === 'function'
    && navigator.canShare({ files });
}

/**
 * Delivers the rendered order image: the share sheet where files can travel (the user picks
 * WhatsApp there), an anchor download everywhere else (the user drags it into the wa.me window
 * the text message opened). The caller pre-renders the blob so this runs synchronously inside
 * the click's user activation — an await gap before navigator.share() burns it on Safari.
 */
export async function shareOrderImage(blob: Blob, fileName: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const file = new File([blob], fileName, { type: 'image/png' });
  if (canShareFiles([file])) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch {
      return 'cancelled'; // AbortError — the user dismissed the sheet
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
  return 'downloaded';
}

/** Shares a Hebrew invoice summary (number, supplier, date, amount) via the Web Share API. */
export async function shareInvoice(
  inv: { invoice_number: string; invoice_date: string; total_amount: number },
  supplierName: string,
  t: (key: TKey, vars?: Record<string, string | number>) => string,
): Promise<void> {
  if (!canShare()) return;
  const text = [
    t('share.invoiceLine', {
      number: bidiIsolate(inv.invoice_number),
      supplier: bidiIsolate(supplierName),
    }),
    t('share.invoiceDateLine', { date: fmtDate(inv.invoice_date) }),
    t('share.invoiceTotalLine', { total: fmtMoneyExact(inv.total_amount) }),
  ].join('\n');
  try {
    await navigator.share({
      title: t('share.invoiceTitle', { number: bidiIsolate(inv.invoice_number) }),
      text,
    });
  } catch {
    // AbortError when the user dismisses the share sheet — nothing to surface.
  }
}
