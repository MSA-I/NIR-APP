import assert from "node:assert/strict";
import {
  assertAssistantProviderTextAllowed,
  classifyAssistantProviderText,
} from "./input-classification.ts";
import { AssistantEdgeError } from "./errors.ts";

Deno.test("ordinary operational and financial questions may cross the provider boundary", () => {
  const cases = [
    "אילו תנועות בנק אינן מותאמות?",
    "מה היתרה של חשבונית INV-2026-18?",
    "למה הזמנה 1234 עדיין לא אושרה?",
    "כמה כסף ממתין לזיכוי?",
    "איזה ספק מאחר הכי הרבה?",
  ];

  for (const question of cases) {
    const result = classifyAssistantProviderText(question);
    assert.equal(result.allowed, true, question);
    assert.doesNotThrow(() => assertAssistantProviderTextAllowed(question));
  }
});

Deno.test("personal contact data is classified and refused before provider egress", () => {
  const cases = [
    "האימייל של הספק הוא buyer@example.com",
    "הטלפון של דוד הוא +972-50-123-4567",
    "מה מספר הוואטסאפ של איש הקשר?",
  ];

  for (const question of cases) {
    const result = classifyAssistantProviderText(question);
    assert.deepEqual(result, {
      allowed: false,
      classification: "personal_contact",
      reason: "personal_contact",
    });
    assert.throws(
      () => assertAssistantProviderTextAllowed(question),
      (error: unknown) =>
        error instanceof AssistantEdgeError &&
        error.code === "assistant_input_restricted",
    );
  }
});

Deno.test("bank credentials, secrets and raw document payloads fail closed", () => {
  const cases = [
    ["מספר חשבון הבנק הוא 123456 בסניף 001", "bank_restricted"],
    ["IBAN IL620108000000099999999", "bank_restricted"],
    ["service_role=sb_secret_1234567890", "provider_forbidden"],
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature", "provider_forbidden"],
    ["sk-proj-1234567890abcdefghijklmnop", "provider_forbidden"],
    ["sb_secret_1234567890abcdef", "provider_forbidden"],
    ["ghp_1234567890abcdefghijklmnopqrstuv", "provider_forbidden"],
    ["AKIAIOSFODNN7EXAMPLE", "provider_forbidden"],
    ["-----BEGIN OPENSSH PRIVATE KEY-----", "provider_forbidden"],
    ["password: correct horse battery staple", "provider_forbidden"],
    ["ser\u200Bvice_role=sb_secret_1234567890abcdef", "provider_forbidden"],
    ["data:image/png;base64,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "document_raw"],
    ["OCR raw:\nשורה א\nשורה ב\nשורה ג\nשורה ד", "document_raw"],
  ] as const;

  for (const [question, classification] of cases) {
    const result = classifyAssistantProviderText(question);
    assert.equal(result.allowed, false, question);
    assert.equal(result.classification, classification, question);
  }
});

Deno.test("classification is deterministic and never returns an unregistered class", () => {
  const first = classifyAssistantProviderText("מה מצב החשבוניות החודש?");
  const second = classifyAssistantProviderText("מה מצב החשבוניות החודש?");
  assert.deepEqual(first, second);
  assert.equal(first.allowed, true);
  assert.ok(
    ["public_product_metadata", "tenant_standard", "financial_sensitive"]
      .includes(first.classification),
  );
});
