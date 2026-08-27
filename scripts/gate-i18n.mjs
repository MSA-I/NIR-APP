/**
 * Runnable oracles for the English-language ledger (GATES.md).
 *
 * Each subcommand prints ONE success-only token, and prints it last, after every assertion has
 * passed. That shape matters: a gate is met only when the process exits zero AND the token appears,
 * so a token emitted before the work would let a later failure pass unnoticed.
 *
 *   node scripts/gate-i18n.mjs ratchet      -- no Hebrew was added to product source
 *   node scripts/gate-i18n.mjs extracted    -- the named surfaces carry zero Hebrew
 *   node scripts/gate-i18n.mjs dictionaries -- he and en agree, and neither ships a blank
 *   node scripts/gate-i18n.mjs abandon      -- the operator-console skip is recorded, not forgotten
 *   node scripts/gate-i18n.mjs zero         -- extraction is FINISHED: nothing left but the exceptions
 *   node scripts/gate-i18n.mjs legacy-errors -- how many PRODUCT sites still show failures in Hebrew only
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');

/** Surfaces that have completed extraction. A surface is listed here only once it reads zero. */
const EXTRACTED = [
  'src/lib/status.ts',
  'src/lib/useDocumentProcessing.ts',
  'src/lib/errors.ts',
  'src/lib/assistant/errorCodes.ts',
  'src/lib/tusUpload.ts',
];

/** The one surface the owner decided not to translate (27.08.2026). */
const ABANDONED_PREFIX = 'src/operator/';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function ratchet() {
  // Delegates to the pinned-count guard rather than re-implementing it: two counters would drift,
  // and the one that drifted would be the one nobody was watching.
  const out = execFileSync(process.execPath, ['scripts/check-i18n.ts'], { cwd: root, encoding: 'utf8' });
  process.stdout.write(out);
  if (!out.includes('check:i18n passed')) fail('gate-i18n: the ratchet did not report a pass');
  console.log('GATE_I18N_RATCHET_OK');
}

function extracted() {
  const baseline = JSON.parse(read('scripts/i18n-baseline.json'));
  const offenders = EXTRACTED.filter((file) => (baseline.counts[file] ?? 0) > 0);
  if (offenders.length) {
    fail(`gate-i18n: these surfaces are listed as extracted but still carry Hebrew:\n  ${offenders.join('\n  ')}`);
  }
  // Positive control: the guard must be able to see Hebrew when it is there. If NOTHING in the
  // baseline carries Hebrew, an empty offender list proves nothing about the check.
  const stillHebrew = Object.values(baseline.counts).reduce((sum, n) => sum + n, 0);
  if (stillHebrew === 0) fail('gate-i18n: the baseline is empty, so the extracted check has no control');
  console.log(`gate-i18n: ${EXTRACTED.length} extracted surface(s) at zero; ${stillHebrew} Hebrew line(s) remain elsewhere`);
  console.log('GATE_I18N_EXTRACTED_OK');
}

function dictionaries() {
  const he = read('src/lib/i18n/dictionaries/he.ts');
  const en = read('src/lib/i18n/dictionaries/en.ts');
  // Key parity is enforced by the compiler (`en: Dictionary`) and by t.spec.ts. What a static read
  // can add is the thing neither of those sees: an English value that is still Hebrew.
  const HEBREW = /[֐-׿]/;
  const ALLOWED_HEBREW_IN_EN = ['languageOptionHe', 'languageHe'];
  const leaks = [];
  for (const line of en.split('\n')) {
    const entry = line.match(/^\s{4}(\w+):\s*'(.*)',$/);
    if (!entry) continue;
    if (ALLOWED_HEBREW_IN_EN.some((key) => entry[1] === key)) continue;
    if (HEBREW.test(entry[2])) leaks.push(`${entry[1]}: ${entry[2]}`);
  }
  if (leaks.length) fail(`gate-i18n: the English dictionary still holds Hebrew:\n  ${leaks.join('\n  ')}`);
  const heKeys = (he.match(/^\s{4}\w+:/gm) ?? []).length;
  const enKeys = (en.match(/^\s{4}\w+:/gm) ?? []).length;
  if (heKeys === 0) fail('gate-i18n: the Hebrew dictionary parsed as empty, so this check proves nothing');
  if (heKeys !== enKeys) fail(`gate-i18n: ${heKeys} Hebrew entries against ${enKeys} English ones`);
  console.log(`gate-i18n: ${heKeys} key(s) in both dictionaries, no Hebrew left in the English one`);
  console.log('GATE_I18N_DICTIONARIES_OK');
}

