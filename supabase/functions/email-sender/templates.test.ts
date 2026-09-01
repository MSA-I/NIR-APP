import { esc, renderOrderEmail, TEMPLATE_VERSION } from './templates.ts';

function assert(condition: boolean, label: string): void {
  if (!condition) throw new Error(`templates assertion failed: ${label}`);
}

const input = {
  orgName: 'מסעדת הגן',
  supplierName: 'ירקות השדה',
  orderNumber: 42,
  revisionNumber: 1,
  expectedDate: '2026-08-27',
  notes: null,
  items: [
    { product_name: 'עגבניות שרי', unit: 'kg', qty: 5, unit_price: 8.9 },
    { product_name: 'מלפפון', unit: 'kg', qty: 2, unit_price: 7.5 },
  ],
  portalUrl: 'https://app.example.co.il/portal#token=abc',
  linkExpiresAt: '2026-09-03',
};

Deno.test('hebrew order email: RTL, subject, items, portal link, no ask-for-reply drift', () => {
  const rendered = renderOrderEmail('new_purchase_order', 'he', input);
  assert(rendered.subject.includes('#42'), 'subject carries the order number');
  assert(rendered.subject.includes('מסעדת הגן'), 'subject carries the org');
  assert(rendered.html.includes('dir="rtl"'), 'hebrew renders RTL');
  assert(rendered.html.includes('עגבניות שרי'), 'items rendered');
  assert(rendered.html.includes(input.portalUrl), 'portal link in html');
  assert(rendered.text.includes(input.portalUrl), 'portal link in text twin');
  assert(rendered.templateVersion === TEMPLATE_VERSION, 'version stamped');
  // #309 — the document system reached the email. The plate, the eyebrow and the filled item
  // head are what make this message and the same order's PDF read as one business, so they are
  // pinned rather than left to whoever edits the markup next.
  assert(rendered.html.includes('#0a171d'), 'the plate is drawn');
  assert(rendered.html.includes('PURCHASE'), 'the eyebrow names the family in the mono');
  assert(rendered.html.includes('הזמנת רכש חדשה'), 'the document names itself');
  assert(!rendered.html.includes('#003f47;padding'), 'the old oceanic button is gone');
});

Deno.test('the version moves when the markup does', () => {
  // The ledger stamps this on every delivered message; a redress that kept version 1 would make
  // two different emails indistinguishable in `email_order_messages`.
  assert(TEMPLATE_VERSION === 2, 'document-system markup is version 2');
});

Deno.test('english locale renders LTR with english copy', () => {
  const rendered = renderOrderEmail('new_purchase_order', 'en', input);
  assert(rendered.html.includes('dir="ltr"'), 'english renders LTR');
  assert(rendered.subject.startsWith('New purchase order #42'), 'english subject');
  assert(rendered.text.includes('Requested delivery date'), 'english labels');
});

Deno.test('revised template says revised, in both locales', () => {
  assert(renderOrderEmail('revised_purchase_order', 'he', input).subject.includes('מעודכנת'),
    'hebrew revised subject');
  assert(renderOrderEmail('revised_purchase_order', 'en', input).subject.startsWith('Updated'),
    'english revised subject');
});

Deno.test('tenant-controlled values cannot inject markup', () => {
  const hostile = renderOrderEmail('new_purchase_order', 'he', {
    ...input,
    orgName: '<script>alert(1)</script>',
    supplierName: '"><img src=x onerror=alert(1)>',
    notes: '<b>bold</b> & "quotes"',
    items: [{ product_name: '<style>*{display:none}</style>', unit: null, qty: 1, unit_price: 1 }],
  });
  assert(!hostile.html.includes('<script>'), 'script tags escaped');
  assert(!hostile.html.includes('<img'), 'element injection escaped');
  assert(!hostile.html.includes('<style>'), 'style tags escaped');
  assert(hostile.html.includes('&lt;script&gt;'), 'escaped form present');
  assert(hostile.html.includes('&lt;img'), 'escaped img form present');
});

Deno.test('esc covers the five html-significant characters', () => {
  assert(esc(`&<>"'`) === '&amp;&lt;&gt;&quot;&#39;', 'exact escape table');
});

Deno.test('missing expected date renders an honest "not set", never today', () => {
  const rendered = renderOrderEmail('new_purchase_order', 'he', { ...input, expectedDate: null });
  assert(rendered.text.includes('לא צוין'), 'hebrew unset date');
  const english = renderOrderEmail('new_purchase_order', 'en', { ...input, expectedDate: null });
  assert(english.text.includes('not set'), 'english unset date');
});
