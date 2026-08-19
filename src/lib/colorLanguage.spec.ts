import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Tone } from './status';

/**
 * The four rules in this file all guard the same failure mode: two names for one value.
 *
 * `--color-alert-solid` and `--color-alert-fg` both resolve to rose-700 today, as do
 * `--color-trend-up-fg` and `--color-alert-fg`. So a component asking for the wrong one looks
 * perfectly correct on screen, and stays wrong until somebody separates the values — at which
 * point every mistaken call site changes color at once, in production, with no diff to blame.
 * These assertions are the only thing standing between "identical value" and "same meaning".
 */

const css = readFileSync('src/index.css', 'utf8');
/** Comments carry prose about tokens they must not be credited with using. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every Tone, kept total by the type system — a sixth meaning breaks compilation here first. */
const TONES = Object.keys({
  done: true, await: true, alert: true, info: true, idle: true,
} satisfies Record<Tone, true>) as Tone[];

function sourceFiles(dir = 'src'): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) return [];
    return /\.spec\.tsx?$/.test(entry.name) ? [] : [path];
  });
}

const sources = sourceFiles().map(
  (file) => [relative('src', file).replace(/\\/g, '/'), readFileSync(file, 'utf8')] as const,
);

function hits(pattern: RegExp) {
  return sources.flatMap(([file, source]) =>
    source
      .split(/\r?\n/)
      .flatMap((text, index) => {
        pattern.lastIndex = 0;
        return [...text.matchAll(pattern)].map((m) => `${file}:${index + 1}  ${m[0]}`);
      }),
  );
}

describe('color language', () => {
  it('`solid` הוא מילוי פקד, לעולם לא צבע טקסט', () => {
    // index.css's own docblock: "solid → filled control". 28 call sites used text-alert-solid as
    // the ink of a destructive ghost button and text-done-solid as a check glyph — the -fg role.
    expect(hits(new RegExp(`\\btext-(?:${TONES.join('|')})-solid\\b`, 'g'))).toEqual([]);
  });

  it('אין `white` גולמי — טקסט על משטח מלא הוא on-solid', () => {
    // bg-white survives on purpose in four places: an opaque plate behind a tenant-uploaded logo,
    // which may be a transparent PNG. That is a deliberate literal, so it is named, not inferred.
    expect(rules).toContain('--color-on-solid');
    expect(hits(/\btext-white\b/g)).toEqual([]);

    const plates = sources
      .filter(([, source]) => /\bbg-white\b/.test(source))
      .map(([file]) => file)
      .sort();
    expect(plates).toEqual(['components/Layout.tsx', 'pages/Settings.tsx']);
  });

  it('כיוון שינוי לובש trend-*, ולעולם לא טון סטטוס', () => {
    // A price that rose is a direction, not an "alert". Both are rose-700, so the only way this
    // stays honest is a rule: a trend arrow and a status tone never share an element.
    //
    // Whitespace is collapsed first because the real offender straddled two lines — the span
    // carried text-alert-fg and the arrow sat on the next line — and a line-at-a-time scan would
    // have called that clean. 200 characters is about one JSX element after collapsing.
    const mixed = sources.flatMap(([file, source]) => {
      const flat = source.replace(/\s+/g, ' ');
      return [...flat.matchAll(/\btext-(?:alert|done|await|info)-(?:fg|solid|on-soft)\b/g)]
        .filter((m) => /Trending(?:Up|Down)/.test(flat.slice(m.index, m.index + 200)))
        .map((m) => `${file}  ${flat.slice(m.index, m.index + 80)}`);
    });
    expect(mixed).toEqual([]);
  });

  it('בורר המוצרים אינו מדבר בטון "הושלם" — בחירה אינה השלמה', () => {
    // The selection box wore border-done-line/bg-done-soft/text-done-fg. Choosing a product is a
    // choice; the done family says a step finished, and a picker has nothing finished on it. The
    // two read the same to anyone who knows the language, so only a rule keeps them apart. The
    // file lookup is asserted first: a rename must fail here, not quietly pass on an empty scan.
    const picker = sources.find(([file]) => file === 'pages/neworder/ProductStep.tsx');
    expect(picker, 'pages/neworder/ProductStep.tsx').toBeDefined();
    const surfaces = ['wash', 'line', 'soft', 'on-soft', 'fg', 'solid'].join('|');
    expect([...picker![1].matchAll(new RegExp(`\\bdone-(?:${surfaces})\\b`, 'g'))].map((m) => m[0])).toEqual([]);
  });

  it('כל טון חושף בדיוק את שישה המשטחים, ולכל אחד יש מחלקה', () => {
    // badge-${tone} and note-${tone} are built by string interpolation (ui.tsx, DocumentStatusBadge),
    // so a Tone with no class renders unstyled and no build fails. This is that build failure.
    for (const tone of TONES) {
      for (const surface of ['wash', 'line', 'soft', 'on-soft', 'fg', 'solid']) {
        expect(rules, `--color-${tone}-${surface}`).toContain(`--color-${tone}-${surface}:`);
      }
      expect(rules, `.badge-${tone}`).toContain(`.badge-${tone}`);
      expect(rules, `.note-${tone}`).toContain(`.note-${tone}`);
    }
  });
});
