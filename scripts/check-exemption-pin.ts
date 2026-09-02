/**
 * check:exemptions — the definer-exemption pin, checked in milliseconds instead of at minute
 * nineteen of a twenty-minute gate.
 *
 * `private.scope_definer_exemptions` is the ledger of SECURITY DEFINER functions that touch a
 * scope-enforced table without filtering on auth_scopes() (0057). `p9_five_domains.sql` pins its
 * row count so that adding one is a deliberate, argued act rather than a silent widening of the
 * A5 hole — the pin's own comment says "zero silent additions".
 *
 * The pin works. What did not work is WHERE it lives: a suite the author of a migration has no
 * reason to run. Four consecutive waves added an exemption, left the pin alone, and discovered it
 * only when `npm run quality` reached p9 — 0075 (B1), 0077 twice (C2 and C5), each costing a full
 * gate run to find a one-line edit. This script is the same assertion, moved to `npm run build`.
 *
 * It is arithmetic, not a database read, so it runs with no stack: count what the migrations
 * explicitly add and drain, apply it to 0057's seed, and require p9 to agree.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The two inputs, overridable ONLY so `check:gate-controls` can hand this guard a deliberately
 * broken copy and prove it goes red. Nothing in the product sets these; the defaults are the
 * real tree. A guard nobody has watched fail is a line in a config file that everyone believes
 * -- and this one had no positive control at all until 02.09.2026 (DEBT §9).
 */
const migrationsDir = process.env.EXEMPTION_PIN_MIGRATIONS_DIR
  ?? fileURLToPath(new URL('../supabase/migrations', import.meta.url));
const p9Path = process.env.EXEMPTION_PIN_P9_PATH
  ?? fileURLToPath(new URL('../supabase/tests/p9_five_domains.sql', import.meta.url));

/**
 * 0057:260-266 seeds the registry from pg_proc, so its size is decided at migration time and
 * cannot be counted from the text. 59 is what that seed produced, and it is not a number this
 * script has to trust: p9 re-reads the live registry every gate run, so a seed that drifts fails
 * there. Here it is only the origin the deltas below are applied to.
 */
const SEED_0057 = 59;

const LEGACY_SCOPE_REASSERT_OMISSIONS = new Set([
  '0067_barcode_lookup_index.sql',
  '0080_server_price_submission_actor.sql',
  '0082_fix_document_interpretation_dispatch.sql',
  '0083_fix_document_interpretation_claim.sql',
  '0084_automatic_document_classification.sql',
  '0085_reprocess_reviewed_document.sql',
  // 0090 landed on main on 09.08.2026 and was applied to production on 10.08, both BEFORE this
  // rule existed -- the rule arrives with the codex campaign in the same merge that adds this
  // line. Retrofitting the assertion block would mean editing a migration production has already
  // run, which the constitution forbids outright. Nothing is unchecked as a result: the identical
  // global assertion runs in p9_five_domains.sql every gate, and 0090's three definer exemptions
  // are pinned in the count below. What is lost is earliness for one historical file, not cover.
  '0090_automatic_delivery_note_receiving.sql',
]);

const SCOPE_REASSERTION = /into\s+([a-z_][a-z0-9_]*)\s+from\s+private\.scope_enforcement_violations\s*\(\s*\)\s*;\s*if\s+\1\s+is\s+not\s+null\s+then\s+raise\s+exception/i;

