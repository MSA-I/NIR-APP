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

/**
 * The measure that replaced WCAG contrast for mark-vs-mark separation (24.08.2026).
 *
 * WCAG's ratio is defined for TEXT on a BACKGROUND and is a function of luminance alone, so as
 * a test of "can a reader tell these two series apart" it can only ever see lightness. That was
 * adequate while the ramp was monochrome — lightness was the only difference there was. It is
 * not adequate for a categorical palette, whose steps sit at deliberately similar lightness so
 * that none of them dominates, and where hue carries the identity.
 *
 * OKLab Euclidean distance x100 is the perceptual measure that sees both. The thresholds below
 * are the data-viz skill's: 15 for unsimulated vision, 8 under simulated colour-vision
 * deficiency. The CVD transforms are Machado, Oliveira & Fernandes (2009) at severity 1.0,
 * applied in LINEAR RGB — the model the thresholds were calibrated against, so swapping in a
 * different simulation would mean recalibrating the numbers too.
 */
const MACHADO = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
} as const;

function linearRgbToOklab([r, g, b]: readonly [number, number, number]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ] as const;
}

/** oklch() components of a token, following one level of var() indirection. */
function oklchOf(name: string) {
  const value = tokenValue(name);
  const parts = value.match(/^oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)$/);
  if (!parts) throw new Error(`--${name} is not a plain oklch() value: ${value}`);
  return { lightness: Number(parts[1]) / 100, chroma: Number(parts[2]), hue: Number(parts[3]) };
}

function labOf(name: string, deficiency?: keyof typeof MACHADO) {
  const { lightness, chroma, hue } = oklchOf(name);
  const linear = oklchToLinearRgb(lightness, chroma, hue);
  if (!deficiency) return linearRgbToOklab(linear);
  const matrix = MACHADO[deficiency];
  return linearRgbToOklab(matrix.map((row) => row[0] * linear[0] + row[1] * linear[1] + row[2] * linear[2]) as unknown as readonly [number, number, number]);
}

function deltaE(a: string, b: string, deficiency?: keyof typeof MACHADO) {
  const [p, q] = [labOf(a, deficiency), labOf(b, deficiency)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) * 100;
}

const NORMAL_FLOOR = 15;
const CVD_FLOOR = 8;
const CHROMA_FLOOR = 0.1;
const SERIES_TOKENS = [1, 2, 3, 4, 5].map((n) => `color-series-${n}`);

describe('categorical palette', () => {
  it('כל צעד נושא כרומה אמיתית — לא אפור שמתחזה לגוון', () => {
    // The defect this palette exists to answer. Every step of the sequential ramp measures under
    // 0.10 chroma (0.058 · 0.050 · 0.031 · 0.022 · 0.015), which is why five "different" colours
    // read as five greys. A categorical step that drifts back under the floor is the same bug.
    for (const token of SERIES_TOKENS) {
      expect(oklchOf(token).chroma, token).toBeGreaterThanOrEqual(CHROMA_FLOOR);
    }
  });

  it('כל זוג נבדל — גם למי שאינו רואה צבע', () => {
    // ALL pairs, not just neighbours: the donut puts four named slices and "אחר" on screen at
    // once, and the legend chips sit in a row, so any two steps get compared directly. A
    // neighbour-only check would pass a palette whose first and third steps are indistinguishable.
    for (let i = 0; i < SERIES_TOKENS.length; i++) {
      for (let j = i + 1; j < SERIES_TOKENS.length; j++) {
        const [a, b] = [SERIES_TOKENS[i], SERIES_TOKENS[j]];
        expect(deltaE(a, b), `${a} vs ${b} (normal vision)`).toBeGreaterThanOrEqual(NORMAL_FLOOR);
        expect(Math.min(deltaE(a, b, 'protan'), deltaE(a, b, 'deutan')), `${a} vs ${b} (CVD)`)
          .toBeGreaterThanOrEqual(CVD_FLOOR);
      }
    }
  });

  it('רמפת העמודות היא גוון אחד בשלוש בהירות — לא פלטה קטגורית שנייה', () => {
    // The ramp encodes RANK, and a ramp can only do that through lightness — which is also the
    // one carrier that survives colour blindness. Two failures are possible and both look fine
    // on a designer's screen: steps that converge in lightness (rank stops reading), and steps
    // that wander in hue (the ramp turns into a second, unmeasured categorical palette beside
    // the real one — exactly the split that put the bar chart in the old vocabulary until
    // 25.08.2026). The floor is the smaller of the two gaps the tokens ship with.
    const ramp = ['color-bar-high', 'color-bar-mid', 'color-bar-low'].map(oklchOf);
    const [high, mid, low] = ramp;
    expect(high.lightness).toBeLessThan(mid.lightness);
    expect(mid.lightness).toBeLessThan(low.lightness);
    expect(mid.lightness - high.lightness).toBeGreaterThanOrEqual(0.15);
    expect(low.lightness - mid.lightness).toBeGreaterThanOrEqual(0.15);
    for (const step of ramp) expect(step.hue).toBe(ramp[0].hue);
  });

  it('אף צעד קטגורי אינו משאיל טוקן סטטוס', () => {
    // The two vocabularies stay apart (DESIGN.md, חוק שני אוצרות-המילים). A series step that
    // resolved to a status family would make a chart mark claim a business state.
    for (const token of SERIES_TOKENS) {
      expect(rules).toMatch(new RegExp(`--${token}:\\s*oklch\\(`));
    }
  });
});


