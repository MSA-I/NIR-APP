/**
 * The MEASURED half of the contrast contract — the CI browser job, both themes.
 *
 * `check:contrast` proves the manifest is honest; this proves the palette is. Every pair in
 * `contrast-pairs.mjs` is resolved BY THE BROWSER and its ratio computed from real sRGB, because
 * nothing else can: the palette is `oklch`, several tokens are `color-mix()` over other tokens, and
 * two scrims carry alpha inside the token. A ratio computed from two literals in Node would be a
 * number about a colour space nobody renders in.
 *
 * IT NEEDS NO SIGN-IN, deliberately. Token pairs resolve on `:root` from `src/index.css`, which the
 * login screen already loads, so this gate is independent of the demo seed, of auth and of every
 * fixture the journey gate depends on. That independence is the point: a contrast regression should
 * fail on its own terms rather than behind somebody else's broken login.
 *
 * WHAT IT THEREFORE DOES NOT CLAIM. It measures the PALETTE, not each screen's choice of pair — that
 * a given card really uses `ink-muted` on `surface` is a different question, answered by the journey
 * gate's screenshots and by review. Two gates, two claims, neither pretending to be the other.
 *
 * A POSITIVE CONTROL RUNS FIRST and must FAIL. A contrast gate that cannot demonstrate its own
 * failure path is a gate that reports "all pass" when its measurement is broken — which is exactly
 * what happened to the first version of the measurement in this package, where a Node-side helper
 * read `oklch()` numbers as if they were RGB and produced confident, meaningless ratios.
 *
 * Environment (the sibling gate's contract): PLAYWRIGHT_CORE_PATH, QUALITY_BROWSER_PATH,
 * QUALITY_BASE_URL, and optionally QUALITY_ARTIFACT_DIR for the report.
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DIRECTION_PAIRS, NON_TEXT_EXEMPT, NON_TEXT_PAIRS, TEXT_EXEMPT, TEXT_PAIRS,
} from './contrast-pairs.mjs';
import { informationBearing } from './observed-pairs.mjs';

const requireEnv = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required browser-gate environment: ${name}`);
  return value;
};

const { chromium } = createRequire(import.meta.url)(requireEnv('PLAYWRIGHT_CORE_PATH'));
const browserPath = requireEnv('QUALITY_BROWSER_PATH');
const baseUrl = requireEnv('QUALITY_BASE_URL').replace(/\/$/, '');
const artifactDir = process.env.QUALITY_ARTIFACT_DIR ?? null;

const MANIFEST_PAIRS = [
  ...TEXT_PAIRS.map((pair) => ({ ...pair, kind: 'text', threshold: 4.5, source: 'manifest' })),
  ...NON_TEXT_PAIRS.map((pair) => ({ ...pair, kind: 'non-text', threshold: 3, source: 'manifest' })),
];

/**
 * The second claim, and the one that catches what a maintained list cannot.
 *
 * The manifest asserts the PALETTE is sound. These are the pairs the SCREENS actually put together,
 * read out of the source by `observed-pairs.mjs`. On 31.08.2026 the manifest was green while three
 * real pairs sat at 1.08, 1.21 and 1.64 — none of them listed, because nobody had thought of them.
 * Measuring both means a new screen that invents a pair is measured on the day it ships.
 *
 * A duplicate across the two sets is harmless here: the same pair measured twice is the same number.
 */
const OBSERVED_PAIRS = informationBearing(NON_TEXT_EXEMPT, TEXT_EXEMPT)
  .map((pair) => ({ ...pair, source: 'rendered' }));

const PAIRS = [...MANIFEST_PAIRS, ...OBSERVED_PAIRS];

/**
 * Runs INSIDE the page. Resolves each token through a canvas so any CSS colour syntax the browser
 * understands becomes sRGB + alpha, then composites a translucent value over its own background
 * before comparing — which is what the eye does and what a naive reader of `getComputedStyle`
 * misses.
 */
const measureInPage = ([pairs, theme]) => {
  const root = document.documentElement;
  if (theme === 'dark') root.dataset.theme = 'dark';
  else delete root.dataset.theme;

  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const toRgba = (css) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  const token = (name) => {
    const value = getComputedStyle(root).getPropertyValue(`--color-${name}`).trim();
    return value === '' ? null : toRgba(value);
  };
  const channel = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
  const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  // The ground a translucent background composites over: the page itself.
  const pageGround = token('canvas') ?? [255, 255, 255, 1];

  return pairs.map((pair) => {
    const rawFg = token(pair.fg);
    const rawBg = token(pair.bg);
    if (rawFg === null || rawBg === null) {
      return { ...pair, theme, resolved: false };
    }
    const bg = over(rawBg, pageGround);
    const fg = over(rawFg, bg);
    /**
     * THE RAW RATIO IS THE VERDICT; the rounded one is only for reading.
     *
     * This returned `Number(ratio.toFixed(2))` and the gate compared THAT — so a pair measuring
     * 2.998155 became 3.00 and passed a 3:1 threshold it does not meet. It happened on the very ring
     * this package added (`nav-current-edge` on `nav-current`), it reported green locally, and CI
     * resolved the same colour one 8-bit step differently, got 2.99 and went red. A gate that rounds
     * before it compares is a gate that certifies its own near-misses.
     */
    const exact = ratio(fg, bg);
    return { ...pair, theme, resolved: true, ratio: exact, shown: Number(exact.toFixed(2)) };
  });
};

