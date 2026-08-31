/**
 * The colour pairs the PRODUCT actually renders together, read out of every `className` literal.
 *
 * WHY THIS EXISTS ALONGSIDE THE MANIFEST. `contrast-pairs.mjs` is a list somebody maintains, and on
 * 31.08.2026 it was complete, honest, green -- and blind to three real defects, because it answers
 * "is the palette sound?" and not "do the screens pair it soundly?". A monogram disc wore an ink
 * that inverts with the theme (1.64:1 in the dark), a chart tooltip took its ground from a family
 * that inverts and its lettering from one that does not (1.08:1 -- white on white), and every focus
 * ring inside the phone drawer used the paper focus colour on an inverted panel (1.21:1). All three
 * were pairs no human had thought to list. This file does not think; it reads the source.
 *
 * A pair is reported ONLY when a foreground utility and a background utility land in the same class
 * set, which means the browser really composites one over the other.
 *
 * THE LIMIT, STATED PLAINLY: a `text-*` whose ground comes from an ANCESTOR is invisible here. The
 * drawer's focus rings are exactly that case -- `bg-inverse` sits on the panel at Layout.tsx and the
 * rings are on rows inside it -- and they were caught by measuring a hypothesis, not by this scan.
 * So this narrows the gap; it does not close it. A live screen sweep is still the only thing that
 * resolves an inherited ground.
 */
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const files = execSync('git ls-files "src/**/*.tsx" "src/**/*.ts"', { encoding: 'utf8' })
  .split(/\r?\n/)
  .map((f) => f.trim())
  .filter((f) => (f.endsWith('.tsx') || f.endsWith('.ts')) && existsSync(f));

const css = readFileSync('src/index.css', 'utf8');
const themeStart = css.indexOf('@theme');
let depth = 0;
let themeEnd = -1;
for (let i = css.indexOf('{', themeStart); i < css.length; i += 1) {
  if (css[i] === '{') depth += 1;
  else if (css[i] === '}') {
    depth -= 1;
    if (depth === 0) { themeEnd = i + 1; break; }
  }
}
const defined = new Set([
  ...css.slice(themeStart, themeEnd).matchAll(/--color-([a-z0-9]+(?:-[a-z0-9]+)*)\s*:/g),
].map((m) => m[1]));

/** Quoted runs that look like they hold utilities. */
const STRINGS = /'([^'\n]{2,600})'|"([^"\n]{2,600})"|`([^`]{2,600})`/g;
/**
 * The trailing `(?![/\w-])` drops any utility carrying an ALPHA MODIFIER.
 *
 * `hover:bg-inverse-ink/10` is a 10% wash of that token over whatever is behind it, not the solid
 * token — and the real ground is the ancestor. Reading it as solid invented four pairs that nothing
 * renders, one of which "failed" at 1.33:1 and cost a diagnosis.
 */
