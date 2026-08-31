/**
 * check:appearance-scope — the dark theme reaches the tenant app and NOTHING ELSE.
 *
 * Three applications are built from this repository and all three import `src/index.css`
 * (`src/main.tsx`, `src/operator/main.tsx`, `src/portal/main.tsx`), so the dark palette is present
 * in the stylesheet of the platform operations console and of the PUBLIC, no-login supplier portal.
 * Neither has a theme switch and neither should ever turn dark.
 *
 * ADR-0010 requires that to be a POSITIVE contract. "The attribute is simply never set there" is a
 * negative one, and negative contracts are defeated silently: one shared import, or any module both
 * entries happen to load that writes the attribute, and a page a supplier opens without logging in
 * renders dark with nobody having touched its HTML. So the two other entries DECLARE
 * `data-theme="light"`, exactly one module is allowed to write the attribute, and this script is
 * what keeps both true.
 *
 * IT ALSO GUARDS THE FAVICON, which is a different bug with the same shape. `public/favicon.svg`
 * follows `prefers-color-scheme` — it must, because a browser tab cannot see a page theme — so any
 * in-page `<img src="/favicon.svg">` becomes a mark that flips with the OPERATING SYSTEM rather than
 * with the surface it sits on. That shipped once: the operator console, pinned to the light theme,
 * rendered a paper-white mark on a light pill on any machine with a dark OS. In-page marks use
 * `BrandMark` (inline, `currentColor`) or the static one-ink asset.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');

const failures = [];
const fail = (where, why) => failures.push({ where, why });

/** Every `.ts`/`.tsx` under src, specs included: a spec that writes the attribute is a leak too. */
function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) yield path;
  }
}

// ---- 1. The two other entries declare the light theme, and the tenant does not -----------------
for (const entry of ['operator.html', 'portal.html']) {
  const html = read(entry);
  if (!/<html[^>]*\sdata-theme="light"/.test(html)) {
    fail(entry, 'must carry data-theme="light" on <html> — a positive contract, not the absence of one (ADR-0010)');
  }
}
if (/<html[^>]*\sdata-theme=/.test(read('index.html'))) {
  fail('index.html', 'must NOT hard-code data-theme — the tenant entry resolves it in the pre-paint script');
}

// ---- 2. Exactly one pre-paint bootstrap, in the tenant entry ------------------------------------
const BOOTSTRAP = /localStorage\.getItem\(\s*'inplace\.theme'\s*\)/;
if (!BOOTSTRAP.test(read('index.html'))) {
  fail('index.html', 'the pre-paint theme bootstrap is missing — a dark page will flash light on every cold start');
}
for (const entry of ['operator.html', 'portal.html']) {
  if (BOOTSTRAP.test(read(entry))) {
    fail(entry, 'carries a theme bootstrap — this application has no theme and must not read the choice');
  }
}

