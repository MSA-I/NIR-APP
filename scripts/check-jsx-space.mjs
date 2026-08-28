/**
 * Two translated expressions on consecutive JSX lines render with NO space between them.
 *
 * This is not a style rule. JSX keeps a single space where a run of whitespace containing a
 * newline sits between two pieces of TEXT, and DROPS it where the same whitespace sits between
 * two EXPRESSIONS. So a paragraph written as
 *
 *     המסמך נשמר,
 *     והוא ממתין לבדיקה.
 *
 * reads correctly, and the same paragraph after extraction —
 *
 *     {t('documents.text_18')}
 *     {t('documents.text_19')}
 *
 * — renders `המסמך נשמר,והוא ממתין לבדיקה.` The words are glued, in both languages, on every
 * screen the line-based extractor split. Seventeen of them shipped before this guard existed;
 * `extract.mjs` now joins a multi-line text block into one key, and this refuses the shape
 * outright so a hand-written one cannot reintroduce it.
 *
 * The fix at a call site is `{' '}` on the end of the earlier line — the same explicit space the
 * repo already uses where a space has to survive a line break.
 *
 * Measured, not assumed: `render(<p>{'a,'}{'\n'}{'b.'}</p>)` produces `a,b.` — that reading is
 * pinned by `src/components/jsxAdjacentExpressions.spec.tsx`, so this guard cannot outlive the
 * behaviour it defends against.
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.tsx$/.test(entry) && !/\.spec\.tsx$/.test(entry)) files.push(full);
  }
})(path.join(root, 'src'));

/** A line that is nothing but one `t(...)` expression — the shape the extractor emits. */
const BARE = /^\s*\{t\((?:'[^']*'|[A-Za-z_$][\w$.[\]]*)(?:,[\s\S]*)?\)\}\s*$/;

const offences = [];
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  for (let i = 1; i < lines.length; i += 1) {
    if (BARE.test(lines[i]) && BARE.test(lines[i - 1])) {
      offences.push(`${path.relative(root, file).split(path.sep).join('/')}:${i + 1}`);
    }
  }
}

if (offences.length) {
  console.error(
    `check:jsx-space FAILED — ${offences.length} place(s) where two translated expressions sit on\n` +
    'consecutive lines. JSX drops the whitespace between them, so the words render glued together.\n' +
    "Add `{' '}` to the end of the earlier line, or make the two keys one sentence:\n  " +
    offences.join('\n  '),
  );
  process.exit(1);
}

console.log(`check:jsx-space passed: ${files.length} .tsx file(s), no glued translated expressions.`);
