/**
 * check:counts — the numbers in CLAUDE.md, checked in milliseconds instead of by the next agent.
 *
 * CLAUDE.md is the file every agent reads FIRST, and it states how big the gates are: how many
 * SQL suites `npm run quality` runs, how many preflight arms, how many browser scenarios, how
 * many tests `check:review` and `vitest` execute. Those numbers are load-bearing — a reader who
 * counts 27 where 28 exist stops looking one suite early.
 *
 * They have drifted five times. CLAUDE.md documents the history itself: 13 → 20 → 26 → 27 for
 * suites; 22 → 25 → 29 → 30 → 33 for scenarios; 16 → 21 → 22 for check:review; seven → eight for
 * the check:* scripts. Every drift was found by a human re-counting by hand, after the stale
 * number had already misled someone. The constitution's own instruction — "סופרים לפני שכותבים" —
 * had no enforcement behind it.
 *
 * This is that enforcement, built the same way `check:exemptions` was: recount from the source of
 * truth, then require the prose to agree. Nothing here reads a database, starts a browser, or
 * runs a test — it is text arithmetic over files that are already on disk.
 *
 * WHAT IT DOES NOT COUNT, deliberately: the number of tests `vitest run` reports (422 today). A
 * test count cannot be read from text without re-implementing a test collector — `describe`
 * nesting, `test.each`, and conditional registration all make the file lie. The vitest FILE count
 * is checked (a glob is exact); the test count is pinned in CLAUDE.md from the runner's own
 * output. ponytail: if that one number drifts again, parse `vitest run --reporter=json` here
 * rather than guessing from source text.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

const claudeMd = read('CLAUDE.md');

/**
 * CLAUDE.md is written right-to-left and carries U+200F RIGHT-TO-LEFT MARKs inside the prose,
 * often between a bullet and the number that follows it. They are invisible in an editor and
 * would silently break every anchor below, so they are stripped before matching. Nothing else
 * about the text is normalised: the anchors must match the document as written.
 */
const prose = claudeMd.replace(/[‎‏‪-‮⁦-⁩]/g, '');

interface Anchor {
  /** Where in CLAUDE.md this restatement lives, for the failure message. */
  readonly where: string;
  /** Must capture exactly one group: the number as written. */
  readonly re: RegExp;
}

interface Claim {
  readonly id: string;
  /** How the number is derived — printed on success so the next reader can redo it. */
  readonly how: string;
  readonly actual: number;
  readonly anchors: readonly Anchor[];
}

