// Post-generation validation -- the piece that makes "evidence before eloquence" mechanical.
// Nothing here trusts the model: the answer is re-parsed against the canonical schema, every
// cited id must have been issued in THIS run, every numeral in a claim must be derivable from a
// cited fact under the product's own formatting rules, and a fact from a provider-forbidden
// classification can support nothing. An answer that fails twice ships no prose at all.
import {
  ASSISTANT_DRAFT_ROLES,
  ASSISTANT_SENT_CLAIM_PATTERNS,
  type AssistantAnswer,
  AssistantAnswerSchema,
  DIGIT_PATTERN,
  type Fact,
  mayReachProvider,
  type SourceReference,
} from "../../../src/lib/assistant/contracts.ts";
import {
  assistantSourceRouteDecision,
} from "../../../src/lib/assistant/routeAccess.ts";
import type { AssistantRole } from "../../../src/lib/assistant/contracts.ts";

export type ValidationResult =
  | { ok: true; answer: AssistantAnswer }
  | { ok: false; errors: string[] };

/** Maximal digit runs including grouping and decimal separators, Latin or Arabic-Indic. */
const NUMERAL_RUN = /[0-9٠-٩۰-۹][0-9٠-٩۰-۹.,]*/g;

/**
 * Three letters in a claim's text — one short word — is the floor for "this sentence says
 * something". Deliberately script-agnostic (`\p{L}`): the run's language is decided by the
 * question now, and a rule that counted Hebrew letters would pass an English answer and fail a
 * Hebrew one for no reason anybody could defend. A currency mark or a percent sign is not a word.
 */
