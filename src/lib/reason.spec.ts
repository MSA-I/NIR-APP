import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPTIONAL_REASON_LABEL_KEY, reasonOr } from './reason';
import { he } from './i18n/dictionaries/he';
import { en } from './i18n/dictionaries/en';

/**
 * The owner's ruling of 11.08.2026 has two halves, and only the first one is visible on screen:
 * stop making people type a reason, and keep writing one to the ledger. A later edit that "finishes
 * the job" by sending an empty reason would pass every UI test and fail at the server, on roughly
 * fifty commands that raise `reason_required` — so the guarantee is pinned here.
 */
describe('reasonOr', () => {
  it('keeps what a person wrote, trimmed', () => {
    expect(reasonOr('  הספק שלח מסמך מתוקן  ', 'הסרת מסמך')).toBe('הספק שלח מסמך מתוקן');
  });

  it('never returns empty, whatever the box contained', () => {
    for (const empty of ['', '   ', '\n\t', null, undefined]) {
      expect(reasonOr(empty, 'הסרת מסמך').trim().length).toBeGreaterThan(0);
    }
  });

  it('names the action and says plainly that nobody explained it', () => {
    // Both halves matter. "—" alone would be an audit line that teaches an auditor nothing; the
    // action name without the admission would read like someone had actually written it.
    const written = reasonOr('', 'הסרת מסמך מתיקיית המסמכים');
    expect(written).toContain('הסרת מסמך מתיקיית המסמכים');
    expect(written).toContain('ללא הערה');
  });

  it('stays inside the 1000-character bound every reason column is checked against', () => {
    expect(reasonOr('', 'א'.repeat(200)).length).toBeLessThanOrEqual(1000);
  });
});

