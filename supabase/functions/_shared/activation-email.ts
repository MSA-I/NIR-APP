// activation-email.ts -- the product email that follows a verified paid activation.
//
// WHAT THIS IS ALLOWED TO SAY, AND WHAT IT MUST NOT. Paddle is the merchant of record (#207): it
// took the payment, so it issues the receipt, the invoice and the tax document, and it sends them
// itself. This email therefore carries NO amount, NO tax, NO invoice number and NO payment method.
// A second document describing the same money would not be a courtesy; it would be a second
// commercial record of one transaction, with our name on the one that is wrong.
//
// What it does carry is the thing Paddle has no way to say: the plan is live, this is what it is
// called, and here is the way in.
//
// THE PLAN NAME IS A LABEL, NEVER A DECISION. It is passed in from subscription_plans.label, which
// the ledger row already resolved through the provider price MAP. Nothing here derives a plan, and
// nothing here reads a provider payload -- 0187 dead-letters an unmapped price precisely so no
// code path downstream has to guess, and this is downstream.

/** Bumped whenever the wording changes, so a delivered email can be traced to its text. */
export const ACTIVATION_TEMPLATE_VERSION = 1;

export type ActivationLocale = 'he' | 'en';

export interface ActivationTemplateInput {
  planLabel: string;
  appUrl: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** Every interpolated value is escaped: a plan label is data, and a template is where injection
 *  happens (the email-sender/templates.ts rule, applied to the one template that lives here). */
export function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const COPY: Readonly<Record<ActivationLocale, {
  subject: (plan: string) => string;
  heading: string;
  body: (plan: string) => string;
  cta: string;
  receipt: string;
  dir: 'rtl' | 'ltr';
}>> = {
  he: {
    subject: (plan) => `המסלול ${plan} פעיל ב-InPlace`,
    heading: 'המנוי שלכם פעיל',
    body: (plan) => `המסלול ${plan} נפתח בחשבון שלכם, וכל מה שהוא כולל זמין מעכשיו.`,
    // Said plainly, because a customer who does not find the receipt here will look for it from
    // us, and the honest answer is that it comes from the payment provider.
    receipt: 'הקבלה והחשבונית נשלחות בנפרד על ידי Paddle, שמטפלת בתשלום.',
    cta: 'כניסה למערכת',
    dir: 'rtl',
  },
  en: {
    subject: (plan) => `Your ${plan} plan is live on InPlace`,
    heading: 'Your subscription is active',
    body: (plan) => `The ${plan} plan is open on your account, and everything it includes is available now.`,
    receipt: 'Your receipt and invoice are sent separately by Paddle, which handled the payment.',
    cta: 'Open InPlace',
    dir: 'ltr',
  },
};

export function renderActivationEmail(
  locale: ActivationLocale,
  input: ActivationTemplateInput,
): RenderedEmail {
  const copy = COPY[locale] ?? COPY.he;
  const url = esc(input.appUrl);

  const html = `<!doctype html><html dir="${copy.dir}"><body style="font-family:system-ui,sans-serif;`
    + `line-height:1.6;color:#1a1a1a;max-width:34rem;margin:0 auto;padding:1.5rem">`
    + `<h1 style="font-size:1.25rem;margin:0 0 1rem">${esc(copy.heading)}</h1>`
    // The whole sentence is escaped once, as one string. An earlier version escaped it and then
    // ran a replace to bold the plan name inside the result -- which is a second pass over
    // already-escaped output looking for a substring the escaping may have changed. Emphasis is
    // not worth a rule that subtle; the sentence goes in whole.
    + `<p style="margin:0 0 1rem">${esc(copy.body(input.planLabel))}</p>`
    + `<p style="margin:0 0 1.5rem"><a href="${url}" style="display:inline-block;padding:0.6rem 1.2rem;`
    + `background:#1f2937;color:#fff;text-decoration:none;border-radius:6px">${esc(copy.cta)}</a></p>`
    + `<p style="margin:0;font-size:0.875rem;color:#666">${esc(copy.receipt)}</p>`
    + `</body></html>`;

  const text = [
    copy.heading,
    '',
    copy.body(input.planLabel),
    '',
    `${copy.cta}: ${input.appUrl}`,
    '',
    copy.receipt,
  ].join('\n');

  return { subject: copy.subject(input.planLabel), html, text };
}

/**
 * What would turn this email into a second receipt, in either language. Exported so a test asserts
 * the rule instead of a reviewer having to remember it: the moment somebody adds "you were charged
 * ₪249" to be helpful, InPlace has issued a commercial record for money Paddle collected.
 *
 * NOTE WHAT IS NOT ON THIS LIST. The words "receipt" and "invoice" are allowed, because the
 * English copy uses both to say the receipt comes from somewhere else — pointing at a document is
 * the opposite of issuing one. What is forbidden is the CONTENT of a receipt: an amount, a
 * currency, a tax figure, or a tax-document number.
 */
export const FORBIDDEN_RECEIPT_TERMS: readonly string[] = [
  '₪', '$', '€', 'מע״מ', 'מע"מ', 'חשבונית מס', 'VAT',
];

/** True when the rendered email states no amount, currency, tax figure or tax-document number. */
export function readsAsProductEmail(rendered: RenderedEmail): boolean {
  const haystack = `${rendered.subject}\n${rendered.text}`;
  if (FORBIDDEN_RECEIPT_TERMS.some((term) => haystack.includes(term))) return false;
  // A bare number next to a currency word is the other shape an amount takes. Catching it here
  // means the rule survives a copy change that spells the currency out.
  return !/\d[\d,.]*\s*(ils|usd|eur|shekel|שקל|dollar)/i.test(haystack);
}
