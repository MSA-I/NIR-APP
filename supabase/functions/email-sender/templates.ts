// email-sender/templates.ts -- versioned, escaped, bilingual order-delivery templates.
//
// Rendering is PURE and provable (Deno tests beside this file). Every tenant-controlled value
// passes esc() before touching HTML -- product names, org names and notes are attacker-adjacent
// input, and a template is exactly the place injection happens. TEMPLATE_VERSION is stamped on
// every ledger row (email_order_messages.template_version) so a delivered email can always be
// traced to the wording that produced it; changing anything here means bumping the version.
//
// The supplier sees RAW product wording (the 0149 rule) -- the snapshot already carries it.

export const TEMPLATE_VERSION = 1;

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

  const itemRows = input.items.map((item) => `
        <tr>
          <td style="padding:6px 10px;border-bottom:1px solid #e2e2df;"><bdi>${esc(item.product_name)}</bdi></td>
          <td style="padding:6px 10px;border-bottom:1px solid #e2e2df;white-space:nowrap;" dir="ltr">${item.qty} ${esc(item.unit ?? '')}</td>
        </tr>`).join('');

  const html = `<!doctype html>
<html dir="${copy.dir}" lang="${copy.lang}">
  <body style="margin:0;padding:24px;background:#f4f4f2;font-family:Arial,Helvetica,sans-serif;color:#1c2a2e;">
    <table role="presentation" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px;" width="100%">
      <tr><td>
        <p style="margin:0 0 4px;font-size:13px;color:#5a6b6e;">${esc(input.orgName)}</p>
        <h1 style="margin:0 0 16px;font-size:20px;">${esc(subject)}</h1>
        <p style="margin:0 0 12px;">${esc(copy.greeting(input.supplierName))}</p>
        <p style="margin:0 0 12px;">${esc(copy.intro(input.orgName, revised))}</p>
        <p style="margin:0 0 16px;"><strong>${esc(copy.expected)}:</strong> <span dir="ltr">${esc(expected)}</span></p>
        <h2 style="margin:0 0 8px;font-size:15px;">${esc(copy.itemsTitle(input.items.length))}</h2>
        <table role="presentation" width="100%" style="border-collapse:collapse;font-size:14px;">${itemRows}
        </table>
        ${input.notes ? `<p style="margin:16px 0 0;font-size:14px;"><strong>${esc(copy.notesTitle)}:</strong> <bdi>${esc(input.notes)}</bdi></p>` : ''}
        <p style="margin:24px 0 8px;">
          <a href="${esc(input.portalUrl)}"
             style="display:inline-block;background:#003f47;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold;">
            ${esc(copy.cta)}
          </a>
        </p>
        <p style="margin:0 0 8px;font-size:13px;color:#5a6b6e;">${esc(copy.ctaHint)}</p>
        ${expiry ? `<p style="margin:0;font-size:12px;color:#8a9699;">${esc(copy.expiry(expiry))}</p>` : ''}
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