const FG = /(?:^|[\s:[])text-([a-z][a-z0-9-]*)(?![/\w-])/g;
const BG = /(?:^|[\s:[])bg-([a-z][a-z0-9-]*)(?![/\w-])/g;
const BD = /(?:^|[\s:[])(?:border|ring|divide)-([a-z][a-z0-9-]*)(?![/\w-])/g;

/** Utility suffixes that are sizes/alignments/keywords, not colours. */
const NOT_A_COLOUR = new Set([
  'xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '2xs',
  'left', 'right', 'center', 'start', 'end', 'justify', 'balance', 'pretty',
  'nowrap', 'wrap', 'ellipsis', 'clip', 'transparent', 'current', 'inherit', 'none',
  'inset', 'offset', 'fixed', 'auto', 'top', 'bottom', 'contain', 'cover', 'repeat',
  '0', '1', '2', '3', '4', '8',
]);

const pairs = new Map();
const add = (fg, bg, kind, site) => {
  if (fg === bg) return;
  if (!defined.has(fg) || !defined.has(bg)) return;
  const key = `${kind}|${fg}|${bg}`;
  if (!pairs.has(key)) pairs.set(key, { fg, bg, kind, sites: new Set() });
  pairs.get(key).sites.add(site);
};

const grab = (re, s) => {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (!NOT_A_COLOUR.has(m[1])) out.push(m[1]);
  }
  return out;
};

/**
 * One literal becomes one class set PER BRANCH — base text plus that branch, never two branches.
 *
 * A template literal that reads `` `…ring-inset ${active ? 'bg-action text-on-solid' : 'text-ink-soft
 * hover:bg-surface-hover'}` `` describes TWO class sets, and the two are mutually exclusive states.
 * Pairing across them invents `on-solid` on `surface-hover` — the selected item's ink over the
 * resting item's hover wash, a thing no element ever wears. But dropping the base along with the
 * holes loses the pairs that matter most: `ring-inset ring-focus` lives in the base and the fill it
 * is drawn on lives in a branch, which is exactly the combination that hid a real 2.00:1 focus ring.
 * So: base × each branch.
 */
const classSets = (literal) => {
  const branches = [...literal.matchAll(/'([^'\n]{2,300})'|"([^"\n]{2,300})"/g)]
    .map((b) => b[1] ?? b[2])
    .filter((b) => /(?:^|[\s:[])(?:text|bg|border|ring|divide)-/.test(b));
  const base = literal.replace(/\$\{[^{}]*\}/g, ' ').replace(/'[^'\n]*'|"[^"\n]*"/g, ' ');
  return branches.length === 0 ? [base] : branches.map((b) => `${base} ${b}`);
};

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  STRINGS.lastIndex = 0;
  let m;
  while ((m = STRINGS.exec(src)) !== null) {
    const whole = m[1] ?? m[2] ?? m[3];
    for (const s of classSets(whole)) {
      if (!/(?:^|[\s:[])(?:text|bg|border|ring|divide)-/.test(s)) continue;
      const bgs = grab(BG, s);
      if (bgs.length === 0) continue;
      /* A ring only sits on the element's OWN ground when it is INSET. Otherwise it is drawn
         outside, over the parent — which is why `focus` on `action` looked like a failure at the
         skip link, where the ring is outside a filled pill on the page ground. */
      const ringIsInset = /(?:^|[\s:[])ring-inset\b/.test(s);
      for (const bg of bgs) {
        for (const fg of grab(FG, s)) add(fg, bg, 'text', file);
        if (!ringIsInset && !/(?:^|[\s:[])(?:border|divide)-/.test(s)) continue;
        for (const bd of grab(BD, s)) add(bd, bg, 'non-text', file);
      }
    }
  }
}

const rows = [...pairs.values()].map((p) => ({
  fg: p.fg,
  bg: p.bg,
  kind: p.kind,
  threshold: p.kind === 'text' ? 4.5 : 3,
  where: `rendered together in ${[...p.sites].sort()[0]}${p.sites.size > 1 ? ` and ${p.sites.size - 1} other file(s)` : ''}`,
  sites: [...p.sites].sort().slice(0, 3),
  siteCount: p.sites.size,
}));
rows.sort((a, b) => (a.kind === b.kind ? a.fg.localeCompare(b.fg) : a.kind.localeCompare(b.kind)));

/**
 * Drops the pairs the manifest has already DECIDED are below threshold on purpose.
 *
 * One exemption list, not two. A rendered pair is skipped only when `contrast-pairs.mjs` names it —
 * `TEXT_EXEMPT` by token (placeholder and disabled lettering) or `NON_TEXT_EXEMPT` by pair — so a
 * new exclusion has to be written down, with a reason, in the same place every other one lives.
 */
export const informationBearing = (nonTextExempt, textExempt) => rows.filter((row) => {
  if (row.kind === 'text' && textExempt.has(row.fg)) return false;
  return !nonTextExempt.some((pair) => pair.fg === row.fg && pair.bg === row.bg);
});

export const observedPairs = rows;

// Run directly (`node scripts/observed-pairs.mjs`) to dump the raw list for inspection.
if (process.argv[1] && process.argv[1].endsWith('observed-pairs.mjs')) {
  process.stdout.write(JSON.stringify(rows));
}