/** `Invoke-SqlTest "supabase\tests\<name>.sql" "<label>"` — one call per suite. */
const SQL_SUITE_CALL = /Invoke-SqlTest\s+"supabase\\tests\\/g;
/** Every mention of the helper, including its definition and the two fixture loads. */
const ANY_SQL_TEST_MENTION = /Invoke-SqlTest/g;
/** `select '<name>'` — one per preflight arm, the first plain and the rest `union all`. */
const PREFLIGHT_ARM = /select\s+'/g;
/** `await run(` — the scenario invocation. Bare `run(` also catches the declaration. */
const BROWSER_SCENARIO = /await run\(/g;
/** A top-level `test(` in a node:test file. Nesting is not used in model.test.ts. */
const NODE_TEST = /^\s*test\(/gm;

const qualityGates = read('scripts/check-quality-gates.ps1');
const packageJson = JSON.parse(read('package.json')) as { scripts: Record<string, string> };

const checkScripts = Object.keys(packageJson.scripts)
  .filter((name) => name.startsWith('check:'))
  .map((name) => name.slice('check:'.length));

const sqlTestFiles = readdirSync(join(root, 'supabase/tests')).filter((f) => f.endsWith('.sql'));

/** vitest.config.ts pins `include: ['src/**\/*.spec.{ts,tsx}']`; `.test.ts` belongs to node:test. */
function countSpecFiles(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += countSpecFiles(path);
    else if (/\.spec\.tsx?$/.test(entry.name)) total += 1;
  }
  return total;
}

const claims: readonly Claim[] = [
  {
    id: 'sql-suites',
    how: 'Invoke-SqlTest calls in check-quality-gates.ps1 whose first argument is supabase\\tests\\…',
    actual: [...qualityGates.matchAll(SQL_SUITE_CALL)].length,
    anchors: [
      { where: 'the `npm run quality` bullet ("מריץ N סוויטות SQL")', re: /(\d+)\*{0,2}\s*ל?סוויטות/g },
      // Was: the "מה שה-CI לא מכסה" sentence, which claimed the suites do NOT run on CI.
      // On 09.08.2026 they started running there (quality-gate.yml, job `sql`), so the claim
      // moved into the job list rather than disappearing — and the anchor moves with it.
      { where: 'the quality-gate.yml job list ("N סוויטות + preflight")', re: /(\d+) סוויטות \+ preflight/g },
    ],
  },
  {
    id: 'sql-test-mentions',
    how: 'every occurrence of the string Invoke-SqlTest in check-quality-gates.ps1 (definition + fixtures included)',
    actual: [...qualityGates.matchAll(ANY_SQL_TEST_MENTION)].length,
    anchors: [{ where: '"בקובץ יש N מופעים של המחרוזת"', re: /\*\*(\d+)\*\* מופעים של המחרוזת/g }],
  },
  {
    id: 'sql-test-files',
    how: '.sql files in supabase/tests/ (one more than the suites: p1_preflight.sql runs via Invoke-Preflight)',
    actual: sqlTestFiles.length,
    anchors: [{ where: '"יש N קבצי `.sql`"', re: /\*\*(\d+)\*\* קבצי `\.sql`/g }],
  },
  {
    id: 'preflight-arms',
    how: "select '<name>' arms in supabase/tests/p1_preflight.sql",
    actual: [...read('supabase/tests/p1_preflight.sql').matchAll(PREFLIGHT_ARM)].length,
    anchors: [
      { where: 'the preflight mentions ("preflight עם N זרועות")', re: /(\d+)\*{0,2} זרועות/g },
      { where: '"Invoke-Preflight זורק אם לא חזרו בדיוק N שורות"', re: /בדיוק (\d+) שורות/g },
    ],
  },
  {
    id: 'browser-scenarios',
    how: 'await run( calls in scripts/check-browser-smoke.cjs',
    actual: [...read('scripts/check-browser-smoke.cjs').matchAll(BROWSER_SCENARIO)].length,
    anchors: [
      { where: 'the scenario mentions ("N תרחישי דפדפן" / "N תרחישים")', re: /(\d+)\*{0,2}\s*ל?תרחיש(?:ים|י)/g },
      { where: '"N נכון ל-<date>" inside the counting note', re: /\((\d+) נכון ל-/g },
    ],
  },
  {
    id: 'review-tests',
    how: 'top-level test( declarations in src/components/document-review/model.test.ts',
    actual: [...read('src/components/document-review/model.test.ts').matchAll(NODE_TEST)].length,
    anchors: [
      { where: 'the `check:review` bullet ("— N בדיקות")', re: /model\.test\.ts` — \*\*(\d+)\*\* בדיקות/g },
      { where: "node:test's own output quoted in the parenthetical", re: /`ℹ tests (\d+)`/g },
      { where: 'the drift-history line', re: /\*\*(\d+)\*\* ל-`check:review`/g },
    ],
  },
  {
    id: 'vitest-files',
    how: "src/**/*.spec.{ts,tsx} — vitest.config.ts's include pattern",
    actual: countSpecFiles(join(root, 'src')),
    anchors: [{ where: 'the `npm run test` bullet ("… בדיקות ב-N קבצים")', re: /בדיקות ב-\*\*(\d+)\*\* קבצים/g }],
  },
  {
    id: 'check-scripts',
    how: 'check:* keys in package.json',
    actual: checkScripts.length,
    anchors: [],
  },
];

const failures: string[] = [];

for (const claim of claims) {
  for (const anchor of claim.anchors) {
    const found = [...prose.matchAll(anchor.re)].map((m) => Number(m[1]));

    if (found.length === 0) {
      failures.push(
        `  ${claim.id} — the anchor for ${anchor.where} matched nothing in CLAUDE.md.\n`
        + `    Either the sentence was reworded or the claim was dropped. If the wording changed,\n`
        + `    update the anchor in scripts/check-counts.ts; if the claim is gone, delete it here too.\n`
        + `    An anchor that matches nothing protects nothing.`,
      );
      continue;
    }

    const wrong = found.filter((n) => n !== claim.actual);
    if (wrong.length > 0) {
      failures.push(
        `  ${claim.id} — CLAUDE.md says ${[...new Set(wrong)].join(', ')}, the repository has ${claim.actual}.\n`
        + `    Where : ${anchor.where}\n`
        + `    Counted: ${claim.how}\n`
        + `    ${found.length} restatement(s) of this number were checked; ${wrong.length} disagree.`,
      );
    }
  }
}

/**
 * The check:* list is spelled out in CLAUDE.md as names, not as a digit ("alerts · dashboard · …"),
 * so it is compared as a set. A script added to package.json and not to that line is the exact
 * failure the "שבעה → שמונה" drift was.
 */
// The character class carries `-` because a script name may be hyphenated
// (`check:supplier-columns`, the first one). This widens what the anchor can TOKENISE; it
// does not weaken what is compared — the set equality below is unchanged, and a script added
// to package.json and not to CLAUDE.md still fails. The rule "fix CLAUDE.md, not the script"
// is about the COUNTS; a parser that cannot express a legal name is a different bug.
const listedScripts = /`(alerts(?: · [a-z0-9:-]+)+)`/.exec(prose);
if (!listedScripts) {
  failures.push(
    '  check-scripts — could not find the `alerts · dashboard · …` list in CLAUDE.md.\n'
    + '    That list is how a reader learns which gates exist. If it moved, fix the anchor.',
  );
} else {
  const listed = listedScripts[1].split(' · ');
  const missing = checkScripts.filter((s) => !listed.includes(s));
  const extra = listed.filter((s) => !checkScripts.includes(s));
  if (missing.length || extra.length) {
    failures.push(
      `  check-scripts — the list in CLAUDE.md and package.json disagree.\n`
      + `    package.json has ${checkScripts.length}: ${checkScripts.join(' · ')}\n`
      + `    CLAUDE.md lists ${listed.length}: ${listed.join(' · ')}\n`
      + (missing.length ? `    Missing from CLAUDE.md: ${missing.join(', ')}\n` : '')
      + (extra.length ? `    Listed but not in package.json: ${extra.join(', ')}\n` : '')
      + `    Also update the Hebrew word before "סקריפטי ה-check:*" — it is spelled, not written as a digit.`,
    );
  }
}

if (failures.length > 0) {
  console.error(
    'check:counts FAILED — CLAUDE.md understates or overstates the gates.\n\n'
    + failures.join('\n\n')
    + '\n\n  This is the check working. CLAUDE.md is read FIRST by every agent, and a stale count\n'
    + '  sends the reader to look for fewer suites, fewer scenarios or fewer tests than exist.\n'
    + '  Fix CLAUDE.md to the counted values above — do not "fix" this script to agree with prose.',
  );
  process.exit(1);
}

console.log(
  'check:counts passed: '
  + claims.map((c) => `${c.id}=${c.actual}`).join(', ')
  + '.',
);
