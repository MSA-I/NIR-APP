import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { he } from '../../lib/i18n/dictionaries/he';

/**
 * The step bar renders twice — a compact row of numbered buttons on a phone, the chip strip from
 * `sm` up — because a single `rounded-full` strip wrapped into a blurred ellipse at phone width
 * (owner review, 19.08.2026, defect 9). Two renderings of one control is a fair answer to that,
 * and it carries one hazard worth a test: they can drift into announcing DIFFERENT names.
 *
 * They did. The phone number span shipped with `aria-hidden`, so a screen-reader user on a phone
 * heard "מוצרים וכמויות" where a desktop user heard "01 מוצרים וכמויות" — the step control losing
 * its step number on the one viewport where the label is all there is. The browser gate found it
 * by timing out on a locator; this finds it in a second, which is where it belongs.
 *
 * Source-level on purpose. Rendering `NewOrder` needs the whole data layer stood up, and the
 * invariant is a property of the markup: whatever the number span does in one rendering, it must
 * do in the other. `typographyContract.spec.ts` and `productDisplayName.spec.ts` read source for
 * the same reason.
 */
const source = readFileSync(join(process.cwd(), 'src/pages/neworder/NewOrder.tsx'), 'utf8');

const stepper = (() => {
  // The label moved into the dictionary; the anchor moved with it, and the sentence it used to
  // be is asserted below rather than dropped.
  const start = source.indexOf("<nav aria-label={t('newOrder.aria_label')}>");
  const end = source.indexOf('</nav>', start);
  if (start < 0 || end < 0) throw new Error('the step bar markup moved — update this test with it');
  return source.slice(start, end);
})();

describe('the step bar announces one name per step, at every width', () => {
  it('still calls itself the order steps', () => {
    expect(he.newOrder.aria_label).toBe('שלבי הזמנה');
  });

  it('renders both a phone and a desktop variant', () => {
    expect(stepper).toContain('sm:hidden');
    expect(stepper).toContain('sm:flex');
  });

  it('never hides the step number from assistive technology', () => {
    // The digit is half the accessible name. Hiding it in one variant is exactly the drift that
    // shipped once already, and it is invisible to every test that only renders one width.
    const numberSpans = stepper.match(/<span className="num[^"]*"[^>]*>/g) ?? [];
    expect(numberSpans.length).toBe(2);
    for (const span of numberSpans) expect(span).not.toContain('aria-hidden');
  });

  it('gives both variants the label as well as the number', () => {
    // Phone puts the label in `sr-only`; desktop shows it. Either way it is part of the name.
    expect(stepper).toContain('<span className="sr-only">{entry.label}</span>');
    expect(stepper).toContain('{entry.label}</span>');
  });

  it('marks the current step for assistive technology in both variants', () => {
    expect((stepper.match(/aria-current=/g) ?? []).length).toBe(2);
  });
});
