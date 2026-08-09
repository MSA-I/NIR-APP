/**
 * check:money — one place decides what a shekel looks like.
 *
 * Why this exists. `check:tokens` already forbids a raw colour in a .tsx, because a second source
 * of colour truth drifts. Money had no such gate, and it drifted further: by 09.08.2026 the app
 * rendered currency FIVE ways at once —
 *
 *   fmtMoneyExact  → `354.00 ₪`   (correct)
 *   fmtMoney       → `0 ₪` · `780 ₪` · `1,650.6 ₪`   (shape depended on the value)
 *   lib/checks.ts  → `₪1234.5`    (symbol prefixed, toLocaleString with no locale at all)
 *   charts.tsx     → `₪1,235`     (symbol prefixed, rounded)
 *   ten .tsx sites → `₪1234.50`   (symbol prefixed, NO thousands separator)
 *
 * `Suppliers.tsx` carried two of those conventions in one file, in adjacent columns. None of it was
 * a bug anybody typed on purpose; it is what happens when every screen may invent a format.
 *
 * WHAT IS BANNED, and only this:
 *   1. the shekel sign glued to an interpolated value — `₪{v}`, `₪${v}`, `{v}₪`, `${v} ₪`.
 *      That is a hand-rolled money format, and it also puts the symbol on the wrong side of the
 *      figure from every table in the app.
 *   2. `toLocaleString(` outside src/lib/format.ts. Without a locale argument it follows the
 *      reader's browser, so the same invoice reads differently on two machines.
 *   3. `new Intl.NumberFormat` with a currency outside src/lib/format.ts — a second formatter is
 *      how the first drift started.
 *
 * WHAT IS DELIBERATELY ALLOWED: `₪` in prose and comments; `(₪)` as the unit beside a numeric
 * input; `₪` inside a character class that STRIPS it while parsing (Bank.tsx, importSheet.ts,
 * document-review/model.ts); and `₪` in a test's literal expectation. None of those format a
 * figure, and banning them would push the next author toward something worse.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const srcDir = join(root, 'src');
/** The one file allowed to decide the shape of money. */
const FORMAT_MODULE = join(srcDir, 'lib', 'format.ts');

interface Rule {
  readonly id: string;
  readonly re: RegExp;
  readonly why: string;
  readonly fix: string;
}

const RULES: readonly Rule[] = [
  {
    id: 'symbol-glued-to-value',
    // The sign immediately before an interpolation, or immediately after one.
    re: /₪\s*\$?\{|\}\s*₪/g,
    why: 'the shekel sign is being glued to an interpolated value — a hand-rolled money format',
    fix: 'use fmtMoneyExact (ledgers, tables, detail, anything about money being moved) or '
      + 'fmtMoneyRounded (KPI tiles, chart axes) from src/lib/format.ts',
  },
  {
    id: 'to-locale-string',
    re: /\.toLocaleString\(/g,
    why: 'toLocaleString follows the reader\'s browser locale, so the same figure reads differently '
      + 'on two machines',
    fix: 'format through src/lib/format.ts, which pins he-IL',
  },
  {
    id: 'second-currency-formatter',
    re: /new Intl\.NumberFormat\([^)]*currency/g,
    why: 'a second currency formatter is exactly how the first drift started',
    fix: 'add the variant to src/lib/format.ts and export it, so there is one place to read',
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

const findings: string[] = [];

for (const file of walk(srcDir)) {
  if (file === FORMAT_MODULE) continue;
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);

  for (const rule of RULES) {
    lines.forEach((line, index) => {
      rule.re.lastIndex = 0;
      if (!rule.re.test(line)) return;
      findings.push(
        `  ${relative(root, file)}:${index + 1} — ${rule.why}\n`
        + `    ${line.trim().slice(0, 160)}\n`
        + `    Fix: ${rule.fix}`,
      );
    });
  }
}

if (findings.length > 0) {
  console.error(
    `check:money FAILED — ${findings.length} hand-rolled money format(s).\n\n`
    + findings.join('\n\n')
    + '\n\n  A financial product that spells the same amount three ways teaches its own users not\n'
    + '  to trust the figures. src/lib/format.ts is the one place that decides.',
  );
  process.exit(1);
}

console.log(`check:money passed: ${RULES.length} rules over src/**/*.ts(x), src/lib/format.ts exempt.`);