const CLAIM_TEXT_HAS_WORDS = /\p{L}[\p{L}\s'’-]{2,}/u;

function toLatinDigits(value: string): string {
  return value
    .replace(
      /[٠-٩]/g,
      (digit) => String(digit.charCodeAt(0) - 0x0660),
    )
    .replace(
      /[۰-۹]/g,
      (digit) => String(digit.charCodeAt(0) - 0x06F0),
    );
}

function normalizeNumeral(token: string): string {
  return toLatinDigits(token).replace(/,/g, "").replace(/[.]+$/, "");
}

export function extractNumerals(text: string): string[] {
  const matches = text.match(NUMERAL_RUN) ?? [];
  return matches.map(normalizeNumeral).filter((token) => token.length > 0);
}

/**
 * Every rendering of a fact's VALUE the product itself would produce. For numbers that is the
 * raw value and its 0-2 decimal fixed forms (grouping separators are stripped from the claim
 * side, so "1,234" and "1234" meet in the middle). For strings it is the digit runs the server
 * itself wrote, plus the product's dotted date rendering for a calendar date.
 */
export function valueNumeralsForFact(fact: Fact): Set<string> {
  const allowed = new Set<string>();
  const value = fact.value;
  if (typeof value === "number" && Number.isFinite(value)) {
    allowed.add(String(value));
    allowed.add(value.toFixed(0));
    allowed.add(value.toFixed(1));
    allowed.add(value.toFixed(2));
  } else if (typeof value === "string") {
    allowed.add(normalizeNumeral(value));
    for (const run of extractNumerals(value)) allowed.add(run);
    const calendar = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (calendar) {
      const [, year, month, day] = calendar;
      allowed.add(`${day}.${month}.${year}`);
      allowed.add(`${Number(day)}.${Number(month)}.${year}`);
    }
  }
  allowed.delete("");
  return allowed;
}

// There is deliberately NO label-derived numeral pool. Labels carry tenant-authored text --
// supplier and product names legitimately contain digits ("ספק 2000") -- and any rule that
// admits label digits as quantities hands every claim citing that fact a free numeral. The
// ruling (2026-08-20): the numeral pool comes from fact VALUES only, never labels; windows and
// scopes are described in words, and mangling tenant names to make validation easier would be
// the wrong trade.

export function validateAnswer(
  raw: unknown,
  facts: readonly Fact[],
  sources: readonly SourceReference[],
  role?: AssistantRole,
): ValidationResult {
  const parsed = AssistantAnswerSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) =>
        `schema:${issue.path.join(".")}:${issue.message}`
      ),
    };
  }
  const answer = parsed.data;
  const errors: string[] = [];
  const factById = new Map(facts.map((fact) => [fact.id, fact]));
  const sourceIds = new Set(sources.map((source) => source.id));

  for (const source of sources) {
    const routeDecision = assistantSourceRouteDecision(source, role);
    if (routeDecision === "not_allowlisted") {
      errors.push(`source:${source.id}:route_not_allowlisted`);
    } else if (routeDecision === "not_permitted") {
      errors.push(`source:${source.id}:route_not_permitted`);
    }
  }

  answer.blocks.forEach((block, index) => {
    if (block.type === "text") {
      // The schema already refuses digits in text blocks; assert it anyway so a schema edit can
      // never silently drop the product's core invariant.
      if (DIGIT_PATTERN.test(block.text)) {
        errors.push(`block:${index}:text_block_contains_digits`);
      }
      return;
    }
    if (block.type === "draft") {
      // #191 is a role decision, not a rendering preference: accountant is offered no supplier
      // draft at all. An unknown role refuses too -- both live call sites pass one, so the only
      // way to arrive here without a role is a new caller that has not thought about this.
      if (!role || !ASSISTANT_DRAFT_ROLES.includes(role)) {
        errors.push(`block:${index}:draft_not_permitted`);
      }
      // Nothing in this product sends a supplier message, so a draft that says it was sent is a
      // false statement about the product itself -- the one lie no citation could ever support.
      //
      // EVERY language is checked, not the run's own. A Hebrew reader can ask for an English body
      // and an English reader for a Hebrew one; the model chooses the words. Gating the refusal on
      // the run locale would leave exactly one language unguarded per run, which is the same hole
      // in a smaller shape.
      if (Object.values(ASSISTANT_SENT_CLAIM_PATTERNS).some((p) => p.test(block.text))) {
        errors.push(`block:${index}:draft_claims_sent`);
      }
      const draftFacts: Fact[] = [];
      for (const factId of block.fact_ids) {
        const fact = factById.get(factId);
        if (!fact) {
          errors.push(`block:${index}:unknown_fact_id:${factId}`);
          continue;
        }
        if (!mayReachProvider(fact.classification)) {
          errors.push(`block:${index}:forbidden_fact_classification:${factId}`);
          continue;
        }
        draftFacts.push(fact);
      }
      for (const sourceId of block.source_ids) {
        if (!sourceIds.has(sourceId)) {
          errors.push(`block:${index}:unknown_source_id:${sourceId}`);
        }
      }
      // The digit rule is not relaxed for a message body. A reminder that names an order number
      // or a quantity is carrying a quantity, and it is pinned to cited VALUES exactly as a claim
      // is -- the union here spans every cited fact because a draft is a paragraph rather than a
      // single assertion, not because the bar is lower.
      const draftValues = new Set<string>();
      for (const fact of draftFacts) {
        for (const numeral of valueNumeralsForFact(fact)) draftValues.add(numeral);
      }
      for (const numeral of extractNumerals(block.text)) {
        if (!draftValues.has(numeral)) {
          errors.push(`block:${index}:numeral_without_fact:${numeral}`);
        }
      }
      return;
    }
    // A claim's text must SAY something (measured live 01.09.2026: one question came back as
    // four claim blocks whose entire text was "3", "500", "390" and "246.6" — the panel drew four
    // cards each carrying a bare number and no sentence, which is the "strange answer" the owner
    // reported). Every other rule here pins what a number may assert; none of them required the
    // assertion to exist. `claim_value` already carries the number, so the text that has no
    // letters at all is carrying nothing.
    if (!CLAIM_TEXT_HAS_WORDS.test(block.text)) {
      errors.push(`block:${index}:claim_text_is_not_a_sentence`);
    }
    const cited: Fact[] = [];
    for (const factId of block.fact_ids) {
      const fact = factById.get(factId);
      if (!fact) {
        errors.push(`block:${index}:unknown_fact_id:${factId}`);
        continue;
      }
      if (!mayReachProvider(fact.classification)) {
        errors.push(`block:${index}:forbidden_fact_classification:${factId}`);
        continue;
      }
      cited.push(fact);
    }
    const sameKind = cited.filter((fact) => fact.kind === block.claim_kind);
    if (sameKind.length === 0) {
      errors.push(`block:${index}:fact_does_not_support_claim_kind`);
    }
    const sameSubject = sameKind.filter((fact) => {
      if (fact.subject === null || block.subject === null) {
        return fact.subject === null && block.subject === null;
      }
      return fact.subject.entity === block.subject.entity &&
        fact.subject.id === block.subject.id;
    });
    if (sameKind.length > 0 && sameSubject.length === 0) {
      errors.push(`block:${index}:fact_does_not_support_claim_subject`);
    }
    const sameUnit = sameSubject.filter((fact) => fact.unit === block.claim_unit);
    if (sameSubject.length > 0 && sameUnit.length === 0) {
      errors.push(`block:${index}:fact_does_not_support_claim_unit`);
    }
    const supporting = sameUnit.filter((fact) => Object.is(fact.value, block.claim_value));
    if (sameUnit.length > 0 && supporting.length === 0) {
      errors.push(`block:${index}:fact_does_not_support_claim_value`);
    }
    for (const sourceId of block.source_ids) {
      if (!sourceIds.has(sourceId)) {
        errors.push(`block:${index}:unknown_source_id:${sourceId}`);
      }
    }
    // VALUES only. Every numeral in a claim must be a rendering of a cited fact's VALUE --
    // never a digit that happens to appear in a label. Otherwise citing the price-increase fact
    // (label "…ב-30 הימים…") makes "יש 30 חשבוניות כפולות" pass -- a quantity fabricated out of
    // somebody's window -- and a supplier named "ספק 2000" hands 2000 to every claim citing it.
    // A window or scope is described in words; the retry feedback teaches the model exactly that.
    const valueUnion = new Set<string>();
    for (const fact of supporting) {
      for (const numeral of valueNumeralsForFact(fact)) valueUnion.add(numeral);
    }
    for (const numeral of extractNumerals(block.text)) {
      if (!valueUnion.has(numeral)) {
        errors.push(`block:${index}:numeral_without_fact:${numeral}`);
      }
    }
  });

  // A digit-free clean sheet is still a claim about reality. When this run issued facts, prose
  // alone may not stand: the answer must anchor itself in at least one claim, or say WHY there
  // is no answer through the closed no_answer_reason vocabulary -- otherwise a failed tool could
  // read as a false all-clear.
  // A draft counts as an anchor because it is fact-pinned in the same way a claim is: its
  // `fact_ids` is required, and every numeral in it was checked against a cited value above.
  if (
    facts.length > 0 && answer.no_answer_reason === null &&
    !answer.blocks.some((block) => block.type === "claim" || block.type === "draft")
  ) {
    errors.push("answer:prose_only_without_claim_or_reason");
  }

  answer.next_steps.forEach((step, index) => {
    if (!sourceIds.has(step.source_id)) {
      errors.push(`next_step:${index}:unknown_source_id:${step.source_id}`);
    }
    if (DIGIT_PATTERN.test(step.label)) {
      // A next-step label is prose, not a claim; a quantity here has no citation to rest on.
      errors.push(`next_step:${index}:label_contains_digits`);
    }
  });

  return errors.length === 0 ? { ok: true, answer } : { ok: false, errors };
}
