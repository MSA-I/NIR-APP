/**
 * check:i18n — a ratchet on hardcoded Hebrew in the product source.
 *
 * WHY A PINNED COUNT AND NOT A BAN. Extraction runs across ~205 files and takes a phase. A guard
 * that forbade Hebrew outright would be red for that entire phase, and a guard that is red for a
 * phase gets commented out. So this pins a count PER FILE and fails in BOTH directions: a file
 * that gains Hebrew is a regression, and a file that loses it without moving its pin means the
 * baseline is stale and the next regression would hide inside the slack. Same shape as
 * scripts/check-exemption-pin.ts, and for the same reason — a number that only ever goes down is
 * a number someone has to argue with.
 *
 * WHAT IS DELIBERATELY NOT COUNTED:
 *   - Comments. This codebase writes them in English, and the handful of Hebrew ones are quoting
 *     product vocabulary, not shipping UI. Counting documentation would make the number mean
 *     something other than "strings a user reads", and a guard nobody trusts is a guard nobody
 *     keeps.
 *   - `*.spec.*`. Tests assert on literal Hebrew ON PURPOSE (see src/test/setup.ts): the test
 *     locale is pinned to `he`, so `getByText('שמירה')` keeps working and keeps its diagnostic
 *     power. Rewriting them to read the dictionary would make them pass against a broken
 *     dictionary, because both sides would be reading the same source.
 *   - The dictionaries themselves, and src/portal/i18n.ts. Hebrew is the content there.
 *
 * Run `node scripts/check-i18n.ts --update` after finishing a surface, then commit the baseline
 * move alongside the extraction that earned it.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const BASELINE = path.join(root, 'scripts', 'i18n-baseline.json');
const HEBREW = /[\u0590-\u05FF]/;

/** Paths whose Hebrew is content rather than interface. Matched as path prefixes, POSIX-style. */
const NOT_INTERFACE = [
  'src/lib/i18n/dictionaries/',
  'src/portal/i18n.ts',
];

type Baseline = { __reason: Record<string, string>; counts: Record<string, number> };

function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, found);
    else if (/\.tsx?$/.test(entry) && !/\.spec\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

/**
 * Strips comments before counting. Naive on purpose: it does not parse the language, so a `//`
 * inside a string literal (a URL, a regex) removes the rest of that line from the count. That
 * direction is safe — it can only UNDERCOUNT, and an undercount that gets pinned still fails the
 * moment a real string is added on a later line. A full parser here would be a second TypeScript
 * front end maintained to make a counter marginally tighter.
 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const counts: Record<string, number> = {};
for (const file of sources(path.join(root, 'src'))) {
  const relative = path.relative(root, file).split(path.sep).join('/');
  if (NOT_INTERFACE.some((prefix) => relative.startsWith(prefix))) continue;
  const hebrew = stripComments(readFileSync(file, 'utf8'))
    .split('\n')
    .filter((line) => HEBREW.test(line)).length;
  if (hebrew > 0) counts[relative] = hebrew;
}

const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

if (process.argv.includes('--update')) {
  let previous: Baseline;
  try {
    previous = JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline;
  } catch {
    previous = { __reason: {}, counts: {} };
  }
  writeFileSync(BASELINE, `${JSON.stringify({ __reason: previous.__reason, counts }, null, 2)}\n`);
  const before = Object.values(previous.counts).reduce((sum, n) => sum + n, 0);
  console.log(
    `check:i18n baseline updated: ${Object.keys(counts).length} file(s), ${total} Hebrew line(s)`
    + `${before ? ` (was ${before}, ${before - total >= 0 ? '-' : '+'}${Math.abs(before - total)})` : ''}.`,
  );
  process.exit(0);
}

let baseline: Baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline;
} catch {
  console.error(
    'check:i18n FAILED — scripts/i18n-baseline.json is missing or unreadable.\n'
    + '  Create it with: node scripts/check-i18n.ts --update',
  );
  process.exit(1);
}

const problems: string[] = [];
for (const [file, found] of Object.entries(counts)) {
  const pinned = baseline.counts[file];
  if (pinned === undefined) problems.push(`  ${file}: NEW file with ${found} Hebrew line(s), not in the baseline`);
  else if (found > pinned) problems.push(`  ${file}: ${pinned} → ${found}  (+${found - pinned}) — Hebrew was ADDED`);
  else if (found < pinned) problems.push(`  ${file}: ${pinned} → ${found}  (-${pinned - found}) — extracted, baseline is stale`);
}
for (const file of Object.keys(baseline.counts)) {
  if (counts[file] === undefined) problems.push(`  ${file}: pinned at ${baseline.counts[file]} but has no Hebrew left (or was deleted)`);
}

if (problems.length) {
  const added = problems.some((p) => p.includes('ADDED') || p.includes('NEW file'));
  console.error(
    `check:i18n FAILED — ${problems.length} file(s) disagree with the baseline.\n\n`
    + `${problems.join('\n')}\n\n`
    + (added
      ? '  Hebrew was hardcoded into product source. Put the string in src/lib/i18n/dictionaries/\n'
        + '  and read it with useT(). If it genuinely is not interface copy, say so in a comment —\n'
        + '  comments are not counted.\n'
      : '  Strings were extracted and the baseline did not follow. Run:\n'
        + '    node scripts/check-i18n.ts --update\n'
        + '  and commit the baseline move with the extraction that earned it.\n'),
  );
  process.exit(1);
}

const abandoned = Object.keys(baseline.__reason).length;
console.log(
  `check:i18n passed: ${Object.keys(counts).length} file(s) still carry ${total} Hebrew line(s), `
  + `all at their pinned counts${abandoned ? ` (${abandoned} documented exception(s))` : ''}.`,
);
