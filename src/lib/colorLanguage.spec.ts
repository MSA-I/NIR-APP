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

/**
 * oklch → linear sRGB (Björn Ottosson's Oklab matrices). Linear values are exactly what WCAG's
 * relative-luminance formula wants, so no gamma round-trip is needed to compare two tokens.
 * Verified against the three ramp hexes index.css documents in its own comment (chart-1,
 * chart-3, chart-4): all three reproduce byte-for-byte, so the numbers below are the same ones
 * a browser paints. The literals are not repeated here — this file is scanned by check:tokens.
 */
function oklchToLinearRgb(lightness: number, chroma: number, hue: number) {
  const h = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(h);
  const b = chroma * Math.sin(h);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ] as const;
}

/** One level of `var()` indirection is all the ramp uses: chart-1 → action, chart-4 → shell. */
function tokenValue(name: string): string {
  const raw = rules.match(new RegExp(`--${name}:\s*([^;]+);`))?.[1].trim();
  if (!raw) throw new Error(`token --${name} is not declared in index.css`);
  const alias = raw.match(/^var\(--([\w-]+)\)$/);
  return alias ? tokenValue(alias[1]) : raw;
}

function luminanceOf(name: string) {
  const value = tokenValue(name);
  const parts = value.match(/^oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)$/);
  if (!parts) throw new Error(`--${name} is not a plain oklch() value: ${value}`);
  const [r, g, b] = oklchToLinearRgb(Number(parts[1]) / 100, Number(parts[2]), Number(parts[3]));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string) {
  const [hi, lo] = [luminanceOf(a), luminanceOf(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('comparison series', () => {
  const theme = readFileSync('src/lib/theme.ts', 'utf8');
  const body = theme.slice(theme.indexOf('export function comparisonSeries'));
  const steps = [...body.matchAll(/t\.bars\[(\d)\]/g)].map((match) => Number(match[1]));

  it('שתי הסדרות מופרדות ב-3:1 לפחות — לא רק מול המשטח, אלא זו מול זו', () => {
    // The measurement nobody was making. Until now every chart colour was checked against the
    // SURFACE it sits on; no assertion asked what a series measures against the series beside it.
    // That is how the main dashboard shipped two lines at 1.56:1 — chart-1 against chart-4, where
    // colour contributed nothing and the dash carried the entire distinction on its own.
    expect(steps).toHaveLength(2);
    const pair = contrast(`color-chart-${steps[0] + 1}`, `color-chart-${steps[1] + 1}`);
    expect(pair, `chart-${steps[0] + 1} vs chart-${steps[1] + 1}`).toBeGreaterThanOrEqual(3);
  });

  it('הסדרה השנייה תמיד מקווקוות — נשא שאינו צבע', () => {
    // Greyscale print, a compressed screenshot, and colour-vision deficiency all erase hue and
    // leave lightness. The dash survives all three, so it is a requirement and not a garnish.
    expect(body).toContain('dash: true');
    expect(body.indexOf('dash: true')).toBeGreaterThan(body.indexOf(`t.bars[${steps[0]}]`));
  });

  it('אף מסך אינו בונה סדרות בעצמו — הזיווג חי במקום אחד', () => {
    // The whole point of the helper: two dashboards previously chose their own indices and
    // disagreed. A `series={[...]}` literal carrying a colour is that mistake coming back.
    const handRolled = sources
      .filter(([file]) => file !== 'lib/theme.ts')
      .flatMap(([file, source]) => {
        const flat = source.replace(/\s+/g, ' ');
        return [...flat.matchAll(/series=\{\[/g)].map((m) => `${file}  ${flat.slice(m.index, m.index + 60)}`);
      });
    expect(handRolled).toEqual([]);
  });
});
