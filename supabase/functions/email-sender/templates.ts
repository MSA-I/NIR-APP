// email-sender/templates.ts -- versioned, escaped, bilingual order-delivery templates.
//
// Rendering is PURE and provable (Deno tests beside this file). Every tenant-controlled value
// passes esc() before touching HTML -- product names, org names and notes are attacker-adjacent
// input, and a template is exactly the place injection happens. TEMPLATE_VERSION is stamped on
// every ledger row (email_order_messages.template_version) so a delivered email can always be
// traced to the wording that produced it; changing anything here means bumping the version.
//
// The supplier sees RAW product wording (the 0149 rule) -- the snapshot already carries it.

/**
 * 2 — the document system (#309). The wording did not move; the dressing did, so an order that
 * arrives by email and the same order as a PDF now read as one business. Bumped because this file
 * says a change here bumps it, and because `email_order_messages.template_version` is what lets a
 * delivered message be traced back to the markup that produced it.
 */
export const TEMPLATE_VERSION = 2;

export type OrderTemplateName = 'new_purchase_order' | 'revised_purchase_order';
export type TemplateLocale = 'he' | 'en';

export interface OrderSnapshotItem {
  product_name: string;
  unit: string | null;
  qty: number;
  unit_price: number;
}

export interface OrderTemplateInput {
  orgName: string;
  supplierName: string | null;
  orderNumber: number;
  revisionNumber: number;
  expectedDate: string | null;
  notes: string | null;
  items: OrderSnapshotItem[];
  portalUrl: string;
  linkExpiresAt: string | null;
}

export function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// FSI/PDI isolation for names inside plain-text lines (the bidiIsolate rule from
// src/lib/format.ts -- markup is not available in text/plain).
const isolate = (s: string): string => `⁨${s}⁩`;

function fmtDate(value: string | null, locale: TemplateLocale): string {
  if (!value) return locale === 'he' ? 'לא צוין' : 'not set';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return locale === 'he' ? 'לא צוין' : 'not set';
  return new Intl.DateTimeFormat(locale === 'he' ? 'he-IL' : 'en-GB', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Jerusalem',
  }).format(date);
}

interface Copy {
  subject: (n: number, org: string, revised: boolean) => string;
  /** The family, in words, in the plate's corner — the document system's eyebrow (#309). */
  eyebrow: string;
  /** The document's own name. The subject still carries the number and the org; this does not. */
  heading: (revised: boolean) => string;
  itemColumn: string;
  qtyColumn: string;
  greeting: (supplier: string | null) => string;
  intro: (org: string, revised: boolean) => string;
  expected: string;
  itemsTitle: (count: number) => string;
  notesTitle: string;
  cta: string;
  ctaHint: string;
  expiry: (date: string) => string;
  dir: 'rtl' | 'ltr';
  lang: string;
}

const COPY: Record<TemplateLocale, Copy> = {
  he: {
    // The latin half is what actually gets drawn in the mono; see src/index.css's @font-face note.
    eyebrow: 'רכש · PURCHASE',
    heading: (revised) => revised ? 'הזמנת רכש מעודכנת' : 'הזמנת רכש חדשה',
    itemColumn: 'פריט',
    qtyColumn: 'כמות',
    subject: (n, org, revised) => revised
      ? `הזמנת רכש מעודכנת #${n} — ${org}`
      : `הזמנת רכש חדשה #${n} — ${org}`,
    greeting: (supplier) => supplier ? `שלום ${supplier},` : 'שלום,',
    intro: (org, revised) => revised
      ? `מצורפת גרסה מעודכנת של הזמנת הרכש מאת ${org}. הגרסה הקודמת בוטלה.`
      : `התקבלה הזמנת רכש חדשה מאת ${org}.`,
    expected: 'תאריך אספקה מבוקש',
    itemsTitle: (count) => `פריטים (${count})`,
    notesTitle: 'הערות',
    cta: 'לאישור ההזמנה או להצעת שינויים',
    ctaHint: 'בקישור ניתן לאשר את ההזמנה כפי שהיא, או להציע שינויים בכמות, במחיר או בתאריך האספקה — ללא צורך בחשבון.',
    expiry: (date) => `הקישור בתוקף עד ${date}.`,
    dir: 'rtl',
    lang: 'he',
  },
  en: {
    eyebrow: 'PURCHASE',
    heading: (revised) => revised ? 'Updated purchase order' : 'New purchase order',
    itemColumn: 'Item',
    qtyColumn: 'Quantity',
    subject: (n, org, revised) => revised
      ? `Updated purchase order #${n} — ${org}`
      : `New purchase order #${n} — ${org}`,
    greeting: (supplier) => supplier ? `Hello ${supplier},` : 'Hello,',
    intro: (org, revised) => revised
      ? `An updated version of the purchase order from ${org} is attached below. The previous version was cancelled.`
      : `A new purchase order from ${org} has been issued.`,
    expected: 'Requested delivery date',
    itemsTitle: (count) => `Items (${count})`,
    notesTitle: 'Notes',
    cta: 'Approve the order or propose changes',
    ctaHint: 'The link lets you approve the order as sent, or propose changes to quantities, prices or the delivery date — no account needed.',
    expiry: (date) => `The link is valid until ${date}.`,
    dir: 'ltr',
    lang: 'en',
  },
};

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  templateName: OrderTemplateName;
  templateVersion: number;
}

