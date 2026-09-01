#!/usr/bin/env node
/**
 * check:decision-numbers — two owner rulings may not share a number, and a citation may not
 * point at a ruling that is not there.
 *
 * WHY, AND IT IS NOT HYPOTHETICAL. Merging wave 1 and wave 2 produced this, with NO conflict
 * whatsoever — git placed the two rows side by side and reported a clean merge:
 *
 *     | 311 | **האם חלון ההשקה מוארך, ועד מתי** | …    ← #174
 *     | 311 | **הכניסה המאוחדת** | …                   ← #195
 *
 * Two different decisions, one number, and nothing to see. That is worse than a conflict: a
 * conflict stops you. This is the same accident #173 fixed on `#306` in August, and by 01.09.2026
 * `#309` was claimed by three separate pull requests at once.
 *
 * These numbers are how the repository cites the owner's decisions — from migrations, from ADRs,
 * from code comments. A duplicate makes every citation of that number ambiguous, and a citation
 * of a row that does not exist is a pointer into nothing. Both are silent until someone needs the
 * answer, which is exactly when being wrong is expensive.
 *
 * The plan claimed this guard existed before it did. It does now.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const docPath = process.env.DECISION_DOC_PATH || path.join(repoRoot, 'docs', 'OPEN-DECISIONS.md');
const inject = process.env.DECISION_NUMBERS_INJECT;

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(docPath)) fail(`check:decision-numbers FAILED — ${docPath} is not there.`);

let source = readFileSync(docPath, 'utf8');
if (inject === 'duplicate') {
  // Re-state an existing row under a number that already exists, the way a clean merge does.
  const first = source.match(/^\|\s*(\d{3})\s*\|.*$/m);
  if (first) source += `\n${first[0]}\n`;
}
if (inject === 'dangling') {
  source += '\n> A sentence that cites `#997` for a ruling that was never written.\n';
}

const lines = source.split(/\r?\n/);

// ---------------------------------------------------------------- rows
const rows = new Map();          // number -> [{ line, title }]
lines.forEach((line, index) => {
  const m = line.match(/^\|\s*(\d{2,4})\s*\|\s*(.*?)\s*\|/);
  if (!m) return;
  const number = m[1];
  if (!rows.has(number)) rows.set(number, []);
  rows.get(number).push({ line: index + 1, title: m[2].replace(/\*/g, '').slice(0, 68) });
});

if (rows.size === 0) {
  fail('check:decision-numbers FAILED — parsed zero decision rows. The table shape changed and\n'
    + '  this guard is measuring nothing.');
}

const duplicates = [...rows.entries()].filter(([, list]) => list.length > 1);
if (duplicates.length) {
  fail('check:decision-numbers FAILED — a decision number is used more than once:\n\n'
    + duplicates.map(([n, list]) => `    #${n} appears ${list.length} times:\n`
      + list.map((r) => `      line ${r.line}: ${r.title}`).join('\n')).join('\n\n')
    + '\n\n  A merge does NOT conflict on this: two pull requests each append a row and git puts\n'
    + '  them side by side. Every citation of that number is then ambiguous — and these numbers\n'
    + '  are cited from migrations, ADRs and code comments. Renumber the later one, by landing\n'
    + '  order, and carry the number through everything that cites it.');
}

