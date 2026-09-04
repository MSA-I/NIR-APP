/**
 * REQ-07 — the two refusals the "אישור לתשלום" button can produce, and what they said.
 *
 * `invoice_three_way_approval_guard` (0099) is the trigger behind the approve button. It refuses
 * an approval that has not passed three-way matching, and it refuses one whose invoice is a
 * definite duplicate. Both are rules the product enforces ON PURPOSE, and both reached the owner
 * as `errors.fallback` — "הפעולה נכשלה. אם הבעיה חוזרת — פנה לתמיכה." — because neither string
 * appeared anywhere under `src/`. Support is the wrong destination for a state the product itself
 * created and the person can act on.
 *
 * The wire status is NOT asserted here. `errcode = '55000'` is what makes PostgREST answer 500,
 * and moving it is a migration against a trigger body — see the REQ-07 row in `docs/GATES.md`.
 * What this file pins is the half that is a client concern: the sentence.
 *
 * `proposal_already_decided` — the second code REQ-07 measured — is asserted alongside as a
 * control. It was already mapped before this package, so it must be green in BOTH runs; a red on
 * that line would mean the harness, not the finding.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toErrorKey } from './errors';
import { en } from './i18n/dictionaries/en';
import { he } from './i18n/dictionaries/he';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const REFUSALS = [
  'invoice_approval_blocked_three_way_review',
  'invoice_approval_blocked_definite_duplicate',
] as const;

describe('the invoice approval guard names what it refused', () => {
  it('maps each refusal to its own key, whichever shape the message arrives in', () => {
    for (const code of REFUSALS) {
      for (const raw of [code, `Error: ${code}`, `${code} (55000)`]) {
        expect(toErrorKey(new Error(raw))).toBe(code);
        expect(toErrorKey(raw)).toBe(code);
      }
    }
  });

  it('does not collapse either refusal into the generic fallback', () => {
    for (const code of REFUSALS) {
      expect(toErrorKey(new Error(code))).not.toBe('fallback');
    }
    // The two are different states with different next actions — "the goods have not been
    // receipted yet" is not "you have already entered this invoice" — so they must not share a
    // key either.
    expect(toErrorKey(new Error(REFUSALS[0]))).not.toBe(toErrorKey(new Error(REFUSALS[1])));
  });

  it('resolves to its own sentence in both dictionaries, not to the fallback', () => {
    for (const code of REFUSALS) {
      const key = toErrorKey(new Error(code));
      for (const dictionary of [he, en]) {
        const errors = dictionary.errors as unknown as Record<string, string | undefined>;
        expect(errors[key]).toBeTypeOf('string');
        expect(errors[key]).not.toBe(errors.fallback);
      }
    }
  });

  it('leaves the fallback intact for a code nobody mapped, so the assertions above mean something',
    () => {
      expect(toErrorKey(new Error('zzz_no_such_condition'))).toBe('fallback');
    });

  /** Control: green before this package and after it. */
  it('still names the already-decided proposal, as it did before', () => {
    expect(toErrorKey(new Error('proposal_already_decided'))).toBe('proposal_already_decided');
    for (const dictionary of [he, en]) {
      const errors = dictionary.errors as unknown as Record<string, string | undefined>;
      expect(errors.proposal_already_decided).toBeTypeOf('string');
      expect(errors.proposal_already_decided).not.toBe(errors.fallback);
    }
  });
});