export function renderOrderEmail(
  templateName: OrderTemplateName,
  locale: TemplateLocale,
  input: OrderTemplateInput,
): RenderedEmail {
  const copy = COPY[locale];
  const revised = templateName === 'revised_purchase_order';
  const subject = copy.subject(input.orderNumber, input.orgName, revised);
  const expected = fmtDate(input.expectedDate, locale);
  const expiry = input.linkExpiresAt ? fmtDate(input.linkExpiresAt, locale) : null;

  const itemRows = input.items.map((item, index) => `
          <tr style="background:${index % 2 ? '#f4efe7' : '#fffcf8'};">
            <td style="padding:11px 12px;border-bottom:1px solid #e5dbcd;"><bdi>${esc(item.product_name)}</bdi></td>
            <td style="padding:11px 12px;border-bottom:1px solid #e5dbcd;white-space:nowrap;font-weight:bold;color:#0a171d;text-align:${copy.dir === 'rtl' ? 'left' : 'right'};" dir="ltr">${item.qty} ${esc(item.unit ?? '')}</td>
          </tr>`).join('');

  // Tables and inline hex, deliberately: Outlook has no flexbox and no CSS variables, and a
  // webfont is not worth a broken layout in the one place the business cannot re-send. The plate,
  // the eyebrow and the filled table head are the document system carried across in what email
  // can actually render — the display face falls back to Arial and that is the honest trade.
  const plate = '#0a171d';
  const html = `<!doctype html>
<html dir="${copy.dir}" lang="${copy.lang}">
  <body style="margin:0;padding:24px;background:#e8eef1;font-family:Arial,Helvetica,sans-serif;color:#46545b;">
    <table role="presentation" style="max-width:560px;margin:0 auto;background:#fffcf8;border-radius:12px;overflow:hidden;" width="100%">
      <tr><td style="background:${plate};padding:26px 28px 24px;">
        <table role="presentation" width="100%"><tr>
          <td style="font-family:'Courier New',Courier,monospace;font-size:12px;font-weight:bold;letter-spacing:0.18em;color:#5d9096;">${esc(copy.eyebrow)}</td>
          <td style="text-align:${copy.dir === 'rtl' ? 'left' : 'right'};font-size:12px;color:#7d8f95;">#${input.orderNumber}</td>
        </tr></table>
        <div style="font-size:31px;font-weight:bold;color:#fffcf8;padding-top:20px;line-height:1.1;">${esc(copy.heading(revised))}</div>
        <div style="font-size:13px;color:#a2b3b8;padding-top:8px;">${esc(input.orgName)}</div>
      </td></tr>
      <tr><td style="padding:24px 28px 0;">
        <p style="margin:0 0 8px;font-size:15px;">${esc(copy.greeting(input.supplierName))}</p>
        <p style="margin:0 0 18px;font-size:15px;line-height:1.6;">${esc(copy.intro(input.orgName, revised))}</p>
        <table role="presentation" width="100%" style="background:#f4efe7;border-radius:10px;"><tr>
          <td style="padding:13px 16px;font-size:13px;font-weight:bold;">${esc(copy.expected)}</td>
          <td style="padding:13px 16px;text-align:${copy.dir === 'rtl' ? 'left' : 'right'};font-size:16px;font-weight:bold;color:#003f47;" dir="ltr">${esc(expected)}</td>
        </tr></table>
        <p style="margin:22px 0 8px;font-size:11px;font-weight:bold;letter-spacing:0.09em;color:#63737a;">${esc(copy.itemsTitle(input.items.length))}</p>
        <table role="presentation" width="100%" style="border-collapse:collapse;font-size:15px;">
          <tr style="background:${plate};">
            <td style="padding:9px 12px;font-size:12px;font-weight:bold;color:#fffcf8;">${esc(copy.itemColumn)}</td>
            <td style="padding:9px 12px;font-size:12px;font-weight:bold;color:#fffcf8;text-align:${copy.dir === 'rtl' ? 'left' : 'right'};">${esc(copy.qtyColumn)}</td>
          </tr>${itemRows}
        </table>
        ${input.notes ? `<table role="presentation" width="100%" style="background:#f4efe7;border-radius:10px;margin-top:18px;"><tr><td style="padding:14px 16px;font-size:14px;line-height:1.55;"><strong>${esc(copy.notesTitle)}:</strong> <bdi>${esc(input.notes)}</bdi></td></tr></table>` : ''}
        <p style="margin:22px 0 0;">
          <a href="${esc(input.portalUrl)}"
             style="display:block;background:${plate};color:#fffcf8;padding:17px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px;text-align:center;">
            ${esc(copy.cta)}
          </a>
        </p>
        <p style="margin:9px 0 0;font-size:12px;line-height:1.55;color:#63737a;text-align:center;">${esc(copy.ctaHint)}</p>
      </td></tr>
      <tr><td style="padding:18px 28px 22px;">
        <table role="presentation" width="100%" style="border-top:1px solid #e5dbcd;"><tr>
          <td style="padding-top:14px;font-size:11px;color:#63737a;">${expiry ? esc(copy.expiry(expiry)) : ''}</td>
          <td style="padding-top:14px;text-align:${copy.dir === 'rtl' ? 'left' : 'right'};font-size:11px;color:#63737a;">InPlace</td>
        </tr></table>
      </td></tr>
    </table>
  </body>
</html>`;

  const text = [
    subject,
    '',
    copy.greeting(input.supplierName),
    copy.intro(input.orgName, revised),
    `${copy.expected}: ${expected}`,
    '',
    copy.itemsTitle(input.items.length) + ':',
    ...input.items.map((item) => `- ${isolate(item.product_name)} — ${item.qty} ${item.unit ?? ''}`.trimEnd()),
    ...(input.notes ? ['', `${copy.notesTitle}: ${isolate(input.notes)}`] : []),
    '',
    `${copy.cta}: ${input.portalUrl}`,
    copy.ctaHint,
    ...(expiry ? [copy.expiry(expiry)] : []),
  ].join('\n');

  return { subject, html, text, templateName, templateVersion: TEMPLATE_VERSION };
}
