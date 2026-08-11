import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPTIONAL_REASON_LABEL, reasonOr } from './reason';

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
    ['pages', 'PayerQueue.tsx'],
    ['pages', 'PaymentRequests.tsx'],
    ['pages', 'PriceLists.tsx'],
    ['pages', 'SupplierPrices.tsx'],
  ];

  it.each(files)('%s/%s asks for a reason without demanding one', (...parts) => {
    const source = readFileSync(join(process.cwd(), 'src', ...parts), 'utf8');
    expect(source).not.toMatch(/!\s*(f\.|extension\.)?reason\.trim\(\)/);
  });

  it('offers the same words everywhere the shared dialog is used', () => {
    expect(OPTIONAL_REASON_LABEL).toContain('רשות');
    expect(OPTIONAL_REASON_LABEL).not.toContain('חובה');
  });
});
