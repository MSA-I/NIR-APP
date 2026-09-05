/**
 * ENTRY-11 — the operator invitation refuses a bad link by naming a state; its tenant twin
 * names a next step.
 *
 * The brief's rule is that a refusal says what happened AND what to do next. Measured
 * 2026-09-04: the tenant screen meets it -- "קישור ההזמנה אינו תקין. ייתכן שהועתק חלקית —
 * בקש מהעסק לשלוח הזמנה חדשה." -- while the operator screen says only "הקישור אינו תקין."
 * and "ההזמנה בוטלה.". Two of its four refusal states already comply (`expired` names a new
 * link, `accepted` names signing in), which is what makes the other two an oversight rather
 * than a policy.
 *
 * The oracle is on the dictionaries rather than on a mounted component because the defect IS
 * the sentence: `AcceptOperatorInvite.tsx:129-145` renders whichever of the four keys the
 * lookup returns, identically, so a component test would assert the same strings through one
 * more layer.
 *
 * A next step is recognised by the same imperative markers the two compliant messages already
 * use, in each language. This is deliberately a low bar -- the point is that a next step is
 * present at all, not that it is phrased a particular way.
 */
import { describe, expect, it } from 'vitest';
import { he } from '../lib/i18n/dictionaries/he';
import { en } from '../lib/i18n/dictionaries/en';

/** Every state the invitation lookup can refuse on. `valid` is not a refusal. */
const REFUSAL_STATES = ['expired', 'revoked', 'accepted', 'unknown'] as const;

const NEXT_STEP = {
  he: /יש ל|אפשר|בקש|לבקש|ניתן ל/,
  en: /\brequest|\bask\b|\bsign in\b|\bcontact\b|\byou can\b/i,
};

describe('the operator invitation refusal says what to do next', () => {
  for (const state of REFUSAL_STATES) {
    it(`names a next step for "${state}" in Hebrew`, () => {
      const message = (he.operatorInvite as Record<string, string>)[state];
      expect(message, `operatorInvite.${state} is missing from he.ts`).toBeTruthy();
      expect(message).toMatch(NEXT_STEP.he);
    });

    it(`names a next step for "${state}" in English`, () => {
      const message = (en.operatorInvite as Record<string, string>)[state];
      expect(message, `operatorInvite.${state} is missing from en.ts`).toBeTruthy();
      expect(message).toMatch(NEXT_STEP.en);
    });
  }

  it('matches the tenant twin, which already meets the rule', () => {
    // If the twin ever stops carrying a next step, this test has been measuring nothing.
    const twin = (he.acceptInvite as Record<string, string>).invalidUnknown;
    expect(twin).toMatch(NEXT_STEP.he);
  });
});
