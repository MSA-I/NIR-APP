/**
 * proposeDisplayName — the one place a raw catalogue name is turned into a canonical one.
 *
 * A product has exactly one hand-typed `name`, and twenty-five screens render it raw. The owner
 * asked for a canonical form: identify the product type, keep a meaningful size, drop the brand
 * and the supplier's filler — `שמן קנולה 100 מ״ל חברת דגן200cc` should read as canola oil at one
 * stated size. This module proposes that form. It does not apply it.
 *
 * THREE THINGS THIS MODULE IS NOT, each for a measured reason.
 *
 * 1. It is NOT a render-time helper. The proposal is written once, to `products.display_name`,
 *    by a human approving it; every screen then reads a column. Normalising per render would run
 *    a guess on every paint, and would make the displayed name a function of whatever the parser
 *    happened to believe today rather than of what a person approved. `productDisplayName.spec.ts`
 *    enforces this with a guard: no file under `src/pages/` or `src/components/` may import it.
 *
 * 2. It has NO SQL twin, deliberately. `nameKey` has one (`private.name_match_key`, parity-pinned)
 *    because *matching* genuinely happens on both sides — the client compares a spreadsheet row to
 *    a catalogue row, and the server does too, so one answer must hold across the boundary. Display
 *    naming happens in exactly one place: a screen where a person approves a proposal. A PL/pgSQL
 *    re-implementation would have no caller, and an uncalled second implementation is just a second
 *    answer waiting to disagree with the first. This is the kind of symmetry that gets built by
 *    reflex; it is being declined on purpose.
 *
 * 3. It NEVER decides a brand. `חברת דגן` is dropped because the name literally says `חברת` —
 *    the text declares it. But `תנובה` in `קוטג׳ תנובה` may well be the thing the kitchen actually
 *    orders, and no list this module could carry would know the difference. Which words in this
 *    catalogue are brands is the owner's knowledge. The review screen is where that gets settled.
 *
 * THE CONSTRAINT THAT SHAPES EVERYTHING: part of the live catalogue is stored in VISUAL order, not
 * logical order — imported from Hebrew spreadsheets and OCR without bidi conversion, so a name
 * reads back as `)ב12- אר30*30מטליות מיקרופייבר`. Those names cannot be parsed; the tokens are not
 * in the order they mean. Feeding one to a size parser yields a plausible-looking wrong answer that
 * then gets written into a column and shown everywhere. So this module REFUSES them rather than
 * parsing them — `blocked`, never a proposal. Display-layer fixes do not help: `bidiIsolate` and
 * `dir="auto"` render a reversed name faithfully reversed.
 *
 * Every uncertainty resolves the same direction: `conflict` or `blocked`, never a silent choice.
 * `dropped` is surfaced so the owner's review is a check rather than an act of trust.
 */
import { normalizeUnitInput } from './format';

/** Matches the `products.display_name` column check and the OCR name slice in review. */
export const MAX_DISPLAY_NAME_LENGTH = 120;

/** The separator in `type — size`. */
const SIZE_SEPARATOR = ' — ';

export type VisualOrderSignal =
  | 'leading_closer'
  | 'unbalanced_brackets'
  | 'closer_before_opener';

export interface DisplayNameProposal {
  kind: 'proposal';
  displayName: string;
  type: string;
  size: string | null;
  dropped: string[];
}

export interface DisplayNameConflict {
  kind: 'conflict';
  reasons: string[];
  candidates: string[];
}

export interface DisplayNameBlocked {
  kind: 'blocked';
  reason: 'suspected_visual_order' | 'too_short';
}

export type DisplayNameVerdict =
  | DisplayNameProposal
  | DisplayNameConflict
  | DisplayNameBlocked;

const BRACKET_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
];

/**
 * The visual-order detector, shared in behaviour with `scripts/report-product-name-health.ts`
 * (the spec pins the two together over one corpus, so they cannot drift apart).
 *
 * Brackets are the cheap, reliable tell. In logical order an opener precedes its closer; a string
 * stored in visual order has them the other way round, and a string mangled by OCR loses one
 * entirely. None of the three signals proves reversal on its own — they mark a name whose
 * character order cannot be trusted, which is all a refusal needs.
 */
