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

/**
 * The regression this file did not have.
 *
 * Every case below was refused before 27.08.2026, and the first three were replayed against the
 * production function that day and returned HTTP 400 `assistant_input_restricted`. None of them
 * sends a contact detail, a bank coordinate or a credential -- they NAME one, or they simply
 * contain a date. The five allowed cases the suite already had contained no date at all, which is
 * exactly why the gap survived review.
 */
Deno.test("naming a subject is not disclosing it, and a date is not a phone number", () => {
  const cases = [
    // Measured live in production, 27.08.2026.
    "מה קרה בתאריך 03.08.2026 בהזמנות?",
    "איך אני מוסיף ספק חדש עם פרטי בנק?",
    "מה קורה עם סניף 3 שלנו?",
    // Same shapes, other spellings.
    "כמה שילמתי לספקים בחודש 03.08.2026?",
    "מה קרה ב 02-08-2026 בהזמנה?",
    "תראה לי חשבוניות מ-01.07.2026 עד 09.08.2026",
    "מה הטלפון של ספק שטראוס?",
    "מי איש קשר אצל הספק הזה?",
    "מי איש הקשר אצל הספק הזה?",
    "למה חשבון בנק לא מסונכרן?",
    "שכחתי את הסיסמה למערכת, איך מאפסים?",
    "אפשר לשלוח לספק אימייל מהמערכת?",
    // A person who puts each thought on its own line has not pasted a document.
    "מה ההוצאה החודשית שלי?\nוגם מה ההכנסה?\nוגם מה הרווח?\nותן לי סיכום",
  ];

  for (const question of cases) {
    const result = classifyAssistantProviderText(question);
    assert.equal(result.allowed, true, question);
    assert.doesNotThrow(() => assertAssistantProviderTextAllowed(question));
  }
});

Deno.test("no calendar date in any written form reads as a phone number", () => {
  const separators = [".", "/", "-"];
  for (let month = 1; month <= 12; month += 1) {
    for (let day = 1; day <= 28; day += 1) {
      const dd = String(day).padStart(2, "0");
      const mm = String(month).padStart(2, "0");
      const written = [
        ...separators.map((sep) => `${dd}${sep}${mm}${sep}2026`),
        ...separators.map((sep) => `${day}${sep}${month}${sep}26`),
        `2026-${mm}-${dd}`,
      ];
      for (const date of written) {
        const question = `מה קרה בתאריך ${date}?`;
        assert.equal(
          classifyAssistantProviderText(question).allowed,
          true,
          question,
        );
      }
    }
  }
});

/**
 * The third case here used to be "מה מספר הוואטסאפ של איש הקשר?" -- a question that names a
 * contact and sends nothing. It is allowed from 27.08.2026 and is asserted as allowed in the
 * regression test above. What replaces it is the same question CARRYING the number, in the
 * spellings an Israeli actually writes: that is the disclosure this boundary exists to stop, and
 * every one of them is still refused.
 */
Deno.test("personal contact data is classified and refused before provider egress", () => {
  const cases = [
    "האימייל של הספק הוא buyer@example.com",
    "הטלפון של דוד הוא +972-50-123-4567",
    "מה מספר הוואטסאפ של איש הקשר? 050-123-4567",
    "תתקשר אליו ל־0501234567",
    "המספר במשרד הוא 03-1234567",
    "המספר במשרד הוא 031234567",
    "אפשר להשיג אותו ב 052 987 6543",
    "הנייד שלו 00972541234567",
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
    ["הסיסמה שלי היא Aa123456!", "provider_forbidden"],
    ["passwd=hunter2hunter2", "provider_forbidden"],
    ["מספר החשבון הוא 4580 9912 3344", "bank_restricted"],
    ["כרטיס אשראי 4580991233440011", "bank_restricted"],
    ["SWIFT POALILIT", "bank_restricted"],
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
