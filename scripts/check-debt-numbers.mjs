#!/usr/bin/env node
/**
 * check:debt-numbers — two debt sections cannot share a number.
 *
 * WHAT THIS IS FOR. `DEBT-REGISTER.md` is addressed by number: commits, gate labels, migration
 * comments and owner rulings all say "§35" and mean one specific section. The number is the
 * identifier, and nothing was checking it was unique.
 *
 * HOW IT BREAKS, AND WHY GIT DOES NOT SAVE YOU. Two branches each append a new section, each
 * picking "the next free number" against the trunk they branched from. Both are right when they
 * are written. Git merges them without a conflict — they are additions in different places — and
 * the register now has two §-somethings. Every reference to that number is ambiguous from then on,
 * and nothing in the diff looks wrong. That is exactly what the seven merge waves produced.
 *
 * WHAT THIS DELIBERATELY DOES NOT CHECK. Not citations. A `§N` in this file that has no section
 * is usually correct prose: a section of a DIFFERENT document (`EMAIL-AND-BILLING…md §2`), or a
 * deliberate reference to a section that was closed and removed, which the register keeps on
 * purpose so the history stays readable. Measured on the tree this guard was written against, a
 * dangling-citation check produced three findings and all three were false. A gate that cries
 * wolf on a clean tree teaches people to skip it, which costs more than it catches.
 *
 * `scripts/next-free-number.mjs` is the other half: it scans branches before you pick a number.
 * This one catches what got through anyway.
 *
 * `INJECT=duplicate` restates an existing heading under a number already used, the way a clean
 * merge does — which is how check:gate-controls proves this guard bites.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const docPath = process.env.DEBT_DOC_PATH || path.join(repoRoot, 'docs', 'DEBT-REGISTER.md');
const inject = process.env.DEBT_NUMBERS_INJECT;

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(docPath)) fail(`check:debt-numbers FAILED — ${docPath} is not there.`);

let source = readFileSync(docPath, 'utf8');
if (inject === 'duplicate') {
  const first = source.match(/^### §\d+.*$/m);
  if (first) source += `\n${first[0]}\n`;
}

const lines = source.replace(/\r\n/g, '\n').split('\n');

// A heading owns one number, or several: `### §16 / §24 — ...` is one section answering to both.
const sections = new Map();   // number -> [{ line, title }]
lines.forEach((line, index) => {
  const heading = line.match(/^### (§\d+(?:\s*\/\s*§\d+)*)\s*—\s*(.*)$/);
  if (!heading) return;
  const title = heading[2].replace(/[`*]/g, '').slice(0, 68);
  for (const m of heading[1].matchAll(/§(\d+)/g)) {
    const number = m[1];
    if (!sections.has(number)) sections.set(number, []);
    sections.get(number).push({ line: index + 1, title });
  }
});

if (sections.size === 0) {
  fail('check:debt-numbers FAILED — parsed zero debt sections. The heading shape changed and this\n'
    + '  guard is measuring nothing.');
}

const duplicates = [...sections.entries()].filter(([, list]) => list.length > 1);
if (duplicates.length) {
  fail('check:debt-numbers FAILED — a debt section number is used more than once:\n\n'
    + duplicates.map(([n, list]) => `    §${n} appears ${list.length} times:\n`
      + list.map((r) => `      line ${r.line}: ${r.title}`).join('\n')).join('\n\n')
    + '\n\n  The number is how commits, gate labels and owner rulings address a section, so two\n'
    + '  sections sharing one make every reference to it ambiguous. Two branches picking the same\n'
    + '  "next free" number merge without a conflict, which is why this is caught here and not by\n'
    + '  git. Renumber the newer one — `node scripts/next-free-number.mjs` says what is free.');
}

console.log(`check:debt-numbers passed: ${sections.size} debt section number(s), none duplicated.`);
