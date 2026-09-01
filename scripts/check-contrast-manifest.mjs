/**
 * check:contrast — the STATIC half of the contrast contract.
 *
 * It proves the manifest in `contrast-pairs.mjs` is complete and honest. It does NOT compute a
 * single ratio, and that is the whole design: the palette is `oklch`, several tokens are
 * `color-mix()` over other tokens and two carry alpha, so a ratio computed from two literals in
 * Node answers a question nobody asked. The measurement lives in `check-contrast-rendered.cjs`,
 * inside the CI browser job, where a browser can resolve what these actually are.
 *
 * Putting the measurement in `verify` was considered and rejected: `verify` stands up no preview and
 * no browser, and a gate that quietly grew one would change what `npm run verify` means for every
 * other change in the repository.
 *
 * WHAT THIS CATCHES, which is the part worth having in a two-second gate:
 *   · a pair naming a token that does not exist — the rendered gate would measure `transparent`
 *     against `transparent` and cheerfully pass;
 *   · an ink token that appears in NEITHER the manifest nor the exemption list, which is how a new
 *     text colour ships unmeasured;
 *   · a status family that gained a rung nobody pinned;
 *   · the same pair listed twice, which inflates the count and hides a missing one.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DIRECTION_PAIRS, INK_TOKENS, NON_TEXT_EXEMPT, NON_TEXT_PAIRS, STATUS_FAMILIES,
  TEXT_EXEMPT, TEXT_PAIRS,
} from './contrast-pairs.mjs';

const cssPath = fileURLToPath(new URL('../src/index.css', import.meta.url));
const css = readFileSync(cssPath, 'utf8');

const failures = [];
const fail = (why) => failures.push(why);

// ---- the tokens `@theme` actually defines -------------------------------------------------------
const themeStart = css.indexOf('@theme');
let themeEnd = -1;
if (themeStart !== -1) {
  let depth = 0;
  for (let i = css.indexOf('{', themeStart); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) { themeEnd = i + 1; break; }
    }
  }
}
if (themeEnd === -1) {
  console.error('check:contrast FAILED — could not read the @theme block in src/index.css.');
  process.exit(1);
}
const defined = new Set(
  [...css.slice(themeStart, themeEnd).matchAll(/--color-([a-z0-9]+(?:-[a-z0-9]+)*)\s*:/g)].map((m) => m[1]),
);

const ALL = [
  ...TEXT_PAIRS.map((pair) => ({ ...pair, kind: 'text', threshold: 4.5 })),
  ...NON_TEXT_PAIRS.map((pair) => ({ ...pair, kind: 'non-text', threshold: 3 })),
];
/** Everything the manifest names at all, measured or not -- used for the existence check. */
const NAMED = [
  ...ALL,
  ...NON_TEXT_EXEMPT.map((pair) => ({ ...pair, kind: 'non-text exemption', where: pair.reason })),
  ...DIRECTION_PAIRS.map((pair) => ({ fg: pair.lighter, bg: pair.darker, kind: 'direction', where: pair.where })),
];

// ---- 1. every named token exists ---------------------------------------------------------------
for (const { fg, bg, where, kind } of NAMED) {
  for (const [role, name] of [['foreground', fg], ['background', bg]]) {
    if (!defined.has(name)) {
      fail(`${kind} pair "${where}" names a ${role} --color-${name} that @theme does not define — `
        + 'the rendered gate would compare two unresolved values and pass');
    }
  }
}

// ---- 2. no duplicates, because a duplicate hides a gap -----------------------------------------
const seen = new Map();
for (const { fg, bg, where } of ALL) {
  const key = `${fg}|${bg}`;
  if (seen.has(key)) {
    fail(`the pair ${fg} on ${bg} is listed twice ("${seen.get(key)}" and "${where}") — `
      + 'a duplicate inflates the count and makes a missing pair look covered');
  }
  seen.set(key, where);
}

// ---- 3. every ink token is measured or exempted, with a reason ----------------------------------
const measuredForegrounds = new Set(ALL.map((pair) => pair.fg));
for (const ink of INK_TOKENS) {
  if (measuredForegrounds.has(ink)) continue;
  if (TEXT_EXEMPT.has(ink)) continue;
  fail(`--color-${ink} carries text but appears in neither the manifest nor TEXT_EXEMPT — `
    + 'a text colour that is in neither list is a text colour nobody has measured');
}
for (const [ink, reason] of TEXT_EXEMPT) {
  if (!defined.has(ink)) {
    fail(`--color-${ink} is exempted ("${reason}") but @theme no longer defines it — delete the exemption`);
  }
  if (measuredForegrounds.has(ink)) {
    fail(`--color-${ink} is BOTH measured and exempted — decide which, because the exemption is a `
      + 'claim that the pair cannot pass');
  }
}

