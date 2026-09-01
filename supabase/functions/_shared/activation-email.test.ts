// The activation email says the plan is live and nothing about the money.

import {
  ACTIVATION_TEMPLATE_VERSION,
  esc,
  readsAsProductEmail,
  renderActivationEmail,
} from "./activation-email.ts";

function eq(actual: unknown, expected: unknown, message?: string): void {
  const a = JSON.stringify(actual) ?? "undefined";
  const b = JSON.stringify(expected) ?? "undefined";
  if (a !== b) throw new Error(`${message ?? "not equal"}: got ${a}, expected ${b}`);
}

const APP = "https://app.inplace.digital";

Deno.test("both languages render, and neither reads as a receipt", () => {
  for (const locale of ["he", "en"] as const) {
    const rendered = renderActivationEmail(locale, { planLabel: "Pro", appUrl: APP });
    if (rendered.subject.length === 0) throw new Error(`${locale}: empty subject`);
    if (!rendered.text.includes(APP)) throw new Error(`${locale}: the way in is missing`);
    eq(readsAsProductEmail(rendered), true, `${locale} reads as a receipt`);
  }
});

Deno.test("the receipt sentence points at Paddle rather than issuing one", () => {
  // The customer must be able to find their receipt. Saying where it comes from is the difference
  // between helping and issuing a second commercial record for the same payment (#207).
  const he = renderActivationEmail("he", { planLabel: "Pro", appUrl: APP });
  const en = renderActivationEmail("en", { planLabel: "Pro", appUrl: APP });
  if (!he.text.includes("Paddle")) throw new Error("the Hebrew copy does not say where the receipt comes from");
  if (!en.text.includes("Paddle")) throw new Error("the English copy does not say where the receipt comes from");
});

Deno.test("an amount anywhere in the copy fails the product-email rule", () => {
  // The guard, exercised against what a future 'helpful' edit would look like.
  for (const poisoned of ["חויבתם ב-249 ₪", "You were charged $79", "כולל מע״מ", "1,490 ILS", "VAT included"]) {
    eq(
      readsAsProductEmail({ subject: "x", text: poisoned, html: "" }),
      false,
      `an amount slipped through: ${poisoned}`,
    );
  }
});

Deno.test("the plan label is escaped, because it reaches HTML", () => {
  const rendered = renderActivationEmail("en", {
    planLabel: '<img src=x onerror="alert(1)">',
    appUrl: APP,
  });
  // The property is that the label contributes no element and no attribute BOUNDARY. The literal
  // text `onerror=` surviving is fine and expected: with its quotes escaped to &quot; it is prose
  // inside a paragraph, not an attribute. Asserting on the substring alone would be asserting
  // that escaping deletes text, which is not what escaping does.
  if (rendered.html.includes("<img")) throw new Error("a plan label reached the HTML unescaped");
  if (/onerror\s*=\s*["']/.test(rendered.html)) {
    throw new Error("an attribute boundary survived escaping");
  }
  if (!rendered.html.includes("&lt;img")) throw new Error("the label was not escaped at all");
});

Deno.test("the app url is escaped, because it reaches an href", () => {
  const rendered = renderActivationEmail("en", {
    planLabel: "Pro",
    appUrl: 'https://app.inplace.digital" onclick="alert(1)',
  });
  if (rendered.html.includes('onclick="alert(1)"')) {
    throw new Error("a url broke out of its attribute");
  }
});

Deno.test("an unknown locale falls back to Hebrew rather than rendering nothing", () => {
  const rendered = renderActivationEmail("de" as unknown as "he", { planLabel: "Pro", appUrl: APP });
  if (rendered.subject.length === 0) throw new Error("an unknown locale produced an empty subject");
});

Deno.test("esc covers the five characters that matter", () => {
  eq(esc(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
});

Deno.test("the template carries a version, so a delivered email traces to its wording", () => {
  eq(typeof ACTIVATION_TEMPLATE_VERSION, "number");
  eq(ACTIVATION_TEMPLATE_VERSION >= 1, true);
});