describe('comparison series', () => {
  const theme = readFileSync('src/lib/theme.ts', 'utf8');
  const body = theme.slice(theme.indexOf('export function comparisonSeries'));
  const steps = [...body.matchAll(/t\.categorical\[(\d)\]/g)].map((match) => Number(match[1]));

  it('שתי הסדרות נבדלות ב-ΔE, לא ביחס בהירות', () => {
    // The measurement nobody was making, restated in the right unit. Until 0148-era work no
    // assertion asked what a series measures against the series beside it — that is how the main
    // dashboard shipped two lines at 1.56:1, where colour contributed nothing and the dash
    // carried the whole distinction alone.
    //
    // The floor used to be 3:1 WCAG. That number is now unreachable BY CONSTRUCTION and its
    // absence is not a regression: categorical steps are held at similar lightness on purpose,
    // and WCAG only sees lightness. ΔE sees hue too, which is what actually separates them now.
    expect(steps).toHaveLength(2);
    const [primary, counterpart] = steps.map((step) => `color-series-${step + 1}`);
    expect(deltaE(primary, counterpart), `${primary} vs ${counterpart} (normal vision)`)
      .toBeGreaterThanOrEqual(NORMAL_FLOOR);
    expect(
      Math.min(deltaE(primary, counterpart, 'protan'), deltaE(primary, counterpart, 'deutan')),
      `${primary} vs ${counterpart} (CVD)`,
    ).toBeGreaterThanOrEqual(CVD_FLOOR);
  });

  it('הסדרה השנייה תמיד מקווקוות — נשא שאינו צבע', () => {
    // Greyscale print, a compressed screenshot, and colour-vision deficiency all erase hue and
    // leave lightness. The dash survives all three, so it is a requirement and not a garnish.
    expect(body).toContain('dash: true');
    expect(body.indexOf('dash: true')).toBeGreaterThan(body.indexOf(`t.categorical[${steps[0]}]`));
  });

  it('הניצוץ נושא צורה ולא רק גוון — DEBT §53', () => {
    // The price sparkline is 96×28 with no axes, no dots and no tooltip, so the stroke hue was
    // the whole message: rose-700 rising against emerald-700 falling, the one pair that collapses
    // under deuteranopia and protanopia. Its aria-label already says the direction in words, which
    // serves a screen reader and nobody who is looking at it. The glyph is the carrier that
    // survives greyscale, a compressed screenshot and colour-vision deficiency alike.
    const sparkline = sources.find(([file]) => file === 'components/supplier-metrics.tsx')?.[1] ?? '';
    expect(sparkline, 'supplier-metrics.tsx not found').not.toBe('');
    expect(sparkline).toMatch(/DirectionGlyph = last > first \? ArrowUpRight : last < first \? ArrowDownRight : Minus/);
    expect(sparkline).toContain('<DirectionGlyph');
    // Neutral ink on purpose: a sixth hue would be a new claim in the colour language, and this
    // glyph is meant to add information without adding meaning to a colour.
    expect(sparkline).toMatch(/<DirectionGlyph[^>]*text-ink-mid/);
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
