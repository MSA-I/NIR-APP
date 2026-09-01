/**
 * A ratchet on dictionary keys nobody asks for.
 *
 * WHY THIS EXISTS, and it is the whole point of the campaign it came out of. Merge `7278f787`
 * brought the English dictionary across and dropped 439 `t()` calls with the conflicting hunks —
 * `Expenses.tsx` went from 59 calls to zero. The keys stayed, translated and unreachable, and the
 * screen went on rendering Hebrew beside them. **Nothing in the repository noticed.** `check:i18n`
 * could not: its count went UP, not down, so the ratchet was satisfied. `tsc` could not: an unused
 * object property is not an error. The audit of 30.08.2026 found 462 such keys, and the two worst
 * files were the two whose translation layer had been deleted whole.
 *
 * So this counts the leaf keys in `he.ts` that no file under `src/` names as a literal, and pins
 * the number. A key that loses its last call site raises it, which is the failure this exists for.
 *
 * WHAT IT DELIBERATELY CANNOT SEE, and why the number is a floor rather than a truth:
 *
 *   - `status.*` and `errors.*` are resolved by TEMPLATE — `t(`status.${row.status}`)` — so a
 *     literal search finds none of them. Excluded by name rather than reported as 254 false
 *     orphans, which would make the number meaningless and the guard ignorable.
 *   - Specs count as call sites. A key used only by a test is not orphaned in the sense that
 *     matters: something still reads it, and deleting it would break a check.
 *   - A `_one` plural sibling is reached by `t()` itself, never by a literal (`src/lib/i18n/t.ts`),
 *     so it is excluded the same way. Its BASE key is not, and that is the one worth watching.
 *
 * Lower the pin whenever keys are wired or deleted. It only ever goes down.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const PINNED = 129;

const root = process.cwd();
const DYNAMIC_NAMESPACES = new Set(['status', 'errors']);

const NAMESPACE = /^ {2}([A-Za-z0-9_]+): \{/;
const SUBSPACE = /^ {4}([A-Za-z0-9_]+): \{/;
const CLOSE = /^ {4}\},?$/;
const LEAF = /^\s+([A-Za-z0-9_]+):\s*['"`]/;

function leafKeys(file) {
  const source = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const keys = [];
  let namespace = null;
  let sub = null;
  for (const line of source.split(/\r?\n/)) {
    let m = line.match(NAMESPACE);
    if (m) { namespace = m[1]; sub = null; continue; }
    m = line.match(SUBSPACE);
    if (m) { sub = m[1]; continue; }
    if (CLOSE.test(line)) { sub = null; continue; }
    m = line.match(LEAF);
    if (m && namespace) keys.push(sub ? `${namespace}.${sub}.${m[1]}` : `${namespace}.${m[1]}`);
  }
  return keys;
}

function sourceText(dir, chunks = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) { sourceText(full, chunks); continue; }
    if (!/\.tsx?$/.test(entry)) continue;
    const relative = path.relative(root, full).split(path.sep).join('/');
    if (relative.includes('/i18n/dictionaries/')) continue;
    chunks.push(readFileSync(full, 'utf8'));
  }
  return chunks;
}

const keys = leafKeys(path.join(root, 'src/lib/i18n/dictionaries/he.ts'));
const blob = sourceText(path.join(root, 'src')).join('\n');
const named = (key) => blob.includes(`'${key}'`) || blob.includes(`"${key}"`) || blob.includes(`\`${key}\``);

const orphans = keys.filter((key) => !DYNAMIC_NAMESPACES.has(key.split('.')[0])
  && !key.endsWith('_one')
  && !named(key));

function fail(message) {
  console.error(message);
  process.exit(1);
}

// Positive control: if EVERY key looked orphaned the search itself would be broken, and an
// alarming number would read as a finding rather than as a bug in this file.
if (orphans.length > keys.length / 2) {
  fail(`check:orphan-keys FAILED — ${orphans.length} of ${keys.length} keys look unreachable, `
    + 'which means this check is broken rather than the dictionary.');
}

if (orphans.length > PINNED) {
  const added = orphans.slice(0, 25);
  fail(`check:orphan-keys FAILED — ${orphans.length} key(s) have no call site, up from the pinned ${PINNED}.\n`
    + '  A key lost its last reader: either a screen stopped asking for it, or it was written and never wired.\n'
    + '  This is the failure that let merge 7278f787 drop 439 t() calls unnoticed.\n\n  '
    + added.join('\n  ') + (orphans.length > 25 ? `\n  … and ${orphans.length - 25} more` : ''));
}
if (orphans.length < PINNED) {
  fail(`check:orphan-keys FAILED — ${orphans.length} key(s) have no call site, down from the pinned ${PINNED}.\n`
    + `  Good. Lower PINNED in scripts/check-orphan-keys.mjs to ${orphans.length} and commit it with the change.`);
}

console.log(`check:orphan-keys passed: ${keys.length} leaf key(s), ${orphans.length} with no call site, pinned.`);