export function visualOrderSignals(name: string): VisualOrderSignal[] {
  const text = name.trim();
  const signals: VisualOrderSignal[] = [];

  if (BRACKET_PAIRS.some(([, close]) => text.startsWith(close))) {
    signals.push('leading_closer');
  }

  const unbalanced = BRACKET_PAIRS.some(([open, close]) => {
    let opens = 0;
    let closes = 0;
    for (const char of text) {
      if (char === open) opens += 1;
      else if (char === close) closes += 1;
    }
    return opens !== closes;
  });
  if (unbalanced) signals.push('unbalanced_brackets');

  // Balanced but inverted -- `) ... (` counts equal and still cannot be read left of right.
  const inverted = BRACKET_PAIRS.some(([open, close]) => {
    let depth = 0;
    for (const char of text) {
      if (char === open) depth += 1;
      else if (char === close) {
        if (depth === 0) return true;
        depth -= 1;
      }
    }
    return false;
  });
  if (inverted && !signals.includes('closer_before_opener')) {
    signals.push('closer_before_opener');
  }

  return signals;
}

/** Hebrew or Latin letters. Digits and punctuation alone do not make a product type. */
const LETTER = /[א-תA-Za-z]/g;
const NUMBER = '\\d+(?:[.,]\\d+)?';
/** A measure must not be glued to another letter or digit: `500g` yes, `500gr`/`100 גרעינים` no. */
const AFTER = '(?![\\u05D0-\\u05EAA-Za-z0-9])';
/** No boundary is required BEFORE the number, so `דגן200cc` is still seen. That is the point. */
const BEFORE = '(?<![\\d.,])';

type MeasureFamily = 'volume' | 'mass';

/**
 * Ordered most-specific first: JS alternation takes the first branch that matches, so `ליטר` must
 * precede `ל׳` and `gr` must precede `g`. Factors reduce every member of a family to one base unit
 * (millilitre, gram) purely so two spellings of the SAME size can be recognised as agreeing.
 */
const MEASURE_ALIASES: ReadonlyArray<{
  source: string;
  family: MeasureFamily;
  factor: number;
}> = [
  { source: 'סמ["״]?ק', family: 'volume', factor: 1 },
  { source: 'מ["״]?ל', family: 'volume', factor: 1 },
  { source: 'ליטר', family: 'volume', factor: 1000 },
  { source: 'ל["׳\']', family: 'volume', factor: 1000 },
  { source: 'ml', family: 'volume', factor: 1 },
  { source: 'cc', family: 'volume', factor: 1 },
  { source: 'ltr', family: 'volume', factor: 1000 },
  { source: 'l', family: 'volume', factor: 1000 },
  { source: 'ק["״]?ג', family: 'mass', factor: 1000 },
  { source: 'קילו(?:גרם)?', family: 'mass', factor: 1000 },
  { source: 'מ["״]?ג', family: 'mass', factor: 0.001 },
  { source: 'גרם', family: 'mass', factor: 1 },
  { source: 'גר["׳\']?', family: 'mass', factor: 1 },
  { source: 'ג["׳\']', family: 'mass', factor: 1 },
  { source: 'kg', family: 'mass', factor: 1000 },
  { source: 'mg', family: 'mass', factor: 0.001 },
  { source: 'gr', family: 'mass', factor: 1 },
  { source: 'g', family: 'mass', factor: 1 },
];

const MEASURE_RE = new RegExp(
  `${BEFORE}(${NUMBER})\\s*(${MEASURE_ALIASES.map((alias) => alias.source).join('|')})${AFTER}`,
  'gi',
);
/** `30*30`, `30x30 ס״מ` — one measurement of a thing, never two contradicting sizes. */
const DIMENSION_RE = new RegExp(
  `${BEFORE}${NUMBER}\\s*[*x×]\\s*${NUMBER}(?:\\s*[*x×]\\s*${NUMBER})?`,
  'gi',
);
/** Fat content and the like. Dropping `3%` would merge two different products into one name. */
const PERCENT_RE = new RegExp(`${BEFORE}(${NUMBER})\\s*%`, 'g');

