// The screen must be able to say why the machine did not act — for EVERY arm of the ladder.
//
// The failure this prevents is the one that actually happened: the owner enabled autonomy,
// uploaded a document, and the screen said "ממתין להכרעה" and stopped. The answer (`not_an_invoice`)
// existed in the database and could not be reached. 0079 made it a column; this file makes sure a
// future arm added to 0077's ladder cannot ship without a sentence a bookkeeper can read.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FILING_REASON_KEYS, filingReason } from './model';
import type { ReviewSnapshot } from './model';
import { he } from '../../lib/i18n/dictionaries/he';
import type { Dictionary } from '../../lib/i18n/dictionaries/he';
import { translate } from '../../lib/i18n/t';
import type { TKey } from '../../lib/i18n/t';

/**
 * These functions take the translator now, because the module is pure and cannot hold a hook.
 * The tests inject the HEBREW one: every assertion below still names the literal sentence, so a
 * wrong dictionary entry fails here. Comparing `t(key)` to `t(key)` would pass either way.
 */
const t = ((key, vars) => translate(he as unknown as Dictionary, key, vars)) as
  (key: TKey, vars?: Record<string, string | number>) => string;

const migrationsDir = join(process.cwd(), 'supabase', 'migrations');

/**
 * Every `v_reason_code := '<code>'` the apply command can assign, read from the SQL itself.
 *
 * Scanned ONCE, at module load, into a constant — not per assertion. The directory is ~150 SQL
 * files, this file called it four times, and a whole scan inside an `it()` counts against the 5s
 * testTimeout: with the full suite running it measured 12s and failed on time, not on content.
 * The SQL cannot change mid-run, so this is a fixture, and a fixture belongs outside the clock.
 */
function readLadderCodes(): string[] {
  const codes = new Set<string>();
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    // A plain assignment, `v_reason_code := 'x';`.
    for (const match of sql.matchAll(/v_(?:line_)?reason_code\s*:=\s*'([a-z_]+)'/g)) {
      codes.add(match[1]);
    }
    // And an assignment that BRANCHES. 0298 maps the parser's own refusal onto a filing code with
    // `v_line_reason_code := case ... when 'price_above_cap' then 'line_price_above_cap' ... end;`
    // and the literal-only scan above saw none of it — four real stops the reviewer can reach
    // read as labels for states that could not happen. Only the RESULT arms count: a `when` arm
    // is the parser's vocabulary, not a filing code, and adding it would break the other direction.
    // Scoped to `v_line_reason_code`: `0190` assigns the EMAIL DELIVERY reason with the same
    // `v_reason_code := case` shape, and `delivered`/`complaint` are not stops on this ladder.
    for (const assignment of sql.matchAll(/v_line_reason_code\s*:=\s*case[\s\S]*?end\s*;/g)) {
      for (const arm of assignment[0].matchAll(/(?:then|else)\s+'([a-z_]+)'/g)) codes.add(arm[1]);
    }
  }
  return [...codes].sort();
}

const LADDER_CODES = readLadderCodes();
const ladderCodes = () => LADDER_CODES;

const snapshotWith = (filings: ReviewSnapshot['filings']) =>
  ({ filings } as unknown as ReviewSnapshot);

const filing = (over: Partial<ReviewSnapshot['filings'][number]>) => ({
  id: 'f1', org_id: 'org', document_id: 'doc', category: 'invoice',
  supplier_id: null, interpretation_id: 'i1', confidence: 0.9,
  decided_by: 'system', decided_at: '2026-08-07T11:05:36Z',
  reverted_at: null, reverted_reason: null, reason_code: null,
  ...over,
} as ReviewSnapshot['filings'][number]);

describe('every stop the ladder can reach has a sentence', () => {
  it('finds the ladder in the migrations at all', () => {
    // If this ever returns nothing, the scan below is vacuously green and proves nothing.
    expect(ladderCodes().length).toBeGreaterThan(10);
    expect(ladderCodes()).toContain('not_an_invoice');
  });

  it('labels every code the SQL can assign', () => {
    const missing = ladderCodes().filter((code) => !(code in FILING_REASON_KEYS));
    expect(missing).toEqual([]);
  });

  it('has no label for a code the ladder cannot produce', () => {
    // Kept honest in both directions: a stale sentence is a promise about a state that no longer
    // exists. `already_decided` is a pre-refusal rather than an outcome, so it is allowed here.
    const codes = new Set([...ladderCodes(), 'already_decided']);
    expect(Object.keys(FILING_REASON_KEYS).filter((k) => !codes.has(k))).toEqual([]);
  });
});

describe('what the reviewer is told', () => {
  it('names the stop the owner actually hit', () => {
    const text = filingReason(snapshotWith([filing({ reason_code: 'not_an_invoice' })]), t);
    expect(text).toContain('אין עדיין פקודת כתיבה אוטומטית בטוחה');
  });

  it('explains an unreadable currency without silently calling it shekels', () => {
    const text = filingReason(snapshotWith([filing({ reason_code: 'currency_unrecognised' })]), t);
    expect(text).toContain('המטבע שהודפס');
    expect(text).not.toContain('שקל');
  });

  it('says nothing when the machine wrote the record — a null code is not a stop', () => {
    expect(filingReason(snapshotWith([filing({ reason_code: null })]), t)).toBeNull();
  });

  it('survives a snapshot that has no filings field at all', () => {
    // Regression: the first version dereferenced `snapshot.filings` and threw
    // "Cannot read properties of undefined", which renders as a blank review screen.
    expect(filingReason({} as unknown as ReviewSnapshot, t)).toBeNull();
  });

  it('says nothing when there is no machine filing at all', () => {
    expect(filingReason(snapshotWith([]), t)).toBeNull();
    expect(filingReason(snapshotWith([filing({ decided_by: 'human', reason_code: 'not_an_invoice' })]), t))
      .toBeNull();
  });

  it('ignores a reverted filing — an undone decision is not the current reason', () => {
    expect(filingReason(snapshotWith([
      filing({ reason_code: 'not_an_invoice', reverted_at: '2026-08-07T12:00:00Z' }),
    ]), t)).toBeNull();
  });

  it('reads the newest filing when a document was decided more than once', () => {
    const text = filingReason(snapshotWith([
      filing({ id: 'old', reason_code: 'autonomy_disabled', decided_at: '2026-08-07T09:00:00Z' }),
      filing({ id: 'new', reason_code: 'supplier_unidentified', decided_at: '2026-08-07T11:00:00Z' }),
    ]), t);
    expect(text).toContain('הספק לא הותאם');
  });

  it('never prints a bare enum, even for an arm nobody labelled', () => {
    const text = filingReason(snapshotWith([filing({ reason_code: 'some_future_arm' })]), t);
    expect(text).not.toContain('some_future_arm');
    expect(text).toContain('ההכרעה אצלך');
  });
});
