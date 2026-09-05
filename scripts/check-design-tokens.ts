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

/* ============================================================================================
 * The dark theme, and why this is a PARITY check rather than a literal ban (ADR-0010, #331).
 *
 * A second palette cannot live inside `@theme` — it needs a selector — so the rule "every colour
 * literal outside @theme is a leak" had to grow exactly one hole, and a hole with no shape is how
 * the token layer would rot. So: ONE canonical selector, and every token accounted for.
 *
 * `missing` is the failure that matters. A token nobody remembered to give a dark value does not
 * error at build time and does not error in the browser: it keeps its LIGHT value and renders, for
 * example, near-white body text on a near-white card. That is a silent, screen-sized bug, and it is
 * the reason this check exists at all rather than a comment asking people to be careful.
 *
 * AN ALIAS IS EXEMPT ONLY IF IT POINTS INSIDE THE PALETTE. `--color-chart-1: var(--color-action)`
 * follows `action` into the dark block for free and must not be restated. But the whole semantic
 * status family is `var(--color-emerald-50)` and friends — aliases to TAILWIND'S STOCK RAMP, which
 * has no idea this product has a dark theme. Those 34 tokens do NOT follow anything and are exactly
 * the ones a "skip the aliases" rule would have hidden. The distinction is mechanical: is the
 * target a token this `@theme` defines?
 * ========================================================================================== */
const DARK_SELECTOR = ":root[data-theme='dark']";

/** Tokens that legitimately have no dark value, each with the reason it does not need one. */
const DARK_EXEMPT = new Map<string, string>([
  ['shell', 'the on-dark family is dark BY DESIGN, not by theme — auth panels, aurora, tooltip'],
  ['shell-ink', 'ink on the on-dark ground; same reason'],
  ['shell-ink-soft', 'ink on the on-dark ground; same reason'],
  ['shell-ink-dim', 'ink on the on-dark ground; same reason'],
  // The table header strip, moved off `action` + `shell-ink-soft` on 03.09.2026 (RC6). The strip
  // always claimed the `shell` contract — this list said so — but only its INK came from `shell`;
  // its band came from `action`, which the dark theme turns into light paper. Half a contract is
  // not a contract: the band measured 1.24:1 in the dark. Both halves are named here now, so
  // "dark in both themes" is a claim about the whole strip and not about one of its two colours.
  ['table-head', 'the table header strip is dark BY DESIGN, not by theme — one idiom on every screen'],
  ['table-head-ink', 'ink on that strip; same reason'],
  ['fixed-onyx', 'onyx as fill/ink on a LIGHT surface (btn-rainbow body, plan badge words) in both themes'],
  ['aurora-1', 'the auth aurora paints an on-dark panel in both themes; its ramp is the frozen light values of the chart ramp'],
  ['aurora-2', 'the auth aurora paints an on-dark panel in both themes; its ramp is the frozen light values of the chart ramp'],
  ['aurora-3', 'the auth aurora paints an on-dark panel in both themes; its ramp is the frozen light values of the chart ramp'],
  ['aurora-4', 'the auth aurora paints an on-dark panel in both themes; its ramp is the frozen light values of the chart ramp'],
  // The mirror of the `shell` family: those surfaces are dark by design, these are LIGHT by
  // design. The document plate is the sheet the product's generated files are drawn on — PDFs,
  // the order image, the workbook, the supplier portal's rendering of them. Paper is white in
  // both themes, and a document that inverted with the reader's app theme would print wrong.
  // Six tokens, added when wave 7's dark theme met wave 6's document plate: neither pull request
  // knew about the other, and the guard is what noticed.
  ['doc-plate-lift', 'the generated-document sheet is paper, and paper is white in both themes'],
  ['doc-plate-line', 'rules on that sheet; same reason'],
  ['doc-plate-action', 'the action colour printed on that sheet; same reason'],
  ['doc-ink-soft', 'ink on the paper sheet; same reason'],
  // doc-ink-muted is NOT here any more: it has a real dark value. The claim that the sheet
  // is paper in both themes was wrong -- `doc-paper` aliases `surface`, which flips.
  // The other five stay: three sit on the dark plate, and doc-ink-body follows `ink-soft`.
  ['doc-ink-dim', 'ink on the paper sheet; same reason'],
  ['aurora-5', 'the auth aurora paints an on-dark panel in both themes; its ramp is the frozen light values of the chart ramp'],
  // The assistant card, the third family on this list and the same reason as the first: it is a
  // DARK surface inside a light product, by owner ruling 01.09.2026, not a light surface that a
  // dark page flips. Every step is Onyx — the shell's own hue — so on a dark page the card is
  // already the right dark and a second value would only make it drift from the chrome it
  // belongs to. Seven tokens remain after P9 removed the gradient and decorative motes; the same
  // collision the document plate had, and the same guard that noticed.
  ['assistant-card', 'the assistant card is dark BY DESIGN, not by theme — the owner chose a dark card in a light product'],
  ['assistant-rim', 'the card frame; same reason'],
  ['assistant-edge', 'inner hairlines on the card; same reason'],
  ['assistant-well', "the composer's field on the card; same reason"],
  ['assistant-bubble', 'a soft surface ON the dark card; same reason'],
  ['assistant-bubble-hover', 'its hover step; same reason'],
  ['assistant-focus', 'the focus ring lightened for the dark card specifically; same reason'],
]);

const aliasTarget = (declaration: string) => /var\(\s*--color-([a-z0-9-]+)\s*\)/.exec(declaration)?.[1];