// ---- 3. Only `appearance.ts` writes the attribute or touches the storage key --------------------
const OWNER = join(root, 'src', 'lib', 'appearance.ts');
const WRITES_ATTRIBUTE = /dataset\.theme\s*=|setAttribute\(\s*['"]data-theme['"]/;
const READS_KEY = /['"]inplace\.theme['"]|THEME_STORAGE_KEY/;
for (const file of sources(join(root, 'src'))) {
  if (file === OWNER) continue;
  // Comments blanked, like every other scan in this file: the rule is about USAGE, and prose that
  // names the key in order to explain the rule is not a second reader of it.
  const text = blankComments(readFileSync(file, 'utf8'));
  const where = relative(root, file);
  // A spec may set the attribute to arrange a dark render; it may not read the storage key, which is
  // the part that decides the theme for a real person.
  const isSpec = /\.spec\.tsx?$/.test(where);
  if (WRITES_ATTRIBUTE.test(text) && !isSpec) {
    fail(where, 'writes data-theme — only src/lib/appearance.ts may, or the two are two sources of truth');
  }
  if (READS_KEY.test(text) && !isSpec) {
    fail(where, "reads the theme storage key — go through src/lib/appearance.ts");
  }
}

// ---- 4. No second dark mechanism in the stylesheet ---------------------------------------------
const css = read('src/index.css');
if (/@media[^{]*prefers-color-scheme\s*:\s*dark/.test(css)) {
  fail('src/index.css', 'a prefers-color-scheme:dark block is a SECOND dark mechanism — the switch is authoritative, and the OS only seeds the first visit');
}
if (/(^|[^-\w.]):is\(\.dark\)|(^|[\s,{])\.dark[\s,{]/.test(css)) {
  fail('src/index.css', 'a `.dark` class selector is a second dark mechanism — this product themes by [data-theme]');
}
if (!css.includes("[data-theme='dark']")) {
  fail('src/index.css', "the dark palette selector is gone — check:tokens' parity check silently stops running without it");
}

// ---- 5. The adaptive favicon never appears as an in-page mark ----------------------------------
//
// USAGE, NOT PROSE. The first version of this check matched the bare string and reported four files
// whose only mention of the path is a comment explaining why not to use it — including this rule's
// own reason, written next to the fix. Comments are blanked (the same discipline
// `check-design-tokens.ts` follows) and only an actual `src=`/`href=` attribute counts.
/**
 * A FUNCTION DECLARATION, not a `const` arrow, and that is load-bearing: declarations hoist, so
 * check 3 — which runs above this line — can call it. Check 3 was the one scan in this file still
 * reading raw text, and on 01.09.2026 it failed the gate on `theme-choice.ts` for a doc comment
 * NAMING the storage key while explaining that only `appearance.ts` may read it. A check that fails
 * on the sentence describing its own rule punishes documentation. The regex is local for the same
 * reason: a `const` at this position would be in its temporal dead zone when check 3 calls in.
 */
function blankComments(source) {
  const newlines = /[^\r\n]/g;
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(newlines, ' '))
    .replace(/\/\/.*/g, (m) => ' '.repeat(m.length));
}

const IN_PAGE_FAVICON = /(?:src|href)\s*=\s*(?:["'{]\s*)?["'`]?[^"'`]*\/favicon\.svg/;
for (const file of sources(join(root, 'src'))) {
  const text = blankComments(readFileSync(file, 'utf8'));
  if (IN_PAGE_FAVICON.test(text)) {
    fail(relative(root, file),
      'uses /favicon.svg as an in-page mark — that file follows the OS colour scheme, so it flips with the operating system instead of with its surface. Use BrandMark (inline) or /brand/inplace-symbol.svg');
  }
}

// ---- 6. the inline mark and the shipped asset draw the SAME shape ------------------------------
//
// `BrandMark.tsx` carries the symbol's two path `d` strings inline, because an external SVG loaded
// through `<img>` cannot inherit `currentColor` and the owner's rule is that the mark follows its
// ground. That leaves the geometry in three files — the component, `public/brand/inplace-symbol.svg`
// and `public/favicon.svg` — with nothing tying them together, so a future reshape could ship an
// in-page mark and a browser-tab mark that are different drawings. This is the tie.
const pathsOf = (source) => [...source.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1].trim());
const markPaths = pathsOf(read('public/brand/inplace-symbol.svg'));
if (markPaths.length === 0) {
  fail('public/brand/inplace-symbol.svg', 'no <path d> found — the extractor is broken, not the asset');
} else {
  for (const [file, label] of [['src/components/BrandMark.tsx', 'the inline component'],
                               ['public/favicon.svg', 'the browser-tab mark']]) {
    const found = pathsOf(read(file));
    const same = found.length === markPaths.length && found.every((d, i) => d === markPaths[i]);
    if (!same) {
      fail(file, `${label} draws a different shape from public/brand/inplace-symbol.svg — one mark, three files, and they have drifted`);
    }
  }
}

// ---- 7. the first-paint chrome colour is the token, not a transcription of it ------------------
//
// `appearance.ts` reads `--color-canvas` at runtime so the browser chrome cannot drift from the
// palette. `index.html` still has to STATE a colour, because it is needed before any stylesheet
// exists — so it states the token's own value, and this is what keeps the two the same after a
// repaint that only touches the stylesheet.
const lightCanvas = /--color-canvas:\s*([^;]+);/.exec(read('src/index.css'))?.[1]?.trim();
const metaColour = /<meta name="theme-color" content="([^"]+)"/.exec(read('index.html'))?.[1]?.trim();
if (lightCanvas === undefined) {
  fail('src/index.css', 'no --color-canvas found — the extractor is broken, not the stylesheet');
} else if (metaColour !== lightCanvas) {
  fail('index.html', `theme-color is "${metaColour}" but the light --color-canvas is "${lightCanvas}" — the first paint would show a ground the palette no longer uses`);
}

if (failures.length > 0) {
  console.error('check:appearance-scope FAILED — the dark theme must reach the tenant app and nothing else (ADR-0010):');
  for (const { where, why } of failures) console.error(`  ${where}  — ${why}`);
  process.exit(1);
}

console.log(
  'check:appearance-scope passed: operator.html and portal.html are pinned to light, the pre-paint '
  + 'bootstrap exists only in index.html, src/lib/appearance.ts is the only writer of data-theme and '
  + 'of the theme key, src/index.css carries the dark selector and no second dark mechanism, and no '
  + 'in-page mark uses the OS-adaptive /favicon.svg; the inline mark matches the shipped asset '
  + 'and the first-paint theme-color matches the light --color-canvas.',
);
