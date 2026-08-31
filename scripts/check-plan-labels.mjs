/**
 * The Hebrew half of the commercial catalogue must equal the database, row for row.
 *
 * WHY THIS EXISTS. `src/lib/planLabels.ts` moved plan names and entitlement labels out of the
 * server's response and into the dictionary, so that an English reader stops seeing
 * `The פרימיום plan…` and `Move to חינם` (owner decision 31.08.2026, OPEN-DECISIONS #303). That
 * move creates a SECOND copy of wording the database already holds — and `PlanBadge` has the
 * cautionary tale written into it: `TIER_CLASS` "used to exist twice, character for character,
 * and the two copies had already drifted where it counts".
 *
 * So this parses the seeding migrations and asserts that every Hebrew entry still matches the row
 * it mirrors. It fails in BOTH directions that matter:
 *
 *   - a migration renames a plan or a quota and the dictionary is not updated → the Hebrew screen
 *     silently says something the database does not, and the English screen says a third thing;
 *   - a key is seeded with no dictionary entry at all → not an error, but it is REPORTED, because
 *     that row will render Hebrew to an English reader and nobody would otherwise notice.
 *
 * It reads `he.ts` only. English is a translation and is expected to differ; `en: Dictionary`
 * already makes `tsc` fail when a key is missing on that side.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const MIGRATIONS = path.join(root, 'supabase/migrations');
const DICTIONARY = path.join(root, 'src/lib/i18n/dictionaries/he.ts');

const dictionaryEntry = (source, name) => {
  const match = source.match(new RegExp(`^\\s+${name}: '([^']*)',`, 'm'));
  return match ? match[1] : null;
};

const dictionary = readFileSync(DICTIONARY, 'utf8');
const files = readdirSync(MIGRATIONS).filter((file) => file.endsWith('.sql')).sort();

const asDictionaryName = (prefix, key) => `${prefix}${key.replace(/[.]/g, '_')}`;

/**
 * Migrations are read IN ORDER and a later file overwrites an earlier one, because a rename is a
 * later file: 0154 seeded `('free', 'Free', 1, true)` and 0184 renamed it to «חינם». Reading the
 * whole corpus at once and taking any match would pin the dictionary to wording the database
 * stopped using — this guard reported exactly that on its own first run, and the bug was here
 * rather than in the catalogue.
 *
 * A plan label is written in TWO shapes and both count. 0184 renames through
 * `update … from (values (key, tier_order, label))` — key, INT, label — and seeds the two new
 * rungs through `insert … values (key, label, tier_order, active)` — key, label, INT. Matching
 * only the insert shape makes the rename invisible, which is what happened.
 */
function labelsFor(shapes) {
  const found = new Map();
  for (const file of files) {
    const source = readFileSync(path.join(MIGRATIONS, file), 'utf8');
    for (const { pattern, key, label } of shapes) {
      for (const match of source.matchAll(pattern)) found.set(match[key], match[label]);
    }
  }
  return found;
}

const plans = labelsFor([
  { pattern: /\(\s*'([a-z][a-z0-9_]*)'\s*,\s*'([^']+)'\s*,\s*-?\d+\s*,\s*(?:true|false)\s*\)/g, key: 1, label: 2 },
  { pattern: /\(\s*'([a-z][a-z0-9_]*)'\s*,\s*-?\d+\s*,\s*'([^']+)'\s*\)/g, key: 1, label: 2 },
]);
const definitions = labelsFor([
  { pattern: /\(\s*'([a-z][a-z0-9_.]*)'\s*,\s*'(?:numeric|boolean)'\s*,\s*'[a-z_]+'\s*,\s*(?:'[a-z]+'|null)\s*,\s*'([^']+)'/g, key: 1, label: 2 },
  // A RENAME, which is not an insert and was this guard's blind spot. 0251 renamed
  // `ocr_pages.monthly` away from the word "OCR" on the owner's instruction — a decision about what
  // customers are told a quota is called — and without this pattern the guard compared the
  // dictionary against the ORIGINAL seed, agreed with it, and reported all clear while the screen
  // said something else. A guard that only reads inserts cannot see a correction.
  { pattern: /set\s+label\s*=\s*'([^']+)'\s*where\s+entitlement_key\s*=\s*'([a-z][a-z0-9_.]*)'/gi, key: 2, label: 1 },
]);
const presentation = labelsFor([
  { pattern: /\(\s*'([a-z][a-z0-9_.]*)'\s*,\s*\d+\s*,\s*'([^']+)'\s*,\s*(?:true|false)\s*\)/g, key: 1, label: 2 },
]);

const problems = [];
const unmapped = [];
let compared = 0;

for (const [family, prefix, rows] of [
  ['subscription_plans.label', 'plan_', plans],
  ['entitlement_definitions.label', 'entitlement_', definitions],
  ['plan_feature_presentation.public_label', 'planFeature_', presentation],
]) {
  for (const [key, label] of rows) {
    const name = asDictionaryName(prefix, key);
    const entry = dictionaryEntry(dictionary, name);
    if (entry == null) { unmapped.push(`${family}  ${key}  «${label}»  (no ${name} in he.ts)`); continue; }
    compared += 1;
    if (entry !== label) {
      problems.push(`${family}  ${key}\n      database: «${label}»\n      he.ts:    «${entry}»  (${name})`);
    }
  }
}

// Positive control. If the patterns above stopped matching, every row would look unmapped and this
// guard would report "all clear" while checking nothing at all.
if (compared < 30) {
  console.error(`check:plan-labels FAILED — only ${compared} label(s) matched a migration row, which means `
    + 'this parser is broken rather than the catalogue. Expected at least 30 (6 plans + 20 definitions + 11 cards).');
  process.exit(1);
}

if (problems.length) {
  console.error(`check:plan-labels FAILED — ${problems.length} Hebrew label(s) no longer match the database.\n`
    + '  The dictionary mirrors the seeded rows; a migration renamed one of them and this copy did not follow.\n'
    + '  Fix he.ts to match the migration, and give en.ts the English for the new wording.\n\n    '
    + problems.join('\n    '));
  process.exit(1);
}

console.log(`check:plan-labels passed: ${compared} Hebrew label(s) match their seeded row`
  + (unmapped.length ? `; ${unmapped.length} seeded row(s) have no dictionary entry and will render Hebrew:\n  ${unmapped.join('\n  ')}` : '.'));
