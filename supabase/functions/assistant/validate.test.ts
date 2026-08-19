// Post-generation validation contracts. These pin the mechanical half of "evidence before
// eloquence": digits outside claims, ids from outside this run, numerals no cited fact supports
// and forbidden-class citations are all rejections -- not warnings.
import assert from "node:assert/strict";
import type {
  Fact,
  SourceReference,
} from "../../../src/lib/assistant/contracts.ts";
import {
  extractNumerals,
  validateAnswer,
  valueNumeralsForFact,
} from "./validate.ts";

function fact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: "f1",
    kind: "metric.count",
    subject: null,
    label: "חשבוניות שנקלטו ב-7 הימים האחרונים",
    value: 12,
    unit: "count",
    tool: "get_business_summary",
    as_of: "2026-08-20T10:00:00.000Z",
    classification: "tenant_standard",
    ...overrides,
  };
}

function source(overrides: Partial<SourceReference> = {}): SourceReference {
  return {
    id: "s1",
    entity: "organization",
    entity_id: "11111111-1111-4111-8111-111111111111",
    label: "חשבוניות",
    route: "/invoices",
    classification: "tenant_standard",
    ...overrides,
  };
}

function answer(blocks: unknown[], extra: Record<string, unknown> = {}) {
  return { blocks, next_steps: [], no_answer_reason: null, ...extra };
}

Deno.test("a valid claim citing an issued fact passes", () => {
  const result = validateAnswer(
    answer([
      { type: "text", text: "מצב הקליטה השבוע תקין." },
      { type: "claim", text: "נקלטו 12 חשבוניות בשבוע האחרון.", fact_ids: ["f1"], source_ids: ["s1"] },
    ]),
    [fact()],
    [source()],
  );
  assert.equal(result.ok, true);
});

Deno.test("digits in a text block are rejected", () => {
  const result = validateAnswer(
    answer([{ type: "text", text: "נקלטו 12 חשבוניות." }]),
    [fact()],
    [source()],
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.some((error) =>
      error.includes("text_block_contains_digits")
    ));
  }
});

Deno.test("Arabic-Indic digits in a text block are rejected too", () => {
  const result = validateAnswer(
    answer([{ type: "text", text: "נקלטו ١٢ חשבוניות." }]),
    [fact()],
    [source()],
  );
  assert.equal(result.ok, false);
});

Deno.test("a fact id not issued in this run is rejected", () => {
  const result = validateAnswer(
    answer([{
      type: "claim",
      text: "נקלטו 12 חשבוניות.",
      fact_ids: ["f9"],
      source_ids: [],
    }]),
    [fact()],
    [],
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.some((error) =>
      error.includes("unknown_fact_id:f9")
    ));
  }
});

Deno.test("a source id not issued in this run is rejected", () => {
  const result = validateAnswer(
    answer([{
      type: "claim",
      text: "נקלטו 12 חשבוניות.",
      fact_ids: ["f1"],
      source_ids: ["s7"],
    }]),
    [fact()],
    [source()],
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.some((error) =>
      error.includes("unknown_source_id:s7")
    ));
  }
});

Deno.test("a numeral no cited fact supports is rejected", () => {
  const result = validateAnswer(
    answer([{
      type: "claim",
      text: "נקלטו 13 חשבוניות.",
      fact_ids: ["f1"],
      source_ids: [],
    }]),
    [fact()],
    [],
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.some((error) =>
      error.includes("numeral_without_fact:13")
    ));
  }
});

Deno.test("grouped and fixed renderings of a cited money value pass", () => {
  const money = fact({
    id: "f1",
    kind: "metric.money",
    label: "סכום פתוח בדרישות תשלום",
    value: 1234.5,
    unit: "ils",
  });
  for (const text of ["הסכום הפתוח הוא 1,234.50 שקלים.", "בסך 1234.5 ש\"ח."]) {
    const result = validateAnswer(
      answer([{ type: "claim", text, fact_ids: ["f1"], source_ids: [] }]),
      [money],
      [],
    );
    assert.equal(result.ok, true, text);
  }
});

Deno.test("a label digit is never a legal numeral -- values only, windows in words", () => {
  // f1's label carries "7" ("…ב-7 הימים האחרונים"); its value is 12. Quoting the window digit is
  // refused even alongside the value -- the window is described in words instead.
  const withLabelDigit = validateAnswer(
    answer([{
      type: "claim",
      text: "נקלטו 12 חשבוניות במהלך 7 הימים האחרונים.",
      fact_ids: ["f1"],
      source_ids: [],
    }]),
    [fact()],
    [],
  );
  assert.equal(withLabelDigit.ok, false);
  if (!withLabelDigit.ok) {
    assert.ok(withLabelDigit.errors.some((error) =>
      error.includes("numeral_without_fact:7")
    ));
  }
  const inWords = validateAnswer(
    answer([{
      type: "claim",
      text: "נקלטו 12 חשבוניות בשבוע האחרון.",
      fact_ids: ["f1"],
      source_ids: [],
    }]),
    [fact()],
    [],
  );
  assert.equal(inWords.ok, true);
});

