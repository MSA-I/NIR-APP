/**
 * check:tokens — the design-token rule as a gate instead of a sentence in prose.
 *
 * DESIGN.md ("חוק הטוקנים", §6 Runbook) requires the enforcement grep to return zero rows over
 * the product source: no raw Tailwind palette classes and no hex colour literals — every colour
 * goes through an `@theme` token in `src/index.css`, and charts go through `chartTheme()`.
 * Until this script, the grep lived only in documentation and depended on someone running it.
 *
 * Two scopes, because the rule means something different in each:
 *
 *   1. Product source (`.ts` + `.tsx` under src) — zero palette classes, zero hex literals.
 *      `.ts` is in scope because `src/lib/orderImage.ts` builds a whole styled HTML document
 *      and would otherwise be the one file able to regress to a literal unwatched.
 *
 *   2. `src/index.css` itself — it DEFINES the tokens, so a literal inside `@theme` is the
 *      point. Outside `@theme` it is a leak: the pointer glow and the body gradient each spelled
 *      an `@theme` value out a second time, so a retheme repainted the tokens and left the
 *      atmosphere behind. Outside the block, colour may only arrive through `var()`/`color-mix()`.
 *      `rgb()`/`hsl()` are barred everywhere in the file — the palette is oklch, and the five
 *      shadow tokens were hand-transcribed Onyx/Oceanic in exactly that notation.
 *
 *   3. Elevation, same rule one layer over. Tailwind's stock `shadow-{sm..2xl}` are neutral black
 *      and are NOT tokens: the modal panel and the toast wore them while every other raised
 *      surface derived its shadow from `--color-shell`/`--color-action`, so a brand repaint would
 *      have left the two highest surfaces in the product behind. `shadow-none` stays legal — it
 *      removes a shadow rather than inventing one.
 *
 * Third-party CSS (pdfjs's shipped stylesheet, THIRD_PARTY_NOTICES.md) stays outside the rule.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcRoot = fileURLToPath(new URL('../src', import.meta.url));
const cssPath = join(srcRoot, 'index.css');

/** DESIGN.md:359 verbatim. A new palette name or utility prefix goes into DESIGN.md first. */
const RAW_PALETTE =
  /\b(?:bg|text|border|ring|fill|stroke|divide|outline|decoration|placeholder|accent|caret|shadow)-(?:slate|gray|zinc|indigo|violet|blue|emerald|green|amber|yellow|orange|rose|red|sky|cyan|teal)-[0-9]{2,3}\b/g;

/** DESIGN.md:361 — zero hex literals in product source; charts read tokens via chartTheme(). */
const HEX_LITERAL = /#[0-9a-fA-F]{6}\b/g;

/**
 * Stock Tailwind elevation. The project ships seven named shadow tokens (card, card-hover,
 * dashboard, menu, toast, dialog, fab) and every one of them is a color-mix over a brand token.
 * A bare `shadow-lg` opts that surface out of the repaint contract without saying so.
 */
const STOCK_SHADOW = /\bshadow-(?:sm|md|lg|xl|2xl|inner)\b/g;

/** Inside index.css a 3-digit hex is a colour too (`color: #fff`); in .ts `#106` is an issue ref. */
const CSS_COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\boklch\(/g;

/** The palette is oklch. An rgb()/hsl() anywhere in the stylesheet is a hand-copied token. */
const LEGACY_NOTATION = /\brgba?\(|\bhsla?\(/g;

function* walkSource(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkSource(path);
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) yield path;
  }
}

interface Violation {
  file: string;
  line: number;
  match: string;
  why: string;
}

const violations: Violation[] = [];
const sourceFiles = [...walkSource(srcRoot)];
let scanned = 0;

for (const file of sourceFiles) {
  scanned += 1;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((text, index) => {
    const checks: [RegExp, string][] = [
      [RAW_PALETTE, 'raw colour in product source — use an @theme token'],
      [HEX_LITERAL, 'raw colour in product source — use an @theme token'],
      [STOCK_SHADOW, "stock Tailwind elevation — use a --shadow-* token (card/card-hover/dashboard/menu/toast/dialog/fab)"],
    ];
    for (const [pattern, why] of checks) {
      pattern.lastIndex = 0;
      for (const found of text.matchAll(pattern)) {
        violations.push({ file: relative(srcRoot, file), line: index + 1, match: found[0], why });
      }
    }
  });
}

/**
 * Blank a region out instead of slicing it, so every surviving line keeps its original number.
 * Comments go the same way: prose in a comment must never satisfy or trip an assertion.
 */
function blank(source: string, from: number, to: number) {
  return (
    source.slice(0, from) +
    source.slice(from, to).replace(/[^\n]/g, ' ') +
    source.slice(to)
  );
}

const rawCss = readFileSync(cssPath, 'utf8');
let css = rawCss.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));

const themeStart = css.indexOf('@theme');
if (themeStart === -1) {
  console.error('check:tokens FAILED — src/index.css has no @theme block. The token layer is the gate.');
  process.exit(1);
}

// Find the matching close brace so the block boundary is real, not a guess at indentation.
let depth = 0;
let themeEnd = -1;
for (let i = css.indexOf('{', themeStart); i < css.length; i += 1) {
  if (css[i] === '{') depth += 1;
  else if (css[i] === '}') {
    depth -= 1;
    if (depth === 0) {
      themeEnd = i + 1;
      break;
    }
  }
}
if (themeEnd === -1) {
  console.error('check:tokens FAILED — the @theme block in src/index.css is unbalanced.');
  process.exit(1);
}