describe('the reason box no longer blocks a button', () => {
  /**
   * The screens were changed by hand, and the thing that would quietly come back is the gate, not
   * the label: a `disabled={... !reason.trim()}` re-added during an unrelated edit puts the
   * interrogation back with nothing else in the suite noticing.
   */
  const files = [
    ['components', 'ui.tsx'],
    ['components', 'DocumentRemovalDialog.tsx'],
    ['components', 'PriceListUpload.tsx'],
    ['components', 'document-review', 'DocumentAssessmentPanel.tsx'],
    ['components', 'document-review', 'DocumentReviewProposals.tsx'],
    ['components', 'document-review', 'PriceListReviewConfirmation.tsx'],
    ['pages', 'Admin.tsx'],
    ['pages', 'Bank.tsx'],
    ['pages', 'DocumentOperations.tsx'],
    ['pages', 'Inventory.tsx'],
    ['pages', 'InvoiceNew.tsx'],
    ['pages', 'AccountantPaymentQueue.tsx'],
    ['pages', 'PaymentRequests.tsx'],
    ['pages', 'PriceLists.tsx'],
    // The second wave (30.08.2026). These carried the gate for three weeks after the ruling because
    // the first pass listed the files it had touched, and a list of touched files cannot notice the
    // ones it missed. That is why the sweep below exists alongside this list.
    ['components', 'InvoiceLineReviewModal.tsx'],
    ['components', 'SupplierCommunicationCard.tsx'],
    ['components', 'WhatsAppConnectionCard.tsx'],
    ['components', 'document-review', 'PriceListAutomationReadiness.tsx'],
    ['pages', 'ProductNameRepairReview.tsx'],
    ['pages', 'SupplierProposalReview.tsx'],
    ['pages', 'Settings.tsx'],
    ['operator', 'CustomerDetail.tsx'],
    ['operator', 'CustomerOnboarding.tsx'],
    ['operator', 'CustomerSubscription.tsx'],
  ];

  /**
   * The original pattern only knew three spellings — `!reason.trim()`, `!f.reason.trim()`,
   * `!extension.reason.trim()` — and the second wave used six others it could not see:
   * `!evidenceReason.trim()`, `!roleReason.trim()`, `!!form.reason.trim()` and
   * `reason.trim() === ''` among them. A guard that matches only the shapes already fixed is a
   * guard that reports green over every shape nobody thought of, so it now matches on the *name*
   * (anything ending in `reason`, either case) rather than on a fixed list of prefixes. The prefix
   * is optional on purpose: an earlier draft required one and silently stopped matching plain
   * `!reason.trim()`, which is the most common spelling of all.
   *
   * It still cannot see two of the ten — `ProductNameRepairReview` and `PriceListAutomationReadiness`
   * trimmed into a local first (`const reason = x.trim(); if (!reason)`), and matching a bare `!ident`
   * would flag every legitimate `if (!action || !reason) return;` after a `ConfirmDialog`. Those two
   * are caught by the refusal sweep below instead. Checked against the pre-change sources: the two
   * sweeps together flag 10 of 10.
   */
  const GATE = /!\s*[\w$.]*[Rr]eason\.trim\(\)|[\w$.]*[Rr]eason\.trim\(\)\s*===\s*(''|"")/;

  it.each(files)('%s/%s asks for a reason without demanding one', (...parts) => {
    const source = readFileSync(join(process.cwd(), 'src', ...parts), 'utf8');
    expect(source).not.toMatch(GATE);
  });

  it('offers the same words everywhere the shared dialog is used', () => {
    // Split: the module pins the KEY, each dictionary pins the claim that the box is optional.
    expect(OPTIONAL_REASON_LABEL_KEY).toBe('reason.optionalLabel');
    expect(he.reason.optionalLabel).toContain('רשות');
    expect(he.reason.optionalLabel).not.toContain('חובה');
    expect(en.reason.optionalLabel).toContain('optional');
    expect(en.reason.optionalLabel).not.toMatch(/required/i);
  });

  /**
   * The list above is maintained by hand, and the failure it could not prevent already happened:
   * ten screens kept the gate because nobody added them to it. So the real guard is this sweep —
   * it reads every product source file under `src`, and a new screen is covered the day it is
   * written rather than the day someone remembers it.
   *
   * `InvoiceDetail.tsx` is the one allowed exception, and it is not a gate on a person. Its
   * `ConfirmDialog` already ran `reasonOr` before the value is stored, so the check between the
   * dialog and the password step-up can never be reached with a blank string. It stays because the
   * 3-way override is one of the few places whose reason is rendered back on screen
   * (`InvoiceDetail.tsx`, "החסימה נעקפה על ידי בעלים"), and a defensive non-empty assertion in
   * front of that command is worth keeping.
   */
  const ALLOWED_DEFENSIVE_GATE = ['pages', 'InvoiceDetail.tsx'].join('/');

  /**
   * THE PLATFORM OPERATOR CONSOLE IS OUT OF SCOPE, AND NOT BY OVERSIGHT (#300).
   *
   * #299 says "no screen", and its reasoning is that the audit log is not weakened by dropping the
   * client gate: the 75 `reason_required` checks across 44 migrations test NON-BLANK only, so a
   * `reasonOr` sentence satisfies every one of them and no server changes. That reasoning does not
   * reach `src/operator`. `0249` made a reason a REAL argument of the cross-tenant staff commands —
   * `platform_change_user_access` and the roster writes refuse without one — so removing the client
   * gate there would not free a legitimate action, it would hand the operator a button that always
   * fails. That is the exact failure #299 was written to remove, arriving from the other side.
   *
   * The scope question is recorded as `#300` with this as its stated default, not decided here.
   */
  const STAFF_CONSOLE = 'operator/';

  function productSources(): string[] {
    const root = join(process.cwd(), 'src');
    return (readdirSync(root, { recursive: true, encoding: 'utf8' }) as string[])
      .map((entry) => entry.split(/[\\/]/).join('/'))
      .filter((entry) => /\.tsx?$/.test(entry))
      .filter((entry) => !/\.spec\.tsx?$/.test(entry));
  }

  it('has no screen anywhere under src that refuses to act on a blank reason', () => {
    const offenders: string[] = [];
    for (const relative of productSources()) {
      if (relative === ALLOWED_DEFENSIVE_GATE) continue;
      if (relative.startsWith(STAFF_CONSOLE)) continue;
      // The dictionaries hold the WORDS a refusal is said with, not a screen that refuses.
      if (relative.startsWith('lib/i18n/dictionaries/')) continue;
      const source = readFileSync(join(process.cwd(), 'src', relative), 'utf8');
      if (GATE.test(source)) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The symptom the owner actually reported was the sentence on screen, not the boolean behind it.
   * A screen can also demand a reason by telling the person it is mandatory — a label reading
   * "חובה", or a toast refusing the action — and those survive any amount of boolean tidying.
   *
   * `errors.ts` is excluded because it is the opposite thing: it translates a refusal the SERVER
   * raised into Hebrew. When `reason_required` comes back from a command the person is entitled to
   * read why, and deleting that sentence would make a real failure silent.
   */
  it('has no screen that tells a person a reason is mandatory', () => {
    const refusals = /יש לציין סיבה|יש להזין סיבה|יש לנמק|מחייבת סיבה|מחייב סיבה/;
    const offenders: string[] = [];
    for (const relative of productSources()) {
      if (relative === 'lib/errors.ts') continue;
      // Same reason as errors.ts: the dictionaries hold the WORDS a server refusal is said with,
      // and deleting them would make a real failure silent rather than making a screen kinder.
      if (relative.startsWith('lib/i18n/dictionaries/')) continue;
      const source = readFileSync(join(process.cwd(), 'src', relative), 'utf8');
      if (refusals.test(source)) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });
});
