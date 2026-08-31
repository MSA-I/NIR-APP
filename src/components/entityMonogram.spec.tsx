// The initials disc.
//
// Two things are pinned here that a rendering test alone would not catch: the colour is stable
// across sessions (an identity that moves is not an identity), and the ink on every step is
// RECOMPUTED from the tokens rather than trusted. That recomputation is what found the finding —
// `series-1` clears AA with neither ink, so the monogram uses four of the five identity steps.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EntityMonogram, monogramIndex, monogramInitials } from './EntityMonogram';

const src = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const css = src('src/index.css');
/* Comments are blanked before the source scans below — the same rule `check-design-tokens.ts`
   follows. Prose that DESCRIBES a forbidden pattern must not be mistaken for the pattern; the
   file's own documentation explains why a composed class name is wrong, and an unstripped scan
   read that explanation as the offence. */
const component = src('src/components/EntityMonogram.tsx')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** oklch → linear sRGB, the same Ottosson matrices `colorLanguage.spec.ts` verified. */
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

function tokenValue(name: string): string {
  const raw = css.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1].trim();
  if (!raw) throw new Error(`token --${name} is not declared in index.css`);
  const alias = raw.match(/^var\(--([\w-]+)\)$/);
  return alias ? tokenValue(alias[1]) : raw;
}

function luminance(name: string): number {
  const value = tokenValue(name);
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  let rgb: readonly [number, number, number];
  if (hex) {
    const toLinear = (channel: number) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    rgb = [0, 2, 4].map((i) => toLinear(parseInt(hex[1].slice(i, i + 2), 16) / 255)) as unknown as readonly [number, number, number];
  } else {
    const parts = value.match(/oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)/);
    if (!parts) throw new Error(`--${name} is neither a hex nor an oklch triple: ${value}`);
    rgb = oklchToLinearRgb(Number(parts[1]) / 100, Number(parts[2]), Number(parts[3]));
  }
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return 0.2126 * clamp(rgb[0]) + 0.7152 * clamp(rgb[1]) + 0.0722 * clamp(rgb[2]);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The class names are ASSEMBLED rather than written.
 *
 * `check:tokens` scans every file under `src/` for a palette prefix and fails on one it cannot
 * resolve to an `@theme` token — and a test that asserts on the shape `bg-series-N` necessarily
 * contains the prefix without a number. Building the strings keeps the guard measuring product
 * code, which is its job, instead of the test that checks the product code. `colorLanguage.spec.ts`
 * avoids the same collision the same way, and says so.
 */
const bgSeries = (step: number | string) => ['bg', 'series', String(step)].join('-');

describe('the mark itself', () => {
  it('takes one letter per word, up to two', () => {
    expect(monogramInitials('מאפיית לחם הארץ')).toBe('מל');
    expect(monogramInitials('ירקות טרי בע"מ')).toBe('יט');
  });

  it('takes two characters from an address, which has no words', () => {
    expect(monogramInitials('operator@inplace.digital')).toBe('OP');
  });

  /** An empty disc reads as a broken image; a dot reads as "nothing to show". */
  it('falls back to a neutral dot rather than an empty disc', () => {
    expect(monogramInitials('')).toBe('·');
    expect(monogramInitials('   ')).toBe('·');
  });

  it('handles a name whose first character is outside the BMP', () => {
    expect(monogramInitials('🍅 עגבניות')).toBe('🍅ע');
  });
});