function executableSql(source: string, includeDoBodies: boolean): string {
  let out = '';
  let i = 0;
  let state: 'code' | 'line' | 'block' | 'single' | 'escapeSingle' | 'double' = 'code';
  let blockDepth = 0;
  while (i < source.length) {
    const char = source[i];
    const pair = source.slice(i, i + 2);
    if (state === 'line') {
      if (char === '\n' || char === '\r') { out += char; state = 'code'; }
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (pair === '/*') { blockDepth += 1; i += 2; }
      else if (pair === '*/') {
        blockDepth -= 1;
        i += 2;
        if (blockDepth === 0) state = 'code';
      } else i += 1;
      continue;
    }
    if (state === 'escapeSingle') {
      if (char === '\\') i = Math.min(i + 2, source.length);
      else if (pair === "''") i += 2;
      else { i += 1; if (char === "'") state = 'code'; }
      continue;
    }
    if (state === 'single') {
      if (pair === "''") i += 2;
      else { i += 1; if (char === "'") state = 'code'; }
      continue;
    }
    if (state === 'double') {
      if (pair === '""') i += 2;
      else { i += 1; if (char === '"') state = 'code'; }
      continue;
    }

    if (pair === '--') { out += ' '; state = 'line'; i += 2; continue; }
    if (pair === '/*') { out += ' '; state = 'block'; blockDepth = 1; i += 2; continue; }
    if (char === "'") {
      out += ' ';
      const escapeString = i > 0 && source[i - 1]?.toLowerCase() === 'e'
        && (i === 1 || !/[A-Za-z0-9_$]/.test(source[i - 2] ?? ''));
      state = escapeString ? 'escapeSingle' : 'single';
      i += 1;
      continue;
    }
    if (char === '"') { out += ' '; state = 'double'; i += 1; continue; }
    if (char === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(source.slice(i))?.[0];
      if (tag) {
        const close = source.indexOf(tag, i + tag.length);
        if (close < 0) return out;
        if (includeDoBodies && /\bdo\s*$/i.test(out.slice(-64))) {
          out += ` ${executableSql(source.slice(i + tag.length, close), false)} `;
        } else out += ' ';
        i = close + tag.length;
        continue;
      }
    }
    out += char;
    i += 1;
  }
  return out;
}

const migrationExecutableSql = (source: string) => executableSql(source, true);

const parserSelfChecks: Array<[string, boolean]> = [
  ["do $$ begin select string_agg(detail, ',') into v_errors from private.scope_enforcement_violations(); if v_errors is not null then raise exception 'blocked'; end if; end $$;", true],
  ["select 'from private.scope_enforcement_violations(';", false],
  ['select $text$from private.scope_enforcement_violations($text$;', false],
  ['/* outer /* nested */ from private.scope_enforcement_violations( */ select 1;', false],
  ['-- from private.scope_enforcement_violations(\nselect 1;', false],
  ["do $$ begin perform '\\', 'from private.scope_enforcement_violations('; end $$;", false],
  ["do $$ begin perform '\\'; select string_agg(detail, ',') into v_errors from private.scope_enforcement_violations(); if v_errors is not null then raise exception 'blocked'; end if; end $$;", true],
];
const parserFailures = parserSelfChecks.flatMap(([sql, expected], index) => {
  const parsed = migrationExecutableSql(sql);
  return SCOPE_REASSERTION.test(parsed) === expected ? [] : [`${index}: ${JSON.stringify(parsed)}`];
});
if (parserFailures.length) {
  throw new Error(`check:exemptions internal SQL lexer self-check failed at case(s): ${parserFailures.join(', ')}`);
}

/** One complete explicit INSERT statement; strings/comments are removed before matching. */
const EXPLICIT_INSERT =
  /insert\s+into\s+private\.scope_definer_exemptions\b([\s\S]*?);/gi;

/** A drain: `delete from private.scope_definer_exemptions ... in ( sig, sig, sig )` */
const EXPLICIT_DELETE =
  /delete\s+from\s+private\.scope_definer_exemptions\b([\s\S]*?);/gi;

interface Ledger { file: string; added: number; drained: number }

function insertedValueRows(statementBody: string): number {
  const valuesAt = /\bvalues\b/i.exec(statementBody);
  if (!valuesAt) throw new Error('scope exemption INSERT must use explicit VALUES rows');
  const valuesTail = statementBody.slice(valuesAt.index + valuesAt[0].length);
  const clause = /\bon\s+conflict\b|\breturning\b/i.exec(valuesTail);
  const values = clause ? valuesTail.slice(0, clause.index) : valuesTail;
  let depth = 0;
  let rows = 0;
  for (const char of values) {
    if (char === '(') {
      if (depth === 0) rows += 1;
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth < 0) throw new Error('unbalanced scope exemption INSERT');
    }
  }
  if (depth !== 0 || rows === 0) throw new Error('invalid scope exemption VALUES rows');
  return rows;
}

const ledger: Ledger[] = [];
const migrationNames = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();