/** name -> whether its @theme value is an alias to another token IN this palette. */
const followsPalette = new Map<string, boolean>();
for (const found of themeBody.matchAll(/--color-([a-z0-9]+(?:-[a-z0-9]+)*)\s*:([^;]*);/g)) {
  const target = aliasTarget(found[2]);
  followsPalette.set(found[1], target !== undefined && definedTokens.has(target));
}

const darkStart = css.indexOf(DARK_SELECTOR);
let darkEnd = -1;
if (darkStart !== -1) {
  let depth = 0;
  for (let i = css.indexOf('{', darkStart); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) { darkEnd = i + 1; break; }
    }
  }
  if (darkEnd === -1) {
    console.error(`check:tokens FAILED — the ${DARK_SELECTOR} block in src/index.css is unbalanced.`);
    process.exit(1);
  }

  const darkBody = css.slice(darkStart, darkEnd);
  const darkDeclared: string[] = [...darkBody.matchAll(/--color-([a-z0-9]+(?:-[a-z0-9]+)*)\s*:/g)].map((m) => m[1]);
  const darkSet = new Set(darkDeclared);

  if (darkDeclared.length !== darkSet.size) {
    const seen = new Set<string>();
    for (const name of darkDeclared) {
      if (seen.has(name)) {
        violations.push({
          file: 'index.css',
          line: cssLineOf(darkStart),
          match: `--color-${name}`,
          why: 'declared twice inside the dark selector — the second wins silently, so one of them is a lie',
        });
      }
      seen.add(name);
    }
  }

  for (const name of darkSet) {
    if (definedTokens.has(name)) continue;
    violations.push({
      file: 'index.css',
      line: cssLineOf(darkStart),
      match: `--color-${name}`,
      why: 'given a dark value but never defined in @theme — a dark-only token cannot be used by any utility',
    });
  }

  const missing = [...definedTokens]
    .filter((name) => !darkSet.has(name))
    .filter((name) => !DARK_EXEMPT.has(name))
    .filter((name) => followsPalette.get(name) !== true)
    .sort();

  if (missing.length > 0) {
    for (const name of missing) {
      violations.push({
        file: 'index.css',
        line: cssLineOf(darkStart),
        match: `--color-${name}`,
        why: 'no dark value — it would keep its LIGHT value on a dark page, which renders but is wrong',
      });
    }
  }

  for (const [name, reason] of DARK_EXEMPT) {
    if (!definedTokens.has(name)) {
      violations.push({
        file: 'index.css',
        line: cssLineOf(darkStart),
        match: `--color-${name}`,
        why: `on the dark-exemption list ("${reason}") but no longer defined in @theme — delete the exemption`,
      });
    }
  }
}

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

const outsideTheme = darkStart === -1
  ? blank(css, themeStart, themeEnd)
  // The dark selector is the ONE declared hole in "no literals outside @theme"; the parity
  // check above is what keeps it a hole and not an exit.
  : blank(blank(css, themeStart, themeEnd), darkStart, darkEnd);
CSS_COLOUR_LITERAL.lastIndex = 0;
for (const found of outsideTheme.matchAll(CSS_COLOUR_LITERAL)) {
  violations.push({
    file: 'index.css',
    line: cssLineOf(found.index ?? 0),
    match: found[0].trim(),
    why: 'colour literal outside @theme — a rule body may only reach colour through var()/color-mix()',
  });
}

/**
 * Fifth scope — the ONE declared exemption, kept to exactly one file.
 *
 * Owner ruling 27.08.2026 (OPEN-DECISIONS #296): «צבע הנייר נשאר. המנויים זה הדבר היחיד שיכול
 * לחרוג ממסגרת הצבעים של האפליקציה». The subscription plan card is drawn identically here and on
 * the marketing site, so it is authored once in `src/styles/plan-card.css` and copied there; and
 * because the two repositories give the SAME token names opposite values (`--color-ink` is a light
 * ink on that dark page and the darkest ink there is here), the shared file cannot read a host
 * token at all. It therefore carries absolute values — the thing every other file is forbidden.
 *
 * What this check defends is the word "היחיד". An exemption nobody counts is not an exemption, it
 * is a hole: the next stylesheet added under `src/` would inherit the freedom without anyone
 * ruling on it. So the rule is structural rather than textual — there are exactly two stylesheets
 * in this project, and a third is a failure whatever it contains.
 */
const ALLOWED_STYLESHEETS = new Set(['index.css', 'styles/plan-card.css']);
function* walkStylesheets(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkStylesheets(path);
    else if (entry.isFile() && entry.name.endsWith('.css')) yield path;
  }
}
const stylesheets = [...walkStylesheets(srcRoot)].map((path) =>
  relative(srcRoot, path).replace(/\\/g, '/'),
);
for (const sheet of stylesheets) {
  if (ALLOWED_STYLESHEETS.has(sheet)) continue;
  violations.push({
    file: sheet,
    line: 1,
    match: sheet,
    why:
      'a second stylesheet outside the token layer — only src/styles/plan-card.css is exempt ' +
      '(OPEN-DECISIONS #296), and that exemption covers the plan card alone. Put the colour in ' +
      '@theme and the rule in index.css.',
  });
}
for (const sheet of ALLOWED_STYLESHEETS) {
  if (stylesheets.includes(sheet)) continue;
  violations.push({
    file: sheet,
    line: 1,
    match: sheet,
    why: 'the declared stylesheet is missing — either it was deleted, or ALLOWED_STYLESHEETS is stale',
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
    'src/index.css keeps every colour literal inside @theme and uses no rgb()/hsl(); ' +
    `${stylesheets.length} stylesheet(s) under src/, and the only one exempt from the token layer ` +
    'is styles/plan-card.css (OPEN-DECISIONS #296).',
);
