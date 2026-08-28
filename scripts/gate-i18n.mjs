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
 *   node scripts/gate-i18n.mjs currency-untouched -- translating the UI changed nothing about money
 *   node scripts/gate-i18n.mjs help-registry-paired -- every product-help topic exists in both locales
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
  'src/pages/Settings.tsx',
  'src/pages/Reports.tsx',
  'src/pages/ConsolidatedInvoices.tsx',
  'src/lib/routePresentation.ts',
  'src/pages/DocumentOperations.tsx',
  'src/lib/monthlyReport.ts',
  'src/pages/Legal.tsx',
  'src/pages/Admin.tsx',
  'src/components/OrgSubscriptionPanel.tsx',
  'src/lib/webhooks.ts',
  'src/pages/WebhookSettings.tsx',
  'src/pages/neworder/NewOrder.tsx',
  'src/pages/Expenses.tsx',
  'src/pages/Exceptions.tsx',
  'src/lib/consolidatedInvoices.ts',
  'src/components/FileUpload.tsx',
  'src/components/document-review/assessment.ts',
  'src/components/document-review/DocumentAssessmentPanel.tsx',
  'src/components/document-review/DocumentReviewWorkspace.tsx',
  'src/pages/SupplierLog.tsx',
  'src/pages/Invoices.tsx',
  'src/components/document-review/PriceListAutomationReadiness.tsx',
  'src/components/document-review/DocumentScanPreview.tsx',
  'src/components/assistant/AnswerView.tsx',
  'src/components/WhatsAppConnectionCard.tsx',
  'src/pages/ProductPurchaseSummary.tsx',
  'src/components/InvoiceLineReviewModal.tsx',
  'src/pages/FinancialSupplier.tsx',
  'src/pages/Credits.tsx',
  'src/components/EmailOrderCard.tsx',
  'src/lib/orderEmail.ts',
  'src/components/ReceiptConflictDialog.tsx',
  'src/pages/SupplierProposalReview.tsx',
  'src/pages/neworder/SupplierSplitStep.tsx',
  'src/components/assistant/AssistantDialog.tsx',
  'src/lib/documentStatus.ts',
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
const LEGACY_ERROR_CALLS = 4;

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


/**
 * P3-G5. Translating the interface must change NOTHING about money.
 *
 * The owner's currency decision (OPEN-DECISIONS #277) is a real multi-currency system, and it is
 * being built somewhere else. What this branch owes is the opposite proof: that it left the
 * shekel assumption exactly where it found it while rewriting 4,000 lines of screen copy.
 *
 * It delegates the src half to `check:money` rather than re-implementing it — that guard already
 * bans a second currency formatter outside `format.ts`, and two counters drift. What it adds is
 * the half `check:money` cannot see, because it only scans `src`: the SERVER's refusal. 0108
 * blocks a document printing anything but a shekel instead of recording its numbers as shekels,
 * and that refusal is the load-bearing one — it is what makes "everything is in shekels" true of
 * the data rather than only of the formatting.
 */
function currencyUntouched() {
  try {
    execFileSync(process.execPath, ['scripts/check-money.ts'], { cwd: root, encoding: 'utf8' });
  } catch (e) {
    fail(`gate-i18n: check:money failed, so money no longer has one source of truth:\n${e.stdout ?? ''}${e.stderr ?? ''}`);
  }

  const migration = 'supabase/migrations/0108_document_reconciliation_assessment.sql';
  const sql = read(migration);
  const required = [
    "v_currency not in ('ILS', 'NIS', '₪', 'ש\"ח', 'שח')",
    "'code', 'currency_not_ils', 'severity', 'error'",
    'v_blocked := true;',
  ];
  const missing = required.filter((needle) => !sql.includes(needle));
  if (missing.length) {
    fail(`gate-i18n: ${migration} no longer refuses a non-shekel document. Missing:\n  ${missing.join('\n  ')}`);
  }

  console.log('gate-i18n: money still has one formatter, and 0108 still blocks a non-shekel document');
  console.log('GATE_I18N_CURRENCY_UNTOUCHED_OK');
}


/**
 * P2-G8. Every product-help topic exists in both locales.
 *
 * The assistant answers product questions ONLY from this registry — there is no fallback and no
 * model knowledge (OPEN-DECISIONS #192). A topic with a Hebrew row and no English one is therefore
 * not a cosmetic gap: an English speaker asking that question gets Hebrew back, or nothing.
 *
 * Checked structurally rather than by counting, so it fails for the right reason: it names the
 * topics that lost a twin, in whichever direction. An English row with no Hebrew original is also
 * a failure — that is #192's "locale חסר" read the other way, a translation of nothing.
 */
function helpRegistryPaired() {
  const registry = read('src/lib/assistant/productHelpRegistry.ts').replace(/\r\n/g, '\n');
  const ids = [...registry.matchAll(/^ {4}id: '(\w+)',$/gm)].map((m) => m[1]);
  const locales = [...registry.matchAll(/^ {4}locale: '(\w+)',$/gm)].map((m) => m[1]);
  if (ids.length === 0 || ids.length !== locales.length) {
    fail(`gate-i18n: parsed ${ids.length} id(s) against ${locales.length} locale(s) — the registry's shape changed and this check can no longer read it`);
  }
  const byLocale = { he: [], en: [] };
  ids.forEach((id, index) => { (byLocale[locales[index]] ??= []).push(id); });
  const he = byLocale.he ?? [];
  const en = byLocale.en ?? [];
  const missingEnglish = he.filter((id) => !en.includes(id));
  const orphanEnglish = en.filter((id) => !he.includes(id));
  if (missingEnglish.length || orphanEnglish.length) {
    const lines = ['gate-i18n: the product-help registry is not paired.'];
    if (missingEnglish.length) lines.push(`  no English row: ${missingEnglish.join(', ')}`);
    if (orphanEnglish.length) lines.push(`  English with no Hebrew original: ${orphanEnglish.join(', ')}`);
    fail(lines.join('\n'));
  }
  console.log(`gate-i18n: ${he.length} product-help topic(s), each in both locales`);
  console.log('GATE_I18N_HELP_PAIRED_OK');
}

const COMMANDS = {
  ratchet, extracted, dictionaries, abandon, zero, legacyErrors,
  'legacy-errors': legacyErrors,
  currencyUntouched, 'currency-untouched': currencyUntouched,
  helpRegistryPaired, 'help-registry-paired': helpRegistryPaired,
};
const command = COMMANDS[process.argv[2]];
if (!command) fail(`gate-i18n: unknown subcommand ${process.argv[2] ?? '(none)'}; expected one of ${Object.keys(COMMANDS).join(', ')}`);
command();