Deno.test("a claim citing a provider-forbidden fact is rejected", () => {
  const banking = fact({ id: "f1", classification: "bank_restricted" });
  const result = validateAnswer(
    answer([{
      type: "claim",
      text: "נקלטו 12 חשבוניות.",
      fact_ids: ["f1"],
      source_ids: [],
    }]),
    [banking],
    [],
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.some((error) =>
      error.includes("forbidden_fact_classification")
    ));
  }
});

Deno.test("next_steps must point at issued sources and carry no digits", () => {
  const bad = validateAnswer(
    answer(
      [{ type: "text", text: "אין ממצאים חריגים." }],
      {
        next_steps: [
          { label: "פתח 3 חשבוניות", source_id: "s9" },
        ],
      },
    ),
    [fact()],
    [source()],
  );
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.ok(bad.errors.some((error) => error.includes("unknown_source_id:s9")));
    assert.ok(bad.errors.some((error) =>
      error.includes("label_contains_digits")
    ));
  }
});

Deno.test("a calendar-date fact admits the product's dotted rendering", () => {
  const dated = fact({
    id: "f1",
    kind: "invoice.status",
    value: "2026-08-19",
    unit: "date",
    label: "תאריך קליטה אחרון",
  });
  const result = validateAnswer(
    answer([{
      type: "claim",
      text: "החשבונית האחרונה נקלטה ב-19.08.2026.",
      fact_ids: ["f1"],
      source_ids: [],
    }]),
    [dated],
    [],
  );
  assert.equal(result.ok, true);
});

Deno.test("numeral extraction normalizes grouping and Arabic-Indic digits", () => {
  assert.deepEqual(extractNumerals("סכום 1,234.50 ועוד ١٢"), [
    "1234.50",
    "12",
  ]);
  const values = valueNumeralsForFact(fact({ value: 1234.5 }));
  assert.ok(values.has("1234.50"));
  assert.ok(values.has("1234.5"));
  assert.ok(values.has("1235"));
});

Deno.test("a label numeral cannot be borrowed by a claim as a quantity (cross-fact attack)", () => {
  // The adversarial case: cite the price-increase fact -- whose LABEL contributes "30" -- and
  // present that 30 as a count of duplicate invoices. Membership would pass it; pairing refuses.
  const priceFact = fact({
    id: "f1",
    kind: "alert.occurrence",
    label: "מחירים שעלו ב-30 הימים האחרונים",
    value: 4,
  });
  const result = validateAnswer(
    answer([{
      type: "claim",
      text: "יש 30 חשבוניות כפולות.",
      fact_ids: ["f1"],
      source_ids: [],
    }]),
    [priceFact],
    [],
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.some((error) =>
      error.includes("numeral_without_fact:30")
    ));
  }
});

Deno.test("a tenant-authored name with digits never leaks a numeral into claims", () => {
  // A supplier legitimately named with digits: the name rides in the LABEL, untouched (mangling
  // tenant data to ease validation would be the wrong trade) -- and contributes nothing to the
  // numeral pool.
  const named = fact({
    id: "f1",
    kind: "metric.count",
    label: "חשבוניות פתוחות של ספק 2000",
    value: 3,
  });
  const valueOnly = validateAnswer(
    answer([{
      type: "claim",
      text: "לספק יש 3 חשבוניות פתוחות.",
      fact_ids: ["f1"],
      source_ids: [],
    }]),
    [named],
    [],
  );
  assert.equal(valueOnly.ok, true);
  const borrowed = validateAnswer(
    answer([{
      type: "claim",
      text: "לספק 2000 יש 3 חשבוניות פתוחות.",
      fact_ids: ["f1"],
      source_ids: [],
    }]),
    [named],
    [],
  );
  assert.equal(borrowed.ok, false);
  if (!borrowed.ok) {
    assert.ok(borrowed.errors.some((error) =>
      error.includes("numeral_without_fact:2000")
    ));
  }
});

Deno.test("prose alone cannot stand when facts were issued -- claim or named reason required", () => {
  const unanchored = validateAnswer(
    answer([{ type: "text", text: "אין חשבוניות כפולות." }]),
    [fact()],
    [],
  );
  assert.equal(unanchored.ok, false);
  if (!unanchored.ok) {
    assert.ok(unanchored.errors.some((error) =>
      error.includes("prose_only_without_claim_or_reason")
    ));
  }
  const reasoned = validateAnswer(
    answer(
      [{ type: "text", text: "לא ניתן היה למדוד את הנתון הזה." }],
      { no_answer_reason: "not_measured" },
    ),
    [fact()],
    [],
  );
  assert.equal(reasoned.ok, true);
  // With no facts issued at all (no tool ran), plain prose remains legal.
  const smalltalk = validateAnswer(
    answer([{ type: "text", text: "שלום! איך אפשר לעזור?" }]),
    [],
    [],
  );
  assert.equal(smalltalk.ok, true);
});

Deno.test("a null-valued fact supports no numerals at all", () => {
  const unmeasured = fact({ id: "f1", value: null, label: "סכום פתוח" });
  const result = validateAnswer(
    answer([{
      type: "claim",
      text: "הסכום הפתוח הוא 0.",
      fact_ids: ["f1"],
      source_ids: [],
    }]),
    [unmeasured],
    [],
  );
  assert.equal(result.ok, false);
});