for (const name of migrationNames) {
  // 0057 defines and seeds the table; its seed is the baseline, not a delta.
  if (name.startsWith('0057_')) continue;

  const sql = migrationExecutableSql(readFileSync(join(migrationsDir, name), 'utf8'));
  if (!/private\.scope_definer_exemptions/i.test(sql)) continue;

  const added = [...sql.matchAll(EXPLICIT_INSERT)]
    .reduce((count, match) => count + insertedValueRows(match[1] ?? ''), 0);

  // Each drained signature is one `to_regprocedure('…')` inside the delete's IN list. Counting
  // the statement would say "one" for a delete that removes three, which is exactly what 0073 does.
  let drained = 0;
  for (const [, body] of sql.matchAll(EXPLICIT_DELETE)) {
    drained += [...body.matchAll(/to_regprocedure\s*\(/gi)].length;
  }

  if (added || drained) ledger.push({ file: name, added, drained });
}

const missingScopeReassertion: string[] = [];
let scopeReassertionCount = 0;

for (const name of migrationNames) {
  const version = Number(/^([0-9]{4})_/.exec(name)?.[1]);
  if (!Number.isFinite(version) || version <= 57 || LEGACY_SCOPE_REASSERT_OMISSIONS.has(name)) continue;
  const sql = migrationExecutableSql(readFileSync(join(migrationsDir, name), 'utf8'));
  if (!SCOPE_REASSERTION.test(sql)) missingScopeReassertion.push(name);
  else scopeReassertionCount += 1;
}

const staleLegacyOmissions = [...LEGACY_SCOPE_REASSERT_OMISSIONS]
  .filter((name) => !migrationNames.includes(name));
if (missingScopeReassertion.length || staleLegacyOmissions.length) {
  const missing = missingScopeReassertion.map((name) => `    ${name}`).join('\n');
  const stale = staleLegacyOmissions.map((name) => `    ${name}`).join('\n');
  console.error(
    'check:exemptions FAILED -- every migration after 0057 must re-run private.scope_enforcement_violations().\n\n'
    + (missing ? `  Missing re-assertion:\n${missing}\n\n` : '')
    + (stale ? `  Stale legacy omission entries:\n${stale}\n\n` : '')
    + '  Do not add a new exception. Add the standard assertion block so new tables, policies,\n'
    + '  triggers, and SECURITY DEFINER functions cannot land beyond the A1/A3/A5 gate.',
  );
  process.exit(1);
}

const added = ledger.reduce((n, e) => n + e.added, 0);
const drained = ledger.reduce((n, e) => n + e.drained, 0);
const expected = SEED_0057 + added - drained;

const p9 = readFileSync(p9Path, 'utf8');
const pinned = /count\(\*\)\s*from\s+private\.scope_definer_exemptions\s*\)\s*=\s*(\d+)/i.exec(p9);

if (!pinned) {
  console.error(
    'check:exemptions FAILED — could not find the row-count pin in supabase/tests/p9_five_domains.sql.\n'
    + '  The pin is the only thing standing between a new SECURITY DEFINER exemption and a silent\n'
    + '  widening of the A5 hole. If it was deliberately removed, this script must go with it.',
  );
  process.exit(1);
}

const pinnedCount = Number(pinned[1]);

if (pinnedCount !== expected) {
  const rows = ledger
    .map((e) => `    ${e.file}: +${e.added} -${e.drained}`)
    .join('\n');
  console.error(
    `check:exemptions FAILED — the definer exemption registry and its pin disagree.\n\n`
    + `  p9_five_domains.sql pins  : ${pinnedCount}\n`
    + `  the migrations imply      : ${expected}   (0057 seeded ${SEED_0057}, +${added} added, -${drained} drained)\n\n`
    + `${rows}\n\n`
    + `  A migration added or drained an exemption without moving the pin. That is the check\n`
    + `  working, not a nuisance: every row here is a definer that reads a scope-enforced table\n`
    + `  without filtering on auth_scopes(), and the pin exists so adding one is argued rather\n`
    + `  than absorbed. Update supabase/tests/p9_five_domains.sql to ${expected} AND write why the\n`
    + `  new exemption cannot be an invoker — the multi-unit enablement wave reads that reason to\n`
    + `  decide whether the row can ever be drained.`,
  );
  process.exit(1);
}

console.log(
  `check:exemptions passed: ${scopeReassertionCount} post-0057 migration(s) re-assert A1/A3/A5 `
  + `(${LEGACY_SCOPE_REASSERT_OMISSIONS.size} pinned historical omissions); pin ${pinnedCount} `
  + `matches ${ledger.length} migration(s) `
  + `(+${added} / -${drained} over 0057's seed of ${SEED_0057}).`,
);