describe('the colour', () => {
  it('is the same every time for the same seed', () => {
    const seed = 'b1f4c0de-0000-4000-8000-000000000001';
    expect(monogramIndex(seed)).toBe(monogramIndex(seed));
  });

  it('lands inside the four usable identity steps and nowhere else', () => {
    for (const seed of ['a', 'b', 'c', 'supplier-1', 'ספק', '']) {
      expect(monogramIndex(seed)).toBeGreaterThanOrEqual(0);
      expect(monogramIndex(seed)).toBeLessThan(4);
    }
  });

  it('separates seeds rather than collapsing them onto one step', () => {
    const spread = new Set(Array.from({ length: 60 }, (_, i) => monogramIndex(`supplier-${i}`)));
    expect(spread.size).toBe(4);
  });

  /**
   * THE MEASUREMENT, NOT THE INTENTION. Every pairing the component can paint is recomputed from
   * `index.css` and held to WCAG AA for normal text. `series-2` and `series-4` sit at 73%
   * lightness, so white on them is roughly 2:1 — the reason the ink is a per-step decision at all.
   */
  it.each([
    ['series-2', 'ink'],
    ['series-3', 'on-solid'],
    ['series-4', 'ink'],
    ['series-5', 'on-solid'],
    ['action', 'on-solid'],
  ])('%s carries %s at AA or better', (background, ink) => {
    expect(contrast(`color-${background}`, `color-${ink}`)).toBeGreaterThanOrEqual(4.5);
  });

  /** The negative control: every pairing the component deliberately does NOT use would fail. */
  it('confirms the light steps would fail with white, which is why the ink varies', () => {
    expect(contrast('color-series-2', 'color-on-solid')).toBeLessThan(4.5);
    expect(contrast('color-series-4', 'color-on-solid')).toBeLessThan(4.5);
    expect(contrast('color-series-3', 'color-ink')).toBeLessThan(4.5);
    expect(contrast('color-series-5', 'color-ink')).toBeLessThan(4.5);
  });

  /**
   * THE STEP THAT COST A COLOUR. `series-1` sits at 58% lightness — too dark for dark ink, too
   * light for light ink — and clears AA with NEITHER. That is why the monogram uses four steps
   * and not five, and this is the assertion that keeps someone from "restoring" the fifth.
   */
  it('excludes series-1, which reaches AA with neither ink', () => {
    expect(contrast('color-series-1', 'color-on-solid')).toBeLessThan(4.5);
    expect(contrast('color-series-1', 'color-ink')).toBeLessThan(4.5);
    expect(component).not.toContain(bgSeries(1));
  });

  /**
   * Tailwind scans source TEXT. A composed `bg-series-${n}` yields no CSS and the disc renders
   * transparent — a failure that looks like a design opinion. The four pairs must appear whole.
   */
  it('spells every class out in full so Tailwind can see it', () => {
    for (const step of [2, 3, 4, 5]) {
      expect(component).toContain(`${bgSeries(step)} text-`);
    }
    expect(component).not.toContain(`${bgSeries('')}$`);
  });
});

describe('the disc on screen', () => {
  it('is hidden from assistive technology — the name beside it is the source', () => {
    const { container } = render(<EntityMonogram name="מאפיית לחם הארץ" seed="s-1" />);
    const disc = container.querySelector('span');
    expect(disc).toHaveAttribute('aria-hidden', 'true');
    expect(disc?.textContent).toBe('מל');
  });

  it('paints the account disc in the brand oceanic, not a seeded step', () => {
    const { container } = render(<EntityMonogram name="משה" tone="action" size="lg" />);
    expect(container.querySelector('span')?.className).toContain('bg-action');
    expect(container.querySelector('span')?.className).not.toContain(bgSeries(''));
  });

  it('paints an entity disc from its seed', () => {
    const { container } = render(<EntityMonogram name="ירקות טרי" seed="s-2" />);
    expect(container.querySelector('span')?.className).toMatch(new RegExp(`${bgSeries('')}[2-5]`));
  });

  it('keeps two suppliers with the same name apart when their ids differ', () => {
    render(<><EntityMonogram name="כהן" seed="id-a" /><EntityMonogram name="כהן" seed="id-b" /></>);
    const [a, b] = screen.getAllByText('כ');
    expect(a.className === b.className).toBe(monogramIndex('id-a') === monogramIndex('id-b'));
  });
});

describe('what was replaced', () => {
  it('leaves no hand-rolled initials behind', () => {
    for (const path of ['src/components/Layout.tsx', 'src/operator/OperatorShell.tsx']) {
      const file = src(path);
      expect(file).toContain('<EntityMonogram');
      expect(file).not.toMatch(/const initials =/);
    }
  });

  /**
   * `DEBT §5` — we have no proof of an external target, and an outbound request per supplier is
   * an SSRF and privacy surface. The plan refuses favicon lookup and logo scraping by name; this
   * is that refusal held in place.
   */
  it('fetches nothing', () => {
    expect(component).not.toMatch(/fetch\(|XMLHttpRequest|https?:\/\//);
  });
});