// ---------------------------------------------------------------- citations
// ONLY the unambiguous form is checked. A bare `#312` is also an issue number, a pull
// request, a section heading and a percentage — scanning for it raised six false alarms on
// main alone (#127, #128, #129, #130, #140, #309). The repository already writes
// `OPEN-DECISIONS #274` wherever it means this table, and that is the only citation a guard
// can resolve without guessing.
const known = new Set(rows.keys());
let citations = [];
try {
    const out = execFileSync('git', ['grep', '--untracked', '-hoE', 'OPEN-DECISIONS #[0-9]{3}',
    '--', 'docs', 'supabase', 'src', 'scripts'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  citations = [...new Set(out.split('\n').map((s) => s.match(/(\d{3})/)?.[1]).filter(Boolean))];
} catch (error) {
  if (error.status !== 1) {
    fail(`check:decision-numbers FAILED — the citation scan could not run: ${String(error.stderr ?? '').slice(0, 160)}`);
  }
}
if (inject === 'dangling') citations.push('997');

// Anything at or above the first real row is in the decision space; below it the number is
// almost certainly something else entirely (a migration, a port, a percentage).
const lowest = Math.min(...[...known].map(Number));
const dangling = citations
  .filter((n) => Number(n) >= lowest && !known.has(n))
  .sort();

if (dangling.length) {
  fail('check:decision-numbers FAILED — citation(s) point at a ruling that is not in the table:\n\n'
    + dangling.map((n) => `    #${n}`).join('\n')
    + '\n\n  Either the row was renumbered and this citation was left behind, or it was never\n'
    + '  written. Both leave a reader following a pointer into nothing.');
}


// ---------------------------------------------------------------- citations INSIDE the code
// The rulings are not only cited in prose. Measured across src, supabase and scripts: 1,653 bare
// `#NNN` citations, and they are how the code actually points at a decision — a migration saying
// which ruling it implements, a component saying why it renders what it does. A wrong one here is
// worse than a broken link: the number still names a REAL ruling, so the comment reads as
// authoritative and describes the wrong decision. #174's move from #311 to #314 left exactly that
// behind in four places, including a reason string a migration greps for at run time.
//
// TWO EXCLUSIONS, BOTH MEASURED, NEITHER AN ALLOWLIST OF NUMBERS:
//   * stylesheets — `#000` is the colour black, not ruling zero. No decision is cited from CSS.
//   * this file — it names historical numbers in order to explain them, which is the same trap
//     that has now caught three guards in this repo.
// A token longer than three digits is not a citation either: `#4338ca` is a colour and `#7702` is
// an order number, and matching their first three digits was what made an earlier pass of this
// measurement look impossible.
const CODE_PATHS = ['src', 'supabase', 'scripts'];
const SELF_FILE = 'scripts/check-decision-numbers.mjs';
let codeCitations = [];
try {
  // Whole lines, not just the token: deciding whether `#666` is a ruling or the colour grey
  // needs what sits immediately to its left, and `-o` throws exactly that away.
  const out = execFileSync('git', ['grep', '--untracked', '-nIE', '#[0-9]{3}', '--', ...CODE_PATHS],
    { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  // A CSS colour is not a citation even when it is written inside a .ts file. The exclusion
  // above was by file EXTENSION, which is why `color:#666` in an inline HTML email template
  // read as a ruling: activation-email.ts is TypeScript that emits styles. Match the property
  // instead of the filename -- that is what the comment above already claims to be doing.
  // Two shapes, because a colour is written two ways. `color:#666` is the CSS declaration; the
  // canvas API assigns instead -- `ctx.fillStyle = '#000'` -- and check-contrast-rendered.mjs is
  // full of exactly that, being a contrast checker. Neither is a citation. The quote before the
  // `#` is what makes the second safe: a real citation is never written `= '#331'`.
  const CSS_COLOUR = /(?:color|background|background-color|fill|stroke|border|border-color|outline|box-shadow|text-shadow|stop-color|caret-color)\s*:\s*$/i;
  const COLOUR_ASSIGNED = /(?:fillStyle|strokeStyle|shadowColor|backgroundColor|borderColor|Color)\s*=\s*['"`]$/i;
  codeCitations = out.split(String.fromCharCode(10)).filter(Boolean).flatMap((hit) => {
    const parts = hit.split(':');
    const lineNo = parts.at(1);
    const file = parts.at(0);
    const text = parts.slice(2).join(':');
    const found = [];
    for (const m of text.matchAll(/#([0-9]{3})([0-9a-fA-F]*)/g)) {
      if (m[2].length) continue;                                   // #4338ca is a colour, #7702 an order
      const before = text.slice(Math.max(0, m.index - 24), m.index);
      if (CSS_COLOUR.test(before) || COLOUR_ASSIGNED.test(before)) continue;
      found.push({ file, lineNo, token: m[1] });
    }
    return found;
  }).filter((c) => !c.file.endsWith('.css')
    && c.file !== SELF_FILE
    && c.file !== 'scripts/renumber-map.json');
} catch (error) {
  if (error.status !== 1) {
    fail(`check:decision-numbers FAILED — the code citation scan could not run: ${String(error.stderr ?? '').slice(0, 160)}`);
  }
}
if (inject === 'code') {
  codeCitations.push({ file: 'src/pages/Dashboard.tsx', lineNo: '1', token: '996' });
}

const badCode = codeCitations.filter((c) => !known.has(c.token));
if (badCode.length) {
  const shown = badCode.slice(0, 20);
  fail(`check:decision-numbers FAILED — ${badCode.length} citation(s) in the CODE name a ruling that`
    + ` is not in the table:\n\n`
    + shown.map((c) => `    ${c.file}:${c.lineNo} -> #${c.token}`).join(String.fromCharCode(10))
    + (badCode.length > 20 ? `${String.fromCharCode(10)}    … and ${badCode.length - 20} more` : '')
    + '\n\n  Either the ruling was renumbered and this citation stayed behind, or it was never'
    + '\n  written. A stale number is the dangerous case: it still names a real ruling, so the'
    + '\n  comment reads as authoritative while describing a different decision entirely.');
}

const numbers = [...known].map(Number).sort((a, b) => a - b);
console.log(`check:decision-numbers passed: ${rows.size} rulings, #${numbers[0]}–#${numbers.at(-1)},`
  + ` none duplicated, ${citations.length} prose citation(s) and ${codeCitations.length} in code all resolve.`);