/** Only an explicit self-declared company marker. Never an inferred brand — see the module note. */
const COMPANY_RE = /(?:חברת|חב["״׳'])\s*\S+/g;

const SEPARATOR_EDGE = /^[\s\-–—,.;:*/\\|]+|[\s\-–—,.;:*/\\|]+$/g;

interface Span {
  start: number;
  end: number;
  text: string;
  /** Two candidates sharing a key state the same size in different words; they do not conflict. */
  key: string;
}

const countLetters = (text: string) => (text.match(LETTER) ?? []).length;

const tidy = (text: string) => text.replace(/\s+/g, ' ').trim();

function parseAmount(raw: string): number {
  return Number.parseFloat(raw.replace(',', '.'));
}

function measureKey(amountText: string, aliasText: string): string {
  const alias = MEASURE_ALIASES.find((candidate) =>
    new RegExp(`^(?:${candidate.source})$`, 'i').test(aliasText));
  if (!alias) return `raw:${tidy(`${amountText}${aliasText}`).toLowerCase()}`;
  // Rounded before keying: 0.1 litre and 100 ml must land on the same key despite binary floats.
  const base = parseAmount(amountText) * alias.factor;
  return `${alias.family}:${base.toPrecision(12)}`;
}

/** Non-overlapping scan, most-structured pattern first, so `30*30` is never read as two numbers. */
function sizeCandidates(text: string): Span[] {
  const claimed: Span[] = [];
  const overlaps = (start: number, end: number) =>
    claimed.some((span) => start < span.end && end > span.start);

  const collect = (pattern: RegExp, key: (match: RegExpExecArray) => string) => {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      const start = match.index;
      const end = start + match[0].length;
      if (!overlaps(start, end)) {
        claimed.push({ start, end, text: tidy(match[0]), key: key(match) });
      }
    }
  };

  collect(DIMENSION_RE, (match) => `dimension:${tidy(match[0]).replace(/\s+/g, '').toLowerCase()}`);
  collect(PERCENT_RE, (match) => `percent:${parseAmount(match[1] ?? '0').toPrecision(12)}`);
  collect(MEASURE_RE, (match) => measureKey(match[1] ?? '', match[2] ?? ''));

  return claimed.sort((a, b) => a.start - b.start);
}

function companySpans(text: string): Span[] {
  COMPANY_RE.lastIndex = 0;
  const spans: Span[] = [];
  for (let match = COMPANY_RE.exec(text); match; match = COMPANY_RE.exec(text)) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      text: tidy(match[0]),
      key: 'company',
    });
  }
  return spans;
}

function cut(text: string, spans: Span[]): string {
  const ordered = [...spans].sort((a, b) => b.start - a.start);
  let out = text;
  for (const span of ordered) out = out.slice(0, span.start) + ' ' + out.slice(span.end);
  return tidy(out).replace(SEPARATOR_EDGE, '');
}

/**
 * Propose a canonical display name, or refuse.
 *
 * @param name The raw `products.name` exactly as stored.
 * @param unit The product's unit of sale, used only to drop a bare repetition of it from the name
 *   (`עגבניות ק״ג` where the unit is already `ק״ג`). A unit carrying a NUMBER is a size, not a
 *   repetition, and is kept.
 */
export function proposeDisplayName(name: string, unit: string): DisplayNameVerdict {
  const text = tidy(name ?? '');

  if (countLetters(text) < 2) return { kind: 'blocked', reason: 'too_short' };
  if (visualOrderSignals(text).length > 0) {
    return { kind: 'blocked', reason: 'suspected_visual_order' };
  }

  // Sizes are scanned across the WHOLE name BEFORE anything is dropped. In the owner's own
  // example the second size is glued to the brand token (`חברת דגן200cc`); dropping the company
  // first would delete the evidence of the contradiction and yield a confident wrong answer.
  const candidates = sizeCandidates(text);
  const distinct = new Map<string, Span>();
  for (const candidate of candidates) {
    if (!distinct.has(candidate.key)) distinct.set(candidate.key, candidate);
  }

  if (distinct.size > 1) {
    return {
      kind: 'conflict',
      reasons: ['the name states more than one size, and they do not agree'],
      candidates: [...distinct.values()].sort((a, b) => a.start - b.start).map((span) => span.text),
    };
  }

  const size = distinct.size === 1 ? [...distinct.values()][0]! : null;
  const dropped: string[] = [];

  // A second spelling of the SAME size loses no information, but the reviewer is still told.
  for (const candidate of candidates) {
    if (size && candidate !== size && candidate.text !== size.text) dropped.push(candidate.text);
  }

  const companies = companySpans(text);
  for (const company of companies) dropped.push(company.text);

  let type = cut(text, [...(size ? [size] : []), ...companies]);

  const canonicalUnit = normalizeUnitInput(unit);
  if (canonicalUnit) {
    const bare = new RegExp(
      `(?<![\\u05D0-\\u05EAA-Za-z0-9])${escapeRegExp(canonicalUnit)}(?![\\u05D0-\\u05EAA-Za-z0-9])`,
    );
    const found = bare.exec(type);
    if (found) {
      dropped.push(found[0]);
      type = tidy(type.replace(bare, ' ')).replace(SEPARATOR_EDGE, '');
    }
  }

  if (countLetters(type) < 2) return { kind: 'blocked', reason: 'too_short' };

  const displayName = size ? `${type}${SIZE_SEPARATOR}${size.text}` : type;

  if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    // Truncating would be a silent edit to a name shown on every screen. A person shortens it.
    return {
      kind: 'conflict',
      reasons: [`the canonical name is ${displayName.length} characters, over the ${MAX_DISPLAY_NAME_LENGTH} the column accepts`],
      candidates: [displayName],
    };
  }

  return { kind: 'proposal', displayName, type, size: size?.text ?? null, dropped };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
