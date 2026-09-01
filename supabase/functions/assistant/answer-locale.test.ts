// The language one run speaks. Owner ruling 01.09.2026: the QUESTION decides it, and the
// interface is only the fallback. The rule this replaced was measured live the same day — five
// runs across three question/interface combinations, every answer Hebrew, two of them under
// `locale: "en"` — so the interface setting had no observable effect at all.
import assert from "node:assert/strict";
import { resolveAnswerLocale } from "./reader-locale.ts";

Deno.test("the question decides, whatever the interface says", () => {
  assert.equal(resolveAnswerLocale("כמה כסף ממתין לזיכוי?", "en"), "he");
  assert.equal(resolveAnswerLocale("How much money is waiting to be credited?", "he"), "en");
  assert.equal(resolveAnswerLocale("כמה כסף ממתין לזיכוי?", "he"), "he");
  assert.equal(resolveAnswerLocale("How much money is waiting?", "en"), "en");
});

Deno.test("a Hebrew question keeps its language through the Latin a business question carries", () => {
  // Supplier names, currency codes and product codes are Latin inside ordinary Hebrew questions.
  // A rule that asked "does this contain Latin?" would answer half the Hebrew questions in
  // English, which is why the mark is the Hebrew script itself and not the absence of Latin.
  assert.equal(resolveAnswerLocale("מה היתרה של Strauss Group ב-ILS?", "he"), "he");
  assert.equal(resolveAnswerLocale("מה קרה עם PO-1042 מול Tnuva?", "en"), "he");
});

Deno.test("a question with no language in it falls back to the interface", () => {
  for (const locale of ["he", "en"] as const) {
    assert.equal(resolveAnswerLocale("1042", locale), locale);
    assert.equal(resolveAnswerLocale("???", locale), locale);
    assert.equal(resolveAnswerLocale("", locale), locale);
    // One or two stray letters are a typo, not a language.
    assert.equal(resolveAnswerLocale("ok", locale), locale);
  }
});