const cssLineOf = (index: number) => css.slice(0, index).split('\n').length;

/**
 * Fourth scope, and the one the 2026-08-25 audit paid for: a semantic class that points at a
 * token which was never defined. `text-ink-strong` (18 uses, 8 files, all of the supplier portal)
 * and a bare `text-alert` (the „does not qualify" X in the operator console) both compiled to
 * nothing at all — Tailwind emits no rule for an undefined token, so the text silently inherited
 * its parent colour and the red warning was not red. The three checks above look for colour that
 * bypasses the token layer; this one looks for colour that *claims* the token layer and misses.
 *
 * Only names whose first segment already belongs to a defined family are judged — `ink-strong` is
 * tested because `ink`, `ink-body`, `ink-mid` exist, while `text-sm` and `border-b` are not colour
 * at all and are left alone. A whole new family is a deliberate act and shows up in review; a typo
 * inside an existing one is what nobody sees.
 */
/**
 * Comments are blanked before this scan, same rule the CSS side already follows: prose must never
 * trip an assertion. Two comments in the tree name a dead class on purpose — the note in
 * `DocumentOperations.tsx` explaining why the urgent banner lost its border, and the one in
 * `quickActions.spec.ts` listing the `bg-section-*` utilities nothing may use. Both are the record
 * of a fixed bug; failing the gate on them would delete the record. A `//` inside JSX text or a
 * regex is blanked too — that can only hide a violation on that line, never invent one.
 */
function blankComments(source: string) {
  let out = '';
  let mode: 'code' | 'line' | 'block' | '"' | "'" | '`' = 'code';
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (mode === 'code') {
      if (ch === '/' && next === '/') { mode = 'line'; out += '  '; i += 1; continue; }
      if (ch === '/' && next === '*') { mode = 'block'; out += '  '; i += 1; continue; }
      if (ch === '"' || ch === "'" || ch === '`') mode = ch;
      out += ch;
      continue;
    }
    if (mode === 'line') {
      if (ch === '\n') { mode = 'code'; out += ch; continue; }
      out += ' ';
      continue;
    }
    if (mode === 'block') {
      if (ch === '*' && next === '/') { mode = 'code'; out += '  '; i += 1; continue; }
      out += ch === '\n' ? ch : ' ';
      continue;
    }
    // Inside a string literal: `\` escapes the next character, the matching quote closes it.
    if (ch === '\\') { out += '  '; i += 1; continue; }
    if (ch === mode) mode = 'code';
    out += ch;
  }
  return out;
}

const themeBody = css.slice(themeStart, themeEnd);
const definedTokens = new Set([...themeBody.matchAll(/--color-([a-z0-9]+(?:-[a-z0-9]+)*)\s*:/g)].map((m) => m[1]));
if (definedTokens.size === 0) {
  console.error('check:tokens FAILED — no --color-* tokens found inside @theme. The extractor is broken, not the source.');
  process.exit(1);
}
const colourFamilies = new Set([...definedTokens].map((name) => name.split('-')[0]));
const SEMANTIC_CLASS =
  /\b(?:bg|text|border|ring|fill|stroke|divide|outline|decoration|placeholder|accent|caret)-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\b/g;

for (const file of sourceFiles) {
  const lines = blankComments(readFileSync(file, 'utf8')).split(/\r?\n/);
  lines.forEach((text, index) => {
    SEMANTIC_CLASS.lastIndex = 0;
    for (const found of text.matchAll(SEMANTIC_CLASS)) {
      const name = found[1];
      if (definedTokens.has(name)) continue;
      if (!colourFamilies.has(name.split('-')[0])) continue;
      violations.push({
        file: relative(srcRoot, file),
        line: index + 1,
        match: found[0],
        why: `no --color-${name} in @theme — the class compiles to nothing and the colour silently falls back to the parent`,
      });
    }
  });
}

LEGACY_NOTATION.lastIndex = 0;
for (const found of css.matchAll(LEGACY_NOTATION)) {
  violations.push({
    file: 'index.css',
    line: cssLineOf(found.index ?? 0),
    match: found[0],
    why: 'rgb()/hsl() in the stylesheet — the palette is oklch; derive with color-mix(… var(--token) …)',
  });
}

const outsideTheme = blank(css, themeStart, themeEnd);
CSS_COLOUR_LITERAL.lastIndex = 0;
for (const found of outsideTheme.matchAll(CSS_COLOUR_LITERAL)) {
  violations.push({
    file: 'index.css',
    line: cssLineOf(found.index ?? 0),
    match: found[0].trim(),
    why: 'colour literal outside @theme — a rule body may only reach colour through var()/color-mix()',
  });
}

if (violations.length > 0) {
  console.error('check:tokens FAILED. Every colour goes through an @theme token (src/index.css + DESIGN.md together):');
  for (const v of violations) {
    console.error(`  src/${v.file.replace(/\\/g, '/')}:${v.line}  ${v.match}  — ${v.why}`);
  }
  process.exit(1);
}

console.log(
  `check:tokens passed: ${scanned} .ts/.tsx files with zero raw palette classes, zero hex literals, ` +
    `zero stock Tailwind shadows and zero references to a colour outside the ${definedTokens.size} ` +
    'tokens @theme actually defines; ' +
    'src/index.css keeps every colour literal inside @theme and uses no rgb()/hsl().',
);
