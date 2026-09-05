import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE CONTRADICTION BETWEEN TWO FILES THAT SHIPPED TOGETHER (`ENTRY-02`).
 *
 * `src/styles/plan-card.css` is a transcription of the marketing site's plan chapter, and that
 * chapter closes both capability blocks on a phone and hands them to an expander — the reference's
 * `.plan-card__more`, a `details` holding the whole ladder for one plan. The transcription brought
 * the CLOSING rule across and `PlanTicket` deliberately does not draw the expander: its own note
 * lists `.plan-card__more` among the four parts it refuses to own, «this card already lists every
 * row it received inline, at every width, so the expander would hide what is already there».
 *
 * Both statements are reasonable and together they published a public pricing page that, on a
 * phone, showed four plan names and four document counts. Measured 04.09.2026 at 390x844: 52
 * entitlement rows in the DOM, ZERO laid out, zero controls to open them — on the only public page
 * that says what the product does. The rows were still readable by a screen reader, which is
 * precisely why nothing that reads markup ever noticed.
 *
 * SO THIS IS A SPEC ABOUT TWO FILES AGREEING, not about either one being wrong. A card may close
 * its blocks on a phone exactly when it draws the control that opens them again. It is worth a
 * cheap source oracle beside the rendered one (`scripts/measure-public-entrance.mjs`) because the
 * browser measurement is not in any workflow this repository runs on every push, and the defect it
 * catches is one whole viewport of one public page going blank.
 */
const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const css = read('../styles/plan-card.css');
const ticket = read('./PlanTicket.tsx');

/** Comments in this stylesheet discuss `.plan-card__more` at length; only rules count. */
const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '');

/** The `@media (max-width: 767px)` body — the phone, which is where the rows vanished. */
const phoneBlock = (): string => {
  const source = withoutComments(css);
  const start = source.search(/@media\s*\(\s*max-width:\s*767px\s*\)\s*\{/);
  expect(start, 'plan-card.css has no phone media query — this spec is measuring nothing').toBeGreaterThan(-1);
  let depth = 0;
  let i = source.indexOf('{', start);
  const from = i + 1;
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(from, i);
    }
  }
  throw new Error('unbalanced braces in plan-card.css');
};

/** Every rule in a block, as selector + body pairs. */
const rules = (block: string) =>
  [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1].trim().replace(/\s+/g, ' '),
    body: match[2].trim().replace(/\s+/g, ' '),
  }));

describe('כרטיס המסלול על טלפון', () => {
  /** The positive control. If the card stops drawing blocks, the claim below is about nothing. */
  it('הכרטיס אכן מצייר את שני הבלוקים, ואינו מצייר מרחיב שיפתח אותם', () => {
    /* Comments, not code: `PlanTicket`'s own header discusses `.plan-card__more` at length —
       naming it is how it records the refusal to draw it. */
    const code = withoutComments(ticket).replace(/^\s*\/\/.*$/gm, '');
    expect(code).toMatch(/className=\{?["'`][^"'`]*\bplan-block\b/);
    expect(code).not.toMatch(/\bplan-card__more\b/);
  });

  /**
   * The claim itself: nothing may take `.plan-block` out of the phone's layout unless the same
   * selector requires the expander to be present on that card.
   *
   * `:has(.plan-card__more)` is the qualifier that makes the transcription honest — the reference's
   * card closes its blocks BECAUSE it offers the ladder, and a card that offers no ladder keeps
   * its rows. The check is on the SELECTOR rather than on a comment, because a comment cannot be
   * measured and this defect was already documented in prose in both files while it shipped.
   */
  it('אינו מסתיר את שורות היכולות בטלפון בלי פקד שיפתח אותן', () => {
    const offenders = rules(phoneBlock()).filter((rule) =>
      /(^|[\s,>+~])\.plan-block(\b|[^_-])/.test(`${rule.selector} `)
      && /display\s*:\s*none/.test(rule.body)
      && !rule.selector.includes('plan-card__more'));

    expect(
      offenders.map((rule) => `${rule.selector} { ${rule.body} }`),
      'A phone rule removes .plan-block from the layout while PlanTicket draws no .plan-card__more '
      + 'to open it again — /pricing then shows four plan names and nothing else (ENTRY-02).',
    ).toEqual([]);
  });

  /**
   * `ENTRY-06`, the structural half. `.plan-row__tag` is `white-space: nowrap` and `flex: none` —
   * both transcribed, both right — so in a 209px card the badge cannot shrink and cannot break. In
   * a row that may not wrap it therefore leaves the card: measured 04.09.2026, the free rung's
   * «רק 30 יום ראשונים» badge crossed its own card's border on all five intro rows.
   *
   * The row must be allowed to wrap. That is the one property that makes the overflow structurally
   * impossible rather than impossible for today's strings.
   */
  it('שורת יכולת יכולה לעבור שורה, כך שתג שאינו נשבר לא יוצא מהכרטיס', () => {
    const row = rules(withoutComments(css)).find((rule) => rule.selector === '.plan-row');
    expect(row, 'plan-card.css has no .plan-row rule').toBeDefined();
    expect(row!.body).toMatch(/flex-wrap\s*:\s*wrap/);
    const tag = rules(withoutComments(css)).find((rule) => rule.selector === '.plan-row__tag');
    expect(tag, 'plan-card.css has no .plan-row__tag rule').toBeDefined();
    // The badge is still the reference's: it does not break its own words. That is exactly why the
    // ROW has to be the thing that gives.
    expect(tag!.body).toMatch(/white-space\s*:\s*nowrap/);
  });
});