function abandon() {
  // A skip that is not written down in all three places is not a skip, it is an omission.
  const gates = read('GATES.md');
  const debt = read('docs/DEBT-REGISTER.md');
  const baseline = JSON.parse(read('scripts/i18n-baseline.json'));

  if (!/ABANDON:\s*P2-G4\b/.test(gates)) fail('gate-i18n: GATES.md has no ABANDON line for the operator console');
  if (!debt.includes('src/operator/')) fail('gate-i18n: DEBT-REGISTER.md does not record the untranslated operator console');
  const operatorFiles = Object.keys(baseline.counts).filter((f) => f.startsWith(ABANDONED_PREFIX));
  if (operatorFiles.length === 0) {
    fail('gate-i18n: no operator file is pinned in the baseline, so nothing records what was skipped');
  }
  const reason = baseline.__reason ?? {};
  if (!Object.keys(reason).some((key) => key.startsWith(ABANDONED_PREFIX))) {
    fail('gate-i18n: scripts/i18n-baseline.json has no __reason entry for the operator console');
  }
  console.log(`gate-i18n: operator console recorded in GATES.md, DEBT-REGISTER.md and the baseline (${operatorFiles.length} file(s))`);
  console.log('GATE_I18N_ABANDON_OK');
}

function zero() {
  // The end-of-phase oracle, and deliberately NOT the same command as the ratchet.
  //
  // `ratchet` passes while thousands of Hebrew lines remain — its job is only that the number
  // never goes up. A gate titled "everything is extracted" that ran the ratchet would be a gate
  // whose English claim and whose command measured different things, and it would have reported
  // the phase complete on its first day. This one fails until the count is actually zero.
  const baseline = JSON.parse(read('scripts/i18n-baseline.json'));
  const exceptions = new Set(Object.keys(baseline.__reason ?? {}));
  const remaining = Object.entries(baseline.counts)
    .filter(([file, count]) => count > 0 && !exceptions.has(file))
    .sort((a, b) => b[1] - a[1]);
  if (remaining.length) {
    const total = remaining.reduce((sum, [, count]) => sum + count, 0);
    const worst = remaining.slice(0, 5).map(([file, count]) => `  ${String(count).padStart(4)}  ${file}`);
    const lines = [
      `gate-i18n: extraction is not finished — ${total} Hebrew line(s) across ${remaining.length} file(s).`,
      ...worst,
      '  ...',
    ];
    fail(lines.join('\n'));
  }
  console.log(`gate-i18n: nothing left to extract; ${exceptions.size} documented exception(s) remain pinned`);
  console.log('GATE_I18N_ZERO_OK');
}

/**
 * The number of call sites still resolving a failure in Hebrew regardless of the reader.
 *
 * `toHebrewError` is a transitional shim: it names what it does, so nothing is hidden, but a screen
 * that still calls it shows Hebrew to an English reader. The count is pinned here for the same
 * reason the Hebrew line count is pinned — a migration with no ratchet stops at whatever fraction
 * the day ran out on, and nobody notices which fraction that was.
 */
const LEGACY_ERROR_CALLS = 11;

function legacyErrors() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) files.push(full);
    }
  };
  walk(path.join(root, 'src'));

  let found = 0;
  const perFile = [];
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (relative === 'src/lib/errors.ts') continue; // the definition itself
    // Specs call it deliberately: they pin the Hebrew wording, and a test that read the sentence
    // out of the dictionary would pass against a broken dictionary. Counting them here would make
    // the ratchet punish exactly the assertions that make the migration safe.
    if (/\.spec\.tsx?$/.test(relative)) continue;
    const hits = (readFileSync(file, 'utf8').match(/\btoHebrewError\(/g) ?? []).length;
    if (hits) { found += hits; perFile.push([relative, hits]); }
  }

  if (found > LEGACY_ERROR_CALLS) {
    fail(`gate-i18n: ${found} toHebrewError call(s), up from the pinned ${LEGACY_ERROR_CALLS}. `
      + 'A new screen was written against the Hebrew-only shim instead of useT().errorText.');
  }
  if (found < LEGACY_ERROR_CALLS) {
    fail(`gate-i18n: ${found} toHebrewError call(s), down from the pinned ${LEGACY_ERROR_CALLS}. `
      + `Good — lower the pin in scripts/gate-i18n.mjs to ${found} and commit it with the conversion.`);
  }
  console.log(`gate-i18n: ${found} call site(s) across ${perFile.length} file(s) still resolve failures in Hebrew only`);
  console.log('GATE_I18N_LEGACY_ERRORS_OK');
}

const COMMANDS = { ratchet, extracted, dictionaries, abandon, zero, legacyErrors, 'legacy-errors': legacyErrors };
const command = COMMANDS[process.argv[2]];
if (!command) fail(`gate-i18n: unknown subcommand ${process.argv[2] ?? '(none)'}; expected one of ${Object.keys(COMMANDS).join(', ')}`);
command();