// ---- 3b. the same completeness check, DERIVED from the stylesheet rather than hand-written -------
/**
 * `INK_TOKENS` is a list somebody maintains, and on 31.08.2026 it was wrong in the way hand-written
 * lists are always wrong: `shell-ink-dim` and `inverse-ink-dim` both carry real lettering — the
 * label at the top of every chart tooltip and the org name under the drawer's brand mark — and
 * neither appeared in it, so neither was ever measured. Both then turned out to be fine, which is
 * the point: nobody knew that. This derives the list from the naming convention instead, so the
 * NEXT rung to be added is measured on the day it is added rather than on the day it is noticed.
 */
const LOOKS_LIKE_LETTERING = /(^ink(-|$))|(-ink(-|$))|(-fg$)|(-on-soft$)|(^chart-(tick|label)$)/;
for (const token of [...defined].sort()) {
  if (!LOOKS_LIKE_LETTERING.test(token)) continue;
  if (measuredForegrounds.has(token)) continue;
  if (TEXT_EXEMPT.has(token)) continue;
  // A `*-ink` token is sometimes a GROUND for its own family's reverse pill (`bg-inverse-ink`), and
  // being measured as a background is being measured.
  if (ALL.some((pair) => pair.bg === token)) continue;
  fail(`--color-${token} is named like lettering but appears nowhere in the manifest — measure it `
    + 'against the ground it is written on, or exempt it with a reason');
}

// ---- 4. every status family is accounted for on all four rungs ---------------------------------
for (const family of STATUS_FAMILIES) {
  const measured = (fg, bg) => ALL.some((pair) => pair.fg === fg && pair.bg === bg);
  const accounted = (fg, bg) => measured(fg, bg)
    || NON_TEXT_EXEMPT.some((pair) => pair.fg === fg && pair.bg === bg);
  if (!measured(`${family}-fg`, 'surface')) fail(`${family}: no "fg on surface" pair -- status text on a card is unmeasured`);
  if (!measured(`${family}-on-soft`, `${family}-soft`)) fail(`${family}: no "on-soft on soft" pair -- the badge is unmeasured`);
  if (!measured('on-solid', `${family}-solid`)) fail(`${family}: no "on-solid on solid" pair -- the filled chip is unmeasured`);
  // The badge border is EXEMPT rather than measured, but it still has to be NAMED: a rung in neither
  // list is a rung nobody decided about.
  if (!accounted(`${family}-line`, `${family}-soft`)) {
    fail(`${family}: the badge border appears in neither NON_TEXT_PAIRS nor NON_TEXT_EXEMPT -- `
      + 'name it or measure it, but do not leave it out');
  }
}

// ---- 5. every exemption carries a reason, and none of them is also measured ---------------------
for (const { fg, bg, reason } of NON_TEXT_EXEMPT) {
  if (!reason || reason.trim().length < 20) {
    fail(`the exemption ${fg} on ${bg} has no real reason -- an exemption without one is a pair `
      + 'somebody gave up on');
  }
  if (ALL.some((pair) => pair.fg === fg && pair.bg === bg)) {
    fail(`${fg} on ${bg} is BOTH measured and exempted -- decide which`);
  }
}

// ---- 6. the contract that exists because it was got wrong once ----------------------------------
if (!DIRECTION_PAIRS.some((pair) => pair.lighter === 'toggle-knob' && pair.darker === 'toggle-track')) {
  fail('the appearance switch knob/track DIRECTION contract is missing -- the relationship inverted '
    + 'between themes once (the raised disc became a hole in the dark palette) and a ratio would '
    + 'not have caught it');
}

if (failures.length > 0) {
  console.error('check:contrast FAILED — the contrast manifest is not complete:');
  for (const why of failures) console.error(`  ${why}`);
  process.exit(1);
}

console.log(
  `check:contrast passed: ${TEXT_PAIRS.length} text pair(s) at 4.5:1, ${NON_TEXT_PAIRS.length} `
  + `non-text pair(s) at 3:1, ${DIRECTION_PAIRS.length} direction contract(s), `
  + `${TEXT_EXEMPT.size} text and ${NON_TEXT_EXEMPT.length} non-text exemption(s) each carrying a `
  + `reason; every token defined in @theme, no duplicates, and all ${STATUS_FAMILIES.length} status `
  + 'families accounted for on text, badge, filled chip and boundary. The RATIOS are measured in the '
  + 'CI browser job (scripts/check-contrast-rendered.mjs) -- this gate only proves the list is honest.',
);
