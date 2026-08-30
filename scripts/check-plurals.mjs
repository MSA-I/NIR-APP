/**
 * A ratchet on counted phrases that read "1 suppliers".
 *
 * `t()` reaches for a `<key>_one` sibling when the count is one (`src/lib/i18n/t.ts`). This counts
 * the English keys that interpolate `{count}` straight into a bare plural noun and have NO such
 * sibling — exactly the set that renders wrong at one. Pinned like every other ratchet here, so it
 * can only go down: 72 existed when the mechanism was built, and the phrases on the 44 screens of
 * `artifacts/i18n-audit-20260830` were converted first.
 *
 * A SEPARATE FILE rather than another branch of gate-i18n.mjs, for the same reason `ratchet`
 * delegates to `check-i18n.ts`: this one has to read the dictionary line by line, and a second
 * parser living inside the gate would be a second thing to keep in step with the first.
 *
 * HEURISTIC, and in the safe direction. `{count} rows ({rows})` is caught; `Orders ({count})` is
 * not, because a number in brackets reads correctly at one. A phrase that trips this and already
 * reads well is answered by adding the sibling anyway — one line, and it cannot make the copy
 * worse.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const PINNED = 48;

const root = process.cwd();
const source = readFileSync(path.join(root, 'src/lib/i18n/dictionaries/en.ts'), 'utf8');

const NAMESPACE = /^ {2}([A-Za-z0-9_]+): \{/;
const ENTRY = /^ {4}([A-Za-z0-9_]+): '(.*)',?\s*$/;
const COUNTED = /\{count\}\s+[a-z]+s\b/;

let namespace = null;
const keys = new Set();
const counted = [];
for (const line of source.split(/\r?\n/)) {
  const opened = line.match(NAMESPACE);
  if (opened) { namespace = opened[1]; continue; }
  const entry = line.match(ENTRY);
  if (!entry || !namespace) continue;
  const full = `${namespace}.${entry[1]}`;
  keys.add(full);
  if (COUNTED.test(entry[2])) counted.push([full, entry[2]]);
}

const open = counted.filter(([key]) => !keys.has(`${key}_one`));

function fail(message) {
  console.error(message);
  process.exit(1);
}

// Positive control: if NOTHING interpolates a count, an empty offender list proves nothing at all.
if (counted.length === 0) fail('check:plurals FAILED — no counted phrase found, so this check has no control.');

if (open.length > PINNED) {
  fail(`check:plurals FAILED — ${open.length} counted phrase(s) read "1 items", up from the pinned ${PINNED}.\n`
    + '  Add a <key>_one sibling in BOTH dictionaries; `t()` picks it up automatically.\n\n  '
    + open.map(([key, value]) => `${key}: ${value}`).join('\n  '));
}
if (open.length < PINNED) {
  fail(`check:plurals FAILED — ${open.length} counted phrase(s) still read "1 items", down from the pinned ${PINNED}.\n`
    + `  Good. Lower PINNED in scripts/check-plurals.mjs to ${open.length} and commit it with the conversion.`);
}

console.log(`check:plurals passed: ${counted.length} counted phrase(s), `
  + `${counted.length - open.length} with a singular sibling, ${open.length} pinned.`);