const browser = await chromium.launch({ headless: true, executablePath: browserPath });
const failures = [];
const rows = [];

try {
  const page = await browser.newPage();
  const response = await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
  if (!response || !response.ok()) {
    throw new Error(`the preview did not serve /login (${response ? response.status() : 'no response'})`);
  }
  // The stylesheet has to be in, or every token resolves empty and every pair "passes".
  await page.waitForFunction(
    () => getComputedStyle(document.documentElement).getPropertyValue('--color-canvas').trim() !== '',
    null,
    { timeout: 15000 },
  );

  // ---- the positive control, before anything is trusted ----------------------------------------
  const control = await page.evaluate(measureInPage, [
    [{ fg: 'ink-faint', bg: 'ink-ghost', where: 'positive control: two near-neighbours that cannot pass 4.5:1', threshold: 4.5, kind: 'text' }],
    'light',
  ]);
  const controlRow = control[0];
  if (!controlRow.resolved || controlRow.ratio >= 4.5) {
    throw new Error(
      'the positive control did not fail: measured '
      + `${controlRow.resolved ? controlRow.shown : 'unresolved'} for two adjacent ink rungs. `
      + 'The measurement is broken, so every "pass" below would be meaningless.',
    );
  }
  console.log(`positive control ok — two adjacent ink rungs measured ${controlRow.shown}:1, below 4.5 as required`);

  for (const theme of ['light', 'dark']) {
    // The DIRECTION contracts first. A relationship that inverted once is cheaper to check than to
    // debug, and no ratio would have caught it: the knob and its pill were 1.26 apart before the
    // dark theme and 1.26 apart after it, with the sign flipped.
    const directions = await page.evaluate(([pairs, activeTheme]) => {
      const root = document.documentElement;
      if (activeTheme === 'dark') root.dataset.theme = 'dark';
      else delete root.dataset.theme;
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const luminanceOf = (name) => {
        const value = getComputedStyle(root).getPropertyValue(`--color-${name}`).trim();
        if (value === '') return null;
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = '#000';
        ctx.fillStyle = value;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
        const ch = (c) => {
          const s = c / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
      };
      return pairs.map((pair) => ({
        ...pair,
        theme: activeTheme,
        lighterLum: luminanceOf(pair.lighter),
        darkerLum: luminanceOf(pair.darker),
      }));
    }, [DIRECTION_PAIRS, theme]);
    for (const row of directions) {
      if (row.lighterLum === null || row.darkerLum === null) {
        failures.push(`[${theme}] direction ${row.lighter} vs ${row.darker} -- a token resolved to nothing`);
      } else if (row.lighterLum <= row.darkerLum) {
        failures.push(
          `[${theme}] ${row.lighter} (${row.lighterLum.toFixed(4)}) is NOT lighter than `
          + `${row.darker} (${row.darkerLum.toFixed(4)}) -- ${row.where}`,
        );
      }
    }

    const measured = await page.evaluate(measureInPage, [PAIRS, theme]);
    for (const row of measured) {
      rows.push(row);
      if (!row.resolved) {
        failures.push(`[${theme}] ${row.fg} on ${row.bg} — one of the tokens resolved to nothing (${row.where})`);
      } else if (row.ratio < row.threshold) {
        failures.push(
          `[${theme}] ${row.fg} on ${row.bg} = ${row.shown}:1 (exact ${row.ratio}), needs ${row.threshold}:1 — ${row.where}`,
        );
      }
    }
  }
} finally {
  await browser.close();
}

if (artifactDir) {
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    join(artifactDir, 'contrast-report.json'),
    `${JSON.stringify({ rows, failures }, null, 2)}\n`,
  );
}

const worst = rows
  .filter((row) => row.resolved)
  .sort((a, b) => a.ratio / a.threshold - b.ratio / b.threshold)
  .slice(0, 5)
  .map((row) => `${row.theme}:${row.fg}/${row.bg}=${row.shown}`)
  .join('  ');

if (failures.length > 0) {
  console.error(`check:contrast-rendered FAILED — ${failures.length} pair(s) below threshold:`);
  for (const line of failures) console.error(`  ${line}`);
  process.exit(1);
}

console.log(
  `check:contrast-rendered passed: ${rows.length} measurement(s) — ${PAIRS.length} pair(s) x 2 themes `
  + `— every one at or above its threshold, measured from computed styles in a real browser.\n`
  + `  ${MANIFEST_PAIRS.length} from the manifest (is the palette sound?) and ${OBSERVED_PAIRS.length} `
  + 'read out of the product\'s own class strings (do the screens pair it soundly?).\n'
  + `tightest five: ${worst}`,
);
