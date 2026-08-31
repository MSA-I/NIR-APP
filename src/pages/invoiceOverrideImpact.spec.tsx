// The three-way override, after it moved onto `ImpactDialog`.
//
// Two claims are pinned here and neither is visible from the JSX. The first is that the path lost
// a window rather than gaining one — it used to be a ConfirmDialog that collected a reason and
// then a ReauthModal, and it is now one dialog that states the extent plus a step-up that asks for
// nothing but a password. The second is the staleness loop, which is the actual bug this repairs:
// `invoice_three_way_assessment_stale` means the assessment CHANGED, and the old path answered
// that by closing the window over it and keeping the stale hash, so approving again would fail
// identically forever.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { he } from '../lib/i18n/dictionaries/he';
import { en } from '../lib/i18n/dictionaries/en';
import { toErrorKey } from '../lib/errors';

const source = readFileSync(resolve(process.cwd(), 'src/pages/InvoiceDetail.tsx'), 'utf8');
/* Comments blanked: this file's own documentation names the patterns it removed. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

describe('the override path lost a window', () => {
  it('opens the impact dialog, not a confirmation that cannot describe the action', () => {
    expect(code).toContain('<ImpactDialog open={overrideOpen}');
    expect(code).not.toContain('overrideConfirmOpen');
  });

  /**
   * `ReauthModal` was built to REPLACE a reason-only dialog, not to stack after one
   * (`ReauthModal.tsx:122-124`). It gets the reason that was already typed and asks only for the
   * password — so the whole path has exactly one reason box, which is acceptance criterion 8.
   */
  it('hands the already-typed reason to the step-up instead of asking twice', () => {
    expect(code).toContain('onConfirm={() => void overrideThreeWayMatch(overrideReason)}');
    expect(code).not.toMatch(/<ReauthModal[\s\S]{0,400}reasonLabel/);
  });

  /** Cancelling the password prompt must not throw away what was typed behind it. */
  it('leaves the impact dialog standing when the step-up is cancelled', () => {
    expect(code).toContain('onCancel={() => setOverrideReauthOpen(false)}');
    expect(code).not.toContain("onCancel={() => { setOverrideReauthOpen(false); setOverrideReason(''); }}");
  });
});

describe('the impact is read from the server, not assembled', () => {
  it('carries the assessment hash the command checks', () => {
    expect(code).toContain('assessmentHash: data.threeWay.assessment_hash');
    expect(code).toContain('p_assessment_hash: data.threeWay.assessment_hash');
  });

  it('is null until the assessment arrives, which is what locks the confirm', () => {
    expect(code).toContain('data.threeWay == null ? null : {');
  });

  /**
   * The server's blocking reasons are WARNINGS, not blockers: proceeding past them is the entire
   * purpose of an override, and `0099` re-checks them anyway. The one true blocker is the
   * duplicate, which `0099:1975` refuses outright.
   */
  it('treats the match reasons as warnings and the duplicate as the one hard blocker', () => {
    expect(code).toContain('warnings: data.threeWay.reasons.map');
    expect(code).toContain('hardBlockers: data.threeWay.definite_duplicate_invoice');
  });

  /** `0099` has one writer and no eraser, so the dialog does not offer a way back. */
  it('says the override cannot be undone, because there is no command that undoes it', () => {
    expect(code).toContain('reversible: false');
  });

  it('states what will NOT change, not only what will', () => {
    expect(code).toContain("happens: false, description: t('invoices.overrideEffectNoAmounts')");
    expect(code).toContain("happens: false, description: t('invoices.overrideEffectNoLines')");
  });

  it('shows the invoice amount in the invoice’s own currency', () => {
    expect(code).toContain('amounts: [{ currency: inv.currency, amount: inv.total_amount }]');
    expect(code).toContain('baseCurrency={inv.currency}');
  });
});

describe('the staleness loop, which is the bug this repairs', () => {
  /**
   * THE NAME MATTERS. The plan carried `assessment_hash_mismatch` for a while; that string does
   * not exist anywhere in the repository. The server raises `invoice_three_way_assessment_stale`
   * (`0099:1972`), and a handler matching the wrong name would have been dead code that looked
   * like a fix.
   */
  it('matches the error the server actually raises', () => {
    expect(code).toContain('/invoice_three_way_assessment_stale/i.test(res.error.message)');
    expect(code).not.toContain('assessment_hash_mismatch');
  });

  it('maps that refusal to a sentence about the STATE, not a generic failure', () => {
    expect(toErrorKey('invoice_three_way_assessment_stale')).toBe('invoice_three_way_assessment_stale');
    expect(he.errors.invoice_three_way_assessment_stale).toContain('המצב השתנה');
    expect(en.errors.invoice_three_way_assessment_stale).toContain('state changed');
  });

  /**
   * The three things a stale hash requires, and the old path did none of them: keep the window
   * open, reload the assessment, and mint a NEW idempotency key — the key is part of the decision,
   * so a new state is a new decision.
   */
  it('keeps the dialog open, refetches, and mints a new idempotency key', () => {
    const branch = code.slice(code.indexOf('if (res.error) {'), code.indexOf('setOverrideOpen(false);'));
    expect(branch).toContain('setOverrideError(errorText(res.error.message))');
    expect(branch).toContain('setOverrideIdempotencyKey(crypto.randomUUID())');
    expect(branch).toContain('void refetch()');
    expect(branch).not.toContain('setOverrideOpen(false)');
  });

  /** A toast closes over the refusal and takes the typed reason with it. */
  it('shows every refusal inside the dialog rather than in a toast', () => {
    expect(code).toContain('error={overrideError}');
    expect(code).not.toMatch(/setOverrideReauthOpen\(false\);\s*if \(res\.error\) \{ toast\(/);
  });

  it('clears a previous refusal when the dialog is opened again', () => {
    expect(code).toContain('onClick={() => { setOverrideError(null); setOverrideOpen(true); }}');
  });
});

describe('the wording exists on both sides', () => {
  it.each([
    'overrideReasonLabel', 'overrideScope', 'overrideChangeBefore', 'overrideChangeAfter',
    'overrideEffectApproval', 'overrideEffectNoAmounts', 'overrideBlockedDuplicate',
  ])('%s is written in Hebrew and in English', (key) => {
    expect((he.invoices as Record<string, string>)[key]).toBeTruthy();
    expect((en.invoices as Record<string, string>)[key]).toBeTruthy();
  });

  it.each([
    'invoice_three_way_assessment_stale',
    'approved_invoice_override_immutable',
    'definite_duplicate_invoice_cannot_be_overridden',
  ])('%s has a sentence rather than falling to the generic failure', (code_) => {
    expect((he.errors as Record<string, string>)[code_]).toBeTruthy();
    expect((en.errors as Record<string, string>)[code_]).toBeTruthy();
    expect(toErrorKey(code_)).toBe(code_);
  });
});
